// Lighter on Robinhood Chain (F16): perps settled on Robinhood Chain, collateral USDG, 0% fees on Standard accounts.
// Lighter signs with its own scheme (Schnorr over ECgFp5 + Poseidon2), done in the browser by Lighter's official signer
// (lighter-go v1.0.12 web build, sha256 95c9dd38…c5ae, Go 1.25.5 runtime). The trading key is made on this device and
// registered once with a wallet signature (ChangePubKey). It can trade, cancel and withdraw only to the owner's own
// address; it never reaches the Troya server. All calls go straight to Lighter's API (it answers CORS).
// sendTx only means Lighter accepted a transaction, not that it ran: waitLeverage and waitFill read the account and the
// trade feed afterwards, so the desk can stop an order when the leverage did not apply and say what really filled.
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
  // a rate-limit answer is not data: read as data it looks like an empty account or book (no positions, no fills)
  if (r.status === 429 || j.code === 23000) throw new Error("Lighter is limiting requests right now. Try again in a minute.");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function markets() {
  const [books, details] = await Promise.all([get("/api/v1/orderBooks"), get("/api/v1/orderBookDetails")]);
  const d = new Map((details.order_book_details || []).map((x) => [x.market_id, x]));
  return (books.order_books || []).filter((b) => b.market_type === "perp" && b.status === "active").map((b) => {
    const x = d.get(b.market_id) || {};
    return { id: b.market_id, symbol: b.symbol, sizeDecimals: x.size_decimals ?? b.supported_size_decimals, priceDecimals: x.price_decimals ?? b.supported_price_decimals,
      minBase: Number(x.min_base_amount ?? b.min_base_amount ?? 0), minQuote: Number(x.min_quote_amount ?? b.min_quote_amount ?? 0),
      maxLeverage: x.min_initial_margin_fraction ? Math.floor(10000 / x.min_initial_margin_fraction) : 10,
      mmf: Number(x.maintenance_margin_fraction || 0) / 10000,     // maintenance margin (120 = 1.2%), for the liquidation estimate
      mark: Number(x.mark_price || x.last_trade_price || 0), change24h: x.daily_price_change != null ? Number(x.daily_price_change) : null, volumeUsd: Number(x.daily_quote_token_volume || 0),
      takerFee: Number(b.taker_fee || 0), makerFee: Number(b.maker_fee || 0) };
  }).sort((a, b) => b.volumeUsd - a.volumeUsd);
}
// the order book by price level: Lighter returns single orders, so orders at the same price are summed into one level
export async function book(marketId, limit = 20) {
  const j = await get(`/api/v1/orderBookOrders?market_id=${marketId}&limit=${limit}`);
  const side = (xs, asc) => {
    const lv = new Map();
    for (const o of xs || []) {
      const px = Number(o.price), sz = Number(o.remaining_base_amount ?? o.initial_base_amount ?? 0);
      if (px > 0 && sz > 0) lv.set(px, (lv.get(px) || 0) + sz);
    }
    return [...lv].map(([px, sz]) => ({ px, sz })).sort((a, b) => (asc ? a.px - b.px : b.px - a.px));
  };
  return { bids: side(j.bids, false), asks: side(j.asks, true) };
}
// the owner's master account index on Lighter RH (null until the first deposit lands)
export async function accountOf(owner) {
  const j = await get(`/api/v1/accountsByL1Address?l1_address=${getAddress(owner)}`);
  if (j.code === 21100 || !j.sub_accounts) return null;
  return j.sub_accounts.find((a) => a.account_type === 0)?.index ?? null;
}
export async function accountState(acct) {
  const j = await get(`/api/v1/account?by=index&value=${acct}`);
  if (!Array.isArray(j.accounts)) throw new Error(j.message || "Lighter did not return the account.");   // never an empty account by mistake
  const a = j.accounts[0] || {};
  return {
    collateral: Number(a.collateral || 0), available: Number(a.available_balance || 0), totalValue: Number(a.total_asset_value || 0),
    // the value that backs cross positions (what Lighter's own liquidation prices use; above totalValue when spot assets count as margin)
    crossValue: Number(a.cross_asset_value ?? a.total_asset_value ?? 0),
    positions: (a.positions || []).filter((p) => Number(p.position) !== 0).map((p) => ({ marketId: p.market_id, symbol: p.symbol, size: Number(p.position) * (p.sign === -1 ? -1 : 1),
      entry: Number(p.avg_entry_price || 0), value: Number(p.position_value || 0), pnl: Number(p.unrealized_pnl || 0), liq: Number(p.liquidation_price || 0) || null })),
    // the leverage the account holds per market, also for markets with no open position (Lighter keeps the entry once a
    // leverage was set): initial_margin_fraction "33.33" (%) is 3333 in the basis points UpdateLeverage takes
    margins: Object.fromEntries((a.positions || []).filter((p) => Number(p.initial_margin_fraction) > 0).map((p) => {
      const imf = Math.round(Number(p.initial_margin_fraction) * 100);
      return [p.market_id, { imf, lev: Math.round(10000 / imf), isolated: Number(p.margin_mode) === 1 }];
    })),
  };
}
// the initial margin fraction (basis points) for a leverage, exactly as setLeverage sends it
export const imfOf = (lev) => Math.round(10000 / lev);
// does the account already hold this leverage, in cross margin, for this market?
export function leverageIs(margins, marketId, lev) {
  const m = margins?.[marketId];
  return !!m && m.imf === imfOf(lev) && !m.isolated;
}
// Estimated liquidation price on a cross-margin account after an order: Lighter liquidates when the cross account value
// (equity = accountState().crossValue) falls to the maintenance margin of all positions. The order adds `add` (signed
// base) at `px` to this market's position; the other positions are held at today's value. With add = 0 it matched
// Lighter's own liquidation_price to the cent on live accounts (one position and 35, plain and with spot margin).
export function estLiq({ equity, positions = [], marketId, add = 0, px = 0, mmfOf }) {
  let others = 0, q0 = 0, e0 = 0, pnl0 = 0;
  for (const p of positions) {
    if (p.marketId === marketId) { q0 = p.size; e0 = p.entry; pnl0 = p.pnl; }
    else others += (mmfOf(p.marketId) || 0) * Math.abs(p.value);
  }
  const mmf = mmfOf(marketId) || 0, q = q0 + add;
  if (!q || !(mmf < 1) || !isFinite(equity)) return null;
  const cost = q0 * e0 + add * px;               // what the combined position was opened at
  const liq = (others + cost - (equity - pnl0)) / (q - mmf * Math.abs(q));
  return liq > 0 && isFinite(liq) ? liq : null;  // none: the account covers a move all the way to zero
}
// poll the account until Lighter reports this leverage for the market (about 6 s); false when it never shows
export async function waitLeverage(acct, marketId, lev, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(1000);
    try { if (leverageIs((await accountState(acct)).margins, marketId, lev)) return true; } catch {}
  }
  return false;
}
// what one order filled: the account's trades on this market whose client order index is this order's
export async function orderFills(acct, marketId, coi) {
  const j = await get(`/api/v1/trades?account_index=${acct}&market_id=${marketId}&sort_by=timestamp&sort_dir=desc&limit=100`);
  if (!Array.isArray(j.trades)) throw new Error(j.message || "Lighter did not return the trades.");      // unknown, not "no fills"
  const me = Number(acct), id = String(coi);
  let base = 0, quote = 0;
  for (const t of j.trades) {
    const mine = (Number(t.bid_account_id) === me && String(t.bid_client_id_str ?? t.bid_client_id) === id)
      || (Number(t.ask_account_id) === me && String(t.ask_client_id_str ?? t.ask_client_id) === id);
    if (mine) { const s = Number(t.size), p = Number(t.price); base += s; quote += s * p; }
  }
  return { base, avg: base ? quote / base : null };
}
// an IOC order fills (or is cancelled) the moment it executes; read its fills for about 6 s. All of one order's trades
// come from the same transaction, so once some show, one more look catches any the feed had not listed yet.
export async function waitFill(acct, marketId, coi, base, ms = 6000) {
  const end = Date.now() + ms;
  let f = { base: 0, avg: null };
  while (Date.now() < end) {
    await sleep(1000);
    try { f = await orderFills(acct, marketId, coi); } catch {}
    if (f.base >= base * 0.999999) break;
    if (f.base > 0) { await sleep(1000); try { f = await orderFills(acct, marketId, coi); } catch {} break; }
  }
  return f;
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
// minNonce: the nonce right after a transaction just sent, so a follow-up (the order after its leverage change) stays in
// one sequence even when nextNonce has not caught up yet
async function client(owner, acct, minNonce = 0) {
  const k = getKey(owner, acct);
  if (!k) throw new Error("Set up the Lighter trading key first.");
  const nonce = Math.max(Number(await nextNonce(acct)), Number(minNonce) || 0);
  await call("_createClientByPrv", k.prv, LIGHTER.chainId, acct, nonce, LIGHTER.keyIndex);
  return nonce;
}

/* ---------- trading ---------- */
const toInt = (v, d) => String(Math.round(Number(v) * 10 ** d));
// accepted only: the change runs after, and can still fail (for example when open positions need more margin), so the
// desk waits for it with waitLeverage. Returns the nonce it used, for the order that follows.
export async function setLeverage(owner, acct, market, lev, isolated = false) {
  if (!(lev >= 1 && lev <= market.maxLeverage)) throw new Error(`Leverage must be between 1x and ${market.maxLeverage}x.`);
  const nonce = await client(owner, acct);
  const tx = await call("_signUpdateLeverage", acct, market.id, imfOf(lev), isolated ? 1 : 0, nonce);
  return { ...(await sendTx(TX.updateLeverage, tx.txInfo)), nonce };
}
// market order = IOC with a worst price (the slippage cap); limit = good till time (28 days). Returns the client order
// index, which the trade feed carries, so waitFill can find this order's fills.
export async function placeOrder(owner, acct, market, { isBuy, base, price, market: isMarket = true, reduceOnly = false, nonce: minNonce = 0 }) {
  if (!(Number(base) > 0) || !(Number(price) > 0)) throw new Error("The order needs a size and a price.");
  const nonce = await client(owner, acct, minNonce);
  const coi = Date.now() % 2 ** 31;
  const tx = await call("_signCreateOrder", acct, market.id, coi, toInt(base, market.sizeDecimals), toInt(price, market.priceDecimals),
    isBuy ? 0 : 1, isMarket ? 1 : 0, isMarket ? 0 : 1, reduceOnly ? 1 : 0, "0", isMarket ? 0 : -1, nonce);
  return { ...(await sendTx(TX.createOrder, tx.txInfo)), coi, nonce };
}
// secure withdrawal: USDG back to the owner's own address on Robinhood Chain (the only destination it allows). The amount
// is always explicit: a blank or zero amount is refused here too, never read as "everything".
export async function withdraw(owner, acct, amountUsdg) {
  const units = Math.floor(Number(amountUsdg) * 1e6);
  if (!Number.isFinite(units) || units < 1_000_000) throw new Error("Withdraw at least 1 USDG.");
  const nonce = await client(owner, acct);
  const tx = await call("_signWithdraw", acct, LIGHTER.usdgAsset, 0, String(units), nonce);
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
