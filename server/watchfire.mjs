// V8 F39 Watchfire: keeps watching coins after launch, for rings and herds. Alerts and receipts; the paper Arena acts
// on "fire". Real-money exits stay off until their real-money test (ARENA_WATCHFIRE_LIVE=1).
//
// Built from the $SUPLEX forensics (20 Nov 2026, research_notes/Riset V8 Agamemnon…/watchfire_forensics_suplex.md):
// 61 wallets of one operator sent their coins to one wallet within 0.4 s, that wallet sold 17% of the supply 1 s later
// and 13 more wallets sold in the same block, all through a busy trading router. Funding checks missed them (aged
// wallets, each first funded with dust from a different address), so the signals here are behaviour, read live from
// Transfer logs:
//   · gather    at least 5 different wallets send the coin to one wallet (not a pool, curve or router) within 5 s → fire
//   · whale     one sale of at least 5% of the supply                                                          → fire
//   · velocity  holders sold at least 8% of what they hold in 60 s, with at least 4 sellers and twice as many
//               sellers as buyers in 2 minutes                                                                  → red
//   · weight    one holder with at least 10% of the supply, or at least 40% of what holders hold bought through
//               one router                                                                                     → amber
// Live feed: a WebSocket logs subscription (ROBINHOOD_WSS) for every watched coin, plus an HTTP poll that fills any gap
// (every 1.5 s when the socket is quiet). Watched: coins the Arena holds, and coins asked for at /api/watchfire/:token
// (for 30 minutes).
//   GET /api/watchfire/:token   one coin's state: level, reasons, top holders, recent signals (starts watching it)
//   GET /api/watchfire          every watched coin and the recent fires
import { Interface, getAddress, isAddress, zeroPadValue } from "ethers";
import { createRequire } from "node:module";
import { rpc, ADDR, CHAINS } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const require = createRequire(import.meta.url);
const fi = new Interface(require("./abi/pons-v2-factory.json").abi);
const ERC20 = new Interface(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const BLOCK_S = 0.1;                                   // Robinhood Chain: ~0.1 s blocks (7,484 blocks in 751 s on 19 Nov)
const RULES = { gatherSenders: 5, gatherSecs: 5, whalePct: 5, velocityPct: 8, velocitySellers: 4, topPct: 10, herdPct: 40 };
const HISTORY_BLOCKS = 6 * 3600 / BLOCK_S;             // a coin's past is read up to 6 hours back
const ASK_MS = 30 * 60_000, FIRE_MS = 10 * 60_000, RED_MS = 3 * 60_000;
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const num = (h) => Number(BigInt(h));
const topicAddr = (t) => "0x" + String(t).slice(26).toLowerCase();
let store = null;
const W = new Map();                                    // token → state
const fires = [];                                       // recent fires, newest first

/* ---------- one coin's state ---------- */
function blank(token) {
  return { token, symbol: null, decimals: 18, supply: 0, venues: new Set([lc(ADDR.poolManager)]), routers: new Set(), bal: new Map(), via: new Map(),
    events: [], p2p: [], seen: new Set(), lastBlock: 0, loading: null, ready: false, until: 0, reasons: new Set(), level: "clear", why: [],
    fireAt: 0, fireKind: null, redAt: 0, lastFire: null, headBlock: 0,
    launchBlock: 0, dev: new Set(), insiders: new Set(), snipers: new Set(), bundlers: new Set(), ring: new Set(), early: [], trades: [] };
}
const amountOf = (st, h) => Number(BigInt(h) / 10n ** BigInt(Math.max(0, st.decimals - 6))) / 1e6;
async function call(to, data) { return rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 12_000 }); }
// long ranges go to the official RPC (30k-block eth_getLogs, as Ring Radar and Sentry do); if it fails, smaller pieces
// through the normal upstreams (Chainstack takes a few thousand blocks; a free mirror only 100, so it is never asked)
async function getLogs(tokens, from, to) {
  const out = [];
  const piece = async (a, b, step) => {
    for (let x = a; x <= b; x += step) {
      const y = Math.min(b, x + step - 1);
      const q = [{ address: tokens, topics: [T_TRANSFER], fromBlock: hex(x), toBlock: hex(y) }];
      // the paid Chainstack node first (up to 10,000 blocks a call); the free official RPC only when it fails, so a burst
      // of coin loads never runs the official RPC into its rate limit (20 Nov: one 429 on the flywheel scan)
      let r = await rpc("robinhood", "eth_getLogs", q, { timeoutMs: 15_000 }).catch(() => null);
      if (!Array.isArray(r) && step > 3_000) r = await rpc("robinhood", "eth_getLogs", q, { timeoutMs: 20_000, only: CHAINS.robinhood.wide }).catch(() => null);
      if (Array.isArray(r)) out.push(...r);
      else if (step > 500) await piece(x, y, step > 3_000 ? 2_500 : Math.floor(step / 5));
      else throw new Error("could not read transfers");
    }
  };
  await piece(from, to, to - from > 3_000 ? 9_000 : 2_500);
  return out;
}
async function load(st) {
  const t = st.token;
  const [sup, dec, sym] = await Promise.all([call(t, ERC20.encodeFunctionData("totalSupply")), call(t, ERC20.encodeFunctionData("decimals")).catch(() => null), call(t, ERC20.encodeFunctionData("symbol")).catch(() => null)]);
  st.decimals = dec && dec !== "0x" ? Number(ERC20.decodeFunctionResult("decimals", dec)[0]) : 18;
  st.supply = amountOf(st, sup);
  try { st.symbol = sym ? ERC20.decodeFunctionResult("symbol", sym)[0] : null; } catch { st.symbol = null; }
  // venues: the Pons curve (if any), Uniswap v4's pool manager, and the coin's v3 pools from the market board
  const lt = await call(ADDR.ponsFactory, fi.encodeFunctionData("getLaunchedToken", [t])).catch(() => null);
  if (lt) { try { const c = lc(fi.decodeFunctionResult("getLaunchedToken", lt)[0].curve); if (c && c !== ZERO) st.venues.add(c); } catch { /* not Pons */ } }
  const row = await import("./market.mjs").then((m) => m.indexRow(t)).catch(() => null);
  for (const p of row?.pools || []) if (isAddress(String(p.pool || ""))) st.venues.add(lc(p.pool));
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const launch = await import("./ringradar.mjs").then((m) => m.findLaunchTx(t)).catch(() => null);
  st.launchBlock = launch?.block || 0;
  const rr = launch ? await import("./ringradar.mjs").then((m) => m.ringCheck(t, launch)).catch(() => null) : null;
  if (rr?.launch?.deployer) st.dev.add(lc(rr.launch.deployer));
  for (const w of rr?.exemptions?.wallets || []) if (!st.dev.has(lc(w))) st.insiders.add(lc(w));
  const from = Math.max(launch?.block || 0, head - HISTORY_BLOCKS);
  st.fullHistory = !!(launch?.block && launch.block >= head - HISTORY_BLOCKS);
  const logs = await getLogs([getAddress(t)], from, head);
  ingest(st, logs, { history: true });
  st.lastBlock = head; st.headBlock = head; st.ready = true;
  evaluate(st, head);
}

