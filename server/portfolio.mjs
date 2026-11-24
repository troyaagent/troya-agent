// Portfolio tokens: every token a wallet holds on Robinhood Chain, its value, and its PnL from the wallet's own trades.
//   GET /api/portfolio/tokens?address=0x…            every token held, priced where possible, sorted by value
//   GET /api/portfolio/pnl?address=0x…&token=0x…      PnL for one token, read from the wallet's trades on chain
// Holdings (community report 21 Nov 2026: "I bought 4 tokens, only 2 show"): Blockscout PRO finds the tokens (its balance
// list, plus its newest incoming transfers for coins its balance list has not picked up yet), the chain's own Transfer
// logs of the last ~15 minutes add anything bought since, and one balanceOf per token through the RPC broker (Chainstack
// first) gives the amount: Blockscout listed coins at their old balance after they were sold (19 such in one wallet).
// Tokens Blockscout flags as scams, airdrop spam with links in their names and copies wearing a major's name are left out,
// unless this wallet bought them itself. $TROYA, USDG and WETH are always read.
// Prices: Troya's market index, then Blockscout's rate (stocks, majors), then the chain itself for Pons coins (the curve's
// reserves while on the curve, the Uniswap v4 pool's price after graduation, as the coin page reads them), then
// DexScreener. A token without any price is still listed, marked priceUsd null ("No price yet").
// bought: true when a token reached the wallet in a transaction the wallet sent itself (a buy or swap), or straight from
// its Pons curve or the v4 PoolManager; false when it only ever arrived in transactions others sent (airdrops, plain
// transfers); null when the history read does not reach back far enough to tell.
// PnL is in ETH terms: for every transaction that moved the token, the wallet's net ETH (the transaction value plus
// internal transfers in and out, so smart accounts and routers count too) and WETH/USDG moved with it. Spent on buys vs
// received on sells plus what is held now at today's price. Gas is not counted. Tokens that arrived by plain transfer
// (no ETH, WETH or USDG left the wallet) are reported, never priced as bought.
import { isAddress, getAddress, AbiCoder, keccak256, toBeHex, Interface } from "ethers";
import { HttpError } from "./api.mjs";
import { rpc, iface, tokenMeta, ADDR } from "./robinhood.mjs";
import { indexRow, dsPairs, dsRows, getEthUsd, blockscoutApi, hasBlockscout, getStocks } from "./market.mjs";

const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
const USDG = String(ADDR.usdg || "0x5fc5360d0400a0fd4f2af552add042d716f1d168").toLowerCase();
const WETH = String(ADDR.weth || "").toLowerCase();
const POOL_MANAGER = String(ADDR.poolManager || "").toLowerCase();
const VENUES = new Set([ADDR.poolManager, ADDR.universalRouter, ADDR.swapRouter02].filter(Boolean).map((x) => String(x).toLowerCase()));
const ZERO = "0x0000000000000000000000000000000000000000";
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const VENUE = /router|curve|pool|swap|relay|aggregat|kyber|lifi|uniswap|exchange|bridge/i;   // contract names that trade
const SPAM = /https?:|www\.|\.com|\.io\b|\.xyz|\.net|t\.me|claim|visit|reward|airdrop|voucher|gift/i;
const lc = (s) => String(s || "").toLowerCase();
const MAJOR = { USDG, WETH, TROYA, ETH: null, USDC: null, USDT: null };   // symbol → the only real address (null: none on this chain)
const FUNGIBLE = new Set(["ERC-20", "ERC-8056"]);                            // ERC-8056: Robinhood stock tokens
const memo = new Map();
function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn();
  memo.set(key, { at: Date.now(), p });
  p.catch(() => memo.delete(key));
  if (memo.size > 3000) memo.delete(memo.keys().next().value);
  return p;
}
const addrOf = (s, what) => { if (!isAddress(String(s || ""))) throw new HttpError(400, `That is not a ${what} address.`); return lc(s); };
const hex = (n) => "0x" + Number(n).toString(16);
const pad32 = (a) => "0x" + lc(a).slice(2).padStart(64, "0");
const qs = (p) => (p ? "&" + new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString() : "");

