// Robinhood Chain access for Troya (chain 4663, gas in ETH):
//  - JSON-RPC relay (/api/rpc/:chain) so the browser talks to chains through our origin
//  - swap quotes + calldata: Pons Family bonding curves (before graduation) and Uniswap v3 / v4 (everything else,
//    graduated Pons coins included: their v4 pool key is computed from the Pons factory record)
//  - Troya Gate (route, impact, depth, fee, simulation, test sell), token health heuristics, balances
//  - Pons launch builder, logo hosting for launches, LI.FI bridge quotes (Arbitrum / Base / Ethereum ⇄ Robinhood Chain)
//
// Every address below is a public contract read from chain (Uniswap deployments checked against SwapRouter02.WETH9,
// UniversalRouter.poolManager and V4Quoter.poolManager; Pons factory/hook from launched tokens). Nothing here holds funds:
// every function returns a transaction for the user's own wallet to sign.
import {
  AbiCoder, Interface, getAddress, isAddress, parseUnits, formatUnits, keccak256, id as selectorId, toBeHex, ZeroAddress, solidityPacked, hexlify, randomBytes,
} from "ethers";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, send } from "./api.mjs";
import { KYBER_ON, KYBER_LIVE, kyberRoute, kyberBuild, splitLoss } from "./kyber.mjs";

/* ------------------------------------------------------------------ */
/* chains + upstreams                                                  */
/* ------------------------------------------------------------------ */

const list = (env, fallback) => (process.env[env] ? process.env[env].split(/[\s,]+/).filter(Boolean) : fallback);
export const CHAIN_ID = 4663;
const OFFICIAL_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const CHAINS = {
  robinhood: { id: 4663, name: "Robinhood Chain", upstreams: list("ROBINHOOD_RPCS", [OFFICIAL_RPC, "https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"]) },
  arbitrum: { id: 42161, name: "Arbitrum One", upstreams: list("ARBITRUM_RPCS", ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"]) },
  // bridge sources: the browser reads balances and receipts here through the relay
  base: { id: 8453, name: "Base", upstreams: list("BASE_RPCS", ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]) },
  ethereum: { id: 1, name: "Ethereum", upstreams: list("ETHEREUM_RPCS", ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]) },
};

export const ADDR = {
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // Uniswap
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  // Pons Family
  ponsFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  ponsHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
};
for (const k of Object.keys(ADDR)) ADDR[k] = getAddress(ADDR[k].toLowerCase());
const ZERO = ZeroAddress;
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const V3_FEES = [100, 500, 3000, 10000];
export const PONS_SITE = "https://ponsfamily.com/launchpad/";

/* ------------------------------------------------------------------ */
/* raw JSON-RPC with fallback                                          */
/* ------------------------------------------------------------------ */

class RpcError extends Error { constructor(msg, code, data) { super(msg); this.code = code; this.data = data; } }
const failedAt = new Map(); // upstream → time it last failed

async function post(url, payload, timeoutMs) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": "troya-agent/0.2" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 500 || res.status === 429 || res.status === 403) throw Object.assign(new Error(`upstream ${res.status}`), { transient: true });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`upstream sent non-JSON (${res.status})`), { transient: true }); }
}
function ordered(chain) {
  const ups = CHAINS[chain]?.upstreams;
  if (!ups?.length) throw new HttpError(404, `Unknown chain: ${chain}`);
  return [...ups].sort((a, b) => ((failedAt.get(a) || 0) > Date.now() - 60_000 ? 1 : 0) - ((failedAt.get(b) || 0) > Date.now() - 60_000 ? 1 : 0));
}
async function forward(chain, payload, { noRetry = false, timeoutMs = Number(process.env.RPC_TIMEOUT_MS) || 9000, only } = {}) {
  let lastErr;
  for (const url of only ? [only] : ordered(chain)) {
    try { return await post(url, payload, timeoutMs); }
    catch (e) {
      lastErr = e;
      failedAt.set(url, Date.now());
      if (noRetry && !(e.transient || e.name === "TimeoutError" || e.cause)) break;
    }
  }
  throw new HttpError(502, `Could not reach ${CHAINS[chain].name}: ${lastErr?.message || "no upstream answered"}`);
}
/** rpc(chain, method, params) → result; throws RpcError on a JSON-RPC error (e.g. a revert). */
export async function rpc(chain, method, params = [], opts = {}) {
  const r = await forward(chain, { jsonrpc: "2.0", id: 1, method, params }, { noRetry: method === "eth_sendRawTransaction", ...opts });
  if (r?.error) throw new RpcError(r.error.message || "RPC error", r.error.code, r.error.data);
  return r?.result;
}

/* ------------------------------------------------------------------ */
/* ABIs                                                                */
/* ------------------------------------------------------------------ */

