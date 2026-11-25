// V10 F67 Nekyia: The Ghost Trade (community idea). Replay a wallet's own trades on Robinhood Chain as the paths it did not
// take: if it had held until now, sold at the highest price reached while it held, or followed Troya Gate's verdict at the
// time it bought. In the Nekyia, Odysseus speaks with the ghosts of the dead. A replay from on-chain history; it never
// predicts what comes next and never says what to buy or sell.
// What it reads (nothing is guessed):
//   trades   the same swap reader as Chiron (chiron.mjs): the wallet's token transfers, transactions and internal
//            transactions from Blockscout PRO, one coin in and ETH (or WETH, USDG) out is a buy, the reverse a sell, so the
//            Pons curve, Uniswap v3/v4 and routers are all read. Round trips are Chiron's (roundTrips): a trip opens on a buy
//            while the wallet holds none and closes when 90% of what was bought has been sold. Open positions count too.
//            Trips mixed with plain transfers are left out (their cost is not known). Gas is not counted.
//   prices   from the chain at a given block, for Pons coins paired with ETH: on the curve, the exact curve sale of that size
//            with the curve's fee and creator tax (getReserves at that block); once graduated, the Uniswap v4 pool's spot price
//            at that block (slot0), before the price impact of that size, so an upper bound. Other coins get no ghost paths.
//   the top  NEKYIA_SAMPLES price reads spread over the stretch it was held (or the N days after the buy, ?days=N), then a
//            finer pass around the best one. The real peak can sit between two reads, so this can only under-state it.
//   the Gate the latest verdict Troya had recorded on that coin before the buy (Two Fates, Sentry's last results, The Record's
//            Sentry posts, Phoenix's stored setups and the Seal's Gate receipts). Blocked for a safety reason: following it
//            means no buy, so 0 ETH. Passed, passed with notes, or blocked only for its route: following it changes nothing.
//            No verdict before the buy: "no Gate verdict on record". Troya kept failed verdicts only from 25 Nov 2026.
//   GET /api/nekyia/:wallet   ?token=0x… (one coin)  ?days=N (the top within N days after the buy, 1 to 30)
// Read-only: nothing here signs, trades or moves money.
import { getAddress, isAddress, Interface } from "ethers";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./api.mjs";
import { roundTrips } from "./chiron.mjs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const PAGES = Math.max(2, Math.min(40, Number(process.env.NEKYIA_PAGES) || 12));
const DAILY_CALLS = Math.max(50, Number(process.env.NEKYIA_BS_DAILY) || 2000);
const SAMPLES = Math.max(6, Math.min(40, Number(process.env.NEKYIA_SAMPLES) || 12));
const REFINE = 6;
const MAX_TRIPS = Math.max(1, Math.min(30, Number(process.env.NEKYIA_TRIPS) || 10));
const WAIT_MS = 25_000, TTL = 20 * 60_000, TTL_SHORT = 2 * 60_000;
const VERDICT_BACK = 7 * 24 * 3600_000;
const lc = (s) => String(s || "").toLowerCase();
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const qs = (p) => (p ? "&" + new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString() : "");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const txUrl = (h) => `${EXPLORER}/tx/${h}`;
const blockUrl = (n) => `${EXPLORER}/block/${n}`;
const cleanSym = (s) => String(s || "?").replace(/[^\p{L}\p{N}$._-]/gu, "").replace(/^\$+/, "").slice(0, 16) || "?";
let store = null, dataDir = null;

