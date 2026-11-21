// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaStake} from "../src/TroyaStake.sol";

/// Against Robinhood Chain (4663) with the real $TROYA token, on a local in-memory fork: nothing is sent to the chain.
/// Coins for the test wallets come from the Uniswap v4 PoolManager (it holds the pool's $TROYA) by impersonation.
/// Skipped, not failed, when the RPC cannot be reached.
contract TroyaStakeForkTest is Test {
    address constant TROYA = 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    IERC20 troya = IERC20(TROYA);
    TroyaStake s;
    address alice = makeAddr("fork-alice");
    address bob = makeAddr("fork-bob");

    function _fork() internal returns (bool) {
        try vm.createSelectFork("robinhood") {}
        catch {
            vm.skip(true, "Robinhood Chain RPC not reachable: fork test skipped");
            return false;
        }
        assertEq(block.chainid, 4663, "not Robinhood Chain");
        uint256 g = gasleft();
        s = new TroyaStake(TROYA);
        console2.log("deploy gas (execution only, L1 data fee not included)", g - gasleft());
        return true;
    }

    function _fund(address who, uint256 amt) internal {
        vm.prank(POOL_MANAGER);
        troya.transfer(who, amt);
        vm.prank(who);
        troya.approve(address(s), type(uint256).max);
    }

    function test_Fork_RealTroyaFullCycle() public {
        if (!_fork()) return;
        uint256 supply = troya.totalSupply();
        console2.log("TROYA total supply", supply / 1e18);
        console2.log("bronze 0.01%", supply / 10_000 / 1e18, "silver 0.1%", supply / 1_000 / 1e18);
        console2.log("gold 0.5%", supply / 200 / 1e18);

        uint256 aAmt = supply / 1_000;          // silver-sized
        uint256 bAmt = supply / 10_000;         // bronze-sized
        _fund(alice, aAmt * 2);
        _fund(bob, bAmt);

        // the real coin books exactly what was sent (no transfer tax on wallet-to-contract moves)
        uint256 g = gasleft();
        vm.prank(alice); s.stake(aAmt);
        console2.log("gas: first stake", g - gasleft());
        (uint256 amount, uint64 since,,,) = s.stakeOf(alice);
        assertEq(amount, aAmt, "TROYA is not fee-on-transfer into the stake");
        assertEq(troya.balanceOf(address(s)), aAmt);
        assertEq(since, block.timestamp);

        vm.prank(bob); s.stake(bAmt);

        // top-up 10 days later: start moves halfway
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 10 days);
        g = gasleft();
        vm.prank(alice); s.stake(aAmt);
        console2.log("gas: top-up", g - gasleft());
        (amount, since,,,) = s.stakeOf(alice);
        assertEq(amount, aAmt * 2);
        assertEq(since, t0 + 5 days);

        // a weekly ETH share, if it is ever switched on
        vm.deal(address(this), 1 ether);
        g = gasleft();
        s.notifyReward{value: 0.21 ether}();
        console2.log("gas: notifyReward", g - gasleft());
        uint256 total = aAmt * 2 + bAmt;
        assertApproxEqAbs(s.earned(alice), (0.21 ether * aAmt * 2) / total, 2);
        assertApproxEqAbs(s.earned(bob), (0.21 ether * bAmt) / total, 2);

        uint256 e0 = alice.balance;
        g = gasleft();
        vm.prank(alice); s.claim();
        console2.log("gas: claim", g - gasleft());
        assertGt(alice.balance, e0);

        // unstake half, wait out the cooldown, withdraw
        g = gasleft();
        vm.prank(alice); s.requestUnstake(aAmt);
        console2.log("gas: requestUnstake", g - gasleft());
        vm.warp(block.timestamp + 3 days - 1);
        vm.prank(alice); vm.expectRevert();
        s.withdraw();
        vm.warp(block.timestamp + 1);
        uint256 b0 = troya.balanceOf(alice);
        g = gasleft();
        vm.prank(alice); s.withdraw();
        console2.log("gas: withdraw", g - gasleft());
        assertEq(troya.balanceOf(alice) - b0, aAmt, "the whole amount comes back");
        assertEq(troya.balanceOf(address(s)), s.totalStaked() + s.totalPending());
        assertEq(s.totalStaked(), aAmt + bAmt);
    }
}
