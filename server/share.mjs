// Share links with their own link preview (21 Nov audit, 3-13). A share used to link /agent?ref=CODE#/token/0x…, and the
// part after "#" never reaches a server, so X, Telegram and Discord showed the site's one og.png for every coin.
//   GET /t/:address        a tiny page with the coin's own preview (title: "$SYM · $price · Troya Gate: <verdict>",
//                          description: the Gate and Watchfire lines, image below), then on to /agent?ref=…#/token/…
//   GET /t/:address.png    that preview image, 1200 × 630, drawn here and kept 10 minutes
//   GET /r/:code           a referral link with the site's preview, then on to /agent?ref=CODE
// ?ref=CODE on /t/ carries the sharer's referral code along. Called from server.mjs before the API and the static files.
// The image is drawn without a browser or an image library: the room, marks and shapes are plain pixel math, the words come
// from a glyph atlas of the site's own fonts (server/share-assets, made by tools/share-glyphs.mjs), and the PNG encoder is
// the one icons.mjs uses. Nothing here moves money or posts anything; it reads the same Gate, Watchfire and price the coin
// page shows. Coin names are free, so every symbol is escaped and never trusted as markup.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { ipOf } from "./api.mjs";

const SITE = "https://troya.codes";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = join(HERE, "share-assets");
const LOGO = join(HERE, "..", "public", "img", "logo-3d-128.png");
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CODE_RE = /^[a-z0-9]{4,12}$/;                 // herald.mjs's referral codes
const IMG_TTL = 10 * 60_000;
const W = 1200, H = 630;
const PAGE_WAIT_MS = 2500;                           // a crawler waits a few seconds for the page; the Gate keeps running after
const IMAGE_WAIT_MS = 9000;                          // the image may wait longer for a Gate check already under way

