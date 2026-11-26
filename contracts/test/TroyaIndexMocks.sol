// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// WETH9 as deployed everywhere: deposit / withdraw (ETH sent with a plain call)
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external {
        _burn(msg.sender, a);
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "WETH: ETH transfer failed");
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}

contract MockToken is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, uint8 d) ERC20(n, n) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// A token that can turn hostile on transfer(): revert, burn all gas, return a huge payload, return false, re-enter a
/// target, or take a 1% fee (on every move, also transferFrom).
contract EvilToken is ERC20 {
    enum Mode { Normal, Revert, BurnGas, ReturnBomb, ReturnFalse, Reenter, FeeOnTransfer }
    Mode public mode;
    address public target;
    bytes public payload;
    bool public innerOk;
    bytes public innerErr;
    bool private _inside;

    constructor() ERC20("Evil", "EVIL") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setMode(Mode m) external { mode = m; }
    function arm(address t, bytes calldata p) external { target = t; payload = p; mode = Mode.Reenter; }

    function transfer(address to, uint256 v) public override returns (bool) {
        Mode m = mode;
        if (m == Mode.Revert) revert("EVIL: frozen");
        if (m == Mode.BurnGas) { while (true) {} }
        if (m == Mode.ReturnBomb) {
            assembly { return(0, 1000000) }
        }
        if (m == Mode.ReturnFalse) return false;
        if (m == Mode.Reenter && !_inside) {
            _inside = true;
            (innerOk, innerErr) = target.call(payload);
            _inside = false;
        }
        return super.transfer(to, v);
    }

    function _update(address from, address to, uint256 v) internal override {
        if (mode == Mode.FeeOnTransfer && from != address(0) && to != address(0)) {
            uint256 fee = v / 100;
            super._update(from, address(0xdead), fee);
            v -= fee;
        }
        super._update(from, to, v);
    }
}

interface IV3CallbackLike {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// One Uniswap v3 pool with a single full-range position of fixed liquidity: the real sqrt-price maths for exact-input and
/// exact-output swaps in both directions, the fee on the input, price limits (partial fills), the callback-then-check
/// payment flow (output first, then the callback, then "IIA" if not paid), and the slot0 `unlocked` flag.
contract MockV3Pool {
    uint256 constant Q96 = 1 << 96;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint128 public liquidity;
    uint160 public sqrtPriceX96;
    bool public unlocked = true;

    constructor(address t0, address t1, uint24 f, uint160 s, uint128 l) { token0 = t0; token1 = t1; fee = f; sqrtPriceX96 = s; liquidity = l; }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, unlocked);
    }

    /// moves the price as a big trade would (for manipulation tests), without tokens
    function setPrice(uint160 s) external { sqrtPriceX96 = s; }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(unlocked, "LOK");
        require(amountSpecified != 0, "AS");
        uint256 s = sqrtPriceX96;
        require(zeroForOne ? (limit < s && limit > 4295128739) : (limit > s && limit < type(uint160).max), "SPL");
        unlocked = false;
        (uint256 sNew, uint256 amtIn, uint256 amtOut) = _compute(s, zeroForOne, amountSpecified, limit);
        sqrtPriceX96 = uint160(sNew);
        address tIn = zeroForOne ? token0 : token1;
        if (amtOut != 0) IERC20(zeroForOne ? token1 : token0).transfer(recipient, amtOut);
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(amtOut)) : (-int256(amtOut), int256(amtIn));
        uint256 before = IERC20(tIn).balanceOf(address(this));
        IV3CallbackLike(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tIn).balanceOf(address(this)) >= before + amtIn, "IIA");
        unlocked = true;
    }

    function _compute(uint256 s, bool zeroForOne, int256 amountSpecified, uint256 limit)
        internal
        view
        returns (uint256 sNew, uint256 amtIn, uint256 amtOut)
    {
        uint256 lq = uint256(liquidity) * Q96;
        if (amountSpecified > 0) {
            uint256 full = (uint256(amountSpecified) * (1e6 - fee)) / 1e6;
            uint256 net = full;
            if (zeroForOne) {
                sNew = Math.mulDiv(lq, s, lq + net * s);
                if (sNew < limit) { sNew = limit; net = Math.mulDiv(lq, s - sNew, s) / sNew; }
                amtOut = Math.mulDiv(liquidity, s - sNew, Q96);
            } else {
                sNew = s + Math.mulDiv(net, Q96, liquidity);
                if (sNew > limit) { sNew = limit; net = Math.mulDiv(liquidity, sNew - s, Q96); }
                amtOut = Math.mulDiv(lq, sNew - s, sNew) / s;
            }
            amtIn = net == full ? uint256(amountSpecified) : Math.mulDiv(net, 1e6, 1e6 - fee) + 1;
        } else {
            amtOut = uint256(-amountSpecified);
            uint256 net;
            if (zeroForOne) {
                uint256 d = Math.mulDiv(amtOut, Q96, liquidity) + 1;
                sNew = d >= s ? limit : s - d;
                if (sNew < limit) { sNew = limit; amtOut = Math.mulDiv(liquidity, s - sNew, Q96); }
                net = Math.mulDiv(lq, s - sNew, s) / sNew + 1;
            } else {
                uint256 den = amtOut * s >= lq ? 0 : lq - amtOut * s;
                sNew = den == 0 ? limit : Math.mulDiv(lq, s, den) + 1;
                if (sNew > limit) { sNew = limit; amtOut = Math.mulDiv(lq, sNew - s, sNew) / s; }
                net = Math.mulDiv(liquidity, sNew - s, Q96) + 1;
            }
            amtIn = Math.mulDiv(net, 1e6, 1e6 - fee) + 1;
        }
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address a, address b, uint24 fee, uint160 sqrtP, uint128 liq) external returns (MockV3Pool p) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        p = new MockV3Pool(t0, t1, fee, sqrtP, liq);
        getPool[t0][t1][fee] = address(p);
        getPool[t1][t0][fee] = address(p);
    }
}

