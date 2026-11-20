// KyberSwap aggregator: a fallback route for Robinhood Chain coins that Troya's own Pons / Uniswap routes cannot reach
// (Long.xyz, Bankr, Frontier.fun, Virtuals, Abyss, Goo, Clank.trade, o1, Ramses, Aerodrome, PancakeSwap, Sushi …).
// robinhood.mjs only asks Kyber after its own route finds nothing, so every route that already worked stays as it was.
// Calldata is built on the server from a fresh route, sent only to the known router, and the Gate simulates it like any
// other swap (route, impact, simulation, test sell, transfer tax).
//   KYBER=0 turns the fallback off · KYBER_LIVE=0 stops people signing Kyber swaps · KYBER_CLIENT_ID (default "troya") · KYBER_ROUTERS=comma list (default: MetaAggregationRouterV2)
import { AsyncLocalStorage } from "node:async_hooks";

const BASE = "https://aggregator-api.kyberswap.com";
const CLIENT = process.env.KYBER_CLIENT_ID || "troya";
export const KYBER_ON = process.env.KYBER !== "0";
// Signing a Kyber swap (the Swap page, the Agent Wallet, Telegram) passed its real-money test on 16 Nov 2026 (0.001 ETH →
// ABYSS through abyss-v3 and back: txs 0x53dde274…, 0xaf498861…, 0xf5f46c77…). KYBER_LIVE=0 closes it again; quotes, the Gate
// and Sentry keep using Kyber routes either way.
export const KYBER_LIVE = process.env.KYBER_LIVE !== "0";
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SLUG = { 4663: "robinhood", 8453: "base", 42161: "arbitrum" };
const ROUTERS = new Set(String(process.env.KYBER_ROUTERS || "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
const lower = (s) => String(s || "").toLowerCase();

// Kyber refuses bursts (403 "Forbidden" / 429), and one Gate run makes several calls, so calls go out one at a time with a
// short gap. Two lanes share that gap: the priority lane (hi) for a person waiting on a quote, a Gate or a build (the
// /api/swap/* handlers run inside interactive()), and the background lane (lo) for Sentry, Arena, Autopilot, Aegis and the
// Gate API. hi is always served first and fails fast: one retry after 500 ms and a 4 s budget, after which the caller falls
// back (LI.FI on Base and Arbitrum, Troya's own route on Robinhood Chain). lo keeps the patient exponential backoff, but a
// refused background call only holds the background lane, so a burst of Sentry checks can no longer starve a user's quote.
// lo also holds at most LO_CAP waiting calls: past that the oldest is dropped with an error (its caller already handles
// Kyber failing) instead of growing a queue that no one will wait for.
const GAP_MS = Math.max(100, Number(process.env.KYBER_GAP_MS) || 600);
const HI_BUDGET_MS = Math.max(1000, Number(process.env.KYBER_HI_BUDGET_MS) || 4000);
const HI_RETRY_MS = 500, HOLD_CAP_MS = 2000, LO_CAP = 20, LO_TRIES = 5;
// a store older than this is not a person waiting any more (a timer or loop started inside a request inherits the store)
const HI_TTL_MS = 60_000;
const lane = new AsyncLocalStorage();
/** interactive(fn): runs fn with every KyberSwap call it makes in the priority lane. */
export function interactive(fn) { return lane.run({ at: Date.now() }, fn); }
const inHiLane = () => { const s = lane.getStore(); return !!s && Date.now() - s.at < HI_TTL_MS; };

const hiQ = [], loQ = [];
let last = 0, loUntil = 0, timer = null;
const late = () => new Error("KyberSwap did not answer in time");
// serve the next call once the gap since the last one has passed: hi first; lo also waits out its own backoff (loUntil)
function pump() {
  if (timer) { clearTimeout(timer); timer = null; }
  const q = hiQ.length ? hiQ : loQ.length ? loQ : null;
  if (!q) return;
  const wait = (q === hiQ ? last + GAP_MS : Math.max(last + GAP_MS, loUntil)) - Date.now();
  if (wait > 0) { timer = setTimeout(pump, wait); return; }
  last = Date.now();
  q.shift().go();
  pump();
}
function slot(hi, { signal, front = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(late());
    const q = hi ? hiQ : loQ;
    const onAbort = () => { const i = q.indexOf(job); if (i >= 0) { q.splice(i, 1); reject(late()); pump(); } };
    const job = {
      go: () => { signal?.removeEventListener("abort", onAbort); resolve(); },
      drop: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (front) q.unshift(job); else q.push(job);
    if (!hi) while (loQ.length > LO_CAP) loQ.shift().drop(new Error("KyberSwap is busy: too many background checks were waiting, so the oldest was dropped"));
    pump();
  });
}
// a refusal in the priority lane holds everyone for a moment, never more than HOLD_CAP_MS (the old code pushed the shared
// clock up to 16 s ahead, and every user waited behind it)
function hold(ms) { last = Math.max(last, Date.now() + Math.min(ms, HOLD_CAP_MS) - GAP_MS); }
async function call(chainId, path, { method = "GET", body, timeout = 12000 } = {}) {
  const slug = SLUG[chainId];
  if (!slug) throw new Error(`KyberSwap is not set up for chain ${chainId}`);
  const hi = inHiLane();
  const budget = hi ? AbortSignal.timeout(HI_BUDGET_MS) : null; // covers the wait in the queue, the call and the retry
  const tries = hi ? 2 : LO_TRIES;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    await slot(hi, { signal: budget, front: attempt > 0 });
    let res, j;
    try {
      res = await fetch(`${BASE}/${slug}/api/v1/${path}`, {
        method, signal: budget || AbortSignal.timeout(timeout),
        headers: { accept: "application/json", "x-client-id": CLIENT, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 403 || res.status === 429) {
        res.body?.cancel().catch(() => {});
        lastErr = new Error("KyberSwap is busy, try again in a moment");
        if (hi) { hold(HI_RETRY_MS); loUntil = Math.max(loUntil, Date.now() + HOLD_CAP_MS); } // background gives way to the retry
        else loUntil = Math.max(loUntil, Date.now() + 1000 * 2 ** attempt);
        continue;
      }
      try { j = await res.json(); } catch (e) { if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e; throw new Error(`KyberSwap returned ${res.status}`); }
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw late();
      throw e;
    }
    if (!res.ok || String(j.code) !== "0" || !j.data) throw new Error(j?.message ? `KyberSwap: ${j.message}` : `KyberSwap returned ${res.status}`);
    return j.data;
  }
  throw lastErr;
}

// Routes are kept 15 s, keyed by chain, both tokens and the amount rounded to 2 significant digits, so the round-trip probes
// (whose amounts move with every block) and repeated background checks reuse a fresh answer. A hit for a different exact
// amount is only handed to a caller that asked for an estimate ({ approx: true }), scaled to its amount and without the
// routeSummary, so a swap is always built from Kyber's route for exactly the amount being swapped.
const CACHE = new Map(), CACHE_MS = 15_000;
export function sig2(v) {
  const s = BigInt(v).toString();
  if (s.length <= 2 || s.startsWith("-")) return s;
  return ((BigInt(s.slice(0, 2)) + (s.charCodeAt(2) >= 53 ? 1n : 0n)) * 10n ** BigInt(s.length - 2)).toString();
}
const scaled = (v, from, to) => {
  const r = Number((to * 1000000n) / from) / 1000000;
  return { ...v, routeSummary: undefined, scaled: true, out: (v.out * to) / from, inUsd: v.inUsd != null ? v.inUsd * r : null, outUsd: v.outUsd != null ? v.outUsd * r : null };
};
/** kyberRoute({ tokenIn, tokenOut, amountIn, approx }) — addresses, or ZERO / "native" for ETH; amountIn as bigint.
 *  approx: true accepts a cached route for a nearby amount, scaled (probes and estimates only, never for building). */
export async function kyberRoute({ chainId = 4663, tokenIn, tokenOut, amountIn, approx = false }) {
  const t = (a) => (!a || a === "native" || /^0x0{40}$/i.test(a) ? KYBER_NATIVE : a);
  const amt = BigInt(amountIn);
  const qs = new URLSearchParams({ tokenIn: t(tokenIn), tokenOut: t(tokenOut), amountIn: amt.toString(), gasInclude: "true" });
  const key = `${chainId}|${lower(t(tokenIn))}|${lower(t(tokenOut))}|${sig2(amt)}`, hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) {
    if (hit.amt === amt) return hit.v;
    if (approx && hit.amt > 0n) return scaled(hit.v, hit.amt, amt);
  }
  const d = await call(chainId, `routes?${qs}`);
  const rs = d.routeSummary;
  if (!rs?.amountOut || BigInt(rs.amountOut) <= 0n) throw new Error("KyberSwap found no route");
  const router = d.routerAddress || rs.routerAddress;
  if (!ROUTERS.has(lower(router))) throw new Error("KyberSwap answered with an unknown router, so the route was not used");
  const paths = (rs.route || []).map((leg) => leg.map((s) => ({ pool: s.pool, tokenIn: s.tokenIn, tokenOut: s.tokenOut, exchange: s.exchange, poolType: s.poolType })));
  const exchanges = [...new Set(paths.flat().map((s) => s.exchange))];
  const v = {
    routeSummary: rs, router, out: BigInt(rs.amountOut),
    inUsd: Number(rs.amountInUsd) || null, outUsd: Number(rs.amountOutUsd) || null, gasUsd: Number(rs.gasUsd) || null,
    paths, exchanges,
  };
  CACHE.set(key, { t: Date.now(), amt, v });
  if (CACHE.size > 300) for (const [k, x] of CACHE) if (Date.now() - x.t > CACHE_MS) CACHE.delete(k);
  return v;
}

/** kyberBuild({ routeSummary, router, sender, slippageBps, deadline }) → { to, data, value, amountOut } */
export async function kyberBuild({ chainId = 4663, routeSummary, router, sender, recipient, slippageBps, deadline }) {
  const d = await call(chainId, "route/build", {
    method: "POST", timeout: 15000,
    body: { routeSummary, sender, recipient: recipient || sender, slippageTolerance: Math.max(1, Math.min(5000, Math.round(slippageBps))), deadline, source: CLIENT, enableGasEstimation: false },
  });
  const to = d.routerAddress || router;
  if (!ROUTERS.has(lower(to)) || lower(to) !== lower(router)) throw new Error("KyberSwap built the swap for a different router, so it was not used");
  if (!/^0x[0-9a-f]+$/i.test(d.data || "")) throw new Error("KyberSwap returned no calldata");
  return { to, data: d.data, value: BigInt(d.transactionValue || 0), amountOut: BigInt(d.amountOut || 0) };
}

/** splitLoss(rtProbe, rtFull) → { feePct, impact }: a full-size round trip loses about 2 × (fees + impact) and a small one
 *  about 2 × fees. Tiny probes can be off (gas-aware routing, market makers), so a probe that shows far less loss than the
 *  real size (on a small trade) is not trusted: the whole one-way loss is then reported as fees and impact as zero. */
export function splitLoss(rtP, rtF) {
  if (rtF == null) return { feePct: rtP != null ? rtP * 50 : null, impact: null };
  const oneWay = rtF / 2;
  // a near-zero probe next to a modest full-size loss is noise; a near-zero probe next to a big loss is real impact
  if (rtP == null || (rtP < 0.0005 && rtF < 0.05)) return { feePct: oneWay * 100, impact: 0 };
  const fee = Math.min(rtP / 2, oneWay);
  return { feePct: fee * 100, impact: Math.max(0, oneWay - fee) };
}
