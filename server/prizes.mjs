// Weekly prize pool for the most active traders on Troya (owner, 22 Nov 2026; community request: "a leaderboard needs
// prizes that grow with activity"). It sits on top of the leaderboard page (#/leaderboard).
//   · the pool: 0.1% of $TROYA trading volume that week. The creator wallet earns 2.6% of every $TROYA trade, so the pool is
//     the creator fees credited that week × LEADERBOARD_POOL_VOLUME_BPS (default 10) / 260. The credits are the ones the fee
//     split uses: feesplit.mjs keeps data/fee-credits.json (hourly sums of the Pons escrow's Credited events for the creator
//     wallet, counted from data/fee-split-start.json's startBlock, default 119990898). This module only reads that file.
//   · the week: Monday 00:00 UTC to the next Monday 00:00 UTC (the Arena Cup's week and label, e.g. "2026-W48"). The first
//     prize week starts Monday 23 Nov 2026 (LEADERBOARD_PRIZES_FROM); weeks before it are never paid.
//   · the ranking: the USD value of trades made THROUGH Troya in the week, read from records the server writes itself:
//       - Agent Wallet swaps, perps and closes (data/journal.jsonl, agent-wallet.* entries with status "executed"), which
//         covers Telegram and X trades, Autopilot, Champions, Aegis, playbooks and the Inbox: they all run through the
//         Agent Wallet; the launch first buy sent right behind a launch (agent-wallet.launch, result.firstBuy) too.
//       - web Swap trades on Robinhood Chain: data/web-swaps.json, booked by POST /api/swap/sent (stakebonus.mjs) only when
//         the wallet sent exactly what Troya built for it; its coin and side are read from the receipt for the guard below.
//         An app's own report (POST /api/journal, source "reported by app") never counts by itself: anyone signed in can
//         write one.
//       - perps tickets from the Perps page (perp_order, reported by the app): counted only for the Hyperliquid fills that
//         Hyperliquid itself shows on that wallet, for that market, in the 3 minutes before the report.
//     A trade counts once (one hash or one entry), and only at $5 or more. Team, admin, test and Arena wallets are left out
//     (the list stats.mjs uses, plus the creator wallet and LEADERBOARD_EXCLUDE). A wallet and its Agent Wallet count as one.
//     Wash-trading guard: a round trip of the same coin (a buy and a sell, either order) within 5 minutes counts only its
//     larger leg; and no wallet counts for more than 40% of the week's total counted volume (all wallets, before the cap).
//     Each trade's USD value is stamped once, near the time it is first read (data/prize-trades.json), so standings do not
//     move with later prices: the value the Agent Wallet logged when it has one, else ETH × the ETH price of that hour.
//   · the prizes: the top 10 share the pool 30/20/15/10/7/6/4/3/3/2 %. With fewer than 10 traders the unpaid shares stay with
//     the owner, and so does any prize under LEADERBOARD_MIN_SEND_ETH (0.00002 ETH).
//   · paying: every Monday, after the Herald payouts (payouts.mjs calls afterHerald() when its weekly run ends; this module's
//     own hourly tick also runs it from 01:00 UTC once Herald has recorded the week, and from 03:00 UTC regardless). Plain ETH
//     transfers from the creator wallet (flywheel-auto payoutSigner()), keeping PAYOUT_RESERVE_ETH (0.003) for gas: if the
//     wallet cannot cover every prize above the reserve, nothing is sent and the week waits for the next hour. The prize
//     list is frozen on disk before the first transfer; each transfer is signed, its hash written to disk as "sending", and
//     only then broadcast. After a crash, a "sending" prize is settled from the chain (paid, or broadcast again with the
//     very same signed transaction, which can never pay twice); only when its nonce was taken by another transaction, seen
//     twice 15 minutes apart, is it signed again. Each week is recorded in data/prizes.json, each paid prize sealed.
//   · LEADERBOARD_PRIZES: "live" pays; "dry" (the default) works the week out and records it without sending; "off" does
//     nothing (the page still shows the standings).
//   GET  /api/leaderboard/prizes        public: the pool, live standings with each rank's estimated prize, last week's
//                                       winners with their transactions, the rules in plain words
//   POST /api/leaderboard/prizes/run {dry}   admin: work out (and, live and not dry, pay) the last closed week now
import { stat, open } from "node:fs/promises";
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";

const FILE = "prizes.json", VALS = "prize-trades.json", CREDITS = "fee-credits.json", START = "fee-split-start.json";
const DEF = { weeks: {}, told: {} };
export const DEFAULT_START_BLOCK = 119_990_898;   // the owner's fee-split start (21 Nov 2026), as feesplit.mjs
export const CREATOR_BPS = 260;                   // the creator wallet's 2.6% of $TROYA volume
export const SPLIT_PCT = [30, 20, 15, 10, 7, 6, 4, 3, 3, 2];
export const MIN_TRADE_USD = 5;
export const ROUND_TRIP_MS = 5 * 60_000;
export const CAP_PCT = 40;
const HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const TEST_WALLETS = ["0x12a05719851c8375342de65c9105329c81f57054"];   // the team's real-money test wallet (as stats.mjs)
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
const ethOf = (wei) => Number(BigInt(wei || 0)) / 1e18;
const r6 = (x) => +Number(x || 0).toFixed(6);
const r2 = (x) => +Number(x || 0).toFixed(2);
export const weiOfEth = (x) => BigInt(Math.round(Number(x) * 1e9)) * 10n ** 9n;
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
const NATIVE = (t) => t == null || t === "" || /^(eth|native|weth|0x0{40}|0xe{40})$/i.test(String(t).replace(/^\$/, ""));
const coinKey = (t) => lc(String(t || "").replace(/^\$/, ""));

export const modeOf = () => (["live", "dry", "off"].includes(process.env.LEADERBOARD_PRIZES) ? process.env.LEADERBOARD_PRIZES : "dry");
export const poolBps = () => { const v = Number(process.env.LEADERBOARD_POOL_VOLUME_BPS); return process.env.LEADERBOARD_POOL_VOLUME_BPS && v >= 0 && v <= CREATOR_BPS && isFinite(v) ? v : 10; };
export const minSendEth = () => { const v = Number(process.env.LEADERBOARD_MIN_SEND_ETH); return process.env.LEADERBOARD_MIN_SEND_ETH && v >= 0 && isFinite(v) ? v : 0.00002; };
const reserveEth = () => { const v = Number(process.env.PAYOUT_RESERVE_ETH); return process.env.PAYOUT_RESERVE_ETH && v >= 0 && isFinite(v) ? v : 0.003; };
export const fromTs = () => { const t = Date.parse(process.env.LEADERBOARD_PRIZES_FROM || "2026-11-23T00:00:00Z"); return isFinite(t) ? t : 0; };
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => lc(a).trim()).filter(isAddr);

let store = null;

/* ---------------- pure parts (tools/prizes-test.mjs feeds them fixtures) ---------------- */

