// Phase 7 · Sentry Autopilot: your rules, run around the clock on every Pons launch that passes Troya Gate.
//   Rules per user: minRaisedEth (curve raised, ETH), buyEth, takeProfitX, stopPct, maxOpen, maxBuysPerDay.
//   Practice (default): play money at real prices. Entries and exits are quoted on chain the moment they happen; nothing
//   is sent. Live: the Agent Wallet buys and sells through executeForUser, so Troya Gate and the caps run again. Live
//   needs AUTOPILOT_LIVE=1 on the server, an Agent Wallet, and the user switching it on.
//   Exits are checked every 60 s: take-profit at takeProfitX, stop at -stopPct %, and anything still open after 7 days.
//   Telegram (via tgterm.mjs): /autopilot · on|off · practice|live · set min 1 buy 0.01 tp 2 sl 30 max 3
//   Web: Agent → Sentry Autopilot. Phase 9 reads the closed results of users who opted into the leaderboard.
import { randomBytes } from "node:crypto";
import { formatUnits } from "ethers";
import { quoteSwap } from "./tools.mjs";
import { getAgentWallet, executeForUser } from "./agentwallet.mjs";
import { getBalances } from "./robinhood.mjs";

const LIVE_OK = process.env.AUTOPILOT_LIVE === "1";
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const STATE = "autopilot.json";
const MAX_AGE = 7 * 86400e3;
export const DEFAULTS = { minRaisedEth: 1, buyEth: 0.01, takeProfitX: 2, stopPct: 30, maxOpen: 3, maxBuysPerDay: 5 };
const LIMITS = { minRaisedEth: [0, 4.2], buyEth: [0.001, 0.5], takeProfitX: [1.05, 50], stopPct: [5, 95], maxOpen: [1, 10], maxBuysPerDay: [1, 30] };
let store = null, ticking = false, sender = null;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const eth = (v, d = 4) => (v == null || !isFinite(v) ? "–" : `${Number(v).toFixed(d)} ETH`);
const blank = () => ({ users: {}, positions: [] });
const decStr = (n) => trunc(Number(n).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tokenBal(addr, token) {
  const b = await getBalances(addr, [token]).catch(() => null);
  return b?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === token.toLowerCase()) || null;
}
async function ethBal(addr) { return Number((await getBalances(addr).catch(() => null))?.balances?.find((x) => x.address === "native")?.amount ?? NaN); }
// at most 15 significant digits, cut and never rounded up, so a Number of it stays at or below the balance
function trunc(s, sig = 15) {
  const [i, f = ""] = String(s).split(".");
  const intD = i.replace(/^0+/, "").length;
  if (intD >= sig) return i;
  const keep = intD ? sig - intD : sig + (f.match(/^0*/)[0].length);
  return f ? `${i}.${f.slice(0, keep)}`.replace(/\.?0+$/, "") || "0" : i;
}
export function useSender(fn) { sender = fn; }
export function init(st) { store = store || st; }
async function tg(method, payload) {
  if (sender) return sender(method, payload);
  if (!TG) return { ok: false };
  return fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => ({ ok: false }));
}
async function dm(address, text) {
  const chat = (await store.readJson("telegram.json", { links: {} })).links?.[address.toLowerCase()];
  if (chat) await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
}

