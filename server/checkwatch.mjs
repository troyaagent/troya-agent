// Check Watch (holder review idea E, 28 Nov 2026): a coin's Troya Check is run again by itself when something that matters
// changes on chain, instead of waiting for someone to ask. Watched: every coin checked in the last 14 days (newest first,
// up to 300) and every coin someone follows. Each pass reads a small fingerprint per coin:
//   · Pons coins: the creator fee recipient, the creator tax and whether it graduated (Pons factory and curve)
//   · every coin: the EIP-1967 implementation slot (a code upgrade) and owner() (ownership moved or renounced)
//   · the pool liquidity Troya's market board already holds (no extra call)
// A change is logged, the coin is checked again from scratch, and whoever follows it gets a Telegram note with the score
// before and after. Follow: /follow 0x… in a private chat with @TrojanTroya_bot, or the "Alert me" link on the coin's check
// page (t.me/TrojanTroya_bot?start=follow_0x…). The first read of a coin only records it: nothing fires on what was already
// there. Reads only; nothing here trades, signs or moves funds.
import { getAddress, isAddress } from "ethers";

const FILE = "check-watch.json";        // { fp: { addr: fingerprint }, events: [...], passAt }
const FOLLOWS = "check-follows.json";   // { chats: { chatId: [addr, ...] } }
const TICK_MS = 5 * 60_000;
const SLICE = 25;                       // coins read per pass besides the followed ones
const FOLLOWED_PER_PASS = 40;
const WINDOW = 14 * 86400e3;
const MAX_COINS = 300;
const PER_CHAT = 25;
const LIQ_DROP = 0.5;                   // pool liquidity at or under half of its reference
const LIQ_MIN_USD = 2000;               // smaller pools move too much to say anything
const RECHECK_GAP = 30 * 60_000;        // one re-check per coin per 30 minutes at most
const LIQ_GAP = 6 * 3600e3;             // one liquidity note per coin per 6 hours at most
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO32 = "0x" + "0".repeat(64);
const SITE = "https://troya.codes";
const BOT = "TrojanTroya_bot";

let store = null;
let state = { fp: {}, events: [], passAt: 0 };
let follows = { chats: {} };
let cursor = 0;
let busy = false;
const lc = (a) => String(a || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "–");
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const slotAddr = (s) => (s && s !== ZERO32 ? getAddress("0x" + s.slice(-40)) : null);

/** the coins followed by any chat, with how many chats follow each */
function followed() {
  const n = new Map();
  for (const list of Object.values(follows.chats || {})) for (const a of list || []) n.set(lc(a), (n.get(lc(a)) || 0) + 1);
  return n;
}

