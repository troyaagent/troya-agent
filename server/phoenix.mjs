// V9 F57 Phoenix: the agents learn from Troya's own graded results (community idea from lynx_evo, 23 Nov 2026: "LLM
// learning for agent quality"). Phoenix was the tutor who raised Achilles. No fine-tuning: a learning loop.
//   A) Every closed trade and every graded call becomes a lesson: who traded (the Arena's AI traders on paper and with
//      their small real budget, the Anthropic Round, Sentry's calls graded in The Record, Champions followers and Sentry
//      Autopilot users, both without any wallet), the coin, the setup features that were stored at the time (coin age at
//      entry, ETH raised on the Pons curve, Sentry's count of independent buyers, Ring Radar's flag, Troya Gate's notes,
//      whether Sentry had posted it, the trader's stop and target, the hour), how long it was held, why it closed, the
//      result in % and win or loss, and one plain line. The line is written from a template (an LLM rewrite only with
//      PHOENIX_LLM=1). Lessons rebuilt from history at the first run are marked backfilled.
//      Lessons are aggregated into pattern stats per feature bucket with the sample size and a Wilson lower bound (95%);
//      a pattern is never claimed with fewer than 5 samples.
//   B) What an agent would be told before it decides (lessonBlock): the 3 to 5 patterns that stand out most, with n, and
//      its last few lessons. Advisory text only: it never changes caps, budgets, kill switches, Gate blocks or any rail.
//      It reaches a prompt only with PHOENIX_INJECT=1 (arena.mjs aiDaily, antround.mjs ask). Off (the default) is shadow
//      mode: lessons and stats are recorded and shown, and every decision path is exactly what it was before.
//   C) The community bot learns from the team's corrections: data/lessons-bot.json, [{ at, wrong, right, source }],
//      seeded once with the corrections of 23 Nov 2026. botfacts.mjs puts the active ones in every bot's facts; an admin
//      chat adds one with /lesson wrong => right (tgbot.mjs).
//   GET /api/phoenix   public: pattern stats, recent lessons, the corrections and what each agent would be told
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FILE = "phoenix.json", BOT_FILE = "lessons-bot.json";
const TICK = 5 * 60_000, KEEP = 5000, MIN_N = 5, Z = 1.96;
const lc = (s) => String(s || "").toLowerCase();
const fin = (x) => (Number.isFinite(x) ? x : null);
let store = null, dataDir = null, busy = false, cache = null, ringIdx = null;

/** PHOENIX_INJECT=1 puts the "What you learned" block into the agents' prompts. Anything else: shadow mode. */
export const INJECT = () => process.env.PHOENIX_INJECT === "1";

/* ---------- the corrections the community bot must never repeat ---------- */
// The three real corrections of 23 Nov 2026, written once when the file does not exist yet (the team edits the file or
// adds lines with /lesson from an admin chat; a seed never overwrites it).
const SEED = [
  { at: "2026-11-23T08:50:00Z", source: "team correction, Telegram group, 23 Nov 2026",
    wrong: "The bot retracted the Market update, as if the shorter busy-coin cards, every new coin listed, the age pills, the chat side panel and search opening Swap were not shipped or not checked.",
    right: "The Market update shipped and is live since 23 Nov 2026 at troya.codes/agent#/market. Confirm it plainly; never retract it or call it unchecked." },
  { at: "2026-11-23T14:45:00Z", source: "team correction, Telegram group, 23 Nov 2026",
    wrong: "Asked \"who is 7%?\", the bot guessed that 7% meant a share of the weekly prize pool.",
    right: "The holder with about 7% of $TROYA is the staking contract 0x1C867c13BD950a90aB75158C1C45061837aa02d2: it holds every staked $TROYA, it is not one person, it has no owner, and only each staker can withdraw their own coins. When someone asks about a big holder or a percentage, check the holders with the tools first; never guess what a number means." },
  { at: "2026-11-23T15:30:00Z", source: "team correction, Telegram group, 23 Nov 2026",
    wrong: "The bot told a staker that the full daily stakers' share only pays once 5% of the supply is staked, as if that target were still ahead.",
    right: "The 5% target was already met (7.6% of the supply staked on 23 Nov 2026), so the full daily share is paid. Read the staked share live (the staked-share line in the live facts, the stake page or /api/stake/stats) before saying anything about it, and never describe the 5% target as not yet reached when the live number is above it." },
];
const botPath = () => join(dataDir, BOT_FILE);
async function seedBot() {
  try { await readFile(botPath(), "utf8"); return; } catch { /* missing: seed it */ }
  await store.writeJson(BOT_FILE, SEED);
  console.log(`[phoenix] seeded ${SEED.length} bot corrections in ${BOT_FILE}`);
}
const okLesson = (e) => e && typeof e.wrong === "string" && typeof e.right === "string" && e.wrong.trim() && e.right.trim() && e.active !== false && (!e.until || Date.parse(e.until) > Date.now());
export async function botLessons() { const l = await store.readJson(BOT_FILE, []); return Array.isArray(l) ? l.filter(okLesson) : []; }
/** /lesson from an admin chat (tgbot.mjs). */
export async function addBotLesson({ wrong, right, source }) {
  const e = { at: new Date().toISOString(), wrong: String(wrong).replace(/\s+/g, " ").trim().slice(0, 600), right: String(right).replace(/\s+/g, " ").trim().slice(0, 900), source: String(source || "team").slice(0, 120) };
  if (e.wrong.length < 4 || e.right.length < 4) return { ok: false, why: "Write it as: /lesson what the bot got wrong => what is right" };
  let n = 0;
  await store.update(BOT_FILE, [], (l) => { const list = Array.isArray(l) ? l : []; list.push(e); n = list.filter(okLesson).length; return list.slice(-200); });
  cache = null;
  return { ok: true, active: n, entry: e };
}
/** /lesson off <n> (n as /lesson list numbers them, active ones only). */
export async function offBotLesson(k) {
  let hit = null;
  await store.update(BOT_FILE, [], (l) => { const act = (Array.isArray(l) ? l : []).filter(okLesson); hit = act[k - 1] || null; if (hit) hit.active = false; return l; });
  cache = null;
  return hit;
}

