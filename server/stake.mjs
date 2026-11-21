// $TROYA staking (contracts/src/TroyaStake.sol): a wallet's tier from what it has staked and for how long, read from the
// chain. Bronze, Silver and Gold each need a share of the $TROYA total supply (read on chain) AND a time staked. Both, and
// the perks, live in one operator file, data/stake.json, re-read every 30 s, so they change with no contract redeploy and
// no restart. The contract address lives there too ("contract"), or in STAKE_CONTRACT; until one is set, every answer says
// deployed:false and every wallet has no tier.
// Perks carry no money: earlier Sentry alerts, a larger assistant and Council quota, free Gate API calls, Arena Cup points,
// a badge. This module only reads: it sends no transaction, holds no key and moves no coin. The weekly ETH share to stakers
// (a share of $TROYA creator fees that grows with market cap, varies with volume, not a promised yield) is worked out and
// sent by server/feesplit.mjs (run from server/payouts.mjs); /api/stake/stats shows it.
// Owner decisions, 21 Nov 2026: staked $TROYA (staked + waiting) counts for the 1M holder status (holders.mjs); Sentry
// lead at most 30 s Gold, 15 s Silver, 5 s Bronze; perks stay off (perksLive false) until the contract is deployed.
//   GET /api/stake                 terms: contract, cooldown, the tiers in $TROYA and days, the perks of each tier
//   GET /api/stake/stats           the contract's totals, and stakers by tier (from the contract's own events)
//   GET /api/stake/:address        one wallet: staked, since, waiting, unlock time, reward ETH, tier, the next tier, perks
//                                  (?fresh=1 reads the chain again instead of the 60 s cache, e.g. right after a transaction)
import { readFileSync } from "node:fs";
import { getAddress, isAddress, Interface, id as keccakId } from "ethers";
import { rpc, CHAINS } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const CONFIG_FILE = "stake.json";        // operator config, under data/
const INDEX_FILE = "stake-index.json";   // the event index behind /api/stake/stats, under data/
export const LEAD_MAX_SEC = 30;          // owner, 21 Nov 2026: no tier gets a Sentry lead above 30 s
const DAY = 86_400_000;
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);

export const DEFAULTS = {
  contract: "",          // TroyaStake on Robinhood Chain, once deployed (STAKE_CONTRACT overrides)
  deployBlock: 0,        // the block it was deployed in: the event scan starts there
  token: "",             // the staked coin; empty = the $TROYA CA in public/config.js
  deployedAt: 0,         // ms, the deploy block's time (tools/deploy-stake.mjs writes it; else read from deployBlock)
  perksLive: false,      // the hooks are wired (Sentry, assistant, Council, Gate API, Arena Cup, chat, Treasury): true switches them on
  holdersCountStaked: true, // owner, 21 Nov 2026: holders.mjs adds staked + waiting $TROYA to the balance behind the 1M perks
  // a tier needs both: at least minPctOfSupply percent of the total supply staked, for at least minDays (weighted start)
  tiers: [
    { key: "bronze", name: "Bronze", minPctOfSupply: 0.01, minDays: 7 },
    { key: "silver", name: "Silver", minPctOfSupply: 0.1, minDays: 14 },
    { key: "gold", name: "Gold", minPctOfSupply: 0.5, minDays: 30 },
  ],
  // what each tier unlocks. No perk pays money. "none" is a wallet with no tier.
  //   sentryLeadSec    Sentry DMs this tier's linked Telegram this many seconds before the public channel post (at most 30)
  //   aiQuotaX         multiplier on the assistant's messages a day and the Council's calls a minute
  //   gateFreePerDay   free Gate API checks a day, on top of the wallet's own free checks
  //   arenaCupPoints   points shown on the weekly Arena Cup board (the prize order stays PnL %)
  //   badge            the badge shown next to the wallet
  perks: {
    none: { sentryLeadSec: 0, aiQuotaX: 1, gateFreePerDay: 0, arenaCupPoints: 0, badge: null },
    bronze: { sentryLeadSec: 5, aiQuotaX: 1.5, gateFreePerDay: 25, arenaCupPoints: 10, badge: "bronze" },
    silver: { sentryLeadSec: 15, aiQuotaX: 2, gateFreePerDay: 100, arenaCupPoints: 25, badge: "silver" },
    gold: { sentryLeadSec: 30, aiQuotaX: 3, gateFreePerDay: 400, arenaCupPoints: 60, badge: "gold" },
  },
};

