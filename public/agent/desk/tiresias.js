// V10 F68 Tiresias, the Time Machine (#/tiresias): what the chain showed in the first minutes of past launches that pumped or
// dumped, and how a coin compares with them, side by side with the evidence. Everything comes from GET /api/tiresias and
// GET /api/tiresias/:token (server/tiresias.mjs); the coin search uses /api/search/coins. Patterns from the past are context,
// never a promise: this page never forecasts a price or says what to buy or sell.
import { h, clear, toast, debounce } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const when = (ms) => (ms ? `${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${new Date(ms).toISOString().slice(11, 16)} UTC` : "–");
const sgn = (x) => (x == null || !isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x) >= 10 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(1)}%`);
const pc = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const KIND = { pumped: "Doubled or more", dumped: "Halved or worse", between: "In between" };
// the features shown, in order, and how each is written
const ROWS = [
  ["ageMin", (x) => (x == null ? "–" : x < 90 ? `${x.toFixed(x < 10 ? 1 : 0)} min` : `${(x / 60).toFixed(1)} h`)],
  ["raisedEth", (x) => (x == null ? "–" : `${x.toFixed(3)} ETH`)],
  ["fillEthPerMin", (x) => (x == null ? "–" : `${x.toFixed(3)} ETH/min`)],
  ["holders", (x) => (x == null ? "–" : String(Math.round(x)))],
  ["buyers", (x) => (x == null ? "–" : String(Math.round(x)))],
  ["sellShare", (x) => pc(x)],
  ["top5Pct", (x) => (x == null ? "–" : `${x.toFixed(1)}%`)],
  ["bundlePct", (x) => (x == null ? "–" : `${x.toFixed(1)}%`)],
  ["devSoldPct", (x) => (x == null ? "–" : `${x.toFixed(2)}%`)],
  ["devOutPct", (x) => (x == null ? "–" : `${x.toFixed(2)}%`)],
  ["exemptOthers", (x) => (x == null ? "unknown" : String(Math.round(x)))],
  ["freshShare", (x) => pc(x)],
];

function css() {
  if (document.querySelector("style[data-tiresias]")) return;
  document.head.append(h("style", { "data-tiresias": "1" }, `
