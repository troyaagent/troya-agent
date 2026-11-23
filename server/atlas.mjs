// V9 F49 Swift ("Troya Atlas" inside): one buy box. A coin (address, ticker or name) and an amount of ETH in; every venue
// Troya already reaches is asked for a read-only quote at the same moment, and the answer ranks them by what you actually
// receive after fees and gas, with the Troya Gate verdict for the coin.
//
//   GET /api/atlas/quote?token=<address|ticker|name>&amountEth=0.01[&from=<wallet>]
//   → { token, amountIn, amountInWei, ethUsd, priceUsd, routes:[{ venue, label, chain, chainId, out, outRaw, outUsd, netOut,
//       priceImpactPct, feesPct, gasEth, gasUsd, gasNote, etaSec, ok, why, executable, handoff }], best, bestOverall,
//       gate:{ verdict, label, passed, total, why, pass, checks, quote }, alsoAvailable:[…], fundFrom:[…]|null, quotedAt, tookMs }
//
// Venues, each through the function the rest of Troya already uses (nothing is re-implemented here):
//   Pons curve ........ robinhood.mjs gateCheck → sharedQuote → quoteSwap (the curve maths), the same quote Swap signs
//   Uniswap v3 / v4 ... robinhood.mjs uniswapVenues (routerQuote on the official quoters), best path of each version
//   KyberSwap ......... kyber.mjs kyberRoute (Robinhood Chain aggregator: Long.xyz, Bankr, Frontier, Virtuals, Ramses …)
//   Base, Arbitrum .... robinhood.mjs crossBuyQuote (LI.FI, one transaction on the source chain, the coin's Gate first)
//   Lighter spot ...... Lighter's public order book (api.rh.lighter.xyz), matched to the coin by its Robinhood Chain address
//   Hyperliquid ....... market.mjs getHlSpot / getHlMarkets: spot is a buy route only for the same token (never by ticker);
//                       a perp on the coin's price is listed under alsoAvailable, never as a buy route
//
// Rules: a venue that fails or does not answer in time is listed with its reason, never filled in. "executable" marks the
// routes Troya's own Swap flow can sign today: the route Swap itself picks on Robinhood Chain (quoteSwap's winner) and
// the cross-chain buys. Other venues are shown for comparison; `best` is the top executable route, `bestOverall` the top
// route of all when that is a different one. Gas is an estimate (typical gas units × the chain's gas price, or the
// aggregator's own gas figure) and says so. Nothing here builds or sends a transaction.
import { isAddress, getAddress, parseUnits, formatUnits } from "ethers";
import { HttpError } from "./api.mjs";
import { gateCheck, uniswapVenues, crossBuyQuote, tokenMeta, ponsState, rpc, CHAIN_ID, ADDR } from "./robinhood.mjs";
import { KYBER_ON, KYBER_LIVE, kyberRoute } from "./kyber.mjs";
import { verdictOf, tallyOf } from "../public/agent/js/verdict.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const PREVIEW_FROM = "0x000000000000000000000000000000000000dEaD"; // the Swap page's stand-in sender for cross-chain previews
const CACHE_MS = 15_000, CACHE_MAX = 200;
const MAX_ETH = 10;
const CROSS_MAX_ETH = 2;                       // crossBuyQuote's own limit
const T = { gate: 35_000, uni: 15_000, kyber: 9_000, cross: 30_000, lighter: 8_000, hl: 8_000, bal: 8_000, misc: 5_000 };
const RH_GAS_UNITS = { "pons-curve": 170_000, "uniswap-v3": 160_000, "uniswap-v4": 190_000, kyberswap: 320_000 };
const ETA_RH = 3;                              // seconds: a Robinhood Chain transaction lands within a few seconds
const XC = [{ key: "base", id: 8453, name: "Base" }, { key: "arbitrum", id: 42161, name: "Arbitrum" }];
const RESERVE = { robinhood: 10n ** 14n, base: 3n * 10n ** 14n, arbitrum: 3n * 10n ** 14n }; // left for gas (Swap's own numbers)
const LIGHTER = "https://api.rh.lighter.xyz";
const USDG_ASSET = 3;
const NAMES = { "pons-curve": "Pons curve", "uniswap-v3": "Uniswap v3", "uniswap-v4": "Uniswap v4", kyberswap: "KyberSwap", "lifi-base": "From Base", "lifi-arbitrum": "From Arbitrum", "lighter-spot": "Lighter spot", "hyperliquid-spot": "Hyperliquid spot" };