const POOLKEY = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const PATHKEY = "(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)";
const TOKEN_PARAMS = "tuple(string name,string symbol,string logo,string description,tuple(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)";
export const iface = {
  erc20: new Interface([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)",
    "function owner() view returns (address)", "function transfer(address to,uint256 amount) returns (bool)",
  ]),
  ponsToken: new Interface(["function logo() view returns (string)", "function description() view returns (string)", "function socials() view returns (string twitter,string telegram,string discord,string website,string farcaster)"]),
  mc: new Interface([
    "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
    "function getEthBalance(address addr) view returns (uint256)",
  ]),
  v3Factory: new Interface(["function getPool(address,address,uint24) view returns (address)"]),
  quoterV2: new Interface(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]),
  v4Quoter: new Interface([
    `function quoteExactInputSingle((${POOLKEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
    `function quoteExactInput((address exactCurrency,${PATHKEY}[] path,uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)`,
  ]),
  swapRouter02: new Interface([
    "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
    "function unwrapWETH9(uint256 amountMinimum) payable",
    "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
  ]),
  ur: new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  permit2: new Interface([
    "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
    "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  ]),
  weth: new Interface(["function deposit() payable", "function withdraw(uint256)"]),
  ponsFactory: new Interface([
    "function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
    "function launchFee() view returns (uint256)", "function launchEnabled() view returns (bool)", "function canLaunch(address launcher) view returns (bool)",
    "function launchConfigCount() view returns (uint256)",
    "function getLaunchConfig(uint256 id) view returns (tuple(uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
    "function maxCreatorTaxBps() view returns (uint256)", "function snipeTaxStartBps() view returns (uint256)", "function snipeTaxSeconds() view returns (uint256)",
    "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
    `function launchToken(${TOKEN_PARAMS} params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)`,
  ]),
  ponsCurve: new Interface([
    "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)",
    "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)", "function graduated() view returns (bool)",
    "function sellableTokens() view returns (uint256)", "function currentSnipeTaxBps(address recipient) view returns (uint256)", "function realQuoteReserve() view returns (uint256)",
    "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)",
    "function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut)",
  ]),
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const coder = AbiCoder.defaultAbiCoder();
const qty = (n) => "0x" + BigInt(n || 0).toString(16);
const lower = (a) => String(a).toLowerCase();
export const isNative = (t) => !t || /^(eth|native|0x0{40})$/i.test(String(t).trim());
function addr(a, label = "address") {
  if (!isAddress(String(a || "").trim())) throw new HttpError(400, `That ${label} is not a valid 0x address.`);
  return getAddress(String(a).trim());
}
async function ethCall(to, data, { from, value, block = "latest", overrides } = {}) {
  const tx = { to, data };
  if (from) tx.from = from;
  if (value) tx.value = qty(value);
  return rpc("robinhood", "eth_call", overrides ? [tx, block, overrides] : [tx, block]);
}
// many reads in one eth_call through Multicall3; failed legs come back as null. Batches run in parallel chunks, and a
// chunk the node refuses (out of gas on heavy quoter calls, a busy upstream) is halved and retried down to single calls.
async function readPart(part) {
  const data = iface.mc.encodeFunctionData("aggregate3", [part.map((c) => ({ target: c.target, allowFailure: true, callData: c.data ?? c.iface.encodeFunctionData(c.fn, c.args || []) }))]);
  try {
    const raw = await ethCall(ADDR.multicall3, data);
    const [res] = iface.mc.decodeFunctionResult("aggregate3", raw);
    return res.map((r, k) => {
      const c = part[k];
      if (!r.success) return null;
      if (c.raw) return r.returnData;
      try { return c.iface.decodeFunctionResult(c.fn, r.returnData); } catch { return null; }
    });
  } catch (e) {
    if (part.length > 1) {
      const mid = Math.ceil(part.length / 2);
      const [a, b] = await Promise.all([readPart(part.slice(0, mid)), readPart(part.slice(mid))]);
      return a.concat(b);
    }
    if (e instanceof HttpError) throw e; // no upstream answered at all
    return [null];
  }
}
async function readMany(calls, chunk = 60) {
  if (!calls.length) return [];
  const parts = [];
  for (let i = 0; i < calls.length; i += chunk) parts.push(calls.slice(i, i + chunk));
  return (await Promise.all(parts.map(readPart))).flat();
}
const C = (target, ifc, fn, args) => ({ target, iface: ifc, fn, args });
const RAW = (target, data) => ({ target, data, raw: true });

function parseAmount(v, decimals, label = "amount") {
  const s = String(v ?? "").trim();
  if (!/^\d*\.?\d+$/.test(s)) throw new HttpError(400, `Enter a positive ${label}.`);
  const [w, f = ""] = s.split(".");
  const x = parseUnits(`${w || "0"}.${f.slice(0, decimals) || "0"}`, decimals);
  if (x <= 0n) throw new HttpError(400, `Enter a positive ${label}.`);
  if (x >= 2n ** 127n) throw new HttpError(400, `That ${label} is too large.`);
  return x;
}
const fmt = (raw, dec) => formatUnits(raw, dec);

/* ---------- token metadata ---------- */
const NATIVE = { address: "native", symbol: "ETH", name: "Ether", decimals: 18 };
const META = new Map(); // lower(address) → { address, symbol, name, decimals, at }
META.set(lower(ADDR.weth), { address: ADDR.weth, symbol: "WETH", name: "Wrapped Ether", decimals: 18, at: Infinity });
META.set(lower(ADDR.usdg), { address: ADDR.usdg, symbol: "USDG", name: "Global Dollar", decimals: 6, at: Infinity });
export const STOCKS = [];
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const d = JSON.parse(await readFile(path.join(here, "data", "robinhood-stocks.json"), "utf8"));
  for (const s of d.stocks || []) {
    const a = getAddress(s.address.toLowerCase());
    STOCKS.push({ ...s, address: a });
    META.set(lower(a), { address: a, symbol: s.symbol, name: s.name, decimals: s.decimals ?? 18, stock: true, at: Infinity });
  }
} catch (e) { console.warn("[robinhood] stock list missing:", e.message); }

export async function tokenMeta(address) {
  const a = addr(address, "token address");
  const hit = META.get(lower(a));
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit;
  const r = await readMany([C(a, iface.erc20, "symbol"), C(a, iface.erc20, "name"), C(a, iface.erc20, "decimals"), C(a, iface.erc20, "totalSupply")]);
  if (r[2] == null && r[3] == null) throw new HttpError(404, `${a} does not look like a token on Robinhood Chain.`);
  const v = { address: a, symbol: String(r[0]?.[0] ?? "?"), name: String(r[1]?.[0] ?? ""), decimals: Number(r[2]?.[0] ?? 18), totalSupply: r[3] ? String(r[3][0]) : null, at: Date.now() };
  META.set(lower(a), v);
  return v;
}
const metaOf = async (a) => (a === ZERO ? NATIVE : tokenMeta(a));
const symOf = (a) => (a === ZERO ? "ETH" : META.get(lower(a))?.symbol || a.slice(0, 6));
const pub = (m) => ({ address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals });

/* ------------------------------------------------------------------ */
/* Pons Family                                                         */
/* ------------------------------------------------------------------ */

const ponsCache = new Map(); // lower(token) → { at, v }
/** ponsState(token, account?) → null when the token is not a Pons v2 launch; otherwise curve + fee state. */
export async function ponsState(token, account = ZERO) {
  const t = addr(token, "token address");
  const key = `${lower(t)}:${lower(account)}`;
  const hit = ponsCache.get(key);
  if (hit && Date.now() - hit.at < 8_000) return hit.v;
  const [lt] = await readMany([C(ADDR.ponsFactory, iface.ponsFactory, "getLaunchedToken", [t])]);
  const w = lt?.[0];
  if (!w || !w.exists) { ponsCache.set(key, { at: Date.now(), v: null }); return null; }
  const curve = getAddress(w.curve), pair = getAddress(w.pairToken);
  const r = await readMany([
    C(curve, iface.ponsCurve, "getReserves"), C(curve, iface.ponsCurve, "feeBps"), C(curve, iface.ponsCurve, "creatorTaxBps"), C(curve, iface.ponsCurve, "graduated"),
    C(curve, iface.ponsCurve, "sellableTokens"), C(curve, iface.ponsCurve, "realQuoteReserve"), C(curve, iface.ponsCurve, "currentSnipeTaxBps", [account || ZERO]),
  ]);
  const pairMeta = pair === ZERO ? NATIVE : await tokenMeta(pair).catch(() => ({ address: pair, symbol: "?", decimals: 18 }));
  const graduated = Number(w.phase) >= 2 || !!r[3]?.[0];
  const s = {
    token: t, curve, pair, pairSymbol: pairMeta.symbol, pairDecimals: pairMeta.decimals, graduated, phase: Number(w.phase),
    quoteReserve: BigInt(r[0]?.[0] ?? 0n), tokenReserve: BigInt(r[0]?.[1] ?? 0n),
    feeBps: BigInt(r[1]?.[0] ?? 100n), taxBps: BigInt(r[2]?.[0] ?? w.creatorTaxBps), sellable: BigInt(r[4]?.[0] ?? 0n),
    realQuote: BigInt(r[5]?.[0] ?? 0n), threshold: BigInt(w.graduationThreshold), snipeBps: BigInt(r[6]?.[0] ?? 0n),
    poolFee: Number(w.poolFee), tickSpacing: Number(w.tickSpacing), creatorFeeRecipient: getAddress(w.creatorFeeRecipient), deployer: getAddress(w.deployer),
  };
  if (graduated) {
    const [c0, c1] = lower(t) < lower(pair) ? [t, pair] : [pair, t];
    s.v4Key = { c0: getAddress(c0), c1: getAddress(c1), fee: s.poolFee, ts: s.tickSpacing, hooks: ADDR.ponsHook };
    s.poolId = poolIdOf(s.v4Key);
    addV4Key(s.poolId, { ...s.v4Key, liq: 1e6 });
  }
  ponsCache.set(key, { at: Date.now(), v: s });
  if (ponsCache.size > 3000) ponsCache.delete(ponsCache.keys().next().value);
  return s;
}
/** public view of ponsState (numbers instead of bigints) */
export function ponsPublic(s) {
  if (!s) return null;
  const pd = s.pairDecimals;
  const priceInPair = !s.graduated && s.tokenReserve > 0n ? Number(fmt(s.quoteReserve, pd)) / Number(fmt(s.tokenReserve, 18)) : null;
  return {
    token: s.token, curve: s.curve, graduated: s.graduated, phase: s.phase, poolId: s.poolId || null,
    pair: { address: s.pair === ZERO ? "native" : s.pair, symbol: s.pairSymbol, decimals: pd },
    priceInPair, raised: Number(fmt(s.realQuote, pd)), threshold: Number(fmt(s.threshold, pd)),
    progressPct: s.graduated ? 100 : s.threshold > 0n ? Math.min(100, Number((s.realQuote * 10000n) / s.threshold) / 100) : null,
    fees: { curveBps: Number(s.feeBps), creatorTaxBps: Number(s.taxBps), snipeTaxBps: Number(s.snipeBps) },
    creatorFeeRecipient: s.creatorFeeRecipient, deployer: s.deployer, ponsUrl: PONS_SITE + lower(s.token),
  };
}
const BPS = 10000n;
const cpOut = (a, rIn, rOut) => (a <= 0n ? 0n : (a * rOut) / (rIn + a));
function curveBuyQuote(s, pairIn) {
  let snipe = s.snipeBps;
  const max = BPS - s.feeBps - s.taxBps - 100n;
  if (snipe > max) snipe = max;
  const net = pairIn - (pairIn * (s.feeBps + s.taxBps + snipe)) / BPS;
  let out = cpOut(net, s.quoteReserve, s.tokenReserve);
  const capped = out > s.sellable;
  if (capped) out = s.sellable;
  const small = pairIn / 1000n > 0n ? pairIn / 1000n : 1n;
  const netSmall = small - (small * (s.feeBps + s.taxBps + snipe)) / BPS;
  const outSmall = cpOut(netSmall, s.quoteReserve, s.tokenReserve);
  const impact = outSmall > 0n ? Math.max(0, 1 - (Number(out) / Number(pairIn)) / (Number(outSmall) / Number(small))) : 0;
  return { out, capped, impact, snipeBps: snipe };
}
function curveSellQuote(s, tokIn) {
  const gross = cpOut(tokIn, s.tokenReserve, s.quoteReserve);
  const out = gross - (gross * (s.feeBps + s.taxBps)) / BPS;
  const spot = s.tokenReserve > 0n ? (tokIn * s.quoteReserve) / s.tokenReserve : 0n;
  return { out, impact: spot > 0n ? Math.max(0, 1 - Number(gross) / Number(spot)) : 0 };
}

/* ------------------------------------------------------------------ */
/* Uniswap v3 / v4 router                                              */
/* ------------------------------------------------------------------ */

let DATA_DIR = null;
const v4 = { keys: {}, pending: new Map(), scanning: false, saveTimer: null };
const poolIdOf = (k) => keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.c0, k.c1, k.fee, k.ts, k.hooks]));
function saveKeys() {
  if (!DATA_DIR || v4.saveTimer) return;
  v4.saveTimer = setTimeout(async () => {
    v4.saveTimer = null;
    try { await writeFile(path.join(DATA_DIR, "v4keys.json.tmp"), JSON.stringify(v4.keys)); await import("node:fs/promises").then((f) => f.rename(path.join(DATA_DIR, "v4keys.json.tmp"), path.join(DATA_DIR, "v4keys.json"))); } catch {}
  }, 2000);
}
export function addV4Key(id, key) {
  const k = lower(id);
  if (!v4.keys[k]) { v4.keys[k] = key; saveKeys(); }
  else if (key.liq && v4.keys[k]) v4.keys[k].liq = Math.max(v4.keys[k].liq || 0, key.liq);
}
// standard hookless keys and the Pons hook key; WETH as listed by indexers may really be native ETH in v4
const STD = [[100, 1], [500, 10], [3000, 60], [10000, 200], [2500, 50], [200, 4], [50, 1], [1000, 20], [5000, 100], [20000, 400]];
function guessKey(p) {
  const opts = [[p.a, p.b]];
  if (lower(p.a) === lower(ADDR.weth)) opts.push([ZERO, p.b]);
  if (lower(p.b) === lower(ADDR.weth)) opts.push([p.a, ZERO]);
  for (const [x, y] of opts) {
    const [c0, c1] = lower(x) < lower(y) ? [x, y] : [y, x];
    const tries = [...STD.map(([fee, ts]) => [fee, ts, ZERO]), [0, 200, ADDR.ponsHook]];
    for (const [fee, ts, hooks] of tries) {
      const k = { c0: getAddress(lower(c0)), c1: getAddress(lower(c1)), fee, ts, hooks };
      if (lower(poolIdOf(k)) === lower(p.id)) return k;
    }
  }
  return null;
}
const T_INIT = selectorId("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
/** noteV4([{id, a, b, liq}]) — v4 pools seen by the market index; unknown keys are resolved in the background. */
export function noteV4(pools) {
  for (const p of pools || []) {
    const id = lower(p.id || "");
    if (!/^0x[0-9a-f]{64}$/.test(id) || !p.a || !p.b) continue;
    if (v4.keys[id]) { v4.keys[id].liq = p.liq || v4.keys[id].liq; continue; }
    if (v4.keys[id] === null) continue;
    const g = guessKey({ ...p, id });
    if (g) { v4.keys[id] = { ...g, liq: p.liq || 0 }; continue; }
    v4.pending.set(id, p);
  }
  saveKeys();
  if (v4.pending.size && !v4.scanning) scanV4().catch((e) => { v4.scanning = false; console.warn("[v4 scan]", e.message); });
}
async function scanV4() {
  v4.scanning = true;
  try {
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    const STEP = 9_900_000;
    const ids = [...v4.pending.values()].sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, 8).map((p) => lower(p.id));
    for (const id of ids) {
      let found = false;
      for (let to = head; to > 0 && !found; to -= STEP) {
        const from = Math.max(0, to - STEP + 1);
        let logs = [];
        try { logs = await rpc("robinhood", "eth_getLogs", [{ address: ADDR.poolManager, topics: [T_INIT, id], fromBlock: qty(from), toBlock: qty(to) }], { only: OFFICIAL_RPC, timeoutMs: 20000 }); }
        catch { break; }
        await new Promise((r) => setTimeout(r, 1100)); // the official RPC answers 429 to bursts
        for (const l of logs || []) {
          const [fee, ts, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], l.data);
          v4.keys[id] = { c0: getAddress("0x" + l.topics[2].slice(26)), c1: getAddress("0x" + l.topics[3].slice(26)), fee: Number(fee), ts: Number(ts), hooks: getAddress(hooks), liq: v4.pending.get(id)?.liq || 0 };
          found = true;
        }
        if (from === 0) break;
      }
      if (!found) v4.keys[id] = null;
      v4.pending.delete(id);
      saveKeys();
    }
  } finally { v4.scanning = false; }
  if (v4.pending.size) setTimeout(() => scanV4().catch(() => { v4.scanning = false; }), 5000);
}
const v4Pools = () => Object.entries(v4.keys).filter(([, k]) => k).map(([id, k]) => ({ id, ...k }));

const v3Cache = new Map(); // "a-b-fee" → { addr, at }
async function v3Pools(pairs) {
  const need = [];
  for (const [a, b, fee] of pairs) {
    const k = [lower(a), lower(b)].sort().join("-") + "-" + fee;
    const c = v3Cache.get(k);
    if (!c || Date.now() - c.at > 30 * 60_000) need.push({ k, a, b, fee });
  }
  if (need.length) {
    const res = await readMany(need.map((n) => C(ADDR.v3Factory, iface.v3Factory, "getPool", [n.a, n.b, n.fee])));
    need.forEach((n, i) => { if (res[i]) v3Cache.set(n.k, { addr: res[i][0] === ZERO ? null : res[i][0], at: Date.now() }); });
  }
  return pairs.map(([a, b, fee]) => v3Cache.get([lower(a), lower(b)].sort().join("-") + "-" + fee)?.addr || null);
}
async function candidates(tin, tout, extraHubs = []) {
  const out = [];
  const A = tin === ZERO ? ADDR.weth : tin, B = tout === ZERO ? ADDR.weth : tout;
  if (lower(A) !== lower(B)) {
    const hubs = [ADDR.weth, ADDR.usdg].filter((h) => lower(h) !== lower(A) && lower(h) !== lower(B));
    const pairs = [];
    V3_FEES.forEach((f) => pairs.push([A, B, f]));
    hubs.forEach((h) => V3_FEES.forEach((f) => { pairs.push([A, h, f]); pairs.push([h, B, f]); }));
    const ex = await v3Pools(pairs);
    const has = (a, b, f) => ex[pairs.findIndex((p) => p[0] === a && p[1] === b && p[2] === f)];
    V3_FEES.forEach((f) => { if (has(A, B, f)) out.push({ venue: "v3", hops: [{ a: A, b: B, fee: f }] }); });
    hubs.forEach((h) => V3_FEES.forEach((f1) => { if (!has(A, h, f1)) return; V3_FEES.forEach((f2) => { if (has(h, B, f2)) out.push({ venue: "v3", hops: [{ a: A, b: h, fee: f1 }, { a: h, b: B, fee: f2 }] }); }); }));
  }
  const pools = v4Pools();
  const between = (x, y) => pools.filter((p) => (lower(p.c0) === lower(x) && lower(p.c1) === lower(y)) || (lower(p.c0) === lower(y) && lower(p.c1) === lower(x)));
  const other = (p, x) => (lower(p.c0) === lower(x) ? p.c1 : p.c0);
  for (const p of between(tin, tout)) out.push({ venue: "v4", hops: [{ key: p, from: tin, to: tout }] });
  const hubs4 = [...new Set([ZERO, ADDR.usdg, ...extraHubs].map(lower))].filter((h) => h !== lower(tin) && h !== lower(tout));
  for (const h of hubs4) {
    const l1 = between(tin, h).sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, 3);
    const l2 = between(h, tout).sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, 3);
    for (const p1 of l1) for (const p2 of l2) out.push({ venue: "v4", hops: [{ key: p1, from: tin, to: other(p1, tin) }, { key: p2, from: other(p1, tin), to: tout }] });
  }
  return out;
}
const v3Path = (hops) => solidityPacked(hops.flatMap((h, i) => (i === 0 ? ["address", "uint24", "address"] : ["uint24", "address"])), hops.flatMap((h, i) => (i === 0 ? [h.a, h.fee, h.b] : [h.fee, h.b])));
const poolKey = (k) => ({ currency0: k.c0, currency1: k.c1, fee: k.fee, tickSpacing: k.ts, hooks: k.hooks });
const pathKeys = (hops) => hops.map((h) => ({ intermediateCurrency: h.to, fee: h.key.fee, tickSpacing: h.key.ts, hooks: h.key.hooks, hookData: "0x" }));
function quoteCall(c, amount) {
  if (c.venue === "v3") return RAW(ADDR.quoterV2, iface.quoterV2.encodeFunctionData("quoteExactInput", [v3Path(c.hops), amount]));
  if (c.hops.length === 1) {
    const h = c.hops[0];
    return RAW(ADDR.v4Quoter, iface.v4Quoter.encodeFunctionData("quoteExactInputSingle", [{ poolKey: poolKey(h.key), zeroForOne: lower(h.from) === lower(h.key.c0), exactAmount: amount, hookData: "0x" }]));
  }
  return RAW(ADDR.v4Quoter, iface.v4Quoter.encodeFunctionData("quoteExactInput", [{ exactCurrency: c.hops[0].from, path: pathKeys(c.hops), exactAmount: amount }]));
}
function decodeOut(c, data) {
  if (!data || data.length < 66) return 0n;
  try {
    if (c.venue === "v3") return BigInt(iface.quoterV2.decodeFunctionResult("quoteExactInput", data)[0]);
    return BigInt(iface.v4Quoter.decodeFunctionResult(c.hops.length === 1 ? "quoteExactInputSingle" : "quoteExactInput", data)[0]);
  } catch { return 0n; }
}
const routeLabel = (c) => (c.venue === "v3"
  ? "Uniswap v3 · " + [symOf(c.hops[0].a), ...c.hops.map((h) => symOf(h.b))].join(" → ")
  : "Uniswap v4 · " + [symOf(c.hops[0].from), ...c.hops.map((h) => symOf(h.to))].join(" → "));
const hopsView = (c) => (c.venue === "v3"
  ? c.hops.map((h) => ({ from: symOf(h.a), to: symOf(h.b), feePct: h.fee / 10000 }))
  : c.hops.map((h) => ({ from: symOf(h.from), to: symOf(h.to), feePct: h.key.fee >= 0x800000 ? null : h.key.fee / 10000, hooks: h.key.hooks !== ZERO ? h.key.hooks : null, pons: lower(h.key.hooks) === lower(ADDR.ponsHook) })));

async function routerQuote(tin, tout, amountIn, hubs = []) {
  const cands = await candidates(tin, tout, hubs);
  if (!cands.length) return { ok: false, reason: "No Uniswap v3 or v4 pool connects these two tokens yet." };
  const res = await readMany(cands.map((c) => quoteCall(c, amountIn)), 8);
  const ranked = cands.map((c, i) => ({ c, out: decodeOut(c, res[i]) })).filter((x) => x.out > 0n).sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0));
  if (!ranked.length) return { ok: false, reason: "Every pool reverted for this size: the pools are too thin for this amount." };
  const best = ranked[0];
  const small = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
  const [so] = await readMany([quoteCall(best.c, small)]);
  const smallOut = decodeOut(best.c, so);
  const impact = smallOut > 0n ? Math.max(0, 1 - (Number(best.out) / Number(amountIn)) / (Number(smallOut) / Number(small))) : null;
  return { ok: true, best, ranked, impact };
}
function buildRouterTx(c, tin, tout, amountIn, minOut, deadline) {
  const inEth = tin === ZERO, outEth = tout === ZERO;
  if (c.venue === "v3") {
    const calls = [iface.swapRouter02.encodeFunctionData("exactInput", [{ path: v3Path(c.hops), recipient: outEth ? ADDRESS_THIS : MSG_SENDER, amountIn, amountOutMinimum: minOut }])];
    if (outEth) calls.push(iface.swapRouter02.encodeFunctionData("unwrapWETH9", [minOut]));
    return { to: ADDR.swapRouter02, data: iface.swapRouter02.encodeFunctionData("multicall", [deadline, calls]), value: inEth ? amountIn : 0n,
      approvals: inEth ? [] : [{ kind: "erc20", token: tin, spender: ADDR.swapRouter02, amount: amountIn }] };
  }
  // v4 through UniversalRouter: V4_SWAP → [SWAP_EXACT_IN(_SINGLE), SETTLE_ALL(in), TAKE_ALL(out)]
  let actions, swapParam;
  if (c.hops.length === 1) {
    const h = c.hops[0];
    actions = "0x060c0f";
    swapParam = coder.encode([`(${POOLKEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`],
      [{ poolKey: poolKey(h.key), zeroForOne: lower(h.from) === lower(h.key.c0), amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  } else {
    actions = "0x070c0f";
    swapParam = coder.encode([`(address currencyIn,${PATHKEY}[] path,uint256[] minHopPriceX36,uint128 amountIn,uint128 amountOutMinimum)`],
      [{ currencyIn: tin, path: pathKeys(c.hops), minHopPriceX36: [], amountIn, amountOutMinimum: minOut }]);
  }
  const settle = coder.encode(["address", "uint256"], [tin, amountIn]);
  const take = coder.encode(["address", "uint256"], [tout, minOut]);
  const input = coder.encode(["bytes", "bytes[]"], [actions, [swapParam, settle, take]]);
  return { to: ADDR.universalRouter, data: iface.ur.encodeFunctionData("execute", ["0x10", [input], deadline]), value: inEth ? amountIn : 0n,
    approvals: inEth ? [] : [{ kind: "erc20", token: tin, spender: ADDR.permit2, amount: amountIn }, { kind: "permit2", token: tin, spender: ADDR.universalRouter, amount: amountIn }] };
}

/* ------------------------------------------------------------------ */
/* quotes                                                              */
/* ------------------------------------------------------------------ */

let marketMod = null;
const ethUsdNow = async () => { try { marketMod ||= await import("./market.mjs"); return await marketMod.getEthUsd(); } catch { return null; } };
// pool depth: the market board first; a coin outside the board (e.g. a graduated v4 pool GeckoTerminal has not listed)
// falls back to the single-token read (DexScreener, cached 30 s), capped at 2.5 s so a quote is never held up by it
const liquidityFor = async (token) => {
  try {
    marketMod ||= await import("./market.mjs");
    const row = marketMod.indexRow?.(token) || null;
    if (row?.liquidityUsd) return row;
    const one = await Promise.race([marketMod.getRobinhoodToken(token).then((r) => r?.token || null).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 2500))]);
    return one?.liquidityUsd ? one : row;
  } catch { return null; }
};

/**
 * quoteSwap({ tokenIn, tokenOut, amountIn | amountInRaw, slippageBps, from? }) — any pair on Robinhood Chain.
 * tokenIn/tokenOut: "ETH" or a 0x address. Returns the best route plus a `plan` buildSwapTx turns into calldata.
 */
// Server-side limits (the app offers up to 5%; the API must not be looser than the app). Internal simulations (the Gate's
// test sell) pass _sim to go wider; nothing a client sends can.
export const MAX_SLIPPAGE_BPS = Math.max(10, Math.min(5000, Number(process.env.MAX_SLIPPAGE_BPS) || 500));
export const capSlippage = (bps, sim = false) => Math.min(sim ? 5000 : MAX_SLIPPAGE_BPS, Math.max(1, Math.round(Number(bps) || 100)));
// A client may ask for MORE price protection than the quote's own minimum, never less (minOut=0 is ignored).
export function floorMinOut(quoteMin, requested, sim = false) {
  const q = BigInt(quoteMin);
  if (requested == null || requested === "") return q;
  let r;
  try { r = BigInt(requested); } catch { throw new HttpError(400, "minOutRaw must be a whole number of token units."); }
  if (sim) return r < 0n ? 0n : r;
  return r > q ? r : q;
}
// KyberSwap fallback quote. Impact = how much worse the full size fills than a 1% probe; fees and spread come from the probe's
// USD values when Kyber prices both sides. The plan carries Kyber's own route; buildSwapTx turns it into calldata on the server.
async function kyberQuote(tin, tout, amt, coin, ethUsd, warnings, light = false) {
  const probeAmt = amt / 100n > 0n ? amt / 100n : 1n;
  // light (the Gate's own test sell): only the route and the amount out are needed, so skip the probe and the round trip
  const [full, probe] = await Promise.all([
    kyberRoute({ tokenIn: tin, tokenOut: tout, amountIn: amt }),
    light ? null : kyberRoute({ tokenIn: tin, tokenOut: tout, amountIn: probeAmt }).catch(() => null),
  ]);
  // round trips tell fees from impact: a small one loses about twice the fees and taxes, a full-size one twice the fees
  // plus twice the impact (one-sided probes and USD prices are too noisy for young coins)
  let impact = null, feePct = null;
  if (probe && probe.out > 0n) {
    const [backP, backF] = await Promise.all([
      kyberRoute({ tokenIn: tout, tokenOut: tin, amountIn: probe.out }).catch(() => null),
      kyberRoute({ tokenIn: tout, tokenOut: tin, amountIn: full.out }).catch(() => null),
    ]);
    const rt = (back, a) => (back && back.out > 0n ? Math.max(0, 1 - Number((back.out * 1000000n) / a) / 1000000) : null);
    ({ feePct, impact } = splitLoss(rt(backP, probeAmt), rt(backF, amt)));
  }
  const row = await liquidityFor(coin || tout);
  const depthEth = row?.liquidityUsd && ethUsd ? row.liquidityUsd / ethUsd / 2 : null;
  const via = full.exchanges.join(" + ");
  return {
    out: full.out, priceImpact: impact, feePct, feeNote: feePct != null ? "half of a small round trip" : null, venue: "kyberswap",
    route: { venue: "kyberswap", label: `KyberSwap · ${symOf(tin)} → ${symOf(tout)} via ${via}`, hops: full.paths.map((leg) => ({ from: symOf(leg[0]?.tokenIn || tin), to: symOf(leg[leg.length - 1]?.tokenOut || tout), venue: leg.map((x) => x.exchange).join(" → ") })) },
    depth: { eth: depthEth, usd: row?.liquidityUsd ?? null, note: depthEth != null ? "ETH side of the main pool (GeckoTerminal reserve / 2)" : "Pool depth not indexed" },
    plan: { venue: "kyber", routeSummary: full.routeSummary, router: full.router },
  };
}
export async function quoteSwap({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps = 100, from, _sim = false }) {
  const tin = isNative(tokenIn) ? ZERO : addr(tokenIn, "input token");
  const tout = isNative(tokenOut) ? ZERO : addr(tokenOut, "output token");
  if (lower(tin) === lower(tout)) throw new HttpError(400, "Pick two different tokens.");
  const [mi, mo] = await Promise.all([metaOf(tin), metaOf(tout)]);
  const amt = amountInRaw != null && amountInRaw !== "" ? BigInt(amountInRaw) : parseAmount(amountIn, mi.decimals);
  if (amt <= 0n) throw new HttpError(400, "Enter a positive amount.");
  const slip = capSlippage(slippageBps, _sim);
  const side = tin === ZERO ? "buy" : tout === ZERO ? "sell" : "swap";
  const warnings = [];
  if (!_sim && Math.round(Number(slippageBps) || 0) > MAX_SLIPPAGE_BPS) warnings.push(`Slippage is capped at ${MAX_SLIPPAGE_BPS / 100}% on this server.`);
  const ethUsd = await ethUsdNow();
  const base = { chain: "robinhood", chainId: CHAIN_ID, side, tokenIn: tin === ZERO ? NATIVE : pub(mi), tokenOut: tout === ZERO ? NATIVE : pub(mo), slippageBps: slip, ethUsd };
  const finish = (o) => {
    const minOut = (o.out * BigInt(10000 - slip)) / 10000n;
    if (o.priceImpact != null && o.priceImpact > 0.05) warnings.push(`Price impact is ${(o.priceImpact * 100).toFixed(1)}%. A smaller amount gets a better price.`);
    if (o.feePct != null && o.feePct > 5) warnings.push(`This route charges about ${o.feePct.toFixed(1)}% in fees and taxes.`);
    return {
      ...base,
      amountIn: fmt(amt, mi.decimals), amountInRaw: amt.toString(),
      amountOut: fmt(o.out, mo.decimals), amountOutRaw: o.out.toString(), minOut: fmt(minOut, mo.decimals), minOutRaw: minOut.toString(),
      rate: Number(fmt(o.out, mo.decimals)) / Number(fmt(amt, mi.decimals)),
      priceImpact: o.priceImpact, feePct: o.feePct, feeNote: o.feeNote || null, venue: o.venue, route: o.route, poolLiquidity: o.depth,
      alternatives: o.alternatives || [], warnings, plan: o.plan, quotedAt: Date.now(),
    };
  };

  // ETH ⇄ WETH
  if ((tin === ZERO && lower(tout) === lower(ADDR.weth)) || (lower(tin) === lower(ADDR.weth) && tout === ZERO)) {
    return finish({ out: amt, priceImpact: 0, feePct: 0, venue: "wrap", route: { venue: "wrap", label: tin === ZERO ? "Wrap ETH → WETH" : "Unwrap WETH → ETH", hops: [] }, depth: { eth: null, note: "WETH contract" }, plan: { venue: "wrap", tin, tout } });
  }

  // Pons coin still on its bonding curve
  const coin = side === "buy" ? tout : side === "sell" ? tin : null;
  const ps = await ponsState(coin || (await isPonsEither(tin, tout)), from && isAddress(from) ? getAddress(from) : ZERO).catch(() => null);
  if (ps && !ps.graduated) {
    const buying = lower(ps.token) === lower(tout);
    const counter = buying ? tin : tout;
    if (lower(counter) !== lower(ps.pair)) {
      const want = ps.pair === ZERO ? "ETH" : ps.pairSymbol;
      throw new HttpError(400, `${symOf(ps.token)} is still on its Pons curve, which trades against ${want}. ${buying ? `Pay with ${want}` : `Sell it for ${want}`}${ps.pair !== ZERO ? ` (swap ETH ⇄ ${want} first)` : ""}.`, { code: "CURVE_PAIR" });
    }
    const pp = ponsPublic(ps);
    const feePct = Number(ps.feeBps + ps.taxBps) / 100;
    const depth = { eth: ps.pair === ZERO ? Number(fmt(ps.realQuote, 18)) : null, pair: Number(fmt(ps.realQuote, ps.pairDecimals)), pairSymbol: ps.pairSymbol, note: "Raised on the Pons curve so far" };
    if (pp.progressPct != null && pp.progressPct > 90) warnings.push(`The curve is ${pp.progressPct.toFixed(0)}% full: it graduates to Uniswap v4 soon.`);
    if (buying) {
      const q = curveBuyQuote(ps, amt);
      if (q.out <= 0n) throw new HttpError(409, "This curve is sold out: the coin is graduating to Uniswap v4.");
      if (q.capped) warnings.push("This buy fills the rest of the curve; the unused part of your payment stays with the curve rules.");
      if (q.snipeBps > 0n) warnings.push(`Launch snipe tax is active (${(Number(q.snipeBps) / 100).toFixed(1)}%) for the first seconds after launch.`);
      return finish({ out: q.out, priceImpact: q.impact, feePct: feePct + Number(q.snipeBps) / 100, venue: "pons-curve",
        route: { venue: "pons-curve", label: `Pons curve · ${symOf(tin)} → ${symOf(ps.token)}`, curve: ps.curve, pons: pp, hops: [{ from: symOf(tin), to: symOf(ps.token), feePct }] },
        depth, plan: { venue: "pons-curve", side: "buy", curve: ps.curve, pair: ps.pair, token: ps.token } });
    }
    const q = curveSellQuote(ps, amt);
    if (q.out <= 0n) throw new HttpError(409, "Nothing to receive for this size on the curve.");
    return finish({ out: q.out, priceImpact: q.impact, feePct, venue: "pons-curve",
      route: { venue: "pons-curve", label: `Pons curve · ${symOf(ps.token)} → ${symOf(tout)}`, curve: ps.curve, pons: pp, hops: [{ from: symOf(ps.token), to: symOf(tout), feePct }] },
      depth, plan: { venue: "pons-curve", side: "sell", curve: ps.curve, pair: ps.pair, token: ps.token } });
  }

  // Uniswap v3 / v4 (graduated Pons coins route through their Pons-hook pool)
  const hubs = ps?.graduated && ps.pair !== ZERO ? [ps.pair] : [];
  const r = await routerQuote(tin, tout, amt, hubs);
  if (!r.ok) {
    // not on a Pons curve or a Uniswap pool Troya can reach: ask KyberSwap (Long.xyz, Bankr, Frontier, Virtuals, Ramses, Aerodrome …)
    const kq = KYBER_ON ? await kyberQuote(tin, tout, amt, coin, ethUsd, warnings, _sim).catch(() => null) : null;
    if (kq) return finish(kq);
    throw new HttpError(404, `${r.reason} Troya routes Pons curves and Uniswap v3/v4 pools on Robinhood Chain, plus the other Robinhood Chain venues through KyberSwap.`, { code: "NO_ROUTE" });
  }
  const c = r.best.c;
  let feePct = c.venue === "v3" ? c.hops.reduce((s, h) => s + h.fee / 10000, 0) : c.hops.reduce((s, h) => s + (h.key.fee < 0x800000 ? h.key.fee / 10000 : 0), 0);
  if (ps?.graduated) feePct += Number(ps.feeBps + ps.taxBps) / 100; // the Pons hook keeps the 1% fee + creator tax after graduation
  // best execution: when Troya's own route is poor (a thin or odd pool: big impact or fees), ask KyberSwap too and take
  // whichever gives more. A healthy Pons or Uniswap route is kept as it is.
  if (KYBER_ON && ((r.impact ?? 0) > 0.02 || feePct > 3)) {
    const kq = await kyberQuote(tin, tout, amt, coin, ethUsd, warnings, _sim).catch(() => null);
    if (kq && kq.out * 1000n > r.best.out * 1005n) return finish(kq);
  }
  const row = await liquidityFor(coin || tout);
  const depthEth = row?.liquidityUsd && ethUsd ? row.liquidityUsd / ethUsd / 2 : null;
  return finish({
    out: r.best.out, priceImpact: r.impact, feePct, venue: c.venue === "v3" ? "uniswap-v3" : "uniswap-v4",
    route: { venue: c.venue === "v3" ? "uniswap-v3" : "uniswap-v4", label: routeLabel(c), hops: hopsView(c), pons: ps ? ponsPublic(ps) : null },
    depth: { eth: depthEth, usd: row?.liquidityUsd ?? null, note: depthEth != null ? "ETH side of the main pool (GeckoTerminal reserve / 2)" : "Pool depth not indexed" },
    alternatives: r.ranked.slice(1, 5).map((x) => ({ venue: x.c.venue === "v3" ? "uniswap-v3" : "uniswap-v4", label: routeLabel(x.c), amountOut: fmt(x.out, mo.decimals) })),
    plan: { venue: c.venue, c },
  });
}
// for token ⇄ token swaps: is either side a Pons coin? (returns the address or ZERO)
async function isPonsEither(a, b) {
  for (const x of [a, b]) { if (x === ZERO) continue; const s = await ponsState(x).catch(() => null); if (s) return x; }
  return ZERO;
}

/**
 * buildSwapTx({ from, tokenIn, tokenOut, amountIn | amountInRaw, slippageBps, minOutRaw? })
 * → { chainId, from, to, data, value, deadline, quote, approvals:[{kind,token,spender,amount,needed,tx}], approval }
 * Always re-quotes on the server: calldata is never built from a client-supplied route.
 */
export async function buildSwapTx({ from, tokenIn, tokenOut, amountIn, amountInRaw, minOutRaw, slippageBps, deadlineSec = 1200, _quote, _sim = false, _gate = false }) {
  const who = addr(from, "wallet address");
  const q = _quote?.plan ? _quote : await quoteSwap({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps, from: who });
  const amt = BigInt(q.amountInRaw);
  const min = floorMinOut(q.minOutRaw, minOutRaw, _sim);
  const deadline = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(3600, Number(deadlineSec) || 1200));
  const tin = q.tokenIn.address === "native" ? ZERO : q.tokenIn.address, tout = q.tokenOut.address === "native" ? ZERO : q.tokenOut.address;
  let built;
  const p = q.plan;
  if (p.venue === "wrap") {
    built = tin === ZERO ? { to: ADDR.weth, data: iface.weth.encodeFunctionData("deposit", []), value: amt, approvals: [] }
      : { to: ADDR.weth, data: iface.weth.encodeFunctionData("withdraw", [amt]), value: 0n, approvals: [] };
  } else if (p.venue === "pons-curve") {
    if (p.side === "buy") {
      built = { to: p.curve, data: iface.ponsCurve.encodeFunctionData("buy", [amt, min, who]), value: p.pair === ZERO ? amt : 0n,
        approvals: p.pair === ZERO ? [] : [{ kind: "erc20", token: p.pair, spender: p.curve, amount: amt }] };
    } else {
      built = { to: p.curve, data: iface.ponsCurve.encodeFunctionData("sell", [amt, min, who]), value: 0n, approvals: [{ kind: "erc20", token: p.token, spender: p.curve, amount: amt }] };
    }
  } else if (p.venue === "kyber") {
    if (!KYBER_LIVE && !_sim && !_gate) throw new HttpError(403, "Swaps through KyberSwap (for coins outside Pons and Uniswap) are switched off on this server right now. The Gate result still works.", { code: "KYBER_TESTING" });
    // slippage that lands Kyber's own minimum at or above Troya's floor (the quote's minimum, or a stricter one from the client)
    const quoted = BigInt(p.routeSummary.amountOut);
    const slip = quoted > min ? Number(((quoted - min) * 10000n) / quoted) : 1;
    const kb = await kyberBuild({ routeSummary: p.routeSummary, router: p.router, sender: who, slippageBps: Math.max(1, slip), deadline });
    built = { to: kb.to, data: kb.data, value: kb.value, approvals: tin === ZERO ? [] : [{ kind: "erc20", token: tin, spender: kb.to, amount: amt, name: "KyberSwap" }] };
    if (tin === ZERO && kb.value !== amt) throw new HttpError(502, "KyberSwap asked for a different ETH amount than quoted, so the swap was not built.");
  } else {
    built = buildRouterTx(p.c, tin, tout, amt, min, deadline);
  }
  const approvals = await approvalTxs(who, built.approvals);
  const first = approvals.find((a) => a.needed);
  return {
    chainId: CHAIN_ID, from: who, to: built.to, data: built.data, value: built.value.toString(), deadline, quote: q,
    approvals, approval: first || { needed: false },
  };
}
async function approvalTxs(owner, specs) {
  if (!specs?.length) return [];
  const reads = await readMany(specs.map((a) => (a.kind === "erc20"
    ? C(a.token, iface.erc20, "allowance", [owner, a.spender])
    : C(ADDR.permit2, iface.permit2, "allowance", [owner, a.token, a.spender]))));
  const now = Math.floor(Date.now() / 1000);
  return specs.map((a, i) => {
    if (a.kind === "erc20") {
      const allowance = BigInt(reads[i]?.[0] ?? 0n);
      return { kind: "erc20", token: a.token, spender: a.spender, amount: a.amount.toString(), allowance: allowance.toString(), needed: allowance < a.amount,
        label: `Approve ${symOf(a.token)} for ${a.name || (a.spender === ADDR.permit2 ? "Permit2" : a.spender === ADDR.swapRouter02 ? "Uniswap" : "the Pons curve")}`,
        tx: { to: a.token, data: iface.erc20.encodeFunctionData("approve", [a.spender, a.amount]), value: "0" } };
    }
    const amount = BigInt(reads[i]?.[0] ?? 0n), exp = Number(reads[i]?.[1] ?? 0);
    const expiration = now + 30 * 60;
    return { kind: "permit2", token: a.token, spender: a.spender, amount: a.amount.toString(), allowance: amount.toString(), needed: amount < a.amount || exp < now + 120,
      label: `Allow Uniswap to spend ${symOf(a.token)} through Permit2 (30 min)`,
      tx: { to: ADDR.permit2, data: iface.permit2.encodeFunctionData("approve", [a.token, a.spender, a.amount, expiration]), value: "0" } };
  });
}

/* ------------------------------------------------------------------ */
/* Troya Gate: simulations before signing                              */
/* ------------------------------------------------------------------ */

const SIM_WALLET = "0x7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a"; // no key exists for this; used only inside eth_call
async function touchedKeys(contract, data) {
  // Nitro charges gas even here, so the throwaway sender gets a balance through the state-override argument.
  // The official RPC does not serve eth_createAccessList, so ask the mirrors that do.
  const params = [{ from: SIM_WALLET, to: contract, data, gas: "0x1e84800" }, "latest", { [SIM_WALLET]: { balance: qty(10n ** 20n) } }];
  let lastErr;
  for (const url of CHAINS.robinhood.upstreams.filter((u) => u !== OFFICIAL_RPC)) {
    try {
      const r = await rpc("robinhood", "eth_createAccessList", params, { only: url });
      const entry = (r?.accessList || []).find((x) => lower(x.address) === lower(contract));
      return entry?.storageKeys || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("No upstream serves eth_createAccessList");
}
/** simulateTx({from,to,data,value}, overrides?) → { ok, returnData?, error? } — eth_call only, never sent. */
export async function simulateTx(tx, overrides) {
  const from = tx.from ? addr(tx.from, "from") : SIM_WALLET;
  const ov = { [from]: { balance: qty(BigInt(tx.value || 0) + 10n ** 20n) }, ...(overrides || {}) };
  try {
    const ret = await rpc("robinhood", "eth_call", [{ from, to: tx.to, data: tx.data, value: qty(tx.value), gas: "0x1c9c380" }, "latest", ov]);
    return { ok: true, returnData: ret };
  } catch (e) {
    return { ok: false, error: e.message || "reverted", data: e.data || null };
  }
}
/**
 * transferTaxProbe(token, amountRaw) — the tax a token takes on transfer, measured directly. Inside one eth_call,
 * Multicall3 is handed the tokens through a state override, sends them to the Uniswap v4 PoolManager (where a v4 sell
 * delivers them) and to a fresh wallet, and reads what arrived. Used when a router's return value does not report the
 * amount out (the Universal Router returns nothing) and when the test sell could not run.
 * → { pct, toPool, toWallet } (percent lost; null where that transfer reverted), { pct: null, blocked: true } when no
 * transfer goes through at all, or null when the balance storage cannot be found.
 */
const SIM_WALLET_2 = "0x7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0b"; // no key exists for this either
export async function transferTaxProbe(token, amountRaw, extra = []) {
  const t = addr(token, "token address"), amt = BigInt(amountRaw), MC = ADDR.multicall3;
  if (amt <= 0n) return null;
  const keys = await touchedKeys(t, iface.erc20.encodeFunctionData("balanceOf", [MC]));
  if (!keys.length) return null;
  const bal = (a) => ({ target: t, allowFailure: true, callData: iface.erc20.encodeFunctionData("balanceOf", [a]) });
  const send = (a) => ({ target: t, allowFailure: true, callData: iface.erc20.encodeFunctionData("transfer", [a, amt]) });
  const to = [ADDR.poolManager, SIM_WALLET_2, ...extra.filter(Boolean)];
  const calls = to.flatMap((a) => [bal(a), send(a), bal(a)]);
  const ov = { [t]: { stateDiff: Object.fromEntries(keys.map((k) => [k, toBeHex(amt * BigInt(to.length + 1), 32)])) } };
  const raw = await rpc("robinhood", "eth_call", [{ to: MC, data: iface.mc.encodeFunctionData("aggregate3", [calls]), gas: "0x1c9c380" }, "latest", ov]);
  const res = iface.mc.decodeFunctionResult("aggregate3", raw)[0];
  const lost = (i) => {
    const [b0, tx, b1] = [res[i], res[i + 1], res[i + 2]];
    if (!b0.success || !tx.success || !b1.success) return null;
    if (tx.returnData && tx.returnData !== "0x" && BigInt(tx.returnData) === 0n) return null;   // transfer() said false
    const got = BigInt(b1.returnData) - BigInt(b0.returnData);
    return got >= amt ? 0 : (Number(amt - got) / Number(amt)) * 100;
  };
  const each = to.map((_, i) => lost(i * 3));
  if (each.every((x) => x == null)) return { pct: null, blocked: true };   // every transfer reverted or said false
  return { pct: Math.max(...each.map((x) => x ?? 0)), toPool: each[0], toWallet: each[1], toOthers: each.slice(2) };
}
/**
 * sellCheck({ token, amountRaw, to? }) — a throwaway address gets the tokens + approvals inside an eth_call and sells
 * them back (to ETH unless `to` is given) through the best route. Reveals honeypots and transfer tax.
 */
// the v3 pool a sell starts in (a token that taxes transfers into its own pool shows up when the probe sends there)
async function firstV3Pool(q) {
  const h = q?.plan?.venue === "v3" ? q.plan.c?.hops?.[0] : null;
  if (!h) return null;
  const r = await ethCall(ADDR.v3Factory, iface.v3Factory.encodeFunctionData("getPool", [h.a, h.b, h.fee]));
  const p = iface.v3Factory.decodeFunctionResult("getPool", r)[0];
  return p && p !== ZeroAddress ? p : null;
}
export async function sellCheck({ token, amountRaw, to = "ETH", _recheck = true }) {
  const t = addr(token, "token address");
  let amt = BigInt(amountRaw);
  if (amt <= 0n) throw new HttpError(400, "Nothing to sell.");
  // A Pons curve can only pay out the quote buyers actually put in (realQuoteReserve). Right after launch that is close to
  // nothing, so selling a whole simulated buy back into the curve as it is now reverts, although the buyer's own ETH would
  // cover it. Test-sell what the curve can take today instead (constant product: out = x·Q/(T+x) ≤ real → x ≤ real·T/(Q−real)),
  // and say so plainly when it can take nothing yet.
  let partial = false;
  const ps = await ponsState(t).catch(() => null);
  if (ps && !ps.graduated && ps.quoteReserve > ps.realQuote) {
    const maxTok = (ps.realQuote * ps.tokenReserve) / (ps.quoteReserve - ps.realQuote);
    if (ps.realQuote < 10n ** 12n || maxTok <= 0n) return { ok: false, unknown: true, thin: true, reason: "The curve holds no buyers' ETH right now (no buys yet, or every buyer sold), so there is nothing to test a sell against." };
    if (amt > (maxTok * 9n) / 10n) { amt = (maxTok * 9n) / 10n; partial = true; }
  }
  const q = await quoteSwap({ tokenIn: t, tokenOut: to, amountInRaw: amt.toString(), slippageBps: 5000, from: SIM_WALLET, _sim: true });
  const b = await buildSwapTx({ from: SIM_WALLET, _quote: q, minOutRaw: "0", _sim: true });
  const diff = {};
  const balKeys = await touchedKeys(t, iface.erc20.encodeFunctionData("balanceOf", [SIM_WALLET]));
  if (!balKeys.length) return { ok: false, unknown: true, quote: q, reason: "Could not locate the token's balance storage, so the test sell was skipped." };
  for (const k of balKeys) diff[k] = toBeHex(amt * 2n, 32);
  const overrides = {};
  for (const a of b.approvals) {
    if (a.kind === "erc20") {
      for (const k of await touchedKeys(t, iface.erc20.encodeFunctionData("allowance", [SIM_WALLET, a.spender]))) diff[k] = toBeHex(2n ** 255n, 32);
    } else {
      const keys = await touchedKeys(ADDR.permit2, iface.permit2.encodeFunctionData("allowance", [SIM_WALLET, t, a.spender]));
      const packed = (BigInt(2 ** 40) << 160n) | (2n ** 160n - 1n); // amount = max uint160, expiration far in the future, nonce 0
      overrides[ADDR.permit2] = { stateDiff: Object.fromEntries(keys.map((k) => [k, toBeHex(packed, 32)])) };
    }
  }
  overrides[t] = { stateDiff: diff };
  const sim = await simulateTx({ from: SIM_WALLET, to: b.to, data: b.data, value: "0" }, overrides);
  if (!sim.ok) return { ok: false, sellable: false, quote: q, reason: `The test sell reverted: ${sim.error}` };
  let actual = null;
  try {
    if (q.venue === "pons-curve") actual = BigInt(iface.ponsCurve.decodeFunctionResult("sell", sim.returnData)[0]);
    else if (q.venue === "uniswap-v3") actual = BigInt(coder.decode(["uint256"], iface.swapRouter02.decodeFunctionResult("multicall", sim.returnData)[0][0])[0]);
    else if (q.venue === "kyberswap") actual = BigInt(coder.decode(["uint256", "uint256"], sim.returnData)[0]); // swap() → (returnAmount, gasUsed)
  } catch {}
  const quoted = BigInt(q.amountOutRaw);
  let taxPct = actual != null && quoted > 0n ? Math.max(0, 1 - Number(actual) / Number(quoted)) * 100 : null, taxVia = taxPct != null ? "sell" : null;
  // the Universal Router (Uniswap v4) returns nothing, so measure the transfer itself
  if (taxPct == null) { const p = await transferTaxProbe(t, amt).catch(() => null); if (p?.pct != null) { taxPct = p.pct; taxVia = "transfer"; } }
  else if (taxPct > 0.5 && _recheck) {
    // the quote and its simulation can land on different blocks (a trade in between reads as "tax"). Before calling it
    // a tax: measure the transfer itself (into the pool too), and if that shows none, measure the sell once more
    const p = await transferTaxProbe(t, amt, [await firstV3Pool(q).catch(() => null)]).catch(() => null);
    if (p?.pct != null && p.pct > 0.5) { taxPct = Math.max(taxPct, p.pct); taxVia = "transfer"; }
    else {
      const again = await sellCheck({ token: t, amountRaw: amt.toString(), to, _recheck: false }).catch(() => null);
      if (again?.transferTaxPct != null) taxPct = Math.min(taxPct, again.transferTaxPct);
    }
  }
  return { ok: true, sellable: true, partial, quote: q, actualOut: actual != null ? fmt(actual, q.tokenOut.decimals) : null, quotedOut: q.amountOut, outSymbol: q.tokenOut.symbol, transferTaxPct: taxPct, transferTaxVia: taxVia };
}

/**
 * gateCheck({ tokenIn, tokenOut, amountIn|amountInRaw, from, slippageBps }) → { pass, checks:[{key,status,label,detail}], quote, tx }
 * status: pass | warn | fail | skip
 */
export async function gateCheck({ tokenIn, tokenOut, amountIn, amountInRaw, from, slippageBps = 100 }) {
  const checks = [];
  const add = (key, status, label, detail) => checks.push({ key, status, label, detail });
  let q;
  try { q = await quoteSwap({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps, from }); add("route", "pass", "Route", q.route.label); }
  catch (e) { add("route", "fail", "Route", e.message); return { pass: false, checks }; }
  const imp = q.priceImpact;
  add("impact", imp == null ? "skip" : imp > 0.15 ? "fail" : imp > 0.05 ? "warn" : "pass", "Price impact", imp == null ? "Not measurable" : `${(imp * 100).toFixed(2)}%`);
  const d = q.poolLiquidity || {};
  if (q.venue === "wrap") add("depth", "skip", "Pool depth", "Not a pool: the WETH contract");
  else if (d.eth != null) add("depth", d.eth < 0.05 ? "fail" : d.eth < 0.5 ? "warn" : "pass", "Pool depth", `${d.eth < 1 ? d.eth.toFixed(3) : d.eth.toFixed(2)} ETH${q.venue === "pons-curve" ? " raised on the curve" : ""}`);
  else if (d.pair != null) add("depth", "pass", "Pool depth", `${d.pair.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${d.pairSymbol} raised on the curve`);
  else add("depth", "skip", "Pool depth", d.note || "Not indexed");
  if (q.feePct != null) add("fee", q.feePct > 10 ? "fail" : q.feePct > 5 ? "warn" : "pass", "Fees and taxes", `${q.feePct.toFixed(2)}%${q.feeNote ? ` (${q.feeNote})` : ""}`);
  let tx = null;
  try {
    tx = await buildSwapTx({ from: from && isAddress(from) ? from : SIM_WALLET, _quote: q, _gate: true });
    if (!tx.approvals.some((a) => a.needed)) {
      const sim = await simulateTx({ from: tx.from, to: tx.to, data: tx.data, value: tx.value });
      add("sim", sim.ok ? "pass" : "fail", "Transaction simulation", sim.ok ? "The exact swap succeeds against the current pool" : sim.error);
    } else add("sim", "skip", "Transaction simulation", "Runs after the approval; the test sell below covers the route");
  } catch (e) { add("sim", "fail", "Transaction simulation", e.message); }
  // test sell of what a buy returns (or of the amount being sold)
  const coin = q.side === "buy" ? q.tokenOut.address : q.side === "sell" ? q.tokenIn.address : null;
  // WETH and USDG (Paxos, with freeze and pause controls) are major tokens: a test sell says nothing useful about
  // them and USDG's controls make the simulation revert, so they skip it, as stablecoins do on Base and Arbitrum
  const major = coin && [lower(ADDR.weth), lower(ADDR.usdg)].includes(lower(coin));
  if (major) { add("sell", "skip", "Test sell", "A major token (USDG or WETH): no test sell needed"); add("tax", "skip", "Transfer tax", "A major token: none expected"); }
  else if (coin && coin !== "native" && q.venue !== "wrap") {
    const sellAmt = q.side === "buy" ? q.amountOutRaw : q.amountInRaw;
    try {
      const sc = await sellCheck({ token: coin, amountRaw: sellAmt });
      // when the test sell cannot tell, the transfer itself is still measured
      const probeTax = async () => {
        const p = await transferTaxProbe(coin, sellAmt).catch(() => null);
        if (!p) return add("tax", "skip", "Transfer tax", "Not measured");
        if (p.blocked) return add("tax", "warn", "Transfer tax", "A plain transfer reverts, to the pool and to a wallet: trading may be paused, limited or blocked");
        add("tax", p.pct > 10 ? "fail" : p.pct > 0.5 ? "warn" : "pass", "Transfer tax", p.pct > 0.5 ? `About ${p.pct.toFixed(1)}% is lost on transfer` : "None on a transfer to the pool or to a wallet");
      };
      if (sc.unknown) { add("sell", "skip", "Test sell", sc.reason); await probeTax(); }
      else if (!sc.sellable) { add("sell", "fail", "Test sell", sc.reason); await probeTax(); }
      else {
        add("sell", "pass", "Test sell", sc.partial
          ? `A partial sell goes through (${sc.actualOut != null ? Number(sc.actualOut).toPrecision(4) + " " + sc.outSymbol : "succeeds"}); the young curve can't take a full one yet`
          : sc.actualOut != null ? `Selling back returns ${Number(sc.actualOut).toPrecision(5)} ${sc.outSymbol}` : "Selling back succeeds");
        const tax = sc.transferTaxPct;
        add("tax", tax == null ? "skip" : tax > 10 ? "fail" : tax > 0.5 ? "warn" : "pass", "Transfer tax", tax == null ? "Not measured on this route" : tax > 0.5 ? `About ${tax.toFixed(1)}% is lost on transfer` : sc.transferTaxVia === "transfer" ? "None on a transfer to the pool or to a wallet" : "None detected");
      }
    } catch (e) { add("sell", "warn", "Test sell", e.message); add("tax", "skip", "Transfer tax", "Not measured"); }
  }
  // a Kyber route is simulated above, but nobody gets its calldata to sign until KYBER_LIVE is on
  if (q.venue === "kyberswap" && !KYBER_LIVE) tx = null;
  return { pass: !checks.some((c) => c.status === "fail"), checks, quote: q, tx, checkedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* token health (heuristic)                                            */
/* ------------------------------------------------------------------ */

const SIGS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"],
  pause: ["pause()", "unpause()", "setPaused(bool)"],
  blacklist: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "addBot(address)", "setBots(address[],bool)", "isBlacklisted(address)"],
  fees: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxes(uint256,uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "updateFees(uint256,uint256)", "setTaxFee(uint256)"],
  limits: ["setMaxTxAmount(uint256)", "setMaxWallet(uint256)", "setMaxWalletSize(uint256)", "updateMaxTxnAmount(uint256)"],
  trading: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "startTrading()"],
  owner: ["owner()", "transferOwnership(address)", "renounceOwnership()"],
};
const sel = (s) => selectorId(s).slice(2, 10);
const SEL = Object.fromEntries(Object.entries(SIGS).map(([k, v]) => [k, v.map((s) => ({ sig: s, sel: sel(s) }))]));
const hasSel = (code, s) => code.includes("63" + s);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export async function tokenHealth(address) {
  const a = addr(address, "token address");
  const code = String(await rpc("robinhood", "eth_getCode", [a, "latest"]) || "0x").toLowerCase();
  if (code === "0x") return { address: a, isContract: false, risk: "high", flags: [{ level: "risk", text: "There is no contract at this address on Robinhood Chain." }], heuristic: true };
  const flags = [];
  let proxy = null, impl = code;
  const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
  if (clone) {
    proxy = { type: "EIP-1167 clone", implementation: getAddress("0x" + clone[1]) };
    impl = String(await rpc("robinhood", "eth_getCode", [proxy.implementation, "latest"]) || "0x").toLowerCase();
  } else {
    const slot = await rpc("robinhood", "eth_getStorageAt", [a, IMPL_SLOT, "latest"]).catch(() => null);
    if (slot && BigInt(slot) !== 0n) {
      proxy = { type: "EIP-1967 upgradeable proxy", implementation: getAddress("0x" + slot.slice(-40)) };
      impl = String(await rpc("robinhood", "eth_getCode", [proxy.implementation, "latest"]) || "0x").toLowerCase();
      flags.push({ level: "warn", key: "upgradeable", text: "Upgradeable proxy: whoever controls it can change the token's code." });
    }
  }
  const found = Object.fromEntries(Object.entries(SEL).map(([k, v]) => [k, v.filter((x) => hasSel(impl, x.sel)).map((x) => x.sig)]));
  const [meta, ps, own] = await Promise.all([
    tokenMeta(a).catch(() => null),
    ponsState(a).catch(() => null),
    readMany([C(a, iface.erc20, "owner")]).then((r) => r[0]?.[0] ?? null).catch(() => null),
  ]);
  const ownerAddr = own ? getAddress(own) : null;
  const renounced = ownerAddr ? /^0x0{38}(00|01)$/i.test(ownerAddr) || lower(ownerAddr) === "0x000000000000000000000000000000000000dead" : null;
  const kind = ps ? "pons" : STOCKS.some((s) => lower(s.address) === lower(a)) ? "stock" : "unknown";
  if (kind === "pons") {
    flags.push({ level: "info", key: "template", text: `Pons Family launch: fixed supply from the Pons token template, ${ps.graduated ? "graduated to a Uniswap v4 pool with the Pons hook" : `trading on its bonding curve (${ponsPublic(ps).progressPct?.toFixed(1)}% to graduation)`}.` });
    const tax = Number(ps.taxBps) / 100;
    flags.push({ level: tax > 5 ? "warn" : "info", key: "creatorTax", text: tax > 0 ? `Creator tax ${tax.toFixed(2)}% on every trade, on top of the 1% Pons fee.` : "No creator tax; only the 1% Pons fee applies." });
  }
  if (kind === "stock") flags.push({ level: "info", key: "stock", text: "Tokenized stock on Robinhood Chain (an approved Pons pair asset)." });
  if (found.mint.length) flags.push({ level: kind === "pons" ? "info" : "risk", key: "mint", text: `Has a mint function (${found.mint[0]}): supply may be increased by whoever is allowed to call it.` });
  if (found.pause.length) flags.push({ level: "warn", key: "pause", text: "Transfers can be paused." });
  if (found.blacklist.length) flags.push({ level: "risk", key: "blacklist", text: "Has blacklist / bot-list functions: some wallets can be blocked from selling." });
  if (found.fees.length) flags.push({ level: "warn", key: "fees", text: "Fees or taxes can be changed by the owner." });
  if (found.limits.length) flags.push({ level: "warn", key: "limits", text: "Max transaction or wallet limits can be set." });
  if (found.trading.length) flags.push({ level: "warn", key: "trading", text: "Trading can be switched on (and possibly off) by the owner." });
  if (ownerAddr && !renounced && (found.mint.length || found.pause.length || found.blacklist.length || found.fees.length)) flags.push({ level: "warn", key: "owner", text: `An owner is set (${ownerAddr.slice(0, 10)}…) and holds the controls above.` });
  if (ownerAddr && renounced) flags.push({ level: "info", key: "renounced", text: "Ownership is renounced." });
  const risks = flags.filter((f) => f.level === "risk").length, warns = flags.filter((f) => f.level === "warn").length;
  return {
    address: a, isContract: true, kind, proxy, owner: ownerAddr, ownerRenounced: renounced,
    name: meta?.name ?? null, symbol: meta?.symbol ?? null, decimals: meta?.decimals ?? null, totalSupply: meta?.totalSupply ?? null,
    codeSize: (impl.length - 2) / 2, functions: found, pons: ponsPublic(ps),
    flags, risk: risks ? "high" : warns >= 2 ? "medium" : warns ? "low-medium" : "low",
    heuristic: true, note: "Bytecode heuristics, not an audit. A clean result does not make a token safe.",
  };
}
/** on-chain profile of a Pons coin (logo, description, socials) */
export async function ponsProfile(token) {
  const t = addr(token, "token address");
  const r = await readMany([C(t, iface.ponsToken, "logo"), C(t, iface.ponsToken, "description"), C(t, iface.ponsToken, "socials")]);
  if (!r[0] && !r[1] && !r[2]) return null;
  const s = r[2] || [];
  return { logo: r[0]?.[0] || null, description: r[1]?.[0] || null, twitter: s[0] || null, telegram: s[1] || null, discord: s[2] || null, website: s[3] || null, farcaster: s[4] || null };
}

