// V10 F63 Sirens: Real Depth and Honest Volume. The Sirens sang beautifully and sank ships: a coin can look deep and busy
// and still sink the trader who believes it. One Robinhood Chain coin in, three readings out:
//   GET /api/sirens/:token     (address, ticker or name)   → { coin, depth, volume, family, partial, method }
//   GET /api/sirens            the published method, as text the page shows
//
// 1. Real depth. Price impact of a buy and a sell of $100, $1,000 and $10,000 on every Robinhood Chain venue Troya
//    already quotes, through the same functions Swap and Swift use (nothing is re-implemented):
//      Pons curve ........ robinhood.mjs quoteSwap (the curve maths, while the coin is on its curve)
//      Uniswap v3 / v4 ... robinhood.mjs uniswapVenues (best path of each version, impact from a 1/1000 probe on it)
//      KyberSwap ......... kyber.mjs kyberRoute (the aggregator's other Robinhood Chain pools), impact against a $10 probe
//      Lighter spot ...... Lighter's public order book (api.rh.lighter.xyz), walked level by level
//    Impact is how much worse the average price of the size is than the price of a tiny trade on the same route, so fees
//    and taxes are not in it. From a quote's impact m at size x, an equivalent full-range pool holds R = x(1-m)/m on its
//    money side: "behaves like a pool of 2R". A venue whose reported liquidity (DexScreener) is at least 4 times what its
//    own $1,000 quote behaves like is flagged "looks deep, quotes shallow".
// 2. Honest volume. The coin's own Transfer logs over the last 24 hours (the official RPC's wide eth_getLogs, as Assay and
//    Watchfire read them): a move from a venue (its Pons curve, the Uniswap v4 PoolManager, every pool DexScreener lists)
//    to a wallet is a buy, from a wallet to a venue a sell; a router in the middle is looked through (Watchfire's rule).
//    Transactions that add or remove liquidity (v3 Mint/Burn/Collect, v4 ModifyLiquidity) are left out. Each trade is
//    priced in USD at the 5-minute close of the coin's own chart. Then, in this order, each trade removed once:
//      A same transaction  a wallet buys and sells the coin inside one transaction (self-trade or arbitrage)
//      B round trip        a wallet's buy and sell within 10 minutes, sizes within 10% of each other
//      C ended flat        a wallet with 6 or more trades whose buys and sells end within 5% of each other: all of it
//      D linked wallets    wallets first funded by the same wallet (Assay's funding read) trading the coin back and forth
//                          between them (B across the group), or the group ending flat (C across the group)
//      E scripted repeats  the same wallet or group trading the exact same coin amount 5 or more times
//    Honest volume = what is left. DexScreener's reported 24-hour volume is shown next to it; Tribute's pool flags (a round
//    total, many times the pool) are added when Tribute already has a reading.
// 3. Family tree. Tokens with the same ticker or name on other chains (DexScreener search), each marked: an official link
//    (a LayerZero OFT peer of this contract, or the parent token of a canonical bridge), plausibly official (same address,
//    same deployer on a chain with a public Blockscout, or the same website or X account), or a lookalike (a different
//    contract with no link found). What could not be checked is said.
// Cached: depth 3 minutes, volume 5 minutes, family 20 minutes; an answer waits at most ~22 s, then says which parts are
// still being read (they keep reading; the page asks again). Read-only: nothing here trades, signs or moves money.
import { isAddress, getAddress, parseUnits, formatUnits, id as keccakId } from "ethers";
import { HttpError } from "./api.mjs";
import { rpc, CHAINS, ADDR, tokenMeta, ponsState, quoteSwap, uniswapVenues } from "./robinhood.mjs";

const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const at = (t) => "0x" + String(t).slice(26).toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const why = (e) => String(e?.message || e || "failed").replace(/\s+/g, " ").slice(0, 240);
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const SIZES = [100, 1000, 10000];
const RULES = { windowS: 600, sizeTol: 0.10, flatTol: 0.05, flatMinTrades: 6, repeatMin: 5, funderWallets: 25, looksDeepX: 4, looksDeepMinUsd: 5000 };
const TTL = { depth: 3 * 60_000, volume: 5 * 60_000, family: 20 * 60_000 };
const WAIT_MS = 22_000, VOLUME_BUDGET_MS = 80_000, FUNDER_BUDGET_MS = 35_000;
const MAX_TRANSFERS = 150_000;
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const T_LIQ = [keccakId("Mint(address,address,int24,int24,uint128,uint256,uint256)"), keccakId("Burn(address,int24,int24,uint128,uint256,uint256)"),
  keccakId("Collect(address,address,int24,int24,uint128,uint128)")];
const T_V4LIQ = keccakId("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
// routers and position managers: never a trader (the wallet behind them is)
const ROUTERS = new Set([ADDR.universalRouter, ADDR.swapRouter02, ADDR.permit2, ADDR.ponsFactory, ADDR.ponsHook].map(lc).concat([
  "0x204faca1764b154221e35c0d20abb3c525710498", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  "0x73991a25c818bf1f1128deaab1492d45638de0d3", "0x58daec3116aae6d93017baaea7749052e8a04fa7", "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e"]));
const LIGHTER = "https://api.rh.lighter.xyz", USDG_ASSET = 3;
// LayerZero v2 endpoint ids → DexScreener chain ids (the chains a peer can be matched on)
const LZ = { ethereum: 30101, bsc: 30102, avalanche: 30106, polygon: 30109, arbitrum: 30110, optimism: 30111, mantle: 30181, linea: 30183, base: 30184,
  solana: 30168, unichain: 30320, abstract: 30324, sonic: 30332, berachain: 30362, hyperevm: 30367 };
// chains with a free public Blockscout, where a token's creator can be read
const BLOCKSCOUT = { ethereum: "https://eth.blockscout.com", base: "https://base.blockscout.com", arbitrum: "https://arbitrum.blockscout.com",
  optimism: "https://optimism.blockscout.com", polygon: "https://polygon.blockscout.com", gnosis: "https://gnosis.blockscout.com" };
const CHAIN_NAME = { robinhood: "Robinhood Chain", ethereum: "Ethereum", base: "Base", arbitrum: "Arbitrum", optimism: "Optimism", polygon: "Polygon", bsc: "BNB Chain",
  solana: "Solana", avalanche: "Avalanche", hyperevm: "HyperEVM", sui: "Sui", ton: "TON", tron: "Tron", mantle: "Mantle", linea: "Linea", sonic: "Sonic",
  abstract: "Abstract", berachain: "Berachain", unichain: "Unichain", blast: "Blast", zksync: "zkSync", pulsechain: "PulseChain", cronos: "Cronos", gnosis: "Gnosis" };
const chainName = (c) => CHAIN_NAME[c] || String(c || "?").replace(/^./, (x) => x.toUpperCase());

let marketMod = null;
const market = async () => (marketMod ||= await import("./market.mjs"));
// swappable for tests: the funding read (Assay's, which keeps its own cache)
export const deps = { fundingOf: async (a, head) => (await import("./assay.mjs")).fundingOf(a, head) };
export function _setDeps(o) { Object.assign(deps, o); }

function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}
async function getJson(url, ms = 9000) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "troya-agent/0.2" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.json();
}
const memo = new Map();
function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  memo.set(key, { at: Date.now(), p });
  p.catch(() => { if (memo.get(key)?.p === p) memo.delete(key); });
  if (memo.size > 600) for (const [k, v] of memo) if (Date.now() - v.at > 30 * 60_000) memo.delete(k);
  return p;
}