.ti-page { display: grid; gap: 16px; }
.ti-box { padding: 18px; }
.ti-box h3 { margin: 0 0 8px; font-size: 15px; }
.ti-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; position: relative; }
.ti-sug { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; margin-top: 4px; border: 1px solid var(--line-3); border-radius: 10px; background: var(--bg-2); display: grid; max-height: 280px; overflow: auto; }
.ti-sug:empty { display: none; }
.ti-sug button { display: flex; gap: 10px; align-items: baseline; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 8px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.ti-sug button:hover { background: var(--bg-1, var(--bg-2)); }
.ti-sug .mono { font-size: 11.5px; color: var(--faint); }
.ti-wait { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13.5px; padding: 12px 0; }
.ti-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-3); border-top-color: var(--fg); animation: tispin 0.9s linear infinite; }
@keyframes tispin { to { transform: rotate(360deg); } }
.ti-sent { font-size: 14.5px; line-height: 1.5; margin: 4px 0 6px; }
.ti-moment { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; }
.ti-rates { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0 4px; }
.ti-rates div { border: 1px solid var(--line-2); border-radius: 10px; padding: 10px 12px; background: var(--bg-2); }
.ti-rates small { display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.ti-rates b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ti-rates span { display: block; font-size: 11.5px; color: var(--muted); }
.ti-scroll { overflow-x: auto; }
.ti-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ti-table th { text-align: left; font-weight: 500; color: var(--faint); font-size: 11px; letter-spacing: .05em; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.ti-table td { padding: 7px 8px; border-bottom: 1px solid var(--line-2); vertical-align: top; white-space: nowrap; }
.ti-table td:first-child { white-space: normal; color: var(--muted); }
.ti-table .me { font-weight: 600; }
.ti-table .r { text-align: right; }
.ti-k { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; }
.ti-k.pumped { color: var(--up); border-color: var(--up); } .ti-k.dumped { color: var(--down); border-color: var(--down); } .ti-k.between { color: var(--muted); }
.ti-up { color: var(--up); } .ti-down { color: var(--down); }
.ti-ev { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; }
.ti-note { font-size: 12.5px; color: var(--muted); line-height: 1.55; margin: 10px 0 0; }
.ti-defs { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 13px; color: var(--muted); }
@media (max-width: 720px) { .ti-rates { grid-template-columns: 1fr; } .ti-form { grid-template-columns: 1fr; } }`));
}

const kindTag = (k) => h("span", { class: `ti-k ${k}` }, KIND[k] || k);
const rateLine = (r, label) => !r ? null : h("div", {}, h("small", {}, label), r.claim
  ? h("b", {}, `${r.pumped} · ${r.dumped} · ${r.between}`) : h("b", {}, `${r.n}`),
  h("span", {}, r.claim ? `doubled · halved or worse · in between, of ${r.n} (${pc(r.shares.pumped)} · ${pc(r.shares.dumped)} · ${pc(r.shares.between)})` : `launch${r.n === 1 ? "" : "es"}: fewer than 5, so no share is given`));

export async function mount(view, ctx = {}) {
  css();
  let alive = true, seq = 0, timer = null, summary = null;
  const input = h("input", { class: "input", placeholder: "A coin's name, ticker or 0x… contract on Robinhood Chain", spellcheck: "false", autocomplete: "off" });
  const sug = h("div", { class: "ti-sug" });
  const go = h("button", { class: "btn primary", type: "button" }, "Compare");
  const out = h("div", { "aria-live": "polite" });
  const sumBox = h("div");

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2 || ADDR.test(q)) { clear(sug); return; }
    try {
      const d = await api.get(`/api/search/coins?q=${encodeURIComponent(q)}&limit=8`);
      if (!alive || input.value.trim() !== q) return;
      clear(sug, (d.coins || []).filter((c) => c.kind === "coin" || !c.kind).map((c) => h("button", { type: "button", onclick: () => { clear(sug); input.value = c.address; run(c.address); } },
        h("b", {}, `$${c.symbol}`), h("span", {}, c.name || ""), h("span", { class: "mono" }, short(c.address)), c.launchpad === "pons" ? null : h("span", { class: "fine" }, "not Pons"))));
    } catch { clear(sug); }
  }, 250);
  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clear(sug); run(input.value); } if (e.key === "Escape") clear(sug); });
  go.addEventListener("click", () => { clear(sug); run(input.value); });

  async function run(raw, { again = 0 } = {}) {
    clearTimeout(timer);
    const a = ADDR.exec(String(raw || "").trim())?.[0];
    if (!a) { toast("Pick a coin from the list or paste its 0x contract address.", "error"); input.focus(); return; }
    const id = ++seq;
    input.value = a;
    if (location.hash !== `#/tiresias/${a}`) history.replaceState(null, "", `#/tiresias/${a}`);
    if (!again) clear(out, h("div", { class: "ti-wait" }, h("span", { class: "ti-spin" }), h("span", {}, "Reading this coin's launch, its first buyers and its curve from the chain…")));
    go.disabled = true;
    let r;
    try { r = await api.get(`/api/tiresias/${a}`); }
    catch (e) { if (!alive || id !== seq) return; go.disabled = false; clear(out, h("div", { class: "dk-empty" }, h("b", {}, "Tiresias could not read this coin right now."), h("p", {}, e.message))); return; }
    if (!alive || id !== seq) return;
    go.disabled = false;
    if (r.status === "reading") {
      clear(out, h("div", { class: "ti-wait" }, h("span", { class: "ti-spin" }), h("span", {}, r.sentence)));
      if (again < 10) timer = setTimeout(() => { if (alive && id === seq) run(a, { again: again + 1 }); }, 5000);
      return;
    }
    render(r);
  }

  function render(r) {
    if (r.status !== "done") { clear(out, h("div", { class: "dk-empty" }, h("b", {}, r.sentence || "Nothing to compare."), r.note ? h("p", {}, r.note) : null)); return; }
    const L = r.labels || {}, G = r.groups || {}, f = r.features || {};
    const ev = r.evidence || {};
    // this coin against what each group showed
    const groupTable = h("div", { class: "ti-scroll" }, h("table", { class: "ti-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "What the chain showed"), h("th", { class: "r" }, `$${r.symbol || "this coin"}`),
        ...["pumped", "dumped", "between"].map((k) => h("th", { class: "r" }, `${KIND[k]} (${G[k]?.n ?? 0})`)))),
      h("tbody", {}, ROWS.map(([k, fmt]) => h("tr", {}, h("td", {}, L[k] || k), h("td", { class: "r me" }, fmt(f[k])),
        ...["pumped", "dumped", "between"].map((g) => h("td", { class: "r" }, G[g]?.medians ? fmt(G[g].medians[k]) : "–")))))));
    const fewGroups = ["pumped", "dumped", "between"].filter((g) => G[g] && !G[g].medians);
    // the analogs side by side
    const an = r.analogs || [];
    const anTable = an.length ? h("div", { class: "ti-scroll" }, h("table", { class: "ti-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Past launch"), h("th", {}, "Afterwards"), h("th", { class: "r" }, "24 h"), h("th", { class: "r" }, "Distance"),
        ...ROWS.slice(0, 8).map(([k]) => h("th", { class: "r" }, (L[k] || k).replace(/ \(.*\)$/, ""))), h("th", {}, "Evidence"))),
      h("tbody", {}, an.map((x) => h("tr", {},
        h("td", {}, h("b", {}, x.symbol ? `$${x.symbol}` : short(x.token)), h("br"), h("span", { class: "fine" }, `checked ${when(x.at)}`), h("br"), h("span", { class: "fine" }, x.from)),
        h("td", {}, kindTag(x.outcome.kind), x.outcome.peakX ? h("div", { class: "fine" }, `peak ${x.outcome.peakX.toFixed(2)}x in 24 h`) : null),
        h("td", { class: `r ${x.outcome.change24h > 0 ? "ti-up" : "ti-down"}` }, sgn(x.outcome.change24h)),
        h("td", { class: "r" }, x.distance != null ? x.distance.toFixed(2) : "–"),
        ...ROWS.slice(0, 8).map(([k, fmt]) => h("td", { class: "r" }, fmt(x.f?.[k]))),
        h("td", {}, h("div", { class: "ti-ev" },
          h("a", { class: "link", href: x.evidence.launchUrl, target: "_blank", rel: "noopener" }, "launch tx"),
          h("a", { class: "link", href: x.evidence.blockUrl, target: "_blank", rel: "noopener" }, "block at the check"),
          x.evidence.post ? h("a", { class: "link", href: x.evidence.post, target: "_blank", rel: "noopener" }, "Sentry's post") : null,
          h("a", { class: "link", href: `#/gate/${x.token}` }, "Gate"))))))))
      : h("p", { class: "fine" }, "No past launch could be compared.");
    clear(out,
      h("p", { class: "ti-sent" }, r.sentence),
      h("p", { class: "ti-moment" }, `$${r.symbol || short(r.token)} read ${r.moment.text}: ${when(r.moment.at)}, ${ROWS[0][1](r.moment.ageMin)} after launch, block `,
        h("a", { class: "link", href: ev.blockUrl, target: "_blank", rel: "noopener" }, String(r.moment.block)), ". ",
        h("a", { class: "link", href: ev.launchUrl, target: "_blank", rel: "noopener" }, "Launch transaction"), " · ",
        h("a", { class: "link", href: `#/gate/${r.token}` }, "Gate it now"),
        r.ownOutcome ? h("span", {}, ` · Troya graded this coin itself: ${KIND[r.ownOutcome.kind].toLowerCase()} (${sgn(r.ownOutcome.change24h)} at 24 h).`) : null),
      h("div", { class: "ti-rates" }, rateLine(r.baseRate?.analogs, `The ${an.length} nearest past launches`), rateLine(r.baseRate?.all, "All past launches read"),
        h("div", {}, h("small", {}, "How alike"), h("b", {}, r.closeness || "–"), h("span", {}, r.medianDistance != null ? `median distance ${r.medianDistance.toFixed(2)} (0 is identical; over 1, loosely alike)` : ""))),
      h("h3", { style: { marginTop: "16px" } }, "This coin next to what past launches showed"),
      h("p", { class: "fine" }, "Medians of each group, read at Troya's check, before the outcome was known."),
      groupTable,
      fewGroups.length ? h("p", { class: "fine" }, fewGroups.map((g) => `${KIND[g]}: ${G[g].why}.`).join(" ")) : null,
      h("h3", { style: { marginTop: "16px" } }, "The nearest past launches, side by side"),
      anTable,
      h("h3", { style: { marginTop: "16px" } }, "Evidence for this coin"),
      h("div", { class: "ti-ev" },
        h("span", {}, `${ev.transfers ?? "–"} transfers read from the launch to block ${ev.block}`),
        ev.dev ? h("span", {}, "Dev wallet ", h("a", { class: "link mono", href: `${EXPLORER}/address/${ev.dev}`, target: "_blank", rel: "noopener" }, short(ev.dev))) : null,
        ...(ev.devTxs || []).map((d) => h("a", { class: "link", href: `${EXPLORER}/tx/${d.tx}`, target: "_blank", rel: "noopener" }, `dev ${d.kind}`)),
        ...(ev.bundles || []).map((b) => h("a", { class: "link", href: `${EXPLORER}/tx/${b.tx}`, target: "_blank", rel: "noopener" }, `bundle buy: ${b.wallets} wallets, ${b.pctOfSupply.toFixed(1)}%`)),
        f.freshRead ? h("span", {}, `${Math.round((f.freshShare || 0) * f.freshRead)} of the first ${f.freshRead} buyers had never sent a transaction before the launch`) : null),
      (ev.topBuyers || []).length ? h("p", { class: "fine", style: { marginTop: "6px" } }, "Largest buyers by then: ", ...ev.topBuyers.flatMap((b, i) => [i ? ", " : "", h("a", { class: "link mono", href: `${EXPLORER}/address/${b.wallet}`, target: "_blank", rel: "noopener" }, short(b.wallet)), ` ${b.pctOfSupply.toFixed(1)}%`])) : null,
      h("p", { class: "ti-note" }, r.note));
  }

  function renderSummary(s) {
    const D = s.definitions || {};
    clear(sumBox, h("h3", {}, "What Tiresias compares"),
      h("ul", { class: "ti-defs" },
        h("li", {}, h("b", {}, "Doubled or more: "), D.pumped), h("li", {}, h("b", {}, "Halved or worse: "), D.dumped), h("li", {}, h("b", {}, "In between: "), D.between),
        h("li", {}, D.window), h("li", {}, D.analogs), h("li", {}, D.claim)),
      h("div", { class: "ti-rates" }, rateLine(s.baseRate, "All past launches read so far"),
        h("div", {}, h("small", {}, "Read from"), h("b", {}, s.n ? `${when(s.from).split(",")[0]} to ${when(s.to).split(",")[0]}` : "–"), h("span", {}, `${s.pending} graded launch${s.pending === 1 ? "" : "es"} still to read`)),
        h("div", {}, h("small", {}, "Typical check"), h("b", {}, s.medianCheckAgeMin != null ? `${s.medianCheckAgeMin.toFixed(1)} min` : "–"), h("span", {}, "after launch (median)"))),
      h("p", { class: "ti-note" }, s.notStored),
      h("p", { class: "ti-note" }, s.note));
  }

  clear(view, h("div", { class: "dk ti-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Tiresias · V10 Poseidon"),
      h("h1", {}, "What the chain ", h("em", {}, "showed"), " before."),
      h("p", { class: "dk-sub" }, "Past launches that doubled or halved within a day of Troya's check, what the chain showed in the minutes before, and how a coin compares with them, side by side with the evidence: curve fill speed, holders, sells, the dev wallet, bundles, tax-exempt insiders and fresh wallets. Patterns from the past are context, never a promise.")),
    h("section", { class: "panel ti-box" }, h("div", { class: "ti-form" }, input, go, sug), h("div", { style: { marginTop: "14px" } }, out)),
    h("section", { class: "panel ti-box" }, sumBox)));

  api.get("/api/tiresias").then((s) => { if (alive) { summary = s; renderSummary(s); } }).catch(() => { if (alive) clear(sumBox, h("p", { class: "fine" }, "The summary of past launches could not be read right now.")); });
  const start = ctx.parts?.[0] || ctx.query?.token || "";
  if (ADDR.test(start)) run(start);
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; clearTimeout(timer); };
}
