// V7 F31 Ring Radar: catches rigged Pons launches before you buy.
// The pattern The Block traced on Robinhood Chain (27 Sep 2026): the creator frees up to 32 wallets from the Pons snipe tax
// in the launch itself, a bundler buys for all of them within a few blocks, and the creator plus those wallets end up holding
// most of the supply, then sell into the first real buyers. Ring Radar reads that straight from the chain:
//   · the snipe-tax exemption list, decoded from the launch call (direct factory call, PonsV2LaunchAndBuy, or any router,
//     found by tracing the transaction)
//   · bundle buys in the first seconds: one transaction delivering curve tokens to many wallets, and which contract sent it
//   · how much of the supply the exempt and bundled wallets still hold now
//   · bundler contracts reused across launches, and coins launched with the same name or ticker shortly before (decoys)
// Verdicts are "red", "amber" or "clear", with plain reasons. Alerts only: nothing here trades.
//   GET /api/ring/:token     the radar for one Pons coin (cached 10 min)
//   GET /api/ring            recent results and the bundler contracts seen on more than one launch
import { createRequire } from "node:module";
import { Interface, getAddress, isAddress, formatUnits, zeroPadValue, id as keccakId } from "ethers";
import { rpc, ADDR, CHAINS } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const require = createRequire(import.meta.url);
const fi = new Interface(require("./abi/pons-v2-factory.json").abi);
const li = new Interface(require("./abi/pons-v2-launchandbuy.json").abi);
const LAUNCH_AND_BUY = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const LAUNCH_TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const ERC20 = new Interface(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function name() view returns (string)"]);
const FILE = "ringradar.json";
const WINDOW = 120;                       // blocks after the launch read as "the first seconds" (~12 s at ~0.1 s blocks)
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const pct = (a, b) => (b > 0n ? Number((a * 10_000n) / b) / 100 : 0);
let store = null;
const memo = new Map();                   // token → { at, res }

/* ---------- the launch call and its exemption list ---------- */
function decodeLaunch(to, input) {
  const sel = String(input || "").slice(0, 10);
  const pick = (params, exemptions, extra = {}) => ({ name: params?.name ?? params?.[0] ?? null, symbol: params?.symbol ?? params?.[1] ?? null,
    creatorFeeRecipient: params?.creatorFeeRecipient ?? params?.[5] ?? null, exemptions: [...(exemptions || [])].map(lc), ...extra });
  try {
    if (lc(to) === lc(ADDR.ponsFactory)) {
      if (sel === fi.getFunction("0xa72101af").selector) { const d = fi.decodeFunctionData("0xa72101af", input); return pick(d[0], d[3], { via: "factory" }); }
      if (sel === "0xd6a0eef5") { const d = fi.decodeFunctionData("0xd6a0eef5", input); return pick(d[0], d[4], { via: "factory (for)", deployer: lc(d[3]) }); }
      if (sel === "0xf35abbcf") { const d = fi.decodeFunctionData("0xf35abbcf", input); return pick(d[0], [], { via: "factory" }); }
    }
    if (lc(to) === LAUNCH_AND_BUY && sel === li.getFunction("launchAndBuy").selector) {
      const d = li.decodeFunctionData("launchAndBuy", input);
      return pick(d[0], d[6], { via: "PonsV2LaunchAndBuy", firstBuyRecipient: lc(d[5]) });
    }
  } catch { /* not this shape */ }
  return null;
}
async function traceInner(txHash) {
  const r = await fetch("https://robinhood.drpc.org", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [txHash, { tracer: "callTracer" }] }), signal: AbortSignal.timeout(25_000) }).then((x) => x.json()).catch(() => null);
  let found = null;
  const walk = (n) => { if (found || !n) return; if (lc(n.to) === lc(ADDR.ponsFactory)) { const d = decodeLaunch(n.to, n.input); if (d) { found = { ...d, via: `router ${getAddress(n.from)}` }; return; } } (n.calls || []).forEach(walk); };
  walk(r?.result);
  return found;
}
async function findLaunchTx(token) {
  // the TokenLaunched log carries the coin as topic 1; search back in 30k-block steps (the official RPC's range) up to ~2 days
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const pad = zeroPadValue(token, 32);
  for (let to = head, i = 0; i < 60 && to > 0; i++, to -= 30_000) {
    // wide log ranges only work on the official RPC (the mirrors cap them), as Sentry does
    const logs = await rpc("robinhood", "eth_getLogs", [{ address: ADDR.ponsFactory, topics: [LAUNCH_TOPIC, pad], fromBlock: hex(Math.max(0, to - 29_999)), toBlock: hex(to) }], { timeoutMs: 20_000, only: CHAINS.robinhood.upstreams[0] }).catch(() => []);
    if (logs?.length) return { tx: logs[0].transactionHash, block: Number(BigInt(logs[0].blockNumber)) };
  }
  return null;
}