/** The week `ms` falls in: Monday 00:00 UTC to the next Monday, labelled like the Arena Cup ("2026-W48"). */
export function weekAt(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const y = new Date(start + 3 * DAY).getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4), wk1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return { key: `${y}-W${String(1 + Math.floor((start - wk1) / WEEK)).padStart(2, "0")}`, start, end: start + WEEK };
}

/** The pool of [start, end): the credited hours whose start is inside, × bps / 260 (BigInt wei). */
export function poolOf(hours, start, end, bps = poolBps()) {
  let wei = 0n, credits = 0, n = 0;
  for (const [k, c] of Object.entries(hours || {})) {
    const hs = Date.parse(`${k}:00:00.000Z`);
    if (!(hs >= start && hs < end)) continue;
    wei += BigInt(c?.wei || 0); credits += c?.n || 0; n++;
  }
  return { creditedWei: wei, credits, hours: n, bps, poolWei: (wei * BigInt(Math.round(bps * 100))) / BigInt(CREATOR_BPS * 100) };
}

/** USD filled by a Hyperliquid order response (statuses: [{ filled: { totalSz, avgPx } }, { waitingForTrigger }, …]). */
export function filledUsd(statuses) {
  if (!Array.isArray(statuses)) return 0;
  let usd = 0;
  for (const s of statuses) { const f = s?.filled; if (f) usd += (Number(f.totalSz) || 0) * (Number(f.avgPx) || 0); }
  return usd;
}

// what the browser reports (POST /api/journal sets source "reported by app"): never proof of a trade by itself
const REPORTED = (src) => /^reported/i.test(String(src || ""));
const WEB_KINDS = /^(swap|swap\.sent|swap\.verified|swap\.web|web\.swap|web-swap|swap-sent)$/;
const OK_STATUS = /^(executed|confirmed|verified|ok|done|success)$/i;
/** A verified web swap record, in any of the shapes it may be written in (journal entry data, or a file row). */
export function webSwapOf(x) {
  if (!x || typeof x !== "object") return null;
  const hash = lc(x.hash || x.tx || x.txHash || "");
  const from = lc(x.from || x.address || x.owner || x.wallet || x.account || "");
  const t = Number(x.t || x.at || x.ts || x.time || x.verifiedAt || x.blockTime || 0);
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !isAddr(from) || !(t > 0)) return null;
  if (x.verified === false || (x.status && !OK_STATUS.test(String(x.status)))) return null;
  const tin = x.tokenIn ?? x.in ?? x.sellToken ?? x.from_token, tout = x.tokenOut ?? x.out ?? x.buyToken ?? x.to_token;
  const buy = NATIVE(tin) && !NATIVE(tout), sell = !NATIVE(tin) && NATIVE(tout);
  const usd = num(x.usd ?? x.valueUsd ?? x.amountUsd ?? x.usdValue ?? x.volumeUsd);
  const ethIn = num(x.ethIn ?? x.amountInEth ?? (NATIVE(tin) ? x.amountIn : null));
  const ethOut = num(x.ethOut ?? x.amountOutEth ?? (NATIVE(tout) ? x.amountOut : null));
  return { id: `ws:${hash}`, t: t < 1e12 ? t * 1000 : t, addr: from, src: "web", kind: "swap", hash, coin: buy ? coinKey(tout) : coinKey(tin), dir: buy ? "buy" : sell ? "sell" : null,
    usd, eth: ethIn || ethOut || null, token: !usd && !ethIn && !ethOut && !NATIVE(tin) ? tin : null, amount: !usd && !ethIn && !ethOut ? num(x.amountIn) : null };
}

/** One journal entry → a trade to value, or null. Nothing here is priced; valueOf() does that once. */
export function candidateOf(e) {
  if (!e || typeof e !== "object" || !isAddr(e.address) || !(e.t > 0) || e.source === "arena") return null;
  const d = e.data || {};
  const base = { id: String(e.id || `${e.t}:${e.kind}`), t: e.t, addr: lc(e.address), src: e.source || "app" };
  const m = /^agent-wallet\.(swap|perp|close|launch)$/.exec(e.kind || "");
  if (m) {
    if (e.status !== "executed" || REPORTED(e.source)) return null;
    const res = d.result || {};
    if (m[1] === "swap") {
      const p = d.params || {}, last = (res.steps || []).at(-1);
      if (!last?.hash || last.broadcast === false || last.status === "reverted") return null;
      const buy = NATIVE(p.tokenIn) && !NATIVE(p.tokenOut), sell = !NATIVE(p.tokenIn) && NATIVE(p.tokenOut);
      return { ...base, kind: p.initialBuy ? "first-buy" : "swap", hash: lc(last.hash), txStatus: last.status || null, coin: buy ? coinKey(p.tokenOut) : coinKey(p.tokenIn), dir: buy ? "buy" : sell ? "sell" : null,
        usd: num(d.usd), eth: NATIVE(p.tokenIn) ? num(p.amountIn) : null, token: NATIVE(p.tokenIn) ? null : p.tokenIn, amount: NATIVE(p.tokenIn) ? null : num(p.amountIn) };
    }
    if (m[1] === "perp" || m[1] === "close") {
      const usd = filledUsd(res.response);
      if (!(usd > 0)) return null;                         // resting, refused or not sent: nothing traded
      return { ...base, kind: m[1], hash: null, coin: `hl:${String(res.coin || d.params?.coin || "").toUpperCase()}`, dir: res.isBuy === true ? "buy" : res.isBuy === false ? "sell" : null, usd };
    }
    const fb = res.firstBuy;                               // launch: only the first buy is a trade (the Pons fee is not)
    if (!fb?.hash || !(Number(fb.eth) > 0) || /reverted|not-sent/.test(fb.status || "")) return null;
    return { ...base, id: `${base.id}:fb`, kind: "first-buy", hash: lc(fb.hash), txStatus: fb.status || null, coin: coinKey(res.token), dir: "buy", eth: Number(fb.eth) };
  }
  if (e.kind === "perp_order" && REPORTED(e.source)) {
    if (!d.coin || typeof d.coin !== "string") return null;
    return { ...base, src: "web", kind: "perp-web", hash: null, coin: `hl:${d.coin.toUpperCase()}`, hlCoin: d.coin, size: num(d.size), verify: "hl" };
  }
  if (WEB_KINDS.test(e.kind || "") && !REPORTED(e.source) && OK_STATUS.test(e.status || "")) {
    const w = webSwapOf({ ...d, hash: d.hash || d.tx, from: d.from || e.address, t: e.t });
    return w ? { ...w, id: String(e.id || w.id), src: e.source === "app" || !e.source ? "web" : e.source } : null;
  }
  return null;
}

/**
 * Valued trades → legs: the owner wallet (an Agent Wallet counts as its owner), and Hyperliquid fills checked for a web
 * perps ticket counted once even when two tickets saw the same fill.
 */
