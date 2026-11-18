// Troya Gate as a Virtuals ACP seller (ACP SDK v2). Another agent hires the "Troya Gate check" offering with a token
// address, funds the job in USDC into ACP's escrow on Base, and gets back the fresh Troya Gate check signed by Troya's
// attestor. Nothing here holds the buyer's money: ACP's escrow does, and pays the agent wallet once the job completes.
//
// The check runs on the Troya server next to this process (GET /api/gate/v1/internal/check/:token, from this machine
// only, with GATE_INTERNAL_KEY). In ACP v2 a provider cannot cancel a funded job, so when the check cannot run after
// three tries the deliverable says so plainly and asks the buyer to reject it, which returns the escrow.
//
// Env (acp.env on the server, never committed; values from the agent's page on app.virtuals.io):
//   ACP_WALLET_ADDRESS   the agent wallet address            ACP_WALLET_ID      the wallet id (Signers tab)
//   ACP_SIGNER_KEY       the signer private key (Signers tab → Add Signer → Copy Key)
//   ACP_BUILDER_CODE     optional, bc-… from the Settings tab  ACP_PRICE_USDC     default 0.01
//   GATE_INTERNAL_KEY    the same value as in the server's .env  TROYA_URL        default http://127.0.0.1:9270
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";

const env = process.env;
for (const k of ["ACP_WALLET_ADDRESS", "ACP_WALLET_ID", "ACP_SIGNER_KEY", "GATE_INTERNAL_KEY"])
  if (!env[k]) { console.error(`[acp] ${k} is not set; see acp/README.md`); process.exit(1); }
const TROYA = String(env.TROYA_URL || "http://127.0.0.1:9270").replace(/\/+$/, "");
const PRICE = Math.max(0.01, Number(env.ACP_PRICE_USDC || 0.01));
const ADDR = /0x[0-9a-fA-F]{40}/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the buyer asked for: { token, amountEth } as the offering's schema says, or any text that holds a token address
function readAsk(content) {
  const o = typeof content === "string" ? (() => { try { return JSON.parse(content); } catch { return { text: content }; } })() : content || {};
  const token = (ADDR.exec(String(o.token || o.tokenAddress || o.contract || "")) || ADDR.exec(JSON.stringify(o)) || [])[0] || null;
  const amt = Number(o.amountEth ?? o.amount ?? 0.01);
  return { token, amountEth: Number.isFinite(amt) && amt > 0 ? Math.min(5, Math.max(0.0001, amt)) : 0.01, assay: o.assay !== false && o.assay !== 0 && o.assay !== "0" };
}
const askOf = (session) => {
  const req = [...session.entries].find((e) => e.kind === "message" && e.contentType === "requirement");
  return req ? readAsk(req.content) : { token: null };
};

async function gateCheck({ token, amountEth, assay }) {
  const u = `${TROYA}/api/gate/v1/internal/check/${token}?amountEth=${amountEth}&assay=${assay ? 1 : 0}`;
  const r = await fetch(u, { headers: { "x-internal-key": env.GATE_INTERNAL_KEY }, signal: AbortSignal.timeout(40_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.attested) throw Object.assign(new Error(j?.error || `Troya answered ${r.status}`), { final: r.status === 400 });
  return j;
}

const SAY = {
  passed: "passed every Troya Gate test",
  caution: "passed the trade tests, but The Assay raised a red flag",
  failed: "failed Troya Gate",
  untested: "has had no buys yet, so the sell test could not run",
};
function deliverable(out) {
  const a = out.attested;
  const name = a.symbol ? `$${a.symbol}` : "This token";
  const notes = (a.checks || []).filter((c) => c.status === "fail" || c.status === "warn").map((c) => c.detail).filter(Boolean);
  return JSON.stringify({
    summary: `${name} (${a.token}) ${SAY[a.verdict] || `came back "${a.verdict}"`} at a ${a.amountEth} ETH trade on Robinhood Chain.${a.reason ? ` ${a.reason}.` : ""}${notes.length ? ` Notes: ${notes.slice(0, 3).join("; ")}.` : ""}`,
    verdict: a.verdict,
    attested: a,
    hash: out.hash,
    signature: out.signature,
    attestor: out.attestor,
    howToVerify: "keccak256 of JSON.stringify(attested) equals hash, and the EIP-191 signature of \"Troya Gate result\\n<hash>\" recovers to attestor. Or POST { attested, signature } to https://troya.codes/api/gate/v1/verify",
  });
}

const busy = new Set();   // one handler per job at a time (events can arrive twice on reconnect)
async function once(session, what, fn) {
  const k = `${session.chainId}:${session.jobId}:${what}`;
  if (busy.has(k)) return; busy.add(k);
  try { await fn(); } catch (e) { console.error(`[acp] job ${session.jobId} ${what}:`, e?.message || e); } finally { busy.delete(k); }
}

const agent = await AcpAgent.create({
  evmProvider: await PrivyAlchemyEvmProviderAdapter.create({      // 0.1.15 names it evmProvider (the README still says provider)
    walletAddress: env.ACP_WALLET_ADDRESS, walletId: env.ACP_WALLET_ID, signerPrivateKey: env.ACP_SIGNER_KEY,
    chains: [base], ...(env.ACP_BUILDER_CODE ? { builderCode: env.ACP_BUILDER_CODE } : {}),
  }),
});

agent.on("entry", async (session, entry) => {
  // 1) the buyer's requirement: a token address → propose the price; anything else → say what is needed (nothing is paid)
  if (entry.kind === "message" && entry.contentType === "requirement" && session.status === "open") {
    return once(session, "budget", async () => {
      const ask = readAsk(entry.content);
      if (!ask.token) {
        await session.sendMessage("Troya Gate needs the token's contract address on Robinhood Chain (0x followed by 40 hex characters), for example {\"token\":\"0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074\",\"amountEth\":0.01}. Please open a new job with it.");
        console.log(`[acp] job ${session.jobId}: no token address, asked for one`);
        return;
      }
      await session.setBudget(AssetToken.usdc(PRICE, session.chainId));
      console.log(`[acp] job ${session.jobId}: ${ask.token} at ${ask.amountEth} ETH, budget ${PRICE} USDC`);
    });
  }
  // 2) funded → run the check and submit it
  if (entry.kind === "system" && entry.event?.type === "job.funded" && session.status === "funded") {
    return once(session, "submit", async () => {
      const ask = askOf(session);
      let out = null, err = null;
      for (let i = 0; i < 3 && !out; i++) {
        try { out = await gateCheck(ask); } catch (e) { err = e; if (e.final) break; await sleep(20_000); }
      }
      if (out) {
        await session.submit(deliverable(out));
        console.log(`[acp] job ${session.jobId} submitted: ${ask.token} ${out.attested.verdict}`);
      } else {
        await session.submit(JSON.stringify({ summary: `The Troya Gate check could not run for ${ask.token || "this request"} (${String(err?.message || "unknown").slice(0, 160)}). Please reject this job so ACP returns your USDC, then try again in a few minutes.`, verdict: "not-run" }));
        console.error(`[acp] job ${session.jobId}: check failed after funding, asked the buyer to reject: ${err?.message}`);
      }
    });
  }
  if (entry.kind === "system" && /job\.(completed|rejected|expired)/.test(entry.event?.type || "")) console.log(`[acp] job ${session.jobId} ${entry.event.type}`);
});

await agent.start(() => console.log(`[acp] Troya Gate seller online as ${env.ACP_WALLET_ADDRESS}, ${PRICE} USDC a check, checks from ${TROYA}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await agent.stop().catch(() => {}); process.exit(0); });
