// $TROYA staking, 2x for stakers who trade through Troya (owner, 22 Nov 2026, from community feedback: "rewards should go to
// people who actually use the platform"; final: a 1-day window). A staker who made at least one trade through Troya in the
// STAKE_ACTIVE_DAYS (default 1 = the 24 hours, fractions allowed: 0.5 = 12 h) before a daily share (01:00 UTC) counts double
// in that share:
//     w_i = stake_i × (active_i ? 2 : 1),   W = Σ w_i,   S = Σ stake_i   (coins staked; coins waiting to leave never count)
//     staker i is owed P × w_i / W of the run's paid share P (P is worked out by feesplit.mjs as before: tiers, 5% target)
// TroyaStake can only split pro rata by stake, so a run sends notifyReward(X), X = P × S / W (every staker then gets
// P × s_i / W through the contract) and books a bonus b_i = P × s_i / W for each ACTIVE staker, paid by this module as a plain
// ETH transfer from the same creator wallet. Σ b_i + X = P exactly (the rounding dust goes to X, so the contract part).
// Bonuses accrue per wallet in data/stake-bonus.json and the daily run sends a wallet its accrued bonus once it reaches
// STAKE_MIN_SEND_ETH (default 0.00002), at most once a day; gas comes from the creator wallet's reserve (PAYOUT_RESERVE_ETH):
// when the wallet cannot send it and keep the reserve, nothing is sent and the bonus keeps accruing. A wallet that unstakes
// keeps what it accrued and gets it on a later run. A wallet that refuses ETH (a contract) is skipped and keeps it.
// Accrued bonuses are owed: feesplit.mjs keeps them out of the room it pays the next shares and the burn from.
// "Active" = the staking wallet, its Troya Agent Wallet, or (when the staking wallet is an Agent Wallet) its owner made an
// executed trade through Troya worth at least STAKE_ACTIVE_MIN_USD (default $5, against wash trading), or launched a coin
// through Troya, in the window. From the daily share for 30 Nov 2026 (ACTIVE_V2_FROM: the run at 01:00 UTC on 1 Dec, whose
// window opens 30 Nov 01:00 UTC; community review by Xivor, owner 25 Nov 2026) the minimum is STAKE_ACTIVE_MIN_USD_V2
// (default $20). activeMinUsd(asOf) picks it from the share's day, so a day already settled or running keeps its rule:
//   · Agent Wallet swaps, perps and closes, from any source but the Arena (the app, Telegram, X, Autopilot, playbooks,
//     Champions, Aegis): data/journal.jsonl entries the server wrote itself, status "executed", the swap's last transaction
//     confirmed, a perp filled. Entries the browser reports (POST /api/journal, source "reported by app") never count.
//   · Swap page trades on Robinhood Chain: POST /api/swap/sent { hash } (robinhood.mjs) checks on chain that the sender sent
//     exactly the calldata Troya built for it a moment ago, that it succeeded and is recent, and books it in
//     data/web-swaps.json with the value of the quote it was built from.
//   · launches through Troya (data/launches.json, team tests left out; a launch is verified on chain before it is recorded).
// Not counted (the server cannot verify them): Swap page trades on Base, Arbitrum and Solana, and Perps page orders sent
// from the browser's own Hyperliquid key. Team, admin, Arena and test wallets (as server/stats.mjs) and the creator wallet
// are never active (they keep 1x).
// STAKE_REWARDS: dry works the split out (X, the bonuses, per wallet) and records it on the feesplit day, accrues nothing and
// sends nothing; live accrues and sends; off: nothing runs. Herald payouts are not touched.
import { readFile } from "node:fs/promises";
import { getAddress, isAddress, Interface, keccak256 } from "ethers";
import { rpc } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const FILE = "stake-bonus.json", WEB_FILE = "web-swaps.json", INDEX_FILE = "stake-index.json";
const HOUR = 3_600_000, DAY = 86_400_000;
const HORIZON = 30 * DAY;                 // how far back "last trade" is looked up for the page
const SENT_MAX_AGE = 2 * HOUR;            // a Swap page trade is booked only when it is reported within 2 h of its block
const GAS_CAP = 100_000n;                 // a recipient whose plain transfer needs more gas than this is skipped (a contract)
const CREATOR = "0x57b09fe6dab0a7d3776e56e6388c773d6c4d09e4";
const TEST_WALLETS = ["0x12a05719851c8375342de65c9105329c81f57054"];   // the team's real-money test wallet (as stats.mjs)
const TRADE = /^agent-wallet\.(swap|perp|close)$/;
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + Number(n).toString(16);
const ethOf = (wei) => Number(BigInt(wei || 0)) / 1e18;
const r6 = (x) => +Number(x || 0).toFixed(6);
const short = (a) => (a ? `${lc(a).slice(0, 6)}…${lc(a).slice(-4)}` : "");
let store = null;