/** every coin checked in the last 14 days, newest first */
async function recentChecked(now) {
  const rows = await store.readJson("checks.json", []).catch(() => []);
  const seen = new Set(), out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < MAX_COINS; i--) {
    const r = rows[i];
    if (r?.kind !== "coin" || !r.address || now - (r.at || 0) > WINDOW) continue;
    const k = lc(r.address);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** a coin's fingerprint; a field that could not be read is undefined (kept from the last read, never an event) */
async function fingerprint(a) {
  const { rpc, ponsState } = await import("./robinhood.mjs");
  const [ps, slot, own] = await Promise.all([
    ponsState(a).then((v) => ({ v }), () => null),
    rpc("robinhood", "eth_getStorageAt", [a, IMPL_SLOT, "latest"], { bg: true }).then((s) => String(s || "").toLowerCase(), () => undefined),
    rpc("robinhood", "eth_call", [{ to: a, data: "0x8da5cb5b" }, "latest"], { bg: true }).then((s) => (/^0x[0-9a-f]{64}$/i.test(String(s || "")) ? lc(s) : undefined), () => undefined),
  ]);
  const M = await import("./market.mjs").catch(() => null);
  const row = M?.indexRow?.(a);
  const liq = row ? Number(row.realLiquidityUsd ?? row.liquidityUsd) : NaN;
  const p = ps?.v;
  return {
    pons: ps ? !!p : undefined,
    rec: p ? lc(p.creatorFeeRecipient) : undefined,
    tax: p ? Number(p.taxBps) : undefined,
    grad: p ? !!p.graduated : undefined,
    impl: slot && /^0x[0-9a-f]{64}$/.test(slot) ? slot : undefined,
    owner: own,
    liq: isFinite(liq) && liq > 0 ? Math.round(liq) : undefined,
    symbol: row?.symbol || null,
  };
}

/** what changed between two fingerprints, in words */
export function changesOf(old, cur, now = Date.now()) {
  const out = [];
  const both = (k) => old[k] !== undefined && old[k] !== null && cur[k] !== undefined;
  if (both("rec") && old.rec !== cur.rec) out.push({ kind: "fee-recipient", text: `The creator fee now goes to ${short(getAddress(cur.rec))} (it went to ${short(getAddress(old.rec))})` });
  if (both("tax") && old.tax !== cur.tax) out.push({ kind: "tax", text: `The creator tax changed from ${old.tax / 100}% to ${cur.tax / 100}%` });
  if (old.grad === false && cur.grad === true) out.push({ kind: "graduated", text: "It graduated from its bonding curve to a Uniswap v4 pool" });
  if (both("impl") && old.impl !== cur.impl) {
    const was = slotAddr(old.impl), now2 = slotAddr(cur.impl);
    out.push({ kind: "upgrade", text: !was ? `It became an upgradeable proxy (implementation ${short(now2)})` : !now2 ? `Its upgradeable proxy slot was cleared (was ${short(was)})` : `Its code was upgraded: implementation ${short(was)} → ${short(now2)}` });
  }
  if (both("owner") && old.owner !== cur.owner) {
    const to = slotAddr(cur.owner), from = slotAddr(old.owner);
    const dead = !to || /^0x0{36}dead$/i.test(lc(to));
    out.push({ kind: "owner", text: dead ? `Ownership was renounced (the owner was ${short(from)})` : `The owner changed from ${from ? short(from) : "none"} to ${short(to)}` });
  }
  if (old.liqRef >= LIQ_MIN_USD && cur.liq !== undefined && cur.liq <= old.liqRef * LIQ_DROP && now - (old.liqAt || 0) > LIQ_GAP) {
    out.push({ kind: "liquidity", text: `Pool liquidity fell from ${usd(old.liqRef)} to ${usd(cur.liq)}` });
  }
  return out;
}

async function tgSend(chat, text, markup = null) {
  const T = process.env.TELEGRAM_BOT_TOKEN;
  if (!T) return false;
  const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3800), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }),
  }).then((x) => x.json()).catch(() => null);
  // a chat that blocked the bot is dropped from the follow list
  if (r && !r.ok && /blocked|chat not found|deactivated/i.test(r.description || "")) await saveFollows((f) => { delete f.chats[String(chat)]; });
  return !!r?.ok;
}

async function saveState() { await store.writeJson(FILE, { ...state, events: state.events.slice(-500) }).catch((e) => console.warn("[checkwatch] save", e.message)); }
async function saveFollows(fn) {
  await store.update(FOLLOWS, { chats: {} }, (f) => { if (!f.chats) f.chats = {}; fn(f); follows = f; return f; });
}

