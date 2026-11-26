// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaIndex} from "../src/TroyaIndex.sol";
import {TroyaIndexSwapper, Venue} from "../src/TroyaIndexSwapper.sol";
import {IndexFixture} from "./TroyaIndex.t.sol";
import {MockToken, EvilToken, MockV3Pool, MockWETH} from "./TroyaIndexMocks.sol";

/// Random deposits (ETH and in kind), withdrawals, keeper rebalances, donations, price pumps, a token turning hostile,
/// owner pauses and proposals, claims and fee flushes. Every action is checked as it happens:
///   - a withdrawal never reverts (whatever the token, the pause, the owner or the keeper did);
///   - deposits and withdrawals never lower what one share holds of any asset (no dilution, rounding to the vault);
///   - nothing but a withdrawal or a rebalance lowers a holding; a rebalance lowers only the asset it sells, by at most
///     the move cap, and only raises the asset it buys.
contract IndexHandler is Test {
    TroyaIndex public vault;
    TroyaIndexSwapper public swapper;
    EvilToken public evil;
    address public keeper;
    address public safe;
    MockV3Pool[4] public pools;
    uint160[4] public startPrice;
    address[] public actors;
    address[] public tokens; // every token the vault may hold (listed or not)

    uint256 public redeemReverts;
    uint256 public violations;
    string public lastViolation;
    uint256 public rebalances;
    uint256 public rebalanceFails;
    bytes4 public lastRebalanceErr;
    uint256 public redeems;
    uint256 public deposits;

    constructor(TroyaIndex v, TroyaIndexSwapper s, EvilToken e, address k, address o, MockV3Pool[4] memory p, address[] memory t) {
        vault = v;
        swapper = s;
        evil = e;
        keeper = k;
        safe = o;
        pools = p;
        for (uint256 i; i < 4; ++i) startPrice[i] = p[i].sqrtPriceX96();
        tokens = t;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA11CE0 + i));
            actors.push(a);
        }
    }

    function actorCount() external view returns (uint256) { return actors.length; }
    function tokenCount() external view returns (uint256) { return tokens.length; }
    function _who(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    function _flag(string memory why) internal {
        ++violations;
        lastViolation = why;
    }

    /// holdings of ETH and every token, and the supply
    function _snap() internal view returns (uint256[] memory h, uint256 supply) {
        h = new uint256[](tokens.length + 1);
        h[0] = vault.holdings(address(0));
        for (uint256 i; i < tokens.length; ++i) h[i + 1] = vault.holdings(tokens[i]);
        supply = vault.totalSupply();
    }

    /// what one share holds never drops: after * s0 >= before * s1, per asset
    function _noDilution(uint256[] memory h0, uint256 s0, string memory what) internal {
        (uint256[] memory h1, uint256 s1) = _snap();
        if (s1 == 0 || s0 == 0) return;
        for (uint256 i; i < h0.length; ++i) {
            if (h1[i] * s0 < h0[i] * s1) _flag(what);
        }
    }

    /// no holding dropped at all
    function _noOutflow(uint256[] memory h0, string memory what) internal {
        (uint256[] memory h1,) = _snap();
        for (uint256 i; i < h0.length; ++i) {
            if (h1[i] < h0[i]) _flag(what);
        }
    }

    /* ---------------- actions ---------------- */

    function depositEth(uint256 seed, uint256 amt) external {
        address a = _who(seed);
        amt = bound(amt, 0.002 ether, 5 ether);
        vm.deal(a, a.balance + amt);
        vault.accrue();   // the fee due so far is the management fee, not a dilution by this deposit
        (uint256[] memory h0, uint256 s0) = _snap();
        vm.prank(a);
        try vault.depositEth{value: amt}(0, a) {
            ++deposits;
            _noDilution(h0, s0, "depositEth diluted");
        } catch {}
    }

    function depositInKind(uint256 seed, uint256 shares) external {
        if (vault.totalSupply() == 0) return;
        address a = _who(seed);
        shares = bound(shares, 1, 3 ether);
        uint256[] memory need;
        uint256 fee;
        try vault.previewDeposit(shares) returns (uint256[] memory n, uint256 f) { need = n; fee = f; } catch { return; }
        address[] memory list = vault.assets();
        for (uint256 i = 1; i < list.length; ++i) {
            if (need[i] == 0) continue;
            if (list[i] == address(evil)) evil.mint(a, need[i]);
            else MockToken(list[i]).mint(a, need[i]);
            vm.prank(a);
            IERC20(list[i]).approve(address(vault), need[i]);
        }
        vm.deal(a, a.balance + need[0] + fee);
        vault.accrue();
        (uint256[] memory h0, uint256 s0) = _snap();
        vm.prank(a);
        try vault.deposit{value: need[0] + fee, gas: 5_000_000}(shares, a, need) {
            ++deposits;
            _noDilution(h0, s0, "deposit diluted");
        } catch {}
    }

    function redeem(uint256 seed, uint256 frac) external {
        address a = _who(seed);
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bound(frac, 1, bal);
        vault.accrue();
        (uint256[] memory h0, uint256 s0) = _snap();
        vm.prank(a);
        try vault.redeem{gas: 8_000_000}(shares, a) {
            ++redeems;
            _noDilution(h0, s0, "redeem diluted the others");
        } catch {
            ++redeemReverts;
        }
    }

    struct Plan {
        uint256 id;
        bool zf;
        uint256 amt;
        bool listed;
        uint256 iIn;
        uint256 iOut;
    }

    function _plan(uint256 venueSeed, bool sellFirst, uint256 amtSeed, bool tooMuch) internal view returns (Plan memory p) {
        p.id = venueSeed % vault.venueCount();
        Venue memory v = vault.getVenue(p.id);
        p.zf = sellFirst;
        (address assetIn, address assetOut) = p.zf ? (v.asset0, v.asset1) : (v.asset1, v.asset0);
        uint256 held = vault.holdings(assetIn);
        bool buyable;
        (p.listed, buyable) = vault.assetInfo(assetIn);
        uint256 cap = buyable ? (held * vault.maxMoveBps()) / 10_000 : held;
        p.amt = tooMuch ? cap + 1 + (amtSeed % 1e18) : bound(amtSeed, 0, cap);
        p.iIn = _index(assetIn);
        p.iOut = _index(assetOut);
    }

    function rebalance(uint256 venueSeed, bool sellFirst, uint256 amtSeed, bool tooMuch) external {
        // let the cooldown pass, reading the prices every hour
        uint256 next = vault.nextRebalanceAt();
        while (block.timestamp < next) _tick();
        Plan memory p = _plan(venueSeed, sellFirst, amtSeed, tooMuch);
        if (p.amt == 0) return;
        (uint256[] memory h0,) = _snap();
        vm.prank(keeper);
        try vault.rebalance{gas: 10_000_000}(p.id, p.zf, p.amt, 0) returns (uint256 spent, uint256 got) {
            ++rebalances;
            if (tooMuch) _flag("rebalance above the move cap went through");
            if (!p.listed) _flag("rebalance sold an unlisted asset");
            _checkRebalance(h0, p, spent, got);
        } catch (bytes memory err) {
            lastRebalanceErr = bytes4(err);
            ++rebalanceFails;
        }
    }

    function _checkRebalance(uint256[] memory h0, Plan memory p, uint256 spent, uint256 got) internal {
        (uint256[] memory h1,) = _snap();
        for (uint256 i; i < h0.length; ++i) {
            if (i == p.iIn) {
                uint256 d = h0[i] > h1[i] ? h0[i] - h1[i] : 0;
                if (d > p.amt || d != spent) _flag("rebalance sold more than asked");
            } else if (i == p.iOut) {
                if (h1[i] < h0[i] + got || got == 0) _flag("rebalance output did not arrive");
            } else if (h1[i] < h0[i]) {
                _flag("rebalance touched a third asset");
            }
        }
    }

    function donate(uint256 which, uint256 amt) external {
        uint256 i = which % (tokens.length + 1);
        (uint256[] memory h0,) = _snap();
        if (i == 0) {
            amt = bound(amt, 1, 3 ether);
            vm.deal(address(this), amt);
            (bool ok,) = address(vault).call{value: amt}("");
            ok;
        } else {
            address t = tokens[i - 1];
            amt = bound(amt, 1, 1_000 ether);
            if (t == address(evil)) evil.mint(address(vault), amt);
            else MockToken(t).mint(address(vault), amt);
        }
        _noOutflow(h0, "a donation lowered a holding");
    }

    /// someone moves a pool's price (a sandwich, a whale): the vault's own holdings never move by it
    function pump(uint256 poolSeed, uint256 pct, bool up) external {
        MockV3Pool p = pools[poolSeed % 4];
        pct = bound(pct, 1, 12);
        uint256 s = p.sqrtPriceX96();
        (uint256[] memory h0,) = _snap();
        p.setPrice(uint160(up ? (s * (100 + pct)) / 100 : (s * (100 - pct)) / 100));
        _noOutflow(h0, "a price move lowered a holding");
    }

    /// arbitrage brings a pool back to its first price
    function heal(uint256 poolSeed) external {
        uint256 i = poolSeed % 4;
        pools[i].setPrice(startPrice[i]);
    }

    function setEvil(uint256 m) external {
        uint256 k = m % 4;
        evil.setMode(k == 0 ? EvilToken.Mode.Normal : k == 1 ? EvilToken.Mode.Revert : k == 2 ? EvilToken.Mode.BurnGas : EvilToken.Mode.ReturnFalse);
    }

    /// the owner does what it can do instantly, and proposes changes (which wait 48 hours)
    function ownerActs(uint256 mode, uint256 keeperSeed) external {
        (uint256[] memory h0,) = _snap();
        vm.startPrank(safe);
        if (mode % 3 == 0) vault.setPaused(true, true);
        else if (mode % 3 == 1) vault.setPaused(false, false);
        try vault.propose(TroyaIndex.Op.Keeper, abi.encode(address(uint160(keeperSeed)))) {} catch {}
        try vault.propose(TroyaIndex.Op.Fee, abi.encode(safe, uint16(100))) {} catch {}
        vm.stopPrank();
        _noOutflow(h0, "the owner lowered a holding");
    }

    function claim(uint256 seed, uint256 which) external {
        address a = _who(seed);
        address asset = which % 2 == 0 ? address(0) : address(evil);
        if (vault.owed(a, asset) == 0) return;
        (uint256[] memory h0,) = _snap();
        vm.prank(a);
        try vault.claimOwed{gas: 2_000_000}(asset, a) {} catch {}
        _noOutflow(h0, "a claim lowered a holding");
    }

    function flush() external {
        (uint256[] memory h0,) = _snap();
        try vault.flushFees() {} catch {}
        _noOutflow(h0, "flushing fees lowered a holding");
    }

    function tick() external { _tick(); }

    function _tick() internal {
        vm.warp(block.timestamp + 1 hours);
        vault.pokeAll();
    }

    function _index(address asset) internal view returns (uint256) {
        if (asset == address(0)) return 0;
        for (uint256 i; i < tokens.length; ++i) if (tokens[i] == asset) return i + 1;
        return type(uint256).max;
    }

    receive() external payable {}
}

