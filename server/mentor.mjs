// V10 F70 Mentor: Blocked, and Here Is Why (community idea). A weekly report built from Two Fates (fates.mjs): which launches
// the Gate blocked, the reason in plain words, what happened to them afterwards, next to the ones it passed. Mentor was Athena
// in disguise, guiding Odysseus's son. Every coin is linked to its proof, and the misses are included and counted.
// What it reads: data/fates.json, exactly as Two Fates keeps it (passed vs blocked, priced at the check, at 1 hour and at 24
// hours; a coin blocked only for its route, "pay with USDG first", is not a safety block and Two Fates leaves it out; a
// blocked coin whose test sell or simulation failed is "not sellable" and counted as a full loss). Nothing is re-graded here.
// Two Fates keeps its last 3000 coins (about a week of launches), so Mentor copies each week into data/mentor.json as it goes
// and freezes it 26 hours after the week ends (by then every coin checked that week has its 24 hour price).
// A week runs Monday 00:00 UTC to Sunday 24:00 UTC. Two Fates started collecting on 25 Nov 2026, so the first week is
// partial, and the report says so.
// Misses, counted on both sides: a blocked coin that was up 24 hours later, and a passed coin that went to zero.
// Mentor never posts. mentorDraft() writes a short draft for X and Telegram; only the owner posts it, after approving it.
// With MENTOR_DRAFTS=1 (off by default) the draft of the week that just ended is sent privately to the owner on Monday from
// 09:00 UTC, once, through the owner alerts (infrawatch.mjs tellOwner).
//   GET /api/mentor               the current week + the archive of past weeks (summaries)
//   GET /api/mentor?week=YYYY-MM-DD  one week in full (the Monday it starts on)
//   GET /api/mentor/draft         admins only: the draft post text for a week (?week=)
// What the price did after the check, not a forecast or advice.
import { HttpError } from "./api.mjs";

const FILE = "mentor.json", FATES = "fates.json", RECORD = "record.json";
const H = 3600e3, DAY = 24 * H, WEEK = 7 * DAY;
const FREEZE_AFTER = 26 * H;
const KEEP_WEEKS = 26;
const TICK = 10 * 60_000;
const ZERO = 0.1;
const SITE = "https://troya.codes";
const EXPLORER = "https://robinhoodchain.blockscout.com";
let store = null, mem = null, busy = false, lastTick = 0;

const lc = (s) => String(s || "").toLowerCase();
const num = (x) => (Number.isFinite(x) && x > 0 ? x : null);
const pct = (a, b) => (num(a) && num(b) ? (b / a - 1) * 100 : null);
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export function weekStart(ms) { const d = new Date(ms); const back = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back); }
const keyOf = (start) => new Date(start).toISOString().slice(0, 10);
const dateText = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeText = (ms) => `${dateText(ms)} ${new Date(ms).toISOString().slice(11, 16)} UTC`;

// the Gate's checks in plain words (the keys Sentry keeps in `fails`)
const PLAIN = {
  sell: "it could not be sold: the test sell failed",
  sim: "a dry run of the buy failed",
  tax: "a hidden transfer tax takes part of every transfer",
  fee: "the fees and taxes on a trade are too high",
  impact: "a small buy moves the price too far (thin liquidity)",
  ring: "the launch looks rigged (Ring Radar: tax-exempt insider wallets or bundled first buys)",
  depth: "the pool is too thin",
  devlinks: "the dev's side wallets hold too much",
  oath: "the dev broke a signed pledge",
  route: "it could not be routed",
};
export function plainReason(c) {
  const keys = (c.fails || []).filter((k) => k !== "route");
  const words = keys.map((k) => PLAIN[k]).filter(Boolean);
  if (words.length) return words.join("; ");
  const head = String(c.reason || "").split(":")[0].trim();
  return head ? `${head} failed` : "a safety check failed";
}

/* ---------- the copy of Two Fates, week by week ---------- */
async function state() { mem ||= await store.readJson(FILE, { weeks: {}, drafts: {}, fatesSince: null }); return mem; }
// what Mentor keeps of a Two Fates coin: enough to rebuild its line, nothing graded twice
const compact = (c) => ({ token: lc(c.token), symbol: c.symbol || null, at: c.at, cohort: c.cohort, reason: c.cohort === "blocked" ? c.reason || null : null, fails: c.cohort === "blocked" ? c.fails || [] : undefined,
  notSellable: !!c.notSellable || undefined, status: c.status, result: c.result || null, p0: c.p0 ?? null, p1h: c.p1h ?? null, p24h: c.p24h ?? null });

