// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaPass} from "../src/TroyaPass.sol";

/// Against Robinhood Chain (4663) with the real $TROYA token. Skipped, not failed, when the RPC cannot be reached.
contract TroyaPassForkTest is Test {
    address constant TROYA = 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951; // Uniswap v4: holds $TROYA pool reserves

    function test_Fork_RealTroya() public {
        try vm.createSelectFork("robinhood") {}
        catch {
            vm.skip(true, "Robinhood Chain RPC (robinhood.drpc.org) not reachable: fork test skipped");
            return;
        }
        assertEq(block.chainid, 4663, "not Robinhood Chain");
        uint256 held = IERC20(TROYA).balanceOf(POOL_MANAGER);
        assertGt(held, 1e18, "the PoolManager should hold $TROYA");

        TroyaPass pass = new TroyaPass(TROYA, 1e18);
        assertTrue(pass.eligible(POOL_MANAGER));
        address nobody = makeAddr("nobody-on-robinhood");
        assertFalse(pass.eligible(nobody));

        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(TroyaPass.NotEligible.selector, 0, 1e18));
        pass.mint();

        vm.prank(POOL_MANAGER);
        uint256 id = pass.mint();
        assertEq(pass.ownerOf(id), POOL_MANAGER);
        assertTrue(pass.isActive(POOL_MANAGER));
        assertGt(bytes(pass.tokenURI(id)).length, 500);

        // a minimum above what anyone could hold: nobody qualifies
        TroyaPass strict = new TroyaPass(TROYA, held + 1);
        assertFalse(strict.eligible(POOL_MANAGER));
    }
}
