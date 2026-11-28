// Hero trend: the big word behind the homepage hero and its "Trade …" pill follow a real, checkable number instead of a
// hand-picked name (owner, 28 Nov 2026: "biar kita ga asal"). Rule (option A): once per UTC day, the single company with
// the largest 24-hour traded volume among trade.xyz's markets on Hyperliquid (dex "xyz"). Indexes, ETFs, commodities, FX and
// any ticker not on the list below are never picked, so the word is always a company we can name correctly.
// The choice is written into the page as it is served (server/livehtml.mjs fragments "hero-word" and "hero-trade"), so the
// homepage never flickers from the fallback; if Hyperliquid cannot be read, yesterday's choice stays.
//   GET /api/hero/trend → { ticker, name, volumeUsd, day, chosenAt, rule, ranking }
import { setFragment } from "./livehtml.mjs";

const FILE = "hero-trend.json";
const HL = "https://api.hyperliquid.xyz/info";
const RULE = "Once per UTC day: the company with the largest 24-hour traded volume on trade.xyz (Hyperliquid), indexes, ETFs and commodities left out.";
// trade.xyz ticker → the company's name as the hero writes it. Only tickers whose company is certain; add more after checking.
const COMPANIES = {
  ANT: "Anthropic", NVDA: "NVIDIA", SNDK: "SanDisk", MU: "Micron", GOOGL: "Google", TSLA: "Tesla", NBIS: "Nebius", AMD: "AMD",
  AAPL: "Apple", SMSN: "Samsung", META: "Meta", INTC: "Intel", CRCL: "Circle", MSTR: "Strategy", RKLB: "Rocket Lab", MRVL: "Marvell",
  CRWV: "CoreWeave", AMZN: "Amazon", MSFT: "Microsoft", IREN: "IREN", COIN: "Coinbase", ARM: "Arm", DELL: "Dell", KIOXIA: "Kioxia",
  UNITREE: "Unitree", MRNA: "Moderna", HOOD: "Robinhood", ZM: "Zoom", ZHIPU: "Zhipu", AVGO: "Broadcom", TSM: "TSMC", PLTR: "Palantir",
  ORCL: "Oracle", NFLX: "Netflix", IBM: "IBM", GME: "GameStop", BABA: "Alibaba", QCOM: "Qualcomm", COST: "Costco", LLY: "Eli Lilly",
  CRWD: "CrowdStrike", ASML: "ASML", MINIMAX: "MiniMax", AMAT: "Applied Materials", HYUNDAI: "Hyundai", NET: "Cloudflare", RDDT: "Reddit",
  RIVN: "Rivian", SOFTBANK: "SoftBank", LRCX: "Lam Research", PANW: "Palo Alto", NOK: "Nokia", EBAY: "eBay", SNOW: "Snowflake",
  SNAP: "Snap", SMCI: "Supermicro", RBLX: "Roblox", MELI: "MercadoLibre", TENCENT: "Tencent", CATL: "CATL", STX: "Seagate", WDC: "Western Digital",
};
const FALLBACK = { ticker: "ANT", name: "Anthropic", volumeUsd: null, day: null, chosenAt: null };
let store = null, state = { ...FALLBACK }, busy = false;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n / 1e3)}K`);
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export async function ranking() {
  const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Hyperliquid ${r.status}`);
  const [meta, ctx] = await r.json();
  return (meta?.universe || []).map((a, i) => ({ ticker: String(a.name || "").replace(/^xyz:/, ""), volumeUsd: Number(ctx?.[i]?.dayNtlVlm) || 0 }))
    .filter((x) => COMPANIES[x.ticker] && x.volumeUsd > 0)
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
}

function paint(s) {
  const name = s.name.toUpperCase();
  setFragment("hero-word", `<p class="ant-word" aria-hidden="true"><svg viewBox="0 0 1000 124" preserveAspectRatio="xMidYMid meet"><text x="0" y="117" textLength="1000" lengthAdjust="spacingAndGlyphs">${esc(name)}</text></svg></p>`);
  const why = s.volumeUsd ? `most traded company on trade.xyz today · ${usd(s.volumeUsd)} in 24h` : `${esc(s.ticker)} perp · bridge in from Robinhood Chain`;
  setFragment("hero-trade", `<a class="ant-pill" href="/agent#/perps/xyz:${esc(s.ticker)}"><i></i><span>Trade ${esc(s.name)}<small>${esc(why)}</small></span><b>Trade</b></a>`);
}

async function choose({ force = false } = {}) {
  if (busy) return state;
  if (!force && state.day === dayOf()) return state;
  busy = true;
  try {
    const list = await ranking();
    if (!list.length) return state;
    const top = list[0];
    state = { ticker: top.ticker, name: COMPANIES[top.ticker], volumeUsd: Math.round(top.volumeUsd), day: dayOf(), chosenAt: Date.now(),
      ranking: list.slice(0, 5).map((x) => ({ ticker: x.ticker, name: COMPANIES[x.ticker], volumeUsd: Math.round(x.volumeUsd) })) };
    await store?.writeJson(FILE, state).catch(() => {});
    paint(state);
    return state;
  } catch (e) {
    console.warn("[herotrend]", e.message);
    return state;
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  state = await store.readJson(FILE, state).catch(() => state);
  if (!state?.ticker || !COMPANIES[state.ticker]) state = { ...FALLBACK };
  paint(state);
  r.get("/api/hero/trend", () => ({ ...state, rule: RULE }), { weight: 1, perMin: 60 });
  if (process.env.HERO_TREND === "0") return;
  setTimeout(() => choose().catch(() => {}), 20_000).unref?.();
  setInterval(() => choose().catch(() => {}), 10 * 60_000).unref?.();   // picks the new day's company within 10 minutes of 00:00 UTC
}
export const _test = { COMPANIES, paint, dayOf };
