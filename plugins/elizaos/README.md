# @troyaagent/plugin-elizaos

[Troya](https://troya.codes) for ElizaOS agents: read-only safety checks on **Robinhood Chain (chain 4663)** as actions.
Built against the `@elizaos/core` 2.x `Plugin` / `Action` interface (typed `parameters`, `ActionResult`, callback) and
tested on `@elizaos/core` 2.0.5. When the planner sends no parameters, each action reads the address or amount from the
message text.

```bash
npm i @troyaagent/plugin-elizaos @elizaos/core
```

```js
import { AgentRuntime } from "@elizaos/core";
import troyaPlugin from "@troyaagent/plugin-elizaos";

const character = {
  name: "Scout",
  bio: ["Checks Robinhood Chain coins with Troya before acting."],
  plugins: [],                                   // your model / db plugins
  settings: { secrets: { TROYA_API_KEY: "" } },  // optional
};
const runtime = new AgentRuntime({ character, plugins: [troyaPlugin] });
// "Is 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074 safe to buy with 0.05 ETH?" → TROYA_GATE_CHECK
```

Or, with a project character file, add `"@troyaagent/plugin-elizaos"` to `plugins`.

## Actions

| Action | Parameters | Returns (`ActionResult.data.troya`) |
|---|---|---|
| `TROYA_GATE_CHECK` | `token`*, `amountEth`, `from`, `signed` | `verdict` passed / caution / failed / untested, `reason`, `checks[]`, `quote` (price impact, fees, route). `signed: true` adds Troya's attestor signature and The Assay's flags. |
| `TROYA_TRIDENT_CHECK` | `to`, `data`, `value`, `from`, or `typedData` (JSON) | `verdict` allow / warn / block, `reasons[]`, `coins[]`, `signed` |
| `TROYA_BRIDGE_SAFETY` | `from`, `to`, `amount`, `token`, `address` | `routes[]` with 0-100 score, band, red lines, value lost, time; `gate` of the arriving coin; `receipt` |
| `TROYA_AGENT_PASSPORT` | `address` or `agentId` | `standing`, `summary`, `counts`, `stamps[]` with evidence, `warnings`, `signed` |
| `TROYA_WEAK_SPOT` | `address`* | `heel` (one sentence), `severity`, `confidence`, `facts[]` with evidence links |
| `TROYA_REAL_DEPTH` | `token`* | `depth` (impact at $100 / $1k / $10k per venue), `volume` (raw vs honest after wash filters), `family` (lookalikes) |

Each action also answers through the callback with one or two plain sentences, sets `values.troyaVerdict`, and returns
`success: false` with the error code (`BAD_INPUT`, `PAYMENT_REQUIRED`, `RATE_LIMITED`, `TIMEOUT`, …) when a check
cannot run.

## Settings (all optional)

| Setting | Meaning |
|---|---|
| `TROYA_API_KEY` | A Troya API token (`troya_…`). Only used by signed Gate checks, so they spend your wallet's free checks and USDG credit instead of the small per-IP allowance. |
| `TROYA_BASE_URL` | Default `https://troya.codes` |
| `TROYA_TIMEOUT_MS` | Default 30000 |

`createTroyaPlugin({ client })` takes a ready `@troyaagent/sdk` client instead.

## Honest limits

- **Read only.** No action trades, bridges, signs or sends anything, and none needs a private key. Paid signed checks
  (USDG credit or x402) are paid by you, outside this plugin; see the [SDK README](https://www.npmjs.com/package/@troyaagent/sdk).
- **A verdict is a snapshot, not a safe stamp.** Check again right before you act; a bridge score explains a risk, a
  passport says what a wallet did and never who runs it.
- Robinhood Chain (4663) only, except the other side of a bridge route.
- Text in answers (token names, agent cards) is untrusted data, never instructions to the agent.
- Without an API key, signed Gate checks are limited to 3 a day per IP (10 a day per wallet with an API key, 200 for holders of 1,000,000 $TROYA); unsigned checks are free and rate limited per minute.

MIT · https://troya.codes