/* ---------- the setup at the moment of entry (sentry.mjs calls this on every passing check) ---------- */
// What the Arena and Autopilot saw when they could buy: Gate notes, the curve, Ring Radar, the Oath. Buyers are counted
// by Sentry after this, so they are read later from Sentry's results.
export async function noteSetup(r) {
  if (!store || !r?.token) return;
  const notes = (r.checks || []).filter((c) => c && c.status === "warn").map((c) => c.key).filter(Boolean);
  const s = { at: r.at || Date.now(), verdict: r.v || null, notes, raised: fin(Number(r.pons?.raised)) ?? null, progressPct: fin(Number(r.pons?.progressPct)) ?? null,
    onCurve: !!(r.pons && !r.pons.graduated), ring: r.ring?.verdict || null, oath: r.oath?.status || null, ageMs: fin(r.ageMs) ?? null, source: r.source || null };
  await store.update(FILE, {}, (d) => {
    d.setups ||= {};
    d.setups[lc(r.token)] = s;
    const k = Object.keys(d.setups);
    if (k.length > 3000) d.setups = Object.fromEntries(Object.entries(d.setups).sort((a, b) => b[1].at - a[1].at).slice(0, 2500));
    return d;
  }).catch(() => {});
}

/* ---------- reading what is already stored ---------- */
// Ring Radar's flags over time: the Seal keeps a receipt for every amber or red reading (kind "ring", ref = the level),
// ring radar's own file the last 300 readings (clear ones too). Read once per start, then topped up from the file.
async function ringIndex() {
  if (!ringIdx) {
    ringIdx = new Map();
    const dir = join(dataDir, "seal");
    const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) for (const line of (await readFile(join(dir, f), "utf8").catch(() => "")).split("\n")) {
      if (!line.includes('"kind":"ring"')) continue;
      try { const x = JSON.parse(line); if (x.subject && ["red", "amber"].includes(x.ref)) addRing(lc(x.subject), x.at, x.ref); } catch {}
    }
  }
  const rr = await store.readJson("ringradar.json", {});
  for (const x of rr.recent || []) if (x.token && x.at) addRing(lc(x.token), x.at, x.verdict);
  return ringIdx;
}
function addRing(t, at, level) {
  const l = ringIdx.get(t) || [];
  if (!l.some((y) => y.at === at)) { l.push({ at, level }); l.sort((a, b) => a.at - b.at); ringIdx.set(t, l); }
}
async function birthMap() {
  try { return JSON.parse(await readFile(join(dataDir, "token-birth.json"), "utf8")); } catch { return {}; }
}

async function sources() {
  const [arena, record, sentry, ant, champs, auto, birth, ring, ph] = await Promise.all([
    store.readJson("arena.json", {}), store.readJson("record.json", { calls: {} }), store.readJson("sentry.json", {}), store.readJson("antround.json", {}),
    store.readJson("champions.json", {}), store.readJson("autopilot.json", {}), birthMap(), ringIndex(), store.readJson(FILE, {})]);
  const recent = new Map();
  for (const x of sentry.recent || []) if (x.token && !recent.has(lc(x.token))) recent.set(lc(x.token), x);
  return { arena, calls: record.calls || {}, recent, seen: sentry.seen || {}, ant, champs, auto, birth, ring, setups: ph.setups || {} };
}

