// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TroyaOathVault} from "../src/TroyaOathVault.sol";

contract Coin is ERC20 {
    constructor() ERC20("Coin", "COIN") { _mint(msg.sender, 1_000_000 ether); }
}

/// skims 1% on every transfer: the vault must book what it really received
contract TaxCoin is ERC20 {
    constructor() ERC20("Tax", "TAX") { _mint(msg.sender, 1_000_000 ether); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { uint256 fee = v / 100; super._update(from, address(0xdead), fee); v -= fee; }
        super._update(from, to, v);
    }
}

contract TroyaOathVaultTest is Test {
    TroyaOathVault vault;
    Coin coin;
    address dev = address(0xD3);
    address stranger = address(0xBAD);

    function setUp() public {
        vault = new TroyaOathVault();
        coin = new Coin();
        coin.transfer(dev, 100_000 ether);
        vm.prank(dev); coin.approve(address(vault), type(uint256).max);
    }

    function _lock(uint256 amount, uint64 cliff, uint256 rate) internal returns (uint256) {
        vm.prank(dev);
        return vault.lock(address(coin), amount, dev, cliff, rate);
    }

    function test_nothingBeforeCliff() public {
        uint256 id = _lock(10_000 ether, uint64(block.timestamp + 7 days), 1_000 ether);
        vm.warp(block.timestamp + 7 days);
        assertEq(vault.available(id), 0);
        vm.prank(dev); vm.expectRevert(abi.encodeWithSelector(TroyaOathVault.TooMuch.selector, 1, 0));
        vault.withdraw(id, 1, dev);
    }

    function test_linearAfterCliff() public {
        uint64 cliff = uint64(block.timestamp + 1 days);
        uint256 id = _lock(10_000 ether, cliff, 1_000 ether);
        vm.warp(cliff + 12 hours);
        assertEq(vault.available(id), 500 ether);
        vm.prank(dev); vault.withdraw(id, 500 ether, dev);
        assertEq(vault.available(id), 0);
        vm.warp(cliff + 30 days);
        assertEq(vault.available(id), 9_500 ether);            // capped at what was locked
    }

    function test_onlyBeneficiary() public {
        uint256 id = _lock(1_000 ether, uint64(block.timestamp), 1_000 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(stranger); vm.expectRevert(TroyaOathVault.NotBeneficiary.selector);
        vault.withdraw(id, 1 ether, stranger);
        vm.prank(stranger); vm.expectRevert(TroyaOathVault.NotBeneficiary.selector);
        vault.tighten(id, uint64(block.timestamp + 10 days), 1 ether);
    }

    function test_tightenNeverLoosens() public {
        uint64 cliff = uint64(block.timestamp + 5 days);
        uint256 id = _lock(10_000 ether, cliff, 1_000 ether);
        vm.startPrank(dev);
        vm.expectRevert(TroyaOathVault.Looser.selector); vault.tighten(id, cliff - 1, 1_000 ether);
        vm.expectRevert(TroyaOathVault.Looser.selector); vault.tighten(id, cliff, 1_001 ether);
        vm.expectRevert(TroyaOathVault.Looser.selector); vault.tighten(id, cliff, 0);
        vault.tighten(id, cliff + 5 days, 500 ether);
        vm.stopPrank();
        (,,,, uint64 c, uint128 r) = vault.locks(id);
        assertEq(c, cliff + 5 days); assertEq(r, 500 ether);
    }

    function test_tightenAfterWithdrawDoesNotBrick() public {
        uint64 cliff = uint64(block.timestamp);
        uint256 id = _lock(10_000 ether, cliff, 1_000 ether);
        vm.warp(cliff + 4 days);
        vm.startPrank(dev);
        vault.withdraw(id, 4_000 ether, dev);
        vault.tighten(id, cliff, 500 ether);                  // now only 2,000 unlocked against 4,000 taken
        assertEq(vault.available(id), 0);
        vm.warp(cliff + 10 days);
        assertEq(vault.available(id), 1_000 ether);
        vm.stopPrank();
    }

    function test_feeOnTransferBookedAtReceived() public {
        TaxCoin t = new TaxCoin();
        t.transfer(dev, 10_000 ether);
        vm.startPrank(dev);
        t.approve(address(vault), type(uint256).max);
        uint256 id = vault.lock(address(t), 1_000 ether, dev, uint64(block.timestamp), 10_000 ether);
        vm.stopPrank();
        (,, uint128 amount,,,) = vault.locks(id);
        assertEq(amount, 990 ether);
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.available(id), 990 ether);
    }

    function testFuzz_neverMoreThanUnlocked(uint96 amount, uint32 dt, uint96 rate, uint96 ask) public {
        vm.assume(amount > 0 && amount <= 100_000 ether && rate > 0);
        uint64 cliff = uint64(block.timestamp + 1 days);
        uint256 id = _lock(amount, cliff, rate);
        vm.warp(uint256(cliff) + dt);
        uint256 cap = vault.unlockedAt(id, block.timestamp);
        vm.prank(dev);
        if (ask == 0 || ask > cap) { vm.expectRevert(); vault.withdraw(id, ask, dev); }
        else { vault.withdraw(id, ask, dev); assertLe(ask, uint256(amount)); }
    }

    function testFuzz_unlockMonotoneAndCapped(uint96 amount, uint96 rate, uint32 d1, uint32 d2) public {
        vm.assume(amount > 0 && amount <= 100_000 ether && rate > 0);
        uint64 cliff = uint64(block.timestamp + 1 days);
        uint256 id = _lock(amount, cliff, rate);
        (uint32 a, uint32 b) = d1 <= d2 ? (d1, d2) : (d2, d1);
        uint256 u1 = vault.unlockedAt(id, uint256(cliff) + a);
        uint256 u2 = vault.unlockedAt(id, uint256(cliff) + b);
        assertLe(u1, u2);
        assertLe(u2, uint256(amount));
    }
}
