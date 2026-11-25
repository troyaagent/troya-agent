// V10 F64 Proteus: One Stock, Many Seas. Proteus, the old man of the sea, could take any shape: one share trades on chain
// in many shapes. For one ticker, every place Troya can read it for free, side by side, against the real share:
//   GET /api/proteus            the tickers Troya can compare (Robinhood Chain stock tokens + Hyperliquid stock perps)
//   GET /api/proteus/:ticker    { ticker, reference, band, venues:[…], missing:[…], text }
// Venues (each one only when it can really be read):
//   Robinhood Chain stock token . radar.mjs stockGaps: the pool price per share (price ÷ the ERC-8056 multiplier), its
//                                 liquidity and volume (stocks.mjs stockDesk + DexScreener)
//   Hyperliquid stock perps ..... every HIP-3 builder dex (perpDexs, then metaAndAssetCtxs per dex, through hl.mjs):
//                                 mark, oracle, open interest, 24h volume, funding, and the impact spread Hyperliquid
//                                 itself publishes for a typical market order. Delisted markets are left out.
//   xStocks and Ondo ............ the official contracts from CoinGecko's free coin list (by symbol and name: "TSLAx"
//                                 xStock, "TSLAon" Ondo Tokenized), then every chain's pools from DexScreener: price from
//                                 the deepest pool, liquidity and volume summed. Same-ticker contracts not on CoinGecko's
//                                 record are never used (DexScreener lists fakes: a "TSLAon" at $279 with $5.9M of
//                                 liquidity, 25 Nov 2026).
// The reference: the latest real share price (Yahoo Finance's public chart, regular session or extended hours) while the
// US market is open; when it is closed, Zeno's Gap (V9 F51): that price moved by Nasdaq-100 futures since it was set.
// The 24/7 fair-value band: the range spanned by the independent estimates Troya can read (the last real price, Zeno's
// fair value, and each perp dex's own oracle price), never a confidence interval. Each venue: its premium or discount
// to the reference and where it sits against the band. An estimate, not a quote; never a forecast.
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
const UA = { "user-agent": "Mozilla/5.0 (compatible; TroyaProteus/1.0)", accept: "application/json" };
const why = (e) => String(e?.message || e || "failed").replace(/\s+/g, " ").slice(0, 200);
const FILE = "proteus.json";
const TTL = { answer: 90_000, list: 5 * 60_000, ref: 2 * 60_000, reg: 3 * 86_400_000, regMiss: 86_400_000, ds: 60_000, dexes: 10 * 60_000 };
// HIP-3 tickers that are not one company's share: indices, commodities, currencies, rates, crypto baskets, volatility
const NOT_STOCK = new Set(("XYZ100 SP500 JP225 KR200 NIFTY IBOV DXY VIX GOLD SILVER PLATINUM PALLADIUM COPPER ALUMINIUM URANIUM CL BRENTOIL NATGAS HO TTF " +
  "CORN WHEAT JPY EUR GBP KRW TOTAL2 OTHERS BTCD 10Y 30Y 2Y BVIV PURRDAT BIRD DRAM BOT KSTR KORU LYTE NCLD MUU SNXX SHAZ STRC TREAD DRV ANSEM QNT").split(" "));
// CoinGecko platform ids → DexScreener chain ids
const DS_CHAIN = { ethereum: "ethereum", "binance-smart-chain": "bsc", "arbitrum-one": "arbitrum", solana: "solana", mantle: "mantle", base: "base", "polygon-pos": "polygon",
  hyperevm: "hyperevm", robinhood: "robinhood", avalanche: "avalanche", "optimistic-ethereum": "optimism", ink: "ink", "the-open-network": "ton", sui: "sui", tron: "tron", "x-layer": "xlayer" };
