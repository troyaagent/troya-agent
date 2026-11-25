// V10 F64 Proteus (#/proteus and #/proteus/<TICKER>): one share compared everywhere it trades on chain that Troya can read
// for free (Robinhood Chain stock tokens, Hyperliquid stock perps, xStocks and Ondo tokens), against the real share and a
// 24/7 fair-value band built on Zeno's Gap. Everything comes from GET /api/proteus and /api/proteus/:ticker
// (server/proteus.mjs). Reading only: no trade, no wallet.
import { h, clear, toast, ago } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const usd = (n) => {
  if (n == null || !isFinite(n)) return "–";
  const a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n).toLocaleString("en-US")}`;
};
const px = (n) => (n == null || !isFinite(n) ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`);
const sp = (x) => (x == null || !isFinite(x) ? "–" : `${x > 0 ? "+" : ""}${x.toFixed(2)}%`);
const SESSION = { open: "US market open", "pre-market": "Pre-market", "after-hours": "After hours", overnight: "US market closed (overnight)", weekend: "US market closed (weekend)" };

function css() {
  if (document.querySelector("style[data-proteus]")) return;
  document.head.append(h("style", { "data-proteus": "1" }, `
.pt-page { display: grid; gap: 16px; }
.pt-box { padding: 18px; min-width: 0; }
.pt-box h2 { margin: 0 0 6px; font-size: 17px; }
.pt-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pt-form input { max-width: 220px; text-transform: uppercase; }
.pt-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.pt-chips button { font: inherit; font-size: 12.5px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg-2); color: var(--fg); cursor: pointer; }
.pt-lead { margin: 2px 0 12px; font-size: 15px; line-height: 1.45; }
.pt-ref { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.pt-ref div { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); min-width: 0; }
.pt-ref small { display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.pt-ref b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pt-ref span { display: block; font-size: 12px; color: var(--muted); }
.pt-strip { position: relative; height: 64px; margin: 18px 6px 34px; }
.pt-axis { position: absolute; left: 0; right: 0; top: 30px; height: 2px; background: var(--line-2); }
.pt-band { position: absolute; top: 22px; height: 18px; background: var(--up-bg); border: 1px solid var(--up); border-radius: 4px; min-width: 3px; }
.pt-refm { position: absolute; top: 14px; width: 2px; height: 34px; background: var(--fg); }
.pt-dot { position: absolute; top: 25px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: var(--warn); border: 2px solid var(--bg-2); }
.pt-dot.perp { background: var(--muted); border-radius: 2px; }
.pt-dot.out { background: var(--down); }
.pt-tick { position: absolute; top: 46px; font-size: 11px; color: var(--faint); transform: translateX(-50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pt-lbl { position: absolute; top: 0; font-size: 11px; color: var(--muted); transform: translateX(-50%); white-space: nowrap; }
.pt-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.pt-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: -1px; border-radius: 50%; background: var(--warn); }
.pt-legend i.perp { background: var(--muted); border-radius: 2px; } .pt-legend i.band { background: var(--up-bg); border: 1px solid var(--up); border-radius: 2px; } .pt-legend i.ref { width: 2px; border-radius: 0; background: var(--fg); }
.pt-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.pt-t { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.pt-t th { text-align: right; font-weight: 500; color: var(--faint); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.pt-t td { text-align: right; padding: 8px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.pt-t th:first-child, .pt-t td:first-child, .pt-t th:nth-child(2), .pt-t td:nth-child(2) { text-align: left; }
.pt-t td small { display: block; color: var(--faint); font-size: 11.5px; }
.pt-up { color: var(--up); } .pt-down { color: var(--down); } .pt-warn { color: var(--warn); }
.pt-thin { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--warn); border: 1px solid var(--warn); border-radius: 999px; padding: 0 6px; margin-left: 6px; }
.pt-list { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.pt-text p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; }
.pt-wait { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13.5px; }
@media (max-width: 720px) { .pt-ref { grid-template-columns: 1fr; } }`));
}

