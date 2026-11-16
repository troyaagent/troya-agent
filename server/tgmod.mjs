// Group moderation for t.me/troyaagent: removes shilling of other coins, call-channel ads, paid-promo offers and
// forwarded ads, and handles /report. A first offence is removed with a warning; a second one inside 24 hours, or a
// message that is plainly spam or a scam, is a ban (with all their messages revoked). Admins, the bot and our own
// channels are never touched. The join guard in tgbot.mjs still handles newcomers.
//   score(text)  → how promotional a message reads (3+ = remove on sight, 2+ = remove when a member reports it)
//   screen(m, tg, me) → true when the message was handled (removed or a command) and the bot should stay quiet
import { readFileSync } from "node:fs";
const OWN_HANDLES = /^(trojantroya_bot|troyaagent|troyasentry|admin|admins)$/i;
const OWN_CHATS = new Set([String(process.env.SENTRY_CHANNEL_ID || "-1004430431881")]);
const MAJORS = /^(TROYA|ETH|WETH|BTC|WBTC|HYPE|SOL|USDC|USDT|USDG|NVDA|TSLA|AAPL|SPY|QQQ|AMZN|MSFT|GOOGL|META)$/i;

export const BLACKLIST = /f[o0]urtis|fourvote|fourrank|gem\s?pump|dexvra|majors?boosts?|coin_?trending|hood\s?hunters?|dex\s?socials?|coinsniper|coinmooner|coinhunt\b|gemfinder|freshcoins|top100token/i;
// places a holder may fairly ask about; the listing-seller script below never fires on these
const VENUES = String.raw`(?:dex\s?screener|coin\s?gecko|gecko\s?terminal|coin\s?market\s?cap|cmc|cg|uniswap|pons|robinhood|hyperliquid|binance|coinbase|bybit|okx|kraken|kucoin|gate|mexc|bitget|dextools|birdeye|gmgn|x|twitter|telegram|tg)\b`;
// the listing seller's script: seed "still not listed on X", "the more listings the better", "confirm our listing on X", "update our socials on X"
const LISTING = new RegExp([
  String.raw`\bnot\s+(?:yet\s+)?listed\s+on\s+(?!${VENUES})[A-Za-z]`,
  String.raw`\b(?:have|did)\s+you\s+(?:considered?|thought\s+(?:of|about))\s+(?:getting\s+)?list(?:ing|ed)\s+on\b`,
  String.raw`\b(?:the\s+)?more\s+listings\b`,
  String.raw`\blisted\s+on\s+(?:all|every|more|many|multiple)\s+(?:the\s+)?(?:major\s+|big\s+|top\s+)?(?:platforms?|sites?|directories|trackers)\b`,
  String.raw`\bget\s+(?:us\s+|it\s+)?(?:on|listed\s+on)\s+(?:more|all|every)\s+(?:the\s+)?(?:sites?|platforms?|directories|trackers)\b`,
  String.raw`\bconfirm\s+(?:our|the|your|my)\s+listing\b`,
  String.raw`\bupdate\s+(?:our|the|your)\s+(?:telegram|tg|x|twitter|website|socials?|links?|info|profile)\b[^\n]{0,40}\bon\s+(?!${VENUES})[A-Za-z]`,
].join("|"), "i");
// fake "V2 / relaunch / migration" announcements that send holders to a drainer bot, and bots posing as DexScreener or Troya.
// Admins post real news and are never screened, so a member's "migration portal" or look-alike bot is a scam: a ban at once.
const IMPOSTOR = new RegExp([
  String.raw`\b(?:v2|migrat\w*|relaunch\w*|allocation|airdrop)\b[^]{0,400}?\b(?:portal|bot|link|dapp|site|here)\b\s*[:\-–—]?\s*(?:👉\s*)?(?:@(?!(?:trojantroya_bot|troyaagent|troyasentry)\b)[A-Za-z0-9_]{4,}|https?:\/\/(?!(?:www\.)?(?:troya\.codes|x\.com|twitter\.com|dexscreener\.com|robinhoodchain\.blockscout\.com|t\.me\/(?:troyaagent|troyasentry|trojantroya_bot))\b))`,
  String.raw`\bverify\s+(?:your\s+|their\s+)?(?:previous\s+|old\s+)?(?:token\s+)?holdings\b`,
  String.raw`\b(?:v2|holder|token)\s+(?:allocation|migration)\b[^]{0,400}?(?:eligible\s+holders|official\s+updates|portal)`,
  String.raw`@(?!trojantroya_bot\b)[A-Za-z0-9_]*(?:d[e3]x[a-z0-9_]{0,8}n[e3]r|tr[o0]ya|claim|airdrop|migrat|rectif|validat|walletconnect)[A-Za-z0-9_]*bot\b`,
].join("|"), "iu");
// "private holders group / whales chat" and "hit me up, I'll get you added": each half alone is a question, together the scam
const DM_ASK = /\b(?:send|drop|shoot)\s+(?:me\s+|us\s+)?(?:a\s+)?(?:d[il1]rect\s+|pr[il1]vate\s+){1,2}(?:mess?age|msg|dm|pm)\b|\bhit\s+me\s+up\b|\bsend\s+me\s+a\s+(?:message|msg|pm|text)\b|\b(?:message|msg|pm|text)\s+me\b|\bget\s+(?:you\s+)?added\b|\bi.?ll\s+(?:get\s+you\s+)?add(?:ed)?\s+you\b/i;
const PRIVATE_CHAT = /\b(?:private|exclusive|secret|inner|vip)\s+(?:holders?|whales?|alpha|investors?|community)\s+(?:group|chat|channel|circle)\b|\bwhales?\s+(?:chat|group|channel|circle)\b|\bholders?\s+only\s+(?:group|chat)\b/i;
// "I am co-founder of X, I have a partnership offer, who is the best person to discuss this with?"
const PARTNERSHIP = /\b(?:partnership|collaboration|collab)\s+(?:offer|proposal|opportunit\w*|deal)\b|\bbest\s+person\s+to\s+(?:discuss|talk|speak|contact|reach)\b|\b(?:discuss|talk\s+about)\s+(?:a\s+|this\s+|the\s+|potential\s+)?(?:partnership|collaboration|collab)\b/i;
// a member whose name claims a team role (or is the project's own name): nothing on its own, a ban with any promo or DM ask
export const IMPOSTOR_NAME = /co.?founder|\bfounder\b|\bceo\b|\bcto\b|\bcmo\b|\badmin\b|\bmoderator\b|\bmod\b|\bdev\b|\bdeveloper\b|\bsupport\b|\bofficial\b|\bteam\b|^\s*troya(?:\s+(?:agent|team|support|official|dev|admin))?\s*$/i;
// letters swapped to slip past filters: "hoIders" (capital I for l), Cyrillic or Greek look-alikes, 𝐟𝐚𝐧𝐜𝐲 letters
const FOLD_FROM = [..."аеорсухіјѕԁһԛԝкмнтвαβεζηικμνορτυχ"], FOLD_TO = [..."aeopcyxijsdhqwkmhtbabezhikmnoptyx"];
const FOLD = new Map(FOLD_FROM.map((c, i) => [c, FOLD_TO[i]]));
export const fold = (x) => String(x || "").normalize("NFKC")
  .replace(/[Ͱ-ϿЀ-ԯ]/g, (c) => FOLD.get(c) ?? (FOLD.has(c.toLowerCase()) ? FOLD.get(c.toLowerCase()).toUpperCase() : c))
  .replace(/(?<=[a-z])I(?=[a-z])/g, "l")
  .replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, "o");