// what is known about a coin at time t, from what was stored then (or later, for counts that describe that moment)
function coinAt(S, token, t, raisedHint) {
  const k = lc(token), setup = S.setups[k] || null, row = S.recent.get(k) || null;
  const b = S.birth[k];
  let born = b?.src === "creation" && b.at ? Number(b.at) : null, ageSrc = born ? "creation block" : null;
  if (!born && S.seen[k] && Number(S.seen[k]) <= t + 60_000) { born = Number(S.seen[k]); ageSrc = "first seen by Sentry"; }
  const ageMin = born ? Math.max(0, (t - born) / 60_000) : null;
  const raised = fin(raisedHint) ?? setup?.raised ?? (row?.raised != null ? Number(row.raised) : null);
  const onCurve = raisedHint != null ? true : setup ? setup.onCurve : row ? row.raised != null : null;
  const rings = S.ring.get(k) || [];
  const ringAt = setup?.ring || [...rings].reverse().find((x) => x.at <= t + 120_000)?.level || null;
  const call = S.calls[k];
  const posted = call && call.kind !== "born" && call.kind !== "stock" ? call.at <= t : false;
  return {
    ageMin: ageMin != null ? +ageMin.toFixed(1) : null, ageSrc, raisedEth: raised != null && onCurve !== false ? +Number(raised).toFixed(3) : null,
    venue: onCurve === true ? "curve" : onCurve === false ? "pool" : null, buyers: row?.buyers != null ? Number(row.buyers) : null,
    ring: ringAt === "red" || ringAt === "amber" ? ringAt : "none", gateNotes: setup ? setup.notes || [] : null, gateVerdict: setup?.verdict || null, sentryPosted: posted,
  };
}

/* ---------- lessons ---------- */
const AGENT_NAMES = { "ai-claude": "Claude", "ai-gpt": "GPT", "ai-gemini": "Gemini", "ai-deepseek": "DeepSeek", "ai-qwen": "Qwen" };
function collect(S, have) {
  const out = [];
  const names = Object.fromEntries(Object.values(S.arena.agents || {}).map((a) => [a.id, { name: a.name || AGENT_NAMES[a.id] || a.id, model: a.model || null, kind: a.kind }]));
  // the Arena: every closed paper and live trade of an AI trader (user strategies stay on their own pages)
  for (const p of S.arena.positions || []) {
    if (p.status !== "closed" || !p.closedAt || !(p.amountEth > 0) || p.pnlEth == null || have.has(`arena:${p.id}`)) continue;
    const ag = names[p.agent];
    if (!ag || ag.kind !== "ai") continue;
    const f = coinAt(S, p.token, p.openedAt, p.raisedAtEntry);
    out.push({ id: `arena:${p.id}`, source: "arena", book: p.mode === "live" ? "live" : "paper", agent: p.agent, agentName: ag.name, model: ag.model, symbol: p.symbol || null, token: p.token,
      openedAt: p.openedAt, at: p.closedAt, heldMin: +((p.closedAt - p.openedAt) / 60_000).toFixed(1), exit: p.reason || "closed", ...f,
      watchfire: !!p.watchfire || p.reason === "watchfire", stopPct: p.rules?.stopPct ?? null, takeProfitX: p.rules?.takeProfitX ?? null, maxHoldHours: p.rules?.maxHoldHours ?? null,
      pnlPct: +((p.pnlEth / p.amountEth) * 100).toFixed(2), win: p.pnlEth > 0 });
  }
  // The Record: every graded Sentry call (the same calls the Arena's replay uses)
  for (const c of Object.values(S.calls)) {
    if (c.status !== "graded" || c.kind === "born" || c.kind === "stock" || c.source === "x" || !(c.p0 > 0) || !(c.p24h > 0) || have.has(`record:${c.token}`)) continue;
    const f = coinAt(S, c.token, c.at, null);
    if (f.venue == null) f.venue = c.source ? "pool" : "curve";
    out.push({ id: `record:${c.token}`, source: "record", book: "call", agent: "sentry", agentName: "Sentry calls", model: null, symbol: c.symbol || null, token: c.token,
      openedAt: c.at, at: c.at + 86_400_000, heldMin: 1440, exit: "graded at 24 h", ...f, sentryPosted: true,
      peakX: c.peak > 0 ? +(c.peak / c.p0).toFixed(2) : null, pnlPct: +((c.p24h / c.p0 - 1) * 100).toFixed(2), win: c.p24h > c.p0 });
  }
  // the Anthropic Round: long, short or flat on xyz:ANT
  for (const c of S.ant.calls || []) {
    if (c.status !== "closed" || c.side === "flat" || c.pnlPct == null || have.has(`ant:${c.id}`)) continue;
    out.push({ id: `ant:${c.id}`, source: "ant", book: c.live?.opened ? "live" : "paper", agent: c.agent, agentName: c.name || AGENT_NAMES[c.agent] || c.agent, model: c.model || null, symbol: "ANT", token: null,
      openedAt: c.at, at: c.closedAt, heldMin: c.closedAt ? +((c.closedAt - c.at) / 60_000).toFixed(1) : null, exit: c.reason || "closed", side: c.side, lev: c.lev, stopPct: c.stopPct ?? null, tpPct: c.tpPct ?? null,
      pnlPct: +Number(c.pnlPct).toFixed(2), win: c.pnlPct > 0 });
  }
  // Champions followers and Sentry Autopilot users: their results only, never who they are
  for (const p of S.champs.pos || []) {
    if (p.status !== "closed" || p.pnlEth == null || !(p.amountEth > 0) || !p.closedAt || have.has(`champ:${p.id}`)) continue;
    const f = coinAt(S, p.token, p.openedAt, null);
    out.push({ id: `champ:${p.id}`, source: "champions", book: "live", agent: `champions:${p.agent}`, agentName: `Followers of ${names[p.agent]?.name || AGENT_NAMES[p.agent] || p.agent}`, model: null, symbol: p.symbol || null, token: p.token,
      openedAt: p.openedAt, at: p.closedAt, heldMin: +((p.closedAt - p.openedAt) / 60_000).toFixed(1), exit: String(p.exit || "closed").slice(0, 60), ...f, pnlPct: +((p.pnlEth / p.amountEth) * 100).toFixed(2), win: p.pnlEth > 0 });
  }
  for (const p of S.auto.positions || []) {
    if (p.status !== "closed" || p.pnlEth == null || !(p.amountEth > 0) || !p.closedAt || have.has(`auto:${p.id}`)) continue;
    const f = coinAt(S, p.token, p.openedAt, p.raisedAtEntry ?? null);
    out.push({ id: `auto:${p.id}`, source: "autopilot", book: p.mode === "live" ? "live" : "paper", agent: "autopilot", agentName: "Sentry Autopilot users", model: null, symbol: p.symbol || null, token: p.token,
      openedAt: p.openedAt, at: p.closedAt, heldMin: +((p.closedAt - p.openedAt) / 60_000).toFixed(1), exit: p.reason || "closed", ...f,
      stopPct: p.rules?.stopPct ?? null, takeProfitX: p.rules?.takeProfitX ?? null, pnlPct: +((p.pnlEth / p.amountEth) * 100).toFixed(2), win: p.pnlEth > 0 });
  }
  return out;
}

