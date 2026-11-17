// F19 · $TROYA flywheel: creator fees feed buyback, burn and locked liquidity, and every cycle is read back from the chain.
//   GET  /api/flywheel         → creator fees (earned, claimed, waiting in the Pons fee escrow), $TROYA burned (all of it at
//                                0x…dEaD, and what the flywheel burned), liquidity locked for good (Uniswap v4 positions
//                                in the $TROYA pool owned by 0x…dEaD, valued at today's price) and the cycles
//   POST /api/flywheel/record  → {cycle, step, hash}: one step of a cycle the creator wallet signed (claim, buyback, burn,
//                                lock); it is checked on chain (signer, status, what moved) before it is logged
// The creator wallet signs every transaction in its own browser wallet. The server holds no key and moves nothing.
import { Interface, AbiCoder, keccak256, getAddress, zeroPadValue, toBeHex } from "ethers";
import { rpc, ADDR, ponsState } from "./robinhood.mjs";
import { getEthUsd } from "./market.mjs";
import { HttpError } from "./api.mjs";

export const TROYA = getAddress("0x1fa81ddaaac83240803b3f2d20595e40edc1a074");
export const CREATOR = getAddress("0x57b09fe6dab0a7d3776e56e6388c773d6c4d09e4");
export const ESCROW = getAddress("0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e");
export const POSM = getAddress("0x58daec3116aae6d93017baaea7749052e8a04fa7");          // Uniswap v4 PositionManager
export const DEAD = "0x000000000000000000000000000000000000dEaD";
const LAUNCH_BLOCK = 114_314_797;                                                     // the one mint of $TROYA
const MINTED = 1_000_000_000;                                                         // minted once, straight to the Pons curve
const ZERO = "0x0000000000000000000000000000000000000000";
const OFFICIAL = "https://rpc.mainnet.chain.robinhood.com";
const coder = AbiCoder.defaultAbiCoder();
const lc = (s) => String(s || "").toLowerCase();
const pad = (a) => zeroPadValue(lc(a), 32);
const T = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  credited: "0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5",     // Credited(address recipient, address source, uint256)
  claimed: "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a",      // Claimed(address recipient, uint256)
};
const ercI = new Interface(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const escI = new Interface(["function balanceOf(address) view returns (uint256)"]);
const posI = new Interface([
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
]);
const pmI = new Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);

let store = null;
const FILE = "flywheel.json";
// v: bump when the scan rules change; the scanned history is then read again from launch (cycles are kept)
const V = 2;
const blank = () => ({ v: V, scanned: LAUNCH_BLOCK - 1, credited: "0", credits: 0, claimed: "0", claims: [], burns: [], locked: [], cycles: [] });
const fresh = (x) => (x?.v === V ? { ...blank(), ...x } : { ...blank(), cycles: x?.cycles || [] });

const call = (to, data, block = "latest") => rpc("robinhood", "eth_call", [{ to, data }, block], { timeoutMs: 12000 });
const big = (x) => BigInt(x || 0);
const eth = (wei) => Number(big(wei)) / 1e18;
const qty = (n) => "0x" + Number(n).toString(16);                                    // JSON-RPC quantities: no leading zeros

