// In-app docs: how Troya works, Troya Gate, limits, Agent Wallet trust model, playbooks, MCP + REST, glossary, FAQ.
import { h, clear, icon, useCss, copyText, esc } from "../ui.js";
import { api } from "../api.js";

const SITE = window.SITE || {};
const PKG = SITE.mcpPackage || "@troyaagent/mcp";

const code = (text, label) => h("div", { class: "dc-code" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => copyText(text, `${label || "Snippet"} copied`) }, icon("copy"), "Copy"), h("pre", {}, h("code", {}, text)));
const P = (...kids) => h("p", {}, ...kids);
const UL = (items) => h("ul", {}, items.map((x) => h("li", {}, x)));

export async function mount(view) {
  useCss("docs");
  const base = location.origin;
  const sections = [
    ["overview", "Overview", [
      P("Troya Agent is a trading desk for Robinhood Chain (chain 4663) and Hyperliquid perps, with an assistant in front of it. You ask in plain words; Troya reads live data, runs checks, and hands you a ticket. Nothing moves until you sign it, or until your optional Agent Wallet acts inside the caps you set."),
      UL([
        [h("b", {}, "Desk: "), "the app's home (troya.codes/agent): the next setup step, live prices, the Gate, your agent's status, the brief, signals and Sentry on one page. The sidebar groups every tool (Trade, Discover, Agent, You, Help), and Ask Troya or Cmd K opens the agent beside any page; paste a coin there to gate it."],
        [h("b", {}, "Gate a coin: "), "paste any Robinhood Chain address at #/gate and see the seven checks, the same ones that run before every order."],
        [h("b", {}, "Market: "), "Robinhood Chain coins and tokenized stocks from GeckoTerminal pools and Pons on chain (Long.xyz, Bankr, Frontier.fun, Abyss, Goo, Clank.trade, o1 and Virtuals included), plus every Hyperliquid perp and spot pair."],
        [h("b", {}, "Swap: "), "any pair on Robinhood Chain through Pons curves and Uniswap v3/v4 pools, and coins from the other Robinhood Chain launchpads (Long.xyz, Bankr, Frontier.fun, Abyss, Virtuals and more) through KyberSwap. You sign in your own wallet."],
        [h("b", {}, "Perps: "), "Hyperliquid orders with leverage, take-profit and stop-loss, signed by a trade-only key you approve once."],
        [h("b", {}, "Bridge: "), "ETH between Robinhood Chain and Arbitrum, Base or Ethereum through LI.FI routes, or To Hyperliquid: ETH on Robinhood Chain becomes USDC on your own Hyperliquid account in one transaction."],
        [h("b", {}, "Telegram: "), "trade Robinhood Chain coins from a private chat with @TrojanTroya_bot (Gate first, then Confirm), and follow t.me/troyasentry: every new Pons launch, and new pools on Uniswap and the other Robinhood Chain launchpads, go through the Gate, and the channel posts the clean passes with at least 0.5 ETH of real buying from 25 or more independent wallets (no bots, farms or copies)."],
        [h("b", {}, "Gate badge: "), "a live Troya Gate result Pons devs can embed on their site (troya.codes/badge)."],
        [h("b", {}, "Daily brief: "), "positions, PnL, liquidation distance, funding, the nearest stop, the market and Sentry every morning, with smart alerts (Portfolio → Today's brief, /brief in Telegram)."],
        [h("b", {}, "Sentry Autopilot: "), "your rules on every launch that passes the Gate, in practice mode first, with a leaderboard you can copy rules from (Agent → Sentry Autopilot, #/leaderboard, /autopilot)."],
        [h("b", {}, "Start: "), "a guided 60-second setup at #/start."],
        [h("b", {}, "Launchpad: "), "new coins from Pons, Long.xyz, Bankr, Frontier.fun, Abyss, Virtuals and more, and a form to launch your own on Pons."],
        [h("b", {}, "Agent: "), "chat, Agent Wallet, Autopilot and Playbooks."],
        [h("b", {}, "Arbitrum and Base: "), "pick the network above the Swap card; KyberSwap routes, the same Troya Gate, your own wallet signs. Arbitrum is live (16 Nov 2026); Base shows quotes and the Gate and opens after its own real-money test."],
        [h("b", {}, "Next (Roadmap v3, in build): "), "Solana and Hyperliquid spot."],
      ]),
    ]],
    ["token", "$TROYA token", (() => {
      // Facts read from chain on 15 Nov 2026 (mint log, totalSupply, burns to 0x0, curve state, owner()). Each links to a place to check it.
      const ca = SITE.ca || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
      const BS = "https://robinhoodchain.blockscout.com";
      const A = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);
      return [
        P("$TROYA is the Troya Agent token on Robinhood Chain. Everything below can be checked on chain; the links show where."),
        h("div", { class: "dc-ca" }, code(ca, "Contract address")),
        UL([
          [h("b", {}, "Fair launch on Pons: "), "launched 14 Nov 2026 (UTC). All 1,000,000,000 tokens were minted once, straight into the Pons bonding curve. There was no presale and no pre-minted team allocation: every token in a wallet, the team's included, was bought from the curve."],
          [h("b", {}, "No owner: "), "the token contract has no owner."],
          [h("b", {}, "Burns: "), "the dev wallet has burned 26,884,853 $TROYA in 6 transactions to the zero address (as of 15 Nov 2026), so supply is now about 973.1M. ", A(`${BS}/token/${ca}`, "Live supply on Blockscout"), "."],
          [h("b", {}, "Fees on the curve: "), "each curve trade pays 1% to Pons and a 1.9% creator tax to the ", A(`${BS}/address/0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`, "creator wallet"), ". At 4.2 ETH raised the curve graduates to a Uniswap v4 pool."],
          [h("b", {}, "Uniswap pool: "), "an ETH/TROYA Uniswap v4 pool (1% fee) has traded alongside the curve since 15 Nov 2026. It is the pair ", A(`https://dexscreener.com/robinhood/${ca}`, "DexScreener"), " tracks. Its liquidity position (Uniswap v4 NFT #4293939) was burned by the creator wallet on 15 Nov 2026, so nobody, the team included, can remove that liquidity: ", A(`${BS}/tx/0xfe7f12591df9b9f53a0366a31cf36d1cf00b8200b6ae05fb8eeb7989afc24ea0`, "burn transaction"), "."],
        ]),
        h("h3", {}, "What holding it does"),
        P("From 16 Nov 2026, 12:00 UTC, a wallet holding at least 1,000,000 $TROYA (your signed-in wallet plus its Agent Wallet, read from chain) gets:"),
        UL(["200 assistant messages a day instead of 20", "100 active playbooks instead of 25", "Every coin Troya Sentry posts, by private message on Telegram"]),
        P("Check your status with /wallet in a private chat with ", A("https://t.me/TrojanTroya_bot", "@TrojanTroya_bot"), "."),
        h("h3", {}, "Not announced"),
        P("Allocations beyond the above, vesting, buybacks, future burns and exchange listings have not been announced. Anything about $TROYA that is not here, on x.com/Troyaagent or in t.me/troyaagent is not from the team."),
        P(A(`${BS}/token/${ca}`, "Blockscout"), " · ", A(`https://dexscreener.com/robinhood/${ca}`, "DexScreener"), " · ", A(`https://ponsfamily.com/launchpad/${ca}`, "Pons"), " · ", A("https://troya.codes/verify", "Proof log")),
      ];
    })()],
    ["flow", "How a request flows", [
      h("ol", { class: "dc-steps" },
        h("li", {}, h("b", {}, "Read. "), "Read tools fetch prices, books, funding, balances and contract code. They cannot move funds."),
        h("li", {}, h("b", {}, "Prepare. "), "The order is simulated, checked by Troya Gate and your limits, and turned into a ticket (in chat) or a one-time confirmationId (over MCP/REST, valid 120 seconds and bound to a hash of the parameters). Chat tickets expire after 10 minutes."),
        h("li", {}, h("b", {}, "Execute. "), "You sign the ticket in your wallet, or the Agent Wallet runs it inside its caps. Over MCP/REST, execute_intent takes only the confirmationId and re-checks your limits. Every outcome lands in your journal with its reason.")),
    ]],
    ["perps", "Perps from zero", [
      P("Perps run on your own Hyperliquid account, which needs USDC as margin. The whole path, from ETH on Robinhood Chain to an open position:"),
      h("ol", { class: "dc-steps" },
        h("li", {}, h("b", {}, "Fund. "), "Bridge → To Hyperliquid, or ask the chat \"fund my Hyperliquid with 0.02 ETH\". One transaction on Robinhood Chain; the USDC lands on your own Hyperliquid account, usually within a minute. The Agent Wallet can run it too, and the USDC still lands on your account."),
        h("li", {}, h("b", {}, "Approve once. "), "Trade on the Perps page with a trade-only browser key, or let the Agent Wallet trade: Agent → Hyperliquid trading → Approve on Hyperliquid. It can place and cancel orders; it cannot withdraw."),
        h("li", {}, h("b", {}, "Trade. "), "Ask \"long ETH $50 at 3x, stop 3000\". Troya Gate and your caps run first, you confirm. Playbooks can guard the position: a stop-loss or a take-profit ladder checked every 20 seconds.")),
      P("From a terminal: prepare_hl_funding, prepare_perp_order and prepare_close_position, each confirmed with execute_intent. Live orders need two locks opened: dry-run off for that API token in the app, and the MCP started with TROYA_LIVE=1."),
    ]],
    ["autopilot", "Sentry Autopilot", [
      P("Sentry checks every Pons launch about 90 seconds in, and again at 5, 15 and 60 minutes while it is quiet. When a launch passes and its curve has raised at least what you set, Autopilot buys your amount, then sells at your take-profit or stop, or after 7 days. Exits are checked every 60 seconds."),
      UL([
        [h("b", {}, "Practice: "), "play money at real prices. Entries and exits are quoted on chain when they happen; nothing is sent."],
        [h("b", {}, "Live: "), "buys and sells from your Agent Wallet, so Troya Gate and your caps run again on each trade. Tested with real money on 15 Nov 2026 (troya.codes/verify)."],
        [h("b", {}, "Rules: "), "curve raised at least (ETH), buy per coin (ETH), take profit (x), stop (% down), open at once, buys a day. In Telegram: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3, or plain words."],
        [h("b", {}, "Leaderboard: "), "opt in to show your results with a shortened address; anyone can copy the rules of a trader on the board."],
      ]),
    ]],
    ["gate", "Troya Gate", [
      P("Troya Gate runs before anything executes. A failed check blocks the action; a warning is shown on the ticket."),
      UL([
        [h("b", {}, "Route: "), "an executable route exists for the swap."],
        [h("b", {}, "Price impact: "), "below the operator limit (default 8%)."],
        [h("b", {}, "Pool depth: "), "enough ETH on the pool's ETH side, or raised on a Pons curve (default 0.25 ETH)."],
        [h("b", {}, "Contract: "), "bytecode heuristics for mint, pause, blacklist, fee setters, proxies and live owners. A heuristic, not an audit."],
        [h("b", {}, "Transfer tax: "), "fee or tax setters in the token contract, and the fixed creator tax on Pons coins."],
        [h("b", {}, "Sell simulation: "), "a test sell of the exact amount goes through against the live curve or pool (simulated, never sent)."],
        [h("b", {}, "Perps: "), "market exists, leverage within the market and your cap, the size fits the visible book, slippage and funding."],
      ]),
      P("Token names, tickers and social posts come from the internet. Troya treats them as untrusted text: shown as data, never followed as instructions."),
    ]],
    ["limits", "Limits and policy", [
      P("Limits live outside any model, in a policy file the server re-reads on every action. The operator sets the ceiling; you can only go stricter, in Agent → Autopilot."),
      UL(["Per-action and per-day USD caps", "Maximum leverage", "Allowed perp markets (empty means all)", "Pause: stops every Agent Wallet action at once", "Operator kill switch: stops all execution for everyone"]),
      P("Troya charges no fee during the beta. Network gas and venue fees (pool fees, Hyperliquid fees) still apply."),
    ]],
    ["wallet", "Agent Wallet trust model", [
      P("By default Troya is non-custodial: your wallet signs every transaction and the app never sees its key."),
      P("The Agent Wallet is optional and custodial. It is a separate small wallet whose key the operator stores encrypted (AES-256-GCM). It lets the agent act without a popup each time."),
      UL([
        "Withdrawals go only to the address that owns it.",
        "Per-action and per-day caps, plus your limits, apply to everything it does.",
        "Its key can be exported at any time with a fresh signature from your wallet.",
        "On Hyperliquid it trades as an approved agent on your account: trade-only, it cannot withdraw there.",
        "Keep its balance small. Your main wallet is never touched.",
      ]),
    ]],
    ["playbooks", "Playbooks and Autopilot", [
      P("Playbooks are rules the server checks every 20 seconds: stop-loss guards, take-profit ladders, DCA schedules and price alerts. When one fires, the Agent Wallet executes it if it is on and inside its caps; otherwise you get a ticket in your inbox (valid 10 minutes)."),
      P("Autopilot is opt-in and runs in your browser tab. It picks up due tickets and runs them with the Agent Wallet, so you do not have to click each one. Close the tab and it stops."),
    ]],
    ["mcp", "MCP setup", [
      P("Use Troya from Claude Desktop, Cursor or Claude Code. The MCP server holds no keys; it calls this server's API with your token."),
      P("1. Create an API token in ", h("a", { class: "link", href: "#/agent/wallet" }, "Agent → Wallet → API tokens"), ". Tokens are stored hashed and start in dry-run."),
      P("2. Add the server:"),
      code(`npx -y ${PKG}`, "Command"),
      P(h("b", {}, "Claude Desktop / Cursor"), " (claude_desktop_config.json or .cursor/mcp.json):"),
      code(JSON.stringify({ mcpServers: { troya: { command: "npx", args: ["-y", PKG], env: { TROYA_BASE_URL: base, TROYA_API_KEY: "troya_…" } } } }, null, 2), "Config"),
      P(h("b", {}, "Claude Code:")),
      code(`claude mcp add troya --env TROYA_BASE_URL=${base} --env TROYA_API_KEY=troya_… -- npx -y ${PKG}`, "Command"),
      UL([
        [h("code", {}, "TROYA_BASE_URL"), " this server (", h("code", {}, "TROYA_URL"), " also works)."],
        [h("code", {}, "TROYA_API_KEY"), " needed for prepare and execute tools; read tools work without it."],
        [h("code", {}, "TROYA_LIVE=1"), " lets execute_intent run live. Execution also needs a token with the execute scope and dry-run switched off for that token."],
      ]),
    ]],
    ["rest", "REST API", [
      P("Base URL: ", h("code", {}, `${base}/agent/api`), " (also served at ", h("code", {}, `${base}/api`), ")."),
      code([
        "GET  /agent/api/tools                     list tools, tiers, JSON schemas",
        "GET  /agent/api/tools/:name?arg=value     read tools (public)",
        "POST /agent/api/tools/:name   {args}      prepare: x-api-key · execute: x-api-key + Idempotency-Key",
        "GET  /agent/api/market/robinhood          Robinhood Chain coins",
        "GET  /agent/api/market/robinhood/token?address=0x…",
        "GET  /agent/api/market/stocks             tokenized stocks",
        "GET  /agent/api/swap/quote?tokenIn=ETH&tokenOut=0x…&amountIn=0.01",
        "GET  /agent/api/market/hl                 Hyperliquid perps",
      ].join("\n"), "Routes"),
      code(`curl "${base}/agent/api/tools/analyze_ticker?coin=BTC"\n\ncurl -X POST ${base}/agent/api/tools/prepare_order \\\n  -H "x-api-key: troya_…" -H "content-type: application/json" \\\n  -d '{"kind":"perp","coin":"ETH","side":"long","sizeUsd":50,"leverage":3}'\n\ncurl -X POST ${base}/agent/api/tools/execute_intent \\\n  -H "x-api-key: troya_…" -H "Idempotency-Key: $(uuidgen)" -H "content-type: application/json" \\\n  -d '{"confirmationId":"cf_…"}'`, "Examples"),
      h("div", { class: "dc-tools", "data-tools": "" }, h("div", { class: "sk", style: { height: "120px" } })),
    ]],
    ["chains", "Chains and venues", [
      UL([
        [h("b", {}, "Robinhood Chain: "), "chain 4663, an Ethereum L2 on Arbitrum Orbit, gas in ETH. Explorer: robinhoodchain.blockscout.com."],
        [h("b", {}, "Pons Family: "), "bonding-curve launches; a coin graduates into a Uniswap v4 pool with the Pons hook. 1% fee (70% to the creator) plus an optional creator tax up to 10%."],
        [h("b", {}, "Uniswap v3 / v4: "), "everything else, with WETH and USDG as the main hubs. Tokenized stocks trade here."],
        [h("b", {}, "Hyperliquid: "), "perps. Orders go to Hyperliquid mainnet."],
        [h("b", {}, "Bridge: "), "LI.FI routes between Robinhood Chain and Arbitrum, Base or Ethereum, usually minutes."],
      ]),
    ]],
    ["glossary", "Glossary", [
      h("dl", { class: "dc-dl" },
        ...[["Ticket", "A proposed action with its numbers and checks. Expires after 10 minutes."], ["confirmationId", "One-time id from a prepare tool, valid 120 seconds, bound to the exact parameters."], ["Dry-run", "The action is checked and logged but not sent."], ["Funding", "Hourly payment between longs and shorts on a perp. Positive: longs pay."], ["Price impact", "How much your own order moves the pool price."], ["Agent Wallet", "Optional custodial hot wallet the agent can use inside caps."], ["Journal", "Your audit log: every action, its reason and outcome."]]
          .flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    ]],
    ["faq", "FAQ", [
      ...[["Does Troya hold my funds?", "No, unless you create an Agent Wallet. That one is custodial by design and capped; your own wallet stays yours."],
        ["Can the agent trade without me?", "Only through the Agent Wallet, only inside its caps and your limits, and only when it is switched on. Pause stops it instantly."],
        ["Is the token health score an audit?", "No. It reads the contract bytecode for common owner controls. A clean score does not make a token safe."],
        ["Why was my action blocked?", "The ticket shows which Troya Gate check or limit failed. Your journal keeps the reason."],
        ["How many chat messages do I get?", "The operator sets a free daily allowance per wallet (20 by default)."]]
        .map(([q, a]) => h("details", { class: "dc-faq" }, h("summary", {}, q), h("p", {}, a))),
    ]],
  ];

  const toc = h("nav", { class: "dc-toc", "aria-label": "Docs sections" }, sections.map(([id, t]) => h("a", { href: `#/docs`, "data-id": id, onclick: (e) => { e.preventDefault(); document.getElementById(`dc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, t)));
  const content = h("div", { class: "dc-content" }, sections.map(([id, t, kids]) => h("section", { id: `dc-${id}`, class: "dc-sec" }, h("h2", {}, t), kids)));
  clear(view, h("div", { class: "dc-wrap" },
    h("header", { class: "page-head" }, h("h1", {}, "Docs"), h("p", {}, "How Troya works, what it checks, and how to plug your own agent in.")),
    h("div", { class: "dc-grid" }, toc, content)));

  // tools table from the live registry
  const box = content.querySelector("[data-tools]");
  try {
    const r = await api.get("tools");
    clear(box, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Tool"), h("th", { class: "l" }, "Tier"), h("th", { class: "l" }, "What it does"))),
      h("tbody", {}, r.tools.map((t) => h("tr", {}, h("td", { class: "l mono" }, t.name), h("td", { class: "l" }, h("span", { class: `badge-s ${t.tier === "read" ? "" : t.tier === "prepare" ? "blue" : "warn"}` }, t.tier)), h("td", { class: "l dc-desc" }, t.description)))))));
  } catch (e) { clear(box, h("p", { class: "faint" }, `Tool list unavailable: ${esc(e.message)}`)); }

  // highlight the section in view
  const links = [...toc.querySelectorAll("a")];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { const id = en.target.id.slice(3); links.forEach((a) => a.toggleAttribute("aria-current", a.dataset.id === id)); }
  }, { rootMargin: "-20% 0px -70% 0px" });
  content.querySelectorAll(".dc-sec").forEach((s) => io.observe(s));
  return () => io.disconnect();
}
