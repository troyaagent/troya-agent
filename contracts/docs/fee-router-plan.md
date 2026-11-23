# TroyaFeeRouter: migration plan

Status: built and tested locally only (`src/TroyaFeeRouter.sol`). Nothing deployed, no transaction sent, the Pons fee
recipient is unchanged (still the creator wallet `0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`). Deploying it and moving
the fee recipient are two separate owner decisions.

## 1. How $TROYA creator fees reach the recipient today (read from the verified sources and the chain, 23 Nov 2026)

- $TROYA graduated (Pons phase 2). Pool: Uniswap v4 PoolManager `0x8366…0951`, key
  `(currency0 ETH 0x0, currency1 TROYA, fee 0, tickSpacing 200, hooks 0xE5e7…e044 PonsV2MemeHook)`,
  pool id `0x050f1f047e1753d3058519c50e522b1f80c9e1eb208eb1f10867adab67bb38c1`.
- `hook.launches(poolId)`: creatorTaxBps 190, hookFeeBps 100, protocolFeeShareBps 3000, buybackEnabled false,
  creator = buybackCreatorRecipient = `0x57b0…D09E4`. So the creator side is 70 + 190 = 260 bps of volume. These are
  snapshotted per pool at graduation, which is why `creatorBps` is an immutable 260 in the router.
- Each swap: `afterSwap` takes 2.9% of the swap's unspecified side into `pendingFees` / `pendingCreatorTax`
  (often in $TROYA). The Pons sweep operator (`0xa101…cA83`) runs `sweepPoolFees` several times a day: it converts
  the $TROYA part to ETH inside the pool and calls `PonsV2FeeEscrow.credit{value}(creator)`. Example:
  tx `0x9c6b…d2cf` (block 121,420,012) credited 0.004228 ETH to the creator wallet and 0.000488 ETH to the protocol.
- So the recipient is paid **native ETH, by pull**: the escrow (`0xd3af…ac9e`) only books a balance; the recipient
  must call `escrow.claim()`, which pushes ETH with a plain `call` (all gas forwarded). The recipient therefore needs a
  `receive()`. No WETH. No $TROYA is ever credited, except through the hook owner's emergency `rescuePoolFees`, which
  sends pending tokens straight to the recipient: the router's `rescueToken` forwards any such token to the team.
- Factory `0x7eD5…EC7e`: the current recipient can move it instantly with `transferCreatorFeeRecipient(token, new)`
  (no Pons timelock for the creator). The Pons owner (`0x263e…19Dd`) has a standing override
  `setCreatorFeeRecipient` with `CREATOR_FEE_RECIPIENT_TIMELOCK` 3 days and a 3-day execution window
  (`pendingCreatorFeeRecipient(TROYA)` is empty today). A move also re-points the buyback vest beneficiary
  (irrelevant here: buyback is off for $TROYA).
- TroyaStake `0x1C86…02d2` (verified source byte-identical to `src/TroyaStake.sol`): `notifyReward()` reverts with
  `NoStakers` when `totalStaked == 0` and `ZeroAmount` on 0. The router never calls it in either case (the share goes to
  the team instead). Today: totalStaked 73,276,465 TROYA of 962,406,382 supply (7.6%, above the 5% target), totalRewarded 0.
- Volume reality check: server ledger shows 0.0604 ETH of creator credits from 21 Nov 16:55 UTC to 23 Nov (~0.02 ETH/day).
  The pool-price market cap is ~4.9 to 5.0 ETH (~$8.5k), so today the lowest tier applies.

## 2. What the contract does (short)

- `distribute()` (anyone, once per `minInterval` window aligned to it; default 86400 = once per UTC day): records this
  hour's price, claims the escrow, splits `balance - burnReserve - totalOwed`:
  stakers `amount * stakerBps[tier] / 260`, scaled by `staked / (5% of totalSupply)` below the target, sent with
  `TroyaStake.notifyReward{value}()` in the same transaction (if that call fails, the whole call fails: the stakers'
  share cannot be skipped, also not by gas griefing); gas wallet `amount * 10 / 260`; burn `amount * burnBps[tier] / 260`
  into `burnReserve`; team the rest (rounding dust included). Staker or gas shares under `minSendWei` go to the team.
  A payee that refuses ETH is not skipped: its amount is kept for it (`owed`, `withdrawOwed`).