const nameOf = (u) => fold([u?.first_name, u?.last_name].filter(Boolean).join(" "));
const fakeName = (u) => IMPOSTOR_NAME.test(nameOf(u));
// "urgent announcement for all holders, important information regarding your holdings": the bait half of a DM scam
const HOLDINGS_BAIT = /\b[il1]mportant\s+[il1]nformat[il1]on\s+(?:regarding|about|on|for)\s+(?:your|ur)\b|\burgent\s+ann[o0]uncement\b|\bregarding\s+(?:your|ur)\s+(?:h[o0][il1]dings|wallets?|tokens|funds|bags)\b/i;
// a member named as the project or its bot ("Troya Agent", "Tr0ya Ag3nt", "Troya | Agent", "Troya Support"): Troya never posts
// as a member, so any message from one is removed and the account banned. Checked on every message, since scammers join under
// another name and rename later.
const squeeze = (x) => fold(x).toLowerCase().replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
export function posesAsProject(u) {
  if (!u || u.is_bot) return false;
  const n = squeeze([u.first_name, u.last_name].filter(Boolean).join(" ")), h = squeeze(u.username);
  return /troyaagent|trojantroya|troyasentry/.test(n)
    || /^troya(?:team|support|official|admin|dev|mod|bot|news|updates?|announcements?|help|helpdesk|care|ai)?$/.test(n)
    || /troyaagent|trojantroya|troyasentry|troya(?:support|admin|official|team|help|dev|mod)/.test(h);
}
// selling listings, trending spots, boosts or votes: "listed on @x", "boost your token with @x", "I can add the rocket to 300", trending-bot posts
const SERVICES = /\b(?:list(?:ed|ing)?|trend(?:ing)?|votes?|boost(?:s|ed|ing)?)\b[^\n@]{0,40}\b(?:on|at|with|via|by|in|from)\s+@(?!(?:trojantroya_bot|troyaagent|troyasentry|admin|admins)\b)[A-Za-z0-9_]{4,32}|\bI\s+can\s+(?:add|get|give|push|bring|increase)\b[^\n]{0,60}\b(?:votes?|rockets?|flames?|holders|volume|trending|views|members)\b|\b(?:add|increase)\s+(?:up\s+)?the\s+(?:rockets?|flames?|votes?)|🔥\s*TRENDING\s*🔥/i;
const RULES = [
  // links to other chains' charts and launchpads, other groups and bots (Troya is Robinhood Chain only)
  [3, /dexscreener\.com\/(?!robinhood)|pump\.fun|birdeye\.so|dextools\.io|gmgn\.ai|photon-sol|axiom\.trade|bullx\.io|geckoterminal\.com\/(?!robinhood)|t\.me\/(?!troyaagent\b|troyasentry\b|trojantroya_bot\b)|telegram\.me\/|chat\.whatsapp\.com|discord\.gg\//i],
  // a Solana-style address (Troya never posts one)
  [3, /(?:^|[^A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/],
  // paid promotion, boosts, fake votes
  [3, /promot(?:e|ing|ion)\s+(?:for\s+)?(?:your|ur)\s+(?:project|token|coin)|professional\s+promotion|targeted\s+promotions?|reach\s+(?:genuine|real|active|organic)\s+(?:investors|holders|traders|buyers)|grow\s+(?:your|ur)\s+project|boost\s+(?:your|ur)\s+(?:token|project|coin)|(?:dex|trending)\s*(?:boost|rocket|vote)|rocket\W.{0,40}vote|buying\s+(?:volume|activity|pressure)\s+(?:of|from|up)|\bkols?\b.{0,60}(?:promot|reach|volume)|volume\s+bot|(?:cmc|coinmarketcap)\s+(?:trending|communit)|\d+\+?\s*(?:tg|telegram)\s+channels/i],
  // call channels, "insider" and signal sellers
  [3, /insider\s+(?:calls?|printing|plays?)|next\s+(?:call|play|gem)|(?:my|our)\s+(?:next\s+)?calls?\b|call(?:ed)?\s+(?:this|it)\s+(?:one\s+)?(?:privately|early|at)|called\s+privately|\bvip\s+(?:calls?|group|channel)|verified\s+scanners?|(?:good|quality|best|free)\s+signals|signals?\s+(?:group|channel)|catch(?:ing)?\s+(?:all\s+)?(?:the\s+)?runners|call\s+the\s+big\s+investors/i],
  // scams (also a ban at once, see SCAM)
  [3, /rug\s?pull.{0,80}(?:teach|learn|dm)|(?:teach|show)\s+you\s+how|recover\s+(?:your\s+)?(?:funds|wallet|crypto)|guaranteed\s+(?:profit|returns?)|investment\s+(?:manager|plan|account)/i],
  // gains brags: "106X", "(30K >1.1M)", "50k → 1.7m", "NOW AT $10M MC"
  [2, /\b\d{2,4}\s?x\b(?!\s*(?:lev|leverage|long|short))|\(\s*\d+(?:\.\d+)?\s*k\s*>\s*\d|\d+(?:\.\d+)?\s*k\s*(?:>|->|→|to)\s*\d+(?:\.\d+)?\s*m\b|\bnow\s+at\s+\$?\d/i],
  [2, /profit\s+upon\s+profit|make\s+(?:a\s+)?profit\s+of|invested\s+\$\d+.{0,60}profit|(?:made|making)\s+\$?\d+k?\s+(?:from|in|off)\s|turned\s+\$\d+\s+into/i],
  [2, /\bd\.?\s?m\s+(?:me|now|👉|for)|\bd\.m\.?\s+me|\binbox\s+me|send\s+(?:me\s+)?a\s+dm|make\s+sure\s+you\s+follow|follow\s+(?:him|her)\b/i],
  [1, /\bprinting\b|\bmilestone\b|don.?t\s+miss\s+(?:out|it)|\bgem\b|\b100x\b|\bmoon(?:ing|shot)?\b/i],
  // blacklisted names and service pitches: listing, trending, vote and boost sellers the group asked to keep out
  [3, BLACKLIST],
  [3, SERVICES],
  [3, LISTING],
  // fake migrations and look-alike bots (also a ban at once, see severeOf)
  [3, IMPOSTOR],
  [2, DM_ASK],
  [2, PRIVATE_CHAT],
  [3, PARTNERSHIP],
  [2, HOLDINGS_BAIT],
];

// how promotional a text reads: rule weights plus other people's @handles and other coins' tickers when they come with it
const SCAM = RULES[4][1];
export function score(text) {
  const t = fold(text);
  if (!t.trim()) return 0;
  let s = 0;
  for (const [w, re] of RULES) if (re.test(t)) s += w;
  const handles = [...t.matchAll(/@([A-Za-z0-9_]{4,32})/g)].map((x) => x[1]).filter((h) => !OWN_HANDLES.test(h));
  const tickers = [...t.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g)].map((x) => x[1]).filter((x) => !MAJORS.test(x));
  if (handles.length) s += s >= 1 || /\bcalls?\b|\bdm\b|follow|boost|signal|vip/i.test(t) ? 3 : 0;
  if (tickers.length && s >= 1) s += 1;
  return s;
}

// a forwarded message counts as an ad when it comes from a channel or chat that isn't ours
function foreignForward(m) {
  const o = m.forward_origin;
  if (!o || m.is_automatic_forward) return false;
  const id = String(o.chat?.id ?? o.sender_chat?.id ?? "");
  if (id && (OWN_CHATS.has(id) || id === String(m.chat.id))) return false;
  if (o.sender_user?.is_bot && OWN_HANDLES.test(o.sender_user.username || "")) return false;
  return o.type === "channel" || o.type === "chat";
}
const body = (m) => String(m?.text || m?.caption || "");
export const verdict = (m) => (foreignForward(m) ? 3 + score(body(m)) : score(body(m)));

/* ---------- rules text (/rules and the pinned post) ---------- */
function siteCa() {
  try { return (readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1] || ""; } catch { return ""; }
}
export function rulesText(ca = siteCa()) {
  return `<b>Troya Agent group rules</b>

This group is for Troya Agent only: the project, its progress and the team building it. Troya is built on Robinhood Chain and works inside its ecosystem, and the team ships carefully, one tested step at a time.

1. Stay on topic: Troya Agent, Robinhood Chain and what is being built around it.
2. No promotion of other coins: no call channels, signal groups, "100x" brags or forwarded ads.
3. No paid-promotion, boost, vote, volume or listing offers. The team does not take them in this chat.
4. No scams, no links to other groups or bots, no asking people to DM you, send funds or share a seed phrase.
5. Admins never DM first. Anyone who does is not the team.
6. The only official $TROYA contract on Robinhood Chain:
<code>${ca}</code>
Ignore any other address.
7. Be decent to each other, and check any coin with Troya Gate before you trade it.

<b>How it is enforced</b>
A message that breaks rules 2 to 4 is removed and you get a warning. A second one, or anything plainly spam or a scam, is a ban. See something like it? Reply <code>/report</code> to the message.

Official links: troya.codes · x.com/Troyaagent · t.me/troyasentry`;
}

/* ---------- state: admins (cached), strikes, people caught recently, reports ---------- */
const adminCache = new Map();   // chat → { at, ids:Set }
async function admins(tg, chat) {
  const c = adminCache.get(chat);
  if (c && Date.now() - c.at < 10 * 60e3) return c.ids;
  const r = await tg("getChatAdministrators", { chat_id: chat }).catch(() => null);
  const ids = new Set((r?.result || []).map((a) => a.user.id));
  if (r?.ok) adminCache.set(chat, { at: Date.now(), ids });
  return ids;
}
const strikes = new Map();      // `${chat}:${user}` → offence times in the last 24 hours
const caught = new Map();       // `${chat}:${user}` → until (ms): right after a warning, more promo is the second strike
const reports = new Map();      // `${chat}:${msg}` → Set of reporter ids
const STRIKE_MS = 24 * 3600e3, FLAG_MS = 30 * 60e3;
function strike(key) {
  const now = Date.now();
  const list = (strikes.get(key) || []).filter((t) => now - t < STRIKE_MS);
  list.push(now); strikes.set(key, list);
  if (strikes.size > 2000) strikes.delete(strikes.keys().next().value);
  caught.set(key, now + FLAG_MS);
  return list.length;
}

const del = (tg, chat, id) => tg("deleteMessage", { chat_id: chat, message_id: id }).catch(() => null);
async function brief(tg, chat, text, ms = 20000) {
  const r = await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_notification: true, link_preview_options: { is_disabled: true } }).catch(() => null);
  const id = r?.result?.message_id;
  if (id) setTimeout(() => del(tg, chat, id), ms).unref?.();
}
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const who = (u) => esc(String(u?.first_name || u?.username || "someone").slice(0, 32));

async function ban(tg, chat, user, why) {
  const r = await tg("banChatMember", { chat_id: chat, user_id: user.id, revoke_messages: true }).catch(() => null);
  console.log(`[mod] ban ${user.id} (${why}) ${r?.ok ? "ok" : r?.description || "failed"}`);
  if (r?.ok) await brief(tg, chat, `${who(user)} was banned for spam.`, 30000);
  return !!r?.ok;
}
// one offence: remove it, then warn, or ban when it is the second inside 24 hours or plainly spam
async function offence(tg, chat, msgId, user, { severe = false, why = "" } = {}) {
  await del(tg, chat, msgId);
  const n = strike(`${chat}:${user.id}`);
  console.log(`[mod] removed ${msgId} from ${user.id} (${why}, strike ${n}${severe ? ", severe" : ""})`);
  if (severe || n >= 2) return ban(tg, chat, user, why);
  await brief(tg, chat, `${who(user)}, this is a warning: promotions, calls and ads for other coins are not allowed here. Next time is a ban. Group rules: /rules`, 60000);
  return false;
}
const severeOf = (m, v) => v >= 6 || SCAM.test(fold(body(m))) || IMPOSTOR.test(fold(body(m))) || (fakeName(m.from) && v >= 2) || posesAsProject(m.from) || (foreignForward(m) && score(body(m)) >= 3);

export async function screen(m, tg, me) {
  const chat = m.chat?.id;
  if (!chat || !m.from || m.from.is_bot) return false;
  if (m.sender_chat && (String(m.sender_chat.id) === String(chat) || OWN_CHATS.has(String(m.sender_chat.id)))) return false;   // anonymous admin / our channel
  const adm = await admins(tg, chat);
  const isAdm = adm.has(m.from.id);
  if (!isAdm && posesAsProject(m.from)) {
    await del(tg, chat, m.message_id);
    console.log(`[mod] removed ${m.message_id} from ${m.from.id} (name poses as Troya)`);
    await ban(tg, chat, m.from, "name poses as Troya");
    return true;
  }
  const mine = (at) => !at || at.toLowerCase() === String(me?.username || "").toLowerCase();

  // /report (also /spam, and /ban from members): reply to the message you want checked. An admin's /ban bans at once.
  const cmd = /^\/(report|spam|ban)(?:@([A-Za-z0-9_]+))?\b/i.exec(body(m).trim());
  if (cmd && mine(cmd[2])) {
    await del(tg, chat, m.message_id);
    const t = m.reply_to_message;
    if (!t || !t.from) { await brief(tg, chat, `Reply <code>/report</code> to the message you want removed.`); return true; }
    if (t.from.is_bot || adm.has(t.from.id) || t.from.id === m.from.id) return true;
    if (isAdm && cmd[1].toLowerCase() === "ban") { await del(tg, chat, t.message_id); await ban(tg, chat, t.from, `admin /ban by ${m.from.id}`); return true; }
    const rk = `${chat}:${t.message_id}`;
    if (!reports.has(rk)) import("./community.mjs").then((c) => c.addFromTelegram({ kind: "scam", text: "Reported in the group", from: m.from, chat: m.chat, reported: { ...t.from, text: body(t) } })).catch(() => {});
    const set = reports.get(rk) || new Set(); set.add(m.from.id); reports.set(rk, set);
    if (reports.size > 500) reports.delete(reports.keys().next().value);
    const v = verdict(t), flagged = (caught.get(`${chat}:${t.from.id}`) || 0) > Date.now();
    if (isAdm || v >= 2 || flagged || set.size >= 2 || posesAsProject(t.from)) {
      const banned = await offence(tg, chat, t.message_id, t.from, { severe: severeOf(t, v), why: `report by ${m.from.id}` });
      if (!banned) await brief(tg, chat, `Removed. Thanks for the report, ${who(m.from)}.`);
    } else {
      await brief(tg, chat, `Noted, ${who(m.from)}. It goes as soon as one more member reports it.`);
    }
    return true;
  }
  if (isAdm) return false;

  const v = verdict(m);
  const flagged = (caught.get(`${chat}:${m.from.id}`) || 0) > Date.now();
  // just warned: more promo (or a forwarded or captionless post) is the second strike; a plain chat line still goes through
  if (flagged && (v >= 2 || foreignForward(m) || (!body(m).trim() && (m.photo || m.video || m.animation || m.document)))) {
    await offence(tg, chat, m.message_id, m.from, { severe: true, why: "again right after a warning" });
    return true;
  }
  if (flagged && v >= 1) { await del(tg, chat, m.message_id); return true; }
  if (v >= 3 || (v >= 2 && fakeName(m.from))) { await offence(tg, chat, m.message_id, m.from, { severe: severeOf(m, v), why: foreignForward(m) ? "forwarded ad" : fakeName(m.from) && v < 3 ? `score ${v}, name poses as the team` : `score ${v}` }); return true; }
  return false;
}
