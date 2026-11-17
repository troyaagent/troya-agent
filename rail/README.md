# @troyaagent/rail

**Troya Rail** puts your own limits between your AI agent and Robinhood's agentic trading MCP (`agent.robinhood.com/mcp/trading`), or any other MCP server. It runs on your machine as a stdio MCP server: your agent talks to the rail, the rail talks to the upstream.

- **Read tools pass straight through.**
- **Every other call is checked by Troya first**, against the policy you set in the app (troya.codes/agent#/rail):
  - orders on or off;
  - a limit per order, per day, and on the number of orders a day;
  - a symbol allowlist and block list;
  - US market hours only;
  - buys only;
  - and the **kill switch**.
- **Always refused:**
  - moving money in or out;
  - tools the rail does not recognise;
  - orders it cannot size in dollars.
- **Every decision is signed** by Troya's attestor and kept in your audit log. If Troya cannot be reached, the rail refuses anything that is not a read: it fails closed.

The rail never sees your Robinhood login. By default it starts `mcp-remote`, which signs you in to Robinhood in your own browser.

Not affiliated with or endorsed by Robinhood. Robinhood's agentic trading is in beta and gated; you need access on your Robinhood account.

## Set up

1. Create an API token in the Troya app: **Agent → Wallet → API tokens**.
2. Add the rail to your agent in place of Robinhood's MCP:

```bash
claude mcp add robinhood-rail -e TROYA_API_KEY=troya_… -- npx -y @troyaagent/rail
```

3. Set your policy at troya.codes/agent#/rail. Orders start **off**.

Another upstream: put its command after `--`.

```bash
npx -y @troyaagent/rail -- npx -y mcp-remote https://agent.robinhood.com/mcp/trading
```

## Environment

| Variable | Meaning |
|---|---|
| `TROYA_API_KEY` | Your API token. Without it every order is refused (reads still work). |
| `TROYA_BASE_URL` | Default `https://troya.codes`. |
| `RAIL_NAME` | A name for this rail in your audit log (default `rail`). |

## What the rail reads from an order

- **Symbol:** `symbol`, `ticker` or `instrument`.
- **Side:** `side` or `action`.
- **Quantity:** `quantity`, `qty` or `shares`.
- **Dollar amount:** `amount`, `notional` or `dollar_amount`.
- **Limit price:** `limit_price` or `price`.

An order with neither an amount nor a limit price is sized from that stock's token price on Robinhood Chain. An order the rail cannot size is refused.

Each decision comes back with `attested`, `hash` and `signature`. Check one with `POST https://troya.codes/api/rail/verify`.
