// Community reports: bug reports, ideas and "something looks wrong" flags from the website (with up to three
// screenshots) and from Telegram (/bug, /idea, /report in a private chat, /bug and /idea in the group, member
// /report on a promo in the group). Everything lands in one inbox only admins can open (Desk → Social → Reports).
// Nothing is sent to anyone's personal chat. If REPORTS_CHAT_ID is set (a private team group with the bot in it),
// each new report is also posted there.
//
//   POST /api/community/report          public, rate limited: { kind, message, contact?, page?, wallet?, images?: [dataURL] }
//   GET  /api/community/reports         admin: newest first
//   GET  /api/community/file/:name      admin: a screenshot
//   POST /api/community/reports/:id     admin: { status, note }
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";

const KINDS = { bug: "Bug", idea: "Idea", scam: "Something suspicious", other: "Other" };
const STATUSES = ["new", "seen", "working", "fixed", "wontfix", "spam"];
const MAX_IMAGES = 3, MAX_IMAGE = 3 * 1024 * 1024;
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

let store = null, dir = null;
const FILE = "reports.json";

/* ---------- limits: per web visitor and per Telegram user ---------- */
const recent = new Map();   // key → [timestamps]
function allow(key, max, windowMs) {
  const now = Date.now(), l = (recent.get(key) || []).filter((t) => now - t < windowMs);
  if (l.length >= max) { recent.set(key, l); return false; }
  l.push(now); recent.set(key, l);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return true;
}

/* ---------- images: only real PNG, JPEG or WebP bytes are kept ---------- */
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
async function saveImage(id, n, buf) {
  const ext = sniff(buf);
  if (!ext) throw new HttpError(400, "Screenshots must be PNG, JPEG or WebP.");
  if (buf.length > MAX_IMAGE) throw new HttpError(413, "Each screenshot can be up to 3 MB.");
  const name = `${id}-${n}.${ext}`;
  await writeFile(join(dir, name), buf, { mode: 0o600 });
  return name;
}

async function add(r) {
  const id = randomBytes(4).toString("hex");
  const item = { id, at: Date.now(), status: "new", note: "", ...r, images: [] };
  return { id, item };
}
async function commit(item) {
  await store.update(FILE, [], (l) => { l.push(item); if (l.length > 3000) l.splice(0, l.length - 3000); return l; });
  notifyTeam(item).catch(() => {});
  return item;
}

