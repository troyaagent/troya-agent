// Home (#/): the agent desk. Ask box, onboarding steps, live stats, brief, signals, movers.
import { h, clear, icon, useCss, every, sparkline, pctEl, usd, compact, toast, store, infoTip, tokenIcon, coinIcon, logoUrl } from "../ui.js";
import { api, cached } from "../api.js";
import { wallet, onWallet, openConnect, reader } from "../wallet.js";
import { tokenCell, priceCell, usdCell, perpPrice, fmtApr } from "../marketlib.js";

const onboard = store("troya.onboard", {});
const hideSteps = store("troya.home.hideSteps", false);

export async function mount(view, { go }) {
  useCss("home");
  const stops = [];
  const ask = (q) => go(`#/agent?q=${encodeURIComponent(q)}`);

  /* ---------- hero + ask ---------- */
  const input = h("input", { class: "ask-in", type: "text", placeholder: "Ask Troya… \"is NVDA still being bought on Robinhood Chain?\"", "aria-label": "Ask your agent", maxlength: "500" });
  const submit = () => { const q = input.value.trim(); if (q) ask(q); else input.focus(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  const slash = (e) => { if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") { e.preventDefault(); input.focus(); } };
  addEventListener("keydown", slash);
  stops.push(() => removeEventListener("keydown", slash));

  const hero = h("section", { class: "home-hero" },
    h("div", { class: "eyebrow" }, h("i", { class: "dot" }), "Agent desk"),
    h("h1", {}, "Where should your agent look today?"),
    h("p", { class: "home-sub" }, "Say it in plain words. Troya pulls the numbers and checks the route; you sign off."),
    h("div", { class: "ask-bar" }, icon("spark", "ask-ico"), input, h("kbd", {}, "/"), h("button", { class: "btn primary", type: "button", onclick: submit }, "Ask", icon("arrowUp"))),
    h("div", { class: "chips ask-chips" },
      [["What's running hot?", "What is moving most on Robinhood Chain and Hyperliquid in the last 24 hours?"],
       ["Crowded funding", "Which Hyperliquid perps have the most stretched funding right now, and who is paying whom?"],
       ["How Troya works", "How does Troya work, and what can it do without my signature?"]]
        .map(([t, q]) => h("button", { class: "chip", type: "button", onclick: () => ask(q) }, t))));

  /* ---------- get started ---------- */
  const steps = h("section", { class: "panel steps" });
  let agentWallet = false, funded = false;
  function renderSteps() {
    if (hideSteps.get()) { steps.hidden = true; return; }
    const o = onboard.get();
    const list = [
      { k: "connect", t: "Connect", tip: "Link a browser wallet. Troya never sees its key.", done: !!wallet.address, act: wallet.address ? null : h("button", { class: "link", type: "button", onclick: () => openConnect() }, "Connect") },
      { k: "agent", t: "Agent Wallet", tip: "Optional small wallet the agent can use inside your caps.", done: agentWallet || !!o.agentWallet, act: h("a", { class: "link", href: "#/agent/wallet" }, "Create") },
      { k: "fund", t: "Fund it", tip: "Bring ETH onto Robinhood Chain through the bridge.", done: funded || !!o.funded, act: h("a", { class: "link", href: "#/bridge" }, "Bridge") },
      { k: "swap", t: "First swap", tip: "Try a small swap on Robinhood Chain.", done: !!o.swap, act: h("a", { class: "link", href: "#/swap" }, "Try it") },
    ];
    const n = list.filter((s) => s.done).length;
    clear(steps,
      h("div", { class: "steps-h" }, h("b", {}, "Get started"), h("span", { class: "badge-s" }, `${n}/4`), h("button", { class: "link hide-btn", type: "button", onclick: () => { hideSteps.set(true); renderSteps(); } }, "Hide")),
      h("ol", { class: "steps-list" }, list.map((s, i) => h("li", { class: s.done ? "done" : "" },
        h("span", { class: "sn" }, s.done ? icon("check") : String(i + 1)),
        h("div", {}, h("div", { class: "st" }, s.t, infoTip(s.tip)), s.done ? h("span", { class: "fine" }, "Done") : s.act)))));
    if (n === 4) steps.hidden = true;
  }
  async function checkSteps() {
    agentWallet = false; funded = false;
    if (wallet.address) {
      try { const b = await reader("robinhood").getBalance(wallet.address); funded = b > 0n; } catch {}
      if (wallet.session) { try { const aw = await api.get("agent-wallet"); agentWallet = !!(aw?.address || aw?.wallet?.address); } catch {} }
    }
    renderSteps();
  }
  renderSteps();
  stops.push(onWallet(() => { renderSteps(); checkSteps(); }));

  /* ---------- stats ---------- */
  const statHype = h("div", { class: "v" }, "–"), statHypeS = h("div", { class: "s" }, "Hyperliquid mid");
  const statTop = h("div", { class: "v" }, "–"), statTopS = h("div", { class: "s" }, " ");
  const statSig = h("div", { class: "v" }, "–"), statSigS = h("div", { class: "s" }, " ");
  const stats = h("section", { class: "stats" },
    h("div", { class: "stat" }, h("div", { class: "k" }, tokenIcon({ symbol: "ETH" }, "sm k-ico"), "ETH", infoTip("Live ETH/USD mid price from Hyperliquid. Gas on Robinhood Chain is paid in ETH, and ETH amounts convert to dollars at this price.")), statHype, statHypeS),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Top mover", infoTip("Largest 24h change among Hyperliquid perps with more than $1M of daily volume.")), statTop, statTopS),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Signals", infoTip("Live thresholds: stretched funding, big moves, hot new Robinhood Chain coins.")), statSig, statSigS));

  const status = h("div", { class: "home-status" });
  function renderStatus() {
    clear(status,
      h("span", {}, h("span", { class: "faint" }, "Wallet "), wallet.address ? h("span", {}, "Connected") : h("span", {}, "Not connected"), " ",
        wallet.address ? h("a", { class: "link", href: "#/portfolio" }, "Portfolio") : h("button", { class: "link", type: "button", onclick: () => openConnect() }, "Connect")),
      h("span", {}, h("span", { class: "faint" }, "Autopilot "), "Off ", h("a", { class: "link", href: "#/agent/autopilot" }, "Set up")));
  }
  renderStatus();
  stops.push(onWallet(renderStatus));

  /* ---------- brief + signals ---------- */
  const briefBody = h("div", { class: "panel-b" }, h("div", { class: "sk", style: { height: "80px" } }));
  const briefTime = h("span", { class: "fine" });
  const brief = h("section", { class: "panel brief" },
    h("div", { class: "panel-h" }, h("h2", {}, "Brief", infoTip("Written from live Hyperliquid and Robinhood Chain data each minute. Facts only, no forecasts.")), h("span", { class: "row" }, h("span", { class: "live-dot" }), briefTime)),
    briefBody);
  const sigBody = h("div", { class: "panel-b sig-list" }, h("div", { class: "sk", style: { height: "80px" } }));
  const sigs = h("section", { class: "panel signals" }, h("div", { class: "panel-h" }, h("h2", {}, "Signals", infoTip("Things worth a look right now. They are thresholds, not recommendations."))), sigBody);

  /* ---------- movers ---------- */
  const hlBody = h("tbody"), elyBody = h("tbody");
  const hlTable = h("section", { class: "panel movers" },
    h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid movers", infoTip("Perps with more than $1M of 24h volume, sorted by the size of the 24h move.")), h("a", { class: "link fine", href: "#/market?tab=perps" }, "All perps")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Market"), h("th", { class: "hide-s" }, ""), h("th", {}, "Price"), h("th", {}, "24h"), h("th", { class: "hide-s" }, "Funding/yr"), h("th", { class: "hide-s" }, "Volume"))), hlBody)));
  const elyTable = h("section", { class: "panel movers" },
    h("div", { class: "panel-h" }, h("h2", {}, "Hot on Robinhood Chain", infoTip("Robinhood Chain coins with the most volume in the last 24 hours, from GeckoTerminal pools (wash-traded pools left out).")), h("a", { class: "link fine", href: "#/market" }, "Full market")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Token"), h("th", {}, "Price"), h("th", {}, "24h"), h("th", { class: "hide-s" }, "Volume"))), elyBody)));
  hlBody.append(...skel(6, 6));
  elyBody.append(...skel(6, 4));

  clear(view, hero, steps, stats, status, h("div", { class: "home-grid" }, brief, sigs), h("div", { class: "home-grid even" }, hlTable, elyTable));

  /* ---------- data ---------- */
  stops.push(every(10000, async () => {
    try { const p = await api.get("price/eth"); statHype.textContent = usd(p.usd); } catch { statHypeS.textContent = "price unavailable"; }
  }));
  stops.push(every(30000, async () => {
    try {
      const d = await cached("market/hl", 8000);
      const liquid = d.markets.filter((m) => (m.volumeUsd || 0) >= 1e6 && m.change24h != null);
      const movers = [...liquid].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 7);
      if (movers[0]) { clear(statTop, h("span", { class: "tok-link" }, coinIcon(movers[0].coin, "k-big"), movers[0].coin)); clear(statTopS, h("span", { class: movers[0].change24h >= 0 ? "up" : "down" }, `${movers[0].change24h >= 0 ? "+" : ""}${movers[0].change24h.toFixed(2)}%`), " · 24h"); }
      let sparks = {};
      try { sparks = (await cached(`market/hl/sparks?coins=${movers.map((m) => encodeURIComponent(m.coin)).join(",")}`, 120000)).sparks || {}; } catch {}
      clear(hlBody, movers.map((m) => h("tr", { class: "click", onclick: () => go(`#/perps/${encodeURIComponent(m.coin)}`) },
        h("td", { class: "l" }, h("div", { class: "tok" }, coinIcon(m.coin), h("div", {}, h("b", {}, m.coin), h("small", {}, `OI ${usd(m.oiUsd, { compact: true })}`)))),
        h("td", { class: "hide-s" }, sparkline(sparks[m.coin])),
        h("td", {}, perpPrice(m.mark)), h("td", {}, pctEl(m.change24h)),
        h("td", { class: `hide-s ${Math.abs(m.fundingApr) >= 100 ? (m.fundingApr > 0 ? "warnc" : "down") : "muted"}` }, fmtApr(m.fundingApr)),
        h("td", { class: "hide-s" }, usd(m.volumeUsd, { compact: true })))));
    } catch (e) { clear(hlBody, h("tr", {}, h("td", { colspan: 6, class: "l muted" }, `Hyperliquid data is unavailable: ${e.message}`))); }
  }));
  stops.push(every(30000, async () => {
    try {
      const d = await cached("market/robinhood?sort=volume&limit=7", 15000);
      clear(elyBody, d.tokens.slice(0, 7).map((t) => h("tr", { class: "click", onclick: () => go(`#/token/${t.address}`) },
        h("td", { class: "l" }, tokenCell(t)),
        h("td", {}, priceCell(t.priceEth, t.priceUsd)), h("td", {}, pctEl(t.change24h)), h("td", { class: "hide-s" }, usdCell(t.volume24hUsd, null)))));
      if (!d.tokens.length) clear(elyBody, h("tr", {}, h("td", { colspan: 4, class: "l muted" }, "No Robinhood Chain coins returned.")));
    } catch (e) { clear(elyBody, h("tr", {}, h("td", { colspan: 4, class: "l muted" }, `The Robinhood Chain board is unavailable: ${e.message}`))); }
  }));
  stops.push(every(60000, async () => {
    try {
      const b = await api.get("brief");
      briefTime.textContent = b.stale ? "last good copy" : "live";
      clear(briefBody, h("ul", { class: "brief-list" }, b.items.map((it) => h("li", {}, it.text))),
        h("button", { class: "link", type: "button", onclick: () => ask("Walk me through today's brief: what stands out and what should I watch?") }, "Ask about the brief →"),
        b.stale ? h("p", { class: "note" }, "A source is slow right now, so this is the last good copy.") : null);
    } catch (e) { clear(briefBody, h("p", { class: "muted" }, `The brief could not be built right now (${e.message}).`)); }
  }));
  let showAll = false;
  let lastSignals = [];
  const renderSignals = () => {
    const list = showAll ? lastSignals : lastSignals.slice(0, 5);
    if (!lastSignals.length) { clear(sigBody, h("p", { class: "muted" }, "Nothing crosses the thresholds right now.")); return; }
    clear(sigBody, list.map((s) => h("div", { class: `sig ${s.kind}` },
      h("span", { class: "sig-k" }, { funding: "Funding", move: "Move", volume: "Volume", new: "New" }[s.kind] || s.kind),
      h("div", { class: "sig-t" }, h("b", { class: "tok-link" }, s.coin ? coinIcon(s.coin, "sm") : s.address ? tokenIcon({ symbol: s.symbol, address: s.address, image: s.image }, "sm") : null, s.title), h("span", {}, s.detail)),
      h("div", { class: "sig-a" },
        h("button", { class: "link", type: "button", onclick: () => watch(s) }, "Watch"),
        h("button", { class: "link", type: "button", onclick: () => ask(`${s.title}. ${s.detail} What does this mean and is there a trade here inside my limits?`) }, "Ask"),
        h("button", { class: "link", type: "button", onclick: () => go(s.coin ? `#/perps/${encodeURIComponent(s.coin)}` : `#/token/${s.address}`) }, "Open")))),
      lastSignals.length > 5 ? h("button", { class: "link fine", type: "button", onclick: () => { showAll = !showAll; renderSignals(); } }, showAll ? "Show fewer" : `${lastSignals.length - 5} more`) : null);
  };
  stops.push(every(45000, async () => {
    try {
      const d = await api.get("signals");
      lastSignals = d.signals || [];
      statSig.textContent = String(d.total ?? lastSignals.length);
      statSigS.textContent = `${Math.min(5, lastSignals.length)} on screen`;
      renderSignals();
    } catch (e) { clear(sigBody, h("p", { class: "muted" }, `Signals are unavailable right now (${e.message}).`)); }
  }));

  // "Watch" hands the idea to the agent's playbooks if signed in; otherwise explain what is needed
  async function watch(s) {
    if (!wallet.session) { toast("Sign in from the Agent page to set up watches.", ""); go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}`); return; }
    go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}&kind=${s.kind}`);
  }

  return () => stops.forEach((f) => { try { f(); } catch {} });
}

function skel(n, cols) {
  return Array.from({ length: n }, () => h("tr", {}, Array.from({ length: cols }, (_, i) => h("td", { class: i === 0 ? "l" : "" }, h("div", { class: "sk", style: { height: "14px", width: i === 0 ? "110px" : "48px", marginLeft: i === 0 ? "0" : "auto" } })))));
}