/* ---------- the wallet's swaps (Chiron's reader, with Nekyia's own daily budget) ---------- */
let bsMod = null, A = null;
const budget = { day: "", calls: 0 };
class OverBudget extends Error {}
async function addrs() { if (!A) { const rh = await import("./robinhood.mjs"); A = { ...rh.ADDR, rpc: rh.rpc, iface: rh.iface }; } return A; }
async function bs(path) {
  bsMod ||= await import("./market.mjs");
  if (!bsMod.hasBlockscout()) throw new Error("Trade history is not available on this server right now (Blockscout is paused or not set up).");
  if (budget.day !== day()) { budget.day = day(); budget.calls = 0; }
  if (budget.calls + 1 > DAILY_CALLS) throw new OverBudget("Nekyia has used today's history reads. Ask again after 00:00 UTC.");
  budget.calls++;
  return bsMod.blockscoutApi(path);
}
async function pagesOf(path, max) {
  const items = [];
  let next = null, n = 0;
  do {
    const r = await bs(next ? `${path}?${qs(next).slice(1)}` : path);
    items.push(...(r?.items || []));
    next = r?.next_page_params || null;
  } while (next && ++n < max);
  const ts = items.map((x) => (x.timestamp ? Date.parse(x.timestamp) : null)).filter((x) => x != null);
  return { items, complete: !next, oldest: ts.length ? Math.min(...ts) : null };
}
async function readSwaps(a) {
  const AD = await addrs();
  const weth = lc(AD.weth), usdg = lc(AD.usdg);
  const [tt, txs, itx] = await Promise.all([pagesOf(`/addresses/${a}/token-transfers`, PAGES), pagesOf(`/addresses/${a}/transactions`, PAGES), pagesOf(`/addresses/${a}/internal-transactions`, PAGES)]);
  const since = Math.max(...[tt, txs, itx].filter((l) => !l.complete && l.oldest != null).map((l) => l.oldest), 0);
  const ethUsdNow = Number(await bsMod.getEthUsd().catch(() => 0)) || 0;
  const per = new Map();
  const row = (h, x) => { let r = per.get(h); if (!r) { r = { hash: h, at: x.timestamp ? Date.parse(x.timestamp) : null, block: Number(x.block_number || 0), eth: 0, weth: 0, usdg: 0, rate: null, coins: new Map(), failed: false }; per.set(h, r); } return r; };
  const wei = (v) => Number(BigInt(v || 0)) / 1e18;
  for (const x of txs.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since) continue;
    const r = row(lc(x.hash), x);
    if (x.status && x.status !== "ok") { r.failed = true; continue; }
    if (lc(x.from?.hash) === a) r.eth -= wei(x.value);
    if (lc(x.to?.hash) === a) r.eth += wei(x.value);
    const rate = Number(x.historic_exchange_rate || x.exchange_rate || 0);
    if (rate > 0) r.rate = rate;
  }
  for (const x of itx.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since || x.success === false || x.error || !x.value || x.value === "0") continue;
    const r = row(lc(x.transaction_hash), x);
    if (lc(x.from?.hash) === a) r.eth -= wei(x.value);
    if (lc(x.to?.hash) === a) r.eth += wei(x.value);
  }
  for (const x of tt.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since) continue;
    const tok = lc(x.token?.address_hash), type = x.token?.type || x.token_type;
    if (!tok || type !== "ERC-20") continue;
    const v = Number(x.total?.value || 0) / 10 ** Number(x.total?.decimals ?? x.token?.decimals ?? 18);
    const sign = (lc(x.to?.hash) === a ? 1 : 0) - (lc(x.from?.hash) === a ? 1 : 0);
    if (!sign || !(v > 0)) continue;
    const r = row(lc(x.transaction_hash), x);
    if (tok === weth) { r.weth += sign * v; continue; }
    if (tok === usdg) { r.usdg += sign * v; continue; }
    if (x.token?.reputation === "scam") continue;
    const c = r.coins.get(tok) || { net: 0, symbol: cleanSym(x.token?.symbol) };
    c.net += sign * v;
    r.coins.set(tok, c);
  }
  const events = [];
  for (const r of per.values()) {
    if (r.failed || !r.coins.size) continue;
    const moved = [...r.coins].filter(([, c]) => Math.abs(c.net) > 0);
    if (!moved.length) continue;
    const ethUsd = r.rate || ethUsdNow;
    const quote = r.eth + r.weth + (ethUsd > 0 ? r.usdg / ethUsd : 0);
    if (moved.length > 1) { for (const [tok, c] of moved) events.push({ token: tok, symbol: c.symbol, kind: c.net > 0 ? "in" : "out", amount: Math.abs(c.net), eth: 0, at: r.at, block: r.block, tx: r.hash }); continue; }
    const [tok, c] = moved[0];
    if (c.net > 0 && quote < -1e-12) events.push({ token: tok, symbol: c.symbol, kind: "buy", amount: c.net, eth: -quote, at: r.at, block: r.block, tx: r.hash, usdg: r.usdg !== 0 });
    else if (c.net < 0 && quote > 1e-12) events.push({ token: tok, symbol: c.symbol, kind: "sell", amount: -c.net, eth: quote, at: r.at, block: r.block, tx: r.hash, usdg: r.usdg !== 0 });
    else events.push({ token: tok, symbol: c.symbol, kind: c.net > 0 ? "in" : "out", amount: Math.abs(c.net), eth: 0, at: r.at, block: r.block, tx: r.hash });
  }
  events.sort((x, y) => x.block - y.block || x.at - y.at);
  // every buy and sell of each trip, for the evidence (roundTrips keeps only the first buy and the last sell)
  return { events, window: { from: since || null, complete: tt.complete && txs.complete && itx.complete, pages: PAGES }, transactions: per.size };
}

