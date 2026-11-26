// @troyaagent/sdk: a tiny client for Troya's public, read-only HTTP API (https://troya.codes, Robinhood Chain 4663).
// No dependencies: it needs a global fetch (Node 18+, Bun, Deno, browsers) or one passed in.
// Read only by construction: every call is a GET or a check (POST with JSON to read), nothing here builds, signs or
// sends a transaction, and no call needs a private key. Every answer is a reading of the chain at that moment.

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://troya.codes";
export const CHAIN_ID = 4663;
/** $TROYA on Robinhood Chain. */
export const TROYA_TOKEN = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const isAddr = (s) => ADDR.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every failure is a TroyaError: code says what kind, status is the HTTP status (0 when no answer came back). */
export class TroyaError extends Error {
  constructor(message, { code = "HTTP_ERROR", status = 0, url = null, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TroyaError";
    this.code = code;
    this.status = status;
    this.url = url;
    this.body = body;
    /** On a 402 from the signed Gate check: how to pay (USDG on Robinhood Chain) and the free tiers. */
    this.payment = body && typeof body === "object" ? body.payment || null : null;
  }
}

const bad = (msg) => new TroyaError(msg, { code: "BAD_INPUT" });
function needAddr(v, what) {
  const s = String(v ?? "").trim();
  if (!isAddr(s)) throw bad(`${what} must be a 0x address (0x + 40 hex characters), got ${JSON.stringify(String(v ?? "").slice(0, 60))}.`);
  return s;
}
function codeFor(status) {
  if (status === 400 || status === 404 || status === 413 || status === 422) return "BAD_INPUT";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 402) return "PAYMENT_REQUIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "UNAVAILABLE";
  return "HTTP_ERROR";
}
function b64json(s) {
  const txt = typeof Buffer !== "undefined" ? Buffer.from(s, "base64").toString("utf8") : decodeURIComponent(escape(atob(s)));
  return JSON.parse(txt);
}

// the same rule the Troya server uses for a Gate verdict (server/sentry.mjs verdict): depth is shown but never decides
export function gateVerdict(checks = []) {
  const real = checks.filter((c) => c.key !== "depth");
  const fail = real.find((c) => c.status === "fail");
  if (fail) return { verdict: "failed", reason: `${fail.label || fail.key}: ${fail.detail}` };
  const sell = real.find((c) => c.key === "sell");
  if (sell && sell.status === "skip" && /holds no buyers|too little/i.test(sell.detail || "")) return { verdict: "untested", reason: `${sell.label || "Test sell"}: ${sell.detail}` };
  const warn = real.find((c) => c.status === "warn");
  if (warn) return { verdict: "caution", reason: `${warn.label || warn.key}: ${warn.detail}` };
  return { verdict: "passed", reason: null };
}

/**
 * Make a client. Options: baseUrl (default https://troya.codes), apiKey (a Troya API token, troya_…, only sent to the
 * signed Gate check so it spends that wallet's free checks and credit), timeoutMs (default 30000), fetch (your own
 * fetch, e.g. for a proxy or tests), userAgent.
 */