/* ---------- reading transfers: buys, sells, wallet-to-wallet moves ---------- */
function ingest(st, logs, { history = false } = {}) {
  const byTx = new Map();
  for (const l of logs) {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (st.seen.has(k)) continue;
    st.seen.add(k);
    if (st.seen.size > 20_000) st.seen = new Set([...st.seen].slice(-10_000));
    const g = byTx.get(l.transactionHash) || []; g.push(l); byTx.set(l.transactionHash, g);
  }
  const V = st.venues;
  for (const [tx, g] of byTx) {
    const block = num(g[0].blockNumber);
    const moves = g.map((l) => ({ from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), a: amountOf(st, l.data) }));
    // a router sits in the middle of a trade: wallet → R → venue (a sale) or venue → R → wallet (a buy), in one tx
    for (const m of moves) {
      if (V.has(m.to) && !V.has(m.from) && moves.some((x) => x.to === m.from && !V.has(x.from) && x.from !== ZERO)) st.routers.add(m.from);
      if (V.has(m.from) && !V.has(m.to) && moves.some((x) => x.from === m.to && !V.has(x.to) && x.to !== ZERO)) st.routers.add(m.to);
    }
    const buyersInTx = new Set();
    for (const m of moves) {
      // seeding the curve or pool at launch moves (nearly) the whole supply: not a trade
      const seed = st.supply > 0 && m.a >= 0.9 * st.supply;
      // balances for every wallet (venues, routers and the zero address are not holders)
      if (m.from !== ZERO) st.bal.set(m.from, (st.bal.get(m.from) || 0) - m.a);
      st.bal.set(m.to, (st.bal.get(m.to) || 0) + m.a);
      const R = st.routers;
      if (seed) continue;
      if (V.has(m.to) && !V.has(m.from)) {
        const via = moves.find((x) => x.to === m.from && !V.has(x.from) && x.from !== ZERO);
        st.events.push({ block, tx, kind: "sell", wallet: via ? via.from : m.from, a: m.a, router: via ? m.from : null });
        st.trades.push({ block, tx, kind: "sell", wallet: via ? via.from : m.from, a: m.a, router: via ? m.from : null });
      } else if (V.has(m.from) && !V.has(m.to) && m.to !== ZERO) {
        const fwd = moves.find((x) => x.from === m.to && !V.has(x.to) && x.to !== ZERO);
        const wallet = fwd ? fwd.to : m.to;
        st.events.push({ block, tx, kind: "buy", wallet, a: m.a, router: fwd ? m.to : null });
        st.trades.push({ block, tx, kind: "buy", wallet, a: m.a, router: fwd ? m.to : null });
        if (!st.via.has(wallet)) st.via.set(wallet, fwd ? m.to : "direct");
        buyersInTx.add(wallet);
        if (st.launchBlock && block <= st.launchBlock + 120) st.snipers.add(wallet);            // the first ~12 seconds
        if (st.early.length < 60 && !st.early.some((e) => e.wallet === wallet)) st.early.push({ wallet, block, a: m.a, router: fwd ? m.to : null });
      } else if (m.from !== ZERO && m.to !== ZERO && m.to !== DEAD && !R.has(m.from) && !R.has(m.to) && !V.has(m.from) && !V.has(m.to)) {
        st.p2p.push({ block, tx, from: m.from, to: m.to, a: m.a });
      }
    }
    if (buyersInTx.size >= 3) for (const w of buyersInTx) st.bundlers.add(w);              // one tx buying for 3+ wallets
    if (!history) evaluate(st, block);
  }
  if (st.trades.length > 600) st.trades = st.trades.slice(-300);
  // keep the last ~10 minutes of signals
  const keep = (st.lastBlock || 0) - 600 / BLOCK_S;
  if (st.events.length > 5_000) st.events = st.events.filter((e) => e.block >= keep);
  if (st.p2p.length > 2_000) st.p2p = st.p2p.filter((e) => e.block >= keep);
}

