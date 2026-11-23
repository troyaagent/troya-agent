// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TroyaStake} from "../src/TroyaStake.sol";
import {TroyaFeeRouter, PoolKey, SwapParams} from "../src/TroyaFeeRouter.sol";

/// plain ERC20 + burn, like the real $TROYA (PonsV2LauncherToken: OpenZeppelin ERC20 + ERC20Burnable, no transfer tax)
contract MockTroya is ERC20, ERC20Burnable {
    constructor() ERC20("Troya", "TROYA") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract Junk is ERC20 {
    constructor() ERC20("Junk", "JUNK") { _mint(msg.sender, 1_000 ether); }
}

/// PonsV2FeeEscrow's ETH side: credit, balanceOf, claim() pushes the whole balance to the caller
contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    function credit(address r) external payable { balanceOf[r] += msg.value; }
    function claim() external returns (uint256 a) {
        a = balanceOf[msg.sender];
        require(a > 0, "NoBalance");
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "TransferFailed");
    }
}

contract MockPonsFactory {
    address public lastCaller;
    address public lastToken;
    address public lastRecipient;
    function transferCreatorFeeRecipient(address token, address to) external {
        lastCaller = msg.sender; lastToken = token; lastRecipient = to;
    }
}

interface IUnlockCallback { function unlockCallback(bytes calldata) external returns (bytes memory); }

/// A Uniswap v4 PoolManager stand-in for one pool: slot0 readable through extsload at the real slot, the unlocked flag
/// through exttload, and exact-input ETH -> token swaps with concentrated-liquidity maths at a fixed liquidity, a price
/// limit, and a 2.9% cut of the output (the Pons hook's 1% fee + 1.9% creator tax). unlock() checks every delta is settled.
contract MockPoolManager {
    bytes32 constant UNLOCKED = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    uint256 constant Q96 = 1 << 96;
    mapping(bytes32 => bytes32) public slots;
    ERC20 public token;
    uint256 public liquidity = 3.5e22;   // ~2.5 ETH of virtual ETH reserve at sqrtP = 14000 * 2^96
    bool public unlocked;
    bool public forceUnlocked;
    bool public failSwap;
    uint256 ethOwed;
    uint256 paid;
    uint256 tokenOwed;

    constructor(ERC20 t) { token = t; }
    function slotOf(bytes32 id) public pure returns (bytes32) { return keccak256(abi.encode(id, uint256(6))); }
    function setPrice(bytes32 id, uint160 p) external { slots[slotOf(id)] = bytes32(uint256(p)); }
    function priceOf(bytes32 id) public view returns (uint160) { return uint160(uint256(slots[slotOf(id)])); }
    function setForceUnlocked(bool v) external { forceUnlocked = v; }
    function setFailSwap(bool v) external { failSwap = v; }
    function extsload(bytes32 s) external view returns (bytes32) { return slots[s]; }
    function exttload(bytes32 s) external view returns (bytes32) {
        return s == UNLOCKED && (unlocked || forceUnlocked) ? bytes32(uint256(1)) : bytes32(0);
    }
    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        r = IUnlockCallback(msg.sender).unlockCallback(data);
        require(paid == ethOwed && tokenOwed == 0, "CurrencyNotSettled");
        paid = 0; ethOwed = 0; unlocked = false;
    }
    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256 d) {
        require(unlocked, "ManagerLocked");
        require(!failSwap, "hook says no");
        require(p.zeroForOne && p.amountSpecified < 0, "only exact ETH in");
        bytes32 id = keccak256(abi.encode(key));
        uint256 sp = priceOf(id);
        require(sp != 0, "PoolNotInitialized");
        require(p.sqrtPriceLimitX96 < sp, "PriceLimitAlreadyExceeded");
        uint256 amtIn = uint256(-p.amountSpecified);
        uint256 lq = liquidity * Q96;
        uint256 sNew = Math.mulDiv(lq, sp, lq + amtIn * sp);
        if (sNew < p.sqrtPriceLimitX96) {
            sNew = p.sqrtPriceLimitX96;
            amtIn = Math.mulDiv(Math.mulDiv(liquidity, Q96, sNew), sp - sNew, sp);
        }
        uint256 out = Math.mulDiv(liquidity, sp - sNew, Q96);
        out -= (out * 290) / 10_000;
        slots[slotOf(id)] = bytes32(sNew);
        ethOwed = amtIn;
        tokenOwed = out;
        int256 a0 = -int256(amtIn);
        int256 a1 = int256(out);
        assembly { d := or(shl(128, a0), and(sub(shl(128, 1), 1), a1)) }
    }
    function settle() external payable returns (uint256) { paid += msg.value; return msg.value; }
    function take(address c, address to, uint256 amt) external {
        require(c == address(token), "wrong currency");
        tokenOwed -= amt;
        token.transfer(to, amt);
    }
}

