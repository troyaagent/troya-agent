// Browser Hyperliquid client: msgpack + L1 action signing, a local trade-only key the user approves once,
// and order / cancel / leverage actions. Signed payloads go through our relay (/api/hl/exchange) because
// the page's CSP only allows same-origin requests; the relay never sees a private key.
// No DOM access at import time, so this file also runs in Node for the signing tests.
import { Wallet, keccak256, getBytes, concat, toBeHex, zeroPadValue, Signature, getAddress } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_DECIMALS_PERP = 6;

/* ---------------- msgpack (subset Hyperliquid actions use) ---------------- */
// Matches @msgpack/msgpack / Python msgpack: smallest int encoding, float64 for non-integers, str8 for 32–255 bytes.
export function msgpackEncode(value) {
  const out = [];
  const u8 = (n) => out.push(n & 0xff);
  const u16 = (n) => { u8(n >> 8); u8(n); };
  const u32 = (n) => { u8(n >>> 24); u8(n >>> 16); u8(n >>> 8); u8(n); };
  const u64 = (n) => { const b = BigInt.asUintN(64, BigInt(n)); for (let i = 7; i >= 0; i--) u8(Number((b >> BigInt(i * 8)) & 0xffn)); };
  const enc = new TextEncoder();
  const write = (v) => {
    if (v === null || v === undefined) return u8(0xc0);
    if (v === true) return u8(0xc3);
    if (v === false) return u8(0xc2);
    if (typeof v === "number") {
      if (Number.isSafeInteger(v)) {
        if (v >= 0) {
          if (v < 0x80) return u8(v);
          if (v < 0x100) { u8(0xcc); return u8(v); }
          if (v < 0x10000) { u8(0xcd); return u16(v); }
          if (v < 0x100000000) { u8(0xce); return u32(v); }
          u8(0xcf); return u64(v);
        }
        if (v >= -0x20) return u8(0xe0 | (v + 0x20));
        if (v >= -0x80) { u8(0xd0); return u8(v); }
        if (v >= -0x8000) { u8(0xd1); return u16(v); }
        if (v >= -0x80000000) { u8(0xd2); return u32(v); }
        u8(0xd3); return u64(v);
      }
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, v);
      u8(0xcb);
      for (let i = 0; i < 8; i++) u8(dv.getUint8(i));
      return;
    }
    if (typeof v === "bigint") { if (v >= 0n) { u8(0xcf); return u64(v); } u8(0xd3); return u64(v); }
    if (typeof v === "string") {
      const b = enc.encode(v);
      if (b.length < 32) u8(0xa0 | b.length);
      else if (b.length < 0x100) { u8(0xd9); u8(b.length); }
      else if (b.length < 0x10000) { u8(0xda); u16(b.length); }
      else { u8(0xdb); u32(b.length); }
      for (const x of b) out.push(x);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length < 16) u8(0x90 | v.length);
      else if (v.length < 0x10000) { u8(0xdc); u16(v.length); }
      else { u8(0xdd); u32(v.length); }
      for (const x of v) write(x);
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length < 16) u8(0x80 | keys.length);
      else if (keys.length < 0x10000) { u8(0xde); u16(keys.length); }
      else { u8(0xdf); u32(keys.length); }
      for (const k of keys) { write(k); write(v[k]); }
      return;
    }
    throw new Error(`Cannot encode ${typeof v}`);
  };
  write(value);
  return new Uint8Array(out);
}

