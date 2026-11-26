# TroyaIndex static analysis: triage

Scanners: Slither 0.11.6 and Wake 4.22.2 (all detectors, min impact info, min confidence low), solc 0.8.24, on a scratch
copy of `contracts/` (`tools/scan/.venv`). Scope: `src/TroyaIndex.sol`, `src/TroyaIndexSwapper.sol`, `src/TroyaIndexZap.sol`.
Pass 1 = the code handed over after phase 2 (run by the coordinator, 27 Nov 2026); pass 2 = after the fixes below.
Line numbers are those of the current source (pass 2). **This is a scanner triage, not an audit.**

## Counts (findings in TroyaIndex*)

| scanner / level | pass 1 | pass 2 | unexplained after pass 2 |
|---|---|---|---|
| Slither High | 6 (arbitrary-send-eth 1, weak-prng 1, reentrancy-balance 4) | 6 (same) | 0 |
| Slither Medium | 29 (incorrect-equality 13, uninitialized-local 3, unused-return 13) | 22 (incorrect-equality 13, unused-return 9) | 0 |
| Slither Low | 38 (calls-loop 22, reentrancy-benign 2, timestamp 13, missing-zero-check 1) | 37 (missing-zero-check gone) | 0 |
| Slither Informational / Optimization | 23 / 2 | 19 / 2 (unused-state gone) | 0 |
| Wake HIGH impact (possible reentrancy) | 2 (deposit refund H/M; swapper `_swap` H/L) | 3 (the swapper `_send` note moved from WARNING to H/M) | 0 |
| Wake WARNING unchecked return value | 17 | 8 | 0 |
| Wake WARNING other | 4 (reentrancy `_send` 1, missing return paths 1, address.balance 2) | 3 (missing return paths 1, address.balance 2) | 0 |

## Fixes made (pass 1 → pass 2)

| fix | where | why |
|---|---|---|
| Locals initialised explicitly | `TroyaIndex._trade` `uint256 value = 0` (431), `_required` `bool backed = false` (648), `TroyaIndexZap.zap` `bool zeroForOne = false` (59) | Slither uninitialized-local; the defaults were already intended, now stated |
| ERC-20 probe return values used | `TroyaIndex._checkNewAsset` (852): `totalSupply()` must be > 0 and `balanceOf(vault)` <= supply, else `BadAsset` | Slither unused-return / Wake unchecked-return; also refuses a token with no supply |
| `PoolManager.settle()` return checked | `TroyaIndexSwapper.unlockCallback` (228): `paid != owed` → `NotSettled` | Slither unused-return / Wake unchecked-return (2); the PoolManager's own unlock check already enforced it |
| `_accrue()` returns nothing; `accrue()` reports the minted amount from the supply change | `TroyaIndex` 468-473, 674 | Wake unchecked-return on the 4 internal `_accrue()` calls |
| Zero-address checks in the swapper constructor | `TroyaIndexSwapper` 112 (`ZeroAddress`) | Slither missing-zero-check (ponsHook); also weth, factory, PoolManager |
| Unused constants removed | `TroyaIndexSwapper` `KIND_V4`, `MIN_SQRT_PRICE` | Slither unused-state (informational) |

Cost: TroyaIndex runtime 24,139 → 24,209 B (367 B under the 24,576 B limit); swapper 6,939 → 6,976 B; zap unchanged.
Tests added: zero-supply token refused; swapper constructor zero addresses refused. `forge test`: 197 of 198 passed
(the one failure is the existing `TroyaFeeRouterFork.test_Fork_RecipientSweepDistribute`, which depends on unswept Pons
fees at the fork block; all 75 TroyaIndex tests passed, fork tests included).

## Triage of every High and Medium, and every Wake warning

