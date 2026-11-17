// Troya Guide: on every page, what the page is for, a walk-through that lights up each part of the screen,
// questions to ask Troya about it and the sensible next steps. The orb (bottom right) opens it; questions go to the
// agent drawer, so the answer comes from the live tools, not from this file.
import { h, clear } from "/agent/js/ui.js";
import { chromeIcon } from "./chrome-icons.js";

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
    ask: ["Which launches have the most independent buyers today?"], next: [["Create a token", "#/launch/create"]] },
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

function render() {
  const k = keyOf(), g = k == null ? null : G[k];
  const tourSteps = (g?.tour || []).filter(([sel]) => document.querySelector(sel));
  const input = h("input", { class: "g-in", placeholder: "Ask Troya anything about this page…", maxlength: "400" });
  const send = () => { const q = input.value.trim(); if (!q) return input.focus(); close(); ask?.(q); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  clear(panel,
    h("div", { class: "g-h" }, h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("div", {}, h("b", {}, "Troya Guide"), h("small", {}, "You ask · Troya checks · you sign")),
      h("button", { class: "g-x", type: "button", "aria-label": "Close the guide", onclick: close }, chromeIcon("close"))),
    h("div", { class: "g-b" },
      h("p", { class: "g-mic" }, "This page"),
      h("h3", {}, g?.t || "Troya"),
      h("p", { class: "g-what" }, g?.what || "Ask Troya anything; it reads the chain live."),
      tourSteps.length ? h("button", { class: "g-walk", type: "button", onclick: () => { close(); startTour(tourSteps); } },
        h("span", { class: "d2-tile" }, chromeIcon("start")), h("span", {}, h("b", {}, "Show me how this page works"), h("small", {}, `${tourSteps.length} steps, right on the screen`))) : null,
      g?.ask?.length ? h("p", { class: "g-mic" }, "Ask Troya") : null,
      g?.ask?.length ? h("div", { class: "g-asks" }, g.ask.map((q) => h("button", { class: "g-ask", type: "button", onclick: () => { close(); ask?.(q); } }, chromeIcon("spark"), h("span", {}, q)))) : null,
      g?.next?.length ? h("p", { class: "g-mic" }, "Good next steps") : null,
      g?.next?.length ? h("div", { class: "g-next" }, g.next.map(([t, href]) => h("a", { href, onclick: close }, t, h("i", {}, "→")))) : null,
      h("p", { class: "g-safe" }, "Nobody from Troya DMs first or asks for a seed phrase. Found a bug? ", h("a", { href: "/community", target: "_self" }, "troya.codes/community"))),
    h("div", { class: "g-f" }, input, h("button", { class: "btn primary", type: "button", onclick: send }, "Ask")));
}
function open() { render(); document.body.classList.add("g-open"); panel.setAttribute("aria-hidden", "false"); setTimeout(() => panel.querySelector(".g-in")?.focus({ preventScroll: true }), 300); }
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

export function mountGuide({ askFn }) {
  ask = askFn;
  orb = h("button", { class: "g-orb", type: "button", "aria-label": "Troya Guide", title: "Troya Guide", onclick: () => (document.body.classList.contains("g-open") ? close() : open()) },
    h("span", { class: "g-halo" }), h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("span", { class: "g-orb-t" }, "Guide"));
  panel = h("aside", { class: "g-panel", "aria-label": "Troya Guide", "aria-hidden": "true" });
  document.body.append(orb, panel);
  addEventListener("hashchange", () => { endTour(); if (document.body.classList.contains("g-open")) render(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("g-open")) close(); });
  return { open, close };
}
