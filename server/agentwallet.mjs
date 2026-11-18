// Optional custodial Agent Wallet: one small hot wallet per signed-in owner, key encrypted at rest
// (AES-256-GCM, master key from TROYA_MASTER_KEY or data/master.key). It can only withdraw to the owner (on Robinhood Chain, or as USDC to the owner's own Hyperliquid account),
// its key can be exported with a fresh signature, and every execution passes limits + Troya Gate and is journaled.
// TROYA_NO_BROADCAST=1 stops right before sending (tests / staging).
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Wallet, JsonRpcProvider, Interface, parseUnits, formatUnits, getAddress } from "ethers";
import { requireSession, makeChallenge, consumeChallenge } from "./auth.mjs";
import { HttpError } from "./api.mjs";
import { checkAction, recordUsage, getPolicy, operatorPolicy } from "./policy.mjs";
import { logAction } from "./journal.mjs";
import { RPC, getBalances, quoteSwap, gateSwap, simulatePerp, gatePerp, ethUsd } from "./tools.mjs";
import { buildSwapTx, hlFundQuote } from "./robinhood.mjs";
import { getProposal, markProposal } from "./inbox.mjs";

let store, master;
const NO_BROADCAST = process.env.TROYA_NO_BROADCAST === "1";
const CHAIN_IDS = { robinhood: 4663, arbitrum: 42161 };
const providers = {};
const provider = (chain) => (providers[chain] ||= new JsonRpcProvider(RPC[chain], { chainId: CHAIN_IDS[chain], name: chain }, { staticNetwork: true }));

async function loadMaster(dataDir) {
  const env = process.env.TROYA_MASTER_KEY || "";
  if (env) {
    const buf = /^[0-9a-fA-F]{64}$/.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (buf.length !== 32) throw new Error("TROYA_MASTER_KEY must be 32 bytes (64 hex chars or base64).");
    return buf;
  }
  const file = `${dataDir}/master.key`;
  try { return Buffer.from((await readFile(file, "utf8")).trim(), "hex"); }
  catch {
    const k = randomBytes(32);
    await writeFile(file, k.toString("hex"), { mode: 0o600, flag: "wx" }).catch(async () => {});
    return Buffer.from((await readFile(file, "utf8")).trim(), "hex");
  }
}
function encrypt(pk, owner) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", master, iv);
  c.setAAD(Buffer.from(owner.toLowerCase()));
  const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}
function decrypt(enc, owner) {
  const d = createDecipheriv("aes-256-gcm", master, Buffer.from(enc.iv, "hex"));
  d.setAAD(Buffer.from(owner.toLowerCase()));
  d.setAuthTag(Buffer.from(enc.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(enc.ct, "hex")), d.final()]).toString("utf8");
}

const k = (owner) => String(owner).toLowerCase();
async function rec(owner) { return (await store.readJson("agentwallets.json", {}))[k(owner)] || null; }
const pub = (r) => (r ? { exists: true, address: r.address, enabled: r.enabled !== false, caps: r.caps, createdAt: r.createdAt, exportedAt: r.exportedAt || null } : { exists: false });

export async function getAgentWallet(owner) { const r = await rec(owner); return r ? pub(r) : null; }
function signer(r, owner, chain) { return new Wallet(decrypt(r.enc, owner), provider(chain)); }
async function mod(name) { try { return await import(`./${name}.mjs`); } catch { return {}; } }

// caps: the stricter of the wallet's own caps and the user's policy (checkAction handles policy)
async function capCheck(owner, r, usd) {
  const reasons = [];
  if (r.enabled === false) reasons.push("The Agent Wallet is switched off.");
  const op = await operatorPolicy();
  if (!op.agentWallet?.enabled) reasons.push("The operator has switched Agent Wallets off.");
  if (r.caps?.perTradeUsd != null && usd > r.caps.perTradeUsd) reasons.push(`Above the Agent Wallet per-trade cap ($${r.caps.perTradeUsd}).`);
  const day = new Date().toISOString().slice(0, 10);
  const spent = r.spent?.day === day ? r.spent.usd : 0;
  const daily = Math.min(r.caps?.dailyUsd ?? Infinity, op.agentWallet?.maxDailyUsd ?? Infinity);
  if (usd > 0 && spent + usd > daily) reasons.push(`Would pass the Agent Wallet daily cap ($${daily}; $${spent.toFixed(2)} used today).`);
  return reasons;
}
async function addSpent(owner, usd) {
  const day = new Date().toISOString().slice(0, 10);
  await store.update("agentwallets.json", {}, (all) => {
    const r = all[k(owner)];
    if (!r) return;
    r.spent = r.spent?.day === day ? { day, usd: r.spent.usd + usd } : { day, usd };
  });
}