/* ---------------- wire formatting ---------------- */
export function floatToWire(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Bad number: ${x}`);
  let s = n.toFixed(8);
  if (Math.abs(Number(s) - n) >= 1e-12) throw new Error(`Too many decimals: ${x}`);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
export function roundPx(px, szDecimals, maxDecimals = MAX_DECIMALS_PERP) {
  const n = Number(px);
  if (!(n > 0)) throw new Error("Price must be above zero.");
  if (Number.isInteger(n)) return n;
  return Number(Number(n.toPrecision(5)).toFixed(Math.max(0, maxDecimals - szDecimals)));
}
export function roundSz(sz, szDecimals) { const f = 10 ** szDecimals; return Math.floor(Number(sz) * f + 1e-9) / f; }
const typeWire = (t) => t.limit ? { limit: { tif: t.limit.tif } } : { trigger: { isMarket: !!t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
export function orderWire({ asset, isBuy, limitPx, size, reduceOnly = false, orderType }) {
  return { a: asset, b: !!isBuy, p: floatToWire(limitPx), s: floatToWire(size), r: !!reduceOnly, t: typeWire(orderType) };
}

/* ---------------- signing ---------------- */
export function actionHash(action, vaultAddress, nonce, expiresAfter) {
  const parts = [msgpackEncode(action), getBytes(zeroPadValue(toBeHex(BigInt(nonce)), 8))];
  if (!vaultAddress) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), getBytes(getAddress(vaultAddress)));
  if (expiresAfter != null) parts.push(new Uint8Array([0]), getBytes(zeroPadValue(toBeHex(BigInt(expiresAfter)), 8)));
  return keccak256(concat(parts));
}
const L1_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO };
const AGENT_TYPES = { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] };
export async function signL1Action(key, action, nonce, isMainnet = true) {
  const w = key instanceof Wallet ? key : new Wallet(key);
  const sig = Signature.from(await w.signTypedData(L1_DOMAIN, AGENT_TYPES, { source: isMainnet ? "a" : "b", connectionId: actionHash(action, null, nonce) }));
  return { r: sig.r, s: sig.s, v: sig.v };
}
let lastNonce = 0;
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1));

/* ---------------- relay ---------------- */
async function relay(payload) {
  const res = await fetch("/api/hl/exchange", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Hyperliquid relay failed (${res.status})`);
  return data;
}

/* ---------------- trading key (trade-only agent) ---------------- */
const AGENT_NAME = "Troya";
const keyName = (owner) => `troya.hl.agent.${String(owner).toLowerCase()}`;
const ls = () => (typeof localStorage !== "undefined" ? localStorage : null);
export function getTradingKey(owner) {
  try { const v = JSON.parse(ls()?.getItem(keyName(owner)) || "null"); return v && v.pk ? v : null; } catch { return null; }
}
function saveTradingKey(owner, v) { try { ls()?.setItem(keyName(owner), JSON.stringify(v)); } catch { throw new Error("This browser blocks local storage, so a trading key cannot be kept here."); } }
export function revokeTradingKey(owner) { try { ls()?.removeItem(keyName(owner)); } catch {} }

// Is the local key listed among the account's approved agents on Hyperliquid?
export async function tradingKeyStatus(owner) {
  const k = getTradingKey(owner);
  if (!k) return { state: "none" };
  try {
    const r = await fetch(`/api/hl/agents?address=${owner}`).then((x) => x.json());
    const hit = (r.agents || []).find((a) => a.address?.toLowerCase() === k.address.toLowerCase());
    if (hit) return { state: "approved", key: k, validUntil: hit.validUntil };
    return { state: k.approvedAt ? "expired" : "pending", key: k };
  } catch { return { state: k.approvedAt ? "approved" : "pending", key: k, offline: true }; }
}

/**
 * Ask the user's wallet to approve a fresh trade-only key (Hyperliquid "approveAgent").
 * eip = the EIP-1193 provider; the wallet should already be on Arbitrum (signatureChainId 0xa4b1).
 */
export async function approveTradingKey(owner, eip) {
  const w = Wallet.createRandom();
  const nonce = nextNonce();
  const message = { hyperliquidChain: "Mainnet", agentAddress: w.address, agentName: AGENT_NAME, nonce };
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message,
  };
  const raw = await eip.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(typed)] });
  const sig = Signature.from(raw);
  const action = { type: "approveAgent", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", agentAddress: w.address, agentName: AGENT_NAME, nonce };
  const res = await relay({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null });
  saveTradingKey(owner, { pk: w.privateKey, address: w.address, name: AGENT_NAME, createdAt: Date.now(), approvedAt: Date.now() });
  return res;
}

