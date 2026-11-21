// V6 F27 · Launch in Telegram: launch a coin from a private chat with the Troya bot, from the Agent Wallet.
//   /launch                       step by step: name → ticker → image → links → creator tax → initial buy → preview → Confirm
//   photo + caption "/launch Wooden Horse $HORSE tax 2% buy 0.01 site: horse.xyz tg: t.me/horse"   the quick way, straight
//                                 to the preview (the links are optional there too)
//   /skip                         launch without an image (at the image step), or without links (at the links step)
//   /cancel                       drop the launch being prepared
//   Confirm lasts 90 seconds; a later Confirm re-checks the plan and the balance and sends a fresh preview (20 Nov)
// Open to everyone (holders of 1M $TROYA keep the whole creator fee; others keep 0.6% of volume, Troya 0.1%), with the
// same rules as every Troya launch (launch.mjs plan()). Off / test (admin wallets only) / live, switched by an admin.
import { randomBytes } from "node:crypto";

const SITE = (process.env.SITE_URL || "https://troya.codes").replace(/\/+$/, "");
const BOT = process.env.TG_BOT_USERNAME || "TrojanTroya_bot";
const SESSION_TTL = 30 * 60_000, CONFIRM_TTL = 90_000;
const LATE_WINDOW = 30 * 60_000;   // after a launch setup times out, the next answer is told so instead of going elsewhere
const TAXES = [0, 100, 200, 300, 400];
const BUYS = [0, 0.001, 0.005, 0.01, 0.05];
const sessions = new Map();          // chat → { step, owner, name, symbol, logo, website, telegram, twitter, description, taxBps, buyEth, exp, card }
/** a launch is being set up in this chat (its answers belong to the launch, not to the dev inbox) */
export const inSession = (chat) => { const s = sessions.get(chat); return !!(s && s.exp + LATE_WINDOW > Date.now()); };
const pend = new Map();              // id → { chat, act, ...; exp }
const busy = new Set();              // chats with a launch in flight
let store = null;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const lc = (s) => String(s || "").toLowerCase();
// a reason as one clause, so ". Nothing was spent." never doubles the full stop
// the reason on its own: "Nothing was spent" is added by each message, never twice
const why = (e, n = 220) => esc(String(e?.message || e || "").replace(/[.\s]*Nothing was spent[.\s]*$/i, "").replace(/[.\s]+$/, "").slice(0, n));
function issue(p, ttl) {
  const now = Date.now();
  // an expired button is kept a while longer, so a late Confirm is still recognised (and re-checked) instead of being
  // lost the moment anyone else's chat gets a button
  for (const [k, v] of pend) if (v.exp + LATE_WINDOW < now) pend.delete(k);
  const id = randomBytes(6).toString("hex");
  pend.set(id, { ...p, exp: now + ttl });
  return `tl:${id}`;
}
async function ownerOf(chatId) {
  const t = await store.readJson("telegram.json", { links: {}, codes: {} });
  return Object.entries(t.links || {}).find(([, c]) => String(c) === String(chatId))?.[0] || null;
}

