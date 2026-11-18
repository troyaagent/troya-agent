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
// Buy buttons in ETH; TG_TRADE_BUYS="0.005,0.01,0.02" overrides (three amounts, each between 0.0005 and 1 ETH)
const envBuys = (process.env.TG_TRADE_BUYS || "").split(",").map((x) => x.trim()).filter((x) => /^\d*\.?\d+$/.test(x) && +x >= 0.0005 && +x <= 1).slice(0, 4);
const BUYS = envBuys.length >= 3 ? envBuys : ["0.001", "0.005", "0.01", "0.05"];
const SELLS = [25, 50, 75, 100];
// slippage, picked per chat on the card (1, 3, 5 or 10%); sells used 5% and buys 3% before a pick
const SLIPS = [1, 3, 5, 10];
const slip = new Map();               // chat → %
const slipFor = (chat, act) => slip.get(String(chat)) ?? (act === "sell" ? 5 : 3);
const GAS_KEEP = 0.0003;              // left in the Agent Wallet by "Max" for gas (Troya refunds gas afterwards)
let STORE = null;
const PICK_TTL = 10 * 60_000, CONFIRM_TTL = 60_000;
const pend = new Map();               // id → { chat, owner, token, act, amt, pct, sym, step, exp }
const busy = new Set();               // chats with an execution in flight

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// keep at most 15 significant digits by cutting, never rounding up (a Number of the result stays at or below the input)
export function trunc(s, sig = 15) {
  const [i, f = ""] = String(s).split(".");
  const intD = i.replace(/^0+/, "").length;
  if (intD >= sig) return i;
  const keep = intD ? sig - intD : sig + (f.match(/^0*/)[0].length);
  return f ? `${i}.${f.slice(0, keep)}`.replace(/\.?0+$/, "") || "0" : i;
}
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