/* ------------------------------------------------------------------ */
/* balances                                                            */
/* ------------------------------------------------------------------ */

export async function getBalances(address, extraTokens = []) {
  const a = addr(address, "wallet address");
  const tokens = [...new Set([ADDR.weth, ADDR.usdg, ...extraTokens.filter((t) => isAddress(t)).map((t) => getAddress(t))].map(lower))].slice(0, 40).map((t) => getAddress(t));
  const r = await readMany([C(ADDR.multicall3, iface.mc, "getEthBalance", [a]), ...tokens.map((t) => C(t, iface.erc20, "balanceOf", [a]))]);
  const eth = BigInt(r[0]?.[0] ?? 0n);
  const out = [{ ...NATIVE, raw: eth.toString(), amount: formatUnits(eth, 18) }];
  const metas = await Promise.all(tokens.map((t) => tokenMeta(t).catch(() => null)));
  tokens.forEach((t, i) => {
    const raw = r[i + 1] ? BigInt(r[i + 1][0]) : null;
    if (raw == null || !metas[i]) return;
    if (raw === 0n && !extraTokens.some((x) => lower(x) === lower(t))) return;
    out.push({ address: t, symbol: metas[i].symbol, name: metas[i].name, decimals: metas[i].decimals, raw: raw.toString(), amount: formatUnits(raw, metas[i].decimals) });
  });
  return { chain: "robinhood", chainId: CHAIN_ID, address: a, balances: out, at: Date.now() };
}