/// enough of a v4 PoolManager for venue checks (extsload at the real pools slot, exttload unlocked flag); no swaps
contract MockPoolManagerLite {
    bytes32 constant UNLOCKED = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    mapping(bytes32 => bytes32) public slots;
    bool public isUnlocked;
    function setPrice(bytes32 poolId, uint160 p) external { slots[keccak256(abi.encode(poolId, uint256(6)))] = bytes32(uint256(p)); }
    function setUnlocked(bool v) external { isUnlocked = v; }
    function extsload(bytes32 s) external view returns (bytes32) { return slots[s]; }
    function exttload(bytes32 s) external view returns (bytes32) { return s == UNLOCKED && isUnlocked ? bytes32(uint256(1)) : bytes32(0); }
    function unlock(bytes calldata) external pure returns (bytes memory) { revert("no swaps in this mock"); }
}

/// a holder that cannot take ETH
contract EthRefuser {
    function redeem(address vault, uint256 shares) external {
        (bool ok, bytes memory r) = vault.call(abi.encodeWithSignature("redeem(uint256,address)", shares, address(this)));
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
    function claim(address vault, address asset, address to) external {
        (bool ok, bytes memory r) = vault.call(abi.encodeWithSignature("claimOwed(address,address)", asset, to));
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
}

/// a holder whose ETH receive hook re-enters the vault, recording how it ended
contract EthReenterer {
    address public vault;
    bytes public payload;
    bool public tried;
    bool public innerOk;
    bytes public innerErr;
    function set(address v, bytes calldata p) external { vault = v; payload = p; tried = false; }
    function redeem(uint256 shares) external {
        (bool ok, bytes memory r) = vault.call(abi.encodeWithSignature("redeem(uint256,address)", shares, address(this)));
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
    receive() external payable {
        if (tried) return;
        tried = true;
        (innerOk, innerErr) = vault.call(payload);
    }
}
