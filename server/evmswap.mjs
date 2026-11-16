// F11: swaps and Troya Gate on Base and Arbitrum. Routes come from KyberSwap (the same router Troya uses for the other
// Robinhood Chain launchpads); the Gate runs the same seven checks it runs on Robinhood Chain: route, price impact, pool
// depth, fees and taxes, the exact swap simulated with eth_call, a test sell from a throwaway address (balance and
// allowance written into the eth_call through a state override) and transfer tax. Robinhood Chain stays in robinhood.mjs;
// its /api/swap/* routes hand any request with ?chain=base|arbitrum to this file. Nothing here signs or sends.
import { AbiCoder, Interface, getAddress, isAddress, formatUnits, parseUnits, keccak256, toBeHex } from "ethers";
import { rpc } from "./robinhood.mjs";
import { kyberRoute, kyberBuild, splitLoss, KYBER_LIVE } from "./kyber.mjs";
import { HttpError } from "./api.mjs";

export const NETS = {
  base: { key: "base", id: 8453, name: "Base", gecko: "base", explorer: "https://basescan.org",
    weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  arbitrum: { key: "arbitrum", id: 42161, name: "Arbitrum One", gecko: "arbitrum", explorer: "https://arbiscan.io",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
};
// a few well-known tokens per chain for the token picker; anything else is found by address or by search
export const POPULAR = {
  base: [
    ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "USD Coin", 6], ["0x4200000000000000000000000000000000000006", "WETH", "Wrapped Ether", 18],
    ["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", "Coinbase Wrapped BTC", 8], ["0x940181a94A35A4569E4529A3CDfB74e38FD98631", "AERO", "Aerodrome", 18],
    ["0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "DAI", "Dai Stablecoin", 18],
  ],
  arbitrum: [
    ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", "USD Coin", 6], ["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "WETH", "Wrapped Ether", 18],
    ["0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", "Tether USD", 6], ["0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB", "Arbitrum", 18],
    ["0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "WBTC", "Wrapped BTC", 8], ["0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", "GMX", "GMX", 18],
  ],
};
// Signing opens per chain after that chain's own real-money test. Both passed on 16 Nov 2026: Arbitrum (0.008 ETH → ARB and
// back: txs 0x5cdd4942…, 0x70f35f6c…, 0xd82d36eb…) and Base (0.001 ETH → AERO and back: 0x8d06b5f7…, 0x5753629f…, 0x5af72722…).
// EVM_LIVE_CHAINS=arbitrum,base sets the list; EVM_LIVE=0 closes all. Quotes and the Gate work either way.
export const EVM_LIVE = process.env.EVM_LIVE !== "0";
const LIVE_CHAINS = new Set(String(process.env.EVM_LIVE_CHAINS || "arbitrum,base").split(",").map((x) => x.trim()).filter(Boolean));
export const evmLive = (chain) => EVM_LIVE && LIVE_CHAINS.has(chain);
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = { address: "native", symbol: "ETH", name: "Ether", decimals: 18 };
const SIM = "0x7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a"; // no key exists; used only inside eth_call
const MAX_SLIP = Math.max(10, Math.min(5000, Number(process.env.MAX_SLIPPAGE_BPS) || 500));
const coder = AbiCoder.defaultAbiCoder();
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"]);
const lower = (s) => String(s || "").toLowerCase();
const qty = (v) => "0x" + BigInt(v || 0).toString(16);
const fmt = (raw, d) => formatUnits(raw, d);
const isNat = (a) => !a || a === "native" || /^eth$/i.test(String(a)) || lower(a) === ZERO;

export const netOf = (chain) => {
  const n = NETS[lower(chain)];
  if (!n) throw new HttpError(400, `Troya swaps on Robinhood Chain, Base and Arbitrum. Unknown chain "${chain}".`);
  return n;
};
const call = (n, to, data, overrides) => rpc(n.key, "eth_call", overrides ? [{ to, data }, "latest", overrides] : [{ to, data }, "latest"]);

/* ---------- token metadata ---------- */
const META = new Map();
export async function evmTokenMeta(chain, address) {
  const n = netOf(chain);
  if (isNat(address)) return NATIVE;
  if (!isAddress(address)) throw new HttpError(400, "That is not a valid 0x token address.");
  const a = getAddress(address), k = `${n.key}:${lower(a)}`;
  if (META.has(k)) return META.get(k);
  const known = POPULAR[n.key].find(([x]) => lower(x) === lower(a));
  let m;
  if (known) m = { address: a, symbol: known[1], name: known[2], decimals: known[3] };
  else {
    const [d, s, nm] = await Promise.all(["decimals", "symbol", "name"].map((f) => call(n, a, erc20.encodeFunctionData(f, [])).catch(() => null)));
    if (!d || d === "0x") throw new HttpError(404, `No token contract at ${a} on ${n.name}.`);
    const str = (x, f) => { try { return erc20.decodeFunctionResult(f, x)[0]; } catch { return ""; } };
    m = { address: a, decimals: Number(erc20.decodeFunctionResult("decimals", d)[0]), symbol: str(s, "symbol") || a.slice(0, 6), name: str(nm, "name") };
  }
  META.set(k, m);
  return m;
}

/* ---------- pool depth from GeckoTerminal (cached) ---------- */
const DEPTH = new Map();
async function depthUsd(n, token) {
  if (isNat(token)) return null;
  const k = `${n.key}:${lower(token)}`, hit = DEPTH.get(k);
  if (hit && Date.now() - hit.t < 5 * 60_000) return hit.v;
  let v = null;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${n.gecko}/tokens/${lower(token)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (r.ok) v = Number((await r.json())?.data?.attributes?.total_reserve_in_usd) || null;
  } catch { /* depth stays unknown */ }
  DEPTH.set(k, { t: Date.now(), v });
  return v;
}
async function ethUsd() { try { const m = await import("./market.mjs"); return await m.getEthUsd(); } catch { return null; } }

/* ---------- quote ---------- */
export async function evmQuote({ chain, tokenIn, tokenOut, amountIn, amountInRaw, slippageBps = 100, _sim = false }) {
  const n = netOf(chain);
  const [mi, mo] = await Promise.all([evmTokenMeta(n.key, tokenIn), evmTokenMeta(n.key, tokenOut)]);
  const tin = mi.address === "native" ? ZERO : mi.address, tout = mo.address === "native" ? ZERO : mo.address;
  if (lower(tin) === lower(tout)) throw new HttpError(400, "Pick two different tokens.");
  let amt;
  try { amt = amountInRaw != null && amountInRaw !== "" ? BigInt(amountInRaw) : parseUnits(String(amountIn ?? ""), mi.decimals); } catch { throw new HttpError(400, "Enter a valid amount."); }
  if (amt <= 0n) throw new HttpError(400, "Enter a positive amount.");
  const slip = Math.min(_sim ? 5000 : MAX_SLIP, Math.max(1, Math.round(Number(slippageBps) || 100)));
  const side = tin === ZERO ? "buy" : tout === ZERO ? "sell" : "swap";
  const coin = side === "buy" ? tout : side === "sell" ? tin : tout;
  const probeAmt = amt / 100n > 0n ? amt / 100n : 1n;
  let full, probe = null;
  try {
    [full, probe] = await Promise.all([
      kyberRoute({ chainId: n.id, tokenIn: tin, tokenOut: tout, amountIn: amt }),
      _sim ? null : kyberRoute({ chainId: n.id, tokenIn: tin, tokenOut: tout, amountIn: probeAmt }).catch(() => null),
    ]);
  } catch (e) { throw new HttpError(404, `No route on ${n.name} for this pair right now (${e.message}).`, { code: "NO_ROUTE" }); }
  // round trips tell fees from impact: a small one loses about twice the fees, a full-size one twice the fees plus
  // twice the impact (one-sided probes are too noisy at small sizes)
  let impact = null, feePct = null;
  if (probe && probe.out > 0n) {
    const [backP, backF] = await Promise.all([
      kyberRoute({ chainId: n.id, tokenIn: tout, tokenOut: tin, amountIn: probe.out }).catch(() => null),
      kyberRoute({ chainId: n.id, tokenIn: tout, tokenOut: tin, amountIn: full.out }).catch(() => null),
    ]);
    const rt = (back, a) => (back && back.out > 0n ? Math.max(0, 1 - Number((back.out * 1000000n) / a) / 1000000) : null);
    ({ feePct, impact } = splitLoss(rt(backP, probeAmt), rt(backF, amt)));
  }
  const [liq, eu] = await Promise.all([depthUsd(n, coin), ethUsd()]);
  const depthEth = liq && eu ? liq / eu / 2 : null;
  const warnings = [];
  if (impact != null && impact > 0.05) warnings.push(`Price impact is ${(impact * 100).toFixed(1)}%. A smaller amount gets a better price.`);
  if (feePct != null && feePct > 5) warnings.push(`This route loses about ${feePct.toFixed(1)}% to fees and taxes.`);
  const minOut = (full.out * BigInt(10000 - slip)) / 10000n;
  const via = full.exchanges.join(" + ");
  const pub = (m) => (m.address === "native" ? NATIVE : { address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals });
  return {
    chain: n.key, chainId: n.id, side, tokenIn: pub(mi), tokenOut: pub(mo), slippageBps: slip, ethUsd: eu,
    amountIn: fmt(amt, mi.decimals), amountInRaw: amt.toString(), amountOut: fmt(full.out, mo.decimals), amountOutRaw: full.out.toString(),
    minOut: fmt(minOut, mo.decimals), minOutRaw: minOut.toString(),
    rate: Number(fmt(full.out, mo.decimals)) / Number(fmt(amt, mi.decimals)),
    priceImpact: impact, feePct, feeNote: feePct != null ? "half of a small round trip" : null, venue: "kyberswap",
    route: { venue: "kyberswap", label: `KyberSwap · ${mi.symbol} → ${mo.symbol} via ${via}`, hops: [] },
    poolLiquidity: { eth: depthEth, usd: liq, note: depthEth != null ? "ETH side of the token's pools (GeckoTerminal reserve / 2)" : "Pool depth not indexed" },
    alternatives: [], warnings, plan: { venue: "kyber", routeSummary: full.routeSummary, router: full.router, chainId: n.id }, quotedAt: Date.now(),
  };
}

/* ---------- build ---------- */
export async function evmBuild({ chain, from, tokenIn, tokenOut, amountIn, amountInRaw, minOutRaw, slippageBps, _quote, _sim = false, _gate = false }) {
  const n = netOf(chain);
  if (!isAddress(from || "")) throw new HttpError(400, "A valid wallet address is required.");
  const who = getAddress(from);
  if (!evmLive(n.key) && !_sim && !_gate) throw new HttpError(403, `Swaps on ${n.name} open after their own real-money test, very soon. Quotes and Troya Gate already work here.`, { code: "EVM_TESTING" });
  const q = _quote?.plan ? _quote : await evmQuote({ chain: n.key, tokenIn, tokenOut, amountIn, amountInRaw, slippageBps });
  let min = BigInt(q.minOutRaw);
  if (minOutRaw != null && minOutRaw !== "") { const r = BigInt(minOutRaw); min = _sim ? (r < 0n ? 0n : r) : (r > min ? r : min); }
  const quoted = BigInt(q.plan.routeSummary.amountOut);
  const slip = quoted > min ? Number(((quoted - min) * 10000n) / quoted) : 1;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const kb = await kyberBuild({ chainId: n.id, routeSummary: q.plan.routeSummary, router: q.plan.router, sender: who, slippageBps: Math.max(1, slip), deadline });
  const amt = BigInt(q.amountInRaw);
  const tin = q.tokenIn.address === "native" ? ZERO : q.tokenIn.address;
  if (tin === ZERO && kb.value !== amt) throw new HttpError(502, "KyberSwap asked for a different ETH amount than quoted, so the swap was not built.");
  const approvals = [];
  if (tin !== ZERO) {
    const allowance = BigInt(await call(n, tin, erc20.encodeFunctionData("allowance", [who, kb.to])).catch(() => "0x0") || "0x0");
    approvals.push({ kind: "erc20", token: tin, spender: kb.to, amount: amt.toString(), allowance: allowance.toString(), needed: allowance < amt,
      label: `Approve ${q.tokenIn.symbol} for KyberSwap`, tx: { to: tin, data: erc20.encodeFunctionData("approve", [kb.to, amt]), value: "0" } });
  }
  return { chain: n.key, chainId: n.id, from: who, to: kb.to, data: kb.data, value: kb.value.toString(), deadline, quote: q, approvals, approval: approvals.find((a) => a.needed) || { needed: false } };
}

/* ---------- simulation + test sell ---------- */
async function simulate(n, tx, overrides) {
  const from = tx.from || SIM;
  const ov = { [from]: { balance: qty(BigInt(tx.value || 0) + 10n ** 20n) }, ...(overrides || {}) };
  try { return { ok: true, returnData: await rpc(n.key, "eth_call", [{ from, to: tx.to, data: tx.data, value: qty(tx.value), gas: "0x1c9c380" }, "latest", ov]) }; }
  catch (e) { return { ok: false, error: e.message || "reverted" }; }
}
// find the storage slot of a mapping(address => uint) by writing candidates into an eth_call and reading balanceOf back
// (Solidity layout keccak(key . slot) and Vyper layout keccak(slot . key); slots 0-60, OpenZeppelin v5 namespaced, a few gapped ones)
const SLOTS = new Map();
// OpenZeppelin v5 ERC20Upgradeable keeps balances at keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~0xff
const OZ5 = (BigInt(keccak256(coder.encode(["uint256"], [BigInt(keccak256(new TextEncoder().encode("openzeppelin.storage.ERC20"))) - 1n]))) & ~0xffn);
const SLOT_CANDIDATES = [...Array.from({ length: 61 }, (_, i) => BigInt(i)), OZ5, OZ5 + 1n, 101n, 151n, 201n];
async function mappingSlot(n, token, readData, keyFor, label) {
  const k = `${n.key}:${lower(token)}:${label}`;
  if (SLOTS.has(k)) return SLOTS.get(k);
  const probe = 0x5eedn * 10n ** 20n;
  for (const i of SLOT_CANDIDATES) {
    for (const layout of ["sol", "vy"]) {
      const slot = keyFor(i, layout);
      try {
        const r = await call(n, token, readData, { [token]: { stateDiff: { [slot]: toBeHex(probe, 32) } } });
        if (r && r !== "0x" && BigInt(r) === probe) { SLOTS.set(k, { i, layout }); return { i, layout }; }
      } catch { /* next */ }
    }
  }
  SLOTS.set(k, null);
  return null;
}
const pad = (a) => coder.encode(["address"], [a]);
const balSlot = (holder) => (i, layout) => keccak256(layout === "sol" ? coder.encode(["address", "uint256"], [holder, i]) : coder.encode(["uint256", "address"], [i, holder]));
const allowSlot = (owner, spender) => (i, layout) => {
  const inner = keccak256(layout === "sol" ? coder.encode(["address", "uint256"], [owner, i]) : coder.encode(["uint256", "address"], [i, owner]));
  return keccak256(layout === "sol" ? coder.encode(["address", "bytes32"], [spender, inner]) : coder.encode(["bytes32", "address"], [inner, spender]));
};
export async function evmSellCheck({ chain, token, amountRaw }) {
  const n = netOf(chain);
  const t = getAddress(token);
  const amt = BigInt(amountRaw);
  const q = await evmQuote({ chain: n.key, tokenIn: t, tokenOut: "ETH", amountInRaw: amt.toString(), slippageBps: 5000, _sim: true });
  const b = await evmBuild({ chain: n.key, from: SIM, _quote: q, minOutRaw: "0", _sim: true });
  const bs = await mappingSlot(n, t, erc20.encodeFunctionData("balanceOf", [SIM]), balSlot(SIM), "bal");
  if (!bs) return { ok: false, unknown: true, quote: q, reason: "Could not locate the token's balance storage, so the test sell was skipped." };
  const diff = { [balSlot(SIM)(bs.i, bs.layout)]: toBeHex(amt * 2n, 32) };
  const spender = b.to;
  const as = await mappingSlot(n, t, erc20.encodeFunctionData("allowance", [SIM, spender]), allowSlot(SIM, spender), `allow:${lower(spender)}`);
  if (!as) return { ok: false, unknown: true, quote: q, reason: "Could not locate the token's allowance storage, so the test sell was skipped." };
  diff[allowSlot(SIM, spender)(as.i, as.layout)] = toBeHex(2n ** 255n, 32);
  const sim = await simulate(n, { from: SIM, to: b.to, data: b.data, value: "0" }, { [t]: { stateDiff: diff } });
  if (!sim.ok) return { ok: false, sellable: false, quote: q, reason: `The test sell reverted: ${sim.error}` };
  let actual = null;
  try { actual = BigInt(coder.decode(["uint256", "uint256"], sim.returnData)[0]); } catch {}
  const quoted = BigInt(q.amountOutRaw);
  const taxPct = actual != null && quoted > 0n ? Math.max(0, 1 - Number(actual) / Number(quoted)) * 100 : null;
  return { ok: true, sellable: true, quote: q, actualOut: actual != null ? fmt(actual, 18) : null, outSymbol: "ETH", transferTaxPct: taxPct };
}

/* ---------- Troya Gate ---------- */
export async function evmGate({ chain, tokenIn, tokenOut, amountIn, amountInRaw, from, slippageBps = 100 }) {
  const n = netOf(chain);
  const checks = [];
  const add = (key, status, label, detail) => checks.push({ key, status, label, detail });
  let q;
  try { q = await evmQuote({ chain: n.key, tokenIn, tokenOut, amountIn, amountInRaw, slippageBps }); add("route", "pass", "Route", q.route.label); }
  catch (e) { add("route", "fail", "Route", e.message); return { pass: false, checks, chain: n.key }; }
  const imp = q.priceImpact;
  add("impact", imp == null ? "skip" : imp > 0.15 ? "fail" : imp > 0.05 ? "warn" : "pass", "Price impact", imp == null ? "Not measurable" : `${(imp * 100).toFixed(2)}%`);
  const d = q.poolLiquidity || {};
  if (d.eth != null) add("depth", d.eth < 0.05 ? "fail" : d.eth < 0.5 ? "warn" : "pass", "Pool depth", `${d.eth < 1 ? d.eth.toFixed(3) : d.eth.toFixed(2)} ETH`);
  else add("depth", "skip", "Pool depth", d.note || "Not indexed");
  if (q.feePct != null) add("fee", q.feePct > 10 ? "fail" : q.feePct > 5 ? "warn" : "pass", "Fees and taxes", `${q.feePct.toFixed(2)}% (${q.feeNote})`);
  let tx = null;
  try {
    tx = await evmBuild({ chain: n.key, from: from && isAddress(from) ? from : SIM, _quote: q, _gate: true });
    if (!tx.approvals.some((a) => a.needed)) {
      const sim = await simulate(n, { from: tx.from, to: tx.to, data: tx.data, value: tx.value });
      add("sim", sim.ok ? "pass" : "fail", "Transaction simulation", sim.ok ? "The exact swap succeeds against the current pools" : sim.error);
    } else add("sim", "skip", "Transaction simulation", "Runs after the approval; the test sell below covers the route");
  } catch (e) { add("sim", "fail", "Transaction simulation", e.message); }
  const coin = q.side === "buy" ? q.tokenOut.address : q.side === "sell" ? q.tokenIn.address : null;
  if (coin && coin !== "native" && !POPULAR[n.key].some(([a]) => lower(a) === lower(coin) && /^(USDC|USDT|DAI|WETH)$/.test(POPULAR[n.key].find(([x]) => lower(x) === lower(coin))[1]))) {
    try {
      const sc = await evmSellCheck({ chain: n.key, token: coin, amountRaw: q.side === "buy" ? q.amountOutRaw : q.amountInRaw });
      if (sc.unknown) { add("sell", "skip", "Test sell", sc.reason); add("tax", "skip", "Transfer tax", "Not measured"); }
      else if (!sc.sellable) { add("sell", "fail", "Test sell", sc.reason); add("tax", "skip", "Transfer tax", "Not measured"); }
      else {
        add("sell", "pass", "Test sell", sc.actualOut != null ? `Selling back returns ${Number(sc.actualOut).toPrecision(5)} ETH` : "Selling back succeeds");
        const tax = sc.transferTaxPct;
        add("tax", tax == null ? "skip" : tax > 10 ? "fail" : tax > 0.5 ? "warn" : "pass", "Transfer tax", tax == null ? "Not measured on this route" : tax > 0.5 ? `About ${tax.toFixed(1)}% is lost on transfer` : "None detected");
      }
    } catch (e) { add("sell", "warn", "Test sell", e.message); add("tax", "skip", "Transfer tax", "Not measured"); }
  } else if (coin && coin !== "native") { add("sell", "skip", "Test sell", "A major token (stablecoin or WETH): no test sell needed"); }
  if (!KYBER_LIVE || !evmLive(n.key)) tx = null;
  return { pass: !checks.some((c) => c.status === "fail"), checks, quote: q, tx, chain: n.key, checkedAt: Date.now() };
}

/* ---------- token search for the picker (GeckoTerminal, cached) ---------- */
const SEARCH = new Map();
export async function evmSearch({ chain, q = "" }) {
  const n = netOf(chain);
  const query = String(q).trim().slice(0, 40);
  const popular = POPULAR[n.key].map(([address, symbol, name, decimals]) => ({ address, symbol, name, decimals }));
  if (!query) return { chain: n.key, tokens: popular };
  const k = `${n.key}:${lower(query)}`, hit = SEARCH.get(k);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.v;
  let tokens = [];
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?${new URLSearchParams({ query, network: n.gecko, include: "base_token" })}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      const inc = new Map((d.included || []).map((x) => [x.id, x.attributes]));
      const seen = new Set();
      for (const p of d.data || []) {
        const id = p.relationships?.base_token?.data?.id || "";
        const a = id.split("_")[1], t = inc.get(id);
        if (!a || !t || seen.has(lower(a))) continue;
        seen.add(lower(a));
        tokens.push({ address: getAddress(a), symbol: t.symbol, name: t.name, decimals: t.decimals ?? 18, image: t.image_url && /^https:/.test(t.image_url) ? t.image_url : null, liquidityUsd: Number(p.attributes?.reserve_in_usd) || null });
        if (tokens.length >= 20) break;
      }
    }
  } catch { /* fall back to the popular list */ }
  const ql = lower(query);
  const v = { chain: n.key, tokens: [...popular.filter((t) => lower(t.symbol).includes(ql) || lower(t.name).includes(ql)), ...tokens.filter((t) => !popular.some((p) => lower(p.address) === lower(t.address)))] };
  SEARCH.set(k, { t: Date.now(), v });
  return v;
}
