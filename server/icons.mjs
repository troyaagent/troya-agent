// Icons: token logos for Robinhood Chain tokens and coin logos for Hyperliquid and Lighter markets, fetched once and kept on disk.
//   GET /api/icon/token/:address  → the token's logo: vetted stock logo (stocks.mjs overrides, then /img/logos/stocks) → known brand
//                                  logo → GeckoTerminal image → DexScreener profile → Blockscout PRO icon_url → Pons on-chain logo →
//                                  tokenURI() metadata (Long, Bankr and other launchpads keep the image there) → a generated
//                                  monogram. A Robinhood Chain token never answers 404 (other chains do, see the route).
//   GET /api/icon/coin/:coin      → Hyperliquid coin logo (perps, HIP-3 "dex:COIN", spot "COIN_spot", Lighter "COIN" and "COIN/USDG"),
//                                  aliased to the stock or perp logo where that is the same asset (ANT → xyz:ANT, SPY_spot → SPY,
//                                  TSLAX_spot → TSLA), else a monogram. Never 404.
// Every logo is kept as downloaded and as a 96 px copy made here, and pages get the copy: a 24–32 px tile never needs a 3 MB
// traced SVG or a 400 KB photo. The copy is a PNG (the project has no image library; WebP would need one such as sharp).
// Upstream URLs come from public token metadata, so every fetch is https-only, size-capped and blocked from private networks.
import { promises as fs } from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { Interface } from "ethers";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const COIN_RE = /^[A-Za-z0-9:._/-]{1,40}$/;
const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_BYTES = 3 * 1024 * 1024;
const POS_TTL = 7 * 86400_000;   // re-check a found logo weekly
const NEG_TTL = 3600_000;        // a token without a logo is looked up again after an hour (a DexScreener profile may have appeared)
const DEEP_TTL = 6 * 3600_000;   // …but Blockscout and the on-chain metadata, which rarely change, only every 6 h
const ERR_TTL = 10 * 60_000;     // a miss caused by an upstream error (timeout, 5xx) is retried after 10 minutes
const MONO_MAX_AGE = 6 * 3600;   // browsers keep a monogram 6 h, so a logo that turns up later shows the same day
const SMALL = 96;                // the served copy: 96 px covers a 32 px tile on a 3x screen
const UA = { "user-agent": "troya-agent/0.1 (+icons)", accept: "image/*,application/json;q=0.8" };
const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";   // an SVG opened directly must not run anything

// brand logos for well-known Robinhood Chain contracts (served from /img/logos)
const KNOWN = {
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "eth-color.svg",   // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "usdg.png",  // USDG
};
// coins Troya draws with its own files: Lighter's "ETH/USDG", "PONS/USDG" and the like
const BRAND = { ETH: "eth-color.svg", WETH: "eth-color.svg", USDC: "usdc.svg", USDG: "usdg.png", SOL: "sol.svg", HYPE: "hyperliquid.svg", PONS: "pons.svg" };
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };
const TYPE = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif" };

let DIR, PUBLIC_LOGOS, marketMod;
let stocksP = Promise.resolve(null);   // stocks.mjs, for its logo overrides (Anthropic's mark for ANT)
// stock tokens show their company's logo, self-hosted in /img/logos/stocks/<TICKER>.png (vetted by hand, 18 Nov 2026):
// the token indexes return the Robinhood feather for every stock, which made Tesla, Nvidia and the rest look the same
const STOCK_LOGO = new Map();   // lower(address) → ticker
const STOCK_NAME = new Map();   // ticker → company name ("Tesla, Inc."), to tell a spot token named after a stock from a memecoin
const index = new Map();  // key → { t, file|null, small?, sym?, deepAt?, err? }
const inflight = new Map();
const making = new Map();  // key → promise of the 96 px copy being made

export async function register(r, ctx) {
  DIR = path.join(ctx.dataDir, "icons");
  PUBLIC_LOGOS = path.join(ctx.root, "public", "img", "logos");
  await fs.mkdir(DIR, { recursive: true });
  try { for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(path.join(DIR, "index.json"), "utf8")))) index.set(k, v); } catch {}
  import("./market.mjs").then((m) => { marketMod = m; }).catch(() => {});
  stocksP = import("./stocks.mjs").catch(() => null);
  import("./robinhood.mjs").then((m) => { for (const x of m.STOCKS || []) STOCK_LOGO.set(String(x.address).toLowerCase(), String(x.symbol).toUpperCase()); }).catch(() => {});
  // every stock token on the stocks desk (203 on 18 Nov), not only the 63 in the market list; refreshed every 6 h
  const deskStocks = () => stocksP.then((m) => m?.stockDesk()).then((d) => {
    for (const x of d?.assets || []) {
      if (!x.address || !x.symbol) continue;
      const t = String(x.symbol).toUpperCase();
      STOCK_LOGO.set(String(x.address).toLowerCase(), t);
      if (x.name) STOCK_NAME.set(t, String(x.name));
    }
  }).catch(() => {});
  setTimeout(deskStocks, 10_000).unref?.(); setInterval(deskStocks, 6 * 3600_000).unref?.();

  r.get("/api/icon/token/:address", async ({ params, query, res }) => {
    // ?chain=base|arbitrum|solana for tokens on the other chains Troya trades (Robinhood Chain when absent)
    const chain = OTHER.has(String(query.chain || "")) ? String(query.chain) : "robinhood";
    const raw = String(params.address || "");
    const a = chain === "solana" ? raw : raw.toLowerCase();
    if (chain === "solana" ? !SOL_RE.test(a) : !ADDR_RE.test(a)) return sendErr(res, 400, "Not a token address");
    if (chain === "robinhood") {
      const own = await stockLogo(STOCK_LOGO.get(a), a);
      if (own) return sendLogo(res, own);
      if (KNOWN[a] && await exists(path.join(PUBLIC_LOGOS, KNOWN[a]))) return sendFile(res, path.join(PUBLIC_LOGOS, KNOWN[a]));
      const file = await resolve(`r:${a}`, (o) => tokenSources(a, o));
      if (file) return sendFile(res, file);
      // no logo anywhere: the letter tile the app would draw, as an image, so the page logs no 404
      const hit = index.get(`r:${a}`);
      return sendMonogram(res, hit?.sym || marketMod?.indexRow?.(a)?.symbol || "", a, 2, !!hit?.err);
    }
    if (KNOWN_OTHER[`${chain}:${a.toLowerCase()}`]) { const f = path.join(PUBLIC_LOGOS, KNOWN_OTHER[`${chain}:${a.toLowerCase()}`]); if (await exists(f)) return sendFile(res, f); }
    const file = await resolve(`${chain}:${a}`, () => otherSources(chain, a));
    // Base, Arbitrum and Solana keep the 404: their token lists carry a logo URL of their own (Jupiter, KyberSwap …) that the
    // app tries after this proxy, and only an error makes it move on. A monogram here would hide those logos.
    return file ? sendFile(res, file) : sendErr(res, 404, "No logo for this token");
  }, { weight: 0.2, perMin: 3000 });

  r.get("/api/icon/coin/:coin", async ({ params, res }) => {
    const raw = String(params.coin || "");
    if (!COIN_RE.test(raw)) return sendErr(res, 400, "Not a market name");
    // Lighter: "ANT" is Anthropic (the xyz:ANT logo), and a spot pair ("AAPL/USDG") wears its base coin's logo
    const c = BARE_ALIAS[raw] || raw.split("/")[0];
    if (!c) return sendMonogram(res, raw, raw, 1);
    const prefixed = /^[a-z0-9]+:/.test(c), bare = c.replace(/^[a-z0-9]+:/, "");
    const spot = bare.endsWith("_spot"), name = spot ? bare.slice(0, -5) : bare;
    if (!prefixed && BRAND[name] && await exists(path.join(PUBLIC_LOGOS, BRAND[name]))) return sendFile(res, path.join(PUBLIC_LOGOS, BRAND[name]));
    // HIP-3 stock perps ("xyz:TSLA") share the stock token's vetted logo
    if (prefixed && TICKER_RE.test(name)) { const s = await stockLogo(name); if (s) return sendLogo(res, s); }
    // a spot token that is a stock (Wrapped Apple xStock, or SPY with no other name) wears that stock's logo
    if (spot) { const t = await spotStock(name); const s = t && await stockLogo(t); if (s) return sendLogo(res, s); }
    // a plain ticker (Lighter lists stocks as "SPY", "NVDA") is a coin first: ZETA is ZetaChain, not Zeta Global.
    // Only when Hyperliquid has no coin logo for it does the stock logo stand in.
    if (!prefixed && !spot && TICKER_RE.test(name)) {
      const s = await stockLogo(name);
      if (s) { const coin = await resolve(`c:${c}`, () => coinSources(c)); return coin ? sendFile(res, coin) : sendLogo(res, s); }
    }
    const key = aliasOf(c) ? `ca:${c}` : `c:${c}`;   // ca: a fresh key for aliased names (they were cached as missing)
    const file = await resolve(key, () => coinSources(c));
    return file ? sendFile(res, file) : sendMonogram(res, c, c, 1, !!index.get(key)?.err);
  }, { weight: 0.2, perMin: 3000 });
}