/* ---------- the verdict ---------- */
function holders(st) {
  const skip = (w) => st.venues.has(w) || st.routers.has(w) || w === ZERO || w === DEAD || w === st.token;
  return [...st.bal.entries()].filter(([w, v]) => v > 1e-6 && !skip(w)).sort((a, b) => b[1] - a[1]);
}
function evaluate(st, B) {
  const since = (secs) => B - secs / BLOCK_S;
  const hs = holders(st);
  const held = hs.reduce((s, [, v]) => s + v, 0);
  const why = [];
  let level = "clear", kind = null, detail = null;
  // gather: many wallets to one wallet within a few seconds
  const g = new Map();
  for (const e of st.p2p) if (e.block > since(RULES.gatherSecs) && e.block <= B) { const r = g.get(e.to) || { senders: new Set(), a: 0, tx: e.tx }; r.senders.add(e.from); r.a += e.a; g.set(e.to, r); }
  const gather = [...g.entries()].sort((a, b) => b[1].senders.size - a[1].senders.size)[0];
  if (gather && gather[1].senders.size >= RULES.gatherSenders) { for (const w of gather[1].senders) st.ring.add(w); st.ring.add(gather[0]); level = "fire"; kind = "gather"; detail = `${gather[1].senders.size} wallets sent ${pctOf(gather[1].a, st.supply)}% of the supply to ${short(gather[0])} within ${RULES.gatherSecs} s`; }
  // whale: one sale of a big slice of the supply
  const bigSell = st.events.filter((e) => e.kind === "sell" && e.block > since(10) && e.block <= B && st.supply > 0 && (100 * e.a) / st.supply >= RULES.whalePct).sort((a, b) => b.a - a.a)[0];
  if (!kind && bigSell) { level = "fire"; kind = "whale"; detail = `one wallet sold ${pctOf(bigSell.a, st.supply)}% of the supply in one trade`; }
  // velocity: holders leaving fast
  const w60 = st.events.filter((e) => e.block > since(60) && e.block <= B), w120 = st.events.filter((e) => e.block > since(120) && e.block <= B);
  const sold60 = w60.filter((e) => e.kind === "sell").reduce((s, e) => s + e.a, 0);
  const sellers = new Set(w120.filter((e) => e.kind === "sell").map((e) => e.wallet)).size, buyers = new Set(w120.filter((e) => e.kind === "buy").map((e) => e.wallet)).size;
  const soldPct = held > 0 ? (100 * sold60) / (held + sold60) : 0;
  const velocity = soldPct >= RULES.velocityPct && sellers >= RULES.velocitySellers && sellers >= 2 * Math.max(1, buyers);
  if (velocity) why.push(`holders sold ${soldPct.toFixed(1)}% of what they hold in the last minute (${sellers} sellers, ${buyers} buyers in 2 minutes)`);
  // weight: one big holder, or a crowd from one router
  const top = hs[0];
  const topPct = top && st.supply > 0 ? (100 * top[1]) / st.supply : 0;
  if (topPct >= RULES.topPct) why.push(`one wallet holds ${topPct.toFixed(1)}% of the supply`);
  const byRouter = new Map(); for (const [w, v] of hs) { const r = st.via.get(w); if (r && r !== "direct") byRouter.set(r, (byRouter.get(r) || 0) + v); }
  const herd = [...byRouter.entries()].sort((a, b) => b[1] - a[1])[0];
  const herdPct = herd && held > 0 ? (100 * herd[1]) / held : 0;
  if (herdPct >= RULES.herdPct) why.push(`${herdPct.toFixed(0)}% of what holders hold was bought through one trading router`);
  // sticky levels: a fire stays 10 minutes, red 3 minutes
  const now = Date.now();
  if (kind) {
    const fresh = !st.fireAt || now - st.fireAt > FIRE_MS || st.fireKind !== kind;
    st.fireAt = now; st.fireKind = kind; st.lastFire = { kind, detail, block: B, at: now };
    if (fresh) onFire(st, kind, detail, B);
  }
  if (velocity) st.redAt = now;
  if (level !== "fire" && st.fireAt && now - st.fireAt < FIRE_MS) level = "fire";
  else if (level !== "fire" && (velocity || (st.redAt && now - st.redAt < RED_MS))) level = "red";
  else if (level === "clear" && (topPct >= RULES.topPct || herdPct >= RULES.herdPct)) level = "amber";
  st.level = level;
  st.why = [...(st.lastFire && level === "fire" ? [st.lastFire.detail] : []), ...why];
  st.metrics = { holders: hs.length, heldPct: st.supply ? +((100 * held) / st.supply).toFixed(2) : null, topPct: +topPct.toFixed(2), herdPct: +herdPct.toFixed(1), soldLastMinPct: +soldPct.toFixed(2), sellers2m: sellers, buyers2m: buyers, block: B };
  st.top = hs.slice(0, 10).map(([w, v]) => ({ wallet: getAddress(w), pct: st.supply ? +((100 * v) / st.supply).toFixed(2) : null, via: st.via.get(w) && st.via.get(w) !== "direct" ? getAddress(st.via.get(w)) : null }));
}
const pctOf = (a, s) => (s > 0 ? ((100 * a) / s).toFixed(1) : "?");
const short = (a) => `${getAddress(a).slice(0, 6)}…${a.slice(-4)}`;

