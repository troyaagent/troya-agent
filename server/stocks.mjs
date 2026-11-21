// F17 · Stock desk: Robinhood stock tokens on Robinhood Chain.
//   GET /api/stocks/desk           → every stock token (price, the ERC-8056 multiplier that dividends and splits move,
//                                    pending changes) and the corporate actions calendar (cash dividends, splits)
//   GET /api/stocks/loans?address= → Morpho Blue markets that lend USDG against stock tokens, and the user's loans with
//                                    health factor and the collateral price where liquidation starts
// Sources: Robinhood's stock token API (api.robinhood.com/rhj), DexScreener for pool prices, Morpho Blue on chain.
import { Interface } from "ethers";
import { rpc, ADDR } from "./robinhood.mjs";
import { dsPairs, dsRows, getEthUsd } from "./market.mjs";
import { HttpError } from "./api.mjs";
import { monogramSvg } from "./icons.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RH_API = "https://api.robinhood.com/rhj";
const lc = (s) => String(s || "").toLowerCase();
const memo = new Map();
async function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  memo.set(key, { at: Date.now(), v });
  return v;
}
async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "troya-agent/0.2" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(502, `Robinhood's stock token API answered ${r.status}.`);
  return r.json();
}
const date = (d) => (d?.year ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);

/* ---------- the desk: stocks, multipliers, corporate actions ---------- */
export async function stockDesk() {
  return cached("desk", 10 * 60e3, async () => {
    const [a, c, ethUsd] = await Promise.all([getJson(`${RH_API}/assets`), getJson(`${RH_API}/corporate-actions`), getEthUsd().catch(() => null)]);
    const assets = (a.assets || []).filter((x) => x.status === "ASSET_STATUS_ACTIVE").map((x) => {
      const dep = (x.deployments || []).find((d) => d.chainId === 4663);
      return dep ? { symbol: x.tokenSymbol, name: String(x.tokenName || "").replace(/\s•\s*Robinhood Token$/, ""), address: lc(dep.contractAddress), logo: x.logoUrl || null,
        multiplier: Number(x.currentMultiplier || 1), pendingMultiplier: x.pendingMultiplier ? Number(x.pendingMultiplier) : null, pendingAt: x.pendingMultiplierEffectiveTime || null, isin: x.isin || null } : null;
    }).filter(Boolean);
    const rows = dsRows(await dsPairs(assets.map((x) => x.address)).catch(() => []), ethUsd);
    for (const x of assets) {
      const r = rows.get(x.address);
      Object.assign(x, { priceUsd: r?.priceUsd ?? null, change24h: r?.change24h ?? null, liquidityUsd: r?.liquidityUsd ?? null, volume24hUsd: r?.volume24hUsd ?? null });
    }
    assets.sort((p, q) => (q.volume24hUsd || 0) - (p.volume24hUsd || 0) || p.symbol.localeCompare(q.symbol));
    const bySym = new Map(assets.map((x) => [x.symbol, x]));
    // the API's status alone is not enough: an action still "in progress" after its date is being paid, not coming up
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    const actions = (c.corpActions || []).map((x) => {
      const div = x.details?.cashDividend, split = x.details?.forwardSplit || x.details?.reverseSplit || x.details?.split;
      const s = bySym.get(x.tokenSymbol);
      const d = date(x.processDate), num = (v) => (v == null || v === "" ? null : Number(v));
      const open = /PROGRESS|PENDING|SCHEDULED/.test(x.status);
      return {
        symbol: x.tokenSymbol, address: lc((x.deployments || []).find((dp) => dp.chainId === 4663)?.contractAddress) || s?.address || null,
        type: /DIVIDEND/.test(x.type) ? "dividend" : /REVERSE_SPLIT/.test(x.type) ? "reverse split" : /SPLIT/.test(x.type) ? "split" : String(x.type).replace(/^CORPORATE_ACTION_TYPE_/, "").toLowerCase(),
        status: /COMPLETED/.test(x.status) ? "done" : open ? (d && d < today ? "paying" : "upcoming") : String(x.status).replace(/^CORPORATE_ACTION_STATUS_/, "").toLowerCase(),
        date: d, dividendPerShare: div?.rate != null ? Number(div.rate) : null,
        // splits come as { oldRate: "1", newRate: "3" }: a 3-for-1 split reads [3, 1]
        ratio: split ? [num(split.newRate ?? split.numerator ?? split.newShares), num(split.oldRate ?? split.denominator ?? split.oldShares)] : null,
        yieldPct: div?.rate != null && s?.priceUsd ? (Number(div.rate) / (s.priceUsd / (s.multiplier || 1))) * 100 : null,   // one payment against the share price
      };
    }).filter((a) => {
      // the feed repeats some actions (same stock, date, type and amount): list each once
      const k = `${a.symbol}|${a.date}|${a.type}|${a.dividendPerShare ?? ""}|${a.ratio?.join(":") ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((p, q) => String(q.date).localeCompare(String(p.date)));
    return {
      assets, actions, updatedAt: Date.now(), source: "Robinhood stock token API + DexScreener pools",
      note: "Dividends are reinvested into the token: the multiplier rises and each token stands for slightly more of the share. Splits multiply it. Balances in your wallet do not change.",
    };
  });
}

/* ---------- Morpho Blue: borrow USDG against stock tokens ---------- */
export const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
// listed (whitelisted) stock-collateral / USDG markets on Robinhood Chain, from Morpho's API (16 Nov 2026)
const MARKETS = [
  ["NVDA", "0xf5ff7d546af5e72f3912d2aa723088fd0bf66fddc158714995637714d9db6e4c"], ["SPY", "0xeb1739b2a69dd22a4285d366a06698a01018b37c24d2994fefe19cc72f313613"],
  ["GOOGL", "0x7408b08b03e05ffd2d21c797489a0e77a28e4bb36acb4e827c69e805d06272b4"], ["NVDA", "0x95312f02c1dae8407b2c80468a5657a9bd19c45ac277f1a61aa52c11444c5314"],
  ["SPCX", "0x10151e2ac82a820153520d9d77d56de1c84775e23b79bdc11e2e34282d9afa10"], ["GOOGL", "0xba01f6625137b692c5dd86afb8e654b4016d7b64e36dfca4124e84bef98bc4d2"],
  ["NVDA", "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc"], ["TSLA", "0x22e4598e5cc16cff0056e72d61c5f1f2f8bf5bbffc22da5277ab196939c8a59e"],
  ["AAPL", "0x947ae981cc823024ea00b602f6ea72d049cac05d66ef096198ceeb998651c175"], ["SPCX", "0x21ea2a012b888120e328775c2a7bf6fb4619cf4c4c631ad1c9b6db51f8882d5a"],
  ["TSLA", "0xe29c7d3790037800101ecbad9c45de2067698d206cbcab7c25069a9f43c9eb98"], ["AAPL", "0xcaa167af7ba0422c76424fae56167b7db25bf19f4f435215e6dd7d06a943bdac"],
  ["META", "0x69400cfe81f2ae381b9a9f27076a4d637338379d999e9ffdfbde52f0876312ee"],
];
const morpho = new Interface([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const oracleI = new Interface(["function price() view returns (uint256)"]);
const mc = new Interface(["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)"]);
async function multicall(calls) {
  const raw = await rpc("robinhood", "eth_call", [{ to: ADDR.multicall3, data: mc.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))]) }, "latest"], { timeoutMs: 15000 });
  return mc.decodeFunctionResult("aggregate3", raw)[0];
}
async function marketsState() {
  return cached("morpho:markets", 60_000, async () => {
    const params = await cached("morpho:params", 24 * 3600e3, async () => {
      const r = await multicall(MARKETS.map(([, id]) => ({ to: MORPHO, data: morpho.encodeFunctionData("idToMarketParams", [id]) })));
      return MARKETS.map(([symbol, id], i) => {
        const p = morpho.decodeFunctionResult("idToMarketParams", r[i].returnData);
        return { id, symbol, loanToken: lc(p.loanToken), collateralToken: lc(p.collateralToken), oracle: lc(p.oracle), irm: lc(p.irm), lltv: p.lltv.toString() };
      });
    });
    const r = await multicall(params.flatMap((p) => [{ to: MORPHO, data: morpho.encodeFunctionData("market", [p.id]) }, { to: p.oracle, data: oracleI.encodeFunctionData("price") }]));
    return params.map((p, i) => {
      const m = morpho.decodeFunctionResult("market", r[2 * i].returnData);
      const price = r[2 * i + 1].success ? BigInt(oracleI.decodeFunctionResult("price", r[2 * i + 1].returnData)[0]) : null;
      const supply = Number(m.totalSupplyAssets) / 1e6, borrow = Number(m.totalBorrowAssets) / 1e6;
      return { ...p, lltvPct: Number(BigInt(p.lltv) / 10n ** 14n) / 100, supplyUsdg: supply, borrowUsdg: borrow, utilization: supply ? borrow / supply : 0, liquidityUsdg: supply - borrow,
        priceUsd: price != null ? Number(price) / 1e24 : null,   // oracle: USDG (6 dec) per stock token (18 dec) at 1e36 scale
        _m: { tba: m.totalBorrowAssets.toString(), tbs: m.totalBorrowShares.toString() }, _price: price?.toString() ?? null };
    });
  });
}
export async function stockLoans(address) {
  const ms = await marketsState();
  const out = { markets: ms.map(({ _m, _price, ...x }) => x), loans: [], updatedAt: Date.now(),
    note: "Morpho Blue lends USDG against stock tokens. A loan can be liquidated when its health factor falls to 1, that is when the collateral is worth less than the loan divided by the LLTV." };
  if (!address) return out;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new HttpError(400, "That is not a valid address.");
  const r = await multicall(ms.map((m) => ({ to: MORPHO, data: morpho.encodeFunctionData("position", [m.id, address]) })));
  ms.forEach((m, i) => {
    if (!r[i].success) return;
    const p = morpho.decodeFunctionResult("position", r[i].returnData);
    const coll = BigInt(p.collateral), bs = BigInt(p.borrowShares);
    if (coll === 0n && bs === 0n) return;
    const tba = BigInt(m._m.tba), tbs = BigInt(m._m.tbs);
    const borrowRaw = bs === 0n ? 0n : (bs * (tba + 1n) + (tbs + 1_000_000n) - 1n) / (tbs + 1_000_000n);   // round up, as Morpho does
    const price = m._price ? BigInt(m._price) : 0n;
    const maxBorrowRaw = (coll * price / 10n ** 36n) * BigInt(m.lltv) / 10n ** 18n;
    const borrow = Number(borrowRaw) / 1e6, collTokens = Number(coll) / 1e18;
    out.loans.push({
      marketId: m.id, symbol: m.symbol, collateral: collTokens, collateralRaw: coll.toString(), borrowShares: bs.toString(), borrowRaw: borrowRaw.toString(), collateralUsd: m.priceUsd ? collTokens * m.priceUsd : null, borrowUsdg: borrow,
      maxBorrowUsdg: Number(maxBorrowRaw) / 1e6, health: borrowRaw > 0n ? Number(maxBorrowRaw) / Number(borrowRaw) : null,
      liquidationPriceUsd: borrow > 0 && collTokens > 0 ? borrow / (collTokens * (m.lltvPct / 100)) : null, lltvPct: m.lltvPct, priceUsd: m.priceUsd,
    });
  });
  return out;
}

// Logos the vetted PNG set cannot give. Anthropic (ANT) has no ticker logo upstream and the token indexes answer the Robinhood
// feather for it, so it wears the mark the Hyperliquid xyz:ANT perp uses (the same vector, 20 Nov 2026). Read by
// /api/stocks/logo here and by /api/icon/token and /api/icon/coin in icons.mjs, so every page shows the same mark.
const ANTHROPIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><title>Anthropic icon</title>` +
  `<rect width="180" height="180" fill="#fafaf7"/><g transform="translate(31.5 49.236702127659576) scale(0.12446808510638298)">` +
  `<path fill="#191919" d="m536.5 1.3l260 653.6h142.5l-260-653.6z"/>` +
  `<path fill-rule="evenodd" fill="#191919" d="m259.7 0.5h149.1l259.7 653.6h-145.3l-53.1-137.2h-271.7l-53.2 137.2h-145.2zm-14.4 394.9h178l-89-229.7z"/></g></svg>`;
const LOGO_BY_ADDRESS = { "0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373": "ANT" };
const LOGO_BY_TICKER = { ANT: { type: "image/svg+xml", body: Buffer.from(ANTHROPIC_SVG) } };
/** The override logo for a stock token address or ticker ({ type, body }), or null. */
export function logoOverride(address, ticker) {
  return LOGO_BY_TICKER[LOGO_BY_ADDRESS[lc(address)] || String(ticker || "").toUpperCase()] || null;
}

const logos = new Map();
let logoDir = null;
async function logo(addr) {
  const a = lc(addr);
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new HttpError(400, "Bad address.");
  if (logos.has(a)) return logos.get(a);
  const fixed = logoOverride(a);
  if (fixed) return fixed;
  // the vetted company logo shipped with the site (/img/logos/stocks/<TICKER>.png) wins, so every page shows the same one
  // only the vetted logos: Robinhood's CDN returns the same feather for most stock tokens, which is worse than a letter
  const rh = await import("./robinhood.mjs").catch(() => null);
  const desk = await stockDesk().catch(() => null);
  const tk = rh?.STOCKS?.find((x) => lc(x.address) === a)?.symbol || desk?.assets?.find((x) => lc(x.address) === a)?.symbol;
  const over = logoOverride(a, tk);
  if (over) return over;
  const own = tk ? await readFile(new URL(`../public/img/logos/stocks/${String(tk).replace(/[^A-Za-z0-9.]/g, "")}.png`, import.meta.url)).catch(() => null) : null;
  // no vetted logo: the letter tile the app draws, as an image (200, not 404), kept 6 h and not memoized (a logo may ship)
  if (!own) return { type: "image/svg+xml", body: monogramSvg(tk || "", a, 2), mono: true };
  const v = { type: "image/png", body: own };
  logos.set(a, v);
  return v;
}

export async function register(r, ctx) {
  logoDir = join(ctx.dataDir, "stock-logos");
  await mkdir(logoDir, { recursive: true }).catch(() => { logoDir = null; });
  r.get("/api/stocks/logo/:address", async ({ params, res }) => {
    const x = await logo(params.address);
    res.writeHead(200, {
      "content-type": x.type, "cache-control": `public, max-age=${x.mono ? 21600 : 604800}`, "x-content-type-options": "nosniff", ...(x.mono ? { "x-icon": "monogram" } : {}),
      // an SVG opened directly must not run anything
      ...(x.type === "image/svg+xml" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    });
    res.end(x.body);
    return undefined;
  }, { weight: 1 });
  r.get("/api/stocks/desk", () => stockDesk(), { weight: 1 });
  r.get("/api/stocks/loans", ({ query }) => stockLoans(query.address || null), { weight: 1 });
}