/* ---------- reads on chain, through the RPC broker ---------- */
// many reads in one eth_call through Multicall3, 150 a call: [returnData | null (the call reverted) | undefined (not read)]
async function multi(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 150) {
    const part = calls.slice(i, i + 150);
    try {
      const data = iface.mc.encodeFunctionData("aggregate3", [part.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
      const raw = await rpc("robinhood", "eth_call", [{ to: ADDR.multicall3, data }, "latest"], { timeoutMs: 12_000 });
      const [res] = iface.mc.decodeFunctionResult("aggregate3", raw);
      out.push(...res.map((r) => (r.success && r.returnData && r.returnData !== "0x" ? r.returnData : null)));
    } catch { out.push(...part.map(() => undefined)); }
  }
  return out;
}
const ERC = iface.erc20;
const bigOf = (d) => { try { return d ? BigInt(ERC.decodeFunctionResult("balanceOf", d)[0]) : null; } catch { return null; } };
/** token → raw balance on chain (null: not read, or balanceOf reverted: the caller keeps what Blockscout says) */
async function balancesOf(a, tokens) {
  const res = await multi(tokens.map((t) => ({ target: t, data: ERC.encodeFunctionData("balanceOf", [a]) })));
  return new Map(tokens.map((t, i) => [t, res[i] === undefined ? null : bigOf(res[i])]));
}
/** fungible tokens that reached the wallet in the last ~15 minutes, from the chain's own Transfer logs (one topic per
 *  position, 100 blocks under the head): what was bought since Blockscout last indexed the wallet */
async function recentIncoming(a, pieces = 1) {
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", []))) - 100;
  const out = new Set();
  for (let k = 0; k < pieces; k++) {
    const to = head - k * 9_000, from = to - 8_999;
    const logs = await rpc("robinhood", "eth_getLogs", [{ topics: [T_TRANSFER, null, pad32(a)], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 15_000 });
    for (const l of Array.isArray(logs) ? logs : []) if ((l.topics || []).length === 3) out.add(lc(l.address));   // ERC-721 has the id as a 4th topic
  }
  return out;
}

/* ---------- Blockscout PRO: the wallet's tokens and where they came from ---------- */
// incoming token transfers, newest first (50 a page): finds coins the balance list has not picked up yet and tells a buy
// from an airdrop. Shared by walletTokens (first page) and acquisitions (up to `pages`); one token's own list (`token`)
// settles the coins older than those pages.
// each page is cached on its own, so the first page walletTokens reads is the one acquisitions starts from
const inPage = (a, token, cursor) => cached(`inp:${a}:${token || ""}:${cursor ? JSON.stringify(cursor) : ""}`, token ? 10 * 60_000 : 60_000,
  () => blockscoutApi(`/addresses/${a}/token-transfers?filter=to${token ? `&token=${token}` : ""}${qs(cursor)}`));
async function incomingPages(a, pages, token = null) {
  const items = [];
  let next = null, n = 0;
  do {
    const r = await inPage(a, token, next);
    items.push(...(r?.items || []));
    next = r?.next_page_params || null;
  } while (next && ++n < pages);
  return { items, complete: !next };
}
// transactions the wallet sent itself (50 a page)
function sentPages(a, pages) {
  return cached(`sent:${a}:${pages}`, 60_000, async () => {
    const hashes = new Set();
    let next = null, n = 0, oldest = null;
    do {
      const r = await blockscoutApi(`/addresses/${a}/transactions?filter=from${qs(next)}`);
      for (const x of r?.items || []) {
        if (lc(x.from?.hash) !== a) continue;
        if (x.status === "ok" || x.result === "success") hashes.add(lc(x.hash));
        const at = x.timestamp ? Date.parse(x.timestamp) : null;
        if (at != null) oldest = oldest == null ? at : Math.min(oldest, at);
      }
      next = r?.next_page_params || null;
    } while (next && ++n < pages);
    return { hashes, complete: !next, oldest, none: !hashes.size && !next };
  });
}

const cleanSym = (s) => String(s || "?").replace(/\s•.*$/, "");
const cleanName = (s) => String(s || "").replace(/\s•\s*Robinhood Token$/, "");
function spamOf(t) {
  if (t.reputation === "scam" || SPAM.test(`${t.name} ${t.symbol}`)) return true;
  // a copy wearing a major token's name (a fake "USDG" or "TROYA" airdropped to wallets) is spam
  const real = MAJOR[String(t.symbol || "").toUpperCase()];
  return real !== undefined && real !== lc(t.address_hash || t.address);
}
const fromBs = (t, raw) => ({
  address: lc(t.address_hash), symbol: cleanSym(t.symbol), name: cleanName(t.name), decimals: Number(t.decimals ?? 18), raw: raw.toString(),
  amount: Number(raw) / 10 ** Number(t.decimals ?? 18), rate: t.exchange_rate != null ? Number(t.exchange_rate) : null, icon: t.icon_url || null,
  stock: t.type === "ERC-8056", holders: t.holders_count != null ? Number(t.holders_count) : null, spam: spamOf(t),
});

/** Every token the wallet holds, spam included and flagged: [{ address, symbol, name, decimals, raw, amount, rate, icon, stock, spam }] */
export async function walletTokensAll(address) {
  const a = addrOf(address, "wallet");
  return cached(`wt:${a}`, 30_000, async () => {
    const found = new Map();                 // token → row (amount as Blockscout has it until the chain says otherwise)
    const bs = hasBlockscout();
    if (bs) {
      const [bal, inc] = await Promise.all([
        blockscoutApi(`/addresses/${a}/token-balances`).catch((e) => { console.warn("[portfolio] blockscout balances", e.message); return null; }),
        incomingPages(a, 1).catch(() => null)]);
      for (const x of Array.isArray(bal) ? bal : []) {
        const t = x.token || {};
        if (FUNGIBLE.has(t.type) && t.address_hash) found.set(lc(t.address_hash), fromBs(t, BigInt(x.value || 0)));
      }
      for (const x of inc?.items || []) {
        const t = x.token || {}, k = lc(t.address_hash);
        if (FUNGIBLE.has(t.type || x.token_type) && k && !found.has(k)) found.set(k, { ...fromBs({ ...t, type: t.type || x.token_type }, 0n), unseen: true });
      }
    }
    // the last ~15 minutes on chain (3 pieces when Blockscout is out: the chain is all there is)
    const recent = await recentIncoming(a, bs ? 1 : 3).catch(() => new Set());
    const always = [TROYA, USDG, WETH];
    const extra = [...new Set([...always, ...recent])].filter((t) => !found.has(t)).slice(0, 40);
    const metas = await Promise.all(extra.map((t) => tokenMeta(t).catch(() => null)));
    extra.forEach((t, i) => {
      const m = metas[i];
      if (m) found.set(t, { address: t, symbol: cleanSym(m.symbol), name: cleanName(m.name), decimals: Number(m.decimals ?? 18), raw: "0", amount: 0, rate: null, icon: null,
        stock: !!m.stock, holders: null, spam: spamOf({ ...m, address_hash: t }) && !always.includes(t), unseen: true });
    });
    // the chain decides the amount: Blockscout kept coins at their old balance after they left the wallet
    const toks = [...found.keys()];
    const onChain = await balancesOf(a, toks).catch(() => new Map());
    const list = [];
    for (const t of toks) {
      const row = found.get(t), raw = onChain.get(t);
      if (raw != null) { row.raw = raw.toString(); row.amount = Number(raw) / 10 ** row.decimals; row.checked = true; }
      else if (row.unseen) continue;         // no balance from either source
      if (!(BigInt(row.raw) > 0n)) continue;
      delete row.unseen;
      list.push(row);
    }
    return list;
  });
}
/** Every token the wallet holds without the spam (Aegis, the Agent Wallet guard, the assistant's get_balances) */
export async function walletTokens(address) {
  return (await walletTokensAll(address)).filter((t) => !t.spam);
}

/* ---------- Pons coins priced on chain ---------- */
const FACTORY = new Interface(["function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"]);
const CURVE = new Interface(["function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)", "function graduated() view returns (bool)"]);
const PMI = new Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);
const coder = AbiCoder.defaultAbiCoder();
const slot0Of = (poolId) => toBeHex(BigInt(keccak256(coder.encode(["bytes32", "uint256"], [poolId, 6]))), 32);   // the pools mapping sits at slot 6
const PONS = new Map();      // token → { curve, pair, pd, poolId, tokenFirst, graduated, at } | { none: true, at }
const ponsDue = (s) => !s || Date.now() - s.at > (s.none ? 6 * 3600_000 : s.graduated ? 24 * 3600_000 : 10 * 60_000);
async function ponsStatic(tokens) {
  const due = tokens.filter((t) => ponsDue(PONS.get(t))).slice(0, 300);
  if (!due.length) return;
  const res = await multi(due.map((t) => ({ target: ADDR.ponsFactory, data: FACTORY.encodeFunctionData("getLaunchedToken", [t]) })));
  const pairs = new Set();
  const got = due.map((t, i) => {
    if (res[i] === undefined) return null;   // not read: keep what was known
    let w = null; try { w = res[i] ? FACTORY.decodeFunctionResult("getLaunchedToken", res[i])[0] : null; } catch {}
    if (!w?.exists) { PONS.set(t, { none: true, at: Date.now() }); return null; }
    const pair = lc(w.pairToken);
    if (pair !== ZERO) pairs.add(pair);
    return [t, w, pair];
  }).filter(Boolean);
  const pd = new Map([[ZERO, 18], [WETH, 18], [USDG, 6]]);
  await Promise.all([...pairs].filter((p) => !pd.has(p)).map(async (p) => { const m = await tokenMeta(p).catch(() => null); if (m) pd.set(p, Number(m.decimals ?? 18)); }));
  for (const [t, w, pair] of got) {
    const [c0, c1] = t < pair ? [t, pair] : [pair, t];
    const poolId = keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [getAddress(c0), getAddress(c1), Number(w.poolFee), Number(w.tickSpacing), ADDR.ponsHook]));
    PONS.set(t, { curve: lc(w.curve), pair, pd: pd.get(pair) ?? 18, poolId, tokenFirst: c0 === t, graduated: Number(w.phase) >= 2, at: Date.now() });
  }
  while (PONS.size > 5000) PONS.delete(PONS.keys().next().value);
}
// the pair's dollar price: ETH, USDG, a Robinhood stock token or a coin on the board
async function pairUsdOf(pairs, ethUsd) {
  const out = new Map([[ZERO, ethUsd], [WETH, ethUsd], [USDG, 1]]);
  const rest = [...pairs].filter((p) => !out.has(p));
  for (const p of rest) { const px = indexRow(p)?.priceUsd; if (px > 0) out.set(p, px); }
  if (rest.some((p) => !out.has(p))) {
    const st = await getStocks().catch(() => null);
    for (const s of st?.stocks || []) if (s.priceUsd > 0 && !out.has(lc(s.address))) out.set(lc(s.address), s.priceUsd);
  }
  return out;
}
/** token → { priceUsd, onCurve } for the Pons coins among `tokens` */
async function ponsPrices(tokens, ethUsd) {
  await ponsStatic(tokens);
  const pons = tokens.filter((t) => PONS.get(t) && !PONS.get(t).none);
  const out = new Map();
  if (!pons.length) return out;
  const calls = [];
  for (const t of pons) {
    const s = PONS.get(t);
    calls.push({ target: s.curve, data: CURVE.encodeFunctionData("getReserves") }, { target: s.curve, data: CURVE.encodeFunctionData("graduated") },
      { target: ADDR.poolManager, data: PMI.encodeFunctionData("extsload", [slot0Of(s.poolId)]) });
  }
  const [res, usdOf] = await Promise.all([multi(calls), pairUsdOf(new Set(pons.map((t) => PONS.get(t).pair)), ethUsd)]);
  pons.forEach((t, i) => {
    const s = PONS.get(t), pUsd = usdOf.get(s.pair);
    const dec = (k, ifc, fn) => { try { return res[3 * i + k] ? ifc.decodeFunctionResult(fn, res[3 * i + k]) : null; } catch { return null; } };
    const rv = dec(0, CURVE, "getReserves"), grad = s.graduated || !!dec(1, CURVE, "graduated")?.[0];
    let inPair = null, onCurve = false;
    if (grad) {
      if (!s.graduated) s.graduated = true;
      let w = 0n; try { w = res[3 * i + 2] ? BigInt(PMI.decodeFunctionResult("extsload", res[3 * i + 2])[0]) : 0n; } catch {}
      const sq = w & ((1n << 160n) - 1n);
      if (sq > 0n) { const sp = Number(sq) / 2 ** 96, r = sp * sp; inPair = s.tokenFirst ? r * 10 ** (18 - s.pd) : 1 / (r * 10 ** (s.pd - 18)); }
    } else if (rv && rv[1] > 0n) {
      inPair = (Number(rv[0]) / 10 ** s.pd) / (Number(rv[1]) / 1e18);
      onCurve = true;
    }
    const priceUsd = inPair > 0 && Number.isFinite(inPair) && pUsd ? inPair * pUsd : null;
    if (priceUsd) out.set(t, { priceUsd, onCurve, curve: s.curve });
  });
  return out;
}