export const activeDays = () => { const v = Number(process.env.STAKE_ACTIVE_DAYS); return process.env.STAKE_ACTIVE_DAYS && v > 0 && v <= 30 && isFinite(v) ? v : 1; };
const envUsd = (k, def) => { const v = Number(process.env[k]); return process.env[k] && v >= 0 && isFinite(v) ? v : def; };
export const ACTIVE_V2_FROM = Date.parse("2026-11-30T00:00:00Z");   // the first share day at the $20 minimum (paid 1 Dec 01:00 UTC)
export const activeMinUsdOld = () => envUsd("STAKE_ACTIVE_MIN_USD", 5);
export const activeMinUsdNew = () => envUsd("STAKE_ACTIVE_MIN_USD_V2", 20);
/** The daily share a trade at `ms` counts toward is paid at 01:00 UTC (feesplit.mjs RUN_HOUR_UTC): today's if not yet, else tomorrow's. */
export const nextShareAt = (ms = Date.now()) => { const t = Math.floor(ms / DAY) * DAY + HOUR; return ms < t ? t : t + DAY; };
/** The UTC day (its 00:00) that the share paid at `asOf` (01:00 UTC) settles: the day before. */
export const shareDayOf = (asOf) => Math.floor((asOf - HOUR) / DAY) * DAY - DAY;
/** The $ floor of a qualifying trade for the share paid at `asOf` (default: the next share): $5 for days up to 29 Nov 2026, $20 from 30 Nov. */
export const activeMinUsd = (asOf = nextShareAt()) => (shareDayOf(asOf) >= ACTIVE_V2_FROM ? activeMinUsdNew() : activeMinUsdOld());
export const MIN_USD_RULE = () => `The qualifying trade is $${activeMinUsdOld()} or more for daily shares up to 29 Nov 2026 and $${activeMinUsdNew()} or more from 30 Nov 2026 (the share paid 1 Dec 01:00 UTC onward).`;
export const windowMs = (days = activeDays()) => Math.round(days * DAY);
/** "once a day", "once every 12 hours", "once every 3 days" */
export function freqText(days = activeDays()) {
  if (days === 1) return "once a day";
  if (days < 1 || !Number.isInteger(days)) { const h = Math.round(days * 24); return h === 1 ? "once an hour" : `once every ${h} hours`; }
  return `once every ${days} days`;
}
/** "the 24 hours", "the 12 hours", "the 3 days" before the daily share */
export const windowText = (days = activeDays()) => (days === 1 || days < 1 || !Number.isInteger(days) ? `${Math.round(days * 24)} hours` : `${days} days`);
export const ACTIVE_LINE = (days = activeDays()) => `Trade through Troya at least ${freqText(days)} to earn 2x.`;
export const ACTIVE_HOW = (days = activeDays(), minUsd = activeMinUsd()) =>
  `A staker who made a trade of $${minUsd} or more through Troya (the Swap page on Robinhood Chain, the Agent Wallet, trades in Telegram or on X, or a coin launched through Troya) in the ${windowText(days)} before the daily share counts double in it: each staked $TROYA weighs 2 instead of 1. The contract pays everyone the 1x part; the extra part is sent straight to the wallet in ETH from the creator wallet once it adds up to at least the smallest payment. Team and test wallets keep 1x. ${MIN_USD_RULE()}`;

/* ---------------- pure parts (tools/stakebonus-test.mjs feeds them fixtures) ---------------- */

/**
 * Splits a paid share `payWei` among `stakes` = [{ address, raw, active }] (raw: coins staked, base units).
 * → { P, S, A, W, notifyWei (X, to notifyReward), bonusWei (Σ b_i), bonuses: [{ address, wei }], wallets: [{ address, raw,
 *     active, weight, contractWei, bonusWei, totalWei }] }. Nobody active: X = P and no bonus (exactly the old pro-rata run).
 */
