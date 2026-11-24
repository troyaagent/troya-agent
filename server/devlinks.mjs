// V8 Dev side wallets. A question from the community on X (21 Nov 2026): "Many developers don't buy where they launch
// their tokens, they buy elsewhere and sell them, how do you overcome this?" And from the live Arena (19 Nov): wallets
// that sold together passed Ring Radar because they did not buy in the first seconds. For one coin, this finds the
// wallets tied to its dev and what they hold and sold, read from Robinhood Chain (Chainstack first) and Blockscout PRO:
//   · launch   wallets the dev freed from the Pons snipe tax in the launch call, and the wallet its first buy went to
//   · coins    wallets the dev sent coins to (directly or through a contract in the same transaction), wallets that
//              sent coins to the dev, one hop further from those, and wallets several dev-side wallets gathered coins into
//   · ETH      wallets that got ETH from the dev or sent it ETH, the dev's own funders (its first ETH, and wallets that
//              sent it ETH in the day before the launch) and the other wallets those funders paid, when a funder is a
//              small wallet (an exchange, bridge, bot app or launcher funds thousands and links nobody); on a deep read,
//              also the first funder of the biggest holders, sellers and earliest buyers: three or more of them first
//              paid by one small wallet are a cluster
//   · trades   three or more wallets buying or selling in one block through the same private contract (a busy public
//              router is a crowd of strangers: reported as a herd, never a link)
// A cluster that touches the dev side joins it. The report: how many wallets, how much of the supply they hold, what the
// dev side got and sold, and when. Only wallets that touched the coin count; contracts are left out.
// Feeds: the Gate ("Dev side wallets" on a buy, robinhood.mjs gateCheck), the Gate API flags (devLinkFlags), Aegis
// (sells by these wallets raise dev-linked-sell; a red one builds the exit). Alerts and facts only: nothing here trades.
//   GET /api/devlinks/:token    ?deep=0 for the fast read · cached 30 s (first 10 minutes), 90 s (first hour), 3 min (first
//                               day), 15 min (3 days), 1 h after
import { getAddress, isAddress, zeroPadValue } from "ethers";
import { rpc, ADDR, CHAINS, ponsState } from "./robinhood.mjs";

const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const LAUNCH_AND_BUY = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const pct = (a, s) => (s > 0n ? Number((a * 1_000_000n) / s) / 10_000 : 0);
const r2 = (x) => Math.round(x * 100) / 100;
const big = (h) => { try { return BigInt(h && h !== "0x" ? h : 0); } catch { return 0n; } };
const at = (t) => "0x" + String(t).slice(26).toLowerCase();
// venues: where coins are bought and sold. A coin's curve and pools are added per coin, and so are the relays (contracts
// that pass the coin between a wallet and a venue in one transaction, like a trading bot's router)
const PUBLIC = new Set([ADDR.poolManager, ADDR.universalRouter, ADDR.swapRouter02, ADDR.permit2, ADDR.ponsFactory, ADDR.ponsHook, LAUNCH_AND_BUY,
  "0x204faca1764b154221e35c0d20abb3c525710498", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",                     // Uniswap, KyberSwap routers
  "0x73991a25c818bf1f1128deaab1492d45638de0d3", "0x58daec3116aae6d93017baaea7749052e8a04fa7"].map(lc));             // Uniswap v3 / v4 position managers
const HUB_TXS = 3000;          // a wallet with more transactions than this (exchange, bot operator, launcher) links nobody by paying them
const SMALL_TXS = 300;         // a funder this small links every wallet it paid; up to HUB_TXS, only those paid within a day of the dev
const PUBLIC_TXS = 50_000;     // a contract this busy is a public app: wallets trading through it in one block are a herd
const OWN_TXS = 2_000;         // a router this small is someone's own contract: every wallet trading through it is a cluster
                               // (bot apps and bundler services seen on Robinhood Chain have 8,000 to 50,000,000 transactions)
const DAY_S = 86_400, BLOCKS_A_DAY = 864_000;   // Robinhood Chain: about 0.1 s blocks
const MAX_TRANSFERS = 20_000;  // a busy coin is read on its newest transfers; the dev's own transfers are read in full
const WIDE = 300_000;          // up to this many blocks, rpc() serves a log read from Chainstack in 9,000-block pieces
const BATCH = /disperse|multi.?send|multi.?transfer|batch|airdrop|distribut|bulk/i;
// What decides is what the dev side still holds, and selling while it holds. What it already sold is said, never decides:
// in the Arena's 44 coins (19 to 21 Nov) a dev side selling its launch buy came before winners as often as before losers.
export const RULES = {
  failHold: 30, failHoldLinked: 2,                  // fail: 2+ linked wallets and the dev side together hold 30%+ of the supply
  failSellingNow: 2, failSellingHold: 10,           //   or the dev side sold 2%+ in the last 10 minutes and still holds 10%+
  warnSideHold: 3, warnDevSideHold: 20,            // warn: linked wallets hold 3%+, the dev side holds 20%+,
  warnSellingNow: 1, warnSellingHold: 5, nowMin: 10, //   the dev side sold 1%+ in the last 10 minutes and still holds 5%+,
  warnClusterHold: 20,                              //   or clusters not tied to the dev hold 20%+
};

let store = null;
export function initDevLinks(s) { store ||= s; }

/* ---------- caches ---------- */
const memo = new Map();        // token → { at, res, ttl }
const inflight = new Map();
const info = new Map();        // address → { txs, contract, at }
const blocks = new Map();      // block → { at, txs: Map(hash → { from, to }) }
const codes = new Map();       // address → is a contract (an EIP-7702 account is a wallet)
let saved = null, saveT = null, assayF = null;   // devlinks-cache.json: first funders and births never change
async function disk() {
  if (saved) return saved;
  saved = (await store?.readJson("devlinks-cache.json", {}).catch(() => null)) || {};
  saved.funders ||= {}; saved.launch ||= {};
  return saved;
}
function save() {
  if (!store || saveT) return;
  saveT = setTimeout(async () => {
    saveT = null;
    const f = Object.entries(saved.funders);
    if (f.length > 20_000) saved.funders = Object.fromEntries(f.slice(-15_000));
    await store.writeJson("devlinks-cache.json", saved).catch(() => {});
  }, 5_000);
  saveT.unref?.();
}

