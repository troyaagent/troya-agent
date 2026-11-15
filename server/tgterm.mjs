// Phase 5 · Telegram as a full terminal. From a private chat with the bot, through the owner's Agent Wallet:
//   /long ETH 20 3x sl 3000 tp 3600 · /short … · /close ETH [50] · /positions · /fund 0.01 · /stop ETH 3000 [50]
//   /tp ETH 3600 [50] · /playbooks · and plain words ("long ETH $20 at 3x"), answered by the app's assistant with tickets.
// Same rules as Phase 2 (tgtrade.mjs): TG_TRADE=1, private chat only, linked chats only (app → Settings → Telegram),
// every action is a card with Confirm (60 s), callback ids are opaque, single-use and bound to the chat, one execution
// per chat at a time, and executeForUser re-runs the Gate and the caps at the moment it sends.
import { randomBytes } from "node:crypto";
import { getAgentWallet, executeForUser } from "./agentwallet.mjs";
import { simulatePerp, gatePerp } from "./tools.mjs";
import { hlUserState, hlInfo, hlAsset } from "./hl.mjs";
import { hlFundQuote, getBalances } from "./robinhood.mjs";

const ON = process.env.TG_TRADE === "1";
const SITE = "https://troya.codes";
const SCAN = "https://robinhoodchain.blockscout.com";
const HLX = "https://app.hyperliquid.xyz/explorer/address/";
const PICK_TTL = 10 * 60_000, CONFIRM_TTL = 60_000;
const pend = new Map();               // id → { chat, owner, step, … , exp }
const busy = new Set();
let store = null;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (v) => (v == null || !isFinite(v) ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`);
const px = (v) => (v == null || !isFinite(v) ? "–" : v >= 1000 ? Number(v).toFixed(1) : v >= 1 ? Number(v).toFixed(3) : Number(v).toPrecision(4));
const coinOf = (c) => String(c || "").toUpperCase().replace(/-PERP$/, "").replace(/[^A-Z0-9:]/g, "").slice(0, 20);
function issue(p, ttl) {
  const now = Date.now();
  for (const [k, v] of pend) if (v.exp < now) pend.delete(k);
  const id = randomBytes(6).toString("hex");
  pend.set(id, { ...p, exp: now + ttl });
  return `tx:${id}`;
}
async function ownerOf(chatId) {
  const t = await store.readJson("telegram.json", { links: {}, codes: {} });
  return Object.entries(t.links || {}).find(([, c]) => String(c) === String(chatId))?.[0] || null;
}
const appBtn = (path, text = "Open Troya") => [{ text, url: SITE + path }];
const NEED_LINK = `<b>Link this chat to your wallet first.</b>\n\n1. Open troya.codes/agent and connect your wallet\n2. Settings → Telegram alerts → Link Telegram\n3. Tap Start in the chat it opens`;
const NEED_AW = `<b>You need an Agent Wallet for this.</b>\n\nCreate it in the app (Agent → Wallet) and set its caps. For perps, approve it once on Hyperliquid there too.`;

// is the owner's Agent Wallet an approved trading agent on their Hyperliquid account?
async function approved(owner, awAddr) {
  const list = await hlInfo({ type: "extraAgents", user: owner.toLowerCase() }).catch(() => null);
  if (!Array.isArray(list)) return null;
  return list.some((a) => String(a.address).toLowerCase() === awAddr.toLowerCase() && (!a.validUntil || a.validUntil > Date.now()));
}

/* ---------- cards ---------- */
async function perpCard(base, { coin, side, sizeUsd, leverage, slPx, tpPx }) {
  const aw = await getAgentWallet(base.owner);
  const sim = await simulatePerp({ coin, side, sizeUsd });
  const gate = await gatePerp(sim, { leverage, address: base.owner });
  const [st, ok] = await Promise.all([hlUserState(base.owner).catch(() => null), approved(base.owner, aw.address)]);
  const margin = sizeUsd / leverage;
  const lines = [`<b>${side === "short" ? "Short" : "Long"} ${esc(sim.coin)} · ${usd(sizeUsd)} at ${leverage}x</b>`,
    `Margin about ${usd(margin)} · est. fill ${px(sim.avgFillPx)} (${sim.slippagePct != null ? sim.slippagePct.toFixed(3) : "–"}% vs mid)`];
  if (slPx || tpPx) lines.push(`${slPx ? `Stop ${px(slPx)}` : ""}${slPx && tpPx ? " · " : ""}${tpPx ? `Take profit ${px(tpPx)}` : ""}`);
  lines.push(`Troya Gate: <b>${gate.pass ? "Passed" : "Blocked"}</b>`);
  for (const c of gate.checks.slice(0, 7)) lines.push(`${c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : "!"} ${esc(c.name)}: ${esc(String(c.detail).slice(0, 90))}`);
  const acct = st?.withdrawable ?? 0;
  lines.push(`\nHyperliquid account: ${usd(st?.accountValue)} · free ${usd(acct)}`);
  const rows = [];
  const blockers = [];
  if (ok === false) blockers.push("Approve your Agent Wallet on Hyperliquid once: Troya → Agent → Hyperliquid trading → Approve on Hyperliquid.");
  if (acct < margin * 1.02) blockers.push(`Not enough free USDC on Hyperliquid for about ${usd(margin)} of margin. Fund it from Robinhood Chain: /fund 0.01`);
  if (blockers.length) lines.push(...blockers.map((b) => "· " + esc(b)));
  if (gate.pass && !blockers.length) {
    lines.push("Confirm within 60 seconds. The Gate and your caps run again before it sends.");
    rows.push([{ text: "Confirm", callback_data: issue({ ...base, step: "confirm", kind: "perp", params: { coin: sim.coin, side, sizeUsd, leverage, slPx: slPx || null, tpPx: tpPx || null }, label: `${side === "short" ? "Short" : "Long"} ${sim.coin} ${usd(sizeUsd)} at ${leverage}x` }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...base, step: "cancel" }, PICK_TTL) }]);
  }
  if (acct < margin * 1.02) rows.push([{ text: "Fund 0.01 ETH", callback_data: issue({ ...base, step: "fundcard", amount: 0.01 }, PICK_TTL) }]);
  if (ok === false) rows.push(appBtn("/agent#/agent/wallet", "Approve in Troya"));
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

async function positionsCard(base) {
  const st = await hlUserState(base.owner);
  const open = (st.positions || []).filter((p) => p.size !== 0);
  const lines = [`<b>Hyperliquid · ${short(base.owner)}</b>`, `Account ${usd(st.accountValue)} · free ${usd(st.withdrawable)} · unrealized ${usd(st.unrealizedPnl)}`];
  const rows = [];
  if (!open.length) lines.push("\nNo open positions. Open one with /long ETH 20 3x");
  for (const p of open.slice(0, 8)) {
    const mark = await hlAsset(p.coin).then((a) => Number(a.markPx || a.midPx)).catch(() => null);
    lines.push(`\n<b>${esc(p.coin)} ${p.size > 0 ? "long" : "short"}</b> ${Math.abs(p.size)} · entry ${px(p.entryPx)} · mark ${px(mark)}\nPnL ${usd(p.unrealizedPnl)} (${(p.returnOnEquity * 100).toFixed(1)}%)${p.liquidationPx ? ` · liq ${px(p.liquidationPx)}` : ""}${p.leverage ? ` · ${p.leverage}x` : ""}`);
    rows.push([50, 100].map((pct) => ({ text: `Close ${p.coin} ${pct}%`, callback_data: issue({ ...base, step: "closecard", coin: p.coin, pct }, PICK_TTL) })));
  }
  rows.push([{ text: "Refresh", callback_data: issue({ ...base, step: "positions" }, PICK_TTL) }, { text: "Account on Hyperliquid", url: HLX + base.owner }]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

async function closeCard(base, coin, pct) {
  const st = await hlUserState(base.owner);
  const p = (st.positions || []).find((x) => x.coin.toUpperCase() === coin && x.size !== 0);
  if (!p) return { text: `No open ${esc(coin)} position on your Hyperliquid account.`, markup: { inline_keyboard: [[{ text: "Positions", callback_data: issue({ ...base, step: "positions" }, PICK_TTL) }]] } };
  return {
    text: `<b>Close ${pct}% of ${esc(p.coin)} ${p.size > 0 ? "long" : "short"}</b>\nSize ${Math.abs(p.size)} · entry ${px(p.entryPx)} · PnL now ${usd(p.unrealizedPnl)}\nA reduce-only market order from your Agent Wallet. Confirm within 60 seconds.`,
    markup: { inline_keyboard: [[{ text: "Confirm", callback_data: issue({ ...base, step: "confirm", kind: "close", params: { coin: p.coin, sizePct: pct }, label: `Close ${pct}% of ${p.coin}` }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...base, step: "cancel" }, PICK_TTL) }]] },
  };
}

async function fundCard(base, amount) {
  const aw = await getAgentWallet(base.owner);
  const [q, bal] = await Promise.all([
    hlFundQuote({ address: aw.address, amountWei: BigInt(Math.round(amount * 1e9)) * 10n ** 9n, toAddress: base.owner }).catch((e) => ({ err: e.message })),
    getBalances(aw.address).catch(() => null),
  ]);
  const eth = Number(bal?.balances?.find((x) => x.address === "native")?.amount || 0);
  if (q.err) return { text: `Could not find a route for ${amount} ETH: ${esc(String(q.err).slice(0, 160))}`, markup: { inline_keyboard: [] } };
  const usdc = Number(q.toAmount) / 10 ** q.toDecimals;
  const lines = [`<b>Fund Hyperliquid · ${amount} ETH</b>`, `About ${usdc.toFixed(2)} USDC lands on your own Hyperliquid account (${short(base.owner)}), usually within a minute.`, `Route ${esc(q.tool)} via LI.FI · fees about ${usd(q.feeUsd + q.gasUsd)}`, `Agent Wallet ETH: ${eth.toFixed(5)}`];
  const rows = [];
  if (eth < amount * 1.01) lines.push(`· Not enough ETH in your Agent Wallet. Top it up first (/wallet shows the address).`);
  else { lines.push("Confirm within 60 seconds."); rows.push([{ text: "Confirm", callback_data: issue({ ...base, step: "confirm", kind: "hl_fund", params: { amount }, label: `Fund Hyperliquid with ${amount} ETH` }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...base, step: "cancel" }, PICK_TTL) }]); }
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

async function guardCard(base, type, coin, price, pct) {
  const st = await hlUserState(base.owner).catch(() => null);
  const pos = (st?.positions || []).find((x) => x.coin.toUpperCase() === coin && x.size !== 0);
  const long = pos ? pos.size > 0 : true;
  const watch = type === "stop_loss"
    ? { type, coin, triggerPx: price, direction: long ? "below" : "above", sizePct: pct }
    : { type, coin, levels: [{ px: price, sizePct: pct }], direction: long ? "above" : "below" };
  const what = type === "stop_loss" ? `Stop-loss: close ${pct}% of ${coin} when it trades ${long ? "at or below" : "at or above"} ${px(price)}` : `Take profit: close ${pct}% of ${coin} when it trades ${long ? "at or above" : "at or below"} ${px(price)}`;
  return {
    text: `<b>${esc(what)}</b>\n${pos ? `Your ${coin} ${long ? "long" : "short"}: ${Math.abs(pos.size)} at ${px(pos.entryPx)}.` : `No open ${coin} position yet; it guards one when you open it.`}\nThe server checks it every 20 seconds and closes through your Agent Wallet, inside your caps. Confirm within 60 seconds.`,
    markup: { inline_keyboard: [[{ text: "Confirm", callback_data: issue({ ...base, step: "confirm", kind: "watch", params: watch, label: what }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...base, step: "cancel" }, PICK_TTL) }]] },
  };
}

async function playbooksText(base) {
  const list = (await store.readJson("watches.json", [])).filter((w) => w.address === base.owner.toLowerCase() && w.status === "active");
  if (!list.length) return "No active playbooks. Set one with /stop ETH 3000 or /tp ETH 3600, or in the app.";
  return `<b>Active playbooks</b>\n${list.slice(0, 15).map((w) => `· ${esc(w.title)}${w.lastPrice ? ` (now ${px(w.lastPrice)})` : ""}`).join("\n")}\n\nManage them in Troya → Agent → Playbooks.`;
}

/* ---------- the assistant's answer with its tickets as buttons ---------- */
const mdToHtml = (t) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/^\s*[-*]\s+/gm, "• ").replace(/^#+\s*/gm, "");
async function assistantReply(base, text) {
  const as = await import("./assistant.mjs");
  const r = await as.answerFor(base.owner, text, { via: "telegram" });
  const rows = [];
  for (const p of (r.proposals || []).slice(0, 4)) {
    if (["swap", "perp", "hl_fund", "watch", "close"].includes(p.kind)) rows.push([{ text: `Run: ${String(p.summary).slice(0, 40)}`, callback_data: issue({ ...base, step: "ticket", kind: p.kind, params: p.params, proposalId: p.id, label: p.summary }, PICK_TTL) }]);
    else if (p.kind === "bridge") rows.push(appBtn(`/agent#/bridge?amount=${encodeURIComponent(String(p.params?.amount || ""))}`, "Open Bridge in Troya"));
  }
  const body = mdToHtml(String(r.text || "").slice(0, 3500)) + (rows.length ? "\n\nTap a ticket to review it. Nothing runs until you confirm." : "");
  return { text: body, markup: { inline_keyboard: rows } };
}

