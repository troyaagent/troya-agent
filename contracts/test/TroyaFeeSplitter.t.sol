// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TroyaFeeSplitter, TroyaFeeSplitterFactory} from "../src/TroyaFeeSplitter.sol";

/// A stand-in for the Pons v2 fee escrow: balances per recipient, claim() pays msg.sender.
contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function credit(address recipient) external payable { balanceOf[recipient] += msg.value; }

    function creditToken(address recipient, address token, uint256 amount) external {
        ERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOfToken[recipient][token] += amount;
    }

    function claim() external returns (uint256 a) {
        a = balanceOf[msg.sender];
        require(a > 0, "NoBalance");
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "TransferFailed");
    }

    function claimToken(address token) external returns (uint256 a) {
        a = balanceOfToken[msg.sender][token];
        require(a > 0, "NoBalance");
        balanceOfToken[msg.sender][token] = 0;
        ERC20(token).transfer(msg.sender, a);
    }
}

/// A stand-in for a Pons curve: fees wait here until the fee recipient sweeps them into the escrow.
contract MockCurve {
    MockEscrow public escrow;
    address public recipient;
    constructor(MockEscrow e, address r) { escrow = e; recipient = r; }
    receive() external payable {}

    function sweepFees(uint256) external {
        require(msg.sender == recipient, "not recipient");
        escrow.credit{value: address(this).balance}(recipient);
    }
}

contract Coin is ERC20 {
    constructor() ERC20("Coin", "COIN") { _mint(msg.sender, 1e27); }
}

/// A creator wallet that cannot take ETH (a contract without receive()).
contract NoEth {}