/* ------------------------------------------------------------------ */
/* bridge (LI.FI)                                                      */
/* ------------------------------------------------------------------ */

const LIFI = "https://li.quest/v1";
export const LIFI_CHAINS = { 1: "Ethereum", 42161: "Arbitrum", 8453: "Base", 4663: "Robinhood Chain" };
async function lifi(p) {
  const res = await fetch(`${LIFI}${p}`, { headers: { accept: "application/json", "user-agent": "troya-agent/0.2" }, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new HttpError(502, `LI.FI answered ${res.status} with something unexpected.`); }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, json?.message ? `No route: ${json.message}` : `LI.FI ${res.status}`);
  return json;
}
export async function bridgeQuote({ fromChain, toChain = CHAIN_ID, address, amountWei }) {
  fromChain = Number(fromChain); toChain = Number(toChain || CHAIN_ID);
  if (!LIFI_CHAINS[fromChain] || !LIFI_CHAINS[toChain] || fromChain === toChain) throw new HttpError(400, "Unsupported chain pair.");
  if (fromChain !== CHAIN_ID && toChain !== CHAIN_ID) throw new HttpError(400, "One side of the bridge must be Robinhood Chain.");
  const who = addr(address, "wallet address");
  const amount = BigInt(amountWei || 0);
  if (amount <= 0n) throw new HttpError(400, "Enter a positive amount.");
  const q = await lifi(`/quote?fromChain=${fromChain}&toChain=${toChain}&fromToken=${ZERO}&toToken=${ZERO}&fromAddress=${who}&toAddress=${who}&fromAmount=${amount}&integrator=troya-agent&slippage=0.01`);
  const e = q.estimate || {}, tx = q.transactionRequest;
  if (!tx?.to || !tx?.data) throw new HttpError(502, "The route came back without a transaction to sign.");
  const usd = (l) => (l || []).reduce((s, x) => s + (Number(x?.amountUSD) || 0), 0);
  return {
    fromChain, toChain, fromName: LIFI_CHAINS[fromChain], toName: LIFI_CHAINS[toChain], tool: String(q.toolDetails?.name || q.tool || "unknown"),
    fromAmount: String(amount), toAmount: String(e.toAmount || 0), toAmountMin: String(e.toAmountMin || 0),
    fromSymbol: q.action?.fromToken?.symbol || "ETH", toSymbol: q.action?.toToken?.symbol || "ETH",
    executionSec: Number(e.executionDuration || 0), feeUsd: usd(e.feeCosts), gasUsd: usd(e.gasCosts),
    tx: { to: tx.to, data: tx.data, value: String(BigInt(tx.value || 0)), gasLimit: String(BigInt(tx.gasLimit || 400000)), chainId: Number(tx.chainId || fromChain) },
  };
}

