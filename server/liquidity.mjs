// F18 · Liquidity desk: Uniswap v3 positions on Robinhood Chain. The agent sets the range from volatility, watches it
// and calls the rebalance; the user's wallet signs every transaction (mint, collect, remove) in the browser.
//   GET /api/lp/pools?token=          → Uniswap v3 pools (each checked on chain: its factory is Uniswap's), with the live
//                                       price, active liquidity, TVL, 24h volume and the pool's fee APR
//   GET /api/lp/suggest?pool=&days=   → ranges from realized volatility (hourly candles): tight, balanced and wide, ticks
//                                       aligned to the pool, the chance the price stays inside for the whole period, and
//                                       the fees $1,000 would earn per day at today's volume while in range
//   GET /api/lp/positions?address=    → the wallet's v3 positions: range, in range or not, token amounts, uncollected
//                                       fees, value, and how far the price is from each edge
// Sources: the pool and position contracts on chain; DexScreener for TVL, 24h volume and USD prices (fresh every 2 min);
// GeckoTerminal for hourly candles (one call per pool per hour, the top pools measured ahead in the background) and the
// list of busiest pools (one call per hour). Its free quota is shared, so nothing here waits on it twice.
import { Interface, getAddress, isAddress } from "ethers";
import { rpc, ADDR, STOCKS } from "./robinhood.mjs";
import { geckoApi } from "./market.mjs";
import { HttpError } from "./api.mjs";

export const NPM = getAddress("0x73991a25c818bf1f1128deaab1492d45638de0d3");
const FACTORY = ADDR.v3Factory.toLowerCase();
const WETH = ADDR.weth.toLowerCase(), USDG = ADDR.usdg.toLowerCase();
const DEX = "uniswap-v3-robinhood";
const lc = (s) => String(s || "").toLowerCase();
const MAX_U128 = (1n << 128n) - 1n;

const poolI = new Interface([
  "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)", "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
]);
const ercI = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const npmI = new Interface([
  "function balanceOf(address) view returns (uint256)", "function ownerOf(uint256) view returns (address)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
]);
const factoryI = new Interface(["function getPool(address,address,uint24) view returns (address)"]);
const mcI = new Interface(["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)"]);

async function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 120) {
    const part = calls.slice(i, i + 120);
    const raw = await rpc("robinhood", "eth_call", [{ to: ADDR.multicall3, data: mcI.encodeFunctionData("aggregate3", [part.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))]) }, "latest"], { timeoutMs: 15000 });
    out.push(...mcI.decodeFunctionResult("aggregate3", raw)[0]);
  }
  return out;
}
const dec = (i, fn, r) => (r?.success ? i.decodeFunctionResult(fn, r.returnData) : null);

const memo = new Map();
// swr: past its age, a value is still served while a fresh one is fetched in the background
async function cached(key, ms, fn, swr = false) {
  const hit = memo.get(key);
  if (hit && "v" in hit && Date.now() - hit.at < ms) return hit.v;
  if (swr && hit && "v" in hit && hit.v != null) { if (!hit.p) cached(key, 0, fn).catch(() => {}); return hit.v; }
  if (hit?.p) return hit.p;
  const p = fn().then((v) => { memo.set(key, { at: Date.now(), v }); return v; },
    (e) => { memo.set(key, hit && "v" in hit ? { at: hit.at, v: hit.v } : {}); throw e; });
  memo.set(key, { ...(hit || {}), p });
  return p;
}

/* ---------- v3 math (floats: for display, ranges and estimates; the contracts do the exact math) ---------- */
export const tickPrice = (t) => Math.pow(1.0001, t);                 // token1 raw per token0 raw
const sqrtOfTick = (t) => Math.pow(1.0001, t / 2);
const sqrtOfX96 = (x) => Number(BigInt(x)) / 2 ** 96;
const MIN_TICK = -887272, MAX_TICK = 887272;
export function amountsFor(L, sp, sa, sb) {
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
}
const norm = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
// chance a driftless random walk with this volatility never leaves ±k standard deviations over the period
function stayInside(k) {
  let s = 0;
  for (let n = 0; n < 40; n++) s += ((n % 2 ? -1 : 1) / (2 * n + 1)) * Math.exp(-((2 * n + 1) ** 2) * Math.PI ** 2 / (8 * k * k));
  return Math.max(0, Math.min(1, (4 / Math.PI) * s));
}