export async function tick() {
  if (busy) return;
  busy = true;
  lastTick = Date.now();
  try {
    const m = await state();
    const f = await store.readJson(FATES, { coins: {} });
    const now = Date.now();
    let changed = false;
    if (f.since && m.fatesSince !== f.since) { m.fatesSince = f.since; changed = true; }
    for (const c of Object.values(f.coins || {})) {
      if (!c?.token || !c.at || !c.cohort) continue;
      const start = weekStart(c.at), k = keyOf(start);
      const w = (m.weeks[k] ||= { start, end: start + WEEK, coins: {} });
      if (w.frozenAt) continue;
      const v = compact(c), old = w.coins[v.token];
      if (!old || JSON.stringify(old) !== JSON.stringify(v)) { w.coins[v.token] = v; changed = true; }
    }
    for (const w of Object.values(m.weeks)) if (!w.frozenAt && now > w.end + FREEZE_AFTER) { w.frozenAt = now; changed = true; }
    const keys = Object.keys(m.weeks).sort();
    while (keys.length > KEEP_WEEKS) { delete m.weeks[keys.shift()]; changed = true; }
    if (changed) await store.writeJson(FILE, m);
    if (process.env.MENTOR_DRAFTS === "1") await maybeSendDraft(now).catch((e) => console.warn("[mentor] draft", e.message));
  } catch (e) {
    console.warn("[mentor]", e.message);
  } finally { busy = false; }
}