| # | finding | verdict | reason (lines, existing guard) |
|---|---|---|---|
| S-H1 | arbitrary-send-eth: `TroyaIndexSwapper._send` sends ETH to `msg.sender` (149) | false positive | `msg.sender` is the caller who funded this very swap; the swapper holds nothing between transactions, so it only returns the caller's own ETH (and strays nobody owns); `swap` is `nonReentrant` (126-129) |
| S-H2 | weak-prng: `hour % OBSERVATIONS` in `TroyaIndex._observe` (712) | false positive | a ring-buffer slot index (24 hourly reads), not randomness |
| S-H3 | reentrancy-balance: `TroyaIndex._trade` reads `inBefore` (428), calls the swapper (434), compares `spent > amountIn` (439) | false positive | `spent` and `received` come from balances read again after the call (435-436); `rebalance` is `nonReentrant` (399); the swapper is an immutable contract that sends back everything in the same call; the vault trusts only its own balance deltas |
| S-H4 | reentrancy-balance: `TroyaIndex.rebalance` uses `received` after `_trade` (414, 417) | false positive | same as S-H3: `received` is a post-call balance delta, checked against the median floor and `minOut` |
| S-H5 | reentrancy-balance: `TroyaIndexZap.zap` reads `have` (56) before `swapper.swap` (67) | false positive | `have` is read again after the swap (68) before the `have < need` check (69); `zap` is `nonReentrant` (46); the zap holds nothing between transactions |
| S-H6 | reentrancy-balance: `TroyaIndexZap.zap` (68-69) | false positive | duplicate report of S-H5 for the post-swap read |
| S-M1..13 | incorrect-equality: `supply == 0` (627, 645, 364), `ethHeld == 0` (636), `shares == 0` (638), `hour == lastObservedHour` (709), `supply == 0 \|\| mgmtFeeBps == 0` (665), `h == 0` (652), `totalSupply() == 0` (272), `lastRebalanceAt == 0` (602), `received == 0` (417), `a == 0` (350), swapper `amount == 0` (147) | false positive (all 13) | every one is a "nothing / first time" test on a counter, a computed amount or the share supply, which donations cannot move (the supply only changes by mint/burn). The two that read balances (`ethHeld`, `h`, through `_holdings`) can only be pushed away from zero by a donation, which enables a deposit path, never blocks a withdrawal; rounding is always in the vault's favour (`Math.Rounding.Ceil` on deposits, floor on redeems). No strict equality guards an invariant |
| S-M14..16 | uninitialized-local: `value`, `backed`, `zeroForOne` | fixed (cheap) | initialised explicitly (see fixes); behaviour unchanged |
| S-M17 | unused-return: `swapper.swap` in `TroyaIndex._trade` (434) | false positive, by design | the vault never trusts the swapper's report: it measures its own balances before and after (428-439) |
| S-M18-19 | unused-return: `IERC20.balanceOf` / `totalSupply` probes in `_checkNewAsset` | fixed | both values are now used (852) |
| S-M20-21 | unused-return: v3 `pool.swap` (166) | false positive | the swapper measures balances (`_bal`, 133-137); the pool is paid only through the callback, which is limited to `_maxIn` and to the expected token |
| S-M22-23 | unused-return: `poolManager.unlock` (173) | false positive | `unlockCallback` returns empty bytes; settlement is enforced inside the callback and by the PoolManager's unlock |
| S-M24-25 | unused-return: `poolManager.settle` (2) | fixed | `paid != owed` → `NotSettled` (228) |
| S-M26 | unused-return: `slot0()` partial tuple in `_spot` (243) | false positive | only `sqrtPriceX96` and `unlocked` are needed |
| S-M27 | unused-return: `vault.previewDeposit` fee in `TroyaIndexZap.zap` (52) | false positive | the fee is paid inside `vault.deposit` from the same msg.value; the zap refunds whatever is left (75-85) |
| S-M28 | unused-return: `swapper.swap` in `zap` (67) | false positive | the zap re-reads its token balance (68) and requires `have >= need` (69) |
| S-M29 | unused-return: `vault.deposit` in `zap` (74) | false positive | the zap measures what came back (75) and refunds it; the vault's own checks decide the deposit |
| W-1 | [HIGH][MEDIUM] possible reentrancy in `TroyaIndex.deposit`: refund `msg.sender.call{value: spare}` (317), exploitable from the zap | false positive | the refund is the last statement: tokens pulled, fee booked, shares minted before it (checks-effects-interactions); `deposit` is `nonReentrant` (289), so a re-entering caller is refused; the refund goes only to the caller who overpaid |
| W-2 | [HIGH][LOW] possible reentrancy in `TroyaIndexSwapper._swap`: guard slots cleared after `pool.swap` (166-168, 175) | false positive | `swap` is `nonReentrant`; the v3 callback answers only `_v3Pool` while it is set (184-185) and pays at most `_maxIn` in the expected token; the v4 callback answers only the PoolManager while `_maxIn != 0` (205); clearing after the call is the intended pattern (no transient storage on Shanghai) |
| W-3 | [HIGH][MEDIUM] (pass 1: WARNING) possible reentrancy in `TroyaIndexSwapper._send` (149) | false positive | last calls of `swap`, after all accounting; `swap` is `nonReentrant`; the swapper keeps no state a re-entry could use |
| W-4..11 | [WARNING][HIGH] unchecked return value (8 left): `_observe` in `rebalance` (408) and `pokeAll` (462), `_buildVenue(p, false)` at propose (770), `swapper.swap` (434), v3 `pool.swap` (166), `poolManager.unlock` (173), zap `swapper.swap` (67), zap `vault.deposit` (74) | false positive | `_observe`'s bool only says whether a read was recorded; a missing read is caught by `n < MIN_OBSERVATIONS` and the spot check (409-411). `_buildVenue` at propose time is validation only (it reverts when invalid). The swap/unlock/deposit cases: see S-M17, S-M20-23, S-M28-29 |
| W-(fixed) | [WARNING][HIGH] unchecked return on the 4 `_accrue()` calls, the 2 ERC-20 probes, the 2 `settle()` calls | fixed | see fixes |
| W-12 | [WARNING][MEDIUM] not all paths assign return values: `medianSqrtPrice` (580) | false positive | the empty case returns `(0, 0)` explicitly; otherwise `n` is assigned in the loop and `median` on the last line |
| W-13-14 | [WARNING][LOW] use of `address.balance` in `TroyaIndexZap.zap` (49, 75) | false positive, by design | the zap spends and refunds only `balance - start`, where `start` excludes any ETH that was there before the call; a donation during the call can only add ETH, which is refunded to the caller |

## Low and informational (summary)

- **calls-loop (22)**: external calls inside loops over the asset list (at most 8) and venue list (at most 16), all to
  listed tokens and canonical pools; a token that reverts in `redeem` is skipped and kept as a claim (the loop itself
  cannot be blocked: each transfer is a low-level call with a 300k gas cap). Accepted.
- **reentrancy-benign (2)**: the swapper's guard slots written after the pool call (see W-2). Accepted.
- **timestamp (13)**: the timelock (48 h), execution window, cooldown, hourly observations and the management-fee accrual
  use `block.timestamp`; a sequencer can shift it by seconds, which is immaterial at hour and day scales. Accepted.
- **Informational**: assembly (the gas-capped transfer in `_trySend`, deliberate), pragma, cyclomatic complexity (the
  timelock dispatcher), low-level calls (deliberate: refunds, `_trySend`, swapper returns), missing-inheritance (mocks /
  callback interfaces), unindexed event addresses (events kept small for bytecode size), cache-array-length.
