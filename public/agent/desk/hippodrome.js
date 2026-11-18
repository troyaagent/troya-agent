// Troya Launches (#/troya-launches; first called the Hippodrome at #/hippodrome, which still redirects here), V6: every coin born through Troya, in three lanes like a trench board.
//   New            launched through Troya (X, Telegram or troya.codes), still early on its Pons curve
//   Almost bonded  a curve at least half full
//   Migrated       graduated to its own Uniswap v4 pool ($TROYA leads it)
// Numbers come from /api/launch/board (Pons on chain, DexScreener, GeckoTerminal, Blockscout), refreshed every 15 s.
import { h, clear, useCss, pageHead, short, ago, tokenIcon, setBorn, compact, usd, every, icon, tipOn, copyText } from "/agent/js/ui.js";
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
// V6 F30: Troya Gate's shield, coloured by the coin's live verdict
const SHIELD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M12 2l8.2 3.1v6.6c0 5-3.5 9.2-8.2 10.6-4.7-1.4-8.2-5.6-8.2-10.6V5.1zm3.6 6.6l-4.9 4.9-2.3-2.3-1.3 1.3 3.6 3.6 6.2-6.2z"/></svg>';
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

// a coin's own links and a copy button for its contract address, beside its name
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const safeLink = (u) => { try { const x = new URL(String(u || "")); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const EXTRA_CSS = `
.hp-copy { display: inline-flex; align-items: center; justify-content: center; align-self: center; flex: none; width: 18px; height: 18px; padding: 0; margin-left: -4px; border: 0; border-radius: 5px; background: none; color: var(--muted, #8a979c); cursor: pointer; transition: color .15s, background .15s; }
.hp-copy svg { width: 13px; height: 13px; display: block; }
.hp-copy:hover, .hp-copy:focus-visible { color: #fff; background: rgba(142, 223, 245, .12); outline: none; }
.hp-copy.done { color: #6fd39a; }
.hp-soc { display: inline-flex; align-items: center; gap: 5px; }
.hp-soc a { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--line, rgba(255, 255, 255, .12)); background: rgba(255, 255, 255, .03); color: var(--fg-2, #c9d6db); transition: color .15s, border-color .15s, background .15s; }
.hp-soc a:hover, .hp-soc a:focus-visible { color: #fff; border-color: rgba(142, 223, 245, .6); background: rgba(142, 223, 245, .12); outline: none; }
.hp-soc svg { width: 11px; height: 11px; display: block; }
.hp-soc a:not(.web) svg { fill: currentColor; }
.hp-soc a.web svg { width: 12px; height: 12px; }
`;
function extraCss() {
  if (document.getElementById("hp-extra-css")) return;
  const s = document.createElement("style"); s.id = "hp-extra-css"; s.textContent = EXTRA_CSS; document.head.append(s);
}

export async function mount(view, ctx) {
  useCss("perps");
  extraCss();
  let alive = true;
  const asked = ctx?.query?.lane && LANES.some((l) => l.key === ctx.query.lane);
  const st = { d: null, err: null, lane: asked ? ctx.query.lane : "new", menu: false, chosen: !!asked };
  const kpis = h("div", { class: "hp-kpis" });
  const lanes = h("div", { class: "hp-lanes" });
  const tabs = h("div", { class: "hp-tabs", role: "tablist" });
  // a slim header row so the three lanes and Create coin lead the page (owner, 18 Nov)
  clear(view, h("div", { class: "dk hp" },
    h("header", { class: "hp-top" },
      h("div", { class: "hp-top-l" }, h("h1", {}, "Troya Launches"), kpis),
      h("a", { class: "btn primary hp-create", href: "#/create" }, icon("plus"), "Create coin")),
    tabs, lanes));

  async function refresh() {
    // an empty answer (the board still building after a restart) keeps what is on screen and says it is loading
    try {
      const d = await api.get("/api/launch/board");
      if (!d?.new) throw new Error(st.d ? "Couldn't refresh the board just now." : "The board is still loading. It refreshes on its own.");
      st.d = d; st.err = null;
      setBorn([...d.new, ...d.almost].map((x) => x.token), d.migrated.map((x) => x.token));
    }
    catch (e) { st.err = e.message; }
    if (alive) paint();
  }

  const stat = (k, v, title) => h("span", { class: "hp-st", title: title || null }, h("i", {}, k), h("b", {}, v));
  const taxOf = (bps) => Number((1 + (Number(bps) || 0) / 100).toFixed(2));
  const taxTip = (bps) => `Total tax on every buy and sell: 1% Pons fee (0.7% to the creator, 0.3% to Pons)${bps ? ` + ${Number((bps / 100).toFixed(2))}% creator tax` : ", no creator tax"}`;
  // a coin card: identity and numbers on top (market cap on the right), the curve and the ways to trade along the bottom
  function card(c, lane) {
    const src = SOURCE[c.source];
    const fresh = c.at && Date.now() - c.at < 3 * 60_000;
    const pct = Math.max(0, Math.min(100, Number(c.progressPct) || 0));
    // tags appear only when they are true for this coin
    const tags = [];
    // V6 F30 Born at the gate: the coin's live Troya Gate verdict (a 0.01 ETH buy and its sell simulated, every 10 minutes)
    if (c.gate?.verdict) {
      const G = { passed: ["Gate: passed", `Troya Gate passed it: ${c.gate.passed} of ${c.gate.total} checks clean, the buy and the sell simulated.`, "green"],
        caution: ["Gate: caution", `Troya Gate passed it with a warning. ${c.gate.why || ""}`, "yellow"],
        failed: ["Gate: failed", `Troya Gate would stop a trade right now. ${c.gate.why || ""}`, "red"],
        untested: ["Gate: not tested yet", "Nobody has sold yet, so the sell can't be simulated. Troya checks again every 10 minutes.", "blue"],
        launching: ["Gate: launching", "Its first minutes carry Pons's snipe tax, so the Gate waits for it to settle. Checked again in 30 seconds.", "blue"] }[c.gate.verdict];
      if (G) tags.push(tipOn(h("span", { class: `hp-tag hp-gate ${c.gate.verdict} ic` }, svg(SHIELD, "hp-tag-ic")), G[0], `${G[1].trim()} Checked ${ago(c.gate.checkedAt)}.`, G[2]));
    }
    if (c.og) tags.push(tipOn(h("span", { class: "hp-tag og" }, "OG"), "OG", c.badgesFrom === "gmgn" ? "Flagged as an OG token on GMGN." : "The original $TROYA, the coin Troya is built around.", "green"));
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
      tags.push(tipOn(h("span", { class: "hp-tag horse" }, h("i", { class: "hp-horse-ic" })), "Dev holds $TROYA",
        `The creator holds ${amt} $TROYA${c.keepsAll ? " and keeps the whole creator fee on this coin" : ""}.`, "blue"));
    }
    const go = () => { location.hash = `#/token/${c.token.toLowerCase()}`; };
    const stop = (e) => e.stopPropagation();
    // the coin's own X, Telegram and website (an X link to a single post is the launch post)
    const so = c.socials || {}, xUrl = safeLink(so.x), tgUrl = safeLink(so.telegram), webUrl = safeLink(so.website);
    const xTitle = xUrl && /\/status\/\d+/.test(xUrl) ? "Launch post on X" : "X";
    const socLinks = [
      xUrl ? h("a", { href: xUrl, target: "_blank", rel: "noopener nofollow", title: xTitle, "aria-label": `${c.symbol} on X`, onclick: stop }, svg(X_ICON, "")) : null,
      tgUrl ? h("a", { href: tgUrl, target: "_blank", rel: "noopener nofollow", title: "Telegram", "aria-label": `${c.symbol} on Telegram`, onclick: stop }, svg(TG_ICON, "")) : null,
      webUrl ? h("a", { class: "web", href: webUrl, target: "_blank", rel: "noopener nofollow", title: "Website", "aria-label": `${c.symbol} website`, onclick: stop }, svg(WEB_ICON, "")) : null,
    ].filter(Boolean);
    const socials = socLinks.length ? h("span", { class: "hp-soc" }, socLinks) : null;
    const copy = h("button", { class: "hp-copy", type: "button", title: `Copy contract address ${c.token}`, "aria-label": `Copy ${c.symbol} contract address`,
      onclick: (e) => { e.stopPropagation(); copyText(c.token, `${c.symbol || "Coin"} contract address copied`); copy.classList.add("done"); copy.innerHTML = CHECK_ICON; setTimeout(() => { copy.classList.remove("done"); copy.innerHTML = COPY_ICON; }, 1600); },
      onkeydown: stop });
    copy.innerHTML = COPY_ICON;
    return h("article", { class: `hp-card${fresh ? " fresh" : ""}`, tabindex: "0", role: "link", "aria-label": `${c.symbol} ${c.name}`, onclick: go, onkeydown: (e) => { if (e.key === "Enter") go(); } },
      h("div", { class: "hp-ava" }, tokenIcon({ address: c.token, symbol: c.symbol, image: c.image }, "xl")),
      h("div", { class: "hp-body" },
        h("div", { class: "hp-top" }, h("b", { class: "hp-sym" }, c.symbol || short(c.token)), h("span", { class: "hp-name" }, c.name || ""), copy),
        tags.length ? h("div", { class: "hp-tags" }, tags) : null,
        socials ? h("div", { class: "hp-tags hp-soc-row" }, socials) : null,
        h("div", { class: "hp-meta" },
          src ? h("span", { class: "hp-src", title: `Launched from ${src[0]}` }, svg(src[1], "hp-src-ic")) : null,
          c.at ? h("span", {}, ago(c.at)) : null,
          c.creator ? h("span", { class: "mono" }, short(c.creator)) : null),
        h("div", { class: "hp-stats" },
          stat("Holders", c.holders != null ? compact(c.holders, 0) : "–"), stat("Txns", c.txns24h != null ? compact(c.txns24h, 0) : "–"),
          stat("Tax", `${taxOf(c.creatorTaxBps)}%`, taxTip(c.creatorTaxBps)), c.initialBuyEth ? stat("Dev buy", `${c.initialBuyEth} ETH`) : null)),
      h("div", { class: "hp-side" },
        h("div", { class: "hp-mc" }, h("small", {}, "MC"), h("b", {}, usd(c.mcapUsd, { compact: true }))),
        h("div", { class: "hp-vol" }, h("small", {}, "Vol 24h"), h("span", {}, usd(c.volume24hUsd, { compact: true })))),
      h("div", { class: "hp-foot" },
        lane === "migrated" ? h("div", { class: "hp-grad" }, h("span", {}, "Graduated"), h("small", {}, c.liquidityUsd != null ? `Pool ${usd(c.liquidityUsd, { compact: true })}` : "Uniswap v4"))
          : h("div", { class: "hp-bar", title: `${pct.toFixed(1)}% of the curve filled` }, h("i", { style: { width: `${pct}%` } }), h("span", {}, pct < 0.05 ? "Just started on the curve" : `${pct.toFixed(pct < 10 ? 1 : 0)}% bonded`, c.raisedEth != null && c.raisedEth >= 0.0005 ? ` · ${c.raisedEth.toFixed(c.raisedEth < 1 ? 3 : 2)} ETH` : "")),
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
      h("span", { class: "hp-kpi" }, h("b", {}, String(d.counts.born)), " born"),
      h("span", { class: "hp-kpi" }, h("b", {}, String(d.counts.graduated)), " graduated"),
      h("span", { class: "hp-kpi" }, h("b", {}, usd(vol, { compact: true })), " vol 24h"));
    // phones show one lane at a time: until the visitor picks one, open the first lane that has coins in it
    if (!st.chosen && !d[st.lane]?.length) { const first = LANES.find((l) => d[l.key]?.length); if (first) st.lane = first.key; }
    clear(tabs, LANES.map((l) => h("button", { class: `hp-tab ${l.tone}`, type: "button", role: "tab", "aria-selected": String(st.lane === l.key), onclick: () => { st.lane = l.key; st.chosen = true; paint(); } },
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
