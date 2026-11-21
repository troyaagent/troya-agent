// Market data: Robinhood Chain token board (GeckoTerminal pools across Pons, Clanker, Bankr, Virtuals, Uniswap … plus
// on-chain Pons state), tokenized stocks, Hyperliquid perps + spot, ETH price, a computed brief and live signals.
// Everything here is read-only and cached in memory; when a source fails the last good copy is served with `stale: true`.
// GeckoTerminal's public API allows about 30 calls a minute, so every call goes through one paced queue
// (user-facing reads jump ahead of the background index refresh).
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { AbiCoder, Interface, keccak256, toBeHex } from "ethers";
import { KYBER_ON } from "./kyber.mjs";
import { hlCtxs, perpName } from "./hl.mjs";
import { noteV4, ponsState, ponsPublic, ponsProfile, STOCKS, ADDR as RH, rpc as rhRpc, CHAINS as RH_CHAINS, iface as RHI } from "./robinhood.mjs";

const UA = { "user-agent": "troya-agent/0.2 (+market-reader)", accept: "application/json" };
const HL = "https://api.hyperliquid.xyz/info";
const GECKO = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const STOCK_SET = new Set(STOCKS.map((s) => String(s.address).toLowerCase()));
// the bundled list holds 63 stock tokens; Robinhood's stocks desk lists every one (203 on 18 Nov): merge them in at start and
// every 6 h, so search, the board, Gate checks and copycat guards all know Firefly, ONTO, CBRS and the rest are stocks
async function syncStocks() {
  const d = await import("./stocks.mjs").then((m) => m.stockDesk()).catch(() => null);
  let added = 0;
  for (const x of d?.assets || []) {
    const a = String(x.address || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) || STOCK_SET.has(a) || !x.symbol) continue;
    STOCK_SET.add(a); STOCKS.push({ address: a, symbol: String(x.symbol), name: String(x.name || x.symbol), decimals: 18 }); added++;
  }
  if (added) console.log(`[market] ${added} more stock tokens from the stocks desk (${STOCK_SET.size} in all)`);
}
setTimeout(() => syncStocks().catch(() => {}), 20_000).unref?.();
setInterval(() => syncStocks().catch(() => {}), 6 * 3600_000).unref?.();
const SORTS = new Set(["volume", "mcap", "change", "liquidity", "newest", "price", "txns", "holders", "picks"]);
const SORT_ALIAS = { age: "newest", new: "newest", marketcap: "mcap", cap: "mcap", fdv: "mcap", gainers: "change", vol: "volume" };
export const LAUNCHPADS = {
  pons: "Pons", clanker: "Clanker", bankr: "Bankr", virtuals: "Virtuals", hoodit: "Hoodit", mintclub: "Mint Club", easya: "EasyA", o1: "O1 Launchpad",
  frontier: "Frontier", long: "Long", abyss: "Abyss", goo: "Goo", clank: "Clank.trade", uniswap: "Uniswap", ramses: "Ramses", pancake: "PancakeSwap", sushi: "SushiSwap",
  aero: "Aerodrome", up: "Up", other: "Other",
};
const LAUNCH_PADS = new Set(["pons", "clanker", "bankr", "virtuals", "hoodit", "mintclub", "easya", "o1", "frontier", "long", "abyss", "goo", "clank"]);
export function padOfDex(id = "") {
  if (/^pons/.test(id)) return "pons";
  if (id === "clank-trade") return "clank";
  if (/^clank/.test(id)) return "clanker";
  if (id === "abyss") return "abyss";
  if (/^goo-/.test(id)) return "goo";
  if (/^aero-/.test(id)) return "aero";
  if (/^up-v/.test(id)) return "up";
  if (/^bankr/.test(id)) return "bankr";
  if (/^virtuals/.test(id)) return "virtuals";
  if (id === "hoodit") return "hoodit";
  if (/^mint-club/.test(id)) return "mintclub";
  if (/^easya/.test(id)) return "easya";
  if (/^o1-/.test(id)) return "o1";
  if (/^frontier/.test(id)) return "frontier";
  if (/^long-/.test(id)) return "long";
  if (/^uniswap/.test(id)) return "uniswap";
  if (/^ramses/.test(id)) return "ramses";
  if (/^pancakeswap/.test(id)) return "pancake";
  if (/^sushiswap/.test(id)) return "sushi";
  return "other";
}
// venues Troya can build a swap for: Pons curves and Uniswap v3 / v4 (graduated Pons pools are v4 with the Pons hook), and every
// other Robinhood Chain venue through the KyberSwap fallback (robinhood.mjs asks Kyber when its own route finds nothing)
const ROUTABLE = (dex) => /^(pons-v2|pons-v2-dex|pons-dot-family|uniswap-v3-robinhood|uniswap-v4-robinhood)$/.test(dex) || (KYBER_ON && !!dex);

