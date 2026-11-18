// F14 · The Assay: who is behind a Robinhood Chain coin, read from the chain before you buy.
// From the coin's whole transfer history (and a few archive reads) it measures: what the dev bought, sold and still
// holds; how concentrated the wallets are; how much the first seconds of buyers grabbed (bundles); wallets fed by
// one sender; trading that goes round in circles (wash); and who funded the dev and the top holders. It reports red
// and amber flags only. It never calls a coin safe: no flag means nothing was found in what was measured.
//   GET /api/assay/:token → { status: "done" | "running", flags, dev, holders, launch, clusters, wash, funding, ... }
import { ADDR, CHAINS, rpc, ponsState, iface } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const at = (t) => "0x" + String(t).slice(26).toLowerCase();
const KNOWN = {
  [lc(ADDR.poolManager)]: "Uniswap v4 pool manager", [lc(ADDR.universalRouter)]: "Uniswap router", [lc(ADDR.swapRouter02)]: "Uniswap router",
  [lc(ADDR.permit2)]: "Permit2", [lc(ADDR.ponsFactory)]: "Pons factory", [lc(ADDR.ponsHook)]: "Pons hook",
  "0x204faca1764b154221e35c0d20abb3c525710498": "Uniswap router", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": "KyberSwap router",
  [ZERO]: "zero address", [DEAD]: "dead address",
};
const LP_MANAGERS = new Set(["0x73991a25c818bf1f1128deaab1492d45638de0d3", "0x58daec3116aae6d93017baaea7749052e8a04fa7"]);   // Uniswap v3 NPM, v4 PositionManager
const CACHE_MS = 15 * 60e3;
let store;
const cache = new Map(), inflight = new Map();

/* ---------- small chain helpers ---------- */
const archive = () => CHAINS.robinhood.upstreams.find((u) => /drpc/.test(u)) || CHAINS.robinhood.upstreams.at(-1);
async function arch(method, params) {
  for (let i = 0; i < 3; i++) {
    try { return await rpc("robinhood", method, params, { only: archive(), timeoutMs: 12000 }); }
    catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
}
async function call(to, data) { return rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 12000 }); }
async function codeOf(addrs) {
  const out = new Map();
  // an EIP-7702 account (code 0xef0100 + delegate) is a person's wallet with smart features, not a contract
  await Promise.all(addrs.map(async (a) => { try { const c = await rpc("robinhood", "eth_getCode", [a, "latest"], { timeoutMs: 12000 }); out.set(a, c !== "0x" && !lc(c).startsWith("0xef0100")); } catch { out.set(a, false); } }));
  return out;
}
// the first block where pred(block) holds, by bisection over archive state (monotonic predicates only)
async function firstBlock(pred, head) {
  if (!(await pred(head))) return null;
  let lo = 1, hi = head;                 // the archive keeps no state for block 0
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await pred(mid)) hi = mid; else lo = mid + 1; }
  return lo;
}
// every Transfer of the coin since it was created. The official RPC answers wide ranges; a big history is split in
// halves until each piece fits (fallback RPCs cap ranges at 10,000 blocks, so they are not used for this)
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SPAN = 9_900_000;   // the official RPC answers at most 10,000,000 blocks per eth_getLogs
// History is read newest first, compacted on arrival, and capped: a coin with more transfers than the cap is measured
// on its most recent ones and the report says so. (One uncapped read of a very busy coin ran the server out of memory.)
const MAX_TRANSFERS = 60_000;
const compact = (l) => ({ from: at(l.topics[1]), to: at(l.topics[2]), v: BigInt(l.data === "0x" ? 0 : l.data), block: Number(l.blockNumber), tx: l.transactionHash });
async function readRange(token, from, to, acc, depth = 0) {
  if (acc.out.length >= MAX_TRANSFERS) { acc.partial = true; return; }
  let e;
  for (let i = 0; i < 4; i++) {
    try {
      const logs = await rpc("robinhood", "eth_getLogs", [{ address: token, topics: [T_TRANSFER], fromBlock: hex(from), toBlock: hex(to) }], { only: CHAINS.robinhood.upstreams[0], timeoutMs: 45000 });
      for (const l of logs || []) acc.out.push(compact(l));
      acc.from = Math.min(acc.from, from);
      return;
    } catch (x) { e = x; if (!/429|rate/i.test(x.message)) break; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }   // busy: wait, same range
  }
  // too many logs or too slow: halve the range, newer half first (one block always fits)
  if (depth >= 18 || to <= from || /429|rate/i.test(e.message)) throw e;
  const mid = Math.floor((from + to) / 2);
  await readRange(token, mid + 1, to, acc, depth + 1);
  await readRange(token, from, mid, acc, depth + 1);
}
async function history(token, from, to) {
  const acc = { out: [], partial: false, from: to + 1 };
  for (let b = to; b >= from && !acc.partial; b -= SPAN + 1) await readRange(token, Math.max(from, b - SPAN), b, acc);
  acc.out.sort((a, b) => a.block - b.block);
  return acc;
}
// one measurement at a time; the rest wait their turn
let queue = Promise.resolve();
const oneAtATime = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
const born = new Map();
// the coin's first mint (a Transfer from the zero address) marks its birth; the official RPC answers the whole range
async function bornBlock(token, head) {
  if (born.has(token)) return born.get(token);
  let b = null;
  // oldest window first: the first window holding a mint holds the birth
  for (let a = 1; a <= head && b == null; a += SPAN + 1) {
    try {
      const mints = await rpc("robinhood", "eth_getLogs", [{ address: token, topics: [T_TRANSFER, "0x" + "0".repeat(64)], fromBlock: hex(a), toBlock: hex(Math.min(head, a + SPAN)) }], { only: CHAINS.robinhood.upstreams[0], timeoutMs: 45000 });
      if (mints?.length) b = Math.min(...mints.map((l) => Number(l.blockNumber)));
    } catch { break; }
  }
  if (b == null) b = await firstBlock(async (n) => (await arch("eth_getCode", [token, hex(n)])) !== "0x", head).catch(() => null);
  if (b != null) born.set(token, b);
  return b;
}

