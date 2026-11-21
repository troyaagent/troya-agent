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
// (data/fee-credits.json). Only dailyRun() moves money. It runs once a day at 01:00 UTC (owner, 21 Nov 2026: daily, not
// weekly; the Herald payouts stay weekly on Monday in server/payouts.mjs) and settles the previous UTC day:
//   · stakers: their ETH goes to TroyaStake.notifyReward() (paid into the staking contract every day; claim any time), shared
//     by every coin staked at that moment, at one rate per staked coin: a run pays share × min(1, totalStaked / target), the
//     target being STAKE_FULL_TARGET_PCT (default 5) % of the current total supply; the unpaid part stays with the owner.
//     Coins waiting out the cooldown do not count (the contract's totalStaked).
//     The pot from startBlock to go-live, and the first 7 days after go-live, is paid with the first daily run at least 7
//     days after the contract went live, so early stakers get all of it on day 7; from then on every day.
//     If nobody is staked at a paying run, the amount is too small to send (under STAKE_MIN_SEND_ETH, default 0.00002 ETH),
//     or the run cannot send it (the gas reserve, a transaction that fails after retries), it stays with the owner: nothing
//     is carried to the next day.
//   · burn: the burn ETH buys $TROYA through the flywheel's buyback path (Troya Gate, the Universal Router only, 3% slippage
//     bound) and burn()s all of it (flywheel-auto.mjs buybackAndBurn). What cannot be bought back stays with the owner.
//   · the creator wallet keeps PAYOUT_RESERVE_ETH (0.003) for gas; stakers are paid before the burn when the wallet is short.
//   · a part is marked "sending" and its cursor moved before anything is broadcast, so a crash never pays twice.
//   · STAKE_REWARDS: "live" sends; "dry" (the default) works everything out and records it without sending and settles
//     nothing (a later live run pays everything since the last live run, under the same rules); "off" skips the daily run
//     (the market cap and the credits are still recorded: read-only).
//   · the admins' Telegram gets one digest a week (Monday) and a message when a run fails, never a message a day; and
//     nothing at all while no stake contract is configured and STAKE_REWARDS is not live.
// Herald payouts (referral rewards and Cup prizes) are untouched: paid from the owner's part, weekly, as before.
// 2x for stakers who trade through Troya (owner, 22 Nov 2026; server/stakebonus.mjs has the rule): a paying run takes the
// stakes at one block, weighs each active staker's coins 2 and the others 1, sends notifyReward(X = P × S / W) and books the
// active stakers' extra part as a bonus that the same run (and the next ones) sends straight to their wallets once it
// reaches STAKE_MIN_SEND_ETH. Bonuses booked and not sent yet are owed: they are kept out of the room for the next shares and
// the burn. Nobody active: X = P, the run is exactly the pro-rata run it was.
// Free gas paid by creator fees (owner, 22 Nov 2026): after the stakers, the 2x bonuses and the burn, every daily run sends
// that day's creator-fee credits × GAS_TOPUP_VOLUME_BPS / 260 (default 10 = 0.1% of $TROYA volume) from the creator wallet
// to the gas sponsor wallet (server/gas.mjs: the holders' weekly drip and the Agent Wallet gas refunds), whatever the sponsor
// already holds: no threshold, no target. Under STAKE_MIN_SEND_ETH, no room above the creator wallet's gas reserve and the 2x
// bonuses it owes, or no sponsor address: that day's amount stays with the owner, nothing carried. The admins can pull the
// sponsor's balance back with POST /api/gas/admin/withdraw (it sends only to the creator wallet). The same crash safety as the
// 2x bonuses: the transfer is signed, written down as "sending" with its hash and nonce, then broadcast; a run that stopped
// before it knew the outcome is settled from the chain by the next run (its receipt, or its nonce used by another
// transaction). A day's top-up is decided live once (data/fee-split.json gasTopups), so a re-run never sends it again.
//   · GAS_TOPUP: "live" sends (also while STAKE_REWARDS is dry: the day is then dry for the stakers and live for the top-up);
//     "dry" (the default) works it out and records it in the day; "off" records nothing sent. STAKE_REWARDS=off stops the
//     whole daily run, the top-up with it. The day record and /api/feesplit show it as gasTopup.
//   GET  /api/feesplit                 public: the rule, this hour's tier and market cap, today so far, the staker pot, past days
//   POST /api/feesplit/run {day, dry}  admin: run one day now (default: yesterday, dry)
import { Interface, getAddress, keccak256 } from "ethers";
import { rpc, CHAINS } from "./robinhood.mjs";
import { TROYA, CREATOR, ESCROW } from "./flywheel.mjs";
import { HttpError } from "./api.mjs";
import * as bonus from "./stakebonus.mjs";

const START_FILE = "fee-split-start.json", CREDITS_FILE = "fee-credits.json", MC_FILE = "mc-hourly.json", LEDGER = "fee-split.json";
// the owner's start (21 Nov 2026), used when data/fee-split-start.json is missing
export const DEFAULT_START = { startBlock: 119_990_898, creditedWeiAtStart: "1933781537705012708" };
export const CREATOR_BPS = 260;          // the creator wallet's 2.6% of volume, in basis points
export const TIERS = [
  { key: "base", name: "Under $35k", minMc: 0, stakerBps: 10, burnBps: 0 },
  { key: "mid", name: "$35k to $100k", minMc: 35_000, stakerBps: 50, burnBps: 0 },
  { key: "top", name: "$100k and up", minMc: 100_000, stakerBps: 100, burnBps: 10 },
];
export const RUN_HOUR_UTC = 1;           // the daily run: 01:00 UTC, for the UTC day that just ended
export const FIRST_PAY_DAYS = 7;         // the pot is paid with the first daily run at least 7 days after go-live
const T_CREDITED = "0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5";   // Credited(recipient, source, amount), as flywheel.mjs
const HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const MIN_BURN_WEI = 5n * 10n ** 14n;    // 0.0005 ETH, the flywheel's own smallest buyback
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const pad = (a) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const ethOf = (wei) => Number(BigInt(wei || 0)) / 1e18;
const r6 = (x) => +Number(x || 0).toFixed(6);
const weiOfEth = (x) => BigInt(Math.round(Number(x) * 1e9)) * 10n ** 9n;
export const modeOf = () => (["live", "dry", "off"].includes(process.env.STAKE_REWARDS) ? process.env.STAKE_REWARDS : "dry");
const reserveEth = () => { const v = Number(process.env.PAYOUT_RESERVE_ETH); return v >= 0 && isFinite(v) && process.env.PAYOUT_RESERVE_ETH ? v : 0.003; };
export const minSendEth = () => { const v = Number(process.env.STAKE_MIN_SEND_ETH); return process.env.STAKE_MIN_SEND_ETH && v >= 0 && isFinite(v) ? v : 0.00002; };
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
let store = null;

