// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIndex, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @dev Uniswap v4 types, ABI-identical to v4-core (Currency and IHooks are addresses there). Named apart from the ones in
/// TroyaFeeRouter.sol so both files can be imported together.
struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerV4 {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V4PoolKey memory key, V4SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
    function exttload(bytes32 slot) external view returns (bytes32);
}

/// @notice One pool the index may trade in: a Uniswap v3 pool from the canonical factory, or a Uniswap v4 pool of the
/// canonical PoolManager with no hook or the Pons hook. `asset0` / `asset1` are the vault's own names for the pool's two
/// tokens: ETH is address(0), and WETH in a pool is ETH to the vault (wrapped and unwrapped inside the swap).
struct Venue {
    uint8 kind; // 1 = Uniswap v3, 2 = Uniswap v4
    bool active;
    uint16 slippageBps; // the most a trade here may come out under the 24-hour median price, pool fees included
    address pool; // v3: the pool; v4: 0
    address token0; // the pool's token0 / currency0 (WETH, a token, or address(0) for native ETH in v4)
    address token1;
    address asset0; // the vault asset for token0
    address asset1; // the vault asset for token1
    uint24 fee; // v3 and v4: the pool fee
    int24 tickSpacing; // v4 key
    address hooks; // v4 key
}

/// @title Troya Index swap engine
/// @notice The single place where TroyaIndex and TroyaIndexZap trade. swap() trades what the caller just sent it (ETH as
/// msg.value, or tokens transferred in just before) in one pool, and sends everything back to the caller in the same
/// call: the bought asset and any unspent input. It pays the pool at most the budget it was given and only answers the
/// pool it called: a v3 callback from any other address, or a v4 callback outside a swap it started, is refused.
/// @dev No owner, no admin, no upgrade, no storage beyond the three guard slots of the swap in progress. It holds
/// nothing between transactions, so there is nothing in it to take. The vault never trusts what it reports: it measures
/// its own balances before and after.
contract TroyaIndexSwapper is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint8 internal constant KIND_V3 = 1;
    uint8 internal constant KIND_V4 = 2;
    /// @dev v4-core Lock.IS_UNLOCKED_SLOT (transient) and the PoolManager's `_pools` mapping slot (StateLibrary.POOLS_SLOT)
    bytes32 private constant IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    uint256 private constant POOLS_SLOT = 6;
    /// @dev TickMath.MIN_SQRT_PRICE (v3 MIN_SQRT_RATIO); a price limit must stay strictly above it
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;

    /// @notice Wrapped ETH of Robinhood Chain (only ever held inside a swap).
    IWETH9 public immutable weth;
    /// @notice The canonical Uniswap v3 factory: a v3 venue must be one of its pools.
    IUniswapV3Factory public immutable v3Factory;
    /// @notice The canonical Uniswap v4 PoolManager.
    IPoolManagerV4 public immutable poolManager;
    /// @notice The only v4 hook a venue may have besides none: the Pons hook of graduated Pons coins.
    address public immutable ponsHook;

    address private _v3Pool; // the v3 pool of the swap in progress, 0 otherwise
    address private _v3TokenIn; // what that pool may ask to be paid in
    uint256 private _maxIn; // the most the pool may ask; also marks a v4 swap in progress when non-zero

    error NotPool();
    error TooMuchIn(uint256 asked, uint256 budget);
    error UnexpectedDelta();
    error TransferFailed();

    constructor(address weth_, address v3Factory_, address poolManager_, address ponsHook_) {
        weth = IWETH9(weth_);
        v3Factory = IUniswapV3Factory(v3Factory_);
        poolManager = IPoolManagerV4(poolManager_);
        ponsHook = ponsHook_;
    }

    /// @notice ETH from WETH unwraps (and nothing else meant).
    receive() external payable {}

    /// @notice Swaps in venue `v` with what the caller sent (msg.value for ETH, or tokens transferred here first) and
    /// returns the bought asset and any unspent input to the caller. exactIn: sell exactly `amount`; otherwise buy
    /// exactly `amount`; either may stop early at `limit`. The pool is paid at most `maxIn`.
    /// @return spent Input used. @return received Output sent back.
    function swap(Venue calldata v, bool zeroForOne, bool exactIn, uint256 amount, uint256 maxIn, uint160 limit)
        external
        payable
        nonReentrant
        returns (uint256 spent, uint256 received)
    {
        (address assetIn, address assetOut) = zeroForOne ? (v.asset0, v.asset1) : (v.asset1, v.asset0);
        uint256 inBefore = _bal(assetIn);
        _swap(v, zeroForOne, exactIn, amount, maxIn, limit);
        uint256 inLeft = _bal(assetIn);
        spent = inBefore - inLeft;
        received = _bal(assetOut);
        _send(assetOut, received);
        _send(assetIn, inLeft);
    }

    function _bal(address asset) private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    function _send(address asset, uint256 amount) private {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
    }

    /// @dev Swaps in venue `v`. exactIn: sells exactly `amount` (or less if `limit` is reached); otherwise buys exactly
    /// `amount` (or less if `limit` is reached). The pool is paid at most `maxIn`. Any WETH this contract holds afterwards
    /// is unwrapped, so ETH always comes back as ETH. Callers measure what really moved by their own balances.
    function _swap(Venue calldata v, bool zeroForOne, bool exactIn, uint256 amount, uint256 maxIn, uint160 limit) internal {
        int256 spec = amount.toInt256();
        if (v.kind == KIND_V3) {
            _v3Pool = v.pool;
            _v3TokenIn = zeroForOne ? v.token0 : v.token1;
            _maxIn = maxIn;
            // v3: positive = exact input, negative = exact output
            IUniswapV3Pool(v.pool).swap(address(this), zeroForOne, exactIn ? spec : -spec, limit, "");
            _v3Pool = address(0);
            _v3TokenIn = address(0);
        } else {
            _maxIn = maxIn == 0 ? 1 : maxIn;
            V4PoolKey memory key = V4PoolKey(v.token0, v.token1, v.fee, v.tickSpacing, v.hooks);
            // v4: negative = exact input, positive = exact output
            poolManager.unlock(abi.encode(key, zeroForOne, exactIn ? -spec : spec, limit, maxIn));
        }
        _maxIn = 0;
        uint256 w = IERC20(address(weth)).balanceOf(address(this));
        if (w != 0) weth.withdraw(w);
    }

    /// @notice Uniswap v3 swap callback: pays the pool this contract is swapping in, in the token it sells, at most the
    /// swap's budget. Any other caller is refused.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address pool = _v3Pool;
        if (pool == address(0) || msg.sender != pool) revert NotPool();
        address tokenIn = _v3TokenIn;
        // exactly one side is positive: what the pool is owed, in the token sold
        uint256 owed;
        if (amount0Delta > 0) {
            if (tokenIn != IUniswapV3Pool(pool).token0()) revert UnexpectedDelta();
            owed = uint256(amount0Delta);
        } else if (amount1Delta > 0) {
            if (tokenIn != IUniswapV3Pool(pool).token1()) revert UnexpectedDelta();
            owed = uint256(amount1Delta);
        } else {
            return;
        }
        if (owed > _maxIn) revert TooMuchIn(owed, _maxIn);
        if (tokenIn == address(weth)) weth.deposit{value: owed}();
        IERC20(tokenIn).safeTransfer(pool, owed);
    }

    /// @notice Uniswap v4 unlock callback: runs the one swap this contract asked for and settles it. Only the PoolManager
    /// can call it, and only while a swap started here is in progress.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _maxIn == 0) revert NotPool();
        (V4PoolKey memory key, bool zeroForOne, int256 spec, uint160 limit, uint256 maxIn) =
            abi.decode(data, (V4PoolKey, bool, int256, uint160, uint256));
        int256 delta = poolManager.swap(key, V4SwapParams(zeroForOne, spec, limit), "");
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        // only the sold side may be owed to the pool; the bought side is taken
        (int128 dIn, int128 dOut) = zeroForOne ? (d0, d1) : (d1, d0);
        (address cIn, address cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        if (dOut < 0 || dIn > 0) revert UnexpectedDelta();
        uint256 owed = uint256(uint128(-dIn));
        if (owed > maxIn) revert TooMuchIn(owed, maxIn);
        if (owed != 0) {
            if (cIn == address(0)) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(cIn);
                if (cIn == address(weth)) weth.deposit{value: owed}();
                IERC20(cIn).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
        }
        if (dOut > 0) poolManager.take(cOut, address(this), uint256(uint128(dOut)));
        return "";
    }

    /// @notice The venue's current sqrtPriceX96 (0 if it cannot be read safely now).
    function spot(Venue calldata v) external view returns (uint160) {
        return _spot(v);
    }

    /// @dev The venue's current sqrtPriceX96 (sqrt of token1 per token0, Q64.96), or 0 if it cannot be read safely now:
    /// a v3 pool in the middle of a swap, or the v4 PoolManager unlocked by someone.
    function _spot(Venue calldata v) internal view returns (uint160) {
        if (v.kind == KIND_V3) {
            (uint160 p,,,,,, bool unlocked) = IUniswapV3Pool(v.pool).slot0();
            return unlocked ? p : 0;
        }
        if (poolManager.exttload(IS_UNLOCKED_SLOT) != bytes32(0)) return 0;
        return _v4Price(V4PoolKey(v.token0, v.token1, v.fee, v.tickSpacing, v.hooks));
    }

    function _v4Price(V4PoolKey memory key) internal view returns (uint160) {
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(key)), POOLS_SLOT));
        return uint160(uint256(poolManager.extsload(slot)));
    }
}
