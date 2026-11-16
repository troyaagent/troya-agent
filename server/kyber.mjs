// KyberSwap aggregator: a fallback route for Robinhood Chain coins that Troya's own Pons / Uniswap routes cannot reach
// (Long.xyz, Bankr, Frontier.fun, Virtuals, Abyss, Goo, Clank.trade, o1, Ramses, Aerodrome, PancakeSwap, Sushi …).
// robinhood.mjs only asks Kyber after its own route finds nothing, so every route that already worked stays as it was.
// Calldata is built on the server from a fresh route, sent only to the known router, and the Gate simulates it like any
// other swap (route, impact, simulation, test sell, transfer tax).
//   KYBER=0 turns the fallback off · KYBER_LIVE=0 stops people signing Kyber swaps · KYBER_CLIENT_ID (default "troya") · KYBER_ROUTERS=comma list (default: MetaAggregationRouterV2)
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
// short gap, and a refused call waits and tries again.
const GAP_MS = Math.max(100, Number(process.env.KYBER_GAP_MS) || 600);
let chain = Promise.resolve(), last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slot() {
  const turn = chain.then(async () => { const wait = last + GAP_MS - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); });
  chain = turn.catch(() => {});
  return turn;
}
async function call(chainId, path, { method = "GET", body, timeout = 12000 } = {}) {
  const slug = SLUG[chainId];
  if (!slug) throw new Error(`KyberSwap is not set up for chain ${chainId}`);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    await slot();
    const res = await fetch(`${BASE}/${slug}/api/v1/${path}`, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { accept: "application/json", "x-client-id": CLIENT, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 403 || res.status === 429) { lastErr = new Error("KyberSwap is busy, try again in a moment"); last = Date.now() + 1000 * 2 ** attempt; await sleep(1000 * 2 ** attempt); continue; }
    let j;
    try { j = await res.json(); } catch { throw new Error(`KyberSwap returned ${res.status}`); }
    if (!res.ok || String(j.code) !== "0" || !j.data) throw new Error(j?.message ? `KyberSwap: ${j.message}` : `KyberSwap returned ${res.status}`);
    return j.data;
  }
  throw lastErr;
}

const CACHE = new Map(), CACHE_MS = 15_000;
/** kyberRoute({ tokenIn, tokenOut, amountIn }) — addresses, or ZERO / "native" for ETH; amountIn as bigint. */
export async function kyberRoute({ chainId = 4663, tokenIn, tokenOut, amountIn }) {
  const t = (a) => (!a || a === "native" || /^0x0{40}$/i.test(a) ? KYBER_NATIVE : a);
  const qs = new URLSearchParams({ tokenIn: t(tokenIn), tokenOut: t(tokenOut), amountIn: BigInt(amountIn).toString(), gasInclude: "true" });
  const key = `${chainId}:${qs}`, hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
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
  CACHE.set(key, { t: Date.now(), v });
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
