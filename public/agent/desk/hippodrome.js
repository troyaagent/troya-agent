// Troya Launches (#/troya-launches; first called the Hippodrome at #/hippodrome, which still redirects here), V6: every coin born through Troya, in three lanes like a trench board.
//   New            launched through Troya (X, Telegram or troya.codes), still early on its Pons curve
//   Almost bonded  a curve at least half full
//   Migrated       graduated to its own Uniswap v4 pool ($TROYA leads it)
// Numbers come from /api/launch/board (Pons on chain, DexScreener, GeckoTerminal, Blockscout), refreshed every 15 s.
import { h, clear, useCss, pageHead, short, ago, tokenIcon, setBorn, compact, usd, every, icon, tipOn } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const LANES = [
  { key: "new", title: "New", tone: "new", hint: "Born through Troya, early on the curve", empty: "No coins yet." },
  { key: "almost", title: "Almost bonded", tone: "almost", hint: "Curve at least 50% full", empty: "Nothing close to bonding yet." },
  { key: "migrated", title: "Migrated", tone: "migrated", hint: "Graduated to its own Uniswap v4 pool", empty: "No coin has graduated yet." },
];
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 3h3l-6.6 7.5L21.6 21h-6l-4.7-6.1L5.4 21h-3l7.1-8.1L2.2 3h6.1l4.2 5.6L17.5 3zm-1 16.2h1.7L7.6 4.7H5.8l10.7 14.5z"/></svg>';
const TG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.5-1.5zm-3.3 3.2-8.6 7.8-.3 3.4-1.4-4.5 10.3-6.7z"/></svg>';
const WEB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
const svg = (s, cls) => { const e = h("span", { class: cls, "aria-hidden": "true" }); e.innerHTML = s; return e; };
const SOURCE = { x: ["X", X_ICON], tg: ["Telegram", TG_ICON], web: ["Web", WEB_ICON] };
// CTO: a group of people; Dex Paid: a blue verified badge
const PEOPLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.25 6.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0zM15.75 9.75a3 3 0 1 1 6 0 3 3 0 0 1-6 0zM2.25 9.75a3 3 0 1 1 6 0 3 3 0 0 1-6 0zM6.31 15.12A6.75 6.75 0 0 1 12 12a6.75 6.75 0 0 1 6.71 7.5.75.75 0 0 1-.37.57A12.7 12.7 0 0 1 12 21.75c-2.3 0-4.47-.61-6.34-1.68a.75.75 0 0 1-.37-.57 6.79 6.79 0 0 1 1.02-4.38zM5.08 14.25a8.29 8.29 0 0 0-1.3 5.14 9.7 9.7 0 0 1-1.77-.44l-.11-.04a.56.56 0 0 1-.38-.49l-.01-.12a3.75 3.75 0 0 1 3.57-4.05zM20.23 19.39a8.29 8.29 0 0 0-1.31-5.14 3.75 3.75 0 0 1 3.57 4.05l-.01.12a.56.56 0 0 1-.37.49l-.12.04c-.56.2-1.15.35-1.76.44z"/></svg>';
const FIRE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12.96 2.29a.75.75 0 0 0-1.07-.14 9.74 9.74 0 0 0-3.54 6.18 7.55 7.55 0 0 1-1.7-1.72.75.75 0 0 0-1.16-.08A9 9 0 1 0 15.68 4.53a7.46 7.46 0 0 1-2.72-2.24zM15.75 14.25a3.75 3.75 0 1 1-7.31-1.17c.63.46 1.35.81 2.13 1a6 6 0 0 1 1.93-3.55 3.75 3.75 0 0 1 3.25 3.72z"/></svg>';
const VERIFIED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="vb" d="M8.6 3.8A4.5 4.5 0 0 1 12 2.25c1.36 0 2.57.6 3.4 1.55a4.5 4.5 0 0 1 3.5 1.3 4.5 4.5 0 0 1 1.3 3.5A4.5 4.5 0 0 1 21.75 12a4.5 4.5 0 0 1-1.55 3.4 4.5 4.5 0 0 1-1.3 3.5 4.5 4.5 0 0 1-3.5 1.3A4.5 4.5 0 0 1 12 21.75a4.5 4.5 0 0 1-3.4-1.55 4.5 4.5 0 0 1-3.5-1.3 4.5 4.5 0 0 1-1.3-3.5A4.5 4.5 0 0 1 2.25 12c0-1.36.6-2.57 1.55-3.4a4.5 4.5 0 0 1 1.3-3.5 4.5 4.5 0 0 1 3.5-1.3z"/><path class="vc" d="M8.4 12.3l2.4 2.4 4.8-5.2"/></svg>';
// besides Troya (Buy, through the Gate), each coin opens on the venues people already trade on
const VENUES = [
  ["Fomo", "fomo.png", (c) => `https://fomo.family/tokens/robinhood/${c.token}`],
  ["Pons", "pons.svg", (c) => c.ponsUrl || `https://ponsfamily.com/launchpad/${c.token.toLowerCase()}`],
  ["DexScreener", "dexscreener.png", (c) => `https://dexscreener.com/robinhood/${c.token}`],
  ["GMGN", "gmgn.png", (c) => `https://gmgn.ai/robinhood/token/${c.token.toLowerCase()}`],
  // pump.fun trades Robinhood Chain coins too (paid in SOL, since July 2026)
  ["pump.fun", "pumpfun.png", (c) => `https://pump.fun/coin/${c.token.toLowerCase()}`],
];