export function createTroyaClient(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey ? String(options.apiKey).trim() : "";
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30_000);
  const doFetch = options.fetch || globalThis.fetch;
  if (typeof doFetch !== "function") throw new TroyaError("No fetch available: use Node 18 or newer, or pass options.fetch.", { code: "CONFIG" });
  const userAgent = options.userAgent || `troya-sdk/${VERSION}`;

  async function request(method, path, { query, body, auth = false, timeout = timeoutMs, signal, raw = false } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers = { accept: "application/json", "user-agent": userAgent };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && apiKey) headers["x-api-key"] = apiKey;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeout);
    const onAbort = () => ctl.abort(signal.reason);
    if (signal) { if (signal.aborted) ctl.abort(signal.reason); else signal.addEventListener("abort", onAbort, { once: true }); }
    let res;
    try {
      res = await doFetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      const timedOut = ctl.signal.aborted && !signal?.aborted;
      throw new TroyaError(timedOut ? `Troya did not answer within ${Math.round(timeout / 1000)} s (${method} ${url.pathname}).` : signal?.aborted ? "The call was cancelled." : `Could not reach Troya (${method} ${url.pathname}): ${e?.message || e}`,
        { code: timedOut ? "TIMEOUT" : signal?.aborted ? "ABORTED" : "NETWORK", url: url.toString(), cause: e });
    } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); }
    let text = "";
    try { text = await res.text(); } catch {}
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (raw) return { status: res.status, headers: res.headers, json, text };
    if (!res.ok) {
      const msg = (json && typeof json.error === "string" && json.error) || `Troya answered HTTP ${res.status} for ${method} ${url.pathname}.`;
      throw new TroyaError(msg, { code: codeFor(res.status), status: res.status, url: url.toString(), body: json ?? text.slice(0, 500) });
    }
    if (json === null) throw new TroyaError(`Troya answered something that is not JSON for ${method} ${url.pathname}.`, { code: "BAD_RESPONSE", status: res.status, url: url.toString(), body: text.slice(0, 500) });
    return json;
  }

  // poll a route that answers partial:true while its sources are still reading
  async function settle(fn, { waitMs = 0, everyMs = 6000, signal } = {}) {
    const until = Date.now() + Math.max(0, Number(waitMs) || 0);
    let out = await fn();
    while (out && out.partial && Date.now() + everyMs <= until) {
      if (signal?.aborted) break;
      await sleep(everyMs);
      out = await fn();
    }
    return out;
  }

  const client = {
    baseUrl,
    hasApiKey: !!apiKey,
    /** Low-level: any Troya GET or POST route, JSON in and out. */
    request,

    /**
     * Troya Gate, free and unsigned: GET /api/swap/gate. A fresh pre-trade simulation of buying `token` with ETH at
     * amountEth (route, price impact, pool depth, fees and taxes, transaction simulation, test sell, transfer tax, launch
     * ring, dev side wallets). The built swap transaction the route also returns is dropped: this SDK never hands one out.
     */
    async gateCheck(token, { amountEth = 0.01, from, slippagePct, signal } = {}) {
      const t = needAddr(token, "token");
      if (from != null && from !== "") needAddr(from, "from");
      const amt = Number(amountEth);
      if (!(amt > 0) || amt > 5) throw bad("amountEth must be more than 0 and at most 5.");
      const g = await request("GET", "/api/swap/gate", { query: { tokenIn: "ETH", tokenOut: t, amountIn: String(amt), from: from || undefined, slippageBps: slippagePct != null ? Math.round(Number(slippagePct) * 100) : undefined }, signal });
      const checks = Array.isArray(g.checks) ? g.checks.map((c) => ({ key: c.key, status: c.status, label: c.label, detail: c.detail })) : [];
      const q = g.quote || null;
      const v = gateVerdict(checks);
      return {
        kind: "gate", signed: false, chainId: CHAIN_ID, token: q?.tokenOut?.address || t, symbol: q?.tokenOut?.symbol || null, name: q?.tokenOut?.name || null, amountEth: amt,
        verdict: v.verdict, reason: v.reason, pass: !!g.pass, checks,
        quote: q ? { amountOut: q.amountOut ?? null, minOut: q.minOut ?? null, priceImpactPct: q.priceImpact != null ? +(q.priceImpact * 100).toFixed(3) : null, feePct: q.feePct ?? null,
          route: q.route?.label || q.venue || null, venue: q.venue || null, poolLiquidityEth: q.poolLiquidity?.eth ?? null, poolLiquidityUsd: q.poolLiquidity?.usd ?? null, ethUsd: q.ethUsd ?? null, warnings: q.warnings || [] } : null,
        checkedAt: g.checkedAt || Date.now(),
        source: `${baseUrl}/api/swap/gate`,
      };
    },

    /**
     * Troya Gate, signed: GET /api/gate/v1/check/:token. The same fresh check plus The Assay's flags, signed by Troya's
     * attestor (verify it with verifyGateResult). Uses a free daily allowance (a few per IP without an API key, more per
     * wallet with one, more again for $TROYA holders), then 0.01 USDG of credit per check. When none is left Troya answers
     * 402 and this throws a TroyaError with code PAYMENT_REQUIRED and err.payment saying how to pay. Paying is up to you:
     * this SDK never sends money.
     */
    async signedGateCheck(token, { amountEth = 0.01, from, assay = true, preferCredit = false, signal } = {}) {
      const t = needAddr(token, "token");
      if (from != null && from !== "") needAddr(from, "from");
      return request("GET", `/api/gate/v1/check/${t}`, { query: { amountEth, from: from || undefined, assay: assay === false ? "0" : undefined, pay: preferCredit ? "credit" : undefined }, auth: true, signal, timeout: Math.max(timeoutMs, 45_000) });
    },
    /** Is this a genuine Troya Gate result? POST /api/gate/v1/verify with { attested, signature } exactly as returned. */
    verifyGateResult({ attested, signature } = {}, { signal } = {}) {
      if (!attested || typeof attested !== "object" || !/^0x[0-9a-fA-F]{130}$/.test(String(signature || ""))) throw bad("Pass { attested, signature } exactly as the signed Gate check returned them.");
      return request("POST", "/api/gate/v1/verify", { body: { attested, signature }, signal });
    },
    /** Price, pay-to address, free tiers and attestor of the signed Gate API: GET /api/gate/v1. */
    gateInfo({ signal } = {}) { return request("GET", "/api/gate/v1", { signal }); },
    /** Free checks left today and USDG credit for a wallet: GET /api/gate/v1/credits/:address. */
    gateCredits(address, { signal } = {}) { return request("GET", `/api/gate/v1/credits/${needAddr(address, "address")}`, { signal }); },
    /** The x402 version of the signed check (pay $0.01 per call, no account): GET /api/gate/x402. */
    x402Info({ signal } = {}) { return request("GET", "/api/gate/x402", { signal }); },
    /**
     * What an x402 payment for one signed Gate check would be, read from the 402 answer's PAYMENT-REQUIRED header.
     * Nothing is signed or paid here; hand `required` to your own x402 client if you choose to pay.
     */
    async x402Requirements(token, { amountEth = 0.01, signal } = {}) {
      const t = needAddr(token, "token");
      const r = await request("GET", "/api/gate/x402/check", { query: { token: t, amountEth }, raw: true, signal });
      if (r.status === 402) {
        const h = r.headers.get("payment-required");
        let required = null;
        try { required = h ? b64json(h) : r.json; } catch { required = r.json; }
        return { status: 402, resource: `${baseUrl}/api/gate/x402/check?token=${t}&amountEth=${amountEth}`, required };
      }
      if (r.status >= 400) throw new TroyaError((r.json && r.json.error) || `Troya answered HTTP ${r.status} for the x402 check.`, { code: codeFor(r.status), status: r.status, body: r.json });
      return { status: r.status, required: null, body: r.json };
    },

    /**
     * Troya Trident (firewall): POST /api/trident/check. Send a Robinhood Chain transaction ({ from, to, data, value }),
     * an EIP-7702 { authorizationList }, or a signature request { typedData } before it is signed. Answers
     * allow / warn / block with plain reasons and a signature from the Troya attestor.
     */
    tridentCheck(req = {}, { signal } = {}) {
      const body = {};
      if (req.chainId != null) body.chainId = req.chainId;
      if (req.from) body.from = needAddr(req.from, "from");
      if (req.to) body.to = needAddr(req.to, "to");
      if (req.data != null && req.data !== "") { const d = String(req.data); if (!/^0x[0-9a-fA-F]*$/.test(d)) throw bad("data must be 0x-prefixed hex calldata."); body.data = d; }
      if (req.value != null && req.value !== "") { try { body.value = "0x" + BigInt(req.value).toString(16); } catch { throw bad("value must be an amount in wei (a number, a decimal string or 0x hex)."); } }
      if (Array.isArray(req.authorizationList)) body.authorizationList = req.authorizationList;
      if (req.typedData != null && req.typedData !== "") {
        let td = req.typedData;
        if (typeof td === "string") { try { td = JSON.parse(td); } catch { throw bad("typedData must be EIP-712 typed data (an object or a JSON string)."); } }
        if (!td || typeof td !== "object") throw bad("typedData must be EIP-712 typed data (an object or a JSON string).");
        body.typedData = td;
      }
      if (!body.to && !body.typedData && !body.authorizationList) throw bad("Send a transaction (to, data, value), an authorizationList, or a signature request (typedData).");
      return request("POST", "/api/trident/check", { body, signal });
    },

    /**
     * Troya Scylla (safe crossing): GET /api/scylla/routes. Every bridge route for moving `amount` ETH between Robinhood
     * Chain and Base, Arbitrum or Ethereum, each with a 0-100 safety score, band (green/amber/red) and red lines. One side
     * must be Robinhood Chain. from/to: robinhood, base, arbitrum, ethereum or a chain id. token (optional): a coin bought
     * at the end, which also runs the Gate on it. Routes are quotes, never sent transactions.
     */
    bridgeSafety({ from = "base", to = "robinhood", amount = 0.1, token, address, signal } = {}) {
      const a = Number(amount);
      if (!(a > 0) || a > 50) throw bad("amount is in ETH: more than 0 and at most 50.");
      if (token) needAddr(token, "token");
      if (address) needAddr(address, "address");
      return request("GET", "/api/scylla/routes", { query: { from, to, amount: String(amount), token: token || undefined, address: address || undefined }, signal, timeout: Math.max(timeoutMs, 45_000) });
    },

    /**
     * Troya Bow (agent passport): GET /api/bow/:address, or /api/bow?agentId= for an ERC-8004 id. Stamps built from
     * evidence (ERC-8004 identity and feedback, calls graded in public, paid jobs, Seal receipts, launches, farm-like
     * reviewers, endpoint health), each with its proof, a standing and a dated summary, signed by the Troya attestor.
     * It describes what wallets and endpoints did, never who runs them.
     */
    agentPassport(target, { agentId, signal } = {}) {
      let address = null, id = agentId;
      if (target && typeof target === "object") { address = target.address || null; id = target.agentId ?? id; }
      else if (target != null && target !== "") { if (/^\d+$/.test(String(target).trim())) id = String(target).trim(); else address = target; }
      if (address) return request("GET", `/api/bow/${needAddr(address, "address")}`, { query: { agentId: id ?? undefined }, signal, timeout: Math.max(timeoutMs, 45_000) });
      if (id != null && /^\d+$/.test(String(id))) return request("GET", "/api/bow", { query: { agentId: String(id) }, signal, timeout: Math.max(timeoutMs, 45_000) });
      throw bad("Give an agent wallet address (0x + 40 hex) or its ERC-8004 agent id.");
    },

    /**
     * Troya Heel (weak spot): GET /api/heel/:address. Paste a coin, a dev wallet or an agent; Troya names its single most
     * dangerous weak spot in one sentence, with up to three facts that each carry on-chain evidence and a confidence.
     * While a source is still reading the answer has partial: true; waitMs keeps asking until it settles or time runs out.
     */
    weakSpot(address, { waitMs = 0, signal } = {}) {
      const a = needAddr(address, "address");
      return settle(() => request("GET", `/api/heel/${a}`, { signal, timeout: Math.max(timeoutMs, 45_000) }), { waitMs, signal });
    },

    /**
     * Troya Sirens (real depth and honest volume): GET /api/sirens/:token (address, ticker or name). Price impact of
     * $100 / $1,000 / $10,000 buys and sells on every Robinhood Chain venue, 24 h volume with wash trades removed, and
     * the coin's family. Depth reads in the background: by default this waits up to 30 s for it (waitMs).
     */
    realDepth(token, { waitMs = 30_000, signal } = {}) {
      const t = String(token ?? "").trim();
      if (!t || t.length > 80) throw bad("token must be a coin address, ticker or name.");
      return settle(() => request("GET", `/api/sirens/${encodeURIComponent(t)}`, { signal, timeout: Math.max(timeoutMs, 45_000) }), { waitMs, signal });
    },

    /** Troya's remote MCP server, JSON-RPC 2.0 over POST /mcp (read-only tools: gate_check, watchfire, allies, …). */
    async mcp(method, params = {}, { signal } = {}) {
      const r = await request("POST", "/mcp", { body: { jsonrpc: "2.0", id: Date.now(), method, params }, signal });
      if (r.error) throw new TroyaError(r.error.message || "MCP error", { code: "MCP_ERROR", body: r });
      return r.result;
    },
  };
  return client;
}
