// Market data: Robinhood Chain token board (GeckoTerminal pools across Pons, Clanker, Bankr, Virtuals, Uniswap … plus
// on-chain Pons state), tokenized stocks, Hyperliquid perps + spot, ETH price, a computed brief and live signals.
// Everything here is read-only and cached in memory; when a source fails the last good copy is served with `stale: true`.
// GeckoTerminal's public API allows about 30 calls a minute, so every call goes through one paced queue
// (user-facing reads jump ahead of the background index refresh).
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { KYBER_ON } from "./kyber.mjs";
import { noteV4, ponsState, ponsPublic, ponsProfile, STOCKS, ADDR as RH } from "./robinhood.mjs";

const UA = { "user-agent": "troya-agent/0.2 (+market-reader)", accept: "application/json" };
const HL = "https://api.hyperliquid.xyz/info";
const GECKO = "https://api.geckoterminal.com/api/v2";
const NET = "robinhood";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const STOCK_SET = new Set(STOCKS.map((s) => String(s.address).toLowerCase()));
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
function gecko(pathQs, { hi = false } = {}) {
  return new Promise((resolve, reject) => {
    (hi ? gq.hi : gq.lo).push({ pathQs, resolve, reject, hi, queuedAt: Date.now() });
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
      try { job.resolve(await getJson(`${GECKO}/networks/${NET}/${job.pathQs}`, { timeout: 15000 })); }
      catch (e) {
        if (e.status === 429 && (job.tries || 0) < 2) {
          job.tries = (job.tries || 0) + 1;
          gq.last = Date.now() + 20_000;           // back off, then retry this job first
          (job.hi ? gq.hi : gq.lo).unshift(job);
          continue;
        }
        job.reject(e);
      }
    }
  } finally { gq.busy = false; }
}

