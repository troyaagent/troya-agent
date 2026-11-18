// UI helpers shared by every page. Pages build DOM with h() and these small components.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function clear(el, ...kids) { el.replaceChildren(); append(el, kids); return el; }
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------- formatting ---------- */
const nf = (d, min = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: min });
export function num(v, d = 2) { if (v == null || !isFinite(v)) return "–"; return nf(d).format(v); }
export function compact(v, d = 1) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(d) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(d) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(d) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(d) + "K";
  return nf(a < 1 ? 4 : 2).format(v);
}
export function usd(v, opts = {}) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (opts.compact && a >= 1e4) return "$" + compact(v, opts.d ?? 1);
  if (a > 0 && a < 0.01) return "$" + tiny(v);
  return "$" + nf(a >= 1000 ? 0 : 2, a >= 1000 ? 0 : 2).format(v);
}
// tiny prices: 0.0000123 → "0.0₄123" (subscript = count of zeros after the decimal point)
const SUB = "₀₁₂₃₄₅₆₇₈₉";
export function tiny(v, sig = 4) {
  if (v == null || !isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1) return nf(a >= 1000 ? 2 : 4).format(v);
  const s = a.toFixed(20);
  const m = /^0\.(0*)(\d+)/.exec(s);
  if (!m) return String(v);
  const zeros = m[1].length;
  const digits = m[2].slice(0, sig).replace(/0+$/, "") || "0";
  const sign = v < 0 ? "-" : "";
  if (zeros < 4) return sign + "0." + m[1] + digits;
  return sign + "0.0" + String(zeros).split("").map((c) => SUB[+c]).join("") + digits;
}
/** A number with exactly `d` decimals: order books and price columns line up digit for digit. */
export function fixed(v, d = 2) { if (v == null || !isFinite(v)) return "–"; return nf(d, d).format(v); }
/** A USD price (no "$"): 2 decimals from 1 up (64,856.10 · 509.01 · 8.40), small prices in the tiny style. */
export function price(v) { if (v == null || !isFinite(v)) return "–"; return Math.abs(v) >= 1 ? fixed(v, 2) : tiny(v); }
/** A token amount: at least 2 decimals from 1 up (1,169,401.20 · 12.5000 → 12.50), small amounts in the tiny style. */
export function amount(v) { if (v == null || !isFinite(v)) return "–"; const a = Math.abs(v); return a >= 1 ? nf(a >= 1000 ? 2 : 4, 2).format(v) : tiny(v); }
export function hype(v, d) { if (v == null || !isFinite(v)) return "–"; return (Math.abs(v) < 1 ? tiny(v) : compact(v, d ?? 2)) + " HYPE"; }
export function eth(v, d) { if (v == null || !isFinite(v)) return "–"; return (Math.abs(v) < 1 ? tiny(v) : compact(v, d ?? 3)) + " ETH"; }
export function pct(v, d = 2) { if (v == null || !isFinite(v)) return "–"; const a = Math.abs(v); return (v > 0 ? "+" : "") + (a >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(a >= 100 ? 0 : d)) + "%"; }
export function pctEl(v) { return h("span", { class: `pct ${v == null ? "flat" : v > 0.0001 ? "up" : v < -0.0001 ? "down" : "flat"}` }, pct(v)); }
export function short(a, n = 4) { return a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : ""; }
export function ago(ts) {
  if (!ts) return "–";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export function greeting() { const hr = new Date().getHours(); return hr < 5 ? "Late night" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"; }

/* ---------- icons (inline SVG, stroke) ---------- */
const P = {
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  wallet: "M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3m0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5m18 7h-4a2 2 0 0 0 0 4h4z",
  close: "M18 6 6 18M6 6l12 12",
  swap: "M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  arrowRight: "M5 12h14M12 5l7 7-7 7",
  ext: "M7 17 17 7M8 7h9v9",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M20 6 9 17l-5-5",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  plus: "M12 5v14M5 12h14",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  pause: "M8 5v14M16 5v14",
  play: "M7 4v16l13-8z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
  pool: "M3 15c2 0 2-2 4.5-2S10 15 12 15s2.5-2 4.5-2 2.5 2 4.5 2M3 20c2 0 2-2 4.5-2S10 20 12 20s2.5-2 4.5-2 2.5 2 4.5 2M12 3v7m-3-3 3 3 3-3",
  loop: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  menu: "M3 6h18M3 12h18M3 18h18",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  key: "M15 7a4 4 0 1 1-4.9 3.9L3 18v3h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7z",
  bridge: "M3 18h18M5 18V9m14 9V9M3 9c4 0 5-4 9-4s5 4 9 4",
  rocket: "M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2M14 4l6 6-8 8-6-6zM16 2l6 6",
};
export function icon(name, cls = "") {
  return icon_(name, cls);
}
function icon_(name, cls = "") {
  const d = P[name] || P.info;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.6");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = d.split(/(?=M)/).map((s) => `<path d="${s}"/>`).join("");
  return el;
}
/* ---------- logos ---------- */
const L = "/img/logos/";
// official marks for networks, launchpads, venues and wallets (self-hosted in /img/logos)
export const LOGOS = {
  chain: { robinhood: "robinhood.png", hyperliquid: "hyperliquid.svg", arbitrum: "arbitrum-disc.svg", base: "base.png", ethereum: "eth-color.svg", solana: "sol.svg" },
  pad: { clanker: "clanker.png", bankr: "bankr.png", virtuals: "virtuals.png", mintclub: "mintclub.png", uniswap: "uniswap.webp", ramses: "ramses.png", pancake: "pancake.png", sushi: "sushi.png", stocks: "robinhood.png", pons: "pons.svg" },
  venue: { uniswap: "uniswap.webp", lifi: "lifi.webp", relay: "relay.webp", hyperliquid: "hyperliquid.svg", wrap: "eth-color.svg" },
  wallet: { metamask: "metamask.webp", rabby: "rabby.webp", okx: "okx.webp", coinbase: "coinbase.webp" },
  symbol: { HYPE: "hyperliquid.svg", USDC: "usdc.svg", ETH: "eth-color.svg", WETH: "eth-color.svg", USDG: "usdg.png", SOL: "sol.svg" },
};
const NATIVE = /^(eth|native|0x0{40}|0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)$/i;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const logoUrl = (kind, key) => { const f = LOGOS[kind]?.[String(key || "").toLowerCase()] || LOGOS[kind]?.[key]; return f ? L + f : null; };

// round badge that tries image sources in order and keeps a monogram only when none loads
function logoBox(cls, label, sources, title) {
  const box = h("span", { class: cls, title: title || null });
  box.textContent = label;
  const list = sources.filter(Boolean);
  const next = () => {
    const src = list.shift();
    if (!src) return;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onload = () => { box.textContent = ""; box.classList.add("has-img"); box.append(img); };
    img.onerror = next;
    img.src = src;
  };
  next();
  return box;
}
const mono = (s) => (String(s || "?").replace(/^[a-z0-9]+:/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?");

export function chainLogo(chain, size = 16) {
  const k = String(chain || "").toLowerCase();
  const b = logoBox("chain-logo", "", [logoUrl("chain", k)], k);
  b.style.width = b.style.height = size + "px";
  return b;
}
// launchpads and venues without a logo file use their own token's logo through the icon proxy
const PAD_ICON = {
  abyss: "/api/icon/token/0x15f3385625d7e364c5a6216fbbceadf10fa90e7d",
  goo: "/api/icon/token/0x6572eade9fb17f4027baf92feac222b9aa746bd0",
  aero: "/api/icon/token/0x940181a94A35A4569E4529A3CDfB74e38FD98631?chain=base",
};
export function padLogo(pad, size = 16) {
  const k = String(pad || "other").toLowerCase();
  const b = logoBox("pad-logo", k === "other" ? "…" : mono(k).slice(0, 1), [logoUrl("pad", k), PAD_ICON[k]], k);
  b.style.width = b.style.height = size + "px";
  return b;
}
export function venueLogo(v, size = 16) {
  const k = String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = Object.keys(LOGOS.venue).find((x) => k.includes(x));
  const b = logoBox("pad-logo", mono(k).slice(0, 1), [key ? L + LOGOS.venue[key] : null], v);
  b.style.width = b.style.height = size + "px";
  return b;
}
export function walletLogo(name, icon, size = 26) {
  const k = String(name || "").toLowerCase();
  const key = Object.keys(LOGOS.wallet).find((x) => k.includes(x));
  const b = logoBox("wallet-logo", "", [icon && /^(data:image\/|https:)/.test(icon) ? icon : null, key ? L + LOGOS.wallet[key] : null], name);
  if (!b.classList.contains("has-img")) b.append(icon_("wallet"));
  b.style.width = b.style.height = size + "px";
  return b;
}

/* ---------- token icon ---------- */
// sources: brand logo for ETH/WETH/USDG → Troya icon cache (GeckoTerminal, DexScreener, Pons on-chain logo) → listing image → monogram
// coins born through Troya (and $TROYA itself) wear the chrome horse in the corner of their logo, everywhere in the app
const BORN = new Set(), GOLD = new Set();   // GOLD: born through Troya and graduated to its own pool
try { const k = JSON.parse(localStorage.getItem("troya.born") || "{}"); for (const a of k.b || []) BORN.add(a); for (const a of k.g || []) GOLD.add(a); } catch {}
// { all: true }: the list is the server's full one, so a coin that left it (a hidden team test) loses its horse here too
export function setBorn(list, graduated = [], { all = false } = {}) {
  if (all && Array.isArray(list)) { BORN.clear(); GOLD.clear(); }
  for (const a of list || []) if (ADDR.test(String(a))) BORN.add(String(a).toLowerCase());
  for (const a of graduated || []) if (ADDR.test(String(a))) { BORN.add(String(a).toLowerCase()); GOLD.add(String(a).toLowerCase()); }
  try { localStorage.setItem("troya.born", JSON.stringify({ b: [...BORN].slice(-400), g: [...GOLD].slice(-200) })); } catch {}
}
export const isBorn = (a) => BORN.has(String(a || "").toLowerCase());
// hovering (or tapping) the horse badge opens a small card: born through Troya, and how to launch your own.
// One floating card for the whole page, so a lane or a box that clips its content never cuts it off.
let bornPop = null, bornHide = 0;
function bornCard(badge, gold) {
  if (!bornPop) {
    bornPop = h("div", { class: "born-pop", role: "tooltip", hidden: true });
    bornPop.addEventListener("mouseenter", () => clearTimeout(bornHide));
    bornPop.addEventListener("mouseleave", () => hideBorn());
    document.addEventListener("click", (e) => { if (bornPop && !bornPop.hidden && !bornPop.contains(e.target) && !e.target.closest?.(".tok-troya")) bornPop.hidden = true; });
    addEventListener("scroll", () => { if (bornPop) bornPop.hidden = true; }, { passive: true, capture: true });
    document.body.append(bornPop);
  }
  clearTimeout(bornHide);
  clear(bornPop,
    h("div", { class: "born-pop-head" }, h("img", { src: "/img/logo-3d-128.png", alt: "" }), h("span", {}, h("b", {}, "Born through Troya"), h("small", {}, gold ? "Graduated to its own Uniswap pool" : "Still on its Pons curve"))),
    h("a", { class: "born-pop-link", href: "/agent#/create", onclick: () => { bornPop.hidden = true; } }, "Create your coin", h("i", {}, "→")),
    h("a", { class: "born-pop-link", href: "/agent#/launch/x", onclick: () => { bornPop.hidden = true; } }, "Launch from X", h("i", {}, "→")));
  bornPop.classList.toggle("gold", gold);
  bornPop.hidden = false;
  const r = badge.getBoundingClientRect(), w = bornPop.offsetWidth, hh = bornPop.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + hh > innerHeight - 8) top = r.top - hh - 8;
  bornPop.style.left = `${left}px`; bornPop.style.top = `${Math.max(8, top)}px`;
}
const hideBorn = () => { clearTimeout(bornHide); bornHide = setTimeout(() => { if (bornPop) bornPop.hidden = true; }, 220); };
let tipBox = null, tipHide = 0;
function showTip(el, title, text, tone) {
  if (!tipBox) {
    tipBox = h("div", { class: "tip-pop", role: "tooltip", hidden: true });
    addEventListener("scroll", () => { if (tipBox) tipBox.hidden = true; }, { passive: true, capture: true });
    document.addEventListener("click", (e) => { if (tipBox && !tipBox.hidden && !e.target.closest?.("[data-tip]")) tipBox.hidden = true; });
    document.body.append(tipBox);
  }
  clearTimeout(tipHide);
  clear(tipBox, title ? h("b", {}, title) : null, h("span", {}, text));
  tipBox.className = `tip-pop${tone ? " " + tone : ""}`;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect(), w = tipBox.offsetWidth, hh = tipBox.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.top - hh - 8;
  if (top < 8) top = r.bottom + 8;
  tipBox.style.left = `${left}px`; tipBox.style.top = `${top}px`;
}
/** Explains `el` on hover, focus or tap: a title and one line. */
export function tipOn(el, title, text, tone = "") {
  el.dataset.tip = "1";
  el.tabIndex = 0;
  el.setAttribute("aria-label", title ? `${title}: ${text}` : text);
  el.addEventListener("mouseenter", () => showTip(el, title, text, tone));
  el.addEventListener("focus", () => showTip(el, title, text, tone));
  const hide = () => { clearTimeout(tipHide); tipHide = setTimeout(() => { if (tipBox) tipBox.hidden = true; }, 120); };
  el.addEventListener("mouseleave", hide);
  el.addEventListener("blur", hide);
  el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); showTip(el, title, text, tone); });
  return el;
}
export function tokenIcon(t, size = "") {
  const sym = String(t?.symbol || "").toUpperCase();
  const addr = String(t?.address || "");
  const native = !addr ? sym === "ETH" : NATIVE.test(addr);
  const brand = native ? L + (sym === "SOL" ? LOGOS.symbol.SOL : LOGOS.symbol.ETH) : null;
  const img = t?.image || t?.imageUrl || t?.logo;
  const direct = img && /^(https:|\/)/.test(img) ? img : null;
  // logos go through our cached proxy first: some hosts (ipfs.io) refuse to be embedded cross-origin
  const net = String(t?.chain || "robinhood").toLowerCase();
  const other = net === "base" || net === "arbitrum" || net === "solana";
  const proxied = net === "solana" ? (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? `/api/icon/token/${addr}?chain=solana` : null)
    : ADDR.test(addr) ? `/api/icon/token/${addr.toLowerCase()}?${other ? `chain=${net}&` : ""}v=4` : null;   // v=4: stock logos as round-safe tiles (18 Nov)
  const box = logoBox(`tok-ico ${size}`, mono(t?.symbol), [
    brand,
    !native && ({ "0x0bd7d308f8e1639fab988df18a8011f41eacad73": L + LOGOS.symbol.WETH, "0x5fc5360d0400a0fd4f2af552add042d716f1d168": L + LOGOS.symbol.USDG })[addr.toLowerCase()] || null,
    proxied, direct,
    !ADDR.test(addr) && LOGOS.symbol[sym] ? L + LOGOS.symbol[sym] : null,
  ]);
  const hue = [...(addr || sym || "x")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  box.style.background = `linear-gradient(135deg, hsl(${(hue % 60) + 170} 45% 26%), hsl(${(hue % 60) + 190} 50% 14%))`;
  if (ADDR.test(addr) && !other && BORN.has(addr.toLowerCase())) {
    const gold = GOLD.has(addr.toLowerCase());
    const horse = h("span", { class: `tok-net tok-troya${gold ? " gold" : ""}`, role: "button", tabindex: "0", "aria-label": gold ? "Born through Troya, graduated: launch your own coin" : "Born through Troya: launch your own coin" }, h("img", { src: "/img/logo-3d-128.png", alt: "", decoding: "async" }));
    horse.addEventListener("mouseenter", () => bornCard(horse, gold));
    horse.addEventListener("mouseleave", hideBorn);
    horse.addEventListener("focus", () => bornCard(horse, gold));
    horse.addEventListener("blur", hideBorn);
    // a tap opens the card instead of following the row or card the logo sits in
    horse.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); bornCard(horse, gold); });
    return h("span", { class: `tok-wrap ${size}` }, box, horse);
  }
  // network badge in the corner (like a wallet's token list): pass t.chain = "robinhood" | "base" | "arbitrum" | …
  if (!t?.chain || !LOGOS.chain[net]) return box;
  const badge = logoBox("tok-net", "", [logoUrl("chain", net)], net);
  return h("span", { class: `tok-wrap ${size}` }, box, badge);
}
// Hyperliquid market logo (perps, HIP-3 "dex:COIN", spot)
export function coinIcon(coin, size = "") {
  const c = String(coin || "");
  // brand logos first for the coins whose Hyperliquid glyph is dark on our dark tiles (ETH, UETH, SOL, HYPE …)
  const base = c.replace(/^[a-z0-9]+:/, "").replace(/_spot$/, "").replace(/^U(?=(ETH|SOL)$)/, "").replace(/^W(?=ETH$)/, "");
  const brand = LOGOS.symbol[base] && base !== "USDG" ? L + LOGOS.symbol[base] : null;
  return logoBox(`tok-ico perp ${size}`, mono(c).slice(0, 1), [brand, c ? `/api/icon/coin/${encodeURIComponent(c)}?v=3` : null]);
}