/* ---------- Blockscout PRO ---------- */
// Its own spacing (one call every 150 ms) beside market.mjs's shared client, both well under the plan's 15 a second. A
// 402 or 429 pauses this reader for 15 minutes; market.mjs's own pause (out of credits) is honoured too.
const BS = "https://api.blockscout.com/4663/api/v2";
let bsNext = 0, bsPause = 0, market = null;
async function bs(path) {
  const key = process.env.BLOCKSCOUT_API_KEY || "";
  if (!key) throw new Error("no Blockscout PRO key");
  if (Date.now() < bsPause) throw new Error("Blockscout paused");
  market ||= await import("./market.mjs").catch(() => ({}));
  if (market.hasBlockscout && !market.hasBlockscout()) throw new Error("Blockscout paused");
  const wait = Math.max(0, bsNext - Date.now()); bsNext = Date.now() + wait + 150;
  if (wait) await new Promise((ok) => setTimeout(ok, wait));
  for (let i = 0; i < 2; i++) {
    const res = await fetch(BS + path, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch((e) => ({ ok: false, status: 0, e }));
    if (res.status === 402 || res.status === 429) { bsPause = Date.now() + 15 * 60_000; throw new Error(`Blockscout ${res.status}`); }
    if (res.ok) return res.json();
    if (res.status === 404 || res.status === 422) return null;
    if (i) throw new Error(`Blockscout ${res.status || res.e?.message}`);
    await new Promise((ok) => setTimeout(ok, 600));
  }
}
async function bsPages(path, { pages = 2, stop } = {}) {
  const out = [];
  let q = "";
  for (let i = 0; i < pages; i++) {
    const j = await bs(path + (q ? (path.includes("?") ? "&" : "?") + q : ""));
    const items = j?.items || [];
    out.push(...items);
    if (!j?.next_page_params || !items.length || stop?.(items)) break;
    q = new URLSearchParams(Object.entries(j.next_page_params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
  }
  return out;
}
async function infoOf(a) {
  a = lc(a);
  const h = info.get(a);
  if (h && Date.now() - h.at < 6 * 3600_000) return h;
  const [c, d] = await Promise.all([bs(`/addresses/${a}/counters`).catch(() => null), codes.has(a) ? null : bs(`/addresses/${a}`).catch(() => null)]);
  if (d) codes.set(a, !!d.is_contract);
  const v = { txs: c ? Number(c.transactions_count || 0) : null, contract: codes.get(a) ?? null, at: Date.now() };
  info.set(a, v);
  if (info.size > 5000) info.delete(info.keys().next().value);
  return v;
}
const ok = (t) => t && t.status !== "error" && t.result !== "error" && t.success !== false;
const tx = (t, kind) => ({ from: lc(t.from?.hash), to: lc(t.to?.hash), toContract: !!t.to?.is_contract, fromContract: !!t.from?.is_contract, value: big(t.value),
  block: Number(t.block_number), at: Date.parse(t.timestamp) || 0, tx: lc(t.hash || t.transaction_hash), method: t.method || null, kind });

/** A wallet's first ETH: the earliest transaction paying it, or the contract call it came through (bridge, exchange, bot
 *  app, batch sender: then the contract and the wallet that sent that call are named). Kept for good. */
async function firstFunder(w) {
  w = lc(w);
  const d = await disk();
  if (d.funders[w]) return d.funders[w];
  if (!assayF || Date.now() - assayF.at > 10 * 60_000) assayF = { at: Date.now(), v: (await store?.readJson("assay-funders.json", {}).catch(() => null)) || {} };
  const a = assayF.v[w];
  if (a?.funder) return (d.funders[w] = { funder: lc(a.funder), block: a.block ?? null, tx: a.tx || null, how: "direct", src: "assay" });
  const asc = await bs(`/addresses/${w}/transactions?sort=block_number&order=asc`);
  if (!asc) return null;
  const items = (asc.items || []).filter(ok).map((t) => tx(t, "tx"));
  const firstIn = items.find((t) => t.to === w && t.value > 0n), firstOut = items.find((t) => t.from === w);
  let r;
  if (firstIn && (!firstOut || firstIn.block <= firstOut.block)) {
    r = firstIn.fromContract ? { funder: null, via: firstIn.from, block: firstIn.block, at: firstIn.at, tx: firstIn.tx, how: "contract" }
      : { funder: firstIn.from, block: firstIn.block, at: firstIn.at, tx: firstIn.tx, eth: Number(firstIn.value) / 1e18, how: "direct" };
  } else {
    const int = (await bsPages(`/addresses/${w}/internal-transactions?filter=to`, { pages: 1 })).filter(ok).map((t) => tx(t, "internal")).filter((t) => t.to === w && t.value > 0n).sort((x, y) => x.block - y.block);
    const e = int[0];
    if (e && (!firstOut || e.block <= firstOut.block)) {
      const t = await bs(`/transactions/${e.tx}`).catch(() => null);
      r = { funder: null, via: e.from, viaFrom: lc(t?.from?.hash) || null, block: e.block, at: e.at, tx: e.tx, eth: Number(e.value) / 1e18, how: "contract" };
    } else r = { funder: null, how: "unknown", block: firstOut?.block ?? null };
  }
  d.funders[w] = r;
  save();
  return r;
}

/** ETH in and out of a wallet since a block: value transfers, ETH out of contracts, and batch sends (newest first). */
async function ethOf(w, sinceBlock) {
  const stop = (items) => items.some((x) => Number(x.block_number) < sinceBlock);
  const [txs, internal] = await Promise.all([
    bsPages(`/addresses/${w}/transactions`, { pages: 4, stop }).catch(() => []),
    bsPages(`/addresses/${w}/internal-transactions`, { pages: 2, stop }).catch(() => []),
  ]);
  const t1 = txs.filter(ok).map((t) => tx(t, "tx"));
  const all = [...t1, ...internal.filter(ok).map((t) => tx(t, "internal"))].filter((t) => t.block >= sinceBlock);
  const out = all.filter((t) => t.from === w && t.value > 0n && t.to), inn = all.filter((t) => t.to === w && t.value > 0n);
  // ETH sent through a batch sender: the contract pays the wallets inside the same transaction
  for (const b of out.filter((t) => t.toContract && t.kind === "tx" && !PUBLIC.has(t.to) && BATCH.test(t.method || "")).slice(0, 3)) {
    const legs = (await bsPages(`/transactions/${b.tx}/internal-transactions`, { pages: 1 }).catch(() => [])).filter(ok).map((t) => tx(t, "internal"));
    for (const l of legs) if (l.from === b.to && l.value > 0n && l.to && l.to !== w) out.push({ ...l, from: w, via: b.to, kind: "batch" });
  }
  return { out, in: inn };
}

/* ---------- chain reads ---------- */
async function headBlock() { return Number(BigInt(await rpc("robinhood", "eth_blockNumber", []))); }
async function blockTime(n) {
  const b = await rpc("robinhood", "eth_getBlockByNumber", [hex(n), false], { timeoutMs: 12_000 }).catch(() => null);
  return b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : 0;
}
async function codeOf(addrs) {
  const todo = [...new Set(addrs.map(lc))].filter((a) => a && !codes.has(a)).slice(0, 150);
  for (let i = 0; i < todo.length; i += 12) {
    await Promise.all(todo.slice(i, i + 12).map(async (a) => {
      const c = await rpc("robinhood", "eth_getCode", [a, "latest"], { timeoutMs: 10_000 }).catch(() => null);
      if (c != null) codes.set(a, c !== "0x" && !lc(c).startsWith("0xef0100"));
    }));
  }
  while (codes.size > 30_000) codes.delete(codes.keys().next().value);
}
async function balancesOf(token, ws) {
  const out = new Map();
  for (let i = 0; i < ws.length; i += 15) {
    await Promise.all(ws.slice(i, i + 15).map(async (w) => {
      const r = await rpc("robinhood", "eth_call", [{ to: token, data: "0x70a08231" + w.slice(2).padStart(64, "0") }, "latest"], { timeoutMs: 10_000 }).catch(() => null);
      if (r) out.set(w, big(r));
    }));
  }
  return out;
}
// Log reads: up to WIDE blocks, rpc() splits a read that names the official RPC into Chainstack pieces (the paid node)
// and only falls back to the official RPC. Wider spans go to the official RPC with one value per topic position and stay
// 100 blocks under the head (its newest blocks are not always there yet); the newest 100 blocks come from Chainstack.
// A span with too many logs is halved, newest half first, until the cap.
async function logs(filter, from, to, head, acc = { out: [], partial: false, from: to + 1 }, depth = 0) {
  if (from > to) return acc;
  const safe = Math.min(to, head - 100);
  if (to > safe) {
    const tail = await rpc("robinhood", "eth_getLogs", [{ ...filter, fromBlock: hex(Math.max(from, safe + 1)), toBlock: hex(to) }], { timeoutMs: 15_000 });
    acc.out.push(...(tail || []));
    acc.from = Math.min(acc.from, Math.max(from, safe + 1));
    if (from > safe) return acc;
    to = safe;
  }
  if (acc.out.length >= MAX_TRANSFERS) { acc.partial = true; return acc; }
  try {
    const got = await rpc("robinhood", "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }], { only: CHAINS.robinhood.wide, timeoutMs: to - from > WIDE ? 45_000 : 20_000 });
    acc.out.push(...(got || []));
    acc.from = Math.min(acc.from, from);
    return acc;
  } catch (e) {
    if (depth >= 16 || to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    await logs(filter, mid + 1, to, head, acc, depth + 1);
    if (acc.out.length < MAX_TRANSFERS) await logs(filter, from, mid, head, acc, depth + 1); else acc.partial = true;
    return acc;
  }
}
const compact = (l) => ({ from: at(l.topics[1]), to: at(l.topics[2]), v: big(l.data), block: Number(BigInt(l.blockNumber)), li: Number(BigInt(l.logIndex || 0)),
  tx: lc(l.transactionHash), ts: l.blockTimestamp && Number(BigInt(l.blockTimestamp)) > 0 ? Number(BigInt(l.blockTimestamp)) * 1000 : 0 });

/** The coin's birth: Blockscout names the transaction that created the contract (kept for good). */
async function launchOf(token) {
  const d = await disk();
  if (d.launch[token]) return d.launch[token];
  const a = await bs(`/addresses/${token}`).catch(() => null);
  const h = a?.creation_transaction_hash || a?.creation_tx_hash;
  let r = null;
  if (h) {
    const t = await rpc("robinhood", "eth_getTransactionByHash", [h], { timeoutMs: 12_000 }).catch(() => null);
    if (t?.blockNumber) r = { block: Number(BigInt(t.blockNumber)), tx: lc(h), from: lc(t.from), creator: lc(a.creator_address_hash) };
  }
  if (!r) {   // no Blockscout: the Pons launch log (Ring Radar's reader, about two days back)
    const f = await (await import("./ringradar.mjs")).findLaunchTx(token).catch(() => null);
    if (f) r = { block: f.block, tx: lc(f.tx), from: null, creator: null };
  }
  if (r) { d.launch[token] = r; save(); }
  return r;
}
// a Pons launch call names wallets of the dev's own choosing: the snipe-tax exemptions and the first buy's recipient
async function launchCallOf(token, r) {
  if (r.call) return r.call;
  const c = await (await import("./ringradar.mjs")).launchCall(r.tx).catch(() => null);
  if (!c) return null;
  r.call = { exemptions: c.exemptions.slice(0, 40), firstBuyRecipient: c.firstBuyRecipient, deployer: c.deployer, decoded: c.decoded };
  (await disk()).launch[token] = r; save();
  return r.call;
}

/** One block's transactions with the contract each was sent to (kept). */
async function blockTxs(n) {
  if (blocks.has(n)) return blocks.get(n);
  const b = await rpc("robinhood", "eth_getBlockByNumber", [hex(n), true], { timeoutMs: 12_000 }).catch(() => null);
  if (!b) return null;
  const v = { at: Number(BigInt(b.timestamp || 0)) * 1000, txs: new Map((b.transactions || []).map((t) => [lc(t.hash), { from: lc(t.from), to: lc(t.to) }])) };
  blocks.set(n, v);
  if (blocks.size > 4000) blocks.delete(blocks.keys().next().value);
  return v;
}

/* ---------- venues ---------- */
function venuesOf(tr, base) {
  // a relay takes the coin from a wallet and hands it to a venue in the same transaction, or the other way round
  const venue = new Set(base);
  const byTx = new Map();
  for (const x of tr) { if (!byTx.has(x.tx)) byTx.set(x.tx, []); byTx.get(x.tx).push(x); }
  for (let pass = 0; pass < 2; pass++) for (const xs of byTx.values()) {
    if (xs.length < 2 || xs.length > 40) continue;
    for (const a of xs) for (const b of xs) if (a !== b && a.to === b.from && a.to !== ZERO && a.to !== DEAD && !venue.has(a.to) && (venue.has(b.to) || venue.has(a.from))) venue.add(a.to);
  }
  return { venue, byTx };
}

/* ---------- the facts of one coin (read once; the analysis replays them at any block) ---------- */
async function facts(token, { deep = true, toBlock = null } = {}) {
  const t = lc(token);
  const head = await headBlock();
  const end = Math.min(head, toBlock ?? head);
  const [ps, supplyHex, launch] = await Promise.all([
    ponsState(t).catch(() => null),
    rpc("robinhood", "eth_call", [{ to: t, data: "0x18160ddd" }, "latest"], { timeoutMs: 12_000 }).catch(() => "0x0"),
    launchOf(t),
  ]);
  const supply = big(supplyHex);
  if (!launch || !supply) return { token: t, unknown: !launch ? "no birth block found" : "no supply" };
  if (ps) await launchCallOf(t, launch);
  const symbol = await rpc("robinhood", "eth_call", [{ to: t, data: "0x95d89b41" }, "latest"], { timeoutMs: 10_000 })
    .then((h) => { const n = Number(BigInt("0x" + h.slice(66, 130))); return Buffer.from(h.slice(130, 130 + n * 2), "hex").toString("utf8") || null; }).catch(() => null);
  const devs = [...new Set((ps ? [ps.deployer, ps.creatorFeeRecipient] : [launch.creator, launch.from]).map(lc).filter((a) => a && a !== ZERO && isAddress(a)))];
  await codeOf(devs);
  const devWallets = devs.filter((a) => codes.get(a) === false);
  const curve = ps ? lc(ps.curve) : null;
  const F = { token: t, symbol, supply, head, end, launch, curve, devs, devWallets, deep, eth: {}, funders: [], pfund: {}, coTrades: [], via: {}, funderInfo: {}, pools: [], errors: [] };

  // every transfer since the birth (newest first past the cap), plus the dev's own transfers in full
  const hist = await logs({ address: t, topics: [T_TRANSFER] }, launch.block, end, head);
  let transfers = hist.out.map(compact);
  if (hist.partial) {
    for (const d of devs) for (const pos of [1, 2]) {
      const topics = pos === 1 ? [T_TRANSFER, zeroPadValue(d, 32)] : [T_TRANSFER, null, zeroPadValue(d, 32)];
      const more = await logs({ address: t, topics }, launch.block, Math.min(end, hist.from - 1), head).catch(() => ({ out: [] }));
      transfers.push(...more.out.map(compact));
    }
  }
  const seen = new Set();
  transfers = transfers.filter((x) => { const k = `${x.tx}:${x.li}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.block - b.block || a.li - b.li);
  F.transfers = transfers; F.partial = hist.partial;

  // block → time: Chainstack's logs carry it; the official RPC's say 0, so those are placed between known blocks
  const anchors = new Map();
  for (const x of transfers) if (x.ts) anchors.set(x.block, x.ts);
  if (!anchors.has(launch.block)) anchors.set(launch.block, await blockTime(launch.block));
  if (!anchors.has(end)) anchors.set(end, end === head ? Date.now() : await blockTime(end));
  const pts = [...anchors.entries()].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  F.tsOf = (n) => {
    if (anchors.get(n)) return anchors.get(n);
    if (!pts.length) return 0;
    let lo = 0, hi = pts.length - 1;
    if (n <= pts[0][0]) return pts[0][1] - (pts[0][0] - n) * 100;
    if (n >= pts[hi][0]) return pts[hi][1] + (n - pts[hi][0]) * 100;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= n) lo = m; else hi = m; }
    const [b0, t0] = pts[lo], [b1, t1] = pts[hi];
    return Math.round(t0 + ((t1 - t0) * (n - b0)) / (b1 - b0));
  };
  for (const x of transfers) if (!x.ts) x.ts = F.tsOf(x.block);
  F.bornAt = F.tsOf(launch.block);

  // venues found per coin: pools (a contract with token0(), for a coin that is not on a Pons curve) and routers (a contract
  // that trades the coin with many wallets, or takes it from 3+ wallets and passes most of it to a venue, like a trading
  // bot's contract that holds coins between transactions)
  const peers = new Map(), flow = new Map();
  const known = new Set([...PUBLIC, curve].filter(Boolean));
  const fl = (a) => flow.get(a) || flow.set(a, { from: new Set(), to: new Set(), got: 0n, toV: 0n, fromV: 0n, sent: 0n }).get(a);
  for (const x of transfers) {
    for (const [a, b] of [[x.from, x.to], [x.to, x.from]]) { if (!peers.has(a)) peers.set(a, new Set()); const s = peers.get(a); if (s.size < 12) s.add(b); }
    if (x.from === ZERO) continue;
    const r = fl(x.to); r.got += x.v; if (known.has(x.from)) r.fromV += x.v; else if (r.from.size < 5) r.from.add(x.from);
    const q = fl(x.from); q.sent += x.v; if (known.has(x.to)) q.toV += x.v; else if (q.to.size < 5) q.to.add(x.to);
  }
  const cand = [...new Set([...[...peers.entries()].filter(([, s]) => s.size >= 10).map(([a]) => a),
    ...[...flow.entries()].filter(([, r]) => (r.from.size >= 3 && r.toV * 10n >= r.got * 7n) || (r.to.size >= 3 && r.fromV * 10n >= r.sent * 7n)).map(([a]) => a)])]
    .filter((a) => !known.has(a) && a !== ZERO && a !== DEAD && !devs.includes(a)).slice(0, 40);
  await codeOf(cand);
  const venuesFound = cand.filter((a) => codes.get(a) === true);
  F.pools = []; F.routers = [];
  await Promise.all(venuesFound.map(async (a) => {
    const r = await rpc("robinhood", "eth_call", [{ to: a, data: "0x0dfe1681" }, "latest"], { timeoutMs: 10_000 }).catch(() => null);
    (r && r !== "0x" && r.length >= 66 ? F.pools : F.routers).push(a);
  }));
  const base = new Set([...PUBLIC, curve, ...F.pools, ...F.routers].filter(Boolean));

  const bsOn = !!process.env.BLOCKSCOUT_API_KEY;
  if (!bsOn) F.errors.push("no Blockscout PRO key: ETH links and funders not read");
  // the dev's ETH (about a week before the launch to now). A busy dev wallet (a launch service, a bot) links nobody by ETH
  const since = Math.max(0, launch.block - 7 * BLOCKS_A_DAY);
  if (bsOn) for (const d of devWallets.slice(0, 2)) {
    const inf = await infoOf(d).catch(() => null);
    if (inf?.txs != null && inf.txs > HUB_TXS) { F.errors.push(`the dev wallet ${short(d)} is busy (${inf.txs} transactions): its ETH links were not used`); continue; }
    try { F.eth[d] = await ethOf(d, since); } catch (e) { F.errors.push(`dev ETH ${short(d)}: ${e.message}`); }
  }
  // the dev's funders: its first ETH, and wallets that paid it in the day before the launch
  const fset = new Map();
  if (bsOn) for (const d of devWallets.slice(0, 2)) {
    const ff = await firstFunder(d).catch(() => null);
    if (ff?.funder) fset.set(ff.funder, { funder: ff.funder, why: "its first ETH", block: ff.block, at: ff.at, tx: ff.tx || null });
    else if (ff?.how === "contract" && ff.viaFrom && ff.viaFrom !== d) fset.set(ff.viaFrom, { funder: ff.viaFrom, why: `its first ETH, through ${short(ff.via)}`, block: ff.block, at: ff.at, via: ff.via, tx: ff.tx || null });
    for (const i of F.eth[d]?.in || []) {
      if (i.fromContract || !i.from || devs.includes(i.from) || i.block > launch.block || i.at < F.bornAt - DAY_S * 1000) continue;
      if (!fset.has(i.from)) fset.set(i.from, { funder: i.from, why: "sent it ETH in the day before the launch", block: i.block, at: i.at, tx: i.tx });
    }
  }
  for (const f of [...fset.values()].slice(0, 3)) {
    const inf = await infoOf(f.funder).catch(() => null);
    f.txs = inf?.txs ?? null; f.contract = inf?.contract ?? null;
    f.hub = !!f.contract || f.txs == null || f.txs > HUB_TXS;
    f.paid = [];
    if (!f.hub) {
      const out = (await bsPages(`/addresses/${f.funder}/transactions?filter=from`, { pages: 3 }).catch(() => [])).filter(ok).map((x) => tx(x, "tx"))
        .filter((x) => x.value > 0n && x.to && !x.toContract && !devs.includes(x.to));
      f.paid = out.filter((x) => f.txs <= SMALL_TXS || Math.abs(x.at - (f.at || x.at)) <= DAY_S * 1000).map((x) => ({ to: x.to, block: x.block, at: x.at, eth: Number(x.value) / 1e18, tx: x.tx }));
    }
    F.funders.push(f);
  }

  // a first ledger: who to read deeper (the biggest holders, sellers and buyers, and the first minute's buyers)
  const { venue, byTx } = venuesOf(transfers, base);
  F.relays = [...venue].filter((v) => !base.has(v));
  const bal = new Map(), bought = new Map(), sold = new Map(), firstBuy = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  for (const x of transfers) {
    if (x.from !== ZERO) add(bal, x.from, -x.v);
    add(bal, x.to, x.v);
    const fv = venue.has(x.from), tv = venue.has(x.to);
    if (fv && !tv) { add(bought, x.to, x.v); if (!firstBuy.has(x.to)) firstBuy.set(x.to, x.block); }
    else if (!fv && tv && x.from !== ZERO) add(sold, x.from, x.v);
  }
  const rank = (m) => [...m.entries()].filter(([a, v]) => v > 0n && !venue.has(a) && a !== ZERO && a !== DEAD && !devs.includes(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([a]) => a);
  const early = [...firstBuy.entries()].filter(([, b]) => b <= launch.block + 600).map(([a]) => a);
  F.people = [...new Set([...rank(bal).slice(0, 20), ...rank(sold).slice(0, 12), ...rank(bought).slice(0, 12), ...early.slice(0, 10)])].slice(0, 40);

  // three or more wallets trading in one block: the contract each trade went through
  const perBlock = new Map();
  for (const x of transfers) {
    const fv = venue.has(x.from), tv = venue.has(x.to);
    const side = fv && !tv ? "buy" : !fv && tv && x.from !== ZERO ? "sell" : null;
    if (!side) continue;
    const k = `${x.block}:${side}`;
    if (!perBlock.has(k)) perBlock.set(k, { block: x.block, side, legs: [] });
    perBlock.get(k).legs.push({ w: side === "buy" ? x.to : x.from, v: x.v, tx: x.tx, venue: side === "buy" ? x.from : x.to });
  }
  const crowded = [...perBlock.values()].filter((g) => new Set(g.legs.map((l) => l.w)).size >= 3).sort((a, b) => b.legs.length - a.legs.length).slice(0, 25);
  const contracts = new Set();
  for (const g of crowded) {
    const b = await blockTxs(g.block);
    // the relay or router the coins passed through, else the contract the transaction was sent to
    for (const l of g.legs) l.via = (l.venue !== curve && !PUBLIC.has(l.venue) && !F.pools.includes(l.venue) ? l.venue : null) || b?.txs.get(l.tx)?.to || null;
    const by = new Map();
    for (const l of g.legs) if (l.via) { if (!by.has(l.via)) by.set(l.via, []); by.get(l.via).push(l); }
    for (const [via, legs] of by) {
      const ws = [...new Set(legs.map((l) => l.w))];
      if (ws.length < 3) continue;
      contracts.add(via);
      F.coTrades.push({ block: g.block, at: b?.at || F.tsOf(g.block), side: g.side, via, wallets: ws, amount: legs.reduce((s, l) => s + l.v, 0n), oneTx: new Set(legs.map((l) => l.tx)).size === 1, tx: legs[0].tx });
    }
  }
  // how busy each of those contracts and routers is: a public app's crowd is a herd, a private contract's is a cluster
  for (const c of [...new Set([...contracts, ...F.routers])].slice(0, 10)) {
    const pub = PUBLIC.has(c) || c === curve || F.pools.includes(c);
    const inf = pub || !bsOn ? { txs: null } : await infoOf(c).catch(() => ({ txs: null }));
    F.via[c] = { txs: inf.txs, public: pub || (inf.txs != null && inf.txs >= PUBLIC_TXS), unknown: !pub && inf.txs == null };
  }

  // deep: the first funder of those wallets, and how busy the funders that paid two or more of them are
  if (deep && bsOn) {
    for (let i = 0; i < F.people.length; i += 4) {
      await Promise.all(F.people.slice(i, i + 4).map(async (w) => { const r = await firstFunder(w).catch(() => null); if (r) F.pfund[w] = r; }));
    }
    const count = new Map();
    for (const [w, r] of Object.entries(F.pfund)) { const k = r.funder || (r.viaFrom !== w ? r.viaFrom : null); if (k) count.set(k, (count.get(k) || 0) + 1); }
    for (const [k, n] of [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const inf = await infoOf(k).catch(() => null);
      F.funderInfo[k] = { txs: inf?.txs ?? null, contract: inf?.contract ?? null, n };
    }
  }
  return F;
}

/* ---------- the analysis, at any block (a backtest replays it at the moment of a buy) ---------- */
const CAT = { exempt: "named by the dev in the launch", fromDev: "got coins from the dev", toDev: "sent coins to the dev", ethDev: "moved ETH with the dev", funder: "funded the dev",
  sameFunder: "paid by the dev's funder", fundedSide: "first funded by the dev side", hop: "moved coins with a dev-side wallet", cluster: "in a cluster with the dev side" };
export function analyze(F, cut = F.end, { now = null, balNow = null } = {}) {
  if (F.unknown) return { token: getAddress(F.token), status: "unknown", reason: F.unknown, at: Date.now() };
  const supply = F.supply, devs = new Set(F.devs);
  const tr = F.transfers.filter((x) => x.block <= cut);
  const nowMs = now ?? F.tsOf(cut);
  const { venue, byTx } = venuesOf(tr, new Set([...PUBLIC, F.curve, ...(F.pools || []), ...(F.routers || [])].filter(Boolean)));
  const contract = (a) => codes.get(a) === true;
  const burn = (a) => a === ZERO || a === DEAD;

  const bal = new Map(), S = new Map();
  const st = (w) => (S.has(w) ? S.get(w) : S.set(w, { bought: 0n, sold: 0n, gotIn: 0n, sells: [] }).get(w));
  const add = (w, v) => bal.set(w, (bal.get(w) || 0n) + v);
  const edges = [];
  for (const x of tr) {
    if (x.from !== ZERO) add(x.from, -x.v);
    add(x.to, x.v);
    const fv = venue.has(x.from), tv = venue.has(x.to);
    if (fv && !tv && !burn(x.to)) st(x.to).bought += x.v;
    else if (!fv && tv && x.from !== ZERO) { const s = st(x.from); s.sold += x.v; s.sells.push({ v: x.v, block: x.block, at: x.ts, tx: x.tx, via: x.to }); }
    else if (!fv && !tv && x.from !== ZERO && !burn(x.to) && x.from !== x.to) { edges.push(x); st(x.to).gotIn += x.v; st(x.from); }
  }
  const live = balNow && cut >= F.end;       // a capped history: balances are read from the chain instead of the ledger
  const balOf = (w) => { const v = live && balNow.has(w) ? balNow.get(w) : bal.get(w) || 0n; return v > 0n ? v : 0n; };
  const touched = (w) => S.has(w) || balOf(w) > 0n;

  const L = new Map();   // wallet → { hop, cats: Set, why: [] }
  // ev: what proves the link ({ type: "tx" | "address" | "block", ref }), kept next to its reason (the Cluster map shows it)
  const link = (w, hop, cat, why, ev = null) => {
    if (!w || devs.has(w) || venue.has(w) || burn(w) || contract(w)) return false;
    const e = L.get(w);
    if (e) { e.cats.add(cat); if (!e.why.includes(why) && e.why.length < 4) { e.why.push(why); e.ev.push(ev); } e.hop = Math.min(e.hop, hop); return false; }
    L.set(w, { hop, cats: new Set([cat]), why: [why], ev: [ev] });
    return true;
  };
  const evTx = (hash) => (hash ? { type: "tx", ref: hash } : null), evAddr = (a) => (a ? { type: "address", ref: getAddress(a) } : null);
  const side = (w) => devs.has(w) || L.has(w);
  // the dev's circle: wallets that moved ETH both ways with the dev (an exchange's hot wallet only pays out), and its own
  // funders when they are small. They need not touch the coin: the wallets they first funded join the dev side
  const circle = new Set();
  for (const e of Object.values(F.eth || {})) {
    const outTo = new Set(e.out.filter((o) => o.block <= cut && o.kind !== "batch").map((o) => o.to));
    for (const i of e.in) if (i.block <= cut && !i.fromContract && outTo.has(i.from)) circle.add(i.from);
  }
  for (const f of F.funders || []) if ((f.block == null || f.block <= cut) && !f.contract && f.txs != null && f.txs <= HUB_TXS) circle.add(f.funder);

  // the launch call: wallets the dev freed from the snipe tax, and where its first buy went
  for (const w of F.launch.call?.exemptions || []) link(lc(w), 1, CAT.exempt, "freed from the snipe tax by the dev in the launch", evTx(F.launch.tx));
  if (F.launch.call?.firstBuyRecipient) link(F.launch.call.firstBuyRecipient, 1, CAT.exempt, "got the dev's first buy in the launch", evTx(F.launch.tx));
  // coins to and from the dev, also through a contract inside the same transaction
  const fromDev = new Map(), fromDevTx = new Map();
  for (const x of edges) {
    if (devs.has(x.from)) { fromDev.set(x.to, (fromDev.get(x.to) || 0n) + x.v); if (!fromDevTx.has(x.to)) fromDevTx.set(x.to, x.tx); }
    if (devs.has(x.to) && !devs.has(x.from)) link(x.from, 1, CAT.toDev, "sent coins to the dev", evTx(x.tx));
    if (devs.has(x.from) && contract(x.to)) for (const y of byTx.get(x.tx) || []) if (y.from === x.to && !venue.has(y.to) && !burn(y.to)) { fromDev.set(y.to, (fromDev.get(y.to) || 0n) + y.v); if (!fromDevTx.has(y.to)) fromDevTx.set(y.to, y.tx); }
  }
  for (const [w, v] of fromDev) link(w, 1, CAT.fromDev, `got ${r2(pct(v, supply))}% of the supply from the dev`, evTx(fromDevTx.get(w)));
  // ETH: paid by the dev, or paid the dev
  for (const e of Object.values(F.eth || {})) {
    for (const o of e.out) if (o.block <= cut && o.value >= 10n ** 15n && touched(o.to)) link(o.to, 1, CAT.ethDev, o.kind === "batch" ? "got ETH from the dev through a batch sender" : `got ${r2(Number(o.value) / 1e18)} ETH from the dev`, evTx(o.tx));
    for (const i of e.in) if (i.block <= cut && !i.fromContract && touched(i.from)) link(i.from, 1, CAT.ethDev, `sent ${r2(Number(i.value) / 1e18)} ETH to the dev`, evTx(i.tx));
  }
  // the dev's funders and the other wallets they paid
  for (const f of F.funders || []) {
    if (f.block != null && f.block > cut) continue;
    if (touched(f.funder)) link(f.funder, 1, CAT.funder, `funded the dev (${f.why})`, evTx(f.tx) || evAddr(f.funder));
    for (const p of f.paid || []) if (p.block <= cut && touched(p.to)) link(p.to, 2, CAT.sameFunder, `paid by ${short(f.funder)}, which also funded the dev`, evTx(p.tx) || evAddr(f.funder));
  }

  // clusters: gathered into one wallet, first funded by one small wallet, or trading in one block through a private contract
  const clusters = [], herds = [];
  const recv = new Map();
  for (const x of edges) { if (!recv.has(x.to)) recv.set(x.to, []); recv.get(x.to).push(x); }
  for (const [z, xs] of recv) {
    if (contract(z) || new Set(xs.map((x) => x.from)).size < 3) continue;
    // three or more different wallets sending it coins within about 5 seconds (50 blocks)
    let best = 0;
    for (let i = 0, j = 0; i < xs.length; i++) { while (xs[i].block - xs[j].block > 50) j++; best = Math.max(best, new Set(xs.slice(j, i + 1).map((x) => x.from)).size); }
    if (best >= 3) { const ss = [...new Set(xs.map((x) => x.from))]; clusters.push({ kind: "gathered", why: `${ss.length} wallets sent their coins to ${short(z)}`, wallets: [z, ...ss], at: xs[0].ts, ev: evTx(xs[0].tx) }); }
  }
  const groups = new Map();
  for (const [w, r] of Object.entries(F.pfund || {})) {
    if (r.block != null && r.block > cut) continue;
    const k = r.funder || (r.viaFrom && r.viaFrom !== w ? r.viaFrom : null);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ w, at: r.at || 0, tx: r.tx || null });
  }
  for (const [k, ms] of groups) {
    if (side(k) || circle.has(k)) { for (const m of ms) link(m.w, 2, CAT.fundedSide, `first funded by ${devs.has(k) ? "the dev" : circle.has(k) ? `${short(k)}, which ${(F.funders || []).some((f) => f.funder === k) ? "funded the dev" : "moved ETH both ways with the dev"}` : `${short(k)}, a dev-side wallet`}`, evTx(m.tx) || evAddr(k)); continue; }
    if ((F.funders || []).some((f) => f.funder === k && !f.hub)) { for (const m of ms) link(m.w, 2, CAT.sameFunder, `first funded by ${short(k)}, which also funded the dev`, evTx(m.tx) || evAddr(k)); continue; }
    const fi = F.funderInfo?.[k];
    if (ms.length < 3 || !fi || fi.contract || fi.txs == null || fi.txs > HUB_TXS) continue;
    const ats = ms.map((m) => m.at).filter(Boolean).sort((a, b) => a - b);
    if (fi.txs > SMALL_TXS && ats.length >= 3 && ats.at(-1) - ats[0] > DAY_S * 1000) continue;
    clusters.push({ kind: "funded", why: `${ms.length} of the biggest or earliest wallets got their first ETH from ${short(k)}`, wallets: ms.map((m) => m.w), funder: k, ev: evAddr(k), evOf: Object.fromEntries(ms.filter((m) => m.tx).map((m) => [m.w, evTx(m.tx)])) });
  }
  // wallets that sold through the same private router (its own contract, not a public app), at any time
  for (const r of F.routers || []) {
    const v = F.via?.[r];
    if (!v || v.public || v.unknown || v.txs > OWN_TXS) continue;
    const ws = [...new Set(tr.filter((x) => x.to === r && !venue.has(x.from) && x.from !== ZERO).map((x) => x.from))];
    if (ws.length >= 3) clusters.push({ kind: "one router", why: `${ws.length} wallets traded through the same private contract ${short(r)}${v.txs != null ? ` (${v.txs} transactions)` : ""}`, wallets: ws, via: r, ev: evAddr(r) });
  }
  for (const c of F.coTrades || []) {
    if (c.block > cut) continue;
    const v = F.via?.[c.via];
    const row = { kind: c.side === "buy" ? "bought together" : "sold together", block: c.block, at: c.at, via: c.via, wallets: c.wallets, pctOfSupply: r2(pct(c.amount, supply)), ev: evTx(c.tx) || { type: "block", ref: String(c.block) } };
    if (!v || v.public || v.unknown) { herds.push({ ...row, why: `${c.wallets.length} wallets ${c.side === "buy" ? "bought" : "sold"} in one block through ${short(c.via)}, ${v?.unknown ? "a contract not checked" : `a busy public contract${v?.txs ? ` (${v.txs.toLocaleString("en-US")} transactions)` : ""}`}: a crowd, not a link` }); continue; }
    clusters.push({ ...row, why: `${c.wallets.length} wallets ${c.side === "buy" ? "bought" : "sold"} in one block through the same contract ${short(c.via)}${c.oneTx ? " in one transaction" : ""}` });
  }
  // closure: a wallet that moved coins with the dev side, and a cluster that touches it, join the dev side
  for (let round = 0; round < 3; round++) {
    let grew = false;
    for (const x of edges) if (x.v * 2000n >= supply) {
      if (L.get(x.from)?.hop <= 2 && !side(x.to)) grew = link(x.to, L.get(x.from).hop + 1, CAT.hop, `got coins from ${short(x.from)}, a dev-side wallet`, evTx(x.tx)) || grew;
      if (L.get(x.to)?.hop <= 2 && !side(x.from) && touched(x.from)) grew = link(x.from, L.get(x.to).hop + 1, CAT.hop, `sent coins to ${short(x.to)}, a dev-side wallet`, evTx(x.tx)) || grew;
    }
    for (const c of clusters) if (!c.joined && c.wallets.some(side)) { c.joined = true; for (const w of c.wallets) grew = link(w, 3, CAT.cluster, c.why, c.evOf?.[w] || c.ev || null) || grew; }
    if (!grew) break;
  }

  /* ---------- totals ---------- */
  const linked = [...L.keys()].filter(touched);
  const dside = new Set([...devs, ...linked]);
  const holdOf = (ws) => ws.reduce((s, w) => s + balOf(w), 0n);
  const sideHold = holdOf(linked), devHold = holdOf([...devs]);
  let got = 0n;
  for (const w of dside) got += S.get(w)?.bought || 0n;
  for (const x of edges) if (dside.has(x.to) && !dside.has(x.from)) got += x.v;
  const sells = [...dside].flatMap((w) => (S.get(w)?.sells || []).map((s) => ({ ...s, wallet: w, dev: devs.has(w) }))).sort((a, b) => a.block - b.block);
  const sold = sells.reduce((s, x) => s + x.v, 0n);
  const recent = sells.filter((s) => s.at >= nowMs - RULES.nowMin * 60_000).reduce((s, x) => s + x.v, 0n);
  const linkedSells = sells.filter((s) => !s.dev);
  let together = 0;
  for (let i = 0, j = 0; i < linkedSells.length; i++) { while (linkedSells[i].at - linkedSells[j].at > 60_000) j++; together = Math.max(together, new Set(linkedSells.slice(j, i + 1).map((s) => s.wallet)).size); }
  const loose = clusters.filter((c) => !c.joined);
  const looseWallets = [...new Set(loose.flatMap((c) => c.wallets))].filter((w) => !contract(w) && !venue.has(w) && !dside.has(w));
  const looseHold = holdOf(looseWallets);

  const P = { sideHold: pct(sideHold, supply), devHold: pct(devHold, supply), dsHold: pct(sideHold + devHold, supply), sold: pct(sold, supply), soldOfGot: got > 0n ? Math.min(100, pct(sold, got)) : 0,
    recent: pct(recent, supply), looseHold: pct(looseHold, supply), linkedSold: pct(linkedSells.reduce((s, x) => s + x.v, 0n), supply) };
  const n = linked.length;
  let status = "pass";
  if ((n >= RULES.failHoldLinked && P.dsHold >= RULES.failHold) || (P.recent >= RULES.failSellingNow && P.dsHold >= RULES.failSellingHold)) status = "fail";
  else if ((n && P.sideHold >= RULES.warnSideHold) || P.dsHold >= RULES.warnDevSideHold || P.looseHold >= RULES.warnClusterHold
    || (P.recent >= RULES.warnSellingNow && P.dsHold >= RULES.warnSellingHold)) status = "warn";
  const ago = (ms) => { const s = Math.max(0, Math.round((nowMs - ms) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
  const cats = new Map();
  for (const w of linked) for (const c of L.get(w).cats) cats.set(c, (cats.get(c) || 0) + 1);
  const why = [];
  if (n) why.push(`${n} wallet${n === 1 ? "" : "s"} tied to the dev (${[...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, k]) => `${k} ${c}`).join(", ")}) hold${n === 1 ? "s" : ""} ${r2(P.sideHold)}% of the supply`);
  else why.push("No wallets tied to the dev found");
  if (P.devHold >= 0.01) why.push(`the dev holds ${r2(P.devHold)}%`);
  if (sold > 0n) why.push(`the dev side sold ${r2(P.sold)}% of the supply (${Math.round(P.soldOfGot)}% of what it got), last sale ${ago(sells.at(-1).at)}${P.recent >= 0.1 ? `, ${r2(P.recent)}% in the last ${RULES.nowMin} min` : ""}`);
  if (together >= 3) why.push(`${together} linked wallets sold within one minute of each other`);
  if (loose.length && P.looseHold >= 1) why.push(`${loose.length} other cluster${loose.length === 1 ? "" : "s"} (not tied to the dev) hold${loose.length === 1 ? "s" : ""} ${r2(P.looseHold)}%`);
  const label = status === "fail" ? (P.recent >= RULES.failSellingNow ? "Dev side is selling now" : "Dev side holds most of the supply") : null;
  const sale = (s) => (s ? { at: s.at, block: s.block, tx: s.tx, wallet: getAddress(s.wallet), dev: s.dev } : null);
  const view = (w) => { const s = S.get(w); return { wallet: getAddress(w), why: L.get(w).why, evidence: L.get(w).ev, hop: L.get(w).hop, holdsPct: r2(pct(balOf(w), supply)), boughtPct: r2(pct(s?.bought || 0n, supply)),
    gotPct: r2(pct(s?.gotIn || 0n, supply)), soldPct: r2(pct(s?.sold || 0n, supply)), firstSale: s?.sells?.[0] ? { at: s.sells[0].at, tx: s.sells[0].tx } : null, lastSale: s?.sells?.length ? { at: s.sells.at(-1).at, tx: s.sells.at(-1).tx } : null }; };
  return {
    token: getAddress(F.token), symbol: F.symbol, status, verdict: status === "fail" ? "red" : status === "warn" ? "amber" : "clear", label,
    text: `${why.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()),
    linked: { count: n, holdsPct: r2(P.sideHold), soldPct: r2(P.linkedSold), sellersWithinOneMinute: together },
    devSide: { holdsPct: r2(P.dsHold), devHoldsPct: r2(P.devHold), gotPct: r2(pct(got, supply)), soldPct: r2(P.sold), soldOfGotPct: Math.round(P.soldOfGot), soldLast10MinPct: r2(P.recent),
      firstSale: sale(sells[0]), lastSale: sale(sells.at(-1)) },
    dev: [...devs].map((d) => ({ wallet: getAddress(d), contract: contract(d), holdsPct: r2(pct(balOf(d), supply)), boughtPct: r2(pct(S.get(d)?.bought || 0n, supply)), soldPct: r2(pct(S.get(d)?.sold || 0n, supply)) })),
    funders: (F.funders || []).filter((f) => f.block == null || f.block <= cut).map((f) => ({ wallet: getAddress(f.funder), why: f.why, transactions: f.txs, followed: !f.hub, paid: (f.paid || []).filter((p) => p.block <= cut).length })),
    circle: [...circle].slice(0, 10).map((w) => getAddress(w)),
    wallets: linked.sort((a, b) => (balOf(b) > balOf(a) ? 1 : -1)).slice(0, 60).map(view),
    clusters: loose.slice(0, 8).map((c) => ({ kind: c.kind, why: c.why, wallets: c.wallets.length, holdsPct: r2(pct(holdOf(c.wallets.filter((w) => !contract(w) && !venue.has(w))), supply)), via: c.via ? getAddress(c.via) : undefined, at: c.at || undefined,
      members: c.wallets.filter((w) => !contract(w) && !venue.has(w)).slice(0, 40).map((w) => getAddress(w)), evidence: c.ev || null, memberEvidence: c.evOf ? Object.fromEntries(Object.entries(c.evOf).map(([w, e]) => [getAddress(w), e])) : undefined })),
    herds: herds.slice(0, 6).map((h) => ({ why: h.why, side: h.kind, wallets: h.wallets.length, pctOfSupply: h.pctOfSupply, via: getAddress(h.via), at: h.at })),
    relays: [...venue].filter((v) => !PUBLIC.has(v) && v !== F.curve && !(F.pools || []).includes(v)).slice(0, 10).map((v) => getAddress(v)),
    bornAt: F.bornAt, at: nowMs,
    coverage: { fromBlock: F.launch.block, toBlock: cut, transfers: tr.length, partial: !!F.partial, deep: !!F.deep, people: (F.people || []).length, funded: Object.keys(F.pfund || {}).length, notes: (F.errors || []).slice(0, 3) },
    note: "Facts from the chain, not a judgement of people: a wallet counts as tied to the dev only through coins or ETH that moved between them, a small shared funder, or trades through one private contract. Wallets a dev keeps fully apart (funded from an exchange, trading through public apps) stay hidden.",
    _set: { linked: new Set(linked), devs, loose: new Set(looseWallets), relays: [...venue].filter((v) => !PUBLIC.has(v) && v !== F.curve),
      edges: edges.filter((x) => x.v * 10_000n >= supply).slice(-4000).map((x) => ({ from: x.from, to: x.to, v: x.v, tx: x.tx, block: x.block })), supply },
  };
}

/* ---------- the read, cached ---------- */
async function compute(t, deep) {
  const F = await facts(t, { deep });
  let res = analyze(F);
  if (F.unknown) return res;
  // contracts (lockers, vaults, pools) are not side wallets: read the code of every wallet found, then read again
  const ws = [...res._set.linked, ...res._set.loose].filter((w) => !codes.has(w));
  let balNow = null;
  if (ws.length) await codeOf(ws);
  if (F.partial) balNow = await balancesOf(t, [...res._set.linked, ...res._set.loose, ...F.devs].slice(0, 150));
  if (ws.length || balNow) res = analyze(F, F.end, { balNow });
  return res;
}
// a coin's first minutes change fast (side wallets buy a minute or two in): read again sooner while it is young
const ttlOf = (r) => {
  if (r.status === "unknown") return 60_000;
  const age = Date.now() - (r.bornAt || 0), M = 60_000;
  return age < 10 * M ? 30_000 : age < 60 * M ? 90_000 : age < DAY_S * 1000 ? 3 * M : age < 3 * DAY_S * 1000 ? 15 * M : 60 * M;
};
const sealed = new Map();
/** The report for one coin. waitMs: how long to wait for a read that is not cached (it goes on in the background). */
export async function devLinks(token, { deep = true, waitMs = 30_000, fresh = false, bg = false } = {}) {
  if (!isAddress(String(token || ""))) throw Object.assign(new Error("That is not a token address."), { status: 400 });
  const t = lc(token);
  const hit = memo.get(t);
  if (!fresh && hit && Date.now() - hit.at < hit.ttl && (hit.res.coverage?.deep || !deep)) return hit.res;
  const key = `${t}:${deep ? 1 : 0}`;
  if (!inflight.has(key)) {
    inflight.set(key, slot(() => compute(t, deep), bg).then((res) => {
      memo.set(t, { at: Date.now(), res, ttl: ttlOf(res) });
      if (memo.size > 600) memo.delete(memo.keys().next().value);
      // a fail is sealed once per coin every 6 hours (V7 F35 receipts)
      if (res.status === "fail" && Date.now() - (sealed.get(t) || 0) > 6 * 3600_000) {
        sealed.set(t, Date.now());
        import("./seal.mjs").then((m) => m.seal("devlinks", res.token, publicView(res), `${res.label}: ${res.text}`.slice(0, 150))).catch(() => {});
      }
      return res;
    }).catch((e) => { const res = { token: getAddress(t), status: "unknown", reason: e.message, at: Date.now() }; memo.set(t, { at: Date.now(), res, ttl: 60_000 }); return res; })
      .finally(() => inflight.delete(key)));
  }
  const p = inflight.get(key);
  const r = waitMs > 0 ? await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), waitMs))]) : null;
  return r || (hit?.res ? { ...hit.res, stale: true } : { token: getAddress(t), status: "running", note: "Reading the wallets tied to the dev. Ask again in a few seconds." });
}
// at most two coins read at a time (a first read is about 10 to 60 calls; funders and births are kept for good after).
// A person's read (the Gate, the API) goes first; Aegis's background refreshes take one of the two places at most and
// wait while anyone else does
let active = 0, activeBg = 0;
const waitFg = [], waitBg = [];
async function slot(fn, bg = false) {
  if (bg) { while (active >= 2 || activeBg >= 1 || waitFg.length) await new Promise((ok) => waitBg.push(ok)); activeBg++; }
  else if (active >= 2) await new Promise((ok) => waitFg.push(ok));
  active++;
  try { return await fn(); } finally { active--; if (bg) activeBg--; (waitFg.shift() || waitBg.shift())?.(); }
}
export const publicView = (r) => { if (!r || !r._set) return r; const { _set, ...rest } = r; return rest; };

