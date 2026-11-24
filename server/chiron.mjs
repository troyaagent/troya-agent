// V9 F48 Chiron: paste any trader wallet, no connecting needed, and Chiron reads its own trades on Robinhood Chain to find
// the one habit that costs it most. The centaur Chiron trained Achilles. It describes habits; it never says what to buy.
// What it reads (nothing new is measured; the readers are the ones Portfolio PnL uses):
//   history   Blockscout PRO (market.mjs's shared, rate-limited client): the wallet's token transfers, its transactions and
//             its internal transactions, CHIRON_PAGES pages of 50 each (default 12). Only the stretch all three lists cover
//             is used, so a sale is never read without the ETH that paid for it.
//   swaps     per transaction, the coin that moved and the wallet's own net ETH, WETH and USDG (tx value + internal
//             transfers, as portfolio.mjs tokenPnl reads it). One coin in and ETH out is a buy; one coin out and ETH in is a
//             sell. That reads the Pons curve, Uniswap v3 and v4 and routers alike, so no venue is missed; the venue is
//             named from where the coin came from or went (the coin's Pons curve, the v4 PoolManager, a v3 pool).
//             Transfers without ETH, coin-for-coin swaps and stock tokens are not trades and are counted apart. Gas is not
//             counted. USDG is turned into ETH at the ETH price Blockscout kept for that transaction.
//   launch    how long after a coin was born the wallet bought it, from the chain alone: whether the coin's code existed 5
//             minutes before the buy, and if not, its creation block by binary search (entryAges below). For a Pons coin
//             its creation is its launch; for any other coin it is its creation, said as such.
//   later     for "sold winners early" only: the coin's price 24 h after the sale (1 h when 24 h has not passed yet), read
//             from the chain at that block (the Pons curve's reserves, or its Uniswap v4 pool once graduated), ETH pairs only.
// A round trip opens on a buy while the wallet holds none of the coin and closes when 90% of what was bought has been sold.
// Habits, each compared inside the wallet's own closed round trips (cost-weighted returns: total result / total cost):
//   early      entries in a launch's first 60 s, or first 5 min, against its later entries
//   hold       median hold of losing round trips against winning ones; the cost compares the losers held past the winners'
//              median hold with the losers closed sooner
//   overtrade  round trips opened on its busiest days (at least max(4, twice its median buys a day)) against the other days
//   earlysell  winning round trips whose coin traded at 1.5x or more of the sale price 24 h later
// Cost = how much worse the habit's trades did than the comparison group, in ETH (the gap in return times what those trades
// cost). The habit with the largest cost is the one; nothing is picked by a model. Under MIN_TRIPS closed round trips it
// says so and picks nothing. Every number carries its sample size.
// Rules (POST /api/chiron/rule, signed in): "launch-wait" (no buys of a coin in its first N seconds) and "daily-buys" (at
// most N buys a day) are enforced on the server for every buy through policy.mjs checkAction, which the Agent Wallet runs
// for the owner's taps and for every automated job Scepter governs (Autopilot, Playbooks, Aegis, Champions), and which
// chat tickets show. Swaps signed in the owner's own wallet on Swap are not stopped. "note" rules (holding losers, selling
// winners) are reminders shown in Scepter: Troya cannot enforce them, and the button says so.
//   GET  /api/chiron/:address   { status: done|reading|few|none|busy, sample, top, sentence, habits, trips, ... } cached 30 min
//   GET  /api/chiron/rules      signed in: your rules and today's Agent Wallet buys
//   POST /api/chiron/rule       { kind: launch-wait|daily-buys|note, sec|n|text, habit?, from?, on? }   signed in
// Read-only towards the chain: nothing here signs, trades or moves money.
import { getAddress, isAddress, Interface } from "ethers";
import { HttpError } from "./api.mjs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const PAGES = Math.max(2, Math.min(40, Number(process.env.CHIRON_PAGES) || 12));
const DAILY_CALLS = Math.max(50, Number(process.env.CHIRON_BS_DAILY) || 3000);   // Blockscout calls a day for Chiron's reads
const WAIT_MS = Math.max(3000, Number(process.env.CHIRON_WAIT_MS) || 25_000);
const TTL_DONE = 30 * 60_000, TTL_SHORT = 2 * 60_000;
export const MIN_TRIPS = 5;
const CLOSE_AT = 0.9;            // a round trip closes when 90% of what was bought has been sold
const DUST_ETH = 0.0001;         // round trips that cost less are left out
const FILE = "chiron.json";
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const qs = (p) => (p ? "&" + new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString() : "");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const txUrl = (h) => `${EXPLORER}/tx/${h}`;
let store = null;