/// forge-config: default.invariant.runs = 96
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = false
contract TroyaIndexInvariantTest is IndexFixture {
    IndexHandler handler;

    uint256 start;

    function setUp() public override {
        super.setUp();
        start = block.timestamp;
        address[] memory t = new address[](3);
        t[0] = address(toka);
        t[1] = address(usdx);
        t[2] = address(evil);
        handler = new IndexHandler(vault, swapper, evil, keeper, safe, [poolA, poolU, poolAU, poolE], t);
        _depositEth(alice, 5 ether);
        _hours(13);
        targetContract(address(handler));
    }

    /// whatever happened, a withdrawal never reverted
    function invariant_withdrawalsNeverRevert() public view {
        assertEq(handler.redeemReverts(), 0);
    }

    /// no action ever diluted a holder, moved a holding it should not, or broke a rebalance bound
    function invariant_noUnexplainedOutflow() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
    }

    /// every claim kept for a holder (and the fees) is fully backed
    function invariant_claimsBacked() public view {
        assertGe(address(vault).balance, vault.totalOwed(address(0)) + vault.feesAccrued());
        assertEq(address(vault).balance, vault.holdings(address(0)) + vault.totalOwed(address(0)) + vault.feesAccrued());
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address tk = handler.tokens(i);
            assertGe(IERC20(tk).balanceOf(address(vault)), vault.totalOwed(tk));
        }
    }

    /// owed per asset is exactly the sum of what is kept for each holder
    function invariant_owedSumsMatch() public view {
        uint256 e;
        uint256 x;
        for (uint256 i; i < handler.actorCount(); ++i) {
            e += vault.owed(handler.actors(i), address(0));
            x += vault.owed(handler.actors(i), address(evil));
        }
        e += vault.owed(alice, address(0));
        x += vault.owed(alice, address(evil));
        assertEq(e, vault.totalOwed(address(0)));
        assertEq(x, vault.totalOwed(address(evil)));
    }

    /// shares: the holders' balances add up to the supply, and the dead shares never move
    function invariant_sharesAddUp() public view {
        uint256 sum = vault.balanceOf(vault.DEAD()) + vault.balanceOf(alice) + vault.balanceOf(mgmtTo);
        for (uint256 i; i < handler.actorCount(); ++i) sum += vault.balanceOf(handler.actors(i));
        assertEq(sum, vault.totalSupply());
        assertEq(vault.balanceOf(vault.DEAD()), vault.DEAD_SHARES());
    }

    /// the swapper never keeps anything between transactions
    function invariant_swapperEmpty() public view {
        assertEq(address(swapper).balance, 0);
        assertEq(weth.balanceOf(address(swapper)), 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        for (uint256 i; i < handler.tokenCount(); ++i) assertEq(IERC20(handler.tokens(i)).balanceOf(address(swapper)), 0);
    }

    /// deposits never push the supply past the cap (the management fee's TIDX are minted on top of deposits, not by them)
    function invariant_withinCap() public view {
        assertLe(vault.totalSupply() - vault.balanceOf(mgmtTo), vault.totalCap());
    }

    /// the management fee never mints more than 1% a year of the supply for the time that passed since the start
    function invariant_mgmtFeeWithinRate() public view {
        uint256 elapsed = block.timestamp - start;
        // fees accrue on a supply at most totalCap + the fees themselves; a generous upper bound on what 1% a year can mint
        uint256 bound_ = (vault.totalCap() * 2 * 100 * elapsed) / (10_000 * 365 days) + 1;
        assertLe(vault.balanceOf(mgmtTo), bound_);
    }

    /// after each run: the successful paths really ran (shown with -vv)
    function afterInvariant() external view {
        console2.log("successful rebalances / redeems / deposits", handler.rebalances(), handler.redeems(), handler.deposits());
        console2.log("owed EVIL / ETH", vault.totalOwed(address(evil)), vault.totalOwed(address(0)));
        console2.log("rebalance fails", handler.rebalanceFails());
        console2.logBytes4(handler.lastRebalanceErr());
    }
}
