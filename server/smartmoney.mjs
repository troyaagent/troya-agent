// V7 F37 Robinhood Radar, part 2: smart money on chain 4663, scored on The Record. Every coin Troya Sentry called is graded
// after the fact (did it reach 2x its call price, or never even 1.3x). For each graded coin Aegis-style log reads find the
// wallets that bought in its first 15 minutes; a wallet that keeps showing up early in the winners and rarely in the losers
// is "smart". Sniper bots that buy everything land near the base rate and drop out; devs and the coin's fee wallet are left out.
// Ranking uses the Wilson lower bound of the win rate, so three lucky buys do not beat thirty good ones.
//   GET /api/radar/smart            the smart-wallet board (addresses shortened), base rate and how it is scored
//   GET /api/radar/smart/:token     which smart wallets bought this coin in its first 15 minutes
import { getAddress, isAddress, id as keccakId } from "ethers";
import { HttpError } from "./api.mjs";

const FILE = "smartmoney.json";
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const WINDOW_S = 15 * 60;
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
let store = null, busy = false, R = null, rate = null, board = null;
const coinMemo = new Map();

async function chain() { return (R ||= await import("./robinhood.mjs")); }

/** blocks per second, measured over the last ~100k blocks (Robinhood Chain makes about 10 a second) */
async function blockRate() {
  if (rate && Date.now() - rate.at < 6 * 3600_000) return rate;
  const { rpc } = await chain();
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const [a, b] = await Promise.all([rpc("robinhood", "eth_getBlockByNumber", [hex(head), false]), rpc("robinhood", "eth_getBlockByNumber", [hex(head - 100_000), false])]);
  const perS = 100_000 / Math.max(1, Number(BigInt(a.timestamp)) - Number(BigInt(b.timestamp)));
  rate = { at: Date.now(), head, headTs: Number(BigInt(a.timestamp)), perS };
  return rate;
}
const blockAt = (r, tsMs) => Math.max(1, Math.round(r.head - (r.headTs - tsMs / 1000) * r.perS));

