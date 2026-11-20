// F12: Solana swaps through Jupiter (pump.fun and every other Solana launchpad and DEX Jupiter routes), with a Solana
// Troya Gate before anyone signs: route, price impact, liquidity, fees (from round trips), who can still mint or freeze the
// coin, Token-2022 traps (transfer fee, permanent delegate, non-transferable), the exact swap simulated from the user's own
// address, and a sell route back to SOL. The transaction is built by Jupiter for the user's own address and signed in the
// user's own wallet (Phantom, Solflare, Backpack); nothing here signs or sends.
//   SOLANA_RPCS=comma list (default: the public mainnet RPC, then publicnode) · JUP_BASE (default https://lite-api.jup.ag)
//   SOLANA_LIVE=0 stops building swaps for signing (quotes and the Gate keep working)
import { HttpError } from "./api.mjs";
import { splitLoss } from "./kyber.mjs";

const JUP = process.env.JUP_BASE || "https://lite-api.jup.ag";
const RPCS = String(process.env.SOLANA_RPCS || "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);
export const SOL_MINT = "So11111111111111111111111111111111111111112";
// Solana swaps passed their real-money test on 16 Nov 2026 (0.01 SOL → 311,929 BONK through Jupiter and all of it back:
// signatures 4EeusuHe…, 2AaWM94S…). SOLANA_LIVE=0 closes signing again; quotes and the Gate keep working.
export const SOLANA_LIVE = process.env.SOLANA_LIVE !== "0";
const NATIVE = { address: "native", symbol: "SOL", name: "Solana", decimals: 9 };
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SLIP = Math.max(10, Math.min(5000, Number(process.env.MAX_SLIPPAGE_BPS) || 500));
const isNat = (a) => !a || a === "native" || /^sol$/i.test(String(a)) || a === SOL_MINT;
const mintOf = (a) => (isNat(a) ? SOL_MINT : a);
const STABLE = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]); // USDC, USDT
const fmt = (raw, d) => { const s = BigInt(raw).toString().padStart(d + 1, "0"); const w = s.slice(0, -d) || "0", f = s.slice(-d).replace(/0+$/, ""); return d ? (f ? `${w}.${f}` : w) : s; };
function toRaw(v, d) {
  const s = String(v ?? "").trim();
  if (!/^\d*\.?\d+$/.test(s)) throw new HttpError(400, "Enter a valid amount.");
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0");
}

/* ---------- RPC + Jupiter, one call at a time with a short gap (both rate-limit bursts) ---------- */
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) { last = new Error(j.error.message || "Solana RPC error"); if (/rate|429|too many/i.test(last.message)) continue; throw last; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error("Solana RPC unavailable");
}
let jchain = Promise.resolve(), jlast = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jslot() { const t = jchain.then(async () => { const w = jlast + 350 - Date.now(); if (w > 0) await sleep(w); jlast = Date.now(); }); jchain = t.catch(() => {}); return t; }
async function jup(path, { method = "GET", body } = {}) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    await jslot();
    const r = await fetch(`${JUP}${path}`, { method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { lastErr = new Error("Jupiter is busy, try again in a moment"); jlast = Date.now() + 1000 * 2 ** i; await sleep(1000 * 2 ** i); continue; }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(j?.error || j?.message || `Jupiter returned ${r.status}`);
    return j;
  }
  throw lastErr;
}
const QCACHE = new Map();
async function jquote(inMint, outMint, amount, slippageBps = 100) {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: BigInt(amount).toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  const k = qs.toString(), hit = QCACHE.get(k);
  if (hit && Date.now() - hit.t < 15000) return hit.v;
  const q = await jup(`/swap/v1/quote?${qs}`);
  if (!q?.outAmount || BigInt(q.outAmount) <= 0n) throw new Error(q?.error || "no route");
  QCACHE.set(k, { t: Date.now(), v: q });
  if (QCACHE.size > 300) for (const [x, v] of QCACHE) if (Date.now() - v.t > 15000) QCACHE.delete(x);
  return q;
}