const lc = (a) => String(a || "").toLowerCase();
const num = (raw, dec) => Number(formatUnits(raw, dec));
let marketMod = null;
const market = async () => (marketMod ||= await import("./market.mjs"));

/** p, or a rejection that says how long the venue was given */
function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const why = (e) => String(e?.message || e || "failed").replace(/\s+/g, " ").slice(0, 280);

/* ---------- small cached reads ---------- */
const memo = new Map();
async function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  memo.set(key, { at: Date.now(), p });
  p.catch(() => { if (memo.get(key)?.p === p) memo.delete(key); });
  return p;
}
const gasPrice = (chain) => cached(`gp:${chain}`, 30_000, async () => BigInt(await rpc(chain, "eth_gasPrice", [])));
async function lighterGet(path) {
  const r = await fetch(LIGHTER + path, { headers: { accept: "application/json", "user-agent": "troya-agent/0.2" }, signal: AbortSignal.timeout(T.lighter) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429 || j.code === 23000) throw new Error("Lighter is limiting requests right now");
  if (!r.ok || (j.code && j.code !== 200)) throw new Error(`Lighter answered ${r.status}`);
  return j;
}
const lighterMarkets = () => cached("lt:markets", 60_000, async () => {
  const [books, assets] = await Promise.all([lighterGet("/api/v1/orderBooks"), lighterGet("/api/v1/assetDetails")]);
  return { books: books.order_books || [], assets: assets.asset_details || [] };
});

/* ---------- the coin ---------- */
async function resolveToken(q) {
  const raw = String(q || "").trim().replace(/^\$/, "");
  if (!raw) throw new HttpError(400, "Type or paste a coin: its address, ticker or name.");
  if (raw.length > 64) throw new HttpError(400, "That is too long for a coin name or address.");
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
  if (!address) {
    const r = await within((await market()).searchCoins(raw, 8), T.misc, "Coin search").catch(() => null);
    const c = (r?.coins || []).find((x) => x.kind !== "major" && /^0x[0-9a-f]{40}$/i.test(x.address || ""));
    if (!c) throw new HttpError(404, `No Robinhood Chain coin matches "${raw}". Paste its contract address instead.`);
    address = c.address;
  }
  if (!isAddress(address)) throw new HttpError(400, "That is not a valid address.");
  address = getAddress(lc(address));
  if ([lc(ADDR.weth), ZERO].includes(lc(address))) throw new HttpError(400, "Swift buys a coin with ETH: pick a coin other than ETH or WETH.");
  const m = await tokenMeta(address).catch(() => null);
  if (!m) throw new HttpError(404, "That address is not a token on Robinhood Chain.");
  return { address: getAddress(m.address), symbol: m.symbol, name: m.name, decimals: m.decimals };
}
function parseEth(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{0,6}(\.\d{1,18})?$/.test(s) || s === "" || s === ".") throw new HttpError(400, "Enter an ETH amount, for example 0.01.");
  const wei = parseUnits(s.startsWith(".") ? `0${s}` : s, 18);
  if (wei <= 0n) throw new HttpError(400, "Enter a positive amount.");
  if (wei > parseUnits(String(MAX_ETH), 18)) throw new HttpError(400, `Swift quotes up to ${MAX_ETH} ETH at a time.`);
  return { wei, text: formatUnits(wei, 18) };
}