export function assemble(cands, vals, ownerOf = new Map()) {
  const out = [], tids = new Map();
  for (const c of [...cands].sort((a, b) => a.t - b.t)) {
    const v = vals[c.id];
    if (!v || !(v.usd > 0)) continue;
    const owner = ownerOf.get(c.addr) || c.addr;
    let usd = v.usd, dir = v.dir || c.dir || null;
    if (Array.isArray(v.fills)) {
      const seen = tids.get(owner) || tids.set(owner, new Set()).get(owner);
      const fresh = v.fills.filter((f) => !seen.has(String(f.tid)));
      fresh.forEach((f) => seen.add(String(f.tid)));
      usd = fresh.reduce((s, f) => s + f.usd, 0);
      const b = fresh.filter((f) => f.dir === "buy").reduce((s, f) => s + f.usd, 0);
      dir = b * 2 > usd ? "buy" : b * 2 < usd ? "sell" : null;
    }
    out.push({ id: c.id, t: c.t, owner, addr: c.addr, coin: v.coin || c.coin, dir, usd, hash: c.hash || null, kind: c.kind, src: c.src });
  }
  return out;
}

/**
 * The week's standings from its legs: in the window, $5 and up, not excluded, one count per hash (or entry); then the
 * round-trip guard (same coin, opposite sides, within 5 minutes: only the larger leg counts, a tie drops the later one), and
 * the cap (no wallet above capPct % of the total counted volume of all wallets, taken before the cap). Order: counted USD,
 * then who reached it first, then the address (a stable order for wallets tied at the cap).
 */
