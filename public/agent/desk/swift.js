// V9 F49 Swift (#/swift?token=&amount=): one buy box. Type or paste a coin (ticker, name or address) and an amount of ETH;
// Troya asks every venue it reaches at the same moment (Pons curve, Uniswap v3 and v4, KyberSwap, ETH on Base or
// Arbitrum through LI.FI, Lighter spot, Hyperliquid) and ranks them by what you actually receive after fees and gas. The
// Troya Gate verdict sits inside the Buy button. Buy hands the route to the Swap page, which quotes again, runs the Gate and
// waits for your wallet: nothing here signs or sends. The answer comes from GET /api/atlas/quote (server/atlas.mjs).
// swiftCard() is the same box in a compact card for the Desk home (built, not placed yet).
import { h, clear, icon, short, toast, tokenIcon, chainLogo, venueLogo, amount, compact, usd, debounce } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet } from "/agent/js/wallet.js";
import { coinSuggest } from "/agent/js/coinsearch.js";
import { verdictOf } from "/agent/js/verdict.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CHIPS = ["0.005", "0.01", "0.05", "0.1", "0.25"];
const TITLE = "Swift";
const SUBTITLE = "Best route across every venue Troya reaches";
const VENUE = {
  "pons-curve": ["Pons curve", "pons"], "uniswap-v4": ["Uniswap v4", "uniswap"], "uniswap-v3": ["Uniswap v3", "uniswap"], kyberswap: ["KyberSwap", "kyber"],
  "lifi-base": ["Pay from Base", "lifi"], "lifi-arbitrum": ["Pay from Arbitrum", "lifi"], "lighter-spot": ["Lighter spot", "lighter"], "hyperliquid-spot": ["Hyperliquid spot", "hyperliquid"],
};
const CHAIN = { robinhood: "Robinhood Chain", base: "Base", arbitrum: "Arbitrum", hyperliquid: "Hyperliquid" };
const ASKING = ["Pons curve", "Uniswap v4", "Uniswap v3", "KyberSwap", "Base via LI.FI", "Arbitrum via LI.FI", "Lighter", "Hyperliquid"];
const REFRESH_MS = 45_000;

export function swiftCss() {
  if (document.querySelector("link[data-swift-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/swift.css", "data-swift-css": "1" }));
}
const cleanAmt = (s) => { let v = String(s ?? "").replace(/[\s_]/g, "").replace(/,/g, "."); v = v.replace(/[^\d.]/g, ""); const i = v.indexOf("."); return i < 0 ? v : v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, ""); };
const okAmt = (s) => /^\d*\.?\d+$/.test(s) && Number(s) > 0;
const pctTxt = (v) => (v == null ? "–" : v < 0.01 ? "<0.01%" : `${v.toFixed(v < 1 ? 2 : 1)}%`);
const secTxt = (s) => (s == null ? "–" : s < 90 ? `~${Math.max(1, Math.round(s))} s` : `~${Math.round(s / 60)} min`);
const gasTxt = (r) => (r.gasUsd != null ? (r.gasUsd < 0.01 ? "<$0.01" : usd(r.gasUsd)) : r.gasEth != null ? `${r.gasEth.toPrecision(2)} ETH` : "–");
const outTxt = (v) => { const n = Number(v); return !isFinite(n) ? "–" : n >= 1e6 ? compact(n, 2) : amount(n); };
const vName = (r) => VENUE[r.venue]?.[0] || r.label.split(" · ")[0];

/* the Gate ring that rides inside the Buy button: passed / total, coloured by the verdict word */
function gateRing(g, size = 20) {
  const v = g ? verdictOf(g) : null;
  const frac = g?.total ? Math.max(0, Math.min(1, g.passed / g.total)) : 0;
  const C = 2 * Math.PI * 8;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 20 20"); el.setAttribute("width", size); el.setAttribute("height", size); el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", `sf-ring w-${v?.word || "none"}`);
  el.innerHTML = `<circle cx="10" cy="10" r="8" class="a"/><circle cx="10" cy="10" r="8" class="b" stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 10 10)"/>`;
  return el;
}
function gateWord(g) {
  const v = verdictOf(g);
  return { v, cls: v.word === "blocked" ? "v-failed" : v.word === "passed" ? "v-passed" : "v-caution", short: v.word === "passed" ? "Gate passed" : v.word === "notes" ? "Gate: read the note" : v.word === "untestable" ? "Gate: not testable yet" : "Gate blocked" };
}

