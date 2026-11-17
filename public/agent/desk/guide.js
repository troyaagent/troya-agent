// Troya Guide: on every page, what the page is for, a walk-through that lights up each part of the screen,
// questions to ask Troya about it and the sensible next steps. The orb (bottom right) opens it; questions go to the
// agent drawer, so the answer comes from the live tools, not from this file.
import { h, clear } from "/agent/js/ui.js";
import { stream } from "/agent/js/api.js";
import { wallet } from "/agent/js/wallet.js";
import { chromeIcon } from "./chrome-icons.js";

/* ---------- the chat inside the guide: ask anything, Troya answers here and points the way ---------- */
const GUEST_KEY = "troya.guestChat";                 // the same guest memory as the full chat page
const guestLog = { get() { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || "[]"); } catch { return []; } }, set(v) { try { localStorage.setItem(GUEST_KEY, JSON.stringify(v.slice(-30))); } catch {} } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function md(text) {
  const lines = esc(text).split("\n");
  let html = "", list = false;
  const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(?:https?:\/\/)?troya\.codes(\/agent)?(#\/[\w\/?=&.-]*|\/[\w\/?=&.#-]*)?/g, (m, ag, path) => {
      const href = ag && path?.startsWith("#") ? path : `https://troya.codes${ag || ""}${path || ""}`;
      return `<a href="${href}"${href.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${m}</a>`;
    });
  for (const raw of lines) {
    const m = /^\s*[-*] (.*)$/.exec(raw);
    if (m) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(m[1])}</li>`; }
    else { if (list) { html += "</ul>"; list = false; } if (raw.trim()) html += `<p>${inline(raw)}</p>`; }
  }
  if (list) html += "</ul>";
  return html;
}
// pages an answer points to become buttons: open the page, and walk through it when it has a tour
const KW = [[/\b(swap|buy|sell)\b/i, "swap"], [/\bgate\b|safe to buy|is it safe/i, "gate"], [/\bbridge\b|bring eth|fund hyperliquid/i, "bridge"], [/\bperps?\b|\blong\b|\bshort\b|leverage/i, "perps"],
  [/liquidity|\brange\b|\blp\b/i, "liquidity"], [/agent wallet/i, "agent/wallet"], [/playbook|stop[- ]loss|take[- ]profit|\bdca\b|\btwap\b|alert/i, "agent/playbooks"], [/flywheel|buyback|burn/i, "flywheel"], [/stock|nvda|tsla|spy\b|morpho|dividend/i, "stocks"], [/registry|reputation|file (a )?call/i, "registry"], [/\brail\b|kill switch|robinhood (mcp|agent)|agentic/i, "rail"]];
function routesIn(text, q = "") {
  const out = new Set();
  for (const [re, p] of KW) if (re.test(q)) out.add(p);
  for (const m of String(text).matchAll(/troya\.codes\/agent#\/([a-z][\w\/-]*)/g)) out.add(m[1]);
  for (const m of String(text).matchAll(/(?:^|[\s(])#\/([a-z][\w\/-]*)/g)) out.add(m[1]);
  if (out.size < 2) for (const [re, p] of KW) if (re.test(text)) out.add(p);
  return [...out].map((p) => p.replace(/\/$/, "")).filter((p) => G[p] || G[p.split("/")[0]]).slice(0, 2);
}

// tour steps: [selector, title, text]; a step whose element is not on screen is skipped
const G = {
  "": { t: "Desk", what: "Your home: live numbers from the chain, the Gate, what your agent is doing and what Sentry saw last.",
    tour: [[".d2-kpis", "The pulse", "Live from the chain: ETH, $TROYA, how many Sentry calls are graded in public and what the flywheel has burned."],
      [".d2-quick", "One click away", "The four things people do most. Every swap and every perp order runs through the Gate first."],
      [".d2-chart", "The chart", "ETH or $TROYA over a day, a week or a month."],
      [".dk-steps", "Start in four steps", "Connect, an optional Agent Wallet, funds on Robinhood Chain and a first swap. Troya ticks them off as you go."],
      [".dk-gate", "Troya Gate", "Search any coin by name or paste its address: seven checks, a simulated buy and a test sell, before you risk anything."],
      [".dk-agent", "Your agent", "What the agent may do for you and what is running: Agent Wallet, Autopilot, Sentry Autopilot, playbooks."]],
    ask: ["What is moving most on Robinhood Chain right now?", "How does Troya Gate decide pass, caution or fail?", "What can Troya do without my signature?"],
    next: [["Gate a coin", "#/gate"], ["Make a first swap", "#/swap"], ["Start in 60 seconds", "#/start"]] },
  swap: { t: "Swap", what: "Swap coins and tokenized stocks on Robinhood Chain, Base, Arbitrum and Solana. The Gate checks every swap, and you sign it in your own wallet.",
    tour: [[".sw-net", "The network", "Robinhood Chain by default; Base, Arbitrum and Solana route through KyberSwap and Jupiter with the same Gate."],
      [".sw-leg", "What you pay", "Pick a token and an amount. The quick buttons fill common sizes. Search tokens by name or ticker."],
      [".sw-mid", "Flip", "Swap sides in one tap."],
      [".sw-card .big", "Review, then sign", "Troya quotes the best route, runs the seven checks and only then asks your wallet to sign."]],
    ask: ["Is this coin safe to buy? Run the Gate on it.", "What fees will I pay on this swap?", "Which route does Troya use for Pons coins?"],
    next: [["Gate a coin first", "#/gate"], ["Bridge ETH in", "#/bridge"], ["Watch it with a playbook", "#/agent/playbooks"]] },
  perps: { t: "Perps", what: "Hyperliquid perps from your own Hyperliquid account, plus trade.xyz stock, index and metal perps, with stops and take-profit.",
    tour: [[".pp-chart", "The market", "Live chart for the market you picked."], [".pp-book", "The book", "Live order book: where the size sits."],
      [".pp-ticket", "Your ticket", "Long or short, size, leverage, stop and take-profit. The Gate checks margin and the fill before it sends."],
      [".pp-pos", "Positions", "Open positions and orders, with one-tap close."]],
    ask: ["How do I fund Hyperliquid from Robinhood Chain?", "Which perps have stretched funding right now?", "What does a 3x long on ETH risk at today's price?"],
    next: [["Fund Hyperliquid", "#/bridge?dir=hl"], ["Set a stop-loss playbook", "#/agent/playbooks"]] },
  spot: { t: "Spot (Hyperliquid)", what: "Buy and sell HYPE, UBTC, UETH and other Hyperliquid spot coins from your own account, with a Spot Gate on the live book.",
    tour: [[".sp-side", "Pairs", "Every spot pair with volume."], [".sp-card", "The ticket", "Buy or sell; the Spot Gate reads spread and what your size fills at."]],
    ask: ["What is the spread on HYPE right now?", "How do I move USDC between perps and spot?"], next: [["Perps", "#/perps"]] },
  lighter: { t: "Perps · Lighter", what: "Lighter perps on Robinhood Chain: deposit USDG, one signature sets up a trading key made in your browser.",
    tour: [[".lt-acct", "Your Lighter account", "Deposit, balance and withdrawals, all on Robinhood Chain."], [".sp-side", "Markets", "Every Lighter market."], [".sp-card", "The ticket", "Orders fill within 1% of the price, after the Lighter Gate."]],
    ask: ["How do I deposit USDG into Lighter?", "Is Lighter available where I live?"], next: [["Swap ETH to USDG", "#/swap"]] },
  stocks: { t: "Stock desk", what: "Robinhood stock tokens: prices with dividend and split multipliers, baskets in one go, and USDG loans against stocks on Morpho Blue.",
    tour: [[".sd-tabs", "Four desks", "Stocks, dividends and splits, baskets, and borrow."], [".sd-body", "The desk", "Every action here passes the Gate; loans pass a Loan Gate with the liquidation price shown."]],
    ask: ["Which stock tokens moved most today?", "What health factor should I keep on a Morpho loan?"], next: [["Swap into a stock", "#/swap"]] },
  liquidity: { t: "Liquidity desk", what: "Earn fees on Uniswap v3 pools: Troya proposes ranges from the pool's own volatility and watches them for you.",
    tour: [[".sp-side", "Pools", "Search by coin name or ticker; TVL, fee APR and volume per pool."], [".lq-presets", "The range", "Tight, balanced or wide, with the chance the price stays inside and the fees per $1,000 a day."],
      [".lq-amts", "Amounts", "Both sides of the position, sized for the range."], [".lq-card .big", "Mint", "The Liquidity Gate checks the pool and both tokens, then your wallet mints."]],
    ask: ["Which range is best for NVDA/USDG this week?", "What is impermanent loss in plain words?"], next: [["Watch a range", "#/agent/playbooks"]] },
  bridge: { t: "Bridge", what: "Move ETH between Robinhood Chain, Base, Arbitrum and Ethereum, or turn ETH into USDC on your Hyperliquid account in one transaction.",
    tour: [[".br-ctrls", "Direction", "Pick where the funds come from and where they go."], [".br-card", "Amount and route", "A live quote with the time and the fees."]],
    ask: ["What is the cheapest way to get ETH onto Robinhood Chain?", "How long does a bridge take?"], next: [["Swap once it lands", "#/swap"]] },
  gate: { t: "Gate a coin", what: "Seven checks on any Robinhood Chain coin, the same result the badge, Sentry and every swap use, plus The Assay on its holders.",
    tour: [[".dk-gate-form", "Find the coin", "Type a name or ticker (TROYA, NVDA) or paste an address."], [".dk-checks", "Seven checks", "Route, price impact, depth, fees and taxes, a simulation, a test sell and transfer tax."], [".dk-assay", "The Assay", "Who funded the dev, holder clusters, bundled buys and wash trades."]],
    ask: ["Explain this Gate result in plain words.", "What does a caution on pool depth mean?"], next: [["Swap it", "#/swap"], ["Get the badge", "/badge"]] },
  market: { t: "Market", what: "Every coin on Robinhood Chain with a real pool, plus stock tokens, Hyperliquid perps and spot.",
    tour: [[".mk-top", "Boards", "Robinhood Chain, stocks, perps and spot."], [".mk-filters", "Search and filter", "Search by name or ticker; filter by launchpad."], [".mk-panel", "The board", "Sort by volume, liquidity, age. Tap a row for the token page."]],
    ask: ["Which new coins have real buyers today?", "Why is a coin marked as not routed?"], next: [["Gate a coin", "#/gate"]] },
  token: { t: "Token page", what: "One coin: chart, pools, trades and the facts Troya read from the chain.",
    tour: [[".tk-chart", "Chart", "Price in USD from its pools."], [".tk-side", "Facts", "Liquidity, holders and links."]],
    ask: ["Is this coin safe to buy?", "Who are the biggest holders of this coin?"], next: [["Gate it", "#/gate"], ["Swap", "#/swap"]] },
  launch: { t: "Launchpad", what: "Every launch on Robinhood Chain launchpads, newest first, with the Gate one tap away.",
    tour: [[".lp-tabs", "Launchpads", "Pons and the others."], [".mk-panel", "Launches", "Progress, buyers and age."]],
    ask: ["Which launches have the most independent buyers today?"], next: [["Create coin", "#/create"]] },
  "launch/create": { t: "Create a token", what: "Launch a coin on Pons with the Gate on it from the first block.",
    tour: [[".lc-form", "Your coin", "Name, ticker, image and links."], [".lc-side", "Preview", "What people will see."]],
    ask: ["What does it cost to launch on Pons?", "How does a Pons curve graduate?"], next: [["Get a Gate badge", "/badge"]] },
  leaderboard: { t: "Leaderboard", what: "Traders who opted in, ranked by results, with rules you can copy.", tour: [[".lb-box", "The board", "Opt in from your Portfolio to appear here."]],
    ask: ["How do copy rules work?"], next: [["Playbooks", "#/agent/playbooks"]] },
  agent: { t: "Chat", what: "Talk to Troya like a trader next to you. It pulls live data, prepares tickets, and nothing moves until you sign or your caps allow it.",
    tour: [[".ag-suggest", "Start here", "Tap a question or write your own."], [".ag-composer", "Ask anything", "Coins, perps, stocks, your positions. Tickets appear as cards to confirm."]],
    ask: ["Long ETH $20 at 3x with a stop at 3000", "Twap 0.05 ETH into NVDA over 1 hour"], next: [["Agent Wallet", "#/agent/wallet"]] },
  "agent/wallet": { t: "Agent Wallet", what: "An optional small wallet the agent can use inside the caps you set. Withdrawals only go back to your own wallet.",
    tour: [[".ag-intro", "What it is", "A hot wallet for trading money only, with daily caps."], [".ag-signin", "Sign in", "Signing proves the wallet is yours; it costs nothing."]],
    ask: ["What are safe caps for an Agent Wallet?", "How do I withdraw everything from it?"], next: [["Autopilot", "#/agent/autopilot"], ["Playbooks", "#/agent/playbooks"]] },
  "agent/autopilot": { t: "Autopilot", what: "Runs the tickets you approved, inside your caps, while this tab is open.", tour: [[".ag-intro", "How it works", "Rules first; every order still passes the Gate."]],
    ask: ["What will Autopilot do on its own?"], next: [["Sentry Autopilot", "#/agent/sentry"]] },
  "agent/sentry": { t: "Sentry Autopilot", what: "Your rules on every new launch Sentry passes: practice with play money, or live from the Agent Wallet.", tour: [[".ag-intro", "Your rules", "Minimum raised, size, take profit and stop."]],
    ask: ["What rules make sense for Sentry Autopilot?"], next: [["The Record", "/record"]] },
  "agent/playbooks": { t: "Playbooks", what: "Rules the server watches for you: stop-loss, take-profit ladders, DCA, TWAP, price alerts, range and loan guards.", tour: [[".ag-intro", "Rules that watch", "Checked every 20 seconds; triggers execute inside your caps or land in your inbox."]],
    ask: ["Set a stop-loss on my ETH long at 3000", "Smart DCA 0.01 ETH into TROYA every day"], next: [["Inbox", "#/portfolio/inbox"]] },
  portfolio: { t: "Portfolio", what: "Your balances across chains, open positions and the steps left to set up.", tour: [[".pf-tiles", "Totals", "What you hold, everywhere."]],
    ask: ["Summarise my portfolio and its biggest risk."], next: [["History", "#/portfolio/history"]] },
  social: { t: "Social", what: "Your X account on Troya, Troya answering on X, the Holder Pass, holder votes and the agent factory.", tour: [[".sd-tabs", "Five parts", "X, Holder pass, Votes, Agents (and Reports for admins)."], [".so-body", "The part you picked", "Everything signs in your wallet; votes cost no gas."]],
    ask: ["How do I get a Holder Pass?", "How do I build an agent?"], next: [["Flywheel", "#/flywheel"]] },
  flywheel: { t: "$TROYA flywheel", what: "Creator fees buy $TROYA back through the Gate, burn it and lock liquidity, every step read back from the chain.", tour: [[".fw-tiles", "The numbers", "Fees earned and claimed, burned and locked."], [".fw-panel", "Cycles", "Every cycle with its transactions."]],
    ask: ["How much $TROYA has been burned so far?"], next: [["Verify", "/verify"]] },
  start: { t: "Start in 60 seconds", what: "The fastest path from nothing to a first checked trade.", tour: [[".st-list", "The steps", "Do them in order; each one says why."]], ask: ["What do I need to start?"], next: [["Desk", "#/"]] },
  registry: { t: "Agent registry", what: "AI agents ranked by the calls they filed on Robinhood Chain coins. Every call is signed when filed and graded in public when its time is up.", tour: [[".rg-kpis", "The totals", "Agents, calls filed and how many came out right."], [".rg-board", "The ranking", "Reputation is the lower bound of the right-call rate: a short lucky run can't top a long record."], [".rg-mine", "Your agents", "Register one and file its calls; each comes back signed."]],
    ask: ["How do I register my agent and file a call?", "How is reputation worked out?"], next: [["Audited rail", "#/rail"]] },
  rail: { t: "Audited rail", what: "Your limits between your AI agent and Robinhood's agentic trading MCP: every order checked, every decision signed, and a kill switch.", tour: [[".rl-kill", "The kill switch", "One click refuses every order until you switch it off."], [".rl-form", "Your policy", "Orders on or off, per order, per day, allowlist, market hours."], [".rl-log", "Audit log", "Every order your agent tried, allowed or refused, with Troya's signature."]],
    ask: ["How do I connect the rail to my agent?", "What does the rail always refuse?"], next: [["Agent registry", "#/registry"]] },
  docs: { t: "Docs", what: "How every part of Troya works, the API and the MCP server.", tour: [], ask: ["How do I connect Troya to my own AI agent over MCP?"], next: [["API and MCP", "/api-and-mcp"]] },
};
const keyOf = () => {
  const p = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean);
  const two = p.slice(0, 2).join("/");
  if (G[two]) return two;
  if (p[0] === "assistant") return "agent";
  return G[p[0] || ""] ? p[0] || "" : null;
};

let panel, orb, ask = null, tourEl = null, steps = [], step = 0;

let conv = null, convBox = null, busy = false, abort = null;
// what the page is showing right now (pages send "troya:ctx"); goes with every question so answers fit the screen
let screen = { key: null, text: "" };
addEventListener("troya:ctx", (e) => { screen = { key: keyOf(), text: String(e.detail?.text || "").replace(/\s+/g, " ").slice(0, 800) }; });
const screenText = () => (screen.key === keyOf() && screen.text ? ` On my screen: ${screen.text}` : "");
function chatSend(q) {
  q = String(q || "").trim();
  if (!q || busy) return;
  const k = keyOf(), g = k == null ? null : G[k];
  busy = true;
  const me = h("div", { class: "g-msg me" }, h("p", {}, q));
  const body = h("div", { class: "g-md" });
  const status = h("div", { class: "g-status" }, h("span", { class: "ag-spin" }), h("span", {}, "Troya is reading the chain…"));
  const acts = h("div", { class: "g-acts" });
  const bot = h("div", { class: "g-msg bot" }, h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("div", { class: "g-bub" }, status, body, acts));
  conv.push(me, bot);
  convBox.append(me, bot);
  panel.classList.add("chatting");
  const scroll = () => { const b = panel.querySelector(".g-b"); if (b) b.scrollTop = b.scrollHeight; };
  scroll();
  let acc = "";
  abort = new AbortController();
  const guest = !wallet.session;
  const prior = guest ? guestLog.get().slice(-8) : undefined;
  const context = g ? `(I am on the ${g.t} page of troya.codes/agent.${screenText()}) ` : screenText() ? `(${screenText().trim()}) ` : "";
  stream("assistant/stream", { message: context + q, ...(guest ? { history: prior } : {}) }, (type, data) => {
    if (type === "status") status.lastChild.textContent = data.text;
    else if (type === "text") { acc += data.delta; body.innerHTML = md(acc); scroll(); }
    else if (type === "proposal") acts.append(h("a", { class: "g-act", href: "#/agent" }, chromeIcon("chat"), "A ticket is ready: confirm it in Chat"));
    else if (type === "done") { if (guest && acc) guestLog.set([...guestLog.get(), { role: "user", text: q }, { role: "assistant", text: acc }]); }
    else if (type === "error") body.innerHTML = md(`**${data.error}**`);
  }, abort.signal).catch((e) => { if (e.name !== "AbortError") body.innerHTML = md(`**${e.message}**`); })
    .finally(() => {
      status.remove(); busy = false;
      for (const p of routesIn(acc, q)) {
        const gk = G[p] ? p : p.split("/")[0], title = G[gk]?.t || p;
        acts.append(h("a", { class: "g-act", href: `#/${p}` }, chromeIcon("start"), `Open ${title}`));
        if (G[gk]?.tour?.length) acts.append(h("button", { class: "g-act", type: "button", onclick: () => { close(); location.hash = `#/${p}`; setTimeout(() => { const st = (G[gk].tour || []).filter(([s]) => document.querySelector(s)); if (st.length) startTour(st); }, 1600); } }, chromeIcon("sentry"), `Show me how`));
      }
      scroll();
    });
}

