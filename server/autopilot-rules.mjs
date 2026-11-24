// Sentry Autopilot: optional extra rules (community request, 24 Nov 2026). A trader's own routine for a new launch: the CA on
// Pons is the one the coin's own X account posted, that X account is verified and its site works, the dev did not sell in
// the first minute; then a fixed $10 with his own stop and take-profit. Every rule here is OFF by default: a user who never
// switches one on gets exactly the Autopilot of before. The checks only ever say no; they never buy anything themselves.
//   devEarly  skip when the dev or the wallets tied to it (devlinks.mjs: coins or ETH moved with the dev, its small funders,
//             clusters) SOLD more than devEarlyPct % of what the dev side got, within the first devEarlyMin minutes after
//             the launch (defaults 1 min, 0 % = any sale). Coins passed between dev-side wallets and burns are not sales; a
//             sale is coins going to a market (the Pons curve, a pool, a router). Asked before the window has passed (or
//             before the chain read covers it), the answer is WAIT: Autopilot looks again after the window, never buys early.
//   siteUp    the website on the coin's Pons profile answers HTTP 200 within 5 seconds (public addresses only, at most
//             3 redirects). Nothing more is judged about the site.
//   xCheck    the X link on the coin's Pons profile (socials.twitter) is an account, that account has a verified badge
//             (blue, business or government), and it shows the coin's full contract address in its bio, its pinned post
//             or one of its 5 newest posts. One X user lookup per coin (badge, bio and pinned post in one read); the newest
//             posts only when the address is in neither. Cached per coin and shared by every user. Over any budget (X's own
//             daily caps in xsocial.mjs, or Autopilot's share, AUTOPILOT_X_DAILY coins a day, default 30), nothing is read
//             and the rule FAILS CLOSED: no buy, with the reason in the activity and the DM.
//   buyUsd    buy a fixed dollar amount: converted to ETH at the live ETH price at the moment of the buy (market.mjs
//             getEthUsd). 0 = the ETH amount (buyEth) as before. The ETH it comes to must sit inside the usual 0.001 to
//             0.5 ETH per buy, or the coin is skipped (never silently resized).
// Order: the dev rule first (free chain reads, and it may say wait), then the site, then X (paid) last, and the first rule
// that fails ends it, so a coin that fails cheaply never spends an X read.
const lc = (s) => String(s || "").toLowerCase();
const clip = (s, n = 60) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const day = () => new Date().toISOString().slice(0, 10);

export const EXTRA_DEFAULTS = { xCheck: false, siteUp: false, devEarly: false, devEarlyMin: 1, devEarlyPct: 0, buyUsd: 0 };
export const EXTRA_LIMITS = { devEarlyMin: [1, 15], devEarlyPct: [0, 100], buyUsd: [0, 1000] };
export const BOOL_KEYS = ["xCheck", "siteUp", "devEarly"];
export const anyCheck = (r) => !!(r && (r.xCheck || r.siteUp || r.devEarly));
export const X_DAILY = Math.max(1, Number(process.env.AUTOPILOT_X_DAILY) || 30);
const SETTLE_MS = 20_000;             // after the window: new blocks and the log reader catch up before the dev side is read
const RUNNING_TRIES = 4;              // a dev-side read still running is asked again (45 s apart) this many times, then: no buy
const SITE_MS = 5_000;
const UA = "TroyaAutopilot/1.0 (+https://troya.codes)";

let store = null;
export function initRules(st) { store ||= st; }

// what the rules read, swappable in tests (tools/autopilot-rules-test.mjs mocks X, the chain and the site)
export const deps = {
  now: () => Date.now(),
  profile: async (token) => (await import("./robinhood.mjs")).ponsProfile(token),
  pons: async (token) => { const rh = await import("./robinhood.mjs"); return rh.ponsPublic(await rh.ponsState(token)); },
  xAccount: async (handle, needle) => (await import("./xsocial.mjs")).accountCheck(handle, needle),
  devLinks: async (token, opts) => (await import("./devlinks.mjs")).devLinks(token, opts),
  site: (url) => siteCheck(url),
  ethUsd: async () => (await import("./market.mjs")).getEthUsd(),
};
export function _setDeps(o) { Object.assign(deps, o); }
export function _reset() { profMemo.clear(); xMemo.clear(); siteMemo.clear(); xInflight.clear(); memBudget.day = ""; memBudget.n = 0; }