/* ---------- who funded a wallet (kept forever: it never changes) ---------- */
const FUNDERS = "assay-funders.json";
let funders = null;
async function fundingOf(addr, head) {
  funders ||= await store.readJson(FUNDERS, {});
  const a = lc(addr);
  if (funders[a]) return funders[a];
  const active = async (n) => {
    const [b, c] = await Promise.all([arch("eth_getBalance", [a, hex(n)]), arch("eth_getTransactionCount", [a, hex(n)])]);
    return BigInt(b || 0) > 0n || BigInt(c || 0) > 0n;
  };
  const first = await firstBlock(active, head);
  if (first == null) return null;
  const blk = await rpc("robinhood", "eth_getBlockByNumber", [hex(first), true], { timeoutMs: 15000 });
  const txs = blk?.transactions || [];
  let r = null;
  const direct = txs.find((t) => lc(t.to) === a && BigInt(t.value || 0) > 0n);
  if (direct) r = { block: first, funder: lc(direct.from), tx: direct.hash, how: "direct" };
  else {
    // funded inside a contract call (a bridge, an exchange or a batch sender): name the contract and the transaction
    const pad = a.slice(2);
    for (const t of txs.slice(0, 40)) {
      const rc = await rpc("robinhood", "eth_getTransactionReceipt", [t.hash], { timeoutMs: 12000 }).catch(() => null);
      if (rc?.logs?.some((l) => l.topics?.some((x) => lc(x).endsWith(pad)) || lc(l.data).includes(pad))) { r = { block: first, funder: null, via: lc(t.to), viaFrom: lc(t.from), tx: t.hash, how: "contract" }; break; }
    }
    r ||= { block: first, funder: null, how: "unknown" };
  }
  funders[a] = r;
  await store.writeJson(FUNDERS, funders);
  return r;
}