export const STAKE_ABI = [
  "function token() view returns (address)",
  "function COOLDOWN() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalPending() view returns (uint256)",
  "function totalRewarded() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function accRewardPerToken() view returns (uint256)",
  "function stakeOf(address) view returns (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt, uint256 earnedEth)",
  "function stake(uint256)", "function requestUnstake(uint256)", "function cancelUnstake()", "function withdraw()", "function claim()",
  "function notifyReward() payable",
  "event Staked(address indexed account, uint256 amount, uint256 staked, uint64 since)",
  "event UnstakeRequested(address indexed account, uint256 amount, uint256 staked, uint256 pending, uint64 unlockAt)",
  "event UnstakeCancelled(address indexed account, uint256 amount, uint256 staked, uint64 since)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "event RewardNotified(address indexed from, uint256 amount, uint256 totalStaked, uint256 accRewardPerToken)",
  "event RewardClaimed(address indexed account, uint256 amount)",
];
const IFACE = new Interface(STAKE_ABI);
const ERC20 = new Interface(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);
const T = Object.fromEntries(["Staked", "UnstakeRequested", "UnstakeCancelled", "Withdrawn"].map((n) => [n, IFACE.getEvent(n).topicHash]));

let store = null;

/* ---------------- config ---------------- */

function troyaCa() {
  if (process.env.TROYA_CA) return process.env.TROYA_CA;
  try { return (readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1] || ""; } catch { return ""; }
}
let cfgMemo = null;
/** The operator config merged over DEFAULTS (re-read at most every 30 s). Bad values fall back to the defaults. */
export async function stakeConfig() {
  if (cfgMemo && Date.now() - cfgMemo.at < 30_000) return cfgMemo.v;
  const raw = (store ? await store.readJson(CONFIG_FILE, {}) : {}) || {};
  const contract = process.env.STAKE_CONTRACT || raw.contract || DEFAULTS.contract;
  const token = raw.token || troyaCa();
  const tiers = (Array.isArray(raw.tiers) && raw.tiers.length ? raw.tiers : DEFAULTS.tiers)
    .map((t) => ({ key: String(t.key || "").toLowerCase(), name: String(t.name || t.key || ""), minPctOfSupply: Number(t.minPctOfSupply), minDays: Number(t.minDays) }))
    .filter((t) => /^[a-z0-9_-]{1,24}$/.test(t.key) && t.key !== "none" && t.minPctOfSupply > 0 && t.minPctOfSupply <= 100 && t.minDays >= 0)
    .sort((a, b) => a.minPctOfSupply - b.minPctOfSupply || a.minDays - b.minDays);
  const perks = { ...DEFAULTS.perks };
  for (const [k, p] of Object.entries(raw.perks || {})) if (p && typeof p === "object") perks[k] = { ...(DEFAULTS.perks[k] || DEFAULTS.perks.none), ...p };
  const v = {
    contract: isAddress(contract) ? getAddress(contract) : "",
    deployBlock: Math.max(0, Math.floor(Number(process.env.STAKE_DEPLOY_BLOCK || raw.deployBlock || 0))),
    deployedAt: Math.max(0, Math.floor(Number(raw.deployedAt) || 0)),
    token: isAddress(token) ? getAddress(token) : "",
    tiers: tiers.length ? tiers : DEFAULTS.tiers,
    perks,
    perksLive: raw.perksLive === true,
    holdersCountStaked: raw.holdersCountStaked !== false && DEFAULTS.holdersCountStaked,
  };
  cfgMemo = { at: Date.now(), v };
  return v;
}
const perksOf = (cfg, key) => ({ ...DEFAULTS.perks.none, ...(cfg.perks[key || "none"] || cfg.perks.none) });

/* ---------------- chain reads ---------------- */

const call = async (to, iface, fn, args = []) => iface.decodeFunctionResult(fn, await rpc("robinhood", "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"]));