const lcs = (s) => String(s || "").toLowerCase();
const NEXT_NONCE = new Map();   // lower(Agent Wallet address) → { n: the next nonce this server will use, at }; trusted for 2 min
async function send(owner, w, tx, label) {
  if (NO_BROADCAST) {
    const populated = await w.populateTransaction(tx).catch((e) => ({ error: e.shortMessage || e.message }));
    return { broadcast: false, note: "TROYA_NO_BROADCAST is set: the transaction was built but not sent.", tx: populated?.error ? null : { to: populated.to, value: String(populated.value ?? 0), data: (populated.data || "0x").slice(0, 74) + "…" }, error: populated?.error || null };
  }
  // the nonce is read straight from the node and counted here: ethers caches an identical request for 250 ms, so a swap sent
  // right after its approval could reuse the approval's nonce ("nonce has already been used"). A failed send starts over.
  const a = lcs(w.address);
  let sent;
  try {
    const onChain = Number(BigInt(await w.provider.send("eth_getTransactionCount", [w.address, "pending"])));
    const mine = NEXT_NONCE.get(a);
    const nonce = Math.max(onChain, mine && Date.now() - mine.at < 120_000 ? mine.n : 0);
    NEXT_NONCE.set(a, { n: nonce + 1, at: Date.now() });
    sent = await w.sendTransaction({ ...tx, nonce });
  } catch (e) { NEXT_NONCE.delete(a); throw e; }
  const receipt = await sent.wait(1, 90_000).catch(() => null);
  // Troya pays gas: the fee goes back to the Agent Wallet (daily limits in gas.mjs); never for a withdrawal to the owner
  if (receipt?.status === 1 && lcs(tx.to) !== lcs(owner)) {
    const fee = (receipt.gasUsed || 0n) * (receipt.gasPrice || receipt.effectiveGasPrice || 0n);
    import("./gas.mjs").then((g) => g.refundGas(owner, w.address, fee)).catch(() => {});
  }
  return { broadcast: true, hash: sent.hash, status: receipt ? (receipt.status === 1 ? "confirmed" : "reverted") : "pending", label };
}

// the creator's first buy of a coin it is launching (owner, 18 Nov: on GMGN the dev showed after the snipers): the launch and
// the buy leave together with nonces n and n+1, so the buy is sequenced right behind the launch, before any bot reacting to
// the new coin. The curve's address is known before launch (Pons places it by the launch salt) and the creator is exempt
// from the launch snipe tax. The buy's gas is set by hand: its curve does not exist yet, so it cannot be estimated.
const CURVE_BUY = new Interface(["function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)"]);
const FIRST_BUY_GAS = 300_000n;   // a Pons curve buy used 91,252 gas on 18 Nov
async function sendLaunchAndBuy(owner, w, launchTx, buyTx, labels) {
  if (NO_BROADCAST) return [await send(owner, w, launchTx, labels[0]), null];
  const a = lcs(w.address);
  let first, second = null;
  try {
    const onChain = Number(BigInt(await w.provider.send("eth_getTransactionCount", [w.address, "pending"])));
    const mine = NEXT_NONCE.get(a);
    const nonce = Math.max(onChain, mine && Date.now() - mine.at < 120_000 ? mine.n : 0);
    NEXT_NONCE.set(a, { n: nonce + 1, at: Date.now() });
    first = await w.sendTransaction({ ...launchTx, nonce });
    try {
      NEXT_NONCE.set(a, { n: nonce + 2, at: Date.now() });
      second = await w.sendTransaction({ ...buyTx, nonce: nonce + 1, gasLimit: FIRST_BUY_GAS });
    } catch (e) { NEXT_NONCE.delete(a); console.warn("[launch] the first buy was not sent:", String(e.shortMessage || e.message).slice(0, 160)); }
  } catch (e) { NEXT_NONCE.delete(a); throw e; }
  const done = async (sent, tx, label) => {
    if (!sent) return null;
    const receipt = await sent.wait(1, 90_000).catch(() => null);
    if (receipt?.status === 1) {
      const fee = (receipt.gasUsed || 0n) * (receipt.gasPrice || receipt.effectiveGasPrice || 0n);
      import("./gas.mjs").then((g) => g.refundGas(owner, w.address, fee)).catch(() => {});
    }
    return { broadcast: true, hash: sent.hash, status: receipt ? (receipt.status === 1 ? "confirmed" : "reverted") : "pending", label, block: receipt?.blockNumber ?? null };
  };
  const l = await done(first, launchTx, labels[0]);
  const b = await done(second, buyTx, labels[1]);
  return [l, b];
}

