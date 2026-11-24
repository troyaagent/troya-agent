// Community chat inside the app (community request, 21 Nov 2026): people talk without leaving troya.codes.
// Reading is public. Posting needs the wallet sign-in (the troya_sid cookie from /api/auth/verify; API tokens and the
// Agent Wallet cannot post), so every message is written by a person behind a signed-in wallet. Troya's bots never post
// here, and a message that speaks as Troya, its bots or the team is refused.
// The same rules as the Telegram group (tgmod.mjs: shilling, call channels, paid promo, DM asks, fake migrations, look-alike
// bots, blacklisted services; community.mjs: sales pitches), plus: no links except troya.codes, no @handles but ours,
// at most 280 characters. A refused message is a strike; 3 strikes in 24 hours mute the wallet for 24 hours, and a plain
// scam (score 6+) mutes it for 7 days. Admins (X_ADMINS, else TROYA_ADMINS, plus CHAT_ADMINS) remove messages and ban wallets.
//   GET    /api/chat?since=<seq>    public: new messages and removals since seq (no seq: the latest 60), and who you are
//                                     (each message: name = profile username, else @X handle, else short address; avatar = profile picture or null)
//   POST   /api/chat                { text }                       signed in
//   DELETE /api/chat/:id                                           admin: remove one message
//   POST   /api/chat/ban            { address, hours?, reason?, purge? }  admin: no hours = until unbanned; purge removes their messages
//   POST   /api/chat/unban          { address }                    admin
//   GET    /api/chat/bans                                          admin
// Stored in data/chat.json (the newest 400 messages, removals, bans and the moderation log).
import { HttpError } from "./api.mjs";
import { getSession, requireSession, normAddress } from "./auth.mjs";
import { score, fold, BLACKLIST } from "./tgmod.mjs";
import { looksLikePitch } from "./community.mjs";

