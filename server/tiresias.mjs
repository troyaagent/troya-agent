// V10 F68 Tiresias: Time Machine (community idea). See what the chain showed in the first minutes and hours of past launches
// that pumped or dumped, and how a coin compares with them, side by side with the evidence. Tiresias was the blind prophet who
// saw what others could not. Patterns from the past are context, never a promise.
// The past: every launch Troya graded 24 hours after a check. Two Fates (every Sentry check, passed and blocked, since
// 25 Nov 2026) and The Record (every Sentry post since 15 Nov 2026), Pons launches paired with ETH and checked within 6 hours
// of launch. Its outcome, plainly:
//   pumped    the price 24 hours after the check was at least double the price at the check (+100% or more)
//   dumped    it was half or less (−50% or worse), it went to zero, or it could not be sold
//   between   anything else
// What the chain showed before it: read from the chain itself, the same way for a past launch and for the coin asked about,
// over the stretch from the launch to the moment of the check (the moment the outcome is measured from, so nothing after it
// leaks in). From the coin's Transfer logs, its launch call, its curve at that block and its first buyers' nonces:
//   age at the check · ETH raised on the curve and how fast it came in · holders · the share of bought coins already sold
//   back · the top 5 buyers' share of the supply · bundle buys in the first ~12 s · what the dev wallet sold or sent away ·
//   wallets freed from the snipe tax besides the dev (Ring Radar's signal) · the share of the first 15 buyers that had never
//   sent a transaction before the launch (fresh wallets)
// The coin asked about is read at Troya's own check when there was one within 6 hours of launch, so it is compared at the
// same moment as the past launches; otherwise now if it is under 6 hours old, otherwise at the age most past launches were
// checked (its first minutes). Analogs: the 10 past launches nearest on those features (each feature scaled by its spread in
// the data, so no single one dominates). Base rates: how many pumped, dumped or neither, each with its sample size; no share
// is claimed under 5 samples. What wallets did, never who people are.
//   GET /api/tiresias              the data so far: sample sizes, what each group showed, the definitions
//   GET /api/tiresias/:token       the coin, its nearest past analogs, the base rates
// Only data/tiresias.json is written (the features read for past launches, kept for good). Read-only towards the chain.
import { getAddress, isAddress, Interface, id as keccakId } from "ethers";
import { HttpError } from "./api.mjs";

const FILE = "tiresias.json";
const H = 3600e3, DAY = 24 * H;
const MAX_AGE_MS = 6 * H;                 // a check more than 6 hours after launch is not compared
const BUNDLE_BLOCKS = 120;                // ~12 s at ~0.1 s blocks, as Ring Radar reads "the first seconds"
const FRESH_N = 15;                       // first buyers whose nonce is read
const K = 10, MIN_N = 5, KEEP = 2500;
const VER = 2;                            // how a past launch was read; an entry of another version is read again
const TICK = Math.max(5_000, Number(process.env.TIRESIAS_TICK_MS) || 20_000);
const PUMP = 100, DUMP = -50;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const SITE = "https://troya.codes";
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const CURVE = new Interface(["function realQuoteReserve() view returns (uint256)", "function graduated() view returns (bool)"]);
const ERC20 = new Interface(["function totalSupply() view returns (uint256)", "function symbol() view returns (string)"]);
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const num = (x) => (Number.isFinite(x) && x > 0 ? x : null);
const pct = (a, b) => (num(a) && num(b) ? (b / a - 1) * 100 : null);
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
let store = null, mem = null, busy = false;

/* ---------- the chain ---------- */
let R = null;
async function rh() { R ||= await import("./robinhood.mjs"); return R; }
async function rpc(method, params, opts = {}) { const r = await rh(); return r.rpc("robinhood", method, params, { timeoutMs: 15_000, ...opts }); }
async function call(to, data, block = "latest") { return rpc("eth_call", [{ to, data }, typeof block === "number" ? hex(block) : block]); }
async function header(n) { const b = await rpc("eth_getBlockByNumber", [typeof n === "number" ? hex(n) : n, false]); return { n: Number(BigInt(b.number)), t: Number(BigInt(b.timestamp)) * 1000 }; }
/** the last block at or before time t (ms), between a known block a and a later known block b */
async function blockAt(t, a, b) {
  if (t >= b.t) return b;
  if (t <= a.t) return a;
  let lo = a, hi = b;
  for (let i = 0; i < 4 && hi.n - lo.n > 2; i++) {
    const guess = Math.min(hi.n - 1, Math.max(lo.n + 1, lo.n + Math.round(((t - lo.t) / Math.max(1, hi.t - lo.t)) * (hi.n - lo.n))));
    const g = await header(guess);
    if (g.t <= t) lo = g; else hi = g;
  }
  return lo;
}

