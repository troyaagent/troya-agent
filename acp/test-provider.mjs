// "Troya Test Provider": a small ACP provider used to test Troya as a job EVALUATOR (V10 F66 Phaeacians) end to end,
// because outside providers did not answer (Fun Freak, 26 Nov 2026). Its job "token_snapshot" takes a Robinhood Chain
// token address ({"token":"0x..."}), asks 0.01 USDC on Base, and once the buyer funds the escrow it delivers a real
// snapshot read from troya.codes' public API: price, market cap, liquidity (pool total and money side), 24 h volume and
// change, holders, age, launchpad and the latest Troya Gate verdict with its failing or warning checks. Troya Gate (the evaluator)
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
const SITE = "https://troya.codes";
const getJson = (u) => fetch(SITE + u, { signal: AbortSignal.timeout(60_000) }).then((r) => r.json());
const readToken = (content) => { try { const j = typeof content === "string" ? JSON.parse(content) : content; return String(j?.token || j?.address || "").match(/0x[0-9a-fA-F]{40}/)?.[0] || null; } catch { return String(content || "").match(/0x[0-9a-fA-F]{40}/)?.[0] || null; } };
const asks = new Map();   // jobId -> token address from the requirement
async function snapshot(token) {
  const [m, g] = await Promise.all([getJson(`/api/market/robinhood/token?address=${token}`).catch(() => null), getJson(`/api/badge/${token}`).catch(() => null)]);
  const t = m?.token;
  if (!t?.symbol) return { ok: false, token, summary: `No Robinhood Chain token found at ${token}.` };
  const flags = (g?.checks || []).filter((c) => c.status === "fail" || c.status === "warn").map((c) => `${c.label}: ${String(c.detail || "").slice(0, 160)}`);
  return {
    ok: true, token, symbol: t.symbol, name: t.name, launchpad: t.launchpad || null,
    priceUsd: t.priceUsd ?? null, mcapUsd: t.mcapUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, moneySideLiquidityUsd: t.realLiquidityUsd ?? null,
    volume24hUsd: t.volume24hUsd ?? null, change24hPct: t.change24h ?? null, holders: t.holders ?? null,
    ageDays: t.bornAt ? Math.round((Date.now() - t.bornAt) / 864e5 * 10) / 10 : null,
    gate: g?.verdict ? { verdict: g.verdict, checkedAt: g.checkedAt || null, flags } : null,
    sources: [`${SITE}/agent#/token/${token}`, `${SITE}/agent#/gate/${token}`],
    summary: `${t.symbol}: $${Number(t.mcapUsd || 0).toFixed(0)} market cap, $${Number(t.liquidityUsd || 0).toFixed(0)} liquidity, ${t.holders ?? "?"} holders, Gate ${g?.verdict || "not read"}${flags.length ? ` (${flags.length} flag${flags.length > 1 ? "s" : ""})` : ""}.`,
    at: new Date().toISOString(),
  };
}
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
      const token = readToken(entry.content);
      if (!token) { await session.sendMessage('token_snapshot needs a Robinhood Chain token address, e.g. {"token":"0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"}. Please open a new job with it.'); log(`job ${session.jobId}: no token address, asked for one`); return; }
      asks.set(String(session.jobId), token);
      await session.setBudget(AssetToken.usdc(PRICE, session.chainId));
      log(`job ${session.jobId}: snapshot of ${token} requested, asked ${PRICE} USDC`);
    });
  }
  if (entry.kind === "system" && type === "job.funded" && session.status === "funded") {
    return once(session, "submit", async () => {
      const token = asks.get(String(session.jobId)) || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
      const snap = await snapshot(token);
      await session.submit(JSON.stringify(snap));
      log(`job ${session.jobId}: funded, snapshot delivered (${snap.summary}); waiting for the evaluator`);
    });
  }
  if (entry.kind === "system" && /job\.(completed|rejected|expired)/.test(type || "")) log(`job ${session.jobId}: ${type}`);
});

await agent.start(() => log(`online as ${env.ACP_WALLET_ADDRESS} on Base, ${PRICE} USDC per test job. Leave this window open.`));