/** a coin changed: check it again from scratch, keep the event, tell its followers */
async function recheck(a, list, fp) {
  const C = await import("./check.mjs");
  const rows = await store.readJson("checks.json", []).catch(() => []);
  const prev = C.latestChecks(rows).get(a);
  C.forget?.(a);
  const r = await C.checkForChat(getAddress(a), { via: "watch", budgetMs: 120_000, firstWaitMs: 60_000 }).catch(() => null);
  const after = r && C.complete(r) ? r.score : null;
  const ev = { at: Date.now(), address: getAddress(a), symbol: r?.symbol || fp.symbol || prev?.symbol || null, changes: list.map((c) => c.kind), text: list.map((c) => c.text).join("; "),
    before: prev?.score ?? null, after, label: after != null ? r.label : null };
  state.events.push(ev);
  const chats = Object.entries(follows.chats || {}).filter(([, l]) => (l || []).some((x) => lc(x) === a)).map(([c]) => c);
  if (chats.length) {
    const { text, markup } = alertMessage(ev);
    for (const c of chats) await tgSend(c, text, markup);
    ev.told = chats.length;
  }
  console.log(`[checkwatch] ${ev.symbol || a}: ${ev.text} · ${ev.before ?? "–"} → ${after ?? "–"} · told ${ev.told || 0}`);
  if (after == null && state.fp[a]) state.fp[a].retry = { at: Date.now(), evAt: ev.at, tries: 0 };
  return ev;
}

/** a re-check that ran out of time: read again, fill the event's score, and tell followers who got "checking it again" */
async function retryRecheck(a, now) {
  const f = state.fp[a], rt = f?.retry;
  if (!rt || now - rt.at < 5 * 60_000) return false;
  const C = await import("./check.mjs");
  const r = await C.checkForChat(getAddress(a), { via: "watch", budgetMs: 120_000, firstWaitMs: 60_000 }).catch(() => null);
  const ev = state.events.find((e) => lc(e.address) === a && e.at === rt.evAt);
  if (r && C.complete(r)) {
    delete f.retry;
    if (ev) {
      ev.after = r.score; ev.label = r.label;
      const chats = Object.entries(follows.chats || {}).filter(([, l]) => (l || []).some((x) => lc(x) === a)).map(([c]) => c);
      for (const c of chats) await tgSend(c, `<b>Troya Check Watch</b> · ${ev.symbol ? `$${esc(ev.symbol)}` : short(ev.address)}\nNew score after the change (${esc(ev.text)}): <b>${ev.before ?? "–"} → ${r.score}</b> (${esc(r.label || "")})`, { inline_keyboard: [[checkBtn(ev.address), stopBtn(ev.address)]] });
    }
    console.log(`[checkwatch] ${ev?.symbol || a}: re-check done · ${ev?.before ?? "–"} → ${r.score}`);
  } else if (++rt.tries >= 3) delete f.retry;
  else rt.at = now;
  return true;
}

async function tick() {
  if (busy || !store) return;
  busy = true;
  try {
    const now = Date.now();
    const fol = followed();
    const recent = (await recentChecked(now)).filter((a) => !fol.has(a));
    const others = recent.length ? Array.from({ length: Math.min(SLICE, recent.length) }, (_, i) => recent[(cursor + i) % recent.length]) : [];
    cursor = recent.length ? (cursor + SLICE) % recent.length : 0;
    const coins = [...[...fol.keys()].slice(0, FOLLOWED_PER_PASS), ...others];
    let rechecks = 0;
    for (const [a, f] of Object.entries(state.fp)) if (f.retry && rechecks < 2 && (await retryRecheck(a, now).catch(() => false))) rechecks++;
    for (const a of coins) {
      if (!isAddress(a)) continue;
      const cur = await fingerprint(a).catch(() => null);
      if (!cur || cur.pons === undefined) continue;
      const old = state.fp[a];
      if (!old) {
        state.fp[a] = { ...cur, liqRef: cur.liq ?? null, liqAt: 0, since: now, at: now };
        continue;
      }
      const list = changesOf(old, cur, now);
      // keep what was read; a field that failed this time keeps its last value
      const next = { ...old, at: now };
      for (const k of ["pons", "rec", "tax", "grad", "impl", "owner", "liq", "symbol"]) if (cur[k] !== undefined && cur[k] !== null) next[k] = cur[k];
      if (cur.liq !== undefined) next.liqRef = Math.max(cur.liq, old.liqRef || 0);
      if (list.some((c) => c.kind === "liquidity")) { next.liqRef = cur.liq; next.liqAt = now; }
      state.fp[a] = next;
      if (list.length && rechecks < 3 && now - (old.recheckAt || 0) > RECHECK_GAP) {
        rechecks++;
        state.fp[a].recheckAt = now;
        await recheck(a, list, cur).catch((e) => console.warn("[checkwatch] recheck", e.message));
      } else if (list.length) {
        state.events.push({ at: now, address: getAddress(a), symbol: cur.symbol, changes: list.map((c) => c.kind), text: list.map((c) => c.text).join("; "), before: null, after: null, queued: true });
      }
    }
    // coins nobody checked for 30 days and nobody follows are dropped from the fingerprints
    for (const [a, f] of Object.entries(state.fp)) if (now - (f.at || 0) > 30 * 86400e3 && !fol.has(a)) delete state.fp[a];
    state.passAt = now;
    await saveState();
  } finally { busy = false; }
}

