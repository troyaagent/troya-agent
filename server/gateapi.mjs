// F23 · Gate for every agent: Troya Gate as an API any agent can call, paid per check in USDG on Robinhood Chain.
// A check is fresh (never a cached snapshot), runs at the agent's own trade size, adds The Assay's flags and comes back
// signed by Troya's attestor key, so another agent can verify the result without trusting whoever passed it on.
//
// Who pays:
//   · an API token (x-api-key, from the app) or a wallet signature (x-troya-address / -timestamp / -signature) names a
//     wallet; that wallet gets a free number of checks a day (more for $TROYA holders), then spends USDG credit
//   · without either, an IP gets a few free checks a day to try it
// How credit is bought: send USDG on Robinhood Chain to PAY_TO from the wallet that will use it. Transfers are read
// from the chain every minute (or at once with /credits/claim) and credited to the sender. Nobody can claim someone
// else's payment: credit always goes to the address the USDG came from.
//   GET  /api/gate/v1                       price, pay-to address, free tiers, attestor, totals
//   GET  /api/gate/v1/check/:token          ?amountEth=0.01&from=0x…&assay=0&pay=credit → the signed result (or 402 with how to pay)
//   GET  /api/gate/v1/credits/:address      balance, free checks left today, deposits
//   POST /api/gate/v1/credits/claim         { txHash } → credit a USDG payment now
//   POST /api/gate/v1/verify                { attested, signature } → is this a genuine Troya Gate result
//   POST /api/gate/v1/admin/settings        admins: { enabled, priceUsdg, freePerDay, holderFreePerDay, anonPerDay }
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { Wallet, verifyMessage, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";
import { optionalApiToken } from "./apitokens.mjs";
import { gateCheck, rpc, ADDR } from "./robinhood.mjs";
import { verdict } from "./sentry.mjs";

const FILE = "gateapi.json";
const USDG = String(ADDR.usdg || "0x5fc5360d0400a0fd4f2af552add042d716f1d168").toLowerCase(), USDG_DEC = 6;
const PAY_TO = getAddress(process.env.GATE_PAY_TO || "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4");   // the $TROYA creator wallet
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const DEFAULTS = { enabled: true, priceUsdg: 0.01, freePerDay: 10, holderFreePerDay: 200, anonPerDay: 3 };
const RANGE = 2000;
const lc = (s) => String(s || "").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const micro = (usdg) => Math.round(Number(usdg) * 1e6);
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
let store = null, dir = null, attestor = null, scanning = false;
const seenSigs = new Map();                  // signature → expiry, so a signed request is used once

/* ---------- the attestor key: signs results, holds no funds; made on the server, stored encrypted ---------- */
async function masterKey() {
  const f = join(dir, "gate-attestor.key");
  try { const k = await readFile(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32); await writeFile(f, k, { mode: 0o600 }); return k;
}
let attestorP = null;                        // one creation at a time (two parallel first calls must not make two keys)
async function getAttestor() {
  if (attestor) return attestor;
  return (attestorP ||= makeAttestor().finally(() => { attestorP = null; }));
}
async function makeAttestor() {
  if (attestor) return attestor;
  const f = join(dir, "gate-attestor.json");
  try {
    const j = JSON.parse(await readFile(f, "utf8"));
    const d = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(j.iv, "hex")); d.setAuthTag(Buffer.from(j.tag, "hex"));
    attestor = new Wallet(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]).toString("utf8"));
  } catch {
    const w = Wallet.createRandom();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", await masterKey(), iv);
    const ct = Buffer.concat([c.update(w.privateKey, "utf8"), c.final()]);
    await writeFile(f, JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex"), address: w.address, at: Date.now() }), { mode: 0o600 });
    attestor = new Wallet(w.privateKey);
  }
  return attestor;
}
const attestMessage = (hash) => `Troya Gate result\n${hash}`;
export async function attestorAddress() { return (await getAttestor()).address; }
/** Sign any record with the attestor (the agent registry signs every call it files): keccak256 of the JSON, EIP-191. */
export async function attest(obj, label = "Troya record") {
  const hash = keccak256(toUtf8Bytes(JSON.stringify(obj)));
  const w = await getAttestor();
  return { hash, signature: await w.signMessage(`${label}\n${hash}`), attestor: w.address };
}

