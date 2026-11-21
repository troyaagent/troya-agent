// Market (#/market): Robinhood Chain board (default), tokenized stocks, Hyperliquid perps and spot.
import { h, clear, useCss, pageHead, seg, table, sparkline, pctEl, usd, tiny, compact, every, debounce, emptyState, tokenIcon, coinIcon, padLogo, chainLogo, infoTip } from "../ui.js";
import { api, cached } from "../api.js";
import { LAUNCHPADS, padName, tokenCell, priceCell, ethAmount, usdCell, mcapCell, ageText, updatedText, fmtFunding, fmtApr, perpPrice, perpTicker, perpName, perpSub, perpCategory, PERP_CATS, BUY_ETH, buyHref } from "../marketlib.js";
// phones: price on top, market cap under it (instead of the ETH price), so the board stays three columns wide
// token age (community request, 20 Nov 2026): when the coin was born, from its creation block (/api/token-age). The board's
// createdAt is the main pool's date, so a coin that graduated to Uniswap looked as old as its graduation; it stays the
// fallback until the birth is read.
const BORN = new Map();
const bornOf = (t) => BORN.get(String(t.address || "").toLowerCase()) || t.bornAt || t.createdAt || null;   // bornAt: the server's copy of the same birth
const priceMcCell = (t) => h("div", { class: "pcell" }, h("span", {}, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"), h("span", { class: "sub" }, t.mcapUsd > 0 ? `MC ${usd(t.mcapUsd, { compact: true })}` : "MC –", bornOf(t) ? h("span", { title: "Age: how long ago the coin was created" }, ` · ${ageText(bornOf(t))}`) : null), staleNote(t));
// Liquidity is the money side of a coin's pools (ETH, USDG or stock tokens): what a seller can take out. The pool total
// also counts the coin at the pool's own price (MOW: $18.6M on 0.81 ETH), so it only shows in the tooltip.
const liqTip = (t) => (t.liquidityUsd != null ? (t.realLiquidityUsd != null ? `${usd(t.liquidityUsd, { compact: true })} incl. the coin side` : `Pool total ${usd(t.liquidityUsd, { compact: true })} incl. the coin side; the ETH or USDG side is not read yet`) : "");
const liqCell = (t) => h("div", { class: "pcell", title: liqTip(t) }, h("span", {}, t.realLiquidityUsd != null ? usd(t.realLiquidityUsd, { compact: true }) : "–"));
// a price the index has not refreshed for 15 minutes is dimmed and says how old it is (server clock: board.now)
let boardNow = 0;
const STALE_MS = 15 * 60_000;
const ageOf = (t) => (t.priceAt ? (boardNow || Date.now()) - t.priceAt : 0);
const ageWords = (ms) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.floor(ms / 3600_000)} h`);
const staleNote = (t) => (ageOf(t) > STALE_MS ? h("span", { class: "sub warnc" }, `price ${ageWords(ageOf(t))} old`) : null);

const PAGE = 50;
const NARROW = matchMedia("(max-width: 720px)").matches;
// the long lists (Stocks, Perps, Spot) build 60 rows and a "Show more": 300 perps used to build 300 rows at once
const STEP = 60;
function moreBar(onMore) {
  const el = h("div", { class: "mk-more" });
  el.paint = (shown, total) => clear(el,
    total > shown ? h("button", { class: "btn sm", type: "button", onclick: onMore }, `Show ${Math.min(STEP, total - shown)} more`) : null,
    total > STEP ? h("span", { class: "fine muted" }, `${shown.toLocaleString()} of ${total.toLocaleString()}`) : null);
  return el;
}
// a narrow Buy on a coin's row: Swap opens with the coin and BUY_ETH filled in; the Gate and the user's own signature
// still come first there. The row's own click (the token page) stays out of it.
const buyCol = { key: "buy", label: "", cls: "mk-buy-c", render: (t) => (t.tradable && /^0x[0-9a-fA-F]{40}$/.test(String(t.address || ""))
  ? h("a", { class: "mk-buy", href: buyHref(t.address), title: `Open Swap with ${BUY_ETH} ETH for ${t.symbol || "this coin"}; the Gate checks it before you sign`, "aria-label": `Buy ${t.symbol || "this coin"} on Troya Swap`, onclick: (e) => e.stopPropagation() }, "Buy")
  : null) };

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
  head.classList.add("mk-head");
  const sub = h("p", { class: "mk-desc" });   // phones hide it: the header took 40% of the first screen there
  head.append(sub);
  clear(view, head, h("div", { class: "mk-top" }, tabSeg), body);

  function show() {
    try { stopTab?.(); } catch {}
    clear(body);
    const subs = {
      robinhood: "Coins on Robinhood Chain (chain 4663): Pons curves, Uniswap pools and every launchpad GeckoTerminal tracks, with live prices in USD and ETH.",
      stocks: "Tokenized stocks and ETFs on Robinhood Chain, priced from their on-chain pools.",
      perps: "Every Hyperliquid perpetual, including the stocks, indices and commodities listed by trade.xyz. Mark price, funding and open interest are live.",
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
  // each category has its default order: picks keep Troya's own, New lists the youngest first, the rest the busiest
  const catSort = (k, sort) => (k === "picks" ? "picks" : k === "new" ? "newest" : sort === "newest" || sort === "picks" || !sort ? "volume" : sort);
  const cat0 = ["picks", "trending", "new", "bonding", "all"].includes(query.cat) ? query.cat : "picks";
  const state = { q: query.q || "", launchpad: query.pad || "all", sort: catSort(cat0), dir: "desc", offset: 0, showAll: false, cat: cat0 };
  const CATS = [["picks", "Troya picks", "Picked by Troya from live data: at least $10K of real liquidity (the ETH, USDG or stock-token side of its pools), 40+ trades and $2K+ volume today, volume under 25 times that liquidity, the 10 largest wallets under 80% and not down 40% today; real buyers, spread-out holders and listed socials rank it higher. A read of the data, not advice. Run the Gate before you buy."], ["trending", "Trending", "Real trading today: $1K+ volume and 20+ trades in 24 hours"], ["new", "New", "Born in the last 72 hours, off a bonding curve: just graduated, or launched straight into a pool"], ["bonding", "Bonding", "Still on a Pons bonding curve, before graduation"], ["all", "All", "Every coin Troya can route"]];
  const catBar = h("div", { class: "mk2-cats", role: "tablist" });
  // phones show two lines of the note; a tap opens the rest
  const catNote = h("p", { class: "fine muted mk2-catnote", onclick: () => catNote.classList.toggle("open") });
  // the row is drawn at once with "–" for the counts, so nothing below it moves when the numbers arrive
  let lastCatCounts = null;
  const paintCats = (counts = lastCatCounts) => {
    lastCatCounts = counts || null;
    clear(catBar, CATS.map(([k, label, tip]) => h("button", { type: "button", role: "tab", "aria-selected": String(state.cat === k), title: tip, onclick: () => {
      if (state.cat === k) return;
      const was = state.sort;
      state.cat = k; state.offset = 0; state.sort = catSort(k, was);
      if (state.sort !== was) state.dir = "desc";
      // the arrow follows the order the new category uses (Trending lost it after Troya picks)
      tbl.setSort(state.sort === "picks" ? null : state.sort, state.dir);
      history.replaceState(null, "", `#/market${k === "picks" ? "" : `?cat=${k}`}`);
      catNote.classList.remove("open");
      paintCats();
      load();
    } }, label, h("span", { class: "ct" }, counts?.[k] != null ? String(counts[k]) : "–"))));
    catNote.textContent = (CATS.find(([k]) => k === state.cat) || [])[2] || "";
  };
  paintCats();
  let reqId = 0;
  const search = h("input", { class: "input search", type: "search", placeholder: "Search symbol, name or address", value: state.q, "aria-label": "Search tokens" });
  const chips = h("div", { class: "chips" });
  const untradable = h("button", { class: "link fine", type: "button" });
  const foot = h("div", { class: "mk-foot" });
  const pager = h("div", { class: "pager" });
  const notice = h("div");
  const tbl = table({
    // Troya picks keep their own order, so no column claims to sort them
    sort: state.sort === "picks" ? null : { key: state.sort, dir: state.dir },
    onSort: (key, dir) => { state.sort = key; state.dir = dir; state.offset = 0; load(); },
    onRow: (t) => go(`#/token/${t.address}`),
    href: (t) => `#/token/${t.address}`,
    emptyText: "No token matches.",
    cols: [
      { key: "rank", label: "#", render: (t, i) => h("span", { class: "rank" }, state.offset + i + 1), cls: "rank", hide: NARROW },
      { key: "token", label: "Token", align: "l", render: (t) => (state.cat === "picks" && t.pick?.why?.length ? h("div", { class: "mk2-pick" }, tokenCell(t, { flagUntradable: true }), h("p", { class: "mk2-why" }, t.pick.why.join(" · "))) : tokenCell(t, { flagUntradable: true })) },
      { key: "price", label: NARROW ? "Price · MC" : "Price", sort: true, render: (t) => { if (NARROW) return priceMcCell(t); const c = priceCell(t.priceEth, t.priceUsd), n = staleNote(t); if (n) c.append(n); return c; } },
      { key: "chart", label: NARROW ? "24h" : "24h chart", render: (t) => (NARROW ? h("div", { class: "mk-spark-c" }, sparkline(t.spark, { w: 56, h: 22 }), pctEl(t.change24h)) : sparkline(t.spark, { w: 96, h: 30 })), cls: "mk-spark" },
      { key: "change", label: "24h", sort: true, render: (t) => pctEl(t.change24h), hide: NARROW },
      { key: "volume", label: "24h volume", sort: true, render: (t) => usdCell(t.volume24hUsd, t.volume24hEth), hide: NARROW },
      { key: "liquidity", label: "Liquidity", sort: true, render: (t) => liqCell(t), hide: NARROW },
      { key: "mcap", label: "Mkt cap", sort: true, render: (t) => mcapCell(t), hide: NARROW },
      { key: "holders", label: "Holders", sort: true, render: (t) => (t.holders != null ? h("div", { class: "pcell" }, h("span", {}, compact(t.holders, 1).replace(/\.0(?=[KMB]$)/, "")), t.top10Pct != null ? h("span", { class: `sub ${t.top10Pct > 60 ? "warnc" : ""}`, title: "Share held by the 10 largest wallets" }, `top 10 ${t.top10Pct.toFixed(0)}%`) : null) : h("span", { class: "muted" }, "–")), hide: NARROW },
      { key: "txns", label: "Trades 24h", sort: true, render: (t) => (t.txns24h != null ? compact(t.txns24h, 1) : "–"), hide: NARROW },
      { key: "newest", label: "Age", sort: true, render: (t) => h("span", { class: "muted", title: "How long ago the coin was created" }, ageText(bornOf(t))), hide: NARROW },
      buyCol,
    ],
  });
  // Desk 2.0: the four busiest coins as cards above the board. Four placeholders hold their place until the data
  // lands, so the categories and the board do not jump down when the cards arrive.
  const topBox = h("div", { class: "mk2-top" });
  let topPainted = false;
  if (!state.q && state.offset === 0 && state.launchpad === "all") clear(topBox, [0, 1, 2, 3].map(() => h("div", { class: "mk2-card mk2-card-sk", "aria-hidden": "true" }, h("div", { class: "sk", style: { height: "40px", width: "60%" } }), h("div", { class: "sk", style: { height: "22px", width: "70%" } }), h("div", { class: "sk", style: { height: "14px", width: "85%" } }))));
  const paintTop = (rows) => (topPainted = true) && clear(topBox, rows.slice(0, 4).map((t, i) => h("a", { class: "mk2-card", href: `#/token/${t.address}` },
    h("div", { class: "mk2-c-h" }, tokenIcon({ ...t, chain: "robinhood" }), h("span", {}, h("b", {}, t.symbol), h("small", {}, i === 0 ? "Busiest today" : t.launchpad ? padName(t.launchpad) : "Robinhood Chain")), h("span", { class: "mk2-rank" }, `#${i + 1}`)),
    h("div", { class: "mk2-c-p" }, t.priceUsd != null ? `$${tiny(t.priceUsd)}` : "–"),
    h("div", { class: "mk2-c-f" }, pctEl(t.change24h), h("span", {}, `vol ${t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : "–"}`), h("span", { title: liqTip(t) }, `liq ${t.realLiquidityUsd != null ? usd(t.realLiquidityUsd, { compact: true }) : "–"}`)),
    h("i", { class: "mk2-bar", style: { "--w": `${Math.min(100, Math.abs(t.change24h || 0))}%` }, "data-dir": (t.change24h || 0) >= 0 ? "up" : "down" }))));
  clear(box, topBox, catBar, catNote, h("div", { class: "mk-filters" }, search, chips), notice, h("div", { class: "panel mk-panel" }, tbl), pager, h("div", { class: "mk-sub" }, untradable), foot);

  // the launchpad counts are the whole board's (every category), which is why the strip says "On the board": Troya picks
  // can show 20 coins while All says 255
  function renderChips(counts) {
    const list = [["all", "All"], ...LAUNCHPADS.filter(([k]) => counts?.[k] || k === state.launchpad)];
    const n = (k) => (counts?.[k] != null ? compact(counts[k], 1).replace(/\.0(?=[KMB]$)/, "") : null);
    clear(chips, h("span", { class: "mk-chips-l" }, "On the board"), list.map(([k, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(state.launchpad === k), title: n(k) != null ? `${label}: ${Number(counts[k]).toLocaleString()} coins on the board, across every category` : null, onclick: () => { state.launchpad = k; state.offset = 0; load(); } },
      k === "all" ? null : padLogo(k, 14), label, h("span", { class: "ct" }, n(k) ?? "–"))));
  }
  renderChips();
  async function load() {
    const id = ++reqId;
    tbl.setLoading(10);
    const qs = new URLSearchParams({ q: state.q, launchpad: state.launchpad, sort: state.sort, dir: state.dir, offset: String(state.offset), limit: String(PAGE), tradable: state.showAll ? "0" : "1", cat: state.q ? "all" : state.cat });
    try {
      // a name or ticker also asks the full-chain search, so a coin outside the board still shows up (real coin first)
      const named = state.q && !/0x[0-9a-fA-F]{40}/.test(state.q) && state.offset === 0 && state.launchpad === "all";
      const [d, s] = await Promise.all([api.get(`market/robinhood?${qs}`), named ? api.get(`search/coins?${new URLSearchParams({ q: state.q, limit: "20" })}`).catch(() => null) : null]);
      if (id !== reqId) return;
      boardNow = d.now || 0;
      renderChips(d.counts);
      paintCats(d.catCounts);
      let rows = d.tokens || [];
      if (s?.coins?.length) {
        const by = new Map(rows.map((t) => [String(t.address).toLowerCase(), t]));
        const first = s.coins.filter((c) => c.kind !== "major").map((c) => by.get(c.address) || { address: c.address, symbol: c.symbol, name: c.name, image: c.image, priceUsd: c.priceUsd, liquidityUsd: c.liquidityUsd, realLiquidityUsd: c.realLiquidityUsd ?? null, volume24hUsd: c.volume24hUsd, change24h: c.change24h, launchpad: c.launchpad, stock: c.kind === "stock", tradable: c.tradable });
        const seen = new Set(first.map((t) => String(t.address).toLowerCase()));
        rows = [...first, ...rows.filter((t) => !seen.has(String(t.address).toLowerCase()))];
        d.total = Math.max(d.total || 0, rows.length);
      }
      const paintRows = () => {
        tbl.setRows(rows);
        // rows whose price is over 15 minutes old are dimmed (the price cell says how old); the table helper has no row class
        tbl.querySelectorAll("tbody > tr").forEach((tr, i) => {
          const t = rows[i], old = t && ageOf(t) > STALE_MS;
          tr.style.opacity = old ? ".55" : "";
          tr.title = old ? `This price is ${ageWords(ageOf(t))} old: no source has refreshed this coin since.` : "";
        });
      };
      paintRows();
      // the real births for this page: known ones come back at once, the rest are read in the background and asked again
      const askAges = async (tries) => {
        const need = rows.map((t) => String(t.address || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !BORN.has(a));
        if (!need.length) return;
        const r = await api.post("token-age", { addresses: need.slice(0, 60) }).catch(() => null);
        if (id !== reqId || !r?.ages) return;
        let got = 0;
        for (const [a, at] of Object.entries(r.ages)) if (at) { BORN.set(a, at); got++; }
        if (got) paintRows();
        if (tries > 0 && got < need.length) setTimeout(() => { if (id === reqId) askAges(tries - 1); }, 7000);
      };
      askAges(2);
      if (!state.q && state.offset === 0 && state.launchpad === "all") {
        const top = state.cat === "all" && state.sort === "volume" && state.dir === "desc" ? d : await api.get("market/robinhood?cat=all&sort=volume&dir=desc&limit=12&tradable=1").catch(() => null);
        if (id !== reqId) return;
        const busy = (top?.tokens || rows).filter((t) => t.priceUsd != null && !t.washVolume).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
        if (busy.length) paintTop(busy);
      }
      if (!topPainted) clear(topBox);   // no cards to show (a search or a launchpad from the link): drop the placeholders
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
      // how many coins carry a price read in the last 10 minutes (the old "updated just now" spoke for the board, not its rows)
      const freshLine = d.fresh10 != null && d.freshOf ? ` · ${Number(d.fresh10).toLocaleString()} of ${Number(d.freshOf).toLocaleString()} updated in the last 10 min.` : ` · ${updatedText(d.updatedAt)}.`;
      clear(foot,
        h("p", {}, state.q ? `${rows.length} result${rows.length === 1 ? "" : "s"} for "${state.q}"` : `${Number(d.counts?.all ?? d.total).toLocaleString()} coins on the board`, d.volume24hUsd ? ` · 24h volume across tracked pools ${usd(d.volume24hUsd, { compact: true })}` : "", freshLine),
        h("p", {}, "Prices from GeckoTerminal pools; a coin not refreshed for 5 minutes takes DexScreener's price, and Pons coins are priced on chain (the curve's reserves, or the Uniswap v4 pool after graduation). Market cap is price times supply; for Pons coins the supply is read on chain, after burns. Liquidity is the ETH, USDG or stock-token side of a coin's pools, the money a seller can take out; the pool total, which also counts the coin at its own price, is in the tooltip. Pools under $500 are left out, and a pool's volume above 300 times its liquidity, or above $50K a trade, is not counted. Many coins copy popular symbols: check the address on robinhoodchain.blockscout.com before you buy."));
    } catch (e) {
      if (id !== reqId) return;
      tbl.setRows([]);
      if (!topPainted) clear(topBox);
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
  let data = [], q = "", sort = { key: "volume24hUsd", dir: "desc" }, limit = STEP;
  const search = h("input", { class: "input search", type: "search", placeholder: "Search stock (NVDA, TSLA, SPY…)", "aria-label": "Search stocks" });
  const note = h("div");
  const foot = h("div", { class: "mk-foot" });
  const more = moreBar(() => { limit += STEP; render(); });
  const tbl = table({
    sort, onSort: (k, d) => { sort = { key: k, dir: d }; render(); },
    onRow: (t) => go(`#/token/${t.address}`),
    href: (t) => `#/token/${t.address}`,
    emptyText: "No stock matches.",
    cols: [
      { key: "symbol", label: "Stock", align: "l", render: (t) => h("div", { class: "tok" }, tokenIcon(t), h("div", { style: { minWidth: 0 } }, h("b", {}, t.symbol, !t.tradable ? h("span", { class: "pad-tag warn", title: "No Uniswap pool Troya can route through yet." }, "not routed") : null), h("small", {}, h("span", { class: "tok-nm" }, t.name)))) },
      { key: "priceUsd", label: "Price", sort: true, render: (t) => priceCell(t.priceEth, t.priceUsd) },
      { key: "change24h", label: "24h", sort: true, render: (t) => pctEl(t.change24h) },
      { key: "volume24hUsd", label: "24h volume", sort: true, render: (t) => usd(t.volume24hUsd, { compact: true }), hide: NARROW },
      { key: "liquidityUsd", label: "Liquidity", sort: true, render: (t) => usd(t.liquidityUsd, { compact: true }), hide: NARROW },
      { ...buyCol, hide: NARROW },   // a phone has no room for it next to the price and the 24h pill; the coin page has Buy
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search), note, h("div", { class: "panel mk-panel" }, tbl), more, foot);
  function render() {
    const s = sort.dir === "asc" ? 1 : -1, k = sort.key;
    const rows = data.filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * s);
    tbl.setRows(rows.slice(0, limit));
    more.paint(Math.min(limit, rows.length), rows.length);
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
  search.addEventListener("input", debounce(() => { q = search.value.trim(); limit = STEP; render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 120000);
  return () => clearInterval(t);
}

/* ---------------- Perps ---------------- */
// Perps read by what they are: "SK hynix" in bold, "SKHX · trade.xyz · up to 10x" under it (trade.xyz's "xyz:" prefix
// is an id, so no label shows it), on shelves: Crypto, Stocks, Indices, Commodities, FX. The shelf rides in the link.
function perpsTab(box, go, query) {
  const state = { q: "", cat: PERP_CATS.some(([k]) => k === query.cat) ? query.cat : "all", sort: "volumeUsd", dir: "desc", limit: STEP };
  let data = [];
  const search = h("input", { class: "input search", type: "search", placeholder: "Search market (BTC, NVIDIA, Gold…)", "aria-label": "Search perps" });
  const catSeg = seg(PERP_CATS.map(([value, label]) => ({ value, label })), state.cat, (v) => {
    state.cat = v; state.limit = STEP;
    history.replaceState(null, "", `#/market?tab=perps${v === "all" ? "" : `&cat=${v}`}`);
    render();
  }, "mk-pcat");
  const foot = h("div", { class: "mk-foot" });
  const more = moreBar(() => { state.limit += STEP; render(); });
  const link = (m) => `#/perps/${encodeURIComponent(m.coin)}`;
  const tbl = table({
    sort: { key: "volumeUsd", dir: "desc" },
    onSort: (k, d) => { state.sort = k; state.dir = d; render(); },
    onRow: (m) => go(link(m)),
    href: link,
    emptyText: "No market matches.",
    cols: [
      { key: "coin", label: "Market", align: "l", render: (m) => h("div", { class: "tok" }, coinIcon(m.coin), h("div", { style: { minWidth: 0 } }, h("b", {}, h("span", { class: "mk-nm" }, perpName(m))), h("small", {}, h("span", { class: "tok-nm" }, perpSub(m))))) },
      { key: "mark", label: "Mark", sort: true, render: (m) => perpPrice(m.mark) },
      { key: "change24h", label: "24h", sort: true, render: (m) => pctEl(m.change24h) },
      { key: "fundingHrPct", label: "Funding / hr", sort: true, render: (m) => h("span", { class: m.fundingHrPct > 0 ? "" : "down" }, fmtFunding(m.fundingHrPct)) },
      { key: "fundingApr", label: "Annualized", sort: true, render: (m) => h("span", { class: m.fundingApr < 0 ? "down" : "" }, fmtApr(m.fundingApr)), hide: NARROW },
      { key: "oiUsd", label: "Open interest", sort: true, render: (m) => usd(m.oiUsd, { compact: true }), hide: NARROW },
      { key: "volumeUsd", label: "24h volume", sort: true, render: (m) => usd(m.volumeUsd, { compact: true }) },
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search, catSeg), h("div", { class: "panel mk-panel" }, tbl), more, foot);
  // a search matches the name or the bare ticker ("hynix", "skhx", "xyz:skhx" all find SK hynix)
  const matches = (m, q) => !q || perpName(m).toLowerCase().includes(q) || perpTicker(m.coin).toLowerCase().includes(q.replace(/^[a-z0-9]+:/, ""));
  function render() {
    const q = state.q.toLowerCase();
    let rows = data.filter((m) => matches(m, q) && (state.cat === "all" || perpCategory(m) === state.cat));
    const k = state.sort, s = state.dir === "asc" ? 1 : -1;
    rows = rows.sort((a, b) => ((a[k] ?? -Infinity) > (b[k] ?? -Infinity) ? s : (a[k] ?? -Infinity) < (b[k] ?? -Infinity) ? -s : 0));
    tbl.setRows(rows.slice(0, state.limit));
    more.paint(Math.min(state.limit, rows.length), rows.length);
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
  search.addEventListener("input", debounce(() => { state.q = search.value.trim(); state.limit = STEP; render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
  return () => clearInterval(t);
}

/* ---------------- Spot ---------------- */
// Unit's bridged assets on Hyperliquid spot, by their own name (the pair id "@142" is an internal index, not a name)
const UNIT = { UBTC: "BTC", UETH: "ETH", USOL: "SOL", UFART: "Fartcoin", UPUMP: "PUMP", UENA: "ENA", UXPL: "XPL", UZEC: "ZEC" };
// a row opens the Spot desk on that pair; the label ("HYPE/USDT0") picks one pair, the base ("HYPE") can name four
function spotTab(box, go) {
  let data = [], q = "", sort = { key: "volumeUsd", dir: "desc" }, limit = STEP;
  const search = h("input", { class: "input search", type: "search", placeholder: "Search pair (HYPE, PURR…)", "aria-label": "Search spot pairs" });
  const foot = h("div", { class: "mk-foot" });
  const more = moreBar(() => { limit += STEP; render(); });
  // only a pair the desk can trade (an asset id and a live mark) links there; any other would open the desk's default pair
  const link = (p) => (p.asset != null && p.mark > 0 ? `#/spot?pair=${encodeURIComponent(p.label || p.base)}` : null);
  const tbl = table({
    sort, onSort: (k, d) => { sort = { key: k, dir: d }; render(); }, emptyText: "No pair matches.",
    onRow: (p) => { const to = link(p); if (to) go(to); },
    href: link,
    cols: [
      { key: "label", label: "Pair", align: "l", render: (p) => h("div", { class: "tok" }, coinIcon(`${p.base}_spot`), h("div", {}, h("b", {}, p.label), UNIT[p.base] ? h("small", {}, `Unit · bridged ${UNIT[p.base]}`) : p.base === "HYPE" ? h("small", {}, "Hyperliquid") : null)) },
      { key: "mark", label: "Price", sort: true, render: (p) => perpPrice(p.mark) },
      { key: "change24h", label: "24h", sort: true, render: (p) => pctEl(p.change24h) },
      { key: "volumeUsd", label: "24h volume", sort: true, render: (p) => usd(p.volumeUsd, { compact: true }) },
      { key: "mcapUsd", label: "Mkt cap", sort: true, render: (p) => usd(p.mcapUsd, { compact: true }), hide: NARROW },
    ],
  });
  clear(box, h("div", { class: "mk-filters" }, search), h("div", { class: "panel mk-panel" }, tbl), more, foot);
  function render() {
    const s = sort.dir === "asc" ? 1 : -1, k = sort.key;
    const rows = data.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase())).sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * s);
    tbl.setRows(rows.slice(0, limit));
    more.paint(Math.min(limit, rows.length), rows.length);
  }
  async function load(first) {
    if (first) tbl.setLoading(12);
    try { const d = await api.get("market/hl/spot"); data = d.pairs.filter((p) => (p.volumeUsd || 0) > 0 || p.canonical); render(); clear(foot, h("p", {}, `${data.length} active spot pairs on Hyperliquid · ${updatedText(d.updatedAt)}.`)); }
    catch (e) { tbl.setRows([]); clear(foot, h("div", { class: "alert error" }, `Hyperliquid spot is unavailable: ${e.message}`)); }
  }
  search.addEventListener("input", debounce(() => { q = search.value.trim(); limit = STEP; render(); }, 150));
  load(true);
  const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
  return () => clearInterval(t);
}