/** the wallets that bought `token` from a venue in a window of blocks, and the dev side to leave out */
async function earlyBuyers(token, fromBlock, toBlock) {
  const { rpc, ponsState, ADDR, CHAINS } = await chain();
  const ps = await ponsState(token).catch(() => null);
  const venues = new Set([lc(ADDR.poolManager), lc(ADDR.universalRouter), lc(ADDR.swapRouter02), "0x204faca1764b154221e35c0d20abb3c525710498", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", ps?.curve && lc(ps.curve)].filter(Boolean));
  const devs = new Set([ps?.deployer, ps?.creatorFeeRecipient].filter(Boolean).map(lc));
  const q = [{ address: token, topics: [T_TRANSFER], fromBlock: hex(fromBlock), toBlock: hex(toBlock) }];
  const logs = await rpc("robinhood", "eth_getLogs", q, { timeoutMs: 20_000 }).catch(() => rpc("robinhood", "eth_getLogs", q, { timeoutMs: 25_000, only: CHAINS.robinhood.upstreams[0] }));
  const buyers = new Map();
  let firstBlock = null;
  for (const l of logs || []) {
    const from = "0x" + l.topics[1].slice(26), to = "0x" + l.topics[2].slice(26);
    const bn = Number(BigInt(l.blockNumber));
    if (firstBlock == null) firstBlock = bn;
    if (!venues.has(from) || venues.has(to) || devs.has(to) || /^0x0{40}$/.test(to)) continue;
    if (!buyers.has(to)) buyers.set(to, bn);
  }
  return { buyers, devs, firstBlock, pons: !!ps };
}

const wilson = (w, n, z = 1.64) => (n ? (w / n + (z * z) / (2 * n) - z * Math.sqrt((w / n) * (1 - w / n) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n) : 0);

/** one pass: read the early buyers of every graded call not read yet, then score the wallets */
async function build({ max = 40 } = {}) {
  if (busy || !store) return;
  busy = true;
  try {
    const rec = await store.readJson("record.json", {});
    const calls = Object.values(rec.calls || {}).filter((c) => c.p0 > 0 && c.peak > 0 && c.status === "graded" && c.token && c.source !== "x");
    const d = await store.readJson(FILE, {});
    d.coins ||= {};
    const r = await blockRate();
    let done = 0;
    for (const c of calls) {
      const t = lc(c.token);
      const outcome = c.peak >= 2 * c.p0 ? "win" : c.peak < 1.3 * c.p0 ? "loss" : "flat";
      if (d.coins[t]) { d.coins[t].outcome = outcome; continue; }
      if (done >= max) continue;
      done++;
      // the call comes ~90 s after launch: read from 5 minutes before it to 15 minutes after the first transfer
      const callB = blockAt(r, c.at);
      const from = Math.max(1, callB - Math.round(300 * r.perS)), to = Math.min(r.head, callB + Math.round(WINDOW_S * r.perS));
      try {
        const e = await earlyBuyers(t, from, to);
        d.coins[t] = { symbol: c.symbol, outcome, at: c.at, buyers: [...e.buyers.keys()].slice(0, 400), pons: e.pons };
      } catch (err) { console.warn("[smart]", c.symbol, err.message); done--; break; }
    }
    // score
    const W = new Map();
    for (const [t, x] of Object.entries(d.coins)) {
      if (x.outcome === "flat") continue;
      for (const w of x.buyers || []) {
        const s = W.get(w) || { wins: 0, losses: 0, coins: [] };
        if (x.outcome === "win") s.wins++; else s.losses++;
        s.coins.push({ t, s: x.symbol, o: x.outcome, at: x.at });
        W.set(w, s);
      }
    }
    const graded = Object.values(d.coins).filter((x) => x.outcome !== "flat");
    const base = graded.length ? graded.filter((x) => x.outcome === "win").length / graded.length : 0;
    const rows = [...W.entries()].map(([w, s]) => ({ wallet: w, wins: s.wins, losses: s.losses, n: s.wins + s.losses, rate: s.wins / (s.wins + s.losses), score: wilson(s.wins, s.wins + s.losses), last: Math.max(...s.coins.map((x) => x.at)), recent: s.coins.sort((a, b) => b.at - a.at).slice(0, 5) }))
      .filter((x) => x.wins >= 3 && x.score > base).sort((a, b) => b.score - a.score).slice(0, 100);
    // wallets that bought exactly the same coins are most likely one trader or one group: mark them as a cluster
    const sig = new Map();
    for (const x of rows) { const k = [...new Set(W.get(x.wallet).coins.map((c) => c.t))].sort().join(","); x.sig = k; sig.set(k, (sig.get(k) || 0) + 1); }
    for (const x of rows) { x.cluster = sig.get(x.sig) > 1 ? sig.get(x.sig) : 0; delete x.sig; }
    d.board = { at: Date.now(), coins: graded.length, baseRate: +base.toFixed(3), wallets: rows };
    await store.update(FILE, {}, (x) => { x.coins = d.coins; x.board = d.board; return x; });
    board = d.board;
    if (done) console.log(`[smart] read ${done} coins; ${graded.length} graded, ${rows.length} smart wallets (base rate ${(base * 100).toFixed(0)}%)`);
  } catch (e) { console.warn("[smart]", e.message); }
  finally { busy = false; }
}

async function boardNow() { if (board) return board; const d = await store.readJson(FILE, {}); board = d.board || null; return board; }

/** smart wallets among the first-15-minute buyers of a coin (live coins too), cached 5 min */
export async function smartIn(token) {
  const t = lc(token);
  const h = coinMemo.get(t);
  if (h && Date.now() - h.at < 5 * 60_000) return h.v;
  const b = await boardNow();
  if (!b?.wallets?.length) return { token: getAddress(t), smart: [], note: "The smart-wallet board is still being built." };
  const set = new Map(b.wallets.map((w, i) => [w.wallet, { ...w, rank: i + 1 }]));
  const r = await blockRate();
  // the launch block, from Pons' TokenLaunched log (Ring Radar's finder, up to ~2 days back)
  const launch = await (await import("./ringradar.mjs")).findLaunchTx(t).catch(() => null);
  const first = launch?.block ?? null;
  let v;
  if (first == null) v = { token: getAddress(t), smart: [], note: "Not a Pons launch from the last ~2 days, so its first 15 minutes cannot be read live (older coins are scored from The Record)." };
  else {
    const e = await earlyBuyers(t, first, first + Math.round(WINDOW_S * r.perS));
    const hits = [...e.buyers.keys()].filter((w) => set.has(w)).map((w) => { const s = set.get(w); return { wallet: getAddress(w), rank: s.rank, wins: s.wins, losses: s.losses, secondsIn: Math.round((e.buyers.get(w) - first) / r.perS) }; }).sort((a, b) => a.rank - b.rank);
    v = { token: getAddress(t), firstBlock: first, buyers: e.buyers.size, smart: hits, baseRate: b.baseRate,
      summary: hits.length ? `${hits.length} smart wallet${hits.length > 1 ? "s" : ""} (past early buys on coins that reached 2x) bought in the first 15 minutes, best ranked #${hits[0].rank}` : "No wallet from the smart board bought in the first 15 minutes." };
  }
  coinMemo.set(t, { at: Date.now(), v });
  return v;
}

const pub = (w, i) => ({ rank: i + 1, wallet: `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`, full: getAddress(w.wallet), wins: w.wins, losses: w.losses, winRate: +w.rate.toFixed(3), score: +w.score.toFixed(3), cluster: w.cluster || 0, lastAt: w.last, recent: w.recent.map((x) => ({ symbol: x.s, outcome: x.o, token: getAddress(x.t) })) });

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => build({ max: 60 }).catch(() => {}), 90_000);
  setInterval(() => build({ max: 40 }).catch(() => {}), 20 * 60_000).unref();
  r.get("/api/radar/smart", async () => {
    const b = await boardNow();
    return { at: b?.at || null, coinsGraded: b?.coins || 0, baseRate: b?.baseRate ?? null, wallets: (b?.wallets || []).slice(0, 50).map(pub),
      how: "For every coin Troya Sentry called and graded (reached 2x its call price = win, never 1.3x = loss), the wallets that bought from the curve or pool in its first 15 minutes. A wallet needs 3+ wins and a Wilson lower bound above the base rate; devs and fee wallets are left out. cluster = how many wallets on the board bought exactly the same coins (most likely one trader or one group). Past results, not a promise." };
  }, { weight: 1 });
  r.get("/api/radar/smart/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return smartIn(params.token); }, { weight: 3, perMin: 20 });
}
