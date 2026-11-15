// Optional custodial Agent Wallet: one small hot wallet per signed-in owner, key encrypted at rest
// (AES-256-GCM, master key from TROYA_MASTER_KEY or data/master.key). It can only withdraw to the owner (on Robinhood Chain, or as USDC to the owner's own Hyperliquid account),
// its key can be exported with a fresh signature, and every execution passes limits + Troya Gate and is journaled.
// TROYA_NO_BROADCAST=1 stops right before sending (tests / staging).
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Wallet, JsonRpcProvider, parseUnits, formatUnits, getAddress } from "ethers";
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

async function send(owner, w, tx, label) {
  if (NO_BROADCAST) {
    const populated = await w.populateTransaction(tx).catch((e) => ({ error: e.shortMessage || e.message }));
    return { broadcast: false, note: "TROYA_NO_BROADCAST is set: the transaction was built but not sent.", tx: populated?.error ? null : { to: populated.to, value: String(populated.value ?? 0), data: (populated.data || "0x").slice(0, 74) + "…" }, error: populated?.error || null };
  }
  const sent = await w.sendTransaction(tx);
  const receipt = await sent.wait(1, 90_000).catch(() => null);
  return { broadcast: true, hash: sent.hash, status: receipt ? (receipt.status === 1 ? "confirmed" : "reverted") : "pending", label };
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
      const reasons = [...pc.reasons, ...cap, ...(gate.pass ? [] : gate.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`)), ...(q.executable ? [] : ["No executable swap route on this server."])];
      if (reasons.length) return await blocked(owner, kind, summary, reasons, gate, source, proposalId);
      const w = signer(r, owner, "robinhood");
      const native = (t) => !t || t === "native" || /^eth$/i.test(t);
      const tx = await buildSwapTx({ from: w.address, tokenIn: native(params.tokenIn) ? "ETH" : params.tokenIn, tokenOut: native(params.tokenOut) ? "ETH" : params.tokenOut, amountIn: String(params.amountIn), slippageBps: Math.round((q.slippagePct || 1) * 100) });
      // approvals first (ERC-20, then Permit2 for Uniswap v4), then the swap itself; only to/data/value go to the signer
      const pick = (t) => ({ to: t.to, data: t.data, value: t.value != null ? BigInt(t.value) : 0n });
      const txs = [...(tx.approvals || []).filter((a) => a.needed && a.tx).map((a) => pick(a.tx)), pick(tx)];
      const sends = [];
      for (const t of txs) sends.push(await send(owner, w, t, summary));
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
    } else if (kind === "withdraw" || kind === "send") {
      const chain = "robinhood";
      const amount = Number(params.amount);
      if (!(amount > 0)) throw new HttpError(400, "Enter an amount above zero.");
      usd = amount * ep;
      summary = `Withdraw ${amount} ETH on Robinhood Chain to the owner wallet`;
      const pc = await checkAction(owner, { kind: "withdraw" });
      if (pc.reasons.some((x) => /kill switch/.test(x))) return await blocked(owner, kind, summary, pc.reasons, null, source, proposalId);
      const w = signer(r, owner, chain);
      result = await send(owner, w, { to: getAddress(owner), value: parseUnits(String(amount), 18) }, summary);
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
