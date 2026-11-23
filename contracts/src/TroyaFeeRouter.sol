// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface ITroyaToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 value) external;
}

interface ITroyaStake {
    function token() external view returns (address);
    function totalStaked() external view returns (uint256);
    function notifyReward() external payable;
}

interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256);
}

interface IPonsFactory {
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}

/// @dev Uniswap v4 types, ABI-identical to v4-core (Currency and IHooks are addresses there).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
    function exttload(bytes32 slot) external view returns (bytes32);
}

/// @title Troya fee router
/// @notice The Pons creator-fee recipient of $TROYA. Every creator fee $TROYA earns (2.6% of its trading volume, paid by
/// Pons in ETH) lands here, and the split of it is done by this code, not by a server:
///   - stakers: 0.1% of volume while the market cap is under the middle threshold, 0.5% from it, 1% from the top threshold
///     (10, 50 and 100 of every 260 wei received), sent to TroyaStake.notifyReward() and shared by every staked coin;
///   - free gas: 0.1% of volume (10 of 260) to the gas sponsor wallet;
///   - burn: from the top threshold another 0.1% (10 of 260) buys $TROYA in its own pool and burns it;
///   - team: everything else.
/// The stakers' share is paid in full once 5% of the supply is staked; with less staked only staked / target of it is
/// paid. What cannot be paid (nobody staked, an amount under the minimum) goes to the team; nothing is carried over,
/// except the burn share, which waits here until it can be bought and burned (it never goes to anyone).
/// @dev Anyone can run distribute(), once per period (default: once per UTC day). The market-cap tier comes from the
/// pool's own price, read straight from the Uniswap v4 PoolManager once an hour by anyone (poke()), and the median of the
/// last 24 hourly reads is used, so one pumped or dumped hour cannot move the tier. No oracle, no server.
/// Every change to the rule (shares, thresholds, payees, minimums, period) is proposed on chain and can be executed only
/// after 7 days, so everybody sees it coming. There is no pause, no upgrade, no arbitrary call, and no way to take the ETH
/// that is due to the stakers. The only call to Pons is moving the fee recipient, and it sits behind the same 7 days.
contract TroyaFeeRouter is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice The rule. Shares are in basis points of $TROYA trading volume, out of `creatorBps` (260): a share of
    /// x bps of volume is x / 260 of every wei received. Index 0, 1, 2 of the tier arrays: under `midMcWei`, from
    /// `midMcWei`, from `highMcWei`.
    struct Config {
        address team;               // receives everything that is not another share
        address gasWallet;          // the free-gas sponsor wallet
        uint16[3] stakerBps;        // stakers' share per tier, bps of volume (10, 50, 100)
        uint16[3] burnBps;          // buy-and-burn share per tier, bps of volume (0, 0, 10)
        uint16 gasBps;              // free-gas share, bps of volume (10)
        uint16 stakeTargetBps;      // the stake (bps of total supply) that earns the full stakers' share (500 = 5%)
        uint16 maxBurnSlippageBps;  // how far the buy-back may pay above the median and the current price
        uint32 minInterval;         // distribute() runs at most once per this many seconds, aligned to it (86400: UTC days)
        uint128 midMcWei;           // market cap, in wei of ETH, where the middle tier starts
        uint128 highMcWei;          // market cap, in wei of ETH, where the top tier starts
        uint128 minSendWei;         // a staker or gas share under this goes to the team instead
        uint128 minBurnWei;         // the burn share waits here until it reaches this
    }

    /// @notice What one distribution does (also what preview() would do now).
    struct Split {
        uint8 tier;
        uint256 mcWei;
        uint256 observations;
        uint256 amount;
        uint256 toStakers;
        uint256 toGas;
        uint256 toBurn;
        uint256 toTeam;
        uint256 totalStaked;
        uint256 stakeTarget;
    }

    struct Observation {
        uint160 sqrtPriceX96;
        uint64 hour; // block.timestamp / 1 hours
    }

    /// @notice Every change waits this long between being proposed and being executable.
    uint256 public constant TIMELOCK = 7 days;
    /// @notice A matured proposal must be executed within this window, or it lapses.
    uint256 public constant EXECUTION_WINDOW = 7 days;
    /// @notice The market cap is the median of the hourly reads of the last 24 hours...
    uint256 public constant OBSERVATIONS = 24;
    /// @notice ...and needs at least 12 of them; with fewer, the lowest tier applies.
    uint256 public constant MIN_OBSERVATIONS = 12;
    /// @notice Hard limits no proposal can cross: the stakers never get less than 0.1% of volume in any tier,
    /// free gas never more than 0.5%, the full-share target is at most 10% of supply.
    uint16 public constant MIN_STAKER_BPS = 10;
    uint16 public constant MAX_GAS_BPS = 50;
    uint16 public constant MAX_STAKE_TARGET_BPS = 1_000;
    uint16 public constant MIN_BURN_SLIPPAGE_BPS = 10;
    uint16 public constant MAX_BURN_SLIPPAGE_BPS = 2_000;
    uint128 public constant MAX_MIN_SEND_WEI = 0.001 ether;
    uint128 public constant MAX_MIN_BURN_WEI = 0.01 ether;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev v4-core Lock.IS_UNLOCKED_SLOT (transient) and the PoolManager's `_pools` mapping slot (StateLibrary.POOLS_SLOT)
    bytes32 private constant IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    uint256 private constant POOLS_SLOT = 6;
    uint160 private constant MIN_SQRT_PRICE = 4295128739;

    /// @notice $TROYA.
    ITroyaToken public immutable troya;
    /// @notice The TroyaStake contract the stakers' share is sent to.
    ITroyaStake public immutable stake;
    /// @notice The Pons v2 fee escrow that holds the creator fees until this contract claims them.
    IPonsFeeEscrow public immutable escrow;
    /// @notice The Uniswap v4 PoolManager that holds the ETH/$TROYA pool.
    IPoolManager public immutable poolManager;
    /// @notice The Pons v2 launch factory (only used to move the fee recipient, behind the timelock).
    IPonsFactory public immutable ponsFactory;
    /// @notice The Pons hook of the ETH/$TROYA pool, part of its pool key.
    address public immutable hook;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    /// @notice The ETH/$TROYA pool id (currency0 ETH, currency1 $TROYA).
    bytes32 public immutable poolId;
    /// @notice The creator side's cut of volume in bps (70 of the 1% Pons fee + the 1.9% creator tax = 260). Fixed:
    /// Pons snapshots both for the pool at graduation.
    uint16 public immutable creatorBps;

    Config private _config;
    Config private _pendingConfig;
    /// @notice When the pending config becomes executable; 0 when none is pending.
    uint64 public pendingConfigEta;
    /// @notice The proposed new Pons fee recipient; address(0) when none is pending.
    address public pendingRecipient;
    /// @notice When the pending recipient move becomes executable.
    uint64 public pendingRecipientEta;

    Observation[24] private _observations;
    /// @notice The last hour (block.timestamp / 1 hours) a price was recorded.
    uint64 public lastObservedHour;
    /// @notice When distribute() last ran.
    uint64 public lastDistribution;

    /// @notice ETH set aside for the buy-back; it waits here until it is bought and burned.
    uint256 public burnReserve;
    /// @notice ETH a payee could not receive (it refused the transfer), kept for it here.
    mapping(address account => uint256) public owed;
    /// @notice The total of `owed`, never counted again in a split.
    uint256 public totalOwed;

    /// @notice Lifetime totals, for /stake and /proof.
    uint256 public distributions;
    uint256 public totalDistributed;
    uint256 public totalToStakers;
    uint256 public totalToGas;
    uint256 public totalToTeam;
    uint256 public totalToBurn;
    uint256 public totalBurnEthSpent;
    uint256 public totalTroyaBurned;

    event Distributed(
        uint256 indexed number,
        uint8 tier,
        uint256 mcWei,
        uint256 amount,
        uint256 toStakers,
        uint256 toGas,
        uint256 toBurn,
        uint256 toTeam,
        uint256 totalStaked,
        uint256 stakeTarget
    );
    event Observed(uint64 indexed hour, uint160 sqrtPriceX96);
    event BoughtAndBurned(uint256 ethSpent, uint256 troyaBurned, uint160 spotSqrtPriceX96, uint160 medianSqrtPriceX96);
    event BurnSkipped(uint256 reserve, uint160 spotSqrtPriceX96, uint160 medianSqrtPriceX96);
    event Owed(address indexed account, uint256 amount);
    event OwedWithdrawn(address indexed account, address to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event ConfigProposed(Config config, uint256 eta);
    event ConfigExecuted(Config config);
    event ConfigCancelled(Config config);
    event RecipientMoveProposed(address indexed newRecipient, uint256 eta);
    event RecipientMoveExecuted(address indexed newRecipient);
    event RecipientMoveCancelled(address indexed newRecipient);

    error ZeroAddress();
    error WrongStakeToken();
    error PoolNotInitialized();
    error BadCreatorBps();
    error BadPayee();
    error ShareOutOfBounds();
    error TargetOutOfBounds();
    error SlippageOutOfBounds();
    error IntervalOutOfBounds();
    error ThresholdsOutOfOrder();
    error MinimumTooHigh();
    error TooSoon(uint256 nextAt);
    error NothingToDistribute();
    error PoolManagerUnlocked();
    error NotPoolManager();
    error NothingPending();
    error TimelockNotElapsed(uint256 eta);
    error TimelockExpired(uint256 expiredAt);
    error NothingOwed();
    error TransferFailed();
    error CannotRenounce();

    /// @param owner_ The team wallet: it can propose (7 days ahead) and cancel changes, nothing else.
    /// @param troya_ $TROYA. @param stake_ TroyaStake. @param escrow_ PonsV2FeeEscrow. @param poolManager_ Uniswap v4 PoolManager.
    /// @param ponsFactory_ PonsV2LaunchFactory. @param hook_ The Pons hook. @param poolFee_ @param tickSpacing_ The pool key's.
    /// @param creatorBps_ The creator side's cut of volume, bps (260). @param initial The starting rule.
    constructor(
        address owner_,
        address troya_,
        address stake_,
        address escrow_,
        address poolManager_,
        address ponsFactory_,
        address hook_,
        uint24 poolFee_,
        int24 tickSpacing_,
        uint16 creatorBps_,
        Config memory initial
    ) Ownable(owner_) {
        if (
            troya_ == address(0) || stake_ == address(0) || escrow_ == address(0) || poolManager_ == address(0)
                || ponsFactory_ == address(0) || hook_ == address(0)
        ) revert ZeroAddress();
        if (ITroyaStake(stake_).token() != troya_) revert WrongStakeToken();
        if (creatorBps_ == 0 || creatorBps_ > 2_000) revert BadCreatorBps();
        troya = ITroyaToken(troya_);
        stake = ITroyaStake(stake_);
        escrow = IPonsFeeEscrow(escrow_);
        poolManager = IPoolManager(poolManager_);
        ponsFactory = IPonsFactory(ponsFactory_);
        hook = hook_;
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        creatorBps = creatorBps_;
        poolId = keccak256(abi.encode(address(0), troya_, poolFee_, tickSpacing_, hook_));
        if (_spotSqrtPrice() == 0) revert PoolNotInitialized();
        _check(initial);
        _config = initial;
        emit ConfigExecuted(initial);
    }

    /// @notice Pons pays out by sending ETH from the escrow when this contract claims; anyone may also add ETH, which is
    /// then split like a fee.
    receive() external payable {}

    /* ------------------------------------------------------------------ */
    /* the split                                                           */
    /* ------------------------------------------------------------------ */

    /// @notice Claims this contract's creator fees from the Pons escrow and splits everything it holds by the rule.
    /// Anyone may call it, once per period (with the default 1 day: once per UTC day). The stakers' share always goes
    /// to TroyaStake in the same transaction; if that fails, the whole call fails, so it can never be skipped.
    function distribute() external nonReentrant returns (Split memory s) {
        if (_isUnlocked()) revert PoolManagerUnlocked();
        Config memory c = _config;
        uint256 period = c.minInterval;
        if (lastDistribution != 0 && block.timestamp / period <= uint256(lastDistribution) / period) {
            revert TooSoon((uint256(lastDistribution) / period + 1) * period);
        }
        _observe();
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        uint256 amount = _free();
        if (amount == 0) revert NothingToDistribute();
        s = _split(amount, c);

        lastDistribution = uint64(block.timestamp);
        uint256 number = ++distributions;
        totalDistributed += amount;
        totalToStakers += s.toStakers;
        totalToGas += s.toGas;
        totalToTeam += s.toTeam;
        totalToBurn += s.toBurn;
        burnReserve += s.toBurn;
        emit Distributed(number, s.tier, s.mcWei, amount, s.toStakers, s.toGas, s.toBurn, s.toTeam, s.totalStaked, s.stakeTarget);

        if (s.toStakers != 0) stake.notifyReward{value: s.toStakers}();
        _pay(c.gasWallet, s.toGas);
        _pay(c.team, s.toTeam);
        _buyAndBurn(c);
    }

    /// @notice Spends the burn reserve on $TROYA in its own pool and burns what it bought, if the price is within
    /// `maxBurnSlippageBps` of both the 24-hour median and the current price. Anyone may call it; distribute() does too.
    /// @return spent ETH spent. @return burned $TROYA burned.
    function buyAndBurn() external nonReentrant returns (uint256 spent, uint256 burned) {
        if (_isUnlocked()) revert PoolManagerUnlocked();
        _observe();
        return _buyAndBurn(_config);
    }

    /// @notice Records this hour's pool price, if this hour has none yet. Anyone may call it (Troya does, every hour);
    /// the market-cap tier is the median of these reads.
    /// @return recorded Whether a price was recorded.
    function poke() external nonReentrant returns (bool recorded) {
        if (_isUnlocked()) revert PoolManagerUnlocked();
        return _observe();
    }

    /// @notice Sends ETH kept for `msg.sender` (a payee that refused a transfer) to `to`.
    function withdrawOwed(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        emit OwedWithdrawn(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Sends a token that ended up here (anything but ETH, which is all the split is made of) to the team.
    /// Anyone may call it. This contract never holds $TROYA between transactions: what it buys it burns at once.
    function rescueToken(address token) external nonReentrant {
        address team = _config.team;
        uint256 amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(team, amount);
        emit Rescued(token, team, amount);
    }

    /// @dev Called by the PoolManager inside unlock() during a buy-back: swaps `ethIn` ETH for $TROYA down to the price
    /// limit, pays the ETH, takes the $TROYA. Only the PoolManager can call it, and it only calls back whoever unlocked,
    /// which is this contract itself.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 ethIn, uint160 limit) = abi.decode(data, (uint256, uint160));
        int256 delta = poolManager.swap(_key(), SwapParams(true, -ethIn.toInt256(), limit), "");
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        uint256 spent = a0 < 0 ? uint256(uint128(-a0)) : 0;
        uint256 bought = a1 > 0 ? uint256(uint128(a1)) : 0;
        if (spent != 0) poolManager.settle{value: spent}();
        if (bought != 0) poolManager.take(address(troya), address(this), bought);
        return abi.encode(spent, bought);
    }

    /* ------------------------------------------------------------------ */
    /* the 7-day timelock                                                  */
    /* ------------------------------------------------------------------ */

    /// @notice Proposes a new rule. It can be executed by anyone 7 days from now (for 7 days), and cancelled by the
    /// owner until then. A new proposal replaces the pending one and restarts the clock.
    function proposeConfig(Config calldata next) external onlyOwner {
        _check(next);
        if (pendingConfigEta != 0) emit ConfigCancelled(_pendingConfig);
        _pendingConfig = next;
        uint256 eta = block.timestamp + TIMELOCK;
        pendingConfigEta = uint64(eta);
        emit ConfigProposed(next, eta);
    }

    /// @notice Makes the pending rule the rule, once its 7 days have passed. Anyone may call it.
    function executeConfig() external nonReentrant {
        uint256 eta = pendingConfigEta;
        _matured(eta);
        Config memory next = _pendingConfig;
        _config = next;
        delete _pendingConfig;
        pendingConfigEta = 0;
        emit ConfigExecuted(next);
    }

    /// @notice Drops the pending rule.
    function cancelConfig() external onlyOwner {
        if (pendingConfigEta == 0) revert NothingPending();
        emit ConfigCancelled(_pendingConfig);
        delete _pendingConfig;
        pendingConfigEta = 0;
    }

    /// @notice Proposes handing the $TROYA creator fees to `newRecipient` at Pons (the way back, or to a successor).
    /// Executable by anyone 7 days from now, for 7 days. ETH already here, or already credited to this contract in the
    /// escrow, is still split by this contract afterwards.
    function proposeRecipientMove(address newRecipient) external onlyOwner {
        if (newRecipient == address(0) || newRecipient == address(this)) revert BadPayee();
        if (pendingRecipient != address(0)) emit RecipientMoveCancelled(pendingRecipient);
        pendingRecipient = newRecipient;
        uint256 eta = block.timestamp + TIMELOCK;
        pendingRecipientEta = uint64(eta);
        emit RecipientMoveProposed(newRecipient, eta);
    }

    /// @notice Moves the $TROYA creator fees at Pons to the proposed recipient, once its 7 days have passed.
    function executeRecipientMove() external nonReentrant {
        address to = pendingRecipient;
        if (to == address(0)) revert NothingPending();
        _matured(pendingRecipientEta);
        pendingRecipient = address(0);
        pendingRecipientEta = 0;
        emit RecipientMoveExecuted(to);
        ponsFactory.transferCreatorFeeRecipient(address(troya), to);
    }

    /// @notice Drops the pending recipient move.
    function cancelRecipientMove() external onlyOwner {
        address to = pendingRecipient;
        if (to == address(0)) revert NothingPending();
        pendingRecipient = address(0);
        pendingRecipientEta = 0;
        emit RecipientMoveCancelled(to);
    }

    /// @notice Ownership cannot be renounced: the thresholds are in ETH and must follow ETH's price through the
    /// timelock, and the way back (proposeRecipientMove) needs an owner. Every owner power is a public 7-day proposal.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }

    /* ------------------------------------------------------------------ */
    /* views                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice The rule in force.
    function config() external view returns (Config memory) {
        return _config;
    }

    /// @notice The proposed rule and when it becomes executable (eta 0: none).
    function pendingConfig() external view returns (Config memory next, uint256 eta) {
        return (_pendingConfig, pendingConfigEta);
    }

    /// @notice What distribute() would do if called now (including what is waiting in the escrow).
    function preview() external view returns (Split memory) {
        uint256 amount = _free() + escrow.balanceOf(address(this));
        return _split(amount, _config);
    }

    /// @notice The earliest time distribute() can run again.
    function nextDistributionAt() external view returns (uint256) {
        if (lastDistribution == 0) return block.timestamp;
        uint256 period = _config.minInterval;
        return (uint256(lastDistribution) / period + 1) * period;
    }

    /// @notice The market cap used for the tier: (median price of the last 24 hourly reads) x (total supply minus
    /// 0x...dEaD), in wei of ETH, the number of reads it is the median of, and the tier (0 with fewer than 12 reads).
    function marketCap() public view returns (uint256 mcWei, uint256 n, uint8 tier) {
        uint160 m;
        (m, n) = medianSqrtPrice();
        if (m == 0) return (0, n, 0);
        uint256 supply = troya.totalSupply() - troya.balanceOf(DEAD);
        // price = (sqrtP / 2^96)^2 $TROYA per ETH; market cap in ETH = supply / price
        mcWei = Math.mulDiv(Math.mulDiv(supply, 1 << 96, m), 1 << 96, m);
        tier = mcWei >= _config.highMcWei ? 2 : mcWei >= _config.midMcWei ? 1 : 0;
    }

    /// @notice The median sqrtPriceX96 of the hourly reads of the last 24 hours and how many there are; 0 with fewer
    /// than 12. (For an even count it is the mean of the middle two square-root prices.)
    function medianSqrtPrice() public view returns (uint160 median, uint256 n) {
        uint256 nowHour = block.timestamp / 1 hours;
        uint256[] memory v = new uint256[](OBSERVATIONS);
        for (uint256 i; i < OBSERVATIONS; ++i) {
            Observation memory o = _observations[i];
            if (o.hour != 0 && uint256(o.hour) + OBSERVATIONS > nowHour) v[n++] = o.sqrtPriceX96;
        }
        if (n < MIN_OBSERVATIONS) return (0, n);
        for (uint256 i = 1; i < n; ++i) {
            uint256 x = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > x) {
                v[j] = v[j - 1];
                --j;
            }
            v[j] = x;
        }
        median = uint160(n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2);
    }

    /// @notice One of the 24 hourly reads (slot = hour % 24).
    function observation(uint256 slot) external view returns (uint160 sqrtPriceX96, uint64 hour) {
        Observation memory o = _observations[slot];
        return (o.sqrtPriceX96, o.hour);
    }

    /// @notice The pool's current sqrtPriceX96 (sqrt of $TROYA per ETH, Q64.96), straight from the PoolManager.
    function spotSqrtPrice() external view returns (uint160) {
        return _spotSqrtPrice();
    }

    /* ------------------------------------------------------------------ */
    /* internals                                                           */
    /* ------------------------------------------------------------------ */

    /// @dev ETH free to split: the balance minus the burn reserve and what is owed to payees.
    function _free() private view returns (uint256) {
        return address(this).balance - burnReserve - totalOwed;
    }

    function _split(uint256 amount, Config memory c) private view returns (Split memory s) {
        (s.mcWei, s.observations, s.tier) = marketCap();
        s.amount = amount;
        s.totalStaked = stake.totalStaked();
        s.stakeTarget = (troya.totalSupply() * c.stakeTargetBps) / 10_000;
        // stakers: their tier's share, scaled by staked / target below the target; under the minimum or nobody staked: team
        uint256 due = s.totalStaked < s.stakeTarget
            ? Math.mulDiv(amount * c.stakerBps[s.tier], s.totalStaked, uint256(creatorBps) * s.stakeTarget)
            : (amount * c.stakerBps[s.tier]) / creatorBps;
        if (due != 0 && due >= c.minSendWei) s.toStakers = due;
        // free gas: its share; under the minimum: team
        uint256 gas = (amount * c.gasBps) / creatorBps;
        if (gas != 0 && gas >= c.minSendWei) s.toGas = gas;
        // burn: its tier's share, set aside until it is bought and burned
        s.toBurn = (amount * c.burnBps[s.tier]) / creatorBps;
        // team: the rest, rounding dust included
        s.toTeam = amount - s.toStakers - s.toGas - s.toBurn;
    }

    function _buyAndBurn(Config memory c) private returns (uint256 spent, uint256 burned) {
        uint256 ethIn = burnReserve;
        if (ethIn == 0 || ethIn < c.minBurnWei) return (0, 0);
        (uint160 ref,) = medianSqrtPrice();
        uint160 spot = _spotSqrtPrice();
        // buying $TROYA lowers sqrtP ($TROYA per ETH); stop at (1 - slippage) of the higher of the median and the spot price,
        // so the buy never pays more than `maxBurnSlippageBps` above either of them
        uint256 k = Math.sqrt((uint256(10_000 - c.maxBurnSlippageBps) * 1e36) / 10_000); // sqrt(1 - slippage), 1e18 scale
        uint256 limit = (uint256(ref > spot ? ref : spot) * k) / 1e18;
        if (ref == 0 || spot <= limit || limit <= MIN_SQRT_PRICE) {
            emit BurnSkipped(ethIn, spot, ref);
            return (0, 0);
        }
        try poolManager.unlock(abi.encode(ethIn, uint160(limit))) returns (bytes memory r) {
            (spent, burned) = abi.decode(r, (uint256, uint256));
        } catch {
            emit BurnSkipped(ethIn, spot, ref);
            return (0, 0);
        }
        burnReserve = ethIn - spent;
        totalBurnEthSpent += spent;
        totalTroyaBurned += burned;
        if (burned != 0) troya.burn(burned);
        emit BoughtAndBurned(spent, burned, spot, ref);
    }

    function _observe() private returns (bool) {
        uint256 hour = block.timestamp / 1 hours;
        if (hour == lastObservedHour) return false;
        uint160 p = _spotSqrtPrice();
        if (p == 0) return false;
        _observations[hour % OBSERVATIONS] = Observation(p, uint64(hour));
        lastObservedHour = uint64(hour);
        emit Observed(uint64(hour), p);
        return true;
    }

    /// @dev Pays `amount` ETH to `to`; if `to` refuses it, keeps it for `to` (see withdrawOwed) so the split goes on.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            totalOwed += amount;
            emit Owed(to, amount);
        }
    }

    function _matured(uint256 eta) private view {
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        if (block.timestamp > eta + EXECUTION_WINDOW) revert TimelockExpired(eta + EXECUTION_WINDOW);
    }

    function _check(Config memory c) private view {
        if (c.team == address(0) || c.gasWallet == address(0)) revert ZeroAddress();
        if (c.team == address(this) || c.gasWallet == address(this)) revert BadPayee();
        for (uint256 i; i < 3; ++i) {
            if (c.stakerBps[i] < MIN_STAKER_BPS) revert ShareOutOfBounds();
            // a higher market cap never means a smaller stakers' share
            if (i > 0 && c.stakerBps[i] < c.stakerBps[i - 1]) revert ShareOutOfBounds();
            if (uint256(c.stakerBps[i]) + c.burnBps[i] + c.gasBps > creatorBps) revert ShareOutOfBounds();
        }
        if (c.gasBps > MAX_GAS_BPS) revert ShareOutOfBounds();
        if (c.stakeTargetBps == 0 || c.stakeTargetBps > MAX_STAKE_TARGET_BPS) revert TargetOutOfBounds();
        if (c.maxBurnSlippageBps < MIN_BURN_SLIPPAGE_BPS || c.maxBurnSlippageBps > MAX_BURN_SLIPPAGE_BPS) revert SlippageOutOfBounds();
        if (c.minInterval < 1 hours || c.minInterval > 7 days) revert IntervalOutOfBounds();
        if (c.midMcWei == 0 || c.highMcWei < c.midMcWei) revert ThresholdsOutOfOrder();
        if (c.minSendWei > MAX_MIN_SEND_WEI || c.minBurnWei > MAX_MIN_BURN_WEI) revert MinimumTooHigh();
    }

    function _key() private view returns (PoolKey memory) {
        return PoolKey(address(0), address(troya), poolFee, tickSpacing, hook);
    }

    function _spotSqrtPrice() private view returns (uint160) {
        bytes32 slot = keccak256(abi.encode(poolId, POOLS_SLOT));
        return uint160(uint256(poolManager.extsload(slot)));
    }

    /// @dev True while some caller holds the PoolManager unlocked (a price read then could be mid-manipulation).
    function _isUnlocked() private view returns (bool) {
        return poolManager.exttload(IS_UNLOCKED_SLOT) != bytes32(0);
    }
}