let fireHook = null;                                   // the back-test collects fires instead of acting on them
function onFire(st, kind, detail, block) {
  if (fireHook) return fireHook(st, kind, detail, block);
  const f = { token: getAddress(st.token), symbol: st.symbol, kind, detail, block, at: Date.now() };
  fires.unshift(f); fires.length = Math.min(fires.length, 100);
  console.log(`[watchfire] fire $${st.symbol || "?"} ${kind}: ${detail}`);
  import("./arena.mjs").then((m) => m.watchfireFire?.(st.token, f)).catch(() => {});
  import("./seal.mjs").then((m) => m.seal("watchfire", f.token, f, `Watchfire: ${kind} on $${st.symbol || "?"}`)).catch(() => {});
  // everyone who pinned the coin hears it at once: inbox and Telegram
  const owners = pinned.get(lc(st.token)) || [];
  if (owners.length) import("./inbox.mjs").then(async (m) => { for (const o of owners) await m.addInbox(o, { kind: "watchfire", title: `Watchfire FIRE: $${st.symbol || "?"}`, body: `${detail}. troya.codes/agent#/token/${f.token}`, data: { watchfire: f } }).catch(() => {}); }).catch(() => {});
  store?.update("watchfire.json", {}, (s) => { s.fires = [f, ...(s.fires || [])].slice(0, 300); return s; }).catch(() => {});
}