export function rankWeek(legs, { start = -Infinity, end = Infinity, minUsd = MIN_TRADE_USD, capPct = CAP_PCT, windowMs = ROUND_TRIP_MS, exclude = new Set() } = {}) {
  const seen = new Set(), by = new Map();
  for (const x of [...legs].sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)))) {
    if (!(x.t >= start && x.t < end) || !x.owner || exclude.has(x.owner) || exclude.has(x.addr) || !(x.usd >= minUsd)) continue;
    const k = x.hash ? `h:${x.hash}` : `i:${x.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (by.get(x.owner) || by.set(x.owner, []).get(x.owner)).push({ ...x, counted: x.usd, washed: false, paired: false });
  }
  for (const list of by.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.paired || !a.dir) continue;
      for (let j = i + 1; j < list.length && list[j].t - a.t <= windowMs; j++) {
        const b = list[j];
        if (b.paired || !b.dir || b.coin !== a.coin || b.dir === a.dir) continue;
        a.paired = b.paired = true;
        const small = a.usd >= b.usd ? b : a;
        small.counted = 0; small.washed = true;
        break;
      }
    }
  }
  const rows = [];
  for (const [owner, list] of by) {
    const raw = list.reduce((s, x) => s + x.counted, 0);
    if (!(raw > 0)) continue;
    rows.push({ owner, rawUsd: raw, trades: list.filter((x) => x.counted > 0).length, washed: list.filter((x) => x.washed).length, list });
  }
  const total = rows.reduce((s, r) => s + r.rawUsd, 0), cap = (total * capPct) / 100;
  for (const r of rows) {
    r.usd = Math.min(r.rawUsd, cap);
    r.capped = r.rawUsd > cap + 1e-9;
    let cum = 0;
    r.reachedAt = r.list.find((x) => (cum += x.counted) >= r.usd - 1e-9)?.t ?? r.list.at(-1).t;
    r.firstAt = r.list[0].t;
    delete r.list;
  }
  rows.sort((a, b) => b.usd - a.usd || a.reachedAt - b.reachedAt || (a.owner < b.owner ? -1 : 1));
  return { totalUsd: total, capUsd: cap, rows: rows.map((r, i) => ({ rank: i + 1, ...r })) };
}

/** The prizes of a pool (BigInt wei) for ranked rows: ranks with no trader and prizes under minSend stay with the owner. */
export function prizeItems(poolWei, rows, { split = SPLIT_PCT, minSendWei = weiOfEth(minSendEth()) } = {}) {
  const pool = BigInt(poolWei || 0), items = [];
  let dueWei = 0n;
  split.forEach((pct, i) => {
    const r = rows[i];
    if (!r) return;
    const wei = (pool * BigInt(Math.round(pct * 100))) / 10_000n;
    const small = wei < BigInt(minSendWei) || wei <= 0n;
    items.push({ rank: i + 1, to: r.owner, pct, wei: wei.toString(), eth: r6(ethOf(wei)), volumeUsd: r2(r.usd), status: small ? "too-small" : "due" });
    if (!small) dueWei += wei;
  });
  return { items, dueWei, ownerKeepsWei: pool - dueWei };
}

/* ---------------- what the server knows: credits, wallets, the journal ---------------- */

async function credits() {
  const [st, cr] = await Promise.all([store.readJson(START, null), store.readJson(CREDITS, {})]);
  const sb = Math.floor(Number(st?.startBlock)) > 0 ? Math.floor(Number(st.startBlock)) : DEFAULT_START_BLOCK;
  const same = cr && Number(cr.startBlock) === sb;            // feesplit.mjs starts over when the start block changes
  return { hours: same ? cr.hours || {} : {}, readUpTo: same ? Number(cr.cursorTime) || 0 : 0, startBlock: sb };
}

let walletMemo = null;
async function wallets() {
  if (walletMemo && Date.now() - walletMemo.at < 60_000) return walletMemo.v;
  const aw = await store.readJson("agentwallets.json", {});
  const ownerOf = new Map();
  for (const [owner, r] of Object.entries(aw.wallets || aw)) if (isAddr(owner) && isAddr(r?.address)) ownerOf.set(lc(r.address), lc(owner));
  const creator = await import("./flywheel.mjs").then((m) => lc(m.CREATOR)).catch(() => "");
  // the list stats.mjs leaves out of its user counts, plus the creator wallet and LEADERBOARD_EXCLUDE
  const exclude = new Set([...TEST_WALLETS, ...admins(), ...String(process.env.STATS_EXCLUDE || "").split(","), ...String(process.env.LEADERBOARD_EXCLUDE || "").split(","),
    process.env.ARENA_LIVE_OWNER || "", creator].map((a) => lc(a).trim()).filter(isAddr));
  for (const [a, o] of ownerOf) if (exclude.has(o)) exclude.add(a);
  walletMemo = { at: Date.now(), v: { ownerOf, exclude } };
  return walletMemo.v;
}

// The journal is read a slice at a time (only the new bytes on each pass), like herald.mjs: a long journal is read once
// per server start, then a few KB per pass. Only trades from the last three weeks are kept in memory.
const J = { pos: 0, list: [], ids: new Set() };
const QUICK = /"kind":"(agent-wallet\.(swap|perp|close|launch)|perp_order|swap[a-z.\-]*|web[.\-]swap)"/;
async function scanJournal() {
  const file = store.path("journal.jsonl");
  const st = await stat(file).catch(() => null);
  if (!st) return;
  if (st.size < J.pos) { J.pos = 0; J.list = []; J.ids.clear(); }   // rotated or truncated: start over
  const keepFrom = Math.min(fromTs(), weekAt(D.now()).start) - 2 * WEEK;
  for (let pass = 0; pass < 64 && J.pos < st.size; pass++) {
    const len = Math.min(st.size - J.pos, 16 << 20);
    const buf = Buffer.alloc(len);
    const fh = await open(file, "r");
    try { await fh.read(buf, 0, len, J.pos); } finally { await fh.close(); }
    const end = buf.lastIndexOf(10);
    if (end < 0) break;
    J.pos += end + 1;
    for (const line of buf.toString("utf8", 0, end).split("\n")) {
      if (!QUICK.test(line)) continue;
      try { const c = candidateOf(JSON.parse(line)); if (c && c.t >= keepFrom && !J.ids.has(c.id)) { J.ids.add(c.id); J.list.push(c); } } catch { /* a broken line is skipped */ }
    }
  }
  if (J.list.length && J.list[0].t < keepFrom) { J.list = J.list.filter((c) => c.t >= keepFrom); J.ids = new Set(J.list.map((c) => c.id)); }
}

// Swap page trades on Robinhood Chain, verified by the server: POST /api/swap/sent { hash } (robinhood.mjs → stakebonus.mjs
// recordWebSwap) books a trade in data/web-swaps.json { trades: [{ address, t, hash, usd, venue, at }] } only when the sender
// sent exactly the calldata Troya built for it, it succeeded and is recent; usd is the ETH or USDG side of the quote it was
// built from (0 for a coin-to-coin swap without one, so those do not reach the $5 floor). Read here, never written.
const WEB_FILE = "web-swaps.json";
async function webSwapCands() {
  const d = await store.readJson(WEB_FILE, null);
  const rows = Array.isArray(d) ? d : Array.isArray(d?.trades) ? d.trades : Array.isArray(d?.items) ? d.items : [];
  return rows.map(webSwapOf).filter(Boolean);
}
// which coin a web swap bought or sold, from its receipt: the one non-hub token that came to the sender (a buy) or left it
// (a sell); WETH and USDG are the money side (as robinhood.mjs ADDR). Unclear (both, or none) → no side, never paired.
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HUB = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);
export function sideOfReceipt(rc, sender) {
  const me = "0x" + lc(sender).replace(/^0x/, "").padStart(64, "0");
  const got = new Set(), gave = new Set();
  for (const l of rc?.logs || []) {
    const t = (l.topics || []).map(lc);
    if (t[0] !== T_TRANSFER || t.length < 3 || HUB.has(lc(l.address))) continue;
    if (t[2] === me) got.add(lc(l.address));
    if (t[1] === me) gave.add(lc(l.address));
  }
  if (got.size === 1 && !gave.size) return { coin: [...got][0], dir: "buy" };
  if (gave.size === 1 && !got.size) return { coin: [...gave][0], dir: "sell" };
  return null;
}

/* ---------------- valuing a trade, once ---------------- */

const hourMemo = new Map();
async function ethUsdAtDefault(t) {
  const { getEthUsd } = await import("./market.mjs");
  if (Date.now() - t < 20 * 60_000) return getEthUsd();
  const h0 = Math.floor(t / HOUR) * HOUR;
  if (hourMemo.has(h0)) return hourMemo.get(h0);
  const { hlInfo } = await import("./hl.mjs");
  const c = await hlInfo({ type: "candleSnapshot", req: { coin: "ETH", interval: "1h", startTime: h0, endTime: h0 + HOUR } }).catch(() => null);
  const k = Array.isArray(c) ? c.find((x) => Number(x.t) <= t && t < Number(x.T || x.t + HOUR)) || c[0] : null;
  const px = k ? (Number(k.o) + Number(k.c)) / 2 : null;
  if (px > 0) { hourMemo.set(h0, px); if (hourMemo.size > 800) hourMemo.delete(hourMemo.keys().next().value); return px; }
  return getEthUsd();
}
const D = {
  ethUsdAt: ethUsdAtDefault,
  // the token's USD price now and its address (a symbol is resolved the way the Agent Wallet resolves it)
  tokenUsd: async (ref) => { const t = await (await import("./tools.mjs")).resolveToken(ref); return { usd: num(t?.priceUsd), address: isAddr(t?.address) ? lc(t.address) : null }; },
  receipt: async (hash) => (await import("./robinhood.mjs")).rpc("robinhood", "eth_getTransactionReceipt", [hash]),
  hlFills: async (user, startTime, endTime) => (await import("./hl.mjs")).hlInfo({ type: "userFillsByTime", user, startTime, endTime, aggregateByTime: true }),
  ethUsdNow: async () => (await import("./market.mjs")).getEthUsd(),
  cardOf: async (a) => (await import("./profile.mjs")).cardOf(a),
  signer: async () => (await import("./flywheel-auto.mjs")).payoutSigner(),
  notify: async (text) => (await import("./community.mjs")).notifyAdmins?.(text),
  seal: async (...a) => (await import("./seal.mjs")).seal(...a),
  now: () => Date.now(),
  receiptMs: 120_000,                    // how long a sent prize's receipt is awaited before it is left to the next run
};

/** A trade's value, or undefined while it cannot be told yet (a pending transaction, a ticket's fills not settled). */
export async function valueOf(c, deps = D) {
  const now = deps.now();
  if (c.hash && c.txStatus && c.txStatus !== "confirmed") {
    const rc = await deps.receipt(c.hash).catch(() => undefined);
    if (rc === undefined) return undefined;
    if (!rc) return now - c.t > HOUR ? { usd: 0, how: "never mined" } : undefined;
    if (Number(rc.status) !== 1) return { usd: 0, how: "reverted" };
  }
  if (c.verify === "hl") {
    if (now - c.t < 90_000) return undefined;
    const fills = await deps.hlFills(c.addr, c.t - 180_000, c.t + 30_000).catch(() => null);
    if (!Array.isArray(fills)) return undefined;
    let left = c.size ? c.size * 1.02 : Infinity;
    const mine = [];
    for (const f of fills.filter((x) => String(x.coin).toUpperCase() === String(c.hlCoin).toUpperCase()).sort((a, b) => a.time - b.time)) {
      const sz = Math.min(Number(f.sz) || 0, left);
      if (!(sz > 0)) break;
      left -= sz;
      mine.push({ tid: String(f.tid ?? f.hash ?? `${f.time}:${f.px}`), usd: r2(sz * Number(f.px)), dir: f.side === "B" ? "buy" : "sell" });
    }
    return { usd: r2(mine.reduce((s, f) => s + f.usd, 0)), fills: mine, how: "hyperliquid fills" };
  }
  // a web swap's record has no coin or side: read from its receipt once, for the round-trip guard
  let side = {};
  if (c.src === "web" && c.kind === "swap" && !c.dir && c.hash) {
    const rc = await deps.receipt(c.hash).catch(() => undefined);
    if (rc === undefined) return undefined;
    side = (rc && sideOfReceipt(rc, c.addr)) || {};
  }
  if (c.usd > 0) return { usd: r2(c.usd), ...side, how: "logged" };
  if (c.eth > 0) { const px = await deps.ethUsdAt(c.t).catch(() => null); return px > 0 ? { usd: r2(c.eth * px), ethUsd: r2(px), how: "eth × hour price" } : undefined; }
  if (c.token && c.amount > 0) {
    const p = await deps.tokenUsd(c.token).catch(() => undefined);
    if (p === undefined) return undefined;
    return p?.usd > 0 ? { usd: r2(c.amount * p.usd), coin: p.address || undefined, how: "token price when read" } : { usd: 0, how: "no price" };
  }
  return { usd: 0, how: "no amount" };
}

// valuations are kept for 5 weeks; at most 80 new ones per pass (prices and receipts are API calls)
async function valuate(cands) {
  const cache = await store.readJson(VALS, { v: {} });
  const vals = cache.v || {};
  const todo = cands.filter((c) => !vals[c.id]);
  let pending = 0, fresh = 0;
  for (let i = 0; i < todo.length; i += 8) {
    if (fresh >= 80) { pending += todo.length - i; break; }
    const part = todo.slice(i, i + 8);
    const got = await Promise.all(part.map((c) => valueOf(c, D).catch(() => undefined)));
    part.forEach((c, j) => { if (got[j]) { vals[c.id] = { ...got[j], at: D.now(), t: c.t }; fresh++; } else pending++; });
  }
  if (fresh) {
    await store.update(VALS, { v: {} }, (x) => {
      x.v = { ...(x.v || {}), ...Object.fromEntries(todo.filter((c) => vals[c.id]).map((c) => [c.id, vals[c.id]])) };
      const cut = D.now() - 5 * WEEK;
      for (const [k, v] of Object.entries(x.v)) if ((v.t || v.at || 0) < cut) delete x.v[k];
      return x;
    });
  }
  return { vals, pending };
}

/* ---------------- standings ---------------- */

const memo = new Map();
async function standingsFor(w, { fresh = false } = {}) {
  const hit = memo.get(w.key), ttl = w.end <= D.now() ? 10 * 60_000 : 60_000;
  if (!fresh && hit && D.now() - hit.at < ttl) return hit.v;
  await scanJournal();
  const cands = [...J.list, ...(await webSwapCands())].filter((c) => c.t >= w.start && c.t < w.end);
  const { vals, pending } = await valuate(cands);
  const { ownerOf, exclude } = await wallets();
  const r = rankWeek(assemble(cands, vals, ownerOf), { start: w.start, end: w.end, exclude });
  const cr = await credits();
  const pool = poolOf(cr.hours, w.start, w.end);
  const v = { week: w, ...r, pool, readUpTo: cr.readUpTo, pending };
  memo.set(w.key, { at: D.now(), v });
  if (memo.size > 6) memo.delete(memo.keys().next().value);
  return v;
}

const nameOf = async (a) => { const c = await D.cardOf(a).catch(() => null); return c?.username || null; };
const pubItem = async (x) => ({ rank: x.rank, pct: x.pct, name: await nameOf(x.to), trader: short(x.to), eth: x.eth, volumeUsd: x.volumeUsd, status: x.status, hash: x.status === "paid" || x.status === "failed" ? x.hash || null : null,
  txUrl: x.status === "paid" && x.hash ? EXPLORER + x.hash : null, seal: x.seal || null });
async function pubWeek(rec) {
  if (!rec) return null;
  return { key: rec.key, start: rec.start, end: rec.end, status: rec.status, mode: rec.mode, at: rec.at || null, poolEth: rec.poolEth, creditedEth: rec.creditedEth, volumeBps: rec.volumeBps, totalUsd: rec.totalUsd,
    traders: rec.traders ?? null, ownerKeepsEth: rec.ownerKeepsEth, paidEth: r6((rec.items || []).filter((x) => x.status === "paid").reduce((s, x) => s + ethOf(x.wei), 0)),
    note: rec.note || null, items: await Promise.all((rec.items || []).map(pubItem)) };
}

export const RULES = () => [
  `The pool is ${poolBps() / 100}% of all $TROYA trading volume in the week (Monday 00:00 to Monday 00:00 UTC). The $TROYA creator wallet earns 2.6% of every $TROYA trade, so the pool is ${poolBps()}/260 of the creator fees that come in that week, and it grows as people trade.`,
  "Ranked by the dollar value of your trades made through Troya that week: web Swap, Agent Wallet swaps and perps (including Telegram and X trades), perps tickets on the Perps page, and the first buy of a coin you launch through Troya.",
  `Only trades of $${MIN_TRADE_USD} or more count. Your wallet and your Agent Wallet count as one trader.`,
  "A quick round trip (buying and selling the same coin within 5 minutes) counts only its larger side, and no wallet counts for more than 40% of the week's total.",
  `The top 10 share the pool: ${SPLIT_PCT.map((p) => `${p}%`).join(", ")}. Prizes are paid in ETH on Robinhood Chain from the creator wallet every Monday, after the Herald payouts.`,
  `With fewer than 10 traders the unused shares stay with the team, as does any prize under ${minSendEth()} ETH. Team, admin, test and Arena wallets are not ranked.`,
  "Prizes depend on trading volume and are not a promised reward.",
];

let viewMemo = null;
async function view(me) {
  const now = D.now(), w = weekAt(now), prev = weekAt(now - WEEK), mode = modeOf();
  if (!viewMemo || now - viewMemo.at > 30_000) {
    const cur = await standingsFor(w);
    const ethUsd = await D.ethUsdNow().catch(() => null);
    const led = await store.readJson(FILE, DEF);
    const rec = led.weeks?.[prev.key];
    let last = null;
    if (prev.start >= fromTs()) {
      if (rec) last = await pubWeek(rec);
      else {
        const p = await standingsFor(prev);
        const plan = prizeItems(p.pool.poolWei, p.rows);
        last = { ...(await pubWeek({ key: prev.key, start: prev.start, end: prev.end, status: "pending", mode, poolEth: r6(ethOf(p.pool.poolWei)), creditedEth: r6(ethOf(p.pool.creditedWei)), volumeBps: p.pool.bps, totalUsd: r2(p.totalUsd), traders: p.rows.length, ownerKeepsEth: r6(ethOf(plan.ownerKeepsWei)), items: plan.items })),
          note: mode === "off" ? "Prize payouts are off." : "Paid on Monday after 01:00 UTC, after the Herald payouts." };
      }
    }
    const history = await Promise.all(Object.values(led.weeks || {}).sort((a, b) => b.start - a.start).slice(0, 8).map(async (x) => ({ key: x.key, status: x.status, poolEth: x.poolEth, traders: x.traders ?? null,
      paidEth: r6((x.items || []).filter((i) => i.status === "paid").reduce((s, i) => s + ethOf(i.wei), 0)), winner: x.items?.[0] ? (await nameOf(x.items[0].to)) || short(x.items[0].to) : null })));
    const poolEth = ethOf(cur.pool.poolWei), plan = prizeItems(cur.pool.poolWei, cur.rows);
    const rows = await Promise.all(cur.rows.slice(0, 50).map(async (r, i) => ({ rank: r.rank, owner: r.owner, name: await nameOf(r.owner), trader: short(r.owner), usd: r2(r.usd), trades: r.trades, capped: r.capped, washed: r.washed,
      prizePct: SPLIT_PCT[i] ?? null, prizeEth: plan.items[i] ? plan.items[i].eth : null, prizeUsd: plan.items[i] && ethUsd ? r2(plan.items[i].eth * ethUsd) : null, tooSmall: plan.items[i]?.status === "too-small" })));
    const warmup = w.start < fromTs();
    viewMemo = { at: now, v: {
      name: "Weekly prize pool", mode,
      week: { key: w.key, start: w.start, end: w.end, endsIn: Math.max(0, w.end - now), warmup, firstWeekStart: fromTs(), firstPayoutAt: fromTs() + WEEK + HOUR },
      pool: { eth: r6(poolEth), usd: ethUsd ? r2(poolEth * ethUsd) : null, creditedEth: r6(ethOf(cur.pool.creditedWei)), credits: cur.pool.credits, volumeBps: cur.pool.bps, pctOfVolume: cur.pool.bps / 100, readUpTo: cur.readUpTo || null,
        line: `${warmup ? "Warm-up week pool (not paid)" : "This week's prize pool"}: ${r6(poolEth)} ETH (${cur.pool.bps / 100}% of $TROYA volume)` },
      split: SPLIT_PCT, minTradeUsd: MIN_TRADE_USD, capPct: CAP_PCT, roundTripMinutes: ROUND_TRIP_MS / 60_000, minSendEth: minSendEth(),
      totals: { traders: cur.rows.length, usd: r2(cur.rows.reduce((s, r) => s + r.usd, 0)), pending: cur.pending },
      rows, lastWeek: last, history, rules: RULES(),
      status: mode === "live" ? "Prizes are paid every Monday." : mode === "dry" ? `Test mode: the standings and prizes are worked out but not sent yet. The first payout is planned for Monday ${new Date(fromTs() + WEEK).toUTCString().slice(5, 11)}.` : "Prize payouts are off right now; the standings still count.",
      botLine: botLine({ mode, poolEth, bps: cur.pool.bps, warmup }),
    } };
  }
  const v = viewMemo.v, m = lc(me);
  const mine = m ? v.rows.find((r) => r.owner === m) : null;
  let meRow = mine ? { rank: mine.rank, usd: mine.usd, trades: mine.trades } : null;
  if (m && !mine) {
    const om = (await wallets()).ownerOf.get(m) || m;          // signed in as an Agent Wallet: its owner's row
    const r = (await standingsFor(weekAt(now))).rows.find((x) => x.owner === om);
    if (r) meRow = { rank: r.rank, usd: r2(r.usd), trades: r.trades };
  }
  return { ...v, rows: v.rows.slice(0, 25).map(({ owner, ...r }) => ({ ...r, mine: !!m && owner === m })), me: meRow };
}

/** One sentence for the bots (botfacts.mjs reads it from GET /api/leaderboard/prizes), true to the mode. */
export function botLine({ mode = modeOf(), poolEth = null, bps = poolBps(), warmup = false } = {}) {
  const first = new Date(fromTs() + WEEK).toUTCString().slice(5, 16);
  const how = `${bps / 100}% of all $TROYA trading volume each week (Monday 00:00 to Monday 00:00 UTC) is a prize pool for the 10 wallets with the most trading volume made through Troya (web Swap, Agent Wallet swaps and perps, Telegram and X trades, Perps page tickets, launch first buys), split ${SPLIT_PCT.join("/")}%, paid in ETH on Robinhood Chain every Monday. Trades under $${MIN_TRADE_USD} do not count, a round trip of the same coin within 5 minutes counts once, no wallet counts for more than ${CAP_PCT}% of the week's volume, and team wallets are left out. It depends on volume and is not a promised reward.`;
  const pool = poolEth != null ? ` ${warmup ? "Warm-up pool so far (not paid)" : "This week's pool so far"}: ${r6(poolEth)} ETH.` : "";
  if (mode === "off") return `Weekly prize pool (troya.codes/agent#/leaderboard): paused right now; the leaderboard still shows volume standings. When on: ${how}`;
  if (mode === "dry") return `Weekly prize pool (troya.codes/agent#/leaderboard), being tested: the standings are live but no prize has been paid yet; the first payout is planned for ${first}, once the team switches payouts on. ${how}${pool}`;
  return `Weekly prize pool (troya.codes/agent#/leaderboard): ${how}${pool}`;
}

