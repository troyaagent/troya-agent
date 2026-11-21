// Profiles (community request in Telegram, @lynx_evo, 21 Nov 2026: "profile feature: editable username, profile photo,
// banner photo, added in the Portfolio feature"). One profile per wallet: a username, a short bio, an avatar and a banner.
// Anyone can read a profile; only the wallet's own sign-in (the troya_sid cookie from /api/auth/verify) can change it, so
// API tokens and the Agent Wallet cannot. The Portfolio page shows it as a header, #/u/<username> and
// #/portfolio?address=0x… show anyone's, and the in-app chat (chat.mjs) shows the username and avatar instead of the
// short address, read when the message is served, so a rename or an admin reset reaches old messages too.
//
// The rules
//   · username: 3–20 letters, digits or _, unique ignoring case (the case you type is kept for display). Never one that
//     reads as Troya, its bots, its products or its staff ("troya", "admin", "official", "support", "mod", "team", "dev",
//     "@TrojanTroya_bot", "sentry", "tr0ya_supp0rt" …), never all digits, never "0x…" (it would pass for a wallet). Admins
//     (the team) are not held to the reserved words. A wallet sets its first name at any time and changes it at most once
//     every 7 days (a change of letter case only is free, and a typo can be fixed within 15 minutes of a change without
//     starting the 7 days again); a name it leaves stays held for it for 30 days, so nobody can
//     take a name the moment it is let go and speak under it.
//   · bio: at most 160 characters and 3 lines, no links except troya.codes, and the chat's own judge (chat.mjs: no
//     @handles but ours, no speaking as Troya or the team, no promotion, DM asks or scams).
//   · images: PNG, JPEG or WebP only, checked by their first bytes as well as their content-type; avatar ≤ 1 MB, banner
//     ≤ 2 MB. Each is decoded and re-encoded here by sharp (libvips): turned by its EXIF orientation, cropped to the centre
//     and resized to 256 × 256 (avatar) or 1500 × 500 (banner), written as WebP with every metadata block dropped (EXIF,
//     GPS, XMP, ICC, comments). Only that output is stored (data/profile-img/<sha256>.webp) and served, as image/webp with
//     nosniff and a sandbox CSP, never as HTML or SVG. The file name is the hash of its bytes: cached for a year, ETag = hash.
//   · limits: 5 changes an hour per wallet (a save of name + bio counts 1, each image 1; removing your own image is free),
//     20 image uploads a day; plus the per-IP limits on each route.
//   · admins (X_ADMINS, else TROYA_ADMINS) reset a profile (any of name, bio, avatar, banner), may block the name for good
//     and lock the wallet's edits for some days. Every reset is logged with who did it.
//
//   GET    /api/profile?address=0x… | ?u=<username>   public: { address, profile | null, badges }
//   GET    /api/profile/me                            signed in: your profile, your limits, the rules
//   GET    /api/profile/check?u=<username>            public: { ok, name } or { ok: false, why }
//   POST   /api/profile            { username?, bio? }  signed in ("" clears a field)
//   POST   /api/profile/avatar     image bytes          signed in, content-type image/png | image/jpeg | image/webp
//   POST   /api/profile/banner     image bytes          signed in
//   DELETE /api/profile/avatar | /api/profile/banner    signed in: remove your own
//   GET    /api/profile/img/:file                       public: <32 hex>.webp
//   POST   /api/profile/admin/reset { address, fields?: ["username","bio","avatar","banner"], block?, lockDays?, reason? }
//   POST   /api/profile/admin/unblock { username }      admin: a blocked name can be taken again
//   GET    /api/profile/admin/log                       admin: the latest resets, blocks and renames
// State: data/profiles.json { users: { <lowercase address>: profile }, names: { <lowercase name>: address },
// held: { <lowercase name>: { by, until } }, blocked: [names], log: [...] }.
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./api.mjs";
import { getSession, requireSession, normAddress } from "./auth.mjs";
import { cleanText, judge, isAdminAddr as isTeamAddr } from "./chat.mjs";