export function cleanRules(input = {}, base = DEFAULTS) {
  const out = { ...DEFAULTS, ...base };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (input[k] != null && isFinite(Number(input[k]))) out[k] = Math.min(hi, Math.max(lo, Number(input[k])));
  out.maxOpen = Math.round(out.maxOpen); out.maxBuysPerDay = Math.round(out.maxBuysPerDay);
  return out;
}
// "min 1 buy 0.01 tp 2 sl 30 max 3", or plain words: "above 1 ETH raised, 0.01 ETH each, take profit at 2x, stop at -30%"
export function parseRules(text) {
  const t = String(text || "").toLowerCase();
  const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const r = {
    minRaisedEth: num(/(?:min(?:imum)?|above|over|raised)\s*(?:of\s*)?(\d*\.?\d+)\s*(?:eth)?/) ?? num(/(\d*\.?\d+)\s*eth\s*raised/),
    buyEth: num(/(?:buy|each|size|per\s*(?:coin|buy))\s*(\d*\.?\d+)/) ?? num(/(\d*\.?\d+)\s*eth\s*each/),
    takeProfitX: num(/(?:tp|take\s*profit)(?:\s*at)?\s*(\d*\.?\d+)\s*x?/),
    stopPct: num(/(?:sl|stop(?:\s*loss)?)(?:\s*at)?\s*-?\s*(\d*\.?\d+)\s*%?/),
    maxOpen: num(/max(?:imum)?\s*(?:open\s*)?(\d+)/),
    maxBuysPerDay: num(/(\d+)\s*(?:buys?\s*)?(?:a|per)\s*day/),
  };
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v != null));
}

/* ---------- state ---------- */
export async function userOf(address) {
  const s = await store.readJson(STATE, blank());
  const u = s.users?.[address.toLowerCase()] || {};
  return { on: !!u.on, mode: u.mode === "live" ? "live" : "practice", rules: cleanRules(u.rules || {}), public: !!u.public, liveAvailable: LIVE_OK };
}
export async function setUser(address, patch) {
  if (patch.mode === "live") {
    if (!LIVE_OK) throw Object.assign(new Error("Live mode is not switched on on this server yet. Practice mode runs with play money at real prices."), { status: 400 });
    const aw = await getAgentWallet(address);
    if (!aw?.exists) throw Object.assign(new Error("Live mode trades from your Agent Wallet. Create one first (Agent → Wallet)."), { status: 400 });
  }
  let out;
  await store.update(STATE, blank(), (s) => {
    s.users ||= {}; const k = address.toLowerCase();
    const u = s.users[k] || { on: false, mode: "practice", rules: { ...DEFAULTS }, public: false };
    if ("on" in patch) u.on = !!patch.on;
    if (patch.mode === "live" || patch.mode === "practice") u.mode = patch.mode;
    if (patch.rules) u.rules = cleanRules(patch.rules, u.rules);
    if ("public" in patch) u.public = !!patch.public;
    u.updatedAt = Date.now();
    s.users[k] = u; out = { ...u };
  });
  return { ...out, rules: cleanRules(out.rules), liveAvailable: LIVE_OK };
}
export async function positionsOf(address, { open } = {}) {
  const s = await store.readJson(STATE, blank());
  return (s.positions || []).filter((p) => p.address === address.toLowerCase() && (open == null || (open ? p.status === "open" : p.status === "closed")));
}
export function stats(list) {
  const closed = list.filter((p) => p.status === "closed");
  const by = (mode) => { const c = closed.filter((p) => p.mode === mode); const pnl = c.reduce((a, p) => a + (p.pnlEth || 0), 0); const won = c.filter((p) => (p.pnlEth || 0) > 0).length; return { closed: c.length, pnlEth: pnl, winRate: c.length ? won / c.length : null, invested: c.reduce((a, p) => a + p.amountEth, 0) }; };
  return { practice: by("practice"), live: by("live"), open: list.filter((p) => p.status === "open").length };
}
async function savePosition(pos) {
  await store.update(STATE, blank(), (s) => {
    s.positions ||= [];
    const i = s.positions.findIndex((p) => p.id === pos.id);
    if (i >= 0) s.positions[i] = pos; else s.positions.push(pos);
    // keep it bounded: all open ones and the newest 5000 closed
    const closed = s.positions.filter((p) => p.status === "closed").sort((a, b) => b.closedAt - a.closedAt).slice(0, 5000);
    s.positions = [...s.positions.filter((p) => p.status === "open"), ...closed];
  });
}

