// Activity feed (owner, 22 Nov 2026): real things that happen on Troya, posted to the Telegram group and summed up on X, so
// members can see the site is used. Only real records: nothing is estimated, nothing is invented, no price talk.
//
// Sources, and how each is seen
//   launch          every coin born through Troya (web, Launch on X, Launch in Telegram): launch.mjs addRecord() emits it
//   stake           a wallet that stakes $TROYA for the first time: stake.mjs scan() emits each Staked event of the index
//   registry.agent  an agent registered in the AI calls registry (#/registry): registry.mjs createAgent() emits it
//   f20.agent       an agent built in the Agent factory (#/social/agents): read from data/agents.json
//   gate checks     outside agents using Troya Gate: data/gateapi.json (API checks per caller, USDG credit spent, ACP jobs)
//                   and data/x402.json (settled x402 payments), counted per hour; callers are told apart by a salted
//                   hash only, never stored or shown in the clear
//   grad            a coin launched through Troya that graduated to Uniswap: data/graduations.json (pulse.mjs) ∩ launches.json
//   payout          the daily stakers' share once sent live: data/fee-split.json (feesplit.mjs, status "sent" with its tx)
//   mc.tier         $TROYA market-cap tier crossings ($35k, $100k): data/mc-hourly.json hourly medians, only when the last
//                   ACTIVITY_MC_CONFIRM_H (2) full hours all sit past the line by ACTIVITY_MC_MARGIN (5%), so it never flaps
//   arena           real-money Arena trades opened and closed: data/arena.json positions with mode "live"
//   cup             Arena Cup prizes and referral rewards paid: data/payouts.json weeks paid live
// File sources are primed on the first run (what is already there is marked seen, never posted), so a fresh start posts
// only what happens after it. An event older than 3 hours when it is first seen is recorded and never posted.
//
// Telegram (ACTIVITY_FEED=live|dry|off, default dry; ACTIVITY_CHAT, default @troyaagent)
//   one post per event for launches, new stakers, registered agents, graduations, staker payouts, tier crossings and Cup
//   payouts; the outside-agent checks and the Arena's real-money trades as one summary an hour. At most one message per
//   ACTIVITY_TG_GAP_S (90) seconds and ACTIVITY_TG_PER_HOUR (12) an hour: what queues meanwhile goes out as one message.
//   A launch waits for its Troya Gate verdict (up to ACTIVITY_GATE_WAIT_MIN, 10 minutes). A coin the Gate blocks, or whose
//   name reads like another project's (the Telegram guard's rules), is posted as a neutral "launch recorded" with no link;
//   an obvious spam name is not posted at all. Team test coins are never posted.
// X (ACTIVITY_X=live|dry|off, default dry)
//   a digest every ACTIVITY_X_EVERY_H (4) hours, only when something happened, and the daily recap. Every post goes through
//   xsocial.postTweet (the shared daily X budget). One cashtag at most: $TROYA, and only when TROYA itself is named.
// Daily recap at ACTIVITY_RECAP_UTC_HOUR (13) UTC, to the group and X: launches, trades through Troya, new stakers, ETH to
// stakers, outside-agent checks over the last 24 hours. A zero line is left out; nothing at all is posted on a zero day.
// dry: everything is worked out and kept in data/activity.json (posts with mode "dry"), nothing is sent.
// State (seen keys, the queue, the hour's counts, the last sends) lives in data/activity.json, written before anything is
// sent, so a restart never posts twice.
//   GET /api/activity           recent events and posts (sent or would-be), the queue and the switches
//   GET /api/activity/preview   admins: the next Telegram message, the next X digest so far and the next recap
import { createHmac, randomBytes } from "node:crypto";
import { score as promoScore, posesAsProject, fold } from "./tgmod.mjs";
import { LABEL, LEGACY } from "../public/agent/js/verdict.js";

const FILE = "activity.json";
const SITE = "https://troya.codes";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const MAX_AGE = 3 * HOUR;                 // first seen later than this after it happened: recorded, never posted
const TEST_WALLETS = ["0x12a05719851c8375342de65c9105329c81f57054"];   // the team's test wallet (as launch.mjs and stats.mjs)
const AI_NAMES = { "ai-claude": "Claude", "ai-gpt": "GPT", "ai-gemini": "Gemini", "ai-deepseek": "DeepSeek", "ai-qwen": "Qwen" };
const NETS = { "eip155:8453": "Base", "eip155:42161": "Arbitrum", "eip155:137": "Polygon", "eip155:4663": "Robinhood Chain", "eip155:84532": "Base Sepolia" };
// tickers of big coins and Troya's own: a new coin under one of these is a copy, posted as "launch recorded" without its name
const COPY_TICKERS = /^(TROYA|ETH|WETH|BTC|WBTC|USDC|USDT|USDG|HOOD|HYPE|SOL)$/i;
const MIXED = /[Ͱ-ϿЀ-ԯ]/;                // Cyrillic or Greek letters mixed into a Latin name (sentry.lookAlike)
const TRADE = /^agent-wallet\.(swap|perp|close)$|^perp_order$/;          // the trades stats.mjs counts

