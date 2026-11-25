// V10 F63 Sirens (#/sirens and #/sirens/<coin>): real depth and honest volume for one Robinhood Chain coin, and its
// family tree across chains. Everything comes from GET /api/sirens/:token (server/sirens.mjs); this page only shows it,
// with the method the numbers were made by. Reading only: nothing here asks a wallet to sign.
import { h, clear, toast, short, ago } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const SAMPLES = [["$TROYA", "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"], ["NVDA token", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"]];
const KIND = { linked: ["Official link", "ok"], plausible: ["Plausibly official", "maybe"], lookalike: ["Lookalike", "bad"], copy: ["Same-chain copy", "bad"] };
const usd = (n) => {
  if (n == null || !isFinite(n)) return "–";
  const a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n).toLocaleString("en-US")}`;
};
const pct = (x, d = 2) => (x == null || !isFinite(x) ? "–" : `${x < 0.01 && x > 0 ? "<0.01" : x.toFixed(x >= 10 ? 1 : d)}%`);
const price = (n) => (n == null ? "–" : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 20 })}`);

function css() {
  if (document.querySelector("style[data-sirens]")) return;
  document.head.append(h("style", { "data-sirens": "1" }, `
.sr-page { display: grid; gap: 16px; }
.sr-box { padding: 18px; min-width: 0; }
.sr-box h2 { margin: 0 0 4px; font-size: 17px; }
.sr-box h3 { margin: 14px 0 6px; font-size: 14px; }
.sr-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sr-form .cs-wrap { min-width: 220px; }
.sr-try { margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.sr-lead { margin: 6px 0 12px; font-size: 15px; line-height: 1.45; }
.sr-id { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sr-id b { font-size: 20px; }
.sr-alert { border: 1px solid var(--warn); background: var(--warn-bg); color: var(--fg); border-radius: 10px; padding: 10px 12px; font-size: 13.5px; margin: 8px 0; }
.sr-alert.bad { border-color: var(--down); background: var(--down-bg); }
.sr-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -2px; }
.sr-t { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.sr-t th { text-align: right; font-weight: 500; color: var(--faint); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.sr-t td { text-align: right; padding: 8px; border-bottom: 1px solid var(--line-2); white-space: nowrap; vertical-align: top; }
.sr-t th:first-child, .sr-t td:first-child { text-align: left; }
.sr-t td.sr-wrap { white-space: normal; text-align: left; min-width: 220px; color: var(--muted); font-size: 12.5px; }
.sr-t tr.sr-note td { border-bottom: 1px solid var(--line-2); padding-top: 0; white-space: normal; text-align: left; color: var(--muted); font-size: 12.5px; }
.sr-i0 { color: var(--fg); } .sr-i1 { color: var(--warn); } .sr-i2 { color: var(--down); }
.sr-x { color: var(--faint); cursor: help; border-bottom: 1px dotted var(--line-3); }
.sr-tag { display: inline-block; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.sr-tag.ok { color: var(--up); border-color: var(--up); } .sr-tag.maybe { color: var(--warn); border-color: var(--warn); } .sr-tag.bad { color: var(--down); border-color: var(--down); }
.sr-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 6px 0 12px; }
.sr-tiles div { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); min-width: 0; }
.sr-tiles small { display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.sr-tiles b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sr-tiles span { display: block; font-size: 12px; color: var(--muted); }
.sr-bars { display: grid; gap: 7px; margin: 4px 0 6px; }
.sr-bar { display: grid; grid-template-columns: minmax(150px, 260px) 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
.sr-bar i { display: block; height: 10px; border-radius: 5px; background: var(--line-2); overflow: hidden; }
.sr-bar i em { display: block; height: 100%; background: var(--warn); border-radius: 5px; }
.sr-bar.honest i em { background: var(--up); }
.sr-bar span:last-child { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sr-list { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.sr-wait { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13.5px; }
.sr-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-3); border-top-color: var(--up); animation: sr-r 0.9s linear infinite; flex: none; }
@keyframes sr-r { to { transform: rotate(360deg); } }
.sr-method p { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; }
.sr-method b { display: block; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-bottom: 2px; }
@media (max-width: 720px) { .sr-tiles { grid-template-columns: 1fr 1fr; } .sr-bar { grid-template-columns: 1fr auto; } .sr-bar i { grid-column: 1 / -1; grid-row: 2; } }`));
}

