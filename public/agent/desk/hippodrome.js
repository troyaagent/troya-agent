// Hippodrome (#/hippodrome), V6: every coin born through Troya, in three lanes like a trench board.
//   New            launched through Troya (X, Telegram or troya.codes), still early on its Pons curve
//   Almost bonded  a curve at least half full
//   Migrated       graduated to its own Uniswap v4 pool ($TROYA leads it)
// Numbers come from /api/launch/board (Pons on chain, DexScreener, GeckoTerminal, Blockscout), refreshed every 15 s.
import { h, clear, useCss, pageHead, short, ago, tokenIcon, setBorn, compact, usd, every, icon } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const LANES = [
  { key: "new", title: "New", tone: "new", hint: "Born through Troya, early on the curve", empty: "No coins yet. Launch the first one." },
  { key: "almost", title: "Almost bonded", tone: "almost", hint: "Curve at least half full", empty: "Nothing close to bonding yet." },
  { key: "migrated", title: "Migrated", tone: "migrated", hint: "Graduated to its own Uniswap v4 pool", empty: "No coin has graduated yet." },
];
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 3h3l-6.6 7.5L21.6 21h-6l-4.7-6.1L5.4 21h-3l7.1-8.1L2.2 3h6.1l4.2 5.6L17.5 3zm-1 16.2h1.7L7.6 4.7H5.8l10.7 14.5z"/></svg>';
const TG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.5-1.5zm-3.3 3.2-8.6 7.8-.3 3.4-1.4-4.5 10.3-6.7z"/></svg>';
const WEB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
const svg = (s, cls) => { const e = h("span", { class: cls, "aria-hidden": "true" }); e.innerHTML = s; return e; };
const SOURCE = { x: ["X", X_ICON], tg: ["Telegram", TG_ICON], web: ["Web", WEB_ICON] };
// besides Troya (Buy, through the Gate), each coin opens on the venues people already trade on
const VENUES = [
  ["Fomo", "fomo.png", (c) => `https://fomo.family/tokens/robinhood/${c.token}`],
  ["Pons", "pons.svg", (c) => c.ponsUrl || `https://ponsfamily.com/launchpad/${c.token.toLowerCase()}`],
  ["DexScreener", "dexscreener.png", (c) => `https://dexscreener.com/robinhood/${c.token}`],
  ["GMGN", null, (c) => `https://gmgn.ai/robinhood/token/${c.token.toLowerCase()}`],
];