/** V9 F48 Chiron: the Pons facts of these coins (curve, pair, pair decimals, v4 pool id, token sorts first), read once and
 *  cached as above; coins that are not Pons launches are left out. slot0 of a pool id: ponsSlot0Of. */
export async function ponsInfo(tokens) {
  const list = [...new Set(tokens.map(lc))];
  await ponsStatic(list);
  return new Map(list.map((t) => [t, PONS.get(t)]).filter(([, s]) => s && !s.none));
}
export const ponsSlot0Of = (poolId) => slot0Of(poolId);

/* ---------- prices ---------- */
async function priced(list) {
  const ethUsd = await getEthUsd().catch(() => null);
  for (const t of list) {
    const row = indexRow(t.address);
    t.priceUsd = t.address === USDG ? 1 : row?.priceUsd ?? t.rate ?? null;
    t.priceSource = t.address === USDG ? "USDG" : row?.priceUsd != null ? row.priceSource || "Troya market" : t.rate != null ? "Blockscout" : null;
    t.change24h = row?.change24h ?? null;
    t.image = row?.image || t.icon || null;
    if (row?.launchpad === "pons" && row.priceSource === "Pons curve, on chain") t.onCurve = true;
  }
  // Pons coins the index does not carry yet: the chain itself (a coin still on its curve has no DEX pair to read)
  const noPx = list.filter((t) => t.priceUsd == null && !t.stock).map((t) => t.address);
  if (noPx.length) {
    const px = await ponsPrices(noPx, ethUsd).catch((e) => { console.warn("[portfolio] pons prices", e.message); return new Map(); });
    for (const t of list) { const p = px.get(t.address); if (t.priceUsd == null && p) { t.priceUsd = p.priceUsd; t.onCurve = p.onCurve; t.priceSource = p.onCurve ? "Pons curve, on chain" : "Uniswap v4 pool, on chain"; } }
  }
  const need = list.filter((t) => t.priceUsd == null).map((t) => t.address);
  if (need.length) {
    const rows = dsRows(await dsPairs(need.slice(0, 150)).catch(() => []), ethUsd);
    for (const t of list) if (t.priceUsd == null && rows.get(t.address)) { const r = rows.get(t.address); t.priceUsd = r.priceUsd; t.change24h = r.change24h; t.image ||= r.image; t.priceSource = "DexScreener"; }
  }
  for (const t of list) { t.valueUsd = t.priceUsd != null ? t.amount * t.priceUsd : null; t.onCurve = !!t.onCurve; }
  return { ethUsd, list: list.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1)) };
}
// the priced list, shared by the token list and the PnL reads of one page load
function pricedTokens(a, { all = false } = {}) {
  return cached(`pr:${a}:${all ? 1 : 0}`, 20_000, async () => priced((all ? await walletTokensAll(a) : await walletTokens(a)).map((x) => ({ ...x }))));
}