// buttons: tapping one in a private chat follows or stops a coin without typing its address (callback data cw:f:/cw:u:)
const checkBtn = (a) => ({ text: "Troya Check", url: `${SITE}/check/${a}` });
export const followBtn = (a, isPrivate = true) => (isPrivate ? { text: "Alert me on changes", callback_data: `cw:f:${a}` } : { text: "Alert me on changes", url: `https://t.me/${BOT}?start=follow_${a}` });
const stopBtn = (a, label = "Stop alerts") => ({ text: label, callback_data: `cw:u:${a}` });

/** the Telegram note for one change (what changed, the score before and after, the page) */
export function alertMessage(ev, { sample = false } = {}) {
  const sym = ev.symbol ? `$${esc(ev.symbol)}` : short(ev.address);
  const score = ev.after != null ? `Troya checked it again: <b>${ev.before ?? "–"} → ${ev.after}</b> (${esc(ev.label || "")})` : "Troya is checking it again: the new score will be on its page shortly.";
  const head = sample ? "<b>Troya Check Watch</b> · sample note (nothing changed, this shows what an alert looks like)" : `<b>Troya Check Watch</b> · ${sym}`;
  return {
    text: `${head}\n${sample ? `Coin: ${sym}\n` : ""}What changed: ${esc(ev.text)}.\n${score}`,
    markup: { inline_keyboard: [[checkBtn(ev.address), stopBtn(ev.address)]] },
  };
}

/** a sample alert to one chat, so a follower sees the format before anything changes */
export async function sendSample(chat, address) {
  const a = getAddress(lc(address));
  const rows = await store.readJson("checks.json", []).catch(() => []);
  const C = await import("./check.mjs");
  const last = C.latestChecks(rows).get(lc(a));
  const ev = { address: a, symbol: last?.symbol || null, text: "The creator fee now goes to 0x1234…abcd (it went to 0x57b0…09E4)", before: last?.score ?? 74, after: Math.max(0, (last?.score ?? 74) - 16), label: "Some flags" };
  return tgSend(chat, alertMessage(ev, { sample: true }).text, alertMessage(ev).markup);
}

const symbols = async () => {
  const C = await import("./check.mjs");
  return C.latestChecks(await store.readJson("checks.json", []).catch(() => []));
};
async function followingView(chat) {
  const l = follows.chats[chat] || [];
  if (!l.length) return { text: "You don't follow any coin yet. /follow 0x… (or /follow $TICKER) and Troya tells you here when its fee recipient, code, owner or liquidity changes, with the new Troya Check." };
  const last = await symbols();
  const name = (a) => last.get(lc(a))?.symbol ? `$${last.get(lc(a)).symbol}` : short(a);
  return {
    text: `<b>You follow ${l.length} coin${l.length === 1 ? "" : "s"}</b>\n${l.map((a) => `${esc(name(a))} · <code>${a}</code>${last.get(lc(a))?.score != null ? ` · now ${last.get(lc(a)).score}` : ""}`).join("\n")}\n\nTap Stop under a coin to end its alerts.`,
    markup: { inline_keyboard: l.map((a) => [checkBtn(a), stopBtn(a, `Stop ${String(name(a)).slice(0, 24)}`)]) },
  };
}