export function splitShare(payWei, stakes) {
  const P = BigInt(payWei || 0);
  const list = (stakes || []).map((s) => ({ address: lc(s.address), raw: BigInt(s.raw || 0), active: !!s.active })).filter((s) => s.raw > 0n);
  const S = list.reduce((x, s) => x + s.raw, 0n), A = list.reduce((x, s) => x + (s.active ? s.raw : 0n), 0n), W = S + A;
  const none = { P, S, A, W, notifyWei: P, bonusWei: 0n, bonuses: [] };
  if (P === 0n || S === 0n) return { ...none, wallets: list.map((s) => ({ ...s, weight: s.active ? 2 : 1, contractWei: S ? (P * s.raw) / S : 0n, bonusWei: 0n, totalWei: S ? (P * s.raw) / S : 0n })) };
  const bonuses = A === 0n ? [] : list.filter((s) => s.active).map((s) => ({ address: s.address, wei: (P * s.raw) / W }));
  const bonusWei = bonuses.reduce((x, b) => x + b.wei, 0n);
  const notifyWei = P - bonusWei;
  const bmap = new Map(bonuses.map((b) => [b.address, b.wei]));
  // what each wallet gets through the contract: X pro rata by stake (the contract's own maths, at the snapshot's stakes)
  const wallets = list.map((s) => {
    const contractWei = (notifyWei * s.raw) / S, b = bmap.get(s.address) || 0n;
    return { ...s, weight: s.active ? 2 : 1, contractWei, bonusWei: b, totalWei: contractWei + b };
  }).sort((a, b) => (b.totalWei > a.totalWei ? 1 : b.totalWei < a.totalWei ? -1 : 0));
  return { P, S, A, W, notifyWei, bonusWei, bonuses, wallets };
}
/** true when a trade at `lastTradeAt` counts for a share settled at `asOf` (the window ends at asOf, inclusive) */
export const countsAt = (lastTradeAt, asOf, win = windowMs()) => lastTradeAt != null && lastTradeAt <= asOf && lastTradeAt > asOf - win;
/** The wallets a run sends a bonus to: accrued ≥ min, not already sent today, not on hold. Largest first. */
export function dueOf(wallets, { minSendWei, runDay, now = Date.now(), max = 100 }) {
  return Object.entries(wallets || {}).map(([address, w]) => ({ address, wei: BigInt(w.accruedWei || 0), w }))
    .filter((x) => x.wei > 0n && x.wei >= BigInt(minSendWei) && x.w.lastSendDay !== runDay && !(x.w.holdUntil > now) && isAddress(x.address))
    .sort((a, b) => (b.wei > a.wei ? 1 : b.wei < a.wei ? -1 : 0)).slice(0, max);
}
/** The day record's split, for /api/feesplit (short addresses) and the ledger (full ones). */
export function splitRecord(sp, { snapshot, asOf, active } = {}) {
  if (!sp) return null;
  return {
    notifyEth: r6(ethOf(sp.notifyWei)), bonusEth: r6(ethOf(sp.bonusWei)), payEth: r6(ethOf(sp.P)),
    stakers: sp.wallets.length, activeStakers: sp.wallets.filter((w) => w.active).length,
    stakedTokens: Math.round(ethOf(sp.S)), activeTokens: Math.round(ethOf(sp.A)), weightTokens: Math.round(ethOf(sp.W)),
    activeDays: activeDays(), minUsd: asOf ? activeMinUsd(asOf) : activeMinUsd(), asOf: asOf || null, block: snapshot?.block ?? null,
    bonusStatus: sp.bonusWei > 0n ? "planned" : "none",
    wallets: sp.wallets.slice(0, 1000).map((w) => ({ address: w.address, tokens: r6(ethOf(w.raw)), active: w.active, weight: w.weight,
      lastTradeAt: active?.get(w.address)?.lastTradeAt ?? null, contractEth: r6(ethOf(w.contractWei)), bonusEth: r6(ethOf(w.bonusWei)), totalEth: r6(ethOf(w.totalWei)), bonusWei: w.bonusWei.toString() })),
  };
}
/** The public form of a day's split: short addresses, no wei strings. */
export const splitPublic = (s) => (s ? { ...s, wallets: (s.wallets || []).slice(0, 200).map((w) => ({ address: short(w.address), tokens: w.tokens, active: w.active, weight: w.weight, contractEth: w.contractEth, bonusEth: w.bonusEth, totalEth: w.totalEth })) } : null);

/* ---------------- who is excluded (as server/stats.mjs), the Agent Wallets ---------------- */

export const excluded = () => new Set([
  ...TEST_WALLETS, CREATOR,
  ...String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(","),
  ...String(process.env.STATS_EXCLUDE || "").split(","),
  process.env.ARENA_LIVE_OWNER || "",
].map((a) => lc(a).trim()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));

async function agentMap() {
  const aw = await store.readJson("agentwallets.json", {});
  const all = aw.wallets && typeof aw.wallets === "object" ? aw.wallets : aw;
  const walletOf = new Map(), ownerOf = new Map();
  for (const [owner, r] of Object.entries(all || {})) {
    if (!/^0x[0-9a-f]{40}$/i.test(owner) || !r?.address || !isAddress(r.address)) continue;
    walletOf.set(lc(owner), lc(r.address)); ownerOf.set(lc(r.address), lc(owner));
  }
  return { walletOf, ownerOf };
}

/* ---------------- prices (for the $5 floor) ---------------- */

let px = { eth: null, ethAt: 0, tokens: new Map(), fixed: null };
async function ethUsd() {
  if (px.fixed) return px.fixed.eth ?? null;
  if (px.eth && Date.now() - px.ethAt < 60_000) return px.eth;
  try { const v = Number(await (await import("./market.mjs")).getEthUsd()); if (v > 0) px = { ...px, eth: v, ethAt: Date.now() }; } catch { /* keep the last */ }
  return px.eth;
}
async function tokenUsd(token) {
  const k = lc(token);
  if (px.fixed) return px.fixed.tokens?.[k] ?? null;
  const hit = px.tokens.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  let v = null;
  try {
    const m = await import("./market.mjs");
    v = Number(m.indexRow?.(k)?.priceUsd) || null;
    if (!v) v = Number((await Promise.race([m.getRobinhoodToken(k), new Promise((r) => setTimeout(() => r(null), 5000))]))?.token?.priceUsd) || null;
  } catch { v = null; }
  px.tokens.set(k, { at: Date.now(), v });
  if (px.tokens.size > 2000) px.tokens.delete(px.tokens.keys().next().value);
  return v;
}

/* ---------------- trades through Troya ---------------- */