const impactCls = (x) => (x == null ? "" : x < 1 ? "sr-i0" : x < 5 ? "sr-i1" : "sr-i2");
function impactCell(c) {
  if (!c) return h("td", {}, "–");
  if (!c.ok) return h("td", {}, h("span", { class: "sr-x", title: c.why || "No quote" }, "no quote"));
  return h("td", { class: impactCls(c.impactPct), title: c.route || "" }, pct(c.impactPct));
}

function depthEl(d) {
  if (d.status === "reading") return waitEl("Quoting every venue at three sizes…");
  if (d.status === "failed") return h("p", { class: "fine" }, `Depth could not be read: ${d.error}`);
  const cols = ["buy", "sell"].flatMap((side) => d.sizes.map((s) => [side, s]));
  return h("div", {},
    h("p", { class: "sr-lead" }, d.headline),
    d.coinLooksDeep ? h("div", { class: "sr-alert bad" }, h("b", {}, "Looks deep, quotes shallow. "), d.coinLooksDeep.text) : null,
    d.venues.some((v) => v.looksDeep) ? h("div", { class: "sr-alert" }, `${d.venues.filter((v) => v.looksDeep).map((v) => v.label).join(", ")}: the reported liquidity is at least 4 times what the quotes behave like. Notes under the table.`) : null,
    d.venues.length ? h("div", { class: "sr-scroll" }, h("table", { class: "sr-t" },
      h("thead", {}, h("tr", {}, h("th", {}, "Venue"), h("th", {}, "Reported"), ...cols.map(([side, s]) => h("th", {}, `${side === "buy" ? "Buy" : "Sell"} $${s >= 1000 ? s / 1000 + "K" : s}`)), h("th", {}, "Behaves like"), h("th", {}, "2% move at"))),
      h("tbody", {}, d.venues.flatMap((v) => [
        h("tr", {}, h("td", {}, h("b", {}, v.label)), h("td", {}, v.reportedLiquidityUsd ? usd(v.reportedLiquidityUsd) : "–"),
          ...cols.map(([side, s]) => impactCell(v[side].find((c) => c.sizeUsd === s))),
          h("td", { class: v.looksDeep ? "sr-i2" : "" }, v.behavesLikeUsd != null ? usd(v.behavesLikeUsd) : v.deeperThanSizes ? "deeper" : v.dust ? "none" : "–"),
          h("td", {}, v.within2PctUsd != null ? (v.within2PctUsd < 1 ? "under $1" : usd(v.within2PctUsd)) : "–")),
        v.notes.length ? h("tr", { class: "sr-note" }, h("td", { colspan: String(cols.length + 4) }, v.notes.join(" "))) : null,
      ].filter(Boolean))))) : null,
    h("p", { class: "fine" }, "Price impact of each size against a tiny trade on the same route, so fees are not in it. Under 1% is plain, 1 to 5% amber, over 5% red. \"Behaves like\" is the full-range pool that would give the $1,000 buy's impact; \"2% move at\" is about how much buying moves the price 2% there. Reported liquidity is DexScreener's."),
    d.missing?.length ? h("details", {}, h("summary", { class: "fine" }, `Not quoted (${d.missing.length})`), h("ul", { class: "sr-list" }, d.missing.map((m) => h("li", {}, h("b", {}, m.label), `: ${m.why}`)))) : null,
    h("p", { class: "fine" }, `Coin price ${price(d.priceUsd)} (${d.priceSource || "unknown source"}), ETH ${price(d.ethUsd)}. Read ${ago(d.readAt)} ago.`));
}

