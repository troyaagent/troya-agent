// Live read-only checks of the Robinhood Chain engine (quotes, gate, health, launch build). Sends nothing.
// node tools/rh-smoke.mjs
import * as rh from "../server/robinhood.mjs";

const ok = (label, v) => console.log("✓", label, v);
let fails = 0;
const bad = (label, e) => { fails++; console.log("✗", label, e?.message || e); };
const t0 = Date.now();
await rh.register({ get() {}, post() {}, del() {} }, { dataDir: (await import("node:path")).join((await import("node:os")).tmpdir(), "troya-rh-smoke") }).catch(() => {});

// seed the live $TROYA ETH pool (Uniswap v4, 1% fee, no hook) the market board would normally report
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
rh.noteV4([{ id: "0x1fcf92a1481e9f4f1f66ad68dfb855df5bfe6c6144009d1bf5e2615f3bcc205e", a: "0x0000000000000000000000000000000000000000", b: TROYA, liq: 1e4 }]);
const show = (q) => `${q.amountIn} ${q.tokenIn.symbol} → ${Number(q.amountOut).toPrecision(6)} ${q.tokenOut.symbol} via ${q.route.label} · impact ${q.priceImpact == null ? "?" : (q.priceImpact * 100).toFixed(2) + "%"} · fee ${q.feePct?.toFixed(2)}%`;
const cases = [
  ["ETH → KEYFO (Pons curve)", { tokenIn: "ETH", tokenOut: "0xa1b656c68b6b664957dc515f0343c10d9822af8d", amountIn: "0.01" }],
  ["ETH → TROYA (Pons curve or Uniswap v4)", { tokenIn: "ETH", tokenOut: TROYA, amountIn: "0.01" }],
  ["TROYA → ETH", { tokenIn: TROYA, tokenOut: "ETH", amountIn: "100000" }],
  ["ETH → NVDA (stock)", { tokenIn: "ETH", tokenOut: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", amountIn: "0.01" }],
  ["ETH → USDG", { tokenIn: "ETH", tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amountIn: "0.01" }],
  ["ETH → WETH (wrap)", { tokenIn: "ETH", tokenOut: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", amountIn: "0.01" }],
];
for (const [label, args] of cases) {
  try { ok(label, show(await rh.quoteSwap({ ...args, slippageBps: 100 }))); } catch (e) { bad(label, e); }
}
const FROM = "0x1111111111111111111111111111111111111111";
try {
  const b = await rh.buildSwapTx({ from: FROM, tokenIn: "0xa1b656c68b6b664957dc515f0343c10d9822af8d", tokenOut: "ETH", amountIn: "1000", slippageBps: 300 });
  ok("build sell KEYFO", `to ${b.to} approvals ${b.approvals.map((a) => `${a.kind}:${a.needed}`).join(",")}`);
} catch (e) { bad("build sell KEYFO", e); }
try {
  const b = await rh.buildSwapTx({ from: FROM, tokenIn: "ETH", tokenOut: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", amountIn: "0.01", slippageBps: 100 });
  ok("build ETH → NVDA", `${b.quote.route.label} approvals ${b.approvals.length}`);
} catch (e) { bad("build ETH → NVDA", e); }
// server-side limits: a client can't ask for more than the cap, or for minOut=0
try {
  const q = await rh.quoteSwap({ tokenIn: "ETH", tokenOut: TROYA, amountIn: "0.01", slippageBps: 5000 });
  if (q.slippageBps !== rh.MAX_SLIPPAGE_BPS) throw new Error(`slippage ${q.slippageBps} bps passed through, cap is ${rh.MAX_SLIPPAGE_BPS}`);
  const b = await rh.buildSwapTx({ from: FROM, tokenIn: "ETH", tokenOut: TROYA, amountIn: "0.01", slippageBps: 5000, minOutRaw: "0" });
  if (!(BigInt(b.quote.minOutRaw) > 0n)) throw new Error("minOut fell to 0");
  ok("limits", `slippage capped at ${q.slippageBps} bps, minOut kept at ${b.quote.minOut} ${b.quote.tokenOut.symbol}`);
} catch (e) { bad("limits", e); }
for (const [label, args] of [["gate ETH → KEYFO", { tokenIn: "ETH", tokenOut: "0xa1b656c68b6b664957dc515f0343c10d9822af8d", amountIn: "0.005" }], ["gate ETH → TROYA", { tokenIn: "ETH", tokenOut: TROYA, amountIn: "0.005" }]]) {
  try { const g = await rh.gateCheck({ ...args, from: FROM }); ok(label, `pass=${g.pass} ` + g.checks.map((c) => `${c.key}:${c.status}(${String(c.detail).slice(0, 60)})`).join(" | ")); } catch (e) { bad(label, e); }
}
try { const h = await rh.tokenHealth("0xa1b656c68b6b664957dc515f0343c10d9822af8d"); ok("health KEYFO", `${h.kind} risk=${h.risk} ${h.flags.map((f) => f.key).join(",")}`); } catch (e) { bad("health", e); }
try { const p = await rh.ponsProfile("0xa1b656c68b6b664957dc515f0343c10d9822af8d"); ok("pons profile", JSON.stringify(p).slice(0, 160)); } catch (e) { bad("profile", e); }
try { const m = await rh.launchMenu(); ok("launch menu", `fee ${m.launchFeeEth} ETH, configs ${m.configs.length}, maxTax ${m.maxCreatorTaxBps}`); } catch (e) { bad("menu", e); }
try {
  const l = await rh.buildLaunchTx({ creator: FROM, name: "Troya Smoke", symbol: "TSMK", description: "test only, never sent", creatorTaxBps: 0 });
  ok("launch build+sim", `sim ok=${l.simulation.ok} ${l.simulation.error || ""} token=${l.predicted?.token || "-"}`);
} catch (e) { bad("launch", e); }
try { const b = await rh.getBalances("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"); ok("balances", b.balances.map((x) => `${x.symbol} ${Number(x.amount).toFixed(4)}`).join(", ")); } catch (e) { bad("balances", e); }
try { const q = await rh.bridgeQuote({ fromChain: 42161, address: FROM, amountWei: "10000000000000000" }); ok("lifi Arbitrum → Robinhood", `${q.tool} → ${Number(q.toAmount) / 1e18} ETH in ~${q.executionSec}s fee $${q.feeUsd.toFixed(2)}`); } catch (e) { bad("lifi", e); }
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${fails ? fails + " failed" : "all passed"}`);
if (fails) process.exitCode = 1;
