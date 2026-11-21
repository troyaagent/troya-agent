// Hyperliquid: read-only info proxy (cached) + exchange signing helpers used by the Agent Wallet.
// Signing follows Hyperliquid's L1 action scheme: keccak(msgpack(action) ‖ nonce u64 BE ‖ vault flag [‖ expiresAfter])
// → "phantom agent" {source, connectionId} signed as EIP-712 under domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}.
import { encode } from "@msgpack/msgpack";
import { Wallet, keccak256, getBytes, concat, toBeHex, zeroPadValue, Signature, getAddress, isAddress, verifyTypedData } from "ethers";

const INFO = "https://api.hyperliquid.xyz/info";
const EXCHANGE = "https://api.hyperliquid.xyz/exchange";
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_DECIMALS_PERP = 6;

class HlError extends Error { constructor(status, message) { super(message); this.status = status; this.expose = true; } }

/* ---------------- info (read) ---------------- */
export async function hlInfo(body, { timeout = 9000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new HlError(502, e.name === "AbortError" ? "Hyperliquid did not answer in time." : "Could not reach Hyperliquid.");
  } finally { clearTimeout(t); }
  const text = await res.text();
  if (!res.ok) throw new HlError(502, `Hyperliquid answered ${res.status}: ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { throw new HlError(502, "Hyperliquid sent an unreadable answer."); }
}

// TTL cache with in-flight de-duplication, and stale-while-revalidate where a key asks for it (swr = a multiple of the
// ttl): a value past its ttl but younger than swr × ttl is answered at once while ONE background refresh runs, so a
// visitor no longer waits the 0.7-1.8 s Hyperliquid read each time an entry expires. swr 0 (the default) keeps the
// strict ttl: an account's positions, its approved agents, the order book and the mids are always live reads.
// A refresh that fails leaves the old value in place; the next reader tries again.
const cache = new Map();   // key → { t, v, ok, p, ttl, swr }
function cached(key, ttl, fn, { swr = 0 } = {}) {
  const now = Date.now();
  let e = cache.get(key);
  if (!e) { e = { t: 0, v: undefined, ok: false, p: null, ttl, swr }; cache.set(key, e); }
  e.ttl = ttl; e.swr = Math.max(e.swr || 0, swr);
  const age = e.ok ? now - e.t : Infinity;
  if (age < ttl) return Promise.resolve(e.v);
  if (!e.p) {
    const p = Promise.resolve().then(fn).then(
      (v) => { if (e.p === p) e.p = null; Object.assign(e, { t: Date.now(), v, ok: true }); return v; },
      (err) => { if (e.p === p) e.p = null; throw err; });
    e.p = p;
    p.catch(() => {});                      // nobody may be waiting on a background refresh
  }
  if (swr > 0 && age < ttl * swr) return Promise.resolve(e.v);
  if (cache.size > 800) for (const [k, x] of cache) if (!x.p && now - x.t > Math.max(120_000, x.ttl * (x.swr || 1))) cache.delete(k);
  return e.p;
}
const STALE_X = 12;                         // display reads: an answer up to 12 × ttl old while the refresh runs

/* ---------------- market names ---------------- */
// displayName for every perp: trade.xyz lists bare tickers (SKHX, CL, SP500), so search and the pages can say what each
// one is. Static names first, then the Robinhood stock-token list (the same companies trade there), then the ticker.
const MAIN_NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", HYPE: "Hyperliquid", XRP: "XRP", DOGE: "Dogecoin", BNB: "BNB", ADA: "Cardano",
  AVAX: "Avalanche", LINK: "Chainlink", SUI: "Sui", LTC: "Litecoin", TRX: "TRON", DOT: "Polkadot", TON: "Toncoin", BCH: "Bitcoin Cash",
  NEAR: "NEAR", APT: "Aptos", ARB: "Arbitrum", OP: "Optimism", AAVE: "Aave", UNI: "Uniswap", ENA: "Ethena", TAO: "Bittensor",
  kPEPE: "Pepe (per 1,000)", kBONK: "Bonk (per 1,000)", kSHIB: "Shiba Inu (per 1,000)", WLD: "Worldcoin", FARTCOIN: "Fartcoin", PUMP: "Pump.fun",
};
const XYZ_NAMES = {
  XYZ100: "Nasdaq 100", SP500: "S&P 500", JP225: "Nikkei 225", KR200: "KOSPI 200", NIFTY: "Nifty 50", IBOV: "Ibovespa", DXY: "US Dollar Index",
  VIX: "VIX volatility index", GOLD: "Gold", SILVER: "Silver", PLATINUM: "Platinum", PALLADIUM: "Palladium", COPPER: "Copper",
  ALUMINIUM: "Aluminium", URANIUM: "Uranium", CL: "WTI crude", BRENTOIL: "Brent crude", NATGAS: "Natural gas", HO: "Heating oil",
  TTF: "Dutch TTF gas", CORN: "Corn", WHEAT: "Wheat", JPY: "Japanese yen", EUR: "Euro", GBP: "British pound", KRW: "Korean won",
  ANT: "Anthropic", SKHX: "SK hynix", SMSN: "Samsung Electronics", TSM: "TSMC", HOOD: "Robinhood", NVDA: "NVIDIA", TSLA: "Tesla",
  AAPL: "Apple", MSFT: "Microsoft", GOOGL: "Alphabet", AMZN: "Amazon", META: "Meta", NFLX: "Netflix", ORCL: "Oracle", INTC: "Intel",
  AMD: "AMD", MU: "Micron", PLTR: "Palantir", COIN: "Coinbase", MSTR: "Strategy", CRCL: "Circle", COST: "Costco", LLY: "Eli Lilly",
  RIVN: "Rivian", BABA: "Alibaba", SNDK: "SanDisk", CRWV: "CoreWeave", GME: "GameStop", SOFTBANK: "SoftBank", HYUNDAI: "Hyundai Motor",
  KIOXIA: "Kioxia", HIMS: "Hims & Hers", DKNG: "DraftKings", LITE: "Lumentum", BX: "Blackstone", MRVL: "Marvell", RKLB: "Rocket Lab",
  ZM: "Zoom", EBAY: "eBay", ARM: "Arm", SPCX: "SpaceX", ASML: "ASML", MINIMAX: "MiniMax", BB: "BlackBerry", DELL: "Dell", IBM: "IBM",
  AVGO: "Broadcom", NOW: "ServiceNow", NBIS: "Nebius", WDC: "Western Digital", NOK: "Nokia", BE: "Bloom Energy", ZHIPU: "Zhipu AI",
  QCOM: "Qualcomm", AMAT: "Applied Materials", IBIDEN: "Ibiden", GIGADEV: "GigaDevice", CXMT: "ChangXin Memory", GEV: "GE Vernova",
  UNITREE: "Unitree Robotics", IREN: "IREN", NET: "Cloudflare", CRWD: "CrowdStrike", RDDT: "Reddit", AAOI: "Applied Optoelectronics",
  MRNA: "Moderna", SHEIN: "Shein", YMTC: "Yangtze Memory", BMNR: "BitMine", CVX: "Chevron", OURA: "Oura", LRCX: "Lam Research",
  UMC: "United Microelectronics", CAMBRICON: "Cambricon", TWST: "Twist Bioscience", GLW: "Corning", ACN: "Accenture", INNOLIGHT: "InnoLight",
  CATL: "CATL", RELIANCE: "Reliance Industries", JIO: "Jio Platforms", SNAP: "Snap", TTWO: "Take-Two", NU: "Nu Holdings",
  ICE: "Intercontinental Exchange", MELI: "MercadoLibre", STX: "Seagate", PANW: "Palo Alto Networks", TENCENT: "Tencent", SNOW: "Snowflake",
  SMCI: "Supermicro", USAR: "USA Rare Earth", EWY: "MSCI South Korea ETF", EWJ: "MSCI Japan ETF", EWZ: "MSCI Brazil ETF",
  EWT: "MSCI Taiwan ETF", XLE: "Energy sector ETF", SMH: "Semiconductor ETF", SOXL: "Semiconductor 3x ETF", MAGS: "Magnificent Seven ETF",
  XBI: "Biotech ETF", TLT: "20+ year Treasury ETF", URNM: "Uranium miners ETF",
};
// the Robinhood stock list (robinhood.mjs, merged with the stocks desk by market.mjs), read once it is loaded
let STOCK_LIST = null, stockNames = new Map(), stockNamesN = -1, stockLoad = null;
const cleanCo = (n) => String(n || "").replace(/\s•.*$/, "")
  .replace(/,?\s+(Class [A-C]\b.*|Common Stock.*|Ordinary Shares.*|American Depositary Shares.*)$/i, "")
  .replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|plc|PBC|N\.V\.|S\.A\.)$/i, "").trim();
const loadStockNames = () => (stockLoad ||= import("./robinhood.mjs").then((m) => { STOCK_LIST = m.STOCKS || null; }).catch(() => {}));
function stockName(ticker) {
  if (!STOCK_LIST) return null;
  if (STOCK_LIST.length !== stockNamesN) { stockNamesN = STOCK_LIST.length; stockNames = new Map(STOCK_LIST.map((s) => [String(s.symbol || "").toUpperCase(), cleanCo(s.name)])); }
  return stockNames.get(ticker) || null;
}
/** "xyz:SKHX" → "SK hynix", "BTC" → "Bitcoin"; an unknown ticker is its own name. */
export function perpName(coin) {
  const c = String(coin || ""), xyz = /^xyz:/i.test(c), t = c.replace(/^xyz:/i, "");
  if (!xyz) return MAIN_NAMES[t] || MAIN_NAMES[t.toUpperCase()] || t;
  return XYZ_NAMES[t.toUpperCase()] || stockName(t.toUpperCase()) || t;
}

/* ---------------- perps meta ---------------- */
// the raw meta + contexts of one dex, read once for everyone: hlMeta, hlXyzMeta and market.mjs getHlMarkets (the
// Market board) used to make the same Hyperliquid call each. fresh: wait for a read younger than the ttl (every path
// that prices or sizes an order); otherwise an older copy may answer while the refresh runs.
export function hlCtxs(dex = "", { fresh = false } = {}) {
  const key = `ctxs:${dex || "main"}`;
  return cached(key, 5000, async () => {
    await loadStockNames();
    const [meta, ctxs] = await hlInfo(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) throw new HlError(502, "Hyperliquid sent an unreadable market list.");
    return { meta, ctxs, at: Date.now() };
  }, { swr: fresh ? 0 : STALE_X });
}
// the dex list sets trade.xyz's asset numbers (100000 + index × 10000): an order reads it strictly (fresh)
const perpDexs = ({ fresh = false } = {}) => cached("perpDexs", 10 * 60e3, () => hlInfo({ type: "perpDexs" }), { swr: fresh ? 0 : STALE_X });
// one normalized list per raw read (the same object answers until the next read lands)
const BUILT = new WeakMap();
const once = (raw, tag, build) => { let m = BUILT.get(raw); if (!m) BUILT.set(raw, (m = {})); return (m[tag] ||= build()); };

// perps meta + live contexts, merged into one list
export async function hlMeta({ fresh = false } = {}) {
  const raw = await hlCtxs("", { fresh });
  return once(raw, "meta", () => {
    const { meta, ctxs } = raw;
    const markets = meta.universe.map((u, i) => {
      const c = ctxs[i] || {};
      const mark = +c.markPx || null, prev = +c.prevDayPx || null;
      return {
        asset: i, coin: u.name, displayName: perpName(u.name), szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
        onlyIsolated: !!u.onlyIsolated, isDelisted: !!u.isDelisted, marginMode: u.marginMode || null,
        markPx: mark, midPx: +c.midPx || null, oraclePx: +c.oraclePx || null, prevDayPx: prev,
        change24h: mark && prev ? ((mark - prev) / prev) * 100 : null,
        funding: c.funding != null ? +c.funding : null,             // hourly rate
        openInterest: c.openInterest != null ? +c.openInterest : null, // in coin
        openInterestUsd: c.openInterest != null && mark ? +c.openInterest * mark : null,
        dayNtlVlm: c.dayNtlVlm != null ? +c.dayNtlVlm : null,
        premium: c.premium != null ? +c.premium : null,
        impactPxs: c.impactPxs || null,
      };
    });
    return { markets, time: raw.at };
  });
}
// F16: trade.xyz perps (stocks, indices, metals) are a HIP-3 dex on Hyperliquid. Same API, same trading key; orders
// use asset 100000 + dexIndex × 10000 + index, margin sits in a separate "xyz" balance. Read from the live meta each time.
export const XYZ = "xyz";
export const XYZ_USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";   // the collateral token as sendAsset names it
// the last good trade.xyz list: a failed refresh (rate limit, timeout) serves it to the pages instead of dropping every
// stock perp. A fresh read (an order being priced) never falls back to it: no read, no order.
let lastXyz = null;
export async function hlXyzMeta({ fresh = false } = {}) {
  if (fresh) return hlXyzMetaFresh({ fresh });
  try { const r = await hlXyzMetaFresh(); if (r.markets.length) lastXyz = r; return r.markets.length || !lastXyz ? r : lastXyz; }
  catch (e) { if (lastXyz) return lastXyz; throw e; }
}
async function hlXyzMetaFresh({ fresh = false } = {}) {
  const dexes = await perpDexs({ fresh });
  const idx = (dexes || []).findIndex((d) => d && d.name === XYZ);
  if (idx < 1) return { markets: [], dexIndex: null };
  const raw = await hlCtxs(XYZ, { fresh });
  return once(raw, `xyz:${idx}`, () => {
    const { meta, ctxs } = raw;
    const markets = meta.universe.map((u, i) => {
      const c = ctxs[i] || {};
      const mark = +c.markPx || null, prev = +c.prevDayPx || null;
      return {
        asset: 100000 + idx * 10000 + i, coin: u.name, label: u.name.replace(/^xyz:/, ""), displayName: perpName(u.name), dex: XYZ, venue: "trade.xyz",
        szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated || u.marginMode === "noCross", isDelisted: !!u.isDelisted, marginMode: u.marginMode || null,
        markPx: mark, midPx: +c.midPx || null, oraclePx: +c.oraclePx || null, prevDayPx: prev,
        change24h: mark && prev ? ((mark - prev) / prev) * 100 : null,
        funding: c.funding != null ? +c.funding : null, openInterest: c.openInterest != null ? +c.openInterest : null,
        openInterestUsd: c.openInterest != null && mark ? +c.openInterest * mark : null, dayNtlVlm: c.dayNtlVlm != null ? +c.dayNtlVlm : null,
        premium: c.premium != null ? +c.premium : null, impactPxs: c.impactPxs || null,
      };
    });
    return { markets, dexIndex: idx, time: raw.at };
  });
}
// fresh (the default): the mark, mid and limits come from a read younger than 5 s, as before the stale-while-revalidate
// change, because the Agent Wallet sizes orders and sets the IOC price band from them. Name lookups (candles, the
// book) pass fresh: false.
export async function hlAsset(coin, { fresh = true } = {}) {
  const want = String(coin).toUpperCase();
  const { markets } = await hlMeta({ fresh });
  let m = markets.find((x) => x.coin.toUpperCase() === want);
  if (!m && want.startsWith("XYZ:")) m = (await hlXyzMeta({ fresh })).markets.find((x) => x.coin.toUpperCase() === want && !x.isDelisted);
  if (!m) throw new HlError(404, `Hyperliquid has no perp market called ${coin}.`);
  return m;
}
// display reads only (the chart, the book, the Perps header): a bare ticker with no main perp of that name is the
// trade.xyz market (ANT → xyz:ANT, NVDA → xyz:NVDA), as the Perps page resolves a link. Orders keep hlAsset's strict name.
async function hlAssetAny(coin) {
  try { return await hlAsset(coin, { fresh: false }); }
  catch (e) {
    if (e.status !== 404 || String(coin).includes(":")) throw e;
    try { return await hlAsset(`${XYZ}:${coin}`, { fresh: false }); } catch (e2) { throw e2.status === 404 ? e : e2; }   // the 404 names what was asked for
  }
}
// a perp's exact Hyperliquid name from the market lists already in memory, without waiting on a read: "BTC" → "BTC",
// "KPEPE" → "kPEPE", "XYZ:ANT" or a bare "ANT" → "xyz:ANT". null when the lists are cold or hold no such perp.
function peekCoin(coin) {
  const want = String(coin || "").toUpperCase();
  const uni = (dex) => cache.get(`ctxs:${dex}`)?.v?.meta?.universe || null;
  const main = uni("main")?.find((u) => String(u.name).toUpperCase() === want);
  if (main) return main.name;
  const w = want.includes(":") ? want : `XYZ:${want}`;
  return uni(XYZ)?.find((u) => String(u.name).toUpperCase() === w && !u.isDelisted)?.name || null;
}
// fresh: a read at most 1 s old (the Perps page right after a funding or a move, when the 2.5 s copy can still show the
// old balance); otherwise any copy younger than 2.5 s answers
export async function hlUserState(address, { fresh = false } = {}) {
  if (!isAddress(address)) throw new HlError(400, "That is not a valid address.");
  const user = getAddress(address).toLowerCase();
  return cached(`user:${user}`, fresh ? 1000 : 2500, async () => {
    const [ch, orders, fills, spot, chx, ordersx, mode] = await Promise.all([
      hlInfo({ type: "clearinghouseState", user }),
      hlInfo({ type: "frontendOpenOrders", user }).catch(() => []),
      hlInfo({ type: "userFills", user }).catch(() => []),
      hlInfo({ type: "spotClearinghouseState", user }).catch(() => ({ balances: [] })),
      hlInfo({ type: "clearinghouseState", user, dex: XYZ }).catch(() => null),
      hlInfo({ type: "frontendOpenOrders", user, dex: XYZ }).catch(() => []),
      hlInfo({ type: "userAbstraction", user }).catch(() => null),
    ]);
    // unified / portfolio margin: per-dex balances read 0; the shared USDC (available after maintenance) is the margin
    const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
    const shared = unified ? +((spot?.tokenToAvailableAfterMaintenance || []).find((x) => Number(x[0]) === 0)?.[1] || 0) : null;
    const posOf = (st, dex) => (st?.assetPositions || []).map((p) => p.position).filter(Boolean).map((p) => ({ ...pos(p), dex }));
    const pos = (p) => ({
      coin: p.coin, size: +p.szi, entryPx: +p.entryPx || null, positionValue: +p.positionValue || 0,
      unrealizedPnl: +p.unrealizedPnl || 0, returnOnEquity: +p.returnOnEquity || 0, liquidationPx: p.liquidationPx != null ? +p.liquidationPx : null,
      marginUsed: +p.marginUsed || 0, leverage: p.leverage?.value ?? null, leverageType: p.leverage?.type ?? null, maxLeverage: p.maxLeverage ?? null,
      funding: p.cumFunding ? +p.cumFunding.sinceOpen : null,
    });
    const positions = [...posOf(ch, null), ...posOf(chx, XYZ)];
    return {
      address: user,
      accountValue: +ch.marginSummary?.accountValue || 0,
      totalMarginUsed: +ch.marginSummary?.totalMarginUsed || 0,
      totalNtlPos: +ch.marginSummary?.totalNtlPos || 0,
      withdrawable: unified ? shared : +ch.withdrawable || 0,
      unified, abstraction: mode || null,
      unrealizedPnl: positions.reduce((a, p) => a + p.unrealizedPnl, 0),
      positions,
      dexes: { [XYZ]: { accountValue: +chx?.marginSummary?.accountValue || 0, withdrawable: unified ? shared : +chx?.withdrawable || 0, totalMarginUsed: +chx?.marginSummary?.totalMarginUsed || 0 } },
      openOrders: [...(orders || []), ...(ordersx || [])].slice(0, 100).map((o) => ({
        coin: o.coin, side: o.side === "B" ? "buy" : "sell", limitPx: +o.limitPx, size: +o.sz, origSize: +o.origSz, oid: o.oid,
        timestamp: o.timestamp, reduceOnly: !!o.reduceOnly, orderType: o.orderType, triggerPx: o.triggerPx ? +o.triggerPx : null, isTrigger: !!o.isTrigger, tif: o.tif || null,
      })),
      fills: (fills || []).slice(0, 60).map((f) => ({
        coin: f.coin, side: f.side === "B" ? "buy" : "sell", px: +f.px, size: +f.sz, time: f.time, dir: f.dir, closedPnl: +f.closedPnl || 0, fee: +f.fee || 0, hash: f.hash, oid: f.oid,
      })),
      spot: (spot?.balances || []).filter((b) => +b.total > 0).map((b) => ({ coin: b.coin, total: +b.total, hold: +b.hold })),
      time: Date.now(),
    };
  });
}

/* ---------------- wire formatting ---------------- */
// Mirrors the SDK's float_to_wire: 8 decimals max, exact, normalised (no trailing zeros, no exponent).
export function floatToWire(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new HlError(400, `Bad number: ${x}`);
  let s = n.toFixed(8);
  if (Math.abs(Number(s) - n) >= 1e-12) throw new HlError(400, `Too many decimals: ${x}`);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}
// price: ≤5 significant figures and ≤ (6 - szDecimals) decimals for perps; integers always allowed
export function roundPx(px, szDecimals, maxDecimals = MAX_DECIMALS_PERP) {
  const n = Number(px);
  if (!(n > 0)) throw new HlError(400, "Price must be above zero.");
  if (Number.isInteger(n)) return n;
  const sig = Number(n.toPrecision(5));
  const dec = Math.max(0, maxDecimals - szDecimals);
  return Number(sig.toFixed(dec));
}
export function roundSz(sz, szDecimals) {
  const f = 10 ** szDecimals;
  return Math.floor(Number(sz) * f + 1e-9) / f;
}
function orderTypeWire(t) {
  if (t.limit) return { limit: { tif: t.limit.tif } };
  if (t.trigger) return { trigger: { isMarket: !!t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
  throw new HlError(400, "Unknown order type.");
}
export function orderWire({ asset, isBuy, limitPx, size, reduceOnly = false, orderType, cloid }) {
  const w = { a: asset, b: !!isBuy, p: floatToWire(limitPx), s: floatToWire(size), r: !!reduceOnly, t: orderTypeWire(orderType) };
  if (cloid) w.c = cloid;
  return w;
}
export function orderAction(wires, grouping = "na") { return { type: "order", orders: wires, grouping }; }

/* ---------------- signing ---------------- */
export function actionHash(action, vaultAddress, nonce, expiresAfter) {
  const parts = [encode(action), getBytes(zeroPadValue(toBeHex(BigInt(nonce)), 8))];
  if (!vaultAddress) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), getBytes(getAddress(vaultAddress)));
  if (expiresAfter != null) parts.push(new Uint8Array([0]), getBytes(zeroPadValue(toBeHex(BigInt(expiresAfter)), 8)));
  return keccak256(concat(parts));
}
export const L1_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO };
export const AGENT_TYPES = { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] };
export function phantomAgent(hash, isMainnet = true) { return { source: isMainnet ? "a" : "b", connectionId: hash }; }

export async function signL1Action(privateKey, action, { vaultAddress = null, nonce, expiresAfter = null, isMainnet = true } = {}) {
  const wallet = privateKey instanceof Wallet ? privateKey : new Wallet(privateKey);
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter);
  const sig = Signature.from(await wallet.signTypedData(L1_DOMAIN, AGENT_TYPES, phantomAgent(hash, isMainnet)));
  return { r: sig.r, s: sig.s, v: sig.v };
}

// strictly increasing millisecond nonces per signer (Hyperliquid rejects reused nonces)
const lastNonce = new Map();
function nextNonce(addr) {
  const prev = lastNonce.get(addr) || 0;
  const n = Math.max(Date.now(), prev + 1);
  lastNonce.set(addr, n);
  return n;
}

async function postExchange(payload, { timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(EXCHANGE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
  } catch (e) {
    throw new HlError(502, e.name === "AbortError" ? "Hyperliquid did not confirm in time. Check your open orders before retrying." : "Could not reach Hyperliquid.");
  } finally { clearTimeout(t); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new HlError(502, `Hyperliquid answered ${res.status}: ${text.slice(0, 200)}`); }
  if (data?.status === "err") throw new HlError(400, `Hyperliquid refused: ${data.response}`);
  // per-order errors come back inside response.data.statuses
  const statuses = data?.response?.data?.statuses;
  if (Array.isArray(statuses)) {
    const bad = statuses.find((s) => s && s.error);
    if (bad && statuses.every((s) => s && s.error)) throw new HlError(400, `Hyperliquid refused the order: ${bad.error}`);
  }
  return data;
}

async function signAndSend(privateKey, action, { vaultAddress = null } = {}) {
  const wallet = new Wallet(privateKey);
  const nonce = nextNonce(wallet.address);
  const signature = await signL1Action(wallet, action, { vaultAddress, nonce });
  return postExchange({ action, nonce, signature, vaultAddress });
}

// market-style price: mid ± slippage, then rounded to tick rules
export async function slippagePx(coin, isBuy, slippage = 0.01, ref) {
  const m = await hlAsset(coin);
  const base = ref || m.midPx || m.markPx;
  if (!base) throw new HlError(503, `No live price for ${coin}.`);
  return roundPx(base * (isBuy ? 1 + slippage : 1 - slippage), m.szDecimals);
}

/**
 * Place a perp order from a key (Agent Wallet or approved trading key).
 * limitPx omitted → aggressive IOC at mid ± slippage (a "market" order). tp/sl = trigger prices (reduce-only, market triggers).
 */
export async function hlPlaceOrder({ privateKey, coin, isBuy, size, limitPx, reduceOnly = false, tif, slippage = 0.01, leverage, isCross = true, tp, sl }) {
  if (!privateKey) throw new HlError(400, "Missing signing key.");
  const m = await hlAsset(coin);
  if (m.isDelisted) throw new HlError(400, `${coin} is delisted on Hyperliquid.`);
  const sz = roundSz(size, m.szDecimals);
  if (!(sz > 0)) throw new HlError(400, `Size rounds to zero (${coin} trades in steps of ${10 ** -m.szDecimals}).`);
  if (leverage) await hlUpdateLeverage({ privateKey, coin, leverage, isCross: m.onlyIsolated ? false : isCross });
  const isMarket = limitPx == null;
  const px = isMarket ? await slippagePx(coin, isBuy, slippage) : roundPx(limitPx, m.szDecimals);
  const wires = [orderWire({ asset: m.asset, isBuy, limitPx: px, size: sz, reduceOnly, orderType: { limit: { tif: tif || (isMarket ? "Ioc" : "Gtc") } } })];
  const trig = (triggerPx, tpsl) => {
    const tpx = roundPx(triggerPx, m.szDecimals);
    // worst acceptable fill once the trigger fires (closing side), same 10% band the SDK uses for market triggers
    const fill = roundPx(isBuy ? tpx * 0.9 : tpx * 1.1, m.szDecimals);
    return orderWire({ asset: m.asset, isBuy: !isBuy, limitPx: fill, size: sz, reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: tpx, tpsl } } });
  };
  if (tp) wires.push(trig(tp, "tp"));
  if (sl) wires.push(trig(sl, "sl"));
  const action = orderAction(wires, wires.length > 1 ? "normalTpsl" : "na");
  const res = await signAndSend(privateKey, action);
  return { coin, isBuy, size: sz, limitPx: px, market: isMarket, response: res?.response?.data?.statuses ?? res };
}

export async function hlCancel({ privateKey, coin, oid }) {
  const m = await hlAsset(coin);
  const action = { type: "cancel", cancels: [{ a: m.asset, o: Number(oid) }] };
  const res = await signAndSend(privateKey, action);
  return { coin, oid: Number(oid), response: res?.response?.data?.statuses ?? res };
}

export async function hlUpdateLeverage({ privateKey, coin, leverage, isCross = true }) {
  const m = await hlAsset(coin);
  const lev = Math.round(Number(leverage));
  if (!(lev >= 1 && lev <= m.maxLeverage)) throw new HlError(400, `${coin} allows 1–${m.maxLeverage}x leverage.`);
  const action = { type: "updateLeverage", asset: m.asset, isCross: !!isCross, leverage: lev };
  const res = await signAndSend(privateKey, action);
  return { coin, leverage: lev, isCross: !!isCross, response: res?.response ?? res };
}

/* ---------------- routes ---------------- */
const INTERVALS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };

export async function register(r) {
  // keep the shared market lists warm, so no visitor waits for Hyperliquid when an entry expires. Every 20 s: two
  // metaAndAssetCtxs reads (weight 20 each, about 120 of the 1200 per minute Hyperliquid allows this server), well
  // inside the 60 s a display read may be answered from; a page polling faster still refreshes at the 5 s ttl.
  if (process.env.TROYA_BOARD !== "0") {
    const warm = () => { hlMeta().catch(() => {}); hlXyzMeta().catch(() => {}); };
    setTimeout(warm, 3000).unref?.();
    setInterval(warm, 20_000).unref?.();
  }
  // displayName on every market (Anthropic for xyz:ANT, S&P 500 for xyz:SP500, Bitcoin for BTC)
  r.get("/api/hl/meta", async ({ query }) => {
    if (query.all !== "1") return hlMeta();
    // both lists at once: one after the other added the trade.xyz read to every cold answer
    const [main, x] = await Promise.all([hlMeta(), hlXyzMeta().catch(() => ({ markets: [] }))]);
    return { markets: [...main.markets, ...x.markets], time: main.time };
  });

  // one market's live numbers (about 1 KB), for the Perps header's 5 s refresh: it used to pull the whole list (about
  // 150 KB) each time. A bare ticker resolves like the page's link (ANT → xyz:ANT when no main perp has that name).
  r.get("/api/hl/ctx", async ({ query }) => {
    const coin = String(query.coin || "BTC").trim().slice(0, 40);
    const m = await hlAssetAny(coin);
    return { market: m, time: Date.now() };
  });

  r.get("/api/hl/mids", async () => cached("mids", 2000, () => hlInfo({ type: "allMids" })));

  r.get("/api/hl/candles", async ({ query }) => {
    const coin = String(query.coin || "BTC").trim().slice(0, 40);
    const interval = INTERVALS[query.interval] ? query.interval : "1h";
    const end = Date.now();
    const from = Number(query.from) > 0 ? Number(query.from) : end - INTERVALS[interval] * 400;
    const start = Math.max(from, end - INTERVALS[interval] * 2000);
    // the name from the lists in memory first (no wait), a lookup only when they are cold; an older list is fine here
    const canon = peekCoin(coin) || (await hlAssetAny(coin.toUpperCase())).coin;
    const bucket = Math.floor(end / Math.min(INTERVALS[interval], 60e3));
    const rows = await cached(`candles:${canon}:${interval}:${Math.floor(start / INTERVALS[interval])}:${bucket}`, 4000,
      () => hlInfo({ type: "candleSnapshot", req: { coin: canon, interval, startTime: start, endTime: end } }), { swr: 3 });
    return { coin: canon, interval, candles: (rows || []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v, n: c.n })) };
  }, { weight: 2 });

  r.get("/api/hl/book", async ({ query }) => {
    const coin = String(query.coin || "BTC").toUpperCase();
    // spot books (F12) are "@<index>" or "PURR/USDC"; anything else must be a known perp
    const canon = /^@\d{1,5}$|^[A-Z0-9]{1,12}\/USDC$/.test(coin) ? coin : peekCoin(coin) || (await hlAssetAny(coin)).coin;
    const b = await cached(`book:${canon}`, 1000, () => hlInfo({ type: "l2Book", coin: canon }));
    const side = (lv) => (lv || []).slice(0, 20).map((x) => ({ px: +x.px, sz: +x.sz, n: x.n }));
    return { coin: canon, time: b?.time || Date.now(), bids: side(b?.levels?.[0]), asks: side(b?.levels?.[1]) };
  });

  // ?fresh=1: a read at most 1 s old, for the Perps page while it waits on a funding or a move. Each IP gets 40 fresh
  // reads a minute; past that the ordinary 2.5 s copy answers (never an error), so a loop cannot drain Hyperliquid's limit.
  const freshUse = new Map();   // ip → { t, n }
  const freshOk = (ip) => {
    const now = Date.now();
    let b = freshUse.get(ip);
    if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; freshUse.set(ip, b); }
    if (freshUse.size > 5000) for (const [k, v] of freshUse) if (now - v.t > 60_000) freshUse.delete(k);
    return ++b.n <= 40;
  };
  r.get("/api/hl/user", async ({ query, ip }) => {
    if (!query.address) throw new HlError(400, "Pass ?address=0x…");
    return hlUserState(query.address, { fresh: query.fresh === "1" && freshOk(ip) });
  }, { weight: 2 });

  // Relay for payloads already signed in the browser (CSP keeps the page same-origin).
  // We only forward; keys never reach this server. Shape is checked so it cannot be used as an open proxy.
  const RELAY_TYPES = new Set(["order", "cancel", "updateLeverage", "approveAgent", "scheduleCancel", "modify", "batchModify", "usdClassTransfer", "withdraw3", "sendAsset"]);
  r.post("/api/hl/exchange", async ({ body }) => {
    const a = body?.action;
    if (!a || typeof a !== "object" || !RELAY_TYPES.has(a.type)) throw new HlError(400, "Unsupported Hyperliquid action.");
    if (!Number.isSafeInteger(body.nonce) || Math.abs(body.nonce - Date.now()) > 24 * 3600e3) throw new HlError(400, "Bad nonce.");
    const s = body.signature;
    if (!s || !/^0x[0-9a-fA-F]{1,64}$/.test(String(s.r)) || !/^0x[0-9a-fA-F]{1,64}$/.test(String(s.s)) || ![27, 28].includes(Number(s.v))) throw new HlError(400, "Bad signature.");
    if (a.type === "order" && (!Array.isArray(a.orders) || a.orders.length < 1 || a.orders.length > 10)) throw new HlError(400, "Bad order list.");
    // sendAsset only between the user's own perp balances (main ↔ trade.xyz), never to another address
    if (a.type === "sendAsset" && (![""].concat(XYZ).includes(a.sourceDex) || ![""].concat(XYZ).includes(a.destinationDex) || a.sourceDex === a.destinationDex || a.token !== XYZ_USDC || a.fromSubAccount !== "")) throw new HlError(400, "Only USDC between your Hyperliquid perps and trade.xyz balances.");
    if (a.type === "sendAsset") {
      // the destination must be the signer: recover who signed the EIP-712 message
      const types = { "HyperliquidTransaction:SendAsset": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationDex", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "fromSubAccount", type: "string" }, { name: "nonce", type: "uint64" }] };
      let signer = null;
      try { signer = verifyTypedData({ name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(a.signatureChainId, 16), verifyingContract: "0x0000000000000000000000000000000000000000" }, types,
        { hyperliquidChain: a.hyperliquidChain, destination: a.destination, sourceDex: a.sourceDex, destinationDex: a.destinationDex, token: a.token, amount: a.amount, fromSubAccount: a.fromSubAccount, nonce: a.nonce }, { r: s.r, s: s.s, v: Number(s.v) }); } catch {}
      if (!signer || signer.toLowerCase() !== String(a.destination).toLowerCase()) throw new HlError(400, "USDC can only move between your own balances.");
    }
    const payload = { action: a, nonce: body.nonce, signature: { r: s.r, s: s.s, v: Number(s.v) }, vaultAddress: body.vaultAddress || null };
    return postExchange(payload);
  }, { weight: 3, perMin: 120, maxBody: 32 * 1024 });

  // perps end to end on the Perps page (asked in the group, 15–16 Nov 2026): a funding quote sized by the margin that is
  // missing, ETH on Robinhood Chain → USDC on the same address on Hyperliquid (at least 6 USDC: Hyperliquid's minimum is 5)
  r.get("/api/hl/fund-quote", async ({ query }) => {
    if (!isAddress(query.address || "")) throw new HlError(400, "Pass ?address=0x…");
    const want = Number(query.usd);
    if (!(want > 0) || want > 100000) throw new HlError(400, "Pass ?usd= with the USDC you need.");
    const [{ ethUsd }, { hlFundQuote }] = await Promise.all([import("./tools.mjs"), import("./robinhood.mjs")]);
    const ep = await ethUsd();
    if (!(ep > 0)) throw new HlError(502, "No ETH price right now. Try again in a minute.");
    const fundUsd = Math.max(6, want * 1.04);
    const amountEth = Math.ceil((fundUsd / ep) * 1e6) / 1e6;
    const q = await hlFundQuote({ address: getAddress(query.address), amountWei: (BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n).toString() });
    return { ...q, fundUsd: +fundUsd.toFixed(2), amountEth };
  }, { weight: 2, perMin: 30 });

  // which trading keys (agents) this account has approved on Hyperliquid
  r.get("/api/hl/agents", async ({ query }) => {
    if (!isAddress(query.address || "")) throw new HlError(400, "Pass ?address=0x…");
    const user = getAddress(query.address).toLowerCase();
    const list = await cached(`agents:${user}`, 3000, () => hlInfo({ type: "extraAgents", user }));
    return { address: user, agents: (list || []).map((a) => ({ name: a.name, address: a.address, validUntil: a.validUntil ?? null })) };
  });
}