/* ---------- caches: per coin (X, profile) and per site ---------- */
const profMemo = new Map(), xMemo = new Map(), siteMemo = new Map(), xInflight = new Map();
const fresh = (m, k) => { const h = m.get(k); return h && deps.now() < h.until ? h.v : null; };
const keep = (m, k, v, ms) => { m.set(k, { v, until: deps.now() + ms }); if (m.size > 2000) m.delete(m.keys().next().value); return v; };
async function profileOf(token) {
  const k = lc(token), hit = fresh(profMemo, k);
  if (hit) return hit;
  const p = await deps.profile(token);
  return p ? keep(profMemo, k, p, 10 * 60_000) : null;
}

// an X account link: x.com/name, twitter.com/name, a post link x.com/name/status/…, or @name. Not x.com/i/communities, not a search
export function handleOf(link) {
  const s = String(link || "").trim();
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s) || /^@([A-Za-z0-9_]{1,15})$/.exec(s);
  return m && !/^(home|i|intent|share|search|explore|hashtag|settings|messages|notifications)$/i.test(m[1]) ? m[1] : null;
}

/* ---------- Autopilot's share of the X budget: coins looked up per day ---------- */
const memBudget = { day: "", n: 0 };
async function takeXBudget() {
  if (!store) { if (memBudget.day !== day()) { memBudget.day = day(); memBudget.n = 0; } if (memBudget.n >= X_DAILY) return false; memBudget.n++; return true; }
  let ok = false;
  await store.update("autopilot-x.json", {}, (u) => {
    if (u.day !== day()) { u.day = day(); u.n = 0; }
    if (u.n >= X_DAILY) return u;
    u.n++; ok = true; return u;
  });
  return ok;
}
export async function xBudgetToday() { const u = store ? await store.readJson("autopilot-x.json", {}) : memBudget; return { used: u.day === day() ? u.n || 0 : 0, of: X_DAILY }; }

/* ---------- the rules ---------- */
const line = (key, label, status, detail, extra = {}) => ({ key, label, status, detail, ...extra });
const LABEL = { devEarly: "Dev didn't sell early", siteUp: "Site up", xCheck: "X check", buyUsd: "Buy in USD" };

