// Desk pulse (community request, 21 Nov 2026): two live lanes for the Desk, real data only.
//   mountPassStrip(el)   the newest coins that passed Sentry at the channel's bar (GET /api/pulse/passed); hides when empty
//   mountGraduated(el)   Pons coins that just filled their curve and moved to their own Uniswap v4 pool, with the time since
//                        (GET /api/pulse/graduated, read from the chain's Initialize events); hides when empty
// Each returns a stop function (clears its timer), for the Desk's stops list. The host element is hidden while its lane is
// empty, so it leaves no gap in the Desk's grid.
import { h, clear, every, usd, pctEl, ago, infoTip, tokenIcon, short } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export function pulseCss() {
  if (document.querySelector("link[data-pulse-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/pulse.css", "data-pulse-css": "1" }));
}
const tick = (s) => (s ? `$${s}` : null);
const when = (ms) => { const a = ago(ms); return a === "–" ? "just now" : `${a} ago`; };

/* ---------- Passed Sentry ---------- */
export function mountPassStrip(el, { limit = 12 } = {}) {
  pulseCss();
  const row = h("div", { class: "pl-pass-row", role: "list" });
  const box = h("section", { class: "pl-pass", "aria-label": "Coins that passed Sentry", hidden: true },
    h("div", { class: "pl-pass-h" }, h("span", { class: "live-dot" }), h("span", { class: "pl-pass-l" }, "Passed Sentry"),
      infoTip("The newest coins that passed every Sentry check and drew real buying: at least 0.5 ETH in from 25 independent buyers, the same bar as the Sentry channel. Not a recommendation: open the coin and its Gate before you trade.", "Passed Sentry")),
    row);
  clear(el, box);
  el.hidden = true;   // the host too, so an empty strip leaves no gap in the Desk's grid
  let alive = true;
  const stop = every(60_000, async () => {
    let d;
    try { d = await api.get(`pulse/passed?limit=${limit}`); } catch { return; }   // a failed read keeps what is shown
    if (!alive) return;
    const items = (d.items || []).filter((x) => ADDR.test(x.token));
    box.hidden = el.hidden = !items.length;
    clear(row, items.map((x) => {
      const age = x.bornAt ? ago(x.bornAt) : null;
      const tip = [`${tick(x.symbol) || x.name || short(x.token)}${x.name && x.symbol && x.name.toUpperCase() !== x.symbol.toUpperCase() ? ` · ${x.name}` : ""}`,
        age ? `born ${when(x.bornAt)}` : null, x.passedAt ? `passed Sentry ${when(x.passedAt)}` : null,
        x.buyers != null ? `${x.buyers} independent buyers` : null, x.source && x.source !== "Pons" ? x.source : null].filter(Boolean).join(" · ");
      return h("a", { class: "pl-chip", role: "listitem", href: `#/token/${x.token}`, title: tip, "aria-label": tip },
        tokenIcon({ symbol: x.symbol, address: x.token }, "sm"),
        h("b", {}, tick(x.symbol) || x.name || short(x.token)),
        h("span", {}, age || (x.passedAt ? `passed ${ago(x.passedAt)}` : "")));
    }));
  });
  return () => { alive = false; stop(); };
}

/* ---------- Just graduated ---------- */
export function mountGraduated(el, { limit = 12 } = {}) {
  pulseCss();
  const allLink = h("a", { class: "link pl-grad-all", href: "#/market?tab=graduated" }, "See all graduated");
  const lane = h("div", { class: "pl-lane", role: "list" });
  const box = h("section", { class: "panel pl-grad", "aria-label": "Coins that just graduated", hidden: true },
    h("div", { class: "panel-h" },
      h("h2", {}, "Just graduated", infoTip("Pons coins whose bonding curve filled and moved to their own Uniswap v4 pool. Read from Robinhood Chain: the pool's creation with the Pons hook, confirmed by the Pons factory. The time is the block's own time.", "Just graduated")),
      h("span", { class: "pl-grad-sub" }, "Pons curve filled · own Uniswap v4 pool"),
      // the full list lives on the Market's Graduated tab (community request, 24 Nov 2026)
      allLink),
    lane);
  clear(el, box);
  el.hidden = true;
  let alive = true, last = [], clocks = [];
  const paint = () => {
    box.hidden = el.hidden = !last.length;
    clocks = [];
    clear(lane, last.map((x) => {
      const name = tick(x.symbol) || x.name || short(x.token);
      const facts = [
        x.mcapUsd > 0 ? ["Market cap", usd(x.mcapUsd, { compact: true })] : null,
        x.liquidityUsd > 0 ? ["Liquidity", usd(x.liquidityUsd, { compact: true })] : null,
        x.change24h != null ? ["24h", pctEl(x.change24h)] : null,
        x.threshold > 0 && x.pair?.symbol ? ["Curve filled", `${x.threshold >= 100 ? Math.round(x.threshold).toLocaleString("en-US") : +Number(x.threshold).toFixed(2)} ${x.pair.symbol}`] : null,
      ].filter(Boolean).slice(0, 4);
      return h("article", { class: "pl-card", role: "listitem" },
        h("a", { class: "pl-card-id", href: `#/token/${x.token}` },
          tokenIcon({ symbol: x.symbol, address: x.token, image: x.image }, ""),
          h("div", {}, h("b", {}, name), h("small", {}, x.name && x.name !== x.symbol ? x.name : x.pair?.symbol ? `paired with ${x.pair.symbol}` : short(x.token)))),
        (() => { const w = h("span", { class: "pl-when", title: new Date(x.at).toLocaleString() }, `Graduated ${when(x.at)}`); clocks.push([w, x.at]); return w; })(),
        facts.length ? h("dl", { class: "pl-facts" }, facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))) : null,
        h("div", { class: "pl-card-a" },
          h("a", { class: "link", href: `#/token/${x.token}` }, "Open"),
          h("a", { class: "link", href: `#/gate/${x.token}` }, "Gate"),
          x.tx ? h("a", { class: "link", href: `${EXPLORER}/tx/${x.tx}`, target: "_blank", rel: "noopener" }, "Graduation tx") : null));
    }));
  };
  const stopLoad = every(60_000, async () => {
    let d;
    try { d = await api.get(`pulse/graduated?limit=${limit}`); } catch { return; }
    if (!alive) return;
    last = (d.items || []).filter((x) => ADDR.test(x.token) && Number.isFinite(x.at));
    allLink.textContent = d.total > 0 ? `See all ${d.total} graduated` : "See all graduated";
    paint();
  });
  // "Graduated 12m ago" keeps moving between reads
  const stopClock = every(30_000, () => { if (alive) for (const [w, at] of clocks) w.textContent = `Graduated ${when(at)}`; });
  return () => { alive = false; stopLoad(); stopClock(); };
}
