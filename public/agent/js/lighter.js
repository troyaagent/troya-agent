// Lighter on Robinhood Chain (F16): perps settled on Robinhood Chain, collateral USDG, 0% fees on Standard accounts.
// Lighter signs with its own scheme (Schnorr over ECgFp5 + Poseidon2), done in the browser by Lighter's official signer
// (lighter-go v1.0.12 web build, sha256 95c9dd38…c5ae, Go 1.25.5 runtime). The trading key is made on this device and
// registered once with a wallet signature (ChangePubKey). It can trade, cancel and withdraw only to the owner's own
// address; it never reaches the Troya server. All calls go straight to Lighter's API (it answers CORS).
import { Contract, Interface, getAddress, parseUnits, formatUnits } from "ethers";
import { wallet, signerFor, reader } from "./wallet.js";

export const LIGHTER = {
  base: "https://api.rh.lighter.xyz",
  chainId: 466324,                                               // Lighter RH signing chain id
  contract: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",         // on Robinhood Chain (4663)
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  usdgAsset: 3,                                                  // assetDetails: USDG
  keyIndex: 77,                                                  // Troya's own API-key slot (4–156 are free for apps)
};
const TX = { changePubKey: 8, withdraw: 13, createOrder: 14, cancelOrder: 15, updateLeverage: 20 };

/* ---------- the signer (loaded once, on first use) ---------- */
let signerReady = null;
function loadScript(src) {
  return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Could not load the Lighter signer.")); document.head.append(s); });
}
export function loadSigner() {
  signerReady ||= (async () => {
    if (!window.Go) await loadScript("/vendor/lighter/wasm_exec.js");
    const go = new window.Go();
    const { instance } = await WebAssembly.instantiateStreaming(fetch("/vendor/lighter/lighter-signer-web.wasm"), go.importObject);
    go.run(instance);                                             // the Go runtime stays alive; do not await
    for (let i = 0; i < 50 && typeof window._createClientByPrv !== "function"; i++) await new Promise((r) => setTimeout(r, 40));
    if (typeof window._createClientByPrv !== "function") throw new Error("The Lighter signer did not start.");
    return window;
  })().catch((e) => { signerReady = null; throw e; });
  return signerReady;
}
const check = (r) => { if (r?.error) throw new Error(r.error); return r; };
const call = async (fn, ...args) => check(await (await loadSigner())[fn](...args)());

/* ---------- Lighter API ---------- */
async function get(path, headers = {}) {
  const r = await fetch(LIGHTER.base + path, { headers, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.code) throw new Error(`Lighter ${r.status}`);
  return j;
}
async function sendTx(txType, txInfo) {
  const r = await fetch(`${LIGHTER.base}/api/v1/sendTx`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ tx_type: String(txType), tx_info: txInfo }) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 200) throw new Error(`Lighter refused it: ${j.message || j.code || r.status}`);
  return j;                                                     // accepted, not yet executed: check the account after
}
const nextNonce = async (acct) => (await get(`/api/v1/nextNonce?account_index=${acct}&api_key_index=${LIGHTER.keyIndex}`)).nonce;

export async function markets() {
  const [books, details] = await Promise.all([get("/api/v1/orderBooks"), get("/api/v1/orderBookDetails")]);
  const d = new Map((details.order_book_details || []).map((x) => [x.market_id, x]));
  return (books.order_books || []).filter((b) => b.market_type === "perp" && b.status === "active").map((b) => {
    const x = d.get(b.market_id) || {};
    return { id: b.market_id, symbol: b.symbol, sizeDecimals: x.size_decimals ?? b.supported_size_decimals, priceDecimals: x.price_decimals ?? b.supported_price_decimals,
      minBase: Number(x.min_base_amount ?? b.min_base_amount ?? 0), minQuote: Number(x.min_quote_amount ?? b.min_quote_amount ?? 0),
      maxLeverage: x.min_initial_margin_fraction ? Math.floor(10000 / x.min_initial_margin_fraction) : 10,
      mark: Number(x.mark_price || x.last_trade_price || 0), change24h: x.daily_price_change != null ? Number(x.daily_price_change) : null, volumeUsd: Number(x.daily_quote_token_volume || 0),
      takerFee: Number(b.taker_fee || 0), makerFee: Number(b.maker_fee || 0) };
  }).sort((a, b) => b.volumeUsd - a.volumeUsd);
}
export async function book(marketId, limit = 20) {
  const j = await get(`/api/v1/orderBookOrders?market_id=${marketId}&limit=${limit}`);
  const side = (xs) => (xs || []).map((o) => ({ px: Number(o.price), sz: Number(o.remaining_base_amount ?? o.initial_base_amount ?? 0) })).filter((o) => o.px > 0 && o.sz > 0);
  return { bids: side(j.bids), asks: side(j.asks) };
}
// the owner's master account index on Lighter RH (null until the first deposit lands)
export async function accountOf(owner) {
  const j = await get(`/api/v1/accountsByL1Address?l1_address=${getAddress(owner)}`);
  if (j.code === 21100 || !j.sub_accounts) return null;
  return j.sub_accounts.find((a) => a.account_type === 0)?.index ?? null;
}
export async function accountState(acct) {
  const j = await get(`/api/v1/account?by=index&value=${acct}`);
  const a = j.accounts?.[0] || {};
  return {
    collateral: Number(a.collateral || 0), available: Number(a.available_balance || 0), totalValue: Number(a.total_asset_value || 0),
    positions: (a.positions || []).filter((p) => Number(p.position) !== 0).map((p) => ({ marketId: p.market_id, symbol: p.symbol, size: Number(p.position) * (p.sign === -1 ? -1 : 1),
      entry: Number(p.avg_entry_price || 0), value: Number(p.position_value || 0), pnl: Number(p.unrealized_pnl || 0), liq: Number(p.liquidation_price || 0) || null })),
  };
}