const native = (t) => !t || t === "native" || /^eth$/i.test(String(t));
/** What a journal entry is worth: { usd } | { eth } | { token, amount } | null (not a counted trade). Exported for the tests. */
export function journalTrade(e) {
  if (!e || !TRADE.test(String(e.kind || "")) || e.status !== "executed") return null;
  const src = String(e.source || "");
  if (src === "arena" || src === "reported by app" || /^reported/.test(src)) return null;   // the Arena, and anything the browser reported
  const p = e.data?.params || {}, res = e.data?.result || {};
  if (e.kind === "agent-wallet.swap") {
    const steps = Array.isArray(res.steps) ? res.steps : res.hash ? [res] : [];
    const last = steps[steps.length - 1];
    if (!last || last.broadcast === false || last.status !== "confirmed") return null;      // reverted or never seen on chain
    const amt = Number(p.amountIn);
    if (!(amt > 0)) return null;
    return native(p.tokenIn) ? { eth: amt } : { token: p.tokenIn, amount: amt };
  }
  // perps and closes: a filled Hyperliquid order (a resting or refused one is not a trade)
  const st = Array.isArray(res.response) ? res.response : [];
  const f = st.find((s) => s && typeof s === "object" && s.filled)?.filled;
  if (f && Number(f.totalSz) > 0 && Number(f.avgPx) > 0) return { usd: Number(f.totalSz) * Number(f.avgPx) };
  return null;
}
async function usdOf(ev) {
  if (ev.launch) return Infinity;                      // a launch through Troya counts whatever its size (verified on chain, rate limited)
  if (ev.usd != null) return ev.usd;
  if (ev.eth != null) { const e = await ethUsd(); return e ? ev.eth * e : null; }
  if (ev.token) { const p = await tokenUsd(ev.token); return p ? ev.amount * p : null; }
  return null;
}

let evMemo = null;
/** Every trade through Troya between asOf - horizon and asOf: [{ actor, t, kind, source, usd | eth | token+amount | launch }]. */
export async function loadEvents(asOf = Date.now(), horizon = HORIZON) {
  const from = asOf - horizon, out = [];
  let text = "";
  try { text = await readFile(store.path("journal.jsonl"), "utf8"); } catch { /* none yet */ }
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"agent-wallet.') || !line.includes('"executed"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Number(e.t) || 0;
    if (t < from || t > asOf || !/^0x[0-9a-f]{40}$/.test(lc(e.address))) continue;
    const v = journalTrade(e);
    if (v) out.push({ actor: lc(e.address), t, kind: e.kind.replace(/^agent-wallet\./, ""), source: e.source || "app", ...v });
  }
  for (const l of await store.readJson("launches.json", [])) {
    const t = Number(l?.at) || 0;
    if (!l || l.teamTest || t < from || t > asOf) continue;
    for (const a of new Set([lc(l.owner), lc(l.wallet)])) if (/^0x[0-9a-f]{40}$/.test(a)) out.push({ actor: a, t, kind: "launch", source: l.source || "web", launch: true });
  }
  for (const s of (await store.readJson(WEB_FILE, { trades: [] })).trades || []) {
    const t = Number(s?.t) || 0;
    if (t < from || t > asOf || !/^0x[0-9a-f]{40}$/.test(lc(s.address))) continue;
    out.push({ actor: lc(s.address), t, kind: "swap", source: "web", usd: Number(s.usd) || 0, hash: s.hash });
  }
  return out.sort((a, b) => b.t - a.t);
}
async function eventsNow() {
  if (evMemo && Date.now() - evMemo.at < 60_000) return evMemo.v;
  const v = await loadEvents(Date.now(), HORIZON);
  evMemo = { at: Date.now(), v };
  return v;
}

/**
 * Is each of `addresses` active at `asOf`? → Map(lowercase address → { active, lastTradeAt, last, via, excluded }).
 * lastTradeAt is the newest trade of at least the $ floor (or a launch) by the wallet, its Agent Wallet or its owner, at or
 * before asOf (within 30 days); active when it is inside the window that ends at asOf.
 */
export async function activeFor(addresses, { asOf = Date.now(), win = windowMs(), events = null, minUsd = activeMinUsd(asOf) } = {}) {
  const ex = excluded(), am = await agentMap();
  const evs = (events || await loadEvents(asOf, Math.max(win, HORIZON))).filter((e) => e.t <= asOf);
  const by = new Map();
  for (const e of evs) { if (!by.has(e.actor)) by.set(e.actor, []); by.get(e.actor).push(e); }
  const out = new Map();
  for (const a of addresses || []) {
    const k = lc(a);
    const actors = [...new Set([k, am.walletOf.get(k), am.ownerOf.get(k)].filter(Boolean))];
    if (actors.some((x) => ex.has(x))) { out.set(k, { active: false, excluded: true, lastTradeAt: null, last: null, via: null }); continue; }
    const mine = actors.flatMap((x) => (by.get(x) || []).map((e) => ({ ...e, via: x === k ? "wallet" : x === am.walletOf.get(k) ? "agent-wallet" : "owner" }))).sort((x, y) => y.t - x.t);
    let hit = null;
    for (const e of mine) { const u = await usdOf(e); if (u != null && u >= minUsd) { hit = { ...e, usd: u === Infinity ? null : r6(u) }; break; } }
    out.set(k, { active: !!hit && countsAt(hit.t, asOf, win), excluded: false, lastTradeAt: hit?.t ?? null, via: hit?.via ?? null,
      last: hit ? { kind: hit.kind, source: hit.source, usd: hit.usd ?? null, launch: !!hit.launch } : null });
  }
  return out;
}

