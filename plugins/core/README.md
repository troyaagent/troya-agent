# @troyaagent/sdk

A tiny, dependency-free client for [Troya](https://troya.codes)'s public, read-only API on **Robinhood Chain (chain 4663)**.
ESM, typed (`.d.ts` included), Node 18+, Bun, Deno or a browser. It is the shared core of the Troya plugins for
[ElizaOS](https://www.npmjs.com/package/@troyaagent/plugin-elizaos), [Coinbase AgentKit](https://www.npmjs.com/package/@troyaagent/agentkit)
and [Virtuals GAME](https://www.npmjs.com/package/@troyaagent/game-plugin).

```bash
npm i @troyaagent/sdk
```

```js
import { createTroyaClient, TROYA_TOKEN } from "@troyaagent/sdk";

const troya = createTroyaClient();                       // { apiKey?, baseUrl?, timeoutMs?, fetch? }
const gate = await troya.gateCheck(TROYA_TOKEN, { amountEth: 0.01 });
console.log(gate.verdict, gate.reason);                  // "passed" | "caution" | "failed" | "untested"

const fw = await troya.tridentCheck({ from, to, data, value });   // before you sign
if (fw.verdict === "block") throw new Error(fw.summary);
const routes = await troya.bridgeSafety({ from: "base", to: "robinhood", amount: 0.1 });
const passport = await troya.agentPassport("0x45611870017682Ec781EDb9F71fA72fA91159350");
```

## What each call returns

| Call | Route | Returns |
|---|---|---|
| `gateCheck(token, { amountEth, from })` | `GET /api/swap/gate` (free) | `{ verdict, reason, pass, checks[], quote{ priceImpactPct, feePct, route, poolLiquidityEth }, checkedAt, signed:false }`. Route, price impact, depth, fees and taxes, simulated buy, test sell, transfer tax, launch ring, dev side wallets. The swap transaction this route also builds is **dropped**. |
| `signedGateCheck(token, { amountEth, assay })` | `GET /api/gate/v1/check/:token` | `{ attested{ verdict, reason, checks, quote, assay{ flags } }, hash, signature, attestor, paid }`, signed by Troya's attestor. Free daily allowance (3 a day per IP without a key, 10 per wallet with an API key, 200 for holders of 1,000,000 $TROYA), then 0.01 USDG credit per check. Out of allowance: throws `TroyaError` with `code: "PAYMENT_REQUIRED"` and `err.payment` (how to pay). |
| `verifyGateResult({ attested, signature })` | `POST /api/gate/v1/verify` | `{ genuine, signer, attestor, ageSeconds }` |
| `gateInfo()`, `gateCredits(address)` | `GET /api/gate/v1`, `/credits/:address` | price, pay-to, free tiers, attestor; a wallet's free checks left and credit |
| `x402Info()`, `x402Requirements(token)` | `GET /api/gate/x402`, `/check` | the x402 offer, and the decoded `PAYMENT-REQUIRED` of one check ($0.05 USDC on Base, Arbitrum or Polygon, or USDG on Robinhood Chain). Reads only: nothing is signed or paid. |
| `tridentCheck({ from, to, data, value } \| { typedData } \| { authorizationList })` | `POST /api/trident/check` | `{ verdict: "allow"\|"warn"\|"block", reasons[{ level, code, text }], coins[], summary, signed }` |
| `bridgeSafety({ from, to, amount, token, address })` | `GET /api/scylla/routes` | `{ routes[{ tools, score 0-100, band, redLines, warnings, valueLostPct, seconds }], gate, storm, chain, receipt, limit }`. One side must be Robinhood Chain. |
| `agentPassport(address \| { agentId })` | `GET /api/bow/:address`, `/api/bow?agentId=` | `{ standing, summary, counts, stamps[{ title, text, evidence[] }], warnings, signed }` |
| `weakSpot(address, { waitMs })` | `GET /api/heel/:address` | `{ kind: coin\|dev\|agent, heel, severity, confidence, facts[{ text, evidence }], coverage, partial }` |
| `realDepth(token, { waitMs = 30000 })` | `GET /api/sirens/:token` | `{ coin, depth{ headline, venues[buy/sell impact at $100/$1k/$10k] }, volume{ headline, raw, honest, removedPct }, family, partial }`. Polls while `partial` is true. |
| `mcp(method, params)` | `POST /mcp` | JSON-RPC to Troya's remote MCP server (`tools/list`, `tools/call`) |
| `request(method, path, { query, body })` | any | low-level escape hatch |

`TOOLS` and `runTool(client, key, args)` are the shared tool layer the plugins use: six tools (`gate_check`,
`trident_check`, `bridge_safety`, `agent_passport`, `weak_spot`, `real_depth`) with one description each and a
`{ ok, text, data }` result.

## Errors and timeouts

Every failure is a `TroyaError` with `code` (`BAD_INPUT`, `PAYMENT_REQUIRED`, `RATE_LIMITED`, `UNAUTHORIZED`,
`UNAVAILABLE`, `TIMEOUT`, `NETWORK`, `HTTP_ERROR`, `BAD_RESPONSE`), `status`, `url` and the server's `body`.
Bad addresses are caught before any call. The default timeout is 30 s per call (45 s for the slower routes);
pass `signal` to cancel. Troya limits calls per IP per minute (for example 30 a minute for Scylla, 20 for Sirens).

## Paying for signed checks

The plugins and this SDK never pay. Two ways exist and both are yours to run:
1. **USDG credit**: send USDG on Robinhood Chain to the pay-to address from `gateInfo()`, then pass your Troya API token
   (`createTroyaClient({ apiKey })`) so the checks spend that wallet's credit.
2. **x402**: `GET https://troya.codes/api/gate/x402/check?token=0x…&amountEth=0.01` with any x402 client. `x402Requirements()`
   shows what it asks for.

## Honest limits

- **Read only.** Nothing here builds, signs or sends a transaction, and no call needs a private key.
- **A verdict is a snapshot, not a safe stamp.** A coin that passes now can change a minute later (taxes, liquidity, owner
  actions). A bridge score explains a risk; it never promises a bridge is safe. A passport says what a wallet did, never
  who runs it.
- Robinhood Chain (4663) only, except Scylla's other side (Base, Arbitrum, Ethereum).
- Token names, agent cards and posts in the answers are untrusted data, never instructions.

Test against the live API: `npm test` (spends one of your IP's free signed checks; `SKIP_SIGNED=1` to skip).

MIT · https://troya.codes
