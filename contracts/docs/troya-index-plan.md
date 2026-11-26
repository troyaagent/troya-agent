# TroyaIndex (TIDX): phase 1 plan

Status: **code and tests only, not deployed, not audited.** Nothing has been sent to any chain. Deploying is an owner
decision, done by the owner from his own wallet with the script in section 8. The idea came from the community; the
owner approved building it without a paid audit, so the design goal is that the contract itself is the safety: small
powers, hard limits in code, everything readable on Blockscout.

Files (all in `contracts/`):

| file | what |
|---|---|
| `src/TroyaIndex.sol` | the vault and its ERC-20 share token "Troya Index" (TIDX), 23,443 B runtime |
| `src/TroyaIndexSwapper.sol` | the stateless swap engine (Uniswap v3 pools and the v4 PoolManager), 6,939 B |
| `src/TroyaIndexZap.sol` | deposit with ETH only once the vault holds tokens, 4,735 B |
| `script/DeployTroyaIndex.s.sol` | deploy script the owner runs himself (reads parameters from env, prints what to verify) |
| `test/TroyaIndex.t.sol`, `test/TroyaIndexMocks.sol` | 53 unit, adversarial and fuzz tests |
| `test/TroyaIndexInvariant.t.sol` | 7 invariants over random adversarial sequences |
| `test/TroyaIndexFork.t.sol` | 3 tests on a local Robinhood Chain fork (real WETH, real pools, real Pons hook) |

Compiler as the other contracts: solc 0.8.24, optimizer 500 runs, evm shanghai (foundry.toml). All three are under the
24,576 B limit (TroyaIndex with 1,133 B to spare).

## 1. What it does, in plain words

- You put ETH in, you get TIDX. TIDX is a plain ERC-20: you can hold it, send it, or burn it to take your part out.
- Troya's keeper (an agent wallet) keeps the vault's ETH spread over a small basket of Robinhood Chain tokens (at most
  8 assets, ETH included), for example ETH + USDG + $TROYA + a few stock tokens. It does that only by swapping between
  the listed tokens, only in listed Uniswap pools, and the bought tokens always land straight back in the vault.
- Your TIDX is always a claim on the same fraction of **everything** the vault holds. 1% of the TIDX supply = 1% of the
  ETH, 1% of the USDG, 1% of the $TROYA, ... in the vault.
- Taking out (redeem) is always open and never uses a price: burn TIDX, receive your fraction of every asset, in kind.
  Nobody can pause it, not the team, not the keeper.
- Troya earns a small deposit fee in ETH (default 0.5%, never more than 1%, hard-coded), sent to TroyaFeeRouter.
- The owner is the team's 2-of-2 Safe `0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb` (the Safe that owns TroyaFeeRouter;
  read on chain 26 Nov 2026: Safe 1.5.0, threshold 2, owners `0x1e13…58d1` and `0x70A0…a931`). It can pause new deposits
  and rebalances at once, and every other change waits 48 hours in public.
- There is no function anywhere that sends the vault's assets to the owner, the keeper or anyone else, except to a
  holder who burns TIDX, or into a swap whose output must come back in the same transaction.

## 2. Every function and who may call it

### TroyaIndex

