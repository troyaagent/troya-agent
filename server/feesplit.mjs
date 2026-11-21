// $TROYA fee split (owner, 21 Nov 2026). The $TROYA creator wallet earns 2.6% of every $TROYA trade (0.7% = 70% of the 1%
// Pons fee, plus the 1.9% creator tax; Pons keeps 0.3%). From startBlock (data/fee-split-start.json; creator fees credited
// before it belong to the owner and are never split) each creator-fee credit is split by the $TROYA market cap in the hour it
// was credited:
//     MC under $35k     stakers 0.1% of volume  (credit × 10/260), the owner keeps the rest
//     $35k to $100k     stakers 0.5%            (credit × 50/260)
//     $100k and up      stakers 1.0%            (credit × 100/260) and 0.1% bought back and burned (credit × 10/260)
// The tier follows the market cap up and down, hour by hour. Against a pumped read, the market cap is read every 10 minutes
// from three places (Troya's market index, DexScreener, the Uniswap v4 pool price × supply on chain) and an hour's market cap
// is the median of all of that hour's reads (data/mc-hourly.json). A credit uses its hour's tier; an hour with no read uses the
// last hour before it that has one; before any read at all, the lowest tier.
// Credits are the Pons fee escrow's Credited events for the creator wallet (the events flywheel.mjs scans), summed per hour
// (data/fee-credits.json). Only weeklyRun() moves money; server/payouts.mjs calls it every Monday after the Herald payouts:
//   · stakers: their ETH goes to TroyaStake.notifyReward(), shared by every coin staked at that moment, at one rate per staked
//     coin (owner, 21 Nov 2026): a run pays share × min(1, totalStaked / target), the target being STAKE_FULL_TARGET_PCT
//     (default 5) % of the current total supply; the unpaid part stays with the owner. Coins waiting out the cooldown do not
//     count (the contract's totalStaked). So one staker with 1M $TROYA gets about 1/48 of the week's share. It is kept (the staker
//     pot) while the stake contract is not live and until the second Monday after it goes live, so people have time to stake
//     and the pot is not sniped minutes before; from then on it is sent every Monday. If nobody is staked at a paying run, or
//     the run cannot send it (the gas reserve, a transaction that fails after retries), it stays with the owner: nothing is
//     carried to the next week. The pre-launch pot follows the same rule on its paying Monday.
//   · burn: the burn ETH buys $TROYA through the flywheel's buyback path (Troya Gate, the Universal Router only, 3% slippage
//     bound) and burn()s all of it (flywheel-auto.mjs buybackAndBurn). What cannot be bought back stays with the owner.
//   · the creator wallet keeps PAYOUT_RESERVE_ETH (0.003) for gas; stakers are paid before the burn when the wallet is short.
//   · STAKE_REWARDS: "live" sends; "dry" (the default) works everything out and records it without sending and settles
//     nothing (a later live run pays everything since the last live run, under the same rules); "off" skips the weekly run
//     (the market cap and the credits are still recorded: read-only).
// Herald payouts (referral rewards and Cup prizes) are untouched: paid from the owner's part, as before.
//   GET /api/feesplit     public: the rule, this hour's tier and market cap, this week so far, the staker pot, past weeks
import { Interface } from "ethers";
import { rpc, CHAINS } from "./robinhood.mjs";
import { TROYA, CREATOR, ESCROW } from "./flywheel.mjs";
import { HttpError } from "./api.mjs";

const START_FILE = "fee-split-start.json", CREDITS_FILE = "fee-credits.json", MC_FILE = "mc-hourly.json", LEDGER = "fee-split.json";
// the owner's start (21 Nov 2026), used when data/fee-split-start.json is missing
export const DEFAULT_START = { startBlock: 119_990_898, creditedWeiAtStart: "1933781537705012708" };
export const CREATOR_BPS = 260;          // the creator wallet's 2.6% of volume, in basis points
export const TIERS = [
  { key: "base", name: "Under $35k", minMc: 0, stakerBps: 10, burnBps: 0 },
  { key: "mid", name: "$35k to $100k", minMc: 35_000, stakerBps: 50, burnBps: 0 },
  { key: "top", name: "$100k and up", minMc: 100_000, stakerBps: 100, burnBps: 10 },
];
const T_CREDITED = "0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5";   // Credited(recipient, source, amount), as flywheel.mjs
const HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const MIN_NOTIFY_WEI = 10n ** 13n;       // 0.00001 ETH
const MIN_BURN_WEI = 5n * 10n ** 14n;    // 0.0005 ETH, the flywheel's own smallest buyback
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const pad = (a) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const ethOf = (wei) => Number(BigInt(wei || 0)) / 1e18;
const r6 = (x) => +Number(x || 0).toFixed(6);
export const modeOf = () => (["live", "dry", "off"].includes(process.env.STAKE_REWARDS) ? process.env.STAKE_REWARDS : "dry");
const reserveEth = () => { const v = Number(process.env.PAYOUT_RESERVE_ETH); return v >= 0 && isFinite(v) && process.env.PAYOUT_RESERVE_ETH ? v : 0.003; };
let store = null;

