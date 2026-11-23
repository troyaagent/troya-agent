// Troya Gate: paste any coin and see its checks, the same result the badge, Swap and Sentry use. Robinhood Chain is home;
// Base, Arbitrum and Solana run their own Gate through /api/swap/gate. gatePanel() is the Desk card; mount() is the full
// page at #/gate and #/gate/<address>?chain=&amount=
import { h, clear, icon, useCss, short, ago, tokenIcon, toast, chainLogo } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";
import { verdictOf, tallyOf } from "/agent/js/verdict.js";

// token age on the Gate (community request, 20 Nov 2026): how long ago the coin was created, from its creation block.
// /api/token-age reads Robinhood Chain only, so a coin checked on Base, Arbitrum or Solana shows no age rather than the
// age of whatever sits at that address on Robinhood Chain
const gateIdLine = (r, a, chain = "robinhood") => {
  const s = h("span", {}, [r.name, short(a)].filter(Boolean).join(" · "));
  if (chain !== "robinhood") return s;
  api.get(`/api/token-age/${a}`).then((x) => { if (x?.bornAt) { s.append(` · age ${ago(x.bornAt)}`); s.title = `Created ${new Date(x.bornAt).toUTCString().replace(" GMT", " UTC")}`; } }).catch(() => {});
  return s;
};

const ADDR = /0x[0-9a-fA-F]{40}/;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;                    // a Solana token (mint) address: base58, never 0x
const EXAMPLE = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";   // NVDA (Robinhood stock token)
// the buy size the Gate checks. The badge and Sentry check 0.01 ETH; price impact grows with size, so a bigger buy is
// checked live through /api/swap/gate
const SIZES = ["0.01", "0.1", "1"], BADGE_SIZE = "0.01";
// one tap into Swap with the amount filled in and its review opening as soon as Swap's own Gate run passes at that exact
// amount (review=1); nothing is signed until the person confirms there and in their wallet
const BUYS = ["0.005", "0.01", "0.05"];
const NETS = [
  { key: "robinhood", label: "Robinhood", name: "Robinhood Chain" },
  { key: "base", label: "Base", name: "Base" },
  { key: "arbitrum", label: "Arbitrum", name: "Arbitrum One" },
  { key: "solana", label: "Solana", name: "Solana" },
];
const netOf = (k) => NETS.find((n) => n.key === k) || NETS[0];
const nativeOf = (k) => (k === "solana" ? "SOL" : "ETH");
const sameAddr = (x, y) => !!x && !!y && (/^0x/i.test(x) ? x.toLowerCase() === String(y).toLowerCase() : x === y);

// A live /api/swap/gate answer in the badge's shape. The word comes from verdict.js, the one reading Swap and the badge
// use too, and Swap's own pass is kept (with the route's venue and curve depth), so the page never offers a buy Swap
// blocks nor calls "no buyers yet" a coin that Swap blocks.
export function fromGate(g, a, chain, size, curve = null) {
  const checks = (g?.checks || []).map(({ key, label, status, detail }) => ({ key, label, status, detail }));
  const t = g?.quote?.tokenOut || {};
  const quote = g?.quote ? { venue: g.quote.venue, poolLiquidity: g.quote.poolLiquidity || null } : null;
  const v = verdictOf({ pass: g?.pass, checks, quote, curve });
  return {
    token: a, symbol: String(t.symbol || "").slice(0, 24), name: String(t.name || "").slice(0, 48), image: t.image || null,
    verdict: v.legacy, word: v.word, pass: g?.pass, quote, reason: v.why && v.word !== "passed" ? `${v.why.label}: ${v.why.detail}` : null,
    checks, curve, checkedAt: g?.checkedAt || Date.now(), chain, amount: size, live: true,
  };
}
// a 0x address the Robinhood Chain route could not even read as a token (maybe it lives on Base or Arbitrum)
export const notToken = (r) => r?.checks?.length === 1 && r.checks[0].key === "route" && r.checks[0].status === "fail" && !r.symbol;
// review: Swap opens its Review the moment its own Gate run passes (the person still confirms there and signs in the wallet)
export const swapHref = (a, chain, amount, review = false) => `#/swap?${new URLSearchParams({ ...(chain && chain !== "robinhood" ? { chain } : {}), out: a, amount, ...(review ? { review: "1" } : {}) })}`;

