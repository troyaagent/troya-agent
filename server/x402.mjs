// F23+ · Troya Gate over x402 (v2): any agent pays $0.01 in USDC on Base per check, with no account, no API key and no
// deposit. The 402 reply carries the price and the Bazaar description, so x402 directories (Coinbase's Bazaar,
// Agentic.Market, x402scan) can list it and agents can find it on their own.
//
// The flow, as the x402 v2 HTTP transport defines it:
//   1. GET /api/gate/x402/check?token=0x…             → 402, PAYMENT-REQUIRED header (base64 JSON: price, payTo, Bazaar)
//   2. the agent signs an EIP-3009 USDC authorization  → same GET with a PAYMENT-SIGNATURE header
//   3. the facilitator verifies it (nothing moves yet) → Troya runs the check
//   4. the facilitator settles it on Base              → 200, the signed result, PAYMENT-RESPONSE header (the tx)
// When the check itself fails, step 4 never happens and nothing is charged. When settlement fails, the result is not
// sent. The money goes straight to PAY_TO on Base (the $TROYA creator wallet, the same address as on Robinhood Chain).
//
// Off until X402_ENABLED=1. X402_NETWORK picks the chain: eip155:84532 (Base Sepolia, test USDC, the public x402.org
// facilitator) or eip155:8453 (Base, real USDC, Coinbase's facilitator, needs CDP_API_KEY_ID + CDP_API_KEY_SECRET).
//   GET /api/gate/x402          what it costs, where it pays, which network, whether it is on
//   GET /api/gate/x402/check    ?token=0x…&amountEth=0.01&assay=1 → the x402-paid, signed Gate check
import { createPrivateKey, sign as edSign, randomBytes } from "node:crypto";
import { getAddress, isAddress } from "ethers";
import { send, HttpError } from "./api.mjs";

const FILE = "x402.json";
const NETS = {
  "eip155:8453": { name: "Base", chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" }, facilitator: "https://api.cdp.coinbase.com/platform/v2/x402", scan: "https://basescan.org/tx/" },
  "eip155:84532": { name: "Base Sepolia", chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" }, facilitator: "https://x402.org/facilitator", scan: "https://sepolia.basescan.org/tx/" },
};
const lc = (s) => String(s || "").toLowerCase();
const SITE = () => String(process.env.SITE_URL || "https://troya.codes").replace(/\/+$/, "");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));

function cfg() {
  const network = NETS[process.env.X402_NETWORK] ? process.env.X402_NETWORK : "eip155:84532";
  const net = NETS[network];
  const price = Math.max(0.001, Number(process.env.X402_PRICE_USD || 0.01));
  return {
    enabled: process.env.X402_ENABLED === "1",
    network, net, price,
    amount: String(Math.round(price * 1e6)),                       // USDC has 6 decimals
    payTo: getAddress(process.env.X402_PAY_TO || process.env.GATE_PAY_TO || "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4"),
    facilitator: String(process.env.X402_FACILITATOR_URL || net.facilitator).replace(/\/+$/, ""),
  };
}

/* ---------- Coinbase's facilitator wants a short-lived JWT per call (the same claims as @coinbase/cdp-sdk) ---------- */
const b64url = (b) => Buffer.from(b).toString("base64url");
export function cdpJwt(method, url) {
  const id = process.env.CDP_API_KEY_ID, secret = String(process.env.CDP_API_KEY_SECRET || "").replace(/\\n/g, "\n");
  if (!id || !secret) return null;
  const u = new URL(url), now = Math.floor(Date.now() / 1000);
  const claims = { sub: id, iss: "cdp", uris: [`${method} ${u.host}${u.pathname}`], iat: now, nbf: now, exp: now + 120 };
  const nonce = randomBytes(8).toString("hex");
  if (/BEGIN (EC )?PRIVATE KEY/.test(secret)) {                   // ES256 key (PEM)
    const head = { alg: "ES256", kid: id, typ: "JWT", nonce };
    const input = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(claims))}`;
    const sig = edSign("sha256", Buffer.from(input), { key: createPrivateKey(secret), dsaEncoding: "ieee-p1363" });
    return `${input}.${b64url(sig)}`;
  }
  const raw = Buffer.from(secret, "base64");                        // Ed25519 key (base64, 32-byte seed + 32-byte public key)
  if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is neither an EC PEM key nor a base64 Ed25519 key");
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) }, format: "jwk" });
  const head = { alg: "EdDSA", kid: id, typ: "JWT", nonce };
  const input = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(edSign(null, Buffer.from(input), key))}`;
}