/* ---------- token data ---------- */
const META = new Map();
export async function solTokenMeta(address) {
  if (isNat(address)) return NATIVE;
  if (!MINT_RE.test(String(address || ""))) throw new HttpError(400, "That is not a valid Solana token address.");
  const hit = META.get(address);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.v;
  let t = null;
  try { const list = await jup(`/tokens/v2/search?query=${encodeURIComponent(address)}`); t = (Array.isArray(list) ? list : []).find((x) => x.id === address) || null; } catch {}
  let v;
  if (t) v = { address, symbol: t.symbol, name: t.name, decimals: t.decimals, image: /^https:/.test(t.icon || "") ? t.icon : null, verified: !!t.isVerified, launchpad: t.launchpad || null,
    liquidityUsd: Number(t.liquidity) || null, mintAuthority: t.mintAuthority || null, freezeAuthority: t.freezeAuthority || null, tokenProgram: t.tokenProgram || null };
  else {
    const acc = await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }]).catch(() => null);
    const info = acc?.value?.data?.parsed?.info;
    if (!info || info.decimals == null) throw new HttpError(404, "No token mint at that address on Solana.");
    v = { address, symbol: address.slice(0, 4), name: "", decimals: info.decimals, image: null, verified: false, launchpad: null, liquidityUsd: null,
      mintAuthority: info.mintAuthority || null, freezeAuthority: info.freezeAuthority || null, tokenProgram: acc.value.owner };
  }
  META.set(address, { t: Date.now(), v });
  return v;
}
// Token-2022 extensions that can hurt a holder
async function mintTraps(address) {
  const acc = await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }]).catch(() => null);
  const ext = acc?.value?.data?.parsed?.info?.extensions || [];
  const out = { transferFeeBps: 0, permanentDelegate: null, nonTransferable: false, token2022: acc?.value?.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };
  for (const e of ext) {
    if (e.extension === "transferFeeConfig") out.transferFeeBps = Number(e.state?.newerTransferFee?.transferFeeBasisPoints || 0);
    if (e.extension === "permanentDelegate") out.permanentDelegate = e.state?.delegate || "set";
    if (e.extension === "nonTransferable") out.nonTransferable = true;
  }
  return out;
}

/* ---------- quote ---------- */
const pub = (m) => (m.address === "native" ? NATIVE : { address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals, image: m.image || null });
export async function solQuote({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps = 100, _sim = false }) {
  const [mi, mo] = await Promise.all([solTokenMeta(tokenIn), solTokenMeta(tokenOut)]);
  const inMint = mintOf(mi.address === "native" ? null : mi.address), outMint = mintOf(mo.address === "native" ? null : mo.address);
  if (inMint === outMint) throw new HttpError(400, "Pick two different tokens.");
  if (amountInRaw != null && amountInRaw !== "" && !/^\d+$/.test(String(amountInRaw))) throw new HttpError(400, "Enter a valid amount.");
  const amt = amountInRaw != null && amountInRaw !== "" ? BigInt(amountInRaw) : toRaw(amountIn, mi.decimals);
  if (amt <= 0n) throw new HttpError(400, "Enter a positive amount.");
  const slip = Math.min(_sim ? 5000 : MAX_SLIP, Math.max(1, Math.round(Number(slippageBps) || 100)));
  const side = inMint === SOL_MINT ? "buy" : outMint === SOL_MINT ? "sell" : "swap";
  let full;
  try { full = await jquote(inMint, outMint, amt, slip); } catch (e) { throw new HttpError(404, `No route on Solana for this pair right now (${e.message}).`, { code: "NO_ROUTE" }); }
  const out = BigInt(full.outAmount);
  let feePct = null, impact = Number(full.priceImpactPct) || 0;
  if (!_sim) {
    const probeAmt = amt / 100n > 0n ? amt / 100n : 1n;
    const probe = await jquote(inMint, outMint, probeAmt, slip).catch(() => null);
    const [backP, backF] = await Promise.all([
      probe ? jquote(outMint, inMint, BigInt(probe.outAmount), slip).catch(() => null) : null,
      jquote(outMint, inMint, out, slip).catch(() => null),
    ]);
    const rt = (b, a) => (b ? Math.max(0, 1 - Number((BigInt(b.outAmount) * 1000000n) / a) / 1000000) : null);
    const s = splitLoss(rt(backP, probeAmt), rt(backF, amt));
    feePct = s.feePct;
    if (s.impact != null) impact = Math.max(impact, s.impact);
  }
  const labels = [...new Set((full.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))];
  const minOut = BigInt(full.otherAmountThreshold || 0) || (out * BigInt(10000 - slip)) / 10000n;
  const coin = side === "buy" ? mo : side === "sell" ? mi : mo;
  const warnings = [];
  if (impact > 0.05) warnings.push(`Price impact is ${(impact * 100).toFixed(1)}%. A smaller amount gets a better price.`);
  if (feePct != null && feePct > 5) warnings.push(`This route loses about ${feePct.toFixed(1)}% to fees and taxes.`);
  return {
    chain: "solana", side, tokenIn: pub(mi), tokenOut: pub(mo), slippageBps: slip,
    amountIn: fmt(amt, mi.decimals), amountInRaw: amt.toString(), amountOut: fmt(out, mo.decimals), amountOutRaw: out.toString(),
    minOut: fmt(minOut, mo.decimals), minOutRaw: minOut.toString(),
    rate: Number(fmt(out, mo.decimals)) / Number(fmt(amt, mi.decimals)),
    priceImpact: impact, feePct, feeNote: feePct != null ? "half of a small round trip" : null, venue: "jupiter",
    route: { venue: "jupiter", label: `Jupiter · ${mi.symbol} → ${mo.symbol} via ${labels.join(" + ") || "a direct pool"}`, hops: [] },
    poolLiquidity: { usd: coin.liquidityUsd ?? null, eth: null, note: coin.liquidityUsd != null ? "Liquidity across the coin's pools (Jupiter)" : "Liquidity not indexed" },
    launchpad: coin.launchpad || null, alternatives: [], warnings, plan: { venue: "jupiter", quoteResponse: full }, quotedAt: Date.now(),
  };
}