const lc = (s) => String(s || "").toLowerCase();
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const isTx = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h || ""));
const short = (a) => (isAddr(a) ? `${lc(a).slice(0, 6)}…${lc(a).slice(-4)}` : "");
const strip = (h) => String(h || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const hourStart = (k) => Date.parse(`${k}:00:00.000Z`);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const admins = () => String(`${process.env.X_ADMINS || ""},${process.env.TROYA_ADMINS || ""}`).split(",").map((a) => lc(a.trim())).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const teamSet = () => new Set([...TEST_WALLETS, ...admins(), ...String(process.env.STATS_EXCLUDE || "").split(",").map((a) => lc(a.trim())), lc(process.env.ARENA_LIVE_OWNER)].filter((a) => /^0x[0-9a-f]{40}$/.test(a)));

const modeOf = (v) => (["live", "dry", "off"].includes(v) ? v : "dry");
export const tgMode = () => modeOf(process.env.ACTIVITY_FEED);
export const xMode = () => modeOf(process.env.ACTIVITY_X);
const num = (v, d, lo = -Infinity, hi = Infinity) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export const CFG = () => ({
  chat: process.env.ACTIVITY_CHAT || "@troyaagent",
  gapMs: num(process.env.ACTIVITY_TG_GAP_S, 90, 30, 3600) * 1000,
  perHour: num(process.env.ACTIVITY_TG_PER_HOUR, 12, 1, 60),
  gatherMs: 20_000,                       // a ready event waits this long so a burst leaves as one message
  gateWaitMs: num(process.env.ACTIVITY_GATE_WAIT_MIN, 10, 1, 60) * MIN,
  xEveryMs: num(process.env.ACTIVITY_X_EVERY_H, 4, 1, 24) * HOUR,
  recapHour: num(process.env.ACTIVITY_RECAP_UTC_HOUR, 13, 0, 23),
  mcMargin: num(process.env.ACTIVITY_MC_MARGIN, 0.05, 0, 0.5),
  mcConfirmH: Math.round(num(process.env.ACTIVITY_MC_CONFIRM_H, 2, 1, 12)),
});

/* ---------------- numbers and names ---------------- */
export function fmtTok(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  const t = (x, s) => `${+x.toFixed(x >= 100 ? 0 : 1)}${s}`;
  return a >= 1e9 ? t(v / 1e9, "B") : a >= 1e6 ? t(v / 1e6, "M") : a >= 1e4 ? t(v / 1e3, "K") : Math.round(v).toLocaleString("en-US");
}
export const fmtEth = (x) => { const v = Number(x) || 0; return String(+v.toFixed(v !== 0 && Math.abs(v) < 0.001 ? 6 : 4)); };
const fmtUsd = (x) => { const v = Number(x) || 0; return v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`; };
const fmtPct = (bps) => `${+(bps / 100).toFixed(2)}%`;
// names and tickers are attacker-controlled: no links, no handles, no control characters, short
export function cleanName(s, n = 32) {
  let t = String(s ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");
  t = t.replace(/(https?:\/\/|www\.)\S*/gi, "").replace(/\b[\w-]+\.(com|io|xyz|me|org|net|fun|app|gg|co|codes|family|sh|ai)\b\S*/gi, "").replace(/t\.me\/\S*/gi, "").replace(/[@#$]/g, "");
  return t.replace(/\s+/g, " ").trim().slice(0, n);
}
const cleanSym = (s) => cleanName(s, 16).replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 16);
const tag = (sym) => (/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(sym) ? `$${sym}` : sym);           // Telegram has no cashtag limit
/** "HORSE (Wooden Horse)", or one of them when they are the same or one is missing */
export function coinTitle(name, symbol, { cash = true } = {}) {
  const n = cleanName(name), s = cleanSym(symbol);
  const head = s ? (cash ? tag(s) : s) : n;
  if (n && s && lc(n) !== lc(s)) return cash ? `${head} (${n})` : `${n} (${s})`;     // X: the name first, the ticker without $
  return head || "a new coin";
}

/** null, "spam" (not posted at all) or "impersonation" (posted as "launch recorded", without its name or a link) */
export function screenName(name, symbol) {
  const both = `${name || ""} ${symbol || ""}`;
  if (/https?:\/\/|\bt\.me\/|\bwww\./i.test(both) || promoScore(both) >= 3) return "spam";
  if (posesAsProject({ first_name: String(name || "") }) || posesAsProject({ first_name: String(symbol || "") })) return "impersonation";
  if (COPY_TICKERS.test(cleanSym(symbol)) || [name, symbol].some((x) => x && /[A-Za-z]/.test(x) && MIXED.test(x))) return "impersonation";
  if (/troya/i.test(fold(both).replace(/0/g, "o"))) return "impersonation";
  return null;
}
// a coin we may name on X: nothing a reader could take as a pitch ("moon", "100x", "gem", "buy")
const quietName = (name, symbol) => !screenName(name, symbol) && promoScore(`${name} ${symbol}`) === 0 && !/\b(buy|moon|pump|100x|gem|lambo)\b/i.test(`${name} ${symbol}`);

/** the Troya Gate word of a launch board row (verdict.js words), or null while it is still being checked */
export function gateWord(gate) {
  const v = gate?.verdict;
  const word = Object.keys(LEGACY).find((k) => LEGACY[k] === v) || (["passed", "notes", "blocked", "untestable"].includes(v) ? v : null);
  return word ? { word, label: LABEL[word] } : null;
}

/* ---------------- Telegram texts: each event is { text, line } (line: one row of a combined message) ---------------- */
const coinUrl = (token) => `${SITE}/agent#/token/${lc(token)}`;
const link = (url, label) => `<a href="${esc(url)}">${esc(label)}</a>`;
const VENUE = { web: "on troya.codes", x: "from a post on X", tg: "from Telegram" };

export function launchMsg(d) {
  const who = d.who?.html || "someone", venue = VENUE[d.source] || "on troya.codes";
  const g = d.gate ? `Troya Gate: ${d.gate.label}` : "Troya Gate: not checked yet";
  if (d.flag === "impersonation") return {
    text: `<b>Launch recorded</b>\nA coin was launched through Troya ${venue} by ${who}, on Pons (Robinhood Chain). Its name reads like another project's, so it is not named or linked here.`,
    line: `Launch recorded ${venue} by ${who} (its name reads like another project's, not linked)` };
  const title = esc(coinTitle(d.name, d.symbol));
  if (d.gate?.word === "blocked") return {
    text: `<b>Launch recorded</b>\n${title}, launched ${venue} by ${who}, on Pons (Robinhood Chain).\n${g}, so no link is shared.`,
    line: `Launch recorded: ${title} by ${who} · ${g}, no link` };
  return {
    text: `<b>New coin launched through Troya</b>\n${title}\nBy ${who}, ${venue} · Pons, Robinhood Chain\n${g}\n${link(coinUrl(d.token), "Chart and Troya Gate on troya.codes")}`,
    line: `New coin: ${title} by ${who}, ${venue} · ${g} · ${link(coinUrl(d.token), "page")}` };
}
export function stakeMsg(d) {
  const amt = `${fmtTok(d.amount)} $TROYA`;
  const pct = d.pctOfSupply > 0 ? ` (${+d.pctOfSupply.toFixed(d.pctOfSupply < 0.01 ? 4 : 2)}% of supply)` : "";
  const tier = d.tier ? `Tier: ${esc(d.tier.name)} once staked ${plural(d.tier.minDays, "day")}.` : d.minName ? `Below the ${esc(d.minName)} minimum for now.` : "";
  return {
    text: `<b>New $TROYA staker</b>\n${d.who?.html || "A wallet"} staked ${amt}${pct}.${tier ? `\n${tier}` : ""}\n${link(`${SITE}/stake`, "troya.codes/stake")}`,
    line: `New staker: ${d.who?.html || "a wallet"} staked ${amt}${d.tier ? ` (${esc(d.tier.name)} after ${plural(d.tier.minDays, "day")})` : ""} · ${link(`${SITE}/stake`, "stake")}` };
}
export function registryMsg(d) {
  const n = esc(cleanName(d.name, 40));
  return {
    text: `<b>New agent in the Troya registry</b>\n${n}, registered by ${d.who?.html || "a wallet"}. It files signed calls on Robinhood Chain coins, each graded in public later.\n${link(`${SITE}/agent#/registry`, "troya.codes/agent#/registry")}`,
    line: `New agent in the registry: ${n} by ${d.who?.html || "a wallet"} · ${link(`${SITE}/agent#/registry`, "registry")}` };
}
const TEMPLATE = { accumulator: "an Accumulator", index: "a Stock index", twap: "a Silent buyer", range: "a Range keeper", loan: "a Loan guard" };
export function f20Msg(d) {
  const n = esc(cleanName(d.name, 32)), slug = String(d.slug || "").replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const url = `${SITE}/agent#/social/agents/${slug}`;
  const kind = TEMPLATE[d.template] || "an";
  return {
    text: `<b>New agent built on Troya</b>\n${n} (@${esc(slug)}), ${kind} agent by ${d.who?.html || "a wallet"}. It runs on its owner's Agent Wallet, inside their limits.\n${link(url, `troya.codes/agent#/social/agents/${slug}`)}`,
    line: `New agent: ${n}, ${kind} agent by ${d.who?.html || "a wallet"} · ${link(url, "page")}` };
}
export function gradMsg(d) {
  const title = esc(coinTitle(d.name, d.symbol));
  if (d.gate?.word === "blocked") return {
    text: `<b>Graduated</b>\n${title}, launched on Troya, filled its Pons curve and moved to Uniswap v4 on Robinhood Chain.\nTroya Gate: ${d.gate.label}, so no link is shared.`,
    line: `Graduated: ${title}, launched on Troya · Troya Gate: ${d.gate.label}, no link` };
  return {
    text: `<b>Graduated</b>\n${title}, launched on Troya, just graduated to Uniswap v4 on Robinhood Chain.\n${link(coinUrl(d.token), "Chart and Troya Gate on troya.codes")}`,
    line: `Graduated: ${title}, launched on Troya, now on Uniswap v4 · ${link(coinUrl(d.token), "page")}` };
}
const dayLabel = (k) => new Date(`${k}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export function payoutMsg(d) {
  const tx = isTx(d.hash) ? link(`${EXPLORER}/tx/${d.hash}`, `${d.hash.slice(0, 10)}…`) : "";
  return {
    text: `<b>Paid to $TROYA stakers</b>\n${fmtEth(d.eth)} ETH paid to $TROYA stakers today (the share for ${dayLabel(d.day)}), sent into the staking contract. Claim any time.\n${tx ? `Tx ${tx} · ` : ""}${link(`${SITE}/stake`, "troya.codes/stake")}`,
    line: `${fmtEth(d.eth)} ETH paid to $TROYA stakers (share for ${dayLabel(d.day)})${tx ? ` · tx ${tx}` : ""}` };
}
export function mcMsg(d) {
  const up = d.dir === "up";
  const line = up ? `above ${fmtUsd(d.edge)}` : `under ${fmtUsd(d.edge)}`;
  return {
    text: `<b>$TROYA staker share: now ${fmtPct(d.toBps)} of volume</b>\nThe $TROYA market cap has ${up ? "held" : "stayed"} ${line} for ${plural(d.hours, "full hour")} (hourly median about ${fmtUsd(d.median)}), so the stakers' share of $TROYA trading volume moves ${up ? "up" : "down"} from ${fmtPct(d.fromBps)} to ${fmtPct(d.toBps)}. It follows market cap hour by hour and varies with volume; it is not a promised yield.\n${link(`${SITE}/stake`, "troya.codes/stake")}`,
    line: `$TROYA market cap ${up ? "held" : "stayed"} ${line} for ${plural(d.hours, "hour")}: stakers' share now ${fmtPct(d.toBps)} of volume (was ${fmtPct(d.fromBps)})` };
}
export function agentsHourMsg(d) {
  const total = d.api + d.x402 + d.acp;
  const known = d.agents + (d.acp > 0 ? 1 : 0);                   // ACP buyers are not told apart: at least one
  const by = known ? ` by ${d.acp > 0 ? "at least " : ""}${plural(known, "outside agent")}` : " by outside agents";
  const nets = Object.keys(d.nets || {}).length ? Object.keys(d.nets).join(", ") : "Base";
  const parts = [d.x402 ? `${d.x402} over x402 on ${nets}` : "", d.acp ? plural(d.acp, "Virtuals ACP job") : "", d.api ? `${d.api} through the Gate API` : ""].filter(Boolean);
  return {
    text: `<b>Troya Gate, last hour</b>\n${plural(total, "check")}${by} through Troya Gate (${parts.join(", ")}).\n${link(`${SITE}/api-and-mcp`, "troya.codes/api-and-mcp")}`,
    line: `Last hour: ${plural(total, "check")}${by} through Troya Gate (${parts.join(", ")})` };
}
export function arenaHourMsg(d) {
  const rows = (d.trades || []).slice(0, 8).map((t) => {
    // tickers repeat across launchpads (three NOX coins, 22 Nov): name the exact coin with its short address, linked to its page
    const ca = /^0x[0-9a-fA-F]{40}$/.test(t.token || "") ? t.token : null;
    const who = esc(t.agent), sym = esc(tag(cleanSym(t.symbol) || "a coin")) + (ca ? ` (${link(`${SITE}/agent#/token/${ca}`, `${ca.slice(0, 6)}…${ca.slice(-4)}`)})` : "");
    if (t.kind === "open") return `${who} opened ${sym} with ${fmtEth(t.eth)} ETH`;
    const pnl = Number(t.pnlEth) || 0;
    return `${who} closed ${sym}: ${pnl >= 0 ? "+" : "−"}${fmtEth(Math.abs(pnl))} ETH${t.reason ? ` (${esc(cleanName(t.reason, 40))})` : ""}`;
  });
  const more = (d.trades || []).length - rows.length;
  return {
    text: `<b>Arena, last hour (real money)</b>\n${rows.join("\n")}${more > 0 ? `\n…and ${more} more` : ""}\n${link(`${SITE}/arena`, "troya.codes/arena")}`,
    line: `Arena, real money, last hour: ${rows.slice(0, 3).join("; ")}${(d.trades || []).length > 3 ? `; ${(d.trades || []).length - 3} more` : ""}` };
}
export function cupMsg(d) {
  const tx = (h, label) => (isTx(h) ? link(`${EXPLORER}/tx/${h}`, label) : esc(label));
  const prizes = (d.cup || []).map((x) => `#${x.rank} ${x.who?.html || "a wallet"}: ${tx(x.hash, `${fmtEth(x.eth)} ETH`)}`);
  const refs = d.refs?.n ? `Referral rewards: ${fmtEth(d.refs.eth)} ETH to ${plural(d.refs.n, "referrer")}.` : "";
  return {
    text: `<b>Arena Cup ${esc(d.season)}: paid</b>\n${prizes.length ? `${prizes.join("\n")}\n` : ""}${refs ? `${refs}\n` : ""}Every payment is on chain and sealed. ${link(`${SITE}/arena`, "troya.codes/arena")}`,
    line: `Arena Cup ${esc(d.season)} paid${prizes.length ? `: ${prizes.join(", ")}` : ""}${refs ? ` · ${refs}` : ""}` };
}
/** the recap rows that are not zero, in a fixed order */
export function recapRows(c, { cash = true } = {}) {
  return [
    c.launches ? plural(c.launches, "coin launched", "coins launched") : "",
    c.trades ? plural(c.trades, "trade through Troya", "trades through Troya") : "",
    c.stakers ? `${c.stakers} new ${cash ? "$TROYA" : "TROYA"} ${c.stakers === 1 ? "staker" : "stakers"}` : "",
    c.stakerEth > 0 ? `${fmtEth(c.stakerEth)} ETH paid to stakers` : "",
    c.agentChecks ? plural(c.agentChecks, "check by outside agents", "checks by outside agents") : "",
  ].filter(Boolean);
}
export function recapMsg(c) {
  const rows = recapRows(c);
  if (!rows.length) return null;
  return { text: `<b>Today on Troya</b> (24 hours to ${String(c.hour).padStart(2, "0")}:00 UTC)\n${rows.join("\n")}\n${link(`${SITE}/stats`, "troya.codes/stats")}`, line: `Today on Troya: ${rows.join(", ")}` };
}
/** one Telegram message for everything that is ready: the event's own text when it is alone, else one row each */
export function compose(items, { max = 10 } = {}) {
  if (!items.length) return null;
  if (items.length === 1) return items[0].msg.text;
  const rows = items.slice(0, max).map((i) => `• ${i.msg.line}`);
  let out = `<b>On Troya just now</b>\n${rows.join("\n")}`;
  if (items.length > max) out += `\n…and ${items.length - max} more: ${link(`${SITE}/stats`, "troya.codes/stats")}`;
  while (out.length > 3900 && rows.length > 1) { rows.pop(); out = `<b>On Troya just now</b>\n${rows.join("\n")}\n…and ${items.length - rows.length} more: ${link(`${SITE}/stats`, "troya.codes/stats")}`; }
  return out;
}

/* ---------------- X texts: plain, one cashtag at most ---------------- */
/** every $TICKER loses its $, except one $TROYA when allowTroya; the result never carries more than one cashtag */
export function xSafe(text, { allowTroya = false } = {}) {
  let kept = 0;
  return String(text || "").replace(/\$([A-Za-z][A-Za-z0-9]{0,15})\b/g, (m, s) => (allowTroya && !kept && s.toUpperCase() === "TROYA" ? (kept++, m) : s));
}
export const cashtags = (t) => (String(t || "").match(/\$[A-Za-z][A-Za-z0-9]{0,15}\b/g) || []).length;
/** X's count: a link is 23, anything outside Latin and general punctuation 2 */
export function xLength(t) {
  let n = 0;
  for (const part of String(t || "").split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) { n += 23; continue; }
    for (const ch of part) n += /[\u0000-ჿ -⁯]/.test(ch) ? 1 : 2;
  }
  return n;
}
const fit = (t, max = 280) => { let s = t; while (xLength(s) > max && s.includes("\n")) s = s.split("\n").filter((_, i, a) => i !== a.length - 2).join("\n"); return xLength(s) <= max ? s : null; };
export function xDigest(c, top = [], hours = 4) {
  const rows = [
    c.launches ? plural(c.launches, "coin launched", "coins launched") : "",
    c.graduated ? plural(c.graduated, "graduation") : "",
    c.stakers ? `${c.stakers} new $TROYA ${c.stakers === 1 ? "staker" : "stakers"}` : "",
    c.agentChecks ? plural(c.agentChecks, "check by outside agents", "checks by outside agents") : "",
    c.agents ? plural(c.agents, "new agent registered", "new agents registered") : "",
    c.stakerEth > 0 ? `${fmtEth(c.stakerEth)} ETH paid to stakers` : "",
    c.arenaCloses ? `Arena AI traders closed ${plural(c.arenaCloses, "real-money trade")} (${c.arenaWins} won, net ${c.arenaPnl >= 0 ? "+" : "−"}${fmtEth(Math.abs(c.arenaPnl))} ETH)` : "",
  ].filter(Boolean);
  if (!rows.length) return null;
  // a digest with nothing but a check or two reads as an empty account (22 Nov: "Last 4h on Troya: 1 check by outside agents"):
  // post only with a launch, graduation, staker, agent or payout, or at least ACTIVITY_X_MIN_CHECKS outside checks
  const substance = c.launches || c.graduated || c.stakers || c.agents || c.stakerEth > 0 || c.arenaCloses || (c.agentChecks || 0) >= Number(process.env.ACTIVITY_X_MIN_CHECKS || 5);
  if (!substance) return null;
  const tops = top.slice(0, 2).map((t) => `${coinTitle(t.name, t.symbol, { cash: false })}${t.gate?.word === "passed" ? ", Troya Gate passed" : ""}`);
  const text = `Last ${hours}h on Troya: ${rows.join(", ")}.${tops.length ? `\nNew: ${tops.join("; ")}.` : ""}\nhttps://troya.codes`;
  return fit(xSafe(text, { allowTroya: true }));
}
export function xRecap(c) {
  const rows = recapRows(c);
  if (!rows.length) return null;
  return fit(xSafe(`Today on Troya (24h to ${String(c.hour).padStart(2, "0")}:00 UTC):\n${rows.join("\n")}\nhttps://troya.codes/stats`, { allowTroya: true }));
}

/* ---------------- market-cap tier crossings, with hysteresis ---------------- */
/**
 * cur: the tier key announced last (null before the first look). hours: { "2026-11-22T13": { median } }. Only full hours
 * (before nowKey) count. The tier moves up when the last `confirm` consecutive hourly medians are all at least the next
 * line × (1 + margin), down when they are all under the current line × (1 − margin). Returns { tier, from, to, median, hour }.
 */
export function mcStep(cur, hours, tiers, { nowKey, margin = 0.05, confirm = 2 } = {}) {
  const keys = Object.keys(hours || {}).filter((k) => k < nowKey && hours[k]?.median > 0).sort();
  const last = keys.slice(-confirm);
  const fresh = last.length && hourStart(nowKey) - hourStart(last.at(-1)) <= 2 * HOUR;
  const consecutive = last.every((k, i) => !i || hourStart(k) - hourStart(last[i - 1]) === HOUR);
  const idxOf = (mc) => { let i = 0; tiers.forEach((t, j) => { if (mc >= t.minMc) i = j; }); return i; };
  if (!fresh || last.length < confirm || !consecutive) return { tier: cur, changed: false };
  const meds = last.map((k) => hours[k].median), median = meds.at(-1), hour = last.at(-1);
  if (!cur || tiers.findIndex((t) => t.key === cur) < 0) return { tier: tiers[idxOf(median)].key, changed: false, primed: true, median, hour };
  const i = tiers.findIndex((t) => t.key === cur);
  let j = i;
  while (j + 1 < tiers.length && meds.every((m) => m >= tiers[j + 1].minMc * (1 + margin))) j++;
  if (j === i) while (j > 0 && meds.every((m) => m < tiers[j].minMc * (1 - margin))) j--;
  if (j === i) return { tier: cur, changed: false, median, hour };
  return { tier: tiers[j].key, changed: true, from: tiers[i], to: tiers[j], dir: j > i ? "up" : "down", edge: j > i ? tiers[j].minMc : tiers[j + 1].minMc, median, hour, hours: confirm };
}

/* ---------------- dependencies (the tests hand in stubs) ---------------- */
const D = {
  now: () => Date.now(),
  sendTg: async (text) => {
    const T = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!T) return { ok: false, description: "TELEGRAM_BOT_TOKEN is not set" };
    const j = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ chat_id: CFG().chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
    if (j?.description) j.description = String(j.description).split(T).join("…");           // never the token in a log
    return j;
  },
  postX: async (text) => (await import("./xsocial.mjs")).postTweet(text),
  board: async () => (await import("./launch.mjs")).board(),
  teamTest: async (rec) => !!(await import("./launch.mjs")).teamTestWhy(rec),
  xHandle: async (a) => (await import("./xsocial.mjs")).handleOf(a),
  profileName: async (a) => (await import("./profile.mjs")).cardOf(a)?.username || null,
  stakeTerms: async () => (await import("./stake.mjs")).stakeTerms(),
  mcTiers: async () => (await import("./feesplit.mjs")).TIERS,
  later: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
};

/* ---------------- state ---------------- */
let store = null, S = null, busy = false, lastPoll = 0, timer = null;
const inbox = [];
const blank = () => ({ v: 1, salt: null, primed: {}, seen: {}, queue: [], events: [], posts: [], agentHours: {}, cur: null,
  tg: { lastAt: 0, sends: [] }, x: { slot: null }, recapDay: null, mc: { tier: null, hour: null }, gate: null });
const newHour = (k) => ({ hour: k, api: 0, x402: 0, acp: 0, callers: [], nets: {}, arena: [] });
const hash = (k) => createHmac("sha256", S.salt).update(String(k)).digest("hex").slice(0, 16);
const seen = (k) => !!S.seen[k];
const mark = (k, t = D.now()) => { S.seen[k] = t; };
function note(type, summary, extra = {}) {
  S.events.push({ t: D.now(), type, summary: strip(summary).slice(0, 300), ...extra });
}

/* ---------------- the event bus ---------------- */
// the fields each source may hand in (nothing else is kept: no logos, no keys)
const PICK = {
  launch: ["token", "name", "symbol", "owner", "source", "ref", "at", "teamTest"],
  stake: ["account", "amount", "staked", "since", "first", "tx", "logIndex"],
  "registry.agent": ["slug", "name", "owner", "at"],
};
/** Hooks in other modules call this. Never throws, never waits; returns false when the feed is off. */
export function emit(type, data = {}) {
  try {
    if (tgMode() === "off" && xMode() === "off") return false;
    const keys = PICK[type];
    if (!keys) return false;
    const d = {};
    for (const k of keys) { const v = data?.[k]; if (v == null || typeof v === "object") continue; d[k] = typeof v === "bigint" ? v.toString() : v; }
    inbox.push({ type, data: d, at: Date.now() });
    if (inbox.length > 1000) inbox.splice(0, inbox.length - 1000);
    if (store && !timer) timer = D.later(() => { timer = null; tick().catch((e) => console.warn("[activity]", e.message)); }, 1500);
    return true;
  } catch { return false; }
}

async function whoOf(addr, { viaX = false } = {}) {
  if (!isAddr(addr)) return { html: "a wallet", plain: "a wallet" };
  if (viaX) {
    const h = (await D.xHandle(lc(addr)).catch(() => null))?.username;
    if (h && /^[A-Za-z0-9_]{1,15}$/.test(h)) return { html: `<a href="https://x.com/${h}">@${h}</a>`, plain: `@${h}` };
  }
  const u = await D.profileName(lc(addr)).catch(() => null);
  if (u && /^[A-Za-z0-9_]{3,20}$/.test(u)) return { html: esc(u), plain: u };
  return { html: short(addr), plain: short(addr) };
}

// queue an event for the group (only while the group feed is not off); `wait` lets a launch wait for its Gate verdict
function enqueue(key, kind, t, data, { readyAt = D.now(), waitUntil = null } = {}) {
  if (tgMode() === "off") return;
  S.queue.push({ key, kind, t, data, readyAt, waitUntil, tries: 0 });
}

async function ingest(ev) {
  const now = D.now(), d = ev.data || {};
  if (ev.type === "launch") {
    if (!isAddr(d.token)) return;
    const key = `launch:${lc(d.token)}`, t = Number(d.at) || ev.at;
    if (seen(key)) return;
    mark(key);
    const team = d.teamTest || await D.teamTest({ ...d }).catch(() => false);
    const spam = screenName(d.name, d.symbol) === "spam";
    note("launch", `${coinTitle(d.name, d.symbol)} ${VENUE[d.source] || ""}${team ? " (team test, not posted)" : spam ? " (spam name, not posted)" : ""}`, { token: lc(d.token), source: d.source || "web", team: !!team, skipped: team ? "team test" : spam ? "spam name" : undefined });
    if (team || spam || now - t > MAX_AGE) return;
    enqueue(key, "launch", t, d, { readyAt: t + 45_000, waitUntil: t + CFG().gateWaitMs });
  } else if (ev.type === "stake") {
    if (!isAddr(d.account) || !isTx(d.tx)) return;
    const key = `stake:${lc(d.tx)}:${Number(d.logIndex) || 0}`;
    if (seen(key) || !d.first) return;
    mark(key);
    const t = Number(d.since) > 0 ? Number(d.since) * 1000 : ev.at;
    const team = teamSet().has(lc(d.account));
    note("stake", `new staker ${short(d.account)}${team ? " (team wallet, not posted)" : ""}`, { team: team || undefined, skipped: team ? "team wallet" : undefined });
    if (now - t > MAX_AGE || team) return;
    enqueue(key, "stake", t, d);
  } else if (ev.type === "registry.agent") {
    const key = `registry:${String(d.slug || "").slice(0, 40)}`;
    if (!d.slug || seen(key)) return;
    mark(key);
    const spam = !!screenName(d.name, "");
    note("registry.agent", `${cleanName(d.name, 40)}${spam ? " (name not posted)" : ""}`, { skipped: spam ? "name" : undefined });
    if (spam || now - (Number(d.at) || ev.at) > MAX_AGE) return;
    enqueue(key, "registry.agent", Number(d.at) || ev.at, d);
  }
}

/* ---------------- pollers: files the server already writes ---------------- */
const read = (name, fb) => store.readJson(name, fb);
async function launchSet() {
  const out = new Map();
  for (const x of await read("launches.json", [])) if (isAddr(x.token) && !x.teamTest) out.set(lc(x.token), x);
  return out;
}
// prime: the first look at a source marks what is there as seen
function primeOr(src, keys) {
  if (S.primed[src]) return false;
  for (const k of keys) mark(k);
  S.primed[src] = D.now();
  return true;
}

async function pollF20() {
  const l = (await read("agents.json", [])).filter((a) => a?.slug && !a.retired);
  if (primeOr("f20", l.map((a) => `f20:${a.slug}`))) return;
  for (const a of l) {
    const key = `f20:${a.slug}`;
    if (seen(key)) continue;
    mark(key);
    const spam = !!screenName(a.name, "") || !!screenName(a.slug, "");
    note("f20.agent", `${cleanName(a.name)} (@${a.slug})${spam ? " (name not posted)" : ""}`, { skipped: spam ? "name" : undefined });
    if (spam || D.now() - (Number(a.createdAt) || 0) > MAX_AGE) continue;
    enqueue(key, "f20.agent", a.createdAt, { slug: a.slug, name: a.name, template: a.template, owner: a.owner });
  }
}
async function pollGrads() {
  const g = (await read("graduations.json", { items: [] })).items || [];
  const born = await launchSet();
  const mine = g.filter((x) => born.has(lc(x.token)));
  if (primeOr("grads", mine.map((x) => `grad:${lc(x.token)}`))) return;
  for (const x of mine) {
    const key = `grad:${lc(x.token)}`;
    if (seen(key)) continue;
    mark(key);
    const rec = born.get(lc(x.token));
    const name = rec?.name || x.name, symbol = rec?.symbol || x.symbol;
    const flag = screenName(name, symbol);
    note("grad", `${coinTitle(name, symbol)} graduated${flag ? ` (${flag}, not posted)` : ""}`, { token: lc(x.token), skipped: flag || undefined });
    if (flag || D.now() - (Number(x.at) || 0) > MAX_AGE) continue;
    enqueue(key, "grad", x.at, { token: x.token, name, symbol });
  }
}
async function pollPayouts() {
  const days = (await read("fee-split.json", { days: {} })).days || {};
  const sent = Object.values(days).filter((d) => d?.mode === "live" && d.stakers?.status === "sent" && isTx(d.stakers.hash) && d.stakers.sentEth > 0);
  if (primeOr("payouts", sent.map((d) => `payout:${d.day}`))) return;
  for (const d of sent) {
    const key = `payout:${d.day}`;
    if (seen(key)) continue;
    mark(key);
    note("payout", `${fmtEth(d.stakers.sentEth)} ETH to stakers for ${d.day}`, { eth: d.stakers.sentEth, day: d.day });
    if (D.now() - (Number(d.at) || 0) > 12 * HOUR) continue;      // the run's own time: sent at 01:00 UTC, a slow receipt is fine
    enqueue(key, "payout", d.at, { day: d.day, eth: d.stakers.sentEth, hash: d.stakers.hash });
  }
}
async function pollMc() {
  const tiers = await D.mcTiers().catch(() => null);
  if (!Array.isArray(tiers) || !tiers.length) return;
  const hours = (await read("mc-hourly.json", { hours: {} })).hours || {};
  const nowKey = hourKey(D.now()), c = CFG();
  const done = Object.keys(hours).filter((k) => k < nowKey && hours[k]?.median > 0).sort().at(-1);
  if (!done || done === S.mc.hour) return;
  const st = mcStep(S.mc.tier, hours, tiers, { nowKey, margin: c.mcMargin, confirm: c.mcConfirmH });
  S.mc.hour = done;
  if (st.tier) S.mc.tier = st.tier;
  if (!st.changed) return;
  const key = `mc:${st.hour}:${st.to.key}`;
  if (seen(key)) return;
  mark(key);
  note("mc.tier", `${st.dir} to ${st.to.name} at ${fmtUsd(st.median)}`, { tier: st.to.key });
  enqueue(key, "mc.tier", D.now(), { dir: st.dir, edge: st.edge, median: st.median, hours: st.hours, fromBps: st.from.stakerBps, toBps: st.to.stakerBps });
}
async function pollArena() {
  const a = await read("arena.json", {});
  const live = (a.positions || []).filter((p) => p?.mode === "live" && p.id);
  const keys = live.flatMap((p) => [`arena:open:${p.id}`, ...(p.status === "closed" ? [`arena:close:${p.id}`] : [])]);
  if (primeOr("arena", keys)) return;
  const name = (id) => cleanName(a.agents?.[id]?.name || AI_NAMES[id] || "An AI trader", 24);
  for (const p of live) {
    for (const kind of ["open", "close"]) {
      if (kind === "close" && p.status !== "closed") continue;
      const key = `arena:${kind}:${p.id}`;
      if (seen(key)) continue;
      mark(key);
      const t = kind === "open" ? p.openedAt : p.closedAt;
      const row = { kind, agent: name(p.agent), symbol: p.symbol, token: p.token || null, eth: p.amountEth, pnlEth: p.pnlEth, reason: p.reason || null };
      note("arena", `${row.agent} ${kind === "open" ? "opened" : "closed"} ${cleanSym(p.symbol)}`, { kind, pnlEth: kind === "close" ? p.pnlEth : undefined });
      if (D.now() - (Number(t) || 0) > MAX_AGE) continue;
      S.cur.arena.push(row);
    }
  }
}
async function pollCup() {
  const weeks = Object.values((await read("payouts.json", { weeks: {} })).weeks || {}).filter((w) => w?.season && (w.status === "paid" || w.status === "partial") && (w.items || []).some((x) => x.ok && isTx(x.hash)));
  if (primeOr("cup", weeks.map((w) => `cup:${w.season}`))) return;
  for (const w of weeks) {
    const key = `cup:${w.season}`;
    if (seen(key)) continue;
    mark(key);
    const ok = (w.items || []).filter((x) => x.ok && isTx(x.hash));
    note("cup", `Arena Cup ${w.season} paid: ${ok.length} payments`, { season: w.season });
    if (D.now() - (Number(w.at) || 0) > 24 * HOUR) continue;
    enqueue(key, "cup", w.at, { season: w.season, items: ok.map((x) => ({ kind: x.kind, rank: x.rank || null, to: x.to, eth: x.eth, hash: x.hash })) });
  }
}
// Gate API and x402: per-caller counts read as differences between two looks, the callers kept only as salted hashes
async function pollGate() {
  const g = await read("gateapi.json", {}), x = await read("x402.json", {});
  const team = teamSet();
  const teamKey = (k) => team.has(lc(k)) || team.has(lc(String(k).replace(/^ip:/, "")));
  const price = Math.max(1, Math.round((Number(g.settings?.priceUsdg) || 0.01) * 1e6));
  const usage = g.usage || { day: null, by: {} };
  const snap = { day: usage.day || null, by: {}, credits: {}, acp: Number(g.stats?.acp) || 0, x402At: Math.max(0, ...(x.last || []).map((e) => Number(e.at) || 0)) };
  for (const [k, n] of Object.entries(usage.by || {})) snap.by[hash(k)] = Number(n) || 0;
  for (const [k, n] of Object.entries(g.credits || {})) snap.credits[hash(lc(k))] = Number(n) || 0;
  const prev = S.gate;
  S.gate = snap;
  if (!prev) return;                                                // the first look: counting starts now
  const cur = S.cur, callers = new Set(cur.callers);
  for (const [k, n] of Object.entries(usage.by || {})) {
    if (teamKey(k)) continue;
    const h = hash(k), before = usage.day === prev.day ? prev.by[h] || 0 : 0, inc = (Number(n) || 0) - before;
    if (inc > 0) { cur.api += inc; callers.add(hash(lc(k))); }
  }
  for (const [k, n] of Object.entries(g.credits || {})) {
    if (team.has(lc(k))) continue;
    const h = hash(lc(k)), before = prev.credits[h];
    if (before != null && Number(n) < before) { const used = Math.round((before - Number(n)) / price); if (used > 0) { cur.api += used; callers.add(h); } }
  }
  if (snap.acp > prev.acp) cur.acp += snap.acp - prev.acp;
  for (const e of x.last || []) {
    if (!(Number(e.at) > (prev.x402At || 0)) || !e.tx || team.has(lc(e.payer))) continue;
    cur.x402++; if (isAddr(e.payer)) callers.add(hash(lc(e.payer)));
    const n = NETS[e.network] || "Base"; cur.nets[n] = (cur.nets[n] || 0) + 1;
  }
  cur.callers = [...callers];
}
// a new hour: the last one's checks and Arena trades go out as one summary each
function rollHour() {
  const k = hourKey(D.now());
  if (!S.cur) { S.cur = newHour(k); return; }
  if (S.cur.hour === k) return;
  const c = S.cur, total = c.api + c.x402 + c.acp;
  S.cur = newHour(k);
  if (total > 0) {
    const d = { hour: c.hour, api: c.api, x402: c.x402, acp: c.acp, agents: c.callers.length, nets: c.nets };
    S.agentHours[c.hour] = { total, api: c.api, x402: c.x402, acp: c.acp, agents: c.callers.length };
    note("gate.hour", `${total} outside-agent checks in ${c.hour}:00 UTC`, { total });
    if (D.now() - hourStart(c.hour) < 3 * HOUR) enqueue(`gate:${c.hour}`, "agents.hour", hourStart(c.hour) + HOUR, d);
  }
  if (c.arena.length && D.now() - hourStart(c.hour) < 3 * HOUR) enqueue(`arena:${c.hour}`, "arena.hour", hourStart(c.hour) + HOUR, { trades: c.arena });
}

/* ---------------- turning a queued event into its message ---------------- */
async function boardRow(token) {
  const b = await D.board().catch(() => null);
  if (!b) return null;
  return [...(b.new || []), ...(b.almost || []), ...(b.migrated || [])].find((x) => lc(x.token) === lc(token)) || null;
}
// { text, line } when it can be posted, { skip } when it must not be, or null to look again on the next tick
async function finalize(it) {
  const d = it.data || {}, now = D.now();
  switch (it.kind) {
    case "launch": {
      const row = await boardRow(d.token);
      if (row?.teamTest) return { skip: "team test" };
      const gate = gateWord(row?.gate);
      if (!gate && it.waitUntil && now < it.waitUntil) return null;
      const flag = screenName(row?.name || d.name, row?.symbol || d.symbol);
      if (flag === "spam") return { skip: "spam name" };
      return launchMsg({ ...d, name: d.name || row?.name, symbol: d.symbol || row?.symbol, gate, flag, who: await whoOf(d.owner, { viaX: d.source === "x" }) });
    }
    case "stake": {
      const terms = await D.stakeTerms().catch(() => null);
      const dec = Number(terms?.decimals ?? 18), amount = Number(BigInt(d.staked || d.amount || 0)) / 10 ** dec;
      const tiers = (terms?.tiers || []).filter((t) => t.minTokens != null).sort((a, b) => a.minTokens - b.minTokens);
      const tier = [...tiers].reverse().find((t) => amount >= t.minTokens) || null;
      return stakeMsg({ amount, pctOfSupply: terms?.supply > 0 ? (amount / terms.supply) * 100 : 0, tier: tier ? { name: tier.name, minDays: tier.minDays } : null, minName: tiers[0]?.name || null, who: await whoOf(d.account) });
    }
    case "registry.agent": return registryMsg({ ...d, who: await whoOf(d.owner) });
    case "f20.agent": return f20Msg({ ...d, who: await whoOf(d.owner) });
    case "grad": return gradMsg({ ...d, gate: gateWord((await boardRow(d.token))?.gate) });
    case "payout": return payoutMsg(d);
    case "mc.tier": return mcMsg(d);
    case "agents.hour": return agentsHourMsg(d);
    case "arena.hour": return arenaHourMsg(d);
    case "cup": {
      const cup = [], refs = { n: 0, eth: 0 };
      for (const x of (d.items || []).sort((a, b) => (a.rank || 9) - (b.rank || 9))) {
        if (x.kind === "cup") cup.push({ rank: x.rank, eth: x.eth, hash: x.hash, who: await whoOf(x.to) });
        else { refs.n++; refs.eth += Number(x.eth) || 0; }
      }
      return cupMsg({ season: d.season, cup, refs });
    }
    case "recap": return d.msg || null;
    default: return { skip: "unknown kind" };
  }
}

/* ---------------- sending ---------------- */
function log(post) { S.posts.push(post); }
async function sendTick() {
  const mode = tgMode(), c = CFG(), now = D.now();
  if (mode === "off") { S.queue = []; return; }
  for (const it of S.queue) {
    if (it.msg || it.skip || it.readyAt > now) continue;
    const m = await finalize(it).catch((e) => { console.warn("[activity] finalize:", e.message); return null; });
    if (!m) continue;
    if (m.skip) { it.skip = m.skip; note("skipped", `${it.kind} ${it.key}: ${m.skip}`); continue; }
    it.msg = m; it.readyTs = now;
  }
  S.queue = S.queue.filter((i) => !i.skip);
  const ready = S.queue.filter((i) => i.msg).sort((a, b) => a.readyTs - b.readyTs);
  S.tg.sends = (S.tg.sends || []).filter((t) => now - t < HOUR);
  if (!ready.length || now - (S.tg.lastAt || 0) < c.gapMs || S.tg.sends.length >= c.perHour) return;
  if (now - ready[0].readyTs < c.gatherMs) return;
  const text = compose(ready);
  // written down before anything is sent: a crash during the send can lose a message, never post it twice
  S.queue = S.queue.filter((i) => !ready.includes(i));
  S.tg.lastAt = now; S.tg.sends.push(now);
  const post = { at: now, ch: "tg", mode, text, keys: ready.map((i) => i.key), status: mode === "live" ? "sending" : "dry" };
  log(post);
  if (mode !== "live") return;
  await save();
  const j = await D.sendTg(text).catch((e) => ({ ok: false, description: e.message }));
  if (j?.ok) { post.status = "sent"; post.id = j.result?.message_id || null; return; }
  post.status = "failed"; post.error = String(j?.description || "not sent").slice(0, 200);
  if (j?.parameters?.retry_after) S.tg.lastAt = now + j.parameters.retry_after * 1000;
  // put them back for the next window, at most 3 tries each
  for (const i of ready) if (++i.tries < 3) S.queue.push(i);
  console.warn("[activity] Telegram:", post.error);
}

async function xPost(kind, key, text, allowTroya) {
  if (!text || seen(key)) return;
  mark(key);
  const safe = xSafe(text, { allowTroya });
  if (cashtags(safe) > 1 || xLength(safe) > 280) { note("skipped", `X ${kind}: over the rules`); return; }
  const mode = xMode();
  const post = { at: D.now(), ch: "x", kind, mode, text: safe, keys: [key], status: mode === "live" ? "sending" : "dry" };
  log(post);
  if (mode !== "live") return;
  await save();
  try { post.id = await D.postX(safe) || null; post.status = "sent"; }
  catch (e) { post.status = "failed"; post.error = String(e?.message || e).slice(0, 200); console.warn("[activity] X:", post.error); }
}

/* ---------------- counts for the X digest and the daily recap ---------------- */
async function countsFor(from, to, { trades = false } = {}) {
  const inWin = (t) => t >= from && t < to;
  const ev = S.events.filter((e) => inWin(e.t));
  const launches = [...(await launchSet()).values()].filter((x) => inWin(Number(x.at) || 0));
  const real = [];
  for (const x of launches) if (!(await D.teamTest(x).catch(() => false))) real.push(x);
  const days = Object.values((await read("fee-split.json", { days: {} })).days || {});
  const stakerEth = days.filter((d) => d?.mode === "live" && d.stakers?.status === "sent" && inWin(Number(d.at) || 0)).reduce((s, d) => s + (Number(d.stakers.sentEth) || 0), 0);
  let agentChecks = Object.entries(S.agentHours).filter(([k]) => inWin(hourStart(k))).reduce((s, [, v]) => s + (v.total || 0), 0);
  if (S.cur && inWin(hourStart(S.cur.hour))) agentChecks += S.cur.api + S.cur.x402 + S.cur.acp;
  const c = { launches: real.length, real, stakers: ev.filter((e) => e.type === "stake" && !e.team).length, graduated: ev.filter((e) => e.type === "grad").length,
    agents: ev.filter((e) => e.type === "registry.agent" || e.type === "f20.agent").length, stakerEth: +stakerEth.toFixed(6), agentChecks };
  // the Arena's real-money results (community asked 22 Nov to see them on X, not only in the group)
  const closes = ev.filter((e) => e.type === "arena" && e.kind === "close" && Number.isFinite(Number(e.pnlEth)));
  c.arenaCloses = closes.length; c.arenaWins = closes.filter((e) => Number(e.pnlEth) > 0).length;
  c.arenaPnl = +closes.reduce((x, e) => x + Number(e.pnlEth), 0).toFixed(6);
  if (trades) {
    const team = teamSet();
    c.trades = (await store.tail("journal.jsonl", 1e6, (e) => inWin(Number(e.t) || 0) && TRADE.test(e.kind || "") && e.status === "executed" && e.source !== "arena" && !team.has(lc(e.address)))).length;
  }
  return c;
}
async function topLaunches(list) {
  const b = await D.board().catch(() => null);
  const rows = new Map([...(b?.new || []), ...(b?.almost || []), ...(b?.migrated || [])].map((x) => [lc(x.token), x]));
  return list.map((x) => ({ ...x, row: rows.get(lc(x.token)) })).filter((x) => quietName(x.name, x.symbol) && !x.row?.teamTest && gateWord(x.row?.gate)?.word !== "blocked")
    .sort((a, b) => (b.row?.mcapUsd || 0) - (a.row?.mcapUsd || 0) || (b.at || 0) - (a.at || 0)).slice(0, 2).map((x) => ({ name: x.name, symbol: x.symbol, gate: gateWord(x.row?.gate) }));
}
export async function digestText(from, to) {
  const c = await countsFor(from, to);
  return xDigest(c, await topLaunches(c.real), Math.round((to - from) / HOUR));
}
async function recapCounts(target) { return { ...(await countsFor(target - DAY, target, { trades: true })), hour: CFG().recapHour }; }
const recapAt = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), CFG().recapHour); };

