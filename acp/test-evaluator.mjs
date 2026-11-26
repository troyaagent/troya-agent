// End-to-end test of Troya as an ACP EVALUATOR (V10 F66 Phaeacians): the "Troya Test Buyer" agent hires another
// provider (Fun Freak, "Fun Freak Picks feed", 0.05 USDC on Base) and names Troya Gate (0x1731…7E6C) as the job's
// evaluator. When the provider submits, Troya's seller program (acp/seller.mjs on the server) runs the Phaeacians
// precheck, signs a record, and completes or rejects the job. This script only watches and prints what happens.
// It spends 0.05 USDC from the Troya Test Buyer agent wallet (Base) into ACP's escrow.
// Env: ~/.config/troya/acp-buyer.env (ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_KEY of the buyer agent).
// Usage (the owner runs it): cd ~/Desktop/TROYAAGENT/acp && node test-evaluator.mjs
import { readFileSync } from "node:fs";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";

const env = Object.fromEntries(readFileSync(process.env.HOME + "/.config/troya/acp-buyer.env", "utf8").split("\n").filter((l) => /^ACP_/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
// the provider: "Troya Test Provider" (test-provider.mjs, ~/.config/troya/acp-provider.env) when it exists, else Fun Freak
// (which never answered on 26 Nov 2026). Override with TEST_PROVIDER / TEST_OFFERING / TEST_PRICE.
let own = null;
try { own = Object.fromEntries(readFileSync(process.env.HOME + "/.config/troya/acp-provider.env", "utf8").split("\n").filter((l) => /^ACP_/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])); } catch { own = null; }
const PROVIDER = process.env.TEST_PROVIDER || own?.ACP_WALLET_ADDRESS || "0x5c1f1a8214da64125fa9450a6fc55e8931779dda";
const OFFERING = process.env.TEST_OFFERING || (own ? own.ACP_OFFERING || "test_task" : "Fun Freak Picks feed");
const EVALUATOR = "0x1731a0D264A4fd6aB6702bD849Aa6A13533c7E6C";   // Troya Gate
const PRICE = Number(process.env.TEST_PRICE || (own ? own.ACP_PRICE_USDC || 0.01 : 0.05));
const t0 = Date.now(), log = (...a) => console.log(`[test +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const finish = async (code) => { await buyer.stop().catch(() => {}); process.exit(code); };
setTimeout(() => { log("no final result after 15 minutes; the job may still be open on ACP (an unfinished job expires and the escrow returns to the buyer)"); finish(2); }, 15 * 60_000);

const buyer = await AcpAgent.create({
  evmProvider: await PrivyAlchemyEvmProviderAdapter.create({ walletAddress: env.ACP_WALLET_ADDRESS, walletId: env.ACP_WALLET_ID, signerPrivateKey: env.ACP_SIGNER_KEY, chains: [base] }),
});
const me = await buyer.getAddress();
let jobId = null;

buyer.on("entry", async (session, entry) => {
  if (jobId && String(session.jobId) !== String(jobId)) return;
  if (entry.kind === "message") { log("message:", String(entry.content).slice(0, 300)); return; }
  const type = entry.event?.type;
  log("event:", type, "| status:", session.status);
  try {
    if (type === "budget.set") {
      await session.fund(AssetToken.usdc(PRICE, session.chainId));
      log(`funded ${PRICE} USDC into escrow`);
    } else if (type === "job.submitted") {
      log("provider submitted; waiting for Troya (the evaluator) to complete or reject…");
    } else if (type === "job.completed") { log("JOB COMPLETED by the evaluator (escrow paid to the provider). Troya's record: https://troya.codes/api/phaeacians"); finish(0); }
    else if (type === "job.rejected") { log("JOB REJECTED by the evaluator (escrow back to the buyer). Reason above. Record: https://troya.codes/api/phaeacians"); finish(0); }
    else if (type === "job.expired") { log("job expired (escrow back to the buyer)"); finish(1); }
  } catch (e) { log("error on", type, e?.message || e); }
});

await buyer.start(() => log(`buyer online as ${me} on Base`));
jobId = await buyer.createJobByOfferingName(base.id, OFFERING, PROVIDER, { service: "picks" }, { evaluatorAddress: EVALUATOR });
log("created job", jobId, `→ provider ${own ? "Troya Test Provider" : "Fun Freak"} (${OFFERING}, ${PRICE} USDC), evaluator Troya Gate`);
