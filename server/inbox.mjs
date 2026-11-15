// Inbox (notes + agent proposals), user settings, assistant memory, optional Telegram alerts.
// Proposals expire after 10 minutes; the app (or Autopilot with the Agent Wallet) acts on them.
import { randomBytes } from "node:crypto";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const PROPOSAL_TTL = 10 * 60 * 1000;
const MAX_ITEMS = 300;
let store;
const file = (a) => `inbox/${String(a).toLowerCase()}.json`;
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, n);
const id = () => randomBytes(8).toString("hex");

export async function addInbox(address, { kind = "note", title, body = "", data = null }) {
  const item = { id: id(), t: Date.now(), kind: clip(kind, 30), title: clip(title, 160), body: clip(body, 1200), data, read: false };
  await store.update(file(address), { items: [] }, (box) => { box.items.unshift(item); box.items = box.items.slice(0, MAX_ITEMS); });
  sendTelegram(address, `${item.title}${item.body ? "\n" + item.body : ""}`).catch(() => {});
  return item;
}

// kind: swap | perp | bridge | watch | send ; params depend on kind; summary is human text.
export async function createProposal(address, { kind, params, summary, rationale = "", gate = null, source = "assistant" }) {
  const p = { id: id(), kind, params, summary: clip(summary, 300), rationale: clip(rationale, 600), gate, source, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + PROPOSAL_TTL };
  await store.update(file(address), { items: [] }, (box) => {
    box.proposals = (box.proposals || []).filter((x) => x.status === "pending" ? x.expiresAt > Date.now() - 86400_000 : x.createdAt > Date.now() - 7 * 86400_000).slice(0, 200);
    box.proposals.unshift(p);
  });
  return p;
}
export async function getProposal(address, pid) {
  const box = await store.readJson(file(address), { items: [] });
  const p = (box.proposals || []).find((x) => x.id === pid);
  if (p && p.status === "pending" && p.expiresAt < Date.now()) p.status = "expired";
  return p || null;
}
export async function markProposal(address, pid, status, result = null) {
  let out = null;
  await store.update(file(address), { items: [] }, (box) => {
    const p = (box.proposals || []).find((x) => x.id === pid);
    if (p) { p.status = status; p.result = result; p.doneAt = Date.now(); out = p; }
  });
  return out;
}
export async function listProposals(address, { due = false } = {}) {
  const box = await store.readJson(file(address), { items: [] });
  const now = Date.now();
  return (box.proposals || []).map((p) => (p.status === "pending" && p.expiresAt < now ? { ...p, status: "expired" } : p)).filter((p) => !due || p.status === "pending");
}

/* ---------- Telegram (only when TELEGRAM_BOT_TOKEN is set) ---------- */
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
let tgOffset = 0;
async function tg(method, payload, ms = 10000) {
  const res = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(ms) });
  return res.json();
}
export async function sendTelegram(address, text) {
  if (!TG) return false;
  const links = await store.readJson("telegram.json", { links: {}, codes: {} });
  const chat = links.links[String(address).toLowerCase()];
  if (!chat) return false;
  const prefs = (await store.readJson("settings.json", {}))[String(address).toLowerCase()] || {};
  if (prefs.telegramAlerts === false) return false;
  await tg("sendMessage", { chat_id: chat, text: `Troya Agent\n${text}`.slice(0, 3500), disable_web_page_preview: true });
  return true;
}
// Long polling: one getUpdates call waits up to 25 s, so replies are instant. Only one process may poll a bot token,
// so a local copy of the server sets TELEGRAM_POLL=0 while production runs.
let tgMe = null;
async function onTelegramMessage(m) {
  const code = /^\/start\s+([a-f0-9]{16})$/.exec(m.text || "");
  if (code) {
    let linked = false;
    await store.update("telegram.json", { links: {}, codes: {} }, (t) => {
      const c = t.codes[code[1]];
      if (c && c.exp > Date.now()) { t.links[c.address] = m.chat.id; delete t.codes[code[1]]; linked = true; }
    });
    await tg("sendMessage", { chat_id: m.chat.id, text: linked ? "Linked. Troya will send your alerts here." : "That link code expired. Make a new one in Troya: Settings → Telegram." }).catch(() => {});
    return;
  }
  // Phase 2: trade messages in a private chat (TG_TRADE=1); everything else goes to the normal bot
  if (await import("./tgtrade.mjs").then((t) => t.handleMessage(m, tg, store)).catch((e) => { console.warn("[telegram trade]", e.message); return false; })) return;
  // Phase 5: perps, Fund Hyperliquid, positions, playbooks and the assistant in a linked private chat
  if (await import("./tgterm.mjs").then((t) => t.handleMessage(m, tg, store)).catch((e) => { console.warn("[telegram terminal]", e.message); return false; })) return;
  const bot = await import("./tgbot.mjs");
  await bot.handleBotMessage(m, tg, tgMe);
}
async function telegramLoop() {
  tgMe = (await tg("getMe", {}).catch(() => null))?.result || null;
  const bot = await import("./tgbot.mjs"); bot.initBot(store);
  setInterval(() => bot.sweep(tg).catch(() => {}), 15000).unref();   // the join guard's clock
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset: tgOffset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35000);
      if (!r.ok) { await new Promise((x) => setTimeout(x, r.error_code === 409 ? 30000 : 5000)); continue; }
      for (const u of r.result || []) {
        tgOffset = u.update_id + 1;
        if (u.message) await onTelegramMessage(u.message).catch((e) => console.warn("[telegram]", e.message));
        if (u.callback_query) {
          const traded = await import("./tgtrade.mjs").then((t) => t.handleCallback(u.callback_query, tg)).catch((e) => { console.warn("[telegram trade]", e.message); return false; });
          const term = traded || await import("./tgterm.mjs").then((t) => t.handleCallback(u.callback_query, tg)).catch((e) => { console.warn("[telegram terminal]", e.message); return false; });
          if (!term) await import("./tgbot.mjs").then((b) => b.handleCallback(u.callback_query, tg)).catch((e) => console.warn("[telegram guard]", e.message));
        }
      }
    } catch { await new Promise((x) => setTimeout(x, 5000)); }
  }
}

