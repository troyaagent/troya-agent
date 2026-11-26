// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TroyaIndexSwapper, Venue, IUniswapV3Pool} from "./TroyaIndexSwapper.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @title Troya Index (TIDX)
/// @notice An index vault on Robinhood Chain. People deposit ETH (or the basket itself); Troya's keeper keeps the vault
/// spread over a small basket of tokens by swapping between them; every share (TIDX) is a claim on the same fraction of
/// everything the vault holds.
///   - Withdraw: burn shares, get your fraction of every asset, in kind (ETH and each token). Always open: no pause, no
///     price, no keeper, no owner involved. A token that refuses to move is kept for you to claim later, the rest is sent.
///   - Deposit: while the vault holds only ETH, ETH in mints shares at the vault's ETH per share. Once it holds tokens,
///     a deposit brings the same fraction of every holding (TroyaIndexZap buys them for you with ETH). No price is used,
///     so no price can be manipulated to mint cheap shares.
///   - Rebalance: only the keeper, only between listed assets, only in listed Uniswap pools, output straight back into
///     the vault in the same call, at most `maxMoveBps` of the sold asset per call, at most once per `cooldown`, and never
///     under the pool's own 24-hour median price minus the venue's slippage.
///   - Owner (the team's Safe): pause new deposits / rebalances (instant), and everything else through a public 48-hour
///     timelock. No function exists that sends the vault's assets anywhere but to a withdrawing holder or into a swap.
/// @dev No upgrade, no delegatecall, no selfdestruct, no arbitrary call.
contract TroyaIndex is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Timelocked changes. Data encodings:
    ///   Keeper (address), Guardian (address), Fee (address recipient, uint16 bps), Caps (uint256 total, uint256 wallet),
    ///   RebalanceRules (uint16 maxMoveBps, uint32 cooldown), AddAsset (address), RetireAsset (address),
    ///   AddVenue (VenueInput), RemoveVenue (uint256 id).
    enum Op {
        Keeper,
        Guardian,
        Fee,
        Caps,
        RebalanceRules,
        AddAsset,
        RetireAsset,
        AddVenue,
        RemoveVenue
    }

    /// @notice A pool to list. kind 1: Uniswap v3, `pool` is the pool address (the rest is read from it). kind 2: Uniswap
    /// v4, the pool key (`currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`); `pool` must be 0.
    struct VenueInput {
        uint8 kind;
        address pool;
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint16 slippageBps;
    }

    struct AssetInfo {
        bool listed; // in the basket (deposits bring it, withdrawals pay it)
        bool buyable; // a rebalance may buy it; false once retired (it can then only be sold, then pruned)
    }

    struct Observation {
        uint160 sqrtPriceX96;
        uint64 hour; // block.timestamp / 1 hours
    }

    uint8 private constant KIND_V3 = 1;
    uint8 private constant KIND_V4 = 2;
    uint160 private constant MIN_SQRT_PRICE = 4295128739;

    /// @notice ETH, in the asset list.
    address public constant ETH = address(0);
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Every change but a pause waits this long, then can be executed by anyone within EXECUTION_WINDOW.
    uint256 public constant TIMELOCK = 48 hours;
    uint256 public constant EXECUTION_WINDOW = 7 days;
    /// @notice Hard limits no owner can cross.
    uint256 public constant MAX_ASSETS = 8; // ETH included
    uint256 public constant MAX_VENUES = 16;
    uint16 public constant MAX_FEE_BPS = 100; // 1% deposit fee, in ETH
    uint16 public constant MAX_MOVE_BPS = 5_000; // one rebalance sells at most half of an asset
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // never more than 10% under the median, pool fees included
    uint32 public constant MIN_COOLDOWN = 1 hours;
    uint32 public constant MAX_COOLDOWN = 7 days;
    /// @notice The first deposit mints 1 share per wei of ETH and locks DEAD_SHARES of them for good, so the share supply
    /// can never fall back to zero and a share can never be made so expensive that a deposit rounds to nothing.
    uint256 public constant MIN_FIRST_DEPOSIT = 0.001 ether;
    uint256 public constant DEAD_SHARES = 1e9;
    /// @notice A rebalance needs at least this many of the venue's last 24 hourly price reads.
    uint256 public constant OBSERVATIONS = 24;
    uint256 public constant MIN_OBSERVATIONS = 12;
    /// @notice Gas given to each asset transfer of a withdrawal; a token that fails within it is kept for the holder.
    uint256 public constant SEND_GAS = 300_000;

    /// @notice The stateless swap engine every rebalance trades through (it returns everything to the vault in the same call).
    TroyaIndexSwapper public immutable swapper;
    /// @notice Wrapped ETH (never a basket asset: WETH in a pool is ETH to the vault), the canonical Uniswap v3 factory,
    /// and the Pons hook (the only v4 hook a venue may have besides none), all taken from the swapper.
    address public immutable weth;
    address public immutable v3Factory;
    address public immutable ponsHook;

    address public keeper;
    /// @notice May pause (never unpause, never anything else). Meant for a watchdog key.
    address public guardian;
    address public feeRecipient;
    uint16 public feeBps;
    /// @notice Caps in shares (1 share = 1 wei of ETH at the first deposit): total supply, and the TIDX a wallet may hold
    /// after a deposit to it.
    uint256 public totalCap;
    uint256 public walletCap;
    uint16 public maxMoveBps;
    uint32 public cooldown;
    uint64 public lastRebalanceAt;
    bool public depositsPaused;
    bool public rebalancesPaused;

    /// @notice ETH deposit fees waiting for flushFees(); not part of the holdings.
    uint256 public feesAccrued;
    /// @notice What a withdrawal could not send (the asset refused), kept for the holder: owed[holder][asset].
    mapping(address account => mapping(address asset => uint256)) public owed;
    /// @notice The total of `owed` per asset; not part of the holdings.
    mapping(address asset => uint256) public totalOwed;

    address[] private _assets;
    mapping(address asset => AssetInfo) public assetInfo;
    Venue[] private _venues;
    /// @notice The active venue id + 1 of a pool (v3 pool address, or v4 pool id as bytes32), 0 if none.
    mapping(bytes32 poolRef => uint256) public venueOf;
    mapping(uint256 venueId => Observation[24]) private _obs;
    mapping(uint256 venueId => uint64) public lastObservedHour;

    /// @notice When a proposed change becomes executable, by id = keccak256(abi.encode(op, data)); 0 if none.
    mapping(bytes32 id => uint256) public etaOf;

    event Deposited(address indexed sender, address indexed receiver, uint256 shares, uint256[] amounts, uint256 fee);
    event Redeemed(address indexed holder, address indexed receiver, uint256 shares, uint256[] amounts);
    event Rebalanced(
        uint256 indexed venueId, address indexed assetIn, address indexed assetOut, uint256 spent, uint256 received, uint256 floor
    );
    event Observed(uint256 indexed venueId, uint64 indexed hour, uint160 sqrtPriceX96);
    event OwedRecorded(address indexed account, address indexed asset, uint256 amount);
    event OwedClaimed(address indexed account, address indexed asset, address to, uint256 amount);
    event FeesFlushed(address indexed recipient, uint256 amount);
    event Paused(bool deposits, bool rebalances, address by);
    event ChangeProposed(bytes32 indexed id, Op op, bytes data, uint256 eta);
    event ChangeExecuted(bytes32 indexed id, Op op, bytes data);
    event ChangeCancelled(bytes32 indexed id);
    event KeeperSet(address keeper);
    event GuardianSet(address guardian);
    event FeeSet(address recipient, uint16 bps);
    event CapsSet(uint256 totalCap, uint256 walletCap);
    event RebalanceRulesSet(uint16 maxMoveBps, uint32 cooldown);
    event AssetAdded(address indexed asset);
    event AssetRetired(address indexed asset);
    event AssetPruned(address indexed asset);
    event VenueAdded(uint256 indexed venueId, bytes32 indexed poolRef, address asset0, address asset1, uint16 slippageBps);
    event VenueRemoved(uint256 indexed venueId);

    error ZeroAddress();
    error ZeroAmount();
    error BadAsset();
    error BadVenue();
    error OutOfBounds();
    error TooMany();
    error DepositsPaused();
    error RebalancesPaused();
    error NotKeeper();
    error NotGuardian();
    error FirstDepositTooSmall();
    error NoSharesYet();
    error NotEthOnly();
    error NothingBacking();
    error SharesBelowMinimum(uint256 shares, uint256 minimum);
    error AboveMax(address asset, uint256 needed, uint256 max);
    error NotEnoughEth(uint256 needed, uint256 sent);
    error ReceivedLess(address asset, uint256 needed, uint256 received);
    error TotalCapExceeded();
    error WalletCapExceeded();
    error WrongLength();
    error CooldownActive(uint256 nextAt);
    error MoveTooLarge(uint256 amount, uint256 max);
    error NotEnoughObservations(uint256 n);
    error SpotUnreadable();
    error OutputTooLow(uint256 received, uint256 floor);
    error SpentTooMuch();
    error AlreadyPending();
    error NothingPending();
    error TimelockNotElapsed(uint256 eta);
    error TimelockExpired(uint256 expiredAt);
    error NothingOwed();
    error TransferFailed();
    error CannotRenounce();
    error StillHeld();

    struct Init {
        address owner; // the team's Safe
        address swapper; // TroyaIndexSwapper
        address keeper;
        address guardian;
        address feeRecipient;
        uint16 feeBps;
        uint256 totalCap;
        uint256 walletCap;
        uint16 maxMoveBps;
        uint32 cooldown;
        address[] assets; // the basket tokens besides ETH
        VenueInput[] venues;
    }

    /// @notice Deploys the vault with its first basket and pools (nobody has deposited yet, so no timelock is needed for
    /// them; every later change waits 48 hours).
    constructor(Init memory p)
        ERC20("Troya Index", "TIDX")
        Ownable(p.owner)
    {
        if (p.swapper == address(0)) revert ZeroAddress();
        swapper = TroyaIndexSwapper(payable(p.swapper));
        weth = address(swapper.weth());
        v3Factory = address(swapper.v3Factory());
        ponsHook = swapper.ponsHook();
        _assets.push(ETH);
        assetInfo[ETH] = AssetInfo(true, true);
        _setKeeper(p.keeper);
        _setGuardian(p.guardian);
        _setFee(p.feeRecipient, p.feeBps);
        _setCaps(p.totalCap, p.walletCap);
        _setRebalanceRules(p.maxMoveBps, p.cooldown);
        for (uint256 i; i < p.assets.length; ++i) _addAsset(p.assets[i]);
        for (uint256 i; i < p.venues.length; ++i) _addVenue(p.venues[i]);
    }

    /// @notice ETH from the swapper; anyone else's ETH is a donation to every holder.
    receive() external payable {}

    /* ------------------------------------------------------------------ */
    /* deposit                                                             */
    /* ------------------------------------------------------------------ */

    /// @notice Deposit ETH while the vault holds no token (the first deposit, and the ETH-only phase): shares =
    /// (ETH after the fee) x supply / ETH held. The first deposit mints 1 share per wei and locks DEAD_SHARES of them.
    /// @param minShares Reverts if fewer shares would be minted (protects against a donation front-run).
    function depositEth(uint256 minShares, address receiver) external payable nonReentrant returns (uint256 shares) {
        if (depositsPaused) revert DepositsPaused();
        if (receiver == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee;
        (shares, fee) = _ethShares(msg.value, msg.value);
        if (shares < minShares) revert SharesBelowMinimum(shares, minShares);
        if (totalSupply() == 0) _mint(DEAD, DEAD_SHARES);
        _checkCaps(receiver, shares);
        feesAccrued += fee;
        _mint(receiver, shares);
        uint256[] memory amounts = new uint256[](_assets.length);
        amounts[0] = msg.value - fee;
        emit Deposited(msg.sender, receiver, shares, amounts, fee);
    }

    /// @notice Deposit in kind: mint exactly `shares` by bringing the same fraction (shares / supply) of every holding,
    /// rounded up: ETH from msg.value (plus the fee on that ETH; the rest is refunded) and each token pulled from the
    /// caller (approve it first). No price is involved. TroyaIndexZap does this from ETH alone.
    /// @param maxAmounts One per asset, in the order of assets(): the most of each the caller will bring (index 0, ETH, is
    /// bounded by msg.value and ignored).
    function deposit(uint256 shares, address receiver, uint256[] calldata maxAmounts)
        external
        payable
        nonReentrant
        returns (uint256[] memory amounts, uint256 fee)
    {
        if (depositsPaused) revert DepositsPaused();
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        address[] memory list = _assets;
        if (maxAmounts.length != list.length) revert WrongLength();
        (amounts, fee) = _required(shares, msg.value);
        if (amounts[0] + fee > msg.value) revert NotEnoughEth(amounts[0] + fee, msg.value);
        _checkCaps(receiver, shares);
        // bring the tokens first (measured by what really arrived), then mint, then refund the spare ETH
        for (uint256 i = 1; i < list.length; ++i) {
            uint256 need = amounts[i];
            if (need == 0) continue;
            if (need > maxAmounts[i]) revert AboveMax(list[i], need, maxAmounts[i]);
            IERC20 t = IERC20(list[i]);
            uint256 before = t.balanceOf(address(this));
            t.safeTransferFrom(msg.sender, address(this), need);
            uint256 got = t.balanceOf(address(this)) - before;
            if (got < need) revert ReceivedLess(list[i], need, got);
        }
        feesAccrued += fee;
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, shares, amounts, fee);
        uint256 spare = msg.value - amounts[0] - fee;
        if (spare != 0) {
            (bool ok,) = msg.sender.call{value: spare}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice What deposit(shares) needs now, per asset in the order of assets() (ETH first), and the ETH fee on top.
    function previewDeposit(uint256 shares) external view returns (uint256[] memory amounts, uint256 fee) {
        return _required(shares, 0);
    }

    /// @notice What depositEth(value) would mint now, and its fee. Reverts like depositEth when it is not open
    /// (NotEthOnly: the vault holds a token; use deposit / the zap).
    function previewDepositEth(uint256 value) external view returns (uint256 shares, uint256 fee) {
        return _ethShares(value, 0);
    }

    /* ------------------------------------------------------------------ */
    /* withdraw (always open)                                              */
    /* ------------------------------------------------------------------ */

    /// @notice Burn `shares` of your TIDX and receive shares / supply of every asset the vault holds, in kind, rounded
    /// down. Never paused, never priced. An asset that cannot be sent (a token that reverts, ETH refused by `receiver`)
    /// does not stop the others: it is recorded in owed[receiver][asset], claimable with claimOwed().
    function redeem(uint256 shares, address receiver) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        amounts = previewRedeem(shares);
        _burn(msg.sender, shares);
        emit Redeemed(msg.sender, receiver, shares, amounts);
        address[] memory list = _assets;
        for (uint256 i; i < list.length; ++i) {
            uint256 a = amounts[i];
            if (a == 0) continue;
            if (!_trySend(list[i], receiver, a)) {
                owed[receiver][list[i]] += a;
                totalOwed[list[i]] += a;
                emit OwedRecorded(receiver, list[i], a);
            }
        }
    }

    /// @notice What redeem(shares) pays now, per asset in the order of assets().
    function previewRedeem(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 supply = totalSupply();
        uint256 n = _assets.length;
        amounts = new uint256[](n);
        if (supply == 0) return amounts;
        for (uint256 i; i < n; ++i) amounts[i] = Math.mulDiv(_holdings(_assets[i]), shares, supply);
    }

    /// @notice Takes out what a withdrawal kept for you in `asset` (listed or not), to `to`. Reverts if it still fails,
    /// so you can try again later; nothing is lost.
    function claimOwed(address asset, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 a = owed[msg.sender][asset];
        if (a == 0) revert NothingOwed();
        owed[msg.sender][asset] = 0;
        totalOwed[asset] -= a;
        emit OwedClaimed(msg.sender, asset, to, a);
        if (asset == ETH) {
            (bool ok,) = to.call{value: a}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, a);
        }
    }

    /* ------------------------------------------------------------------ */
    /* rebalance (keeper)                                                  */
    /* ------------------------------------------------------------------ */

    /// @notice The keeper's only power: sell `amountIn` of one side of venue `venueId` for the other side, in that pool,
    /// with the output paid to this vault in the same call. Bounds, all checked here:
    ///   - both sides listed, the bought side not retired;
    ///   - amountIn <= maxMoveBps of the sold asset's holdings (a retired asset may be sold in full);
    ///   - at most once per `cooldown`;
    ///   - received >= minOut and >= the value of what was spent at the venue's 24-hour median price minus its
    ///     slippageBps, and the pool is never pushed past that band (price limit).
    /// @param zeroForOne true: sell the venue's asset0 for asset1.
    function rebalance(uint256 venueId, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 spent, uint256 received)
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (rebalancesPaused) revert RebalancesPaused();
        uint256 next = uint256(lastRebalanceAt) + cooldown;
        if (lastRebalanceAt != 0 && block.timestamp < next) revert CooldownActive(next);
        Venue memory v = _checkMove(venueId, zeroForOne, amountIn);
        _observe(venueId, v);
        (uint160 median, uint256 n) = medianSqrtPrice(venueId);
        if (n < MIN_OBSERVATIONS) revert NotEnoughObservations(n);
        if (swapper.spot(v) == 0) revert SpotUnreadable();

        lastRebalanceAt = uint64(block.timestamp);
        (spent, received) = _trade(v, zeroForOne, amountIn, _priceLimit(median, zeroForOne, v.slippageBps));
        uint256 floor = (_valueAt(median, zeroForOne, spent) * (10_000 - v.slippageBps)) / 10_000;
        if (floor < minOut) floor = minOut;
        if (received < floor || received == 0) revert OutputTooLow(received, floor);
        emit Rebalanced(venueId, zeroForOne ? v.asset0 : v.asset1, zeroForOne ? v.asset1 : v.asset0, spent, received, floor);
    }

    /// @dev Sells exactly amountIn (or less at the limit) and measures, by the vault's own balances, what left and what
    /// arrived.
    function _trade(Venue memory v, bool zeroForOne, uint256 amountIn, uint160 limit)
        private
        returns (uint256 spent, uint256 received)
    {
        (address assetIn, address assetOut) = zeroForOne ? (v.asset0, v.asset1) : (v.asset1, v.asset0);
        uint256 inBefore = _balance(assetIn);
        uint256 outBefore = _balance(assetOut);
        // hand exactly amountIn to the swapper; it must send the output (and any unspent input) back in this same call
        uint256 value;
        if (assetIn == ETH) value = amountIn;
        else IERC20(assetIn).safeTransfer(address(swapper), amountIn);
        swapper.swap{value: value}(v, zeroForOne, true, amountIn, amountIn, limit);
        uint256 inAfter = _balance(assetIn);
        uint256 outAfter = _balance(assetOut);
        spent = inBefore > inAfter ? inBefore - inAfter : 0;
        received = outAfter > outBefore ? outAfter - outBefore : 0;
        if (spent > amountIn) revert SpentTooMuch();
    }

    /// @dev The venue is active, both sides listed, the bought side not retired, and amountIn within the move cap.
    function _checkMove(uint256 venueId, bool zeroForOne, uint256 amountIn) private view returns (Venue memory v) {
        v = _activeVenue(venueId);
        (address assetIn, address assetOut) = zeroForOne ? (v.asset0, v.asset1) : (v.asset1, v.asset0);
        AssetInfo memory infoIn = assetInfo[assetIn];
        if (!infoIn.listed || !assetInfo[assetOut].buyable) revert BadAsset();
        if (amountIn == 0) revert ZeroAmount();
        uint256 held = _holdings(assetIn);
        uint256 maxIn = infoIn.buyable ? (held * maxMoveBps) / 10_000 : held;
        if (amountIn > maxIn) revert MoveTooLarge(amountIn, maxIn);
    }

    /// @notice Records this hour's price of venue `venueId`, if it has none yet. Anyone may call it (Troya does, hourly).
    function poke(uint256 venueId) external nonReentrant returns (bool) {
        return _observe(venueId, _activeVenue(venueId));
    }

    /// @notice poke() for every active venue.
    function pokeAll() external nonReentrant {
        for (uint256 i; i < _venues.length; ++i) {
            if (_venues[i].active) _observe(i, _venueAt(i));
        }
    }

    /// @notice Sends the accrued ETH deposit fees to the fee recipient. Anyone may call it.
    function flushFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccrued;
        if (amount == 0) revert ZeroAmount();
        feesAccrued = 0;
        address to = feeRecipient;
        emit FeesFlushed(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Drops a retired asset the vault no longer holds from the list. Anyone may call it.
    function prune(address asset) external nonReentrant {
        AssetInfo memory info = assetInfo[asset];
        if (asset == ETH || !info.listed || info.buyable) revert BadAsset();
        if (_holdings(asset) != 0) revert StillHeld();
        delete assetInfo[asset];
        // keep the order of the others (deposit's maxAmounts follow it)
        uint256 n = _assets.length;
        uint256 i = 1;
        while (_assets[i] != asset) ++i;
        for (; i + 1 < n; ++i) _assets[i] = _assets[i + 1];
        _assets.pop();
        emit AssetPruned(asset);
    }

    /* ------------------------------------------------------------------ */
    /* owner: pause (instant) and the 48-hour timelock                     */
    /* ------------------------------------------------------------------ */

    /// @notice Pauses or resumes new deposits and rebalances. Withdrawals cannot be paused.
    function setPaused(bool deposits, bool rebalances) external onlyOwner {
        depositsPaused = deposits;
        rebalancesPaused = rebalances;
        emit Paused(deposits, rebalances, msg.sender);
    }

    /// @notice The guardian (or owner) stops new deposits and rebalances at once. Only the owner can resume.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        depositsPaused = true;
        rebalancesPaused = true;
        emit Paused(true, true, msg.sender);
    }

    /// @notice Proposes a change; anyone can execute it from 48 hours later, for 7 days. The owner can cancel it.
    function propose(Op op, bytes calldata data) external onlyOwner returns (bytes32 id) {
        _change(op, data, false);
        id = keccak256(abi.encode(op, data));
        if (etaOf[id] != 0) revert AlreadyPending();
        uint256 eta = block.timestamp + TIMELOCK;
        etaOf[id] = eta;
        emit ChangeProposed(id, op, data, eta);
    }

    /// @notice Executes a proposed change once its 48 hours have passed (re-checked against the limits now).
    function execute(Op op, bytes calldata data) external nonReentrant {
        bytes32 id = keccak256(abi.encode(op, data));
        uint256 eta = etaOf[id];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        if (block.timestamp > eta + EXECUTION_WINDOW) revert TimelockExpired(eta + EXECUTION_WINDOW);
        delete etaOf[id];
        _change(op, data, true);
        emit ChangeExecuted(id, op, data);
    }

    function cancel(bytes32 id) external onlyOwner {
        if (etaOf[id] == 0) revert NothingPending();
        delete etaOf[id];
        emit ChangeCancelled(id);
    }

    /// @notice Ownership cannot be renounced (nobody could pause or rotate a lost keeper). Withdrawals never need it.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }

    /* ------------------------------------------------------------------ */
    /* views                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice The basket, ETH (address 0) first.
    function assets() external view returns (address[] memory) {
        return _assets;
    }

    /// @notice What the vault holds of `asset` for its holders (balance minus owed claims and, for ETH, accrued fees).
    function holdings(address asset) external view returns (uint256) {
        return _holdings(asset);
    }

    function venueCount() external view returns (uint256) {
        return _venues.length;
    }

    function getVenue(uint256 venueId) external view returns (Venue memory) {
        return _venueAt(venueId);
    }

    function spotSqrtPrice(uint256 venueId) external view returns (uint160) {
        return swapper.spot(_venueAt(venueId));
    }

    function observation(uint256 venueId, uint256 slot) external view returns (uint160 sqrtPriceX96, uint64 hour) {
        Observation memory o = _obs[venueId][slot];
        return (o.sqrtPriceX96, o.hour);
    }

    /// @notice The median sqrtPriceX96 of venue `venueId`'s hourly reads of the last 24 hours, and how many there are.
    /// (For an even count, the mean of the middle two.)
    function medianSqrtPrice(uint256 venueId) public view returns (uint160 median, uint256 n) {
        uint256 nowHour = block.timestamp / 1 hours;
        uint256[] memory x = new uint256[](OBSERVATIONS);
        for (uint256 i; i < OBSERVATIONS; ++i) {
            Observation memory o = _obs[venueId][i];
            if (o.hour != 0 && uint256(o.hour) + OBSERVATIONS > nowHour) x[n++] = o.sqrtPriceX96;
        }
        if (n == 0) return (0, 0);
        for (uint256 i = 1; i < n; ++i) {
            uint256 y = x[i];
            uint256 j = i;
            while (j > 0 && x[j - 1] > y) {
                x[j] = x[j - 1];
                --j;
            }
            x[j] = y;
        }
        median = uint160(n % 2 == 1 ? x[n / 2] : (x[n / 2 - 1] + x[n / 2]) / 2);
    }

    /// @notice The earliest time the next rebalance may run.
    function nextRebalanceAt() external view returns (uint256) {
        return lastRebalanceAt == 0 ? block.timestamp : uint256(lastRebalanceAt) + cooldown;
    }

    /* ------------------------------------------------------------------ */
    /* internals                                                           */
    /* ------------------------------------------------------------------ */

    /// @dev Raw balance of the vault in `asset`, ETH included as ETH.
    function _balance(address asset) private view returns (uint256) {
        return asset == ETH ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /// @dev What belongs to the holders: the balance minus owed claims (and accrued fees for ETH), never below 0.
    function _holdings(address asset) private view returns (uint256) {
        uint256 b = _balance(asset);
        uint256 reserved = totalOwed[asset] + (asset == ETH ? feesAccrued : 0);
        return b > reserved ? b - reserved : 0;
    }

    /// @dev depositEth's price: (value - fee) x supply / ETH held, only while no token is held; the first deposit gets
    /// 1 share per wei minus DEAD_SHARES. `incoming` ETH (msg.value) is not yet a holding.
    function _ethShares(uint256 value, uint256 incoming) private view returns (uint256 shares, uint256 fee) {
        fee = (value * feeBps) / 10_000;
        uint256 net = value - fee;
        uint256 supply = totalSupply();
        if (supply == 0) {
            if (net < MIN_FIRST_DEPOSIT) revert FirstDepositTooSmall();
            return (net - DEAD_SHARES, fee);
        }
        for (uint256 i = 1; i < _assets.length; ++i) {
            if (_holdings(_assets[i]) != 0) revert NotEthOnly();
        }
        uint256 ethHeld = _holdings(ETH);
        ethHeld = ethHeld > incoming ? ethHeld - incoming : 0;
        if (ethHeld == 0) revert NothingBacking();
        shares = Math.mulDiv(net, supply, ethHeld);
        if (shares == 0) revert SharesBelowMinimum(0, 1);
    }

    /// @dev Per asset: ceil(holding x shares / supply); `incoming` ETH (msg.value) is not yet a holding. Fee: feeBps of
    /// the ETH part.
    function _required(uint256 shares, uint256 incoming) private view returns (uint256[] memory amounts, uint256 fee) {
        uint256 supply = totalSupply();
        if (supply == 0) revert NoSharesYet();
        uint256 n = _assets.length;
        amounts = new uint256[](n);
        bool backed;
        for (uint256 i; i < n; ++i) {
            uint256 h = _holdings(_assets[i]);
            if (i == 0) h = h > incoming ? h - incoming : 0;
            if (h == 0) continue;
            backed = true;
            amounts[i] = Math.mulDiv(h, shares, supply, Math.Rounding.Ceil);
        }
        if (!backed) revert NothingBacking();
        fee = (amounts[0] * feeBps) / 10_000;
    }

    function _checkCaps(address receiver, uint256 shares) private view {
        if (totalSupply() + shares > totalCap) revert TotalCapExceeded();
        if (balanceOf(receiver) + shares > walletCap) revert WalletCapExceeded();
    }

    /// @dev Sends `amount` of `asset` with at most SEND_GAS, copying at most 32 bytes of return data; false on any failure.
    function _trySend(address asset, address to, uint256 amount) private returns (bool ok) {
        uint256 g = SEND_GAS;
        if (asset == ETH) {
            assembly {
                ok := call(g, to, amount, 0, 0, 0, 0)
            }
            return ok;
        }
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        assembly {
            let success := call(g, asset, 0, add(data, 0x20), mload(data), 0, 0x20)
            switch returndatasize()
            case 0 { ok := and(success, gt(extcodesize(asset), 0)) }
            default { ok := and(success, and(gt(returndatasize(), 31), eq(mload(0), 1))) }
        }
    }

    function _observe(uint256 venueId, Venue memory v) private returns (bool) {
        uint256 hour = block.timestamp / 1 hours;
        if (hour == lastObservedHour[venueId]) return false;
        uint160 p = swapper.spot(v);
        if (p == 0) return false;
        _obs[venueId][hour % OBSERVATIONS] = Observation(p, uint64(hour));
        lastObservedHour[venueId] = uint64(hour);
        emit Observed(venueId, uint64(hour), p);
        return true;
    }

    /// @dev How much of the other side `amount` is worth at sqrt price `s` (token1 per token0, Q64.96).
    function _valueAt(uint160 s, bool zeroForOne, uint256 amount) private pure returns (uint256) {
        return zeroForOne
            ? Math.mulDiv(Math.mulDiv(amount, s, 1 << 96), s, 1 << 96)
            : Math.mulDiv(Math.mulDiv(amount, 1 << 96, s), 1 << 96, s);
    }

    /// @dev The swap's price limit: the median moved against the vault by the slippage (in price, so sqrt in sqrt price).
    function _priceLimit(uint160 median, bool zeroForOne, uint16 slippageBps) private pure returns (uint160) {
        uint256 k = Math.sqrt((uint256(10_000 - slippageBps) * 1e36) / 10_000); // sqrt(1 - slippage), 1e18 scale
        uint256 limit = zeroForOne ? (uint256(median) * k) / 1e18 : (uint256(median) * 1e18) / k;
        if (limit <= MIN_SQRT_PRICE || limit > type(uint160).max) revert OutOfBounds();
        return uint160(limit);
    }

    /* ---------- the timelocked changes ---------- */

    /// @dev Checks a change against the limits; with `apply_`, also makes it. propose() runs it without, execute() with.
    function _change(Op op, bytes calldata data, bool apply_) private {
        if (op == Op.Keeper) {
            address k = abi.decode(data, (address));
            if (apply_) _setKeeper(k);
        } else if (op == Op.Guardian) {
            address g = abi.decode(data, (address));
            if (apply_) _setGuardian(g);
        } else if (op == Op.Fee) {
            (address r, uint16 bps) = abi.decode(data, (address, uint16));
            _checkFee(r, bps);
            if (apply_) _setFee(r, bps);
        } else if (op == Op.Caps) {
            (uint256 t, uint256 w) = abi.decode(data, (uint256, uint256));
            _checkCapsArgs(t, w);
            if (apply_) _setCaps(t, w);
        } else if (op == Op.RebalanceRules) {
            (uint16 m, uint32 c) = abi.decode(data, (uint16, uint32));
            _checkRules(m, c);
            if (apply_) _setRebalanceRules(m, c);
        } else if (op == Op.AddAsset) {
            address a = abi.decode(data, (address));
            _checkNewAsset(a);
            if (apply_) _addAsset(a);
        } else if (op == Op.RetireAsset) {
            address a = abi.decode(data, (address));
            if (a == ETH || !assetInfo[a].buyable) revert BadAsset();
            if (apply_) {
                assetInfo[a].buyable = false;
                emit AssetRetired(a);
            }
        } else if (op == Op.AddVenue) {
            VenueInput memory p = abi.decode(data, (VenueInput));
            // at propose time the sides may be assets an earlier proposal is still adding; execute checks they are listed
            if (apply_) _addVenue(p);
            else _buildVenue(p, false);
        } else {
            uint256 id = abi.decode(data, (uint256));
            Venue memory v = _activeVenue(id);
            if (apply_) {
                _venues[id].active = false;
                delete venueOf[_poolRef(v)];
                emit VenueRemoved(id);
            }
        }
    }

    function _setKeeper(address k) private {
        keeper = k; // 0 switches rebalancing off
        emit KeeperSet(k);
    }

    function _setGuardian(address g) private {
        guardian = g;
        emit GuardianSet(g);
    }

    function _checkFee(address r, uint16 bps) private view {
        if (r == address(0)) revert ZeroAddress();
        if (r == address(this) || bps > MAX_FEE_BPS) revert OutOfBounds();
    }

    function _setFee(address r, uint16 bps) private {
        _checkFee(r, bps);
        feeRecipient = r;
        feeBps = bps;
        emit FeeSet(r, bps);
    }

    function _checkCapsArgs(uint256 t, uint256 w) private pure {
        if (t == 0 || w == 0 || w > t) revert OutOfBounds();
    }

    function _setCaps(uint256 t, uint256 w) private {
        _checkCapsArgs(t, w);
        totalCap = t;
        walletCap = w;
        emit CapsSet(t, w);
    }

    function _checkRules(uint16 m, uint32 c) private pure {
        if (m == 0 || m > MAX_MOVE_BPS || c < MIN_COOLDOWN || c > MAX_COOLDOWN) revert OutOfBounds();
    }

    function _setRebalanceRules(uint16 m, uint32 c) private {
        _checkRules(m, c);
        maxMoveBps = m;
        cooldown = c;
        emit RebalanceRulesSet(m, c);
    }

    function _checkNewAsset(address a) private view {
        if (a == ETH || a == weth || a == address(this) || a.code.length == 0) revert BadAsset();
        AssetInfo memory info = assetInfo[a];
        if (info.buyable) revert BadAsset(); // already active (a retired one may be re-activated)
        if (!info.listed && _assets.length >= MAX_ASSETS) revert TooMany();
        // must look like an ERC-20
        IERC20(a).balanceOf(address(this));
        IERC20(a).totalSupply();
    }

    function _addAsset(address a) private {
        _checkNewAsset(a);
        if (!assetInfo[a].listed) _assets.push(a);
        assetInfo[a] = AssetInfo(true, true);
        emit AssetAdded(a);
    }

    /// @dev Checks a pool and turns it into a venue: v3 pools must come from the canonical factory; v4 pools from the
    /// canonical PoolManager, initialized, with no hook or the Pons hook. Both sides must be listed assets and different.
    function _buildVenue(VenueInput memory p, bool requireListed) private view returns (Venue memory v) {
        if (p.slippageBps == 0 || p.slippageBps > MAX_SLIPPAGE_BPS) revert OutOfBounds();
        if (_venues.length >= MAX_VENUES) revert TooMany();
        v.kind = p.kind;
        v.active = true;
        v.slippageBps = p.slippageBps;
        if (p.kind == KIND_V3) {
            if (p.pool == address(0) || p.pool.code.length == 0) revert BadVenue();
            v.pool = p.pool;
            v.token0 = IUniswapV3Pool(p.pool).token0();
            v.token1 = IUniswapV3Pool(p.pool).token1();
            v.fee = IUniswapV3Pool(p.pool).fee();
            if (IUniswapV3FactoryLike(v3Factory).getPool(v.token0, v.token1, v.fee) != p.pool) revert BadVenue();
        } else if (p.kind == KIND_V4) {
            if (p.pool != address(0) || p.currency0 >= p.currency1) revert BadVenue();
            if (p.hooks != address(0) && p.hooks != ponsHook) revert BadVenue();
            v.token0 = p.currency0;
            v.token1 = p.currency1;
            v.fee = p.fee;
            v.tickSpacing = p.tickSpacing;
            v.hooks = p.hooks;
            if (swapper.spot(v) == 0) revert BadVenue(); // not initialized (or the PoolManager is mid-unlock)
        } else {
            revert BadVenue();
        }
        v.asset0 = v.token0 == weth ? ETH : v.token0;
        v.asset1 = v.token1 == weth ? ETH : v.token1;
        if (v.asset0 == v.asset1) revert BadVenue();
        if (requireListed && (!assetInfo[v.asset0].listed || !assetInfo[v.asset1].listed)) revert BadVenue();
        if (venueOf[_poolRef(v)] != 0) revert BadVenue();
    }

    function _addVenue(VenueInput memory p) private {
        Venue memory v = _buildVenue(p, true);
        _venues.push(v);
        uint256 id = _venues.length - 1;
        venueOf[_poolRef(v)] = id + 1;
        emit VenueAdded(id, _poolRef(v), v.asset0, v.asset1, v.slippageBps);
    }

    function _venueAt(uint256 id) private view returns (Venue memory) {
        return _venues[id];
    }

    function _activeVenue(uint256 id) private view returns (Venue memory v) {
        if (id >= _venues.length) revert BadVenue();
        v = _venueAt(id);
        if (!v.active) revert BadVenue();
    }

    function _poolRef(Venue memory v) private pure returns (bytes32) {
        return v.kind == KIND_V3
            ? bytes32(uint256(uint160(v.pool)))
            : keccak256(abi.encode(v.token0, v.token1, v.fee, v.tickSpacing, v.hooks)); // = the v4 PoolId
    }
}