async function scheduleTick() {
  const now = D.now(), c = CFG();
  const slot = Math.floor(now / c.xEveryMs);
  if (S.x.slot == null) S.x.slot = slot;                               // the first run: the next full window
  else if (slot > S.x.slot) {
    S.x.slot = slot;
    if (xMode() !== "off") { const to = slot * c.xEveryMs; await xPost("digest", `xdigest:${to}`, await digestText(to - c.xEveryMs, to), true); }
  }
  const target = recapAt(now), day = dayKey(now);
  if (!S.primed.recap) { S.primed.recap = now; if (now >= target) S.recapDay = day; return; }   // the first day may be partial: skipped
  if (now < target || S.recapDay === day) return;
  S.recapDay = day;
  if (now - target > 3 * HOUR) return;                                 // too late to call it "today"
  const counts = await recapCounts(target);
  const m = recapMsg(counts);
  note("recap", m ? m.line : "nothing to recap", { day });
  if (!m) return;
  if (tgMode() !== "off") S.queue.push({ key: `recap:${day}`, kind: "recap", t: target, data: { msg: m }, readyAt: now, tries: 0 });
  if (xMode() !== "off") await xPost("recap", `xrecap:${day}`, xRecap(counts), true);
}

/* ---------------- the loop ---------------- */
function prune() {
  const now = D.now();
  for (const [k, t] of Object.entries(S.seen)) if (now - t > 30 * DAY) delete S.seen[k];
  S.events = S.events.filter((e) => now - e.t < 8 * DAY).slice(-3000);
  S.posts = S.posts.slice(-200);
  for (const k of Object.keys(S.agentHours)) if (now - hourStart(k) > 8 * DAY) delete S.agentHours[k];
  S.queue = S.queue.filter((i) => now - (i.readyAt || 0) < 6 * HOUR).slice(-200);   // never post something hours stale
}
async function save() { await store.writeJson(FILE, S); }
export async function tick() {
  if (busy || !store || !S) return;
  if (tgMode() === "off" && xMode() === "off") { inbox.length = 0; return; }
  busy = true;
  try {
    rollHour();
    while (inbox.length) await ingest(inbox.shift()).catch((e) => console.warn("[activity] ingest:", e.message));
    if (D.now() - lastPoll >= MIN - 1000) {
      lastPoll = D.now();
      for (const [n, f] of [["agents", pollF20], ["graduations", pollGrads], ["payouts", pollPayouts], ["market cap", pollMc], ["arena", pollArena], ["cup", pollCup], ["gate", pollGate]])
        await f().catch((e) => console.warn(`[activity] ${n}:`, e.message));
    }
    await sendTick();
    await scheduleTick();
    prune();
    await save();
  } finally { busy = false; }
}