/* ---------- bought or received ---------- */
// per token: did it ever reach the wallet in a transaction the wallet sent (a buy, a swap, a claim it made), from a trading
// venue in someone else's transaction, in one another wallet sent within the stretch of history read (an airdrop, a plain
// transfer), or only before that stretch
function note(per, a, sent, x) {
  const t = lc(x.token?.address_hash);
  if (!t || lc(x.to?.hash) !== a) return;
  const p = per.get(t) || { own: false, venue: false, others: false, older: false, from: new Set() };
  if (sent.hashes.has(lc(x.transaction_hash))) p.own = true;
  // delivered by a trading venue in someone else's transaction: a cross-chain buy filled by a solver (RelayRouter), a
  // Pons curve or a pool paying out to a recipient, a router: bought, not airdropped
  else if (x.from?.is_contract && (VENUE.test(String(x.from?.name || "")) || VENUES.has(lc(x.from?.hash)))) p.venue = true;
  else {
    if (x.from?.is_contract) p.from.add(lc(x.from?.hash));
    const at = x.timestamp ? Date.parse(x.timestamp) : null;
    // a wallet that never sent a transaction itself (a contract, a smart account) cannot tell an airdrop from a buy
    if (!sent.none && (sent.complete || (at != null && sent.oldest != null && at >= sent.oldest))) p.others = true; else p.older = true;
  }
  per.set(t, p);
}
export async function acquisitions(address, { pages = 4 } = {}) {
  const a = addrOf(address, "wallet");
  if (!hasBlockscout()) return null;
  return cached(`acq:${a}:${pages}`, 2 * 60_000, async () => {
    const [inc, sent] = await Promise.all([incomingPages(a, pages), sentPages(a, pages)]);
    const per = new Map();     // token → { own, venue, others, older, from: Set (contracts that sent it) }
    for (const x of inc.items) note(per, a, sent, x);
    return { a, per, sent, seen: new Set(), incComplete: inc.complete, complete: inc.complete && sent.complete };
  });
}
/** true: bought (its own transaction, a venue, or straight from the coin's Pons curve or the v4 PoolManager) · false: only
 *  ever received from others · null: cannot tell from the history read */