/** the facts of a Pons launch that never change (cached in the file for past launches) */
async function launchOf(token) {
  const { iface, ADDR } = await rh();
  const raw = await call(ADDR.ponsFactory, iface.ponsFactory.encodeFunctionData("getLaunchedToken", [getAddress(token)])).catch(() => null);
  let w = null; try { w = raw ? iface.ponsFactory.decodeFunctionResult("getLaunchedToken", raw)[0] : null; } catch {}
  if (!w || !w.exists) return { skip: "not a Pons launch" };
  if (lc(w.pairToken) !== ZERO) return { skip: "a Pons launch not paired with ETH" };
  const ring = await import("./ringradar.mjs");
  const l = await timeout(ring.findLaunchTx(token), 40_000).catch(() => null);
  if (!l) return { skip: "its launch transaction was not found" };
  const lh = await header(l.block);
  const lc_ = await timeout(ring.launchCall(l.tx), 30_000).catch(() => null);
  const deployer = lc(w.deployer), creator = lc(w.creatorFeeRecipient);
  const exemptOthers = lc_?.decoded ? lc_.exemptions.filter((x) => x !== deployer && x !== creator).length : null;
  const supRaw = await call(token, ERC20.encodeFunctionData("totalSupply")).catch(() => null);
  const symRaw = await call(token, ERC20.encodeFunctionData("symbol")).catch(() => null);
  let symbol = null; try { symbol = symRaw ? String(ERC20.decodeFunctionResult("symbol", symRaw)[0]).replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 16) : null; } catch {}
  return { token: lc(token), symbol, curve: lc(w.curve), deployer, creator, threshold: Number(BigInt(w.graduationThreshold)) / 1e18, supply: supRaw ? Number(BigInt(supRaw)) / 1e18 : null,
    tx: l.tx, block: l.block, at: lh.t, exemptOthers, exemptKnown: !!lc_?.decoded };
}