// a small segmented choice in the .seg look; set(v) repaints it. Tight buttons, so the four networks fit one line on a
// 390 px phone (it wraps only on narrower screens)
function choice(label, opts, value, onPick) {
  const box = h("div", { class: "seg", role: "group", "aria-label": label, style: { flexWrap: "wrap", maxWidth: "100%" } });
  box.set = (v) => {
    box.value = v;
    clear(box, opts.map((o) => h("button", { type: "button", "aria-pressed": String(o.value === v), style: { display: "inline-flex", alignItems: "center", gap: "4px", padding: "0 7px", fontSize: "12px" }, onclick: () => onPick(o.value) }, o.label)));
  };
  box.set(value);
  return box;
}

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

/* ---------- V7 Athena on every coin: Ring Radar, Oath, smart money, Quantum-Ready, Aegis, and the Council on demand ---------- */
function athenaBox(addr) {
  const dl = h("dl", { class: "dk-assay-facts" });
  const rows = {};
  const row = (k, label) => { const dd = h("dd", {}, h("span", { class: "fine" }, "reading…")); rows[k] = dd; dl.append(h("dt", {}, label), dd); };
  row("ring", "Ring Radar"); row("app", "Robinhood app"); row("oath", "Oath"); row("smart", "Smart money"); row("quantum", "Quantum-Ready"); row("aegis", "Aegis");
  const set = (k, ...nodes) => { if (rows[k]) clear(rows[k], ...nodes); };
  const council = h("div", { class: "dk-council" });
  const councilBtn = h("button", { class: "btn sm", type: "button" }, icon("spark"), "Ask the Council");
  councilBtn.addEventListener("click", async () => {
    councilBtn.disabled = true;
    clear(council, h("div", { class: "dk-assay-b" }, h("span", { class: "ag-spin" }), h("span", { class: "fine" }, "Three analysts are reading Troya's facts on this coin (up to a minute)…")));
    let c;
    try { c = await api.get(`/api/council/${addr}`); } catch (e) { clear(council, h("p", { class: "fine" }, `The Council could not sit: ${e.message}`)); councilBtn.disabled = false; return; }
    const list = (title, xs, cls) => (xs?.length ? h("div", { class: `dk-cl ${cls}` }, h("b", {}, title), h("ul", {}, xs.map((x) => h("li", {}, x)))) : null);
    clear(council,
      h("p", {}, h("span", { class: `dk-v v-${c.verdict === "pass" ? "passed" : c.verdict === "avoid" ? "failed" : "caution"}` }, `Council: ${c.verdict}`), c.debate?.summary ? h("span", { class: "fine" }, ` ${c.debate.summary}`) : null),
      list("Three reasons not to buy", c.counsel.map((r) => r.reason), "cl-counsel"),
      list("Bull", c.debate?.bull, "cl-bull"), list("Bear", c.debate?.bear, "cl-bear"), list("Risk", c.debate?.risk, "cl-risk"),
      h("p", { class: "fine" }, "Every point cites Troya's own facts; nothing from X or websites reaches the analysts. ", c.receipt ? h("a", { class: "link", href: `/api/seal/r/${c.receipt}`, target: "_blank", rel: "noopener" }, "Sealed receipt") : null));
  });
  const box = h("section", { class: "dk-assay dk-athena" },
    h("div", { class: "dk-assay-h" }, h("b", {}, "Athena"), h("span", { class: "fine" }, "V7: rigged launches, dev pledges, smart money, after-buy guard")),
    h("div", { class: "dk-assay-b" }, dl), h("div", { class: "dk-gate-a" }, councilBtn, h("a", { class: "btn sm", href: "#/agent/aegis" }, icon("shield"), "Guard my coins")), council);
  const get = (u) => api.get(u).catch((e) => ({ error: e.message }));
  setTimeout(async () => {
    get(`/api/ring/${addr}`).then((r) => set("ring", r.error ? h("span", { class: "fine" }, "unavailable") : r.verdict === "unknown" ? h("span", { class: "fine" }, "not a recent Pons launch") : h("span", { class: `af-${r.verdict === "red" ? "red" : r.verdict === "amber" ? "amber" : "clear"}` }, h("b", {}, r.verdict), ` · ${(r.reasons || []).slice(0, 2).join("; ")}`)));
    get(`/api/radar/app/${addr}`).then((x) => set("app", h("span", {}, x.error ? "unavailable" : x.listed ? h("b", {}, x.tradable ? "tradable in the Robinhood app" : "shown in the Robinhood app (price only)") : "not in the Robinhood app")));
    get(`/api/oath/${addr}`).then((o) => set("oath", o.status === "none" || o.error ? h("span", { class: "fine" }, "no Oath taken · ", h("a", { class: "link", href: "/oath" }, "devs sign here")) : h("span", {}, h("b", {}, o.status === "kept" ? "kept" : "broken"), ` · max ${o.pledge.maxSellPctPerDay}% a day${o.pledge.feeLockDays ? `, fees locked ${o.pledge.feeLockDays}d` : ""}${o.breaches?.length ? ` · ${o.breaches.length} breach${o.breaches.length > 1 ? "es" : ""}` : ""}`)));
    get(`/api/radar/smart/${addr}`).then((s) => set("smart", h("span", {}, s.summary || s.note || "unavailable")));
    get(`/api/quantum/token/${addr}`).then((q) => set("quantum", h("span", {}, q.summary || "unavailable")));
    get(`/api/aegis/token/${addr}`).then((g) => set("aegis", h("span", {}, g.guarded ? `guarded${g.sellTest ? ` · last sell test ${g.sellTest.ok ? `passed, tax ${Number(g.sellTest.tax || 0).toFixed(1)}%` : "failed"}` : ""}${g.events?.[0] ? ` · ${g.events[0].level}: ${g.events[0].text}` : ""}` : "nobody guards it yet")));
  }, 120);
  return box;
}

