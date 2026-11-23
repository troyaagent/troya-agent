// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroyaStake} from "../src/TroyaStake.sol";
import {TroyaFeeRouter} from "../src/TroyaFeeRouter.sol";

interface IPonsFactoryFork {
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}

interface IPonsHookFork {
    function feeSweepOperator() external view returns (address);
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

interface IEscrowFork {
    function credit(address recipient) external payable;
    function balanceOf(address recipient) external view returns (uint256);
}

/// Against Robinhood Chain (4663) with the real $TROYA, TroyaStake, Pons factory, hook, fee escrow and Uniswap v4 pool,
/// on a local in-memory fork: nothing is sent to the chain. Skipped, not failed, when the RPC cannot be reached.
contract TroyaFeeRouterForkTest is Test {
    address constant TROYA = 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074;
    address constant STAKE = 0x1C867c13BD950a90aB75158C1C45061837aa02d2;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant CREATOR = 0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4;
    address constant GAS_SPONSOR = 0x937533f8Eb47A10B529A42a7154B73CECa33390B;
    bytes32 constant POOL_ID = 0x050f1f047e1753d3058519c50e522b1f80c9e1eb208eb1f10867adab67bb38c1;

    TroyaStake stake = TroyaStake(STAKE);
    IERC20 troya = IERC20(TROYA);

    function _fork() internal returns (bool) {
        try vm.createSelectFork("robinhood") {}
        catch {
            vm.skip(true, "Robinhood Chain RPC not reachable: fork test skipped");
            return false;
        }
        assertEq(block.chainid, 4663, "not Robinhood Chain");
        return true;
    }

    function _cfg(uint128 mid, uint128 high) internal pure returns (TroyaFeeRouter.Config memory c) {
        c.team = CREATOR;
        c.gasWallet = GAS_SPONSOR;
        c.stakerBps = [uint16(10), 50, 100];
        c.burnBps = [uint16(0), 0, 10];
        c.gasBps = 10;
        c.stakeTargetBps = 500;
        c.maxBurnSlippageBps = 500;
        c.minInterval = 1 days;
        c.midMcWei = mid;
        c.highMcWei = high;
        c.minSendWei = 0.00002 ether;
        c.minBurnWei = 0.0005 ether;
    }

    function _deploy(TroyaFeeRouter.Config memory c) internal returns (TroyaFeeRouter r) {
        uint256 g = gasleft();
        r = new TroyaFeeRouter(CREATOR, TROYA, STAKE, ESCROW, POOL_MANAGER, FACTORY, HOOK, 0, 200, 260, c);
        console2.log("deploy gas (execution only)", g - gasleft());
        assertEq(r.poolId(), POOL_ID, "pool id derived from the Pons pool key");
    }

    function _pokeDay(TroyaFeeRouter r) internal {
        for (uint256 i; i < 24; ++i) {
            vm.warp(block.timestamp + 1 hours);
            r.poke();
        }
    }

    /// the real path: the router becomes the Pons creator-fee recipient, the Pons sweep operator sweeps the pool's
    /// pending fees, the escrow credits the router, and distribute() claims and splits them into the real TroyaStake
    function test_Fork_RecipientSweepDistribute() public {
        if (!_fork()) return;
        TroyaFeeRouter r = _deploy(_cfg(20 ether, 57.7 ether));

        vm.prank(CREATOR);
        IPonsFactoryFork(FACTORY).transferCreatorFeeRecipient(TROYA, address(r));
        // launches(poolId) returns 13 words; the 5th is the creator-fee recipient the hook credits
        (bool ok, bytes memory ret) = HOOK.staticcall(abi.encodeWithSignature("launches(bytes32)", POOL_ID));
        assertTrue(ok);
        address creator;
        assembly { creator := mload(add(ret, 160)) }
        assertEq(creator, address(r), "the hook now credits the router");

        // the sweep the Pons operator runs several times a day: the creator part lands in the escrow, in ETH, for the router
        vm.prank(IPonsHookFork(HOOK).feeSweepOperator());
        IPonsHookFork(HOOK).sweepPoolFees(POOL_ID, 1, 0);
        uint256 credited = IEscrowFork(ESCROW).balanceOf(address(r));
        console2.log("credited to the router by the real sweep (wei)", credited);
        assertGt(credited, 0);
        assertEq(troya.balanceOf(address(r)), 0, "no $TROYA paid to the recipient: Pons converts to ETH first");

        _pokeDay(r);
        (uint256 mc, uint256 n, uint8 tier) = r.marketCap();
        console2.log("market cap (wei of ETH)", mc, "reads", n);
        assertEq(n, 24);
        assertEq(tier, 0, "under $35k today");

        uint256 rewarded0 = stake.totalRewarded();
        uint256 gas0 = GAS_SPONSOR.balance;
        uint256 team0 = CREATOR.balance;
        uint256 g = gasleft();
        TroyaFeeRouter.Split memory s = r.distribute();
        console2.log("distribute gas (execution only)", g - gasleft());
        console2.log("staked", s.totalStaked / 1e18, "target", s.stakeTarget / 1e18);
        assertEq(s.amount, credited);
        assertEq(IEscrowFork(ESCROW).balanceOf(address(r)), 0, "claimed");
        uint256 due = (credited * 10) / 260;
        if (s.totalStaked < s.stakeTarget) due = (due * s.totalStaked) / s.stakeTarget;
        assertEq(s.toStakers, due >= 0.00002 ether ? due : 0);
        assertEq(stake.totalRewarded() - rewarded0, s.toStakers, "paid into the real TroyaStake");
        assertEq(GAS_SPONSOR.balance - gas0, s.toGas);
        assertEq(CREATOR.balance - team0, s.toTeam);
        assertEq(address(r).balance, 0);
    }

    /// the buy-and-burn against the real pool and hook, with thresholds low enough that today's market cap is the top tier
    function test_Fork_BuyAndBurnInRealPool() public {
        if (!_fork()) return;
        TroyaFeeRouter r = _deploy(_cfg(0.5 ether, 1 ether));
        _pokeDay(r);
        (,, uint8 tier) = r.marketCap();
        assertEq(tier, 2);

        address payer = makeAddr("fee-stand-in");
        vm.deal(payer, 0.26 ether);
        vm.prank(payer);
        IEscrowFork(ESCROW).credit{value: 0.26 ether}(address(r));

        uint256 supply0 = troya.totalSupply();
        uint256 rewarded0 = stake.totalRewarded();
        uint160 spot0 = r.spotSqrtPrice();
        TroyaFeeRouter.Split memory s = r.distribute();
        assertEq(s.toBurn, 0.01 ether);
        console2.log("burn ETH spent", r.totalBurnEthSpent(), "TROYA burned", r.totalTroyaBurned() / 1e18);
        assertEq(r.totalBurnEthSpent(), 0.01 ether, "the whole burn share bought");
        assertGt(r.totalTroyaBurned(), 0);
        assertEq(supply0 - troya.totalSupply(), r.totalTroyaBurned(), "burned for good");
        assertEq(troya.balanceOf(address(r)), 0);
        assertEq(r.burnReserve(), 0);
        assertLt(r.spotSqrtPrice(), spot0, "bought $TROYA: fewer per ETH now");
        assertEq(stake.totalRewarded() - rewarded0, s.toStakers);
        assertEq(address(r).balance, 0);
    }
}