/* ---------- words and numbers ---------- */
export function fmtEth(x) {
  if (x == null || !isFinite(x)) return "–";
  const a = Math.abs(x);
  const d = a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return `${x < 0 ? "−" : ""}${a.toFixed(d).replace(/\.?0+$/, "") || "0"} ETH`;
}
export function fmtPct(r) {
  if (r == null || !isFinite(r)) return "–";
  const p = r * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`;
}
export function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = ms / 3600_000;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}
const cleanSym = (s) => String(s || "?").replace(/[^\p{L}\p{N}$._-]/gu, "").replace(/^\$+/, "").slice(0, 16) || "?";   // the pages print "$" before it

/* ---------- the math: pure, so tools/chiron-test.mjs can check it on made-up trips ---------- */
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
export const retOf = (xs) => { const c = sum(xs, (t) => t.cost); return c > 0 ? sum(xs, (t) => t.pnl) / c : null; };
export function median(xs) {
  const v = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const ev = (t, note, which = "entry") => ({ tx: which === "exit" ? t.exitTx : t.entryTx, url: txUrl(which === "exit" ? t.exitTx : t.entryTx), note });
const tripLine = (t) => `$${t.symbol}: ${fmtPct(t.ret)} (${fmtEth(t.pnl)})`;
const worst = (xs, n = 3) => [...xs].sort((a, b) => a.pnl - b.pnl).slice(0, n);
const WIN_TEXT = { 60: "60 seconds", 300: "5 minutes" };

/**
 * Turn the wallet's swaps, oldest first, into round trips.
 * events: [{ token, symbol, kind: buy|sell|in|out, amount, eth, at, block, tx, venue }]
 *   buy/sell: a swap against ETH (eth = what it cost / brought); in/out: coins that moved without ETH (not trades)
 * → { trips: closed round trips, open, unmatched (sales of coins bought before the history read), tainted (mixed with
 *     transfers, left out), dust }
 */
export function roundTrips(events) {
  const open = new Map(), trips = [];
  let unmatched = 0, tainted = 0, dust = 0;
  for (const e of events) {
    const k = e.token;
    let t = open.get(k);
    if (e.kind === "buy") {
      if (!t) { t = { token: k, symbol: e.symbol, bought: 0, sold: 0, got: 0, moved: 0, cost: 0, proceeds: 0, buys: 0, sells: 0, entryAt: e.at, entryBlock: e.block, entryTx: e.tx, venue: e.venue, mixed: false }; open.set(k, t); }
      t.bought += e.amount; t.cost += e.eth; t.buys++;
      continue;
    }
    if (!t) { if (e.kind === "sell") unmatched++; continue; }
    if (e.kind === "sell") {
      t.sold += e.amount; t.proceeds += e.eth; t.sells++;
      t.exitAt = e.at; t.exitBlock = e.block; t.exitTx = e.tx; t.exitVenue = e.venue;
    } else {                                       // coins sent or received without ETH while the position was open
      t.mixed = true;
      if (e.kind === "out") t.moved += e.amount; else t.got += e.amount;
    }
    // closed once 90% of what came in (bought, or received) has gone out (sold, or sent away)
    if (t.sold + t.moved >= (t.bought + t.got) * CLOSE_AT) {
      open.delete(k);
      if (t.mixed) { tainted++; continue; }
      if (t.cost < DUST_ETH) { dust++; continue; }
      t.pnl = t.proceeds - t.cost;
      t.ret = t.pnl / t.cost;
      t.holdMs = t.exitAt - t.entryAt;
      trips.push(t);
    }
  }
  return { trips, open: [...open.values()], unmatched, tainted, dust };
}

function earlyHabit(trips, W) {
  // entrySec: seconds after launch (exact up to 5 minutes); entryAfter: bought later than that many seconds after launch
  const known = trips.filter((t) => (t.entrySec != null && t.entrySec >= 0) || t.entryAfter);
  const E = known.filter((t) => t.entrySec != null && t.entrySec <= W && !(t.entryAfter >= W)), L = known.filter((t) => !E.includes(t));
  const base = { key: "early", window: W, title: `Buying in a launch's first ${WIN_TEXT[W]}`, sample: { early: E.length, later: L.length, unknownLaunch: trips.length - known.length } };
  if (E.length < 3 || L.length < 3) return { ...base, measured: false, present: false, why: `${E.length} round ${E.length === 1 ? "trip" : "trips"} entered within ${WIN_TEXT[W]} of launch and ${L.length} later: at least 3 of each are needed to compare` };
  const rE = retOf(E), rL = retOf(L), costE = sum(E, (t) => t.cost);
  const gap = (rL - rE) * costE;
  const present = gap > 0 && rE < rL - 0.05;
  const medAge = median(E.map((t) => t.entrySec));
  return {
    ...base, measured: true, present, costEth: present ? gap : 0, costPct: present ? rL - rE : 0,
    compare: [{ n: E.length, label: `entries in the first ${WIN_TEXT[W]}`, ret: rE }, { n: L.length, label: "later entries", ret: rL }],
    numbers: { earlyReturn: rE, laterReturn: rL, earlyResultEth: sum(E, (t) => t.pnl), laterResultEth: sum(L, (t) => t.pnl), earlyCostEth: costE, medianEntrySec: medAge },
    sentence: present ? `buying in a launch's first ${WIN_TEXT[W]}. Its ${E.length} entries that early returned ${fmtPct(rE)} against ${fmtPct(rL)} for its ${L.length} later entries, about ${fmtEth(gap)} less than at the later rate`
      : `entries in a launch's first ${WIN_TEXT[W]} (${E.length}) returned ${fmtPct(rE)}, later ones (${L.length}) ${fmtPct(rL)}: no cost found`,
    facts: [`${E.length} round trips entered within ${WIN_TEXT[W]} of launch (median ${medAge != null ? Math.round(medAge) : "?"} s after it): ${fmtPct(rE)}, ${fmtEth(sum(E, (t) => t.pnl))} in all`,
      `${L.length} round trips entered later: ${fmtPct(rL)}, ${fmtEth(sum(L, (t) => t.pnl))} in all`],
    evidence: worst(E).map((t) => ev(t, `Bought $${t.symbol} ${Math.round(t.entrySec)} s after launch; round trip ${tripLine(t)}`)),
    rule: { kind: "launch-wait", sec: W, label: `No buys in a coin's first ${WIN_TEXT[W]}`, enforced: true },
  };
}

function holdHabit(trips) {
  const W = trips.filter((t) => t.pnl > 0), Lo = trips.filter((t) => t.pnl < 0);
  const base = { key: "hold", title: "Holding losers far longer than winners", sample: { winners: W.length, losers: Lo.length } };
  if (W.length < 2 || Lo.length < 3) return { ...base, measured: false, present: false, why: `${plural(W.length, "winning round trip")} and ${plural(Lo.length, "losing one")}: at least 2 winners and 3 losers are needed` };
  const mW = median(W.map((t) => t.holdMs)), mL = median(Lo.map((t) => t.holdMs));
  const present = mL >= 2 * mW && mL - mW >= 10 * 60_000;
  const long = Lo.filter((t) => t.holdMs > mW), quick = Lo.filter((t) => t.holdMs <= mW);
  let cost = null, rLong = retOf(long), rQuick = retOf(quick);
  if (present && long.length >= 2 && quick.length >= 2 && rQuick > rLong) cost = (rQuick - rLong) * sum(long, (t) => t.cost);
  return {
    ...base, measured: true, present, costEth: present ? cost : 0, costPct: present && cost != null ? rQuick - rLong : 0, costMeasured: cost != null || !present,
    compare: long.length && quick.length ? [{ n: long.length, label: `losers held past ${fmtDur(mW)}`, ret: rLong }, { n: quick.length, label: "losers closed sooner", ret: rQuick }] : [{ n: Lo.length, label: "losers", hold: mL }, { n: W.length, label: "winners", hold: mW }],
    numbers: { medianHoldWinMs: mW, medianHoldLossMs: mL, longLosers: long.length, quickLosers: quick.length, longReturn: rLong, quickReturn: rQuick },
    sentence: present ? `holding losers far longer than winners: a median of ${fmtDur(mL)} for its ${Lo.length} losing round trips against ${fmtDur(mW)} for its ${W.length} winners${cost != null ? `. The losers held past ${fmtDur(mW)} returned ${fmtPct(rLong)} against ${fmtPct(rQuick)} for losers closed sooner, about ${fmtEth(cost)}` : ""}`
      : `losers were held a median of ${fmtDur(mL)}, winners ${fmtDur(mW)}: not far longer`,
    facts: [`Winning round trips (${W.length}): median hold ${fmtDur(mW)}`, `Losing round trips (${Lo.length}): median hold ${fmtDur(mL)}`,
      ...(long.length && quick.length ? [`Losers held past ${fmtDur(mW)} (${long.length}): ${fmtPct(rLong)}; losers closed sooner (${quick.length}): ${fmtPct(rQuick)}`] : []),
      ...(present && cost == null ? ["Its cost in ETH is not measured: too few losers on one side to compare (2 of each are needed)"] : [])],
    evidence: [...long].sort((a, b) => b.holdMs - a.holdMs).slice(0, 3).map((t) => ev(t, `$${t.symbol} held ${fmtDur(t.holdMs)}, closed at ${fmtPct(t.ret)} (${fmtEth(t.pnl)})`, "exit")),
    rule: { kind: "note", habit: "hold", label: `Reminder: look again at any losing position open past ${fmtDur(mW)}`, text: `Look again at any losing position that has been open longer than ${fmtDur(mW)}, my winners' median hold.`, enforced: false },
  };
}

