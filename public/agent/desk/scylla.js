// V10 F59 Scylla: Safe Crossing + F61 Pharos: Storm Watch (#/scylla). Every route Troya's bridge can hand you between
// Robinhood Chain and Base, Arbitrum or Ethereum, scored 0-100 from sourced facts with red lines; the storm-watch tab shows
// the on-chain settings Pharos reads every few minutes and every change it saw. Everything comes from GET /api/scylla,
// GET /api/scylla/routes and GET /api/pharos (server/scylla.mjs, server/pharos.mjs). Reading only: this page never asks a
// wallet to sign or send anything.
import { h, clear, toast, ago } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet } from "/agent/js/wallet.js";

const CHAINS = [["robinhood", "Robinhood Chain"], ["base", "Base"], ["arbitrum", "Arbitrum"], ["ethereum", "Ethereum"]];
const EXPLORER = { ethereum: "https://etherscan.io/address/", robinhood: "https://robinhoodchain.blockscout.com/address/" };
const CRIT = { verification: "How a crossing is verified", control: "Who can change or pause it", incidents: "Incidents", track: "Time in production", audits: "Audits" };
const short = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a || "") ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const when = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–");
const link = (href, text) => (/^https?:\/\//.test(href) ? h("a", { class: "link", href, target: "_blank", rel: "noopener" }, text || href.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)) : h("span", {}, href));

function css() {
  if (document.querySelector("style[data-scylla]")) return;
  document.head.append(h("style", { "data-scylla": "1" }, `
.sc-page { display: grid; gap: 16px; }
.sc-box { padding: 18px; }
.sc-box h3 { margin: 0 0 8px; font-size: 15px; }
.sc-tabs { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line-2); border-radius: 999px; }
.sc-tabs button { border: 0; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer; }
.sc-tabs button.on { background: var(--bg-3, var(--bg-2)); color: var(--fg); }
.sc-form { display: grid; grid-template-columns: 1fr auto 1fr 140px; gap: 10px; align-items: end; }
.sc-form label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.sc-form .sc-tok { grid-column: 1 / -1; }
.sc-form select, .sc-form input { width: 100%; }
.sc-flip { height: 38px; }
.sc-act { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.sc-banner { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--bg-2); border-left: 4px solid var(--muted); font-size: 13.5px; margin-bottom: 10px; }
.sc-banner.storm, .sc-banner.failed, .sc-banner.bad { border-left-color: var(--down); }
.sc-banner.watch, .sc-banner.caution, .sc-banner.warn { border-left-color: var(--warn); }
.sc-banner.calm, .sc-banner.passed, .sc-banner.ok { border-left-color: var(--up); }
.sc-banner ul { margin: 6px 0 0; padding-left: 18px; }
.sc-routes { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.sc-r { display: grid; grid-template-columns: 72px 1fr; gap: 14px; padding: 14px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--bg-2); }
.sc-score { display: grid; place-items: center; align-content: center; border-radius: 10px; border: 1px solid var(--line-3); padding: 8px 0; }
.sc-score b { font-size: 28px; line-height: 1; font-variant-numeric: tabular-nums; }
.sc-score small { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-top: 4px; }
.sc-score.green b { color: var(--up); } .sc-score.amber b { color: var(--warn); } .sc-score.red b { color: var(--down); }
.sc-score.green { border-color: var(--up); } .sc-score.amber { border-color: var(--warn); } .sc-score.red { border-color: var(--down); }
.sc-r h4 { margin: 0; font-size: 15px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sc-tag { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; color: var(--muted); font-weight: 500; }
.sc-tag.troya { color: var(--fg); border-color: var(--fg); }
.sc-meta { font-size: 12.5px; color: var(--muted); margin: 4px 0 0; }
.sc-lines { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
.sc-lines li { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: baseline; }
.sc-l { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
.sc-l.red { color: var(--down); border-color: var(--down); } .sc-l.warn { color: var(--warn); border-color: var(--warn); }
.sc-comp { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sc-comp span { font-size: 12px; border: 1px solid var(--line-2); border-radius: 8px; padding: 2px 8px; }
.sc-sig { margin-top: 12px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.sc-sheet { border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; background: var(--bg-2); }
.sc-sheet + .sc-sheet { margin-top: 10px; }
.sc-sheet header { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.sc-sheet header b { font-size: 15px; }
.sc-parts { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
.sc-parts td { border-top: 1px solid var(--line-2); padding: 6px 6px 6px 0; vertical-align: top; }
.sc-parts td:first-child { white-space: nowrap; color: var(--muted); width: 1%; }
.sc-parts td.pts { white-space: nowrap; font-variant-numeric: tabular-nums; width: 1%; }
.sc-src { display: block; margin-top: 3px; font-size: 11.5px; color: var(--faint); overflow-wrap: anywhere; }
.sc-src a { margin-right: 8px; }
.sc-w { width: 100%; border-collapse: collapse; font-size: 13px; }
.sc-w td, .sc-w th { text-align: left; padding: 5px 8px 5px 0; border-top: 1px solid var(--line-2); vertical-align: top; }
.sc-w th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); font-weight: 500; }
.sc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.sc-stats div { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); }
.sc-stats small { display: block; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.sc-stats b { font-size: 18px; font-weight: 600; }
.sc-item { border-top: 1px solid var(--line-2); padding: 10px 0; }
.sc-item header { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; font-size: 13.5px; }
.sc-item dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0 0; font-size: 12.5px; }
.sc-item dt { color: var(--muted); } .sc-item dd { margin: 0; overflow-wrap: anywhere; }
.sc-item dd .chg { color: var(--warn); margin-left: 6px; }
.sc-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.sc-log li { padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--bg-2); overflow-wrap: anywhere; }
.sc-log li.high { border-left: 3px solid var(--down); } .sc-log li.medium { border-left: 3px solid var(--warn); }
.sc-grp { margin: 14px 0 0; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.sc-pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--line-2); margin: 8px 0 0; }
@media (max-width: 720px) { .sc-form { grid-template-columns: 1fr 1fr; } .sc-flip { display: none; } .sc-form label.sc-amt { grid-column: 1 / -1; } .sc-stats { grid-template-columns: 1fr 1fr; } .sc-r { grid-template-columns: 1fr; } .sc-score { grid-auto-flow: column; justify-content: start; gap: 8px; padding: 6px 10px; } }`));
}

const sources = (list) => (list?.length ? h("span", { class: "sc-src" }, "Source: ", list.map((s) => link(s))) : h("span", { class: "sc-src" }, "No source: counted as unknown."));
function sheet(s) {
  return h("div", { class: "sc-sheet" },
    h("header", {}, h("b", {}, s.name), h("span", { class: `sc-score ${s.redLines?.length || s.score < 40 ? "red" : s.score < 70 ? "amber" : "green"}`, style: { padding: "2px 10px", display: "inline-block" } }, h("b", { style: { fontSize: "18px" } }, String(s.score)))),
    s.redLines?.length ? h("ul", { class: "sc-lines" }, s.redLines.map((r) => h("li", {}, h("span", { class: "sc-l red" }, "Red line"), h("span", {}, `${r.text} Caps the score at ${r.cap}.`)))) : null,
    h("table", { class: "sc-parts" }, h("tbody", {}, s.parts.map((p) => h("tr", {},
      h("td", {}, CRIT[p.criterion] || p.criterion),
      h("td", { class: "pts" }, `${p.points} / ${p.weight}`),
      h("td", {}, h("span", {}, p.text || "Not confirmed."), p.confidence === "partial" ? h("span", { class: "sc-tag", style: { marginLeft: "6px" } }, "partly confirmed") : null, sources(p.sources)))))),
    s.kind === "router" ? h("p", { class: "fine", style: { margin: "6px 0 0" } }, "A router, not a bridge: scored without the verification line and scaled to 100.") : null);
}

export async function mount(view) {
  css();
  let alive = true, tab = "routes", info = null;
  const sel = (v) => h("select", { class: "input" }, CHAINS.map(([k, n]) => h("option", { value: k, selected: k === v ? "selected" : null }, n)));
  const from = sel("base"), to = sel("robinhood");
  const amount = h("input", { class: "input", value: "0.1", inputmode: "decimal", autocomplete: "off" });
  const token = h("input", { class: "input", placeholder: "Optional: 0x… a coin bought when you arrive (Robinhood Chain, Base or Arbitrum)", spellcheck: "false", autocomplete: "off" });
  const flip = h("button", { class: "btn sc-flip", type: "button", title: "Swap direction", "aria-label": "Swap direction" }, "⇄");
  flip.addEventListener("click", () => { const a = from.value; from.value = to.value; to.value = a; });
  const go = h("button", { class: "btn primary", type: "button" }, "Score the routes");
  const res = h("div", { "aria-live": "polite" });
  const routesPane = h("div", { class: "sc-page" },
    h("section", { class: "panel sc-box" },
      h("div", { class: "sc-form" }, h("label", {}, "From", from), flip, h("label", {}, "To", to), h("label", { class: "sc-amt" }, "Amount (ETH)", amount), h("label", { class: "sc-tok" }, "Coin at the end", token)),
      h("div", { class: "sc-act" }, go, h("span", { class: "fine" }, "One side is always Robinhood Chain, as on Troya's bridge. Quotes only: nothing is signed or sent."))),
    h("section", { class: "panel sc-box" }, res));
  const stormPane = h("div", { class: "sc-page", hidden: true });
  const rubricPane = h("div", { class: "sc-page", hidden: true });
  const tabs = [["routes", "Routes", routesPane], ["storm", "Storm watch", stormPane], ["rubric", "Rubric and facts", rubricPane]];
  const tabBtns = tabs.map(([k, label]) => { const b = h("button", { type: "button", class: k === tab ? "on" : null }, label); b.addEventListener("click", () => setTab(k)); return b; });
  function setTab(k) {
    tab = k; tabs.forEach(([kk, , pane], i) => { pane.hidden = kk !== k; tabBtns[i].classList.toggle("on", kk === k); });
    if (k === "storm") loadStorm(); if (k === "rubric") loadRubric();
  }

  function paint(o) {
    const st = o.storm || {};
    const banner = (cls, title, list) => h("div", { class: `sc-banner ${cls}` }, h("b", {}, title), list?.length ? h("ul", {}, list.map((x) => h("li", {}, x))) : null);
    clear(res,
      h("h3", {}, `${o.from.name} to ${o.to.name}, ${o.amountEth} ETH${o.token ? `, buying $${o.token.symbol || short(o.token.address)}` : ""}`),
      banner(st.level || "unknown", st.level === "storm" ? "Storm watch: a key setting on this route changed in the last 24 hours, or the chain looks unhealthy." : st.level === "watch" ? "Storm watch: a setting on this route changed in the last 7 days." : st.level === "calm" ? "Storm watch: no change on this route's watched settings in the last 7 days." : "Storm watch has no reading yet.", st.warnings),
      o.gate ? banner(o.gate.verdict, `Troya Gate on $${o.token?.symbol || "the coin"} on ${o.to.name}: ${o.gate.verdict} (${o.gate.passed} of ${o.gate.total} checks)`, o.gate.why ? [o.gate.why] : []) : null,
      o.arrivalNotes?.length ? banner("warn", "On arrival", o.arrivalNotes) : null,
      o.primaryNote ? h("p", { class: "fine" }, o.primaryNote) : null,
      o.listNote ? h("p", { class: "fine" }, `LI.FI's other routes could not be read: ${o.listNote}`) : null,
      o.routes.length ? h("ul", { class: "sc-routes" }, o.routes.map((r) => h("li", { class: "sc-r" },
        h("div", { class: `sc-score ${r.band}` }, h("b", {}, String(r.score)), h("small", {}, r.band === "green" ? "stronger" : r.band === "amber" ? "mixed" : "weak")),
        h("div", {},
          h("h4", {}, r.tools.join(" + "), r.source === "troya" ? h("span", { class: "sc-tag troya" }, "Troya's route") : null, r.tags.filter((t) => t !== "Troya's route").map((t) => h("span", { class: "sc-tag" }, String(t).toLowerCase()))),
          h("p", { class: "sc-meta" }, [
            `Weakest layer: ${r.weakest}`,
            r.valueLostPct != null ? `value lost in the quote ${r.valueLostPct}%` : null,
            r.seconds ? `about ${r.seconds < 90 ? r.seconds + " s" : Math.round(r.seconds / 60) + " min"}` : null,
            r.swaps?.length ? `then a swap: ${r.swaps.join(", ")}` : null,
          ].filter(Boolean).join(" · ")),
          (r.redLines.length || r.warnings.length) ? h("ul", { class: "sc-lines" },
            r.redLines.map((x) => h("li", {}, h("span", { class: "sc-l red" }, "Red line"), h("span", {}, `${x.text} (${x.from}; caps at ${x.cap})`))),
            r.warnings.map((x) => h("li", {}, h("span", { class: "sc-l warn" }, "Careful"), h("span", {}, x)))) : null,
          h("div", { class: "sc-comp" }, r.components.map((c) => h("span", {}, `${c.name} ${c.score}${c.known ? "" : " (no facts)"}`))))))) : h("p", { class: "fine" }, "No route came back for this crossing right now."),
      o.chain ? h("div", { class: "sc-banner", style: { marginTop: "12px" } }, h("b", {}, `${o.chain.name}: ${o.chain.score} / 100`), h("p", { class: "fine", style: { margin: "4px 0 0" } }, o.chain.note), h("p", { class: "fine", style: { margin: "4px 0 0" } }, o.chain.canonicalBridge)) : null,
      o.receipt ? h("div", { class: "sc-sig" }, "Crossing receipt, signed by the Troya attestor ", h("span", { class: "mono" }, o.receipt.attestor), h("br"), "hash ", h("span", { class: "mono" }, o.receipt.hash), h("br"), "Verify: EIP-191 over \"Troya Scylla\" + newline + hash.") : null,
      h("p", { class: "fine", style: { marginTop: "10px" } }, o.limit));
  }
  go.addEventListener("click", async () => {
    if (from.value === to.value) { toast("Pick two different chains.", "error", 4000); return; }
    if (from.value !== "robinhood" && to.value !== "robinhood") { toast("One side must be Robinhood Chain.", "error", 4000); return; }
    const t = token.value.trim();
    if (t && !/^0x[0-9a-fA-F]{40}$/.test(t)) { toast("The coin must be a 0x address.", "error", 4000); return; }
    const qs = new URLSearchParams({ from: from.value, to: to.value, amount: amount.value.trim() || "0.1" });
    if (t) qs.set("token", t);
    if (wallet.address) qs.set("address", wallet.address);
    go.disabled = true; clear(res, h("p", { class: "fine" }, "Reading every route, the bridges' facts, storm watch" + (t ? " and the Gate on the coin" : "") + "…"));
    try { const o = await api.get(`/api/scylla/routes?${qs}`); if (alive) paint(o); }
    catch (e) { if (alive) clear(res, h("div", { class: "alert error" }, e.message || String(e))); }
    finally { go.disabled = false; }
  });

  async function loadStorm() {
    clear(stormPane, h("section", { class: "panel sc-box" }, h("p", { class: "fine" }, "Reading storm watch…")));
    let d; try { d = await api.get("/api/pharos"); } catch (e) { if (alive) clear(stormPane, h("section", { class: "panel sc-box" }, h("div", { class: "alert error" }, e.message))); return; }
    if (!alive) return;
    const hl = d.health;
    const groups = [...new Set(d.items.map((i) => i.groupLabel))];
    clear(stormPane,
      h("section", { class: "panel sc-box" }, h("h3", {}, "Robinhood Chain health"),
        hl ? h("div", {}, h("div", { class: `sc-banner ${hl.status}` }, h("b", {}, hl.status === "ok" ? "Calm" : hl.status === "warn" ? "Watch" : hl.status === "bad" ? "Storm" : "Unknown"), h("ul", {}, hl.reasons.map((x) => h("li", {}, x)))),
          h("div", { class: "sc-stats" }, [["Latest block age", hl.ageSec != null ? `${hl.ageSec} s` : "–"], ["Blocks a second", hl.blocksPerSec ?? "next reading"], ["Behind Ethereum", hl.l1LagBlocks != null ? `${hl.l1LagBlocks} blocks` : "–"], ["Last new batch", hl.batchQuietMin == null ? "next reading" : `${hl.batchQuietMin} min ago`]].map(([k, v]) => h("div", {}, h("small", {}, k), h("b", {}, String(v))))))
          : h("p", { class: "fine" }, "No reading yet: the first one is taken a minute and a half after the server starts."),
        h("p", { class: "fine", style: { marginTop: "10px" } }, `Read every ${d.every}. Last reading ${d.lastRun ? when(d.lastRun) + ` (${ago(d.lastRun)} ago)` : "not yet"}; watching since ${when(d.firstRun)}. Automatic alerts: ${d.alerts}.`)),
      h("section", { class: "panel sc-box" }, h("h3", {}, "Changes seen"),
        d.changes.length ? h("ul", { class: "sc-log" }, d.changes.map((c) => h("li", { class: c.severity }, h("b", {}, `${c.label}: ${c.field}`), ` ${c.fromText} → ${c.toText}`, h("br"), h("span", { class: "fine" }, `${when(c.at)} · ${c.chain === "ethereum" ? "Ethereum" : "Robinhood Chain"} · ${short(c.address)}`))))
          : h("p", { class: "fine" }, "No setting has changed since Pharos started watching."),
        d.activity.length ? [h("p", { class: "sc-grp" }, "Multisig activity"), h("ul", { class: "sc-log" }, d.activity.map((a) => h("li", {}, a.text, h("br"), h("span", { class: "fine" }, when(a.at)))))] : null),
      h("section", { class: "panel sc-box" }, h("h3", {}, "What Pharos reads"),
        groups.map((g) => [h("p", { class: "sc-grp" }, g), d.items.filter((i) => i.groupLabel === g).map((i) => h("div", { class: "sc-item" },
          h("header", {}, h("b", {}, i.label), h("span", { class: "fine" }, i.chain === "ethereum" ? "Ethereum " : "Robinhood Chain ", h("a", { class: "link mono", href: (EXPLORER[i.chain] || "") + i.address, target: "_blank", rel: "noopener" }, short(i.address)))),
          h("dl", {}, i.fields.map((f) => [h("dt", {}, f.label), h("dd", {}, f.error ? h("span", { class: "fine" }, "could not be read this time") : f.text, f.lastChange ? h("span", { class: "chg" }, `changed ${when(f.lastChange)}`) : null)]))))]),
        h("p", { class: "fine", style: { marginTop: "10px" } }, d.limits), h("p", { class: "fine" }, "Addresses: ", d.sources.map((s) => link(s)))));
  }

  async function loadRubric() {
    if (!info) { clear(rubricPane, h("section", { class: "panel sc-box" }, h("p", { class: "fine" }, "Reading the rubric…"))); try { info = await api.get("/api/scylla"); } catch (e) { if (alive) clear(rubricPane, h("section", { class: "panel sc-box" }, h("div", { class: "alert error" }, e.message))); return; } }
    if (!alive) return;
    clear(rubricPane,
      h("section", { class: "panel sc-box" }, h("h3", {}, "How a route is scored"), h("p", { class: "fine" }, info.scoring),
        h("table", { class: "sc-w" }, h("thead", {}, h("tr", {}, h("th", {}, "Criterion"), h("th", {}, "Weight"), h("th", {}, "Categories (points)"))),
          h("tbody", {}, Object.entries(info.weights).map(([k, w]) => h("tr", {}, h("td", {}, CRIT[k] || k), h("td", {}, String(w)), h("td", {}, info.categories[k].map((c) => `${c.text} (${c.points})`).join(" · ")))))),
        h("h3", { style: { marginTop: "14px" } }, "Red lines"),
        h("ul", { class: "sc-lines" }, info.redLines.map((r) => h("li", {}, h("span", { class: "sc-l red" }, `cap ${r.cap}`), h("span", {}, r.text))))),
      h("section", { class: "panel sc-box" }, h("h3", {}, `The fact table (checked ${info.checked})`), info.bridges.map(sheet)),
      h("section", { class: "panel sc-box" }, h("h3", {}, "The chain itself"), sheet(info.chain), h("p", { class: "fine", style: { marginTop: "8px" } }, info.chain.facts?.canonicalBridge || "")),
      h("section", { class: "panel sc-box" }, h("h3", {}, "For wallets and agents"), h("p", { class: "fine" }, info.how),
        h("pre", { class: "sc-pre" }, "curl 'https://troya.codes/api/scylla/routes?from=base&to=robinhood&amount=0.1'"), h("p", { class: "fine", style: { marginTop: "8px" } }, info.limit)));
  }

  clear(view, h("div", { class: "dk sc-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Scylla and Pharos · V10 Poseidon"),
      h("h1", {}, "Cross with your ", h("em", {}, "eyes"), " open."),
      h("p", { class: "dk-sub" }, "Every route Troya's bridge can hand you between Robinhood Chain and Base, Arbitrum or Ethereum, scored 0 to 100 from sourced facts: how the crossing is verified, who can change or pause it, how long it has run, its incidents and audits. Red lines cap the score. Storm watch reads the chain's own bridge settings every few minutes and shows every change.")),
    h("div", {}, h("div", { class: "sc-tabs", role: "tablist" }, tabBtns)),
    routesPane, stormPane, rubricPane));
  return () => { alive = false; };
}
