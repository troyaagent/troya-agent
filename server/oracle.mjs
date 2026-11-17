// F21 · The chart oracle: Troya writes a chart note, and the chart grades it in public 24 hours later.
// Every 6 hours Troya reads hourly candles for ETH, BTC, $TROYA and the top Troya picks on Robinhood Chain and writes
// one note per coin: a lean (up, down or sideways for the next 24 hours), support and resistance from the last two
// days, and why, from rules anyone can check: the 20- and 50-hour averages, RSI, volume against the day before and
// where the price sits in its range. 24 hours later the note is graded against the price then:
//   up wins at +0.5% or more · down wins at -0.5% or less · sideways wins if the move stays inside ±3%.
// Nothing is deleted. It is a read of the chart, never advice.
//   GET /api/oracle?limit=  → { stats, notes, rules, updatedAt }
//   GET /api/oracle/coin/:id → the latest note for one coin (address, or ETH / BTC)
import { getHlCandles, getRobinhoodCandles, getRobinhoodToken, getRobinhoodTokens } from "./market.mjs";

const FILE = "oracle.json";
const H = 3600e3, EVERY = 6 * H, HORIZON = 24 * H;
const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
let store = null, busy = false, mem = null;
const lc = (s) => String(s || "").toLowerCase();

/* ---------- indicators ---------- */
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; };
function rsi(v, n = 14) {
  if (v.length <= n) return null;
  let g = 0, l = 0;
  for (let i = v.length - n; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  if (!l) return 100;
  return 100 - 100 / (1 + g / l);
}
const fmt = (p) => "$" + (p >= 100 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) : p >= 1 ? p.toFixed(2) : p.toPrecision(3));

// GeckoTerminal leaves out hours with no trades: carry the last close through them (volume 0) so every hour counts
function hourly(candles) {
  const src = candles.filter((k) => k.close > 0).sort((x, y) => x.time - y.time), out = [];
  for (const k of src) {
    const prev = out[out.length - 1];
    if (prev) for (let t = prev.time + 3600; t < k.time && out.length < 2000; t += 3600) out.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
    out.push(k);
  }
  const last = out[out.length - 1], nowH = Math.floor(Date.now() / 3600e3) * 3600;
  if (last) for (let t = last.time + 3600; t <= nowH && out.length < 2000; t += 3600) out.push({ time: t, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 });
  return out.slice(-200);
}
function read(candles) {
  const c = hourly(candles);
  if (c.length < 24) return null;   // a day of hours at least
  const close = c.map((k) => k.close), px = close[close.length - 1];
  const e20 = ema(close.slice(-60), 20), e50 = ema(close.slice(-100), 50), r = rsi(close);
  const last48 = c.slice(-48), support = Math.min(...last48.map((k) => k.low || k.close)), resistance = Math.max(...last48.map((k) => k.high || k.close));
  const v = c.map((k) => k.volume || 0), vNow = v.slice(-12).reduce((s, x) => s + x, 0), vPrev = v.slice(-36, -12).reduce((s, x) => s + x, 0) / 2;
  const volUp = vPrev > 0 ? vNow / vPrev : null;
  const range = resistance - support, pos = range > 0 ? (px - support) / range : 0.5;
  // the lean: trend from the averages, momentum from RSI, confirmation from volume and range position
  let score = 0;
  score += px > e20 ? 1 : -1;
  score += e20 > e50 ? 1 : -1;
  if (r != null) score += r > 55 && r < 72 ? 1 : r < 45 && r > 28 ? -1 : 0;
  if (r != null && r >= 72) score -= 1;            // stretched: room to cool off
  if (r != null && r <= 28) score += 1;            // washed out: room to bounce
  if (volUp != null && volUp > 1.3) score += px > e20 ? 0.5 : -0.5;
  const spread = range / px;
  const call = score >= 2 ? "up" : score <= -2 ? "down" : "sideways";
  const why = [];
  why.push(`${px > e20 ? "above" : "below"} its 20-hour average${e20 > e50 ? ", which is above the 50-hour" : ", which is below the 50-hour"}`);
  if (r != null) why.push(`RSI ${Math.round(r)}${r >= 72 ? " (stretched)" : r <= 28 ? " (washed out)" : ""}`);
  if (volUp != null) why.push(`volume ${volUp >= 1.3 ? "rising" : volUp <= 0.7 ? "fading" : "steady"} against the day before`);
  why.push(`${pos > 0.8 ? "near the top" : pos < 0.2 ? "near the bottom" : "mid"} of its two-day range`);
  const target = call === "up" ? resistance : call === "down" ? support : null;
  const text = call === "up" ? `Leaning up toward ${fmt(resistance)}, support at ${fmt(support)}.`
    : call === "down" ? `Leaning down toward ${fmt(support)}, resistance at ${fmt(resistance)}.`
    : `Sideways between ${fmt(support)} and ${fmt(resistance)} more likely than a break.`;
  return { price: px, call, conf: Math.min(1, Math.abs(score) / 4), support, resistance, target, text, why, rsi: r != null ? +r.toFixed(1) : null, spreadPct: +(spread * 100).toFixed(1) };
}

