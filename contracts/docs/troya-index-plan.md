# TroyaIndex (TIDX): plan (phase 1 contracts, phase 2 keeper, API, app and deploy page)

Status: **code and tests only, not deployed, not audited.** Nothing has been sent to any chain. Deploying is an owner
decision, done by the owner from his own browser wallet on the deploy page (section 9; the forge script is the
alternative). The idea came from the community; the
owner approved building it without a paid audit, so the design goal is that the contract itself is the safety: small
powers, hard limits in code, everything readable on Blockscout.

Files (all in `contracts/`):

| file | what |
|---|---|
| `src/TroyaIndex.sol` | the vault and its ERC-20 share token "Troya Index" (TIDX), 24,209 B runtime |
| `src/TroyaIndexSwapper.sol` | the stateless swap engine (Uniswap v3 pools and the v4 PoolManager), 6,976 B |
| `src/TroyaIndexZap.sol` | deposit with ETH only once the vault holds tokens, 4,735 B |
| `script/DeployTroyaIndex.s.sol` | deploy script the owner runs himself (reads parameters from env, prints what to verify) |
| `test/TroyaIndex.t.sol`, `test/TroyaIndexMocks.sol` | 64 unit, adversarial and fuzz tests (10 of them on the management fee) |
| `test/TroyaIndexInvariant.t.sol` | 8 invariants over random adversarial sequences |
| `test/TroyaIndexFork.t.sol` | 3 tests on a local Robinhood Chain fork (real WETH, real pools, real Pons hook) |

Compiler as the other contracts: solc 0.8.24, optimizer 500 runs, evm shanghai (foundry.toml). All three are under the
24,576 B limit (TroyaIndex with 367 B to spare after the management fee and the static-analysis hardening, 27 Nov 2026).

Phase 2 (outside `contracts/`): `server/index-keeper.mjs` (keeper, public API, alerts), `public/agent/desk/index-vault.js`
(the app page `#/vault` and the owner's deploy page `#/vault/deploy`), `public/agent/desk/index-deploy-lib.js` (the approved
parameters and the deployment calldata, shared by the deploy page and the fork test), `public/agent/desk/troya-index.json`
(ABI + bytecode, built by `tools/build-index-artifacts.mjs`), tests `tools/index-keeper-test.mjs`,
`tools/index-fork-test.mjs`, `tools/index-ui-test.mjs`. Section 14.

## 1. What it does, in plain words

- You put ETH in, you get TIDX. TIDX is a plain ERC-20: you can hold it, send it, or burn it to take your part out.
- Troya's keeper (an agent wallet) keeps the vault's ETH spread over a small basket of Robinhood Chain tokens (at most
  8 assets, ETH included), for example ETH + USDG + $TROYA + a few stock tokens. It does that only by swapping between
  the listed tokens, only in listed Uniswap pools, and the bought tokens always land straight back in the vault.
- Your TIDX is always a claim on the same fraction of **everything** the vault holds. 1% of the TIDX supply = 1% of the
  ETH, 1% of the USDG, 1% of the $TROYA, ... in the vault.
- Taking out (redeem) is always open and never uses a price: burn TIDX, receive your fraction of every asset, in kind.
  Nobody can pause it, not the team, not the keeper.