/* ---------- tokens and pools ---------- */
const metas = new Map();
async function tokenMetas(addrs) {
  const need = [...new Set(addrs.map(lc))].filter((a) => !metas.has(a));
  if (need.length) {
    const r = await multicall(need.flatMap((a) => [{ to: a, data: ercI.encodeFunctionData("symbol") }, { to: a, data: ercI.encodeFunctionData("decimals") }]));
    need.forEach((a, i) => {
      const symbol = dec(ercI, "symbol", r[2 * i])?.[0], decimals = dec(ercI, "decimals", r[2 * i + 1])?.[0];
      if (decimals != null) metas.set(a, { address: a, symbol: String(symbol || "?").slice(0, 16), decimals: Number(decimals) });
    });
  }
  return Object.fromEntries(addrs.map((a) => [lc(a), metas.get(lc(a))]));
}

// read pools on chain; anything not created by Uniswap's v3 factory is dropped
async function readPools(addrs) {
  const F = ["factory", "token0", "token1", "fee", "tickSpacing", "liquidity", "slot0"];
  const r = await multicall(addrs.flatMap((a) => F.map((f) => ({ to: a, data: poolI.encodeFunctionData(f) }))));
  const pools = [];
  addrs.forEach((a, i) => {
    const g = (k) => dec(poolI, F[k], r[i * F.length + k]);
    const f = g(0)?.[0];
    if (!f || lc(f) !== FACTORY) return;
    const s0 = g(6);
    if (!s0) return;
    pools.push({ address: lc(a), token0: lc(g(1)[0]), token1: lc(g(2)[0]), fee: Number(g(3)[0]), tickSpacing: Number(g(4)[0]), liquidity: g(5)[0].toString(), sqrtPriceX96: s0.sqrtPriceX96.toString(), tick: Number(s0.tick) });
  });
  const m = await tokenMetas(pools.flatMap((p) => [p.token0, p.token1]));
  return pools.filter((p) => m[p.token0] && m[p.token1]).map((p) => ({ ...p, t0: m[p.token0], t1: m[p.token1] }));
}

// the side people quote in: USDG, then WETH, then the other token
const rank = (a) => (a === USDG ? 2 : a === WETH ? 1 : 0);
function present(p, gt) {
  const raw = sqrtOfX96(p.sqrtPriceX96) ** 2;
  const price = raw * 10 ** (p.t0.decimals - p.t1.decimals);         // token1 per token0
  const invert = rank(p.token0) > rank(p.token1);
  const usd0 = gt?.usd?.[p.token0] ?? null, usd1 = gt?.usd?.[p.token1] ?? null;
  const sym = (t) => (t.address === WETH ? "ETH" : t.symbol);
  return {
    address: p.address, fee: p.fee, feePct: p.fee / 1e4, tickSpacing: p.tickSpacing, tick: p.tick, sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity,
    token0: { ...p.t0, label: sym(p.t0), priceUsd: usd0 }, token1: { ...p.t1, label: sym(p.t1), priceUsd: usd1 },
    price, invert, base: invert ? sym(p.t1) : sym(p.t0), quote: invert ? sym(p.t0) : sym(p.t1), display: invert ? 1 / price : price,
    name: invert ? `${sym(p.t1)} / ${sym(p.t0)}` : `${sym(p.t0)} / ${sym(p.t1)}`,
    tvlUsd: gt?.tvl ?? null, volume24hUsd: gt?.vol ?? null,
    feeAprPct: gt?.tvl > 0 && gt?.vol != null ? (gt.vol * p.fee / 1e6 / gt.tvl) * 365 * 100 : null,
    chart: `https://www.geckoterminal.com/robinhood/pools/${p.address}`,
  };
}

const gtId = (x) => lc(String(x?.id || "").split("_").pop());
function gtRows(d) {
  return (d?.data || []).filter((x) => x?.relationships?.dex?.data?.id === DEX).map((x) => {
    const a = x.attributes || {}, base = gtId(x.relationships?.base_token?.data), quote = gtId(x.relationships?.quote_token?.data);
    return { address: lc(a.address), tvl: Number(a.reserve_in_usd) || 0, vol: Number(a.volume_usd?.h24) || 0, usd: { [base]: Number(a.base_token_price_usd) || null, [quote]: Number(a.quote_token_price_usd) || null } };
  });
}

