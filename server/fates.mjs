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
// 7 and 30 days (Xivor's holder review, idea A, 27 Nov 2026): a coin graded at 24 h is read again at 7 and 30 days, with a
// fresh Gate test sell, because a delayed honeypot passes the sell test at launch and switches on a blacklist or a 100% tax
// later. "Went bad" (rule v1, written down before any 7 or 30 day grade existed): the price is 10% of the price at the check
// or less, or there is no price any more, or the coin cannot be sold (the re-test sell, the simulation or the route fails;
// for a coin blocked as not sellable at the check, until a re-test sells it). One 2x2 table per horizon: passed or blocked
// at the check, against went bad or still tradable, with the base rate (how many of all graded coins went bad).
//   GET /api/fates → { passed, blocked, tables, wentBadRule, rules, recent, since, updatedAt }
import { getRobinhoodToken, getEthUsd } from "./market.mjs";

const FILE = "fates.json";
const SENTRY = "sentry.json";
const H = 3600e3, DAY = 24 * H;
const JOIN_MS = 20 * 60e3;      // a check noticed later than this has no fair "price at the check": it is not entered
const KEEP = 3000;
const ZERO = 0.1;               // "went to zero": the 24 h price is at most 10% of the price at the check
const NOT_SELLABLE = new Set(["sell", "sim"]);
const W7 = 7 * DAY, W30 = 30 * DAY;
const RETEST_PER_TICK = 3;     // Gate re-tests per minute at most (each one simulates a buy and a sell on the chain)
const RETEST_ETH = "0.01";
export const WENT_BAD_RULE = { version: "v1", setAt: "2026-11-27", text: "A coin went bad by a horizon (24 hours, 7 days, 30 days) when, at that time, its price is 10% of the price at the Sentry check or less, or it has no price any more, or it cannot be sold: the Gate's test sell, simulation or route fails at the re-test (7 and 30 days), or it was blocked as not sellable at the check and no re-test has sold it since. Anything else is still tradable. Written down on 27 Nov 2026, before the first 7 day grade." };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      const c = { token: k, symbol: x.symbol || null, at: x.at, cohort, verdict: x.verdict || null, reason: cohort === "blocked" ? String(x.reason || "").slice(0, 300) : null, fails,
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
    // 7 and 30 days: a price read and a fresh Gate test sell, a few per minute, the oldest first
    let budget = RETEST_PER_TICK;
    const due = Object.values(d.coins).filter((c) => c.status === "graded").sort((a, b) => a.at - b.at);
    for (const c of due) {
      if (budget <= 0) break;
      for (const [key, win] of [["d7", W7], ["d30", W30]]) {
        if (budget <= 0 || c[key] || now - c.at < win) continue;
        budget--;
        const r = await laterRead(c, now).catch(() => null);
        if (r) c[key] = r;
      }
    }
    await save();
  } catch (e) {
    console.warn("[fates]", e.message);
  } finally { busy = false; }
}