/* ---------- sparkline ---------- */
export function sparkline(values, opts = {}) {
  const w = opts.w || 80, hgt = opts.h || 24;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");
  const v = (values || []).filter((x) => x != null && isFinite(x));
  if (v.length < 2) { svg.innerHTML = `<line x1="0" y1="${hgt / 2}" x2="${w}" y2="${hgt / 2}" stroke="var(--line-3)" stroke-width="1"/>`; return svg; }
  const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * w, hgt - 2 - ((x - min) / rng) * (hgt - 4)]);
  const up = v[v.length - 1] >= v[0];
  const col = opts.color || (up ? "var(--up)" : "var(--down)");
  svg.innerHTML = `<polyline fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round" points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/>`;
  return svg;
}

/* ---------- small components ---------- */
export function pageHead(title, sub, extra = {}) {
  return h("header", { class: "page-head" },
    h("h1", {}, title, extra.badge ? h("span", { class: `badge-s ${extra.badgeClass || ""}` }, extra.badge) : null),
    sub ? h("p", {}, sub) : null,
    extra.act ? h("div", { class: "act" }, extra.act) : null);
}
export function seg(options, value, onChange, cls = "") {
  const box = h("div", { class: `seg ${cls}`, role: "group" });
  const render = () => {
    box.replaceChildren(...options.map((o) => {
      const opt = typeof o === "string" ? { value: o, label: o } : o;
      return h("button", { type: "button", "data-v": opt.value, "aria-pressed": String(opt.value === value), onclick: () => { value = opt.value; render(); onChange?.(value); } }, opt.label);
    }));
  };
  render();
  box.set = (v) => { value = v; render(); };
  box.get = () => value;
  return box;
}
export function tabs(options, value, onChange) {
  const box = h("div", { class: "tabs", role: "tablist" });
  const render = () => box.replaceChildren(...options.map((o) => {
    const opt = typeof o === "string" ? { value: o, label: o } : o;
    return h("button", { type: "button", role: "tab", "aria-selected": String(opt.value === value), onclick: () => { value = opt.value; render(); onChange?.(value); } }, opt.label);
  }));
  render();
  box.set = (v) => { value = v; render(); };
  return box;
}
// the small "i": a styled tip on hover, focus and tap (a native title never shows on phones)
export function infoTip(text, title = "") { return tipOn(h("i", { class: "info", role: "button" }, "i"), title, text); }
export function skeletonRows(n = 6, cols = 6) {
  return Array.from({ length: n }, () => h("tr", {}, Array.from({ length: cols }, (_, i) => h("td", { class: i < 2 ? "l" : "" }, h("div", { class: "sk", style: { height: "14px", width: i === 1 ? "140px" : "60px", marginLeft: i < 2 ? "0" : "auto" } })))));
}
export function emptyState(title, text, action) { return h("div", { class: "empty" }, h("b", {}, title), text ? h("div", {}, text) : null, action || null); }