/** For GET /api/leaderboard and the Desk: whether the leaderboard has something to show besides Autopilot rows. */
export function hint() {
  if (!store || modeOf() === "off") return null;
  const v = viewMemo?.v;
  return { show: true, poolEth: v?.pool?.eth ?? null, traders: v?.totals?.traders ?? null };
}

/** Telegram /leaderboard: the pool and the top 5, in the bot's HTML. */
export async function prizeText() {
  if (!store) return "";
  const v = await view(null);
  const L = [`<b>${v.pool.line}</b>`, `Week ${v.week.key}, ends ${new Date(v.week.end).toUTCString().slice(0, 16)} 00:00 UTC.`];
  if (!v.rows.length) L.push("No trades counted yet this week. Trade through Troya (Swap, the Agent Wallet, Telegram, X, Perps) to enter.");
  for (const r of v.rows.slice(0, 5)) L.push(`${r.rank}. ${r.name ? `@${r.name}` : `<code>${r.trader}</code>`} · $${Math.round(r.usd).toLocaleString("en-US")}${r.prizeEth ? ` · ≈ ${r.prizeEth} ETH (${r.prizePct}%)` : ""}`);
  if (v.mode !== "live") L.push(v.status);
  L.push("Rules and last week's winners: troya.codes/agent#/leaderboard");
  return L.join("\n");
}

