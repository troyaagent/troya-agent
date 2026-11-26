# @troyaagent/game-plugin

[Troya](https://troya.codes) for Virtuals GAME agents (`@virtuals-protocol/game`, game-node): a worker with read-only
safety functions on **Robinhood Chain (chain 4663)**, in the same shape as the official game-node plugins. Tested on
`@virtuals-protocol/game` 0.1.14.

```bash
npm i @troyaagent/game-plugin @virtuals-protocol/game
```

```js
import { GameAgent } from "@virtuals-protocol/game";
import TroyaPlugin from "@troyaagent/game-plugin";

const troya = new TroyaPlugin();                  // { clientOptions: { apiKey?, baseUrl?, timeoutMs? } }
const agent = new GameAgent(process.env.GAME_API_KEY, {
  name: "Robinhood Scout",
  goal: "Find Robinhood Chain coins worth a look and never act on one that fails Troya Gate.",
  description: "A careful on-chain scout.",
  workers: [troya.getWorker()],                   // or getWorker({ functions: [troya.gateCheckFunction] })
});
await agent.init();
await agent.run(60, { verbose: true });
```

## Functions

GAME passes every argument as a string; numbers and booleans are read back. Each function finishes `done` with a
one-line summary plus `result: {…}` JSON as feedback, or `failed` with the reason (`BAD_INPUT`, `PAYMENT_REQUIRED`,
`RATE_LIMITED`, `TIMEOUT`, …).

| Function | Args | Feedback `result` |
|---|---|---|
| `troya_gate_check` | `token`, `amountEth?`, `from?`, `signed?` | `verdict` passed / caution / failed / untested, `reason`, `checks[]`, `quote`; signed adds the attestor signature and The Assay's flags |
| `troya_trident_check` | `to?`, `data?`, `value?`, `from?`, `typedData?` (JSON) | `verdict` allow / warn / block, `reasons[]`, `coins[]` |
| `troya_bridge_safety` | `from?`, `to?`, `amount?`, `token?`, `address?` | `routes[]` with score 0-100, band, red lines; `gate`; `storm` |
| `troya_agent_passport` | `address?` or `agentId?` | `standing`, `summary`, `stamps[]` with evidence, `warnings` |
| `troya_weak_spot` | `address` | `heel`, `severity`, `confidence`, `facts[]` |
| `troya_real_depth` | `token` | `depth` per venue at $100 / $1k / $10k, `volume` raw vs honest, `family` |

Getters: `gateCheckFunction`, `tridentCheckFunction`, `bridgeSafetyFunction`, `agentPassportFunction`,
`weakSpotFunction`, `realDepthFunction`, `functions` (all six).

## Honest limits

- **Read only.** No function trades, bridges, signs or sends, and none needs a private key. Pair it with your own trading
  worker and let that worker act only after `troya_gate_check` is not `failed`.
- **A verdict is a snapshot, not a safe stamp.** Check again right before acting; a bridge score explains a risk; a
  passport says what a wallet did, never who runs it.
- Robinhood Chain (4663) only, except the other side of a bridge route.
- The GAME planner needs your own GAME API key; Troya needs none. Signed Gate checks without a Troya API key are limited
  to 3 a day per IP (10 a day per wallet with an API key, 200 for holders of 1,000,000 $TROYA); paying for more (USDG credit or x402) happens outside this plugin.
- Feedback is cut at 3,500 characters so the planner stays focused.

MIT · https://troya.codes
