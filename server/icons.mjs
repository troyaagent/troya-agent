// Icons: token logos for Robinhood Chain tokens and coin logos for Hyperliquid markets, fetched once and kept on disk.
//   GET /api/icon/token/:address  → image bytes (GeckoTerminal image → DexScreener profile → Pons on-chain logo → known brand logo), 404 when none exists
//   GET /api/icon/coin/:coin      → Hyperliquid coin SVG (perps, HIP-3 "dex:COIN", spot "COIN_spot")
// Upstream URLs come from public token metadata, so every fetch is https-only, size-capped and blocked from private networks.
import { promises as fs } from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const COIN_RE = /^[A-Za-z0-9:._-]{1,40}$/;
const MAX_BYTES = 3 * 1024 * 1024;
const POS_TTL = 7 * 86400_000;   // re-check a found logo weekly
const NEG_TTL = 6 * 3600_000;    // re-check a missing logo after 6 h
const UA = { "user-agent": "troya-agent/0.1 (+icons)", accept: "image/*,application/json;q=0.8" };

// brand logos for well-known Robinhood Chain contracts (served from /img/logos)
const KNOWN = {
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "eth-color.svg",   // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "usdg.png",  // USDG
};
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };
const TYPE = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif" };

let DIR, PUBLIC_LOGOS, marketMod;
// stock tokens show their company's logo, self-hosted in /img/logos/stocks/<TICKER>.png (vetted by hand, 18 Nov 2026):
// the token indexes return the Robinhood feather for every stock, which made Tesla, Nvidia and the rest look the same
const STOCK_LOGO = new Map();   // lower(address) → ticker
const index = new Map();  // key → { t, file|null }
const inflight = new Map();

export async function register(r, ctx) {
  DIR = path.join(ctx.dataDir, "icons");
  PUBLIC_LOGOS = path.join(ctx.root, "public", "img", "logos");
  await fs.mkdir(DIR, { recursive: true });
  try { for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(path.join(DIR, "index.json"), "utf8")))) index.set(k, v); } catch {}
  import("./market.mjs").then((m) => { marketMod = m; }).catch(() => {});
  import("./robinhood.mjs").then((m) => { for (const x of m.STOCKS || []) STOCK_LOGO.set(String(x.address).toLowerCase(), String(x.symbol).toUpperCase()); }).catch(() => {});
  // every stock token on the stocks desk (203 on 18 Nov), not only the 63 in the market list; refreshed every 6 h
  const deskStocks = () => import("./stocks.mjs").then((m) => m.stockDesk()).then((d) => { for (const x of d?.assets || []) if (x.address && x.symbol) STOCK_LOGO.set(String(x.address).toLowerCase(), String(x.symbol).toUpperCase()); }).catch(() => {});
  setTimeout(deskStocks, 10_000).unref?.(); setInterval(deskStocks, 6 * 3600_000).unref?.();
  const stockFile = async (ticker) => { const f = path.join(PUBLIC_LOGOS, "stocks", `${String(ticker).replace(/[^A-Z0-9.]/g, "")}.png`); try { await fs.access(f); return f; } catch { return null; } };

  r.get("/api/icon/token/:address", async ({ params, query, res }) => {
    // ?chain=base|arbitrum|solana for tokens on the other chains Troya trades (Robinhood Chain when absent)
    const chain = OTHER.has(String(query.chain || "")) ? String(query.chain) : "robinhood";
    const raw = String(params.address || "");
    const a = chain === "solana" ? raw : raw.toLowerCase();
    if (chain === "solana" ? !SOL_RE.test(a) : !ADDR_RE.test(a)) return sendErr(res, 400, "Not a token address");
    if (chain === "robinhood" && STOCK_LOGO.has(a)) { const f = await stockFile(STOCK_LOGO.get(a)); if (f) return sendFile(res, f); }
    if (chain === "robinhood" && KNOWN[a]) { try { await fs.access(path.join(PUBLIC_LOGOS, KNOWN[a])); return sendFile(res, path.join(PUBLIC_LOGOS, KNOWN[a])); } catch {} }
    if (chain !== "robinhood" && KNOWN_OTHER[`${chain}:${a.toLowerCase()}`]) { try { const f = path.join(PUBLIC_LOGOS, KNOWN_OTHER[`${chain}:${a.toLowerCase()}`]); await fs.access(f); return sendFile(res, f); } catch {} }
    const file = chain === "robinhood" ? await resolve(`r:${a}`, () => tokenSources(a)) : await resolve(`${chain}:${a}`, () => otherSources(chain, a));
    return file ? sendFile(res, file) : sendErr(res, 404, "No logo for this token");
  }, { weight: 0.2, perMin: 3000 });

  r.get("/api/icon/coin/:coin", async ({ params, res }) => {
    const c = String(params.coin || "");
    if (!COIN_RE.test(c)) return sendErr(res, 400, "Not a market name");
    // HIP-3 stock perps ("xyz:TSLA") share the stock token's vetted logo
    const tk = /^[a-z0-9]+:([A-Z][A-Z0-9.]{0,9})$/.exec(c)?.[1];
    if (tk) { const f = await stockFile(tk); if (f) return sendFile(res, f); }
    // a plain ticker (Lighter lists stocks as "SPY", "NVDA") is a coin first: ZETA is ZetaChain, not Zeta Global.
    // Only when Hyperliquid has no coin logo for it does the stock logo stand in.
    if (/^[A-Z][A-Z0-9.]{0,9}$/.test(c) && await stockFile(c)) {
      const coin = await resolve(`c:${c}`, () => coinSources(c));
      return sendFile(res, coin || await stockFile(c));
    }
    const file = await resolve(aliasOf(c) ? `ca:${c}` : `c:${c}`, () => coinSources(c));   // ca: a fresh key for aliased names (they were cached as missing)
    return file ? sendFile(res, file) : sendErr(res, 404, "No logo for this market");
  }, { weight: 0.2, perMin: 3000 });
}