/* ---------- the trading key (kept in this browser only) ---------- */
const keyName = (owner, acct) => `troya.lighter.${getAddress(owner).toLowerCase()}.${acct}`;
export function getKey(owner, acct) { try { return JSON.parse(localStorage.getItem(keyName(owner, acct)) || "null"); } catch { return null; } }
export function forgetKey(owner, acct) { try { localStorage.removeItem(keyName(owner, acct)); } catch {} }
export async function keyRegistered(acct, pk) {
  const j = await get(`/api/v1/apikeys?account_index=${acct}&api_key_index=${LIGHTER.keyIndex}`);
  return (j.api_keys?.[0]?.public_key || "").toLowerCase() === String(pk || "").replace(/^0x/, "").toLowerCase();
}
// one wallet signature: a fresh key is generated here, then registered for the account with ChangePubKey
export async function setupKey(owner, acct) {
  const seed = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const nonce = await nextNonce(acct);
  const c = await call("_createClient", seed, LIGHTER.chainId, acct, nonce, LIGHTER.keyIndex);
  if (!c.pubKeySuccess || !c.body) throw new Error("The Lighter signer could not prepare the key.");
  const l1 = await wallet.eip.request({ method: "personal_sign", params: [toHexUtf8(c.body), owner] });
  const tx = await call("_signChangePubKey", acct, l1, nonce, LIGHTER.keyIndex);
  await sendTx(TX.changePubKey, tx.txInfo);
  try { localStorage.setItem(keyName(owner, acct), JSON.stringify({ prv: c.prv, pk: c.pk, acct, keyIndex: LIGHTER.keyIndex, at: Date.now() })); }
  catch { throw new Error("This browser blocks local storage, so the Lighter key cannot be kept."); }
  for (let i = 0; i < 30; i++) { if (await keyRegistered(acct, c.pk).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
}
const toHexUtf8 = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function client(owner, acct) {
  const k = getKey(owner, acct);
  if (!k) throw new Error("Set up the Lighter trading key first.");
  const nonce = await nextNonce(acct);
  await call("_createClientByPrv", k.prv, LIGHTER.chainId, acct, nonce, LIGHTER.keyIndex);
  return nonce;
}

/* ---------- trading ---------- */
const toInt = (v, d) => String(Math.round(Number(v) * 10 ** d));
export async function setLeverage(owner, acct, market, lev, isolated = false) {
  const nonce = await client(owner, acct);
  const tx = await call("_signUpdateLeverage", acct, market.id, Math.round(10000 / lev), isolated ? 1 : 0, nonce);
  return sendTx(TX.updateLeverage, tx.txInfo);
}
// market order = IOC with a worst price (the slippage cap); limit = good till time (28 days)
export async function placeOrder(owner, acct, market, { isBuy, base, price, market: isMarket = true, reduceOnly = false }) {
  const nonce = await client(owner, acct);
  const coi = Date.now() % 2 ** 31;
  const tx = await call("_signCreateOrder", acct, market.id, coi, toInt(base, market.sizeDecimals), toInt(price, market.priceDecimals),
    isBuy ? 0 : 1, isMarket ? 1 : 0, isMarket ? 0 : 1, reduceOnly ? 1 : 0, "0", isMarket ? 0 : -1, nonce);
  return sendTx(TX.createOrder, tx.txInfo);
}
// secure withdrawal: USDG back to the owner's own address on Robinhood Chain (the only destination it allows)
export async function withdraw(owner, acct, amountUsdg) {
  const nonce = await client(owner, acct);
  const tx = await call("_signWithdraw", acct, LIGHTER.usdgAsset, 0, String(Math.floor(Number(amountUsdg) * 1e6)), nonce);
  return sendTx(TX.withdraw, tx.txInfo);
}

/* ---------- deposit (on Robinhood Chain, signed by the user's wallet) ---------- */
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const LIGHTER_ABI = new Interface(["function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount)"]);
export async function usdgBalance(owner) {
  const c = new Contract(LIGHTER.usdg, ERC20, reader("robinhood"));
  return Number(formatUnits(await c.balanceOf(owner), 6));
}
export async function deposit(owner, amountUsdg, onStep = () => {}) {
  const amt = parseUnits(String(amountUsdg), 6);
  if (amt < 1_000_000n) throw new Error("Lighter takes at least 1 USDG per deposit.");
  const signer = await signerFor("robinhood");
  const usdg = new Contract(LIGHTER.usdg, ERC20, signer);
  if ((await usdg.allowance(owner, LIGHTER.contract)) < amt) { onStep("approve"); await (await usdg.approve(LIGHTER.contract, amt)).wait(); }
  onStep("deposit");
  const lt = new Contract(LIGHTER.contract, LIGHTER_ABI, signer);
  const tx = await lt.deposit(getAddress(owner), LIGHTER.usdgAsset, 0, amt);
  await tx.wait();
  return tx.hash;
}