/* ---------- stock logos ---------- */
// a vetted stock logo: stocks.mjs's overrides first (Anthropic's mark for ANT is an SVG), then /img/logos/stocks/<TICKER>.png
async function stockLogo(ticker, address) {
  const sm = await stocksP;
  const o = sm?.logoOverride?.(address, ticker);
  if (o) return { buf: o.body, type: o.type };
  const t = String(ticker || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
  if (!t) return null;
  const f = path.join(PUBLIC_LOGOS, "stocks", `${t}.png`);
  return (await exists(f)) ? { file: f } : null;
}
// Hyperliquid spot token names → full names ("AAPLX" → "Wrapped Apple xStock", "ANT" → "ANT POWER"), refreshed every 6 h:
// a spot token wears a stock logo only when it is that stock, so ANT POWER does not get Anthropic's mark
let spotNames = null, spotNamesAt = 0, spotNamesP = null;
function spotFullNames() {
  if (spotNamesAt && Date.now() - spotNamesAt < 6 * 3600_000) return Promise.resolve(spotNames);
  if (!spotNamesP) spotNamesP = (async () => {
    try {
      const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA["user-agent"] },
        body: JSON.stringify({ type: "spotMeta" }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`spotMeta ${r.status}`);
      const j = await r.json();
      spotNames = new Map((j?.tokens || []).map((t) => [String(t.name), t.fullName == null ? null : String(t.fullName)]));
      spotNamesAt = Date.now();
    } catch { spotNamesAt = Date.now() - 6 * 3600_000 + 10 * 60_000; }   // asked again in 10 minutes, not on every request
    finally { spotNamesP = null; }
    return spotNames;
  })();
  return spotNamesP;
}
// "AAPLX" (Wrapped Apple xStock) → AAPL, "USPYX" (Unit SP500 xStock) → SPY, "ANTX" → ANT, "TSLA" (Tesla - Wagyu.xyz) → TSLA,
// "SPY" with no full name → SPY. "ANT" (ANT POWER) and "CASH" (CASH) stay themselves.
async function spotStock(name, names) {
  names ??= await spotFullNames();
  if (!names || !names.has(name)) return null;   // unknown for now: no guess
  const full = names.get(name), cands = [];
  if (full && /stock|tokenized/i.test(full)) cands.push(name.replace(/X$/, ""), name.replace(/^U/, "").replace(/X$/, ""), name);
  else if (full === null) cands.push(name);
  else {
    const word = String(STOCK_NAME.get(name) || "").toLowerCase().match(/[a-z]{4,}/)?.[0];
    if (word && full.toLowerCase().includes(word)) cands.push(name);
  }
  for (const t of cands) if (TICKER_RE.test(t) && await stockLogo(t)) return t;
  return null;
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
  if (ds?.img) out.push(ds.img);
  return out;
}
// Robinhood Chain tokens. deep: also the slow sources (Blockscout, the token contract), run on the first look and every 6 h
async function tokenSources(a, { deep } = {}) {
  const out = [];
  let sym = marketMod?.indexRow?.(a)?.symbol || null, complete = true;
  const fromIndex = marketMod?.imageFor?.(a);   // GeckoTerminal's image, from the board listings
  if (fromIndex) out.push(fromIndex);
  const ds = await dexscreenerImage(a, "robinhood").catch(() => null);
  if (ds?.img) out.push(ds.img);
  sym ||= ds?.sym || null;
  if (deep) {
    // Blockscout PRO (the paid key the holder counts use): the icon a token's team set on the explorer
    const bs = await blockscoutToken(a);
    if (bs === undefined) complete = false;   // skipped (budget or paused): try again on the next look, not in 6 h
    if (bs?.icon) out.push(bs.icon);
    sym ||= bs?.sym || null;
    // Pons coins keep their logo on chain (an ipfs:// or https:// string in the token contract)
    try {
      const rh = await import("./robinhood.mjs");
      const prof = await rh.ponsProfile(a);
      if (prof?.logo) out.push(prof.logo);
    } catch {}
    // Long, Bankr and other launchpads: tokenURI() points to a JSON (usually on IPFS) whose image is the logo
    const md = await tokenUriMeta(a);
    if (md?.image) out.push(md.image);
    sym ||= md?.sym || null;
    if (!sym) { try { const m = await (await import("./robinhood.mjs")).tokenMeta(a); if (m?.symbol && m.symbol !== "?") sym = m.symbol; } catch {} }
  }
  return { urls: out, sym, deep: deep && complete };
}
// Blockscout: at most 120 icon lookups an hour, so the shared client (5 calls a second) stays free for holder counts.
// undefined = not asked (no key, paused, over budget); null = asked, nothing there
const BS_PER_HOUR = 120;
let bsWindow = 0, bsUsed = 0;
async function blockscoutToken(a) {
  if (!marketMod?.hasBlockscout?.() || !marketMod.blockscoutApi) return undefined;
  if (Date.now() - bsWindow > 3600_000) { bsWindow = Date.now(); bsUsed = 0; }
  if (bsUsed >= BS_PER_HOUR) return undefined;
  bsUsed++;
  try {
    const j = await marketMod.blockscoutApi(`/tokens/${a}`);
    const icon = typeof j?.icon_url === "string" && /^(https:|ipfs:)/i.test(j.icon_url.trim()) ? j.icon_url.trim() : null;
    return { icon, sym: typeof j?.symbol === "string" ? j.symbol : null };
  } catch { return null; }
}
const META_IFACE = new Interface(["function tokenURI() view returns (string)"]);
async function tokenUriMeta(a) {
  let uri;
  try {
    const rh = await import("./robinhood.mjs");
    const raw = await rh.rpc("robinhood", "eth_call", [{ to: a, data: META_IFACE.encodeFunctionData("tokenURI") }, "latest"], { timeoutMs: 8000 });
    if (!raw || raw === "0x") return null;
    uri = String(META_IFACE.decodeFunctionResult("tokenURI", raw)[0] || "").trim();
  } catch { return null; }   // no tokenURI() on this contract
  if (!uri) return null;
  let json = null;
  const data = /^data:application\/json(;base64)?,(.*)$/is.exec(uri);
  if (data) { try { json = JSON.parse(data[1] ? Buffer.from(data[2], "base64").toString("utf8") : decodeURIComponent(data[2])); } catch {} }
  else {
    for (const u of withIpfsMirrors([uri]).slice(0, 4)) {
      const got = await fetchSafe(u, 256 * 1024).catch(() => null);
      if (!got) continue;
      try { json = JSON.parse(got.buf.toString("utf8")); break; } catch {}
    }
  }
  if (!json || typeof json !== "object") return null;
  // Long writes the image as image_hash (ipfs://…), Bankr and most others as image
  const img = [json.image, json.image_url, json.imageUrl, json.logo, json.icon, json.image_hash].find((x) => typeof x === "string" && x.trim());
  return { image: img ? img.trim() : null, sym: typeof json.symbol === "string" ? json.symbol : null };
}
// names Hyperliquid draws under another market id: Lighter's metals, wrapped spot tokens, pre-IPO and commodity perps
const METAL = { XAU: "xyz:GOLD", XAG: "xyz:SILVER", XPT: "xyz:PLATINUM", XAUT0: "xyz:GOLD",
  COPPER: "flx:COPPER", OPENAI: "vntl:OPENAI", ANTHROPIC: "vntl:ANTHROPIC", SOXL: "xyz:SOXL",
  UFART: "FARTCOIN", FXRP: "XRP", HPENGU: "PENGU", WMNT: "MNT", UUUSPX: "SPX", XMRN: "XMR", UBTC: "BTC", UZEC: "ZEC", UENA: "ENA", UXPL: "XPL", UPUMP: "PUMP" };
// bare names only (not "ANT_spot", which is ANT POWER on Hyperliquid): Lighter's ANT is the Anthropic pre-IPO perp
const BARE_ALIAS = { ANT: "xyz:ANT" };
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
    const got = new Map();   // address → { img, sym }
    for (const p of Array.isArray(list) ? list : []) {
      const k = String(p?.baseToken?.address || "").toLowerCase();
      if (!k) continue;
      const u = p?.info?.imageUrl;
      const prev = got.get(k) || { img: null, sym: p?.baseToken?.symbol || null };
      // DexScreener's CDN resizes on request; icons never need more than 128 px
      if (u && !prev.img) prev.img = u.replace(/width=\d+&height=\d+/, "width=128&height=128");
      got.set(k, prev);
    }
    for (const x of batch) x.resolve(got.get(String(x.a).toLowerCase()) || null);
  } catch (e) { for (const x of batch) x.reject(e); }
}