const cache = new Map(); // key → { t, value, p }
async function memo(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit?.value !== undefined && now - hit.t < ttl) return hit.value;
  if (hit?.p) return hit.p;
  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { t: Date.now(), value });
      return value;
    } catch (e) {
      if (hit?.value !== undefined) {
        cache.set(key, { t: hit.t, value: hit.value });
        const v = hit.value;
        return v && typeof v === "object" && !Array.isArray(v) ? { ...v, stale: true, staleReason: e.message } : v;
      }
      cache.delete(key);
      throw e;
    }
  })();
  cache.set(key, { ...(hit || {}), p });
  if (cache.size > 2000) for (const [k, v] of cache) if (now - v.t > 600_000) cache.delete(k);
  return p;
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
export async function dsPairs(addrs) {
  const list = [...new Set(addrs.map(lc))].filter((a) => ADDR_RE.test(a));
  const out = [];
  for (let i = 0; i < list.length; i += 30) {
    const part = list.slice(i, i + 30);
    const d = await memo(`ds:${part.join(",")}`, 60_000, () => getJson(DS + part.join(","), { timeout: 12000 }));
    if (Array.isArray(d)) out.push(...d);
  }
  return out;
}
// best DexScreener pair per base token (deepest liquidity) → board-style row
export function dsRows(pairs, ethUsd) {
  const best = new Map();
  for (const p of pairs || []) {
    const a = lc(p.baseToken?.address);
    if (!a) continue;
    const cur = best.get(a);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(a, p);
  }
  const rows = new Map();
  for (const [a, p] of best) {
    const dex = `${p.dexId || "other"}${p.labels?.[0] ? "-" + p.labels[0] : ""}`;
    const priceUsd = fnum(p.priceUsd);
    const tx = p.txns?.h24 || {};
    const sym = (s) => String(s || "").replace(/\s•.*$/, "");
    rows.set(a, {
      address: a, name: String(p.baseToken?.name || "").replace(/\s•\s*Robinhood Token$/, ""), symbol: sym(p.baseToken?.symbol), image: goodImg(p.info?.imageUrl),
      priceUsd, priceEth: priceUsd && ethUsd ? priceUsd / ethUsd : null, change24h: fnum(p.priceChange?.h24), change1h: fnum(p.priceChange?.h1),
      volume24hUsd: fnum(p.volume?.h24), volume24hEth: ethUsd && p.volume?.h24 != null ? p.volume.h24 / ethUsd : null,
      liquidityUsd: fnum(p.liquidity?.usd), liquidityEth: ethUsd && p.liquidity?.usd != null ? p.liquidity.usd / ethUsd : null,
      mcapUsd: fnum(p.marketCap) ?? fnum(p.fdv), mcapEth: ethUsd && (p.marketCap ?? p.fdv) ? (p.marketCap ?? p.fdv) / ethUsd : null,
      buys24h: tx.buys ?? null, sells24h: tx.sells ?? null, txns24h: tx.buys != null ? (tx.buys || 0) + (tx.sells || 0) : null,
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
export async function getEthUsd() {
  return memo("ethUsd", 10_000, async () => {
    try {
      const mids = await hl({ type: "allMids" }, 6000);
      const v = fnum(mids?.ETH);
      if (v) return v;
      throw new Error("ETH mid missing");
    } catch {
      const d = await gecko(`tokens/${RH.weth.toLowerCase()}`, { hi: true });
      const v = fnum(d?.data?.attributes?.price_usd);
      if (!v) throw new Error("No ETH price available");
      return v;
    }
  });
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
const HUBS = new Set([lc(RH.weth), lc(RH.usdg), "0x0000000000000000000000000000000000000000"]);
const board = { rows: new Map(), updatedAt: 0, refreshing: null, error: null, volumeUsd: 0, cursor: 0 };
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
  } catch {}
})();
function saveBoard() {
  if (!BOARD_FILE || boardSaveTimer) return;
  boardSaveTimer = setTimeout(async () => {
    boardSaveTimer = null;
    try {
      const tmp = BOARD_FILE + ".tmp";
      await writeFile(tmp, JSON.stringify({ updatedAt: board.updatedAt, volumeUsd: board.volumeUsd, cursor: board.cursor, rows: [...board.rows.values()].map(clean) }));
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
    volumeUsd: fnum(a.volume_usd?.h24) || 0, liquidityUsd: fnum(a.reserve_in_usd), mcapUsd: fnum(a.market_cap_usd) ?? fnum(a.fdv_usd), fdvUsd: fnum(a.fdv_usd),
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
  const pad = padOfDex(pr.dex);
  if (LAUNCH_PADS.has(pad) || (!LAUNCH_PADS.has(t.launchpad) && t.launchpad === "other")) t.launchpad = LAUNCH_PADS.has(t.launchpad) ? t.launchpad : pad;
  if (ROUTABLE(pr.dex)) t.tradable = true;
  if (!t._main || (pr.liquidityUsd || 0) > (t._main.liquidityUsd || 0)) {
    t._main = pr;
    Object.assign(t, { priceUsd: pr.priceUsd, priceEth: pr.priceEth, change24h: pr.change24h, change1h: pr.change1h, liquidityUsd: pr.liquidityUsd, mcapUsd: pr.mcapUsd,
      pool: pr.pool, poolDex: pr.dex, quoteSymbol: pr.quoteSymbol });
  }
  t.volume24hEth = ethUsd ? t.volume24hUsd / ethUsd : null;
  t.liquidityEth = ethUsd && t.liquidityUsd != null ? t.liquidityUsd / ethUsd : null;
  // Pons: 1B minted once; only when it fits the pool (a broken dust-pool price would give an absurd number)
  if (!(t.mcapUsd > 0) && t.launchpad === "pons" && t.priceUsd > 0 && t.liquidityUsd > 0 && t.priceUsd * 1e9 <= t.liquidityUsd * 400) t.mcapUsd = t.priceUsd * 1e9;
  t.mcapEth = ethUsd && t.mcapUsd != null ? t.mcapUsd / ethUsd : null;
  if (t.image) IMAGES.set(t.address, t.image);
}
const clean = (t) => { const { _main, _pick, ...rest } = t; return rest; };
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
    publish(map, { full: ok >= PAGES.length * 0.75 });
    try { noteV4(v4seen); } catch {}
    board.error = null;
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
    return { count: tok?.holders_count != null ? Number(tok.holders_count) : null, top10: items.slice(0, 10).reduce((s, x) => s + (x.pct || 0), 0), holders: items };
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
async function holdersTick() {
  if (holdersBusy || ((!BS_KEY || bsDown()) && (gq.hi.length || gq.lo.length > 1))) return;   // GeckoTerminal fallback: users and the board first
  const now = Date.now();
  const next = [...board.rows.values()].filter((t) => { const h = HOLDERS.get(t.address); return !h || now - h.at > 6 * 3600_000; })
    .sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))[0];
  if (!next) return;
  holdersBusy = true;
  try { await fetchHolders(next.address); } catch { HOLDERS.set(next.address, { ...(HOLDERS.get(next.address) || {}), at: now - 5 * 3600_000 }); } finally { holdersBusy = false; }
}
setInterval(() => holdersTick().catch(() => {}), BS_KEY ? 4_000 : 20_000).unref();
const holdersOf = (a) => HOLDERS.get(a) || null;
/* Troya picks: a read of live data, never advice. A coin needs a real pool and real trading, then earns points for
   buyers outnumbering sellers, holders spread out, volume a pool can carry (not wash trading), listed socials and a day
   that is not a collapse. Each pick says why, in a few words. */
const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`);
function pickCoins(rows) {
  const out = [];
  for (const t of rows) {
    const liq = t.liquidityUsd || 0, vol = t.volume24hUsd || 0, tx = t.txns24h || 0, ch = t.change24h;
    if (liq < 10_000 || tx < 40 || vol < 2_000 || ch == null || ch <= -40) continue;
    const turn = vol / liq;
    if (turn > 25) continue;                                   // more volume than the pool could carry: likely wash trading
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
    if (turn >= 0.3 && turn <= 6) { score += 1.5; }
    if (h?.count != null) {
      score += Math.min(3, Math.log10(Math.max(1, h.count)) - 1.5);
      if (h.top10 != null) score += h.top10 < 45 ? 1.5 : h.top10 > 65 ? -1.5 : 0;
      if (h.count >= 150) why.push(`${h.count.toLocaleString("en-US")} holders${h.top10 != null && h.top10 < 55 ? `, top 10 hold ${Math.round(h.top10)}%` : ""}`);
    }
    if (soc && (soc.twitter || soc.telegram || soc.website)) { score += 1; }
    if (ch >= 10) { score += Math.min(2, ch / 25); why.push(`up ${Math.round(ch)}% today`); } else if (ch <= -15) score -= 1;
    why.unshift(`${money(liq)} pool, ${money(vol)} traded`);
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
  for (const t of map.values()) t.seenAt = now;          // rows this pass reached
  // keep tokens from earlier passes that this pass did not reach (pages shift as volume moves); after a complete pass
  // they go once unseen for 30 minutes, while a pass is still running or was cut short by 429s they stay up to 6 hours
  const keep = full ? 30 * 60_000 : BOARD_MAX_AGE;
  const next = new Map(map);
  for (const [a, t] of board.rows) if (!next.has(a) && now - (t.seenAt || 0) < keep) next.set(a, t);
  board.rows = next;
  board.updatedAt = now;
  board.volumeUsd = [...next.values()].reduce((s, t) => s + (t.volume24hUsd || 0), 0);
  saveBoard();
}
let boardTimer = null;
function startBoard() {
  if (boardTimer) return;
  refreshBoard().catch((e) => console.warn("[market] board:", e.message));
  boardTimer = setInterval(() => refreshBoard().catch((e) => console.warn("[market] board:", e.message)), 8 * 60_000);
  boardTimer.unref?.();
}
async function ensureBoard() {
  if (board.rows.size) return;
  startBoard();
  // first request after boot: wait for the first page or two
  for (let i = 0; i < 40 && !board.rows.size; i++) await new Promise((r) => setTimeout(r, 500));
  if (!board.rows.size) throw httpErr(503, `The Robinhood Chain board is still loading${board.error ? ` (${board.error})` : ""}. Try again in a few seconds.`);
}
/** index row for a token (used by swap quotes for pool depth) */
export const indexRow = (address) => board.rows.get(lc(address)) || null;

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
const SORT_KEY = { volume: "volume24hUsd", mcap: "mcapUsd", change: "change24h", liquidity: "liquidityUsd", newest: "createdAt", price: "priceUsd", txns: "txns24h", holders: "holders" };

// getRobinhoodTokens({q, launchpad, sort, dir, offset, limit, tradable}) → {tokens,total,counts,updatedAt,stale,ethUsd,source,...}
export async function getRobinhoodTokens(opts = {}) {
  const o = cleanOpts(opts);
  await ensureBoard();
  if (Date.now() - board.updatedAt > 10 * 60_000) refreshBoard().catch(() => {});
  const ethUsd = await getEthUsd().catch(() => null);
  let all = [...board.rows.values()].filter((t) => !t.stock);
  // copies: when several coins share a ticker, the one with the most holders (then the oldest) is the original; the others
  // are marked copyOf and kept out of Trending, Troya picks and "Busiest today"
  const bySym = new Map();
  for (const t of all) { const k = String(t.symbol || "").toLowerCase(); if (!k) continue; if (!bySym.has(k)) bySym.set(k, []); bySym.get(k).push(t); }
  const holdersOf = (t) => HOLDERS.get(t.address)?.count ?? 0;
  for (const g of bySym.values()) {
    if (g.length < 2) { g[0].copyOf = null; continue; }
    const orig = [...g].sort((a, b) => (holdersOf(b) - holdersOf(a)) || ((a.createdAt || Infinity) - (b.createdAt || Infinity)))[0];
    for (const t of g) t.copyOf = t === orig ? null : orig.address;
  }
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
  const isTrend = (t) => !t.copyOf && (t.volume24hUsd || 0) >= 1000 && (t.txns24h || 0) >= 20;
  const picked = pickCoins(rows.filter((t) => !t.copyOf));
  const catCounts = { all: rows.length, picks: picked.length, trending: rows.filter(isTrend).length, new: rows.filter(isNew).length, bonding: rows.filter(onCurve).length };
  if (o.cat === "picks") rows = picked;
  else if (o.cat === "trending") rows = rows.filter(isTrend);
  else if (o.cat === "new") rows = rows.filter(isNew);
  else if (o.cat === "bonding") rows = rows.filter(onCurve);
  const hidden = o.tradable ? (o.launchpad === "all" ? all.length - routable.length : all.filter((t) => t.launchpad === o.launchpad && !t.tradable).length) : 0;
  const k = SORT_KEY[o.sort];
  const sgn = o.dir === "asc" ? 1 : -1;
  if (k === "holders") for (const t of rows) t.holders = HOLDERS.get(t.address)?.count ?? null;
  if (o.sort !== "picks") rows = [...rows].sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * sgn;
  });
  return {
    catCounts, cat: o.cat,
    tokens: rows.slice(o.offset, o.offset + o.limit).map((t) => { const r = { ...clean(t), pick: t._pick || undefined, spark: sparkOf(t), socials: socialOf(t.address), holders: holdersOf(t.address)?.count ?? null, top10Pct: holdersOf(t.address)?.top10 ?? null }; if (!(r.mcapUsd > 0) && r.launchpad === "pons" && r.priceUsd > 0 && r.liquidityUsd > 0 && r.priceUsd * 1e9 <= r.liquidityUsd * 400) { r.mcapUsd = r.priceUsd * 1e9; r.mcapEth = ethUsd ? r.mcapUsd / ethUsd : null; } return r; }), total: rows.length, counts, hiddenTotal: hidden,
    volume24hUsd: board.volumeUsd, volume24hEth: ethUsd ? board.volumeUsd / ethUsd : null,
    offset: o.offset, limit: o.limit, sort: o.sort, dir: o.dir, launchpad: o.launchpad,
    updatedAt: board.updatedAt, stale: !!board.error, notice: board.error ? `Last refresh failed (${board.error}); showing the previous board.` : null,
    source: "GeckoTerminal + Robinhood Chain RPC", ethUsd,
  };
}

// getRobinhoodToken(address) → {token, pons, links, sources}  (fast: board row or DexScreener + Pons read on chain)
export async function getRobinhoodToken(address) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const a = lc(address);
  return memo(`rh:token:${a}`, 30_000, async () => {
    const ethUsd = await getEthUsd().catch(() => null);
    const [ds, ps, prof] = await Promise.allSettled([dsPairs([a]).then((x) => dsRows(x, ethUsd).get(a) || null), ponsState(a), ponsProfile(a)]);
    let row = board.rows.get(a) ? clean(board.rows.get(a)) : null;
    if (!HOLDERS.has(a)) await Promise.race([fetchHolders(a, { hi: true }).catch(() => null), new Promise((r) => setTimeout(r, 4000))]);
    const dsr = ds.status === "fulfilled" ? ds.value : null;
    const pons = ps.status === "fulfilled" && ps.value ? ponsPublic(ps.value) : null;
    // a Pons token still on its curve trades on the curve; a stray DEX pair thinner than the curve (e.g. a $0.40 dust
    // pool) would show a wrong price and liquidity, so it is ignored for numbers (its links and image are still used)
    const curveLive = !!(pons && !pons.graduated && pons.priceInPair > 0 && pons.pair?.address === "native");
    const dsThin = !!(dsr && curveLive && (dsr.liquidityUsd || 0) < pons.raised * (ethUsd || 0));
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
    const token = row ? { ...row } : { address: a, name: "", symbol: "", launchpad: "pons", tradable: true, pools: [] };
    { const hd = HOLDERS.get(a); if (hd?.count != null) { token.holders = hd.count; token.top10Pct = hd.top10; } }
    if (pons) { token.launchpad = "pons"; token.tradable = true; }
    if (curveLive && token.priceUsd == null) {
      // numbers straight from the curve: price from its reserves, liquidity = ETH actually raised on it
      token.priceEth = pons.priceInPair; token.priceUsd = ethUsd ? pons.priceInPair * ethUsd : null;
      token.liquidityEth = pons.raised; token.liquidityUsd = ethUsd ? pons.raised * ethUsd : null;
      if (dsr?.mcapUsd && dsr.priceUsd) { token.mcapUsd = dsr.mcapUsd * (token.priceUsd / dsr.priceUsd); token.mcapEth = ethUsd ? token.mcapUsd / ethUsd : null; }
    }
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
      sources: [board.rows.get(a) ? "GeckoTerminal" : dsr ? "DexScreener" : null, pons ? "Pons factory (on chain)" : null].filter(Boolean),
      updatedAt: Date.now(),
    };
  });
}
// recent trades of a token's main pool (GeckoTerminal), loaded after the token page renders
export async function getRobinhoodTrades(address) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const a = lc(address);
  const pool = board.rows.get(a)?.pool || (await getRobinhoodToken(a)).token?.pool;
  if (!pool) return { trades: [], pool: null };
  return memo(`rh:trades:${pool}`, 60_000, async () => {
    const t = await gecko(`pools/${pool}/trades`, { hi: true });
    const trades = (t.data || []).slice(0, 50).map((x) => {
      const v = x.attributes || {};
      const buy = v.kind === "buy";
      return { t: Date.parse(v.block_timestamp || "") || null, side: buy ? "buy" : "sell", trader: v.tx_from_address, tx: v.tx_hash, usd: fnum(v.volume_in_usd),
        tokens: fnum(buy ? v.to_token_amount : v.from_token_amount), quote: fnum(buy ? v.from_token_amount : v.to_token_amount) };
    });
    return { trades, pool, source: "GeckoTerminal", updatedAt: Date.now() };
  });
}

// candles for a Robinhood token's main pool, in USD: [{time(sec), open, high, low, close, volume}]
const GT_TF = { "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };
// bg: a background job (the Record back-fill, smart DCA sizing) waits behind people loading a chart or a range
export async function getRobinhoodCandles(address, interval = "1h", { bg = false } = {}) {
  if (!ADDR_RE.test(String(address || ""))) throw httpErr(400, "That is not a valid token address.");
  const iv = GT_TF[interval] ? interval : "1h";
  const a = lc(address);
  return memo(`rh:candles:${a}:${iv}`, iv === "5m" || iv === "15m" ? 2 * 60_000 : 5 * 60_000, async () => {
    let pool = board.rows.get(a)?.pool;
    if (!pool) pool = (await getRobinhoodToken(a)).token?.pool;
    if (!pool) throw httpErr(404, "No pool to chart for this token yet.");
    const [tf, agg] = GT_TF[iv];
    const d = await gecko(`pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=300&currency=usd&token=${a}`, { hi: !bg });
    const c = (d?.data?.attributes?.ohlcv_list || []).map((x) => ({ time: Number(x[0]), open: fnum(x[1]), high: fnum(x[2]), low: fnum(x[3]), close: fnum(x[4]), volume: fnum(x[5]) }))
      .filter((x) => x.close != null).sort((x, y) => x.time - y.time);
    return { candles: c, interval: iv, source: "GeckoTerminal", unit: "USD", pool };
  });
}

/* ---------------- tokenized stocks ---------------- */
export async function getStocks() {
  return memo("rh:stocks", 2 * 60_000, async () => {
    const ethUsd = await getEthUsd().catch(() => null);
    const rows = dsRows(await dsPairs(STOCKS.map((x) => x.address)), ethUsd);
    const stocks = STOCKS.map((x) => {
      const a = lc(x.address), r = rows.get(a);
      if (r?.image) IMAGES.set(a, r.image);
      return { address: a, symbol: x.symbol, name: x.name, decimals: x.decimals, priceUsd: r?.priceUsd ?? null, priceEth: r?.priceEth ?? null, change24h: r?.change24h ?? null,
        volume24hUsd: r?.volume24hUsd ?? null, liquidityUsd: r?.liquidityUsd ?? null, mcapUsd: r?.mcapUsd ?? null, image: r?.image || null, pool: r?.pool || null, poolDex: r?.poolDex || null, tradable: !!r?.tradable };
    });
    if (!stocks.some((x) => x.priceUsd != null)) throw new Error("DexScreener returned no stock prices");
    return { stocks, updatedAt: Date.now(), source: "DexScreener (on-chain pools)", ethUsd };
  });
}

/* ---------------- Hyperliquid ---------------- */
function normPerp(u, c, dex) {
  const mark = fnum(c.markPx), prev = fnum(c.prevDayPx), oracle = fnum(c.oraclePx), funding = fnum(c.funding), oi = fnum(c.openInterest);
  return {
    coin: u.name, dex: dex || null, mark, mid: fnum(c.midPx), oracle,
    change24h: mark && prev ? (mark / prev - 1) * 100 : null,
    fundingHr: funding, fundingHrPct: funding != null ? funding * 100 : null, fundingApr: funding != null ? funding * 24 * 365 * 100 : null,
    oiUsd: oi != null && oracle ? oi * oracle : null, volumeUsd: fnum(c.dayNtlVlm),
    maxLeverage: u.maxLeverage, szDecimals: u.szDecimals, delisted: !!u.isDelisted, onlyIsolated: !!u.onlyIsolated,
  };
}
// getHlMarkets() → {markets:[...], updatedAt}
export async function getHlMarkets() {
  return memo("hl:markets", 8_000, async () => {
    const [main, xyz] = await Promise.allSettled([hl({ type: "metaAndAssetCtxs" }), hl({ type: "metaAndAssetCtxs", dex: "xyz" })]);
    if (main.status !== "fulfilled") throw new Error(`Hyperliquid unavailable: ${main.reason?.message}`);
    const out = [];
    const add = ([meta, ctxs], dex) => meta.universe.forEach((u, i) => { if (ctxs[i]) out.push(normPerp(u, ctxs[i], dex)); });
    add(main.value, null);
    if (xyz.status === "fulfilled") add(xyz.value, "xyz");
    return { markets: out.filter((m) => !m.delisted), updatedAt: Date.now(), dexes: xyz.status === "fulfilled" ? ["main", "xyz"] : ["main"] };
  });
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
      const gain = [...e.tokens].filter((t) => t.change24h != null && (t.volume24hUsd || 0) >= 20_000 && (t.liquidityUsd || 0) >= 20_000).sort((a, b) => b.change24h - a.change24h)[0];
      let text = `Robinhood Chain: ${top.symbol} leads 24h volume with ${fmtUsd(top.volume24hUsd || 0)} traded${top.change24h != null ? ` (${fmtPct(top.change24h)})` : ""}`;
      if (e.volume24hUsd) text += `, out of ${fmtUsd(e.volume24hUsd)} across tracked pools`;
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
        if ((t.volume24hUsd || 0) >= 25_000 && (t.liquidityUsd || 0) >= 15_000 && t.change24h != null && t.change24h >= 50) {
          out.push({ id: `v:${t.address}`, kind: "volume", address: t.address, value: Math.min(t.change24h, 5000) / 10, title: `${t.symbol} ${fmtPct(t.change24h)} on Robinhood Chain`,
            detail: `${fmtUsd(t.volume24hUsd)} traded in 24h on ${LAUNCHPADS[t.launchpad] || t.launchpad}.` });
        }
      }
    }
    if (newR.status === "fulfilled") {
      const hourAgo = Date.now() - 3600_000;
      for (const t of newR.value.tokens) {
        if (t.createdAt && t.createdAt >= hourAgo && (t.volume24hUsd || 0) >= 2_000) {
          out.push({ id: `n:${t.address}`, kind: "new", address: t.address, value: t.volume24hUsd, title: `New on ${LAUNCHPADS[t.launchpad] || t.launchpad}: ${t.symbol}`,
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
// keeps one row per contract, puts the real one first (exact match, then official, then liquidity) and marks tiny
// copies that borrow a bigger coin's ticker.
const COIN_SEARCH = new Map();
const kindRank = (c) => (c.kind === "major" ? 0 : c.kind === "stock" ? 1 : 2);
export async function searchCoins(q, limit = 12) {
  const raw = String(q || "").trim().replace(/^\$/, "").slice(0, 40);
  limit = Math.max(1, Math.min(30, Number(limit) || 12));
  if (!raw) return { q: "", coins: [] };
  if (ADDR_RE.test(raw)) {
    const r = await getRobinhoodToken(raw).catch(() => null), t = r?.token;
    return { q: raw, coins: t ? [{ address: lc(t.address), symbol: t.symbol, name: t.name, kind: STOCK_SET.has(lc(t.address)) ? "stock" : "coin", image: t.image || null, priceUsd: t.priceUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, volume24hUsd: t.volume24hUsd ?? null, change24h: t.change24h ?? null, launchpad: t.launchpad || null }] : [] };
  }
  const ql = raw.toLowerCase();
  const hit = COIN_SEARCH.get(ql);
  if (hit && Date.now() - hit.t < 60_000) return { ...hit.v, coins: hit.v.coins.slice(0, limit) };
  const out = new Map();
  const add = (c) => {
    const a = lc(c.address); if (!a) return;
    const prev = out.get(a);
    out.set(a, prev ? { ...prev, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)), image: prev.image || c.image || null, liquidityUsd: Math.max(prev.liquidityUsd || 0, c.liquidityUsd || 0) || null } : { ...c, address: a });
  };
  const hits = (sym, name) => String(sym || "").toLowerCase().includes(ql) || String(name || "").toLowerCase().includes(ql);
  for (const [address, symbol, name] of [["native", "ETH", "Ether"], [RH.weth, "WETH", "Wrapped Ether"], [RH.usdg, "USDG", "Global Dollar"]])
    if (hits(symbol, name)) add({ address, symbol, name, kind: "major" });
  for (const s of STOCKS) if (hits(s.symbol, s.name)) add({ address: s.address, symbol: s.symbol, name: String(s.name || "").replace(/\s•\s*Robinhood Token$/, ""), kind: "stock", image: IMAGES.get(lc(s.address)) || null });
  for (const t of board.rows.values()) if (hits(t.symbol, t.name))
    add({ address: t.address, symbol: t.symbol, name: t.name, kind: t.stock ? "stock" : "coin", image: t.image || null, priceUsd: t.priceUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, volume24hUsd: t.volume24hUsd ?? null, change24h: t.change24h ?? null, launchpad: t.launchpad || null });
  try {
    const d = await memo(`ds:search:${ql}`, 60_000, () => getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(raw)}`, { timeout: 8000 }));
    for (const p of d?.pairs || []) {
      if (p.chainId !== "robinhood" || !p.baseToken?.address) continue;
      const b = p.baseToken, sym = String(b.symbol || "").replace(/\s•.*$/, ""), name = String(b.name || "").replace(/\s•\s*Robinhood Token$/, "");
      if (!hits(sym, name)) continue;                       // DexScreener also matches on the quote token
      const a = lc(b.address);
      if (/^0x0{40}$/.test(a)) continue;                    // native ETH in v4 pools: the ETH row above covers it
      add({ address: a, symbol: sym, name, kind: STOCK_SET.has(a) ? "stock" : "coin", image: goodImg(p.info?.imageUrl), priceUsd: fnum(p.priceUsd), liquidityUsd: fnum(p.liquidity?.usd),
        volume24hUsd: fnum(p.volume?.h24), change24h: fnum(p.priceChange?.h24), launchpad: padOfDex(`${p.dexId || "other"}${p.labels?.[0] ? "-" + p.labels[0] : ""}`) || null });
    }
  } catch { /* the local sources still answer */ }
  // a stock whose company name is the query ("tesla" → Tesla, TSLA) ranks with exact ticker matches
  const firstWord = (n) => String(n || "").replace(/\s•.*$/, "").toLowerCase().split(/[\s,.]+/)[0];
  const rank = (c) => { const s = String(c.symbol).toLowerCase(), n = String(c.name || "").toLowerCase(); if (c.kind === "stock" && (n === ql || firstWord(n) === ql)) return 0; return s === ql ? 0 : s.startsWith(ql) ? 1 : n === ql || n.startsWith(ql) ? 2 : 3; };
  let coins = [...out.values()].sort((x, y) => rank(x) - rank(y) || kindRank(x) - kindRank(y) || (y.liquidityUsd || 0) - (x.liquidityUsd || 0));
  // a coin named or ticketed like a stock token (TESLA, xTESLAFI, TSLA) is a copy of it
  const stockKeys = new Set(STOCKS.flatMap((x) => [String(x.symbol).toLowerCase(), firstWord(x.name)]).filter((k) => k && k.length >= 3));
  const stockCopy = (c) => c.kind === "coin" && [String(c.symbol).toLowerCase(), firstWord(c.name), String(c.name || "").toLowerCase().replace(/^x|fi$/g, "")].some((k) => stockKeys.has(k));
  const top = new Map();
  for (const c of coins) { const k = String(c.symbol).toLowerCase(); top.set(k, Math.max(top.get(k) || 0, c.liquidityUsd || 0, c.kind !== "coin" ? 1e9 : 0)); }
  coins = coins.map((c) => ({ ...c, image: c.kind === "stock" ? `/api/stocks/logo/${c.address}?v=3` : c.image || null,
    copy: stockCopy(c) || (c.kind === "coin" && (c.liquidityUsd || 0) < 25_000 && (top.get(String(c.symbol).toLowerCase()) || 0) > Math.max(5000, 20 * (c.liquidityUsd || 0))) }))
    .sort((x, y) => (x.copy === y.copy ? 0 : x.copy ? 1 : -1));   // copies last; the order is otherwise kept
  const v = { q: raw, coins, sources: ["Troya index", "Robinhood stock tokens", "DexScreener"], updatedAt: Date.now() };
  COIN_SEARCH.set(ql, { t: Date.now(), v });
  if (COIN_SEARCH.size > 500) COIN_SEARCH.delete(COIN_SEARCH.keys().next().value);
  return { ...v, coins: coins.slice(0, limit) };
}