export function boughtOf(acq, token) {
  const p = acq?.per?.get(token);
  if (!p) return null;
  if (p.own || p.venue) return true;
  const curve = PONS.get(token)?.curve;                 // Pons curves are often unverified: matched by address
  if (p.from.has(POOL_MANAGER) || (curve && p.from.has(curve))) return true;
  return p.older ? null : p.others ? false : null;
}
// coins the pages above do not settle (older than them, or crowded out by a stream of stablecoin transfers): their own
// transfer list, a few per load (Pons coins first: a curve coin is what people buy), within a time budget
async function settle(acq, list, { max = 6, budgetMs = 2_500 } = {}) {
  const a = acq.a;
  const unsure = list.filter((t) => boughtOf(acq, t.address) !== true && acq.per.get(t.address)?.from.size).map((t) => t.address);
  if (unsure.length) await ponsStatic(unsure).catch(() => {});
  if (acq.incComplete) return;                          // every incoming transfer was read already
  const isPons = (t) => (PONS.get(t.address) && !PONS.get(t.address).none ? 1 : 0);
  const todo = list.filter((t) => boughtOf(acq, t.address) == null && !(t.valueUsd >= 0.01) && !acq.seen.has(t.address))
    .sort((x, y) => isPons(y) - isPons(x)).slice(0, max);
  if (!todo.length) return;
  const until = Date.now() + budgetMs;
  for (const t of todo) {
    if (Date.now() > until) break;
    const r = await Promise.race([incomingPages(a, 1, t.address).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), Math.max(0, until - Date.now())))]);
    if (!r) break;
    acq.seen.add(t.address);
    const old = acq.per.get(t.address);
    if (old && !old.own && !old.venue) acq.per.delete(t.address);     // its own list replaces what the pages saw of it
    for (const x of r.items) note(acq.per, a, acq.sent, x);
    if (!r.complete && boughtOf(acq, t.address) === false) acq.per.get(t.address).older = true;   // more history behind it
  }
}

