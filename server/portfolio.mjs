// Portfolio tokens: every token a wallet holds on Robinhood Chain, its value, and its PnL from the wallet's own trades.
//   GET /api/portfolio/tokens?address=0x…            every token held (Blockscout PRO), priced, sorted by value
//   GET /api/portfolio/pnl?address=0x…&token=0x…      PnL for one token, read from the wallet's trades on chain
// Holdings come from Blockscout's token balances (ERC-20 and Robinhood stock tokens), skipping tokens Blockscout flags as
// scams and airdrop spam with links in their names; $TROYA is always looked up. Prices: Troya's market index, then
// Blockscout's rate (stocks, majors), then DexScreener.
// PnL is in ETH terms: for every transaction that moved the token, the wallet's net ETH (the transaction value plus
// internal transfers in and out, so smart accounts and routers count too) and WETH/USDG moved with it. Spent on buys vs
// received on sells plus what is held now at today's price. Gas is not counted. Tokens that arrived by plain transfer
// (no ETH, WETH or USDG left the wallet) are reported, never priced as bought.
import { isAddress, getAddress } from "ethers";
import { HttpError } from "./api.mjs";
import { getBalances, ADDR } from "./robinhood.mjs";
import { indexRow, dsPairs, dsRows, getEthUsd, blockscoutApi, hasBlockscout } from "./market.mjs";

const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
const USDG = String(ADDR.usdg || "0x5fc5360d0400a0fd4f2af552add042d716f1d168").toLowerCase();
const WETH = String(ADDR.weth || "").toLowerCase();
const SPAM = /https?:|www\.|\.com|\.io\b|\.xyz|\.net|t\.me|claim|visit|reward|airdrop|voucher|gift/i;
const lc = (s) => String(s || "").toLowerCase();
const MAJOR = { USDG, WETH, TROYA, ETH: null, USDC: null, USDT: null };   // symbol → the only real address (null: none on this chain)
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

/** Every token the wallet holds: [{ address, symbol, name, decimals, raw, amount, rate, icon, stock }] */
export async function walletTokens(address) {
  const a = addrOf(address, "wallet");
  return cached(`wt:${a}`, 30_000, async () => {
    let list = [];
    if (hasBlockscout()) {
      try {
        const r = await blockscoutApi(`/addresses/${a}/token-balances`);
        for (const x of Array.isArray(r) ? r : []) {
          const t = x.token || {}, raw = BigInt(x.value || 0);
          if (!(raw > 0n) || !["ERC-20", "ERC-8056"].includes(t.type)) continue;
          if (t.reputation === "scam" || SPAM.test(`${t.name} ${t.symbol}`)) continue;
          // a copy wearing a major token's name (a fake "USDG" or "TROYA" airdropped to wallets) is spam
          const real = MAJOR[String(t.symbol || "").toUpperCase()];
          if (real !== undefined && real !== lc(t.address_hash)) continue;
          const dec = Number(t.decimals ?? 18);
          list.push({ address: lc(t.address_hash), symbol: String(t.symbol || "?").replace(/\s•.*$/, ""), name: String(t.name || "").replace(/\s•\s*Robinhood Token$/, ""), decimals: dec, raw: raw.toString(),
            amount: Number(raw) / 10 ** dec, rate: t.exchange_rate != null ? Number(t.exchange_rate) : null, icon: t.icon_url || null, stock: t.type === "ERC-8056", holders: t.holders_count != null ? Number(t.holders_count) : null });
        }
      } catch (e) { console.warn("[portfolio] blockscout", e.message); list = []; }
    }
    // $TROYA always, and the on-chain read as the fallback when Blockscout is missing or down
    const have = new Set(list.map((x) => x.address));
    const extra = [TROYA, ...(list.length ? [] : [USDG])].filter((t) => !have.has(t));
    if (extra.length) {
      const b = await getBalances(a, extra).catch(() => null);
      for (const x of b?.balances || []) if (x.address !== "native" && Number(x.amount) > 0 && !have.has(lc(x.address))) list.push({ address: lc(x.address), symbol: x.symbol, name: x.name, decimals: x.decimals, raw: x.raw, amount: Number(x.amount), rate: null, icon: null, stock: false });
    }
    return list;
  });
}

async function priced(list) {
  const ethUsd = await getEthUsd().catch(() => null);
  const need = [];
  for (const t of list) {
    const row = indexRow(t.address);
    t.priceUsd = t.address === USDG ? 1 : row?.priceUsd ?? t.rate ?? null;
    t.change24h = row?.change24h ?? null;
    t.image = row?.image || t.icon || null;
    if (t.priceUsd == null) need.push(t.address);
  }
  if (need.length) {
    const rows = dsRows(await dsPairs(need.slice(0, 60)).catch(() => []), ethUsd);
    for (const t of list) if (t.priceUsd == null && rows.get(t.address)) { const r = rows.get(t.address); t.priceUsd = r.priceUsd; t.change24h = r.change24h; t.image ||= r.image; }
  }
  for (const t of list) t.valueUsd = t.priceUsd != null ? t.amount * t.priceUsd : null;
  return { ethUsd, list: list.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1)) };
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
    const [{ list, ethUsd }, tr] = await Promise.all([walletTokens(a).then((l) => priced(l.map((x) => ({ ...x })))), blockscoutApi(`/addresses/${a}/token-transfers?token=${t}`)]);
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
    for (const r of rows) {
      const f = await txFlows(r.hash, a).catch(() => null);
      if (!f || f.failed) continue;
      const net = r.in - r.out;
      const paidEth = f.ethOut - f.ethIn + (f.wethOut - f.wethIn) + (ethUsd ? (f.usdgOut - f.usdgIn) / ethUsd : 0);
      if (net > 0) {
        if (paidEth > 1e-12) { costEth += paidEth; bought += net; buys++; } else transfersIn += net;
      } else if (net < 0) {
        if (-paidEth > 1e-12) { proceedsEth += -paidEth; sold += -net; sells++; } else transfersOut += -net;
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
      priceUsd, ethUsd, partial: (tr?.next_page_params != null) || byTx.size > 40,
      note: "In ETH terms at today's ETH price; gas not counted. Tokens received by plain transfer are not counted as bought.",
    };
  });
}

export async function register(r) {
  r.get("/api/portfolio/tokens", async ({ query }) => {
    const a = addrOf(query.address, "wallet");
    const { ethUsd, list } = await priced((await walletTokens(a)).map((x) => ({ ...x })));
    const tokens = list.map(({ rate, icon, ...t }) => t);
    return { address: getAddress(a), ethUsd, tokens, totalUsd: tokens.reduce((s, t) => s + (t.valueUsd || 0), 0), source: hasBlockscout() ? "Blockscout" : "chain", at: Date.now() };
  }, { weight: 2, perMin: 60 });
  r.get("/api/portfolio/pnl", async ({ query }) => tokenPnl(query.address, query.token), { weight: 4, perMin: 60 });
}