export async function register(r) {
  r.get("/api/search/coins", ({ query }) => searchCoins(query.q, query.limit), { weight: 1, perMin: 240 });
  r.get("/api/market/robinhood/holders", async ({ query }) => {
    const a = lc(query.address);
    if (!ADDR_RE.test(a)) throw httpErr(400, "That is not a valid token address.");
    const t = BS_KEY && !bsDown() ? await topHolders(a).catch(() => null) : null;
    if (t) return { ...t, source: "Blockscout" };
    // Blockscout paused or failing: the count and the top-10 share from GeckoTerminal, without the per-wallet list
    const g = await geckoHolders(a).catch(() => null);
    if (!g || g.count == null) throw httpErr(503, "Holder data is unavailable right now. Try again in a few minutes.");
    return { count: g.count, top10: g.top10, holders: [], source: "GeckoTerminal", note: "The list of top wallets is unavailable right now; the holder count and the top-10 share are live." };
  }, { weight: 2, perMin: 60 });
  r.get("/api/market/robinhood", ({ query }) => getRobinhoodTokens(query), { weight: 1 });
  r.get("/api/market/robinhood/token", ({ query }) => getRobinhoodToken(query.address), { weight: 2 });
  r.get("/api/market/robinhood/candles", ({ query }) => getRobinhoodCandles(query.address, query.interval), { weight: 1 });
  r.get("/api/market/robinhood/trades", ({ query }) => getRobinhoodTrades(query.address), { weight: 1 });
  r.get("/api/market/stocks", () => getStocks(), { weight: 1 });
  r.get("/api/market/launchpads", () => ({ launchpads: LAUNCHPADS }));
  r.get("/api/market/hl", async ({ query }) => {
    const d = await getHlMarkets();
    let m = d.markets;
    if (query.dex === "main") m = m.filter((x) => !x.dex);
    else if (query.dex) m = m.filter((x) => x.dex === query.dex);
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
  if (process.env.TROYA_BOARD !== "0") { startBoard(); setTimeout(() => getStocks().catch(() => {}), 3000).unref?.(); }
}