- Troya earns two small fees, both with hard-coded maximums and changeable only through the 48-hour timelock:
  a deposit fee in ETH (default 0.5%, never more than 2%) sent to TroyaFeeRouter, and a management fee of 1% a year
  (never more than 2% a year) paid by minting new TIDX to the creator wallet. Withdrawals are free.
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
| `accrue()` | anyone | mints the management fee due since the last accrual (deposit, redeem and rebalance do it first anyway) |
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
| `Fee` | `(address recipient, uint16 bps)` | deposit fee: bps <= 200 (2%); recipient not 0, not the vault |
| `Caps` | `(uint256 totalCap, uint256 walletCap)` | both > 0, wallet <= total |
| `RebalanceRules` | `(uint16 maxMoveBps, uint32 cooldown)` | 1..5000 bps; 1 hour..7 days |
| `AddAsset` | `address` | an ERC-20 contract, not WETH (ETH is the base), at most 8 assets |
| `RetireAsset` | `address` | not ETH; it can then only be sold, and pruned once empty |
| `AddVenue` | `VenueInput` | v3: a pool of the canonical factory `0x1f7d…2EfA`; v4: an initialized pool of the PoolManager `0x8366…0951` with **no hook or the Pons hook only**; both sides listed; slippage 1..1000 bps; at most 16 venues |
| `RemoveVenue` | `uint256 id` | an active venue |
| `MgmtFee` | `(address recipient, uint16 bpsPerYear)` | management fee: <= 200 (2% a year); recipient not 0, not the vault. Executing it first accrues the old rate up to that second |

Constants no proposal can change: `TIMELOCK` 48 h, `EXECUTION_WINDOW` 7 days, `MAX_ASSETS` 8, `MAX_VENUES` 16,
`MAX_FEE_BPS` 200, `MAX_MGMT_FEE_BPS` 200 a year, `MAX_MOVE_BPS` 5000, `MAX_SLIPPAGE_BPS` 1000, `MIN_COOLDOWN` 1 h, `MAX_COOLDOWN` 7 days,
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
- The owner's strongest moves (pause everything, keeper to 0, caps to 1 wei, both fees at their maximum) do not touch redemptions
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

## 6. Caps and fees

- **Caps are in TIDX** (1 TIDX = 1 ETH at the first deposit), so no price is needed to enforce them:
  `totalCap` (2 TIDX, ~2 ETH) on the supply, and `walletCap` (0.5 TIDX) on what the receiving wallet holds after a
  deposit. Raising them goes through the 48-hour timelock. Donations raise value, never supply. The wallet cap is a soft
  guard: it only applies to deposits (TIDX are transferable), and several wallets can each deposit up to it. If the
  basket gains in ETH terms, the cap in ETH terms grows with it. Management-fee TIDX are minted on top of deposits and
  may take the supply a little past `totalCap`; deposits still stop at the cap (`supply + new shares <= totalCap`).
- **Deposit fee** (owner, 26 Nov 2026): `feeBps` of the ETH part of a deposit, default 50 = 0.5%, **hard max 200 = 2%**,
  accrued in the vault and sent by anyone's `flushFees()` to `feeRecipient` (TroyaFeeRouter `0x76d9…Ff3B`, whose
  `receive()` takes ETH and splits it by its own rule). Honest limitation: in the in-kind phase it is charged on the ETH
  part only (there is no price to value the token part), so the effective fee is `feeBps x (ETH share of the basket)`.
- **Management fee** (owner, 26 Nov 2026): `mgmtFeeBps` a year, default 100 = 1%, **hard max 200 = 2% a year**, paid by
  minting TIDX to `mgmtFeeRecipient` (default the creator wallet `0x57b0…D09E4`; TroyaFeeRouter cannot handle TIDX). No
  price is involved: after `t` seconds the vault mints `supply x mgmtFeeBps x t / (10,000 x 365 days)` new TIDX.
  - It accrues on every deposit, redeem and rebalance (before they are priced), on executing a fee change (old rate up to
    that second, new rate after), and by anyone's `accrue()`. The previews (`previewDeposit`, `previewDepositEth`,
    `previewRedeem`) price against the supply with the fee due now already counted, so what they show is what the call does.
  - It never mints more than the rate allows for the elapsed time, however long the vault sat idle: the minted share of
    the supply is linear in time (`r x t`, not compounded), so holders keep `1 / (1 + r t)` of the vault: at 2% a year
    after one year 98.04%, after 10 years 83.3%, after 100 idle years 33.3% (more than the 13.3% that 2% compounded
    yearly would leave). Nothing can overflow or divide by a shrinking number, so `accrue()` and therefore withdrawals
    can never revert because of it (tested after a 100-year idle period).
  - With no supply (before the first deposit) nothing accrues; the first deposit still mints 1 TIDX per wei minus the dead
    shares, and the inflation defence is unchanged (the fee only adds supply; tested).
  - The fee recipient's TIDX are ordinary TIDX: it can redeem them in kind like anyone, or hold them.