/* ---------- patterns ---------- */
const hourBucket = (t) => { const h = new Date(t).getUTCHours(); return h < 6 ? "00:00 to 06:00" : h < 12 ? "06:00 to 12:00" : h < 18 ? "12:00 to 18:00" : "18:00 to 24:00"; };
// key, label, the bucket of a lesson (null: not recorded, so not counted), and the words used in a sentence
export const PATTERNS = [
  { key: "age", label: "Coin age at entry", of: (l) => (l.ageMin == null ? null : l.ageMin < 10 ? "under 10 minutes" : l.ageMin < 60 ? "10 to 60 minutes" : l.ageMin < 360 ? "1 to 6 hours" : l.ageMin < 1440 ? "6 to 24 hours" : "over a day"),
    say: (b) => `entries on coins ${b} old` },
  { key: "raised", label: "ETH raised on the Pons curve at entry", of: (l) => (l.venue === "pool" ? "off the curve (in a pool)" : l.raisedEth == null ? null : l.raisedEth < 0.5 ? "under 0.5 ETH" : l.raisedEth < 1 ? "0.5 to 1 ETH" : l.raisedEth < 2 ? "1 to 2 ETH" : "2 ETH or more"),
    say: (b) => (b.startsWith("off") ? "entries on coins already off the curve" : `entries with ${b} raised on the curve`) },
  { key: "buyers", label: "Independent buyers (Sentry's count)", of: (l) => (l.buyers == null ? null : l.buyers < 10 ? "under 10" : l.buyers < 25 ? "10 to 24" : "25 or more"),
    say: (b) => `coins with ${b} independent buyers` },
  { key: "ring", label: "Ring Radar at entry", of: (l) => (l.source === "ant" ? null : l.ring === "red" ? "red" : l.ring === "amber" ? "amber" : "no flag"),
    say: (b) => (b === "no flag" ? "coins with no Ring Radar flag" : `coins Ring Radar flagged ${b}`) },
  { key: "gate", label: "Troya Gate note at entry", of: (l) => (l.gateNotes == null ? null : l.gateNotes.includes("depth") ? "a depth note (young curve or thin pool)" : l.gateNotes.length ? "another note" : "no note"),
    say: (b) => (b === "no note" ? "coins with no Gate note" : `coins with ${b} from the Gate`) },
  { key: "posted", label: "Sentry had posted it before the entry", of: (l) => (l.source === "arena" || l.source === "champions" || l.source === "autopilot" ? (l.sentryPosted ? "yes" : "no") : null),
    say: (b) => (b === "yes" ? "coins Sentry had already posted" : "coins Sentry had not posted yet") },
  { key: "stop", label: "Stop in the trader's rules", of: (l) => (l.source === "record" || l.stopPct == null ? null : l.stopPct <= 20 ? "20% or tighter" : l.stopPct <= 30 ? "21 to 30%" : "over 30%"),
    say: (b) => `trades with a stop of ${b}` },
  { key: "tp", label: "Take-profit in the trader's rules", of: (l) => (l.takeProfitX == null ? null : l.takeProfitX < 1.5 ? "under 1.5x" : l.takeProfitX <= 2 ? "1.5x to 2x" : "over 2x"),
    say: (b) => `trades with a take-profit ${b}` },
  { key: "hour", label: "Entry time (UTC)", of: (l) => (l.openedAt ? hourBucket(l.openedAt) : null), say: (b) => `entries made ${b} UTC` },
  { key: "watchfire", label: "Watchfire fired while held", of: (l) => (l.source === "arena" ? (l.watchfire ? "yes" : "no") : null), say: (b) => (b === "yes" ? "trades Watchfire fired on" : "trades Watchfire never fired on"), outcome: true },
  { key: "side", label: "Side", of: (l) => (l.source === "ant" ? l.side : null), say: (b) => `${b} calls` },
  { key: "lev", label: "Leverage", of: (l) => (l.source === "ant" && l.lev ? `${l.lev}x` : null), say: (b) => `calls at ${b}` },
];
const P = Object.fromEntries(PATTERNS.map((p) => [p.key, p]));