const FILE = "profiles.json", IMG_DIR = "profile-img";
export const RULES = { nameMin: 3, nameMax: 20, bioMax: 160, bioLines: 3, renameDays: 7, fixMinutes: 15, holdDays: 30, editsPerHour: 5, uploadsPerDay: 20 };
export const KINDS = {
  avatar: { max: 1024 * 1024, w: 256, h: 256, minW: 64, minH: 64, q: 84 },
  banner: { max: 2 * 1024 * 1024, w: 1500, h: 500, minW: 300, minH: 100, q: 80 },
};
const MAX_PIXELS = 30_000_000;                 // a bigger picture is refused before it is decoded (a "decompression bomb")
const RENAME_MS = RULES.renameDays * 86400e3, FIX_MS = RULES.fixMinutes * 60e3, HOLD_MS = RULES.holdDays * 86400e3, HOUR = 3600e3;
const KEEP_LOG = 300, BADGE_TTL = 10 * 60e3;
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => lc(a.trim())).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
export const isProfileAdmin = (a) => admins().includes(lc(a));
// the team may use the words the public may not (a Team badge sits next to their name anyway)
const isTeam = (a) => isProfileAdmin(a) || isTeamAddr(a);
const requireAdmin = (req) => { const s = requireSession(req); if (!isProfileAdmin(s.address)) throw new HttpError(403, "Admins only."); return s; };

/* ---------- the name rules (pure, exported for tests) ---------- */
// look-alike digits folded back to letters, so "tr0ya", "adm1n" and "5upport" read as what they spell
const LEET = { 0: "o", 1: "i", 2: "z", 3: "e", 4: "a", 5: "s", 6: "g", 7: "t", 8: "b", 9: "g" };
const fold = (s, one = "i") => lc(s).replace(/[0-9]/g, (d) => (d === "1" ? one : LEET[d]));
// anywhere in the name: Troya and its bots, and staff roles that are never a hobby
const BLOCK_IN = ["troya", "trojan", "admin", "official", "support", "moderat", "staff", "helpdesk", "customerservice", "customercare", "verified"];
// the whole name, or one part of it between underscores: short staff words and Troya's own names
const BLOCK_WORDS = new Set(("team mod mods dev devs developer bot bots system root owner founder cofounder ceo cto coo security sentry oracle herald aegis " +
  "council watchfire gate seal arena owl scepter flywheel registry hermes athena agamemnon cassandra odysseus mcp api null undefined anonymous anon " +
  "everyone here channel announcement announcements news help info contact service services moderation manager community airdrop giveaway claim " +
  "claims rewards refund refunds recovery wallet walletconnect metamask robinhood pons").split(" "));
// a staff word with a "real", "the" or "iam" in front, or numbers after: "realdev", "the_team", "mod2"
const STAFF_ISH = /^(?:the|real|iam|im|its|ur|your|our)?(?:team|mods?|devs?|developer|bots?|system|owner|founder|ceo)(?:team|s)?\d*$/;
/** null when `raw` may be a username, else the reason it may not. team: the reserved words do not apply. */
export function nameProblem(raw, { team = false } = {}) {
  const n = String(raw ?? "");
  if (n.length < RULES.nameMin || n.length > RULES.nameMax) return `A username is ${RULES.nameMin} to ${RULES.nameMax} characters.`;
  if (!/^[A-Za-z0-9_]+$/.test(n)) return "Use only letters, numbers and _ in a username.";
  if (/^\d+$/.test(n)) return "A username needs at least one letter.";
  if (/^0x[0-9a-f]{3,}/i.test(n)) return "A username can't look like a wallet address.";
  if (n.replace(/_/g, "").length < 2) return "A username needs at least two letters or numbers.";
  if (team) return null;
  // as typed, without the numbers at either end ("mod2", "1337dev"), and with look-alike digits read as letters
  const low = lc(n), variants = new Set();
  for (const b of new Set([low, low.replace(/\d+$/, ""), low.replace(/^\d+/, "")])) for (const v of [b, fold(b, "i"), fold(b, "l")]) if (v) variants.add(v);
  const RESERVED = "That username is reserved: it reads as Troya, its bots or its team.";
  for (const v of variants) {
    const flat = v.replace(/_/g, "");
    if (BLOCK_IN.some((w) => flat.includes(w)) || BLOCK_WORDS.has(flat) || STAFF_ISH.test(flat)) return RESERVED;
    for (const part of v.split("_").filter(Boolean)) if (BLOCK_WORDS.has(part) || BLOCK_WORDS.has(part.replace(/\d+$/, ""))) return RESERVED;
  }
  return null;
}
/** The bio as it will be stored, or throws an HttpError with the reason. */
export function cleanBio(raw, { team = false } = {}) {
  let t = cleanText(raw);
  const lines = t.split("\n");
  if (lines.length > RULES.bioLines) t = [...lines.slice(0, RULES.bioLines - 1), lines.slice(RULES.bioLines - 1).join(" ")].join("\n");
  if (!t) return "";
  if ([...t].length > RULES.bioMax) throw new HttpError(400, `Keep the bio to ${RULES.bioMax} characters.`);
  const bad = judge(t, { team });
  if (bad) throw new HttpError(400, bad.why.replace(/ here\b/, " in a bio").replace("It was not posted.", "It was not saved."));
  return t;
}