/** what the chain showed from the launch to time t: the features and the evidence behind them */
async function featuresAt(L, t, now) {
  const { ADDR } = await rh();
  const at = await blockAt(t, { n: L.block, t: L.at }, now);
  const logs = await rpc("eth_getLogs", [{ address: getAddress(L.token), topics: [T_TRANSFER], fromBlock: hex(L.block), toBlock: hex(at.n) }], { timeoutMs: 30_000, only: (await rh()).CHAINS.robinhood.wide });
  const V = new Set([L.curve, lc(ADDR.poolManager), lc(ADDR.universalRouter), lc(ADDR.swapRouter02), "0xe33e9e479df8802cb0866d5d05258bec4cf62948", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5"]);
  const bal = new Map(), bought = new Map(), firstBuy = new Map(), bundleTx = new Map();
  let buys = 0, sells = 0, tokIn = 0, tokOut = 0, devBought = 0, devSold = 0, devOut = 0;
  const sellers = new Set(), devTxs = [];
  for (const g of logs || []) {
    const from = "0x" + g.topics[1].slice(26), to = "0x" + g.topics[2].slice(26), amt = Number(BigInt(g.data)) / 1e18, b = Number(BigInt(g.blockNumber));
    if (from !== ZERO) bal.set(from, (bal.get(from) || 0) - amt);
    if (to !== ZERO) bal.set(to, (bal.get(to) || 0) + amt);
    const fv = V.has(from), tv = V.has(to);
    if (fv && !tv && to !== ZERO && to !== lc(L.token)) {
      buys++; tokIn += amt; bought.set(to, (bought.get(to) || 0) + amt);
      if (!firstBuy.has(to)) firstBuy.set(to, b);
      if (to === L.deployer) devBought += amt;
      if (b <= L.block + BUNDLE_BLOCKS) { const e = bundleTx.get(g.transactionHash) || { to: new Set(), amt: 0 }; e.to.add(to); e.amt += amt; bundleTx.set(g.transactionHash, e); }
    } else if (!fv && tv && from !== ZERO) {
      sells++; tokOut += amt; sellers.add(from);
      if (from === L.deployer) { devSold += amt; if (devTxs.length < 3) devTxs.push({ tx: g.transactionHash, kind: "sold" }); }
    } else if (from === L.deployer && !tv && to !== ZERO) { devOut += amt; if (devTxs.length < 3) devTxs.push({ tx: g.transactionHash, kind: "sent away" }); }
  }
  const sup = L.supply || 1e9;
  const holders = [...bal].filter(([a, v]) => v > 1e-9 && !V.has(a) && a !== ZERO && a !== lc(L.token)).length;
  const top = [...bought].sort((a, b) => b[1] - a[1]);
  const top5 = top.slice(0, 5).reduce((s, [, v]) => s + v, 0);
  const bundles = [...bundleTx].filter(([, e]) => e.to.size >= 3);
  const bundleAmt = bundles.reduce((s, [, e]) => s + e.amt, 0);
  // the curve at that block
  const { iface, ADDR: AD } = await rh();
  const mc = await call(AD.multicall3, iface.mc.encodeFunctionData("aggregate3", [[{ target: getAddress(L.curve), allowFailure: true, callData: CURVE.encodeFunctionData("realQuoteReserve") }, { target: getAddress(L.curve), allowFailure: true, callData: CURVE.encodeFunctionData("graduated") }]]), at.n).catch(() => null);
  let raised = null, graduated = null;
  try {
    const [res] = iface.mc.decodeFunctionResult("aggregate3", mc);
    if (res[1].success) graduated = !!CURVE.decodeFunctionResult("graduated", res[1].returnData)[0];
    if (res[0].success) raised = Number(BigInt(CURVE.decodeFunctionResult("realQuoteReserve", res[0].returnData)[0])) / 1e18;
  } catch {}
  if (graduated) raised = L.threshold || raised;
  // fresh wallets: the first buyers (not the dev) that had never sent a transaction before the launch block
  const first = [...firstBuy].filter(([a]) => a !== L.deployer && a !== L.creator).sort((a, b) => a[1] - b[1]).slice(0, FRESH_N).map(([a]) => a);
  let fresh = 0, read = 0;
  for (let i = 0; i < first.length; i += 5) {
    await Promise.all(first.slice(i, i + 5).map(async (w) => {
      const n = await rpc("eth_getTransactionCount", [getAddress(w), hex(L.block - 1)], { timeoutMs: 10_000 }).catch(() => null);   // the nonce before the launch block
      if (n == null) return;
      read++; if (Number(BigInt(n)) === 0) fresh++;
    }));
  }
  const ageMin = Math.max(0, (at.t - L.at) / 60_000);
  const f = {
    ageMin: +ageMin.toFixed(2), raisedEth: raised, fillEthPerMin: raised != null && ageMin > 0 ? raised / ageMin : null,
    progressPct: raised != null && L.threshold ? Math.min(100, (raised / L.threshold) * 100) : null, graduated,
    holders, buyers: bought.size, buys, sells, sellers: sellers.size, sellShare: tokIn > 0 ? Math.min(1, tokOut / tokIn) : null,
    top5Pct: (top5 / sup) * 100, bundlePct: (bundleAmt / sup) * 100, devBoughtPct: (devBought / sup) * 100, devSoldPct: (devSold / sup) * 100, devOutPct: (devOut / sup) * 100,
    exemptOthers: L.exemptOthers, freshShare: read ? fresh / read : null, freshRead: read,
  };
  const evidence = { launchTx: L.tx, launchBlock: L.block, launchAt: L.at, block: at.n, at: at.t, transfers: (logs || []).length,
    bundles: bundles.slice(0, 3).map(([tx, e]) => ({ tx, wallets: e.to.size, pctOfSupply: (e.amt / sup) * 100 })), dev: L.deployer, devTxs,
    topBuyers: top.slice(0, 5).map(([w, v]) => ({ wallet: w, pctOfSupply: (v / sup) * 100 })), freshOf: first.length };
  return { f, evidence };
}

/* ---------- the past: graded launches, their features, their outcome ---------- */
async function state() { mem ||= await store.readJson(FILE, { past: {}, skip: {}, since: Date.now() }); return mem; }
function outcomeOf(x) {
  // x: { result?, p0, p24h, notSellable?, peak? }
  const ch = x.result === "not-sellable" || (x.result === "zero" && !num(x.p24h)) ? -100 : pct(x.p0, x.p24h);
  if (ch == null) return null;
  const kind = ch >= PUMP ? "pumped" : ch <= DUMP || x.result === "zero" || x.result === "not-sellable" ? "dumped" : "between";
  return { kind, change24h: ch, peakX: num(x.peak) && num(x.p0) ? x.peak / x.p0 : null, result: x.result || null };
}
let candMemo = { at: 0, list: null };
async function candidates() {
  if (candMemo.list && Date.now() - candMemo.at < 2 * 60_000) return candMemo.list;
  candMemo = { at: Date.now(), list: await readCandidates() };
  return candMemo.list;
}
async function readCandidates() {
  const [fates, record] = await Promise.all([store.readJson("fates.json", { coins: {} }), store.readJson("record.json", { calls: {} })]);
  const out = new Map();
  for (const c of Object.values(record.calls || {})) {
    if (c.status !== "graded" || c.kind === "born" || c.kind === "stock" || c.source === "x" || !num(c.p0) || !c.token) continue;
    const o = outcomeOf({ p0: c.p0, p24h: c.p24h, peak: c.peak });
    if (o) out.set(lc(c.token), { token: lc(c.token), symbol: c.symbol || null, at: c.at, from: "The Record (Sentry posted it)", post: c.post || null, outcome: o });
  }
  for (const c of Object.values(fates.coins || {})) {
    if (c.status !== "graded" || !c.token) continue;
    const o = outcomeOf(c);
    if (o) out.set(lc(c.token), { token: lc(c.token), symbol: c.symbol || null, at: c.at, from: `Two Fates (${c.cohort === "blocked" ? "blocked" : "passed"} by the Gate)`, cohort: c.cohort, post: out.get(lc(c.token))?.post || null, outcome: { ...o, peakX: out.get(lc(c.token))?.outcome?.peakX ?? null } });
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}
export async function backfillOne() {
  if (busy) return null;
  busy = true;
  try {
    const d = await state();
    const list = await candidates();
    const next = list.find((c) => d.past[c.token]?.v !== VER && !(d.skip[c.token]?.final));
    if (!next) return null;
    const res = await readPast(next).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
    if (res.skip) d.skip[next.token] = { why: res.skip, final: true, at: Date.now() };
    else if (res.error) { const s = d.skip[next.token] || { tries: 0 }; s.tries = (s.tries || 0) + 1; s.why = res.error; s.final = s.tries >= 3; s.at = Date.now(); d.skip[next.token] = s; }
    else d.past[next.token] = res;
    const keys = Object.keys(d.past);
    if (keys.length > KEEP) d.past = Object.fromEntries(Object.entries(d.past).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP));
    dirty++;
    if (dirty >= 10 || Date.now() - lastSave > 2 * 60_000) await flush();
    return { token: next.token, ...res };
  } finally { busy = false; }
}
let dirty = 0, lastSave = 0;
export async function flush() { if (!mem || !dirty) return; dirty = 0; lastSave = Date.now(); await store.writeJson(FILE, mem); }
async function readPast(c) {
  const L = await launchOf(c.token);
  if (L.skip) return L;
  if (c.at - L.at > MAX_AGE_MS) return { skip: "checked more than 6 hours after its launch" };
  if (c.at < L.at + 20_000) return { skip: "the check time is not after its first 20 seconds" };
  const now = await header("latest");
  const { f, evidence } = await featuresAt(L, c.at, now);
  return { v: VER, token: c.token, symbol: c.symbol || L.symbol, at: c.at, from: c.from, cohort: c.cohort || null, post: c.post, outcome: c.outcome, f, evidence, readAt: Date.now() };
}

/* ---------- comparing ---------- */
// the features the distance uses, and how each is put on a comparable scale before dividing by its spread
export const DIST = [
  ["ageMin", (x) => Math.log1p(x)], ["raisedEth", (x) => Math.log1p(10 * x)], ["fillEthPerMin", (x) => Math.log1p(100 * x)], ["holders", (x) => Math.log1p(x)],
  ["sellShare", (x) => x], ["top5Pct", (x) => x], ["bundlePct", (x) => x], ["devSoldPct", (x) => x], ["freshShare", (x) => x], ["exemptOthers", (x) => Math.log1p(x)],
];
export const LABELS = {
  ageMin: "Minutes since launch", raisedEth: "ETH raised on the curve", fillEthPerMin: "ETH raised per minute", progressPct: "Curve filled (%)", holders: "Holders",
  buyers: "Wallets that bought", sellShare: "Share of bought coins already sold back", top5Pct: "Top 5 buyers' share of the supply (%)", bundlePct: "Bundle buys in the first ~12 s (% of supply)",
  devSoldPct: "Dev wallet sold (% of supply)", devOutPct: "Dev wallet sent to other wallets (% of supply)", exemptOthers: "Wallets freed from the snipe tax besides the dev", freshShare: "Fresh wallets among the first 15 buyers",
};
function quantile(s, q) { if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
export function median(xs) { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return quantile(s, 0.5); }
export function scales(rows) {
  const out = {};
  for (const [k, tr] of DIST) {
    const v = rows.map((r) => r.f?.[k]).filter((x) => x != null && isFinite(x)).map(tr).sort((a, b) => a - b);
    let s = v.length >= 4 ? quantile(v, 0.75) - quantile(v, 0.25) : 0;
    if (!(s > 1e-9) && v.length) { const m = v.reduce((a, b) => a + b, 0) / v.length; s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); }
    out[k] = s > 1e-9 ? s : 1;
  }
  return out;
}
export function distance(a, b, sc) {
  let s = 0, n = 0;
  for (const [k, tr] of DIST) {
    const x = a?.[k], y = b?.[k];
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
    s += ((tr(x) - tr(y)) / sc[k]) ** 2; n++;
  }
  return n >= 5 ? Math.sqrt(s / n) : null;
}
const GROUPS = ["pumped", "dumped", "between"];
const GROUP_TEXT = { pumped: "Doubled or more 24 hours after the check", dumped: "Halved or worse, went to zero or could not be sold, within 24 hours", between: "In between" };
function groupsOf(rows) {
  const out = {};
  for (const g of GROUPS) {
    const xs = rows.filter((r) => r.outcome.kind === g);
    out[g] = { label: GROUP_TEXT[g], n: xs.length,
      medians: xs.length >= MIN_N ? Object.fromEntries(Object.keys(LABELS).map((k) => [k, median(xs.map((r) => r.f?.[k]))])) : null,
      why: xs.length < MIN_N ? `${xs.length} launch${xs.length === 1 ? "" : "es"} so far: at least ${MIN_N} are needed to describe this group` : null };
  }
  return out;
}
function rate(rows) {
  const n = rows.length;
  const c = Object.fromEntries(GROUPS.map((g) => [g, rows.filter((r) => r.outcome.kind === g).length]));
  return { n, ...c, shares: n >= MIN_N ? Object.fromEntries(GROUPS.map((g) => [g, c[g] / n])) : null, claim: n >= MIN_N };
}
const pastView = (r, d) => ({ token: getAddress(r.token), symbol: r.symbol, at: r.at, from: r.from, cohort: r.cohort, distance: d ?? null, outcome: r.outcome, f: r.f,
  evidence: { ...r.evidence, launchUrl: `${EXPLORER}/tx/${r.evidence.launchTx}`, blockUrl: `${EXPLORER}/block/${r.evidence.block}`, post: r.post || null, gate: `${SITE}/agent#/gate/${getAddress(r.token)}` } });

async function dataset() {
  const d = await state();
  return Object.values(d.past).filter((r) => r.f && r.outcome && r.v === VER);
}
const DEFS = {
  pumped: "The price 24 hours after Troya's check was at least double the price at the check (+100% or more).",
  dumped: "The price 24 hours after the check was half or less (−50% or worse), or the coin went to zero, or it could not be sold.",
  between: "Anything else.",
  window: "Every feature is read from the chain over the stretch from the launch to the moment of the check, so nothing that happened after the check leaks in.",
  analogs: `The ${K} past launches nearest on the features (each scaled by its spread across all past launches; at least 5 features must be known on both sides).`,
  claim: `No share is given for fewer than ${MIN_N} launches.`,
};
const NOT_STORED = "Not compared, because Troya did not store them for past launches and they cannot be read back cheaply: social links and X activity, holder counts from outside the coin's own Transfer logs, and the wallets' funding trails (Cluster map reads those for one coin at a time). Only Pons launches paired with ETH and checked within 6 hours of launch are in the data.";
const NOTE = "Patterns from the past are context, never a promise. Tiresias shows what the chain showed before past launches moved and how this coin compares; it does not forecast a price or say what to buy or sell.";

export async function summary() {
  const rows = await dataset();
  const d = await state();
  const cand = await candidates();
  const pending = cand.filter((c) => d.past[c.token]?.v !== VER && !d.skip[c.token]?.final).length;
  const skipped = {};
  for (const s of Object.values(d.skip)) if (s.final) skipped[s.why] = (skipped[s.why] || 0) + 1;
  const ats = rows.map((r) => r.at);
  return { n: rows.length, from: ats.length ? Math.min(...ats) : null, to: ats.length ? Math.max(...ats) : null, pending, skipped, groups: groupsOf(rows), baseRate: rate(rows),
    medianCheckAgeMin: median(rows.map((r) => r.f.ageMin)), labels: LABELS, definitions: DEFS, notStored: NOT_STORED, note: NOTE };
}

/* ---------- one coin ---------- */
async function checkTimeOf(token) {
  const [fates, sentry, record, phoenix] = await Promise.all([store.readJson("fates.json", { coins: {} }), store.readJson("sentry.json", {}), store.readJson("record.json", { calls: {} }), store.readJson("phoenix.json", {})]);
  const k = lc(token), xs = [];
  const fc = fates.coins?.[k]; if (fc?.at) xs.push({ at: fc.at, source: "Two Fates (Sentry's check)", verdict: fc.cohort });
  for (const x of sentry.recent || []) if (lc(x.token) === k && x.at) xs.push({ at: x.at, source: "Sentry's check", verdict: x.verdict });
  const rc = record.calls?.[k]; if (rc?.at && rc.kind !== "born" && rc.kind !== "stock") xs.push({ at: rc.at, source: "Sentry's post (The Record)", verdict: "passed" });
  const ps = phoenix.setups?.[k]; if (ps?.at) xs.push({ at: ps.at, source: "Sentry's check (Phoenix setup)", verdict: ps.verdict });
  xs.sort((a, b) => a.at - b.at);
  return xs[0] || null;
}
async function compute(token) {
  const t = lc(token);
  const L = await launchOf(t);
  if (L.skip) return { token: getAddress(t), status: "unsupported", sentence: `Tiresias reads Pons launches paired with ETH only, and this coin is ${L.skip === "not a Pons launch" ? "not a Pons launch" : L.skip === "a Pons launch not paired with ETH" ? "a Pons launch paired with another coin" : `one whose launch could not be read (${L.skip})`}.`, note: NOTE };
  const now = await header("latest");
  const rows = (await dataset()).filter((r) => r.token !== t);
  const chk = await checkTimeOf(t);
  const medAge = median(rows.map((r) => r.f.ageMin)) ?? 6;
  let moment;
  if (chk && chk.at >= L.at && chk.at - L.at <= MAX_AGE_MS) moment = { at: chk.at, kind: "check", text: `at Troya's check (${chk.source}), the same moment the past launches were measured from` };
  else if (now.t - L.at <= MAX_AGE_MS) moment = { at: now.t, kind: "now", text: "now (it launched under 6 hours ago)" };
  else moment = { at: L.at + medAge * 60_000, kind: "first-minutes", text: `in its first ${Math.round(medAge)} minutes, the age most past launches were checked at (it launched ${((now.t - L.at) / DAY).toFixed(1)} days ago, so its later days are not compared)` };
  const { f, evidence } = await featuresAt(L, moment.at, now);
  const sc = scales(rows);
  const near = rows.map((r) => ({ r, d: distance(f, r.f, sc) })).filter((x) => x.d != null).sort((a, b) => a.d - b.d).slice(0, K);
  const own = (await state()).past[t] || null;
  const an = rate(near.map((x) => x.r));
  const sentence = !rows.length ? "No past launches have been read yet, so there is nothing to compare with."
    : !near.length ? "Too few features could be read for this coin to compare it."
    : an.claim ? `Of the ${near.length} past launches nearest to this one, ${an.pumped} doubled or more within 24 hours of the check, ${an.dumped} halved or worse and ${an.between} landed in between. Across all ${rows.length} past launches: ${rate(rows).pumped} doubled, ${rate(rows).dumped} halved or worse.`
    : `Only ${near.length} past launches are near enough to compare: at least ${MIN_N} are needed to give a share.`;
  // distances are in spreads: under 0.5 the launches looked much alike on most features; over 1 they did not
  const medD = median(near.map((x) => x.d));
  const closeness = medD == null ? null : medD <= 0.5 ? "close" : medD <= 1 ? "fair" : "loose";
  const sentence2 = closeness === "loose" ? `${sentence} None of them looked much like this coin (median distance ${medD.toFixed(2)}), so read them loosely.` : sentence;
  return {
    token: getAddress(t), symbol: L.symbol, status: "done", moment: { ...moment, ageMin: f.ageMin, block: evidence.block }, sentence: sentence2, closeness, medianDistance: medD,
    features: f, evidence: { ...evidence, launchUrl: `${EXPLORER}/tx/${L.tx}`, blockUrl: `${EXPLORER}/block/${evidence.block}`, gate: `${SITE}/agent#/gate/${getAddress(t)}` },
    check: chk, ownOutcome: own?.outcome || null,
    analogs: near.map((x) => pastView(x.r, x.d)),
    baseRate: { analogs: an, all: rate(rows) }, groups: groupsOf(rows),
    dataset: { n: rows.length, from: rows.length ? Math.min(...rows.map((r) => r.at)) : null },
    labels: LABELS, definitions: DEFS, notStored: NOT_STORED, note: NOTE, checkedAt: Date.now(),
  };
}

const memo = new Map(), inflight = new Map();
let running = 0;
const queue = [];
async function slot(fn) { if (running >= 2) await new Promise((r) => queue.push(r)); running++; try { return await fn(); } finally { running--; queue.shift()?.(); } }
export async function tiresias(token, { waitMs = 25_000 } = {}) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "Paste a coin's contract address on Robinhood Chain (0x + 40 hex).");
  const k = lc(token);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) {
    const p = slot(() => compute(k)).then((res) => { memo.set(k, { at: Date.now(), ttl: 10 * 60_000, res }); if (memo.size > 500) memo.delete(memo.keys().next().value); return res; },
      (e) => { console.warn("[tiresias]", k, e?.message || e); const res = { token: getAddress(k), status: "error", sentence: `This coin could not be read just now (${String(e.message || e).slice(0, 120)}). Try again in a minute.` }; memo.set(k, { at: Date.now(), ttl: 60_000, res }); return res; })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  const r = await Promise.race([inflight.get(k), sleep(waitMs).then(() => null)]);
  return r || { token: getAddress(k), status: "reading", sentence: "Reading this coin's launch, its first buyers and its curve from the chain. This takes up to a minute." };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/tiresias", () => summary(), { weight: 1, perMin: 60 });
  r.get("/api/tiresias/:token", ({ params }) => tiresias(params.token), { weight: 2, perMin: 20 });
  if (process.env.TIRESIAS_BACKFILL === "0") return;
  setInterval(() => backfillOne().catch((e) => console.warn("[tiresias] backfill", e.message)), TICK).unref?.();
}