/* ---------- one week, in plain words ---------- */
const change24 = (c) => (c.status !== "graded" ? null : c.result === "not-sellable" || (c.result === "zero" && !num(c.p24h)) ? -100 : pct(c.p0, c.p24h));
function statsOf(list) {
  const graded = list.filter((c) => c.status === "graded");
  const ch = graded.map(change24).filter((x) => x != null);
  return {
    checked: list.length, watching: list.filter((c) => c.status === "watching").length, graded: graded.length,
    up24h: graded.filter((c) => c.result === "up").length, down24h: graded.filter((c) => c.result === "down").length,
    wentToZero: graded.filter((c) => c.result === "zero").length, notSellable: graded.filter((c) => c.result === "not-sellable").length,
    median24h: median(ch),
    zeroShare: graded.length ? graded.filter((c) => c.result === "zero" || c.result === "not-sellable").length / graded.length : null,
  };
}
const RESULT = { up: "up after 24 h", down: "down after 24 h", zero: "went to zero within 24 h", "not-sellable": "could not be sold (counted as a full loss)" };
function resultText(c) {
  if (c.status === "no-price") return "no price at the check, so not graded";
  if (c.status === "watching") return c.notSellable ? "not sellable at the check; graded at 24 h" : "still being watched (graded 24 h after the check)";
  return RESULT[c.result] || "graded";
}
function missOf(c) {
  if (c.status !== "graded") return null;
  if (c.cohort === "blocked" && c.result === "up") return "blocked-rose";
  if (c.cohort === "passed" && c.result === "zero") return "passed-zero";
  return null;
}
function line(c, calls) {
  const call = calls[c.token];
  const recordCall = call && call.kind !== "born" && call.kind !== "stock" ? { at: call.at, post: call.post || null, page: `${SITE}/record` } : null;
  return {
    token: c.token, symbol: c.symbol, at: c.at, cohort: c.cohort, status: c.status, result: c.result, resultText: resultText(c),
    reason: c.cohort === "blocked" ? plainReason(c) : null, gateSaid: c.cohort === "blocked" ? c.reason || null : null, fails: c.fails || [], notSellable: !!c.notSellable,
    priceAtCheck: c.p0 ?? null, change1h: pct(c.p0, c.p1h), change24h: change24(c), miss: missOf(c),
    proof: { gate: `${SITE}/agent#/gate/${c.token}`, record: recordCall, explorer: `${EXPLORER}/token/${c.token}`, fates: `${SITE}/api/fates` },
  };
}
function partialOf(w, since) {
  if (!since || since <= w.start) return null;
  return { from: since, text: `Two Fates started collecting on ${timeText(since)}, so this week covers only from then, not from ${dateText(w.start)}.` };
}
/** One week as the report shows it. passedLimit: how many passed coins to list (misses first, then newest). */
export function weekView(w, { since = null, calls = {}, passedLimit = 100, now = Date.now() } = {}) {
  const all = Object.values(w.coins || {}).sort((a, b) => b.at - a.at);
  const priced = all.filter((c) => c.status !== "no-price");
  const blocked = all.filter((c) => c.cohort === "blocked").map((c) => line(c, calls));
  const passedAll = all.filter((c) => c.cohort === "passed").map((c) => line(c, calls));
  const passed = [...passedAll.filter((c) => c.miss), ...passedAll.filter((c) => !c.miss)].slice(0, Math.max(0, Math.min(3000, passedLimit)));
  const stats = { passed: statsOf(priced.filter((c) => c.cohort === "passed")), blocked: statsOf(priced.filter((c) => c.cohort === "blocked")) };
  const misses = {
    blockedRose: blocked.filter((c) => c.miss === "blocked-rose").length,
    passedZero: passedAll.filter((c) => c.miss === "passed-zero").length,
  };
  misses.total = misses.blockedRose + misses.passedZero;
  const caught = blocked.filter((c) => c.status === "graded" && (c.result === "zero" || c.result === "not-sellable")).length;
  const running = now < w.end;
  return {
    key: keyOf(w.start), start: w.start, end: w.end, running, frozen: !!w.frozenAt, partial: partialOf(w, since),
    counts: { checked: all.length, passed: passedAll.length, blocked: blocked.length, noPrice: all.filter((c) => c.status === "no-price").length,
      watching: all.filter((c) => c.status === "watching").length },
    stats, misses, caught, blocked, passed, passedListed: passed.length, passedTotal: passedAll.length,
    summary: summaryOf({ w, stats, misses, caught, blockedN: blocked.length, passedN: passedAll.length, running }),
  };
}
const p0 = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const sgn = (x) => (x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x) >= 10 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(1)}%`);
function summaryOf({ w, stats, misses, caught, blockedN, passedN, running }) {
  const b = stats.blocked, p = stats.passed;
  const parts = [`${running ? "So far this week" : `The week of ${dateText(w.start)}`}, the Gate blocked ${blockedN} launch${blockedN === 1 ? "" : "es"} and passed ${passedN}.`];
  if (b.graded) parts.push(`Of the blocked ones graded at 24 hours (${b.graded}), ${caught} went to zero or could not be sold and ${misses.blockedRose} ${misses.blockedRose === 1 ? "was" : "were"} up: ${misses.blockedRose === 1 ? "a miss" : "misses"}, counted.`);
  else if (blockedN) parts.push("None of the blocked ones has its 24 hour price yet.");
  if (p.graded) parts.push(`Of the passed ones graded (${p.graded}), ${p0(p.up24h / p.graded)} were up after 24 hours and ${misses.passedZero} went to zero: misses too, counted. Median 24 hour change: ${sgn(p.median24h)}.`);
  else if (passedN) parts.push("None of the passed ones has its 24 hour price yet.");
  return parts.join(" ");
}

/* ---------- the draft post (never posted by Mentor) ---------- */
/** A short draft for X (no cashtags: one post carries at most one) and a longer one for Telegram. The owner posts it. */
export function mentorDraft(v) {
  const b = v.stats.blocked, p = v.stats.passed;
  const head = `Troya Gate, week of ${dateText(v.start)}${v.partial ? ` (partial: Two Fates started ${dateText(v.partial.from)})` : ""}${v.running ? ", so far" : ""}.`;
  const xl = [head, `Blocked ${v.counts.blocked} launch${v.counts.blocked === 1 ? "" : "es"}, passed ${v.counts.passed}.`];
  if (b.graded) xl.push(`Blocked, 24 h later: ${v.caught} went to zero or could not be sold, ${v.misses.blockedRose} rose (${v.misses.blockedRose === 1 ? "a miss" : "misses"}).`);
  if (p.graded) xl.push(`Passed: ${p0(p.up24h / p.graded)} up at 24 h, ${v.misses.passedZero} went to zero (misses, counted).`);
  xl.push(`Every coin with its proof: troya.codes/agent#/mentor`);
  let x = xl.join("\n");
  if (x.length > 280) x = [head, `Blocked ${v.counts.blocked}, passed ${v.counts.passed}. Misses counted: ${v.misses.total}.`, "Every coin with its proof: troya.codes/agent#/mentor"].join("\n");
  const tl = [head, "", v.summary, ""];
  const shown = v.blocked.slice(0, 8);
  if (shown.length) {
    tl.push("Blocked, and why:");
    for (const c of shown) tl.push(`• ${c.symbol ? `$${c.symbol}` : c.token.slice(0, 10)}: ${c.reason}. ${c.change24h != null ? `24 h: ${sgn(c.change24h)}` : c.resultText.replace(/^./, (x) => x.toUpperCase())}${c.miss ? " (a miss)" : ""}`);
    if (v.blocked.length > shown.length) tl.push(`…and ${v.blocked.length - shown.length} more on the page.`);
    tl.push("");
  }
  const pz = v.passed.filter((c) => c.miss === "passed-zero").slice(0, 5);
  if (pz.length) { tl.push("Passed, then went to zero (misses):"); for (const c of pz) tl.push(`• ${c.symbol ? `$${c.symbol}` : c.token.slice(0, 10)}`); tl.push(""); }
  tl.push("Each coin links to its Gate page and The Record: troya.codes/agent#/mentor", "What the price did after the check; never a forecast.");
  return { x, telegram: tl.join("\n"), week: v.key, note: "Draft only. Mentor never posts: the owner reads it, approves it and posts it." };
}
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function maybeSendDraft(now) {
  const d = new Date(now);
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 9) return;
  const m = await state();
  const k = keyOf(weekStart(now) - WEEK);
  const w = m.weeks[k];
  if (!w || m.drafts?.[k]?.sentAt) return;
  const calls = (await store.readJson(RECORD, { calls: {} })).calls || {};
  const v = weekView(w, { since: m.fatesSince, calls, passedLimit: 200, now });
  const dr = mentorDraft(v);
  const { tellOwner } = await import("./infrawatch.mjs");
  await tellOwner(`<b>Mentor: draft for the week of ${escHtml(dateText(w.start))}</b>\nNot posted. Approve it in chat before anything goes out.\n\n<b>X</b>\n${escHtml(dr.x)}\n\n<b>Telegram</b>\n${escHtml(dr.telegram)}`);
  m.drafts ||= {};
  m.drafts[k] = { sentAt: now };
  await store.writeJson(FILE, m);
}