/* ---------- the shared engine: one coin, one amount, one answer ---------- */
function engine({ onState }) {
  const st = { coin: null, text: "", amount: "0.01", res: null, err: null, loading: false, at: 0, seq: 0, pick: null, t0: 0 };
  async function run({ quiet = false } = {}) {
    const token = st.coin?.address || st.text.trim();
    if (!token) { st.err = null; st.res = null; onState(st); return; }
    if (!okAmt(st.amount)) { st.err = "Enter an ETH amount, for example 0.01."; st.res = null; onState(st); return; }
    const id = ++st.seq;
    st.loading = true; st.t0 = Date.now(); if (!quiet) { st.err = null; st.res = null; st.pick = null; }
    onState(st);
    try {
      const qs = new URLSearchParams({ token, amountEth: st.amount, ...(wallet.address ? { from: wallet.address } : {}) });
      const r = await api.get(`/api/atlas/quote?${qs}`);
      if (id !== st.seq) return;
      st.res = r; st.err = null; st.at = Date.now();
      st.coin = { address: r.token.address, symbol: r.token.symbol, name: r.token.name };
      // keep the route someone picked when it is still there and signable; otherwise the best one
      const keep = st.pick && r.routes.find((x) => x.venue === st.pick && x.ok && x.executable);
      st.pick = keep ? st.pick : r.best?.venue || null;
    } catch (e) {
      if (id !== st.seq) return;
      st.err = e.message || String(e);
      if (!quiet) st.res = null;
    }
    st.loading = false;
    onState(st);
  }
  return { st, run };
}

/** where Buy goes: the Swap page with the route filled in (the cross-chain panel for Base / Arbitrum) */
function buyHref(st, r) {
  if (!r?.handoff?.href) return null;
  return r.handoff.kind === "swap" ? `${r.handoff.href}&review=1` : r.handoff.href;
}
function selected(st) { return st.res?.routes.find((x) => x.venue === st.pick && x.ok) || null; }

/** the Buy button with the Gate inside it; disabled with the reason when the Gate blocks or nothing can be signed */
function buyButton(st, { big = true } = {}) {
  const res = st.res, r = selected(st), g = res?.gate;
  const sym = res?.token?.symbol ? `$${res.token.symbol}` : "";
  if (!res) return h("button", { class: `btn primary sf-buy${big ? " big" : ""}`, type: "button", disabled: true }, h("span", { class: "sf-buy-t" }, st.loading ? "Finding the best route…" : "Buy"));
  const gw = gateWord(g);
  const blocked = !gw.v.canBuy || !g.pass;
  const why = blocked ? g.why || gw.v.note : !r ? res.bestOverall?.why || "No venue Troya can sign has a route for this buy right now." : null;
  const btn = h("button", { class: `btn primary sf-buy${big ? " big" : ""}${blocked ? " blocked" : ""}`, type: "button", disabled: blocked || !r,
    "aria-describedby": "sf-buy-why", title: why || `Opens Swap with ${vName(r)} filled in. Your wallet signs there.` },
    h("span", { class: `sf-gate ${gw.cls}` }, gateRing(g), h("span", {}, g.total ? `${g.passed}/${g.total}` : "–")),
    h("span", { class: "sf-buy-t" }, blocked ? "Gate blocked" : r ? `Buy ${sym}` : "No route to sign"),
    !blocked && r ? h("span", { class: "sf-buy-v" }, vName(r)) : null,
    !blocked && r ? icon("arrowRight", "sf-buy-go") : null);
  btn.addEventListener("click", () => { const href = buyHref(st, r); if (href) location.hash = href; });
  return h("div", { class: "sf-buy-wrap" }, btn,
    h("p", { id: "sf-buy-why", class: `sf-buy-why ${blocked ? "bad" : ""}` }, why || (r ? `${gw.short} · ${g.tally}.${gw.v.word === "passed" ? "" : ` ${gw.v.note}`} Swap quotes again and runs the Gate before your wallet signs.` : "")));
}