export const WORDING = "A share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield.";
export const PAID_DAILY = "Paid into the staking contract every day; claim any time.";
export const NO_STAKERS = "If nobody is staked when the daily share is paid, it stays with the team.";
export const targetPct = () => { const v = Number(process.env.STAKE_FULL_TARGET_PCT); return v > 0 && v <= 100 ? v : 5; };
export const RATE_RULE = () => `Each staked $TROYA earns the same rate. The full daily share is paid once ${targetPct()}% of supply is staked; until then the unpaid part stays with the team.`;
// the free-gas top-up's switch and size: GAS_TOPUP_VOLUME_BPS is basis points of volume (10 = 0.1%), at most 50 (0.5%) so
// a typo cannot send a large part of the creator fees; anything else falls back to 10
export const gasTopupMode = () => (["live", "dry", "off"].includes(process.env.GAS_TOPUP) ? process.env.GAS_TOPUP : "dry");
export const gasTopupBps = () => { const v = Number(process.env.GAS_TOPUP_VOLUME_BPS); return process.env.GAS_TOPUP_VOLUME_BPS && v >= 0 && v <= 50 && isFinite(v) ? v : 10; };
const pctOf = (bps) => `${+(bps / 100).toFixed(2)}%`;
/** The public sentence on where free gas comes from, true to the switch: "refills every day" only once GAS_TOPUP is live. */
export function gasTopupLine(mode = gasTopupMode(), bps = gasTopupBps()) {
  if (mode === "live") return `Free gas on Troya is paid for by $TROYA creator fees: ${pctOf(bps)} of all $TROYA trading volume refills the gas wallet every day.`;
  if (mode === "dry") return `Free gas on Troya will be refilled from $TROYA creator fees: ${pctOf(bps)} of all $TROYA trading volume will go to the gas wallet every day (not switched on yet).`;
  return null;
}
export const RULE = "The $TROYA creator wallet earns 2.6% of every $TROYA trade. Each fee is split by the $TROYA market cap in the hour it came in (the median of several reads that hour): under $35k stakers get 0.1% of trading volume, from $35k 0.5%, from $100k 1% and another 0.1% buys $TROYA back and burns it. Paid into the staking contract every day (01:00 UTC, for the day before) and shared by every coin staked at that moment; claim any time on the stake page. Each staked $TROYA earns the same rate: the full share is paid once 5% of the supply is staked, and with less staked only that fraction is paid (2.5% staked: half the share) while the rest stays with the team. Fees from before the contract is live, and from its first 7 days, are paid together on day 7 after it goes live. Anything a run cannot send (nobody staked, under 0.00002 ETH, the gas reserve) stays with the team; nothing is carried over.";

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
/** 00:00 UTC of the day `ms` falls in, and that day's key ("2026-11-21"). */
export const dayStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The first day boundary whose run pays the stakers: the first 00:00 UTC at least 7 days after go-live (its run is at 01:00). */
export function firstPayAt(deployedAt) {
  const t = deployedAt + FIRST_PAY_DAYS * DAY, d0 = dayStart(t);
  return d0 === t ? t : d0 + DAY;
}
/** When the daily run after `ms` happens (01:00 UTC today if not yet, else tomorrow). */
export function nextRunAt(ms) {
  const today = dayStart(ms) + RUN_HOUR_UTC * HOUR;
  return ms < today ? today : today + DAY;
}

/**
 * What one daily run (settling everything up to `end`, a 00:00 UTC) does with the stakers' and the burn ETH (wei, BigInt).
 * Stakers first, then the burn, both inside what the creator wallet holds above the reserve. Nothing is carried: a part not
 * sent is "return" (stays with the owner), except the stakers' part before their first paying run, which is "hold" (the pot;
 * settle false).
 */
export function decideRun({ end, stakerWei, burnWei, contractLive, deployedAt, totalStakedRaw, supplyRaw, targetPct: pct = targetPct(), balanceWei, reserveWei, minSendWei = weiOfEth(minSendEth()), owedWei = 0n }) {
  // the 2x bonuses booked and not sent yet (stakebonus.mjs) are owed to stakers: they are not room for anything else
  const keep = BigInt(reserveWei) + BigInt(owedWei || 0);
  let room = BigInt(balanceWei) > keep ? BigInt(balanceWei) - keep : 0n;
  const noRoom = `the creator wallet could not cover it above its gas reserve${BigInt(owedWei || 0) > 0n ? " and the 2x bonuses it still owes" : ""}`;
  const S = BigInt(stakerWei), B = BigInt(burnWei), MIN = BigInt(minSendWei);
  let stakers;
  if (!contractLive) stakers = { action: "hold", settle: false, reason: "The stake contract is not live yet: kept for the first daily run 7 days after it goes live." };
  else if (!(deployedAt > 0)) stakers = { action: "hold", settle: false, reason: "The stake contract's deploy time is unknown (deployBlock in data/stake.json): kept." };
  else if (end < firstPayAt(deployedAt)) stakers = { action: "hold", settle: false, payOn: firstPayAt(deployedAt) + RUN_HOUR_UTC * HOUR, reason: `Kept until the run of ${dayKey(firstPayAt(deployedAt))}, 7 days after the contract went live, so everyone has time to stake.` };
  else if (S === 0n) stakers = { action: "none", settle: true };
  else if (!(BigInt(totalStakedRaw || 0) > 0n)) stakers = { action: "return", settle: true, returnedWei: S, reason: "Returned to the owner: no stakers." };
  else {
    // one rate per staked coin: the full share only once the target (pct % of the supply) is staked
    const due = paidOf(S, totalStakedRaw, supplyRaw, pct);
    const target = targetOf(supplyRaw, pct), staked = BigInt(totalStakedRaw);
    const fractionPpm = target > 0n ? Number(staked >= target ? 1_000_000n : (staked * 1_000_000n) / target) : 0;
    const rate = fractionPpm < 1_000_000 ? `Paid at ${(fractionPpm / 10_000).toFixed(2)}%: ${(Number(staked) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} of the ${(Number(target) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $TROYA target (${pct}% of supply) is staked; the rest stays with the team.` : null;
    const send = due < room ? due : room;
    if (due < MIN) stakers = { action: "return", settle: true, returnedWei: S, fractionPpm, dueWei: due, tooSmall: true, reason: `Returned to the owner: too small to send (${r6(ethOf(due))} ETH, under ${r6(ethOf(MIN))} ETH)${rate ? `. ${rate.replace(/; the rest stays with the team\.$/, "")}` : ""}.` };
    else if (send < MIN) stakers = { action: "return", settle: true, returnedWei: S, fractionPpm, dueWei: due, reason: `Returned to the owner: ${noRoom}.` };
    else {
      stakers = { action: "send", settle: true, sendWei: send, returnedWei: S - send, fractionPpm, dueWei: due,
        ...(send < due ? { reason: `${rate ? `${rate.replace(/ the rest stays with the team\.$/, "")} ` : ""}Partly returned to the owner: the creator wallet keeps its gas reserve${BigInt(owedWei || 0) > 0n ? " and the 2x bonuses it still owes" : ""}.` } : rate ? { reason: rate } : {}) };
      room -= send;
    }
  }
  let burn;
  if (B === 0n) burn = { action: "none", settle: true };
  else {
    const send = B < room ? B : room;
    if (send < MIN_BURN_WEI) burn = { action: "return", settle: true, returnedWei: B, reason: B < MIN_BURN_WEI ? "Returned to the owner: below the 0.0005 ETH smallest buyback." : `Returned to the owner: ${noRoom}.` };
    else burn = { action: "send", settle: true, sendWei: send, returnedWei: B - send, ...(B > send ? { reason: "Partly returned to the owner: the creator wallet keeps its gas reserve." } : {}) };
  }
  return { stakers, burn };
}
/** The free-gas top-up due for a day's creator-fee credits: credits × bps / 260 (BigInt, rounded down; bps to 0.01). */
export const gasTopupWei = (creditedWei, bps = gasTopupBps()) => (BigInt(creditedWei || 0) * BigInt(Math.round(bps * 100))) / BigInt(CREATOR_BPS * 100);
/**
 * The free-gas top-up of one daily run (wei, BigInt): that day's credits × bps / 260 to the gas sponsor, whatever the sponsor
 * holds, inside what the creator wallet holds above its reserve and the 2x bonuses it owes. spentWei: what this run would
 * already have sent and the balance does not show (a dry run). What is not sent stays with the owner ("return"), never carried.
 */
