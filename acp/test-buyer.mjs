// End-to-end test of the Troya Gate offering on Virtuals ACP: the "Troya Test Buyer" agent hires Troya Gate for one
// check, funds the 0.01 USDC budget, checks the signed deliverable and completes the job (which releases the escrow).
// Env: ~/.config/troya/acp-buyer.env (ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_KEY of the buyer agent).
// Usage: node test-buyer.mjs [token] [--chain=robinhood]
import { readFileSync } from "node:fs";
import { keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken, robinhood } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";

const env = Object.fromEntries(readFileSync(process.env.HOME + "/.config/troya/acp-buyer.env", "utf8").split("\n").filter((l) => /^ACP_/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const SELLER = "0x1731a0D264A4fd6aB6702bD849Aa6A13533c7E6C";
const ATTESTOR = "0xbEa3056612704eEE964B892862d969D2d4bB5fDE";
const token = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const chain = process.argv.includes("--chain=robinhood") ? robinhood : base;
const t0 = Date.now(), log = (...a) => console.log(`[buyer +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const finish = async (code) => { await buyer.stop().catch(() => {}); process.exit(code); };
setTimeout(() => { log("timed out after 8 minutes"); finish(2); }, 8 * 60_000);

const buyer = await AcpAgent.create({
  evmProvider: await PrivyAlchemyEvmProviderAdapter.create({ walletAddress: env.ACP_WALLET_ADDRESS, walletId: env.ACP_WALLET_ID, signerPrivateKey: env.ACP_SIGNER_KEY, chains: [chain] }),
});
const me = await buyer.getAddress();
let jobId = null;

buyer.on("entry", async (session, entry) => {
  if (jobId && String(session.jobId) !== String(jobId)) return;
  if (entry.kind === "message") { log("message:", String(entry.content).slice(0, 300)); return; }
  const type = entry.event?.type;
  log("event:", type, "status:", session.status);
  try {
    if (type === "budget.set") {
      await session.fund(AssetToken.usdc(0.01, session.chainId));
      log("funded 0.01");
    } else if (type === "job.submitted") {
      const raw = entry.event?.deliverable ?? entry.event?.content ?? entry.event?.data ?? JSON.stringify(entry.event);
      let d = null; try { d = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
      const att = d?.attested;
      const hashOk = att && keccak256(toUtf8Bytes(JSON.stringify(att))) === d.hash;
      let signer = null; try { signer = att ? verifyMessage(`Troya Gate result\n${d.hash}`, d.signature) : null; } catch {}
      log("deliverable:", d?.summary || String(raw).slice(0, 300));
      log("hash matches:", !!hashOk, "| signed by Troya attestor:", signer === ATTESTOR);
      await session.complete(hashOk && signer === ATTESTOR ? "Signed Troya Gate result received and verified" : "Result received");
      log("completed the job");
    } else if (type === "job.completed") { log("JOB COMPLETED"); finish(0); }
    else if (type === "job.rejected" || type === "job.expired") { log("job ended:", type); finish(1); }
  } catch (e) { log("error on", type, e?.message || e); }
});

await buyer.start(() => log(`buyer online as ${me} on ${chain.name}`));
jobId = await buyer.createJobByOfferingName(chain.id, "troyaGateCheck", SELLER, { token, amountEth: 0.01 }, { evaluatorAddress: me });
log("created job", jobId, "for", token);
