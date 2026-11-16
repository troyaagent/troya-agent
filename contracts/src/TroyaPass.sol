// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Troya Holder Pass
/// @notice A soulbound pass for $TROYA holders on Robinhood Chain. Anyone holding at least MIN_HOLD $TROYA mints one
///         pass to their own wallet; it can never be sold, transferred or approved, only burned by its holder. Votes
///         (signed off chain) count a pass only while its wallet still holds MIN_HOLD: see isActive().
/// @dev No owner, no admin, no pause, no upgrade, no fees, no withdraw. The only external call is TOKEN.balanceOf.
///      Implements EIP-5192 (minimal soulbound NFTs): locked() is always true.
contract TroyaPass is ERC721 {
    using Strings for uint256;

    /// @notice The $TROYA token whose balance decides eligibility.
    IERC20 public immutable TOKEN;
    /// @notice The $TROYA balance (in token units, 18 decimals) needed to mint and to stay active.
    uint256 public immutable MIN_HOLD;

    /// @notice Passes ever minted (the last token id). Ids start at 1 and are never reused.
    uint256 public totalMinted;
    /// @notice Passes that exist now (minted minus burned).
    uint256 public totalSupply;
    /// @notice The pass held by a wallet, 0 if none.
    mapping(address => uint256) public passOf;

    struct Minted {
        uint64 blockNumber;
        uint64 timestamp;
    }

    mapping(uint256 => Minted) private _minted;

    /// @dev EIP-5192
    event Locked(uint256 tokenId);

    error ZeroToken();
    error NotEligible(uint256 balance, uint256 minHold);
    error AlreadyHasPass(uint256 tokenId);
    error NoPass();
    error Soulbound();

    constructor(address token, uint256 minHold) ERC721("Troya Holder Pass", "TPASS") {
        if (token == address(0)) revert ZeroToken();
        TOKEN = IERC20(token);
        MIN_HOLD = minHold;
    }

    /* ---------- holders ---------- */

    /// @notice Mint your pass. Needs MIN_HOLD $TROYA in this wallet and no pass yet.
    function mint() external returns (uint256 tokenId) {
        uint256 held = passOf[msg.sender];
        if (held != 0) revert AlreadyHasPass(held);
        uint256 balance = TOKEN.balanceOf(msg.sender);
        if (balance < MIN_HOLD) revert NotEligible(balance, MIN_HOLD);
        tokenId = ++totalMinted;
        unchecked {
            ++totalSupply;
        }
        passOf[msg.sender] = tokenId;
        _minted[tokenId] = Minted(uint64(block.number), uint64(block.timestamp));
        _mint(msg.sender, tokenId); // no receiver callback: a pass only ever goes to the caller
        emit Locked(tokenId);
    }

    /// @notice Burn your own pass. You may mint a new one later while you still hold MIN_HOLD.
    function burn() external {
        uint256 tokenId = passOf[msg.sender];
        if (tokenId == 0) revert NoPass();
        delete passOf[msg.sender];
        delete _minted[tokenId];
        unchecked {
            --totalSupply;
        }
        _burn(tokenId);
    }

    /* ---------- views ---------- */

    /// @notice True when the wallet holds at least MIN_HOLD $TROYA right now.
    function eligible(address account) public view returns (bool) {
        return TOKEN.balanceOf(account) >= MIN_HOLD;
    }

    /// @notice True when the wallet has a pass and still holds MIN_HOLD $TROYA: only these count in votes.
    function isActive(address account) external view returns (bool) {
        return passOf[account] != 0 && eligible(account);
    }

    /// @notice The block number and timestamp a pass was minted at.
    function mintedAt(uint256 tokenId) external view returns (uint256 blockNumber, uint256 timestamp) {
        _requireOwned(tokenId);
        Minted memory m = _minted[tokenId];
        return (m.blockNumber, m.timestamp);
    }

    /// @notice EIP-5192: every pass is locked to its wallet.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId); // EIP-5192
    }

    /// @notice Fully on-chain metadata: base64 JSON with an SVG image.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory n = tokenId.toString();
        string memory json = string.concat(
            '{"name":"Troya Holder Pass #',
            n,
            '","description":"A soulbound pass for $TROYA holders on Robinhood Chain. It cannot be sold, transferred or approved, only burned by its holder. It counts in Troya votes while its wallet still holds the minimum $TROYA.",',
            '"attributes":[{"trait_type":"Pass number","display_type":"number","value":',
            n,
            '},{"trait_type":"Minted block","display_type":"number","value":',
            uint256(_minted[tokenId].blockNumber).toString(),
            '},{"trait_type":"Soulbound","value":"Yes"}],"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(n))),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _svg(string memory n) internal pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">',
            '<defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0" stop-color="#f4f7f8"/><stop offset=".5" stop-color="#8edff5"/><stop offset="1" stop-color="#3d7486"/>',
            "</linearGradient></defs>",
            '<rect width="600" height="600" fill="#0d0c0b"/>',
            '<rect x="28" y="28" width="544" height="544" rx="28" fill="none" stroke="#8edff5" stroke-opacity=".38"/>',
            '<rect x="44" y="44" width="512" height="512" rx="20" fill="none" stroke="#8edff5" stroke-opacity=".12"/>',
            '<text x="300" y="252" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="104" font-weight="700" letter-spacing="6" fill="url(#c)">TROYA</text>',
            '<line x1="210" y1="292" x2="390" y2="292" stroke="#8edff5" stroke-opacity=".5"/>',
            '<text x="300" y="338" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" letter-spacing="10" fill="#8edff5">HOLDER PASS</text>',
            '<text x="300" y="468" text-anchor="middle" font-family="Courier New,monospace" font-size="40" fill="#f4f7f8">#',
            n,
            "</text>",
            '<text x="300" y="518" text-anchor="middle" font-family="Courier New,monospace" font-size="13" letter-spacing="3" fill="#8edff5" fill-opacity=".6">SOULBOUND / ROBINHOOD CHAIN</text>',
            "</svg>"
        );
    }

    /* ---------- soulbound ---------- */

    /// @dev Only mint (from 0) and burn (to 0) pass through; any transfer between wallets reverts.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }
}