function wilsonLow(w, n) {
  if (!n) return null;
  const p = w / n, z2 = Z * Z;
  return (p + z2 / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function tally(list) {
  const n = list.length, wins = list.filter((l) => l.win).length, pn = list.map((l) => l.pnlPct).filter((x) => x != null);
  return { n, wins, losses: n - wins, winRate: n ? +(wins / n * 100).toFixed(1) : null, wilsonLow: n ? +(wilsonLow(wins, n) * 100).toFixed(1) : null,
    avgPnlPct: pn.length ? +(pn.reduce((a, b) => a + b, 0) / pn.length).toFixed(1) : null, medianPnlPct: pn.length ? +median(pn).toFixed(1) : null, enough: n >= MIN_N };
}
export function patternsOf(list, keys = PATTERNS.map((p) => p.key)) {
  const out = [];
  for (const k of keys) {
    const p = P[k], groups = new Map();
    for (const l of list) { const b = p.of(l); if (b == null) continue; if (!groups.has(b)) groups.set(b, []); groups.get(b).push(l); }
    if (groups.size < 1) continue;
    for (const [b, g] of groups) out.push({ key: k, label: p.label, bucket: b, ...tally(g), outcome: !!p.outcome });
  }
  return out;
}
// how much a bucket stands out from the base rate, weighted by its size: only buckets with n >= 5
function standouts(pats, base, keys) {
  return pats.filter((x) => x.enough && !x.outcome && (!keys || keys.includes(x.key)) && base != null)
    .map((x) => ({ ...x, score: Math.abs(x.winRate - base) * Math.sqrt(x.n) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}
const statLine = (x) => `${x.wins} win${x.wins === 1 ? "" : "s"} / ${x.losses} loss${x.losses === 1 ? "" : "es"} (n=${x.n}, ${x.winRate}% won${x.wins ? `, at least ${x.wilsonLow}% at 95% confidence` : ""}${x.avgPnlPct != null ? `, average ${x.avgPnlPct > 0 ? "+" : ""}${x.avgPnlPct}%` : ""})`;
// a Sentry call is not an entry: the same pattern words, said of calls
const sayOf = (key, bucket, src) => { const t = P[key].say(bucket); return src === "record" ? t.replace(/^entries (on|with|made)/, "calls $1").replace(/^trades /, "calls ") : t; };

/* ---------- the plain line of one lesson ---------- */
const ageText = (m) => (m < 1 ? "under a minute" : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)} h` : `${(m / 1440).toFixed(1)} days`);
const pct = (x) => `${x > 0 ? "+" : ""}${Number(x).toFixed(1)}%`;
const EXIT = { stop: "was stopped out", "take-profit": "took profit", time: "sold at its time limit", watchfire: "sold when Watchfire fired", "nothing left to sell": "found nothing left to sell" };
function describe(l) {
  if (l.source === "record") return `Sentry called $${l.symbol || "?"} (${l.venue === "pool" ? "in a pool" : "on its Pons curve"}${l.ageMin != null ? `, ${ageText(l.ageMin)} old` : ""}${l.buyers != null ? `, ${l.buyers} independent buyers` : ""}): ${pct(l.pnlPct)} after 24 h${l.peakX ? `, peak ${l.peakX}x` : ""}. ${l.win ? "A win." : "A miss."}`;
  if (l.source === "ant") return `${l.agentName} went ${l.side} ${l.lev}x on xyz:ANT and closed at the ${l.exit}${l.heldMin != null ? ` after ${ageText(l.heldMin)}` : ""}: ${pct(l.pnlPct)} on the stake. ${l.win ? "A win." : "A loss."}`;
  const who = l.source === "arena" ? `${l.agentName}${l.book === "live" ? " (real money)" : ""}` : l.agentName;
  const at = [l.ageMin != null ? `${ageText(l.ageMin)} after launch` : null, l.raisedEth != null ? `with ${l.raisedEth.toFixed(2)} ETH raised on the curve` : l.venue === "pool" ? "in its pool" : null].filter(Boolean).join(" ") +
    (l.ring && l.ring !== "none" ? ` (Ring Radar ${l.ring})` : "");
  return `${who} bought $${l.symbol || "?"}${at ? ` ${at}` : ""}, and ${EXIT[l.exit] || `closed (${l.exit})`} after ${ageText(l.heldMin || 0)}: ${pct(l.pnlPct)}. ${l.win ? "A win." : "A loss."}`;
}
// the takeaway: the pattern this lesson belongs to that stands out most, only when it has 5+ samples
function takeaway(l, scopeStats) {
  const s = scopeStats[scopeOf(l)];
  if (!s) return "";
  const mine = s.patterns.filter((x) => P[x.key].of(l) === x.bucket);
  const top = standouts(mine, s.overall.winRate)[0];
  if (!top) return " Too few similar trades yet to call a pattern.";
  const vs = top.winRate < s.overall.winRate ? "below" : "above";
  return ` Pattern: ${sayOf(top.key, top.bucket, l.source)} won ${top.wins} of ${top.n} (${top.winRate}%), ${vs} the ${s.overall.winRate}% average.`;
}
const scopeOf = (l) => (l.source === "arena" ? (l.book === "live" ? "arena-live" : "arena") : l.source);

async function llmLine(l, text) {
  if (process.env.PHOENIX_LLM !== "1") return null;
  const llm = await import("./llm.mjs");
  if (!llm.llmOn() || !(await llm.underCap())) return null;
  const out = await llm.ask({ system: "Rewrite this trading lesson as one plain English sentence of at most 30 words. Keep every number exactly. No advice, no emoji.", user: text, maxTokens: 120, temperature: 0.2 }).catch(() => "");
  const s = String(out || "").replace(/\s+/g, " ").trim();
  return s.length > 20 && s.length < 260 ? s : null;
}

/* ---------- stats for every scope ---------- */
const callWords = (s) => ({ ...s, patterns: s.patterns.map((x) => ({ ...x, label: x.label.replace(/at entry$/, "at the call").replace(/^Entry time/, "Call time") })) });
function scopes(lessons) {
  const by = (f) => lessons.filter(f);
  const mk = (list, keys) => ({ overall: tally(list), patterns: patternsOf(list, keys) });
  const COIN = ["age", "raised", "buyers", "ring", "gate", "posted", "stop", "tp", "hour", "watchfire"];
  return {
    arena: mk(by((l) => l.source === "arena" && l.book === "paper"), COIN),
    "arena-live": mk(by((l) => l.source === "arena" && l.book === "live"), COIN),
    record: callWords(mk(by((l) => l.source === "record"), ["age", "raised", "buyers", "ring", "hour"])),
    ant: mk(by((l) => l.source === "ant"), ["side", "lev", "hour"]),
    champions: mk(by((l) => l.source === "champions"), ["age", "raised", "ring", "posted", "hour"]),
    autopilot: mk(by((l) => l.source === "autopilot"), COIN),
  };
}

/* ---------- one pass: new closed trades and graded calls become lessons ---------- */
async function pass() {
  if (busy || !store) return;
  busy = true;
  try {
    const S = await sources();
    const cur = await store.readJson(FILE, {});
    const have = new Set((cur.lessons || []).map((l) => l.id));
    const since = cur.since || Date.now();
    const fresh = collect(S, have);
    if (fresh.length) {
      const all = [...(cur.lessons || []), ...fresh];
      const st = scopes(all);
      for (const l of fresh) {
        l.backfilled = l.at < since;
        l.fact = describe(l); l.takeaway = takeaway(l, st).trim();
        const text = `${l.fact}${l.takeaway ? ` ${l.takeaway}` : ""}`;
        const better = !l.backfilled ? await llmLine(l, text).catch(() => null) : null;
        l.lesson = better || text; l.lessonBy = better ? "llm" : "template"; l.writtenAt = Date.now();
      }
      await store.update(FILE, {}, (d) => {
        d.since ||= since;
        const ids = new Set((d.lessons || []).map((l) => l.id));
        d.lessons = [...(d.lessons || []), ...fresh.filter((l) => !ids.has(l.id))].sort((a, b) => a.at - b.at).slice(-KEEP);
        d.updatedAt = Date.now();
        return d;
      });
      const bf = fresh.filter((l) => l.backfilled).length;
      console.log(`[phoenix] ${fresh.length} new lesson(s)${bf ? `, ${bf} backfilled from history` : ""}`);
    } else if (!cur.since) await store.update(FILE, {}, (d) => { d.since ||= since; return d; });
    cache = null;
  } catch (e) { console.warn("[phoenix]", e.message); }
  finally { busy = false; }
}

/* ---------- B) what an agent is told before it decides ---------- */
// kind "arena": before an Arena AI trader writes its rules for the day; kind "ant": before an Anthropic Round call.
// Returns "" when there is nothing with 5+ samples to say. The text says plainly that it changes no limit.
export async function lessonBlock({ kind = "arena", agent, record = false } = {}) {
  if (!store) return "";
  const d = await store.readJson(FILE, {});
  const lessons = d.lessons || [];
  const st = scopes(lessons);
  const scope = kind === "ant" ? "ant" : "arena";
  const all = st[scope];
  const own = lessons.filter((l) => l.source === (kind === "ant" ? "ant" : "arena") && l.agent === agent && (kind === "ant" || l.book === "paper"));
  const ownPats = patternsOf(own, kind === "ant" ? ["side", "lev", "hour"] : ["age", "raised", "buyers", "ring", "gate", "posted", "stop", "tp", "hour"]);
  const ownBase = tally(own).winRate;
  const picks = [];
  for (const x of standouts(ownPats, ownBase)) { if (picks.length >= 3) break; picks.push({ ...x, who: "Your trades" }); }
  for (const x of standouts(all.patterns, all.overall.winRate)) {
    if (picks.length >= 5) break;
    if (picks.some((y) => y.key === x.key && y.bucket === x.bucket)) continue;
    picks.push({ ...x, who: kind === "ant" ? "All AI traders on ANT" : "All five AI traders" });
  }
  const last = own.slice(-3).reverse();
  if (!picks.length && !last.length) return "";
  const lines = [`What you learned (Phoenix: patterns from Troya's own graded results, n = the number of trades behind each; advisory only, your caps, budgets, the kill switch and Troya Gate do not change):`];
  if (all.overall.n) lines.push(`- Base rate: ${scope === "ant" ? "AI traders' ANT calls" : "AI traders' paper trades"}: ${statLine(all.overall)}.${own.length ? ` Yours: ${statLine(tally(own))}.` : ""}`);
  for (const x of picks.slice(0, 5)) lines.push(`- ${x.who}, ${P[x.key].say(x.bucket)}: ${statLine(x)}.`);
  if (last.length) lines.push(`Your last lessons: ${last.map((l, i) => `${i + 1}) ${l.fact || l.lesson}`).join(" ")}`);
  const text = lines.join("\n");
  if (record) await store.update(FILE, {}, (x) => { x.injections = [{ at: Date.now(), kind, agent, chars: text.length }, ...(x.injections || [])].slice(0, 200); return x; }).catch(() => {});
  return text;
}

/* ---------- the public view ---------- */
const pubLesson = (l) => ({ id: l.id, at: l.at, openedAt: l.openedAt, source: l.source, book: l.book, agent: l.agent, agentName: l.agentName, symbol: l.symbol, token: l.token,
  pnlPct: l.pnlPct, win: l.win, exit: l.exit, heldMin: l.heldMin, ageMin: l.ageMin ?? null, ageSrc: l.ageSrc ?? null, raisedEth: l.raisedEth ?? null, buyers: l.buyers ?? null, ring: l.ring ?? null,
  gate: l.gateNotes == null ? null : l.gateNotes.length ? l.gateNotes : [], sentryPosted: l.sentryPosted ?? null, side: l.side, lev: l.lev, peakX: l.peakX ?? null,
  lesson: l.lesson, fact: l.fact || null, takeaway: l.takeaway || null, lessonBy: l.lessonBy, backfilled: !!l.backfilled });
async function buildView() {
  const d = await store.readJson(FILE, {});
  const lessons = d.lessons || [];
  const st = scopes(lessons);
  const arenaAgents = [...new Set(lessons.filter((l) => l.source === "arena").map((l) => l.agent))];
  const agents = [];
  for (const id of arenaAgents) {
    const mine = lessons.filter((l) => l.source === "arena" && l.agent === id), paper = mine.filter((l) => l.book === "paper"), live = mine.filter((l) => l.book === "live");
    const exits = {};
    for (const l of paper) exits[l.exit] = (exits[l.exit] || 0) + 1;
    agents.push({ id, name: mine[0].agentName, model: mine.at(-1).model, paper: tally(paper), live: tally(live), exits,
      patterns: patternsOf(paper, ["age", "raised", "buyers", "ring", "gate", "posted", "stop", "tp", "hour", "watchfire"]), wouldTell: await lessonBlock({ kind: "arena", agent: id }) });
  }
  agents.sort((a, b) => (b.paper.winRate ?? -1) - (a.paper.winRate ?? -1));
  const antAgents = [...new Set(lessons.filter((l) => l.source === "ant").map((l) => l.agent))].map((id) => {
    const mine = lessons.filter((l) => l.source === "ant" && l.agent === id);
    return { id, name: mine[0].agentName, overall: tally(mine) };
  });
  const corrections = await botLessons().catch(() => []);
  const count = (f) => lessons.filter(f).length;
  const inject = INJECT();
  return {
    mode: inject ? "inject" : "shadow", inject,
    note: inject ? "Live: before they decide, the Arena's AI traders and the Anthropic Round read a short \"What you learned\" block built from these stats. It is advice in their prompt; caps, budgets, the kill switch and Troya Gate are unchanged."
      : "Shadow mode: lessons are recorded and shown; agents don't use them yet. No prompt, rule, cap or trade changes.",
    since: d.since || null, updatedAt: d.updatedAt || null,
    totals: { lessons: lessons.length, backfilled: count((l) => l.backfilled), live: count((l) => !l.backfilled),
      bySource: { arena: count((l) => l.source === "arena"), record: count((l) => l.source === "record"), ant: count((l) => l.source === "ant"), champions: count((l) => l.source === "champions"), autopilot: count((l) => l.source === "autopilot") } },
    rules: `A lesson is written when a trade closes or a Sentry call is graded at 24 hours. A win is a trade closed in profit (a call: higher after 24 h than at the call). Each pattern shows its sample size n and a Wilson lower bound: the win rate it is at least, with 95% confidence. A pattern is never claimed with fewer than ${MIN_N} trades. Features come from what Troya stored at the time; one that was not stored is left out, never guessed. Arena patterns use the paper book (every AI trader takes every trade there); the real-money book is shown on its own. Backfilled lessons were rebuilt from history when Phoenix started.`,
    arena: { paper: st.arena.overall, live: st["arena-live"].overall, patterns: st.arena.patterns, agents },
    sentry: { overall: st.record.overall, patterns: st.record.patterns },
    antRound: { overall: st.ant.overall, patterns: st.ant.patterns, agents: antAgents },
    followers: { champions: st.champions.overall.n ? st.champions.overall : null, autopilot: st.autopilot.overall.n ? st.autopilot.overall : null },
    recent: lessons.slice().sort((a, b) => b.at - a.at).slice(0, 60).map(pubLesson),
    injections: inject ? (d.injections || []).slice(0, 20) : [],
    corrections: corrections.map((c) => ({ at: c.at, wrong: c.wrong, right: c.right, source: c.source })),
  };
}
export async function phoenixView() {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  const v = await buildView();
  cache = { at: Date.now(), v };
  return v;
}

export async function register(r, ctx) {
  store = ctx.store; dataDir = ctx.dataDir;
  await seedBot().catch((e) => console.warn("[phoenix] seed:", e.message));
  r.get("/api/phoenix", () => phoenixView(), { weight: 1 });
  if (process.env.PHOENIX === "0") return;
  setTimeout(() => pass().catch(() => {}), 60_000).unref?.();
  setInterval(() => pass().catch(() => {}), TICK).unref?.();
}
// for a local run against a copy of the data (no server needed)
export const _test = { collect, describe, takeaway, scopes, wilsonLow, pass, sayOf, init: (s, dir) => { store = s; dataDir = dir; ringIdx = null; cache = null; }, seedBot, SEED };
