![Troya Agent](.github/banner.jpg)

# Troya Agent

An AI trading desk for **Robinhood Chain** (chain 4663), with swaps on **Base**, **Arbitrum** and **Solana** and **Hyperliquid** perps and spot.
Ask in plain words, read what Troya Gate found, then sign. Live at **[troya.codes](https://troya.codes)**.

**$TROYA CA (Robinhood Chain):** `0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074`
The same address is shown on [troya.codes](https://troya.codes). Trade it on [Pons](https://ponsfamily.com/launchpad/0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074) or through Troya Gate in the [app](https://troya.codes/agent#/swap?in=eth&out=0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074).

- App: [troya.codes/agent](https://troya.codes/agent)
- Real transactions made with this code: [troya.codes/verify](https://troya.codes/verify) · every claim with its evidence: [troya.codes/proof](https://troya.codes/proof) ([JSON](https://troya.codes/proof.json))
- X: [@Troyaagent](https://x.com/Troyaagent) · Telegram: [t.me/troyaagent](https://t.me/troyaagent)

## Proof

Every claim Troya makes can be checked without a wallet:

- **[troya.codes/proof](https://troya.codes/proof)**: the $TROYA burn read from the chain, Troya Gate run live on any coin with each check explained, every real trade by Troya's agents with its transaction, the contracts read on chain, and what is live versus planned. The numbers are written into the HTML by the server, so they read without JavaScript.
- **[troya.codes/proof.json](https://troya.codes/proof.json)**: the same claims, machine-readable, each with status `live` or `planned` and its evidence (transaction hashes, contract addresses, API URLs, `eth_call` bodies).
- **[troya.codes/verify](https://troya.codes/verify)**: the real-money test behind each shipped feature, with signers.

**Check the burn yourself.** $TROYA was minted once (1,000,000,000) and every burn uses the token's own `burn()`, which lowers the total supply instead of parking coins at a dead address. So: burned = 1,000,000,000 − `totalSupply()`.

```bash
curl -s https://rpc.mainnet.chain.robinhood.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074","data":"0x18160ddd"},"latest"]}'
# result = totalSupply in wei (18 decimals); 1,000,000,000 minus it is what has been burned
```

Or open the token on [Blockscout](https://robinhoodchain.blockscout.com/token/0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074) and read its total supply. Every burn transaction and the wallet that signed it: [/api/proof/burn](https://troya.codes/api/proof/burn).

**Contracts on Robinhood Chain (4663)**

| Contract | Address | Source |
|---|---|---|
| $TROYA (Pons token, no `owner()`) | [`0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074`](https://robinhoodchain.blockscout.com/token/0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074) | Pons Family template |
| TroyaStake (no owner, admin, pause or upgrade; 3-day unstake wait) | [`0x1C867c13BD950a90aB75158C1C45061837aa02d2`](https://robinhoodchain.blockscout.com/address/0x1C867c13BD950a90aB75158C1C45061837aa02d2) | [`contracts/src/TroyaStake.sol`](contracts/src/TroyaStake.sol) |
| Troya Holder Pass (soulbound) | [`0x439EBc38c756f4F729c1474ED8DE337cFe3Aa77E`](https://robinhoodchain.blockscout.com/address/0x439EBc38c756f4F729c1474ED8DE337cFe3Aa77E) | [`contracts/src/TroyaPass.sol`](contracts/src/TroyaPass.sol) |
| TroyaFeeSplitter factory (owner: the team wallet, which can only change where Troya's share goes) | [`0x266323d6ce63E4dfE62cC87bD14cA6C97BB2F525`](https://robinhoodchain.blockscout.com/address/0x266323d6ce63E4dfE62cC87bD14cA6C97BB2F525) | [`contracts/src/TroyaFeeSplitter.sol`](contracts/src/TroyaFeeSplitter.sol) |
| TroyaOathVault (verified on [Sourcify](https://sourcify.dev/server/v2/contract/4663/0x6Bb959367a71d07F5bBCb91eb41b62949440a4e8)) | [`0x6Bb959367a71d07F5bBCb91eb41b62949440a4e8`](https://robinhoodchain.blockscout.com/address/0x6Bb959367a71d07F5bBCb91eb41b62949440a4e8) | [`contracts/src/TroyaOathVault.sol`](contracts/src/TroyaOathVault.sol) |
| Uniswap v4 LP position #4293939, owned by `0x…dEaD` | [PositionManager `0x58daec31…04fA7`](https://robinhoodchain.blockscout.com/token/0x58daec3116aae6D93017bAAea7749052E8a04fA7/instance/4293939) | Uniswap v4 |

Wallets the site names: creator wallet [`0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`](https://robinhoodchain.blockscout.com/address/0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4) (launched $TROYA, signs the flywheel and the burns), team wallet [`0x45611870017682Ec781EDb9F71fA72fA91159350`](https://robinhoodchain.blockscout.com/address/0x45611870017682Ec781EDb9F71fA72fA91159350), test wallet [`0x12a05719851c8375342DE65c9105329c81f57054`](https://robinhoodchain.blockscout.com/address/0x12a05719851c8375342DE65c9105329c81f57054), Arena Agent Wallet [`0xba9e826D5eb02061c3323E7F163F0645073E377d`](https://robinhoodchain.blockscout.com/address/0xba9e826D5eb02061c3323E7F163F0645073E377d), Gate attestor [`0xbEa3056612704eEE964B892862d969D2d4bB5fDE`](https://robinhoodchain.blockscout.com/address/0xbEa3056612704eEE964B892862d969D2d4bB5fDE) (signs results, holds no funds). There is no third-party audit; the Agent Wallet is custodial by design.

## What it does

| Area | What runs |
|---|---|
| Swap | Any pair on Robinhood Chain: Pons bonding curves, Uniswap v3 (SwapRouter02) and Uniswap v4 (Universal Router + Permit2), and coins from the other Robinhood Chain launchpads through KyberSwap. Tokenized stocks and ETFs (NVDA, TSLA, SPY…) included. |
| More chains | The same Swap page on Base and Arbitrum (KyberSwap routes) and Solana (Jupiter routes, any Wallet Standard wallet), each with its own Gate run on that chain. |
| Troya Gate | Pre-trade checks on every swap, see below. |
| Perps | Hyperliquid order book, fills simulated level by level before you place an order. |
| Spot | Hyperliquid spot coins (HYPE, UBTC, UETH…) from your own Hyperliquid account; a Spot Gate reads the live book and orders are capped 1% from the price. |
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
cli/                @troyaagent/cli, Troya CLI (`troya gate TROYA`, `troya oracle`); one file, no dependencies
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
