# Troya Agent

An AI trading desk for **Robinhood Chain** (chain 4663) with **Hyperliquid** perps.
Ask in plain words, read what Troya Gate found, then sign. Live at **[troya.codes](https://troya.codes)**.

- App: [troya.codes/agent](https://troya.codes/agent)
- Real transactions made with this code: [troya.codes/verify](https://troya.codes/verify)
- X: [@Troyaagent](https://x.com/Troyaagent) · Telegram: [t.me/troyaagent](https://t.me/troyaagent)

## What it does

| Area | What runs |
|---|---|
| Swap | Any pair on Robinhood Chain: Pons bonding curves, Uniswap v3 (SwapRouter02) and Uniswap v4 (Universal Router + Permit2). Tokenized stocks and ETFs (NVDA, TSLA, SPY…) included. |
| Troya Gate | Pre-trade checks on every swap, see below. |
| Perps | Hyperliquid order book, fills simulated level by level before you place an order. |
| Bridge | ETH between Robinhood Chain and Arbitrum through LI.FI. |
| Launch | Create a coin on Pons from the app. |
| Agent chat | Plain-language requests become a ticket you review and sign. The model never holds a key. |
| Agent Wallet | Optional small hot wallet per owner with caps you set. It can only withdraw to its owner. |
| API and MCP | REST API and an MCP server (`mcp/`) for Claude Desktop, Cursor or Claude Code. Execution is dry-run by default. |

## Troya Gate

Every swap quote goes through `gateCheck` in [`server/robinhood.mjs`](server/robinhood.mjs). The checks run against the live chain:

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Route | a route exists | | no route |
| Price impact | up to 5% | over 5% | over 15% |
| Pool depth (ETH side) | 0.5 ETH or more | under 0.5 ETH | under 0.05 ETH |
| Fees and taxes | up to 5% | over 5% | over 10% |
| Transaction simulation | the exact swap succeeds against the current pool | | it reverts |
| Test sell | selling back what you would receive goes through | | it reverts |
| Transfer tax | 0.5% or less | over 0.5% | over 10% |

After the Gate:

1. When you press Swap, Troya Gate runs again on the pool as it is at that moment, again after any approval, and once more if the review stays open past 45 seconds. If it fails, or cannot be reached, nothing is built and nothing is sent ([`public/agent/js/pages/swap.js`](public/agent/js/pages/swap.js)).
2. The server then re-quotes from scratch. Calldata is never built from a route sent by the browser (`buildSwapTx`).
3. The transaction carries a hard minimum-out from your slippage (1, 3 or 5%, capped at 5%). If the pool moves past it before inclusion, the swap reverts and only gas is spent.
4. Agent Wallet trades re-run the quote, the full Gate and your caps at execution time. Prepared actions expire (120 s over the API, 10 minutes in chat).

## Run it locally

Node 20 or newer.

```bash
npm install
npm run serve          # http://127.0.0.1:9270
```

Markets, quotes and the Gate work with no configuration. Optional settings come from the environment, for example `node --env-file=.env server.mjs` (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Turns on the AI chat. Without it a deterministic parser handles requests. |
| `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK`, `LLM_DAILY_USD` | Chat model, fallback model and daily spend cap (default $5). |
| `TROYA_MASTER_KEY` | Encrypts Agent Wallet keys at rest (AES-256-GCM). Generated in `data/` if unset. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_POLL` | Telegram bot. Set `TELEGRAM_POLL=0` to keep a local copy from polling. |
| `ROBINHOOD_RPC`, `ARBITRUM_RPC`, `HL_INFO_URL` | Override the public RPC and Hyperliquid endpoints. |
| `X_BEARER_TOKEN` | Optional social search tool. |
| `PORT`, `HOST`, `PUBLIC`, `TRUST_PROXY`, `COOKIE_SECURE`, `SITE_URL` | Serving behind a reverse proxy. |
| `TROYA_NO_BROADCAST=1` | Stops right before any transaction is sent (tests, staging). |

## Layout

```
server.mjs          static site + API on one port
server/             API: chain engine and Gate (robinhood.mjs), tools and limits (tools.mjs, policy.mjs),
                    Agent Wallet, assistant, Hyperliquid signing (hl.mjs), journal, Telegram bot
public/             the site (index, capabilities, verify, risk-controls, api-and-mcp…) and the app (public/agent)
mcp/                @troyaagent/mcp, the MCP server; holds no keys, forwards to the REST API
tools/              rh-smoke.mjs (read-only live checks), regate-test.mjs (Swap re-check), crawl.mjs (page and link check)
```

## Tests

```bash
node --test server/hl.test.mjs     # Hyperliquid signing vectors
node tools/rh-smoke.mjs            # live, read-only: quotes, Gate, token health, launch build; sends nothing
node tools/regate-test.mjs [url]   # browser: the Gate runs again on Swap, blocks on a fail, refuses when unreachable
```

## Security notes

- No keys, tokens or user data live in this repository. Secrets come from the environment.
- Wallet signing happens in your own wallet. The server builds transactions; it cannot sign for a connected wallet.
- The Agent Wallet is opt-in, custodial and capped. Its key is encrypted at rest and can be exported with a fresh signature.

Found something? Open an issue, or message [@Troyaagent](https://x.com/Troyaagent) for anything sensitive.

## License

[MIT](LICENSE)