/* Fund Hyperliquid: ETH on Robinhood Chain → USDC on the user's own Hyperliquid account, one LI.FI transaction.
   LI.FI calls Hyperliquid (HyperCore) chain 1337 and lists perps USDC under the Arbitrum USDC address. The route is
   checked to deliver that token to the expected account before anything is returned for signing. */
export const HL_CHAIN = 1337;
const HL_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export async function hlFundQuote({ address, amountWei, toAddress }) {
  const from = addr(address, "wallet address");
  const to = toAddress ? addr(toAddress, "Hyperliquid account") : from;
  const amount = BigInt(amountWei || 0);
  if (amount <= 0n) throw new HttpError(400, "Enter a positive amount.");
  const q = await lifi(`/quote?fromChain=${CHAIN_ID}&toChain=${HL_CHAIN}&fromToken=${ZERO}&toToken=${HL_USDC}&fromAddress=${from}&toAddress=${to}&fromAmount=${amount}&integrator=troya-agent&slippage=0.01`);
  const e = q.estimate || {}, tx = q.transactionRequest, a = q.action || {};
  if (!tx?.to || !tx?.data) throw new HttpError(502, "The route came back without a transaction to sign.");
  if (Number(tx.chainId || CHAIN_ID) !== CHAIN_ID) throw new HttpError(502, "The route asked for a transaction on another chain.");
  if (Number(a.toChainId) !== HL_CHAIN || String(a.toToken?.address || "").toLowerCase() !== HL_USDC.toLowerCase()) throw new HttpError(502, "The route does not end in USDC on Hyperliquid.");
  if (String(a.toAddress || to).toLowerCase() !== to.toLowerCase()) throw new HttpError(502, "The route would deliver to a different account.");
  const usd = (l) => (l || []).reduce((s, x) => s + (Number(x?.amountUSD) || 0), 0);
  return {
    fromChain: CHAIN_ID, toChain: HL_CHAIN, fromName: "Robinhood Chain", toName: "Hyperliquid", toAddress: to, tool: String(q.toolDetails?.name || q.tool || "unknown"),
    fromAmount: String(amount), toAmount: String(e.toAmount || 0), toAmountMin: String(e.toAmountMin || 0), toDecimals: Number(a.toToken?.decimals ?? 6),
    fromSymbol: "ETH", toSymbol: "USDC", executionSec: Number(e.executionDuration || 0), feeUsd: usd(e.feeCosts), gasUsd: usd(e.gasCosts), toAmountUsd: Number(e.toAmountUSD || 0),
    tx: { to: tx.to, data: tx.data, value: String(BigInt(tx.value || 0)), gasLimit: String(BigInt(tx.gasLimit || 600000)), chainId: CHAIN_ID },
  };
}