/* ---------- the $TROYA pool (Uniswap v4, Pons hook) ---------- */
async function poolOf() {
  const s = await ponsState(TROYA);
  if (!s?.v4Key) throw new HttpError(503, "The $TROYA pool could not be read right now.");
  return { key: s.v4Key, id: s.poolId };
}
// slot0 and active liquidity straight from the PoolManager's storage (pools mapping at slot 6)
async function poolState(id, block = "latest") {
  const base = BigInt(keccak256(coder.encode(["bytes32", "uint256"], [id, 6])));
  const [s0, liq] = await Promise.all([
    call(ADDR.poolManager, pmI.encodeFunctionData("extsload", [toBeHex(base, 32)]), block),
    call(ADDR.poolManager, pmI.encodeFunctionData("extsload", [toBeHex(base + 3n, 32)]), block),
  ]);
  const w = BigInt(pmI.decodeFunctionResult("extsload", s0)[0]);
  const sqrtPriceX96 = w & ((1n << 160n) - 1n);
  let tick = Number((w >> 160n) & 0xffffffn); if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick, liquidity: BigInt(pmI.decodeFunctionResult("extsload", liq)[0]) & ((1n << 128n) - 1n) };
}
const sqrtOfTick = (t) => Math.pow(1.0001, t / 2);
function amountsFor(L, sp, sa, sb) {
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
}
const int24 = (x) => { const v = Number(x & 0xffffffn); return v >= 0x800000 ? v - 0x1000000 : v; };
// any Uniswap v4 pool of $TROYA against ETH counts (the Pons pool and the hookless 1% pool whose position was burned
// on 15 Nov); the flywheel adds to the Pons pool, where the trading is
const isTroyaEth = (k) => lc(k.currency0) === lc(ZERO) && lc(k.currency1) === lc(TROYA);
const idOfKey = (k) => keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
async function positionOf(tokenId) {
  const [pi, lq] = await Promise.all([
    call(POSM, posI.encodeFunctionData("getPoolAndPositionInfo", [tokenId])).then((r) => posI.decodeFunctionResult("getPoolAndPositionInfo", r)),
    call(POSM, posI.encodeFunctionData("getPositionLiquidity", [tokenId])).then((r) => posI.decodeFunctionResult("getPositionLiquidity", r)[0]),
  ]);
  if (!isTroyaEth(pi.poolKey)) return null;
  const info = BigInt(pi.info), k = pi.poolKey;
  return { tokenId: String(tokenId), liquidity: BigInt(lq), tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n),
    poolId: idOfKey(k), fee: Number(k.fee), hooks: getAddress(k.hooks), pons: lc(k.hooks) === lc(ADDR.ponsHook) };
}

/* ---------- scan the chain since the last look (fees, claims, burns, positions sent to 0x…dEaD) ---------- */
async function logs(filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += 9_000_000) {
    const b = Math.min(to, a + 8_999_999);
    for (let tries = 0; ; tries++) {
      try { out.push(...(await rpc("robinhood", "eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(b) }], { only: OFFICIAL, timeoutMs: 20000 }) || [])); break; }
      catch (e) { if (tries >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (tries + 1))); }
    }
  }
  return out;
}
let scanning = null;
async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const d = fresh(await store.readJson(FILE, blank()));
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    const from = d.scanned + 1, to = head - 2;
    if (to < from) return d;
    const step = async (f) => { const r = await logs(f, from, to); await new Promise((x) => setTimeout(x, 400)); return r; };
    const cr = await step({ address: ESCROW, topics: [T.credited, pad(CREATOR)] });
    const cl = await step({ address: ESCROW, topics: [T.claimed, pad(CREATOR)] });
    // burns by the creator wallet: burn() (a transfer to the zero address, supply goes down) or a send to 0x…dEaD
    // (two queries: the official RPC allows long ranges only with one value per topic)
    const bn = [...await step({ address: TROYA, topics: [T.transfer, pad(CREATOR), pad(DEAD)] }), ...await step({ address: TROYA, topics: [T.transfer, pad(CREATOR), pad(ZERO)] })];
    const nf = await step({ address: POSM, topics: [T.transfer, null, pad(DEAD)] });
    const add = { credited: 0n, claims: [], burns: [], locked: [] };
    for (const l of cr) add.credited += big(l.data);
    for (const l of cl) add.claims.push({ hash: l.transactionHash, block: Number(BigInt(l.blockNumber)), eth: eth(l.data) });
    for (const l of bn) add.burns.push({ hash: l.transactionHash, block: Number(BigInt(l.blockNumber)), troya: eth(l.data) });
    for (const l of nf) {
      const id = BigInt(l.topics[3]);
      const p = await positionOf(id).catch(() => null);
      if (p) add.locked.push({ tokenId: p.tokenId, hash: l.transactionHash, block: Number(BigInt(l.blockNumber)), from: getAddress("0x" + l.topics[1].slice(26)) });
    }
    return store.update(FILE, blank(), (x0) => {
      const x = fresh(x0);
      if (x.scanned >= to || x.scanned !== d.scanned) return x;
      x.credited = (big(x.credited) + add.credited).toString(); x.credits += cr.length;
      const seen = new Set([...x.claims, ...x.burns, ...x.locked].map((y) => y.hash + (y.tokenId || "")));
      for (const c of add.claims) if (!seen.has(c.hash)) x.claims.push(c);
      for (const b of add.burns) if (!seen.has(b.hash)) x.burns.push(b);
      for (const p of add.locked) if (!seen.has(p.hash + p.tokenId)) x.locked.push(p);
      x.claimed = x.claims.reduce((s, c) => s + c.eth, 0).toString();
      x.scanned = to;
      return x;
    });
  })().finally(() => { scanning = null; });
  return scanning;
}