/* ---------- resolve + cache ---------- */
async function resolve(key, sourcesFn) {
  const hit = index.get(key);
  const now = Date.now();
  if (hit && now - hit.t < (hit.file ? POS_TTL : hit.err ? ERR_TTL : NEG_TTL)) {
    if (!hit.file) return null;
    const f = await servable(key, hit);
    if (f) return f;
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let file = null, small, err = false, meta = {};
    // the slow lookups run on the first try, after an error and then every 6 h; a known miss in between only asks the
    // listings again, which is where a new logo usually turns up
    const deep = !hit || !!hit.file || !!hit.err || !hit.deepAt || now - hit.deepAt > DEEP_TTL;
    try {
      const got = await sourcesFn({ deep });
      if (got && !Array.isArray(got)) meta = got;
      for (const url of withIpfsMirrors(Array.isArray(got) ? got : got?.urls)) {
        const g = await download(url).catch(() => { err = true; return null; });
        if (!g) continue;
        file = `${key.replace(/[^a-zA-Z0-9]/g, "_")}.${g.ext}`;
        await fs.writeFile(path.join(DIR, file), g.buf);
        small = await makeSmall(file).catch(() => "");
        break;
      }
    } catch { err = true; }
    // keep an old file if the refresh failed
    if (!file && hit?.file && await exists(path.join(DIR, hit.file))) { file = hit.file; small = hit.small; }
    const sym = meta.sym || hit?.sym;
    const deepAt = deep && meta.deep !== false && !err ? Date.now() : hit?.deepAt;
    index.set(key, file
      ? { t: Date.now(), file, ...(small !== undefined ? { small } : {}), ...(sym ? { sym } : {}) }
      : { t: Date.now(), file: null, ...(sym ? { sym } : {}), ...(deepAt ? { deepAt } : {}), ...(err ? { err: true } : {}) });
    saveIndex();
    return file ? (small ? path.join(DIR, small) : path.join(DIR, file)) : null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
// the file to send: the 96 px copy, made now for a logo cached before copies existed, else the original
async function servable(key, hit) {
  if (!(await exists(path.join(DIR, hit.file)))) return null;
  if (hit.small === undefined) {
    let p = making.get(key);
    if (!p) {
      p = makeSmall(hit.file).catch(() => "").then((s) => { hit.small = s; saveIndex(); return s; }).finally(() => making.delete(key));
      making.set(key, p);
    }
    await p;
  }
  if (hit.small && await exists(path.join(DIR, hit.small))) return path.join(DIR, hit.small);
  return path.join(DIR, hit.file);
}
// "" when a copy would not be clearly smaller than the original (a 3 KB WebP, a small vector SVG)
async function makeSmall(file) {
  const buf = await fs.readFile(path.join(DIR, file));
  const ext = path.extname(file).slice(1).toLowerCase();
  const out = await queued(() => shrink(buf, ext));
  if (!out || out.buf.length > buf.length * 0.8) return "";
  const name = `${file.replace(/\.[a-z0-9]+$/i, "")}.s${SMALL}.${out.ext}`;
  await fs.writeFile(path.join(DIR, name), out.buf);
  return name;
}
// one image at a time: a crawl of a new page does not decode thirty logos at once
let chain_ = Promise.resolve();
function queued(fn) { const p = chain_.then(fn, fn); chain_ = p.catch(() => {}); return p; }
let saveTimer = null;
function saveIndex() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const tmp = path.join(DIR, `index.json.${process.pid}.tmp`);
    try { await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(index))); await fs.rename(tmp, path.join(DIR, "index.json")); } catch {}
  }, 1500);
}
const exists = (f) => fs.access(f).then(() => true, () => false);

