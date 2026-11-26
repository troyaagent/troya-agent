// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TroyaIndex} from "../src/TroyaIndex.sol";
import {TroyaIndexSwapper} from "../src/TroyaIndexSwapper.sol";
import {TroyaIndexZap} from "../src/TroyaIndexZap.sol";

interface IPonsFactoryView {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

/// Deploys TroyaIndexSwapper, TroyaIndex and TroyaIndexZap on Robinhood Chain (4663), for the owner to run himself from
/// his own wallet. Nothing here reads a private key: the signer comes from forge's own flags (--ledger, --trezor,
/// --account <keystore>, or --interactive).
///
///   forge script script/DeployTroyaIndex.s.sol --rpc-url robinhood --ledger --sender <your address>          # dry run
///   forge script script/DeployTroyaIndex.s.sol --rpc-url robinhood --ledger --sender <your address> --broadcast
///
/// Parameters (environment; defaults in brackets):
///   INDEX_OWNER            [the team's 2-of-2 Safe 0xbF41...7Fbb]
///   INDEX_KEEPER           (required) the rebalancing wallet; it can only make the vault swap with itself
///   INDEX_GUARDIAN         [0] a watchdog key that can only pause
///   INDEX_FEE_RECIPIENT    [TroyaFeeRouter 0x76d9...Ff3B]
///   INDEX_FEE_BPS          [50] deposit fee on the ETH part, at most 200 (2%)
///   INDEX_MGMT_FEE_BPS     [100] management fee per year, minted in TIDX, at most 200 (2% a year)
///   INDEX_MGMT_FEE_RECIPIENT [the creator wallet 0x57b0...D09E4] receives the management fee (TIDX)
///   INDEX_TOTAL_CAP        [2e18] total TIDX supply cap (1 TIDX = 1 ETH at the first deposit)
///   INDEX_WALLET_CAP       [5e17] TIDX one wallet may hold after a deposit
///   INDEX_MAX_MOVE_BPS     [2000] the most of an asset one rebalance may sell (hard max 5000)
///   INDEX_COOLDOWN         [14400] seconds between rebalances (1 hour to 7 days)
///   INDEX_ASSETS           [] comma-separated basket tokens besides ETH (at most 7)
///   INDEX_V3_POOLS         [] comma-separated Uniswap v3 pools (from the canonical factory) to list
///   INDEX_V3_SLIPPAGE_BPS  [100] one value for every v3 pool, or one per pool
///   INDEX_PONS_TOKENS      [] comma-separated graduated Pons coins paired with ETH; their Uniswap v4 pool key is read
///                          from the Pons factory (currency0 ETH, the coin, its pool fee and tick spacing, the Pons hook)
///   INDEX_PONS_SLIPPAGE_BPS [600] one value for every Pons pool (their hook takes 2.9% of every trade)
contract DeployTroyaIndex is Script {
    uint256 constant CHAIN_ID = 4663;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant SAFE = 0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb;
    address constant FEE_ROUTER = 0x76d97f6A3b97d856dBC7FaA6E59a892D87C3Ff3B;
    address constant CREATOR = 0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4;
    string constant BLOCKSCOUT_API = "https://robinhoodchain.blockscout.com/api/";

    function run() external {
        require(block.chainid == CHAIN_ID, "not Robinhood Chain (4663)");
        vm.startBroadcast();
        (TroyaIndexSwapper swapper, TroyaIndex vault, TroyaIndexZap zap) = deploy();
        vm.stopBroadcast();
        _report(swapper, vault, zap);
    }

    /// @dev The deployment itself, without broadcasting (the fork test runs it in-process).
    function deploy() public returns (TroyaIndexSwapper swapper, TroyaIndex vault, TroyaIndexZap zap) {
        TroyaIndex.Init memory p = params();
        swapper = new TroyaIndexSwapper(WETH, V3_FACTORY, POOL_MANAGER, PONS_HOOK);
        p.swapper = address(swapper);
        vault = new TroyaIndex(p);
        zap = new TroyaIndexZap(vault);
    }

    /// @notice The constructor parameters read from the environment (swapper left 0: filled in by deploy()).
    function params() public view returns (TroyaIndex.Init memory p) {
        p.owner = vm.envOr("INDEX_OWNER", SAFE);
        p.keeper = vm.envAddress("INDEX_KEEPER");
        p.guardian = vm.envOr("INDEX_GUARDIAN", address(0));
        p.feeRecipient = vm.envOr("INDEX_FEE_RECIPIENT", FEE_ROUTER);
        p.feeBps = uint16(vm.envOr("INDEX_FEE_BPS", uint256(50)));
        p.mgmtFeeRecipient = vm.envOr("INDEX_MGMT_FEE_RECIPIENT", CREATOR);
        p.mgmtFeeBps = uint16(vm.envOr("INDEX_MGMT_FEE_BPS", uint256(100)));
        p.totalCap = vm.envOr("INDEX_TOTAL_CAP", uint256(2 ether));
        p.walletCap = vm.envOr("INDEX_WALLET_CAP", uint256(0.5 ether));
        p.maxMoveBps = uint16(vm.envOr("INDEX_MAX_MOVE_BPS", uint256(2_000)));
        p.cooldown = uint32(vm.envOr("INDEX_COOLDOWN", uint256(4 hours)));
        p.assets = vm.envOr("INDEX_ASSETS", ",", new address[](0));

        address[] memory v3 = vm.envOr("INDEX_V3_POOLS", ",", new address[](0));
        uint256[] memory v3Slip = vm.envOr("INDEX_V3_SLIPPAGE_BPS", ",", _one(100));
        address[] memory pons = vm.envOr("INDEX_PONS_TOKENS", ",", new address[](0));
        uint16 ponsSlip = uint16(vm.envOr("INDEX_PONS_SLIPPAGE_BPS", uint256(600)));
        require(v3Slip.length == 1 || v3Slip.length == v3.length, "INDEX_V3_SLIPPAGE_BPS: one value or one per pool");

        p.venues = new TroyaIndex.VenueInput[](v3.length + pons.length);
        for (uint256 i; i < v3.length; ++i) {
            uint16 s = uint16(v3Slip.length == 1 ? v3Slip[0] : v3Slip[i]);
            p.venues[i] = TroyaIndex.VenueInput(1, v3[i], address(0), address(0), 0, 0, address(0), s);
        }
        for (uint256 i; i < pons.length; ++i) {
            IPonsFactoryView.LaunchedToken memory lt = IPonsFactoryView(PONS_FACTORY).getLaunchedToken(pons[i]);
            require(lt.exists, "not a Pons coin");
            require(lt.pairToken == address(0), "Pons coin not paired with native ETH");
            p.venues[v3.length + i] =
                TroyaIndex.VenueInput(2, address(0), address(0), pons[i], lt.poolFee, lt.tickSpacing, PONS_HOOK, ponsSlip);
        }
    }

    function _one(uint256 x) private pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function _report(TroyaIndexSwapper swapper, TroyaIndex vault, TroyaIndexZap zap) internal view {
        TroyaIndex.Init memory p = params();
        p.swapper = address(swapper);
        console2.log("TroyaIndexSwapper", address(swapper));
        console2.log("TroyaIndex       ", address(vault));
        console2.log("TroyaIndexZap    ", address(zap));
        console2.log("");
        console2.log("Read back and compare with what you meant to deploy:");
        console2.log("  owner()        ", vault.owner());
        console2.log("  keeper()       ", vault.keeper());
        console2.log("  guardian()     ", vault.guardian());
        console2.log("  feeRecipient() ", vault.feeRecipient());
        console2.log("  feeBps()       ", vault.feeBps());
        console2.log("  mgmtFeeBps()   ", vault.mgmtFeeBps());
        console2.log("  mgmtFeeRecipient()", vault.mgmtFeeRecipient());
        console2.log("  totalCap()     ", vault.totalCap());
        console2.log("  walletCap()    ", vault.walletCap());
        console2.log("  maxMoveBps()   ", vault.maxMoveBps());
        console2.log("  cooldown()     ", vault.cooldown());
        console2.log("  assets()       ", vault.assets().length, "(ETH first)");
        console2.log("  venueCount()   ", vault.venueCount());
        console2.log("");
        console2.log("Blockscout source verification (run each; compiler settings come from foundry.toml):");
        console2.log(
            string.concat(
                "  forge verify-contract --chain 4663 --verifier blockscout --verifier-url ",
                BLOCKSCOUT_API,
                " ",
                vm.toString(address(swapper)),
                " src/TroyaIndexSwapper.sol:TroyaIndexSwapper --constructor-args ",
                vm.toString(abi.encode(WETH, V3_FACTORY, POOL_MANAGER, PONS_HOOK))
            )
        );
        console2.log(
            string.concat(
                "  forge verify-contract --chain 4663 --verifier blockscout --verifier-url ",
                BLOCKSCOUT_API,
                " ",
                vm.toString(address(vault)),
                " src/TroyaIndex.sol:TroyaIndex --constructor-args ",
                vm.toString(abi.encode(p))
            )
        );
        console2.log(
            string.concat(
                "  forge verify-contract --chain 4663 --verifier blockscout --verifier-url ",
                BLOCKSCOUT_API,
                " ",
                vm.toString(address(zap)),
                " src/TroyaIndexZap.sol:TroyaIndexZap --constructor-args ",
                vm.toString(abi.encode(address(vault)))
            )
        );
    }
}
