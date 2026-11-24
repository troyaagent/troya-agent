// TROYA AGENT — site + app + API. `npm run serve` → http://127.0.0.1:9270
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initApi, handleApi } from "./server/api.mjs";
import { handleShare } from "./server/share.mjs";
// live numbers and proof tables written into the pages as they are served (filled by server/proof.mjs)
import { liveHtml, liveTag } from "./server/livehtml.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "public");
const PORT = +(process.env.PORT || 9270);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = process.env.PUBLIC === "1";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
};

// clean URLs for the marketing pages; the app lives at /agent (hash routes inside)
const ROUTES = {
  "/": "/index.html",
  "/capabilities": "/capabilities.html",
  "/philosophy": "/philosophy.html",
  "/plans": "/plans.html",
  "/api-and-mcp": "/api-and-mcp.html",
  "/risk-controls": "/risk-controls.html",
  "/market-analysis": "/market-analysis.html",
  "/insights": "/insights.html",
  "/terms": "/terms.html",
  "/privacy": "/privacy.html",
  "/verify": "/verify.html",
  "/seal": "/seal.html",
  "/snap": "/snap.html",
  "/oath": "/oath.html",
  "/arena": "/arena.html",
  "/record": "/record.html",
  "/flywheel": "/flywheel.html",
  "/community": "/community.html",
  "/roadmap": "/roadmap.html",
  "/launch-on-x": "/launch-on-x.html",
  "/badge": "/badge.html",
  "/gate-bot": "/gate-bot.html",
  "/stats": "/stats.html",
  "/swap": "/swap.html",
  "/stake": "/stake.html",
  "/zero": "/zero.html",
  "/safety": "/safety.html",
  "/proof": "/proof.html",
  "/changelog/agent-wallet": "/changelog/agent-wallet.html",
  "/agent": "/agent/index.html",
};

