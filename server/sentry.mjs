// Troya Sentry: every new Pons launch goes through Troya Gate. The channel gets only the ones worth a look: passed with no
// warning AND real buying (at least SENTRY_MIN_POST_ETH, default 0.5 ETH, on the curve, from SENTRY_MIN_BUYERS, default 25,
// independent wallets), re-checked at 5, 15 and 60 minutes so a coin that picks up later still makes it. A wallet that
// bought SENTRY_BOT_COINS (default 8) other new coins in the last 24 hours is a bot or a farm and is not counted. A ticker
// already posted that day (look-alike letters folded) and a name mixing Cyrillic or Greek into Latin letters are held. Failed, caution and dust-only results are kept in /api/sentry/recent and the
// daily recap, never dropped from the record.
// The group gets one recap a day. Results also feed GET /api/sentry/recent (public, read-only).
//   SENTRY=1    watch + post        SENTRY=dry   watch, write posts to data/sentry-preview.jsonl, send nothing
//   SENTRY_CHANNEL (default @troyasentry) · SENTRY_RECAP_CHAT (default @troyaagent) · SENTRY_RECAP_UTC_HOUR (default 13)
//   SENTRY_IMAGES=0 turns off the coin's logo on posts (on by default; posts fall back to text when a logo can't be fetched)
//   SENTRY_POOLS=1 also checks coins that launch outside Pons: every new hookless Uniswap v3/v4 pool against ETH, WETH or USDG,
//   and (from GeckoTerminal's new-pools list, every 4 minutes) new pools on the other Robinhood Chain launchpads and venues:
//   Long.xyz, Bankr, Frontier.fun, Abyss, Goo, Clank.trade, o1, Virtuals, Ramses, Aerodrome … (routed through KyberSwap).
//   They are checked at about 5, 20 and 80 minutes and posted under the same rules, with 0.5 ETH of pool depth in place of
//   the curve, so empty, dust or farm-traded pools never reach the channel. SENTRY_POOLS=dry writes those posts to data/sentry-pools-preview.jsonl instead.
// Launch log: PonsFactory event, topics = [sig, token, curve, deployer]. Token names come from the internet: they are
// stripped of links and handles and HTML-escaped before they reach Telegram. Wording stays factual: check results,
// never "scam" or "safe".
import { ADDR, CHAINS, rpc, gateCheck, ponsState, ponsPublic, ponsProfile, tokenMeta } from "./robinhood.mjs";
import { readFileSync } from "node:fs";
import { AbiCoder, getAddress } from "ethers";
import { addV4Key } from "./robinhood.mjs";
import { newLaunchPools, LAUNCHPADS, indexRow, dsTokenPairs, getEthUsd } from "./market.mjs";

const LAUNCH_TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const MODE = process.env.SENTRY || "";
const CHANNEL = process.env.SENTRY_CHANNEL || "@troyasentry";
const RECAP_CHAT = process.env.SENTRY_RECAP_CHAT || "@troyaagent";
const RECAP_HOUR = Number(process.env.SENTRY_RECAP_UTC_HOUR ?? 13);
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const SITE = "https://troya.codes";
const PONS = "https://ponsfamily.com/launchpad/";
const TEST_ETH = "0.01";
const MIN_POST = Number(process.env.SENTRY_MIN_POST_ETH ?? 0.5); // the channel's bar: real money on the curve, not a dev test buy
const MIN_BUYERS = Number(process.env.SENTRY_MIN_BUYERS ?? 25);   // …from at least this many independent wallets
const BOT_COINS = Number(process.env.SENTRY_BOT_COINS ?? 8);      // a wallet that bought this many other new coins in 24 h is a bot or a farm: not counted
const TRACTION_S = [5 * 60, 10 * 60, 45 * 60];   // passed but quiet → look again at about 5, 15 and 60 minutes
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WALLETS = "sentry-wallets.json";
const MIN_RAISED = 0.002;                // below this a curve is dust: a "passed" there would mean nothing, so it waits like an empty one
const FIRST_CHECK_S = 90;                 // past the launch snipe tax
const RETRY_S = [5 * 60, 15 * 60];        // no buys yet → look again, then drop quietly
const MAX_RANGE = 2000, CATCHUP = 3000, MAX_GAP = 20000;
const STATE = "sentry.json";
const POOLS = process.env.SENTRY_POOLS || "";
const T_V4_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";   // PoolManager Initialize
const T_V3_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"; // UniswapV3Factory PoolCreated
const NULL_ADDR = "0x0000000000000000000000000000000000000000";
const QUOTES = new Set([NULL_ADDR, ADDR.weth.toLowerCase(), ADDR.usdg.toLowerCase()]);
const POOL_FIRST_S = 300, POOL_RETRY_S = [15 * 60, 60 * 60];
const coder = AbiCoder.defaultAbiCoder();
// the full stock list (the stocks desk's 203, merged by market.mjs), loaded once without a circular import at start
let marketIsStock = null;
import("./market.mjs").then((m) => { marketIsStock = m.isStock || null; }).catch(() => {});
const STOCKS = (() => { try { return new Set(JSON.parse(readFileSync(new URL("./data/robinhood-stocks.json", import.meta.url), "utf8")).stocks.map((x) => x.address.toLowerCase())); } catch { return new Set(); } })();
// Tokenized stocks are not launches: Sentry never posts one and The Record never grades one. Audit, 20 Nov 2026: $ANT, the
// Anthropic stock token, got a new Uniswap v4 pool and was posted as a call, because Robinhood listed it after the market's
// last 6-hourly merge of its stocks desk. So the desk itself is read again (at most every 5 minutes; stocks.mjs caches it for
// 10) before a pool is checked. Any one of the three lists is enough. A desk that cannot be read leaves the other two.
const DESK_STOCKS = new Set();
let deskAt = 0, deskRead = null;
// one read at a time: a pool check that lands while The Record's loop is reading the desk waits for that read
export function refreshStocks() {
  if (deskRead) return deskRead;
  if (Date.now() - deskAt < 5 * 60e3) return Promise.resolve();
  deskAt = Date.now();
  return (deskRead = import("./stocks.mjs").then((m) => m.stockDesk()).catch(() => null).then((d) => {
    for (const x of d?.assets || []) { const a = String(x.address || "").toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a)) DESK_STOCKS.add(a); }
  }).finally(() => { deskRead = null; }));
}
export const isStock = (a) => { const t = String(a || "").toLowerCase(); return STOCKS.has(t) || DESK_STOCKS.has(t) || !!marketIsStock?.(t); };
const STOCK_NOTE = "Tokenized stock: not a launch, not graded on The Record";

let store, busy = false, lastPost = 0, lastWalletSave = 0;
const recent = [];                        // newest first, for /api/sentry/recent
// for the bot's /sentry and the brief: a stock posted before the rule above is history, not a launch to show again
export const recentResults = (n = 5) => recent.filter((r) => !isStock(r.token)).slice(0, n);