export function decideGasTopup({ creditedWei, bps = gasTopupBps(), sponsor, balanceWei, reserveWei, owedWei = 0n, spentWei = 0n, minSendWei = weiOfEth(minSendEth()) }) {
  const due = gasTopupWei(creditedWei, bps), MIN = BigInt(minSendWei);
  if (due === 0n) return { action: "none", dueWei: 0n };
  if (due < MIN) return { action: "return", dueWei: due, returnedWei: due, tooSmall: true, reason: `Stays with the owner: too small to send (${r6(ethOf(due))} ETH, under ${r6(ethOf(MIN))} ETH).` };
  if (!sponsor) return { action: "return", dueWei: due, returnedWei: due, reason: "Stays with the owner: the gas sponsor wallet's address could not be read." };
  const owes = BigInt(owedWei || 0) > 0n ? " and the 2x bonuses it still owes" : "";
  const keep = BigInt(reserveWei) + BigInt(owedWei || 0) + BigInt(spentWei || 0);
  const room = BigInt(balanceWei) > keep ? BigInt(balanceWei) - keep : 0n;
  const send = due < room ? due : room;
  if (send < MIN) return { action: "return", dueWei: due, returnedWei: due, reason: `Stays with the owner: the creator wallet could not cover it above its gas reserve${owes}.` };
  return { action: "send", dueWei: due, sendWei: send, returnedWei: due - send, ...(send < due ? { reason: `Partly stays with the owner: the creator wallet keeps its gas reserve${owes}.` } : {}) };
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

/* ---------------- the daily run (01:00 UTC, the UTC day that just ended) ---------------- */
const LDEF = { stakerFrom: 0, burnFrom: 0, days: {}, digests: {}, failNotes: {}, gasTopups: {} };
let running = false;
/** true once day `key` is decided for this mode (a dry day is worked out again when the switch goes live) */
export async function dayDone(key) {
  const led = store ? await store.readJson(LEDGER, LDEF) : LDEF;
  const d = led.days?.[key];
  return !!d && (d.mode === "live" || modeOf() === "dry");
}

// deps: tests hand in a signer and a buyback (a local fork); the server always uses the creator wallet and the flywheel's path
export async function dailyRun({ day, start, end, reason = "schedule", dry = false, deps = {} } = {}) {
  const mode = modeOf();
  if (mode === "off") return { mode, note: "The daily fee split is off (STAKE_REWARDS=off)." };
  if (!store) throw new Error("not started");
  if (running) throw new HttpError(409, "A fee split run is already going.");
  running = true;
  try {
    end ??= start + DAY; day ??= dayKey(start);
    const cr = await store.readJson(CREDITS_FILE, {});
    const st0 = await startOf();
    if (cr.startBlock !== st0.startBlock || !(cr.cursorTime >= end)) return { mode, waiting: true, note: "The creator-fee credits are not read up to the end of that day yet; the next run tries again." };
    const led = await store.readJson(LEDGER, LDEF);
    const prev = led.days?.[day];
    if (prev?.mode === "live") return { mode, already: true, day: prev };
    const live = mode === "live" && !dry;
    const mc = (await store.readJson(MC_FILE, { hours: {} })).hours || {};
    const hours = cr.hours || {};
    const stakerFrom = led.stakerFrom || 0, burnFrom = led.burnFrom || 0;
    const S = accrue(hours, mc, stakerFrom, end), B = accrue(hours, mc, burnFrom, end), D1 = accrue(hours, mc, start, end);
    const c = deps.contract || await contractState();
    const totalStakedRaw = c.live ? await c.st.totalStakedRaw().catch(() => null) : 0n;
    if (c.live && totalStakedRaw == null) throw new Error("Couldn't read totalStaked from the stake contract.");
    const supplyRaw = deps.supplyRaw ?? await supplyNow();
    if (!(supplyRaw > 0n)) throw new Error("Couldn't read the $TROYA total supply.");
    const topLive = gasTopupMode() === "live" && !dry;      // the free-gas top-up has its own switch (GAS_TOPUP)
    const w = live || topLive ? deps.signer || await (await import("./flywheel-auto.mjs")).payoutSigner() : deps.signer || null;
    if (live && !w) throw new Error("The creator wallet key is not stored on the server, so nothing can be paid automatically.");
    const balanceWei = w ? await w.provider.getBalance(w.address) : BigInt(await rpc("robinhood", "eth_getBalance", [CREATOR, "latest"]));
    const reserveWei = weiOfEth(reserveEth());
    const owedWei = await bonus.owedWei();                   // 2x bonuses booked and not sent yet: owed, so not room
    const decide = (staked) => decideRun({ end, stakerWei: S.stakerWei, burnWei: B.burnWei, contractLive: c.live, deployedAt: c.deployedAt || 0, totalStakedRaw: staked || 0n, supplyRaw, targetPct: targetPct(), balanceWei, reserveWei, owedWei });
    let dec = decide(totalStakedRaw);
    // 2x for stakers who trade through Troya: the stakes at one block (the paid share follows that block's total), who is
    // active in the window that ends at this run's 01:00 UTC, then X for notifyReward and a bonus per active staker
    let split = null, snap = null, act = null;
    const asOf = end + RUN_HOUR_UTC * HOUR;
    if (dec.stakers.action === "send") {
      snap = await (deps.snapshot || bonus.stakeSnapshot)();
      if (snap.totalRaw !== BigInt(totalStakedRaw || 0)) dec = decide(snap.totalRaw);
      if (dec.stakers.action === "send") {
        act = await bonus.activeFor(snap.stakes.map((x) => x.address), { asOf });
        split = bonus.splitShare(dec.stakers.sendWei, snap.stakes.map((x) => ({ ...x, active: act.get(x.address)?.active === true })));
      }
    }
    const part = (d, acc, from) => ({ fromMs: from || null, accruedEth: r6(ethOf(acc)), action: d.action, sendEth: r6(ethOf(d.sendWei || 0n)), returnedEth: r6(ethOf(d.returnedWei || 0n)), reason: d.reason || null, payOn: d.payOn || null,
      ...(d.fractionPpm != null ? { paidPct: d.fractionPpm / 10_000 } : {}), ...(d.tooSmall ? { tooSmall: true } : {}),
      status: d.action === "send" ? (live ? "sending" : "dry") : d.action === "hold" ? "held" : d.action === "return" ? "returned" : "none" });
    const entry = { day, start, end, at: Date.now(), reason, mode: live ? "live" : "dry", balanceEth: r6(ethOf(balanceWei)), reserveEth: reserveEth(), minSendEth: minSendEth(),
      contract: c.contract || null, contractLive: c.live, totalStaked: c.live ? String(totalStakedRaw) : null, supply: String(supplyRaw), targetPct: targetPct(), stats: sumView(D1),
      stakers: part(dec.stakers, S.stakerWei, stakerFrom), burn: part(dec.burn, B.burnWei, burnFrom), owedBonusEth: r6(ethOf(owedWei)) };
    if (split) entry.stakers.split = bonus.splitRecord(split, { snapshot: snap, asOf, active: act });
    if (snap && !split) entry.stakers.snapshot = { block: snap.block, from: snap.from, totalStaked: String(snap.totalRaw) };
    const save = (cursors = {}, more = null) => store.update(LEDGER, LDEF, (x) => {
      x.days ||= {};
      if (x.days[day]?.mode !== "live" || x.days[day]?.at === entry.at) x.days[day] = entry;   // a live day is written once, by its own run
      Object.assign(x, cursors);
      if (more) more(x);
      const keep = Object.keys(x.days).sort().slice(-120);
      x.days = Object.fromEntries(keep.map((k) => [k, x.days[k]]));
      return x;
    });
    const runDay = dayKey(deps.now || Date.now());
    if (!live) {
      // dry: what the bonus payments of a live run would be (nothing is booked in dry, so only bonuses from live runs show)
      entry.bonusPay = bonusPayView(await bonus.payDue({ dry: true, runDay, reserveWei, minSendWei: weiOfEth(minSendEth()) }).catch(() => null));
      // the free-gas top-up: live (GAS_TOPUP=live) from the creator wallet's balance as it is now, since nothing above was
      // sent; dry inside what a live run would have left after the stakers, the bonuses and the burn
      const wouldSendWei = (dec.stakers.action === "send" ? dec.stakers.sendWei : 0n) + (dec.burn.action === "send" ? dec.burn.sendWei : 0n) +
        weiOfEth((entry.bonusPay?.skipped || []).reduce((s, x) => s + (Number(x.eth) || 0), 0));
      await gasTopupStep({ day, entry, w, topLive, creditedWei: D1.creditedWei, balanceWei, reserveWei, owedWei, readFresh: topLive, spentWei: topLive ? 0n : wouldSendWei, save, deps });
      await save(); return { mode: entry.mode, day: entry };
    }
    // live: each part is marked "sending" and its cursor moved BEFORE anything is broadcast, so a crash can never pay twice;
    // the day's 2x bonuses are written down as planned before notifyReward and booked on the wallets once it went through
    const cursors = { ...(dec.stakers.settle ? { stakerFrom: end } : {}), ...(dec.burn.settle ? { burnFrom: end } : {}) };
    await save(cursors);
    if (dec.stakers.action === "send") {
      if (split?.bonusWei > 0n) await bonus.planBonus(day, split, entry.at);
      await sendStakers(w, c.contract, split ? split.notifyWei : dec.stakers.sendWei, entry.stakers);
      if (split?.bonusWei > 0n) {
        const ok = entry.stakers.status === "sent" || entry.stakers.status === "unknown";
        await bonus.settleBonus(day, ok);
        entry.stakers.split.bonusStatus = ok ? "accrued" : "returned";
        if (ok) entry.stakers.bonusEth = entry.stakers.split.bonusEth;
      }
      await save();
    }
    // the 2x bonuses due (accrued ≥ STAKE_MIN_SEND_ETH, this run's or older ones): before the burn, inside the reserve
    entry.bonusPay = bonusPayView(await bonus.payDue({ signer: w, runDay, reserveWei, minSendWei: weiOfEth(minSendEth()) })
      .catch((e) => ({ at: Date.now(), error: String(e.shortMessage || e.message).slice(0, 200), sent: [], skipped: [] })));
    if (dec.burn.action === "send") await sendBurn(dec.burn.sendWei, entry.burn, day, deps.buybackAndBurn);
    // the free-gas top-up last, from what the creator wallet holds after all of the above (read back from the chain)
    await gasTopupStep({ day, entry, w, topLive, creditedWei: D1.creditedWei, balanceWei, reserveWei, owedWei, readFresh: true, spentWei: 0n, save, deps });
    await save();
    return { mode: entry.mode, day: entry };
  } finally { running = false; view = null; }
}
async function sendStakers(w, contract, value, rec) {
  const data = new Interface(["function notifyReward() payable"]).encodeFunctionData("notifyReward");
  rec.notifyEth = r6(ethOf(value));
  let last = null;
  for (let a = 1; a <= 3; a++) {
    rec.attempts = a;
    try { await w.provider.call({ from: w.address, to: contract, data, value }); }      // a revert (no stakers) costs nothing
    catch (e) { last = `notifyReward would revert: ${String(e.shortMessage || e.message).slice(0, 160)}`; break; }
    let tx;
    try { tx = await w.sendTransaction({ to: contract, data, value, chainId: 4663 }); }
    catch (e) { last = `Not sent: ${String(e.shortMessage || e.message).slice(0, 160)}`; if (a < 3) await new Promise((r) => setTimeout(r, 20_000)); continue; }
    rec.hash = tx.hash;
    try {
      const rc = await tx.wait(1, 180_000);
      if (rc?.status === 1) {
        rec.status = "sent"; rec.sentEth = r6(ethOf(value));           // X: with 2x bonuses booked, less than the share sendEth
        import("./seal.mjs").then((m) => m.seal("stake-share", contract, { eth: rec.sentEth, hash: tx.hash }, `Stakers' share: ${rec.sentEth} ETH sent to TroyaStake.notifyReward()`)).catch(() => {});
        return;
      }
      last = "The transaction reverted on chain."; break;
    } catch (e) { Object.assign(rec, { status: "unknown", failed: true, reason: `Sent, but the receipt could not be read (check ${tx.hash}): ${String(e.shortMessage || e.message).slice(0, 120)}` }); return; }
  }
  Object.assign(rec, { status: "returned", failed: true, returnedEth: r6(rec.returnedEth + rec.sendEth), sendEth: 0, reason: `Returned to the owner: ${last || "not sent"}` });
}
async function sendBurn(wei, rec, day, injected) {
  const fw = injected ? { buybackAndBurn: injected } : await import("./flywheel-auto.mjs");
  let last = null;
  for (let a = 1; a <= 2; a++) {
    rec.attempts = a;
    try {
      const r = await fw.buybackAndBurn(ethOf(wei), { id: `split-${day}` });
      Object.assign(rec, { status: "sent", sentEth: rec.sendEth, buyHash: r.buyHash, burnHash: r.burnHash, troyaBurned: r.burned });
      return;
    } catch (e) {
      last = String(e.shortMessage || e.message).slice(0, 200);
      if (e.bought) { Object.assign(rec, { status: "failed", failed: true, buyHash: e.buyHash || null, reason: `Bought back but not burned: ${last}. The $TROYA sits in the creator wallet; burn it from the flywheel page.` }); return; }
      if (a < 2) await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  Object.assign(rec, { status: "returned", failed: true, returnedEth: r6(rec.returnedEth + rec.sendEth), sendEth: 0, reason: `Returned to the owner: the buyback could not run (${last}).` });
}

/* ---------------- the free-gas top-up (owner, 22 Nov 2026): 0.1% of volume to the gas sponsor, every day ---------------- */
const GAS_CAP = 100_000n;                // a plain transfer to the sponsor (an ordinary wallet) needs 21k
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);
const OPEN_GAS = ["sending", "unknown"];
/**
 * One run's top-up: decided (decideGasTopup) and written in entry.gasTopup. Live (topLive: GAS_TOPUP=live, not a dry admin
 * run) it is also written to the ledger's gasTopups[day], once: a day already decided live is shown again, never re-sent.
 * readFresh: the creator wallet's balance and the bonuses it owes are read again now (after what this run sent).
 */
async function gasTopupStep({ day, entry, w, topLive, creditedWei, balanceWei, reserveWei, owedWei, readFresh, spentWei, save, deps }) {
  const mode = gasTopupMode(), bps = gasTopupBps();
  const rec = { mode: mode === "off" ? "off" : topLive ? "live" : "dry", volumeBps: bps, creditedEth: r6(ethOf(creditedWei)), dueEth: r6(ethOf(gasTopupWei(creditedWei, bps))), at: entry.at };
  try {
    if (mode === "off") { entry.gasTopup = { ...rec, status: "off", reason: "Off (GAS_TOPUP=off): that day's amount stays with the owner." }; return; }
    if (topLive && w) rec.recovered = await recoverGasTopups(w.provider, w.address).catch(() => 0);
    const done = (await store.readJson(LEDGER, LDEF)).gasTopups?.[day];
    if (done?.mode === "live") { entry.gasTopup = { ...done, again: true }; return; }
    let sponsor = null;
    try {
      const a = "sponsorAddress" in deps ? deps.sponsorAddress : await (await import("./gas.mjs")).sponsorAddress();
      sponsor = a ? getAddress(a) : null;
      if (sponsor && lc(sponsor) === lc(CREATOR)) sponsor = null;
    } catch { sponsor = null; }
    if (sponsor) {
      const sb = await (w ? w.provider.getBalance(sponsor) : rpc("robinhood", "eth_getBalance", [sponsor, "latest"])).then(BigInt).catch(() => null);
      Object.assign(rec, { sponsor, sponsorBalanceEth: sb == null ? null : r6(ethOf(sb)) });
    }
    if (topLive && !w) { entry.gasTopup = await finalGas(day, { ...rec, status: "returned", returnedEth: rec.dueEth, sendEth: 0, reason: "Stays with the owner: the creator wallet key is not stored on the server." }, save); return; }
    const bal = readFresh && w ? BigInt(await w.provider.getBalance(w.address)) : BigInt(balanceWei);
    const owed = readFresh ? await bonus.owedWei() : BigInt(owedWei || 0);
    const d = decideGasTopup({ creditedWei, bps, sponsor, balanceWei: bal, reserveWei, owedWei: owed, spentWei });
    Object.assign(rec, { action: d.action, sendEth: r6(ethOf(d.sendWei || 0n)), returnedEth: r6(ethOf(d.returnedWei || 0n)), reason: d.reason || null, ...(d.tooSmall ? { tooSmall: true } : {}),
      status: d.action === "send" ? (topLive ? "sending" : "dry") : d.action === "return" ? "returned" : "none" });
    entry.gasTopup = rec;
    if (!topLive) return;                                       // dry: recorded in the day only
    if (d.action !== "send") { entry.gasTopup = await finalGas(day, rec, save); return; }
    await sendGasTopup(w, sponsor, d.sendWei, rec, reserveWei, () => save({}, (x) => putGas(x, day, rec)));
  } catch (e) {
    // the stakers' and the burn's records stand; a top-up that could not be worked out stays with the owner
    const sent = OPEN_GAS.includes(rec.status) && rec.hash;
    entry.gasTopup = sent ? rec : { ...rec, status: "returned", failed: true, sendEth: 0, returnedEth: rec.dueEth, reason: `Stays with the owner: ${String(e.shortMessage || e.message).slice(0, 160)}` };
    if (topLive && !sent) await save({}, (x) => putGas(x, day, entry.gasTopup)).catch(() => {});
  }
}
function putGas(x, day, rec) {
  x.gasTopups ||= {};
  x.gasTopups[day] = { ...rec, day };
  const k = Object.keys(x.gasTopups).sort().slice(-120);
  x.gasTopups = Object.fromEntries(k.map((y) => [y, x.gasTopups[y]]));
}
async function finalGas(day, rec, save) { await save({}, (x) => putGas(x, day, rec)); return rec; }
// the receipt, polled (as stakebonus.mjs: a quiet chain or a fork may bring no new block event)
async function receiptOf(pr, hash, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const rc = await pr.getTransactionReceipt(hash).catch(() => null);
    if (rc) return rc;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
/** A plain ETH transfer to the sponsor: checked, signed, written as "sending" (hash, nonce) BEFORE the broadcast, then awaited. */
async function sendGasTopup(w, to, value, rec, reserveWei, persist) {
  const pr = w.provider;
  const back = async (reason, extra = {}) => { Object.assign(rec, { status: "returned", returnedEth: r6(rec.returnedEth + rec.sendEth), sendEth: 0, reason, ...extra }); await persist(); };
  let est = null;
  try { est = BigInt(await pr.estimateGas({ from: w.address, to, value })); } catch { est = null; }
  if (!est || est > GAS_CAP) return back(`Stays with the owner: ${!est ? "the gas sponsor did not accept a plain ETH transfer" : "a transfer to the gas sponsor needs too much gas"}.`, { failed: true });
  const fee = await pr.getFeeData().catch(() => ({}));
  if (BigInt(reserveWei) < est * BigInt(fee.maxFeePerGas || fee.gasPrice || 1_000_000_000n)) return back("Stays with the owner: gas is unusually high, more than the creator wallet's gas reserve.");
  let pop, signed, hash;
  try {
    // the nonce straight from the node (ethers caches an identical count for 250 ms: a transfer right after the burn would reuse it)
    const nonce = Number(BigInt(await pr.send("eth_getTransactionCount", [w.address, "pending"])));
    pop = await w.populateTransaction({ to, value, gasLimit: (est * 12n) / 10n, chainId: 4663, nonce });
    signed = await w.signTransaction(pop);
    hash = keccak256(signed);
  } catch (e) { return back(`Stays with the owner: not signed (${String(e.shortMessage || e.message).slice(0, 120)}).`, { failed: true }); }
  Object.assign(rec, { status: "sending", hash, nonce: Number(pop.nonce), sendingAt: Date.now() });
  await persist();                                              // written BEFORE the broadcast: a crash can never send it twice
  try { await pr.broadcastTransaction(signed); }
  catch (e) {
    const seen = await pr.getTransaction(hash).catch(() => null);
    if (!seen) return back(`Stays with the owner: not sent (${String(e.shortMessage || e.message).slice(0, 120)}).`, { failed: true });
  }
  const rc = await receiptOf(pr, hash, 120_000);
  if (!rc) Object.assign(rec, { status: "unknown", failed: true, reason: `Sent, but the receipt could not be read (check ${hash}); the next run settles it from the chain.` });
  else if (rc.status === 1) {
    Object.assign(rec, { status: "sent", sentEth: rec.sendEth, block: rc.blockNumber ?? null });
    import("./seal.mjs").then((m) => m.seal("gas-topup", to, { eth: rec.sentEth, hash }, `Free gas: ${rec.sentEth} ETH of creator fees sent to the gas sponsor`)).catch(() => {});
  } else return back("Stays with the owner: the transfer reverted on chain.", { failed: true });
  await persist();
}
/**
 * Top-ups left "sending" or "unknown" by a run that stopped before it knew the outcome, settled from the chain: the receipt
 * (sent, or reverted), or the creator wallet's nonce gone past theirs with no receipt (it can never land: stays with the
 * owner). Neither yet: left as it is for the next run. Never sends anything.
 */
async function recoverGasTopups(pr, from) {
  const led = await store.readJson(LEDGER, LDEF);
  const open = Object.entries(led.gasTopups || {}).filter(([, g]) => OPEN_GAS.includes(g.status) && g.hash && Date.now() - (g.sendingAt || g.at || 0) > 10 * 60_000);
  if (!open.length) return 0;
  const used = await pr.getTransactionCount(from, "latest").catch(() => null);
  let n = 0;
  for (const [day, g] of open) {
    const rc = await pr.getTransactionReceipt(g.hash).catch(() => null);
    const lost = { status: "returned", failed: true, returnedEth: r6((g.returnedEth || 0) + (g.sendEth || 0)), sendEth: 0 };
    const fix = rc ? (rc.status === 1 ? { status: "sent", sentEth: g.sendEth, block: rc.blockNumber ?? null, failed: false, reason: null } : { ...lost, reason: "Stays with the owner: the transfer reverted on chain." })
      : used != null && g.nonce != null && Number(used) > g.nonce ? { ...lost, reason: "Stays with the owner: the transfer never landed (its nonce was used by another transaction)." } : null;
    if (!fix) continue;
    await store.update(LEDGER, LDEF, (x) => {
      const q = x.gasTopups?.[day];
      if (!q || q.hash !== g.hash || !OPEN_GAS.includes(q.status)) return x;
      Object.assign(q, fix, { checkedAt: Date.now(), settledFromChain: true });
      if (q.failed === false) delete q.failed;
      if (x.days?.[day]?.gasTopup?.hash === g.hash) x.days[day].gasTopup = { ...q };
      return x;
    });
    n++;
  }
  return n;
}

/* ---------------- the admins' Telegram: a weekly digest and failures only ---------------- */
// silent while no stake contract is configured and the switch is not live (nothing can move then)
async function shouldTell() {
  if (modeOf() === "live") return true;
  const c = await contractState().catch(() => ({ live: false }));
  return !!c.contract;
}
const tell = (text) => import("./community.mjs").then((m) => m.notifyAdmins?.(text)).catch(() => {});
async function failNote(day, text) {
  if (!(await shouldTell())) return;
  let fresh = false;
  await store.update(LEDGER, LDEF, (x) => { x.failNotes ||= {}; if (!x.failNotes[day]) { x.failNotes[day] = Date.now(); fresh = true; } const k = Object.keys(x.failNotes).sort().slice(-60); x.failNotes = Object.fromEntries(k.map((y) => [y, x.failNotes[y]])); return x; });
  if (fresh) await tell(`<b>$TROYA fee split</b>: the run for ${day} did not go through.\n${text}`);
}
const partLine = (n, p) => `${n}: ${p.accruedEth} ETH, ${p.status}${p.sentEth ? ` ${p.sentEth} ETH` : ""}${p.returnedEth ? `, ${p.returnedEth} ETH to the owner` : ""}${p.reason ? ` (${p.reason})` : ""}${p.hash ? ` robinhoodchain.blockscout.com/tx/${p.hash}` : ""}${p.burnHash ? ` burn robinhoodchain.blockscout.com/tx/${p.burnHash}` : ""}`;
/** The digest of the 7 days before Monday `monday` (00:00 UTC), as text (exported for the tests). */
export function digestText(days, monday) {
  const list = days.filter((d) => d.start >= monday - WEEK && d.start < monday).sort((a, b) => a.start - b.start);
  const sum = (f) => r6(list.reduce((s, d) => s + (Number(f(d)) || 0), 0));
  const tiers = TIERS.map((t) => [t.name, list.reduce((s, d) => s + (d.stats?.byTier?.[t.key]?.hours || 0), 0)]).filter(([, h]) => h).map(([n, h]) => `${n} ${h} h`).join(", ");
  const dry = list.some((d) => d.mode === "dry");
  return `<b>$TROYA fee split, week to ${dayKey(monday - DAY)}</b>${dry ? " (dry run: nothing sent)" : ""}\n${list.length} daily run${list.length === 1 ? "" : "s"}. Creator fees credited: ${sum((d) => d.stats?.creditedEth)} ETH${tiers ? ` (${tiers})` : ""}.\n` +
    `Stakers: ${sum((d) => d.stakers?.sentEth)} ETH sent, ${sum((d) => d.stakers?.returnedEth)} ETH to the owner${list.some((d) => d.stakers?.status === "held") ? `, pot held: ${list.filter((d) => d.stakers?.status === "held").at(-1)?.stakers?.accruedEth} ETH` : ""}${dry ? `, would send ${sum((d) => d.stakers?.status === "dry" ? d.stakers.sendEth : 0)} ETH` : ""}.\n` +
    (sum((d) => d.stakers?.bonusEth) || sum((d) => d.bonusPay?.sentEth) || sum((d) => d.stakers?.split?.bonusEth) ? `2x for active traders: ${sum((d) => d.stakers?.bonusEth)} ETH booked as bonuses, ${sum((d) => d.bonusPay?.sentEth)} ETH of bonuses sent${dry ? `, would book ${sum((d) => (d.mode === "dry" ? d.stakers?.split?.bonusEth : 0))} ETH` : ""}.\n` : "") +
    `Burn: ${sum((d) => d.burn?.sentEth)} ETH bought back and burned, ${sum((d) => d.burn?.returnedEth)} ETH to the owner.` +
    (list.some((d) => d.gasTopup && d.gasTopup.mode !== "off") ? `\nFree gas: ${sum((d) => d.gasTopup?.sentEth)} ETH of creator fees sent to the gas sponsor, ${sum((d) => d.gasTopup?.returnedEth)} ETH stayed with the owner${list.some((d) => d.gasTopup?.status === "dry") ? `, would send ${sum((d) => (d.gasTopup?.status === "dry" ? d.gasTopup.sendEth : 0))} ETH (GAS_TOPUP dry)` : ""}.` : "") +
    (list.some((d) => d.stakers?.failed || d.burn?.failed || d.gasTopup?.failed) ? `\nProblems: ${list.filter((d) => d.stakers?.failed || d.burn?.failed || d.gasTopup?.failed).map((d) => d.day).join(", ")}.` : "");
}
async function weeklyDigest(monday) {
  if (!(await shouldTell())) return;
  const led = await store.readJson(LEDGER, LDEF);
  const k = dayKey(monday);
  if (led.digests?.[k]) return;
  const days = Object.values(led.days || {});
  if (!days.some((d) => d.start >= monday - WEEK && d.start < monday)) return;
  await store.update(LEDGER, LDEF, (x) => { x.digests ||= {}; x.digests[k] = Date.now(); const ks = Object.keys(x.digests).sort().slice(-20); x.digests = Object.fromEntries(ks.map((y) => [y, x.digests[y]])); return x; });
  await tell(digestText(days, monday));
}
let ticking = false;
async function dailyTick() {
  if (ticking || !store || modeOf() === "off") return;
  ticking = true;
  try {
    const now = Date.now(), today = dayStart(now);
    if (now < today + RUN_HOUR_UTC * HOUR) return;
    const day = dayKey(today - DAY);
    if (!(await dayDone(day))) {
      const out = await dailyRun({ day, start: today - DAY, end: today }).catch(async (e) => { console.warn("[feesplit] run:", e.message); await failNote(day, e.message); return null; });
      if (out?.waiting && now > today + 12 * HOUR) await failNote(day, out.note);
      const d = out?.day;
      if (d && (d.stakers?.failed || d.burn?.failed)) await failNote(day, [d.stakers?.failed ? partLine("Stakers", d.stakers) : "", d.burn?.failed ? partLine("Burn", d.burn) : ""].filter(Boolean).join("\n"));
      if (d?.gasTopup?.failed) await failNote(`${day}-gas`, `Free gas top-up: ${d.gasTopup.dueEth} ETH due, ${d.gasTopup.status}${d.gasTopup.reason ? ` (${d.gasTopup.reason})` : ""}${d.gasTopup.hash ? ` robinhoodchain.blockscout.com/tx/${d.gasTopup.hash}` : ""}`);
      const odd = (d?.bonusPay?.skipped || []).filter((x) => x.unknown || x.why === "reverted");
      if (d?.bonusPay?.error || odd.length) await failNote(`${day}-bonus`, `2x bonus payments: ${d.bonusPay.error || odd.map((x) => `${x.address} ${x.eth} ETH ${x.why}${x.hash ? ` robinhoodchain.blockscout.com/tx/${x.hash}` : ""}`).join("; ")}`);
    }
    if (new Date(now).getUTCDay() === 1) await weeklyDigest(today);
  } catch (e) { console.warn("[feesplit] tick:", e.message); }
  finally { ticking = false; }
}

/* ---------------- the view (stake page, /api/stake/stats, /api/feesplit) ---------------- */
let view = null;
export async function feeSplitView() {
  if (view && Date.now() - view.at < 60_000) return view.v;
  const [st, cr, mcf, led, c] = await Promise.all([startOf(), store.readJson(CREDITS_FILE, {}), store.readJson(MC_FILE, { hours: {} }), store.readJson(LEDGER, LDEF), contractState().catch(() => ({ live: false }))]);
  const mc = mcf.hours || {}, hours = cr.startBlock === st.startBlock ? cr.hours || {} : {};
  const now = Date.now(), today = dayStart(now);
  const cur = mcAt(mc, hourKey(now)), tier = cur.mc == null ? TIERS[0] : tierOfMc(cur.mc);
  const todayA = accrue(hours, mc, today, Infinity), pot = accrue(hours, mc, led.stakerFrom || 0, Infinity), burnPot = accrue(hours, mc, led.burnFrom || 0, Infinity);
  const payOn = c.live && c.deployedAt ? Math.max(nextRunAt(now), firstPayAt(c.deployedAt) + RUN_HOUR_UTC * HOUR) : null;
  const supplyRaw = await supplyNow().catch(() => 0n);
  const stakedRaw = c.live ? await c.st.totalStakedRaw().catch(() => 0n) : 0n;
  const targetRaw = targetOf(supplyRaw), frac = targetRaw > 0n ? Number(stakedRaw >= targetRaw ? 1_000_000n : (stakedRaw * 1_000_000n) / targetRaw) / 1_000_000 : 0;
  const paidNow = (wei) => r6(ethOf(paidOf(wei, stakedRaw, supplyRaw)));
  // cross-check with flywheel.mjs: its running total of credits minus the owner's creditedWeiAtStart, up to its own cursor
  const fw = await store.readJson("flywheel.json", {});
  const days = Object.values(led.days || {}).sort((a, b) => b.start - a.start).slice(0, 14).map((d) => ({
    day: d.day, start: d.start, end: d.end, mode: d.mode, credits: d.stats?.credits, creditedEth: d.stats?.creditedEth, byTier: d.stats?.byTier,
    stakers: pick(d.stakers), burn: pick(d.burn), bonusPay: d.bonusPay || null, gasTopup: pickGas(d.gasTopup) }));
  const gasDays = Object.values(led.gasTopups || {}).filter((g) => g.status === "sent");
  const firstPay = c.live && c.deployedAt ? firstPayAt(c.deployedAt) + RUN_HOUR_UTC * HOUR : null;
  const v = {
    name: "$TROYA fee split", mode: modeOf(), wording: WORDING, paid: PAID_DAILY, noStakers: NO_STAKERS, rule: RULE,
    active: { line: bonus.ACTIVE_LINE(), how: bonus.ACTIVE_HOW(), days: bonus.activeDays(), minUsd: bonus.activeMinUsd(), totals: await bonus.bonusTotals().catch(() => null) },
    tiers: TIERS.map((t) => ({ key: t.key, name: t.name, minMcUsd: t.minMc, stakersPctOfVolume: t.stakerBps / 100, burnPctOfVolume: t.burnBps / 100, stakersShareOfCreatorFees: t.stakerBps / CREATOR_BPS, burnShareOfCreatorFees: t.burnBps / CREATOR_BPS })),
    start: { block: st.startBlock, from: st.from },
    schedule: { every: "day", hourUtc: RUN_HOUR_UTC, nextRunAt: nextRunAt(now), firstPayAt: firstPay, minSendEth: minSendEth(), firstPayDays: FIRST_PAY_DAYS },
    now: { hour: hourKey(now), mcUsd: cur.mc, mcHour: cur.hour, sampledThisHour: !!mc[hourKey(now)]?.median, readsThisHour: mc[hourKey(now)]?.n || 0, tier: { key: tier.key, name: tier.name, stakersPctOfVolume: tier.stakerBps / 100, burnPctOfVolume: tier.burnBps / 100 } },
    today: { start: today, ...sumView(todayA), stakersReceiveEth: paidNow(todayA.stakerWei), gasTopupEth: r6(ethOf(gasTopupWei(todayA.creditedWei))) },
    // free gas paid by creator fees (owner, 22 Nov 2026): line = the public sentence, true to GAS_TOPUP
    gasTopup: { mode: gasTopupMode(), volumeBps: gasTopupBps(), pctOfVolume: gasTopupBps() / 100, shareOfCreatorFees: gasTopupBps() / CREATOR_BPS, line: gasTopupLine(), minSendEth: minSendEth(),
      rule: `Every day at 01:00 UTC, ${pctOf(gasTopupBps())} of the day's $TROYA trading volume (the creator-fee credits × ${gasTopupBps()}/${CREATOR_BPS}) goes from the creator wallet to the gas sponsor wallet, whatever it holds. Under ${minSendEth()} ETH, or with no room above the creator wallet's gas reserve, that day's amount stays with the team; nothing is carried over.`,
      sentEth: r6(gasDays.reduce((x, g) => x + (Number(g.sentEth) || 0), 0)), sentDays: gasDays.length, last: ((d) => (d ? { day: d.day, ...d.gasTopup } : null))(days.find((d) => d.gasTopup)) },
    rate: { rule: RATE_RULE(), targetPct: targetPct(), targetTokens: Math.round(ethOf(targetRaw)), stakedTokens: Math.round(ethOf(stakedRaw)), supplyTokens: Math.round(ethOf(supplyRaw)),
      paidPct: +(frac * 100).toFixed(2), line: `${compactNum(ethOf(stakedRaw))} of ${compactNum(ethOf(targetRaw))} staked (${(frac * 100).toFixed(2)}%) → stakers receive ${(frac * 100).toFixed(2)}% of today's share.` },
    pot: { stakerEth: r6(ethOf(pot.stakerWei)), receiveEthAtTodaysStake: paidNow(pot.stakerWei), sinceMs: led.stakerFrom || null, burnEth: r6(ethOf(burnPot.burnWei)), payOn, contractLive: !!c.live,
      payNote: !c.live ? "Paid with the first daily run 7 days after the stake contract goes live, if anyone is staked then." : `Paid on ${dayKey(payOn)} at 01:00 UTC, if anyone is staked then.` },
    lastDay: days[0] || null, days,
    credits: { cursor: cr.cursor ?? null, readUpTo: cr.cursorTime || null, scannedAt: cr.scannedAt || null, last: (cr.last || []).slice(0, 10) },
    check: { creditedWeiAtStart: st.creditedWeiAtStart, flywheelCreditedEth: fw.credited ? ethOf(fw.credited) : null, flywheelSinceStartEth: fw.credited ? r6(ethOf(BigInt(fw.credited) - BigInt(st.creditedWeiAtStart || 0))) : null, flywheelScanned: fw.scanned ?? null, mineSinceStartEth: r6(ethOf(Object.values(hours).reduce((s, h) => s + BigInt(h.wei), 0n))), mineCursor: cr.cursor ?? null },
  };
  view = { at: Date.now(), v };
  return v;
}
const compactNum = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
// a day's free-gas top-up, public: the sponsor as a short address
const pickGas = (g) => (g ? { mode: g.mode, status: g.status, creditedEth: g.creditedEth ?? null, volumeBps: g.volumeBps ?? null, dueEth: g.dueEth ?? 0, sendEth: g.sendEth || 0, sentEth: g.sentEth || 0, returnedEth: g.returnedEth || 0,
  reason: g.reason || null, tooSmall: !!g.tooSmall, failed: !!g.failed, hash: g.hash || null, sponsor: shortAddr(g.sponsor), sponsorBalanceEth: g.sponsorBalanceEth ?? null, ...(g.settledFromChain ? { settledFromChain: true } : {}) } : null);
const pick = (p) => (p ? { accruedEth: p.accruedEth, status: p.status, sentEth: p.sentEth || 0, sendEth: p.sendEth || 0, returnedEth: p.returnedEth || 0, reason: p.reason || null, paidPct: p.paidPct ?? null, tooSmall: !!p.tooSmall, hash: p.hash || null, buyHash: p.buyHash || null, burnHash: p.burnHash || null, troyaBurned: p.troyaBurned || null, payOn: p.payOn || null,
  ...(p.notifyEth != null ? { notifyEth: p.notifyEth } : {}), ...(p.split ? { split: bonus.splitPublic(p.split) } : {}) } : null);
// a run's 2x bonus payments, as recorded on its day (short addresses only)
function bonusPayView(b) {
  if (!b) return null;
  return { at: b.at, dry: !!b.dry, runDay: b.runDay || null, due: b.due ?? null, sentEth: b.sentEth || 0, error: b.error || null, recovered: b.recovered || 0,
    sent: (b.sent || []).slice(0, 100), skipped: (b.skipped || []).slice(0, 100) };
}

export async function register(r, ctx) {
  store = ctx.store;
  bonus.init(ctx.store);
  setTimeout(() => { sampleMc().catch(() => {}); scanCredits().catch(() => {}); }, 75_000).unref?.();
  setInterval(() => sampleMc().catch(() => {}), 10 * 60_000).unref?.();
  setInterval(() => scanCredits().catch(() => {}), 5 * 60_000).unref?.();
  setTimeout(() => dailyTick().catch(() => {}), 150_000).unref?.();
  setInterval(() => dailyTick().catch(() => {}), 10 * 60_000).unref?.();
  r.get("/api/feesplit", () => feeSplitView(), { weight: 1 });
  r.post("/api/feesplit/run", async ({ req, body }) => {
    const s = await import("./auth.mjs").then((m) => m.getSession(req)).catch(() => null);
    if (!s || !admins().includes(lc(s.address))) throw new HttpError(403, "Admins only.");
    const today = dayStart(Date.now());
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.day || "")) ? Date.parse(`${body.day}T00:00:00Z`) : today - DAY;
    if (!(start < today)) throw new HttpError(400, "Only a day that has ended can be run.");
    return dailyRun({ day: dayKey(start), start, end: start + DAY, reason: "admin", dry: body?.dry !== false });
  });
}

export const _test = { setStore: (st) => { store = st; view = null; bonus.init(st); }, dailyTick, recoverGasTopups, setSupply: (v) => { supplyMemo = { at: Date.now(), v: BigInt(v) }; } };