export function gatePanel({ go, ask, compact = false, start = "", chain: startChain = "", amount: startAmount = "" } = {}) {
  const input = h("input", { class: "input dk-gate-in", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "Search a coin (TROYA, NVDA…) or paste its address", "aria-label": "Coin name, ticker or address", maxlength: "80" });
  // a pick from the dropdown is a Robinhood Chain coin: that is what the search covers
  const inputBox = coinSuggest(input, (c) => { input.value = c.address; run(c.address, { net: "robinhood" }); }, { majors: false });
  const runBtn = h("button", { class: "btn primary", type: "button" }, icon("shield"), "Run the Gate");
  const out = h("div", { class: "dk-gate-out", "aria-live": "polite" });
  const st = {
    chain: NETS.some((n) => n.key === startChain) ? startChain : "robinhood",
    size: SIZES.includes(String(startAmount)) ? String(startAmount) : BADGE_SIZE,
    picked: NETS.some((n) => n.key === startChain),   // a network chosen on purpose (a chip or ?chain=) carries over to the next coin
  };
  let alive = true, seq = 0, last = null, extras = null;
  const kept = new Map();   // the newest badge answer per coin (the browser may keep an older copy of the same URL for two minutes)

  // the size and network to check (full page): picking one runs the Gate again on the coin on screen
  // reads as one line: "Check a [0.01 | 0.1 | 1] ETH buy on [Robinhood | Base | Arbitrum | Solana]"
  const unit = h("span", { class: "fine" }, `${nativeOf(st.chain)} buy on`);
  const sizeSeg = choice("Buy size to check", SIZES.map((v) => ({ value: v, label: v })), st.size, (v) => {
    if (v === st.size) return;
    st.size = v; sizeSeg.set(v);
    if (last?.token) run(last.token, { example: last.example, net: st.chain });
  });
  const netSeg = choice("Network", NETS.map((n) => ({ value: n.key, label: [chainLogo(n.key, 14), n.label] })), st.chain, pickNet);
  const row = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" };
  const opts = compact ? null : h("div", { class: "dk-gate-opts", style: { ...row, gap: "8px 10px", marginTop: "12px" } },
    h("div", { style: row }, h("span", { class: "fine" }, "Check a"), sizeSeg, unit), netSeg);
  const setNet = (k) => { st.chain = k; netSeg.set(k); unit.textContent = `${nativeOf(k)} buy on`; };
  const fits = (a, k) => (k === "solana" ? MINT.test(a || "") : /^0x[0-9a-fA-F]{40}$/.test(a || ""));

  function pickNet(k) {
    if (k === st.chain) return;
    st.picked = true;
    const a = [last && !last.example ? last.token : null, input.value.trim()].find((x) => fits(x, k));
    setNet(k);
    if (a) run(a, { net: k, auto: false });
    else { toast(`Paste a ${netOf(k).name} coin's address to check it there.`, "", 4500); input.focus(); }
  }

  // the coin on screen stays, dimmed, while the same coin is checked again at a new size or network (render() replaces
  // the dimmed nodes; busy(false) clears the flag)
  function busy(on, text = "") {
    for (const el of out.querySelectorAll(".dk-gate-h, .dk-gate-buy, .dk-checks")) { el.style.opacity = on ? ".5" : ""; el.style.pointerEvents = on ? "none" : ""; }
    if (on) out.setAttribute("aria-busy", "true"); else out.removeAttribute("aria-busy");
    const m = out.querySelector(".dk-gate-meta");
    if (on && m) clear(m, h("span", { class: "ag-spin", style: { width: "12px", height: "12px", marginRight: "8px", verticalAlign: "-2px" } }), text);
  }

  // one check: the badge's answer for the default 0.01 ETH on Robinhood Chain (memoized, ?fresh=1 for a new run), and the
  // live /api/swap/gate for any other size or network (the same call Swap makes before it lets anyone sign)
  async function check(a, chain, size, fresh) {
    try {
      if (chain === "robinhood" && size === BADGE_SIZE) {
        const r = await api.get(`/api/badge/${a}${fresh ? "?fresh=1" : ""}`);
        const k = a.toLowerCase(), prev = kept.get(k);
        if (r?.freshLimited) toast("Fresh runs are limited to six a minute. This is the latest check.", "", 4500);
        if (prev && r?.checkedAt && prev.checkedAt > r.checkedAt) return { ...prev, live: false, cached: true };
        // "just now" only when the server says it ran the check for this request
        const v = { ...r, chain, amount: BADGE_SIZE, live: !!fresh && r?.cached === false };
        if (r?.checks) { kept.set(k, v); if (kept.size > 30) kept.delete(kept.keys().next().value); }
        return v;
      }
      const g = await api.get(`swap/gate?${new URLSearchParams({ in: nativeOf(chain), out: a, amount: size, ...(chain === "robinhood" ? {} : { chain }) })}`);
      return fromGate(g, a, chain, size, chain === "robinhood" ? kept.get(a.toLowerCase())?.curve || null : null);
    } catch (e) { return { verdict: "error", error: e.message, chain, amount: size }; }
  }

  // a 0x address that is no token on this network: look it up on the other EVM networks (read-only token lookups)
  async function elsewhere(a, here) {
    const keys = ["robinhood", "base", "arbitrum"];
    const found = await Promise.all(keys.map((k) => api.get(`token/meta?${new URLSearchParams({ address: a, ...(k === "robinhood" ? {} : { chain: k }) })}`).then((m) => !!m?.address, () => false)));
    if (found[keys.indexOf(here)]) return null;       // a real token here with no route: that fail stands
    return keys.find((k, i) => k !== here && found[i]) || null;
  }

  async function run(raw, { example = false, fresh = false, net = null, auto = true } = {}) {
    const text = String(raw || "").trim();
    let a = ADDR.exec(text)?.[0] || (MINT.test(text) ? text : null);
    let chain = net || st.chain;
    // a new coin starts on Robinhood Chain unless a network was picked on purpose
    if (!net && a && !st.picked && !(last && sameAddr(last.token, a))) chain = "robinhood";
    if (a && !/^0x/i.test(a)) chain = "solana";              // base58: only a Solana coin looks like this
    else if (a && chain === "solana") chain = "robinhood";   // a 0x address is never a Solana coin
    if (!a && text) {
      // a name or a ticker: the search covers Robinhood Chain coins (the real coin ranks first; copies are marked in the
      // dropdown). Elsewhere an address is needed, so a copy is never gated, and offered, by mistake.
      if (chain !== "robinhood") { toast(`Paste the coin's address to check it on ${netOf(chain).name}.`, "error"); input.focus(); return; }
      const c = await findCoin(text).catch(() => null);
      if (!alive) return;
      if (c?.address) a = c.address;
      else { toast(`No Robinhood Chain coin matches "${text}". Paste its address instead.`, "error"); input.focus(); return; }
    }
    if (!a) { input.focus(); return; }
    setNet(chain);
    const id = ++seq, size = st.size;
    if (!example) input.value = a;
    runBtn.disabled = true;
    if (last && sameAddr(last.token, a) && out.querySelector(".dk-gate-meta")) busy(true, `Checking a ${size} ${nativeOf(chain)} buy on ${netOf(chain).name}…`);
    else clear(out, h("div", { class: "dk-gate-wait" }, h("span", { class: "ag-spin" }), h("span", {}, chain === "solana" ? "Reading the route, liquidity, the mint's powers and a sell route…" : "Reading the route, the pool, fees and a test sell…")));
    let r = await check(a, chain, size, fresh);
    if (!alive || id !== seq) return;
    let moved = null;
    if (auto && chain !== "solana" && notToken(r)) {
      const k = await elsewhere(a, chain);
      if (!alive || id !== seq) return;
      if (k) {
        moved = { from: chain, to: k };
        setNet(k);
        r = await check(a, k, size, false);
        if (!alive || id !== seq) return;
      }
    }
    runBtn.disabled = false;
    busy(false);
    last = { token: a, example };
    if (!compact && !example) {
      const p = new URLSearchParams();
      if (st.chain !== "robinhood") p.set("chain", st.chain);
      if (size !== BADGE_SIZE) p.set("amount", size);
      const want = `#/gate/${a}${String(p) ? `?${p}` : ""}`;
      if (location.hash !== want) history.replaceState(null, "", want);
    }
    render(a, r, example, moved);
  }

  // "Checked for a 0.01 ETH buy · cached 2m ago · Run fresh": what the verdict is for, and how old it is
  function meta(a, r, example, moved) {
    const chain = r.chain || "robinhood";
    const age = r.checkedAt ? Date.now() - r.checkedAt : null;
    const cached = !r.live && (r.cached === true || (age != null && age > 60_000));
    const when = age == null ? "" : !cached && age < 60_000 ? "just now" : `${ago(r.checkedAt)} ago`;
    return h("p", { class: "fine dk-gate-meta", style: { margin: "12px 0 0" } },
      moved ? `Not a token on ${netOf(moved.from).name}, so the Gate ran on ${netOf(moved.to).name}. ` : null,
      `Checked for a ${r.amount || BADGE_SIZE} ${nativeOf(chain)} buy${chain === "robinhood" ? "" : ` on ${netOf(chain).name}`}`,
      when ? ` · ${cached ? "cached " : ""}${when}` : null,
      cached ? [" · ", h("button", { class: "link", type: "button", onclick: () => run(a, { example, fresh: true, net: chain, auto: false }) }, "Run fresh")] : null);
  }

  // the Assay and Athena read Robinhood Chain history; they are kept while the same coin is checked at another size
  function extrasFor(a, example) {
    const key = `${a.toLowerCase()}|${example ? "ex" : ""}`;
    if (extras?.key !== key) extras = { key, nodes: [assayBox(a, compact), compact || example ? null : athenaBox(a)] };
    return extras.nodes;
  }

  function render(a, r, example, moved) {
    const chain = r.chain || "robinhood", rh = chain === "robinhood", nat = nativeOf(chain), net = netOf(chain);
    const size = r.amount || BADGE_SIZE;
    if (r.verdict === "error" || !r.checks) {
      clear(out, h("div", { class: "dk-empty" }, h("b", {}, `The Gate could not read this coin on ${net.name} right now.`), h("p", {}, r.error || r.reason || "Try again in a minute."), h("button", { class: "btn sm", type: "button", onclick: () => run(a, { example, net: chain, auto: false }) }, icon("refresh"), "Try again")), opts);
      return;
    }
    // one verdict, the same Swap and the badge show: the pill, the ring, the note, the buttons and the nudge all follow it
    const v = verdictOf(r), sym = r.symbol ? `$${r.symbol}` : "this coin";
    const sum = r.checks.map((c) => `${c.label}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Gate result for ${r.symbol ? "$" + r.symbol : a} (${a}) on ${net.name}, checked for a ${size} ${nat} buy: ${v.label}. ${v.sentence} ${sum}` } }));
    // a bigger test size that only fails on price impact says more about the size than the coin: no nudge for that
    const sizeOnly = size !== BADGE_SIZE && r.checks.every((c) => c.status !== "fail" || c.key === "impact");
    if (!example && !sizeOnly && v.nudge) dispatchEvent(new CustomEvent("troya:nudge", { detail: { key: `gate-${a}-${chain}-${v.word}`, text: `${r.symbol ? "$" + r.symbol : "This coin"} ${v.nudge}. Want me to explain?`, q: `Explain this Gate result for ${r.symbol ? "$" + r.symbol : a} on ${net.name} in plain words: what failed or needs a look, and what it means for me.` } }));
    // "6 passed · 1 not measured" reads clearer than "6 of 7 passed" next to a Passed verdict
    const c = tallyOf(r.checks);
    const total = r.checks.length || 7, frac = Math.max(0, Math.min(1, c.passed / total)), C = 2 * Math.PI * 50;
    const ringEl = h("span", { class: `dk-ring v-${v.cls}`, role: "img", "aria-label": `${c.passed} of ${total} checks passed` });
    ringEl.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${C}"/></svg><b>${c.passed}/${total}</b>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const x = ringEl.querySelector(".rb"); if (x) x.style.strokeDasharray = `${frac * C} ${C}`; }));
    const has = (b) => v.buttons.includes(b);
    // price impact is measured at the size checked, so a fail at 1 ETH can be a pass at 0.01
    const impactFail = v.word === "blocked" && v.why?.key === "impact";
    const hint = impactFail && Number(size) > Number(SIZES[0]) ? ` That is for a ${size} ${nat} buy; a smaller one may pass.` : "";
    clear(out,
      h("div", { class: "dk-gate-h" },
        ringEl,
        tokenIcon({ symbol: r.symbol, address: a, chain, image: r.image }, ""),
        h("div", { class: "dk-gate-id" },
          h("b", {}, r.symbol ? `$${r.symbol}` : short(a)), gateIdLine(r, a, chain)),
        h("div", { class: "dk-gate-v" },
          h("span", { class: `dk-v v-${v.cls}` }, v.label),
          h("span", { class: "fine" }, c.text))),
      // the buy sits right under the verdict, not past the checks, the Assay and Athena. Swap runs the Gate again at the
      // exact amount and opens its review once that passes (review=1); the person confirms there and in the wallet
      has("buy") ? h("div", { class: "dk-gate-a dk-gate-buy" },
        h("a", { class: `btn primary${compact ? " sm" : ""}`, href: swapHref(a, chain, size, true), title: `Opens the swap review for ${size} ${nat}. Swap runs the Gate again first; you confirm there and sign in your wallet.` }, icon("swap"), `Buy ${sym}`),
        has("amounts") ? h("div", { class: "chips", role: "group", "aria-label": `Buy ${sym} with`, style: { alignItems: "center" } },
          BUYS.map((x, i) => h("a", { class: "chip", href: swapHref(a, chain, x, true), "aria-label": `Review a buy of ${sym} with ${x} ${nat}`, style: { height: compact ? "28px" : "32px", padding: "0 10px", fontVariantNumeric: "tabular-nums" } }, i === BUYS.length - 1 ? `${x} ${nat}` : x))) : null) : null,
      meta(a, r, example, moved),
      opts,
      example ? h("p", { class: "fine dk-gate-ex" }, "Live example: NVDA, a Robinhood stock token. Paste any coin above to check it.") : null,
      h("ol", { class: "dk-checks" }, r.checks.map((x) => h("li", { class: `c-${x.status}` },
        h("span", { class: "dk-ck" }, x.status === "pass" ? icon("check") : x.status === "fail" ? icon("close") : h("b", {}, x.status === "warn" ? "!" : "–")),
        h("span", { class: "dk-ck-l" }, x.label),
        h("span", { class: "dk-ck-d" }, x.detail || "")))),
      r.curve && r.curve.progressPct != null ? h("div", { class: "dk-curve" }, h("span", {}, `Pons curve · ${Number(r.curve.raised || 0).toFixed(2)} ${r.curve.pair || "ETH"} raised`), h("div", { class: "dk-bar", style: { "--p": `${Math.min(100, r.curve.progressPct)}%` } }, h("i")), h("span", { class: "fine" }, `${r.curve.progressPct.toFixed(1)}% to graduation`)) : null,
      h("p", { class: `note dk-gate-note v-${v.cls}` }, h("b", {}, v.sentence), ` ${v.note}${hint}`),
      rh ? extrasFor(a, example) : compact ? null : h("p", { class: "fine" }, "The Assay and Athena read Robinhood Chain coins, so they are not shown here."),
      h("div", { class: "dk-gate-a" },
        rh && has("fomo") ? h("a", { class: "btn sm dk-fomo", href: `https://fomo.family/tokens/robinhood/${a}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/fomo.png", alt: "", width: 18, height: 18 }), "Buy on Fomo") : null,
        rh && has("token") ? h("a", { class: "btn sm", href: `#/token/${a}` }, "Token page") : null,
        rh && !example ? h("a", { class: "btn sm", href: `#/heel/${a}`, title: "V9 Heel: its one weak spot in a sentence, with the transactions behind it" }, "Find its weak spot") : null,
        ask && has("ask") ? h("button", { class: "btn sm", type: "button", onclick: () => ask(`Is this token safe? ${a}${rh ? "" : ` (on ${net.name})`}`) }, icon("spark"), "Ask Troya") : null,
        ask && has("explain") ? h("button", { class: "btn sm", type: "button", onclick: () => ask(`Why did the Troya Gate block ${r.symbol ? "$" + r.symbol : a} (${a}) on ${net.name}? Explain it in plain words.`) }, icon("spark"), "Ask why") : null,
        rh && has("badge") ? h("a", { class: "btn sm", href: `/badge?ca=${a}`, target: "_blank", rel: "noopener" }, icon("shield"), "Get the badge") : null));
  }

  // pressing Run the Gate (or Enter) asks for a new check, not the badge's memo
  runBtn.addEventListener("click", () => run(input.value, { fresh: true }));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value, { fresh: true }); });
  input.addEventListener("paste", () => setTimeout(() => { const v = input.value.trim(); if (ADDR.test(v) || MINT.test(v)) run(v); }, 0));

  const el = h("section", { class: `panel dk-gate ${compact ? "compact" : ""}` },
    h("div", { class: "panel-h" }, h("h2", {}, "Troya Gate"), compact ? h("a", { class: "link fine", href: "#/gate" }, "Open the Gate") : h("a", { class: "link fine", href: "/risk-controls" }, "How the checks work")),
    h("p", { class: "dk-gate-sub" }, "Seven checks before you can buy: route, price impact, depth, fees and taxes, a simulation, a test sell and transfer tax. Fail one, no order."),
    h("div", { class: "dk-gate-form" }, inputBox, runBtn),
    out);

  const s = String(start || "").trim();
  if (ADDR.test(s) || MINT.test(s)) run(s);
  else run(EXAMPLE, { example: true, net: "robinhood" });   // the Desk's live example: a Robinhood stock token
  return { el, run, stop: () => { alive = false; } };
}

export async function mount(view, ctx) {
  useCss("home");
  const g = gatePanel({ go: ctx.go, ask: ctx.ask, start: ctx.parts[0] || ctx.query.ca || "", chain: ctx.query.chain, amount: ctx.query.amount });
  const how = [
    ["Route", "There is a real path from ETH to the coin: a Pons curve or a Uniswap pool."],
    ["Price impact", "How far your own buy moves the price, at the size checked: 0.01 ETH unless you pick 0.1 or 1."],
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
        h("p", { class: "note" }, "On Base and Arbitrum the same seven checks run; on Solana the Gate also reads the coin's mint and freeze authority."),
        h("p", { class: "note" }, "Results are checks, never endorsements. ", h("a", { class: "link", href: "/risk-controls" }, "Risk controls"), " · ", h("a", { class: "link", href: "/badge" }, "Gate badge for your site"))))));
  return () => g.stop();
}