/* ---------- the image: a Telegram photo (or an image sent as a file) becomes the coin's logo ---------- */
// Telegram keeps each photo in several sizes; the biggest one that fits the logo store (1 MB) is used, so nobody has to
// think about file sizes
let fetchImage = async (tg, fileId) => {
  const f = await tg("getFile", { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path) throw new Error("no file");
  const r = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`file ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg" };
};
/** tests only: replace how a Telegram image is fetched */
export const _setImageFetcher = (fn) => { fetchImage = fn; };
function imageOf(m) {
  if (Array.isArray(m.photo) && m.photo.length) {
    const sizes = m.photo.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
    const fits = sizes.filter((p) => (p.width || 0) <= 1280 && !(p.file_size > 1_000_000));
    return (fits.pop() || sizes[0]).file_id;
  }
  if (m.document && /^image\/(png|jpeg|webp)$/.test(m.document.mime_type || "")) return m.document.file_size > 1_000_000 ? null : m.document.file_id;
  return null;
}
// the picture is centre-cropped to a square of at most 1024 px first (logosquare.mjs), as on the web form and on X: a
// 2:1 photo was stored as it came, and every board then cut its own middle out of it
async function saveImage(tg, fileId) {
  const [{ saveLaunchLogo }, { squareLogo }] = await Promise.all([import("./robinhood.mjs"), import("./logosquare.mjs")]);
  const { buf, type } = await fetchImage(tg, fileId);
  const sq = await squareLogo(buf, type);
  return (await saveLaunchLogo(sq.buf, sq.type)).url;
}

/* ---------- messages ---------- */
const LINK_FIRST = `<b>Link this chat to your wallet first.</b>

1. Open troya.codes/agent and connect your wallet
2. Settings → Telegram alerts → Link Telegram
3. Tap Start in the chat it opens

Then send /launch again.`;
// the Pons launch fee is read from the factory (launchMenu), never written into a message: "0.0005 ETH today" was typed in
// five places and would go stale the day Pons changes it
const launchFee = async () => { const { launchMenu } = await import("./robinhood.mjs"); return launchMenu().then((m) => (Number(m.launchFeeEth) > 0 ? Number(m.launchFeeEth) : null)).catch(() => null); };
const ethTxt = (x) => Number(x).toFixed(6).replace(/\.?0+$/, "");
const feeTxt = (fee) => (fee != null ? `the Pons launch fee (${ethTxt(fee)} ETH today)` : "the Pons launch fee");
const walletFirst = (fee) => `<b>You need an Agent Wallet to launch here.</b>

Your Agent Wallet pays ${feeTxt(fee)} and your initial buy; Troya pays the gas. Create it in the app (Agent → Wallet) and send it a little ETH on Robinhood Chain.

Then send /launch again.`;
// the image is optional in Telegram (it is required only on the web form): said the same way at every image prompt
const IMAGE_ASK = "Now send the coin's image as a photo (square works best; other shapes are cropped to the centre square). No image? Reply /skip.";
const LINKS_ASK = "Website, Telegram group or one-line description? Send them in one message (for example: horse.xyz t.me/horsegroup The first horse inside the walls), or /skip. They are written into the coin for good.";
const appBtn = (path) => ({ inline_keyboard: [[{ text: /#\/start/.test(path) ? "Finish setup" : "Open Troya", url: SITE + path }]] });
// straight to the guide's Telegram section, not the top of a page about posting on X
const guideBtn = () => ({ inline_keyboard: [[{ text: "Read the guide", url: `${SITE}/launch-on-x#telegram` }]] });

async function agentBalance(address) {
  const { rpc, launchMenu } = await import("./robinhood.mjs");
  const [bal, menu] = await Promise.all([rpc("robinhood", "eth_getBalance", [address, "latest"]), launchMenu(true).catch(() => null)]);
  const fee = Number(menu?.launchFeeEth);
  return { eth: Number(BigInt(bal)) / 1e18, fee: fee > 0 ? fee : null };
}
const linkLines = (s) => [s.website ? `Website: ${esc(s.website)}` : null, s.telegram ? `Telegram: ${esc(s.telegram)}` : null, s.twitter ? `X: ${esc(s.twitter)}` : null,
  s.description ? `Description: ${esc(s.description.length > 160 ? s.description.slice(0, 157) + "…" : s.description)}` : null].filter(Boolean);
// recheck: the card that replaces a Confirm pressed after its 90 seconds, so it says the numbers are fresh
async function preview(L, s, { recheck = false } = {}) {
  const p = await L.plan({ owner: s.owner, creatorTaxBps: s.taxBps, name: s.name, symbol: s.symbol, source: "tg" });
  const b = await agentBalance(s.wallet).catch(() => null);
  // the same figure as X, the setup page and the onboarding gaps: the fee + 0.0001, or the fee + the buy + 0.0002
  // (the factory unread: the balance is still checked against the last known fee, never skipped)
  const need = b ? L.needEthFor(b.fee ?? 0.0005, s.buyEth) : 0;
  if (b && b.eth < need) {
    const e = new Error(`your Agent Wallet holds ${ethTxt(b.eth)} ETH; the launch fee${s.buyEth ? ` plus the ${s.buyEth} ETH buy` : ""} needs ${ethTxt(need)} ETH. The Agent Wallet is separate from your own wallet: press Add ETH on its page (Agent → Wallet), then send /launch again`);
    e.fund = true; throw e;
  }
  const fee = p.split ? `you keep 0.6% of volume${s.taxBps ? ` plus your ${s.taxBps / 100}% tax` : ""}, Troya takes 0.1%` : `100% yours, to ${short(p.owner)}`;
  const text = `<b>Launch preview</b>

<b>${esc(s.name)}</b>  $${esc(s.symbol)}
Image: ${s.logo ? "attached, cropped to a centre square" : "none (the coin will have no image, for good)"}
${linkLines(s).length ? linkLines(s).join("\n") : "Links: none"}
Creator tax: ${s.taxBps ? `${s.taxBps / 100}%, all yours` : "none"}
Initial buy: ${s.buyEth ? `${s.buyEth} ETH from your Agent Wallet` : "none"}
Creator fee: ${fee}
Cost: ${feeTxt(b?.fee ?? null)} from your Agent Wallet${b ? `, which holds ${ethTxt(b.eth)} ETH` : ""}; Troya pays the gas

Name, ticker, image, links and tax are final once launched. ${recheck ? "Prices and limits re-checked, confirm within 90 seconds." : "Confirm within 90 seconds."}`;
  // the Confirm is tied to this very setup (ses), so a card from an earlier /launch can never launch a newer one
  return { text, plan: p, markup: { inline_keyboard: [[{ text: "Confirm launch", callback_data: issue({ chat: s.chat, act: "confirm", ses: s }, CONFIRM_TTL) }, { text: "Cancel", callback_data: issue({ chat: s.chat, act: "cancel" }, SESSION_TTL) }]] } };
}
const taxKb = (chat) => ({ inline_keyboard: [TAXES.map((t) => ({ text: t ? `${t / 100}%` : "No tax", callback_data: issue({ chat, act: "tax", v: t }, SESSION_TTL) }))] });
const buyKb = (chat) => ({ inline_keyboard: [BUYS.map((b) => ({ text: b ? `${b} ETH` : "No buy", callback_data: issue({ chat, act: "buy", v: b }, SESSION_TTL) }))] });

/* ---------- entry points (called from inbox.mjs before trading and the assistant) ---------- */
export function init(s) { store = s; }
// true when the message was a launch message and has been answered
export async function handleMessage(m, tg, st) {
  if (!m?.chat) return false;
  store ||= st;
  const text = String(m.text || m.caption || "").trim();
  const isCmd = /^\/launch(?:@\w+)?\b/i.test(text) || /^\/start\s+launch$/i.test(text);
  const chat = m.chat.id;
  const s = sessions.get(chat);
  const live = s && s.exp > Date.now();
  // an answer that comes after the setup timed out (a name or ticker sent much later): say so, plainly, once
  if (!isCmd && s && !live && s.exp + LATE_WINDOW > Date.now() && m.chat.type === "private" && !text.startsWith("/")) {
    sessions.delete(chat);
    await tg("sendMessage", { chat_id: chat, text: "That launch setup timed out (30 minutes without an answer), so nothing was launched. Send /launch to start again." }).catch(() => {});
    return true;
  }
  if (!isCmd && !live) return false;
  if (m.chat.type !== "private") {
    if (!isCmd) return false;
    await tg("sendMessage", { chat_id: chat, reply_to_message_id: m.message_id, text: "Launching happens in a private chat with me, never in the group.", reply_markup: { inline_keyboard: [[{ text: "Launch in a private chat", url: `https://t.me/${BOT}?start=launch` }]] } }).catch(() => {});
    return true;
  }
  const say = (t, markup) => tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }).catch(() => null);
  if (/^\/cancel\b/i.test(text)) { sessions.delete(chat); await say("Launch dropped. Send /launch to start again."); return true; }
  // any other command leaves the launch and goes on to trading or the assistant
  if (!isCmd && text.startsWith("/") && !/^\/skip\b/i.test(text)) { sessions.delete(chat); return false; }
  const L = await import("./launch.mjs");

  if (isCmd) {
    const mode = await L.tgLaunchMode();
    const owner = await ownerOf(chat);
    if (mode === "off" || (mode === "test" && !(owner && L.isAdminWallet(owner)))) {
      await say("<b>Launching in Telegram isn't open yet.</b> It goes live after its real-money test. Anyone can launch from X or on troya.codes today.", { inline_keyboard: [[{ text: "Create coin", url: `${SITE}/agent#/create` }]] });
      return true;
    }
    if (!owner) { await say(LINK_FIRST, appBtn("/agent#/start?for=launch-tg")); return true; }
    // every step still missing, at once, with the one page that does them all (18 Nov)
    {
      const ob = await import("./onboard.mjs"); ob.init(store);
      const fee = await launchFee();
      const gaps = await ob.gapsFor(owner, "launch-tg", { needEth: L.needEthFor(fee ?? 0.0005) }).catch(() => []);
      if (gaps.length) {
        await say(`<b>Almost ready to launch here.</b> ${gaps.length} step${gaps.length > 1 ? "s" : ""} left, all on one page:\n\n${gaps.map((g, i) => `${i + 1}. ${esc(g.charAt(0).toUpperCase() + g.slice(1))}`).join("\n")}\n\nThe Agent Wallet pays ${feeTxt(fee)} and any initial buy; Troya pays the gas. Then send /launch again.`, appBtn("/agent#/start?for=launch-tg"));
        return true;
      }
    }
    const aw = await import("./agentwallet.mjs").then((x) => x.getAgentWallet(owner));
    if (!aw?.exists) { await say(walletFirst(await launchFee()), appBtn("/agent#/start?for=launch-tg")); return true; }
    if (busy.has(chat)) { await say("A launch from this chat is still going through. Wait for its message, then send /launch again."); return true; }
    // the daily limit before any typing (the name check comes once there is a name)
    try { await L.plan({ owner, creatorTaxBps: 0, source: "tg" }); }
    catch (e) { await say(`<b>Not launched:</b> ${why(e)}.`); return true; }
    const args = text.replace(/^\/(?:launch(?:@\w+)?|start\s+launch)\s*/i, "").trim();
    const fresh = { chat, owner, wallet: aw.address, step: "name", name: "", symbol: "", logo: "", website: "", telegram: "", twitter: "", description: "", taxBps: 0, buyEth: 0, exp: Date.now() + SESSION_TTL };
    if (args) {
      // the quick way: everything in one message (a photo caption or plain text)
      const ask = await L.readLaunch(`launch ${args}`);
      if (!ask || ask.unclear || !ask.name || !ask.symbol) {
        await say("Troya couldn't read the name and ticker for sure. Send it like this, as the caption of the coin's image:\n<code>/launch Wooden Horse $HORSE tax 2% buy 0.01</code>\n\nOr send /launch alone and answer step by step.", guideBtn());
        return true;
      }
      Object.assign(fresh, { name: ask.name, symbol: ask.symbol, taxBps: ask.taxBps || 0, buyEth: ask.buyEth || 0, website: ask.website || "", telegram: ask.telegram || "", step: "preview", quick: true });
      const np = L.nameProblem(fresh.name, fresh.symbol, { team: L.isAdminWallet(owner) });
      if (np) { await say(`<b>Not launched:</b> ${esc(np)}`); return true; }
      if (fresh.taxBps > L.MAX_TAX_BPS) { await say("<b>Not launched:</b> the creator tax can be 4% at most."); return true; }
      if (fresh.buyEth > L.MAX_INITIAL_BUY_ETH) { await say(`<b>Not launched:</b> the initial buy can be up to ${L.MAX_INITIAL_BUY_ETH} ETH.`); return true; }
      const fid = imageOf(m);
      if (fid) { try { fresh.logo = await saveImage(tg, fid); } catch { await say("Troya couldn't read that image. Send it as a photo (PNG or JPEG) rather than as a file."); return true; } }
      sessions.set(chat, fresh);
      if (!fresh.logo) { fresh.step = "image"; await say(`<b>${esc(fresh.name)}</b> $${esc(fresh.symbol)}. ${IMAGE_ASK}`); return true; }
      return showPreview(L, tg, fresh, say);
    }
    sessions.set(chat, fresh);
    await say("<b>New coin.</b> What's its name? (for example: Wooden Horse)\n\nSend /cancel any time to stop.");
    return true;
  }

  // the steps of a launch in progress
  s.exp = Date.now() + SESSION_TTL;
  if (s.step === "name") {
    const name = text.replace(/\s+/g, " ").trim();
    if (!name || name.startsWith("/")) { await say("Send the coin's name as plain text, or /cancel."); return true; }
    if (name.length > 48) { await say("Keep the name to 48 characters."); return true; }
    // the name's own rules right here: checked only at the ticker step, a reserved name asked for "another ticker" forever
    const bad = L.coinNameProblem(name, { team: L.isAdminWallet(s.owner) });
    if (bad) { await say(`${esc(bad.replace(/\s*Pick another[^.]*\.?$/i, ""))}\n\nSend another name, or /cancel.`); return true; }
    s.name = name; s.step = "symbol";
    await say(`<b>${esc(name)}</b>. Now the ticker, letters and numbers only (for example: HORSE).`);
    return true;
  }
  if (s.step === "symbol") {
    const sym = text.replace(/^\$/, "").trim();
    const np = L.nameProblem(s.name, sym, { team: L.isAdminWallet(s.owner) });
    if (np) { await say(`${esc(np.replace(/\s*Pick another[^.]*\.?$/i, ""))}\n\nSend another ticker, or /cancel.`); return true; }
    s.symbol = sym; s.step = "image";
    await say(`$${esc(sym)}. ${IMAGE_ASK}`);
    return true;
  }
  if (s.step === "image") {
    if (/^\/skip\b/i.test(text)) {
      s.logo = "";
      if (s.quick) return showPreview(L, tg, s, say);
      s.step = "links"; await say(`No image. ${LINKS_ASK}`); return true;
    }
    const fid = imageOf(m);
    if (!fid) { await say(m.document ? "Send the image as a photo rather than as a file. No image? Reply /skip." : "Send the image as a photo. No image? Reply /skip."); return true; }
    try { s.logo = await saveImage(tg, fid); } catch { await say("Troya couldn't read that image. Send it as a photo (PNG or JPEG) rather than as a file. No image? Reply /skip."); return true; }
    if (s.quick) return showPreview(L, tg, s, say);
    s.step = "links";
    await say(`Image saved, cropped to a centre square. ${LINKS_ASK}`);
    return true;
  }
  // optional: the coin's website, Telegram group and a line about it, written on chain with it (as on the web form)
  if (s.step === "links") {
    // "no" or "skip" typed without the slash is a skip too, never a one-word description written on chain
    if (!/^\/skip\b/i.test(text) && !/^(?:no|none|nope|skip|nothing|n\/a|-)[.!]?$/i.test(text)) {
      if (!text) { await say(`Send them as text. ${LINKS_ASK}`); return true; }
      const got = L.linksAnswer(text);
      Object.assign(s, got);
      if (!got.website && !got.telegram && !got.twitter && !got.description) { await say(`Troya couldn't read that. ${LINKS_ASK}`); return true; }
    }
    s.step = "tax";
    const shown = linkLines(s);
    await say(`${shown.length ? `${shown.join("\n")}\n\n` : "No links. "}Creator tax? It's yours on every buy and sell, fixed for good.`, taxKb(chat));
    return true;
  }
  // tax, buy and preview are answered with buttons
  await say("Use the buttons above, or /cancel to stop.");
  return true;
}