export async function register(r, ctx) {
  store = ctx.store;
  if (TG && process.env.TELEGRAM_POLL !== "0") telegramLoop();

  r.get("/api/inbox", async ({ req, query }) => {
    const s = requireSession(req);
    const box = await store.readJson(file(s.address), { items: [] });
    const unread = box.items.filter((x) => !x.read).length;
    let items = box.items;
    if (query.unread === "1") items = items.filter((x) => !x.read);
    return { items: items.slice(0, Math.min(200, Number(query.limit) || 50)), unread };
  });
  r.post("/api/inbox/read", async ({ req, body }) => {
    const s = requireSession(req);
    const ids = Array.isArray(body.ids) ? new Set(body.ids) : null;
    await store.update(file(s.address), { items: [] }, (box) => { for (const it of box.items) if (!ids || ids.has(it.id)) it.read = true; });
    return { ok: true };
  });
  r.get("/api/inbox/proposals", async ({ req, query }) => {
    const s = requireSession(req);
    return { items: (await listProposals(s.address, { due: query.due === "1" })).slice(0, 100) };
  });
  // The app tells us a proposal was signed in the user's wallet, rejected or failed.
  r.post("/api/inbox/proposal-done", async ({ req, body }) => {
    const s = requireSession(req);
    const st = ["done", "rejected", "failed", "submitted"].includes(body.status) ? body.status : "done";
    const p = await markProposal(s.address, String(body.id || ""), st, { hash: /^0x[0-9a-fA-F]{64}$/.test(body.hash || "") ? body.hash : null, note: clip(body.note, 300) });
    if (!p) throw new HttpError(404, "Proposal not found.");
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: `proposal.${p.kind}`, summary: `${p.summary} (${st})`, rationale: p.rationale, data: { proposalId: p.id, hash: p.result?.hash || null }, status: st, source: "reported by app" });
    return { proposal: p };
  });

  /* settings + memory (things the assistant should remember, written by the user) */
  r.get("/api/settings", async ({ req }) => {
    const s = requireSession(req);
    return (await store.readJson("settings.json", {}))[s.address.toLowerCase()] || {};
  });
  r.post("/api/settings", async ({ req, body }) => {
    const s = requireSession(req);
    let out;
    await store.update("settings.json", {}, (all) => {
      const cur = all[s.address.toLowerCase()] || {};
      if ("lang" in body) cur.lang = ["auto", "en", "id"].includes(body.lang) ? body.lang : "auto";
      if ("telegramAlerts" in body) cur.telegramAlerts = !!body.telegramAlerts;
      if ("slippage" in body) cur.slippage = Math.min(20, Math.max(0.1, Number(body.slippage) || 1));
      all[s.address.toLowerCase()] = out = cur;
    });
    return out;
  });
  r.get("/api/memory", async ({ req }) => {
    const s = requireSession(req);
    return { items: (await store.readJson("memory.json", {}))[s.address.toLowerCase()] || [] };
  });
  r.post("/api/memory", async ({ req, body }) => {
    const s = requireSession(req);
    const text = clip(body.text, 280).trim();
    if (!text) throw new HttpError(400, "Write something to remember.");
    let items;
    await store.update("memory.json", {}, (all) => { items = all[s.address.toLowerCase()] = [{ id: id(), t: Date.now(), text }, ...(all[s.address.toLowerCase()] || [])].slice(0, 30); });
    return { items };
  });
  r.del("/api/memory/:id", async ({ req, params }) => {
    const s = requireSession(req);
    let items;
    await store.update("memory.json", {}, (all) => { items = all[s.address.toLowerCase()] = (all[s.address.toLowerCase()] || []).filter((m) => m.id !== params.id); });
    return { items };
  });

  /* Telegram */
  r.get("/api/notify/status", async ({ req }) => {
    const s = requireSession(req);
    const t = await store.readJson("telegram.json", { links: {}, codes: {} });
    return { configured: !!TG, linked: !!t.links[s.address.toLowerCase()] };
  });
  r.post("/api/notify/telegram/link", async ({ req }) => {
    const s = requireSession(req);
    if (!TG) throw new HttpError(400, "Telegram alerts are not configured on this server.");
    const code = randomBytes(8).toString("hex");
    await store.update("telegram.json", { links: {}, codes: {} }, (t) => { t.codes[code] = { address: s.address.toLowerCase(), exp: Date.now() + 15 * 60_000 }; });
    const me = await tg("getMe", {}).catch(() => null);
    return { code, url: me?.result?.username ? `https://t.me/${me.result.username}?start=${code}` : null };
  });
  r.post("/api/notify/telegram/unlink", async ({ req }) => {
    const s = requireSession(req);
    await store.update("telegram.json", { links: {}, codes: {} }, (t) => { delete t.links[s.address.toLowerCase()]; });
    return { ok: true };
  });
  r.post("/api/notify/test", async ({ req }) => {
    const s = requireSession(req);
    if (!TG) throw new HttpError(400, "Telegram alerts are not configured on this server.");
    return { sent: await sendTelegram(s.address, "Test alert. Alerts are working.") };
  });
}