/* ---------------- the stakes at one block ---------------- */

/**
 * Every staker's stake at one block: { block, totalRaw, stakes: [{ address, raw }], from }. The event index (stake.mjs) is
 * brought up to date first; when its sum matches the contract's totalStaked at the index's own block, that is the snapshot;
 * otherwise every indexed account is read at the head and the sum checked again. Throws when they cannot be made to agree
 * (a staker the index has not seen yet): the run is tried again on the next tick.
 */
export async function stakeSnapshot() {
  const st = await import("./stake.mjs");
  const cfg = await st.stakeConfig();
  if (!(await st.stakeLive())) throw new Error("No live TroyaStake contract is configured.");
  const I = new Interface(st.STAKE_ABI);
  const call = async (fn, args, tag) => I.decodeFunctionResult(fn, await rpc("robinhood", "eth_call", [{ to: cfg.contract, data: I.encodeFunctionData(fn, args) }, tag]));
  await st.scanStake();
  const idx = await store.readJson(INDEX_FILE, {});
  if (idx.contract !== cfg.contract) throw new Error("The stake index is not built yet; the run tries again.");
  const accounts = Object.entries(idx.accounts || {});
  const fromIdx = accounts.map(([address, x]) => ({ address: lc(address), raw: BigInt(x.staked || 0) })).filter((s) => s.raw > 0n);
  const sumIdx = fromIdx.reduce((x, s) => x + s.raw, 0n);
  if (idx.cursor != null) {
    try {
      const [t] = await call("totalStaked", [], hex(idx.cursor));
      if (BigInt(t) === sumIdx) return { block: idx.cursor, totalRaw: sumIdx, stakes: fromIdx, from: "index" };
    } catch { /* the RPC may not serve that block: read every account at the head below */ }
  }
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const tag = hex(head);
  const [t] = await call("totalStaked", [], tag);
  const total = BigInt(t), stakes = [];
  const addrs = accounts.map(([a]) => lc(a));
  for (let i = 0; i < addrs.length; i += 8) {
    const part = await Promise.all(addrs.slice(i, i + 8).map((a) => call("stakeOf", [a], tag).then((r) => ({ address: a, raw: BigInt(r[0]) }))));
    for (const s of part) if (s.raw > 0n) stakes.push(s);
  }
  const sum = stakes.reduce((x, s) => x + s.raw, 0n);
  if (sum === total) return { block: head, totalRaw: total, stakes, from: "chain" };
  throw new Error(`The stake index is missing stakers (it finds ${ethOf(sum)} of the ${ethOf(total)} $TROYA staked); the run tries again.`);
}

/* ---------------- the bonus ledger (data/stake-bonus.json) ---------------- */

const LDEF = { wallets: {}, days: {}, sends: {} };
const W0 = () => ({ accruedWei: "0", earnedWei: "0", paidWei: "0", days: {}, payments: [] });
const trim = (o, n) => Object.fromEntries(Object.keys(o || {}).sort().slice(-n).map((k) => [k, o[k]]));

/** The bonuses booked and not sent yet (wei): the creator wallet owes them, so feesplit.mjs keeps them out of its room. */
export async function owedWei() {
  if (!store) return 0n;
  const led = await store.readJson(FILE, LDEF);
  return Object.values(led.wallets || {}).reduce((x, w) => x + BigInt(w.accruedWei || 0), 0n);
}
/** live, before notifyReward is broadcast: the day's bonuses are written down as "planned" (a crash leaves the trace). */
export async function planBonus(day, sp, at = Date.now()) {
  if (!sp || !(sp.bonusWei > 0n)) return;
  await store.update(FILE, LDEF, (x) => {
    x.days ||= {};
    if (x.days[day] && x.days[day].status !== "planned") return x;      // a day's bonuses are booked once
    x.days[day] = { status: "planned", at, totalWei: sp.bonusWei.toString(), wallets: Object.fromEntries(sp.bonuses.filter((b) => b.wei > 0n).map((b) => [b.address, b.wei.toString()])) };
    x.days = trim(x.days, 120);
    return x;
  });
}
/** live, after notifyReward: ok (sent, or sent with an unread receipt) books the planned bonuses on each wallet; otherwise
 *  the whole share went back to the owner, the bonuses with it. Idempotent. */
export async function settleBonus(day, ok) {
  let booked = 0n;
  await store.update(FILE, LDEF, (x) => {
    const d = x.days?.[day];
    if (!d || d.status !== "planned") return x;
    d.status = ok ? "accrued" : "returned"; d.settledAt = Date.now();
    if (ok) for (const [a, wei] of Object.entries(d.wallets || {})) {
      const w = (x.wallets[a] ||= W0());
      w.accruedWei = (BigInt(w.accruedWei || 0) + BigInt(wei)).toString();
      w.earnedWei = (BigInt(w.earnedWei || 0) + BigInt(wei)).toString();
      w.days = trim({ ...(w.days || {}), [day]: String(wei) }, 60);
      booked += BigInt(wei);
    }
    return x;
  });
  evMemo = null;
  return booked;
}