/* ------------------------------------------------------------------ */
/* Pons launch                                                         */
/* ------------------------------------------------------------------ */

let menuCache = null;
export async function launchMenu(fresh = false) {
  if (!fresh && menuCache && Date.now() - menuCache.at < 60_000) return menuCache.v;
  const F = ADDR.ponsFactory;
  const head = await readMany([C(F, iface.ponsFactory, "launchFee"), C(F, iface.ponsFactory, "launchEnabled"), C(F, iface.ponsFactory, "launchConfigCount"),
    C(F, iface.ponsFactory, "maxCreatorTaxBps"), C(F, iface.ponsFactory, "snipeTaxStartBps"), C(F, iface.ponsFactory, "snipeTaxSeconds")]);
  if (head.slice(0, 3).some((x) => x == null)) throw new HttpError(502, "The Pons factory did not answer. Try again in a moment.");
  const n = Math.min(Number(head[2][0]), 20);
  const cfg = await readMany(Array.from({ length: n }, (_, i) => C(F, iface.ponsFactory, "getLaunchConfig", [i])));
  const configs = cfg.map((x, id) => (x ? {
    id, supply: fmt(x[0].supply, 18), curveFeeBps: Number(x[0].curveFeeBps), phantomQuoteEth: Number(fmt(x[0].phantomQuote, 18)),
    graduationEth: Number(fmt(x[0].graduationThreshold, 18)), poolFee: Number(x[0].poolFee), tickSpacing: Number(x[0].tickSpacing), enabled: Boolean(x[0].enabled),
  } : null)).filter((c) => c && c.enabled);
  const v = {
    factory: F, launchFeeWei: String(head[0][0]), launchFeeEth: Number(fmt(head[0][0], 18)), launchEnabled: Boolean(head[1][0]),
    maxCreatorTaxBps: Number(head[3]?.[0] ?? 1000), snipeTaxStartBps: Number(head[4]?.[0] ?? 0), snipeTaxSeconds: Number(head[5]?.[0] ?? 0),
    configs, creatorShareOfCurveFee: 0.7,
  };
  menuCache = { at: Date.now(), v };
  return v;
}
const SITE_URL = () => (process.env.SITE_URL || "").replace(/\/+$/, "");
/**
 * buildLaunchTx({ creator, name, symbol, logo, description, website, twitter, telegram, creatorTaxBps, configId?, feeRecipient? })
 * feeRecipient: where creator fees go (default the creator; launches from an Agent Wallet send them to the owner's wallet)
 * → Pons launchToken tx (ETH pair, creator exempt from the launch snipe tax) + an eth_call simulation. Nothing is sent.
 */
