// "Troya Test Provider": a tiny ACP provider used only to test Troya as a job EVALUATOR (V10 F66 Phaeacians) end to end,
// because outside providers did not answer (Fun Freak, 26 Nov 2026). It accepts any job for its test offering, asks
// 0.01 USDC on Base, and once the buyer funds the escrow it submits a short test deliverable. Troya Gate (the evaluator)
// then completes or rejects the job. This program never moves money itself: ACP's escrow pays it only if Troya completes.
// Env: ~/.config/troya/acp-provider.env (ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_KEY of the provider agent).
// Usage (on the owner's Mac, in its own Terminal window, before test-evaluator.mjs): node test-provider.mjs
import { readFileSync } from "node:fs";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";

const env = Object.fromEntries(readFileSync(process.env.HOME + "/.config/troya/acp-provider.env", "utf8").split("\n").filter((l) => /^ACP_/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const PRICE = Number(env.ACP_PRICE_USDC || 0.01);
const log = (...a) => console.log(`[provider ${new Date().toISOString().slice(11, 19)}]`, ...a);
const done = new Set();
const once = async (session, what, fn) => {
  const k = `${session.chainId}:${session.jobId}:${what}`;
  if (done.has(k)) return; done.add(k);
  try { await fn(); } catch (e) { done.delete(k); log(`job ${session.jobId} ${what} failed:`, e?.message || e); }
};

const agent = await AcpAgent.create({
  evmProvider: await PrivyAlchemyEvmProviderAdapter.create({ walletAddress: env.ACP_WALLET_ADDRESS, walletId: env.ACP_WALLET_ID, signerPrivateKey: env.ACP_SIGNER_KEY, chains: [base] }),
});

agent.on("entry", async (session, entry) => {
  if (!session.roles?.includes("provider")) return;
  const type = entry.event?.type;
  if (entry.kind === "message" && entry.contentType === "requirement" && session.status === "open") {
    return once(session, "budget", async () => {
      await session.setBudget(AssetToken.usdc(PRICE, session.chainId));
      log(`job ${session.jobId}: requirement received, asked ${PRICE} USDC`);
    });
  }
  if (entry.kind === "system" && type === "job.funded" && session.status === "funded") {
    return once(session, "submit", async () => {
      await session.submit(JSON.stringify({ summary: "Troya Test Provider: test deliverable for an evaluator check.", deliveredAt: new Date().toISOString(), job: String(session.jobId) }));
      log(`job ${session.jobId}: funded, test deliverable submitted; waiting for the evaluator`);
    });
  }
  if (entry.kind === "system" && /job\.(completed|rejected|expired)/.test(type || "")) log(`job ${session.jobId}: ${type}`);
});

await agent.start(() => log(`online as ${env.ACP_WALLET_ADDRESS} on Base, ${PRICE} USDC per test job. Leave this window open.`));
