// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaIndex} from "../src/TroyaIndex.sol";
import {TroyaIndexSwapper, Venue} from "../src/TroyaIndexSwapper.sol";
import {TroyaIndexZap} from "../src/TroyaIndexZap.sol";
import {DeployTroyaIndex} from "../script/DeployTroyaIndex.s.sol";

/// Against Robinhood Chain (4663) on a local in-memory fork: the real WETH, the real Uniswap v3 factory and pools
/// (WETH/USDG 0.01%, NVDA/WETH 0.05%), the real Uniswap v4 PoolManager and the real Pons pool of $TROYA with its hook.
/// Nothing is sent to the chain. Skipped, not failed, when the RPC cannot be reached.
contract TroyaIndexForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TROYA = 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant WETH_USDG_100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant NVDA_WETH_500 = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;
    address constant SAFE = 0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb; // owns TroyaFeeRouter (2-of-2)
    address constant FEE_ROUTER = 0x76d97f6A3b97d856dBC7FaA6E59a892D87C3Ff3B;
    address constant CREATOR = 0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4;
    bytes32 constant TROYA_POOL_ID = 0x050f1f047e1753d3058519c50e522b1f80c9e1eb208eb1f10867adab67bb38c1;

    TroyaIndexSwapper swapper;
    TroyaIndex vault;
    TroyaIndexZap zap;
    address keeper = makeAddr("keeper");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant V_USDG = 0;
    uint256 constant V_TROYA = 1;
    uint256 constant V_NVDA = 2;

    function _fork() internal returns (bool) {
        try vm.createSelectFork("robinhood") {}
        catch {
            vm.skip(true, "Robinhood Chain RPC not reachable: fork test skipped");
            return false;
        }
        assertEq(block.chainid, 4663, "not Robinhood Chain");
        return true;
    }

    function _init() internal view returns (TroyaIndex.Init memory p) {
        p.owner = SAFE;
        p.swapper = address(swapper);
        p.keeper = keeper;
        p.guardian = guardian;
        p.feeRecipient = FEE_ROUTER;
        p.feeBps = 50;
        p.mgmtFeeRecipient = CREATOR;
        p.mgmtFeeBps = 100;
        p.totalCap = 2 ether;
        p.walletCap = 0.5 ether;
        p.maxMoveBps = 2_000;
        p.cooldown = 4 hours;
        p.assets = new address[](3);
        p.assets[0] = USDG;
        p.assets[1] = TROYA;
        p.assets[2] = NVDA;
        p.venues = new TroyaIndex.VenueInput[](3);
        p.venues[0] = TroyaIndex.VenueInput(1, WETH_USDG_100, address(0), address(0), 0, 0, address(0), 100);
        p.venues[1] = TroyaIndex.VenueInput(2, address(0), address(0), TROYA, 0, 200, PONS_HOOK, 600);
        p.venues[2] = TroyaIndex.VenueInput(1, NVDA_WETH_500, address(0), address(0), 0, 0, address(0), 200);
    }

    function _deploy() internal {
        swapper = new TroyaIndexSwapper(WETH, V3_FACTORY, POOL_MANAGER, PONS_HOOK);
        uint256 g = gasleft();
        vault = new TroyaIndex(_init());
        console2.log("vault deploy gas (execution only)", g - gasleft());
        zap = new TroyaIndexZap(vault);
        assertEq(vault.venueOf(TROYA_POOL_ID), V_TROYA + 1, "the v4 venue is the real $TROYA Pons pool");
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function _hours(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.warp(block.timestamp + 1 hours);
            vault.pokeAll();
        }
    }

    function _rebalance(uint256 id, address assetIn, uint256 amount) internal returns (uint256 spent, uint256 got) {
        Venue memory v = vault.getVenue(id);
        bool zf = v.asset0 == assetIn;
        uint256 g = gasleft();
        vm.prank(keeper);
        (spent, got) = vault.rebalance(id, zf, amount, 0);
        console2.log("rebalance gas", g - gasleft());
    }

    /// deposit -> rebalance into USDG (v3, WETH wrapped inside the swap), $TROYA (v4 Pons pool, native ETH) and NVDA
    /// (v3) -> zap deposit with ETH only -> sell some $TROYA back through the Pons hook -> everybody withdraws in kind
    function test_Fork_DepositRebalanceZapWithdraw() public {
        if (!_fork()) return;
        _deploy();

        vm.prank(alice);
        vault.depositEth{value: 0.5 ether}(0, alice);
        vm.prank(bob);
        vault.depositEth{value: 0.4 ether}(0, bob);
        assertEq(vault.feesAccrued(), 0.0045 ether);

        _hours(13);
        (uint256 s1, uint256 usdg) = _rebalance(V_USDG, address(0), 0.15 ether);
        console2.log("ETH -> USDG", s1, usdg);
        assertEq(s1, 0.15 ether);
        assertEq(IERC20(USDG).balanceOf(address(vault)), usdg);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0, "WETH unwrapped inside the swap");

        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
        (uint256 s2, uint256 troya) = _rebalance(V_TROYA, address(0), 0.1 ether);
        console2.log("ETH -> TROYA (Pons v4)", s2, troya / 1e18);
        assertGt(troya, 0);
        assertEq(IERC20(TROYA).balanceOf(address(vault)), troya);

        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
        (uint256 s3, uint256 nvda) = _rebalance(V_NVDA, address(0), 0.1 ether);
        console2.log("ETH -> NVDA", s3, nvda);
        assertGt(nvda, 0);

        // nothing stuck in the swapper
        assertEq(address(swapper).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0);
        assertEq(IERC20(TROYA).balanceOf(address(swapper)), 0);

        // depositEth is closed now; carol zaps with ETH
        vm.expectRevert(TroyaIndex.NotEthOnly.selector);
        vault.previewDepositEth(1 ether);
        uint256[] memory ids = new uint256[](4);
        ids[1] = V_USDG;
        ids[2] = V_TROYA;
        ids[3] = V_NVDA;
        uint256 c0 = carol.balance;
        vm.prank(carol);
        uint256 g = gasleft();
        uint256 spent = zap.zap{value: 0.5 ether}(0.2 ether, carol, ids);
        console2.log("zap gas", g - gasleft());
        console2.log("zap: 0.2e18 TIDX cost (wei)", spent);
        assertEq(vault.balanceOf(carol), 0.2 ether);
        assertEq(c0 - carol.balance, spent);
        assertLt(spent, 0.22 ether, "within 10% of the 1:1 share price after pool fees");
        assertEq(address(zap).balance, 0);
        assertEq(IERC20(TROYA).balanceOf(address(zap)), 0);

        // sell part of the $TROYA back to ETH through the Pons hook
        vm.warp(block.timestamp + 4 hours);
        vault.pokeAll();
        uint256 sellAmt = IERC20(TROYA).balanceOf(address(vault)) / 5;
        (uint256 s4, uint256 ethBack) = _rebalance(V_TROYA, TROYA, sellAmt);
        console2.log("TROYA -> ETH (Pons v4)", s4 / 1e18, ethBack);
        assertEq(s4, sellAmt);
        assertGt(ethBack, 0);

        // everybody withdraws in kind: ETH, USDG, $TROYA and NVDA
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            uint256 sh = vault.balanceOf(who[i]);
            uint256 e0 = who[i].balance;
            vm.prank(who[i]);
            g = gasleft();
            uint256[] memory out = vault.redeem(sh, who[i]);
            console2.log("redeem gas", g - gasleft());
            assertEq(who[i].balance - e0, out[0]);
            assertEq(IERC20(USDG).balanceOf(who[i]), out[1]);
            assertEq(IERC20(TROYA).balanceOf(who[i]), out[2]);
            assertEq(IERC20(NVDA).balanceOf(who[i]), out[3]);
            assertGt(out[1] * out[2] * out[3], 0, "a slice of every holding");
            assertEq(vault.owed(who[i], USDG) + vault.owed(who[i], NVDA), 0, "nothing had to be kept");
        }
        // the management fee (1% a year over the ~12 hours of this run) went to the creator wallet in TIDX
        uint256 fee = vault.balanceOf(CREATOR);
        assertGt(fee, 0, "management fee minted in TIDX");
        assertEq(vault.totalSupply(), vault.DEAD_SHARES() + fee);
        vm.prank(CREATOR);
        vault.redeem(fee, CREATOR);
        assertEq(vault.totalSupply(), vault.DEAD_SHARES());
        assertLt(vault.holdings(address(0)), 1e10, "only the dead shares' dust is left");

        // the fees go to the fee router (its receive() takes ETH and splits it like a creator fee)
        uint256 f = vault.feesAccrued();
        uint256 r0 = FEE_ROUTER.balance;
        vault.flushFees();
        assertEq(FEE_ROUTER.balance - r0, f);
    }

    /// the band works against the real pool: with the spot pushed far outside the median band by a big trade, the keeper
    /// cannot make the vault trade, whatever minOut it passes
    function test_Fork_SandwichedPoolRefused() public {
        if (!_fork()) return;
        _deploy();
        vm.prank(alice);
        vault.depositEth{value: 0.5 ether}(0, alice);
        _hours(13);
        // a whale buys $TROYA with 1 ETH in the real Pons pool, pushing the price well over 5%
        address whale = makeAddr("whale");
        vm.deal(whale, 2 ether);
        Venue memory v = vault.getVenue(V_TROYA);
        vm.prank(whale);
        swapper.swap{value: 1 ether}(v, true, true, 1 ether, 1 ether, 4295128740);
        assertGt(IERC20(TROYA).balanceOf(whale), 0);
        uint160 spot = vault.spotSqrtPrice(V_TROYA);
        (uint160 median,) = vault.medianSqrtPrice(V_TROYA);
        console2.log("spot vs median sqrtP", spot, median);
        assertLt(spot, (uint256(median) * 97) / 100, "pushed far");
        vm.prank(keeper);
        vm.expectRevert();
        vault.rebalance(V_TROYA, true, 0.05 ether, 0);
    }

    /// the deploy script, run in-process against the fork with the parameters from the environment
    function test_Fork_DeployScript() public {
        if (!_fork()) return;
        vm.setEnv("INDEX_KEEPER", vm.toString(keeper));
        vm.setEnv("INDEX_GUARDIAN", vm.toString(guardian));
        vm.setEnv("INDEX_ASSETS", string.concat(vm.toString(USDG), ",", vm.toString(TROYA)));
        vm.setEnv("INDEX_V3_POOLS", vm.toString(WETH_USDG_100));
        vm.setEnv("INDEX_V3_SLIPPAGE_BPS", "100");
        vm.setEnv("INDEX_PONS_TOKENS", vm.toString(TROYA));
        vm.setEnv("INDEX_PONS_SLIPPAGE_BPS", "600");
        DeployTroyaIndex s = new DeployTroyaIndex();
        (TroyaIndexSwapper sw, TroyaIndex v, TroyaIndexZap z) = s.deploy();
        assertEq(v.owner(), SAFE);
        assertEq(v.feeRecipient(), FEE_ROUTER);
        assertEq(v.totalCap(), 2 ether);
        assertEq(v.walletCap(), 0.5 ether);
        assertEq(v.feeBps(), 50);
        assertEq(v.keeper(), keeper);
        assertEq(address(v.swapper()), address(sw));
        assertEq(address(z.vault()), address(v));
        assertEq(v.assets().length, 3);
        assertEq(v.venueCount(), 2);
        assertEq(v.venueOf(TROYA_POOL_ID), 2);
    }
}