async function devRule(token, rules, born, attempt) {
  const N = rules.devEarlyMin, X = rules.devEarlyPct, now = deps.now();
  const rule = X > 0 ? `more than ${X}% of what it got` : "anything";
  const wait = (until, why) => line("devEarly", LABEL.devEarly, "wait", why, { waitUntil: Math.max(now + 5_000, until) });
  // the first look comes ~90 s after a launch: a longer window is waited out before anything is read
  if (born && now < born + N * 60_000 + SETTLE_MS) return wait(born + N * 60_000 + SETTLE_MS, `Waiting until the coin's first ${N} min have passed, then checking whether the dev side sold ${rule}`);
  let d = await deps.devLinks(token, { deep: true, waitMs: 25_000 }).catch((e) => ({ status: "unknown", reason: e.message }));
  const bornAt = d?.bornAt || born;
  const end = bornAt ? bornAt + N * 60_000 : null;
  if (end && now < end + SETTLE_MS) return wait(end + SETTLE_MS, `Waiting until the coin's first ${N} min have passed, then checking whether the dev side sold ${rule}`);
  // a report from before the window closed (cached by the Gate) is read again
  if (d && d.status !== "running" && d.status !== "unknown" && end && !(d.at >= end)) d = await deps.devLinks(token, { deep: true, waitMs: 25_000, fresh: true }).catch((e) => ({ status: "unknown", reason: e.message }));
  if (!d || d.status === "running" || (end && d.status !== "unknown" && !(d.at >= end))) {
    if (attempt + 1 < RUNNING_TRIES) return wait(now + 45_000, "Still reading the wallets tied to the dev; checking again in under a minute");
    return line("devEarly", LABEL.devEarly, "fail", "The wallets tied to the dev could not be read in time, so no buy without the check");
  }
  if (d.status === "unknown") return line("devEarly", LABEL.devEarly, "fail", `The wallets tied to the dev could not be read${d.reason ? ` (${clip(d.reason, 80)})` : ""}, so no buy without the check`);
  const set = d._set;
  if (!set?.sells || set.got == null || !end) return line("devEarly", LABEL.devEarly, "fail", "The dev side's early sales could not be measured, so no buy without the check");
  if (d.coverage?.partial) return line("devEarly", LABEL.devEarly, "fail", "The coin's trade history was too long to read in full, so the first minutes could not be checked");
  const early = set.sells.filter((s) => s.at && s.at <= end);
  const sold = early.reduce((a, s) => a + BigInt(s.v), 0n), got = BigInt(set.got);
  const pct = got > 0n ? Number((sold * 10_000n) / got) / 100 : sold > 0n ? 100 : 0;
  const who = early.some((s) => s.dev) ? (early.some((s) => !s.dev) ? "the dev and wallets tied to it" : "the dev") : "wallets tied to the dev";
  const linked = d.linked?.count || 0;
  const scope = `dev + ${linked} linked wallet${linked === 1 ? "" : "s"}`;
  if (sold > 0n && pct > X) return line("devEarly", LABEL.devEarly, "fail", `${who[0].toUpperCase()}${who.slice(1)} sold ${pct.toFixed(pct < 1 ? 2 : 1)}% of what the dev side got within the first ${N} min (${early.length} sale${early.length === 1 ? "" : "s"}; your limit: ${X > 0 ? `${X}%` : "no sale"})`, { soldPct: pct });
  return line("devEarly", LABEL.devEarly, "pass", sold > 0n ? `The dev side sold ${pct.toFixed(2)}% of what it got in the first ${N} min, within your ${X}% (${scope})` : `No sale by the dev side in the first ${N} min (${scope})`, { soldPct: pct });
}

export async function siteCheck(raw) {
  const { safeUrl } = await import("./projectcheck.mjs");
  const t0 = Date.now();
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await safeUrl(url);
    if (!u) return { ok: false, why: "address not allowed or not found" };
    const left = SITE_MS - (Date.now() - t0);
    if (left <= 0) return { ok: false, why: "no answer within 5 s" };
    let r;
    try { r = await fetch(u, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: AbortSignal.timeout(left) }); }
    catch (e) { return { ok: false, why: e?.name === "TimeoutError" ? "no answer within 5 s" : String(e?.cause?.code || e?.name || "unreachable") }; }
    r.body?.cancel?.().catch(() => {});
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), u).href; continue; }
    return { ok: r.status === 200, status: r.status, host: u.hostname, ms: Date.now() - t0 };
  }
  return { ok: false, why: "too many redirects" };
}
async function siteRule(prof) {
  const w = String(prof?.website || "").trim();
  if (!w) return line("siteUp", LABEL.siteUp, "fail", "The coin lists no website on Pons");
  const k = lc(w);
  let s = fresh(siteMemo, k);
  if (!s) { s = await deps.site(w).catch((e) => ({ ok: false, why: e.message })); keep(siteMemo, k, s, s.ok ? 5 * 60_000 : 2 * 60_000); }
  return s.ok ? line("siteUp", LABEL.siteUp, "pass", `${clip(s.host || w, 50)} answered 200${s.ms != null ? ` in ${(s.ms / 1000).toFixed(1)} s` : ""}`)
    : line("siteUp", LABEL.siteUp, "fail", `${clip(w, 50)} ${s.status ? `answered ${s.status}, not 200` : `did not answer (${s.why || "unreachable"})`}`);
}