/* ---------- build (unsigned transaction for the user's wallet) ---------- */
export async function solBuild({ from, tokenIn, tokenOut, amountIn, amountInRaw, slippageBps, _quote, _gate = false }) {
  if (!MINT_RE.test(String(from || ""))) throw new HttpError(400, "Connect a Solana wallet first.");
  if (!SOLANA_LIVE && !_gate) throw new HttpError(403, "Swaps on Solana open after their real-money test, very soon. Quotes and Troya Gate already work here.", { code: "SOLANA_TESTING" });
  const q = _quote?.plan ? _quote : await solQuote({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps });
  const r = await jup("/swap/v1/swap", { method: "POST", body: {
    quoteResponse: q.plan.quoteResponse, userPublicKey: from, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" } },
  } });
  if (!r?.swapTransaction) throw new HttpError(502, r?.error || "Jupiter did not return a transaction.");
  return { chain: "solana", from, tx: r.swapTransaction, lastValidBlockHeight: r.lastValidBlockHeight, quote: q };
}
async function simulate(txBase64) {
  try {
    const r = await rpc("simulateTransaction", [txBase64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }]);
    if (r?.value?.err) {
      const logs = (r.value.logs || []).join(" ");
      return { ok: false, error: /insufficient (funds|lamports)/i.test(logs) || /InsufficientFunds/.test(JSON.stringify(r.value.err)) ? "funds" : JSON.stringify(r.value.err).slice(0, 160) };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ---------- Troya Gate on Solana ---------- */
export async function solGate({ tokenIn, tokenOut, amountIn, amountInRaw, from, slippageBps = 100 }) {
  const checks = [];
  const add = (key, status, label, detail) => checks.push({ key, status, label, detail });
  let q;
  try { q = await solQuote({ tokenIn, tokenOut, amountIn, amountInRaw, slippageBps }); add("route", "pass", "Route", q.route.label + (q.launchpad ? ` (${q.launchpad} coin)` : "")); }
  catch (e) { add("route", "fail", "Route", e.message); return { pass: false, checks, chain: "solana" }; }
  const imp = q.priceImpact;
  add("impact", imp == null ? "skip" : imp > 0.15 ? "fail" : imp > 0.05 ? "warn" : "pass", "Price impact", imp == null ? "Not measurable" : `${(imp * 100).toFixed(2)}%`);
  const liq = q.poolLiquidity?.usd;
  add("depth", liq == null ? "skip" : liq < 5000 ? "fail" : liq < 50000 ? "warn" : "pass", "Liquidity", liq == null ? "Not indexed" : `$${Math.round(liq).toLocaleString("en-US")} across its pools`);
  if (q.feePct != null) add("fee", q.feePct > 10 ? "fail" : q.feePct > 5 ? "warn" : "pass", "Fees and taxes", `${q.feePct.toFixed(2)}% (${q.feeNote})`);
  // the coin's own powers: mint and freeze authority, Token-2022 extensions
  const coin = q.side === "buy" ? q.tokenOut : q.side === "sell" ? q.tokenIn : q.tokenOut;
  if (coin.address !== "native" && !STABLE.has(coin.address)) {
    const m = await solTokenMeta(coin.address).catch(() => null);
    const traps = await mintTraps(coin.address).catch(() => null);
    if (m) {
      add("freeze", m.freezeAuthority ? (m.verified ? "warn" : "fail") : "pass", "Freeze authority", m.freezeAuthority ? "The issuer can freeze holders' tokens, so a sell can be blocked" : "None: nobody can freeze your tokens");
      add("mint", m.mintAuthority ? "warn" : "pass", "Mint authority", m.mintAuthority ? "The issuer can still mint more" : "Revoked: the supply is fixed");
    }
    if (traps) {
      if (traps.permanentDelegate) add("delegate", m?.verified ? "warn" : "fail", "Permanent delegate", "Token-2022: a delegate can move tokens out of any wallet");
      if (traps.nonTransferable) add("transfer", "fail", "Transferable", "Token-2022: this token cannot be transferred or sold");
      add("tax", traps.transferFeeBps > 1000 ? "fail" : traps.transferFeeBps > 50 ? "warn" : "pass", "Transfer tax", traps.transferFeeBps ? `${(traps.transferFeeBps / 100).toFixed(2)}% on every transfer (Token-2022)` : "None");
    }
  }
  // the exact swap, simulated from the user's own address
  let built = null;
  if (from && MINT_RE.test(from)) {
    try {
      built = await solBuild({ from, _quote: q, _gate: true });
      const sim = await simulate(built.tx);
      add("sim", sim.ok ? "pass" : sim.error === "funds" ? "skip" : "fail", "Transaction simulation", sim.ok ? "The exact swap succeeds from your address right now" : sim.error === "funds" ? "Your wallet needs more SOL to run it (amount plus about 0.003 SOL for fees)" : `It fails right now: ${sim.error}`);
    } catch (e) { add("sim", "warn", "Transaction simulation", e.message); }
  } else add("sim", "skip", "Transaction simulation", "Connect a Solana wallet to simulate the exact swap from your address");
  // selling back: a route back to SOL must exist for what the buy returns
  if (q.side === "buy" && coin.address !== "native") {
    try {
      const back = await jquote(coin.address, SOL_MINT, BigInt(q.amountOutRaw), 5000);
      add("sell", "pass", "Sell route", `Selling it back returns about ${Number(fmt(BigInt(back.outAmount), 9)).toPrecision(5)} SOL`);
    } catch { add("sell", "fail", "Sell route", "No route back to SOL for this coin right now"); }
  }
  return { pass: !checks.some((c) => c.status === "fail"), checks, quote: q, tx: SOLANA_LIVE && built ? built.tx : null, chain: "solana", checkedAt: Date.now() };
}

/* ---------- balances, status, search ---------- */
export async function solBalance({ owner, mint }) {
  if (!MINT_RE.test(String(owner || ""))) throw new HttpError(400, "Not a Solana address.");
  if (isNat(mint)) { const r = await rpc("getBalance", [owner]); return { raw: String(r?.value ?? 0), decimals: 9 }; }
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  let raw = 0n, decimals = 0;
  for (const a of r?.value || []) { const ta = a.account?.data?.parsed?.info?.tokenAmount; if (ta) { raw += BigInt(ta.amount); decimals = ta.decimals; } }
  return { raw: raw.toString(), decimals };
}
export async function solStatus({ sig }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(sig || ""))) throw new HttpError(400, "Not a Solana signature.");
  const r = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const s = r?.value?.[0];
  return { found: !!s, status: s?.confirmationStatus || null, err: s?.err ? JSON.stringify(s.err) : null };
}
const POPULAR = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", decimals: 6 },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD", decimals: 6 },
  { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", decimals: 6 },
  { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "Bonk", name: "Bonk", decimals: 5 },
];
const SCACHE = new Map();
export async function solSearch({ q = "" }) {
  const query = String(q).trim().slice(0, 50);
  const k = query.toLowerCase(), hit = SCACHE.get(k);
  if (hit && Date.now() - hit.t < 5 * 60_000) return hit.v;
  const map = (t) => ({ address: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, image: /^https:/.test(t.icon || "") ? t.icon : null, liquidityUsd: Number(t.liquidity) || null, launchpad: t.launchpad || null, verified: !!t.isVerified });
  let tokens = [];
  try {
    const list = query ? await jup(`/tokens/v2/search?query=${encodeURIComponent(query)}`) : await jup("/tokens/v2/toptrending/1h?limit=30");
    tokens = (Array.isArray(list) ? list : []).filter((t) => t.id && t.id !== SOL_MINT).map(map);
  } catch { /* popular list only */ }
  const v = { chain: "solana", tokens: query ? tokens.slice(0, 30) : [...POPULAR, ...tokens.filter((t) => !POPULAR.some((p) => p.address === t.address))].slice(0, 30), trending: !query };
  SCACHE.set(k, { t: Date.now(), v });
  return v;
}