/* ---------- prices at a block ---------- */
const CURVE = new Interface(["function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)", "function graduated() view returns (bool)", "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)"]);
const PMI = new Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const ethPaired = (info) => !!info && (info.pair === ZERO || info.pair === lc(A?.weth)) && info.pd === 18;
async function multi(calls, block) {
  const AD = await addrs();
  const data = AD.iface.mc.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
  const raw = await AD.rpc("robinhood", "eth_call", [{ to: AD.multicall3, data }, block == null ? "latest" : "0x" + block.toString(16)], { timeoutMs: 12_000 });
  const [res] = AD.iface.mc.decodeFunctionResult("aggregate3", raw);
  return res;
}
/** the coin's state at a block: on the curve (reserves) or in its v4 pool (spot) */
async function stateAt(info, block) {
  const AD = await addrs();
  const { ponsSlot0Of } = await import("./portfolio.mjs");
  const res = await multi([{ target: info.curve, data: CURVE.encodeFunctionData("getReserves") }, { target: info.curve, data: CURVE.encodeFunctionData("graduated") },
    { target: AD.poolManager, data: PMI.encodeFunctionData("extsload", [ponsSlot0Of(info.poolId)]) }], block);
  const dec = (i, fn) => { try { return res[i].success && res[i].returnData !== "0x" ? CURVE.decodeFunctionResult(fn, res[i].returnData) : null; } catch { return null; } };
  const grad = !!dec(1, "graduated")?.[0];
  if (!grad) { const rv = dec(0, "getReserves"); return rv && rv[1] > 0n ? { phase: "curve", qr: Number(rv[0]) / 1e18, tr: Number(rv[1]) / 1e18, px: Number(rv[0]) / Number(rv[1]) } : null; }
  let w = 0n; try { w = res[2].success ? BigInt(PMI.decodeFunctionResult("extsload", res[2].returnData)[0]) : 0n; } catch {}
  const sq = w & ((1n << 160n) - 1n);
  if (!(sq > 0n)) return null;
  const sp = Number(sq) / 2 ** 96, r = sp * sp;
  return { phase: "pool", px: info.tokenFirst ? r : 1 / r };
}
/** what selling `amount` coins would have brought at that state, in ETH */
function saleOf(st, amount, fees) {
  if (!st || !(amount > 0)) return null;
  if (st.phase === "curve") { const gross = (amount * st.qr) / (st.tr + amount); return { eth: gross * (1 - fees), method: "the curve's own sale of that size, after its fee and creator tax" }; }
  return { eth: amount * st.px, method: "the Uniswap v4 pool's spot price, before the price impact of that size (an upper bound)" };
}

/* ---------- blocks and times ---------- */
async function head() {
  const AD = await addrs();
  const b = await AD.rpc("robinhood", "eth_getBlockByNumber", ["latest", false], { timeoutMs: 10_000 });
  return { n: Number(BigInt(b.number)), t: Number(BigInt(b.timestamp)) * 1000 };
}
async function blockTime(n) {
  const AD = await addrs();
  const b = await AD.rpc("robinhood", "eth_getBlockByNumber", ["0x" + n.toString(16), false], { timeoutMs: 10_000 }).catch(() => null);
  return b ? Number(BigInt(b.timestamp)) * 1000 : null;
}