/* ---------- sources ---------- */
// tokens on Base, Arbitrum and Solana: GeckoTerminal's token image, then DexScreener's
const OTHER = new Set(["base", "arbitrum", "solana"]);
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KNOWN_OTHER = {
  "base:0x4200000000000000000000000000000000000006": "eth-color.svg", "arbitrum:0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "eth-color.svg",
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "usdc.svg", "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": "usdc.svg",
  "arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548": "arbitrum-disc.svg",
};
async function otherSources(chain, a) {
  const out = [];
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${a}`, { headers: { accept: "application/json", "user-agent": UA["user-agent"] }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const img = (await r.json())?.data?.attributes?.image_url; if (img && /^https:/.test(img) && !/missing/.test(img)) out.push(img); }
  } catch {}
  const ds = await dexscreenerImage(a, chain).catch(() => null);
  if (ds) out.push(ds);
  return out;
}
async function tokenSources(a) {
  const out = [];
  const fromIndex = marketMod?.imageFor?.(a);
  if (fromIndex) out.push(fromIndex);
  const ds = await dexscreenerImage(a, "robinhood").catch(() => null);
  if (ds) out.push(ds);
  // Pons coins keep their logo on chain (an ipfs:// or https:// string in the token contract)
  try {
    const rh = await import("./robinhood.mjs");
    const prof = await rh.ponsProfile(a);
    if (prof?.logo) out.push(prof.logo);
  } catch {}
  return out;
}
// names Hyperliquid draws under another market id: Lighter's metals, wrapped spot tokens, pre-IPO and commodity perps
const METAL = { XAU: "xyz:GOLD", XAG: "xyz:SILVER", XPT: "xyz:PLATINUM", XAUT0: "xyz:GOLD",
  COPPER: "flx:COPPER", OPENAI: "vntl:OPENAI", ANTHROPIC: "vntl:ANTHROPIC", SOXL: "xyz:SOXL",
  UFART: "FARTCOIN", FXRP: "XRP", HPENGU: "PENGU", WMNT: "MNT", UUUSPX: "SPX", XMRN: "XMR", UBTC: "BTC", UZEC: "ZEC", UENA: "ENA", UXPL: "XPL", UPUMP: "PUMP" };
const aliasOf = (c) => METAL[c] || METAL[String(c).replace(/^[a-z0-9]+:/, "").replace(/_spot$/, "")] || null;
function coinSources(c) {
  const base = "https://app.hyperliquid.xyz/coins/";
  const u = (x) => `${base}${encodeURIComponent(x)}.svg`;
  const list = aliasOf(c) ? [u(aliasOf(c)), u(c)] : [u(c)];
  const bare = c.replace(/^[a-z0-9]+:/, "");
  if (bare !== c) list.push(u(bare));                                          // xyz:TSLA → TSLA
  const spot = bare.endsWith("_spot");
  const name = spot ? bare.slice(0, -5) : bare;
  if (spot) list.push(u(name)); else list.push(u(`${name}_spot`));
  // wrapped / bridged spot names: kPEPE → PEPE, UBTC → BTC (Unit), USDT0 → USDT, XMR1 → XMR, ONEAR → NEAR
  const alt = new Set();
  if (/^k[A-Z]/.test(name)) alt.add(name.slice(1));
  if (/^[UO][A-Z]{2,}/.test(name) && !/^(USDC|USDT|USDE|USDH|USD)/.test(name)) alt.add(name.slice(1));
  if (/^[A-Z]{2,}\d$/.test(name)) alt.add(name.slice(0, -1));
  for (const a of alt) list.push(u(a));
  return [...new Set(list)];
}
// DexScreener token profiles, batched per chain: requests arriving within 120 ms share one call (up to 30 addresses)
const dsQueues = new Map(); // chain → { list, timer }
function dexscreenerImage(a, chain) {
  return new Promise((resolve, reject) => {
    let q = dsQueues.get(chain);
    if (!q) dsQueues.set(chain, (q = { list: [], timer: null }));
    q.list.push({ a, resolve, reject });
    if (q.list.length >= 30) flushDs(chain);
    else if (!q.timer) q.timer = setTimeout(() => flushDs(chain), 120);
  });
}
async function flushDs(chain) {
  const q = dsQueues.get(chain);
  clearTimeout(q.timer); q.timer = null;
  const batch = q.list.splice(0, 30);
  if (q.list.length) q.timer = setTimeout(() => flushDs(chain), 120);
  if (!batch.length) return;
  const addrs = [...new Set(batch.map((x) => x.a))];
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${addrs.join(",")}`, { headers: { ...UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const list = res.ok ? await res.json() : [];
    const img = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      const u = p?.info?.imageUrl;
      const k = String(p?.baseToken?.address || "").toLowerCase();
      // DexScreener's CDN resizes on request; icons never need more than 128 px
      if (u && k && !img.has(k)) img.set(k, u.replace(/width=\d+&height=\d+/, "width=128&height=128"));
    }
    for (const x of batch) x.resolve(img.get(String(x.a).toLowerCase()) || null);
  } catch (e) { for (const x of batch) x.reject(e); }
}

