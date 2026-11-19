// V7 F37 Robinhood Radar, part 1: stock tokens against the real share. Robinhood Chain's stock tokens trade around the clock
// in Uniswap pools, the shares trade only in US market hours. So a token can sit above or below the real share price, most
// of all on weekends and overnight, when the pool is pricing where it thinks the next open will be.
// For every stock token on the desk: the pool price per share (price ÷ multiplier) against the latest real price (regular
// session, or pre-market / after-hours when that is the latest trade), the gap in %, and whether the US market is open.
//   GET /api/radar/stocks        every stock token with its gap, sorted by the size of the gap (cached 2 min)
import { HttpError } from "./api.mjs";

const UA = { "user-agent": "Mozilla/5.0 (compatible; TroyaRadar/1.0)" };
const REF_MS = 2 * 60_000;
const refs = new Map();          // symbol → { at, v }
let last = null;

/** The latest real price of a US share and the market session, from Yahoo Finance's public chart endpoint. */
async function shareRef(sym) {
  const h = refs.get(sym);
  if (h && Date.now() - h.at < REF_MS) return h.v;
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d&includePrePost=true`;
  const j = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const d = j?.chart?.result?.[0];
  let v = null;
  if (d?.meta?.regularMarketPrice) {
    const m = d.meta, p = m.currentTradingPeriod || {}, now = Date.now() / 1000;
    const closes = d.indicators?.quote?.[0]?.close || [], ts = d.timestamp || [];
    let lastPx = null, lastT = null;
    for (let i = closes.length - 1; i >= 0; i--) if (closes[i] != null) { lastPx = closes[i]; lastT = ts[i]; break; }
    const inP = (k) => p[k] && now >= p[k].start && now < p[k].end;
    const etDay = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
    const weekend = etDay === "Sat" || etDay === "Sun" || (etDay === "Fri" && p.post && now >= p.post.end);
    const session = inP("regular") ? "open" : inP("pre") ? "pre-market" : inP("post") ? "after-hours" : weekend ? "weekend" : "overnight";
    const useExt = session !== "open" && lastPx && lastT > (m.regularMarketTime || 0);
    v = { price: useExt ? lastPx : m.regularMarketPrice, regularClose: m.regularMarketPrice, at: (useExt ? lastT : m.regularMarketTime) * 1000, session, basis: useExt ? "extended hours" : "regular session" };
  }
  refs.set(sym, { at: Date.now(), v });
  return v;
}

export async function stockGaps() {
  if (last && Date.now() - last.at < REF_MS) return last.v;
  const { stockDesk } = await import("./stocks.mjs");
  const desk = await stockDesk();
  const assets = (desk?.assets || []).filter((a) => a.priceUsd > 0);
  const rows = [];
  for (let i = 0; i < assets.length; i += 6) {
    const part = await Promise.all(assets.slice(i, i + 6).map(async (a) => {
      const ref = await shareRef(a.symbol).catch(() => null);
      const perShare = a.priceUsd / (a.multiplier || 1);
      const gap = ref?.price ? (perShare / ref.price - 1) * 100 : null;
      return { symbol: a.symbol, name: a.name, address: a.address, logo: a.logo, tokenPriceUsd: a.priceUsd, multiplier: a.multiplier || 1, perShareUsd: +perShare.toFixed(4),
        sharePriceUsd: ref?.price ?? null, shareBasis: ref?.basis || null, shareAt: ref?.at || null, session: ref?.session || null,
        gapPct: gap == null ? null : +gap.toFixed(2), liquidityUsd: a.liquidityUsd ?? null, volume24hUsd: a.volume24hUsd ?? null,
        thin: !(a.liquidityUsd >= 50_000) };
    }));
    rows.push(...part);
  }
  rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  const session = rows.find((r) => r.session)?.session || null;
  const v = { at: Date.now(), session, rows,
    notable: rows.filter((r) => r.gapPct != null && !r.thin && Math.abs(r.gapPct) >= 1).slice(0, 8).map((r) => ({ symbol: r.symbol, gapPct: r.gapPct, address: r.address })),
    how: "gap = (token price ÷ multiplier) ÷ latest real share price − 1. The real price is the regular session, or pre-market/after-hours when that is the latest trade. Thin pools (under $50k liquidity) are marked: their price moves on small trades.",
    source: "Pool prices from the Robinhood Chain pools; share prices from Yahoo Finance's public chart data (delayed up to a few minutes)." };
  last = { at: Date.now(), v };
  return v;
}

export async function register(r) {
  r.get("/api/radar/stocks", async () => {
    const v = await stockGaps();
    if (!v.rows.length) throw new HttpError(503, "The stock desk is not answering right now.");
    return v;
  }, { weight: 2 });
}
