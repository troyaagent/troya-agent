// V10 F70 Mentor (#/mentor): the weekly report from Two Fates. Which launches the Gate blocked, why, and what happened to them
// afterwards, next to the ones it passed, each coin linked to its proof, misses included and counted. Everything comes from
// GET /api/mentor (server/mentor.mjs). Reading only: this page never posts anything anywhere.
import { h, clear, toast, ago } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const sgn = (x) => (x == null || !isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x) >= 10 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(1)}%`);
const share = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const day = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const when = (ms) => `${day(ms)}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
const tone = (x) => (x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "");

function css() {
  if (document.querySelector("style[data-mentor]")) return;
  document.head.append(h("style", { "data-mentor": "1" }, `
.mn-page { display: grid; gap: 16px; }
.mn-box { padding: 18px; }
.mn-box h3 { margin: 0 0 8px; font-size: 15px; }
.mn-weeks { display: flex; flex-wrap: wrap; gap: 6px; }
.mn-weeks button { border: 1px solid var(--line-2); background: transparent; color: var(--muted); padding: 6px 12px; border-radius: 999px; font: inherit; font-size: 12.5px; cursor: pointer; }
.mn-weeks button.on { color: var(--fg); border-color: var(--line-3); background: var(--bg-2); }
.mn-partial { margin: 10px 0 0; padding: 10px 12px; border-left: 3px solid var(--warn); background: var(--bg-2); border-radius: 8px; font-size: 13px; }
.mn-sum { font-size: 14.5px; line-height: 1.5; margin: 12px 0 0; }
.mn-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
.mn-side { border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; background: var(--bg-2); }
.mn-side small { display: block; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.mn-side b.big { font-size: 26px; font-weight: 600; }
.mn-side dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 8px 0 0; font-size: 13px; }
.mn-side dt { color: var(--muted); } .mn-side dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.mn-miss { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.mn-miss div { border: 1px solid var(--line-2); border-radius: 10px; padding: 10px 12px; }
.mn-miss small { display: block; font-size: 11px; color: var(--muted); }
.mn-miss b { font-size: 20px; font-weight: 600; }
.mn-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mn-coin { border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; display: grid; gap: 6px; }
.mn-coin.miss { border-left: 3px solid var(--warn); }
.mn-top { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
.mn-top b { font-size: 15px; }
.mn-top .mono { font-size: 11.5px; color: var(--faint); }
.mn-why { font-size: 13.5px; }
.mn-said { font-size: 12px; color: var(--muted); }
.mn-nums { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.mn-nums .up { color: var(--up); } .mn-nums .down { color: var(--down); }
.mn-tag { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; white-space: nowrap; color: var(--muted); }
.mn-tag.warn { color: var(--warn); border-color: var(--warn); } .mn-tag.down { color: var(--down); border-color: var(--down); } .mn-tag.up { color: var(--up); border-color: var(--up); }
.mn-proof { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
.mn-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.mn-table th { text-align: left; font-weight: 500; color: var(--faint); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
.mn-table td { padding: 7px 8px; border-bottom: 1px solid var(--line-2); vertical-align: top; }
.mn-table td.r, .mn-table th.r { text-align: right; }
.mn-table .up { color: var(--up); } .mn-table .down { color: var(--down); }
.mn-table tr.miss td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
.mn-scroll { overflow-x: auto; }
.mn-rules { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 0; }
@media (max-width: 720px) { .mn-two, .mn-miss { grid-template-columns: 1fr; } .mn-table .hide-sm { display: none; } }`));
}

