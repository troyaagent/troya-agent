// TroyaIndex: the approved deployment, shared by the owner's deploy page (#/vault/deploy) and the fork test
// (tools/index-fork-test.mjs), so the test signs exactly the calldata the page will ask the wallet to sign.
// The bytecode comes from /agent/desk/troya-index.json, built from contracts/out by tools/build-index-artifacts.mjs.
// Parameters approved by the owner on 26 Nov 2026 (docs/troya-index-plan.md section 13): total cap 2 TIDX, wallet cap 0.5
// TIDX, deposit fee 0.5% (max 2%) in ETH to TroyaFeeRouter, management fee 1% a year (max 2%) minted in TIDX to the creator
// wallet, move cap 20%, cooldown 4 h, slippage 100/200/600 bps, no guardian, a new dedicated keeper wallet, basket
// ETH + USDG + SPY + NVDA + a small $TROYA weight.
import { AbiCoder, Interface, getAddress } from "ethers";

export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const BLOCKSCOUT_API = "https://robinhoodchain.blockscout.com/api/";
export const CREATOR = getAddress("0x57b09fe6dab0a7d3776e56e6388c773d6c4d09e4");    // deploys, then hands ownership over
export const SAFE = getAddress("0xbf418c9e3a56acae5bf5aea7905ea127763d7fbb");       // team 2-of-2 Safe, owns TroyaFeeRouter
export const FEE_ROUTER = getAddress("0x76d97f6a3b97d856dbc7faa6e59a892d87c3ff3b");
export const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
export const V3_FACTORY = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
export const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
export const PONS_HOOK = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");

export const TOKENS = {
  USDG: getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
  SPY: getAddress("0x117cc2133c37b721f49de2a7a74833232b3b4c0c"),
  NVDA: getAddress("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"),
  TROYA: getAddress("0x1fa81ddaaac83240803b3f2d20595e40edc1a074"),
};

// the basket besides ETH (assets() order: ETH, USDG, SPY, NVDA, TROYA) and its pools. Depth read on chain 26 Nov 2026:
// WETH/USDG 0.01% ~4,777 WETH; SPY/WETH 0.05% ~299 WETH; NVDA/WETH 0.05% ~425 WETH (0.5 ETH moves each under 0.03%);
// $TROYA Pons pool ~$12k, hence its 5% weight and 600 bps band (the Pons hook keeps 2.9% of every trade).
export const PARAMS = {
  feeRecipient: FEE_ROUTER,
  feeBps: 50,
  mgmtFeeRecipient: CREATOR,
  mgmtFeeBps: 100,
  totalCap: 2_000_000_000_000_000_000n,
  walletCap: 500_000_000_000_000_000n,
  maxMoveBps: 2_000,
  cooldown: 4 * 3600,
  guardian: "0x0000000000000000000000000000000000000000",
  assets: [TOKENS.USDG, TOKENS.SPY, TOKENS.NVDA, TOKENS.TROYA],
  venues: [
    { kind: 1, pool: getAddress("0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca"), currency0: ZERO(), currency1: ZERO(), fee: 0, tickSpacing: 0, hooks: ZERO(), slippageBps: 100, label: "Uniswap v3 WETH/USDG 0.01%" },
    { kind: 1, pool: getAddress("0xddcbba3666f578e3f09516f21ff85bfee859ab5e"), currency0: ZERO(), currency1: ZERO(), fee: 0, tickSpacing: 0, hooks: ZERO(), slippageBps: 200, label: "Uniswap v3 SPY/WETH 0.05%" },
    { kind: 1, pool: getAddress("0x62ab521f71431f78ac374cdbadc6cda3c8916b6c"), currency0: ZERO(), currency1: ZERO(), fee: 0, tickSpacing: 0, hooks: ZERO(), slippageBps: 200, label: "Uniswap v3 NVDA/WETH 0.05%" },
    { kind: 2, pool: ZERO(), currency0: ZERO(), currency1: TOKENS.TROYA, fee: 0, tickSpacing: 200, hooks: PONS_HOOK, slippageBps: 600, label: "Uniswap v4 ETH/$TROYA (Pons pool)" },
  ],
};
function ZERO() { return "0x0000000000000000000000000000000000000000"; }