/* ---------- optional: a private team group, never a personal chat ---------- */
async function tgCall(method, payload) {
  if (!TG) return null;
  return fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
}
// who receives new reports by Telegram: chats an admin linked from the Reports tab (one-time code), plus REPORTS_CHAT_ID
const TGF = "reports-tg.json";
async function receivers() { const d = await store.readJson(TGF, { chats: [], codes: {} }); return [...new Set([...(d.chats || []).filter((c) => !c.off).map((c) => String(c.id)), ...(process.env.REPORTS_CHAT_ID ? [String(process.env.REPORTS_CHAT_ID)] : [])])]; }
async function notifyTeam(it) {
  if (!TG) return;
  const chats = await receivers();
  if (!chats.length) return;
  const text = `<b>New report:</b> <b>${esc(KINDS[it.kind] || it.kind)}</b> · #${it.id} · ${esc(it.source)}\n\n${esc(it.message).slice(0, 900)}${it.reported ? `\n\nReported message from ${esc(it.reported.user || it.reported.id)}: ${esc(it.reported.text || "").slice(0, 300)}` : ""}${it.page ? `\nPage: ${esc(it.page)}` : ""}${it.contact ? `\nContact: ${esc(it.contact)}` : ""}${it.wallet ? `\nWallet: <code>${esc(it.wallet)}</code>` : ""}\n\nInbox: troya.codes/agent#/social/reports`;
  const img = it.images[0] ? await readFile(join(dir, it.images[0])).catch(() => null) : null;
  for (const chat of chats) {
    if (img) {
      const f = new FormData();
      f.set("chat_id", chat); f.set("caption", text.slice(0, 1020)); f.set("parse_mode", "HTML");
      f.set("photo", new Blob([img], { type: it.images[0].endsWith(".png") ? "image/png" : it.images[0].endsWith(".webp") ? "image/webp" : "image/jpeg" }), it.images[0]);
      const r = await fetch(`https://api.telegram.org/bot${TG}/sendPhoto`, { method: "POST", body: f, signal: AbortSignal.timeout(30000) }).then((x) => x.json()).catch(() => null);
      if (r?.ok) continue;
    }
    await tgCall("sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}
/** The bot calls this for "/start rep_<code>" in a private chat. */
export async function bindReportsChat(code, chat, from) {
  if (!store) return { ok: false };
  let ok = false;
  await store.update(TGF, { chats: [], codes: {} }, (d) => {
    d.codes ||= {}; d.chats ||= [];
    const c = d.codes[code];
    if (c && c.exp > Date.now()) {
      ok = true; delete d.codes[code];
      d.chats = d.chats.filter((x) => String(x.id) !== String(chat.id));
      d.chats.push({ id: chat.id, name: from?.username ? `@${from.username}` : String(from?.first_name || "").slice(0, 40), by: c.by, at: Date.now() });
    }
    for (const [k, v] of Object.entries(d.codes)) if (v.exp < Date.now()) delete d.codes[k];
    return d;
  });
  return { ok };
}
/** "/reports on|off" from a linked chat. */
export async function setReportsChat(chatId, on) {
  if (!store) return { linked: false };
  let linked = false;
  await store.update(TGF, { chats: [], codes: {} }, (d) => { const c = (d.chats || []).find((x) => String(x.id) === String(chatId)); if (c) { linked = true; c.off = !on; } return d; });
  return { linked };
}

/* ---------- Telegram: called by the bot ---------- */
export async function addFromTelegram({ kind, text, from, chat, photo, reported, tg }) {
  if (!store) return null;
  const uid = String(from?.id || "");
  if (!allow(`tg:${uid}`, 6, 3600_000)) return { limited: true };
  const { id, item } = await add({
    kind: KINDS[kind] ? kind : "other", source: chat?.type === "private" ? "telegram-dm" : "telegram-group",
    message: clean(text, 4000) || (photo ? "(screenshot)" : ""),
    contact: from?.username ? `@${from.username}` : clean(from?.first_name, 60), tgUser: uid || null, tgChat: String(chat?.id || ""),
    reported: reported ? { user: reported.username ? `@${reported.username}` : clean(reported.first_name, 60), id: String(reported.id || ""), text: clean(reported.text, 1500) } : null,
  });
  // the largest photo size the bot can read (Telegram keeps the file; we keep a copy for the inbox)
  if (photo?.file_id && TG && (photo.file_size || 0) <= MAX_IMAGE) {
    try {
      const f = await (tg ? tg("getFile", { file_id: photo.file_id }) : tgCall("getFile", { file_id: photo.file_id }));
      const path = f?.result?.file_path || f?.file_path;
      if (path) {
        const res = await fetch(`https://api.telegram.org/file/bot${TG}/${path}`, { signal: AbortSignal.timeout(20000) });
        if (res.ok) item.images.push(await saveImage(id, 0, Buffer.from(await res.arrayBuffer())));
      }
    } catch { /* the words still count */ }
  }
  await commit(item);
  return { id };
}

/* ---------- web ---------- */
async function addFromWeb({ body, ip, req }) {
  if (!allow(`ip:${ip}`, 5, 3600_000)) throw new HttpError(429, "That is a lot of reports in an hour. Try again later, or write in the Telegram group.");
  const kind = KINDS[body?.kind] ? body.kind : "other";
  const message = clean(body?.message, 4000);
  if (message.length < 10) throw new HttpError(400, "Tell us a little more: at least a sentence.");
  if (body?.website) throw new HttpError(400, "Something went wrong.");          // honeypot field, hidden from people
  const images = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES + 1) : [];
  if (images.length > MAX_IMAGES) throw new HttpError(400, "Up to three screenshots.");
  const s = getSession(req);
  const { id, item } = await add({
    kind, source: "web", message,
    contact: clean(body?.contact, 120), page: clean(body?.page, 300),
    wallet: s?.address || (/^0x[0-9a-fA-F]{40}$/.test(String(body?.wallet || "")) ? body.wallet : null),
    signedIn: !!s, ua: clean(req.headers["user-agent"], 200),
  });
  let n = 0;
  for (const d of images) {
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(d || ""));
    if (!m) throw new HttpError(400, "Screenshots must be PNG, JPEG or WebP.");
    item.images.push(await saveImage(id, n++, Buffer.from(m[2], "base64")));
  }
  await commit(item);
  return { ok: true, id };
}

export async function register(r, ctx) {
  store = ctx.store;
  dir = join(ctx.dataDir, "reports");
  await mkdir(dir, { recursive: true });

  r.post("/api/community/report", addFromWeb, { weight: 3, perMin: 10, maxBody: 13 * 1024 * 1024 });

  r.get("/api/community/reports", async ({ req, query }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    let l = (await store.readJson(FILE, [])).slice().reverse();
    if (query.status && STATUSES.includes(query.status)) l = l.filter((x) => x.status === query.status);
    if (query.kind && KINDS[query.kind]) l = l.filter((x) => x.kind === query.kind);
    const all = await store.readJson(FILE, []);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((x) => x.status === s).length]));
    return { reports: l.slice(0, 200), counts, kinds: KINDS, statuses: STATUSES, team: !!process.env.REPORTS_CHAT_ID };
  }, { weight: 2 });

  r.get("/api/community/file/:name", async ({ req, res, params }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const name = String(params.name);
    if (!/^[0-9a-f]{8}-\d\.(png|jpg|webp)$/.test(name)) throw new HttpError(404, "Not found");
    const buf = await readFile(join(dir, name)).catch(() => null);
    if (!buf) throw new HttpError(404, "Not found");
    const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
    res.end(buf);
  }, { weight: 1 });

  // an admin links their own chat with the bot: a one-time code, valid 15 minutes, in a t.me deep link
  r.post("/api/community/telegram", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    if (!TG) throw new HttpError(503, "The Telegram bot is not configured on this server.");
    const code = randomBytes(8).toString("hex");
    await store.update(TGF, { chats: [], codes: {} }, (d) => { d.codes ||= {}; d.codes[code] = { by: getSession(req)?.address || null, exp: Date.now() + 15 * 60_000 }; return d; });
    const me = await tgCall("getMe", {});
    const user = me?.result?.username || "TrojanTroya_bot";
    return { url: `https://t.me/${user}?start=rep_${code}`, expiresIn: 900 };
  }, { weight: 2, perMin: 10 });
  r.get("/api/community/telegram", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const d = await store.readJson(TGF, { chats: [], codes: {} });
    return { chats: (d.chats || []).map((c) => ({ name: c.name, on: !c.off, at: c.at })) };
  }, { weight: 1 });

  r.post("/api/community/reports/:id", async ({ req, params, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const status = STATUSES.includes(body?.status) ? body.status : null;
    let out = null;
    await store.update(FILE, [], (l) => {
      const x = l.find((y) => y.id === params.id);
      if (!x) return l;
      if (status) x.status = status;
      if (typeof body?.note === "string") x.note = clean(body.note, 1000);
      x.updatedAt = Date.now(); x.updatedBy = getSession(req)?.address || null;
      out = x;
      return l;
    });
    if (!out) throw new HttpError(404, "No report with that id.");
    return { report: out };
  }, { weight: 2 });
}
