// Market (#/market): Robinhood Chain board (default), tokenized stocks, Hyperliquid perps and spot.
import { h, clear, useCss, pageHead, seg, table, sparkline, pctEl, usd, tiny, compact, every, debounce, emptyState, tokenIcon, coinIcon, padLogo, chainLogo, infoTip } from "../ui.js";
import { api, cached } from "../api.js";
import { LAUNCHPADS, padName, tokenCell, priceCell, ethAmount, usdCell, mcapCell, ageText, updatedText, fmtFunding, fmtApr, perpPrice } from "../marketlib.js";
// phones: price on top, market cap under it (instead of the ETH price), so the board stays three columns wide
const priceMcCell = (t) => h("div", { class: "pcell" }, h("span", {}, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"), h("span", { class: "sub" }, t.mcapUsd != null ? `MC ${usd(t.mcapUsd, { compact: true })}` : "MC –"));

const PAGE = 50;
const NARROW = matchMedia("(max-width: 720px)").matches;

export async function mount(view, { go, query }) {
  useCss("home");
  useCss("market");
  let tab = ["robinhood", "stocks", "perps", "spot"].includes(query.tab) ? query.tab : "robinhood";
  let stopTab = null;

  const body = h("div");
  const tabSeg = seg([{ value: "robinhood", label: h("span", { class: "seg-ico" }, chainLogo("robinhood", 14), "Robinhood Chain") }, { value: "stocks", label: h("span", { class: "seg-ico" }, chainLogo("robinhood", 14), "Stocks") }, { value: "perps", label: h("span", { class: "seg-ico" }, chainLogo("hyperliquid", 14), "Perps") }, { value: "spot", label: h("span", { class: "seg-ico" }, chainLogo("hyperliquid", 14), "Spot") }], tab, (v) => {
    tab = v;
    history.replaceState(null, "", `#/market${v === "robinhood" ? "" : `?tab=${v}`}`);
    show();
  });
  const head = pageHead("Market", null, { badge: "Mainnet" });
  const sub = h("p", {});
  head.append(sub);
  clear(view, head, h("div", { class: "mk-top" }, tabSeg), body);

  function show() {
    try { stopTab?.(); } catch {}
    clear(body);
    const subs = {
      robinhood: "Coins on Robinhood Chain (chain 4663): Pons curves, Uniswap pools and every launchpad GeckoTerminal tracks, with live prices in USD and ETH.",
      stocks: "Tokenized stocks and ETFs on Robinhood Chain, priced from their on-chain pools.",
      perps: "Every Hyperliquid perpetual, including the XYZ builder markets. Mark price, funding and open interest are live.",
      spot: "Hyperliquid spot pairs with their live mark and 24h activity.",
    };
    sub.textContent = subs[tab];
    stopTab = ({ robinhood: robinhoodTab, stocks: stocksTab, perps: perpsTab, spot: spotTab })[tab](body, go, query);
  }
  show();
  return () => { try { stopTab?.(); } catch {} };
}

/* ---------------- Robinhood Chain ---------------- */
function robinhoodTab(box, go, query) {
  const state = { q: query.q || "", launchpad: query.pad || "all", sort: "volume", dir: "desc", offset: 0, showAll: false };
  let reqId = 0;
  const search = h("input", { class: "input search", type: "search", placeholder: "Search symbol, name or address", value: state.q, "aria-label": "Search tokens" });
  const chips = h("div", { class: "chips" });
  const untradable = h("button", { class: "link fine", type: "button" });
  const foot = h("div", { class: "mk-foot" });
  const pager = h("div", { class: "pager" });
  const notice = h("div");
  const tbl = table({
    sort: { key: "volume", dir: "desc" },
    onSort: (key, dir) => { state.sort = key; state.dir = dir; state.offset = 0; load(); },
    onRow: (t) => go(`#/token/${t.address}`),
    emptyText: "No token matches.",
    cols: [
      { key: "rank", label: "#", render: (t, i) => h("span", { class: "rank" }, state.offset + i + 1), cls: "rank", hide: NARROW },
      { key: "token", label: "Token", align: "l", render: (t) => tokenCell(t, { flagUntradable: true }) },
      { key: "price", label: NARROW ? "Price · MC" : "Price", sort: true, render: (t) => (NARROW ? priceMcCell(t) : priceCell(t.priceEth, t.priceUsd)) },
      { key: "chart", label: NARROW ? "24h" : "24h chart", render: (t) => (NARROW ? h("div", { class: "mk-spark-c" }, sparkline(t.spark, { w: 56, h: 22 }), pctEl(t.change24h)) : sparkline(t.spark, { w: 96, h: 30 })), cls: "mk-spark" },
      { key: "change", label: "24h", sort: true, render: (t) => pctEl(t.change24h), hide: NARROW },
      { key: "volume", label: "24h volume", sort: true, render: (t) => usdCell(t.volume24hUsd, t.volume24hEth), hide: NARROW },
      { key: "liquidity", label: "Liquidity", sort: true, render: (t) => usdCell(t.liquidityUsd, null), hide: NARROW },
      { key: "mcap", label: "Mkt cap", sort: true, render: (t) => mcapCell(t), hide: NARROW },
      { key: "txns", label: "Trades 24h", sort: true, render: (t) => (t.txns24h != null ? compact(t.txns24h, 1) : "–"), hide: NARROW },
      { key: "newest", label: "Age", sort: true, render: (t) => h("span", { class: "muted" }, ageText(t.createdAt)), hide: NARROW },
    ],
  });
  // Desk 2.0: the four busiest coins as cards above the board
  const topBox = h("div", { class: "mk2-top" });
  const paintTop = (rows) => clear(topBox, rows.slice(0, 4).map((t, i) => h("a", { class: "mk2-card", href: `#/token/${t.address}` },
    h("div", { class: "mk2-c-h" }, tokenIcon({ ...t, chain: "robinhood" }), h("span", {}, h("b", {}, t.symbol), h("small", {}, i === 0 ? "Busiest today" : t.launchpad ? padName(t.launchpad) : "Robinhood Chain")), h("span", { class: "mk2-rank" }, `#${i + 1}`)),
    h("div", { class: "mk2-c-p" }, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"),
    h("div", { class: "mk2-c-f" }, pctEl(t.change24h), h("span", {}, `vol ${t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : "–"}`), h("span", {}, `liq ${t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : "–"}`)),
    h("i", { class: "mk2-bar", style: { "--w": `${Math.min(100, Math.abs(t.change24h || 0))}%` }, "data-dir": (t.change24h || 0) >= 0 ? "up" : "down" }))));
  clear(box, topBox, h("div", { class: "mk-filters" }, search, chips), h("div", { class: "mk-sub" }, untradable), notice, h("div", { class: "panel mk-panel" }, tbl), pager, foot);

  function renderChips(counts) {
    const list = [["all", "All"], ...LAUNCHPADS.filter(([k]) => counts?.[k] || k === state.launchpad)];
    clear(chips, list.map(([k, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(state.launchpad === k), onclick: () => { state.launchpad = k; state.offset = 0; load(); } },
      k === "all" ? null : padLogo(k, 14), label, counts?.[k] != null ? h("span", { class: "ct" }, compact(counts[k], 1).replace(/\.0(?=[KMB]$)/, "")) : null)));
  }
  async function load() {
    const id = ++reqId;
    tbl.setLoading(10);
    const qs = new URLSearchParams({ q: state.q, launchpad: state.launchpad, sort: state.sort, dir: state.dir, offset: String(state.offset), limit: String(PAGE), tradable: state.showAll ? "0" : "1" });
    try {
      // a name or ticker also asks the full-chain search, so a coin outside the board still shows up (real coin first)
      const named = state.q && !/0x[0-9a-fA-F]{40}/.test(state.q) && state.offset === 0 && state.launchpad === "all";
      const [d, s] = await Promise.all([api.get(`market/robinhood?${qs}`), named ? api.get(`search/coins?${new URLSearchParams({ q: state.q, limit: "20" })}`).catch(() => null) : null]);
      if (id !== reqId) return;
      renderChips(d.counts);
      let rows = d.tokens || [];
      if (s?.coins?.length) {
        const by = new Map(rows.map((t) => [String(t.address).toLowerCase(), t]));
        const first = s.coins.filter((c) => c.kind !== "major").map((c) => by.get(c.address) || { address: c.address, symbol: c.symbol, name: c.name, image: c.image, priceUsd: c.priceUsd, liquidityUsd: c.liquidityUsd, volume24hUsd: c.volume24hUsd, change24h: c.change24h, launchpad: c.launchpad, stock: c.kind === "stock" });
        const seen = new Set(first.map((t) => String(t.address).toLowerCase()));
        rows = [...first, ...rows.filter((t) => !seen.has(String(t.address).toLowerCase()))];
        d.total = Math.max(d.total || 0, rows.length);
      }
      tbl.setRows(rows);
      if (!state.q && state.offset === 0 && state.launchpad === "all") { const busy = [...rows].filter((t) => t.priceUsd != null).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)); if (busy.length) paintTop(busy); }
      topBox.hidden = !!state.q;
      const hiddenTotal = d.hiddenTotal;
      untradable.textContent = state.showAll ? "Hide coins Troya cannot route" : `Show coins Troya cannot route yet${hiddenTotal ? ` (${compact(hiddenTotal, 0)})` : ""}`;
      untradable.onclick = () => { state.showAll = !state.showAll; load(); };
      clear(notice, d.notice ? h("div", { class: "alert warn", style: { marginBottom: "10px" } }, d.notice) : d.stale ? h("div", { class: "alert warn", style: { marginBottom: "10px" } }, "The market source answered slowly; showing the last good copy.") : null);
      const from = d.total ? state.offset + 1 : 0, to = Math.min(d.total, state.offset + PAGE);
      clear(pager,
        h("button", { class: "btn sm", type: "button", disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - PAGE); load(); scrollTo(0, 0); } }, "Previous"),
        h("span", {}, `${from.toLocaleString()}–${to.toLocaleString()} of ${Number(d.total).toLocaleString()}`),
        h("button", { class: "btn sm", type: "button", disabled: to >= d.total, onclick: () => { state.offset += PAGE; load(); scrollTo(0, 0); } }, "Next"));
      clear(foot,
        h("p", {}, `${Number(d.counts?.all ?? d.total).toLocaleString()} coins on the board`, d.volume24hUsd ? ` · 24h volume across tracked pools ${usd(d.volume24hUsd, { compact: true })}` : "", ` · ${updatedText(d.updatedAt)}.`),
        h("p", {}, "Pools and prices from GeckoTerminal, Pons curve state read on chain. Pools with almost no liquidity are left out, and volume that a pool's liquidity could not carry (wash trading) is not counted. Many coins copy popular symbols: check the address on robinhoodchain.blockscout.com before you buy."));
    } catch (e) {
      if (id !== reqId) return;
      tbl.setRows([]);
      clear(notice, h("div", { class: "alert error", style: { marginBottom: "10px" } }, `Could not load the Robinhood Chain market: ${e.message}`));
    }
  }
  search.addEventListener("input", debounce(() => { state.q = search.value.trim(); state.offset = 0; load(); }, 300));
  load();
  const t = setInterval(() => { if (!document.hidden && state.offset === 0) load(); }, 45000);
  return () => clearInterval(t);
}

