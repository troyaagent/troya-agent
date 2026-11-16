// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {TroyaPass} from "../src/TroyaPass.sol";

contract MockTroya is ERC20 {
    constructor() ERC20("Troya Agent", "TROYA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ReceiverRejects {
    // a contract wallet with no onERC721Received: mint must still work (no safe-mint callback)
    function mintPass(TroyaPass p) external returns (uint256) {
        return p.mint();
    }
}

library B64 {
    function decode(string memory s) internal pure returns (bytes memory out) {
        bytes memory d = bytes(s);
        require(d.length % 4 == 0, "b64 length");
        uint256 pad = d.length > 0 && d[d.length - 1] == "=" ? (d[d.length - 2] == "=" ? 2 : 1) : 0;
        out = new bytes(d.length / 4 * 3 - pad);
        uint256 j;
        for (uint256 i = 0; i < d.length; i += 4) {
            uint256 n = (_v(d[i]) << 18) | (_v(d[i + 1]) << 12) | (_v(d[i + 2]) << 6) | _v(d[i + 3]);
            // forge-lint: disable-next-line(unsafe-typecast)
            if (j < out.length) out[j++] = bytes1(uint8(n >> 16));
            // forge-lint: disable-next-line(unsafe-typecast)
            if (j < out.length) out[j++] = bytes1(uint8(n >> 8));
            // forge-lint: disable-next-line(unsafe-typecast)
            if (j < out.length) out[j++] = bytes1(uint8(n));
        }
    }

    function _v(bytes1 c) private pure returns (uint256) {
        if (c >= "A" && c <= "Z") return uint8(c) - 65;
        if (c >= "a" && c <= "z") return uint8(c) - 71;
        if (c >= "0" && c <= "9") return uint8(c) + 4;
        if (c == "+") return 62;
        if (c == "/") return 63;
        if (c == "=") return 0;
        revert("b64 char");
    }
}

contract TroyaPassTest is Test {
    MockTroya token;
    TroyaPass pass;
    uint256 constant MIN = 1_000_000e18;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);

    function setUp() public {
        token = new MockTroya();
        pass = new TroyaPass(address(token), MIN);
        token.mint(alice, MIN);
        token.mint(bob, MIN * 3);
    }

    function test_Constructor() public view {
        assertEq(address(pass.TOKEN()), address(token));
        assertEq(pass.MIN_HOLD(), MIN);
        assertEq(pass.name(), "Troya Holder Pass");
        assertEq(pass.symbol(), "TPASS");
    }

    function test_RevertZeroToken() public {
        vm.expectRevert(TroyaPass.ZeroToken.selector);
        new TroyaPass(address(0), MIN);
    }

    function test_MintWhenEligible() public {
        vm.roll(1234);
        vm.warp(1_800_000_000);
        vm.expectEmit(true, true, true, true, address(pass));
        emit Transfer(address(0), alice, 1);
        vm.expectEmit(false, false, false, true, address(pass));
        emit Locked(1);
        vm.prank(alice);
        uint256 id = pass.mint();
        assertEq(id, 1);
        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.passOf(alice), 1);
        assertEq(pass.balanceOf(alice), 1);
        assertEq(pass.totalMinted(), 1);
        assertEq(pass.totalSupply(), 1);
        (uint256 blk, uint256 ts) = pass.mintedAt(1);
        assertEq(blk, 1234);
        assertEq(ts, 1_800_000_000);
        assertTrue(pass.locked(1));
        assertTrue(pass.isActive(alice));
    }

    function test_RevertWhenNotEligible() public {
        address carol = makeAddr("carol");
        token.mint(carol, MIN - 1);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(TroyaPass.NotEligible.selector, MIN - 1, MIN));
        pass.mint();
        assertFalse(pass.eligible(carol));
        assertFalse(pass.isActive(carol));
    }

    function test_OnePerWallet() public {
        vm.startPrank(alice);
        pass.mint();
        vm.expectRevert(abi.encodeWithSelector(TroyaPass.AlreadyHasPass.selector, 1));
        pass.mint();
        vm.stopPrank();
        assertEq(pass.balanceOf(alice), 1);
    }

    function test_TransferReverts() public {
        vm.prank(alice);
        pass.mint();
        vm.startPrank(alice);
        vm.expectRevert(TroyaPass.Soulbound.selector);
        pass.transferFrom(alice, bob, 1);
        vm.expectRevert(TroyaPass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1);
        vm.expectRevert(TroyaPass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1, "");
        vm.stopPrank();
        assertEq(pass.ownerOf(1), alice);
    }

    function test_ApproveReverts() public {
        vm.prank(alice);
        pass.mint();
        vm.startPrank(alice);
        vm.expectRevert(TroyaPass.Soulbound.selector);
        pass.approve(bob, 1);
        vm.expectRevert(TroyaPass.Soulbound.selector);
        pass.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(pass.getApproved(1), address(0));
        assertFalse(pass.isApprovedForAll(alice, bob));
    }

    function test_BurnThenRemint() public {
        vm.startPrank(alice);
        pass.mint();
        vm.expectEmit(true, true, true, true, address(pass));
        emit Transfer(alice, address(0), 1);
        pass.burn();
        assertEq(pass.passOf(alice), 0);
        assertEq(pass.balanceOf(alice), 0);
        assertEq(pass.totalSupply(), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        pass.ownerOf(1);
        uint256 again = pass.mint();
        vm.stopPrank();
        assertEq(again, 2, "ids are never reused");
        assertEq(pass.passOf(alice), 2);
        assertEq(pass.totalMinted(), 2);
        assertEq(pass.totalSupply(), 1);
    }

    function test_BurnWithoutPassReverts() public {
        vm.prank(alice);
        vm.expectRevert(TroyaPass.NoPass.selector);
        pass.burn();
    }

    function test_IsActiveAfterSelling() public {
        vm.prank(alice);
        pass.mint();
        assertTrue(pass.isActive(alice));
        vm.prank(alice);
        assertTrue(token.transfer(bob, 1)); // now below MIN_HOLD
        assertFalse(pass.isActive(alice));
        assertEq(pass.ownerOf(1), alice, "the pass stays, it just stops counting");
        vm.prank(bob);
        assertTrue(token.transfer(alice, 1));
        assertTrue(pass.isActive(alice));
    }

    function test_ContractWalletWithoutReceiverCanMint() public {
        ReceiverRejects w = new ReceiverRejects();
        token.mint(address(w), MIN);
        uint256 id = w.mintPass(pass);
        assertEq(pass.ownerOf(id), address(w));
    }

    function test_SupportsInterface() public view {
        assertTrue(pass.supportsInterface(0xb45a3c0e)); // EIP-5192
        assertTrue(pass.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(pass.supportsInterface(0x5b5e139f)); // ERC-721 metadata
        assertTrue(pass.supportsInterface(0x01ffc9a7)); // ERC-165
        assertFalse(pass.supportsInterface(0xffffffff));
    }

    function test_TokenURI() public {
        vm.roll(777);
        vm.prank(bob);
        pass.mint();
        string memory uri = pass.tokenURI(1);
        string memory prefix = "data:application/json;base64,";
        assertTrue(_startsWith(uri, prefix));
        string memory json = string(B64.decode(_after(uri, bytes(prefix).length)));
        assertEq(vm.parseJsonString(json, ".name"), "Troya Holder Pass #1");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), 1);
        assertEq(vm.parseJsonUint(json, ".attributes[1].value"), 777);
        assertEq(vm.parseJsonString(json, ".attributes[2].value"), "Yes");
        string memory image = vm.parseJsonString(json, ".image");
        string memory ip = "data:image/svg+xml;base64,";
        assertTrue(_startsWith(image, ip));
        string memory svg = string(B64.decode(_after(image, bytes(ip).length)));
        assertTrue(_startsWith(svg, "<svg "));
        assertTrue(_contains(svg, "HOLDER PASS"));
        assertTrue(_contains(svg, ">#1</text>"));
        assertTrue(_contains(svg, "#0d0c0b"));
        assertTrue(_contains(svg, "#8edff5"));
    }

    function test_TokenURIRevertsForMissingToken() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 9));
        pass.tokenURI(9);
    }

    function testFuzz_Eligibility(uint256 balance) public {
        balance = bound(balance, 0, MIN * 10);
        address w = makeAddr("fuzz");
        token.mint(w, balance);
        assertEq(pass.eligible(w), balance >= MIN);
        vm.prank(w);
        if (balance < MIN) {
            vm.expectRevert(abi.encodeWithSelector(TroyaPass.NotEligible.selector, balance, MIN));
            pass.mint();
        } else {
            uint256 id = pass.mint();
            assertEq(pass.ownerOf(id), w);
        }
    }

    /* ---------- helpers ---------- */
    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    function _after(string memory s, uint256 from) internal pure returns (string memory) {
        bytes memory a = bytes(s);
        bytes memory out = new bytes(a.length - from);
        for (uint256 i; i < out.length; i++) out[i] = a[from + i];
        return string(out);
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(needle);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; i++) {
            bool ok = true;
            for (uint256 j; j < b.length; j++) {
                if (a[i + j] != b[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
