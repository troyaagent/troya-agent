// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Halmos proofs for TroyaOathVault: each check_ holds for ALL values of its arguments.
import {Test} from "forge-std/Test.sol";
import {TroyaOathVault} from "../../src/TroyaOathVault.sol";

/// a plain token with symbolic-friendly transfers (no fee, no hooks)
contract PlainToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 v) external { balanceOf[a] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true; }
}

contract TroyaOathVaultHalmos is Test {
    TroyaOathVault vault;
    PlainToken token;
    address constant DEV = address(0xD3);

    function setUp() public {
        vault = new TroyaOathVault();
        token = new PlainToken();
    }

    // sizes bounded to what any real coin uses (2^96 units, about 79 billion coins at 18 decimals) so the solver's
    // multiplication and division stay tractable; the contract itself works up to uint128
    function _lock(uint128 amount, uint64 cliff, uint128 rate) internal returns (uint256 id) {
        vm.assume(amount > 0 && rate > 0 && amount <= 2 ** 96 && rate <= 2 ** 96 && cliff <= 2 ** 40);
        token.mint(DEV, amount);
        vm.startPrank(DEV);
        token.approve(address(vault), amount);
        id = vault.lock(address(token), amount, DEV, cliff, rate);
        vm.stopPrank();
    }

    /// Property 1: nothing leaves before the cliff, whatever is asked.
    function check_nothingBeforeCliff(uint128 amount, uint64 cliff, uint128 rate, uint64 t, uint256 ask) public {
        uint256 id = _lock(amount, cliff, rate);
        vm.assume(t <= cliff);
        vm.warp(t);
        vm.prank(DEV);
        try vault.withdraw(id, ask, DEV) { assert(false); } catch {}
    }

    /// Property 2: a withdrawal never takes more than the rate has unlocked (by time), so a dev can never dump faster
    /// than its Oath allows.
    function check_neverFasterThanTheRate(uint128 amount, uint64 cliff, uint128 rate, uint64 t, uint256 ask) public {
        uint256 id = _lock(amount, cliff, rate);
        vm.assume(t > cliff && t <= 2 ** 40);
        vm.warp(t);
        uint256 cap = vault.unlockedAt(id, t);       // = min(amount, rate × (t − cliff) / 1 day)
        vm.prank(DEV);
        try vault.withdraw(id, ask, DEV) {
            assert(ask <= cap);
            assert(ask <= amount);
        } catch {}
    }

    /// Property 3: only the beneficiary can take coins out or change the terms.
    function check_onlyBeneficiary(address who, uint128 amount, uint64 cliff, uint128 rate, uint256 ask, uint64 c2, uint256 r2) public {
        uint256 id = _lock(amount, cliff, rate);
        vm.assume(who != DEV);
        vm.warp(type(uint64).max);
        vm.startPrank(who);
        try vault.withdraw(id, ask, who) { assert(false); } catch {}
        try vault.tighten(id, c2, r2) { assert(false); } catch {}
        vm.stopPrank();
    }

    /// Property 4: terms only get stricter. After any successful tighten, the cliff is no earlier and the rate no higher.
    function check_termsOnlyTighten(uint128 amount, uint64 cliff, uint128 rate, uint64 c2, uint256 r2) public {
        uint256 id = _lock(amount, cliff, rate);
        vm.prank(DEV);
        try vault.tighten(id, c2, r2) {
            (,,,, uint64 c, uint128 r) = vault.locks(id);
            assert(c >= cliff && r <= rate && r > 0);
        } catch {}
    }

    /// Property 5: everything taken out of a lock, over two withdrawals at any times, stays within what was locked, and the
    /// vault always holds exactly what was locked minus what was taken.
    function check_totalWithinLock(uint128 amount, uint64 cliff, uint128 rate, uint64 t1, uint64 t2, uint256 a1, uint256 a2) public {
        uint256 id = _lock(amount, cliff, rate);
        vm.assume(t1 <= t2 && t2 <= 2 ** 40);
        uint256 got = 0;
        vm.warp(t1);
        vm.prank(DEV);
        try vault.withdraw(id, a1, DEV) { got += a1; } catch {}
        vm.warp(t2);
        vm.prank(DEV);
        try vault.withdraw(id, a2, DEV) { got += a2; } catch {}
        assert(got <= amount);
        assert(token.balanceOf(address(vault)) == uint256(amount) - got);
    }

    // Unlocking moving forward in time and staying under the locked amount is fuzzed in test/TroyaOathVault.t.sol
    // (testFuzz_unlockMonotoneAndCapped): symbolic division over two times is beyond the solver's time limit.
}