// F16: Lighter on Robinhood Chain is called from the browser (its API answers CORS; keys never touch this server)
const EXTRA_CONNECT = ["https://api.rh.lighter.xyz", "wss://api.rh.lighter.xyz", ...(process.env.CSP_CONNECT || "").split(/[\s,]+/)].filter(Boolean).join(" ");
// WalletConnect for phone wallets (public/agent/js/walletconnect.js, provider self-hosted under /vendor/walletconnect). The
// projectId (dashboard.reown.com) is public by design: every visitor's browser sends it to the relay. Without one the
// connect sheet leaves the option out and the policy below stays as it was. With one: the relay socket (connect-src) and
// WalletConnect Verify, a hidden frame that vouches for this domain to the wallet (frame-src). Telemetry is off in the app.
const WC_PROJECT_ID = /^[0-9a-f]{32}$/i.test(process.env.WALLETCONNECT_PROJECT_ID || "") ? process.env.WALLETCONNECT_PROJECT_ID : null;
if (process.env.WALLETCONNECT_PROJECT_ID && !WC_PROJECT_ID) console.warn("[walletconnect] WALLETCONNECT_PROJECT_ID is not a 32-character hex project ID: the phone wallet option stays off");
const WC_CONNECT = WC_PROJECT_ID ? " wss://relay.walletconnect.org wss://relay.walletconnect.com" : "";
const WC_FRAME = WC_PROJECT_ID ? ["frame-src 'self' https://verify.walletconnect.org https://verify.walletconnect.com"] : [];
// Wallets talk to chains through our own /api/rpc proxy, so connect-src can stay 'self'.
function csp(path, data) {
  if (!path.endsWith(".html") || path.split("/").some((seg) => seg.startsWith("_"))) return "frame-ancestors 'none'";
  const hashes = [...data.toString("utf8").matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trim(), "worker-src 'self' blob:",
    `connect-src 'self' ${EXTRA_CONNECT}${WC_CONNECT}`.trim(), "img-src 'self' data: blob: https:", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    ...WC_FRAME, "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

// How long a browser keeps a file before it asks again. Every answer carries an ETag, so asking again costs a 304, not the bytes.
function cacheControl(path) {
  // the Lighter signer must match Lighter's live API, so it is checked on every load like code
  if (path.startsWith("/vendor/lighter/")) return "no-cache";
  // fonts and vendor libraries keep their bytes for as long as their URL lives: a new version needs a new file name (or a ?v=
  // on every reference), otherwise returning visitors keep the old one for a year
  if (/^\/(vendor|fonts|home\/fonts)\//.test(path)) return "public, max-age=31536000, immutable";
  if (/\.(html|js|mjs|css|json)$/.test(path)) return "no-cache";
  // artwork, logos and the 3D horse: a week (a changed image under the same name reaches returning visitors within 7 days)
  if (/^\/(img|home\/art|home\/logos)\//.test(path)) return "public, max-age=604800";
  return "public, max-age=3600";
}

const headers = (type, path, data) => ({
  "content-type": type,
  "cache-control": cacheControl(path),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": csp(path, data),
});

/* ---------- static files: validators and byte ranges ---------- */
// Part of every ETag: the headers a page is sent with (its CSP above all). When they change (CSP_CONNECT, a new policy in this
// file) a cached page must not be confirmed with a 304, which would keep the old policy in the browser.
const SIG = createHash("sha256").update(JSON.stringify(headers(TYPES[".html"], "/index.html", Buffer.alloc(0)))).digest("hex").slice(0, 8);
// weak, from size and mtime: no read needed, and Caddy leaves weak tags alone when it compresses
const etagOf = (st, variant = "") => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${SIG}${variant}"`;
// a tag without W/, quotes, or the "-gzip" / "-zstd" / "-br" a compressing proxy may append
const tagCore = (t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, "").replace(/-(gzip|zstd|br)$/, "");
const seconds = (ms) => Math.floor(ms / 1000) * 1000;   // HTTP dates have no milliseconds

// If-None-Match wins over If-Modified-Since (RFC 9110 13.2.2)
function notModified(req, etag, st) {
  const inm = req.headers["if-none-match"];
  if (inm) return inm.trim() === "*" || inm.split(",").some((t) => tagCore(t) === tagCore(etag));
  const since = Date.parse(req.headers["if-modified-since"] || "");
  return Number.isFinite(since) && seconds(st.mtimeMs) <= since;
}

// Video, the 3D horse and the Lighter signer are fetched in pieces: iPhone Safari plays an .mp4 only when Range gets a 206, and
// Chrome needs it to seek. The gzipped copy of the signer is always sent whole (its ranges would count gzip bytes).
const RANGED = new Set([".mp4", ".glb", ".wasm"]);
// "bytes=a-b", "bytes=a-" or "bytes=-n" → { start, end }. "unsatisfiable" → 416. null → the header is ignored and the whole
// file follows with 200, as RFC 9110 allows: a header we cannot read, or several ranges at once (no browser needs them for media)
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).replace(/\s+/g, ""));
  if (!m || (!m[1] && !m[2])) return null;
  const first = m[1] ? Number(m[1]) : null, last = m[2] ? Number(m[2]) : null;
  if (first === null) return last === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - last), end: size - 1 };
  if (first >= size || (last !== null && last < first)) return "unsatisfiable";
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}
// If-Range: the range only counts when the client's copy is still current. Our tags are weak and a weak tag never matches here
// (RFC 9110 13.1.5), so browsers send the Last-Modified date, which must match to the second.
function rangeStillValid(req, st) {
  const v = req.headers["if-range"];
  if (!v) return true;
  if (/^\s*(W\/)?"/.test(v)) return false;
  return Date.parse(v) === seconds(st.mtimeMs);
}

// streamed, not read into memory (the film is 24 MB); a closed tab just ends the stream
const pipe = (res, file, opts) => pipeline(createReadStream(file, opts), res, () => {});

async function sendFile(req, res, file, path, st) {
  const ext = extname(file), type = TYPES[ext] || "application/octet-stream";
  const head = req.method === "HEAD", get = req.method === "GET";
  let src = file, variant = "";
  // the Lighter signer (7.6 MB) goes out pre-gzipped (2.4 MB) when the browser accepts it
  if (ext === ".wasm" && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    const gz = await stat(file + ".gz").catch(() => null);
    if (gz?.isFile()) { src = file + ".gz"; st = gz; variant = "-gz"; }
  }
  const ranged = RANGED.has(ext) && !variant;
  // a page with live numbers (server/livehtml.mjs) carries their version in its tag: a cached copy is not confirmed once they
  // move, and a date alone (If-Modified-Since, the file's mtime) never confirms it
  const live = ext === ".html" ? liveTag(path) : "";
  const validators = {
    "cache-control": cacheControl(path), etag: etagOf(st, variant + live), "last-modified": new Date(st.mtimeMs).toUTCString(),
    ...(ext === ".wasm" ? { vary: "accept-encoding" } : {}),
  };
  if ((get || head) && !(live && !req.headers["if-none-match"]) && notModified(req, validators.etag, st)) { res.writeHead(304, validators).end(); return; }

  if (ext === ".html") {                            // pages are small and their CSP hashes the inline scripts: read whole
    const data = liveHtml(path, await readFile(file));
    res.writeHead(200, { ...headers(type, path, data), ...validators, "content-length": data.length });
    res.end(head ? undefined : data);
    return;
  }
  const base = { ...headers(type, path), ...validators, ...(ranged ? { "accept-ranges": "bytes" } : {}) };
  const range = ranged && get && req.headers.range && rangeStillValid(req, st) ? byteRange(req.headers.range, st.size) : null;
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...base, "content-range": `bytes */${st.size}`, "content-length": 0 }).end();
    return;
  }
  if (range) {
    // no-transform: a compressing proxy must not touch a partial answer (its byte counts would no longer add up)
    res.writeHead(206, { ...base, "cache-control": `${base["cache-control"]}, no-transform`,
      "content-range": `bytes ${range.start}-${range.end}/${st.size}`, "content-length": range.end - range.start + 1 });
    pipe(res, src, range);
    return;
  }
  res.writeHead(200, { ...base, "content-length": st.size, ...(variant ? { "content-encoding": "gzip" } : {}) });
  if (head) res.end(); else pipe(res, src);
}