const pct = (a, b) => (num(a) && num(b) ? (b / a - 1) * 100 : null);
// one later read: the price now and a fresh Gate run; sellable is true (the test sell went through), false (the sell, the
// simulation or the route failed) or null (the Gate could not say: no answer in time, or the sell was not tested)
async function laterRead(c, now) {
  const p = num(await priceNow(c.token).catch(() => null));
  let sellable = null;
  try {
    const { gateCheck } = await import("./robinhood.mjs");
    const g = await Promise.race([gateCheck({ tokenIn: "ETH", tokenOut: c.token, amountIn: RETEST_ETH, slippageBps: 100 }), sleep(45_000).then(() => null)]);
    const ch = Array.isArray(g?.checks) ? g.checks : [];
    if (ch.some((x) => ["sell", "sim", "route"].includes(x.key) && x.status === "fail")) sellable = false;
    else if (ch.some((x) => x.key === "sell" && (x.status === "pass" || x.status === "warn"))) sellable = true;
  } catch { /* the Gate could not run: sellable stays unknown */ }
  const gone = !p || (num(c.p0) && p <= c.p0 * ZERO);
  const stuck = sellable === false || (c.notSellable && sellable !== true);
  return { at: now, p, change: num(c.p0) && p ? pct(c.p0, p) : gone ? -100 : null, sellable, bad: gone || stuck,
    why: sellable === false ? "could not be sold at the re-test" : gone ? (p ? "price 10% of the check or less" : "no price any more") : stuck ? "blocked as not sellable, no re-test sold it" : null };
}
// went bad by a horizon: true, false, or null while it is not graded at that horizon yet
const badAt = (c, h) => (h === "24h" ? (c.status === "graded" ? c.result === "zero" || c.result === "not-sellable" : null) : (c[h] ? !!c[h].bad : null));
// the change at a horizon, for the second column (down 50% or more); a coin with no price left or not sellable counts as -100%
// (change24 is defined further down: these run only after the module has loaded)
const changeAt = (c, h) => (h === "24h" ? (c.status === "graded" ? change24(c) : null) : c[h] ? (c[h].bad && c[h].change == null ? -100 : c[h].change) : null);
function tableOf(priced, h) {
  const cell = (cohort) => {
    const list = priced.filter((c) => c.cohort === cohort && badAt(c, h) != null);
    const bad = list.filter((c) => badAt(c, h));
    // a second column that leaves the main rule alone (Xivor, 27 Nov 2026): down 50% or more, went-bad coins included
    const down50 = list.filter((c) => { const x = changeAt(c, h); return x != null && x <= -50; }).length;
    return { graded: list.length, wentBad: bad.length, stillTradable: list.length - bad.length, down50 };
  };
  const passed = cell("passed"), blocked = cell("blocked"), n = passed.graded + blocked.graded;
  // shares are 0 to 1 and named so; counts are in passed and blocked
  return { passed, blocked, graded: n,
    // the base rate: how many of all graded coins went bad (when most do, "block everything" already looks accurate)
    baseRate: n ? (passed.wentBad + blocked.wentBad) / n : null,
    passedWentBadShare: passed.graded ? passed.wentBad / passed.graded : null,               // missed: Troya passed it, it went bad
    blockedStillTradableShare: blocked.graded ? blocked.stillTradable / blocked.graded : null,  // false alarms
    passedDown50Share: passed.graded ? passed.down50 / passed.graded : null,
    blockedDown50Share: blocked.graded ? blocked.down50 / blocked.graded : null };
}
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
    priceAtCheck: c.p0 ?? null, change1h: pct(c.p0, c.p1h), change24h: c.status === "graded" ? change24(c) : null,
    change7d: c.d7?.change ?? null, bad7d: c.d7 ? !!c.d7.bad : null, sellable7d: c.d7?.sellable ?? null, why7d: c.d7?.why ?? null,
    change30d: c.d30?.change ?? null, bad30d: c.d30 ? !!c.d30.bad : null, sellable30d: c.d30?.sellable ?? null, why30d: c.d30?.why ?? null };
}
// what the Gate said about each of these contracts when Sentry checked its launch (V10, Xivor's name-clash idea, 26 Nov
// 2026): { address: { v: "passed" | "notes" | "blocked", reason, at } }. "notes" is a pass with notes (Sentry's caution:
// a check warned, e.g. the sell side could not be tested), kept apart so a plain "passed" never reads as safe when it was
// not clean (Xivor). Older Two Fates rows did not keep that difference: Sentry's own recent list fills it in when it
// still has the coin; otherwise the row says "passed". A contract Sentry never checked is left out.
export async function launchVerdicts(addrs) {
  if (!store) return {};
  const d = await state().catch(() => null), out = {};
  let sv = null;
  const sentryVerdict = async (k) => {
    sv ||= new Map(((await store.readJson(SENTRY, {}).catch(() => ({})))?.recent || []).map((x) => [lc(x.token), x.verdict]));
    return sv.get(k);
  };
  for (const a of addrs || []) {
    const k = lc(a), c = d?.coins?.[k];
    if (!c?.cohort) continue;
    const verdict = c.verdict || (c.cohort === "passed" ? await sentryVerdict(k) : null);
    out[k] = { v: c.cohort === "blocked" ? "blocked" : verdict === "caution" ? "notes" : "passed", reason: c.reason || null, at: c.at || null };
  }
  return out;
}
export async function fatesView({ limit = 100 } = {}) {
  const d = await state();
  const all = Object.values(d.coins).sort((a, b) => b.at - a.at);
  const priced = all.filter((c) => c.status !== "no-price");
  return {
    passed: statsOf(priced.filter((c) => c.cohort === "passed")),
    blocked: statsOf(priced.filter((c) => c.cohort === "blocked")),
    tables: { "24h": tableOf(priced, "24h"), "7d": tableOf(priced, "d7"), "30d": tableOf(priced, "d30") },
    wentBadRule: WENT_BAD_RULE,
    recent: all.slice(0, Math.min(3000, Math.max(1, Number(limit) || 100))).map(view),
    since: d.since, updatedAt: Date.now(),
    rules: "Every launch Troya Sentry checks goes on one of two lists. Passed: the Gate let it through (passed, or passed with notes). Blocked: the Gate blocked it for a safety reason; a coin blocked only because its curve trades against USDG or a stock token is left out. Both are priced when Sentry checked them and again at 1 hour and 24 hours. Went to zero means the 24 h price is 10% of the price at the check or less, or there is no price any more. A blocked coin whose test sell or simulation failed is filed as not sellable and counted as a full loss, apart from coins that simply fell. Coins with no price at the check are listed but left out of the numbers. Coins graded at 24 hours are read again at 7 and 30 days with a fresh Gate test sell, and each horizon has a 2x2 table: passed or blocked against went bad or still tradable, with the base rate. " + WENT_BAD_RULE.text + " What the price did, not a forecast or advice.",
  };
}

