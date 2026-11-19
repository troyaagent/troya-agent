// V8 F40 Tribute: is a coin's "revenue", "rewards" or market cap real?
// Built from a community report on X (20 Nov 2026): on Hookr, the Robinhood Chain launchpad of revenue tokens, the only
// income of AGENT CITYr (0x56dC…8547) in its first week was 100 AGENTCITY deposited as a "bonus" by its creator's own
// wallet 0x9a91…02b4. Three checks, read from the chain, Blockscout and DexScreener:
//   · income   who pays the holders, and where that money came from. Payers looked at: a Hookr revenue token and its
//              drop box, the coin itself, its creator, and any address that sent WETH or USDG to several of the biggest
//              wallets. Each payer's income in the window is traced to its senders: trading (pools, Hookr's hook and
//              doors), the creator, wallets the creator funded, outside wallets; and to what it is paid in (ETH and USDG,
//              or the project's own coin).
//   · backing  the market cap against the real money in its pools (the ETH, USDG or stock-token side): the most a seller
//              could ever take out. The idea of market.mjs refreshBacked(), for coins of any age.
//   · volume   volume no real trading explains: a round $50.00M from a few dozen trades, or many times the pool's money
//              (market.mjs fold() rules, plus the real money).
// Verdict: "fake" (a red check), "caution" (an amber one), "clear" (measured, nothing found), "unknown" (nothing to read).
// Read-only: never trades, never moves money.
//   GET /api/tribute/:token   one coin (cached 10 min)
import { Interface, getAddress, isAddress, id as keccakId } from "ethers";
import { rpc, ADDR, CHAINS, ponsState } from "./robinhood.mjs";
import { dsPairs, getEthUsd, blockscoutApi, hasBlockscout, isStock } from "./market.mjs";
import { fundingOf } from "./assay.mjs";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const pad = (a) => "0x" + "0".repeat(24) + lc(a).slice(2);
const at = (t) => "0x" + String(t).slice(26).toLowerCase();
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "?");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const WETH = lc(ADDR.weth), USDG = lc(ADDR.usdg), CBBTC = "0xcec185eb182c47d1ba1efc84e6959e18cd620be4";
const HARD = new Set([ZERO, WETH, USDG, CBBTC]);              // real money on the other side of a pool (stock tokens too)
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const WINDOW = 9_900_000;          // blocks read back (~11 days at ~0.1 s); the official RPC answers 10M blocks per call
const CACHE_MS = 10 * 60_000, BUDGET_MS = 18_000;
const RULES = {
  creatorRed: 50, creatorAmber: 20, ownCoinAmber: 50,           // % of the traced income
  backRed: 400, backRedMinCap: 1e6, backRedLoose: 2000, backMinCap: 1e5, backAmber: 200, backAmberMinCap: 2.5e5,
  avgTradeMax: 50_000, volToLiq: 300, volToReal: 300,
  payees: 3, creatorPayees: 5, creatorPayeesRed: 10, scanHolders: 8,
};
const ERC20 = new Interface(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function name() view returns (string)", "function balanceOf(address) view returns (uint256)", "function owner() view returns (address)"]);
// Hookr revenue tokens (current tokenizer since 29 Oct 2026, and the one before it): hookr.fun/docs/revenue-tokenizer
const HOOKR_TOKENIZERS = new Set(["0x08de138e558a9258c6b4077e8bdeb9ad1fb46a4b", "0xfb3c1501c727f30883cd7b36ec380381af7412ef"]);
const HR = new Interface([
  "function tokenizer() view returns (address)", "function streamManager() view returns (address)", "function dropBox() view returns (address)",
  "function doorCount() view returns (uint256)", "function doorAt(uint256) view returns (tuple(uint8 kind,address target,uint32 gas))",
  "function assetCount() view returns (uint256)", "function assetAt(uint256) view returns (tuple(address currency,uint256 index,uint256 carry,uint128 received,uint128 paid,uint128 pendingStream,uint64 streamEnd,uint64 lastRelease))",
  "function earningSupply() view returns (uint256)",
  "event Synced(address indexed by,uint256 pulledEth,uint256 tip,uint256 bridged)",
  "event BonusDeposited(address indexed from,uint256 indexed asset,uint256 amount)",
  "event IncomeRecognized(uint256 indexed asset,bytes32 indexed sourceId,uint256 amount,uint64 streamEnd)",
  "event Dropped(uint256 indexed dropId,address indexed from,address indexed asset,uint256 amount,uint48 snapshotBlock,uint256 earningSupply)",
  "event Forwarded(address indexed currency,uint256 amount)",
]);
const EV = Object.fromEntries(["Synced", "BonusDeposited", "IncomeRecognized", "Dropped", "Forwarded"].map((n) => [n, HR.getEvent(n).topicHash]));
const DOOR_KIND = ["Hookr pool core", "Hookr pool family", "fee NFT", "Uniswap v4 positions", "outside door", "Uniswap v3 positions", "revenue token shares"];
// money from these is trading: Uniswap, Pons, KyberSwap, and Hookr's hook, cores, claims, recapture, lanes, leg collectors, routers
const VENUES = new Set([ADDR.poolManager, ADDR.universalRouter, ADDR.swapRouter02, ADDR.permit2, ADDR.ponsFactory, ADDR.ponsHook].map(lc).concat([
  "0x204faca1764b154221e35c0d20abb3c525710498", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e",   // PonsV2FeeEscrow: pays Pons creator fees in the coin's pair token
  "0x73991a25c818bf1f1128deaab1492d45638de0d3", "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0x89c9fb50d1f03192230ffb1c279bb6e7d3fe6acc", "0x9a8a1006469ba196f8fefc017a53505c83a060bb", "0x342baa22e202954593b04b7ed1663621e0565d46",
  "0x8d0583b408e2959fa0450c54f749c1a4dad3d335", "0x97d440593912234b78432a030fb5186bd2a3bc86", "0x8ad0ac66dbebcc047e8d216666c925e797e5e52e",
  "0x1172a3cc44ce8e8e3f1f0e58a9a0e9678b7118f8", "0x4a71c270b1520f94064268102aebd744b0de7942", "0xf83569e564d70daebc35950f66a73f2e2b915583",
  "0xa83007ab66cf977132c58f5a138e1e92a005fff3", "0x2b8dd989d34256b7685e3bd8f10299a4891f1af2", "0x7d79010cf29e548b55224f0ceedaed2275d65781",
  "0xc2bc9a3fe6c4ce8c2f7eb4655b0869b01d8c93c9", "0xbc56f48f873841d26a5a02575263d82f68e12864", "0x854f3fa7ac342b244df0d9a8c8f597b051aae559",
  "0x08de138e558a9258c6b4077e8bdeb9ad1fb46a4b", "0xfb3c1501c727f30883cd7b36ec380381af7412ef",
]));
const NOT_PAYER = /router|swap|pool|pair|aggregat|exchange|bridge|vault|zap|dex|universal|multicall|permit|settle|relay|locker|position|curve|manager/i;
const MARKET_NAME = /pons|uniswap|router|swap|pool|pair|escrow|hook|dex|exchange|aggregat|curve|position/i;   // a contract that pays out trading fees
const memo = new Map(), inflight = new Map();

/* ---------- small chain helpers ---------- */
const W = () => CHAINS.robinhood.wide;
const call = (to, data) => rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 10_000 });
const tryRead = (I, to, fn, args = []) => call(to, I.encodeFunctionData(fn, args)).then((r) => I.decodeFunctionResult(fn, r)[0]).catch(() => null);
const CODE = new Map(), POOL = new Map();   // per address, kept while the server runs (capped)
async function isContract(a) {
  if (CODE.size > 20_000) CODE.clear();
  if (!CODE.has(a)) { const c = await rpc("robinhood", "eth_getCode", [a, "latest"], { timeoutMs: 10_000 }).catch(() => "0x"); CODE.set(a, !!c && c !== "0x" && !lc(c).startsWith("0xef0100")); }
  return CODE.get(a);
}
async function isPool(a) {   // a pool answers token0()
  if (POOL.size > 20_000) POOL.clear();
  if (!POOL.has(a)) { const r = await call(a, "0x0dfe1681").catch(() => null); POOL.set(a, !!(r && r !== "0x" && r.length >= 66)); }
  return POOL.get(a);
}
// The official RPC answers 429 when pressed (the rest of the server reads it too): two reads at a time across all checks,
// and a busy answer waits and retries (0.5 s, 1 s, 2 s)
let wideBusy = 0;
const wideQ = [];
async function wideLogs(q, S, retries = 3) {
  while (wideBusy >= 2) await new Promise((r) => wideQ.push(r));
  wideBusy++;
  try {
    for (let i = 0; ; i++) {
      try { return (await rpc("robinhood", "eth_getLogs", [q], { only: W(), timeoutMs: 15_000 })) || []; }
      catch (e) {
        const busy = /429|rate/i.test(e.message);
        if (busy) S.throttled = true;
        if (i >= retries || !busy || S.left() < 5000) throw e;
        await sleep(500 * 2 ** i);
      }
    }
  } finally { wideBusy--; wideQ.shift()?.(); }
}
// logs of one contract over up to 10M blocks (the official RPC's limit with one address and one value per topic; it
// returns 10,000 logs at most). Too many: halve the range, three times at most. split=false gives up instead (null)
async function logs(S, address, topics, { split = true, depth = 0, from = S.from, to = S.head } = {}) {
  try {
    return await wideLogs({ address, topics, fromBlock: hex(from), toBlock: hex(to) }, S, split ? 3 : 0);
  } catch (e) {
    if (!split) { const many = /10000|exceed/i.test(e.message); S.cut(`skipped ${short(lc(topics[2] ? at(topics[2]) : address))}: ${many ? "too many transfers" : String(e.message).slice(0, 60)}`, many); return null; }
    if (depth < 3 && to > from && /10000|exceed|too many/i.test(e.message)) {
      const mid = Math.floor((from + to) / 2);
      const [older, newer] = await Promise.all([logs(S, address, topics, { depth: depth + 1, from, to: mid }), logs(S, address, topics, { depth: depth + 1, from: mid + 1, to })]);
      return [...older, ...newer];
    }
    S.cut(`logs ${short(lc(address))}: ${String(e.message).slice(0, 80)}`);
    return [];
  }
}
const bs = (path) => (hasBlockscout() ? blockscoutApi(path).catch(() => null) : Promise.resolve(null));
// ETH into or out of an address in the window (Blockscout: transactions and internal calls that carry value), newest first
async function ethMoves(S, addr, dir, { internal = true, soft = false } = {}) {
  const out = [];
  for (const kind of internal ? ["transactions", "internal-transactions"] : ["transactions"]) {
    if (S.left() < 4000) { S.cut(`no time for ETH moves of ${short(addr)}`, soft); break; }
    const d = await bs(`/addresses/${addr}/${kind}?filter=${dir}${kind === "internal-transactions" ? "&include_zero_value=false" : ""}`);
    if (!d) continue;
    for (const x of d.items || []) {
      const blk = Number(x.block_number ?? x.block ?? 0), v = BigInt(x.value || 0);
      if (!v || (blk && blk < S.from) || (x.status && x.status !== "ok") || x.success === false) continue;
      out.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), asset: ZERO, v, tx: x.transaction_hash || x.hash, method: x.method || null });
    }
    if (d.next_page_params && (d.items || []).length && Number(d.items.at(-1).block_number) >= S.from) S.cut(`ETH moves of ${short(addr)}: newest 50 only`, soft);   // one page per kind
  }
  return out;
}
async function pmap(list, n, fn) { const out = []; for (let i = 0; i < list.length; i += n) out.push(...(await Promise.all(list.slice(i, i + n).map(fn)))); return out; }
const units = (v, dec) => Number(BigInt(v) / 10n ** BigInt(Math.max(0, dec - 6))) / 10 ** Math.min(6, dec);
const usd = (n) => (n == null ? "?" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`);
const pctS = (x) => (x >= 99.5 && x < 100 ? (Math.floor(x * 10) / 10).toFixed(1) : x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x >= 0.01 ? x.toFixed(2) : x.toPrecision(1)) + "%";
const amt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n >= 1 ? n.toFixed(n >= 100 ? 0 : 2) : n.toPrecision(2));

/* ---------- prices and units of the assets that paid ---------- */
async function assetInfo(S, list) {
  const need = [...new Set(list)].filter((a) => !S.assets.has(a));
  const others = need.filter((a) => !HARD.has(a) && a !== S.t);
  const best = new Map();
  if (others.length) for (const p of await dsPairs(others).catch(() => [])) {
    const b = lc(p.baseToken?.address);
    if (others.includes(b) && (!best.has(b) || (p.liquidity?.usd || 0) > (best.get(b).liquidity?.usd || 0))) best.set(b, p);
  }
  await Promise.all(need.map(async (a) => {
    if (a === ZERO) return S.assets.set(a, { dec: 18, sym: "ETH", usd: S.ethUsd });
    const [dec, sym] = await Promise.all([tryRead(ERC20, a, "decimals"), tryRead(ERC20, a, "symbol")]);
    const price = a === WETH ? S.ethUsd : a === USDG ? 1 : a === S.t ? S.priceUsd : Number(best.get(a)?.priceUsd) || null;
    S.assets.set(a, { dec: dec == null ? 18 : Number(dec), sym: sym || short(a), usd: price });
  }));
}

/* ---------- who made the coin ---------- */
async function creatorsOf(S) {
  const c = new Set();
  const add = (a) => { a = lc(a); if (isAddress(a) && a !== ZERO && a !== DEAD && !VENUES.has(a)) c.add(a); };
  if (S.ps) { add(S.ps.deployer); add(S.ps.creatorFeeRecipient); }
  if (S.hk?.streamManager) add(S.hk.streamManager);
  // the sender of the transaction that created it (Blockscout names the factory for factory-made coins)
  const info = await bs(`/addresses/${S.t}`);
  const ctx = info?.creation_transaction_hash || info?.creation_tx_hash;
  if (ctx) { const tx = await rpc("robinhood", "eth_getTransactionByHash", [ctx], { timeoutMs: 10_000 }).catch(() => null); if (tx?.from) add(tx.from); }
  if (info?.creator_address_hash && !(await isContract(lc(info.creator_address_hash)))) add(info.creator_address_hash);
  const owner = await tryRead(ERC20, S.t, "owner");
  if (owner) add(owner);
  // people only: a launcher, a fee splitter or a distributor contract is not the creator's wallet (Dividend Hound's Pons
  // fee recipient is the contract that pays its holders SPY from trading fees)
  for (const a of [...c]) if (await isContract(a)) c.delete(a);
  return c;
}

/* ---------- a Hookr revenue token ---------- */
async function hookrOf(t) {
  const tz = lc(await tryRead(HR, t, "tokenizer"));
  if (!HOOKR_TOKENIZERS.has(tz)) return null;
  const [sm, box, dc, ac, es] = await Promise.all(["streamManager", "dropBox", "doorCount", "assetCount", "earningSupply"].map((f) => tryRead(HR, t, f)));
  const doors = await Promise.all([...Array(Math.min(16, Number(dc || 0))).keys()].map((i) => tryRead(HR, t, "doorAt", [i])));
  const assets = await Promise.all([...Array(Math.min(8, Number(ac || 0))).keys()].map((i) => tryRead(HR, t, "assetAt", [i])));
  return {
    tokenizer: tz, legacy: tz === "0xfb3c1501c727f30883cd7b36ec380381af7412ef", streamManager: sm ? lc(sm) : null, dropBox: box && lc(box) !== ZERO ? lc(box) : null,
    doors: doors.filter(Boolean).map((d) => ({ kind: Number(d.kind), target: lc(d.target) })), assets: assets.map((a) => (a ? lc(a.currency) : null)), earning: es ? BigInt(es) : 0n,
  };
}

/* ---------- check 1: income ---------- */
// what the payers received in the window, as { from, asset, v, tx, via }
async function inflows(S, hub, assets, { eth = true } = {}) {
  const parts = await Promise.all(assets.filter((a) => a !== ZERO).map(async (a) =>
    (await logs(S, a, [T_TRANSFER, null, pad(hub)])).map((l) => ({ from: at(l.topics[1]), asset: a, v: BigInt(l.data === "0x" ? 0 : l.data), tx: l.transactionHash, via: hub }))));
  const out = parts.flat();
  if (eth) for (const m of await ethMoves(S, hub, "to")) out.push({ ...m, via: hub });
  return out;
}
// a Hookr revenue token's income: ERC-20s from Transfer logs; ETH from its own events (doors' ETH arrives inside syncs)
async function hookrIncome(S) {
  const { t, hk } = S;
  const ercs = hk.assets.filter((a) => a && a !== ZERO);
  const [recs, synced, bonus, recog] = await Promise.all([
    inflows(S, t, ercs, { eth: false }), logs(S, t, [EV.Synced]), logs(S, t, [EV.BonusDeposited]), logs(S, t, [EV.IncomeRecognized, pad(ZERO)]),
  ]);
  const doorEth = synced.reduce((s, l) => { const d = HR.decodeEventLog("Synced", l.data, l.topics); return s + d.pulledEth - d.tip - d.bridged; }, 0n);
  const bonusEth = [];
  for (const l of bonus) { const d = HR.decodeEventLog("BonusDeposited", l.data, l.topics); if (d.asset === 0n) bonusEth.push({ from: lc(d.from), asset: ZERO, v: d.amount, tx: l.transactionHash, via: t }); }
  const ethIn = recog.reduce((s, l) => s + HR.decodeEventLog("IncomeRecognized", l.data, l.topics).amount, 0n);
  // ETH sent straight to the token (not through a door, not a bonus): the senders are its value transactions
  let straight = ethIn - doorEth - bonusEth.reduce((s, r) => s + r.v, 0n);
  if (doorEth > 0n) recs.push({ from: "doors", asset: ZERO, v: doorEth, tx: null, via: t, n: synced.length });
  recs.push(...bonusEth);
  if (straight > 0n) {
    for (const m of (await ethMoves(S, t, "to", { internal: false })).filter((m) => !/bonus/i.test(m.method || "") && !bonusEth.some((b) => b.tx === m.tx))) {
      if (straight <= 0n) break;
      const v = m.v < straight ? m.v : straight; straight -= v;
      recs.push({ ...m, v, via: t });
    }
    if (straight > 0n) recs.push({ from: "unknown", asset: ZERO, v: straight, tx: null, via: t });
  }
  // the drop box shares any asset anyone drops in
  if (hk.dropBox) for (const l of await logs(S, hk.dropBox, [EV.Dropped])) {
    const d = HR.decodeEventLog("Dropped", l.data, l.topics);
    recs.push({ from: lc(d.from), asset: lc(d.asset), v: d.amount, tx: l.transactionHash, via: hk.dropBox });
  }
  // an outside door (an agent's income, a fee right) passes on what others paid into it: look one step further
  for (const door of hk.doors.filter((d) => d.kind === 4).slice(0, 3)) {
    const fromDoor = recs.filter((r) => r.from === door.target && r.asset !== ZERO);
    const fwd = await logs(S, door.target, [EV.Forwarded, pad(ZERO)]);
    const ethFwd = fwd.reduce((s, l) => s + HR.decodeEventLog("Forwarded", l.data, l.topics).amount, 0n);
    const paidIn = await inflows(S, door.target, [...new Set([...ercs, ...fromDoor.map((r) => r.asset)])], { eth: ethFwd > 0n });
    if (!paidIn.length) continue;
    for (const r of fromDoor) r.drop = true;
    if (ethFwd > 0n) { const d = recs.find((r) => r.from === "doors"); if (d) d.v = d.v > ethFwd ? d.v - ethFwd : 0n; }
    for (const p of paidIn) recs.push({ ...p, via: door.target, viaDoor: true });
  }
  return recs.filter((r) => !r.drop && r.v > 0n);
}
// payers outside Hookr: the coin itself, its creator, and whoever sent WETH or USDG to several of the biggest wallets
async function findPayers(S) {
  const holders = S.holders.map((h) => h.a);
  const holderSet = new Set(holders);
  const payers = [];
  // the creator's own outflows: who it paid, and which wallets it funded
  for (const c of [...S.creators].slice(0, 2)) {
    const out = (await Promise.all([...S.payAssets, S.t].map(async (a) => (await logs(S, a, [T_TRANSFER, pad(c)])).map((l) => ({ to: at(l.topics[2]), asset: a, v: BigInt(l.data === "0x" ? 0 : l.data) }))))).flat();
    const eth = await ethMoves(S, c, "from", { internal: false, soft: true });
    for (const x of [...out, ...eth]) if (x.to && x.to !== ZERO && x.to !== DEAD && !VENUES.has(x.to) && !S.poolSet.has(x.to)) { S.funded.add(x.to); S.fundedBy.set(x.to, c); }
    const paid = new Set([...out.filter((x) => x.asset !== S.t), ...eth].map((x) => x.to).filter((a) => holderSet.has(a)));
    if (paid.size >= RULES.creatorPayees) payers.push({ address: c, kind: "creator", payees: paid.size });
  }
  // the coin contract paying holders (dividend and reflection designs): WETH, USDG or ETH out to several wallets
  const outOf = async (hub) => {
    const tok = (await Promise.all(S.payAssets.map(async (a) => (await logs(S, a, [T_TRANSFER, pad(hub)])).map((l) => at(l.topics[2]))))).flat();
    const eth = (await isContract(hub)) ? (await ethMoves(S, hub, "from", { internal: true, soft: true })).map((m) => m.to) : [];
    return new Set([...tok, ...eth].filter((a) => a && !VENUES.has(a) && a !== ZERO));
  };
  // known payout contracts: the coin itself, and a Pons coin's creator-fee recipient when it is a contract
  const hubs = S.hk ? [] : [{ address: S.t, kind: "coin" }];
  const fee = lc(S.ps?.creatorFeeRecipient);
  if (fee && fee !== ZERO && !S.creators.has(fee) && (await isContract(fee))) hubs.push({ address: fee, kind: "fee contract" });
  // a payer pays holders: at least 3 of the 50 biggest, or 10 wallets in all (a tax token paying its team wallets is not one)
  for (const h of hubs) {
    const paid = await outOf(h.address), toHolders = [...paid].filter((a) => holderSet.has(a)).length;
    if (toHolders >= RULES.payees || paid.size >= 10) payers.push({ ...h, payees: paid.size, holdersPaid: toHolders });
  }
  // WETH and USDG into the biggest wallets: one sender paying several of them is a distributor (skipped when a known
  // payout contract already pays them: the time goes to tracing its income instead)
  if (payers.some((p) => p.kind !== "creator") || S.hk) S.cut("holder scan skipped: a payout contract was found", true);
  else if (S.throttled) S.cut("holder scan skipped: the RPC is busy");
  else if (S.left() > 9000) {
    const eoas = S.holders.filter((h) => !h.contract && !S.creators.has(h.a) && h.a !== DEAD).slice(0, RULES.scanHolders).map((h) => h.a);
    const seen = new Map(), read = new Set();
    await pmap(eoas.flatMap((h) => S.payAssets.map((a) => [a, h])), 6, async ([a, h]) => {
      const ls = await logs(S, a, [T_TRANSFER, null, pad(h)], { split: false });
      if (!ls) return;                              // a busy trading wallet: skipped (noted in window.cut)
      read.add(h);
      for (const l of ls) { const f = at(l.topics[1]); if (f === ZERO || f === h || VENUES.has(f) || S.poolSet.has(f)) continue; const k = seen.get(f) || new Set(); k.add(h); seen.set(f, k); }
    });
    S.scanned = read.size;
    const cands = [...seen.entries()].filter(([, s]) => s.size >= RULES.payees).sort((x, y) => y[1].size - x[1].size).slice(0, 4);
    for (const [f, s] of cands) {
      if (payers.some((p) => p.address === f) || (await isPool(f))) continue;
      if (await isContract(f)) { const info = await bs(`/addresses/${f}`); if (NOT_PAYER.test(String(info?.name || "") + " " + String(info?.public_tags?.map?.((x) => x.display_name).join(" ") || ""))) continue; }
      payers.push({ address: f, kind: S.creators.has(f) ? "creator" : "distributor", payees: s.size });
      if (payers.length >= 5) break;
    }
  } else S.cut("no time for the holder scan");
  return payers;
}
const kindOf = (S, a) => (a === "doors" ? "trading" : a === "unknown" ? "unknown" : S.creators.has(a) ? "creator" : S.funded.has(a) ? "creator-funded" : a === ZERO ? "minted"
  : S.doorSet.has(a) || VENUES.has(a) || S.poolSet.has(a) || POOL.get(a) ? "trading" : "outside");
async function incomeCheck(S) {
  const R = { status: "none", windowDays: S.days, payers: [], totalUsd: 0, byKind: {}, ownCoinUsd: 0, creatorPct: 0, ownCoinPct: 0, tradingPct: 0, sources: [], creators: [...S.creators] };
  let recs = [];
  if (S.hk) {
    R.hookr = { tokenizer: S.hk.tokenizer, legacy: S.hk.legacy, dropBox: S.hk.dropBox, streamManager: S.hk.streamManager, doors: S.hk.doors.map((d) => ({ kind: DOOR_KIND[d.kind] || `kind ${d.kind}`, address: d.target })) };
    R.payers.push({ address: S.t, kind: "revenue token", payees: null });
    if (S.hk.dropBox) R.payers.push({ address: S.hk.dropBox, kind: "drop box", payees: null });
    recs = await hookrIncome(S);
  }
  const found = await findPayers(S);
  R.payers.push(...found);
  for (const p of found) {
    if (p.kind === "creator") { R.creatorPays = { address: p.address, payees: p.payees }; continue; }   // the creator's own money, by definition
    recs.push(...(await inflows(S, p.address, [...S.payAssets, S.t])));
  }
  if (!R.payers.length) return R;
  // who the biggest outside senders are: their first ETH, from The Assay's funder records (kept forever per wallet)
  const assets = [...new Set(recs.map((r) => r.asset))];
  await assetInfo(S, assets);
  const val = (r) => { const a = S.assets.get(r.asset); return a?.usd ? units(r.v, a.dec) * a.usd : 0; };
  for (const r of recs) { r.kind = kindOf(S, r.from); r.usd = val(r); }
  // the creator funds wallets; a contract it sent money to (a router, a pool) is not one of its wallets
  for (const a of new Set(recs.filter((r) => r.kind === "creator-funded").map((r) => r.from))) {
    if (!(await isContract(a))) continue;
    S.funded.delete(a); S.fundedBy.delete(a);
    for (const r of recs) if (r.from === a) r.kind = (await isPool(a)) ? "trading" : "outside";
  }
  const outside = [...new Map(recs.filter((r) => r.kind === "outside").sort((a, b) => b.usd - a.usd).map((r) => [r.from, r])).keys()].slice(0, 3);
  await Promise.all(outside.map(async (a) => {
    if (await isContract(a)) {
      const market = (await isPool(a)) || MARKET_NAME.test(String((await bs(`/addresses/${a}`))?.name || ""));
      if (market) for (const r of recs) if (r.from === a) r.kind = "trading";
      return;
    }
    const p = fundingOf(a, S.head).catch(() => null);
    const f = await Promise.race([p, sleep(Math.min(5000, Math.max(0, S.left() - 3000)))]);
    if (f?.funder && S.creators.has(lc(f.funder))) { S.funded.add(a); S.fundedBy.set(a, lc(f.funder)); for (const r of recs) if (r.from === a) r.kind = "creator-funded"; }
  }));
  // what it pays in: ETH and USDG are money; the coin itself, or a coin from the same creator, is not
  const own = new Set([S.t]);
  await Promise.all(assets.filter((a) => !HARD.has(a) && a !== S.t && !isStock(a)).slice(0, 6).map(async (a) => {
    const ps = await ponsState(a).catch(() => null);
    const sym = lc(S.assets.get(a)?.sym).replace(/[^a-z0-9]/g, ""), mine = lc(S.symbol).replace(/[^a-z0-9]/g, "");
    if ((ps && (S.creators.has(lc(ps.deployer)) || S.creators.has(lc(ps.creatorFeeRecipient)))) || (S.hk && sym.length >= 3 && mine.startsWith(sym))) own.add(a);
  }));
  R.ownAssets = [...own].filter((a) => assets.includes(a)).map((a) => S.assets.get(a)?.sym || short(a));
  const total = recs.reduce((s, r) => s + r.usd, 0);
  for (const r of recs) { R.byKind[r.kind] = (R.byKind[r.kind] || 0) + r.usd; if (own.has(r.asset)) R.ownCoinUsd += r.usd; }
  R.totalUsd = total;
  // shares by dollars; when nothing has a price, by payments
  const w = (r) => (total > 0 ? r.usd : 1), wt = recs.reduce((s, r) => s + w(r), 0);
  const share = (f) => (wt > 0 ? (recs.filter(f).reduce((s, r) => s + w(r), 0) / wt) * 100 : 0);
  R.creatorPct = share((r) => r.kind === "creator" || r.kind === "creator-funded");
  R.ownCoinPct = share((r) => own.has(r.asset)); R.tradingPct = share((r) => r.kind === "trading");
  // by sender and asset, biggest first
  const g = new Map();
  for (const r of recs) { const k = `${r.from}|${r.asset}`; const x = g.get(k) || { from: r.from, kind: r.kind, asset: r.asset, v: 0n, usd: 0, txs: 0, fundedBy: S.fundedBy.get(r.from) || null, viaDoor: !!r.viaDoor }; x.v += r.v; x.usd += r.usd; x.txs += r.n || 1; g.set(k, x); }
  R.sources = [...g.values()].sort((a, b) => b.usd - a.usd || (b.v > a.v ? 1 : -1)).slice(0, 12).map((x) => {
    const a = S.assets.get(x.asset);
    return { from: /^0x/.test(x.from) ? getAddress(x.from) : x.from, kind: x.kind, asset: x.asset === ZERO ? "ETH" : getAddress(x.asset), symbol: a?.sym, amount: a ? units(x.v, a.dec) : null, usd: +x.usd.toPrecision(4), txs: x.txs, fundedBy: x.fundedBy && getAddress(x.fundedBy), throughDoor: x.viaDoor || undefined };
  });
  R.unpriced = recs.some((r) => !S.assets.get(r.asset)?.usd);
  // how much of the revenue token the creator's wallets hold: their share of every payout
  if (S.hk?.earning > 0n && S.creators.size) {
    const bal = await Promise.all([...S.creators].map((c) => tryRead(ERC20, S.t, "balanceOf", [c]).then((v) => BigInt(v || 0))));
    R.creatorHoldsPct = +(Number((bal.reduce((s, v) => s + v, 0n) * 1_000_000n) / S.hk.earning) / 10_000).toFixed(2);
  }
  R.status = !recs.length ? (S.hk ? "amber" : "none") : R.creatorPct >= RULES.creatorRed ? "red" : R.creatorPct >= RULES.creatorAmber || R.ownCoinPct >= RULES.ownCoinAmber ? "amber" : "ok";
  if (R.creatorPays) R.status = R.creatorPays.payees >= RULES.creatorPayeesRed ? "red" : R.status === "red" ? "red" : "amber";
  R.counts = { inflows: recs.length };
  return R;
}
function incomeReasons(S, R, vol) {
  const out = [];
  const days = `${R.windowDays} days`;
  if (R.creatorPays) out.push({ level: R.creatorPays.payees >= RULES.creatorPayeesRed ? "red" : "amber", text: `Its creator's own wallet ${short(R.creatorPays.address)} paid ETH or other money straight to ${R.creatorPays.payees} of its biggest holders in the last ${days}: any "rewards" there are the creator's own money.` });
  if (!R.payers.length || (R.status === "none" && !R.creatorPays)) {
    const looked = S.scanned ? `the coin itself, its creator, and ${S.payNames.join(", ")} sent to its ${S.scanned} biggest wallets` : "the coin itself and its creator; its biggest wallets were not scanned this time";
    out.push({ level: "ok", text: `No address was found paying its holders in the last ${days} (looked at: ${looked}), so there is no revenue or reward to test.` });
    return out;
  }
  if (S.hk && !R.totalUsd && !R.sources.length) { out.push({ level: "amber", text: `It is a Hookr revenue token, but no income reached it or its drop box in the last ${days}: there is no revenue behind it yet.` }); return out; }
  const what = R.sources.slice(0, 2).map((s) => `${amt(s.amount)} ${s.symbol}`).join(" and ");
  const tot = R.totalUsd > 0 ? ` (about ${usd(R.totalUsd)})` : "";
  const creatorSrc = R.sources.filter((s) => s.kind === "creator" || s.kind === "creator-funded");
  if (R.creatorPct >= RULES.creatorAmber) {
    const who = creatorSrc.slice(0, 2).map((s) => s.kind === "creator" ? `its creator's own wallet ${short(s.from)}` : `${short(s.from)}, a wallet its creator funded`).join(" and ");
    const all = R.creatorPct >= 99.5;
    out.push({ level: R.creatorPct >= RULES.creatorRed ? "red" : "amber", text: `${all ? "All" : pctS(R.creatorPct)} of the income its holders were paid in the last ${days}${all ? `, ${what}${tot},` : tot} came from ${who}, not from trading fees or outside payers.` });
  }
  if (R.ownCoinPct >= RULES.ownCoinAmber) out.push({ level: "amber", text: `${R.ownCoinPct >= 99.5 ? "All of that income was" : `${pctS(R.ownCoinPct)} of that income was`} paid in ${R.ownAssets.join(" and ")}, the project's own coin, not in ETH or USDG.` });
  if (R.creatorHoldsPct >= 50) out.push({ level: "info", text: `The creator's wallets hold ${pctS(R.creatorHoldsPct)} of the revenue token, so most of what it pays flows back to them.` });
  if (R.tradingPct >= 50 && vol?.status === "red") out.push({ level: "amber", text: `Most of its income is trading fees, but the volume paying those fees looks scripted (see below).` });
  if (!out.some((x) => x.level === "red" || x.level === "amber")) {
    const mix = [["trading", "trading fees"], ["outside", "outside wallets"], ["unknown", "senders not identified"], ["minted", "newly minted coins"]].filter(([k]) => (R.byKind[k] || 0) > 0)
      .map(([k, n]) => `${pctS(R.totalUsd ? (R.byKind[k] / R.totalUsd) * 100 : 0)} ${n}`).join(", ");
    out.push({ level: "ok", text: `Its holders were paid ${what || "income"}${tot} in the last ${days}${mix ? `: ${mix}` : ""}; none of it traced back to the creator's wallets.` });
  }
  if (R.unpriced) out.push({ level: "info", text: "Some of that income is in coins without a market price, so the dollar shares leave them out." });
  return out;
}

