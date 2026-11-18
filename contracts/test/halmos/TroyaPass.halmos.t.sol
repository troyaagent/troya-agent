// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Halmos proofs for TroyaPass: each check_ holds for ALL values of its arguments.
import {Test} from "forge-std/Test.sol";
import {TroyaPass} from "../../src/TroyaPass.sol";

contract BalanceToken {
    mapping(address => uint256) public balanceOf;
    function set(address a, uint256 b) external { balanceOf[a] = b; }
}

contract TroyaPassHalmos is Test {
    TroyaPass pass;
    BalanceToken token;
    uint256 constant MIN = 1_000_000e18;

    function setUp() public {
        token = new BalanceToken();
        pass = new TroyaPass(address(token), MIN);
    }

    function _holder(address who) internal {
        vm.assume(who != address(0) && who.code.length == 0);
        token.set(who, MIN);
        vm.prank(who);
        pass.mint();
    }

    /// Property 1: a pass can only be minted by a wallet holding at least the minimum $TROYA.
    function check_mintNeedsTheMinimum(address who, uint256 balance) public {
        vm.assume(who != address(0) && who.code.length == 0);
        token.set(who, balance);
        vm.prank(who);
        try pass.mint() returns (uint256 id) {
            assert(balance >= MIN);
            assert(pass.ownerOf(id) == who && pass.passOf(who) == id);
        } catch {
            assert(balance < MIN);
        }
    }

    /// Property 2: one pass per wallet. A second mint always fails, whatever the balance.
    function check_onePassPerWallet(address who, uint256 balance) public {
        _holder(who);
        token.set(who, balance);
        vm.prank(who);
        try pass.mint() {
            assert(false);
        } catch {}
        assert(pass.balanceOf(who) == 1);
    }

    /// Property 3: soulbound. No transfer path moves a pass: not by its holder, not by anyone else, to any address.
    function check_cannotBeTransferred(address holder, address caller, address to) public {
        _holder(holder);
        uint256 id = pass.passOf(holder);
        vm.assume(to != address(0));
        vm.prank(caller);
        try pass.transferFrom(holder, to, id) { assert(false); } catch {}
        vm.prank(caller);
        try pass.safeTransferFrom(holder, to, id) { assert(false); } catch {}
        vm.prank(caller);
        try pass.safeTransferFrom(holder, to, id, "") { assert(false); } catch {}
        assert(pass.ownerOf(id) == holder);
    }

    /// Property 4: no approvals can ever be granted.
    function check_noApprovals(address caller, address spender, uint256 id, bool on) public {
        vm.prank(caller);
        try pass.approve(spender, id) { assert(false); } catch {}
        vm.prank(caller);
        try pass.setApprovalForAll(spender, on) { assert(false); } catch {}
    }

    /// Property 5: only the holder can burn their own pass; anyone else's burn changes nothing.
    function check_onlyHolderBurns(address holder, address other) public {
        _holder(holder);
        vm.assume(other != holder);
        uint256 id = pass.passOf(holder);
        vm.prank(other);
        try pass.burn() {} catch {}
        assert(pass.ownerOf(id) == holder);
        vm.prank(holder);
        pass.burn();
        assert(pass.passOf(holder) == 0 && pass.balanceOf(holder) == 0 && pass.totalSupply() == 0);
    }
}