/* ---------- PnL from the wallet's own trades ---------- */
const wei = (v) => Number(BigInt(v || 0)) / 1e18;
async function txFlows(hash, a) {
  return cached(`tx:${hash}:${a}`, 24 * 3600_000, async () => {
    const [tx, internal] = await Promise.all([blockscoutApi(`/transactions/${hash}`), blockscoutApi(`/transactions/${hash}/internal-transactions`).catch(() => ({ items: [] }))]);
    let ethIn = 0, ethOut = 0, wethIn = 0, wethOut = 0, usdgIn = 0, usdgOut = 0;
    if (tx?.status && tx.status !== "ok") return { failed: true };
    if (lc(tx?.from?.hash) === a) ethOut += wei(tx.value);
    if (lc(tx?.to?.hash) === a) ethIn += wei(tx.value);
    for (const it of internal?.items || []) {
      if (it.success === false || !it.value || it.value === "0") continue;
      if (lc(it.from?.hash) === a) ethOut += wei(it.value);
      if (lc(it.to?.hash) === a) ethIn += wei(it.value);
    }
    for (const t of tx?.token_transfers || []) {
      const tok = lc(t.token?.address_hash || t.token?.address), v = Number(t.total?.value || 0) / 10 ** Number(t.total?.decimals ?? t.token?.decimals ?? 18);
      if (tok === WETH) { if (lc(t.to?.hash) === a) wethIn += v; if (lc(t.from?.hash) === a) wethOut += v; }
      if (tok === USDG) { if (lc(t.to?.hash) === a) usdgIn += v; if (lc(t.from?.hash) === a) usdgOut += v; }
    }
    return { ethIn, ethOut, wethIn, wethOut, usdgIn, usdgOut, at: tx?.timestamp ? Date.parse(tx.timestamp) : null };
  });
}

