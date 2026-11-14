# @troyaagent/mcp

MCP server for **Troya Agent**: market tools for Robinhood Chain (chain 4663) and Hyperliquid, with the same limits, Troya Gate checks and journal as the web app. The server holds no keys. It forwards every call to the Troya REST API.

## Install

```bash
npx -y @troyaagent/mcp
```

### Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "troya": {
      "command": "npx",
      "args": ["-y", "@troyaagent/mcp"],
      "env": { "TROYA_BASE_URL": "https://your-troya-host", "TROYA_API_KEY": "troya_…" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add troya --env TROYA_BASE_URL=https://your-troya-host --env TROYA_API_KEY=troya_… -- npx -y @troyaagent/mcp
```

## Environment

| Variable | Meaning |
|---|---|
| `TROYA_BASE_URL` | Troya server URL. `TROYA_URL` is accepted as a fallback. Default `http://127.0.0.1:9270`. |
| `TROYA_API_KEY` | API token from the app: **Agent → Wallet → API tokens**. Read tools work without it. |
| `TROYA_LIVE` | Set to `1` to let `execute_intent` run live. Without it, every execution from this MCP is a dry run. |

## Tools and tiers

- **read** (cannot move funds): `analyze_ticker`, `get_movers`, `get_funding_extremes`, `get_robinhood_tokens` (alias `robinhood_tokens`), `robinhood_token`, `get_new_pairs`, `analyze_token_health`, `quote_swap`, `get_balances`, `get_policy`, `simulate_trade`, `get_social_info` (only when the server has `X_BEARER_TOKEN`; posts are wrapped as untrusted text).
- **prepare** (needs a token): `prepare_order` `{kind: "perp" | "swap", …}`, `prepare_perp_order`, `prepare_swap`. These run Troya Gate and your limits, then return a one-time `confirmationId` that lasts 120 seconds and is bound to a hash of the parameters.
- **execute** (needs a token with the execute scope): `execute_intent {confirmationId}`. It re-checks your limits and runs through your Agent Wallet. It stays a dry run unless **both** of these are true: you switched dry-run off for that token in the app, and `TROYA_LIVE=1` is set here.

## REST (same tools)

```
GET  /api/tools                       list with tier + JSON schema (public)
GET  /api/tools/:name?arg=value       read tools, public
POST /api/tools/:name   {args}        read: public · prepare: x-api-key · execute: x-api-key + Idempotency-Key
GET  /agent/api/market/robinhood        Robinhood Chain token list
GET  /agent/api/market/robinhood/token?address=0x…
GET  /agent/api/market/hl             Hyperliquid perps
```

`/agent/api/*` mirrors `/api/*`. API tokens are stored hashed on the server and can be revoked at any time. Troya charges no fee during the beta.