async function xRule(token, prof) {
  const link = String(prof?.twitter || "").trim();
  if (!link) return line("xCheck", LABEL.xCheck, "fail", "The coin lists no X account on Pons");
  const handle = handleOf(link);
  if (!handle) return line("xCheck", LABEL.xCheck, "fail", `The coin's X link is not an account (${clip(link, 60)})`);
  const k = `${lc(token)}:${lc(handle)}`;
  const hit = fresh(xMemo, k);
  if (hit) return { ...hit, cached: true };
  if (xInflight.has(k)) return xInflight.get(k);
  const p = (async () => {
    const res = (status, detail, ms, extra = {}) => keep(xMemo, k, line("xCheck", LABEL.xCheck, status, detail, { handle, ...extra }), ms);
    if (!(await takeXBudget())) return res("fail", `Autopilot's X lookups for today are used up (${X_DAILY} coins), so no buy without the check`, 5 * 60_000, { capped: "autopilot" });
    const a = await deps.xAccount(handle, lc(token)).catch((e) => ({ error: e.message }));
    if (a?.capped) return res("fail", a.capped === "users" ? "Troya's daily X lookups are used up, so no buy without the check" : `@${handle}: Troya's daily X reads are used up, so no buy without the check`, 5 * 60_000, { capped: a.capped });
    if (!a || a.error) return res("fail", `X could not be read${a?.error ? ` (${clip(a.error, 80)})` : ""}, so no buy without the check`, 2 * 60_000);
    if (a.notFound) return res("fail", `@${handle} was not found on X`, 60 * 60_000);
    if (!a.verified) return res("fail", `@${a.handle || handle} has no verified badge on X`, 6 * 3600_000);
    if (!a.where) {
      if (a.capped === "reads") return res("fail", `@${a.handle} is verified, but its bio and pinned post do not show this coin's contract address, and Troya's daily X reads are used up, so its newest posts were not read`, 5 * 60_000, { capped: "reads" });
      return res("fail", `@${a.handle} is verified, but ${a.protected ? "its posts are protected and its bio and pinned post do not" : "its bio, pinned post and 5 newest posts do not"} show this coin's contract address`, 10 * 60_000);
    }
    return res("pass", `@${a.handle} is verified (${a.verifiedType || "blue"}) and shows this coin's contract address in its ${a.where}`, 6 * 3600_000);
  })().finally(() => xInflight.delete(k));
  xInflight.set(k, p);
  return p;
}

/**
 * The extra rules for one coin and one user's rules → { verdict: "pass" | "fail" | "wait", checks, waitUntil }.
 * born: the launch time in ms when known (Sentry's first sight of it); attempt: how many times this coin was looked at
 * already for this user (a dev-side read still running is asked again a few times, then fails closed).
 */
export async function evaluate(r, rules, { born = null, attempt = 0 } = {}) {
  const checks = [];
  const notRun = () => {
    for (const k of ["devEarly", "siteUp", "xCheck"]) if (rules[k] && !checks.some((c) => c.key === k)) checks.push(line(k, LABEL[k], "not-run", "Not checked: an earlier rule already said no"));
  };
  if (rules.devEarly) {
    const d = await devRule(r.token, rules, born, attempt);
    checks.push(d);
    if (d.status === "wait") { for (const k of ["siteUp", "xCheck"]) if (rules[k]) checks.push(line(k, LABEL[k], "not-run", "Checked once the wait is over")); return { verdict: "wait", checks, waitUntil: d.waitUntil }; }
    if (d.status !== "pass") { notRun(); return { verdict: "fail", checks }; }
  }
  if (rules.siteUp || rules.xCheck) {
    const prof = await profileOf(r.token).catch(() => null);
    if (!prof) {
      for (const k of ["siteUp", "xCheck"]) if (rules[k]) checks.push(line(k, LABEL[k], "fail", "The coin's Pons profile could not be read, so no buy without the check"));
      return { verdict: "fail", checks };
    }
    if (rules.siteUp) { const s = await siteRule(prof); checks.push(s); if (s.status !== "pass") { notRun(); return { verdict: "fail", checks }; } }
    if (rules.xCheck) { const x = await xRule(r.token, prof); checks.push(x); if (x.status !== "pass") return { verdict: "fail", checks }; }
  }
  return { verdict: "pass", checks };
}

