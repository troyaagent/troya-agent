// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Troya Oath Vault (V7 F32, tier 3)
/// @notice A dev's Oath enforced in code. The dev locks coins here with two terms: nothing leaves before the cliff, and after
///         it at most `ratePerDay` coins unlock per day (linear, by the second). Only the lock's beneficiary can withdraw,
///         only what has unlocked. Terms can be made stricter (a later cliff, a lower rate) and never looser.
/// @dev No owner, no admin, no pause, no upgrade, no fees, no rescue. Troya cannot touch a single coin in here.
///      Fee-on-transfer coins are booked at what the vault actually received.
contract TroyaOathVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        address token;
        address beneficiary;
        uint128 amount;       // coins received into the lock
        uint128 withdrawn;    // coins taken out so far
        uint64 cliff;         // unix time before which nothing unlocks
        uint128 ratePerDay;   // coins that unlock per day after the cliff
    }

    /// @notice Every lock ever made; ids start at 1.
    mapping(uint256 => Lock) public locks;
    uint256 public lockCount;

    event Locked(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 amount, uint64 cliff, uint256 ratePerDay);
    event Withdrawn(uint256 indexed id, address indexed to, uint256 amount);
    event Tightened(uint256 indexed id, uint64 cliff, uint256 ratePerDay);

    error ZeroAmount();
    error ZeroRate();
    error NotBeneficiary();
    error TooMuch(uint256 asked, uint256 available);
    error Looser();
    error Overflow();

    /// @notice Lock `amount` of `token` for `beneficiary`: nothing before `cliff`, then `ratePerDay` coins a day.
    function lock(address token, uint256 amount, address beneficiary, uint64 cliff, uint256 ratePerDay) external nonReentrant returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (ratePerDay == 0) revert ZeroRate();
        if (ratePerDay > type(uint128).max) revert Overflow();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (got == 0) revert ZeroAmount();
        if (got > type(uint128).max) revert Overflow();
        id = ++lockCount;
        locks[id] = Lock({ token: token, beneficiary: beneficiary, amount: uint128(got), withdrawn: 0, cliff: cliff, ratePerDay: uint128(ratePerDay) });
        emit Locked(id, token, beneficiary, got, cliff, ratePerDay);
    }

    /// @notice Coins of lock `id` unlocked by time `t` (withdrawn ones included).
    function unlockedAt(uint256 id, uint256 t) public view returns (uint256) {
        Lock storage l = locks[id];
        if (t <= l.cliff) return 0;
        uint256 u = (uint256(l.ratePerDay) * (t - l.cliff)) / 1 days;
        return u > l.amount ? l.amount : u;
    }

    /// @notice Coins of lock `id` the beneficiary can take out now.
    function available(uint256 id) public view returns (uint256) {
        uint256 u = unlockedAt(id, block.timestamp);
        uint256 w = locks[id].withdrawn;
        return u > w ? u - w : 0;      // a tightened lock can sit below what was already taken until time catches up
    }

    /// @notice Take `amount` unlocked coins out of lock `id` to `to`. Beneficiary only.
    function withdraw(uint256 id, uint256 amount, address to) external nonReentrant {
        Lock storage l = locks[id];
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        uint256 a = available(id);
        if (amount == 0) revert ZeroAmount();
        if (amount > a) revert TooMuch(amount, a);
        l.withdrawn += uint128(amount);
        IERC20(l.token).safeTransfer(to, amount);
        emit Withdrawn(id, to, amount);
    }

    /// @notice Make lock `id` stricter: a cliff no earlier and a rate no higher than now. Beneficiary only.
    function tighten(uint256 id, uint64 cliff, uint256 ratePerDay) external {
        Lock storage l = locks[id];
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (cliff < l.cliff || ratePerDay > l.ratePerDay || ratePerDay == 0) revert Looser();
        // stricter terms apply from the cliff on, so coins unlocked but not yet taken can lock again: that is the point
        l.cliff = cliff;
        l.ratePerDay = uint128(ratePerDay);
        emit Tightened(id, cliff, ratePerDay);
    }
}
