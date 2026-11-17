// Desk (#/): one calm page that answers "where am I, what's moving, what is my agent doing, what next".
// Everything the old Home had (ask box, the four start steps, live stats, brief, signals, movers) plus
// the Gate, the agent's status, Sentry's latest results and shortcuts to every tool.
import { h, clear, icon, useCss, every, sparkline, pctEl, usd, toast, store, infoTip, tokenIcon, coinIcon, short, ago, greeting } from "/agent/js/ui.js";
import { api, cached } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, reader, signIn } from "/agent/js/wallet.js";
import { tokenCell, priceCell, usdCell, perpPrice, fmtApr } from "/agent/js/marketlib.js";
import { gatePanel } from "./gate.js";
import { chromeIcon } from "./chrome-icons.js";

const onboard = store("troya.onboard", {});
const hideSteps = store("troya.home.hideSteps", false);
const autoPref = store("troya.autopilot", { on: false, playbooks: true, chat: false });

export async function mount(view, { go, ask: askDrawer }) {
  useCss("home");
  const stops = [];
  const ask = (q) => (askDrawer ? askDrawer(q) : go(`#/agent?q=${encodeURIComponent(q)}`));

  /* ---------- greeting + ask ---------- */
  const input = h("input", { class: "ask-in", type: "text", placeholder: "Ask Troya… \"is NVDA still being bought on Robinhood Chain?\"", "aria-label": "Ask your agent", maxlength: "500" });
  const submit = () => { const q = input.value.trim(); if (q) { ask(q); input.value = ""; } else input.focus(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  const slash = (e) => { if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { e.preventDefault(); input.focus(); } };
  void slash;

  const head = h("section", { class: "dk-head" },
    h("div", { class: "dk-hello" },
      h("p", { class: "dk-eyebrow" }, h("i", { class: "live-dot" }), "Agent desk · Robinhood · Base · Arbitrum · Solana · Hyperliquid"),
      h("h1", {}, h("em", {}, `${greeting()}.`), " Where should your agent look today?"),
      h("p", { class: "dk-sub" }, "Say it in plain words. Troya pulls the numbers and checks the route; you sign off.")),
    h("div", { class: "dk-ask" },
      h("div", { class: "ask-bar" }, icon("spark", "ask-ico"), input, h("kbd", {}, "/"), h("button", { class: "btn primary", type: "button", onclick: submit }, "Ask", icon("arrowUp"))),
      h("div", { class: "chips ask-chips" },
        [["What's running hot?", "What is moving most on Robinhood Chain and Hyperliquid in the last 24 hours?"],
         ["Crowded funding", "Which Hyperliquid perps have the most stretched funding right now, and who is paying whom?"],
         ["How Troya works", "How does Troya work, and what can it do without my signature?"]]
          .map(([t, q]) => h("button", { class: "chip", type: "button", onclick: () => ask(q) }, t)))));

  /* ---------- start in four steps (same steps and storage as before) ---------- */
  const steps = h("section", { class: "dk-steps" });
  let agentWallet = false, funded = false;
  function renderSteps() {
    if (hideSteps.get()) { steps.hidden = true; return; }
    const o = onboard.get();
    const list = [
      { t: "Connect", tip: "Link a browser wallet. Troya never sees its key.", done: !!wallet.address, act: () => openConnect(), label: "Connect wallet" },
      { t: "Agent Wallet", tip: "Optional small wallet the agent can use inside your caps.", done: agentWallet || !!o.agentWallet, href: "#/agent/wallet", label: "Create" },
      { t: "Fund it", tip: "Bring ETH onto Robinhood Chain through the bridge.", done: funded || !!o.funded, href: "#/bridge", label: "Bridge" },
      { t: "First swap", tip: "Try a small swap on Robinhood Chain. The Gate runs before you sign.", done: !!o.swap, href: "#/swap", label: "Try it" },
    ];
    const n = list.filter((s) => s.done).length;
    const next = list.findIndex((s) => !s.done);
    steps.hidden = n === 4;
    clear(steps,
      h("div", { class: "dk-steps-h" },
        h("div", {}, h("b", {}, "Start in four steps"), h("span", { class: "fine" }, ` ${n} of 4 done`)),
        h("div", { class: "dk-bar", style: { "--p": `${(n / 4) * 100}%` } }, h("i")),
        h("button", { class: "link fine", type: "button", onclick: () => { hideSteps.set(true); renderSteps(); } }, "Hide")),
      h("ol", { class: "dk-steps-list" }, list.map((s, i) => h("li", { class: s.done ? "done" : i === next ? "next" : "" },
        h("span", { class: "sn" }, s.done ? icon("check") : String(i + 1)),
        h("div", { class: "st" }, h("b", {}, s.t), h("p", {}, s.tip)),
        s.done ? h("span", { class: "fine" }, "Done")
          : s.href ? h("a", { class: `btn sm ${i === next ? "primary" : ""}`, href: s.href }, s.label)
          : h("button", { class: `btn sm ${i === next ? "primary" : ""}`, type: "button", onclick: s.act }, s.label)))));
  }
  async function checkSteps() {
    agentWallet = false; funded = false;
    if (wallet.address) {
      try { const b = await reader("robinhood").getBalance(wallet.address); funded = b > 0n; } catch {}
      if (wallet.session) { try { const aw = await api.get("agent-wallet"); agentWallet = !!(aw?.address || aw?.wallet?.address || aw?.exists); } catch {} }
    }
    renderSteps();
  }
  renderSteps();
  stops.push(onWallet(() => { renderSteps(); checkSteps(); }));

  /* ---------- live stats ---------- */
  const statEth = h("div", { class: "v" }, "–"), statEthS = h("div", { class: "s" }, "Hyperliquid mid");
  const statTop = h("div", { class: "v" }, "–"), statTopS = h("div", { class: "s" }, " ");
  const statSig = h("div", { class: "v" }, "–"), statSigS = h("div", { class: "s" }, " ");
  const statYou = h("div", { class: "v dk-you" }), statYouS = h("div", { class: "s" });
  const stats = h("section", { class: "stats dk-stats" },
    h("div", { class: "stat" }, h("div", { class: "k" }, tokenIcon({ symbol: "ETH" }, "sm k-ico"), "ETH", infoTip("Live ETH/USD mid price from Hyperliquid. Gas on Robinhood Chain is paid in ETH, and ETH amounts convert to dollars at this price.")), statEth, statEthS),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Top mover", infoTip("Largest 24h change among Hyperliquid perps with more than $1M of daily volume.")), statTop, statTopS),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Signals", infoTip("Live thresholds: stretched funding, big moves, hot new Robinhood Chain coins.")), statSig, statSigS),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Your desk", infoTip("Your wallet and whether Autopilot is running in this browser.")), statYou, statYouS));
  function renderYou() {
    const on = !!autoPref.get().on;
    clear(statYou, wallet.address ? short(wallet.address) : "No wallet");
    clear(statYouS,
      wallet.address ? h("a", { class: "link", href: "#/portfolio" }, "Portfolio") : h("button", { class: "link", type: "button", onclick: () => openConnect() }, "Connect"),
      " · Autopilot ", h("b", { class: on ? "up" : "" }, on ? "On" : "Off"), " ", h("a", { class: "link", href: "#/agent/autopilot" }, on ? "Open" : "Set up"));
  }
  renderYou();
  stops.push(onWallet(renderYou));

  /* ---------- the agent: wallet, autopilots, playbooks, alerts ---------- */
  const agentBody = h("div", { class: "dk-agent-b" });
  const agent = h("section", { class: "panel dk-agent" },
    h("div", { class: "panel-h" }, h("h2", {}, "Your agent", infoTip("What the agent may do for you, and what is running now. Nothing moves without your caps and your rules.")), h("a", { class: "link fine", href: "#/agent/wallet" }, "Agent settings")),
    agentBody);
  const line = (ic, t, val, href, cls = "") => h("a", { class: `dk-line ${cls}`, href }, h("span", { class: "dk-line-ic" }, icon(ic)), h("span", { class: "dk-line-t" }, t), h("span", { class: "dk-line-v" }, val), icon("arrowRight", "dk-line-go"));
  async function renderAgent() {
    if (!wallet.session) {
      clear(agentBody,
        h("div", { class: "dk-lock" },
          h("p", {}, wallet.address ? "Sign in once to see your Agent Wallet, Autopilot and playbooks. Signing proves the wallet is yours; it costs nothing and sends nothing." : "Connect a wallet and sign in to give Troya an Agent Wallet with caps, rules for Autopilot and playbooks that watch for you."),
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), wallet.address ? "Sign in" : "Connect wallet")),
        line("wallet", "Agent Wallet", "Small wallet with daily caps", "#/agent/wallet", "dim"),
        line("bolt", "Autopilot", "Runs approved tickets in this tab", "#/agent/autopilot", "dim"),
        line("eye", "Sentry Autopilot", "Your rules on every new launch", "#/agent/sentry", "dim"),
        line("clock", "Playbooks", "Alerts and orders on triggers", "#/agent/playbooks", "dim"));
      return;
    }
    clear(agentBody, h("div", { class: "sk", style: { height: "150px" } }));
    const [aw, ap, wt, nt] = await Promise.all([
      api.get("agent-wallet").catch(() => null), api.get("autopilot").catch(() => null),
      api.get("watches").catch(() => null), api.get("notify/status").catch(() => null)]);
    const pilot = !!autoPref.get().on;
    const sa = ap?.settings;
    const active = (wt?.items || []).filter((w) => w.status === "active").length;
    clear(agentBody,
      line("wallet", "Agent Wallet", !aw?.exists ? "Not created yet" : `${aw.enabled ? "On" : "Off"}${aw.caps ? ` · ${usd(aw.caps.perTradeUsd)} a trade · ${usd(aw.caps.dailyUsd)} a day` : ""}`, "#/agent/wallet", aw?.exists && aw.enabled ? "on" : ""),
      line("bolt", "Autopilot", pilot ? "On in this tab" : "Off", "#/agent/autopilot", pilot ? "on" : ""),
      line("eye", "Sentry Autopilot", sa ? (sa.on ? `On · ${sa.mode === "live" ? "live" : "practice"}` : `Off · ${sa.mode === "live" ? "live" : "practice"} mode`) : "Set your rules", "#/agent/sentry", sa?.on ? "on" : ""),
      line("clock", "Playbooks", wt ? `${active} active of ${(wt.items || []).length}` : "None yet", "#/agent/playbooks", active ? "on" : ""),
      line("bell", "Telegram alerts", nt?.configured ? (nt.linked ? "Linked" : "Not linked") : "Not available here", "#/settings", nt?.linked ? "on" : ""));
  }
  renderAgent();
  stops.push(onWallet(renderAgent));

  /* ---------- brief + signals (same sources as before) ---------- */
  const briefBody = h("div", { class: "panel-b" }, h("div", { class: "sk", style: { height: "80px" } }));
  const briefTime = h("span", { class: "fine" });
  const brief = h("section", { class: "panel brief" },
    h("div", { class: "panel-h" }, h("h2", {}, "Brief", infoTip("Written from live Hyperliquid and Robinhood Chain data each minute. Facts only, no forecasts.")), h("span", { class: "row" }, h("span", { class: "live-dot" }), briefTime)),
    briefBody);
  const sigBody = h("div", { class: "panel-b sig-list" }, h("div", { class: "sk", style: { height: "80px" } }));
  const sigs = h("section", { class: "panel signals" }, h("div", { class: "panel-h" }, h("h2", {}, "Signals", infoTip("Things worth a look right now. They are thresholds, not recommendations."))), sigBody);

  /* ---------- movers ---------- */
  const hlBody = h("tbody"), rhBody = h("tbody");
  const hlTable = h("section", { class: "panel movers" },
    h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid movers", infoTip("Perps with more than $1M of 24h volume, sorted by the size of the 24h move.")), h("a", { class: "link fine", href: "#/market?tab=perps" }, "All perps")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Market"), h("th", { class: "hide-s" }, ""), h("th", {}, "Price"), h("th", {}, "24h"), h("th", { class: "hide-s" }, "Funding/yr"), h("th", { class: "hide-s" }, "Volume"))), hlBody)));
  const rhTable = h("section", { class: "panel movers" },
    h("div", { class: "panel-h" }, h("h2", {}, "Hot on Robinhood Chain", infoTip("Robinhood Chain coins with the most volume in the last 24 hours, from GeckoTerminal pools (wash-traded pools left out).")), h("a", { class: "link fine", href: "#/market" }, "Full market")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Token"), h("th", {}, "Price"), h("th", {}, "24h"), h("th", { class: "hide-s" }, "Volume"))), rhBody)));
  hlBody.append(...skel(6, 6));
  rhBody.append(...skel(6, 4));

  /* ---------- Sentry: latest results ---------- */
  const senBody = h("div", { class: "dk-sentry-b" }, h("div", { class: "sk", style: { height: "120px" } }));
  const sentry = h("section", { class: "panel dk-sentry" },
    h("div", { class: "panel-h" }, h("h2", {}, "Sentry", infoTip("Every new Pons launch, and every new pool on Uniswap and the other Robinhood Chain launchpads, goes through the Gate. Only clean passes with real buying reach the channel; every result stays here.")),
      h("span", { class: "row" }, h("a", { class: "link fine", href: "#/agent/sentry" }, "Sentry Autopilot"), h("a", { class: "link fine", href: "https://t.me/troyasentry", target: "_blank", rel: "noopener" }, "Channel"))),
    senBody);

  /* ---------- shortcuts: every tool, one line each ---------- */
  const tools = [
    ["swap", "Swap", "Coins and tokenized stocks on Robinhood Chain", "#/swap"],
    ["bolt", "Perps", "Hyperliquid perps with stops and take-profit", "#/perps"],
    ["bridge", "Bridge", "Bring ETH in from Ethereum, Arbitrum or Base", "#/bridge"],
    ["rocket", "Launch", "Create a coin on Pons with the Gate on it", "#/launch/create"],
    ["loop", "Copy", "Follow traders from the leaderboard", "#/leaderboard"],
    ["key", "API and MCP", "Give your own agent a scoped token", "#/agent/wallet"],
  ];
  const shortcuts = h("section", { class: "panel dk-tools" },
    h("div", { class: "panel-h" }, h("h2", {}, "Tools"), h("a", { class: "link fine", href: "#/docs" }, "Docs")),
    h("div", { class: "dk-tools-g" }, tools.map(([ic, t, d, href]) => h("a", { class: "dk-tool", href }, h("span", { class: "dk-tool-ic" }, icon(ic)), h("b", {}, t), h("span", {}, d)))));

  const gate = gatePanel({ go, ask, compact: true });
  stops.push(gate.stop);

  /* ---------- Desk 2.0 hero: the Troya horse, the promise, live numbers ---------- */
  const CA = (window.SITE && window.SITE.ca) || "";
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
  const tiny = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 12 })}`);
  const kpi = (label, v, s) => h("div", { class: "d2-kpi" }, h("div", { class: "l" }, label), v, s);
  const kEth = h("div", { class: "v" }, "–"), kEthS = h("div", { class: "s" }, "gas under $0.01");
  const kTro = h("div", { class: "v" }, "–"), kTroS = h("div", { class: "s" }, "on chain, live");
  const kSen = h("div", { class: "v" }, "–"), kSenS = h("div", { class: "s" }, "Sentry calls");
  const kBurn = h("div", { class: "v" }, "–"), kBurnS = h("div", { class: "s" }, "of supply");
  const tagGateB = h("b", {}, "Troya Gate"), tagGateS = h("small", {}, "$TROYA, checking…");
  const tagFlyB = h("b", {}, "Flywheel"), tagFlyS = h("small", {}, "reading the chain…");
  const horseCanvas = h("canvas", { class: "d2-horse", "aria-hidden": "true" });
  const tile = (ic) => h("span", { class: "d2-tile" }, chromeIcon(ic));
  const hero = h("section", { class: "d2-hero" },
    h("div", { class: "d2-beams", "aria-hidden": "true" }),
    h("div", { class: "d2-txt" },
      h("p", { class: "d2-mic" }, h("i", { class: "live-dot" }), "Live · Robinhood Chain"),
      h("h1", {}, "Every coin", h("br"), h("em", {}, "opened"), h("span", {}, " at the"), h("br"), h("span", {}, "gate.")),
      h("p", { class: "d2-lead" }, "Troya reads the chain, simulates every trade from your own address and tells you what it found, before your wallet signs anything."),
      h("div", { class: "d2-acts" },
        h("a", { class: "btn primary d2-big", href: "#/gate" }, chromeIcon("gate"), "Gate a coin"),
        h("button", { class: "btn d2-big", type: "button", onclick: () => (askDrawer ? askDrawer() : go("#/agent")) }, chromeIcon("spark"), "Ask Troya")),
      h("div", { class: "d2-kpis" }, kpi("ETH", kEth, kEthS), kpi("$TROYA", kTro, kTroS), kpi("Sentry", kSen, kSenS), kpi("Burned", kBurn, kBurnS))),
    h("div", { class: "d2-stage" },
      h("div", { class: "d2-floor", "aria-hidden": "true" }), horseCanvas,
      h("a", { class: "d2-tag t1", href: CA ? `#/gate/${CA}` : "#/gate" }, tile("verify"), h("span", {}, tagGateB, tagGateS)),
      h("a", { class: "d2-tag t2", href: "#/flywheel" }, tile("flywheel"), h("span", {}, tagFlyB, tagFlyS))));
  const quick = h("section", { class: "d2-quick" },
    [["swap", "Swap", "The Gate checks every trade", "#/swap"], ["perps", "Perps", "Crypto, stocks and metals", "#/perps"],
     ["liquidity", "Earn on liquidity", "Ranges set from volatility", "#/liquidity"], ["spark", "Build an agent", "From your own playbooks", "#/social/agents"]]
      .map(([ic, t, d, href]) => h("a", { class: "d2-q", href }, tile(ic), h("span", {}, h("b", {}, t), h("small", {}, d)))));
  let horse = null, alive = true;
  stops.push(() => { alive = false; try { horse?.dispose(); } catch {} });
  const startHorse = () => import("./horse.js").then((m) => m.mountHorse(horseCanvas)).then((hr) => { if (!alive) hr?.dispose(); else horse = hr; }).catch(() => hero.classList.add("no-3d"));
  setTimeout(startHorse, 150);                   // after the page has painted
  stops.push(every(60000, async () => {
    try {
      const f = await api.get("flywheel");
      if (f.price?.troyaUsd) kTro.textContent = tiny(f.price.troyaUsd);
      if (f.burned) { kBurn.textContent = compact(f.burned.total); kBurnS.textContent = `${f.burned.pctOfMinted.toFixed(2)}% of supply`; tagFlyB.textContent = `${compact(f.burned.total)} burned`; }
      const c = f.totals?.cycles || 0; tagFlyS.textContent = `flywheel · ${c} cycle${c === 1 ? "" : "s"}`;
    } catch { tagFlyS.textContent = "flywheel"; }
    try { const r = await api.get("record?limit=1"); kSen.textContent = String(r.stats.calls); kSenS.textContent = `calls, ${r.stats.graded} graded in public`; } catch {}
  }));
  if (CA) stops.push(every(300000, async () => {
    try {
      const b = await api.get(`/api/badge/${CA}`);
      const n = (b.checks || []).length, pass = (b.checks || []).filter((c) => c.status === "pass").length;
      if (n) { tagGateB.textContent = `${pass} / ${n} passed`; tagGateS.textContent = `$TROYA · Gate${b.checkedAt ? `, ${ago(b.checkedAt)}` : ""}`; }
    } catch { tagGateS.textContent = "$TROYA · open the Gate"; }
  }));

  // two columns: the left one is for looking (Gate, brief, markets), the right one for your agent and what it watches
  clear(view, h("div", { class: "dk" },
    hero, quick, steps,
    h("div", { class: "dk-cols" },
      h("div", { class: "dk-col" }, gate.el, brief, hlTable, rhTable),
      h("div", { class: "dk-col" }, agent, sentry, sigs, shortcuts))));

  /* ---------- data ---------- */
  stops.push(every(10000, async () => {
    try { const p = await api.get("price/eth"); statEth.textContent = usd(p.usd); kEth.textContent = usd(p.usd); } catch { statEthS.textContent = "price unavailable"; kEthS.textContent = "price unavailable"; }
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
      clear(rhBody, d.tokens.slice(0, 7).map((t) => h("tr", { class: "click", onclick: () => go(`#/token/${t.address}`) },
        h("td", { class: "l" }, tokenCell(t)),
        h("td", {}, priceCell(t.priceEth, t.priceUsd)), h("td", {}, pctEl(t.change24h)), h("td", { class: "hide-s" }, usdCell(t.volume24hUsd, null)))));
      if (!d.tokens.length) clear(rhBody, h("tr", {}, h("td", { colspan: 4, class: "l muted" }, "No Robinhood Chain coins returned.")));
    } catch (e) { clear(rhBody, h("tr", {}, h("td", { colspan: 4, class: "l muted" }, `The Robinhood Chain board is unavailable: ${e.message}`))); }
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
  stops.push(every(60000, async () => {
    try {
      const d = await api.get("sentry/recent?limit=6");
      const items = d.items || [];
      if (!items.length) {
        clear(senBody, h("div", { class: "dk-empty" }, h("b", {}, d.live ? "Nothing checked in the last while." : "Sentry is not watching on this server."), h("p", {}, "Every result the channel sees is listed here as it comes in. "), h("a", { class: "btn sm", href: d.channel || "https://t.me/troyasentry", target: "_blank", rel: "noopener" }, "Open t.me/troyasentry")));
        return;
      }
      const word = { passed: "Passed", caution: "Caution", failed: "Failed" };
      clear(senBody, h("ul", { class: "dk-sen" }, items.map((it) => h("li", {},
        tokenIcon({ symbol: it.symbol, address: it.token }, "sm"),
        h("div", { class: "dk-sen-t" }, h("b", {}, it.symbol ? `$${it.symbol}` : short(it.token)), h("span", {}, [it.name, it.source || "Pons", it.buyers != null ? `${it.buyers} buyers` : null].filter(Boolean).join(" · "))),
        h("span", { class: `dk-v v-${it.verdict}` }, word[it.verdict] || it.verdict || "Checked"),
        h("span", { class: "fine dk-sen-at" }, ago(it.at)),
        h("span", { class: "dk-sen-a" },
          h("a", { class: "link", href: `#/gate/${it.token}` }, "Gate"),
          h("a", { class: "link", href: `#/token/${it.token}` }, "Open"),
          it.post ? h("a", { class: "link", href: it.post, target: "_blank", rel: "noopener" }, "Post") : null)))));
    } catch (e) { clear(senBody, h("p", { class: "muted" }, `Sentry results are unavailable right now (${e.message}).`)); }
  }));

  async function watch(s) {
    if (!wallet.session) { toast("Sign in from the Agent page to set up watches.", ""); go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}`); return; }
    go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}&kind=${s.kind}`);
  }

  return () => stops.forEach((f) => { try { f(); } catch {} });
}

function skel(n, cols) {
  return Array.from({ length: n }, () => h("tr", {}, Array.from({ length: cols }, (_, i) => h("td", { class: i === 0 ? "l" : "" }, h("div", { class: "sk", style: { height: "14px", width: i === 0 ? "110px" : "48px", marginLeft: i === 0 ? "0" : "auto" } })))));
}