// the total supply of the staked coin (10 min), and its decimals (for good)
let supplyMemo = null;
async function supply(cfg) {
  if (supplyMemo && supplyMemo.token === cfg.token && Date.now() - supplyMemo.at < 10 * 60_000) return supplyMemo;
  try {
    const [[s], [d]] = await Promise.all([call(cfg.token, ERC20, "totalSupply"), supplyMemo?.token === cfg.token ? [supplyMemo.decimals] : call(cfg.token, ERC20, "decimals")]);
    supplyMemo = { token: cfg.token, at: Date.now(), raw: BigInt(s), decimals: Number(d) };
  } catch (e) {
    if (supplyMemo?.token === cfg.token) return supplyMemo;     // a failed read keeps the last good supply
    throw e;
  }
  return supplyMemo;
}

// the configured contract has to be a TroyaStake for the configured coin: checked once per address (10 min)
let checkMemo = null;
async function checked(cfg) {
  if (!cfg.contract || !cfg.token) return false;
  if (checkMemo?.contract === cfg.contract && Date.now() - checkMemo.at < 10 * 60_000) return checkMemo.ok;
  let ok = false, tok = null, cd = null;
  try {
    [[tok], [cd]] = await Promise.all([call(cfg.contract, IFACE, "token"), call(cfg.contract, IFACE, "COOLDOWN")]);
    ok = lc(tok) === lc(cfg.token) && Number(cd) === 3 * 86_400;
  } catch (e) {
    if (e.status) throw e;       // the chain could not be reached (HttpError 502): ask again next time, decide nothing
  }                              // a revert or an empty answer: no TroyaStake at that address
  if (!ok) console.warn(`[stake] ${cfg.contract} is not a TroyaStake for ${cfg.token} (token ${tok}, cooldown ${cd}): staking stays off`);
  checkMemo = { contract: cfg.contract, at: Date.now(), ok };
  return ok;
}

const memo = new Map();   // address → { at, v } raw stake, 60 s
async function readStake(cfg, address, fresh) {
  const k = lc(address), hit = memo.get(k);
  const age = hit ? Date.now() - hit.at : -1;   // a clock that moved back makes the entry stale, not fresh
  if (hit && hit.contract === cfg.contract && age >= 0 && age < (fresh ? 5_000 : 60_000)) return hit.v;
  const [amount, since, pending, unlockAt, earnedEth] = await call(cfg.contract, IFACE, "stakeOf", [k]);
  const v = { amount: BigInt(amount), since: Number(since), pending: BigInt(pending), unlockAt: Number(unlockAt), earnedWei: BigInt(earnedEth) };
  memo.set(k, { at: Date.now(), contract: cfg.contract, v });
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return v;
}

/* ---------------- tiers ---------------- */

// the minimum stake of a tier in base units: pct percent of the supply, exact in BigInt
const minRawOf = (tier, supplyRaw) => (supplyRaw * BigInt(Math.round(tier.minPctOfSupply * 1e6))) / 100_000_000n;
const toNum = (raw, decimals) => Number(raw) / 10 ** decimals;

function placeOf(cfg, sup, amountRaw, sinceSec, now = Date.now()) {
  const heldMs = sinceSec ? Math.max(0, now - sinceSec * 1000) : 0;
  let idx = -1;
  cfg.tiers.forEach((t, i) => { if (amountRaw >= minRawOf(t, sup.raw) && heldMs >= t.minDays * DAY) idx = i; });
  const tier = idx >= 0 ? cfg.tiers[idx] : null;
  const nt = cfg.tiers[idx + 1] || null;
  let next = null;
  if (nt) {
    const needRaw = minRawOf(nt, sup.raw), amountMet = amountRaw >= needRaw, timeMet = heldMs >= nt.minDays * DAY;
    next = {
      key: nt.key, name: nt.name, minPctOfSupply: nt.minPctOfSupply, minDays: nt.minDays,
      needTokens: toNum(needRaw, sup.decimals), moreTokens: amountMet ? 0 : toNum(needRaw - amountRaw, sup.decimals),
      amountProgress: needRaw > 0n ? Math.min(1, Number((amountRaw * 10_000n) / needRaw) / 10_000) : 1,
      timeProgress: nt.minDays > 0 ? Math.min(1, heldMs / (nt.minDays * DAY)) : 1,
      amountMet, timeMet,
      // with the amount there, the day the time requirement is met (a top-up moves the start, so this can move too)
      timeMetAt: amountRaw > 0n && sinceSec ? sinceSec * 1000 + nt.minDays * DAY : null,
    };
  }
  return { tier: tier ? { key: tier.key, name: tier.name } : null, next, stakedDays: heldMs / DAY };
}

