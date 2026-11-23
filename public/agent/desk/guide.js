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
  // features named in the question (Scepter, Sentry Autopilot, Treasury…) get their own page, read from the glossary
  for (const g of featuresIn(q)) if (!g.page.startsWith("/")) out.add(g.page);
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
  heel: { t: "Find the weak spot", what: "Paste a coin, a dev wallet or an agent: Troya names its one most dangerous weak spot, with up to three facts that link to their transactions on Blockscout, and one Guard button.",
    tour: [[".hl-form", "Paste", "A coin address, a dev wallet or an agent wallet on Robinhood Chain."], [".hl-sentence", "The heel", "One sentence: the worst thing found, picked by fixed rules, with a confidence label."], [".hl-facts", "Proof", "Each fact links to the transaction, contract or block behind it."], [".hl-guard", "Guard", "Pin a coin to Watchfire, or watch a dev's next launches."]],
    ask: ["Explain this Heel in plain words.", "What does the dev passport count?"], next: [["Gate a coin", "#/gate"], ["Holder tiers", "#/treasury"]] },
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
  herald: { t: "Herald", what: "Your referral link and what the wallets you brought did, share cards that carry the link, the weekly Arena Cup and the contributor board.",
    tour: [[".hr-link", "Your link", "Every wallet that signs in through it counts for you. Only what it does after that counts."], [".hr-maker", "Card maker", "A Gate verdict, a Watchfire alert or a PnL as a PNG, with your link and its QR code."], [".hr-lb", "Leaderboard", "Referrers ranked by referred wallets that did something on Troya."], [".hr-cup", "Arena Cup", "Paper strategies ranked by PnL % for the week, at least 3 closed trades."], [".hr-board", "Contributor board", "Work the project needs: code, guides, videos, translations, bug reports."]],
    ask: ["How does the Arena Cup rank traders?"], next: [["Arena", "#/agent/arena"]] },
  agent: { t: "Chat", what: "Talk to Troya like a trader next to you. It pulls live data, prepares tickets, and nothing moves until you sign or your caps allow it.",
    tour: [[".ag-suggest", "Start here", "Tap a question or write your own."], [".ag-composer", "Ask anything", "Coins, perps, stocks, your positions. Tickets appear as cards to confirm."]],
    ask: ["Long ETH $20 at 3x with a stop at 3000", "Twap 0.05 ETH into NVDA over 1 hour"], next: [["Agent Wallet", "#/agent/wallet"]] },
  "agent/wallet": { t: "Agent Wallet", what: "An optional small wallet the agent can use inside the caps you set. Withdrawals only go back to your own wallet.",
    tour: [[".ag-intro", "What it is", "A hot wallet for trading money only, with daily caps."], [".ag-signin", "Sign in", "Signing proves the wallet is yours; it costs nothing."]],
    ask: ["What are safe caps for an Agent Wallet?", "How do I withdraw everything from it?"], next: [["Autopilot", "#/agent/autopilot"], ["Playbooks", "#/agent/playbooks"]] },
  "agent/scepter": { t: "Scepter", what: "One command screen for every agent working for you: the trust ladder, a daily cap for each job, the trades waiting for your yes, a receipt for every action and one switch that stops them all.",
    tour: [[".ag-intro", "One command", "Sentry Autopilot, Playbooks, Aegis exits and Champions all answer to this screen."],
      [".sc-cmd", "Stop every agent", "One switch: nothing trades from your Agent Wallet until you resume, whatever any job wants."],
      [".sc-ladder", "Trust ladder", "Watch: jobs only alert you. Approve, the default: every automated trade waits for your yes. Auto: jobs act on their own, inside every cap and the Gate."],
      [".sc-jobs", "Jobs and their caps", "Each job gets a daily cap in USD, inside your wallet caps, and shows what it used today."],
      [".sc-wait", "Waiting for you", "Automated trades held for your approval: approve or dismiss each one."],
      [".sc-rec", "Receipts", "Every trade your agents made, or were stopped from making, with its reason and its transaction."],
      [".ag-signin", "Sign in", "Scepter belongs to the wallet you sign in with. Signing costs nothing."]],
    ask: ["What is the difference between Watch, Approve and Auto?", "What does Stop every agent stop?", "Why is a trade waiting for my approval?"],
    next: [["Agent Wallet", "#/agent/wallet"], ["Sentry Autopilot", "#/agent/sentry"], ["Playbooks", "#/agent/playbooks"]] },
  "agent/autopilot": { t: "Autopilot", what: "A switch for this browser tab: while it stays open, Autopilot runs due playbook tickets (and chat tickets, if you tick it) with your Agent Wallet instead of waiting for your tap. Its caps and the switch that stops every agent live in the Budget on Agent → Scepter.",
    tour: [[".ag-intro", "How it works", "Rules first; every order still passes the Gate, your limits and the trust ladder in Scepter."]],
    ask: ["What will Autopilot do on its own?", "What is the difference between Autopilot, Sentry Autopilot and Playbooks?"], next: [["Sentry Autopilot", "#/agent/sentry"], ["Scepter", "#/agent/scepter"]] },
  "agent/arena": { t: "Arena", what: "A strategy in plain words becomes rules, is replayed on The Record, then runs 7 days on paper; five AI models trade their own strategies side by side.", tour: [[".ag-intro", "The Arena", "Write a strategy, read the replay, then prove it on paper."]],
    ask: ["Which strategy did best on The Record?"], next: [["The Record", "/record"]] },
  "agent/aegis": { t: "Aegis", what: "A guard on every coin you hold: dev and whale sells, a sell test every five minutes, tax jumps and broken Oaths raise an alert in your inbox and Telegram; exit mode prepares the sell on red.", tour: [[".ag-intro", "Your guard", "Switch it on and every coin in your wallet and Agent Wallet is watched."]],
    ask: ["What does Aegis watch on my coins?"], next: [["Oath", "/oath"]] },
  "agent/sentry": { t: "Sentry Autopilot", what: "Your rules on every new launch Sentry passes: practice with play money, or live from the Agent Wallet.", tour: [[".ag-intro", "Your rules", "Minimum raised, size, take profit and stop."]],
    ask: ["What rules make sense for Sentry Autopilot?", "How is Sentry Autopilot different from Autopilot?"], next: [["The Record", "/record"], ["Scepter", "#/agent/scepter"]] },
  "agent/playbooks": { t: "Playbooks", what: "Rules the server watches for you: stop-loss, take-profit ladders, DCA, TWAP, price alerts, basket rebalances, range and loan guards.", tour: [[".ag-intro", "Rules that watch", "Checked every 20 seconds; triggers execute inside your caps and the trust ladder, or land in your inbox."]],
    ask: ["Set a stop-loss on my ETH long at 3000", "Smart DCA 0.01 ETH into TROYA every day"], next: [["Inbox", "#/portfolio/inbox"], ["Scepter", "#/agent/scepter"]] },
  portfolio: { t: "Portfolio", what: "Your balances across chains, open positions and the steps left to set up.", tour: [[".pf-tiles", "Totals", "What you hold, everywhere."]],
    ask: ["Summarise my portfolio and its biggest risk."], next: [["History", "#/portfolio/history"]] },
  "portfolio/inbox": { t: "Inbox", what: "Alerts from your playbooks, Aegis, Watchfire pins and the X Tracker, and the tickets your agent prepared. A ticket moves nothing until you approve it.",
    tour: [[".pf-inbox", "Your messages", "Newest first, unread ones marked. Each ticket waits for your signature or your yes."], [".pf-connect", "Connect", "The inbox belongs to the wallet you sign in with."]],
    ask: ["What needs my attention in my inbox?", "Why is a trade waiting for my approval?"], next: [["Scepter", "#/agent/scepter"], ["Playbooks", "#/agent/playbooks"]] },
  "portfolio/history": { t: "History", what: "Your journal: every action Troya prepared or ran for this wallet, with the reason behind it, beside your Hyperliquid fills.", tour: [],
    ask: ["What did my agent do today, and why?"], next: [["Scepter receipts", "#/agent/scepter"]] },
  "portfolio/owl": { t: "Weekly review", what: "Owl reads your last 7 days on Robinhood Chain: the coins you traded most, what each one really cost or made in ETH, what Troya knew about it, and three plain lines: keep, change, try.", tour: [],
    ask: ["What should I change from last week?"], next: [["Portfolio", "#/portfolio"]] },
  social: { t: "Social", what: "Your X account on Troya, Troya answering on X, the Holder Pass, holder votes and the agent factory.", tour: [[".sd-tabs", "Five parts", "X, Holder pass, Votes, Agents (and Reports for admins)."], [".so-body", "The part you picked", "Everything signs in your wallet; votes cost no gas."]],
    ask: ["How do I get a Holder Pass?", "How do I build an agent?"], next: [["Flywheel", "#/flywheel"]] },
  "social/agents": { t: "Agent factory", what: "Build a named agent from Troya's own parts: pick a template and it runs as playbooks on your own Agent Wallet, inside your limits, with a public page.",
    tour: [[".so-tpl", "Templates", "Accumulator, Stock index, Silent buyer, Range keeper and Loan guard. Each one is playbooks that already exist."],
      [".so-body .btn.blue", "Build it", "Name it and give it a handle. It acts through your Agent Wallet; with the Agent Wallet off, each action comes to your inbox."],
      [".so-agent", "Agents on Troya", "Every agent with its template, owner, status and actions. Pause, resume or retire your own."]],
    ask: ["Which agent template fits a long-term buyer?", "What can an agent do without my approval?"], next: [["Agent Wallet", "#/agent/wallet"], ["Scepter", "#/agent/scepter"]] },
  treasury: { t: "Treasury", what: "$TROYA holder tiers and what each one unlocks today: Watchfire pins, Gate checks a day and, from 1,000,000 $TROYA, the holder perks. Counted across your signed-in wallet and its Agent Wallet.",
    tour: [[".ts-you", "Your tier", "The $TROYA counted for you and how much more the next tier needs."], [".ts .ag-signin", "Sign in", "Your tier and your pins belong to the wallet you sign in with."],
      [".ts .tbl-wrap", "The tiers", "Visitor, Scout, Soldier, Captain and King's Guard: more Watchfire pins and Gate checks a day as you climb, and the holder perks from Soldier."],
      ['.ts input[aria-label="Coin address to pin"]', "Watchfire pins", "Pin a coin and every Watchfire fire on it reaches your inbox and Telegram."],
      ['.ts input[aria-label="X account to track"]', "X Tracker", "Track an account on X: when it posts a Robinhood Chain contract, Troya runs the Gate and pings you."],
      [".ts-pro", "Pro", "Pro plans, paid in $TROYA or a stablecoin, show here once the team sets their prices."]],
    ask: ["Which tier am I in, and what does the next one unlock?", "What do Watchfire pins do?", "What are the holder perks?"],
    next: [["Buy $TROYA", "#/swap?out=0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"], ["Gate a coin", "#/gate"]] },
  create: { t: "Create coin", what: "Three ways to launch a coin on Robinhood Chain through Troya: on troya.codes with your own wallet, by posting to @Troyaagent on X, or with /launch in Telegram. Each lands on the Pons curve, gets checked by the Gate and shows up in Troya Launches.",
    tour: [[".cc-grid", "Three ways", "The web, X and Telegram, each with its fees, its limits and its status."], [".cc-foot", "After the launch", "Troya Launches lists every coin born through Troya; the Creator desk holds the fees your coins earn."]],
    ask: ["What does it cost to launch through Troya?", "How do I launch a coin from X?", "How does a Pons curve graduate?"],
    next: [["Launch from X", "#/launch/x"], ["Troya Launches", "#/troya-launches"], ["Creator desk", "#/creator"]] },
  "launch/x": { t: "Launch from X", what: "Set up once, then launch a coin by posting to @Troyaagent on X: your Agent Wallet launches it on Pons and Troya replies with the address. Trade on X uses the same link.",
    tour: [[".lx-steps", "Set up", "Sign in, an Agent Wallet, Sign in with X and a little ETH. Set up in one go does all but the ETH."], [".lx-tweet", "The post", "Copy the example: launch Name $TICKER, with a tax and an initial buy if you like, and the image attached."],
      [".lx-sell", "Your launches", "Coins you launched from X, with Sell 25%, 50% or 100% of the initial buy."]],
    ask: ["How do I write a launch post on X?", "Why does my Agent Wallet need its own ETH?"], next: [["Agent Wallet", "#/agent/wallet"], ["Create coin", "#/create"]] },
  creator: { t: "Creator desk", what: "Every coin your wallet launched through Troya, the creator fees waiting for each, read live from Pons, and the claim, signed by your own wallet.",
    tour: [[".cr-sum", "Waiting for you", "Creator fees across your coins, with Claim all."], [".cr-wallet", "Paid to your own wallet", "Coins launched while holding 1,000,000 $TROYA: one escrow claim pays them all."], [".cr-list", "Your coins", "Each coin with what it has earned and its own claim."]],
    ask: ["How are creator fees split on a Troya launch?", "How do I claim my creator fees?"], next: [["Create coin", "#/create"], ["Troya Launches", "#/troya-launches"]] },
  "troya-launches": { t: "Troya Launches", what: "Every coin born through Troya, from X, Telegram or troya.codes, in three lanes: New, Almost bonded and Migrated, each with its live Gate shield.",
    tour: [[".hp-kpis", "The totals", "Coins born through Troya and how they are doing."], [".hp-lanes", "Three lanes", "New, early on the Pons curve; Almost bonded, at least half full; Migrated, graduated to its own Uniswap v4 pool."],
      [".hp-card", "A coin", "Its Gate shield, re-checked every 10 minutes, its tags and its numbers. Tap it for the coin page."]],
    ask: ["What do the tags on a Troya Launches card mean?", "Which Troya launch has the most buyers today?"], next: [["Create coin", "#/create"], ["Born at the gate", "/record#born"]] },
  flywheel: { t: "$TROYA flywheel", what: "Creator fees buy $TROYA back through the Gate, burn it and lock liquidity, every step read back from the chain.", tour: [[".fw-tiles", "The numbers", "Fees earned and claimed, burned and locked."], [".fw-panel", "Cycles", "Every cycle with its transactions."]],
    ask: ["How much $TROYA has been burned so far?"], next: [["Verify", "/verify"]] },
  start: { t: "Start in 60 seconds", what: "The fastest path from nothing to a first checked trade.", tour: [[".st-list", "The steps", "Do them in order; each one says why."]], ask: ["What do I need to start?"], next: [["Desk", "#/"]] },
  registry: { t: "Agent registry", what: "AI agents ranked by the calls they filed on Robinhood Chain coins. Every call is signed when filed and graded in public when its time is up.", tour: [[".rg-kpis", "The totals", "Agents, calls filed and how many came out right."], [".rg-board", "The ranking", "Reputation is the lower bound of the right-call rate: a short lucky run can't top a long record."], [".rg-mine", "Your agents", "Register one and file its calls; each comes back signed."]],
    ask: ["How do I register my agent and file a call?", "How is reputation worked out?"], next: [["Audited rail", "#/rail"]] },
  rail: { t: "Audited rail", what: "Your limits between your AI agent and Robinhood's agentic trading MCP: every order checked, every decision signed, and a kill switch.", tour: [[".rl-kill", "The kill switch", "One click refuses every order until you switch it off."], [".rl-form", "Your policy", "Orders on or off, per order, per day, allowlist, market hours."], [".rl-log", "Audit log", "Every order your agent tried, allowed or refused, with Troya's signature."]],
    ask: ["How do I connect the rail to my agent?", "What does the rail always refuse?"], next: [["Agent registry", "#/registry"]] },
  docs: { t: "Docs", what: "How every part of Troya works, the API and the MCP server.", tour: [], ask: ["How do I connect Troya to my own AI agent over MCP?"], next: [["API and MCP", "/api-and-mcp"]] },
};
// The page under the orb. A second segment that is a page of its own (#/agent/scepter) must never borrow the first
// segment's text: on Scepter the orb used to describe Chat. Only a second segment that is not a known page (a coin
// address, a perp, a stock desk tab, an agent's handle) falls back to the first one. SUB lists the screens with their own
// entry above; a new tab added there without an entry shows the plain fallback, never another page's words.
const SUB = { agent: ["scepter", "wallet", "autopilot", "sentry", "aegis", "arena", "playbooks"], portfolio: ["inbox", "history", "owl"], social: ["agents"], launch: ["create", "x"] };
const ALIAS = { assistant: "agent", hippodrome: "troya-launches", "agent/chat": "agent" };
const keyOf = () => {
  const p = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map((s) => s.toLowerCase());
  const first = ALIAS[p[0]] || p[0] || "";
  if (!p[1]) return G[first] ? first : null;
  const two = ALIAS[`${first}/${p[1]}`] || `${first}/${p[1]}`;
  if (G[two]) return two;
  if (SUB[first]?.includes(p[1])) return null;
  return G[first] ? first : null;
};