function summary(st) {
  const res = st.res, r = selected(st);
  if (!res) return null;
  const sym = res.token.symbol ? `$${res.token.symbol}` : "coins";
  const best = res.best;
  return h("div", { class: "sf-sum" },
    h("div", { class: "sf-coin" }, tokenIcon({ address: res.token.address, symbol: res.token.symbol }, "md"),
      h("div", { class: "sf-coin-t" }, h("b", {}, sym), h("a", { class: "link fine mono", href: `#/token/${res.token.address}` }, `${res.token.name ? `${res.token.name} · ` : ""}${short(res.token.address)}`))),
    r ? h("div", { class: "sf-get" },
      h("span", { class: "sf-get-k" }, "You get about"),
      h("b", { class: "sf-get-v", title: `${r.out} ${sym}` }, outTxt(r.netOut ?? r.out), h("small", {}, ` ${sym}`)),
      h("span", { class: "sf-get-u" }, r.outUsd != null ? `≈ ${usd(r.outUsd)} after fees${r.gasEth != null ? ", gas counted" : ""}` : "No dollar price for this coin yet")) : null,
    best ? h("p", { class: "sf-reason" }, icon("bolt"), best.reason, best.venue !== st.pick && r ? h("span", { class: "fine" }, ` · you picked ${vName(r)}`) : null) : null,
    res.bestOverall && res.best ? h("p", { class: "fine sf-over" }, `${vName(res.bestOverall)} quotes ${res.bestOverall.moreThanBestPct != null ? `${res.bestOverall.moreThanBestPct}% ` : ""}more. ${res.bestOverall.why}`) : null);
}

function fundLine(st) {
  const f = st.res?.fundFrom, r = selected(st);
  if (!f || !wallet.address) return null;
  if (f[0]?.error) return h("p", { class: "fine sf-fund" }, `Balances could not be read: ${f[0].error}`);
  const need = r?.chain || "robinhood";
  const here = f.find((x) => x.key === need);
  const alt = here && !here.enough ? st.res.routes.find((x) => x.ok && x.executable && f.find((y) => y.key === x.chain)?.enough) : null;
  return h("div", { class: "sf-fund" },
    h("span", { class: "fine" }, "Your ETH"),
    f.map((x) => h("span", { class: `sf-bal${x.enough ? " ok" : ""}${x.key === need ? " on" : ""}` }, chainLogo(x.key, 14), `${x.balanceEth != null ? amount(Number(x.balanceEth)) : "?"} `, h("small", {}, CHAIN[x.key] || x.name))),
    alt ? h("button", { class: "btn sm", type: "button", onclick: () => { st.pick = alt.venue; st._paint?.(); } }, `Not enough on ${CHAIN[need]}: pay from ${CHAIN[alt.chain]}`) : null);
}

