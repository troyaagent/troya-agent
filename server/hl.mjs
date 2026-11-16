// Hyperliquid: read-only info proxy (cached) + exchange signing helpers used by the Agent Wallet.
// Signing follows Hyperliquid's L1 action scheme: keccak(msgpack(action) ‖ nonce u64 BE ‖ vault flag [‖ expiresAfter])
// → "phantom agent" {source, connectionId} signed as EIP-712 under domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}.
import { encode } from "@msgpack/msgpack";
import { Wallet, keccak256, getBytes, concat, toBeHex, zeroPadValue, Signature, getAddress, isAddress } from "ethers";

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

// tiny TTL cache with in-flight de-duplication
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl) return hit.p;
  const p = fn().catch((e) => { if (cache.get(key)?.p === p) cache.delete(key); throw e; });
  cache.set(key, { t: now, p });
  if (cache.size > 800) for (const [k, v] of cache) if (now - v.t > 120_000) cache.delete(k);
  return p;
}

// perps meta + live contexts, merged into one list
export async function hlMeta() {
  return cached("meta", 5000, async () => {
    const [meta, ctxs] = await hlInfo({ type: "metaAndAssetCtxs" });
    const markets = meta.universe.map((u, i) => {
      const c = ctxs[i] || {};
      const mark = +c.markPx || null, prev = +c.prevDayPx || null;
      return {
        asset: i, coin: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
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
    return { markets, time: Date.now() };
  });
}
export async function hlAsset(coin) {
  const { markets } = await hlMeta();
  const m = markets.find((x) => x.coin.toUpperCase() === String(coin).toUpperCase());
  if (!m) throw new HlError(404, `Hyperliquid has no perp market called ${coin}.`);
  return m;
}
export async function hlUserState(address) {
  if (!isAddress(address)) throw new HlError(400, "That is not a valid address.");
  const user = getAddress(address).toLowerCase();
  return cached(`user:${user}`, 2500, async () => {
    const [ch, orders, fills, spot] = await Promise.all([
      hlInfo({ type: "clearinghouseState", user }),
      hlInfo({ type: "frontendOpenOrders", user }).catch(() => []),
      hlInfo({ type: "userFills", user }).catch(() => []),
      hlInfo({ type: "spotClearinghouseState", user }).catch(() => ({ balances: [] })),
    ]);
    const positions = (ch.assetPositions || []).map((p) => p.position).filter(Boolean).map((p) => ({
      coin: p.coin, size: +p.szi, entryPx: +p.entryPx || null, positionValue: +p.positionValue || 0,
      unrealizedPnl: +p.unrealizedPnl || 0, returnOnEquity: +p.returnOnEquity || 0, liquidationPx: p.liquidationPx != null ? +p.liquidationPx : null,
      marginUsed: +p.marginUsed || 0, leverage: p.leverage?.value ?? null, leverageType: p.leverage?.type ?? null, maxLeverage: p.maxLeverage ?? null,
      funding: p.cumFunding ? +p.cumFunding.sinceOpen : null,
    }));
    return {
      address: user,
      accountValue: +ch.marginSummary?.accountValue || 0,
      totalMarginUsed: +ch.marginSummary?.totalMarginUsed || 0,
      totalNtlPos: +ch.marginSummary?.totalNtlPos || 0,
      withdrawable: +ch.withdrawable || 0,
      unrealizedPnl: positions.reduce((a, p) => a + p.unrealizedPnl, 0),
      positions,
      openOrders: (orders || []).slice(0, 100).map((o) => ({
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
  r.get("/api/hl/meta", async () => hlMeta());

  r.get("/api/hl/mids", async () => cached("mids", 2000, () => hlInfo({ type: "allMids" })));

  r.get("/api/hl/candles", async ({ query }) => {
    const coin = String(query.coin || "BTC").toUpperCase();
    const interval = INTERVALS[query.interval] ? query.interval : "1h";
    const end = Date.now();
    const from = Number(query.from) > 0 ? Number(query.from) : end - INTERVALS[interval] * 400;
    const start = Math.max(from, end - INTERVALS[interval] * 2000);
    await hlAsset(coin);
    const bucket = Math.floor(end / Math.min(INTERVALS[interval], 60e3));
    const rows = await cached(`candles:${coin}:${interval}:${Math.floor(start / INTERVALS[interval])}:${bucket}`, 4000,
      () => hlInfo({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } }));
    return { coin, interval, candles: (rows || []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v, n: c.n })) };
  }, { weight: 2 });

  r.get("/api/hl/book", async ({ query }) => {
    const coin = String(query.coin || "BTC").toUpperCase();
    // spot books (F12) are "@<index>" or "PURR/USDC"; anything else must be a known perp
    if (!/^@\d{1,5}$|^[A-Z0-9]{1,12}\/USDC$/.test(coin)) await hlAsset(coin);
    const b = await cached(`book:${coin}`, 1000, () => hlInfo({ type: "l2Book", coin }));
    const side = (lv) => (lv || []).slice(0, 20).map((x) => ({ px: +x.px, sz: +x.sz, n: x.n }));
    return { coin, time: b?.time || Date.now(), bids: side(b?.levels?.[0]), asks: side(b?.levels?.[1]) };
  });

  r.get("/api/hl/user", async ({ query }) => {
    if (!query.address) throw new HlError(400, "Pass ?address=0x…");
    return hlUserState(query.address);
  }, { weight: 2 });

  // Relay for payloads already signed in the browser (CSP keeps the page same-origin).
  // We only forward; keys never reach this server. Shape is checked so it cannot be used as an open proxy.
  const RELAY_TYPES = new Set(["order", "cancel", "updateLeverage", "approveAgent", "scheduleCancel", "modify", "batchModify", "usdClassTransfer", "withdraw3"]);
  r.post("/api/hl/exchange", async ({ body }) => {
    const a = body?.action;
    if (!a || typeof a !== "object" || !RELAY_TYPES.has(a.type)) throw new HlError(400, "Unsupported Hyperliquid action.");
    if (!Number.isSafeInteger(body.nonce) || Math.abs(body.nonce - Date.now()) > 24 * 3600e3) throw new HlError(400, "Bad nonce.");
    const s = body.signature;
    if (!s || !/^0x[0-9a-fA-F]{1,64}$/.test(String(s.r)) || !/^0x[0-9a-fA-F]{1,64}$/.test(String(s.s)) || ![27, 28].includes(Number(s.v))) throw new HlError(400, "Bad signature.");
    if (a.type === "order" && (!Array.isArray(a.orders) || a.orders.length < 1 || a.orders.length > 10)) throw new HlError(400, "Bad order list.");
    const payload = { action: a, nonce: body.nonce, signature: { r: s.r, s: s.s, v: Number(s.v) }, vaultAddress: body.vaultAddress || null };
    return postExchange(payload);
  }, { weight: 3, perMin: 120, maxBody: 32 * 1024 });

  // which trading keys (agents) this account has approved on Hyperliquid
  r.get("/api/hl/agents", async ({ query }) => {
    if (!isAddress(query.address || "")) throw new HlError(400, "Pass ?address=0x…");
    const user = getAddress(query.address).toLowerCase();
    const list = await cached(`agents:${user}`, 3000, () => hlInfo({ type: "extraAgents", user }));
    return { address: user, agents: (list || []).map((a) => ({ name: a.name, address: a.address, validUntil: a.validUntil ?? null })) };
  });
}