/* ---------- entry points ---------- */
const CMD = /^\/(long|short|close|positions|pos|fund|stop|tp|playbooks|brief|alerts|autopilot)(?:@\w+)?(?:\s+([\s\S]*))?$/i;
export function parse(text) {
  const m = CMD.exec(String(text || "").trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase(), arg = (m[2] || "").trim();
  if (cmd === "long" || cmd === "short") {
    const a = /^([A-Za-z0-9:]+)\s+\$?(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?)\s*x)?\b/i.exec(arg);
    if (!a) return { cmd, error: `Usage: /${cmd} ETH 20 3x [sl 3000] [tp 3600] (size in USD)` };
    const sl = /\bsl\s*\$?(\d+(?:\.\d+)?)/i.exec(arg), tp = /\btp\s*\$?(\d+(?:\.\d+)?)/i.exec(arg);
    return { cmd, coin: coinOf(a[1]), sizeUsd: Number(a[2]), leverage: Math.max(1, Math.round(Number(a[3]) || 1)), slPx: sl ? Number(sl[1]) : null, tpPx: tp ? Number(tp[1]) : null };
  }
  if (cmd === "close") { const a = /^([A-Za-z0-9:]+)(?:\s+(\d{1,3})%?)?/.exec(arg); return a ? { cmd, coin: coinOf(a[1]), pct: Math.min(100, Math.max(1, Number(a[2]) || 100)) } : { cmd, error: "Usage: /close ETH [50]" }; }
  if (cmd === "fund") { const n = Number((/(\d*\.?\d+)/.exec(arg) || [])[1]); return n > 0 ? { cmd, amount: n } : { cmd, error: "Usage: /fund 0.01 (ETH from your Agent Wallet → USDC on your Hyperliquid account)" }; }
  if (cmd === "stop" || cmd === "tp") {
    const a = /^([A-Za-z0-9:]+)\s+\$?(\d+(?:\.\d+)?)(?:\s+(\d{1,3})%?)?/.exec(arg);
    return a ? { cmd, coin: coinOf(a[1]), price: Number(a[2]), pct: Math.min(100, Math.max(1, Number(a[3]) || 100)) } : { cmd, error: `Usage: /${cmd} ETH ${cmd === "stop" ? "3000" : "3600"} [50]` };
  }
  if (cmd === "brief" || cmd === "alerts" || cmd === "autopilot") return { cmd, arg };
  return { cmd: cmd === "pos" ? "positions" : cmd };
}