function routeRow(st, r, i, bestVenue) {
  const pickable = r.ok && r.executable;
  const on = r.venue === st.pick;
  const [name, logo] = VENUE[r.venue] || [r.label, r.venue];
  const status = !r.ok ? h("span", { class: "sf-tag off" }, "No route")
    : r.venue === bestVenue ? h("span", { class: "sf-tag best" }, "Best")
    : r.executable ? h("span", { class: "sf-tag" }, "Can sign")
    : r.pending ? h("span", { class: "sf-tag cmp", title: "The Gate did not finish yet" }, "Gate pending")
    : h("span", { class: "sf-tag cmp", title: "Shown for comparison: Troya's Swap cannot sign this venue yet" }, "Compare");
  const sym = st.res.token.symbol ? `$${st.res.token.symbol}` : "";
  const body = [
    h("span", { class: "sf-rank" }, r.ok ? String(i + 1) : "–"),
    h("span", { class: "sf-ven" }, h("span", { class: "sf-logos" }, logo === "lighter" ? h("span", { class: "pad-logo sf-mono" }, "L") : venueLogo(logo, 22), chainLogo(r.chain, 12)),
      h("span", { class: "sf-ven-t" }, h("b", {}, name), h("small", {}, r.ok ? r.label.split(" · ").slice(1).join(" · ") || CHAIN[r.chain] : CHAIN[r.chain] || r.chain))),
    r.ok ? h("span", { class: "sf-out" }, h("b", { title: `${r.out} ${sym} before gas` }, outTxt(r.netOut ?? r.out)), h("small", {}, r.outUsd != null ? usd(r.outUsd) : sym)) : h("span", { class: "sf-why" }, r.why),
    r.ok ? h("span", { class: "sf-facts" },
      h("span", { title: "Price impact" }, h("i", {}, "Impact"), pctTxt(r.priceImpactPct)),
      h("span", { title: "Fees and taxes on the route" }, h("i", {}, "Fees"), pctTxt(r.feesPct)),
      h("span", { title: r.gasNote || "Gas" }, h("i", {}, "Gas"), gasTxt(r)),
      h("span", { title: "Time until the coin is in your wallet" }, h("i", {}, "Time"), secTxt(r.etaSec))) : null,
    status,
  ];
  const note = r.ok && (r.note || (!r.executable ? "Shown for comparison: Troya's Swap cannot sign this venue yet." : null));
  if (pickable) return h("li", {}, h("button", { type: "button", class: `sf-row${on ? " on" : ""}`, "aria-pressed": String(on), onclick: () => { st.pick = r.venue; st._paint?.(); } }, ...body), note ? h("p", { class: "sf-note" }, note) : null);
  return h("li", {}, h("div", { class: `sf-row${r.ok ? " cmp" : " off"}` }, ...body), note ? h("p", { class: "sf-note" }, note) : null);
}

function waiting(st) {
  const s = Math.round((Date.now() - st.t0) / 1000);
  return h("div", { class: "sf-wait" },
    h("div", { class: "sf-wait-h" }, h("span", { class: "sf-spin" }), h("span", {}, `Asking every venue at once${s > 2 ? ` · ${s} s` : ""}`)),
    h("ul", { class: "sf-wait-l" }, ASKING.map((t) => h("li", {}, h("span", { class: "sk" }), t))),
    h("p", { class: "fine" }, "The Troya Gate runs a simulated buy and a test sell at the same time, so a first answer can take 20 to 30 seconds."));
}