/* ---------- checks 2 and 3: backing and volume ---------- */
async function marketChecks(S) {
  const B = { status: "unknown", pools: [] }, V = { status: "unknown", pools: [] };
  if (S.stock) { B.status = V.status = "n/a"; return { B, V, reasons: [{ level: "info", text: "It is a tokenized stock: its value is the share it tracks, not the money in its pools, so backing and volume are not judged." }] }; }
  const own = S.pairs.filter((p) => lc(p.baseToken?.address) === S.t);
  const rows = await Promise.all(own.map(async (p) => {
    const L = p.liquidity || {}, price = Number(p.priceUsd) || 0, q = lc(p.quoteToken?.address), pool = lc(p.pairAddress);
    const hard = HARD.has(q) || isStock(q);
    let real = Math.max(0, (Number(L.usd) || 0) - (Number(L.base) || 0) * price), src = "dexscreener";
    // a v2/v3-style pool holds its own coins: read the quote token's balance in it
    if (/^0x[0-9a-f]{40}$/.test(pool) && q !== ZERO && (q === WETH || q === USDG)) {
      const [b, d] = await Promise.all([tryRead(ERC20, q, "balanceOf", [pool]), tryRead(ERC20, q, "decimals")]);
      if (b != null && d != null) { real = units(b, Number(d)) * (q === USDG ? 1 : S.ethUsd || 0); src = "chain"; }
    }
    const tx = p.txns?.h24 || {};
    return { pool, dex: `${p.dexId || "?"}${p.labels?.[0] ? " " + p.labels[0] : ""}`, quote: p.quoteToken?.symbol || "?", hard, realUsd: real, source: src, liquidityUsd: Number(L.usd) || 0,
      base: Number(L.base) || 0, volumeUsd: Number(p.volume?.h24) || 0, trades: (tx.buys || 0) + (tx.sells || 0), mc: Number(p.marketCap ?? p.fdv) || 0, priceUsd: price };
  }));
  // a Pons coin still on its curve: the curve's real quote reserve
  if (S.ps && !S.ps.graduated && S.ps.realQuote > 0n && !rows.some((r) => r.pool === lc(S.ps.curve))) {
    const pairUsd = lc(S.ps.pair) === ZERO || lc(S.ps.pair) === WETH ? S.ethUsd : lc(S.ps.pair) === USDG ? 1 : null;
    if (pairUsd) {
      const px = S.ps.tokenReserve > 0n ? (units(S.ps.quoteReserve, S.ps.pairDecimals) / units(S.ps.tokenReserve, 18)) * pairUsd : 0;
      rows.push({ pool: lc(S.ps.curve), dex: "pons curve", quote: S.ps.pairSymbol, hard: true, realUsd: units(S.ps.realQuote, S.ps.pairDecimals) * pairUsd, source: "chain",
        liquidityUsd: 0, base: units(S.ps.tokenReserve, 18), volumeUsd: 0, trades: 0, mc: px * S.supply, priceUsd: px });
    }
  }
  const reasons = [];
  if (!rows.length) { reasons.push({ level: "info", text: "No pools with a price were found for it, so its market cap and volume could not be checked." }); return { B, V, reasons }; }
  const main = [...rows].sort((a, b) => b.liquidityUsd + b.realUsd - (a.liquidityUsd + a.realUsd))[0];
  const mc = main.mc || main.priceUsd * S.supply;
  const hardUsd = rows.filter((r) => r.hard).reduce((s, r) => s + r.realUsd, 0), softUsd = rows.filter((r) => !r.hard).reduce((s, r) => s + r.realUsd, 0);
  const inPools = rows.reduce((s, r) => s + r.base, 0);
  Object.assign(B, {
    marketCapUsd: Math.round(mc), realMoneyUsd: Math.round(hardUsd), otherCoinSideUsd: Math.round(softUsd), ratio: hardUsd > 0 ? +(mc / hardUsd).toFixed(1) : null,
    exitPct: mc > 0 ? +Math.min(100, (hardUsd / mc) * 100).toFixed(3) : null, poolSupplyPct: S.supply > 0 ? +((inPools / S.supply) * 100).toFixed(3) : null,
    pools: rows.slice(0, 8).map((r) => ({ pool: r.pool, dex: r.dex, quote: r.quote, realUsd: Math.round(r.realUsd), liquidityUsd: Math.round(r.liquidityUsd), source: r.source, hardMoney: r.hard })),
  });
  const ratio = hardUsd > 0 ? mc / hardUsd : Infinity, softRatio = softUsd > 0 ? mc / softUsd : Infinity;
  const qs = [...new Set(rows.filter((r) => r.hard).map((r) => r.quote))].join("/") || "ETH/USDG";
  if (!(mc > 0)) B.status = "unknown";
  else if ((mc >= RULES.backRedMinCap && ratio >= RULES.backRed) || (mc >= RULES.backMinCap && ratio >= RULES.backRedLoose && !(softRatio < RULES.backAmber))) {
    B.status = "red";
    reasons.push({ level: "red", text: hardUsd > 0
      ? `Its ${usd(mc)} market cap is backed by only ${usd(hardUsd)} of real money (${qs}) in its pools: at most ${pctS((hardUsd / mc) * 100)} of the market cap could ever be sold.`
      : `Its ${usd(mc)} market cap has no ETH, USDG or stock tokens behind it in any pool${softUsd ? `, only ${usd(softUsd)} of other coins` : ""}.` });
    if (B.poolSupplyPct != null && B.poolSupplyPct < 2) reasons.push({ level: "info", rank: 0.5, text: `Its pools hold only ${pctS(B.poolSupplyPct)} of the supply, so the price behind that market cap is set by a very small pool.` });
  } else if ((mc >= RULES.backAmberMinCap && ratio >= RULES.backAmber && (hardUsd > 0 || softRatio >= RULES.backAmber)) || (hardUsd === 0 && mc >= RULES.backMinCap)) {
    B.status = "amber";
    reasons.push({ level: "amber", text: hardUsd > 0
      ? `Its ${usd(mc)} market cap has ${usd(hardUsd)} of real money (${qs}) in its pools: only ${pctS((hardUsd / mc) * 100)} of it could be sold.`
      : `Its pools hold no ETH, USDG or stock tokens: the other side is ${usd(softUsd)} of ${[...new Set(rows.map((r) => r.quote))].join("/")}, another coin whose own value may not be real.` });
  } else {
    B.status = "ok";
    reasons.push({ level: "ok", text: `Its ${usd(mc)} market cap has ${usd(hardUsd + softUsd)} of real money in its pools (${pctS(Math.min(100, ((hardUsd + softUsd) / mc) * 100))} of the market cap could be sold), a normal ratio.` });
  }
  // volume: few huge trades, a round total, more than the pool could carry
  let vol = 0, trades = 0, scripted = 0, amber = false;
  for (const r of rows) {
    vol += r.volumeUsd; trades += r.trades;
    if (r.volumeUsd < 10_000) continue;
    const why = [];
    const avg = r.trades ? r.volumeUsd / r.trades : Infinity;
    if (avg > RULES.avgTradeMax) why.push(`${usd(r.volumeUsd)} from ${r.trades} trades (about ${usd(avg)} a trade)`);
    if (r.liquidityUsd > 0 && r.volumeUsd > r.liquidityUsd * RULES.volToLiq) why.push(`${Math.round(r.volumeUsd / r.liquidityUsd)}x the pool's liquidity`);
    const m = r.volumeUsd >= 1e6 ? 1e6 : 0;
    if (m && r.trades < 500 && Math.abs(r.volumeUsd - Math.round(r.volumeUsd / m) * m) <= r.volumeUsd * 0.001) why.push(`a round ${usd(Math.round(r.volumeUsd / m) * m)}`);
    const ofReal = r.realUsd > 0 ? r.volumeUsd / r.realUsd : Infinity;
    if (why.length) { scripted += r.volumeUsd; V.pools.push({ pool: r.pool, dex: r.dex, volumeUsd: Math.round(r.volumeUsd), trades: r.trades, why, scripted: true }); }
    else if (r.volumeUsd >= 50_000 && ofReal > RULES.volToReal) { amber = true; V.pools.push({ pool: r.pool, dex: r.dex, volumeUsd: Math.round(r.volumeUsd), trades: r.trades, why: [`${Math.round(ofReal)}x the real money in the pool`] }); }
  }
  Object.assign(V, { volume24hUsd: Math.round(vol), trades24h: trades, avgTradeUsd: trades ? Math.round(vol / trades) : null, scriptedUsd: Math.round(scripted), volumeToRealMoney: hardUsd + softUsd > 0 ? +(vol / (hardUsd + softUsd)).toFixed(1) : null });
  if (vol > 0 && scripted / vol >= 0.5) {
    V.status = "red";
    const p = V.pools.find((x) => x.scripted);
    reasons.push({ level: "red", text: `Its 24-hour volume looks scripted: ${p.why.join(", ")}. That is not real demand.` });
  } else if (scripted > 0 || amber) {
    V.status = "amber";
    const p = V.pools.find((x) => x.scripted) || V.pools[0];
    reasons.push({ level: "amber", text: `Part of its volume looks scripted: ${usd(p.volumeUsd)} in one pool, ${p.why.join(", ")}.` });
  } else if (vol > 0) {
    V.status = "ok";
    reasons.push({ level: "ok", text: `Its volume looks like real trading: ${usd(vol)} in 24 hours from ${trades.toLocaleString("en-US")} trades.` });
  } else { V.status = "ok"; reasons.push({ level: "info", text: "It had no trading volume in the last 24 hours." }); }
  return { B, V, reasons };
}