/* ---------- one route row ---------- */
function row(o) {
  return {
    venue: o.venue, label: o.label || NAMES[o.venue] || o.venue, chain: o.chain || "robinhood", chainId: o.chainId || CHAIN_ID,
    out: o.out ?? null, outRaw: o.outRaw ?? null, outUsd: null, netOut: null,
    priceImpactPct: o.impact != null ? +(o.impact * 100).toFixed(3) : null, feesPct: o.feesPct != null ? +Number(o.feesPct).toFixed(3) : null,
    gasEth: o.gasEth ?? null, gasUsd: null, gasNote: o.gasNote || null, etaSec: o.etaSec ?? null,
    ok: !!o.ok, why: o.why || null, executable: !!o.executable, handoff: o.handoff || null, via: o.via || null, note: o.note || null,
  };
}
const failRow = (venue, reason, extra = {}) => row({ venue, ok: false, why: reason, ...extra });

/* ---------- the quote ---------- */
export async function atlasQuote({ token, amountEth, from }) {
  const t0 = Date.now();
  const coin = await resolveToken(token);
  const amt = parseEth(amountEth);
  const who = from && isAddress(String(from)) ? getAddress(lc(from)) : null;
  const swapHref = (extra = "") => `#/swap?in=ETH&out=${coin.address}&amount=${amt.text}${extra}`;
  const D = coin.decimals;

  // every venue at once; each one settles on its own and none can hold the answer past its timeout
  const times = {};
  const timed = (name, p) => { const t = Date.now(); return settle(p).then((r) => { times[name] = Date.now() - t; return r; }); };
  const ethUsdP = timed("ethUsd", within((async () => (await market()).getEthUsd())(), T.misc, "ETH price"));
  const gateP = timed("gate", within(gateCheck({ tokenIn: "ETH", tokenOut: coin.address, amountIn: amt.text, from: who || undefined }), T.gate, "Troya Gate"));
  const psP = timed("pons", within(ponsState(coin.address), T.misc, "Pons"));
  const uniP = timed("uniswap", within(uniswapVenues({ tokenIn: "ETH", tokenOut: coin.address, amountInRaw: amt.wei.toString() }), T.uni, "Uniswap quoters"));
  const kyberP = KYBER_ON ? timed("kyberswap", within(kyberRoute({ tokenIn: ZERO, tokenOut: coin.address, amountIn: amt.wei }), T.kyber, "KyberSwap")) : null;
  // the cross-chain buys start once this chain's Gate has answered: each runs the same Gate again inside crossBuyQuote,
  // and three Gates at once on the rate-limited Robinhood Chain RPC made all three slow (a cold start timed out). After
  // the first one their reads are warm. A coin the Gate blocks is not quoted from another chain (it would be refused).
  const crossP = gateP.then((g) => Promise.all(XC.map((s) => {
    if (amt.wei > parseUnits(String(CROSS_MAX_ETH), 18)) return null;
    if (g.ok && !g.v.pass) return { ok: false, e: new Error("The Troya Gate blocks this coin on Robinhood Chain, so no cross-chain route is offered.") };
    return timed(s.key, within(crossBuyQuote({ fromChain: s.id, toChain: CHAIN_ID, toToken: coin.address, address: who || PREVIEW_FROM, amountWei: amt.wei.toString() }), T.cross, `LI.FI from ${s.name}`));
  })));
  const lighterP = timed("lighter", within(lighterMarkets(), T.lighter, "Lighter"));
  const hlSpotP = timed("hlSpot", within((async () => (await market()).getHlSpot())(), T.hl, "Hyperliquid spot"));
  const hlPerpP = timed("hlPerps", within((async () => (await market()).getHlMarkets())(), T.hl, "Hyperliquid perps"));
  const gpP = timed("gasPrice", within(gasPrice("robinhood"), T.misc, "Robinhood Chain gas price"));
  const balP = who ? timed("balances", within(balances(who), T.bal, "Wallet balances")) : null;
  const rowP = settle((async () => { try { return (await market()).indexRow(coin.address); } catch { return null; } })());

  const [ethUsdR, gateR, psR, uniR, kyberR, gpR, rowR] = await Promise.all([ethUsdP, gateP, psP, uniP, kyberP, gpP, rowP]);
  const ethUsd = ethUsdR.ok && Number(ethUsdR.v) > 0 ? Number(ethUsdR.v) : null;
  const gp = gpR.ok ? gpR.v : null;
  const rhGas = (venue) => (gp != null && RH_GAS_UNITS[venue] ? num(gp * BigInt(RH_GAS_UNITS[venue]), 18) : null);
  const gasNoteFor = (venue) => (gp != null ? `Estimate: about ${(RH_GAS_UNITS[venue] / 1000).toFixed(0)}k gas units at ${Number(formatUnits(gp, 9)).toPrecision(3)} gwei` : "Gas price could not be read, so gas is not counted");

  /* ---- the Gate: one verdict, the same words Swap and the Gate page use ---- */
  let gate, swapVenue = null, gq = null;
  if (gateR.ok) {
    const g = gateR.v;
    gq = g.quote || null;
    swapVenue = g.pass || (g.checks || []).some((c) => c.key === "route" && c.status === "pass") ? gq?.venue || null : null;
    const v = verdictOf({ pass: g.pass, checks: g.checks, quote: gq ? { venue: gq.venue, poolLiquidity: gq.poolLiquidity } : null });
    const tl = tallyOf(g.checks);
    gate = { verdict: v.word, label: v.label, passed: tl.passed, total: tl.total, tally: tl.text, why: v.why ? `${v.why.label}: ${v.why.detail}` : null, answer: v.answer, note: v.note, canBuy: v.canBuy,
      pass: !!g.pass, checks: (g.checks || []).map((c) => ({ key: c.key, status: c.status, label: c.label, detail: c.detail })), quote: gq ? { venue: gq.venue, poolLiquidity: gq.poolLiquidity || null } : null, checkedAt: g.checkedAt || Date.now() };
  } else {
    gate = { verdict: "blocked", label: "Blocked", passed: 0, total: 0, tally: "", why: `Troya Gate: ${why(gateR.e)}`, answer: "No: the checks could not run just now", note: "Troya will not offer a buy until the Gate can run.", canBuy: false, pass: false, checks: [], quote: null, error: why(gateR.e) };
  }
  const gateOpen = gate.canBuy && gate.pass;

  const routes = [];
  /* ---- Pons curve ---- */
  const ps = psR.ok ? psR.v : null;
  if (!psR.ok) routes.push(failRow("pons-curve", `Could not read Pons: ${why(psR.e)}`));
  else if (!ps) routes.push(failRow("pons-curve", "Not a Pons coin: it has no Pons bonding curve."));
  else if (ps.graduated) routes.push(failRow("pons-curve", "Graduated: the curve is closed and the coin trades in its Uniswap v4 pool (Pons hook)."));
  else if (gq?.venue === "pons-curve") {
    routes.push(row({ venue: "pons-curve", label: gq.route?.label || "Pons curve", ok: true, out: gq.amountOut, outRaw: gq.amountOutRaw, impact: gq.priceImpact, feesPct: gq.feePct,
      gasEth: rhGas("pons-curve"), gasNote: gasNoteFor("pons-curve"), etaSec: ETA_RH, executable: swapVenue === "pons-curve", handoff: { kind: "swap", href: swapHref() },
      note: gq.warnings?.length ? gq.warnings.join(" ") : null }));
  } else {
    const gateRoute = gate.checks.find((c) => c.key === "route");
    routes.push(failRow("pons-curve", gateRoute?.status === "fail" ? gateRoute.detail : gateR.ok ? "The curve gave no quote for this buy." : `No curve quote: ${gate.error}`));
  }

  /* ---- Uniswap v3 and v4 ---- */
  if (!uniR.ok) { routes.push(failRow("uniswap-v4", why(uniR.e))); routes.push(failRow("uniswap-v3", why(uniR.e))); }
  else for (const v of ["v4", "v3"]) {
    const u = uniR.v[v], venue = `uniswap-${v}`;
    if (!u) { routes.push(failRow(venue, uniR.v.reason || `No Uniswap ${v} pool reaches this coin from ETH.`)); continue; }
    routes.push(row({ venue, label: u.label, ok: true, out: u.amountOut, outRaw: u.out.toString(), impact: u.priceImpact, feesPct: u.feePct, gasEth: rhGas(venue), gasNote: gasNoteFor(venue), etaSec: ETA_RH,
      executable: swapVenue === venue, handoff: { kind: "swap", href: swapHref() }, via: u.hops?.map((x) => `${x.from}→${x.to}`).join(", ") || null }));
  }

  /* ---- KyberSwap ---- */
  if (!KYBER_ON) routes.push(failRow("kyberswap", "KyberSwap is turned off on this server."));
  else if (!kyberR.ok) routes.push(failRow("kyberswap", why(kyberR.e)));
  else {
    const k = kyberR.v;
    const lossPct = k.inUsd && k.outUsd ? Math.max(0, (1 - k.outUsd / k.inUsd) * 100) : null;
    const canSign = swapVenue === "kyberswap" && KYBER_LIVE;
    routes.push(row({ venue: "kyberswap", label: `KyberSwap · via ${k.exchanges.join(" + ") || "?"}`, ok: true, out: formatUnits(k.out, D), outRaw: k.out.toString(),
      impact: swapVenue === "kyberswap" ? gq?.priceImpact ?? null : null, feesPct: swapVenue === "kyberswap" ? gq?.feePct ?? null : null,
      gasEth: k.gasUsd && ethUsd ? k.gasUsd / ethUsd : rhGas("kyberswap"), gasNote: k.gasUsd ? "KyberSwap's own gas estimate" : gasNoteFor("kyberswap"), etaSec: ETA_RH,
      executable: canSign, handoff: { kind: "swap", href: swapHref() }, via: k.exchanges.join(", "),
      note: lossPct != null ? `KyberSwap values this at $${k.inUsd.toFixed(2)} in, $${k.outUsd.toFixed(2)} out (${lossPct.toFixed(2)}% lost to fees, spread and impact by its prices).` : null }));
  }

  /* ---- cross-chain: pay with ETH on Base or Arbitrum ---- */
  const crossR = await crossP;
  XC.forEach((s, i) => {
    const venue = `lifi-${s.key}`, r = crossR[i];
    if (!r) return routes.push(failRow(venue, `A cross-chain buy is limited to ${CROSS_MAX_ETH} ETH at a time.`, { chain: s.key, chainId: s.id }));
    if (!r.ok) return routes.push(failRow(venue, why(r.e), { chain: s.key, chainId: s.id }));
    const q = r.v;
    const feesPct = q.fromAmountUsd > 0 ? (q.feeUsd / q.fromAmountUsd) * 100 : null;
    routes.push(row({ venue, chain: s.key, chainId: s.id, label: `Pay from ${s.name} · ${q.tool}`, ok: true, out: formatUnits(BigInt(q.toAmount), q.toDecimals ?? D), outRaw: String(q.toAmount),
      impact: null, feesPct, gasEth: q.gasUsd && ethUsd ? q.gasUsd / ethUsd : null, gasNote: q.gasUsd ? `LI.FI's gas estimate on ${s.name}` : "No gas figure from LI.FI",
      etaSec: q.executionSec || null, executable: true, handoff: { kind: "cross", href: swapHref(`&pay=${s.key}`), fromChain: s.id },
      via: q.tool, note: `One transaction on ${s.name}; the coin lands on Robinhood Chain.${who ? "" : " Quoted for a stand-in wallet until you connect."}` }));
  });

  /* ---- Lighter spot (an order book on Robinhood Chain, quoted in USDG) ---- */
  const lighterR = await lighterP;
  const alsoAvailable = [];
  let lighterBook = null;
  if (!lighterR.ok) routes.push(failRow("lighter-spot", why(lighterR.e)));
  else {
    const { books, assets } = lighterR.v;
    const asset = assets.find((a) => lc(a.l1_address) === lc(coin.address));
    const spot = asset && books.find((b) => b.market_type === "spot" && b.status === "active" && Number(b.base_asset_id) === Number(asset.asset_id) && Number(b.quote_asset_id) === USDG_ASSET);
    const perp = books.find((b) => b.market_type === "perp" && b.status === "active" && String(b.symbol).toUpperCase() === String(coin.symbol).toUpperCase());
    if (perp && asset) alsoAvailable.push({ venue: "lighter-perps", label: `Lighter perp · ${perp.symbol}`, href: `#/lighter/${encodeURIComponent(perp.symbol)}`, note: "A perp on the price, margined in USDG: you do not hold the coin." });
    else if (perp) alsoAvailable.push({ venue: "lighter-perps", label: `Lighter perp · ${perp.symbol}`, href: `#/lighter/${encodeURIComponent(perp.symbol)}`, note: "A perp with the same ticker. Nothing links it to this contract, so check it is the same asset." });
    if (!spot) routes.push(failRow("lighter-spot", asset ? `Lighter lists this token (asset ${asset.symbol}) but has no active spot market for it against USDG.` : "Lighter has no spot market for this coin."));
    else lighterBook = { spot, asset };
  }
  if (lighterBook) routes.push(await lighterRow(lighterBook, coin, amt, gp).catch((e) => failRow("lighter-spot", why(e))));

  /* ---- Hyperliquid: spot only for the same token, perps as "also available" ---- */
  const [hlSpotR, hlPerpR] = await Promise.all([hlSpotP, hlPerpP]);
  const sym = String(coin.symbol || "").toUpperCase();
  if (!hlSpotR.ok) routes.push(failRow("hyperliquid-spot", why(hlSpotR.e), { chain: "hyperliquid", chainId: 1337 }));
  else {
    const same = (hlSpotR.v.pairs || []).filter((p) => String(p.base || "").toUpperCase() === sym);
    routes.push(failRow("hyperliquid-spot", same.length
      ? `Hyperliquid spot has ${same.map((p) => p.label).join(", ")}, but that is Hyperliquid's own token with the same ticker, not this Robinhood Chain contract, so it is not offered as a route.`
      : "Hyperliquid spot has no market for this coin.", { chain: "hyperliquid", chainId: 1337 }));
  }
  if (hlPerpR.ok) {
    for (const m of (hlPerpR.v.markets || []).filter((x) => String(x.coin).toUpperCase() === sym || String(x.coin).toUpperCase() === `XYZ:${sym}`).slice(0, 2)) {
      alsoAvailable.push({ venue: "hyperliquid-perps", label: `Hyperliquid perp · ${m.displayName || m.coin}`, href: `#/perps/${encodeURIComponent(m.coin)}`, mark: m.mark ?? null, note: "A perp on the price, settled in USDC: you do not hold the coin, and it is not a buy route." });
    }
  }

  // the Gate did not finish: Robinhood Chain routes are quoted but not offered to sign until it does
  if (!gateR.ok) for (const r of routes) if (r.ok && r.chain === "robinhood" && !r.executable && r.venue !== "lighter-spot") { r.pending = true; r.note = `The Gate did not finish (${gate.error}), so this route is not offered to sign yet.`; }

  /* ---- price, net of gas, ranking ---- */
  const kyberOk = kyberR?.ok ? kyberR.v : null;
  const lifiOk = crossR.find((r) => r?.ok)?.v || null;
  const idx = rowR.ok ? rowR.v : null;
  let priceUsd = null, priceSource = null;
  if (Number(idx?.priceUsd) > 0) { priceUsd = Number(idx.priceUsd); priceSource = "Troya's market board"; }
  else if (kyberOk?.outUsd && kyberOk.out > 0n) { priceUsd = kyberOk.outUsd / num(kyberOk.out, D); priceSource = "KyberSwap's route value"; }
  else if (lifiOk?.toAmountUsd && BigInt(lifiOk.toAmount) > 0n) { priceUsd = lifiOk.toAmountUsd / num(BigInt(lifiOk.toAmount), lifiOk.toDecimals ?? D); priceSource = "LI.FI's route value"; }
  const amtNum = Number(amt.text);
  for (const r of routes) {
    if (!r.ok || r.out == null) continue;
    const out = Number(r.out);
    r.outUsd = priceUsd != null ? +(out * priceUsd).toFixed(4) : null;
    r.gasUsd = r.gasEth != null && ethUsd ? +(r.gasEth * ethUsd).toFixed(4) : null;
    // gas turned into coins at this route's own rate: what is left after paying for the transaction
    r.netOut = r.gasEth != null ? Math.max(0, out * (1 - r.gasEth / amtNum)) : out;
  }
  const okRows = routes.filter((r) => r.ok).sort((a, b) => b.netOut - a.netOut);
  const bad = routes.filter((r) => !r.ok);
  const ranked = [...okRows, ...bad];
  const pick = (r) => r ? { venue: r.venue, label: r.label, chain: r.chain, netOut: r.netOut, out: r.out, reason: reasonFor(r, coin) } : null;
  // best: the top route Troya can sign; when the Gate blocks the coin it is still named, with blocked set (Buy stays off)
  const bestRow = okRows.find((r) => r.executable) || null;
  const topRow = okRows[0] || null;
  const best = pick(bestRow);
  if (best) { best.blocked = !gateOpen; if (!gateOpen) best.blockedWhy = gate.why; }
  const bestOverall = topRow && topRow !== bestRow ? { ...pick(topRow), moreThanBestPct: bestRow && bestRow.netOut > 0 ? +(((topRow.netOut / bestRow.netOut) - 1) * 100).toFixed(2) : null,
    why: topRow.chain === "robinhood" && !swapVenue && topRow.venue !== "lighter-spot"
      ? (gateR.ok ? "The Gate found no route Swap can sign for this coin right now." : `The Troya Gate did not finish (${gate.error}), so no route is offered to sign yet. Try again in a moment.`)
      : `Troya's Swap cannot sign a ${topRow.label.split(" · ")[0]} route yet, so it is shown for comparison.` } : null;

  /* ---- where the wallet can pay from ---- */
  let fundFrom = null;
  if (balP) {
    const b = await balP;
    fundFrom = b.ok ? b.v.map((x) => ({ ...x, enough: x.raw != null && BigInt(x.raw) >= amt.wei + RESERVE[x.key], raw: undefined })) : [{ error: why(b.e) }];
  }

  return {
    token: coin, amountIn: amt.text, amountInWei: amt.wei.toString(), ethUsd, priceUsd, priceSource,
    routes: ranked, best, bestOverall, gate, alsoAvailable, fundFrom, wallet: who,
    quotedAt: Date.now(), tookMs: Date.now() - t0, timings: times,
    note: "Read-only quotes from each venue at this moment. Gas is an estimate. Routes marked executable open Troya's Swap, which quotes again and runs the Gate before your wallet signs.",
  };
}