| function | who | what |
|---|---|---|
| `depositEth(minShares, receiver)` payable | anyone (not while deposits are paused) | only while the vault holds no token: mints `(ETH - fee) x supply / ETH held`; the first deposit mints 1 TIDX per wei and locks `DEAD_SHARES` (1e9) at 0x…dEaD |
| `deposit(shares, receiver, maxAmounts[])` payable | anyone (not while paused) | mints exactly `shares` against the same fraction of every holding, rounded up: ETH from msg.value (+ fee, spare refunded), tokens pulled from the caller |
| `previewDeposit(shares)`, `previewDepositEth(value)`, `previewRedeem(shares)` | view | what the calls above take / pay now |
| `redeem(shares, receiver)` | any TIDX holder, **always** | burns `shares`, pays `shares / supply` of every asset, rounded down; an asset that cannot be sent is kept as a claim |
| `claimOwed(asset, to)` | the holder a claim was kept for | sends that claim to `to` (any address) |
| `rebalance(venueId, zeroForOne, amountIn, minOut)` | keeper only (not while rebalances are paused) | one bounded swap between two listed assets in a listed pool; section 5 |
| `poke(venueId)`, `pokeAll()` | anyone | records this hour's pool price (the rebalance price guard) |
| `flushFees()` | anyone | sends the accrued ETH fees to `feeRecipient` |
| `prune(asset)` | anyone | drops a retired asset the vault no longer holds from the list |
| `setPaused(deposits, rebalances)` | owner | pause / resume new deposits and rebalances, instantly. Withdrawals cannot be paused: there is no flag for them |
| `pause()` | guardian or owner | pauses deposits and rebalances; the guardian cannot resume |
| `propose(op, data)` / `cancel(id)` | owner | queue / drop a change; checked against the hard limits when proposed |
| `execute(op, data)` | anyone | applies a queued change from 48 hours after proposing, for 7 days (then it lapses); re-checked when executed |
| `transferOwnership` / `acceptOwnership` | owner / new owner | two-step (Ownable2Step); `renounceOwnership` is disabled |
| views | anyone | `assets()`, `assetInfo()`, `holdings()`, `getVenue()`, `venueCount()`, `venueOf()`, `medianSqrtPrice()`, `spotSqrtPrice()`, `observation()`, `nextRebalanceAt()`, `etaOf()`, `owed()`, `totalOwed()`, `feesAccrued()`, caps, fee, keeper, guardian |

Timelocked changes (`Op`), with their hard limits:

| op | data | limit (in code) |
|---|---|---|
| `Keeper` | `address` | any; 0 switches rebalancing off |
| `Guardian` | `address` | any; 0 = none |
| `Fee` | `(address recipient, uint16 bps)` | bps <= 100 (1%); recipient not 0, not the vault |
| `Caps` | `(uint256 totalCap, uint256 walletCap)` | both > 0, wallet <= total |
| `RebalanceRules` | `(uint16 maxMoveBps, uint32 cooldown)` | 1..5000 bps; 1 hour..7 days |
| `AddAsset` | `address` | an ERC-20 contract, not WETH (ETH is the base), at most 8 assets |
| `RetireAsset` | `address` | not ETH; it can then only be sold, and pruned once empty |
| `AddVenue` | `VenueInput` | v3: a pool of the canonical factory `0x1f7d…2EfA`; v4: an initialized pool of the PoolManager `0x8366…0951` with **no hook or the Pons hook only**; both sides listed; slippage 1..1000 bps; at most 16 venues |
| `RemoveVenue` | `uint256 id` | an active venue |

Constants no proposal can change: `TIMELOCK` 48 h, `EXECUTION_WINDOW` 7 days, `MAX_ASSETS` 8, `MAX_VENUES` 16,
`MAX_FEE_BPS` 100, `MAX_MOVE_BPS` 5000, `MAX_SLIPPAGE_BPS` 1000, `MIN_COOLDOWN` 1 h, `MAX_COOLDOWN` 7 days,
`MIN_FIRST_DEPOSIT` 0.001 ETH, `DEAD_SHARES` 1e9, `MIN_OBSERVATIONS` 12 of 24, `SEND_GAS` 300,000.

### TroyaIndexSwapper (no owner, no state between transactions)

| function | who | what |
|---|---|---|
| `swap(venue, zeroForOne, exactIn, amount, maxIn, limit)` payable | anyone | trades what the caller just sent it (msg.value, or tokens transferred in first) in that one pool and sends the output **and any unspent input back to the caller**, in the same call; pays the pool at most `maxIn` |
| `uniswapV3SwapCallback` | only the v3 pool the swapper is swapping in, only during that swap | pays the pool, at most the budget |
| `unlockCallback` | only the v4 PoolManager, only during a swap the swapper started | runs the swap, settles the sold side, takes the bought side; any other delta shape reverts |
| `spot(venue)` | view | the pool's sqrt price, or 0 while it cannot be read safely (v3 pool mid-swap, PoolManager unlocked) |

ETH in v3 pools is WETH: the swapper wraps exactly what the pool asks inside the callback and unwraps every WETH it
holds before returning, so the vault only ever holds native ETH. Anyone calling `swap` can only trade their own funds.