function render() {
  const k = keyOf(), g = k == null ? null : G[k];
  const tourSteps = (g?.tour || []).filter(([sel]) => document.querySelector(sel));
  const input = h("textarea", { class: "g-in", rows: "1", placeholder: "Ask Troya anything…", maxlength: "500" });
  const send = () => { const q = input.value.trim(); if (!q) return input.focus(); input.value = ""; chatSend(q); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  conv = conv || [];
  convBox = h("div", { class: "g-conv" }, conv);
  clear(panel,
    h("div", { class: "g-h" }, h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("div", {}, h("b", {}, "Ask Troya"), h("small", {}, "Answers from the live chain · points you the way")),
      conv.length ? h("button", { class: "g-x", type: "button", title: "New conversation", "aria-label": "New conversation", onclick: () => { abort?.abort(); conv = []; panel.classList.remove("chatting"); render(); } }, chromeIcon("create")) : null,
      h("button", { class: "g-x", type: "button", "aria-label": "Close", onclick: close }, chromeIcon("close"))),
    h("div", { class: "g-b" },
      h("p", { class: "g-mic" }, "This page"),
      h("h3", {}, g?.t || "Troya"),
      h("p", { class: "g-what" }, g?.what || "Ask Troya anything; it reads the chain live."),
      tourSteps.length ? h("button", { class: "g-walk", type: "button", onclick: () => { close(); startTour(tourSteps); } },
        h("span", { class: "d2-tile" }, chromeIcon("start")), h("span", {}, h("b", {}, "Show me how this page works"), h("small", {}, `${tourSteps.length} steps, right on the screen`))) : null,
      g?.ask?.length ? h("p", { class: "g-mic" }, "Ask Troya") : null,
      g?.ask?.length ? h("div", { class: "g-asks" }, g.ask.map((q) => h("button", { class: "g-ask", type: "button", onclick: () => chatSend(q) }, chromeIcon("spark"), h("span", {}, q)))) : null,
      g?.next?.length ? h("p", { class: "g-mic g-nx" }, "Good next steps") : null,
      g?.next?.length ? h("div", { class: "g-next" }, g.next.map(([t, href]) => h("a", { href, onclick: close }, t, h("i", {}, "→")))) : null,
      h("p", { class: "g-safe" }, "Nobody from Troya DMs first or asks for a seed phrase. Found a bug? ", h("a", { href: "/community", target: "_self" }, "troya.codes/community")),
      convBox),
    h("div", { class: "g-f" }, input, h("button", { class: "btn primary g-send", type: "button", "aria-label": "Send", onclick: send }, chromeIcon("send") || "Ask"),
      h("a", { class: "g-full", href: "#/agent", title: "Open the full chat", "aria-label": "Open the full chat", onclick: close }, chromeIcon("expand"))));
  if (conv.length) { panel.classList.add("chatting"); requestAnimationFrame(() => { const b = panel.querySelector(".g-b"); if (b) b.scrollTop = b.scrollHeight; }); }
}
// a page still building when the guide opens gets its walk-through button as soon as its parts are on screen
function recheck() {
  if (!document.body.classList.contains("g-open") || panel.querySelector(".g-walk")) return;
  const k = keyOf(), g = k == null ? null : G[k];
  if ((g?.tour || []).some(([sel]) => document.querySelector(sel))) { const v = panel.querySelector(".g-in")?.value || ""; render(); const i = panel.querySelector(".g-in"); if (i) i.value = v; }
}
function open() { render(); [700, 1600, 3200].forEach((ms) => setTimeout(recheck, ms)); document.body.classList.add("g-open"); panel.setAttribute("aria-hidden", "false"); setTimeout(() => panel.querySelector(".g-in")?.focus({ preventScroll: true }), 300); }
function close() { document.body.classList.remove("g-open"); panel.setAttribute("aria-hidden", "true"); }

/* ---------- the walk-through: a soft spotlight on each part ---------- */
function endTour() { tourEl?.remove(); tourEl = null; removeEventListener("resize", place); removeEventListener("scroll", onScroll, true); removeEventListener("keydown", keys); }
let scrollRaf = 0;
const onScroll = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; place(); }); };
function keys(e) { if (e.key === "Escape") endTour(); if (e.key === "ArrowRight" || e.key === "Enter") nextStep(); if (e.key === "ArrowLeft" && step > 0) { step--; show(); } }
function nextStep() { if (step < steps.length - 1) { step++; show(); } else endTour(); }
function startTour(list) { steps = list; step = 0; addEventListener("resize", place); addEventListener("scroll", onScroll, { passive: true, capture: true }); addEventListener("keydown", keys); show(); }
function place() {
  if (!tourEl) return;
  const el = document.querySelector(steps[step][0]); if (!el) return;
  const r = el.getBoundingClientRect(), pad = 8;
  Object.assign(tourEl.querySelector(".t-hole").style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const c = tourEl.querySelector(".t-card"), w = Math.min(340, innerWidth - 32), below = r.bottom + 230 < innerHeight;
  Object.assign(c.style, { width: `${w}px`, left: `${Math.min(innerWidth - w - 16, Math.max(16, r.left + 12))}px`, top: `${below ? Math.min(innerHeight - 220, r.bottom + 18) : Math.max(16, r.top - 214)}px` });
}
function show() {
  const [sel, title, text] = steps[step], el = document.querySelector(sel);
  if (!el) return nextStep();
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (!tourEl) {
    tourEl = h("div", { class: "t-tour", role: "dialog", "aria-label": "Page walk-through" }, h("div", { class: "t-hole" }), h("div", { class: "t-card" }));
    tourEl.addEventListener("click", (e) => { if (e.target === tourEl) endTour(); });
    document.body.append(tourEl);
  }
  const c = tourEl.querySelector(".t-card");
  clear(c, h("div", { class: "t-st" }, `Step ${step + 1} of ${steps.length}`), h("b", {}, title), h("p", {}, text),
    h("div", { class: "t-act" }, h("span", { class: "t-dots" }, steps.map((_, i) => h("i", { class: i === step ? "on" : "" }))),
      h("span", { class: "t-btns" }, h("button", { class: "btn", type: "button", onclick: endTour }, "Skip"),
        h("button", { class: "btn primary", type: "button", onclick: nextStep }, step === steps.length - 1 ? "Done" : "Next"))));
  place(); setTimeout(place, 420); setTimeout(place, 900);
}

/* ---------- highlight anything, then "Ask Troya" ---------- */
let pill = null, pillText = "";
function hidePill() { if (pill) pill.hidden = true; pillText = ""; }
function showPill() {
  const sel = getSelection();
  const text = String(sel?.toString() || "").replace(/\s+/g, " ").trim();
  if (!sel || sel.rangeCount === 0 || text.length < 2 || text.length > 300) return hidePill();
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!node || !node.closest("#view, .d-main") || node.closest("input, textarea, .g-panel, .t-tour")) return hidePill();
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.width && !r.height) return hidePill();
  pillText = text;
  pill.hidden = false;
  const w = pill.offsetWidth || 130;
  pill.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  pill.style.top = `${r.top > 56 ? r.top - 46 : r.bottom + 10}px`;
}
/* ---------- a small nudge at the moments that matter (Gate blocked, a note, a failed transaction) ---------- */
let nudgeEl = null, nudgeAt = 0, nudgeTimer = 0;
const seenNudges = new Set();
function nudge({ key, text, q }) {
  if (!text || !q || seenNudges.has(key)) return;
  seenNudges.add(key);
  if (document.body.classList.contains("g-open")) return;
  if (Date.now() - nudgeAt < 30000) return;
  nudgeAt = Date.now();
  clearTimeout(nudgeTimer);
  clear(nudgeEl, h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("p", {}, text),
    h("span", { class: "g-nudge-a" }, h("button", { class: "btn primary", type: "button", onclick: () => { nudgeEl.hidden = true; askNow(q); } }, "Explain"),
      h("button", { class: "g-x", type: "button", "aria-label": "Dismiss", onclick: () => { nudgeEl.hidden = true; } }, chromeIcon("close"))));
  nudgeEl.hidden = false;
  nudgeTimer = setTimeout(() => { nudgeEl.hidden = true; }, 16000);
}
function askNow(q) { open(); if (q) setTimeout(() => chatSend(q), 220); }