// TVL, 24h volume and both tokens' USD prices from DexScreener's pair endpoint (30 pools a call, 300 calls a minute)
const DSP = "https://api.dexscreener.com/latest/dex/pairs/robinhood/";
async function dsStats(addrs) {
  const out = new Map(), list = [...new Set(addrs.map(lc))].sort();
  for (let i = 0; i < list.length; i += 30) {
    const part = list.slice(i, i + 30);
    const d = await cached(`lp:ds:${part.join(",")}`, 120_000, async () => {
      const r = await fetch(DSP + part.join(","), { headers: { accept: "application/json", "user-agent": "troya-agent/0.2" }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`DexScreener answered ${r.status}`);
      return r.json();
    }, true).catch(() => null);
    for (const p of d?.pairs || []) {
      const b = lc(p.baseToken?.address), q = lc(p.quoteToken?.address), pu = Number(p.priceUsd) || null, pn = Number(p.priceNative) || null;
      out.set(lc(p.pairAddress), { address: lc(p.pairAddress), tvl: Number(p.liquidity?.usd) || 0, vol: Number(p.volume?.h24) || 0, usd: { [b]: pu, [q]: pu && pn ? pu / pn : null } });
    }
  }
  return out;
}
const FEES = [100, 500, 3000, 10000];
// every Uniswap v3 pool of a token against ETH and USDG, straight from the factory, plus any other pair DexScreener knows
async function poolsOfToken(t) {
  const quotes = [WETH, USDG].filter((q) => q !== t);
  const pairs = quotes.flatMap((q) => FEES.map((f) => [q, f]));
  const r = await multicall(pairs.map(([q, f]) => ({ to: ADDR.v3Factory, data: factoryI.encodeFunctionData("getPool", [t, q, f]) })));
  const found = r.map((x) => lc(dec(factoryI, "getPool", x)?.[0] || "")).filter((a) => a && !/^0x0{40}$/.test(a));
  const ds = await cached(`lp:dstoken:${t}`, 300_000, async () => {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${t}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    return res.ok ? res.json() : [];
  }).catch(() => []);
  for (const p of Array.isArray(ds) ? ds : []) if (p.dexId === "uniswap" && (p.labels || []).includes("v3")) found.push(lc(p.pairAddress));
  return [...new Set(found)];
}
// the busiest pools: GeckoTerminal's list, asked once an hour (served from memory meanwhile); if it cannot answer, the
// factory's pools for ETH/USDG and every stock token against USDG and ETH
async function topPoolAddrs() {
  return cached("lp:top", 3600_000, async () => {
    const d = await geckoApi(`dexes/${DEX}/pools?sort=h24_volume_usd_desc&page=1`, { hi: true }).catch(() => null);
    const rows = gtRows(d).map((x) => x.address);
    if (rows.length >= 5) return rows;
    const pairs = [...FEES.map((f) => [WETH, USDG, f]), ...STOCKS.flatMap((s) => [[s.address, USDG, 500], [s.address, WETH, 500], [s.address, USDG, 3000]])];
    const r = await multicall(pairs.map(([a, b, f]) => ({ to: ADDR.v3Factory, data: factoryI.encodeFunctionData("getPool", [a, b, f]) })));
    return r.map((x) => lc(dec(factoryI, "getPool", x)?.[0] || "")).filter((a) => a && !/^0x0{40}$/.test(a));
  }, true);
}

export async function lpPools(token) {
  const t = token && isAddress(token) ? lc(token) : null;
  return cached(`lp:pools:${t || "top"}`, 120_000, async () => {
    const addrs = (t ? await poolsOfToken(t) : await topPoolAddrs()).slice(0, 60);
    if (!addrs.length) return { pools: [], token: t, updatedAt: Date.now(), note: t ? "No Uniswap v3 pool for this token on Robinhood Chain." : "No pools could be read right now." };
    const [pools, stats] = await Promise.all([readPools(addrs), dsStats(addrs)]);
    const list = pools.map((p) => present(p, stats.get(p.address))).filter((p) => t || (p.tvlUsd || 0) >= 1000)
      .sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 25);
    return { pools: list, token: t, updatedAt: Date.now(), note: list.length ? "" : "No Uniswap v3 pool with liquidity for this token.", source: "Uniswap v3 on chain · DexScreener TVL, volume and prices" };
  }, true);
}