export const WORDING = "A share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield.";
export const NO_STAKERS = "If nobody is staked when the weekly share is paid, it stays with the team.";
export const targetPct = () => { const v = Number(process.env.STAKE_FULL_TARGET_PCT); return v > 0 && v <= 100 ? v : 5; };
export const RATE_RULE = () => `Each staked $TROYA earns the same rate. The full weekly share is paid once ${targetPct()}% of supply is staked; until then the unpaid part stays with the team.`;
export const RULE = "The $TROYA creator wallet earns 2.6% of every $TROYA trade. Each fee is split by the $TROYA market cap in the hour it came in (the median of several reads that hour): under $35k stakers get 0.1% of trading volume, from $35k 0.5%, from $100k 1% and another 0.1% buys $TROYA back and burns it. Every Monday, after the Herald payouts, the stakers' ETH is sent to the stake contract and shared by every coin staked at that moment; claim it on the stake page. Each staked $TROYA earns the same rate: the full share is paid once 5% of the supply is staked, and with less staked only that fraction is paid (2.5% staked: half the share) while the rest stays with the team. Fees from before the contract is live are kept and paid on the second Monday after it goes live. Anything the run cannot send stays with the team; nothing is carried over.";

/* ---------------- pure parts (tools/feesplit-test.mjs feeds them fixtures) ---------------- */