function overtradeHabit(trips) {
  const byDay = new Map();
  for (const t of trips) { const d = day(t.entryAt); byDay.set(d, (byDay.get(d) || 0) + 1); }
  const counts = [...byDay.values()];
  const med = median(counts), T = Math.max(4, Math.ceil(2 * (med || 0)));
  const busyDays = [...byDay].filter(([, n]) => n >= T).map(([d]) => d);
  const busy = trips.filter((t) => busyDays.includes(day(t.entryAt))), quiet = trips.filter((t) => !busyDays.includes(day(t.entryAt)));
  const base = { key: "overtrade", title: "Trading too often", sample: { days: byDay.size, busyDays: busyDays.length, busy: busy.length, quiet: quiet.length } };
  if (byDay.size < 3) return { ...base, measured: false, present: false, why: `round trips opened on ${plural(byDay.size, "day")}: at least 3 days are needed` };
  if (busy.length < 3 || quiet.length < 3) return { ...base, measured: false, present: false, why: busyDays.length ? `${busy.length} round trips on its busiest days (${T}+ buys) and ${quiet.length} on the others: at least 3 of each are needed` : `no day with ${T} or more buys (its median is ${med} a day), so there is no busy day to compare` };
  const rB = retOf(busy), rQ = retOf(quiet), costB = sum(busy, (t) => t.cost);
  const gap = (rQ - rB) * costB;
  const present = gap > 0 && rB < rQ - 0.05;
  const top = [...byDay].sort((a, b) => b[1] - a[1])[0];
  return {
    ...base, measured: true, present, costEth: present ? gap : 0, costPct: present ? rQ - rB : 0,
    compare: [{ n: busy.length, label: `trades on busy days (${T}+ buys)`, ret: rB }, { n: quiet.length, label: "trades on other days", ret: rQ }],
    numbers: { medianPerDay: med, busyFrom: T, busyReturn: rB, quietReturn: rQ, busiest: { day: top[0], trips: top[1] } },
    sentence: present ? `trading too often. On its ${plural(busyDays.length, "busiest day")} (${T} or more buys) its ${busy.length} round trips returned ${fmtPct(rB)} against ${fmtPct(rQ)} for ${quiet.length} on the other days, about ${fmtEth(gap)} less`
      : `round trips on its busiest days (${T}+ buys) returned ${fmtPct(rB)}, on the other days ${fmtPct(rQ)}: no cost found`,
    facts: [`${plural(byDay.size, "active day")}, a median of ${med} round trips a day; the busiest, ${top[0]}, had ${top[1]}`,
      `${plural(busyDays.length, "busy day")} (${T}+ buys): ${busy.length} round trips, ${fmtPct(rB)}, ${fmtEth(sum(busy, (t) => t.pnl))}`,
      `Other days: ${quiet.length} round trips, ${fmtPct(rQ)}, ${fmtEth(sum(quiet, (t) => t.pnl))}`],
    evidence: worst(busy).map((t) => ev(t, `$${t.symbol} bought on ${day(t.entryAt)}, a ${byDay.get(day(t.entryAt))}-trade day; round trip ${tripLine(t)}`)),
    rule: { kind: "daily-buys", n: Math.max(1, T - 1), label: `At most ${Math.max(1, T - 1)} buys a day`, enforced: true },
  };
}

function earlySellHabit(trips) {
  const W = trips.filter((t) => t.pnl > 0);
  const priced = W.filter((t) => t.laterPx > 0 && t.sold > 0);
  const base = { key: "earlysell", title: "Selling winners too early", sample: { winners: W.length, priced: priced.length } };
  if (priced.length < 3) return { ...base, measured: false, present: false, why: W.length < 3 ? `${plural(W.length, "winning round trip")}: at least 3 are needed` : `the later price of only ${priced.length} of its ${W.length} winners could be read (Pons coins paired with ETH, sold at least an hour ago): at least 3 are needed` };
  const up = priced.filter((t) => t.laterPx >= 1.5 * (t.proceeds / t.sold));
  const left = sum(up, (t) => t.sold * (t.laterPx - t.proceeds / t.sold));
  const present = up.length >= 2 && up.length / priced.length >= 0.4 && left > 0;
  const proceedsUp = sum(up, (t) => t.proceeds);
  return {
    ...base, measured: true, present, costEth: present ? left : 0, costPct: present && proceedsUp > 0 ? left / proceedsUp : 0, upperBound: true,
    compare: [{ n: up.length, label: "winners sold below the later price", ret: retOf(up) }, { n: priced.length, label: "winners with a later price read", ret: retOf(priced) }],
    numbers: { soldBelowLater: up.length, priced: priced.length },
    sentence: present ? `selling winners early. ${up.length} of its ${priced.length} winning round trips read were sold below the coin's price ${up.every((t) => t.laterH === 24) ? "24 h" : "1 to 24 h"} later (1.5x or more); at that price the coins sold were worth about ${fmtEth(left)} more`
      : `${up.length} of ${priced.length} winners traded at 1.5x or more of the sale price later: not a pattern`,
    facts: [`${priced.length} winning round trips with a readable later price; ${up.length} traded at 1.5x or more of the sale price ${up.length && up.every((t) => t.laterH === 24) ? "24 h" : "1 to 24 h"} later`,
      "The later price is the pool's spot price at that block; selling that size then would have moved it, so this is an upper bound"],
    evidence: [...up].sort((a, b) => b.laterPx / (b.proceeds / b.sold) - a.laterPx / (a.proceeds / a.sold)).slice(0, 3).map((t) => ev(t, `$${t.symbol} sold at ${fmtPct(t.ret)}; ${t.laterH} h later its price was ${(t.laterPx / (t.proceeds / t.sold)).toFixed(1)}x the sale price`, "exit")),
    rule: { kind: "note", habit: "earlysell", label: "Reminder: look again before selling a winner", text: "Before I sell a winning position, I look at it again: my winners often traded higher after I sold.", enforced: false },
  };
}

