// V9 F47 Heel (#/heel and #/heel/<address>): paste a coin, a dev wallet or an agent; Troya names its one weak spot in a
// sentence, with up to three facts that each link to their proof on Blockscout, a confidence label and one Guard button.
// The answer comes from GET /api/heel/:address (server/heel.mjs); this page only shows it.
import { h, clear, icon, short, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, signIn, openConnect } from "/agent/js/wallet.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const KIND = { coin: "Coin", dev: "Dev wallet", agent: "Agent", unknown: "Wallet" };
const SEV = { critical: ["Critical", "v-failed"], high: ["High", "v-failed"], medium: ["Medium", "v-caution"], low: ["Low", "v-quiet"], none: ["No weak spot found", "v-passed"] };
const EVTYPE = { tx: "Transaction", contract: "Contract code", eth_call: "Simulation (eth_call)", logs: "Transfer logs", block: "Block", address: "Address" };
const STATUS = { done: "read", running: "still reading", failed: "could not be read", "n/a": "not applicable" };
const SAMPLES = [["$TROYA", "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"]];

export function heelCss() {
  if (document.querySelector("link[data-heel-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/heel.css", "data-heel-css": "1" }));
}
const refText = (e) => (e.type === "block" ? `#${Number(e.ref).toLocaleString("en-US")}` : /^0x[0-9a-fA-F]{64}$/.test(e.ref) || /^0x[0-9a-fA-F]{40}$/.test(e.ref) ? short(e.ref, 6) : e.ref);

function evidenceEl(e) {
  if (!e) return null;
  const url = /^https:\/\/robinhoodchain\.blockscout\.com\//.test(e.url || "") ? e.url : null;
  return h("div", { class: "hl-ev" },
    h("span", { class: "hl-ev-t" }, EVTYPE[e.type] || e.type),
    url ? h("a", { class: "link mono", href: url, target: "_blank", rel: "noopener", title: e.ref }, refText(e), h("span", { class: "hl-ev-out" }, " on Blockscout")) : h("span", { class: "mono" }, refText(e)),
    e.note ? h("span", { class: "hl-ev-n" }, e.note) : null);
}

function passportEl(p, kind) {
  if (!p) return null;
  const L = p.launches, f = p.funding;
  const cell = (k, v, sub) => h("div", { class: "hl-pp-c" }, h("span", {}, k), h("b", {}, v), sub ? h("small", {}, sub) : null);
  const funded = !f ? "not found" : f.funder ? short(f.funder) : f.how === "contract" ? `a contract (${short(f.via)})` : "not found";
  return h("section", { class: "panel hl-pp" },
    h("div", { class: "panel-h" }, h("h2", {}, kind === "coin" ? "Its dev's passport" : "Dev passport"), h("a", { class: "link fine mono", href: `${EXPLORER}/address/${p.wallet}`, target: "_blank", rel: "noopener" }, short(p.wallet, 6))),
    h("div", { class: "hl-pp-grid" },
      cell(kind === "coin" ? "Earlier Pons launches" : "Pons launches", L ? String(L.total) : "not read", L?.more ? `newest ${L.read} read` : null),
      cell("Dev sold its buy within 6 h", L ? `${L.outWithin6h} of ${L.read}` : "–", L ? `${L.outWithin1h} within 1 h${L.outWithin6hSmallBuy ? ` · ${L.outWithin6hSmallBuy} a buy under 1% of supply` : ""}` : null),
      cell("Sold out on day one, after 6 h", L ? String(L.soldDay1After6h) : "–"),
      cell("Graduated", L ? `${L.graduated} of ${L.read}` : "–"),
      cell("First ETH from", funded, f?.funderLaunches ? `${f.funderLaunches.total} launch${f.funderLaunches.total === 1 ? "" : "es"} of its own, ${f.funderLaunches.soldOutDay1} sold out on day one` : null),
      cell("Wallet age", p.age?.days != null ? `${p.age.days} days` : "unknown", p.age?.transactions != null ? `${p.age.transactions} transactions` : null)),
    f?.tx ? h("p", { class: "fine hl-pp-n" }, "First funding: ", h("a", { class: "link mono", href: `${EXPLORER}/tx/${f.tx}`, target: "_blank", rel: "noopener" }, short(f.tx, 6))) : null,
    p.thisCoin ? h("p", { class: "fine hl-pp-n" }, `On this coin the dev got ${p.thisCoin.devGotPct ?? "?"}% of the supply${p.thisCoin.outAfterHours != null ? ` and was 80% out ${p.thisCoin.outAfterHours} h after launch` : p.thisCoin.status === "no-buy" ? " (no buy)" : ", still holding most of it in its first day"}.`) : null,
    p.latestCoin ? h("p", { class: "fine hl-pp-n" }, `Newest coin ${short(p.latestCoin.token)}: ${p.latestCoin.text}`) : null,
    L?.coins?.length ? h("ul", { class: "hl-pp-coins" }, L.coins.slice(0, 8).map((c) => h("li", {},
      h("a", { class: "link mono", href: `#/heel/${c.token}` }, short(c.token)),
      c.devGotPct != null && c.status !== "no-buy" ? h("span", { class: "fine" }, `dev got ${c.devGotPct}%`) : null,
      h("span", {}, c.status === "no-buy" ? "dev did not buy" : c.status === "held" ? "dev held" : c.status === "burned" ? "dev burned its buy" : c.outAfterHours != null ? `dev out after ${c.outAfterHours} h` : c.status),
      c.graduated ? h("span", { class: "hl-tag" }, "graduated") : null,
      c.outTx ? h("a", { class: "link fine", href: `${EXPLORER}/tx/${c.outTx}`, target: "_blank", rel: "noopener" }, "tx") : null))) : null,
    p.notes?.length ? h("p", { class: "fine hl-pp-n" }, p.notes.join(" · ")) : null,
    L?.rule ? h("p", { class: "fine hl-pp-n" }, `How it is counted: ${L.rule}.`) : null);
}

