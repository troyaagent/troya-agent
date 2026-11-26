// V9 F52 Two Fates, part 1: passed vs blocked, graded on the same clock (Xivor's spec, 25 Nov 2026).
// The Record grades the coins Sentry posts. That alone undersells the Gate, because the comparison is missing: how did the
// launches the Gate blocked do? Here every launch Sentry checks goes on one of two lists, and both are graded the same way:
//   passed   the Gate let it through (passed, or passed with notes)
//   blocked  the Gate blocked it for a safety reason. A coin blocked only because its curve trades against USDG or a stock
//            token (route: "pay with USDG first") is NOT a safety block and is left out, so it cannot flatter the numbers.
// Same clock: the price when Sentry checked it, then at 1 hour and 24 hours. Same "went to zero": the 24 h price is 10% of
// the price at the check or less, or there is no price at all any more. A blocked coin that could not be sold (the test sell
// or the simulation failed) has no honest 24 h price: it is filed as "not sellable", counted as a full loss in the totals
// and shown apart from coins that simply fell.
// Nothing here is a forecast or advice: it is what the price did after the check, whatever that turns out to say.
//   GET /api/fates → { passed, blocked, rules, recent, since, updatedAt }
import { getRobinhoodToken, getEthUsd } from "./market.mjs";

const FILE = "fates.json";
const SENTRY = "sentry.json";
const H = 3600e3, DAY = 24 * H;
const JOIN_MS = 20 * 60e3;      // a check noticed later than this has no fair "price at the check": it is not entered
const KEEP = 3000;
const ZERO = 0.1;               // "went to zero": the 24 h price is at most 10% of the price at the check
const NOT_SELLABLE = new Set(["sell", "sim"]);
let store, busy = false, mem = null;

const lc = (s) => String(s || "").toLowerCase();
const num = (x) => (Number.isFinite(x) && x > 0 ? x : null);

async function priceNow(token) {
  const r = await getRobinhoodToken(token);
  const p = r?.pons;
  if (p && !p.graduated && p.priceInPair > 0 && p.pair?.address === "native") {
    const eu = Number(await getEthUsd()) || 0;
    if (eu) return p.priceInPair * eu;
  }
  return num(Number(r?.token?.priceUsd));
}

// which list a Sentry result belongs on, or null (not tested, no buyers yet, or a route-only block)
export function cohortOf(x) {
  if (!x?.token || !x.at) return null;
  if (x.verdict === "passed" || x.verdict === "caution") return "passed";
  if (x.verdict !== "failed") return null;
  const fails = Array.isArray(x.fails) ? x.fails : null;
  // results recorded before Sentry kept the failing checks: only the reason text is known
  if (!fails) return /^route\b/i.test(String(x.reason || "")) ? null : "blocked";
  return fails.some((k) => k !== "route") ? "blocked" : null;
}

async function state() { mem ||= await store.readJson(FILE, { coins: {}, since: Date.now() }); return mem; }
async function save() {
  if (!mem) return;
  const all = Object.entries(mem.coins).sort((a, b) => b[1].at - a[1].at);
  if (all.length > KEEP) mem.coins = Object.fromEntries(all.slice(0, KEEP));
  await store.writeJson(FILE, mem);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await state();
    const s = await store.readJson(SENTRY, {});
    const now = Date.now();
    // new checks: entered with the price of the moment, only while that moment is still close to the check
    for (const x of s.recent || []) {
      const k = lc(x.token), cohort = cohortOf(x);
      if (!cohort || d.coins[k] || now - x.at > JOIN_MS) continue;
      const fails = Array.isArray(x.fails) ? x.fails : [];
      const c = { token: k, symbol: x.symbol || null, at: x.at, cohort, reason: cohort === "blocked" ? String(x.reason || "").slice(0, 300) : null, fails,
        notSellable: cohort === "blocked" && fails.some((f) => NOT_SELLABLE.has(f)), status: "watching" };
      c.p0 = await priceNow(k).catch(() => null);
      c.joinedAt = now;
      if (!c.p0 && !c.notSellable) c.status = "no-price";   // nothing to grade against; listed, left out of the numbers
      d.coins[k] = c;
    }
    // grading: one read at 1 hour, one at 24 hours
    for (const c of Object.values(d.coins)) {
      if (c.status !== "watching") continue;
      const age = now - c.at;
      if (c.notSellable && age >= DAY) { c.status = "graded"; c.result = "not-sellable"; continue; }
      if (!c.p1h && age >= H && !c.tried1h) { c.tried1h = true; c.p1h = await priceNow(c.token).catch(() => null); }
      if (age >= DAY) {
        const p = await priceNow(c.token).catch(() => null);
        c.p24h = p; c.status = "graded"; c.gradedAt = now;
        c.result = c.notSellable ? "not-sellable" : !p || p <= c.p0 * ZERO ? "zero" : p > c.p0 ? "up" : "down";
      }
    }
    await save();
  } catch (e) {
    console.warn("[fates]", e.message);
  } finally { busy = false; }
}