/* ---------- first seconds: who bought, in what bundles ---------- */
async function call(to, data) { return rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 12_000 }); }
async function balances(token, wallets) {
  const out = new Map();
  for (let i = 0; i < wallets.length; i += 25) {
    await Promise.all(wallets.slice(i, i + 25).map(async (w) => {
      const r = await call(token, ERC20.encodeFunctionData("balanceOf", [w])).catch(() => "0x0");
      out.set(w, BigInt(r && r !== "0x" ? r : 0));
    }));
  }
  return out;
}

/** The radar for one Pons coin. launch = { tx, block } when the caller already has the launch log (Sentry does). */
export async function ringCheck(token, launch = null) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "That is not a token address.");
  const t = lc(token);
  const hit = memo.get(t);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.res;
  const l = launch?.tx ? launch : await findLaunchTx(t);
  if (!l) return { token: getAddress(t), verdict: "unknown", reasons: ["Not a Pons V2 launch found in the last ~2 days, so Ring Radar has nothing to read."], at: Date.now() };
  const tx = await rpc("robinhood", "eth_getTransactionByHash", [l.tx], { timeoutMs: 15_000 });
  let d = decodeLaunch(tx?.to, tx?.input) || (await traceInner(l.tx));
  const deployer = lc(d?.deployer || tx?.from);
  const creator = lc(d?.creatorFeeRecipient);
  const exempt = [...new Set((d?.exemptions || []).filter((w) => w && w !== ZERO))];
  const exemptOthers = exempt.filter((w) => w !== deployer && w !== creator);

  // the curve that sells the coin, then every curve sale in the first seconds
  const lt = await call(ADDR.ponsFactory, fi.encodeFunctionData("getLaunchedToken", [t])).catch(() => null);
  const curve = lt ? lc(fi.decodeFunctionResult("getLaunchedToken", lt)[0].curve) : null;
  const [supplyHex, symHex] = await Promise.all([call(t, ERC20.encodeFunctionData("totalSupply")), call(t, ERC20.encodeFunctionData("symbol")).catch(() => null)]);
  const supply = BigInt(supplyHex);
  const symbol = d?.symbol || (symHex ? ERC20.decodeFunctionResult("symbol", symHex)[0] : null);
  const logs = await rpc("robinhood", "eth_getLogs", [{ address: t, topics: [T_TRANSFER], fromBlock: hex(l.block), toBlock: hex(l.block + WINDOW) }], { timeoutMs: 20_000 }).catch(() => []);
  const byTx = new Map();
  for (const g of logs || []) {
    const from = "0x" + g.topics[1].slice(26), to = "0x" + g.topics[2].slice(26);
    if (curve && from !== curve) continue;                                  // only buys from the curve
    if (to === curve || to === ZERO) continue;
    const e = byTx.get(g.transactionHash) || { tx: g.transactionHash, block: Number(BigInt(g.blockNumber)), to: new Map() };
    e.to.set(to, (e.to.get(to) || 0n) + BigInt(g.data));
    byTx.set(g.transactionHash, e);
  }
  // every curve sale to an exempt wallet in the first seconds, bundled or not
  const exemptSet = new Set(exempt);
  let exemptBought = 0n;
  for (const e of byTx.values()) for (const [w, a] of e.to) if (exemptSet.has(w)) exemptBought += a;
  const bundles = [];
  for (const e of byTx.values()) {
    if (e.to.size < 3) continue;
    const btx = await rpc("robinhood", "eth_getTransactionByHash", [e.tx], { timeoutMs: 12_000 }).catch(() => null);
    bundles.push({ tx: e.tx, block: e.block, contract: lc(btx?.to), sender: lc(btx?.from), wallets: [...e.to.keys()], amount: [...e.to.values()].reduce((a, b) => a + b, 0n) });
  }
  const bundled = [...new Set(bundles.flatMap((b) => b.wallets))];
  const watch = [...new Set([...exempt, ...bundled, deployer, creator].filter(Boolean))].slice(0, 120);
  const bal = await balances(t, watch);
  const sum = (ws) => ws.reduce((a, w) => a + (bal.get(w) || 0n), 0n);
  const groupHold = sum(watch);
  const exemptHold = sum(exempt);
  const bundleBought = bundles.reduce((a, b) => a + b.amount, 0n);

  // memory across launches: bundler contracts and names
  const st = await store.update(FILE, {}, (s) => {
    s.bundlers ||= {}; s.names ||= {};
    for (const b of bundles) if (b.contract && b.contract !== LAUNCH_AND_BUY) {
      const r = (s.bundlers[b.contract] ||= { launches: [], first: Date.now() });
      if (!r.launches.includes(t)) r.launches = [t, ...r.launches].slice(0, 50);
    }
    const key = lc(symbol || "").trim();
    if (key) { s.names[key] = [{ token: t, at: Date.now(), deployer }, ...(s.names[key] || []).filter((x) => x.token !== t)].slice(0, 20); }
    return s;
  });
  const reused = bundles.map((b) => b.contract).filter((c) => (st.bundlers?.[c]?.launches?.length || 0) >= 2);
  const decoys = (st.names?.[lc(symbol || "").trim()] || []).filter((x) => x.token !== t && Date.now() - x.at < 48 * 3600_000);

  const reasons = [];
  const holdPct = pct(groupHold, supply), exemptPct = pct(exemptHold, supply), bundlePct = pct(bundleBought, supply);
  if (exemptOthers.length) reasons.push(`${exemptOthers.length} wallet${exemptOthers.length > 1 ? "s" : ""} besides the dev ${exemptOthers.length > 1 ? "were" : "was"} freed from the snipe tax in the launch itself`);
  const exemptBoughtPct = pct(exemptBought, supply);
  if (exemptBought > 0n) reasons.push(`the exempt wallets bought ${exemptBoughtPct}% of the supply in the first seconds${exemptHold < exemptBought ? ` and have already sold ${pct(exemptBought - exemptHold, exemptBought)}% of it` : ""}`);
  if (bundles.length) reasons.push(`${bundles.length} bundle buy${bundles.length > 1 ? "s" : ""} in the first seconds bought ${bundlePct}% of the supply for ${bundled.length} wallets`);
  if (reused.length) reasons.push(`the bundler contract ${getAddress(reused[0]).slice(0, 10)}… was also used on ${st.bundlers[reused[0]].launches.length - 1} other launch${st.bundlers[reused[0]].launches.length > 2 ? "es" : ""}`);
  if (decoys.length) reasons.push(`${decoys.length} other coin${decoys.length > 1 ? "s" : ""} named $${symbol} launched in the last 48 hours`);
  if (watch.length > 1 && holdPct >= 10) reasons.push(`the dev, the exempt and the bundled wallets still hold ${holdPct}% of the supply`);

  let verdict = "clear";
  // red needs the exemptions to have been used (bought) or the group to sit on the supply; a long list alone is amber
  if ((exemptOthers.length >= 8 && (exemptBoughtPct >= 25 || holdPct >= 40)) || (reused.length && bundlePct >= 20) || (bundlePct >= 40 && holdPct >= 40)) verdict = "red";
  else if (exemptOthers.length >= 4 || exemptBoughtPct >= 10 || bundlePct >= 20 || reused.length || decoys.length || holdPct >= 30) verdict = "amber";
  if (exemptOthers.length >= 4 && exemptBought === 0n) reasons.push("none of the exempt wallets bought in the first seconds");
  if (!reasons.length) reasons.push("No exempt wallets beyond the dev, no bundle buys in the first seconds, no reused bundler and no same-name coins seen.");

  const res = {
    token: getAddress(t), symbol, verdict, reasons, at: Date.now(),
    launch: { tx: l.tx, block: l.block, via: d?.via || "unknown", deployer: deployer ? getAddress(deployer) : null },
    exemptions: { count: exempt.length, besidesDev: exemptOthers.length, wallets: exempt.slice(0, 32).map((w) => getAddress(w)), boughtPct: pct(exemptBought, supply), holdPct: exemptPct },
    bundles: bundles.slice(0, 10).map((b) => ({ tx: b.tx, block: b.block, contract: b.contract ? getAddress(b.contract) : null, wallets: b.wallets.length, pctOfSupply: pct(b.amount, supply) })),
    groupHoldPct: holdPct, reusedBundlers: reused.map((c) => getAddress(c)), decoys: decoys.slice(0, 5).map((x) => ({ token: getAddress(x.token), at: x.at })),
  };
  memo.set(t, { at: Date.now(), res });
  await store.update(FILE, {}, (s) => { s.recent = [{ token: t, symbol, verdict, at: res.at, reasons: reasons.slice(0, 2) }, ...(s.recent || []).filter((x) => x.token !== t)].slice(0, 300); return s; }).catch(() => {});
  if (verdict !== "clear") import("./seal.mjs").then((m) => m.seal("ring", res.token, res, verdict)).catch(() => {});
  return res;
}

/** Ring Radar flags in The Assay's shape, from the cache only (never computes), for the Gate API and the app. */
export function ringFlags(token) {
  const hit = memo.get(lc(token));
  if (!hit || hit.res.verdict === "clear" || hit.res.verdict === "unknown") return [];
  return [{ key: "ring", level: hit.res.verdict === "red" ? "red" : "amber", title: hit.res.verdict === "red" ? "Ring Radar: rigged launch pattern" : "Ring Radar: launch needs a closer look", detail: hit.res.reasons.slice(0, 3).join("; ") }];
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/ring/:token", async ({ params }) => ringCheck(params.token), { weight: 2, perMin: 30 });
  r.get("/api/ring", async () => {
    const s = await store.readJson(FILE, {});
    const reused = Object.entries(s.bundlers || {}).filter(([, v]) => v.launches.length >= 2).sort((a, b) => b[1].launches.length - a[1].launches.length).slice(0, 20)
      .map(([c, v]) => ({ contract: getAddress(c), launches: v.launches.length, latest: v.launches.slice(0, 5).map((x) => getAddress(x)) }));
    return { name: "Troya Ring Radar", recent: (s.recent || []).slice(0, 50), reusedBundlers: reused };
  }, { weight: 1 });
}