/* ---------- Troya's Gate verdicts on record ---------- */
let vmemo = { at: 0, map: null };
async function sealGate() {
  const out = [];
  const dir = join(dataDir || "", "seal");
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of (await readFile(join(dir, f), "utf8").catch(() => "")).split("\n")) {
    if (!line.includes('"kind":"gate"')) continue;
    try { const x = JSON.parse(line); const v = /^(passed|caution|failed)/i.exec(String(x.ref || ""))?.[1]?.toLowerCase(); if (x.subject && v) out.push({ token: lc(x.subject), at: x.at, verdict: v, source: "a Gate check sealed in the Seal", seq: x.seq, hash: x.hash }); } catch {}
  }
  return out;
}
async function verdicts() {
  if (vmemo.map && Date.now() - vmemo.at < 5 * 60_000) return vmemo.map;
  const [fates, sentry, record, phoenix, seal] = await Promise.all([store.readJson("fates.json", { coins: {} }), store.readJson("sentry.json", {}), store.readJson("record.json", { calls: {} }),
    store.readJson("phoenix.json", {}), sealGate()]);
  const map = new Map();
  const add = (token, v) => { const k = lc(token); const l = map.get(k) || []; l.push(v); map.set(k, l); };
  for (const c of Object.values(fates.coins || {})) if (c.token && c.at) add(c.token, { at: c.at, verdict: c.cohort === "blocked" ? "failed" : "passed", reason: c.reason || null, fails: c.fails || [], source: "Two Fates (Sentry's check)" });
  for (const x of sentry.recent || []) if (x.token && x.at && ["passed", "caution", "failed"].includes(x.verdict)) add(x.token, { at: x.at, verdict: x.verdict, reason: x.reason || null, fails: x.fails || null, source: "Sentry's check", post: x.post || null });
  for (const c of Object.values(record.calls || {})) if (c.token && c.at && c.kind !== "born" && c.kind !== "stock" && c.source !== "x") add(c.token, { at: c.at, verdict: "passed", reason: null, source: "Sentry posted it (The Record)", post: c.post || null });
  for (const [t, s] of Object.entries(phoenix.setups || {})) if (s?.at && s.verdict) add(t, { at: s.at, verdict: s.verdict, reason: (s.notes || []).length ? `notes: ${s.notes.join(", ")}` : null, source: "Sentry's check (Phoenix setup)" });
  for (const x of seal) add(x.token, x);
  for (const l of map.values()) l.sort((a, b) => a.at - b.at);
  vmemo = { at: Date.now(), map };
  return map;
}
/** the latest verdict at or before the buy (within 7 days), or null */
export function verdictBefore(list, buyAt) {
  const before = (list || []).filter((v) => v.at <= buyAt + 30_000 && buyAt - v.at <= VERDICT_BACK);
  return before.length ? before[before.length - 1] : null;
}
const safetyBlock = (v) => v?.verdict === "failed" && !(Array.isArray(v.fails) ? v.fails.length && v.fails.every((k) => k === "route") : /^route\b/i.test(String(v.reason || "")));