### TroyaIndexZap (no owner, holds nothing between transactions)

| function | who | what |
|---|---|---|
| `zap(shares, receiver, venueIds[])` payable | anyone | reads `previewDeposit(shares)`, buys exactly the missing amount of each token with ETH in one of the vault's own ETH/token venues (exact output), makes the in-kind deposit for `receiver`, refunds all leftover ETH and tokens to the caller. msg.value is the most it can cost; the caller bears pool prices and fees |

## 3. Deposit pricing (no price, so no price to manipulate)

Let `S` be the TIDX supply and `h_i` the vault's holding of asset `i` (its balance minus claims kept for holders, and
for ETH minus accrued fees).

- **First deposit** (`S = 0`), ETH only: `net = value - fee`, must be >= 0.001 ETH. Mints `net` TIDX in total, of which
  `DEAD_SHARES = 1e9` go to 0x…dEaD forever. So 1 TIDX = 1 ETH at the start, and the supply can never return to 0.
- **ETH-only phase** (`S > 0`, every token holding is 0): `shares = floor(net x S / h_ETH)`, `h_ETH` before this deposit.
  This is the same proportional rule as below with one asset.
- **In-kind** (any time `S > 0`): to mint exactly `shares`, bring `ceil(h_i x shares / S)` of every asset `i`. After the
  deposit each holding per share is `(h_i + ceil(h_i x shares / S)) / (S + shares) >= h_i / S`: nobody is diluted, and
  the depositor gets exactly the fraction he paid for. Tokens are measured by what really arrived (a fee-on-transfer
  token makes the deposit revert). `maxAmounts[]` (one per asset, in `assets()` order) bounds what the caller brings
  if the basket moves between quote and transaction.
- **Zap**: the same in-kind deposit, with the tokens bought by exact-output swaps in the vault's own pools. The pools'
  prices only decide what the zapper pays for the tokens (bounded by msg.value); they never decide how many TIDX he gets.

Why not "value the basket with prices and mint by value": a spot price can be pushed for one block for the cost of the
pool fee, and Robinhood Chain has no oracle for most of these tokens. Any mint-by-price design lets someone mint cheap
TIDX against a pushed price and redeem them in kind. Proportional in-kind minting is immune by construction: it
never asks what anything is worth.

**First-depositor / inflation attack.** The classic attack (deposit 1 wei, donate a lot, make the next deposit round to 0
shares) does not work: the first deposit is at least 0.001 ETH, `DEAD_SHARES` can never be redeemed, a deposit that would
mint 0 shares reverts, `depositEth` has `minShares`, and in-kind deposits name their exact share count. Tested: an
attacker who is first, redeems down to 1 share and donates 100 ETH makes one share worth < 0.000001 ETH; the next
depositor loses at most one share of rounding, and most of the donation goes to the dead shares
(`test_InflationAttack_IsHarmless`). Donations of any asset are simply gifts to all holders.

## 4. Why withdrawals cannot be blocked

- `redeem` has no pause check, no keeper or owner check, no price, no oracle, no cap and no cooldown. It reads the
  holdings, burns the shares, then pays. Every state change happens before any transfer (checks-effects-interactions),
  under `nonReentrant`.
- **One bad asset cannot lock the rest.** Each asset is sent with its own low-level call limited to `SEND_GAS`
  (300,000) and copying at most 32 bytes of return data. If it reverts, returns false, burns all its gas, returns a huge
  payload, or the receiver refuses ETH, that amount is booked as `owed[receiver][asset]` (and taken out of the holdings
  of everyone else), and the loop continues. `claimOwed(asset, to)` retries later, to any address (tested with a frozen
  token, a gas burner, a return bomb, a false-returning token, a re-entrant token, a contract that refuses ETH).
- The owner's strongest moves (pause everything, keeper to 0, caps to 1 wei, fee to 1%) do not touch redemptions
  (`test_Redeem_HostileOwnerCannotStopIt`); the invariant run checks that no redemption ever reverted across thousands
  of random sequences that include all of these.
- What could still stop a single asset: its issuer freezing the vault's address (USDG and the Robinhood stock tokens
  are upgradeable proxies with issuer controls). Then that asset is kept as a claim; all the others still pay out.

