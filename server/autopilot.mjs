// Phase 7 · Sentry Autopilot: your rules, run around the clock on every Pons launch that passes Troya Gate.
//   Rules per user: minRaisedEth (curve raised, ETH), buyEth, takeProfitX, stopPct, maxOpen, maxBuysPerDay.
//   Practice (default): play money at real prices. Entries and exits are quoted on chain the moment they happen; nothing
//   is sent. Live: the Agent Wallet buys and sells through executeForUser, so Troya Gate and the caps run again. Live
//   needs AUTOPILOT_LIVE=1 on the server, an Agent Wallet, and the user switching it on.
//   Exits are checked every 60 s: take-profit at takeProfitX, stop at -stopPct %, and anything still open after 7 days.
//   Telegram (via tgterm.mjs): /autopilot · on|off · practice|live · set min 1 buy 0.01 tp 2 sl 30 max 3
//   Web: Agent → Sentry Autopilot. Phase 9 reads the closed results of users who opted into the leaderboard.
//   Optional extra rules (24 Nov 2026, community request), all off by default (autopilot-rules.mjs): X check (the coin's
//   own X account is verified and shows its CA), site up, the dev side did not sell in the first minutes, and a buy in
//   USD converted to ETH at the live price. Each check's pass or fail is kept in the activity (data/autopilot-activity.json)
//   and sent with the buy or skip DM.   /autopilot set xcheck on site on devsell 1m 0% buy $10
import { randomBytes } from "node:crypto";
import { quoteSwap } from "./tools.mjs";
import { getAgentWallet, executeForUser, findLot, onLots } from "./agentwallet.mjs";
import { getBalances } from "./robinhood.mjs";
import { getPolicy } from "./policy.mjs";
import * as R from "./autopilot-rules.mjs";