/* ---------- the public view ---------- */
let view = null;
export async function flywheelView() {
  if (view && Date.now() - view.at < 60_000) return view.v;
  const d = await scan().catch(async (e) => { console.warn("[flywheel] scan:", e.message); return { ...blank(), ...(await store.readJson(FILE, blank())) }; });
  const { key, id } = await poolOf();
  const [st, waitingRaw, deadRaw, supplyRaw, ethUsd, creatorEth] = await Promise.all([
    poolState(id), call(ESCROW, escI.encodeFunctionData("balanceOf", [CREATOR])), call(TROYA, ercI.encodeFunctionData("balanceOf", [DEAD])),
    call(TROYA, ercI.encodeFunctionData("totalSupply")), getEthUsd().catch(() => null), rpc("robinhood", "eth_getBalance", [CREATOR, "latest"]),
  ]);
  // ETH is currency0 and $TROYA currency1, both 18 decimals: price = TROYA per ETH
  const ethFirst = lc(key.c0) === lc("0x0000000000000000000000000000000000000000");
  const sp = Number(st.sqrtPriceX96) / 2 ** 96, troyaPerEth = ethFirst ? sp * sp : 1 / (sp * sp);
  const troyaUsd = ethUsd && troyaPerEth > 0 ? ethUsd / troyaPerEth : null;
  const positions = [], states = new Map([[lc(id), st]]);
  for (const p of d.locked) {
    const now = await positionOf(BigInt(p.tokenId)).catch(() => null);
    if (!now) continue;
    if (!states.has(lc(now.poolId))) states.set(lc(now.poolId), await poolState(now.poolId).catch(() => null));
    const ps = states.get(lc(now.poolId));
    if (!ps) continue;
    const psp = Number(ps.sqrtPriceX96) / 2 ** 96;
    const [a0, a1] = amountsFor(Number(now.liquidity), psp, sqrtOfTick(now.tickLower), sqrtOfTick(now.tickUpper));
    const ethAmt = a0 / 1e18, troyaAmt = a1 / 1e18;
    const inRange = ps.tick >= now.tickLower && ps.tick < now.tickUpper;
    positions.push({ ...p, pool: now.pons ? "Pons pool" : `Uniswap v4 ${now.fee / 1e4}% pool`, poolId: now.poolId, liquidity: now.liquidity.toString(), eth: ethAmt, troya: troyaAmt,
      usd: ethUsd ? ethAmt * ethUsd + troyaAmt * (troyaUsd || 0) : null, fullRange: now.tickLower <= -887000 && now.tickUpper >= 887000, inRange, _L: inRange && lc(now.poolId) === lc(id) ? now.liquidity : 0n });
  }
  const lockedL = positions.reduce((s, p) => s + p._L, 0n);
  const supply = eth(supplyRaw), dead = eth(deadRaw);
  const cycles = (d.cycles || []).slice().sort((a, b) => b.startedAt - a.startedAt);
  const sum = (f) => cycles.reduce((s, c) => s + (f(c) || 0), 0);
  const v = {
    token: TROYA, creator: CREATOR, escrow: ESCROW, dead: DEAD, positionManager: POSM, permit2: ADDR.permit2, poolId: id,
    pool: { key, sqrtPriceX96: st.sqrtPriceX96.toString(), tick: st.tick, liquidity: st.liquidity.toString() },
    price: { troyaPerEth, troyaUsd, ethUsd },
    fees: { earnedEth: eth(d.credited), credits: d.credits, claimedEth: Number(d.claimed) || 0, claims: d.claims.length, waitingEth: eth(waitingRaw), creatorWalletEth: eth(creatorEth) },
    // burned = what left the supply through burn() plus what sits at 0x…dEaD
    burned: { total: MINTED - supply + dead, pctOfMinted: (MINTED - supply + dead) / MINTED * 100, viaBurn: MINTED - supply, atDead: dead, supply, minted: MINTED,
      byCreator: d.burns.reduce((s, b) => s + b.troya, 0), burns: d.burns.slice(-50).reverse() },
    locked: { positions: positions.map(({ _L, ...p }) => p), usd: positions.reduce((s, p) => s + (p.usd || 0), 0), eth: positions.reduce((s, p) => s + p.eth, 0), troya: positions.reduce((s, p) => s + p.troya, 0),
      shareOfActivePct: st.liquidity > 0n ? Number(lockedL * 10000n / st.liquidity) / 100 : null },
    cycles, totals: { cycles: cycles.length, ethToBuyback: sum((c) => c.steps?.buyback?.ethIn), troyaBought: sum((c) => c.steps?.buyback?.troyaOut), troyaBurned: sum((c) => c.steps?.burn?.troya),
      ethLocked: sum((c) => c.steps?.lock?.eth), troyaLocked: sum((c) => c.steps?.lock?.troya) },
    scannedTo: d.scanned, updatedAt: Date.now(),
    rules: "Creator fees on $TROYA (70% of the 1% Pons fee plus the 1.9% creator tax) are credited to the creator wallet in the Pons fee escrow. A cycle claims them; a share goes to the flywheel and the rest stays with the creator. The flywheel share buys $TROYA back through Troya Gate, burns part of it with the token's own burn() so the supply goes down, and adds the rest as liquidity to the $TROYA pool, a position minted straight to 0x…dEaD so nobody can remove it. Each step is signed by the creator wallet, by hand or by the automatic mode; this page reads every number back from the chain.",
  };
  view = { at: Date.now(), v };
  return v;
}