/// a payee whose receive hook tries to re-enter the router, records how that ended, and takes the ETH
contract Reenterer {
    TroyaFeeRouter public r;
    bytes public payload;
    bool public tried;
    bool public innerOk;
    bytes public innerErr;
    function set(TroyaFeeRouter r_, bytes calldata p) external { r = r_; payload = p; tried = false; }
    receive() external payable {
        if (tried || address(r) == address(0)) return;
        tried = true;
        (innerOk, innerErr) = address(r).call(payload);
    }
}

/// a payee that refuses ETH
contract Refuser {
    function withdraw(TroyaFeeRouter r, address payable to) external { r.withdrawOwed(to); }
}

contract TroyaFeeRouterTest is Test {
    uint256 constant Q96 = 1 << 96;
    uint256 constant START = 1_795_466_226; // 23 Nov 2026

    MockTroya troya;
    TroyaStake stake;
    MockEscrow escrow;
    MockPoolManager pm;
    MockPonsFactory factory;
    TroyaFeeRouter router;
    address hookAddr = makeAddr("pons-hook");
    address team = makeAddr("team");
    address gasWallet = makeAddr("gas-sponsor");
    address alice = makeAddr("alice");
    address keeper = makeAddr("anyone");
    bytes32 id;

    function _cfg() internal view returns (TroyaFeeRouter.Config memory c) {
        c.team = team;
        c.gasWallet = gasWallet;
        c.stakerBps = [uint16(10), 50, 100];
        c.burnBps = [uint16(0), 0, 10];
        c.gasBps = 10;
        c.stakeTargetBps = 500;
        c.maxBurnSlippageBps = 500;
        c.minInterval = 1 days;
        c.midMcWei = 20 ether;
        c.highMcWei = 57.7 ether;
        c.minSendWei = 0.00002 ether;
        c.minBurnWei = 0.0005 ether;
    }

    function _deploy(TroyaFeeRouter.Config memory c) internal returns (TroyaFeeRouter) {
        return new TroyaFeeRouter(team, address(troya), address(stake), address(escrow), address(pm), address(factory), hookAddr, 0, 200, 260, c);
    }

    function setUp() public {
        vm.warp(START);
        troya = new MockTroya();
        stake = new TroyaStake(address(troya));
        escrow = new MockEscrow();
        pm = new MockPoolManager(troya);
        factory = new MockPonsFactory();
        id = keccak256(abi.encode(address(0), address(troya), uint24(0), int24(200), hookAddr));
        pm.setPrice(id, _sqrtForMc(10 ether));
        troya.transfer(address(pm), 300_000_000 ether); // the pool's $TROYA side
        router = _deploy(_cfg());
        _stake(alice, 60_000_000 ether); // 6% of supply: above the 5% target
    }

    /* ---------------- helpers ---------------- */

    /// sqrtPriceX96 at which the market cap (total supply / price) is `mc` wei
    function _sqrtForMc(uint256 mc) internal view returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(troya.totalSupply(), 1 << 192, mc)));
    }

    function _stake(address who, uint256 amt) internal {
        troya.transfer(who, amt);
        vm.startPrank(who);
        troya.approve(address(stake), amt);
        stake.stake(amt);
        vm.stopPrank();
    }

    /// `n` hourly reads at the market cap `mc`, one per hour, ending in the current hour
    function _hours(uint256 mc, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            if (router.lastObservedHour() == block.timestamp / 1 hours) vm.warp(block.timestamp + 1 hours);
            pm.setPrice(id, _sqrtForMc(mc));
            router.poke();
        }
    }

    function _fees(uint256 amt) internal {
        vm.deal(address(this), amt);
        escrow.credit{value: amt}(address(router));
    }

    function _nextDay() internal {
        vm.warp((block.timestamp / 1 days + 1) * 1 days + 1 hours);
    }

    function _run() internal returns (TroyaFeeRouter.Split memory s) {
        vm.prank(keeper);
        s = router.distribute();
    }

    /* ---------------- shares per tier ---------------- */

    function test_TierBase_Shares() public {
        _hours(10 ether, 24);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.tier, 0);
        assertEq(s.toStakers, 0.1 ether, "0.1% of volume = 10/260");
        assertEq(s.toGas, 0.1 ether, "gas 10/260");
        assertEq(s.toBurn, 0);
        assertEq(s.toTeam, 2.4 ether);
        assertEq(stake.totalRewarded(), 0.1 ether);
        assertApproxEqAbs(stake.earned(alice), 0.1 ether, 1);
        assertEq(gasWallet.balance, 0.1 ether);
        assertEq(team.balance, 2.4 ether);
        assertEq(address(router).balance, 0);
        assertEq(escrow.balanceOf(address(router)), 0, "claimed from the escrow");
    }

    function test_TierMid_Shares() public {
        _hours(30 ether, 24);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.tier, 1);
        assertEq(s.toStakers, 0.5 ether);
        assertEq(s.toGas, 0.1 ether);
        assertEq(s.toBurn, 0);
        assertEq(team.balance, 2.0 ether);
    }

    function test_TierTop_SharesAndBurn() public {
        _hours(100 ether, 24);
        _fees(2.6 ether);
        uint256 supply0 = troya.totalSupply();
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.tier, 2);
        assertEq(s.toStakers, 1 ether);
        assertEq(s.toGas, 0.1 ether);
        assertEq(s.toBurn, 0.1 ether);
        assertEq(team.balance, 1.4 ether);
        assertEq(router.burnReserve(), 0, "the whole burn share was bought");
        assertEq(router.totalBurnEthSpent(), 0.1 ether);
        assertGt(router.totalTroyaBurned(), 0);
        assertEq(supply0 - troya.totalSupply(), router.totalTroyaBurned(), "bought $TROYA burned");
        assertEq(troya.balanceOf(address(router)), 0, "no $TROYA left behind");
        assertEq(address(router).balance, 0);
    }

    function test_TierBoundaries() public {
        _hours(20 ether, 24);
        (uint256 mc,, uint8 tier) = router.marketCap();
        assertApproxEqRel(mc, 20 ether, 1e12);
        // the boundary reading may round a hair either side; one wei of ETH above it is mid
        _hours(20.001 ether, 24);
        (, , tier) = router.marketCap();
        assertEq(tier, 1);
        _hours(19.999 ether, 24);
        (, , tier) = router.marketCap();
        assertEq(tier, 0);
        _hours(57.71 ether, 24);
        (, , tier) = router.marketCap();
        assertEq(tier, 2);
        _hours(57.69 ether, 24);
        (, , tier) = router.marketCap();
        assertEq(tier, 1);
    }

    /* ---------------- the 5% staked rule ---------------- */

    function test_StakeBelowTarget_Scales() public {
        vm.prank(alice);
        stake.requestUnstake(35_000_000 ether); // 2.5% of supply left staked: half the share
        _hours(30 ether, 24);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.stakeTarget, 50_000_000 ether);
        assertEq(s.totalStaked, 25_000_000 ether);
        assertEq(s.toStakers, 0.25 ether, "half of 0.5% of volume");
        assertEq(team.balance, 2.6 ether - 0.25 ether - 0.1 ether, "the unpaid half stays with the team");
    }

    function test_StakeAboveTarget_FullShare() public {
        _stake(alice, 100_000_000 ether);
        _hours(30 ether, 24);
        _fees(2.6 ether);
        assertEq(_run().toStakers, 0.5 ether);
    }

    function test_NoStakers_ShareToTeam() public {
        vm.prank(alice);
        stake.requestUnstake(60_000_000 ether);
        assertEq(stake.totalStaked(), 0);
        _hours(100 ether, 24);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run(); // TroyaStake.notifyReward would revert NoStakers: it is not called
        assertEq(s.toStakers, 0);
        assertEq(stake.totalRewarded(), 0);
        assertEq(team.balance, 2.6 ether - 0.1 ether - 0.1 ether);
    }

    function test_BelowMinimum_ToTeam() public {
        _hours(10 ether, 24);
        _fees(0.0005 ether); // stakers 10/260 = 0.0000192 < 0.00002, gas the same
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers, 0);
        assertEq(s.toGas, 0);
        assertEq(team.balance, 0.0005 ether, "nothing carried over: all to the team");
        assertEq(address(router).balance, 0);
    }

    function test_SmallStakeBelowMinimumAfterScaling_ToTeam() public {
        vm.prank(alice);
        stake.requestUnstake(59_999_000 ether); // 1,000 coins staked of a 50M target
        _hours(10 ether, 24);
        _fees(1 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers, 0, "scaled share under the minimum");
        assertEq(s.toGas, uint256(1 ether) * 10 / 260);
    }

    /* ---------------- rounding ---------------- */

    function testFuzz_SplitAddsUp(uint96 amount, uint8 tierSeed, uint96 staked) public {
        amount = uint96(bound(amount, 1, 1_000 ether));
        staked = uint96(bound(staked, 0, 59_000_000 ether));
        vm.prank(alice);
        stake.requestUnstake(60_000_000 ether);
        if (staked > 0) _stake(keeper, staked);
        uint256[3] memory mcs = [uint256(10 ether), 30 ether, 100 ether];
        _hours(mcs[tierSeed % 3], 24);
        _fees(amount);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers + s.toGas + s.toBurn + s.toTeam, amount, "every wei accounted for");
        assertEq(address(router).balance, router.burnReserve() + router.totalOwed(), "only the burn reserve and owed stay");
        assertLe(s.toStakers, (uint256(amount) * [10, 50, 100][s.tier]) / 260);
        assertEq(stake.totalRewarded(), s.toStakers);
        assertEq(team.balance, s.toTeam);
    }

    function test_DustGoesToTeam() public {
        _hours(100 ether, 24);
        uint256 amt = 0.001 ether + 3; // not divisible by 260
        _fees(amt);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers, (amt * 100) / 260);
        assertEq(s.toGas, (amt * 10) / 260);
        assertEq(s.toBurn, (amt * 10) / 260);
        assertEq(s.toTeam, amt - s.toStakers - s.toGas - s.toBurn);
        assertEq(s.toTeam, (amt * 140) / 260 + 2, "the rounding dust (2 wei here) goes to the team");
    }

    /* ---------------- permissionless, once per period ---------------- */

    function test_Distribute_PermissionlessOncePerDay() public {
        _hours(10 ether, 24);
        _fees(1 ether);
        vm.prank(makeAddr("random"));
        router.distribute();
        _fees(1 ether);
        uint256 next = (block.timestamp / 1 days + 1) * 1 days;
        assertEq(router.nextDistributionAt(), next);
        vm.expectRevert(abi.encodeWithSelector(TroyaFeeRouter.TooSoon.selector, next));
        router.distribute();
        vm.warp(next);
        vm.prank(makeAddr("someone-else"));
        router.distribute();
        assertEq(router.distributions(), 2);
    }

    function test_Distribute_NothingReverts() public {
        _hours(10 ether, 24);
        vm.expectRevert(TroyaFeeRouter.NothingToDistribute.selector);
        router.distribute();
        assertEq(router.lastDistribution(), 0, "a failed call does not use up the day");
    }

    function test_Distribute_SplitsDirectEthToo() public {
        _hours(10 ether, 24);
        vm.deal(address(this), 2.6 ether);
        (bool ok,) = address(router).call{value: 2.6 ether}("");
        assertTrue(ok);
        assertEq(_run().toStakers, 0.1 ether);
    }

    function test_Preview_MatchesDistribute() public {
        _hours(100 ether, 24);
        _fees(1.3 ether);
        TroyaFeeRouter.Split memory p = router.preview();
        TroyaFeeRouter.Split memory s = _run();
        assertEq(p.amount, s.amount);
        assertEq(p.toStakers, s.toStakers);
        assertEq(p.toGas, s.toGas);
        assertEq(p.toBurn, s.toBurn);
        assertEq(p.toTeam, s.toTeam);
        assertEq(p.tier, s.tier);
    }

    function test_Distribute_RevertsWhilePoolManagerUnlocked() public {
        _hours(10 ether, 24);
        _fees(1 ether);
        pm.setForceUnlocked(true);
        vm.expectRevert(TroyaFeeRouter.PoolManagerUnlocked.selector);
        router.distribute();
        vm.expectRevert(TroyaFeeRouter.PoolManagerUnlocked.selector);
        router.poke();
        vm.expectRevert(TroyaFeeRouter.PoolManagerUnlocked.selector);
        router.buyAndBurn();
    }

    /* ---------------- the market cap: hourly median ---------------- */

    function test_Median_TooFewReadsMeansLowestTier() public {
        _hours(100 ether, 11);
        (uint256 mc, uint256 n, uint8 tier) = router.marketCap();
        assertEq(n, 11);
        assertEq(mc, 0);
        assertEq(tier, 0);
        _fees(2.6 ether);
        vm.warp(block.timestamp + 1 hours); // distribute's own read makes 12
        assertEq(_run().tier, 2);
    }

    function test_Median_OnePumpedHourChangesNothing() public {
        _hours(10 ether, 23);
        _hours(10_000 ether, 1);
        (, uint256 n, uint8 tier) = router.marketCap();
        assertEq(n, 24);
        assertEq(tier, 0);
    }

    function test_Median_ElevenPumpedHoursChangeNothing() public {
        _hours(10 ether, 13);
        _hours(10_000 ether, 11);
        (,, uint8 tier) = router.marketCap();
        assertEq(tier, 0);
    }

    function test_Median_MajorityMovesTier() public {
        _hours(10 ether, 11);
        _hours(100 ether, 13);
        (,, uint8 tier) = router.marketCap();
        assertEq(tier, 2);
    }

    function test_Median_StaleReadsDropOut() public {
        _hours(100 ether, 24);
        vm.warp(block.timestamp + 13 hours);
        (, uint256 n, uint8 tier) = router.marketCap();
        assertEq(n, 11, "reads older than 24 hours do not count");
        assertEq(tier, 0);
    }

    function test_Poke_OncePerHour() public {
        vm.warp((block.timestamp / 1 hours + 1) * 1 hours);
        assertTrue(router.poke());
        assertFalse(router.poke());
        pm.setPrice(id, _sqrtForMc(1_000 ether));
        assertFalse(router.poke(), "the first read of the hour stands");
        (uint160 p,) = router.observation((block.timestamp / 1 hours) % 24);
        assertEq(p, _sqrtForMc(10 ether));
        vm.warp(block.timestamp + 1 hours);
        assertTrue(router.poke());
    }

    function test_Median_UsesSupplyMinusDead() public {
        _hours(10 ether, 24);
        (uint256 mc0,,) = router.marketCap();
        troya.transfer(router.DEAD(), 100_000_000 ether); // 10% sent to 0x...dEaD
        (uint256 mc1,,) = router.marketCap();
        assertApproxEqRel(mc1, (mc0 * 9) / 10, 1e9);
    }

    /* ---------------- the burn ---------------- */

    function test_Burn_SkippedWhenPricePumped_ThenRetried() public {
        _hours(100 ether, 24);
        pm.setPrice(id, _sqrtForMc(130 ether)); // $TROYA 30% above its median right now
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers, 1 ether, "stakers paid whatever happens to the burn");
        assertEq(router.burnReserve(), 0.1 ether, "the burn share waits, it does not go to the team");
        assertEq(team.balance, 1.4 ether);
        assertEq(address(router).balance, 0.1 ether);
        // still pumped: a retry does nothing
        (uint256 spent,) = router.buyAndBurn();
        assertEq(spent, 0);
        // back near the median: anyone can finish it
        pm.setPrice(id, _sqrtForMc(102 ether));
        vm.prank(keeper);
        (uint256 spent2, uint256 burned) = router.buyAndBurn();
        assertEq(spent2, 0.1 ether);
        assertGt(burned, 0);
        assertEq(router.burnReserve(), 0);
    }

    function test_Burn_BelowMinimumAccumulates() public {
        _hours(100 ether, 24);
        _fees(0.0104 ether); // burn share 0.0004 < 0.0005
        _run();
        assertEq(router.burnReserve(), 0.0004 ether);
        assertEq(router.totalBurnEthSpent(), 0);
        _nextDay();
        _hours(100 ether, 1);
        _fees(0.0104 ether);
        _run();
        assertEq(router.burnReserve(), 0, "0.0008 bought and burned once over the minimum");
        assertEq(router.totalBurnEthSpent(), 0.0008 ether);
    }

    function test_Burn_FailingSwapDoesNotBlockTheSplit() public {
        _hours(100 ether, 24);
        pm.setFailSwap(true);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.toStakers, 1 ether);
        assertEq(stake.totalRewarded(), 1 ether);
        assertEq(router.burnReserve(), 0.1 ether);
        pm.setFailSwap(false);
        router.buyAndBurn();
        assertEq(router.burnReserve(), 0);
    }

    function test_Burn_PriceLimitCapsImpact() public {
        _hours(100 ether, 24);
        // a big reserve: the buy stops at 5% above the starting price and the rest waits
        vm.deal(address(this), 260 ether);
        escrow.credit{value: 260 ether}(address(router));
        uint160 before = pm.priceOf(id);
        _run();
        uint160 afterP = pm.priceOf(id);
        uint256 k = Math.sqrt(uint256(9_500) * 1e36 / 10_000);
        assertApproxEqAbs(afterP, uint256(before) * k / 1e18, 2, "stopped at the limit");
        assertGt(router.burnReserve(), 0, "the unspent part waits");
        assertLt(router.burnReserve(), 10 ether);
        assertEq(address(router).balance, router.burnReserve());
    }

    function test_UnlockCallback_OnlyPoolManager() public {
        vm.expectRevert(TroyaFeeRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(uint256(1 ether), uint160(1)));
    }

    /* ---------------- payees that refuse or re-enter ---------------- */

    function test_Reentrancy_PayeeCannotReenter() public {
        Reenterer r = new Reenterer();
        TroyaFeeRouter.Config memory c = _cfg();
        c.team = address(r);
        router = _deploy(c);
        _hours(100 ether, 24);
        bytes4[4] memory sels = [router.distribute.selector, router.buyAndBurn.selector, router.poke.selector, TroyaFeeRouter.rescueToken.selector];
        for (uint256 i; i < 4; ++i) {
            if (i > 0) vm.warp(block.timestamp + 1 days);
            _hours(100 ether, 24);
            bytes memory payload = i == 3 ? abi.encodeWithSelector(sels[i], address(troya)) : abi.encodeWithSelector(sels[i]);
            r.set(router, payload);
            _fees(2.6 ether);
            _run();
            assertTrue(r.tried());
            assertFalse(r.innerOk(), "re-entry refused");
            assertEq(bytes4(r.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        }
        assertEq(address(r).balance, 4 * 1.4 ether, "paid once per run");
    }

    function test_RefusingPayee_IsOwedNotLost() public {
        Refuser bad = new Refuser();
        TroyaFeeRouter.Config memory c = _cfg();
        c.gasWallet = address(bad);
        router = _deploy(c);
        _hours(10 ether, 24);
        _fees(2.6 ether);
        _run();
        assertEq(router.owed(address(bad)), 0.1 ether);
        assertEq(router.totalOwed(), 0.1 ether);
        assertEq(stake.totalRewarded(), 0.1 ether, "stakers paid anyway");
        // what is owed is never split again
        _nextDay();
        _hours(10 ether, 1);
        _fees(2.6 ether);
        TroyaFeeRouter.Split memory s = _run();
        assertEq(s.amount, 2.6 ether);
        address payable dest = payable(makeAddr("gas-new"));
        vm.expectRevert(TroyaFeeRouter.ZeroAddress.selector);
        bad.withdraw(router, payable(address(0)));
        bad.withdraw(router, dest);
        assertEq(dest.balance, 0.2 ether);
        assertEq(router.totalOwed(), 0);
        vm.expectRevert(TroyaFeeRouter.NothingOwed.selector);
        bad.withdraw(router, dest);
    }

    /* ---------------- stray tokens ---------------- */

    function test_RescueToken_ToTeamOnly() public {
        Junk j = new Junk();
        j.transfer(address(router), 5 ether);
        vm.deal(address(router), 1 ether);
        vm.prank(keeper);
        router.rescueToken(address(j));
        assertEq(j.balanceOf(team), 5 ether);
        assertEq(address(router).balance, 1 ether, "ETH untouched");
        troya.transfer(address(router), 7 ether);
        router.rescueToken(address(troya));
        assertEq(troya.balanceOf(team), 7 ether);
    }

    /* ---------------- the 7-day timelock ---------------- */

    function test_Timelock_Config() public {
        TroyaFeeRouter.Config memory c = _cfg();
        c.stakerBps = [uint16(20), 60, 120];
        c.midMcWei = 25 ether;

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.proposeConfig(c);

        vm.prank(team);
        router.proposeConfig(c);
        (TroyaFeeRouter.Config memory p, uint256 eta) = router.pendingConfig();
        assertEq(eta, block.timestamp + 7 days);
        assertEq(p.midMcWei, 25 ether);
        assertEq(router.config().midMcWei, 20 ether, "nothing changes yet");

        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(TroyaFeeRouter.TimelockNotElapsed.selector, eta));
        router.executeConfig();

        vm.warp(eta);
        vm.prank(keeper); // anyone executes a matured proposal
        router.executeConfig();
        TroyaFeeRouter.Config memory now_ = router.config();
        assertEq(now_.midMcWei, 25 ether);
        assertEq(now_.stakerBps[2], 120);
        (, eta) = router.pendingConfig();
        assertEq(eta, 0);
        vm.expectRevert(TroyaFeeRouter.NothingPending.selector);
        router.executeConfig();
    }

    function test_Timelock_ConfigCancelAndExpiry() public {
        TroyaFeeRouter.Config memory c = _cfg();
        c.gasBps = 0;
        vm.startPrank(team);
        router.proposeConfig(c);
        router.cancelConfig();
        vm.stopPrank();
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(TroyaFeeRouter.NothingPending.selector);
        router.executeConfig();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.cancelConfig();

        vm.prank(team);
        router.proposeConfig(c);
        uint256 eta = block.timestamp + 7 days;
        vm.warp(eta + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TroyaFeeRouter.TimelockExpired.selector, eta + 7 days));
        router.executeConfig();
    }

    function test_Timelock_NewProposalRestartsClock() public {
        TroyaFeeRouter.Config memory c = _cfg();
        vm.prank(team);
        router.proposeConfig(c);
        vm.warp(block.timestamp + 6 days);
        c.gasBps = 20;
        vm.prank(team);
        router.proposeConfig(c);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        router.executeConfig();
        vm.warp(block.timestamp + 5 days);
        router.executeConfig();
        assertEq(router.config().gasBps, 20);
    }

    function test_Timelock_RecipientMove() public {
        address back = makeAddr("creator-wallet");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        router.proposeRecipientMove(back);
        vm.startPrank(team);
        vm.expectRevert(TroyaFeeRouter.BadPayee.selector);
        router.proposeRecipientMove(address(router));
        router.proposeRecipientMove(back);
        vm.stopPrank();
        uint256 eta = router.pendingRecipientEta();
        assertEq(eta, block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(TroyaFeeRouter.TimelockNotElapsed.selector, eta));
        router.executeRecipientMove();
        vm.warp(eta);
        vm.prank(keeper);
        router.executeRecipientMove();
        assertEq(factory.lastCaller(), address(router));
        assertEq(factory.lastToken(), address(troya));
        assertEq(factory.lastRecipient(), back);
        assertEq(router.pendingRecipient(), address(0));
    }

    function test_Timelock_RecipientMoveCancel() public {
        vm.startPrank(team);
        router.proposeRecipientMove(makeAddr("x"));
        router.cancelRecipientMove();
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(TroyaFeeRouter.NothingPending.selector);
        router.executeRecipientMove();
        assertEq(factory.lastCaller(), address(0));
    }

    function test_ConfigBounds() public {
        TroyaFeeRouter.Config memory c;
        vm.startPrank(team);
        c = _cfg(); c.stakerBps = [uint16(9), 50, 100];
        vm.expectRevert(TroyaFeeRouter.ShareOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.stakerBps = [uint16(10), 100, 50];
        vm.expectRevert(TroyaFeeRouter.ShareOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.stakerBps = [uint16(10), 50, 250];
        vm.expectRevert(TroyaFeeRouter.ShareOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.gasBps = 51;
        vm.expectRevert(TroyaFeeRouter.ShareOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.stakeTargetBps = 1_001;
        vm.expectRevert(TroyaFeeRouter.TargetOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.stakeTargetBps = 0;
        vm.expectRevert(TroyaFeeRouter.TargetOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.maxBurnSlippageBps = 2_001;
        vm.expectRevert(TroyaFeeRouter.SlippageOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.minInterval = 59 minutes;
        vm.expectRevert(TroyaFeeRouter.IntervalOutOfBounds.selector); router.proposeConfig(c);
        c = _cfg(); c.highMcWei = 1 ether;
        vm.expectRevert(TroyaFeeRouter.ThresholdsOutOfOrder.selector); router.proposeConfig(c);
        c = _cfg(); c.minSendWei = 0.0011 ether;
        vm.expectRevert(TroyaFeeRouter.MinimumTooHigh.selector); router.proposeConfig(c);
        c = _cfg(); c.team = address(0);
        vm.expectRevert(TroyaFeeRouter.ZeroAddress.selector); router.proposeConfig(c);
        c = _cfg(); c.gasWallet = address(router);
        vm.expectRevert(TroyaFeeRouter.BadPayee.selector); router.proposeConfig(c);
        vm.stopPrank();
    }

    /* ---------------- ownership and deploy checks ---------------- */

    function test_CannotRenounce_TwoStepTransfer() public {
        vm.prank(team);
        vm.expectRevert(TroyaFeeRouter.CannotRenounce.selector);
        router.renounceOwnership();
        address next = makeAddr("safe");
        vm.prank(team);
        router.transferOwnership(next);
        assertEq(router.owner(), team, "two steps");
        vm.prank(next);
        router.acceptOwnership();
        assertEq(router.owner(), next);
    }

    function test_Constructor_Checks() public {
        TroyaStake other = new TroyaStake(address(new Junk()));
        vm.expectRevert(TroyaFeeRouter.WrongStakeToken.selector);
        new TroyaFeeRouter(team, address(troya), address(other), address(escrow), address(pm), address(factory), hookAddr, 0, 200, 260, _cfg());
        vm.expectRevert(TroyaFeeRouter.PoolNotInitialized.selector);
        new TroyaFeeRouter(team, address(troya), address(stake), address(escrow), address(pm), address(factory), hookAddr, 0, 60, 260, _cfg());
        assertEq(router.poolId(), id);
        assertEq(router.creatorBps(), 260);
    }
}