/**
 * The stake tier of `address`, read from the TroyaStake contract (60 s cache; { fresh: true } re-reads after 5 s).
 * Never throws: a failed read answers { known: false, tier: null } with the no-tier perks, and is not cached.
 * Hooks read `(await tierOf(a)).perks`.
 */
export async function tierOf(address, { fresh = false } = {}) {
  const cfg = await stakeConfig();
  const base = { address: isAddress(String(address || "")) ? getAddress(address) : null, contract: cfg.contract || null, deployed: false, known: true, tier: null, next: null, perks: perksOf(cfg, null), perksLive: cfg.perksLive };
  if (!base.address) return { ...base, known: false };
  try {
    if (!(await checked(cfg))) return base;
    const [sup, st] = await Promise.all([supply(cfg), readStake(cfg, base.address, fresh)]);
    const place = placeOf(cfg, sup, st.amount, st.since);
    return {
      ...base, deployed: true,
      staked: toNum(st.amount, sup.decimals), stakedRaw: st.amount.toString(),
      since: st.since ? st.since * 1000 : null, stakedDays: place.stakedDays,
      pending: toNum(st.pending, sup.decimals), pendingRaw: st.pending.toString(),
      unlockAt: st.unlockAt ? st.unlockAt * 1000 : null, canWithdraw: st.pending > 0n && Date.now() >= st.unlockAt * 1000,
      earnedEth: Number(st.earnedWei) / 1e18, earnedWei: st.earnedWei.toString(),
      pctOfSupply: sup.raw > 0n ? Number((st.amount * 1_000_000n) / sup.raw) / 10_000 : 0,
      tier: place.tier, next: place.next, perks: perksOf(cfg, place.tier?.key),
    };
  } catch (e) {
    console.warn("[stake] read failed:", e.message);
    return { ...base, known: false };
  }
}

/** $TROYA a wallet has in the stake contract, staked and waiting to leave (tokens). holders.mjs can add it to the balance. */
export async function stakedTokens(address) {
  const t = await tierOf(address);
  return { staked: t.staked || 0, pending: t.pending || 0, known: t.known, deployed: t.deployed };
}

/** The perks of a tier key ("bronze" …) or of no tier. */
export async function tierPerks(key) { return perksOf(await stakeConfig(), key); }

/**
 * The perks that apply to `address` now: its tier's perks once perksLive is true in data/stake.json, the no-tier perks
 * before that or when the stake cannot be read. Never throws. This is what the perk hooks in other modules call.
 */
export async function activePerks(address) {
  const cfg = await stakeConfig();
  if (!cfg.perksLive) return perksOf(cfg, null);
  const t = await tierOf(address);
  return t.tier ? t.perks : perksOf(cfg, null);
}

/** Telegram chats of linked wallets whose tier has a Sentry lead (perksLive only), longest lead first:
 *  [{ chat, address, tier, leadSec }], leadSec at most LEAD_MAX_SEC. Sentry DMs these before it posts to the public channel.
 *  Only linked wallets the event index has seen staking are read from the chain (one stakeOf each, 60 s cache), so a post
 *  costs no read per linked wallet. Never throws: nothing is listed when the stake cannot be read. */
export async function stakerChats() {
  const cfg = await stakeConfig();
  if (!cfg.perksLive || !store) return [];
  if (!(await checked(cfg).catch(() => false))) return [];
  const [t, idx] = await Promise.all([store.readJson("telegram.json", { links: {} }), store.readJson(INDEX_FILE, {})]);
  const seen = idx.contract === cfg.contract ? idx.accounts || {} : null;
  const out = [];
  for (const [address, chat] of Object.entries(t.links || {})) {
    if (seen && !(BigInt(seen[lc(address)]?.staked || 0) > 0n)) continue;
    const s = await tierOf(address);
    const lead = Math.min(LEAD_MAX_SEC, Math.max(0, Number(s.perks?.sentryLeadSec) || 0));
    if (s.tier && lead > 0) out.push({ chat, address, tier: s.tier.key, leadSec: lead });
  }
  return out.sort((a, b) => b.leadSec - a.leadSec);
}

/** true when the configured contract is a TroyaStake for $TROYA (no chain read when none is configured). */
export async function stakeLive() { return checked(await stakeConfig()).catch(() => false); }