/* ---------- small things ---------- */
const lc = (s) => String(s || "").toLowerCase();
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// a coin's symbol as people typed it, without control or invisible characters, short enough for a title
const cleanSym = (s) => String(s || "").replace(/^\$/, "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").trim().slice(0, 20);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const timeout = (p, ms, v = null) => Promise.race([Promise.resolve(p).catch(() => v), new Promise((r) => setTimeout(() => r(v), ms))]);
function price(v) {
  if (!(v > 0) || !isFinite(v)) return null;
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 })}`;
  // four significant digits however small (0.0000001234), without trailing zeros past the cents (0.5 → 0.50)
  return `$${v.toFixed(Math.min(14, 3 - Math.floor(Math.log10(v)))).replace(/(\.\d\d\d*?)0+$/, "$1")}`;
}
function stamp(t) {
  const d = new Date(t || Date.now());
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// per IP: a crawler reads a page and its image once; this only stops a script walking random addresses
const hits = new Map();
function limited(ip, n = 90) {
  const now = Date.now();
  let b = hits.get(ip);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; hits.set(ip, b); }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60_000) hits.delete(k);
  return ++b.n > n;
}

/* ---------- what the preview says: the same Gate, Watchfire and price the coin page shows ---------- */
// "Checking" while the Gate runs; the badge's own words after (verdict.js LABEL, shared with Swap and the Gate page)
const LOOK = {
  passed: { tone: "up" }, caution: { tone: "warn" }, failed: { tone: "down" }, untested: { tone: "grey" },
  error: { tone: "grey", label: "Unavailable" }, pending: { tone: "grey", label: "Checking" },
};
const FIRE = { clear: ["Calm", "up", "Nothing unusual in this coin's transfers."], amber: ["Watch", "warn", "Weight in few hands. Nothing moving yet."], red: ["Selling fast", "down", "Holders are leaving quickly."], fire: ["Fire", "down", "A dump pattern just happened."] };

async function facts(a, waitMs) {
  const [market, badge, watchfire] = await Promise.all([import("./market.mjs").catch(() => null), import("./badge.mjs").catch(() => null), import("./watchfire.mjs").catch(() => null)]);
  const row = market?.indexRow?.(a) || null;
  // badgeResult runs the Gate once per 10 minutes per coin (memoised in badge.mjs); a page that cannot wait leaves it running
  const gateP = badge?.badgeResult ? Promise.resolve().then(() => badge.badgeResult(a)).catch((e) => ({ verdict: "error", error: String(e?.message || e).slice(0, 160) })) : Promise.resolve({ verdict: "error" });
  const tokP = row ? Promise.resolve(null) : timeout(market?.getRobinhoodToken?.(a).then((r) => r?.token || null), Math.min(waitMs, 3000));
  const [g, tok] = await Promise.all([timeout(gateP, waitMs, null), tokP]);
  const coin = row || tok || {};
  // Watchfire reads a coin's transfers when someone opens its page; a share of a listed coin starts that reading too, so the
  // next preview carries it (an unlisted address never starts a watch: a script walking addresses must not load the chain)
  let wf = watchfire?.watchfireState?.(a) || null;
  if (!wf && row && watchfire?.watch) { try { watchfire.watch(a, "ask"); } catch { /* the preview goes out without it */ } }
  const gate = g || { verdict: "pending" };
  const look = LOOK[gate.verdict] || LOOK.error;
  const checks = Array.isArray(gate.checks) ? gate.checks : [];
  const pass = checks.filter((c) => c.status === "pass").length;
  const sym = cleanSym(coin.symbol || gate.symbol);
  return {
    address: a, sym, name: String(coin.name || gate.name || "").slice(0, 60), priceUsd: Number(coin.priceUsd) || null, change24h: coin.change24h != null ? Number(coin.change24h) : null,
    verdict: gate.verdict, label: look.label || gate.label || "Unavailable", tone: look.tone, answer: gate.answer || "", checks, pass, checkedAt: gate.checkedAt || null,
    fire: wf && FIRE[wf.level] ? { word: FIRE[wf.level][0], tone: FIRE[wf.level][1], line: String((wf.why || [])[0] || FIRE[wf.level][2]) } : null,
  };
}

function gateLine(f) {
  const n = f.checks.length;
  if (f.verdict === "pending") return "Troya Gate is checking it now: a simulated buy and a test sell from a fresh address.";
  if (f.verdict === "passed" || f.verdict === "caution") return `Troya Gate: ${f.label}. ${f.pass} of ${n} checks passed on a simulated buy and a test sell from a fresh address.`;
  if (f.verdict === "failed") { const why = f.answer.replace(/^No:\s*/, ""); return `Troya Gate: Blocked${why ? `, ${why}` : ""}.`; }
  if (f.verdict === "untested") return "Troya Gate: Not testable yet, no buyers on the curve right now.";
  return "Troya Gate could not check it just now.";
}
function describe(f) {
  const fire = f.fire ? ` Watchfire: ${f.fire.word}. ${f.fire.line.replace(/\.?$/, ".")}` : " Watchfire reads every transfer of the coin on its page.";
  return `${gateLine(f)}${fire}`.slice(0, 300);
}
const titleOf = (f) => [f.sym ? `$${f.sym}` : short(f.address), price(f.priceUsd), `Troya Gate: ${f.verdict === "pending" ? "checking" : f.label}`].filter(Boolean).join(" · ");

/* ---------- the pages ---------- */
function page({ title, desc, url, canonical = url, image, alt, target, link }) {
  const script = `location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});`;
  const sha = createHash("sha256").update(script).digest("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Troya Agent">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(alt)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@Troyaagent">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<script>${script}</script>
</head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#05090b;color:#c3cfd8;font:16px/1.5 system-ui,sans-serif">
<p><a href="${esc(target)}" style="color:#8edff5">${esc(link)}</a></p></body></html>`;
  return { html, csp: `default-src 'none'; script-src 'sha256-${sha}'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` };
}
function sendPage(req, res, p, maxAge) {
  const body = Buffer.from(p.html, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": `public, max-age=${maxAge}`,
    "content-security-policy": p.csp, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" });
  res.end(req.method === "HEAD" ? undefined : body);
}

/* ---------- drawing: an RGB float canvas, src-over blending, shapes by signed distance (one pixel of anti-aliasing) ---------- */
const C = { bg: [5, 9, 11], fg: [243, 248, 251], fg2: [195, 207, 216], muted: [125, 139, 151], faint: [86, 99, 110], accent: [142, 223, 245], up: [142, 223, 245], down: [255, 125, 125], warn: [240, 196, 110], grey: [159, 176, 191] };
const TONE = { up: [[247, 253, 255], C.up], down: [[255, 217, 217], C.down], warn: [[255, 240, 207], C.warn], grey: [[227, 235, 240], C.grey] };
const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

class Raster {
  constructor(w, h, bg) { this.w = w; this.h = h; this.p = new Float32Array(w * h * 3); for (let i = 0; i < w * h; i++) this.p.set(bg, i * 3); }
  put(x, y, col, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3, p = this.p;
    p[i] += (col[0] - p[i]) * a; p[i + 1] += (col[1] - p[i + 1]) * a; p[i + 2] += (col[2] - p[i + 2]) * a;
  }
  // coverage(x + .5, y + .5) → 0..1 over a box; col may be a function of y
  shape(x0, y0, x1, y1, cover, col, alpha = 1) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      const c = typeof col === "function" ? col(y) : col;
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) { const v = cover(x + 0.5, y + 0.5); if (v > 0) this.put(x, y, c, v * alpha); }
    }
  }
  radial(cx, cy, r, stops) {                 // stops: [t, alpha] of one colour, as the browser card's createRadialGradient
    const col = stops.col;
    this.shape(cx - r, cy - r, cx + r, cy + r, (x, y) => {
      const t = Math.hypot(x - cx, y - cy) / r;
      if (t >= 1) return 0;
      for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [t0, a0] = stops[i - 1], [t1, a1] = stops[i]; return a0 + ((a1 - a0) * (t - t0)) / (t1 - t0 || 1); }
      return 0;
    }, col);
  }
  rrect(x, y, w, h, r, { fill, fillA = 1, stroke, strokeA = 1, lw = 1 } = {}) {
    const cx = x + w / 2, cy = y + h / 2, hw = w / 2, hh = h / 2;
    const sd = (px, py) => { const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
    if (fill) this.shape(x - 1, y - 1, x + w + 1, y + h + 1, (px, py) => clamp01(0.5 - sd(px, py)), fill, fillA);
    if (stroke) this.shape(x - lw, y - lw, x + w + lw, y + h + lw, (px, py) => clamp01(lw / 2 + 0.5 - Math.abs(sd(px, py))), stroke, strokeA);
  }
  circle(cx, cy, r, opts) { this.rrect(cx - r, cy - r, r * 2, r * 2, r, opts); }
  line(x0, y0, x1, y1, lw, col) {          // round caps
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-9;
    this.shape(Math.min(x0, x1) - lw, Math.min(y0, y1) - lw, Math.max(x0, x1) + lw, Math.max(y0, y1) + lw, (px, py) => {
      const t = clamp01(((px - x0) * dx + (py - y0) * dy) / L2);
      return clamp01(lw / 2 + 0.5 - Math.hypot(px - x0 - t * dx, py - y0 - t * dy));
    }, col);
  }
  // an RGBA picture of exactly w × h at (x, y), optionally cut to a circle
  image(img, x, y, round = false) {
    const r = img.w / 2;
    for (let j = 0; j < img.h; j++) for (let i = 0; i < img.w; i++) {
      const o = (j * img.w + i) * 4;
      const m = round ? clamp01(r + 0.5 - Math.hypot(i + 0.5 - r, j + 0.5 - r)) : 1;
      this.put(x + i, y + j, [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]], (img.rgba[o + 3] / 255) * m);
    }
  }
  // an opaque RGB PNG. Not icons.mjs's encoder: that one tries five filters per row and deflates at level 9 on the main
  // thread (about 300 ms for a card, with the Telegram and X bots waiting); here every row uses the Sub filter, which suits
  // smooth gradients, and zlib compresses on its thread pool
  async png() {
    const { w, h, p } = this, stride = w * 3, raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) {
      const o = y * (stride + 1), s = y * stride;
      raw[o] = 1;
      for (let i = 0; i < stride; i++) {
        const v = Math.round(p[s + i]), left = i >= 3 ? Math.round(p[s + i - 3]) : 0;
        raw[o + 1 + i] = (v - left) & 255;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
  }
}
const deflate = promisify(zlib.deflate);
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
  let c = -1;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  b.writeUInt32BE((c ^ -1) >>> 0, 8 + data.length);
  return b;
}