/* ---------- one trip, its ghosts ---------- */
async function ghosts(t, ctx) {
  const { info, now, fees, days } = ctx;
  const out = { token: getAddress(t.token), symbol: t.symbol, state: t.open ? "open" : "closed", replayed: false,
    entry: { at: t.entryAt, block: t.entryBlock, tx: t.entryTx, url: txUrl(t.entryTx), costEth: t.cost, amount: t.bought, buys: t.buys },
    exit: t.open ? (t.sells ? { partial: true, sold: t.sold, proceedsEth: t.proceeds, lastTx: t.exitTx, url: t.exitTx ? txUrl(t.exitTx) : null } : null)
      : { at: t.exitAt, block: t.exitBlock, tx: t.exitTx, url: txUrl(t.exitTx), proceedsEth: t.proceeds, amount: t.sold, sells: t.sells },
    paths: {} };
  // the Gate at buy time works for any coin
  const v = verdictBefore(ctx.verdicts.get(lc(t.token)), t.entryAt);
  const later = (ctx.verdicts.get(lc(t.token)) || []).find((x) => x.at > t.entryAt + 30_000) || null;
  const actualClosed = t.open ? null : t.proceeds - t.cost;
  if (!info || !ethPaired(info)) {
    out.why = !info ? "Not a Pons launch: Nekyia reads past prices of Pons coins paired with ETH only (on their curve or their Uniswap v4 pool)." : "This Pons coin is not paired with ETH, so its price in ETH is not read here.";
    out.paths.actual = actualClosed != null ? { eth: actualClosed, txs: [t.entryTx, t.exitTx], text: "What the trades returned" } : { eth: null, text: "Still open; its value now is not read for this coin" };
    out.paths.gate = gatePath(v, later, actualClosed);
    return out;
  }
  out.replayed = true;
  const nowSt = await stateAt(info, now.n).catch(() => null);
  const holdSale = saleOf(nowSt, t.bought, fees);
  // actual: closed = proceeds - cost; open = proceeds so far + the coins still held, sold now
  if (!t.open) out.paths.actual = { eth: actualClosed, txs: [t.entryTx, t.exitTx], text: "What the trades returned" };
  else { const rest = saleOf(nowSt, Math.max(0, t.bought - t.sold), fees); out.paths.actual = { eth: rest ? t.proceeds + rest.eth - t.cost : null, txs: [t.entryTx, ...(t.exitTx ? [t.exitTx] : [])], block: now.n, blockUrl: blockUrl(now.n), method: rest?.method || null, text: "Still open: what was sold so far plus the rest at the price now" }; }
  out.paths.hold = holdSale ? { eth: holdSale.eth - t.cost, block: now.n, blockUrl: blockUrl(now.n), at: now.t, method: holdSale.method, txs: [t.entryTx], text: t.open && !t.sells ? "Held until now (it still is)" : "If nothing had been sold, valued now" }
    : { eth: null, text: "The price now could not be read" };
  // the top: the best price in the stretch it was held, or in the N days after the buy
  const rate = (now.n - t.entryBlock) / Math.max(1, (now.t - t.entryAt) / 1000);
  let to = days ? Math.min(now.n, t.entryBlock + Math.round(days * 86400 * rate)) : t.open ? now.n : t.exitBlock;
  if (!(to > t.entryBlock)) to = t.entryBlock + 1;
  const pts = [];
  const read = async (b) => { const st = await stateAt(info, b).catch(() => null); if (st) pts.push({ b, st }); };
  const span = to - t.entryBlock;
  const blocks = [...new Set(Array.from({ length: SAMPLES }, (_, i) => t.entryBlock + Math.round((span * i) / (SAMPLES - 1))))];
  for (let i = 0; i < blocks.length; i += 4) await Promise.all(blocks.slice(i, i + 4).map(read));
  if (pts.length) {
    pts.sort((a, b) => b.st.px - a.st.px);
    const best = pts[0].b, step = Math.max(1, Math.round(span / (SAMPLES - 1)));
    const fine = [...new Set(Array.from({ length: REFINE }, (_, i) => Math.round(best - step + ((2 * step) * (i + 1)) / (REFINE + 1))))].filter((b) => b > t.entryBlock && b <= to && b !== best);
    await Promise.all(fine.map(read));
    pts.sort((a, b) => b.st.px - a.st.px);
    const top = pts[0], sale = saleOf(top.st, t.bought, fees);
    const at = await blockTime(top.b);
    const entrySt = pts.find((p) => p.b === t.entryBlock)?.st || null;
    out.paths.top = sale ? { eth: sale.eth - t.cost, block: top.b, blockUrl: blockUrl(top.b), at, method: sale.method, reads: pts.length, txs: [t.entryTx],
      xOfEntry: entrySt?.px > 0 ? top.st.px / entrySt.px : null,
      text: days ? `Sold everything at the best of ${pts.length} price reads in the ${days} day${days === 1 ? "" : "s"} after the buy` : `Sold everything at the best of ${pts.length} price reads while it was held` } : { eth: null, text: "No price could be read in that stretch" };
  } else out.paths.top = { eth: null, text: "No price could be read in that stretch" };
  out.paths.gate = gatePath(v, later, out.paths.actual.eth);
  return out;
}
function gatePath(v, later, actual) {
  if (!v) return { eth: null, verdict: null, text: "No Gate verdict on record before this buy", later: later ? { at: later.at, verdict: later.verdict, source: later.source } : null };
  const block = safetyBlock(v);
  const said = v.verdict === "failed" ? (block ? "blocked" : "blocked only for its route (pay with USDG first), not a safety block") : v.verdict === "caution" ? "passed with notes" : "passed";
  return { eth: block ? 0 : actual, verdict: v.verdict, said, at: v.at, source: v.source, reason: v.reason ? String(v.reason).slice(0, 220) : null, post: v.post || null, seal: v.hash ? { seq: v.seq, hash: v.hash } : null,
    text: block ? "The Gate had blocked it: following it means no buy, so nothing gained or lost" : "The Gate let it through: following it means the same trade" };
}