/* ---------- the check ---------- */
// the newest block the official RPC knows (it refuses ranges past its own head); another node's head, further back, if it is busy
async function headBlock() {
  for (let i = 0; i < 3; i++) {
    try { return Number(BigInt(await rpc("robinhood", "eth_blockNumber", [], { timeoutMs: 8_000 }))) - 20; } catch { await sleep(500 * (i + 1)); }   // our paid node first
  }
  return Number(BigInt(await rpc("robinhood", "eth_blockNumber", [], { timeoutMs: 8_000 }))) - 300;
}
async function measure(t) {
  const started = Date.now();
  const S = { t, assets: new Map(), creators: new Set(), funded: new Set(), fundedBy: new Map(), doorSet: new Set(), poolSet: new Set(), partial: false, cuts: [], left: () => started + BUDGET_MS - Date.now() };
  // soft cuts are noted but do not mark the check partial (a busy wallet skipped in the holder scan, a creator's older payments)
  S.cut = (why, soft = false) => { if (!soft) S.partial = true; if (S.cuts.length < 10 && !S.cuts.includes(why)) S.cuts.push(why); };
  const code = await rpc("robinhood", "eth_getCode", [t, "latest"], { timeoutMs: 10_000 });
  if (!code || code === "0x") return { token: getAddress(t), symbol: null, verdict: "unknown", reasons: ["There is no contract at this address on Robinhood Chain."], checks: {}, at: Date.now() };
  const [sup, dec, sym, pairs, ethUsd, head, ps, hk] = await Promise.all([
    tryRead(ERC20, t, "totalSupply"), tryRead(ERC20, t, "decimals"), tryRead(ERC20, t, "symbol"), dsPairs([t]).catch(() => []), getEthUsd().catch(() => null),
    headBlock(), ponsState(t).catch(() => null), hookrOf(t).catch(() => null),
  ]);
  if (sup == null) return { token: getAddress(t), symbol: null, verdict: "unknown", reasons: ["This contract does not answer as a token (no totalSupply)."], checks: {}, at: Date.now() };
  Object.assign(S, { ps, hk, pairs, ethUsd, symbol: sym || null, decimals: dec == null ? 18 : Number(dec), stock: isStock(t) });
  S.supply = units(sup, S.decimals);
  S.head = head;
  S.from = Math.max(1, S.head - WINDOW);
  const best = pairs.filter((p) => lc(p.baseToken?.address) === t).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  S.priceUsd = Number(best?.priceUsd) || null;
  for (const p of pairs) if (/^0x[0-9a-f]{40}$/i.test(p.pairAddress || "")) S.poolSet.add(lc(p.pairAddress));
  // what payouts are looked for in: WETH, USDG, and the money its deepest pool trades against (a stock token, cbBTC)
  const q = lc(best?.quoteToken?.address);
  const extra = q && q !== ZERO && q !== WETH && q !== USDG && q !== t && (isStock(q) || q === CBBTC);
  S.payAssets = extra ? [WETH, USDG, q] : [WETH, USDG];
  S.payNames = extra ? ["WETH", "USDG", best.quoteToken.symbol || short(q)] : ["WETH", "USDG"];
  if (ps) S.poolSet.add(lc(ps.curve));
  for (const d of hk?.doors || []) S.doorSet.add(d.target);
  if (hk?.dropBox) S.doorSet.add(hk.dropBox);
  const [b0, b1] = await Promise.all([S.from, S.head].map((n) => rpc("robinhood", "eth_getBlockByNumber", [hex(n), false], { timeoutMs: 10_000 }).catch(() => null)));
  S.days = b0 && b1 ? Math.max(1, Math.round((Number(b1.timestamp) - Number(b0.timestamp)) / 86400)) : 11;

  const market = marketChecks(S).catch((e) => ({ B: { status: "unknown" }, V: { status: "unknown" }, reasons: [{ level: "info", text: `Pools could not be read (${e.message}).` }] }));
  const [creators, holders] = await Promise.all([creatorsOf(S), bs(`/tokens/${t}/holders`)]);
  S.creators = creators;
  S.holders = (holders?.items || []).map((x) => ({ a: lc(x.address?.hash), contract: !!x.address?.is_contract, name: x.address?.name || null })).filter((x) => x.a);
  let I;
  try { I = await Promise.race([incomeCheck(S), sleep(Math.max(4000, S.left())).then(() => null)]); } catch (e) { I = { status: "unknown", error: e.message }; }
  if (!I) I = { status: "unknown", error: "ran out of time" };
  const M = await market;
  const reasons = [];
  const iR = I.status === "unknown" ? [{ level: "info", text: `Who pays its holders could not be fully traced this time (${I.error || "no data"}); ask again in a minute.` }] : incomeReasons(S, I, M.V);
  const all = [...iR, ...M.reasons];
  const rank = { red: 0, amber: 1, ok: 2, info: 3 };
  all.sort((a, b) => (a.rank ?? rank[a.level]) - (b.rank ?? rank[b.level]));
  for (const x of all) reasons.push(x.text);
  const levels = [I.status, M.B.status, M.V.status, ...iR.map((x) => x.level)];
  const measured = [I.status, M.B.status, M.V.status].some((s) => s === "ok" || s === "none" || s === "red" || s === "amber");
  const verdict = levels.includes("red") ? "fake" : levels.includes("amber") ? "caution" : measured && (M.B.status !== "unknown" || I.status !== "none") ? "clear" : "unknown";
  if (S.partial) reasons.push("Some reads were cut short (busy history or a slow source), so this check saw part of the window.");
  if (!hasBlockscout()) reasons.push("Blockscout was unavailable, so creators, holders and ETH payments were read only in part.");
  return {
    token: getAddress(t), symbol: S.symbol, verdict, reasons, at: Date.now(), ms: Date.now() - started,
    checks: {
      income: { ...I, ownCoinUsd: I.ownCoinUsd != null ? +I.ownCoinUsd.toPrecision(4) : undefined, totalUsd: I.totalUsd != null ? +I.totalUsd.toPrecision(4) : undefined,
        creatorPct: I.creatorPct != null ? +I.creatorPct.toFixed(1) : undefined, ownCoinPct: I.ownCoinPct != null ? +I.ownCoinPct.toFixed(1) : undefined, tradingPct: I.tradingPct != null ? +I.tradingPct.toFixed(1) : undefined,
        byKind: I.byKind ? Object.fromEntries(Object.entries(I.byKind).map(([k, v]) => [k, +v.toPrecision(4)])) : undefined, creators: (I.creators || []).map((a) => getAddress(a)),
        payers: (I.payers || []).map((p) => ({ ...p, address: getAddress(p.address) })) },
      backing: M.B, volume: M.V,
      window: { fromBlock: S.from, toBlock: S.head, days: S.days, partial: S.partial, cut: S.cuts.length ? S.cuts : undefined },
    },
    note: "Read from the chain, Blockscout and DexScreener. Fake means a check found money that is not what it looks like; clear means nothing was found in what was measured.",
  };
}

