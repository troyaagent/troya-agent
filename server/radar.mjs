// V7 F37 Robinhood Radar, part 1: stock tokens against the real share (part 3, coins in the Robinhood app, is further down). Robinhood Chain's stock tokens trade around the clock
// in Uniswap pools, the shares trade only in US market hours. So a token can sit above or below the real share price, most
// of all on weekends and overnight, when the pool is pricing where it thinks the next open will be.
// For every stock token on the desk: the pool price per share (price ÷ multiplier) against the latest real price (regular
// session, or pre-market / after-hours when that is the latest trade), the gap in %, and whether the US market is open.
//   GET /api/radar/stocks        every stock token with its gap, sorted by the size of the gap (cached 2 min)
//   GET /api/radar/app           Robinhood Chain coins in the Robinhood app, and what was added or turned tradable lately
//   GET /api/radar/app/:token    is this coin in the Robinhood app, tradable or shown only
import { getAddress as getAddr, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const lc = (x) => String(x || "").toLowerCase();

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

/* ---------- V9 F51 Zeno's Gap: a fair value while the US market is closed ----------
   The last real share price is stale once the market closes, while the token keeps trading. Nasdaq-100 futures (NQ=F) trade
   nearly around the clock on weekdays, so the overnight fair value of a share is its last real price moved by the futures
   since that price was set (beta 1, the same for every share: an estimate, said so on the page). Futures are closed on
   weekends, so over a weekend the fair value is simply Friday's last price. In Zeno's paradox Achilles never quite catches
   the tortoise; here the token and the share are kept side by side until the open closes the gap. */
const FUT = "NQ=F";
let fut = null;
async function futuresSeries() {
  if (fut && Date.now() - fut.at < REF_MS) return fut.v;
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(FUT)}?interval=5m&range=5d&includePrePost=true`;
  const j = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const d = j?.chart?.result?.[0];
  const ts = d?.timestamp || [], cl = d?.indicators?.quote?.[0]?.close || [];
  const pts = ts.map((t, i) => [t * 1000, cl[i]]).filter(([, c]) => Number.isFinite(c) && c > 0);
  const v = pts.length ? pts : null;
  if (v) fut = { at: Date.now(), v };
  return v;
}
// the futures' move from the moment a share price was set to now, or null when it cannot be read
function futuresMove(pts, sinceMs) {
  if (!pts || !sinceMs) return null;
  let from = null;
  for (const [t, c] of pts) { if (t <= sinceMs) from = c; else break; }
  const to = pts[pts.length - 1][1];
  return from ? to / from - 1 : null;
}

export async function stockGaps() {
  if (last && Date.now() - last.at < REF_MS) return last.v;
  const { stockDesk } = await import("./stocks.mjs");
  const desk = await stockDesk();
  const assets = (desk?.assets || []).filter((a) => a.priceUsd > 0);
  const rows = [];
  const futPts = await futuresSeries().catch(() => null);
  for (let i = 0; i < assets.length; i += 6) {
    const part = await Promise.all(assets.slice(i, i + 6).map(async (a) => {
      const ref = await shareRef(a.symbol).catch(() => null);
      const perShare = a.priceUsd / (a.multiplier || 1);
      const gap = ref?.price ? (perShare / ref.price - 1) * 100 : null;
      // Zeno's Gap: with the market closed, the share's fair value moves with the futures since its last real price
      const closed = ref?.session && ref.session !== "open";
      const fm = closed ? futuresMove(futPts, ref?.at) : 0;
      const fair = ref?.price ? ref.price * (1 + (fm || 0)) : null;
      const fairGap = fair ? (perShare / fair - 1) * 100 : null;
      return { symbol: a.symbol, name: a.name, address: a.address, logo: a.logo, tokenPriceUsd: a.priceUsd, multiplier: a.multiplier || 1, perShareUsd: +perShare.toFixed(4),
        sharePriceUsd: ref?.price ?? null, shareBasis: ref?.basis || null, shareAt: ref?.at || null, session: ref?.session || null,
        gapPct: gap == null ? null : +gap.toFixed(2), liquidityUsd: a.liquidityUsd ?? null, volume24hUsd: a.volume24hUsd ?? null,
        thin: !(a.liquidityUsd >= 50_000),
        fairUsd: fair ? +fair.toFixed(4) : null, futuresMovePct: closed && fm != null ? +(fm * 100).toFixed(2) : null, fairGapPct: fairGap == null ? null : +fairGap.toFixed(2) };
    }));
    rows.push(...part);
  }
  rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
  const session = rows.find((r) => r.session)?.session || null;
  const v = { at: Date.now(), session, rows,
    notable: rows.filter((r) => r.gapPct != null && !r.thin && Math.abs(r.gapPct) >= 1).slice(0, 8).map((r) => ({ symbol: r.symbol, gapPct: r.gapPct, address: r.address })),
    // F51 snap-back watch: deep pools whose token sits 3% or more away from the fair value while the market is closed
    snapBack: session && session !== "open" ? rows.filter((r) => r.fairGapPct != null && !r.thin && Math.abs(r.fairGapPct) >= 3)
      .sort((a, b) => Math.abs(b.fairGapPct) - Math.abs(a.fairGapPct)).slice(0, 8).map((r) => ({ symbol: r.symbol, address: r.address, fairGapPct: r.fairGapPct, side: r.fairGapPct > 0 ? "above" : "below" })) : [],
    futures: futPts ? { symbol: FUT, last: futPts[futPts.length - 1][1], at: futPts[futPts.length - 1][0] } : null,
    zeno: "While the US market is closed, fair value = the share's last real price × (1 + the move in Nasdaq-100 futures since that price was set). The same move is used for every share (beta 1), so it is an estimate, not a quote. Futures are closed on weekends, so over a weekend fair value is Friday's last price. Whether a gap closes at the open is never known in advance: this is a reading, not a forecast or advice.",
    how: "gap = (token price ÷ multiplier) ÷ latest real share price − 1. The real price is the regular session, or pre-market/after-hours when that is the latest trade. Thin pools (under $50k liquidity) are marked: their price moves on small trades.",
    source: "Pool prices from the Robinhood Chain pools; share prices from Yahoo Finance's public chart data (delayed up to a few minutes)." };
  if (rows.length) last = { at: Date.now(), v };   // an empty board (the stock desk still loading after a restart) is not cached
  return v;
}


/* ---------- part 3: coins in the Robinhood app ----------
   Robinhood's public list of crypto pairs (the one its app reads) carries, besides the majors, Robinhood Chain coins: some
   tradable in the app, many shown with a price only. Every 15 minutes the list is compared with the last one: a coin added
   to the app, or turning tradable, is the strongest outside signal a Robinhood Chain coin can get. Each app entry is matched
   to its contract on chain 4663 by exact name and ticker on Blockscout, keeping the priced one (copies have no price). */
const RH_PAIRS = "https://nummus.robinhood.com/currency_pairs/";
const APP_FILE = "rhapp.json";
// the big coins of other chains are in the app too; they are not Robinhood Chain coins, so they are never matched
const MAJORS = new Set("BTC ETH SOL DOGE SHIB XRP ADA AVAX DOT LTC BCH ETC XLM LINK UNI AAVE COMP USDC USDT DAI PYUSD USDG MATIC POL ARB OP SUI APT NEAR ATOM XTZ ALGO HBAR TRX TON BNB PEPE BONK WIF FLOKI TRUMP PENGU POPCAT MEW MOODENG ONDO RENDER FET GRT CRV LDO MKR SKY ENA HYPE WLFI ZEC XMR DASH BSV BTG LSK OMG NEO QTUM MANA SAND AXS APE IMX INJ TIA SEI JUP PYTH W ZRO STRK BLUR RAY ORCA".split(" "));
let appStore = null, appBusy = false;

async function appTick() {
  if (appBusy || !appStore) return;
  appBusy = true;
  try {
    const j = await fetch(RH_PAIRS, { headers: UA, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const list = (j?.results || []).filter((x) => x?.asset_currency?.code && x.quote_currency?.code === "USD");
    if (list.length < 50) return;                                                 // a partial answer is not a delisting
    const d = await appStore.readJson(APP_FILE, {});
    d.snap ||= {}; d.match ||= {}; d.events ||= [];
    const first = !d.baselineAt, now = Date.now(), seen = new Set();
    for (const x of list) {
      const code = x.asset_currency.code, name = x.asset_currency.name || code;
      const tradable = x.tradability === "tradable", displayOnly = !!x.display_only;
      seen.add(code);
      const prev = d.snap[code];
      if (!prev) { if (!first) d.events.unshift({ at: now, code, name, kind: "added", tradable }); d.snap[code] = { name, tradable, displayOnly, firstSeen: now, lastSeen: now }; continue; }
      if (prev.tradable !== tradable && !first) d.events.unshift({ at: now, code, name, kind: tradable ? "tradable" : "untradable", tradable });
      Object.assign(prev, { name, tradable, displayOnly, lastSeen: now });
    }
    for (const [code, v] of Object.entries(d.snap)) if (!seen.has(code) && !v.removedAt) { v.removedAt = now; if (!first) d.events.unshift({ at: now, code, name: v.name, kind: "removed", tradable: false }); }
    d.baselineAt ||= now;
    d.events = d.events.slice(0, 300);
    // match up to 10 entries a round (unmatched ones again after a week) to their contract on Robinhood Chain (Blockscout credits are shared)
    const { blockscoutApi, hasBlockscout } = await import("./market.mjs");
    if (hasBlockscout()) {
      const todo = Object.entries(d.snap).filter(([c, v]) => !v.removedAt && !MAJORS.has(c.toUpperCase()) && (!d.match[c] || (d.match[c].address == null && now - d.match[c].at > 7 * 86_400_000))).slice(0, 10);
      for (const [code, v] of todo) {
        const r = await blockscoutApi(`/search?q=${encodeURIComponent(code)}`).catch(() => null);
        if (!r) break;
        const toks = (r.items || []).filter((t) => t.type === "token" && String(t.symbol || "").toUpperCase() === code.toUpperCase() && String(t.name || "").toLowerCase() === String(v.name).toLowerCase());
        const priced = toks.filter((t) => t.exchange_rate != null);
        const pick = priced[0] || (toks.length === 1 ? toks[0] : null);
        d.match[code] = { address: pick ? lc(pick.address_hash || pick.address) : null, copies: Math.max(0, toks.length - 1), at: now };
      }
    }
    for (const e of d.events.slice(0, 20)) if (!e.token && d.match[e.code]?.address) e.token = d.match[e.code].address;
    await appStore.update(APP_FILE, {}, () => d);
    const fresh = d.events.filter((e) => e.at === now);
    if (fresh.length) console.log(`[radar] Robinhood app: ${fresh.map((e) => `${e.kind} ${e.code}`).join(", ")}`);
  } catch (e) { console.warn("[radar] app", e.message); }
  finally { appBusy = false; }
}

/** Is this Robinhood Chain coin in the Robinhood app, and can people trade it there? */
export async function appStatus(token) {
  if (!appStore) return null;
  const d = await appStore.readJson(APP_FILE, {});
  const t = lc(token);
  const code = Object.keys(d.match || {}).find((c) => d.match[c]?.address === t);
  if (!code) return { listed: false };
  const s = d.snap[code];
  return { listed: !s.removedAt, code, name: s.name, tradable: s.tradable, displayOnly: s.displayOnly, since: s.firstSeen, baselineAt: d.baselineAt };
}

export async function appView() {
  const d = await appStore.readJson(APP_FILE, {});
  const live = Object.entries(d.snap || {}).filter(([, v]) => !v.removedAt);
  const chain = live.filter(([c]) => d.match?.[c]?.address).map(([c, v]) => ({ code: c, name: v.name, token: getAddr(d.match[c].address), tradable: v.tradable, displayOnly: v.displayOnly, firstSeen: v.firstSeen }));
  return { pairs: live.length, tradable: live.filter(([, v]) => v.tradable).length, chainCoins: chain.sort((a, b) => Number(b.tradable) - Number(a.tradable)), matched: Object.values(d.match || {}).filter((m) => m.address).length,
    events: (d.events || []).slice(0, 50), baselineAt: d.baselineAt || null,
    how: "Robinhood's public crypto pair list, read every 15 minutes. tradable = buy and sell in the Robinhood app; display only = shown with a price. Each entry is matched to its Robinhood Chain contract by exact name and ticker, keeping the priced one." };
}

export async function register(r, ctx) {
  appStore = ctx?.store || null;
  setTimeout(() => appTick().catch(() => {}), 50_000);
  setInterval(() => appTick().catch(() => {}), 15 * 60_000).unref();
  r.get("/api/radar/app", async () => appView(), { weight: 1 });
  r.get("/api/radar/app/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return { token: getAddr(params.token), ...(await appStatus(params.token)) }; }, { weight: 1 });
  r.get("/api/radar/stocks", async () => {
    const v = await stockGaps();
    if (!v.rows.length) throw new HttpError(503, "The stock desk is not answering right now.");
    return v;
  }, { weight: 2 });
}