/* ---------- the coin ---------- */
async function resolveCoin(q) {
  const raw = String(q || "").trim().replace(/^\$/, "");
  if (!raw) throw new HttpError(400, "Type or paste a coin: its address, ticker or name.");
  if (raw.length > 64) throw new HttpError(400, "That is too long for a coin name or address.");
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
  if (!address) {
    const r = await within((await market()).searchCoins(raw, 8), 6000, "Coin search").catch(() => null);
    const c = (r?.coins || []).find((x) => x.kind !== "major" && /^0x[0-9a-f]{40}$/i.test(x.address || ""));
    if (!c) throw new HttpError(404, `No Robinhood Chain coin matches "${raw}". Paste its contract address instead.`);
    address = c.address;
  }
  if (!isAddress(address)) throw new HttpError(400, "That is not a valid address.");
  if ([lc(ADDR.weth), lc(ADDR.usdg), ZERO].includes(lc(address))) throw new HttpError(400, "Pick a coin other than ETH, WETH or USDG.");
  const m = await tokenMeta(getAddress(lc(address))).catch(() => null);
  if (!m) throw new HttpError(404, "That address is not a token on Robinhood Chain.");
  return { address: getAddress(m.address), symbol: m.symbol, name: m.name, decimals: Number(m.decimals), totalSupply: m.totalSupply || null, stock: !!m.stock };
}
// what Troya knows about the coin's market: its DexScreener pairs, price, ETH price, Pons state
async function context(coin) {
  return cached(`ctx:${lc(coin.address)}`, 60_000, async () => {
    const M = await market();
    const [pairs, ethUsd, ps] = await Promise.all([
      M.dsTokenPairs(coin.address).catch(() => []), M.getEthUsd().catch(() => null), ponsState(coin.address).catch(() => null)]);
    const a = lc(coin.address);
    const own = (pairs || []).filter((p) => lc(p.baseToken?.address) === a || lc(p.quoteToken?.address) === a);
    const based = own.filter((p) => lc(p.baseToken?.address) === a && Number(p.priceUsd) > 0).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    let priceUsd = null, priceSource = null;
    const row = M.indexRow?.(a);
    if (Number(row?.priceUsd) > 0) { priceUsd = Number(row.priceUsd); priceSource = "Troya's market board"; }
    else if (based[0]) { priceUsd = Number(based[0].priceUsd); priceSource = `DexScreener (${based[0].dexId})`; }
    return { pairs: own, ethUsd: Number(ethUsd) > 0 ? Number(ethUsd) : null, ps, priceUsd, priceSource };
  });
}
const pairVenue = (p) => {
  const d = lc(p.dexId), l = (p.labels || []).map(lc);
  if (d === "uniswap" && l.includes("v4")) return "uniswap-v4";
  if (d === "uniswap" && l.includes("v3")) return "uniswap-v3";
  if (d === "uniswap") return l.includes("v2") ? "other" : "uniswap-v3";
  if (/pons/.test(d)) return "pons-curve";
  return "other";
};

/* ================= 1. real depth ================= */
const NAMES = { "pons-curve": "Pons curve", "uniswap-v3": "Uniswap v3", "uniswap-v4": "Uniswap v4", kyberswap: "KyberSwap (aggregator)", "lighter-spot": "Lighter spot" };
const effOf = (sizeUsd, m) => (m > 0.0005 && m < 0.999 ? (2 * sizeUsd * (1 - m)) / m : null);   // equivalent full-range pool, both sides
const usdWei = (usd, ethUsd) => parseUnits((usd / ethUsd).toFixed(18), 18);
const tokRaw = (usd, priceUsd, dec) => { const n = usd / priceUsd; if (!(n > 0) || !isFinite(n)) return null; return parseUnits(n.toFixed(Math.min(dec, 12)), dec); };

async function lighterSpot(coin) {
  const [books, assets] = await Promise.all([getJson(`${LIGHTER}/api/v1/orderBooks`, 8000), getJson(`${LIGHTER}/api/v1/assetDetails`, 8000)]);
  const asset = (assets.asset_details || []).find((x) => lc(x.l1_address) === lc(coin.address));
  if (!asset) return { none: "Lighter lists no spot market for this coin." };
  const spot = (books.order_books || []).find((b) => b.market_type === "spot" && b.status === "active" && Number(b.base_asset_id) === Number(asset.asset_id) && Number(b.quote_asset_id) === USDG_ASSET);
  if (!spot) return { none: `Lighter lists the token (${asset.symbol}) but has no active spot market for it against USDG.` };
  const book = await getJson(`${LIGHTER}/api/v1/orderBookOrders?market_id=${spot.market_id}&limit=250`, 8000);
  const side = (xs, dir) => (xs || []).map((o) => ({ px: Number(o.price), sz: Number(o.remaining_base_amount ?? o.initial_base_amount ?? 0) })).filter((x) => x.px > 0 && x.sz > 0).sort((a, b) => dir * (a.px - b.px));
  return { spot, asks: side(book.asks, 1), bids: side(book.bids, -1) };
}
// walk a book for a USD size: buys spend USD on the asks, sells sell coins worth the USD size into the bids
function walk(levels, usd, buy) {
  if (!levels.length) return { ok: false, why: buy ? "No sell orders on the book right now." : "No buy orders on the book right now." };
  const best = levels[0].px;
  let left = buy ? usd : usd / best, got = 0, paid = 0;
  for (const l of levels) {
    if (left <= 0) break;
    if (buy) { const cost = l.px * l.sz; if (cost <= left) { got += l.sz; paid += cost; left -= cost; } else { got += left / l.px; paid += left; left = 0; } }
    else { const take = Math.min(left, l.sz); got += take * l.px; paid += take; left -= take; }
  }
  if (left > 1e-9) return { ok: false, why: `The book is too thin for this size: it fills about $${Math.round(buy ? usd - left : (usd / best - left) * best).toLocaleString("en-US")}.` };
  const avg = buy ? paid / got : got / paid;
  return { ok: true, impact: Math.max(0, buy ? avg / best - 1 : 1 - avg / best) };
}