/* ---------------- fetch + cache ---------------- */
async function getJson(url, { timeout = 12000, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(url, {
    method, headers: body ? { ...UA, "content-type": "application/json", ...headers } : { ...UA, ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${new URL(url).host} returned non-JSON (${res.status})`); }
  if (!res.ok) throw Object.assign(new Error(data?.error || data?.message || data?.errors?.[0]?.title || `${new URL(url).host} ${res.status}`), { status: res.status, data });
  return data;
}
const hl = (body, timeout = 10000) => getJson(HL, { method: "POST", body, timeout });

// GeckoTerminal queue: one call every 3 s, high-priority (user) calls first; a 429 waits and retries twice
const gq = { hi: [], lo: [], busy: false, last: 0, lastLo: false };
// F18 Liquidity desk reads pools and candles through the same queue (paths are under networks/robinhood/)
export const geckoApi = (pathQs, opts) => gecko(pathQs, opts);
// the same call already waiting is joined, never queued twice (with Blockscout paused, holder reads for the same coins
// piled up behind the 10-second background pace and the queue only grew); a user asking for something the background
// already queued moves it up front. The background queue is capped: its oldest job gives way.
const LO_CAP = 40;
const CHART_RE = /\/ohlcv\//;
function gecko(pathQs, { hi = false } = {}) {
  return new Promise((resolve, reject) => {
    const dup = gq.hi.find((j) => j.pathQs === pathQs) || gq.lo.find((j) => j.pathQs === pathQs);
    if (dup) {
      dup.waiters.push({ resolve, reject });
      if (hi && !dup.hi) { gq.lo.splice(gq.lo.indexOf(dup), 1); dup.hi = true; dup.queuedAt = Date.now(); if (CHART_RE.test(pathQs)) gq.hi.unshift(dup); else gq.hi.push(dup); }
      return;
    }
    const job = { pathQs, waiters: [{ resolve, reject }], hi, queuedAt: Date.now() };
    // a chart someone is looking at goes to the front of the user queue (it waited ~47 s behind back-fills on 20 Nov)
    if (hi && CHART_RE.test(pathQs)) gq.hi.unshift(job); else (hi ? gq.hi : gq.lo).push(job);
    while (gq.lo.length > LO_CAP) { const old = gq.lo.shift(); for (const w of old.waiters) w.reject(Object.assign(new Error("GeckoTerminal queue is full; try again shortly"), { status: 503 })); }
    pumpGecko();
  });
}
// a background job that has waited this long goes next, so a steady stream of high-priority calls (chart loads, the
// Record back-fill every 8 s) cannot starve the board
const LO_MAX_WAIT = 30_000;
const loOverdue = () => gq.lo.length && Date.now() - gq.lo[0].queuedAt > LO_MAX_WAIT;
async function pumpGecko() {
  if (gq.busy) return;
  gq.busy = true;
  try {
    while (gq.hi.length || gq.lo.length) {
      // user-facing calls go 4 s after the previous one; the background board waits 10 s and steps aside for user calls
      // an overdue background job goes next, but only one at a time: then a waiting user call (a chart, a range
      // suggestion) goes, so a backlog of overdue board jobs cannot hold user calls for half a minute either
      let job = gq.hi.length && (!loOverdue() || gq.lastLo) ? gq.hi.shift() : gq.lo.shift();
      for (;;) {
        const wait = gq.last + (job.hi ? 4000 : 10000) - Date.now();
        if (wait <= 0) break;
        if (!job.hi && gq.hi.length && Date.now() - job.queuedAt <= LO_MAX_WAIT) { gq.lo.unshift(job); job = gq.hi.shift(); continue; }
        await new Promise((r) => setTimeout(r, Math.min(wait, 250)));
      }
      gq.last = Date.now();
      gq.lastLo = !job.hi;
      try { const v = await getJson(`${GECKO}/networks/${NET}/${job.pathQs}`, { timeout: 15000 }); for (const w of job.waiters) w.resolve(v); }
      catch (e) {
        if (e.status === 429 && (job.tries || 0) < 2) {
          job.tries = (job.tries || 0) + 1;
          gq.last = Date.now() + 20_000;           // back off, then retry this job first
          (job.hi ? gq.hi : gq.lo).unshift(job);
          continue;
        }
        for (const w of job.waiters) w.reject(e);
      }
    }
  } finally { gq.busy = false; }
}

// Stale-while-revalidate: a value past its ttl but younger than swr × ttl (12 by default, and never more than 10 minutes
// past the ttl) is answered at once while ONE background refresh runs; only a cold or very old key makes its reader
// wait (one user paid 0.7-1.8 s each time an entry expired). swr: 0 keeps the strict ttl for reads that stamp a price
// "now" or feed one that is recorded (DexScreener pairs, a coin's page read, which The Record and the oracle price
// from). Either way, when a refresh fails the last good value is served with stale: true (and the next reader, or the
// one after a short pause, tries again).
const cache = new Map(); // key → { t, value, p, err, retryAt }
const STALE_X = 12;
const staleFor = (ttl, swr) => (swr > 0 ? Math.min(ttl * swr, ttl + 10 * 60_000) : 0);
const asStale = (v, why) => (v && typeof v === "object" && !Array.isArray(v) ? { ...v, stale: true, staleReason: why } : v);
async function memo(key, ttl, fn, { swr = STALE_X } = {}) {
  const now = Date.now();
  let e = cache.get(key);
  if (!e) { e = { t: 0, value: undefined, p: null, err: null, retryAt: 0 }; cache.set(key, e); }
  const has = e.value !== undefined, age = has ? now - e.t : Infinity;
  if (age < ttl) return e.value;
  // a failing source is asked again at most every few seconds while there is a value to serve meanwhile
  if (!e.p && (!has || now >= e.retryAt)) {
    const p = Promise.resolve().then(fn).then(
      (value) => { if (e.p === p) e.p = null; Object.assign(e, { t: Date.now(), value, err: null, retryAt: 0 }); return value; },
      (err) => { if (e.p === p) e.p = null; Object.assign(e, { err: err?.message || String(err), retryAt: Date.now() + Math.min(ttl, 5_000) }); throw err; });
    e.p = p;
    p.catch(() => {});                      // a background refresh may have nobody waiting on it
  }
  if (cache.size > 2000) for (const [k, v] of cache) if (!v.p && now - v.t > 30 * 60_000) cache.delete(k);
  if (has && (age < staleFor(ttl, swr) || !e.p)) return e.err ? asStale(e.value, e.err) : e.value;
  try { return await e.p; }
  catch (err) { if (has) return asStale(e.value, err.message); throw err; }
}
// token address → logo URL, filled as listings are normalized (read by icons.mjs)
const IMAGES = new Map();
export const imageFor = (address) => IMAGES.get(String(address || "").toLowerCase()) || null;
const fnum = (v) => { const n = typeof v === "string" ? Number(v) : v; return n == null || !isFinite(n) ? null : n; };
const httpErr = (status, message) => Object.assign(new Error(message), { status, expose: true });
const goodImg = (u) => (typeof u === "string" && /^https:\/\//.test(u) && !/missing/.test(u) ? u : null);
const lc = (a) => String(a || "").toLowerCase();

/* ---------------- DexScreener (token detail + stocks: fast, 300 calls/min) ---------------- */
const DS = "https://api.dexscreener.com/tokens/v1/robinhood/";
// tokens/v1 answers up to 30 coins a call but with ONE pair per coin, and not always its main pool (MEME came back as a
// $1.1K USDG pool next to its $600K pool, 20 Nov 2026); token-pairs/v1 lists every pool of one coin
const DSP = "https://api.dexscreener.com/token-pairs/v1/robinhood/";
export async function dsPairs(addrs) {
  const list = [...new Set(addrs.map(lc))].filter((a) => ADDR_RE.test(a));
  const out = [];
  for (let i = 0; i < list.length; i += 30) {
    const part = list.slice(i, i + 30);
    const d = await memo(`ds:${part.join(",")}`, 60_000, () => getJson(DS + part.join(","), { timeout: 12000 }), { swr: 0 });   // callers stamp these prices "now"
    if (Array.isArray(d)) out.push(...d);
  }
  return out;
}
export async function dsTokenPairs(address) {
  const a = lc(address);
  if (!ADDR_RE.test(a)) return [];
  const d = await memo(`dsp:${a}`, 60_000, () => getJson(DSP + a, { timeout: 12000 }), { swr: 0 });
  return Array.isArray(d) ? d : [];
}
// best DexScreener pair per base token (deepest liquidity) → board-style row
export function dsRows(pairs, ethUsd) {
  const best = new Map(), all = new Map();
  for (const p of pairs || []) {
    const a = lc(p.baseToken?.address);
    if (!a) continue;
    const cur = best.get(a);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(a, p);
    if (!all.has(a)) all.set(a, []);
    all.get(a).push(p);
  }
  // price and change come from the deepest pool; volume, liquidity and trades add up over the token's real pools
  // (stock tokens trade in several pools, so one pool showed 2-6x too little); dust pools and fabricated volume left out
  const sumOf = (a) => {
    let vol = 0, liq = 0, buys = 0, sells = 0, n = 0;
    for (const p of all.get(a) || []) {
      const l = p.liquidity?.usd || 0, v = p.volume?.h24 || 0, tx = p.txns?.h24 || {}, t = (tx.buys || 0) + (tx.sells || 0);
      if (l < 500) continue;
      if (!STOCK_SET.has(a) && v > 10_000 && (t === 0 || v / t > 50_000)) continue;
      vol += v; liq += l; buys += tx.buys || 0; sells += tx.sells || 0; n++;
    }
    return n ? { vol, liq, buys, sells, n } : null;
  };
  const rows = new Map();
  for (const [a, p] of best) {
    const dex = `${p.dexId || "other"}${p.labels?.[0] ? "-" + p.labels[0] : ""}`;
    const priceUsd = fnum(p.priceUsd);
    const tx = p.txns?.h24 || {};
    const sym = (s) => String(s || "").replace(/\s•.*$/, "");
    rows.set(a, {
      address: a, name: String(p.baseToken?.name || "").replace(/\s•\s*Robinhood Token$/, ""), symbol: sym(p.baseToken?.symbol), image: goodImg(p.info?.imageUrl),
      priceUsd, priceEth: priceUsd && ethUsd ? priceUsd / ethUsd : null, change24h: fnum(p.priceChange?.h24), change1h: fnum(p.priceChange?.h1),
      volume24hUsd: sumOf(a)?.vol ?? fnum(p.volume?.h24), volume24hEth: ethUsd ? (sumOf(a)?.vol ?? fnum(p.volume?.h24) ?? 0) / ethUsd : null,
      liquidityUsd: sumOf(a)?.liq ?? fnum(p.liquidity?.usd), liquidityEth: ethUsd ? (sumOf(a)?.liq ?? fnum(p.liquidity?.usd) ?? 0) / ethUsd : null,
      mcapUsd: fnum(p.marketCap) ?? fnum(p.fdv), mcapEth: ethUsd && (p.marketCap ?? p.fdv) ? (p.marketCap ?? p.fdv) / ethUsd : null,
      buys24h: sumOf(a)?.buys ?? tx.buys ?? null, sells24h: sumOf(a)?.sells ?? tx.sells ?? null, txns24h: sumOf(a) ? sumOf(a).buys + sumOf(a).sells : tx.buys != null ? (tx.buys || 0) + (tx.sells || 0) : null,
      createdAt: fnum(p.pairCreatedAt), pool: lc(p.pairAddress), poolDex: dex, quoteSymbol: p.quoteToken?.symbol || null,
      pools: [{ pool: lc(p.pairAddress), dex, quoteSymbol: p.quoteToken?.symbol || null, liquidityUsd: fnum(p.liquidity?.usd), volumeUsd: fnum(p.volume?.h24) }],
      launchpad: padOfDex(dex), tradable: /^uniswap-(v3|v4)$/.test(dex) || KYBER_ON, stock: STOCK_SET.has(a),
      website: p.info?.websites?.[0]?.url || null,
      twitter: p.info?.socials?.find((x) => x.type === "twitter")?.url || null,
      telegram: p.info?.socials?.find((x) => x.type === "telegram")?.url || null,
      source: "DexScreener",
    });
  }
  return rows;
}

/* ---------------- ETH / USD ---------------- */
let ETH_LAST = null;   // the last ETH price read, for the synchronous readers (indexRow)
export async function getEthUsd() {
  return memo("ethUsd", 10_000, async () => {
    try {
      const mids = await hl({ type: "allMids" }, 6000);
      const v = fnum(mids?.ETH);
      if (v) return (ETH_LAST = v);
      throw new Error("ETH mid missing");
    } catch {
      const d = await gecko(`tokens/${RH.weth.toLowerCase()}`, { hi: true });
      const v = fnum(d?.data?.attributes?.price_usd);
      if (!v) throw new Error("No ETH price available");
      return (ETH_LAST = v);
    }
    // at most 30 s old while a refresh runs (not the display default of 12 x the ttl): this price also turns the Agent
    // Wallet's dollar caps into ETH and sizes payouts (agentwallet.mjs, payouts.mjs); the 15 s warm-up keeps it fresher
  }, { swr: 3 });
}
export async function getHypeUsd() {
  return memo("hypeUsd", 10_000, async () => {
    const mids = await hl({ type: "allMids" }, 6000);
    const v = fnum(mids?.HYPE);
    if (!v) throw new Error("No HYPE price available");
    return v;
  });
}

/* ---------------- Robinhood Chain board (GeckoTerminal) ---------------- */
const CBBTC = "0xcec185eb182c47d1ba1efc84e6959e18cd620be4";   // Coinbase Wrapped BTC: a major, kept off the coin board and launch lists
const HUBS = new Set([lc(RH.weth), lc(RH.usdg), CBBTC, "0x0000000000000000000000000000000000000000"]);
const board = { rows: new Map(), updatedAt: 0, refreshing: null, error: null, volumeUsd: 0, cursor: 0 };
// One honest set of numbers per coin (20 Nov 2026 audit). Three things the indexers alone got wrong:
//  · price: a row off GeckoTerminal's top lists kept its last price for an hour ($TROYA showed $0.00000653, 69 minutes
//    old, -54%, while its pool traded at $0.0000056); rows older than PRICE_STALE take DexScreener's numbers, and Pons
//    coins are priced from the chain itself (CHAIN, below)
//  · market cap: price x 1B ignored the 32.7M $TROYA burned; Pons coins use totalSupply minus 0x...dEaD, read on chain
//  · liquidity: a pool's reserve counts the coin side at the pool's own price, so MOW showed $18.6M on 0.81 ETH and Troya
//    picks called it an "$18.8M pool"; REAL holds the money side (ETH, WETH, USDG, cbBTC or a stock token) of its pools
const PRICE_STALE = 5 * 60_000;
const REAL = new Map();     // address -> { usd, at }: money side of the coin's pools, from DexScreener's pair list
const CHAIN = new Map();    // address -> { priceUsd, priceEth, supply, onCurve, realUsd, at }: Pons coins read on chain
const PSTATIC = new Map();  // address -> { curve, pair, pd, graduated, poolId, tokenFirst, at } | { none: true, at }
// The board is saved to data/board.json and read back at boot: a full pass takes minutes at GeckoTerminal's pace, so a
// restart (or a 429 spell) would otherwise leave the Market with only the first page or nothing at all.
const BOARD_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "board.json") : null;
const BOARD_MAX_AGE = 6 * 3600_000;
let boardSaveTimer = null;
(function loadBoard() {
  if (!BOARD_FILE) return;
  try {
    const s = JSON.parse(readFileSync(BOARD_FILE, "utf8"));
    if (!(Date.now() - (s.updatedAt || 0) < BOARD_MAX_AGE) || !Array.isArray(s.rows)) return;
    board.rows = new Map(s.rows.filter((t) => t?.address).map((t) => [t.address, t]));
    board.updatedAt = s.updatedAt; board.volumeUsd = s.volumeUsd || 0; board.cursor = Number.isInteger(s.cursor) && s.cursor >= 0 ? s.cursor : 0;
    for (const t of board.rows.values()) if (t.image) IMAGES.set(t.address, t.image);
    // real liquidity and the on-chain supply come back too (a chain price is never reused after a restart)
    for (const [a, v] of Array.isArray(s.real) ? s.real : []) if (v && Number.isFinite(v.at)) REAL.set(a, v);
    for (const [a, v] of Array.isArray(s.supply) ? s.supply : []) if (v?.supply > 0) CHAIN.set(a, { supply: v.supply, at: 0 });
  } catch {}
})();
function saveBoard() {
  if (!BOARD_FILE || boardSaveTimer) return;
  boardSaveTimer = setTimeout(async () => {
    boardSaveTimer = null;
    try {
      const tmp = BOARD_FILE + ".tmp";
      await writeFile(tmp, JSON.stringify({ updatedAt: board.updatedAt, volumeUsd: board.volumeUsd, cursor: board.cursor, rows: [...board.rows.values()].map(clean),
        real: [...REAL].slice(-2000), supply: [...CHAIN].filter(([, c]) => c.supply > 0).slice(-2000).map(([a, c]) => [a, { supply: c.supply }]) }));
      await rename(tmp, BOARD_FILE);
    } catch (e) { console.warn("[market] board save:", e.message); }
  }, 5000);
  boardSaveTimer.unref?.();
}

function poolRow(p, inc) {
  const a = p.attributes || {};
  const baseId = p.relationships?.base_token?.data?.id || "", quoteId = p.relationships?.quote_token?.data?.id || "";
  const base = lc(baseId.split("_")[1]), quote = lc(quoteId.split("_")[1]);
  const dex = p.relationships?.dex?.data?.id || "";
  const tok = inc.get(baseId)?.attributes || {};
  const tx = a.transactions?.h24 || {};
  const [baseSym = "", quoteSym = ""] = String(a.name || "").split(" / ");
  return {
    pool: lc(a.address), dex, base, quote, quoteSymbol: quoteSym.replace(/\s.*$/, ""),
    name: String(tok.name || baseSym).replace(/\s•\s*Robinhood Token$/, ""), symbol: tok.symbol || baseSym, image: goodImg(tok.image_url),
    priceUsd: fnum(a.base_token_price_usd), priceEth: fnum(a.base_token_price_native_currency),
    change24h: fnum(a.price_change_percentage?.h24), change1h: fnum(a.price_change_percentage?.h1),
    volumeUsd: fnum(a.volume_usd?.h24) || 0, liquidityUsd: fnum(a.reserve_in_usd), mcapUsd: fnum(a.market_cap_usd) || fnum(a.fdv_usd) || null, fdvUsd: fnum(a.fdv_usd),
    buys: tx.buys || 0, sells: tx.sells || 0, createdAt: Date.parse(a.pool_created_at || "") || null,
  };
}
// fold one pool into the per-token row: the deepest pool sets the price, volume and trades add up
// GeckoTerminal's busiest-pool lists carry wash-traded copycat pools ($50M "volume" against $0 liquidity): a pool needs
// real liquidity to be listed, and volume far beyond what its liquidity could carry is not counted
const MIN_POOL_LIQ_USD = 500;
function fold(map, pr, ethUsd) {
  if (!pr.base || HUBS.has(pr.base)) return;
  if (!(pr.liquidityUsd >= MIN_POOL_LIQ_USD)) return;
  if (pr.volumeUsd > pr.liquidityUsd * 300) { pr.volumeUsd = 0; pr.washVolume = true; }
  // fabricated volume: a few trades worth millions each (a copycat pool showed $50M from 20 trades); stock pools excepted
  const trades = (pr.buys || 0) + (pr.sells || 0);
  if (!STOCK_SET.has(pr.base) && pr.volumeUsd > 10_000 && (trades === 0 || pr.volumeUsd / trades > 50_000)) { pr.volumeUsd = 0; pr.washVolume = true; }
  let t = map.get(pr.base);
  if (!t) {
    t = { address: pr.base, name: pr.name, symbol: pr.symbol, image: pr.image, pools: [], volume24hUsd: 0, txns24h: 0, buys24h: 0, sells24h: 0, createdAt: pr.createdAt, launchpad: "other", tradable: false, stock: STOCK_SET.has(pr.base) };
    map.set(pr.base, t);
  }
  if (t.pools.some((x) => x.pool === pr.pool)) return;
  t.pools.push({ pool: pr.pool, dex: pr.dex, quoteSymbol: pr.quoteSymbol, liquidityUsd: pr.liquidityUsd, volumeUsd: pr.volumeUsd });
  t.volume24hUsd += pr.volumeUsd; t.buys24h += pr.buys; t.sells24h += pr.sells; t.txns24h = t.buys24h + t.sells24h;
  if (pr.createdAt && (!t.createdAt || pr.createdAt < t.createdAt)) t.createdAt = pr.createdAt;
  if (!t.image && pr.image) t.image = pr.image;
  // the launchpad is where the coin was born: a Pons curve always wins; otherwise the oldest pool seen decides. Before
  // (20 Nov) any pool on a launchpad's DEX relabelled a coin (PONS and CASHCAT showed "Abyss" from a later Abyss pair)
  // and the label of a coin without one followed the order pages arrived in ("Ramses" one pass, "Uniswap" the next)
  const pad = padOfDex(pr.dex), at = pr.createdAt || Infinity;
  if (t.launchpad !== "pons" && (pad === "pons" || t._padAt === undefined || at < t._padAt)) { t.launchpad = pad; t._padAt = at; }
  if (ROUTABLE(pr.dex)) t.tradable = true;
  if (!t._main || (pr.liquidityUsd || 0) > (t._main.liquidityUsd || 0)) {
    t._main = pr;
    Object.assign(t, { priceUsd: pr.priceUsd, priceEth: pr.priceEth, change24h: pr.change24h, change1h: pr.change1h, liquidityUsd: pr.liquidityUsd, mcapUsd: pr.mcapUsd,
      pool: pr.pool, poolDex: pr.dex, quoteSymbol: pr.quoteSymbol });
    t.seenAt = Date.now();   // when this price was read (a pass takes minutes; publish() used to stamp every row at its end)
  }
  t.volume24hEth = ethUsd ? t.volume24hUsd / ethUsd : null;
  t.liquidityEth = ethUsd && t.liquidityUsd != null ? t.liquidityUsd / ethUsd : null;
  // Pons: the supply left after burns, read on chain (honest() below sets it at read time too); until it is read, the 1B
  // minted once, and only when it fits the pool (a broken dust-pool price would give an absurd number)
  if (!(t.mcapUsd > 0) && t.launchpad === "pons" && t.priceUsd > 0) {
    const s = CHAIN.get(t.address)?.supply;
    if (s > 0) t.mcapUsd = t.priceUsd * s;
    else if (t.liquidityUsd > 0 && t.priceUsd * 1e9 <= t.liquidityUsd * 400) t.mcapUsd = t.priceUsd * 1e9;
  }
  t.mcapEth = ethUsd && t.mcapUsd != null ? t.mcapUsd / ethUsd : null;
  if (t.image) IMAGES.set(t.address, t.image);
}
const clean = (t) => { const { _main, _pick, _padAt, ...rest } = t; return rest; };
// the newest pools on Robinhood Chain across every venue (Sentry uses this to catch launches outside Pons and Uniswap)
export async function newLaunchPools() {
  const d = await gecko(`new_pools?page=1&include=base_token`);
  const inc = new Map((d.included || []).map((x) => [x.id, x]));
  return (d.data || []).map((p) => { const pr = poolRow(p, inc); return { base: pr.base, quote: pr.quote, dex: pr.dex, pool: pr.pool, createdAt: pr.createdAt, pad: padOfDex(pr.dex), liquidityUsd: pr.liquidityUsd }; });
}
// GeckoTerminal's public API is tight on rate (it answers 429 well under the documented 30/min), so the board reads
// 20 pages per pass (the busiest pools, Pons, the other Robinhood Chain launchpads, new pools) and refreshes every 8 minutes
const PAGES = [
  ...[1, 2, 3].map((p) => `pools?page=${p}&sort=h24_tx_count_desc&include=base_token`),
  ...[1, 2, 3].map((p) => `pools?page=${p}&sort=h24_volume_usd_desc&include=base_token`),
  ...[1, 2, 3].map((p) => `dexes/pons-v2/pools?page=${p}&sort=h24_volume_usd_desc&include=base_token`),
  `dexes/pons-v2-dex/pools?page=1&sort=h24_volume_usd_desc&include=base_token`,
  ...["long-xyz", "bankr-robinhood", "frontier-fun", "abyss", "goo-exchange", "clank-trade", "o1-launchpad-robinhood", "virtuals-robinhood"]
    .map((d) => `dexes/${d}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`),
  ...[1, 2].map((p) => `new_pools?page=${p}&include=base_token`),
];
async function refreshBoard() {
  if (board.refreshing) return board.refreshing;
  board.refreshing = (async () => {
    const ethUsd = await getEthUsd().catch(() => null);
    const map = new Map();
    const v4seen = [];
    let ok = 0;
    // a pass picks up where the last one stopped (the cursor is saved with the board), so restarts in quick succession
    // still walk every page instead of fetching page 1 again and never reaching the launchpads
    const start = (board.cursor || 0) % PAGES.length;
    for (let k = 0; k < PAGES.length; k++) {
      const idx = (start + k) % PAGES.length, pq = PAGES[idx];
      board.cursor = (idx + 1) % PAGES.length;
      try {
        const d = await gecko(pq);
        ok++;
        const inc = new Map((d.included || []).map((x) => [x.id, x]));
        for (const p of d.data || []) {
          const pr = poolRow(p, inc);
          fold(map, pr, ethUsd);
          if (/^0x[0-9a-f]{64}$/.test(pr.pool) && /uniswap-v4|pons-v2-dex/.test(pr.dex)) v4seen.push({ id: pr.pool, a: pr.base, b: pr.quote, liq: pr.liquidityUsd || 0 });
        }
        publish(map);
      } catch (e) { board.error = e.message; if (e.status === 429) await new Promise((r) => setTimeout(r, 30_000)); }
    }
    if (!ok) throw new Error(board.error || "GeckoTerminal did not answer");
    // $TROYA and the coins born through Troya are always on the board, even when their pools are too small for
    // GeckoTerminal's top lists ($TROYA itself was missing from Market)
    try {
      const pins = await import("./launch.mjs").then((m) => m.bornTokens()).catch(() => []);
      for (const a of pins.slice(0, 20)) {
        if (map.has(a)) continue;
        const d = await gecko(`tokens/${a}/pools?page=1&include=base_token`).catch(() => null);
        if (!d?.data?.length) continue;
        const inc = new Map((d.included || []).map((x) => [x.id, x]));
        for (const p of d.data) { const pr = poolRow(p, inc); if (pr.base === a) fold(map, pr, ethUsd); }
      }
    } catch {}
    publish(map, { full: ok >= PAGES.length * 0.75 });
    try { noteV4(v4seen); } catch {}
    board.error = null;
    // every pass ends by refreshing the rows it did not reach (off GeckoTerminal's lists) from DexScreener
    sweepStale().catch((e) => console.warn("[market] stale sweep:", e.message));
  })().finally(() => { board.refreshing = null; });
  return board.refreshing;
}
const SPARK = new Map();      // address → [[ms, priceUsd], …]
const SPARK_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "sparks.json") : null;
(function loadSparks() { if (!SPARK_FILE) return; try { const o = JSON.parse(readFileSync(SPARK_FILE, "utf8")); for (const [a, v] of Object.entries(o || {})) if (Array.isArray(v)) SPARK.set(a, v); } catch {} })();
let sparkSaveAt = 0;
function notePrices(rows) {
  const now = Date.now();
  for (const t of rows) {
    if (!(t.priceUsd > 0)) continue;
    const l = SPARK.get(t.address) || [];
    if (l.length && now - l[l.length - 1][0] < 10 * 60_000) continue;
    l.push([now, t.priceUsd]);
    while (l.length && now - l[0][0] > 26 * 3600_000) l.shift();
    SPARK.set(t.address, l);
  }
  if (SPARK_FILE && now - sparkSaveAt > 5 * 60_000) { sparkSaveAt = now; writeFile(SPARK_FILE + ".tmp", JSON.stringify(Object.fromEntries(SPARK))).then(() => rename(SPARK_FILE + ".tmp", SPARK_FILE)).catch(() => {}); }
}
// 24 points over the last 24 hours: the recorded prices, with the start and the last hour anchored by the 24h and 1h changes
function sparkOf(t) {
  if (!(t.priceUsd > 0)) return null;
  const now = Date.now(), pts = (SPARK.get(t.address) || []).filter(([ms]) => now - ms <= 24 * 3600_000);
  if (t.change24h != null && t.change24h > -100) pts.unshift([now - 24 * 3600_000, t.priceUsd / (1 + t.change24h / 100)]);
  if (t.change1h != null && t.change1h > -100 && !pts.some(([ms]) => now - ms < 70 * 60_000)) pts.push([now - 3600_000, t.priceUsd / (1 + t.change1h / 100)]);
  pts.push([now, t.priceUsd]);
  pts.sort((x, y) => x[0] - y[0]);
  if (pts.length < 2) return null;
  const out = [], step = 24 * 3600_000 / 23;
  for (let i = 0; i < 24; i++) {
    const at = now - 24 * 3600_000 + i * step;
    let j = pts.findIndex(([ms]) => ms >= at);
    if (j < 0) j = pts.length - 1;
    out.push(+pts[Math.max(0, j)][1].toPrecision(6));
  }
  return out;
}
/* socials for the board: Pons coins from the token contract (socials()), the rest from DexScreener profiles */
const SOCIALS = new Map();    // address → { twitter, telegram, website, at }
let socialsBusy = false;
async function fillSocials() {
  if (socialsBusy) return;
  socialsBusy = true;
  try {
    const now = Date.now();
    const due = [...board.rows.values()].filter((t) => !t.stock && (!SOCIALS.has(t.address) || now - SOCIALS.get(t.address).at > 6 * 3600_000))
      .sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 60);
    if (!due.length) return;
    const pons = due.filter((t) => t.launchpad === "pons");
    for (const t of pons) {
      const p = await ponsProfile(t.address).catch(() => null);
      SOCIALS.set(t.address, { twitter: p?.twitter || null, telegram: p?.telegram || null, website: p?.website || null, at: now });
    }
    const rest = due.filter((t) => t.launchpad !== "pons").map((t) => t.address);
    if (rest.length) {
      const rows = dsRows(await dsPairs(rest).catch(() => []), null);
      for (const a of rest) { const r = rows.get(a); SOCIALS.set(a, { twitter: r?.twitter || null, telegram: r?.telegram || null, website: r?.website || null, at: now }); }
    }
  } finally { socialsBusy = false; }
}
const HOLDERS = new Map();    // address → { count, top10, at }
const HOLDERS_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "holders.json") : null;
(function loadHolders() { if (!HOLDERS_FILE) return; try { for (const [a, v] of Object.entries(JSON.parse(readFileSync(HOLDERS_FILE, "utf8")) || {})) HOLDERS.set(a, v); } catch {} })();
let holdersSaveAt = 0;
// Blockscout PRO API (free plan: 5 requests a second, 100k credits a day ≈ 5,000 calls): holders and the largest wallets.
// Without a key, GeckoTerminal's token info is the fallback.
const BS_KEY = process.env.BLOCKSCOUT_API_KEY || "";
const BS = "https://api.blockscout.com/4663/api/v2";
let bsLast = 0, bsDownUntil = 0;
// when the Blockscout key runs out of credits (or is rate-limited) every call fails for a while: stop calling it for 30
// minutes and let the callers fall back (GeckoTerminal for holder counts), instead of failing every page that shows holders
const bsDown = () => Date.now() < bsDownUntil;
async function blockscout(path) {
  if (bsDown()) throw new Error("Blockscout is paused (out of credits)");
  const wait = Math.max(0, bsLast + 350 - Date.now()); bsLast = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  try { return await getJson(`${BS}${path}`, { timeout: 12000, headers: { authorization: `Bearer ${BS_KEY}` } }); }
  catch (e) {
    if (/credit|quota|rate.?limit|\b(402|429)\b/i.test(String(e.message || e))) { bsDownUntil = Date.now() + 30 * 60_000; console.warn("[blockscout] out of credits: paused 30 min, holder counts come from GeckoTerminal meanwhile"); }
    throw e;
  }
}
export const isStock = (a) => STOCK_SET.has(String(a || "").toLowerCase());
export const blockscoutApi = (p) => blockscout(p);   // shared rate-limited client (portfolio)
export const hasBlockscout = () => !!BS_KEY && !bsDown();
const LABEL = { "0x000000000000000000000000000000000000dead": "dead address (burned)", "0x0000000000000000000000000000000000000000": "zero address (burned)" };
export async function topHolders(a) {
  if (!BS_KEY) return null;
  return memo(`bs:holders:${a}`, 10 * 60_000, async () => {
    const [tok, list] = await Promise.all([blockscout(`/tokens/${a}`), blockscout(`/tokens/${a}/holders`)]);
    const supply = Number(tok?.total_supply || 0), dec = Number(tok?.decimals || 18);
    const items = (list?.items || []).slice(0, 25).map((x) => {
      const ad = x.address || {}, h = lc(ad.hash);
      const tag = ad.metadata?.tags?.find((t) => t.tagType === "name")?.name;
      return { address: ad.hash, pct: supply ? (Number(x.value) / supply) * 100 : null, balance: Number(x.value) / 10 ** dec, contract: !!ad.is_contract, label: LABEL[h] || ad.name || tag || null };
    });
    // "top 10" means wallets: pools, curves, lockers, the v4 PoolManager and burn addresses hold coins but are not holders
    const NOT_WALLET = /pool|locker|pair|curve|router|vault|escrow|manager|bonding|burn/i;
    for (const x of items) x.wallet = !(LABEL[lc(x.address)] || lc(x.address) === "0x8366a39cc670b4001a1121b8f6a443a643e40951" || (x.contract && NOT_WALLET.test(String(x.label || ""))));
    const top10 = items.filter((x) => x.wallet).slice(0, 10).reduce((s, x) => s + (x.pct || 0), 0);
    return { count: tok?.holders_count != null ? Number(tok.holders_count) : null, top10, top10Of: "wallets (pools, lockers and burn addresses left out)", holders: items };
  });
}
export async function fetchHolders(a, { hi = false } = {}) {
  let v = null;
  if (BS_KEY && !bsDown()) {
    const t = await topHolders(a).catch(() => null);
    if (t) v = { count: t?.count ?? null, top10: t?.top10 != null ? +t.top10.toFixed(2) : null, at: Date.now() };
  }
  if (!v) v = await geckoHolders(a, { hi });
  HOLDERS.set(a, v);
  const row = board.rows.get(a);
  if (row) { row.holders = v.count; row.top10Pct = v.top10; }
  if (HOLDERS_FILE && Date.now() - holdersSaveAt > 60_000) { holdersSaveAt = Date.now(); writeFile(HOLDERS_FILE + ".tmp", JSON.stringify(Object.fromEntries(HOLDERS))).then(() => rename(HOLDERS_FILE + ".tmp", HOLDERS_FILE)).catch(() => {}); }
  return v;
}
async function geckoHolders(a, { hi = false } = {}) {
  const d = await gecko(`tokens/${a}/info`, { hi });
  const h = d?.data?.attributes?.holders;
  return { count: h?.count != null ? Number(h.count) : null, top10: h?.distribution_percentage?.top_10 != null ? Number(h.distribution_percentage.top_10) : null, at: Date.now() };
}
let holdersBusy = false;
let geckoHoldersAt = 0;
async function holdersTick() {
  // GeckoTerminal fallback: users and the board first, but never starved (with Blockscout paused the column went all "–")
  const fallback = !BS_KEY || bsDown();
  if (holdersBusy || (fallback && (gq.hi.length || gq.lo.length > 1) && Date.now() - geckoHoldersAt < 30_000)) return;
  if (fallback) geckoHoldersAt = Date.now();
  const now = Date.now();
  // every coin on the board, most traded first, each every 6 hours. Blockscout PRO Builder (19 Nov 2026: 100M credits a
  // month, 15 req/s) covers this with room for the token pages, Portfolio, Owl and Aegis; BS_HOLDERS_TOP caps it if needed
  const top = Number(process.env.BS_HOLDERS_TOP || 0);
  const ranked = [...board.rows.values()].sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  const next = (top > 0 ? ranked.slice(0, top) : ranked).filter((t) => { const h = HOLDERS.get(t.address); return !h || now - h.at > 6 * 3600_000; })[0];
  if (!next) return;
  holdersBusy = true;
  try { await fetchHolders(next.address); } catch { HOLDERS.set(next.address, { ...(HOLDERS.get(next.address) || {}), at: now - 5 * 3600_000 }); } finally { holdersBusy = false; }
}
setInterval(() => holdersTick().catch(() => {}), BS_KEY ? 4_000 : 20_000).unref();
const holdersOf = (a) => HOLDERS.get(a) || null;
/* Troya picks: a read of live data, never advice. A coin needs real money in its pools and real trading, then earns
   points for buyers outnumbering sellers, holders spread out, volume its money can carry (not wash trading), listed
   socials and a day that is not a collapse. Each pick says why, in a few words.
   Liquidity here is the money side only (realLiquidityUsd: ETH, USDG or stock tokens): MOW was picked as an "$18.8M
   pool" on 0.81 ETH (20 Nov 2026). A coin whose money side is not read yet is not picked. */
const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`);
function pickCoins(rows) {
  const out = [];
  for (const t of rows) {
    const liq = t.realLiquidityUsd, vol = t.volume24hUsd || 0, tx = t.txns24h || 0, ch = t.change24h;
    if (!(liq >= 10_000) || tx < 40 || vol < 2_000 || ch == null || ch <= -40) continue;
    const turn = vol / liq;
    if (turn > 25) continue;                                   // more volume than its money could carry: likely wash trading
    const h = HOLDERS.get(t.address), soc = SOCIALS.get(t.address);
    if (h?.top10 != null && h.top10 > 80) continue;            // a handful of wallets own it
    let score = Math.log10(liq) * 2 + Math.min(3, Math.log10(tx));
    const why = [];
    const buys = t.buys24h, sells = t.sells24h;
    if (buys != null && sells != null && buys + sells >= 30) {
      const share = buys / (buys + sells);
      score += (share - 0.5) * 6;
      if (share >= 0.55) why.push(`${Math.round(share * 100)}% of trades are buys`);
    }
    if (turn >= 0.6 && turn <= 12) { score += 1.5; }          // the old 0.3-6 band on the two-sided pool, which is about twice the money side
    if (h?.count != null) {
      score += Math.min(3, Math.log10(Math.max(1, h.count)) - 1.5);
      if (h.top10 != null) score += h.top10 < 45 ? 1.5 : h.top10 > 65 ? -1.5 : 0;
      if (h.count >= 150) why.push(`${h.count.toLocaleString("en-US")} holders${h.top10 != null && h.top10 < 55 ? `, top 10 hold ${Math.round(h.top10)}%` : ""}`);
    }
    if (soc && (soc.twitter || soc.telegram || soc.website)) { score += 1; }
    if (ch >= 10) { score += Math.min(2, ch / 25); why.push(`up ${Math.round(ch)}% today`); } else if (ch <= -15) score -= 1;
    why.unshift(`${money(liq)} real liquidity, ${money(vol)} traded`);
    if (soc && (soc.twitter || soc.telegram) && why.length < 3) why.push("lists its socials");
    out.push({ t, score });
    t._pick = { score: +score.toFixed(2), why: why.slice(0, 3) };
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20).map((x) => x.t);
}
const cleanLink = (u) => { try { const x = new URL(/^https?:/i.test(u) ? u : `https://${u}`); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const socialOf = (a) => { const s = SOCIALS.get(a); if (!s) return null; const tw = s.twitter ? (s.twitter.startsWith("http") ? s.twitter : `https://x.com/${String(s.twitter).replace(/^@/, "")}`) : null; const tg = s.telegram ? (s.telegram.startsWith("http") ? s.telegram : `https://t.me/${String(s.telegram).replace(/^@/, "")}`) : null; const o = { x: cleanLink(tw || ""), telegram: cleanLink(tg || ""), website: s.website ? cleanLink(s.website) : null }; return o.x || o.telegram || o.website ? o : null; };

function publish(map, { full = false } = {}) {
  const now = Date.now();
  try { notePrices(map.values()); } catch {}
  setTimeout(() => fillSocials().catch(() => {}), 1000);
  for (const t of map.values()) t.seenAt ||= now;        // rows this pass reached (fold() stamps when each price was read)
  // keep tokens from earlier passes that this pass did not reach (pages shift as volume moves); after a complete pass
  // they go once unseen for 30 minutes, while a pass is still running or was cut short by 429s they stay up to 6 hours
  const keep = full ? 30 * 60_000 : BOARD_MAX_AGE;
  const next = new Map(map);
  for (const [a, t] of board.rows) if (!next.has(a) && now - (t.seenAt || 0) < keep) next.set(a, t);
  board.rows = next;
  board.updatedAt = now;
  board.volumeUsd = [...next.values()].filter((t) => !t.stock).reduce((s, t) => s + (t.volume24hUsd || 0), 0);
  saveBoard();
}
let boardTimer = null;
function startBoard() {
  if (boardTimer) return;
  refreshBoard().catch((e) => console.warn("[market] board:", e.message));
  boardTimer = setInterval(() => refreshBoard().catch((e) => console.warn("[market] board:", e.message)), 8 * 60_000);
  boardTimer.unref?.();
  // between passes: Pons prices and supply on chain every minute, the money side of pools every 30 s (8 coins), and the
  // stale-row sweep every 4 minutes as well as at the end of each pass (a pass can run long when GeckoTerminal answers 429)
  setTimeout(() => chainTick().catch(() => {}), 2_000).unref?.();
  setInterval(() => chainTick().catch((e) => console.warn("[market] chain prices:", e.message)), 60_000).unref?.();
  setInterval(() => realTick().catch(() => {}), 30_000).unref?.();
  setTimeout(() => sweepStale().catch(() => {}), 20_000).unref?.();
  setInterval(() => sweepStale().catch((e) => console.warn("[market] stale sweep:", e.message)), 4 * 60_000).unref?.();
}
async function ensureBoard() {
  if (board.rows.size) return;
  startBoard();
  // first request after boot: wait for the first page or two
  for (let i = 0; i < 40 && !board.rows.size; i++) await new Promise((r) => setTimeout(r, 500));
  if (!board.rows.size) throw httpErr(503, `The Robinhood Chain board is still loading${board.error ? ` (${board.error})` : ""}. Try again in a few seconds.`);
}
/** index row for a token (swap quotes read its pool depth; callouts, Portfolio and Watchfire its price): a copy with the
 *  same honest price, market cap and real liquidity the Market and the coin page show */
export const indexRow = (address) => { const t = board.rows.get(lc(address)); return t ? honest(t) : null; };

function cleanOpts(opts = {}) {
  let sort = String(opts.sort || "volume").toLowerCase();
  sort = SORT_ALIAS[sort] || sort;
  if (!SORTS.has(sort)) sort = "volume";
  const dir = String(opts.dir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  let launchpad = String(opts.launchpad || "all").toLowerCase();
  if (!/^[a-z0-9-]{1,20}$/.test(launchpad)) launchpad = "all";
  const q = String(opts.q || "").trim().slice(0, 64);
  const offset = Math.max(0, Math.min(100000, parseInt(opts.offset, 10) || 0));
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 50));
  const tradable = !(opts.tradable === false || opts.tradable === "0" || opts.tradable === 0);
  const cat = ["picks", "trending", "new", "bonding"].includes(String(opts.cat || "")) ? String(opts.cat) : "all";
  return { sort, dir, launchpad, q, offset, limit, tradable, cat };
}
// "liquidity" sorts by the money side (what a seller can take out), never by the two-sided pool total
const SORT_KEY = { volume: "volume24hUsd", mcap: "mcapUsd", change: "change24h", liquidity: "realLiquidityUsd", newest: "createdAt", price: "priceUsd", txns: "txns24h", holders: "holders" };

/* ---------------- one honest price, market cap and liquidity per coin ---------------- */
// Real liquidity (20 Nov 2026). A pool's "liquidity" counts both sides at the pool's own price, so a coin minted with a
// made-up price shows millions of liquidity and market cap while the pool holds a few dollars of real money (same-ticker
// PONS / CASHCAT / AI / USDG pools born 19 Nov: $35M "liquidity" on about $8k of USDG; MOW $18.6M on 0.81 ETH). The money
// side, ETH, WETH, USDG, cbBTC or a Robinhood stock token, summed over the coin's pools, is what a seller can actually
// take out. A side that is another memecoin is not money. 0 = pools but no money side; null = not read yet.
const MONEY = new Set([lc(RH.weth), lc(RH.usdg), CBBTC, "0x0000000000000000000000000000000000000000"]);
const isMoney = (a) => MONEY.has(a) || STOCK_SET.has(a);
export function realFromPairs(pairs, address, ethUsd) {
  const a = lc(address);
  let usd = 0, n = 0, seen = 0;
  for (const p of pairs || []) {
    const b = lc(p.baseToken?.address), q = lc(p.quoteToken?.address), L = p.liquidity || {};
    if (b !== a && q !== a) continue;
    seen++;
    const total = Number(L.usd), pu = Number(p.priceUsd), pn = Number(p.priceNative);
    if (!(total > 0)) continue;
    let side = null;
    if (b === a && isMoney(q)) {
      // the quote amount at the quote's own dollar price (priceUsd / priceNative); without it, the pool less the coin side
      const qUsd = pu > 0 && pn > 0 ? pu / pn : q === lc(RH.usdg) ? 1 : ethUsd && (q === lc(RH.weth) || /^0x0{40}$/.test(q)) ? ethUsd : null;
      side = L.quote != null && qUsd ? Number(L.quote) * qUsd : L.base != null && pu > 0 ? total - Number(L.base) * pu : null;
    } else if (q === a && isMoney(b)) {
      side = L.base != null && pu > 0 ? Number(L.base) * pu : null;   // the coin is the quote here: the base is the money
    }
    if (side == null || !Number.isFinite(side)) continue;
    usd += Math.max(0, Math.min(total, side)); n++;
  }
  return n ? usd : seen ? 0 : null;
}
// on a Pons curve the money is what was raised on it (read on chain); elsewhere the DexScreener read above
const realLiqOf = (a, c = CHAIN.get(a)) => (c?.onCurve && c.realUsd != null && Date.now() - c.at < 30 * 60_000 ? c.realUsd : REAL.get(a)?.usd ?? null);

// Pons coins on chain: the curve's reserves while on the curve, the Uniswap v4 pool's sqrtPriceX96 after graduation (as
// /api/flywheel reads $TROYA), and totalSupply minus what sits at 0x...dEaD. Every Pons coin on the board, once a
// minute, in a few Multicall3 reads; the coin page reads its own coin again when it opens.
const CHAIN_FRESH = 3 * 60_000;
const DEAD = "0x000000000000000000000000000000000000dead";
const ERC = new Interface(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const CURVE = new Interface(["function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)", "function realQuoteReserve() view returns (uint256)", "function graduated() view returns (bool)"]);
const PMI = new Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);
// a v4 pool's slot0 in the PoolManager's storage (the pools mapping sits at slot 6)
const slot0Of = (poolId) => toBeHex(BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6]))), 32);
async function multi(calls) {   // [{ target, data }] -> [returnData | null], 150 reads per eth_call
  const out = [];
  for (let i = 0; i < calls.length; i += 150) {
    const part = calls.slice(i, i + 150);
    try {
      const data = RHI.mc.encodeFunctionData("aggregate3", [part.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
      const raw = await rhRpc("robinhood", "eth_call", [{ to: RH.multicall3, data }, "latest"], { timeoutMs: 12000 });
      const [res] = RHI.mc.decodeFunctionResult("aggregate3", raw);
      out.push(...res.map((r) => (r.success && r.returnData && r.returnData !== "0x" ? r.returnData : null)));
    } catch { out.push(...part.map(() => null)); }
  }
  return out;
}
// the pair's dollar price: ETH, USDG, a Robinhood stock token (many Pons coins pair with GME, NVDA, GLD...: their pool
// price from the stock list) or a coin on the board
const pairUsd = (pair, ethUsd, stockPx) => (/^0x0{40}$/.test(pair) || pair === lc(RH.weth) ? ethUsd : pair === lc(RH.usdg) ? 1
  : stockPx?.get(pair) ?? CHAIN.get(pair)?.priceUsd ?? board.rows.get(pair)?.priceUsd ?? null);
const staticDue = (a) => { const s = PSTATIC.get(a); return !s || (s.none ? Date.now() - s.at > 6 * 3600_000 : !s.graduated && Date.now() - s.at > 30 * 60_000); };
async function loadStatic(a) {
  const s = await ponsState(a).catch(() => undefined);
  if (s === undefined) return;                                  // the RPC did not answer: keep what was known
  if (!s) { PSTATIC.set(a, { none: true, at: Date.now() }); return; }
  PSTATIC.set(a, { curve: s.curve, pair: lc(s.pair), pd: Number(s.pairDecimals ?? 18), graduated: !!(s.graduated && s.poolId), poolId: s.poolId || null,
    tokenFirst: s.v4Key ? lc(s.v4Key.c0) === a : null, at: Date.now() });
}
async function readChain(addrs, { statics = 40 } = {}) {
  const ethUsd = await getEthUsd().catch(() => null);
  const list = [...new Set(addrs.map(lc))].filter((a) => ADDR_RE.test(a));
  const due = list.filter(staticDue).slice(0, statics);
  for (let i = 0; i < due.length; i += 4) await Promise.all(due.slice(i, i + 4).map(loadStatic));
  const calls = [], idx = [];
  for (const a of list) {
    const st = PSTATIC.get(a);
    if (!st || st.none) continue;
    const at = calls.length;
    calls.push({ target: a, data: ERC.encodeFunctionData("totalSupply") }, { target: a, data: ERC.encodeFunctionData("balanceOf", [DEAD]) });
    if (st.graduated) calls.push({ target: RH.poolManager, data: PMI.encodeFunctionData("extsload", [slot0Of(st.poolId)]) });
    else calls.push({ target: st.curve, data: CURVE.encodeFunctionData("getReserves") }, { target: st.curve, data: CURVE.encodeFunctionData("realQuoteReserve") }, { target: st.curve, data: CURVE.encodeFunctionData("graduated") });
    idx.push([a, st, at]);
  }
  if (!calls.length) return;
  const stockPx = idx.some(([, st]) => STOCK_SET.has(st.pair)) ? new Map(((await getStocks().catch(() => null))?.stocks || []).filter((x) => x.priceUsd > 0).map((x) => [x.address, x.priceUsd])) : null;
  const res = await multi(calls);
  const now = Date.now();
  for (const [a, st, at] of idx) {
    const dec = (k, ifc, fn) => { try { return res[at + k] ? ifc.decodeFunctionResult(fn, res[at + k]) : null; } catch { return null; } };
    const ts = dec(0, ERC, "totalSupply")?.[0], dead = dec(1, ERC, "balanceOf")?.[0];
    const supply = ts != null && ts > 0n ? Number(ts - (dead != null && dead <= ts ? dead : 0n)) / 1e18 : null;   // Pons coins have 18 decimals
    const pUsd = pairUsd(st.pair, ethUsd, stockPx);
    let inPair = null, onCurve = false, realUsd = null;
    if (st.graduated) {
      let w = 0n; try { w = res[at + 2] ? BigInt(PMI.decodeFunctionResult("extsload", res[at + 2])[0]) : 0n; } catch {}
      const sq = w & ((1n << 160n) - 1n);
      if (sq > 0n) {
        // price = token1 per token0 in raw units; the coin has 18 decimals, its pair pd
        const sp = Number(sq) / 2 ** 96, r = sp * sp;
        inPair = st.tokenFirst ? r * 10 ** (18 - st.pd) : 1 / (r * 10 ** (st.pd - 18));
      }
    } else {
      const rv = dec(2, CURVE, "getReserves"), rq = dec(3, CURVE, "realQuoteReserve")?.[0], g = dec(4, CURVE, "graduated")?.[0];
      if (g) PSTATIC.delete(a);                                 // it graduated since the last read: its pool is read next round
      else if (rv && rv[1] > 0n) {
        inPair = (Number(rv[0]) / 10 ** st.pd) / (Number(rv[1]) / 1e18);
        onCurve = true;
        if (rq != null && pUsd) realUsd = (Number(rq) / 10 ** st.pd) * pUsd;
      }
    }
    const priceUsd = inPair > 0 && Number.isFinite(inPair) && pUsd ? inPair * pUsd : null;
    const prev = CHAIN.get(a);
    CHAIN.set(a, { priceUsd, priceEth: priceUsd && ethUsd ? priceUsd / ethUsd : null, supply: supply > 0 ? supply : prev?.supply ?? null, onCurve, realUsd, at: now });
  }
  while (CHAIN.size > 3000) CHAIN.delete(CHAIN.keys().next().value);
  while (PSTATIC.size > 5000) PSTATIC.delete(PSTATIC.keys().next().value);
}
let chainBusy = false;
async function chainTick() {
  if (chainBusy || !board.rows.size) return;
  chainBusy = true;
  try {
    const pons = [...board.rows.values()].filter((t) => t.launchpad === "pons" && !t.stock).sort((x, y) => (y.volume24hUsd || 0) - (x.volume24hUsd || 0)).slice(0, 300);
    await readChain(pons.map((t) => t.address));
  } finally { chainBusy = false; }
}

// honest(row) -> a copy with the freshest price (a Pons coin's chain price while it is fresh, else the row, which the
// sweep refreshes from DexScreener once it is PRICE_STALE old), priceAt (when that price was read), the market cap on the
// supply left after burns for Pons coins, and realLiquidityUsd next to the two-sided liquidityUsd
function honest(t, ethUsd = ETH_LAST) {
  const r = { ...t };
  r.priceAt = Math.max(t.priceAt || 0, t.seenAt || 0) || null;
  r.priceSource = t.priceSource || (t.source === "DexScreener" ? "DexScreener" : "GeckoTerminal");
  const c = CHAIN.get(t.address);
  if (c?.priceUsd > 0 && Date.now() - c.at < CHAIN_FRESH) {
    // the 24h and 1h changes were measured to the indexer's price: keep where they started, end them at the chain price
    const p0 = r.priceUsd;
    if (p0 > 0) for (const k of ["change24h", "change1h"]) if (r[k] != null && r[k] > -100) r[k] = +((c.priceUsd / (p0 / (1 + r[k] / 100)) - 1) * 100).toFixed(2);
    r.priceUsd = c.priceUsd;
    r.priceEth = c.priceEth ?? (ethUsd ? c.priceUsd / ethUsd : r.priceEth);
    r.priceAt = c.at;
    r.priceSource = c.onCurve ? "Pons curve, on chain" : "Uniswap v4 pool, on chain";
  }
  if (c?.supply > 0 && r.priceUsd > 0) { r.supply = c.supply; r.mcapUsd = r.priceUsd * c.supply; r.mcapEth = ethUsd ? r.mcapUsd / ethUsd : null; }
  const real = realLiqOf(t.address, c);
  r.realLiquidityUsd = real;
  r.realLiquidityEth = real != null && ethUsd ? real / ethUsd : null;
  return r;
}

// a row the indexer has not refreshed for PRICE_STALE takes DexScreener's numbers, in place (the Market, the Desk and the
// coin page then show the same thing): the pair of the row's own main pool when DexScreener lists it, otherwise its
// deepest pair, and only when that is about as deep (a stray dust pair's price can be far off). Structure (pool, venue,
// launchpad, route) stays as the index has it; the two-sided liquidity stays the main pool's, as GeckoTerminal reports.
function freshen(row, pairs, ethUsd, now = Date.now()) {
  const a = row.address;
  const mine = (pairs || []).filter((p) => lc(p.baseToken?.address) === a && fnum(p.priceUsd) > 0);
  if (!mine.length) return false;
  let p = mine.find((x) => lc(x.pairAddress) === row.pool);
  if (!p) {
    // the pair with the most money in it (a made-up price inflates the two-sided total, never the money side)
    p = mine.map((x) => ({ x, m: realFromPairs([x], a, ethUsd) || 0 })).sort((u, v) => v.m - u.m || (v.x.liquidity?.usd || 0) - (u.x.liquidity?.usd || 0))[0].x;
    if ((p.liquidity?.usd || 0) < (row.liquidityUsd || 0) * 0.5) return false;
  }
  const sum = dsRows(mine, ethUsd).get(a);
  const p0 = row.priceUsd, p1 = fnum(p.priceUsd), tx = p.txns?.h24 || {};
  const mcap = fnum(p.marketCap) ?? fnum(p.fdv) ?? (row.mcapUsd > 0 && p0 > 0 ? row.mcapUsd * (p1 / p0) : null);
  Object.assign(row, {
    priceUsd: p1, priceEth: ethUsd ? p1 / ethUsd : row.priceEth, change24h: fnum(p.priceChange?.h24), change1h: fnum(p.priceChange?.h1),
    liquidityUsd: fnum(p.liquidity?.usd) ?? row.liquidityUsd, mcapUsd: mcap,
    volume24hUsd: sum?.volume24hUsd ?? fnum(p.volume?.h24) ?? row.volume24hUsd,
    buys24h: sum?.buys24h ?? tx.buys ?? row.buys24h, sells24h: sum?.sells24h ?? tx.sells ?? row.sells24h,
    priceAt: now, priceSource: "DexScreener",
  });
  row.txns24h = (row.buys24h || 0) + (row.sells24h || 0);
  row.volume24hEth = ethUsd ? (row.volume24hUsd || 0) / ethUsd : null;
  row.liquidityEth = ethUsd && row.liquidityUsd != null ? row.liquidityUsd / ethUsd : null;
  row.mcapEth = ethUsd && row.mcapUsd != null ? row.mcapUsd / ethUsd : null;
  return true;
}
// the same refresh from the row's own main pool on GeckoTerminal (pools/multi): price, changes, the pool's liquidity and
// market cap, and that pool's share of the 24h volume (the other pools' volume and the trade counts wait for the next pass)
function freshenPool(row, pr, ethUsd, now = Date.now()) {
  if (!(pr.priceUsd > 0)) return false;
  const trades = (pr.buys || 0) + (pr.sells || 0);
  const vol = pr.volumeUsd > (pr.liquidityUsd || 0) * 300 || (!STOCK_SET.has(row.address) && pr.volumeUsd > 10_000 && (trades === 0 || pr.volumeUsd / trades > 50_000)) ? 0 : pr.volumeUsd || 0;
  const entry = (row.pools || []).find((x) => x.pool === pr.pool);
  if (entry) { row.volume24hUsd = Math.max(0, (row.volume24hUsd || 0) - (entry.volumeUsd || 0) + vol); entry.volumeUsd = vol; entry.liquidityUsd = pr.liquidityUsd; }
  const p0 = row.priceUsd;
  Object.assign(row, { priceUsd: pr.priceUsd, priceEth: pr.priceEth ?? (ethUsd ? pr.priceUsd / ethUsd : row.priceEth), change24h: pr.change24h, change1h: pr.change1h,
    liquidityUsd: pr.liquidityUsd ?? row.liquidityUsd, mcapUsd: pr.mcapUsd || (row.mcapUsd > 0 && p0 > 0 ? row.mcapUsd * (pr.priceUsd / p0) : row.mcapUsd), priceAt: now, priceSource: "GeckoTerminal" });
  row.volume24hEth = ethUsd ? (row.volume24hUsd || 0) / ethUsd : null;
  row.liquidityEth = ethUsd && row.liquidityUsd != null ? row.liquidityUsd / ethUsd : null;
  row.mcapEth = ethUsd && row.mcapUsd != null ? row.mcapUsd / ethUsd : null;
  return true;
}
const rowAge = (t, now = Date.now()) => now - Math.max(t.priceAt || 0, t.seenAt || 0);
// rows older than PRICE_STALE from DexScreener, 30 coins a call (53 of 290 rows were 60-83 minutes old on 20 Nov while
// the footer said "updated just now"). The batch answer has one pair per coin: a coin whose main pool it skipped reads
// its own pair list. Pons coins on their curve are priced on chain, and come here only when that read is missing.
let sweepBusy = false;
async function sweepStale() {
  if (sweepBusy || !board.rows.size) return;
  sweepBusy = true;
  try {
    const now = Date.now(), ethUsd = await getEthUsd().catch(() => null);
    // a coin on its Pons curve is priced on chain; only when that read is missing does its curve pool come from GeckoTerminal
    const onCurve = (t) => t.poolDex === "pons-v2";
    const chainFresh = (t) => { const c = CHAIN.get(t.address); return c?.priceUsd > 0 && now - c.at < CHAIN_FRESH; };
    const all = [...board.rows.values()].filter((t) => !t.stock && rowAge(t, now) > PRICE_STALE && !(onCurve(t) && chainFresh(t)))
      .sort((x, y) => (y.volume24hUsd || 0) - (x.volume24hUsd || 0)).slice(0, 450);
    if (!all.length) return;
    const old = all.filter((t) => !onCurve(t));
    const pairs = old.length ? await dsPairs(old.map((t) => t.address)).catch(() => []) : [];
    const listed = new Set(pairs.map((p) => lc(p.baseToken?.address)));
    const miss = [...old.filter((t) => !freshen(t, pairs, ethUsd, now)), ...all.filter(onCurve)];
    for (const t of miss.filter((x) => listed.has(x.address)).slice(0, 30)) {
      const ps = await dsTokenPairs(t.address).catch(() => null);
      if (!ps) continue;
      freshen(t, ps, ethUsd, Date.now());
      if (ps.length) REAL.set(t.address, { usd: realFromPairs(ps, t.address, ethUsd), at: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
    }
    // DexScreener does not list every venue (Virtuals, O1, Frontier, Clank pools: 33 of 86 stale rows on 20 Nov): the rest
    // read their own main pool from GeckoTerminal, 30 pools a call, at background priority and at most 2 calls a sweep
    const left = miss.filter((t) => rowAge(t) > PRICE_STALE && /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(t.pool || "")).slice(0, 60);
    for (let i = 0; i < left.length; i += 30) {
      const part = left.slice(i, i + 30);
      const d = await gecko(`pools/multi/${part.map((t) => t.pool).join(",")}?include=base_token`).catch(() => null);
      if (!d?.data?.length) continue;
      const inc = new Map((d.included || []).map((x) => [x.id, x]));
      const byPool = new Map(d.data.map((p) => { const pr = poolRow(p, inc); return [pr.pool, pr]; }));
      for (const t of part) { const pr = byPool.get(t.pool); if (pr && pr.base === t.address) freshenPool(t, pr, ethUsd); }
    }
    board.volumeUsd = [...board.rows.values()].filter((t) => !t.stock).reduce((s, t) => s + (t.volume24hUsd || 0), 0);
    saveBoard();
  } finally { sweepBusy = false; }
}
// the money side of each coin from DexScreener's full pair list: a coin that could be a pick every 10 minutes, the rest
// every 30, 8 coins every 30 seconds (about 16 calls a minute against DexScreener's 300)
let realBusy = false;
async function realTick() {
  if (realBusy || !board.rows.size) return;
  realBusy = true;
  try {
    const now = Date.now(), ethUsd = await getEthUsd().catch(() => null);
    const cand = (t) => (t.liquidityUsd || 0) >= 10_000 && (t.txns24h || 0) >= 40 && (t.volume24hUsd || 0) >= 2_000;
    const due = [...board.rows.values()].filter((t) => !t.stock && t.poolDex !== "pons-v2")
      .map((t) => { const r = REAL.get(t.address); return { t, age: r ? now - r.at : Infinity, c: cand(t) }; })
      .filter((x) => x.age > (x.c ? 10 : 30) * 60_000)
      .sort((x, y) => (y.age === Infinity) - (x.age === Infinity) || y.c - x.c || (y.t.volume24hUsd || 0) - (x.t.volume24hUsd || 0)).slice(0, 8);
    for (const { t } of due) {
      const ps = await dsTokenPairs(t.address).catch(() => null);
      if (ps) REAL.set(t.address, { usd: realFromPairs(ps, t.address, ethUsd), at: Date.now() });
      await new Promise((r) => setTimeout(r, 400));
    }
    while (REAL.size > 4000) REAL.delete(REAL.keys().next().value);
  } finally { realBusy = false; }
}
// A young or barely held coin whose market cap is over 2000x the money in its pools is sorted after the rest. Names stay
// free and nothing is labelled (owner, 18 Nov).
const unbacked = (t) => {
  const real = t.realLiquidityUsd, cap = Number(t.mcapUsd) || 0;
  if (real == null || cap < 100_000 || cap <= real * 2000) return false;
  const holders = holdersOf(t.address)?.count;
  return (t.createdAt && Date.now() - t.createdAt < 7 * 86400_000) || (holders != null && holders < 1000);
};

// when each coin was born (its creation block, tokenage.mjs), as the coin page shows its age: the board's createdAt is the
// main pool's date, so a coin that graduated to Uniswap read 3 days old in a list and 5 on its page ($TROYA, 20 Nov).
// Answered from the cache; unknown births are looked up in the background (a later read has them).
let ageMod = null;
async function bornOf(addrs) {
  const m = await (ageMod ||= import("./tokenage.mjs").catch(() => null));
  if (!m?.bornAt) return addrs.map(() => null);
  return Promise.all(addrs.map((a) => m.bornAt(a, { waitMs: 0 }).catch(() => null)));
}
// getRobinhoodTokens({q, launchpad, sort, dir, offset, limit, tradable}) → {tokens,total,counts,updatedAt,stale,ethUsd,source,...}
export async function getRobinhoodTokens(opts = {}) {
  const o = cleanOpts(opts);
  await ensureBoard();
  if (Date.now() - board.updatedAt > 10 * 60_000) refreshBoard().catch(() => {});
  const ethUsd = await getEthUsd().catch(() => null);
  // every row as the coin page shows it: chain price for Pons coins, supply after burns, the money side of its pools
  let all = [...board.rows.values()].filter((t) => !t.stock).map((t) => honest(t, ethUsd));
  // every coin is listed alike, whatever its ticker (owner, 18 Nov: no "copy" marks, as on other launchers)
  if (o.q && ADDR_RE.test(o.q) && !board.rows.has(lc(o.q))) {
    const r = await getRobinhoodToken(o.q).catch(() => null);
    if (r?.token) all.push(r.token);
  }
  const ql = o.q.toLowerCase().replace(/^\$/, "");
  if (ql) all = all.filter((t) => t.address === ql || t.symbol.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql));
  const routable = all.filter((t) => t.tradable);
  const base = o.tradable ? routable : all;
  const counts = { all: base.length };
  for (const t of base) counts[t.launchpad] = (counts[t.launchpad] || 0) + 1;
  let rows = o.launchpad === "all" ? base : base.filter((t) => t.launchpad === o.launchpad);
  // categories: Trending (real trading today), New (born in the last 72 hours, off a bonding curve: graduated or
  // launched straight into a pool), Bonding (still on a Pons curve)
  const onCurve = (t) => t.poolDex === "pons-v2";
  const isNew = (t) => t.createdAt && Date.now() - t.createdAt < 72 * 3600_000 && !onCurve(t);
  const isTrend = (t) => (t.volume24hUsd || 0) >= 1000 && (t.txns24h || 0) >= 20;
  const picked = pickCoins(rows);
  const catCounts = { all: rows.length, picks: picked.length, trending: rows.filter(isTrend).length, new: rows.filter(isNew).length, bonding: rows.filter(onCurve).length };
  if (o.cat === "picks") rows = picked;
  else if (o.cat === "trending") rows = rows.filter(isTrend);
  else if (o.cat === "new") rows = rows.filter(isNew);
  else if (o.cat === "bonding") rows = rows.filter(onCurve);
  const hidden = o.tradable ? (o.launchpad === "all" ? all.length - routable.length : all.filter((t) => t.launchpad === o.launchpad && !t.tradable).length) : 0;
  // how many coins of this listing carry a price read in the last 10 minutes (the footer said "updated just now" while 53
  // of 290 rows were an hour old); each row also carries its own priceAt
  const now = Date.now();
  const fresh10 = base.filter((t) => t.priceAt && now - t.priceAt <= 10 * 60_000).length;
  const k = SORT_KEY[o.sort];
  const sgn = o.dir === "asc" ? 1 : -1;
  if (k === "holders") for (const t of rows) t.holders = HOLDERS.get(t.address)?.count ?? null;
  if (o.sort !== "picks") rows = [...rows].sort((a, b) => {
    const ua = unbacked(a), ub = unbacked(b);
    if (ua !== ub) return ua ? 1 : -1;
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * sgn;
  });
  const page = rows.slice(o.offset, o.offset + o.limit);
  const births = await bornOf(page.map((t) => t.address));
  return {
    catCounts, cat: o.cat,
    tokens: page.map((t, i) => ({ ...clean(t), bornAt: births[i] ?? null, pick: t._pick || undefined, spark: sparkOf(t), socials: socialOf(t.address), holders: holdersOf(t.address)?.count ?? null, top10Pct: holdersOf(t.address)?.top10 ?? null })), total: rows.length, counts, hiddenTotal: hidden,
    volume24hUsd: board.volumeUsd, volume24hEth: ethUsd ? board.volumeUsd / ethUsd : null,
    offset: o.offset, limit: o.limit, sort: o.sort, dir: o.dir, launchpad: o.launchpad,
    updatedAt: board.updatedAt, fresh10, freshOf: base.length, now, stale: !!board.error, notice: board.error ? `Last refresh failed (${board.error}); showing the previous board.` : null,
    source: "GeckoTerminal + DexScreener + Robinhood Chain RPC", ethUsd,
  };
}

// getRobinhoodToken(address) → {token, pons, links, sources}  (fast: board row or DexScreener + Pons read on chain)
// the hub tokens (WETH, USDG) are left out of the coin board on purpose; their pages get a known profile at once instead
// of the slow board / DexScreener / GeckoTerminal search (it took 20-76 s and ended in "not on the board")
async function hubToken(a) {
  const ethUsd = await getEthUsd().catch(() => null);
  const usdg = a === lc(RH.usdg);
  const token = { address: a, symbol: usdg ? "USDG" : "WETH", name: usdg ? "Global Dollar" : "Wrapped Ether", decimals: usdg ? 6 : 18, hub: true,
    priceUsd: usdg ? 1 : ethUsd, priceEth: usdg ? (ethUsd ? 1 / ethUsd : null) : 1, launchpad: "other", tradable: true, pools: [],
    image: usdg ? "/img/logos/usdg.png" : "/img/logos/eth-color.svg",
    description: usdg ? "Global Dollar (USDG), the Paxos-issued dollar stablecoin used as a base pair across Robinhood Chain. Its issuer can freeze and pause it."
      : "Wrapped Ether (WETH): ETH as a token, always 1:1 with ETH, used by pools on Robinhood Chain.", website: usdg ? "https://www.paxos.com/usdg" : null };
  return { token, pons: null, ethUsd, links: { pons: null, dexscreener: `https://dexscreener.com/robinhood/${a}`, geckoterminal: `https://www.geckoterminal.com/robinhood/tokens/${a}`, explorer: `https://robinhoodchain.blockscout.com/token/${a}` },
    sources: ["Known token"], updatedAt: Date.now() };
}
export async function getRobinhoodToken(address) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const a = lc(address);
  // strict ttl: The Record, the registry and the oracle take a coin's price from here at the moment they record it
  if (a === lc(RH.usdg) || a === lc(RH.weth)) return memo(`rh:hub:${a}`, 60_000, () => hubToken(a), { swr: 0 });
  return memo(`rh:token:${a}`, 30_000, async () => {
    const ethUsd = await getEthUsd().catch(() => null);
    // every pool of the coin (token-pairs); the one-pair batch endpoint only when that list is unavailable
    const [ds, ps, prof] = await Promise.allSettled([dsTokenPairs(a).catch(() => dsPairs([a])), ponsState(a), ponsProfile(a)]);
    const pairs = ds.status === "fulfilled" ? ds.value : [];
    const live = board.rows.get(a) || null;
    let row = live ? clean(live) : null;
    // with Blockscout paused, holder counts come only from the paced holders loop: a read here for every coin Sentry,
    // The Record or the board looks at filled GeckoTerminal's queue faster than it drains (18 Nov)
    { const hh = HOLDERS.get(a); if (BS_KEY && !bsDown() && (!hh || Date.now() - (hh.at || 0) > 15 * 60_000)) await Promise.race([fetchHolders(a, { hi: false }).catch(() => null), new Promise((r) => setTimeout(r, 4000))]); }
    const dsr = dsRows(pairs, ethUsd).get(a) || null;
    if (dsr) {
      // price from the pool that holds the most money, not the biggest two-sided total (a made-up price inflates that)
      const main = pairs.filter((p) => lc(p.baseToken?.address) === a && fnum(p.priceUsd) > 0)
        .map((p) => ({ p, m: realFromPairs([p], a, ethUsd) || 0 })).sort((x, y) => y.m - x.m || (y.p.liquidity?.usd || 0) - (x.p.liquidity?.usd || 0))[0]?.p;
      if (main && lc(main.pairAddress) !== dsr.pool) {
        const pu = fnum(main.priceUsd);
        Object.assign(dsr, { priceUsd: pu, priceEth: ethUsd ? pu / ethUsd : dsr.priceEth, change24h: fnum(main.priceChange?.h24), change1h: fnum(main.priceChange?.h1), liquidityUsd: fnum(main.liquidity?.usd),
          mcapUsd: fnum(main.marketCap) ?? fnum(main.fdv), pool: lc(main.pairAddress), poolDex: `${main.dexId || "other"}${main.labels?.[0] ? "-" + main.labels[0] : ""}`, quoteSymbol: main.quoteToken?.symbol || null });
      }
      dsr.priceAt = Date.now(); dsr.priceSource = "DexScreener";
    }
    if (pairs.length) REAL.set(a, { usd: realFromPairs(pairs, a, ethUsd), at: Date.now() });
    const pons = ps.status === "fulfilled" && ps.value ? ponsPublic(ps.value) : null;
    // a Pons token still on its curve trades on the curve; a stray DEX pair thinner than the curve (e.g. a $0.40 dust
    // pool) would show a wrong price and liquidity, so it is ignored for numbers (its links and image are still used)
    const curveLive = !!(pons && !pons.graduated && pons.priceInPair > 0 && pons.pair?.address === "native");
    const dsThin = !!(dsr && curveLive && (dsr.liquidityUsd || 0) < pons.raised * (ethUsd || 0));
    // a board row the index has not refreshed for 5 minutes takes DexScreener's numbers, on the board too, so the Market,
    // the Desk and this page show one price ($TROYA read $0.00000653 here, 69 minutes old, at $0.0000056 on 20 Nov)
    if (live && !curveLive && live.poolDex !== "pons-v2" && rowAge(live) > PRICE_STALE && freshen(live, pairs, ethUsd)) row = clean(live);
    if (!row && dsr && !dsThin) row = dsr;
    // fall back to GeckoTerminal only when neither the board nor DexScreener knows the token
    if (!row) {
      const pools = await gecko(`tokens/${a}/pools?page=1&include=base_token`, { hi: true }).catch(() => null);
      if (pools?.data?.length) {
        const inc = new Map((pools.included || []).map((x) => [x.id, x]));
        const m = new Map();
        for (const p of pools.data) { const pr = poolRow(p, inc); if (pr.base === a) fold(m, pr, ethUsd); }
        if (m.get(a)) row = clean(m.get(a));
      }
    }
    if (!row && !pons) throw httpErr(404, "This token is not on the Robinhood Chain board yet (no pool on GeckoTerminal or DexScreener, and not a Pons launch).");
    let token = row ? { ...row } : { address: a, name: "", symbol: "", launchpad: "pons", tradable: true, pools: [] };
    if (!token.stock) { const sd = await Promise.race([import("./stocks.mjs").then((m) => m.stockDesk()).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]); if (sd?.assets?.some((x) => lc(x.address) === a)) token.stock = true; }
    { const hd = HOLDERS.get(a); if (hd?.count != null) { token.holders = hd.count; token.top10Pct = hd.top10; } }
    if (pons) { token.launchpad = "pons"; token.tradable = true; }
    if (curveLive && token.priceUsd == null) {
      // numbers straight from the curve: price from its reserves, liquidity = ETH actually raised on it
      token.priceEth = pons.priceInPair; token.priceUsd = ethUsd ? pons.priceInPair * ethUsd : null;
      token.liquidityEth = pons.raised; token.liquidityUsd = ethUsd ? pons.raised * ethUsd : null;
      if (dsr?.mcapUsd && dsr.priceUsd) { token.mcapUsd = dsr.mcapUsd * (token.priceUsd / dsr.priceUsd); token.mcapEth = ethUsd ? token.mcapUsd / ethUsd : null; }
      token.priceAt = Date.now(); token.priceSource = "Pons curve, on chain";
    }
    // a Pons coin is priced from the chain itself (its curve, or its v4 pool after graduation) and its market cap counts
    // the supply left after burns; the board takes the same read, so every page shows this number
    if (pons) {
      const st = PSTATIC.get(a);
      if (st && !st.none && st.graduated !== !!(pons.graduated && pons.poolId)) PSTATIC.delete(a);
      await Promise.race([readChain([a], { statics: 1 }).catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
    }
    token = honest(token, ethUsd);
    token.bornAt = (await bornOf([a]))[0] ?? null;
    if (token.realLiquidityUsd == null && curveLive && ethUsd) { token.realLiquidityUsd = pons.raised * ethUsd; token.realLiquidityEth = pons.raised; }
    if (!token.symbol || !token.name) {
      try { const rh = await import("./robinhood.mjs"); const m = await rh.tokenMeta(a); token.symbol ||= m.symbol; token.name ||= m.name; } catch {}
    }
    const p = prof.status === "fulfilled" ? prof.value : null;
    token.description = p?.description || null;
    token.website = p?.website || token.website || dsr?.website || null;
    token.twitter = p?.twitter || token.twitter || dsr?.twitter || null;
    token.telegram = p?.telegram || token.telegram || dsr?.telegram || null;
    if (!token.image && dsr?.image) token.image = dsr.image;
    if (!token.image && p?.logo) token.logoUri = p.logo;
    if (token.image) IMAGES.set(a, token.image);
    return {
      token, pons, ethUsd,
      links: {
        pons: pons ? pons.ponsUrl : null, dexscreener: `https://dexscreener.com/robinhood/${a}`, geckoterminal: `https://www.geckoterminal.com/robinhood/tokens/${a}`,
        explorer: `https://robinhoodchain.blockscout.com/token/${a}`,
      },
      sources: [...new Set([board.rows.get(a) ? "GeckoTerminal" : null, token.priceSource === "DexScreener" || (!board.rows.get(a) && dsr) || pairs.length ? "DexScreener" : null,
        pons ? "Pons factory (on chain)" : null, / on chain$/.test(token.priceSource || "") ? "Robinhood Chain RPC (price, supply)" : null].filter(Boolean))],
      updatedAt: Date.now(),
    };
  }, { swr: 0 });
}
// recent trades of a token's main pool (GeckoTerminal), loaded after the token page renders
export async function getRobinhoodTrades(address) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const a = lc(address);
  const pool = board.rows.get(a)?.pool || (await getRobinhoodToken(a)).token?.pool;
  if (!pool) return { trades: [], pool: null };
  // stale-while-revalidate: the last trades answer at once while a fresh read waits in the GeckoTerminal queue
  const last = LAST.get(`t:${pool}`);
  const fresh = memo(`rh:trades:${pool}`, 60_000, async () => {
    const t = await gecko(`pools/${pool}/trades`, { hi: true });
    const trades = (t.data || []).slice(0, 50).map((x) => {
      const v = x.attributes || {};
      const buy = v.kind === "buy";
      return { t: Date.parse(v.block_timestamp || "") || null, side: buy ? "buy" : "sell", trader: v.tx_from_address, tx: v.tx_hash, usd: fnum(v.volume_in_usd),
        tokens: fnum(buy ? v.to_token_amount : v.from_token_amount), quote: fnum(buy ? v.from_token_amount : v.to_token_amount) };
    });
    const v = { trades, pool, source: "GeckoTerminal", updatedAt: Date.now() };
    setLast(`t:${pool}`, v);
    return v;
  });
  if (last) { fresh.catch(() => {}); return last; }
  return fresh;
}
// how full the GeckoTerminal queue is (public, numbers only): a chart that loads slowly can be told apart from a slow upstream
export const geckoQueue = () => ({ hi: gq.hi.length, lo: gq.lo.length, oldestHiS: gq.hi.length ? Math.round((Date.now() - gq.hi[0].queuedAt) / 1000) : 0,
  oldestLoS: gq.lo.length ? Math.round((Date.now() - gq.lo[0].queuedAt) / 1000) : 0, busy: gq.busy,
  // what is waiting, by kind of call (addresses left out): tokens/:a/info, pools/:p/ohlcv/..., new_pools ...
  kinds: [...gq.hi, ...gq.lo].reduce((m, j) => { const k = `${j.hi ? "hi" : "lo"} ${j.pathQs.split("?")[0].replace(/0x[0-9a-fA-F]{40,64}/g, ":a").replace(/\/(minute|hour|day)$/, "")}`; m[k] = (m[k] || 0) + 1; return m; }, {}) });

const LAST = new Map();   // last good trades / candles per pool, served while a refresh is queued
// kept on disk too, so a chart answers at once after a restart instead of waiting for GeckoTerminal's queue (each deploy
// emptied it, and a cold chart then waited behind a rate limit shared by every call this server makes)
const LAST_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "gecko-last.json") : null;
(function loadLast() { if (!LAST_FILE) return; try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(LAST_FILE, "utf8")) || {})) LAST.set(k, v); } catch {} })();
let lastDirty = false;
if (LAST_FILE) setInterval(() => {
  if (!lastDirty) return;
  lastDirty = false;
  const keep = Object.fromEntries([...LAST.entries()].slice(-120));   // the most recently refreshed charts and trade lists
  writeFile(LAST_FILE + ".tmp", JSON.stringify(keep)).then(() => rename(LAST_FILE + ".tmp", LAST_FILE)).catch(() => {});
}, 60_000).unref?.();
const setLast = (k, v) => { LAST.delete(k); LAST.set(k, v); lastDirty = true; if (LAST.size > 400) LAST.delete(LAST.keys().next().value); };