// returns true when the message was handled here
export async function handleMessage(m, tg, st) {
  if (!ON || !m?.chat || m.chat.type !== "private" || m.from?.is_bot) return false;
  store = store || st;
  const text = String(m.text || "").trim();
  if (!text) return false;
  const c = parse(text);
  // plain words go to the assistant only for linked chats; everything else falls through to the normal bot
  if (!c && (text.startsWith("/") || /^0x[0-9a-fA-F]{40}$/.test(text))) return false;
  const chat = m.chat.id;
  const owner = await ownerOf(chat);
  if (!c && !owner) return false;
  const send = (body, markup) => tg("sendMessage", { chat_id: chat, text: body, parse_mode: "HTML", reply_markup: markup || { inline_keyboard: [] }, link_preview_options: { is_disabled: true } });
  if (c?.error) { await send(esc(c.error)); return true; }
  if (!owner) { await send(NEED_LINK, { inline_keyboard: [appBtn("/agent")] }); return true; }
  const aw = await getAgentWallet(owner);
  const base = { chat, owner };
  try {
    if (!c) {
      await tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
      const r = await assistantReply(base, text);
      await send(r.text, r.markup);
      return true;
    }
    if (c.cmd === "playbooks") { await send(await playbooksText(base)); return true; }
    if (c.cmd === "brief") { const b = await import("./brief.mjs"); b.init(store); const note = await b.command(owner, chat, c.arg); if (note) await send(esc(note)); return true; }
    if (c.cmd === "autopilot") { const ap = await import("./autopilot.mjs"); ap.init(store); try { await send(await ap.command(owner, c.arg)); } catch (e) { await send(esc(e.message)); } return true; }
    if (c.cmd === "alerts") { const b = await import("./brief.mjs"); b.init(store); await send(esc(await b.alertsCommand(owner, c.arg))); return true; }
    if (c.cmd === "positions") { const r = await positionsCard(base); await send(r.text, r.markup); return true; }
    if (!aw?.exists) { await send(NEED_AW, { inline_keyboard: [appBtn("/agent#/agent/wallet")] }); return true; }
    const wait = await tg("sendMessage", { chat_id: chat, text: c.cmd === "fund" ? "Finding a route…" : "Running Troya Gate…" }).catch(() => null);
    let r;
    if (c.cmd === "long" || c.cmd === "short") r = await perpCard(base, { coin: c.coin, side: c.cmd, sizeUsd: c.sizeUsd, leverage: c.leverage, slPx: c.slPx, tpPx: c.tpPx });
    else if (c.cmd === "close") r = await closeCard(base, c.coin, c.pct);
    else if (c.cmd === "fund") r = await fundCard(base, c.amount);
    else r = await guardCard(base, c.cmd === "stop" ? "stop_loss" : "take_profit", c.coin, c.price, c.pct);
    const mid = wait?.result?.message_id;
    if (mid) await tg("editMessageText", { chat_id: chat, message_id: mid, text: r.text, parse_mode: "HTML", reply_markup: r.markup, link_preview_options: { is_disabled: true } });
    else await send(r.text, r.markup);
  } catch (e) {
    await send(`Could not do that: ${esc(String(e.message).slice(0, 220))}`);
  }
  return true;
}