// a payment written as "sending" by a run that stopped before it knew the outcome: read back from the chain. It is put back
// on the wallet only when the chain shows it reverted, or its nonce was used by another transaction (so it can never land)
async function recover(provider, from) {
  const led = await store.readJson(FILE, LDEF);
  const open = [];
  for (const [a, w] of Object.entries(led.wallets || {})) for (const p of w.payments || []) if (p.status === "sending" && Date.now() - (p.at || 0) > 10 * 60_000) open.push([a, p]);
  if (!open.length) return 0;
  const used = await provider.getTransactionCount(from, "latest").catch(() => null);
  let n = 0;
  for (const [a, p] of open) {
    const rc = p.hash ? await provider.getTransactionReceipt(p.hash).catch(() => null) : null;
    const status = rc ? (rc.status === 1 ? "sent" : "reverted") : used != null && p.nonce != null && used > p.nonce ? "dropped" : null;
    if (!status) continue;
    await store.update(FILE, LDEF, (x) => {
      const w = x.wallets[a], q = w?.payments?.find((y) => y.id === p.id);
      if (!q || q.status !== "sending") return x;
      q.status = status; q.checkedAt = Date.now();
      if (status === "sent") w.paidWei = (BigInt(w.paidWei || 0) + BigInt(q.wei)).toString();
      else w.accruedWei = (BigInt(w.accruedWei || 0) + BigInt(q.wei)).toString();
      return x;
    });
    n++;
  }
  return n;
}