async function sendL1(owner, action) {
  const k = getTradingKey(owner);
  if (!k) throw new Error("Enable trading first: approve a trading key with your wallet.");
  const nonce = nextNonce();
  const signature = await signL1Action(k.pk, action, nonce);
  return relay({ action, nonce, signature, vaultAddress: null });
}

const statuses = (res) => res?.response?.data?.statuses || [];
export function describeStatuses(res) {
  return statuses(res).map((s) => s?.filled ? `filled ${s.filled.totalSz} @ ${s.filled.avgPx}` : s?.resting ? `resting (order ${s.resting.oid})` : s?.error ? `error: ${s.error}` : s === "waitingForFill" ? "waiting for fill" : s === "waitingForTrigger" ? "waiting for trigger" : String(s)).join(" · ");
}

/**
 * market = an entry from /api/hl/meta ({asset, coin, szDecimals, maxLeverage, midPx, markPx, onlyIsolated}).
 * limitPx null → IOC at mid ± slippage. tp/sl = trigger prices for reduce-only market exits.
 */
export async function placeOrder({ owner, market, isBuy, size, limitPx = null, reduceOnly = false, slippage = 0.01, leverage, isCross = true, tp, sl, refPx }) {
  const m = market;
  const sz = roundSz(size, m.szDecimals);
  if (!(sz > 0)) throw new Error(`Size rounds to zero: ${m.coin} trades in steps of ${10 ** -m.szDecimals}.`);
  if (leverage) await setLeverage({ owner, market: m, leverage, isCross });
  const isMarket = limitPx == null;
  const base = refPx || m.midPx || m.markPx;
  const px = isMarket ? roundPx(base * (isBuy ? 1 + slippage : 1 - slippage), m.szDecimals) : roundPx(limitPx, m.szDecimals);
  const orders = [orderWire({ asset: m.asset, isBuy, limitPx: px, size: sz, reduceOnly, orderType: { limit: { tif: isMarket ? "Ioc" : "Gtc" } } })];
  const trig = (tpx, tpsl) => {
    const t = roundPx(tpx, m.szDecimals);
    return orderWire({ asset: m.asset, isBuy: !isBuy, limitPx: roundPx(isBuy ? t * 0.9 : t * 1.1, m.szDecimals), size: sz, reduceOnly: true, orderType: { trigger: { isMarket: true, triggerPx: t, tpsl } } });
  };
  if (tp) orders.push(trig(tp, "tp"));
  if (sl) orders.push(trig(sl, "sl"));
  const res = await sendL1(owner, { type: "order", orders, grouping: orders.length > 1 ? "normalTpsl" : "na" });
  return { res, px, size: sz, text: describeStatuses(res) };
}
/**
 * Spot order (F12). pair = an entry from /api/market/hl/spot ({pair, label, asset, szDecimals, mid}). Same trade-only key as
 * perps; spot prices take up to 8 decimals. limitPx null → IOC at mid ± slippage (a market order that never fills worse).
 */