// sortable table: cols = [{key,label,align:'l'|'r',sort:true,render:(row)=>node|string,hide:bool}]
export function table({ cols, onRow, onSort, sort, emptyText = "Nothing here yet." }) {
  const thead = h("thead");
  const tbody = h("tbody");
  const el = h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, thead, tbody));
  let cur = sort || null;
  const head = () => thead.replaceChildren(h("tr", {}, cols.filter((c) => !c.hide).map((c) => {
    const active = cur && cur.key === c.key;
    return h("th", {
      class: `${c.align === "l" ? "l" : ""} ${c.sort ? "sort" : ""} ${c.cls || ""}`, ...(active ? { "aria-sort": cur.dir === "asc" ? "ascending" : "descending" } : {}),
      onclick: c.sort ? () => { cur = { key: c.key, dir: active && cur.dir === "desc" ? "asc" : "desc" }; head(); onSort?.(cur.key, cur.dir); } : null,
    }, c.label, active ? (cur.dir === "asc" ? " ↑" : " ↓") : "");
  })));
  head();
  el.setLoading = (n = 8) => tbody.replaceChildren(...skeletonRows(n, cols.filter((c) => !c.hide).length));
  el.setRows = (rows) => {
    if (!rows.length) { tbody.replaceChildren(h("tr", {}, h("td", { colspan: cols.length, class: "l" }, emptyState(emptyText)))); return; }
    tbody.replaceChildren(...rows.map((r, i) => h("tr", { class: onRow ? "click" : "", onclick: onRow ? () => onRow(r) : null },
      cols.filter((c) => !c.hide).map((c) => { const v = c.render ? c.render(r, i) : r[c.key]; return h("td", { class: c.align === "l" ? "l" : c.cls || "" }, v); }))));
  };
  return el;
}