/* ---------------- paying a week ---------------- */

const saveWeek = (rec) => store.update(FILE, DEF, (x) => { x.weeks ||= {}; if (x.weeks[rec.key]?.status !== "paid" || rec.status === "paid") x.weeks[rec.key] = structuredClone(rec); return x; });
async function tellOnce(key, text) {
  let fresh = false;
  await store.update(FILE, DEF, (x) => { x.told ||= {}; if (!x.told[key]) { x.told[key] = D.now(); fresh = true; const ks = Object.keys(x.told).sort((a, b) => x.told[a] - x.told[b]); for (const k of ks.slice(0, Math.max(0, ks.length - 100))) delete x.told[k]; } return x; });
  if (fresh) await D.notify(text).catch(() => {});
}
const lineOf = (x) => `#${x.rank} ${short(x.to)} ${x.pct}%: ${x.eth} ETH${x.status === "too-small" ? " (under the smallest send, stays with the team)" : x.hash ? ` ${EXPLORER}${x.hash}` : ""}${x.status === "failed" ? " FAILED" : ""}${x.error ? ` (${String(x.error).slice(0, 120)})` : ""}`;

/** Sign, write "sending" with the hash, then broadcast: a crash leaves a hash to settle, never a second payment.
 *  false when the broadcast failed: the run stops there (the next prize would take the same nonce) and recover() decides. */