export async function placeSpotOrder({ owner, pair, isBuy, size, limitPx = null, slippage = 0.01, refPx }) {
  const sz = roundSz(size, pair.szDecimals);
  if (!(sz > 0)) throw new Error(`Size rounds to zero: ${pair.label} trades in steps of ${10 ** -pair.szDecimals}.`);
  const isMarket = limitPx == null;
  const base = refPx || pair.mid;
  if (!(base > 0)) throw new Error("No price for this pair right now.");
  const px = isMarket ? roundPx(base * (isBuy ? 1 + slippage : 1 - slippage), pair.szDecimals, 8) : roundPx(limitPx, pair.szDecimals, 8);
  const orders = [orderWire({ asset: pair.asset, isBuy, limitPx: px, size: sz, reduceOnly: false, orderType: { limit: { tif: isMarket ? "Ioc" : "Gtc" } } })];
  const res = await sendL1(owner, { type: "order", orders, grouping: "na" });
  return { res, px, size: sz, text: describeStatuses(res) };
}
/** Moves USDC between the perps and the spot account (Hyperliquid usdClassTransfer); signed by the user's own wallet. */
export async function transferUsdClass(owner, eip, amount, toPerp) {
  const nonce = nextNonce();
  const amt = String(Math.floor(Number(amount) * 1e6) / 1e6);
  if (!(Number(amt) > 0)) throw new Error("Enter an amount of USDC.");
  const message = { hyperliquidChain: "Mainnet", amount: amt, toPerp: !!toPerp, nonce };
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      "HyperliquidTransaction:UsdClassTransfer": [{ name: "hyperliquidChain", type: "string" }, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "nonce", type: "uint64" }],
    },
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    message,
  };
  const raw = await eip.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(typed)] });
  const sig = Signature.from(raw);
  const action = { type: "usdClassTransfer", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", amount: amt, toPerp: !!toPerp, nonce };
  return relay({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null });
}
/** Withdraws USDC from the Hyperliquid account to the same address on Arbitrum (Hyperliquid "withdraw3", $1 fee taken by
 *  Hyperliquid). The destination is always the signer's own address; the user's wallet signs. */
export async function withdrawUsdc(owner, eip, amount) {
  const time = nextNonce();
  const amt = String(Math.floor(Number(amount) * 1e6) / 1e6);
  if (!(Number(amt) > 1)) throw new Error("Withdrawals must be above 1 USDC (Hyperliquid keeps 1 USDC as the fee).");
  const destination = getAddress(owner);
  const message = { hyperliquidChain: "Mainnet", destination, amount: amt, time };
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }],
    },
    primaryType: "HyperliquidTransaction:Withdraw",
    message,
  };
  const raw = await eip.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(typed)] });
  const sig = Signature.from(raw);
  const action = { type: "withdraw3", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", destination, amount: amt, time };
  return relay({ action, nonce: time, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null });
}
/** F16: moves USDC between the main Hyperliquid perps balance ("") and the trade.xyz balance ("xyz"). The user's wallet
 *  signs (sendAsset); the destination is always the signer's own address, and the server checks that before relaying. */
export async function sendToDex(owner, eip, amount, sourceDex, destinationDex) {
  const nonce = nextNonce();
  const amt = String(Math.floor(Number(amount) * 1e6) / 1e6);
  if (!(Number(amt) > 0)) throw new Error("Enter an amount of USDC.");
  const destination = getAddress(owner);
  const token = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
  const message = { hyperliquidChain: "Mainnet", destination, sourceDex, destinationDex, token, amount: amt, fromSubAccount: "", nonce };
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: ZERO },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      "HyperliquidTransaction:SendAsset": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationDex", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "fromSubAccount", type: "string" }, { name: "nonce", type: "uint64" }],
    },
    primaryType: "HyperliquidTransaction:SendAsset",
    message,
  };
  const raw = await eip.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(typed)] });
  const sig = Signature.from(raw);
  const action = { type: "sendAsset", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", destination, sourceDex, destinationDex, token, amount: amt, fromSubAccount: "", nonce };
  return relay({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null });
}
export async function setLeverage({ owner, market, leverage, isCross = true }) {
  const lev = Math.round(Number(leverage));
  if (!(lev >= 1 && lev <= market.maxLeverage)) throw new Error(`${market.coin} allows 1–${market.maxLeverage}x.`);
  return sendL1(owner, { type: "updateLeverage", asset: market.asset, isCross: market.onlyIsolated ? false : !!isCross, leverage: lev });
}
export async function cancelOrder({ owner, market, oid }) {
  return sendL1(owner, { type: "cancel", cancels: [{ a: market.asset, o: Number(oid) }] });
}