await initApi({ dataDir: process.env.DATA_DIR || join(HERE, "data"), root: HERE });

async function serve(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/.well-known/x402") url.pathname = "/api/gate/x402/well-known";   // x402 discovery (x402scan, Agent402)
  // every claim on the site with its evidence, live (server/proof.mjs); read by checkers and agents from any origin
  if (url.pathname === "/proof.json") url.pathname = "/api/proof/claims";
  // V7 F38: the Troya Snap (MetaMask runs it with origin "null") and other bots call these cross-origin; no cookies are involved
  if (url.pathname === "/api/gate/tx" || url.pathname === "/api/gate/feed") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  }
  // V8 F45: the remote MCP endpoint (server/mcp.mjs) also answers at /mcp. MCP clients, agents and browser tools call it, the
  // skill file and llms.txt from any origin; no cookies are read there, an optional API token comes in a header
  if (url.pathname === "/mcp" || url.pathname === "/mcp/") url.pathname = "/api/mcp";
  if (url.pathname === "/api/mcp" || url.pathname === "/agent/api/mcp") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-session-id, last-event-id");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  }
  if (url.pathname === "/skill.md" || url.pathname === "/llms.txt") res.setHeader("access-control-allow-origin", "*");
  // the WalletConnect projectId for the connect sheet (null: the phone wallet option stays hidden). Read when the sheet opens.
  if ((url.pathname === "/api/walletconnect" || url.pathname === "/agent/api/walletconnect") && (req.method === "GET" || req.method === "HEAD")) {
    const body = JSON.stringify({ projectId: WC_PROJECT_ID });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  // share links with their own link preview: /t/<coin> (and its .png), /r/<referral code> (server/share.mjs). A link to
  // /agent#/token/… cannot have one: the part after "#" never reaches the server, so every coin showed the same og.png
  if (url.pathname.startsWith("/t/") || url.pathname.startsWith("/r/")) { if (await handleShare(req, res, url)) return; }
  if (await handleApi(req, res, url)) return;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request"); return; }
  if (path.length > 1 && path.endsWith("/") && ROUTES[path.slice(0, -1)]) path = path.slice(0, -1);
  path = ROUTES[path] || path;
  if (path.endsWith("/")) path += "index.html";
  if (PUBLIC && path.split("/").some((seg) => seg.startsWith("_"))) path = "/404";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw 0;
    // the cache rules read the resolved path, so "/vendor%2F..%2Fimg/…" cannot borrow the year-long vendor rule
    await sendFile(req, res, file, file.slice(ROOT.length).split(sep).join("/"), st);
    return;
  } catch {
    if (res.headersSent) { res.destroy(); return; }   // the file vanished mid-answer (a deploy swapping it): drop the connection
  }
  const page = await readFile(join(ROOT, "404.html")).catch(() => null);
  if (page) { res.writeHead(404, headers(TYPES[".html"], "/404.html", page)); res.end(req.method === "HEAD" ? undefined : page); }
  else res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
}

