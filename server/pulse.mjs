// Desk pulse (community request, 21 Nov 2026): two small live lanes for the Desk.
//   GET /api/pulse/passed     the newest coins that passed Sentry at the channel's bar (the Desk's green pill: no check
//                             failed, at least 0.5 ETH in from 25 independent buyers, not a copy or a look-alike, not a
//                             tokenized stock, no paper liquidity). Straight from Sentry's own record, nothing added.
//   GET /api/pulse/graduated  Pons coins that recently filled their bonding curve and moved to their own Uniswap v4 pool.
//                             Read from the chain: the PoolManager's Initialize event for a pool with the Pons hook, then
//                             the Pons factory confirms the coin is graduated and that this pool is its pool. The time is
//                             the block's own timestamp. Nothing is estimated or filled in.
// The graduation watcher reads new blocks every minute (one log read on our own node) and, on its first start, walks back
// PULSE_BACKFILL_H hours (default 72) one 270k-block part per minute, so a fresh server fills the lane within minutes.
//   PULSE_GRAD=0 turns the watcher off (the route then answers from what is saved in data/graduations.json).
import { ADDR, CHAINS, rpc, ponsState, ponsPublic, tokenMeta } from "./robinhood.mjs";
import { AbiCoder, getAddress } from "ethers";
import { recentResults, itemMeetsBar, isStock, paperLiquidity, cleanName, cleanSymbol, lookAlike } from "./sentry.mjs";
import { indexRow, adoptRows } from "./market.mjs";
import { bornAt } from "./tokenage.mjs";

const lc = (s) => String(s || "").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const coder = AbiCoder.defaultAbiCoder();
// PoolManager Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee,
// int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick): the same topic Sentry and robinhood.mjs read
export const T_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const STATE = "graduations.json";
const ON = process.env.PULSE_GRAD !== "0";
const BACKFILL_H = Math.max(0, Number(process.env.PULSE_BACKFILL_H ?? 72));
const PART = 270_000;                 // blocks per log read (rpc() sends it to our node in 9,000-block pieces)
const MAX_GAP = 3_000_000;            // after a long stop, new blocks are read from at most this far back (about 3.7 days)
const KEEP_MS = 14 * 86400e3, KEEP_MIN = 40, KEEP_MAX = 200;
const LANE_MS = 7 * 86400e3;          // the lane shows graduations of the last 7 days
const TICK_MS = 60_000;