async function facilitator(c, path, body) {
  const url = `${c.facilitator}/${path}`;
  const headers = { "content-type": "application/json" };
  if (/api\.cdp\.coinbase\.com/.test(url)) {
    const jwt = cdpJwt("POST", url);
    if (!jwt) throw new HttpError(503, "x402 on Base needs Coinbase's facilitator key, which is not set yet.");
    headers.authorization = `Bearer ${jwt}`;
    headers["correlation-context"] = "sdk_language=node,source=x402,source_version=2.1.0";
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(path === "settle" ? 45_000 : 15_000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!j) throw new Error(`facilitator ${path} answered ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

/* ---------- what the 402 says ---------- */
const EXAMPLE = {
  attested: {
    v: 1, chainId: 4663, token: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", symbol: "TROYA", amountEth: 0.01, verdict: "passed", reason: null,
    checks: [{ key: "route", status: "pass", detail: "Uniswap v4 · ETH → TROYA" }, { key: "impact", status: "pass", detail: "0.44%" }, { key: "depth", status: "pass", detail: "2.33 ETH" }, { key: "fee", status: "pass", detail: "2.90%" },
      { key: "sim", status: "pass", detail: "The exact swap succeeds against the current pool" }, { key: "sell", status: "pass", detail: "Selling back succeeds" }, { key: "tax", status: "pass", detail: "None on a transfer to the pool or to a wallet" }],
    quote: { amountOut: "1610989.54", minOut: "1594879.64", priceImpactPct: 0.44, feePct: 2.9, route: "Uniswap v4 · ETH → TROYA" },
    assay: { flags: [], devHoldsPct: 0, devSoldPct: 0, top10Pct: 20 },
    checkedAt: 0,
  },
  hash: "0x keccak256 of the attested JSON", signature: "0x EIP-191 signature of \"Troya Gate result\\n<hash>\"", attestor: "0x the Troya Gate attestor (GET /api/gate/x402)",
  paid: { by: "x402", network: "eip155:8453", payer: "0x the paying wallet", transaction: "0x the settlement tx on Base" },
};
function required(c, error) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: `${SITE()}/api/gate/x402/check`,
      description: "Troya Gate: a fresh pre-trade safety check for any token on Robinhood Chain, run at your trade size. Can it be bought and sold, the real taxes, price impact, honeypot and liquidity tests, plus dev and holder flags. Signed by Troya's attestor so any agent can verify it.",
      mimeType: "application/json",
      serviceName: "Troya Gate",
      tags: ["crypto", "token-safety", "trading", "robinhood-chain", "honeypot-check"],
      iconUrl: `${SITE()}/img/favicon-512.png`,
    },
    accepts: [{
      scheme: "exact", network: c.network, amount: c.amount, asset: c.net.usdc, payTo: c.payTo, maxTimeoutSeconds: 120, extra: c.net.extra,
    }],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { token: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", amountEth: "0.01", assay: "1" } },
          output: { type: "json", example: EXAMPLE },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["GET", "HEAD"] },
                queryParams: {
                  type: "object",
                  properties: {
                    token: { type: "string", description: "Token contract address on Robinhood Chain (0x + 40 hex)" },
                    amountEth: { type: "string", description: "Trade size in ETH to test at, 0.0001 to 5 (default 0.01)" },
                    assay: { type: "string", enum: ["0", "1"], description: "1 adds dev, holder and bundle flags (default 1)" },
                  },
                  required: ["token"],
                },
                headers: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
          },
          required: ["input"],
        },
      },
    },
  };
}
const EXPOSE = { "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" };
function ask402(res, c, error) {
  const pr = required(c, error);
  send(res, 402, pr, { ...EXPOSE, "payment-required": b64(pr) });
}

/* ---------- a payment is used once: in flight or settled, its nonce is taken ---------- */
const nonces = new Map();
function takeNonce(n) {
  const now = Date.now();
  for (const [k, t] of nonces) if (t < now) nonces.delete(k);
  if (nonces.has(n)) return false;
  nonces.set(n, now + 30 * 60_000);
  return true;
}

let store = null;
export async function register(r, ctx) {
  store = ctx.store;
  const gate = await import("./gateapi.mjs");

  r.get("/api/gate/x402", async () => {
    const c = cfg(), d = await store.readJson(FILE, {});
    return {
      name: "Troya Gate over x402", x402Version: 2, enabled: c.enabled,
      network: c.network, networkName: c.net.name, price: { usd: c.price, amount: c.amount, asset: "USDC", token: c.net.usdc, decimals: 6 },
      payTo: c.payTo, facilitator: new URL(c.facilitator).host, resource: `${SITE()}/api/gate/x402/check?token=0x…`,
      attestor: await gate.attestorAddress(),
      howToPay: "Call the resource, read the PAYMENT-REQUIRED header (base64 JSON), sign the USDC transfer it asks for (EIP-3009, any x402 client does this) and call again with PAYMENT-SIGNATURE. Nothing is charged when the check cannot run.",
      totals: { paidChecks: d.stats?.paid || 0, usdc: (d.stats?.micro || 0) / 1e6 },
      also: "Pay in USDG on Robinhood Chain instead: GET /api/gate/v1",
    };
  }, { weight: 1 });

  r.get("/api/gate/x402/check", async ({ req, res, query }) => {
    const c = cfg();
    if (!c.enabled) throw new HttpError(503, "Troya Gate over x402 is not switched on yet. The USDG version works now: GET /api/gate/v1/check/:token", { docs: "https://troya.codes/api-and-mcp#gate-api" });
    const token = String(query.token || "");
    if (!isAddress(token)) throw new HttpError(400, "Add ?token= with a token contract address on Robinhood Chain (0x + 40 hex).");
    const sigHeader = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!sigHeader) return ask402(res, c, "PAYMENT-SIGNATURE header is required");

    // 1) read the payment and hold it to exactly what this endpoint asks for
    let pp;
    try { pp = unb64(sigHeader); } catch { throw new HttpError(400, "PAYMENT-SIGNATURE is not base64 JSON.", { x402Version: 2 }); }
    const want = required(c).accepts[0];
    const acc = pp?.accepted || {}, auth = pp?.payload?.authorization || {};
    const now = Math.floor(Date.now() / 1000);
    const bad =
      pp?.x402Version !== 2 ? "invalid_x402_version"
      : acc.scheme !== "exact" ? "unsupported_scheme"
      : acc.network !== c.network ? "invalid_network"
      : lc(acc.asset) !== lc(want.asset) || lc(acc.payTo) !== lc(want.payTo) || String(acc.amount) !== want.amount ? "invalid_payment_requirements"
      : !pp?.payload?.signature || !auth.nonce ? "invalid_payload"
      : lc(auth.to) !== lc(c.payTo) ? "invalid_exact_evm_payload_recipient_mismatch"
      : String(auth.value) !== want.amount ? "invalid_exact_evm_payload_authorization_value_mismatch"
      : Number(auth.validBefore) < now + 6 ? "invalid_exact_evm_payload_authorization_valid_before"
      : Number(auth.validAfter) > now ? "invalid_exact_evm_payload_authorization_valid_after"
      : null;
    if (bad) return ask402(res, c, bad);
    const nk = `${c.network}:${lc(auth.from)}:${lc(auth.nonce)}`;
    if (!takeNonce(nk)) return ask402(res, c, "this payment was already used");
    const release = () => nonces.delete(nk);           // nothing was settled, so the same signed payment may be sent again
    const body = { x402Version: 2, paymentPayload: pp, paymentRequirements: want };

    // 2) the facilitator checks the signature and the balance; nothing moves yet
    let v;
    try { v = await facilitator(c, "verify", body); }
    catch (e) { release(); if (e.status) throw e; console.error("[x402] verify:", e.message); throw new HttpError(502, "The payment could not be checked right now. Nothing was charged; try again in a minute."); }
    if (!v?.isValid) { release(); return ask402(res, c, v?.invalidReason || "payment not valid"); }
    const payer = v.payer || auth.from;

    // 3) the check itself; when it fails, the payment is never settled
    let out;
    try { out = await gate.signedCheck(token, { amountEth: query.amountEth, withAssay: query.assay !== "0" }); }
    catch (e) { release(); console.error("[x402] check:", e.message); throw new HttpError(502, `The check could not run: ${e.message}. Nothing was charged.`); }

    // 4) settle on Base, then hand the result over
    let s;
    try { s = await facilitator(c, "settle", body); }
    catch (e) { console.error("[x402] settle:", e.message); s = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: c.network, payer }; }
    if (!s?.success) {
      console.error("[x402] settle failed:", s?.errorReason, s?.transaction || "");
      send(res, 402, { x402Version: 2, error: `Payment did not settle: ${s?.errorReason || "unknown"}. The result is withheld and nothing should have moved.` }, { ...EXPOSE, "payment-response": b64(s || {}) });
      return;
    }
    await store.update(FILE, {}, (d) => {
      d.stats ||= { paid: 0, micro: 0 };
      d.stats.paid++; d.stats.micro += Number(want.amount);
      d.last = [{ at: Date.now(), network: c.network, payer: lc(s.payer || payer), tx: s.transaction, token: lc(token), verdict: out.attested?.verdict }, ...(d.last || [])].slice(0, 200);
      return d;
    }).catch(() => {});
    console.log(`[x402] paid check ${token} by ${s.payer || payer} tx ${s.transaction} (${c.net.name})`);
    send(res, 200, { ...out, paid: { by: "x402", network: c.network, payer: s.payer || payer, transaction: s.transaction, explorer: c.net.scan + s.transaction, amountUsdc: c.price } },
      { ...EXPOSE, "payment-response": b64(s) });
  }, { weight: 4, perMin: 60 });
}