// the price strip: the band, the reference and every venue on one axis (the deep venues set the scale; the rest are
// pinned to the edge with their real premium in the label)
function stripEl(r) {
  const ref = r.reference, band = r.band;
  const vs = r.venues.filter((v) => v.priceUsd > 0);
  if (!ref || !vs.length) return null;
  const core = vs.filter((v) => v.deep);
  const pts = [ref.usd, ...(band ? [band.lowUsd, band.highUsd] : []), ...(core.length ? core : vs).map((v) => v.priceUsd)];
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = Math.max((hi - lo) * 0.25, ref.usd * 0.0015);
  lo -= pad; hi += pad;
  const x = (p) => Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100));
  const off = (p) => p < lo || p > hi;
  return h("div", {},
    h("div", { class: "pt-strip", role: "img", "aria-label": `Price strip: reference ${px(ref.usd)}${band ? `, band ${px(band.lowUsd)} to ${px(band.highUsd)}` : ""}, ${vs.length} venues` },
      h("div", { class: "pt-axis" }),
      band ? h("div", { class: "pt-band", style: { left: `${x(band.lowUsd)}%`, width: `${Math.max(0.4, x(band.highUsd) - x(band.lowUsd))}%` }, title: `Fair-value band ${px(band.lowUsd)} to ${px(band.highUsd)}` }) : null,
      h("div", { class: "pt-refm", style: { left: `${x(ref.usd)}%` }, title: `Reference ${px(ref.usd)}` }),
      h("div", { class: "pt-lbl", style: { left: `${x(ref.usd)}%` } }, `reference ${px(ref.usd)}`),
      ...vs.map((v) => h("div", { class: `pt-dot ${v.kind === "perp" ? "perp" : ""} ${off(v.priceUsd) ? "out" : ""}`, style: { left: `${x(v.priceUsd)}%` }, title: `${v.label} on ${v.chain}: ${px(v.priceUsd)} (${sp(v.premiumPct)})${off(v.priceUsd) ? ", off this scale" : ""}` })),
      h("div", { class: "pt-tick", style: { left: "0%", transform: "none" } }, px(lo)), h("div", { class: "pt-tick", style: { left: "100%", transform: "translateX(-100%)" } }, px(hi))),
    h("div", { class: "pt-legend" }, h("span", {}, h("i", { class: "ref" }), "Reference"), band ? h("span", {}, h("i", { class: "band" }), "Fair-value band") : null,
      h("span", {}, h("i", {}), "Token"), h("span", {}, h("i", { class: "perp" }), "Perp"), vs.some((v) => off(v.priceUsd)) ? h("span", {}, "Red: off this scale (thin venues), see the table") : null));
}

function result(r) {
  const ref = r.reference, band = r.band;
  const cls = (x) => (x == null ? "" : Math.abs(x) < 0.5 ? "" : Math.abs(x) < 2 ? "pt-warn" : x > 0 ? "pt-up" : "pt-down");
  return [
    h("section", { class: "panel pt-box" },
      h("h2", {}, `${r.ticker}${r.name ? ` · ${r.name}` : ""}`),
      h("p", { class: "pt-lead" }, r.headline),
      ref ? h("div", { class: "pt-ref" },
        h("div", {}, h("small", {}, ref.kind === "zeno" ? "Reference: Zeno's fair value" : "Reference: real share"), h("b", {}, px(ref.usd)), h("span", {}, SESSION[ref.session] || ref.session || "")),
        h("div", {}, h("small", {}, "Last real price"), h("b", {}, px(ref.lastRealUsd)), h("span", {}, `${ref.basis || ""}${ref.lastRealAt ? ` · ${ago(ref.lastRealAt)} ago` : ""}`)),
        h("div", {}, h("small", {}, "Fair-value band"), h("b", {}, band ? (band.lowUsd === band.highUsd ? px(band.lowUsd) : `${px(band.lowUsd)} to ${px(band.highUsd)}`) : "–"), h("span", {}, band ? `${band.estimates.length} estimate${band.estimates.length === 1 ? "" : "s"}` : "no estimate"))) : null,
      ref ? h("p", { class: "fine" }, ref.text) : null,
      stripEl(r),
      band ? h("details", {}, h("summary", { class: "fine" }, "What the band is made of"), h("ul", { class: "pt-list" }, band.estimates.map((e) => h("li", {}, `${e.label}: ${px(e.usd)}`)), h("li", {}, band.text))) : null),
    h("section", { class: "panel pt-box" }, h("h2", {}, "Every venue"),
      r.venues.length ? h("div", { class: "pt-scroll" }, h("table", { class: "pt-t" },
        h("thead", {}, h("tr", {}, h("th", {}, "Venue"), h("th", {}, "Chain"), h("th", {}, "Price per share"), h("th", {}, "vs reference"), h("th", {}, "vs band"), h("th", {}, "Liquidity / OI"), h("th", {}, "24h volume"), h("th", {}, "More"))),
        h("tbody", {}, r.venues.map((v) => h("tr", {},
          h("td", {}, v.href ? h("a", { class: "link", href: v.href, ...(v.external ? { target: "_blank", rel: "noopener" } : {}) }, v.label) : v.label, !v.deep ? h("span", { class: "pt-thin", title: v.kind === "perp" ? "Under $1M of open interest" : "Under $50k of liquidity: its price moves on small trades" }, "thin") : null),
          h("td", {}, v.chain),
          h("td", {}, px(v.priceUsd), v.multiplier && v.multiplier !== 1 ? h("small", {}, `token ${px(v.perToken)} ÷ ${Number(v.multiplier).toFixed(4)}`) : null),
          h("td", { class: cls(v.premiumPct) }, sp(v.premiumPct)),
          h("td", {}, v.band ? (v.band.side === "inside" ? "inside" : `${v.band.side} ${sp(v.band.byPct)}`) : "–"),
          h("td", {}, v.kind === "perp" ? `${usd(v.oiUsd)} OI` : usd(v.liquidityUsd)),
          h("td", {}, usd(v.volume24hUsd)),
          h("td", {}, v.kind === "perp" ? [v.fundingHrPct != null ? `funding ${v.fundingHrPct.toFixed(4)}%/h` : null, v.impactSpreadPct != null ? `spread ${v.impactSpreadPct.toFixed(3)}%` : null].filter(Boolean).join(" · ") || "–" : v.pools ? `${v.pools} pool${v.pools === 1 ? "" : "s"}${v.pool ? ` · deepest ${v.pool}` : ""}` : "–")))))) : h("p", { class: "fine" }, "No venue could be read for this ticker right now."),
      r.venues.some((v) => v.note) ? h("ul", { class: "pt-list" }, [...new Set(r.venues.map((v) => v.note).filter(Boolean))].map((n) => h("li", {}, n))) : null,
      r.missing.length ? h("details", { open: r.venues.length < 2 }, h("summary", { class: "fine" }, `Not shown (${r.missing.length})`), h("ul", { class: "pt-list" }, r.missing.map((m) => h("li", {}, h("b", {}, m.label), `: ${m.why}`)))) : null,
      h("p", { class: "fine" }, `Read ${ago(r.checkedAt)} ago. ${r.sources}`)),
    h("section", { class: "panel pt-box pt-text" }, h("h2", {}, "Read this first"),
      h("p", {}, r.text.estimate), h("p", {}, r.text.us), h("p", {}, r.text.forecast), h("p", { class: "fine" }, r.text.method)),
  ];
}