/* ---------- images ---------- */
const TYPES = { "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/pjpeg": "jpeg", "image/webp": "webp" };
/** "png" | "jpeg" | "webp" from the first bytes, else null (an SVG, HTML, GIF or anything else never gets past here). */
export function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP" && /^VP8[ LX]$/.test(buf.toString("latin1", 12, 16))) return "webp";
  return null;
}
let sharpLib;      // undefined: not tried yet · null: could not load (image uploads answer 503, names and bios still work)
async function getSharp() {
  if (sharpLib !== undefined) return sharpLib;
  try { sharpLib = (await import("sharp")).default; sharpLib.cache(false); }
  catch (e) { console.warn("[profile] sharp could not load, image uploads are off:", e.message); sharpLib = null; }
  return sharpLib;
}
// two images at a time at most: a burst of uploads queues instead of taking every core
let running = 0;
const waiting = [];
async function oneAtATime(fn) {
  if (running >= 2) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}
/** buf (as uploaded) → the WebP to store: { data, w, h }. Throws an HttpError a person can act on. */
export async function encodeImage(kind, buf, type) {
  const k = KINDS[kind];
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, "Send the image file itself (PNG, JPG or WebP).");
  if (buf.length > k.max) throw new HttpError(413, `The ${kind} is over ${k.max / 1048576} MB. Pick a smaller file.`);
  const said = TYPES[lc(String(type || "").split(";")[0].trim())];
  if (!said) throw new HttpError(415, "Use a PNG, JPG or WebP image.");
  const real = sniff(buf);
  if (!real || real !== said) throw new HttpError(415, "This file is not the PNG, JPG or WebP image it says it is.");
  const sharp = await getSharp();
  if (!sharp) throw new HttpError(503, "Image uploads are unavailable right now. Your name and bio can still be saved.");
  return oneAtATime(async () => {
    const opts = { failOn: "error", limitInputPixels: MAX_PIXELS, animated: false };
    let meta;
    try { meta = await sharp(buf, opts).metadata(); } catch { throw new HttpError(415, "This image could not be read. Try another PNG, JPG or WebP file."); }
    if (meta.format !== real) throw new HttpError(415, "This file is not the PNG, JPG or WebP image it says it is.");
    const w = meta.autoOrient?.width || meta.width || 0, h = meta.autoOrient?.height || meta.height || 0;
    if (w < k.minW || h < k.minH) throw new HttpError(422, `The ${kind} is too small: at least ${k.minW} × ${k.minH} pixels.`);
    let out;
    try {
      out = await sharp(buf, opts)
        .rotate()                                                   // EXIF orientation applied, then every metadata block is dropped
        .resize(k.w, k.h, { fit: "cover", position: "centre" })
        .webp({ quality: k.q, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
    } catch { throw new HttpError(415, "This image could not be read. Try another PNG, JPG or WebP file."); }
    if (out.info.format !== "webp" || out.info.width !== k.w || out.info.height !== k.h || sniff(out.data) !== "webp") throw new HttpError(500, "The image could not be processed.");
    return { data: out.data, w: k.w, h: k.h };
  });
}
const IMG_NAME = /^[0-9a-f]{32}\.webp$/;
const imgUrl = (id) => (id && IMG_NAME.test(id) ? `/api/profile/img/${id}` : null);

/* ---------- state ---------- */
let store = null;
const EMPTY = () => ({ v: 1, users: {}, names: {}, held: {}, blocked: [], log: [] });
let S = EMPTY();
const badgeMemo = new Map();      // address → { at, v }
const save = () => (store ? store.writeJson(FILE, S) : Promise.resolve());
const imgDir = () => join(store.dir, IMG_DIR);
function logIt(entry) { S.log.push({ at: Date.now(), ...entry }); if (S.log.length > KEEP_LOG) S.log.splice(0, S.log.length - KEEP_LOG); }
function heldFor(key, a, now = Date.now()) {
  const x = S.held[key];
  if (!x) return null;
  if (x.until <= now) { delete S.held[key]; return null; }
  return x.by && x.by === a ? null : x;      // a name you left is still yours to take back
}
/** "" when the name is free for wallet a, else why not */
function takenWhy(key, a) {
  if (S.blocked.includes(key)) return "That username is not available.";
  const owner = S.names[key];
  if (owner && owner !== a) return "That username is taken.";
  if (heldFor(key, a)) return "That username is not available right now.";
  return "";
}
function view(p) {
  if (!p) return null;
  return { address: p.address, username: p.username || null, bio: p.bio || "", avatar: imgUrl(p.avatar?.id), banner: imgUrl(p.banner?.id), joined: p.created || null, updated: p.updated || null };
}
/** what the chat and other pages show for a wallet: { username, avatar } or null. Synchronous (in memory). */
export function cardOf(address) {
  const p = S.users[lc(address)];
  if (!p || (!p.username && !p.avatar)) return null;
  return { username: p.username || null, avatar: imgUrl(p.avatar?.id) };
}
export const profileOf = (address) => view(S.users[lc(address)]);
export function addressOfName(name) { const a = S.names[lc(name)]; return a ? S.users[a]?.address || null : null; }

function limitsOf(p, a, now = Date.now()) {
  const edits = (p?.edits || []).filter((t) => now - t < HOUR);
  const renameAt = p?.nameAt && now - p.nameAt < RENAME_MS ? p.nameAt + RENAME_MS : null;
  const fixUntil = p?.nameAt && now - p.nameAt < FIX_MS ? p.nameAt + FIX_MS : null;
  return { editsPerHour: RULES.editsPerHour, editsLeft: Math.max(0, RULES.editsPerHour - edits.length), nextEditAt: edits.length >= RULES.editsPerHour ? edits[0] + HOUR : null,
    renameEveryDays: RULES.renameDays, renameAt, fixUntil, lockedUntil: p?.lockedUntil && p.lockedUntil > now ? p.lockedUntil : null, admin: isProfileAdmin(a) };
}
function mine(a) {
  const k = lc(a);
  return S.users[k] || null;
}
function ensure(address) {
  const k = lc(address);
  if (!S.users[k]) S.users[k] = { address: normAddress(address), username: null, bio: "", avatar: null, banner: null, created: Date.now(), updated: Date.now(), nameAt: null, edits: [], uploads: null, lockedUntil: null };
  return S.users[k];
}
// every edit passes here first: a locked wallet, and the 5-an-hour budget (consumed by the caller once something changed)
function mayEdit(a) {
  const p = mine(a), now = Date.now();
  if (p?.lockedUntil && p.lockedUntil > now) throw new HttpError(403, `An admin locked this profile until ${new Date(p.lockedUntil).toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  if (isProfileAdmin(a)) return;
  const edits = (p?.edits || []).filter((t) => now - t < HOUR);
  if (edits.length >= RULES.editsPerHour) throw new HttpError(429, `That is ${RULES.editsPerHour} profile changes this hour. Try again ${new Date(edits[0] + HOUR).toISOString().slice(11, 16)} UTC.`, { nextEditAt: edits[0] + HOUR });
}
function spend(p) { const now = Date.now(); p.edits = [...(p.edits || []).filter((t) => now - t < HOUR), now]; p.updated = now; }
async function dropFile(id) {
  if (!id || !IMG_NAME.test(id)) return;
  for (const p of Object.values(S.users)) if (p.avatar?.id === id || p.banner?.id === id) return;   // another profile has the same picture
  await unlink(join(imgDir(), id)).catch(() => {});
}
// a profile with nothing left in it is removed, so it neither shows as a profile nor holds anything
function tidy(k) {
  const p = S.users[k];
  if (p && !p.username && !p.bio && !p.avatar && !p.banner && !p.lockedUntil && !(p.edits || []).length && !p.nameAt) delete S.users[k];
}

/* ---------- badges: read from the modules that own them, at most every 10 minutes per wallet ---------- */
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref?.())]);
export async function badgesOf(address) {
  const k = lc(address);
  const hit = badgeMemo.get(k);
  if (hit && Date.now() - hit.at < BADGE_TTL) return hit.v;
  const [x, hold, stake, pass] = await Promise.all([
    withTimeout(import("./xsocial.mjs").then((m) => m.handleOf(k)).catch(() => null), 2500),
    withTimeout(import("./holders.mjs").then((m) => m.holderOf(k)).catch(() => null), 3500),
    withTimeout(import("./stake.mjs").then((m) => m.badgeOf(k)).catch(() => null), 3500),
    withTimeout(import("./votes.mjs").then((m) => m.passView(k)).catch(() => null), 3500)]);
  const v = {
    team: isTeamAddr(k),
    x: /^[A-Za-z0-9_]{1,15}$/.test(x?.username || "") ? x.username : null,
    holder: hold ? !!hold.holder : null,
    stake: /^(bronze|silver|gold)$/.test(stake || "") ? stake : null,
    pass: pass?.me?.active && Number(pass.me.passId) > 0 ? Number(pass.me.passId) : null,
  };
  badgeMemo.set(k, { at: Date.now(), v });
  if (badgeMemo.size > 5000) badgeMemo.delete(badgeMemo.keys().next().value);
  return v;
}

/* ---------- routes ---------- */
export async function register(r, ctx) {
  store = ctx.store;
  const saved = await store.readJson(FILE, null);
  if (saved && saved.users && typeof saved.users === "object") S = { ...EMPTY(), ...saved };
  await mkdir(imgDir(), { recursive: true });
  // files no profile points to (an upload replaced while the server stopped) are removed once an hour has passed
  (async () => {
    const used = new Set(Object.values(S.users).flatMap((p) => [p.avatar?.id, p.banner?.id]).filter(Boolean));
    for (const f of await readdir(imgDir()).catch(() => [])) {
      if (!IMG_NAME.test(f) || used.has(f)) continue;
      const s = await stat(join(imgDir(), f)).catch(() => null);
      if (s && Date.now() - s.mtimeMs > HOUR) await unlink(join(imgDir(), f)).catch(() => {});
    }
  })().catch(() => {});

  r.get("/api/profile", async ({ query }) => {
    let address = null;
    if (query.u != null && query.u !== "") {
      address = addressOfName(String(query.u).replace(/^@/, "").slice(0, 40));
      if (!address) throw new HttpError(404, "No profile has that username.");
    } else address = normAddress(query.address);
    const p = S.users[lc(address)];
    return { address, profile: view(p), badges: await badgesOf(address) };
  }, { perMin: 120 });

  r.get("/api/profile/me", async ({ req }) => {
    const s = requireSession(req);
    const p = mine(s.address);
    return { address: s.address, profile: view(p), limits: limitsOf(p, s.address), rules: { ...RULES, avatarMax: KINDS.avatar.max, bannerMax: KINDS.banner.max, avatarSize: [KINDS.avatar.w, KINDS.avatar.h], bannerSize: [KINDS.banner.w, KINDS.banner.h] } };
  }, { perMin: 60 });

  r.get("/api/profile/check", ({ req, query }) => {
    const s = getSession(req), a = s ? lc(s.address) : null;
    const name = String(query.u ?? "").replace(/^@/, "").trim();
    const why = nameProblem(name, { team: !!a && isTeam(a) }) || takenWhy(lc(name), a);
    return why ? { ok: false, name, why } : { ok: true, name, mine: !!a && S.names[lc(name)] === a };
  }, { perMin: 90 });

  r.post("/api/profile", async ({ req, body }) => {
    const s = requireSession(req), a = lc(s.address), now = Date.now();
    if (!body || typeof body !== "object" || Buffer.isBuffer(body)) throw new HttpError(400, "Send { username?, bio? } as JSON.");
    const hasName = Object.hasOwn(body, "username"), hasBio = Object.hasOwn(body, "bio");
    if (!hasName && !hasBio) throw new HttpError(400, "Nothing to change.");
    if ((hasName && body.username != null && typeof body.username !== "string") || (hasBio && body.bio != null && typeof body.bio !== "string")) throw new HttpError(400, "username and bio are text.");
    mayEdit(a);
    const team = isTeam(a), cur = mine(a);
    // everything is checked before anything changes, so a refused bio never leaves a half-saved name
    let name = cur?.username || null, nameKey = lc(name), renamed = false;
    if (hasName) {
      const want = String(body.username ?? "").replace(/^@/, "").trim();
      if (!want) { name = null; nameKey = ""; }
      else {
        const bad = nameProblem(want, { team });
        if (bad) throw new HttpError(400, bad);
        const key = lc(want);
        if (key !== lc(cur?.username)) {
          const why = takenWhy(key, a);
          if (why) throw new HttpError(409, why);
          // the first name is free; a different one waits 7 days from the last (a change of letter case is not a change).
          // Within 15 minutes of a change a typo can be fixed, and the 7 days still count from that change (no chaining).
          const fixing = cur?.nameAt && now - cur.nameAt < FIX_MS;
          if (cur?.nameAt && now - cur.nameAt < RENAME_MS && !team && !fixing) throw new HttpError(429, `You can change your username once every ${RULES.renameDays} days. Next change ${new Date(cur.nameAt + RENAME_MS).toISOString().slice(0, 16).replace("T", " ")} UTC.`, { renameAt: cur.nameAt + RENAME_MS });
          renamed = !fixing;
        }
        name = want; nameKey = key;
      }
    }
    const bio = hasBio ? cleanBio(body.bio ?? "", { team }) : cur?.bio || "";
    const changed = (hasName && (name || null) !== (cur?.username || null)) || (hasBio && bio !== (cur?.bio || ""));
    if (!changed) return { address: s.address, profile: view(cur), limits: limitsOf(cur, a) };
    const p = ensure(s.address);
    const old = lc(p.username);
    if (hasName && old !== nameKey) {
      if (old && S.names[old] === a) { delete S.names[old]; S.held[old] = { by: a, until: now + HOLD_MS }; }
      if (nameKey) { S.names[nameKey] = a; if (S.held[nameKey]?.by === a) delete S.held[nameKey]; }
      logIt({ action: "name", by: a, from: p.username || null, to: name || null });
    }
    if (renamed) p.nameAt = now;
    p.username = name || null;
    p.bio = bio;
    spend(p);
    tidy(a);
    await save();
    return { address: s.address, profile: view(S.users[a]), limits: limitsOf(S.users[a], a) };
  }, { perMin: 20, maxBody: 4096 });

  for (const kind of Object.keys(KINDS)) {
    r.post(`/api/profile/${kind}`, async ({ req, body }) => {
      const s = requireSession(req), a = lc(s.address), now = Date.now();
      if (!Buffer.isBuffer(body)) throw new HttpError(400, "Send the image bytes with an image content-type (PNG, JPG or WebP).");
      mayEdit(a);
      const day = new Date(now).toISOString().slice(0, 10), cur = mine(a);
      if (!isProfileAdmin(a) && cur?.uploads?.day === day && cur.uploads.n >= RULES.uploadsPerDay) throw new HttpError(429, `That is ${RULES.uploadsPerDay} image uploads today. Try again tomorrow (UTC).`);
      const { data } = await encodeImage(kind, body, req.headers["content-type"]);
      const id = createHash("sha256").update(data).digest("hex").slice(0, 32) + ".webp";
      const file = join(imgDir(), id);
      if (!(await stat(file).catch(() => null))) await writeFile(file, data, { mode: 0o640 });
      mayEdit(a);                                   // checked again: the wallet may have been locked while the image was made
      const p = ensure(s.address);
      const prev = p[kind]?.id || null;
      p[kind] = { id, at: now };
      p.uploads = p.uploads?.day === day ? { day, n: p.uploads.n + 1 } : { day, n: 1 };
      spend(p);
      await save();
      if (prev && prev !== id) await dropFile(prev);
      return { address: s.address, profile: view(p), limits: limitsOf(p, a) };
    }, { perMin: 12, maxBody: Math.ceil(KINDS[kind].max * 1.25) });

    r.del(`/api/profile/${kind}`, async ({ req }) => {
      const s = requireSession(req), a = lc(s.address);
      const p = mine(a);
      if (p?.lockedUntil && p.lockedUntil > Date.now()) throw new HttpError(403, "An admin locked this profile.");
      const prev = p?.[kind]?.id || null;
      if (!prev) return { address: s.address, profile: view(p), limits: limitsOf(p, a) };
      p[kind] = null; p.updated = Date.now();
      tidy(a);
      await save();
      await dropFile(prev);
      return { address: s.address, profile: view(S.users[a]), limits: limitsOf(S.users[a], a) };
    }, { perMin: 20 });
  }

  r.get("/api/profile/img/:file", async ({ req, res, params }) => {
    const f = String(params.file || "");
    if (!IMG_NAME.test(f)) throw new HttpError(404, "Not found");
    const etag = `"${f.slice(0, 32)}"`;
    const head = { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline", "cross-origin-resource-policy": "same-site" };
    if (String(req.headers["if-none-match"] || "").split(",").map((x) => x.trim().replace(/^W\//, "")).includes(etag)) { res.writeHead(304, head); res.end(); return; }
    let data;
    try { data = await readFile(join(imgDir(), f)); } catch { throw new HttpError(404, "Not found"); }
    if (sniff(data) !== "webp") throw new HttpError(404, "Not found");     // only what this module wrote is ever served
    res.writeHead(200, { ...head, "content-length": data.length });
    res.end(data);
  }, { weight: 0.2, perMin: 3000 });

  /* ---------- admins ---------- */
  r.post("/api/profile/admin/reset", async ({ req, body }) => {
    const s = requireAdmin(req);
    const a = lc(normAddress(body?.address));
    const all = ["username", "bio", "avatar", "banner"];
    const fields = body?.fields == null ? all : Array.isArray(body.fields) ? body.fields.filter((f) => all.includes(f)) : [];
    const lockDays = body?.lockDays == null || body.lockDays === "" ? null : Number(body.lockDays);
    if (lockDays != null && !(lockDays >= 0 && lockDays <= 365)) throw new HttpError(400, "lockDays is 0 (unlock) to 365.");
    const why = String(body?.reason || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 140) || null;
    const p = S.users[a];
    if (!p && lockDays == null) throw new HttpError(404, "This wallet has no profile.");
    const q = p || ensure(a);
    const now = Date.now(), files = [];
    let blocked = null;
    if (fields.includes("username") && q.username) {
      const key = lc(q.username);
      if (S.names[key] === a) delete S.names[key];
      if (body?.block) { if (!S.blocked.includes(key)) S.blocked.push(key); blocked = q.username; }
      else S.held[key] = { by: null, until: now + HOLD_MS };       // nobody, the wallet included, takes it for 30 days
      q.username = null;
    }
    if (fields.includes("bio")) q.bio = "";
    for (const k of ["avatar", "banner"]) if (fields.includes(k) && q[k]) { files.push(q[k].id); q[k] = null; }
    if (lockDays != null) q.lockedUntil = lockDays ? now + lockDays * 86400e3 : null;
    q.updated = now; q.resetAt = now;
    logIt({ action: "reset", by: s.address, target: a, fields, blocked, lockDays, why });
    badgeMemo.delete(a);
    tidy(a);
    await save();
    for (const id of files) await dropFile(id);
    return { ok: true, address: normAddress(a), profile: view(S.users[a]), lockedUntil: S.users[a]?.lockedUntil || null };
  }, { perMin: 30, maxBody: 4096 });

  r.post("/api/profile/admin/unblock", async ({ req, body }) => {
    const s = requireAdmin(req);
    const key = lc(String(body?.username || "").replace(/^@/, "").trim());
    const had = S.blocked.includes(key) || !!S.held[key];
    S.blocked = S.blocked.filter((x) => x !== key);
    delete S.held[key];
    logIt({ action: "unblock", by: s.address, name: key });
    await save();
    return { ok: true, lifted: had };
  }, { perMin: 30, maxBody: 2048 });

  r.get("/api/profile/admin/log", ({ req }) => {
    requireAdmin(req);
    return { log: S.log.slice(-80).reverse(), blocked: S.blocked, profiles: Object.keys(S.users).length };
  }, { perMin: 60 });
}

// tests only
export const _test = { state: () => S, reset: () => { S = EMPTY(); badgeMemo.clear(); } };