function proofLinks(c) {
  return h("div", { class: "mn-proof" },
    h("a", { class: "link", href: `#/gate/${c.token}` }, "Gate page (a fresh check)"),
    c.proof?.record ? h("a", { class: "link", href: c.proof.record.post || c.proof.record.page, target: "_blank", rel: "noopener" }, c.proof.record.post ? "Sentry's post (The Record)" : "The Record") : null,
    h("a", { class: "link", href: c.proof?.explorer, target: "_blank", rel: "noopener" }, "Explorer"));
}
function resultTag(c) {
  if (c.miss === "blocked-rose") return h("span", { class: "mn-tag warn" }, "Miss: blocked, then rose");
  if (c.miss === "passed-zero") return h("span", { class: "mn-tag warn" }, "Miss: passed, then went to zero");
  if (c.result === "not-sellable") return h("span", { class: "mn-tag down" }, "Could not be sold");
  if (c.result === "zero") return h("span", { class: "mn-tag down" }, "Went to zero");
  if (c.result === "up") return h("span", { class: "mn-tag up" }, "Up after 24 h");
  if (c.result === "down") return h("span", { class: "mn-tag" }, "Down after 24 h");
  if (c.status === "no-price") return h("span", { class: "mn-tag" }, "No price at the check");
  return h("span", { class: "mn-tag" }, "Being watched");
}