// the receipt, polled (waitForTransaction waits for a new block event, which a quiet chain or a fork may not bring)
async function receiptOf(pr, hash, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const rc = await pr.getTransactionReceipt(hash).catch(() => null);
    if (rc) return rc;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * The bonus payments of a daily run: every wallet whose accrued bonus reached minSendWei and was not sent today, largest
 * first, at most `max`. Each is checked (a plain transfer the wallet accepts, gas at most 100k), written as "sending" with its
 * signed hash and nonce, then broadcast and awaited. Stops when the creator wallet cannot pay one and keep its reserve.
 * dry: lists what would be sent, changes nothing. Returns { at, dry, runDay, sent: [...], skipped: [...], sentEth }.
 */
export async function payDue({ signer = null, runDay, reserveWei, minSendWei, dry = false, max = 100 } = {}) {
  const out = { at: Date.now(), dry, runDay, sent: [], skipped: [], sentEth: 0, minSendEth: r6(ethOf(minSendWei)) };
  if (!store) return out;
  if (!dry && signer) out.recovered = await recover(signer.provider, signer.address).catch(() => 0);
  const led = await store.readJson(FILE, LDEF);
  const due = dueOf(led.wallets, { minSendWei, runDay, max });
  out.due = due.length;
  if (dry || !signer) {
    for (const d of due) out.skipped.push({ address: short(d.address), eth: r6(ethOf(d.wei)), why: dry ? "dry run: not sent" : "no signer" });
    return out;
  }
  const pr = signer.provider;
  const mark = (a, f) => store.update(FILE, LDEF, (x) => { const w = (x.wallets[a] ||= W0()); f(w, x); return x; });
  // the nonce straight from the node, counted here: ethers caches an identical getTransactionCount for 250 ms, so a transfer
  // right after notifyReward would reuse its nonce (the same reason agentwallet.mjs counts its own)
  let nextNonce = 0;
  const nonceNow = async () => { nextNonce = Math.max(nextNonce, Number(BigInt(await pr.send("eth_getTransactionCount", [signer.address, "pending"])))); return nextNonce; };
  for (const [i, d] of due.entries()) {
    const a = getAddress(d.address), value = d.wei;
    let est = null;
    try { est = BigInt(await pr.estimateGas({ from: signer.address, to: a, value })); } catch { est = null; }
    if (!est || est > GAS_CAP) {
      const why = !est ? "This wallet did not accept a plain ETH transfer (a contract that refuses ETH?): kept, tried again tomorrow." : "A transfer to this wallet needs too much gas: kept, tried again tomorrow.";
      await mark(d.address, (w) => { w.lastSendDay = runDay; w.lastError = why; w.lastErrorAt = Date.now(); });
      out.skipped.push({ address: short(d.address), eth: r6(ethOf(value)), why });
      continue;
    }
    const fee = await pr.getFeeData().catch(() => ({}));
    const gasWei = est * BigInt(fee.maxFeePerGas || fee.gasPrice || 1_000_000_000n);
    const bal = BigInt(await pr.getBalance(signer.address));
    if (bal < value + BigInt(reserveWei) || BigInt(reserveWei) < gasWei) {
      // the reserve pays the gas; when it cannot, nothing more is sent this run and every bonus keeps accruing
      for (const r of due.slice(i)) out.skipped.push({ address: short(r.address), eth: r6(ethOf(r.wei)), why: "The creator wallet is short of its gas reserve: kept, sent on a later run." });
      break;
    }
    let pop, signed, hash;
    try {
      pop = await signer.populateTransaction({ to: a, value, gasLimit: (est * 12n) / 10n, chainId: 4663, nonce: await nonceNow() });
      signed = await signer.signTransaction(pop);
      hash = keccak256(signed);
    } catch (e) { out.skipped.push({ address: short(d.address), eth: r6(ethOf(value)), why: `Could not sign: ${String(e.shortMessage || e.message).slice(0, 120)}` }); continue; }
    const id = hash.slice(2, 14);
    // written BEFORE the broadcast: a crash from here on can never pay the same bonus twice
    let booked = false;
    await mark(d.address, (w) => {
      if (BigInt(w.accruedWei || 0) < value || w.lastSendDay === runDay) return;
      w.accruedWei = (BigInt(w.accruedWei || 0) - value).toString();
      w.lastSendDay = runDay;
      w.payments = [{ id, at: Date.now(), day: runDay, wei: value.toString(), eth: r6(ethOf(value)), hash, nonce: Number(pop.nonce), status: "sending" }, ...(w.payments || [])].slice(0, 40);
      booked = true;
    });
    if (!booked) continue;
    const settle = (status, extra = {}) => mark(d.address, (w) => {
      const p = (w.payments || []).find((y) => y.id === id);
      if (!p || p.status !== "sending") return;
      Object.assign(p, { status, ...extra });
      if (status === "sent") w.paidWei = (BigInt(w.paidWei || 0) + value).toString();
      if (status === "failed" || status === "reverted") { w.accruedWei = (BigInt(w.accruedWei || 0) + value).toString(); w.lastError = extra.reason || status; w.lastErrorAt = Date.now(); }
      if (status === "reverted") w.holdUntil = Date.now() + 7 * DAY;     // a wallet whose transfer reverts is left alone for a week
    });
    try { await pr.broadcastTransaction(signed); }
    catch (e) {
      const seen = await pr.getTransaction(hash).catch(() => null);
      if (!seen) { await settle("failed", { reason: `Not sent: ${String(e.shortMessage || e.message).slice(0, 120)}` }); out.skipped.push({ address: short(d.address), eth: r6(ethOf(value)), why: `not sent (${String(e.shortMessage || e.message).slice(0, 80)}): kept` }); continue; }
    }
    nextNonce = Number(pop.nonce) + 1;
    const rc = await receiptOf(pr, hash, 120_000);
    if (!rc) { await settle("unknown", { reason: `Sent, the receipt could not be read: check ${hash}` }); out.skipped.push({ address: short(d.address), eth: r6(ethOf(value)), why: "receipt not read", hash, unknown: true }); continue; }
    if (rc.status === 1) {
      await settle("sent", { block: rc.blockNumber });
      out.sent.push({ address: short(d.address), eth: r6(ethOf(value)), hash });
      out.sentEth = r6(out.sentEth + ethOf(value));
      import("./seal.mjs").then((m) => m.seal("stake-bonus", a, { eth: r6(ethOf(value)), hash }, `Stake 2x bonus: ${r6(ethOf(value))} ETH sent to ${short(a)}`)).catch(() => {});
    } else {
      await settle("reverted", { reason: "The transfer reverted on chain." });
      out.skipped.push({ address: short(d.address), eth: r6(ethOf(value)), why: "reverted", hash });
    }
  }
  await store.update(FILE, LDEF, (x) => { x.sends ||= {}; x.sends[runDay] = { at: out.at, sent: out.sent.length, sentEth: out.sentEth, skipped: out.skipped.length }; x.sends = trim(x.sends, 60); return x; });
  return out;
}

/* ---------------- Swap page trades (POST /api/swap/sent, robinhood.mjs) ---------------- */

/**
 * Books a Swap page trade on Robinhood Chain for the 2x. `built(from, to, data)` (robinhood.mjs) is the swap Troya built for
 * that wallet in the last 2 hours, with the value of its quote, or null. Anyone may report a hash: only its sender is booked,
 * and only when the sender sent exactly what Troya built for it. A signed-in wallet must be the sender.
 */
export async function recordWebSwap({ hash, session = null, built }) {
  if (!store) throw new HttpError(503, "Not ready yet. Try again in a minute.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new HttpError(400, "Send the transaction hash (0x + 64 hex).");
  const h = lc(hash);
  const prior = ((await store.readJson(WEB_FILE, { trades: [] })).trades || []).find((x) => x.hash === h);
  if (prior) return { ok: true, already: true, counted: prior.usd >= activeMinUsd(), usd: prior.usd, t: prior.t };
  const [tx, rc] = await Promise.all([rpc("robinhood", "eth_getTransactionByHash", [h]), rpc("robinhood", "eth_getTransactionReceipt", [h])]);
  if (!tx || !rc) throw new HttpError(404, "That transaction is not on Robinhood Chain yet. Try again in a few seconds.");
  if (session && lc(session) !== lc(tx.from)) throw new HttpError(403, "That transaction was sent by another wallet.");
  if (Number(BigInt(rc.status ?? 0)) !== 1) throw new HttpError(400, "That transaction reverted, so it is not a trade.");
  const b = built?.(tx.from, tx.to, tx.input || tx.data);
  if (!b) throw new HttpError(400, "That transaction is not a swap the Troya Swap page built for this wallet in the last 2 hours.");
  const blk = await rpc("robinhood", "eth_getBlockByNumber", [rc.blockNumber, false]);
  const t = blk?.timestamp ? Number(BigInt(blk.timestamp)) * 1000 : 0;
  if (!t || Date.now() - t > SENT_MAX_AGE || t < b.at - 60_000) throw new HttpError(400, "Only a swap sent in the last 2 hours, after Troya built it, is booked.");
  const usd = r6(Number(b.usd) || 0);
  const rec = { address: lc(tx.from), t, hash: h, usd, venue: b.venue || null, at: Date.now() };
  let dup = false;
  await store.update(WEB_FILE, { trades: [] }, (x) => {
    x.trades ||= [];
    if (x.trades.some((y) => y.hash === h)) { dup = true; return x; }
    x.trades.push(rec);
    const cut = Date.now() - 60 * DAY;
    x.trades = x.trades.filter((y) => y.t >= cut).slice(-20_000);
    return x;
  });
  evMemo = null;
  return { ok: true, already: dup, counted: usd >= activeMinUsd(), usd, t, minUsd: activeMinUsd() };
}

/* ---------------- one wallet, for /api/stake/:address and the stake page ---------------- */

export async function walletView(address) {
  if (!store || !isAddress(String(address || ""))) return null;
  const k = lc(address), now = Date.now(), win = windowMs();
  const fs = await import("./feesplit.mjs");
  const next = fs.nextRunAt(now);
  // the $ floor of the next share (activeMinUsd: $5 for days up to 29 Nov 2026, $20 from 30 Nov)
  const a = (await activeFor([k], { asOf: now, win: HORIZON, events: await eventsNow(), minUsd: activeMinUsd(next) })).get(k);
  const last = a?.lastTradeAt ?? null;
  // the 2x applies to the next daily share when the last trade is inside the window that ends at that share
  const active = !a?.excluded && countsAt(last, next, win);
  const led = await store.readJson(FILE, LDEF);
  const w = led.wallets?.[k] || W0();
  const pays = (w.payments || []).slice(0, 10).map((p) => ({ at: p.at, eth: p.eth, hash: p.hash || null, status: p.status }));
  // the newest daily share that lists this wallet (dry or live)
  const fled = await store.readJson("fee-split.json", { days: {} });
  let lastShare = null;
  for (const d of Object.values(fled.days || {}).sort((x, y) => y.start - x.start)) {
    const me = d.stakers?.split?.wallets?.find((x) => x.address === k);
    if (me) { lastShare = { day: d.day, mode: d.mode, active: me.active, weight: me.weight, contractEth: me.contractEth, bonusEth: me.bonusEth, totalEth: me.totalEth, status: d.stakers?.status || null, bonusStatus: d.stakers?.split?.bonusStatus || null }; break; }
  }
  return {
    active, weight: active ? 2 : 1, lastTradeAt: last, lastTrade: a?.last || null, via: a?.via || null, excluded: !!a?.excluded,
    activeUntil: last != null ? last + win : null, nextShareAt: next, startsCountingAt: next - win,
    activeRule: ACTIVE_LINE(), activeHow: ACTIVE_HOW(activeDays(), activeMinUsd(next)), activeDays: activeDays(), activeMinUsd: activeMinUsd(next),
    activeMinUsdOld: activeMinUsdOld(), activeMinUsdNew: activeMinUsdNew(), activeMinUsdFrom: ACTIVE_V2_FROM,
    bonusAccrued: r6(ethOf(w.accruedWei)), bonusAccruedWei: String(w.accruedWei || "0"), bonusEarned: r6(ethOf(w.earnedWei)),
    bonusPaid: r6(ethOf(w.paidWei)), bonusPaidWei: String(w.paidWei || "0"), bonusPayments: pays,
    bonusMinSendEth: fs.minSendEth(), bonusNote: w.lastError && now - (w.lastErrorAt || 0) < 7 * DAY ? w.lastError : null,
    lastShare,
  };
}

/** The public totals: what is owed and paid in 2x bonuses, for /api/feesplit. */
export async function bonusTotals() {
  if (!store) return null;
  const led = await store.readJson(FILE, LDEF);
  const ws = Object.values(led.wallets || {});
  const sum = (f) => r6(ethOf(ws.reduce((x, w) => x + BigInt(w[f] || 0), 0n)));
  return { owedEth: sum("accruedWei"), paidEth: sum("paidWei"), earnedEth: sum("earnedWei"), wallets: ws.filter((w) => BigInt(w.earnedWei || 0) > 0n).length, lastSend: Object.entries(led.sends || {}).sort().at(-1)?.[1] || null };
}

/** feesplit.mjs register() hands the store over (no routes of its own: POST /api/swap/sent is in robinhood.mjs). */
export function init(s) { store = s; }
export async function register(r, ctx) { store = ctx.store; }

// tests only
export const _test = {
  setStore: (s) => { store = s; evMemo = null; },
  setPrices: (p) => { px = { eth: null, ethAt: 0, tokens: new Map(), fixed: p ? { eth: p.eth ?? null, tokens: Object.fromEntries(Object.entries(p.tokens || {}).map(([k, v]) => [lc(k), v])) } : null }; },
  reset: () => { evMemo = null; },
};