/* ---------- ledger ---------- */
const settings = async () => ({ ...DEFAULTS, ...((await store.readJson(FILE, {})).settings || {}) });
export const gateSettings = () => settings();   // V8 F46 Treasury shows the checks a day per tier
async function creditOf(address) {
  const d = await store.readJson(FILE, {}), a = lc(address), s = await settings();
  const used = d.usage?.day === today() ? d.usage.by?.[a] || 0 : 0;
  const holder = await import("./holders.mjs").then((m) => m.holderOf(a)).catch(() => null);
  // V8 F46 Treasury: the daily free checks grow with the holder tier
  const free = await import("./treasury.mjs").then((m) => m.gateFreeFor(a, s)).catch(() => (holder?.holder ? s.holderFreePerDay : s.freePerDay));
  return { address: getAddress(a), balanceUsdg: (d.credits?.[a] || 0) / 1e6, checksLeft: Math.floor((d.credits?.[a] || 0) / micro(s.priceUsdg)), freePerDay: free, freeLeftToday: Math.max(0, free - used), holder: !!holder?.holder,
    deposits: Object.entries(d.deposits || {}).filter(([, x]) => x.from === a).map(([k, x]) => ({ tx: k.split(":")[0], usdg: x.usdg, at: x.at })).sort((p, q) => q.at - p.at).slice(0, 50) };
}

// who is asking: an API token, a fresh wallet signature, or nobody (then the IP)
async function who(req, token) {
  const t = await optionalApiToken(req);
  if (t) return { address: lc(t.address), via: "api-key" };
  const s = getSession(req);
  if (s) return { address: lc(s.address), via: "session" };
  const a = req.headers["x-troya-address"], ts = req.headers["x-troya-timestamp"], sig = req.headers["x-troya-signature"];
  if (a || ts || sig) {
    if (!isAddress(String(a || "")) || !/^\d{10,14}$/.test(String(ts || "")) || !/^0x[0-9a-fA-F]{130}$/.test(String(sig || ""))) throw new HttpError(401, "Send x-troya-address, x-troya-timestamp (ms) and x-troya-signature together.");
    if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new HttpError(401, "The signature is older than 5 minutes. Sign a fresh one.");
    const msg = `Troya Gate v1\naddress: ${lc(a)}\ntoken: ${lc(token)}\ntime: ${ts}`;
    let rec; try { rec = verifyMessage(msg, sig); } catch { rec = null; }
    if (lc(rec) !== lc(a)) throw new HttpError(401, "The signature does not match x-troya-address.");
    const now = Date.now();
    for (const [k, exp] of seenSigs) if (exp < now) seenSigs.delete(k);
    if (seenSigs.has(lc(sig))) throw new HttpError(401, "This signature was already used. Sign each request.");
    seenSigs.set(lc(sig), now + 6 * 60_000);
    return { address: lc(a), via: "signature" };
  }
  return { address: null, via: "anonymous" };
}

function payInfo(s) {
  return {
    price: { amount: s.priceUsdg, asset: "USDG", token: getAddress(USDG), decimals: USDG_DEC, chainId: 4663, network: "Robinhood Chain" },
    payTo: PAY_TO,
    howToPay: [
      `Send USDG on Robinhood Chain (chain 4663) to ${PAY_TO} from the wallet that will use the checks. ${s.priceUsdg} USDG buys one check.`,
      "Credit lands within a minute, or at once with POST /api/gate/v1/credits/claim {\"txHash\":\"0x…\"}.",
      "Then call again with that wallet's API token (x-api-key) or a wallet signature (x-troya-address, x-troya-timestamp, x-troya-signature).",
    ],
    docs: "https://troya.codes/api-and-mcp#gate-api",
  };
}