export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);          // "2026-11-21T13", UTC
export const hourStart = (key) => Date.parse(`${key}:00:00.000Z`);
export function tierOfMc(mc) { let t = TIERS[0]; for (const x of TIERS) if (Number(mc) >= x.minMc) t = x; return t; }
export function median(xs) {
  const v = xs.map(Number).filter((x) => isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
// the sampled hours, oldest first (keys sort by time)
const sampledKeys = (mcHours) => Object.keys(mcHours || {}).filter((k) => mcHours[k]?.median > 0).sort();
/** The market cap that applies to hour `key`: its own median, else the last hour before it that has one, else null. */
export function mcAt(mcHours, key, keys = sampledKeys(mcHours)) {
  let lo = 0, hi = keys.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= key) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best < 0 ? { mc: null, hour: null } : { mc: mcHours[keys[best]].median, hour: keys[best] };
}
export function splitWei(wei, tier) {
  const w = BigInt(wei);
  const staker = (w * BigInt(tier.stakerBps)) / BigInt(CREATOR_BPS), burn = (w * BigInt(tier.burnBps)) / BigInt(CREATOR_BPS);
  return { staker, burn, owner: w - staker - burn };
}
/** Sums the credited hours whose start is in [fromMs, toMs), each split by its hour's tier. */
export function accrue(creditHours, mcHours, fromMs = 0, toMs = Infinity) {
  const keys = sampledKeys(mcHours);
  const out = { credits: 0, creditedWei: 0n, stakerWei: 0n, burnWei: 0n, ownerWei: 0n, hours: 0, unknownMcHours: 0, byTier: {} };
  for (const t of TIERS) out.byTier[t.key] = { credits: 0, hours: 0, creditedWei: 0n, stakerWei: 0n, burnWei: 0n };
  for (const [k, c] of Object.entries(creditHours || {})) {
    const hs = hourStart(k);
    if (!(hs >= fromMs && hs < toMs)) continue;
    const { mc } = mcAt(mcHours, k, keys);
    const tier = mc == null ? TIERS[0] : tierOfMc(mc);
    const s = splitWei(c.wei, tier), b = out.byTier[tier.key];
    if (mc == null) out.unknownMcHours++;
    out.hours++; out.credits += c.n || 0; out.creditedWei += BigInt(c.wei); out.stakerWei += s.staker; out.burnWei += s.burn; out.ownerWei += s.owner;
    b.hours++; b.credits += c.n || 0; b.creditedWei += BigInt(c.wei); b.stakerWei += s.staker; b.burnWei += s.burn;
  }
  return out;
}
/** The stake that earns the full share: pct % of the supply, in base units. */
export const targetOf = (supplyRaw, pct = targetPct()) => (BigInt(supplyRaw || 0) * BigInt(Math.round(pct * 10_000))) / 1_000_000n;
/** What the stakers receive of a share `wei`: wei × min(1, staked / target) (BigInt, rounded down). */
export function paidOf(wei, totalStakedRaw, supplyRaw, pct = targetPct()) {
  const target = targetOf(supplyRaw, pct), staked = BigInt(totalStakedRaw || 0), w = BigInt(wei);
  if (!(target > 0n)) return 0n;
  return staked >= target ? w : (w * staked) / target;
}
/** The first Monday 00:00 UTC strictly after `ms`. */
export function nextMonday(ms) {
  const d = new Date(ms), day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let m = day0 + ((7 - ((d.getUTCDay() + 6) % 7)) % 7) * DAY;
  if (m <= ms) m += WEEK;
  return m;
}
/** The Monday whose run first pays the stakers: the second Monday after the contract went live. */
export const payFrom = (deployedAt) => nextMonday(deployedAt) + WEEK;

/**
 * What one weekly run does with the stakers' and the burn ETH (wei, BigInt). Stakers first, then the burn, both inside what
 * the creator wallet holds above the reserve. Nothing is carried: a part not sent is "return" (stays with the owner), except
 * the stakers' part before their first paying Monday, which is "hold" (the pot; settle false).
 */
export function decideWeek({ end, stakerWei, burnWei, contractLive, deployedAt, totalStakedRaw, supplyRaw, targetPct: pct = targetPct(), balanceWei, reserveWei }) {
  let room = BigInt(balanceWei) > BigInt(reserveWei) ? BigInt(balanceWei) - BigInt(reserveWei) : 0n;
  const S = BigInt(stakerWei), B = BigInt(burnWei);
  let stakers;
  if (!contractLive) stakers = { action: "hold", settle: false, reason: "The stake contract is not live yet: kept for the second Monday after it goes live." };
  else if (!(deployedAt > 0)) stakers = { action: "hold", settle: false, reason: "The stake contract's deploy time is unknown (deployBlock in data/stake.json): kept." };
  else if (end < payFrom(deployedAt)) stakers = { action: "hold", settle: false, payOn: payFrom(deployedAt), reason: `Kept until ${new Date(payFrom(deployedAt)).toISOString().slice(0, 10)}, the second Monday after the contract went live, so everyone has time to stake.` };
  else if (S === 0n) stakers = { action: "none", settle: true };
  else if (!(BigInt(totalStakedRaw || 0) > 0n)) stakers = { action: "return", settle: true, returnedWei: S, reason: "Returned to the owner: no stakers." };
  else {
    // one rate per staked coin: the full share only once the target (pct % of the supply) is staked
    const due = paidOf(S, totalStakedRaw, supplyRaw, pct);
    const target = targetOf(supplyRaw, pct), staked = BigInt(totalStakedRaw);
    const fractionPpm = target > 0n ? Number(staked >= target ? 1_000_000n : (staked * 1_000_000n) / target) : 0;
    const rate = fractionPpm < 1_000_000 ? `Paid at ${(fractionPpm / 10_000).toFixed(2)}%: ${(Number(staked) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} of the ${(Number(target) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $TROYA target (${pct}% of supply) is staked; the rest stays with the team.` : null;
    const send = due < room ? due : room;
    if (send < MIN_NOTIFY_WEI) stakers = { action: "return", settle: true, returnedWei: S, fractionPpm, dueWei: due, reason: due < MIN_NOTIFY_WEI ? `Returned to the owner: under 0.00001 ETH to send${rate ? ` (${rate.replace(/; the rest stays with the team\.$/, "")})` : ""}.` : "Returned to the owner: the creator wallet could not cover it above its gas reserve." };
    else {
      stakers = { action: "send", settle: true, sendWei: send, returnedWei: S - send, fractionPpm, dueWei: due,
        ...(send < due ? { reason: `${rate ? `${rate.replace(/ the rest stays with the team\.$/, "")} ` : ""}Partly returned to the owner: the creator wallet keeps its gas reserve.` } : rate ? { reason: rate } : {}) };
      room -= send;
    }
  }
  let burn;
  if (B === 0n) burn = { action: "none", settle: true };
  else {
    const send = B < room ? B : room;
    if (send < MIN_BURN_WEI) burn = { action: "return", settle: true, returnedWei: B, reason: B < MIN_BURN_WEI ? "Returned to the owner: below the 0.0005 ETH smallest buyback." : "Returned to the owner: the creator wallet could not cover it above its gas reserve." };
    else burn = { action: "send", settle: true, sendWei: send, returnedWei: B - send, ...(B > send ? { reason: "Partly returned to the owner: the creator wallet keeps its gas reserve." } : {}) };
  }
  return { stakers, burn };
}
/** Credited logs → [{ block, i, hash, wei, ts }], only blocks from startBlock on (credits before it are the owner's), in order. */
export function creditsFromLogs(logs, startBlock) {
  return (logs || []).map((l) => ({ block: Number(BigInt(l.blockNumber)), i: Number(BigInt(l.logIndex || 0)), hash: l.transactionHash, wei: BigInt("0x" + (String(l.data || "0x").replace(/^0x/, "").slice(-64) || "0")), ts: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) * 1000 : 0 }))
    .filter((x) => x.block >= startBlock).sort((a, b) => a.block - b.block || a.i - b.i);
}
/** Adds timed credits to the per-hour sums { "2026-11-21T13": { n, wei } } (in place). */
export function addCredits(hours, list) {
  for (const x of list) {
    const h = (hours[hourKey(x.ts)] ||= { n: 0, wei: "0" });
    h.n++; h.wei = (BigInt(h.wei) + BigInt(x.wei)).toString();
  }
  return hours;
}
const sumView = (a) => ({
  credits: a.credits, hours: a.hours, unknownMcHours: a.unknownMcHours, creditedEth: r6(ethOf(a.creditedWei)), stakerEth: r6(ethOf(a.stakerWei)), burnEth: r6(ethOf(a.burnWei)), ownerEth: r6(ethOf(a.ownerWei)),
  byTier: Object.fromEntries(Object.entries(a.byTier).map(([k, b]) => [k, { credits: b.credits, hours: b.hours, creditedEth: r6(ethOf(b.creditedWei)), stakerEth: r6(ethOf(b.stakerWei)), burnEth: r6(ethOf(b.burnWei)) }])),
});