export async function buildLaunchTx(o = {}) {
  const creator = addr(o.creator, "creator wallet");
  const clip = (v, n) => String(v ?? "").trim().slice(0, n);
  const name = clip(o.name, 64), symbol = clip(o.symbol, 16);
  if (!name || !symbol) throw new HttpError(400, "The coin needs a name and a symbol.");
  if (Buffer.byteLength(name) > 64 || Buffer.byteLength(symbol) > 16) throw new HttpError(400, "Name is limited to 64 bytes and symbol to 16 bytes.");
  const logo = clip(o.logo, 512);
  if (logo && !/^(https:\/\/|ipfs:\/\/)/.test(logo)) throw new HttpError(400, "The logo must be an https:// or ipfs:// link (or upload an image).");
  const menu = await launchMenu();
  if (!menu.launchEnabled) throw new HttpError(409, "Pons has paused launches right now.");
  const cfg = menu.configs.find((c) => c.id === Number(o.configId ?? menu.configs[0]?.id));
  if (!cfg) throw new HttpError(400, "Pons has no open launch option right now.");
  const tax = Math.max(0, Math.min(menu.maxCreatorTaxBps, Math.round(Number(o.creatorTaxBps) || 0)));
  const [econ, can] = await readMany([C(ADDR.ponsFactory, iface.ponsFactory, "previewLaunchEconomics", [cfg.id, ZERO]), C(ADDR.ponsFactory, iface.ponsFactory, "canLaunch", [creator])]);
  if (!econ) throw new HttpError(502, "Could not read the launch economics from the Pons factory.");
  if (can && can[0] === false) throw new HttpError(403, "The Pons factory does not allow this wallet to launch right now.");
  const salt = hexlify(randomBytes(32));
  const params = {
    name, symbol, logo, description: clip(o.description, 2048),
    socials: { twitter: clip(o.twitter, 256), telegram: clip(o.telegram, 256), discord: "", website: clip(o.website, 256), farcaster: "" },
    creatorFeeRecipient: o.feeRecipient ? addr(o.feeRecipient, "fee recipient") : creator, creatorTaxBps: tax, buybackEnabled: false, expectedEconomics: econ[0], salt,
  };
  // the creator is exempt from the 3-second launch snipe tax, so their own first buy right after launch pays the normal fee
  const data = iface.ponsFactory.encodeFunctionData("launchToken", [params, cfg.id, ZERO, [creator]]);
  const value = BigInt(menu.launchFeeWei);
  const bal = BigInt(await rpc("robinhood", "eth_getBalance", [creator, "latest"]));
  const sim = await simulateTx({ from: creator, to: ADDR.ponsFactory, data, value: value.toString() });
  let token = null, curve = null;
  if (sim.ok) { try { [token, curve] = iface.ponsFactory.decodeFunctionResult("launchToken", sim.returnData); } catch {} }
  return {
    chainId: CHAIN_ID, from: creator, to: ADDR.ponsFactory, data, value: value.toString(),
    launchFeeWei: menu.launchFeeWei, config: cfg, creatorTaxBps: tax, salt,
    predicted: token ? { token, curve, ponsUrl: PONS_SITE + lower(token) } : null,
    balanceWei: bal.toString(), enoughBalance: bal > value,
    simulation: { ok: sim.ok, error: sim.ok ? null : sim.error },
  };
}
// logo hosting for launches: the image is stored on this server and its https URL goes on chain
const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const saveLaunchLogo = (buf, type) => saveLogo(buf, type);
async function saveLogo(buf, type) {
  const ext = LOGO_TYPES[type];
  if (!ext) throw new HttpError(415, "Upload a PNG, JPEG, GIF or WebP image.");
  if (buf.length > 1024 * 1024) throw new HttpError(413, "The image is over 1 MB.");
  const sniff = buf[0] === 0x89 && buf[1] === 0x50 ? "png" : buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : buf.subarray(0, 3).toString() === "GIF" ? "gif" : buf.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (sniff !== ext) throw new HttpError(415, "The file content does not match an image of that type.");
  const name = createHash("sha256").update(buf).digest("hex").slice(0, 32) + "." + ext;
  const dir = path.join(DATA_DIR, "logos");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buf);
  const base = SITE_URL();
  return { file: name, url: `${base || ""}/api/launch/logo/${name}`, permanent: /^https:\/\//.test(base), note: /^https:\/\//.test(base) ? null : "This server has no public https address (SITE_URL), so the logo link only works locally. Use an ipfs:// or https:// link for a real launch." };
}