async function showPreview(L, tg, s, say, opts) {
  try {
    const pv = await preview(L, s, opts);
    s.step = "preview";
    const sent = await say(pv.text, pv.markup);
    s.card = sent?.result?.message_id || null;
  } catch (e) {
    sessions.delete(s.chat);
    await say(`<b>Not launched:</b> ${why(e, 260)}. Nothing was spent.`, e.fund ? appBtn("/agent#/agent/wallet") : guideBtn());
  }
  return true;
}

// true when the callback belonged to launching
export async function handleCallback(cq, tg) {
  if (!String(cq?.data || "").startsWith("tl:")) return false;
  const ans = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const id = cq.data.slice(3), p = pend.get(id);
  const chat = cq.message?.chat?.id, mid = cq.message?.message_id;
  const mine = !!p && String(cq.from?.id) === String(p.chat) && String(chat) === String(p.chat);
  const s = mine ? sessions.get(chat) : null;
  const say = (t, markup) => tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }).catch(() => null);
  const edit = (t, markup) => tg("editMessageText", { chat_id: chat, message_id: mid, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }).catch(() => null);
  if (!p || p.exp < Date.now()) {
    // a Confirm pressed after its 90 seconds, while the launch is still set up (the setup lives 30 minutes): instead of
    // "start again", read the plan, the daily limits, the launch fee and the Agent Wallet balance again and send a fresh
    // preview. Nothing launches here: the new card needs its own Confirm within 90 seconds. Only this setup's own card
    // counts, and its old Confirm is spent here, so a stale card can never launch.
    if (mine && p.act === "confirm" && s?.step === "preview" && s.exp > Date.now() && !busy.has(chat) && p.ses === s) {
      pend.delete(id);
      await ans("That Confirm expired. Prices and limits re-checked, see the new preview.");
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }).catch(() => null);
      s.exp = Date.now() + SESSION_TTL;
      await showPreview(await import("./launch.mjs"), tg, s, say, { recheck: true });
      return true;
    }
    await ans("This button expired. Send /launch to start again.", true); return true;
  }
  if (!mine) { await ans("These buttons belong to someone else's chat."); return true; }
  if (!s) { await ans("This launch was dropped. Send /launch to start again.", true); return true; }
  const L = await import("./launch.mjs");
  pend.delete(id);
  // a tap is an answer too: the setup lives 30 minutes from the last one, buttons included
  s.exp = Date.now() + SESSION_TTL;
  if (p.act === "cancel") { sessions.delete(chat); await ans("Dropped"); await edit("Launch dropped. Send /launch to start again."); return true; }
  if (p.act === "tax" && s.step === "tax") {
    s.taxBps = p.v; s.step = "buy"; await ans();
    await edit(`Creator tax: ${p.v ? `${p.v / 100}%` : "none"}.`);
    await say("Initial buy? Your Agent Wallet buys right after the first 3 seconds, through the Gate and within its caps.", buyKb(chat));
    return true;
  }
  if (p.act === "buy" && s.step === "buy") {
    s.buyEth = p.v; await ans();
    await edit(`Initial buy: ${p.v ? `${p.v} ETH` : "none"}.`);
    await showPreview(L, tg, s, say);
    return true;
  }
  if (p.act === "confirm" && s.step === "preview") {
    if (p.ses !== s) { await ans("This preview was replaced by a newer one. Use the newest preview.", true); return true; }
    if (busy.has(chat)) { await ans("Already launching one. Wait for it to finish."); return true; }
    busy.add(chat); sessions.delete(chat);
    await ans("Launching…");
    await edit(`<b>Launching $${esc(s.symbol)}…</b> Your Agent Wallet is sending it to Robinhood Chain${s.buyEth ? `, then the ${s.buyEth} ETH buy` : ""}. This takes a few seconds.`);
    // the launch runs in the background so the bot keeps answering everyone else meanwhile
    (async () => {
      try {
        const out = await L.launchWithAgentWallet({ owner: s.owner, name: s.name, symbol: s.symbol, logo: s.logo, creatorTaxBps: s.taxBps, source: "tg", ref: `tg:${chat}:${mid}`, buyEth: s.buyEth,
          description: s.description || "", website: s.website || "", telegram: s.telegram || "", twitter: s.twitter || "" });
        if (!out.ok) {
          if (out.why === "pending") {
            await edit(`<b>$${esc(s.symbol)} is still confirming on Robinhood Chain.</b> Once it lands it shows on Troya Launches and in your Creator desk.`, { inline_keyboard: [[{ text: "Troya Launches", url: `${SITE}/agent#/troya-launches` }]] });
            return;
          }
          if (out.why === "reverted") { await edit("<b>Not launched:</b> the launch transaction failed on Robinhood Chain, so no coin was created (only a little gas was used). Wait a minute and send /launch again.", guideBtn()); return; }
          const reason = out.why === "no-agent-wallet" ? "your wallet has no Agent Wallet yet" : (out.reasons || [])[0] || "the launch could not be sent";
          await edit(`<b>Not launched:</b> ${why(reason, 200)}. Nothing was spent.`, guideBtn());
          return;
        }
        const ca = out.launch.token, ib = out.launch.initialBuy;
        const mc = await L.marketCapUsd(ca).catch(() => null);
        const mcTxt = mc ? `$${mc >= 1e6 ? (mc / 1e6).toFixed(2) + "M" : mc >= 1e3 ? (mc / 1e3).toFixed(1) + "K" : mc.toFixed(0)}` : null;
        // "Sell here" exists only while trading in Telegram is on (TG_TRADE=1), so the sentence names the button that is
        // really below: otherwise the sale is on troya.codes (Launch from X → Your launches)
        const tgTrade = process.env.TG_TRADE === "1";
        const coinUrl = `${SITE}/agent#/token/${lc(ca)}`;
        const lines = [`<b>$${esc(s.symbol)} is live.</b>${mcTxt ? ` Market cap ~${mcTxt}.` : ""}`];
        if (ib) lines.push(ib.executed ? `Initial buy of ${ib.eth} ETH done. ${tgTrade ? `To sell it, tap "Sell here" below (25%, 50% or 100%, from your Agent Wallet).` : `To sell it, open Launch from X → Your launches on troya.codes (the "Your launches" button below; 25%, 50% or 100%, from your Agent Wallet).`}` : `Initial buy not sent: ${esc(String(ib.reasons?.[0] || "it was refused").slice(0, 120))}.`);
        if (!s.logo) lines.push("No image was attached, so the coin has none.");
        lines.push(`Creator fee: ${out.launch.split ? `0.6% of volume${s.taxBps ? ` plus your ${s.taxBps / 100}% tax` : ""} to you, 0.1% to Troya` : "all yours"}.`, "", `CA: <code>${ca}</code>`, "", "Send /launch to launch another.");
        // the share step: a ready post with the ticker, the full CA and the coin's page (one cashtag, the creator posts it)
        const share = `https://x.com/intent/post?text=${encodeURIComponent(`$${s.symbol} is live on Robinhood Chain\nCA ${ca}\n${coinUrl}`)}`;
        const sell = tgTrade ? [[{ text: ib?.executed ? "Sell here" : "Buy or sell here", url: `https://t.me/${BOT}?start=t_${lc(ca)}` }]]
          : ib?.executed ? [[{ text: "Your launches", url: `${SITE}/agent#/launch/x` }]] : [];
        await edit(lines.join("\n"), { inline_keyboard: [[{ text: "Trade it on Troya", url: coinUrl }], ...sell,
          [{ text: "Share on X", url: share }, { text: "Creator desk", url: `${SITE}/agent#/creator` }],
          [{ text: "Troya Launches", url: `${SITE}/agent#/troya-launches` }]] });
      } catch (e) {
        await edit(`<b>Not launched:</b> ${why(e, 200)}. Nothing was spent.`, guideBtn());
      } finally { busy.delete(chat); }
    })();
    return true;
  }
  await ans();
  return true;
}
