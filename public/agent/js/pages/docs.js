// In-app docs: how Troya works, Troya Gate, limits, Agent Wallet trust model, playbooks, MCP + REST, glossary, FAQ.
import { h, clear, icon, useCss, copyText, esc } from "../ui.js";
import { api } from "../api.js";

const SITE = window.SITE || {};
const PKG = SITE.mcpPackage || "@troyaagent/mcp";

const code = (text, label) => h("div", { class: "dc-code" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => copyText(text, `${label || "Snippet"} copied`) }, icon("copy"), "Copy"), h("pre", {}, h("code", {}, text)));
const P = (...kids) => h("p", {}, ...kids);
const UL = (items) => h("ul", {}, items.map((x) => h("li", {}, x)));
const L = (href, text) => h("a", { href, ...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener" } : {}) }, text);

export async function mount(view, ctx = {}) {
  useCss("docs");
  const base = location.origin;
  const sections = [
    ["overview", "Overview", [
      P("Troya Agent is a trading desk for Robinhood Chain (chain 4663) and Hyperliquid perps, with an assistant in front of it. You ask in plain words; Troya reads live data, runs checks, and hands you a ticket. Nothing moves until you sign it, or until your optional Agent Wallet acts inside the caps you set."),
      UL([
        [h("b", {}, "Desk: "), "the app's home at ", L("#/", "troya.codes/agent"), ": the next setup step, live prices, the Gate, your agent's status, the brief, signals and Sentry on one page. The sidebar groups every tool (Trade, Discover, Agent, You, Help), and Ask Troya or Cmd K opens the agent beside any page; paste a coin there to gate it."],
        [h("b", {}, "Gate a coin: "), "paste any Robinhood Chain address on ", L("#/gate", "Gate a coin"), " and see the eight checks, the same ones that run before every order."],
        [h("b", {}, "Market: "), "Robinhood Chain coins and tokenized stocks from GeckoTerminal pools and Pons on chain (Long.xyz, Bankr, Frontier.fun, Abyss, Goo, Clank.trade, o1 and Virtuals included), plus every Hyperliquid perp and spot pair."],
        [h("b", {}, "Swap: "), "any pair on Robinhood Chain through Pons curves and Uniswap v3/v4 pools, and coins from the other Robinhood Chain launchpads (Long.xyz, Bankr, Frontier.fun, Abyss, Virtuals and more) through KyberSwap. You sign in your own wallet."],
        [h("b", {}, "Perps: "), "Hyperliquid orders with leverage, take-profit and stop-loss, signed by a trade-only key you approve once."],
        [h("b", {}, "Bridge: "), "ETH between Robinhood Chain and Arbitrum, Base or Ethereum through LI.FI routes, or To Hyperliquid: ETH on Robinhood Chain becomes USDC on your own Hyperliquid account in one transaction."],
        [h("b", {}, "Telegram: "), "trade Robinhood Chain coins from a private chat with @TrojanTroya_bot (Gate first, then Confirm), and follow the ", L("https://t.me/troyasentry", "Sentry channel"), ": every new Pons launch, and new pools on Uniswap and the other Robinhood Chain launchpads, go through the Gate, and the channel posts the clean passes with at least 0.5 ETH of real buying from 25 or more independent wallets (no bots, farms or copies)."],
        [h("b", {}, "Gate badge: "), "a live Troya Gate result Pons devs can embed on their site (", L("/badge", "Gate badge"), ")."],
        [h("b", {}, "Daily brief: "), "positions, PnL, liquidation distance, funding, the nearest stop, the market and Sentry every morning, with smart alerts (Portfolio → Today's brief, /brief in Telegram)."],
        [h("b", {}, "Sentry Autopilot: "), "your rules on every launch that passes the Gate, in practice mode first, with a leaderboard you can copy rules from (", L("#/agent/sentry", "Sentry Autopilot"), ", the ", L("#/leaderboard", "Leaderboard"), ", /autopilot in Telegram)."],
        [h("b", {}, "Start: "), "a guided setup: ", L("#/start", "Start in 60 seconds"), "."],
        [h("b", {}, "All launches: "), "new coins from Pons, Long.xyz, Bankr, Frontier.fun, Abyss, Virtuals and more (", L("#/launch", "All launches"), "). To launch your own coin, see Launch a coin below."],
        [h("b", {}, "Agent: "), "chat, Agent Wallet, Autopilot and Playbooks."],
        [h("b", {}, "Arbitrum and Base: "), "pick the network above the Swap card; KyberSwap routes, the same Troya Gate, your own wallet signs (live since 16 Nov 2026, each tested with real money)."],
        [h("b", {}, "Solana: "), "pick Solana above the Swap card: Jupiter routes (pump.fun and every other Solana launchpad), a Solana Gate (who can freeze or mint the coin, Token-2022 traps, the swap simulated from your address, a sell route), signed in your own Solana wallet (live since 16 Nov 2026)."],
        [h("b", {}, "Spot (Hyperliquid): "), "buy and sell HYPE, UBTC, UETH and every Hyperliquid spot coin from your own Hyperliquid account; a Spot Gate reads the live book first and orders never fill more than 1% from the price (live since 16 Nov 2026)."],
        [h("b", {}, "The Assay: "), "under every Gate result: what the dev bought, sold and holds, liquidity pulled, top-10 concentration, the first 30 seconds of buyers, wallet clusters, round-trip trading and who funded the dev. Red and amber flags only, never a safe stamp."],
        [h("b", {}, "TWAP and Smart DCA: "), "Agent → Playbooks. TWAP splits a big buy or sell into slices that each stay under a price-impact cap (a slice waits for depth instead of going through); Smart DCA buys 0.5–1.5× the base by the 7-day average, within the total budget."],
        [h("b", {}, "More perps: "), "the Perps page also lists trade.xyz stock, index and metal perps (same Hyperliquid key; USDC moves into the trade.xyz balance with one signature), and Perps · Lighter (Robinhood) trades Lighter's exchange on Robinhood Chain with USDG and a key made in your browser."],
        [h("b", {}, "Stock desk: "), "stock tokens with their dividend and split multiplier, the corporate actions calendar, baskets in one go, a rebalance playbook, and USDG loans against your stocks on Morpho Blue with a Loan Gate and alerts."],
        [h("b", {}, "The Record: "), L("/record", "The Record"), " grades every Sentry call: the price at the call, an hour later, a day later and the peak."],
      ]),
    ]],
    ["launch", "Launch a coin", (() => {
      const tg = h("span", {}, h("b", {}, "In Telegram: "), "launching from a private chat with @TrojanTroya_bot is built and in its real-money test; it opens once that test is done.");
      api.get("launch/rules").then((r) => { if (r?.tgLaunch) clear(tg, h("b", {}, "In Telegram: "), "send /launch to ", L(`https://t.me/${r.tgBot || "TrojanTroya_bot"}`, `@${r.tgBot || "TrojanTroya_bot"}`), " in a private chat and answer the questions, or send one photo with the launch line as its caption."); }).catch(() => {});
      return [
        P("Anyone can launch a Pons coin through Troya. Launching is free; Pons charges its own small launch fee. Every coin born through Troya wears the Troya horse on its logo across Troya and shows on ", L("#/troya-launches", "Troya Launches"), " in three lanes: New, Almost bonded and Migrated."),
        h("h3", {}, "Three ways to launch"),
        UL([
          [h("b", {}, "On troya.codes: "), L("#/create", "Create coin"), ". Your own wallet signs."],
          [h("b", {}, "From X: "), "set it up once on ", L("#/launch/x", "Launch from X"), " (sign in, link X, an Agent Wallet with a little ETH), then post \"@Troyaagent launch Name $TICKER\" with the image attached. Add \"tax 2%\" for a creator tax and \"buy 0.01\" for an initial buy. Troya replies with the address, or with what to fix (nothing is spent then). The full guide is on ", L("/launch-on-x", "Launch on X"), "."],
          tg,
        ]),
        h("h3", {}, "Fees and limits"),
        UL([
          "The Pons fee is 1% of volume, and 0.7% of it is the creator's share.",
          "Without 1,000,000 $TROYA: you keep 0.6% of volume and all of your creator tax; Troya takes 0.1% through a fee-split contract nobody can change. Up to 3 launches a day per wallet, at most 1 of them from X (days in UTC).",
          "With 1,000,000 $TROYA or more (your wallet plus its Agent Wallet): 100% of the creator fee goes straight to your wallet, and there is no daily limit.",
          "Creator tax: 0% to 4%, all of it yours.",
          "Any name and ticker: the ticker is letters and numbers (16 at most), the name up to 48 characters. Both are written into the coin for good.",
        ]),
        h("h3", {}, "After the launch"),
        P(L("#/creator", "Creator desk"), " shows every coin you launched through Troya with the creator fees waiting for each, and claims them in one click, signed by your own wallet. An initial buy from X sits in your Agent Wallet; sell it from ", L("#/launch/x", "Launch from X"), " (Your launches)."),
      ];
    })()],
    ["token", "$TROYA token", (() => {
      // Facts read from chain on 15 Nov 2026 (mint log, totalSupply, burns to 0x0, curve state, owner()). Each links to a place to check it.
      const ca = SITE.ca || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
      const BS = "https://robinhoodchain.blockscout.com";
      const A = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);
      const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.round(n).toLocaleString("en-US"));
      const burnLine = h("span", {}, "every $TROYA burned lowers the total supply; the running total is read from the chain on the flywheel page.");
      api.get("flywheel").then((f) => { const b = f?.burned; if (b?.total > 0) burnLine.textContent = `${big(b.total)} $TROYA burned so far (${b.pctOfMinted.toFixed(2)}% of the 1B minted), so the supply is now about ${big(b.supply)}. Every burn is listed on the flywheel page.`; }).catch(() => {});
      return [
        P("$TROYA is the Troya Agent token on Robinhood Chain. Everything below can be checked on chain; the links show where."),
        h("div", { class: "dc-ca" }, code(ca, "Contract address")),
        UL([
          [h("b", {}, "Fair launch on Pons: "), "launched 14 Nov 2026 (UTC). All 1,000,000,000 tokens were minted once, straight into the Pons bonding curve. There was no presale and no pre-minted team allocation: every token in a wallet, the team's included, was bought from the curve."],
          [h("b", {}, "No owner: "), "the token contract has no owner."],
          [h("b", {}, "Burns: "), burnLine, " ", A(`${BS}/token/${ca}`, "Live supply on Blockscout"), "."],
          [h("b", {}, "Fees on the curve: "), "each curve trade pays 1% to Pons and a 1.9% creator tax to the ", A(`${BS}/address/0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`, "creator wallet"), ". At 4.2 ETH raised the curve graduates to a Uniswap v4 pool."],
          [h("b", {}, "Uniswap pools: "), "$TROYA graduated from the Pons curve on 16 Nov 2026 into a Uniswap v4 pool with the Pons hook. Its liquidity, position #4302001 (4.2 ETH and 204M $TROYA at graduation), is held by the Pons launch locker, which has no function that moves it or removes liquidity: ", A(`${BS}/tx/0xa77271fef8b0ac94235545a28895bfc0e67e77815dbccadc2246bdca07818dd8`, "graduation transaction"), ". A small separate pool with no hook (1% fee, position #4293939, 0.0012 ETH) was burned by the creator wallet on 15 Nov 2026, so nobody, the team included, can remove it: ", A(`${BS}/tx/0xfe7f12591df9b9f53a0366a31cf36d1cf00b8200b6ae05fb8eeb7989afc24ea0`, "burn transaction"), ". Chart: ", A(`https://dexscreener.com/robinhood/${ca}`, "DexScreener"), "."],
        ]),
        h("h3", {}, "What holding it does"),
        P("Live since 16 Nov 2026, 12:00 UTC: a wallet holding at least 1,000,000 $TROYA (your signed-in wallet plus its Agent Wallet, read from chain) gets:"),
        UL(["200 assistant messages a day instead of 20", "100 active playbooks instead of 25", "Every coin Troya Sentry posts, by private message on Telegram", "No daily limit on launches through Troya", "100% of the creator fee on the coins you launch through Troya", "A small gas claim in ETH on Robinhood Chain once a week (Portfolio → Troya pays your gas)"]),
        P("Check your status with /wallet in a private chat with ", A("https://t.me/TrojanTroya_bot", "@TrojanTroya_bot"), "."),
        h("h3", {}, "The flywheel"),
        P("A flywheel cycle, signed by the creator wallet, claims creator fees from the Pons fee escrow, buys $TROYA back through Troya Gate, burns it with the token's own burn() so the supply goes down, and adds full-range liquidity to the Pons pool as a position minted to the dead address, so nobody can remove it. Phase One ran on 17 Nov 2026. Every cycle, burn and locked position is read back from the chain on ", L("#/flywheel", "the flywheel page"), " (public copy: ", L("/flywheel", "troya.codes/flywheel"), ")."),
        h("h3", {}, "Not announced"),
        P("Further buybacks after Phase One, allocations beyond the above, vesting and exchange listings have not been announced. Anything about $TROYA that is not here, on x.com/Troyaagent or in t.me/troyaagent is not from the team."),
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
        [h("b", {}, "Live: "), "buys and sells from your Agent Wallet, so Troya Gate and your caps run again on each trade. Tested with real money on 15 Nov 2026 (", L("/verify", "proof log"), ")."],
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
      P("Limits live outside any model, in a policy file the server re-reads on every action. The operator sets the ceiling; you can only go stricter, in the Budget on Agent → Scepter."),
      UL(["Per-action and per-day USD caps", "Maximum leverage", "Allowed perp markets (empty means all)", "Pause: stops every Agent Wallet action at once", "Operator kill switch: stops all execution for everyone"]),
      P("Swaps, perps and bridges: Troya adds no fee of its own. Network gas and venue fees (pool fees, token taxes, Hyperliquid fees) still apply and are shown before you sign. Launches: free, and Troya takes 0.1% of a coin's volume from creators without 1,000,000 $TROYA (see Launch a coin)."),
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
        [h("b", {}, "Pons Family: "), "bonding-curve launches; a coin graduates into a Uniswap v4 pool with the Pons hook. 1% fee (70% to the creator) plus an optional creator tax: 0% to 4% on coins launched through Troya."],
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
        ["Is a Gate pass an audit?", "No. The seven Gate checks simulate the trade from a fresh address and read the contract for common owner powers, at one moment. A pass is a snapshot, not an audit, and a coin can change after it."],
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
  // #/docs?s=launch opens at that section (the guide links on Create coin point here); on a first visit it waits for
  // docs.css, which moves the contents list beside the text and so moves every section
  const at = /^[a-z0-9-]{1,40}$/.test(ctx.query?.s || "") ? document.getElementById(`dc-${ctx.query.s}`) : null;
  if (at) {
    const jump = () => requestAnimationFrame(() => at.scrollIntoView({ block: "start" }));
    const css = document.querySelector('link[href^="/agent/css/docs.css"]');
    if (css && !css.sheet) css.addEventListener("load", jump, { once: true }); else jump();
  }

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