/* ---------- War Table: labelled trades, early buyers and holders for one coin ---------- */
function tagsOf(st, w) {
  const t = [];
  if (st.dev.has(w)) t.push("dev");
  if (st.insiders.has(w)) t.push("insider");
  if (st.snipers.has(w)) t.push("sniper");
  if (st.bundlers.has(w)) t.push("bundler");
  if (st.ring.has(w)) t.push("ring");
  const b = st.bal.get(w) || 0;
  if (st.supply > 0 && b / st.supply >= 0.01) t.push("whale");
  const v = st.via.get(w);
  if (v && v !== "direct") t.push("bot");
  return t;
}
export function board(token) {
  const st = W.get(lc(token));
  if (!st?.ready) return null;
  const head = Math.max(st.headBlock, st.lastBlock);
  const ago = (b) => Math.max(0, Math.round((head - b) * BLOCK_S));
  const pct = (a) => (st.supply > 0 ? +((100 * a) / st.supply).toFixed(3) : null);
  const trades = st.trades.slice(-150).reverse().map((e) => ({ kind: e.kind, wallet: getAddress(e.wallet), pct: pct(e.a), tokens: +e.a.toFixed(2), secsAgo: ago(e.block), tx: e.tx, via: e.router ? getAddress(e.router) : null, tags: tagsOf(st, e.wallet) }));
  const early = st.early.map((e) => {
    const now = Math.max(0, st.bal.get(e.wallet) || 0);
    return { wallet: getAddress(e.wallet), secsAfterLaunch: st.launchBlock ? Math.round((e.block - st.launchBlock) * BLOCK_S) : null, boughtPct: pct(e.a), nowPct: pct(now),
      status: now <= e.a * 0.02 ? "sold all" : now < e.a * 0.9 ? "sold part" : now > e.a * 1.1 ? "bought more" : "holding", tags: tagsOf(st, e.wallet) };
  });
  const hs = holders(st).slice(0, 50).map(([w, v]) => ({ wallet: getAddress(w), pct: pct(v), tags: tagsOf(st, w), via: st.via.get(w) && st.via.get(w) !== "direct" ? getAddress(st.via.get(w)) : null }));
  const counts = {}; for (const k of ["dev", "insider", "sniper", "bundler", "ring", "whale", "bot"]) counts[k] = 0;
  for (const w of new Set([...st.trades.map((e) => e.wallet), ...st.early.map((e) => e.wallet)])) for (const k of tagsOf(st, w)) counts[k]++;
  return { token: getAddress(st.token), symbol: st.symbol, level: st.level, why: st.why, metrics: st.metrics, lastFire: st.lastFire, fullHistory: !!st.fullHistory,
    trades, early, holders: hs, counts, devs: [...st.dev].map((w) => getAddress(w)), at: Date.now() };
}