async function readDepth(coin) {
  const C = await context(coin);
  const { ethUsd, priceUsd, ps } = C;
  const D = coin.decimals;
  const venues = new Map();
  const v = (k) => { if (!venues.has(k)) venues.set(k, { venue: k, label: NAMES[k], buy: [], sell: [], notes: [] }); return venues.get(k); };
  const cell = (sizeUsd, o) => ({ sizeUsd, ok: !!o.ok, impactPct: o.impact != null ? +(o.impact * 100).toFixed(3) : null, feesPct: o.feesPct != null ? +Number(o.feesPct).toFixed(2) : null, why: o.why || null, route: o.route || null });
  if (!ethUsd) throw new Error("The ETH price could not be read, so dollar sizes cannot be set.");
  const noPrice = "No price for the coin, so a sell of a dollar size cannot be set.";

  // Pons curve, while the coin is on it
  const curveOpen = ps && !ps.graduated;
  if (curveOpen) {
    const pairIsEth = ps.pair === ZERO, pairIsUsd = lc(ps.pair) === lc(ADDR.usdg);
    const pairRaw = (usd) => (pairIsEth ? usdWei(usd, ethUsd) : pairIsUsd ? parseUnits(usd.toFixed(6), 6) : null);
    for (const s of SIZES) {
      const inRaw = pairRaw(s);
      if (inRaw == null) { v("pons-curve").buy.push(cell(s, { ok: false, why: `The curve trades against ${ps.pairSymbol}; only ETH and USDG curves are sized here.` })); continue; }
      const q = await quoteSwap({ tokenIn: pairIsEth ? "ETH" : ps.pair, tokenOut: coin.address, amountInRaw: inRaw.toString() }).then((x) => ({ ok: true, impact: x.priceImpact, feesPct: x.feePct }), (e) => ({ ok: false, why: why(e) }));
      v("pons-curve").buy.push(cell(s, q));
      const t = priceUsd ? tokRaw(s, priceUsd, D) : null;
      if (!t) { v("pons-curve").sell.push(cell(s, { ok: false, why: noPrice })); continue; }
      const qs = await quoteSwap({ tokenIn: coin.address, tokenOut: pairIsEth ? "ETH" : ps.pair, amountInRaw: t.toString() }).then((x) => ({ ok: true, impact: x.priceImpact, feesPct: x.feePct }), (e) => ({ ok: false, why: why(e) }));
      v("pons-curve").sell.push(cell(s, qs));
    }
    v("pons-curve").notes.push(`Real money on the curve: ${Number(formatUnits(ps.realQuote, ps.pairDecimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${ps.pairSymbol}. A bonding curve's depth is set by its formula, so it is never flagged as looking deep.`);
  }

  // Uniswap v3 and v4: buys from ETH, sells to ETH, each size its own quote
  const uniSide = async (side) => {
    for (const s of SIZES) {
      let r;
      if (side === "buy") r = await within(uniswapVenues({ tokenIn: "ETH", tokenOut: coin.address, amountInRaw: usdWei(s, ethUsd).toString() }), 20_000, "Uniswap quoters").catch((e) => ({ err: why(e) }));
      else { const t = priceUsd ? tokRaw(s, priceUsd, D) : null; r = t ? await within(uniswapVenues({ tokenIn: coin.address, tokenOut: "ETH", amountInRaw: t.toString() }), 20_000, "Uniswap quoters").catch((e) => ({ err: why(e) })) : { err: noPrice }; }
      for (const k of ["v3", "v4"]) {
        const u = r?.[k];
        v(`uniswap-${k}`)[side].push(u ? cell(s, { ok: true, impact: u.priceImpact, feesPct: u.feePct, route: u.label }) : cell(s, { ok: false, why: r?.err || r?.reason || `No Uniswap ${k} pool reaches this coin from ETH.` }));
      }
    }
  };
  // KyberSwap: impact against a $10 probe on the same pair
  const kyberSide = async (side) => {
    const { KYBER_ON, kyberRoute } = await import("./kyber.mjs");
    if (!KYBER_ON) { for (const s of SIZES) v("kyberswap")[side].push(cell(s, { ok: false, why: "KyberSwap is turned off on this server." })); return; }
    const amt = (usd) => (side === "buy" ? usdWei(usd, ethUsd) : priceUsd ? tokRaw(usd, priceUsd, D) : null);
    const ask = (usd) => { const a = amt(usd); if (!a) return Promise.reject(new Error(noPrice)); return within(kyberRoute(side === "buy" ? { tokenIn: ZERO, tokenOut: coin.address, amountIn: a } : { tokenIn: coin.address, tokenOut: ZERO, amountIn: a }), 12_000, "KyberSwap").then((k) => ({ k, a })); };
    const probe = await ask(10).catch((e) => ({ err: why(e) }));
    for (const s of SIZES) {
      if (probe.err) { v("kyberswap")[side].push(cell(s, { ok: false, why: probe.err })); continue; }
      const r = await ask(s).catch((e) => ({ err: why(e) }));
      if (r.err) { v("kyberswap")[side].push(cell(s, { ok: false, why: r.err })); continue; }
      const rate = Number(r.k.out) / Number(r.a), pRate = Number(probe.k.out) / Number(probe.a);
      v("kyberswap")[side].push(cell(s, { ok: true, impact: pRate > 0 ? Math.max(0, 1 - rate / pRate) : null, route: `via ${r.k.exchanges.join(" + ") || "?"}` }));
    }
  };
  const lighterP = within(lighterSpot(coin), 15_000, "Lighter").catch((e) => ({ err: why(e) }));
  await Promise.all([uniSide("buy"), uniSide("sell"), kyberSide("buy"), kyberSide("sell")]);
  const L = await lighterP;
  const missing = [];
  if (L.err) missing.push({ venue: "lighter-spot", label: NAMES["lighter-spot"], why: L.err });
  else if (L.none) missing.push({ venue: "lighter-spot", label: NAMES["lighter-spot"], why: L.none });
  else for (const s of SIZES) { v("lighter-spot").buy.push(cell(s, walk(L.asks, s, true))); v("lighter-spot").sell.push(cell(s, priceUsd ? walk(L.bids, s, false) : { ok: false, why: noPrice })); }
  if (!curveOpen) missing.push({ venue: "pons-curve", label: NAMES["pons-curve"], why: ps ? "Graduated: the curve is closed and the coin trades in its Uniswap v4 pool." : "Not a Pons coin: it has no bonding curve." });

  // reported liquidity per venue (DexScreener), and what each venue's own quotes behave like
  const rep = { "uniswap-v3": 0, "uniswap-v4": 0, "pons-curve": 0, other: 0 };
  const repN = { "uniswap-v3": 0, "uniswap-v4": 0, "pons-curve": 0, other: 0 };
  for (const p of C.pairs) { const k = pairVenue(p); rep[k] += Number(p.liquidity?.usd) || 0; repN[k]++; }
  const reportedTotal = Object.values(rep).reduce((s, x) => s + x, 0);
  const rows = [];
  for (const r of venues.values()) {
    const quoted = [...r.buy, ...r.sell].some((c) => c.ok);
    if (!quoted) { missing.push({ venue: r.venue, label: r.label, why: r.buy.find((c) => c.why)?.why || "No quote." }); continue; }
    r.reportedLiquidityUsd = r.venue === "kyberswap" ? (rep.other || null) : r.venue === "lighter-spot" ? null : rep[r.venue] || null;
    r.reportedPools = r.venue === "kyberswap" ? repN.other : r.venue === "lighter-spot" ? null : repN[r.venue] ?? null;
    // the equivalent pool from the $1,000 buy (the $100 one when $1,000 did not quote, then $10,000)
    const ref = [1000, 100, 10000].map((s) => r.buy.find((c) => c.sizeUsd === s && c.ok && c.impactPct != null)).find((c) => c && effOf(c.sizeUsd, c.impactPct / 100) != null);
    r.behavesLikeUsd = ref ? Math.round(effOf(ref.sizeUsd, ref.impactPct / 100)) : null;
    r.behavesFrom = ref ? ref.sizeUsd : null;
    r.within2PctUsd = r.behavesLikeUsd != null ? Math.round((r.behavesLikeUsd / 2) * 0.02 / 0.98) : null;
    const tiny = r.buy.filter((c) => c.ok && c.impactPct != null).every((c) => c.impactPct < 0.05);
    if (r.behavesLikeUsd == null && tiny && r.buy.some((c) => c.ok)) r.deeperThanSizes = true;
    r.looksDeep = r.venue !== "pons-curve" && r.venue !== "lighter-spot" && r.reportedLiquidityUsd >= RULES.looksDeepMinUsd && r.behavesLikeUsd != null && r.reportedLiquidityUsd >= RULES.looksDeepX * r.behavesLikeUsd;
    if (r.looksDeep) r.notes.push(`Looks deep, quotes shallow: DexScreener reports ${usd(r.reportedLiquidityUsd)} here, but a $${r.behavesFrom.toLocaleString("en-US")} buy moves the price ${r.buy.find((c) => c.sizeUsd === r.behavesFrom).impactPct.toFixed(2)}%, what a pool of about ${usd(r.behavesLikeUsd)} would do. Usually much of the reported number is the coin's own side, or liquidity parked away from the current price.`);
    if (r.venue !== "pons-curve" && r.venue !== "lighter-spot" && r.venue !== "kyberswap" && r.reportedLiquidityUsd > 0 && r.behavesLikeUsd >= 2 * r.reportedLiquidityUsd) r.notes.push(`Quotes deeper than reported (behaves like about ${usd(r.behavesLikeUsd)} against ${usd(r.reportedLiquidityUsd)} reported): concentrated liquidity sits close to the current price, so small and mid sizes fill well. Past that range the depth thins quickly.`);
    if (r.buy.some((c) => c.ok && c.sizeUsd === 100 && c.impactPct >= 50)) { r.dust = true; r.notes.push("Almost no depth: even a $100 trade moves the price by half or more. A pool like this is a trap, whatever its reported number."); }
    if (r.venue === "kyberswap") r.notes.push("KyberSwap is an aggregator: it may route through the same Uniswap pool, or split across the coin's pools on other Robinhood Chain venues. Its reported number is the sum of the non-Uniswap pools DexScreener lists.");
    rows.push(r);
  }
  // where the real depth is: the venue with the smallest impact at $1,000 and $10,000, per side
  const bestAt = (side, s, rs) => {
    const c = rs.map((r) => ({ r, c: r[side].find((x) => x.sizeUsd === s && x.ok && x.impactPct != null) })).filter((x) => x.c).sort((a, b) => a.c.impactPct - b.c.impactPct)[0];
    return c ? { venue: c.r.venue, label: c.r.label, sizeUsd: s, impactPct: c.c.impactPct } : null;
  };
  // pools and books first: KyberSwap often routes through the same pool, so it is named only when it is clearly better
  const pick = (side, s) => {
    const all = bestAt(side, s, rows), own = bestAt(side, s, rows.filter((r) => r.venue !== "kyberswap"));
    return own && (!all || all.venue !== "kyberswap" || all.impactPct >= own.impactPct - 0.5) ? own : all;
  };
  const best = { buy1k: pick("buy", 1000), buy10k: pick("buy", 10000), sell1k: pick("sell", 1000), sell10k: pick("sell", 10000) };
  const top = rows.filter((r) => r.behavesLikeUsd != null).sort((a, b) => b.behavesLikeUsd - a.behavesLikeUsd)[0] || null;
  const coinLooksDeep = reportedTotal >= 10_000 && top && reportedTotal >= RULES.looksDeepX * top.behavesLikeUsd;
  const headline = !rows.length ? "No venue Troya reaches gave a quote for this coin."
    : best.buy1k && best.buy1k.impactPct >= 50 ? `No venue has real depth: even the best $1,000 buy moves the price ${best.buy1k.impactPct.toFixed(1)}% (${best.buy1k.label}).`
    : best.buy1k ? `The real depth is on ${best.buy1k.label}: a $1,000 buy moves the price ${best.buy1k.impactPct.toFixed(2)}% there${best.sell1k ? `, a $1,000 sell ${best.sell1k.impactPct.toFixed(2)}% on ${best.sell1k.label}` : ""}.`
      : "No venue quoted a $1,000 buy.";
  return {
    status: "done", sizes: SIZES, venues: rows, missing, best, headline,
    reported: { totalUsd: Math.round(reportedTotal), pools: C.pairs.length, source: "DexScreener (every pool it lists for the coin on Robinhood Chain)" },
    coinLooksDeep: coinLooksDeep ? { reportedUsd: Math.round(reportedTotal), behavesLikeUsd: top.behavesLikeUsd, venue: top.label,
      text: `DexScreener reports ${usd(reportedTotal)} of liquidity across ${C.pairs.length} pool${C.pairs.length === 1 ? "" : "s"}, but the deepest route Troya can quote behaves like a pool of about ${usd(top.behavesLikeUsd)} (${top.label}).` } : null,
    priceUsd, priceSource: C.priceSource, ethUsd, readAt: Date.now(),
  };
}
function usd(n) {
  if (n == null || !isFinite(n)) return "–";
  const a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n).toLocaleString("en-US")}`;
}

/* ================= 2. honest volume ================= */
const W = () => CHAINS.robinhood.wide;
async function wideLogs(q, retries = 3) {
  for (let i = 0; ; i++) {
    try { return (await rpc("robinhood", "eth_getLogs", [q], { only: W(), timeoutMs: 30_000 })) || []; }
    catch (e) { if (i >= retries || !/429|rate|busy|timeout/i.test(e.message)) throw e; await sleep(800 * 2 ** i); }
  }
}
// logs over a range; too many for one answer (10,000) or too slow: halve, newer half first
async function rangeLogs(filter, from, to, acc, depth = 0) {
  if (acc.out.length >= MAX_TRANSFERS) { acc.partial = true; return; }
  try { const r = await wideLogs({ ...filter, fromBlock: hex(from), toBlock: hex(to) }); acc.out.push(...r); return; }
  catch (e) {
    if (depth >= 16 || to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    await rangeLogs(filter, mid + 1, to, acc, depth + 1);
    await rangeLogs(filter, from, mid, acc, depth + 1);
  }
}
async function blockTs(n) {
  const b = await rpc("robinhood", "eth_getBlockByNumber", [typeof n === "number" ? hex(n) : n, false], { timeoutMs: 12_000 });
  return { n: Number(BigInt(b.number)), t: Number(BigInt(b.timestamp)) };
}
// the block 24 hours back, found from the measured block rate and corrected twice
async function windowBlocks() {
  const head = await blockTs("latest");
  const goal = head.t - 86_400;
  const probe = await blockTs(Math.max(1, head.n - 900_000));
  let rate = (head.n - probe.n) / Math.max(1, head.t - probe.t);
  let n = Math.max(1, Math.round(head.n - 86_400 * rate)), b = await blockTs(n);
  for (let i = 0; i < 2 && Math.abs(b.t - goal) > 60; i++) { n = Math.max(1, Math.round(b.n + (goal - b.t) * rate)); b = await blockTs(n); }
  // anchors every ~2 hours for the timestamps of the trades in between
  const anchors = [b, head];
  for (let k = 1; k < 12; k++) { const m = Math.round(b.n + ((head.n - b.n) * k) / 12); anchors.push(await blockTs(m).catch(() => null)); }
  return { from: b, head, anchors: anchors.filter(Boolean).sort((x, y) => x.n - y.n) };
}
function tsOf(anchors, n) {
  let lo = anchors[0], hi = anchors[anchors.length - 1];
  for (const a of anchors) { if (a.n <= n) lo = a; if (a.n >= n) { hi = a; break; } }
  if (hi.n === lo.n) return lo.t;
  return Math.round(lo.t + ((hi.t - lo.t) * (n - lo.n)) / (hi.n - lo.n));
}
// the coin's USD price at a moment: the 5-minute close of its own chart (Troya's chart reader)
async function priceSeries(coin, fallback) {
  for (const [iv, word, min] of [["5m", "5-minute", 12], ["1h", "hourly", 6]]) {
    const c = await within((await market()).getRobinhoodCandles(coin.address, iv), 15_000, "Chart").catch(() => null);
    const pts = (c?.candles || []).filter((x) => x.close > 0).map((x) => [x.time, x.close]);
    if (pts.length >= min) return { at: (t) => { let v = pts[0][1]; for (const [tt, cl] of pts) { if (tt <= t) v = cl; else break; } return v; }, source: `the coin's ${word} chart (${c.source || "Troya"})` };
  }
  if (fallback) return { at: () => fallback, source: "today's price (no 5-minute chart was available)", flat: true };
  return null;
}

