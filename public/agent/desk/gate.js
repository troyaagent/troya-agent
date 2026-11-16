// Troya Gate: paste any Robinhood Chain coin and see the seven checks, the same result the badge and Sentry use.
// gatePanel() is the Desk card; mount() is the full page at #/gate and #/gate/0x…
import { h, clear, icon, useCss, short, ago, tokenIcon, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const WORD = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "Not tested yet", error: "Unavailable" };
const NOTE = {
  passed: "Every check passed at this moment. A snapshot, never a safe stamp: a coin can change after a check.",
  caution: "It can be bought, but something needs a look first. Read the line in amber.",
  failed: "At least one check failed, so Troya will not offer a buy. Read the line in red.",
  untested: "There is no route to test yet, so nothing could be checked.",
};

export function gatePanel({ go, ask, compact = false, start = "" } = {}) {
  const SITE = window.SITE || {};
  const input = h("input", { class: "input dk-gate-in", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "Paste a Robinhood Chain coin address, 0x…", "aria-label": "Coin address", maxlength: "80" });
  const runBtn = h("button", { class: "btn primary", type: "button" }, icon("shield"), "Run the Gate");
  const out = h("div", { class: "dk-gate-out", "aria-live": "polite" });
  let alive = true, seq = 0;

  async function run(raw, { example = false } = {}) {
    const m = ADDR.exec(String(raw || ""));
    if (!m) { if (raw) toast("Paste a full coin address (0x and 40 characters).", "error"); input.focus(); return; }
    const a = m[0], id = ++seq;
    if (!example) input.value = a;
    runBtn.disabled = true;
    clear(out, h("div", { class: "dk-gate-wait" }, h("span", { class: "ag-spin" }), h("span", {}, "Reading the route, the pool, fees and a test sell…")));
    let r;
    try { r = await api.get(`/api/badge/${a}`); } catch (e) { r = { verdict: "error", error: e.message }; }
    if (!alive || id !== seq) return;
    runBtn.disabled = false;
    if (!compact && !example && location.hash !== `#/gate/${a}`) history.replaceState(null, "", `#/gate/${a}`);
    render(a, r, example);
  }

  function render(a, r, example) {
    if (r.verdict === "error" || !r.checks) {
      clear(out, h("div", { class: "dk-empty" }, h("b", {}, "The Gate could not read this coin right now."), h("p", {}, r.error || r.reason || "Try again in a minute."), h("button", { class: "btn sm", type: "button", onclick: () => run(a) }, icon("refresh"), "Try again")));
      return;
    }
    const failed = r.checks.filter((c) => c.status === "fail").length;
    const passed = r.checks.filter((c) => c.status === "pass").length;
    clear(out,
      h("div", { class: "dk-gate-h" },
        tokenIcon({ symbol: r.symbol, address: a }, ""),
        h("div", { class: "dk-gate-id" },
          h("b", {}, r.symbol ? `$${r.symbol}` : short(a)), h("span", {}, [r.name, short(a)].filter(Boolean).join(" · "))),
        h("div", { class: "dk-gate-v" },
          h("span", { class: `dk-v v-${r.verdict}` }, WORD[r.verdict] || r.verdict),
          h("span", { class: "fine" }, `${passed} of ${r.checks.length} passed${r.checkedAt ? ` · ${ago(r.checkedAt)}` : ""}`))),
      example ? h("p", { class: "fine dk-gate-ex" }, "Live example: the $TROYA token. Paste any coin above to check it.") : null,
      h("ol", { class: "dk-checks" }, r.checks.map((c) => h("li", { class: `c-${c.status}` },
        h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")),
        h("span", { class: "dk-ck-l" }, c.label),
        h("span", { class: "dk-ck-d" }, c.detail || "")))),
      r.curve && r.curve.progressPct != null ? h("div", { class: "dk-curve" }, h("span", {}, `Pons curve · ${Number(r.curve.raised || 0).toFixed(2)} ${r.curve.pair || "ETH"} raised`), h("div", { class: "dk-bar", style: { "--p": `${Math.min(100, r.curve.progressPct)}%` } }, h("i")), h("span", { class: "fine" }, `${r.curve.progressPct.toFixed(1)}% to graduation`)) : null,
      h("p", { class: `note dk-gate-note v-${r.verdict}` }, r.reason && r.verdict !== "passed" ? r.reason : NOTE[r.verdict] || ""),
      h("div", { class: "dk-gate-a" },
        failed ? null : h("a", { class: "btn primary sm", href: `#/swap?out=${a}` }, icon("swap"), "Swap"),
        h("a", { class: "btn sm", href: `#/token/${a}` }, "Token page"),
        ask ? h("button", { class: "btn sm", type: "button", onclick: () => ask(`Is this token safe? ${a}`) }, icon("spark"), "Ask Troya") : null,
        h("a", { class: "btn sm ghost", href: `/badge?ca=${a}`, target: "_blank", rel: "noopener" }, "Get the badge")));
  }

  runBtn.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  input.addEventListener("paste", () => setTimeout(() => { if (ADDR.test(input.value)) run(input.value); }, 0));

  const el = h("section", { class: `panel dk-gate ${compact ? "compact" : ""}` },
    h("div", { class: "panel-h" }, h("h2", {}, "Troya Gate"), compact ? h("a", { class: "link fine", href: "#/gate" }, "Open the Gate") : h("a", { class: "link fine", href: "/risk-controls" }, "How the checks work")),
    h("p", { class: "dk-gate-sub" }, "Seven checks before you can buy: route, price impact, depth, fees and taxes, a simulation, a test sell and transfer tax. Fail one, no order."),
    h("div", { class: "dk-gate-form" }, input, runBtn),
    out);

  if (ADDR.test(start)) run(start);
  else if (SITE.ca) run(SITE.ca, { example: true });
  else clear(out, h("p", { class: "muted" }, "Paste a coin to see its seven checks."));
  return { el, run, stop: () => { alive = false; } };
}