/* ---------- text ---------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// names and symbols are attacker-controlled: drop links, handles, control chars, keep it short
export function cleanName(s, n = 32) {
  let t = String(s ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");
  t = t.replace(/(https?:\/\/|www\.)\S*/gi, "").replace(/\b[\w-]+\.(com|io|xyz|me|org|net|fun|app|gg|co|codes|family|sh|ai)\b\S*/gi, "").replace(/t\.me\/\S*/gi, "").replace(/@\w+/g, "");
  t = t.replace(/\s+/g, " ").trim().slice(0, n);
  return t;
}
export const cleanSymbol = (s) => cleanName(s, 16).replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 16);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (v) => (v == null ? "–" : v < 0.001 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2));

// verdict for a fresh launch: thin depth is expected on a new curve, so it is reported, never the verdict
export function verdict(g) {
  const real = g.checks.filter((c) => c.key !== "depth");
  const fail = real.find((c) => c.status === "fail");
  if (fail) return { v: "failed", why: fail };
  const sell = real.find((c) => c.key === "sell");
  if (sell && sell.status === "skip" && /holds no buyers|too little/i.test(sell.detail)) return { v: "nobuys" };
  const warn = real.find((c) => c.status === "warn");
  if (warn) return { v: "caution", why: warn };
  return { v: "passed" };
}

// real money behind the coin: graduated, at least MIN_POST ETH raised on an ETH curve, or (a pool) 0.5 ETH of depth
function moneyIn(r, minEth) {
  if (r.pons) {
    if (r.pons.graduated) return true;
    const ethPair = r.pons.pair?.address === "native" || /^W?ETH$/i.test(r.pons.pair?.symbol || "");
    return ethPair && Number(r.pons.raised) >= minEth;
  }
  return (r.checks || []).find((c) => c.key === "depth")?.status === "pass";
}

// copies and impersonations: Cyrillic or Greek letters mixed into a Latin name ("Nеil" with a Cyrillic е), and one ticker
// per day (the first coin posted under a ticker keeps it for 24 hours)
const MIXED = /[Ͱ-ϿЀ-ԯ]/;
export const lookAlike = (r) => [r?.symbol, r?.name].some((x) => x && /[A-Za-z]/.test(x) && MIXED.test(x));
const FOLD_FROM = [..."аеорсухіјѕԁһԛԝкмнтвαβεζηικμνορτυχ"], FOLD_TO = [..."aeopcyxijsdhqwkmhtbabezhikmnoptyx"];
export function tickerKey(sym) {
  const t = String(sym || "").normalize("NFKC").toLowerCase().replace(/./gu, (c) => { const i = FOLD_FROM.indexOf(c); return i < 0 ? c : FOLD_TO[i]; });
  return t.replace(/[^\p{L}\p{N}]/gu, "");
}

// the channel's filter. null = post it; otherwise the reason it is held back (kept in /api/sentry/recent)
export function holdReason(r, { minEth = MIN_POST, minBuyers = MIN_BUYERS, copy = null } = {}) {
  if (r?.v !== "passed") return r?.why ? `${r.why.label}: ${r.why.detail}` : "Did not pass";
  if (lookAlike(r)) return "Name mixes look-alike letters (Cyrillic or Greek with Latin): not posted";
  if (copy) return `Same ticker as ${copy.symbol ? "$" + copy.symbol : "a coin"} (${short(copy.token)}), posted in the last 24 hours: not posted`;
  if (!moneyIn(r, minEth)) return r.pons ? `Passed, but under ${minEth} ETH raised within an hour: not posted` : `Passed, but under ${minEth} ETH of pool depth: not posted`;
  if (!r.buyers) return "Passed, but its buyers could not be counted: not posted";
  if (r.buyers.organic < minBuyers) return `Passed, but only ${r.buyers.organic} independent buyers of ${r.buyers.all} within an hour (${minBuyers} needed; wallets that bought ${BOT_COINS}+ other new coins in 24 hours are not counted): not posted`;
  return null;
}
export const worthPosting = (r, minEth = MIN_POST, minBuyers = MIN_BUYERS) => !holdReason(r, { minEth, minBuyers });
// The channel's bar alone (at least MIN_POST ETH in and MIN_BUYERS independent buyers), shown on the Desk as a green pill.
// Audit, 21 Nov 2026: the Desk showed a green "Passed" on $WOLFPACK with 0 buyers and $0.52 of volume, because "passed"
// only means no check failed. A pass without real buying is a neutral "Checks passed · no real buying yet" there.
export const meetsBar = (r, minEth = MIN_POST, minBuyers = MIN_BUYERS) => r?.v === "passed" && moneyIn(r, minEth) && (r.buyers?.organic ?? 0) >= minBuyers;
// the same, for a stored /api/sentry/recent item (its pons block is gone): graduated reads as 100% progress, and a pool
// result was only recorded once it had MIN_POST ETH of depth
// A copy (a ticker posted earlier that day) or a look-alike name is held for good: never green, however much buying it has
// (a fake $USDG pool counted 25,870 buyers, 21 Nov 2026).
const COPY_HOLD = /^Same ticker|look-alike/i;
export function itemMeetsBar(x, minEth = MIN_POST, minBuyers = MIN_BUYERS) {
  if (!x || x.verdict !== "passed" || x.stock) return false;
  if (typeof x.eligible === "boolean") return x.eligible;
  if (x.posted) return true;
  if (COPY_HOLD.test(x.reason || "")) return false;
  const money = x.source ? true : (x.progressPct != null && x.progressPct >= 100) || (x.raised != null && x.raised >= minEth);
  return money && (x.buyers ?? 0) >= minBuyers;
}

/* ---------- liquidity next to volume ---------- */
// A pool minted at a made-up price reports millions of "liquidity" on a few dollars of trading ($WOLFPACK: $123.8M on $0.52
// of volume, 21 Nov 2026). Very deep next to almost no volume, with little of it in ETH or USDG, is a caution, never a pass.
const PAPER_MIN_USD = 250_000, PAPER_RATIO = 1000, PAPER_REAL_SHARE = 0.1;
const usd0 = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Number(v || 0).toFixed(2)}`);
export function paperLiquidity({ liquidityUsd, volume24hUsd, realLiquidityUsd } = {}) {
  const L = Number(liquidityUsd), V = Math.max(0, Number(volume24hUsd) || 0);
  if (!(L >= PAPER_MIN_USD) || L < Math.max(V, 1) * PAPER_RATIO) return null;
  // a pool that really holds money on its ETH or USDG side is a deep new pool, not a made-up price
  if (realLiquidityUsd != null && Number(realLiquidityUsd) >= L * PAPER_REAL_SHARE) return null;
  return { label: "Liquidity vs volume", detail: `${usd0(L)} of pool liquidity on ${usd0(V)} traded in 24 hours${realLiquidityUsd != null ? ` (${usd0(Number(realLiquidityUsd))} of it in ETH or USDG)` : ""}: the pool's price may be set, not traded` };
}
// a coin not on the Market's board yet: its DexScreener pairs, summed, with the ETH or USDG side as the money in them
export function pairsLiquidity(pairs, token, ethUsd) {
  const a = String(token).toLowerCase();
  const money = { [ADDR.weth.toLowerCase()]: "eth", [NULL_ADDR]: "eth", [ADDR.usdg.toLowerCase()]: "usd" };
  let L = 0, V = 0, real = 0, n = 0;
  for (const p of pairs || []) {
    const b = String(p.baseToken?.address || "").toLowerCase(), q = String(p.quoteToken?.address || "").toLowerCase();
    if (b !== a && q !== a) continue;
    const l = Number(p.liquidity?.usd);
    if (l > 0) { L += l; n++; }
    V += Number(p.volume?.h24) || 0;
    const other = b === a ? q : b, amt = Number(b === a ? p.liquidity?.quote : p.liquidity?.base) || 0;
    if (money[other] === "usd") real += amt;
    else if (money[other] === "eth" && ethUsd) real += amt * ethUsd;
  }
  return n ? { liquidityUsd: L, volume24hUsd: V, realLiquidityUsd: ethUsd ? real : null } : null;
}
// the coin's pools as the Market sees them (its board row), else DexScreener (read-only, cached a minute by market.mjs)
async function paperCheck(token) {
  try {
    const row = indexRow(token);
    if (row?.liquidityUsd != null) return paperLiquidity(row);
    const [pairs, ethUsd] = await Promise.all([dsTokenPairs(token), getEthUsd().catch(() => null)]);
    const l = pairsLiquidity(pairs, token, ethUsd);
    return l ? paperLiquidity(l) : null;
  } catch { return null; }
}
const permanent = (r, copy) => lookAlike(r) || !!copy;   // held for good: no point looking again

