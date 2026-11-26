# @troyaagent/agentkit

[Troya](https://troya.codes) for Coinbase AgentKit: an `ActionProvider` with read-only safety checks on
**Robinhood Chain (chain 4663)**. Works with any wallet provider (the actions never touch it) and with the LangChain,
Vercel AI SDK or MCP framework extensions. Tested on `@coinbase/agentkit` 0.10.4 and `@coinbase/agentkit-langchain` 0.3.0.

```bash
npm i @troyaagent/agentkit @coinbase/agentkit zod@3
```

```js
import { AgentKit } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { troyaActionProvider } from "@troyaagent/agentkit";

const agentKit = await AgentKit.from({
  walletProvider,                                   // your usual wallet provider
  actionProviders: [troyaActionProvider()],         // { apiKey?, baseUrl?, timeoutMs? }
});
const tools = await getLangChainTools(agentKit);    // hand these to your agent
const out = JSON.parse(await tools.find((t) => t.name === "troya_gate_check").invoke({ token: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074" }));
```

Prefer `customActionProvider`? `customActionProvider(troyaActions())` gives the same actions.

## Actions

Every action returns a JSON string: `{ ok: true, summary, result }` or `{ ok: false, summary, error: { code, message } }`.

| Action | Schema (zod) | `result` |
|---|---|---|
| `troya_gate_check` | `token`*, `amountEth?`, `from?`, `signed?` | `verdict` passed / caution / failed / untested, `reason`, `checks[]`, `quote`; with `signed: true` also `attested`, `signature`, `attestor`, The Assay's flags |
| `troya_trident_check` | `to?`, `data?`, `value?`, `from?`, `typedData?` (JSON string) | `verdict` allow / warn / block, `reasons[]`, `coins[]`, `signed` |
| `troya_bridge_safety` | `from?`, `to?`, `amount?`, `token?`, `address?` | `routes[]` (score 0-100, band, red lines, value lost, seconds), `gate`, `storm`, `receipt` |
| `troya_agent_passport` | `address?` or `agentId?` | `standing`, `summary`, `counts`, `stamps[]` with evidence, `warnings`, `signed` |
| `troya_weak_spot` | `address`* | `heel`, `severity`, `confidence`, `facts[]` with evidence links |
| `troya_real_depth` | `token`* | `depth` per venue at $100 / $1k / $10k, `volume` raw vs honest, `family` |

A good pattern: call `troya_gate_check` before any swap action, and `troya_trident_check` on the transaction before
the wallet signs it; stop on `failed` or `block`.

## Honest limits

- **Read only.** These actions do not trade, bridge, sign or send, and ignore the wallet provider on purpose. Your
  other action providers still can, so keep their own limits in place.
- **A verdict is a snapshot, not a safe stamp.** Check again right before acting. A bridge score explains a risk; a
  passport says what a wallet did, never who runs it.
- Robinhood Chain (4663) only, except the other side of a bridge route. `supportsNetwork()` is true for every network
  because Troya is read over HTTP.
- Signed Gate checks without an API key are limited to 3 a day per IP (10 a day per wallet with an API key, 200 for holders of 1,000,000 $TROYA); then they need USDG credit or x402, which you
  pay outside this package (see the [SDK README](https://www.npmjs.com/package/@troyaagent/sdk)).
- `zod` must be v3 (the one AgentKit uses).

MIT · https://troya.codes
