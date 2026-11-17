// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

interface IPonsCurve {
    function sweepFees(uint256 minQuoteOut) external;
}

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Troya fee splitter
/// @notice The Pons creator-fee recipient of one coin launched through Troya by a wallet that does not hold 1,000,000 $TROYA.
/// Everything it collects is split two ways: `troyaBps` of it to the Troya treasury and the rest to the creator.
/// The creator and the share are fixed when the splitter is created. Nobody, Troya included, can change them, move the
/// creator's part, or point the coin's fees anywhere else: this contract has no function for that.
/// @dev Deployed as an EIP-1167 clone by {TroyaFeeSplitterFactory} at a CREATE2 address that is known before the coin is
/// launched, so the clone only has to exist once there is something to collect.
contract TroyaFeeSplitter is ReentrancyGuard {
    /// @notice The factory that created this splitter; it names the Pons fee escrow and the Troya treasury.
    TroyaFeeSplitterFactory public factory;
    /// @notice The wallet that launched the coin. It receives everything that is not Troya's share.
    address public creator;
    /// @notice Troya's share of every amount collected, in basis points of that amount.
    uint16 public troyaBps;

    /// @notice Amounts a recipient refused to receive (a contract without a way to accept ETH or tokens), kept for them here.
    /// token address(0) is ETH.
    mapping(address token => mapping(address account => uint256)) public owed;
    /// @notice The total of `owed` per token, never counted again in a split.
    mapping(address token => uint256) public totalOwed;

    event Split(address indexed token, uint256 toCreator, uint256 toTroya, address treasury);
    event Owed(address indexed token, address indexed account, uint256 amount);
    event OwedWithdrawn(address indexed token, address indexed account, address to, uint256 amount);

    error AlreadyInitialized();
    error NothingOwed();
    error TransferFailed();

    constructor() {
        // the implementation itself can never be initialized; only its clones are
        factory = TroyaFeeSplitterFactory(address(1));
    }

    /// @dev Called once by the factory in the same transaction that creates the clone.
    function initialize(address creator_, uint16 troyaBps_) external {
        if (address(factory) != address(0)) revert AlreadyInitialized();
        factory = TroyaFeeSplitterFactory(msg.sender);
        creator = creator_;
        troyaBps = troyaBps_;
    }

    receive() external payable {}

    /// @notice Pulls this splitter's fees from Pons and splits them. Anyone may call it; the split is the same whoever does.
    /// @param curves Pons curves to sweep first (the coin's own curve before graduation). A curve this splitter does not
    /// receive fees from simply refuses and is skipped.
    /// @param tokens ERC-20 tokens to claim from the Pons escrow and split as well (ETH is always claimed and split).
    function collect(address[] calldata curves, address[] calldata tokens) external nonReentrant {
        IPonsFeeEscrow escrow = IPonsFeeEscrow(factory.escrow());
        for (uint256 i; i < curves.length; ++i) {
            if (curves[i].code.length == 0) continue;
            try IPonsCurve(curves[i]).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        _split(address(0));
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(0)) continue;
            if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
            _split(t);
        }
    }

    /// @notice Splits whatever ETH or `token` already sits in this splitter, without touching Pons.
    function split(address token) external nonReentrant {
        _split(token);
    }

    /// @notice Sends an amount kept for `msg.sender` (see `owed`) to an address that can receive it.
    function withdrawOwed(address token, address to) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        totalOwed[token] -= amount;
        if (!_send(token, to, amount)) revert TransferFailed();
        emit OwedWithdrawn(token, msg.sender, to, amount);
    }

    function _split(address token) internal {
        uint256 held = token == address(0) ? address(this).balance : IERC20Min(token).balanceOf(address(this));
        uint256 amount = held - totalOwed[token];
        if (amount == 0) return;
        uint256 toTroya = (amount * troyaBps) / 10_000;
        uint256 toCreator = amount - toTroya;
        address treasury = factory.treasury();
        _pay(token, treasury, toTroya);
        _pay(token, creator, toCreator);
        emit Split(token, toCreator, toTroya, treasury);
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_send(token, to, amount)) {
            owed[token][to] += amount;
            totalOwed[token] += amount;
            emit Owed(token, to, amount);
        }
    }

    function _send(address token, address to, uint256 amount) internal returns (bool ok) {
        if (token == address(0)) {
            (ok,) = to.call{value: amount}("");
            return ok;
        }
        bytes memory ret;
        (ok, ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        ok = ok && (ret.length == 0 || abi.decode(ret, (bool)));
        if (ok && ret.length == 0 && token.code.length == 0) ok = false;
    }
}

/// @title Troya fee splitter factory
/// @notice Creates one {TroyaFeeSplitter} per coin at an address that can be worked out before the coin is launched, so it can
/// be set as the coin's Pons creator-fee recipient at launch. The owner can only change where Troya's own share goes.
contract TroyaFeeSplitterFactory is Ownable2Step {
    /// @notice Troya's share can never be set above 20% of a creator's fees.
    uint16 public constant MAX_TROYA_BPS = 2_000;

    /// @notice The splitter code every clone runs.
    address public immutable implementation;
    /// @notice The Pons v2 fee escrow on Robinhood Chain.
    address public immutable escrow;
    /// @notice Where Troya's share goes.
    address public treasury;

    event SplitterCreated(address indexed splitter, address indexed creator, uint16 troyaBps, bytes32 salt);
    event TreasuryUpdated(address indexed treasury);

    error ZeroAddress();
    error ShareTooHigh();

    constructor(address escrow_, address treasury_, address owner_) Ownable(owner_) {
        if (escrow_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        treasury = treasury_;
        implementation = address(new TroyaFeeSplitter());
        emit TreasuryUpdated(treasury_);
    }

    /// @notice The address the splitter for (`creator`, `troyaBps`, `salt`) has, or will have once created.
    function predict(address creator, uint16 troyaBps, bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(creator, troyaBps, salt), address(this));
    }

    /// @notice Creates the splitter for (`creator`, `troyaBps`, `salt`), or returns it if it already exists. Anyone may call it.
    function deploy(address creator, uint16 troyaBps, bytes32 salt) public returns (address splitter) {
        if (creator == address(0)) revert ZeroAddress();
        if (troyaBps > MAX_TROYA_BPS) revert ShareTooHigh();
        splitter = predict(creator, troyaBps, salt);
        if (splitter.code.length > 0) return splitter;
        splitter = Clones.cloneDeterministic(implementation, _salt(creator, troyaBps, salt));
        TroyaFeeSplitter(payable(splitter)).initialize(creator, troyaBps);
        emit SplitterCreated(splitter, creator, troyaBps, salt);
    }

    /// @notice Creates the splitter if needed, then collects and splits its fees.
    function deployAndCollect(address creator, uint16 troyaBps, bytes32 salt, address[] calldata curves, address[] calldata tokens)
        external
        returns (address splitter)
    {
        splitter = deploy(creator, troyaBps, salt);
        TroyaFeeSplitter(payable(splitter)).collect(curves, tokens);
    }

    /// @notice Changes where Troya's share goes from now on. It never touches a creator's share.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function _salt(address creator, uint16 troyaBps, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, troyaBps, salt));
    }
}