export async function mount(view, ctx) {
  useCss("perps");
  let alive = true;
  const st = { d: null, err: null, lane: ctx?.query?.lane && LANES.some((l) => l.key === ctx.query.lane) ? ctx.query.lane : "new", menu: false };
  const kpis = h("div", { class: "hp-kpis" });
  const lanes = h("div", { class: "hp-lanes" });
  const tabs = h("div", { class: "hp-tabs", role: "tablist" });
  const createBtn = h("button", { class: "btn primary hp-create", type: "button", "aria-haspopup": "true", "aria-expanded": "false", onclick: (e) => { e.stopPropagation(); st.menu = !st.menu; paintMenu(); } }, icon("plus"), "Create coin");
  const menu = h("div", { class: "hp-menu", hidden: true });
  clear(view, h("div", { class: "dk hp" },
    h("div", { class: "hp-head" },
      pageHead("Hippodrome", "Every coin born through Troya, from its first block on the Pons curve to its own Uniswap pool. Launched from X, Telegram or troya.codes."),
      h("div", { class: "hp-create-wrap" }, createBtn, menu)),
    kpis, tabs, lanes));
  const closeMenu = () => { if (st.menu) { st.menu = false; paintMenu(); } };
  document.addEventListener("click", closeMenu);

  function paintMenu() {
    createBtn.setAttribute("aria-expanded", String(st.menu));
    menu.hidden = !st.menu;
    if (!st.menu) return;
    const opt = (href, ic, title, text, extra = {}) => h(extra.disabled ? "div" : "a", { class: `hp-opt${extra.disabled ? " off" : ""}`, href: extra.disabled ? null : href, onclick: () => closeMenu() },
      svg(ic, "hp-opt-ic"), h("span", {}, h("b", {}, title, extra.badge ? h("small", { class: "hp-soon" }, extra.badge) : null), h("small", {}, text)));
    clear(menu,
      opt("#/launch/create", WEB_ICON, "On troya.codes", "Sign with your own wallet. Open to everyone."),
      opt("#/launch/x", X_ICON, "From X", "Post to @Troyaagent. Holders of 1M $TROYA."),
      opt(null, TG_ICON, "In Telegram", "From the Troya bot. Open to everyone.", { disabled: true, badge: "Soon" }));
  }

  async function refresh() {
    try { st.d = await api.get("/api/launch/board"); st.err = null; setBorn([...st.d.new, ...st.d.almost].map((x) => x.token), st.d.migrated.map((x) => x.token)); }
    catch (e) { st.err = e.message; }
    if (alive) paint();
  }

  const stat = (k, v) => h("span", { class: "hp-st" }, h("i", {}, k), h("b", {}, v));
  function card(c, lane) {
    const src = SOURCE[c.source];
    const fresh = c.at && Date.now() - c.at < 3 * 60_000;
    const pct = Math.max(0, Math.min(100, Number(c.progressPct) || 0));
    const chips = [];
    if (c.creatorTaxBps) chips.push(h("span", { class: "hp-chip" }, `Tax ${c.creatorTaxBps / 100}%`));
    if (c.keepsAll === true) chips.push(h("span", { class: "hp-chip gold", title: "The creator holds 1M $TROYA and keeps the whole creator fee" }, "Holder"));
    if (c.initialBuyEth) chips.push(h("span", { class: "hp-chip", title: "The creator's Agent Wallet bought right after launch" }, `Dev buy ${c.initialBuyEth} ETH`));
    const go = () => { location.hash = `#/token/${c.token.toLowerCase()}`; };
    return h("article", { class: `hp-card${fresh ? " fresh" : ""}`, tabindex: "0", role: "link", "aria-label": `${c.symbol} ${c.name}`, onclick: go, onkeydown: (e) => { if (e.key === "Enter") go(); } },
      h("div", { class: "hp-ava" }, tokenIcon({ address: c.token, symbol: c.symbol, image: c.image }, "xl")),
      h("div", { class: "hp-body" },
        h("div", { class: "hp-top" }, h("b", { class: "hp-sym" }, c.symbol || short(c.token)), h("span", { class: "hp-name" }, c.name || ""),
          c.source === "origin" ? h("span", { class: "hp-src origin" }, "Genesis") : src ? h("span", { class: "hp-src", title: `Launched from ${src[0]}` }, svg(src[1], "hp-src-ic"), c.source === "x" ? null : src[0]) : null),
        h("div", { class: "hp-meta" }, c.at ? h("span", {}, ago(c.at)) : null,
          c.creatorX ? h("span", {}, `@${c.creatorX}`) : c.creator ? h("span", { class: "mono" }, short(c.creator)) : null, ...chips),
        h("div", { class: "hp-stats" }, stat("MC", usd(c.mcapUsd, { compact: true })), stat("Vol", usd(c.volume24hUsd, { compact: true })), stat("Holders", c.holders != null ? compact(c.holders, 0) : "–"),
          stat("Txns", c.txns24h != null ? compact(c.txns24h, 0) : "–")),
        lane === "migrated" ? h("div", { class: "hp-grad" }, h("span", {}, "Graduated"), h("small", {}, c.liquidityUsd != null ? `Pool ${usd(c.liquidityUsd, { compact: true })}` : "Uniswap v4"))
          : h("div", { class: "hp-bar", title: `${pct.toFixed(1)}% of the curve filled` }, h("i", { style: { width: `${pct}%` } }), h("span", {}, `${pct.toFixed(pct < 10 ? 1 : 0)}% bonded`, c.raisedEth != null ? ` · ${c.raisedEth.toFixed(c.raisedEth < 1 ? 3 : 2)} ETH` : ""))),
      h("div", { class: "hp-act" },
        h("a", { class: "btn hp-buy", href: `#/swap?in=eth&out=${c.token}`, onclick: (e) => e.stopPropagation(), title: "Buy on Troya, through the Gate" },
          h("img", { src: "/img/logo-3d-128.png", alt: "", width: 16, height: 16 }), "Buy"),
        h("div", { class: "hp-venues", role: "group", "aria-label": "Trade elsewhere" }, VENUES.map(([name, logo, url]) =>
          h("a", { class: "hp-venue", href: url(c), target: "_blank", rel: "noopener", title: `Trade on ${name}`, "aria-label": `Trade ${c.symbol} on ${name}`, onclick: (e) => e.stopPropagation() },
            logo ? h("img", { src: `/img/logos/${logo}`, alt: "", width: 16, height: 16 }) : h("b", { class: "hp-venue-txt" }, name.slice(0, 2)))))));
  }

  function paint() {
    const d = st.d;
    if (!d) { clear(lanes, st.err ? h("div", { class: "alert error" }, st.err) : LANES.map(() => h("div", { class: "sk", style: { height: "360px" } }))); return; }
    const all = [...d.new, ...d.almost, ...d.migrated];
    const vol = all.reduce((a, x) => a + (x.volume24hUsd || 0), 0);
    clear(kpis,
      h("div", { class: "hp-kpi" }, h("small", {}, "Born through Troya"), h("b", {}, String(d.counts.born))),
      h("div", { class: "hp-kpi" }, h("small", {}, "Graduated"), h("b", {}, String(d.counts.graduated))),
      h("div", { class: "hp-kpi" }, h("small", {}, "Volume 24h"), h("b", {}, usd(vol, { compact: true }))),
      h("div", { class: "hp-kpi" }, h("small", {}, "Almost bonded at"), h("b", {}, `${d.almostPct}%`)));
    clear(tabs, LANES.map((l) => h("button", { class: `hp-tab ${l.tone}`, type: "button", role: "tab", "aria-selected": String(st.lane === l.key), onclick: () => { st.lane = l.key; paint(); } },
      h("i", {}), l.title, h("small", {}, String(d[l.key].length)))));
    clear(lanes, LANES.map((l) => h("section", { class: `panel hp-lane ${l.tone}${st.lane === l.key ? " on" : ""}`, "aria-label": l.title },
      h("header", {}, h("i", { class: "hp-dot" }), h("b", {}, l.title), h("span", { class: "hp-count" }, String(d[l.key].length)), h("small", {}, l.hint)),
      h("div", { class: "hp-list" }, d[l.key].length ? d[l.key].map((c) => card(c, l.key))
        : h("div", { class: "hp-empty" }, h("p", {}, l.empty), l.key === "new" ? h("div", { class: "hp-empty-acts" }, h("a", { class: "btn primary", href: "#/launch/create" }, "Create on troya.codes"), h("a", { class: "btn", href: "#/launch/x" }, "Launch from X")) : null)))));
  }

  paint();
  const stop = every(15_000, refresh);
  return () => { alive = false; stop(); document.removeEventListener("click", closeMenu); };
}