async function readVolume(coin) {
  const t0 = Date.now();
  const C = await context(coin);
  const a = lc(coin.address), dec = coin.decimals;
  const [win, series] = await Promise.all([windowBlocks(), priceSeries(coin, C.priceUsd)]);
  if (!series) throw new Error("No price for this coin, so trades cannot be valued.");
  // venues: its Pons curve, the v4 PoolManager, every pool DexScreener lists (and the board's), v4 pool ids for liquidity events
  const V = new Set([lc(ADDR.poolManager)]);
  if (C.ps?.curve) V.add(lc(C.ps.curve));
  const v4ids = new Set(C.ps?.poolId ? [lc(C.ps.poolId)] : []);
  for (const p of C.pairs) { const x = lc(p.pairAddress); if (/^0x[0-9a-f]{40}$/.test(x)) V.add(x); else if (/^0x[0-9a-f]{64}$/.test(x)) v4ids.add(x); }
  for (const p of (await market()).indexRow?.(a)?.pools || []) if (/^0x[0-9a-f]{40}$/i.test(String(p.pool || ""))) V.add(lc(p.pool));
  const from = win.from.n, to = win.head.n;
  const acc = { out: [], partial: false };
  await rangeLogs({ address: coin.address, topics: [T_TRANSFER] }, from, to, acc);
  // liquidity adds and removes, left out of trading
  const lpTx = new Set();
  const v3pools = [...V].filter((x) => x !== lc(ADDR.poolManager) && x !== lc(C.ps?.curve || ""));
  const liqAcc = [];
  let lpReadFailed = 0;
  const liqRead = (filter) => { const x = { out: [], partial: false }; liqAcc.push(rangeLogs(filter, from, to, x).then(() => x.out, () => { lpReadFailed++; return []; })); };
  if (v3pools.length) for (const tp of T_LIQ) liqRead({ address: v3pools.slice(0, 20).map(getAddress), topics: [tp] });
  for (const pid of [...v4ids].slice(0, 6)) liqRead({ address: ADDR.poolManager, topics: [T_V4LIQ, pid] });
  for (const l of (await Promise.all(liqAcc)).flat()) lpTx.add(lc(l.transactionHash));

  const supply = coin.totalSupply ? Number(BigInt(coin.totalSupply) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6 : 0;
  const amountOf = (d) => Number(BigInt(d === "0x" ? 0 : d) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6;
  const byTx = new Map();
  for (const l of acc.out) { const k = lc(l.transactionHash); const g = byTx.get(k) || []; g.push(l); byTx.set(k, g); }
  const trades = [];
  let lpSkipped = 0, seeds = 0;
  for (const [tx, g] of byTx) {
    if (lpTx.has(tx)) { lpSkipped++; continue; }
    const block = Number(BigInt(g[0].blockNumber));
    const ts = Number(g[0].blockTimestamp) > 0 ? Number(BigInt(g[0].blockTimestamp)) : tsOf(win.anchors, block);
    const moves = g.map((l) => ({ from: at(l.topics[1]), to: at(l.topics[2]), a: amountOf(l.data) }));
    const inner = (x) => V.has(x) || ROUTERS.has(x) || x === ZERO || x === DEAD || x === a;
    for (const m of moves) {
      if (supply > 0 && m.a >= 0.9 * supply) { seeds++; continue; }
      if (V.has(m.to) && !V.has(m.from)) {
        const via = moves.find((x) => x.to === m.from && !V.has(x.from) && x.from !== ZERO);
        const wallet = via && (ROUTERS.has(m.from) || !inner(via.from)) ? via.from : m.from;
        if (inner(wallet)) continue;
        trades.push({ tx, block, ts, kind: "sell", wallet, a: m.a });
      } else if (V.has(m.from) && !V.has(m.to) && m.to !== ZERO) {
        const fwd = moves.find((x) => x.from === m.to && !V.has(x.to) && x.to !== ZERO && x.to !== DEAD);
        const wallet = fwd && (ROUTERS.has(m.to) || !inner(fwd.to)) ? fwd.to : m.to;
        if (inner(wallet)) continue;
        trades.push({ tx, block, ts, kind: "buy", wallet, a: m.a });
      }
    }
  }
  for (const t of trades) t.usd = t.a * series.at(t.ts);
  trades.sort((x, y) => x.block - y.block);

  /* ---- the filters, each trade removed once ---- */
  const off = (t, rule) => { if (!t.rule) t.rule = rule; };
  const live = (xs) => xs.filter((t) => !t.rule);
  const near = (x, y) => Math.abs(x - y) <= RULES.sizeTol * Math.max(x, y);
  // A: in and out inside one transaction
  const perTx = new Map();
  for (const t of trades) { const k = `${t.tx}|${t.wallet}`; const g = perTx.get(k) || []; g.push(t); perTx.set(k, g); }
  for (const g of perTx.values()) if (g.some((t) => t.kind === "buy") && g.some((t) => t.kind === "sell")) for (const t of g) off(t, "A");
  const byWallet = new Map();
  for (const t of trades) { const g = byWallet.get(t.wallet) || []; g.push(t); byWallet.set(t.wallet, g); }
  // B: a buy and a sell of about the same size within 10 minutes (same wallet, or B across a group for D)
  const roundTrips = (xs, rule, cross = false) => {
    const ys = live(xs).sort((p, q) => p.ts - q.ts);
    for (let i = 0; i < ys.length; i++) {
      const p = ys[i];
      if (p.rule) continue;
      for (let j = i + 1; j < ys.length && ys[j].ts - p.ts <= RULES.windowS; j++) {
        const q = ys[j];
        if (q.rule || q.kind === p.kind || (cross && q.wallet === p.wallet) || !near(p.a, q.a)) continue;
        off(p, rule); off(q, rule); break;
      }
    }
  };
  for (const g of byWallet.values()) roundTrips(g, "B");
  // C: a wallet that traded often and ended flat
  const flat = (xs) => {
    if (xs.length < RULES.flatMinTrades) return false;
    const b = xs.filter((t) => t.kind === "buy").reduce((s, t) => s + t.a, 0), s = xs.filter((t) => t.kind === "sell").reduce((s2, t) => s2 + t.a, 0);
    return b > 0 && s > 0 && Math.min(b, s) / Math.max(b, s) >= 1 - RULES.flatTol;
  };
  for (const g of byWallet.values()) if (flat(g)) for (const t of g) off(t, "C");
  // D: linked wallets (same first funder), among the wallets with the most volume still counted
  const vol = (xs) => xs.reduce((s, t) => s + (t.usd || 0), 0);
  const candidates = [...byWallet.entries()].map(([w, g]) => [w, vol(live(g))]).filter(([, u]) => u > 0).sort((x, y) => y[1] - x[1]).slice(0, RULES.funderWallets).map(([w]) => w);
  const funders = new Map();
  let fundersRead = 0, fundersTried = 0;
  const fStart = Date.now();
  for (let i = 0; i < candidates.length && Date.now() - fStart < FUNDER_BUDGET_MS && Date.now() - t0 < VOLUME_BUDGET_MS - 10_000; i += 5) {
    await Promise.all(candidates.slice(i, i + 5).map(async (w) => {
      fundersTried++;
      const f = await within(deps.fundingOf(w, win.head.n), 20_000, "Funding read").catch(() => null);
      if (f) { fundersRead++; if (f.funder && isAddress(f.funder)) funders.set(w, lc(f.funder)); }
    }));
  }
  const groups = new Map();
  for (const [w, f] of funders) { if (ROUTERS.has(f) || V.has(f)) continue; const g = groups.get(f) || []; g.push(w); groups.set(f, g); }
  // more than 10 of the busiest wallets from one funder is a common source (an exchange's hot wallet, a faucet), not a ring
  const linked = [...groups.entries()].filter(([, ws]) => ws.length >= 2 && ws.length <= 10);
  const commonSources = [...groups.entries()].filter(([, ws]) => ws.length > 10).map(([f, ws]) => ({ funder: f, wallets: ws.length }));
  for (const [, ws] of linked) {
    const xs = ws.flatMap((w) => byWallet.get(w) || []);
    roundTrips(xs, "D", true);
    if (flat(live(xs))) for (const t of live(xs)) off(t, "D");
  }
  // E: the exact same amount, five times or more, by one wallet or one group
  const sig = (x) => Number(x.toPrecision(5));
  const units = [...byWallet.keys()].filter((w) => !linked.some(([, ws]) => ws.includes(w))).map((w) => [w]).concat(linked.map(([, ws]) => ws));
  for (const ws of units) {
    const xs = live(ws.flatMap((w) => byWallet.get(w) || []));
    const n = new Map();
    for (const t of xs) n.set(sig(t.a), (n.get(sig(t.a)) || 0) + 1);
    for (const t of xs) if (n.get(sig(t.a)) >= RULES.repeatMin) off(t, "E");
  }

  /* ---- the numbers ---- */
  const LABEL = { A: "Bought and sold in one transaction", B: "Round trip within 10 minutes", C: "Wallet ended flat", D: "Linked wallets trading with each other", E: "Scripted repeats" };
  const rawUsd = vol(trades), honest = live(trades), honestUsd = vol(honest);
  const byRule = ["A", "B", "C", "D", "E"].map((r) => { const xs = trades.filter((t) => t.rule === r); return { rule: r, label: LABEL[r], usd: Math.round(vol(xs)), trades: xs.length, wallets: new Set(xs.map((t) => t.wallet)).size }; });
  const wash = new Map();
  for (const t of trades.filter((x) => x.rule)) { const k = t.wallet; const w = wash.get(k) || { wallet: k, usd: 0, trades: 0, rules: new Set(), tx: t.tx }; w.usd += t.usd; w.trades++; w.rules.add(t.rule); wash.set(k, w); }
  const examples = [...wash.values()].sort((x, y) => y.usd - x.usd).slice(0, 8).map((w) => ({ wallet: w.wallet, usd: Math.round(w.usd), trades: w.trades, rules: [...w.rules], funder: funders.get(w.wallet) || null,
    walletUrl: `${EXPLORER}/address/${w.wallet}`, txUrl: `${EXPLORER}/tx/${w.tx}` }));
  const dsVol = C.pairs.reduce((s, p) => s + (Number(p.volume?.h24) || 0), 0);
  let tribute = [];
  try { tribute = (await import("./tribute.mjs")).tributeFlags(coin.address) || []; } catch {}
  const removedPct = rawUsd > 0 ? +((1 - honestUsd / rawUsd) * 100).toFixed(1) : null;
  const notes = [];
  if (coin.stock) notes.push("It is a tokenized stock: it trades in many pools that bots keep in line with each other and with the share price. Most of what the filters take out here is that arbitrage and market making, not fake trading, and none of it is demand.");
  if (acc.partial) notes.push(`More than ${MAX_TRANSFERS.toLocaleString("en-US")} transfers in 24 hours: only the newest were read, so the numbers cover part of the day.`);
  if (series.flat) notes.push("No chart was available, so every trade is valued at today's price.");
  const headline = !trades.length ? "No buys or sells of this coin were found on chain in the last 24 hours."
    : `Of ${usd(rawUsd)} traded on chain in 24 hours, ${usd(honestUsd)} is left after the wash filters (${removedPct}% taken out as round trips, self-trades and wash patterns)${dsVol > 0 ? `; DexScreener reports ${usd(dsVol)}` : ""}.`;
  return {
    status: acc.partial ? "partial" : "done", headline,
    raw: { usd: Math.round(rawUsd), trades: trades.length, wallets: byWallet.size },
    honest: { usd: Math.round(honestUsd), trades: honest.length, wallets: new Set(honest.map((t) => t.wallet)).size },
    removedPct, byRule, examples, notes, linkedGroups: linked.map(([f, ws]) => ({ funder: f, wallets: ws.length, funderUrl: `${EXPLORER}/address/${f}` })).slice(0, 8), commonSources,
    dexscreener: { volume24hUsd: dsVol > 0 ? Math.round(dsVol) : null, pools: C.pairs.length, honestOfReportedPct: dsVol > 0 ? +((honestUsd / dsVol) * 100).toFixed(1) : null },
    tributeFlags: tribute,
    coverage: { fromBlock: from, toBlock: to, fromTs: win.from.t, toTs: win.head.t, transfers: acc.out.length, transactions: byTx.size, liquidityTxsLeftOut: lpSkipped, liquidityReadsFailed: lpReadFailed, seedsLeftOut: seeds,
      venues: V.size, partial: acc.partial, fundersChecked: fundersRead, fundersTried, wallets: byWallet.size, pricing: series.source, tookMs: Date.now() - t0 },
    readAt: Date.now(),
  };
}

/* ================= 3. family tree ================= */
const host = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
const xHandle = (u) => { const m = /(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})/i.exec(String(u || "")); return m ? m[1].replace(/^@/, "").toLowerCase() : null; };
const COMMON_HOSTS = /^(t\.me|x\.com|twitter\.com|linktr\.ee|pump\.fun|ponsfamily\.com|dexscreener\.com|github\.com|medium\.com|youtube\.com|discord\.gg|discord\.com|instagram\.com|tiktok\.com|bit\.ly)$/;
function linksOf(pairs) {
  const sites = new Set(), xs = new Set();
  for (const p of pairs) {
    for (const w of p.info?.websites || []) { const hh = host(w.url); if (hh && !COMMON_HOSTS.test(hh)) sites.add(hh); }
    for (const s of p.info?.socials || []) { if (s.type === "twitter") { const x = xHandle(s.url); if (x) xs.add(x); } }
  }
  return { sites, xs };
}
async function ethCall(to, data) { return rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 10_000 }).catch(() => null); }
async function readFamily(coin) {
  const C = await context(coin);
  const a = lc(coin.address);
  const sym = String(coin.symbol || "").trim(), name = String(coin.name || "").trim();
  if (!sym) throw new Error("The coin has no ticker to search for.");
  const qs = [sym]; if (name && lc(name) !== lc(sym) && name.length >= 3) qs.push(name);
  const found = [];
  for (const q of qs) {
    const d = await cached(`dss:${lc(q)}`, 10 * 60_000, () => getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, 9000)).catch(() => null);
    found.push(...(d?.pairs || []));
  }
  const same = (p) => lc(String(p.baseToken?.symbol || "").replace(/^\$/, "")) === lc(sym.replace(/^\$/, "")) || (name && lc(p.baseToken?.name) === lc(name));
  const members = new Map();
  for (const p of found) {
    if (!same(p) || !p.baseToken?.address) continue;
    const key = `${p.chainId}|${lc(p.baseToken.address)}`;
    if (p.chainId === "robinhood" && lc(p.baseToken.address) === a) continue;
    const m = members.get(key) || { chain: p.chainId, chainName: chainName(p.chainId), address: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name, liquidityUsd: 0, volume24hUsd: 0, pools: 0, priceUsd: null, _liq: -1, createdAt: null, url: null, pairs: [] };
    const liq = Number(p.liquidity?.usd) || 0;
    m.liquidityUsd += liq; m.volume24hUsd += Number(p.volume?.h24) || 0; m.pools++;
    if (liq > m._liq && Number(p.priceUsd) > 0) { m._liq = liq; m.priceUsd = Number(p.priceUsd); m.url = p.url || null; m.fdvUsd = Number(p.fdv) || null; }
    if (p.pairCreatedAt && (!m.createdAt || p.pairCreatedAt < m.createdAt)) m.createdAt = p.pairCreatedAt;
    m.pairs.push(p);
    members.set(key, m);
  }
  const list = [...members.values()].sort((x, y) => y.liquidityUsd - x.liquidityUsd).slice(0, 30);
  // the coin's own links
  const mine = linksOf(C.pairs);
  try { const s = (await market()).socialsOf?.(a); if (s?.website) { const hh = host(s.website); if (hh && !COMMON_HOSTS.test(hh)) mine.sites.add(hh); } if (s?.x) { const x = xHandle(s.x); if (x) mine.xs.add(x); } } catch {}
  // bridge links read from the contract itself: a LayerZero OFT (endpoint + peers) or a canonical bridge token (l1Address)
  const checks = [];
  const peers = new Map();
  const ep = await ethCall(coin.address, "0x5e280f11");            // endpoint()
  const isOft = !!(ep && ep.length >= 66 && !/^0x0*$/.test(ep));
  if (isOft) {
    await Promise.all(Object.entries(LZ).map(async ([chain, eid]) => {
      const r = await ethCall(coin.address, "0xbb0b6a53" + eid.toString(16).padStart(64, "0"));   // peers(uint32)
      if (r && r.length >= 66 && !/^0x0*$/.test(r)) peers.set(chain, lc(r));
    }));
    checks.push(`It is a LayerZero OFT (it has an endpoint); peers are set for ${peers.size ? [...peers.keys()].map(chainName).join(", ") : "no chain Troya checks"}.`);
  } else checks.push("It is not a LayerZero OFT (no endpoint), so no LayerZero peer can link it to another chain.");
  const l1 = await ethCall(coin.address, "0xc2eeeebd");             // l1Address(): Arbitrum-style canonical bridge tokens
  const parent = l1 && l1.length >= 66 && !/^0x0*$/.test(l1) ? at(l1.slice(0, 66)) : null;
  checks.push(parent ? `It is a canonical bridge token: its parent-chain token is ${parent}.` : "It is not a canonical bridge token (no l1Address).");
  // the coin's deployer: its Pons launch, or Blockscout's creator
  let deployer = C.ps?.deployer ? lc(C.ps.deployer) : null;
  if (!deployer) { try { const M = await market(); if (M.hasBlockscout()) deployer = lc((await within(M.blockscoutApi(`/addresses/${coin.address}`), 8000, "Blockscout"))?.creator_address_hash) || null; } catch {} }
  checks.push(deployer ? `Its deployer is ${deployer}.` : "Its deployer could not be read.");
  // deployers on other chains: the six deepest EVM members on a chain with a free public Blockscout
  const evm = list.filter((m) => BLOCKSCOUT[m.chain] && /^0x[0-9a-fA-F]{40}$/.test(m.address)).slice(0, 6);
  await Promise.all(evm.map(async (m) => {
    const d = await cached(`bsc:${m.chain}:${lc(m.address)}`, 24 * 3600_000, () => getJson(`${BLOCKSCOUT[m.chain]}/api/v2/addresses/${m.address}`, 7000)).catch(() => null);
    m.deployer = lc(d?.creator_address_hash) || null; m.deployerRead = !!d;
  }));
  // copies on Robinhood Chain itself: the five deepest, through Troya's own Blockscout client (shared credits)
  try {
    const M = await market();
    if (M.hasBlockscout()) for (const m of list.filter((x) => x.chain === "robinhood").slice(0, 5)) {
      const d = await cached(`bsc:robinhood:${lc(m.address)}`, 24 * 3600_000, () => within(M.blockscoutApi(`/addresses/${m.address}`), 8000, "Blockscout")).catch(() => null);
      m.deployer = lc(d?.creator_address_hash) || null; m.deployerRead = !!d;
    }
  } catch {}
  for (const m of list) {
    const why = [], unsure = [];
    let kind = "lookalike";
    const evmAddr = /^0x[0-9a-fA-F]{40}$/.test(m.address);
    const peer = peers.get(m.chain);
    if (peer && evmAddr && peer.endsWith(lc(m.address).slice(2))) { kind = "linked"; why.push("a LayerZero OFT peer of this contract (the official bridge link)"); }
    else if (peer && m.chain === "solana") unsure.push("a LayerZero peer is set for Solana, but Solana peers name a program account, not the mint, so Troya cannot match it");
    if (parent && lc(m.address) === parent) { kind = "linked"; why.push("the parent-chain token of this coin's canonical bridge"); }
    if (kind !== "linked") {
      if (evmAddr && lc(m.address) === a) { kind = "plausible"; why.push("the same contract address (usually the same deployer, or a deployment made to match)"); }
      if (deployer && m.deployer && m.deployer === deployer) { kind = "plausible"; why.push("deployed by the same wallet"); }
      const theirs = linksOf(m.pairs);
      const site = [...theirs.sites].find((x) => mine.sites.has(x)), xh = [...theirs.xs].find((x) => mine.xs.has(x));
      if (site) { kind = "plausible"; why.push(`lists the same website (${site}); links can be copied, so this is a hint, not proof`); }
      if (xh) { kind = "plausible"; why.push(`lists the same X account (@${xh}); links can be copied, so this is a hint, not proof`); }
    }
    if (kind === "lookalike") {
      if (!BLOCKSCOUT[m.chain] && !(m.chain === "robinhood" && m.deployerRead)) unsure.push(`its deployer is not checked on ${m.chainName}`);
      else if (!m.deployerRead) unsure.push("its deployer could not be read");
      else if (!deployer) unsure.push("this coin's own deployer could not be read");
    }
    if (m.chain === "robinhood") { kind = kind === "lookalike" ? "copy" : kind; }
    m.kind = kind; m.why = why; m.unsure = unsure;
    m.priceGapPct = m.priceUsd && C.priceUsd ? +((m.priceUsd / C.priceUsd - 1) * 100).toFixed(1) : null;
    delete m.pairs; delete m._liq;
  }
  const n = (k) => list.filter((m) => m.kind === k).length;
  const headline = !list.length ? `DexScreener lists no other token called $${sym} on any chain.`
    : `${list.length} other token${list.length === 1 ? "" : "s"} share the ticker $${sym} or the name: ${n("linked")} with an official bridge link, ${n("plausible")} plausibly official, ${n("lookalike")} lookalike${n("copy") ? `, ${n("copy")} on Robinhood Chain itself` : ""}.`;
  if (coin.stock) checks.push(`It is a tokenized stock: tokens of the same share from other issuers are separate assets with their own backing, not copies of this one. Proteus compares them side by side.`);
  return { status: "done", headline, members: list, checks, proteus: coin.stock ? `#/proteus/${encodeURIComponent(sym)}` : null, isOft, parent, deployer, counts: { linked: n("linked"), plausible: n("plausible"), lookalike: n("lookalike"), copy: n("copy") }, readAt: Date.now(),
    source: "DexScreener search (ticker and name), the coin's contract on Robinhood Chain (endpoint, peers, l1Address), public Blockscout explorers for deployers" };
}