export const RULES = "Built from Two Fates. Every launch Troya Sentry checks goes on one of two lists: passed (the Gate let it through, passed or passed with notes) or blocked (a safety check failed; a coin blocked only because its curve trades against USDG or a stock token is left out). Each is priced when Sentry checked it, then at 1 hour and 24 hours. Went to zero: the 24 hour price is 10% of the price at the check or less, or there is no price any more. Not sellable: a blocked coin whose test sell or simulation failed, counted as a full loss. Misses are counted on both sides: a blocked coin that was up 24 hours later, and a passed coin that went to zero. A week runs Monday 00:00 UTC to Sunday 24:00 UTC. What the price did after the check, never a forecast or advice.";

async function view({ week, passed } = {}) {
  if (Date.now() - lastTick > 60_000) await tick().catch(() => {});
  const m = await state();
  const calls = (await store.readJson(RECORD, { calls: {} })).calls || {};
  const now = Date.now();
  const curKey = keyOf(weekStart(now));
  let k = curKey;
  if (week != null && week !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week))) throw new HttpError(400, "Give the week as the Monday it starts on: YYYY-MM-DD.");
    k = keyOf(weekStart(Date.parse(`${week}T00:00:00Z`)));
  }
  const start = Date.parse(`${k}T00:00:00Z`);
  const w = m.weeks[k] || { start, end: start + WEEK, coins: {} };
  const v = weekView(w, { since: m.fatesSince, calls, passedLimit: Number(passed) || 100, now });
  const weeks = Object.keys(m.weeks).sort().reverse().map((key) => {
    const x = m.weeks[key], list = Object.values(x.coins || {});
    const g = list.filter((c) => c.status === "graded");
    return { key, start: x.start, end: x.end, running: now < x.end, frozen: !!x.frozenAt, partial: !!partialOf(x, m.fatesSince),
      passed: list.filter((c) => c.cohort === "passed").length, blocked: list.filter((c) => c.cohort === "blocked").length,
      misses: g.filter((c) => (c.cohort === "blocked" && c.result === "up") || (c.cohort === "passed" && c.result === "zero")).length };
  });
  if (!weeks.some((x) => x.key === curKey)) weeks.unshift({ key: curKey, start: weekStart(now), end: weekStart(now) + WEEK, running: true, frozen: false, partial: !!partialOf({ start: weekStart(now) }, m.fatesSince), passed: 0, blocked: 0, misses: 0 });
  return {
    week: v, weeks, current: curKey, fatesSince: m.fatesSince, rules: RULES, updatedAt: now,
    limit: "Mentor reads what Two Fates recorded and nothing else: launches Sentry checked within 20 minutes of the check, priced from the Pons curve or the pool. A coin with no price at the check is listed but left out of the numbers. Two Fates started on 25 Nov 2026, so there is no week before that. The Gate page shows a fresh check today, not the one at the time; The Record links the Sentry post where Sentry posted the coin.",
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/mentor/draft", async ({ req, query }) => {
    const { getSession } = await import("./auth.mjs");
    const s = getSession(req);
    const admins = String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (!s || !admins.includes(lc(s.address))) throw new HttpError(403, "Admins only.");
    const v = (await view({ week: query.week, passed: 300 })).week;
    return mentorDraft(v);
  }, { weight: 1, perMin: 20 });
  r.get("/api/mentor", ({ query }) => view({ week: query.week, passed: query.passed }), { weight: 1, perMin: 120 });
  if (process.env.MENTOR === "0") return;
  setInterval(() => tick().catch(() => {}), TICK).unref?.();
  setTimeout(() => tick().catch(() => {}), 45_000).unref?.();
}