export async function mount(view, ctx) {
  useCss("home");
  const g = gatePanel({ go: ctx.go, ask: ctx.ask, start: ctx.parts[0] || ctx.query.ca || "" });
  const how = [
    ["Route", "There is a real path from ETH to the coin: a Pons curve or a Uniswap pool."],
    ["Price impact", "How far your own buy moves the price at the size you typed."],
    ["Pool depth", "How much ETH sits behind the price, so you can get back out."],
    ["Fees and taxes", "Every fee on the way in, named and counted."],
    ["Simulation", "The exact swap is run against the pool as it is now."],
    ["Test sell", "Selling back is simulated too, so a coin that cannot be sold is caught."],
    ["Transfer tax", "A token that skims transfers shows up here."],
  ];
  clear(view, h("div", { class: "dk dk-gatepage" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Gate a coin"),
      h("h1", {}, h("em", {}, "Every coin,"), " opened at the gate."),
      h("p", { class: "dk-sub" }, "The same checks run again when you press Confirm in Swap, in the agent's tickets and in Telegram. Sentry runs them on every new launch.")),
    h("div", { class: "dk-row r75" }, g.el,
      h("section", { class: "panel dk-how" }, h("div", { class: "panel-h" }, h("h2", {}, "What each check reads")),
        h("ol", {}, how.map(([t, d], i) => h("li", {}, h("span", { class: "dk-how-n" }, String(i + 1)), h("div", {}, h("b", {}, t), h("p", {}, d))))),
        h("p", { class: "note" }, "Results are checks, never endorsements. ", h("a", { class: "link", href: "/risk-controls" }, "Risk controls"), " · ", h("a", { class: "link", href: "/badge" }, "Gate badge for your site"))))));
  return () => g.stop();
}