// take one check: free first, then credit; returns how it was paid and a refund for when the check itself fails
async function charge(id, ip, { preferCredit = false } = {}) {
  const s = await settings();
  if (!s.enabled) throw new HttpError(503, "The Gate API is paused right now.");
  const holder = id.address ? await import("./holders.mjs").then((m) => m.holderOf(id.address)).catch(() => null) : null;
  const key = id.address || `ip:${ip}`;
  const free = id.address ? await import("./treasury.mjs").then((m) => m.gateFreeFor(id.address, s)).catch(() => (holder?.holder ? s.holderFreePerDay : s.freePerDay)) : s.anonPerDay;
  const price = micro(s.priceUsdg);
  let paid = null;
  await store.update(FILE, {}, (d) => {
    const t = today();
    if (d.usage?.day !== t) d.usage = { day: t, by: {} };
    const used = d.usage.by[key] || 0;
    d.stats ||= { checks: 0, free: 0, paid: 0, deposits: 0, usdg: 0 };
    const credit = id.address ? d.credits?.[id.address] || 0 : 0;
    // pay=credit: spend this wallet's own credit first and keep its free checks for later
    const useCredit = preferCredit && credit >= price;
    if (used < free && !useCredit) { d.usage.by[key] = used + 1; d.stats.checks++; d.stats.free++; paid = { by: "free", freeLeftToday: free - used - 1 }; return d; }
    if (id.address && (d.credits?.[id.address] || 0) >= price) {
      d.credits[id.address] -= price; d.stats.checks++; d.stats.paid++;
      paid = { by: "credit", costUsdg: s.priceUsdg, balanceUsdg: d.credits[id.address] / 1e6 };
      return d;
    }
    return d;
  });
  if (!paid) {
    throw new HttpError(402, id.address
      ? `Payment required: the free checks for ${getAddress(id.address)} are used up today and it has no USDG credit.`
      : "Payment required: the free checks for anonymous callers are used up today. Name a wallet (API token or signature) for its own free checks, or pay in USDG.", { payment: payInfo(s), freeTier: { perWalletPerDay: s.freePerDay, perHolderPerDay: s.holderFreePerDay, anonymousPerDay: s.anonPerDay } });
  }
  const refund = async () => store.update(FILE, {}, (d) => {
    if (paid.by === "free" && d.usage?.by?.[key]) d.usage.by[key]--;
    if (paid.by === "credit") d.credits[id.address] = (d.credits[id.address] || 0) + price;
    d.stats.checks--; d.stats[paid.by === "free" ? "free" : "paid"]--;
    return d;
  });
  return { paid, refund };
}

