// Token detail (#/token/<address>): price, chart, stats, holders, trades, links. Since V8 F41 it is the War Table:
// Watchfire's live board (labelled trades, early buyers, holder tags), instant trades and chart marks (wartable.js).
import { h, clear, useCss, icon, tokenIcon, padLogo, tiny, price, usd, compact, pctEl, short, ago, copyText, tabs, seg, emptyState } from "../ui.js";
import { api, cached } from "../api.js";
import { padName, ethAmount, ageText } from "../marketlib.js";
import { clusterSection } from "/agent/desk/clusters.js";
import { clashBox } from "../clash.js";
import { startBoard, watchfirePanel, tradePanel, renderTrades, renderEarly, chartMarks, tagEl, renderCallouts, calloutLayer, tributePanel, panelTitle, snapTime } from "./wartable.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = (x) => String(x || "").toLowerCase();

export async function mount(view, { parts, ask }) {
  useCss("home");
  useCss("market");
  const address = String(parts[0] || "").toLowerCase();
  const back = h("a", { class: "tk-back", href: "#/market" }, "← Market");
  if (!ADDR.test(address)) {
    clear(view, back, emptyState("That is not a token address.", "Token pages need a 0x… contract address on Robinhood Chain.", h("a", { class: "link", href: "#/market" }, "Back to the market")));
    return;
  }
  const slow = h("p", { class: "fine muted", style: { margin: "14px 0 0" } });
  clear(view, back, h("div", { style: { padding: "40px 0" } }, h("div", { class: "sk", style: { height: "52px", width: "320px", marginBottom: "18px" } }), h("div", { class: "sk", style: { height: "380px" } }), slow));
  const slowT = setTimeout(() => { slow.textContent = "Still reading this coin from GeckoTerminal and the chain. A coin nobody opened lately can take up to half a minute."; }, 6000);

  let d;
  try { d = await api.get(`market/robinhood/token?address=${address}`); clearTimeout(slowT); }
  catch (e) {
    clearTimeout(slowT);
    clear(view, back, emptyState(e.status === 404 ? "This token is not on the Robinhood Chain board yet." : "The token could not be loaded.", e.message,
      h("div", { class: "row" }, h("a", { class: "link", href: "#/market" }, "Back to the market"), h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/token/${address}`, target: "_blank", rel: "noopener" }, "Look it up on Blockscout ↗"))));
    return;
  }
  const t = d.token;
  const pons = d.pons;
  document.title = `${t.name && t.name !== t.symbol ? `${t.name} ($${t.symbol})` : `$${t.symbol}`} · Troya Agent`;
  let launch = null;
  try { const b = await cached("launch/board", 60000); launch = [...(b.new || []), ...(b.almost || []), ...(b.migrated || [])].find((x) => lc(x.token) === address) || null; } catch {}
  // a stock token's metadata carries Robinhood's own accounts; on a page named after the company they read as its accounts
  const rhOwn = (u) => { try { const x = new URL(/^https?:/i.test(u) ? u : `https://${u}`); return /(^|\.)robinhood\.com$/i.test(x.hostname) || (/(^|\.)(twitter|x)\.com$/i.test(x.hostname) && /^\/robinhood/i.test(x.pathname)); } catch { return /robinhood/i.test(String(u)); } };
  if (t.stock) for (const k of ["website", "twitter", "telegram", "discord"]) if (t[k] && rhOwn(t[k])) t[k] = null;
  // stock tokens and core tokens (WETH, USDG) are not launchpad coins: Watchfire keeps no board for them (no labelled
  // trades, no early buyers), so their page leads with GeckoTerminal's trades of the main pool
  const stockish = !!(t.stock || t.hub);
  const curve = () => !!(pons && !pons.graduated);
  let ethUsd = d.ethUsd > 0 ? d.ethUsd : null;
  let chart = null, chartStop = false;

  // the header price says how old it is ("updated 12s ago", by the server's clock) and refreshes every 20 s while the
  // page is open: $TROYA once showed a price 69 minutes old here while its chart and DexScreener said otherwise
  let skew = d.now ? Date.now() - d.now : 0;
  const pxP = h("div", { class: "p" }), pxU = h("div", { class: "u" }), pxAt = h("div", { class: "fine muted tk-px-at", style: { marginTop: "4px" } });
  const paintPx = () => {
    pxP.textContent = t.priceUsd != null ? `$${price(t.priceUsd)}` : pons?.priceInPair != null ? `${tiny(pons.priceInPair)} ${pons.pair.symbol}` : "No price yet";
    clear(pxU, t.priceEth != null ? h("span", { class: "tk-px-eth" }, `${tiny(t.priceEth)} ETH`) : null, pctEl(t.change24h), h("span", { class: "faint" }, "24h"));
    paintAt();
  };
  const paintAt = () => {
    if (!t.priceAt) { pxAt.textContent = ""; return; }
    const s = Math.max(0, (Date.now() - skew - t.priceAt) / 1000);
    pxAt.textContent = `updated ${s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`} ago`;
    pxAt.title = t.priceSource ? `Price from ${t.priceSource}` : "";
    pxAt.classList.toggle("warnc", s > 15 * 60);
  };
  paintPx();

  /* ---------- the numbers, one helper each: the strip under the name, the stats panel and the agent's context read the
     same function, so they never disagree ---------- */
  const raisedTxt = () => (!(pons?.raised >= 1e-6) ? "0" : pons.raised < 1 ? (+pons.raised).toFixed(4) : tiny(pons.raised));
  // on a Pons curve the money in the coin is what buyers paid into it (raised) at today's price: GeckoTerminal's pool
  // figure also counts the curve's virtual reserve, which no seller can take out ($2,928 beside "Curve raised 0 / 4.2 ETH")
  const pairUsd = () => { const s = String(pons?.pair?.symbol || "").toUpperCase(); return pons?.pair?.address === "native" || s === "ETH" || s === "WETH" ? ethUsd : /^USD/.test(s) ? 1 : null; };
  const onCurveLiq = () => curve() && pairUsd() != null;
  const liqUsd = () => (onCurveLiq() ? Math.max(0, Number(pons.raised) || 0) * pairUsd() : t.realLiquidityUsd ?? null);
  const liqText = () => { const v = liqUsd(); return v == null ? null : v < 0.005 ? "$0" : usd(v, { compact: true }); };
  // Liquidity is the money side of the pools (ETH, USDG or stock tokens); the pool total, which also counts the coin at
  // its own price, only in the tooltip
  const liqTip = () => onCurveLiq()
    ? `What buyers have paid into the curve (${raisedTxt()} ${pons.pair.symbol}) at today's price: the most that sellers can take out. GeckoTerminal's pool figure also counts the curve's virtual reserve.`
    : t.liquidityUsd != null ? (t.realLiquidityUsd != null ? `${usd(t.liquidityUsd, { compact: true })} incl. the coin side` : `Pool total ${usd(t.liquidityUsd, { compact: true })} incl. the coin side; the ETH or USDG side is not read yet`) : "The ETH, USDG or stock-token side of this coin's pools";
  // nobody holds the coin yet when every holder Blockscout lists is a labelled contract (the curve, a pool, a locker), so
  // "1 holder, top 10 0%" reads "None yet". Without the list: a curve with nothing raised still holds all its coins.
  const noWallets = () => {
    if (t.holders === 0) return true;
    const n = t.holders ?? d.holdersCount;
    if (d.holders?.length) return d.holders.every((x) => x.wallet === false) && n != null && n <= d.holders.length;
    return curve() && !(pons.raised > 1e-9) && n != null && n <= 1;
  };
  const holdersParts = () => (noWallets() ? ["None yet", curve() ? "the curve holds all" : "only pools and contracts hold it"] : [t.holders != null ? compact(t.holders, 1).replace(/\.0(?=[KMB]$)/, "") : null, null]);
  const top10Text = () => (noWallets() ? null : t.top10Pct != null ? `${Number(t.top10Pct).toFixed(1)}%` : null);
  const mcText = () => (t.mcapUsd > 0 ? `≈ ${usd(t.mcapUsd, { compact: true })}` : !t.stock && t.mcapEth > 0 ? ethAmount(t.mcapEth) : null);
  const mcTip = () => (t.stock ? `Value of the ${t.symbol} tokens on Robinhood Chain, not ${String(t.name || t.symbol).replace(/\s•.*$/, "")}'s market cap`
    : t.supply > 0 ? `Price × ${compact(t.supply, 2)} coins, the supply left after burns, read on chain` : "Price × supply, as GeckoTerminal or DexScreener report it");
  const volText = () => (t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : null);
  // token age (community request, 20 Nov 2026): the birth from the coin's creation block; the board's createdAt is the main
  // pool's date, which for a coin that graduated to Uniswap is its graduation
  let born = null;
  // (the server sends the same birth as t.bornAt, so the Market list and this page agree before the age call answers)
  const ageVal = () => { const at = born || t.bornAt || launch?.at || t.createdAt; return at ? ageText(at) : null; };

  // the six numbers people check first, right under the name
  const strip = h("div", { class: "tk2-strip", style: { display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: "10px", fontSize: "13px" } });
  const SK = { fontSize: "10.5px", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)", fontWeight: "600" };
  const SV = { fontWeight: "650", fontVariantNumeric: "tabular-nums", color: "var(--fg)" };
  const paintStrip = () => {
    const [hv, hn] = holdersParts();
    clear(strip, [
      [t.stock ? "On chain" : "MC", mcText(), mcTip()],
      ["Liq", liqText(), liqTip()],
      ["Vol 24h", volText(), null],
      ["Holders", hv != null && hn ? `${hv} (${hn})` : hv, null],
      ["Top 10", top10Text(), "Share of the supply in the 10 largest wallets"],
      ["Age", ageVal(), "How long ago the coin was created"],
    ].map(([k, v, tip]) => h("span", { style: { display: "inline-flex", alignItems: "baseline", gap: "6px", whiteSpace: "nowrap" }, title: tip || null }, h("small", { style: SK }, k), h("b", { style: SV }, v ?? "–"))));
  };
  paintStrip();
  const curveBadge = h("span", { class: "badge-s" });
  const paintBadge = () => {
    if (!pons) return;
    curveBadge.className = `badge-s ${pons.graduated ? "blue" : ""}`;
    curveBadge.textContent = pons.graduated ? "Graduated" : `Curve ${pons.progressPct != null ? pons.progressPct.toFixed(1) : "?"}%`;
  };
  paintBadge();

  // the Gate's verdict as a small chip: in the phone header and in the sticky bar (painted once the badge answers)
  const gChips = [];
  const gChip = (cls) => { const c = h("a", { class: `${cls} v-checking`, href: `#/gate/${address}` }, "Gate: checking"); gChips.push(c); return c; };
  const paintChips = (v, label) => { for (const c of gChips) { c.className = `${c.className.split(" ")[0]} v-${v}`; c.textContent = `Gate: ${label}`; } };
  const head = h("div", { class: "tk-head" },
    h("div", { class: "tk-id" }, tokenIcon({ ...t, chain: "robinhood" }),
      h("div", { style: { minWidth: 0 } },
        h("h1", {}, t.name || t.symbol, h("span", { class: "sym" }, `$${t.symbol}`), t.stock ? h("span", { class: "badge-s pad-badge" }, padLogo("stocks", 14), "Tokenized stock") : h("span", { class: "badge-s pad-badge" }, padLogo(t.launchpad, 14), padName(t.launchpad)),
          pons ? curveBadge : null,
          !t.tradable ? h("span", { class: "badge-s warn" }, "Not routed by Troya") : null),
        strip,
        // the full address on a wide screen; a phone shows 0x1fa8…a074 (it wrapped over two lines) with the same copy icon
        h("div", { class: "tk-addr" }, h("span", { class: "mono tk2-ca tk-ca-full" }, address), h("span", { class: "mono tk2-ca tk-ca-short" }, short(address, 4)), h("button", { type: "button", "aria-label": "Copy address", onclick: () => copyText(address, "Address copied") }, icon("copy"))),
        socialRow(t),
        // V10 name clash (Xivor, 26 Nov 2026): other contracts under this ticker, with what the Gate said at each launch
        stockish ? null : clashBox(address))),
    h("div", { class: "tk-px" }, pxP, pxU, pxAt, gChip("tk-gchip")));

  // one Buy on the page: the Trade panel, plus the Gate card's button once the Gate passed. The address copies from the
  // icon beside it, the coin's accounts sit under the name, and Ask opens Troya right here instead of leaving the coin.
  const doAsk = () => { if (ask) ask(askQ); else location.hash = `#/agent?q=${encodeURIComponent(askQ)}`; };
  const doShare = () => import("../sharecard.js").then((m) => m.openShare({ address, symbol: t.symbol, stock: stockish })).catch((e) => console.error(e));
  const askQ = `Give me a read on ${t.symbol} (${address}) on Robinhood Chain: liquidity, contract risk and recent flow.`;
  const actions = h("div", { class: "tk-act" },
    h("a", { class: "btn", href: `#/gate/${address}` }, icon("shield"), "Run the Gate"),
    h("button", { class: "btn", type: "button", onclick: doAsk }, icon("spark"), "Ask about it"),
    // V8 F42 Herald: share cards (Gate verdict + Watchfire) with the viewer's referral link, drawn in the browser
    h("button", { class: "btn", type: "button", onclick: doShare }, icon("ext"), "Share"));
  // on a phone the three buttons took a row of their own above the chart: they fold into a "…" menu in the header
  const moreMenu = h("details", { class: "tk-more" },
    h("summary", { "aria-label": "More actions" }, "…"),
    h("div", { class: "tk-more-m", onclick: (e) => { if (e.target.closest("button")) e.currentTarget.parentElement.open = false; } },
      h("button", { type: "button", onclick: () => copyText(address, "Address copied") }, icon("copy"), "Copy address"),
      h("button", { type: "button", onclick: doShare }, icon("ext"), "Share"),
      h("button", { type: "button", onclick: doAsk }, icon("spark"), "Ask about it")));
  head.append(moreMenu);

  /* ---------- chart ---------- */
  const chartBox = h("div", { class: "tk-chart" });
  let interval = "1h", autoIv = true;   // first load only: a quiet coin opens on the smallest interval that holds trades
  const ivSeg = seg(["5m", "15m", "1h", "4h", "1d"], interval, (v) => { interval = v; autoIv = false; loadChart(); });
  const IV_SECS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  // a launchpad coin opens in market cap (each bar's USD price × today's supply, read on chain after burns for Pons
  // coins): it is how people talk about these coins ("it went from 3K to 40K"). Price shows the raw USD price. Stock and
  // core tokens chart their price only: their "market cap" here would be only the part tokenized on this chain.
  const supplyK = () => (t.supply > 0 ? t.supply : t.mcapUsd > 0 && t.priceUsd > 0 ? t.mcapUsd / t.priceUsd : null);
  let unit = !stockish && supplyK() ? "mcap" : "price";
  let chartK = 1;   // what the drawn bars are multiplied by: 1 for price, the supply for market cap
  const unitSeg = unit === "mcap" ? seg([{ value: "mcap", label: "MCap" }, { value: "price", label: "Price" }], unit, (v) => { unit = v; redraw(); }) : null;
  // candleSeries is the price series: candles, or a line on a quiet coin (every bar the same price carried forward)
  let candleSeries = null, volSeries = null, rows = [], rowAt = new Map(), candleTimes = [], chartEmpty = false, chartSrcName = "", chartIv = interval, lineMode = false;
  // a launchpad coin's board starts as "loading" (its tabs say "Reading…"); stock and core tokens have none
  let board = stockish ? null : { level: "loading" }, calls = null, placeCalls = null;
  const applyMarks = () => { try { candleSeries?.setMarkers(chartMarks(board, candleTimes, IV_SECS[interval] || 3600)); } catch { /* chart gone */ } };
  const chartSrc = h("span", { class: "fine" });
  const paintSrc = () => { chartSrc.textContent = chartSrcName ? `${chartSrcName} · ${chartIv} candles · ${unit === "mcap" ? "market cap in USD" : "priced in USD"}` : ""; };
  // a coin with no trades in the chart's window says so, with its last trade, instead of a flat row of identical bars
  const quietLine = h("p", { class: "fine muted tk-chart-quiet", hidden: true, style: { margin: "8px 0 0" } });
  // one analysis card (community request, 24 Nov 2026: "divide the chart column by 2 with clusters"): the chart and the
  // Cluster map side by side on a wide screen, stacked in the same card on a phone. Stock and core tokens have no map.
  const clusterCard = stockish ? null : clusterSection(address, { compact: true });
  const chartPanel = h("section", { class: `panel tk-an${clusterCard ? "" : " tk-an-solo"}` }, h("div", { class: "tk-an-in" },
    h("div", { class: "tk-an-chart" }, h("div", { class: "tk-chart-bar", style: { flexWrap: "wrap" } }, h("div", { class: "tk-chart-segs", style: { display: "flex", flexWrap: "wrap", gap: "8px" } }, unitSeg, ivSeg), chartSrc), chartBox, quietLine),
    clusterCard ? h("div", { class: "tk-an-cm" }, clusterCard) : null));
  const spanText = (hrs) => (hrs >= 48 ? `${Math.round(hrs / 24)} days` : `${Math.round(hrs)} h`);
  // tradesInWindow comes with on-chain candles; GeckoTerminal's are quiet when no bar carries volume
  const isQuiet = (c, list) => (c.tradesInWindow != null ? c.tradesInWindow === 0 : list.length > 1 && list.every((x) => !(x.volume > 0)));
  let lastC = null;
  const paintQuiet = (c, quiet) => {
    quietLine.hidden = !quiet;
    if (!quiet) { quietLine.textContent = ""; return; }
    const span = c.windowHours > 0 ? c.windowHours : ((rows.length ? rows[rows.length - 1].time - rows[0].time : 0) + (IV_SECS[chartIv] || 3600)) / 3600;
    const px = c.lastTradeUsd > 0 ? `$${tiny(c.lastTradeUsd)}${unit === "mcap" && supplyK() ? ` (MC ${usdShort(c.lastTradeUsd * supplyK())})` : ""}` : null;
    quietLine.textContent = `No trades in the last ${spanText(span)}${c.lastTradeAt ? ` · last trade ${ago(c.lastTradeAt)} ago${px ? ` at ${px}` : ""}` : ""}`;
  };
  // the chart's colours follow the theme, as on the Desk: light keeps a darker blue and red and drops the scale borders
  const isLight = () => document.documentElement.dataset.theme === "light";
  const chartLook = (l) => ({
    layout: { textColor: l ? "#6e685f" : "#748b94" },
    grid: { vertLines: { color: l ? "rgba(0,0,0,.05)" : "rgba(29,45,52,.35)" }, horzLines: { color: l ? "rgba(0,0,0,.05)" : "rgba(29,45,52,.35)" } },
    rightPriceScale: { borderVisible: !l, borderColor: "#142026" }, timeScale: { borderVisible: !l, borderColor: "#142026" },
  });
  const candleLook = (l) => { const up = l ? "#0a7ea3" : "#5fd3ef", dn = l ? "#c8303f" : "#ff6b7d"; return { upColor: up, downColor: dn, wickUpColor: up, wickDownColor: dn }; };
  const lineLook = (l) => ({ color: l ? "#0a7ea3" : "#5fd3ef" });
  // a near-constant series (under 1% from low to high) gets 3% of room on each side of its middle: the scale otherwise
  // printed eight identical labels ("0.0₅2957") over a flat line
  const padScale = (orig) => {
    const r = orig();
    const lo = r?.priceRange?.minValue, hi = r?.priceRange?.maxValue, mid = (lo + hi) / 2;
    if (!(mid > 0) || (hi - lo) / mid >= 0.01) return r;
    return { ...r, priceRange: { minValue: mid * 0.97, maxValue: mid * 1.03 } };
  };
  const volBar = (x, l) => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? (l ? "rgba(10,126,163,.22)" : "rgba(95,211,239,.28)") : (l ? "rgba(200,48,63,.2)" : "rgba(255,107,125,.28)") });
  // the price scale, the crosshair and the last-value label: market cap as compact USD ($20.0K, $1.2M, $3.4B) with as
  // many decimals as the scale's label spacing needs (so neighbouring labels never print the same text), the price as
  // USD with 4 significant digits ($0.0₅9065). The candles are USD; a wrong pair conversion on the server once drew a
  // $13.9M coin as "$18751.03T" here (ORBIO, paired with NVDA): see chainTrades in server/market.mjs.
  const labelStep = () => {
    try {
      const hgt = chartBox.clientHeight, a = candleSeries?.coordinateToPrice(0), b = candleSeries?.coordinateToPrice(hgt);
      return a != null && b != null && hgt > 0 ? Math.abs(a - b) / Math.max(4, hgt / 40) : 0;
    } catch { return 0; }
  };
  const fmtV = (p) => (p < 0 ? "" : unit === "mcap" ? usdShort(p, labelStep()) : p < 1e-15 ? "$0" : `$${tiny(p, 4)}`);
  const fmtOpts = () => ({ priceFormat: { type: "custom", formatter: fmtV, minMove: unit === "mcap" ? 0.01 : 1e-12 } });
  const bar = (x) => ({ time: x.time, open: x.open * chartK, high: x.high * chartK, low: x.low * chartK, close: x.close * chartK });
  const pt = (x) => (lineMode ? { time: x.time, value: x.close * chartK } : bar(x));
  const cleanRows = (list) => { const seen = new Set(); return (list || []).filter((x) => x && x.close > 0 && !seen.has(x.time) && seen.add(x.time)).sort((a, b) => a.time - b.time); };
  const themeObs = new MutationObserver(() => {
    if (!chart) return;
    const l = isLight();
    try { chart.applyOptions(chartLook(l)); candleSeries?.applyOptions(lineMode ? lineLook(l) : candleLook(l)); volSeries?.setData(rows.map((x) => volBar(x, l))); } catch { /* chart gone */ }
  });
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  function redraw() {
    paintSrc();
    if (!candleSeries) return;
    chartK = unit === "mcap" ? supplyK() || 1 : 1;
    try { candleSeries.applyOptions(fmtOpts()); candleSeries.setData(rows.map(pt)); applyMarks(); placeCalls?.(); if (lastC) paintQuiet(lastC, lineMode); } catch { /* chart gone */ }
  }

  /* ---------- the Gate card ---------- */
  const C = 2 * Math.PI * 50;
  const gRing = h("span", { class: "dk-ring tk2-ring" });
  gRing.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${C}"/></svg><b>…</b>`;
  const gVerdict = h("span", { class: "dk-v" }, "Checking"), gNote = h("p", { class: "fine", style: { margin: "6px 0 0" } }, "A simulated buy and a test sell from a fresh address, the same checks Swap runs.");
  const gList = h("ul", { class: "tk2-checks" });
  const gBuy = h("div", { style: { display: "contents" } });   // the Gate card's Buy, only once the Gate passed
  const gateCard = h("section", { class: "panel tk2-gate" },
    h("div", { class: "panel-h" }, panelTitle("Buy and sell check", "Troya Gate"), h("a", { class: "link fine", href: `#/gate/${address}` }, "Full result")),
    h("div", { class: "tk2-gate-b" }, gRing, h("div", {}, gVerdict, gNote)), gList, gBuy,
    h("div", { class: "tk2-also" }, h("span", { class: "fine muted" }, "Also on"),
      t.launchpad === "pons" ? h("a", { class: "tk2-ext", href: `https://ponsfamily.com/launchpad/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/pons.svg", alt: "" }), "Pons") : null,
      h("a", { class: "tk2-ext", href: `https://fomo.family/tokens/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/fomo.png", alt: "" }), "Fomo"),
      h("a", { class: "tk2-ext", href: `https://dexscreener.com/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/dexscreener.png", alt: "" }), "DEX Screener")));
  let ctxGate = "", ctxNote = "";
  const tell = (gateLine) => {
    if (gateLine != null) ctxGate = gateLine;
    const [hv, hn] = holdersParts();
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Token page for $${t.symbol} (${address})${t.stock ? ", a Robinhood stock token" : ""}: price ${t.priceUsd != null ? "$" + tiny(t.priceUsd) : "unknown"}, 24h ${t.change24h != null ? t.change24h.toFixed(1) + "%" : "?"}, market cap ${t.mcapUsd > 0 ? usd(t.mcapUsd, { compact: true }) : "?"}, liquidity ${onCurveLiq() ? `(paid into the Pons curve: ${raisedTxt()} of ${tiny(pons.threshold)} ${pons.pair.symbol})` : "(ETH/USDG side)"} ${liqText() ?? "?"}${!onCurveLiq() && t.liquidityUsd != null ? ` (pool total incl. the coin side ${usd(t.liquidityUsd, { compact: true })})` : ""}, 24h volume ${volText() ?? "?"}, holders ${hv ?? "?"}${hn ? ` (${hn})` : ""}, launchpad ${t.launchpad || "?"}. ${ctxGate} ${ctxNote}`.trim() } }));
  };
  tell();
  api.get(`/api/badge/${address}`).then((r) => {
    const checks = r.checks || [];
    tell(`Troya Gate: ${r.verdict}; ${checks.map((c) => `${c.label} ${c.status}`).join(", ")}.`);
    const word = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "Sell not tested" };
    // the Gate's own words for why the test sell waits (no buys yet, or every buyer sold), never a fixed "nobody bought":
    // Web Test Troya had a buy and a sell on 18 Nov and still read "Nobody has bought" here
    const sell = checks.find((c) => c.key === "sell");
    const waitNote = `${sell?.detail || r.reason || "The test sell waits until the curve holds buyers' money."}${r.checkedAt ? ` Checked ${ago(r.checkedAt)} ago.` : ""}`;
    paintChips(r.verdict || "unknown", r.verdict === "untested" ? "sell untested" : String(word[r.verdict] || r.verdict || "unknown").toLowerCase());
    if (!checks.length) { gVerdict.textContent = r.verdict === "untested" ? word.untested : "Not checked yet"; if (r.verdict === "untested") gNote.textContent = waitNote; return; }
    const pass = checks.filter((c) => c.status === "pass").length;
    gRing.className = `dk-ring tk2-ring v-${r.verdict}`;
    gRing.querySelector("b").textContent = `${pass}/${checks.length}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { gRing.querySelector(".rb").style.strokeDasharray = `${(pass / checks.length) * C} ${C}`; }));
    gVerdict.className = `dk-v v-${r.verdict}`;
    gVerdict.textContent = word[r.verdict] || r.verdict;
    if (r.verdict === "untested") gNote.textContent = waitNote;
    else if (r.checkedAt) gNote.textContent = `Checked ${ago(r.checkedAt)} ago. A snapshot, never a safe stamp.`;
    clear(gList, checks.map((c) => h("li", { class: `c-${c.status}` }, h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")), h("span", {}, c.label))));
    if (r.verdict === "passed") clear(gBuy, h("a", { class: "btn primary tk2-buy", href: `#/swap?out=${address}` }, icon("swap"), `Buy $${t.symbol} with Troya Swap`));
  }).catch(() => { gVerdict.textContent = "Gate unavailable"; paintChips("unknown", "unavailable"); });

  /* ---------- stats panel ---------- */
  const stat = (k, v, tip) => h("div", tip ? { title: tip } : {}, h("div", { class: "k" }, k), h("div", { class: "v" }, v ?? "–"));
  const statKids = () => {
    const [hv, hn] = holdersParts();
    return [
      t.stock
        ? h("div", { title: mcTip() }, h("div", { class: "k" }, "Tokenized on chain"), h("div", { class: "v" }, mcText() ?? "–"))
        : stat("Market cap", mcText(), mcTip()),
      stat("Liquidity", liqText(), liqTip()),
      stat("24h volume", volText()),
      stat("Trades 24h", t.txns24h != null ? h("span", {}, compact(t.txns24h, 1), t.buys24h != null ? h("small", { class: "tk2-sub" }, `${compact(t.buys24h, 1)} buys`) : null) : null),
      stat("Holders", hv != null ? h("span", {}, hv, hn ? h("small", { class: "tk2-sub" }, hn) : null) : null),
      stat("Top 10 hold", top10Text()),
      curve() ? stat("Curve raised", `${raisedTxt()} / ${tiny(pons.threshold)} ${pons.pair.symbol}`) : stat("1h change", t.change1h != null ? pctEl(t.change1h) : null),
      stat("Age", ageVal(), "How long ago the coin was created")];
  };
  const stats = h("section", { class: "panel tk-stats" }, statKids());
  const paintLive = () => { paintPx(); paintBadge(); paintStrip(); clear(stats, statKids()); tell(); };
  api.get(`/api/token-age/${address}`).then((r) => { if (r?.bornAt) { born = r.bornAt; paintStrip(); clear(stats, statKids()); } }).catch(() => {});

  // the largest wallets (the Holders tab), and on a young curve also the check behind "None yet"
  let holdersP = null, holdersAt = 0;
  const loadHolders = () => holdersP || (holdersP = api.get(`market/robinhood/holders?address=${address}`).then((r) => {
    if (chartStop) return;
    const creator = lc(launch?.creator || pons?.deployer || "");
    d.holders = (r.holders || []).map((x) => ({ ...x, isCreator: lc(x.address) === creator }));
    d.holdersCount = r.count; d.holdersTop10 = r.top10; d.holdersSource = r.source || "Blockscout"; d.holdersNote = r.note || null;
    // the server keeps one count for the stats and this tab; take it, so the two never differ
    if (r.count != null) t.holders = r.count;
    if (r.top10 != null) t.top10Pct = r.top10;
    holdersAt = Date.now();
    paintStrip(); clear(stats, statKids());
    if (curTab === "holders") renderTab("holders");
  }).catch((e) => { if (!chartStop && curTab === "holders" && !d.holders) clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, e.message))); })
    .finally(() => { holdersP = null; }));

  // the numbers again every 20 s while the page is in view (the server reads them at most every 30 s per coin): the
  // header price, the curve badge, the strip and the stats change in place, nothing reloads
  const LIVE_KEYS = ["priceUsd", "priceEth", "priceAt", "priceSource", "change1h", "change24h", "mcapUsd", "mcapEth", "supply", "liquidityUsd", "liquidityEth", "realLiquidityUsd", "realLiquidityEth", "volume24hUsd", "txns24h", "buys24h", "sells24h", "holders", "top10Pct"];
  let pxBusy = false;
  const refreshPx = async () => {
    if (pxBusy || document.hidden || chartStop) return;
    pxBusy = true;
    try {
      const r = await api.get(`market/robinhood/token?address=${address}`);
      if (chartStop || !r?.token) return;
      if (r.now) skew = Date.now() - r.now;
      if (r.ethUsd > 0) ethUsd = r.ethUsd;
      for (const k of LIVE_KEYS) if (k in r.token) t[k] = r.token[k];
      if (pons && r.pons) Object.assign(pons, r.pons);
      paintLive();
      // a holder count that moved on a young curve: read the list again, so "None yet" turns into the first buyer
      if (curve() && d.holders && t.holders != null && t.holders !== d.holdersCount && Date.now() - holdersAt > 60_000) loadHolders();
    } catch { /* the last numbers stay, with their age */ } finally { pxBusy = false; }
  };
  const pxT = setInterval(refreshPx, 20_000), atT = setInterval(paintAt, 5_000);

  const info = h("section", { class: "panel tk-info" },
    t.description ? h("p", { style: { margin: 0 } }, t.description) : null,
    h("div", { class: "rows", style: { margin: 0 } },
      launch?.creator ? h("div", {}, h("span", {}, "Creator"), h("span", { class: "mono" }, short(launch.creator, 4))) : null,
      pons && (!launch?.creator || lc(launch.creator) !== lc(pons.deployer)) ? h("div", {}, h("span", {}, launch?.creator ? "Deployed by" : "Creator"), h("span", { class: "mono" }, short(pons.deployer, 5))) : null,
      pons ? h("div", {}, h("span", {}, "Tax"), h("span", {}, `${Number((1 + (pons.fees.creatorTaxBps || 0) / 100).toFixed(2))}% per trade: 1% Pons fee (0.7% creator, 0.3% Pons)${pons.fees.creatorTaxBps ? ` + ${Number((pons.fees.creatorTaxBps / 100).toFixed(2))}% creator tax` : ""}`)) : null,
      pons ? h("div", {}, h("span", {}, "Curve pair"), h("span", {}, pons.pair.symbol)) : null,
      t.poolDex ? h("div", {}, h("span", {}, "Main pool"), h("span", {}, dexName(t.poolDex))) : null,
      t.pools?.length > 1 ? h("div", {}, h("span", {}, "Pools"), h("span", {}, String(t.pools.length))) : null),
    // the coin's own accounts are under its name and Pons, Fomo and DEX Screener on the Gate card: only the data sources here
    h("div", { class: "links" },
      h("a", { class: "link", href: d.links.geckoterminal, target: "_blank", rel: "noopener" }, "GeckoTerminal ↗"),
      h("a", { class: "link", href: d.links.explorer, target: "_blank", rel: "noopener" }, "Blockscout ↗")),
    h("p", { class: "fine", style: { margin: 0 } }, `Data: ${d.sources.join(" + ")}. This page is information, not a safety check. Ask the agent for a contract health read before trading.`));

  /* ---------- tabs ---------- */
  // a launchpad coin: Watchfire's labelled trades first. A stock or core token has no Watchfire board, so no Trades or
  // Early buyers tab (they read "No trades" next to 59K trades in the stats): its trades come from GeckoTerminal
  const tabList = stockish
    ? [{ value: "activity", label: "Trades (USD)" }, { value: "holders", label: "Holders" }, { value: "callouts", label: "Callouts and X" }]
    : [{ value: "trades", label: "Trades" }, { value: "callouts", label: "Callouts and X" }, { value: "holders", label: "Holders" }, { value: "early", label: "Early buyers" }, { value: "activity", label: "Activity (USD)" }];
  // V8 F41 stage 2: callouts (stamped at the price of the moment, graded at 24 h) and posts on X about this contract
  const loadCalls = async () => { try { calls = await api.get(`/api/callouts/${address}`); placeCalls?.(); if (curTab === "callouts") renderTab("callouts"); } catch { /* next round */ } };
  const tabBody = h("div", {}, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Reading this coin's trades…")));
  let curTab = stockish ? "activity" : "trades", tradeFilter = "all";
  // a phone shows 20 trades and a Show more (120 rows pushed the Gate and the stats a long scroll down); wider screens 120
  const narrow = () => matchMedia("(max-width: 560px)").matches;
  let tradeLimit = narrow() ? 20 : 120;
  const moreTrades = () => { tradeLimit = Math.min(120, tradeLimit + 40); renderTab(curTab); };
  const tabsEl = tabs(tabList, curTab, (v) => renderTab(v));
  const toTab = (v) => { tabsEl.set(v); renderTab(v); };

  // a Watchfire trade's size: GeckoTerminal's own USD and ETH for the same transaction and side when it lists it (the
  // Activity list), otherwise the coins × the chart's USD price in that bar, shown as an estimate
  const ethQuote = /^W?ETH$/i.test(String(t.quoteSymbol || "")) || pons?.pair?.address === "native";
  let gtFor = null, gtIdx = new Map();
  const gtTrade = (x) => {
    if (d.trades !== gtFor) {
      gtFor = d.trades; gtIdx = new Map();
      for (const g of d.trades || []) { const k = `${lc(g.tx)}:${g.side}`; gtIdx.set(k, gtIdx.has(k) ? null : g); }   // two in one tx: ambiguous
    }
    const g = gtIdx.get(`${lc(x.tx)}:${x.kind}`);
    return g && g.tokens > 0 && x.tokens > 0 && Math.abs(g.tokens / x.tokens - 1) < 0.02 ? g : null;
  };
  const sizeOf = (x) => {
    const g = gtTrade(x);
    if (g && g.usd != null) return { usd: g.usd, eth: ethQuote && g.quote > 0 ? g.quote : ethUsd ? g.usd / ethUsd : null, est: false };
    if (!(x.tokens > 0)) return null;
    const bt = snapTime(candleTimes, Date.now() / 1000 - (x.secsAgo || 0), IV_SECS[interval] || 3600);
    const px = (bt != null ? rowAt.get(bt)?.close : null) || t.priceUsd;
    if (!(px > 0)) return null;
    const u = x.tokens * px;
    return { usd: u, eth: ethUsd ? u / ethUsd : null, est: true };
  };

  function renderTab(v) {
    curTab = v;
    if (v === "trades") { renderTrades(tabBody, board, tradeFilter, (f) => { tradeFilter = f; renderTab("trades"); }, t.symbol, sizeOf, { limit: tradeLimit, more: moreTrades }); return; }
    if (v === "early") { renderEarly(tabBody, board); return; }
    if (v === "callouts") { if (!calls) { clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading callouts and posts on X…"))); loadCalls(); return; } renderCallouts(tabBody, calls, address, t.symbol, loadCalls); return; }
    if (v === "activity") {
      if (!d.trades) { clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading recent trades…"))); return; }
      if (!d.trades.length) {
        // GeckoTerminal lists no swaps of the main pool; on a Pons curve the buys and sells are on chain, in Trades
        clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, h("b", {}, "No trades in the main pool yet"),
          curve() && !stockish ? h("div", {}, "Buys and sells on the Pons curve are read from the chain by Watchfire, in the Trades tab.") : null,
          curve() && !stockish ? h("button", { class: "btn sm", type: "button", onclick: () => toTab("trades") }, "Open Trades") : null)));
        return;
      }
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Time"), h("th", { class: "l" }, "Side"), h("th", {}, "USD"), h("th", {}, t.symbol), h("th", { class: "l" }, "Trader"))),
        h("tbody", {}, d.trades.slice(0, tradeLimit).map((x) => h("tr", {},
          h("td", { class: "l muted" }, `${ago(x.t)} ago`),
          h("td", { class: `l ${x.side === "buy" ? "tk-trade-buy" : "tk-trade-sell"}` }, x.side === "buy" ? "Buy" : "Sell"),
          h("td", {}, x.usd != null ? usd(x.usd, { compact: x.usd >= 1e4 }) : "–"), h("td", {}, x.tokens != null ? compact(x.tokens, 2) : "–"),
          h("td", { class: "l mono muted" }, h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/tx/${x.tx}`, target: "_blank", rel: "noopener" }, short(x.trader, 4))))))))),
        d.trades.length > tradeLimit && tradeLimit < 120 ? h("div", { class: "mk-more" }, h("button", { class: "btn sm", type: "button", onclick: moreTrades }, "Show more")) : null,
        h("p", { class: "fine" }, "Most recent trades in the main pool, from GeckoTerminal."));
    } else if (!d.holders) {
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading the largest wallets…")));
      loadHolders();
    } else if (!d.holders.length) {
      // the per-wallet list is unavailable (Blockscout paused): the live count and top-10 share, said plainly
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" },
        h("b", {}, d.holdersCount != null ? `${d.holdersCount.toLocaleString("en-US")} holders` : "Holders"),
        d.holdersTop10 != null ? h("div", {}, `The 10 largest wallets hold ${Number(d.holdersTop10).toFixed(1)}% of the supply.`) : null,
        h("div", { class: "fine" }, d.holdersNote || "The list of top wallets is unavailable right now."))));
    } else {
      const max = Math.max(...d.holders.map((x) => x.pct || 0), 1);
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "#"), h("th", { class: "l" }, "Holder"), h("th", {}, "Balance"), h("th", {}, "Share"))),
        h("tbody", {}, d.holders.map((x, i) => h("tr", {},
          h("td", { class: "l rank" }, i + 1),
          h("td", { class: "l mono" }, h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/address/${x.address}`, target: "_blank", rel: "noopener" }, short(x.address, 5)),
            x.isCreator ? h("span", { class: "pad-tag warn" }, "dev / creator") : null, x.label ? h("span", { class: "pad-tag" }, x.label) : x.contract ? h("span", { class: "pad-tag" }, "contract") : null,
            ...((board?.holders || []).find((y) => lc(y.wallet) === lc(x.address))?.tags || []).filter((k) => k !== "whale").map(tagEl)),
          h("td", {}, x.balance != null ? compact(x.balance, 2) : "–"),
          h("td", {}, x.pct != null ? `${x.pct.toFixed(2)}%` : "–", h("span", { class: "tk-bar", style: { width: `${Math.max(2, ((x.pct || 0) / max) * 60)}px` } })))))))),
        h("p", { class: "fine" }, noWallets()
          ? `Only ${curve() ? "the curve" : "pools and contracts"} hold${curve() ? "s" : ""} this coin so far, from ${d.holdersSource || "Blockscout"}. The first buyer shows up here.`
          : `The ${d.holders.length} largest of ${d.holdersCount != null ? d.holdersCount.toLocaleString("en-US") : "all"} holders, from ${d.holdersSource || "Blockscout"}. Pools, lockers and the dead address are labelled; they are not people.`));
    }
  }
  function loadTrades() {
    const ac = new AbortController();
    const msg = (text, retry) => { if (curTab === "activity") clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, text, retry ? h("button", { class: "btn sm", type: "button", onclick: loadTrades }, icon("refresh"), "Try again") : null))); };
    const slowT = setTimeout(() => msg("Still loading recent trades from GeckoTerminal. Busy coins can take up to a minute."), 8000);
    const stopT = setTimeout(() => ac.abort(), 60000);
    api.get(`market/robinhood/trades?address=${address}`, { signal: ac.signal }).then((r) => {
      if (chartStop) return;
      d.trades = r.trades || [];
      if (curTab === "activity" || curTab === "trades") renderTab(curTab);   // Trades takes GeckoTerminal's exact sizes
    }).catch((e) => { if (!chartStop) msg(e.name === "AbortError" ? "Recent trades are taking too long to load." : "Recent trades are unavailable right now.", true); })
      .finally(() => { clearTimeout(slowT); clearTimeout(stopT); });
  }
  loadTrades();

  // F21: the chart oracle's latest note for this coin, when Troya has written one
  const orcCard = h("div", { hidden: true });
  api.get(`/api/oracle/coin/${address}`).then((r) => {
    const n = r?.note;
    if (!n || !n.text || chartStop) return;
    const lean = { up: "Leaning up", down: "Leaning down", sideways: "Sideways" }[n.call] || n.call;
    const span = n.resistance - n.support, pos = span > 0 ? Math.max(0, Math.min(1, (n.price - n.support) / span)) : 0.5;
    const dot = h("i", { style: { left: `${(pos * 100).toFixed(1)}%` } });
    orcCard.replaceWith(h("section", { class: `panel tk2-orc orc-${n.call}` },
      h("div", { class: "panel-h" }, panelTitle("Where the chart leans", "Chart oracle"), h("span", { class: "tk2-lean" }, lean)),
      h("p", { class: "tk2-orc-t" }, n.call === "up" ? `Leaning up toward $${tiny(n.resistance)}, support at $${tiny(n.support)}.` : n.call === "down" ? `Leaning down toward $${tiny(n.support)}, resistance at $${tiny(n.resistance)}.` : `Sideways between $${tiny(n.support)} and $${tiny(n.resistance)} more likely than a break.`),
      h("div", { class: "tk2-orc-r" }, dot),
      h("div", { class: "tk2-orc-e fine muted" }, h("span", {}, "$" + tiny(n.support)), h("span", {}, "$" + tiny(n.price) + " then"), h("span", {}, "$" + tiny(n.resistance))),
      h("p", { class: "fine muted tk2-orc-w" }, (n.why || []).join(" · ")),
      h("p", { class: "fine tk2-orc-f" }, `Written ${ago(n.at)}, graded 24 hours later in public. `, h("a", { class: "link", href: "/record#chart-oracle" }, "Every note"))));
    ctxNote = `Troya's chart note (${lean}, graded in public 24 h later): ${n.text}`; tell();
  }).catch(() => {});

  const wfCard = watchfirePanel();
  const trCard = stockish ? null : tributePanel(address);
  const tradeCard = t.tradable || pons ? tradePanel(t, address) : null;
  // the phone's sticky bar, just above the app's tab bar: Buy presets, Sell and the Gate chip. Every button opens Troya
  // Swap with the amount filled in, where the Gate runs and the user's own wallet signs: a bar that is always under the
  // thumb never sends a trade by itself (the Trade panel's two-tap Agent Wallet buttons stay in the page)
  const mbar = h("div", { class: "tk-mbar", role: "region", "aria-label": `Trade $${t.symbol}` },
    tradeCard ? [h("span", { class: "tk-mbar-l" }, "Buy"),
      [0.001, 0.005, 0.01].map((v) => h("a", { class: "tk-mbar-b", href: `#/swap?out=${address}&amount=${v}` }, `${v}`)),
      h("a", { class: "tk-mbar-s", href: `#/swap?in=${address}&out=ETH` }, "Sell")] : h("span", { class: "fine muted tk-mbar-l" }, "Not routed by Troya"),
    gChip("tk-mbar-g"));
  clear(view, back, head, actions,
    h("div", { class: "tk-grid" }, h("div", { class: "tk-main" }, chartPanel, h("div", { class: "tk-tabs" }, tabsEl, tabBody)), h("div", { class: "tk-side" }, tradeCard, gateCard, wfCard, trCard, orcCard, stats, info)), mbar);
  renderTab(curTab);
  if (!stockish) loadCalls();
  // a young curve: the holder list says whether anyone but the curve holds it yet ("None yet" in the stats)
  if (curve()) loadHolders();
  const callsT = setInterval(() => { if (!document.hidden && !stockish) loadCalls(); }, 60_000);
  const stopBoard = stockish ? () => {} : startBoard(address, (b) => {
    board = b; wfCard.update(b);
    if (curTab === "trades" || curTab === "early") renderTab(curTab);
    applyMarks();
  });
  if (stockish) wfCard.update({ level: "clear", why: ["Stock tokens and core tokens are not memecoins; Watchfire watches coins from launchpads and pools."] });
  view.classList.add("tk2");
  document.body.classList.add("tk-has-mbar");
  const offClass = () => { view.classList.remove("tk2"); document.body.classList.remove("tk-has-mbar"); };

  let chartSeq = 0, chartBusy = false;
  // callouts made while the chart's bars cover them (an older call has no bar to sit on)
  const callsOnChart = () => (calls?.callouts || []).filter((c) => c.at / 1000 >= (candleTimes[0] || 0) - (IV_SECS[interval] || 3600));
  async function loadChart() {
    const my = ++chartSeq, ac = new AbortController();
    placeCalls?.stop?.(); placeCalls = null; candleSeries = null; volSeries = null; chartEmpty = false; lineMode = false; lastC = null; paintQuiet({}, false);
    try { chart?.remove(); } catch {}
    chart = null;
    const wait = h("span", { class: "tk-chart-wait fine muted" });
    clear(chartBox, h("div", { class: "tk-chart-msg" }, h("div", { class: "sk", style: { height: "300px", width: "100%" } }), wait));
    const slowT = setTimeout(() => {
      const quiet = board && board.level !== "loading" && !(board.trades || []).length;
      wait.textContent = quiet ? "No trades on this coin in the last hours; checking GeckoTerminal for older price history…" : "Still loading the price history from GeckoTerminal…";
    }, 6000);
    const stopT = setTimeout(() => ac.abort(), 60000);
    try {
      const c = await api.get(`market/robinhood/candles?address=${address}&interval=${interval}`, { signal: ac.signal });
      clearTimeout(slowT); clearTimeout(stopT);
      if (chartStop || my !== chartSeq) return;
      // first load: when the default window holds no trades, the smallest longer interval that does (the server counts
      // each interval's window from the same trades, so this costs no extra read)
      if (autoIv) {
        autoIv = false;
        const w = c.windows, cur = c.interval || interval;
        const pick = w && w[cur] === 0 ? ["5m", "15m", "1h", "4h", "1d"].find((v) => IV_SECS[v] > IV_SECS[cur] && w[v] > 0) : null;
        if (pick) { interval = pick; ivSeg.set(pick); loadChart(); return; }
      }
      chartSrcName = c.source || ""; chartIv = c.interval || interval; paintSrc();
      const fresh = cleanRows(c.candles);
      if (fresh.length < 2) {
        chartEmpty = true;
        clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, fresh.length ? "Not enough trades for a chart yet" : "No trades yet"), h("span", {}, curve() ? "The chart starts once a few buys and sells land on the curve." : "The chart starts once a few swaps have been indexed.")));
        return;
      }
      const LW = await import("lightweight-charts");
      if (chartStop || my !== chartSeq) return;
      clear(chartBox);
      const l = isLight(), look = chartLook(l);
      chart = LW.createChart(chartBox, {
        autoSize: true,
        layout: { background: { type: "solid", color: "transparent" }, textColor: look.layout.textColor, fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11 },
        grid: look.grid,
        rightPriceScale: { ...look.rightPriceScale, scaleMargins: { top: 0.12, bottom: 0.22 } },
        timeScale: { ...look.timeScale, timeVisible: interval !== "1d" },
        crosshair: { mode: 1 },
        localization: { priceFormatter: fmtV },
      });
      chartK = unit === "mcap" ? supplyK() || 1 : 1;
      lineMode = isQuiet(c, fresh); lastC = c;
      const candles = lineMode
        ? chart.addLineSeries({ ...lineLook(l), lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: padScale, ...fmtOpts() })
        : chart.addCandlestickSeries({ ...candleLook(l), borderVisible: false, autoscaleInfoProvider: padScale, ...fmtOpts() });
      rows = fresh; rowAt = new Map(rows.map((x) => [x.time, x]));
      candles.setData(rows.map(pt));
      paintQuiet(c, lineMode);
      candleSeries = candles; candleTimes = rows.map((x) => x.time); applyMarks();
      // the callers' avatars sit on the bar of their call (same snapping as the marks) and follow scroll, zoom and resize
      placeCalls = calloutLayer(chartBox, chart, candles, callsOnChart, { ivSecs: IV_SECS[interval] || 3600, times: () => candleTimes, scale: () => chartK });
      if (rows.some((x) => x.volume != null)) {
        volSeries = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, color: "rgba(95,211,239,.25)", lastValueVisible: false, priceLineVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volSeries.setData(rows.map((x) => volBar(x, l)));
      }
      chart.timeScale().fitContent();
    } catch (e) {
      clearTimeout(slowT); clearTimeout(stopT);
      if (chartStop || my !== chartSeq) return;
      clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, e.name === "AbortError" ? "The chart is taking too long" : "The chart could not load"),
        h("span", {}, e.name === "AbortError" ? "GeckoTerminal has not answered for a minute." : e.message), h("button", { class: "btn sm", type: "button", onclick: loadChart }, icon("refresh"), "Try again")));
    }
  }
  // the newest bars every 30 s: the last bar changes in place (series.update) and a new one is appended; older bars stay
  // as drawn, so a zoomed or scrolled chart does not jump. A chart that had too few trades is drawn once it has two bars.
  async function refreshChart() {
    if (chartBusy || chartStop || document.hidden) return;
    if (!candleSeries && !chartEmpty) return;   // still loading, or an error that has its own Try again
    const my = chartSeq, iv = interval;
    chartBusy = true;
    try {
      const c = await api.get(`market/robinhood/candles?address=${address}&interval=${iv}`);
      if (chartStop || my !== chartSeq) return;
      const fresh = cleanRows(c.candles);
      if (!candleSeries) { if (fresh.length >= 2) loadChart(); return; }
      // a quiet coin that traded again is drawn as candles; otherwise its "last trade" line stays current
      if (lineMode && !isQuiet(c, fresh)) { loadChart(); return; }
      lastC = c;
      if (lineMode) paintQuiet(c, true);
      const lastT = rows.length ? rows[rows.length - 1].time : 0, l = isLight();
      let added = false;
      for (const x of fresh) {
        if (x.time < lastT) continue;
        if (x.time === lastT) rows[rows.length - 1] = x;
        else { rows.push(x); candleTimes.push(x.time); added = true; }
        rowAt.set(x.time, x);
        candleSeries.update(pt(x));
        volSeries?.update(volBar(x, l));
      }
      if (added) applyMarks();
      placeCalls?.();
    } catch { /* the drawn chart stays; next round */ } finally { chartBusy = false; }
  }
  loadChart();
  const chT = setInterval(refreshChart, 30_000);
  // back to the tab after a while: fresh numbers at once, not at the next tick
  const onVis = () => { if (!document.hidden) { refreshPx(); refreshChart(); } };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    chartStop = true; stopBoard(); clusterCard?.stop?.(); clearInterval(callsT); clearInterval(pxT); clearInterval(atT); clearInterval(chT);
    document.removeEventListener("visibilitychange", onVis); themeObs.disconnect(); placeCalls?.stop?.(); offClass();
    try { chart?.remove(); } catch {}
  };
}