/* ---------- words from the glyph atlas ---------- */
let atlasP = null;
function atlas() {
  atlasP ||= (async () => {
    const { _test: icons } = await import("./icons.mjs");
    const [png, json, logo] = await Promise.all([readFile(join(ASSETS, "glyphs.png")), readFile(join(ASSETS, "glyphs.json"), "utf8"), readFile(LOGO).catch(() => null)]);
    const img = await icons.pngDecode(png), meta = JSON.parse(json);
    const alpha = new Uint8Array(img.w * img.h), line = new Uint8Array(img.w * 4);
    for (let y = 0; y < img.h; y++) { img.row(y, line); for (let x = 0; x < img.w; x++) alpha[y * img.w + x] = line[x * 4 + 3]; }
    let mark = null;
    if (logo) { const l = await icons.pngDecode(logo); if (l) mark = icons.resize(l, 0, 0, l.w, l.h, 60, 60); }
    return { icons, w: img.w, alpha, faces: meta.faces, mark };
  })();
  atlasP.catch(() => { atlasP = null; });
  return atlasP;
}
const has = (A, face, s) => [...String(s)].every((ch) => A.faces[face].glyphs[ch]);
function measure(A, face, s, scale = 1) {
  const f = A.faces[face], chars = [...String(s)];
  let x = 0;
  chars.forEach((ch, i) => { x += (f.glyphs[ch] || f.glyphs["?"] || { adv: f.size / 2 }).adv; if (i < chars.length - 1) x += f.kern[ch + chars[i + 1]] || 0; });
  return x * scale;
}
// the largest scale (down to min) at which s fits maxW
const fit = (A, face, s, maxW, min = 0.5) => Math.max(min, Math.min(1, maxW / Math.max(1, measure(A, face, s))));
// s cut to maxW with an ellipsis
function clip(A, face, s, maxW, scale = 1) {
  let t = String(s);
  if (measure(A, face, t, scale) <= maxW) return t;
  while (t && measure(A, face, `${t}…`, scale) > maxW) t = [...t].slice(0, -1).join("");
  return `${t.replace(/[\s,.;:]+$/, "")}…`;
}
// draws s with its baseline at y; align "left" | "center" | "right"; col a colour or a function of y (a gradient)
function text(R, A, face, s, x, y, col, { scale = 1, align = "left", alpha = 1 } = {}) {
  const f = A.faces[face], chars = [...String(s)], width = measure(A, face, s, scale);
  let pen = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  chars.forEach((ch, i) => {
    const g = f.glyphs[ch] || f.glyphs["?"];
    if (g?.w) {
      if (scale === 1) {
        const gx = Math.round(pen + g.ox), gy = Math.round(y + g.oy);
        for (let j = 0; j < g.h; j++) {
          const c = typeof col === "function" ? col(gy + j) : col;
          for (let k = 0; k < g.w; k++) { const v = A.alpha[(g.y + j) * A.w + g.x + k]; if (v) R.put(gx + k, gy + j, c, (v / 255) * alpha); }
        }
      } else {
        // scaled: each target pixel averages a 2 × 2 grid of bilinear samples from the glyph
        const x0 = pen + g.ox * scale, y0 = y + g.oy * scale, tw = Math.ceil(g.w * scale) + 1, th = Math.ceil(g.h * scale) + 1;
        const at = (sx, sy) => {
          if (sx < -1 || sy < -1 || sx > g.w || sy > g.h) return 0;
          const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
          const px = (u, v) => (u < 0 || v < 0 || u >= g.w || v >= g.h ? 0 : A.alpha[(g.y + v) * A.w + g.x + u]);
          return (px(ix, iy) * (1 - fx) + px(ix + 1, iy) * fx) * (1 - fy) + (px(ix, iy + 1) * (1 - fx) + px(ix + 1, iy + 1) * fx) * fy;
        };
        const bx = Math.floor(x0), by = Math.floor(y0);
        for (let j = 0; j <= th; j++) {
          const c = typeof col === "function" ? col(by + j) : col;
          for (let k = 0; k <= tw; k++) {
            let v = 0;
            for (const [u, w] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) v += at((bx + k + u - x0) / scale - 0.5, (by + j + w - y0) / scale - 0.5);
            if (v > 0) R.put(bx + k, by + j, c, (v / 4 / 255) * alpha);
          }
        }
      }
    }
    pen += (g ? g.adv : f.size / 2) * scale;
    if (i < chars.length - 1) pen += (f.kern[ch + chars[i + 1]] || 0) * scale;
  });
  return width;
}