const pct = (a, b) => (num(a) && num(b) ? (b / a - 1) * 100 : null);
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// a not-sellable coin and a coin with no price left count as -100% in the median, the same for both lists
const change24 = (c) => (c.result === "not-sellable" || (c.result === "zero" && !num(c.p24h)) ? -100 : pct(c.p0, c.p24h));
function statsOf(list) {
  const graded = list.filter((c) => c.status === "graded");
  const ch = graded.map(change24).filter((x) => x != null);
  return {
    checked: list.length, watching: list.filter((c) => c.status === "watching").length, graded: graded.length,
    up24h: graded.filter((c) => c.result === "up").length,
    wentToZero: graded.filter((c) => c.result === "zero").length,
    notSellable: graded.filter((c) => c.result === "not-sellable").length,
    median24h: median(ch),
    zeroShare: graded.length ? graded.filter((c) => c.result === "zero" || c.result === "not-sellable").length / graded.length : null,
  };
}
function view(c) {
  return { token: c.token, symbol: c.symbol, at: c.at, cohort: c.cohort, status: c.status, result: c.result || null, reason: c.reason, notSellable: !!c.notSellable,
    priceAtCheck: c.p0 ?? null, change1h: pct(c.p0, c.p1h), change24h: c.status === "graded" ? change24(c) : null };
}
// what the Gate said about each of these contracts when Sentry checked its launch (V10, Xivor's name-clash idea, 26 Nov
// 2026): { address: { v: "passed" | "blocked", reason, at } }; a contract Sentry never checked is left out
export async function launchVerdicts(addrs) {
  if (!store) return {};
  const d = await state().catch(() => null), out = {};
  for (const a of addrs || []) { const c = d?.coins?.[lc(a)]; if (c?.cohort) out[lc(a)] = { v: c.cohort, reason: c.reason || null, at: c.at || null }; }
  return out;
}
export async function fatesView({ limit = 100 } = {}) {
  const d = await state();
  const all = Object.values(d.coins).sort((a, b) => b.at - a.at);
  const priced = all.filter((c) => c.status !== "no-price");
  return {
    passed: statsOf(priced.filter((c) => c.cohort === "passed")),
    blocked: statsOf(priced.filter((c) => c.cohort === "blocked")),
    recent: all.slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map(view),
    since: d.since, updatedAt: Date.now(),
    rules: "Every launch Troya Sentry checks goes on one of two lists. Passed: the Gate let it through (passed, or passed with notes). Blocked: the Gate blocked it for a safety reason; a coin blocked only because its curve trades against USDG or a stock token is left out. Both are priced when Sentry checked them and again at 1 hour and 24 hours. Went to zero means the 24 h price is 10% of the price at the check or less, or there is no price any more. A blocked coin whose test sell or simulation failed is filed as not sellable and counted as a full loss, apart from coins that simply fell. Coins with no price at the check are listed but left out of the numbers. What the price did, not a forecast or advice.",
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/fates", ({ query }) => fatesView({ limit: query.limit }), { weight: 1 });
  if (process.env.FATES === "0") return;
  setInterval(() => tick().catch(() => {}), 60_000).unref?.();
  setTimeout(() => tick().catch(() => {}), 20_000).unref?.();
}