// two checks at a time: each one makes a few dozen reads
let running = 0;
const waiting = [];
async function limit(fn) {
  while (running >= 2) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** Is this coin's revenue, rewards or market cap real? Cached 10 minutes per coin. */
export async function tributeCheck(token) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "That is not a valid token address.");
  const t = lc(token);
  const hit = memo.get(t);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(t)) {
    // an incomplete read (busy RPC, out of time) is kept one minute, so the next ask tries again
    inflight.set(t, limit(() => measure(t)).then((res) => {
      const done = !res.checks?.window?.partial && res.checks?.income?.status !== "unknown";
      memo.set(t, { at: Date.now(), res, ttl: done ? CACHE_MS : 60_000 });
      if (memo.size > 500) memo.delete(memo.keys().next().value);
      return res;
    })
      // the chain or a source did not answer: say so, keep nothing, the next ask tries again
      .catch((e) => ({ token: getAddress(t), symbol: null, verdict: "unknown", reasons: [`The check could not finish (${String(e.message).slice(0, 120)}). Ask again in a minute.`], checks: {}, at: Date.now() }))
      .finally(() => inflight.delete(t)));
  }
  return inflight.get(t);
}

/** Tribute flags in The Assay's shape, from the cache only (never computes), for the Gate and the app. */
export function tributeFlags(token) {
  const hit = memo.get(lc(token));
  if (!hit || hit.res.verdict === "clear" || hit.res.verdict === "unknown") return [];
  return [{ key: "tribute", level: hit.res.verdict === "fake" ? "red" : "amber", title: hit.res.verdict === "fake" ? "Tribute: revenue or market cap not real" : "Tribute: revenue or market cap needs a closer look", detail: hit.res.reasons.slice(0, 2).join(" ") }];
}

export async function register(r) {
  r.get("/api/tribute/:token", async ({ params }) => tributeCheck(params.token), { weight: 2, perMin: 30 });
}
