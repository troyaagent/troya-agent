// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TroyaStake} from "../src/TroyaStake.sol";

contract InvCoin is ERC20 {
    constructor() ERC20("Coin", "COIN") { _mint(msg.sender, 1_000_000_000 ether); }
}

/// random stakes, top-ups, unstakes, cancels, withdraws, notifies and claims across five wallets
contract StakeHandler is Test {
    TroyaStake public s;
    InvCoin public coin;
    address[] public actors;
    uint256 public ghostClaimed;
    uint256 public ghostWithdrawn;

    constructor(TroyaStake s_, InvCoin c_) {
        s = s_; coin = c_;
        for (uint256 i; i < 5; ++i) {
            address a = address(uint160(0x5000 + i));
            actors.push(a);
            vm.prank(a); coin.approve(address(s), type(uint256).max);
        }
    }
    function actorCount() external view returns (uint256) { return actors.length; }
    function _who(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    function stake(uint256 seed, uint256 amt) external {
        address a = _who(seed);
        amt = bound(amt, 1, 50_000_000 ether);
        if (coin.balanceOf(a) < amt) coin.transfer(a, amt);
        vm.prank(a); s.stake(amt);
    }
    function requestUnstake(uint256 seed, uint256 amt) external {
        address a = _who(seed);
        (uint256 staked,,,,) = s.stakeOf(a);
        if (staked == 0) return;
        amt = bound(amt, 1, staked);
        vm.prank(a); s.requestUnstake(amt);
    }
    function cancel(uint256 seed) external {
        address a = _who(seed);
        (,, uint256 pending,,) = s.stakeOf(a);
        if (pending == 0) return;
        vm.prank(a); s.cancelUnstake();
    }
    function withdraw(uint256 seed) external {
        address a = _who(seed);
        (,, uint256 pending, uint64 unlockAt,) = s.stakeOf(a);
        if (pending == 0) return;
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        vm.prank(a); s.withdraw();
        ghostWithdrawn += pending;
    }
    function notify(uint256 amt) external {
        if (s.totalStaked() == 0) return;
        amt = bound(amt, 1, 50 ether);
        vm.deal(address(this), amt);
        s.notifyReward{value: amt}();
    }
    function claim(uint256 seed) external {
        address a = _who(seed);
        uint256 e = s.earned(a);
        if (e == 0) return;
        uint256 b0 = a.balance;
        vm.prank(a); s.claim();
        assertEq(a.balance - b0, e, "claim pays exactly what earned() showed");
        ghostClaimed += e;
    }
    function wait(uint256 dt) external { vm.warp(block.timestamp + bound(dt, 0, 10 days)); }
}

contract TroyaStakeInvariantTest is Test {
    TroyaStake s;
    InvCoin coin;
    StakeHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        coin = new InvCoin();
        s = new TroyaStake(address(coin));
        handler = new StakeHandler(s, coin);
        coin.transfer(address(handler), coin.balanceOf(address(this)));
        targetContract(address(handler));
    }

    /// every coin booked is still in the contract
    function invariant_coinsBacked() public view {
        assertEq(coin.balanceOf(address(s)), s.totalStaked() + s.totalPending());
    }

    /// totals equal the sum of the accounts
    function invariant_totalsMatchAccounts() public view {
        uint256 staked; uint256 pending;
        for (uint256 i; i < handler.actorCount(); ++i) {
            (uint256 a,, uint256 p,,) = s.stakeOf(handler.actors(i));
            staked += a; pending += p;
        }
        assertEq(staked, s.totalStaked());
        assertEq(pending, s.totalPending());
    }

    /// the ETH held covers everything owed plus the carry, and nothing leaks out
    function invariant_ethBacked() public view {
        uint256 owed;
        for (uint256 i; i < handler.actorCount(); ++i) owed += s.earned(handler.actors(i));
        assertGe(address(s).balance, owed + s.rewardCarry());
        assertEq(address(s).balance, s.totalRewarded() - s.totalClaimed());
        assertEq(handler.ghostClaimed(), s.totalClaimed());
    }

    /// a stake's weighted start is never in the future, and is set exactly when coins are staked
    function invariant_startTimes() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            (uint256 a, uint64 since, uint256 p, uint64 unlockAt,) = s.stakeOf(handler.actors(i));
            assertLe(since, block.timestamp);
            assertEq(a == 0, since == 0);
            assertEq(p == 0, unlockAt == 0);
        }
    }
}