/* ---------- one wallet ---------- */
const NOTE = "A replay from Robinhood Chain history, never a forecast. Nekyia shows what other choices would have returned with the prices the chain recorded; it does not say what to buy or sell. Gas is not counted. A sale valued in a Uniswap pool is at its spot price, before the price impact of that size, so it is an upper bound; on the Pons curve it is the curve's own sale of that size. The top is the best of a set of price reads, so the real peak can be higher.";
async function compute(a, { token, days }) {
  const AD = await addrs();
  const code = await AD.rpc("robinhood", "eth_getCode", [getAddress(a), "latest"], { timeoutMs: 12_000 }).catch(() => null);
  if (code && code !== "0x" && !/^0xef0100/i.test(code)) {
    const sym = await AD.rpc("robinhood", "eth_call", [{ to: getAddress(a), data: "0x95d89b41" }, "latest"], { timeoutMs: 8000 }).catch(() => null);
    if (sym && sym !== "0x") return { address: getAddress(a), status: "none", sentence: "This is a token contract, not a trader wallet. Paste the wallet that trades it.", trips: [], checkedAt: Date.now() };
  }
  const s = await readSwaps(a);
  const rt = roundTrips(s.events);
  let trips = [...rt.trips.map((t) => ({ ...t, open: false })), ...rt.open.filter((t) => !t.mixed && t.cost > 0).map((t) => ({ ...t, open: true }))];
  if (token) trips = trips.filter((t) => t.token === lc(token));
  trips.sort((x, y) => y.entryAt - x.entryAt);
  const base = { address: getAddress(a), token: token ? getAddress(token) : null, days: days || null, window: s.window, checkedAt: Date.now(), note: NOTE,
    sample: { closed: rt.trips.length, open: rt.open.filter((t) => !t.mixed && t.cost > 0).length, leftOut: { mixedWithTransfers: rt.tainted, soldBeforeHistory: rt.unmatched, dust: rt.dust }, transactions: s.transactions } };
  if (!trips.length) return { ...base, status: "none", sentence: token ? "No buys of this coin against ETH were found in this wallet's history read." : `No trades of Robinhood Chain coins against ETH were found in this wallet's history read (${s.transactions} transactions).`, trips: [] };
  const replay = trips.slice(0, MAX_TRIPS);
  const { ponsInfo } = await import("./portfolio.mjs");
  const pons = await ponsInfo([...new Set(replay.map((t) => t.token))]).catch(() => new Map());
  const now = await head();
  const vmap = await verdicts();
  // the curve's fee and creator tax, per coin (fixed at launch)
  const feeOf = new Map();
  await Promise.all([...pons].map(async ([tok, info]) => {
    const r = await multi([{ target: info.curve, data: CURVE.encodeFunctionData("feeBps") }, { target: info.curve, data: CURVE.encodeFunctionData("creatorTaxBps") }]).catch(() => null);
    const n = (i, fn) => { try { return r[i].success ? Number(CURVE.decodeFunctionResult(fn, r[i].returnData)[0]) : null; } catch { return null; } };
    feeOf.set(tok, r ? ((n(0, "feeBps") ?? 100) + (n(1, "creatorTaxBps") ?? 0)) / 10_000 : 0.01);
  }));
  const out = [];
  for (const t of replay) out.push(await ghosts(t, { info: pons.get(t.token), now, fees: feeOf.get(t.token) ?? 0.01, days, verdicts: vmap }).catch((e) => ({ token: getAddress(t.token), symbol: t.symbol, state: t.open ? "open" : "closed", replayed: false, why: `Could not be replayed just now (${String(e.message || e).slice(0, 100)})`, paths: {} })));
  // totals over the trips where each path has a number, with how many
  const totals = {};
  for (const k of ["actual", "hold", "top", "gate"]) {
    const xs = out.filter((t) => t.paths?.[k]?.eth != null);
    totals[k] = { eth: xs.reduce((s, t) => s + t.paths[k].eth, 0), trips: xs.length };
  }
  const both = out.filter((t) => ["actual", "hold", "top", "gate"].every((k) => t.paths?.[k]?.eth != null));
  totals.comparable = { trips: both.length, ...Object.fromEntries(["actual", "hold", "top", "gate"].map((k) => [k, both.reduce((s, t) => s + t.paths[k].eth, 0)])) };
  const gateKnown = out.filter((t) => t.paths?.gate?.verdict).length;
  return {
    ...base, status: "done", trips: out, totals, head: now,
    replayed: { shown: out.length, of: trips.length, limit: MAX_TRIPS, gateVerdicts: gateKnown },
    sentence: `${out.length} of this wallet's ${trips.length} round trip${trips.length === 1 ? "" : "s"}${token ? " in this coin" : ""} replayed (the newest first${trips.length > MAX_TRIPS ? `, up to ${MAX_TRIPS}` : ""}); a Gate verdict was on record before ${gateKnown} of the buys.`,
  };
}