function guardBtn(g, A) {
  if (!g) return null;
  const btn = h("button", { class: "btn primary", type: "button" }, icon("shield"), g.label);
  btn.addEventListener("click", async () => {
    const a = g.action;
    if (!a) { location.hash = g.href; return; }
    btn.disabled = true;
    try {
      if (!wallet.session) {
        if (!wallet.address) { openConnect(); toast("Connect and sign in, then press Guard again.", "", 4500); return; }
        await signIn();
      }
      const r = await api.post(a.path, a.body);
      toast(a.kind === "watchfire-pin" ? "Pinned. Watchfire is watching it." : r?.note || "Saved. You are watching this wallet.", "ok", 5000);
    } catch (e) {
      toast(e.message || String(e), "error", 5000);
      if (g.alt?.href && a.kind === "watchfire-pin") location.hash = g.alt.href;
    } finally { btn.disabled = false; }
  });
  return btn;
}

export async function mount(view, ctx) {
  heelCss();
  const input = h("input", { class: "input hl-in", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "80", placeholder: "Paste a coin, a dev wallet or an agent address", "aria-label": "Coin, dev wallet or agent address" });
  const box = coinSuggest(input, (c) => { input.value = c.address; run(c.address); }, { majors: false });
  const go = h("button", { class: "btn primary", type: "button" }, icon("search"), "Find the heel");
  const out = h("div", { class: "hl-out", "aria-live": "polite" });
  let alive = true, seq = 0, timer = 0;

  async function run(raw, { again = 0 } = {}) {
    clearTimeout(timer);
    const text = String(raw || "").trim();
    let a = ADDR.exec(text)?.[0];
    if (!a && text) { const c = await findCoin(text).catch(() => null); if (c?.address && ADDR.test(c.address)) a = c.address; }
    if (!a) { toast("Paste a Robinhood Chain address (0x…), or a coin's ticker.", "error"); input.focus(); return; }
    const id = ++seq;
    input.value = a;
    if (location.hash !== `#/heel/${a}`) history.replaceState(null, "", `#/heel/${a}`);
    if (!again) clear(out, h("div", { class: "hl-wait" }, h("span", { class: "hl-spin" }), h("span", {}, "Reading the chain: the Gate, holders, launch, side wallets, funding, the dev's past launches…")));
    go.disabled = true;
    let r;
    try { r = await api.get(`/api/heel/${a}`); }
    catch (e) { if (!alive || id !== seq) return; go.disabled = false; clear(out, h("div", { class: "dk-empty" }, h("b", {}, "Heel could not read this address right now."), h("p", {}, e.message), h("button", { class: "btn sm", type: "button", onclick: () => run(a) }, icon("refresh"), "Try again"))); return; }
    if (!alive || id !== seq) return;
    go.disabled = false;
    render(a, r);
    // a source still reading: the server keeps reading in the background, so ask again a few times
    if (r.partial && again < 8) timer = setTimeout(() => { if (alive && id === seq) run(a, { again: again + 1 }); }, 12_000);
  }

  function render(a, r) {
    const [sevText, sevCls] = SEV[r.severity] || SEV.none;
    const name = r.coin?.symbol ? `$${r.coin.symbol}` : short(a, 6);
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Heel for ${name} (${a}), a ${KIND[r.kind] || r.kind}: ${r.heel} Severity ${r.severity}, confidence ${r.confidence}. Facts: ${r.facts.map((f) => f.text).join(" ")}` } }));
    clear(out,
      h("div", { class: "hl-id" },
        h("span", { class: "hl-kind" }, KIND[r.kind] || r.kind),
        h("b", {}, name),
        h("a", { class: "link fine mono", href: `${EXPLORER}/${r.kind === "coin" ? "token" : "address"}/${a}`, target: "_blank", rel: "noopener" }, short(a, 6)),
        h("span", { class: `dk-v ${sevCls}` }, sevText),
        h("span", { class: "hl-conf" }, `Confidence: ${r.confidence}`)),
      h("p", { class: `hl-sentence s-${r.severity}` }, r.heel),
      r.facts?.length ? h("ol", { class: "hl-facts" }, r.facts.map((f) => h("li", { class: `hl-f s-${f.severity || "none"}` },
        h("div", { class: "hl-f-t" }, h("span", {}, f.text), h("span", { class: "hl-f-c" }, `${f.source ? `${f.source} · ` : ""}confidence ${f.confidence}`)),
        evidenceEl(f.evidence)))) : null,
      r.more ? h("p", { class: "fine" }, `${r.more} more finding${r.more === 1 ? "" : "s"} below these three, less severe.`) : null,
      h("div", { class: "dk-gate-a hl-guard" },
        guardBtn(r.guard, a),
        r.guard?.alt ? h("a", { class: "btn", href: r.guard.alt.href }, icon("shield"), r.guard.alt.label) : null,
        r.kind === "coin" ? h("a", { class: "btn sm", href: `#/token/${a}` }, "Token page") : null,
        r.kind === "coin" ? h("a", { class: "btn sm", href: `#/clusters/${a}`, title: "Its largest holders as bubbles, and which wallets are linked, with the transactions behind each link" }, "Cluster map") : null,
        ctx.ask ? h("button", { class: "btn sm", type: "button", onclick: () => ctx.ask(`Explain this Heel in plain words, and what I should do: ${r.heel} (${a})`) }, icon("spark"), "Ask Troya") : null),
      r.partial ? h("p", { class: "fine hl-partial" }, h("span", { class: "hl-spin" }), "Some sources are still reading; this answer updates by itself.") : null,
      passportEl(r.passport, r.kind),
      h("details", { class: "hl-cov" }, h("summary", {}, `What was read (${r.coverage.filter((c) => c.status === "done").length} of ${r.coverage.length} sources) · ${ago(r.checkedAt)} ago`),
        h("ul", {}, r.coverage.map((c) => h("li", { class: `c-${c.status.replace("/", "")}` }, h("b", {}, c.source), h("span", {}, STATUS[c.status] || c.status), c.note ? h("small", {}, c.note) : null)))),
      h("p", { class: "note hl-note" }, r.note));
  }

  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  input.addEventListener("paste", () => setTimeout(() => { if (ADDR.test(input.value)) run(input.value); }, 0));

  clear(view, h("div", { class: "dk hl-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Heel"),
      h("h1", {}, h("em", {}, "One"), " weak spot, with proof."),
      h("p", { class: "dk-sub" }, "Paste a coin, a dev wallet or an agent. Troya reads the Gate, the holders, the launch, the side wallets and the dev's past launches, then names the single most dangerous thing it found. Every fact links to the transaction or contract behind it.")),
    h("section", { class: "panel hl-panel" },
      h("div", { class: "hl-form" }, box, go),
      h("p", { class: "fine hl-try" }, "Try: ", SAMPLES.map(([t, x]) => h("button", { class: "link", type: "button", onclick: () => run(x) }, t))),
      out)));

  const start = ctx.parts[0] || ctx.query.address || "";
  if (ADDR.test(start)) run(start);
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; clearTimeout(timer); };
}
