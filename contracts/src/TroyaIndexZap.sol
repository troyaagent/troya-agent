// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TroyaIndexSwapper, Venue} from "./TroyaIndexSwapper.sol";
import {TroyaIndex} from "./TroyaIndex.sol";

/// @title Troya Index zap
/// @notice Deposit into TroyaIndex with ETH only, once the vault holds tokens. zap() reads what deposit(shares) needs
/// right now, buys exactly that much of each token with ETH in one of the vault's own listed pools (ETH <-> token, through
/// the vault's swapper), makes the in-kind deposit for `receiver`, and refunds every wei of ETH (and any token) left over
/// to the caller. The caller bears the pools' prices and fees; msg.value is the most it can cost.
/// @dev Holds nothing between transactions, has no owner and no approvals from anyone: the only funds it ever touches
/// are the msg.value of the call in progress.
contract TroyaIndexZap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint160 private constant MIN_SQRT_PRICE = 4295128739;

    TroyaIndex public immutable vault;
    TroyaIndexSwapper public immutable swapper;

    error WrongLength();
    error BadVenue();
    error ReceivedLess(address asset, uint256 needed, uint256 received);
    error TransferFailed();

    constructor(TroyaIndex vault_) {
        vault = vault_;
        swapper = vault_.swapper();
    }

    /// @notice The swapper's change and the vault's spare-ETH refund land here, inside a zap.
    receive() external payable {}

    /// @notice Mint exactly `shares` TIDX to `receiver` with ETH: msg.value is the budget (deposit ETH + fee + the ETH the
    /// token buys cost); everything unspent is returned to the caller.
    /// @param venueIds One per asset in the order of vault.assets(): the vault venue (an ETH <-> that token pool) to buy
    /// it in. Index 0 (ETH) and assets the deposit needs none of are ignored.
    /// @return ethSpent What the deposit cost in ETH, all in.
    function zap(uint256 shares, address receiver, uint256[] calldata venueIds)
        external
        payable
        nonReentrant
        returns (uint256 ethSpent)
    {
        uint256 start = address(this).balance - msg.value;
        address[] memory list = vault.assets();
        if (venueIds.length != list.length) revert WrongLength();
        (uint256[] memory need,) = vault.previewDeposit(shares);
        for (uint256 i = 1; i < list.length; ++i) {
            if (need[i] == 0) continue;
            IERC20 t = IERC20(list[i]);
            uint256 have = t.balanceOf(address(this));
            if (have < need[i]) {
                Venue memory v = vault.getVenue(venueIds[i]);
                bool zeroForOne;
                if (!v.active) revert BadVenue();
                if (v.asset0 == address(0) && v.asset1 == list[i]) zeroForOne = true;
                else if (v.asset1 == address(0) && v.asset0 == list[i]) zeroForOne = false;
                else revert BadVenue();
                // buy exactly what is missing with at most the ETH left in this call; the swapper returns the change
                uint256 budget = address(this).balance - start;
                uint160 limit = zeroForOne ? MIN_SQRT_PRICE + 1 : _upLimit(vault.spotSqrtPrice(venueIds[i]));
                swapper.swap{value: budget}(v, zeroForOne, false, need[i] - have, budget, limit);
                have = t.balanceOf(address(this));
                if (have < need[i]) revert ReceivedLess(list[i], need[i], have);
            }
            t.forceApprove(address(vault), need[i]);
        }
        // the vault takes its ETH part + fee from this value and refunds the rest here
        vault.deposit{value: address(this).balance - start}(shares, receiver, need);
        uint256 left = address(this).balance - start;
        ethSpent = msg.value - left;
        for (uint256 i = 1; i < list.length; ++i) {
            IERC20 t = IERC20(list[i]);
            if (need[i] != 0) t.forceApprove(address(vault), 0);
            uint256 b = t.balanceOf(address(this));
            if (b != 0) t.safeTransfer(msg.sender, b);
        }
        if (left != 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @dev A rising-price limit that never binds in practice (the budget is msg.value): four times the current sqrt
    /// price (16x the price), kept under 2^159, below TickMath's maximum.
    function _upLimit(uint160 s) private pure returns (uint160) {
        if (s == 0 || s > type(uint160).max / 8) revert BadVenue();
        return s * 4;
    }
}