function reasonFor(r, coin) {
  const sym = coin.symbol ? `$${coin.symbol}` : "coins";
  const name = r.label.split(" · ")[0];
  const bits = [];
  if (r.priceImpactPct != null) bits.push(`${r.priceImpactPct < 0.01 ? "<0.01" : r.priceImpactPct.toFixed(r.priceImpactPct < 1 ? 2 : 1)}% impact`);
  else if (r.feesPct != null) bits.push(`${r.feesPct.toFixed(2)}% fees`);
  if (r.chain !== "robinhood" && r.etaSec) bits.push(`about ${r.etaSec < 90 ? `${Math.round(r.etaSec)} s` : `${Math.round(r.etaSec / 60)} min`}`);
  return `Most ${sym} for your ETH: ${name}${bits.length ? `, ${bits.join(", ")}` : ""}`;
}

// gas for the two Robinhood Chain transactions a Lighter buy needs first: ETH → USDG on Uniswap, then the deposit
const LIGHTER_GAS_UNITS = 160_000 + 120_000;
async function lighterRow({ spot, asset }, coin, amt, gp) {
  // ETH → USDG on Robinhood Chain first (the Uniswap route Swap would take), then the USDG walks Lighter's asks
  const [u, book] = await Promise.all([
    within(uniswapVenues({ tokenIn: "ETH", tokenOut: ADDR.usdg, amountInRaw: amt.wei.toString() }), T.uni, "ETH → USDG quote"),
    within(lighterGet(`/api/v1/orderBookOrders?market_id=${spot.market_id}&limit=100`), T.lighter, "Lighter order book"),
  ]);
  const leg = [u.v3, u.v4].filter(Boolean).sort((a, b) => (b.out > a.out ? 1 : -1))[0];
  if (!leg) throw new Error("No ETH → USDG route to fund a Lighter buy.");
  let usdg = Number(leg.amountOut), got = 0, spent = 0;
  const asks = (book.asks || []).map((o) => ({ px: Number(o.price), sz: Number(o.remaining_base_amount ?? o.initial_base_amount ?? 0) })).filter((x) => x.px > 0 && x.sz > 0).sort((a, b) => a.px - b.px);
  if (!asks.length) throw new Error(`Lighter's ${spot.symbol} book has no sell orders right now.`);
  const fee = Number(spot.taker_fee || 0) / 100;
  for (const a of asks) {
    if (usdg <= 0) break;
    const cost = a.px * a.sz * (1 + fee);
    if (cost <= usdg) { got += a.sz; spent += cost; usdg -= cost; }
    else { const part = usdg / (a.px * (1 + fee)); got += part; spent += usdg; usdg = 0; }
  }
  if (usdg > 1e-6) throw new Error(`Lighter's ${spot.symbol} book is too thin for this size (it fills about $${spent.toFixed(2)} of $${(spent + usdg).toFixed(2)}).`);
  const avg = spent / got, impact = Math.max(0, avg / asks[0].px - 1);
  return row({ venue: "lighter-spot", label: `Lighter spot · ${spot.symbol}`, ok: true, out: got.toFixed(Math.min(8, coin.decimals)), outRaw: null,
    impact, feesPct: (leg.feePct || 0) + fee * 100, gasEth: gp != null ? num(gp * BigInt(LIGHTER_GAS_UNITS), 18) : null,
    gasNote: gp != null ? "Estimate: the ETH → USDG swap and the Lighter deposit (about 280k gas units on Robinhood Chain)" : "Gas price could not be read, so gas is not counted",
    etaSec: null, executable: false, via: `${leg.label}, then Lighter's book`, note: `Needs USDG deposited on Lighter first (asset ${asset.symbol}); Troya's Swap does not trade Lighter spot.` });
}

