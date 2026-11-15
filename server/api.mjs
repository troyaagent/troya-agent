// API router. Every module in MODULES exports `register(r, ctx)` and adds routes with r.get / r.post / r.del.
// Routes are served under /api/* and mirrored under /agent/api/* (the public REST base).
import { initStore } from "./store.mjs";

const MODULES = [
  "./market.mjs",      // Robinhood Chain board (GeckoTerminal + Pons), tokenized stocks, Hyperliquid markets, brief, signals
  "./hl.mjs",          // Hyperliquid info proxy + exchange signing helpers
  "./robinhood.mjs",   // Robinhood Chain RPC relay, Pons + Uniswap swaps, Troya Gate, Pons launch, LI.FI bridge
  "./auth.mjs",        // wallet sign-in (nonce + signature → session cookie)
  "./policy.mjs",      // policy.json limits, per-user limits, pause + kill switch
  "./journal.mjs",     // audit journal (every action + rationale)
  "./agentwallet.mjs", // optional custodial Agent Wallet (encrypted at rest)
  "./watches.mjs",     // playbooks: server watches checked every 20 s
  "./tools.mjs",       // tool registry shared by the assistant, MCP and REST
  "./assistant.mjs",   // chat assistant (intent engine + optional LLM)
  "./apitokens.mjs",   // API tokens for MCP / REST execution
  "./inbox.mjs",       // inbox, notifications, proposals, settings, memory
  "./sentry.mjs",      // Troya Sentry: every new Pons launch through the Gate → Telegram channel + daily recap
  "./buybot.mjs",      // buy tracker: every $TROYA buy (Pons curve + Uniswap v4 ETH pools) → the Telegram group
  "./badge.mjs",       // Phase 4: live Troya Gate badge (SVG + JSON) for Pons devs to embed
  "./holders.mjs",     // Phase 3: $TROYA holder perks (more messages, more playbooks, Sentry DMs)
  "./icons.mjs",       // token + coin logos, fetched once and cached on disk
];

const routes = [];
const ctx = {};

const r = {
  get: (path, fn, opts) => routes.push({ method: "GET", ...compile(path), fn, opts: opts || {} }),
  post: (path, fn, opts) => routes.push({ method: "POST", ...compile(path), fn, opts: opts || {} }),
  del: (path, fn, opts) => routes.push({ method: "DELETE", ...compile(path), fn, opts: opts || {} }),
};

function compile(path) {
  const keys = [];
  const re = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  return { path, re, keys };
}

// ---- tiny rate limiter (per IP, per minute, weighted) ----
const buckets = new Map();
// one bucket per IP and route, so a strict route (e.g. sendRawTransaction) is not drained by ordinary page traffic;
// plus a global per-IP ceiling across all routes
function limited(ip, route, weight = 1, perMin = 240) {
  return hit(`${ip}|${route}`, weight, perMin) || hit(`${ip}|*`, weight, GLOBAL_PER_MIN);
}
const GLOBAL_PER_MIN = +(process.env.RATE_GLOBAL_PER_MIN || 1800);
function hit(key, weight, perMin) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; buckets.set(key, b); }
  b.n += weight;
  if (buckets.size > 20000) for (const [k, v] of buckets) if (now - v.t > 60_000) buckets.delete(k);
  return b.n > perMin;
}

export function ipOf(req) {
  return (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

export async function readBody(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks);
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw.toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
  }
  return raw;
}

export function send(res, status, body, extra = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export async function initApi({ dataDir, root }) {
  ctx.dataDir = dataDir;
  ctx.root = root;
  ctx.store = await initStore(dataDir);
  for (const m of MODULES) {
    try {
      const mod = await import(m);
      if (typeof mod.register === "function") await mod.register(r, ctx);
    } catch (e) {
      console.error(`[api] module ${m} failed to load:`, e.message);
    }
  }
  r.get("/api/health", () => ({ ok: true, name: "troya-agent", time: Date.now(), modules: MODULES.length }));
}

export async function handleApi(req, res, url) {
  let p = url.pathname;
  if (p.startsWith("/agent/api/")) p = p.slice("/agent".length);
  if (!p.startsWith("/api/")) return false;
  const ip = ipOf(req);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const hit = routes.find((x) => x.method === method && x.re.test(p));
  if (!hit) {
    const other = routes.some((x) => x.re.test(p));
    send(res, other ? 405 : 404, { error: other ? "Method not allowed" : "Not found" });
    return true;
  }
  if (limited(ip, `${hit.method} ${hit.path}`, hit.opts.weight || 1, hit.opts.perMin || 600)) { send(res, 429, { error: "Too many requests, slow down." }); return true; }
  const m = hit.re.exec(p);
  const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const body = method === "POST" || method === "DELETE" ? await readBody(req, hit.opts.maxBody) : {};
    const out = await hit.fn({ req, res, url, params, query: Object.fromEntries(url.searchParams), body, ip, ctx });
    if (out === undefined) { if (!res.writableEnded) send(res, 204, {}); }
    else if (!res.headersSent) send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[api] ${method} ${p}:`, e);
    send(res, status, { error: status >= 500 && !e.expose ? "Something went wrong on our side." : e.message, ...(e.extra || {}) });
  }
  return true;
}
