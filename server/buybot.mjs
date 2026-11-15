// Troya buy tracker: every $TROYA buy, on the Pons curve or a Uniswap v4 ETH pool, posted to the Telegram group.
//   BUYBOT=1   watch + post        BUYBOT=dry   watch, write posts to data/buybot-preview.jsonl, send nothing
//   BUYBOT_CHAT (default @troyaagent) · BUYBOT_MIN_USD (default 25) · BUYBOT_BIG_USD (default 500)
//   BUYBOT_POOLS (extra v4 pool ids, comma separated). The token is the CA in public/config.js.
//   BUYBOT_RECAP_UTC_HOUR (default 14): one recap a day of the last 24 hours of buys. Also posts once when the Pons curve
//   crosses 60/70/80/90% of its graduation target, and once when $TROYA graduates to its Uniswap v4 pool.
// How a buy is read, per transaction: $TROYA leaving a market (the Pons curve, or the v4 PoolManager) minus $TROYA going
// back into one. A positive net is a buy; arbitrage that buys on one venue and sells on the other nets to about zero and
// is skipped. ETH spent comes from the curve's Buy event (gross, fees included) and from our pools' Swap events, so the
// numbers are the chain's own. The wallet shown is the address that ends up holding the tokens.
import { readFileSync } from "node:fs";
import { AbiCoder, getAddress } from "ethers";
import { ADDR, rpc, ponsState } from "./robinhood.mjs";

const MODE = process.env.BUYBOT || "";
const CHAT = process.env.BUYBOT_CHAT || "@troyaagent";
const MIN_USD = Number(process.env.BUYBOT_MIN_USD ?? 25);
const BIG_USD = Number(process.env.BUYBOT_BIG_USD ?? 500);
const EXTRA_POOLS = (process.env.BUYBOT_POOLS || "").split(/[\s,]+/).filter((x) => /^0x[0-9a-fA-F]{64}$/.test(x)).map((x) => x.toLowerCase());
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const SITE = "https://troya.codes";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const STATE = "buybot.json";
const MAX_RANGE = 2000, CATCHUP = 400, MAX_GAP = 20000, PER_TICK = 4;
const RECAP_HOUR = Number(process.env.BUYBOT_RECAP_UTC_HOUR ?? 14);
const MILESTONES = [60, 70, 80, 90];