/* ---------- which coins are watched ---------- */
export function watch(token, reason = "ask") {
  const t = lc(token);
  if (!isAddress(t)) return null;
  let st = W.get(t);
  if (!st) { st = blank(t); W.set(t, st); }
  st.reasons.add(reason);
  if (reason === "ask") st.until = Math.max(st.until, Date.now() + ASK_MS);
  if (!st.ready && !st.loading) st.loading = load(st).catch((e) => { console.warn("[watchfire] load", t, e.message); W.delete(t); }).finally(() => { st.loading = null; resubscribe(); });
  return st;
}
export function watchfireState(token) {
  const st = W.get(lc(token));
  return st?.ready ? { level: st.level, why: st.why, lastFire: st.lastFire } : null;
}
const MAX_WATCH = 150;
let pinned = new Map();                                 // token → owners who pinned it (Treasury)
async function syncArena() {
  const d = await store.readJson("arena.json", {}).catch(() => ({}));
  const open = new Set((d.positions || []).filter((p) => p.status === "open").map((p) => lc(p.token)));
  for (const t of open) watch(t, "arena");
  // the coins Aegis guards for users: their holders get Watchfire's alerts through Aegis
  const ag = await store.readJson("aegis.json", {}).catch(() => ({}));
  const guarded = new Set(Object.keys(ag.coins || {}).map(lc).filter((t) => isAddress(t)));
  for (const t of guarded) if (W.size < MAX_WATCH || W.has(t)) watch(t, "aegis");
  // V8 F46 Treasury: coins holders pinned to Watchfire
  pinned = await import("./treasury.mjs").then((m) => m.allPins()).catch(() => pinned);
  for (const t of pinned.keys()) if (W.size < MAX_WATCH || W.has(t)) watch(t, "pin");
  for (const [t, st] of W) {
    if (!guarded.has(t)) st.reasons.delete("aegis");
    if (!pinned.has(t)) st.reasons.delete("pin");
    if (!open.has(t)) st.reasons.delete("arena");
    if (st.reasons.has("ask") && Date.now() > st.until) st.reasons.delete("ask");
    if (!st.reasons.size && !st.loading) W.delete(t);
  }
  resubscribe();
}