## 5. Rebalancing (the keeper's only power)

`rebalance(venueId, zeroForOne, amountIn, minOut)`, keeper only:

1. not paused; at least `cooldown` (default 4 h) since the last rebalance;
2. the venue is active, both sides are listed, the bought side is not retired;
3. `amountIn <= maxMoveBps x holding` of the sold asset (default 20%; hard max 50%). A retired asset may be sold in full;
4. the venue has at least 12 hourly price reads in the last 24 hours (`poke`, anyone, hourly; the same scheme as the
   TroyaFeeRouter market-cap median). The guard price is their **median**;
5. the swap runs with a price limit of `median x (1 - slippageBps)` (in price terms), so the pool can never be pushed past
   that band by this trade, and a pool already pushed past it refuses the trade outright;
6. the vault hands exactly `amountIn` to the swapper; the swapper must return the output (and any unspent input) in the
   same call; the vault then measures **its own balances**: `received >= minOut` and
   `received >= value of what was spent at the median x (1 - slippageBps)`, pool fees included, or the whole call reverts.

There is no recipient parameter anywhere: the keeper cannot be paid, cannot pick a pool that is not listed, cannot pick
an asset that is not listed, cannot skip the median, and cannot take more than the move cap per cooldown.

Default slippage per venue: 100 bps for deep v3 pools (WETH/USDG 0.01%), 200 for v3 stock pools, 600 for Pons pools
(their hook keeps 2.9% of every trade, so a Pons trade can never be inside a band under ~3%).

## 6. Caps and fee

- **Caps are in TIDX** (1 TIDX = 1 ETH at the first deposit), so no price is needed to enforce them:
  `totalCap` (default 2 TIDX, ~2 ETH) on the supply, and `walletCap` (default 0.5 TIDX) on what the receiving wallet
  holds after a deposit. Raising them goes through the 48-hour timelock. Donations raise value, never supply.
  The wallet cap is a soft guard: it only applies to deposits (TIDX are transferable), and several wallets can each
  deposit up to it. If the basket gains in ETH terms, the cap in ETH terms grows with it.
- **Fee**: `feeBps` of the ETH part of a deposit (default 50 = 0.5%, hard max 100 = 1%), accrued in the vault and sent by
  anyone's `flushFees()` to `feeRecipient` (default TroyaFeeRouter `0x76d9…Ff3B`, whose `receive()` takes ETH and splits
  it by its own rule at the next `distribute()`). No performance fee, no withdrawal fee, no fee in tokens.
  Honest limitation: in the in-kind phase the fee is charged on the ETH part only (there is no price to value the token
  part), so the effective fee is `feeBps x (ETH share of the basket)`. With a 40% ETH basket, 0.5% becomes 0.2%. The
  owner can compensate up to the 1% cap.

## 7. Threat model