// Public IPFS gateways rate-limit busy server IPs (ipfs.io / dweb.link answer 429 from shared hosting), so every IPFS image
// is tried through other gateways first, and ipfs.io last.
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://w3s.link/ipfs/", "https://ipfs.io/ipfs/"];
function ipfsPath(u) {
  u = String(u || "").trim();
  if (u.startsWith("ipfs://")) return u.slice(7).replace(/^ipfs\//, "");
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(\/[^?#]*)?$/.test(u)) return u;   // a bare CID
  let m = u.match(/^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{46,}(?:\/[^?#]*)?)/);
  if (m) return m[1];
  m = u.match(/^https:\/\/([a-z0-9]{50,})\.ipfs\.[^/]+(\/[^?#]*)?/);
  return m ? m[1] + (m[2] && m[2] !== "/" ? m[2] : "") : null;
}
function withIpfsMirrors(urls) {
  const out = [];
  for (const u of urls || []) {
    const p = ipfsPath(u);
    if (p) for (const g of IPFS_GATEWAYS) out.push(g + p);
    if (!p || /^https:/i.test(String(u).trim())) out.push(String(u).trim());
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
// GET with the guards above: https only, public addresses only, at most 3 redirects and `max` bytes. null = nothing there;
// throws on an outage (5xx, 429, timeout) so the caller can retry sooner
async function fetchSafe(raw, max, hops = 0) {
  const url = normalizeUrl(raw);
  if (!url) return null;
  const { hostname } = new URL(url);
  if (net.isIP(hostname) || /^localhost$/i.test(hostname)) return null;
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((x) => privateIp(x.address))) return null;
  const res = await fetch(url, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops < 3) return fetchSafe(new URL(res.headers.get("location"), url).href, max, hops + 1);
  if (!res.ok) { if (res.status >= 500 || res.status === 429) throw new Error(`upstream ${res.status}`); return null; }   // an outage, not "no image"
  const ct = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (Number(res.headers.get("content-length") || 0) > max) return null;
  const chunks = [];
  let size = 0;
  for await (const c of res.body) { size += c.length; if (size > max) return null; chunks.push(c); }
  return { buf: Buffer.concat(chunks), ct };
}
async function download(raw) {
  const got = String(raw || "").startsWith("data:image/") ? dataImage(raw) : await fetchSafe(raw, MAX_BYTES);
  if (!got) return null;
  const { buf, ct } = got;
  const ext = EXT[ct] || sniff(buf);
  if (!ext || buf.length < 40) return null;
  if (ext === "svg" && !/<svg[\s>]/i.test(buf.subarray(0, 2048).toString("utf8"))) return null;
  return { buf, ext };
}
// an image written inline in token metadata (data:image/svg+xml;base64,…)
function dataImage(u) {
  const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(String(u));
  if (!m || m[3].length > MAX_BYTES * 1.4) return null;
  try { return { buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8"), ct: m[1].toLowerCase() }; } catch { return null; }
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

/* ---------- the 96 px copy ---------- */
// PNG and JPEG are decoded here and scaled down; a big SVG is painted to a PNG when it is made of plain filled shapes (the
// traced 1–3 MB logos Hyperliquid serves), or keeps its vectors with any photo inside scaled down. WebP, GIF and AVIF stay
// as they are (DexScreener's are already 128 px).
const MAX_PIXELS = 12_000_000;   // bigger images are left alone: decoding them would hold ~100 MB
const SVG_KEEP = 24_000;         // a vector SVG under this is smaller than any PNG of it
async function shrink(buf, ext) {
  if (ext === "png") { const img = await pngDecode(buf); return img ? squareCopy(img, 64) : null; }
  if (ext === "jpg") { const img = jpegDC(buf); return img ? squareCopy(img, 64) : null; }   // 1/8 of a 512 px photo or more
  if (ext === "svg" && buf.length > SVG_KEEP) {
    const text = buf.toString("utf8");
    const img = await paintSvg(text);
    if (img) return { buf: pngEncode(img), ext: "png" };
    const lean = await svgShrinkPhotos(text);
    return lean ? { buf: Buffer.from(lean, "utf8"), ext: "svg" } : null;
  }
  return null;
}
// the tile shows the logo with object-fit: cover, so the copy is that centre square, scaled down to 96 px (never up)
function squareCopy(img, min) {
  const side = Math.min(img.w, img.h);
  if (side < min) return null;
  const t = Math.min(SMALL, side);
  return { buf: pngEncode(resize(img, (img.w - side) / 2, (img.h - side) / 2, side, side, t, t)), ext: "png" };
}
const rowOf = (img) => img.row || ((y, dst) => dst.set(img.rgba.subarray(y * img.w * 4, (y + 1) * img.w * 4)));
// area-average resize of the source rectangle (sx, sy, sw, sh) to tw × th, in premultiplied alpha so transparent edges do not darken
function resize(img, sx, sy, sw, sh, tw, th) {
  const wx = boxWeights(img.w, sx, sw, tw), wy = boxWeights(img.h, sy, sh, th);
  const rows = new Map();   // source row → [target row, weight, …]
  wy.forEach((l, ty) => { for (let i = 0; i < l.length; i += 2) { if (!rows.has(l[i])) rows.set(l[i], []); rows.get(l[i]).push(ty, l[i + 1]); } });
  const get = rowOf(img), line = new Uint8Array(img.w * 4), tmp = new Float64Array(tw * 4);
  const acc = new Float64Array(tw * th * 4), wsum = new Float64Array(th);
  for (const y of [...rows.keys()].sort((p, q) => p - q)) {
    get(y, line);
    for (let tx = 0; tx < tw; tx++) {
      const l = wx[tx];
      let r = 0, g = 0, b = 0, a = 0, ws = 0;
      for (let i = 0; i < l.length; i += 2) { const o = l[i] * 4, w = l[i + 1], al = line[o + 3] * w; r += line[o] * al; g += line[o + 1] * al; b += line[o + 2] * al; a += al; ws += w; }
      tmp[tx * 4] = r / ws; tmp[tx * 4 + 1] = g / ws; tmp[tx * 4 + 2] = b / ws; tmp[tx * 4 + 3] = a / ws;
    }
    const t = rows.get(y);
    for (let i = 0; i < t.length; i += 2) {
      const ty = t[i], w = t[i + 1], o = ty * tw * 4;
      wsum[ty] += w;
      for (let k = 0; k < tw * 4; k++) acc[o + k] += tmp[k] * w;
    }
  }
  const out = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const ws = wsum[ty] || 1;
    for (let tx = 0; tx < tw; tx++) {
      const o = (ty * tw + tx) * 4, a = acc[o + 3] / ws;
      if (a > 0.0001) { out[o] = clamp8(acc[o] / ws / a); out[o + 1] = clamp8(acc[o + 1] / ws / a); out[o + 2] = clamp8(acc[o + 2] / ws / a); }
      out[o + 3] = clamp8(a);
    }
  }
  return { w: tw, h: th, rgba: out };
}
function boxWeights(len, start, span, n) {
  const s = span / n, out = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * s, b = a + s, l = [];
    for (let j = Math.max(0, Math.floor(a)); j < Math.min(len, Math.ceil(b)); j++) { const w = Math.min(b, j + 1) - Math.max(a, j); if (w > 1e-9) l.push(j, w); }
    if (!l.length) l.push(Math.min(len - 1, Math.max(0, Math.floor(a))), 1);
    out.push(l);
  }
  return out;
}
const clamp8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/* PNG: every colour type and bit depth, not interlaced */
const inflate = promisify(zlib.inflate);
async function pngDecode(buf) {
  if (buf.length < 45 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let p = 8, w = 0, h = 0, depth = 0, ct = -1, il = 0, plte = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; il = d[12]; }
    else if (type === "PLTE") plte = d;
    else if (type === "tRNS") trns = d;
    else if (type === "IDAT") idat.push(d);
    else if ((type === "eXIf" && exifRotated(d)) || type === "acTL") return null;   // turned by its EXIF, or animated: keep the original
    else if (type === "IEND") break;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!ch || il || !w || !h || w * h > MAX_PIXELS || ![1, 2, 4, 8, 16].includes(depth) || (ct === 3 && (!plte || depth === 16)) || (ch > 1 && depth < 8)) return null;
  const stride = Math.ceil((w * ch * depth) / 8), bpp = Math.max(1, (ch * depth) >> 3);
  const raw = await inflate(Buffer.concat(idat), { maxOutputLength: h * (stride + 1) + 1024 });   // a zip bomb stops here
  if (raw.length < h * (stride + 1)) return null;
  // undo the row filters in place
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1) + 1, q = o - stride - 1, f = raw[o - 1];
    if (f === 0) continue;
    if (f === 1) { for (let i = bpp; i < stride; i++) raw[o + i] = (raw[o + i] + raw[o + i - bpp]) & 255; }
    else if (f === 2) { if (y) for (let i = 0; i < stride; i++) raw[o + i] = (raw[o + i] + raw[q + i]) & 255; }
    else if (f === 3) { for (let i = 0; i < stride; i++) raw[o + i] = (raw[o + i] + (((i >= bpp ? raw[o + i - bpp] : 0) + (y ? raw[q + i] : 0)) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[o + i - bpp] : 0, b = y ? raw[q + i] : 0, c = y && i >= bpp ? raw[q + i - bpp] : 0;
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        raw[o + i] = (raw[o + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return null;
  }
  const max = (1 << depth) - 1;
  const trGray = trns && ct === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const trRgb = trns && ct === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  const row = (y, dst) => {
    const o = y * (stride + 1) + 1;
    for (let x = 0; x < w; x++) {
      let r, g, b, a = 255;
      if (depth < 8) {   // gray or palette, 1/2/4 bits
        const bit = x * depth, s = (raw[o + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
        if (ct === 3) { r = plte[s * 3]; g = plte[s * 3 + 1]; b = plte[s * 3 + 2]; a = trns && s < trns.length ? trns[s] : 255; }
        else { r = g = b = Math.round((s * 255) / max); if (s === trGray) a = 0; }
      } else if (depth === 8) {
        const q = o + x * ch;
        if (ct === 3) { const s = raw[q]; r = plte[s * 3]; g = plte[s * 3 + 1]; b = plte[s * 3 + 2]; a = trns && s < trns.length ? trns[s] : 255; }
        else if (ct === 0) { r = g = b = raw[q]; if (raw[q] === trGray) a = 0; }
        else if (ct === 4) { r = g = b = raw[q]; a = raw[q + 1]; }
        else { r = raw[q]; g = raw[q + 1]; b = raw[q + 2]; if (ct === 6) a = raw[q + 3]; else if (trRgb && r === trRgb[0] && g === trRgb[1] && b === trRgb[2]) a = 0; }
      } else {   // 16 bits: the high byte is enough for a 96 px copy
        const q = o + x * ch * 2, v = (k) => (raw[q + k * 2] << 8) | raw[q + k * 2 + 1];
        if (ct === 0) { r = g = b = raw[q]; if (v(0) === trGray) a = 0; }
        else if (ct === 4) { r = g = b = raw[q]; a = raw[q + 2]; }
        else { r = raw[q]; g = raw[q + 2]; b = raw[q + 4]; if (ct === 6) a = raw[q + 6]; else if (trRgb && v(0) === trRgb[0] && v(1) === trRgb[1] && v(2) === trRgb[2]) a = 0; }
      }
      dst[x * 4] = r; dst[x * 4 + 1] = g; dst[x * 4 + 2] = b; dst[x * 4 + 3] = a;
    }
  };
  return { w, h, row };
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
// RGBA → PNG: a palette when the logo has 256 colours or fewer (flat logos, several times smaller), else RGB or RGBA
function pngEncode({ w, h, rgba }) {
  const n = w * h, colors = new Map();
  let opaque = true;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] !== 255) opaque = false;
    if (colors.size <= 256) { const k = ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0; if (!colors.has(k)) colors.set(k, colors.size); }
  }
  const pal = colors.size <= 256, ch = pal ? 1 : opaque ? 3 : 4, ct = pal ? 3 : opaque ? 2 : 6, stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1)), line = new Uint8Array(stride), prev = new Uint8Array(stride);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      if (pal) line[x] = colors.get(((rgba[s] << 24) | (rgba[s + 1] << 16) | (rgba[s + 2] << 8) | rgba[s + 3]) >>> 0);
      else for (let k = 0; k < ch; k++) line[x * ch + k] = rgba[s + k];
    }
    const o = y * (stride + 1);
    if (pal) { raw[o] = 0; raw.set(line, o + 1); }   // palette rows compress best unfiltered
    else {
      // the filter whose bytes sum smallest (as signed), the usual heuristic
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const c = cand[f];
        let sum = 0;
        for (let i = 0; i < stride; i++) {
          const a = i >= ch ? line[i - ch] : 0, b = y ? prev[i] : 0, cc = y && i >= ch ? prev[i - ch] : 0;
          let pr = 0;
          if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
          else if (f === 4) { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
          const v = (line[i] - pr) & 255;
          c[i] = v; sum += v < 128 ? v : 256 - v;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
      raw[o] = best; raw.set(cand[best], o + 1);
    }
    prev.set(line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr)];
  if (pal) {
    const plte = Buffer.alloc(colors.size * 3), alpha = Buffer.alloc(colors.size);
    let lastAlpha = -1;
    for (const [k, i] of colors) { plte[i * 3] = k >>> 24; plte[i * 3 + 1] = (k >>> 16) & 255; plte[i * 3 + 2] = (k >>> 8) & 255; alpha[i] = k & 255; if ((k & 255) !== 255) lastAlpha = i; }
    parts.push(pngChunk("PLTE", plte));
    if (lastAlpha >= 0) parts.push(pngChunk("tRNS", alpha.subarray(0, lastAlpha + 1)));
  }
  parts.push(pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* JPEG at one eighth of its size: each 8×8 block's DC coefficient is that block's average colour, so only the Huffman
   stream is read, no inverse DCT. Baseline and progressive (its first scans carry the DC), 8-bit, grey or YCbCr/RGB. */
function jpegDC(buf) {
  try {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const qt = [], dcT = [], acT = [];
    let f = null, ri = 0, adobe = -1, progressive = false, gotDC = false, p = 2;
    while (p + 4 <= buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m === 0xff) { p++; continue; }
      p += 2;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
      if (m === 0xd9) break;
      const len = buf.readUInt16BE(p), seg = buf.subarray(p + 2, p + len);
      p += len;
      if (m === 0xdb) { for (let i = 0; i < seg.length;) { const pq = seg[i] >> 4; qt[seg[i] & 15] = pq ? seg.readUInt16BE(i + 1) : seg[i + 1]; i += 1 + 64 * (pq ? 2 : 1); } }
      else if (m === 0xc4) {
        for (let i = 0; i < seg.length;) {
          const tc = seg[i] >> 4, th = seg[i] & 15, counts = seg.subarray(i + 1, i + 17);
          let n = 0; for (const c of counts) n += c;
          (tc ? acT : dcT)[th] = huffTable(counts, seg.subarray(i + 17, i + 17 + n));
          i += 17 + n;
        }
      } else if (m === 0xdd) ri = seg.readUInt16BE(0);
      else if (m === 0xe1 && seg.toString("latin1", 0, 4) === "Exif" && exifRotated(seg.subarray(6))) return null;   // a rotated photo: keep the original
      else if (m === 0xee && seg.toString("latin1", 0, 5) === "Adobe") adobe = seg[11];
      else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        if (seg[0] !== 8) return null;
        progressive = m === 0xc2;
        const H = seg.readUInt16BE(1), W = seg.readUInt16BE(3), n = seg[5];
        if (!W || !H || (n !== 1 && n !== 3) || W * H > 64_000_000) return null;   // CMYK and friends stay as they are
        const comps = [];
        for (let i = 0; i < n; i++) comps.push({ id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3], pred: 0 });
        const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
        const mcuX = Math.ceil(W / (8 * hmax)), mcuY = Math.ceil(H / (8 * vmax));
        for (const c of comps) {
          if (!c.h || !c.v) return null;
          c.bw = mcuX * c.h; c.bh = mcuY * c.v; c.dc = new Int32Array(c.bw * c.bh);
          c.cbw = Math.ceil(Math.ceil((W * c.h) / hmax) / 8); c.cbh = Math.ceil(Math.ceil((H * c.v) / vmax) / 8);
        }
        f = { W, H, comps, hmax, vmax, mcuX, mcuY };
      } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null;   // lossless or arithmetic coding
      else if (m === 0xda) {
        if (!f) return null;
        const ns = seg[0], sc = [];
        for (let i = 0; i < ns; i++) { const c = f.comps.find((x) => x.id === seg[1 + i * 2]); if (!c) return null; sc.push({ c, td: seg[2 + i * 2] >> 4, ta: seg[2 + i * 2] & 15 }); }
        const ss = seg[1 + ns * 2], ah = seg[3 + ns * 2] >> 4, al = seg[3 + ns * 2] & 15;
        if (progressive && ss > 0) { p = nextMarker(buf, p); continue; }   // AC detail: not needed at 1/8
        p = jpegScan(buf, p, f, sc, { progressive, ah, al, ri, dcT, acT });
        gotDC = true;
      }
    }
    if (!f || !gotDC) return null;
    const { W, H, comps, hmax, vmax } = f;
    const w = Math.ceil(W / 8), h = Math.ceil(H / 8), rgba = new Uint8Array(w * h * 4);
    const rgb = comps.length === 3 && (adobe === 0 || (comps[0].id === 82 && comps[1].id === 71 && comps[2].id === 66));
    // a block's average is DC × quant / 8 + 128; subsampled chroma (one block per 2 here) is interpolated between block
    // centres, as libjpeg's "fancy upsampling" does, instead of showing as 2-pixel steps
    const val = (c, x, y) => {
      const q = (qt[c.tq] || 1) / 8, at = (bx, by) => c.dc[by * c.bw + bx];
      if (c.h === hmax && c.v === vmax) return at(Math.min(c.cbw - 1, x), Math.min(c.cbh - 1, y)) * q + 128;
      const fx = Math.max(0, Math.min(c.cbw - 1, ((x + 0.5) * c.h) / hmax - 0.5)), fy = Math.max(0, Math.min(c.cbh - 1, ((y + 0.5) * c.v) / vmax - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(c.cbw - 1, x0 + 1), y1 = Math.min(c.cbh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      return ((at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty) * q + 128;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (comps.length === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = clamp8(val(comps[0], x, y)); }
      else {
        const Y = val(comps[0], x, y), cb = val(comps[1], x, y), cr = val(comps[2], x, y);
        if (rgb) { rgba[o] = clamp8(Y); rgba[o + 1] = clamp8(cb); rgba[o + 2] = clamp8(cr); }
        else { rgba[o] = clamp8(Y + 1.402 * (cr - 128)); rgba[o + 1] = clamp8(Y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)); rgba[o + 2] = clamp8(Y + 1.772 * (cb - 128)); }
      }
      rgba[o + 3] = 255;
    }
    return { w, h, rgba };
  } catch { return null; }
}
function huffTable(counts, symbols) {
  const max = new Int32Array(18).fill(-1), min = new Int32Array(17), ptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) { ptr[l] = k; min[l] = code; code += counts[l - 1]; k += counts[l - 1]; if (counts[l - 1]) max[l] = code - 1; code <<= 1; }
  return { max, min, ptr, sym: symbols };
}
function nextMarker(buf, p) {
  while (p + 1 < buf.length) { if (buf[p] === 0xff) { const n = buf[p + 1]; if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) return p; } p++; }
  return buf.length;
}
// one scan's DC values into each component's block grid (baseline scans also carry AC, which is read past)
function jpegScan(buf, start, f, sc, o) {
  let pos = start, bits = 0, nbits = 0, marker = false;
  const bit = () => {
    if (!nbits) {
      if (marker || pos >= buf.length) return 0;
      const b = buf[pos];
      if (b === 0xff) { if (buf[pos + 1] === 0) pos += 2; else { marker = true; return 0; } } else pos++;
      bits = b; nbits = 8;
    }
    return (bits >> --nbits) & 1;
  };
  const recv = (s) => { let v = 0; for (let i = 0; i < s; i++) v = (v << 1) | bit(); return v; };
  const ext = (v, s) => (v < 1 << (s - 1) ? v - (1 << s) + 1 : v);
  const dec = (t) => { if (!t) throw new Error("no table"); let code = 0; for (let l = 1; l <= 16; l++) { code = (code << 1) | bit(); if (code <= t.max[l]) return t.sym[t.ptr[l] + code - t.min[l]]; } throw new Error("bad code"); };
  const block = (s, idx) => {
    const c = s.c;
    if (o.progressive && o.ah) { if (bit()) c.dc[idx] |= 1 << o.al; return; }   // DC refinement: one more bit
    const t = dec(o.dcT[s.td]);
    c.pred += t ? ext(recv(t), t) : 0;
    c.dc[idx] = c.pred << (o.progressive ? o.al : 0);
    if (o.progressive) return;
    for (let k = 1; k < 64;) {
      const rs = dec(o.acT[s.ta]), r = rs >> 4, sz = rs & 15;
      if (!sz) { if (r !== 15) break; k += 16; } else { k += r; recv(sz); k++; }
    }
  };
  for (const s of sc) s.c.pred = 0;
  const one = sc.length === 1, total = one ? sc[0].c.cbw * sc[0].c.cbh : f.mcuX * f.mcuY;
  for (let m = 0; m < total; m++) {
    if (o.ri && m && m % o.ri === 0) {   // restart interval: realign on the RSTn marker, predictions start again from 0
      nbits = 0; marker = false;
      while (pos + 1 < buf.length && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const s of sc) s.c.pred = 0;
    }
    if (one) { const s = sc[0], c = s.c; block(s, Math.floor(m / c.cbw) * c.bw + (m % c.cbw)); }
    else {
      const mx = m % f.mcuX, my = Math.floor(m / f.mcuX);
      for (const s of sc) { const c = s.c; for (let v = 0; v < c.v; v++) for (let hh = 0; hh < c.h; hh++) block(s, (my * c.v + v) * c.bw + mx * c.h + hh); }
    }
  }
  return nextMarker(buf, pos);
}
// EXIF orientation other than 1 (the browser turns such a photo; a copy made here would not be)
function exifRotated(t) {
  if (t.length < 8) return false;
  const le = t.toString("latin1", 0, 2) === "II", u16 = (i) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i)), u32 = (i) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return false;
  for (let i = 0, n = u16(ifd); i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > t.length) break; if (u16(e) === 0x0112) return u16(e + 8) > 1; }
  return false;
}

/* SVG with a photo inside (<image href="data:image/png;base64,…">): the photo is scaled down to 128 px in place. The <image>
   keeps its width and height, so the SVG draws exactly as before, only lighter. */
async function svgShrinkPhotos(text) {
  const re = /(<image\b[^>]*?\s(?:xlink:)?href\s*=\s*["'])data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)(["'])/gi;
  let out = "", last = 0, changed = false;
  for (const m of text.matchAll(re)) {
    const end = text.indexOf(">", m.index + m[0].length);
    const tag = m[1] + text.slice(m.index + m[0].length, end);   // the attributes, without the photo
    if (end < 0 || !/\swidth\s*=/.test(tag) || !/\sheight\s*=/.test(tag)) continue;
    const buf = Buffer.from(m[3].replace(/\s+/g, ""), "base64");
    const img = m[2].toLowerCase() === "png" ? await pngDecode(buf) : jpegDC(buf);
    if (!img) continue;
    const k = 128 / Math.max(img.w, img.h);
    if (k >= 1) continue;
    const small = pngEncode(resize(img, 0, 0, img.w, img.h, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k))));
    if (small.length >= buf.length) continue;
    out += text.slice(last, m.index) + m[1] + "data:image/png;base64," + small.toString("base64") + m[4];
    last = m.index + m[0].length;
    changed = true;
  }
  return changed ? out + text.slice(last) : null;
}

/* A small SVG painter for logos traced from a photo (Hyperliquid serves 1–3 MB ones made of thousands of filled paths). It
   draws filled shapes only: path, rect, circle, ellipse, polygon and polyline, with fill, fill-opacity, opacity, fill-rule,
   transforms and rectangular clip paths (Figma wraps every export in one), 4×4 samples a pixel. Strokes thinner than a tenth
   of a pixel at 96 px (the hairlines tracers add between shapes) are left out. Anything else (gradients, masks, filters,
   visible strokes, text, images, <use>, CSS) returns null and the SVG is kept as it is. */
const SVG_SKIP = new Set(["title", "desc", "metadata", "defs", "clippath"]);   // defs and clipPath are read in a first pass
const SVG_SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline"]);
// the 148 CSS colour keywords, as name:hex
const NAMED = Object.fromEntries((
  "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd " +
  "blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed " +
  "cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 " +
  "darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f " +
  "darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff " +
  "dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc " +
  "ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c " +
  "indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 " +
  "lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 " +
  "limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db " +
  "mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 " +
  "mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 " +
  "orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 " +
  "peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 " +
  "saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd " +
  "slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 " +
  "violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32"
).split(" ").map((x) => { const [k, v] = x.split(":"); return [k, [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16))]; }));
async function paintSvg(text) {
  const t0 = Date.now(), S = SMALL, SS = 4, D = S * SS;
  let slice = t0;   // runs on the server's main thread: hand it back every 20 ms so trading requests never wait on a logo
  const src = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  if (/<!\[CDATA\[|<style[\s>]/i.test(src)) return null;   // CSS classes would change the fills
  const clips = svgClips(src);
  const canvas = new Float32Array(S * S * 4), cov = new Uint8Array(S * S);
  const stack = [];
  let skip = 0, root = false, drew = false, edgesTotal = 0;
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let pos = 0;
  for (let m; (m = tagRe.exec(src));) {
    if (src.slice(pos, m.index).includes("<")) return null;   // markup the tokenizer did not understand
    pos = tagRe.lastIndex;
    const [, close, tag, attrText, selfClose] = m;
    const name = tag.toLowerCase();
    if (close) { if (skip) skip--; else stack.pop(); continue; }
    if (skip || name.includes(":") || SVG_SKIP.has(name)) { if (!selfClose) skip++; continue; }   // editor metadata (sodipodi:…), titles
    const at = svgAttrs(attrText);
    if (!at) return null;
    if (name === "svg") {
      if (root) return null;   // nested <svg>
      root = true;
      const vb = (at.viewbox || "").trim().split(/[\s,]+/).map(Number);
      const vw = vb.length === 4 ? vb[2] : parseFloat(at.width), vh = vb.length === 4 ? vb[3] : parseFloat(at.height);
      if (!(vw > 0) || !(vh > 0) || /%/.test(vb.length === 4 ? "" : `${at.width}${at.height}`)) return null;
      const par = String(at.preserveaspectratio || "").trim();
      if (par && !/^xMidYMid( meet| slice)?$/.test(par) && par !== "none") return null;
      // the tile shows the image with object-fit: cover, so the view box is scaled to cover the square
      const sx = par === "none" ? D / vw : Math.max(D / vw, D / vh), sy = par === "none" ? D / vh : sx;
      const x0 = vb.length === 4 ? vb[0] : 0, y0 = vb.length === 4 ? vb[1] : 0;
      const base = { m: [sx, 0, 0, sy, (D - vw * sx) / 2 - x0 * sx, (D - vh * sy) / 2 - y0 * sy], fill: [0, 0, 0], fa: 1, fo: 1, rule: "nonzero", stroke: false, sw: 1, color: [0, 0, 0], clip: null };
      const st = svgState(base, at, clips);
      if (!st || st.op < 0.999 || st.hidden) return null;
      if (!selfClose) stack.push(st);
      continue;
    }
    if (!root) return null;
    const parent = stack[stack.length - 1];
    if (name !== "g" && !SVG_SHAPES.has(name)) return null;   // use, image, text, gradients, mask …
    const st = svgState(parent, at, clips);
    if (!st) return null;
    if (name === "g") { if (st.op < 0.999) return null; if (!selfClose) stack.push(st); continue; }   // group opacity needs a layer
    if (!selfClose) stack.push(st);   // a shape with children (<title> inside a <path>)
    const alpha = st.op * st.fo * st.fa;
    // a stroke a tenth of a pixel wide or more shows; a non-scaling one keeps its width in screen pixels however small the logo
    if (st.stroke && (at["vector-effect"] === "non-scaling-stroke" || (st.sw * Math.sqrt(Math.abs(st.m[0] * st.m[3] - st.m[1] * st.m[2]))) / SS >= 0.1)) return null;
    if (st.hidden || st.fill === "none" || alpha <= 0) continue;
    const d = shapePath(name, at);
    if (d === null) return null;
    const polys = svgPath(d, st.m);
    if (!polys) return null;
    edgesTotal += polys.reduce((n, p) => n + p.length, 0);
    if (edgesTotal > 3_000_000 || Date.now() - t0 > 2500) return null;   // too much work for a tile: keep the SVG
    fillPolys(polys, st.rule, st.fill, alpha, canvas, cov, S, SS, st.clip);
    if (Date.now() - slice > 20) { await new Promise((ok) => setImmediate(ok)); slice = Date.now(); }
    drew = true;
  }
  if (!root || !drew || src.slice(pos).includes("<")) return null;
  const rgba = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const a = canvas[i * 4 + 3];
    if (a > 0.0001) { rgba[i * 4] = clamp8((canvas[i * 4] / a) * 255); rgba[i * 4 + 1] = clamp8((canvas[i * 4 + 1] / a) * 255); rgba[i * 4 + 2] = clamp8((canvas[i * 4 + 2] / a) * 255); }
    rgba[i * 4 + 3] = clamp8(a * 255);
  }
  return { w: S, h: S, rgba };
}
function svgAttrs(text) {
  const at = {};
  for (const m of text.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) at[m[1].toLowerCase()] = m[2] ?? m[3];
  if (at.style) for (const decl of at.style.split(";")) { const i = decl.indexOf(":"); if (i > 0) at[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim(); }
  for (const k of ["mask", "filter"]) if (at[k] && at[k] !== "none") return null;
  return at;
}
// <clipPath id> holding one plain <rect> → that rectangle (in the user space of the element that uses it); other clip paths
// are left out of the map, so an element using one makes the painter give up
function svgClips(src) {
  const out = new Map();
  for (const m of src.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/gi)) {
    const a = svgAttrs(m[1]) || {}, inner = m[2].replace(/<title[\s\S]*?<\/title>/gi, "").trim();
    const r = /^<rect\b((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>(?:\s*<\/rect>)?$/i.exec(inner);
    if (!a.id || (a.clippathunits && a.clippathunits !== "userSpaceOnUse") || !r) continue;
    const ra = svgAttrs(r[1]) || {}, n = (k) => (ra[k] == null || ra[k] === "" ? 0 : /%/.test(ra[k]) ? NaN : parseFloat(ra[k]));
    if (n("rx") || n("ry")) continue;   // rounded corners: not a plain rectangle
    let tm = [1, 0, 0, 1, 0, 0];
    for (const t of [a.transform, ra.transform]) if (t) { const k = svgTransform(t); if (!k) { tm = null; break; } tm = mul(tm, k); }
    const box = [n("x"), n("y"), n("width"), n("height")];
    if (tm && box.every(Number.isFinite)) out.set(a.id, { box, tm });
  }
  return out;
}
// the inherited paint state for one element, or null when it uses something the painter cannot draw
// fill, its colour's own alpha (fa, from #rrggbbaa or rgba()) and fill-opacity inherit; opacity belongs to the element alone
function svgState(p, at, clips) {
  const st = { m: p.m, fill: p.fill, fa: p.fa, fo: p.fo, rule: p.rule, stroke: p.stroke, sw: p.sw, color: p.color, op: 1, hidden: p.hidden, clip: p.clip };
  if (at.display === "none" || at.visibility === "hidden" || at.visibility === "collapse") st.hidden = true;
  if (at.color && at.color !== "inherit") { const c = svgColor(at.color); if (!c || c === "none") return null; st.color = c.rgb; }
  if (at.fill && at.fill !== "inherit") {
    if (/^currentcolor$/i.test(at.fill)) { st.fill = st.color; st.fa = 1; }
    else { const c = svgColor(at.fill); if (!c) return null; st.fill = c === "none" ? "none" : c.rgb; st.fa = c === "none" || c.a === undefined ? 1 : c.a; }
  }
  if (at["fill-opacity"] != null && at["fill-opacity"] !== "inherit") st.fo = svgNum01(at["fill-opacity"]);
  if (at["fill-rule"] === "evenodd" || at["fill-rule"] === "nonzero") st.rule = at["fill-rule"];
  if (at.opacity != null) st.op = svgNum01(at.opacity);
  if (at.stroke && at.stroke !== "inherit") st.stroke = !/^(none|transparent)$/i.test(at.stroke.trim());   // tracers write "None"
  if (at["stroke-width"] != null && at["stroke-width"] !== "inherit") { if (/%/.test(at["stroke-width"])) return null; st.sw = parseFloat(at["stroke-width"]); }
  if (st.sw === 0 || (at["stroke-opacity"] != null && parseFloat(at["stroke-opacity"]) === 0)) st.stroke = false;
  if (at.transform && at.transform !== "none") { const t = svgTransform(at.transform); if (!t) return null; st.m = mul(p.m, t); }
  if (at["clip-path"] && at["clip-path"] !== "none") {
    // a rectangle clip in this element's user space; only when it stays a rectangle on screen (no rotation or skew)
    const c = clips?.get(/^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(at["clip-path"].trim())?.[1]);
    if (!c) return null;
    const k = mul(st.m, c.tm), [x, y, w, h] = c.box;
    if (Math.abs(k[1]) > 1e-9 || Math.abs(k[2]) > 1e-9) return null;
    const xs = [k[0] * x + k[4], k[0] * (x + w) + k[4]], ys = [k[3] * y + k[5], k[3] * (y + h) + k[5]];
    const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    st.clip = p.clip ? [Math.max(r[0], p.clip[0]), Math.max(r[1], p.clip[1]), Math.min(r[2], p.clip[2]), Math.min(r[3], p.clip[3])] : r;
  }
  if ([st.fo, st.op, st.fa, st.sw].some((v) => !Number.isFinite(v))) return null;
  return st;
}
const svgNum01 = (v) => { const s = String(v).trim(), n = parseFloat(s); return Math.min(1, Math.max(0, s.endsWith("%") ? n / 100 : n)); };
function svgColor(v) {
  v = String(v).trim().toLowerCase();
  if (v === "none" || v === "transparent") return "none";
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return { rgb: [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)), a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : undefined };
    if (h.length === 6 || h.length === 8) return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : undefined };
    return null;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length < 3) return null;
    const rgb = p.slice(0, 3).map((x) => clamp8(x.endsWith("%") ? (parseFloat(x) * 255) / 100 : parseFloat(x)));
    return { rgb, a: p[3] != null ? svgNum01(p[3]) : undefined };
  }
  return NAMED[v] ? { rgb: NAMED[v] } : null;
}
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function svgTransform(s) {
  let m = [1, 0, 0, 1, 0, 0], rest = s;
  for (const t of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    rest = rest.replace(t[0], "");
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.some((x) => !Number.isFinite(x))) return null;
    const r = (deg) => (deg * Math.PI) / 180;
    let k;
    if (t[1] === "matrix") { if (v.length !== 6) return null; k = v; }
    else if (t[1] === "translate") k = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
    else if (t[1] === "scale") k = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (t[1] === "rotate") {
      const c = Math.cos(r(v[0] || 0)), sn = Math.sin(r(v[0] || 0)), cx = v[1] || 0, cy = v[2] || 0;
      k = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (t[1] === "skewX") k = [1, 0, Math.tan(r(v[0] || 0)), 1, 0, 0];
    else k = [1, Math.tan(r(v[0] || 0)), 0, 1, 0, 0];
    m = mul(m, k);
  }
  return rest.replace(/[\s,]/g, "") ? null : m;
}
// rect, circle, ellipse and polygons as path data
function shapePath(name, at) {
  const n = (k, dflt = 0) => { const v = at[k]; if (v == null || v === "") return dflt; if (/%/.test(v)) return NaN; return parseFloat(v); };
  let d;
  if (name === "path") d = at.d || "";
  else if (name === "rect") {
    const x = n("x"), y = n("y"), w = n("width"), h = n("height");
    let rx = at.rx != null ? n("rx") : at.ry != null ? n("ry") : 0, ry = at.ry != null ? n("ry") : rx;
    if (![x, y, w, h, rx, ry].every(Number.isFinite)) return null;
    if (!(w > 0) || !(h > 0)) return "";
    rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2);
    d = rx && ry ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  } else if (name === "circle" || name === "ellipse") {
    const cx = n("cx"), cy = n("cy"), rx = name === "circle" ? n("r") : n("rx"), ry = name === "circle" ? rx : n("ry");
    if (![cx, cy, rx, ry].every(Number.isFinite)) return null;
    if (!(rx > 0) || !(ry > 0)) return "";
    d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
  } else {
    const pts = String(at.points || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (pts.some((x) => !Number.isFinite(x))) return null;
    if (pts.length < 6) return "";
    d = `M${pts[0]} ${pts[1]}` + pts.slice(2, pts.length - (pts.length % 2)).map((v, i) => (i % 2 ? ` ${v}` : `L${v}`)).join("") + "Z";
  }
  return d;
}
// path data → polygons in device space, curves flattened; null on malformed data
function svgPath(d, m) {
  const polys = [], n = d.length, numRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, qx = 0, qy = 0, last = "", cur = null;
  const T = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const ws = () => { while (i < n && (d[i] === " " || d[i] === "," || d[i] === "\n" || d[i] === "\t" || d[i] === "\r")) i++; };
  const num = () => { ws(); numRe.lastIndex = i; const r = numRe.exec(d); if (!r) throw new Error("number"); i = numRe.lastIndex; return +r[0]; };
  const flag = () => { ws(); const ch = d[i++]; if (ch !== "0" && ch !== "1") throw new Error("flag"); return ch === "1"; };
  let points = 0;   // a path that flattens to more than a million points is not a logo: give up before memory does
  const add = (p) => { if (++points > 1_000_000) throw new Error("too many points"); cur.push(p); };
  const start = () => { if (!cur) { cur = [T(cx, cy)]; polys.push(cur); } };
  const lineTo = (x, y) => { start(); add(T(x, y)); };
  const cubic = (x1, y1, x2, y2, x, y) => {
    start();
    const p0 = cur[cur.length - 1], p1 = T(x1, y1), p2 = T(x2, y2), p3 = T(x, y);
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const steps = Math.min(64, Math.max(1, Math.ceil(len / 3)));   // ~3 samples (¾ px) a step
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      add([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]]);
    }
  };
  const quad = (x1, y1, x, y) => cubic(cx + (2 / 3) * (x1 - cx), cy + (2 / 3) * (y1 - cy), x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x, y);
  const arc = (rx, ry, rot, fa, fs, x, y) => {
    if (cx === x && cy === y) return;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) return lineTo(x, y);
    const ph = (rot * Math.PI) / 180, cs = Math.cos(ph), sn = Math.sin(ph);
    const dx = (cx - x) / 2, dy = (cy - y) / 2, x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const nu = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, de = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, nu / de));
    const ccx = (co * rx * y1) / ry, ccy = (-co * ry * x1) / rx;
    const ox = cs * ccx - sn * ccy + (cx + x) / 2, oy = sn * ccx + cs * ccy + (cy + y) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - ccx) / rx, (y1 - ccy) / ry);
    let dt = ang((x1 - ccx) / rx, (y1 - ccy) / ry, (-x1 - ccx) / rx, (-y1 - ccy) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
    const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / segs, kk = (4 / 3) * Math.tan(step / 4);
    const P = (ux, uy) => [ox + rx * ux * cs - ry * uy * sn, oy + rx * ux * sn + ry * uy * cs];
    for (let s = 0; s < segs; s++) {
      const a1 = t1 + s * step, a2 = a1 + step, c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
      const q1 = P(c1 - kk * s1, s1 + kk * c1), q2 = P(c2 + kk * s2, s2 - kk * c2), q3 = s === segs - 1 ? [x, y] : P(c2, s2);
      cubic(q1[0], q1[1], q2[0], q2[1], q3[0], q3[1]);   // cubic() starts from the last point drawn, so cx/cy can wait
    }
  };
  try {
    for (;;) {
      ws();
      if (i >= n) break;
      const ch = d[i];
      if (/[MmZzLlHhVvCcSsQqTtAa]/.test(ch)) { cmd = ch; i++; }
      else if (!cmd || !/[-+.\d]/.test(ch)) return null;
      const rel = cmd >= "a", C = cmd.toUpperCase(), bx = rel ? cx : 0, by = rel ? cy : 0;
      if (C === "M") { const x = num() + bx, y = num() + by; cur = [T(x, y)]; polys.push(cur); cx = sx = x; cy = sy = y; cmd = rel ? "l" : "L"; last = "M"; }
      else if (C === "L") { const x = num() + bx, y = num() + by; lineTo(x, y); cx = x; cy = y; last = "L"; }
      else if (C === "H") { const x = num() + bx; lineTo(x, cy); cx = x; last = "H"; }
      else if (C === "V") { const y = num() + by; lineTo(cx, y); cy = y; last = "V"; }
      else if (C === "C") { const x1 = num() + bx, y1 = num() + by, x2 = num() + bx, y2 = num() + by, x = num() + bx, y = num() + by; cubic(x1, y1, x2, y2, x, y); qx = x2; qy = y2; cx = x; cy = y; last = "C"; }
      else if (C === "S") {
        const x1 = last === "C" ? 2 * cx - qx : cx, y1 = last === "C" ? 2 * cy - qy : cy;
        const x2 = num() + bx, y2 = num() + by, x = num() + bx, y = num() + by;
        cubic(x1, y1, x2, y2, x, y); qx = x2; qy = y2; cx = x; cy = y; last = "C";
      } else if (C === "Q") { const x1 = num() + bx, y1 = num() + by, x = num() + bx, y = num() + by; quad(x1, y1, x, y); qx = x1; qy = y1; cx = x; cy = y; last = "Q"; }
      else if (C === "T") {
        const x1 = last === "Q" ? 2 * cx - qx : cx, y1 = last === "Q" ? 2 * cy - qy : cy, x = num() + bx, y = num() + by;
        quad(x1, y1, x, y); qx = x1; qy = y1; cx = x; cy = y; last = "Q";
      } else if (C === "A") { const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), x = num() + bx, y = num() + by; arc(rx, ry, rot, fa, fs, x, y); cx = x; cy = y; last = "A"; }
      else { cx = sx; cy = sy; cur = null; cmd = ""; last = "Z"; }
    }
  } catch { return null; }
  return polys;
}
// one shape's coverage (4×4 samples a pixel, nonzero or even-odd, inside the clip rectangle), composited over the canvas
function fillPolys(polys, rule, rgb, alpha, canvas, cov, S, SS, clip) {
  const D = S * SS, E = [];   // edges: x0, y0, x1, y1, dir (y0 < y1)
  // samples are taken at pixel centres: the clip keeps columns ca … cb-1 and rows ra … rb-1
  const ca = clip ? Math.max(0, Math.ceil(clip[0] - 0.5)) : 0, cb = clip ? Math.min(D, Math.ceil(clip[2] - 0.5)) : D;
  const ra = clip ? Math.max(0, Math.ceil(clip[1] - 0.5)) : 0, rb = clip ? Math.min(D, Math.ceil(clip[3] - 0.5)) : D;
  if (ca >= cb || ra >= rb) return;
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
  for (const p of polys) {
    if (p.length < 3) continue;
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length];   // closed for filling
      if (a[1] === b[1]) continue;
      const down = a[1] < b[1], top = down ? a : b, bot = down ? b : a;
      E.push([top[0], top[1], bot[0], bot[1], down ? 1 : -1]);
      if (top[1] < ymin) ymin = top[1]; if (bot[1] > ymax) ymax = bot[1];
      for (const x of [a[0], b[0]]) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
    }
  }
  if (!E.length) return;
  E.sort((p, q) => p[1] - q[1]);
  const r0 = Math.max(ra, Math.ceil(ymin - 0.5)), r1 = Math.min(rb - 1, Math.floor(ymax - 0.5));
  let next = 0, active = [];
  const xs = [];
  for (let sy = r0; sy <= r1; sy++) {
    const yc = sy + 0.5;
    while (next < E.length && E[next][1] <= yc) active.push(E[next++]);
    active = active.filter((e) => e[3] > yc);
    xs.length = 0;
    for (const e of active) if (e[1] <= yc) xs.push([e[0] + ((yc - e[1]) * (e[2] - e[0])) / (e[3] - e[1]), e[4]]);
    if (xs.length < 2) continue;
    xs.sort((p, q) => p[0] - q[0]);
    const row = (sy >> 2) * S;
    const span = (xa, xb) => {
      const a = Math.max(ca, Math.ceil(xa - 0.5)), b = Math.min(cb, Math.ceil(xb - 0.5));   // sample columns a … b-1
      for (let col = a >> 2; col <= (b - 1) >> 2 && a < b; col++) cov[row + col] += Math.min(b, (col + 1) * SS) - Math.max(a, col * SS);
    };
    if (rule === "evenodd") { for (let k = 0; k + 1 < xs.length; k += 2) span(xs[k][0], xs[k + 1][0]); }
    else {
      let wind = 0, from = 0;
      for (const [x, dir] of xs) { const was = wind; wind += dir; if (!was && wind) from = x; else if (was && !wind) span(from, x); }
    }
  }
  const [fr, fg, fb] = rgb.map((v) => v / 255);
  const c0 = Math.max(0, Math.floor(xmin / SS)), c1 = Math.min(S - 1, Math.floor(xmax / SS)), y0 = r0 >> 2, y1 = Math.min(S - 1, r1 >> 2);
  for (let y = y0; y <= y1; y++) for (let x = c0; x <= c1; x++) {
    const i = y * S + x, c = cov[i];
    if (!c) continue;
    cov[i] = 0;
    const a = (alpha * Math.min(c, SS * SS)) / (SS * SS), k = 1 - a;
    canvas[i * 4] = fr * a + canvas[i * 4] * k; canvas[i * 4 + 1] = fg * a + canvas[i * 4 + 1] * k; canvas[i * 4 + 2] = fb * a + canvas[i * 4 + 2] * k; canvas[i * 4 + 3] = a + canvas[i * 4 + 3] * k;
  }
}

