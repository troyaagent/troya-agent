// Troya Gate: paste any Robinhood Chain coin and see the seven checks, the same result the badge and Sentry use.
// gatePanel() is the Desk card; mount() is the full page at #/gate and #/gate/0x…
import { h, clear, icon, useCss, short, ago, tokenIcon, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXAMPLE = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";   // NVDA (Robinhood stock token)
const WORD = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "Not tested yet", error: "Unavailable" };
const NOTE = {
  passed: "Every check passed at this moment. A snapshot, never a safe stamp: a coin can change after a check.",
  caution: "It can be bought, but something needs a look first. Read the line in amber.",
  failed: "At least one check failed, so Troya will not offer a buy. Read the line in red.",
  untested: "There is no route to test yet, so nothing could be checked.",
};

/* ---------- The Assay (F14): dev, holders, bundles, clusters, wash trades, funders ---------- */
const pc = (x) => (x == null ? "–" : `${x < 0.1 && x > 0 ? x.toFixed(2) : x.toFixed(1)}%`);
function assayBox(addr, compact) {
  const box = h("section", { class: "dk-assay", "aria-live": "polite" },
    h("div", { class: "dk-assay-h" }, h("b", {}, "The Assay"), h("span", { class: "fine" }, "who is behind this coin")),
    h("div", { class: "dk-assay-b" }, h("span", { class: "ag-spin" }), h("span", { class: "fine" }, "Reading the coin's whole history and who funded its wallets…")));
  let tries = 0;
  const load = async () => {
    if (!box.isConnected && tries > 0) return;
    tries++;
    let d;
    try { d = await api.get(`/api/assay/${addr}`); } catch (e) { d = { status: "error", error: e.message }; }
    if (d.status === "running" && tries < 30) { setTimeout(load, 6000); return; }
    const body = box.querySelector(".dk-assay-b");
    if (d.status !== "done") { clear(body, h("span", { class: "fine" }, d.status === "running" ? "Still reading. Open the Gate again in a minute." : `The Assay could not run: ${d.error || "try again later"}.`)); return; }
    const flags = d.flags || [];
    const lines = [
      ["Dev", d.dev?.wallets?.length ? `holds ${pc(d.dev.holdsPct)} · sold ${pc(d.dev.soldPct)} of what it received${d.dev.liquidityAddedPct > 1 ? ` · put ${pc(d.dev.liquidityAddedPct)} into liquidity` : ""}` : "not identified"],
      ["Top 10 wallets", `${pc(d.holders?.top10Pct)} of supply${d.holders?.count != null ? ` · ${d.holders.count.toLocaleString("en-US")} holders` : ""}`],
      ["First 30 seconds", `${d.launch?.earlyBuyers ?? 0} buyers · still hold ${pc(d.launch?.earlyHoldPct)}`],
      ["Round-trip trading", d.wash?.trades ? `${pc(d.wash.washPct)} of ${d.wash.trades.toLocaleString("en-US")} trades` : "no trades yet"],
    ];
    const f = d.funding?.dev?.find((x) => x.funder || x.via);
    if (f) lines.push(["Dev funded by", f.funder ? short(f.funder) : `a contract call (${short(f.via)})`]);
    else if (d.funding) lines.push(["Dev funded by", "not found"]);
    clear(body,
      flags.length
        ? h("ul", { class: "dk-assay-flags" }, flags.map((x) => h("li", { class: `af-${x.level}` }, h("b", {}, x.title), h("span", {}, x.detail))))
        : h("p", { class: "dk-assay-clear" }, "No red or amber flags in what was measured. Not a safe stamp: it means nothing showed up."),
      compact ? null : h("dl", { class: "dk-assay-facts" }, lines.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      h("p", { class: "fine dk-assay-foot" }, `${(d.coverage?.transfers || 0).toLocaleString("en-US")} transfers read${d.coverage?.partial ? " (most recent only)" : " since launch"} · ${ago(d.at)}`));
  };
  setTimeout(load, 50);
  return box;
}

export function gatePanel({ go, ask, compact = false, start = "" } = {}) {
  const SITE = window.SITE || {};
  const input = h("input", { class: "input dk-gate-in", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "Search a coin (TROYA, NVDA…) or paste its address", "aria-label": "Coin name, ticker or address", maxlength: "80" });
  const inputBox = coinSuggest(input, (c) => { input.value = c.address; run(c.address); }, { majors: false });
  const runBtn = h("button", { class: "btn primary", type: "button" }, icon("shield"), "Run the Gate");
  const out = h("div", { class: "dk-gate-out", "aria-live": "polite" });
  let alive = true, seq = 0;

  async function run(raw, { example = false } = {}) {
    let m = ADDR.exec(String(raw || ""));
    if (!m && String(raw || "").trim()) {
      // a name or a ticker: take the top match (the real coin ranks first; copies are marked in the dropdown)
      const c = await findCoin(raw).catch(() => null);
      if (c?.address) m = [c.address];
      else { toast(`No Robinhood Chain coin matches "${String(raw).trim()}". Paste its address instead.`, "error"); input.focus(); return; }
    }
    if (!m) { input.focus(); return; }
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
    if (r?.checks) {
      const sum = r.checks.map((c) => `${c.label}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
      dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Gate result for ${r.symbol ? "$" + r.symbol : a} (${a}): ${r.verdict}. ${sum}` } }));
      if (!example && (r.verdict === "failed" || r.verdict === "caution")) dispatchEvent(new CustomEvent("troya:nudge", { detail: { key: `gate-${a}-${r.verdict}`, text: `${r.symbol ? "$" + r.symbol : "This coin"} ${r.verdict === "failed" ? "failed" : "needs a look at"} the Gate. Want me to explain?`, q: `Explain this Gate result for ${r.symbol ? "$" + r.symbol : a} in plain words: what failed or needs a look, and what it means for me.` } }));
    }
    if (r.verdict === "error" || !r.checks) {
      clear(out, h("div", { class: "dk-empty" }, h("b", {}, "The Gate could not read this coin right now."), h("p", {}, r.error || r.reason || "Try again in a minute."), h("button", { class: "btn sm", type: "button", onclick: () => run(a) }, icon("refresh"), "Try again")));
      return;
    }
    const failed = r.checks.filter((c) => c.status === "fail").length;
    const passed = r.checks.filter((c) => c.status === "pass").length;
    const unmeasured = r.checks.filter((c) => c.status === "skip").length, notes = r.checks.filter((c) => c.status === "warn").length;
    // "6 passed · 1 not measured" reads clearer than "6 of 7 passed" next to a Passed verdict
    const tally = [`${passed} passed`, failed ? `${failed} failed` : "", notes ? `${notes} to note` : "", unmeasured ? `${unmeasured} not measured` : ""].filter(Boolean).join(" · ");
    const total = r.checks.length || 7, frac = Math.max(0, Math.min(1, passed / total)), C = 2 * Math.PI * 50;
    const ringEl = h("span", { class: `dk-ring v-${r.verdict}`, role: "img", "aria-label": `${passed} of ${total} checks passed` });
    ringEl.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${C}"/></svg><b>${passed}/${total}</b>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const c = ringEl.querySelector(".rb"); if (c) c.style.strokeDasharray = `${frac * C} ${C}`; }));
    clear(out,
      h("div", { class: "dk-gate-h" },
        ringEl,
        tokenIcon({ symbol: r.symbol, address: a, chain: "robinhood" }, ""),
        h("div", { class: "dk-gate-id" },
          h("b", {}, r.symbol ? `$${r.symbol}` : short(a)), h("span", {}, [r.name, short(a)].filter(Boolean).join(" · "))),
        h("div", { class: "dk-gate-v" },
          h("span", { class: `dk-v v-${r.verdict}` }, WORD[r.verdict] || r.verdict),
          h("span", { class: "fine" }, `${tally}${r.checkedAt ? ` · ${ago(r.checkedAt)}` : ""}`))),
      example ? h("p", { class: "fine dk-gate-ex" }, "Live example: NVDA, a Robinhood stock token. Paste any coin above to check it.") : null,
      h("ol", { class: "dk-checks" }, r.checks.map((c) => h("li", { class: `c-${c.status}` },
        h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")),
        h("span", { class: "dk-ck-l" }, c.label),
        h("span", { class: "dk-ck-d" }, c.detail || "")))),
      r.curve && r.curve.progressPct != null ? h("div", { class: "dk-curve" }, h("span", {}, `Pons curve · ${Number(r.curve.raised || 0).toFixed(2)} ${r.curve.pair || "ETH"} raised`), h("div", { class: "dk-bar", style: { "--p": `${Math.min(100, r.curve.progressPct)}%` } }, h("i")), h("span", { class: "fine" }, `${r.curve.progressPct.toFixed(1)}% to graduation`)) : null,
      h("p", { class: `note dk-gate-note v-${r.verdict}` }, r.reason && r.verdict !== "passed" ? r.reason : NOTE[r.verdict] || ""),
      assayBox(a, compact),
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
    h("div", { class: "dk-gate-form" }, inputBox, runBtn),
    out);

  if (ADDR.test(start)) run(start);
  else run(EXAMPLE, { example: true });                 // the Desk's live example: a Robinhood stock token
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
