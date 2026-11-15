// Phase 2 · trade from a private chat with the bot, through the owner's Agent Wallet.
//   TG_TRADE=1 turns it on. Off: these messages fall through to the normal bot replies.
// Rules
// · Private chat only, and only for a chat linked to a wallet (app → Settings → Telegram alerts → Link Telegram, the same
//   one-time link the alerts use). The group never trades.
// · The card shows the same Gate the Agent Wallet runs at execution (tools.quoteSwap + tools.gateSwap, with the owner's
//   policy), so what you see is what decides. Buy is offered only when it passes. executeForUser quotes, gates and checks
//   the caps again at the moment it sends.
// · Every trade is two taps: pick an amount, then Confirm (60 s). Callback data is an opaque id kept here, never the
//   parameters, and only the chat it was issued to can use it. One execution per chat at a time.
// Token names come from the internet: cleaned of links and handles, HTML-escaped.
import { randomBytes } from "node:crypto";
import { isAddress, getAddress, formatUnits } from "ethers";
import { getBalances, ponsState, ponsPublic } from "./robinhood.mjs";
import { quoteSwap, gateSwap, ethUsd } from "./tools.mjs";
import { executeForUser, getAgentWallet } from "./agentwallet.mjs";
import { cleanName, cleanSymbol } from "./sentry.mjs";

export const ON = process.env.TG_TRADE === "1";
const SITE = "https://troya.codes";
const SCAN = "https://robinhoodchain.blockscout.com";
const BUYS = ["0.01", "0.02", "0.05"];
const SELLS = [25, 50, 100];
const PICK_TTL = 10 * 60_000, CONFIRM_TTL = 60_000;
const pend = new Map();               // id → { chat, owner, token, act, amt, pct, sym, step, exp }
const busy = new Set();               // chats with an execution in flight

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fnum = (v, d = 4) => (v == null || !isFinite(v) ? "–" : Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toPrecision(d));
function issue(p, ttl) {
  const now = Date.now();
  for (const [k, v] of pend) if (v.exp < now) pend.delete(k);
  const id = randomBytes(6).toString("hex");
  pend.set(id, { ...p, exp: now + ttl });
  return `tt:${id}`;
}
async function ownerOf(store, chatId) {
  const t = await store.readJson("telegram.json", { links: {}, codes: {} });
  return Object.entries(t.links || {}).find(([, c]) => String(c) === String(chatId))?.[0] || null;
}

/* ---------- messages ---------- */
const LINK_FIRST = `<b>Link this chat to your wallet first.</b>

1. Open troya.codes/agent and connect your wallet
2. Settings → Telegram alerts → Link Telegram
3. Tap Start in the chat it opens

Then paste a coin here again.`;
const WALLET_FIRST = `<b>You need an Agent Wallet to trade here.</b>

It is a small hot wallet that only you can withdraw from, with caps you set per trade and per day. Create it in the app (Agent → Wallet), set the caps, then send it a little ETH on Robinhood Chain.

Then paste a coin here again.`;
const appBtn = (path = "/agent#/agent/wallet") => ({ inline_keyboard: [[{ text: "Open Troya", url: SITE + path }]] });

async function walletText(owner) {
  const aw = await getAgentWallet(owner);
  if (!aw?.exists) return { text: WALLET_FIRST, markup: appBtn() };
  const b = await getBalances(aw.address).catch(() => null);
  const eth = b?.balances?.find((x) => x.address === "native");
  const ep = (await ethUsd().catch(() => 0)) || 0;
  const caps = aw.caps || {};
  return {
    text: `<b>Your Agent Wallet</b>\n<code>${aw.address}</code>\n\nBalance: ${eth ? fnum(Number(eth.amount)) : "–"} ETH${eth && ep ? ` (≈$${(Number(eth.amount) * ep).toFixed(2)})` : ""}\nPer trade: ${caps.perTradeUsd != null ? "$" + caps.perTradeUsd : "your policy"} · Per day: ${caps.dailyUsd != null ? "$" + caps.dailyUsd : "your policy"}\nStatus: ${aw.enabled ? "on" : "switched off"}\n\nTop up by sending ETH on Robinhood Chain to the address above. Withdrawals only go back to your own wallet.`,
    markup: appBtn(),
  };
}