/* ---------- the check ---------- */
const ASSAY_KEEP = ["key", "level", "title", "detail"];
async function runCheck(token, { amountEth, from, withAssay }) {
  const amt = Math.max(0.0001, Math.min(5, Number(amountEth) || 0.01));
  const [g, a] = await Promise.all([
    gateCheck({ tokenIn: "ETH", tokenOut: token, amountIn: String(amt), slippageBps: 100, from: from && isAddress(from) ? from : undefined }),
    withAssay ? import("./assay.mjs").then((m) => m.assay(token, { deep: false, waitMs: 9000 })).catch(() => null) : null,
  ]);
  const vd = verdict(g);
  const q = g.quote || {};
  const ring = await import("./ringradar.mjs").then((m) => m.ringFlags(token)).catch(() => []);   // V7 F31, from the radar's cache
  const oath = await import("./oath.mjs").then((m) => m.oathOf(token)).catch(() => null);           // V7 F32 tier 2
  const oathFlag = oath?.status === "broken" ? [{ key: "oath", level: "red", title: "Oath broken", detail: `the dev broke its pledge (${oath.breaches.length} breach${oath.breaches.length > 1 ? "es" : ""}); see troya.codes/oath` }] : [];
  const flags = [...(a?.status === "done" ? (a.flags || []).filter((f) => f.key !== "partial").map((f) => Object.fromEntries(ASSAY_KEEP.map((k) => [k, f[k]]))) : []), ...ring, ...oathFlag];
  const red = flags.some((f) => f.level === "red");
  const v = vd.v === "nobuys" ? "untested" : vd.v === "passed" && red ? "caution" : vd.v;
  const attested = {
    v: 1, chainId: 4663, token: getAddress(token), symbol: q.tokenOut?.symbol || null, amountEth: amt,
    verdict: v, reason: vd.why ? `${vd.why.label}: ${vd.why.detail}` : red ? `Assay: ${flags.find((f) => f.level === "red").title}` : null,
    checks: g.checks.map((c) => ({ key: c.key, status: c.status, detail: c.detail })),
    quote: q.amountOut ? { amountOut: String(q.amountOut), minOut: String(q.minOut || ""), priceImpactPct: q.priceImpact != null ? +(q.priceImpact * 100).toFixed(3) : null, feePct: q.feePct ?? null, route: q.route?.label || q.venue || null } : null,
    assay: withAssay ? (a?.status === "done" ? { flags, devHoldsPct: a.dev?.holdsPct ?? null, devSoldPct: a.dev?.soldPct ?? null, top10Pct: a.holders?.top10Pct ?? null } : { status: a?.status || "unavailable" }) : null,
    checkedAt: g.checkedAt || Date.now(),
  };
  const json = JSON.stringify(attested), hash = keccak256(toUtf8Bytes(json));
  const w = await getAttestor();
  import("./seal.mjs").then((m) => m.seal("gate", attested.token, hash, `${v} at ${amt} ETH`)).catch(() => {});   // V7 F35: every check gets a receipt
  return { attested, hash, signature: await w.signMessage(attestMessage(hash)), attestor: w.address };
}

/** The same fresh, signed check for callers that are paid elsewhere: x402 (USDC on Base, settled only after the check
 *  ran) and Virtuals ACP (the buyer's USDC sits in ACP's escrow). via names where it was paid, for the totals. */
export async function signedCheck(token, { amountEth, withAssay = true, via = "x402" } = {}) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "That is not a token address on Robinhood Chain.");
  const out = await runCheck(token, { amountEth, withAssay });
  const k = via === "acp" ? "acp" : "x402";
  await store.update(FILE, {}, (d) => { d.stats ||= { checks: 0, free: 0, paid: 0, deposits: 0, usdg: 0 }; d.stats.checks++; d.stats[k] = (d.stats[k] || 0) + 1; return d; }).catch(() => {});
  return out;
}
const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const keyOk = (got) => { const k = process.env.GATE_INTERNAL_KEY || ""; const g = String(got || ""); return k.length >= 24 && g.length === k.length && timingSafeEqual(Buffer.from(g), Buffer.from(k)); };

/** A paid check for callers that are already identified (the tool registry: API token or session, else the IP). */
export async function paidCheck({ address, ip, token, amountEth, assay = true }) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "That is not a token address on Robinhood Chain.");
  const id = { address: address ? lc(address) : null, via: address ? "api-key" : "anonymous" };
  const { paid, refund } = await charge(id, ip || "tools");
  try { return { ...(await runCheck(token, { amountEth, withAssay: assay !== false })), paid: { ...paid, wallet: id.address ? getAddress(id.address) : null, via: id.via } }; }
  catch (e) { await refund().catch(() => {}); throw e.status ? e : new HttpError(502, `The check could not run: ${e.message}`); }
}