/** a tap on Alert me / Stop (callback data cw:f:0x… or cw:u:0x…); private chats only */
export async function onCallback(cq, tg) {
  const m = /^cw:([fu]):(0x[0-9a-fA-F]{40})$/.exec(cq.data || "");
  const msg = cq.message;
  if (!m || !msg) return tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (msg.chat?.type !== "private") return tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Follow coins in a private chat with @${BOT}.`, show_alert: true });
  const chat = String(msg.chat.id), a = getAddress(lc(m[2]));
  const out = await botCommand(m[1] === "f" ? "follow" : "unfollow", a, { chat: msg.chat, from: cq.from }).catch(() => null);
  const text = String(out?.text || out || "");
  const toast = m[1] === "f" ? (/^(Following|Already following)/.test(text) ? "Following: alerts arrive in this chat." : text.replace(/<[^>]+>/g, "").slice(0, 190)) : "Stopped: no more alerts for this coin.";
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: toast });
  // the message the button sat on: a /following list is redrawn, any other message gets the opposite button
  if (/^You follow|^You don't follow/.test(String(msg.text || ""))) {
    const v = await followingView(chat);
    await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: v.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(v.markup ? { reply_markup: v.markup } : {}) }).catch(() => {});
  } else {
    const kb = (msg.reply_markup?.inline_keyboard || []).map((row) => row.map((b) => (b.callback_data === `cw:u:${a}` || b.callback_data === `cw:f:${a}` ? (m[1] === "f" ? stopBtn(a) : followBtn(a)) : b)));
    if (kb.length) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: kb } }).catch(() => {});
  }
  return true;
}

/** for the coin page (enrich): since when the coin is watched and what changed */
export function watchOf(address) {
  const a = lc(address), f = state.fp[a];
  const changes = state.events.filter((e) => lc(e.address) === a).slice(-8).reverse().map((e) => ({ at: e.at, text: e.text, changes: e.changes, before: e.before, after: e.after }));
  return { since: f?.since || null, changes, followers: followed().get(a) || 0 };
}

export function summary() {
  return {
    name: "Troya Check Watch", watching: Object.keys(state.fp).length, followedCoins: followed().size, followingChats: Object.keys(follows.chats || {}).length,
    lastPassAt: state.passAt || null, everyMinutes: TICK_MS / 60_000,
    watched: "creator fee recipient, creator tax, graduation, code upgrades (EIP-1967), owner, pool liquidity (falls by half)",
    events: state.events.slice(-25).reverse(),
    howToFollow: `/follow 0x… in a private chat with @${BOT}, or t.me/${BOT}?start=follow_0x…`,
  };
}

/** /follow, /unfollow and /following in a private chat with the bot */
export async function botCommand(cmd, arg, m) {
  const chat = String(m.chat.id);
  if (m.chat.type !== "private") {
    const a0 = (String(arg || "").match(/0x[0-9a-fA-F]{40}/) || [])[0];
    return `Follow a coin in a private chat with me, so the notes reach only you: <a href="https://t.me/${BOT}?start=follow_${a0 || ""}">open the chat</a>`;
  }
  const mine = () => (follows.chats[chat] || []);
  if (cmd === "following") return followingView(chat);
  let a = (String(arg || "").match(/0x[0-9a-fA-F]{40}/) || [])[0];
  // a bare /unfollow: the only followed coin is stopped at once; with several, each one's command ready to copy
  if (!a && cmd === "unfollow" && !String(arg || "").trim()) {
    const l = mine();
    if (!l.length) return "You don't follow any coin. /follow 0x… to start.";
    if (l.length === 1) a = l[0];
    else return followingView(chat);
  }
  if (!a) {
    const tk = (/\$?([A-Za-z][A-Za-z0-9]{0,15})\b/.exec(String(arg || "").trim()) || [])[1];
    if (!tk) return `Usage: /${cmd} 0x… (a coin on Robinhood Chain), or /${cmd} $TICKER`;
    const t = await (await import("./check.mjs")).resolveTicker(tk);
    if (t.none) return `No coin called ${esc(tk)} found on Robinhood Chain. Send /${cmd} with its contract address.`;
    if (t.many) return `${t.many} contracts on Robinhood Chain use ${esc(tk)}, so Troya won't pick one. Send /${cmd} with the address you mean.`;
    a = t.address;
  }
  a = getAddress(lc(a));
  if (cmd === "unfollow") {
    let had = false;
    await saveFollows((f) => { const l = f.chats[chat] || []; had = l.some((x) => lc(x) === lc(a)); f.chats[chat] = l.filter((x) => lc(x) !== lc(a)); if (!f.chats[chat].length) delete f.chats[chat]; });
    const sym = (await symbols()).get(lc(a))?.symbol;
    const who = `${sym ? `$${esc(sym)} ` : ""}<code>${a}</code>`;
    return { text: had ? `Stopped: no more alerts for ${who}.` : `You were not following ${who}.`, markup: { inline_keyboard: [[checkBtn(a), { ...followBtn(a), text: had ? "Alert me again" : "Alert me on changes" }]] } };
  }
  const { ponsState } = await import("./robinhood.mjs");
  const C = await import("./check.mjs");
  const known = (await store.readJson("checks.json", []).catch(() => [])).some((r) => lc(r.address) === lc(a));
  const isPons = known || (await ponsState(a).then((v) => !!v, () => false));
  if (!isPons) return `Troya has not checked <code>${a}</code> yet. Send /check ${a} first, then /follow it.`;
  let full = false, already = false;
  await saveFollows((f) => {
    const l = f.chats[chat] || [];
    if (l.some((x) => lc(x) === lc(a))) { already = true; return; }
    if (l.length >= PER_CHAT) { full = true; return; }
    f.chats[chat] = [...l, a];
  });
  if (full) return `You follow ${PER_CHAT} coins already. /following lists them; /unfollow one to add another.`;
  const last = C.latestChecks(await store.readJson("checks.json", []).catch(() => [])).get(lc(a));
  return {
    text: `${already ? "Already following" : "Following"} <code>${a}</code>${last?.symbol ? ` ($${esc(last.symbol)})` : ""}.
Troya reads it every few minutes and tells you here when the creator fee recipient or tax changes, its code is upgraded, the owner changes or its pool liquidity halves, with a fresh Troya Check${last?.score != null ? ` (now ${last.score}, ${esc(last.label || "")})` : ""}.
/following lists your coins`,
    markup: { inline_keyboard: [[checkBtn(a), stopBtn(a)]] },
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  state = await store.readJson(FILE, { fp: {}, events: [], passAt: 0 }).catch(() => state);
  if (!state.fp) state.fp = {};
  if (!Array.isArray(state.events)) state.events = [];
  follows = await store.readJson(FOLLOWS, { chats: {} }).catch(() => follows);
  if (!follows.chats) follows.chats = {};
  // a re-check cut short by a restart (no score after it, in the last 6 hours) is tried again
  for (const e of state.events.slice(-50)) {
    const k = lc(e.address), f = state.fp[k];
    if (f && !f.retry && !e.queued && e.after == null && Date.now() - e.at < 6 * 3600e3) f.retry = { at: 0, evAt: e.at, tries: 0 };
  }
  r.get("/api/checkwatch", () => summary(), { weight: 1, perMin: 60 });
  if (process.env.CHECK_WATCH === "0") return;
  setTimeout(() => tick().catch((e) => console.warn("[checkwatch]", e.message)), 45_000).unref?.();
  setInterval(() => tick().catch((e) => console.warn("[checkwatch]", e.message)), TICK_MS).unref?.();
}

export const _test = { changesOf, fingerprint, setStore: (s) => { store = s; }, setState: (s) => { state = s; }, setFollows: (f) => { follows = f; } };
