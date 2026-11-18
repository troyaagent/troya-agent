// All launches (#/launch): new coins on Robinhood Chain across launchpads. #/launch/create (the web form) is handled by
// launch-create.js and #/launch/x by launch-x.js; the Create coin chooser is the Desk page #/create.
import { h, clear, useCss, pageHead, tabs, table, pctEl, compact, debounce, icon, padLogo, usd, tokenIcon, tiny } from "../ui.js";
import { api } from "../api.js";
import { LAUNCHPADS, tokenCell, priceCell, usdCell, mcapCell, ageText, updatedText } from "../marketlib.js";

const STEP = 50;
const NARROW = matchMedia("(max-width: 720px)").matches;
// each tab maps onto an index ordering
const TABS = {
  trending: { label: "Trending", sort: "volume", dir: "desc" },
  new: { label: "New", sort: "newest", dir: "desc" },
  top: { label: "Top", sort: "mcap", dir: "desc" },
  gainers: { label: "Gainers", sort: "change", dir: "desc" },
  traded: { label: "Most traded", sort: "txns", dir: "desc" },
};

export async function mount(view, ctx) {
  if (ctx.parts[0] === "create") {
    const m = await import("./launch-create.js");
    return m.mount(view, ctx);
  }
  if (ctx.parts[0] === "x") {
    const m = await import("./launch-x.js");
    return m.mount(view, ctx);
  }
  useCss("home");
  useCss("market");
  const { go } = ctx;
  const state = { tab: TABS[ctx.query.tab] ? ctx.query.tab : "trending", pad: "all", q: "", rows: [], total: 0 };
  let reqId = 0;

  const head = pageHead("All launches", "Every coin on Robinhood Chain, whichever launchpad minted it: Pons, Clanker, Bankr, Virtuals and more. Coins born through Troya are in Troya Launches.", {
    act: h("a", { class: "btn primary", href: "#/create" }, icon("plus"), "Create coin"),
  });
  const tabEl = tabs(Object.entries(TABS).map(([value, t]) => ({ value, label: t.label })), state.tab, (v) => { state.tab = v; reset(); });
  const search = h("input", { class: "input search", type: "search", placeholder: "Search symbol, name or address", "aria-label": "Search launches" });
  const chips = h("div", { class: "chips" });
  const more = h("div", { class: "lp-more" });
  const foot = h("div", { class: "mk-foot" });
  const notice = h("div");
  const tbl = table({
    onRow: (t) => go(`#/token/${t.address}`),
    emptyText: "No launch matches.",
    cols: [
      { key: "token", label: "Token", align: "l", render: (t) => tokenCell(t) },
      { key: "age", label: "Age", render: (t) => h("span", { class: "muted" }, ageText(t.createdAt)), hide: NARROW },
      // phones: the market cap sits under the price (as on Market), so no column hides off-screen
      { key: "price", label: NARROW ? "Price · MC" : "Price", render: (t) => (NARROW ? h("div", { class: "pcell" }, h("span", {}, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"), h("span", { class: "sub" }, t.mcapUsd > 0 ? `MC ${usd(t.mcapUsd, { compact: true })}` : "MC –")) : priceCell(t.priceEth, t.priceUsd)) },
      { key: "change", label: "24h", render: (t) => pctEl(t.change24h) },
      { key: "volume", label: "24h volume", render: (t) => usdCell(t.volume24hUsd, t.volume24hEth), hide: NARROW },
      { key: "liq", label: "Liquidity", render: (t) => usdCell(t.liquidityUsd, null), hide: NARROW },
      { key: "txns", label: "Trades 24h", render: (t) => (t.txns24h != null ? compact(t.txns24h, 1) : "–"), hide: NARROW },
      { key: "mcap", label: "Market cap", render: (t) => mcapCell(t), hide: NARROW },
    ],
  });

  // Desk 2.0: the first four of the current list as cards (newest, hottest or gainers, whichever tab is open)
  const topBox = h("div", { class: "mk2-top" });
  const paintTop = (rows) => clear(topBox, rows.slice(0, 4).map((t, i) => h("a", { class: "mk2-card", href: `#/token/${t.address}` },
    h("div", { class: "mk2-c-h" }, tokenIcon({ ...t, chain: "robinhood" }), h("span", {}, h("b", {}, t.symbol), h("small", {}, t.createdAt ? `${ageText(t.createdAt)} old` : "New")), h("span", { class: "mk2-rank" }, padLogo(t.launchpad, 16))),
    h("div", { class: "mk2-c-p" }, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"),
    h("div", { class: "mk2-c-f" }, pctEl(t.change24h), h("span", {}, `vol ${t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : "–"}`), h("span", {}, `liq ${t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : "–"}`)),
    h("i", { class: "mk2-bar", style: { "--w": `${Math.min(100, Math.abs(t.change24h || 0))}%` }, "data-dir": (t.change24h || 0) >= 0 ? "up" : "down" }))));
  clear(view, head, h("div", { class: "lp-tabs" }, tabEl), topBox, h("div", { class: "mk-filters" }, search, chips), notice, h("div", { class: "panel mk-panel" }, tbl), more, foot);

  function renderChips(counts) {
    const list = [["all", "All"], ...LAUNCHPADS.filter(([k]) => counts?.[k] || k === state.pad)];
    clear(chips, list.map(([k, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(state.pad === k), onclick: () => { state.pad = k; reset(); } }, k === "all" ? null : padLogo(k, 14), label)));
  }
  function reset() { state.rows = []; load(0); }
  async function load(offset) {
    const id = ++reqId;
    const t = TABS[state.tab];
    if (!offset) tbl.setLoading(10);
    const qs = new URLSearchParams({ q: state.q, launchpad: state.pad, sort: t.sort, dir: t.dir, offset: String(offset), limit: String(STEP), tradable: "1" });
    try {
      const d = await api.get(`market/robinhood?${qs}`);
      if (id !== reqId) return;
      renderChips(d.counts);
      // "Gainers" only makes sense for tokens with some real trading behind them
      const rows = state.tab === "gainers" ? d.tokens.filter((x) => (x.volume24hUsd || 0) >= 5000) : d.tokens;
      state.rows = offset ? state.rows.concat(rows) : rows;
      state.total = d.total;
      state.next = offset + STEP;
      tbl.setRows(state.rows);
      // the top cards never crown a copycat ticker or a pool with fabricated volume
      if (!offset) { if (!state.q) paintTop(state.rows.filter((x) => !x.washVolume)); topBox.hidden = !!state.q; }
      clear(notice, d.notice ? h("div", { class: "alert warn", style: { marginBottom: "10px" } }, d.notice) : null);
      clear(more, state.next < d.total ? h("button", { class: "btn", type: "button", onclick: (e) => { e.target.disabled = true; load(state.next); } }, "Load more") : null);
      clear(foot,
        h("p", {}, `${Number(d.counts?.all ?? d.total).toLocaleString()} coins Troya can route`, d.hiddenTotal ? `, ${Number(d.hiddenTotal).toLocaleString()} more have no route Troya can use yet` : "", ` · ${updatedText(d.updatedAt)}.`),
        h("p", {}, "Pools and prices from GeckoTerminal; ETH figures use the live ETH price. Pools with almost no liquidity are left out."),
        state.tab === "gainers" ? h("p", {}, "Gainers leave out coins with under $5K of 24h volume, so dust trades do not top the list.") : null);
    } catch (e) {
      if (id !== reqId) return;
      if (!offset) tbl.setRows([]);
      clear(notice, h("div", { class: "alert error", style: { marginBottom: "10px" } }, `Could not load launches: ${e.message}`));
    }
  }
  search.addEventListener("input", debounce(() => { state.q = search.value.trim(); reset(); }, 300));
  load(0);
  const timer = setInterval(() => { if (!document.hidden && state.rows.length <= STEP) load(0); }, 45000);
  return () => clearInterval(timer);
}
