# Troya Gate on Virtuals ACP

Other agents can hire **Troya Gate** on the [Agent Commerce Protocol](https://app.virtuals.io/acp). They send a token
address, pay the job price in USDC into ACP's escrow on Base, and get back a fresh Troya Gate check signed by
Troya's attestor. This folder is the seller program. It runs on the Troya server and asks the Troya server for each check.

## The offering (as registered on app.virtuals.io)

- **Name:** Troya Gate check
- **Price:** 0.01 USDC per job
- **SLA:** 5 minutes
- **Description:** A fresh pre-trade safety check for any token on Robinhood Chain (chain 4663), run at your trade
  size. It tests whether the token can be bought and sold, shows the real taxes and price impact, and runs honeypot and
  liquidity tests, plus dev and holder flags from The Assay. The result is signed by Troya's attestor, so any agent can
  verify it.
- **Requirement schema:**

```json
{
  "type": "object",
  "properties": {
    "token": { "type": "string", "description": "Token contract address on Robinhood Chain (0x + 40 hex)" },
    "amountEth": { "type": "number", "description": "Trade size in ETH to test at, 0.0001 to 5. Default 0.01" }
  },
  "required": ["token"]
}
```

## How a job runs

1. The buyer opens a job with `{ "token": "0x…", "amountEth": 0.01 }`.
2. The seller proposes the price (`setBudget`). If there is no token address, it explains what it needs and proposes nothing, so nothing is paid.
3. The buyer funds the job. The seller runs the check and submits it as JSON: a plain summary, the verdict, the
   attested result, its hash, the signature and the attestor address.
4. If the check cannot run after three tries, the submission says so and asks the buyer to reject the job. A rejected job returns the escrow to the buyer.

## Run it

```bash
cd acp && npm install --omit=dev
set -a; . ../acp.env; set +a; node seller.mjs
```

`acp.env` (never committed):

```
ACP_WALLET_ADDRESS=0x…        # the agent wallet on its app.virtuals.io page
ACP_WALLET_ID=…               # Signers tab
ACP_SIGNER_KEY=…              # Signers tab → Add Signer → Copy Key
ACP_BUILDER_CODE=bc-…         # optional, Settings tab
ACP_PRICE_USDC=0.01
GATE_INTERNAL_KEY=…           # the same value as in the server's .env
```

The same check is also sold without any account over x402 (USDC on Base, see `server/x402.mjs`) and in USDG on
Robinhood Chain (`GET /api/gate/v1`).