/* ---------- buyers ---------- */
// who bought: wallets that received the coin from its curve or pool. Whoever it was minted to (the creator, the curve)
// and the deployer are left out. The busiest sender is taken as the venue, plus any venue we already know.
export function buyerSet(logs, { venues = [], exclude = [] } = {}) {
  const a = (t) => ("0x" + String(t).slice(26)).toLowerCase();
  const minted = new Set(), fan = new Map();
  for (const l of logs || []) {
    const f = a(l.topics[1]), to = a(l.topics[2]);
    if (f === NULL_ADDR) { minted.add(to); continue; }
    if (!fan.has(f)) fan.set(f, new Set());
    fan.get(f).add(to);
  }
  const top = [...fan.entries()].sort((x, y) => y[1].size - x[1].size)[0]?.[0];
  const src = new Set([top, ...venues].filter(Boolean).map((x) => x.toLowerCase()));
  const skip = new Set([...minted, ...src, ...exclude.filter(Boolean).map((x) => x.toLowerCase()), NULL_ADDR]);
  const out = new Set();
  for (const f of src) for (const to of fan.get(f) || []) if (!skip.has(to)) out.add(to);
  return [...out];
}
// a day of buyer wallets per coin (40-bit ids), so a wallet buying every new coin is recognised as a bot or a farm
const hist = new Map(), wcount = new Map();
let walletsDirty = false;
const wid = (a) => a.slice(2, 12);
function remember(token, ids, t = Date.now()) {
  const old = hist.get(token);
  if (old) for (const w of old.w) { const n = (wcount.get(w) || 1) - 1; n > 0 ? wcount.set(w, n) : wcount.delete(w); }
  const w = new Set(ids.slice(0, 800));
  hist.set(token, { t: old?.t || t, w });
  for (const x of w) wcount.set(x, (wcount.get(x) || 0) + 1);
  walletsDirty = true;
}
function pruneWallets() {
  const cut = Date.now() - 86400e3;
  for (const [k, v] of hist) if (v.t < cut) { remember(k, []); hist.delete(k); }
}
export const rememberBuyers = (token, wallets) => remember(token.toLowerCase(), wallets.map(wid));   // tests
export function organicOf(token, wallets) {
  const mine = hist.get(token.toLowerCase())?.w;
  return wallets.filter((a) => { const id = wid(a); return (wcount.get(id) || 0) - (mine?.has(id) ? 1 : 0) < BOT_COINS; }).length;
}
const hex = (n) => "0x" + n.toString(16);
// every transfer of a coin since its launch block. The official RPC takes the whole range in one call; the fallbacks cap a
// range at 10,000 blocks, so there it is read in pieces
export async function transfersOf(token, fromBlock, sinceMs = null) {
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const from = Math.max(fromBlock || head - (sinceMs ? Math.ceil((Date.now() - sinceMs) / 1000 + 3600) * 12 : 400000), 0);
  const q = { address: token, topics: [T_TRANSFER], fromBlock: hex(from), toBlock: hex(head) };
  try { return await rpc("robinhood", "eth_getLogs", [q], { timeoutMs: 20000, only: CHAINS.robinhood.wide }); } catch { /* next */ }
  try { return await rpc("robinhood", "eth_getLogs", [q], { timeoutMs: 20000 }); }
  catch (e) {
    if (head - from > 60 * 9000) throw e;
    const out = [];
    for (let b = from; b <= head; b += 9000) out.push(...((await rpc("robinhood", "eth_getLogs", [{ address: token, topics: [T_TRANSFER], fromBlock: hex(b), toBlock: hex(Math.min(head, b + 8999)) }], { timeoutMs: 20000 })) || []));
    return out;
  }
}
async function measureBuyers(r, q) {
  try {
    const venues = [r.pons?.curve, ADDR.poolManager, q?.pool && /^0x[0-9a-fA-F]{40}$/.test(q.pool) ? q.pool : null];
    const all = buyerSet(await transfersOf(r.token, q?.block), { venues, exclude: [r.pons?.deployer, r.pons?.creatorFeeRecipient] });
    remember(r.token.toLowerCase(), all.map(wid));
    r.buyers = { all: all.length, organic: organicOf(r.token, all) };
  } catch (e) { r.buyers = null; console.warn("[sentry] buyers", r.token, e.message); }
}
// first start with no wallet history: learn the last day's buyers from the coins already in the record
async function warmUp(s) {
  if (hist.size >= 20) return;
  const since = Date.now() - 86400e3;
  for (const it of (s.recent || []).filter((x) => x.at > since).slice(0, 150)) {
    if (hist.has(it.token.toLowerCase())) continue;
    try { remember(it.token.toLowerCase(), buyerSet(await transfersOf(it.token, null, it.at)).map(wid), it.at); } catch { /* skip */ }
    await new Promise((x) => setTimeout(x, 2500));                    // gentle on the RPC: about 6 minutes for a full day
  }
  if (walletsDirty) { walletsDirty = false; await saveWallets(); }
  console.log(`[sentry] wallet history: ${hist.size} coins, ${wcount.size} wallets`);
}
const saveWallets = () => store.writeJson(WALLETS, { coins: Object.fromEntries([...hist].map(([k, v]) => [k, { t: v.t, w: [...v.w] }])) });
const mins = (ms) => (ms < 90e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`);

export function formatPost(r) {
  const head = r.v === "passed" ? "Passed" : r.v === "caution" ? "Caution" : "Failed";
  const sym = r.symbol ? `$${esc(r.symbol)}` : "unnamed";
  const name = r.name && r.name.toUpperCase() !== (r.symbol || "").toUpperCase() ? ` · ${esc(r.name)}` : "";
  const ck = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  const lines = [`<b>${head}</b> · <b>${sym}</b>${name}`];
  if (r.source) lines.push(`New ${esc(r.source)} pool`);
  if (r.ageMs > 0) lines.push(`Checked ${mins(r.ageMs)} after launch`);
  if (r.buyers) lines.push(`${r.buyers.organic} independent buyers (wallets that buy every new coin not counted)`);
  if (r.alsoTicker) lines.push(`Another coin used this ticker earlier today (${short(r.alsoTicker.token)}): check the address`);
  if (r.v === "failed" || r.v === "caution") lines.push(`${esc(r.why.label)}: ${esc(String(r.why.detail).slice(0, r.why.label === "Ring Radar" ? 220 : 140))}`);
  const bits = [];
  if (ck.sim) bits.push(`Sim ${ck.sim.status === "pass" ? "ok" : ck.sim.status === "fail" ? "failed" : "skipped"}`);
  if (ck.sell) bits.push(`Test sell ${ck.sell.status === "pass" ? (/partial/i.test(ck.sell.detail) ? "ok (partial)" : "ok") : ck.sell.status === "fail" ? "failed" : "skipped"}`);
  if (ck.tax) bits.push(`Tax ${ck.tax.status === "pass" ? "none" : ck.tax.status === "skip" ? "not measured" : esc(ck.tax.detail)}`);
  if (ck.fee) bits.push(`Fees ${esc(ck.fee.detail)}`);
  if (bits.length) lines.push(bits.join(" · "));
  if (r.pons) lines.push(`Curve ${eth(r.pons.raised)} ${esc(r.pons.pair?.symbol || "ETH")} raised · ${r.pons.progressPct != null ? r.pons.progressPct.toFixed(r.pons.progressPct < 1 ? 2 : 1) : "–"}% to graduation · tax ${Number((1 + (r.pons.fees.creatorTaxBps || 0) / 100).toFixed(2))}% (1% Pons fee${r.pons.fees.creatorTaxBps ? ` + ${Number((r.pons.fees.creatorTaxBps / 100).toFixed(2))}% creator tax` : ", no creator tax"})`);
  if (r.ring && (r.ring.verdict === "red" || r.ring.verdict === "amber") && r.why?.label !== "Ring Radar") lines.push(`Ring Radar ${r.ring.verdict === "red" ? "red" : "amber"}: ${esc(r.ring.reasons.slice(0, 2).join("; ").slice(0, 220))}`);
  if (r.oath?.status === "kept") lines.push(`Oath kept: the dev pledged to sell at most ${r.oath.pledge.maxSellPctPerDay}% of the supply a day${r.oath.pledge.feeLockDays ? ` and leave creator fees for ${r.oath.pledge.feeLockDays} days` : ""}`);
  if (r.assay?.length) for (const l of r.assay) lines.push(esc(l));
  lines.push(`<code>${r.token}</code>`);
  return lines.join("\n");
}
const quickAssay = async (token) => { try { const m = await import("./assay.mjs"); return m.assayLines(await m.assay(token, { deep: false, waitMs: 12000 })); } catch { return []; } };
const TRADE = process.env.TG_TRADE === "1";
const buttons = (a) => ({ inline_keyboard: [
  ...(TRADE ? [[{ text: "Trade in Telegram", url: `https://t.me/${process.env.TG_BOT_USERNAME || "TrojanTroya_bot"}?start=t_${a}` }]] : []),
  [{ text: "Check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${a}` }, { text: "Buy on Fomo", url: `https://fomo.family/tokens/robinhood/${a}` }],
  [{ text: "Pons", url: PONS + a.toLowerCase() }, { text: "DexScreener", url: `https://dexscreener.com/robinhood/${a}` }],
  [{ text: "Every call graded: The Record", url: `${SITE}/record` }],
] });

