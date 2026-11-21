// Perps desk: Hyperliquid chart, order book, order ticket (own-wallet trading key), Troya Gate, positions.
import { h, clear, icon, pageHead, table, review, toast, modal, num, fixed, usd, compact, pct, pctEl, short, useCss, every, debounce, store, coinIcon } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, ensureChain, reader, CHAINS } from "../wallet.js";
import { getTradingKey, tradingKeyStatus, approveTradingKey, revokeTradingKey, placeOrder, cancelOrder, sendToDex, roundSz } from "../hl.js";
import { sendTx, waitReceipt, errText, balanceOf, ETH } from "../chain.js";
// F16: trade.xyz markets (stocks, indices, metals) sit beside the Hyperliquid perps; their margin is a separate balance.
// A trade.xyz ticker says little on its own (ANT, SKHX), so the page names it from the server's displayName:
// "Anthropic · ANT perp". A crypto perp keeps its usual BTC-PERP. tagOf is the bare ticker for units and short labels.
const tagOf = (m) => (m?.dex ? (m.label || String(m.coin || "").replace(/^[a-z]+:/i, "")) : m?.coin);
function nameOf(m) {
  const t = tagOf(m);
  if (!m?.dex) return `${t}-PERP`;
  const n = m.displayName;
  return n && n.toUpperCase() !== String(t).toUpperCase() ? `${n} · ${t} perp` : `${t} perp`;
}
const HL_CHAIN = 1337;         // LI.FI's id for Hyperliquid (HyperCore), where Fund & open delivers the USDC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hyperliquid refuses approveAgent (and every other action) on an address that has never received a deposit
const mustDeposit = (e) => /must deposit/i.test(String(e?.message || e || ""));
const FUND_STEPS = ["Sent", "Bridging", "Landed", "Order placed"];

const IVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const prefs = store("troya.perps", { interval: "1h", unit: "USD", lev: {} });
// local fallback limits when the server policy is unavailable (the server re-checks Agent Wallet actions itself)
const DEFAULT_LIMITS = { maxLeverage: 20, perTradeUsd: 25000, dailyUsd: null, allowedCoins: null, source: "local defaults" };
const TAKER_FEE = 0.00045;     // Hyperliquid base taker fee (0.045%): the margin check and the size chips leave room for it
const SLIP = 0.01;             // a market order goes out as IOC at most 1% through the price (placeOrder's slippage)
const MIN_ORDER_USD = 10;      // Hyperliquid refuses an order worth less than $10

// the ticket and the book are built once and patched in place: a tick that rebuilt them took the click that started on
// the old button, moved the caret and stopped a slider drag after one step
const setText = (el, s) => { s = String(s ?? ""); if (el.textContent !== s) el.textContent = s; };
const setCls = (el, c) => { if (el.className !== c) el.className = c; };
const press = (btns, on) => btns.forEach((b) => { const v = String(!!on(b)); if (b.getAttribute("aria-pressed") !== v) b.setAttribute("aria-pressed", v); });
// a small block with links or buttons is rebuilt only when what it says changes
const patch = (el, sig, build) => { if (el._sig === sig) return; el._sig = sig; clear(el, build()); };
const rejected = (e) => e?.code === 4001 || e?.code === "ACTION_REJECTED" || /reject|denied/i.test(e?.message || "");
// errText (chain.js) turns wallet and RPC errors into plain words ("Not enough ETH to cover the amount plus network fee.")
const errMsg = (e) => { const s = errText(e); return /[.!?…]$/.test(s) ? s : `${s}.`; };