// candles for a Robinhood token's main pool, in USD: [{time(sec), open, high, low, close, volume}]
const GT_TF = { "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };
// Candles straight from the chain for Pons coins: the curve's own Buy and Sell events while the coin is on its curve,
// and its Uniswap v4 pool's Swap events after it graduates, read through our own RPC. GeckoTerminal (free and
// rate-limited: its 429s held charts for 40-50 s on 20 Nov 2026) stays for every other pool.
//   curve Buy  data: quoteIn (gross ETH), tokensOut, fee, creatorTax      curve Sell data: tokensIn, quoteOut, fee, creatorTax
//   v4 Swap (PoolManager) topics: id, sender; data: amount0 (ETH), amount1 (token), sqrtPriceX96, liquidity, tick, fee
// Wide log reads go to the official RPC, which leaves blockTimestamp at 0: block times come from exact reads of up to
// 80 anchor blocks per pass (cached for good), interpolated between them.
const T_CBUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const T_CSELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
const T_V4SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const IV_S = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const CHAINC = new Map();      // token -> { curve, poolId, last, dec, trades: [[unix s, ETH per token, ETH volume]], busy }
const BLOCK_TS = new Map();    // block -> unix s
const rhHex = (n) => "0x" + n.toString(16);
const s256 = (v) => (v >= 2n ** 255n ? v - 2n ** 256n : v);
async function blockTimes(blocks) {
  const uniq = [...new Set(blocks)].sort((x, y) => x - y);
  if (!uniq.length) return new Map();
  const want = uniq.length <= 80 ? uniq : [...new Set([...Array.from({ length: 79 }, (_, k) => uniq[Math.floor((k * (uniq.length - 1)) / 78)]), uniq[uniq.length - 1]])];
  const todo = want.filter((b) => !BLOCK_TS.has(b));
  for (let k = 0; k < todo.length; k += 10) {
    await Promise.all(todo.slice(k, k + 10).map(async (b) => {
      const blk = await rhRpc("robinhood", "eth_getBlockByNumber", [rhHex(b), false]).catch(() => null);
      if (blk?.timestamp) BLOCK_TS.set(b, Number(BigInt(blk.timestamp)));
    }));
  }
  while (BLOCK_TS.size > 60_000) BLOCK_TS.delete(BLOCK_TS.keys().next().value);
  const anchors = uniq.filter((b) => BLOCK_TS.has(b));
  const out = new Map();
  let ai = 0;
  for (const b of uniq) {
    if (BLOCK_TS.has(b)) { out.set(b, BLOCK_TS.get(b)); continue; }
    while (ai < anchors.length - 1 && anchors[ai + 1] < b) ai++;
    const lo = anchors[ai], hi = anchors.find((x) => x > b);
    if (lo == null || lo > b) { if (hi != null) out.set(b, BLOCK_TS.get(hi)); continue; }
    if (hi == null) { out.set(b, BLOCK_TS.get(lo)); continue; }
    const tl = BLOCK_TS.get(lo), th = BLOCK_TS.get(hi);
    out.set(b, Math.round(tl + ((th - tl) * (b - lo)) / (hi - lo)));
  }
  return out;
}
async function chainTrades(a) {
  const ps = await memo(`rh:curveps:${a}`, 60_000, () => ponsState(a)).catch(() => null);
  const poolId = ps?.graduated && /^0x[0-9a-f]{64}$/i.test(ps?.poolId || "") ? ps.poolId : null;
  if (!ps?.curve && !poolId) return null;
  let c = CHAINC.get(a);
  if (!c || lc(c.curve || "") !== lc(ps.curve || "") || (poolId && c.poolId !== poolId)) {
    const head0 = Number(BigInt(await rhRpc("robinhood", "eth_blockNumber", [])));
    const { findLaunchTx } = await import("./ringradar.mjs");
    const l = await findLaunchTx(a).catch(() => null);
    const decHex = await rhRpc("robinhood", "eth_call", [{ to: a, data: "0x313ce567" }, "latest"]).catch(() => null);
    c = { curve: ps.curve || null, poolId, last: l?.block ? l.block - 1 : Math.max(0, head0 - 8_000_000), dec: decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18, trades: [], busy: null };
    CHAINC.set(a, c);
    while (CHAINC.size > 400) CHAINC.delete(CHAINC.keys().next().value);
  }
  if (!c.busy) c.busy = (async () => {
    // the official RPC runs a few blocks behind our node: stay 100 blocks (~10 s) under the head
    const head = Number(BigInt(await rhRpc("robinhood", "eth_blockNumber", []))) - 100;
    if (head <= c.last) return;
    // one topic value per position: the official RPC takes a wide range only that way
    const q = (address, topics) => rhRpc("robinhood", "eth_getLogs", [{ address, topics, fromBlock: rhHex(c.last + 1), toBlock: rhHex(head) }], { only: RH_CHAINS.robinhood.wide, timeoutMs: 25_000 });
    const [buys, sells, swaps] = await Promise.all([
      c.curve ? q(c.curve, [T_CBUY]) : [], c.curve ? q(c.curve, [T_CSELL]) : [], c.poolId ? q(RH.poolManager, [T_V4SWAP, c.poolId]) : [],
    ]);
    const logs = [...(buys || []), ...(sells || []), ...(swaps || [])].sort((x, y) => Number(BigInt(x.blockNumber)) - Number(BigInt(y.blockNumber)) || Number(BigInt(x.logIndex)) - Number(BigInt(y.logIndex)));
    const ts = await blockTimes(logs.filter((l) => !(Number(l.blockTimestamp) > 0)).map((l) => Number(BigInt(l.blockNumber))));
    for (const l of logs) {
      const w = (l.data.slice(2).match(/.{64}/g) || []).map((x) => BigInt("0x" + x));
      const t = Number(l.blockTimestamp) > 0 ? Number(BigInt(l.blockTimestamp)) : ts.get(Number(BigInt(l.blockNumber)));
      if (!t) continue;
      if (l.topics[0] === T_V4SWAP) {
        if (w.length < 3) continue;
        const sq = Number(w[2]) / 2 ** 96, tokPerEth = sq * sq * 10 ** (18 - c.dec);
        const eth = Math.abs(Number(s256(w[0]))) / 1e18;
        if (tokPerEth > 0) c.trades.push([t, 1 / tokPerEth, eth]);
        continue;
      }
      if (w.length < 4) continue;
      const buy = l.topics[0] === T_CBUY;
      const eth = buy ? w[0] - w[2] - w[3] : w[1] + w[2] + w[3], tok = buy ? w[1] : w[0];
      if (tok <= 0n || eth <= 0n) continue;
      const ethF = Number(eth) / 1e18;
      c.trades.push([t, ethF / (Number(tok) / 10 ** c.dec), ethF]);
    }
    c.last = head;
  })().finally(() => { c.busy = null; });
  await c.busy;
  return c;
}
// One 5-minute bucket per key, in the pool's quote unit (ETH or USD): every chart interval (5m … 1d) is a whole number
// of them, so the bars of any interval are built from the same buckets. k orders trades (block * 1e5 + log index), so
// a back-filled older read merges into a bucket without swapping its open and close.
const B5 = 300;
function addB5(m, t, k, px, vq) {
  const b = Math.floor(t / B5) * B5;
  const x = m.get(b);
  if (!x) { m.set(b, { t: b, o: px, h: px, l: px, c: px, v: vq, n: 1, ok: k, ck: k }); return; }
  if (k < x.ok) { x.o = px; x.ok = k; }
  if (k >= x.ck) { x.c = px; x.ck = k; }
  if (px > x.h) x.h = px;
  if (px < x.l) x.l = px;
  x.v += vq; x.n++;
}
// ETH's own price at each bar (Hyperliquid candles of the same interval): an ETH-quoted coin's past bars were all
// multiplied by today's ETH price, so its USD history moved with ETH's later moves (ETH fell 13% in the week to 20 Nov)
const ETH_HOURS = (iv) => Math.ceil((300 * IV_S[iv]) / 3600) + Math.ceil(IV_S[iv] / 3600);
async function ethCloses(iv) {
  const d = await getHlCandles("ETH", iv, ETH_HOURS(iv)).catch(() => null);
  return (d?.candles || []).filter((x) => x.close > 0).map((x) => [x.time, x.close]);
}
// the ETH close of the bar that holds t (the closest earlier one when Hyperliquid has a gap)
function ethAt(list, t, step) {
  let lo = 0, hi = list.length - 1, hit = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= t) { hit = list[mid]; lo = mid + 1; } else hi = mid - 1; }
  return hit && t - hit[0] < Math.max(step, 3600) * 3 ? hit[1] : null;
}
// candles in USD from 5-minute quote buckets: quiet stretches carry the last price forward to the current bar, so the
// chart runs to now (300 bars at most). With them: how many trades the window holds, when the last trade was and at what
// USD price, and the trade count of each interval's window (the page opens on the smallest one that has trades).
async function buildCandles(b5, iv, { quote, lastTrade, covered = null }) {
  if (!b5.size) return null;
  const step = IV_S[iv], now = Math.floor(Date.now() / 1000), endB = Math.floor(now / step) * step;
  const ethNow = quote === "eth" ? await getEthUsd().catch(() => null) : 1;
  if (!ethNow) return null;
  const by = new Map();
  for (const k of [...b5.values()].sort((x, y) => x.t - y.t)) {
    const b = Math.floor(k.t / step) * step, x = by.get(b);
    if (!x) by.set(b, { time: b, open: k.o, high: k.h, low: k.l, close: k.c, vq: k.v, n: k.n });
    else { x.high = Math.max(x.high, k.h); x.low = Math.min(x.low, k.l); x.close = k.c; x.vq += k.v; x.n += k.n; }
  }
  const keys = [...by.keys()].sort((x, y) => x - y);
  const startB = Math.max(keys[0], endB - 299 * step);
  let prev = null;
  for (const k of keys) { if (k < startB) prev = by.get(k).close; else break; }
  const q = [];
  for (let b = startB; b <= endB; b += step) {
    const k = by.get(b);
    if (k) { if (prev != null) { k.open = prev; k.high = Math.max(k.high, prev); k.low = Math.min(k.low, prev); } q.push(k); prev = k.close; }
    else if (prev != null) q.push({ time: b, open: prev, high: prev, low: prev, close: prev, vq: 0, n: 0 });
  }
  const eth = quote === "eth" ? await ethCloses(iv) : [];
  const perBar = quote !== "eth" || eth.length > 0;
  const usdAt = (t, last) => (quote !== "eth" ? 1 : last ? ethNow : ethAt(eth, t, step) ?? ethNow);
  const candles = q.map((x, i) => {
    const e = usdAt(x.time, i === q.length - 1);
    return { time: x.time, open: x.open * e, high: x.high * e, low: x.low * e, close: x.close * e, volume: x.vq * e };
  });
  let lastTradeUsd = null;
  if (lastTrade) {
    let e = 1;
    if (quote === "eth") {
      e = ethAt(eth, lastTrade.t, step);
      // older than this interval's window: the daily ETH candles (90 days), else today's price
      if (e == null) { const d = await ethCloses("1d"); e = ethAt(d, lastTrade.t, 86400) ?? ethNow; }
    }
    lastTradeUsd = lastTrade.px * e;
  }
  const windows = {};
  for (const [k, s] of Object.entries(IV_S)) {
    const from = Math.floor(now / s) * s - 299 * s;
    let n = 0;
    for (const x of b5.values()) if (x.t >= from) n += x.n;
    windows[k] = n;
  }
  return {
    candles, interval: iv, unit: "USD", ethPriced: quote === "eth" ? (perBar ? "per bar" : "today") : null,
    tradesInWindow: q.reduce((s, x) => s + x.n, 0), windowHours: +(((endB + step - startB) / 3600).toFixed(2)),
    lastTradeAt: lastTrade ? lastTrade.t * 1000 : null, lastTradeUsd, windows, windowsFrom: covered, updatedAt: Date.now(),
  };
}