/* ================= the answer ================= */
const PART = { depth: readDepth, volume: readVolume, family: readFamily };
function part(kind, coin) {
  return cached(`${kind}:${lc(coin.address)}`, TTL[kind], () => within(PART[kind](coin), kind === "volume" ? VOLUME_BUDGET_MS : 60_000, kind));
}
export async function sirens(q, { waitMs = WAIT_MS } = {}) {
  const coin = await resolveCoin(q);
  const ps = { depth: part("depth", coin), volume: part("volume", coin), family: part("family", coin) };
  const out = { coin, partial: false };
  const deadline = new Promise((r) => setTimeout(r, waitMs).unref?.());
  await Promise.all(Object.entries(ps).map(async ([k, p]) => {
    const r = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), deadline.then(() => null)]);
    if (!r) { out[k] = { status: "reading" }; out.partial = true; }
    else if (r.e) out[k] = { status: "failed", error: why(r.e) };
    else out[k] = r.v;
  }));
  out.method = METHOD;
  out.checkedAt = Date.now();
  return out;
}
export const METHOD = {
  depth: "Each venue Troya reaches on Robinhood Chain is asked for a read-only quote of a $100, $1,000 and $10,000 buy (from ETH) and sell (to ETH): the Pons curve while a coin is on it, the best Uniswap v3 and v4 paths, KyberSwap's route through the other pools, and Lighter's order book. Impact = how much worse the size's average price is than a tiny trade on the same route, so fees are not in it. From the $1,000 buy, an equivalent full-range pool is worked out (impact m at size x means about x(1-m)/m on its money side): when DexScreener reports at least 4 times that, the venue is flagged \"looks deep, quotes shallow\".",
  volume: "Every Transfer of the coin over the last 24 hours is read from the chain. A move from a venue (its Pons curve, the Uniswap v4 PoolManager, any pool DexScreener lists) to a wallet is a buy, the reverse a sell; routers in the middle are looked through, and liquidity adds and removes are left out. Each trade is valued at the 5-minute close of the coin's chart. Then, each trade removed once, in order: A) a wallet buying and selling in one transaction; B) a wallet's buy and sell within 10 minutes with sizes within 10%; C) a wallet with 6 or more trades whose buys and sells end within 5% of each other; D) wallets first funded by the same wallet (checked for the 25 wallets with the most volume) trading back and forth among themselves, or ending flat as a group; E) the same wallet or group trading the exact same amount 5 or more times. What is left is the honest volume.",
  family: "Tokens with the same ticker or name on any chain, from DexScreener search. An official link is a LayerZero OFT peer of this contract or the parent token of its canonical bridge. Plausibly official: the same address, the same deployer (read where a free public Blockscout exists: Ethereum, Base, Arbitrum, Optimism, Polygon, Gnosis) or the same website or X account. Everything else is a lookalike: a different contract with no link Troya can find. Unchecked parts are named.",
  limits: "A reading of the chain and of public data, not a verdict on anyone. Arbitrage bots that keep prices in line between pools are caught by rules A to C too: that volume is not demand, but it is not always fake. Wash traders that use many unrelated wallets, or are funded through a bridge or an exchange, can slip through rule D. Venues outside Robinhood Chain are not sized for depth. What wallets did, never who people are.",
};

export async function register(r) {
  r.get("/api/sirens", () => ({ name: "Troya Sirens", phase: "V10 F63", how: "GET /api/sirens/:token with an address, ticker or name", method: METHOD, sizes: SIZES, rules: RULES }), { weight: 1 });
  r.get("/api/sirens/:token", ({ params }) => sirens(params.token), { weight: 3, perMin: 20 });
}