/* ---------- a cycle step, checked on chain ---------- */
const STEPS = ["claim", "buyback", "burn", "lock"];
async function receiptOf(hash) {
  for (let i = 0; i < 6; i++) {
    const [tx, rc] = await Promise.all([rpc("robinhood", "eth_getTransactionByHash", [hash]), rpc("robinhood", "eth_getTransactionReceipt", [hash])]);
    if (tx && rc) return { tx, rc };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new HttpError(404, "That transaction is not on Robinhood Chain (yet).");
}
const fromTo = (l, a, b) => (!a || lc(l.topics[1]) === lc(pad(a))) && (!b || lc(l.topics[2]) === lc(pad(b)));
export async function recordStep({ cycle, step, hash }) {
  if (!/^c\d{10,14}$/.test(String(cycle || ""))) throw new HttpError(400, "Bad cycle id.");
  if (!STEPS.includes(step)) throw new HttpError(400, `Step must be one of ${STEPS.join(", ")}.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new HttpError(400, "Bad transaction hash.");
  const { tx, rc } = await receiptOf(hash);
  if (lc(tx.from) !== lc(CREATOR)) throw new HttpError(403, "Only transactions signed by the $TROYA creator wallet count as flywheel steps.");
  if (Number(rc.status) !== 1) throw new HttpError(400, "That transaction failed on chain.");
  const L = rc.logs || [], block = Number(BigInt(rc.blockNumber));
  let rec;
  if (step === "claim") {
    const c = L.find((l) => lc(l.address) === lc(ESCROW) && l.topics[0] === T.claimed && lc(l.topics[1]) === lc(pad(CREATOR)));
    if (!c) throw new HttpError(400, "No fee claim from the Pons escrow in that transaction.");
    rec = { hash, block, eth: eth(c.data) };
  } else if (step === "buyback") {
    const got = L.filter((l) => lc(l.address) === lc(TROYA) && l.topics[0] === T.transfer && fromTo(l, null, CREATOR)).reduce((s, l) => s + big(l.data), 0n);
    if (!got) throw new HttpError(400, "No $TROYA reached the creator wallet in that transaction.");
    rec = { hash, block, ethIn: eth(tx.value), troyaOut: eth(got) };
  } else if (step === "burn") {
    const b = L.filter((l) => lc(l.address) === lc(TROYA) && l.topics[0] === T.transfer && (fromTo(l, CREATOR, DEAD) || fromTo(l, CREATOR, ZERO))).reduce((s, l) => s + big(l.data), 0n);
    if (!b) throw new HttpError(400, "No $TROYA was burned by the creator wallet in that transaction.");
    rec = { hash, block, troya: eth(b) };
  } else {
    const m = L.find((l) => lc(l.address) === lc(POSM) && l.topics[0] === T.transfer && l.topics.length === 4 && BigInt(l.topics[1]) === 0n && lc(l.topics[2]) === lc(pad(DEAD)));
    if (!m) throw new HttpError(400, "No Uniswap v4 position was minted to 0x…dEaD in that transaction.");
    const p = await positionOf(BigInt(m.topics[3]));
    if (!p) throw new HttpError(400, "That position is not in a $TROYA/ETH pool.");
    const troyaIn = L.filter((l) => lc(l.address) === lc(TROYA) && l.topics[0] === T.transfer && fromTo(l, CREATOR, null)).reduce((s, l) => s + big(l.data), 0n);
    // the ETH it holds comes from its liquidity at the price of that block
    const st = await poolState(p.poolId, qty(block)).catch(() => poolState(p.poolId));
    const sp = Number(st.sqrtPriceX96) / 2 ** 96;
    const [a0, a1] = amountsFor(Number(p.liquidity), sp, sqrtOfTick(p.tickLower), sqrtOfTick(p.tickUpper));
    rec = { hash, block, tokenId: p.tokenId, pool: p.pons ? "Pons pool" : `Uniswap v4 ${p.fee / 1e4}% pool`, liquidity: p.liquidity.toString(), eth: a0 / 1e18, troya: troyaIn ? eth(troyaIn) : a1 / 1e18 };
  }
  await store.update(FILE, blank(), (x0) => {
    const x = fresh(x0);
    if (x.cycles.some((c) => Object.values(c.steps || {}).some((s) => s.hash === hash))) return x;
    let c = x.cycles.find((y) => y.id === cycle);
    if (!c) { const n = Number(cycle.slice(1)); c = { id: cycle, startedAt: n < 1e12 ? n * 1000 : n, steps: {} }; x.cycles.push(c); }
    if (c.steps[step]) throw new HttpError(409, `This cycle already has a ${step} step.`);
    c.steps[step] = rec;
    if (step === "lock" && !x.locked.some((y) => y.tokenId === rec.tokenId)) x.locked.push({ tokenId: rec.tokenId, hash, block, from: CREATOR });
    return x;
  });
  view = null;
  return { ok: true, step, ...rec };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/flywheel", () => flywheelView(), { weight: 1 });
  r.post("/api/flywheel/record", ({ body }) => recordStep(body || {}), { weight: 2, perMin: 30 });
  // keep the scan warm so the page answers at once
  setTimeout(() => scan().catch((e) => console.warn("[flywheel] scan:", e.message)), 20_000).unref?.();
  setInterval(() => scan().catch((e) => console.warn("[flywheel] scan:", e.message)), 5 * 60_000).unref?.();
}
