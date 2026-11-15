// Phase 6 · a daily AI brief and smart alerts, by private message to every linked Telegram chat.
//   BRIEF=1 runs the schedule. Each linked chat gets one brief a day at its hour (default BRIEF_UTC_HOUR, 7 UTC) unless it
//   switched it off; alerts are checked every 2 minutes and each fires at most once per 6 hours for the same position.
//   Alerts: a position within 10% of liquidation, a stop-loss playbook within 2% of its trigger, funding running against
//   a position above 50% a year.
//   Chat commands (handled through tgterm.mjs): /brief · /brief off|on · /brief hour 7 · /alerts off|on
// Numbers come from the chain, Hyperliquid and Sentry; the AI only writes the two-line summary on top, from those numbers.
import { getAgentWallet } from "./agentwallet.mjs";
import { getBalances } from "./robinhood.mjs";
import { hlUserState } from "./hl.mjs";
import { hlMarkets, robinhoodToken } from "./tools.mjs";

const ON = process.env.BRIEF === "1";
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const HOUR = Math.min(23, Math.max(0, Number(process.env.BRIEF_UTC_HOUR ?? 7)));
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const STATE = "brief.json";
const ALERT_GAP = 6 * 3600e3;
let store = null, sending = false;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (v) => (v == null || !isFinite(v) ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1000 ? Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 }) : Math.abs(v).toFixed(2)}`);
const pct = (v, d = 1) => (v == null || !isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const px = (v) => (v == null || !isFinite(v) ? "–" : v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
const today = () => new Date().toISOString().slice(0, 10);

let sender = null;                       // tests swap the Telegram sender
export function useSender(fn) { sender = fn; }
async function tg(method, payload) {
  if (sender) return sender(method, payload);
  if (!TG) return { ok: false, description: "no bot token" };
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  return r.json();
}
async function links() { return (await store.readJson("telegram.json", { links: {} })).links || {}; }
async function prefsOf(address) { return (await store.readJson(STATE, { users: {}, alerts: {} })).users?.[address.toLowerCase()] || {}; }
export async function setPrefs(address, patch) {
  let out;
  await store.update(STATE, { users: {}, alerts: {} }, (s) => { s.users ||= {}; const k = address.toLowerCase(); s.users[k] = { on: true, alerts: true, hour: HOUR, ...(s.users[k] || {}), ...patch }; out = s.users[k]; });
  return out;
}

/* ---------- what goes in a brief (numbers only) ---------- */
export async function gather(address) {
  const [aw, st, markets, troya, watches, sentry] = await Promise.all([
    getAgentWallet(address).catch(() => null),
    hlUserState(address).catch(() => null),
    hlMarkets().catch(() => []),
    robinhoodToken(TROYA).catch(() => null),
    store.readJson("watches.json", []).catch(() => []),
    import("./sentry.mjs").then(async (s) => {
      const state = await store.readJson("sentry.json", {});
      const day = s.countSince(state.events || [], Date.now() - 86400e3);
      const best = s.recentResults(60).filter((r) => r.verdict === "passed" && r.at > Date.now() - 86400e3).sort((a, b) => (b.raised || 0) - (a.raised || 0)).slice(0, 3);
      return { day, best };
    }).catch(() => null),
  ]);
  const mk = Object.fromEntries((markets || []).map((m) => [m.coin.toUpperCase(), m]));
  let awEth = null;
  if (aw?.exists) { const b = await getBalances(aw.address).catch(() => null); awEth = Number(b?.balances?.find((x) => x.address === "native")?.amount ?? NaN); }
  const positions = (st?.positions || []).filter((p) => p.size !== 0).map((p) => {
    const m = mk[p.coin.toUpperCase()] || {};
    const mark = Number(m.markPx || m.midPx) || null;
    const long = p.size > 0;
    const liqAway = p.liquidationPx && mark ? Math.abs(mark - p.liquidationPx) / mark * 100 : null;
    const apr = m.fundingApr ?? null;
    const fundingAgainst = apr != null && ((long && apr > 0) || (!long && apr < 0)) ? Math.abs(apr) : 0;
    return { coin: p.coin, side: long ? "long" : "short", size: Math.abs(p.size), entryPx: p.entryPx, mark, pnl: p.unrealizedPnl, roe: p.returnOnEquity * 100, liqPx: p.liquidationPx, liqAway, fundingApr: apr, fundingAgainst };
  });
  const mine = (watches || []).filter((w) => w.address === address.toLowerCase() && w.status === "active");
  const guards = mine.filter((w) => w.type === "stop_loss").map((w) => {
    const mark = Number(mk[w.params.coin]?.markPx || mk[w.params.coin]?.midPx) || null;
    return { id: w.id, title: w.title, coin: w.params.coin, trigger: w.params.triggerPx, away: mark ? Math.abs(mark - w.params.triggerPx) / mark * 100 : null };
  }).sort((a, b) => (a.away ?? 1e9) - (b.away ?? 1e9));
  const coin = (c) => (mk[c] ? { px: Number(mk[c].markPx || mk[c].midPx), ch: mk[c].change24h } : null);
  return {
    address, awEth: isFinite(awEth) ? awEth : null, hasAgentWallet: !!aw?.exists,
    hl: st ? { value: st.accountValue, free: st.withdrawable, upnl: st.unrealizedPnl } : null,
    positions, playbooks: mine.length, guards,
    market: { ETH: coin("ETH"), BTC: coin("BTC"), TROYA: troya ? { px: troya.priceUsd, ch: troya.change24h } : null },
    sentry,
  };
}

async function aiSummary(d) {
  try {
    const llm = await import("./llm.mjs");
    if (!llm.llmOn() || !(await llm.underCap())) return null;
    const system = "You write the first two lines of a trader's morning brief for Troya Agent. Use only the numbers given. Plain English, at most 2 short sentences, no emoji, no hashtags, no advice to buy or sell, no price predictions. Point out what matters most today: a position near liquidation, a stop close to its trigger, funding working against them, a big PnL move, or, with no positions, the market and Sentry in one line.";
    const t = await llm.chatWithTools({ system, user: JSON.stringify(d), tools: [], maxSteps: 1 });
    return String(t || "").trim().slice(0, 400) || null;
  } catch { return null; }
}

export function formatBrief(d, summary) {
  const date = new Date().toUTCString().slice(0, 11);
  const L = [`<b>Troya brief · ${esc(date)}</b>`];
  if (summary) L.push(`<i>${esc(summary)}</i>`);
  L.push("", "<b>Your desk</b>");
  const desk = [];
  if (d.hasAgentWallet) desk.push(`Agent Wallet ${d.awEth != null ? d.awEth.toFixed(4) : "–"} ETH`);
  if (d.hl) desk.push(`Hyperliquid ${usd(d.hl.value)} (free ${usd(d.hl.free)})`);
  L.push(desk.length ? desk.join(" · ") : "No Agent Wallet yet. Create one in Troya → Agent → Wallet.");
  for (const p of d.positions.slice(0, 6)) {
    L.push(`${esc(p.coin)} ${p.side} ${p.size} @ ${px(p.entryPx)} · mark ${px(p.mark)} · PnL ${usd(p.pnl)} (${pct(p.roe)})${p.liqPx ? ` · liq ${px(p.liqPx)} (${p.liqAway != null ? p.liqAway.toFixed(0) : "–"}% away)` : ""}${p.fundingAgainst > 0 ? ` · funding ${p.fundingAgainst.toFixed(0)}%/yr against you` : ""}`);
  }
  if (!d.positions.length && d.hl) L.push("No open perps.");
  if (d.playbooks) L.push(`Playbooks: ${d.playbooks} active${d.guards[0]?.away != null ? ` · nearest stop ${esc(d.guards[0].coin)} ${px(d.guards[0].trigger)} (${d.guards[0].away.toFixed(1)}% away)` : ""}`);
  const m = d.market;
  L.push("", "<b>Market</b>", [m.ETH && `ETH ${px(m.ETH.px)} (${pct(m.ETH.ch)})`, m.BTC && `BTC ${px(m.BTC.px)} (${pct(m.BTC.ch)})`, m.TROYA && `$TROYA ${m.TROYA.px != null ? `$${Number(m.TROYA.px).toPrecision(3)}` : "–"} (${pct(m.TROYA.ch)})`].filter(Boolean).join(" · ") || "–");
  if (d.sentry?.day) {
    const s = d.sentry.day;
    L.push("", "<b>Troya Sentry, last 24h</b>", `${s.seen} launches · ${s.passed} passed · ${s.caution} caution · ${s.failed} failed`);
    if (d.sentry.best.length) L.push(`Most raised among the passed: ${d.sentry.best.map((b) => `$${esc(b.symbol || "?")} (${(b.raised ?? 0).toFixed(2)} ETH)`).join(", ")}`);
  }
  L.push("", "/positions · /playbooks · /brief off to stop these");
  return L.join("\n");
}

export async function sendBrief(address, chat, { force = false } = {}) {
  const d = await gather(address);
  const summary = await aiSummary(d);
  const text = formatBrief(d, summary);
  const r = await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "Open Troya", url: "https://troya.codes/agent" }, { text: "Troya Sentry", url: "https://t.me/troyasentry" }]] } });
  if (r.ok && !force) await setPrefs(address, { lastBrief: today() });
  return { ok: !!r.ok, text, error: r.ok ? null : r.description };
}

/* ---------- alerts ---------- */
export function alertsFor(d) {
  const out = [];
  for (const p of d.positions) {
    if (p.liqAway != null && p.liqAway < 10) out.push({ key: `liq:${p.coin}:${p.side}`, text: `<b>${esc(p.coin)} ${p.side} is ${p.liqAway.toFixed(1)}% from liquidation.</b> Mark ${px(p.mark)}, liquidation ${px(p.liqPx)}. Add margin, reduce it with /close ${esc(p.coin)} 50, or guard it with /stop.` });
    if (p.fundingAgainst > 50) out.push({ key: `fund:${p.coin}:${p.side}`, text: `<b>Funding is running against your ${esc(p.coin)} ${p.side}:</b> about ${p.fundingAgainst.toFixed(0)}% a year right now.` });
  }
  for (const g of d.guards) if (g.away != null && g.away < 2) out.push({ key: `stop:${g.id}`, text: `<b>${esc(g.title)} is ${g.away.toFixed(1)}% from firing.</b> It closes through your Agent Wallet when it does.` });
  return out;
}
async function alertTick() {
  const all = await links();
  const state = await store.readJson(STATE, { users: {}, alerts: {} });
  const now = Date.now();
  const sent = {};
  for (const [address, chat] of Object.entries(all)) {
    if (state.users?.[address]?.alerts === false) continue;
    const st = await hlUserState(address).catch(() => null);
    const hasWatch = (await store.readJson("watches.json", [])).some((w) => w.address === address && w.status === "active" && w.type === "stop_loss");
    if (!st?.positions?.some((p) => p.size !== 0) && !hasWatch) continue;
    const d = await gather(address);
    for (const a of alertsFor(d)) {
      const k = `${address}:${a.key}`;
      if (now - (state.alerts?.[k] || 0) < ALERT_GAP) continue;
      const r = await tg("sendMessage", { chat_id: chat, text: a.text, parse_mode: "HTML" }).catch(() => null);
      if (r?.ok) sent[k] = now;
    }
  }
  if (Object.keys(sent).length) await store.update(STATE, { users: {}, alerts: {} }, (s) => { s.alerts = { ...(s.alerts || {}), ...sent }; for (const [k, t] of Object.entries(s.alerts)) if (now - t > 2 * ALERT_GAP) delete s.alerts[k]; });
}

async function briefTick() {
  if (sending) return;
  sending = true;
  try {
    const hour = new Date().getUTCHours();
    const all = await links();
    const state = await store.readJson(STATE, { users: {}, alerts: {} });
    for (const [address, chat] of Object.entries(all)) {
      const u = state.users?.[address] || {};
      if (u.on === false || (u.hour ?? HOUR) !== hour || u.lastBrief === today()) continue;
      await sendBrief(address, chat).catch((e) => console.warn("[brief]", address.slice(0, 8), e.message));
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally { sending = false; }
}

/* ---------- chat commands (called from tgterm.mjs for linked chats) ---------- */
export async function command(address, chat, arg) {
  const a = String(arg || "").trim().toLowerCase();
  if (a === "off" || a === "on") { await setPrefs(address, { on: a === "on" }); return a === "on" ? `Daily brief on, at ${(await prefsOf(address)).hour ?? HOUR}:00 UTC. /brief hour 9 moves it.` : "Daily brief off. /brief on brings it back, /brief sends one now."; }
  const h = /^hour\s+(\d{1,2})$/.exec(a);
  if (h) { const n = Math.min(23, Math.max(0, Number(h[1]))); await setPrefs(address, { hour: n, on: true }); return `Daily brief moved to ${n}:00 UTC.`; }
  const r = await sendBrief(address, chat, { force: true });
  return r.ok ? null : `Could not build the brief right now: ${r.error || "try again"}`;
}
export async function alertsCommand(address, arg) {
  const a = String(arg || "").trim().toLowerCase();
  if (a === "off" || a === "on") { await setPrefs(address, { alerts: a === "on" }); return a === "on" ? "Smart alerts on: near liquidation, a stop close to firing, funding against you." : "Smart alerts off. /alerts on brings them back."; }
  const p = await prefsOf(address);
  return `Smart alerts are ${p.alerts === false ? "off" : "on"}. They watch your perps for liquidation within 10%, a stop-loss within 2% of firing and funding over 50% a year against you, at most once every 6 hours each. /alerts off or /alerts on.`;
}

export async function register(r, ctx) {
  store = ctx.store;
  const { requireSession } = await import("./auth.mjs");
  // the web shows the same brief and settings as Telegram
  r.get("/api/brief/me", async ({ req }) => {
    const s = requireSession(req);
    const d = await gather(s.address);
    const p = await prefsOf(s.address);
    const linked = !!(await links())[s.address.toLowerCase()];
    return { brief: d, alerts: alertsFor(d).map((a) => a.text.replace(/<[^>]+>/g, "")), prefs: { on: p.on !== false, hour: p.hour ?? HOUR, alerts: p.alerts !== false, lastBrief: p.lastBrief || null }, telegramLinked: linked, schedule: ON };
  });
  r.post("/api/brief/summary", async ({ req }) => {
    const s = requireSession(req);
    const d = await gather(s.address);
    return { summary: await aiSummary(d) };
  }, { perMin: 6 });
  r.post("/api/brief/settings", async ({ req, body }) => {
    const s = requireSession(req);
    const patch = {};
    if ("on" in body) patch.on = !!body.on;
    if ("alerts" in body) patch.alerts = !!body.alerts;
    if ("hour" in body) patch.hour = Math.min(23, Math.max(0, Math.round(Number(body.hour) || 0)));
    return { prefs: await setPrefs(s.address, patch) };
  });
  r.post("/api/brief/send", async ({ req }) => {
    const s = requireSession(req);
    const chat = (await links())[s.address.toLowerCase()];
    if (!chat) return { ok: false, reason: "Link Telegram first: Settings → Telegram alerts." };
    const res = await sendBrief(s.address, chat, { force: true });
    return { ok: res.ok, reason: res.error };
  }, { perMin: 4 });
  if (!ON || !TG) return;
  console.log(`[brief] daily brief at ${HOUR}:00 UTC by default, alerts every 2 minutes`);
  setInterval(() => briefTick().catch((e) => console.warn("[brief]", e.message)), 5 * 60_000).unref();
  setInterval(() => alertTick().catch((e) => console.warn("[brief alerts]", e.message)), 2 * 60_000).unref();
  setTimeout(() => briefTick().catch(() => {}), 20_000).unref();
}
export function init(st) { store = store || st; }