// a mined transfer is one with a receipt: polled, never waited for by block number (a cached or idle block number left
// ethers' waitForTransaction(hash, 1) hanging until its timeout on an anvil fork)
async function receiptOf(p, hash, ms) {
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 1000))) {
    const rc = await p.getTransactionReceipt(hash).catch(() => null);
    if (rc || Date.now() > until) return rc || null;
  }
}
const NEXT_NONCE = new Map();   // the creator wallet → { n: the next nonce this module uses, at }; trusted for 2 minutes
async function payOne(rec, x, w) {
  const p = w.provider, a = lc(w.address);
  // read straight from the node and counted here: ethers caches an identical getTransactionCount for 250 ms, so the next
  // prize could reuse the nonce of the one just sent (as agentwallet.mjs found)
  let nonce, raw;
  try {
    const onChain = Number(BigInt(await p.send("eth_getTransactionCount", [w.address, "pending"])));
    const mine = NEXT_NONCE.get(a);
    nonce = Math.max(onChain, mine && Date.now() - mine.at < 120_000 ? mine.n : 0);
    NEXT_NONCE.set(a, { n: nonce + 1, at: Date.now() });
    raw = await w.signTransaction(await w.populateTransaction({ to: x.to, value: BigInt(x.wei), nonce }));
  } catch (e) { NEXT_NONCE.delete(a); throw e; }
  const { Transaction } = await import("ethers");
  const hash = Transaction.from(raw).hash;
  x.attempts = [...(x.attempts || []), { hash, nonce, at: D.now() }].slice(-5);
  Object.assign(x, { status: "sending", hash, nonce, raw, sentAt: D.now(), dropSeenAt: null });
  delete x.error;
  await saveWeek(rec);
  try { await p.broadcastTransaction(raw); }
  catch (e) {
    const m = String(e.shortMessage || e.message || e);
    NEXT_NONCE.delete(a);
    // a transaction signed a moment ago and refused for its nonce was never mined (another one holds that nonce, mined or
    // pending: the flywheel, the fee split and the stake bonus send from the same creator wallet): sign again
    if (/nonce (too low|has already been used)|nonce.*already.*used|NONCE_EXPIRED|replacement (transaction )?underpriced|REPLACEMENT_UNDERPRICED/i.test(m)) {
      Object.assign(x, { status: "due", hash: null, nonce: null, raw: null, error: `Refused (${m.slice(0, 120)}); signed again.` });
      await saveWeek(rec);
      return "retry";
    }
    if (!/already known|known transaction|already imported/i.test(m)) { x.error = m.slice(0, 200); await saveWeek(rec); return false; }
  }
  const rc = await receiptOf(p, hash, D.receiptMs);
  if (rc) settle(rec, x, rc);
  await saveWeek(rec);
  return true;
}
function settle(rec, x, rc) {
  x.status = Number(rc.status) === 1 ? "paid" : "failed";
  x.block = Number(rc.blockNumber) || null; x.paidAt = D.now();
  delete x.raw;
  if (x.status === "paid") D.seal("leaderboard-prize", x.to, { week: rec.key, rank: x.rank, pct: x.pct, eth: x.eth, hash: x.hash }, `Weekly prize ${rec.key} #${x.rank}: ${x.eth} ETH to ${short(x.to)}`).then((s) => { x.seal = s?.hash || null; }).catch(() => {});
}
/** A "sending" prize after a crash or a failed broadcast: settled from its receipt, sent again as the same signed
 *  transaction, or (its nonce used by another transaction, seen twice 15 minutes apart) put back to be signed again. */
async function recover(rec, w) {
  const p = w.provider;
  for (const x of rec.items.filter((i) => i.status === "sending")) {
    let rc;
    try { rc = await p.getTransactionReceipt(x.hash); } catch { continue; }
    if (rc) { settle(rec, x, rc); continue; }
    const known = await p.getTransaction(x.hash).catch(() => undefined);
    const latest = await p.getTransactionCount(w.address, "latest").catch(() => null);
    if (latest == null || known === undefined) continue;
    if (latest > x.nonce && !known) {
      if (!x.dropSeenAt) { x.dropSeenAt = D.now(); continue; }
      if (D.now() - x.dropSeenAt < 15 * 60_000) continue;
      Object.assign(x, { status: "due", dropped: (x.dropped || 0) + 1, hash: null, nonce: null, raw: null, dropSeenAt: null, error: "Not mined: its nonce went to another transaction. Signed again." });
      continue;
    }
    x.dropSeenAt = null;
    if (x.raw) await p.broadcastTransaction(x.raw).catch(() => {});
    const rc2 = await receiptOf(p, x.hash, Math.min(60_000, D.receiptMs));
    if (rc2) settle(rec, x, rc2);
  }
  await saveWeek(rec);
}
const statusOf = (items) => (items.some((x) => x.status === "sending" || x.status === "due") ? "paying" : items.some((x) => x.status === "failed") ? "partial" : "paid");

let busy = false;
/**
 * The last closed week (or `now`'s previous week): worked out once its creator fees are read through its end, then recorded
 * (dry) or frozen and paid (live). A paid week is never paid again; a dry record is worked out again by a later run.
 */