function mark(R, x, y, status) {
  const col = status === "pass" ? C.up : status === "fail" ? C.down : status === "warn" ? C.warn : C.grey;
  R.circle(x, y, 12, { fill: col, fillA: 0x22 / 255, stroke: col, strokeA: 0xaa / 255, lw: 1.5 });
  const L = (a, b, c, d) => R.line(x + a, y + b, x + c, y + d, 2.6, col);
  if (status === "pass") { L(-5, 0.5, -1.5, 4); L(-1.5, 4, 5.5, -4); }
  else if (status === "fail") { L(-4.5, -4.5, 4.5, 4.5); L(4.5, -4.5, -4.5, 4.5); }
  else if (status === "warn") { L(0, -5.5, 0, 1.5); L(0, 5.2, 0, 5.3); }
  else L(-5, 0, 5, 0);
}

// the coin's own logo, 96 px, from the icon proxy on this same server (it fetches, checks and caches logos already)
async function coinLogo(A, a) {
  const port = +(process.env.PORT || 9270);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/icon/token/${a}`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok || !/image\/png/.test(r.headers.get("content-type") || "")) return null;
    const img = await A.icons.pngDecode(Buffer.from(await r.arrayBuffer()));
    if (!img) return null;
    const side = Math.min(img.w, img.h);
    return A.icons.resize(img, (img.w - side) / 2, (img.h - side) / 2, side, side, 96, 96);
  } catch { return null; }
}

/** The 1200 × 630 preview of a coin, in the share card's layout (public/agent/js/sharecard.js drawCard, kind "gate"). */
export async function drawCoin(f, { logo = null } = {}) {
  const A = await atlas();
  const R = new Raster(W, H, C.bg);
  const tone = TONE[f.tone] || TONE.grey, toneCol = tone[1];
  // the room: two soft lights and faint horizontal slices, as on the card people download
  R.radial(170, 70, 760, Object.assign([[0, 0.2], [0.45, 0.06], [1, 0]], { col: [95, 211, 239] }));
  R.radial(1060, 640, 620, Object.assign([[0, f.tone === "down" ? 0.13 : f.tone === "warn" ? 0.11 : 0.12], [1, 0]], { col: f.tone === "down" ? [255, 125, 125] : f.tone === "warn" ? [240, 196, 110] : [142, 223, 245] }));
  for (let y = 0; y < H; y += 7) R.shape(0, y, W, y + 1, () => 1, [255, 255, 255], 0.016);
  R.rrect(16, 16, W - 32, H - 32, 28, { stroke: [255, 255, 255], strokeA: 0.08, lw: 1.5 });

  // header
  if (A.mark) R.image(A.mark, 60, 50);
  const bx = A.mark ? 132 : 64;
  const tw = text(R, A, "brandB", "Troya", bx, 91, C.fg);
  text(R, A, "brandR", "Agent", bx + tw + 8, 91, C.accent);
  text(R, A, "mono", f.checkedAt ? `checked ${stamp(f.checkedAt)}` : stamp(Date.now()), W - 64, 88, C.muted, { align: "right" });

  // kicker
  const kick = "TROYA GATE".split("").join(" ");
  const kw = measure(A, "monoS", kick) + 32;
  R.rrect(64, 140, kw, 34, 17, { fill: toneCol, fillA: 0x14 / 255, stroke: toneCol, strokeA: 0x66 / 255, lw: 1.2 });
  text(R, A, "monoS", kick, 80, 163, toneCol);

  // the coin, its verdict and the checks
  const L = 64, maxW = 720;
  const head = f.sym && has(A, "head", `$${f.sym}`) ? `$${f.sym}` : short(f.address);
  const hs = fit(A, "head", head, maxW, 0.6);
  text(R, A, "head", clip(A, "head", head, maxW, hs), L, 236, C.fg, { scale: hs });
  const ws = fit(A, "big", f.label, maxW, 0.5);            // the atlas word is 100 px (the browser card's 104, near enough)
  const s = A.faces.big.size * ws, y0 = 338 - s * 0.8, y1 = 338 + s * 0.1;
  const grad = (y) => { const t = clamp01((y - y0) / (y1 - y0)); if (t >= 0.55) return tone[1]; const k = t / 0.55; return tone[0].map((v, i) => v + (tone[1][i] - v) * k); };
  text(R, A, "big", f.label, L, 338, grad, { scale: ws });
  const line = f.verdict === "pending" ? "A simulated buy and a test sell, running now"
    : f.verdict === "untested" ? "No buyers on the curve yet, so the test sell waits"
      : f.checks.length ? `${f.pass} of ${f.checks.length} checks passed` : "The checks could not run just now";
  text(R, A, "line", clip(A, "line", line, maxW), L, 384, C.fg2);
  f.checks.slice(0, 8).forEach((ck, i) => {
    const x = L + (i % 2) * 352, y = 430 + Math.floor(i / 2) * 38;
    mark(R, x + 12, y - 7, ck.status);
    text(R, A, "small", clip(A, "small", String(ck.label || ck.key || ""), 300), x + 34, y, ck.status === "pass" ? C.fg2 : C.fg);
  });

  // the right panel: logo, price, 24 h, Watchfire
  const T = 300, tx = 852, ty = 146, cx = tx + T / 2;
  R.radial(cx, ty + T / 2, 260, Object.assign([[0, 0.1], [1, 0]], { col: [95, 211, 239] }));
  R.rrect(tx, ty, T, T, 26, { fill: [255, 255, 255], fillA: 0.035, stroke: [255, 255, 255], strokeA: 0.1, lw: 1 });
  const ly = ty + 34;
  if (logo) {
    R.circle(cx, ly + 48, 50, { fill: [255, 255, 255], fillA: 0.06, stroke: [255, 255, 255], strokeA: 0.12, lw: 1 });
    R.image(logo, cx - 48, ly, true);
  } else {
    R.circle(cx, ly + 48, 48, { fill: toneCol, fillA: 0.12, stroke: toneCol, strokeA: 0.45, lw: 1.2 });
    const letter = [...(f.sym || "?")][0].toUpperCase();
    text(R, A, "head", has(A, "head", letter) ? letter : "?", cx, ly + 64, C.fg, { align: "center" });
  }
  const p = price(f.priceUsd);
  if (p) {
    text(R, A, "head", p, cx, ty + 196, C.fg, { align: "center", scale: fit(A, "head", p, T - 40, 0.5) });
    if (f.change24h != null && isFinite(f.change24h)) {
      const ch = `${f.change24h > 0 ? "+" : f.change24h < 0 ? "−" : ""}${Math.abs(f.change24h).toFixed(1)}% in 24 h`;
      text(R, A, "small", ch, cx, ty + 228, f.change24h >= 0 ? C.up : C.down, { align: "center" });
    }
  } else text(R, A, "small", "No price yet", cx, ty + 200, C.muted, { align: "center" });
  // "Watchfire · Calm": the font's middle dot sits too close at this size, so the dot is drawn
  const word = f.fire ? f.fire.word : "not read yet";
  const fcol = f.fire ? (TONE[f.fire.tone] || TONE.grey)[1] : C.muted;
  const w1 = measure(A, "small", "Watchfire"), fw = w1 + measure(A, "small", word) + 66;
  const fx = cx - fw / 2;
  R.rrect(fx, ty + 248, fw, 34, 17, { fill: fcol, fillA: 0.1, stroke: fcol, strokeA: 0.4, lw: 1 });
  R.circle(fx + 18, ty + 265, 4, { fill: fcol });
  text(R, A, "small", "Watchfire", fx + 30, ty + 272, C.fg2);
  R.circle(fx + 30 + w1 + 9, ty + 265, 1.6, { fill: C.muted });
  text(R, A, "small", word, fx + 30 + w1 + 18, ty + 272, f.fire ? C.fg : C.muted);
  text(R, A, "mono", `troya.codes/t/${short(lc(f.address))}`, cx, ty + T + 42, C.accent, { align: "center" });
  text(R, A, "foot", "Open the link for the full Gate and Watchfire", cx, ty + T + 70, C.muted, { align: "center" });

  text(R, A, "foot", "A simulated buy and a test sell from a fresh address. A snapshot from the chain, not a promise.", L, 598, C.faint);
  return R.png();
}

/* ---------- the image cache: one PNG per coin for 10 minutes, one render at a time per coin ---------- */
const images = new Map();                     // address → { at, key, p }
let rendering = 0;
async function coinImage(a, key) {
  const hit = images.get(a);
  if (hit && Date.now() - hit.at < IMG_TTL && (hit.key === key || key === "p")) return hit.p;
  if (rendering >= 4) { if (hit) return hit.p; throw Object.assign(new Error("busy"), { status: 503 }); }
  rendering++;
  const p = (async () => {
    try {
      const f = await facts(a, IMAGE_WAIT_MS);
      const A = await atlas();
      return { png: await drawCoin(f, { logo: await coinLogo(A, a) }), done: f.verdict !== "pending" };
    } finally { rendering--; }
  })();
  const e = { at: Date.now(), key, p };
  images.set(a, e);
  // a picture drawn while the Gate was still running is kept only a minute, so the next crawl gets the verdict
  p.then((r) => { if (!r.done) e.at = Date.now() - IMG_TTL + 60_000; }, () => { if (images.get(a) === e) images.delete(a); });
  if (images.size > 300) images.delete(images.keys().next().value);
  return p;
}

/* ---------- routes (server.mjs calls this first; false means "not mine") ---------- */
export async function handleShare(req, res, url) {
  const m = /^\/(t|r)\/([^/]+?)\/?$/.exec(url.pathname);
  if (!m) return false;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return true; }
  if (limited(ipOf(req))) { res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "60" }).end("Too many requests, slow down."); return true; }
  const [, kind, raw] = m;
  const refQ = lc(url.searchParams.get("ref"));
  const ref = CODE_RE.test(refQ) ? refQ : null;

  if (kind === "r") {
    const code = lc(raw);
    if (!CODE_RE.test(code)) return false;   // the 404 page
    sendPage(req, res, page({
      title: "Troya Agent · Check a coin before you buy", url: `${SITE}/r/${code}`, image: `${SITE}/og.png?v=2`, alt: "Troya Agent: every token opened at the gate before you sign",
      desc: "Check any Robinhood Chain coin before you buy: Troya Gate runs a simulated buy and a test sell, and Watchfire reads every transfer. Swap, perps and launches, with an agent that never crosses your limits.",
      target: `/agent?ref=${code}`, link: "Open Troya Agent",
    }), 3600);
    return true;
  }

  const png = /\.png$/i.test(raw), addr = raw.replace(/\.png$/i, "");
  if (!ADDR.test(addr)) return false;
  const a = lc(addr);
  if (png) {
    try {
      const key = String(url.searchParams.get("v") || "p").slice(0, 16);
      const r = await coinImage(a, key);
      res.writeHead(200, { "content-type": "image/png", "content-length": r.png.length, "cache-control": `public, max-age=${r.done ? IMG_TTL / 1000 : 60}`, "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : r.png);
    } catch (e) {
      // the site's own picture rather than a broken preview
      res.writeHead(302, { location: `${SITE}/og.png?v=2`, "cache-control": "no-store" }).end();
      if (e?.status !== 503) console.warn("[share] image", a, e?.message);
    }
    return true;
  }
  const f = await facts(a, PAGE_WAIT_MS);
  // the image URL changes with each Gate check, so a crawler that cached an older picture fetches the new one
  const v = f.checkedAt ? Math.floor(f.checkedAt / 60_000).toString(36) : "p";
  const title = titleOf(f);
  sendPage(req, res, page({
    title, desc: describe(f), url: `${SITE}/t/${a}${ref ? `?ref=${ref}` : ""}`, canonical: `${SITE}/t/${a}`, image: `${SITE}/t/${a}.png?v=${v}`,
    alt: `${f.sym ? `$${f.sym}` : short(a)} on Troya Gate: ${f.verdict === "pending" ? "checking" : f.label}`,
    target: `/agent${ref ? `?ref=${ref}` : ""}#/token/${a}`, link: `Open ${f.sym ? `$${f.sym}` : short(a)} on Troya Agent`,
  }), f.verdict === "pending" ? 30 : 120);
  return true;
}

export const _test = { facts, describe, titleOf, price, page, drawCoin, cleanSym };