export async function tokenPnl(address, token) {
  const a = addrOf(address, "wallet"), t = addrOf(token, "token");
  if (!hasBlockscout()) return { status: "unavailable", reason: "Trade history is not configured on this server." };
  if (t === USDG || t === WETH) return { status: "none", reason: "A stable or wrapped coin: no PnL to show." };
  return cached(`pnl:${a}:${t}`, 3 * 60_000, async () => {
    const [{ list, ethUsd }, tr] = await Promise.all([pricedTokens(a, { all: true }), blockscoutApi(`/addresses/${a}/token-transfers?token=${t}`)]);
    const held = list.find((x) => x.address === t);
    const items = (tr?.items || []).filter((x) => lc(x.token?.address_hash) === t);
    // one row per transaction: tokens in and out of the wallet
    const byTx = new Map();
    for (const x of items) {
      const h = x.transaction_hash, dec = Number(x.total?.decimals ?? x.token?.decimals ?? 18), v = Number(x.total?.value || 0) / 10 ** dec;
      const row = byTx.get(h) || { hash: h, in: 0, out: 0, at: x.timestamp ? Date.parse(x.timestamp) : null };
      if (lc(x.to?.hash) === a) row.in += v;
      if (lc(x.from?.hash) === a) row.out += v;
      byTx.set(h, row);
    }
    const rows = [...byTx.values()].slice(0, 40);
    let costEth = 0, proceedsEth = 0, bought = 0, sold = 0, transfersIn = 0, transfersOut = 0, buys = 0, sells = 0;
    let last = null;                     // the newest buy or sell (Blockscout lists newest first): the share card prints its tx
    for (const r of rows) {
      const f = await txFlows(r.hash, a).catch(() => null);
      if (!f || f.failed) continue;
      const net = r.in - r.out;
      const paidEth = f.ethOut - f.ethIn + (f.wethOut - f.wethIn) + (ethUsd ? (f.usdgOut - f.usdgIn) / ethUsd : 0);
      if (net > 0) {
        if (paidEth > 1e-12) { costEth += paidEth; bought += net; buys++; last ||= r; } else transfersIn += net;
      } else if (net < 0) {
        if (-paidEth > 1e-12) { proceedsEth += -paidEth; sold += -net; sells++; last ||= r; } else transfersOut += -net;
      }
    }
    const priceUsd = held?.priceUsd ?? indexRow(t)?.priceUsd ?? null;
    const priceEth = priceUsd != null && ethUsd ? priceUsd / ethUsd : null;
    const amount = held?.amount ?? 0;
    if (!buys && !sells) return { status: "none", reason: transfersIn ? "These tokens arrived by transfer, not bought with ETH, WETH or USDG from this wallet." : "No trades for this token from this wallet yet.", amount, transfersIn };
    // value only what was bought: tokens that arrived by transfer are not counted as profit
    const fromBuys = Math.max(0, Math.min(amount, bought - sold));
    const valueEth = priceEth != null ? fromBuys * priceEth : null;
    const pnlEth = valueEth != null ? proceedsEth + valueEth - costEth : null;
    const avgEntryEth = bought > 0 ? costEth / bought : null;
    return {
      status: "ok", token: getAddress(t), amount, buys, sells, bought, sold, transfersIn, transfersOut,
      costEth, proceedsEth, valueEth, pnlEth, pnlPct: pnlEth != null && costEth > 0 ? (pnlEth / costEth) * 100 : null,
      pnlUsd: pnlEth != null && ethUsd ? pnlEth * ethUsd : null, avgEntryEth, avgEntryUsd: avgEntryEth != null && ethUsd ? avgEntryEth * ethUsd : null,
      priceUsd, ethUsd, partial: (tr?.next_page_params != null) || byTx.size > 40, lastTx: last ? { hash: last.hash, at: last.at } : null,
      note: "In ETH terms at today's ETH price; gas not counted. Tokens received by plain transfer are not counted as bought.",
    };
  });
}