/* ---------- subjects ---------- */
async function subjects() {
  const list = [{ id: "ETH", symbol: "ETH", kind: "hl" }, { id: "BTC", symbol: "BTC", kind: "hl" }, { id: TROYA, symbol: "TROYA", kind: "rh" }];
  try {
    const p = await getRobinhoodTokens({ cat: "picks", sort: "picks", limit: 8 });
    for (const t of p.tokens || []) if (list.length < 8 && !list.some((x) => x.id === lc(t.address))) list.push({ id: lc(t.address), symbol: t.symbol, kind: "rh" });
  } catch {}
  return list;
}
async function candlesOf(s) {
  if (s.kind === "hl") return (await getHlCandles(s.id, "1h", 168)).candles || [];
  return (await getRobinhoodCandles(s.id, "1h", { bg: true })).candles || [];
}
async function priceOf(s) {
  if (s.kind === "hl") { const c = (await getHlCandles(s.id, "1h", 3)).candles || []; return c.length ? c[c.length - 1].close : null; }
  const r = await getRobinhoodToken(s.id).catch(() => null);
  const p = Number(r?.token?.priceUsd);
  return p > 0 ? p : null;
}

/* ---------- write, grade ---------- */
async function state() { mem ||= await store.readJson(FILE, { notes: [] }); return mem; }
async function save() { if (mem) { mem.notes = mem.notes.slice(-1500); await store.writeJson(FILE, mem); } }
async function write() {
  const s = await state(), now = Date.now();
  for (const sub of await subjects()) {
    const last = s.notes.filter((n) => n.id === sub.id).pop();
    if (last && now - last.at < EVERY - 5 * 60e3) continue;
    try {
      const r = read(await candlesOf(sub));
      if (!r) continue;
      s.notes.push({ ...sub, at: now, ...r, status: "open" });
      await save();
      // F24: a lean on a Robinhood Chain coin is also filed in the agent registry, signed and graded there
      if (sub.kind === "rh" && (r.call === "up" || r.call === "down") && process.env.ORACLE_REGISTRY !== "0") {
        import("./registry.mjs").then((m) => m.houseCall({ slug: "troya-chart-oracle", name: "Troya Chart Oracle", bio: "Troya's chart notes: 20/50-hour averages, RSI, volume and the two-day range", token: sub.id, side: r.call, horizonHours: 24, note: r.text }))
          .catch((e) => console.warn("[oracle] registry", e.message));
      }
    } catch (e) { console.warn("[oracle]", sub.symbol, e.message); }
  }
}
async function grade() {
  const s = await state(), now = Date.now();
  let changed = false;
  for (const n of s.notes) {
    if (n.status !== "open" || now - n.at < HORIZON) continue;
    try {
      const p = await priceOf(n);
      if (!p) { if (now - n.at > HORIZON + 6 * H) { n.status = "no-price"; changed = true; } continue; }
      const move = (p / n.price - 1) * 100;
      n.priceAfter = p; n.move = +move.toFixed(2); n.gradedAt = now; n.status = "graded";
      n.result = n.call === "up" ? (move >= 0.5 ? "win" : "miss") : n.call === "down" ? (move <= -0.5 ? "win" : "miss") : (Math.abs(move) < 3 ? "win" : "miss");
      changed = true;
    } catch {}
  }
  if (changed) await save();
}
async function tick() {
  if (busy) return; busy = true;
  try { await grade(); await write(); } catch (e) { console.warn("[oracle]", e.message); } finally { busy = false; }
}

export async function oracleView({ limit = 60 } = {}) {
  const s = await state();
  const graded = s.notes.filter((n) => n.status === "graded");
  const by = (c) => { const g = graded.filter((n) => n.call === c); return { graded: g.length, wins: g.filter((n) => n.result === "win").length }; };
  const wins = graded.filter((n) => n.result === "win").length;
  return {
    stats: { notes: s.notes.length, open: s.notes.filter((n) => n.status === "open").length, graded: graded.length, wins, winRate: graded.length ? wins / graded.length : null, up: by("up"), down: by("down"), sideways: by("sideways") },
    notes: s.notes.slice(-Math.max(1, Math.min(300, Number(limit) || 60))).reverse(),
    rules: "Every 6 hours Troya reads hourly candles for ETH, BTC, $TROYA and the top Troya picks and writes one note per coin: a lean for the next 24 hours (up, down or sideways), support and resistance from the last two days, and why: the 20- and 50-hour averages, RSI, volume against the day before and where the price sits in its range. 24 hours later each note is graded against the price then: up wins at +0.5% or more, down at -0.5% or less, sideways if the move stays inside ±3%. Nothing is deleted. A read of the chart, never advice.",
    updatedAt: Date.now(),
  };
}
export async function noteFor(id) {
  const s = await state(), k = lc(id) === "eth" ? "ETH" : lc(id) === "btc" ? "BTC" : lc(id);
  return s.notes.filter((n) => n.id === k).pop() || null;
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/oracle", ({ query }) => oracleView({ limit: query.limit }), { weight: 1 });
  r.get("/api/oracle/coin/:id", async ({ params }) => ({ note: await noteFor(params.id) }), { weight: 1 });
  if (process.env.ORACLE !== "0") { setTimeout(() => tick().catch(() => {}), 45_000); setInterval(() => tick().catch(() => {}), 10 * 60_000).unref(); }
}