export function mountGuide({ askFn }) {
  ask = askFn;
  const TUCK = "troya.askTucked";
  const tucked = () => { try { return localStorage.getItem(TUCK) === "1"; } catch { return false; } };
  const setTuck = (on) => { try { on ? localStorage.setItem(TUCK, "1") : localStorage.removeItem(TUCK); } catch {} document.body.classList.toggle("g-tucked", on); };
  const tuckBtn = h("button", { class: "g-tuck", type: "button", "aria-label": "Hide the Ask Troya button", title: "Hide (it stays as a small tab on the right)", onclick: (e) => { e.stopPropagation(); setTuck(true); } }, "×");
  const tab = h("button", { class: "g-tab", type: "button", "aria-label": "Show Ask Troya", title: "Ask Troya", onclick: () => setTuck(false) }, h("img", { src: "/img/logo-3d-128.png", alt: "" }));
  setTuck(tucked());
  orb = h("button", { class: "g-orb", type: "button", "aria-label": "Ask Troya", title: "Ask Troya: questions, guidance, walk-throughs", onclick: () => (document.body.classList.contains("g-open") ? close() : open()) },
    h("span", { class: "g-halo" }), h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("span", { class: "g-orb-t" }, "Ask Troya"));
  panel = h("aside", { class: "g-panel", "aria-label": "Troya Guide", "aria-hidden": "true" });
  pill = h("button", { class: "g-pill", type: "button", hidden: true, onmousedown: (e) => e.preventDefault(), onclick: () => {
    const t = pillText, k = keyOf(), g = k == null ? null : G[k];
    hidePill(); getSelection()?.removeAllRanges();
    askNow(`Explain this${g ? ` from the ${g.t} page` : ""} in plain words: "${t}"`);
  } }, chromeIcon("spark"), "Ask Troya");
  nudgeEl = h("div", { class: "g-nudge", role: "status", hidden: true });
  document.body.append(orb, tuckBtn, tab, panel, pill, nudgeEl);
  document.addEventListener("mouseup", () => setTimeout(showPill, 10));
  document.addEventListener("touchend", () => setTimeout(showPill, 350), { passive: true });
  document.addEventListener("selectionchange", () => { if (!String(getSelection()?.toString() || "").trim()) hidePill(); });
  addEventListener("scroll", hidePill, { passive: true, capture: true });
  addEventListener("troya:nudge", (e) => nudge(e.detail || {}));
  window.TroyaGuide = { open, close, ask: askNow };
  addEventListener("hashchange", () => { endTour(); if (document.body.classList.contains("g-open")) render(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("g-open")) close(); });
  return { open, close };
}