export async function mount(view, ctx = {}) {
  css();
  let alive = true, data = null;
  const weeksBox = h("div", { class: "mn-weeks", role: "tablist" });
  const head = h("div");
  const blockedBox = h("div");
  const passedBox = h("div");
  const rulesBox = h("div");

  function sideStats(label, n, s) {
    return h("div", { class: "mn-side" }, h("small", {}, label), h("b", { class: "big" }, String(n)),
      h("dl", {},
        h("dt", {}, "Graded at 24 h"), h("dd", {}, `${s.graded} of ${s.checked}`),
        h("dt", {}, "Up after 24 h"), h("dd", {}, s.graded ? `${s.up24h} (${share(s.up24h, s.graded)})` : "–"),
        h("dt", {}, "Went to zero"), h("dd", {}, s.graded ? String(s.wentToZero) : "–"),
        h("dt", {}, "Could not be sold"), h("dd", {}, s.graded ? String(s.notSellable) : "–"),
        h("dt", {}, "Median change at 24 h"), h("dd", {}, sgn(s.median24h))));
  }

  function render() {
    const w = data.week;
    clear(weeksBox, data.weeks.map((x) => h("button", { type: "button", class: x.key === w.key ? "on" : "", onclick: () => load(x.key) },
      `${x.running ? "This week" : `Week of ${day(x.start)}`} · ${x.blocked} blocked · ${x.passed} passed${x.misses ? ` · ${x.misses} miss${x.misses === 1 ? "" : "es"}` : ""}`)));
    clear(head,
      h("p", { class: "fine" }, `${when(w.start)} to ${w.running ? "now" : when(w.end)}${w.frozen ? " · final" : w.running ? " · running" : " · still taking 24 hour grades"}`),
      w.partial ? h("p", { class: "mn-partial" }, w.partial.text) : null,
      h("p", { class: "mn-sum" }, w.summary),
      h("div", { class: "mn-two" }, sideStats("Blocked by the Gate", w.counts.blocked, w.stats.blocked), sideStats("Passed by the Gate", w.counts.passed, w.stats.passed)),
      h("div", { class: "mn-miss" },
        h("div", {}, h("small", {}, "Blocked, then went to zero or could not be sold"), h("b", {}, String(w.caught))),
        h("div", {}, h("small", {}, "Misses: blocked, then up after 24 h"), h("b", {}, String(w.misses.blockedRose))),
        h("div", {}, h("small", {}, "Misses: passed, then went to zero"), h("b", {}, String(w.misses.passedZero)))),
      w.counts.noPrice ? h("p", { class: "fine", style: { marginTop: "8px" } }, `${w.counts.noPrice} coin${w.counts.noPrice === 1 ? " had" : "s had"} no price at the check: listed, left out of the numbers.`) : null);

    clear(blockedBox, h("h3", {}, `Blocked, and here is why (${w.blocked.length})`),
      w.blocked.length ? h("ul", { class: "mn-list" }, w.blocked.map((c) => h("li", { class: `mn-coin${c.miss ? " miss" : ""}` },
        h("div", { class: "mn-top" }, h("b", {}, c.symbol ? `$${c.symbol}` : short(c.token)), h("span", { class: "mono" }, short(c.token)), resultTag(c), h("span", { class: "fine" }, `checked ${when(c.at)}`)),
        h("div", { class: "mn-why" }, "Why: ", c.reason, "."),
        c.gateSaid ? h("div", { class: "mn-said" }, `The Gate said: "${c.gateSaid}"`) : null,
        h("div", { class: "mn-nums" }, h("span", {}, "After 1 h: ", h("span", { class: tone(c.change1h) }, sgn(c.change1h))), h("span", {}, "After 24 h: ", h("span", { class: tone(c.change24h) }, c.change24h != null ? sgn(c.change24h) : c.resultText))),
        proofLinks(c))))
        : h("p", { class: "fine" }, "No launch was blocked for a safety reason in this stretch."));

    const rows = w.passed;
    clear(passedBox, h("h3", {}, `Passed (${w.passedTotal})`),
      h("p", { class: "fine" }, w.passedListed < w.passedTotal ? `Showing ${w.passedListed}: the misses first, then the newest. ` : "", "A passed coin that went to zero is a miss and is marked."),
      rows.length ? h("div", { class: "mn-scroll" }, h("table", { class: "mn-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Coin"), h("th", { class: "hide-sm" }, "Checked"), h("th", { class: "r" }, "1 h"), h("th", { class: "r" }, "24 h"), h("th", {}, "Result"), h("th", {}, "Proof"))),
        h("tbody", {}, rows.map((c) => h("tr", { class: c.miss ? "miss" : "" },
          h("td", {}, h("b", {}, c.symbol ? `$${c.symbol}` : short(c.token))), h("td", { class: "hide-sm" }, when(c.at)),
          h("td", { class: `r ${tone(c.change1h)}` }, sgn(c.change1h)), h("td", { class: `r ${tone(c.change24h)}` }, sgn(c.change24h)),
          h("td", {}, resultTag(c)), h("td", {}, proofLinks(c)))))))
        : h("p", { class: "fine" }, "No passed launch in this stretch."),
      w.passedListed < w.passedTotal ? h("button", { class: "btn sm", type: "button", style: { marginTop: "10px" }, onclick: () => load(w.key, 3000) }, `Show all ${w.passedTotal}`) : null);

    clear(rulesBox, h("h3", {}, "How Mentor counts"), h("p", { class: "mn-rules" }, data.rules), h("p", { class: "mn-rules", style: { marginTop: "8px" } }, data.limit),
      h("p", { class: "fine", style: { marginTop: "8px" } }, `Updated ${ago(data.updatedAt)} ago. The raw lists: `, h("a", { class: "link", href: "/api/fates", target: "_blank", rel: "noopener" }, "/api/fates"), " and ", h("a", { class: "link", href: `/api/mentor?week=${w.key}`, target: "_blank", rel: "noopener" }, `/api/mentor?week=${w.key}`), "."));
  }

  async function load(week, passed) {
    try {
      const q = new URLSearchParams();
      if (week) q.set("week", week);
      if (passed) q.set("passed", String(passed));
      const d = await api.get(`/api/mentor${q.toString() ? `?${q}` : ""}`);
      if (!alive) return;
      data = d;
      if (week && location.hash !== `#/mentor/${week}`) history.replaceState(null, "", `#/mentor/${week}`);
      render();
    } catch (e) { if (alive) { toast(e.message || String(e), "error", 5000); clear(head, h("div", { class: "dk-empty" }, h("b", {}, "The report could not be read right now."), h("p", {}, e.message || ""))); } }
  }

  clear(view, h("div", { class: "dk mn-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Mentor · V10 Poseidon"),
      h("h1", {}, "Blocked, and here is ", h("em", {}, "why"), "."),
      h("p", { class: "dk-sub" }, "Every week, the launches Troya Gate blocked, the reason in plain words and what happened to them afterwards, next to the ones it passed. Every coin links to its proof, and the misses are included and counted. Built from Two Fates; what the price did, never a forecast.")),
    h("section", { class: "panel mn-box" }, weeksBox, head),
    h("section", { class: "panel mn-box" }, blockedBox),
    h("section", { class: "panel mn-box" }, passedBox),
    h("section", { class: "panel mn-box" }, rulesBox)));
  clear(head, h("p", { class: "fine" }, "Reading Two Fates…"));
  const start = ctx.parts?.[0] || ctx.query?.week || "";
  load(/^\d{4}-\d{2}-\d{2}$/.test(start) ? start : "");
  return () => { alive = false; };
}
