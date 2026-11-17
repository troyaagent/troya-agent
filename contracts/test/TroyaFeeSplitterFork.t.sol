// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaFeeSplitter, TroyaFeeSplitterFactory} from "../src/TroyaFeeSplitter.sol";

struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }
struct TokenParams {
    string name; string symbol; string logo; string description; Socials socials;
    address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt;
}
struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }
struct Launched {
    address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold;
    uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists;
}

interface IPonsFactory {
    function launchFee() external view returns (uint256);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function snipeTaxSeconds() external view returns (uint256);
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken, address[] calldata exempt)
        external payable returns (address token, address curve);
    function getLaunchedToken(address token) external view returns (Launched memory);
}

interface ICurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
}

interface IEscrow {
    function credit(address recipient) external payable;
    function balanceOf(address recipient) external view returns (uint256);
}

/// Real Pons v2 on a Robinhood Chain (4663) fork: a coin launched with a Troya splitter as its creator-fee recipient, traded,
/// then its fees collected and split. Skipped, not failed, when the RPC cannot be reached.
contract TroyaFeeSplitterForkTest is Test {
    IPonsFactory constant PONS = IPonsFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;

    TroyaFeeSplitterFactory factory;
    address treasury = makeAddr("troya-treasury");
    address creator = makeAddr("coin-creator");
    address trader = makeAddr("trader");

    function _fork() internal returns (bool) {
        try vm.createSelectFork("robinhood") {}
        catch {
            vm.skip(true, "Robinhood Chain RPC not reachable: fork test skipped");
            return false;
        }
        assertEq(block.chainid, 4663, "not Robinhood Chain");
        factory = new TroyaFeeSplitterFactory(ESCROW, treasury, address(this));
        return true;
    }

    function _config() internal view returns (uint256 id) {
        uint256 n = PONS.launchConfigCount();
        for (uint256 i; i < n; ++i) if (PONS.getLaunchConfig(i).enabled) return i;
        revert("no open Pons launch config");
    }

    function _launch(address recipient, uint16 taxBps) internal returns (address token, address curve) {
        uint256 cfg = _config();
        TokenParams memory p = TokenParams({
            name: "Troya Split Test", symbol: "TSPLIT", logo: "", description: "fork test",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: recipient, creatorTaxBps: taxBps, buybackEnabled: false,
            expectedEconomics: PONS.previewLaunchEconomics(cfg, address(0)), salt: keccak256(abi.encode(recipient, taxBps))
        });
        address[] memory exempt = new address[](1);
        exempt[0] = creator;
        uint256 fee = PONS.launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator);
        (token, curve) = PONS.launchToken{value: fee}(p, cfg, address(0), exempt);
        assertEq(PONS.getLaunchedToken(token).creatorFeeRecipient, recipient, "Pons stored the splitter as fee recipient");
        // past the launch snipe tax
        vm.warp(block.timestamp + PONS.snipeTaxSeconds() + 600);
        vm.roll(block.number + 10_000);
    }

    /// buys `ethIn`, sells everything back; returns the volume in ETH (in + out)
    function _trade(address token, address curve, uint256 ethIn) internal returns (uint256 volume) {
        vm.deal(trader, ethIn);
        vm.startPrank(trader);
        uint256 got = ICurve(curve).buy{value: ethIn}(ethIn, 0, trader);
        IERC20(token).approve(curve, got);
        uint256 before = trader.balance;
        ICurve(curve).sell(got, 0, trader);
        vm.stopPrank();
        volume = ethIn + (trader.balance - before);
    }

    function _lists(address curve, address token) internal pure returns (address[] memory curves, address[] memory toks) {
        curves = new address[](1);
        curves[0] = curve;
        toks = new address[](1);
        toks[0] = token;
    }

    function _check(uint16 taxBps, uint16 troyaBps) internal {
        bytes32 salt = keccak256(abi.encode("coin", taxBps));
        address splitter = factory.predict(creator, troyaBps, salt);
        assertEq(splitter.code.length, 0, "no code until there is something to collect");
        (address token, address curve) = _launch(splitter, taxBps);
        uint256 volume = _trade(token, curve, 2 ether) + _trade(token, curve, 1 ether);
        console2.log("volume wei", volume);
        console2.log("curve fee balance", ICurve(curve).quoteFeeBalance(), "tax balance", ICurve(curve).creatorTaxBalance());
        uint256 c0 = creator.balance;
        (address[] memory curves, address[] memory toks) = _lists(curve, token);
        factory.deployAndCollect(creator, troyaBps, salt, curves, toks);
        _assertSplit(volume, creator.balance - c0, taxBps, troyaBps);
        assertEq(splitter.balance, 0);
        assertEq(IEscrow(ESCROW).balanceOf(splitter), 0);
        _later(splitter, curves, toks, troyaBps);
    }

    function _assertSplit(uint256 volume, uint256 toCreator, uint16 taxBps, uint16 troyaBps) internal view {
        uint256 toTroya = treasury.balance;
        uint256 income = toTroya + toCreator;
        console2.log("creator income wei", income, "troya", toTroya);
        assertGt(toTroya, 0, "Troya got its share");
        assertEq(toTroya, income * troyaBps / 10_000, "exact split");
        // creator income per unit of volume: 70% of the 1% fee plus the creator tax
        assertApproxEqRel(income * 10_000 / volume, 70 + uint256(taxBps), 0.08e18, "creator income ~ (0.7% + tax) of volume");
        // Troya's share: 0.1% of volume
        assertApproxEqRel(toTroya * 1_000_000 / volume, 1_000, 0.08e18, "Troya ~ 0.1% of volume");
    }

    /// later fees (after graduation Pons credits them straight into the escrow) are split the same way
    function _later(address splitter, address[] memory curves, address[] memory toks, uint16 troyaBps) internal {
        uint256 t0 = treasury.balance;
        address payer = makeAddr("pons-hook-stand-in");
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        IEscrow(ESCROW).credit{value: 1 ether}(splitter);
        TroyaFeeSplitter(payable(splitter)).collect(curves, toks);
        assertEq(treasury.balance - t0, 1 ether * uint256(troyaBps) / 10_000);
    }

    function test_Fork_NoTax() public {
        if (!_fork()) return;
        _check(0, 1428); // 10 / 70
    }

    function test_Fork_TwoPercentTax() public {
        if (!_fork()) return;
        _check(200, 370); // 10 / 270
    }
}