/** The stake badge of `address` ("bronze" …), or null: perksLive only, never throws. Chat and Treasury show it. */
export async function badgeOf(address) {
  const cfg = await stakeConfig();
  if (!cfg.perksLive || !cfg.contract) return null;
  const p = await activePerks(address).catch(() => null);
  return typeof p?.badge === "string" && /^[a-z0-9_-]{1,24}$/.test(p.badge) ? p.badge : null;
}

/** Arena Cup stake points for a list of owner wallets: Map(lowercase address → points), only wallets with points.
 *  Empty while perksLive is off or no contract is set. Display only: the Cup's prize order stays PnL %. */
export async function cupPointsFor(addresses) {
  const out = new Map();
  const cfg = await stakeConfig();
  if (!cfg.perksLive || !cfg.contract || !(await checked(cfg).catch(() => false))) return out;
  for (const a of [...new Set((addresses || []).map(lc))].filter((x) => isAddress(x)).slice(0, 80)) {
    const p = await activePerks(a).catch(() => null);
    const n = Math.max(0, Math.round(Number(p?.arenaCupPoints) || 0));
    if (n) out.set(a, n);
  }
  return out;
}

/** The contract's totalStaked in base units (BigInt), read now. Throws when it cannot be read. */
export async function totalStakedRaw() {
  const cfg = await stakeConfig();
  if (!(await checked(cfg))) throw new Error("No TroyaStake contract is configured.");
  const [t] = await call(cfg.contract, IFACE, "totalStaked");
  return BigInt(t);
}

/* ---------------- event index (stats) ---------------- */
// Every Staked / UnstakeRequested / UnstakeCancelled / Withdrawn event carries the account's new state, so the latest one per
// account is that account. Scanned forward from deployBlock, at most 270,000 blocks a pass, kept in data/stake-index.json.