const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";   // v4 Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)
const T_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";   // v4 Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
const T_CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455"; // Pons curve buy: data = quoteIn, tokensOut, fee, creatorTax
const ZERO_TOPIC = "0x" + "0".repeat(64);
const coder = AbiCoder.defaultAbiCoder();
const lower = (a) => String(a || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const pad = (a) => "0x" + lower(a).slice(2).padStart(64, "0");
const topicAddr = (t) => "0x" + t.slice(26);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let store, busy = false, lastPost = 0, market = null;
const recent = [];                         // newest first, for /api/buys/recent

function siteCa() {
  try { return (readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1] || ""; } catch { return ""; }
}

/* ---------- numbers ---------- */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 0 : 2 });
}
export const fmtUsd = (n) => (n >= 1e4 ? "$" + fmtNum(n) : "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 }));
export function fmtPrice(p) {
  if (!(p > 0)) return "?";
  if (p >= 0.01) return "$" + p.toFixed(4);
  const s = p.toPrecision(4);                       // 0.00001291 stays readable without scientific notation
  return "$" + Number(s).toFixed(Math.min(14, 2 - Math.floor(Math.log10(p)) + 2)).replace(/0+$/, "");
}
const fmtEth = (e) => (e >= 1 ? e.toFixed(3) : e >= 0.01 ? e.toFixed(4) : e.toPrecision(3)).replace(/\.?0+$/, "") + " ETH";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

/* ---------- the post ---------- */
export function formatBuy(b) {
  const big = b.usd >= BIG_USD;
  const bars = "▰".repeat(Math.max(1, Math.min(20, Math.round(b.usd / 25))));
  const lines = [
    `<b>${big ? "Big $TROYA buy" : "$TROYA buy"}</b>`,
    bars,
    "",
    `Spent: <b>${fmtEth(b.eth)}</b> (${fmtUsd(b.usd)})`,
    `Got: <b>${fmtNum(b.tokens)} TROYA</b>`,
    `Wallet: <a href="${EXPLORER}/address/${b.wallet}">${short(b.wallet)}</a>${b.fresh ? " · new holder" : ""}`,
  ];
  if (b.priceUsd) lines.push(`Price: ${fmtPrice(b.priceUsd)}${b.mcUsd ? ` · MC ${fmtUsd(b.mcUsd)}` : ""}`);
  lines.push(`Venue: ${b.venue}`, `<a href="${EXPLORER}/tx/${b.tx}">View transaction</a>`);
  return lines.join("\n");
}
export function formatMore(rest) {
  const eth = rest.reduce((s, b) => s + b.eth, 0), usd = rest.reduce((s, b) => s + b.usd, 0);
  return `<b>+${rest.length} more $TROYA buys</b>\n${fmtEth(eth)} (${fmtUsd(usd)}) in total`;
}
export function formatRecap(d) {
  const lines = [`<b>$TROYA, last 24 hours</b>`, "", `Buys: <b>${d.buys}</b> from ${d.wallets} wallet${d.wallets === 1 ? "" : "s"}`, `Bought: <b>${fmtEth(d.eth)}</b> (${fmtUsd(d.usd)})`];
  if (d.top) lines.push(`Biggest buy: ${fmtEth(d.top.eth)} (${fmtUsd(d.top.usd)}) by <a href="${EXPLORER}/address/${d.top.wallet}">${short(d.top.wallet)}</a>`);
  if (d.priceUsd) lines.push(`Price now: ${fmtPrice(d.priceUsd)}${d.mcUsd ? ` · MC ${fmtUsd(d.mcUsd)}` : ""}`);
  if (d.curvePct != null) lines.push(`Pons curve: ${d.curvePct.toFixed(1)}% of the way to graduation (${d.raised.toFixed(2)} of ${d.target} ETH)`);
  lines.push("", "Every number is read from the chain.");
  return lines.join("\n");
}
export const formatMilestone = (pct, raised, target) => `<b>$TROYA curve: ${pct}% to graduation</b>\n\n${raised.toFixed(2)} of ${target} ETH raised on the Pons curve. At ${target} ETH, $TROYA graduates to its Uniswap v4 pool.`;
export const formatGraduated = (target) => `<b>$TROYA has graduated</b>\n\nThe Pons curve filled at ${target} ETH and $TROYA now trades on its Uniswap v4 pool on Robinhood Chain.\n\nThe CA does not change. The buy tracker follows the new pool on its own, and Troya Gate routes swaps there automatically.\n\nThanks to everyone who bought on the curve. On to the next one.`;
const buttons = (ca) => ({ inline_keyboard: [
  [{ text: "Buy through Troya Gate", url: `${SITE}/agent#/swap?in=eth&out=${ca}` }],
  [{ text: "Chart", url: `${SITE}/agent#/token/${ca}` }, { text: "DexScreener", url: `https://dexscreener.com/robinhood/${ca}` }],
  [{ text: "Troya Sentry: every new Pons launch, checked", url: "https://t.me/troyasentry" }],
] });

async function tg(method, payload) {
  return fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
}
async function send(text, markup) {
  if (MODE === "dry") { await store.append("buybot-preview.jsonl", { t: Date.now(), chat: CHAT, text, markup }); return { ok: true, dry: true }; }
  const wait = lastPost + 4000 - Date.now();
  if (wait > 0) await new Promise((x) => setTimeout(x, wait));
  lastPost = Date.now();
  const once = () => tg("sendMessage", { chat_id: CHAT, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
  const j = await once();
  if (!j.ok && j.parameters?.retry_after) { await new Promise((x) => setTimeout(x, (j.parameters.retry_after + 1) * 1000)); return once(); }
  return j;
}

/* ---------- market: token, curve, pools, price ---------- */
const erc20 = (to, sel, arg = "") => rpc("robinhood", "eth_call", [{ to, data: sel + arg }, "latest"]);
async function refreshMarket(s) {
  const token = siteCa();
  if (!token) return null;
  if (market && lower(market.token) === lower(token) && Date.now() - market.at < 10 * 60e3) return market;
  const ps = await ponsState(token).catch(() => null);
  const [supplyHex, decHex] = await Promise.all([erc20(token, "0x18160ddd"), erc20(token, "0x313ce567")]);
  const pools = new Set([...(s.pools || []), ...EXTRA_POOLS]);
  if (ps?.poolId) pools.add(lower(ps.poolId));
  market = { token: getAddress(token), curve: ps && !ps.graduated ? lower(ps.curve) : null, ps, pools: [...pools], decimals: Number(BigInt(decHex)), supply: BigInt(supplyHex), at: Date.now() };
  return market;
}
// new ETH ↔ $TROYA v4 pools (anyone can open one, so only ETH pairs count; others are ignored)
async function scanPools(s, token, head) {
  let from = s.poolScan ? s.poolScan + 1 : Math.max(0, head - 5_000_000);
  if (head - from < 500 && s.pools) return;
  const pools = new Set(s.pools || []);
  while (from <= head) {
    const to = Math.min(head, from + 4_000_000);
    const logs = await rpc("robinhood", "eth_getLogs", [{ address: ADDR.poolManager, topics: [T_INIT, null, ZERO_TOPIC, pad(token)], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 25000 });
    for (const l of logs || []) pools.add(lower(l.topics[1]));
    from = to + 1;
  }
  s.pools = [...pools]; s.poolScan = head;
}
async function ethUsd() {
  const { getEthUsd } = await import("./market.mjs");
  return Number(await getEthUsd()) || 0;
}
function spotEth(m, lastSqrt) {
  // the curve's own reserves while it trades; after graduation, the pool's price from the last Swap we saw
  if (m.ps && !m.ps.graduated && m.ps.tokenReserve > 0n) return Number(m.ps.quoteReserve) / Number(m.ps.tokenReserve) * 10 ** (m.decimals - 18);
  if (lastSqrt) { const r = (Number(lastSqrt) / 2 ** 96) ** 2; return r > 0 ? 1 / r * 10 ** (m.decimals - 18) : 0; }   // currency0 = ETH, currency1 = token
  return 0;
}

/* ---------- reading one transaction ---------- */
export function readBuy(receipt, m, unit = 10n ** 18n) {
  const tok = lower(m.token), pm = lower(ADDR.poolManager), venues = new Set([pm, ...(m.curve ? [m.curve] : [])]);
  const pools = new Set(m.pools);
  const net = new Map();          // address → $TROYA received minus sent (markets excluded)
  let out = 0n, back = 0n, ethIn = 0n, ethOut = 0n, sqrt = null;
  const venue = new Set();
  for (const l of receipt.logs || []) {
    const a = lower(l.address);
    if (a === tok && l.topics[0] === T_TRANSFER && l.topics.length === 3) {
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), v = BigInt(l.data);
      if (venues.has(from)) out += v; else net.set(from, (net.get(from) || 0n) - v);
      if (venues.has(to)) back += v; else net.set(to, (net.get(to) || 0n) + v);
    } else if (m.curve && a === m.curve && l.topics[0] === T_CURVE_BUY) {
      ethIn += BigInt("0x" + l.data.slice(2, 66)); venue.add("Pons curve");
    } else if (a === pm && l.topics[0] === T_SWAP && pools.has(lower(l.topics[1]))) {
      const [a0, , sq] = coder.decode(["int128", "int128", "uint160"], l.data);
      if (a0 < 0n) { ethIn += -a0; venue.add("Uniswap v4"); } else ethOut += a0;    // amounts are the swapper's: negative = paid in
      sqrt = sq;
    }
  }
  const tokens = out - back;
  if (tokens <= 0n || out === 0n || tokens * 100n < out) return null;               // a sell, or an arb that nets out
  const eth = ethIn - ethOut;
  if (eth <= 0n) return null;
  let wallet = null, best = 0n;
  for (const [addr, v] of net) if (v > best && addr !== "0x0000000000000000000000000000000000000000") { best = v; wallet = addr; }
  return { tx: receipt.transactionHash, wallet: getAddress(wallet || receipt.from), tokensRaw: tokens, tokens: Number(tokens) / Number(unit), eth: Number(eth) / 1e18, venue: [...venue].join(" + ") || "Pons curve", sqrt, block: Number(BigInt(receipt.blockNumber)) };
}

/* ---------- curve milestones, graduation, daily recap ---------- */
const DAY = 86400e3;
function note(s, b) {
  (s.events ||= []).push([Date.now(), b.eth, b.usd, b.wallet]);
  const cut = Date.now() - 2 * DAY;
  while (s.events.length && s.events[0][0] < cut) s.events.shift();
}
async function watchCurve(s, m) {
  if (Date.now() - (s.curveAt || 0) < 30000 || !m.ps) return;
  s.curveAt = Date.now();
  const ps = await ponsState(m.token).catch(() => null);
  if (!ps) return;
  const target = Number(ps.threshold) / 1e18;
  if (ps.graduated) {
    if (!s.graduated) {
      s.graduated = Date.now(); market = null;
      const j = await send(formatGraduated(+target.toFixed(2)), buttons(m.token));
      if (!j.ok) console.warn("[buybot] graduation post failed:", j.description);
    }
    return;
  }
  const raised = Number(ps.realQuote) / 1e18, pct = target > 0 ? (raised / target) * 100 : 0;
  s.milestones ||= MILESTONES.filter((x) => x <= pct);          // first run: don't announce what already happened
  const hit = MILESTONES.filter((x) => x <= pct && !s.milestones.includes(x));
  if (hit.length) {
    const top = Math.max(...hit);
    s.milestones.push(...hit);
    const j = await send(formatMilestone(top, raised, +target.toFixed(2)), buttons(m.token));
    if (!j.ok) console.warn("[buybot] milestone post failed:", j.description);
  }
}
async function recap(s, m) {
  const now = new Date(), day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== RECAP_HOUR || s.recapDay === day) return;
  s.recapDay = day;
  const ev = (s.events || []).filter((e) => e[0] >= Date.now() - DAY);
  if (!ev.length) return;
  const usdPerEth = await ethUsd().catch(() => 0);
  const ps = m.ps && !m.ps.graduated ? await ponsState(m.token).catch(() => m.ps) : m.ps;
  const spot = spotEth({ ...m, ps }, null), supply = Number(m.supply) / 10 ** m.decimals;
  const top = ev.reduce((a, e) => (e[1] > (a?.[1] || 0) ? e : a), null);
  const d = { buys: ev.length, wallets: new Set(ev.map((e) => e[3])).size, eth: ev.reduce((x, e) => x + e[1], 0), usd: ev.reduce((x, e) => x + e[2], 0),
    top: top ? { eth: top[1], usd: top[2], wallet: top[3] } : null, priceUsd: spot * usdPerEth || null };
  d.mcUsd = d.priceUsd ? d.priceUsd * supply : null;
  if (ps && !ps.graduated) { d.raised = Number(ps.realQuote) / 1e18; d.target = +(Number(ps.threshold) / 1e18).toFixed(2); d.curvePct = d.target ? (d.raised / d.target) * 100 : null; }
  const j = await send(formatRecap(d), buttons(m.token));
  if (!j.ok) console.warn("[buybot] recap failed:", j.description);
}

/* ---------- loop ---------- */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await store.readJson(STATE, {});
    const m0 = await refreshMarket(s);
    if (!m0) return;
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    if (!s.poolScan || head - s.poolScan > 7200) { await scanPools(s, m0.token, head).catch((e) => console.warn("[buybot] pool scan:", e.message)); market = null; }
    const m = await refreshMarket(s);
    let from = s.lastBlock ? s.lastBlock + 1 : head - CATCHUP;
    if (head - from > MAX_GAP) from = head - CATCHUP;                                // after downtime: don't post stale buys
    const txs = new Set();
    while (from <= head) {
      const to = Math.min(head, from + MAX_RANGE - 1);
      const range = { fromBlock: hex(from), toBlock: hex(to) };
      const q = [];
      if (m.curve) q.push(rpc("robinhood", "eth_getLogs", [{ address: m.curve, topics: [T_CURVE_BUY], ...range }], { timeoutMs: 20000 }));
      if (m.pools.length) q.push(rpc("robinhood", "eth_getLogs", [{ address: ADDR.poolManager, topics: [T_SWAP, m.pools], ...range }], { timeoutMs: 20000 }));
      for (const logs of await Promise.all(q)) for (const l of logs || []) txs.add(l.transactionHash);
      s.lastBlock = to;
      from = to + 1;
    }
    const seen = new Set(s.posted || []);
    const unit = 10n ** BigInt(m.decimals);
    const buys = [];
    for (const h of txs) {
      if (seen.has(h)) continue;
      const rc = await rpc("robinhood", "eth_getTransactionReceipt", [h]).catch(() => null);
      if (!rc || rc.status !== "0x1") continue;
      const b = readBuy(rc, m, unit);
      if (b) buys.push(b);
    }
    if (buys.length) {
      const usdPerEth = await ethUsd();
      const ps = m.ps && !m.ps.graduated ? await ponsState(m.token).catch(() => m.ps) : m.ps;   // reserves after these buys
      buys.sort((a, b) => a.block - b.block);
      const lastSqrt = [...buys].reverse().find((b) => b.sqrt)?.sqrt;
      const spot = spotEth({ ...m, ps }, lastSqrt);
      const supply = Number(m.supply) / Number(unit);
      const ok = [];
      for (const b of buys) {
        b.usd = b.eth * usdPerEth;
        note(s, b);
        if (!(b.usd >= MIN_USD)) continue;
        b.priceUsd = spot * usdPerEth || null;
        b.mcUsd = b.priceUsd ? b.priceUsd * supply : null;
        const bal = await erc20(m.token, "0x70a08231", pad(b.wallet).slice(2)).catch(() => null);
        b.fresh = bal != null && BigInt(bal) <= b.tokensRaw + b.tokensRaw / 200n;       // holds about what this buy gave: first buy
        ok.push(b);
      }
      const posts = ok.slice(-PER_TICK), rest = ok.slice(0, -PER_TICK);
      if (rest.length) { const j = await send(formatMore(rest), buttons(m.token)); if (!j.ok) console.warn("[buybot] post failed:", j.description); }
      for (const b of posts) {
        const j = await send(formatBuy(b), buttons(m.token));
        if (!j.ok) console.warn("[buybot] post failed:", j.description);
      }
      for (const b of ok) recent.unshift({ tx: b.tx, wallet: b.wallet, eth: b.eth, usd: Math.round(b.usd * 100) / 100, tokens: b.tokens, venue: b.venue, at: Date.now() });
      recent.splice(50);
      for (const b of buys) seen.add(b.tx);
    }
    for (const h of txs) seen.add(h);
    await watchCurve(s, m).catch((e) => console.warn("[buybot] curve:", e.message));
    await recap(s, m).catch((e) => console.warn("[buybot] recap:", e.message));
    s.posted = [...seen].slice(-500);
    s.recent = recent.slice(0, 20);
    await store.writeJson(STATE, s);
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  recent.push(...((await store.readJson(STATE, {})).recent || []));
  r.get("/api/buys/recent", ({ query }) => ({ items: recent.slice(0, Math.min(50, Number(query.limit) || 20)), minUsd: MIN_USD, live: !!MODE }));
  if (!MODE || (MODE !== "dry" && !TG)) return;
  console.log(`[buybot] watching $TROYA buys → ${MODE === "dry" ? "data/buybot-preview.jsonl (dry)" : CHAT} (min $${MIN_USD})`);
  setTimeout(() => tick().catch((e) => console.warn("[buybot]", e.message)), 8000).unref();
  setInterval(() => tick().catch((e) => console.warn("[buybot]", e.message)), 6000).unref();
}