/* ---------- toast / modal / confirm ---------- */
export function toast(text, kind = "", ms = 3200) {
  const box = document.querySelector("[data-toasts]");
  if (!box) return;
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
export async function copyText(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label, "ok"); } catch { toast("Copy failed", "error"); }
}
// every open dialog, so a route change can close them: a picker left open would act on a page that is gone
const openModals = new Set();
export function closeModals() { for (const m of [...openModals]) m.close(); }
addEventListener("hashchange", () => closeModals());
export function modal({ title, body, wide = false, onClose } = {}) {
  let closed = false;
  const close = () => { if (closed) return; closed = true; openModals.delete(handle); bg.remove(); removeEventListener("keydown", key); onClose?.(); };
  const key = (e) => { if (e.key === "Escape") close(); };
  const box = h("div", { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    title ? h("div", { class: "modal-h" }, h("h2", {}, title), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: close }, icon("close"))) : null,
    h("div", { class: "modal-b" }, body));
  const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) close(); } }, box);
  document.body.append(bg);
  addEventListener("keydown", key);
  setTimeout(() => box.querySelector("input, button.primary, button")?.focus(), 30);
  const handle = { close, box, body: box.querySelector(".modal-b") };
  openModals.add(handle);
  return handle;
}
// review dialog: rows = [[label, value], …]; resolves true/false
export function review({ title = "Review", summary, rows = [], warn, confirmLabel = "Confirm", danger = false, extra } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const body = h("div", {},
      summary ? h("p", { style: { margin: "0 0 6px", fontSize: "14px" } }, summary) : null,
      h("div", { class: "rows" }, rows.filter(Boolean).map(([k, v]) => h("div", {}, h("span", {}, k), h("span", {}, v)))),
      extra || null,
      warn ? h("div", { class: "alert warn", style: { marginBottom: "12px" } }, warn) : null,
      h("div", { class: "row", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn ghost", type: "button", onclick: () => finish(false) }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", onclick: () => finish(true) }, confirmLabel)));
    const m = modal({ title, body, onClose: () => finish(false) });
  });
}

/* ---------- misc ---------- */
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function every(ms, fn) { fn(); const id = setInterval(() => { if (!document.hidden) fn(); }, ms); return () => clearInterval(id); }
export function store(key, fallback) {
  return {
    get() { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} },
  };
}

/* ---------- per-page stylesheet ---------- */
// Pages call useCss("market") to load /agent/css/market.css once.
// A sheet that fails to load (a 502 during a deploy) is dropped and tried again, so the page never stays unstyled.
const loadedCss = new Set();
export function useCss(name, tries = 0) {
  if (loadedCss.has(name)) return;
  loadedCss.add(name);
  const link = h("link", { rel: "stylesheet", href: `/agent/css/${name}.css${tries ? `?r=${tries}` : ""}` });
  link.onerror = () => { loadedCss.delete(name); link.remove(); if (tries < 4) setTimeout(() => useCss(name, tries + 1), 1500 * (tries + 1)); };
  document.head.append(link);
}