function volumeEl(v) {
  if (v.status === "reading") return waitEl("Reading 24 hours of transfers from the chain and checking funders…");
  if (v.status === "failed") return h("p", { class: "fine" }, `Volume could not be read: ${v.error}`);
  const raw = v.raw.usd || 0, ds = v.dexscreener || {};
  const bar = (label, val, cls, sub) => h("div", { class: `sr-bar ${cls || ""}` }, h("span", {}, label), h("i", {}, h("em", { style: { width: `${raw > 0 ? Math.max(val > 0 ? 1 : 0, (100 * val) / raw) : 0}%` } })), h("span", {}, `${usd(val)}${sub ? ` · ${sub}` : ""}`));
  const C = v.coverage || {};
  return h("div", {},
    h("p", { class: "sr-lead" }, v.headline),
    h("div", { class: "sr-tiles" },
      h("div", {}, h("small", {}, "On chain, 24 h"), h("b", {}, usd(v.raw.usd)), h("span", {}, `${v.raw.trades.toLocaleString("en-US")} trades · ${v.raw.wallets.toLocaleString("en-US")} wallets`)),
      h("div", {}, h("small", {}, "Honest volume"), h("b", {}, usd(v.honest.usd)), h("span", {}, `${v.honest.trades.toLocaleString("en-US")} trades · ${v.honest.wallets.toLocaleString("en-US")} wallets`)),
      h("div", {}, h("small", {}, "Taken out"), h("b", {}, v.removedPct != null ? `${v.removedPct}%` : "–"), h("span", {}, "of the on-chain volume")),
      h("div", {}, h("small", {}, "DexScreener says"), h("b", {}, usd(ds.volume24hUsd)), h("span", {}, ds.honestOfReportedPct != null ? `honest is ${ds.honestOfReportedPct}% of it` : "no reported volume"))),
    raw > 0 ? h("div", { class: "sr-bars", role: "list" }, bar("Honest volume", v.honest.usd, "honest"), ...v.byRule.filter((b) => b.usd > 0 || b.trades > 0).map((b) => bar(`${b.rule}. ${b.label}`, b.usd, "", `${b.trades} trades, ${b.wallets} wallets`))) : null,
    v.notes?.length ? h("ul", { class: "sr-list" }, v.notes.map((n) => h("li", {}, n))) : null,
    v.tributeFlags?.length ? h("div", { class: "sr-alert" }, h("b", {}, "Tribute also flags: "), v.tributeFlags.map((f) => `${f.title}. ${f.detail}`).join(" ")) : null,
    v.examples?.length ? h("div", {}, h("h3", {}, "Largest wallets taken out"), h("div", { class: "sr-scroll" }, h("table", { class: "sr-t" },
      h("thead", {}, h("tr", {}, h("th", {}, "Wallet"), h("th", {}, "Rules"), h("th", {}, "Trades"), h("th", {}, "Volume"), h("th", {}, "First funded by"), h("th", {}, "Proof"))),
      h("tbody", {}, v.examples.map((x) => h("tr", {},
        h("td", {}, h("a", { class: "link mono", href: x.walletUrl, target: "_blank", rel: "noopener" }, short(x.wallet))),
        h("td", {}, x.rules.join(" + ")), h("td", {}, String(x.trades)), h("td", {}, usd(x.usd)),
        h("td", {}, x.funder ? h("a", { class: "link mono", href: `${EXPLORER}/address/${x.funder}`, target: "_blank", rel: "noopener" }, short(x.funder)) : "–"),
        h("td", {}, h("a", { class: "link", href: x.txUrl, target: "_blank", rel: "noopener" }, "a transaction")))))))) : null,
    v.linkedGroups?.length ? h("p", { class: "fine" }, `Linked wallets (first funded by the same wallet, among the ${C.fundersChecked} funders read): `, ...v.linkedGroups.flatMap((g, i) => [i ? ", " : "", h("a", { class: "link mono", href: g.funderUrl, target: "_blank", rel: "noopener" }, short(g.funder)), ` funded ${g.wallets}`])) : null,
    h("details", {}, h("summary", { class: "fine" }, "What was read"),
      h("ul", { class: "sr-list" },
        h("li", {}, `Blocks ${Number(C.fromBlock).toLocaleString("en-US")} to ${Number(C.toBlock).toLocaleString("en-US")} (${new Date(C.fromTs * 1000).toUTCString().slice(5, 22)} to ${new Date(C.toTs * 1000).toUTCString().slice(5, 22)} UTC).`),
        h("li", {}, `${Number(C.transfers).toLocaleString("en-US")} transfers in ${Number(C.transactions).toLocaleString("en-US")} transactions, ${C.venues} venues; ${C.liquidityTxsLeftOut} liquidity transactions left out${C.liquidityReadsFailed ? ` (${C.liquidityReadsFailed} liquidity reads failed)` : ""}.`),
        h("li", {}, `First funders read for ${C.fundersChecked} of the ${C.fundersTried} wallets with the most volume${v.commonSources?.length ? `; ${v.commonSources.length} common source${v.commonSources.length === 1 ? "" : "s"} (more than 10 of them from one wallet: an exchange or a faucet) not used as a link` : ""}.`),
        h("li", {}, `Trades valued at ${C.pricing}.`),
        C.partial ? h("li", {}, "Too many transfers to read all of them: the numbers cover part of the day.") : null)),
    h("p", { class: "fine" }, `Read ${ago(v.readAt)} ago. What wallets did, never who people are.`));
}

