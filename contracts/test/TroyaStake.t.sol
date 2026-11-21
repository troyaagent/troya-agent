// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TroyaStake} from "../src/TroyaStake.sol";

contract Coin is ERC20 {
    constructor() ERC20("Coin", "COIN") { _mint(msg.sender, 1_000_000_000 ether); }
}

/// skims 1% on every transfer: the stake must book what it really received
contract TaxCoin is ERC20 {
    constructor() ERC20("Tax", "TAX") { _mint(msg.sender, 1_000_000 ether); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { uint256 fee = v / 100; super._update(from, address(0xdead), fee); v -= fee; }
        super._update(from, to, v);
    }
}

/// takes everything sent to a contract as a fee: the stake must refuse a deposit that books zero
contract BlackHoleCoin is ERC20 {
    constructor() ERC20("Hole", "HOLE") { _mint(msg.sender, 1_000_000 ether); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0) && to.code.length > 0) { super._update(from, address(0xdead), v); return; }
        super._update(from, to, v);
    }
}

/// a coin with a supply above 1e27 base units: the case where a notify's rounding remainder is carried
contract BigCoin is ERC20 {
    constructor() ERC20("Big", "BIG") { _mint(msg.sender, 1e30); }
}

/// a coin with a transfer hook (ERC-777 style) that calls back into the stake mid-transfer
contract HookCoin is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    constructor() ERC20("Hook", "HOOK") { _mint(msg.sender, 1_000_000 ether); }
    function arm(address t, bytes calldata p) external { target = t; payload = p; armed = true; }
    function _update(address from, address to, uint256 v) internal override {
        super._update(from, to, v);
        if (armed && from != address(0) && to != address(0)) {
            armed = false;
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }   // bubble the guard's revert up
        }
    }
}

/// a staker contract whose ETH receive hook re-enters the stake; it records how the inner call ended and lets the
/// outer claim finish, so the test sees both that the claim paid once and why the re-entry failed
contract Reenterer {
    TroyaStake public s;
    bytes public payload;
    bool public tried;
    bool public innerOk;
    bytes public innerErr;
    constructor(TroyaStake s_) { s = s_; }
    function go(address coin, uint256 amount) external {
        ERC20(coin).approve(address(s), type(uint256).max);
        s.stake(amount);
    }
    function setPayload(bytes calldata p) external { payload = p; }
    function claim() external { s.claim(); }
    receive() external payable {
        if (tried) return;
        tried = true;
        (innerOk, innerErr) = address(s).call(payload);
    }
}

/// a staker contract that cannot take ETH
contract NoEth {
    function go(TroyaStake s, address coin, uint256 amount) external { ERC20(coin).approve(address(s), type(uint256).max); s.stake(amount); }
    function claim(TroyaStake s) external { s.claim(); }
}