/* ---------- monogram ---------- */
// the letter tile the app draws for a coin without a logo (ui.js tokenIcon): the same letters and the same teal gradient from
// the same hash, so a tile looks alike whether the browser or the server drew it
const hsl = (h, s, l) => {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
};
export function monogramSvg(label, seed, letters = 2) {
  const txt = String(label || "").replace(/^[a-z0-9]+:/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, letters).toUpperCase() || "?";
  const hue = [...String(seed || label || "x")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hsl((hue % 60) + 170, 45, 26)}"/><stop offset="1" stop-color="${hsl((hue % 60) + 190, 50, 14)}"/></linearGradient></defs>` +
    `<rect width="96" height="96" fill="url(#g)"/><text x="48" y="48" dy=".35em" text-anchor="middle" font-family="'Instrument Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" ` +
    `font-size="${txt.length > 1 ? 34 : 40}" font-weight="600" fill="#c3cfd8">${txt}</text></svg>`;
}

/* ---------- responses ---------- */
async function sendFile(res, file) {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, { "content-type": TYPE[ext] || "application/octet-stream", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": CSP });
  res.end(buf);
}
// a stock logo: a file in /img/logos/stocks, or an override's bytes from stocks.mjs
function sendLogo(res, x) {
  if (x.file) return sendFile(res, x.file);
  res.writeHead(200, { "content-type": x.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": CSP });
  res.end(x.buf);
}
// short: the miss came from an upstream error, so browsers ask again in 10 minutes instead of 6 hours
function sendMonogram(res, label, seed, letters, short = false) {
  res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": `public, max-age=${short ? 600 : MONO_MAX_AGE}`, "x-content-type-options": "nosniff", "content-security-policy": CSP, "x-icon": "monogram" });
  res.end(monogramSvg(label, seed, letters));
}
function sendErr(res, status, error) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": status === 404 ? "public, max-age=3600" : "no-store" });
  res.end(JSON.stringify({ error }));
}

// the image code and the alias rules, for checks in scripts without the server or the network (init points the stock logo
// lookup at a checkout and a stocks module, as register() does)
export const _test = { pngDecode, pngEncode, jpegDC, resize, paintSvg, svgShrinkPhotos, shrink, coinSources, aliasOf, BARE_ALIAS, spotStock, stockLogo,
  init: ({ root, stocks, names = [] }) => { PUBLIC_LOGOS = path.join(root, "public", "img", "logos"); stocksP = Promise.resolve(stocks); for (const [k, v] of names) STOCK_NAME.set(k, v); } };