const CHAIN_NAME = { ethereum: "Ethereum", bsc: "BNB Chain", arbitrum: "Arbitrum", solana: "Solana", mantle: "Mantle", base: "Base", polygon: "Polygon", hyperevm: "HyperEVM",
  robinhood: "Robinhood Chain", avalanche: "Avalanche", optimism: "Optimism", ink: "Ink", ton: "TON", sui: "Sui", tron: "Tron", xlayer: "X Layer" };
let store = null;

function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}
async function getJson(url, ms = 9000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) { const e = new Error(`${new URL(url).hostname} answered ${r.status}`); e.code = r.status; throw e; }
  return r.json();
}
const memo = new Map();
function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  memo.set(key, { at: Date.now(), p });
  p.catch(() => { if (memo.get(key)?.p === p) memo.delete(key); });
  if (memo.size > 800) for (const [k, v] of memo) if (Date.now() - v.at > 30 * 60_000) memo.delete(k);
  return p;
}

/* ---------- the real share: Yahoo's public chart (the Radar's source), and Nasdaq-100 futures for Zeno's Gap ---------- */
async function shareRef(sym) {
  return cached(`ref:${sym}`, TTL.ref, async () => {
    const d = (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d&includePrePost=true`, 8000))?.chart?.result?.[0];
    if (!d?.meta?.regularMarketPrice) return null;
    const m = d.meta, p = m.currentTradingPeriod || {}, now = Date.now() / 1000;
    if (m.instrumentType && !/EQUITY|ETF/i.test(m.instrumentType)) return null;
    const closes = d.indicators?.quote?.[0]?.close || [], ts = d.timestamp || [];
    let lastPx = null, lastT = null;
    for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { lastPx = closes[i]; lastT = ts[i]; break; }
    const inP = (k) => p[k] && now >= p[k].start && now < p[k].end;
    const etDay = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
    const weekend = etDay === "Sat" || etDay === "Sun" || (etDay === "Fri" && p.post && now >= p.post.end);
    const session = inP("regular") ? "open" : inP("pre") ? "pre-market" : inP("post") ? "after-hours" : weekend ? "weekend" : "overnight";
    const useExt = session !== "open" && lastPx && lastT > (m.regularMarketTime || 0);
    return { price: useExt ? lastPx : m.regularMarketPrice, at: (useExt ? lastT : m.regularMarketTime) * 1000, session, basis: useExt ? "extended hours" : "regular session", name: m.longName || m.shortName || null };
  });
}
const futures = () => cached("fut", TTL.ref, async () => {
  const d = (await getJson("https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=5m&range=5d&includePrePost=true", 8000))?.chart?.result?.[0];
  const pts = (d?.timestamp || []).map((t, i) => [t * 1000, d.indicators?.quote?.[0]?.close?.[i]]).filter(([, c]) => Number.isFinite(c) && c > 0);
  if (!pts.length) throw new Error("no futures data");
  return pts;
});
function futuresMove(pts, sinceMs) {
  if (!pts || !sinceMs) return null;
  let from = null;
  for (const [t, c] of pts) { if (t <= sinceMs) from = c; else break; }
  return from ? pts[pts.length - 1][1] / from - 1 : null;
}

/* ---------- Hyperliquid HIP-3 perps ---------- */
const dexList = () => cached("perpDexs", TTL.dexes, async () => {
  const { hlInfo } = await import("./hl.mjs");
  const d = await hlInfo({ type: "perpDexs" });
  return (d || []).filter((x) => x && x.name).map((x) => ({ name: x.name, fullName: x.fullName || x.name }));
});
async function hip3Markets() {
  const { hlCtxs } = await import("./hl.mjs");
  const dexes = await dexList();
  const out = [], failed = [];
  await Promise.all(dexes.map(async (dx) => {
    try {
      const { meta, ctxs } = await within(hlCtxs(dx.name), 9000, `Hyperliquid ${dx.name}`);
      meta.universe.forEach((u, i) => {
        const c = ctxs[i] || {};
        if (u.isDelisted) return;
        const ticker = String(u.name).split(":").pop().toUpperCase();
        const num = (v) => (v == null || v === "" ? null : Number(v));
        const mark = num(c.markPx), oracle = num(c.oraclePx), mid = num(c.midPx);
        const ip = Array.isArray(c.impactPxs) ? c.impactPxs.map(Number) : null;
        out.push({ dex: dx.name, dexName: dx.fullName, coin: u.name, ticker, mark, oracle, mid, maxLeverage: u.maxLeverage ?? null,
          oiUsd: num(c.openInterest) != null && (oracle || mark) ? num(c.openInterest) * (oracle || mark) : null, volume24hUsd: num(c.dayNtlVlm),
          fundingHrPct: num(c.funding) != null ? num(c.funding) * 100 : null,
          impactSpreadPct: ip && ip[0] > 0 && ip[1] > 0 ? ((ip[1] - ip[0]) / ((ip[0] + ip[1]) / 2)) * 100 : null });
      });
    } catch (e) { failed.push({ dex: dx.name, why: why(e) }); }
  }));
  return { markets: out, failed, dexes: dexes.length };
}

/* ---------- xStocks and Ondo: official contracts from CoinGecko, pools from DexScreener ---------- */
// One read of CoinGecko's free coin list (every coin with its contracts, ~4 MB) a day, filtered to the xStocks and Ondo
// tokens and kept in data/proteus.json; a ticker is then matched locally (one call a day instead of four per ticker,
// which CoinGecko's free tier answered with 429 on the server, 25 Nov 2026).
let reg = null, regLoad = null;
const FAMILIES = [
  { key: "xstock", issuer: "xStocks", suffix: "x", match: (c, T) => lc(c.symbol) === lc(`${T}x`) && /xstock/i.test(c.name) && !/wrapped/i.test(c.name) },
  { key: "ondo", issuer: "Ondo", suffix: "on", match: (c, T) => lc(c.symbol) === lc(`${T}on`) && /ondo tokenized/i.test(c.name) },
];
async function coinList() {
  if (reg && Date.now() - reg.at < TTL.reg) return reg;
  if (!reg && store) { const d = await store.readJson(FILE, {}).catch(() => ({})); if (d?.list?.length && Date.now() - d.at < TTL.reg) { reg = { at: d.at, list: d.list }; return reg; } if (d?.list?.length) reg = { at: d.at, list: d.list, stale: true }; }
  regLoad ||= (async () => {
    try {
      const all = await getJson("https://api.coingecko.com/api/v3/coins/list?include_platform=true", 30_000);
      const list = (Array.isArray(all) ? all : []).filter((c) => /xstock|ondo tokenized/i.test(c.name || "")).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, platforms: Object.fromEntries(Object.entries(c.platforms || {}).filter(([k, v]) => k && v)) }));
      if (list.length < 50) throw new Error("CoinGecko's coin list came back without the tokenized stocks");
      reg = { at: Date.now(), list };
      if (store) await store.update(FILE, {}, () => ({ at: reg.at, list })).catch(() => {});
      return reg;
    } finally { regLoad = null; }
  })();
  try { return await regLoad; }
  catch (e) { if (reg?.list?.length) return { ...reg, staleNote: why(e) }; throw e; }
}
async function registry(T) {
  const L = await coinList();
  const out = {};
  for (const f of FAMILIES) {
    const c = L.list.find((x) => f.match(x, T));
    out[f.key] = c ? { id: c.id, name: c.name, symbol: `${T}${f.suffix}`, platforms: c.platforms } : { id: null };
  }
  return out;
}
async function dsToken(chain, address) {
  return cached(`ds:${chain}:${lc(address)}`, TTL.ds, async () => {
    const d = await getJson(`https://api.dexscreener.com/tokens/v1/${chain}/${address}`, 9000);
    const same = (a) => (chain === "solana" || chain === "ton" || chain === "sui" ? String(a) === String(address) : lc(a) === lc(address));
    const pairs = (Array.isArray(d) ? d : []).filter((p) => same(p.baseToken?.address) && Number(p.priceUsd) > 0);
    if (!pairs.length) return null;
    pairs.sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const real = pairs.filter((p) => (p.liquidity?.usd || 0) >= 500);
    if (!real.length) return { dust: true };
    return { priceUsd: Number(pairs[0].priceUsd), liquidityUsd: real.reduce((s, p) => s + (p.liquidity?.usd || 0), 0), volume24hUsd: real.reduce((s, p) => s + (p.volume?.h24 || 0), 0),
      pools: real.length, deepest: { dex: pairs[0].dexId, quote: pairs[0].quoteToken?.symbol || null, liquidityUsd: pairs[0].liquidity?.usd || null, url: pairs[0].url || null } };
  });
}

/* ---------- the list ---------- */
async function tickerList() {
  return cached("list", TTL.list, async () => {
    const [desk, hl] = await Promise.all([
      import("./stocks.mjs").then((m) => within(m.stockDesk(), 20_000, "Stock desk")).catch(() => null),
      within(hip3Markets(), 15_000, "Hyperliquid").catch(() => ({ markets: [] }))]);
    const T = new Map();
    const add = (ticker, o) => { const k = ticker.toUpperCase(); const x = T.get(k) || { ticker: k, name: null, robinhood: null, perps: [] }; Object.assign(x, { name: x.name || o.name || null }); if (o.rh) x.robinhood = o.rh; if (o.perp) x.perps.push(o.perp); T.set(k, x); };
    for (const a of desk?.assets || []) add(a.symbol, { name: a.name, rh: a.address });
    const { perpName } = await import("./hl.mjs");
    for (const m of hl.markets) if (!NOT_STOCK.has(m.ticker) && /^[A-Z][A-Z0-9.]{0,9}$/.test(m.ticker)) add(m.ticker, { name: perpName(`xyz:${m.ticker}`) !== m.ticker ? perpName(`xyz:${m.ticker}`) : null, perp: m.dex });
    const tickers = [...T.values()].map((x) => ({ ...x, perps: [...new Set(x.perps)] }))
      .sort((a, b) => (b.robinhood ? 1 : 0) + b.perps.length - ((a.robinhood ? 1 : 0) + a.perps.length) || a.ticker.localeCompare(b.ticker));
    return { tickers, sources: { robinhood: desk?.assets?.length || 0, hyperliquidDexes: hl.dexes || 0 }, updatedAt: Date.now(),
      note: "Tickers with a Robinhood Chain stock token or a Hyperliquid stock perp. xStocks and Ondo tokens are looked up when a ticker is opened." };
  });
}

/* ---------- one ticker ---------- */
export async function proteus(raw) {
  const T = String(raw || "").trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(T)) throw new HttpError(400, "Type a share's ticker, for example NVDA, TSLA or AAPL.");
  return cached(`t:${T}`, TTL.answer, () => build(T));
}
async function build(T) {
  const t0 = Date.now();
  const list = await tickerList().catch(() => ({ tickers: [] }));
  const entry = list.tickers.find((x) => x.ticker === T) || null;
  const venues = [], missing = [];
  // the Robinhood Chain token, through the Radar (its gap and Zeno's fair value use the same share price)
  const rhP = entry?.robinhood ? import("./radar.mjs").then((m) => within(m.stockGaps(), 30_000, "Robinhood Radar")).then((g) => ({ g, row: (g.rows || []).find((r) => lc(r.address) === lc(entry.robinhood)) })).catch((e) => ({ err: why(e) })) : null;
  const [refR, futR, hlR, regR, rhR] = await Promise.all([
    shareRef(T).then((v) => ({ v }), (e) => ({ err: why(e) })), futures().then((v) => ({ v }), (e) => ({ err: why(e) })),
    within(hip3Markets(), 15_000, "Hyperliquid").catch((e) => ({ markets: [], failed: [{ dex: "all", why: why(e) }] })),
    within(registry(T), 35_000, "CoinGecko").catch((e) => ({ error: why(e) })), rhP]);

  // the reference: the Radar's numbers for a Robinhood ticker (identical source), else the same reads here
  const row = rhR?.row || null;
  let real = null;
  if (row?.sharePriceUsd) real = { price: row.sharePriceUsd, at: row.shareAt, session: row.session, basis: row.shareBasis };
  else if (refR.v) real = refR.v;
  const closed = real?.session && real.session !== "open";
  let fair = null, futMovePct = null;
  if (real) {
    if (!closed) fair = real.price;
    else if (row?.fairUsd) { fair = row.fairUsd; futMovePct = row.futuresMovePct; }
    else { const m = futR.v ? futuresMove(futR.v, real.at) : null; fair = real.price * (1 + (m || 0)); futMovePct = m != null ? +(m * 100).toFixed(2) : null; }
  }
  const reference = real ? { usd: +fair.toFixed(4), kind: closed ? "zeno" : "live", lastRealUsd: real.price, lastRealAt: real.at || null, basis: real.basis || null, session: real.session,
    futuresMovePct: closed ? futMovePct : null,
    text: closed ? `The US market is ${real.session === "weekend" ? "closed for the weekend" : real.session === "overnight" ? "closed overnight" : `in ${real.session} trading`}: the reference is Zeno's fair value, the last real price ($${real.price.toFixed(2)}, ${real.basis}) moved ${futMovePct != null ? `${futMovePct > 0 ? "+" : ""}${futMovePct}% with Nasdaq-100 futures` : "by nothing (futures could not be read or are closed)"}. An estimate, not a quote.`
      : `The US market is open: the reference is the latest real share price ($${real.price.toFixed(2)}).` } : null;
  if (!real) missing.push({ venue: "share", label: "The real share", why: refR.err ? `Yahoo Finance: ${refR.err}` : `No listed share price for ${T} (a private company, or a ticker Yahoo does not carry), so there is nothing to measure a premium against.` });

  // Robinhood Chain stock token
  if (!entry?.robinhood) missing.push({ venue: "robinhood", label: "Robinhood Chain stock token", why: `Robinhood has no ${T} stock token on Robinhood Chain.` });
  else if (rhR?.err) missing.push({ venue: "robinhood", label: "Robinhood Chain stock token", why: rhR.err });
  else if (!row || !(row.perShareUsd > 0)) missing.push({ venue: "robinhood", label: "Robinhood Chain stock token", why: "Its pool price could not be read right now." });
  else venues.push({ venue: "robinhood", kind: "token", label: "Robinhood stock token", chain: "Robinhood Chain", priceUsd: row.perShareUsd, perToken: row.tokenPriceUsd, multiplier: row.multiplier,
    liquidityUsd: row.liquidityUsd, volume24hUsd: row.volume24hUsd, thin: !!row.thin, href: `#/token/${row.address}`, address: row.address,
    note: row.multiplier && row.multiplier !== 1 ? `Robinhood stock token: price per share is the token's price ÷ its multiplier (${Number(row.multiplier).toFixed(4)}, dividends reinvested).` : null });

  // Hyperliquid stock perps, every builder dex that lists the ticker
  const perps = (hlR.markets || []).filter((m) => m.ticker === T);
  for (const m of perps) venues.push({ venue: `hl-${m.dex}`, kind: "perp", label: `${m.dex === "xyz" ? "trade.xyz" : m.dexName === m.dex ? m.dex : m.dexName} perp`, chain: "Hyperliquid", priceUsd: m.mark, oracleUsd: m.oracle,
    oiUsd: m.oiUsd, volume24hUsd: m.volume24hUsd, fundingHrPct: m.fundingHrPct, impactSpreadPct: m.impactSpreadPct, maxLeverage: m.maxLeverage, href: `#/perps/${encodeURIComponent(m.coin)}`, coin: m.coin,
    note: "A perp on the price, settled in USDC: you never hold the share. Its oracle is the dex deployer's own estimate." });
  if (!perps.length) missing.push({ venue: "hl", label: "Hyperliquid stock perps", why: hlR.failed?.length && !hlR.markets?.length ? `Hyperliquid did not answer (${hlR.failed[0].why}).` : `No live Hyperliquid builder dex lists ${T}.` });

  // xStocks and Ondo, every chain with a pool
  for (const f of FAMILIES) {
    const r = regR?.[f.key];
    if (!r) { missing.push({ venue: f.key, label: f.issuer, why: regR?.error ? `CoinGecko's coin list could not be read: ${regR.error}` : "Not looked up." }); continue; }
    if (!r.id) { missing.push({ venue: f.key, label: f.issuer, why: `CoinGecko lists no ${f.issuer} token for ${T} (${T}${f.suffix}).` }); continue; }
    const deps = Object.entries(r.platforms || {}).map(([p, a]) => [DS_CHAIN[p], a, p]).filter(([c]) => c);
    const got = await Promise.all(deps.map(([c, a]) => within(dsToken(c, a), 10_000, "DexScreener").then((v) => ({ c, a, v }), (e) => ({ c, a, err: why(e) }))));
    let any = false;
    for (const g of got) {
      if (!g.v || g.v.dust) continue;
      any = true;
      venues.push({ venue: `${f.key}-${g.c}`, kind: "token", label: `${r.symbol} · ${f.issuer}`, chain: CHAIN_NAME[g.c] || g.c, priceUsd: g.v.priceUsd, liquidityUsd: g.v.liquidityUsd, volume24hUsd: g.v.volume24hUsd,
        pools: g.v.pools, thin: !(g.v.liquidityUsd >= 50_000), address: g.a, href: g.v.deepest.url, external: true,
        pool: `${g.v.deepest.dex}${g.v.deepest.quote ? ` vs ${g.v.deepest.quote}` : ""}`,
        note: "xStocks and Ondo: the price of each token's deepest pool, per token. Any multiplier the issuer applies for dividends is not taken out." });
    }
    const none = got.filter((g) => !g.v).map((g) => CHAIN_NAME[g.c] || g.c), dust = got.filter((g) => g.v?.dust).map((g) => CHAIN_NAME[g.c] || g.c);
    const tail = [none.length ? `no priced pool on ${none.join(", ")}` : null, dust.length ? `only dust pools (under $500) on ${dust.join(", ")}` : null].filter(Boolean).join("; ");
    if (!any) missing.push({ venue: f.key, label: `${r.symbol} · ${f.issuer}`, why: `Official contracts on ${deps.map(([c]) => CHAIN_NAME[c] || c).join(", ") || "no chain DexScreener reads"}, but ${tail || "no pool could be read"}.` });
    else if (tail) missing.push({ venue: f.key, label: `${r.symbol} · ${f.issuer}`, why: tail.replace(/^./, (x) => x.toUpperCase()) + ".", minor: true });
  }

  // the band: the spread of the independent estimates
  const est = [];
  if (real) est.push({ kind: "last", label: `Last real price (${real.basis || "regular session"})`, usd: real.price });
  if (real && closed && fair && Math.abs(fair - real.price) > 1e-9) est.push({ kind: "zeno", label: "Zeno's fair value (moved with Nasdaq-100 futures)", usd: +fair.toFixed(4) });
  for (const p of perps) if (p.oracle > 0) est.push({ kind: "oracle", label: `${p.dex === "xyz" ? "trade.xyz" : p.dexName} oracle`, usd: p.oracle });
  const band = est.length ? { lowUsd: Math.min(...est.map((e) => e.usd)), highUsd: Math.max(...est.map((e) => e.usd)), estimates: est,
    text: est.length === 1 ? "Only one estimate could be read, so the band is a single price." : `The range spanned by ${est.length} independent estimates. Not a confidence interval.` } : null;
  for (const v of venues) {
    v.premiumPct = reference && v.priceUsd ? +((v.priceUsd / reference.usd - 1) * 100).toFixed(2) : null;
    v.vsLastRealPct = real && v.priceUsd ? +((v.priceUsd / real.price - 1) * 100).toFixed(2) : null;
    if (band && v.priceUsd) v.band = v.priceUsd < band.lowUsd ? { side: "below", byPct: +((v.priceUsd / band.lowUsd - 1) * 100).toFixed(2) } : v.priceUsd > band.highUsd ? { side: "above", byPct: +((v.priceUsd / band.highUsd - 1) * 100).toFixed(2) } : { side: "inside", byPct: 0 };
  }
  venues.sort((a, b) => (b.liquidityUsd ?? b.oiUsd ?? 0) - (a.liquidityUsd ?? a.oiUsd ?? 0));
  // the headline compares the venues with real money behind them (a pool of $50k or more, a perp with $1M of open
  // interest); thin ones are still listed, with their own premium
  for (const v of venues) v.deep = v.kind === "perp" ? v.oiUsd >= 1e6 : v.liquidityUsd >= 50_000;
  const pricedAll = venues.filter((v) => v.premiumPct != null), pricedDeep = pricedAll.filter((v) => v.deep);
  const priced = pricedDeep.length >= 2 ? pricedDeep : pricedAll;
  const spread = priced.length >= 2 ? { highest: priced.reduce((m, v) => (v.premiumPct > m.premiumPct ? v : m)), lowest: priced.reduce((m, v) => (v.premiumPct < m.premiumPct ? v : m)) } : null;
  const headline = !venues.length ? `Troya could not read ${T} on any venue right now.`
    : !reference ? `${T} trades in ${venues.length} place${venues.length === 1 ? "" : "s"} Troya can read, but there is no listed share price to measure them against.`
      : spread ? `${T} on chain spans ${(spread.highest.premiumPct - spread.lowest.premiumPct).toFixed(2)} points across ${priced.length}${priced === pricedDeep && pricedAll.length > priced.length ? " deep" : ""} venues: from ${fmtPct(spread.lowest.premiumPct)} (${spread.lowest.label}, ${spread.lowest.chain}) to ${fmtPct(spread.highest.premiumPct)} (${spread.highest.label}, ${spread.highest.chain}) against the ${reference.kind === "zeno" ? "fair value" : "real share"}.`
        : `${T}: ${priced[0].label} sits ${fmtPct(priced[0].premiumPct)} against the ${reference.kind === "zeno" ? "fair value" : "real share"}.`;
  return {
    ticker: T, name: entry?.name || real?.name || null, headline, reference, band, venues, missing, checkedAt: Date.now(), tookMs: Date.now() - t0,
    text: {
      estimate: "An estimate, not a quote. Prices are read from public sources and can be a few minutes old.",
      us: "Stock tokens are not offered to US persons. Robinhood stock tokens, xStocks and Ondo tokens each come with their issuer's own rules.",
      forecast: "No forecast: whether a premium or a discount closes is never known in advance. This page describes prices, it does not recommend a trade.",
      method: "Premium = venue price ÷ reference − 1. The reference is the real share while the US market is open, Zeno's fair value while it is closed. Thin pools (under $50k) move on small trades.",
    },
    sources: "Robinhood stock token API + DexScreener (Robinhood Chain tokens), Hyperliquid info API (HIP-3 perps), CoinGecko (official xStocks and Ondo contracts), DexScreener (their pools), Yahoo Finance public chart (share price and Nasdaq-100 futures).",
  };
}
const fmtPct = (x) => `${x > 0 ? "+" : ""}${x.toFixed(2)}%`;

export async function register(r, ctx) {
  store = ctx?.store || null;
  r.get("/api/proteus", () => tickerList(), { weight: 1 });
  r.get("/api/proteus/:ticker", ({ params }) => proteus(params.ticker), { weight: 2, perMin: 30 });
}
