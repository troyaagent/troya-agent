// Perps desk: Hyperliquid chart, order book, order ticket (own-wallet trading key), Troya Gate, positions.
import { h, clear, icon, pageHead, table, review, toast, modal, num, fixed, usd, compact, pct, pctEl, short, useCss, every, debounce, store, coinIcon } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, ensureChain } from "../wallet.js";
import { getTradingKey, tradingKeyStatus, approveTradingKey, revokeTradingKey, placeOrder, cancelOrder, sendToDex } from "../hl.js";
import { sendTx } from "../chain.js";
// F16: trade.xyz markets (stocks, indices, metals) sit beside the Hyperliquid perps; their margin is a separate balance
const nameOf = (m) => (m?.dex ? `${m.label} · trade.xyz` : `${m?.coin}-PERP`);

const IVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const prefs = store("troya.perps", { interval: "1h", unit: "USD", lev: {} });
// local fallback limits when the server policy is unavailable (the server re-checks Agent Wallet actions itself)
const DEFAULT_LIMITS = { maxLeverage: 20, perTradeUsd: 25000, dailyUsd: null, allowedCoins: null, source: "local defaults" };

const pxDecimals = (p) => (!p ? 2 : p >= 10000 ? 0 : p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 7);
// fixed decimals, so the book, the axis and the header line up digit for digit (383.60 under 383.61)
// a cap reads as a round number: $25K, $2.5K, $500 (not $25.0K)
const capUsd = (v) => (v >= 1000 ? `$${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : usd(v));
const fmtPx = (p) => (p == null || !isFinite(p) ? "–" : fixed(p, pxDecimals(p)));

function readPolicy(p) {
  // /api/policy returns { operator, user, effective: { maxLeverage, perTradeUsd, dailyUsd, allowedPerps, paused, killSwitch }, usedTodayUsd }
  const src = p?.effective || p?.policy || p?.limits || p || {};
  const pick = (...keys) => { for (const k of keys) { const v = src[k] ?? p?.[k]; if (v != null && v !== "") return v; } return null; };
  const n = (v) => (v == null ? NaN : Number(v));                 // a missing value is unknown, never 0
  const lev = n(pick("maxLeverage", "leverageCap", "max_leverage"));
  const per = n(pick("perTradeUsd", "maxTradeUsd", "maxOrderUsd", "per_trade_usd"));
  const daily = n(pick("dailyUsd", "dailyCapUsd", "daily_usd"));
  const used = n(p?.usedTodayUsd);
  const leftRaw = n(pick("dailyLeftUsd", "remainingTodayUsd", "leftTodayUsd"));
  const left = isFinite(leftRaw) ? leftRaw : daily > 0 && isFinite(used) ? Math.max(0, daily - used) : NaN;
  const coins = pick("allowedCoins", "allowedMarkets", "allowedPerps", "markets");
  return {
    maxLeverage: lev > 0 ? lev : DEFAULT_LIMITS.maxLeverage,
    perTradeUsd: per > 0 ? per : DEFAULT_LIMITS.perTradeUsd,
    dailyUsd: daily > 0 ? daily : null,
    dailyLeftUsd: left >= 0 && isFinite(left) ? left : null,
    allowedCoins: Array.isArray(coins) && coins.length ? coins.map((c) => String(c).toUpperCase()) : null,
    paused: !!pick("paused") || !!pick("killSwitch"),
    source: "your policy",
  };
}

// walk the book to estimate the average fill for a given coin size
function walk(levels, size) {
  let left = size, cost = 0;
  for (const l of levels) { const take = Math.min(left, l.sz); cost += take * l.px; left -= take; if (left <= 1e-12) break; }
  const filled = size - Math.max(0, left);
  return { avg: filled > 0 ? cost / filled : null, complete: left <= 1e-12 };
}

export async function mount(view, ctx) {
  useCss("perps");
  const stops = [];
  let alive = true;
  const st = {
    coin: (ctx.parts[0] || "BTC").toUpperCase().replace(/-PERP$/, ""),
    markets: [], m: null, book: { bids: [], asks: [] }, user: null, limits: { ...DEFAULT_LIMITS },
    side: "long", type: "market", unit: prefs.get().unit || "USD", lev: null, interval: prefs.get().interval || "1h",
    key: { state: "none" }, lastOk: 0,
  };

  /* ---------- layout ---------- */
  const mktBtn = h("button", { class: "pp-mkt", type: "button", "aria-label": "Choose market", onclick: () => pickMarket() });
  const pxEl = h("span", { class: "pp-px" }, "–");
  const chgEl = h("span", {});
  const stat = (k) => { const v = h("span", {}, "–"); return [h("div", { class: "pp-stat" }, h("span", { class: "k" }, k), v), v]; };
  const [sFund, vFund] = stat("Funding / hr");
  const [sVol, vVol] = stat("24h volume");
  const [sOi, vOi] = stat("Open interest");
  const [sOr, vOr] = stat("Oracle");
  const live = h("span", { class: "pp-live" }, h("i", { class: "dot" }), "Live");

  const ivals = h("div", { class: "pp-ivals", role: "group", "aria-label": "Chart interval" });
  const chartBox = h("div", { class: "pp-chart-box" }, h("div", { class: "pp-chart-msg" }, "Loading chart…"));
  const bookBids = h("div", {}), bookAsks = h("div", {});
  const spreadEl = h("span", { class: "muted" }, "");
  const posBox = h("div", {});

  const ticket = h("div", { class: "panel pp-ticket" });
  clear(view, h("div", { class: "pp" },
    h("div", { class: "pp-head" }, mktBtn, h("div", { class: "row", style: { gap: "10px" } }, pxEl, chgEl), sFund, sVol, sOi, sOr, live),
    h("div", { class: "pp-grid" },
      h("div", { class: "pp-left" },
        h("section", { class: "panel pp-chart", "aria-label": "Price chart" }, ivals, chartBox),
        h("section", { class: "panel pp-book", "aria-label": "Order book" },
          h("div", { class: "panel-h" }, h("h2", {}, "Order book"), spreadEl),
          h("div", { class: "panel-b" }, h("div", { class: "pp-book-cols" },
            h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Bids"), h("span", {}, "Size")), bookBids),
            h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Asks"), h("span", {}, "Size")), bookAsks)))),
        h("section", { class: "panel pp-pos", "aria-label": "Your positions" }, posBox)),
      ticket)));

  /* ---------- markets + header ---------- */
  async function loadMeta() {
    const r = await api.get("hl/meta?all=1");
    st.markets = r.markets.filter((m) => !m.isDelisted);
    const m = st.markets.find((x) => x.coin.toUpperCase() === String(st.coin).toUpperCase()) || st.markets.find((x) => x.coin === "BTC");
    if (!st.m || m.coin !== st.m.coin) { st.coin = m.coin; }
    st.m = m;
    if (st.lev == null) st.lev = Math.min(prefs.get().lev?.[m.coin] || 3, m.maxLeverage, st.limits.maxLeverage);
    st.lastOk = Date.now();
    renderHead();
  }
  function renderHead() {
    const m = st.m;
    if (!m) return;
    clear(mktBtn, coinIcon(m.coin, "pp-coin"), nameOf(m), icon("arrowRight"));
    mktBtn.lastChild.style.transform = "rotate(90deg)";
    pxEl.textContent = fmtPx(m.markPx);
    clear(chgEl, pctEl(m.change24h));
    vFund.textContent = m.funding == null ? "–" : `${m.funding >= 0 ? "+" : ""}${(m.funding * 100).toFixed(4)}%`;
    vFund.className = m.funding > 0 ? "up" : m.funding < 0 ? "down" : "";
    vVol.textContent = usd(m.dayNtlVlm, { compact: true, d: 2 });
    vOi.textContent = usd(m.openInterestUsd, { compact: true, d: 2 });
    vOr.textContent = fmtPx(m.oraclePx);
    document.title = `${fmtPx(m.markPx)} ${nameOf(m)} · Troya Agent`;
  }
  stops.push(every(1000, () => live.classList.toggle("stale", Date.now() - st.lastOk > 15000)));

  function pickMarket() {
    const q = h("input", { class: "input", placeholder: "Search a market (BTC, ETH, NVDA, GOLD…)", "aria-label": "Search markets" });
    const list = h("div", { class: "pp-pick-list" });
    let sel = 0, group = st.m?.dex ? "xyz" : "all";
    const groupSeg = h("div", { class: "seg pp-pick-g" });
    const drawGroups = () => clear(groupSeg, [["all", "All"], ["crypto", "Crypto"], ["xyz", "Stocks, indices & metals · trade.xyz"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(group === v), onclick: () => { group = v; sel = 0; drawGroups(); render(); } }, t)));
    const rows = () => {
      const s = q.value.trim().toUpperCase();
      return st.markets.filter((m) => (group === "all" || (group === "xyz" ? m.dex === "xyz" : !m.dex)) && (!s || m.coin.toUpperCase().includes(s) || (m.label || "").toUpperCase().includes(s)))
        .sort((a, b) => (b.dayNtlVlm || 0) - (a.dayNtlVlm || 0)).slice(0, 150);
    };
    const choose = (m) => { md.close(); ctx.go(`#/perps/${m.coin}`); };
    const render = () => {
      const rs = rows();
      sel = Math.min(sel, Math.max(0, rs.length - 1));
      clear(list, h("div", { class: "pp-pick-row pp-pick-hd" }, h("b", {}, "Market"), h("span", {}, "Price"), h("span", {}, "24h"), h("span", { class: "vol" }, "Volume")),
        rs.length ? rs.map((m, i) => h("button", { type: "button", class: `pp-pick-row ${i === sel ? "sel" : ""}`, onclick: () => choose(m) },
          h("b", {}, coinIcon(m.coin, "sm"), m.dex ? m.label : `${m.coin}-PERP`, m.dex ? h("small", { class: "pp-xyz" }, "trade.xyz") : null, h("small", {}, `${m.maxLeverage}x`)), h("span", {}, fmtPx(m.markPx)), h("span", { class: m.change24h >= 0 ? "up" : "down" }, pct(m.change24h)), h("span", { class: "vol muted" }, usd(m.dayNtlVlm, { compact: true }))))
          : h("div", { class: "empty" }, "No market matches."));
    };
    q.addEventListener("input", () => { sel = 0; render(); });
    q.addEventListener("keydown", (e) => {
      const rs = rows();
      if (e.key === "ArrowDown") { sel = Math.min(rs.length - 1, sel + 1); render(); e.preventDefault(); }
      if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      if (e.key === "Enter" && rs[sel]) choose(rs[sel]);
    });
    const md = modal({ title: "Perps markets", wide: true, body: h("div", { class: "pp-pick" }, q, groupSeg, list) });
    drawGroups();
    render();
    setTimeout(() => q.focus(), 40);
  }

  /* ---------- chart ---------- */
  let chart = null, candles = null, volume = null, lastBar = null, themeObs = null;
  // the chart follows the theme: hairline grid and ink text on the light page, the dark set on the dark one
  const isLight = () => document.documentElement.dataset.theme === "light";
  const chartLook = (light) => ({
    layout: { background: { type: "solid", color: "transparent" }, textColor: light ? "#6e685f" : "#748b94", fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: light ? "rgba(0,0,0,.05)" : "rgba(20,32,38,.6)" }, horzLines: { color: light ? "rgba(0,0,0,.05)" : "rgba(20,32,38,.6)" } },
    rightPriceScale: { borderColor: light ? "rgba(0,0,0,.08)" : "#142026" },
    timeScale: { borderColor: light ? "rgba(0,0,0,.08)" : "#142026", timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0, vertLine: { color: light ? "rgba(0,0,0,.25)" : "#2a3e47", labelBackgroundColor: light ? "#3d3a35" : "#0f181c" }, horzLine: { color: light ? "rgba(0,0,0,.25)" : "#2a3e47", labelBackgroundColor: light ? "#3d3a35" : "#0f181c" } },
  });
  const candleLook = (light) => (light ? { upColor: "#0a7ea3", downColor: "#c8303f", wickUpColor: "#0a7ea3", wickDownColor: "#c8303f" } : { upColor: "#8edff5", downColor: "#ff7d8a", wickUpColor: "#8edff5", wickDownColor: "#ff7d8a" });
  const volColor = (up, light) => (light ? (up ? "rgba(10,126,163,.22)" : "rgba(200,48,63,.2)") : (up ? "rgba(95,211,239,.28)" : "rgba(255,107,125,.28)"));
  async function initChart() {
    let LW;
    try { LW = await import("lightweight-charts"); } catch { clear(chartBox, h("div", { class: "pp-chart-msg" }, "Chart library failed to load.")); return; }
    if (!alive) return;
    clear(chartBox);
    const light = isLight();
    // the axis and the last-price tag use the same grouped format as the header (64,854 not 64854)
    chart = LW.createChart(chartBox, { autoSize: true, ...chartLook(light), localization: { priceFormatter: fmtPx } });
    candles = chart.addCandlestickSeries({ ...candleLook(light), borderVisible: false });
    // volume sits under the candles without its own tag on the price axis (a red "67.92" there reads like a price)
    volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", color: "rgba(95,211,239,.25)", lastValueVisible: false, priceLineVisible: false });
    themeObs = new MutationObserver(() => {
      if (!chart) return;
      const l = isLight();
      chart.applyOptions(chartLook(l));
      candles.applyOptions(candleLook(l));
      loadCandles(true);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    await loadCandles(true);
  }
  function renderIvals() {
    clear(ivals, IVALS.map((iv) => h("button", { type: "button", "aria-pressed": String(iv === st.interval), onclick: () => { st.interval = iv; prefs.set({ ...prefs.get(), interval: iv }); renderIvals(); loadCandles(true); } }, iv)));
  }
  async function loadCandles(full) {
    if (!candles || !st.coin) return;
    try {
      const from = !full && lastBar ? lastBar.t : 0;
      const r = await api.get(`hl/candles?coin=${st.coin}&interval=${st.interval}${from ? `&from=${from}` : ""}`);
      if (!alive || r.coin !== st.coin || r.interval !== st.interval) return;
      const toBar = (c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c });
      const light = isLight();
      const toVol = (c) => ({ time: Math.floor(c.t / 1000), value: c.v, color: volColor(c.c >= c.o, light) });
      const p = st.m?.markPx || r.candles.at(-1)?.c;
      const d = pxDecimals(p);
      candles.applyOptions({ priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
      if (full || !lastBar) {
        candles.setData(r.candles.map(toBar));
        volume.setData(r.candles.map(toVol));
        chart.timeScale().fitContent();
        if (r.candles.length > 120) chart.timeScale().setVisibleLogicalRange({ from: r.candles.length - 120, to: r.candles.length + 4 });
      } else {
        for (const c of r.candles) if (c.t >= lastBar.t) { candles.update(toBar(c)); volume.update(toVol(c)); }
      }
      lastBar = r.candles.at(-1) || lastBar;
      if (!r.candles.length) clear(chartBox, h("div", { class: "pp-chart-msg" }, "No candles for this market yet."));
    } catch (e) { if (full) toast(`Chart: ${e.message}`, "error"); }
  }

  /* ---------- order book ---------- */
  async function loadBook() {
    if (!st.coin) return;
    try {
      const b = await api.get(`hl/book?coin=${st.coin}`);
      if (!alive || b.coin !== st.coin) return;
      st.book = b;
      st.lastOk = Date.now();
      renderBook();
      renderTicket(false);
    } catch {}
  }
  function renderBook() {
    const N = 10;
    const bids = st.book.bids.slice(0, N), asks = st.book.asks.slice(0, N);
    const max = Math.max(...bids.map((l) => l.sz), ...asks.map((l) => l.sz), 1e-9);
    const sz = (v) => fixed(v, Math.min(st.m?.szDecimals ?? 4, 5));   // the market's own size step, so the column lines up
    const row = (l, cls) => h("div", { class: `pp-lv ${cls}`, title: "Use this price", onclick: () => { st.type = "limit"; limitIn.value = l.px; renderTicket(); } },
      h("i", { style: { width: `${(l.sz / max) * 100}%` } }), h("span", { class: "p" }, fmtPx(l.px)), h("span", {}, sz(l.sz)));
    clear(bookBids, bids.map((l) => row(l, "bid")));
    clear(bookAsks, asks.map((l) => row(l, "ask")));
    if (bids[0] && asks[0]) { const s = asks[0].px - bids[0].px; spreadEl.textContent = `Spread ${((s / asks[0].px) * 100).toFixed(3)}%`; }
  }

  /* ---------- account ---------- */
  async function loadUser() {
    if (!wallet.address) { st.user = null; renderPositions(); renderTicket(false); return; }
    try { st.user = await api.get(`hl/user?address=${wallet.address}`); } catch { st.user = null; }
    if (!alive) return;
    renderPositions();
    renderTicket(false);
  }
  async function loadKey() {
    st.key = wallet.address ? await tradingKeyStatus(wallet.address) : { state: "none" };
    if (alive) renderTicket(false);
  }
  async function loadPolicy() {
    try { st.limits = wallet.session ? readPolicy(await api.get("policy")) : { ...DEFAULT_LIMITS }; } catch { st.limits = { ...DEFAULT_LIMITS }; }
    if (st.m) st.lev = Math.min(st.lev ?? 3, st.m.maxLeverage, st.limits.maxLeverage);
    if (alive) renderTicket();
  }

  let posTab = "positions";
  function renderPositions() {
    const tabsEl = h("div", { class: "tabs", role: "tablist" }, [["positions", "Positions"], ["orders", "Open orders"], ["fills", "Fills"]].map(([v, t]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(posTab === v), onclick: () => { posTab = v; renderPositions(); } }, t,
        st.user && v === "positions" && st.user.positions.length ? ` (${st.user.positions.length})` : st.user && v === "orders" && st.user.openOrders.length ? ` (${st.user.openOrders.length})` : "")));
    let body;
    if (!wallet.address) body = h("div", { class: "empty" }, "Connect a wallet to see your Hyperliquid positions.", h("button", { class: "btn", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"));
    else if (!st.user) body = h("div", { class: "empty" }, "Reading your Hyperliquid account…");
    else if (posTab === "positions") {
      const t = table({ emptyText: "No open positions.", cols: [
        { key: "coin", label: "Market", align: "l", render: (p) => h("a", { class: "link tok-link", href: `#/perps/${p.coin}` }, coinIcon(p.coin, "sm"), `${p.coin}-PERP`) },
        { key: "side", label: "Side", render: (p) => h("span", { class: p.size > 0 ? "side-l" : "side-s" }, p.size > 0 ? "Long" : "Short", p.leverage ? ` ${p.leverage}x` : "") },
        { key: "size", label: "Size", render: (p) => num(Math.abs(p.size), 5) },
        { key: "val", label: "Value", render: (p) => usd(p.positionValue) },
        { key: "entry", label: "Entry", render: (p) => fmtPx(p.entryPx) },
        { key: "mark", label: "Mark", render: (p) => fmtPx(st.markets.find((m) => m.coin === p.coin)?.markPx) },
        { key: "pnl", label: "PnL (ROE)", render: (p) => h("span", { class: p.unrealizedPnl >= 0 ? "up" : "down" }, `${p.unrealizedPnl >= 0 ? "+" : ""}${usd(p.unrealizedPnl)} (${pct(p.returnOnEquity * 100)})`) },
        { key: "liq", label: "Liq. price", render: (p) => fmtPx(p.liquidationPx) },
        { key: "act", label: "", render: (p) => h("button", { class: "btn sm", type: "button", onclick: (e) => { e.stopPropagation(); closePosition(p); } }, "Close") },
      ] });
      t.setRows(st.user.positions);
      body = t;
    } else if (posTab === "orders") {
      const t = table({ emptyText: "No open orders.", cols: [
        { key: "coin", label: "Market", align: "l", render: (o) => h("span", { class: "tok-link" }, coinIcon(o.coin, "sm"), `${o.coin}-PERP`) },
        { key: "side", label: "Side", render: (o) => h("span", { class: o.side === "buy" ? "side-l" : "side-s" }, o.side === "buy" ? "Buy" : "Sell") },
        { key: "type", label: "Type", render: (o) => `${o.orderType || "Limit"}${o.reduceOnly ? " · reduce" : ""}` },
        { key: "px", label: "Price", render: (o) => (o.isTrigger ? `trigger ${fmtPx(o.triggerPx)}` : fmtPx(o.limitPx)) },
        { key: "size", label: "Size", render: (o) => num(o.size, 5) },
        { key: "age", label: "Placed", render: (o) => new Date(o.timestamp).toLocaleString() },
        { key: "act", label: "", render: (o) => h("button", { class: "btn sm", type: "button", onclick: (e) => { e.stopPropagation(); cancel(o); } }, "Cancel") },
      ] });
      t.setRows(st.user.openOrders);
      body = t;
    } else {
      const t = table({ emptyText: "No fills yet.", cols: [
        { key: "time", label: "Time", align: "l", render: (f) => new Date(f.time).toLocaleString() },
        { key: "coin", label: "Market", render: (f) => h("span", { class: "tok-link" }, coinIcon(f.coin, "sm"), f.coin) },
        { key: "dir", label: "Direction", render: (f) => f.dir || f.side },
        { key: "px", label: "Price", render: (f) => fmtPx(f.px) },
        { key: "size", label: "Size", render: (f) => num(f.size, 5) },
        { key: "pnl", label: "Closed PnL", render: (f) => h("span", { class: f.closedPnl > 0 ? "up" : f.closedPnl < 0 ? "down" : "muted" }, usd(f.closedPnl)) },
        { key: "fee", label: "Fee", render: (f) => usd(f.fee) },
      ] });
      t.setRows(st.user.fills.filter((f) => !f.coin.startsWith("@")).slice(0, 40));
      body = t;
    }
    clear(posBox, h("div", { class: "panel-h" }, h("h2", {}, "Your Hyperliquid account"), st.user ? h("span", { class: "muted", style: { fontSize: "12px" } }, `Account value ${usd(st.user.accountValue)} · withdrawable ${usd(st.user.withdrawable)}`) : null), tabsEl, h("div", { style: { padding: "0 6px 8px" } }, body));
  }

  /* ---------- ticket ---------- */
  const sizeIn = h("input", { class: "input", inputmode: "decimal", placeholder: "0.00", "aria-label": "Order size" });
  const limitIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Limit price", "aria-label": "Limit price" });
  const tpIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Take profit", "aria-label": "Take-profit price" });
  const slIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Stop loss", "aria-label": "Stop-loss price" });
  const reduceIn = h("input", { type: "checkbox" });
  const levIn = h("input", { class: "pp-range", type: "range", min: "1", step: "1", "aria-label": "Leverage" });
  let advOpen = false;
  [sizeIn, limitIn, tpIn, slIn].forEach((el) => el.addEventListener("input", debounce(() => renderTicket(false), 120)));
  reduceIn.addEventListener("change", () => renderTicket(false));
  levIn.addEventListener("input", () => { st.lev = +levIn.value; const p = prefs.get(); prefs.set({ ...p, lev: { ...(p.lev || {}), [st.coin]: st.lev } }); renderTicket(false); });

  // numbers behind the ticket
  function calc() {
    const m = st.m;
    const mark = m?.markPx || 0;
    const raw = Number(String(sizeIn.value).replace(/,/g, "")) || 0;
    const isBuy = st.side === "long";
    const limitPx = st.type === "limit" ? Number(limitIn.value) || 0 : null;
    const refPx = limitPx || mark;
    const coinSize = st.unit === "USD" ? (refPx ? raw / refPx : 0) : raw;
    const usdSize = st.unit === "USD" ? raw : raw * refPx;
    const levels = isBuy ? st.book.asks : st.book.bids;
    const w = coinSize > 0 && levels.length ? walk(levels, coinSize) : { avg: null, complete: true };
    const fill = st.type === "limit" ? limitPx : w.avg;
    const impact = st.type === "market" && w.avg && mark ? Math.abs(w.avg - mark) / mark * 100 : 0;
    const lev = st.lev || 1;
    const margin = usdSize / lev;
    const mmr = m ? 1 / (2 * m.maxLeverage) : 0.0125;
    const liq = fill ? (isBuy ? fill * (1 - (1 / lev - mmr)) : fill * (1 + (1 / lev - mmr))) : null;
    const liqDist = liq && mark ? Math.abs(mark - liq) / mark * 100 : null;
    return { mark, coinSize, usdSize, fill, impact, complete: w.complete, margin, liq, liqDist, isBuy, limitPx, lev, tp: Number(tpIn.value) || null, sl: Number(slIn.value) || null };
  }

  function gateChecks(c) {
    const L = st.limits, m = st.m;
    if (!(c.usdSize > 0)) return { state: "wait", items: [] };
    const items = [];
    const add = (label, state, value) => items.push({ label, state, value });
    if (L.paused) add("Agent", "fail", "paused in your policy");
    add("Market", !L.allowedCoins || L.allowedCoins.includes(m.coin) ? "pass" : "fail", L.allowedCoins ? (L.allowedCoins.includes(m.coin) ? "allowed" : "not in your allowlist") : "any market");
    add("Size", c.usdSize <= L.perTradeUsd ? "pass" : "fail", `${usd(c.usdSize)} of ${usd(L.perTradeUsd, { compact: true })} max`);
    if (L.dailyLeftUsd != null) add("Daily cap", c.usdSize <= L.dailyLeftUsd ? "pass" : "fail", `${usd(L.dailyLeftUsd, { compact: true })} left today`);
    add("Leverage", c.lev <= Math.min(L.maxLeverage, m.maxLeverage) ? "pass" : "fail", `${c.lev}x of ${Math.min(L.maxLeverage, m.maxLeverage)}x cap`);
    if (st.user) {
      const reduce = reduceIn.checked, free = freeOf(m);
      add("Margin", reduce || c.margin <= free ? "pass" : "fail", `${usd(c.margin)} needed · ${usd(free)} free${m.dex ? " in trade.xyz" : ""}`);
    }
    if (st.type === "market") add("Price impact", !c.complete ? "fail" : c.impact > 3 ? "fail" : c.impact > 0.5 ? "warn" : "pass", c.complete ? `${c.impact.toFixed(3)}%` : "book too thin");
    if (c.liqDist != null && !reduceIn.checked) add("Liquidation", c.liqDist < 3 ? "warn" : "pass", `~${c.liqDist.toFixed(1)}% away`);
    if (c.tp && c.fill) add("Take profit", (c.isBuy ? c.tp > c.fill : c.tp < c.fill) ? "pass" : "fail", fmtPx(c.tp));
    if (c.sl && c.fill) add("Stop loss", (c.isBuy ? c.sl < c.fill : c.sl > c.fill) ? "pass" : "fail", fmtPx(c.sl));
    if (st.type === "limit" && !(c.limitPx > 0)) add("Limit price", "fail", "enter a price");
    const state = items.some((i) => i.state === "fail") ? "fail" : items.some((i) => i.state === "warn") ? "warn" : "pass";
    return { state, items };
  }

  function renderTicket(full = true) {
    const m = st.m;
    if (!m) { clear(ticket, h("div", { class: "sk", style: { height: "380px" } })); return; }
    const active = document.activeElement;
    const keep = [sizeIn, limitIn, tpIn, slIn].includes(active) ? active : null;
    const cap = Math.max(1, Math.min(m.maxLeverage, st.limits.maxLeverage));
    st.lev = Math.min(Math.max(1, st.lev || 1), cap);
    levIn.max = String(cap);
    levIn.value = String(st.lev);
    const c = calc();
    const g = gateChecks(c);

    const sideSeg = h("div", { class: "seg long", role: "group", "aria-label": "Direction" }, ["long", "short"].map((v) =>
      h("button", { type: "button", "data-v": v, "aria-pressed": String(st.side === v), onclick: () => { st.side = v; renderTicket(); } }, v === "long" ? "Long" : "Short")));
    const typeSeg = h("div", { class: "seg", role: "group", "aria-label": "Order type" }, [["market", "Market"], ["limit", "Limit"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(st.type === v), onclick: () => { st.type = v; if (v === "limit" && !limitIn.value) limitIn.value = fmtPx(m.midPx || m.markPx).replace(/,/g, ""); renderTicket(); } }, t)));
    const unit = h("div", { class: "pp-unit" }, ["USD", m.coin].map((u, i) =>
      h("button", { type: "button", "aria-pressed": String((i === 0 ? "USD" : "COIN") === st.unit || (i === 1 && st.unit !== "USD")), onclick: () => {
        const next = i === 0 ? "USD" : "COIN";
        if (next !== st.unit) { const cc = calc(); sizeIn.value = cc.usdSize > 0 ? (next === "USD" ? cc.usdSize.toFixed(2) : String(+cc.coinSize.toFixed(m.szDecimals))) : ""; }
        st.unit = next; prefs.set({ ...prefs.get(), unit: next }); renderTicket();
      } }, i === 0 ? "USD" : (m.label || m.coin).slice(0, 5))));
    const free = st.user ? freeOf(m) * st.lev : null;
    const pcts = h("div", { class: "pp-pcts" }, [25, 50, 75, 100].map((p) => h("button", { type: "button", onclick: () => {
      if (free == null) { toast(wallet.address ? "Still reading your account…" : "Connect a wallet to size from your balance.", ""); return; }
      const usdAmt = Math.min(free * p / 100, st.limits.perTradeUsd);
      sizeIn.value = st.unit === "USD" ? usdAmt.toFixed(2) : String(+(usdAmt / (c.fill || m.markPx)).toFixed(m.szDecimals));
      renderTicket(false);
    } }, p === 100 ? "Max" : `${p}%`)));

    const adv = h("details", { class: "pp-adv", ...(advOpen ? { open: true } : {}), ontoggle: (e) => { advOpen = e.target.open; } },
      h("summary", {}, "Advanced"),
      h("div", { class: "in" },
        h("label", { class: "pp-check" }, reduceIn, "Reduce only (never opens or grows a position)"),
        h("div", { class: "two" }, tpIn, slIn),
        h("p", { class: "fine", style: { margin: 0 } }, "TP and SL are reduce-only market exits that fire at the trigger price.")));

    const rows = h("div", { class: "pp-rows" },
      h("div", {}, h("span", {}, "Order size"), h("span", {}, c.usdSize > 0 ? `${usd(c.usdSize)} · ${num(c.coinSize, m.szDecimals)} ${m.coin}` : "–")),
      h("div", {}, h("span", {}, st.type === "market" ? "Est. fill" : "Limit price"), h("span", {}, c.fill ? fmtPx(c.fill) : "–")),
      h("div", {}, h("span", {}, "Margin"), h("span", {}, c.usdSize > 0 ? usd(c.margin) : "–")),
      h("div", {}, h("span", {}, "Est. liquidation"), h("span", {}, c.usdSize > 0 && !reduceIn.checked && c.liq ? fmtPx(c.liq) : "–")));

    const gateBox = h("div", { class: "gate-box", "aria-live": "polite" },
      h("div", { class: "gh" }, icon("shield"), "Troya Gate", h("span", { class: `chip-s ${g.state === "wait" ? "" : g.state}` }, g.state === "wait" ? "Waiting" : g.state === "pass" ? "Clear" : g.state === "warn" ? "Check" : "Blocked")),
      g.state === "wait" ? h("div", { class: "muted" }, "Enter a size and the Gate checks it against your limits and the live book.")
        : h("ul", {}, g.items.map((i) => h("li", { class: i.state }, h("span", {}, i.label), h("b", {}, i.value)))),
      h("div", { class: "fine", style: { marginTop: "6px" } }, st.limits.source === "your policy"
        ? `Your limits: ${capUsd(st.limits.perTradeUsd)} per order, up to ${st.limits.maxLeverage}x.`
        : `Default limits: ${capUsd(st.limits.perTradeUsd)} per order, up to ${st.limits.maxLeverage}x.`));

    // main button state machine
    let btn, keyNote = null;
    if (!wallet.address) btn = h("button", { class: "btn big primary", type: "button", onclick: () => openConnect() }, "Connect wallet");
    else if (st.key.state !== "approved") {
      btn = h("button", { class: "btn big blue", type: "button", onclick: enableTrading }, st.key.state === "expired" ? "Re-enable trading" : "Enable trading");
      keyNote = h("p", { class: "pp-key", style: { margin: 0 } }, "One wallet signature approves a ", h("b", {}, "trade-only key"), " kept in this browser. It can place and cancel Hyperliquid orders but ", h("b", {}, "cannot withdraw"), ". You can revoke it any time.");
    } else if (st.funding) {
      btn = h("button", { class: "btn big", type: "button", disabled: true }, "Waiting for the USDC on Hyperliquid…");
      keyNote = h("p", { class: "pp-key", style: { margin: 0 } }, "Funding sent ", h("a", { class: "mono link", href: `https://robinhoodchain.blockscout.com/tx/${st.funding.hash}`, target: "_blank", rel: "noopener" }, short(st.funding.hash, 6)), ". The order goes out from this page the moment it lands, usually within a minute or two. Keep the page open.");
    } else {
      const ready = g.state === "pass" || g.state === "warn";
      // perps end to end: margin is the only check in the way → fund the missing USDC from Robinhood Chain, then open
      const onlyMargin = g.state === "fail" && !m.dex && !reduceIn.checked && !!st.user && g.items.filter((i) => i.state === "fail").every((i) => i.label === "Margin");
      btn = onlyMargin
        ? h("button", { class: `btn big ${st.side === "long" ? "blue" : "danger"}`, type: "button", onclick: fundAndOpen }, `Fund & ${st.side === "long" ? "long" : "short"} ${m.coin}`)
        : h("button", { class: `btn big ${st.side === "long" ? "blue" : "danger"}`, type: "button", ...(ready ? {} : { disabled: true }), onclick: submit },
          g.state === "wait" ? "Enter a size" : ready ? `${st.side === "long" ? "Long" : "Short"} ${m.coin}` : "Blocked by Troya Gate");
      keyNote = onlyMargin
        ? h("p", { class: "pp-key", style: { margin: 0 } }, `Your Hyperliquid account has ${usd(freeOf(m))} free and this order needs about ${usd(c.margin)}. One transaction on Robinhood Chain sends the missing USDC (at least 6), then the order opens by itself when it lands.`)
        : h("p", { class: "pp-key", style: { margin: 0 } }, `Trading key ${short(st.key.key.address)} active. `, h("button", { class: "link", type: "button", onclick: revoke }, "Revoke"));
    }
    const leftToday = st.limits.dailyLeftUsd != null ? `Left today ${usd(st.limits.dailyLeftUsd, { compact: true })} · ` : "";
    let xyzBox = null;
    if (m.dex && st.user?.unified) {
      xyzBox = h("div", { class: "pp-xyz-box" }, h("p", { class: "fine", style: { margin: 0 } }, `Unified account: one USDC balance (${usd(freeOf(m))} free) backs Hyperliquid perps, trade.xyz and spot, so nothing needs moving. Stock perps trade around the clock; outside market hours the price is held inside a band.`));
    } else if (m.dex && st.user) {
      const free = freeOf(m), need = c.margin || 0, main = st.user.withdrawable || 0;
      const short_ = need > free ? Math.ceil((need - free) * 1.05 * 100) / 100 + 0.5 : 0;
      xyzBox = h("div", { class: "pp-xyz-box" },
        h("p", { class: "fine", style: { margin: 0 } }, `trade.xyz margin is its own balance: ${usd(free)} there, ${usd(main)} in your Hyperliquid perps. Stock perps trade around the clock; outside market hours the price is held inside a band.`),
        short_ > 0 && main > 0 ? h("button", { class: "btn sm blue", type: "button", onclick: () => moveUsdc(Math.min(short_, main), "", "xyz") }, `Move ${usd(Math.min(short_, main))} USDC to trade.xyz`) : null,
        free > 0.5 ? h("button", { class: "link fine", type: "button", onclick: () => moveUsdc(free, "xyz", "") }, `Move ${usd(free)} back to perps`) : null);
    }

    clear(ticket, sideSeg, typeSeg,
      st.type === "limit" ? h("label", { class: "field" }, h("span", {}, "Limit price (USD)"), limitIn) : null,
      h("div", {}, h("div", { class: "pp-size-h" }, h("span", {}, "Size"), h("span", {}, `${leftToday}max ${capUsd(st.limits.perTradeUsd)} per order`)),
        h("div", { class: "pp-size", style: { marginTop: "6px" } }, sizeIn, unit)),
      pcts,
      h("div", {}, h("div", { class: "pp-lev-h" }, h("span", {}, "Leverage"), h("b", {}, `${st.lev}x`)), levIn, h("div", { class: "pp-lev-f" }, h("span", {}, "1x"), h("span", {}, `${cap}x cap`))),
      adv, rows, xyzBox, gateBox, btn, keyNote);
    if (keep) { keep.focus(); try { const n = keep.value.length; keep.setSelectionRange(n, n); } catch {} }
  }

  function freeOf(m) { return m?.dex ? +(st.user?.dexes?.[m.dex]?.withdrawable || 0) : +(st.user?.withdrawable || 0); }
  async function moveUsdc(amount, from, to) {
    try {
      await ensureChain("arbitrum");
      await sendToDex(wallet.address, wallet.eip, amount, from, to);
      toast(`Moved ${usd(amount)} USDC ${to === "xyz" ? "to trade.xyz" : "back to perps"}`, "ok");
      await loadUser(); renderTicket();
    } catch (e) { toast(e.shortMessage || e.message, "error", 6000); }
  }
  async function enableTrading() {
    try {
      const ok = await review({ title: "Enable trading on Hyperliquid", summary: "Approve a trade-only key for this browser.", confirmLabel: "Approve in wallet", rows: [
        ["Account", short(wallet.address, 6)], ["Key name", "Troya"], ["Can", "place and cancel perp orders, change leverage"], ["Cannot", "withdraw or transfer funds"], ["Stored", "in this browser only"], ["Signature network", "Arbitrum (EIP-712 typed data, no gas)"],
      ], warn: "Your Hyperliquid account must already hold USDC (fund it from Robinhood Chain: Bridge → To Hyperliquid). If someone gets this browser's storage they could trade (not withdraw) until you revoke it." });
      if (!ok) return;
      await ensureChain("arbitrum");
      await approveTradingKey(wallet.address, wallet.eip);
      toast("Trading key approved", "ok");
      api.post("journal", { kind: "perp_key", summary: "Approved a trade-only Hyperliquid key for this browser", data: { key: getTradingKey(wallet.address)?.address } }).catch(() => {});
      await loadKey();
    } catch (e) { toast(e?.code === 4001 || /reject|denied/i.test(e?.message || "") ? "Request cancelled in the wallet." : e.message, "error", 6000); }
  }
  async function revoke() {
    const ok = await review({ title: "Revoke trading key", summary: "Remove the trading key from this browser?", confirmLabel: "Revoke", danger: true, rows: [["Key", short(st.key.key?.address, 6)]],
      warn: "This deletes the key locally so it can no longer sign. Hyperliquid may still list it under API wallets until it expires or is replaced; remove it there too if you want it gone everywhere." });
    if (!ok) return;
    revokeTradingKey(wallet.address);
    toast("Trading key removed from this browser", "ok");
    loadKey();
  }

  async function submit() {
    const m = st.m, c = calc();
    const g = gateChecks(c);
    if (g.state === "fail" || g.state === "wait") return;
    const ok = await review({
      title: `${st.side === "long" ? "Long" : "Short"} ${m.coin}-PERP`, confirmLabel: "Place order", danger: st.side === "short",
      rows: [
        ["Type", st.type === "market" ? "Market (IOC, 1% max slippage)" : "Limit (good till cancelled)"],
        ["Size", `${num(c.coinSize, m.szDecimals)} ${m.coin} · ${usd(c.usdSize)}`],
        [st.type === "market" ? "Est. fill" : "Limit price", fmtPx(c.fill)],
        ["Leverage", `${c.lev}x ${m.onlyIsolated ? "isolated" : "cross"}`],
        ["Margin", usd(c.margin)],
        ["Est. liquidation", reduceIn.checked ? "–" : fmtPx(c.liq)],
        c.tp ? ["Take profit", fmtPx(c.tp)] : null,
        c.sl ? ["Stop loss", fmtPx(c.sl)] : null,
        reduceIn.checked ? ["Reduce only", "yes"] : null,
      ],
      warn: g.state === "warn" ? g.items.filter((i) => i.state === "warn").map((i) => `${i.label}: ${i.value}`).join(" · ") : null,
    });
    if (!ok) return;
    try {
      const r = await placeOrder({ owner: wallet.address, market: m, isBuy: c.isBuy, size: c.coinSize, limitPx: st.type === "limit" ? c.limitPx : null, reduceOnly: reduceIn.checked, leverage: c.lev, tp: c.tp, sl: c.sl, refPx: c.fill || undefined });
      const failed = /error/.test(r.text) && !/filled|resting/.test(r.text);
      toast(`${m.coin}: ${r.text || "sent"}`, failed ? "error" : "ok", 6000);
      api.post("journal", { kind: "perp_order", summary: `${st.side === "long" ? "Long" : "Short"} ${num(r.size, m.szDecimals)} ${m.coin} @ ${st.type === "market" ? "market" : fmtPx(r.px)} · ${r.text}`,
        data: { coin: m.coin, side: st.side, type: st.type, size: r.size, px: r.px, leverage: c.lev, tp: c.tp, sl: c.sl, reduceOnly: reduceIn.checked, result: r.text, via: "own wallet trading key" } }).catch(() => {});
      if (!failed) sizeIn.value = "";
      setTimeout(loadUser, 800);
      renderTicket();
    } catch (e) { toast(e.message, "error", 7000); }
  }

  // Fund & open: ETH on Robinhood Chain → USDC on this address on Hyperliquid (one LI.FI transaction), then the order
  async function fundAndOpen() {
    const m = st.m, c = calc();
    const free = freeOf(m), missing = c.margin * 1.05 + 0.5 - free;
    if (!(missing > 0)) return submit();
    let q;
    try { q = await api.get(`hl/fund-quote?${new URLSearchParams({ address: wallet.address, usd: missing.toFixed(2) })}`); }
    catch (e) { toast(`No funding route right now: ${e.message}`, "error", 6000); return; }
    const usdc = Number(q.toAmount) / 10 ** q.toDecimals, usdcMin = Number(q.toAmountMin) / 10 ** q.toDecimals;
    const what = `${st.side === "long" ? "Long" : "Short"} ${num(c.coinSize, m.szDecimals)} ${m.coin} · ${usd(c.usdSize)} at ${c.lev}x`;
    const ok = await review({ title: `Fund Hyperliquid, then ${st.side} ${m.coin}-PERP`, confirmLabel: "Fund in wallet", danger: st.side === "short",
      summary: `One transaction on Robinhood Chain sends about ${usd(usdc)} USDC to your Hyperliquid account. The order is placed from this page the moment it lands.`,
      rows: [["You send", `${q.amountEth} ETH on Robinhood Chain`], ["Lands on Hyperliquid (est.)", `${usdc.toFixed(2)} USDC (min ${usdcMin.toFixed(2)})`], ["Route", `${q.tool} via LI.FI`], ["Route fees", usd(q.feeUsd + q.gasUsd)],
        ["Then", what], ["Margin", usd(c.margin)], st.type === "limit" ? ["Limit price", fmtPx(c.limitPx)] : ["Type", "Market (IOC, 1% max slippage)"]],
      warn: "The funding goes through a third-party route and cannot be reversed. Keep this page open until the order is placed; if you leave, the USDC still lands on your Hyperliquid account and you can place the order later." });
    if (!ok) return;
    const order = { coin: m.coin, isBuy: c.isBuy, size: c.coinSize, limitPx: st.type === "limit" ? c.limitPx : null, lev: c.lev, tp: c.tp, sl: c.sl, need: c.margin, side: st.side, type: st.type, usdSize: c.usdSize };
    try {
      const hash = await sendTx("robinhood", { to: q.tx.to, data: q.tx.data, value: q.tx.value, gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n });
      api.post("journal", { kind: "bridge", summary: `Fund Hyperliquid for a ${order.coin} order: ${q.amountEth} ETH → about ${usdc.toFixed(2)} USDC`, data: { hash, route: q.tool, via: "Perps · Fund & open" } }).catch(() => {});
      st.funding = { hash, at: Date.now() };
      toast("Funding sent. The order goes out as soon as the USDC lands.", "ok", 6000);
      renderTicket();
      while (alive && Date.now() - st.funding.at < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 5000));
        await loadUser().catch(() => {});
        if (freeOf(st.markets.find((x) => x.coin === order.coin) || st.m) >= order.need * 1.01) break;
      }
      const mk = st.markets.find((x) => x.coin === order.coin) || st.m;
      const landed = freeOf(mk) >= order.need * 1.01;
      st.funding = null;
      if (!alive) return;
      if (!landed) { toast("The USDC has not landed yet. It will reach your Hyperliquid account; place the order once it shows as free margin.", "", 9000); renderTicket(); return; }
      const r = await placeOrder({ owner: wallet.address, market: mk, isBuy: order.isBuy, size: order.size, limitPx: order.limitPx, leverage: order.lev, tp: order.tp, sl: order.sl });
      const failed = /error/.test(r.text) && !/filled|resting/.test(r.text);
      toast(`${order.coin}: ${r.text || "sent"}`, failed ? "error" : "ok", 7000);
      api.post("journal", { kind: "perp_order", summary: `${order.side === "long" ? "Long" : "Short"} ${num(r.size, mk.szDecimals)} ${order.coin} @ ${order.type === "market" ? "market" : fmtPx(r.px)} · ${r.text} (after funding)`,
        data: { coin: order.coin, side: order.side, type: order.type, size: r.size, px: r.px, leverage: order.lev, tp: order.tp, sl: order.sl, result: r.text, via: "own wallet trading key · Fund & open", fundTx: hash } }).catch(() => {});
      if (!failed) sizeIn.value = "";
      setTimeout(loadUser, 800);
      renderTicket();
    } catch (e) { st.funding = null; toast(e.shortMessage || e.message, "error", 7000); if (alive) renderTicket(); }
  }

  async function closePosition(p) {
    const m = st.markets.find((x) => x.coin === p.coin);
    if (!m) return;
    if (st.key.state !== "approved") { toast("Enable trading first to close from here.", ""); return; }
    const ok = await review({ title: `Close ${p.coin} position`, confirmLabel: "Close at market", danger: true, rows: [["Side", p.size > 0 ? "Long" : "Short"], ["Size", num(Math.abs(p.size), 5)], ["Mark", fmtPx(m.markPx)], ["Unrealised PnL", usd(p.unrealizedPnl)]] });
    if (!ok) return;
    try {
      const r = await placeOrder({ owner: wallet.address, market: m, isBuy: p.size < 0, size: Math.abs(p.size), reduceOnly: true });
      toast(`${p.coin}: ${r.text}`, /error/.test(r.text) ? "error" : "ok", 6000);
      api.post("journal", { kind: "perp_order", summary: `Closed ${p.coin} ${p.size > 0 ? "long" : "short"} at market · ${r.text}`, data: { coin: p.coin, reduceOnly: true, size: Math.abs(p.size), result: r.text } }).catch(() => {});
      setTimeout(loadUser, 800);
    } catch (e) { toast(e.message, "error", 7000); }
  }
  async function cancel(o) {
    const m = st.markets.find((x) => x.coin === o.coin);
    if (!m) return;
    if (st.key.state !== "approved") { toast("Enable trading first to cancel from here.", ""); return; }
    try {
      await cancelOrder({ owner: wallet.address, market: m, oid: o.oid });
      toast("Order cancelled", "ok");
      api.post("journal", { kind: "perp_cancel", summary: `Cancelled ${o.coin} ${o.side} order ${o.oid}`, data: o }).catch(() => {});
      setTimeout(loadUser, 600);
    } catch (e) { toast(e.message, "error", 6000); }
  }

  /* ---------- boot ---------- */
  try { await loadMeta(); }
  catch (e) { clear(view, h("div", { class: "empty", style: { padding: "100px 0" } }, h("b", {}, "Hyperliquid markets could not be loaded."), h("div", {}, e.message), h("button", { class: "btn", type: "button", onclick: () => ctx.go(location.hash) }, "Try again"))); return; }
  if (ctx.parts[0] && st.m.coin.toUpperCase() !== (ctx.parts[0] || "").toUpperCase().replace(/-PERP$/, "")) toast(`No perp called ${ctx.parts[0]}; showing ${st.m.coin}.`, "");
  renderIvals();
  renderTicket();
  renderPositions();
  initChart();
  loadPolicy();
  stops.push(every(5000, loadMeta));
  stops.push(every(1500, loadBook));
  const candleTimer = setInterval(() => { if (!document.hidden) loadCandles(false); }, 5000);
  stops.push(() => clearInterval(candleTimer));
  const offWallet = onWallet(() => { loadUser(); loadKey(); loadPolicy(); });
  stops.push(offWallet);
  stops.push(every(6000, () => { if (wallet.address) loadUser(); }));

  return () => { alive = false; stops.forEach((f) => { try { f(); } catch {} }); themeObs?.disconnect(); try { chart?.remove(); } catch {} };
}