async function poolInfo(address) {
  if (!isAddress(address)) throw new HttpError(400, "That is not a pool address.");
  const a = lc(address);
  const [[p], stats] = await Promise.all([readPools([a]), dsStats([a])]);
  if (!p) throw new HttpError(404, "Not a Uniswap v3 pool on Robinhood Chain.");
  return present(p, stats.get(a));
}

/* ---------- ranges from volatility ---------- */
async function volatility(pool, bg = false) {
  return cached(`lp:vol:${pool}`, 60 * 60_000, async () => {
    const d = await geckoApi(`pools/${pool}/ohlcv/hour?aggregate=1&limit=300&currency=token`, { hi: !bg });
    const closes = (d?.data?.attributes?.ohlcv_list || []).map((x) => Number(x[4])).filter((x) => x > 0).reverse();
    const r = [];
    for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
    if (r.length < 24) return null;
    const m = r.reduce((s, x) => s + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
    return { hourly: sd, samples: r.length };
  }, true);
}
const align = (t, sp, up) => Math.max(Math.ceil(MIN_TICK / sp) * sp, Math.min(Math.floor(MAX_TICK / sp) * sp, (up ? Math.ceil(t / sp) : Math.floor(t / sp)) * sp));

export function rangeFor(p, lowerTick, upperTick, dayVol = p.volume24hUsd) {
  const d = 10 ** (p.token0.decimals - p.token1.decimals);
  const pl = tickPrice(lowerTick) * d, pu = tickPrice(upperTick) * d;
  const out = { lowerTick, upperTick, priceLower: pl, priceUpper: pu, displayLower: p.invert ? 1 / pu : pl, displayUpper: p.invert ? 1 / pl : pu };
  // fees $1,000 would earn per day at today's volume while the price stays inside: its share of the active liquidity
  const sp = sqrtOfX96(p.sqrtPriceX96), sa = sqrtOfTick(lowerTick), sb = sqrtOfTick(upperTick);
  const [a0, a1] = amountsFor(1, sp, sa, sb);
  const perL = (a0 / 10 ** p.token0.decimals) * (p.token0.priceUsd || 0) + (a1 / 10 ** p.token1.decimals) * (p.token1.priceUsd || 0);
  if (perL > 0 && dayVol && p.tick >= lowerTick && p.tick < upperTick) {
    const L = 1000 / perL, share = L / (Number(p.liquidity) + L);
    out.feesPer1kDay = dayVol * (p.fee / 1e6) * share;
    out.aprInRangePct = out.feesPer1kDay * 365 / 10;
  } else { out.feesPer1kDay = 0; out.aprInRangePct = 0; }
  return out;
}

export async function lpSuggest(pool, days = 7) {
  const p = await poolInfo(pool);
  const T = Math.min(90, Math.max(1, Number(days) || 7));
  const v = await volatility(p.address);
  if (!v) throw new HttpError(409, "Not enough price history for this pool yet (needs a day of hourly candles).");
  const sT = v.hourly * Math.sqrt(24 * T);
  const center = Math.log(sqrtOfX96(p.sqrtPriceX96) ** 2) / Math.log(1.0001);
  const presets = [["tight", "Tight", 1], ["balanced", "Balanced", 2], ["wide", "Wide", 3]].map(([key, label, k]) => {
    const w = k * sT / Math.log(1.0001);                                  // half-width in ticks
    let lo = align(center - w, p.tickSpacing, false), hi = align(center + w, p.tickSpacing, true);
    if (hi <= lo) hi = lo + p.tickSpacing;
    return { key, label, k, widthPct: (Math.exp(k * sT) - 1) * 100, stayPct: stayInside(k) * 100, endInsidePct: (2 * norm(k) - 1) * 100, ...rangeFor(p, lo, hi) };
  });
  return {
    pool: p, days: T, volatility: { hourlyPct: v.hourly * 100, annualPct: v.hourly * Math.sqrt(24 * 365) * 100, periodPct: sT * 100, samples: v.samples },
    presets, updatedAt: Date.now(),
    note: "Ranges come from how much this pool's price moved hour to hour over the last weeks. The chance to stay inside assumes it keeps moving like that, with no trend; it is not a forecast. Fee estimates use today's 24h volume and the liquidity active at the current price.",
  };
}

/* ---------- the wallet's positions ---------- */
export async function lpPositions(address, only = null) {
  if (!isAddress(address)) throw new HttpError(400, "That is not a valid address.");
  const owner = getAddress(address);
  let ids;
  if (only != null) ids = [BigInt(only)];
  else {
    const n = Number(dec(npmI, "balanceOf", (await multicall([{ to: NPM, data: npmI.encodeFunctionData("balanceOf", [owner]) }]))[0])?.[0] || 0);
    const r = await multicall(Array.from({ length: Math.min(n, 60) }, (_, i) => ({ to: NPM, data: npmI.encodeFunctionData("tokenOfOwnerByIndex", [owner, n - 1 - i]) })));
    ids = r.map((x) => dec(npmI, "tokenOfOwnerByIndex", x)?.[0]).filter((x) => x != null);
  }
  const pr = await multicall(ids.map((id) => ({ to: NPM, data: npmI.encodeFunctionData("positions", [id]) })));
  const raw = ids.map((id, i) => ({ id, p: dec(npmI, "positions", pr[i]) })).filter((x) => x.p && (x.p.liquidity > 0n || x.p.tokensOwed0 > 0n || x.p.tokensOwed1 > 0n)).slice(0, 30);
  if (!raw.length) return { positions: [], updatedAt: Date.now() };
  const keys = [...new Map(raw.map((x) => [`${lc(x.p.token0)}:${lc(x.p.token1)}:${x.p.fee}`, x.p])).values()];
  const pa = await multicall(keys.map((p) => ({ to: ADDR.v3Factory, data: factoryI.encodeFunctionData("getPool", [p.token0, p.token1, p.fee]) })));
  const poolOf = new Map(keys.map((p, i) => [`${lc(p.token0)}:${lc(p.token1)}:${p.fee}`, lc(dec(factoryI, "getPool", pa[i])?.[0] || "")]));
  const pools = new Map((await readPools([...new Set([...poolOf.values()].filter((x) => x && !/^0x0{40}$/.test(x)))])).map((p) => [p.address, p]));
  const gt = await dsStats([...pools.keys()]);
  // uncollected fees: what collect would pay right now, simulated from the owner (it must be the caller)
  const fees = await Promise.all(raw.map(async (x) => {
    try {
      const data = npmI.encodeFunctionData("collect", [{ tokenId: x.id, recipient: owner, amount0Max: MAX_U128, amount1Max: MAX_U128 }]);
      const r = npmI.decodeFunctionResult("collect", await rpc("robinhood", "eth_call", [{ from: owner, to: NPM, data }, "latest"], { timeoutMs: 10000 }));
      return [BigInt(r[0]), BigInt(r[1])];
    } catch { return [x.p.tokensOwed0, x.p.tokensOwed1]; }
  }));
  const positions = raw.map((x, i) => {
    const pool = pools.get(poolOf.get(`${lc(x.p.token0)}:${lc(x.p.token1)}:${x.p.fee}`));
    if (!pool) return null;
    const P = present(pool, gt.get(pool.address));
    const lo = Number(x.p.tickLower), hi = Number(x.p.tickUpper), L = Number(x.p.liquidity);
    const [a0, a1] = amountsFor(L, sqrtOfX96(pool.sqrtPriceX96), sqrtOfTick(lo), sqrtOfTick(hi));
    const d0 = 10 ** pool.t0.decimals, d1 = 10 ** pool.t1.decimals;
    const amt0 = a0 / d0, amt1 = a1 / d1, f0 = Number(fees[i][0]) / d0, f1 = Number(fees[i][1]) / d1;
    const v = (q0, q1) => (P.token0.priceUsd != null && P.token1.priceUsd != null ? q0 * P.token0.priceUsd + q1 * P.token1.priceUsd : null);
    const r = rangeFor(P, lo, hi, null);
    const inRange = pool.tick >= lo && pool.tick < hi;
    // how far the price can move before it leaves the range, in the displayed direction
    const now = P.display, down = now > 0 ? (now - r.displayLower) / now * 100 : null, up = now > 0 ? (r.displayUpper - now) / now * 100 : null;
    return {
      tokenId: x.id.toString(), pool: P.address, name: P.name, fee: P.fee, feePct: P.feePct, base: P.base, quote: P.quote, invert: P.invert,
      token0: P.token0, token1: P.token1, tickLower: lo, tickUpper: hi, tick: pool.tick, liquidity: x.p.liquidity.toString(),
      price: P.display, displayLower: r.displayLower, displayUpper: r.displayUpper, inRange, roomDownPct: down, roomUpPct: up,
      amount0: amt0, amount1: amt1, fees0: f0, fees1: f1, valueUsd: v(amt0, amt1), feesUsd: v(f0, f1), closed: L === 0,
    };
  }).filter(Boolean);
  return { positions, updatedAt: Date.now() };
}

// one position, for the watch: ownership is checked so a watch cannot follow someone else's NFT
export async function lpPositionStatus(owner, tokenId) {
  const r = await multicall([{ to: NPM, data: npmI.encodeFunctionData("ownerOf", [BigInt(tokenId)]) }]);
  const o = dec(npmI, "ownerOf", r[0])?.[0];
  if (!o) return { gone: true };
  if (lc(o) !== lc(owner)) return { moved: true };
  return (await lpPositions(owner, tokenId)).positions[0] || { gone: true };
}

// for the chat: a pair ("NVDA/USDG", "eth usdg"), a token address or a pool address → the ranges, kept short
export async function lpRangeFor(pair, days = 7) {
  const q = String(pair || "").trim();
  let pool = null;
  if (isAddress(q)) {
    const [p] = await readPools([lc(q)]).catch(() => []);
    pool = p ? p.address : (await lpPools(q)).pools[0]?.address;
  } else {
    const want = q.toUpperCase().replace(/WETH/g, "ETH").split(/[\s/,-]+/).filter(Boolean).slice(0, 2);
    const top = (await lpPools()).pools;
    pool = top.find((p) => want.every((w) => p.name.toUpperCase().split(" / ").includes(w)))?.address;
  }
  if (!pool) return { found: false, note: "No Uniswap v3 pool with liquidity found for that on Robinhood Chain. Paste the token address, or open Liquidity desk to browse the pools." };
  const s = await lpSuggest(pool, days);
  const p = s.pool, f = (n) => Number(Number(n).toPrecision(6));
  return {
    pool: p.address, pair: p.name, feeTierPct: p.feePct, price: `${f(p.display)} ${p.quote} per ${p.base}`, tvlUsd: Math.round(p.tvlUsd || 0), volume24hUsd: Math.round(p.volume24hUsd || 0),
    poolFeeAprPct: p.feeAprPct != null ? +p.feeAprPct.toFixed(1) : null, volatilityAnnualPct: +s.volatility.annualPct.toFixed(1), days: s.days,
    ranges: s.presets.map((x) => ({ name: x.label, from: f(x.displayLower), to: f(x.displayUpper), widthPct: +x.widthPct.toFixed(1), chanceToStayInsidePct: +x.stayPct.toFixed(0), feesPer1000UsdPerDay: +x.feesPer1kDay.toFixed(2), aprWhileInsidePct: +x.aprInRangePct.toFixed(0) })),
    open: `https://troya.codes/agent/#/liquidity/${p.address}`, note: s.note,
  };
}

// measure the busiest pools ahead, as background jobs, so their ranges open at once
async function warm() {
  try {
    const top = (await lpPools()).pools.slice(0, 8);
    for (const p of top) await volatility(p.address, true).catch(() => {});
  } catch {}
}

export async function register(r) {
  if (process.env.LP_WARM !== "0") { setTimeout(warm, 90_000).unref?.(); setInterval(warm, 50 * 60_000).unref?.(); }
  r.get("/api/lp/pools", ({ query }) => lpPools(query.token || null), { weight: 1 });
  r.get("/api/lp/suggest", ({ query }) => lpSuggest(query.pool, query.days), { weight: 1 });
  r.get("/api/lp/positions", ({ query }) => lpPositions(query.address), { weight: 1 });
}