/* ---------- the weekly scorecard (Xivor, 28 Nov 2026) ----------
   Every Monday, the same format so weeks can be compared: the 2x2 table per horizon (passed / blocked × went bad / still
   tradable) with the down-50%-or-more column and the base rate, plus two example coins, one passed and one blocked, picked
   from the side that flatters the Gate least: the passed coin that did worst and the blocked coin that did best. Misses and
   false alarms get the same space as hits. Draft only: sent to the owner on Monday from 09:00 UTC (first edition 7 Dec 2026,
   after the first 7-day grades); nothing is posted until the owner approves it. GET /api/fates/scorecard shows the draft. */
const SCORECARD_FROM = Date.UTC(2026, 11, 7);
const pctTxt = (x) => (x == null ? "–" : `${Math.round(x * 1000) / 10}%`);
const sgnPct = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${Math.round(x)}%`);
const dayTxt = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function hzLine(t, h) {
  if (!t?.graded) return `${h}: no grades yet`;
  return `${h}: passed ${t.passed.graded} (went bad ${t.passed.wentBad}, down 50%+ ${t.passed.down50} = ${pctTxt(t.passedDown50Share)}) · blocked ${t.blocked.graded} (went bad ${t.blocked.wentBad}, down 50%+ ${t.blocked.down50} = ${pctTxt(t.blockedDown50Share)}) · base rate ${pctTxt(t.baseRate)}`;
}
export function scorecardDraft(v, now = Date.now()) {
  const T = v.tables || {};
  const h = T["30d"]?.graded ? ["30d", "change30d", "30 days"] : T["7d"]?.graded ? ["7d", "change7d", "7 days"] : ["24h", "change24h", "24 hours"];
  const withCh = (v.recent || []).filter((c) => c[h[1]] != null);
  const passedWorst = withCh.filter((c) => c.cohort === "passed").sort((a, b) => a[h[1]] - b[h[1]])[0] || null;
  const blockedBest = withCh.filter((c) => c.cohort === "blocked").sort((a, b) => b[h[1]] - a[h[1]])[0] || null;
  const name = (c) => (c.symbol ? `$${c.symbol}` : `${c.token.slice(0, 8)}…`);
  const ex = [];
  if (passedWorst) ex.push(`Passed, did worst: ${name(passedWorst)} ${sgnPct(passedWorst[h[1]])} at ${h[2]}${passedWorst[h[1]] <= -50 ? " (a miss)" : ""}. troya.codes/check/${passedWorst.token}`);
  if (blockedBest) ex.push(`Blocked, did best: ${name(blockedBest)} ${sgnPct(blockedBest[h[1]])} at ${h[2]}${blockedBest[h[1]] > 0 ? " (a false alarm)" : ""}. Blocked for: ${blockedBest.reason || "a safety check"}. troya.codes/check/${blockedBest.token}`);
  const head = `Two Fates, weekly scorecard · ${dayTxt(now)}`;
  const t24 = T["24h"] || {}, t7 = T["7d"] || {};
  const x = [
    head,
    t24.graded ? `24h: passed ${t24.passed.graded}, ${pctTxt(t24.passedDown50Share)} down 50%+ · blocked ${t24.blocked.graded}, ${pctTxt(t24.blockedDown50Share)} down 50%+` : null,
    t7.graded ? `7d: passed ${t7.passed.graded}, ${pctTxt(t7.passedDown50Share)} down 50%+ · blocked ${t7.blocked.graded}, ${pctTxt(t7.blockedDown50Share)} down 50%+` : null,
    "Misses and false alarms included. Tables + CSV: troya.codes/record#two-fates",
  ].filter(Boolean).join("\n");
  const telegram = [
    `<b>${head}</b>`, "",
    "Every launch Sentry checks: passed or blocked by the Gate, graded on the same clock.",
    hzLine(T["24h"], "24 hours"), hzLine(T["7d"], "7 days"), hzLine(T["30d"], "30 days"), "",
    ...(ex.length ? ["Two examples, from the side that flatters the Gate least:", ...ex.map((e) => `• ${e}`), ""] : []),
    `Went bad: at most 10% of the price at the check, no price any more, or it cannot be sold (rule ${v.wentBadRule?.version || "v1"}, written down ${v.wentBadRule?.setAt || "27 Nov 2026"}, before the first 7-day grade).`,
    "Every coin, the full tables and the CSV: troya.codes/record#two-fates",
    "What the price did after the check; never a forecast.",
  ].join("\n");
  return { x, telegram, horizon: h[0], note: "Draft only: the owner approves it before it is posted on X and in the group." };
}
async function maybeSendScorecard(now = Date.now()) {
  const d = new Date(now);
  if (now < SCORECARD_FROM || d.getUTCDay() !== 1 || d.getUTCHours() < 9) return;
  const key = d.toISOString().slice(0, 10);
  const sent = await store.readJson("fates-scorecard.json", {}).catch(() => ({}));
  if (sent[key]) return;
  const dr = scorecardDraft(await fatesView({ limit: 3000 }), now);
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const { tellOwner } = await import("./infrawatch.mjs");
  await tellOwner(`<b>Two Fates scorecard: this week's draft</b>\nNot posted. Approve it in chat before anything goes out.\n\n<b>X</b>\n${esc(dr.x)}\n\n<b>Telegram</b>\n${dr.telegram}`);
  await store.writeJson("fates-scorecard.json", { ...sent, [key]: now });
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/fates", ({ query }) => fatesView({ limit: query.limit }), { weight: 1 });
  r.get("/api/fates/scorecard", async () => scorecardDraft(await fatesView({ limit: 3000 })), { weight: 2, perMin: 20 });
  setInterval(() => maybeSendScorecard().catch((e) => console.warn("[fates] scorecard", e.message)), 15 * 60_000).unref?.();
  if (process.env.FATES === "0") return;
  setInterval(() => tick().catch(() => {}), 60_000).unref?.();
  // the tables' numbers written into /record for readers without JavaScript, refreshed every 2 minutes
  const writeHtml = async () => {
    try {
      const { setFragment } = await import("./livehtml.mjs");
      const v = await fatesView({ limit: 1 });
      const line = (h, t) => (t?.graded ? `${h}: passed ${t.passed.graded} (went bad ${t.passed.wentBad}, down 50% or more ${t.passed.down50}), blocked ${t.blocked.graded} (went bad ${t.blocked.wentBad}, down 50% or more ${t.blocked.down50})` : `${h}: not graded yet`);
      setFragment("fates-head", `<p class="rec-ssr">${[line("24 hours", v.tables["24h"]), line("7 days", v.tables["7d"]), line("30 days", v.tables["30d"])].join("<br>")}<br>Went-bad rule ${WENT_BAD_RULE.version} (${WENT_BAD_RULE.setAt}). Raw data: <a href="/api/fates">/api/fates</a>.</p>`);
    } catch (e) { console.warn("[fates] html", e.message); }
  };
  setTimeout(writeHtml, 25_000).unref?.();
  setInterval(writeHtml, 120_000).unref?.();
  setTimeout(() => tick().catch(() => {}), 20_000).unref?.();
}