contract TroyaFeeSplitterTest is Test {
    MockEscrow escrow;
    TroyaFeeSplitterFactory factory;
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    bytes32 salt = keccak256("coin-1");
    uint16 constant BPS = 1428; // 10/70 of the creator's 0.7%: 0.1% of volume

    function setUp() public {
        escrow = new MockEscrow();
        factory = new TroyaFeeSplitterFactory(address(escrow), treasury, owner);
    }

    function test_PredictMatchesDeployAndIsIdempotent() public {
        address p = factory.predict(creator, BPS, salt);
        assertEq(p.code.length, 0);
        address s = factory.deploy(creator, BPS, salt);
        assertEq(s, p);
        assertGt(s.code.length, 0);
        assertEq(factory.deploy(creator, BPS, salt), s, "second deploy returns the same splitter");
        TroyaFeeSplitter sp = TroyaFeeSplitter(payable(s));
        assertEq(sp.creator(), creator);
        assertEq(sp.troyaBps(), BPS);
        assertEq(address(sp.factory()), address(factory));
    }

    function test_AddressBindsCreatorAndShare() public {
        address a = factory.predict(creator, BPS, salt);
        assertTrue(a != factory.predict(makeAddr("other"), BPS, salt), "another creator gets another address");
        assertTrue(a != factory.predict(creator, BPS + 1, salt), "another share gets another address");
        assertTrue(a != factory.predict(creator, BPS, keccak256("coin-2")), "another salt gets another address");
    }

    function test_FeesCreditedBeforeTheCloneExistsAreSplit() public {
        address p = factory.predict(creator, BPS, salt);
        MockCurve curve = new MockCurve(escrow, p);
        vm.deal(address(curve), 7 ether);   // fees waiting on the curve
        escrow.credit{value: 3 ether}(p);   // and fees already in the escrow (after graduation)
        address[] memory curves = new address[](1);
        curves[0] = address(curve);
        factory.deployAndCollect(creator, BPS, salt, curves, new address[](0));
        uint256 total = 10 ether;
        assertEq(treasury.balance, total * BPS / 10_000);
        assertEq(creator.balance, total - total * BPS / 10_000);
        assertEq(p.balance, 0);
        assertEq(escrow.balanceOf(p), 0);
    }

    function test_AnyoneCanCollectAndTheSplitIsTheSame() public {
        address s = factory.deploy(creator, BPS, salt);
        escrow.credit{value: 1 ether}(s);
        vm.prank(makeAddr("stranger"));
        TroyaFeeSplitter(payable(s)).collect(new address[](0), new address[](0));
        assertEq(treasury.balance, 0.1428 ether);
        assertEq(creator.balance, 0.8572 ether);
    }

    function test_TokensAreSplitToo() public {
        Coin c = new Coin();
        address s = factory.deploy(creator, BPS, salt);
        c.approve(address(escrow), 1000e18);
        escrow.creditToken(s, address(c), 1000e18);
        address[] memory toks = new address[](1);
        toks[0] = address(c);
        TroyaFeeSplitter(payable(s)).collect(new address[](0), toks);
        assertEq(c.balanceOf(treasury), 142.8e18);
        assertEq(c.balanceOf(creator), 857.2e18);
    }

    function test_SkipsCurvesItDoesNotOwnAndAddressesWithoutCode() public {
        address s = factory.deploy(creator, BPS, salt);
        MockCurve foreign = new MockCurve(escrow, makeAddr("someone-else"));
        vm.deal(address(foreign), 1 ether);
        address[] memory curves = new address[](2);
        curves[0] = address(foreign);
        curves[1] = makeAddr("not-a-contract");
        TroyaFeeSplitter(payable(s)).collect(curves, new address[](0));
        assertEq(address(foreign).balance, 1 ether, "a foreign curve keeps its fees");
        assertEq(creator.balance, 0);
    }

    function test_ACreatorThatRefusesEthIsOwedAndCanWithdrawElsewhere() public {
        address noEth = address(new NoEth());
        address s = factory.deploy(noEth, BPS, salt);
        escrow.credit{value: 1 ether}(s);
        TroyaFeeSplitter sp = TroyaFeeSplitter(payable(s));
        sp.collect(new address[](0), new address[](0));
        assertEq(treasury.balance, 0.1428 ether, "Troya's part still goes out");
        assertEq(sp.owed(address(0), noEth), 0.8572 ether);
        // more fees later: the owed part is never split again
        escrow.credit{value: 1 ether}(s);
        sp.collect(new address[](0), new address[](0));
        assertEq(treasury.balance, 0.2856 ether);
        assertEq(sp.owed(address(0), noEth), 1.7144 ether);
        address to = makeAddr("creator-eoa");
        vm.prank(noEth);
        sp.withdrawOwed(address(0), to);
        assertEq(to.balance, 1.7144 ether);
        assertEq(s.balance, 0);
        vm.prank(noEth);
        vm.expectRevert(TroyaFeeSplitter.NothingOwed.selector);
        sp.withdrawOwed(address(0), to);
    }

    function test_CannotBeInitializedTwiceNorTheImplementation() public {
        address s = factory.deploy(creator, BPS, salt);
        vm.expectRevert(TroyaFeeSplitter.AlreadyInitialized.selector);
        TroyaFeeSplitter(payable(s)).initialize(makeAddr("thief"), 0);
        TroyaFeeSplitter impl = TroyaFeeSplitter(payable(factory.implementation()));
        vm.expectRevert(TroyaFeeSplitter.AlreadyInitialized.selector);
        impl.initialize(makeAddr("thief"), 0);
    }

    function test_ShareIsCappedAndCreatorRequired() public {
        vm.expectRevert(TroyaFeeSplitterFactory.ShareTooHigh.selector);
        factory.deploy(creator, 2001, salt);
        vm.expectRevert(TroyaFeeSplitterFactory.ZeroAddress.selector);
        factory.deploy(address(0), BPS, salt);
        factory.deploy(creator, 2000, salt); // the cap itself is fine
    }

    function test_OnlyOwnerMovesTroyasShareAndNeverTheCreators() public {
        address s = factory.deploy(creator, BPS, salt);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setTreasury(makeAddr("x"));
        address t2 = makeAddr("treasury-2");
        vm.prank(owner);
        factory.setTreasury(t2);
        escrow.credit{value: 1 ether}(s);
        TroyaFeeSplitter(payable(s)).collect(new address[](0), new address[](0));
        assertEq(t2.balance, 0.1428 ether);
        assertEq(treasury.balance, 0);
        assertEq(creator.balance, 0.8572 ether);
    }

    function testFuzz_SplitAddsUp(uint96 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 2000));
        vm.assume(amount > 0);
        address s = factory.deploy(creator, bps, salt);
        vm.deal(address(this), amount);
        escrow.credit{value: amount}(s);
        TroyaFeeSplitter(payable(s)).collect(new address[](0), new address[](0));
        assertEq(treasury.balance + creator.balance, amount);
        assertEq(treasury.balance, uint256(amount) * bps / 10_000);
    }
}