/* ---------- pure helpers (no network) ---------- */
/** One PoolManager Initialize log → { id, c0, c1, fee, ts, hooks, block, tx } when the pool carries the Pons hook, else null. */
export function ponsInit(l, hook = ADDR.ponsHook) {
  try {
    if (!l || lc(l.topics?.[0]) !== T_INIT || (l.topics || []).length < 4) return null;
    const [fee, ts, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], l.data);
    if (lc(hooks) !== lc(hook)) return null;
    return {
      id: lc(l.topics[1]), c0: getAddress("0x" + l.topics[2].slice(26)), c1: getAddress("0x" + l.topics[3].slice(26)),
      fee: Number(fee), ts: Number(ts), hooks: getAddress(hooks), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash || null,
    };
  } catch { return null; }
}
/** Sentry's record → the coins that met the channel's bar, newest first, one row per coin. Mirrors /api/sentry/recent's present(). */
export function passedFrom(items, { stock = isStock, paper = (t) => paperLiquidity(indexRow(t) || {}), meets = itemMeetsBar } = {}) {
  const seen = new Set(), out = [];
  for (const x of items || []) {
    const t = lc(x?.token);
    if (!/^0x[0-9a-f]{40}$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    if (x.verdict !== "passed" || stock(t) || lookAlike(x) || paper(t) || !meets(x)) continue;
    out.push(x);
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);

/* ---------- passed ---------- */
async function passedList(limit) {
  return Promise.all(passedFrom(recentResults(200)).slice(0, limit).map(async (x) => {
    // the coin's birth from the chain (tokenage.mjs): the cache answers now, an unknown one is looked up for the next call
    const born = await bornAt(x.token, { waitMs: 0 }).catch(() => null);
    return { token: lc(x.token), symbol: x.symbol || "", name: x.name || "", source: x.source || "Pons", passedAt: x.at || null, bornAt: born || null,
      buyers: num(x.buyers), raisedEth: num(x.raised), post: x.post || null };
  }));
}

/* ---------- graduated ---------- */
let store = null, state = null, busy = false, bps = null, lastErr = null, lastTickAt = 0;
const blank = () => ({ fwd: 0, back: 0, floor: 0, items: [] });

async function blockTime(n) {
  const b = await rpc("robinhood", "eth_getBlockByNumber", ["0x" + n.toString(16), false], { timeoutMs: 12_000, bg: true });
  return b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : null;
}
// blocks a second, measured once from the chain itself (Robinhood Chain made about 9.3 a second on 21 Nov 2026)
async function blockRate(head) {
  if (bps) return bps;
  const span = 100_000;
  const [a, b] = await Promise.all([blockTime(head), blockTime(head - span)]);
  bps = a && b && a > b ? span / ((a - b) / 1000) : 9;
  return bps;
}
async function initLogs(from, to) {
  if (to < from) return [];
  return rpc("robinhood", "eth_getLogs", [{ address: ADDR.poolManager, topics: [T_INIT], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }],
    { only: CHAINS.robinhood.wide, timeoutMs: 45_000, bg: true, module: "pulse" });
}
// a Pons-hook pool is a graduation once the factory says the coin graduated and that this pool is its own
// A read that fails is tried again next minute (the cursor does not move past it); after 5 failures that pool is skipped.
const fails = new Map();
async function confirm(ev) {
  for (const a of [ev.c1, ev.c0]) {
    if (lc(a) === ZERO) continue;
    let ps;
    try { ps = await ponsState(a); }
    catch (e) {
      const n = (fails.get(ev.id) || 0) + 1;
      fails.set(ev.id, n);
      if (n < 5) return { retry: true, why: e.message };
      console.warn("[pulse] skipped pool", ev.id, "after 5 failed reads:", e.message);
      return null;
    }
    if (!ps || !ps.graduated || lc(ps.poolId) !== ev.id) continue;
    const p = ponsPublic(ps);
    const m = await tokenMeta(a).catch(() => null);
    const at = await blockTime(ev.block).catch(() => null);
    if (!at) {
      const n = (fails.get(ev.id) || 0) + 1;
      fails.set(ev.id, n);
      if (n < 5) return { retry: true, why: `block time for ${ev.block} unavailable` };
      console.warn("[pulse] skipped pool", ev.id, "after 5 failed block-time reads");
      return null;
    }
    return {
      token: lc(a), symbol: cleanSymbol(m?.symbol && m.symbol !== "?" ? m.symbol : ""), name: cleanName(m?.name || ""),
      at, block: ev.block, tx: ev.tx, poolId: ev.id,
      pair: { address: p.pair.address, symbol: p.pair.address === "native" ? "ETH" : cleanSymbol(p.pair.symbol || "") || null },
      threshold: num(p.threshold), source: "chain",
    };
  }
  return null;
}
async function absorb(logs) {
  let added = 0;
  try {
    for (const l of logs || []) {
      const ev = ponsInit(l);
      if (!ev || state.items.some((x) => x.poolId === ev.id)) continue;
      const g = await confirm(ev);
      if (g?.retry) throw new Error(g.why);
      if (!g || isStock(g.token)) continue;
      state.items.push(g);
      added++;
    }
  } finally {
    // kept newest first even when a read fails half way (what was confirmed stays; the rest is read again next minute)
    if (added) {
      state.items.sort((a, b) => b.at - a.at);
      const cut = Date.now() - KEEP_MS;
      state.items = state.items.filter((x, i) => i < KEEP_MIN || x.at >= cut).slice(0, KEEP_MAX);
    }
  }
  return added;
}
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [], { bg: true })));
    let dirty = false;
    if (!state.fwd) {
      const rate = await blockRate(head);
      state.fwd = head; state.back = head + 1; state.floor = Math.max(0, head - Math.round(BACKFILL_H * 3600 * rate));
      dirty = true;
    }
    // new blocks first: the lane is about what just happened
    if (head - state.fwd > MAX_GAP) { state.fwd = head - MAX_GAP; dirty = true; }
    if (head > state.fwd) {
      const to = Math.min(head, state.fwd + PART);
      await absorb(await initLogs(state.fwd + 1, to));
      state.fwd = to; dirty = true;
    }
    // then one older part, until the backfill window is covered
    if (state.back > state.floor) {
      const from = Math.max(state.floor, state.back - PART);
      await absorb(await initLogs(from, state.back - 1));
      state.back = from; dirty = true;
    }
    if (dirty) await store.writeJson(STATE, state);
    lastErr = null; lastTickAt = Date.now();
  } catch (e) {
    lastErr = e.message;
    console.warn("[pulse] graduations:", e.message);
  } finally { busy = false; }
}
const inLane = () => { const cut = Date.now() - LANE_MS; return state.items.filter((x) => x.at >= cut && !isStock(x.token)); };
// the Market's Graduated tab (community request, 24 Nov) reads the same list with the board's routing and volume fields,
// so its rows can carry a Buy like the other tabs; the Desk lane ignores the extra fields
function gradList(limit) {
  return inLane().slice(0, limit).map((x) => {
    const row = indexRow(x.token);   // the Market's own board row (no network call here); null when it is not listed yet
    return { ...x, priceUsd: num(row?.priceUsd), priceEth: num(row?.priceEth), mcapUsd: num(row?.mcapUsd), liquidityUsd: num(row?.liquidityUsd), realLiquidityUsd: num(row?.realLiquidityUsd),
      change24h: num(row?.change24h), volume24hUsd: num(row?.volume24hUsd), volume24hEth: num(row?.volume24hEth), txns24h: num(row?.txns24h), holders: num(row?.holders), top10Pct: num(row?.top10Pct),
      priceAt: num(row?.priceAt), spark: Array.isArray(row?.spark) ? row.spark : null, tradable: !!row?.tradable, onBoard: !!row, image: row?.image || null };
  });
}

