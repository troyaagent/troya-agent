// Optional custodial Agent Wallet: one small hot wallet per signed-in owner, key encrypted at rest
// (AES-256-GCM, master key from TROYA_MASTER_KEY or data/master.key). It can only withdraw to the owner (on Robinhood Chain, or as USDC to the owner's own Hyperliquid account),
// its key can be exported with a fresh signature, and every execution passes limits + Troya Gate and is journaled.
// TROYA_NO_BROADCAST=1 stops right before sending (tests / staging).
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Wallet, JsonRpcProvider, Interface, parseUnits, formatUnits, getAddress } from "ethers";
import { requireSession, makeChallenge, consumeChallenge } from "./auth.mjs";
import { HttpError } from "./api.mjs";
import { checkAction, recordUsage, getPolicy, operatorPolicy, usedTodayBy, AUTO_JOBS, swapSide } from "./policy.mjs";
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
async function capCheck(owner, r, usd, source = null) {
  const reasons = [];
  // V8 F44 Scepter: each automated job has its own daily cap, inside the wallet's caps
  if (source && AUTO_JOBS.includes(source) && usd > 0) {
    const caps = (await getPolicy(owner)).effective.jobCaps || {};
    if (caps[source] != null) {
      const used = (await usedTodayBy(owner))[source] || 0;
      if (used + usd > caps[source]) reasons.push(`Above the ${source} job's daily cap ($${caps[source]}; $${used.toFixed(2)} used today). Change it in Agent → Scepter.`);
    }
  }
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
  // the gas paid is returned too: the lot ledger adds it back when it measures the ETH a sell brought in
  const feeWei = receipt ? String((receipt.gasUsed || 0n) * (receipt.gasPrice || receipt.effectiveGasPrice || 0n)) : "0";
  return { broadcast: true, hash: sent.hash, status: receipt ? (receipt.status === 1 ? "confirmed" : "reverted") : "pending", label, feeWei };
}

/* ---------- lot ledger: each automated job sells only its own coins (audit 3-10, 21 Nov 2026) ----------
 * Sentry Autopilot, Champions and Aegis buy the same Gate-passed coins in one Agent Wallet. Until 21 Nov every exit sold
 * the wallet's whole balance of the coin, so the first job to exit dumped the other jobs' coins (and the owner's own), and
 * the next job found "nothing left to sell" and booked a made-up -100% on the board and in Telegram.
 * Now every executed job buy that names its position (lot: { source, positionId }) writes a lot: who bought, for which
 * position, how many coins arrived and what they cost. A job's exit (lot: { …, sell: true }) sells its own lot, never more
 * than the wallet holds. When the wallet holds less than its open lots (the owner or another app sold some), each lot gets
 * its share of what is left and the rest is closed as "sold elsewhere", with no invented profit or loss. Aegis
 * (lot: { closeAll: true }) still sells everything on a red alert, then closes every open lot of that coin with its share of
 * the real ETH that came back. A buy held by the trust ladder carries its lot on the proposal, so a buy approved later
 * still gets its lot, and the job hears about it (onLots hooks) and can give it an exit.
 */
const LOTS = "agentlots.json";
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function transfer(address to,uint256 amount) returns (bool)"]);
const isNative = (t) => !t || t === "native" || /^eth$/i.test(String(t));
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const ratio = (a, b) => (b > 0n ? Number((a * 1_000_000_000n) / b) / 1e9 : 0);
// at most 15 significant digits, cut and never rounded up: tools.quoteSwap reads the amount as a Number, and a Number of a
// longer string can round above what the wallet holds (the same rule as Sentry Autopilot's exits)
function trunc(s, sig = 15) {
  const [i, f = ""] = String(s).split(".");
  const intD = i.replace(/^0+/, "").length;
  if (intD >= sig) return i;
  const keep = intD ? sig - intD : sig + (f.match(/^0*/)[0].length);
  return f ? `${i}.${f.slice(0, keep)}`.replace(/\.?0+$/, "") || "0" : i;
}
// a decimal amount (string or Number) in raw units, cut at the coin's decimals; null when it is not a positive amount
export function toRaw(v, dec) {
  if (v == null || v === "") return null;
  let s = typeof v === "number" || /e/i.test(String(v)) ? Number(v).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : String(v).trim();
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;
  const [i = "0", f = ""] = s.split(".");
  const raw = BigInt((i || "0") + f.slice(0, dec).padEnd(dec, "0"));
  return raw > 0n ? raw : null;
}