/* ---------- graceful stop ---------- */
// systemd stops the service with SIGTERM on every deploy and restart. Node used to die on the spot: an open chat answer broke off
// and requests arriving meanwhile got a 502. Now the listener closes first (Caddy holds new requests and retries until the new
// process listens: lb_try_duration in deploy.sh), running requests finish, a chat stream gets a few seconds and is then closed
// with a line the chat shows, and the process leaves after 8 s at the latest (systemd's TimeoutStopSec=10 is the backstop).
const open = new Set();                            // responses still being written
let stopping = false;

const server = createServer((req, res) => {
  open.add(res);
  res.on("close", () => open.delete(res));
  if (stopping) res.setHeader("connection", "close");   // a request on a kept-alive connection: answer it, then let go
  serve(req, res).catch((e) => {
    console.error("[serve]", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  });
});
server.listen(PORT, HOST, () => console.log(`TROYA AGENT → http://${HOST}:${PORT}`));

const STREAM_GRACE_MS = 3000, STOP_LIMIT_MS = 8000;
const RESTART_NOTE = "Troya is restarting for an update. Send your message again in a few seconds.";
// handlers set the type with writeHead(status, {…}), which getHeader() does not always see: read the header block that went out
const isEventStream = (res) => /text\/event-stream/i.test(String(res.getHeader("content-type") || res._header || ""));

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[serve] ${signal}: finishing ${open.size} open request(s), then exit`);
  server.close(() => process.exit(0));             // runs once the last connection has closed
  for (const res of open) if (!res.headersSent) res.setHeader("connection", "close");
  // idle kept-alive connections close now, and each busy one as soon as its answer is done
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 200).unref();
  // the event shape is the assistant's own error event, so the chat prints the note where the answer would have been
  setTimeout(() => {
    for (const res of open) {
      if (res.writableEnded || !isEventStream(res)) continue;
      res.write(`event: error\ndata: ${JSON.stringify({ error: RESTART_NOTE })}\n\n`);
      res.end();
    }
  }, STREAM_GRACE_MS).unref();
  setTimeout(() => process.exit(0), STOP_LIMIT_MS).unref();
}
// server/tribute.mjs saves its cache on SIGTERM too; its listener runs first and sees ours, so it leaves the exit to us
process.on("SIGTERM", () => stop("SIGTERM"));