- No performance fee (it would need prices), no withdrawal fee, no fee in tokens.

## 7. Threat model

| who | can | cannot |
|---|---|---|
| **anyone / an attacker** | deposit, redeem own TIDX, donate, poke prices, call the swapper with its own funds, sandwich a rebalance up to the band edge | mint TIDX cheaply (no price in minting), dilute holders (rounding always favors the vault), inflate a share to steal a deposit (dead shares + min first deposit), take anything from the vault or the swapper or the zap (they hold nothing callable), fake a pool callback (refused unless from the exact pool mid-swap), list a fake pool (only factory pools / PoolManager pools with no hook or the Pons hook), block anyone's withdrawal, move the 24-hour median without owning at least 13 different hours of the pool's price |
| **a malicious or stolen keeper** | make bad but in-band trades: at most `maxMoveBps` of one asset per `cooldown`, each at most `slippageBps` under the median (with defaults: <= 2% x 20% = 0.4% of the sold asset per 4 hours on a v3 venue, 6% x 20% = 1.2% on a Pons venue), and churn the basket to pay pool fees | receive any funds, choose a recipient, trade in an unlisted pool or asset, exceed the cap or cooldown, trade outside the band, pause or block withdrawals, change any setting. The guardian or owner can pause rebalances at once; replacing the keeper takes 48 hours |
| **a malicious or compromised owner (Safe)** | pause deposits and rebalances instantly; after a public 48-hour notice: set the deposit fee to at most 2% (to itself) and the management fee to at most 2% a year (to itself, which dilutes holders by at most 2% a year of the supply), swap the keeper (to itself), list assets and pools, change caps and rebalance rules within the hard limits | take, sweep or rescue any asset (no such function), upgrade, delegatecall, call arbitrary contracts, pause or slow withdrawals, change the hard limits, skip the 48 hours |
| **owner and keeper together** (the worst case) | after the 48 h notice (plus 12 h of price reads), list a token and a pool it controls (e.g. its own thin Uniswap v3 pool at an inflated price) and have the vault buy into it, at most `maxMoveBps` of one asset per cooldown | do it without a public `ChangeProposed` event 48 hours ahead; stop holders from redeeming in kind in the meantime. **This is the real trust assumption**: holders are safe as long as they (or Troya's watchdog) react to a hostile proposal within ~2 days |
| **a bad token** in the basket | refuse transfers (then it is kept as a claim on withdrawal, and new in-kind deposits stop until it works again or is retired and sold), charge a transfer fee (in-kind deposits revert), rebase (the vault reads live balances, so holders share it; claims kept in a shrinking token may then not be fully payable), re-enter (blocked by `nonReentrant`), burn gas (capped at 300k per asset in redeem) | block the other assets' withdrawals, take assets |
| **a pool, the v4 PoolManager, the Pons hook, WETH** | these are trusted external code: the canonical Uniswap v3 factory and PoolManager, the Pons hook (immutable address in the swapper), and Robinhood Chain's WETH (an upgradeable proxy: its admin could change it; the vault holds WETH only inside a swap) | a hostile hook cannot be listed (only none or the Pons hook); a pool cannot be paid more than the trade's budget, and the vault reverts unless its own balances show the output arrived |

Read-only reentrancy: during a withdrawal's token transfers, the vault's view functions can show a half-paid state.
Nothing inside the vault can be re-entered; integrators that read `holdings()` or `previewRedeem()` from inside a token
callback should not trust them.

## 8. Exact deploy parameters (approved by the owner, 26 Nov 2026)

These live in one place, `public/agent/desk/index-deploy-lib.js` (`PARAMS`), used by the deploy page and the fork test;
the forge script takes the same values from env.

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
| owner | the deploying wallet: the creator wallet `0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4`, which right after hands it to the team Safe `0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb` with `transferOwnership` (two-step: the Safe must call `acceptOwnership`) |
| swapper | the address deployed just before |
| keeper | the server's own keeper wallet, generated on the server (`GET /api/index/keeper`); never a team wallet |
| guardian | `0x0` (none for now) |
| feeRecipient / feeBps | TroyaFeeRouter `0x76d97f6A3b97d856dBC7FaA6E59a892D87C3Ff3B` / `50` (0.5%; hard max 200) |
| mgmtFeeRecipient / mgmtFeeBps | the creator wallet `0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4` / `100` (1% a year; hard max 200) |
| totalCap / walletCap | `2000000000000000000` (2 TIDX) / `500000000000000000` (0.5 TIDX) |
| maxMoveBps / cooldown | `2000` (20%) / `14400` (4 hours) |
| assets | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, SPY `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`, NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, $TROYA `0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074` (`assets()` = ETH, USDG, SPY, NVDA, $TROYA) |
| venues | v3 WETH/USDG 0.01% `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (band 100 bps); v3 SPY/WETH 0.05% `0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e` (200); v3 NVDA/WETH 0.05% `0x62AB521f71431f78ac374CdbadC6cda3c8916b6C` (200); v4 $TROYA Pons pool `(ETH, TROYA, fee 0, tick spacing 200, Pons hook)` = pool id `0x050f1f04…38c1` (600) |

`new TroyaIndexZap(vault)`

**Basket choice, from live pool depth (read on chain 26 Nov 2026, all 63 Robinhood stock tokens scanned for WETH pools):**
the deepest stock pools were NVDA/WETH 0.05% (~425 WETH), SPY/WETH 0.05% (~299 WETH) and SPCX/WETH 0.05% (~234 WETH);
QuoterV2 showed 0.5 ETH moving each of NVDA, SPY, SPCX and USDG by under 0.03% (round trip 0.5 ETH → 0.4993 to 0.4999).
SPY (an S&P 500 ETF token) is the natural core of an index, and NVDA has the deepest pool. SPCX (a private company) was
left out. Starting keeper targets (`data/index-weights.json`, changeable without touching the contract): ETH 35%, USDG
25%, SPY 20%, NVDA 15%, $TROYA 5% ($TROYA's Pons pool holds ~$12k, so 5% of a 2 ETH vault is ~0.1 ETH).

Measured on the fork (gas used): swapper 1.58M, vault 6.47M, zap 1.10M, `transferOwnership` ~50k; a rebalance 160k to
305k; a zap into the basket ~0.8M; a 5-asset redeem ~150k. At ~0.02 gwei the whole deploy costs about 0.0002 ETH.

## 9. Deploy and verify, step by step (the owner, from his own browser wallet)

Nothing below has been run against the live chain. Nothing reads a private key: every transaction is signed in the
owner's wallet.

1. The team runs the tests (section 10), runs `node tools/build-index-artifacts.mjs` after `forge build` so the page's
   bytecode is the tested build of the committed source, and deploys the server with the keeper module (section 14).
2. The owner opens `troya.codes/agent/#/vault/deploy` (linked from nowhere) and connects the **creator wallet**
   `0x57b0…D09E4`; with any other wallet the page stops. The page shows every parameter above, the build (compiler,
   source commit, size) and the keeper address it fetched from the server.
3. Four buttons, one transaction each, in order (each shows a review first, then the wallet):
   1. deploy TroyaIndexSwapper; 2. deploy TroyaIndex; 3. deploy TroyaIndexZap; 4. `transferOwnership(Safe)`.
   The page waits for each receipt, checks the new address has code, shows the transaction and the address, and keeps
   the run in the browser (a reload resumes where it stopped).
4. The Safe accepts: in the Safe app on Robinhood Chain, a transaction to the vault with value 0 and data
   `0x79ba5097` (`acceptOwnership()`), signed by both signers. Until then the creator wallet stays the owner (every change
   still waits 48 hours, and the page and the public alerts show any proposal).
5. The page prints the three `forge verify-contract … --verifier blockscout …` commands with their constructor arguments;
   the team runs them from `contracts/` and checks each address shows "Verified" on Blockscout.
6. The page prints the server settings (`INDEX_ADDRESS`, `INDEX_ZAP_ADDRESS`, `INDEX_DEPLOY_BLOCK`); the team sets them,
   funds the keeper with ~0.005 ETH for gas and sets `INDEX_KEEPER=1`. Pokes start hourly; the first rebalance comes after
   12 hourly reads.
7. First deposit by the team (small, `depositEth`), then a partial redeem, before any announcement; announce (X and TG
   together) only after the owner types the go-ahead in chat.

Alternative without the browser: `script/DeployTroyaIndex.s.sol` with `--ledger` / `--account` (it reads the same values
from env: `INDEX_KEEPER`, `INDEX_ASSETS`, `INDEX_V3_POOLS`, `INDEX_V3_SLIPPAGE_BPS=100,200,200`, `INDEX_PONS_TOKENS`,
`INDEX_MGMT_FEE_BPS`, `INDEX_MGMT_FEE_RECIPIENT`, …; `INDEX_OWNER` defaults to the Safe directly, which skips step 4).

## 10. Tests and scans (local)

`forge test` (26 Nov 2026, after the management fee): **197 passed, 0 failed** for the whole project; TroyaIndex has 74
(63 unit/fuzz, 8 invariants, 3 fork). Of the older fork tests, `TroyaFeeRouterFork.test_Fork_RecipientSweepDistribute`
can fail at a block with no unswept Pons fees (noted in fee-router-plan.md; untouched here), and repeated runs can hit the
free drpc endpoint's rate limit (HTTP 429), which fails fork tests for that run only.

Management-fee tests (in `test/TroyaIndex.t.sol`): one year = 1% of the supply, previews include the fee due, anyone can
`accrue()`; an idle year then a redeem (the redeemer pays its share of the fee, the recipient's TIDX redeem like others);
a 100-year idle period at 2% (mints exactly 2 x supply, holders keep 1/3, the redeem still works); a rate change in the
middle of a period (old rate up to the execution second, new rate after); maximums (201 bps refused in the constructor
and the timelock, recipient 0 or the vault refused, deposit fee max 2%); nothing accrues before the first deposit; a zero
rate mints nothing; fee shares do not let deposits pass the cap; the inflation defence after a year of fees; a fuzz that
one accrual never mints more than `supply x rate x time / year`. The invariant run adds "the fee recipient never holds more
than the rate allows for the time elapsed" and checks deposits stay within the cap net of fee shares.

- `test/TroyaIndex.t.sol` 63 (the first 53): constructor limits (fee, caps, rules, WETH as asset, EOA asset, duplicates, 9 assets,
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
- `test/TroyaIndexInvariant.t.sol` 8 invariants, 96 runs x 60 calls each, over random deposits (ETH and in kind),
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
- Phase 2 (node, outside forge): `tools/index-keeper-test.mjs` 22 checks (the 6 weight-rule checks: refusals, 48-hour pending, published, announced, activation, cancellation, re-check at activation, keeper refusal; and drift maths in both pool orientations, inside
  the band no trade, all-ETH buys the lightest token held under the cap, a heavy token sold for ETH, the move cap on a
  sale, no cap for a retired asset, token over / token under goes through ETH, trades under the minimum skipped, no trade
  without a median, empty vault / no targets, guards for wrong keeper / paused / cooldown / refused key, team wallets
  recognised, only `pokeAll` and `rebalance` signable, plain-words texts for every op and both alerts, the key file
  generated 0600 and kept across restarts, a damaged key file refused not replaced, a team-wallet key refused).
  `tools/index-fork-test.mjs` on an anvil fork of Robinhood Chain: deploy with the deploy page's exact calldata, hand to
  the Safe and accept, deposits, the server keeper's hourly pokes and rebalances through the real Troya Gate (Kyber off on
  the fork, the process clock following the fork's), cooldown respected, `/api/index` and `/api/index/me`, a proposal
  and a pause turned into alert texts, a zap deposit quoted the way the page does, everyone redeems in kind, the
  management fee minted to the creator: 11/11 passed (27 Nov 2026; the first buy through the real Troya Gate, a failing
  Gate refusing the next buy, the later buys with a stand-in Gate because the real Gate's sell test and tax probe pull more
  fresh state than a fork on a free endpoint serves in time). A rerun after the weight rules and a test-only change to the
  zap cost check could not complete: the official RPC refused connections and drpc throttled the fork.
  `tools/index-ui-test.mjs` 13/13 in headless Chrome on a fork: the deploy page clicked through all four steps with the
  creator wallet (impersonated on the fork only), the Safe accepting, an ETH deposit, a keeper rebalance, the active and
  scheduled weights shown, a zap deposit, a redeem with each asset previewed, the keeper refusing weights that do not add
  up to 100%, no sideways scroll at 390 px. Screenshots at 1280 and 390 px.
- **Static analysis: see the next section.** Halmos was not run.

## 10b. Static analysis

Scanned with **Slither 0.11.6** and **Wake 4.22.2** (all detectors, every impact and confidence level), on 27 Nov 2026.
**Not audited by a third party**: a scanner finds known patterns, not logic errors, and the triage below was written by
the same team that wrote the code.

Raw outputs (with the commands), both passes, and the triage of every finding are in `docs/troya-index-scan/`
(`index-slither.txt`, `index-slither-pass2.txt` / `.json`, `index-wake.txt`, `index-wake-pass2.txt` / `.json`,
`index-wake.toml`, `triage.md`). Pass 1 found, in TroyaIndex*, Slither 6 High / 29 Medium / 38 Low and Wake 2
possible-reentrancy plus 21 warnings. Every High and Medium and every Wake warning was checked against the code:

- **Fixed (cheap hardening, behaviour unchanged):** three locals initialised explicitly; the ERC-20 probe reads in
  `_checkNewAsset` now used (a token with no supply is refused); `PoolManager.settle()`'s return checked against what is
  owed; `_accrue()` no longer returns an unused value; zero-address checks in the swapper constructor; two unused swapper
  constants removed. Two tests added. TroyaIndex runtime 24,209 B (367 B under the limit).
- **False positives, with the guard that covers each:** the "arbitrary send" is the swapper returning the caller's own
  funds; the "weak PRNG" is a ring-buffer index; every "reentrancy" sits behind `nonReentrant` and after the state
  changes, and the vault and zap trust only balances read again after the external call; the strict equalities are
  "nothing / first time" tests on counters or the share supply, which donations cannot move; the remaining ignored
  return values are swap reports the callers deliberately replace with their own balance measurements.

Pass 2 (after the fixes): Slither 6 High / 22 Medium / 37 Low, Wake 3 possible-reentrancy plus 11 warnings, **every one
explained in `triage.md`; none unexplained.**

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
8. **Fee under-charge in the in-kind phase** (section 6), by design. The management fee dilutes every holder by about
   1% a year (max 2%), including the dead shares; it is paid in TIDX to the creator wallet, a hot key on the server: if
   that key is stolen, the thief gets those fee TIDX (not the vault's assets), and the Safe can move the recipient (48 h).
9. **Caps are soft against Sybils** (many wallets) and do not follow transfers; they limit how much can be deposited,
   not who holds TIDX.
10. **Rebasing or fee-on-transfer tokens** must not be listed; deposits measure arrivals, but rebasing tokens could leave
    kept claims under-backed.
11. **Gas**: a withdrawal of an 8-asset basket in which every token burns its full 300k stipend needs ~2.5M gas; the
    holder can always add gas, and nothing is lost if a transfer is skipped.
12. **Arbitrum Orbit specifics**: only `block.timestamp` is used (Arbitrum's `block.number` is L1's); compiled for
    Shanghai like the other Troya contracts on this chain.

13. **Phase 2, the server**: the keeper key is a hot key on the server. A stolen key is bounded by the contract (section
    7, keeper row); a compromised server could also change `index-weights.json` and steer the keeper's trades, still only
    inside the same contract bounds. The public alerts depend on the server running; the events are on chain for anyone
    to watch regardless.
14. **Phase 2, the deploy page** is served by troya.codes: if the site itself were compromised it could serve other
    bytecode. Two checks catch that: the page shows the build's source commit before signing, and the Blockscout
    verification of the deployed addresses (section 9 step 5) fails unless the code on chain is the code in the repository.
    Do not announce before all three addresses show "Verified".

## 12. Rollback / stopping

- Emergency: guardian or owner `pause()`: new deposits and rebalances stop at once; holders keep redeeming.
- Bad keeper: pause, then `propose(Keeper, new)` and `execute` 48 hours later.
- Bad asset: pause rebalances if needed, `propose(RetireAsset)`; after 48 h the keeper sells it (in full allowed, still in
  the band); `prune` once empty.
- Wind-down: pause deposits forever and let every holder redeem in kind. There is no "close" or "migrate" function and
  there will not be one in this contract: a phase-2 vault would be a new contract that holders move to by redeeming here
  and depositing there.

## 13. Owner decisions

Decided on 26 Nov 2026: total cap 2 TIDX, wallet cap 0.5 TIDX; deposit fee 0.5% (hard max 2%) in ETH to TroyaFeeRouter;
management fee 1% a year (hard max 2%) in TIDX to the creator wallet; basket ETH + USDG + SPY + NVDA + a small $TROYA
weight (section 8); a new dedicated keeper wallet (generated on the server); move cap 20%, cooldown 4 h; slippage bands
100 / 200 / 600 bps; no guardian for now; owner = the team Safe (handed over right after deploy).

Still open: when to deploy; whether to get an outside review first (the Slither and Wake scans are done, section 10b); switching on the
public alerts (`INDEX_ALERTS=1`, needs the owner's go-ahead like every automatic post); any announcement (owner's
go-ahead typed in chat, X and TG together).

## 14. Phase 2: keeper, public API, app page, deploy page

### Server (`server/index-keeper.mjs`, registered in `server/api.mjs`)

| env | default | what |
|---|---|---|
| `INDEX_ADDRESS` | unset | the vault; until it is set the API shows "opening soon" and nothing runs |
| `INDEX_ZAP_ADDRESS` | unset | the zap (the app's deposit path once the vault holds tokens) |
| `INDEX_DEPLOY_BLOCK` | unset | where the event scan starts (the deploy page prints it) |
| `INDEX_KEEPER` | off | `1` runs the keeper every `INDEX_KEEPER_EVERY_MIN` (10) minutes |
| `INDEX_MIN_OUT_BUFFER_BPS` | 100 | minOut = the simulated output minus this |
| `INDEX_ALERTS` / `INDEX_TG_CHAT` | off / unset | public Telegram alert on every `ChangeProposed` and `Paused` (uses `TELEGRAM_BOT_TOKEN`) |
| `INDEX_TEAM_WALLETS` | unset | extra addresses the keeper key must never be |
| `INDEX_OFF` | unset | `1` stops every timer (tests) |

Data files (in `DATA_DIR`): `index-keeper.key` (32-byte AES key, mode 0600) and `index-keeper-wallet.json` (the keeper's
private key encrypted with it, plus its address, mode 0600), generated on first start as `gas.mjs` does for the gas
sponsor; only the address ever leaves the module. A damaged wallet file is refused, never silently replaced (a new key
would orphan the vault's keeper). `index-keeper.json`: the event scan position, the events, the keeper's log and last
rebalance. `index-weights.json`: `{ active: { targets, driftPct, minTradeEth, since }, pending: { targets, …, scheduledAt,
activatesAt, note } | null, history }` (targets by lowercased address; absent file = the launch weights ETH 35, USDG 25,
SPY 20, NVDA 15, $TROYA 5, drift 5 points, minimum trade 0.005 ETH). Change it only through the scheduling route.

**Target weights never change silently** (Xivor's request, approved by the owner, 26 Nov 2026). The active weights and
any scheduled change are published in `GET /api/index` (`weights.active`, `weights.pending` with `scheduledAt` and
`activatesAt`), in `GET /api/index/weights` and on `#/vault`. A change (`POST /api/index/weights`, admins only:
`{ targets, driftPct?, minTradeEth?, note? }`) is written as pending with an activation time at least 48 hours later
(a shorter delay is raised to 48 h); the keeper keeps using the active weights until then; `POST /api/index/weights/cancel`
drops it before activation. Scheduling, activation and cancellation are posted on the same public alert path as
`ChangeProposed` (`INDEX_ALERTS=1`). Weights that name an asset not on the vault's allow-list (`assets()` on chain), or that
do not add up to exactly 100%, or with a negative or repeated entry, are refused when scheduled, re-checked at activation
(a change naming an asset removed meanwhile is dropped and logged), and the keeper refuses to trade on an active set that
fails the same check. These are server rules, not contract rules: the vault's own limits bind every trade regardless.

The keeper, each pass: refuses if its key is a team wallet (creator, Safe, both Safe signers, team, dev-side and owner
wallets, gas sponsor, TroyaFeeRouter, admins, the stored creator key's address, `INDEX_TEAM_WALLETS`), if it is not the
vault's `keeper()`, or if it holds under 0.0003 ETH. It sends `pokeAll()` when a venue has no read for the current hour.
Then, unless rebalances are paused or the cooldown runs, it values every holding in ETH at the venues' 24-hour medians,
and if one weight is more than `driftPct` points off target it plans one trade through ETH (buy the lightest token with
ETH, or sell the heaviest token for ETH), sized to close the gap and held one wei under the move cap. A buy goes through
Troya Gate (`gateCheck`) and is dropped if the Gate fails. It simulates the rebalance with `eth_call`, sets minOut to the
simulated output minus the buffer, simulates again, estimates gas, signs with a fresh nonce, and waits for the receipt. It
signs only `pokeAll()` and `rebalance()` on the vault, with no value; anything else is refused before signing.

Routes: `GET /api/index/weights`, `POST /api/index/weights` and `POST /api/index/weights/cancel` (admins, see above),
`GET /api/index` (holdings with amounts, ETH and USD value, weights vs targets, NAV per TIDX, caps used, both fees,
keeper, owner and pending owner, last rebalance tx, pending timelock changes in plain words with their times, recent events,
addresses with Blockscout links, the "not audited" note), `GET /api/index/me/:wallet` (shares, what a redeem pays now per
asset, what is kept for the wallet), `GET /api/index/keeper` (the keeper's address, balance, on/off). USD prices: ETH from
`market.mjs getEthUsd`, tokens from `market.mjs getRobinhoodToken`, falling back to the vault's own pool price x ETH.

### App (`public/agent/desk/index-vault.js`, route `#/vault`, Portfolio group)

Deposit (ETH while the vault holds only ETH, quoted with `previewDepositEth`, minShares 0.5% under; afterwards through the
zap: shares aimed 3% under what the ETH buys at the vault's value per TIDX, the zap simulated with `eth_call` for the quoted
cost, msg.value = the most the user pays, the rest refunded), redeem any amount (each asset previewed with `previewRedeem`
first), claimOwed, holdings, caps, fees, the timelock queue and the risk note. Every transaction is signed in the user's
own wallet through `wallet.js`.

### Owner deploy page (`#/vault/deploy`)

Section 9. It runs only with the creator wallet connected, builds the calldata with `index-deploy-lib.js` from
`troya-index.json`, fetches the keeper from `/api/index/keeper` (and stops if the server reports it refused), checks every
new contract has code, keeps the run in the browser, then prints the Safe's `acceptOwnership` data, the Blockscout verify
commands and the server settings.

