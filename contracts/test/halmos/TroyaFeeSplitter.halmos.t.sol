// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Halmos proofs (symbolic execution): every check_ function is proven for ALL values of its arguments, not sampled like a
// fuzz test. Run: uvx --python 3.12 halmos --match-path 'test/halmos/*' (from contracts/).
import {Test} from "forge-std/Test.sol";
import {TroyaFeeSplitter, TroyaFeeSplitterFactory} from "../../src/TroyaFeeSplitter.sol";

contract EmptyEscrow {
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function balanceOfToken(address, address) external pure returns (uint256) { return 0; }
    function claim() external pure returns (uint256) { return 0; }
    function claimToken(address) external pure returns (uint256) { return 0; }
}

contract RefusesEth {
    receive() external payable { revert("no"); }
}

contract TroyaFeeSplitterHalmos is Test {
    TroyaFeeSplitterFactory factory;
    EmptyEscrow escrow;
    address constant TREASURY = address(0xBEEF);
    address constant OWNER = address(0xA11CE);
    address constant CREATOR = address(0xC0FFEE);

    function setUp() public {
        escrow = new EmptyEscrow();
        factory = new TroyaFeeSplitterFactory(address(escrow), TREASURY, OWNER);
    }

    /// Property 1: every split adds up. For any amount and any allowed share, the treasury gets exactly
    /// amount * troyaBps / 10000, the creator gets the rest, and nothing stays behind or is created.
    function check_splitAddsUpExactly(uint96 amount, uint16 bps) public {
        vm.assume(bps <= factory.MAX_TROYA_BPS());
        address s = factory.deploy(CREATOR, bps, bytes32(0));
        vm.deal(s, amount);
        uint256 t0 = TREASURY.balance;
        uint256 c0 = CREATOR.balance;
        TroyaFeeSplitter(payable(s)).split(address(0));
        uint256 toTroya = (uint256(amount) * bps) / 10_000;
        assert(TREASURY.balance - t0 == toTroya);
        assert(CREATOR.balance - c0 == uint256(amount) - toTroya);
        assert(s.balance == 0);
    }

    /// Property 2: Troya's share can never be set above 20% (2,000 bps).
    function check_shareCappedAt20Percent(uint16 bps) public {
        vm.assume(bps > factory.MAX_TROYA_BPS());
        try factory.deploy(CREATOR, bps, bytes32(0)) {
            assert(false);
        } catch {}
    }

    /// Property 3: a splitter is initialized once. Nobody (Troya included) can re-initialize it to a new creator or share.
    function check_cannotReinitialize(address caller, address newCreator, uint16 newBps) public {
        address s = factory.deploy(CREATOR, 1_000, bytes32(0));
        vm.prank(caller);
        try TroyaFeeSplitter(payable(s)).initialize(newCreator, newBps) {
            assert(false);
        } catch {}
        assert(TroyaFeeSplitter(payable(s)).creator() == CREATOR);
        assert(TroyaFeeSplitter(payable(s)).troyaBps() == 1_000);
    }

    /// Property 4: the factory owner can only redirect Troya's own share. Changing the treasury never changes the
    /// creator or the share, and the creator's part still goes to the creator.
    function check_ownerCannotTouchCreatorsPart(address newTreasury, uint96 amount) public {
        vm.assume(newTreasury != address(0) && newTreasury.code.length == 0 && newTreasury != CREATOR);
        vm.assume(uint160(newTreasury) > 0x10000); // not a precompile
        address s = factory.deploy(CREATOR, 1_500, bytes32(0));
        vm.prank(OWNER);
        factory.setTreasury(newTreasury);
        assert(TroyaFeeSplitter(payable(s)).creator() == CREATOR);
        assert(TroyaFeeSplitter(payable(s)).troyaBps() == 1_500);
        vm.deal(s, amount);
        uint256 c0 = CREATOR.balance;
        TroyaFeeSplitter(payable(s)).split(address(0));
        assert(CREATOR.balance - c0 == uint256(amount) - (uint256(amount) * 1_500) / 10_000);
    }

    /// Property 5: only the owner can change the treasury.
    function check_onlyOwnerSetsTreasury(address caller, address newTreasury) public {
        vm.assume(caller != OWNER);
        vm.prank(caller);
        try factory.setTreasury(newTreasury) {
            assert(false);
        } catch {}
        assert(factory.treasury() == TREASURY);
    }

    /// Property 6: an amount kept for a creator that refused ETH can only be taken by that creator, and it is never
    /// split again.
    function check_owedOnlyToItsOwner(address thief, uint96 amount) public {
        vm.assume(amount > 0);
        RefusesEth refuser = new RefusesEth();
        vm.assume(thief != address(refuser));
        address s = factory.deploy(address(refuser), 0, bytes32(0));
        vm.deal(s, amount);
        TroyaFeeSplitter(payable(s)).split(address(0));
        assert(TroyaFeeSplitter(payable(s)).owed(address(0), address(refuser)) == amount);
        vm.prank(thief);
        try TroyaFeeSplitter(payable(s)).withdrawOwed(address(0), thief) {
            assert(false);
        } catch {}
        TroyaFeeSplitter(payable(s)).split(address(0)); // a second split moves nothing that is owed
        assert(TroyaFeeSplitter(payable(s)).owed(address(0), address(refuser)) == amount);
        assert(s.balance == amount);
    }
}