/* ---------- entries: called by Sentry for every launch result ---------- */
export async function onLaunch(r) {
  if (!store || r?.v !== "passed" || !r.token) return [];
  const raised = r.pons && !r.pons.graduated && (r.pons.pair?.address === "native" || /ETH/i.test(r.pons.pair?.symbol || "")) ? Number(r.pons.raised) : null;
  if (raised == null) return [];
  const s = await store.readJson(STATE, blank());
  const opened = [];
  for (const [address, u] of Object.entries(s.users || {})) {
    if (!u.on) continue;
    const rules = cleanRules(u.rules || {});
    if (raised < rules.minRaisedEth) continue;
    const mine = (s.positions || []).filter((p) => p.address === address);
    if (mine.some((p) => p.token.toLowerCase() === r.token.toLowerCase())) continue;   // one buy per coin, ever (Sentry re-checks quiet launches)
    if (mine.filter((p) => p.status === "open").length >= rules.maxOpen) continue;
    if (mine.filter((p) => p.openedAt > Date.now() - 86400e3).length >= rules.maxBuysPerDay) continue;
    const pos = await open(address, u.mode === "live" && LIVE_OK ? "live" : "practice", r, rules).catch((e) => { console.warn("[autopilot] open", address.slice(0, 8), e.message); return null; });
    if (pos) opened.push(pos);
  }
  return opened;
}
async function open(address, mode, r, rules) {
  const q = await quoteSwap({ tokenIn: "ETH", tokenOut: r.token, amountIn: rules.buyEth, slippagePct: 3 });
  if (!(q.amountOut > 0)) throw new Error("no quote");
  const pos = { id: randomBytes(6).toString("hex"), address, mode, token: r.token, symbol: r.symbol || q.tokenOut?.symbol || "?", amountEth: rules.buyEth, tokens: q.amountOut, entryPriceEth: rules.buyEth / q.amountOut, raisedAtEntry: r.pons?.raised ?? null, rules: { takeProfitX: rules.takeProfitX, stopPct: rules.stopPct }, openedAt: Date.now(), status: "open" };
  if (mode === "live") {
    const awPre = await getAgentWallet(address);
    const pre = Number((await tokenBal(awPre.address, r.token))?.amount || 0);
    const ex = await executeForUser(address, { kind: "swap", params: { tokenIn: "ETH", tokenOut: r.token, amountIn: rules.buyEth, slippagePct: 3 }, rationale: `Sentry Autopilot: $${r.symbol} passed the Gate at ${Number(r.pons?.raised || 0).toFixed(2)} ETH raised`, source: "autopilot" });
    if (!ex.executed) { await dm(address, `<b>Sentry Autopilot skipped $${esc(pos.symbol)}.</b> ${esc((ex.reasons || [ex.result?.note || "Not sent."]).join(" ").slice(0, 200))}`); return null; }
    for (let i = 0; i < 6; i++) {
      const now = Number((await tokenBal(awPre.address, r.token))?.amount || 0);
      if (now - pre > q.amountOut * 0.5) { pos.tokens = now - pre; break; }
      await sleep(3000);
    }
    pos.entryPriceEth = rules.buyEth / pos.tokens;
    pos.txBuy = (ex.result?.steps || []).at(-1)?.hash || null;
  }
  await savePosition(pos);
  await dm(address, `<b>Sentry Autopilot${mode === "practice" ? " (practice)" : ""} bought $${esc(pos.symbol)}</b>\n${eth(pos.amountEth)} at ${Number(r.pons?.raised || 0).toFixed(2)} ETH raised. Troya Gate passed.\nTake profit at ${rules.takeProfitX}x, stop at -${rules.stopPct}%.${mode === "practice" ? "\nPlay money at real prices: nothing was sent." : ""}\n<code>${r.token}</code>`);
  return pos;
}