let scanning = false;
export async function scanStake() { return scan(); }
async function scan() {
  if (scanning || !store) return;
  scanning = true;
  try {
    const cfg = await stakeConfig();
    if (!(await checked(cfg).catch(() => false))) return;
    let idx = await store.readJson(INDEX_FILE, {});
    if (idx.contract !== cfg.contract) idx = { contract: cfg.contract, cursor: cfg.deployBlock ? cfg.deployBlock - 1 : null, accounts: {} };
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    if (idx.cursor == null) idx.cursor = head - 1;     // no deploy block configured: from now on only
    const from = idx.cursor + 1;
    if (from > head) return;
    const to = Math.min(head, from + 269_999);
    const logs = await rpc("robinhood", "eth_getLogs", [{ address: cfg.contract, topics: [Object.values(T)], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 30_000, only: CHAINS.robinhood.wide });
    logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    for (const l of logs) {
      let ev;
      try { ev = IFACE.parseLog(l); } catch { continue; }
      const k = lc(ev.args.account);
      const a = (idx.accounts[k] ||= { staked: "0", since: 0, pending: "0", unlockAt: 0 });
      if (ev.name === "Staked" || ev.name === "UnstakeCancelled") {
        a.staked = ev.args.staked.toString(); a.since = Number(ev.args.since);
        if (ev.name === "UnstakeCancelled") { a.pending = "0"; a.unlockAt = 0; }
      } else if (ev.name === "UnstakeRequested") {
        a.staked = ev.args.staked.toString(); if (ev.args.staked === 0n) a.since = 0;
        a.pending = ev.args.pending.toString(); a.unlockAt = Number(ev.args.unlockAt);
      } else if (ev.name === "Withdrawn") { a.pending = "0"; a.unlockAt = 0; }
    }
    idx.cursor = to;
    idx.head = head;
    idx.scannedAt = Date.now();
    await store.writeJson(INDEX_FILE, idx);
  } catch (e) { console.warn("[stake] scan:", e.message); }
  finally { scanning = false; }
}

let statsMemo = null;
export async function stakeStats() {
  if (statsMemo && Date.now() - statsMemo.at < 60_000) return statsMemo.v;
  const cfg = await stakeConfig();
  if (!(await checked(cfg).catch(() => false))) return { deployed: false, contract: cfg.contract || null };
  const sup = await supply(cfg);
  const [[staked], [pending], [rewarded], [claimed]] = await Promise.all(["totalStaked", "totalPending", "totalRewarded", "totalClaimed"].map((f) => call(cfg.contract, IFACE, f)));
  const idx = store ? await store.readJson(INDEX_FILE, {}) : {};
  const byTier = Object.fromEntries([["none", 0], ...cfg.tiers.map((t) => [t.key, 0])]);
  let stakers = 0, waiting = 0, sum = 0n;
  if (idx.contract === cfg.contract) {
    for (const a of Object.values(idx.accounts || {})) {
      const amt = BigInt(a.staked || 0);
      if (BigInt(a.pending || 0) > 0n) waiting++;
      if (amt === 0n) continue;
      stakers++; sum += amt;
      byTier[placeOf(cfg, sup, amt, a.since).tier?.key || "none"]++;
    }
  }
  const v = {
    deployed: true, contract: cfg.contract, token: cfg.token,
    totalStaked: toNum(staked, sup.decimals), totalPending: toNum(pending, sup.decimals),
    pctOfSupplyStaked: sup.raw > 0n ? Number((BigInt(staked) * 1_000_000n) / sup.raw) / 10_000 : 0,
    supply: toNum(sup.raw, sup.decimals),
    rewards: { totalEth: Number(rewarded) / 1e18, claimedEth: Number(claimed) / 1e18, on: BigInt(rewarded) > 0n },
    share: await import("./feesplit.mjs").then((m) => m.feeSplitView()).catch(() => null),
    stakers, waiting, byTier,
    index: { cursor: idx.cursor ?? null, head: idx.head ?? null, scannedAt: idx.scannedAt ?? null, matchesChain: idx.contract === cfg.contract && sum === BigInt(staked) },
  };
  statsMemo = { at: Date.now(), v };
  return v;
}

/* ---------------- terms ---------------- */

export async function stakeTerms() {
  const cfg = await stakeConfig();
  const fs = await import("./feesplit.mjs").catch(() => null);
  const deployed = await checked(cfg).catch(() => false);
  const sup = cfg.token ? await supply(cfg).catch(() => null) : null;
  return {
    name: "Troya Stake", deployed, contract: cfg.contract || null, token: cfg.token || null, chainId: 4663, cooldownDays: 3,
    supply: sup ? toNum(sup.raw, sup.decimals) : null, decimals: sup?.decimals ?? 18,
    tiers: cfg.tiers.map((t) => ({ ...t, minTokens: sup ? toNum(minRawOf(t, sup.raw), sup.decimals) : null, minRaw: sup ? minRawOf(t, sup.raw).toString() : null, perks: perksOf(cfg, t.key) })),
    noTier: perksOf(cfg, null),
    perksLive: cfg.perksLive, holdersCountStaked: cfg.holdersCountStaked,
    rule: "A tier needs both: at least its share of the $TROYA total supply staked, and staked for at least its days. A top-up moves the start time forward in proportion to the coins added. Coins waiting out the 3-day cooldown count for nothing.",
    rewards: `${fs?.WORDING || ""} ${fs?.NO_STAKERS || ""}`.trim(),
    share: fs ? { mode: fs.modeOf(), wording: fs.WORDING, noStakers: fs.NO_STAKERS, rule: fs.RULE, rate: fs.RATE_RULE(), tiers: fs.TIERS.map((t) => ({ key: t.key, name: t.name, minMcUsd: t.minMc, stakersPctOfVolume: t.stakerBps / 100, burnPctOfVolume: t.burnBps / 100 })) } : null,
  };
}

/* ---------------- routes ---------------- */

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => scan().catch(() => {}), 50_000).unref();
  setInterval(() => scan().catch(() => {}), 2 * 60_000).unref();
  r.get("/api/stake", () => stakeTerms(), { weight: 1 });
  // before /api/stake/:address, which would otherwise take "stats" as an address
  r.get("/api/stake/stats", () => stakeStats(), { weight: 1 });
  r.get("/api/stake/:address", async ({ params, query }) => {
    if (!isAddress(params.address)) throw new HttpError(400, "That is not a wallet address.");
    const t = await tierOf(params.address, { fresh: query.fresh === "1" });
    if (!t.known) throw new HttpError(503, "Couldn't read the stake from Robinhood Chain right now. Try again in a minute.");
    return t;
  }, { weight: 1, perMin: 120 });
}

// tests only: forget the cached config, contract check and reads (data/stake.json is otherwise re-read every 30 s)
export const _test = { reset: () => { cfgMemo = null; checkMemo = null; memo.clear(); statsMemo = null; } };