function familyEl(f) {
  if (f.status === "reading") return waitEl("Searching other chains for the same ticker and name…");
  if (f.status === "failed") return h("p", { class: "fine" }, `The family tree could not be read: ${f.error}`);
  return h("div", {},
    h("p", { class: "sr-lead" }, f.headline),
    h("ul", { class: "sr-list" }, f.checks.map((c) => h("li", {}, c))),
    f.proteus ? h("p", { class: "fine" }, h("a", { class: "link", href: f.proteus }, "Compare this share on every venue in Proteus")) : null,
    f.members.length ? h("div", { class: "sr-scroll", style: { marginTop: "10px" } }, h("table", { class: "sr-t" },
      h("thead", {}, h("tr", {}, h("th", {}, "Kind"), h("th", {}, "Chain"), h("th", {}, "Token"), h("th", {}, "Liquidity"), h("th", {}, "Price vs this"), h("th", { style: { textAlign: "left" } }, "Why"))),
      h("tbody", {}, f.members.map((m) => {
        const [k, cls] = KIND[m.kind] || [m.kind, ""];
        return h("tr", {},
          h("td", {}, h("span", { class: `sr-tag ${cls}` }, k)), h("td", {}, m.chainName),
          h("td", {}, m.url ? h("a", { class: "link", href: m.url, target: "_blank", rel: "noopener", title: m.address }, `${m.symbol} `, h("span", { class: "mono fine" }, short(m.address))) : h("span", { title: m.address }, `${m.symbol} `, h("span", { class: "mono fine" }, short(m.address)))),
          h("td", {}, usd(m.liquidityUsd)), h("td", {}, m.priceGapPct == null ? "–" : `${m.priceGapPct > 0 ? "+" : ""}${Math.abs(m.priceGapPct) >= 1000 ? Math.round(m.priceGapPct).toLocaleString("en-US") : m.priceGapPct}%`),
          h("td", { class: "sr-wrap" }, [m.why.length ? m.why.join("; ") : "A different contract with no link found", m.unsure.length ? ` (${m.unsure.join("; ")})` : ""].join("")));
      })))) : null,
    h("p", { class: "fine" }, `Read ${ago(f.readAt)} ago. ${f.source}.`));
}
const waitEl = (t) => h("div", { class: "sr-wait" }, h("span", { class: "sr-spin" }), h("span", {}, t));

function methodEl(M) {
  return h("section", { class: "panel sr-box sr-method" }, h("h2", {}, "How Sirens reads it"),
    h("p", {}, h("b", {}, "Real depth"), M.depth), h("p", {}, h("b", {}, "Honest volume"), M.volume), h("p", {}, h("b", {}, "Family tree"), M.family), h("p", {}, h("b", {}, "Honest limits"), M.limits));
}

