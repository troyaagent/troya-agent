// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Troya Stake
/// @notice Stake $TROYA, unstake with a 3-day wait, then withdraw. Each wallet's stake and the time it has been staked
///         are on chain, so Troya can read a tier from them. Topping up moves the start time forward in proportion to
///         the coins added (a weighted average), so a big top-up today does not inherit a small stake's age.
///         Optional ETH reward: anyone can send ETH with notifyReward(), and it is shared pro rata among the coins
///         staked at that moment (not the coins already waiting to leave). If nobody ever calls it, nothing changes.
/// @dev No owner, no admin, no pause, no upgrade, no fee, no rescue. Nothing in here can move a staker's coins except
///      that staker. Fee-on-transfer coins are booked at what the contract actually received.
///      Reward maths (Synthetix style): accRewardPerToken grows by msg.value * PRECISION / totalStaked on every notify,
///      each account keeps the accumulator value it was last settled at, and accrues amount * (acc - snapshot) / PRECISION.
///      The rounding remainder of each notify is carried into the next one, so no ETH is lost and none is promised twice.
contract TroyaStake is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice The wait between asking to unstake and being able to withdraw.
    uint256 public constant COOLDOWN = 3 days;
    /// @dev Scale of the reward accumulator. a * (acc - snapshot) <= total ETH ever notified * PRECISION, far below 2^256.
    uint256 private constant PRECISION = 1e27;

    struct Account {
        uint128 amount;     // coins staked (these count for tiers and earn rewards)
        uint64 since;       // weighted start time of the stake; 0 when nothing is staked
        uint64 unlockAt;    // when the coins waiting to leave can be withdrawn; 0 when none wait
        uint128 pending;    // coins waiting out the cooldown (no tier, no reward)
        uint128 owed;       // ETH settled to this account and not yet claimed
        uint256 accPaid;    // accRewardPerToken this account was last settled at
    }

    /// @notice The staked coin ($TROYA). Fixed at deploy.
    IERC20 public immutable token;

    mapping(address => Account) private _accounts;
    /// @notice Coins staked across all accounts (sum of every account's amount).
    uint256 public totalStaked;
    /// @notice Coins waiting out the cooldown across all accounts.
    uint256 public totalPending;
    /// @notice Reward ETH per staked coin, scaled by 1e27, since deploy.
    uint256 public accRewardPerToken;
    /// @notice ETH sent through notifyReward(), ever.
    uint256 public totalRewarded;
    /// @notice ETH claimed by stakers, ever.
    uint256 public totalClaimed;
    /// @notice The rounding remainder of the last notify, added to the next one.
    uint256 public rewardCarry;

    event Staked(address indexed account, uint256 amount, uint256 staked, uint64 since);
    event UnstakeRequested(address indexed account, uint256 amount, uint256 staked, uint256 pending, uint64 unlockAt);
    event UnstakeCancelled(address indexed account, uint256 amount, uint256 staked, uint64 since);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardNotified(address indexed from, uint256 amount, uint256 totalStaked, uint256 accRewardPerToken);
    event RewardClaimed(address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error TooMuch(uint256 asked, uint256 staked);
    error NothingPending();
    error CoolingDown(uint64 unlockAt);
    error NoStakers();
    error NothingToClaim();
    error EthTransferFailed();

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
    }

    /* ------------------------------------------------------------------ */
    /* staking                                                             */
    /* ------------------------------------------------------------------ */

    /// @notice Stake `amount` coins (approve this contract first). Adds to any stake you already have.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender];
        _settle(a);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = token.balanceOf(address(this)) - before;
        if (got == 0) revert ZeroAmount();
        _add(a, got);
        totalStaked += got;
        emit Staked(msg.sender, got, a.amount, a.since);
    }

    /// @notice Start unstaking `amount` coins: they stop counting and stop earning now, and can be withdrawn after the
    ///         3-day cooldown. Asking again while coins already wait adds to them and restarts the wait for all of them.
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender];
        if (amount > a.amount) revert TooMuch(amount, a.amount);
        _settle(a);
        a.amount -= uint128(amount);                          // amount <= a.amount, a uint128
        if (a.amount == 0) a.since = 0;                       // the coins that stay keep their age; none left, no age
        a.pending += amount.toUint128();
        a.unlockAt = (block.timestamp + COOLDOWN).toUint64();
        totalStaked -= amount;
        totalPending += amount;
        emit UnstakeRequested(msg.sender, amount, a.amount, a.pending, a.unlockAt);
    }

    /// @notice Put the coins waiting out the cooldown back into your stake (counted as a top-up made now).
    function cancelUnstake() external nonReentrant {
        Account storage a = _accounts[msg.sender];
        uint256 p = a.pending;
        if (p == 0) revert NothingPending();
        _settle(a);
        a.pending = 0;
        a.unlockAt = 0;
        totalPending -= p;
        _add(a, p);
        totalStaked += p;
        emit UnstakeCancelled(msg.sender, p, a.amount, a.since);
    }

    /// @notice Withdraw every coin whose cooldown has ended, to your wallet.
    function withdraw() external nonReentrant {
        Account storage a = _accounts[msg.sender];
        uint256 p = a.pending;
        if (p == 0) revert NothingPending();
        if (block.timestamp < a.unlockAt) revert CoolingDown(a.unlockAt);
        a.pending = 0;
        a.unlockAt = 0;
        totalPending -= p;
        token.safeTransfer(msg.sender, p);
        emit Withdrawn(msg.sender, p);
    }

    /* ------------------------------------------------------------------ */
    /* optional ETH reward                                                 */
    /* ------------------------------------------------------------------ */

    /// @notice Share the ETH sent with this call among everyone staked right now, pro rata to their stake.
    ///         Anyone can call it; it reverts when nothing is staked, so ETH can never be stranded here.
    function notifyReward() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        uint256 t = totalStaked;
        if (t == 0) revert NoStakers();
        uint256 pot = msg.value + rewardCarry;
        uint256 inc = Math.mulDiv(pot, PRECISION, t);
        // what the accumulator now promises, rounded up so the stakers together can never be owed more than was sent
        uint256 promised = Math.mulDiv(inc, t, PRECISION, Math.Rounding.Ceil);
        rewardCarry = pot - promised;
        accRewardPerToken += inc;
        totalRewarded += msg.value;
        emit RewardNotified(msg.sender, msg.value, t, accRewardPerToken);
    }

    /// @notice Send your settled and accrued reward ETH to your wallet.
    function claim() external nonReentrant {
        Account storage a = _accounts[msg.sender];
        _settle(a);
        uint256 r = a.owed;
        if (r == 0) revert NothingToClaim();
        a.owed = 0;
        totalClaimed += r;
        emit RewardClaimed(msg.sender, r);
        (bool ok,) = payable(msg.sender).call{value: r}("");
        if (!ok) revert EthTransferFailed();
    }

    /* ------------------------------------------------------------------ */
    /* views                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice One account: coins staked, weighted start time, coins waiting, when they unlock, reward ETH claimable.
    function stakeOf(address account) external view returns (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt, uint256 earnedEth) {
        Account storage a = _accounts[account];
        return (a.amount, a.since, a.pending, a.unlockAt, _earned(a));
    }

    /// @notice Reward ETH `account` can claim now.
    function earned(address account) external view returns (uint256) {
        return _earned(_accounts[account]);
    }

    /// @notice Seconds `account`'s current stake has been staked (weighted), 0 when nothing is staked.
    function stakedFor(address account) external view returns (uint256) {
        uint64 s = _accounts[account].since;
        return s == 0 ? 0 : block.timestamp - s;
    }

    /* ------------------------------------------------------------------ */
    /* internals                                                           */
    /* ------------------------------------------------------------------ */

    function _earned(Account storage a) private view returns (uint256) {
        return a.owed + Math.mulDiv(a.amount, accRewardPerToken - a.accPaid, PRECISION);
    }

    function _settle(Account storage a) private {
        uint256 acc = accRewardPerToken;
        if (a.accPaid == acc) return;
        if (a.amount != 0) a.owed = (a.owed + Math.mulDiv(a.amount, acc - a.accPaid, PRECISION)).toUint128();
        a.accPaid = acc;
    }

    /// @dev adds `got` coins to the stake, moving the start time to the weighted average of the old stake and now
    function _add(Account storage a, uint256 got) private {
        uint256 old = a.amount;
        uint256 total = old + got;
        uint256 since = old == 0 ? block.timestamp : (old * a.since + got * block.timestamp) / total;
        a.amount = total.toUint128();
        a.since = since.toUint64();
    }
}
