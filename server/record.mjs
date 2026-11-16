// F13 · The Oracle's ledger: every coin Sentry posts is graded in public.
// When Sentry posts a coin, its price is recorded at once (Pons curve price read on chain while it is on the curve,
// the pool price after). It is sampled every 5 minutes for a day, keeping the peak and the low, and graded at 1 hour
// and 24 hours. Calls posted before the ledger existed (or noticed late) are back-filled from GeckoTerminal candles
// and say so. Nothing here is a forecast or advice: it is what the price did after the call.
//   GET /api/record → { stats, calls, rules, updatedAt }
import { getRobinhoodToken, getRobinhoodCandles, getEthUsd } from "./market.mjs";

const FILE = "record.json";
const SENTRY = "sentry.json";
const H = 3600e3, DAY = 24 * H, TICK = 5 * 60e3;
const LIVE_LAG = 3 * 60e3;           // noticed more than 3 min after the post → the price at the call comes from candles
const KEEP = 1000;
let store, timer, busy = false;

const lc = (s) => String(s || "").toLowerCase();
const num = (x) => (Number.isFinite(x) && x > 0 ? x : null);

/* ---------- price now ---------- */
async function priceNow(token) {
  const r = await getRobinhoodToken(token);
  const p = r?.pons;
  if (p && !p.graduated && p.priceInPair > 0 && p.pair?.address === "native") {
    const eu = Number(await getEthUsd()) || 0;
    if (eu) return { usd: p.priceInPair * eu, src: "pons-curve" };
  }
  const usd = num(Number(r?.token?.priceUsd));
  return usd ? { usd, src: "pool" } : null;
}

/* ---------- back-fill from candles ---------- */
const STEP = { "5m": 300, "15m": 900, "1h": 3600 };
async function fromCandles(c) {
  const age = Date.now() - c.at;
  const iv = age < 24 * H ? "5m" : age < 72 * H ? "15m" : "1h";
  const { candles } = await getRobinhoodCandles(c.token, iv, { bg: true });
  if (!candles?.length) return false;
  const step = STEP[iv], t0 = Math.floor(c.at / 1000);
  const at = (t) => candles.find((k) => k.time <= t && t < k.time + step);
  const k0 = at(t0);
  if (!k0) return false;
  // the candle the call fell in: its open if the call came early in it, its close if late
  c.p0 = num(t0 - k0.time < step / 2 ? k0.open : k0.close);
  if (!c.p0) return false;
  const win = candles.filter((k) => k.time + step > t0 && k.time <= t0 + 86400);
  c.peak = Math.max(c.p0, ...win.map((k) => k.high).filter(num));
  c.low = Math.min(c.p0, ...win.map((k) => k.low).filter(num));
  const k1 = at(t0 + 3600), k24 = at(t0 + 86400);
  if (k1 && age >= H) c.p1h = num(k1.close);
  if (k24 && age >= DAY) c.p24h = num(k24.close);
  c.via = `candles-${iv}`;
  if (!c.symbol) c.symbol = (await getRobinhoodToken(c.token).catch(() => null))?.token?.symbol || null;
  c.last = Date.now();
  if (c.p24h) c.status = "graded";
  else if (age >= DAY + 2 * H) c.status = "no-data";
  return true;
}

/* ---------- live sampling ---------- */
async function sample(c) {
  const now = Date.now(), age = now - c.at;
  const p = await priceNow(c.token).catch(() => null);
  c.last = now;
  if (!p) { c.misses = (c.misses || 0) + 1; if (age >= DAY) c.status = c.p0 ? "no-price" : "no-data"; return; }
  if (!c.p0) { c.p0 = p.usd; c.src = p.src; }
  c.now = p.usd;
  c.peak = Math.max(c.peak || 0, p.usd); c.low = Math.min(c.low || Infinity, p.usd);
  if (!c.p1h && age >= H) c.p1h = p.usd;
  if (!c.p24h && age >= DAY) { c.p24h = p.usd; c.status = "graded"; if (age > DAY + 30 * 60e3) c.late = true; }   // late: the server was down at the 24 h mark
}

/* ---------- sync with Sentry's posts ---------- */
// one copy in memory, shared by the live loop and the back-fill loop, written to disk after each pass
let mem = null;
async function state() { mem ||= await store.readJson(FILE, { calls: {} }); return mem; }
async function save() { if (mem) await store.writeJson(FILE, trim(mem)); }
function trim(d) {
  const all = Object.values(d.calls).sort((a, b) => b.at - a.at);
  if (all.length > KEEP) d.calls = Object.fromEntries(all.slice(0, KEEP).map((c) => [c.token, c]));
  return d;
}
export async function noteCall({ token, symbol, at = Date.now(), post = null, source = null }) {
  if (!store || !token) return;
  const d = await state();
  const k = lc(token);
  if (d.calls[k]) return;
  const c = { token: k, symbol: symbol || null, at, post, source, status: "watching", via: Date.now() - at < LIVE_LAG ? "live" : "pending-candles" };
  d.calls[k] = c;
  if (c.via === "live") await sample(c).catch(() => {});
  await save();
}