const LIVE_OK = process.env.AUTOPILOT_LIVE === "1";
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const STATE = "autopilot.json";
const MAX_AGE = 7 * 86400e3;
// a live trade the trust ladder holds for the owner's yes (Approve, the default since 20 Nov 2026) is an inbox item and a
// Telegram message each time: a held exit is asked again at most every half hour, not on every 60 s tick
const ASK_AGAIN_MS = 30 * 60_000;
// the extra rules (R.EXTRA_DEFAULTS) are all off: a user who never sets one keeps exactly the rules of before
export const DEFAULTS = { minRaisedEth: 1, buyEth: 0.01, takeProfitX: 2, stopPct: 30, maxOpen: 3, maxBuysPerDay: 5, ...R.EXTRA_DEFAULTS };
const LIMITS = { minRaisedEth: [0, 4.2], buyEth: [0.001, 0.5], takeProfitX: [1.05, 50], stopPct: [5, 95], maxOpen: [1, 10], maxBuysPerDay: [1, 30], ...R.EXTRA_LIMITS };
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
// at most 15 significant digits, cut and never rounded up, so a Number of it stays at or below the balance
function trunc(s, sig = 15) {
  const [i, f = ""] = String(s).split(".");
  const intD = i.replace(/^0+/, "").length;
  if (intD >= sig) return i;
  const keep = intD ? sig - intD : sig + (f.match(/^0*/)[0].length);
  return f ? `${i}.${f.slice(0, keep)}`.replace(/\.?0+$/, "") || "0" : i;
}
export function useSender(fn) { sender = fn; }
export function init(st) { store = store || st; R.initRules(store); }
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
  for (const k of R.BOOL_KEYS) out[k] = input[k] != null ? input[k] === true || input[k] === "true" || input[k] === 1 : !!out[k];
  out.devEarlyMin = Math.round(out.devEarlyMin);
  // a dollar buy: 0 is off (the ETH amount), otherwise $1 to $1,000 in cents
  out.buyUsd = out.buyUsd > 0 ? Math.min(1000, Math.max(1, Math.round(out.buyUsd * 100) / 100)) : 0;
  return out;
}
// "min 1 buy 0.01 tp 2 sl 30 max 3", or plain words: "above 1 ETH raised, 0.01 ETH each, take profit at 2x, stop at -30%"
export function parseRules(text) {
  // the extra rules (xcheck on, site on, devsell 1m 0%, buy $10) are read first and taken out, so "devsell 2 min" never
  // reads as a 2 ETH minimum and "buy 10 usd" never as 10 ETH
  const ex = R.parseExtra(text);
  const t = ex.rest;
  const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const r = {
    minRaisedEth: num(/(?:min(?:imum)?|above|over|raised)\s*(?:of\s*)?(\d*\.?\d+)\s*(?:eth)?/) ?? num(/(\d*\.?\d+)\s*eth\s*raised/),
    buyEth: num(/(?:buy|each|size|per\s*(?:coin|buy))\s*(\d*\.?\d+)/) ?? num(/(\d*\.?\d+)\s*eth\s*each/),
    takeProfitX: num(/(?:tp|take\s*profit)(?:\s*at)?\s*(\d*\.?\d+)\s*x?/),
    stopPct: num(/(?:sl|stop(?:\s*loss)?)(?:\s*at)?\s*-?\s*(\d*\.?\d+)\s*%?/),
    maxOpen: num(/max(?:imum)?\s*(?:open\s*)?(\d+)/),
    maxBuysPerDay: num(/(\d+)\s*(?:buys?\s*)?(?:a|per)\s*day/),
    ...ex.rules,
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
  // a position whose coins were sold elsewhere has no result (pnlEth null): it is left out, never counted as a loss
  const by = (mode) => { const c = closed.filter((p) => p.mode === mode && p.pnlEth != null); const pnl = c.reduce((a, p) => a + (p.pnlEth || 0), 0); const won = c.filter((p) => (p.pnlEth || 0) > 0).length; return { closed: c.length, pnlEth: pnl, winRate: c.length ? won / c.length : null, invested: c.reduce((a, p) => a + p.amountEth, 0) }; };
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
const raisedOf = (r) => (r?.pons && !r.pons.graduated && (r.pons.pair?.address === "native" || /ETH/i.test(r.pons.pair?.symbol || "")) ? Number(r.pons.raised) : null);
export async function onLaunch(r) {
  if (!store || r?.v !== "passed" || !r.token) return [];
  const raised = raisedOf(r);
  if (raised == null) return [];
  const s = await store.readJson(STATE, blank());
  const opened = [];
  for (const [address, u] of Object.entries(s.users || {})) {
    if (!u.on) continue;
    // waiting out a coin's first minutes for the extra dev rule: the newer result is kept for the look after the wait
    const w = waits.get(`${address}:${r.token.toLowerCase()}`);
    if (w) { w.r = r; continue; }
    const pos = await consider(address, u, r, s, raised);
    if (pos) opened.push(pos);
  }
  return opened;
}
// one user and one coin: the rules of before, then (only when the user switched one on) the extra checks, then the buy
async function consider(address, u, r, s, raised, { attempt = 0 } = {}) {
  const rules = cleanRules(u.rules || {});
  if (raised < rules.minRaisedEth) return null;
  const mine = (s.positions || []).filter((p) => p.address === address);
  // a buy held for the owner's yes counts like a buy: one ask per coin, and inside the day's buys
  const asked = (s.asked || []).filter((a) => a.address === address);
  if (mine.some((p) => p.token.toLowerCase() === r.token.toLowerCase()) || asked.some((a) => a.token === r.token.toLowerCase())) return null;   // one buy per coin, ever (Sentry re-checks quiet launches)
  if (mine.filter((p) => p.status === "open").length >= rules.maxOpen) return null;
  if (mine.filter((p) => p.openedAt > Date.now() - 86400e3).length + asked.filter((a) => a.at > Date.now() - 86400e3).length >= rules.maxBuysPerDay) return null;
  const mode = u.mode === "live" && LIVE_OK ? "live" : "practice";
  let checks = [], buy = rules;
  if (R.anyCheck(rules)) {
    const born = r.ageMs != null && r.at ? r.at - r.ageMs : null;
    const ev = await R.evaluate(r, rules, { born, attempt }).catch((e) => ({ verdict: "fail", checks: [{ key: "rules", label: "Extra rules", status: "fail", detail: `The checks could not run (${String(e.message).slice(0, 80)}), so no buy` }] }));
    checks = ev.checks;
    if (ev.verdict === "wait") { waitFor(address, r, ev.waitUntil, attempt); await note(address, r, "waiting", checks, mode); return null; }
    if (ev.verdict !== "pass") { await note(address, r, "skipped", checks, mode); return null; }
  }
  if (rules.buyUsd > 0) {
    const z = await R.usdToEth(rules.buyUsd, LIMITS.buyEth);
    checks = [...checks, z.check];
    if (!z.ok) { await note(address, r, "skipped", checks, mode); return null; }
    buy = { ...rules, buyEth: z.eth, usd: { usd: rules.buyUsd, px: z.px } };
  }
  const pos = await open(address, mode, r, buy, checks).catch((e) => { console.warn("[autopilot] open", address.slice(0, 8), e.message); return null; });
  if (checks.length) await note(address, r, pos ? "bought" : "not bought", checks, mode, { dm: false });
  return pos;
}

/* ---------- the wait: a coin seen before its first minutes passed (the extra dev rule) ---------- */
// Kept in memory only: after a restart a waiting coin is simply not bought (the safe side), unless Sentry's own re-check
// of a quiet launch brings it here again. The look after the wait reads the curve again and runs every rule again.
const waits = new Map();          // `${address}:${token}` → { r, attempt, timer }
function waitFor(address, r, until, attempt) {
  const k = `${address}:${r.token.toLowerCase()}`;
  if (waits.has(k)) return;
  const ms = Math.max(5_000, Math.min(16 * 60_000, (until || Date.now() + 60_000) - Date.now()));
  const w = { r, attempt };
  w.timer = setTimeout(() => { waits.delete(k); lookAgain(address, w.r, attempt + 1).catch((e) => console.warn("[autopilot] wait", e.message)); }, ms);
  w.timer.unref?.();
  waits.set(k, w);
}
async function lookAgain(address, r, attempt) {
  const s = await store.readJson(STATE, blank());
  const u = s.users?.[address];
  if (!u?.on) return null;
  const pons = await R.deps.pons(r.token).catch(() => null);
  const r2 = pons ? { ...r, pons } : r;
  const raised = raisedOf(r2);
  if (raised == null) { await note(address, r2, "skipped", [{ key: "curve", label: "Curve", status: "fail", detail: pons?.graduated ? "The coin graduated while Autopilot waited" : "The curve could not be read again after the wait" }], u.mode === "live" && LIVE_OK ? "live" : "practice"); return null; }
  return consider(address, u, r2, s, raised, { attempt });
}
// tests: the waiting coins, and a look after the wait run now instead of on its timer
export const _waits = waits;
export async function _lookAgainNow(address, token) {
  const k = `${address.toLowerCase()}:${token.toLowerCase()}`, w = waits.get(k);
  if (!w) return null;
  clearTimeout(w.timer); waits.delete(k);
  return lookAgain(address.toLowerCase(), w.r, w.attempt + 1);
}

/* ---------- the activity: each extra check's pass or fail, for the app and the DMs ---------- */
const ACTIVITY = "autopilot-activity.json";
const SKIP_DMS_A_DAY = 12;
const MARK = { pass: "pass", fail: "FAIL", wait: "wait", "not-run": "not run" };
const checkLines = (checks) => checks.map((c) => `${MARK[c.status] || c.status} · ${esc(c.label)}: ${esc(c.detail)}`).join("\n");
async function note(address, r, outcome, checks, mode, { dm: sendDm = true } = {}) {
  const token = r.token.toLowerCase(), symbol = r.symbol || "?";
  let tell = false;
  await store.update(ACTIVITY, {}, (a) => {
    const list = a[address] || [];
    const top = list[0];
    // the same coin with the same answer again (Sentry's re-checks): the newest row is refreshed, not repeated
    if (top && top.token === token && top.outcome === outcome && JSON.stringify(top.checks.map((c) => [c.status, c.detail])) === JSON.stringify(checks.map((c) => [c.status, c.detail]))) { top.at = Date.now(); top.seen = (top.seen || 1) + 1; return a; }
    // one skip DM per coin, and at most SKIP_DMS_A_DAY a day: the rest are in the app's activity
    tell = sendDm && outcome === "skipped" && !list.some((x) => x.token === token && x.dm) && list.filter((x) => x.dm && x.at > Date.now() - 86400e3).length < SKIP_DMS_A_DAY;
    list.unshift({ at: Date.now(), token, symbol, outcome, mode, checks: checks.map(({ key, label, status, detail }) => ({ key, label, status, detail })), ...(tell ? { dm: true } : {}) });
    a[address] = list.slice(0, 40);
    return a;
  });
  if (tell) await dm(address, `<b>Sentry Autopilot${mode === "practice" ? " (practice)" : ""} skipped $${esc(symbol)}</b>: it passed Troya Gate, but not your extra rules.\n${checkLines(checks)}\n<code>${r.token}</code>`);
}
export async function activityOf(address) { return ((await store.readJson(ACTIVITY, {}))[address.toLowerCase()] || []).slice(0, 40); }

async function open(address, mode, r, rules, checks = []) {
  const q = await quoteSwap({ tokenIn: "ETH", tokenOut: r.token, amountIn: rules.buyEth, slippagePct: 3 });
  if (!(q.amountOut > 0)) throw new Error("no quote");
  const pos = { id: randomBytes(6).toString("hex"), address, mode, token: r.token, symbol: r.symbol || q.tokenOut?.symbol || "?", amountEth: rules.buyEth, tokens: q.amountOut, entryPriceEth: rules.buyEth / q.amountOut, raisedAtEntry: r.pons?.raised ?? null, rules: { takeProfitX: rules.takeProfitX, stopPct: rules.stopPct }, openedAt: Date.now(), status: "open" };
  if (rules.usd) { pos.amountUsd = rules.usd.usd; pos.ethUsd = rules.usd.px; }
  if (checks.length) pos.checks = checks.map((c) => ({ key: c.key, status: c.status }));
  if (mode === "live") {
    const awPre = await getAgentWallet(address);
    const pre = Number((await tokenBal(awPre.address, r.token))?.amount || 0);
    // the lot names this position in the Agent Wallet's lot ledger: its exit then sells these coins only, never the coins
    // Champions or the owner hold of the same launch (audit 3-10, 21 Nov 2026). A buy held for approval keeps the lot on
    // its proposal, so a buy approved later still becomes a position with its take-profit and stop (positionFromLot).
    const lot = { source: "autopilot", positionId: pos.id, meta: { symbol: pos.symbol, rules: pos.rules, raisedAtEntry: pos.raisedAtEntry } };
    const ex = await executeForUser(address, { kind: "swap", params: { tokenIn: "ETH", tokenOut: r.token, amountIn: rules.buyEth, slippagePct: 3 }, rationale: `Sentry Autopilot: $${r.symbol} passed the Gate at ${Number(r.pons?.raised || 0).toFixed(2)} ETH raised`, source: "autopilot", lot });
    // held by the trust ladder: executeForUser already put the ask in the inbox and on Telegram, so no "skipped" message
    // that contradicts it, and the coin is noted so Sentry's re-checks of the same launch do not ask again
    if (!ex.executed && ex.proposed) { await noteAsk(address, r.token); return null; }
    if (!ex.executed) { await dm(address, `<b>Sentry Autopilot skipped $${esc(pos.symbol)}.</b> ${esc((ex.reasons || [ex.result?.note || "Not sent."]).join(" ").slice(0, 200))}`); return null; }
    if (ex.lot?.tokens > 0) { pos.tokens = ex.lot.tokens; pos.lotId = ex.lot.id; }
    else for (let i = 0; i < 6; i++) {
      const now = Number((await tokenBal(awPre.address, r.token))?.amount || 0);
      if (now - pre > q.amountOut * 0.5) { pos.tokens = now - pre; break; }
      await sleep(3000);
    }
    pos.entryPriceEth = rules.buyEth / pos.tokens;
    pos.txBuy = (ex.result?.steps || []).at(-1)?.hash || null;
  }
  await savePosition(pos);
  await dm(address, `<b>Sentry Autopilot${mode === "practice" ? " (practice)" : ""} bought $${esc(pos.symbol)}</b>\n${eth(pos.amountEth)}${pos.amountUsd ? ` ($${pos.amountUsd} at $${Math.round(pos.ethUsd)} per ETH)` : ""} at ${Number(r.pons?.raised || 0).toFixed(2)} ETH raised. Troya Gate passed.${checks.length ? `\n${checkLines(checks)}` : ""}\nTake profit at ${rules.takeProfitX}x, stop at -${rules.stopPct}%.${mode === "practice" ? "\nPlay money at real prices: nothing was sent." : ""}\n<code>${r.token}</code>`);
  return pos;
}

async function noteAsk(address, token) {
  await store.update(STATE, blank(), (s) => {
    s.asked = [...(s.asked || []).filter((a) => a.at > Date.now() - MAX_AGE), { address, token: token.toLowerCase(), at: Date.now() }].slice(-5000);
  });
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
  let pnl = null;
  if (pos.mode === "live") {
    // asked a moment ago and still held (not on Auto): wait for the owner's yes instead of asking again every tick
    if (pos.exitAskedAt > Date.now() - ASK_AGAIN_MS && (await getPolicy(pos.address)).effective.trust !== "auto") { await savePosition(pos); return null; }
    // the lot ledger sells this position's own coins only (audit 3-10, 21 Nov 2026): until then this sold the wallet's
    // whole balance of the coin, Champions' coins of the same launch and the owner's own included, and the job that exited
    // second found "nothing left to sell" and booked -100%. A position from before the ledger sells at most its own
    // pos.tokens, and never coins another job's lot holds.
    const ex = await executeForUser(pos.address, { kind: "swap", params: { tokenIn: pos.token, tokenOut: "ETH", amountIn: decStr(pos.tokens), slippagePct: 8 }, rationale: `Sentry Autopilot: ${reason} on $${pos.symbol}`, source: "autopilot",
      lot: { source: "autopilot", positionId: pos.id, sell: true } });
    // already closed (Aegis sold the coin on a red alert) or nothing of it left (sold elsewhere): no made-up result
    if (ex.lotDone || ex.nothingToSell) return finishFromLot(pos, ex.lot || { how: "sold elsewhere", outEth: null, pnlEth: null });
    if (!ex.executed) { if (ex.proposed) { pos.exitAskedAt = Date.now(); pos.pendingReason = reason; } pos.lastError = (ex.reasons || [ex.proposed ? "Waiting for your approval in Agent → Scepter." : ex.result?.note || "not sent"]).join(" ").slice(0, 200); await savePosition(pos); return null; }
    if (ex.lot) return finishFromLot(pos, ex.lot, reason);
    // no lot (a position from before the ledger): the ETH the sell brought in, on the part of the position it sold
    if (ex.sale?.outEth != null) valueEth = ex.sale.outEth;
    const part = pos.tokens > 0 && ex.sale?.soldTokens > 0 ? Math.min(1, ex.sale.soldTokens / pos.tokens) : 1;
    pnl = valueEth - pos.amountEth * part;
    if (part < 0.999) reason = `${reason}, part sold elsewhere`;
    pos.txSell = (ex.result?.steps || []).at(-1)?.hash || null;
  }
  pos.status = "closed"; pos.closedAt = Date.now(); pos.reason = reason; pos.exitValueEth = valueEth; pos.pnlEth = pnl ?? valueEth - pos.amountEth;
  await savePosition(pos);
  await dm(pos.address, closedText(pos));
  return pos;
}
function closedText(pos) {
  const head = `<b>Sentry Autopilot${pos.mode === "practice" ? " (practice)" : ""} sold $${esc(pos.symbol)}</b> · ${esc(pos.reason)}`;
  // sold elsewhere: the coins left the Agent Wallet another way, so there is no result to report for this position
  if (pos.pnlEth == null) return `${head}\nIn ${eth(pos.amountEth)}. The coins were no longer in the Agent Wallet, so this position has no result.`;
  const cost = pos.exitValueEth - pos.pnlEth;                 // the cost of the part this position itself sold
  return `${head}\nIn ${eth(pos.amountEth)}, out ${eth(pos.exitValueEth)} · ${pos.pnlEth >= 0 ? "+" : ""}${eth(pos.pnlEth)}${cost > 0 ? ` (${((pos.exitValueEth / cost - 1) * 100).toFixed(1)}%)` : ""}`;
}
// a live position whose lot closed: by its own exit, by an exit approved later, by Aegis, or because the coins were gone
async function finishFromLot(pos, lot, reason = null) {
  // the lot hook and the exit tick can both see the same closed lot: the position closes (and messages the owner) once
  if ((await positionsOf(pos.address)).some((p) => p.id === pos.id && p.status === "closed")) return pos;
  const how = lot.how || "sold";
  pos.status = "closed"; pos.closedAt = Date.now();
  pos.reason = how === "sold" ? reason || pos.pendingReason || "sold" : how === "sold, part sold elsewhere" ? `${reason || pos.pendingReason || "sold"}, part sold elsewhere` : how;
  pos.exitValueEth = lot.outEth ?? null; pos.pnlEth = lot.pnlEth ?? null;
  if (lot.soldPct != null) pos.soldPct = lot.soldPct;
  pos.txSell = lot.txSell || pos.txSell || null;
  await savePosition(pos);
  await dm(pos.address, closedText(pos));
  return pos;
}
// a live buy held by the trust ladder and approved later: it becomes a position, with the take-profit and stop of the
// rules it was asked with, so it gets an exit like any other (until 21 Nov 2026 an approved buy had none)
async function positionFromLot(owner, lot) {
  const s = await store.readJson(STATE, blank());
  if ((s.positions || []).some((p) => p.id === lot.positionId)) return;
  const u = s.users?.[owner.toLowerCase()] || {};
  const rules = cleanRules(lot.meta?.rules || u.rules || {});
  const pos = { id: lot.positionId, address: owner.toLowerCase(), mode: "live", token: lot.token, symbol: lot.meta?.symbol || lot.symbol || "?", amountEth: lot.costEth, tokens: lot.tokens,
    entryPriceEth: lot.tokens > 0 ? lot.costEth / lot.tokens : null, raisedAtEntry: lot.meta?.raisedAtEntry ?? null, rules: { takeProfitX: rules.takeProfitX, stopPct: rules.stopPct },
    openedAt: Date.now(), status: "open", lotId: lot.id, txBuy: lot.txBuy || null, approvedLate: true };
  await savePosition(pos);
  await dm(owner, `<b>Sentry Autopilot bought $${esc(pos.symbol)}</b> (approved)\n${eth(pos.amountEth)}. Take profit at ${rules.takeProfitX}x, stop at -${rules.stopPct}%.\n<code>${lot.token}</code>`);
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
        // its lot already closed (Aegis sold the coin, or an exit approved later went through): close with that result
        if (pos.mode === "live") {
          const lot = await findLot(pos.address, "autopilot", pos.id).catch(() => null);
          if (lot && lot.status !== "open") { await finishFromLot(pos, lot); continue; }
        }
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
    `Buys every Pons launch that passes Troya Gate with at least ${r.minRaisedEth} ETH raised: ${r.buyUsd > 0 ? `$${r.buyUsd} each (in ETH at the live price)` : `${r.buyEth} ETH each`}, take profit at ${r.takeProfitX}x, stop at -${r.stopPct}%, at most ${r.maxOpen} open and ${r.maxBuysPerDay} buys a day.`];
  // the extra rules, only when one is on (the status reads exactly as before otherwise)
  const ex = R.extraText(r);
  if (ex.length) L.push(`Extra rules: ${ex.join("; ")}. A check that cannot be read counts as a no.`);
  const open = list.filter((p) => p.status === "open");
  if (open.length) { L.push("", "<b>Open</b>"); for (const p of open.slice(0, 8)) L.push(`$${esc(p.symbol)} · in ${eth(p.amountEth)} · now ${eth(p.lastValueEth)}${p.lastValueEth ? ` (${((p.lastValueEth / p.amountEth - 1) * 100).toFixed(1)}%)` : ""}${p.mode === "practice" ? " · practice" : ""}`); }
  const fmt = (x) => `${x.closed} closed · ${x.pnlEth >= 0 ? "+" : ""}${eth(x.pnlEth)}${x.winRate != null ? ` · ${(x.winRate * 100).toFixed(0)}% won` : ""}`;
  L.push("", `Practice: ${fmt(st.practice)}`, `Live: ${fmt(st.live)}`);
  L.push("", `/autopilot ${u.on ? "off" : "on"} · /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3${u.liveAvailable ? ` · /autopilot ${u.mode === "live" ? "practice" : "live"}` : ""}`);
  L.push("Optional: /autopilot set xcheck on · site on · devsell 1m 0% · buy $10 (each one off again with off, usd off for the ETH amount)");
  if (!u.liveAvailable) L.push("Live mode opens after it passes real-money tests. Practice runs at real prices meanwhile.");
  return L.join("\n");
}
export async function command(address, arg) {
  const a = String(arg || "").trim();
  if (/^(on|off)$/i.test(a)) { await setUser(address, { on: /on/i.test(a) }); return statusText(address); }
  if (/^(live|practice)$/i.test(a)) { await setUser(address, { mode: a.toLowerCase() }); return statusText(address); }
  if (/^set\b/i.test(a) || /\d/.test(a) || /\b(?:x\s*-?\s*check|blue\s*-?\s*check|site|website|dev\s*-?\s*sell|devsell|dev\s*early|usd)\b/i.test(a)) {
    const rules = parseRules(a);
    // an ETH amount set on its own switches a dollar buy back to the ETH amount
    if (rules.buyEth != null && rules.buyUsd == null) rules.buyUsd = 0;
    if (!Object.keys(rules).length) return "Tell me the rules, like: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3";
    await setUser(address, { rules });
    return statusText(address);
  }
  return statusText(address);
}

/* ---------- web ---------- */
export async function register(r, ctx) {
  store = ctx.store; R.initRules(store);
  // the Agent Wallet's lot ledger reports this job's lots: a held buy approved later becomes a position; a lot closed by
  // someone else (Aegis, or a held exit approved later) closes its position at once. Its own direct exits close() handles.
  onLots("autopilot", {
    opened: async (owner, lot, c) => { if (c?.approved) await positionFromLot(owner, lot); },
    closed: async (owner, lot, c) => {
      if (!c?.approved && c?.by === "autopilot") return;
      const pos = (await positionsOf(owner, { open: true })).find((p) => p.id === lot.positionId);
      if (pos) await finishFromLot(pos, lot);
    },
  });
  const { requireSession } = await import("./auth.mjs");
  r.get("/api/autopilot", async ({ req }) => {
    const s = requireSession(req);
    const list = await positionsOf(s.address);
    return { settings: await userOf(s.address), defaults: DEFAULTS, limits: LIMITS, activity: await activityOf(s.address), xBudget: await R.xBudgetToday(), positions: list.sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt)).slice(0, 100), stats: stats(list) };
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