export async function mount(view, ctx) {
  useCss("perps");
  let alive = true;
  const st = { d: null, err: null, lane: ctx?.query?.lane && LANES.some((l) => l.key === ctx.query.lane) ? ctx.query.lane : "new", menu: false };
  const kpis = h("div", { class: "hp-kpis" });
  const lanes = h("div", { class: "hp-lanes" });
  const tabs = h("div", { class: "hp-tabs", role: "tablist" });
  clear(view, h("div", { class: "dk hp" },
    pageHead("Troya Launches", "Every coin born through Troya, from its first block on the Pons curve to its own Uniswap pool. Launched from X, Telegram or troya.codes.",
      { act: h("a", { class: "btn primary hp-create", href: "#/create" }, icon("plus"), "Create coin") }),
    kpis, tabs, lanes));

  async function refresh() {
    try { st.d = await api.get("/api/launch/board"); st.err = null; setBorn([...st.d.new, ...st.d.almost].map((x) => x.token), st.d.migrated.map((x) => x.token)); }
    catch (e) { st.err = e.message; }
    if (alive) paint();
  }

  const stat = (k, v) => h("span", { class: "hp-st" }, h("i", {}, k), h("b", {}, v));
  // a coin card: identity and numbers on top (market cap on the right), the curve and the ways to trade along the bottom
  function card(c, lane) {
    const src = SOURCE[c.source];
    const fresh = c.at && Date.now() - c.at < 3 * 60_000;
    const pct = Math.max(0, Math.min(100, Number(c.progressPct) || 0));
    // tags appear only when they are true for this coin
    const tags = [];
    if (c.source === "origin") tags.push(tipOn(h("span", { class: "hp-tag og" }, "OG"), "OG", "The original $TROYA, the coin Troya is built around.", "green"));
    if (c.cto) tags.push(tipOn(h("span", { class: "hp-tag cto ic on" }, svg(PEOPLE, "hp-tag-ic")), "Community takeover", "The community runs this coin.", "yellow"));
    if (c.dexPaid) tags.push(tipOn(h("span", { class: "hp-tag paid ic on" }, svg(VERIFIED, "hp-tag-ic")), "Dex Paid", "This coin's DexScreener profile is paid and approved.", "blue"));
    const dv = c.dev, pc = (x) => `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}%`;
    if (dv && !dv.never) {
      // dev burn: a flame, yellow when the dev burned everything, green when part of it
      if (dv.burnedPct >= 1) tags.push(dv.burnt === "all"
        ? tipOn(h("span", { class: "hp-tag fire all ic" }, svg(FIRE, "hp-tag-ic")), "Dev burned everything", `The dev burned ${pc(dv.burnedPct)} of what they received and holds none.`, "yellow")
        : tipOn(h("span", { class: "hp-tag fire ic" }, svg(FIRE, "hp-tag-ic")), "Dev burned part", `The dev burned ${pc(dv.burnedPct)} of what they received and still holds ${pc(dv.heldPct)} of the supply.`, "green"));
      // dev sell: red, only when the dev really sold a meaningful share
      if (dv.soldPct >= 5) tags.push(tipOn(h("span", { class: "hp-tag dev red" }, "DS"), dv.sold === "all" ? "Dev sold everything" : "Dev sold",
        `The dev sold or moved out ${pc(dv.soldPct)} of what they received${dv.heldPct > 0 ? ` and still holds ${pc(dv.heldPct)} of the supply` : ""}.`, "red"));
    }
    // the dev holds 1M $TROYA: the Troya horse
    if (c.devHolder) {
      const amt = c.devTroya >= 1e6 ? `${(c.devTroya / 1e6).toFixed(2).replace(/\.?0+$/, "")}M` : compact(c.devTroya || 0, 0);
      tags.push(tipOn(h("span", { class: "hp-tag horse ic" }, h("img", { src: "/img/logo-3d-128.png", alt: "" })), "Dev holds $TROYA",
        `The creator holds ${amt} $TROYA${c.keepsAll ? " and keeps the whole creator fee on this coin" : ""}.`, "blue"));
    }
    const go = () => { location.hash = `#/token/${c.token.toLowerCase()}`; };
    const stop = (e) => e.stopPropagation();
    return h("article", { class: `hp-card${fresh ? " fresh" : ""}`, tabindex: "0", role: "link", "aria-label": `${c.symbol} ${c.name}`, onclick: go, onkeydown: (e) => { if (e.key === "Enter") go(); } },
      h("div", { class: "hp-ava" }, tokenIcon({ address: c.token, symbol: c.symbol, image: c.image }, "xl")),
      h("div", { class: "hp-body" },
        h("div", { class: "hp-top" }, h("b", { class: "hp-sym" }, c.symbol || short(c.token)), h("span", { class: "hp-name" }, c.name || "")),
        tags.length ? h("div", { class: "hp-tags" }, tags) : null,
        h("div", { class: "hp-meta" },
          src ? h("span", { class: "hp-src", title: `Launched from ${src[0]}` }, svg(src[1], "hp-src-ic")) : null,
          c.at ? h("span", {}, ago(c.at)) : null,
          c.creatorX ? h("span", {}, `@${c.creatorX}`) : c.creator ? h("span", { class: "mono" }, short(c.creator)) : null),
        h("div", { class: "hp-stats" },
          stat("Holders", c.holders != null ? compact(c.holders, 0) : "–"), stat("Txns", c.txns24h != null ? compact(c.txns24h, 0) : "–"),
          c.creatorTaxBps ? stat("Tax", `${c.creatorTaxBps / 100}%`) : null, c.initialBuyEth ? stat("Dev buy", `${c.initialBuyEth} ETH`) : null)),
      h("div", { class: "hp-side" },
        h("div", { class: "hp-mc" }, h("small", {}, "MC"), h("b", {}, usd(c.mcapUsd, { compact: true }))),
        h("div", { class: "hp-vol" }, h("small", {}, "Vol 24h"), h("span", {}, usd(c.volume24hUsd, { compact: true })))),
      h("div", { class: "hp-foot" },
        lane === "migrated" ? h("div", { class: "hp-grad" }, h("span", {}, "Graduated"), h("small", {}, c.liquidityUsd != null ? `Pool ${usd(c.liquidityUsd, { compact: true })}` : "Uniswap v4"))
          : h("div", { class: "hp-bar", title: `${pct.toFixed(1)}% of the curve filled` }, h("i", { style: { width: `${pct}%` } }), h("span", {}, `${pct.toFixed(pct < 10 ? 1 : 0)}% bonded`, c.raisedEth != null ? ` · ${c.raisedEth.toFixed(c.raisedEth < 1 ? 3 : 2)} ETH` : "")),
        h("div", { class: "hp-act" },
          h("a", { class: "btn hp-buy", href: `#/swap?in=eth&out=${c.token}`, onclick: stop, title: "Buy on Troya, through the Gate" },
            h("img", { src: "/img/logo-3d-128.png", alt: "", width: 16, height: 16 }), "Buy"),
          VENUES.map(([name, logo, url]) =>
            h("a", { class: "hp-venue", href: url(c), target: "_blank", rel: "noopener", title: `Trade on ${name}`, "aria-label": `Trade ${c.symbol} on ${name}`, onclick: stop },
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
      h("div", { class: "hp-kpi" }, h("small", {}, "Volume 24h"), h("b", {}, usd(vol, { compact: true }))));
    clear(tabs, LANES.map((l) => h("button", { class: `hp-tab ${l.tone}`, type: "button", role: "tab", "aria-selected": String(st.lane === l.key), onclick: () => { st.lane = l.key; paint(); } },
      h("i", {}), l.title, h("small", {}, String(d[l.key].length)))));
    clear(lanes, LANES.map((l) => h("section", { class: `panel hp-lane ${l.tone}${st.lane === l.key ? " on" : ""}`, "aria-label": l.title },
      h("header", {}, h("i", { class: "hp-dot" }), h("b", {}, l.title), h("span", { class: "hp-count" }, String(d[l.key].length)), h("small", {}, l.hint)),
      h("div", { class: "hp-list" }, d[l.key].length ? d[l.key].map((c) => card(c, l.key))
        : h("div", { class: "hp-empty" }, h("p", {}, l.empty))))));
  }

  paint();
  const stop = every(15_000, refresh);
  return () => { alive = false; stop(); };
}