// live loop: picks up new Sentry posts and samples every call still inside its first day
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await state();
    const s = await store.readJson(SENTRY, {});
    const now = Date.now();
    const add = (tok, at, extra = {}) => {
      const k = lc(tok);
      if (!tok || !at || d.calls[k]) return;
      d.calls[k] = { token: k, symbol: null, at, post: null, source: null, status: "watching", via: now - at > LIVE_LAG ? "pending-candles" : "live", ...extra };
    };
    for (const r of s.recent || []) if (r.posted) add(r.token, r.at || now, { symbol: r.symbol || null, post: r.post || null, source: r.source || null });
    // older posts Sentry still remembers (token → time posted), beyond the last 200 results it keeps in full
    for (const [tok, at] of Object.entries(s.posted || {})) add(tok, Number(at));
    for (const c of Object.values(d.calls)) {
      if (c.status !== "watching" || c.via === "pending-candles" || !c.p0 && now - c.at > LIVE_LAG) continue;
      if (now - (c.last || 0) >= TICK - 5000) await sample(c).catch(() => {});
    }
    await save();
  } catch (e) {
    console.warn("[record]", e.message);
  } finally { busy = false; }
}

// back-fill loop: one call at a time from GeckoTerminal candles (slow and rate-limited, so it never holds up the live loop)
let filling = false;
async function backfill() {
  if (filling) return;
  filling = true;
  try {
    const d = await state();
    const now = Date.now();
    const c = Object.values(d.calls).filter((x) => x.status === "watching" && (x.via === "pending-candles" || (!x.p0 && now - x.at > LIVE_LAG)))
      .sort((a, b) => (a.tries || 0) - (b.tries || 0) || b.at - a.at)[0];
    if (!c) return;
    const ok = await fromCandles(c).catch(() => false);
    if (!ok) { c.tries = (c.tries || 0) + 1; if (c.tries >= 6) c.status = "no-data"; }
    // once the price at the call is known, a call still inside its first day keeps going live
    if (ok && c.status === "watching" && now - c.at < DAY) c.via = "candles+live";
    await save();
  } catch (e) {
    console.warn("[record] backfill:", e.message);
  } finally { filling = false; }
}

/* ---------- the public view ---------- */
const pct = (a, b) => (num(a) && num(b) ? (b / a - 1) * 100 : null);
function view(c) {
  return {
    token: c.token, symbol: c.symbol, at: c.at, post: c.post, source: c.source, status: c.status, via: c.via,
    priceAtCall: c.p0 ?? null, change1h: pct(c.p0, c.p1h), change24h: pct(c.p0, c.p24h), changeNow: c.status === "watching" ? pct(c.p0, c.now) : null,
    peakX: num(c.p0) && num(c.peak) ? c.peak / c.p0 : null, lowPct: pct(c.p0, c.low),
    result: c.status !== "graded" ? null : c.p24h > c.p0 ? "win" : "miss", late: !!c.late,
  };
}
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export async function recordView({ limit = 100 } = {}) {
  const d = await state();
  const calls = Object.values(d.calls).sort((a, b) => b.at - a.at).map(view);
  const graded = calls.filter((c) => c.result);
  const r24 = graded.map((c) => c.change24h).filter((x) => x != null);
  const peaks = calls.filter((c) => c.peakX != null && (c.status === "graded" || Date.now() - c.at >= DAY)).map((c) => c.peakX);
  const stats = {
    calls: calls.length, watching: calls.filter((c) => c.status === "watching").length, graded: graded.length,
    wins: graded.filter((c) => c.result === "win").length,
    winRate: graded.length ? graded.filter((c) => c.result === "win").length / graded.length : null,
    median24h: median(r24), medianPeakX: median(peaks),
    reached2x: peaks.filter((x) => x >= 2).length, reachedOf: peaks.length,
    best: graded.length ? graded.reduce((a, b) => (b.peakX > a.peakX ? b : a)) : null,
    worst: graded.length ? graded.reduce((a, b) => (b.change24h < a.change24h ? b : a)) : null,
  };
  return {
    stats, calls: calls.slice(0, Math.min(500, Math.max(1, Number(limit) || 100))), updatedAt: Date.now(),
    rules: "A call is the moment Troya Sentry posts a coin. Its price is recorded then (Pons curve price read on chain while the coin is on the curve, the pool price after), sampled every 5 minutes for a day, and graded 24 hours later: a win if the price is higher than at the call, a miss if not. Peak is the highest price seen in that day. Calls noticed late are filled from GeckoTerminal candles and marked. Past calls do not predict future ones; this is a record, not advice.",
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/record", ({ query }) => recordView({ limit: query.limit }), { weight: 1 });
  if (process.env.RECORD === "0") return;
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 60_000);
  setInterval(() => backfill().catch(() => {}), 8_000);
  setTimeout(() => tick().catch(() => {}), 15_000);
}