// the coin's own accounts, as buttons (X, Telegram, website, Discord); nothing when the coin lists none
const SOC_PATH = { x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z", telegram: "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z", website: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a8.2 8.2 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4zm.81 2h2.95c.32 1.25.78 2.45 1.38 3.56A8 8 0 0 1 5.07 16zM8.02 8H5.07a8 8 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.02 8zM12 19.96A14.1 14.1 0 0 1 10.09 16h3.82A14.1 14.1 0 0 1 12 19.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm.26 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38a8.2 8.2 0 0 1 0 4z", discord: "M20.32 4.37A19.8 19.8 0 0 0 15.4 2.8a13.9 13.9 0 0 0-.63 1.3 18.3 18.3 0 0 0-5.5 0 13 13 0 0 0-.64-1.3 19.7 19.7 0 0 0-4.92 1.53C.6 9.05-.24 13.6.18 18.1a19.9 19.9 0 0 0 6.03 3.05c.49-.66.92-1.36 1.29-2.1a12.9 12.9 0 0 1-2.03-.97l.5-.39a14.2 14.2 0 0 0 12.06 0l.5.39c-.65.38-1.33.71-2.04.97.37.74.8 1.44 1.29 2.1a19.8 19.8 0 0 0 6.04-3.05c.5-5.22-.84-9.73-3.5-13.73zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42 2.18 1.09 2.16 2.42c0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42s.95-2.42 2.15-2.42 2.18 1.09 2.16 2.42c0 1.34-.95 2.42-2.16 2.42z" };
function socialRow(t) {
  const items = [["x", "X", t.twitter], ["telegram", "Telegram", t.telegram], ["website", "Website", t.website], ["discord", "Discord", t.discord]].filter(([, , u]) => u);
  // a stock token is a tokenized share, not a project with its own socials; WETH and USDG are core tokens
  if (!items.length && t.stock) return h("p", { class: "fine muted tk2-nosoc" }, `Tokenized ${String(t.name || t.symbol || "stock").replace(/\s•.*$/, "")} share on Robinhood Chain, issued through Robinhood.`);
  if (!items.length && t.hub) return h("p", { class: "fine muted tk2-nosoc" }, "A core token of Robinhood Chain, used as a base pair by its pools.");
  if (!items.length) return h("p", { class: "fine muted tk2-nosoc" }, "This coin lists no X, Telegram or website.");
  return h("div", { class: "tk2-soc" }, items.map(([k, label, u]) => {
    const a = h("a", { class: "tk2-soc-a", href: safeUrl(/^https?:/i.test(u) ? u : k === "x" ? `https://x.com/${String(u).replace(/^@/, "")}` : k === "telegram" ? `https://t.me/${String(u).replace(/^@/, "")}` : `https://${u}`), target: "_blank", rel: "noopener nofollow" });
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SOC_PATH[k]}"/></svg>`;
    a.append(label);
    return a;
  }));
}

// compact USD for a market cap: $950, $20.0K, $1.2M, $3.4B. step: the gap between two price-scale labels, which may
// ask for more decimals ($19.62M beside $19.64M on a tight scale)
const UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
function usdShort(v, step = 0) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v), u = UNITS.find(([x]) => a >= x);
  if (!u) return `$${a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : tiny(v, 3)}`;
  const n = v / u[0], sig = Math.abs(n) >= 100 ? 0 : 1;
  const need = step > 0 ? Math.max(0, Math.ceil(-Math.log10((step / u[0]) * 1.0001))) : 0;
  return `$${n.toFixed(Math.min(3, Math.max(sig, need)))}${u[1]}`;
}

const DEX = { "uniswap-v3": "Uniswap v3", "uniswap-v4": "Uniswap v4", "uniswap-v2": "Uniswap v2", "pons-v2": "Pons", pons: "Pons", metric: "Metric", ramses: "Ramses", kyberswap: "KyberSwap" };
function dexName(id) {
  const k = String(id || "").toLowerCase().replace(/-robinhood$/, "").replace(/-dex$/, "");
  return DEX[k] || k.split("-").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : "#"; } catch { return "#"; }
}