async function balances(who) {
  const nets = [{ key: "robinhood", id: CHAIN_ID, name: "Robinhood Chain" }, ...XC];
  return Promise.all(nets.map(async (n) => {
    try { const raw = BigInt(await rpc(n.key, "eth_getBalance", [who, "latest"])); return { key: n.key, chainId: n.id, name: n.name, balanceEth: formatUnits(raw, 18), raw: raw.toString() }; }
    catch (e) { return { key: n.key, chainId: n.id, name: n.name, balanceEth: null, raw: null, error: why(e) }; }
  }));
}

/* ---------- cache: the same coin, amount and wallet within 15 s share one answer ---------- */
const CACHE = new Map();
export async function atlasCached(q) {
  const key = [lc(q.token).trim(), String(q.amountEth || "").trim(), lc(q.from || "")].join("|");
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) { const v = await hit.p; return { ...v, cached: true }; }
  const p = atlasQuote(q);
  CACHE.set(key, { at: Date.now(), p });
  p.catch(() => { if (CACHE.get(key)?.p === p) CACHE.delete(key); });   // errors are never kept
  if (CACHE.size > CACHE_MAX) for (const [k, x] of CACHE) if (Date.now() - x.at > CACHE_MS || CACHE.size > CACHE_MAX) CACHE.delete(k);
  return { ...(await p), cached: false };
}

export async function register(r) {
  // weight 3, 30 a minute: one call fans out to every venue (the cross-chain buy's own limits)
  r.get("/api/atlas/quote", ({ query }) => atlasCached({ token: query.token, amountEth: query.amountEth ?? query.amount, from: query.from }), { weight: 3, perMin: 30 });
}