/* ---------------- Stocks ---------------- */
function stocksTab(box, go) {
  let data = [], q = "", sort = { key: "volume24hUsd", dir: "desc" };
  const search = h("input", { class: "input search", type: "search", placeholder: "Search stock (NVDA, TSLA, SPY…)", "aria-label": "Search stocks" });
  const note = h("div");
  const foot = h("div", { class: "mk-foot" });
  const tbl = table({
    sort, onSort: (k, d) => { sort = { key: k, dir: d }; render(); },
    onRow: (t) => go(`#/token/${t.address}`),
    emptyText: "No stock matches.",
    cols: [
      { key: "symbol", label: "Stock", align: "l", render: (t) => h("div", { class: "tok" }, tokenIcon(t), h("div", { style: { minWidth: 0 } }, h("b", {}, t.symbol, !t.tradable ? h("span", { class: "pad-tag warn", title: "No Uniswap pool Troya can route through yet." }, "not routed") : null), h("small", {}, t.name))) },
      { key: "priceUsd", label: "Price", sort: true, render: (t) => priceCell(t.priceEth, t.priceUsd) },
      { key: "change24h", label: "24h", sort: true, render: (t) => pctEl(t.change24h) },
      { key: "volume24hUsd", label: "24h volume", sort: true, render: (t) => usd(t.volume24hUsd, { compact: true }) },
      { key: "liquidityUsd", label: "Liquidity", sort: true, render: (t) => usd(t.liquidityUsd, { compact: true }), hide: NARROW },
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search), note, h("div", { class: "panel mk-panel" }, tbl), foot);
  function render() {
    const s = sort.dir === "asc" ? 1 : -1, k = sort.key;
    tbl.setRows(data.filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * s));
  }
  async function load(first) {
    if (first) tbl.setLoading(12);
    try {
      const d = await api.get("market/stocks");
      data = d.stocks || [];
      render();
      const priced = data.filter((t) => t.priceUsd != null).length;
      clear(note, d.stale ? h("div", { class: "alert warn", style: { marginBottom: "10px" } }, "The price source answered slowly; showing the last good copy.") : null);
      clear(foot, h("p", {}, `${data.length} tokenized stocks and ETFs on Robinhood Chain, ${priced} with a live pool price · ${updatedText(d.updatedAt)}. Prices come from on-chain pools and can drift from the listed share price, especially outside US market hours.`));
    } catch (e) { tbl.setRows([]); clear(note, h("div", { class: "alert error" }, `Could not load the stock list: ${e.message}`)); }
  }
  search.addEventListener("input", debounce(() => { q = search.value.trim(); render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 120000);
  return () => clearInterval(t);
}

/* ---------------- Perps ---------------- */
function perpsTab(box, go) {
  const state = { q: "", dex: "all", sort: "volumeUsd", dir: "desc" };
  let data = [];
  const search = h("input", { class: "input search", type: "search", placeholder: "Search market (BTC, ETH, xyz:NVDA…)", "aria-label": "Search perps" });
  const dexSeg = seg([{ value: "all", label: "All" }, { value: "main", label: "Crypto" }, { value: "xyz", label: "XYZ (stocks & more)" }], "all", (v) => { state.dex = v; render(); });
  const foot = h("div", { class: "mk-foot" });
  const tbl = table({
    sort: { key: "volumeUsd", dir: "desc" },
    onSort: (k, d) => { state.sort = k; state.dir = d; render(); },
    onRow: (m) => go(`#/perps/${encodeURIComponent(m.coin)}`),
    emptyText: "No market matches.",
    cols: [
      { key: "coin", label: "Market", align: "l", render: (m) => h("div", { class: "tok" }, coinIcon(m.coin), h("div", {}, h("b", {}, m.coin), h("small", {}, `up to ${m.maxLeverage}x${m.onlyIsolated ? " · isolated" : ""}`))) },
      { key: "mark", label: "Mark", sort: true, render: (m) => perpPrice(m.mark) },
      { key: "change24h", label: "24h", sort: true, render: (m) => pctEl(m.change24h) },
      { key: "fundingHrPct", label: "Funding / hr", sort: true, render: (m) => h("span", { class: m.fundingHrPct > 0 ? "" : "down" }, fmtFunding(m.fundingHrPct)) },
      { key: "fundingApr", label: "Annualized", sort: true, render: (m) => fmtApr(m.fundingApr), hide: NARROW },
      { key: "oiUsd", label: "Open interest", sort: true, render: (m) => usd(m.oiUsd, { compact: true }), hide: NARROW },
      { key: "volumeUsd", label: "24h volume", sort: true, render: (m) => usd(m.volumeUsd, { compact: true }) },
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search, dexSeg), h("div", { class: "panel mk-panel" }, tbl), foot);
  function render() {
    const q = state.q.toLowerCase();
    let rows = data.filter((m) => (!q || m.coin.toLowerCase().includes(q)) && (state.dex === "all" || (state.dex === "main" ? !m.dex : m.dex === state.dex)));
    const k = state.sort, s = state.dir === "asc" ? 1 : -1;
    rows = rows.sort((a, b) => ((a[k] ?? -Infinity) > (b[k] ?? -Infinity) ? s : (a[k] ?? -Infinity) < (b[k] ?? -Infinity) ? -s : 0));
    tbl.setRows(rows);
  }
  async function load(first) {
    if (first) tbl.setLoading(12);
    try {
      const d = await cached("market/hl", 8000);
      data = d.markets;
      render();
      clear(foot, h("p", {}, `${data.length} live perps from the Hyperliquid API · ${updatedText(d.updatedAt)}. Funding is the hourly rate; annualized assumes it stays the same, which it rarely does.`));
    } catch (e) { tbl.setRows([]); clear(foot, h("div", { class: "alert error" }, `Hyperliquid is unavailable: ${e.message}`)); }
  }
  search.addEventListener("input", debounce(() => { state.q = search.value.trim(); render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
  return () => clearInterval(t);
}

/* ---------------- Spot ---------------- */
function spotTab(box) {
  let data = [], q = "", sort = { key: "volumeUsd", dir: "desc" };
  const search = h("input", { class: "input search", type: "search", placeholder: "Search pair (HYPE, PURR…)", "aria-label": "Search spot pairs" });
  const foot = h("div", { class: "mk-foot" });
  const tbl = table({
    sort, onSort: (k, d) => { sort = { key: k, dir: d }; render(); }, emptyText: "No pair matches.",
    cols: [
      { key: "label", label: "Pair", align: "l", render: (p) => h("div", { class: "tok" }, coinIcon(`${p.base}_spot`), h("div", {}, h("b", {}, p.label), h("small", {}, p.canonical ? "canonical" : p.pair))) },
      { key: "mark", label: "Price", sort: true, render: (p) => perpPrice(p.mark) },
      { key: "change24h", label: "24h", sort: true, render: (p) => pctEl(p.change24h) },
      { key: "volumeUsd", label: "24h volume", sort: true, render: (p) => usd(p.volumeUsd, { compact: true }) },
      { key: "mcapUsd", label: "Mkt cap", sort: true, render: (p) => usd(p.mcapUsd, { compact: true }), hide: NARROW },
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search), h("div", { class: "panel mk-panel" }, tbl), foot);
  function render() {
    const s = sort.dir === "asc" ? 1 : -1, k = sort.key;
    tbl.setRows(data.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase())).sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * s).slice(0, 200));
  }
  async function load(first) {
    if (first) tbl.setLoading(12);
    try { const d = await api.get("market/hl/spot"); data = d.pairs.filter((p) => (p.volumeUsd || 0) > 0 || p.canonical); render(); clear(foot, h("p", {}, `${data.length} active spot pairs on Hyperliquid · ${updatedText(d.updatedAt)}. Showing up to 200.`)); }
    catch (e) { tbl.setRows([]); clear(foot, h("div", { class: "alert error" }, `Hyperliquid spot is unavailable: ${e.message}`)); }
  }
  search.addEventListener("input", debounce(() => { q = search.value.trim(); render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
  return () => clearInterval(t);
}
