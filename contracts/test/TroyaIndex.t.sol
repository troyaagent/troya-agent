// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TroyaIndex} from "../src/TroyaIndex.sol";
import {TroyaIndexSwapper, Venue} from "../src/TroyaIndexSwapper.sol";
import {TroyaIndexZap} from "../src/TroyaIndexZap.sol";
import {
    MockWETH,
    MockToken,
    EvilToken,
    MockV3Pool,
    MockV3Factory,
    MockPoolManagerLite,
    EthRefuser,
    EthReenterer
} from "./TroyaIndexMocks.sol";

/// shared fixture: a vault with ETH + TOKA (18 dec) + USDX (6 dec) + EVIL, and four Uniswap v3 pools from the factory:
/// ETH/TOKA (1 ETH = 1000 TOKA), ETH/USDX (1 ETH = 2000 USDX), TOKA/USDX (1 TOKA = 2 USDX), ETH/EVIL (1:1)
abstract contract IndexFixture is Test {
    uint256 constant START = 1_795_500_000; // 23 Nov 2026
    uint256 constant Q96 = 1 << 96;

    MockWETH weth;
    MockV3Factory factory;
    MockPoolManagerLite pm;
    MockToken toka;
    MockToken usdx;
    EvilToken evil;
    MockV3Pool poolA; // ETH/TOKA
    MockV3Pool poolU; // ETH/USDX
    MockV3Pool poolAU; // TOKA/USDX
    MockV3Pool poolE; // ETH/EVIL
    TroyaIndexSwapper swapper;
    TroyaIndex vault;
    TroyaIndexZap zap;

    address safe = makeAddr("safe-2of2");
    address keeper = makeAddr("keeper");
    address guardian = makeAddr("guardian");
    address feeTo = makeAddr("fee-router");
    address mgmtTo = makeAddr("creator-mgmt-fee");
    address ponsHook = makeAddr("pons-hook");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address eve = makeAddr("eve");

    bool zfA; // venue A: true when selling ETH is zeroForOne
    uint256 constant V_A = 0;
    uint256 constant V_U = 1;
    uint256 constant V_AU = 2;
    uint256 constant V_E = 3;

    function setUp() public virtual {
        vm.warp(START);
        weth = new MockWETH();
        factory = new MockV3Factory();
        pm = new MockPoolManagerLite();
        toka = new MockToken("TOKA", 18);
        usdx = new MockToken("USDX", 6);
        evil = new EvilToken();
        poolA = _pool(address(weth), address(toka), 1_000 ether, 1_000_000 ether, 3000);
        poolU = _pool(address(weth), address(usdx), 1_000 ether, 2_000_000e6, 500);
        poolAU = _pool(address(toka), address(usdx), 1_000_000 ether, 2_000_000e6, 3000);
        poolE = _pool(address(weth), address(evil), 1_000 ether, 1_000 ether, 3000);
        swapper = new TroyaIndexSwapper(address(weth), address(factory), address(pm), ponsHook);
        vault = new TroyaIndex(_init());
        zap = new TroyaIndexZap(vault);
        zfA = vault.getVenue(V_A).asset0 == address(0);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.deal(eve, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
    }

    function _init() internal view returns (TroyaIndex.Init memory p) {
        p.owner = safe;
        p.swapper = address(swapper);
        p.keeper = keeper;
        p.guardian = guardian;
        p.feeRecipient = feeTo;
        p.feeBps = 50;
        p.mgmtFeeRecipient = mgmtTo;
        p.mgmtFeeBps = 100;
        p.totalCap = 100 ether;
        p.walletCap = 50 ether;
        p.maxMoveBps = 2_000;
        p.cooldown = 4 hours;
        p.assets = new address[](3);
        p.assets[0] = address(toka);
        p.assets[1] = address(usdx);
        p.assets[2] = address(evil);
        p.venues = new TroyaIndex.VenueInput[](4);
        p.venues[0] = _v3(poolA, 200);
        p.venues[1] = _v3(poolU, 150);
        p.venues[2] = _v3(poolAU, 300);
        p.venues[3] = _v3(poolE, 200);
    }

    function _v3(MockV3Pool p, uint16 slip) internal pure returns (TroyaIndex.VenueInput memory v) {
        v.kind = 1;
        v.pool = address(p);
        v.slippageBps = slip;
    }

    /// a pool holding `ra` of a and `rb` of b, priced at their ratio, with liquidity sqrt(ra * rb)
    function _pool(address a, address b, uint256 ra, uint256 rb, uint24 fee) internal returns (MockV3Pool p) {
        (address t0, uint256 r0, uint256 r1) = a < b ? (a, ra, rb) : (b, rb, ra);
        uint160 s = uint160(Math.sqrt(Math.mulDiv(r1, 1 << 192, r0)));
        p = factory.createPool(a, b, fee, s, uint128(Math.sqrt(ra * rb)));
        _fund(a, address(p), ra);
        _fund(b, address(p), rb);
        t0;
    }

    function _fund(address token, address to, uint256 amount) internal {
        if (token == address(weth)) {
            vm.deal(address(this), amount);
            weth.deposit{value: amount}();
            weth.transfer(to, amount);
        } else if (token == address(evil)) {
            evil.mint(to, amount);
        } else {
            MockToken(token).mint(to, amount);
        }
    }

    /// `n` hourly reads of every venue, one per hour
    function _hours(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.warp(block.timestamp + 1 hours);
            vault.pokeAll();
        }
    }

    function _dir(uint256 venueId, address assetIn) internal view returns (bool) {
        return vault.getVenue(venueId).asset0 == assetIn;
    }

    function _rebalance(uint256 venueId, address assetIn, uint256 amount) internal returns (uint256 spent, uint256 got) {
        bool zf = _dir(venueId, assetIn);
        vm.prank(keeper);
        return vault.rebalance(venueId, zf, amount, 0);
    }

    function _depositEth(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return vault.depositEth{value: amount}(0, who);
    }

    /// seed: alice 10 ETH, then the keeper buys TOKA and USDX so the vault holds a real basket
    function _seedBasket() internal {
        _depositEth(alice, 10 ether);
        _hours(13);
        _rebalance(V_A, address(0), 1.9 ether);
        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
        _rebalance(V_U, address(0), 1.5 ether);
        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
    }

    function _assetsLen() internal view returns (uint256) {
        return vault.assets().length;
    }

    /// in-kind deposit of `shares` by `who`: mints the needed tokens to it, approves, sends ETH + fee
    function _depositInKind(address who, uint256 shares) internal returns (uint256[] memory amounts) {
        (uint256[] memory need, uint256 fee) = vault.previewDeposit(shares);
        address[] memory list = vault.assets();
        vm.startPrank(who);
        for (uint256 i = 1; i < list.length; ++i) {
            if (need[i] == 0) continue;
            vm.stopPrank();
            _fund(list[i], who, need[i]);
            vm.startPrank(who);
            IERC20(list[i]).approve(address(vault), need[i]);
        }
        (amounts,) = vault.deposit{value: need[0] + fee}(shares, who, need);
        vm.stopPrank();
    }

    function _propose(TroyaIndex.Op op, bytes memory data) internal {
        vm.prank(safe);
        vault.propose(op, data);
    }

    function _proposeAndExecute(TroyaIndex.Op op, bytes memory data) internal {
        _propose(op, data);
        vm.warp(block.timestamp + 48 hours);
        vault.execute(op, data);
    }
}