// price decimals by the size of the price: >= 10,000 -> 0, >= 1,000 -> 1, >= 100 -> 2, >= 10 -> 3, >= 1 -> 4 (5 or 7
// under $1). The page picks them once per market from its mark price (decOf in mount), so the book, the axis, the
// header and TP/SL line up digit for digit; picked per value, the axis read 100.00 beside 97.5000
const pxDecimals = (p) => (!p ? 2 : p >= 10000 ? 0 : p >= 1000 ? 1 : p >= 100 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : p >= 0.01 ? 5 : 7);
// a cap reads as a round number: $25K, $2.5K, $500 (not $25.0K)
const capUsd = (v) => (v >= 1000 ? `$${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : usd(v));

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

// resolves once /agent/css/<name>.css has loaded (at once when it already has), or after ms at most
function cssReady(name, ms) {
  const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => (l.getAttribute("href") || "").startsWith(`/agent/css/${name}.css`));
  if (!link || link.sheet) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    const fin = () => { clearTimeout(t); done(); };
    link.addEventListener("load", fin, { once: true });
    link.addEventListener("error", fin, { once: true });
  });
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
    side: "long", type: "market", unit: prefs.get().unit === "COIN" ? "COIN" : "USD", lev: null, interval: prefs.get().interval || "1h",
    key: { state: "none" }, lastOk: 0,
    busy: null,      // set while an order or a funding is in flight: the main button shows it, disabled, so nothing goes out twice
    funding: null,
    fundStep: null,  // { hash, step } while Fund & open runs: 1 Sent · 2 Bridging · 3 Landed · 4 Order placed
    noDeposit: false, // Hyperliquid answered "Must deposit before performing actions" for this account
  };
  let stage = null;  // where Fund & open is: "fund" | "bridge" | "landed" | "key" | "move" | "order", so a cancel says what really happened
  const decs = new Map();   // coin -> price decimals, picked once from the first mark price seen
  const decOf = (m) => { if (!m?.markPx) return null; let d = decs.get(m.coin); if (d == null) { d = pxDecimals(m.markPx); decs.set(m.coin, d); } return d; };
  const fmtPx = (p, m = st.m) => (p == null || !isFinite(p) ? "–" : fixed(p, decOf(m) ?? pxDecimals(p)));
  // the market behind a coin the account panel shows (a position can sit on a market the list has not loaded)
  const mOf = (coin) => st.markets.find((x) => x.coin === coin) || { coin, dex: /^[a-z]+:/i.test(coin) ? coin.split(":")[0] : null, label: String(coin).replace(/^[a-z]+:/i, "") };
  // started before the market list arrives: the chart library and the first candles load alongside it, so the chart
  // no longer waits for the list (about 1.5 s sooner). A bare ticker resolves on the server the way the link does.
  const lwP = import("lightweight-charts");
  lwP.catch(() => {});
  let early = api.get(`hl/candles?coin=${encodeURIComponent(st.coin)}&interval=${st.interval}`).catch(() => null);

  /* ---------- layout ---------- */
  // the button already holds the asked-for market's name, so the header keeps its height when the list arrives
  const asked = String(ctx.parts[0] || "BTC").replace(/-PERP$/i, "");
  const mktBtn = h("button", { class: "pp-mkt", type: "button", "aria-label": "Choose market", onclick: () => pickMarket() },
    coinIcon(asked, "pp-coin"), asked.includes(":") ? `${asked.split(":")[1].toUpperCase()} perp` : `${asked.toUpperCase()}-PERP`, icon("arrowRight"));
  mktBtn.lastChild.style.transform = "rotate(90deg)";
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
  // ten rows a side, built once: a tick rewrites their numbers, so a click on a price to use it always lands, and the
  // book keeps its height while it loads
  const N_LV = 10;
  const lvRow = (cls) => {
    const bar = h("i", {}), p = h("span", { class: "p" }), s = h("span", {});
    const el = h("div", { class: `pp-lv ${cls}`, title: "Use this price", style: { visibility: "hidden" }, onclick: () => { if (el._px == null) return; limitIn.value = String(el._px); setType("limit"); } }, bar, p, s);
    el._set = (l, max, fmtSz) => {
      el._px = l ? l.px : null;
      el.style.visibility = l ? "" : "hidden";
      if (!l) return;
      bar.style.width = `${(l.sz / max) * 100}%`;
      setText(p, fmtPx(l.px));
      setText(s, fmtSz(l.sz));
    };
    return el;
  };
  const bidRows = Array.from({ length: N_LV }, () => lvRow("bid")), askRows = Array.from({ length: N_LV }, () => lvRow("ask"));
  const bookBids = h("div", {}, bidRows), bookAsks = h("div", {}, askRows);
  const spreadEl = h("span", { class: "muted" }, "");
  const posBox = h("div", {});

  const ticket = h("div", { class: "panel pp-ticket" }, h("div", { class: "sk", style: { height: "380px" } }));
  // perps.css puts the ticket under the chart on a phone; drawn before it arrived, the panels swapped places a moment
  // later (most of the page's layout shift), so the first paint waits for it, never longer than 1.5 s
  const hash0 = location.hash;
  await cssReady("perps", 1500);
  if (location.hash !== hash0) return null;   // left during the wait: the next page owns the view now
  renderIvals();     // the interval row is drawn now, not after the markets load, so the chart under it stays put
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
  // the market asked for in the link (e.g. Anthropic, xyz:ANT). If the list comes back without it (the trade.xyz list
  // failed for a moment) BTC shows meanwhile, and the page switches to it as soon as a refresh brings it back.
  const want = (ctx.parts[0] || "").toUpperCase().replace(/-PERP$/, "");
  // a bare ticker (#/perps/ANT, #/perps/NVDA) with no main-dex perp of that name is the trade.xyz market; before, it
  // fell back to BTC
  const find = (name) => {
    const w = String(name || "").toUpperCase();
    return st.markets.find((x) => x.coin.toUpperCase() === w) || (w && !w.includes(":") ? st.markets.find((x) => x.dex === "xyz" && x.coin.toUpperCase() === `XYZ:${w}`) : null) || null;
  };
  let fellBack = false, metaAt = 0;
  async function loadMeta() {
    const r = await api.get("hl/meta?all=1");
    if (!alive) return;
    st.markets = r.markets.filter((m) => !m.isDelisted);
    metaAt = Date.now();
    if (fellBack && find(want)) { fellBack = false; ctx.go(location.hash); return; }
    // a refresh that comes back without the open market (a trade.xyz read failed for a moment) keeps the market shown
    if (st.m && !fellBack && !find(st.coin)) { st.lastOk = Date.now(); return; }
    const m = (!st.m && want && find(want)) || find(st.coin) || find("BTC");
    if (!st.m && want && !find(want)) fellBack = true;
    if (!st.m || m.coin !== st.m.coin) { st.coin = m.coin; }
    st.m = m;
    if (st.lev == null) st.lev = Math.min(prefs.get().lev?.[m.coin] || 3, m.maxLeverage, st.limits.maxLeverage);
    st.lastOk = Date.now();
    renderHead();
  }
  // the header's 5 s refresh reads this one market (about 1 KB) instead of the whole list (about 150 KB); the list is
  // read again every 60 s, when the picker opens, and while a market asked for in the link has not arrived
  async function loadCtx() {
    if (!st.m) return;
    const coin = st.m.coin;
    try {
      const r = await api.get(`hl/ctx?coin=${encodeURIComponent(coin)}`);
      if (!alive || !st.m || st.m.coin !== coin || r?.market?.coin !== coin) return;
      Object.assign(st.m, r.market);   // st.m is the list's own entry, so the ticket and the tables see the new mark too
      st.lastOk = Date.now();
      renderHead();
    } catch {}
  }
  const headTick = () => { if (fellBack || Date.now() - metaAt > 60_000) loadMeta().catch(() => {}); else loadCtx(); };
  function renderHead() {
    const m = st.m;
    if (!m) return;
    // rebuilt only when the market changes: every 5 s it reloaded the icon and replaced what a press had landed on
    if (mktBtn._sig !== m.coin) { patch(mktBtn, m.coin, () => [coinIcon(m.coin, "pp-coin"), nameOf(m), icon("arrowRight")]); mktBtn.lastChild.style.transform = "rotate(90deg)"; }
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
    const q = h("input", { class: "input", placeholder: "Search a market or company (BTC, Anthropic, NVIDIA, Gold…)", "aria-label": "Search markets" });
    const list = h("div", { class: "pp-pick-list" });
    let sel = 0, group = st.m?.dex ? "xyz" : "all";
    const groupSeg = h("div", { class: "seg pp-pick-g" });
    const drawGroups = () => clear(groupSeg, [["all", "All"], ["crypto", "Crypto"], ["xyz", "Stocks, indices & metals · trade.xyz"]].map(([v, t]) =>
      h("button", { type: "button", "aria-pressed": String(group === v), onclick: () => { group = v; sel = 0; drawGroups(); render(); } }, t)));
    const rows = () => {
      const s = q.value.trim().toUpperCase();
      // the ticker, the label and the name: "anthropic" finds ANT, "nvidia" NVDA, "tesla" TSLA
      const hit = (m) => `${m.coin} ${m.label || ""} ${m.displayName || ""}`.toUpperCase().includes(s);
      return st.markets.filter((m) => (group === "all" || (group === "xyz" ? m.dex === "xyz" : !m.dex)) && (!s || hit(m)))
        .sort((a, b) => (b.dayNtlVlm || 0) - (a.dayNtlVlm || 0)).slice(0, 150);
    };
    const choose = (m) => { md.close(); ctx.go(`#/perps/${m.coin}`); };
    const render = () => {
      const rs = rows();
      sel = Math.min(sel, Math.max(0, rs.length - 1));
      clear(list, h("div", { class: "pp-pick-row pp-pick-hd" }, h("b", {}, "Market"), h("span", {}, "Price"), h("span", {}, "24h"), h("span", { class: "vol" }, "Volume")),
        rs.length ? rs.map((m, i) => h("button", { type: "button", class: `pp-pick-row ${i === sel ? "sel" : ""}`, onclick: () => choose(m) },
          h("b", {}, coinIcon(m.coin, "sm"), nameOf(m), m.dex ? h("small", { class: "pp-xyz" }, "trade.xyz") : null, h("small", {}, `${m.maxLeverage}x`)), h("span", {}, fmtPx(m.markPx, m)), h("span", { class: m.change24h >= 0 ? "up" : "down" }, pct(m.change24h)), h("span", { class: "vol muted" }, usd(m.dayNtlVlm, { compact: true }))))
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
    // the list is refreshed every 60 s; opening the picker brings it up to date (prices, new listings)
    if (Date.now() - metaAt > 10_000) loadMeta().then(() => { if (alive && list.isConnected) render(); }).catch(() => {});
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
  async function initChart(metaP) {
    let LW;
    try { LW = await lwP; } catch { clear(chartBox, h("div", { class: "pp-chart-msg" }, "Chart library failed to load.")); return; }
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
    // the candles were asked for at mount; they are drawn once the list has named the market (its exact coin and decimals)
    await metaP?.catch(() => {});
    if (!alive) return;
    await loadCandles(true);
  }
  function renderIvals() {
    clear(ivals, IVALS.map((iv) => h("button", { type: "button", "aria-pressed": String(iv === st.interval), onclick: () => { st.interval = iv; prefs.set({ ...prefs.get(), interval: iv }); renderIvals(); loadCandles(true); } }, iv)));
  }
  async function loadCandles(full) {
    if (!candles || !st.coin) return;
    try {
      const from = !full && lastBar ? lastBar.t : 0;
      let r = null;
      if (full && early) { const e = early; early = null; r = await e; if (r && (r.coin !== st.coin || r.interval !== st.interval)) r = null; }
      r ||= await api.get(`hl/candles?coin=${encodeURIComponent(st.coin)}&interval=${st.interval}${from ? `&from=${from}` : ""}`);
      if (!alive || r.coin !== st.coin || r.interval !== st.interval) return;
      const toBar = (c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c });
      const light = isLight();
      const toVol = (c) => ({ time: Math.floor(c.t / 1000), value: c.v, color: volColor(c.c >= c.o, light) });
      const d = decOf(st.m) ?? pxDecimals(r.candles.at(-1)?.c);
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
      const b = await api.get(`hl/book?coin=${encodeURIComponent(st.coin)}`);
      if (!alive || b.coin !== st.coin) return;
      st.book = b;
      st.lastOk = Date.now();
      renderBook();
      renderTicket();
    } catch {}
  }
  function renderBook() {
    const bids = st.book.bids.slice(0, N_LV), asks = st.book.asks.slice(0, N_LV);
    const max = Math.max(...bids.map((l) => l.sz), ...asks.map((l) => l.sz), 1e-9);
    const sz = (v) => fixed(v, Math.min(st.m?.szDecimals ?? 4, 5));   // the market's own size step, so the column lines up
    bidRows.forEach((r, i) => r._set(bids[i], max, sz));
    askRows.forEach((r, i) => r._set(asks[i], max, sz));
    if (bids[0] && asks[0]) { const s = asks[0].px - bids[0].px; setText(spreadEl, `Spread ${((s / asks[0].px) * 100).toFixed(3)}%`); }
  }
  const midNow = () => (st.book.bids[0] && st.book.asks[0] ? (st.book.bids[0].px + st.book.asks[0].px) / 2 : st.m?.midPx || st.m?.markPx || null);

  /* ---------- account ---------- */
  // fresh: a read at most 1 s old (after a funding or a move); the server's ordinary copy can be 2.5 s old and still
  // show the balance from before, which stopped Move & open with "margin"
  async function loadUser({ fresh = false } = {}) {
    if (!wallet.address) { st.user = null; renderPositions(); renderTicket(); return; }
    try { st.user = await api.get(`hl/user?address=${wallet.address}${fresh ? "&fresh=1" : ""}`); } catch { st.user = null; }
    if (!alive) return;
    renderPositions();
    renderTicket();
  }
  async function loadKey() {
    st.key = wallet.address ? await tradingKeyStatus(wallet.address) : { state: "none" };
    if (alive) renderTicket();
  }
  async function loadPolicy() {
    try { st.limits = wallet.session ? readPolicy(await api.get("policy")) : { ...DEFAULT_LIMITS }; } catch { st.limits = { ...DEFAULT_LIMITS }; }
    if (st.m) st.lev = Math.min(st.lev ?? 3, st.m.maxLeverage, st.limits.maxLeverage);
    if (alive) renderTicket();
  }

  let posTab = "positions";
  // the account panel refreshes every few seconds; a refresh waits while a pointer is down on it, so a press on Close,
  // Cancel or a tab is never lost to a rebuild between press and release
  let posHold = false, posDue = false, posT = 0;
  // released on pointerup anywhere, or after 3 s at most (a release outside the window never reaches the page)
  posBox.addEventListener("pointerdown", () => { posHold = true; clearTimeout(posT); posT = setTimeout(posRelease, 3000); });
  const posRelease = () => { if (!posHold) return; posHold = false; if (posDue) { posDue = false; setTimeout(() => { if (alive) renderPositions(); }, 0); } };
  addEventListener("pointerup", posRelease);
  addEventListener("pointercancel", posRelease);
  stops.push(() => { clearTimeout(posT); removeEventListener("pointerup", posRelease); removeEventListener("pointercancel", posRelease); });
  function renderPositions() {
    if (posHold) { posDue = true; return; }
    const tabsEl = h("div", { class: "tabs", role: "tablist" }, [["positions", "Positions"], ["orders", "Open orders"], ["fills", "Fills"]].map(([v, t]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(posTab === v), onclick: () => { posTab = v; renderPositions(); } }, t,
        st.user && v === "positions" && st.user.positions.length ? ` (${st.user.positions.length})` : st.user && v === "orders" && st.user.openOrders.length ? ` (${st.user.openOrders.length})` : "")));
    let body;
    if (!wallet.address) body = h("div", { class: "empty" }, "Connect a wallet to see your Hyperliquid positions.", h("button", { class: "btn", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"));
    else if (!st.user) body = h("div", { class: "empty" }, "Reading your Hyperliquid account…");
    else if (posTab === "positions") {
      const t = table({ emptyText: "No open positions.", cols: [
        { key: "coin", label: "Market", align: "l", render: (p) => h("a", { class: "link tok-link", href: `#/perps/${p.coin}` }, coinIcon(p.coin, "sm"), nameOf(mOf(p.coin))) },
        { key: "side", label: "Side", render: (p) => h("span", { class: p.size > 0 ? "side-l" : "side-s" }, p.size > 0 ? "Long" : "Short", p.leverage ? ` ${p.leverage}x` : "") },
        { key: "size", label: "Size", render: (p) => num(Math.abs(p.size), 5) },
        { key: "val", label: "Value", render: (p) => usd(p.positionValue) },
        { key: "entry", label: "Entry", render: (p) => fmtPx(p.entryPx, mOf(p.coin)) },
        { key: "mark", label: "Mark", render: (p) => fmtPx(mOf(p.coin).markPx, mOf(p.coin)) },
        { key: "pnl", label: "PnL (ROE)", render: (p) => h("span", { class: p.unrealizedPnl >= 0 ? "up" : "down" }, `${p.unrealizedPnl >= 0 ? "+" : ""}${usd(p.unrealizedPnl)} (${pct(p.returnOnEquity * 100)})`) },
        { key: "liq", label: "Liq. price", render: (p) => fmtPx(p.liquidationPx, mOf(p.coin)) },
        { key: "act", label: "", render: (p) => h("button", { class: "btn sm", type: "button", onclick: (e) => { e.stopPropagation(); closePosition(p); } }, "Close") },
      ] });
      t.setRows(st.user.positions);
      body = t;
    } else if (posTab === "orders") {
      const t = table({ emptyText: "No open orders.", cols: [
        { key: "coin", label: "Market", align: "l", render: (o) => h("span", { class: "tok-link" }, coinIcon(o.coin, "sm"), nameOf(mOf(o.coin))) },
        { key: "side", label: "Side", render: (o) => h("span", { class: o.side === "buy" ? "side-l" : "side-s" }, o.side === "buy" ? "Buy" : "Sell") },
        { key: "type", label: "Type", render: (o) => `${o.orderType || "Limit"}${o.reduceOnly ? " · reduce" : ""}` },
        { key: "px", label: "Price", render: (o) => (o.isTrigger ? `trigger ${fmtPx(o.triggerPx, mOf(o.coin))}` : fmtPx(o.limitPx, mOf(o.coin))) },
        { key: "size", label: "Size", render: (o) => num(o.size, 5) },
        { key: "age", label: "Placed", render: (o) => new Date(o.timestamp).toLocaleString() },
        { key: "act", label: "", render: (o) => h("button", { class: "btn sm", type: "button", onclick: (e) => { e.stopPropagation(); cancel(o); } }, "Cancel") },
      ] });
      t.setRows(st.user.openOrders);
      body = t;
    } else {
      const t = table({ emptyText: "No fills yet.", cols: [
        { key: "time", label: "Time", align: "l", render: (f) => new Date(f.time).toLocaleString() },
        { key: "coin", label: "Market", render: (f) => h("span", { class: "tok-link" }, coinIcon(f.coin, "sm"), f.coin.includes("/") ? f.coin : nameOf(mOf(f.coin))) },
        { key: "dir", label: "Direction", render: (f) => f.dir || f.side },
        { key: "px", label: "Price", render: (f) => fmtPx(f.px, mOf(f.coin)) },
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
  // Built once (buildTicket); renderTicket only patches it: the values in the rows, the Gate list, the main button's
  // label, action and disabled state. Typing, the caret, a slider drag and a click are never interrupted by a tick.
  const sizeIn = h("input", { class: "input", inputmode: "decimal", placeholder: "0.00", "aria-label": "Order size" });
  const limitIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Limit price", "aria-label": "Limit price" });
  const tpIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Take profit", "aria-label": "Take-profit price" });
  const slIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Stop loss", "aria-label": "Stop-loss price" });
  const reduceIn = h("input", { type: "checkbox" });
  const levIn = h("input", { class: "pp-range", type: "range", min: "1", step: "1", "aria-label": "Leverage" });
  // what the person typed and in which unit, so $50 → BTC → $ comes back to exactly $50 (not a rounded 49.98)
  let typed = null;
  const later = debounce(() => renderTicket(), 120);
  sizeIn.addEventListener("input", () => { typed = { unit: st.unit, value: sizeIn.value }; later(); });
  [limitIn, tpIn, slIn].forEach((el) => el.addEventListener("input", later));
  reduceIn.addEventListener("change", () => renderTicket());
  // while the slider moves only its label and the numbers follow; the Gate, the button and the saved choice on release
  levIn.addEventListener("input", () => { st.lev = +levIn.value; setText(levVal, `${st.lev}x`); fillRows(calc()); });
  levIn.addEventListener("change", () => { st.lev = +levIn.value; const p = prefs.get(); prefs.set({ ...p, lev: { ...(p.lev || {}), [st.coin]: st.lev } }); renderTicket(); });

  const sideBtns = ["long", "short"].map((v) => h("button", { type: "button", "data-v": v, onclick: () => { st.side = v; renderTicket(); } }, v === "long" ? "Long" : "Short"));
  const typeBtns = [["market", "Market"], ["limit", "Limit"]].map(([v, t]) => h("button", { type: "button", "data-v": v, onclick: () => setType(v) }, t));
  const unitBtns = ["USD", "COIN"].map((u) => h("button", { type: "button", "data-v": u, onclick: () => setUnit(u) }, u === "USD" ? "USD" : ""));
  const pctBtns = [25, 50, 75, 100].map((p) => h("button", { type: "button", onclick: () => sizeFromBalance(p) }, p === 100 ? "Max" : `${p}%`));
  const limitField = h("label", { class: "field", hidden: true }, h("span", {}, "Limit price (USD)"), limitIn);
  const sizeHint = h("span", {});
  const levVal = h("b", {}, "–"), levCap = h("span", {});
  const rv = { size: h("span", {}, "–"), fillK: h("span", {}, "Est. fill"), fill: h("span", {}, "–"), margin: h("span", {}, "–"), fee: h("span", {}, "–"), liq: h("span", {}, "–") };
  // the chip alone is the live region: it speaks when the verdict changes, not on every repriced number
  const gateChip = h("span", { class: "chip-s", role: "status", "aria-live": "polite" }, "Waiting");
  const gateWait = h("div", { class: "muted" }, "Enter a size and the Gate checks it against your limits and the live book.");
  const gateList = h("ul", { hidden: true });
  const gateFoot = h("div", { class: "fine", style: { marginTop: "6px" } });
  let btnAct = null;
  const mainBtn = h("button", { class: "btn big", type: "button", onclick: () => btnAct?.() }, "…");
  const keyNote = h("p", { class: "pp-key", style: { margin: 0 }, hidden: true });
  const venueNote = h("p", { class: "fine", style: { margin: 0 } }, "Hyperliquid and trade.xyz are separate venues; not available where their terms exclude (incl. the US).");
  const xyzText = h("p", { class: "fine", style: { margin: 0 } });
  const xyzMove = h("button", { class: "btn sm blue", type: "button", hidden: true, onclick: () => moveUsdc(xyzMove._amt, "", "xyz") });
  const xyzBack = h("button", { class: "link fine", type: "button", hidden: true, onclick: () => moveUsdc(xyzBack._amt, "xyz", "") });
  const xyzBox = h("div", { class: "pp-xyz-box", hidden: true }, xyzText, xyzMove, xyzBack);
  const valRow = (k, v) => h("div", {}, h("span", {}, k), v);

  let built = false;
  function buildTicket() {
    built = true;
    clear(ticket,
      h("div", { class: "seg long", role: "group", "aria-label": "Direction" }, sideBtns),
      h("div", { class: "seg", role: "group", "aria-label": "Order type" }, typeBtns),
      limitField,
      h("div", {}, h("div", { class: "pp-size-h" }, h("span", {}, "Size"), sizeHint),
        h("div", { class: "pp-size", style: { marginTop: "6px" } }, sizeIn, h("div", { class: "seg pp-unit", role: "group", "aria-label": "Size unit" }, unitBtns))),
      h("div", { class: "pp-pcts" }, pctBtns),
      h("div", {}, h("div", { class: "pp-lev-h" }, h("span", {}, "Leverage"), levVal), levIn, h("div", { class: "pp-lev-f" }, h("span", {}, "1x"), levCap)),
      h("details", { class: "pp-adv" },
        h("summary", {}, "Advanced"),
        h("div", { class: "in" },
          h("label", { class: "pp-check" }, reduceIn, "Reduce only (never opens or grows a position)"),
          h("div", { class: "two" }, tpIn, slIn),
          h("p", { class: "fine", style: { margin: 0 } }, "TP and SL are reduce-only market exits that fire at the trigger price."))),
      h("div", { class: "pp-rows" }, valRow("Order size", rv.size), h("div", {}, rv.fillK, rv.fill), valRow("Margin", rv.margin), valRow("Est. fee", rv.fee), valRow("Est. liquidation", rv.liq)),
      xyzBox,
      h("div", { class: "gate-box" }, h("div", { class: "gh" }, icon("shield"), "Troya Gate", gateChip), gateWait, gateList, gateFoot),
      mainBtn, keyNote, venueNote);
  }

  function setType(v) {
    st.type = v;
    if (v === "limit" && !limitIn.value && st.m) limitIn.value = fmtPx(st.m.midPx || st.m.markPx).replace(/,/g, "");
    renderTicket();
  }
  function setUnit(next) {
    const m = st.m;
    if (!m || next === st.unit) return;
    // back to the unit that was typed → the typed text itself; otherwise the size that would really go out
    if (typed && typed.unit === next) sizeIn.value = typed.value;
    else {
      const c = calc();
      sizeIn.value = c.sz > 0 ? (next === "USD" ? (c.sz * c.refPx).toFixed(2) : String(+c.sz.toFixed(m.szDecimals))) : "";
    }
    st.unit = next;
    prefs.set({ ...prefs.get(), unit: next });
    renderTicket();
  }
  // 25 / 50 / 75 / Max of what the free margin can carry at this leverage, leaving room for the taker fee, a fill up to
  // 1% worse and 2% spare, so Max never trips the margin check
  function sizeFromBalance(p) {
    const m = st.m;
    if (!m) return;
    if (!st.user) { toast(wallet.address ? "Still reading your account…" : "Connect a wallet to size from your balance.", ""); return; }
    const lev = st.lev || 1;
    const room = (freeOf(m) * lev * 0.98) / ((1 + SLIP) * (1 + lev * TAKER_FEE));
    const usdAmt = Math.max(0, Math.min(room * p / 100, st.limits.perTradeUsd, st.limits.dailyLeftUsd ?? Infinity));
    const px = (st.type === "limit" && Number(String(limitIn.value).replace(/,/g, ""))) || m.markPx;
    sizeIn.value = st.unit === "USD" ? (Math.floor(usdAmt * 100) / 100).toFixed(2) : String(roundSz(usdAmt / px, m.szDecimals));
    typed = { unit: st.unit, value: sizeIn.value };
    renderTicket();
  }

  // numbers behind the ticket, read from the inputs
  function calc() {
    const m = st.m;
    const mark = m?.markPx || 0;
    const raw = Number(String(sizeIn.value).replace(/,/g, "")) || 0;
    const limitPx = st.type === "limit" ? Number(String(limitIn.value).replace(/,/g, "")) || 0 : null;
    const refPx = limitPx || mark;
    // sz = the coin size rounded down to the market's step: exactly what is sent, and every dollar figure is sz × price
    const sz = raw > 0 && m ? roundSz(st.unit === "USD" ? (refPx ? raw / refPx : 0) : raw, m.szDecimals) : 0;
    return orderCalc({ m, raw, sz, refPx, isBuy: st.side === "long", type: st.type, limitPx, lev: st.lev || 1, tp: Number(tpIn.value) || null, sl: Number(slIn.value) || null, reduce: reduceIn.checked });
  }
  // the same numbers for any order (placeAfter works out a saved order again with the live book)
  function orderCalc({ m, raw = 0, sz, refPx, isBuy, type, limitPx = null, lev, tp = null, sl = null, reduce = false }) {
    const mark = m?.markPx || 0;
    const levels = isBuy ? st.book.asks : st.book.bids;
    const w = sz > 0 && levels.length ? walk(levels, sz) : { avg: null, complete: true };
    const fill = type === "limit" ? limitPx : w.avg;
    const px = fill || refPx || mark;
    const usdSize = sz * px;
    const impact = type === "market" && w.avg && mark ? Math.abs(w.avg - mark) / mark * 100 : 0;
    const margin = usdSize / lev, fee = usdSize * TAKER_FEE;
    // Hyperliquid's $10 minimum, at the lower of the mark and the order's own price (a market sell goes out 1% under)
    const orderPx = type === "market" ? (w.avg || mark) * (isBuy ? 1 + SLIP : 1 - SLIP) : limitPx || 0;
    const minValue = sz * Math.min(orderPx || mark, mark || orderPx);
    const mmr = m ? 1 / (2 * m.maxLeverage) : 0.0125;
    const liq = fill ? (isBuy ? fill * (1 - (1 / lev - mmr)) : fill * (1 + (1 / lev - mmr))) : null;
    const liqDist = liq && mark ? Math.abs(mark - liq) / mark * 100 : null;
    return { m, raw, sz, refPx: refPx || mark, mark, usdSize, fill, impact, complete: w.complete, margin, fee, need: margin + fee, minValue, liq, liqDist, isBuy, type, limitPx, lev, tp, sl, reduce };
  }

  function gateChecks(c) {
    const L = st.limits, m = c.m;
    if (!(c.raw > 0) && !(c.sz > 0)) return { state: "wait", items: [] };
    const items = [];
    const add = (label, state, value) => items.push({ label, state, value });
    if (L.paused) add("Agent", "fail", "paused in your policy");
    const listed = !L.allowedCoins || L.allowedCoins.includes(m.coin.toUpperCase());   // the policy keeps markets upper case
    add("Market", listed ? "pass" : "fail", L.allowedCoins ? (listed ? "allowed" : "not in your allowlist") : "any market");
    // checked before anything is funded or signed: Hyperliquid refuses a smaller order (a reduce-only one may still close)
    const small = !(c.minValue >= MIN_ORDER_USD);
    add("Minimum", small ? (c.reduce ? "warn" : "fail") : "pass", small ? `$10 per order · this is ${usd(c.minValue)}` : "$10 per order");
    add("Size", c.usdSize <= L.perTradeUsd ? "pass" : "fail", `${usd(c.usdSize)} of ${capUsd(L.perTradeUsd)} max`);
    if (L.dailyLeftUsd != null) add("Daily cap", c.usdSize <= L.dailyLeftUsd ? "pass" : "fail", `${usd(L.dailyLeftUsd, { compact: true })} left today`);
    add("Leverage", c.lev <= Math.min(L.maxLeverage, m.maxLeverage) ? "pass" : "fail", `${c.lev}x of ${Math.min(L.maxLeverage, m.maxLeverage)}x cap`);
    if (st.user) {
      const free = freeOf(m);
      add("Margin", c.reduce || c.need <= free ? "pass" : "fail", c.reduce ? "none needed (reduce only)" : `${usd(c.need)} needed incl. fee · ${usd(free)} free${m.dex ? " in trade.xyz" : ""}`);
    }
    if (c.type === "market") add("Price impact", !c.complete ? "fail" : c.impact > 3 ? "fail" : c.impact > 0.5 ? "warn" : "pass", c.complete ? `${c.impact.toFixed(3)}%` : "book too thin");
    if (c.liqDist != null && !c.reduce) add("Liquidation", c.liqDist < 3 ? "warn" : "pass", `~${c.liqDist.toFixed(1)}% away`);
    if (c.tp && c.fill) add("Take profit", (c.isBuy ? c.tp > c.fill : c.tp < c.fill) ? "pass" : "fail", fmtPx(c.tp));
    if (c.sl && c.fill) add("Stop loss", (c.isBuy ? c.sl < c.fill : c.sl > c.fill) ? "pass" : "fail", fmtPx(c.sl));
    if (c.type === "limit" && !(c.limitPx > 0)) add("Limit price", "fail", "enter a price");
    const state = items.some((i) => i.state === "fail") ? "fail" : items.some((i) => i.state === "warn") ? "warn" : "pass";
    return { state, items };
  }

  // what an order does to the market's leverage: a reduce-only order leaves it alone; an open position keeps its margin
  // type (isolated stays isolated) and is not touched when it already runs at this leverage
  function levPlan(m, lev, reduce) {
    if (reduce) return { set: false, isCross: undefined, type: "unchanged" };
    const p = st.user?.positions?.find((x) => x.coin === m.coin);
    const isCross = m.onlyIsolated ? false : p?.leverageType ? p.leverageType !== "isolated" : true;
    const type = isCross ? "cross" : "isolated";
    const same = !!p && Number(p.leverage) === lev && (p.leverageType || "cross") === type;
    return { set: !same, isCross, type };
  }

  function renderTicket() {
    const m = st.m;
    if (!m) return;
    if (!built) buildTicket();
    const cap = Math.max(1, Math.min(m.maxLeverage, st.limits.maxLeverage));
    st.lev = Math.min(Math.max(1, st.lev || 1), cap);
    if (levIn.max !== String(cap)) levIn.max = String(cap);
    if (levIn.value !== String(st.lev)) levIn.value = String(st.lev);
    setText(levVal, `${st.lev}x`);
    setText(levCap, `${cap}x cap`);
    press(sideBtns, (b) => b.dataset.v === st.side);
    press(typeBtns, (b) => b.dataset.v === st.type);
    press(unitBtns, (b) => b.dataset.v === st.unit);
    setText(unitBtns[1], String(tagOf(m)).slice(0, 5));
    limitField.hidden = st.type !== "limit";
    const leftToday = st.limits.dailyLeftUsd != null ? `Left today ${usd(st.limits.dailyLeftUsd, { compact: true })} · ` : "";
    setText(sizeHint, `${leftToday}max ${capUsd(st.limits.perTradeUsd)} per order`);
    const c = calc();
    const g = gateChecks(c);
    fillRows(c);
    fillXyz(m, c);
    fillGate(g);
    fillButton(m, c, g);
  }

  function fillRows(c) {
    const m = st.m, has = c.sz > 0;
    setText(rv.size, has ? `${usd(c.usdSize)} · ${num(c.sz, m.szDecimals)} ${tagOf(m)}` : "–");
    setText(rv.fillK, st.type === "market" ? "Est. fill" : "Limit price");
    setText(rv.fill, c.fill ? fmtPx(c.fill) : "–");
    setText(rv.margin, has ? usd(c.margin) : "–");
    setText(rv.fee, has ? usd(c.fee) : "–");
    setText(rv.liq, has && !c.reduce && c.liq ? fmtPx(c.liq) : "–");
  }

  function fillGate(g) {
    setCls(gateChip, `chip-s${g.state === "wait" ? "" : ` ${g.state}`}`);
    setText(gateChip, g.state === "wait" ? "Waiting" : g.state === "pass" ? "Clear" : g.state === "warn" ? "Check" : "Blocked");
    gateWait.hidden = g.state !== "wait";
    gateList.hidden = g.state === "wait";
    // the same checks in the same order → their values are patched in place; another set → the list is rebuilt
    const lis = gateList.children;
    if (lis.length !== g.items.length || g.items.some((it, i) => lis[i].firstChild.textContent !== it.label)) clear(gateList, g.items.map((it) => h("li", {}, h("span", {}, it.label), h("b", {}))));
    g.items.forEach((it, i) => { setCls(lis[i], it.state); setText(lis[i].lastChild, it.value); });
    // the leverage a trade here can really use: the lower of the policy's cap and the market's own (ANT stops at 10x)
    const m = st.m;
    setText(gateFoot, `${st.limits.source === "your policy" ? "Your limits" : "Default limits"}: ${capUsd(st.limits.perTradeUsd)} per order, up to ${Math.min(st.limits.maxLeverage, m?.maxLeverage || Infinity)}x on ${tagOf(m)}.`);
  }

  function fillXyz(m, c) {
    xyzBox.hidden = !(m.dex && st.user);
    if (xyzBox.hidden) return;
    const free = freeOf(m);
    if (st.user.unified) {
      setText(xyzText, `Unified account: one USDC balance (${usd(free)} free) backs Hyperliquid perps, trade.xyz and spot, so nothing needs moving. Stock perps trade around the clock; outside market hours the price is held inside a band.`);
      xyzMove.hidden = xyzBack.hidden = true;
      return;
    }
    const need = c.need || 0, main = st.user.withdrawable || 0;
    const short_ = need > free ? Math.ceil((need - free) * 1.05 * 100) / 100 + 0.5 : 0;
    setText(xyzText, `trade.xyz margin is its own balance: ${usd(free)} there, ${usd(main)} in your Hyperliquid perps. Stock perps trade around the clock; outside market hours the price is held inside a band.`);
    xyzMove._amt = Math.min(short_, main);
    xyzMove.hidden = !(short_ > 0 && main > 0);
    setText(xyzMove, `Move ${usd(xyzMove._amt)} USDC to trade.xyz`);
    xyzBack._amt = free;
    xyzBack.hidden = !(free > 0.5);
    setText(xyzBack, `Move ${usd(free)} back to perps`);
  }

  // main button state machine: one button, its label, look, action and disabled state change in place
  function fillButton(m, c, g) {
    const sideCls = st.side === "long" ? "blue" : "danger";
    let label, cls = "btn big", act = null, note = null;   // note = [signature, build]
    if (!wallet.address) { label = "Connect wallet"; cls += " primary"; act = () => openConnect(); }
    else if (st.key.state !== "approved" && noDeposit()) {
      // Hyperliquid refuses approveAgent before any deposit, so a new account funds first (that needs no key), then
      // approves the key, then the order goes out: one flow, three wallet steps
      const fails = g.items.filter((i) => i.state === "fail");
      const ok = g.state !== "wait" && !c.reduce && fails.every((i) => i.label === "Margin");
      cls += ` ${sideCls}`;
      if (g.state === "wait") { label = `Fund Hyperliquid & ${st.side} ${tagOf(m)}`; act = () => { sizeIn.focus(); toast("Enter a size first: the funding is sized to the order.", ""); }; }
      else if (ok) { label = `Fund Hyperliquid & ${st.side} ${tagOf(m)}`; act = fundAndOpen; }
      else label = c.reduce ? "Nothing to reduce yet" : "Blocked by Troya Gate";
      note = ["new", () => ["Your Hyperliquid account has no USDC yet. One transaction on Robinhood Chain funds it (no trading key needed for that), then one signature approves a ", h("b", {}, "trade-only key"), " that ", h("b", {}, "cannot withdraw"), ", and the order opens. ",
        h("button", { class: "link", type: "button", onclick: enableTrading }, "Already funded? Enable trading")]];
    }
    else if (st.key.state !== "approved") {
      label = st.key.state === "expired" ? "Re-enable trading" : "Enable trading"; cls += " blue"; act = enableTrading;
      note = ["key", () => ["One wallet signature approves a ", h("b", {}, "trade-only key"), " kept in this browser. It can place and cancel Hyperliquid orders but ", h("b", {}, "cannot withdraw"), ". You can revoke it any time."]];
    } else {
      const ready = g.state === "pass" || g.state === "warn";
      // end to end: margin is the only check in the way → fund the missing USDC from Robinhood Chain (for a trade.xyz
      // market, then move it into that balance), then open
      const onlyMargin = g.state === "fail" && !c.reduce && !!st.user && g.items.filter((i) => i.state === "fail").every((i) => i.label === "Margin");
      cls += ` ${sideCls}`;
      if (onlyMargin) {
        const plan = fundPlan(m, c);
        label = `${plan.bridge ? "Fund" : "Move"} & ${st.side === "long" ? "long" : "short"} ${tagOf(m)}`;
        act = fundAndOpen;
        const text = !plan.xyz
          ? `Your Hyperliquid account has ${usd(freeOf(m))} free and this order needs about ${usd(c.need)}. One transaction on Robinhood Chain sends the missing USDC (at least 6), then the order opens by itself when it lands.`
          : plan.bridge
            ? `Your trade.xyz balance has ${usd(freeOf(m))} free and this order needs about ${usd(c.need)}. One transaction on Robinhood Chain sends USDC to your Hyperliquid account (at least 6), one signature moves ${usd(plan.move)} into trade.xyz, then the order opens.`
            : `Your trade.xyz balance has ${usd(freeOf(m))} free; your Hyperliquid perps balance has ${usd(plan.main)}. One signature moves ${usd(plan.move)} into trade.xyz, then the order opens.`;
        note = [text, () => text];
      } else {
        label = g.state === "wait" ? "Enter a size" : ready ? `${st.side === "long" ? "Long" : "Short"} ${tagOf(m)}` : "Blocked by Troya Gate";
        act = ready ? submit : null;
        const k = st.key.key?.address;
        note = [`key:${k}`, () => [`Trading key ${short(k)} active. `, h("button", { class: "link", type: "button", onclick: revoke }, "Revoke")]];
      }
    }
    if (st.funding) { label = st.funding.step === 1 ? "Confirming on Robinhood Chain…" : "Waiting for the USDC on Hyperliquid…"; act = null; }
    else if (st.busy) { label = st.busy; act = null; }
    // while Fund & open runs (and a few seconds after the order), the note tracks it: 1 Sent · 2 Bridging · 3 Landed · 4 Order placed
    if (st.fundStep) {
      const { hash, step } = st.fundStep;
      const steps = FUND_STEPS.map((t, i) => [i ? " · " : "", i + 1 === step ? h("b", {}, `${i + 1} ${t}`) : `${i + 1} ${t}`]);
      note = [`fund:${hash}:${step}`, () => ["Funding ", h("a", { class: "mono link", href: `https://robinhoodchain.blockscout.com/tx/${hash}`, target: "_blank", rel: "noopener" }, short(hash, 6)), ": ", steps,
        step < 3 ? ". The order goes out from this page when the USDC lands, usually within a minute or two. Keep the page open." : step < 4 ? ". Keep the page open while the order goes out." : "."]];
    }
    setCls(mainBtn, cls);
    setText(mainBtn, label);
    mainBtn.disabled = !act;
    btnAct = act;
    keyNote.hidden = !note;
    if (note) patch(keyNote, note[0], note[1]);
  }

  function freeOf(m) { return m?.dex ? +(st.user?.dexes?.[m.dex]?.withdrawable || 0) : +(st.user?.withdrawable || 0); }
  // an account Hyperliquid has never seen a deposit on: no value anywhere and no fills or spot balance, or Hyperliquid
  // itself said "Must deposit" (until a balance shows)
  function noDeposit() {
    const u = st.user;
    if (!u || u.accountValue > 0 || u.withdrawable > 0 || u.dexes?.xyz?.accountValue > 0 || u.positions?.length) return false;
    return st.noDeposit || (!(u.fills || []).length && !(u.spot || []).length);
  }
  // what an order short of margin needs: USDC bridged in from Robinhood Chain, and for a trade.xyz market (own balance,
  // unless the account is unified) a move from the Hyperliquid perps balance into trade.xyz
  function fundPlan(m, c) {
    const xyz = !!m.dex && !st.user?.unified;
    const missing = Math.max(0, c.need * 1.05 + 0.5 - freeOf(m));      // margin plus the taker fee, 5% and $0.50 spare
    if (!xyz) return { xyz, missing, bridge: missing > 0, bridgeUsd: missing, move: 0, main: 0 };
    const main = +(st.user?.withdrawable || 0), move = Math.ceil(missing * 100) / 100;
    const short_ = Math.max(0, move - main);
    return { xyz, missing, main, move, bridge: short_ > 0, bridgeUsd: short_ > 0 ? short_ + 0.5 : 0 };
  }
  async function moveUsdc(amount, from, to) {
    if (st.busy || !(amount > 0)) return;
    st.busy = "Sign the move in your wallet…";
    renderTicket();
    try {
      await ensureChain("arbitrum");
      await sendToDex(wallet.address, wallet.eip, amount, from, to);
      toast(`Moved ${usd(amount)} USDC ${to === "xyz" ? "to trade.xyz" : "back to perps"}`, "ok");
      await loadUser({ fresh: true });
    } catch (e) { toast(rejected(e) ? "Cancelled. Nothing was moved." : errMsg(e), "error", 6000); }
    finally { st.busy = null; if (alive) renderTicket(); }
  }
  // one wallet signature approves the trade-only key; true once it is approved. inFlow: asked by Fund & open after the
  // USDC landed, so the review does not ask for a deposit that was just made
  async function approveKey({ inFlow = false } = {}) {
    const ok = await review({ title: "Enable trading on Hyperliquid", summary: inFlow ? "Your USDC is on Hyperliquid. Approve a trade-only key for this browser so the order can go out." : "Approve a trade-only key for this browser.", confirmLabel: "Approve in wallet", rows: [
      ["Account", short(wallet.address, 6)], ["Key name", "Troya"], ["Can", "place and cancel perp orders, change leverage"], ["Cannot", "withdraw or transfer funds"], ["Stored", "in this browser only"], ["Signature network", "Arbitrum (EIP-712 typed data, no gas)"],
    ], warn: `${inFlow ? "" : "Your Hyperliquid account must already hold USDC. You can fund it from this ticket with ETH on Robinhood Chain (Fund & open). "}If someone gets this browser's storage they could trade (not withdraw) until you revoke it.` });
    if (!ok) return false;
    await ensureChain("arbitrum");
    await approveTradingKey(wallet.address, wallet.eip);
    toast("Trading key approved", "ok");
    api.post("journal", { kind: "perp_key", summary: "Approved a trade-only Hyperliquid key for this browser", data: { key: getTradingKey(wallet.address)?.address } }).catch(() => {});
    // Hyperliquid's agent list can take a few seconds to show the new key: it counts as approved now, and is read back later
    st.noDeposit = false;
    st.key = { state: "approved", key: getTradingKey(wallet.address) };
    setTimeout(() => { if (alive) loadKey(); }, 6000);
    return true;
  }
  async function enableTrading() {
    if (st.busy) return;
    st.busy = "Confirm in your wallet…";
    renderTicket();
    let fund = false;
    try { await approveKey(); }
    catch (e) {
      // "Must deposit before performing actions": the account has never been funded, so the ticket switches to Fund first
      if (mustDeposit(e)) { st.noDeposit = true; fund = true; }
      else toast(rejected(e) ? "Request cancelled in the wallet." : errMsg(e), "error", 6000);
    }
    finally { st.busy = null; if (alive) renderTicket(); }
    if (fund && alive) askFund();
  }
  async function askFund() {
    const m = st.m;
    const ok = await review({ title: "Fund your Hyperliquid account first", confirmLabel: `Fund & ${st.side} ${tagOf(m)}`,
      summary: "Hyperliquid approves a trading key only on an account that has received a deposit. Fund it from this ticket with ETH on Robinhood Chain: one transaction sends the USDC, then one signature approves the key and the order opens.",
      rows: [["Account", short(wallet.address, 6)], ["Hyperliquid balance", usd(+(st.user?.withdrawable || 0))], ["Market", nameOf(m)]] });
    if (!ok || !alive) return;
    if (!(calc().sz > 0)) { sizeIn.focus(); toast("Enter a size: the funding is sized to the order.", ""); return; }
    fundAndOpen();
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
    if (st.busy) return;
    const m = st.m, c = calc();
    const g = gateChecks(c);
    if (g.state === "fail" || g.state === "wait") return;
    const lp = levPlan(m, c.lev, c.reduce);
    // in flight from the first click: the button is disabled with this label, so a second click cannot send it again
    st.busy = "Confirm the order…";
    renderTicket();
    try {
      const ok = await review({
        title: `${st.side === "long" ? "Long" : "Short"} ${nameOf(m)}`, confirmLabel: "Place order", danger: st.side === "short",
        rows: [
          ["Type", c.type === "market" ? "Market (IOC, 1% max slippage)" : "Limit (good till cancelled)"],
          ["Size", `${num(c.sz, m.szDecimals)} ${tagOf(m)} · ${usd(c.usdSize)}`],
          [c.type === "market" ? "Est. fill" : "Limit price", fmtPx(c.fill)],
          ["Leverage", c.reduce ? "unchanged (reduce only)" : `${c.lev}x ${lp.type}${lp.set ? "" : " (already set)"}`],
          ["Margin", c.reduce ? "none (reduce only)" : `${usd(c.margin)} + ${usd(c.fee)} est. fee`],
          ["Est. liquidation", c.reduce ? "–" : fmtPx(c.liq)],
          c.tp ? ["Take profit", fmtPx(c.tp)] : null,
          c.sl ? ["Stop loss", fmtPx(c.sl)] : null,
          c.reduce ? ["Reduce only", "yes"] : null,
        ],
        warn: g.state === "warn" ? g.items.filter((i) => i.state === "warn").map((i) => `${i.label}: ${i.value}`).join(" · ") : null,
      });
      if (!ok) return;
      st.busy = "Placing the order…";
      renderTicket();
      const r = await placeOrder({ owner: wallet.address, market: m, isBuy: c.isBuy, size: c.sz, limitPx: c.type === "limit" ? c.limitPx : null, reduceOnly: c.reduce, leverage: lp.set ? c.lev : null, isCross: lp.isCross, tp: c.tp, sl: c.sl, refPx: c.fill || undefined });
      const failed = /error/.test(r.text) && !/filled|resting/.test(r.text);
      toast(`${tagOf(m)}: ${r.text || "sent"}`, failed ? "error" : "ok", 6000);
      api.post("journal", { kind: "perp_order", summary: `${st.side === "long" ? "Long" : "Short"} ${num(r.size, m.szDecimals)} ${tagOf(m)} @ ${c.type === "market" ? "market" : fmtPx(r.px)} · ${r.text}`,
        data: { coin: m.coin, side: st.side, type: c.type, size: r.size, px: r.px, leverage: c.lev, leverageSet: lp.set, tp: c.tp, sl: c.sl, reduceOnly: c.reduce, result: r.text, via: "own wallet trading key" } }).catch(() => {});
      if (!failed) { sizeIn.value = ""; typed = null; }
      setTimeout(loadUser, 800);
    } catch (e) { toast(errMsg(e), "error", 7000); }
    finally { st.busy = null; if (alive) renderTicket(); }
  }

  // Fund & open: ETH on Robinhood Chain → USDC on this address on Hyperliquid (one LI.FI transaction), then the order.
  // trade.xyz markets (e.g. Anthropic, xyz:ANT): the USDC lands in the perps balance, so one signature moves it into
  // trade.xyz before the order; when the perps balance already covers it, only the move and the order.
  // A new account (no deposit yet, so no trading key either): fund first, then the key, then the order.
  async function fundAndOpen() {
    if (st.busy) return;
    const m = st.m, c = calc(), g = gateChecks(c);
    // only the margin may be missing: the $10 minimum, the caps and the book must already pass before anything is funded
    if (g.state === "wait" || g.items.some((i) => i.state === "fail" && i.label !== "Margin")) return;
    const plan = fundPlan(m, c);
    const needKey = st.key.state !== "approved";
    if (!(plan.missing > 0)) return needKey ? enableTrading() : submit();
    st.busy = "Confirm in your wallet…";
    stage = null;
    renderTicket();
    try { await fundFlow(m, c, plan, needKey); }
    catch (e) {
      const no = rejected(e);
      // what the cancel or error really left behind, by stage: nothing sent yet, funding on its way, or USDC on Hyperliquid
      const msg = stage === "key" ? (no ? "Cancelled. Your USDC is safe on Hyperliquid; enable trading and place the order when ready."
          : mustDeposit(e) ? "Hyperliquid has not credited the deposit yet. Wait a minute, then enable trading and place the order from the ticket."
          : `${errMsg(e)} Your USDC is safe on Hyperliquid; enable trading and place the order when ready.`)
        : stage === "move" ? (no ? "Cancelled. Your USDC is safe on Hyperliquid; move it to trade.xyz and place the order when ready." : `The move to trade.xyz failed: ${errMsg(e)} Your USDC is safe on Hyperliquid.`)
        : stage === "bridge" ? `${errMsg(e)} The funding is on its way: the USDC reaches your Hyperliquid account and you can place the order then.`
        : stage === "landed" || stage === "order" ? `${errMsg(e)} Your USDC is on Hyperliquid; place the order when ready.`
        : no ? "Cancelled. Nothing was sent." : errMsg(e);
      toast(msg, "error", 8000);
    } finally {
      st.funding = null;
      st.busy = null;
      stage = null;
      // the steps stay on the note for a few seconds after the order went out, then the ticket is back to normal
      if (st.fundStep?.step === 4) { const f = st.fundStep; setTimeout(() => { if (st.fundStep !== f) return; st.fundStep = null; if (alive) renderTicket(); }, 10_000); }
      else st.fundStep = null;
      if (alive) renderTicket();
    }
  }
  // the wallet's ETH on Robinhood Chain must cover the amount plus gas: checked before the review, so a short wallet hears
  // it here and not from a failed transaction. A balance read that fails does not block (the wallet refuses a short send).
  async function ethCheck(q) {
    const ethUsd = q.amountEth > 0 && q.fundUsd > 0 ? q.fundUsd / q.amountEth : 0;
    const [bal, fee] = await Promise.all([balanceOf(wallet.address, ETH, "robinhood").catch(() => null), reader("robinhood").getFeeData().catch(() => null)]);
    const gasPrice = BigInt(fee?.maxFeePerGas ?? fee?.gasPrice ?? 100_000_000n);   // 0.1 gwei when the fee read fails
    const needWei = BigInt(q.tx.value) + ((BigInt(q.tx.gasLimit) * 13n) / 10n) * gasPrice;
    const eth = (wei) => Number(wei) / 1e18;
    const short_ = bal && bal.raw < needWei
      ? `Not enough ETH on Robinhood Chain: this needs about ${num(eth(needWei), 6)} ETH (${usd(eth(needWei) * ethUsd)}) including gas, and your wallet holds ${num(bal.amount, 6)} ETH. Add ETH and try again.`
      : null;
    return { bal, ethUsd, short: short_ };
  }
  async function fundFlow(m, c, plan, needKey) {
    const what = `${st.side === "long" ? "Long" : "Short"} ${num(c.sz, m.szDecimals)} ${tagOf(m)} · ${usd(c.usdSize)} at ${c.lev}x`;
    // the order as reviewed; placeAfter works it out again with the live book before it goes out
    const order = { coin: m.coin, isBuy: c.isBuy, sz: c.sz, limitPx: c.type === "limit" ? c.limitPx : null, lev: c.lev, tp: c.tp, sl: c.sl, need: c.need, side: st.side, type: c.type, usdSize: c.usdSize, fill: c.fill, mid: midNow(), what };
    const typeRow = c.type === "limit" ? ["Limit price", fmtPx(c.limitPx)] : ["Type", "Market (IOC, 1% max slippage)"];
    const marginRow = ["Margin", `${usd(c.margin)} + ${usd(c.fee)} est. fee`];
    const keyRow = needKey ? ["Then", "approve a trade-only key (one signature, no gas)"] : null;
    // the key is asked for only once the USDC is there: Hyperliquid refuses it on an account with no deposit
    const askKey = async () => {
      if (!needKey) return true;
      stage = "key";
      st.busy = "Approve the trading key in your wallet…";
      renderTicket();
      if (await approveKey({ inFlow: true })) return true;
      toast("Not placed. Your USDC is safe on Hyperliquid; enable trading and place the order from the ticket when ready.", "", 9000);
      return false;
    };
    if (!plan.bridge) {           // trade.xyz, the perps balance covers it: move, then open
      const ok = await review({ title: `Move USDC to trade.xyz, then ${st.side} ${nameOf(m)}`, confirmLabel: "Sign the move", danger: st.side === "short",
        summary: `One signature (no gas) moves ${usd(plan.move)} from your Hyperliquid perps balance into trade.xyz, then the order is placed.`,
        rows: [["Move", `${usd(plan.move)} USDC · perps → trade.xyz`], keyRow, ["Then", what], marginRow, typeRow] });
      if (!ok) return;
      stage = "move";
      st.busy = "Sign the move in your wallet…";
      renderTicket();
      await ensureChain("arbitrum");
      await sendToDex(wallet.address, wallet.eip, plan.move, "", m.dex);
      await loadUser({ fresh: true });
      if (!(await askKey())) return;
      return placeAfter(order, null);
    }
    const quote = () => api.get(`hl/fund-quote?${new URLSearchParams({ address: wallet.address, usd: plan.bridgeUsd.toFixed(2) })}`);
    let q, qAt;
    try { q = await quote(); qAt = Date.now(); }
    catch (e) { toast(`No funding route right now: ${e.message}`, "error", 6000); return; }
    if (!alive) return;
    let moved = null;   // set when the quote was priced again and came back worse
    for (;;) {
      const fund = await ethCheck(q);
      if (!alive) return;
      if (fund.short) { toast(fund.short, "error", 10000); return; }
      const usdc = Number(q.toAmount) / 10 ** q.toDecimals, usdcMin = Number(q.toAmountMin) / 10 ** q.toDecimals;
      const after = [needKey && "one signature (no gas) approves a trade-only key", plan.xyz && `one signature (no gas) moves ${usd(plan.move)} into trade.xyz`].filter(Boolean);
      const ok = await review({ title: `Fund Hyperliquid, then ${st.side} ${nameOf(m)}`, confirmLabel: "Fund in wallet", danger: st.side === "short",
        summary: `One transaction on Robinhood Chain sends about ${usd(usdc)} USDC to your Hyperliquid account. ${after.length ? `When it lands, ${after.join(", then ")}, and the order is placed from this page.` : "The order is placed from this page the moment it lands."}`,
        rows: [["You send", `${q.amountEth} ETH (${usd(q.amountEth * fund.ethUsd)}) on Robinhood Chain`],
          fund.bal ? ["Your ETH", `${num(fund.bal.amount, 6)} ETH (${usd(fund.bal.amount * fund.ethUsd)})`] : null,
          ["Lands on Hyperliquid (est.)", `${usdc.toFixed(2)} USDC (min ${usdcMin.toFixed(2)})`], ["Route", `${q.tool} via LI.FI`], ["Route fees", usd(q.feeUsd + q.gasUsd)],
          keyRow, plan.xyz ? ["Then", `move ${usd(plan.move)} USDC into trade.xyz (one signature)`] : null, ["Then", what], marginRow, typeRow],
        warn: `${moved ? `${moved} ` : ""}The funding goes through a third-party route and cannot be reversed. Keep this page open until the order is placed; if you leave, the USDC still lands on your Hyperliquid account and you can place the order later.` });
      if (!ok) return;
      if (Date.now() - qAt <= 30_000) break;
      // the review stayed open more than 30 s: the route is priced again. A quote no worse goes out as it is; a worse one
      // (less USDC, or more ETH) is shown again
      const old = q;
      st.busy = "Refreshing the quote…";
      renderTicket();
      try { q = await quote(); qAt = Date.now(); }
      catch (e) { toast(`No funding route right now: ${e.message}`, "error", 6000); return; }
      if (!alive) return;
      const worse = Number(q.toAmountMin) < Number(old.toAmountMin) * 0.99 || BigInt(q.tx.value) > (BigInt(old.tx.value) * 101n) / 100n;
      if (!worse) {
        const f2 = await ethCheck(q);
        if (f2.short) { toast(f2.short, "error", 10000); return; }
        break;
      }
      moved = "The route was priced again after 30 s and moved: check the new numbers.";
      st.busy = "Confirm in your wallet…";
      renderTicket();
    }
    stage = "fund";
    st.busy = "Confirm the funding in your wallet…";
    renderTicket();
    const hash = await sendTx("robinhood", { to: q.tx.to, data: q.tx.data, value: q.tx.value, gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n });
    stage = "bridge";
    const usdcEst = Number(q.toAmount) / 10 ** q.toDecimals;
    api.post("journal", { kind: "bridge", summary: `Fund Hyperliquid for a ${tagOf(m)} order: ${q.amountEth} ETH → about ${usdcEst.toFixed(2)} USDC`, data: { hash, route: q.tool, via: "Perps · Fund & open" } }).catch(() => {});
    st.funding = { hash, at: Date.now(), step: 1 };
    st.fundStep = { hash, step: 1 };
    renderTicket();
    // 1 Sent: the receipt first. A reverted transaction bridged nothing, so the flow stops here and says so (it used to
    // wait ten minutes for USDC that could never land)
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
    if (!alive) return;
    if (!rc) { toast("The funding transaction has not confirmed after 3 minutes. Check it on the explorer: if it confirms, the USDC reaches your Hyperliquid account and you can place the order then.", "error", 12000); return; }
    if (Number(rc.status) !== 1) { toast("The funding transaction failed on Robinhood Chain (reverted): nothing was bridged and no order was placed. Only the network fee was spent. Try again for a fresh quote.", "error", 12000); return; }
    st.funding.step = st.fundStep.step = 2;
    toast("Funding confirmed on Robinhood Chain. The order goes out as soon as the USDC lands.", "ok", 6000);
    renderTicket();
    // 2 Bridging: the route's own status and a fresh balance read every 5 s, for ten minutes at most
    const mainNow = () => +(st.user?.withdrawable || 0);
    const mkNow = () => st.markets.find((x) => x.coin === order.coin) || m;
    const landedNow = () => (plan.xyz ? mainNow() >= plan.move * 0.98 || freeOf(mkNow()) + mainNow() >= order.need * 1.01 : freeOf(mkNow()) >= order.need * 1.01);
    let routeDone = false;
    while (alive && Date.now() - st.funding.at < 10 * 60_000) {
      await sleep(5000);
      if (!routeDone) {
        const s = await api.get(`bridge/status?${new URLSearchParams({ txHash: hash, fromChain: String(CHAINS.robinhood.id), toChain: String(HL_CHAIN) })}`).catch(() => null);
        if (s?.status === "DONE") routeDone = true;
        if (s?.status === "FAILED") {
          const why = s.substatus ? ` (${String(s.substatus).toLowerCase().replace(/_/g, " ")})` : "";
          toast(`The funding route reports a failure${why}. No order was placed. Check the transaction on the explorer; any refund from the route goes back to your wallet.`, "error", 12000);
          return;
        }
      }
      await loadUser({ fresh: true });
      if (landedNow()) break;
    }
    const landed = landedNow();
    st.funding = null;
    if (!alive) return;
    if (!landed) { toast(`The USDC has not landed yet. It will reach your Hyperliquid account; ${needKey ? "enable trading, " : ""}${plan.xyz ? "move it to trade.xyz and " : ""}place the order once it shows.`, "", 9000); return; }
    // 3 Landed: the key (a new account), the move (trade.xyz), then the order
    stage = "landed";
    st.fundStep.step = 3;
    st.busy = "USDC landed · preparing the order…";
    renderTicket();
    if (needKey) toast("USDC landed. Approve the trading key to place the order.", "ok", 7000);
    if (!(await askKey())) return;
    if (plan.xyz) {
      const need = Math.max(0, order.need * 1.05 + 0.5 - freeOf(mkNow())), amt = Math.min(Math.ceil(need * 100) / 100, Math.floor(mainNow() * 100) / 100);
      if (amt > 0) {
        stage = "move";
        st.busy = "Sign the move in your wallet…";
        renderTicket();
        toast("Sign the move into trade.xyz to place the order.", "ok", 7000);
        await ensureChain("arbitrum");
        await sendToDex(wallet.address, wallet.eip, amt, "", m.dex);
        await loadUser({ fresh: true });
      }
    }
    return placeAfter(order, hash);
  }
  // the order after funding or a move, placed with the trading key. Minutes can pass while the USDC lands, so it is
  // worked out again with the live book first: a Gate failure stops it, and a price more than 1% away from the reviewed
  // one (or a Gate warning) asks once more instead of firing
  async function placeAfter(order, fundTx) {
    stage = "order";
    st.busy = "Preparing the order…";
    renderTicket();
    const mk = () => st.markets.find((x) => x.coin === order.coin) || st.m;
    const again = () => { const c = orderCalc({ m: mk(), sz: order.sz, refPx: order.limitPx || mk().markPx, isBuy: order.isBuy, type: order.type, limitPx: order.limitPx, lev: order.lev, tp: order.tp, sl: order.sl }); return { c, g: gateChecks(c) }; };
    const stopped = (g) => toast(`Not placed: ${g.items.filter((i) => i.state === "fail").map((i) => `${i.label} ${i.value}`).join(" · ")}. Your USDC is safe on Hyperliquid; place the order from the ticket when ready.`, "error", 10000);
    // a balance read right after a funding or a move can still be the old one: fresh reads, for up to 6 s, until the
    // free margin covers the order
    const t0 = Date.now();
    while (alive && freeOf(mk()) < order.need && Date.now() - t0 < 6000) { await sleep(1000); await loadUser({ fresh: true }); }
    if (!alive) return;
    let { c, g } = again();
    if (g.state === "fail") { stopped(g); return; }
    const nowPx = order.type === "market" ? c.fill || midNow() : midNow();
    const thenPx = order.type === "market" ? order.fill || order.mid : order.mid;
    const moved = nowPx && thenPx ? Math.abs(nowPx - thenPx) / thenPx : 0;
    if (moved > 0.01 || g.state === "warn") {
      st.busy = "Confirm the order…";
      renderTicket();
      const ok = await review({ title: `Place the ${nameOf(mk())} order?`, confirmLabel: "Place anyway", danger: order.side === "short",
        summary: moved > 0.01 ? `Price moved from ${fmtPx(thenPx)} to ${fmtPx(nowPx)} — place anyway?` : "The Troya Gate flagged this order after you reviewed it. Place anyway?",
        rows: [["Order", order.what], [order.type === "market" ? "Est. fill now" : "Limit price", fmtPx(c.fill)], ["Margin", `${usd(c.margin)} + ${usd(c.fee)} est. fee`]],
        warn: g.items.filter((i) => i.state === "warn").map((i) => `${i.label}: ${i.value}`).join(" · ") || null });
      if (!ok) { toast("Not placed. Your USDC is safe on Hyperliquid; place the order from the ticket when ready.", "", 8000); return; }
      ({ c, g } = again());
      if (g.state === "fail") { stopped(g); return; }
    }
    const m = mk(), lp = levPlan(m, order.lev, false);
    st.busy = "Placing the order…";
    renderTicket();
    try {
      const r = await placeOrder({ owner: wallet.address, market: m, isBuy: order.isBuy, size: order.sz, limitPx: order.limitPx, reduceOnly: false, leverage: lp.set ? order.lev : null, isCross: lp.isCross, tp: order.tp, sl: order.sl, refPx: c.fill || undefined });
      const failed = /error/.test(r.text) && !/filled|resting/.test(r.text);
      toast(`${tagOf(m)}: ${r.text || "sent"}`, failed ? "error" : "ok", 7000);
      api.post("journal", { kind: "perp_order", summary: `${order.side === "long" ? "Long" : "Short"} ${num(r.size, m.szDecimals)} ${tagOf(m)} @ ${order.type === "market" ? "market" : fmtPx(r.px)} · ${r.text} (${fundTx ? "after funding" : "after a move to trade.xyz"})`,
        data: { coin: order.coin, side: order.side, type: order.type, size: r.size, px: r.px, leverage: order.lev, leverageSet: lp.set, tp: order.tp, sl: order.sl, result: r.text, via: `own wallet trading key · ${fundTx ? "Fund & open" : "Move & open"}`, fundTx } }).catch(() => {});
      if (!failed) { sizeIn.value = ""; typed = null; if (fundTx && st.fundStep) st.fundStep.step = 4; }
    } catch (e) { toast(`${errMsg(e)} Your USDC is on Hyperliquid; place the order when ready.`, "error", 8000); }
    setTimeout(loadUser, 800);
  }

  async function closePosition(p) {
    const m = st.markets.find((x) => x.coin === p.coin);
    if (!m) return;
    if (st.key.state !== "approved") { toast("Enable trading first to close from here.", ""); return; }
    const ok = await review({ title: `Close ${nameOf(m)} position`, confirmLabel: "Close at market", danger: true, rows: [["Side", p.size > 0 ? "Long" : "Short"], ["Size", `${num(Math.abs(p.size), 5)} ${tagOf(m)}`], ["Mark", fmtPx(m.markPx, m)], ["Unrealised PnL", usd(p.unrealizedPnl)]] });
    if (!ok) return;
    try {
      // the 1% cap is set from the live book, not the market list: /api/hl/meta may answer from a copy up to a minute old
      // while it refreshes (server/hl.mjs), and a cap off an old mid either misses the fill or lets it sweep further
      const b = await api.get(`hl/book?coin=${encodeURIComponent(p.coin)}`).catch(() => null);
      const live = b?.bids?.[0] && b?.asks?.[0] ? (b.bids[0].px + b.asks[0].px) / 2 : undefined;
      const r = await placeOrder({ owner: wallet.address, market: m, isBuy: p.size < 0, size: Math.abs(p.size), reduceOnly: true, refPx: live });
      toast(`${tagOf(m)}: ${r.text}`, /error/.test(r.text) ? "error" : "ok", 6000);
      api.post("journal", { kind: "perp_order", summary: `Closed ${tagOf(m)} ${p.size > 0 ? "long" : "short"} at market · ${r.text}`, data: { coin: p.coin, reduceOnly: true, size: Math.abs(p.size), result: r.text } }).catch(() => {});
      setTimeout(loadUser, 800);
    } catch (e) { toast(errMsg(e), "error", 7000); }
  }
  async function cancel(o) {
    const m = st.markets.find((x) => x.coin === o.coin);
    if (!m) return;
    if (st.key.state !== "approved") { toast("Enable trading first to cancel from here.", ""); return; }
    try {
      await cancelOrder({ owner: wallet.address, market: m, oid: o.oid });
      toast("Order cancelled", "ok");
      api.post("journal", { kind: "perp_cancel", summary: `Cancelled ${tagOf(m)} ${o.side} order ${o.oid}`, data: o }).catch(() => {});
      setTimeout(loadUser, 600);
    } catch (e) { toast(errMsg(e), "error", 6000); }
  }

  /* ---------- boot ---------- */
  // the market list, with two quick retries when the market asked for is missing; the chart is built meanwhile and draws
  // its candles (already asked for at mount) once the list has named the market
  const metaP = (async () => {
    await loadMeta();
    for (let i = 0; i < 2 && fellBack && alive; i++) { await sleep(1500); st.m = null; fellBack = false; await loadMeta(); }
  })();
  initChart(metaP);
  try { await metaP; }
  catch (e) {
    // nothing to trade without the list: stop what already runs (the live dot, the chart) before the message replaces the page
    alive = false;
    stops.forEach((f) => { try { f(); } catch {} });
    themeObs?.disconnect();
    try { chart?.remove(); } catch {}
    clear(view, h("div", { class: "empty", style: { padding: "100px 0" } }, h("b", {}, "Hyperliquid markets could not be loaded."), h("div", {}, e.message), h("button", { class: "btn", type: "button", onclick: () => ctx.go(location.hash) }, "Try again")));
    return;
  }
  if (!alive) return;
  if (fellBack) {
    const xyzMissing = !st.markets.some((x) => x.dex);
    toast(want.includes(":") || xyzMissing ? `${ctx.parts[0]} has not loaded yet (the trade.xyz list is on its way); showing ${nameOf(st.m)} and switching the moment it does.` : `No perp called ${ctx.parts[0]}; showing ${nameOf(st.m)}.`, "", 7000);
  }
  renderTicket();
  renderPositions();
  loadPolicy();
  stops.push(every(5000, headTick));
  stops.push(every(1500, loadBook));
  const candleTimer = setInterval(() => { if (!document.hidden) loadCandles(false); }, 5000);
  stops.push(() => clearInterval(candleTimer));
  const offWallet = onWallet(() => { loadUser(); loadKey(); loadPolicy(); });
  stops.push(offWallet);
  stops.push(every(6000, () => { if (wallet.address) loadUser(); }));

  return () => { alive = false; stops.forEach((f) => { try { f(); } catch {} }); themeObs?.disconnect(); try { chart?.remove(); } catch {} };
}
