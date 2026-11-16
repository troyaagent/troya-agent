// Build public/proof.json: every proof transaction on /verify, read from the chains (signer, recipient, block, time,
// status), with the role of each signer. Facts come from RPC receipts, never typed in by hand.
//   ROBINHOOD_RPC=… node tools/build-proof.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider } from "ethers";
const rh = new JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://robinhood-rpc.publicnode.com", 4663, { staticNetwork: true });
const arb = new JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
const base = new JsonRpcProvider("https://mainnet.base.org", 8453, { staticNetwork: true });
const TEST = "0x12a05719851c8375342DE65c9105329c81f57054";
const ROLES = {
  [TEST.toLowerCase()]: "test wallet: signs in its own browser wallet",
  "0xa5c01a8c15eefc4f32fd9cfaf0e5e0cea02581fa": "Agent Wallet of the test wallet (created by the Troya server; funded by the test wallet, pays back only to it)",
  "0x8ed334bc7affecb524793abb8dbe9e88219473dc": "Agent Wallet of the test wallet (created by the Troya server; funded by the test wallet, pays back only to it)",
  "0x86030ce2975432227ede83027a31a16f33d68b80": "Agent Wallet of the test wallet (created by the Troya server; funded by the test wallet, pays back only to it)",
  "0x2fc617e933a52713247ce25730f6695920b3befe": "bridge relayer: delivers the funds on the destination chain",
  "0x57b09fe6dab0a7d3776e56e6388c773d6c4d09e4": "$TROYA creator wallet",
  "0x45611870017682ec781edb9f71fa72fa91159350": "team wallet: signs in its own browser wallet",
  "0xb584fc6073d541150cbb7b5b25223326b7b3041e": "Agent Wallet of the team wallet (created by the Troya server; funded by the team wallet, pays back only to it)",
  "0xe3d9bba49c856edadc2051c5a49a1be9435ac1f3": "Lighter's operator: settles Lighter withdrawals on Robinhood Chain",
};
const P = (step, chain, hash, what) => ({ step, chain, hash, what });
const LIST = [
  P("01 Uniswap v3", "robinhood", "0x88545a2127a8f3bd7c847e483105c08494030be51d54ac7a025dc6dc00825cf4", "buy NVDA (tokenized stock) through Uniswap SwapRouter02"),
  P("01 Uniswap v3", "robinhood", "0xf412b39b5b07c1a223afc2277053d999b1b916001fa9793b7bbad16cb1880cd2", "sell it back"),
  P("02 Uniswap v4 + Permit2", "robinhood", "0xfdafe63ccaea8743ec06440cf3b10c81ed32d00314a5fe879be339e4492cac4f", "buy a graduated Pons coin through the Universal Router"),
  P("02 Uniswap v4 + Permit2", "robinhood", "0xdf5827c7d3f84676c3ce16078c326251f5e4e729a7c5e97ad9dab59cad1d5a3f", "sell it back"),
  P("03 Pons curve", "robinhood", "0x2ef33a9b16b331e192287fb5d5f149ec3d2d908019352678a3f7726760c5b86f", "buy on a Pons bonding curve"),
  P("03 Pons curve", "robinhood", "0xe45f3ea043b21d212bb307af7937dfff5d5f7ae6f00d6ea0f47539c7293ed23b", "sell on the curve"),
  P("04 Bridge round trip", "robinhood", "0x106b35a7e29551d9f907733bae4562bce1aca36836fe60d9649739abbff1b730", "ETH out of Robinhood Chain (LI.FI route)"),
  P("04 Bridge round trip", "arbitrum", "0x7cbe23f72daef6440bb70915baf489d37b52d4ae8b33616bad463d50c98379ed", "landed on Arbitrum One"),
  P("04 Bridge round trip", "arbitrum", "0xe108a08a7b6b01ba36de7124ba3f3f7445fc8373ea4eadb2b74d52551efc4aee", "back from Arbitrum One"),
  P("04 Bridge round trip", "robinhood", "0xca2d1d5964a253897045cfe4b72e5749a155db11e476c51482bfb29eb7e8058f", "landed on Robinhood Chain"),
  P("05 Agent Wallet", "robinhood", "0x5d3db1995477304fbbe3ce4c67a04a44f1c6be8c60147f693086a17f6f2762f6", "chat ticket executed by the Agent Wallet"),
  P("05 Agent Wallet", "robinhood", "0x4d1f80241a73fbaa1026166d1fc54d8d4ab950c0ad3182ce8f03f459b52347fb", "everything withdrawn to the test wallet"),
  P("07 Trade in Telegram", "robinhood", "0x282a01ebe1774bf13e535d148a022f8ae93d32583598846ab44c4785cfd1d959", "buy $TROYA from the private-chat flow"),
  P("07 Trade in Telegram", "robinhood", "0xd027417bd7f5318abf1a13d18f76395c8d4f7311d0b53be145353c22ac98bd81", "sell 100% back"),
  P("07 Trade in Telegram", "robinhood", "0x70fd6b4d86741cb440c299dc358d86abb4a022a37896b59bd1c0bda25e1d828b", "everything withdrawn to the test wallet"),
  P("08 Fund Hyperliquid", "robinhood", "0x0e3d36d9876d49973fc1893c3bb0811230035905ac6c595cca91a23dc25396d1", "the test wallet funds its Agent Wallet"),
  P("08 Fund Hyperliquid", "robinhood", "0x123f596fbad3f4bf1c7659378e237145e28bc9d343fe8896d456588ac624a404", "ETH → USDC on the test wallet's Hyperliquid account, from the Agent Wallet"),
  P("08 Fund Hyperliquid", "robinhood", "0x45c50c60b9f8e9d66432803b77c5d8a13d598b16873ec78a113026484efe17e3", "the Agent Wallet pays its ETH back to the test wallet"),
  P("08 Fund Hyperliquid", "robinhood", "0x292ca004d4e230ea346ba3b107d4e40ba74c0894cafb8ea79a1138c25fe65598", "ETH → USDC on Hyperliquid, from the Bridge page signed by the test wallet"),
  P("10 Sentry Autopilot, live", "arbitrum", "0xd767ae3732a2d5dcce2c201d96155619e0b3f0ab79c54dcbcbe225a3539985be", "the test wallet's USDC (withdrawn from Hyperliquid) bridged back as ETH to its Agent Wallet on Robinhood Chain"),
  P("10 Sentry Autopilot, live", "robinhood", "0xe4a7165b256ad28e7af67119b7305981e8de8d34ee7acf3f663b4ffd5c76f5ca", "Autopilot buy from the Agent Wallet"),
  P("10 Sentry Autopilot, live", "robinhood", "0x1eae52db4926b2bc7449fcd6c38eb09b065d4f1cd024aeef2cdd9fef656f31d3", "Autopilot sells it all back"),
  P("11 Other launchpads through KyberSwap", "robinhood", "0x53dde2747f8138fa34de7ca4ebbf9fc6015cc8c58e188d58db822443d5346a24", "buy ABYSS (Abyss launchpad) through the KyberSwap router from the Swap page"),
  P("11 Other launchpads through KyberSwap", "robinhood", "0xaf498861e6e1c53592eca2c5a8e9869e45e1591560e7a951e79840fc99b9842b", "approve ABYSS for the KyberSwap router (the exact amount)"),
  P("11 Other launchpads through KyberSwap", "robinhood", "0xf5f46c779faf0c80fe2ac107a3c1fbfea6c671b4454be5faddc344c9cc197c4b", "sell it all back to ETH"),
  P("12 Arbitrum and Base", "arbitrum", "0x5cdd494230e3f2b248038d8097d2f034afc57aec85a0f8fff04d995db9bf31f2", "buy ARB on Arbitrum One through the KyberSwap router from the Swap page"),
  P("12 Arbitrum and Base", "arbitrum", "0x70f35f6cf130963c9caae8f7251f0ed1ea64400e9ec03666b47669f32333f330", "approve ARB for the KyberSwap router (the exact amount)"),
  P("12 Arbitrum and Base", "arbitrum", "0xd82d36eb4daa4aed9dcf307726958bf57787e0a59aeb6f943fd4313a30adf9c1", "sell it all back to ETH"),
  P("12 Arbitrum and Base", "base", "0x8d06b5f72fe6425150844966998bc0b0daf1b1459a173f605019211005fdf180", "buy AERO on Base through the KyberSwap router from the Swap page"),
  P("12 Arbitrum and Base", "base", "0x5753629f0e8456a4c701ced613d30c68497dda77964788f26b92b65664ec6b4e", "approve AERO for the KyberSwap router (the exact amount)"),
  P("12 Arbitrum and Base", "base", "0x5af7272242e14a3d183279db8e831c886433cec850d62ac6b5e07c9a49b317c3", "sell it all back to ETH"),
  P("15 Stock basket", "robinhood", "0x2f2de2e44f9933293bc84aa666c3ec6ef32b6b36a90bc9bba5c4a399b46de055", "Index core basket, leg 1: ETH to SPY (tokenized stock) after Troya Gate"),
  P("15 Stock basket", "robinhood", "0x9e0b37341fde2461f074150b27973c24ecc9af01e34b09f690c781d5ea9e2aaa", "Index core basket, leg 2: ETH to QQQ after Troya Gate"),
  P("16 TWAP through the Agent Wallet", "robinhood", "0xb98f3fa142123629d806fed0d1c9cb0d69e90ff0417cb4c3f2594c90bcb210df", "the team wallet funds its Agent Wallet with 0.006 ETH"),
  P("16 TWAP through the Agent Wallet", "robinhood", "0x3b5982b6de64469bc12dfe4aa6fb7c8135aedce24c98db2517780710b4fd85aa", "TWAP slice 1: ETH to NVDA, under the 0.4% impact cap"),
  P("16 TWAP through the Agent Wallet", "robinhood", "0x0bf91409d5eb2d7d9bfeb9b9e546fddda4e2935a7ef7759f22eebb0372154f3a", "TWAP slice 2, two minutes later"),
  P("18 Lighter on Robinhood Chain", "robinhood", "0xe3f0d48c7d3d663d2bc2ac8814cd9253191874a74615d4c9c2e36bcb3317a217", "ETH to USDG on the Swap page"),
  P("18 Lighter on Robinhood Chain", "robinhood", "0x2aa0faad2f17ee2d397d61af60c49dfe775c74776cd845641b3e718b5e7a2912", "approve 11 USDG for Lighter's contract (the exact amount)"),
  P("18 Lighter on Robinhood Chain", "robinhood", "0x2e2763df0a403cac9f0f2580fcf68b34f1b521beda28c440b6b4f4bfb9a2b091", "deposit 11 USDG into Lighter: opens account #55518"),
  P("18 Lighter on Robinhood Chain", "robinhood", "0xec4b83ddd11b9c0a9139cd6d656482bf08eab049b05e72c001882b132f26a91f", "Lighter pays the 11 USDG withdrawal back to the team wallet"),
  P("19 Borrow on Morpho", "robinhood", "0xfcd12c7dc8d5114080dfea4449830e0b9d7e5ad89fa1a37f13ba040fd56f6849", "ETH to NVDA for collateral, on the Swap page"),
  P("19 Borrow on Morpho", "robinhood", "0x7c1e70e029356fc1bf94f68ba0d5ceaed13dfcfe38b4ec37996a093324a7f816", "approve 0.051 NVDA for Morpho Blue (the exact amount)"),
  P("19 Borrow on Morpho", "robinhood", "0x800093c6ce2e14bd59ac92e42ad1ddc4aa7c602d01e9582a71ef7b5eda6aa956", "post 0.051 NVDA as collateral (NVDA/USDG market, LLTV 62.5%)"),
  P("19 Borrow on Morpho", "robinhood", "0x3c210216885d549c44c68b0dade6d958a4b06c7827eca110dc6d533a9b09452f", "borrow 1 USDG at health factor 4.99"),
  P("19 Borrow on Morpho", "robinhood", "0x6e0be035db00455fa5a898be4c42b13de54b5b7faab372ddef41435bf7c4ad7c", "approve USDG for the repayment"),
  P("19 Borrow on Morpho", "robinhood", "0xc24560f5eae62167e178a4f9772c303cf3a7f1b5943585df457f8a2c139ecf5a", "repay all by borrow shares: 1.000001 USDG, no dust left"),
  P("19 Borrow on Morpho", "robinhood", "0xb0e66f9040197c5e7edaf8863510982c14366dd181c4f415b8fc874a1aedaad7", "withdraw the exact 0.051 NVDA collateral"),

  P("LP burn", "robinhood", "0xfe7f12591df9b9f53a0366a31cf36d1cf00b8200b6ae05fb8eeb7989afc24ea0", "Uniswap v4 position NFT #4293939 (ETH/TROYA pool) sent to 0x…dEaD: that liquidity can never be removed"),
];
const EXP = { robinhood: "https://robinhoodchain.blockscout.com/tx/", arbitrum: "https://arbitrum.blockscout.com/tx/", base: "https://basescan.org/tx/" };
const out = [];
for (const x of LIST) {
  const p = x.chain === "arbitrum" ? arb : x.chain === "base" ? base : rh;
  const [t, rc] = await Promise.all([p.getTransaction(x.hash), p.getTransactionReceipt(x.hash)]);
  if (!t || !rc) throw new Error(`not found: ${x.hash}`);
  const b = await p.getBlock(rc.blockNumber);
  out.push({ ...x, chainId: x.chain === "arbitrum" ? 42161 : x.chain === "base" ? 8453 : 4663, explorer: EXP[x.chain] + x.hash, signer: t.from, signerRole: ROLES[t.from.toLowerCase()] || "contract or third party", to: t.to, block: rc.blockNumber, timeUtc: new Date(b.timestamp * 1000).toISOString(), status: rc.status === 1 ? "success" : "failed" });
  process.stdout.write(".");
}
const doc = {
  name: "Troya Agent proof log", site: "https://troya.codes/verify", generated: new Date().toISOString(),
  testWallet: TEST, note: "Every transaction is read from the chain. Agent Wallets are created by the Troya server for a signed-in wallet; each one here was funded by the test wallet and paid back only to it. Hyperliquid fills: https://troya.codes/api/proof/hl-fills (from Hyperliquid's own info API). From 16 Nov the team wallet 0x45611870017682Ec781EDb9F71fA72fA91159350 signs too; its Agent Wallet pays back only to it. Lighter trades of account 55518: https://api.rh.lighter.xyz/api/v1/trades?account_index=55518&sort_by=timestamp&limit=10",
  transactions: out,
};
writeFileSync(join(import.meta.dirname, "..", "public", "proof.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`\nwrote public/proof.json: ${out.length} transactions, all ${out.every((x) => x.status === "success") ? "successful" : "NOT all successful"}`);
