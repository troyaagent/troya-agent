# @troyaagent/cli

**Troya Agent from the terminal.** Run the Troya Gate on a coin, read Troya picks and the chart oracle, quote swaps on Robinhood Chain (chain 4663) and check Hyperliquid perps. It is one file with no dependencies (Node 18+) and holds no keys. Every call goes to the Troya API, where the same limits, Gate checks and journal as the app apply.

```bash
npx @troyaagent/cli gate TROYA
```

Or install it once:

```bash
npm i -g @troyaagent/cli
troya help
```

## Commands

A coin can be a `0x…` address or a ticker such as `TROYA`. Add `--json` to any command for raw JSON.

| Command | What it does |
|---|---|
| `troya gate <coin>` | Troya Gate: route, price impact, pool depth, fees, a simulated buy and a test sell from a fresh address |
| `troya token <coin>` | Price, market cap, liquidity, volume, trades, holders, socials and links |
| `troya search <query>` | Find coins by name, ticker or address |
| `troya market [picks\|trending\|new\|bonding\|all]` | The Robinhood Chain board. Troya picks by default, each one with why |
| `troya holders <coin>` | Top holders, with known contracts labelled |
| `troya health <coin>` | Bytecode check: owner, mint, pause, blacklist, fee setters, proxy |
| `troya quote <amount> <from> <to>` | Best route across Pons, Uniswap and KyberSwap, price impact, fees, minimum out |
| `troya stocks [filter]` | Tokenized stocks and ETFs on Robinhood Chain |
| `troya oracle [coin]` | The chart oracle: a note per coin every 6 hours, graded in public 24 hours later |
| `troya record` | The Oracle's ledger: every Troya Sentry call, graded 24 hours later |
| `troya flywheel` | $TROYA creator fees, buybacks, burns and supply, read from the chain |
| `troya perp <COIN>` | A Hyperliquid perp: price, funding, open interest, spread |
| `troya movers` / `troya funding` | Hyperliquid movers and funding extremes |
| `troya tools` / `troya call <tool> [json \| key=value …]` | Every REST tool, and a direct call to any of them |

## Trading from the terminal

`swap`, `execute`, `balances` and `policy` need an API token. Create one in the app: **Agent → Wallet → API tokens**.

```bash
export TROYA_API_KEY=troya_…
troya swap 0.01 ETH TROYA          # quote + Troya Gate + your limits → a confirmation id (valid 120 s)
troya execute <confirmationId>     # a dry run: shows what would be sent
troya execute <confirmationId> --live
```

A swap runs live only when all three hold: you pass `--live`, the token has the execute scope, and you switched dry-run off for that token in the app. A coin that fails the Gate is never prepared.

## Environment

| Variable | Meaning |
|---|---|
| `TROYA_API_KEY` | API token for your own account. Read commands work without it. |
| `TROYA_BASE_URL` | Troya server. Default `https://troya.codes`. |
| `NO_COLOR` | Plain output without colour. |

Nothing here is advice. Run the Gate before you buy.

Also from Troya: [`@troyaagent/mcp`](https://www.npmjs.com/package/@troyaagent/mcp), the same tools for Claude, Cursor and other MCP clients.