/* ------------------------------------------------------------------ */
/* relay                                                               */
/* ------------------------------------------------------------------ */

const ALLOWED = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionCount", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_sendRawTransaction", "eth_getLogs", "eth_syncing",
]);
const sendBuckets = new Map();
function sendLimited(ip) {
  const now = Date.now();
  let b = sendBuckets.get(ip);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; sendBuckets.set(ip, b); }
  return ++b.n > 30;
}
const headCache = {};
async function headBlock(chain) {
  const h = headCache[chain];
  if (h && Date.now() - h.at < 3000) return h.n;
  const n = Number(BigInt(await rpc(chain, "eth_blockNumber", [])));
  headCache[chain] = { at: Date.now(), n };
  return n;
}
export async function checkCall(chain, c, ip) {
  const fail = (code, message) => ({ jsonrpc: "2.0", id: c?.id ?? null, error: { code, message } });
  if (!c || typeof c !== "object" || typeof c.method !== "string") return fail(-32600, "Invalid request");
  if (!ALLOWED.has(c.method)) return fail(-32601, `Method ${c.method} is not available through the Troya relay.`);
  const params = Array.isArray(c.params) ? c.params : [];
  if (c.method === "eth_sendRawTransaction" && process.env.TROYA_NO_BROADCAST === "1") return fail(-32000, "Broadcasting is switched off on this server (TROYA_NO_BROADCAST). Nothing was sent.");
  if (c.method === "eth_sendRawTransaction" && sendLimited(ip)) return fail(-32005, "Too many transactions from this address, wait a minute.");
  if (c.method === "eth_getLogs") {
    const f = params[0] || {};
    if (!f.address && !f.blockHash) return fail(-32602, "eth_getLogs needs an address filter.");
    if (!f.blockHash) {
      const head = await headBlock(chain);
      const num = (x) => (x == null || x === "latest" || x === "pending" ? head : x === "earliest" ? 0 : Number(BigInt(x)));
      if (num(f.toBlock) - num(f.fromBlock) > 50_000) return fail(-32602, "eth_getLogs range is limited to 50,000 blocks.");
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

// Base and Arbitrum (F11) live in evmswap.mjs; the same /api/swap/* routes take ?chain=base|arbitrum
const isEvm = (c) => c === "base" || c === "arbitrum";
let evmMod = null;
const evm = () => (evmMod ||= import("./evmswap.mjs"));
// Solana (F12) lives in solana.mjs; the same routes take ?chain=solana
const isSol = (c) => c === "solana";
let solMod = null;
const sol = () => (solMod ||= import("./solana.mjs"));
export async function register(r, ctx) {
  DATA_DIR = ctx.dataDir;
  try { v4.keys = JSON.parse(await readFile(path.join(DATA_DIR, "v4keys.json"), "utf8")) || {}; } catch { v4.keys = {}; }

  for (const chain of Object.keys(CHAINS)) {
    r.post(`/api/rpc/${chain}`, async ({ body, res, ip }) => {
      const batch = Array.isArray(body);
      const calls = batch ? body : [body];
      if (!calls.length || calls.length > 25) throw new HttpError(400, "Send between 1 and 25 calls per batch.");
      const pre = await Promise.all(calls.map((c) => checkCall(chain, c, ip)));
      const pass = calls.map((c, i) => (pre[i] ? null : { jsonrpc: "2.0", id: c.id ?? i, method: c.method, params: Array.isArray(c.params) ? c.params : [] }));
      const todo = pass.filter(Boolean);
      let answers = [];
      if (todo.length) {
        const hasSend = todo.some((c) => c.method === "eth_sendRawTransaction");
        const out = await forward(chain, todo.length === 1 ? todo[0] : todo, { noRetry: hasSend });
        answers = Array.isArray(out) ? out : [out];
      }
      const byId = new Map(answers.map((a) => [JSON.stringify(a?.id), a]));
      const merged = calls.map((c, i) => pre[i] || byId.get(JSON.stringify(pass[i].id)) || { jsonrpc: "2.0", id: c.id ?? null, error: { code: -32603, message: "No answer from upstream" } });
      send(res, 200, batch ? merged : merged[0]);
    }, { perMin: 1200, maxBody: 512 * 1024 });
  }

  const slipOf = (query) => query.slippageBps ?? (query.slippage ? Number(query.slippage) * 100 : 100);
  r.get("/api/swap/quote", ({ query }) => isSol(query.chain) ? sol().then((m) => m.solQuote({ tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, slippageBps: slipOf(query) })) : isEvm(query.chain) ? evm().then((m) => m.evmQuote({ chain: query.chain, tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, slippageBps: slipOf(query) })) : quoteSwap({ tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, slippageBps: slipOf(query), from: query.from }), { perMin: 240 });
  r.post("/api/swap/build", ({ body }) => { const b = body || {}; if (isSol(b.chain)) return sol().then((m) => m.solBuild({ from: b.from, tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountIn: b.amountIn, amountInRaw: b.amountInRaw, slippageBps: b.slippageBps })); if (isEvm(b.chain)) return evm().then((m) => m.evmBuild({ chain: b.chain, from: b.from, tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountIn: b.amountIn, amountInRaw: b.amountInRaw, minOutRaw: b.minOutRaw, slippageBps: b.slippageBps })); return buildSwapTx({ from: b.from, tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountIn: b.amountIn, amountInRaw: b.amountInRaw, minOutRaw: b.minOutRaw, slippageBps: b.slippageBps }); }, { perMin: 120 });
  r.get("/api/swap/gate", ({ query }) => isSol(query.chain) ? sol().then((m) => m.solGate({ tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, from: query.from, slippageBps: slipOf(query) })) : isEvm(query.chain) ? evm().then((m) => m.evmGate({ chain: query.chain, tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, from: query.from, slippageBps: slipOf(query) })) : gateCheck({ tokenIn: query.tokenIn || query.in, tokenOut: query.tokenOut || query.out, amountIn: query.amountIn ?? query.amount, amountInRaw: query.amountInRaw, from: query.from, slippageBps: slipOf(query) }), { perMin: 90 });

  r.get("/api/token/health", ({ query }) => tokenHealth(query.address), { perMin: 120 });
  r.get("/api/token/meta", ({ query }) => isSol(query.chain) ? sol().then((m) => m.solTokenMeta(query.address)) : isEvm(query.chain) ? evm().then((m) => m.evmTokenMeta(query.chain, query.address)) : tokenMeta(query.address).then(pub), { perMin: 240 });
  r.get("/api/swap/tokens", ({ query }) => (isSol(query.chain) ? sol().then((m) => m.solSearch({ q: query.q })) : evm().then((m) => m.evmSearch({ chain: query.chain, q: query.q }))), { perMin: 120 });
  // which F11/F12 pieces are open for signing on this server (each opens after its real-money test)
  r.get("/api/features", async () => {
    const [e, so] = await Promise.all([evm(), sol()]);
    // Hyperliquid spot passed its real-money test on 16 Nov 2026 (bought 0.25 HYPE, sold 0.24 back); SPOT_LIVE=0 closes it
    return { arbitrum: e.evmLive("arbitrum"), base: e.evmLive("base"), solana: so.SOLANA_LIVE, spot: process.env.SPOT_LIVE !== "0" };
  });
  r.get("/api/sol/balance", ({ query }) => sol().then((m) => m.solBalance({ owner: query.owner, mint: query.mint })), { perMin: 240 });
  r.get("/api/sol/status", ({ query }) => sol().then((m) => m.solStatus({ sig: query.sig })), { perMin: 240 });
  r.get("/api/token/pons", async ({ query }) => {
    const s = await ponsState(query.address, query.account && isAddress(query.account) ? getAddress(query.account) : ZERO);
    return s ? { pons: true, ...ponsPublic(s), profile: await ponsProfile(s.token).catch(() => null) } : { pons: false };
  }, { perMin: 240 });
  r.get("/api/chain/balances", ({ query }) => getBalances(query.address, String(query.tokens || "").split(",").filter(Boolean)), { perMin: 240 });

  r.get("/api/launch/menu", ({ query }) => launchMenu(query.fresh === "1"), { perMin: 120 });
  r.post("/api/launch/build", ({ body }) => buildLaunchTx(body || {}), { perMin: 60 });
  r.post("/api/launch/logo", async ({ req, body }) => {
    if (!Buffer.isBuffer(body)) throw new HttpError(400, "Send the image bytes with an image content-type.");
    return saveLogo(body, String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase());
  }, { perMin: 20, maxBody: 1100 * 1024 });
  r.get("/api/launch/logo/:file", async ({ params, res }) => {
    const f = String(params.file || "");
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(f)) throw new HttpError(404, "Not found");
    const p = path.join(DATA_DIR, "logos", f);
    try { await stat(p); } catch { throw new HttpError(404, "Not found"); }
    const ext = f.split(".").pop();
    res.writeHead(200, { "content-type": ext === "jpg" ? "image/jpeg" : `image/${ext}`, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
    res.end(await readFile(p));
  }, { weight: 0.2, perMin: 3000 });

  r.get("/api/bridge/chains", () => ({ chains: Object.entries(LIFI_CHAINS).map(([id, name]) => ({ id: Number(id), name })), home: CHAIN_ID }));
  r.get("/api/bridge/quote", ({ query }) => bridgeQuote({ fromChain: query.fromChain, toChain: query.toChain, address: query.address, amountWei: query.amountWei }), { perMin: 60 });
  // Fund Hyperliquid from your own wallet: always to the same address on Hyperliquid
  r.get("/api/bridge/hl-quote", ({ query }) => hlFundQuote({ address: query.address, amountWei: query.amountWei }), { perMin: 60 });
  r.get("/api/bridge/status", async ({ query }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(query.txHash || "")) throw new HttpError(400, "Bad transaction hash.");
    const st = await lifi(`/status?txHash=${query.txHash}&fromChain=${Number(query.fromChain)}&toChain=${Number(query.toChain || CHAIN_ID)}`);
    return { status: String(st.status || "PENDING"), substatus: st.substatus || null, receiving: st.receiving?.txHash || null };
  }, { perMin: 120 });
}