/* ---------- exits ---------- */
export function exitReason(pos, valueEth, now = Date.now()) {
  const ratio = valueEth / pos.amountEth;
  if (ratio >= pos.rules.takeProfitX) return "take-profit";
  if (ratio <= 1 - pos.rules.stopPct / 100) return "stop";
  if (now - pos.openedAt > MAX_AGE) return "7 days";
  return null;
}
export async function close(pos, reason, valueEth) {
  if (pos.mode === "live") {
    const aw = await getAgentWallet(pos.address);
    // a public RPC can lag right after the buy: wait until the coins show up before selling
    let h = null;
    for (let i = 0; i < 5; i++) {
      const b = await getBalances(aw.address, [pos.token]).catch(() => null);
      h = b?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === pos.token.toLowerCase()) || null;
      if (h && Number(h.amount) >= pos.tokens * 0.9) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!h || BigInt(h.raw) === 0n || Number(h.amount) < pos.tokens * 0.001) { pos.status = "closed"; pos.closedAt = Date.now(); pos.reason = "nothing left to sell"; pos.exitValueEth = 0; pos.pnlEth = -pos.amountEth; await savePosition(pos); return pos; }
    const amount = trunc(formatUnits(BigInt(h.raw), h.decimals));   // a decimal string, cut and never rounded above what it holds
    const before = await ethBal(aw.address);
    const ex = await executeForUser(pos.address, { kind: "swap", params: { tokenIn: pos.token, tokenOut: "ETH", amountIn: amount, slippagePct: 8 }, rationale: `Sentry Autopilot: ${reason} on $${pos.symbol}`, source: "autopilot" });
    if (!ex.executed) { pos.lastError = (ex.reasons || [ex.result?.note || "not sent"]).join(" ").slice(0, 200); await savePosition(pos); return null; }
    let after = NaN;
    for (let i = 0; i < 6; i++) { after = await ethBal(aw.address); if (isFinite(before) && after > before) break; await sleep(3000); }
    if (isFinite(before) && isFinite(after) && after > before) valueEth = after - before;   // what actually came back
    else if (!(valueEth > 0)) valueEth = await valueOf({ ...pos, tokens: Number(amount) }).catch(() => 0);
    pos.txSell = (ex.result?.steps || []).at(-1)?.hash || null;
  }
  pos.status = "closed"; pos.closedAt = Date.now(); pos.reason = reason; pos.exitValueEth = valueEth; pos.pnlEth = valueEth - pos.amountEth;
  await savePosition(pos);
  await dm(pos.address, `<b>Sentry Autopilot${pos.mode === "practice" ? " (practice)" : ""} sold $${esc(pos.symbol)}</b> · ${esc(reason)}\nIn ${eth(pos.amountEth)}, out ${eth(valueEth)} · ${pos.pnlEth >= 0 ? "+" : ""}${eth(pos.pnlEth)} (${((valueEth / pos.amountEth - 1) * 100).toFixed(1)}%)`);
  return pos;
}
export async function valueOf(pos) {
  // straight to the on-chain quote with the coin's address (19 Nov 2026): tools.quoteSwap first looked the coin up and built
  // its whole token page, up to ~30 s for a coin nobody had opened, which held up stops here and in the Arena
  const { quoteSwap: chainQuote } = await import("./robinhood.mjs");
  const q = await chainQuote({ tokenIn: pos.token, tokenOut: "ETH", amountIn: decStr(pos.tokens), slippageBps: 500 });
  return Number(q.amountOut) || 0;
}
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = await store.readJson(STATE, blank());
    for (const pos of (s.positions || []).filter((p) => p.status === "open")) {
      try {
        const v = await valueOf(pos);
        pos.lastValueEth = v; pos.lastCheck = Date.now();
        const why = exitReason(pos, v);
        if (why) await close(pos, why, v); else await savePosition(pos);
      } catch (e) {
        // a quote that keeps failing for a week still closes on time, at zero
        if (Date.now() - pos.openedAt > MAX_AGE) await close(pos, "7 days, no route", 0).catch(() => {});
        else { pos.lastError = String(e.message).slice(0, 160); await savePosition(pos).catch(() => {}); }
      }
    }
  } finally { ticking = false; }
}