export async function register(r, ctx) {
  store = ctx.store;
  state = { ...blank(), ...(await store.readJson(STATE, blank())) };
  if (!Array.isArray(state.items)) state.items = [];
  r.get("/api/pulse/passed", async ({ query }) => {
    const items = await passedList(Math.min(24, Math.max(1, Number(query.limit) || 12)));
    return { items, bar: "Passed with no failed check, at least 0.5 ETH in from 25 independent buyers (Sentry's channel bar)", updatedAt: Date.now() };
  }, { perMin: 240 });
  r.get("/api/pulse/graduated", ({ query }) => {
    const items = gradList(Math.min(200, Math.max(1, Number(query.limit) || 12)));
    return { items, total: inLane().length, windowDays: LANE_MS / 86400e3, watching: ON, coverage: { fromBlock: state.back || null, toBlock: state.fwd || null, backfillDone: !!state.fwd && state.back <= state.floor },
      source: "Robinhood Chain: PoolManager Initialize with the Pons hook, confirmed by the Pons factory", lastError: lastErr ? "The chain read failed on the last try; showing what is saved." : null, updatedAt: lastTickAt || null };
  }, { perMin: 240 });
  if (!ON) return;
  setTimeout(() => tick().catch(() => {}), 35_000).unref?.();
  setInterval(() => tick().catch(() => {}), TICK_MS).unref?.();
  // graduated coins the board's pages did not reach get their pool read from DexScreener (lynx_evo, 25 Nov 2026: GENESIS
  // showed no price, MC or Buy with a $19K pool)
  const adopt = () => adoptRows(inLane().filter((x) => { const r = indexRow(x.token); return !r || r._adopted || Date.now() - (r.priceAt || 0) > 20 * 60_000; }).map((x) => x.token), { launchpad: "pons" }).catch((e) => console.warn("[pulse] adopt:", e.message));
  setTimeout(adopt, 60_000).unref?.();
  setInterval(adopt, 4 * 60_000).unref?.();
}

// tests only
export const _test = { setState: (s) => { state = { ...blank(), ...s }; }, getState: () => state, absorb, tick, gradList, passedList };