const memo = new Map(), inflight = new Map();
let running = 0;
const queue = [];
async function slot(fn) { if (running >= 2) await new Promise((r) => queue.push(r)); running++; try { return await fn(); } finally { running--; queue.shift()?.(); } }
export async function nekyia(address, { token = null, days = null, waitMs = WAIT_MS } = {}) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a wallet address on Robinhood Chain (0x + 40 hex).");
  if (token && !isAddress(String(token))) throw new HttpError(400, "The coin is not a valid 0x address.");
  const d = days == null || days === "" ? null : Math.round(Number(days));
  if (d != null && !(d >= 1 && d <= 30)) throw new HttpError(400, "days is 1 to 30.");
  const k = `${lc(address)}|${lc(token)}|${d || ""}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) {
    const startedAt = Date.now();
    const p = slot(() => compute(lc(address), { token: token ? lc(token) : null, days: d })).then((res) => {
      memo.set(k, { at: Date.now(), ttl: TTL, res }); if (memo.size > 500) memo.delete(memo.keys().next().value); return res;
    }, (e) => {
      if (!(e instanceof OverBudget)) console.warn("[nekyia]", lc(address), e?.stack || e);
      const res = { address: getAddress(lc(address)), status: e instanceof OverBudget ? "busy" : "error", sentence: e instanceof OverBudget ? e.message : `The wallet's history could not be read just now (${String(e.message || e).slice(0, 140)}). Ask again in a minute.`, trips: [], checkedAt: Date.now() };
      memo.set(k, { at: Date.now(), ttl: TTL_SHORT / 2, res }); return res;
    }).finally(() => inflight.delete(k));
    p.startedAt = startedAt;
    inflight.set(k, p);
  }
  const p = inflight.get(k);
  const r = await Promise.race([p, sleep(waitMs).then(() => null)]);
  return r || { address: getAddress(lc(address)), status: "reading", startedAt: p.startedAt, sentence: "Reading this wallet's trades and the prices the chain recorded while it held them. This takes up to a minute the first time.", trips: [] };
}

export async function register(r, ctx) {
  store = ctx.store;
  dataDir = ctx.dataDir || store?.dir || null;
  r.get("/api/nekyia/:wallet", ({ params, query }) => nekyia(params.wallet, { token: query.token || null, days: query.days }), { weight: 1, perMin: 30 });
}