export async function mount(view, ctx = {}) {
  css();
  const input = h("input", { class: "input", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "12", placeholder: "Ticker, e.g. NVDA", "aria-label": "Ticker", list: "pt-tickers" });
  const dl = h("datalist", { id: "pt-tickers" });
  const go = h("button", { class: "btn primary", type: "button" }, "Compare");
  const chips = h("div", { class: "pt-chips" });
  const out = h("div", { class: "pt-page", "aria-live": "polite" });
  let alive = true, seq = 0;

  async function run(raw) {
    const T = String(raw || "").trim().replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(T)) { toast("Type a share's ticker, for example NVDA.", "error"); input.focus(); return; }
    const id = ++seq;
    input.value = T;
    if (location.hash !== `#/proteus/${T}`) history.replaceState(null, "", `#/proteus/${T}`);
    clear(out, h("section", { class: "panel pt-box" }, h("div", { class: "pt-wait" }, `Reading ${T} on every venue…`)));
    go.disabled = true;
    try {
      const r = await api.get(`/api/proteus/${encodeURIComponent(T)}`);
      if (!alive || id !== seq) return;
      clear(out, ...result(r));
      dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Proteus for ${T}: ${r.headline} ${r.reference?.text || ""}` } }));
    } catch (e) {
      if (alive && id === seq) clear(out, h("section", { class: "panel pt-box" }, h("div", { class: "dk-empty" }, h("b", {}, `Proteus could not read ${T} right now.`), h("p", {}, e.message))));
    } finally { if (id === seq) go.disabled = false; }
  }
  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });

  clear(view, h("div", { class: "dk pt-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Proteus · V10 Poseidon"),
      h("h1", {}, "One stock, many ", h("em", {}, "seas"), "."),
      h("p", { class: "dk-sub" }, "Proteus, the old man of the sea, could take any shape. One share trades on chain in many shapes: Robinhood stock tokens, Hyperliquid stock perps, xStocks and Ondo tokens on other chains. Pick a ticker to see each one's price against the real share, and a 24/7 fair-value band that builds on Zeno's Gap when the US market is closed.")),
    h("section", { class: "panel pt-box" }, h("div", { class: "pt-form" }, input, dl, go), chips,
      h("p", { class: "fine", style: { marginTop: "10px" } }, "An estimate, not a quote. Stock tokens are not offered to US persons. No forecast.")),
    out));

  api.get("/api/proteus").then((L) => {
    if (!alive) return;
    clear(dl, (L.tickers || []).map((t) => h("option", { value: t.ticker }, t.name || t.ticker)));
    clear(chips, (L.tickers || []).filter((t) => t.robinhood && t.perps.length).slice(0, 14).map((t) => h("button", { type: "button", title: `${t.name || t.ticker}: Robinhood stock token + ${t.perps.length} Hyperliquid perp dex${t.perps.length === 1 ? "" : "es"}`, onclick: () => run(t.ticker) }, t.ticker)));
  }).catch(() => clear(chips, h("span", { class: "fine" }, "The ticker list could not be read; type a ticker.")));

  const start = ctx.parts?.[0] || ctx.query?.ticker || "";
  if (start) run(decodeURIComponent(start));
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; };
}