// the keeper's starting target weights, percent of the vault's ETH value (server/index-keeper.mjs data/index-weights.json)
export const TARGETS = { ETH: 35, USDG: 25, SPY: 20, NVDA: 15, TROYA: 5 };

const coder = AbiCoder.defaultAbiCoder();
const INIT = "tuple(address owner,address swapper,address keeper,address guardian,address feeRecipient,uint16 feeBps,address mgmtFeeRecipient,uint16 mgmtFeeBps,uint256 totalCap,uint256 walletCap,uint16 maxMoveBps,uint32 cooldown,address[] assets,tuple(uint8 kind,address pool,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks,uint16 slippageBps)[] venues)";
export const VAULT_OWNER_IFACE = new Interface(["function transferOwnership(address newOwner)", "function acceptOwnership()", "function owner() view returns (address)", "function pendingOwner() view returns (address)"]);

/** The vault's constructor argument, as one tuple. `owner` is the deploying wallet (the creator), handed to the Safe after. */
export function initTuple({ owner, swapper, keeper }) {
  if (!keeper || /^0x0{40}$/i.test(keeper)) throw new Error("The keeper address is missing.");
  const p = PARAMS;
  return [getAddress(owner), getAddress(swapper), getAddress(keeper), p.guardian, p.feeRecipient, p.feeBps, p.mgmtFeeRecipient, p.mgmtFeeBps, p.totalCap, p.walletCap, p.maxMoveBps, p.cooldown, p.assets,
    p.venues.map((v) => [v.kind, v.pool, v.currency0, v.currency1, v.fee, v.tickSpacing, v.hooks, v.slippageBps])];
}

export const swapperArgs = () => coder.encode(["address", "address", "address", "address"], [WETH, V3_FACTORY, POOL_MANAGER, PONS_HOOK]);
export const vaultArgs = (o) => coder.encode([INIT], [initTuple(o)]);
export const zapArgs = (vault) => coder.encode(["address"], [getAddress(vault)]);

/** The creation calldata of each contract (bytecode + constructor arguments): what the wallet signs, with no `to`. */
export function swapperData(build) { return build.contracts.TroyaIndexSwapper.bytecode + swapperArgs().slice(2); }
export function vaultData(build, o) { return build.contracts.TroyaIndex.bytecode + vaultArgs(o).slice(2); }
export function zapData(build, vault) { return build.contracts.TroyaIndexZap.bytecode + zapArgs(vault).slice(2); }
/** Step 4: the creator proposes the Safe as owner (Ownable2Step: the Safe must then call acceptOwnership()). */
export function transferData() { return VAULT_OWNER_IFACE.encodeFunctionData("transferOwnership", [SAFE]); }
export const acceptData = () => VAULT_OWNER_IFACE.encodeFunctionData("acceptOwnership");

/** The Blockscout verification commands, run from contracts/ (compiler settings come from foundry.toml). */
export function verifyCommands({ swapper, vault, zap, owner, keeper }) {
  const cmd = (addr, path, args) => `forge verify-contract --chain 4663 --verifier blockscout --verifier-url ${BLOCKSCOUT_API} ${getAddress(addr)} ${path} --constructor-args ${args}`;
  return [
    cmd(swapper, "src/TroyaIndexSwapper.sol:TroyaIndexSwapper", swapperArgs()),
    cmd(vault, "src/TroyaIndex.sol:TroyaIndex", vaultArgs({ owner, swapper, keeper })),
    cmd(zap, "src/TroyaIndexZap.sol:TroyaIndexZap", zapArgs(vault)),
  ];
}

/** The server env lines once deployed. */
export function serverEnv({ vault, zap, block }) {
  return [`INDEX_ADDRESS=${getAddress(vault)}`, `INDEX_ZAP_ADDRESS=${getAddress(zap)}`, `INDEX_DEPLOY_BLOCK=${block}`];
}