/**
 * Execute an action with the owner's Agent Wallet.
 * kind: "swap" {tokenIn, tokenOut, amountIn, slippagePct} | "perp" {coin, side, sizeUsd, leverage, tpPx, slPx, reduceOnly}
 *     | "withdraw" {chain, amount} (always to the owner) | "close" {coin, sizePct}
 */
export async function executeForUser(owner, { kind, params = {}, rationale = "", source = "app", proposalId = null }) {
  const r = await rec(owner);
  if (!r) throw new HttpError(400, "No Agent Wallet yet. Create one in Agent → Wallet.");
  const ep = (await ethUsd()) || 0;
  let usd = 0, gate = null, summary = "", result = null;
  try {
    if (kind === "swap") {
      const q = await quoteSwap({ tokenIn: params.tokenIn === "native" ? "ETH" : params.tokenIn || "ETH", tokenOut: params.tokenOut === "native" ? "ETH" : params.tokenOut, amountIn: params.amountIn, slippagePct: params.slippagePct });
      gate = await gateSwap(q);
      usd = q.tokenIn.native ? q.amountIn * ep : (q.tokenIn.priceUsd || 0) * q.amountIn;
      summary = `Swap ${q.amountIn} ${q.tokenIn.symbol} → ${q.tokenOut.symbol}`;
      const pc = await checkAction(owner, { kind: "swap", usd, token: q.tokenOut.native ? q.tokenIn.address : q.tokenOut.address });
      const cap = await capCheck(owner, r, usd);
      let gateFails = gate.pass ? [] : gate.checks.filter((c) => c.status === "fail");
      // V6 initial buy: this Agent Wallet buying the coin it launched through Troya minutes ago. Its curve is empty by
      // definition, so only the pool-depth check is set aside; every other Gate check still applies.
      // creatorBuy (the dev panel in Telegram): the same, for the creator's own coin at any time, so a dev can buy it while
      // nobody else has yet
      if ((params.initialBuy || params.creatorBuy) && gateFails.length) {
        const own = (await store.readJson("launches.json", [])).find((x) => lcs(x.token) === lcs(q.tokenOut.address) && lcs(x.owner) === lcs(owner) && lcs(x.wallet) === lcs(r.address) && (params.creatorBuy || Date.now() - x.at < 15 * 60_000));
        if (own) gateFails = gateFails.filter((c) => !/^pool depth$/i.test(String(c.name || "")));
      }
      const reasons = [...pc.reasons, ...cap, ...gateFails.map((c) => `${c.name}: ${c.detail}`), ...(q.executable ? [] : ["No executable swap route on this server."])];
      if (reasons.length) return await blocked(owner, kind, summary, reasons, gate, source, proposalId);
      const w = signer(r, owner, "robinhood");
      const native = (t) => !t || t === "native" || /^eth$/i.test(t);
      const tx = await buildSwapTx({ from: w.address, tokenIn: native(params.tokenIn) ? "ETH" : params.tokenIn, tokenOut: native(params.tokenOut) ? "ETH" : params.tokenOut, amountIn: String(params.amountIn), slippageBps: Math.round((q.slippagePct || 1) * 100) });
      // approvals first (ERC-20, then Permit2 for Uniswap v4), then the swap itself; only to/data/value go to the signer
      const pick = (t) => ({ to: t.to, data: t.data, value: t.value != null ? BigInt(t.value) : 0n });
      const txs = [...(tx.approvals || []).filter((a) => a.needed && a.tx).map((a) => pick(a.tx)), pick(tx)];
      const sends = [];
      // a public RPC can still be a block behind right after an approval: a swap that reverts just after one is retried
      for (let i = 0; i < txs.length; i++) {
        for (let attempt = 0; ; attempt++) {
          try { sends.push(await send(owner, w, txs[i], summary)); break; }
          catch (e) {
            const afterApproval = i > 0 && i === txs.length - 1;
            if (!afterApproval || attempt >= 2 || !/revert|estimateGas|CALL_EXCEPTION/i.test(e.shortMessage || e.message || "")) throw e;
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          }
        }
      }
      result = { steps: sends };
    } else if (kind === "perp" || kind === "close") {
      const hl = await mod("hl");
      if (typeof hl.hlPlaceOrder !== "function") throw new HttpError(501, "Perp execution is not available on this server yet.");
      const lev = Math.max(1, Math.round(Number(params.leverage) || 1));
      if (kind === "perp") {
        const sim = await simulatePerp({ coin: params.coin, side: params.side, sizeUsd: params.sizeUsd });
        gate = await gatePerp(sim, { leverage: lev, address: owner });
        usd = Number(params.sizeUsd) || 0;
        summary = `${params.side === "short" ? "Short" : "Long"} ${sim.coin} $${usd} at ${lev}x`;
      } else summary = `Close ${params.sizePct || 100}% of ${params.coin}`;
      const pc = await checkAction(owner, { kind: "perp", usd, leverage: lev, market: params.coin });
      const cap = await capCheck(owner, r, usd);
      const reasons = [...(kind === "close" ? pc.reasons.filter((x) => /kill switch/.test(x)) : pc.reasons), ...(kind === "close" ? [] : cap), ...(gate && !gate.pass ? gate.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`) : [])];
      if (reasons.length) return await blocked(owner, kind, summary, reasons, gate, source, proposalId);
      const w = new Wallet(decrypt(r.enc, owner));
      if (NO_BROADCAST) result = { broadcast: false, note: "TROYA_NO_BROADCAST is set: the order was not sent.", order: { ...params, leverage: lev } };
      // The Agent Wallet trades as an approved Hyperliquid API agent on the owner's account: trade-only, it cannot withdraw there.
      else if (kind === "close") {
        // reduce-only market order against the owner's open position
        const st = await hl.hlUserState(getAddress(owner));
        const pos = (st.positions || []).find((p) => String(p.coin).toUpperCase() === String(params.coin).toUpperCase() && p.size !== 0);
        if (!pos) throw new HttpError(400, `No open ${params.coin} position on Hyperliquid.`);
        const pctClose = Math.min(100, Math.max(1, Number(params.sizePct) || 100));
        result = await hl.hlPlaceOrder({ privateKey: w.privateKey, coin: pos.coin, isBuy: pos.size < 0, size: (Math.abs(pos.size) * pctClose) / 100, reduceOnly: true, slippage: 0.01 });
      } else {
        const meta = await hl.hlAsset(params.coin);
        const mark = Number(meta.markPx || meta.midPx);
        if (!(mark > 0)) throw new HttpError(502, `No live price for ${params.coin}.`);
        result = await hl.hlPlaceOrder({ privateKey: w.privateKey, coin: meta.coin, isBuy: params.side !== "short", size: usd / mark, leverage: lev, slippage: 0.01,
          tp: Number(params.tpPx) || undefined, sl: Number(params.slPx) || undefined, reduceOnly: !!params.reduceOnly });
      }
    } else if (kind === "hl_fund") {
      // ETH from the Agent Wallet → USDC on the OWNER's Hyperliquid account (the account it trades as an approved agent)
      const amount = Number(params.amount);
      if (!(amount > 0)) throw new HttpError(400, "Enter an amount above zero.");
      summary = `Fund Hyperliquid: ${amount} ETH → USDC on the owner's Hyperliquid account`;
      const pc = await checkAction(owner, { kind: "withdraw" });
      if (pc.reasons.length) return await blocked(owner, kind, summary, pc.reasons, null, source, proposalId);
      const w = signer(r, owner, "robinhood");
      const q = await hlFundQuote({ address: w.address, amountWei: parseUnits(String(amount), 18), toAddress: owner });
      if (q.toAddress.toLowerCase() !== String(owner).toLowerCase()) throw new HttpError(502, "The route would not deliver to the owner.");
      const sent = await send(owner, w, { to: q.tx.to, data: q.tx.data, value: BigInt(q.tx.value), gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n }, summary);
      result = { ...sent, route: q.tool, usdcEstimate: Number(formatUnits(q.toAmount, q.toDecimals)), usdcMin: Number(formatUnits(q.toAmountMin, q.toDecimals)) };
      usd = 0; // the owner's money moving to the owner's own account never counts against trading caps
    } else if (kind === "launch") {
      // V6 · launch a coin on Pons from the Agent Wallet (Launch on X, Launch in Telegram): the wallet pays the Pons fee, the
      // creator fee goes where launch.mjs plan() says (the owner's own wallet, or a Troya fee splitter), caps and kill switch apply
      const { buildLaunchTx } = await import("./robinhood.mjs");
      const w = signer(r, owner, "robinhood");
      const firstBuy = Math.max(0, Number(params.initialBuyEth) || 0);
      summary = `Launch $${String(params.symbol || "").slice(0, 16)} on Pons${firstBuy ? ` with a ${firstBuy} ETH first buy` : ""}`;
      const tx = await buildLaunchTx({ creator: w.address, feeRecipient: params.feeRecipient || owner, name: params.name, symbol: params.symbol, logo: params.logo || "", description: params.description || "", twitter: params.twitter || "", website: params.website || "", telegram: params.telegram || "", creatorTaxBps: Math.max(0, Math.min(400, Math.round(Number(params.creatorTaxBps) || 0))) });
      usd = (Number(tx.value) / 1e18 + firstBuy) * ep;
      const pc = await checkAction(owner, { kind: "launch", usd });
      const cap = await capCheck(owner, r, usd);
      const reasons = [...pc.reasons, ...cap];
      if (!tx.enoughBalance) reasons.push(`The Agent Wallet ${w.address} needs at least ${(Number(tx.launchFeeWei) / 1e18 + 0.0001).toFixed(4)} ETH on Robinhood Chain for the Pons fee and gas.`);
      else if (!tx.simulation.ok) reasons.push(`Pons would refuse this launch: ${tx.simulation.error || "the simulation failed"}.`);
      if (reasons.length) return await blocked(owner, kind, summary, reasons, null, source, proposalId);
      const launchTx = { to: tx.to, data: tx.data, value: BigInt(tx.value) };
      let sent, buy = null;
      const curve = tx.predicted?.curve || null;
      if (firstBuy > 0 && curve && BigInt(tx.balanceWei || 0) > BigInt(tx.value) + parseUnits(String(firstBuy), 18)) {
        const wei = parseUnits(firstBuy.toFixed(18).replace(/\.?0+$/, ""), 18);
        [sent, buy] = await sendLaunchAndBuy(owner, w, launchTx, { to: curve, data: CURVE_BUY.encodeFunctionData("buy", [wei, 0n, w.address]), value: wei },
          [summary, `First buy ${firstBuy} ETH of $${String(params.symbol || "").slice(0, 16)}`]);
      } else sent = await send(owner, w, launchTx, summary);
      result = { ...sent, token: tx.predicted?.token || null, curve, ponsUrl: tx.predicted?.ponsUrl || null, feeRecipient: params.feeRecipient || owner, launchFeeWei: tx.launchFeeWei,
        firstBuy: firstBuy > 0 ? (buy ? { eth: firstBuy, hash: buy.hash, status: buy.status, block: buy.block, launchBlock: sent?.block ?? null } : { eth: firstBuy, hash: null, status: "not-sent" }) : null };
    } else if (kind === "withdraw" || kind === "send") {
      const chain = "robinhood";
      const amount = Number(params.amount);
      if (!(amount > 0)) throw new HttpError(400, "Enter an amount above zero.");
      usd = amount * ep;
      summary = `Withdraw ${amount} ETH on Robinhood Chain to the owner wallet`;
      const pc = await checkAction(owner, { kind: "withdraw" });
      if (pc.reasons.some((x) => /kill switch/.test(x))) return await blocked(owner, kind, summary, pc.reasons, null, source, proposalId);
      const w = signer(r, owner, chain);
      // asking for the whole balance (typed, not Max) left nothing for the withdrawal's own gas and failed with
      // "insufficient funds" (18 Nov): what does not fit is sent as everything less the gas, and the summary says so
      let value = parseUnits(Number(amount).toFixed(18).replace(/\.?0+$/, ""), 18);
      const bal = await w.provider.getBalance(w.address);
      const fee = await w.provider.getFeeData().catch(() => ({}));
      const gasPrice = fee.maxFeePerGas || fee.gasPrice || 100_000_000n;
      const gasLimit = await w.provider.estimateGas({ from: w.address, to: getAddress(owner), value: 1n }).catch(() => 120_000n);
      const reserve = gasLimit * gasPrice * 3n;
      if (value + reserve > bal) {
        if (bal <= reserve) throw new HttpError(400, `The Agent Wallet holds ${formatUnits(bal, 18)} ETH, too little to pay the gas of a withdrawal.`);
        value = bal - reserve;
        summary = `Withdraw ${formatUnits(value, 18)} ETH (everything less the gas) on Robinhood Chain to the owner wallet`;
      }
      result = await send(owner, w, { to: getAddress(owner), value }, summary);
      result.amountEth = Number(formatUnits(value, 18));
      usd = 0; // withdrawals to the owner never count against trading caps
    } else throw new HttpError(400, `Unknown action kind "${String(kind).slice(0, 20)}".`);
  } catch (e) {
    await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary: summary || kind, rationale, data: { params, error: e.message }, status: "failed", source });
    if (proposalId) await markProposal(owner, proposalId, "failed", { error: e.message });
    throw e.status ? e : new HttpError(502, `Execution failed: ${e.shortMessage || e.message}`);
  }
  const broadcast = result?.broadcast !== false && !(result?.steps || []).some((s) => s.broadcast === false);
  if (broadcast && usd > 0) { await recordUsage(owner, usd); await addSpent(owner, usd); }
  const status = broadcast ? "executed" : "built";
  await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary, rationale, data: { params, gate, result }, status, source });
  if (proposalId) await markProposal(owner, proposalId, broadcast ? "done" : "built", result);
  return { executed: broadcast, summary, gate, result };
}
async function blocked(owner, kind, summary, reasons, gate, source, proposalId) {
  await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary, rationale: reasons.join(" "), data: { gate }, status: "blocked", source });
  if (proposalId) await markProposal(owner, proposalId, "blocked", { reasons });
  return { executed: false, blocked: true, summary, reasons, gate };
}

