// Live test: calls every wrapper against https://troya.codes (or TROYA_BASE_URL) and prints a trimmed view of each answer.
// Read only. The signed Gate check spends one of the caller IP's few free checks a day; skip it with SKIP_SIGNED=1.
//   node test/live.mjs
import assert from "node:assert/strict";
import { createTroyaClient, TroyaError, TROYA_TOKEN, TOOLS, runTool } from "../src/index.js";

const troya = createTroyaClient({ baseUrl: process.env.TROYA_BASE_URL, timeoutMs: 40_000 });
const CREATOR = "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4";   // the $TROYA deployer wallet
const AGENT = "0x45611870017682Ec781EDb9F71fA72fA91159350";     // "Argus", an agent in Troya's registry (Bow's own example)
const trim = (v, n = 600) => { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const out = await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)\n     ${trim(out)}`); }
  catch (e) { failed++; console.log(`FAIL ${name} (${Date.now() - t0} ms): ${e?.code || ""} ${e?.message || e}`); }
}

await step("gateCheck (free, unsigned)", async () => {
  const r = await troya.gateCheck(TROYA_TOKEN, { amountEth: 0.01 });
  assert.equal(r.symbol, "TROYA"); assert.ok(["passed", "caution", "failed", "untested"].includes(r.verdict)); assert.ok(r.checks.length > 3);
  assert.equal(r.tx, undefined, "the built swap transaction must never be returned");
  return { verdict: r.verdict, reason: r.reason, impact: r.quote?.priceImpactPct, fee: r.quote?.feePct, route: r.quote?.route, checks: r.checks.map((c) => `${c.key}:${c.status}`) };
});

let signed = null;
if (process.env.SKIP_SIGNED !== "1") await step("signedGateCheck (free tier or 402)", async () => {
  try {
    signed = await troya.signedGateCheck(TROYA_TOKEN, { amountEth: 0.01 });
    assert.ok(signed.signature && signed.attested.token);
    return { verdict: signed.attested.verdict, reason: signed.attested.reason, attestor: signed.attestor, paid: signed.paid, assayFlags: (signed.attested.assay?.flags || []).map((f) => `${f.level}:${f.title}`) };
  } catch (e) {
    if (e instanceof TroyaError && e.code === "PAYMENT_REQUIRED") return { code: e.code, status: e.status, message: e.message, payTo: e.payment?.payTo, price: e.payment?.price };
    throw e;
  }
});
if (signed) await step("verifyGateResult", async () => {
  const v = await troya.verifyGateResult(signed); assert.equal(v.genuine, true); return v;
});
await step("gateInfo", async () => { const r = await troya.gateInfo(); return { price: r.price, freeTier: r.freeTier, attestor: r.attestor }; });
await step("gateCredits", async () => { const r = await troya.gateCredits(CREATOR); return { freePerDay: r.freePerDay, freeLeftToday: r.freeLeftToday, balanceUsdg: r.balanceUsdg }; });
await step("x402Info", async () => { const r = await troya.x402Info(); return { enabled: r.enabled, network: r.network, price: r.price, networks: (r.networks || []).map((n) => n.name) }; });
await step("x402Requirements (reads the 402, pays nothing)", async () => {
  const r = await troya.x402Requirements(TROYA_TOKEN); assert.equal(r.status, 402);
  return { status: r.status, x402Version: r.required?.x402Version, accepts: (r.required?.accepts || []).map((a) => `${a.network} ${a.amount} → ${a.payTo}`) };
});

await step("tridentCheck: unlimited approve to a plain wallet (expect block)", async () => {
  const spender = AGENT.slice(2).toLowerCase().padStart(64, "0");   // a plain wallet as the spender
  const r = await troya.tridentCheck({ from: CREATOR, to: TROYA_TOKEN, data: "0x095ea7b3" + spender + "f".repeat(64), value: "0" });
  assert.equal(r.verdict, "block"); return { verdict: r.verdict, summary: r.summary, reasons: r.reasons.map((x) => `${x.level}:${x.code}`), signedBy: r.signed?.attestor };
});
await step("tridentCheck: plain ETH transfer to a wallet", async () => {
  const r = await troya.tridentCheck({ from: CREATOR, to: AGENT, data: "0x", value: "1000000000000000" });
  return { verdict: r.verdict, summary: r.summary, reasons: r.reasons };
});

await step("bridgeSafety base → robinhood 0.1 ETH", async () => {
  const r = await troya.bridgeSafety({ from: "base", to: "robinhood", amount: 0.1 });
  assert.ok(Array.isArray(r.routes)); return { routes: r.routes.slice(0, 5).map((x) => `${x.tools.join("+")} ${x.score} ${x.band}${x.redLines.length ? " red:" + x.redLines.map((l) => l.key).join(",") : ""}`), storm: r.storm?.level, receipt: !!r.receipt };
});

await step("agentPassport (wallet)", async () => { const r = await troya.agentPassport(AGENT); assert.ok(r.standing); return { label: r.label, standing: r.standing, summary: r.summary, stamps: r.stamps.length }; });
await step("agentPassport (ERC-8004 id 1)", async () => { const r = await troya.agentPassport({ agentId: 1 }); return { address: r.address, agentId: r.agentId, standing: r.standing, summary: r.summary }; });

await step("weakSpot ($TROYA)", async () => { const r = await troya.weakSpot(TROYA_TOKEN, { waitMs: 20_000 }); assert.equal(r.kind, "coin"); return { heel: r.heel, severity: r.severity, confidence: r.confidence, facts: r.facts.length, partial: r.partial }; });
await step("realDepth ($TROYA)", async () => { const r = await troya.realDepth(TROYA_TOKEN); return { partial: r.partial, depth: r.depth?.headline || r.depth?.status, volume: r.volume?.headline || r.volume?.status, family: r.family?.headline }; });

await step("mcp tools/list", async () => { const r = await troya.mcp("tools/list"); return r.tools.map((t) => t.name); });

// errors come back as TroyaError with a code
await step("bad input is caught before the call", async () => {
  try { await troya.gateCheck("0xnope"); throw new Error("expected BAD_INPUT"); } catch (e) { assert.ok(e instanceof TroyaError); assert.equal(e.code, "BAD_INPUT"); return { code: e.code, message: e.message }; }
});
await step("server 400 becomes TroyaError", async () => {
  try { await troya.bridgeSafety({ from: "ethereum", to: "base" }); throw new Error("expected 400"); } catch (e) { assert.equal(e.code, "BAD_INPUT"); assert.equal(e.status, 400); return { code: e.code, status: e.status, message: e.message }; }
});
await step("timeout becomes TroyaError TIMEOUT", async () => {
  const slow = createTroyaClient({ timeoutMs: 1000, fetch: (_u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  try { await slow.gateInfo(); throw new Error("expected TIMEOUT"); } catch (e) { assert.equal(e.code, "TIMEOUT"); return { code: e.code, message: e.message }; }
});

// the shared tool layer the plugins use
await step("runTool gate_check (shared plugin layer)", async () => { const r = await runTool(troya, "gate_check", { token: TROYA_TOKEN }); assert.ok(r.ok); return r.text; });
console.log(`\n${TOOLS.length} tools: ${TOOLS.map((t) => t.key).join(", ")}`);
console.log(failed ? `\n${failed} step(s) failed` : "\nall steps passed");
process.exitCode = failed ? 1 : 0;