const FILE = "chat.json";
export const MAX_LEN = 280;
const MAX_LINES = 6, KEEP = 400, PAGE = 60, MAX_SINCE = 200, KEEP_REMOVED = 400, KEEP_LOG = 300;
const GAP_MS = 5_000, PER_MIN = 6, PER_HOUR = 60;                        // per wallet
const STRIKE_MS = 24 * 3600e3, STRIKES_TO_MUTE = 3, AUTO_MUTE_MS = 24 * 3600e3, SEVERE_MUTE_MS = 7 * 86400e3;
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const admins = () => [...new Set(`${process.env.X_ADMINS || process.env.TROYA_ADMINS || ""},${process.env.CHAT_ADMINS || ""}`.split(",").map((a) => lc(a.trim())).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
export const isAdminAddr = (a) => admins().includes(lc(a));
const requireAdmin = (req) => { const s = requireSession(req); if (!isAdminAddr(s.address)) throw new HttpError(403, "Admins only."); return s; };

/* ---------- the text rules (pure, exported for tests) ---------- */
/** Control, zero-width and direction characters out, spaces folded, at most two blank lines in a row. */
export function cleanText(raw) {
  let t = String(raw ?? "").normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/[\t  - 　]+/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = t.split("\n");
  if (lines.length > MAX_LINES) t = [...lines.slice(0, MAX_LINES - 1), lines.slice(MAX_LINES - 1).join(" ")].join("\n");
  return t;
}
const OWN_HOST = /^(?:www\.)?troya\.codes$/i;
const OWN_HANDLES = /^(?:troyaagent|troyasentry|trojantroya_bot)$/i;
// written links: with a scheme, starting www., or a bare domain ("pump.fun", "t.me/x", "claim-drop.xyz/abc")
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?::\d{2,5})?(?:[/?#][^\s<>"']*)?/gi;
// spelled out to slip past filters: "site dot com", "site[.]xyz", "t . me / group"
const DOTTED = /\b[a-z0-9-]{2,}\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+|\s+\.\s+)\s*(?:com|io|xyz|net|org|app|me|gg|co|fun|site|online|top|link|live|pro|vip|finance|claims?|ai|sh|so|cc|ly|to|ru|cn)\b|\bt\s*\.\s*me\s*\/|\bdiscord\s*\.\s*gg\b/i;
// A bare domain (no scheme, no www.) counts as a link when it ends in a two-letter country code or one of these endings,
// so a missing space ("done.thanks", "Node.js") is not refused as a link
const TLDS = new Set(("com net org io xyz app dev me gg co ai fun site online top link live pro vip finance claims claim info biz club shop store tech " +
  "space website world today click cash money network exchange trade capital fund global group digital cloud codes family sh so cc ly to ws la su " +
  "one win bet games game wtf lol meme news blog page social chat email support help services agency events tokens token coin coins crypto bot bio " +
  "ink tel mobi name zone city earth land life plus run xxx art wiki gold rich fyi icu cyou cfd sbs rest bond lat buzz monster quest bar pw").split(" "));
const NOT_LINK = /^(?:js|mjs|ts|json|md|txt|png|jpe?g|gif|svg|pdf|csv|eth|sol|btc)$/i;
export function linksIn(text) {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const raw = m[0].replace(/[),.;:!?]+$/, "");
    let host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
    if (!host.includes(".")) continue;
    const bare = !/:\/\//.test(raw) && !/^www\./i.test(raw), tld = host.split(".").pop();
    if (bare && (/^\d+\./.test(host) || NOT_LINK.test(tld) || !(tld.length === 2 || TLDS.has(tld)))) continue;
    out.push({ raw, host, own: OWN_HOST.test(host) });
  }
  if (DOTTED.test(text)) out.push({ raw: "(spelled-out link)", host: "?", own: false });
  return out;
}
const SPEAKS_AS = /^\s*[[(<{]?\s*(?:troya(?:\s*(?:agent|bot|team|support|official|admin|sentry|ai))?|trojantroya|admin|administrator|moderator|mod|support|official|system|bot|announcement|team)\s*[\])>}]?\s*[:|>\-–—]/i;
const POSES = /\b(?:i\s*(?:am|'m)|this\s+is|here\s+is)\s+(?:the\s+)?(?:troya(?:\s*agent)?(?:\s*(?:bot|team|support|admin|ai))?|an?\s+admin|the\s+admin|the\s+(?:dev|team)|official\s+support)\b/i;
const REPEAT = /(.)\1{14,}/u;
/** null when the text may be posted, else { why, strike, severe }. The team (admins) may speak as the team. */
export function judge(text, { team = false } = {}) {
  if (!text) return { why: "Write something first.", strike: false };
  if ([...text].length > MAX_LEN) return { why: `Keep it to ${MAX_LEN} characters.`, strike: false };
  if (REPEAT.test(text)) return { why: "Too many repeated characters.", strike: false };
  const t = fold(text);
  const links = linksIn(t);
  if (links.some((l) => !l.own)) return { why: "Links are not allowed here, except troya.codes.", strike: true };
  const handles = [...t.matchAll(/(?:^|[^\w@])@([A-Za-z0-9_]{3,32})\b/g)].map((x) => x[1]).filter((x) => !OWN_HANDLES.test(x));
  if (handles.length) return { why: "No @handles here, except @Troyaagent and @troyasentry.", strike: true };
  if (!team && (SPEAKS_AS.test(t) || POSES.test(t))) return { why: "Messages can't speak as Troya, its bots or the team.", strike: true };
  const v = score(t);
  if (v >= 6) return { why: "This reads like a scam. It was not posted.", strike: true, severe: true };
  if (v >= 2 || BLACKLIST.test(t) || looksLikePitch({ message: t })) return { why: "This reads like promotion, a DM ask or a scam. Promotions and offers are not allowed here.", strike: true };
  return null;
}

/* ---------- state ---------- */
let store = null, saveT = null;
let S = { seq: 0, messages: [], removed: [], bans: {}, log: [] };
const recent = new Map();     // wallet → post times (last hour)
const strikes = new Map();    // wallet → refused-message times (last 24 h)
function save(now = false) {
  if (!store) return Promise.resolve();
  if (now) { clearTimeout(saveT); saveT = null; return store.writeJson(FILE, S); }
  if (saveT) return Promise.resolve();
  saveT = setTimeout(() => { saveT = null; store.writeJson(FILE, S).catch((e) => console.warn("[chat] save:", e.message)); }, 1500);
  saveT.unref?.();
  return Promise.resolve();
}
function banOf(a) {
  const b = S.bans[lc(a)];
  if (!b) return null;
  if (b.until && b.until <= Date.now()) { delete S.bans[lc(a)]; return null; }
  return b;
}
function logMod(entry) { S.log.push({ at: Date.now(), ...entry }); if (S.log.length > KEEP_LOG) S.log.splice(0, S.log.length - KEEP_LOG); }
function removeMsg(m, by) {
  const i = S.messages.indexOf(m);
  if (i < 0) return false;
  S.messages.splice(i, 1);
  S.removed.push({ id: m.id, seq: ++S.seq, at: Date.now() });
  if (S.removed.length > KEEP_REMOVED) S.removed.splice(0, S.removed.length - KEEP_REMOVED);
  logMod({ action: "remove", by, id: m.id, from: m.from, text: m.text.slice(0, 120) });
  return true;
}
function strike(a) {
  const now = Date.now(), l = (strikes.get(a) || []).filter((t) => now - t < STRIKE_MS);
  l.push(now); strikes.set(a, l);
  if (strikes.size > 5000) strikes.delete(strikes.keys().next().value);
  return l.length;
}
function mute(a, ms, why) {
  S.bans[a] = { until: Date.now() + ms, by: "auto", at: Date.now(), why, auto: true };
  logMod({ action: "mute", by: "auto", target: a, until: S.bans[a].until, why });
}
// The name shown: the wallet's profile username (server/profile.mjs), else its linked X handle, else the short address; the
// profile picture rides along. Both are read when the message is served, not when it was posted, so a rename or an admin
// reset of a profile reaches every message already in the chat.
let prof = null;   // profile.mjs, loaded in register (not imported at the top: profile.mjs imports this file for its text rules)
const view = (m) => {
  const c = prof?.cardOf?.(m.from) || null;
  return { id: m.id, at: m.at, from: m.from, name: c?.username || (m.x ? `@${m.x}` : short(m.from)), user: c?.username || null, avatar: c?.avatar || null,
    x: m.x || null, holder: !!m.holder, ...(m.guard ? { guard: true } : {}), ...(m.stake ? { stake: m.stake } : {}), team: isAdminAddr(m.from), text: m.text };
};
function meOf(req) {
  const s = getSession(req);
  if (!s) return null;
  const b = banOf(s.address);
  return { address: s.address, admin: isAdminAddr(s.address), profile: prof?.cardOf?.(s.address) || null, muted: b ? { until: b.until || null, why: b.auto ? b.why : "Banned by an admin" } : null };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref?.())]);