contract TroyaStakeTest is Test {
    TroyaStake s;
    Coin coin;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address funder = address(0xF00D);

    function setUp() public {
        vm.warp(1_800_000_000);
        coin = new Coin();
        s = new TroyaStake(address(coin));
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < who.length; ++i) {
            coin.transfer(who[i], 10_000_000 ether);
            vm.prank(who[i]); coin.approve(address(s), type(uint256).max);
        }
        vm.deal(funder, 1_000 ether);
    }

    function _stake(address who, uint256 amt) internal { vm.prank(who); s.stake(amt); }
    function _acct(address who) internal view returns (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt, uint256 e) {
        return s.stakeOf(who);
    }
    function _notify(uint256 wei_) internal { vm.prank(funder); s.notifyReward{value: wei_}(); }

    /* ---------------- deploy ---------------- */

    function test_constructorRejectsZeroToken() public {
        vm.expectRevert(TroyaStake.ZeroAddress.selector);
        new TroyaStake(address(0));
    }

    function test_noOwnerSurface() public view {
        assertEq(address(s.token()), address(coin));
        assertEq(s.COOLDOWN(), 3 days);
        assertEq(s.totalStaked(), 0);
    }

    /* ---------------- stake ---------------- */

    function test_stakeRecordsAmountAndStart() public {
        vm.expectEmit(true, false, false, true);
        emit TroyaStake.Staked(alice, 1_000 ether, 1_000 ether, uint64(block.timestamp));
        _stake(alice, 1_000 ether);
        (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt, uint256 e) = _acct(alice);
        assertEq(amount, 1_000 ether);
        assertEq(since, block.timestamp);
        assertEq(pending, 0); assertEq(unlockAt, 0); assertEq(e, 0);
        assertEq(s.totalStaked(), 1_000 ether);
        assertEq(coin.balanceOf(address(s)), 1_000 ether);
        vm.warp(block.timestamp + 5 days);
        assertEq(s.stakedFor(alice), 5 days);
    }

    function test_stakeZeroReverts() public {
        vm.prank(alice); vm.expectRevert(TroyaStake.ZeroAmount.selector);
        s.stake(0);
    }

    function test_stakeWithoutApprovalReverts() public {
        address dave = address(0xDA7E);
        coin.transfer(dave, 10 ether);
        vm.prank(dave); vm.expectRevert();
        s.stake(10 ether);
    }

    function test_topUpWeightsTheStartTime() public {
        uint256 t0 = block.timestamp;
        _stake(alice, 1_000 ether);
        vm.warp(t0 + 10 days);
        _stake(alice, 1_000 ether);                         // equal top-up: start moves halfway, 5 days old
        (uint256 amount, uint64 since,,,) = _acct(alice);
        assertEq(amount, 2_000 ether);
        assertEq(since, t0 + 5 days);
        assertEq(s.stakedFor(alice), 5 days);

        vm.warp(t0 + 20 days);                               // 15 days old, then a top-up 3x the stake
        _stake(alice, 6_000 ether);
        (, since,,,) = _acct(alice);
        // (2000 * (t0+5d) + 6000 * (t0+20d)) / 8000 = t0 + 16.25d
        assertEq(since, t0 + 16 days + 6 hours);
    }

    function test_tinyTopUpBarelyMovesTheStart() public {
        uint256 t0 = block.timestamp;
        _stake(alice, 1_000_000 ether);
        vm.warp(t0 + 30 days);
        _stake(alice, 1 ether);
        (, uint64 since,,,) = _acct(alice);
        assertApproxEqAbs(since, t0, 3);                    // 1 / 1,000,001 of 30 days, about 2.6 s
    }

    function test_feeOnTransferBookedAtReceived() public {
        TaxCoin t = new TaxCoin();
        TroyaStake ts = new TroyaStake(address(t));
        t.transfer(alice, 10_000 ether);
        vm.startPrank(alice);
        t.approve(address(ts), type(uint256).max);
        ts.stake(1_000 ether);
        vm.stopPrank();
        (uint256 amount,,,,) = ts.stakeOf(alice);
        assertEq(amount, 990 ether);
        assertEq(ts.totalStaked(), 990 ether);
        assertEq(t.balanceOf(address(ts)), 990 ether);
        // the full booked amount comes back out (the coin's own 1% applies on the way out too)
        vm.startPrank(alice);
        ts.requestUnstake(990 ether);
        vm.warp(block.timestamp + 3 days);
        uint256 b0 = t.balanceOf(alice);
        ts.withdraw();
        vm.stopPrank();
        assertEq(t.balanceOf(alice) - b0, 980.1 ether);
        assertEq(t.balanceOf(address(ts)), 0);
        assertEq(ts.totalPending(), 0);
    }

    function test_depositThatBooksZeroReverts() public {
        BlackHoleCoin t = new BlackHoleCoin();
        TroyaStake ts = new TroyaStake(address(t));
        t.transfer(alice, 10 ether);
        vm.startPrank(alice);
        t.approve(address(ts), type(uint256).max);
        vm.expectRevert(TroyaStake.ZeroAmount.selector);
        ts.stake(10 ether);
        vm.stopPrank();
    }

    /* ---------------- unstake + cooldown + withdraw ---------------- */

    function test_cooldownThenWithdraw() public {
        _stake(alice, 1_000 ether);
        vm.warp(block.timestamp + 1 days);
        uint64 unlock = uint64(block.timestamp + 3 days);
        vm.expectEmit(true, false, false, true);
        emit TroyaStake.UnstakeRequested(alice, 400 ether, 600 ether, 400 ether, unlock);
        vm.prank(alice); s.requestUnstake(400 ether);
        (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt,) = _acct(alice);
        assertEq(amount, 600 ether); assertEq(pending, 400 ether); assertEq(unlockAt, unlock);
        assertEq(since, block.timestamp - 1 days, "the coins that stay keep their age");
        assertEq(s.totalStaked(), 600 ether); assertEq(s.totalPending(), 400 ether);

        vm.warp(unlock - 1);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(TroyaStake.CoolingDown.selector, unlock));
        s.withdraw();

        vm.warp(unlock);
        uint256 b0 = coin.balanceOf(alice);
        vm.expectEmit(true, false, false, true);
        emit TroyaStake.Withdrawn(alice, 400 ether);
        vm.prank(alice); s.withdraw();
        assertEq(coin.balanceOf(alice) - b0, 400 ether);
        (, , pending, unlockAt,) = _acct(alice);
        assertEq(pending, 0); assertEq(unlockAt, 0);
        assertEq(s.totalPending(), 0);
        assertEq(coin.balanceOf(address(s)), 600 ether);
    }

    function test_fullUnstakeResetsTheAge() public {
        _stake(alice, 1_000 ether);
        vm.warp(block.timestamp + 40 days);
        vm.prank(alice); s.requestUnstake(1_000 ether);
        (uint256 amount, uint64 since,,,) = _acct(alice);
        assertEq(amount, 0); assertEq(since, 0);
        assertEq(s.stakedFor(alice), 0);
        _stake(alice, 10 ether);                            // a fresh stake starts from now
        (, since,,,) = _acct(alice);
        assertEq(since, block.timestamp);
    }

    function test_secondRequestAddsAndRestartsTheWait() public {
        _stake(alice, 1_000 ether);
        vm.prank(alice); s.requestUnstake(100 ether);
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice); s.requestUnstake(100 ether);
        (, , uint256 pending, uint64 unlockAt,) = _acct(alice);
        assertEq(pending, 200 ether);
        assertEq(unlockAt, block.timestamp + 3 days);
        vm.warp(block.timestamp + 1 days + 1);              // the first request's 3 days are over, the restart's are not
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(TroyaStake.CoolingDown.selector, unlockAt));
        s.withdraw();
    }

    function test_unstakeMoreThanStakedReverts() public {
        _stake(alice, 1_000 ether);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(TroyaStake.TooMuch.selector, 1_000 ether + 1, 1_000 ether));
        s.requestUnstake(1_000 ether + 1);
        vm.prank(bob); vm.expectRevert(abi.encodeWithSelector(TroyaStake.TooMuch.selector, 1, 0));
        s.requestUnstake(1);
        vm.prank(alice); vm.expectRevert(TroyaStake.ZeroAmount.selector);
        s.requestUnstake(0);
    }

    function test_withdrawWithNothingPendingReverts() public {
        vm.prank(alice); vm.expectRevert(TroyaStake.NothingPending.selector);
        s.withdraw();
        _stake(alice, 1 ether);
        vm.prank(alice); vm.expectRevert(TroyaStake.NothingPending.selector);
        s.withdraw();
    }

    function test_withdrawTwiceReverts() public {
        _stake(alice, 1 ether);
        vm.prank(alice); s.requestUnstake(1 ether);
        vm.warp(block.timestamp + 3 days);
        vm.startPrank(alice);
        s.withdraw();
        vm.expectRevert(TroyaStake.NothingPending.selector);
        s.withdraw();
        vm.stopPrank();
    }

    function test_cancelUnstakeRestakesAsATopUp() public {
        uint256 t0 = block.timestamp;
        _stake(alice, 1_000 ether);
        vm.warp(t0 + 10 days);
        vm.prank(alice); s.requestUnstake(1_000 ether);     // all of it: the age resets
        vm.warp(t0 + 11 days);
        vm.expectEmit(true, false, false, true);
        emit TroyaStake.UnstakeCancelled(alice, 1_000 ether, 1_000 ether, uint64(t0 + 11 days));
        vm.prank(alice); s.cancelUnstake();
        (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt,) = _acct(alice);
        assertEq(amount, 1_000 ether); assertEq(since, t0 + 11 days);
        assertEq(pending, 0); assertEq(unlockAt, 0);
        assertEq(s.totalStaked(), 1_000 ether); assertEq(s.totalPending(), 0);
        vm.prank(alice); vm.expectRevert(TroyaStake.NothingPending.selector);
        s.cancelUnstake();
    }

    function test_cancelPartialKeepsWeightedAge() public {
        uint256 t0 = block.timestamp;
        _stake(alice, 1_000 ether);
        vm.warp(t0 + 10 days);
        vm.prank(alice); s.requestUnstake(500 ether);       // 500 stay, still from t0
        vm.prank(alice); s.cancelUnstake();                 // 500 back as of t0+10d: weighted t0+5d
        (, uint64 since,,,) = _acct(alice);
        assertEq(since, t0 + 5 days);
    }

    function test_onlyTheStakerCanMoveTheirCoins() public {
        _stake(alice, 1_000 ether);
        vm.prank(alice); s.requestUnstake(1_000 ether);
        vm.warp(block.timestamp + 3 days);
        // nobody else has a call that touches alice's account: every one acts on msg.sender
        vm.startPrank(bob);
        vm.expectRevert(TroyaStake.NothingPending.selector); s.withdraw();
        vm.expectRevert(TroyaStake.NothingPending.selector); s.cancelUnstake();
        vm.expectRevert(abi.encodeWithSelector(TroyaStake.TooMuch.selector, 1, 0)); s.requestUnstake(1);
        vm.stopPrank();
        assertEq(coin.balanceOf(address(s)), 1_000 ether);
        uint256 b0 = coin.balanceOf(alice);
        vm.prank(alice); s.withdraw();
        assertEq(coin.balanceOf(alice) - b0, 1_000 ether);
    }

    function test_directEthTransferIsRefused() public {
        vm.prank(funder);
        (bool ok,) = address(s).call{value: 1 ether}("");
        assertFalse(ok, "no receive(): ETH only comes in through notifyReward");
    }

    /* ---------------- reward accumulator ---------------- */

    function test_neverUsedRewardsChangeNothing() public {
        _stake(alice, 1_000 ether);
        vm.warp(block.timestamp + 30 days);
        assertEq(s.earned(alice), 0);
        vm.prank(alice); vm.expectRevert(TroyaStake.NothingToClaim.selector);
        s.claim();
        vm.prank(alice); s.requestUnstake(1_000 ether);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice); s.withdraw();
        assertEq(address(s).balance, 0);
        assertEq(s.accRewardPerToken(), 0);
    }

    function test_notifyWithNoStakersReverts() public {
        vm.prank(funder); vm.expectRevert(TroyaStake.NoStakers.selector);
        s.notifyReward{value: 1 ether}();
        vm.prank(funder); vm.expectRevert(TroyaStake.ZeroAmount.selector);
        s.notifyReward{value: 0}();
    }

    function test_notifyWhenEveryoneIsCoolingDownReverts() public {
        _stake(alice, 1_000 ether);
        vm.prank(alice); s.requestUnstake(1_000 ether);
        vm.prank(funder); vm.expectRevert(TroyaStake.NoStakers.selector);
        s.notifyReward{value: 1 ether}();
    }

    function test_rewardSplitsProRata() public {
        _stake(alice, 1_000 ether);
        _stake(bob, 3_000 ether);
        vm.expectEmit(true, false, false, false);
        emit TroyaStake.RewardNotified(funder, 4 ether, 4_000 ether, 0);
        _notify(4 ether);
        assertEq(s.earned(alice), 1 ether);
        assertEq(s.earned(bob), 3 ether);
        assertEq(s.totalRewarded(), 4 ether);

        uint256 a0 = alice.balance;
        vm.expectEmit(true, false, false, true);
        emit TroyaStake.RewardClaimed(alice, 1 ether);
        vm.prank(alice); s.claim();
        assertEq(alice.balance - a0, 1 ether);
        assertEq(s.earned(alice), 0);
        vm.prank(alice); vm.expectRevert(TroyaStake.NothingToClaim.selector);
        s.claim();
        assertEq(s.totalClaimed(), 1 ether);
    }

    function test_lateStakerGetsNothingFromEarlierRewards() public {
        _stake(alice, 1_000 ether);
        _notify(1 ether);
        _stake(bob, 1_000 ether);                            // after the notify: none of it
        assertEq(s.earned(bob), 0);
        _notify(2 ether);
        assertEq(s.earned(alice), 2 ether);
        assertEq(s.earned(bob), 1 ether);
    }

    function test_coolingCoinsEarnNothing() public {
        _stake(alice, 1_000 ether);
        _stake(bob, 1_000 ether);
        vm.prank(bob); s.requestUnstake(1_000 ether);
        _notify(1 ether);
        assertEq(s.earned(alice), 1 ether);
        assertEq(s.earned(bob), 0);
    }

    function test_rewardsKeptThroughUnstakeAndWithdraw() public {
        _stake(alice, 1_000 ether);
        _notify(1 ether);
        vm.prank(alice); s.requestUnstake(1_000 ether);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice); s.withdraw();
        assertEq(s.earned(alice), 1 ether, "settled ETH survives the exit");
        uint256 a0 = alice.balance;
        vm.prank(alice); s.claim();
        assertEq(alice.balance - a0, 1 ether);
    }

    function test_topUpSettlesBeforeTheAmountChanges() public {
        _stake(alice, 1_000 ether);
        _stake(bob, 1_000 ether);
        _notify(2 ether);                                    // 1 each
        _stake(alice, 2_000 ether);                          // alice now 3000 of 4000
        _notify(4 ether);                                    // 3 alice, 1 bob
        assertEq(s.earned(alice), 4 ether);
        assertEq(s.earned(bob), 2 ether);
    }

    function test_roundingCarryLosesNoEth() public {
        _stake(alice, 3);                                    // odd, tiny stakes
        _stake(bob, 7);
        for (uint256 i; i < 25; ++i) _notify(1 + i * 7);
        uint256 owed = s.earned(alice) + s.earned(bob);
        assertLe(owed, address(s).balance, "never promises more than it holds");
        assertLe(address(s).balance - owed, 2 + s.rewardCarry(), "what is not owed is the carry plus floor dust");
        vm.prank(alice); s.claim();
        vm.prank(bob); s.claim();
        assertEq(address(s).balance, s.totalRewarded() - s.totalClaimed());
    }

    function test_carryReachesStakers() public {
        BigCoin big = new BigCoin();
        TroyaStake bs = new TroyaStake(address(big));
        big.transfer(alice, 5e27);
        vm.startPrank(alice);
        big.approve(address(bs), type(uint256).max);
        bs.stake(5e27);
        vm.stopPrank();
        vm.prank(funder); bs.notifyReward{value: 1}();     // 1 wei over 5e27 units: the accumulator cannot move, all carried
        assertEq(bs.accRewardPerToken(), 0);
        assertEq(bs.rewardCarry(), 1);
        assertEq(bs.earned(alice), 0);
        vm.prank(funder); bs.notifyReward{value: 4}();     // 1 carried + 4 = 5 wei = exactly 1 unit of the accumulator
        assertEq(bs.rewardCarry(), 0);
        assertEq(bs.earned(alice), 5, "the carried wei is paid with the next notify");
    }

    function test_subWeiRemainderNeverOverpromises() public {
        _stake(alice, 3 ether);
        _notify(1);                                          // 1 wei over 3e18: the share rounds to 0, nothing promised twice
        assertEq(s.earned(alice), 0);
        assertLe(s.earned(alice) + s.rewardCarry(), address(s).balance);
        _notify(3 ether);
        assertEq(s.earned(alice), 3 ether);
    }

    function test_claimToContractThatRefusesEthReverts() public {
        NoEth n = new NoEth();
        coin.transfer(address(n), 10 ether);
        n.go(s, address(coin), 10 ether);
        _notify(1 ether);
        vm.expectRevert(TroyaStake.EthTransferFailed.selector);
        n.claim(s);
        assertEq(s.earned(address(n)), 1 ether, "the reward stays claimable");
    }

    /* ---------------- reentrancy ---------------- */

    function test_reenterClaimFromReceiveIsBlocked() public {
        Reenterer r = new Reenterer(s);
        coin.transfer(address(r), 1_000 ether);
        r.go(address(coin), 1_000 ether);
        _stake(alice, 1_000 ether);
        _notify(2 ether);
        r.setPayload(abi.encodeCall(TroyaStake.claim, ()));
        uint256 b0 = address(r).balance;
        r.claim();
        assertTrue(r.tried());
        assertFalse(r.innerOk(), "the second claim inside receive() must fail");
        assertEq(bytes4(r.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(r).balance - b0, 1 ether, "paid once");
        assertEq(s.earned(address(r)), 0);
        assertEq(address(s).balance, 1 ether, "alice's share is untouched");
        assertEq(s.earned(alice), 1 ether);
    }

    function test_reenterStakeFromReceiveIsBlocked() public {
        Reenterer r = new Reenterer(s);
        coin.transfer(address(r), 1_000 ether);
        r.go(address(coin), 500 ether);
        _notify(1 ether);
        r.setPayload(abi.encodeCall(TroyaStake.stake, (500 ether)));
        r.claim();
        assertFalse(r.innerOk());
        assertEq(bytes4(r.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        (uint256 amount,,,,) = s.stakeOf(address(r));
        assertEq(amount, 500 ether, "the re-entered stake did not happen");
    }

    function test_reenterRequestUnstakeFromReceiveIsBlocked() public {
        Reenterer r = new Reenterer(s);
        coin.transfer(address(r), 1_000 ether);
        r.go(address(coin), 1_000 ether);
        _notify(1 ether);
        r.setPayload(abi.encodeCall(TroyaStake.requestUnstake, (1_000 ether)));
        r.claim();
        assertFalse(r.innerOk());
        assertEq(bytes4(r.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(s.totalPending(), 0);
    }

    function test_hookCoinCannotReenterDuringStake() public {
        HookCoin hc = new HookCoin();
        TroyaStake hs = new TroyaStake(address(hc));
        hc.transfer(alice, 1_000 ether);
        vm.prank(alice); hc.approve(address(hs), type(uint256).max);
        // during alice's deposit the coin calls stake() again (as the coin itself)
        hc.arm(address(hs), abi.encodeCall(TroyaStake.stake, (1)));
        vm.prank(alice); vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hs.stake(100 ether);
        assertEq(hs.totalStaked(), 0);
        assertEq(hc.balanceOf(address(hs)), 0);
    }

    function test_hookCoinCannotReenterDuringWithdraw() public {
        HookCoin hc = new HookCoin();
        TroyaStake hs = new TroyaStake(address(hc));
        hc.transfer(alice, 1_000 ether);
        vm.startPrank(alice);
        hc.approve(address(hs), type(uint256).max);
        hs.stake(100 ether);
        hs.requestUnstake(100 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 3 days);
        hc.arm(address(hs), abi.encodeCall(TroyaStake.withdraw, ()));
        vm.prank(alice); vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hs.withdraw();
        (,, uint256 pending,,) = hs.stakeOf(alice);
        assertEq(pending, 100 ether, "nothing moved");
        assertEq(hc.balanceOf(address(hs)), 100 ether);
    }

    function test_hookCoinCannotCancelDuringStake() public {
        HookCoin hc = new HookCoin();
        TroyaStake hs = new TroyaStake(address(hc));
        hc.transfer(alice, 1_000 ether);
        vm.prank(alice); hc.approve(address(hs), type(uint256).max);
        hc.arm(address(hs), abi.encodeCall(TroyaStake.cancelUnstake, ()));
        vm.prank(alice); vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hs.stake(100 ether);
    }

    /* ---------------- fuzz ---------------- */

    function testFuzz_weightedStartStaysBetween(uint96 a, uint96 b, uint32 dt) public {
        vm.assume(a > 0 && b > 0 && a <= 10_000_000 ether && b <= 10_000_000 ether - a);
        uint256 t0 = block.timestamp;
        _stake(alice, a);
        vm.warp(t0 + dt);
        _stake(alice, b);
        (uint256 amount, uint64 since,,,) = _acct(alice);
        assertEq(amount, uint256(a) + b);
        assertGe(since, t0);
        assertLe(since, t0 + dt);
    }

    function testFuzz_rewardsNeverExceedWhatWasSent(uint96 a, uint96 b, uint96 c, uint64 r1, uint64 r2, uint64 r3) public {
        a = uint96(bound(a, 1, 5_000_000 ether));          // alice stakes it twice
        b = uint96(bound(b, 1, 10_000_000 ether));
        c = uint96(bound(c, 1, 10_000_000 ether));
        vm.deal(funder, uint256(r1) + r2 + r3 + 3);
        _stake(alice, a);
        _stake(bob, b);
        if (r1 > 0) _notify(r1);
        _stake(carol, c);
        vm.prank(bob); s.requestUnstake(b / 2 + 1);
        if (r2 > 0) _notify(r2);
        _stake(alice, a);
        if (r3 > 0) _notify(r3);
        uint256 owed = s.earned(alice) + s.earned(bob) + s.earned(carol);
        assertLe(owed + s.rewardCarry(), address(s).balance);
        assertLe(address(s).balance - owed - s.rewardCarry(), 9, "at most a wei of floor dust per account per settle");
        address[3] memory w = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) if (s.earned(w[i]) > 0) { vm.prank(w[i]); s.claim(); }
        assertGe(address(s).balance, s.rewardCarry());
    }

    function testFuzz_cannotWithdrawEarly(uint96 amt, uint32 wait) public {
        amt = uint96(bound(amt, 1, 10_000_000 ether));
        _stake(alice, amt);
        vm.prank(alice); s.requestUnstake(amt);
        vm.warp(block.timestamp + wait);
        vm.prank(alice);
        if (wait < 3 days) { vm.expectRevert(); s.withdraw(); }
        else { s.withdraw(); assertEq(coin.balanceOf(address(s)), 0); }
    }
}