export async function mount(view, ctx = {}) {
  css();
  const input = h("input", { class: "input", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "80", placeholder: "A Robinhood Chain coin: ticker, name or address", "aria-label": "Coin" });
  const box = coinSuggest(input, (c) => { input.value = c.address; run(c.address); }, { majors: false });
  const go = h("button", { class: "btn primary", type: "button" }, "Read it");
  const out = h("div", { class: "sr-page", "aria-live": "polite" });
  const methodBox = h("div");
  let alive = true, seq = 0, timer = 0;

  async function run(raw, again = 0) {
    clearTimeout(timer);
    const text = String(raw || "").trim();
    let a = ADDR.exec(text)?.[0];
    if (!a && text) { const c = await findCoin(text).catch(() => null); if (c?.address && ADDR.test(c.address)) a = c.address; }
    if (!a) { toast("Paste a Robinhood Chain coin address, or type its ticker.", "error"); input.focus(); return; }
    const id = ++seq;
    input.value = a;
    if (location.hash !== `#/sirens/${a}`) history.replaceState(null, "", `#/sirens/${a}`);
    if (!again) clear(out, h("section", { class: "panel sr-box" }, waitEl("Quoting every venue, reading 24 hours of trades and searching other chains. The first read of a coin takes up to a minute.")));
    go.disabled = true;
    let r;
    try { r = await api.get(`/api/sirens/${a}`); }
    catch (e) { if (!alive || id !== seq) return; go.disabled = false; clear(out, h("section", { class: "panel sr-box" }, h("div", { class: "dk-empty" }, h("b", {}, "Sirens could not read this coin right now."), h("p", {}, e.message), h("button", { class: "btn sm", type: "button", onclick: () => run(a) }, "Try again")))); return; }
    if (!alive || id !== seq) return;
    go.disabled = false;
    render(a, r);
    if (r.partial && again < 10) timer = setTimeout(() => { if (alive && id === seq) run(a, again + 1); }, 9000);
  }

  function render(a, r) {
    const c = r.coin;
    const name = c.symbol ? `$${c.symbol}` : short(a, 6);
    const lines = [r.depth?.headline, r.volume?.headline, r.family?.headline].filter(Boolean).join(" ");
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Sirens for ${name} (${a}): ${lines}` } }));
    clear(out,
      h("section", { class: "panel sr-box" },
        h("div", { class: "sr-id" }, h("b", {}, name), c.name && c.name !== c.symbol ? h("span", { class: "fine" }, c.name) : null,
          h("a", { class: "link fine mono", href: `${EXPLORER}/token/${a}`, target: "_blank", rel: "noopener" }, short(a, 6)),
          h("a", { class: "btn sm", href: `#/token/${a}` }, "Token page"), h("a", { class: "btn sm", href: `#/heel/${a}` }, "Find the weak spot"),
          ctx.ask ? h("button", { class: "btn sm", type: "button", onclick: () => ctx.ask(`Explain this Sirens reading in plain words: ${lines} (${a})`) }, "Ask Troya") : null),
        r.partial ? h("p", { class: "fine" }, "Some parts are still being read; this page updates by itself.") : null),
      h("section", { class: "panel sr-box" }, h("h2", {}, "Real depth"), depthEl(r.depth)),
      h("section", { class: "panel sr-box" }, h("h2", {}, "Honest volume"), volumeEl(r.volume)),
      h("section", { class: "panel sr-box" }, h("h2", {}, "Family tree across chains"), familyEl(r.family)));
    if (r.method) clear(methodBox, methodEl(r.method));
  }

  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  input.addEventListener("paste", () => setTimeout(() => { if (ADDR.test(input.value)) run(input.value); }, 0));

  clear(view, h("div", { class: "dk sr-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Sirens · V10 Poseidon"),
      h("h1", {}, "Real depth, ", h("em", {}, "honest"), " volume."),
      h("p", { class: "dk-sub" }, "The Sirens sang beautifully and sank ships. A coin can look deep and busy and still sink you. Pick a coin: Troya quotes a $100, $1,000 and $10,000 buy and sell on every venue it reaches, takes wash trading out of its last 24 hours, and finds its namesakes on other chains. The method is published below, with its limits.")),
    h("section", { class: "panel sr-box" },
      h("div", { class: "sr-form" }, box, go),
      h("div", { class: "sr-try fine" }, "Try: ", SAMPLES.map(([t, x]) => h("button", { class: "link", type: "button", onclick: () => run(x) }, t)))),
    out, methodBox));
  // the method shows before any coin is picked
  api.get("/api/sirens").then((m) => { if (alive && !methodBox.firstChild && m?.method) clear(methodBox, methodEl(m.method)); }).catch(() => {});

  const start = ctx.parts?.[0] || ctx.query?.token || "";
  if (start) run(decodeURIComponent(start));
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; clearTimeout(timer); };
}