export async function register(r, ctx) {
  store = ctx.store;
  prof = await import("./profile.mjs").catch((e) => { console.warn("[chat] profiles unavailable:", e.message); return null; });
  const saved = await store.readJson(FILE, null);
  if (saved && Array.isArray(saved.messages)) S = { seq: Number(saved.seq) || 0, messages: saved.messages, removed: saved.removed || [], bans: saved.bans || {}, log: saved.log || [] };

  r.get("/api/chat", ({ req, query }) => {
    const since = Math.max(0, Math.floor(Number(query.since) || 0));
    const me = meOf(req);
    const rules = { maxLen: MAX_LEN, gapS: GAP_MS / 1000 };
    // a first load, a client ahead of the server (data reset) or one far behind starts again from the latest page
    const fresh = since && since <= S.seq ? S.messages.filter((m) => m.seq > since) : null;
    if (!fresh || fresh.length > MAX_SINCE) return { reset: true, seq: S.seq, messages: S.messages.slice(-PAGE).map(view), removed: [], me, rules };
    return { seq: S.seq, messages: fresh.map(view), removed: S.removed.filter((x) => x.seq > since).map((x) => x.id), me, rules };
  }, { perMin: 120 });

  r.post("/api/chat", async ({ req, body }) => {
    const s = requireSession(req);
    const a = lc(s.address);
    if (typeof body?.text !== "string") throw new HttpError(400, "Send { text }.");
    const b = banOf(a);
    if (b) throw new HttpError(403, b.until ? `You can't post here until ${new Date(b.until).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "This wallet can't post here.", { muted: { until: b.until || null } });
    const now = Date.now();
    const times = (recent.get(a) || []).filter((t) => now - t < 3600e3);
    if (times.length && now - times[times.length - 1] < GAP_MS) throw new HttpError(429, "One message every few seconds, please.");
    if (times.filter((t) => now - t < 60e3).length >= PER_MIN) throw new HttpError(429, "That's a lot of messages in a minute. Take a breath.");
    if (times.length >= PER_HOUR) throw new HttpError(429, "Hourly message limit reached. Try again later.");
    const text = cleanText(body.text);
    const bad = judge(text, { team: isAdminAddr(a) });
    if (bad) {
      if (bad.strike && !isAdminAddr(a)) {
        const n = strike(a);
        if (bad.severe) mute(a, SEVERE_MUTE_MS, "A message read as a scam");
        else if (n >= STRIKES_TO_MUTE) mute(a, AUTO_MUTE_MS, `${n} refused messages in 24 hours`);
        if (bad.severe || n >= STRIKES_TO_MUTE) await save(true);
      }
      throw new HttpError(400, bad.why);
    }
    const key = fold(text).toLowerCase().replace(/\s+/g, " ");
    if (S.messages.slice(-80).some((m) => lc(m.from) === a && now - m.at < 30 * 60e3 && fold(m.text).toLowerCase().replace(/\s+/g, " ") === key)) throw new HttpError(409, "You just said that.");
    times.push(now); recent.set(a, times);
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
    // shown next to the name: a linked X handle (Sign in with X), the 1M $TROYA holder mark, the King's Guard mark and the $TROYA staking tier
    // badge (only once the stake perks are on: server/stake.mjs badgeOf answers null before that), read once at post time
    const [x, h, sb] = await Promise.all([
      withTimeout(import("./xsocial.mjs").then((m) => m.handleOf(a)).catch(() => null), 2500),
      withTimeout(import("./holders.mjs").then((m) => m.holderOf(a)).catch(() => null), 3000),
      withTimeout(import("./stake.mjs").then((m) => m.badgeOf(a)).catch(() => null), 3000)]);
    const m = { id: ++S.seq, seq: S.seq, at: now, from: normAddress(a), text, x: /^[A-Za-z0-9_]{1,15}$/.test(x?.username || "") ? x.username : null, holder: !!h?.holder };
    if (/^(bronze|silver|gold)$/.test(sb || "")) m.stake = sb;
    // King's Guard (50,000,000 $TROYA, server/treasury.mjs), from the same balance read as the holder mark
    if (h && (await import("./treasury.mjs").then((t) => t.isGuardBalance(h.balance)).catch(() => false))) m.guard = true;
    S.messages.push(m);
    if (S.messages.length > KEEP) S.messages.splice(0, S.messages.length - KEEP);
    save();
    return { message: view(m), seq: S.seq };
  }, { perMin: 30, maxBody: 4096 });

  r.del("/api/chat/:id", async ({ req, params }) => {
    const s = requireAdmin(req);
    const m = S.messages.find((x) => String(x.id) === String(params.id));
    if (!m) throw new HttpError(404, "That message is gone already.");
    removeMsg(m, s.address);
    await save(true);
    return { ok: true, seq: S.seq };
  }, { perMin: 60 });

  r.post("/api/chat/ban", async ({ req, body }) => {
    const s = requireAdmin(req);
    const a = lc(normAddress(body?.address));
    if (isAdminAddr(a)) throw new HttpError(400, "Admins can't be banned here.");
    const hours = body?.hours == null || body.hours === "" ? null : Number(body.hours);
    if (hours != null && !(hours > 0 && hours <= 24 * 365)) throw new HttpError(400, "Hours must be between 1 and 8760, or left out for a ban until lifted.");
    const why = String(body?.reason || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 140) || null;
    S.bans[a] = { until: hours ? Date.now() + hours * 3600e3 : null, by: s.address, at: Date.now(), why, auto: false };
    let purged = 0;
    if (body?.purge !== false) for (const m of S.messages.filter((x) => lc(x.from) === a)) if (removeMsg(m, s.address)) purged++;
    logMod({ action: "ban", by: s.address, target: a, until: S.bans[a].until, why, purged });
    await save(true);
    return { ok: true, address: normAddress(a), until: S.bans[a].until, purged, seq: S.seq };
  }, { perMin: 30 });

  r.post("/api/chat/unban", async ({ req, body }) => {
    const s = requireAdmin(req);
    const a = lc(normAddress(body?.address));
    const had = !!S.bans[a];
    delete S.bans[a];
    strikes.delete(a);
    logMod({ action: "unban", by: s.address, target: a });
    await save(true);
    return { ok: true, lifted: had };
  }, { perMin: 30 });

  r.get("/api/chat/bans", ({ req }) => {
    requireAdmin(req);
    for (const a of Object.keys(S.bans)) banOf(a);
    return { bans: Object.entries(S.bans).map(([address, b]) => ({ address, ...b })), log: S.log.slice(-60).reverse() };
  }, { perMin: 60 });
}

// tests only
export const _test = { state: () => S, reset: () => { S = { seq: 0, messages: [], removed: [], bans: {}, log: [] }; recent.clear(); strikes.clear(); } };