export async function register(r, ctx) {
  store = ctx.store;
  master = await loadMaster(ctx.dataDir);

  r.get("/api/agent-wallet", async ({ req }) => pub(await rec(requireSession(req).address)));

  r.post("/api/agent-wallet/create", async ({ req }) => {
    const s = requireSession(req);
    const op = await operatorPolicy();
    if (!op.agentWallet?.enabled) throw new HttpError(403, "The operator has switched Agent Wallets off.");
    let out;
    await store.update("agentwallets.json", {}, (all) => {
      if (all[k(s.address)]) { out = all[k(s.address)]; return; }
      const w = Wallet.createRandom();
      all[k(s.address)] = out = { address: w.address, enc: encrypt(w.privateKey, s.address), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } };
    });
    await logAction({ address: s.address, kind: "agent-wallet.create", summary: `Agent Wallet ${out.address} ready`, rationale: "Created at the owner's request. Custodial: the operator stores the key encrypted.", source: "app" });
    return pub(out);
  });

  r.get("/api/agent-wallet/balances", async ({ req }) => {
    const s = requireSession(req);
    const w = await rec(s.address);
    if (!w) throw new HttpError(404, "No Agent Wallet yet.");
    return getBalances(w.address);
  });

  r.post("/api/agent-wallet/settings", async ({ req, body }) => {
    const s = requireSession(req);
    const op = await operatorPolicy();
    let out;
    await store.update("agentwallets.json", {}, (all) => {
      const w = all[k(s.address)];
      if (!w) throw new HttpError(404, "No Agent Wallet yet.");
      const lim = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
      if ("perTradeUsd" in body) w.caps.perTradeUsd = lim(body.perTradeUsd, op.perTradeUsd);
      if ("dailyUsd" in body) w.caps.dailyUsd = lim(body.dailyUsd, op.agentWallet?.maxDailyUsd ?? op.dailyUsd);
      if ("enabled" in body) w.enabled = !!body.enabled;
      out = w;
    });
    await logAction({ address: s.address, kind: "agent-wallet.settings", summary: `Agent Wallet ${out.enabled ? "on" : "off"} · $${out.caps.perTradeUsd}/trade · $${out.caps.dailyUsd}/day`, source: "app" });
    return pub(out);
  });

  // execute a pending proposal (or a direct action from the app) with the Agent Wallet
  r.post("/api/agent-wallet/execute", async ({ req, body }) => {
    const s = requireSession(req);
    if (body.proposalId) {
      const p = await getProposal(s.address, String(body.proposalId));
      if (!p) throw new HttpError(404, "Proposal not found.");
      if (p.status !== "pending") throw new HttpError(409, `This proposal is ${p.status}.`);
      if (p.kind === "watch") {
        const watches = await import("./watches.mjs");
        const wch = await watches.createWatch(s.address, p.params);
        await markProposal(s.address, p.id, "done", { watchId: wch.id });
        return { executed: true, summary: `Playbook created: ${wch.title}`, watch: wch };
      }
      return executeForUser(s.address, { kind: p.kind, params: p.params, rationale: p.rationale || "Approved proposal", source: body.source === "autopilot" ? "autopilot" : "app", proposalId: p.id });
    }
    const kind = String(body.kind || "");
    if (!["swap", "perp", "close", "withdraw", "hl_fund"].includes(kind)) throw new HttpError(400, "Unknown action.");
    return executeForUser(s.address, { kind, params: body.params || {}, rationale: String(body.rationale || "Requested in the app").slice(0, 300), source: "app" });
  });

  r.post("/api/agent-wallet/withdraw", async ({ req, body }) => {
    const s = requireSession(req);
    return executeForUser(s.address, { kind: "withdraw", params: { chain: body.chain, amount: body.amount }, rationale: "Owner withdrawal", source: "app" });
  });

  r.get("/api/agent-wallet/activity", async ({ req }) => {
    const s = requireSession(req);
    const { readJournal } = await import("./journal.mjs");
    return { items: await readJournal(s.address, { limit: 100, kind: "agent-wallet" }) };
  });

  r.post("/api/agent-wallet/export-nonce", async ({ req }) => {
    const s = requireSession(req);
    if (!(await rec(s.address))) throw new HttpError(404, "No Agent Wallet yet.");
    return { message: makeChallenge(req, s.address, "export Agent Wallet key", "Reveal the private key of my Troya Agent Wallet. Only sign this if you started the export yourself.") };
  });
  r.post("/api/agent-wallet/export", async ({ req, body }) => {
    const s = requireSession(req);
    consumeChallenge(s.address, "export Agent Wallet key", body.message, body.signature);
    const w = await rec(s.address);
    if (!w) throw new HttpError(404, "No Agent Wallet yet.");
    await store.update("agentwallets.json", {}, (all) => { all[k(s.address)].exportedAt = Date.now(); });
    await logAction({ address: s.address, kind: "agent-wallet.export", summary: "Agent Wallet key exported", rationale: "Owner signed a fresh export request.", source: "app" });
    return { address: w.address, privateKey: decrypt(w.enc, s.address) };
  });

  r.post("/api/agent-wallet/delete", async ({ req, body }) => {
    const s = requireSession(req);
    if (body.confirm !== "DELETE") throw new HttpError(400, 'Type DELETE to confirm. Export the key or withdraw first: funds left in a deleted Agent Wallet are lost.');
    const w = await rec(s.address);
    if (!w) throw new HttpError(404, "No Agent Wallet yet.");
    let bal = null;
    try { bal = await getBalances(w.address); } catch {}
    const dust = (bal?.robinhoodEth || 0) > 0.00001 || (bal?.robinhoodTokens || []).length > 0 || (bal?.hyperliquid?.accountValueUsd || 0) > 0.5;
    if (dust && !w.exportedAt && body.force !== true) throw new HttpError(409, "This Agent Wallet still holds funds and its key was never exported. Withdraw or export first.");
    await store.update("agentwallets.json", {}, (all) => { delete all[k(s.address)]; });
    await logAction({ address: s.address, kind: "agent-wallet.delete", summary: `Agent Wallet ${w.address} deleted`, source: "app" });
    return { ok: true };
  });

  // policy view for the wallet tab
  r.get("/api/agent-wallet/limits", async ({ req }) => getPolicy(requireSession(req).address));
}