contract TroyaIndexTest is IndexFixture {
    /* ---------------- constructor and limits ---------------- */

    function test_Constructor_State() public view {
        assertEq(vault.name(), "Troya Index");
        assertEq(vault.symbol(), "TIDX");
        assertEq(vault.decimals(), 18);
        assertEq(vault.owner(), safe);
        address[] memory a = vault.assets();
        assertEq(a.length, 4);
        assertEq(a[0], address(0));
        assertEq(a[1], address(toka));
        assertEq(vault.venueCount(), 4);
        Venue memory v = vault.getVenue(V_A);
        assertTrue(v.active);
        assertTrue(v.asset0 == address(0) || v.asset1 == address(0), "WETH side is ETH to the vault");
        assertEq(vault.totalCap(), 100 ether);
        assertEq(vault.feeBps(), 50);
        assertEq(address(vault.swapper()), address(swapper));
        assertEq(vault.weth(), address(weth));
    }

    function test_Constructor_RejectsOutOfBounds() public {
        TroyaIndex.Init memory p = _init();
        p.feeBps = 201;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);

        p = _init();
        p.walletCap = p.totalCap + 1;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);

        p = _init();
        p.maxMoveBps = 5_001;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);

        p = _init();
        p.cooldown = 59 minutes;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);

        p = _init();
        p.feeRecipient = address(0);
        vm.expectRevert(TroyaIndex.ZeroAddress.selector);
        new TroyaIndex(p);

        p = _init();
        p.owner = address(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TroyaIndex(p);
    }

    function test_Constructor_RejectsBadAssets() public {
        TroyaIndex.Init memory p = _init();
        p.assets[0] = address(weth); // WETH is ETH
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        new TroyaIndex(p);

        p = _init();
        p.assets[0] = makeAddr("eoa"); // no code
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        new TroyaIndex(p);

        p = _init();
        p.assets[1] = address(toka); // twice
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        new TroyaIndex(p);

        p = _init();
        p.venues = new TroyaIndex.VenueInput[](0);
        p.assets = new address[](8); // 8 + ETH = 9 > MAX_ASSETS
        for (uint256 i; i < 8; ++i) { MockToken t = new MockToken("T", 18); t.mint(address(this), 1); p.assets[i] = address(t); }
        vm.expectRevert(TroyaIndex.TooMany.selector);
        new TroyaIndex(p);

        // a token with no supply is not an asset (the ERC-20 probe reads must answer sensibly)
        p = _init();
        p.assets[0] = address(new MockToken("EMPTY", 18));
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        new TroyaIndex(p);
    }

    function test_Swapper_RejectsZeroAddresses() public {
        vm.expectRevert(TroyaIndexSwapper.ZeroAddress.selector);
        new TroyaIndexSwapper(address(weth), address(factory), address(pm), address(0));
        vm.expectRevert(TroyaIndexSwapper.ZeroAddress.selector);
        new TroyaIndexSwapper(address(0), address(factory), address(pm), ponsHook);
    }

    function test_Constructor_RejectsBadVenues() public {
        // a pool that looks right but is not the factory's
        MockV3Pool fake = new MockV3Pool(poolA.token0(), poolA.token1(), 3000, poolA.sqrtPriceX96(), 1e22);
        TroyaIndex.Init memory p = _init();
        p.venues[0] = _v3(fake, 200);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        new TroyaIndex(p);

        // a pool of an unlisted token
        MockToken other = new MockToken("OTHER", 18);
        MockV3Pool po = _pool(address(weth), address(other), 10 ether, 10 ether, 3000);
        p = _init();
        p.venues[0] = _v3(po, 200);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        new TroyaIndex(p);

        // slippage out of bounds
        p = _init();
        p.venues[0].slippageBps = 0;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);
        p.venues[0].slippageBps = 1_001;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);

        // the same pool twice
        p = _init();
        p.venues[1] = _v3(poolA, 200);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        new TroyaIndex(p);

        // v4: a hook other than none / Pons
        p = _init();
        p.venues[0] = TroyaIndex.VenueInput(2, address(0), address(0), address(toka), 0, 200, makeAddr("evil-hook"), 400);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        new TroyaIndex(p);

        // v4: the Pons hook but the pool is not initialized
        p.venues[0] = TroyaIndex.VenueInput(2, address(0), address(0), address(toka), 0, 200, ponsHook, 400);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        new TroyaIndex(p);

        // v4: initialized Pons pool is accepted
        bytes32 id = keccak256(abi.encode(address(0), address(toka), uint24(0), int24(200), ponsHook));
        pm.setPrice(id, uint160(Q96 * 31));
        TroyaIndex ok = new TroyaIndex(p);
        assertEq(ok.venueOf(id), 1);
        assertEq(ok.getVenue(0).asset0, address(0));
    }

    /* ---------------- deposits ---------------- */

    function test_FirstDeposit_DeadSharesAndFee() public {
        uint256 s = _depositEth(alice, 1 ether);
        uint256 fee = 1 ether * 50 / 10_000;
        assertEq(s, 1 ether - fee - vault.DEAD_SHARES());
        assertEq(vault.balanceOf(vault.DEAD()), vault.DEAD_SHARES());
        assertEq(vault.totalSupply(), 1 ether - fee, "1 share per wei of ETH after the fee");
        assertEq(vault.feesAccrued(), fee);
        assertEq(vault.holdings(address(0)), 1 ether - fee);
    }

    function test_FirstDeposit_TooSmall() public {
        vm.prank(alice);
        vm.expectRevert(TroyaIndex.FirstDepositTooSmall.selector);
        vault.depositEth{value: 0.001 ether}(0, alice); // 0.001 minus the fee is under the minimum
    }

    function test_DepositEth_ProportionalAfterDonation() public {
        _depositEth(alice, 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}(""); // a donation doubles the ETH per share
        assertTrue(ok);
        uint256 supply = vault.totalSupply();
        uint256 held = vault.holdings(address(0));
        uint256 s = _depositEth(bob, 2 ether);
        uint256 net = 2 ether - (2 ether * 50) / 10_000;
        assertEq(s, (net * supply) / held);
        // bob can take out what he put in (minus fee and at most one share of rounding)
        vm.prank(bob);
        uint256[] memory out = vault.redeem(s, bob);
        assertApproxEqAbs(out[0], net, 2, "fair price");
    }

    function test_DepositEth_MinSharesStopsFrontRun() public {
        _depositEth(alice, 1 ether);
        (uint256 expected,) = vault.previewDepositEth(1 ether);
        (bool ok,) = address(vault).call{value: 5 ether}(""); // someone front-runs with a donation
        assertTrue(ok);
        vm.prank(bob);
        vm.expectRevert();
        vault.depositEth{value: 1 ether}(expected, bob);
    }

    function test_DepositEth_ClosedOnceATokenIsHeld() public {
        _seedBasket();
        vm.expectRevert(TroyaIndex.NotEthOnly.selector);
        vault.previewDepositEth(1 ether);
        vm.prank(bob);
        vm.expectRevert(TroyaIndex.NotEthOnly.selector);
        vault.depositEth{value: 1 ether}(0, bob);
    }

    function test_DepositInKind_ExactProportionsAndRefund() public {
        _seedBasket();
        vault.accrue(); // the management fee due so far, so the supply read below is the one the deposit prices against
        uint256 supply = vault.totalSupply();
        uint256 hEth = vault.holdings(address(0));
        uint256 hA = vault.holdings(address(toka));
        uint256 hU = vault.holdings(address(usdx));
        uint256 shares = 1 ether;
        (uint256[] memory need, uint256 fee) = vault.previewDeposit(shares);
        assertEq(need[0], Math.mulDiv(hEth, shares, supply, Math.Rounding.Ceil));
        assertEq(need[1], Math.mulDiv(hA, shares, supply, Math.Rounding.Ceil));
        assertEq(need[2], Math.mulDiv(hU, shares, supply, Math.Rounding.Ceil));
        assertEq(need[3], 0, "EVIL not held");
        assertEq(fee, (need[0] * 50) / 10_000, "fee on the ETH part");

        toka.mint(bob, need[1]);
        usdx.mint(bob, need[2]);
        vm.startPrank(bob);
        toka.approve(address(vault), need[1]);
        usdx.approve(address(vault), need[2]);
        uint256 eth0 = bob.balance;
        vault.deposit{value: need[0] + fee + 3 ether}(shares, bob, need);
        vm.stopPrank();
        assertEq(eth0 - bob.balance, need[0] + fee, "spare ETH refunded");
        assertEq(vault.balanceOf(bob), shares);
        // no dilution: every holding per share is at least what it was
        uint256 s2 = vault.totalSupply();
        assertGe(vault.holdings(address(0)) * supply, hEth * s2);
        assertGe(vault.holdings(address(toka)) * supply, hA * s2);
        assertGe(vault.holdings(address(usdx)) * supply, hU * s2);
    }

    function test_DepositInKind_Guards() public {
        _seedBasket();
        (uint256[] memory need, uint256 fee) = vault.previewDeposit(1 ether);
        uint256[] memory short = new uint256[](3);
        vm.prank(bob);
        vm.expectRevert(TroyaIndex.WrongLength.selector);
        vault.deposit{value: 10 ether}(1 ether, bob, short);

        uint256[] memory tight = new uint256[](4);
        tight[1] = need[1] - 1;
        tight[2] = need[2];
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.AboveMax.selector, address(toka), need[1], need[1] - 1));
        vault.deposit{value: 10 ether}(1 ether, bob, tight);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.NotEnoughEth.selector, need[0] + fee, need[0]));
        vault.deposit{value: need[0]}(1 ether, bob, need);

        // no approval: the pull fails, nothing minted
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit{value: need[0] + fee}(1 ether, bob, need);
    }

    function test_DepositInKind_FeeOnTransferRefused() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        _rebalance(V_E, address(0), 1 ether); // the vault now holds EVIL
        evil.setMode(EvilToken.Mode.FeeOnTransfer);
        (uint256[] memory need, uint256 fee) = vault.previewDeposit(1 ether);
        evil.mint(bob, need[3] * 2);
        vm.startPrank(bob);
        evil.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.ReceivedLess.selector, address(evil), need[3], need[3] - need[3] / 100));
        vault.deposit{value: need[0] + fee}(1 ether, bob, need);
        vm.stopPrank();
    }

    function test_Caps_TotalAndWallet() public {
        _depositEth(alice, 40 ether);
        vm.prank(alice);
        vm.expectRevert(TroyaIndex.WalletCapExceeded.selector);
        vault.depositEth{value: 15 ether}(0, alice);
        // cannot dodge the wallet cap by naming the same receiver from another wallet
        vm.prank(bob);
        vm.expectRevert(TroyaIndex.WalletCapExceeded.selector);
        vault.depositEth{value: 15 ether}(0, alice);
        _depositEth(bob, 50 ether);
        // total cap: 100 shares-ETH
        vm.prank(carol);
        vm.expectRevert(TroyaIndex.TotalCapExceeded.selector);
        vault.depositEth{value: 20 ether}(0, carol);
        // donations raise the value, never the supply: the cap stays a share cap
        (bool ok,) = address(vault).call{value: 500 ether}("");
        assertTrue(ok);
        assertLe(vault.totalSupply(), vault.totalCap());
    }

    function test_Caps_TransferThenDepositStillCapped() public {
        _depositEth(alice, 45 ether);
        uint256 s = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(bob, s); // shares are a plain ERC-20
        vm.prank(bob);
        vm.expectRevert(TroyaIndex.WalletCapExceeded.selector);
        vault.depositEth{value: 10 ether}(0, bob);
    }

    function test_Pause_DepositsAndRebalancesOnly_WithdrawalsOpen() public {
        _seedBasket();
        vm.prank(guardian);
        vault.pause();
        vm.prank(bob);
        vm.expectRevert(TroyaIndex.DepositsPaused.selector);
        vault.depositEth{value: 1 ether}(0, bob);
        vm.warp(block.timestamp + 5 hours);
        vm.prank(keeper);
        vm.expectRevert(TroyaIndex.RebalancesPaused.selector);
        vault.rebalance(V_A, zfA, 0.1 ether, 0);
        // withdrawals: always
        uint256 s = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(s, alice);
        assertEq(vault.balanceOf(alice), 0);
        // the guardian cannot resume; the owner can
        vm.prank(guardian);
        vm.expectRevert();
        vault.setPaused(false, false);
        vm.prank(safe);
        vault.setPaused(false, false);
        assertFalse(vault.depositsPaused());
    }

    function test_InflationAttack_IsHarmless() public {
        // eve is first, with the minimum, then redeems down to a single share and donates 100 ETH
        vm.prank(eve);
        uint256 s = vault.depositEth{value: 0.002 ether}(0, eve);
        vm.prank(eve);
        vault.redeem(s - 1, eve);
        assertEq(vault.totalSupply(), vault.DEAD_SHARES() + 1);
        vm.prank(eve);
        (bool ok,) = address(vault).call{value: 100 ether}("");
        assertTrue(ok);
        // bob deposits 1 ETH: he gets shares (never zero), and can take out his money minus at most one share
        uint256 shares = _depositEth(bob, 1 ether);
        assertGt(shares, 0);
        uint256 net = 1 ether - (1 ether * 50) / 10_000;
        uint256 shareValue = vault.holdings(address(0)) / vault.totalSupply();
        vm.prank(bob);
        uint256[] memory out = vault.redeem(shares, bob);
        assertGe(out[0] + shareValue + 1, net, "bob loses at most one share of rounding");
        assertLt(shareValue, 1e12, "one share is worth < 0.000001 ETH even after a 100 ETH donation");
        // and the donation went mostly to the dead shares, not back to eve
        vm.prank(eve);
        uint256[] memory e = vault.redeem(1, eve);
        assertLt(e[0], 1 ether);
    }

    function test_Fees_FlushToRecipient() public {
        _depositEth(alice, 10 ether);
        uint256 f = vault.feesAccrued();
        assertEq(f, 0.05 ether);
        vm.prank(eve);
        vault.flushFees();
        assertEq(feeTo.balance, f);
        assertEq(vault.feesAccrued(), 0);
        vm.expectRevert(TroyaIndex.ZeroAmount.selector);
        vault.flushFees();
    }

    /* ---------------- withdrawals ---------------- */

    function test_Redeem_InKindProRata() public {
        _seedBasket();
        _depositInKind(bob, 2 ether);
        vault.accrue();
        uint256 supply = vault.totalSupply();
        uint256 hEth = vault.holdings(address(0));
        uint256 hA = vault.holdings(address(toka));
        uint256 hU = vault.holdings(address(usdx));
        uint256 s = vault.balanceOf(alice);
        uint256 e0 = alice.balance;
        vm.prank(alice);
        uint256[] memory out = vault.redeem(s, alice);
        assertEq(out[0], (hEth * s) / supply);
        assertEq(out[1], (hA * s) / supply);
        assertEq(out[2], (hU * s) / supply);
        assertEq(alice.balance - e0, out[0]);
        assertEq(toka.balanceOf(alice), out[1]);
        assertEq(usdx.balanceOf(alice), out[2]);
        // bob, then nothing but the dead shares' dust is left
        uint256 sb = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(sb, bob);
        assertEq(vault.totalSupply(), vault.DEAD_SHARES() + vault.balanceOf(mgmtTo), "the dead shares and the fee recipient's");
        assertGt(vault.balanceOf(mgmtTo), 0, "the management fee was paid in TIDX");
    }

    function _evilBasket() internal {
        _depositEth(alice, 10 ether);
        _depositEth(bob, 10 ether);
        _hours(13);
        _rebalance(V_E, address(0), 2 ether);
        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
        _rebalance(V_A, address(0), 2 ether);
    }

    function _redeemAllWithEvilMode(EvilToken.Mode m) internal {
        _evilBasket();
        evil.setMode(m);
        uint256 s = vault.balanceOf(alice);
        uint256[] memory exp = vault.previewRedeem(s);
        uint256 e0 = alice.balance;
        vm.prank(alice);
        vault.redeem{gas: 3_000_000}(s, alice);
        assertEq(alice.balance - e0, exp[0], "ETH arrived");
        assertEq(toka.balanceOf(alice), exp[1], "TOKA arrived");
        assertEq(vault.owed(alice, address(evil)), exp[3], "EVIL kept for alice");
        assertEq(vault.totalOwed(address(evil)), exp[3]);
        assertEq(vault.balanceOf(alice), 0);
        // the kept EVIL is not counted for the remaining holders
        assertEq(vault.holdings(address(evil)), evil.balanceOf(address(vault)) - exp[3]);
        // bob still exits fine, and alice claims once the token works again
        uint256 sb = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem{gas: 3_000_000}(sb, bob);
        evil.setMode(EvilToken.Mode.Normal);
        vm.prank(alice);
        vault.claimOwed(address(evil), carol);
        assertEq(evil.balanceOf(carol), exp[3]);
        assertEq(vault.owed(alice, address(evil)), 0);
        vm.prank(alice);
        vm.expectRevert(TroyaIndex.NothingOwed.selector);
        vault.claimOwed(address(evil), carol);
    }

    function test_Redeem_RevertingToken_SkippedAndKept() public { _redeemAllWithEvilMode(EvilToken.Mode.Revert); }
    function test_Redeem_GasBurningToken_SkippedAndKept() public { _redeemAllWithEvilMode(EvilToken.Mode.BurnGas); }
    function test_Redeem_ReturnBombToken_SkippedAndKept() public { _redeemAllWithEvilMode(EvilToken.Mode.ReturnBomb); }
    function test_Redeem_FalseReturningToken_SkippedAndKept() public { _redeemAllWithEvilMode(EvilToken.Mode.ReturnFalse); }

    function test_Redeem_ReentrantTokenIsBlocked() public {
        _evilBasket();
        uint256 s = vault.balanceOf(alice);
        // the token tries to re-enter redeem (as itself) mid-transfer
        evil.arm(address(vault), abi.encodeWithSignature("redeem(uint256,address)", 1, address(evil)));
        vm.prank(alice);
        vault.redeem(s, alice);
        assertFalse(evil.innerOk());
        assertEq(bytes4(evil.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(vault.balanceOf(alice), 0);
        assertGt(evil.balanceOf(alice), 0, "the transfer itself went through");
    }

    function test_Redeem_ReceiverRefusingEth_KeptAndClaimedElsewhere() public {
        _depositEth(alice, 2 ether);
        EthRefuser r = new EthRefuser();
        uint256 s = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(address(r), s);
        uint256[] memory exp = vault.previewRedeem(s);
        r.redeem(address(vault), s);
        assertEq(vault.owed(address(r), address(0)), exp[0]);
        assertEq(vault.holdings(address(0)) + vault.totalOwed(address(0)) + vault.feesAccrued(), address(vault).balance);
        r.claim(address(vault), address(0), carol);
        assertEq(carol.balance, 1_000 ether + exp[0]);
    }

    function test_Redeem_EthReentryBlocked() public {
        _depositEth(alice, 2 ether);
        EthReenterer r = new EthReenterer();
        uint256 s = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(address(r), s);
        r.set(address(vault), abi.encodeWithSignature("redeem(uint256,address)", 1, address(r)));
        r.redeem(s / 2);
        assertTrue(r.tried());
        assertFalse(r.innerOk());
        assertEq(bytes4(r.innerErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(vault.balanceOf(address(r)), s - s / 2);
    }

    function test_Redeem_HostileOwnerCannotStopIt() public {
        _seedBasket();
        vm.startPrank(safe);
        vault.setPaused(true, true);
        vault.propose(TroyaIndex.Op.Keeper, abi.encode(address(0)));
        vault.propose(TroyaIndex.Op.Caps, abi.encode(uint256(1), uint256(1)));
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        vault.execute(TroyaIndex.Op.Keeper, abi.encode(address(0)));
        vault.execute(TroyaIndex.Op.Caps, abi.encode(uint256(1), uint256(1)));
        uint256 s = vault.balanceOf(alice);
        vm.prank(alice);
        uint256[] memory out = vault.redeem(s, alice);
        assertGt(out[0], 0);
        assertGt(out[1], 0);
        assertGt(out[2], 0);
    }

    /* ---------------- rebalance ---------------- */

    function test_Rebalance_EthToToken() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        uint256 eth0 = vault.holdings(address(0));
        (uint160 m,) = vault.medianSqrtPrice(V_A);
        bool zf = _dir(V_A, address(0));
        vm.prank(keeper);
        (uint256 spent, uint256 got) = vault.rebalance(V_A, zf, 1 ether, 0);
        assertEq(spent, 1 ether);
        assertApproxEqRel(got, 1_000 ether, 0.01e18, "~1000 TOKA for 1 ETH");
        assertEq(vault.holdings(address(0)), eth0 - 1 ether);
        assertEq(toka.balanceOf(address(vault)), got);
        assertEq(weth.balanceOf(address(vault)), 0, "never holds WETH");
        assertEq(weth.balanceOf(address(swapper)), 0);
        assertEq(address(swapper).balance, 0, "swapper holds nothing after");
        assertEq(toka.balanceOf(address(swapper)), 0);
        assertEq(vault.lastRebalanceAt(), block.timestamp);
        assertGt(m, 0);
    }

    function test_Rebalance_TokenToTokenAndBack() public {
        _seedBasket();
        uint256 a0 = toka.balanceOf(address(vault));
        uint256 u0 = usdx.balanceOf(address(vault));
        (uint256 spent, uint256 got) = _rebalance(V_AU, address(toka), a0 / 10);
        assertEq(spent, a0 / 10);
        assertApproxEqRel(got, (a0 / 10) * 2 / 1e12, 0.01e18, "2 USDX per TOKA");
        assertEq(usdx.balanceOf(address(vault)), u0 + got);
        vm.warp(block.timestamp + 4 hours);
        (spent, got) = _rebalance(V_U, address(usdx), usdx.balanceOf(address(vault)) / 5);
        assertGt(got, 0, "USDX back to ETH");
    }

    function test_Rebalance_OnlyKeeper() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        address[4] memory who = [safe, guardian, alice, address(this)];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(TroyaIndex.NotKeeper.selector);
            vault.rebalance(V_A, true, 0.1 ether, 0);
        }
    }

    function test_Rebalance_CooldownAndMoveCap() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        uint256 held = vault.holdings(address(0));
        bool zf = _dir(V_A, address(0));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.MoveTooLarge.selector, held * 2_000 / 10_000 + 1, held * 2_000 / 10_000));
        vault.rebalance(V_A, zf, held * 2_000 / 10_000 + 1, 0);
        vm.prank(keeper);
        vault.rebalance(V_A, zf, held * 2_000 / 10_000, 0);
        vm.warp(block.timestamp + 4 hours - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.CooldownActive.selector, block.timestamp + 1));
        vault.rebalance(V_A, zf, 0.1 ether, 0);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        vault.rebalance(V_A, zf, 0.1 ether, 0);
    }

    function test_Rebalance_NeedsTwelveHourlyReads() public {
        _depositEth(alice, 10 ether);
        _hours(11); // the rebalance runs in the hour of the last read, so it adds none
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.NotEnoughObservations.selector, 11));
        vault.rebalance(V_A, zfA, 0.1 ether, 0);
    }

    function test_Rebalance_PumpedSpotCannotBeUsed_EvenWithMinOutZero() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        bool zf = _dir(V_A, address(0));
        // someone moves the pool 10% against the vault right before the keeper's trade (a sandwich)
        uint160 s = poolA.sqrtPriceX96();
        uint160 bad = zf ? uint160((uint256(s) * 95) / 100) : uint160((uint256(s) * 105) / 100);
        poolA.setPrice(bad);
        vm.prank(keeper);
        vm.expectRevert(); // the price limit (median - 2%) is already crossed: the pool refuses ("SPL")
        vault.rebalance(V_A, zf, 1 ether, 0);
    }

    function test_Rebalance_FloorHoldsWithThinPool() public {
        // a thin TOKA pool: 2 ETH of size moves it far past the 2% band; the swap stops at the band (partial fill)
        _depositEth(alice, 40 ether);
        _hours(13);
        TroyaIndex.VenueInput memory vi;
        MockToken thin = new MockToken("THIN", 18);
        MockV3Pool p = _pool(address(weth), address(thin), 5 ether, 5_000 ether, 3000);
        _proposeAndExecute(TroyaIndex.Op.AddAsset, abi.encode(address(thin)));
        vi = _v3(p, 200);
        _proposeAndExecute(TroyaIndex.Op.AddVenue, abi.encode(vi));
        uint256 id = vault.venueCount() - 1;
        _hours(13);
        bool zf = _dir(id, address(0));
        uint256 e0 = vault.holdings(address(0));
        vm.prank(keeper);
        (uint256 spent, uint256 got) = vault.rebalance(id, zf, 5 ether, 0);
        assertLt(spent, 5 ether, "stopped at the band: partial fill");
        assertEq(vault.holdings(address(0)), e0 - spent, "the unspent ETH came back");
        (uint160 m,) = vault.medianSqrtPrice(id);
        uint256 fair = zf ? Math.mulDiv(Math.mulDiv(spent, m, Q96), m, Q96) : Math.mulDiv(Math.mulDiv(spent, Q96, m), Q96, m);
        assertGe(got, (fair * 9_800) / 10_000, "never under median - 2%");
    }

    function test_Rebalance_MinOutAboveFloor() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        vm.prank(keeper);
        vm.expectRevert();
        vault.rebalance(V_A, zfA, 1 ether, 2_000 ether);
    }

    function test_Rebalance_MedianIgnoresElevenBadHours() public {
        _depositEth(alice, 10 ether);
        _hours(13); // 13 honest hours
        uint160 honest = poolA.sqrtPriceX96();
        for (uint256 i; i < 11; ++i) {
            vm.warp(block.timestamp + 1 hours);
            poolA.setPrice(uint160((uint256(honest) * 3) / 2));
            vault.pokeAll();
            poolA.setPrice(honest);
        }
        (uint160 m, uint256 n) = vault.medianSqrtPrice(V_A);
        assertEq(n, 24);
        assertEq(m, honest, "11 of 24 pumped hours do not move the median");
    }

    function test_Rebalance_StaleReadsExpire() public {
        _depositEth(alice, 10 ether);
        _hours(13);
        vm.warp(block.timestamp + 2 days); // nobody poked for two days
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.NotEnoughObservations.selector, 1));
        vault.rebalance(V_A, zfA, 0.1 ether, 0);
    }

    function test_Rebalance_RetiredAsset_SellOnlyThenPrune() public {
        _seedBasket();
        _proposeAndExecute(TroyaIndex.Op.RetireAsset, abi.encode(address(toka)));
        (bool listed, bool buyable) = vault.assetInfo(address(toka));
        assertTrue(listed);
        assertFalse(buyable);
        vault.pokeAll();
        // cannot be bought
        vm.prank(keeper);
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        vault.rebalance(V_A, zfA, 0.1 ether, 0);
        // cannot be pruned while held
        vm.expectRevert(TroyaIndex.StillHeld.selector);
        vault.prune(address(toka));
        // a retired asset may be sold in full (no move cap), still within the price band
        _hours(13); // the 48 hours of the timelock let the old reads go stale
        _rebalance(V_A, address(toka), toka.balanceOf(address(vault)));
        assertEq(vault.holdings(address(toka)), 0);
        vault.prune(address(toka));
        address[] memory a = vault.assets();
        assertEq(a.length, 3);
        assertEq(a[1], address(usdx), "order of the rest kept");
        assertEq(a[2], address(evil));
    }

    function test_MaliciousKeeper_CannotRouteFundsElsewhere() public {
        _seedBasket();
        uint256 e0 = vault.holdings(address(0));
        uint256 a0 = vault.holdings(address(toka));
        Venue memory v = vault.getVenue(V_A);
        // the keeper drives the swapper directly: it can only trade what the keeper itself sends
        vm.deal(keeper, 1 ether);
        bool zf = v.asset0 == address(0);
        vm.prank(keeper);
        swapper.swap{value: 1 ether}(v, zf, true, 1 ether, 1 ether, zf ? 4295128740 : type(uint160).max - 1);
        assertGt(toka.balanceOf(keeper), 0, "its own trade");
        assertEq(vault.holdings(address(0)), e0, "vault ETH untouched");
        assertEq(vault.holdings(address(toka)), a0, "vault TOKA untouched");
        // it cannot fake the pool's callback to be paid by the swapper
        vm.prank(keeper);
        vm.expectRevert(TroyaIndexSwapper.NotPool.selector);
        swapper.uniswapV3SwapCallback(1 ether, 0, "");
        vm.prank(keeper);
        vm.expectRevert(TroyaIndexSwapper.NotPool.selector);
        swapper.unlockCallback("");
        // and it has no admin power
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.propose(TroyaIndex.Op.Keeper, abi.encode(keeper));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.setPaused(false, false);
        vm.expectRevert(TroyaIndex.NotGuardian.selector);
        vault.pause();
        vm.stopPrank();
    }

    function test_MaliciousKeeper_LossPerMoveIsBounded() public {
        // the worst a keeper can do with one call: sell the cap into a sandwich down to the band's edge
        _depositEth(alice, 10 ether);
        _hours(13);
        bool zf = _dir(V_A, address(0));
        (uint160 m,) = vault.medianSqrtPrice(V_A);
        uint160 s = poolA.sqrtPriceX96();
        // move the spot 1.5% against the vault: with the 0.3% pool fee and the trade's own impact the fill lands near
        // the 2% band edge
        uint256 k = Math.sqrt(uint256(9_850) * 1e36 / 10_000);
        poolA.setPrice(zf ? uint160(uint256(s) * k / 1e18) : uint160(uint256(s) * 1e18 / k));
        uint256 amt = vault.holdings(address(0)) * 2_000 / 10_000;
        vm.prank(keeper);
        (uint256 spent, uint256 got) = vault.rebalance(V_A, zf, amt, 0);
        uint256 fair = zf ? Math.mulDiv(Math.mulDiv(spent, m, Q96), m, Q96) : Math.mulDiv(Math.mulDiv(spent, Q96, m), Q96, m);
        assertGe(got * 10_000, fair * 9_800, "loss <= 2% of the moved 20%: <= 0.4% of the vault per cooldown");
    }

    function test_SwapperCallbacks_SpoofedByAnyone() public {
        vm.prank(eve);
        vm.expectRevert(TroyaIndexSwapper.NotPool.selector);
        swapper.uniswapV3SwapCallback(0, 1, "");
        vm.prank(address(poolA)); // a real pool, but no swap in progress
        vm.expectRevert(TroyaIndexSwapper.NotPool.selector);
        swapper.uniswapV3SwapCallback(0, 1, "");
        vm.prank(address(pm));
        vm.expectRevert(TroyaIndexSwapper.NotPool.selector);
        swapper.unlockCallback("");
    }

    /* ---------------- owner and the 48-hour timelock ---------------- */

    function test_Timelock_Lifecycle() public {
        bytes memory d = abi.encode(makeAddr("new-keeper"));
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.propose(TroyaIndex.Op.Keeper, d);
        _propose(TroyaIndex.Op.Keeper, d);
        bytes32 id = keccak256(abi.encode(TroyaIndex.Op.Keeper, d));
        assertEq(vault.etaOf(id), block.timestamp + 48 hours);
        vm.prank(safe);
        vm.expectRevert(TroyaIndex.AlreadyPending.selector);
        vault.propose(TroyaIndex.Op.Keeper, d);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(TroyaIndex.TimelockNotElapsed.selector, block.timestamp + 1));
        vault.execute(TroyaIndex.Op.Keeper, d);
        vm.warp(block.timestamp + 1);
        vm.prank(eve); // anyone executes a matured change
        vault.execute(TroyaIndex.Op.Keeper, d);
        assertEq(vault.keeper(), makeAddr("new-keeper"));
        vm.expectRevert(TroyaIndex.NothingPending.selector);
        vault.execute(TroyaIndex.Op.Keeper, d);

        // cancel
        bytes memory d2 = abi.encode(keeper);
        _propose(TroyaIndex.Op.Keeper, d2);
        bytes32 id2 = keccak256(abi.encode(TroyaIndex.Op.Keeper, d2));
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.cancel(id2);
        vm.prank(safe);
        vault.cancel(id2);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(TroyaIndex.NothingPending.selector);
        vault.execute(TroyaIndex.Op.Keeper, d2);

        // expiry
        _propose(TroyaIndex.Op.Keeper, d2);
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert();
        vault.execute(TroyaIndex.Op.Keeper, d2);
    }

    function test_Timelock_BoundsAtProposeAndExecute() public {
        vm.startPrank(safe);
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.Fee, abi.encode(feeTo, uint16(201)));
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.Fee, abi.encode(address(vault), uint16(10)));
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.Caps, abi.encode(uint256(1 ether), uint256(2 ether)));
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.RebalanceRules, abi.encode(uint16(6_000), uint32(4 hours)));
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.RebalanceRules, abi.encode(uint16(1_000), uint32(10 minutes)));
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        vault.propose(TroyaIndex.Op.AddAsset, abi.encode(address(toka)));
        vm.expectRevert(TroyaIndex.BadAsset.selector);
        vault.propose(TroyaIndex.Op.RetireAsset, abi.encode(address(0)));
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        vault.propose(TroyaIndex.Op.RemoveVenue, abi.encode(uint256(99)));
        vm.stopPrank();

        _proposeAndExecute(TroyaIndex.Op.Fee, abi.encode(makeAddr("burner"), uint16(100)));
        assertEq(vault.feeBps(), 100);
        assertEq(vault.feeRecipient(), makeAddr("burner"));
        _proposeAndExecute(TroyaIndex.Op.Caps, abi.encode(uint256(10 ether), uint256(1 ether)));
        assertEq(vault.totalCap(), 10 ether);
        _proposeAndExecute(TroyaIndex.Op.RebalanceRules, abi.encode(uint16(5_000), uint32(1 hours)));
        assertEq(vault.maxMoveBps(), 5_000);
        _proposeAndExecute(TroyaIndex.Op.Guardian, abi.encode(address(0)));
        assertEq(vault.guardian(), address(0));
        _proposeAndExecute(TroyaIndex.Op.RemoveVenue, abi.encode(V_E));
        assertFalse(vault.getVenue(V_E).active);
        assertEq(vault.venueOf(bytes32(uint256(uint160(address(poolE))))), 0);
        // the same pool can be listed again (new id, fresh price reads)
        _proposeAndExecute(TroyaIndex.Op.AddVenue, abi.encode(_v3(poolE, 250)));
        assertEq(vault.venueCount(), 5);
    }

    function test_Timelock_AssetAndVenueProposedTogether() public {
        MockToken t = new MockToken("NEW", 18);
        MockV3Pool p = _pool(address(weth), address(t), 100 ether, 100 ether, 3000);
        bytes memory da = abi.encode(address(t));
        bytes memory dv = abi.encode(_v3(p, 200));
        _propose(TroyaIndex.Op.AddAsset, da);
        _propose(TroyaIndex.Op.AddVenue, dv); // allowed: the asset is on its way
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(TroyaIndex.BadVenue.selector); // but not before the asset is listed
        vault.execute(TroyaIndex.Op.AddVenue, dv);
        vault.execute(TroyaIndex.Op.AddAsset, da);
        vault.execute(TroyaIndex.Op.AddVenue, dv);
        assertEq(vault.assets().length, 5);
        assertEq(vault.venueCount(), 5);
    }

    function test_Timelock_FakePoolNeverListable() public {
        MockV3Pool fake = new MockV3Pool(poolA.token0(), poolA.token1(), 3000, poolA.sqrtPriceX96(), 1e22);
        vm.prank(safe);
        vm.expectRevert(TroyaIndex.BadVenue.selector);
        vault.propose(TroyaIndex.Op.AddVenue, abi.encode(_v3(fake, 200)));
    }

    function test_Owner_HasNoWayToTakeAssets() public {
        _seedBasket();
        uint256 e0 = vault.holdings(address(0));
        uint256 a0 = vault.holdings(address(toka));
        uint256 u0 = vault.holdings(address(usdx));
        // no rescue / sweep / withdraw / arbitrary call selectors exist
        bytes[6] memory tries = [
            abi.encodeWithSignature("sweep(address,address)", address(toka), safe),
            abi.encodeWithSignature("rescue(address,address,uint256)", address(toka), safe, a0),
            abi.encodeWithSignature("withdraw(uint256)", e0),
            abi.encodeWithSignature("execute(address,uint256,bytes)", address(toka), 0, ""),
            abi.encodeWithSignature("upgradeTo(address)", address(1)),
            abi.encodeWithSignature("multicall(bytes[])", new bytes[](0))
        ];
        for (uint256 i; i < tries.length; ++i) {
            vm.prank(safe);
            (bool ok,) = address(vault).call(tries[i]);
            assertFalse(ok);
        }
        // the owner's strongest levers: max fee to itself and itself as keeper, after 48 hours
        _proposeAndExecute(TroyaIndex.Op.Fee, abi.encode(safe, uint16(100)));
        _proposeAndExecute(TroyaIndex.Op.Keeper, abi.encode(safe));
        assertEq(vault.holdings(address(0)), e0, "no holding moved");
        assertEq(vault.holdings(address(toka)), a0);
        assertEq(vault.holdings(address(usdx)), u0);
        assertEq(safe.balance, 0);
        vm.prank(safe);
        vm.expectRevert(TroyaIndex.CannotRenounce.selector);
        vault.renounceOwnership();
    }

    function test_Ownership_TwoStep() public {
        address next = makeAddr("next-safe");
        vm.prank(safe);
        vault.transferOwnership(next);
        assertEq(vault.owner(), safe);
        assertEq(vault.pendingOwner(), next);
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
    }

    function test_Guardian_PauseOnly() public {
        vm.startPrank(guardian);
        vault.pause();
        vm.expectRevert();
        vault.propose(TroyaIndex.Op.Keeper, abi.encode(guardian));
        vm.expectRevert();
        vault.setPaused(false, false);
        vm.stopPrank();
        vm.prank(eve);
        vm.expectRevert(TroyaIndex.NotGuardian.selector);
        vault.pause();
    }

    /* ---------------- zap ---------------- */

    function test_Zap_DepositWithEthOnly() public {
        _seedBasket();
        uint256[] memory ids = new uint256[](_assetsLen());
        ids[1] = V_A;
        ids[2] = V_U;
        ids[3] = V_E;
        uint256 shares = 1 ether;
        (uint256[] memory need,) = vault.previewDeposit(shares);
        uint256 e0 = carol.balance;
        vm.prank(carol);
        uint256 spent = zap.zap{value: 3 ether}(shares, carol, ids);
        assertEq(vault.balanceOf(carol), shares);
        assertEq(e0 - carol.balance, spent, "the rest refunded");
        assertApproxEqRel(spent, 1 ether, 0.02e18, "about 1 ETH of value for 1 ETH of shares");
        assertEq(address(zap).balance, 0);
        assertEq(toka.balanceOf(address(zap)), 0);
        assertEq(usdx.balanceOf(address(zap)), 0);
        assertEq(toka.allowance(address(zap), address(vault)), 0);
        assertGe(vault.holdings(address(toka)), need[1]);
    }

    function test_Zap_BudgetAndVenueChecks() public {
        _seedBasket();
        uint256[] memory ids = new uint256[](_assetsLen());
        ids[1] = V_A;
        ids[2] = V_U;
        vm.prank(carol);
        vm.expectRevert(); // 1 ETH of shares for 0.5 ETH
        zap.zap{value: 0.5 ether}(1 ether, carol, ids);
        ids[2] = V_AU; // TOKA/USDX is not an ETH pool
        vm.prank(carol);
        vm.expectRevert(TroyaIndexZap.BadVenue.selector);
        zap.zap{value: 3 ether}(1 ether, carol, ids);
        vm.prank(carol);
        vm.expectRevert(TroyaIndexZap.WrongLength.selector);
        zap.zap{value: 3 ether}(1 ether, carol, new uint256[](2));
    }

    function test_Zap_RespectsCaps() public {
        _seedBasket();
        uint256[] memory ids = new uint256[](_assetsLen());
        ids[1] = V_A;
        ids[2] = V_U;
        vm.prank(carol);
        vm.expectRevert(TroyaIndex.WalletCapExceeded.selector);
        zap.zap{value: 80 ether}(51 ether, carol, ids);
    }


    /* ---------------- properties (fuzzed) ---------------- */

    /// an in-kind deposit of any size, into any basket, never lowers what one share holds of any asset
    function testFuzz_InKindDepositNeverDilutes(uint256 shares, uint96 donA, uint64 donU, uint96 donE) public {
        _seedBasket();
        vault.accrue();
        toka.mint(address(vault), donA);
        usdx.mint(address(vault), donU);
        evil.mint(address(vault), donE);
        shares = bound(shares, 1, 30 ether);
        uint256 s0 = vault.totalSupply();
        address[] memory list = vault.assets();
        uint256[] memory h0 = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) h0[i] = vault.holdings(list[i]);
        _depositInKind(bob, shares);
        uint256 s1 = vault.totalSupply();
        for (uint256 i; i < list.length; ++i) assertGe(vault.holdings(list[i]) * s0, h0[i] * s1);
    }

    /// a withdrawal pays at most shares / supply of each holding, and never lowers what the other shares hold
    function testFuzz_RedeemIsProRataRoundedDown(uint256 frac) public {
        _seedBasket();
        _depositInKind(bob, 3 ether);
        vault.accrue();
        uint256 bal = vault.balanceOf(alice);
        uint256 shares = bound(frac, 1, bal);
        uint256 s0 = vault.totalSupply();
        address[] memory list = vault.assets();
        uint256[] memory h0 = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) h0[i] = vault.holdings(list[i]);
        vm.prank(alice);
        uint256[] memory out = vault.redeem(shares, alice);
        uint256 s1 = vault.totalSupply();
        for (uint256 i; i < list.length; ++i) {
            assertLe(out[i] * s0, h0[i] * shares);
            assertGe(vault.holdings(list[i]) * s0, h0[i] * s1);
        }
    }

    /// deposit then withdraw at once never returns more than was put in (no free value from rounding)
    function testFuzz_DepositRedeemNoProfit(uint256 first, uint256 amt, uint256 donation) public {
        first = bound(first, 0.002 ether, 40 ether);
        amt = bound(amt, 1 gwei, 40 ether);
        donation = bound(donation, 0, 100 ether);
        _depositEth(alice, first);
        (bool ok,) = address(vault).call{value: donation}("");
        assertTrue(ok);
        vm.prank(bob);
        try vault.depositEth{value: amt}(0, bob) returns (uint256 s) {
            vm.prank(bob);
            uint256[] memory out = vault.redeem(s, bob);
            assertLe(out[0], amt);
        } catch {}
    }


    /* ---------------- management fee (owner decision 26 Nov 2026: 1% a year, max 2%) ---------------- */

    function test_MgmtFee_OneYearIsOnePercentOfSupply() public {
        _depositEth(alice, 10 ether);
        uint256 s0 = vault.totalSupply();
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.previewRedeem(s0)[0], vault.holdings(address(0)) * s0 / (s0 + s0 / 100), "previews already include the fee due");
        vm.prank(eve);
        uint256 minted = vault.accrue();                  // anyone may call it
        assertEq(minted, s0 / 100, "1% of the supply for one year");
        assertEq(vault.balanceOf(mgmtTo), s0 / 100, "paid in TIDX to the management-fee recipient");
        assertEq(vault.feesAccrued(), 0.05 ether, "the ETH deposit fee is separate and unchanged");
        assertEq(vault.lastAccrual(), block.timestamp);
        assertEq(vault.accrue(), 0, "nothing more in the same second");
        // the holders keep 1 / 1.01 of the vault
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256[] memory out = vault.redeem(aliceShares, alice);
        assertApproxEqRel(out[0], (uint256(9.95 ether) * 100) / 101, 1e12);
    }

    function test_MgmtFee_IdleYearThenRedeemPaysTheRedeemerNetOfFee() public {
        _depositEth(alice, 10 ether);
        uint256 sh = vault.balanceOf(alice);
        vm.warp(block.timestamp + 365 days);              // nobody touched the vault for a year
        uint256[] memory exp = vault.previewRedeem(sh);
        vm.prank(alice);
        uint256[] memory out = vault.redeem(sh, alice);   // the redeem accrues first
        assertEq(out[0], exp[0], "preview = what the redeem paid");
        assertGt(vault.balanceOf(mgmtTo), 0);
        // the recipient's TIDX redeem like any other
        uint256 m = vault.balanceOf(mgmtTo);
        vm.prank(mgmtTo);
        uint256[] memory f = vault.redeem(m, mgmtTo);
        assertApproxEqRel(f[0], uint256(9.95 ether) / 101, 1e12, "~1% of the vault for the year");
    }

    function test_MgmtFee_CenturyIdleIsBoundedAndNeverReverts() public {
        _proposeAndExecute(TroyaIndex.Op.MgmtFee, abi.encode(mgmtTo, uint16(200)));
        _depositEth(alice, 10 ether);
        uint256 s0 = vault.totalSupply();
        vm.warp(block.timestamp + 100 * 365 days);
        uint256 sh = vault.balanceOf(alice);
        vm.prank(alice);
        uint256[] memory out = vault.redeem(sh, alice);   // still works after a century
        uint256 m = vault.balanceOf(mgmtTo);
        assertEq(m, s0 * 2, "2% x 100 years of the supply, linear, never compounding");
        // holders keep 1 / (1 + r t) = 1/3, more than 1 - r t (which would be below zero) and than (1 - r)^t (13%)
        assertApproxEqRel(out[0], (9.95 ether * sh / s0) / 3, 1e12);
    }

    function test_MgmtFee_RateChangeMidPeriod() public {
        _depositEth(alice, 10 ether);
        uint256 s0 = vault.totalSupply();
        uint256 t0 = block.timestamp;
        bytes memory d = abi.encode(mgmtTo, uint16(200));
        vm.warp(t0 + 180 days);
        _propose(TroyaIndex.Op.MgmtFee, d);
        vm.warp(block.timestamp + 48 hours);
        vault.execute(TroyaIndex.Op.MgmtFee, d);          // accrues at 1% up to now, then 2% from now
        uint256 firstPart = (s0 * 100 * (182 days)) / (10_000 * 365 days);
        assertEq(vault.balanceOf(mgmtTo), firstPart, "the old rate for the time before the change");
        assertEq(vault.mgmtFeeBps(), 200);
        uint256 s1 = vault.totalSupply();
        vm.warp(block.timestamp + 183 days);
        vault.accrue();
        assertEq(vault.balanceOf(mgmtTo) - firstPart, (s1 * 200 * (183 days)) / (10_000 * 365 days), "the new rate after");
    }

    function test_MgmtFee_CapAtMaxAndOnlyThroughTimelock() public {
        TroyaIndex.Init memory p = _init();
        p.mgmtFeeBps = 201;
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        new TroyaIndex(p);
        p = _init();
        p.mgmtFeeRecipient = address(0);
        vm.expectRevert(TroyaIndex.ZeroAddress.selector);
        new TroyaIndex(p);
        vm.startPrank(safe);
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.MgmtFee, abi.encode(mgmtTo, uint16(201)));
        vm.expectRevert(TroyaIndex.OutOfBounds.selector);
        vault.propose(TroyaIndex.Op.MgmtFee, abi.encode(address(vault), uint16(100)));
        vm.stopPrank();
        // the deposit fee's maximum is 2% now
        _proposeAndExecute(TroyaIndex.Op.Fee, abi.encode(feeTo, uint16(200)));
        assertEq(vault.feeBps(), 200);
        // a new recipient only after 48 hours; nothing else can set it
        address next = makeAddr("next-mgmt");
        _propose(TroyaIndex.Op.MgmtFee, abi.encode(next, uint16(200)));
        assertEq(vault.mgmtFeeRecipient(), mgmtTo);
        vm.warp(block.timestamp + 48 hours);
        vault.execute(TroyaIndex.Op.MgmtFee, abi.encode(next, uint16(200)));
        assertEq(vault.mgmtFeeRecipient(), next);
        assertEq(vault.mgmtFeeBps(), 200);
        assertEq(vault.MAX_MGMT_FEE_BPS(), 200);
        assertEq(vault.MAX_FEE_BPS(), 200);
    }

    function test_MgmtFee_NothingBeforeTheFirstDeposit() public {
        vm.warp(block.timestamp + 3 * 365 days);          // deployed, then idle with no supply
        uint256 s = _depositEth(alice, 1 ether);
        assertEq(vault.balanceOf(mgmtTo), 0, "no supply, no fee");
        assertEq(s, 1 ether - 0.005 ether - vault.DEAD_SHARES(), "first deposit still 1 share per wei");
        assertEq(vault.lastAccrual(), block.timestamp);
    }

    function test_MgmtFee_ZeroRateMintsNothing() public {
        _proposeAndExecute(TroyaIndex.Op.MgmtFee, abi.encode(mgmtTo, uint16(0)));
        _depositEth(alice, 1 ether);
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.accrue(), 0);
    }

    function test_MgmtFee_DoesNotCountAgainstDepositsButDoesNotBypassCaps() public {
        _depositEth(alice, 49 ether);
        _depositEth(bob, 49 ether);
        vm.warp(block.timestamp + 365 days);
        vault.accrue();
        // the fee shares may take the supply past the cap; deposits still stop at it
        uint256 room = vault.totalCap() > vault.totalSupply() ? vault.totalCap() - vault.totalSupply() : 0;
        vm.prank(carol);
        vm.expectRevert(TroyaIndex.TotalCapExceeded.selector);
        vault.depositEth{value: room + 1 ether}(0, carol);
    }

    function test_MgmtFee_InflationDefenceStillHolds() public {
        vm.prank(eve);
        uint256 s = vault.depositEth{value: 0.002 ether}(0, eve);
        vm.prank(eve);
        vault.redeem(s - 1, eve);
        vm.warp(block.timestamp + 365 days);
        vm.prank(eve);
        (bool ok,) = address(vault).call{value: 100 ether}("");
        assertTrue(ok);
        uint256 shares = _depositEth(bob, 1 ether);
        assertGt(shares, 0);
        vm.prank(bob);
        uint256[] memory out = vault.redeem(shares, bob);
        assertGe(out[0] + 1e12, 1 ether - 0.005 ether, "bob loses at most one share of rounding");
    }

    /// whatever the rate, the time and the supply, one accrual mints at most supply x rate x time / year
    function testFuzz_MgmtFeeNeverAboveRate(uint16 bps, uint32 dt, uint256 amt) public {
        bps = uint16(bound(bps, 0, 200));
        amt = bound(amt, 0.002 ether, 40 ether);
        _proposeAndExecute(TroyaIndex.Op.MgmtFee, abi.encode(mgmtTo, bps));
        _depositEth(alice, amt);
        uint256 s0 = vault.totalSupply();
        vm.warp(block.timestamp + dt);
        uint256 m = vault.accrue();
        assertLe(m, (s0 * bps * uint256(dt)) / (10_000 * 365 days));
        assertGe(m + 1, (s0 * bps * uint256(dt)) / (10_000 * 365 days));
    }

    receive() external payable {}
}