/** What each open lot of one coin may still sell, given what the wallet holds now (all in raw units). */
export function lotShares(openLots, balanceRaw) {
  const reserved = openLots.reduce((a, l) => a + BigInt(l.raw), 0n);
  const share = (l) => (balanceRaw >= reserved ? BigInt(l.raw) : reserved > 0n ? (BigInt(l.raw) * balanceRaw) / reserved : 0n);
  return { reserved, free: balanceRaw > reserved ? balanceRaw - reserved : 0n, share };
}
/**
 * The sell a job may make now. lots: every lot of this owner; want: the sell's lot option; balanceRaw: what the wallet
 * holds of the coin; askedRaw: the amount the caller asked for (only used for a position opened before the ledger).
 *   { done }                          the position's lot is already closed (sold by Aegis, or sold elsewhere)
 *   { lotId, amountRaw }              its own lot: its share of what the wallet holds
 *   { closeAll, amountRaw, shares }   Aegis: everything the wallet holds, and each open lot's share of it
 *   { legacy, amountRaw }             no lot (a position from before 21 Nov 2026): at most what no open lot reserves
 */
export function planSell(lots, want, token, balanceRaw, askedRaw = null) {
  const t = lcs(token);
  const open = lots.filter((l) => l.status === "open" && l.token === t);
  const S = lotShares(open, balanceRaw);
  if (want.closeAll) return { closeAll: true, amountRaw: balanceRaw, shares: open.map((l) => ({ id: l.id, share: S.share(l) })) };
  const mine = open.find((l) => l.source === want.source && l.positionId === want.positionId);
  if (mine) return { lotId: mine.id, amountRaw: S.share(mine) };
  const done = lots.find((l) => l.source === want.source && l.positionId === want.positionId && l.token === t);
  if (done) return { done };
  return { legacy: true, amountRaw: askedRaw != null && askedRaw < S.free ? askedRaw : S.free };
}
/**
 * Closes the lots a confirmed sell (or an empty wallet) settled. soldRaw: coins actually sold; outEth: ETH that came back
 * (null when nothing was sold). Returns the closed lots; mutates the lots it closes.
 */
export function settleSell(lots, plan, { soldRaw = 0n, outEth = null, by = null, tx = null, at = Date.now() } = {}) {
  const closeOne = (l, share, eth, how) => {
    const raw = BigInt(l.raw);
    const sold = share > raw ? raw : share;
    const part = ratio(sold, raw);
    Object.assign(l, { status: "closed", closedAt: at, soldRaw: sold.toString(), elsewhereRaw: (raw - sold).toString(), outEth: sold > 0n ? eth : null,
      pnlEth: sold > 0n && eth != null ? eth - l.costEth * part : null, soldPct: Math.round(part * 1000) / 10, how, txSell: sold > 0n ? tx : null, closedBy: by });
    return l;
  };
  if (plan.closeAll) {
    const total = plan.shares.reduce((a, s) => a + s.share, 0n);
    const base = soldRaw > total ? soldRaw : total;        // the owner's own coins were sold too: they take the rest of the ETH
    return plan.shares.map((s) => {
      const l = lots.find((x) => x.id === s.id && x.status === "open");
      if (!l) return null;
      const eth = outEth != null && base > 0n ? outEth * ratio(s.share, base) : null;
      return closeOne(l, soldRaw > 0n ? s.share : 0n, eth, soldRaw > 0n ? (by === "aegis" ? "sold by Aegis" : `sold by ${by || "another job"}`) : "sold elsewhere");
    }).filter(Boolean);
  }
  if (plan.lotId) {
    const l = lots.find((x) => x.id === plan.lotId && x.status === "open");
    if (!l) return [];
    // the coins this lot could not sell were sold before it (by the owner or another app): that part has no result here
    const short = BigInt(l.raw) - plan.amountRaw;
    const how = soldRaw > 0n ? (short > 0n ? "sold, part sold elsewhere" : "sold") : "sold elsewhere";
    // what trunc() cut off (dust) stays in the wallet and is not "sold elsewhere": the lot is charged for its share only
    return [closeOne(l, soldRaw > 0n ? plan.amountRaw : 0n, outEth, how)];
  }
  return [];
}