/* ---------- live feed: WebSocket logs subscription, HTTP fill ---------- */
let ws = null, subId = null, subKey = "", lastMsg = 0, rid = 0;
const pending = new Map();                             // rpc id → resolver
function send(method, params) { return new Promise((res) => { const id = ++rid; pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); setTimeout(() => { if (pending.delete(id)) res(null); }, 10_000); }); }
function connect() {
  const url = process.env.ROBINHOOD_WSS;
  if (!url || typeof WebSocket !== "function") { console.warn(`[watchfire] no live feed (${url ? "no WebSocket in this Node" : "ROBINHOOD_WSS not set"}); polling only`); return; }
  try { ws = new WebSocket(url); } catch (e) { console.warn("[watchfire] ws", e.message); ws = null; setTimeout(connect, 15_000); return; }
  ws.onopen = () => { subId = null; subKey = ""; console.log("[watchfire] live feed connected"); resubscribe(); };
  ws.onmessage = (m) => {
    lastMsg = Date.now();
    let j; try { j = JSON.parse(m.data); } catch { return; }
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result ?? null); pending.delete(j.id); return; }
    if (j.method === "eth_subscription" && j.params?.subscription === subId) queueLog(j.params.result);
  };
  ws.onclose = (e) => { console.warn(`[watchfire] live feed closed (${e?.code || "?"}), reconnecting`); ws = null; subId = null; subKey = ""; setTimeout(connect, 5_000); };
  ws.onerror = () => {};
}
async function resubscribe() {
  if (!ws || ws.readyState !== 1) return;
  const tokens = [...W.values()].filter((s) => s.ready).map((s) => getAddress(s.token)).sort();
  const key = tokens.join(",");
  if (key === subKey) return;
  subKey = key;
  if (subId) { await send("eth_unsubscribe", [subId]); subId = null; }
  if (tokens.length) { subId = await send("eth_subscribe", ["logs", { address: tokens, topics: [T_TRANSFER] }]); console.log(`[watchfire] live feed on ${tokens.length} coin(s): ${subId ? "subscribed" : "subscribe failed"}`); if (!subId) subKey = ""; }
}
// logs arrive one by one: hold them a moment so a transaction's transfers are read together
let queue = [], flushT = null;
function queueLog(l) {
  if (!l || l.removed) return;
  queue.push(l);
  if (!flushT) flushT = setTimeout(flush, 60);
}
function flush() {
  flushT = null;
  const batch = queue; queue = [];
  const by = new Map();
  for (const l of batch) { const t = lc(l.address); if (!by.has(t)) by.set(t, []); by.get(t).push(l); }
  for (const [t, ls] of by) {
    const st = W.get(t);
    if (!st?.ready) continue;
    ingest(st, ls);
    const b = Math.max(...ls.map((l) => num(l.blockNumber)));
    st.lastBlock = Math.max(st.lastBlock, b); st.headBlock = Math.max(st.headBlock, b);
  }
}
let polling = false;
async function poll() {
  if (polling) return;
  const ready = [...W.values()].filter((s) => s.ready);
  if (!ready.length) return;
  if (ws && ws.readyState === 1 && subId && Date.now() - lastMsg < 5_000) return;   // the socket is live
  polling = true;
  try {
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [], { timeoutMs: 5_000 })));
    const from = Math.min(...ready.map((s) => s.lastBlock + 1));
    if (head < from) return;
    const logs = await getLogs(ready.map((s) => getAddress(s.token)), Math.max(from, head - 30_000), head);
    const by = new Map(); for (const l of logs) { const t = lc(l.address); if (!by.has(t)) by.set(t, []); by.get(t).push(l); }
    for (const st of ready) { ingest(st, by.get(st.token) || []); st.lastBlock = head; st.headBlock = head; evaluate(st, head); }
  } catch (e) { /* next round */ }
  finally { polling = false; }
}
// sticky levels decay even when a coin goes quiet
setInterval(() => { for (const st of W.values()) if (st.ready) evaluate(st, Math.max(st.headBlock, st.lastBlock)); }, 15_000).unref?.();

