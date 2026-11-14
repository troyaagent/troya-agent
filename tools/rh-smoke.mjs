// Live read-only checks of the Robinhood Chain engine (quotes, gate, health, launch build). Sends nothing.
// node tools/rh-smoke.mjs
import * as rh from "../server/robinhood.mjs";

const ok = (label, v) => console.log("✓", label, v);
const bad = (label, e) => console.log("✗", label, e?.message || e);
const t0 = Date.now();
await rh.register({ get() {}, post() {}, del() {} }, { dataDir: (await import("node:path")).join((await import("node:os")).tmpdir(), "troya-rh-smoke") }).catch(() => {});

// seed two v4 pools the market board would normally report
rh.noteV4([
  { id: "0x54c3b3d4a5062f2d24eaf267121cf88513386b84ee495b9c83f33b3ba98eadb7", a: "0x807202807b70a154c4d78b070e5d4c285bf65df3", b: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", liq: 45e6 },
  { id: "0xa85f02f8e836e92912c8e0588f60b8868eedc154e558c10a1966269e5122b77c", a: "0x0000000000000000000000000000000000000000", b: "0x0000000000000000000000000000000000000000", liq: 1.8e6 },
]);
const show = (q) => `${q.amountIn} ${q.tokenIn.symbol} → ${Number(q.amountOut).toPrecision(6)} ${q.tokenOut.symbol} via ${q.route.label} · impact ${q.priceImpact == null ? "?" : (q.priceImpact * 100).toFixed(2) + "%"} · fee ${q.feePct?.toFixed(2)}%`;
const cases = [
  ["ETH → KEYFO (Pons curve)", { tokenIn: "ETH", tokenOut: "0xa1b656c68b6b664957dc515f0343c10d9822af8d", amountIn: "0.01" }],
  ["ETH → PONS (v4 via USDG)", { tokenIn: "ETH", tokenOut: "0x807202807b70a154c4d78b070e5d4c285bf65df3", amountIn: "0.01" }],
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
  const b = await rh.buildSwapTx({ from: FROM, tokenIn: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", tokenOut: "0x807202807b70a154c4d78b070e5d4c285bf65df3", amountIn: "5", slippageBps: 100 });
  ok("build USDG → PONS", `${b.quote.route.label} approvals ${b.approvals.map((a) => `${a.kind}:${a.needed}`).join(",")}`);
} catch (e) { bad("build USDG → PONS", e); }
for (const [label, args] of [["gate ETH → KEYFO", { tokenIn: "ETH", tokenOut: "0xa1b656c68b6b664957dc515f0343c10d9822af8d", amountIn: "0.005" }], ["gate ETH → PONS", { tokenIn: "ETH", tokenOut: "0x807202807b70a154c4d78b070e5d4c285bf65df3", amountIn: "0.005" }]]) {
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
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