/* ---------- resolve + cache ---------- */
async function resolve(key, sourcesFn) {
  const hit = index.get(key);
  const now = Date.now();
  // a miss caused by an upstream error (timeout, 5xx) is retried after 10 minutes, a real "no image" after 6 h
  if (hit && now - hit.t < (hit.file ? POS_TTL : hit.err ? 10 * 60_000 : NEG_TTL)) {
    if (!hit.file) return null;
    const f = path.join(DIR, hit.file);
    try { await fs.access(f); return f; } catch {}
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let file = null, err = false;
    try {
      for (const url of withIpfsMirrors(await sourcesFn())) {
        const got = await download(url).catch(() => { err = true; return null; });
        if (!got) continue;
        file = `${key.replace(/[^a-zA-Z0-9]/g, "_")}.${got.ext}`;
        await fs.writeFile(path.join(DIR, file), got.buf);
        break;
      }
    } catch { err = true; }
    // keep an old file if the refresh failed
    if (!file && hit?.file) { try { await fs.access(path.join(DIR, hit.file)); file = hit.file; } catch {} }
    index.set(key, file ? { t: Date.now(), file } : { t: Date.now(), file: null, ...(err ? { err: true } : {}) });
    saveIndex();
    return file ? path.join(DIR, file) : null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
let saveTimer = null;
function saveIndex() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const tmp = path.join(DIR, `index.json.${process.pid}.tmp`);
    try { await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(index))); await fs.rename(tmp, path.join(DIR, "index.json")); } catch {}
  }, 1500);
}