/** From the cache only (never reads): the last report, or null. */
export function devLinksCached(token) { return memo.get(lc(token))?.res || null; }
/** What Aegis watches on a coin: the linked wallets, the clusters not tied to the dev, and the relays a sale can go
 *  through (cache only; a stale or missing report starts a deep read in the background). */
export function devSideOf(token) {
  const h = memo.get(lc(token));
  if (!h || Date.now() - h.at > h.ttl || !h.res.coverage?.deep) devLinks(token, { deep: true, waitMs: 0, bg: true }).catch(() => {});
  const s = h?.res?._set;
  return s ? { linked: s.linked, loose: s.loose, relays: s.relays, at: h.at, status: h.res.status } : null;
}

/** The Gate's line for a buy: { key, status, label, detail } (pass | warn | fail | skip). Waits at most waitMs. */
export async function gateLine(token, { waitMs = 2500 } = {}) {
  const r = await devLinks(token, { deep: true, waitMs }).catch(() => null);
  const label = "Dev side wallets";
  if (!r || r.status === "running") return { key: "devlinks", status: "skip", label, detail: "Still reading the wallets tied to the dev; check again in a few seconds" };
  if (r.status === "unknown") return { key: "devlinks", status: "skip", label, detail: `Not measured${r.reason ? ` (${r.reason})` : ""}` };
  return { key: "devlinks", status: r.status, label, detail: `${r.label ? `${r.label}. ` : ""}${r.text.replace(/\.$/, "")}` };
}

/** Gate API flags in The Assay's shape, from the cache only. */
export function devLinkFlags(token) {
  const r = devLinksCached(token);
  if (!r || (r.status !== "fail" && r.status !== "warn")) return [];
  return [{ key: "devlinks", level: r.status === "fail" ? "red" : "amber", title: r.status === "fail" ? `Dev side wallets: ${r.label.toLowerCase()}` : "Dev side wallets", detail: r.text }];
}

/** The Cluster map (clusters.mjs) reads first funders, address counters and births through the same caches. */
export { firstFunder, infoOf, launchOf };

/** Tests and audits: read the facts once (up to a block) and replay the analysis at other blocks. Nothing is cached. */
export async function _facts(token, opts) { return facts(lc(token), opts); }
export const _codeOf = codeOf;
export const _codes = codes;

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/devlinks/:token", async ({ params, query }) => {
    if (!isAddress(String(params.token || ""))) { const { HttpError } = await import("./api.mjs"); throw new HttpError(400, "That is not a token address."); }
    return publicView(await devLinks(params.token, { deep: query.deep !== "0", waitMs: 25_000 }));
  }, { weight: 3, perMin: 20 });
}