/* ---------- Telegram ---------- */
export async function statusText(address) {
  const u = await userOf(address);
  const list = await positionsOf(address);
  const st = stats(list);
  const r = u.rules;
  const L = [`<b>Sentry Autopilot · ${u.on ? "on" : "off"} · ${u.mode === "live" ? "live (Agent Wallet)" : "practice (play money)"}</b>`,
    `Buys every Pons launch that passes Troya Gate with at least ${r.minRaisedEth} ETH raised: ${r.buyEth} ETH each, take profit at ${r.takeProfitX}x, stop at -${r.stopPct}%, at most ${r.maxOpen} open and ${r.maxBuysPerDay} buys a day.`];
  const open = list.filter((p) => p.status === "open");
  if (open.length) { L.push("", "<b>Open</b>"); for (const p of open.slice(0, 8)) L.push(`$${esc(p.symbol)} · in ${eth(p.amountEth)} · now ${eth(p.lastValueEth)}${p.lastValueEth ? ` (${((p.lastValueEth / p.amountEth - 1) * 100).toFixed(1)}%)` : ""}${p.mode === "practice" ? " · practice" : ""}`); }
  const fmt = (x) => `${x.closed} closed · ${x.pnlEth >= 0 ? "+" : ""}${eth(x.pnlEth)}${x.winRate != null ? ` · ${(x.winRate * 100).toFixed(0)}% won` : ""}`;
  L.push("", `Practice: ${fmt(st.practice)}`, `Live: ${fmt(st.live)}`);
  L.push("", `/autopilot ${u.on ? "off" : "on"} · /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3${u.liveAvailable ? ` · /autopilot ${u.mode === "live" ? "practice" : "live"}` : ""}`);
  if (!u.liveAvailable) L.push("Live mode opens after it passes real-money tests. Practice runs at real prices meanwhile.");
  return L.join("\n");
}
export async function command(address, arg) {
  const a = String(arg || "").trim();
  if (/^(on|off)$/i.test(a)) { await setUser(address, { on: /on/i.test(a) }); return statusText(address); }
  if (/^(live|practice)$/i.test(a)) { await setUser(address, { mode: a.toLowerCase() }); return statusText(address); }
  if (/^set\b/i.test(a) || /\d/.test(a)) {
    const rules = parseRules(a);
    if (!Object.keys(rules).length) return "Tell me the rules, like: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3";
    await setUser(address, { rules });
    return statusText(address);
  }
  return statusText(address);
}

/* ---------- web ---------- */
export async function register(r, ctx) {
  store = ctx.store;
  const { requireSession } = await import("./auth.mjs");
  r.get("/api/autopilot", async ({ req }) => {
    const s = requireSession(req);
    const list = await positionsOf(s.address);
    return { settings: await userOf(s.address), defaults: DEFAULTS, limits: LIMITS, positions: list.sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt)).slice(0, 100), stats: stats(list) };
  });
  r.post("/api/autopilot/settings", async ({ req, body }) => {
    const s = requireSession(req);
    try { return { settings: await setUser(s.address, { on: body.on, mode: body.mode, rules: body.rules, public: body.public, ...(body.on === undefined ? {} : {}) }) }; }
    catch (e) { const { HttpError } = await import("./api.mjs"); throw new HttpError(e.status || 400, e.message); }
  });
  r.post("/api/autopilot/close", async ({ req, body }) => {
    const s = requireSession(req);
    const pos = (await positionsOf(s.address, { open: true })).find((p) => p.id === String(body.id || ""));
    if (!pos) { const { HttpError } = await import("./api.mjs"); throw new HttpError(404, "No open position with that id."); }
    const v = await valueOf(pos).catch(() => 0);
    return { position: await close(pos, "closed by you", v) };
  });
  if (process.env.AUTOPILOT !== "0") setInterval(() => tick().catch((e) => console.warn("[autopilot]", e.message)), 60_000).unref();
}
export { tick as exitTick };