/* Uniswap v3 and v4 pools on chain (stock tokens and every coin whose main pool is one): the pool's Swap events, read
   through our node in pieces it takes (rpc() splits a range of up to 300,000 blocks into Chainstack's 9,000), folded into
   the same 5-minute buckets. GeckoTerminal kept stock charts waiting 16-31 s cold (SPCX, NVDA, 20 Nov 2026) and stays the
   fallback. A first read covers the last 26 hours (the 5m chart's window) and runs in the background, one read at a
   time for the whole server, while that visit's chart comes from GeckoTerminal; older history is filled backwards in the
   background up to 7 days. The 20 most traded stocks are read at start and kept current every 2 minutes.
     v3 Swap (the pool) topics: sender, recipient; data: amount0, amount1, sqrtPriceX96, liquidity, tick
     v4 Swap (PoolManager) topics: id, sender; data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee
   The quote side (WETH or native ETH, or USDG) is read from DexScreener's pair; which side of the pool the coin is on is
   settled by the price itself (the two readings differ by many orders of magnitude) against DexScreener's price. */
const T_V3SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const POOLC = new Map();             // token -> pool reader (below)
const POOL_INIT_S = 26 * 3600;
const POOL_BACK_MAX_S = 7 * 86400;
const POOL_SPAN = 250_000;           // blocks per read (about 7 hours at 10 blocks a second)
const QUOTES = { [lc(RH.weth)]: ["eth", 18], "0x0000000000000000000000000000000000000000": ["eth", 18], [lc(RH.usdg)]: ["usd", 6] };
let BPS = null;
async function blocksPerSec() {
  if (BPS && Date.now() - BPS.at < 3600_000) return BPS.v;
  const head = Number(BigInt(await rhRpc("robinhood", "eth_blockNumber", [])));
  const ts = await blockTimes([head - 200_000, head]);
  const t0 = ts.get(head - 200_000), t1 = ts.get(head);
  BPS = { v: t0 && t1 > t0 ? 200_000 / (t1 - t0) : 10, at: Date.now() };
  return BPS.v;
}
async function mainPoolOf(a) {
  const row = board.rows.get(a) || (await getRobinhoodToken(a).catch(() => null))?.token || null;
  const pool = lc(row?.pool || "");
  const v4 = /^0x[0-9a-f]{64}$/.test(pool);
  if (!v4 && !/^0x[0-9a-f]{40}$/.test(pool)) return null;
  if (/^pons/.test(row.poolDex || "")) return null;               // a Pons curve is read by chainTrades above, not as a pool
  if (v4 && !/^uniswap/.test(row.poolDex || "")) return null;   // only Uniswap's PoolManager emits these Swap events
  const p = (await dsTokenPairs(a).catch(() => [])).find((x) => lc(x.pairAddress) === pool && lc(x.baseToken?.address) === a) || null;
  const qaddr = p ? lc(p.quoteToken?.address) : null;
  const q = qaddr ? QUOTES[qaddr] : /^W?ETH$/i.test(row.quoteSymbol || "") ? ["eth", 18] : /^USDG$/i.test(row.quoteSymbol || "") ? ["usd", 6] : null;
  if (!q) return null;
  const ref = fnum(p?.priceNative) ?? (q[0] === "eth" ? fnum(row.priceEth) : fnum(row.priceUsd));
  return { pool, v4, quote: q[0], qdec: q[1], qaddr, ref: ref > 0 ? ref : null, createdAt: fnum(p?.pairCreatedAt) ?? null };
}
async function poolReader(a) {
  let c = POOLC.get(a);
  if (c && Date.now() - c.metaAt < 30 * 60_000) return c.bad ? null : c;
  const m = await mainPoolOf(a);
  if (!m) { POOLC.set(a, { bad: true, metaAt: Date.now() }); return null; }
  if (c && !c.bad && c.pool === m.pool) { Object.assign(c, { ref: m.ref, createdAt: m.createdAt, metaAt: Date.now() }); return c; }
  const decHex = await rhRpc("robinhood", "eth_call", [{ to: a, data: "0x313ce567" }, "latest"]).catch(() => null);
  c = { a, ...m, dec: decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18, flip: null, lo: null, hi: null, loTs: null, b5: new Map(), n: 0,
    lastT: null, backTo: POOL_INIT_S, born: false, bad: false, metaAt: Date.now(), fwdP: null, queued: {} };
  POOLC.set(a, c);
  while (POOLC.size > 300) POOLC.delete(POOLC.keys().next().value);
  return c;
}
async function poolLogs(c, from, to) {
  const out = [];
  const q = c.v4 ? { address: RH.poolManager, topics: [T_V4SWAP, c.pool] } : { address: c.pool, topics: [T_V3SWAP] };
  for (let s = from; s <= to; s += POOL_SPAN) {
    const e = Math.min(to, s + POOL_SPAN - 1);
    const logs = await rhRpc("robinhood", "eth_getLogs", [{ ...q, fromBlock: rhHex(s), toBlock: rhHex(e) }], { only: RH_CHAINS.robinhood.wide, timeoutMs: 25_000 });
    if (!Array.isArray(logs)) throw new Error("no logs answer");
    out.push(...logs);
  }
  return out;
}
// one Swap log -> [price of the coin in the quote unit, quote amount], for a given side of the pool
function swapOf(c, l, flip) {
  const w = (l.data.slice(2).match(/.{64}/g) || []).map((x) => BigInt("0x" + x));
  if (w.length < 3 || w[2] === 0n) return null;
  const sq = Number(w[2]) / 2 ** 96, r = sq * sq, f = 10 ** (c.dec - c.qdec);
  const px = (flip ? 1 / r : r) * f;
  const vq = Math.abs(Number(s256(flip ? w[0] : w[1]))) / 10 ** c.qdec;
  return isFinite(px) && px > 0 ? [px, vq] : null;
}
async function foldPoolLogs(c, logs) {
  if (!logs.length) return;
  const num = (v) => Number(BigInt(v));
  logs.sort((x, y) => num(x.blockNumber) - num(y.blockNumber) || num(x.logIndex) - num(y.logIndex));
  if (c.flip == null) {
    // which side the coin is on: the latest swap read both ways, the one near DexScreener's price wins; without a price,
    // the address order (token0 is the lower address; native ETH is always currency0 in v4)
    const l = logs[logs.length - 1], a0 = swapOf(c, l, false), a1 = swapOf(c, l, true);
    const off = (x) => (x && c.ref ? Math.abs(Math.log10(x[0] / c.ref)) : Infinity);
    if (c.ref) c.flip = off(a1) < off(a0);
    else if (c.qaddr) c.flip = BigInt(c.qaddr) < BigInt(c.a);
    else { c.bad = true; return; }
    // neither reading near the pool's own price: not a pool these events describe; GeckoTerminal keeps the chart
    if (c.ref && Math.min(off(a0), off(a1)) > Math.log10(20)) { c.bad = true; return; }
  }
  const ts = await blockTimes(logs.filter((l) => !(Number(l.blockTimestamp) > 0)).map((l) => num(l.blockNumber)));
  for (const l of logs) {
    const t = Number(l.blockTimestamp) > 0 ? num(l.blockTimestamp) : ts.get(num(l.blockNumber));
    const s = t ? swapOf(c, l, c.flip) : null;
    if (!s) continue;
    addB5(c.b5, t, num(l.blockNumber) * 1e5 + num(l.logIndex), s[0], s[1]);
    c.n++;
    if (!c.lastT || t >= c.lastT.t) c.lastT = { t, px: s[0] };
  }
}
function poolForward(c) {
  if (c.fwdP) return c.fwdP;
  c.fwdP = (async () => {
    const head = Number(BigInt(await rhRpc("robinhood", "eth_blockNumber", []))) - 100;   // the RPCs trail our node a little
    if (c.hi == null) {
      const from = Math.max(0, head - Math.ceil(POOL_INIT_S * (await blocksPerSec())));
      await foldPoolLogs(c, await poolLogs(c, from, head));
      const ts = await blockTimes([from]);
      c.lo = from; c.loTs = ts.get(from) || Math.floor(Date.now() / 1000) - POOL_INIT_S; c.hi = head;
      if (c.createdAt && c.loTs * 1000 <= c.createdAt) c.born = true;   // a pool younger than 26 h: all of it is read
    } else if (head > c.hi) {
      await foldPoolLogs(c, await poolLogs(c, c.hi + 1, head));
      c.hi = head;
    }
    c.at = Date.now();
  })().finally(() => { c.fwdP = null; });
  return c.fwdP;
}
async function poolBack(c) {
  if (c.hi == null || c.bad || c.born || c.lo <= 0) return false;
  const want = Math.floor(Date.now() / 1000) - Math.min(c.backTo, POOL_BACK_MAX_S);
  if (c.loTs <= want) return false;
  const from = Math.max(0, c.lo - POOL_SPAN);
  await foldPoolLogs(c, await poolLogs(c, from, c.lo - 1));
  const ts = await blockTimes([from]);
  c.lo = from; c.loTs = ts.get(from) || c.loTs - Math.round(POOL_SPAN / (await blocksPerSec()));
  if (from === 0 || (c.createdAt && c.loTs * 1000 <= c.createdAt)) c.born = true;
  return !c.born && c.loTs > want;
}
// one pool read at a time for the whole server, first reads ahead of back-fills
const PQ = { fwd: [], back: [], busy: false };
function poolJob(c, kind) {
  if (!c || c.bad || c.queued[kind]) return;
  c.queued[kind] = true; PQ[kind].push(c);
  pumpPools();
}
async function pumpPools() {
  if (PQ.busy) return;
  PQ.busy = true;
  try {
    for (;;) {
      const kind = PQ.fwd.length ? "fwd" : PQ.back.length ? "back" : null;
      if (!kind) break;
      const c = PQ[kind].shift();
      c.queued[kind] = false;
      try {
        if (kind === "fwd") await poolForward(c);
        else if (await poolBack(c)) poolJob(c, "back");
        c.err = null;
      } catch (e) { c.err = String(e?.message || e).slice(0, 120); c.errAt = Date.now(); }
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally { PQ.busy = false; }
}
async function poolCandles(a, iv) {
  const c = await poolReader(a);
  if (!c) return null;
  if (c.hi == null) { poolJob(c, "fwd"); return null; }   // its first read runs in the background; GeckoTerminal answers now
  // a reader kept current answers at once; one that fell behind catches up for at most 1.5 s, then answers as it is
  await Promise.race([poolForward(c).catch(() => {}), new Promise((r) => setTimeout(r, 1500).unref?.())]);
  if (c.bad || !c.n) return null;
  const step = IV_S[iv], now = Math.floor(Date.now() / 1000);
  const age = c.createdAt ? Math.max(step, now - Math.floor(c.createdAt / 1000)) : Infinity;
  const need = Math.min(300 * step, age), covered = now - c.loTs;
  if (covered < need - step && !c.born) { c.backTo = Math.max(c.backTo, need); poolJob(c, "back"); }
  const full = c.born || covered >= need - step;
  // older bars from GeckoTerminal's last copy of the same pool (kept on disk), when the chain read does not reach back
  const lastC = full ? null : LAST.get(`c:${a}:${iv}`);
  const older = lastC && lc(lastC.pool || "") === c.pool ? (lastC.candles || []).filter((x) => x.time < c.loTs - step) : [];
  if (!full && !older.length && covered < 36 * step) return null;
  const out = await buildCandles(c.b5, iv, { quote: c.quote, lastTrade: c.lastT, covered: c.loTs * 1000 });
  if (!out) return null;
  const venue = c.v4 ? "Uniswap v4 pool" : "Uniswap v3 pool";
  const first = out.candles[0]?.time ?? Infinity;
  if (older.length) out.candles = [...older.filter((x) => x.time < first), ...out.candles].slice(-300);
  out.source = `On-chain: ${venue}${older.length ? " (older bars from GeckoTerminal)" : ""}${out.ethPriced === "today" ? ", USD at today's ETH price" : ""}`;
  out.pool = c.pool; out.trades = c.n;
  return out;
}
// keep the 20 most traded stock tokens read, so their charts answer from memory like $TROYA's
async function warmStockCharts() {
  const s = await getStocks().catch(() => null);
  const top = (s?.stocks || []).filter((x) => x.volume24hUsd > 0).sort((x, y) => y.volume24hUsd - x.volume24hUsd).slice(0, 20);
  for (const x of top) {
    const c = await poolReader(x.address).catch(() => null);
    if (!c) continue;
    c.backTo = POOL_BACK_MAX_S;
    poolJob(c, "fwd"); poolJob(c, "back");
  }
}

async function chainCandles(a, iv) {
  const c = await chainTrades(a);
  if (!c) return poolCandles(a, iv);   // not a Pons coin: its Uniswap pool, when that is its main pool
  if (!c.trades.length) return null;
  const b5 = new Map();
  c.trades.forEach(([t, px, eth], i) => addB5(b5, t, i, px, eth));
  const last = c.trades.reduce((m, x) => (!m || x[0] >= m[0] ? x : m), null);
  const out = await buildCandles(b5, iv, { quote: "eth", lastTrade: last ? { t: last[0], px: last[1] } : null });
  if (!out) return null;
  const src = c.poolId ? (c.curve ? "On-chain: Pons curve + Uniswap v4 pool" : "On-chain: Uniswap v4 pool") : "On-chain: Pons curve";
  out.source = `${src}${out.ethPriced === "today" ? ", USD at today's ETH price" : ""}`;
  out.trades = c.trades.length;
  return out;
}

// bg: a background job (the Record back-fill, smart DCA sizing) waits behind people loading a chart or a range
export async function getRobinhoodCandles(address, interval = "1h", { bg = false } = {}) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const iv = GT_TF[interval] ? interval : "1h";
  const a = lc(address);
  if (!bg) { const cc = await memo(`rh:ccandles:${a}:${iv}`, 10_000, () => chainCandles(a, iv)).catch(() => null); if (cc?.candles?.length) return cc; }
  const lastC = bg ? null : LAST.get(`c:${a}:${iv}`);
  const freshC = memo(`rh:candles:${a}:${iv}`, iv === "5m" || iv === "15m" ? 2 * 60_000 : 5 * 60_000, async () => {
    let pool = board.rows.get(a)?.pool;
    if (!pool) pool = (await getRobinhoodToken(a)).token?.pool;
    if (!pool) throw httpErr(404, "No pool to chart for this token yet.");
    const [tf, agg] = GT_TF[iv];
    const d = await gecko(`pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=300&currency=usd&token=${a}`, { hi: !bg });
    const c = (d?.data?.attributes?.ohlcv_list || []).map((x) => ({ time: Number(x[0]), open: fnum(x[1]), high: fnum(x[2]), low: fnum(x[3]), close: fnum(x[4]), volume: fnum(x[5]) }))
      .filter((x) => x.close != null).sort((x, y) => x.time - y.time);
    const v = { candles: c, interval: iv, source: "GeckoTerminal", unit: "USD", pool, updatedAt: Date.now() };
    if (c.length) setLast(`c:${a}:${iv}`, v);
    return v;
  });
  if (lastC) { freshC.catch(() => {}); return lastC; }
  return freshC;
}

/* ---------------- tokenized stocks ---------------- */
// One source per number: the batch endpoint (tokens/v1) gives each stock ONE pair, so the list read NVDA at $7.1M of
// volume while its page added up its pools ($19.8M, 20 Nov 2026). The list now takes the volume, liquidity and trade
// counts from what the coin page shows: the board's row (every pool of the coin, the page's own source) when the board
// has the stock, else DexScreener's full pair list summed as the page sums it (token-pairs, read in the background: the
// 20 most traded every pass, 10 more in turn, about 15 calls a minute against DexScreener's 300). Price and 24h change
// stay the batch's deepest pair, read every 2 minutes.
const STOCK_PAIRS = new Map();   // address -> { pairs, at }
let stockPairsBusy = false, stockCursor = 0;
async function refreshStockPairs(list) {
  if (stockPairsBusy) return;
  stockPairsBusy = true;
  try {
    const top = [...list].sort((x, y) => (y.volume24hUsd || 0) - (x.volume24hUsd || 0)).slice(0, 20).map((x) => x.address);
    const rest = list.map((x) => x.address).filter((a) => !top.includes(a));
    const turn = rest.length ? Array.from({ length: Math.min(10, rest.length) }, (_, k) => rest[(stockCursor + k) % rest.length]) : [];
    stockCursor = rest.length ? (stockCursor + turn.length) % rest.length : 0;
    for (const a of [...top, ...turn]) {
      const ps = await dsTokenPairs(a).catch(() => null);
      if (ps?.length) STOCK_PAIRS.set(a, { pairs: ps, at: Date.now() });
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally { stockPairsBusy = false; }
}
export async function getStocks() {
  return memo("rh:stocks", 2 * 60_000, async () => {
    const ethUsd = await getEthUsd().catch(() => null);
    const rows = dsRows(await dsPairs(STOCKS.map((x) => x.address)), ethUsd);
    const stocks = STOCKS.map((x) => {
      const a = lc(x.address), r = rows.get(a);
      if (r?.image) IMAGES.set(a, r.image);
      const live = board.rows.get(a);
      const sp = STOCK_PAIRS.get(a);
      const all = !live && sp && Date.now() - sp.at < 30 * 60_000 ? dsRows(sp.pairs, ethUsd).get(a) : null;
      const sum = live && live.volume24hUsd != null ? live : all;
      return { address: a, symbol: x.symbol, name: x.name, decimals: x.decimals, priceUsd: r?.priceUsd ?? null, priceEth: r?.priceEth ?? null, change24h: r?.change24h ?? null,
        volume24hUsd: sum?.volume24hUsd ?? r?.volume24hUsd ?? null, liquidityUsd: sum?.liquidityUsd ?? r?.liquidityUsd ?? null, mcapUsd: r?.mcapUsd ?? null,
        txns24h: sum?.txns24h ?? r?.txns24h ?? null, pools: live ? live.pools?.length ?? null : all ? sp.pairs.filter((p) => lc(p.baseToken?.address) === a).length : null, volumeSource: live ? "index" : all ? "all pairs" : r ? "one pair" : null,
        image: r?.image || null, pool: r?.pool || null, poolDex: r?.poolDex || null, tradable: !!r?.tradable };
    });
    if (!stocks.some((x) => x.priceUsd != null)) throw new Error("DexScreener returned no stock prices");
    refreshStockPairs(stocks).catch(() => {});
    return { stocks, updatedAt: Date.now(), source: "DexScreener (on-chain pools) + Troya index", ethUsd };
  });
}

/* ---------------- Hyperliquid ---------------- */
function normPerp(u, c, dex) {
  const mark = fnum(c.markPx), prev = fnum(c.prevDayPx), oracle = fnum(c.oraclePx), funding = fnum(c.funding), oi = fnum(c.openInterest);
  return {
    coin: u.name, displayName: perpName(u.name), dex: dex || null, mark, mid: fnum(c.midPx), oracle,
    change24h: mark && prev ? (mark / prev - 1) * 100 : null,
    fundingHr: funding, fundingHrPct: funding != null ? funding * 100 : null, fundingApr: funding != null ? funding * 24 * 365 * 100 : null,
    oiUsd: oi != null && oracle ? oi * oracle : null, volumeUsd: fnum(c.dayNtlVlm),
    maxLeverage: u.maxLeverage, szDecimals: u.szDecimals, delisted: !!u.isDelisted, onlyIsolated: !!u.onlyIsolated,
  };
}
// getHlMarkets() → {markets:[...], updatedAt}
// The same metaAndAssetCtxs reads as /api/hl/meta (hl.mjs hlCtxs: one Hyperliquid call serves both, stale-while-
// revalidate, warmed every 20 s), so a visitor is answered from memory; one list is built per pair of reads.
let hlmBuilt = null, hlmGood = null;
export async function getHlMarkets() {
  const [main, xyz] = await Promise.allSettled([hlCtxs(""), hlCtxs("xyz")]);
  if (main.status !== "fulfilled") {
    if (hlmGood) return { ...hlmGood, stale: true, staleReason: main.reason?.message || "Hyperliquid unavailable" };
    throw new Error(`Hyperliquid unavailable: ${main.reason?.message}`);
  }
  const m = main.value, x = xyz.status === "fulfilled" ? xyz.value : null;
  if (hlmBuilt && hlmBuilt.m === m && hlmBuilt.x === x) return hlmBuilt.v;
  const out = [];
  const add = ({ meta, ctxs }, dex) => meta.universe.forEach((u, i) => { if (ctxs[i]) out.push(normPerp(u, ctxs[i], dex)); });
  add(m, null);
  if (x) add(x, "xyz");
  const v = { markets: out.filter((p) => !p.delisted), updatedAt: Math.min(m.at, x?.at ?? m.at), dexes: x ? ["main", "xyz"] : ["main"] };
  hlmBuilt = { m, x, v };
  hlmGood = v;
  return v;
}
// Hyperliquid's circulatingSupply for bridged / wrapped / scaled spot tokens (Unit UBTC, UETH, USOL; ONEAR; kPEPE; XMR1)
// is the underlying coin's supply, not what exists on Hyperliquid: their market cap reads $1.3T for UBTC. Shown as "–".
const WRAPPED_SPOT = /^(U(?!SD)[A-Z]{2,}|O[A-Z]{3,}|k[A-Z].*|[A-Z]{2,}\d)$/;
function spotMcap(base, mark, supply) {
  if (!(mark > 0 && supply > 0)) return null;
  const name = String(base?.name || ""), full = String(base?.fullName || "");
  if (WRAPPED_SPOT.test(name) || /\b(unit|bridged|wrapped|omni|portal)\b/i.test(full)) return null;
  const v = mark * supply;
  return v > 50e9 ? null : v;   // a sanity bound: no Hyperliquid spot token is worth that much on its own
}
export async function getHlSpot() {
  return memo("hl:spot", 20_000, async () => {
    const [meta, ctxs] = await hl({ type: "spotMetaAndAssetCtxs" });
    const tok = new Map(meta.tokens.map((t) => [t.index, t]));
    const byCoin = new Map(ctxs.map((c) => [c.coin, c]));
    const pairs = meta.universe.map((u) => {
      const c = byCoin.get(u.name) || {};
      const base = tok.get(u.tokens[0]), quote = tok.get(u.tokens[1]);
      const mark = fnum(c.markPx), prev = fnum(c.prevDayPx), supply = fnum(c.circulatingSupply);
      return { pair: u.name, base: base?.name, quote: quote?.name, label: `${base?.name || "?"}/${quote?.name || "?"}`, mark, change24h: mark && prev ? (mark / prev - 1) * 100 : null,
        volumeUsd: fnum(c.dayNtlVlm), mcapUsd: spotMcap(base, mark, supply), evm: base?.evmContract?.address || null, canonical: !!u.isCanonical,
        index: u.index, asset: 10000 + u.index, szDecimals: base?.szDecimals ?? 2, mid: fnum(c.midPx) ?? mark };
    }).filter((p) => p.mark != null);
    return { pairs, updatedAt: Date.now() };
  });
}
const IVS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export async function getHlCandles(coin, interval = "1h", hours = 24) {
  if (!/^[A-Za-z0-9:@/_-]{1,32}$/.test(String(coin || ""))) throw httpErr(400, "Unknown market.");
  const iv = IVS[interval] ? interval : "1h";
  const hrs = Math.max(1, Math.min(24 * 90, Number(hours) || 24));
  return memo(`hl:candles:${coin}:${iv}:${hrs}`, iv === "1m" ? 15_000 : 60_000, async () => {
    const end = Date.now();
    const rows = await hl({ type: "candleSnapshot", req: { coin, interval: iv, startTime: end - hrs * 3600_000, endTime: end } });
    return { coin, interval: iv, candles: (rows || []).map((c) => ({ time: Math.floor(c.t / 1000), open: fnum(c.o), high: fnum(c.h), low: fnum(c.l), close: fnum(c.c), volume: fnum(c.v) })) };
  });
}

/* ---------------- brief + signals (computed from live data) ---------------- */
const LIQUID_VOL = 1_000_000;
const fmtPct = (v) => `${v > 0 ? "+" : ""}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
const fmtApr = (v) => `${v > 0 ? "+" : ""}${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(0)}%/yr`;
const fmtUsd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

// getBrief() → {items:[{text, refs:[{coin|address,label}]}], updatedAt}
export async function getBrief() {
  return memo("brief", 60_000, async () => {
    const [hlR, rhR] = await Promise.allSettled([getHlMarkets(), getRobinhoodTokens({ sort: "volume", limit: 30 })]);
    const items = [];
    if (hlR.status === "fulfilled") {
      const liquid = hlR.value.markets.filter((m) => (m.volumeUsd || 0) >= LIQUID_VOL && m.change24h != null);
      if (liquid.length) {
        const up = liquid.filter((m) => m.change24h > 0).length;
        items.push({ text: `${up} of ${liquid.length} liquid Hyperliquid perps (24h volume above $1M) are up over the last 24 hours.`, refs: [] });
        const movers = [...liquid].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 4);
        items.push({ text: `Largest 24h moves: ${movers.map((m) => `${m.coin} ${fmtPct(m.change24h)}`).join(", ")}.`, refs: movers.map((m) => ({ coin: m.coin, label: m.coin })) });
        const fund = liquid.filter((m) => m.fundingApr != null && (m.oiUsd || 0) >= LIQUID_VOL).sort((a, b) => b.fundingApr - a.fundingApr);
        if (fund.length >= 2) {
          const hi = fund[0], lo = fund[fund.length - 1];
          items.push({ text: `Funding at the edges: ${hi.coin} ${fmtApr(hi.fundingApr)} is the richest for shorts to collect, ${lo.coin} ${fmtApr(lo.fundingApr)} the richest for longs.`, refs: [{ coin: hi.coin, label: hi.coin }, { coin: lo.coin, label: lo.coin }] });
        }
      }
    }
    if (rhR.status === "fulfilled" && rhR.value.tokens.length) {
      const e = rhR.value;
      const top = e.tokens[0];
      // "liquid" = $10K of money in its pools (the old $20K on the two-sided total, which counts the coin side too)
      const gain = [...e.tokens].filter((t) => t.change24h != null && (t.volume24hUsd || 0) >= 20_000 && (t.realLiquidityUsd || 0) >= 10_000).sort((a, b) => b.change24h - a.change24h)[0];
      let text = `Robinhood Chain: ${top.symbol} leads 24h volume with ${fmtUsd(top.volume24hUsd || 0)} traded${top.change24h != null ? ` (${fmtPct(top.change24h)})` : ""}`;
      if (e.volume24hUsd) text += `, out of ${fmtUsd(e.volume24hUsd)} across coins on the board`;
      text += gain && gain.address !== top.address ? `; ${gain.symbol} is the strongest gainer among liquid coins at ${fmtPct(gain.change24h)}.` : ".";
      items.push({ text, refs: [{ address: top.address, label: top.symbol }, ...(gain ? [{ address: gain.address, label: gain.symbol }] : [])] });
    }
    if (!items.length) throw new Error("No market source answered");
    return { items, updatedAt: Date.now(), sources: ["Hyperliquid", "GeckoTerminal"] };
  });
}

// getSignals() → {signals:[{id,kind,title,detail,coin?,address?,value}], updatedAt}
export async function getSignals() {
  return memo("signals", 45_000, async () => {
    const [hlR, gainR, newR] = await Promise.allSettled([
      getHlMarkets(), getRobinhoodTokens({ sort: "change", limit: 60 }), getRobinhoodTokens({ sort: "newest", limit: 60, tradable: 0 }),
    ]);
    const out = [];
    if (hlR.status === "fulfilled") {
      const liquid = hlR.value.markets.filter((m) => (m.volumeUsd || 0) >= LIQUID_VOL);
      for (const m of liquid) {
        if (m.fundingApr != null && Math.abs(m.fundingApr) >= 100 && (m.oiUsd || 0) >= 500_000) {
          const longsPay = m.fundingApr > 0;
          out.push({ id: `f:${m.coin}`, kind: "funding", coin: m.coin, value: Math.abs(m.fundingApr), title: `${m.coin} funding ${fmtApr(m.fundingApr)}`,
            detail: `${longsPay ? "Longs pay shorts" : "Shorts pay longs"} about ${Math.abs(m.fundingHrPct).toFixed(4)}% per hour at the current rate.` });
        }
        if (m.change24h != null && Math.abs(m.change24h) >= 12) {
          out.push({ id: `m:${m.coin}`, kind: "move", coin: m.coin, value: Math.abs(m.change24h), title: `${m.coin} ${m.change24h > 0 ? "up" : "down"} ${Math.abs(m.change24h).toFixed(1)}% in 24h`,
            detail: `24h volume $${(m.volumeUsd / 1e6).toFixed(1)}M, open interest $${((m.oiUsd || 0) / 1e6).toFixed(1)}M.` });
        }
      }
    }
    if (gainR.status === "fulfilled") {
      for (const t of gainR.value.tokens) {
        if ((t.volume24hUsd || 0) >= 25_000 && (t.realLiquidityUsd || 0) >= 7_500 && t.change24h != null && t.change24h >= 50) {   // money side, half the old two-sided $15K
          out.push({ id: `v:${t.address}`, kind: "volume", address: t.address, symbol: t.symbol, image: t.image || null, value: Math.min(t.change24h, 5000) / 10, title: `${t.symbol} ${fmtPct(t.change24h)} on Robinhood Chain`,
            detail: `${fmtUsd(t.volume24hUsd)} traded in 24h on ${LAUNCHPADS[t.launchpad] || t.launchpad}.` });
        }
      }
    }
    if (newR.status === "fulfilled") {
      const hourAgo = Date.now() - 3600_000;
      for (const t of newR.value.tokens) {
        if (t.createdAt && t.createdAt >= hourAgo && (t.volume24hUsd || 0) >= 2_000) {
          out.push({ id: `n:${t.address}`, kind: "new", address: t.address, symbol: t.symbol, image: t.image || null, value: t.volume24hUsd, title: `New on ${LAUNCHPADS[t.launchpad] || t.launchpad}: ${t.symbol}`,
            detail: `Launched ${Math.max(1, Math.round((Date.now() - t.createdAt) / 60000))} min ago, ${fmtUsd(t.volume24hUsd)} traded so far.` });
        }
      }
    }
    const byKind = {};
    for (const s of out.sort((a, b) => b.value - a.value)) (byKind[s.kind] ||= []).push(s);
    const order = ["funding", "move", "volume", "new"];
    const mixed = [];
    for (let i = 0; mixed.length < 16 && order.some((k) => byKind[k]?.[i]); i++) for (const k of order) if (byKind[k]?.[i] && mixed.length < 16) mixed.push(byKind[k][i]);
    return { signals: mixed, total: out.length, updatedAt: Date.now() };
  });
}

/* ---------------- routes ---------------- */
/* ---------------- one coin search: symbol, name or ticker, every source, a logo for each ---------------- */
// The board holds only the busiest coins, so a name search there misses most of the chain. This merges the majors,
// Robinhood's stock tokens, the board and DexScreener's search (every pool on Robinhood Chain by symbol and name),
// keeps one row per contract and says what each row is, so every caller can tell the real coin from the rest:
//   verified  a major (ETH, WETH, USDG, cbBTC), a Robinhood stock token or the official $TROYA (SITE.ca)
//   official  the official $TROYA
//   teamTest  one of the team's own test launches (launch.mjs isTeamTest: $TGtestTROYA carries the name "Troya Agent")
//   copy      reuses the ticker of a stock token, a major or the official coin, or of a bigger coin by volume or holders,
//             or mixes look-alike letters (sentry.mjs lookAlike). A hint for a "Copy?" marker: names stay free and no
//             row is ever dropped for it.
// Order: the match (exact ticker, then prefix, then name), then official and verified, then real backing (the money
// side of the pools: ETH, WETH, USDG, cbBTC or a stock token) with the 24h volume, then holders. Liquidity above
// 1000 x the day's volume is suspect (one ANT showed $417.8M of liquidity on $0.35 of volume) and goes last.
// Perps on Hyperliquid and trade.xyz that match by ticker or name come back beside the coins (perps: [...]).
const COIN_SEARCH = new Map();
const kindRank = (c) => (c.kind === "major" ? 0 : c.kind === "stock" ? 1 : 2);
// SITE.ca, the official $TROYA, as public/config.js has it
const SITE_CA = (() => { try { return lc((readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1]); } catch { return ""; } })();
const OFFICIAL_TICKER = "TROYA";
// the majors on Robinhood Chain, with the words people type for them ("btc" finds cbBTC, "ethereum" finds ETH)
const MAJORS = [
  ["native", "ETH", "Ether", ["eth", "ether", "ethereum"]],
  [lc(RH.weth), "WETH", "Wrapped Ether", ["weth", "eth", "ether", "ethereum"]],
  [lc(RH.usdg), "USDG", "Global Dollar", ["usdg"]],
  [CBBTC, "cbBTC", "Coinbase Wrapped BTC", ["cbbtc", "btc", "bitcoin"]],
];
// tickers that belong to a major (SOL has no Robinhood Chain token: a $SOL there borrows Solana's)
const MAJOR_TICKERS = { eth: "native", weth: lc(RH.weth), usdg: lc(RH.usdg), cbbtc: CBBTC, btc: CBBTC, sol: null };
// launch.mjs and sentry.mjs import this module, so they are loaded on first use; the fallbacks keep search answering
let flagMods = null;
const flagHelpers = () => (flagMods ||= Promise.all([import("./launch.mjs").catch(() => null), import("./sentry.mjs").catch(() => null)])
  .then(([l, s]) => ({
    isTeamTest: l?.isTeamTest || ((r) => [r?.symbol, r?.name].some((x) => /test/i.test(String(x || "")))),
    lookAlike: s?.lookAlike || ((r) => [r?.symbol, r?.name].some((x) => x && /[A-Za-z]/.test(x) && /[Ͱ-ϿЀ-ԯ]/.test(x))),
    tickerKey: s?.tickerKey || ((sym) => String(sym || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")),
  })));
// liquidity no trading explains: suspect, ranked last (never hidden)
const suspectLiq = (c) => !c.verified && (Number(c.liquidityUsd) || 0) > 1000 * Math.max(Number(c.volume24hUsd) || 0, 1);
// real backing with the day's trading: the money a seller could take out, and whether anyone trades it
const backing = (c) => Math.log10(1 + Math.max(0, Number(c.realLiquidityUsd) || 0)) + Math.log10(1 + Math.max(0, Number(c.volume24hUsd) || 0));
/** Marks rows in place: verified, official, teamTest, copy (see above). `extra`: other rows (the board, none of `rows`)
 *  that can own a ticker; only those under a ticker found in `rows` are looked at. */
async function flagCoins(rows, extra = []) {
  const H = await flagHelpers();
  const key = (s) => { try { return H.tickerKey(s); } catch { return String(s || "").toLowerCase(); } };
  const owner = new Map();                  // ticker → address that owns it outright (a stock token, a major, $TROYA)
  for (const [k, a] of Object.entries(MAJOR_TICKERS)) owner.set(k, a);
  for (const s of STOCKS) { const k = key(s.symbol); if (k && !owner.has(k)) owner.set(k, lc(s.address)); }
  if (SITE_CA) owner.set(key(OFFICIAL_TICKER), SITE_CA);
  for (const c of rows) {
    c.official = !!SITE_CA && c.address === SITE_CA;
    c.verified = c.official || c.kind === "major" || c.kind === "stock" || STOCK_SET.has(c.address);
    let tt = false;
    if (!c.verified) { try { tt = !!H.isTeamTest({ symbol: c.symbol, name: c.name }); } catch { tt = false; } }
    c.teamTest = tt;
  }
  // the biggest coin under each ticker (by 24h volume, then holders) among these rows and the board; suspect rows and
  // the team's tests never own a ticker
  const want = new Set(rows.map((c) => key(c.symbol)).filter(Boolean));
  const lead = new Map();
  const vol = (c) => Number(c.volume24hUsd) || 0, hold = (c) => Number(c.holders ?? holdersOf(c.address)?.count) || 0;
  const testOf = (c) => { if (c.teamTest != null) return c.teamTest; try { return !!H.isTeamTest({ symbol: c.symbol, name: c.name }); } catch { return false; } };
  for (const c of [...rows, ...extra]) {
    const k = key(c.symbol);
    if (!want.has(k) || owner.has(k) || suspectLiq(c) || testOf(c)) continue;
    const L = lead.get(k);
    if (!L || vol(c) > vol(L) || (vol(c) === vol(L) && hold(c) > hold(L))) lead.set(k, c);
  }
  for (const c of rows) {
    let copy = false;
    if (!c.verified) {
      let look = false; try { look = !!H.lookAlike({ symbol: c.symbol, name: c.name }); } catch {}
      const k = key(c.symbol), L = lead.get(k);
      copy = look || (owner.has(k) && owner.get(k) !== c.address)
        || (!!L && L.address !== c.address && (vol(L) > vol(c) || hold(L) > hold(c)));
    }
    c.copy = copy;
  }
  return rows;
}
// perps that match by ticker (without "xyz:") or by name: exact first, then prefix, then a word of the name
async function searchPerps(q, max = 5) {
  const ql = String(q || "").toLowerCase().replace(/^xyz:/, "").trim();
  if (ql.length < 2) return [];
  const d = await getHlMarkets().catch(() => null);
  const hitsOf = [];
  for (const m of d?.markets || []) {
    const label = String(m.coin).replace(/^xyz:/i, "").toLowerCase(), name = String(m.displayName || "").toLowerCase();
    const r = label === ql || name === ql ? 0 : label.startsWith(ql) ? 1 : name.startsWith(ql) ? 2 : name.split(/[\s&(),./-]+/).some((w) => w && w.startsWith(ql)) ? 3 : -1;
    if (r >= 0) hitsOf.push({ m, r });
  }
  hitsOf.sort((a, b) => a.r - b.r || (b.m.volumeUsd || 0) - (a.m.volumeUsd || 0));
  return hitsOf.slice(0, max).map(({ m }) => ({
    coin: m.coin, label: String(m.coin).replace(/^xyz:/i, ""), displayName: m.displayName || m.coin, dex: m.dex || null,
    venue: m.dex === "xyz" ? "trade.xyz" : "Hyperliquid", priceUsd: m.mark ?? null, change24h: m.change24h ?? null,
    maxLeverage: m.maxLeverage ?? null, volume24hUsd: m.volumeUsd ?? null, href: `#/perps/${m.coin}`,
  }));
}
const MAJOR_Q = /^(btc|bitcoin|cbbtc|eth|ether|ethereum|weth|sol|solana)$/;
// a side read that may not hold the search up: both are warm in memory; a cold start during an outage answers without
const within = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())]);
export async function searchCoins(q, limit = 12) {
  const raw = String(q || "").trim().replace(/^\$/, "").slice(0, 42);   // 42: a full 0x address must fit (it was cut to 40 and found nothing)
  limit = Math.max(1, Math.min(30, Number(limit) || 12));
  if (!raw) return { q: "", coins: [], perps: [] };
  if (ADDR_RE.test(raw)) {
    const a = lc(raw), major = MAJORS.find((m) => m[0] === a);
    const r = major ? null : await getRobinhoodToken(raw).catch(() => null), t = r?.token;
    const row = major ? { address: a, symbol: major[1], name: major[2], kind: "major", image: null, priceUsd: a === lc(RH.weth) ? await getEthUsd().catch(() => null) : null }
      : t ? { address: lc(t.address), symbol: t.symbol, name: t.name, kind: STOCK_SET.has(lc(t.address)) ? "stock" : "coin", image: t.image || null, priceUsd: t.priceUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, realLiquidityUsd: t.realLiquidityUsd ?? null, volume24hUsd: t.volume24hUsd ?? null, change24h: t.change24h ?? null, launchpad: t.launchpad || null, holders: t.holders ?? holdersOf(lc(t.address))?.count ?? null }
      : null;
    if (row?.kind === "stock") row.image = `/api/stocks/logo/${row.address}?v=4`;
    return { q: raw, coins: row ? await flagCoins([row], [...board.rows.values()].filter((x) => x.address !== row.address)) : [], perps: [] };
  }
  const ql = raw.toLowerCase();
  const perpsP = within(searchPerps(raw), 1500, []);
  const hit = COIN_SEARCH.get(ql);
  if (hit && Date.now() - hit.t < 60_000) return { ...hit.v, coins: hit.v.coins.slice(0, limit), perps: await perpsP };
  const ethUsd = await within(getEthUsd(), 1500, ETH_LAST);
  const out = new Map();
  const dsReal = new Map();                 // address → the money side summed over its DexScreener pairs
  // one row per coin, numbers from the best source: the board and the stock list win; DexScreener only fills gaps, and
  // among its pairs the deepest one gives price and change while volumes add up (a thin pair used to overwrite
  // $TROYA's numbers with $3.74 of volume, and the palette disagreed with the token page)
  const add = (c, src = "local") => {
    const a = lc(c.address); if (!a) return;
    const prev = out.get(a);
    if (!prev) { out.set(a, { ...c, address: a, _src: src, _dsLiq: src === "ds" ? c.liquidityUsd || 0 : 0, _dsVol: src === "ds" ? c.volume24hUsd || 0 : 0 }); return; }
    const fill = () => { for (const [k, v] of Object.entries(c)) if (v != null && prev[k] == null) prev[k] = v; };
    if (prev._src !== "ds" || src !== "ds") { if (src !== "ds" && prev._src === "ds") { const keep = { ...prev }; Object.assign(prev, c, { _src: src }); for (const [k, v] of Object.entries(keep)) if (prev[k] == null && v != null) prev[k] = v; } else fill(); return; }
    prev._dsVol += c.volume24hUsd || 0; prev.volume24hUsd = prev._dsVol;
    if ((c.liquidityUsd || 0) > (prev._dsLiq || 0)) { prev._dsLiq = c.liquidityUsd || 0; Object.assign(prev, { priceUsd: c.priceUsd ?? prev.priceUsd, change24h: c.change24h ?? prev.change24h, liquidityUsd: c.liquidityUsd ?? prev.liquidityUsd }); }
    fill();
  };
  const stockRows = new Map(((await getStocks().catch(() => null))?.stocks || []).map((x) => [lc(x.address), x]));
  const hits = (sym, name) => { const s = String(sym || "").toLowerCase(), n = String(name || "").toLowerCase(); if (s.length > 20 || n.length > 60) return false; return s.startsWith(ql) || n.includes(ql); };
  for (const [address, symbol, name, words] of MAJORS)
    if (hits(symbol, name) || words.some((w) => w.startsWith(ql))) add({ address, symbol, name, kind: "major", _words: words, priceUsd: address === "native" || address === lc(RH.weth) ? ethUsd : null });
  for (const s of STOCKS) if (hits(s.symbol, s.name)) { const r = stockRows.get(lc(s.address)) || {}; add({ address: s.address, symbol: s.symbol, name: String(s.name || "").replace(/\s•\s*Robinhood Token$/, ""), kind: "stock", image: IMAGES.get(lc(s.address)) || null,
    priceUsd: r.priceUsd ?? null, liquidityUsd: r.liquidityUsd ?? null, volume24hUsd: r.volume24hUsd ?? null, change24h: r.change24h ?? null, tradable: r.tradable ?? true }); }
  for (const t0 of board.rows.values()) if (hits(t0.symbol, t0.name)) {
    const t = honest(t0);   // the same price and money-side liquidity as the board and the coin page
    add({ address: t.address, symbol: t.symbol, name: t.name, kind: t.stock ? "stock" : "coin", image: t.image || null, priceUsd: t.priceUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, realLiquidityUsd: t.realLiquidityUsd ?? null, volume24hUsd: t.volume24hUsd ?? null, change24h: t.change24h ?? null, launchpad: t.launchpad || null });
  }
  try {
    const d = await memo(`ds:search:${ql}`, 60_000, () => getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(raw)}`, { timeout: 8000 }), { swr: 3 });
    for (const p of d?.pairs || []) {
      if (p.chainId !== "robinhood" || !p.baseToken?.address) continue;
      const b = p.baseToken, sym = String(b.symbol || "").replace(/\s•.*$/, ""), name = String(b.name || "").replace(/\s•\s*Robinhood Token$/, "");
      if (!hits(sym, name)) continue;                       // DexScreener also matches on the quote token
      const a = lc(b.address);
      if (/^0x0{40}$/.test(a)) continue;                    // native ETH in v4 pools: the ETH row above covers it
      // the money side of this pair: 0 when its other side is not money (another memecoin)
      const real = realFromPairs([p], a, ethUsd);
      if (real != null) dsReal.set(a, (dsReal.get(a) || 0) + real);
      add({ address: a, symbol: sym, name, kind: STOCK_SET.has(a) ? "stock" : "coin", image: goodImg(p.info?.imageUrl), priceUsd: fnum(p.priceUsd), liquidityUsd: fnum(p.liquidity?.usd),
        volume24hUsd: fnum(p.volume?.h24), change24h: fnum(p.priceChange?.h24), launchpad: padOfDex(`${p.dexId || "other"}${p.labels?.[0] ? "-" + p.labels[0] : ""}`) || null,
        tradable: /^uniswap/.test(String(p.dexId || "")) || KYBER_ON || null }, "ds");
    }
  } catch { /* the local sources still answer */ }
  for (const c of out.values()) {
    if (c.realLiquidityUsd == null && dsReal.has(c.address)) c.realLiquidityUsd = dsReal.get(c.address);
    if (c.holders == null) c.holders = holdersOf(c.address)?.count ?? null;
  }
  // the board's rows can own a ticker found here too (a bigger coin the query did not match by name)
  await flagCoins([...out.values()], [...board.rows.values()].filter((t) => !out.has(t.address)));
  // a stock whose company name is the query ("tesla" → Tesla, TSLA) and a major by the word people use ("btc" → cbBTC)
  // rank with exact ticker matches
  const firstWord = (n) => String(n || "").replace(/\s•.*$/, "").toLowerCase().split(/[\s,.]+/)[0];
  const rank = (c) => {
    const s = String(c.symbol).toLowerCase(), n = String(c.name || "").toLowerCase();
    if (c.kind === "stock" && (n === ql || firstWord(n) === ql)) return 0;
    if (c.kind === "major" && c._words?.includes(ql)) return 0;
    return s === ql ? 0 : s.startsWith(ql) ? 1 : n === ql || n.startsWith(ql) ? 2 : 3;
  };
  for (const c of out.values()) { c._rank = rank(c); c._sus = suspectLiq(c) ? 1 : 0; c._score = backing(c); }
  let coins = [...out.values()].sort((x, y) => x._sus - y._sus || x._rank - y._rank || y.official - x.official || y.verified - x.verified || kindRank(x) - kindRank(y)
    || x.teamTest - y.teamTest || x.copy - y.copy || y._score - x._score || (y.holders || 0) - (x.holders || 0) || (y.liquidityUsd || 0) - (x.liquidityUsd || 0));
  coins = coins.map(({ _src, _dsLiq, _dsVol, _words, _rank, _sus, _score, ...c }) => ({ ...c, image: c.kind === "stock" ? `/api/stocks/logo/${c.address}?v=4` : c.image || null }));
  const v = { q: raw, coins, majorQuery: MAJOR_Q.test(ql), sources: ["Troya index", "Robinhood stock tokens", "DexScreener", "Hyperliquid"], updatedAt: Date.now() };
  COIN_SEARCH.set(ql, { t: Date.now(), v });
  if (COIN_SEARCH.size > 500) COIN_SEARCH.delete(COIN_SEARCH.keys().next().value);
  return { ...v, coins: coins.slice(0, limit), perps: await perpsP };
}

export function hlMovers(markets, { top = 7, sort = "change" } = {}) {
  const n = Math.max(1, Math.min(Number(top) || 7, 25));
  const liquid = (markets || []).filter((x) => (x.volumeUsd || 0) >= 1e6 && x.change24h != null);
  const by = sort === "volume" ? (x) => x.volumeUsd || 0 : (x) => Math.abs(x.change24h);
  return { markets: liquid.sort((a, b) => by(b) - by(a)).slice(0, n).map((x) => ({ coin: x.coin, displayName: x.displayName || undefined, mark: x.mark, change24h: x.change24h, volumeUsd: x.volumeUsd, oiUsd: x.oiUsd, fundingApr: x.fundingApr })) };
}

export async function register(r) {
  // the $TROYA chart is the most opened one: read its curve and pool history once at start, so nobody waits for it
  setTimeout(() => {
    try { const ca = (readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1]; if (ca) chainTrades(lc(ca)).catch(() => {}); } catch { /* no config */ }
  }, 15_000).unref?.();
  r.get("/api/search/coins", ({ query }) => searchCoins(query.q, query.limit), { weight: 1, perMin: 240 });
  r.get("/api/market/robinhood/holders", async ({ query }) => {
    const a = lc(query.address);
    if (!ADDR_RE.test(a)) throw httpErr(400, "That is not a valid token address.");
    const t = BS_KEY && !bsDown() ? await topHolders(a).catch(() => null) : null;
    if (t) {
      // one number everywhere: the stats line and the Holders tab read the same count
      HOLDERS.set(a, { count: t.count, top10: t.top10 != null ? +t.top10.toFixed(2) : null, at: Date.now() });
      const row = board.rows.get(a); if (row) { row.holders = t.count; row.top10Pct = t.top10; }
      return { ...t, source: "Blockscout" };
    }
    // Blockscout paused or failing: the count and the top-10 share from GeckoTerminal, without the per-wallet list
    const g = await geckoHolders(a).catch(() => null);
    if (!g || g.count == null) throw httpErr(503, "Holder data is unavailable right now. Try again in a few minutes.");
    return { count: g.count, top10: g.top10, holders: [], source: "GeckoTerminal", note: "The list of top wallets is unavailable right now; the holder count and the top-10 share are live." };
  }, { weight: 2, perMin: 60 });
  r.get("/api/market/robinhood", ({ query }) => getRobinhoodTokens(query), { weight: 1 });
  // now: the server's clock, so a page can say how old a price is even when the viewer's clock is off
  r.get("/api/market/robinhood/token", async ({ query }) => ({ ...(await getRobinhoodToken(query.address)), now: Date.now() }), { weight: 2 });
  r.get("/api/market/queue", () => ({ gecko: geckoQueue(), at: Date.now() }), { perMin: 30 });
  r.get("/api/market/robinhood/candles", ({ query }) => getRobinhoodCandles(query.address, query.interval), { weight: 1 });
  r.get("/api/market/robinhood/trades", ({ query }) => getRobinhoodTrades(query.address), { weight: 1 });
  r.get("/api/market/stocks", () => getStocks(), { weight: 1 });
  r.get("/api/market/launchpads", () => ({ launchpads: LAUNCHPADS }));
  r.get("/api/market/hl", async ({ query }) => {
    const d = await getHlMarkets();
    let m = d.markets;
    if (query.dex === "main") m = m.filter((x) => !x.dex);
    else if (query.dex) m = m.filter((x) => x.dex === query.dex);
    // ?top=7&sort=change: the Desk's movers (21 Nov 2026: it downloaded every market, ~92 KB, to show 7 rows). Liquid perps
    // only ($1M+ volume), ranked by the size of the 24 h move, with just the fields the movers table draws.
    if (query.top) return hlMovers(m, query);
    return { ...d, markets: m };
  });
  r.get("/api/market/hl/spot", () => getHlSpot());
  r.get("/api/market/hl/candles", ({ query }) => getHlCandles(query.coin, query.interval, query.hours));
  r.get("/api/market/hl/sparks", async ({ query }) => {
    const coins = String(query.coins || "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9:@/_-]{1,32}$/.test(s)).slice(0, 12);
    const res = await Promise.allSettled(coins.map((c) => getHlCandles(c, "1h", 24)));
    return { sparks: Object.fromEntries(coins.map((c, i) => [c, res[i].status === "fulfilled" ? res[i].value.candles.map((x) => x.close) : []])) };
  });
  r.get("/api/price/eth", async () => ({ symbol: "ETH", usd: await getEthUsd(), source: "Hyperliquid mid", at: Date.now() }));
  r.get("/api/brief", () => getBrief());
  r.get("/api/signals", () => getSignals());
  if (process.env.TROYA_BOARD !== "0") {
    startBoard(); setTimeout(() => getStocks().catch(() => {}), 3000).unref?.();
    // keep warm what every page and search reads, so no visitor pays the source's 0.7-1.8 s when an entry expires: the
    // ETH price (one allMids read, weight 2), the Hyperliquid perps lists (the same reads as /api/hl/meta), spot, and the
    // stock tokens (seven DexScreener calls). Each tick refreshes only an entry past its ttl.
    const warm = (fn, ms) => { setTimeout(() => fn().catch(() => {}), 5000).unref?.(); setInterval(() => fn().catch(() => {}), ms).unref?.(); };
    warm(getEthUsd, 15_000); warm(getHlMarkets, 20_000); warm(getHlSpot, 60_000); warm(getStocks, 2 * 60_000);
    // the 20 most traded stock tokens' pools, read from the chain at start and kept current, like $TROYA's curve above
    setTimeout(() => warmStockCharts().catch(() => {}), 45_000).unref?.();
    setInterval(() => warmStockCharts().catch(() => {}), 2 * 60_000).unref?.();
  }
}