export async function weeklyRun({ reason = "schedule", dry = false, deps = {} } = {}) {
  const mode = modeOf();
  if (mode === "off") return { mode, note: "Prize payouts are off (LEADERBOARD_PRIZES=off)." };
  if (busy) return { mode, busy: true, note: "A prize run is already going." };
  busy = true;
  const signerOf = deps.signer ? async () => deps.signer : D.signer;
  try {
    const now = D.now(), w = weekAt(now - WEEK);
    if (w.start < fromTs()) return { mode, skipped: true, note: `Week ${w.key} started before the prize pool began, so it is not paid.` };
    const led = await store.readJson(FILE, DEF);
    let rec = led.weeks?.[w.key];
    if (rec && (rec.status === "paid" || rec.status === "partial")) return { mode, already: true, week: await pubWeek(rec) };
    const live = mode === "live" && !dry;
    if (!rec || !rec.frozen) {
      const cr = await credits();
      if (!(cr.readUpTo >= w.end)) {
        if (now > w.end + 6 * HOUR) await tellOnce(`${w.key}:credits`, `<b>Weekly prizes waiting</b>, week ${w.key}: the creator fees are read only up to ${cr.readUpTo ? new Date(cr.readUpTo).toISOString().slice(0, 16) : "nothing yet"} UTC, so the pool is not final. It runs as soon as they are.`);
        return { mode, waiting: true, note: "The creator fees are not read through the end of the week yet." };
      }
      const st = await standingsFor(w, { fresh: true });
      if (st.pending && now < w.end + 6 * HOUR) return { mode, waiting: true, note: `${st.pending} trade${st.pending > 1 ? "s" : ""} of that week cannot be valued yet.` };
      const plan = prizeItems(st.pool.poolWei, st.rows);
      const ethUsd = await D.ethUsdNow().catch(() => null);
      rec = { key: w.key, start: w.start, end: w.end, mode: live ? "live" : "dry", status: live ? "paying" : "dry", frozen: live, at: now, reason,
        creditedEth: r6(ethOf(st.pool.creditedWei)), credits: st.pool.credits, volumeBps: st.pool.bps, poolWei: st.pool.poolWei.toString(), poolEth: r6(ethOf(st.pool.poolWei)),
        totalUsd: r2(st.totalUsd), capUsd: r2(st.capUsd), traders: st.rows.length, ethUsd, unvalued: st.pending || 0,
        standings: st.rows.slice(0, 25).map((r) => ({ rank: r.rank, owner: r.owner, usd: r2(r.usd), rawUsd: r2(r.rawUsd), trades: r.trades, washed: r.washed, capped: r.capped })),
        items: plan.items, dueWei: plan.dueWei.toString(), ownerKeepsWei: plan.ownerKeepsWei.toString(), ownerKeepsEth: r6(ethOf(plan.ownerKeepsWei)),
        note: !plan.items.length ? "Nobody traded $5 or more through Troya that week." : null };
      if (live && !plan.items.some((x) => x.status === "due")) rec.status = "paid";        // nothing to send: closed as paid
      await saveWeek(rec);                                                                // frozen on disk before any transfer
      if (!live || rec.status === "paid") {
        await tellOnce(`${w.key}:${rec.status}:${rec.mode}`, `<b>Weekly prizes ${rec.status === "dry" ? "(dry run, nothing sent)" : "closed"}</b>, week ${w.key}\nCreator fees credited: ${rec.creditedEth} ETH → pool ${rec.poolEth} ETH (${rec.volumeBps / 100}% of volume). ${rec.traders} trader${rec.traders === 1 ? "" : "s"}, $${rec.totalUsd} counted. The team keeps ${rec.ownerKeepsEth} ETH.\n${rec.items.map(lineOf).join("\n") || rec.note}`);
        return { mode, week: await pubWeek(rec) };
      }
    }
    // a week frozen by a live run is only ever finished by a live run (a dry run never touches its transfers)
    if (!live) return { mode, frozen: true, note: "This week's prizes are frozen for payment; they are paid by a live run.", week: await pubWeek(rec) };
    const signer = await signerOf();
    if (!signer) throw new Error("The creator wallet key is not stored on the server, so no prize can be paid automatically.");
    await recover(rec, signer);
    const due = rec.items.filter((x) => x.status === "due");
    if (due.length) {
      const total = due.reduce((s, x) => s + BigInt(x.wei), 0n);
      const fee = await signer.provider.getFeeData().catch(() => ({}));
      const gas = 21_000n * 2n * BigInt(due.length) * BigInt(fee.maxFeePerGas || fee.gasPrice || 1_000_000_000n);
      const bal = await signer.provider.getBalance(signer.address);
      if (bal - total - gas < weiOfEth(reserveEth())) {
        rec.status = "waiting"; rec.waitNote = `The creator wallet holds ${r6(ethOf(bal))} ETH; paying ${r6(ethOf(total))} ETH would leave less than the ${reserveEth()} ETH gas reserve.`;
        await saveWeek(rec);
        await tellOnce(`${w.key}:reserve`, `<b>Weekly prizes waiting</b>, week ${w.key}: ${rec.waitNote} Checked again every hour.`);
        return { mode, waiting: true, note: rec.waitNote, week: await pubWeek(rec) };
      }
      delete rec.waitNote;
      for (const x of due) {
        try {
          let r = await payOne(rec, x, signer);
          if (r === "retry") r = await payOne(rec, x, signer);
          if (r !== true) break;
        }
        catch (e) {
          x.error = String(e.shortMessage || e.message).slice(0, 200);
          await saveWeek(rec);
          // not signed or not written: nothing went out; the rest waits for the next hour
          if (x.status === "due") { await tellOnce(`${w.key}:send:${x.rank}`, `<b>Weekly prizes paused</b>, week ${w.key}: prize #${x.rank} could not be sent (${x.error}). Tried again every hour.`); break; }
        }
      }
    }
    rec.status = statusOf(rec.items);
    await saveWeek(rec);
    if (rec.status !== "paying") await tellOnce(`${w.key}:${rec.status}:live`, `<b>Weekly prizes ${rec.status}</b>, week ${w.key}\nPool ${rec.poolEth} ETH (${rec.volumeBps / 100}% of volume, from ${rec.creditedEth} ETH of creator fees). The team keeps ${rec.ownerKeepsEth} ETH.\n${rec.items.map(lineOf).join("\n")}`);
    return { mode, week: await pubWeek(rec) };
  } finally { busy = false; viewMemo = null; }
}

// Monday: from 01:00 UTC once Herald has recorded the week (or Herald is off), from 03:00 UTC regardless; then every hour
// until the week is closed (a wait for the creator fees, the reserve or a transaction in flight is retried).
async function tick({ afterHerald = false } = {}) {
  if (!store || modeOf() === "off") return;
  const now = D.now(), w = weekAt(now - WEEK);
  if (w.start < fromTs() || now < w.end + HOUR) return;
  const rec = (await store.readJson(FILE, DEF)).weeks?.[w.key];
  if (rec && (rec.status === "paid" || rec.status === "partial" || (rec.status === "dry" && modeOf() === "dry"))) return;
  if (!afterHerald && now < w.end + 3 * HOUR) {
    const herald = await store.readJson("payouts.json", {});
    if (!herald.weeks?.[w.key] && process.env.HERALD_PAYOUTS !== "off") return;
  }
  const out = await weeklyRun({ reason: afterHerald ? "after herald" : "schedule" }).catch(async (e) => {
    console.warn("[prizes]", e.message);
    await tellOnce(`${w.key}:error:${String(e.message).slice(0, 40)}`, `<b>Weekly prizes stopped</b>, week ${w.key}: ${e.message}`);
    return null;
  });
  return out;
}
/** payouts.mjs calls this when its weekly Herald run ends (whatever it did): the prizes go right after it. */
export function afterHerald() { return tick({ afterHerald: true }).catch((e) => console.warn("[prizes]", e.message)); }

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => { standingsFor(weekAt(D.now())).catch(() => {}); tick().catch(() => {}); }, 180_000).unref?.();
  // every 10 minutes the week's new trades are read and valued, so each value is stamped close to its trade
  setInterval(() => standingsFor(weekAt(D.now()), { fresh: true }).catch((e) => console.warn("[prizes] standings:", e.message)), 10 * 60_000).unref?.();
  setInterval(() => tick().catch(() => {}), HOUR).unref?.();
  r.get("/api/leaderboard/prizes", async ({ req }) => view(getSession(req)?.address || null), { weight: 1, perMin: 60 });
  r.post("/api/leaderboard/prizes/run", async ({ req, body }) => {
    const s = getSession(req);
    if (!s || !admins().includes(lc(s.address))) throw new HttpError(403, "Admins only.");
    return weeklyRun({ reason: "admin", dry: body?.dry !== false });
  });
}

export const _test = {
  setStore: (st) => { store = st; memo.clear(); viewMemo = null; walletMemo = null; J.pos = 0; J.list = []; J.ids.clear(); },
  setDeps: (d) => Object.assign(D, d), deps: D, standingsFor, view, tick, recover, payOne, statusOf,
};