/* ---------------- the start ---------------- */
export async function startOf() {
  const raw = store ? await store.readJson(START_FILE, null) : null;
  const b = Math.floor(Number(raw?.startBlock));
  return b > 0 ? { startBlock: b, creditedWeiAtStart: String(raw.creditedWeiAtStart ?? "0"), from: "data/fee-split-start.json" } : { ...DEFAULT_START, from: "default (owner, 21 Nov 2026)" };
}

/* ---------------- the market cap, sampled ---------------- */
async function mcReads() {
  const out = [];
  const m = await import("./market.mjs").catch(() => null);
  const row = m?.indexRow?.(TROYA);
  if (row?.mcapUsd > 0) out.push(["index", row.mcapUsd]);
  const pairs = (await m?.dsTokenPairs?.(TROYA).catch(() => [])) || [];
  const best = pairs.filter((p) => lc(p?.baseToken?.address) === lc(TROYA)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const ds = Number(best?.marketCap ?? best?.fdv);
  if (ds > 0) out.push(["dexscreener", ds]);
  const fw = await import("./flywheel.mjs").then((f) => f.flywheelView()).catch(() => null);
  const px = Number(fw?.price?.troyaUsd), sup = fw?.burned ? Number(fw.burned.supply) - Number(fw.burned.atDead || 0) : 0;
  if (px > 0 && sup > 0) out.push(["chain", px * sup]);
  return out.filter(([, v]) => isFinite(v) && v > 0 && v < 1e12);
}
let sampling = false;
export async function sampleMc() {
  if (sampling || !store) return;
  sampling = true;
  try {
    const reads = await mcReads();
    if (!reads.length) return;
    const now = Date.now(), k = hourKey(now), t = Math.floor(now / 1000);
    await store.update(MC_FILE, { hours: {} }, (d) => {
      d.hours ||= {};
      const h = (d.hours[k] ||= { reads: [] });
      for (const [src, v] of reads) h.reads.push([t, src, Math.round(v)]);
      h.reads = h.reads.slice(-60);
      h.median = Math.round(median(h.reads.map((x) => x[2])));
      h.n = h.reads.length;
      const cut = hourKey(now - 120 * DAY);
      for (const key of Object.keys(d.hours)) if (key < cut) delete d.hours[key];
      return d;
    });
    view = null;
  } catch (e) { console.warn("[feesplit] market cap:", e.message); }
  finally { sampling = false; }
}

/* ---------------- the credits, from the chain ---------------- */
const blockTs = new Map();
async function tsOf(block) {
  if (blockTs.has(block)) return blockTs.get(block);
  const b = await rpc("robinhood", "eth_getBlockByNumber", [hex(block), false], { timeoutMs: 12_000 });
  const t = b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : 0;
  if (!t) throw new Error(`no time for block ${block}`);
  blockTs.set(block, t);
  if (blockTs.size > 4000) blockTs.delete(blockTs.keys().next().value);
  return t;
}
let scanning = false;
export async function scanCredits() {
  if (scanning || !store) return;
  scanning = true;
  try {
    const st = await startOf();
    let d = await store.readJson(CREDITS_FILE, {});
    if (d.startBlock !== st.startBlock) d = { startBlock: st.startBlock, cursor: st.startBlock - 1, cursorTime: 0, hours: {}, last: [] };
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", []))) - 2;
    for (let pass = 0; pass < 6 && d.cursor < head; pass++) {
      const from = d.cursor + 1, to = Math.min(head, from + 199_999);
      const logs = await rpc("robinhood", "eth_getLogs", [{ address: ESCROW, topics: [T_CREDITED, pad(CREATOR)], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 30_000, only: CHAINS.robinhood.wide });
      const list = creditsFromLogs(logs, st.startBlock);
      // every credit needs its block's time (at most 300 block reads a pass; a block is taken whole or not at all)
      let reads = 0, done = to;
      for (const x of list) {
        if (!x.ts) {
          if (!blockTs.has(x.block) && ++reads > 300) { done = x.block - 1; break; }
          x.ts = await tsOf(x.block);
        }
      }
      const take = list.filter((x) => x.block <= done && x.ts);
      addCredits(d.hours, take);
      d.last = [...take.slice(-50).reverse().map((x) => ({ block: x.block, hash: x.hash, eth: ethOf(x.wei), at: x.ts })), ...(d.last || [])].slice(0, 50);
      d.cursorTime = await tsOf(done).catch(() => d.cursorTime);
      d.cursor = done;
      d.scannedAt = Date.now();
      await store.writeJson(CREDITS_FILE, d);
      if (done < to) break;
    }
    view = null;
  } catch (e) { console.warn("[feesplit] credits:", e.message); }
  finally { scanning = false; }
}

/* ---------------- the $TROYA supply (10 min) ---------------- */
let supplyMemo = null;
export async function supplyNow() {
  if (supplyMemo && Date.now() - supplyMemo.at < 10 * 60_000) return supplyMemo.v;
  const data = "0x18160ddd";                               // totalSupply()
  const v = BigInt(await rpc("robinhood", "eth_call", [{ to: TROYA, data }, "latest"]));
  supplyMemo = { at: Date.now(), v };
  return v;
}

/* ---------------- the stake contract ---------------- */
async function contractState() {
  const st = await import("./stake.mjs").catch(() => null);
  if (!st) return { live: false };
  const cfg = await st.stakeConfig().catch(() => null);
  if (!cfg?.contract || !(await st.stakeLive())) return { live: false, contract: cfg?.contract || null };
  const deployedAt = cfg.deployedAt || (cfg.deployBlock ? await tsOf(cfg.deployBlock).catch(() => 0) : 0);
  return { live: true, contract: cfg.contract, deployedAt, st };
}

/* ---------------- the weekly run (server/payouts.mjs, after the Herald payouts) ---------------- */
const LDEF = { stakerFrom: 0, burnFrom: 0, weeks: {} };
let running = false;
/** true once the week ending `end` is decided for this mode (a dry week is worked out again when the switch goes live) */
export async function weekDone(season) {
  const led = store ? await store.readJson(LEDGER, LDEF) : LDEF;
  const w = led.weeks?.[season];
  return !!w && (w.mode === "live" || modeOf() === "dry");
}

// deps: tests hand in a signer and a buyback (a local fork); the server always uses the creator wallet and the flywheel's path
export async function weeklyRun({ season, start, end, reason = "schedule", dry = false, deps = {} } = {}) {
  const mode = modeOf();
  if (mode === "off") return { mode, note: "The weekly fee split is off (STAKE_REWARDS=off)." };
  if (!store) throw new Error("not started");
  if (running) throw new HttpError(409, "A fee split run is already going.");
  running = true;
  try {
    const cr = await store.readJson(CREDITS_FILE, {});
    const st0 = await startOf();
    if (cr.startBlock !== st0.startBlock || !(cr.cursorTime >= end)) return { mode, waiting: true, note: "The creator-fee credits are not read up to the end of that week yet; the next run tries again." };
    const led = await store.readJson(LEDGER, LDEF);
    const prev = led.weeks?.[season];
    if (prev?.mode === "live") return { mode, already: true, week: prev };
    const live = mode === "live" && !dry;
    const mc = (await store.readJson(MC_FILE, { hours: {} })).hours || {};
    const hours = cr.hours || {};
    const stakerFrom = led.stakerFrom || 0, burnFrom = led.burnFrom || 0;
    const S = accrue(hours, mc, stakerFrom, end), B = accrue(hours, mc, burnFrom, end), W = accrue(hours, mc, start, end);
    const c = await contractState();
    const totalStakedRaw = c.live ? await c.st.totalStakedRaw().catch(() => null) : 0n;
    if (c.live && totalStakedRaw == null) throw new Error("Couldn't read totalStaked from the stake contract.");
    const supplyRaw = await supplyNow();
    if (!(supplyRaw > 0n)) throw new Error("Couldn't read the $TROYA total supply.");
    const w = live ? deps.signer || await (await import("./flywheel-auto.mjs")).payoutSigner() : null;
    if (live && !w) throw new Error("The creator wallet key is not stored on the server, so nothing can be paid automatically.");
    const balanceWei = w ? await w.provider.getBalance(w.address) : BigInt(await rpc("robinhood", "eth_getBalance", [CREATOR, "latest"]));
    const reserveWei = BigInt(Math.round(reserveEth() * 1e9)) * 10n ** 9n;
    const dec = decideWeek({ end, stakerWei: S.stakerWei, burnWei: B.burnWei, contractLive: c.live, deployedAt: c.deployedAt || 0, totalStakedRaw: totalStakedRaw || 0n, supplyRaw, targetPct: targetPct(), balanceWei, reserveWei });
    const part = (d, acc, from) => ({ fromMs: from || null, accruedEth: r6(ethOf(acc)), action: d.action, sendEth: r6(ethOf(d.sendWei || 0n)), returnedEth: r6(ethOf(d.returnedWei || 0n)), reason: d.reason || null, payOn: d.payOn || null,
      ...(d.fractionPpm != null ? { paidPct: d.fractionPpm / 10_000 } : {}),
      status: d.action === "send" ? (live ? "sending" : "dry") : d.action === "hold" ? "held" : d.action === "return" ? "returned" : "none" });
    const entry = { season, start, end, at: Date.now(), reason, mode: live ? "live" : "dry", balanceEth: r6(ethOf(balanceWei)), reserveEth: reserveEth(),
      contract: c.contract || null, contractLive: c.live, totalStaked: c.live ? String(totalStakedRaw) : null, supply: String(supplyRaw), targetPct: targetPct(), week: sumView(W),
      stakers: part(dec.stakers, S.stakerWei, stakerFrom), burn: part(dec.burn, B.burnWei, burnFrom) };
    const save = (cursors = {}) => store.update(LEDGER, LDEF, (x) => {
      x.weeks ||= {};
      if (x.weeks[season]?.mode !== "live" || x.weeks[season]?.at === entry.at) x.weeks[season] = entry;   // a live week is written once, by its own run
      Object.assign(x, cursors);
      const keep = Object.keys(x.weeks).sort().slice(-60);
      x.weeks = Object.fromEntries(keep.map((k) => [k, x.weeks[k]]));
      return x;
    });
    if (!live) { await save(); return finish(entry); }
    // live: each part is marked "sending" and its cursor moved BEFORE anything is broadcast, so a crash can never pay twice
    const cursors = { ...(dec.stakers.settle ? { stakerFrom: end } : {}), ...(dec.burn.settle ? { burnFrom: end } : {}) };
    await save(cursors);
    if (dec.stakers.action === "send") await sendStakers(w, c.contract, dec.stakers.sendWei, entry.stakers);
    if (dec.burn.action === "send") await sendBurn(dec.burn.sendWei, entry.burn, season, deps.buybackAndBurn);
    await save();
    return finish(entry);
  } finally { running = false; view = null; }
}
async function sendStakers(w, contract, value, rec) {
  const data = new Interface(["function notifyReward() payable"]).encodeFunctionData("notifyReward");
  let last = null;
  for (let a = 1; a <= 3; a++) {
    rec.attempts = a;
    try { await w.provider.call({ from: w.address, to: contract, data, value }); }      // a revert (no stakers) costs nothing
    catch (e) { last = `notifyReward would revert: ${String(e.shortMessage || e.message).slice(0, 160)}`; break; }
    let tx;
    try { tx = await w.sendTransaction({ to: contract, data, value, chainId: 4663 }); }
    catch (e) { last = `Not sent: ${String(e.shortMessage || e.message).slice(0, 160)}`; await new Promise((r) => setTimeout(r, 20_000)); continue; }
    rec.hash = tx.hash;
    try {
      const rc = await tx.wait(1, 180_000);
      if (rc?.status === 1) {
        rec.status = "sent"; rec.sentEth = rec.sendEth;
        import("./seal.mjs").then((m) => m.seal("stake-share", contract, { eth: rec.sentEth, hash: tx.hash }, `Stakers' share: ${rec.sentEth} ETH sent to TroyaStake.notifyReward()`)).catch(() => {});
        return;
      }
      last = "The transaction reverted on chain."; break;
    } catch (e) { rec.status = "unknown"; rec.reason = `Sent, but the receipt could not be read (check ${tx.hash}): ${String(e.shortMessage || e.message).slice(0, 120)}`; return; }
  }
  Object.assign(rec, { status: "returned", returnedEth: r6(rec.returnedEth + rec.sendEth), sendEth: 0, reason: `Returned to the owner: ${last || "not sent"}` });
}
async function sendBurn(wei, rec, season, injected) {
  const fw = injected ? { buybackAndBurn: injected } : await import("./flywheel-auto.mjs");
  let last = null;
  for (let a = 1; a <= 2; a++) {
    rec.attempts = a;
    try {
      const r = await fw.buybackAndBurn(ethOf(wei), { id: `split-${season}` });
      Object.assign(rec, { status: "sent", sentEth: rec.sendEth, buyHash: r.buyHash, burnHash: r.burnHash, troyaBurned: r.burned });
      return;
    } catch (e) {
      last = String(e.shortMessage || e.message).slice(0, 200);
      if (e.bought) { Object.assign(rec, { status: "failed", buyHash: e.buyHash || null, reason: `Bought back but not burned: ${last}. The $TROYA sits in the creator wallet; burn it from the flywheel page.` }); return; }
      if (a < 2) await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  Object.assign(rec, { status: "returned", returnedEth: r6(rec.returnedEth + rec.sendEth), sendEth: 0, reason: `Returned to the owner: the buyback could not run (${last}).` });
}
function finish(e) {
  const line = (n, p) => `${n}: ${p.accruedEth} ETH, ${p.status}${p.sentEth ? ` ${p.sentEth} ETH` : ""}${p.returnedEth ? `, ${p.returnedEth} ETH to the owner` : ""}${p.reason ? ` (${p.reason})` : ""}${p.hash ? ` robinhoodchain.blockscout.com/tx/${p.hash}` : ""}${p.burnHash ? ` burn robinhoodchain.blockscout.com/tx/${p.burnHash}` : ""}`;
  const t = Object.entries(e.week.byTier).filter(([, b]) => b.hours).map(([k, b]) => `${TIERS.find((x) => x.key === k)?.name}: ${b.creditedEth} ETH in ${b.hours} h`).join("; ");
  import("./community.mjs").then((m) => m.notifyAdmins?.(`<b>$TROYA fee split${e.mode === "dry" ? " (dry run, nothing sent)" : ""}</b>, week ${e.season}\nCreator fees credited that week: ${e.week.creditedEth} ETH (${e.week.credits} credits${t ? `; ${t}` : ""}).\n${line("Stakers", e.stakers)}\n${line("Burn", e.burn)}`)).catch(() => {});
  return { mode: e.mode, week: e };
}

/* ---------------- the view (stake page, /api/stake/stats, /api/feesplit) ---------------- */
let view = null;
export async function feeSplitView() {
  if (view && Date.now() - view.at < 60_000) return view.v;
  const [st, cr, mcf, led, c] = await Promise.all([startOf(), store.readJson(CREDITS_FILE, {}), store.readJson(MC_FILE, { hours: {} }), store.readJson(LEDGER, LDEF), contractState().catch(() => ({ live: false }))]);
  const mc = mcf.hours || {}, hours = cr.startBlock === st.startBlock ? cr.hours || {} : {};
  const now = Date.now(), monday = nextMonday(now) - WEEK;
  const cur = mcAt(mc, hourKey(now)), tier = cur.mc == null ? TIERS[0] : tierOfMc(cur.mc);
  const week = accrue(hours, mc, monday, Infinity), pot = accrue(hours, mc, led.stakerFrom || 0, Infinity), burnPot = accrue(hours, mc, led.burnFrom || 0, Infinity);
  const payOn = c.live && c.deployedAt ? Math.max(nextMonday(now), payFrom(c.deployedAt)) + HOUR : null;
  const supplyRaw = await supplyNow().catch(() => 0n);
  const stakedRaw = c.live ? await c.st.totalStakedRaw().catch(() => 0n) : 0n;
  const targetRaw = targetOf(supplyRaw), frac = targetRaw > 0n ? Number(stakedRaw >= targetRaw ? 1_000_000n : (stakedRaw * 1_000_000n) / targetRaw) / 1_000_000 : 0;
  const paidNow = (wei) => r6(ethOf(paidOf(wei, stakedRaw, supplyRaw)));
  // cross-check with flywheel.mjs: its running total of credits minus the owner's creditedWeiAtStart, up to its own cursor
  const fw = await store.readJson("flywheel.json", {});
  const weeks = Object.values(led.weeks || {}).sort((a, b) => b.start - a.start).slice(0, 8).map((w) => ({
    season: w.season, start: w.start, end: w.end, mode: w.mode, credits: w.week?.credits, creditedEth: w.week?.creditedEth, byTier: w.week?.byTier,
    stakers: pick(w.stakers), burn: pick(w.burn) }));
  const v = {
    name: "$TROYA fee split", mode: modeOf(), wording: WORDING, noStakers: NO_STAKERS, rule: RULE,
    tiers: TIERS.map((t) => ({ key: t.key, name: t.name, minMcUsd: t.minMc, stakersPctOfVolume: t.stakerBps / 100, burnPctOfVolume: t.burnBps / 100, stakersShareOfCreatorFees: t.stakerBps / CREATOR_BPS, burnShareOfCreatorFees: t.burnBps / CREATOR_BPS })),
    start: { block: st.startBlock, from: st.from },
    now: { hour: hourKey(now), mcUsd: cur.mc, mcHour: cur.hour, sampledThisHour: !!mc[hourKey(now)]?.median, readsThisHour: mc[hourKey(now)]?.n || 0, tier: { key: tier.key, name: tier.name, stakersPctOfVolume: tier.stakerBps / 100, burnPctOfVolume: tier.burnBps / 100 } },
    week: { start: monday, ...sumView(week), stakersReceiveEth: paidNow(week.stakerWei) },
    rate: { rule: RATE_RULE(), targetPct: targetPct(), targetTokens: Math.round(ethOf(targetRaw)), stakedTokens: Math.round(ethOf(stakedRaw)), supplyTokens: Math.round(ethOf(supplyRaw)),
      paidPct: +(frac * 100).toFixed(2), line: `${compactNum(ethOf(stakedRaw))} of ${compactNum(ethOf(targetRaw))} staked (${(frac * 100).toFixed(2)}%) → stakers receive ${(frac * 100).toFixed(2)}% of this week's share.` },
    pot: { stakerEth: r6(ethOf(pot.stakerWei)), receiveEthAtTodaysStake: paidNow(pot.stakerWei), sinceMs: led.stakerFrom || null, burnEth: r6(ethOf(burnPot.burnWei)), payOn, contractLive: !!c.live,
      payNote: !c.live ? "Paid on the second Monday after the stake contract goes live, if anyone is staked then." : `Paid on ${new Date(payOn).toISOString().slice(0, 10)}, if anyone is staked then.` },
    lastWeek: weeks[0] || null, weeks,
    credits: { cursor: cr.cursor ?? null, readUpTo: cr.cursorTime || null, scannedAt: cr.scannedAt || null, last: (cr.last || []).slice(0, 10) },
    check: { creditedWeiAtStart: st.creditedWeiAtStart, flywheelCreditedEth: fw.credited ? ethOf(fw.credited) : null, flywheelSinceStartEth: fw.credited ? r6(ethOf(BigInt(fw.credited) - BigInt(st.creditedWeiAtStart || 0))) : null, flywheelScanned: fw.scanned ?? null, mineSinceStartEth: r6(ethOf(Object.values(hours).reduce((s, h) => s + BigInt(h.wei), 0n))), mineCursor: cr.cursor ?? null },
  };
  view = { at: Date.now(), v };
  return v;
}
const compactNum = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const pick = (p) => (p ? { accruedEth: p.accruedEth, status: p.status, sentEth: p.sentEth || 0, returnedEth: p.returnedEth || 0, reason: p.reason || null, paidPct: p.paidPct ?? null, hash: p.hash || null, buyHash: p.buyHash || null, burnHash: p.burnHash || null, troyaBurned: p.troyaBurned || null, payOn: p.payOn || null } : null);

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => { sampleMc().catch(() => {}); scanCredits().catch(() => {}); }, 75_000).unref?.();
  setInterval(() => sampleMc().catch(() => {}), 10 * 60_000).unref?.();
  setInterval(() => scanCredits().catch(() => {}), 5 * 60_000).unref?.();
  r.get("/api/feesplit", () => feeSplitView(), { weight: 1 });
}

export const _test = { setStore: (st) => { store = st; view = null; } };