- Tier: market cap = median of the last 24 hourly pool-price reads (`poke()`, permissionless; distribute and
  buyAndBurn also read) x (totalSupply - balance of 0x…dEaD), compared with `midMcWei` / `highMcWei`. Fewer than 12
  reads in the last 24 h: lowest tier. Reads are refused while the PoolManager is unlocked (so a read can never be taken
  in the middle of someone's swap batch).
- Burn: right after the split, if `burnReserve >= minBurnWei`, the router unlocks the PoolManager and swaps exact ETH
  for $TROYA in the Pons pool with a price limit of `(1 - maxBurnSlippageBps)` below the higher of the 24-h median and
  the current price, takes the $TROYA and `burn()`s all of it in the same transaction. Unspent ETH (limit reached,
  price pumped, swap reverted) stays in `burnReserve` for the next `distribute()` or anyone's `buyAndBurn()`; the burn
  failing never blocks the stakers' payment (it runs in a try/catch, after the payouts).
- Timelock: `proposeConfig` / `executeConfig` (anyone, 7 to 14 days after proposing) / `cancelConfig`, and the same for
  `proposeRecipientMove` (the only Pons call: `transferCreatorFeeRecipient(TROYA, to)`). Events for all of them;
  `config()` and `pendingConfig()` are readable. Hard limits no proposal can cross: stakers >= 0.1% of volume in every
  tier and never lower in a higher tier, gas <= 0.5%, target <= 10% of supply, minimums <= 0.001 / 0.01 ETH,
  slippage 0.1% to 20%, period 1 h to 7 days.
- Owner: Ownable2Step; `renounceOwnership` disabled (thresholds are in ETH and must follow ETH/USD; the way back needs
  an owner). No pause, no upgrade, no arbitrary call, no ETH rescue.

### Why the hourly median (and what is left)

No Chainlink on Robinhood Chain for Troya and no server in the loop, so the only trustless source is the pool itself.
A spot read is trivially pumped for one block; a v4 pool has no built-in TWAP; a TWAP hook is not available on the
Pons pool. The median of 24 hourly reads mirrors today's published "hourly median" rule and needs a manipulator to
control at least 13 different hours (13 separate pump-and-dump round trips, each paying the 2.9% hook cut twice on the
size needed to move the price). At today's depth (~2.5 ETH of ETH-side liquidity) doubling the price for one read costs
roughly 1 ETH of round trip, i.e. about 0.06 ETH in fees per manipulated hour, ~0.8 ETH per day of manipulation,
against at most ~0.01 ETH/day of tier difference at today's volume. Residual risks: (a) a sustained real move of the
price is not manipulation, it is the market cap (the tier follows it within ~12 h, as intended); (b) if volume grows
100x while liquidity stays thin, the economics of manipulating the median get closer; the team can raise
`MIN_OBSERVATIONS` only by a new contract; (c) the first read of each hour is the one that counts, so a manipulator
only needs to be first in that hour (still 13 hours); (d) thresholds are in ETH: when ETH/USD moves, the dollar tiers
drift until the owner re-proposes them (7 days).

### Why the burn is in-contract

The buy is a single exact-input swap against the same pool, bounded by a price limit, so its worst case is known in
advance: it never pays more than `maxBurnSlippageBps` above both the 24-h median and the current price, and a
sandwich can at most push it to that bound. The amounts are small (0.1% of volume, ~0.0008 ETH/day at the top tier
today). Doing it atomically means no $TROYA ever sits in the router, and holding the burn share instead of handing it to
the team when the price is outside the band removes any incentive for anyone to keep the price out of the band.
This is the one deliberate difference from the published rule ("what cannot be bought back stays with the owner"):
in router mode it waits and is bought back later. Residual risk: the buy pays the pool's own 2.9% hook cut (2.6% of
it comes back to the router as creator fees later).

## 3. Exact deploy parameters