/* ---------- the feature glossary: what each part of Troya is, where it lives, and whether it can move money ----------
   One line per feature, in plain words. The Guide uses it to turn the features named in a question into page buttons;
   the assistant (server/assistant.mjs, through server/botfacts.mjs glossary()) reads this same array from this file and
   puts it in its prompt as the FEATURE GLOSSARY, so a guest asking "Autopilot or Sentry Autopilot?" gets the same
   answer the pages give. The server parses the text between the two markers as JSON: keep it strict JSON (double
   quotes, no trailing commas, no comments inside). page: an app route (#/…) or a site path (/…). aka: other names
   people use, for matching only. Write what a feature does, never when it shipped: what is live comes from the roadmap. */
export const GLOSSARY = /* GLOSSARY:BEGIN */ [
  {"name": "Troya Gate", "aka": ["Gate"], "page": "gate", "where": "Discover → Gate a coin", "what": "The pre-trade check on any coin, by name, ticker or address: route, price impact, depth, fees and taxes, a simulated buy, a test sell and transfer tax, plus The Assay on its holders. A snapshot, never a safe stamp.", "money": "No: it reads and simulates."},
  {"name": "Swap", "page": "swap", "where": "Trade → Swap", "what": "Coins and stock tokens on Robinhood Chain, Base, Arbitrum and Solana. The Gate checks every swap, and Troya adds no fee of its own.", "money": "Yes: signed in your own wallet."},
  {"name": "Perps", "page": "perps", "where": "Trade → Perps", "what": "Hyperliquid perps from your own Hyperliquid account, plus trade.xyz stock, index and metal perps, with stops and take-profit.", "money": "Yes: orders on your own Hyperliquid account."},
  {"name": "Hyperliquid spot", "aka": ["Spot (Hyperliquid)"], "page": "spot", "where": "Trade → Spot", "what": "HYPE, UBTC, UETH and other spot coins from your own Hyperliquid account, with a Spot Gate on the live book.", "money": "Yes: orders on your own Hyperliquid account."},
  {"name": "Lighter perps", "aka": ["Lighter"], "page": "lighter", "where": "Trade → Lighter perps", "what": "Lighter perps on Robinhood Chain: deposit USDG, and one signature sets up a trading key made in your browser. Not available in the US, the UK, Canada and other excluded places.", "money": "Yes: deposits and orders you sign."},
  {"name": "Stock desk", "page": "stocks", "where": "Trade → Stock desk", "what": "Robinhood stock tokens with dividend and split multipliers, the dividends and splits calendar, baskets in one go, prices against the real share price, and USDG loans against stocks on Morpho Blue with a Loan Gate.", "money": "Yes: what you sign."},
  {"name": "Liquidity desk", "page": "liquidity", "where": "Trade → Liquidity desk", "what": "Uniswap v3 ranges set from the pool's own volatility, a Liquidity Gate, and a range watch that writes when the price leaves the range or nears an edge.", "money": "Yes: your wallet mints and removes. The range watch moves nothing."},
  {"name": "Bridge", "page": "bridge", "where": "Trade → Bridge", "what": "ETH between Robinhood Chain, Base, Arbitrum and Ethereum through LI.FI, or ETH into USDC on your own Hyperliquid account in one transaction.", "money": "Yes: signed by you."},
  {"name": "Market", "page": "market", "where": "Discover → Market", "what": "Every Robinhood Chain coin with a real pool, plus stock tokens, Hyperliquid perps and spot.", "money": "No."},
  {"name": "War Table", "aka": ["coin page", "token page"], "page": "market", "where": "Every coin's page (Market → a coin)", "what": "Each coin page as a trading terminal: candles down to the second, trades labelled dev, insider, sniper, bundler, ring, whale or bot, holder tags, dev marks, the Watchfire and Tribute panels, and a Callouts and X tab.", "money": "Its one-tap buys and sells come from your Agent Wallet, through the Gate and your caps."},
  {"name": "Watchfire", "page": "market", "where": "Every coin page; pins in Treasury", "what": "Keeps watching a coin after launch for rings and herds: wallets gathering coins into one, a sale of 5% of the supply, holders selling fast, one holder or one trading app holding too much. Fires on your pinned coins reach your inbox and Telegram.", "money": "No: it alerts. The paper Arena sells on a fire."},
  {"name": "Tribute", "page": "market", "where": "Every coin page, /api/tribute/<token>", "what": "Is a coin's revenue real: who paid its holders in the last 12 days and with whose money, what real ETH or USDG backs the market cap, and scripted volume. Verdict: real, caution or fake.", "money": "No."},
  {"name": "Troya Launches", "page": "troya-launches", "where": "Discover → Troya Launches", "what": "Every coin born through Troya, in three lanes (New, Almost bonded, Migrated), each with its live Gate shield.", "money": "No."},
  {"name": "Create coin", "page": "create", "where": "Discover → Create coin", "what": "Launch on Pons from troya.codes with your own wallet, from X by posting to @Troyaagent, or in Telegram with /launch. Troya charges nothing to launch; the Pons launch fee applies.", "money": "Yes: your wallet signs on the web; your Agent Wallet pays from X and Telegram."},
  {"name": "Launch from X and Trade on X", "aka": ["Launch from X", "Launch on X", "Trade on X"], "page": "launch/x", "where": "Create coin → From X", "what": "Set up once (sign in, an Agent Wallet with a little ETH, Sign in with X), then post to @Troyaagent: launch Name $TICKER with the image attached, or buy 0.01 $TROYA. Your launches and their Sell buttons are here.", "money": "Yes: from your Agent Wallet, inside its caps, through the Gate."},
  {"name": "Creator desk", "page": "creator", "where": "Discover → Creator desk", "what": "The coins your wallet launched through Troya, their creator fees read live from Pons, and the claim.", "money": "Yes: claims you sign, paid to your wallet."},
  {"name": "Leaderboard", "page": "leaderboard", "where": "Discover → Leaderboard", "what": "Traders who opted in, ranked by results, with rules you can copy.", "money": "No. A copied rule becomes your own playbook."},
  {"name": "Herald", "page": "herald", "where": "Discover → Herald", "what": "Your referral link and what the wallets you brought did, share cards with your link and QR code, the referrers' board, the weekly Arena Cup (paper strategies by PnL %) and the contributor board.", "money": "No transactions. Referral rewards and Cup prizes are paid in ETH by the team, on the terms the page shows."},
  {"name": "Treasury", "aka": ["holder tiers", "tiers"], "page": "treasury", "where": "Discover → Treasury", "what": "$TROYA holder tiers (Visitor, Scout, Soldier, Captain, King's Guard), counted across your wallet and its Agent Wallet: each tier gives more Watchfire pins and Gate checks a day, and the holder perks start at Soldier (1,000,000 $TROYA). Also your Watchfire pins, the X Tracker and Pro plans once they are priced.", "money": "No: tiers are read from your balance."},
  {"name": "X Tracker", "page": "treasury", "where": "Treasury, or Track on a coin page", "what": "Track accounts on X: when one posts a Robinhood Chain contract, Troya runs the Gate and sends you the post, the coin and the verdict.", "money": "No: alerts only."},
  {"name": "Agent registry", "page": "registry", "where": "Discover → Agent registry", "what": "AI agents file up or down calls on Robinhood Chain coins, signed when filed and graded in public when due; reputation is the lower bound of the right-call rate.", "money": "No: calls are views, never trades."},
  {"name": "Chat (Ask Troya)", "aka": ["Ask Troya", "assistant"], "page": "agent", "where": "Agent → Chat, or the Ask Troya orb", "what": "Ask in plain words: Troya reads the chain live and prepares swap, perp, bridge and playbook tickets.", "money": "Not on its own: a ticket moves nothing until you sign or approve it."},
  {"name": "Scepter", "aka": ["trust ladder", "stop every agent"], "page": "agent/scepter", "where": "Agent → Scepter", "what": "One command screen for every automated job (Sentry Autopilot, Playbooks, Aegis exits, Champions): the trust ladder, a daily USD cap per job, the trades waiting for your yes, receipts, and Stop every agent. Trust ladder: Watch (jobs only alert), Approve (the default: each automated trade waits for your yes), Auto (jobs act on their own, inside every cap and the Gate).", "money": "It moves nothing itself: it decides what the automated jobs may trade from your Agent Wallet."},
  {"name": "Agent Wallet", "page": "agent/wallet", "where": "Agent → Agent Wallet", "what": "An optional small wallet the agent trades from, inside caps you set. It withdraws only to your own wallet and its key can be exported; its page also has your Gate API credits and the one-time approval for Hyperliquid trading.", "money": "Yes: automated jobs, X and Telegram trades and War Table taps use it."},
  {"name": "Autopilot", "page": "agent/autopilot", "where": "Agent → Autopilot", "what": "A switch for your browser tab: while the tab stays open, it runs due playbook tickets (and chat tickets, if ticked) with the Agent Wallet instead of waiting for your tap. The page also holds your limits (per action, per day, leverage, perps) and Pause.", "money": "Yes: from the Agent Wallet inside your limits, only with the trust ladder on Auto. It stops when the tab closes."},
  {"name": "Troya Sentry", "aka": ["Sentry"], "page": "/record", "where": "Its Telegram channel; calls on The Record", "what": "Runs every new Pons launch, and new pools on the other launchpads, through the Gate, checks again at 5, 15 and 60 minutes, and posts only clean passes with real buying. Every call is graded in public on The Record.", "money": "No: it reads and posts. Sentry Autopilot is what can trade on it."},
  {"name": "Sentry Autopilot", "page": "agent/sentry", "where": "Agent → Sentry Autopilot, /autopilot in Telegram", "what": "Your rules on Sentry's passes, run on the server around the clock: when a launch passes the Gate and its curve has raised your minimum, it buys your size, then sells at your take-profit or stop, or after 7 days. Practice mode, the default, uses play money at real prices.", "money": "Practice: no. Live: yes, from the Agent Wallet through the Gate, your caps, its Scepter cap and the trust ladder."},
  {"name": "Playbooks", "page": "agent/playbooks", "where": "Agent → Playbooks, or ask in chat", "what": "Rules the server checks every 20 seconds. On the page: stop-loss and take-profit ladders on Hyperliquid perps, DCA and Smart DCA, TWAP for a big buy or sell, and price alerts. From other desks: a basket rebalance (Stock desk), a loan alert (Stock desk) and a range watch (Liquidity desk). There are no other types.", "money": "When one fires, it trades from the Agent Wallet inside your caps and the trust ladder, or puts a ticket in your inbox. Alerts and watches never move money."},
  {"name": "Aegis", "page": "agent/aegis", "where": "Agent → Aegis, /aegis in Telegram", "what": "A guard on every coin you hold: dev and whale sells, dev coins moved to fresh wallets, a sell test every 5 minutes, tax jumps, broken Oaths and Ring Radar flags, as alerts in your inbox and Telegram. Exit mode also prepares a full sell on a red alert.", "money": "Alert mode: no. Exit mode: a sell, as a ticket you approve, or from the Agent Wallet through the Gate when automatic exits are on and the trust ladder allows it."},
  {"name": "Arena", "page": "agent/arena", "where": "Agent → Arena", "what": "A strategy in plain words becomes rules, is replayed on The Record, then runs 7 days on paper on Sentry's passes. Five AI traders (Claude, GPT, Gemini, DeepSeek, Qwen) trade side by side, with a small real budget of Troya's own.", "money": "Your strategies: paper only."},
  {"name": "Champions", "page": "agent/arena", "where": "Agent → Arena", "what": "Follow an Arena AI trader with live trades in profit, or a strategy proven after its 7 days on paper: your Agent Wallet copies its buys and sells for the amount you chose. No performance fee.", "money": "Yes: from your Agent Wallet through the Gate, your caps, the Champions cap and the trust ladder."},
  {"name": "Audited rail", "aka": ["Troya Rail", "rail"], "page": "rail", "where": "Agent → Audited rail", "what": "Runs on your own machine between your AI agent and Robinhood's agentic trading MCP: every order checked against your policy, every decision signed, and a kill switch.", "money": "It never moves money itself: it allows or refuses your agent's orders."},
  {"name": "Portfolio", "page": "portfolio", "where": "You → Portfolio", "what": "Your balances across chains, positions, the setup steps left, and whether Troya pays your gas.", "money": "No."},
  {"name": "Inbox", "page": "portfolio/inbox", "where": "You → Inbox", "what": "Alerts from your playbooks, Aegis, Watchfire pins and the X Tracker, and tickets waiting for your signature or approval.", "money": "Only a ticket you approve."},
  {"name": "History", "page": "portfolio/history", "where": "You → History", "what": "The journal of every action Troya prepared or ran for you, with the reason, beside your Hyperliquid fills.", "money": "No."},
  {"name": "Owl (weekly review)", "aka": ["Owl", "weekly review"], "page": "portfolio/owl", "where": "You → Portfolio → Weekly review", "what": "Your last 7 days on Robinhood Chain: the coins you traded most, what each really cost or made in ETH, what Troya knew, and three lines: keep, change, try.", "money": "No."},
  {"name": "Social", "aka": ["Holder Pass", "holder votes"], "page": "social", "where": "You → Social", "what": "Link your X account to your wallet, Troya answering on X, the soulbound Troya Holder Pass and holder votes (signed, no gas).", "money": "Minting the Holder Pass is a transaction you sign."},
  {"name": "Agent factory", "aka": ["build an agent"], "page": "social/agents", "where": "You → Social → Agents", "what": "Name an agent and pick a template (Accumulator, Stock index, Silent buyer, Range keeper, Loan guard): it runs as playbooks on your own Agent Wallet, with a public page.", "money": "Yes: through your Agent Wallet inside your limits; with it off, each action is a ticket."},
  {"name": "$TROYA flywheel", "aka": ["flywheel", "buyback"], "page": "flywheel", "where": "Help → $TROYA flywheel", "what": "Creator fees on $TROYA claimed, bought back through the Gate, burned and added as locked liquidity, each step read back from the chain.", "money": "Cycles are signed by the creator wallet; the page only reads."},
  {"name": "The Record", "aka": ["chart oracle"], "page": "/record", "where": "troya.codes/record", "what": "Every Sentry call graded in public (at the call, 1 h, 24 h, peak), every coin born through Troya, and the chart oracle: a note every 6 hours on ETH, BTC, $TROYA and top picks, graded 24 hours later.", "money": "No."},
  {"name": "Oath", "aka": ["Oath Vault"], "page": "/oath", "where": "troya.codes/oath, /oath in Telegram", "what": "A dev's signed pledge (a cap on the supply sold a day, days the fees stay unclaimed, the wallets disclosed), watched on chain as kept or broken; a broken Oath turns the Gate verdict to caution. The Oath Vault locks a dev's coins to a cliff and a daily release.", "money": "Only a dev's own coins."},
  {"name": "Ring Radar", "page": "gate", "where": "Gate flags, Sentry posts, /ring in Telegram", "what": "Reads every Pons launch for a rigged start: wallets the creator freed from the snipe tax, bundles, reused bundlers and same-name decoys.", "money": "No."},
  {"name": "Council", "page": "gate", "where": "Gate page, /council in Telegram", "what": "Three reasons not to buy, then bull, bear and risk analysts who may only cite numbered Troya facts; every verdict sealed.", "money": "No."},
  {"name": "Robinhood Radar", "page": "stocks", "where": "Stock desk gaps, the Gate page, /smart in Telegram", "what": "Stock tokens against the real share price in the US session, smart wallets that keep buying early, and which Robinhood Chain coins the Robinhood app lists.", "money": "No."},
  {"name": "Seal", "page": "/seal", "where": "troya.codes/seal", "what": "A signed, hash-chained receipt (ECDSA and post-quantum ML-DSA-65) for every Gate API check, Sentry call, Council verdict and red Aegis alert, anchored on Robinhood Chain daily.", "money": "No."},
  {"name": "Gate API, CLI and MCP", "aka": ["Gate API", "Troya CLI", "MCP server", "Allies and Skills"], "page": "/api-and-mcp", "where": "troya.codes/api-and-mcp", "what": "For builders and other agents: signed Gate checks at their own size (GET /api/gate/v1/check/<token>), the CLI (npx @troyaagent/cli), the remote MCP server (troya.codes/mcp), skill.md, llms.txt and a free verdict feed. Free checks a day by tier, then USDG credit.", "money": "Reads only, except swaps an API token allows, a dry run unless switched to live."},
  {"name": "Gate in MetaMask", "aka": ["MetaMask Snap", "Snap"], "page": "/snap", "where": "troya.codes/snap", "what": "The Troya Gate Snap (@troyaagent/snap) shows the Gate's verdict on the MetaMask confirm screen for Robinhood Chain transactions.", "money": "No: you still confirm in MetaMask."},
  {"name": "Gate badge", "aka": ["badge"], "page": "/badge", "where": "troya.codes/badge", "what": "A live Gate badge any project can put on its site, re-checked at most every 10 minutes.", "money": "No."},
  {"name": "Telegram bot", "aka": ["Troya bot", "TrojanTroya_bot"], "page": "/launch-on-x#telegram", "where": "@TrojanTroya_bot, private chat", "what": "Trades, /launch, perps, stops and playbooks in plain words, /autopilot, /aegis, /assay, /ring, /council, /oath, /smart, the daily brief and your alerts, once the chat is linked in Settings.", "money": "Trades and launches come from your Agent Wallet after you tap Confirm."}
] /* GLOSSARY:END */;