// returns true when the callback belonged here
export async function handleCallback(cq, tg) {
  if (!String(cq?.data || "").startsWith("tx:")) return false;
  const ans = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const id = cq.data.slice(3), p = pend.get(id);
  if (!ON) { await ans("Trading in Telegram is switched off right now."); return true; }
  if (!p || p.exp < Date.now()) { await ans("This button expired. Send the command again.", true); return true; }
  const chat = cq.message?.chat?.id, mid = cq.message?.message_id;
  if (String(cq.from?.id) !== String(p.chat) || String(chat) !== String(p.chat)) { await ans("These buttons belong to someone else's chat."); return true; }
  const edit = (text, markup) => tg("editMessageText", { chat_id: chat, message_id: mid, text, parse_mode: "HTML", reply_markup: markup || { inline_keyboard: [] }, link_preview_options: { is_disabled: true } }).catch(() => {});
  const base = { chat: p.chat, owner: p.owner };
  pend.delete(id);
  try {
    if (p.step === "cancel") { await ans("Cancelled."); await edit("Cancelled. Nothing was sent."); return true; }
    if (p.step === "positions") { await ans("Refreshing…"); const r = await positionsCard(base); await edit(r.text, r.markup); return true; }
    if (p.step === "closecard") { await ans(); const r = await closeCard(base, p.coin, p.pct); await edit(r.text, r.markup); return true; }
    if (p.step === "fundcard") { await ans(); const r = await fundCard(base, p.amount); await edit(r.text, r.markup); return true; }
    if (p.step === "ticket") {
      await ans();
      await edit(`<b>${esc(p.label)}</b>\nRun it with your Agent Wallet ${(await getAgentWallet(p.owner))?.address ? short((await getAgentWallet(p.owner)).address) : ""}? The Gate, your policy and the caps are checked again before it sends. Confirm within 60 seconds.`,
        { inline_keyboard: [[{ text: "Confirm", callback_data: issue({ ...p, step: "confirm" }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ ...base, step: "cancel" }, PICK_TTL) }]] });
      return true;
    }
    if (p.step === "confirm") {
      if (busy.has(p.chat)) { await ans("Already sending one. Wait for it to finish."); return true; }
      busy.add(p.chat);
      await ans("Sending…");
      await edit(`${esc(p.label)}… checking again and sending.`);
      try {
        if (p.kind === "watch") {
          const watches = await import("./watches.mjs");
          const w = await watches.createWatch(p.owner, p.params);
          if (p.proposalId) { const ib = await import("./inbox.mjs"); await ib.markProposal(p.owner, p.proposalId, "done", { watchId: w.id }).catch(() => {}); }
          await edit(`<b>Playbook on.</b> ${esc(w.title)}\nChecked every 20 seconds. /playbooks lists them.`);
          return true;
        }
        const r = await executeForUser(p.owner, { kind: p.kind, params: p.params, rationale: `Telegram: confirmed in private chat`, source: "telegram", proposalId: p.proposalId || null });
        let out;
        if (r.blocked) out = `<b>Not sent.</b> ${esc(r.summary)}\n${(r.reasons || []).map((x) => "· " + esc(String(x).slice(0, 160))).join("\n")}`;
        else if (!r.executed) out = `<b>Built, not sent</b> (test mode on this server). ${esc(r.summary)}`;
        else {
          const res = r.result || {};
          const fill = Array.isArray(res.response) ? res.response.find((x) => x?.filled)?.filled : null;
          const err = Array.isArray(res.response) ? res.response.find((x) => x?.error)?.error : null;
          if (err) out = `<b>Hyperliquid refused it:</b> ${esc(String(err).slice(0, 200))}`;
          else if (fill) out = `<b>Done.</b> ${esc(r.summary)}\nFilled ${fill.totalSz} at ${px(Number(fill.avgPx))}`;
          else if (res.hash) out = `<b>Sent.</b> ${esc(r.summary)}${res.usdcEstimate ? `\nAbout ${Number(res.usdcEstimate).toFixed(2)} USDC on its way to your Hyperliquid account.` : ""}\n<a href="${SCAN}/tx/${res.hash}">${short(res.hash)}</a>`;
          else out = `<b>Done.</b> ${esc(r.summary)}`;
        }
        const next = p.kind === "perp" || p.kind === "close" || p.kind === "hl_fund" ? { inline_keyboard: [[{ text: "Positions", callback_data: issue({ ...base, step: "positions" }, PICK_TTL) }, { text: "Journal in Troya", url: `${SITE}/agent#/agent/wallet` }]] } : { inline_keyboard: [[{ text: "Journal in Troya", url: `${SITE}/agent#/agent/wallet` }]] };
        await edit(out, next);
      } finally { busy.delete(p.chat); }
      return true;
    }
    await ans();
  } catch (e) {
    await edit(`<b>Not sent.</b> ${esc(String(e.message).slice(0, 220))}`);
  }
  return true;
}

export function init(st) { store = st; }