/* ---------- the measurement ---------- */
const pct = (a, b) => (b > 0n ? Number((a * 1000000n) / b) / 10000 : 0);
async function measure(token, { deep = true } = {}) {
  const t = lc(token);
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const [ps, supplyHex, symHex] = await Promise.all([
    ponsState(t).catch(() => null), call(t, "0x18160ddd").catch(() => "0x0"), call(t, iface.erc20.encodeFunctionData("symbol")).catch(() => null),
  ]);
  const supply = BigInt(supplyHex || 0);
  let symbol = null; try { symbol = iface.erc20.decodeFunctionResult("symbol", symHex)[0]; } catch {}
  const b0 = await bornBlock(t, head);
  const hist = await history(t, b0 ?? Math.max(1, head - 900000), head);
  const logs = hist.out;
  if (!logs.length) return { token: t, symbol, status: "done", flags: [{ level: "amber", key: "empty", title: "No transfers found", detail: "Nothing to measure yet." }], at: Date.now() };

  // ledger
  const bal = new Map(), count = new Map();
  const add = (a, v) => bal.set(a, (bal.get(a) || 0n) + v);
  const tr = logs;
  for (const x of tr) { add(x.from, -x.v); add(x.to, x.v); count.set(x.from, (count.get(x.from) || 0) + 1); count.set(x.to, (count.get(x.to) || 0) + 1); }
  bal.delete(ZERO);

  // part of the history only: balances from a window are flows, not holdings, so read the real balances of the wallets
  // that received the most in that window (Multicall3, 100 at a time)
  if (hist.partial) {
    const inflow = new Map();
    for (const x of tr) inflow.set(x.to, (inflow.get(x.to) || 0n) + x.v);
    const cand = [...inflow.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 300).map((x) => x[0]).filter((a) => a !== ZERO);
    if (ps) { cand.push(lc(ps.deployer), lc(ps.creatorFeeRecipient)); if (curve) cand.push(curve); }
    bal.clear();
    const uniq = [...new Set(cand)];
    for (let i = 0; i < uniq.length; i += 100) {
      const part = uniq.slice(i, i + 100);
      const data = iface.mc.encodeFunctionData("aggregate3", [part.map((a) => ({ target: t, allowFailure: true, callData: iface.erc20.encodeFunctionData("balanceOf", [a]) }))]);
      const res = iface.mc.decodeFunctionResult("aggregate3", await call(ADDR.multicall3, data))[0];
      part.forEach((a, j) => { if (res[j]?.success && res[j].returnData !== "0x") bal.set(a, BigInt(res[j].returnData)); });
    }
  }
  // which addresses are contracts (pools, the curve, routers, lockers): the busiest and the biggest holders are checked
  const busiest = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x[0]);
  const biggest = [...bal.entries()].filter((x) => x[1] > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 40).map((x) => x[0]);
  const curve = ps ? lc(ps.curve) : null;
  const check = [...new Set([...busiest, ...biggest].filter((a) => a !== ZERO && a !== DEAD))];
  const isCode = await codeOf(check);
  // a venue is where coins are bought and sold: the Pons curve, the v4 pool manager, a router, or a pool (has token0());
  // other contracts (smart wallets, lockers, vaults) are holders like any wallet, labelled as contracts
  const pools = new Set();
  await Promise.all(check.filter((a) => isCode.get(a) && !KNOWN[a] && a !== curve).map(async (a) => {
    const r = await call(a, "0x0dfe1681").catch(() => null);
    if (r && r !== "0x" && r.length >= 66) pools.add(a);
  }));
  const venue = (a) => a === curve || pools.has(a) || (!!KNOWN[a] && a !== ZERO && a !== DEAD);
  const contract = venue;
  const label = (a) => (a === curve ? "Pons curve" : KNOWN[a] || (pools.has(a) ? "pool" : isCode.get(a) ? "contract" : null));

  // holders: wallets (not contracts, not burned)
  const burned = (bal.get(DEAD) || 0n);
  const holders = [...bal.entries()].filter(([a, v]) => v > 0n && a !== DEAD && !venue(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const inContracts = [...bal.entries()].filter(([a, v]) => v > 0n && venue(a) && a !== DEAD).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const walletsTotal = holders.reduce((s, x) => s + x[1], 0n);
  const top10 = holders.slice(0, 10).reduce((s, x) => s + x[1], 0n);

  // dev: the Pons deployer and fee recipient, or whoever sent the transaction that created the coin
  const devs = new Set();
  if (ps) { devs.add(lc(ps.deployer)); devs.add(lc(ps.creatorFeeRecipient)); }
  let createdTx = null;
  if (!ps && b0 != null) {
    const blk = await rpc("robinhood", "eth_getBlockByNumber", [hex(b0), true], { timeoutMs: 15000 }).catch(() => null);
    for (const x of (blk?.transactions || []).slice(0, 40)) {
      const rc = await rpc("robinhood", "eth_getTransactionReceipt", [x.hash], { timeoutMs: 12000 }).catch(() => null);
      if (lc(rc?.contractAddress) === t || rc?.logs?.some((l) => lc(l.address) === t)) { devs.add(lc(x.from)); createdTx = x.hash; break; }
    }
  }
  const devList = [...devs].filter((a) => a && a !== ZERO);
  // dev moves against a pool are trades unless the transaction went through a Uniswap position manager (adding or
  // removing liquidity): adding liquidity is not selling, pulling it is its own flag
  const devVenueTx = [...new Set(tr.filter((x) => (devs.has(x.to) && venue(x.from)) || (devs.has(x.from) && venue(x.to))).map((x) => x.tx))].slice(0, 80);
  const lpTx = new Set();
  await Promise.all(devVenueTx.map(async (h) => { const tx = await rpc("robinhood", "eth_getTransactionByHash", [h], { timeoutMs: 12000 }).catch(() => null); if (LP_MANAGERS.has(lc(tx?.to))) lpTx.add(h); }));
  let devIn = 0n, devBought = 0n, devSold = 0n, devOut = 0n, devLpAdd = 0n, devLpPull = 0n;
  const devSpread = new Set();
  for (const x of tr) {
    if (devs.has(x.to)) { devIn += x.v; if (venue(x.from)) { if (lpTx.has(x.tx)) devLpPull += x.v; else devBought += x.v; } }
    if (devs.has(x.from)) { if (venue(x.to)) { if (lpTx.has(x.tx)) devLpAdd += x.v; else devSold += x.v; } else if (!devs.has(x.to) && x.to !== DEAD) { devOut += x.v; devSpread.add(x.to); } }
  }
  const devNow = devList.reduce((s, a) => s + (bal.get(a) > 0n ? bal.get(a) : 0n), 0n);

  // launch: buys in the first 30 seconds
  const launch = tr.find((x) => x.from === ZERO)?.block ?? tr[0].block;
  const [lb, hb] = await Promise.all([rpc("robinhood", "eth_getBlockByNumber", [hex(launch), false]).catch(() => null), rpc("robinhood", "eth_getBlockByNumber", [hex(head), false]).catch(() => null)]);
  const spb = lb && hb && head > launch ? Math.max(0.05, (Number(hb.timestamp) - Number(lb.timestamp)) / (head - launch)) : 0.25;
  const early = launch + Math.ceil(30 / spb);
  const buys = tr.filter((x) => venue(x.from) && !contract(x.to) && x.to !== DEAD && !devs.has(x.to));
  const firstBuy = new Map();
  for (const x of buys) if (!firstBuy.has(x.to)) firstBuy.set(x.to, x.block);
  const earlyBuyers = [...firstBuy.entries()].filter(([, b]) => b <= early).map(([a]) => a);
  const earlyHold = earlyBuyers.reduce((s, a) => s + (bal.get(a) > 0n ? bal.get(a) : 0n), 0n);
  const perBlock = new Map();
  for (const x of buys) if (x.block <= launch + Math.ceil(120 / spb)) { if (!perBlock.has(x.block)) perBlock.set(x.block, new Set()); perBlock.get(x.block).add(x.to); }
  const crowdBlock = Math.max(0, ...[...perBlock.values()].map((s) => s.size));

  // clusters: one wallet handing the coin to several wallets that still hold it
  const fan = new Map();
  for (const x of tr) if (!contract(x.from) && !isCode.get(x.from) && x.from !== ZERO && !contract(x.to) && x.to !== DEAD && x.from !== x.to) { if (!fan.has(x.from)) fan.set(x.from, new Set()); fan.get(x.from).add(x.to); }
  const fanClusters = [...fan.entries()].map(([src, set]) => {
    const live = [...set].filter((a) => bal.get(a) > 0n);
    return { source: src, wallets: live.length, holds: live.reduce((s, a) => s + bal.get(a), 0n) + (bal.get(src) > 0n ? bal.get(src) : 0n), dev: devs.has(src) };
  }).filter((c) => c.wallets >= 3).sort((a, b) => (b.holds > a.holds ? 1 : -1));

  // wash: wallets that keep buying and selling about the same amount
  const flow = new Map();
  const f = (a) => (flow.has(a) ? flow.get(a) : flow.set(a, { b: 0, s: 0, bv: 0n, sv: 0n }).get(a));
  let trades = 0;
  for (const x of tr) {
    if (venue(x.from) && !contract(x.to)) { const r = f(x.to); r.b++; r.bv += x.v; trades++; }
    else if (!contract(x.from) && venue(x.to) && x.from !== ZERO) { const r = f(x.from); r.s++; r.sv += x.v; trades++; }
  }
  const washers = [...flow.entries()].filter(([, r]) => r.b >= 3 && r.s >= 3 && (r.bv > r.sv ? r.bv - r.sv : r.sv - r.bv) * 10n <= (r.bv > r.sv ? r.bv : r.sv));
  const washTrades = washers.reduce((s, [, r]) => s + r.b + r.s, 0);
  const top3Trades = [...flow.values()].map((r) => r.b + r.s).sort((a, b) => b - a).slice(0, 3).reduce((s, n) => s + n, 0);

  // funding (archive reads; cached forever per wallet)
  let funding = null;
  if (deep) {
    const who = [...new Set([...devList, ...holders.slice(0, 10).map((x) => x[0]), ...earlyBuyers.sort((a, b) => (bal.get(b) > bal.get(a) ? 1 : -1)).slice(0, 6)])].slice(0, 20);
    const res = new Map();
    for (let i = 0; i < who.length; i += 3) {
      await Promise.all(who.slice(i, i + 3).map(async (a) => res.set(a, await fundingOf(a, head).catch(() => null))));
    }
    const groups = new Map();
    for (const [a, r] of res) if (r?.funder) { if (!groups.has(r.funder)) groups.set(r.funder, []); groups.get(r.funder).push(a); }
    const shared = [...groups.entries()].filter(([fd, ws]) => ws.length >= 2 || devs.has(fd)).map(([fd, ws]) => ({
      funder: fd, wallets: ws, holds: ws.reduce((s, a) => s + (bal.get(a) > 0n ? bal.get(a) : 0n), 0n), withDev: ws.some((a) => devs.has(a)) || devs.has(fd), devIsFunder: devs.has(fd),
    })).sort((x, y) => (y.holds > x.holds ? 1 : -1));
    funding = { checked: who.length, dev: devList.map((a) => ({ wallet: a, ...(res.get(a) || {}) })), shared };
  }

  /* ---------- flags ---------- */
  const flags = [];
  const flag = (level, key, title, detail) => flags.push({ level, key, title, detail });
  // what the dev could sell: everything it received minus what it put into liquidity (and got back when pulling it)
  const devBase = devIn - devLpAdd > 0n ? devIn - devLpAdd : 0n;
  const devSoldPct = devBase > 0n ? Math.min(100, pct(devSold, devBase)) : 0, devHoldPct = pct(devNow, supply);
  if (devLpPull > 0n && pct(devLpPull, supply) >= 1) flag("red", "lp-pulled", "Dev pulled liquidity", `The dev wallet removed liquidity worth ${pct(devLpPull, supply).toFixed(1)}% of the supply from a pool.`);
  if (devBase > 0n && devSoldPct >= 50) flag("red", "dev-sold", "Dev sold", `The dev wallet sold ${devSoldPct.toFixed(0)}% of the coins it received.`);
  else if (devBase > 0n && devSoldPct >= 20) flag("amber", "dev-sold", "Dev sold some", `The dev wallet sold ${devSoldPct.toFixed(0)}% of the coins it received.`);
  if (devHoldPct >= 10) flag("red", "dev-holds", "Dev holds a lot", `The dev wallet holds ${devHoldPct.toFixed(1)}% of the supply.`);
  else if (devHoldPct >= 5) flag("amber", "dev-holds", "Dev holds a large bag", `The dev wallet holds ${devHoldPct.toFixed(1)}% of the supply.`);
  if (devSpread.size >= 3) flag("amber", "dev-spread", "Dev spread coins out", `The dev wallet sent coins to ${devSpread.size} other wallets (${pct(devOut, supply).toFixed(1)}% of the supply).`);
  const top10Pct = pct(top10, supply);
  if (top10Pct >= 50) flag("red", "top10", "Top wallets hold most of it", `The 10 biggest wallets hold ${top10Pct.toFixed(1)}% of the supply.`);
  else if (top10Pct >= 30) flag("amber", "top10", "Concentrated", `The 10 biggest wallets hold ${top10Pct.toFixed(1)}% of the supply.`);
  const earlyPct = pct(earlyHold, supply);
  if (earlyPct >= 30) flag("red", "bundle", "Bundled launch", `Wallets that bought in the first 30 seconds (${earlyBuyers.length}) still hold ${earlyPct.toFixed(1)}% of the supply.`);
  else if (earlyPct >= 15 || (crowdBlock >= 5 && earlyPct >= 5)) flag("amber", "bundle", "Busy first seconds", `${earlyBuyers.length} wallets bought in the first 30 seconds and still hold ${earlyPct.toFixed(1)}%${crowdBlock >= 5 ? `; ${crowdBlock} wallets bought in one block` : ""}.`);
  const fc = fanClusters[0];
  if (fc && pct(fc.holds, supply) >= 5) flag(pct(fc.holds, supply) >= 15 ? "red" : "amber", "cluster", fc.dev ? "Dev-fed wallets" : "Wallet cluster", `${short(fc.source)}${fc.dev ? " (the dev)" : ""} handed coins to ${fc.wallets} wallets that together hold ${pct(fc.holds, supply).toFixed(1)}%.`);
  const washPct = trades ? (washTrades / trades) * 100 : 0;
  if (trades >= 50 && washPct >= 70) flag("red", "wash", "Mostly round-trip trading", `${washers.length} wallets that buy and sell the same amounts (bots or wash trading) made ${washPct.toFixed(0)}% of all trades: the volume looks bigger than real demand.`);
  else if (trades >= 50 && washPct >= 40) flag("amber", "wash", "Round-trip trading", `${washers.length} wallets that buy and sell the same amounts (bots or wash trading) made ${washPct.toFixed(0)}% of all trades.`);
  // wallets that share a funder with the dev: red while they still hold a real share, amber once they are empty
  for (const sh of (funding?.shared || []).slice(0, 2)) {
    const p = pct(sh.holds, supply);
    const others = sh.wallets.filter((w) => !devs.has(w)).length;
    if (sh.withDev && others >= 1) {
      const who = sh.devIsFunder ? `The dev funded ${others} of the biggest or earliest wallets` : `${short(sh.funder)} funded the dev and ${others} other ${others === 1 ? "wallet" : "wallets"} among the biggest or earliest`;
      if (p >= 3) flag("red", "funder", "Same funder as the dev", `${who}; together they hold ${p.toFixed(1)}% of the supply.`);
      else flag("amber", "funder", "Dev-linked wallets", `${who}; they hold ${p.toFixed(1)}% of the supply now.`);
      break;
    }
    if (!sh.withDev && (sh.wallets.length >= 3 || p >= 10)) { flag(p >= 10 ? "red" : "amber", "funder", "Shared funder", `${short(sh.funder)} funded ${sh.wallets.length} of the biggest or earliest wallets; they hold ${p.toFixed(1)}% of the supply.`); break; }
  }
  if (ps && ps.snipeBps > 0n) flag("amber", "snipe", "Snipe tax active", `A ${(Number(ps.snipeBps) / 100).toFixed(1)}% launch snipe tax still applies to buys.`);

  if (hist.partial || b0 == null) flags.unshift({ level: "amber", key: "partial", title: "Partial history", detail: `Only the most recent ${tr.length.toLocaleString("en-US")} transfers were read (the coin has more, or no readable birth): dev and launch numbers may be incomplete.` });
  const view = (a, v) => ({ wallet: a, pct: pct(v, supply), label: label(a) });
  return {
    token: t, symbol, status: "done", at: Date.now(), deep,
    flags, verdict: flags.some((x) => x.level === "red") ? "red" : flags.some((x) => x.level === "amber") ? "amber" : "clear",
    dev: { wallets: devList, createdTx, receivedPct: pct(devIn, supply), boughtPct: pct(devBought, supply), soldPct: devSoldPct, holdsPct: devHoldPct, spreadTo: devSpread.size, liquidityAddedPct: pct(devLpAdd, supply), liquidityPulledPct: pct(devLpPull, supply) },
    holders: { count: hist.partial ? null : holders.length, top10Pct, walletsPct: pct(walletsTotal, supply), burnedPct: pct(burned, supply), top: holders.slice(0, 10).map(([a, v]) => view(a, v)), contracts: inContracts.slice(0, 6).map(([a, v]) => view(a, v)) },
    launch: { block: launch, secondsPerBlock: +spb.toFixed(3), earlyBuyers: earlyBuyers.length, earlyHoldPct: earlyPct, mostBuyersInOneBlock: crowdBlock },
    clusters: fanClusters.slice(0, 5).map((c) => ({ source: c.source, wallets: c.wallets, holdsPct: pct(c.holds, supply), dev: c.dev })),
    wash: { trades, washWallets: washers.length, washPct: +washPct.toFixed(1), top3Pct: trades ? +((top3Trades / trades) * 100).toFixed(1) : 0 },
    funding: funding && { checked: funding.checked, dev: funding.dev, shared: funding.shared.slice(0, 5).map((s) => ({ ...s, holds: undefined, holdsPct: pct(s.holds, supply) })) },
    coverage: { transfers: tr.length, fromBlock: hist.partial ? hist.from : b0, born: b0, head, partial: hist.partial },
    note: "Red and amber flags only. No flag means nothing was found in what was measured, not that a coin is safe.",
  };
}
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

export async function assay(token, { deep = true, waitMs = 20000 } = {}) {
  const t = lc(token);
  const key = `${t}:${deep ? 1 : 0}`;
  const hit = cache.get(key);
  // a busy coin (history capped) takes minutes to read, so it is kept for an hour; others for 15 minutes
  if (hit && Date.now() - hit.at < (hit.coverage?.partial ? 60 * 60e3 : CACHE_MS)) return hit;
  if (!inflight.has(key)) {
    inflight.set(key, oneAtATime(() => measure(t, { deep })).then((r) => { cache.set(key, r); if (cache.size > 500) cache.delete(cache.keys().next().value); return r; })
      .catch((e) => ({ token: t, status: "error", error: e.message, at: Date.now() })).finally(() => inflight.delete(key)));
  }
  const p = inflight.get(key);
  const r = await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), waitMs))]);
  return r || { token: t, status: "running", note: "Reading the coin's history and who funded its wallets. Ask again in a few seconds." };
}