// Public IPFS gateways rate-limit busy server IPs (ipfs.io / dweb.link answer 429 from shared hosting), so every IPFS image
// also gets tried through other gateways before we give up on it.
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://w3s.link/ipfs/", "https://ipfs.io/ipfs/"];
function ipfsPath(u) {
  u = String(u || "").trim();
  if (u.startsWith("ipfs://")) return u.slice(7).replace(/^ipfs\//, "");
  let m = u.match(/^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{46,}(?:\/[^?#]*)?)/);
  if (m) return m[1];
  m = u.match(/^https:\/\/([a-z0-9]{50,})\.ipfs\.[^/]+(\/[^?#]*)?/);
  return m ? m[1] + (m[2] && m[2] !== "/" ? m[2] : "") : null;
}
function withIpfsMirrors(urls) {
  const out = [];
  for (const u of urls || []) {
    out.push(u);
    const p = ipfsPath(u);
    if (p) for (const g of IPFS_GATEWAYS) out.push(g + p);
  }
  return [...new Set(out)];
}
function normalizeUrl(u) {
  u = String(u || "").trim();
  if (u.startsWith("ipfs://")) u = "https://ipfs.io/ipfs/" + u.slice(7).replace(/^ipfs\//, "");
  return /^https:\/\//i.test(u) ? u : null;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}
async function download(raw, hops = 0) {
  const url = normalizeUrl(raw);
  if (!url) return null;
  const { hostname } = new URL(url);
  if (net.isIP(hostname) || /^localhost$/i.test(hostname)) return null;
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((x) => privateIp(x.address))) return null;
  const res = await fetch(url, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops < 3) return download(new URL(res.headers.get("location"), url).href, hops + 1);
  if (!res.ok) { if (res.status >= 500 || res.status === 429) throw new Error(`upstream ${res.status}`); return null; }   // an outage, not "no image"
  const ct = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const c of res.body) { size += c.length; if (size > MAX_BYTES) return null; chunks.push(c); }
  const buf = Buffer.concat(chunks);
  const ext = EXT[ct] || sniff(buf);
  if (!ext || buf.length < 40) return null;
  if (ext === "svg" && !/<svg[\s>]/i.test(buf.subarray(0, 2048).toString("utf8"))) return null;
  return { buf, ext };
}
function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  if (b.subarray(0, 3).toString() === "GIF") return "gif";
  if (b.subarray(4, 12).toString().includes("ftypavif")) return "avif";
  if (/<svg[\s>]/i.test(b.subarray(0, 2048).toString("utf8"))) return "svg";
  return null;
}

/* ---------- responses ---------- */
async function sendFile(res, file) {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, {
    "content-type": TYPE[ext] || "application/octet-stream",
    "cache-control": "public, max-age=86400",
    "x-content-type-options": "nosniff",
    // an SVG opened directly must not run anything
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(buf);
}
function sendErr(res, status, error) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": status === 404 ? "public, max-age=3600" : "no-store" });
  res.end(JSON.stringify({ error }));
}