/** Every habit, measured or not, and the one that cost most (largest cost first; a habit whose cost could not be measured
 *  comes after those with a cost; ties by a fixed order). */
export function measureHabits(trips) {
  const e60 = earlyHabit(trips, 60), e300 = earlyHabit(trips, 300);
  // one launch habit: the window that cost more (60 s when both cost the same or neither was measured)
  const early = (e300.present && (!e60.present || e300.costEth > e60.costEth)) ? e300 : e60.measured || !e300.measured ? e60 : e300;
  const habits = [early, holdHabit(trips), overtradeHabit(trips), earlySellHabit(trips)];
  const ORDER = { early: 0, hold: 1, overtrade: 2, earlysell: 3 };
  const ranked = habits.filter((h) => h.present).sort((a, b) => (b.costEth ?? -1) - (a.costEth ?? -1) || ORDER[a.key] - ORDER[b.key]);
  return { habits, top: ranked[0] || null, alt: { early60: e60, early300: e300 } };
}

/* ---------- reading the wallet ---------- */
let bsMod = null;
const budget = { day: "", calls: 0 };
function takeCalls(n = 1) {
  if (budget.day !== day()) { budget.day = day(); budget.calls = 0; }
  if (budget.calls + n > DAILY_CALLS) return false;
  budget.calls += n;
  return true;
}
export const chironBudget = () => ({ day: budget.day || day(), used: budget.day === day() ? budget.calls : 0, of: DAILY_CALLS });
class OverBudget extends Error {}
async function bs(path) {
  bsMod ||= await import("./market.mjs");
  if (!bsMod.hasBlockscout()) throw new Error("Trade history is not available on this server right now (Blockscout is paused or not set up).");
  if (!takeCalls()) throw new OverBudget("Chiron has used today's history reads. Ask again after 00:00 UTC.");
  return bsMod.blockscoutApi(path);
}
async function pagesOf(path, max) {
  const items = [];
  let next = null, n = 0;
  do {
    const r = await bs(next ? `${path}?${qs(next).slice(1)}` : path);
    items.push(...(r?.items || []));
    next = r?.next_page_params || null;
  } while (next && ++n < max);
  const ts = items.map((x) => (x.timestamp ? Date.parse(x.timestamp) : null)).filter((x) => x != null);
  return { items, complete: !next, oldest: ts.length ? Math.min(...ts) : null };
}

const QUOTE = () => ({ weth: lc(ADDR_CACHE.weth), usdg: lc(ADDR_CACHE.usdg) });
let ADDR_CACHE = null;
async function addrs() {
  if (!ADDR_CACHE) { const rh = await import("./robinhood.mjs"); ADDR_CACHE = { ...rh.ADDR, rpc: rh.rpc, iface: rh.iface }; }
  return ADDR_CACHE;
}
/** a coin bought or sold against ETH, WETH or USDG: true for those three (a quote, not a coin) */
export async function isQuote(token) {
  const A = await addrs();
  const t = lc(token);
  return !t || t === "native" || t === "eth" || /^0x0{40}$/.test(t) || t === lc(A.weth) || t === lc(A.usdg);
}

/** the wallet's swaps as events (oldest first) plus what the history read covers */
async function readSwaps(a) {
  const A = await addrs();
  const { weth, usdg } = QUOTE();
  const [tt, txs, itx] = await Promise.all([pagesOf(`/addresses/${a}/token-transfers`, PAGES), pagesOf(`/addresses/${a}/transactions`, PAGES), pagesOf(`/addresses/${a}/internal-transactions`, PAGES)]);
  // the stretch all three lists cover
  const since = Math.max(...[tt, txs, itx].filter((l) => !l.complete && l.oldest != null).map((l) => l.oldest), 0);
  const ethUsdNow = Number(await bsMod.getEthUsd().catch(() => 0)) || 0;
  const per = new Map();   // hash → { at, block, eth, weth, usdg, usd, coins: Map(token → { net, symbol, venue }) }
  const row = (h, x) => { let r = per.get(h); if (!r) { r = { hash: h, at: x.timestamp ? Date.parse(x.timestamp) : null, block: Number(x.block_number || 0), eth: 0, weth: 0, usdg: 0, rate: null, coins: new Map(), failed: false }; per.set(h, r); } return r; };
  const wei = (v) => Number(BigInt(v || 0)) / 1e18;
  for (const x of txs.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since) continue;
    const r = row(lc(x.hash), x);
    if (x.status && x.status !== "ok") { r.failed = true; continue; }
    if (lc(x.from?.hash) === a) r.eth -= wei(x.value);
    if (lc(x.to?.hash) === a) r.eth += wei(x.value);
    const rate = Number(x.historic_exchange_rate || x.exchange_rate || 0);
    if (rate > 0) r.rate = rate;
  }
  for (const x of itx.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since || x.success === false || x.error || !x.value || x.value === "0") continue;
    const r = row(lc(x.transaction_hash), x);
    if (lc(x.from?.hash) === a) r.eth -= wei(x.value);
    if (lc(x.to?.hash) === a) r.eth += wei(x.value);
  }
  const ponsMod = await import("./portfolio.mjs");
  const coinsSeen = new Set();
  let stocks = 0, nft = 0;
  for (const x of tt.items) {
    const at = x.timestamp ? Date.parse(x.timestamp) : 0;
    if (at < since) continue;
    const tok = lc(x.token?.address_hash);
    const type = x.token?.type || x.token_type;
    if (!tok) continue;
    if (type === "ERC-8056") { stocks++; continue; }
    if (type !== "ERC-20") { nft++; continue; }
    const v = Number(x.total?.value || 0) / 10 ** Number(x.total?.decimals ?? x.token?.decimals ?? 18);
    const sign = (lc(x.to?.hash) === a ? 1 : 0) - (lc(x.from?.hash) === a ? 1 : 0);
    if (!sign || !(v > 0)) continue;
    const r = row(lc(x.transaction_hash), x);
    if (tok === weth) { r.weth += sign * v; continue; }
    if (tok === usdg) { r.usdg += sign * v; continue; }
    if (x.token?.reputation === "scam") continue;
    coinsSeen.add(tok);
    const c = r.coins.get(tok) || { net: 0, symbol: cleanSym(x.token?.symbol), cp: [] };
    c.net += sign * v;
    const other = sign > 0 ? x.from : x.to;
    c.cp.push({ hash: lc(other?.hash), contract: !!other?.is_contract, name: String(other?.name || "") });
    r.coins.set(tok, c);
  }
  // name the venue from the counterparty of the coin: its Pons curve, the v4 PoolManager, a v3 pool, or a router
  const pons = await ponsMod.ponsInfo([...coinsSeen]).catch(() => new Map());
  const pm = lc(A.poolManager);
  const venueOf = (tok, cp) => {
    const curve = pons.get(tok)?.curve;
    for (const c of cp) {
      if (curve && c.hash === curve) return "Pons curve";
      if (c.hash === pm) return "Uniswap v4";
      if (/uniswapv3pool|v3 ?pool/i.test(c.name)) return "Uniswap v3";
    }
    for (const c of cp) if (/pool/i.test(c.name)) return "a pool";
    return "a router";
  };
  const events = [];
  let coinSwaps = 0, transfers = 0;
  for (const r of per.values()) {
    if (r.failed || !r.coins.size) continue;
    const moved = [...r.coins].filter(([, c]) => Math.abs(c.net) > 0);
    if (!moved.length) continue;
    const ethUsd = r.rate || ethUsdNow;
    const quote = r.eth + r.weth + (ethUsd > 0 ? r.usdg / ethUsd : 0);
    if (moved.length > 1) {   // coin for coin, or several coins at once: not a trade against ETH
      coinSwaps++;
      for (const [tok, c] of moved) events.push({ token: tok, symbol: c.symbol, kind: c.net > 0 ? "in" : "out", amount: Math.abs(c.net), eth: 0, at: r.at, block: r.block, tx: r.hash });
      continue;
    }
    const [tok, c] = moved[0];
    const venue = venueOf(tok, c.cp);
    if (c.net > 0 && quote < -1e-12) events.push({ token: tok, symbol: c.symbol, kind: "buy", amount: c.net, eth: -quote, at: r.at, block: r.block, tx: r.hash, venue, usdg: r.usdg !== 0 });
    else if (c.net < 0 && quote > 1e-12) events.push({ token: tok, symbol: c.symbol, kind: "sell", amount: -c.net, eth: quote, at: r.at, block: r.block, tx: r.hash, venue, usdg: r.usdg !== 0 });
    else { transfers++; events.push({ token: tok, symbol: c.symbol, kind: c.net > 0 ? "in" : "out", amount: Math.abs(c.net), eth: 0, at: r.at, block: r.block, tx: r.hash }); }
  }
  events.sort((x, y) => x.block - y.block || x.at - y.at);
  const ats = [tt, txs, itx].flatMap((l) => l.items.map((x) => (x.timestamp ? Date.parse(x.timestamp) : null))).filter((x) => x != null && x >= since);
  return {
    events, pons,
    window: { from: since || (ats.length ? Math.min(...ats) : null), to: ats.length ? Math.max(...ats) : null, complete: tt.complete && txs.complete && itx.complete, pages: PAGES },
    counts: { transactions: per.size, coinSwaps, transfers, stocks, nft, coins: coinsSeen.size },
  };
}