| who | can | cannot |
|---|---|---|
| **anyone / an attacker** | deposit, redeem own TIDX, donate, poke prices, call the swapper with its own funds, sandwich a rebalance up to the band edge | mint TIDX cheaply (no price in minting), dilute holders (rounding always favors the vault), inflate a share to steal a deposit (dead shares + min first deposit), take anything from the vault or the swapper or the zap (they hold nothing callable), fake a pool callback (refused unless from the exact pool mid-swap), list a fake pool (only factory pools / PoolManager pools with no hook or the Pons hook), block anyone's withdrawal, move the 24-hour median without owning at least 13 different hours of the pool's price |
| **a malicious or stolen keeper** | make bad but in-band trades: at most `maxMoveBps` of one asset per `cooldown`, each at most `slippageBps` under the median (with defaults: <= 2% x 20% = 0.4% of the sold asset per 4 hours on a v3 venue, 6% x 20% = 1.2% on a Pons venue), and churn the basket to pay pool fees | receive any funds, choose a recipient, trade in an unlisted pool or asset, exceed the cap or cooldown, trade outside the band, pause or block withdrawals, change any setting. The guardian or owner can pause rebalances at once; replacing the keeper takes 48 hours |
| **a malicious or compromised owner (Safe)** | pause deposits and rebalances instantly; after a public 48-hour notice: set the fee to at most 1% (to itself), swap the keeper (to itself), list assets and pools, change caps and rebalance rules within the hard limits | take, sweep or rescue any asset (no such function), upgrade, delegatecall, call arbitrary contracts, pause or slow withdrawals, change the hard limits, skip the 48 hours |
| **owner and keeper together** (the worst case) | after the 48 h notice (plus 12 h of price reads), list a token and a pool it controls (e.g. its own thin Uniswap v3 pool at an inflated price) and have the vault buy into it, at most `maxMoveBps` of one asset per cooldown | do it without a public `ChangeProposed` event 48 hours ahead; stop holders from redeeming in kind in the meantime. **This is the real trust assumption**: holders are safe as long as they (or Troya's watchdog) react to a hostile proposal within ~2 days |
| **a bad token** in the basket | refuse transfers (then it is kept as a claim on withdrawal, and new in-kind deposits stop until it works again or is retired and sold), charge a transfer fee (in-kind deposits revert), rebase (the vault reads live balances, so holders share it; claims kept in a shrinking token may then not be fully payable), re-enter (blocked by `nonReentrant`), burn gas (capped at 300k per asset in redeem) | block the other assets' withdrawals, take assets |
| **a pool, the v4 PoolManager, the Pons hook, WETH** | these are trusted external code: the canonical Uniswap v3 factory and PoolManager, the Pons hook (immutable address in the swapper), and Robinhood Chain's WETH (an upgradeable proxy: its admin could change it; the vault holds WETH only inside a swap) | a hostile hook cannot be listed (only none or the Pons hook); a pool cannot be paid more than the trade's budget, and the vault reverts unless its own balances show the output arrived |

Read-only reentrancy: during a withdrawal's token transfers, the vault's view functions can show a half-paid state.
Nothing inside the vault can be re-entered; integrators that read `holdings()` or `previewRedeem()` from inside a token
callback should not trust them.

## 8. Exact deploy parameters (placeholders where the owner decides)

`new TroyaIndexSwapper(weth, v3Factory, poolManager, ponsHook)`

| param | value |
|---|---|
| weth | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (checked: `SwapRouter02.WETH9()`) |
| v3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (checked: `SwapRouter02.factory()`) |
| poolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| ponsHook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |

`new TroyaIndex(Init)`

| field | value |
|---|---|
| owner | `0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb` (team Safe 2-of-2) |
| swapper | the address deployed just before |
| keeper | `<KEEPER>`: a **new** wallet used only for rebalancing (not the creator wallet, not the gas sponsor) |
| guardian | `<GUARDIAN>`: a separate watchdog key that can only pause (or 0) |
| feeRecipient | `0x76d97f6A3b97d856dBC7FaA6E59a892D87C3Ff3B` (TroyaFeeRouter) or `<BUY_AND_BURN>` |
| feeBps | `<FEE_BPS>`, suggested `50` (0.5%) |
| totalCap | `<TOTAL_CAP>`, suggested `2000000000000000000` (2 TIDX ~ 2 ETH) |
| walletCap | `<WALLET_CAP>`, suggested `500000000000000000` (0.5 TIDX) |
| maxMoveBps | `2000` (20%) |
| cooldown | `14400` (4 hours) |
| assets | `<BASKET>`, e.g. USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, $TROYA `0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074`, NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| venues | e.g. v3 WETH/USDG 0.01% `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (slippage 100); v4 $TROYA Pons pool key `(0x0, TROYA, 0, 200, Pons hook)` = pool id `0x050f1f04…38c1` (slippage 600); v3 NVDA/WETH 0.05% `0x62AB521f71431f78ac374CdbadC6cda3c8916b6C` (slippage 200) |

`new TroyaIndexZap(vault)`

Liquidity seen on 26 Nov 2026 (block ~123.6M): WETH/USDG 0.01% pool ~4,777 WETH; NVDA/WETH 0.05% ~413 WETH; the $TROYA
Pons pool is thin (~$12k of liquidity), so a 0.1 ETH buy already moves it a few percent. With a 2 ETH vault cap, keep
$TROYA a small weight.

Measured on the fork: vault deploy ~5.65M gas (execution; the swapper and zap are much smaller contracts); a rebalance
160k to 305k gas; a zap into a 4-asset basket ~808k; a 4-asset redeem ~119k. At the ~0.02 gwei seen when TroyaFeeRouter
was deployed, the whole deploy costs well under 0.001 ETH.

## 9. Deploy and verify, step by step (the owner, from his own wallet)

Nothing below has been run against the live chain. The script never reads a private key; the signer is a forge flag.

1. Decide section 13 (keeper wallet, guardian, fee, caps, basket). Create the keeper wallet fresh.
2. In `contracts/`, run the full test suite (fork tests included): `forge test`. All must pass.
3. Set the parameters, for example:
   ```
   export INDEX_KEEPER=<KEEPER>
   export INDEX_GUARDIAN=<GUARDIAN>
   export INDEX_FEE_BPS=50
   export INDEX_TOTAL_CAP=2000000000000000000
   export INDEX_WALLET_CAP=500000000000000000
   export INDEX_ASSETS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
   export INDEX_V3_POOLS=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca,0x62AB521f71431f78ac374CdbadC6cda3c8916b6C
   export INDEX_V3_SLIPPAGE_BPS=100,200
   export INDEX_PONS_TOKENS=0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074
   export INDEX_PONS_SLIPPAGE_BPS=600
   ```
   (`INDEX_OWNER` defaults to the Safe and `INDEX_FEE_RECIPIENT` to TroyaFeeRouter; the script reads each Pons coin's
   pool fee and tick spacing from the Pons factory and refuses coins not paired with native ETH.)
4. Dry run (simulation only, nothing is sent):
   `forge script script/DeployTroyaIndex.s.sol --rpc-url robinhood --ledger --sender <owner wallet>`
   (or `--account <keystore name>` instead of `--ledger`). Read the printed parameters.
5. Deploy: the same command with `--broadcast`. It sends three transactions (swapper, vault, zap) and prints the three
   addresses, the read-back values, and the three `forge verify-contract` commands with their constructor arguments.
6. Verify on Blockscout so anyone can read the source: run the three printed commands, e.g.
   `forge verify-contract --chain 4663 --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ <vault> src/TroyaIndex.sol:TroyaIndex --constructor-args <hex>`
   and check each address shows "Verified" on https://robinhoodchain.blockscout.com (as for TroyaFeeRouter). Sourcify too
   if wanted (`--verifier sourcify`).
7. Read back on Blockscout "Read contract": `owner()` = the Safe, `pendingOwner()` = 0, `keeper()`, `guardian()`,
   `feeRecipient()`, `feeBps()`, `totalCap()`, `walletCap()`, `maxMoveBps()`, `cooldown()`, `assets()`, every
   `getVenue(i)`, `swapper()` = the deployed swapper, `swapper().ponsHook()` = the Pons hook, `totalSupply()` = 0.
8. Start the hourly `pokeAll()` (Troya server, from the keeper or gas sponsor; anyone may call it). Rebalances need 12
   hours of reads.
9. First deposit: the team deposits a small amount itself (>= 0.001 ETH) with `depositEth`, then redeems a part, to see
   the full cycle on chain before announcing.
10. Announce (X and TG together) only after the owner types the go-ahead in chat, with the three addresses, the
    "not audited" section below, the caps, and the 48-hour timelock.

Keeper side (server, not built in phase 1): read `assets()`, `holdings()`, the venues' `spotSqrtPrice` and quoter
prices; when the basket drifts from its target weights, call `rebalance(venue, direction, amount <= cap, minOut =
quote - 1%)` once per cooldown. Watch `ChangeProposed` and alert publicly on any proposal. The UI reads
`previewDeposit` / `previewRedeem` and uses `depositEth` (ETH-only phase) or the zap (afterwards).

## 10. Tests and scans (local)

`forge test`: 186 tests in the project, TroyaIndex adds 63 and all 63 pass. The 177 non-fork tests pass every run. Of the
older fork tests, `TroyaFeeRouterFork.test_Fork_RecipientSweepDistribute` passes or fails with the latest block (it
needs unswept Pons fees at that moment, as already noted in fee-router-plan.md; nothing here touches it), and repeated
runs can hit the free drpc endpoint's rate limit (HTTP 429), which fails fork tests for that run only.

- `test/TroyaIndex.t.sol` 53: constructor limits (fee, caps, rules, WETH as asset, EOA asset, duplicates, 9 assets,
  fake pool that mimics a real one, unlisted side, slippage bounds, duplicate pool, foreign v4 hook, uninitialized v4
  pool, valid Pons pool); first deposit and dead shares; minimum first deposit; ETH-only pricing after a donation;
  `minShares` against a donation front-run; `depositEth` closed once a token is held; exact in-kind proportions, refund,
  `maxAmounts`, wrong length, missing approval, fee-on-transfer refused; total and wallet caps, receiver-param and
  transfer bypass attempts; pause stops deposits and rebalances but not withdrawals, guardian cannot resume; inflation
  attack; fee flush; in-kind pro-rata withdrawal down to the dead shares; withdrawals with a frozen / gas-burning /
  return-bomb / false-returning / re-entrant token and with an ETH-refusing and an ETH-re-entering receiver, claims to
  another address; hostile owner cannot stop withdrawals; rebalance ETH->token, token->token, token->ETH; keeper-only;
  cooldown and move cap; 12 reads needed; stale reads expire; pumped spot refused even with `minOut = 0`; partial fill
  at the band edge in a thin pool; `minOut` above the floor; the median ignores 11 pumped hours of 24; retire -> sell in
  full -> prune keeps order; malicious keeper drives the swapper directly (only its own funds), fakes callbacks, has no
  admin power; worst-case keeper loss per move is inside the band; spoofed callbacks; full timelock lifecycle (too early,
  anyone executes, cancel, expiry, already pending); every op and its bounds at propose and execute; asset and venue
  proposed together; fake pool never listable; owner has no drain selector and its strongest levers move no holding;
  two-step ownership; guardian pause-only; zap with ETH only (exact shares, refunds, nothing left in the zap), zap
  budget and venue checks, zap respects caps; fuzz: in-kind deposits never dilute (with random donations), redemptions
  are pro-rata rounded down, deposit-then-redeem never profits.
- `test/TroyaIndexInvariant.t.sol` 7 invariants, 96 runs x 60 calls each, over random deposits (ETH and in kind),
  withdrawals, keeper rebalances (inside and above the cap), donations, price pumps and heals, a token switching between
  normal / frozen / gas-burning / false-returning, owner pauses and proposals, claims and fee flushes: withdrawals never
  revert; no action dilutes holders or lowers a holding unless it is a withdrawal or a rebalance (which lowers only the
  sold asset, by what it spent, within the cap, and raises the bought one); every kept claim and fee is backed; owed
  sums match; shares add up and the dead shares never move; the swapper never keeps anything; supply within the cap.
- `test/TroyaIndexFork.t.sol` 3 on a local fork of Robinhood Chain (drpc RPC, reachable from the Mac, latest block on
  26 Nov 2026): real WETH, real WETH/USDG and NVDA/WETH v3 pools, real $TROYA Pons v4 pool and hook. Two deposits ->
  ETH->USDG (0.15 ETH -> 250.9 USDG), ETH->$TROYA (0.1 ETH -> 6.34M $TROYA), ETH->NVDA (0.1 ETH -> 1.12 NVDA) -> zap 0.2
  TIDX for 0.20136 ETH -> sell 20% of the $TROYA back through the Pons hook -> all three holders redeem in kind (ETH,
  USDG, $TROYA, NVDA each) -> fees flushed into TroyaFeeRouter. A whale's 1 ETH buy pushes the real Pons pool far
  outside the median band and the keeper's rebalance is refused. The deploy script runs in-process with env
  parameters and produces the expected vault.
- **Not run: Slither, Wake and Halmos are not installed on this Mac** (the fee-router scans in `docs/fee-router-scan/`
  were made from a since-removed environment). Nothing was installed. Recommended before deposits beyond the starting
  cap: run Slither 0.11.x and Wake as for TroyaFeeRouter and add the outputs to `docs/troya-index-scan/`.

## 11. Not audited: residual risks, honestly

1. **No independent review.** All tests above were written by the same author as the code. They can only find what the
   author thought of. Keep the caps small (2 ETH total, 0.5 per wallet) until the code has had outside eyes.
2. **The owner + keeper trust assumption** (section 7): with a 48-hour public notice, they could list a token and pool they
   control and move up to 20% of an asset per 4 hours into it. Holders' only defense is to watch and redeem. Troya's
   server should alert on every `ChangeProposed` in X and TG.
3. **A stolen keeper key bleeds slowly** until paused: up to the band (2% on v3, 6% on Pons venues) of 20% of an asset per
   cooldown, plus pool fees. A guardian key on a watchdog that pauses on unexpected `Rebalanced` events limits it to one
   or two trades.
4. **The 24-hour median is from the pools themselves.** Someone who controls the first read of 13 different hours (13
   manipulated round trips, each paying the pool fee twice) shifts the band. On thin pools ($TROYA) this is cheaper; keep
   such assets small and their slippage tight enough.
5. **Basket tokens can be frozen or upgraded by their issuers** (USDG and the Robinhood stock tokens are proxies; Robinhood
   stock tokens may have their own transfer rules). Withdrawals then keep that token as a claim, and in-kind deposits stop
   until the token is retired and sold (which also needs it to be transferable).
6. **WETH on Robinhood Chain is an upgradeable proxy**; the vault holds it only inside a swap, but a malicious WETH could
   make swaps through v3 WETH pools fail or misbehave within the band checks.
7. **Pons hook**: its 2.9% cut makes every $TROYA rebalance cost ~3% plus impact; the hook is immutable trusted code we do
   not control. A Pons change to the hook would only affect new pools (the address is fixed in the swapper).
8. **Fee under-charge in the in-kind phase** (section 6), by design.
9. **Caps are soft against Sybils** (many wallets) and do not follow transfers; they limit how much can be deposited,
   not who holds TIDX.
10. **Rebasing or fee-on-transfer tokens** must not be listed; deposits measure arrivals, but rebasing tokens could leave
    kept claims under-backed.
11. **Gas**: a withdrawal of an 8-asset basket in which every token burns its full 300k stipend needs ~2.5M gas; the
    holder can always add gas, and nothing is lost if a transfer is skipped.
12. **Arbitrum Orbit specifics**: only `block.timestamp` is used (Arbitrum's `block.number` is L1's); compiled for
    Shanghai like the other Troya contracts on this chain.

## 12. Rollback / stopping

- Emergency: guardian or owner `pause()`: new deposits and rebalances stop at once; holders keep redeeming.
- Bad keeper: pause, then `propose(Keeper, new)` and `execute` 48 hours later.
- Bad asset: pause rebalances if needed, `propose(RetireAsset)`; after 48 h the keeper sells it (in full allowed, still in
  the band); `prune` once empty.
- Wind-down: pause deposits forever and let every holder redeem in kind. There is no "close" or "migrate" function and
  there will not be one in this contract: a phase-2 vault would be a new contract that holders move to by redeeming here
  and depositing there.

## 13. Open decisions for the owner

1. **Caps**: start `totalCap` 2 TIDX and `walletCap` 0.5 TIDX (suggested), or other values. Raising later = 48 h each time.
2. **Fee**: 0.5% suggested (hard max 1%). Recipient: TroyaFeeRouter (fee split by its rule: stakers, gas, burn at the top
   tier, team) or a dedicated buy-and-burn address for "ends up as $TROYA" (not built; phase 2).
3. **Basket and weights**: which tokens (max 7 besides ETH) and which pools. Suggested start: ETH + USDG + a small $TROYA
   weight + 1 to 3 Robinhood stock tokens with deep WETH pools (NVDA 0.05% has ~413 WETH). Weights live in the keeper,
   not in the contract.
4. **Keeper wallet**: a fresh hot wallet on the server, only for `rebalance` and `pokeAll`. Never the creator wallet.
5. **Guardian**: a second, separate key on a watchdog (recommended), or none.
6. **Slippage per venue**: 100 / 200 / 600 bps suggested (v3 deep / v3 stock / Pons).
7. **Rebalance rules**: 20% per move and 4 h cooldown suggested; tighter (10%, 6 h) means a stolen keeper bleeds slower but
   reaching target weights takes longer.
8. **When to deploy and whether to get the scans (Slither/Wake) or an outside review first**; and the go-ahead for any
   public announcement, typed in chat.