/* ---------- back-test: the same rules over a coin's past, block by block ---------- */
export async function backtest(token, fromBlock, toBlock) {
  const t = lc(token), st = blank(t);
  const [sup, dec] = await Promise.all([call(t, ERC20.encodeFunctionData("totalSupply")), call(t, ERC20.encodeFunctionData("decimals")).catch(() => null)]);
  st.decimals = dec && dec !== "0x" ? Number(ERC20.decodeFunctionResult("decimals", dec)[0]) : 18;
  st.supply = amountOf(st, sup);
  const lt = await call(ADDR.ponsFactory, fi.encodeFunctionData("getLaunchedToken", [t])).catch(() => null);
  if (lt) { try { const c = lc(fi.decodeFunctionResult("getLaunchedToken", lt)[0].curve); if (c && c !== ZERO) st.venues.add(c); } catch { /* not Pons */ } }
  const logs = await getLogs([getAddress(t)], fromBlock, toBlock);
  const byBlock = new Map(); for (const l of logs) { const b = num(l.blockNumber); if (!byBlock.has(b)) byBlock.set(b, []); byBlock.get(b).push(l); }
  const found = [];
  const add = (block, kind, detail) => { if (!found.some((f) => f.kind === kind && block - f.block < 100)) found.push({ block, kind, detail }); };
  fireHook = (s, kind, detail, block) => add(block, kind, detail);
  try {
    for (const b of [...byBlock.keys()].sort((x, y) => x - y)) {
      st.lastBlock = b; st.fireAt = 0; st.redAt = 0;
      ingest(st, byBlock.get(b), { history: true });
      evaluate(st, b);
      if (st.why.some((w) => w.startsWith("holders sold"))) add(b, "velocity", st.why.find((w) => w.startsWith("holders sold")));
      if (st.level === "amber" && !found.some((f) => f.kind === "amber")) found.push({ block: b, kind: "amber", detail: st.why.join("; ") });
    }
  } finally { fireHook = null; }
  return { token: getAddress(t), fromBlock, toBlock, transfers: logs.length, signals: found };
}

export async function register(r, ctx) {
  store = ctx.store;
  connect();
  setInterval(() => syncArena().catch(() => {}), 15_000).unref?.();
  setInterval(() => poll().catch(() => {}), 1_500).unref?.();
  setTimeout(() => syncArena().catch(() => {}), 5_000);
  r.get("/api/watchfire/:token", async ({ params }) => {
    if (!isAddress(String(params.token || ""))) throw new HttpError(400, "That is not a token address.");
    const st = watch(params.token, "ask");
    if (st?.loading) await Promise.race([st.loading, new Promise((res) => setTimeout(res, 20_000))]);
    if (!st?.ready) return { token: getAddress(params.token), level: "loading", why: ["Reading this coin's transfers. Ask again in a few seconds."] };
    return { name: "Troya Watchfire", token: getAddress(st.token), symbol: st.symbol, level: st.level, why: st.why, metrics: st.metrics, top: st.top, lastFire: st.lastFire,
      watching: [...st.reasons], live: !!(ws && ws.readyState === 1 && subId), rules: RULES, fullHistory: !!st.fullHistory,
      note: `Watchfire reads patterns, not proof. It cannot sell ahead of a dump inside one block.${st.fullHistory ? "" : " This coin is older than 6 hours: holder figures cover the transfers of the last 6 hours only."}` };
  }, { weight: 2, perMin: 30 });
  r.get("/api/watchfire/:token/board", async ({ params }) => {
    if (!isAddress(String(params.token || ""))) throw new HttpError(400, "That is not a token address.");
    const st = watch(params.token, "ask");
    if (st?.loading) await Promise.race([st.loading, new Promise((res) => setTimeout(res, 20_000))]);
    return board(params.token) || { token: getAddress(params.token), level: "loading", trades: [], early: [], holders: [], counts: {} };
  }, { weight: 2, perMin: 60 });
  r.get("/api/watchfire", async () => ({ name: "Troya Watchfire", live: !!(ws && ws.readyState === 1 && subId),
    watching: [...W.values()].filter((s) => s.ready).map((s) => ({ token: getAddress(s.token), symbol: s.symbol, level: s.level, why: s.why.slice(0, 2), reasons: [...s.reasons] })),
    fires: fires.slice(0, 30) }), { weight: 1 });
}