// the trade card: the Agent Wallet's own Gate on a 0.01 ETH buy, the curve, what you hold, and the buttons
async function card(chat, owner, token) {
  const aw = await getAgentWallet(owner);
  const q = await quoteSwap({ tokenIn: "ETH", tokenOut: token, amountIn: Number(BUYS[0]), slippagePct: 3 });
  const [g, ps, bal] = await Promise.all([gateSwap(q), ponsState(token).catch(() => null), getBalances(aw.address, [token]).catch(() => null)]);
  const sym = cleanSymbol(q.tokenOut?.symbol) || "coin", name = cleanName(q.tokenOut?.name);
  const pons = ponsPublic(ps);
  const held = bal?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === token.toLowerCase());
  const heldN = held ? Number(held.amount) : 0;
  const eth = bal?.balances?.find((x) => x.address === "native");
  const fails = g.checks.filter((c) => c.status === "fail");
  const lines = [`<b>$${esc(sym)}</b>${name && name.toUpperCase() !== sym.toUpperCase() ? ` · ${esc(name)}` : ""}`];
  lines.push(`Troya Gate: <b>${g.pass ? "Passed" : "Blocked"}</b>${fails[0] ? ` · ${esc(fails[0].name)}` : ""}`);
  for (const c of g.checks.slice(0, 8)) lines.push(`${c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : "!"} ${esc(c.name)}: ${esc(String(c.detail).slice(0, 90))}`);
  if (pons && !pons.graduated) lines.push(`Curve: ${fnum(pons.raised, 3)} ${esc(pons.pair?.symbol || "ETH")} raised · ${pons.progressPct != null ? pons.progressPct.toFixed(2) : "–"}% to graduation`);
  lines.push(`<code>${token}</code>`);
  lines.push(`\nAgent Wallet: ${eth ? fnum(Number(eth.amount)) : "–"} ETH${heldN > 0 ? ` · holds ${fnum(heldN)} $${esc(sym)}` : ""}`);
  if (g.pass && (!eth || Number(eth.amount) < Number(BUYS[0]) * 1.05)) lines.push("Top up first: /wallet shows your Agent Wallet address.");
  lines.push(g.pass ? "Pick an amount, then confirm. The Gate runs again before it sends." : "Buying is locked while a check fails.");
  const rows = [];
  const base = { chat, owner, token, sym };
  if (g.pass) rows.push(BUYS.map((a) => ({ text: `Buy ${a} ETH`, callback_data: issue({ ...base, act: "buy", amt: a, step: "pick" }, PICK_TTL) })));
  else rows.push([{ text: "Buy locked · why", callback_data: issue({ ...base, step: "why", why: fails.map((c) => `${c.name}: ${c.detail}`).join("\n").slice(0, 190) || "A check failed." }, PICK_TTL) }]);
  if (heldN > 0) rows.push(SELLS.map((p) => ({ text: `Sell ${p}%`, callback_data: issue({ ...base, act: "sell", pct: p, raw: held.raw, dec: held.decimals, step: "pick" }, PICK_TTL) })));
  rows.push([{ text: "Refresh", callback_data: issue({ ...base, step: "refresh" }, PICK_TTL) }, { text: "Full check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${token}` }]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

/* ---------- entry points (called from inbox.mjs) ---------- */
// returns true when the message was a trade message and has been answered
export async function handleMessage(m, tg, store) {
  if (!ON || !m?.chat) return false;
  const text = String(m.text || "").trim();
  const deep = /^\/start\s+t_(0x[0-9a-fA-F]{40})$/.exec(text);
  const cmd = /^\/(trade|wallet)(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
  const bare = /^(0x[0-9a-fA-F]{40})$/.exec(text);
  if (!deep && !cmd && !bare) return false;
  if (m.chat.type !== "private") {
    if (!cmd) return false;                                          // a pasted address in the group stays the group's business
    await tg("sendMessage", { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: "Trading happens in a private chat with me, never in the group.", reply_markup: { inline_keyboard: [[{ text: "Open a private chat", url: "https://t.me/TrojanTroya_bot" }]] } }).catch(() => {});
    return true;
  }
  const chat = m.chat.id;
  const owner = await ownerOf(store, chat);
  if (!owner) { await tg("sendMessage", { chat_id: chat, text: LINK_FIRST, parse_mode: "HTML", reply_markup: appBtn("/agent") }); return true; }
  if (cmd && cmd[1].toLowerCase() === "wallet") { const w = await walletText(owner); await tg("sendMessage", { chat_id: chat, text: w.text, parse_mode: "HTML", reply_markup: w.markup }); return true; }
  const raw = deep?.[1] || bare?.[1] || cmd?.[2];
  if (!raw || !isAddress(raw)) { await tg("sendMessage", { chat_id: chat, text: "Send a coin address on Robinhood Chain, like /trade 0x…" }); return true; }
  const aw = await getAgentWallet(owner);
  if (!aw?.exists) { await tg("sendMessage", { chat_id: chat, text: WALLET_FIRST, parse_mode: "HTML", reply_markup: appBtn() }); return true; }
  const token = getAddress(raw);
  const wait = await tg("sendMessage", { chat_id: chat, text: "Running Troya Gate…" }).catch(() => null);
  try {
    const c = await card(chat, owner, token);
    const mid = wait?.result?.message_id;
    if (mid) await tg("editMessageText", { chat_id: chat, message_id: mid, text: c.text, parse_mode: "HTML", reply_markup: c.markup, link_preview_options: { is_disabled: true } });
    else await tg("sendMessage", { chat_id: chat, text: c.text, parse_mode: "HTML", reply_markup: c.markup, link_preview_options: { is_disabled: true } });
  } catch (e) {
    await tg("sendMessage", { chat_id: chat, text: `Could not check that coin: ${String(e.message).slice(0, 200)}` });
  }
  return true;
}

// returns true when the callback belonged to trading
export async function handleCallback(cq, tg) {
  if (!String(cq?.data || "").startsWith("tt:")) return false;
  const ans = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const id = cq.data.slice(3), p = pend.get(id);
  if (!ON) { await ans("Trading in Telegram is switched off right now."); return true; }
  if (!p || p.exp < Date.now()) { await ans("This button expired. Paste the coin again.", true); return true; }
  const chat = cq.message?.chat?.id, mid = cq.message?.message_id;
  if (String(cq.from?.id) !== String(p.chat) || String(chat) !== String(p.chat)) { await ans("These buttons belong to someone else's chat."); return true; }
  const edit = (text, markup) => tg("editMessageText", { chat_id: chat, message_id: mid, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } }).catch(() => {});

  if (p.step === "why") { await ans(p.why, true); return true; }
  if (p.step === "refresh" || p.step === "cancel") {
    pend.delete(id); await ans("Checking again…");
    try { const c = await card(p.chat, p.owner, p.token); await edit(c.text, c.markup); } catch (e) { await edit(`Could not check that coin: ${esc(String(e.message).slice(0, 200))}`); }
    return true;
  }
  if (p.step === "pick") {
    pend.delete(id);
    const what = p.act === "buy" ? `Buy <b>${p.amt} ETH</b> of $${esc(p.sym)}` : `Sell <b>${p.pct}%</b> of your $${esc(p.sym)}`;
    const aw = await getAgentWallet(p.owner);
    await ans();
    await edit(`${what} with your Agent Wallet ${aw?.address ? short(aw.address) : ""}?\n\nThe Gate, your policy and the Agent Wallet caps are checked again before it sends. This button works for 60 seconds.`,
      { inline_keyboard: [[{ text: "Confirm", callback_data: issue({ ...p, step: "confirm" }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...p, step: "cancel" }, PICK_TTL) }]] });
    return true;
  }
  if (p.step === "confirm") {
    if (busy.has(p.chat)) { await ans("Already sending one. Wait for it to finish."); return true; }
    pend.delete(id); busy.add(p.chat);
    await ans("Sending…");
    await edit(`${p.act === "buy" ? `Buying ${p.amt} ETH of` : `Selling ${p.pct}% of`} $${esc(p.sym)}… the Gate is running again.`);
    try {
      const params = p.act === "buy"
        ? { tokenIn: "ETH", tokenOut: p.token, amountIn: Number(p.amt), slippagePct: 3 }
        : { tokenIn: p.token, tokenOut: "ETH", amountIn: Number(formatUnits((BigInt(p.raw) * BigInt(p.pct)) / 100n, p.dec)), slippagePct: 5 };
      if (!(params.amountIn > 0)) throw new Error("Nothing to sell.");
      const r = await executeForUser(p.owner, { kind: "swap", params, rationale: `Telegram: confirmed ${p.act} in private chat`, source: "telegram" });
      let out;
      if (r.blocked) out = `<b>Not sent.</b> ${esc(r.summary)}\n${r.reasons.map((x) => "· " + esc(String(x).slice(0, 160))).join("\n")}`;
      else if (!r.executed) out = `<b>Built, not sent</b> (test mode on this server). ${esc(r.summary)}`;
      else {
        const steps = r.result?.steps || [], last = steps[steps.length - 1] || {};
        const st = last.status === "confirmed" ? "Done" : last.status === "reverted" ? "Reverted on chain" : "Sent, waiting for the chain";
        out = `<b>${st}.</b> ${esc(r.summary)}${last.hash ? `\n<a href="${SCAN}/tx/${last.hash}">${short(last.hash)}</a>` : ""}`;
      }
      const again = { inline_keyboard: [[{ text: "Refresh", callback_data: issue({ ...p, step: "refresh" }, PICK_TTL) }, { text: "Journal in Troya", url: `${SITE}/agent#/agent/wallet` }]] };
      await edit(out, again);
    } catch (e) {
      await edit(`<b>Not sent.</b> ${esc(String(e.message).slice(0, 220))}`, { inline_keyboard: [[{ text: "Refresh", callback_data: issue({ ...p, step: "refresh" }, PICK_TTL) }]] });
    } finally { busy.delete(p.chat); }
    return true;
  }
  await ans();
  return true;
}

// deep link a Sentry post can carry: opens the private chat with this coin loaded
export const tradeLink = (token) => `https://t.me/${process.env.TG_BOT_USERNAME || "TrojanTroya_bot"}?start=t_${token}`;
