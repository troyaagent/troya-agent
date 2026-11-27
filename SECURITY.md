# Security policy

Troya Agent runs live on Robinhood Chain (troya.codes). If you find a security problem, please tell us privately first.

## How to report

- Email **team@troya.codes** with "Security" in the subject.
- Include what you found, where (contract address, page or API path), the steps to reproduce it, and what an attacker could do with it.
- Please do not post the details in public (Telegram, X, GitHub issues) until we have answered and fixed it.
- Troya will never ask you for a seed phrase or private key.

We answer within 72 hours and keep you posted until it is fixed. With your consent, we credit you by name once the fix is live.

## In scope

- The contracts Troya deployed, as listed with their addresses on [troya.codes/proof](https://troya.codes/proof) (TroyaFeeRouter, TroyaStake, TroyaOathVault, the fee splitter and others).
- The API at troya.codes/api and troya.codes/agent/api, the MCP server and the npm packages under @troyaagent.
- Anything that could move or lock someone's funds, sign for them, bypass the Troya Gate or the Agent Wallet caps, or leak keys or personal data.

## Out of scope

- Spelling, layout or wording issues (send them to the Telegram group, they are welcome there).
- Reports from automated scanners with no working impact.
- Denial of service by flooding, social engineering of the team, and third-party services (Pons, Uniswap, Blockscout, Hyperliquid) unless Troya's own use of them is the problem.

## Rewards

There is no paid bug bounty yet. A small, fixed security bounty for the Troya Index vault contracts will be published here before the vault opens to deposits.

## Status

Troya's contracts are scanned (Slither, Wake) and tested, not formally audited. The scan triage is in `contracts/docs/`.