async function holderLine(owner) {
  const hp = await import("./holders.mjs").catch(() => null);
  if (!hp) return "";
  const h = await hp.holderOf(owner).catch(() => null);
  if (!h) return "";
  const n = (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
  if (h.holder && h.on) return `Holder perks: on (${n(h.balance)} $TROYA)\n`;
  if (h.holder) return `Holder perks: from ${new Date(h.start).toISOString().slice(0, 16).replace("T", " ")} UTC (${n(h.balance)} $TROYA)\n`;
  return `Holder perks from ${n(h.min)} $TROYA (you hold ${n(h.balance)})\n`;
}
async function walletText(owner) {
  const aw = await getAgentWallet(owner);
  if (!aw?.exists) return { text: WALLET_FIRST, markup: appBtn() };
  const b = await getBalances(aw.address).catch(() => null);
  const eth = b?.balances?.find((x) => x.address === "native");
  const ep = (await ethUsd().catch(() => 0)) || 0;
  const caps = aw.caps || {};
  return {
    text: `<b>Your Agent Wallet</b>\n<code>${aw.address}</code>\n${await holderLine(owner)}\nBalance: ${eth ? fnum(Number(eth.amount)) : "–"} ETH${eth && ep ? ` (≈$${(Number(eth.amount) * ep).toFixed(2)})` : ""}\nPer trade: ${caps.perTradeUsd != null ? "$" + caps.perTradeUsd : "your policy"} · Per day: ${caps.dailyUsd != null ? "$" + caps.dailyUsd : "your policy"}\nStatus: ${aw.enabled ? "on" : "switched off"}\n\nTop up by sending ETH on Robinhood Chain to the address above. Withdrawals only go back to your own wallet.`,
    markup: appBtn(),
  };
}

// the trade card: the Agent Wallet's own Gate on a 0.01 ETH buy, the curve, what you hold, and the buttons
// what each trade here really moved (the Agent Wallet's balances read before and after), per wallet and coin, so the card
// can show the result of a trade and the running profit or loss (owner, 18 Nov: "informasi keuntungan kerugian")
const LEDGER = "tg-trades.json";
async function balOf(addr, token) {
  const b = await getBalances(addr, [token]);
  const t = b.balances.find((x) => x.address !== "native" && x.address.toLowerCase() === token.toLowerCase());
  return { eth: Number(b.balances.find((x) => x.address === "native")?.amount || 0), tok: t ? Number(t.amount) : 0 };
}
async function ledgerOf(owner, token) {
  if (!STORE) return null;
  const l = (await STORE.readJson(LEDGER, [])).filter((x) => x.owner === owner.toLowerCase() && x.token === token.toLowerCase());
  if (!l.length) return null;
  return { spent: l.reduce((a, x) => a + (x.ethIn || 0), 0), back: l.reduce((a, x) => a + (x.ethOut || 0), 0), trades: l.length };
}
// a coin this wallet launched through Troya (its creator may buy it while the curve is empty)
async function launchedBy(owner, token) {
  if (!STORE) return null;
  return (await STORE.readJson("launches.json", [])).find((x) => String(x.token).toLowerCase() === token.toLowerCase() && String(x.owner).toLowerCase() === owner.toLowerCase()) || null;
}
async function card(chat, owner, token) {
  const aw = await getAgentWallet(owner);
  const q = await quoteSwap({ tokenIn: "ETH", tokenOut: token, amountIn: Number(BUYS[0]), slippagePct: slipFor(chat, "buy") });
  const [g, ps, bal] = await Promise.all([gateSwap(q), ponsState(token).catch(() => null), getBalances(aw.address, [token]).catch(() => null)]);
  const sym = cleanSymbol(q.tokenOut?.symbol) || "coin", name = cleanName(q.tokenOut?.name);
  const pons = ponsPublic(ps);
  const held = bal?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === token.toLowerCase());
  const heldN = held ? Number(held.amount) : 0;
  const eth = bal?.balances?.find((x) => x.address === "native");
  const fails0 = g.checks.filter((c) => c.status === "fail");
  // the creator's own coin: an empty curve is expected right after launch, so pool depth alone does not lock the buy
  const mine = await launchedBy(owner, token).catch(() => null);
  const fails = mine ? fails0.filter((c) => !/^pool depth$/i.test(String(c.name || ""))) : fails0;
  const canBuy = fails.length === 0 && (g.pass || mine);
  const lines = [`<b>$${esc(sym)}</b>${name && name.toUpperCase() !== sym.toUpperCase() ? ` · ${esc(name)}` : ""}`];
  lines.push(`Troya Gate: <b>${g.pass ? "Passed" : canBuy ? "Passed for you" : "Blocked"}</b>${fails[0] ? ` · ${esc(fails[0].name)}` : ""}`);
  for (const c of g.checks.slice(0, 8)) lines.push(`${c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : "!"} ${esc(c.name)}: ${esc(String(c.detail).slice(0, 90))}`);
  if (pons && !pons.graduated) lines.push(`Curve: ${fnum(pons.raised, 3)} ${esc(pons.pair?.symbol || "ETH")} raised · ${pons.progressPct != null ? pons.progressPct.toFixed(2) : "–"}% to graduation`);
  lines.push(`<code>${token}</code>`);
  lines.push(`\nAgent Wallet: ${eth ? fnum(Number(eth.amount)) : "–"} ETH${heldN > 0 ? ` · holds ${fnum(heldN)} $${esc(sym)}` : ""}`);
  if (mine) lines.push("<b>Your coin.</b> You launched it through Troya, so its empty curve does not lock your buy; every other Gate check still applies.");
  // your trades of this coin here: ETH out, ETH back, what you still hold (valued at a sell quote), profit or loss
  const led = await ledgerOf(owner, token).catch(() => null);
  if (led) {
    const worth = heldN > 0 ? await quoteSwap({ tokenIn: token, tokenOut: "ETH", amountIn: heldN, slippagePct: 5 }).then((x) => Number(x.amountOut) || 0).catch(() => 0) : 0;
    const pnl = led.back + worth - led.spent, pct = led.spent > 0 ? (pnl / led.spent) * 100 : 0;
    lines.push(`Your trades here: ${fnum(led.spent)} ETH in, ${fnum(led.back)} ETH back${heldN > 0 ? `, holding ~${fnum(worth)} ETH` : ""} · <b>${pnl >= 0 ? "+" : "−"}${fnum(Math.abs(pnl))} ETH (${pnl >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%)</b>`);
  }
  let feeEth = 0;
  if (mine) {
    const f = await import("./launch.mjs").then((L) => L.creatorFees(owner)).catch(() => null);
    const c = f?.coins?.find((x) => String(x.token).toLowerCase() === token.toLowerCase());
    feeEth = c ? Number(c.yoursEth) || 0 : 0;
    lines.push(`Creator fees waiting for you: <b>${feeEth > 0 ? fnum(feeEth) : "0"} ETH</b>${feeEth > 0 ? " (claim them on the Creator desk with your own wallet)" : " (0.7% of every trade's volume, claimable on the Creator desk)"}`);
  }
  if (canBuy && (!eth || Number(eth.amount) < Number(BUYS[0]) * 1.05)) lines.push(`Top up first: your Agent Wallet ${short(aw.address)} needs a little ETH on Robinhood Chain. /wallet shows its address, or finish setup in one page: ${SITE}/agent#/start?for=trade-tg`);
  lines.push(canBuy ? `Pick an amount, then confirm. Slippage ${slipFor(chat, "buy")}%. The Gate runs again before it sends.` : "Buying is locked while a check fails.");
  const rows = [];
  const base = { chat, owner, token, sym, mine: !!mine };
  if (canBuy) {
    rows.push(BUYS.map((a) => ({ text: `Buy ${a}`, callback_data: issue({ ...base, act: "buy", amt: a, step: "pick" }, PICK_TTL) })));
    if (eth && Number(eth.amount) > GAS_KEEP + 0.0005) rows.push([{ text: `Buy max (${fnum(Number(eth.amount) - GAS_KEEP)} ETH)`, callback_data: issue({ ...base, act: "buy", amt: "max", step: "pick" }, PICK_TTL) }]);
  } else rows.push([{ text: "Buy locked · why", callback_data: issue({ ...base, step: "why", why: fails.map((c) => `${c.name}: ${c.detail}`).join("\n").slice(0, 190) || "A check failed." }, PICK_TTL) }]);
  if (heldN > 0) rows.push(SELLS.map((p) => ({ text: p === 100 ? "Sell all" : `Sell ${p}%`, callback_data: issue({ ...base, act: "sell", pct: p, raw: held.raw, dec: held.decimals, step: "pick" }, PICK_TTL) })));
  // slippage for this chat's next trades
  const cur = slip.get(String(chat));
  rows.push(SLIPS.map((s) => ({ text: `${cur === s ? "✓ " : ""}Slip ${s}%`, callback_data: issue({ ...base, step: "slip", slip: s }, PICK_TTL) })));
  rows.push([{ text: "Refresh", callback_data: issue({ ...base, step: "refresh" }, PICK_TTL) }, { text: "Full check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${token}` }]);
  if (mine) rows.push([{ text: feeEth > 0 ? `Claim ${fnum(feeEth)} ETH on Creator desk` : "Creator desk", url: `${SITE}/agent#/creator` }]);
  rows.push([{ text: "Buy on Fomo", url: `https://fomo.family/tokens/robinhood/${token}` }, { text: "Chart", url: `${SITE}/agent#/token/${token}` }]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

/* ---------- entry points (called from inbox.mjs) ---------- */
// returns true when the message was a trade message and has been answered
export async function handleMessage(m, tg, store) {
  if (!ON || !m?.chat) return false;
  STORE ||= store;
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
export async function handleCallback(cq, tg, store) {
  if (!String(cq?.data || "").startsWith("tt:")) return false;
  STORE ||= store;   // a button pressed right after a restart must still know the launches and the trade ledger
  const ans = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const id = cq.data.slice(3), p = pend.get(id);
  if (!ON) { await ans("Trading in Telegram is switched off right now."); return true; }
  if (!p || p.exp < Date.now()) { await ans("This button expired. Paste the coin again.", true); return true; }
  const chat = cq.message?.chat?.id, mid = cq.message?.message_id;
  if (String(cq.from?.id) !== String(p.chat) || String(chat) !== String(p.chat)) { await ans("These buttons belong to someone else's chat."); return true; }
  const edit = (text, markup) => tg("editMessageText", { chat_id: chat, message_id: mid, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } }).catch(() => {});

  if (p.step === "why") { await ans(p.why, true); return true; }
  if (p.step === "slip") {
    slip.set(String(p.chat), p.slip); pend.delete(id); await ans(`Slippage ${p.slip}% for your next trades here`);
    try { const c = await card(p.chat, p.owner, p.token); await edit(c.text, c.markup); } catch {}
    return true;
  }
  if (p.step === "refresh" || p.step === "cancel") {
    pend.delete(id); await ans("Checking again…");
    try { const c = await card(p.chat, p.owner, p.token); await edit(c.text, c.markup); } catch (e) { await edit(`Could not check that coin: ${esc(String(e.message).slice(0, 200))}`); }
    return true;
  }
  if (p.step === "pick") {
    pend.delete(id);
    const what = p.act === "buy" ? `Buy <b>${p.amt === "max" ? "all your ETH (keeping a little for gas)" : `${p.amt} ETH`}</b> of $${esc(p.sym)}` : `Sell <b>${p.pct === 100 ? "all" : `${p.pct}%`}</b> of your $${esc(p.sym)}`;
    const aw = await getAgentWallet(p.owner);
    await ans();
    await edit(`${what} with your Agent Wallet ${aw?.address ? short(aw.address) : ""}? Slippage ${slipFor(p.chat, p.act)}%.\n\nThe Gate, your policy and the Agent Wallet caps are checked again before it sends. This button works for 60 seconds.`,
      { inline_keyboard: [[{ text: "Confirm", callback_data: issue({ ...p, step: "confirm" }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...p, step: "cancel" }, PICK_TTL) }]] });
    return true;
  }
  if (p.step === "confirm") {
    if (busy.has(p.chat)) { await ans("Already sending one. Wait for it to finish."); return true; }
    pend.delete(id); busy.add(p.chat);
    await ans("Sending…");
    await edit(`${p.act === "buy" ? `Buying ${p.amt === "max" ? "max" : `${p.amt} ETH`} of` : `Selling ${p.pct === 100 ? "all" : `${p.pct}%`} of`} $${esc(p.sym)}… the Gate is running again.`);
    try {
      let params;
      if (p.act === "buy") {
        let amt = Number(p.amt);
        if (p.amt === "max") {
          // all the ETH the Agent Wallet holds right now, less a little for gas
          const aw = await getAgentWallet(p.owner);
          const b = await getBalances(aw.address, []);
          const e = Number(b.balances.find((x) => x.address === "native")?.amount || 0);
          amt = Math.floor((e - GAS_KEEP) * 1e6) / 1e6;
          if (!(amt >= 0.0005)) throw new Error("Not enough ETH in your Agent Wallet for a buy after gas.");
        }
        params = { tokenIn: "ETH", tokenOut: p.token, amountIn: amt, slippagePct: slipFor(p.chat, "buy"), ...(p.mine ? { creatorBuy: true } : {}) };
      }
      else {
        // sell a share of what the Agent Wallet holds right now (not when the card was drawn), truncated so it never rounds above it
        const aw = await getAgentWallet(p.owner);
        const b = await getBalances(aw.address, [p.token]);
        const h = b.balances.find((x) => x.address !== "native" && x.address.toLowerCase() === p.token.toLowerCase());
        if (!h || BigInt(h.raw) === 0n) throw new Error("Your Agent Wallet holds none of this coin right now.");
        params = { tokenIn: p.token, tokenOut: "ETH", amountIn: Number(trunc(formatUnits((BigInt(h.raw) * BigInt(p.pct)) / 100n, h.decimals))), slippagePct: slipFor(p.chat, "sell") };
      }
      if (!(params.amountIn > 0)) throw new Error("Nothing to sell.");
      const awx = await getAgentWallet(p.owner);
      const before = await balOf(awx.address, p.token).catch(() => null);
      const r = await executeForUser(p.owner, { kind: "swap", params, rationale: `Telegram: confirmed ${p.act} in private chat`, source: "telegram" });
      let out;
      if (r.blocked) out = `<b>Not sent.</b> ${esc(r.summary)}\n${r.reasons.map((x) => "· " + esc(String(x).slice(0, 160))).join("\n")}`;
      else if (!r.executed) out = `<b>Built, not sent</b> (test mode on this server). ${esc(r.summary)}`;
      else {
        const steps = r.result?.steps || [], last = steps[steps.length - 1] || {};
        const st = last.status === "confirmed" ? "Done" : last.status === "reverted" ? "Reverted on chain" : "Sent, waiting for the chain";
        out = `<b>${st}.</b> ${esc(r.summary)}${last.hash ? `\n<a href="${SCAN}/tx/${last.hash}">${short(last.hash)}</a>` : ""}`;
        // the real result, from the Agent Wallet's balances (a buy costs exactly its amount; a sale's ETH is what arrived)
        if (last.status === "confirmed" && before) {
          const after = await balOf(awx.address, p.token).catch(() => null);
          if (after) {
            const ethIn = p.act === "buy" ? Number(params.amountIn) : 0;
            const ethOut = p.act === "sell" ? Math.max(0, after.eth - before.eth) : 0;
            const tok = after.tok - before.tok;
            out += p.act === "buy" ? `\nGot ${fnum(Math.abs(tok))} $${esc(p.sym)} for ${fnum(ethIn)} ETH.` : `\nSold ${fnum(Math.abs(tok))} $${esc(p.sym)} for ${fnum(ethOut)} ETH.`;
            if (STORE) await STORE.update(LEDGER, [], (l) => [...l, { owner: p.owner.toLowerCase(), token: p.token.toLowerCase(), side: p.act, ethIn, ethOut, tok, hash: last.hash || null, at: Date.now() }].slice(-5000)).catch(() => {});
            const led = await ledgerOf(p.owner, p.token).catch(() => null);
            if (led && after.tok <= 0) { const pnl = led.back - led.spent; out += `\nAll sold. Result: <b>${pnl >= 0 ? "+" : "−"}${fnum(Math.abs(pnl))} ETH (${pnl >= 0 ? "+" : "−"}${led.spent > 0 ? Math.abs((pnl / led.spent) * 100).toFixed(1) : "0.0"}%)</b> over ${led.trades} trades.`; }
          }
        }
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