/* ---------------- routes ---------------- */
async function load() {
  const v = await store.readJson(FILE, blank());
  S = { ...blank(), ...(v && typeof v === "object" ? v : {}) };
  for (const k of ["queue", "events", "posts"]) if (!Array.isArray(S[k])) S[k] = [];
  for (const k of ["seen", "agentHours", "primed"]) if (!S[k] || typeof S[k] !== "object") S[k] = {};
  S.tg = { lastAt: 0, sends: [], ...(S.tg || {}) }; S.x = { slot: null, ...(S.x || {}) }; S.mc = { tier: null, hour: null, ...(S.mc || {}) };
  if (!S.salt) S.salt = randomBytes(16).toString("hex");
}
const pubPost = (p) => ({ at: p.at, channel: p.ch, kind: p.kind || null, mode: p.mode, status: p.status, text: p.text, error: p.error || null });
export async function register(r, ctx) {
  store = ctx.store;
  await load();
  r.get("/api/activity", () => ({
    name: "Troya activity feed", telegram: { mode: tgMode(), chat: CFG().chat, gapSeconds: CFG().gapMs / 1000, perHour: CFG().perHour }, x: { mode: xMode(), everyHours: CFG().xEveryMs / HOUR }, recapUtcHour: CFG().recapHour,
    events: S.events.slice(-60).reverse().map(({ t, type, summary, skipped }) => ({ t, type, summary, skipped: skipped || null })),
    posts: S.posts.slice(-30).reverse().map(pubPost),
    queue: S.queue.map((i) => ({ kind: i.kind, at: i.t, ready: !!i.msg })),
    thisHour: S.cur ? { hour: S.cur.hour, outsideAgentChecks: S.cur.api + S.cur.x402 + S.cur.acp, arenaTrades: S.cur.arena.length } : null,
  }), { weight: 1 });
  r.get("/api/activity/preview", async ({ req }) => {
    const { getSession } = await import("./auth.mjs");
    const s = getSession(req);
    if (!s?.address || !admins().includes(lc(s.address))) return { error: "Admins only." };
    return preview();
  }, { weight: 2 });
  if (tgMode() === "off" && xMode() === "off") { inbox.length = 0; return; }
  console.log(`[activity] feed: Telegram ${tgMode()} (${CFG().chat}), X ${xMode()}`);
  setTimeout(() => tick().catch((e) => console.warn("[activity]", e.message)), 40_000).unref?.();
  setInterval(() => tick().catch((e) => console.warn("[activity]", e.message)), 15_000).unref?.();
}
/** what would go out next: the Telegram message as it stands, the X digest of the window so far, the recap so far */
export async function preview() {
  const now = D.now(), c = CFG();
  const items = [];
  for (const it of S.queue) { const m = it.msg || (it.readyAt <= now ? await finalize({ ...it, waitUntil: null }).catch(() => null) : null); if (m && !m.skip) items.push({ ...it, msg: m }); }
  const from = Math.floor(now / c.xEveryMs) * c.xEveryMs, target = recapAt(now) > now ? recapAt(now) : recapAt(now) + DAY;
  const counts = await recapCounts(Math.min(now, target)).catch(() => null);
  return {
    telegram: { mode: tgMode(), next: compose(items), queued: S.queue.length, earliestAt: Math.max(S.tg.lastAt + c.gapMs, now) },
    x: { mode: xMode(), digestSoFar: await digestText(from, now).catch(() => null), nextDigestAt: from + c.xEveryMs },
    recap: { at: target, telegramSoFar: counts ? recapMsg(counts)?.text || null : null, xSoFar: counts ? xRecap(counts) : null },
  };
}

export const _test = {
  setDeps: (o) => Object.assign(D, o),
  setStore: async (s) => { store = s; await load(); lastPoll = 0; },
  state: () => S, inbox: () => inbox, tick, ingest, finalize, preview, reload: load,
  resetPoll: () => { lastPoll = 0; },
};