/* ---------- launch times and later prices ---------- */
// How long after a coin's launch the wallet bought it, read from the chain alone: does the coin's code exist at the block
// 5 minutes before the buy? If it does, the buy came more than 5 minutes after launch (the exact age is not needed). If it
// does not, the coin was created inside those 5 minutes and a binary search over the blocks between finds its creation
// block, so the seconds are exact. A Pons coin is created in its launch transaction, so for it this is the launch; for any
// other coin it is its creation (said as such). About 3 calls a coin, 15 for an early one; births are kept for good.
const LOOK = 300;                                 // seconds: the widest launch window measured
const births = new Map();                         // token → { block, at } (created) | { before: block } (existed at that block)
let RATE = { at: 0, v: 9.5 };                     // blocks a second, measured over the last ~200k blocks every 10 minutes
async function blockTs(n) {
  const A = await addrs();
  const b = await A.rpc("robinhood", "eth_getBlockByNumber", [typeof n === "number" ? "0x" + n.toString(16) : n, false], { timeoutMs: 10_000 });
  return { n: Number(BigInt(b.number)), t: Number(BigInt(b.timestamp)) };
}
async function rate() {
  if (Date.now() - RATE.at < 10 * 60_000) return RATE.v;
  const h = await blockTs("latest"), o = await blockTs(Math.max(1, h.n - 200_000));
  if (h.t > o.t) RATE = { at: Date.now(), v: (h.n - o.n) / (h.t - o.t) };
  return RATE.v;
}
/** the newest block whose time is at or before tsSec, searching back from a block we know (fromBlock at fromTs) */
async function blockAtOrBefore(tsSec, fromBlock, fromTs) {
  const v = await rate();
  let n = fromBlock, t = fromTs;
  for (let i = 0; i < 5 && t > tsSec; i++) { n = Math.max(1, n - Math.ceil((t - tsSec) * v) - 2); ({ t } = await blockTs(n)); }
  if (t > tsSec) throw new Error("block not found");
  return { n, t };
}
const hasCode = async (token, n) => { const A = await addrs(); const c = await A.rpc("robinhood", "eth_getCode", [getAddress(token), "0x" + n.toString(16)], { timeoutMs: 10_000 }); return !!c && c !== "0x"; };
async function birthNear(token, entryBlock, entryAt) {
  const k = lc(token), hit = births.get(k);
  if (hit?.block != null || (hit?.before != null && hit.before <= entryBlock)) return hit;
  const back = await blockAtOrBefore(Math.floor(entryAt / 1000) - LOOK, entryBlock, Math.floor(entryAt / 1000));
  if (await hasCode(k, back.n)) { const v = { before: back.n }; if (!hit || hit.before > back.n) births.set(k, v); return v; }
  let lo = back.n, hi = entryBlock;                // no code at lo, code at hi (the buy happened)
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await hasCode(k, mid)) hi = mid; else lo = mid; }
  const { t } = await blockTs(hi);
  const v = { block: hi, at: t * 1000 };
  births.set(k, v);
  if (births.size > 20_000) births.delete(births.keys().next().value);
  return v;
}
/** entrySec (exact, when the buy came within 5 minutes of launch) or entryAfter = 300 (later than that) on every trip */
async function entryAges(trips, { waitMs = 30_000, parallel = 8 } = {}) {
  const until = Date.now() + waitMs;
  const first = new Map();                         // the earliest trip of each coin settles the others
  for (const t of [...trips].sort((a, b) => a.entryBlock - b.entryBlock)) if (!first.has(t.token)) first.set(t.token, t);
  const todo = [...first.values()];
  let i = 0;
  const worker = async () => {
    while (i < todo.length && Date.now() < until) {
      const t = todo[i++];
      await birthNear(t.token, t.entryBlock, t.entryAt).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  for (const t of trips) {
    const b = births.get(t.token);
    if (b?.block != null && b.block <= t.entryBlock) { t.launchAt = b.at; t.launchBlock = b.block; t.entrySec = Math.max(0, (t.entryAt - b.at) / 1000); if (t.entrySec > LOOK) { t.entryAfter = LOOK; } }
    else if (b?.before != null && b.before <= t.entryBlock) t.entryAfter = LOOK;
  }
}
const CURVE = new Interface(["function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)", "function graduated() view returns (bool)"]);
const PMI = new Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);
/** ETH per coin at a past block, from the chain (null when the pair is not ETH or the read fails) */
async function pxAt(info, block) {
  const A = await addrs();
  const ZERO = "0x0000000000000000000000000000000000000000";
  if (!info || (info.pair !== ZERO && info.pair !== lc(A.weth)) || info.pd !== 18) return null;
  const { ponsSlot0Of } = await import("./portfolio.mjs");
  const calls = [{ target: info.curve, data: CURVE.encodeFunctionData("getReserves") }, { target: info.curve, data: CURVE.encodeFunctionData("graduated") },
    { target: A.poolManager, data: PMI.encodeFunctionData("extsload", [ponsSlot0Of(info.poolId)]) }];
  const data = A.iface.mc.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
  const raw = await A.rpc("robinhood", "eth_call", [{ to: A.multicall3, data }, "0x" + block.toString(16)], { timeoutMs: 12_000 });
  const [res] = A.iface.mc.decodeFunctionResult("aggregate3", raw);
  const dec = (i, ifc, fn) => { try { return res[i].success && res[i].returnData !== "0x" ? ifc.decodeFunctionResult(fn, res[i].returnData) : null; } catch { return null; } };
  const grad = !!dec(1, CURVE, "graduated")?.[0];
  if (!grad) { const rv = dec(0, CURVE, "getReserves"); return rv && rv[1] > 0n ? Number(rv[0]) / Number(rv[1]) : null; }
  const w = (() => { try { return res[2].success ? BigInt(PMI.decodeFunctionResult("extsload", res[2].returnData)[0]) : 0n; } catch { return 0n; } })();
  const sq = w & ((1n << 160n) - 1n);
  if (!(sq > 0n)) return null;
  const sp = Number(sq) / 2 ** 96, r = sp * sp;
  return info.tokenFirst ? r : 1 / r;
}
async function laterPrices(trips, pons, maxWinners = 12) {
  const A = await addrs();
  const head = await A.rpc("robinhood", "eth_getBlockByNumber", ["latest", false], { timeoutMs: 10_000 });
  const hb = Number(BigInt(head.number)), ht = Number(BigInt(head.timestamp)) * 1000;
  const W = trips.filter((t) => t.pnl > 0 && pons.has(t.token) && t.exitBlock && t.exitAt).sort((a, b) => b.pnl - a.pnl).slice(0, maxWinners);
  await Promise.all(W.map(async (t) => {
    const rate = (hb - t.exitBlock) / Math.max(1, (ht - t.exitAt) / 1000);          // blocks a second between the sale and now
    const hrs = ht - t.exitAt >= 24 * 3600_000 ? 24 : ht - t.exitAt >= 3600_000 ? 1 : 0;
    if (!hrs || !(rate > 0)) return;
    const b = Math.min(hb, t.exitBlock + Math.round(hrs * 3600 * rate));
    const px = await pxAt(pons.get(t.token), b).catch(() => null);
    if (px > 0) { t.laterPx = px; t.laterH = hrs; t.laterBlock = b; }
  }));
}

/* ---------- one wallet ---------- */
const VENUES = ["Pons curve", "Uniswap v4", "Uniswap v3", "a pool", "a router"];
async function compute(address) {
  const a = lc(address);
  const A = await addrs();
  const code = await A.rpc("robinhood", "eth_getCode", [getAddress(a), "latest"], { timeoutMs: 12_000 }).catch(() => null);
  const contract = !!code && code !== "0x" && !/^0xef0100/i.test(code);
  if (contract) {
    // a token or a pool is not a trader; a smart account is (its swaps are read the same way)
    const m = await A.rpc("robinhood", "eth_call", [{ to: getAddress(a), data: "0x95d89b41" }, "latest"], { timeoutMs: 8000 }).catch(() => null);
    if (m && m !== "0x") return { address: getAddress(a), status: "none", sentence: "This is a token contract, not a trader wallet. Paste the wallet that trades it.", habits: [], sample: null, checkedAt: Date.now() };
  }
  const s = await readSwaps(a);
  const rt = roundTrips(s.events);
  const buys = s.events.filter((e) => e.kind === "buy"), sells = s.events.filter((e) => e.kind === "sell");
  const coinsTraded = new Set([...buys, ...sells].map((e) => e.token)).size;
  const sample = {
    trips: rt.trips.length, open: rt.open.length, buys: buys.length, sells: sells.length, coins: coinsTraded,
    leftOut: { soldBeforeHistory: rt.unmatched, mixedWithTransfers: rt.tainted, dust: rt.dust, coinForCoin: s.counts.coinSwaps, transfers: s.counts.transfers, stockTokens: s.counts.stocks },
    window: s.window, transactions: s.counts.transactions,
    venues: Object.fromEntries(VENUES.map((v) => [v, buys.filter((e) => e.venue === v).length + sells.filter((e) => e.venue === v).length]).filter(([, n]) => n)),
    minTrips: MIN_TRIPS,
  };
  const base = { address: getAddress(a), sample, checkedAt: Date.now(), note: NOTE };
  if (!buys.length && !sells.length) return { ...base, status: "none", sentence: `No swaps of Robinhood Chain coins against ETH were found in this wallet's history read (${plural(s.counts.transactions, "transaction")}).`, habits: [], trips: [] };
  if (rt.trips.length < MIN_TRIPS) {
    return { ...base, status: "few", sentence: `Too few trades to name a habit: Chiron needs at least ${MIN_TRIPS} closed round trips and this wallet has ${rt.trips.length} in the history read (${plural(buys.length, "buy")} and ${plural(sells.length, "sell")} across ${plural(coinsTraded, "coin")}, ${plural(rt.open.length, "position")} still open).`, habits: [], trips: tripsView(rt.trips) };
  }
  // launch times (for the launch habit) and later prices (for the sold-early habit)
  await entryAges(rt.trips).catch((e) => console.warn("[chiron] launch ages", e.message));
  for (const t of rt.trips) if (t.entrySec != null || t.entryAfter) t.launchSrc = s.pons.has(t.token) ? "pons" : "creation";
  await laterPrices(rt.trips, s.pons).catch((e) => console.warn("[chiron] later prices", e.message));
  const { habits, top } = measureHabits(rt.trips);
  const all = { pnlEth: sum(rt.trips, (t) => t.pnl), costEth: sum(rt.trips, (t) => t.cost), winRate: rt.trips.filter((t) => t.pnl > 0).length / rt.trips.length, medianHoldMs: median(rt.trips.map((t) => t.holdMs)) };
  all.returnPct = all.costEth > 0 ? all.pnlEth / all.costEth : null;
  sample.launchKnown = rt.trips.filter((t) => t.entrySec != null || t.entryAfter).length;
  sample.pons = rt.trips.filter((t) => s.pons.has(t.token)).length;
  const sentence = top ? `Chiron: the habit that cost this wallet most is ${top.sentence}.`
    : `Chiron found no costly habit in ${rt.trips.length} closed round trips: none of the habits it measures did clearly worse than the wallet's other trades${habits.some((h) => !h.measured) ? " (some could not be measured; see below)" : ""}.`;
  return { ...base, status: "done", sentence, top: top ? top.key : null, habits, results: all, trips: tripsView(rt.trips) };
}
const tripsView = (trips) => [...trips].sort((a, b) => b.exitAt - a.exitAt).slice(0, 40).map((t) => ({
  token: getAddress(t.token), symbol: t.symbol, venue: t.venue, entryAt: t.entryAt, exitAt: t.exitAt, holdMs: t.holdMs, costEth: t.cost, pnlEth: t.pnl, ret: t.ret,
  entrySec: t.entrySec != null && !t.entryAfter ? t.entrySec : null, entryAfter: t.entryAfter || null, launchSrc: t.launchSrc || null, buys: t.buys, sells: t.sells, entryTx: t.entryTx, exitTx: t.exitTx,
  ...(t.laterPx ? { laterX: t.laterPx / (t.proceeds / t.sold), laterH: t.laterH } : {}),
}));
const NOTE = "Chiron describes what this wallet's own trades did. It is not advice: it never says what to buy or sell, and a habit is a comparison inside the wallet's own history, not proof of what caused a loss. Read from Robinhood Chain (Blockscout and the chain itself); gas is not counted.";

const memo = new Map(), inflight = new Map();
let running = 0;
const queue = [];
async function slot(fn) {               // two wallets at a time: the Blockscout client is shared and paced
  if (running >= 2) await new Promise((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}
/** Chiron for one wallet (cached 30 minutes; a reading still running answers { status: "reading" } and goes on) */
export async function chiron(address, { waitMs = WAIT_MS } = {}) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a trader's wallet address on Robinhood Chain (0x + 40 hex).");
  const k = lc(address);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) {
    const startedAt = Date.now();
    const p = slot(() => compute(k)).then((res) => {
      memo.set(k, { at: Date.now(), ttl: res.status === "done" || res.status === "few" || res.status === "none" ? TTL_DONE : TTL_SHORT, res });
      if (memo.size > 1000) memo.delete(memo.keys().next().value);
      return res;
    }, (e) => {
      const res = { address: getAddress(k), status: e instanceof OverBudget ? "busy" : "error", sentence: e instanceof OverBudget ? e.message : `The wallet's history could not be read just now (${String(e.message || e).slice(0, 140)}). Ask again in a minute.`, habits: [], sample: null, checkedAt: Date.now() };
      memo.set(k, { at: Date.now(), ttl: 60_000, res });
      return res;
    }).finally(() => inflight.delete(k));
    p.startedAt = startedAt;
    inflight.set(k, p);
  }
  const p = inflight.get(k);
  const r = await Promise.race([p, sleep(waitMs).then(() => null)]);
  return r || { address: getAddress(k), status: "reading", startedAt: p.startedAt, sentence: "Reading this wallet's trades from Robinhood Chain. This takes up to a minute the first time.", habits: [], sample: null };
}

/* ---------- rules: one tap turns a habit into a rule ---------- */
const RULE_LIMITS = { sec: [10, 3600], n: [1, 100] };
const clampInt = (v, [lo, hi]) => { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
export async function rulesOf(owner) {
  if (!store) return {};
  const d = await store.readJson(FILE, {});
  return d.rules?.[lc(owner)] || {};
}
export async function buysToday(owner) {
  if (!store) return 0;
  const d = await store.readJson(FILE, {});
  const b = d.buys?.[lc(owner)];
  return b?.day === day() ? b.n || 0 : 0;
}
/** an Agent Wallet buy went out (agentwallet.mjs): counted for the daily-buys rule */
export async function noteBuy(owner) {
  if (!store) return;
  await store.update(FILE, {}, (d) => {
    d.buys ||= {};
    const k = lc(owner), b = d.buys[k]?.day === day() ? d.buys[k] : { day: day(), n: 0 };
    b.n++; d.buys[k] = b;
    return d;
  });
}
export async function setRule(owner, body) {
  const kind = String(body?.kind || "");
  const on = body?.on !== false;
  const from = isAddress(String(body?.from || "")) ? getAddress(body.from) : null;
  let out = null;
  await store.update(FILE, {}, (d) => {
    d.rules ||= {};
    const k = lc(owner), r = d.rules[k] || {};
    if (kind === "launch-wait") {
      if (!on) delete r.launchWait;
      else { const sec = clampInt(body.sec, RULE_LIMITS.sec); if (sec == null) throw new HttpError(400, "Give the number of seconds (10 to 3600)."); r.launchWait = { sec, at: Date.now(), from }; }
    } else if (kind === "daily-buys") {
      if (!on) delete r.dailyBuys;
      else { const n = clampInt(body.n, RULE_LIMITS.n); if (n == null) throw new HttpError(400, "Give the number of buys a day (1 to 100)."); r.dailyBuys = { n, at: Date.now(), from }; }
    } else if (kind === "note") {
      const habit = ["hold", "earlysell"].includes(body?.habit) ? body.habit : null;
      if (!habit) throw new HttpError(400, "A reminder belongs to a habit: hold or earlysell.");
      r.notes = (r.notes || []).filter((x) => x.habit !== habit);
      if (on) r.notes.push({ habit, text: String(body.text || "").replace(/[<>]/g, "").slice(0, 200), at: Date.now(), from });
      if (!r.notes.length) delete r.notes;
    } else throw new HttpError(400, "Unknown rule. Use launch-wait, daily-buys or note.");
    d.rules[k] = r;
    out = r;
    return d;
  });
  return out;
}
/** the rules in words, for Scepter, the chat and the API */
export function ruleLines(r) {
  const L = [];
  if (r?.launchWait) L.push({ kind: "launch-wait", sec: r.launchWait.sec, enforced: true, text: `No buys of a coin in its first ${r.launchWait.sec >= 120 && r.launchWait.sec % 60 === 0 ? `${r.launchWait.sec / 60} minutes` : `${r.launchWait.sec} seconds`}`, at: r.launchWait.at, from: r.launchWait.from });
  if (r?.dailyBuys) L.push({ kind: "daily-buys", n: r.dailyBuys.n, enforced: true, text: `At most ${r.dailyBuys.n} buys a day from the Agent Wallet (UTC day)`, at: r.dailyBuys.at, from: r.dailyBuys.from });
  for (const n of r?.notes || []) L.push({ kind: "note", habit: n.habit, enforced: false, text: n.text, at: n.at, from: n.from });
  return L;
}

// a coin's age: older than `sec` seconds? Once a coin is old enough it stays so (cached); a young or unreadable coin is read
// again on the next buy. tokenage's cached birth is used first; otherwise the chain: does the coin's code exist at the block
// `sec` seconds ago? A Pons coin is created in its launch transaction, so for it this is exactly "since launch".
const oldEnough = new Map();      // token → the largest age (s) it was confirmed to have
const blockRate = { at: 0, rate: 9.5 };
export const deps = {
  now: () => Date.now(),
  born: async (token) => (await import("./tokenage.mjs")).bornAt(token, { waitMs: 0 }),
  // the newest block at or before tsSec, and whether the token's code existed there
  codeBefore: async (token, tsSec) => {
    const A = await addrs();
    const blk = async (n) => { const b = await A.rpc("robinhood", "eth_getBlockByNumber", [typeof n === "number" ? "0x" + n.toString(16) : n, false], { timeoutMs: 8000 }); return { n: Number(BigInt(b.number)), t: Number(BigInt(b.timestamp)) }; };
    const head = await blk("latest");
    if (Date.now() - blockRate.at > 10 * 60_000) {
      const back = await blk(Math.max(1, head.n - 20_000)).catch(() => null);
      if (back && head.t > back.t) { blockRate.rate = (head.n - back.n) / (head.t - back.t); blockRate.at = Date.now(); }
    }
    let n = head.n, t = head.t;
    for (let i = 0; i < 4 && t > tsSec; i++) { n = Math.max(1, n - Math.ceil((t - tsSec) * blockRate.rate) - 3); ({ t } = await blk(n)); }
    if (t > tsSec) throw new Error("the block of that time could not be found");
    const code = await A.rpc("robinhood", "eth_getCode", [getAddress(token), "0x" + n.toString(16)], { timeoutMs: 8000 });
    return { block: n, exists: !!code && code !== "0x" };
  },
};
export function _setDeps(o) { Object.assign(deps, o); }
export function _reset() { oldEnough.clear(); }

async function launchWaitCheck(token, sec) {
  const t = lc(token);
  if ((oldEnough.get(t) || 0) >= sec) return null;
  const born = await deps.born(t).catch(() => null);
  if (born) {
    const age = (deps.now() - born) / 1000;
    if (age >= sec) { oldEnough.set(t, Math.max(oldEnough.get(t) || 0, sec)); return null; }
    return `Your Chiron rule: no buys in a coin's first ${sec} seconds. This coin is ${Math.max(0, Math.floor(age))} seconds old.`;
  }
  try {
    const r = await deps.codeBefore(t, Math.floor(deps.now() / 1000) - sec);
    if (r.exists) { oldEnough.set(t, Math.max(oldEnough.get(t) || 0, sec)); return null; }
    return `Your Chiron rule: no buys in a coin's first ${sec} seconds. This coin did not exist ${sec} seconds ago (it was not on chain at block ${r.block.toLocaleString("en-US")}).`;
  } catch (e) {
    return `Your Chiron rule: no buys in a coin's first ${sec} seconds. The coin's age could not be read just now (${String(e.message || e).slice(0, 80)}), so no buy without the check.`;
  }
}
/**
 * The owner's Chiron rules for one buy → { reasons: [] }. policy.mjs checkAction calls this for every swap that buys a
 * coin (side "buy"), so the Agent Wallet blocks the buy and chat tickets show the reason. A sell is never held back.
 */
export async function ruleCheck(owner, { token } = {}) {
  const r = await rulesOf(owner);
  const reasons = [];
  if (r.launchWait && token) { const why = await launchWaitCheck(token, r.launchWait.sec); if (why) reasons.push(why); }
  if (r.dailyBuys) {
    const n = await buysToday(owner);
    if (n >= r.dailyBuys.n) reasons.push(`Your Chiron rule: at most ${r.dailyBuys.n} buys a day. The Agent Wallet has made ${n} today (the count resets at 00:00 UTC).`);
  }
  return { reasons };
}

export async function register(r, ctx) {
  store = ctx.store;
  const { requireSession } = await import("./auth.mjs");
  // before /api/chiron/:address, which would also match these paths
  r.get("/api/chiron/rules", async ({ req }) => {
    const s = requireSession(req);
    return { rules: ruleLines(await rulesOf(s.address)), buysToday: await buysToday(s.address), enforcedOn: ENFORCED_ON };
  }, { weight: 1 });
  r.get("/api/chiron/budget", () => chironBudget(), { weight: 1 });
  r.get("/api/chiron/:address", ({ params }) => chiron(params.address), { weight: 1, perMin: 30 });   // cached answers and "reading" polls are cheap; the reads have their own daily budget
  r.post("/api/chiron/rule", async ({ req, body }) => {
    const s = requireSession(req);
    const raw = await setRule(s.address, body || {});
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "chiron.rule", summary: `${body?.on === false ? "Removed" : "Set"} a Chiron rule (${String(body?.kind || "").slice(0, 20)})`, data: { kind: body?.kind, sec: body?.sec, n: body?.n, habit: body?.habit, from: body?.from }, source: "app" }).catch(() => {});
    const enforced = body?.kind !== "note";
    return { ok: true, rules: ruleLines(raw), enforced, note: body?.on === false ? "Rule removed." : enforced ? `Saved. ${ENFORCED_ON}` : "Saved as a reminder in Agent control (Scepter). Troya cannot enforce this one: it does not hold or close your positions for you." };
  }, { perMin: 20 });
}
export const ENFORCED_ON = "Enforced on every buy from your Agent Wallet: your own taps, Sentry Autopilot, Playbooks, Aegis and Champions, and chat tickets show it. Swaps you sign in your own wallet on Swap are not stopped.";