/* ---------- the page ---------- */
export async function mount(view, ctx) {
  swiftCss();
  let alive = true, tick = 0;
  const E = engine({ onState: () => paint() });
  const st = E.st;
  st._paint = () => paint();
  st.text = ctx.query.token || ctx.parts[0] || "";
  if (ADDR.test(st.text)) st.coin = { address: st.text };
  if (okAmt(ctx.query.amount || "")) st.amount = ctx.query.amount;

  const input = h("input", { class: "input sf-in", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "64", id: "sf-coin", placeholder: "Coin: ticker, name or address", "aria-label": "Coin to buy: ticker, name or address", value: st.text });
  const box = coinSuggest(input, (c) => { st.coin = c; st.text = c.symbol || c.address; input.value = c.symbol ? `$${c.symbol}` : c.address; go(); }, { majors: false });
  const amt = h("input", { id: "sf-amt", class: "sf-amt", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", "aria-label": "ETH to spend", value: st.amount });
  const chips = h("div", { class: "sf-chips", role: "group", "aria-label": "Amount" });
  const find = h("button", { class: "btn sf-find", type: "button" }, icon("search"), "Find best route");
  const dyn = h("div", { class: "sf-dyn" });
  // the inputs are built once and never re-placed, so typing keeps its focus while answers arrive
  const left = h("div", { class: "sf-left" }, h("section", { class: "panel sf-box" },
    h("label", { class: "sf-k", for: "sf-coin" }, "Buy"),
    h("div", { class: "sf-coinrow" }, box),
    h("label", { class: "sf-k", for: "sf-amt" }, "With"),
    h("div", { class: "sf-amtrow" }, amt, h("span", { class: "sf-unit" }, chainLogo("ethereum", 16), "ETH")),
    chips,
    h("div", { class: "sf-act" }, find),
    dyn));
  const right = h("section", { class: "panel sf-routes", "aria-live": "polite", "aria-label": "Routes" });

  const paintChips = () => clear(chips, CHIPS.map((c) => h("button", { type: "button", class: "sf-chip", "aria-pressed": String(st.amount === c), onclick: () => { st.amount = c; amt.value = c; paintChips(); go(); } }, `${c} ETH`)));
  const go = () => {
    const p = new URLSearchParams({ ...(st.coin?.address || st.text ? { token: st.coin?.address || st.text } : {}), amount: st.amount });
    history.replaceState(null, "", `#/swift?${p}`);
    E.run();
  };
  const goSoon = debounce(go, 700);
  input.addEventListener("input", () => { st.coin = null; st.text = input.value.replace(/^\$/, ""); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { st.text = input.value.replace(/^\$/, ""); if (ADDR.test(st.text)) st.coin = { address: st.text }; go(); } });
  input.addEventListener("paste", () => setTimeout(() => { const v = input.value.trim(); if (ADDR.test(v)) { st.coin = { address: v }; st.text = v; go(); } }, 0));
  amt.addEventListener("input", () => { const v = cleanAmt(amt.value); if (v !== amt.value) amt.value = v; st.amount = v; paintChips(); if ((st.coin || st.text) && okAmt(v)) goSoon(); });
  find.addEventListener("click", () => { st.text = input.value.replace(/^\$/, "").trim(); if (ADDR.test(st.text)) st.coin = { address: st.text }; go(); });

  function paint() {
    if (!alive) return;
    find.disabled = st.loading;
    if (st.res && !st.loading && document.activeElement !== input) input.value = st.res.token.symbol ? `$${st.res.token.symbol}` : st.res.token.address;
    clear(dyn,
      st.err && !st.res ? h("div", { class: "alert error sf-err" }, st.err) : null,
      summary(st),
      buyButton(st),
      fundLine(st));
    if (!st.res && !st.loading) {
      clear(right, h("div", { class: "sf-empty" },
        h("b", {}, "Every venue, side by side"),
        h("p", {}, "Pons curves, Uniswap v4 and v3 and KyberSwap on Robinhood Chain; ETH on Base or Arbitrum through LI.FI; Lighter's order book; Hyperliquid. Ranked by the coins you receive after fees and gas."),
        h("p", { class: "fine" }, "Try: ", h("button", { class: "link", type: "button", onclick: () => { st.coin = { address: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074" }; input.value = "$TROYA"; go(); } }, "$TROYA"))));
      return;
    }
    if (!st.res) { clear(right, waiting(st)); return; }
    const res = st.res, okN = res.routes.filter((r) => r.ok).length;
    clear(right,
      h("div", { class: "panel-h sf-rh" },
        h("h2", {}, "Every venue, ranked"),
        h("span", { class: "fine" }, `${okN} of ${res.routes.length} quoted · ${st.loading ? "refreshing…" : `${Math.max(0, Math.round((Date.now() - st.at) / 1000))} s ago`}`,
          h("button", { class: "btn sm ghost", type: "button", title: "Quote again", "aria-label": "Quote again", disabled: st.loading, onclick: () => E.run({ quiet: true }) }, icon("refresh")))),
      st.err ? h("p", { class: "alert warn" }, `Refresh failed: ${st.err}. Showing the last answer.`) : null,
      h("ol", { class: "sf-list" }, res.routes.map((r, i) => routeRow(st, r, i, res.best?.venue))),
      res.alsoAvailable?.length ? h("div", { class: "sf-also" }, h("h3", {}, "Also available, not a buy of the coin"),
        h("ul", {}, res.alsoAvailable.map((a) => h("li", {}, h("a", { class: "link", href: a.href }, a.label), h("span", { class: "fine" }, a.note))))) : null,
      h("p", { class: "note sf-foot" }, `${res.note} Coin price ${res.priceUsd != null ? `from ${res.priceSource}` : "not known"}; ETH at ${res.ethUsd ? usd(res.ethUsd) : "an unknown price"}.`));
  }

  paintChips();
  paint();
  if (st.coin || st.text) E.run(); else setTimeout(() => input.focus(), 30);
  // the answer on screen is quoted again while the page is open and visible; the elapsed counters tick each second
  tick = setInterval(() => {
    if (!alive || document.hidden) return;
    if (st.loading && !st.res) clear(right, waiting(st));
    else if (st.res && !st.loading && Date.now() - st.at > REFRESH_MS) E.run({ quiet: true });
    else if (st.res) { const f = right.querySelector(".sf-rh .fine"); if (f?.firstChild) f.firstChild.textContent = `${st.res.routes.filter((r) => r.ok).length} of ${st.res.routes.length} quoted · ${st.loading ? "refreshing…" : `${Math.round((Date.now() - st.at) / 1000)} s ago`}`; }
  }, 1000);
  const off = onWallet(() => { if (st.res && alive && !st.loading) E.run({ quiet: true }); });

  clear(view, h("div", { class: "dk sf-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Trade · Swift"),
      h("h1", {}, TITLE),
      h("p", { class: "dk-sub" }, `${SUBTITLE}. One box, one amount: Troya asks every venue at once and shows the route that leaves you the most coins after fees and gas, with the Gate inside the Buy button.`)),
    h("div", { class: "sf-grid" }, left, right)));
  return () => { alive = false; clearInterval(tick); off(); };
}

/**
 * swiftCard(): the same buy box as a compact Desk card (one input, the amount chips, the best route in one line and the
 * Buy button with the Gate inside). Built for the Desk home; not placed anywhere yet. Returns { el, destroy }.
 */
export function swiftCard() {
  swiftCss();
  let alive = true;
  const card = h("section", { class: "panel sf-card", "aria-label": TITLE });
  const E = engine({ onState: () => paint() });
  const st = E.st;
  st._paint = () => paint();
  const input = h("input", { class: "input sf-in", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "64", placeholder: "Ticker, name or address", "aria-label": "Coin to buy" });
  const box = coinSuggest(input, (c) => { st.coin = c; st.text = c.symbol || c.address; input.value = c.symbol ? `$${c.symbol}` : c.address; E.run(); }, { majors: false });
  input.addEventListener("input", () => { st.coin = null; st.text = input.value.replace(/^\$/, ""); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { st.text = input.value.replace(/^\$/, ""); if (ADDR.test(st.text)) st.coin = { address: st.text }; E.run(); } });
  const chips = h("div", { class: "sf-chips" });
  const paintChips = () => clear(chips, CHIPS.slice(0, 4).map((c) => h("button", { type: "button", class: "sf-chip", "aria-pressed": String(st.amount === c), onclick: () => { st.amount = c; paintChips(); if (st.coin || st.text) E.run(); } }, `${c} ETH`)));
  const body = h("div", { class: "sf-card-b" });
  function paint() {
    if (!alive) return;
    const res = st.res, r = selected(st);
    if (res && !st.loading && document.activeElement !== input) input.value = res.token.symbol ? `$${res.token.symbol}` : res.token.address;
    const all = `#/swift?${new URLSearchParams({ ...(st.coin?.address ? { token: st.coin.address } : {}), amount: st.amount })}`;
    clear(body,
      st.loading && !res ? h("p", { class: "fine sf-wait-h" }, h("span", { class: "sf-spin" }), "Asking every venue at once…") : null,
      st.err && !res ? h("p", { class: "fine sf-why" }, st.err) : null,
      res?.best ? h("p", { class: "sf-reason" }, icon("bolt"), res.best.reason) : null,
      res && r ? h("p", { class: "fine" }, `About ${outTxt(r.netOut ?? r.out)} $${res.token.symbol}${r.outUsd != null ? ` (${usd(r.outUsd)})` : ""}`) : null,
      res ? buyButton(st, { big: false }) : null,
      h("a", { class: "link fine", href: all }, res ? "See every venue" : "Open Swift"));
  }
  clear(card,
    h("div", { class: "panel-h" }, h("h2", {}, TITLE), h("span", { class: "fine" }, SUBTITLE)),
    h("div", { class: "sf-coinrow" }, box), chips, body);
  paintChips(); paint();
  return { el: card, destroy: () => { alive = false; } };
}