`new TroyaFeeRouter(owner_, troya_, stake_, escrow_, poolManager_, ponsFactory_, hook_, poolFee_, tickSpacing_, creatorBps_, initial)`

| param | value |
|---|---|
| owner_ | the team wallet. Today that is `0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`; **recommended: a hardware wallet or Safe that the server cannot sign for** (the creator key is stored on the server; whoever holds the owner key can propose a hostile rule, and although it waits 7 days, a stolen key can also transfer ownership and out-propose a cancel) |
| troya_ | `0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074` |
| stake_ | `0x1C867c13BD950a90aB75158C1C45061837aa02d2` |
| escrow_ | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| poolManager_ | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| ponsFactory_ | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| hook_ | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| poolFee_ / tickSpacing_ | `0` / `200` (constructor derives pool id `0x050f1f04…38c1` and checks the pool is initialized and that TroyaStake stakes $TROYA) |
| creatorBps_ | `260` |
| initial.team | `0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4` |
| initial.gasWallet | `0x937533f8Eb47A10B529A42a7154B73CECa33390B` (server `data/gas-sponsor.json` address) |
| initial.stakerBps | `[10, 50, 100]` |
| initial.burnBps | `[0, 0, 10]` |
| initial.gasBps | `10` |
| initial.stakeTargetBps | `500` |
| initial.maxBurnSlippageBps | `500` |
| initial.minInterval | `86400` |
| initial.midMcWei | `35000 / ETHUSD` ETH at deploy time (at the ~$1,730 implied by the server's own reads on 23 Nov: `20231213872832369942`, 20.23 ETH) |
| initial.highMcWei | `100000 / ETHUSD` ETH (at ~$1,730: `57803468208092485549`, 57.80 ETH) |
| initial.minSendWei | `20000000000000` (0.00002 ETH, as the server) |
| initial.minBurnWei | `500000000000000` (0.0005 ETH, as the flywheel) |

Compiler: solc 0.8.24, optimizer 500 runs, evm shanghai (foundry.toml). Runtime 19,960 B. Deploy ~4.28M gas
(execution, fork-measured); one `distribute()` with a stake payment ~250k gas.
Verify on Sourcify and Blockscout right after deploy, publish the source commit, run the Slither/Wake scans again on
the exact deployed source (as for TroyaStake in `public/security/`). An independent review before moving real fees is
recommended.

## 4. Switching the server to router mode (`server/feesplit.mjs`)

Nothing below is implemented yet.

1. New env `FEE_ROUTER=<address>` and `STAKE_REWARDS=router` (a fourth mode next to live/dry/off).
2. In router mode `dailyRun()` no longer sends anything from the creator wallet: no `notifyReward`, no gas top-up
   (`GAS_TOPUP` ignored), no `buybackAndBurn` for the burn share. It only:
   - calls `router.poke()` once an hour (from the gas sponsor via `gas.sponsorTx`, value 0; anyone else may too);
   - at 01:00 UTC, if `router.nextDistributionAt() <= now` and `router.preview().amount > 0`, calls
     `router.distribute()` (same wallet). If the server is down, anybody can call it; nothing is lost by a late call;
   - if `burnReserve() >= minBurnWei` after a run, calls `buyAndBurn()` once an hour until it is spent.
3. Credits: `scanCredits()` scans `Credited(recipient = FEE_ROUTER)` from the switch block (instead of the creator
   wallet) for the per-hour history shown on /stake; the ledger before the switch block stays as it is.
4. /stake and /proof read the router directly: `config()`, `pendingConfig()` (show any pending proposal with its
   countdown at the top), `marketCap()` (tier, reads), `preview()`, the lifetime totals (`totalToStakers`, `totalToGas`,
   `totalToTeam`, `totalBurnEthSpent`, `totalTroyaBurned`, `distributions`) and the `Distributed` /
   `BoughtAndBurned` / `ConfigProposed` / `RecipientMoveProposed` events, with links to the transactions.
5. `RULE` text: same economics; replace "Each fee is split by the market cap in the hour it came in" with "Each day's
   fees are split by the median market cap of the last 24 hours, by the TroyaFeeRouter contract"; replace "what cannot be
   bought back stays with the team" with "the burn share waits in the contract until it can be bought back within 5% of
   the median price"; add "any rule change is announced on chain 7 days ahead".
6. The 2x bonus for stakers who trade through Troya (`stakebonus.mjs`) cannot be done by the router (it needs Troya's
   off-chain trade records). Options: keep it, paid from the team's share by the server (as an extra on top of the
   router's pro-rata payment), or retire it. Owner decision; the plan assumes "keep, paid from the team share".

## 5. Switch-over steps

1. Owner decides the owner key (section 3) and approves deploying.
2. Deploy with the parameters above; verify the source; check `config()`, `poolId()`, `spotSqrtPrice()`, `marketCap()`.
3. Start the hourly `poke()` and let at least 24 reads accumulate (the tier needs 12; 24 makes the first day's tier the
   real median).
4. Let the server settle everything before the switch: the first stakers' pot is paid by the server's run on
   **29 Nov 2026 01:00 UTC** (7 days after TroyaStake went live on 21 Nov 16:55 UTC). Switch after that run, at a UTC
   day boundary, so the server owns every credit before the switch block and the router every credit after it.
   Claim the creator wallet's own escrow balance first (`escrow.claim()` from the creator wallet), so the router never
   receives a pre-switch balance.
5. Check `factory.pendingCreatorFeeRecipient(TROYA)` is empty (no Pons override pending).
6. Owner approves and the creator wallet sends `factory.transferCreatorFeeRecipient(0x1FA8…a074, <router>)`. Pons
   applies it at once (no Pons timelock on the creator's own transfer).
7. Verify: `factory.getLaunchedToken(TROYA).creatorFeeRecipient == router`; `hook.launches(poolId)` creator field ==
   router; the next operator sweep emits `Credited(router, hook, …)`. Record the switch block in
   `data/fee-split-start.json` (router mode).
8. Flip the server to `STAKE_REWARDS=router`. Announce (X and TG, with the router address, the rule, and the 7-day
   timelock) only after the owner types the go-ahead in chat.
9. The first `distribute()` after the switch is done in the open and its transaction linked on /proof.

## 6. Rollback

- Change of rule (thresholds after an ETH move, gas wallet rotation, minimums): `proposeConfig(next)`, visible on
  chain and on /stake for 7 days, then anyone `executeConfig()` (within the following 7 days, or it lapses);
  `cancelConfig()` any time before.
- Back to the server (or to a successor contract): `proposeRecipientMove(<creator wallet or successor>)`, wait 7 days,
  anyone `executeRecipientMove()`. Pons credits from then on go to the new recipient. ETH already in the router, and
  anything already credited to it in the escrow, keeps being split by the router's `distribute()`; the server switches
  back to `STAKE_REWARDS=live` with a new `startBlock` at the move.
- There is deliberately no instant stop. If the router were broken in a way that blocks `distribute()` (for example
  TroyaStake reverting), the ETH stays in the router until it works again (there is no ETH rescue, by design), and the
  only ways to redirect new fees are the router's 7-day move or the Pons owner's own 3-day override (not ours).
  The router never touches staked $TROYA: stakers can always unstake and withdraw in TroyaStake.

## 7. Tests and scans (local)

- `forge test`: `test/TroyaFeeRouter.t.sol` 39 tests (every tier and boundary, the 5% scaling, no stakers, minimums,
  rounding dust and a fuzz that every wei is accounted for, once-per-day permissionless distribute, the median against
  one and eleven pumped hours, stale reads, the burn: in band, pumped then retried, below minimum, failing swap,
  price-limit cap; timelock: too early, after 7 days, expiry, cancel, restart; recipient move; config bounds;
  re-entrant and refusing payees; rescue; ownership).
  `test/TroyaFeeRouterFork.t.sol` 2 tests on a local Robinhood Chain fork (drpc RPC reachable from the Mac): the
  router becomes the real Pons recipient, the real operator sweep credits it 0.00287 ETH, `distribute()` pays the real
  TroyaStake; and a real buy-and-burn through the Pons pool (0.01 ETH bought and burned 1,859,405 $TROYA).
- Slither 0.11.6 and Wake 4.22.2 outputs in `docs/fee-router-scan/`.