/* ---------- deposits: USDG transfers to PAY_TO, credited to the sender ---------- */
async function credit(logs) {
  if (!logs.length) return 0;
  let added = 0;
  await store.update(FILE, {}, (d) => {
    d.deposits ||= {}; d.credits ||= {}; d.stats ||= { checks: 0, free: 0, paid: 0, deposits: 0, usdg: 0 };
    for (const l of logs) {
      if (lc(l.address) !== USDG || l.topics?.[0] !== TRANSFER || lc(l.topics[2]) !== lc(pad(PAY_TO))) continue;
      if (d.startBlock && Number(l.blockNumber) < d.startBlock) continue;
      const k = `${lc(l.transactionHash)}:${Number(l.logIndex)}`;
      if (d.deposits[k]) continue;
      const from = "0x" + l.topics[1].slice(26).toLowerCase(), value = Number(BigInt(l.data));
      if (!(value > 0)) continue;
      d.deposits[k] = { from, usdg: value / 1e6, block: Number(l.blockNumber), at: Date.now() };
      d.credits[from] = (d.credits[from] || 0) + value;
      d.stats.deposits++; d.stats.usdg = +((d.stats.usdg || 0) + value / 1e6).toFixed(6);
      added++;
    }
    return d;
  });
  return added;
}
async function scan() {
  if (scanning) return; scanning = true;
  try {
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    const d = await store.readJson(FILE, {});
    if (!d.startBlock) { await store.update(FILE, {}, (x) => { x.startBlock ||= head; x.lastBlock ||= head; return x; }); return; }
    let from = (d.lastBlock || head) + 1;
    if (head - from > 200_000) from = head - 200_000;     // after a long stop, look back about half a day of blocks
    while (from <= head) {
      const to = Math.min(head, from + RANGE - 1);
      const logs = await rpc("robinhood", "eth_getLogs", [{ address: USDG, topics: [TRANSFER, null, pad(PAY_TO)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }], { timeoutMs: 20000 });
      const n = await credit(logs || []);
      if (n) console.log(`[gate api] ${n} USDG payment(s) credited`);
      await store.update(FILE, {}, (x) => { x.lastBlock = to; return x; });
      from = to + 1;
    }
  } catch (e) { console.warn("[gate api] scan", e.message); }
  finally { scanning = false; }
}

export async function register(r, ctx) {
  store = ctx.store; dir = ctx.dataDir;
  getAttestor().catch((e) => console.warn("[gate api] attestor", e.message));
  if (process.env.GATE_API_SCAN !== "0") { setTimeout(() => scan().catch(() => {}), 20_000); setInterval(() => scan().catch(() => {}), 60_000).unref(); }

  r.get("/api/gate/v1", async () => {
    const s = await settings(), d = await store.readJson(FILE, {}), w = await getAttestor();
    return { name: "Troya Gate API", version: 1, enabled: s.enabled, ...payInfo(s),
      freeTier: { perWalletPerDay: s.freePerDay, perHolderPerDay: s.holderFreePerDay, holderMinimum: "1,000,000 $TROYA", anonymousPerDay: s.anonPerDay },
      attestor: w.address, verify: `keccak256 of the attested JSON, signed with EIP-191 as "Troya Gate result\\n<hash>" by the attestor`,
      totals: { checks: d.stats?.checks || 0, paidChecks: d.stats?.paid || 0, deposits: d.stats?.deposits || 0, usdgReceived: d.stats?.usdg || 0 } };
  }, { weight: 1 });

  r.get("/api/gate/v1/check/:token", async ({ req, params, query, ip }) => {
    if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address on Robinhood Chain.");
    const id = await who(req, params.token);
    const { paid, refund } = await charge(id, ip, { preferCredit: query.pay === "credit" });
    try {
      const out = await runCheck(params.token, { amountEth: query.amountEth, from: query.from, withAssay: query.assay !== "0" });
      return { ...out, paid: { ...paid, wallet: id.address ? getAddress(id.address) : null, via: id.via } };
    } catch (e) { await refund().catch(() => {}); throw e.status ? e : new HttpError(502, `The check could not run: ${e.message}`); }
  }, { weight: 4, perMin: 60 });

  // the Virtuals ACP seller (acp/seller.mjs, same server): the job is paid in ACP's escrow, so no free tier and no
  // credit here. Only from this machine and only with GATE_INTERNAL_KEY; anything else gets a plain 404.
  r.get("/api/gate/v1/internal/check/:token", async ({ req, params, query, ip }) => {
    if (!LOCAL.test(ip) || !keyOk(req.headers["x-internal-key"])) throw new HttpError(404, "Not found");
    try { return await signedCheck(params.token, { amountEth: query.amountEth, withAssay: query.assay !== "0", via: "acp" }); }
    catch (e) { throw e.status ? e : new HttpError(502, `The check could not run: ${e.message}`); }
  }, { weight: 1 });

  r.get("/api/gate/v1/credits/:address", async ({ params }) => {
    if (!isAddress(params.address)) throw new HttpError(400, "That is not a wallet address.");
    return creditOf(params.address);
  }, { weight: 2 });

  r.post("/api/gate/v1/credits/claim", async ({ body }) => {
    const h = String(body?.txHash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new HttpError(400, "Send the transaction hash of your USDG payment.");
    const rc = await rpc("robinhood", "eth_getTransactionReceipt", [h]);
    if (!rc) throw new HttpError(404, "That transaction is not on Robinhood Chain yet. Try again in a few seconds.");
    if (rc.status !== "0x1") throw new HttpError(400, "That transaction failed on chain, so nothing was paid.");
    const d = await store.readJson(FILE, {});
    if (d.startBlock && Number(rc.blockNumber) < d.startBlock) throw new HttpError(400, "That payment is older than the Gate API itself.");
    const mine = (rc.logs || []).filter((l) => lc(l.address) === USDG && l.topics?.[0] === TRANSFER && lc(l.topics[2]) === lc(pad(PAY_TO)));
    if (!mine.length) throw new HttpError(400, `No USDG transfer to ${PAY_TO} in that transaction.`);
    const added = await credit(mine);
    const from = "0x" + mine[0].topics[1].slice(26);
    return { credited: added > 0, alreadyCredited: added === 0, ...(await creditOf(from)) };
  }, { weight: 3, perMin: 20 });

  r.post("/api/gate/v1/verify", async ({ body }) => {
    const att = body?.attested, sig = String(body?.signature || "");
    if (!att || typeof att !== "object" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "Send { attested, signature } exactly as the check returned them.");
    const hash = keccak256(toUtf8Bytes(JSON.stringify(att)));
    let signer = null; try { signer = verifyMessage(attestMessage(hash), sig); } catch {}
    const w = await getAttestor();
    return { genuine: lc(signer) === lc(w.address), hash, signer, attestor: w.address, ageSeconds: att.checkedAt ? Math.round((Date.now() - att.checkedAt) / 1000) : null };
  }, { weight: 1 });

  r.post("/api/gate/v1/admin/settings", async ({ req, body }) => {
    const s = getSession(req);
    if (!s || !admins().includes(lc(s.address))) throw new HttpError(403, "Admins only.");
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    let out;
    await store.update(FILE, {}, (d) => {
      const x = { ...DEFAULTS, ...(d.settings || {}) };
      if (body?.enabled != null) x.enabled = !!body.enabled;
      x.priceUsdg = num(body?.priceUsdg ?? x.priceUsdg, 0.001, 10, x.priceUsdg);
      x.freePerDay = num(body?.freePerDay ?? x.freePerDay, 0, 10000, x.freePerDay);
      x.holderFreePerDay = num(body?.holderFreePerDay ?? x.holderFreePerDay, 0, 100000, x.holderFreePerDay);
      x.anonPerDay = num(body?.anonPerDay ?? x.anonPerDay, 0, 1000, x.anonPerDay);
      d.settings = x; out = x; return d;
    });
    return { settings: out };
  }, { weight: 2 });
}