/** The ETH a dollar buy comes to now → { ok, eth, px, check } (check: a line for the activity and the DM). */
export async function usdToEth(usd, [lo, hi]) {
  const px = await deps.ethUsd().catch(() => null);
  if (!(px > 0)) return { ok: false, check: line("buyUsd", LABEL.buyUsd, "fail", `The live ETH price could not be read, so the $${usd} buy was not sized`) };
  const eth = Math.round((usd / px) * 1e6) / 1e6;
  if (eth < lo || eth > hi) return { ok: false, px, eth, check: line("buyUsd", LABEL.buyUsd, "fail", `$${usd} is ${eth} ETH at $${px.toFixed(0)} per ETH, outside the ${lo} to ${hi} ETH a buy may be`) };
  return { ok: true, px, eth, check: line("buyUsd", LABEL.buyUsd, "pass", `$${usd} = ${eth} ETH at $${px.toFixed(0)} per ETH`) };
}

/* ---------- Telegram: the extra rules in words, and their part of /autopilot set ---------- */
const DEV_KW = String.raw`(?:dev\s*-?\s*sell|devsell|dev\s*early|devearly)`;
/** Pulls the extra rules out of the text; returns { rules, rest } (rest: the text left for the usual rules). */
export function parseExtra(text) {
  let t = ` ${String(text || "").toLowerCase()} `;
  const out = {};
  const take = (re, fn) => { t = t.replace(re, (...m) => { fn(m); return " "; }); };
  take(/\b(?:x\s*-?\s*check|blue\s*-?\s*check)\s*(on|off)\b/g, (m) => { out.xCheck = m[1] === "on"; });
  take(/\b(?:site\s*-?\s*up|site|website)\s*(on|off)\b/g, (m) => { out.siteUp = m[1] === "on"; });
  take(new RegExp(String.raw`\b${DEV_KW}\b((?:\s+(?:on|off|within|in|first|\d+\s*(?:m|mins?|minutes?)\b|\d*\.?\d+\s*%))*)`, "g"), (m) => {
    const inner = m[1] || "";
    if (/\boff\b/.test(inner)) { out.devEarly = false; return; }
    out.devEarly = true;
    const mins = /(\d+)\s*(?:m|mins?|minutes?)\b/.exec(inner), pct = /(\d*\.?\d+)\s*%/.exec(inner);
    if (mins) out.devEarlyMin = Number(mins[1]);
    if (pct) out.devEarlyPct = Number(pct[1]);
  });
  // "buy $10", "$10 each", "buy 10 usd": a dollar size; "usd off" goes back to the ETH amount
  take(/(?:\b(?:buy|each|size)\s*)?\$\s*(\d*\.?\d+)(?:\s*(?:each|per\s*(?:coin|buy)))?/g, (m) => { out.buyUsd = Number(m[1]); });
  take(/(?:\b(?:buy|each|size)\s*)?(\d*\.?\d+)\s*(?:\$|\b(?:usd[cgt]?|dollars?)\b)(?:\s*each)?/g, (m) => { out.buyUsd = Number(m[1]); });
  take(/\busd\s*off\b/g, () => { out.buyUsd = 0; });
  return { rules: out, rest: t.trim() };
}
export function extraText(r) {
  const L = [];
  if (r.devEarly) L.push(`skip if the dev side sold ${r.devEarlyPct > 0 ? `more than ${r.devEarlyPct}% of what it got` : "anything"} in the first ${r.devEarlyMin} min`);
  if (r.siteUp) L.push("the coin's website must answer");
  if (r.xCheck) L.push("its X account must be verified and show the CA");
  return L;
}
