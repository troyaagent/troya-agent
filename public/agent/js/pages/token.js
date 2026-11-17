// Token detail (#/token/<address>): price, chart, stats, holders, trades, links.
import { h, clear, useCss, icon, tokenIcon, padLogo, tiny, usd, compact, pctEl, short, ago, copyText, tabs, seg, emptyState } from "../ui.js";
import { api } from "../api.js";
import { padName, ethAmount, ageText } from "../marketlib.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export async function mount(view, { parts, go }) {
  useCss("home");
  useCss("market");
  const address = String(parts[0] || "").toLowerCase();
  const back = h("a", { class: "tk-back", href: "#/market" }, "← Market");
  if (!ADDR.test(address)) {
    clear(view, back, emptyState("That is not a token address.", "Token pages need a 0x… contract address on Robinhood Chain.", h("a", { class: "link", href: "#/market" }, "Back to the market")));
    return;
  }
  clear(view, back, h("div", { style: { padding: "40px 0" } }, h("div", { class: "sk", style: { height: "52px", width: "320px", marginBottom: "18px" } }), h("div", { class: "sk", style: { height: "380px" } })));

  let d;
  try { d = await api.get(`market/robinhood/token?address=${address}`); }
  catch (e) {
    clear(view, back, emptyState(e.status === 404 ? "This token is not on the Robinhood Chain board yet." : "The token could not be loaded.", e.message,
      h("div", { class: "row" }, h("a", { class: "link", href: "#/market" }, "Back to the market"), h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/token/${address}`, target: "_blank", rel: "noopener" }, "Look it up on Blockscout ↗"))));
    return;
  }
  const t = d.token;
  const pons = d.pons;
  let chart = null, ro = null, chartStop = false;

  const head = h("div", { class: "tk-head" },
    h("div", { class: "tk-id" }, tokenIcon({ ...t, chain: "robinhood" }),
      h("div", { style: { minWidth: 0 } },
        h("h1", {}, t.name || t.symbol, h("span", { class: "sym" }, `$${t.symbol}`), t.stock ? h("span", { class: "badge-s pad-badge" }, padLogo("stocks", 14), "Tokenized stock") : h("span", { class: "badge-s pad-badge" }, padLogo(t.launchpad, 14), padName(t.launchpad)),
          pons ? h("span", { class: `badge-s ${pons.graduated ? "blue" : ""}` }, pons.graduated ? "Graduated" : `Curve ${pons.progressPct != null ? pons.progressPct.toFixed(1) : "?"}%`) : null,
          !t.tradable ? h("span", { class: "badge-s warn" }, "Not routed by Troya") : null),
        h("div", { class: "tk-addr" }, h("span", { class: "mono tk2-ca" }, address), h("button", { type: "button", "aria-label": "Copy address", onclick: () => copyText(address, "Address copied") }, icon("copy"))))),
    h("div", { class: "tk-px" },
      h("div", { class: "p" }, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : pons?.priceInPair != null ? `${tiny(pons.priceInPair)} ${pons.pair.symbol}` : "No price yet"),
      h("div", { class: "u" }, t.priceEth != null ? `${tiny(t.priceEth)} ETH` : null, pctEl(t.change24h), h("span", { class: "faint" }, "24h"))));

  const actions = h("div", { class: "tk-act" },
    h("a", { class: "btn primary", href: `#/swap?out=${address}` }, icon("swap"), "Buy with Troya Swap"),
    h("a", { class: "btn", href: `#/gate/${address}` }, icon("shield"), "Run the Gate"),
    h("a", { class: "btn", href: `#/agent?q=${encodeURIComponent(`Give me a read on ${t.symbol} (${address}) on Robinhood Chain: liquidity, contract risk and recent flow.`)}` }, icon("spark"), "Ask about it"),
    h("button", { class: "btn ghost", type: "button", onclick: () => copyText(address, "Address copied") }, icon("copy"), "Copy address"));

  // chart
  const chartBox = h("div", { class: "tk-chart" });
  let interval = "1h";
  const ivSeg = seg(["15m", "1h", "4h", "1d"], interval, (v) => { interval = v; loadChart(); });
  const chartSrc = h("span", { class: "fine" });
  const chartPanel = h("section", { class: "panel" }, h("div", { class: "tk-chart-bar" }, ivSeg, chartSrc), chartBox);

  const C = 2 * Math.PI * 50;
  const gRing = h("span", { class: "dk-ring tk2-ring" });
  gRing.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${C}"/></svg><b>…</b>`;
  const gVerdict = h("span", { class: "dk-v" }, "Checking"), gNote = h("p", { class: "fine", style: { margin: "6px 0 0" } }, "A simulated buy and a test sell from a fresh address, the same checks Swap runs.");
  const gList = h("ul", { class: "tk2-checks" });
  const gateCard = h("section", { class: "panel tk2-gate" },
    h("div", { class: "panel-h" }, h("h2", {}, "Troya Gate"), h("a", { class: "link fine", href: `#/gate/${address}` }, "Full result")),
    h("div", { class: "tk2-gate-b" }, gRing, h("div", {}, gVerdict, gNote)), gList,
    h("a", { class: "btn primary tk2-buy", href: `#/swap?out=${address}` }, icon("swap"), `Buy $${t.symbol} with Troya Swap`),
    h("div", { class: "tk2-also" }, h("span", { class: "fine muted" }, "Also on"),
      t.launchpad === "pons" ? h("a", { class: "tk2-ext", href: `https://ponsfamily.com/launchpad/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/pons.svg", alt: "" }), "Pons") : null,
      h("a", { class: "tk2-ext", href: `https://fomo.family/tokens/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/fomo.png", alt: "" }), "Fomo"),
      h("a", { class: "tk2-ext", href: `https://dexscreener.com/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/dexscreener.png", alt: "" }), "DEX Screener")));
  const tell = (gateLine = "") => dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Token page for $${t.symbol} (${address})${t.stock ? ", a Robinhood stock token" : ""}: price ${t.priceUsd != null ? "$" + tiny(t.priceUsd) : "unknown"}, 24h ${t.change24h != null ? t.change24h.toFixed(1) + "%" : "?"}, liquidity ${t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : "?"}, 24h volume ${t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : "?"}, holders ${t.holders ?? "?"}, launchpad ${t.launchpad || "?"}. ${gateLine}` } }));
  tell();
  api.get(`/api/badge/${address}`).then((r) => {
    const checks = r.checks || [];
    tell(`Troya Gate: ${r.verdict}; ${checks.map((c) => `${c.label} ${c.status}`).join(", ")}.`);
    if (!checks.length) { gVerdict.textContent = "Not tested yet"; return; }
    const pass = checks.filter((c) => c.status === "pass").length;
    gRing.className = `dk-ring tk2-ring v-${r.verdict}`;
    gRing.querySelector("b").textContent = `${pass}/${checks.length}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { gRing.querySelector(".rb").style.strokeDasharray = `${(pass / checks.length) * C} ${C}`; }));
    gVerdict.className = `dk-v v-${r.verdict}`;
    gVerdict.textContent = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "Not tested yet" }[r.verdict] || r.verdict;
    if (r.checkedAt) gNote.textContent = `Checked ${ago(r.checkedAt)} ago. A snapshot, never a safe stamp.`;
    clear(gList, checks.map((c) => h("li", { class: `c-${c.status}` }, h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")), h("span", {}, c.label))));
  }).catch(() => { gVerdict.textContent = "Gate unavailable"; });

  const stat = (k, v) => h("div", {}, h("div", { class: "k" }, k), h("div", { class: "v" }, v ?? "–"));
  const stats = h("section", { class: "panel tk-stats" },
    stat("Market cap", t.mcapUsd != null ? `≈ ${usd(t.mcapUsd, { compact: true })}` : t.mcapEth != null ? ethAmount(t.mcapEth) : null),
    stat("Liquidity", t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : null),
    stat("24h volume", t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : null),
    stat("Trades 24h", t.txns24h != null ? `${compact(t.txns24h, 1)}${t.buys24h != null ? ` (${compact(t.buys24h, 1)} buys)` : ""}` : null),
    stat("Holders", t.holders != null ? compact(t.holders, 1) : null),
    stat("Top 10 hold", t.top10Pct != null ? `${Number(t.top10Pct).toFixed(1)}%` : null),
    pons && !pons.graduated ? stat("Curve raised", `${tiny(pons.raised)} / ${tiny(pons.threshold)} ${pons.pair.symbol}`) : stat("1h change", t.change1h != null ? pctEl(t.change1h) : null),
    stat("Age", t.createdAt ? ageText(t.createdAt) : null));

  const info = h("section", { class: "panel tk-info" },
    t.description ? h("p", { style: { margin: 0 } }, t.description) : null,
    h("div", { class: "rows", style: { margin: 0 } },
      pons ? h("div", {}, h("span", {}, "Creator"), h("span", { class: "mono" }, short(pons.deployer, 5))) : null,
      pons ? h("div", {}, h("span", {}, "Fees"), h("span", {}, `1% Pons fee${pons.fees.creatorTaxBps ? ` + ${(pons.fees.creatorTaxBps / 100).toFixed(2)}% creator tax` : ""}`)) : null,
      pons ? h("div", {}, h("span", {}, "Curve pair"), h("span", {}, pons.pair.symbol)) : null,
      t.poolDex ? h("div", {}, h("span", {}, "Main pool"), h("span", {}, t.poolDex.replace(/-robinhood$/, "").replace(/-/g, " "))) : null,
      t.pools?.length > 1 ? h("div", {}, h("span", {}, "Pools"), h("span", {}, String(t.pools.length))) : null),
    h("div", { class: "links" },
      t.website ? h("a", { class: "link", href: safeUrl(t.website), target: "_blank", rel: "noopener nofollow" }, "Website ↗") : null,
      t.twitter ? h("a", { class: "link", href: safeUrl(t.twitter), target: "_blank", rel: "noopener nofollow" }, "X ↗") : null,
      t.telegram ? h("a", { class: "link", href: safeUrl(t.telegram), target: "_blank", rel: "noopener nofollow" }, "Telegram ↗") : null,
      d.links.pons ? h("a", { class: "link", href: d.links.pons, target: "_blank", rel: "noopener" }, "Pons ↗") : null,
      h("a", { class: "link", href: d.links.dexscreener, target: "_blank", rel: "noopener" }, "DexScreener ↗"),
      h("a", { class: "link", href: d.links.geckoterminal, target: "_blank", rel: "noopener" }, "GeckoTerminal ↗"),
      h("a", { class: "link", href: d.links.explorer, target: "_blank", rel: "noopener" }, "Blockscout ↗")),
    h("p", { class: "fine", style: { margin: 0 } }, `Data: ${d.sources.join(" + ")}. This page is information, not a safety check. Ask the agent for a contract health read before trading.`));

  // activity / holders tabs (only where a source serves them)
  const tabList = [{ value: "activity", label: "Activity" }];
  const tabBody = h("div", {}, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading recent trades…")));
  const tabsEl = tabs(tabList, "activity", (v) => renderTab(v));
  function renderTab(v) {
    if (v === "activity") {
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Time"), h("th", { class: "l" }, "Side"), h("th", {}, "USD"), h("th", {}, t.symbol), h("th", { class: "l" }, "Trader"))),
        h("tbody", {}, d.trades.map((x) => h("tr", {},
          h("td", { class: "l muted" }, `${ago(x.t)} ago`),
          h("td", { class: `l ${x.side === "buy" ? "tk-trade-buy" : "tk-trade-sell"}` }, x.side === "buy" ? "Buy" : "Sell"),
          h("td", {}, x.usd != null ? usd(x.usd, { compact: x.usd >= 1e4 }) : "–"), h("td", {}, x.tokens != null ? compact(x.tokens, 2) : "–"),
          h("td", { class: "l mono muted" }, h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/tx/${x.tx}`, target: "_blank", rel: "noopener" }, short(x.trader, 4))))))))),
        h("p", { class: "fine" }, "Most recent trades in the main pool, from GeckoTerminal."));
    } else {
      const max = Math.max(...d.holders.map((x) => x.pct || 0), 1);
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "#"), h("th", { class: "l" }, "Holder"), h("th", {}, "Balance"), h("th", {}, "Share"))),
        h("tbody", {}, d.holders.map((x, i) => h("tr", {},
          h("td", { class: "l rank" }, i + 1),
          h("td", { class: "l mono" }, short(x.address, 5), x.isCreator ? h("span", { class: "pad-tag" }, "creator") : null),
          h("td", {}, x.balance != null ? compact(x.balance, 2) : "–"),
          h("td", {}, x.pct != null ? `${x.pct.toFixed(2)}%` : "–", h("span", { class: "tk-bar", style: { width: `${Math.max(2, ((x.pct || 0) / max) * 60)}px` } })))))))),
        h("p", { class: "fine" }, "Top holders. Pool and contract addresses can appear in this list."));
    }
  }
  api.get(`market/robinhood/trades?address=${address}`).then((r) => {
    if (chartStop) return;
    d.trades = r.trades || [];
    if (d.trades.length) renderTab("activity");
    else clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "No recent trades in the main pool.")));
  }).catch(() => { if (!chartStop) clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Recent trades are unavailable right now."))); });

  clear(view, back, head, actions,
    h("div", { class: "tk-grid" }, h("div", {}, chartPanel, tabsEl ? h("div", { class: "tk-tabs" }, tabsEl, tabBody) : null), h("div", { class: "tk-side" }, gateCard, stats, info)));
  view.classList.add("tk2");
  const offClass = () => view.classList.remove("tk2");

  async function loadChart() {
    clear(chartBox, h("div", { class: "tk-chart-msg" }, h("div", { class: "sk", style: { height: "300px", width: "100%" } })));
    try {
      const c = await api.get(`market/robinhood/candles?address=${address}&interval=${interval}`);
      if (chartStop) return;
      chartSrc.textContent = `${c.source} · ${c.interval} candles · priced in USD`;
      if (!c.candles?.length || c.candles.length < 2) {
        clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, "No price history yet"), h("span", {}, pons && !pons.graduated ? "Not enough trades on the curve yet for a chart." : "Not enough swaps have been indexed for a chart.")));
        return;
      }
      const LW = await import("lightweight-charts");
      if (chartStop) return;
      clear(chartBox);
      try { chart?.remove(); } catch {}
      chart = LW.createChart(chartBox, {
        autoSize: true,
        layout: { background: { type: "solid", color: "transparent" }, textColor: "#748b94", fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11 },
        grid: { vertLines: { color: "rgba(29,45,52,.35)" }, horzLines: { color: "rgba(29,45,52,.35)" } },
        rightPriceScale: { borderColor: "#142026", scaleMargins: { top: 0.12, bottom: 0.22 } },
        timeScale: { borderColor: "#142026", timeVisible: interval !== "1d" },
        crosshair: { mode: 1 },
        localization: { priceFormatter: (p) => (p < 0 ? "" : p < 1e-15 ? "0" : tiny(p, 4)) },
      });
      const candles = chart.addCandlestickSeries({ upColor: "#5fd3ef", downColor: "#ff6b7d", borderVisible: false, wickUpColor: "#5fd3ef", wickDownColor: "#ff6b7d", priceFormat: { type: "custom", formatter: (p) => (p < 0 ? "" : p < 1e-15 ? "0" : tiny(p, 4)), minMove: 1e-12 } });
      const seen = new Set();
      const rows = c.candles.filter((x) => !seen.has(x.time) && seen.add(x.time)).sort((a, b) => a.time - b.time);
      candles.setData(rows.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
      if (rows.some((x) => x.volume != null)) {
        const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, color: "rgba(95,211,239,.25)", lastValueVisible: false, priceLineVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(rows.map((x) => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? "rgba(95,211,239,.28)" : "rgba(255,107,125,.28)" })));
      }
      chart.timeScale().fitContent();
    } catch (e) {
      clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, "The chart could not load"), h("span", {}, e.message)));
    }
  }
  loadChart();
  return () => { chartStop = true; offClass(); try { chart?.remove(); } catch {} ro?.disconnect(); };
}

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : "#"; } catch { return "#"; }
}