export async function register(r) {
  r.get("/api/portfolio/tokens", async ({ query }) => {
    const a = addrOf(query.address, "wallet");
    const [{ ethUsd, list }, acq] = await Promise.all([pricedTokens(a, { all: true }), acquisitions(a).catch((e) => { console.warn("[portfolio] history", e.message); return null; })]);
    if (acq) await settle(acq, list).catch((e) => console.warn("[portfolio] settle", e.message));
    const tokens = [];
    for (const { rate, icon, checked, ...t } of list) {
      const bought = boughtOf(acq, t.address);
      if (t.spam && bought !== true) continue;      // spam stays out unless this wallet bought it itself
      tokens.push({ ...t, bought });
    }
    const n = (f) => tokens.filter(f).length;
    return {
      address: getAddress(a), ethUsd, tokens, totalUsd: tokens.reduce((s, t) => s + (t.valueUsd || 0), 0),
      counts: { held: tokens.length, bought: n((t) => t.bought === true), received: n((t) => t.bought === false), unpriced: n((t) => t.priceUsd == null) },
      history: acq ? (acq.complete ? "complete" : "recent") : "unavailable",
      source: hasBlockscout() ? "Blockscout + chain" : "chain", at: Date.now(),
    };
  }, { weight: 2, perMin: 60 });
  r.get("/api/portfolio/pnl", async ({ query }) => tokenPnl(query.address, query.token), { weight: 4, perMin: 60 });
}