const p1 = (x) => (x == null ? "–" : `${x > 0 && x < 0.1 ? x.toFixed(2) : x.toFixed(1)}%`);
// plain text, for Telegram: one line of facts, then the flags
export function assayLines(d) {
  if (!d || d.status !== "done") return [];
  const facts = [d.dev?.wallets?.length ? `dev holds ${p1(d.dev.holdsPct)}${d.dev.soldPct ? `, sold ${p1(d.dev.soldPct)}` : ""}` : null, `top 10 wallets ${p1(d.holders?.top10Pct)}`,
    d.launch?.earlyBuyers ? `first 30 s buyers hold ${p1(d.launch.earlyHoldPct)}` : null].filter(Boolean).join(" · ");
  const out = [`Assay: ${facts}`];
  const f = (d.flags || []).filter((x) => x.key !== "partial");
  out.push(f.length ? `Flags: ${f.map((x) => `${x.level === "red" ? "✕" : "!"} ${x.title}`).join(" · ")}` : "No red or amber flags in what was measured");
  return out;
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/assay/:token", ({ params, query }) => {
    if (!ADDR_RE.test(params.token)) throw new HttpError(400, "That is not a valid token address.");
    return assay(params.token, { deep: query.deep !== "0" });
  }, { weight: 2 });
}
// the Project check reads where a creator wallet got its first ETH (devtrack.mjs)
export { fundingOf };
