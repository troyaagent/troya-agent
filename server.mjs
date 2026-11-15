// TROYA AGENT — site + app + API. `npm run serve` → http://127.0.0.1:9270
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initApi, handleApi } from "./server/api.mjs";

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
  "/badge": "/badge.html",
  "/agent": "/agent/index.html",
};

const EXTRA_CONNECT = (process.env.CSP_CONNECT || "").split(/[\s,]+/).filter(Boolean).join(" ");
// Wallets talk to chains through our own /api/rpc proxy, so connect-src can stay 'self'.
function csp(path, data) {
  if (!path.endsWith(".html") || path.split("/").some((seg) => seg.startsWith("_"))) return "frame-ancestors 'none'";
  const hashes = [...data.toString("utf8").matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trim(), "worker-src 'self' blob:",
    `connect-src 'self' ${EXTRA_CONNECT}`.trim(), "img-src 'self' data: blob: https:", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

const headers = (type, path, data) => ({
  "content-type": type,
  "cache-control": /\.(html|js|mjs|css|json)$/.test(path) ? "no-cache" : "public, max-age=3600",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": csp(path, data),
});

await initApi({ dataDir: process.env.DATA_DIR || join(HERE, "data"), root: HERE });

async function serve(req, res) {
  const url = new URL(req.url, "http://x");
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
    if (!(await stat(file)).isFile()) throw 0;
    const type = TYPES[extname(file)] || "application/octet-stream";
    const data = await readFile(file);
    res.writeHead(200, headers(type, path, data));
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    const page = await readFile(join(ROOT, "404.html")).catch(() => null);
    if (page) { res.writeHead(404, headers(TYPES[".html"], "/404.html", page)); res.end(req.method === "HEAD" ? undefined : page); }
    else res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

createServer((req, res) => {
  serve(req, res).catch((e) => {
    console.error("[serve]", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  });
}).listen(PORT, HOST, () => console.log(`TROYA AGENT → http://${HOST}:${PORT}`));