const LOT_HOOKS = {};
/** A job asks to hear about its lots: { allowBuy(owner, lot) → reason|null, opened(owner, lot, ctx), closed(owner, lot, ctx) }. */
export function onLots(source, hooks) { LOT_HOOKS[source] = hooks; }
async function lotHook(source, name, ...args) {
  try { return await LOT_HOOKS[source]?.[name]?.(...args); } catch (e) { console.warn(`[agent-wallet] lot hook ${source}.${name}:`, e.message); return null; }
}
function cleanLot(x) {
  if (!x || typeof x !== "object" || !AUTO_JOBS.includes(x.source)) return null;
  const positionId = x.positionId == null ? null : String(x.positionId).slice(0, 48);
  let meta = null;
  try { meta = x.meta && JSON.stringify(x.meta).length <= 2000 ? JSON.parse(JSON.stringify(x.meta)) : null; } catch {}
  return { source: x.source, positionId, sell: !!x.sell, closeAll: !!x.closeAll, meta };
}
async function lotsOf(owner) { return (await store.readJson(LOTS, {}))[k(owner)] || []; }
/** The lot of one job position (open or closed), or null. */
export async function findLot(owner, source, positionId) {
  return (await lotsOf(owner)).find((l) => l.source === source && l.positionId === String(positionId)) || null;
}
async function saveLots(owner, fn) {
  let out;
  await store.update(LOTS, {}, (all) => {
    const list = (all[k(owner)] ||= []);
    out = fn(list);
    // bounded: every open lot and the newest 2000 closed ones
    all[k(owner)] = [...list.filter((l) => l.status === "open"), ...list.filter((l) => l.status !== "open").sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 2000)];
  });
  return out;
}
const DECIMALS = new Map();
async function tokenDecimals(token) {
  const t = lcs(token);
  if (!DECIMALS.has(t)) DECIMALS.set(t, Number(ERC20.decodeFunctionResult("decimals", await provider("robinhood").call({ to: getAddress(t), data: ERC20.encodeFunctionData("decimals", []) }))[0]));
  return DECIMALS.get(t);
}
async function tokenRaw(wallet, token) {
  const out = await provider("robinhood").call({ to: getAddress(token), data: ERC20.encodeFunctionData("balanceOf", [wallet]) });
  return BigInt(ERC20.decodeFunctionResult("balanceOf", out)[0]);
}
// one lot-aware swap at a time per owner: two jobs exiting the same coin at once would both read the balance before either
// sold, and the second would count the first one's sale as coins "sold elsewhere"
const LOT_LOCKS = new Map();
function withLotLock(owner, fn) {
  const key = k(owner);
  const run = (LOT_LOCKS.get(key) || Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  LOT_LOCKS.set(key, tail);
  tail.then(() => { if (LOT_LOCKS.get(key) === tail) LOT_LOCKS.delete(key); });
  return run;
}
// the plan of a job's sell, read from the chain: a public RPC can be a block behind right after a buy, so a balance below
// the open lots is read again before any coins are called sold elsewhere
async function planLotSell(owner, wallet, lot, token, askedAmount) {
  const dec = await tokenDecimals(token);
  const lots = await lotsOf(owner);
  const reserved = lots.filter((l) => l.status === "open" && l.token === lcs(token)).reduce((a, l) => a + BigInt(l.raw), 0n);
  let bal = await tokenRaw(wallet, token);
  for (let i = 0; i < 2 && bal < reserved; i++) { await sleep(3000); bal = await tokenRaw(wallet, token); }
  return { ...planSell(lots, lot, token, bal, toRaw(askedAmount, dec)), dec, balanceRaw: bal };
}
// a confirmed job buy: the coins that arrived (the balance before and after; the quote only when the chain cannot tell)
async function recordBuy(owner, wallet, lot, q, amountIn, preRaw, sends, approved) {
  const token = lcs(q.tokenOut.address);
  const dec = await tokenDecimals(token);
  let got = 0n;
  for (let i = 0; i < 4 && preRaw != null; i++) {
    const now = await tokenRaw(wallet, token).catch(() => null);
    if (now != null && now > preRaw) { got = now - preRaw; break; }
    await sleep(2500);
  }
  const estimated = got === 0n;
  if (estimated) got = toRaw(q.amountOut, dec) || 0n;
  const l = { id: randomBytes(6).toString("hex"), source: lot.source, positionId: lot.positionId, token, symbol: q.tokenOut.symbol || null, decimals: dec,
    raw: got.toString(), tokens: Number(formatUnits(got, dec)), costEth: Number(amountIn), estimated, openedAt: Date.now(), txBuy: sends.at(-1)?.hash || null, status: "open", meta: lot.meta };
  await saveLots(owner, (list) => { list.push(l); });
  await lotHook(lot.source, "opened", owner, l, { approved });
  return l;
}
// a confirmed job sell: the ETH that came back (balance after − before, plus the gas this sell paid), then the lots it closes
async function recordSell(owner, wallet, lot, plan, q, preWei, sends, soldRaw, approved) {
  const fee = sends.reduce((a, s) => a + BigInt(s?.feeWei || 0), 0n);
  let outEth = null;
  for (let i = 0; i < 4 && preWei != null; i++) {
    const now = await provider("robinhood").getBalance(wallet).catch(() => null);
    if (now != null && now + fee > preWei) { outEth = Number(formatUnits(now + fee - preWei, 18)); break; }
    await sleep(2500);
  }
  const estimated = outEth == null;
  if (estimated) outEth = Number(q.amountOut) || 0;
  const closed = await saveLots(owner, (list) => settleSell(list, plan, { soldRaw, outEth, by: lot.source, tx: sends.at(-1)?.hash || null }).map((l) => ({ ...l })));
  for (const l of closed) await lotHook(l.source, "closed", owner, l, { approved, by: lot.source });
  const own = plan.lotId ? closed.find((l) => l.id === plan.lotId) || null : null;
  return { lot: own, lots: closed, sale: { outEth, soldTokens: Number(formatUnits(soldRaw, plan.dec)), estimated } };
}
// nothing of the position is left in the wallet: its lot (or, for Aegis, every open lot of the coin) closes as sold elsewhere
async function settleEmpty(owner, lot, plan) {
  const closed = await saveLots(owner, (list) => settleSell(list, plan, { soldRaw: 0n, by: lot.source }).map((l) => ({ ...l })));
  for (const l of closed) await lotHook(l.source, "closed", owner, l, { approved: false, by: lot.source });
  return closed;
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
 * lot (swaps of automated jobs, see the lot ledger above): { source, positionId, meta } on a buy, { source, positionId,
 *     sell: true } on that position's exit, { source: "aegis", closeAll: true } for Aegis. A proposal keeps its lot, so
 *     executing a proposal (proposalId) takes the lot from it when none is passed.
 */
export async function executeForUser(owner, opts) {
  const lot = cleanLot(opts.lot === undefined && opts.proposalId ? (await getProposal(owner, opts.proposalId).catch(() => null))?.lot : opts.lot);
  if (opts.kind === "swap" && lot) return withLotLock(owner, () => execute(owner, { ...opts, lot }));
  return execute(owner, { ...opts, lot: null });
}
async function execute(owner, { kind, params = {}, rationale = "", source = "app", proposalId = null, lot = null }) {
  const r = await rec(owner);
  if (!r) throw new HttpError(400, "No Agent Wallet yet. Create one in Agent → Wallet.");
  // the lot ledger, before the trust ladder: a proposal must show the amount this position may really sell, and a position
  // whose coins are gone (or one already bought) must not become a proposal at all. Executing the proposal later runs this
  // again, so the amount is read fresh at the moment it sends.
  const lotSell = kind === "swap" && lot && (lot.sell || lot.closeAll) && isNative(params.tokenOut) && !isNative(params.tokenIn) ? lot : null;
  const lotBuy = kind === "swap" && lot && lot.positionId && !lot.sell && !lot.closeAll && isNative(params.tokenIn) && !isNative(params.tokenOut) ? lot : null;
  let plan = null;
  if (lotSell) {
    try { plan = await planLotSell(owner, r.address, lotSell, params.tokenIn, params.amountIn); }
    catch (e) { throw new HttpError(502, `Could not read the Agent Wallet's coin balance: ${String(e.shortMessage || e.message).slice(0, 160)}`); }
    const what = `Sell for ${lotSell.source}${lotSell.positionId ? ` (position ${lotSell.positionId})` : ""}`;
    if (plan.done) return { ...(await blocked(owner, kind, what, [`This position was already closed: ${plan.done.how}.`], null, source, proposalId)), lotDone: true, lot: plan.done };
    if (!(plan.amountRaw > 0n)) {
      const closed = plan.lotId || plan.closeAll ? await settleEmpty(owner, lotSell, plan) : [];
      const own = closed.find((l) => l.id === plan.lotId) || null;
      const out = await blocked(owner, kind, what, ["Nothing of this position is left in the Agent Wallet: it was sold elsewhere."], null, source, proposalId);
      return own ? { ...out, lotDone: true, lot: own, lots: closed } : { ...out, nothingToSell: true, lots: closed };
    }
    params = { ...params, amountIn: trunc(formatUnits(plan.amountRaw, plan.dec)) };
  }
  if (lotBuy) {
    const prior = await findLot(owner, lotBuy.source, lotBuy.positionId);
    const why = prior ? "This position was already bought." : await lotHook(lotBuy.source, "allowBuy", owner, lotBuy);
    if (why) return blocked(owner, kind, `Buy for ${lotBuy.source}`, [String(why)], null, source, proposalId);
  }
  // V8 F44 Scepter, the trust ladder: on "watch" an automated job only alerts; on "approve" it asks first (an Inbox
  // proposal); on "auto" it acts inside the caps. A trade the user taps or confirms is never held back by the ladder.
  if (AUTO_JOBS.includes(source)) {
    const trust = (await getPolicy(owner)).effective.trust;
    // a held proposal carried by an automated job (the browser-tab Autopilot) goes through only on "auto": until 20 Nov
    // 2026 a proposalId skipped the ladder, so the tab executed the very trades "approve" had just held for a yes
    if (proposalId) { if (trust !== "auto") throw heldForApproval(proposalId); }
    else if (trust === "watch") return blocked(owner, kind, rationale || `${source}: ${kind}`, ["Your trust ladder is on Watch: automated jobs alert you and never trade. Change it in Agent → Scepter."], null, source, null);
    else if (trust === "approve") {
      const { createProposal, addInbox } = await import("./inbox.mjs");
      const p = await createProposal(owner, { kind, params, summary: rationale || `${source}: ${kind}`, rationale, source, lot });
      await addInbox(owner, { kind: "proposal", title: `${source} asks to ${kind}`, body: `${rationale || ""} Approve it in Agent → Scepter or Portfolio → Inbox.`.trim(), data: { proposalId: p.id } });
      await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary: rationale || kind, data: { params, proposalId: p.id }, status: "proposed", source });
      return { executed: false, proposed: true, proposalId: p.id, summary: `Waiting for your approval: ${rationale || kind}` };
    }
  }
  const ep = (await ethUsd()) || 0;
  let usd = 0, gate = null, summary = "", result = null, lotOut = null, side = null;
  try {
    if (kind === "swap") {
      const q = await quoteSwap({ tokenIn: params.tokenIn === "native" ? "ETH" : params.tokenIn || "ETH", tokenOut: params.tokenOut === "native" ? "ETH" : params.tokenOut, amountIn: params.amountIn, slippagePct: params.slippagePct });
      gate = await gateSwap(q);
      usd = q.tokenIn.native ? q.amountIn * ep : (q.tokenIn.priceUsd || 0) * q.amountIn;
      summary = `Swap ${q.amountIn} ${q.tokenIn.symbol} → ${q.tokenOut.symbol}`;
      side = await swapSide(q);           // V9 F48 Chiron: the owner's habit rules apply to buys
      // a creator buying its own coin launched through Troya (the initial buy, the dev panel) is not a trade on someone
      // else's launch: Chiron's rules leave it alone, and it is not counted towards "buys a day"
      if (side === "buy" && (params.initialBuy || params.creatorBuy)) {
        const own = (await store.readJson("launches.json", [])).find((x) => lcs(x.token) === lcs(q.tokenOut.address) && lcs(x.owner) === lcs(owner) && lcs(x.wallet) === lcs(r.address));
        if (own) side = "own-launch";
      }
      const pc = await checkAction(owner, { kind: "swap", usd, token: q.tokenOut.native ? q.tokenIn.address : q.tokenOut.address, side });
      const cap = await capCheck(owner, r, usd, source);
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
      // the lot ledger measures what arrived: the coin balance before a job buy, the ETH balance before a job sell
      const preRaw = lotBuy && !NO_BROADCAST ? await tokenRaw(w.address, q.tokenOut.address).catch(() => null) : null;
      const preWei = lotSell && !NO_BROADCAST ? await w.provider.getBalance(w.address).catch(() => null) : null;
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
      // the swap is on chain: a ledger problem from here on must never turn it into a "failed" trade, so it only warns
      if ((lotBuy || lotSell) && sends.at(-1)?.broadcast && sends.at(-1)?.status === "confirmed") {
        try {
          if (lotBuy) lotOut = { lot: await recordBuy(owner, w.address, lotBuy, q, params.amountIn, preRaw, sends, !!proposalId) };
          else lotOut = await recordSell(owner, w.address, lotSell, plan, q, preWei, sends, toRaw(params.amountIn, plan.dec) || 0n, !!proposalId);
        } catch (e) { console.warn("[agent-wallet] lot ledger:", e.message); }
      }
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
      const cap = await capCheck(owner, r, usd, source);
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
    } else if (kind === "perp_funded") {
      // Perps end to end (asked in the group, 15–16 Nov 2026): when the owner's Hyperliquid account is short of margin, the
      // Agent Wallet funds the shortfall (ETH on Robinhood Chain → USDC on the owner's own Hyperliquid account, one LI.FI
      // route) and the order opens by itself the moment the USDC lands (pendingTick below). That order runs through
      // executeForUser("perp"), so the Gate, the caps and the kill switch all apply again at that moment.
      const hl = await mod("hl");
      const lev = Math.max(1, Math.round(Number(params.leverage) || 1));
      const sizeUsd = Number(params.sizeUsd) || 0;
      if (!(sizeUsd > 0)) throw new HttpError(400, "Enter a size above zero.");
      const sim = await simulatePerp({ coin: params.coin, side: params.side, sizeUsd });
      gate = await gatePerp(sim, { leverage: lev, address: owner });
      const side = params.side === "short" ? "short" : "long";
      const order = { coin: sim.coin, side, sizeUsd, leverage: lev, slPx: Number(params.slPx) || null, tpPx: Number(params.tpPx) || null };
      summary = `${side === "short" ? "Short" : "Long"} ${sim.coin} $${sizeUsd} at ${lev}x, funding Hyperliquid first`;
      const pc = await checkAction(owner, { kind: "perp", usd: sizeUsd, leverage: lev, market: sim.coin });
      const cap = await capCheck(owner, r, sizeUsd);
      const reasons = [...pc.reasons, ...cap, ...(gate.pass ? [] : gate.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`))];
      const agents = await hl.hlInfo({ type: "extraAgents", user: lcs(owner) }).catch(() => null);
      if (Array.isArray(agents) && !agents.some((a) => lcs(a.address) === lcs(r.address) && (!a.validUntil || a.validUntil > Date.now()))) reasons.push("Approve your Agent Wallet on Hyperliquid once first (Troya → Agent → Hyperliquid trading).");
      if (reasons.length) return await blocked(owner, kind, summary, reasons, gate, source, proposalId);
      const st = await hl.hlUserState(getAddress(owner));
      const needUsd = (sizeUsd / lev) * 1.05 + 0.5;                        // the margin, plus a little for fees and the price moving
      const shortUsd = needUsd - (Number(st.withdrawable) || 0);
      if (shortUsd <= 0) return await executeForUser(owner, { kind: "perp", params: order, rationale: rationale || "Enough margin already: opened without funding", source, proposalId });
      if (!(ep > 0)) throw new HttpError(502, "No ETH price right now. Try again in a minute.");
      const fundUsd = Math.max(HL_MIN_FUND_USD, shortUsd * 1.04);           // Hyperliquid refuses deposits under 5 USDC
      const amountEth = Math.ceil((fundUsd / ep) * 1e6) / 1e6;
      const w = signer(r, owner, "robinhood");
      const wei = parseUnits(amountEth.toFixed(6), 18);
      const bal = await w.provider.getBalance(w.address);
      if (bal < wei + parseUnits("0.0002", 18)) return await blocked(owner, kind, summary, [`The Agent Wallet needs about ${(amountEth + 0.0002).toFixed(5)} ETH on Robinhood Chain to add ${fundUsd.toFixed(2)} USDC of margin; it holds ${Number(formatUnits(bal, 18)).toFixed(5)} ETH.`], gate, source, proposalId);
      const q = await hlFundQuote({ address: w.address, amountWei: wei, toAddress: owner });
      if (lcs(q.toAddress) !== lcs(owner)) throw new HttpError(502, "The route would not deliver to the owner.");
      const usdc = Number(formatUnits(q.toAmount, q.toDecimals));
      const sent = await send(owner, w, { to: q.tx.to, data: q.tx.data, value: BigInt(q.tx.value), gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n }, `Fund Hyperliquid: ${amountEth} ETH → about ${usdc.toFixed(2)} USDC for the ${sim.coin} order`);
      if (sent?.broadcast !== false) {
        const job = { id: randomBytes(5).toString("hex"), owner: lcs(owner), order, needUsd: (sizeUsd / lev) * 1.02, fundTx: sent?.hash || null, at: Date.now(), source };
        await store.update(PENDING, [], (l) => [...l.filter((x) => Date.now() - x.at < PENDING_TTL * 2), job]);
      }
      result = { ...sent, route: q.tool, fundedEth: amountEth, usdcEstimate: usdc, usdcMin: Number(formatUnits(q.toAmountMin, q.toDecimals)), pending: true,
        note: "The order opens by itself as soon as the USDC lands on Hyperliquid, usually within a minute or two. You get a message when it does." };
      usd = 0;                                                              // the perp counts against the caps when it opens
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
      const cap = await capCheck(owner, r, usd, source);
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
    } else if ((kind === "withdraw" || kind === "send") && params.token && !isNative(params.token)) {
      // a coin bought by Sentry Autopilot, Champions, the War Table or Aegis (21 Nov 2026: only ETH could leave before, so
      // those coins were stuck): an ERC-20 transfer whose recipient is always the owner, never an address from the request
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(params.token))) throw new HttpError(400, "That is not a token address.");
      const token = getAddress(params.token);
      const pc = await checkAction(owner, { kind: "withdraw" });
      if (pc.reasons.some((x) => /kill switch/.test(x))) return await blocked(owner, kind, "Withdraw a token to the owner wallet", pc.reasons, null, source, proposalId);
      const dec = await tokenDecimals(token);
      const held = await tokenRaw(r.address, token);
      if (held <= 0n) throw new HttpError(400, "The Agent Wallet holds none of this token.");
      // "all" (or no amount) sends the whole balance; a typed amount is cut at the coin's decimals and never above what is held
      const all = params.amount == null || params.amount === "" || String(params.amount).toLowerCase() === "all";
      let raw = all ? held : toRaw(String(params.amount), dec);
      if (!(raw > 0n)) throw new HttpError(400, "Enter an amount above zero.");
      if (raw > held) raw = held;
      const sym = String(params.symbol || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "token";
      summary = `Withdraw ${formatUnits(raw, dec)} $${sym} on Robinhood Chain to the owner wallet`;
      const w = signer(r, owner, "robinhood");
      result = await send(owner, w, { to: token, data: ERC20.encodeFunctionData("transfer", [getAddress(owner), raw]) }, summary);
      Object.assign(result, { token, amount: Number(formatUnits(raw, dec)) });
      usd = 0; // withdrawals to the owner never count against trading caps
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
  if (broadcast && usd > 0) { await recordUsage(owner, usd, source); await addSpent(owner, usd); }
  // V9 F48 Chiron: a buy that went out counts towards the owner's "at most N buys a day" rule
  if (broadcast && kind === "swap" && side === "buy") await import("./chiron.mjs").then((m) => m.noteBuy(owner)).catch((e) => console.warn("[agent-wallet] chiron count:", e.message));
  const status = broadcast ? "executed" : "built";
  await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary, rationale, data: { params, gate, result }, status, source });
  if (proposalId) await markProposal(owner, proposalId, broadcast ? "done" : "built", result);
  return { executed: broadcast, summary, gate, result, ...(lotOut || {}) };
}
async function blocked(owner, kind, summary, reasons, gate, source, proposalId) {
  await logAction({ address: owner, kind: `agent-wallet.${kind}`, summary, rationale: reasons.join(" "), data: { gate }, status: "blocked", source });
  if (proposalId) await markProposal(owner, proposalId, "blocked", { reasons });
  return { executed: false, blocked: true, summary, reasons, gate };
}
// V8 F44 Scepter: a proposal held by the trust ladder waits for the owner's own tap (Inbox, Scepter, a Telegram confirm).
// Unlike blocked() this leaves the proposal pending and writes no journal line: the tab Autopilot asks every 30 seconds,
// and a held proposal must still be there, untouched, when the owner comes to approve it.
const HELD = "Waiting for your approval in Scepter";
function heldForApproval(proposalId) {
  return new HttpError(409, HELD, { executed: false, blocked: true, held: true, proposalId, reasons: [HELD] });
}
// the automated job a request to /execute speaks for, or "app" for the owner's own tap (only AUTO_JOBS names count)
const jobOf = (src) => (AUTO_JOBS.includes(src) ? src : "app");

/* ---------- perps end to end: open the order once the funding lands ---------- */
const PENDING = "perp-pending.json", PENDING_TTL = 20 * 60_000, HL_MIN_FUND_USD = 6;
let pendingBusy = false;
async function pendingTick() {
  if (pendingBusy || !store) return;
  const list = await store.readJson(PENDING, []);
  if (!list.length) return;
  pendingBusy = true;
  try {
    const hl = await mod("hl");
    const { addInbox } = await import("./inbox.mjs");
    const drop = async (id) => store.update(PENDING, [], (l) => l.filter((x) => x.id !== id));
    for (const j of list) {
      const st = await hl.hlUserState(getAddress(j.owner)).catch(() => null);
      const free = Number(st?.withdrawable) || 0;
      const what = `${j.order.side === "short" ? "Short" : "Long"} ${j.order.coin} $${j.order.sizeUsd} at ${j.order.leverage}x`;
      if (st && free >= j.needUsd) {
        await drop(j.id);                                                   // never twice, even if the order below throws
        try {
          const x = await executeForUser(j.owner, { kind: "perp", params: j.order, rationale: "Opened by itself once the Hyperliquid funding landed", source: j.source || "app" });
          const res = x.result || {};
          const err = Array.isArray(res.response) ? res.response.find((y) => y?.error)?.error : null;
          const fill = Array.isArray(res.response) ? res.response.find((y) => y?.filled)?.filled : null;
          // an automated job's order, with the trust ladder moved to Approve since the funding left: it waits for a yes
          if (x.proposed) await addInbox(j.owner, { kind: "perp", title: `${what}: waiting for your approval`, body: "The USDC landed on Hyperliquid. Your trust ladder is on Approve, so the order opens only when you approve it in Agent → Scepter or Portfolio → Inbox. The USDC stays on your Hyperliquid account." });
          else if (x.blocked) await addInbox(j.owner, { kind: "perp", title: `${what}: not opened`, body: `The USDC landed on Hyperliquid, but the order stopped at the last check: ${(x.reasons || []).join(" ")} The USDC stays on your Hyperliquid account.` });
          else if (err) await addInbox(j.owner, { kind: "perp", title: `${what}: Hyperliquid refused it`, body: `${String(err).slice(0, 200)} The USDC stays on your Hyperliquid account.` });
          else await addInbox(j.owner, { kind: "perp", title: `${what}: opened`, body: `The USDC landed on Hyperliquid and the order went through the Gate and your caps${fill ? `: filled ${fill.totalSz} at ${fill.avgPx}` : ""}.` });
        } catch (e) { await addInbox(j.owner, { kind: "perp", title: `${what}: not opened`, body: `${e.message} The USDC stays on your Hyperliquid account.` }).catch(() => {}); }
      } else if (Date.now() - j.at > PENDING_TTL) {
        await drop(j.id);
        await addInbox(j.owner, { kind: "perp", title: `${what}: not opened`, body: `The Hyperliquid funding had not landed after 20 minutes, so the order was not opened. Check the funding transaction${j.fundTx ? ` ${j.fundTx}` : ""} and open the order again once the USDC is there.` }).catch(() => {});
      }
    }
  } catch (e) { console.warn("[agent-wallet] perp pending:", e.message); }
  finally { pendingBusy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  master = await loadMaster(ctx.dataDir);
  setInterval(() => pendingTick().catch(() => {}), 15_000).unref?.();

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

  r.get("/api/agent-wallet/balances", async ({ req, query }) => {
    const s = requireSession(req);
    const w = await rec(s.address);
    if (!w) throw new HttpError(404, "No Agent Wallet yet.");
    // ?tokens=0x…,0x… reads those coins too (the War Table's sell buttons ask for the coin on the page)
    const extra = String(query?.tokens || "").split(",").map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).slice(0, 10);
    return getBalances(w.address, extra);
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
    // who is asking: the owner's own tap ("app"), or an automated job speaking for itself (the tab Autopilot sends
    // source "autopilot"). A job keeps its name all the way down, so the trust ladder and its own daily cap apply to it.
    const source = jobOf(body.source);
    if (body.proposalId) {
      const p = await getProposal(s.address, String(body.proposalId));
      if (!p) throw new HttpError(404, "Proposal not found.");
      if (p.status !== "pending") throw new HttpError(409, `This proposal is ${p.status}.`);
      // held for the owner's yes: checked before anything runs, so a held playbook ("watch") proposal stays pending too
      if (source !== "app" && (await getPolicy(s.address)).effective.trust !== "auto") throw heldForApproval(p.id);
      if (p.kind === "watch") {
        const watches = await import("./watches.mjs");
        const wch = await watches.createWatch(s.address, p.params);
        await markProposal(s.address, p.id, "done", { watchId: wch.id });
        return { executed: true, summary: `Playbook created: ${wch.title}`, watch: wch };
      }
      return executeForUser(s.address, { kind: p.kind, params: p.params, rationale: p.rationale || "Approved proposal", source, proposalId: p.id, lot: p.lot || null });
    }
    const kind = String(body.kind || "");
    if (!["swap", "perp", "perp_funded", "close", "withdraw", "hl_fund"].includes(kind)) throw new HttpError(400, "Unknown action.");
    return executeForUser(s.address, { kind, params: body.params || {}, rationale: String(body.rationale || "Requested in the app").slice(0, 300), source });
  });

  r.post("/api/agent-wallet/withdraw", async ({ req, body }) => {
    const s = requireSession(req);
    return executeForUser(s.address, { kind: "withdraw", params: { chain: body.chain, amount: body.amount, token: body.token || null, symbol: body.symbol || null }, rationale: "Owner withdrawal", source: "app" });
  });

  // the lot ledger: which job holds which coins in this Agent Wallet, and how each lot closed
  r.get("/api/agent-wallet/lots", async ({ req, query }) => {
    const s = requireSession(req);
    const list = await lotsOf(s.address);
    return { items: (query?.open === "1" ? list.filter((l) => l.status === "open") : list).slice(0, 200) };
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
    // every coin it holds, not only WETH/USDG (Blockscout's token list, the same one Portfolio shows): a wallet holding only
    // memecoins counted as empty and the guard never fired (found 20 Nov 2026)
    let coins = [];
    try { coins = await (await import("./portfolio.mjs")).walletTokens(w.address); } catch {}
    const dust = (bal?.robinhoodEth || 0) > 0.00001 || (bal?.robinhoodTokens || []).length > 0 || (coins || []).some((c) => Number(c.amount) > 0) || (bal?.hyperliquid?.accountValueUsd || 0) > 0.5;
    if (dust && !w.exportedAt && body.force !== true) throw new HttpError(409, "This Agent Wallet still holds funds and its key was never exported. Withdraw or export first.");
    await store.update("agentwallets.json", {}, (all) => { delete all[k(s.address)]; });
    await logAction({ address: s.address, kind: "agent-wallet.delete", summary: `Agent Wallet ${w.address} deleted`, source: "app" });
    return { ok: true };
  });

  // policy view for the wallet tab
  r.get("/api/agent-wallet/limits", async ({ req }) => getPolicy(requireSession(req).address));
}