const poolButtons = (a) => ({ inline_keyboard: [
  ...(TRADE ? [[{ text: "Trade in Telegram", url: `https://t.me/${process.env.TG_BOT_USERNAME || "TrojanTroya_bot"}?start=t_${a}` }]] : []),
  [{ text: "Check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${a}` }, { text: "Buy on Fomo", url: `https://fomo.family/tokens/robinhood/${a}` }],
  [{ text: "Chart", url: `${SITE}/agent#/token/${a}` }, { text: "DexScreener", url: `https://dexscreener.com/robinhood/${a}` }],
  [{ text: "Every call graded: The Record", url: `${SITE}/record` }],
] });

export function formatRecap(d, dayLabel) {
  const checked = d.passed + d.caution + d.failed;
  return `<b>Troya Sentry · ${esc(dayLabel)}</b>

${d.seen} Pons launches${d.pools ? ` and ${d.pools} new pools on Uniswap and the other launchpads` : ""} seen. ${checked} had buyers and went through Troya Gate:
${d.passed} passed · ${d.caution} caution · ${d.failed} failed
${d.posted} passed with real buying (at least ${MIN_POST} ETH from ${MIN_BUYERS}+ independent wallets, no copies) and were posted to the channel.
${d.nobuys} had an empty or dust-only curve (no real buys, or every buyer sold), so there was nothing to test.

The posted ones: t.me/${CHANNEL.replace(/^@/, "")} · every result as JSON: troya.codes/api/sentry/recent
Check any coin yourself: /gate 0x…

Automated checks, not endorsements.`;
}

/* ---------- the coin's logo ---------- */
// Pons keeps each coin's logo URL on chain, almost always an IPFS CID. The image is fetched only from fixed public
// gateways by CID (never from an arbitrary host, so no request can be pointed at our own network), checked for type and
// size, and uploaded with the post; Telegram's file_id is then reused for the same logo. Anything else: text post.
const IMAGES = process.env.SENTRY_IMAGES !== "0";
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/"];
const IMG_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMG = 5 * 1024 * 1024;
const fileIds = new Map();               // cid → Telegram file_id
export function logoCid(logo) {
  const m = /^(?:ipfs:\/\/(?:ipfs\/)?|https:\/\/[^/?#]+\/ipfs\/)([A-Za-z0-9]{46,100})(\/[A-Za-z0-9._-]{1,80})?$/.exec(String(logo || "").trim());
  return m ? m[1] + (m[2] || "") : null;
}
async function fetchLogo(cid) {
  for (const g of GATEWAYS) {
    try {
      const r = await fetch(g + cid, { redirect: "error", signal: AbortSignal.timeout(8000) });
      const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!r.ok || !IMG_TYPES[type] || Number(r.headers.get("content-length") || 0) > MAX_IMG) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || buf.length > MAX_IMG) continue;
      return { buf, type };
    } catch { /* next gateway */ }
  }
  return null;
}
export async function logoFor(token) {
  if (!IMAGES) return null;
  const p = await ponsProfile(token).catch(() => null);
  const cid = logoCid(p?.logo);
  if (!cid) return null;
  if (fileIds.has(cid)) return { cid, fileId: fileIds.get(cid) };
  const img = await fetchLogo(cid);
  return img ? { cid, ...img } : null;
}

/* ---------- telegram ---------- */
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  return r.json();
}
// a photo post: the cached file_id, or the image uploaded as multipart; null when Telegram won't take it
async function sendPhoto(chat, logo, caption, markup) {
  let j;
  if (logo.fileId) j = await tg("sendPhoto", { chat_id: chat, photo: logo.fileId, caption, parse_mode: "HTML", reply_markup: markup });
  else {
    const f = new FormData();
    f.set("chat_id", String(chat)); f.set("caption", caption); f.set("parse_mode", "HTML"); f.set("reply_markup", JSON.stringify(markup));
    f.set("photo", new Blob([logo.buf], { type: logo.type }), `logo.${IMG_TYPES[logo.type]}`);
    j = await fetch(`https://api.telegram.org/bot${TG}/sendPhoto`, { method: "POST", body: f, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  }
  if (j.ok) { const ph = j.result.photo; if (ph?.length) fileIds.set(logo.cid, ph[ph.length - 1].file_id); console.log(`[sentry] posted with logo ${logo.cid.slice(0, 16)}… to ${chat}`); if (fileIds.size > 500) fileIds.delete(fileIds.keys().next().value); return j; }
  if (j.parameters?.retry_after) return j;
  console.warn("[sentry] photo post failed, sending text:", j.description);
  if (logo.fileId) fileIds.delete(logo.cid);
  return null;
}
async function send(chat, text, markup, logo = null) {
  if (MODE === "dry") { await store.append("sentry-preview.jsonl", { t: Date.now(), chat, text, markup, logo: logo?.cid || null }); return { ok: true, dry: true }; }
  const wait = lastPost + 4000 - Date.now();
  if (wait > 0) await new Promise((x) => setTimeout(x, wait));
  lastPost = Date.now();
  const once = async () => (logo && text.length <= 1024 && (await sendPhoto(chat, logo, text, markup))) || tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
  const j = await once();
  if (!j.ok && j.parameters?.retry_after) { await new Promise((x) => setTimeout(x, (j.parameters.retry_after + 1) * 1000)); return once(); }
  return j;
}

/* ---------- state ---------- */
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const blank = () => ({ seen: 0, pools: 0, passed: 0, caution: 0, failed: 0, nobuys: 0, posted: 0 });
// one [time, kind] per event, kept 3 days, so the recap counts exactly the last 24 hours
function bump(s, k) { s.events.push([Date.now(), k]); const cut = Date.now() - 3 * 86400e3; while (s.events.length && s.events[0][0] < cut) s.events.shift(); }
export function countSince(events, since) { const d = blank(); for (const [t, k] of events) if (t >= since && k in d) d[k]++; return d; }

/* ---------- one launch ---------- */
// ERC-20 name() and symbol(), or blanks when the contract answers neither (tokenMeta's "?" is not a ticker)
async function nameOf(token) {
  const m = await tokenMeta(token).catch(() => null);
  return { symbol: m && m.symbol !== "?" ? m.symbol : "", name: m?.name || "" };
}
// results stored before names were read for failed checks: filled in once, gently, after a start
async function fillNames() {
  for (const x of recent.filter((it) => !it.symbol && !it.name).slice(0, 120)) {
    const t = await nameOf(x.token);
    if (t.symbol || t.name) { x.symbol = cleanSymbol(t.symbol); x.name = cleanName(t.name); }
    await new Promise((r) => setTimeout(r, 250));
  }
}
export async function checkLaunch(token) {
  const g = await gateCheck({ tokenIn: "ETH", tokenOut: token, amountIn: TEST_ETH, slippageBps: 100 });
  const ps = await ponsState(token).catch(() => null);
  const pons = ponsPublic(ps);
  let vd = verdict(g);
  if (vd.v !== "failed" && pons && !pons.graduated && pons.pair?.address === "native" && (pons.raised ?? 0) < MIN_RAISED) vd = { v: "nobuys" };
  let t = g.quote?.tokenOut || {};
  // a failed route has no quote, so no name: read the coin's own name() and symbol() (failed rows read "0xe623…c82c · Pons")
  if (!t.symbol) t = await nameOf(token);
  return { token, symbol: cleanSymbol(t.symbol), name: cleanName(t.name), checks: g.checks, pons, snipe: !!(ps && ps.snipeBps > 0n), ...vd, at: Date.now() };
}

// logs for one scan window: the official RPC first, once more after a short pause, and only then the fallbacks (whose
// free plans refuse wide ranges, which used to turn a single official hiccup into a noisy failed round)
async function scanLogs(q) {
  for (let i = 0; i < 2; i++) {
    try { return await rpc("robinhood", "eth_getLogs", [q], { timeoutMs: 20000, only: CHAINS.robinhood.wide }); }
    catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  return rpc("robinhood", "eth_getLogs", [q], { timeoutMs: 20000 });
}
async function scan(s) {
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  let from = s.lastBlock ? s.lastBlock + 1 : head - CATCHUP;
  if (head - from > MAX_GAP) from = head - CATCHUP;                     // after downtime: don't flood the channel with stale launches
  while (from <= head) {
    const to = Math.min(head, from + MAX_RANGE - 1);
    const logs = await scanLogs({ address: ADDR.ponsFactory, topics: [LAUNCH_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) });
    for (const l of logs || []) {
      const token = "0x" + l.topics[1].slice(26);
      if (s.seen[token]) continue;
      s.seen[token] = Date.now();
      s.queue.push({ token, due: Date.now() + FIRST_CHECK_S * 1000, tries: 0, seenAt: Date.now(), block: Number(l.blockNumber), tx: l.transactionHash });
      bump(s, "seen");
    }
    if (POOLS) await scanPools(s, from, to);
    s.lastBlock = to;
    from = to + 1;
  }
  const keep = Object.entries(s.seen).sort((a, b) => b[1] - a[1]).slice(0, 3000);
  s.seen = Object.fromEntries(keep);
}

// coins launched outside Pons: a new hookless Uniswap pool with ETH, WETH or USDG on one side. Pons launches (already
// queued above) and tokenized stocks are skipped; a v4 pool's key is registered so the Gate can route through it at once.
function notePool(s, token, item) {
  const t = token.toLowerCase();
  if (s.seen[t] || QUOTES.has(t) || isStock(t)) return;
  s.seen[t] = Date.now();
  s.queue.push({ token: t, due: Date.now() + POOL_FIRST_S * 1000, tries: 0, kind: "pool", ...item });
  bump(s, "pools");
}
async function scanPools(s, from, to) {
  const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
  const [v4, v3] = await Promise.all([
    scanLogs({ address: ADDR.poolManager, topics: [T_V4_INIT], ...range }),
    scanLogs({ address: ADDR.v3Factory, topics: [T_V3_CREATED], ...range }),
  ]);
  for (const l of v4 || []) {
    const c0 = "0x" + l.topics[2].slice(26), c1 = "0x" + l.topics[3].slice(26);
    const [fee, ts, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], l.data);
    if (hooks !== NULL_ADDR && hooks.toLowerCase() !== NULL_ADDR) continue;            // hooked pools (Pons graduations and others) are left out
    const q0 = QUOTES.has(c0), q1 = QUOTES.has(c1);
    if (q0 === q1) continue;
    addV4Key(l.topics[1], { c0: getAddress(c0), c1: getAddress(c1), fee: Number(fee), ts: Number(ts), hooks: getAddress(hooks), liq: 1 });
    notePool(s, q0 ? c1 : c0, { source: "Uniswap v4", pool: l.topics[1], block: Number(l.blockNumber) });
  }
  for (const l of v3 || []) {
    const t0 = "0x" + l.topics[1].slice(26), t1 = "0x" + l.topics[2].slice(26);
    const q0 = QUOTES.has(t0), q1 = QUOTES.has(t1);
    if (q0 === q1) continue;
    const [, pool] = coder.decode(["int24", "address"], l.data);
    notePool(s, q0 ? t1 : t0, { source: "Uniswap v3", pool, block: Number(l.blockNumber) });
  }
}

// launches on the other Robinhood Chain venues, from GeckoTerminal's new-pools list (Pons and plain Uniswap are covered above)
const LAUNCH_EVERY_MS = 4 * 60_000, LAUNCH_MAX_AGE_MS = 2 * 3600e3;
async function scanLaunchpads(s) {
  if (Date.now() - (s.launchpadsAt || 0) < LAUNCH_EVERY_MS) return;
  s.launchpadsAt = Date.now();
  for (const p of await newLaunchPools()) {
    if (!p.base || p.pad === "pons" || /^uniswap-v[34]/.test(p.dex)) continue;
    if (p.createdAt && p.createdAt < Date.now() - LAUNCH_MAX_AGE_MS) continue;
    notePool(s, p.base, { source: LAUNCHPADS[p.pad] && p.pad !== "other" ? LAUNCHPADS[p.pad] : "Other launchpad", pool: p.pool, block: null });   // never a raw GeckoTerminal dex id
  }
}

const recentlyPosted = (s, token) => (s.posted?.[token.toLowerCase()] || 0) > Date.now() - 86400e3;
function markPosted(s, r) {
  const now = Date.now(), token = r.token, symbol = r.symbol;
  s.posted ||= {}; s.posted[token.toLowerCase()] = now;
  for (const [k, t] of Object.entries(s.posted)) if (t < now - 86400e3) delete s.posted[k];
  s.tickers ||= {};
  const k = tickerKey(symbol);
  if (k) s.tickers[k] = { token: token.toLowerCase(), symbol, t: now, organic: r.buyers?.organic ?? null };
  for (const [x, v] of Object.entries(s.tickers)) if (v.t < now - 86400e3) delete s.tickers[x];
}
// another coin already posted under the same ticker (look-alike letters folded) in the last 24 hours. A later coin with
// more than twice its independent buyers is still posted (the first one was the copy), with a line naming the other.
export function copyOf(s, r) {
  const k = tickerKey(r.symbol), e = k ? s.tickers?.[k] : null;
  if (!e || e.token === r.token.toLowerCase() || e.t <= Date.now() - 86400e3) return null;
  if (r.buyers && e.organic != null && r.buyers.organic > 2 * e.organic) { r.alsoTicker = e; return null; }
  return e;
}
const postUrl = (j) => (j?.result?.message_id ? `https://t.me/${CHANNEL.replace(/^@/, "")}/${j.result.message_id}` : null);
function record(s, r, posted, reason, j) {
  recent.unshift({ token: r.token, symbol: r.symbol, name: r.name, verdict: r.v, posted, ...(r.source ? { source: r.source } : {}), reason, raised: r.pons?.raised ?? null, progressPct: r.pons?.progressPct ?? null, buyers: r.buyers ? r.buyers.organic : null, eligible: !!posted || (meetsBar(r) && !COPY_HOLD.test(reason || "")), at: r.at, post: postUrl(j) });
  recent.length = Math.min(recent.length, 200);
  s.recent = recent.slice(0, 200);                                   // survives restarts
  return recent[0];
}

async function work(s) {
  const now = Date.now();
  const due = s.queue.filter((q) => q.due <= now).slice(0, 4);
  for (const q of due) {
    // a pool queued before its token showed up on any stock list: looked up again here, and dropped quietly if it is one
    if (q.kind === "pool") {
      await refreshStocks().catch(() => {});
      if (isStock(q.token)) { s.queue = s.queue.filter((x) => x !== q); continue; }
    }
    let r;
    try { r = await checkLaunch(q.token); }
    catch (e) { q.due = now + 60000; q.err = (q.err || 0) + 1; if (q.err >= 3) s.queue = s.queue.filter((x) => x !== q); console.warn("[sentry]", q.token, e.message); continue; }
    // V7 F31 Ring Radar on every Pons launch: exemptions from the launch call, bundle buys, reused bundlers, decoys
    if (q.kind !== "pool" && r.pons) {
      r.ring = await import("./ringradar.mjs").then((m) => m.ringCheck(q.token, q.tx ? { tx: q.tx, block: q.block } : null)).catch(() => null);
      if (r.ring?.verdict === "red" && r.v === "passed") { r.v = "caution"; r.why = { label: "Ring Radar", detail: r.ring.reasons.slice(0, 2).join("; ") }; }
    }
    // V7 F32 Oath tier 2: a broken Oath turns a pass into caution; a kept one is shown in the post
    r.oath = await import("./oath.mjs").then((m) => m.oathOf(q.token)).catch(() => null);
    if (r.oath?.status === "broken" && r.v === "passed") { const b = r.oath.breaches.at(-1); r.v = "caution"; r.why = { label: "Oath broken", detail: b?.kind === "sell" ? `the dev sold ${b.soldPct}% of the supply on ${b.day}, over its ${b.capPct}% a day pledge` : b?.note || "see troya.codes/oath" }; }
    if (q.kind === "pool") {
      if (r.pons) { s.queue = s.queue.filter((x) => x !== q); continue; }                 // a Pons coin: its launch is covered already
      const ck = Object.fromEntries(r.checks.map((c) => [c.key, c]));
      const deep = r.v === "passed" && ck.route?.status === "pass" && ck.depth?.status === "pass" && !recentlyPosted(s, r.token);
      if (!deep) {
        if (q.tries < POOL_RETRY_S.length) { q.due = now + POOL_RETRY_S[q.tries] * 1000; q.tries++; continue; }
        s.queue = s.queue.filter((x) => x !== q); continue;                               // never reached real depth: dropped quietly
      }
      r.source = q.source;
      const paper = await paperCheck(r.token);
      if (paper) { r.v = "caution"; r.why = paper; }
      await measureBuyers(r, q);
      const copy = copyOf(s, r), why = holdReason(r, { copy });
      if (why && !permanent(r, copy) && q.tries < POOL_RETRY_S.length) { q.due = now + POOL_RETRY_S[q.tries] * 1000; q.tries++; continue; }
      s.queue = s.queue.filter((x) => x !== q);
      if (why) { bump(s, r.v); record(s, r, false, why, null); continue; }                 // deep enough, but bots, a copy or too few buyers
      if (POOLS === "dry") { await store.append("sentry-pools-preview.jsonl", { t: Date.now(), token: r.token, pool: q.pool, text: formatPost(r) }); continue; }
      r.assay = await quickAssay(r.token);
      // $TROYA stakers first (their DMs now, the channel post on a timer), or exactly as before when nobody has a lead
      const leadsP = await stakerLeads();
      let jp = { ok: false }, laterP = null;
      if (leadsP.length || waiting) laterP = postWithLead({ r, text: formatPost(r), markup: poolButtons(r.token), logo: null, leads: leadsP, pool: true });
      else {
        jp = await send(CHANNEL, formatPost(r), poolButtons(r.token), null).catch((e) => ({ ok: false, description: e.message }));
        if (!jp.ok) console.warn("[sentry] pool post failed:", jp.description);
        if (MODE !== "dry") holderDms(r, null).catch((e) => console.warn("[sentry] holder DMs:", e.message));
      }
      bump(s, r.v); bump(s, "posted"); markPosted(s, r);
      const rowP = record(s, r, true, null, jp);
      if (laterP) laterP.item = rowP;
      continue;
    }
    if (r.snipe && q.tries < 3) { q.due = now + 60000; q.tries++; continue; }
    if (r.v === "nobuys") {
      if (q.tries < RETRY_S.length) { q.due = now + RETRY_S[q.tries] * 1000; q.tries++; continue; }
      s.queue = s.queue.filter((x) => x !== q); bump(s, "nobuys"); continue;
    }
    r.ageMs = r.at - (q.seenAt || s.seen[q.token] || r.at);
    // before Sentry Autopilot and the Arena see it: a made-up pool price is a caution, so nothing buys it on a "pass"
    if (r.v === "passed") { const paper = await paperCheck(r.token); if (paper) { r.v = "caution"; r.why = paper; } }
    // Phase 7: Sentry Autopilot sees every passing check (it keeps its own rules and never buys the same coin twice)
    if (MODE !== "dry" && r.v === "passed") import("./autopilot.mjs").then((a) => a.onLaunch(r)).catch((e) => console.warn("[sentry] autopilot:", e.message));
    // V7 F34: the Arena's paper traders (AI models and proving strategies) see the same passing checks
    if (MODE !== "dry" && r.v === "passed") import("./arena.mjs").then((a) => a.onLaunch(r)).catch((e) => console.warn("[sentry] arena:", e.message));
    // V9 F57 Phoenix: the setup the Arena and Autopilot saw (Gate notes, curve, Ring Radar), kept for the lesson written when
    // the trade closes. Only recorded, never read by any buy or sell.
    if (r.v === "passed") import("./phoenix.mjs").then((p) => p.noteSetup(r)).catch(() => {});
    await measureBuyers(r, q);                                          // every checked coin feeds the wallet history
    const copy = r.v === "passed" ? copyOf(s, r) : null;
    const why = r.v === "passed" && recentlyPosted(s, r.token) ? "Posted already in the last 24 hours" : holdReason(r, { copy });
    const post = !why;
    if (!post && r.v === "passed" && !permanent(r, copy) && (q.lt || 0) < TRACTION_S.length) { q.due = now + TRACTION_S[q.lt || 0] * 1000; q.lt = (q.lt || 0) + 1; continue; }
    s.queue = s.queue.filter((x) => x !== q);
    let j = { ok: false }, later = null;
    if (post) {
      const logo = await logoFor(r.token).catch(() => null);
      r.assay = await quickAssay(r.token);
      // $TROYA stakers first (their DMs now, the channel post on a timer), or exactly as before when nobody has a lead
      const leads = await stakerLeads();
      if (leads.length || waiting) later = postWithLead({ r, text: formatPost(r), markup: buttons(r.token), logo, leads, pool: false });
      else {
        j = await send(CHANNEL, formatPost(r), buttons(r.token), logo).catch((e) => ({ ok: false, description: e.message }));
        if (!j.ok) console.warn("[sentry] post failed:", j.description);
        if (MODE !== "dry") holderDms(r, logo && fileIds.has(logo.cid) ? { cid: logo.cid, fileId: fileIds.get(logo.cid) } : null).catch((e) => console.warn("[sentry] holder DMs:", e.message));
      }
      bump(s, "posted"); markPosted(s, r);
    }
    bump(s, r.v);
    const row = record(s, r, post, why, j);
    if (later) later.item = row;
  }
}

// Phase 3: linked $TROYA holders get each result as a private message too (the bot can only DM people who started it).
// `skip`: chats that already had this post (the staker lead below); `text`/`kb`: a post resumed after a restart.
async function holderDms(r, logo, skip = null, text = formatPost(r), kb = r.source ? poolButtons(r.token) : buttons(r.token)) {
  const hp = await import("./holders.mjs").catch(() => null);
  if (!hp) return;
  for (const chat of await hp.holderChats()) {
    if (skip?.has(String(chat))) continue;
    const sent = logo ? await sendPhoto(chat, logo, text, kb).catch(() => null) : null;
    if (!sent?.ok) await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
    await new Promise((x) => setTimeout(x, 60));
  }
}

/* ---------- the staker lead (owner, 21 Nov 2026) ----------
   $TROYA stakers with a tier (server/stake.mjs stakerChats: only once the stake perks are on, only linked wallets) get a
   channel post by private message first: Gold 30 s, Silver 15 s, Bronze 5 s before the public channel (never more than
   LEAD_MAX_S). The loop never waits for it: each tier's DMs are put on a timer, the channel post goes on one chain, and the
   chain posts in the order the posts were decided, each no earlier than its own time, so a later post never overtakes an
   earlier one. The 1M holder DMs follow the channel post as before, minus the chats that already had it. A post still
   waiting when the server stops is kept in data/sentry-pending.json and sent when it starts again. With no staker lead (no
   stake contract, perks off, no tiered wallet linked) and nothing waiting, a post goes out exactly as it always did. */
const LEAD_MAX_S = 30, PENDING = "sentry-pending.json";
const TIER_NAME = { gold: "Gold", silver: "Silver", bronze: "Bronze" };
let chain = Promise.resolve(), waiting = 0, lastDue = 0, recentDirty = false;

async function stakerLeads() {
  if (MODE === "dry" || !TG) return [];
  const st = await import("./stake.mjs").catch(() => null);
  const list = st ? await st.stakerChats().catch(() => []) : [];
  return list.map((x) => ({ ...x, leadSec: Math.min(LEAD_MAX_S, Math.max(0, Math.round(Number(x.leadSec) || 0))) })).filter((x) => x.leadSec > 0 && x.chat != null);
}
async function dmOne(chat, text, kb, logo) {
  const lg = logo ? (fileIds.has(logo.cid) ? { cid: logo.cid, fileId: fileIds.get(logo.cid) } : logo) : null;
  const sent = lg && text.length <= 1024 ? await sendPhoto(chat, lg, text, kb).catch(() => null) : null;
  if (!sent?.ok) await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
}
const keepPending = (fn) => store.update(PENDING, { items: [] }, (d) => { d.items = fn(d.items || []).slice(-50); return d; }).catch(() => {});

// one channel post, queued: `p` = { r, text, markup, logo, leads, pool }. Returns at once with a handle whose `item` (the
// /api/sentry/recent row, set by the caller) gets the post link once the channel post is out.
function postWithLead(p) {
  const lead = p.leads.length ? Math.max(...p.leads.map((x) => x.leadSec)) : 0;
  const at = Math.max(Date.now() + lead * 1000, lastDue);
  lastDue = at;
  const handle = { item: null, at };
  const id = `${p.r?.token || "?"}:${at}`;
  const skip = new Set([...(p.skip || []), ...p.leads.map((x) => x.chat)].map(String));   // chats that have it before the channel
  const byLead = new Map();
  for (const x of p.leads) { if (!byLead.has(x.leadSec)) byLead.set(x.leadSec, []); byLead.get(x.leadSec).push(x); }
  for (const [sec, list] of [...byLead].sort((a, b) => b[0] - a[0])) {
    setTimeout(async () => {
      for (const x of list) {
        await dmOne(x.chat, `${p.text}

<i>${TIER_NAME[x.tier] || "Staker"} tier: you get this ${sec} s before the public channel.</i>`, p.markup, p.logo).catch(() => {});
        await new Promise((res) => setTimeout(res, 60));
      }
    }, Math.max(0, at - sec * 1000 - Date.now()));
  }
  waiting++;
  const saved = keepPending((l) => [...l, { id, token: p.r?.token || null, text: p.text, markup: p.markup, pool: !!p.pool, at, logoCid: p.logo?.cid || null, skip: [...skip] }]);
  chain = chain.then(async () => {
    await saved;
    const wait = at - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    const j = await send(CHANNEL, p.text, p.markup, p.logo).catch((e) => ({ ok: false, description: e.message }));
    if (!j.ok) console.warn(`[sentry] ${p.pool ? "pool " : ""}post failed:`, j.description);
    await keepPending((l) => l.filter((x) => x.id !== id));
    const row = handle.item || (p.r?.token ? recent.find((x) => x.token === p.r.token && x.posted && !x.post) : null);
    if (row && j.ok) { row.post = postUrl(j); recentDirty = true; }
    const lg = !p.pool && p.logo && fileIds.has(p.logo.cid) ? { cid: p.logo.cid, fileId: fileIds.get(p.logo.cid) } : null;
    holderDms(p.r || { token: p.token, source: p.pool ? "pool" : null }, lg, skip, p.text, p.markup).catch((e) => console.warn("[sentry] holder DMs:", e.message));
  }).catch((e) => console.warn("[sentry] queued post:", e.message)).finally(() => { waiting--; });
  return handle;
}
// posts that were still waiting when the server stopped (younger than 15 minutes): sent now, in order, no new lead
async function resumePending() {
  const d = await store.readJson(PENDING, { items: [] });
  const items = (d.items || []).filter((x) => x && x.text && x.at > Date.now() - 15 * 60_000).sort((a, b) => a.at - b.at);
  await store.writeJson(PENDING, { items: [] });
  for (const x of items) {
    const logo = !x.pool && x.token ? await logoFor(x.token).catch(() => null) : null;
    console.log(`[sentry] resuming a post that was waiting at the restart: ${x.token}`);
    postWithLead({ r: x.token ? { token: x.token } : null, token: x.token, text: x.text, markup: x.markup, logo, leads: [], pool: !!x.pool, skip: x.skip });
  }
}

async function recap(s) {
  const now = new Date();
  if (now.getUTCHours() !== RECAP_HOUR) return;
  const today = dayKey();
  if (s.recapSent === today) return;
  const d = countSince(s.events, Date.now() - 86400e3);
  s.recapSent = today;
  if (!d.seen) return;
  const j = await send(RECAP_CHAT, formatRecap(d, "last 24 hours"), { inline_keyboard: [[{ text: "Open Troya Sentry", url: `https://t.me/${CHANNEL.replace(/^@/, "")}` }]] }).catch((e) => ({ ok: false, description: e.message }));
  if (!j.ok) console.warn("[sentry] recap failed:", j.description);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await store.readJson(STATE, { lastBlock: 0, seen: {}, queue: [], events: [], recapSent: null });
    s.events ||= [];
    await scan(s).catch((e) => console.warn("[sentry] scan:", e.message));
    if (POOLS) await scanLaunchpads(s).catch((e) => console.warn("[sentry] launchpads:", e.message));
    await work(s);
    pruneWallets();
    if (walletsDirty && Date.now() - lastWalletSave > 60000) { walletsDirty = false; lastWalletSave = Date.now(); await saveWallets().catch((e) => console.warn("[sentry] wallets:", e.message)); }
    await recap(s).catch((e) => console.warn("[sentry] recap:", e.message));
    if (recentDirty) { recentDirty = false; s.recent = recent.slice(0, 200); }   // post links of queued posts (staker lead)
    await store.writeJson(STATE, s);
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  recent.push(...((await store.readJson(STATE, {})).recent || []));
  const wf = await store.readJson(WALLETS, { coins: {} });
  for (const [k, v] of Object.entries(wf.coins || {})) if (v.t > Date.now() - 86400e3) remember(k, v.w, v.t);
  walletsDirty = false;
  // the record keeps every result, a stock posted before the stock rule included; it is marked so nobody reads it as a launch
  // eligible = met the channel's bar (the Desk's green pill). A pass whose pool now shows paper liquidity (see paperLiquidity,
  // from the Market's board row: no network call here) reads as a caution.
  const present = (x) => {
    if (isStock(x.token)) return { ...x, stock: true, note: STOCK_NOTE, eligible: false };
    if (x.verdict === "passed") {
      const paper = paperLiquidity(indexRow(x.token) || {});
      if (paper) return { ...x, verdict: "caution", reason: `${paper.label}: ${paper.detail}`, eligible: false };
    }
    return { ...x, eligible: itemMeetsBar(x) };
  };
  r.get("/api/sentry/recent", ({ query }) => ({ items: recent.slice(0, Math.min(100, Number(query.limit) || 30)).map(present), bar: { minEth: MIN_POST, minBuyers: MIN_BUYERS }, channel: `https://t.me/${CHANNEL.replace(/^@/, "")}`, live: !!MODE }));
  setTimeout(() => fillNames().catch(() => {}), 40_000).unref?.();
  setTimeout(() => refreshStocks().catch(() => {}), 25_000).unref?.();   // after the market's own first read of the desk
  if (!MODE || (MODE !== "dry" && !TG)) return;
  console.log(`[sentry] watching Pons launches${POOLS ? ", new pools and the other launchpads" : ""} → ${MODE === "dry" ? "data/sentry-preview.jsonl (dry)" : CHANNEL}`);
  setTimeout(() => store.readJson(STATE, {}).then(warmUp).catch((e) => console.warn("[sentry] warm-up:", e.message)), 3000).unref();
  if (MODE !== "dry") setTimeout(() => resumePending().catch((e) => console.warn("[sentry] resume:", e.message)), 4000).unref();
  setTimeout(() => tick().catch(() => {}), 5000).unref();
  setInterval(() => tick().catch(() => {}), 15000).unref();
}

// tests only (tools/sentry-lead-test.mjs): the staker-lead queue without the chain loop
export const _test = { postWithLead, setStore: (s) => { store = s; }, waiting: () => waiting, recent };
