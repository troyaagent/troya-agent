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

## Rewards: the Troya Index vault bounty

Fixed rewards, paid in ETH, for security bugs in the three Troya Index contracts on Robinhood Chain (chain 4663). Their source is verified on Blockscout:

- TroyaIndex vault (TIDX): `0x6bf23c990602254ba066d3ffa4fa1598425ee279`
- TroyaIndexSwapper: `0x67ccefe92364fdc13f396656918f1c49717fa88c`
- TroyaIndexZap: `0x037c42c9358c6080c7660cd4ae9d2b9de49a92a4`

| Severity | What it means | Reward |
|---|---|---|
| Critical | A way to steal depositors' funds, or to lock them for good (including blocking withdrawals) | 0.1 ETH |
| High | A way to break a vault rule: the total or per-wallet cap, the fees, the 48-hour timelock, the move cap or cooldown, or a rebalance outside its slippage limit | 0.03 ETH |

- Everything paid under this bounty is capped at **0.2 ETH** in total. The first valid report of each issue is the one rewarded.
- Paid in ETH on Robinhood Chain, to an address you choose, once the fix or mitigation is live. The Troya team decides whether a report is valid and how severe it is, and sends each payment by hand; nothing is paid automatically.
- Report privately to **team@troya.codes** as described above. Test only on a fork or a local chain, never against live funds, and keep the details private until we have fixed it.
- Not eligible: Troya team members and anyone who wrote or reviewed these contracts for Troya.
- Not covered: anything that needs the team Safe (2 of 3) or the owner to act maliciously; price moves of the basket's assets (ETH, USDG, SPY, NVDA, $TROYA); bugs in third-party contracts (Uniswap, the Pons hook, the basket's tokens) unless the vault's own use of them is the problem; the keeper's choice of timing within its limits; gas griefing with no effect on funds; the risks already listed on the vault page.

The rest of Troya has no paid bounty. Reports are just as welcome, and credited by name with your consent.

## Status

Troya's contracts are scanned (Slither, Wake) and tested, not formally audited. The scan triage is in `contracts/docs/`.