// the features a text names, in the order it names them: longest names first, so "Sentry Autopilot" is never also read
// as "Autopilot" or "Sentry" (the server's parser uses the same rule)
const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const TERMS = GLOSSARY.flatMap((g) => [g.name.replace(/\s*\([^)]*\)\s*$/, ""), ...(g.aka || [])].map((t) => [norm(t).trim(), g]))
  .filter(([t]) => t.length > 2).sort((a, b) => b[0].length - a[0].length);
function featuresIn(text) {
  let s = norm(text);
  const hits = [];
  for (const [t, g] of TERMS) for (const form of [t, `${t}s`]) {
    const k = ` ${form} `;
    for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k)) {
      if (!hits.some((x) => x.g === g)) hits.push({ g, i });
      s = s.slice(0, i + 1) + "#".repeat(form.length) + s.slice(i + 1 + form.length);   // same length: positions hold
    }
  }
  return hits.sort((a, b) => a.i - b.i).map((x) => x.g);
}

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
// a nudge speaks about the page that raised it ("$X failed a check at the Gate"): it goes the moment the user moves on,
// never riding along to the next page for the rest of its 16 seconds
function hideNudge() { clearTimeout(nudgeTimer); if (nudgeEl) nudgeEl.hidden = true; }
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
  addEventListener("hashchange", () => { endTour(); hideNudge(); if (document.body.classList.contains("g-open")) render(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("g-open")) close(); });
  return { open, close };
}
