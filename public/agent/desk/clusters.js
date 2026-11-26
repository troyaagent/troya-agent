// Cluster map (community request 24 Nov 2026; rebuilt 27 Nov in the style of the Bubblemaps map the owner showed): a coin's
// 50 largest holders as glass bubbles on a canvas, sized by the share they hold, spread out with room between them. Wallets
// linked to each other share a colour per cluster, with lines and arrowheads where coins or ETH went, and small dashed dots
// for the wallets off the map that join them. Drag to pan, wheel or pinch to zoom, click a bubble for its card (amount, USD
// value, coins in and out with each counterparty and transaction). The address list beside it hides or shows each holder;
// pools, lockers, staking and burn addresses start hidden (they are not people) and are never grouped.
// The data is GET /api/clusters/:token (server/clusters.mjs); placement, colours and the list rows are cluster-layout.js
// (no DOM, tested in Node by tools/clustermap-test.mjs); this file draws and handles input.
//   clusterSection(address, { lazy, inset, link, compact })  the section for the token page and the Gate result
//     (compact: the token page's analysis card, beside the chart: the map fills the pane, the card floats over it)
//   mount(view, ctx)                                the page at #/clusters and #/clusters/<token>
import { h, clear, icon, short, ago, toast, compact as cpt } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";
import { buildGraph, layoutGraph, bounds, arrowGeometry, listRows, defaultHidden, colorIndex, isContract, PALETTE_SIZE } from "./cluster-layout.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const LABEL = { wallet: "Wallet", dev: "Dev wallet", pool: "Pool", locker: "Locker", staking: "Staking contract", burn: "Burn address", contract: "Contract" };
const EVTYPE = { tx: "Transaction", address: "Address", block: "Block" };
const STATUS = { done: "read", running: "still reading", failed: "could not be read", "n/a": "not applicable" };
const VIA = { funder: "Shared funder", contract: "Private contract", sender: "Sent coins to several holders", receiver: "Collected coins from several holders" };
const SAMPLES = [["$TROYA", "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"]];
const FALLBACK = ["#b28cff", "#f5c451", "#ff7f6e", "#b8f06a", "#ff6fcf", "#ffa24c", "#6ff0c4", "#7aa2ff"];
const lc = (a) => String(a || "").toLowerCase();
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function clusterCss() {
  if (document.querySelector("link[data-cm-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/clusters.css", "data-cm-css": "1" }));
}
const pc = (x) => (x == null ? "–" : `${x > 0 && x < 0.01 ? "<0.01" : x < 10 ? x.toFixed(2) : x.toFixed(1)}%`);
const money = (v) => (v == null ? "not read" : v === 0 ? "$0" : v < 0.01 ? "<$0.01" : v >= 1000 ? `$${cpt(v, 2)}` : `$${v.toFixed(2)}`);
const coins = (v) => (v == null ? "not read" : v === 0 ? "0" : v < 1 ? v.toPrecision(3) : cpt(v, 2));
const safeUrl = (u) => (/^https:\/\/robinhoodchain\.blockscout\.com\//.test(u || "") ? u : null);
const palVar = (i) => (i >= 0 ? `var(--cm-p${(i % PALETTE_SIZE) + 1})` : "transparent");
// h() with a cluster colour: --c is a custom property, which Object.assign(el.style) skips
const hc = (tag, { c = -1, ...attrs }, ...kids) => { const el = h(tag, attrs, ...kids); el.style.setProperty("--c", palVar(c)); return el; };
const addrWord = (n) => `${n} address${n === 1 ? "" : "es"}`;
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(142,223,245,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function evidenceEl(e) {
  if (!e) return null;
  const url = safeUrl(e.url);
  const ref = e.type === "block" ? `#${Number(e.ref).toLocaleString("en-US")}` : short(e.ref, 6);
  return h("span", { class: "cm-ev" }, h("span", { class: "cm-ev-t" }, EVTYPE[e.type] || e.type),
    url ? h("a", { class: "link mono", href: url, target: "_blank", rel: "noopener", title: e.ref }, ref, h("span", { class: "cm-ev-out" }, " on Blockscout")) : h("span", { class: "mono" }, ref));
}
const copyBtn = (text, what = "Address") => h("button", { class: "cm-ib", type: "button", "aria-label": `Copy ${what.toLowerCase()}`, title: `Copy ${what.toLowerCase()}`,
  onclick: (e) => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast("Could not copy", "error")); } }, icon("copy"));

/* ---------- the canvas: bubbles, lines, pan and zoom ---------- */
function canvasMap(stage, r, { hidden, compact, onPick, onHover }) {
  const cv = h("canvas", { class: "cm-cv", role: "img", "aria-label": `Bubble map of the ${r.holders.length} largest holders of ${r.symbol || "this coin"}. The address list has the same holders as buttons.` });
  const tip = h("div", { class: "cm-tip", hidden: true, "aria-hidden": "true" });
  stage.prepend(cv, tip);
  const ctx = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1, k = 1, tx = 0, ty = 0, fitted = false, raf = 0, anim = 0, vanim = 0;
  let g = null, by = new Map(), order = [], sel = null, hover = null, focusCl = null, data = r, colors = readColors();

  function readColors() {
    const cs = getComputedStyle(stage);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    return { pal: FALLBACK.map((f, i) => v(`--cm-p${i + 1}`, f)), wallet: v("--cm-wallet", "#7fb8c8"), deep: v("--cm-wallet-deep", "#0c171b"), edgeW: v("--cm-wallet-edge", "#8edff5"),
      contract: v("--cm-contract", "#7d868c"), line: v("--cm-line", "#9fc7d4"), dev: v("--cm-dev", "#c6f1fc"), sel: v("--cm-sel", "#ffffff"), text: v("--cm-text", "#eef7fa"), bg: v("--cm-bg", "#0a1016") };
  }
  function index() {
    const all = [...g.nodes, ...g.vias];
    by = new Map(all.map((n) => [n.id, n]));
    order = [...g.nodes].sort((a, b) => b.r - a.r);
  }
  function rebuild(animate) {
    const prev = g ? new Map([...g.nodes, ...g.vias].map((n) => [n.id, { x: n.x, y: n.y }])) : null;
    const next = layoutGraph(buildGraph(data, { hidden }), data.token || "", { prev });
    if (!animate || !prev || reduced()) { g = next; index(); paint(); return; }
    const from = new Map([...next.nodes, ...next.vias].map((n) => [n.id, prev.get(n.id) || null]));
    const to = new Map([...next.nodes, ...next.vias].map((n) => [n.id, { x: n.x, y: n.y }]));
    g = next; index();
    const t0 = performance.now(), D = 380;
    cancelAnimationFrame(anim);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / D), e = 1 - (1 - p) ** 3;
      for (const [id, n] of by) { const f = from.get(id), q = to.get(id); if (!q) continue; if (f) { n.x = f.x + (q.x - f.x) * e; n.y = f.y + (q.y - f.y) * e; n.fade = 1; } else n.fade = e; }
      draw();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  // the bubbles that stay lit while one is picked: itself, its cluster, what a line joins it to
  function related() {
    if (!sel && !focusCl) return null;
    const s = new Set();
    const cl = sel ? by.get(sel)?.cluster : focusCl;
    if (sel) s.add(sel);
    if (cl) for (const n of g.nodes) if (n.cluster === cl) s.add(n.id);
    if (sel) for (const e of g.edges) { if (e.a === sel) s.add(e.b); if (e.b === sel) s.add(e.a); }
    for (const v of g.vias) if (v.members.some((m) => s.has(m))) s.add(v.id);
    return s;
  }
  function paint() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function draw() {
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!g) return;
    const lit = related();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    const px = 1 / k;
    // lines and their arrowheads
    for (const e of g.edges) {
      const a = by.get(e.a), b = by.get(e.b);
      if (!a || !b) continue;
      const geo = arrowGeometry(a, b, e.dir, { head: 6 * px, gap: 2.5 * px });
      if (!geo) continue;
      const col = e.color >= 0 ? colors.pal[e.color % PALETTE_SIZE] : colors.line;
      const on = !lit || (lit.has(e.a) && lit.has(e.b));
      ctx.globalAlpha = (on ? (e.color >= 0 ? 0.9 : 0.55) : 0.1) * Math.min(a.fade ?? 1, b.fade ?? 1);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = (e.color >= 0 ? 1.3 : 1) * px;
      ctx.beginPath(); ctx.moveTo(geo.x1, geo.y1); ctx.lineTo(geo.x2, geo.y2); ctx.stroke();
      for (const t of geo.heads) { ctx.beginPath(); ctx.moveTo(t[0][0], t[0][1]); ctx.lineTo(t[1][0], t[1][1]); ctx.lineTo(t[2][0], t[2][1]); ctx.closePath(); ctx.fill(); }
    }
    // intermediates: small dashed dots
    ctx.setLineDash([2 * px, 2 * px]);
    for (const v of g.vias) {
      const on = !lit || lit.has(v.id);
      ctx.globalAlpha = (on ? 0.95 : 0.15) * (v.fade ?? 1);
      ctx.beginPath(); ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2);
      ctx.fillStyle = colors.bg; ctx.fill();
      ctx.strokeStyle = v.color >= 0 ? colors.pal[v.color % PALETTE_SIZE] : colors.line; ctx.lineWidth = 1.2 * px; ctx.stroke();
      if (hover === v.id) { ctx.setLineDash([]); ctx.strokeStyle = colors.sel; ctx.beginPath(); ctx.arc(v.x, v.y, v.r + 2.5 * px, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([2 * px, 2 * px]); }
    }
    ctx.setLineDash([]);
    // bubbles, the biggest first so the small ones stay on top
    for (const n of order) {
      const on = !lit || lit.has(n.id);
      const fade = n.fade ?? 1;
      ctx.globalAlpha = (on ? 1 : 0.28) * fade;
      const base = n.color >= 0 ? colors.pal[n.color % PALETTE_SIZE] : null;
      const gr = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.42, n.r * 0.05, n.x, n.y, n.r * 1.02);
      if (base) { gr.addColorStop(0, hexA(base, 0.55)); gr.addColorStop(0.55, hexA(base, 0.24)); gr.addColorStop(1, hexA(base, 0.12)); }
      else if (n.kind === "contract") { gr.addColorStop(0, hexA(colors.contract, 0.16)); gr.addColorStop(1, hexA(colors.contract, 0.05)); }
      else { gr.addColorStop(0, hexA(colors.wallet, 0.2)); gr.addColorStop(0.6, hexA(colors.wallet, 0.08)); gr.addColorStop(1, hexA(colors.deep, 0.5)); }
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = gr; ctx.fill();
      if (base && on) { ctx.shadowColor = hexA(base, 0.75); ctx.shadowBlur = 16; }
      if (n.kind === "contract") ctx.setLineDash([3 * px, 2.5 * px]);
      ctx.lineWidth = (base ? 1.8 : 1.2) * px;
      ctx.strokeStyle = base ? base : n.kind === "contract" ? hexA(colors.contract, 0.7) : hexA(colors.edgeW, 0.4);
      ctx.stroke();
      ctx.shadowBlur = 0; ctx.setLineDash([]);
      if (n.dev) {
        ctx.setLineDash([3.5 * px, 2.5 * px]); ctx.strokeStyle = colors.dev; ctx.lineWidth = 1.5 * px;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4.5 * px, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      if (sel === n.id || hover === n.id) {
        ctx.globalAlpha = sel === n.id ? 1 : 0.6;
        ctx.strokeStyle = colors.sel; ctx.lineWidth = (sel === n.id ? 2.6 : 1.6) * px;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (n.dev ? 8 : 2.5) * px, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // labels, in screen pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const n of g.nodes) {
      const R = n.r * k, sx = n.x * k + tx, sy = n.y * k + ty;
      if (sx < -R || sy < -R || sx > W + R || sy > H + R) continue;
      const on = !lit || lit.has(n.id);
      ctx.globalAlpha = (on ? 0.95 : 0.3) * (n.fade ?? 1);
      ctx.fillStyle = colors.text;
      if (R >= 16) {
        const fs = Math.max(9.5, Math.min(14, R * 0.34));
        ctx.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
        ctx.fillText(pc(n.pct), sx, sy - (R >= 30 && n.dev ? fs * 0.45 : 0));
        if (R >= 30 && n.dev) { ctx.font = `600 ${fs * 0.72}px system-ui, sans-serif`; ctx.fillText("DEV", sx, sy + fs * 0.75); }
      }
      if (n.dev && R < 30) { ctx.font = "700 9.5px system-ui, sans-serif"; ctx.fillStyle = colors.dev; ctx.fillText("DEV", sx, sy + R + 13); }
    }
    ctx.globalAlpha = 1;
  }

  /* view */
  const clampK = (v) => Math.max(0.12, Math.min(4, v));
  function topPad() { return compact ? 8 : W < 560 ? 64 : 70; }
  function fit(smooth) {
    if (!g || !W) return;
    const b = bounds(g), pad = compact ? 14 : 28, top = topPad();
    const bw = Math.max(40, b.x1 - b.x0), bh = Math.max(40, b.y1 - b.y0);
    const nk = clampK(Math.min((W - pad * 2) / bw, (H - pad * 2 - top) / bh, 2.8));
    const ntx = W / 2 - ((b.x0 + b.x1) / 2) * nk, nty = (H + top) / 2 - ((b.y0 + b.y1) / 2) * nk;
    moveTo(nk, ntx, nty, smooth);
    fitted = true;
  }
  function moveTo(nk, ntx, nty, smooth) {
    cancelAnimationFrame(vanim);
    if (!smooth || reduced()) { k = nk; tx = ntx; ty = nty; paint(); return; }
    const k0 = k, x0 = tx, y0 = ty, t0 = performance.now(), D = 320;
    const step = (t) => { const p = Math.min(1, (t - t0) / D), e = 1 - (1 - p) ** 3; k = k0 + (nk - k0) * e; tx = x0 + (ntx - x0) * e; ty = y0 + (nty - y0) * e; draw(); if (p < 1) vanim = requestAnimationFrame(step); };
    vanim = requestAnimationFrame(step);
  }
  function zoomAt(sx, sy, f) {
    const nk = clampK(k * f);
    tx = sx - ((sx - tx) * nk) / k; ty = sy - ((sy - ty) * nk) / k; k = nk;
    hideTip(); paint();
  }
  function centerOn(id) {
    const n = by.get(id);
    if (!n) return;
    const sx = n.x * k + tx, sy = n.y * k + ty, m = compact ? 20 : 60;
    // the card covers the left of a wide map and the lower part of a narrow one: bring the bubble to the open area
    const narrow = compact || W < 700;
    if (!narrow && sx > m + 340 && sx < W - m && sy > m + topPad() && sy < H - m) return;
    const gx = narrow ? W / 2 : W / 2 + 160, gy = narrow ? Math.max(topPad() + 40, H * 0.26) : H / 2;
    moveTo(k, tx + (gx - sx), ty + (gy - sy), true);
  }

  /* input */
  const local = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  function hit(sx, sy) {
    if (!g) return null;
    const wx = (sx - tx) / k, wy = (sy - ty) / k, slop = 4 / k;
    for (let i = order.length - 1; i >= 0; i--) { const n = order[i]; if (Math.hypot(n.x - wx, n.y - wy) <= n.r + slop) return n; }
    for (const v of g.vias) if (Math.hypot(v.x - wx, v.y - wy) <= v.r + slop + 2 / k) return v;
    return null;
  }
  function showTip(n, sx, sy) {
    if (!n) return hideTip();
    const x = data.holders.find((q) => lc(q.address) === n.id);
    clear(tip, h("i", { class: "cm-tip-bar", style: { background: n.color >= 0 ? palVar(n.color) : "var(--cm-wallet-edge)" } }),
      n.via ? h("span", { class: "cm-tip-r" }, VIA[n.kind] || "Intermediate") : h("span", { class: "cm-tip-r" }, x?.rank ? `#${x.rank}` : x?.label === "dev" ? "dev" : ""),
      h("span", { class: "mono" }, n.via ? short(n.address, 4) : x?.name || short(n.address, 4)),
      n.via ? h("span", { class: "cm-tip-p" }, "not a top holder") : h("span", { class: "cm-tip-p" }, pc(n.pct)));
    tip.hidden = false;
    const tw = tip.offsetWidth || 180, th = tip.offsetHeight || 28;
    tip.style.left = `${Math.max(6, Math.min(W - tw - 6, sx + 14))}px`;
    tip.style.top = `${Math.max(6, Math.min(H - th - 6, sy - th - 10))}px`;
  }
  function hideTip() { tip.hidden = true; }
  const pts = new Map();
  let drag = null, pinch = null, moved = false;
  cv.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    try { cv.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 1) { drag = { x: p.x, y: p.y, tx, ty }; moved = false; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx, ty };
      drag = null; moved = true;
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, nk = clampK(pinch.k * (d / pinch.d));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      tx = cx - ((pinch.cx - pinch.tx) * nk) / pinch.k; ty = cy - ((pinch.cy - pinch.ty) * nk) / pinch.k; k = nk;
      hideTip(); paint(); return;
    }
    if (drag) {
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (!moved && Math.hypot(dx, dy) > 4) { moved = true; cv.classList.add("is-drag"); hideTip(); }
      if (moved) { tx = drag.tx + dx; ty = drag.ty + dy; paint(); }
      return;
    }
    if (e.pointerType !== "mouse") return;
    const n = hit(p.x, p.y), id = n?.id || null;
    cv.style.cursor = n ? "pointer" : "grab";
    if (id !== hover) { hover = id; paint(); onHover?.(n); }
    if (n) showTip(n, p.x, p.y); else hideTip();
  });
  const end = (e) => {
    const was = pts.has(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!was) return;
    if (drag && !moved && e.type === "pointerup") {
      const p = local(e), n = hit(p.x, p.y);
      onPick(n && !n.via ? n.id : null, n?.via ? n : null);
      if (n?.via) showTip(n, p.x, p.y);
    }
    if (!pts.size) { drag = null; cv.classList.remove("is-drag"); }
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pts.size) { hover = null; hideTip(); paint(); } });
  // the wheel zooms the full map; on the token page's card only with Ctrl or ⌘ held (the page keeps scrolling)
  cv.addEventListener("wheel", (e) => {
    if (compact && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0035));
  }, { passive: false });

  /* size: drawn once the stage has a size, kept centred when it changes */
  const ro = new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth), hh = Math.round(stage.clientHeight);
    if (!w || !hh || (w === W && hh === H)) return;
    const ow = W, oh = H;
    W = w; H = hh; dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    if (!fitted) fit(false); else { tx += (W - ow) / 2; ty += (H - oh) / 2; paint(); }
  });
  ro.observe(stage);
  const mo = new MutationObserver(() => { colors = readColors(); paint(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  rebuild(false);
  return {
    select(id, { center = false } = {}) { sel = id; if (id) focusCl = null; if (center && id) centerOn(id); paint(); },
    focusCluster(id) { focusCl = id; sel = null; paint(); },
    setHidden(set) { hidden = set; if (sel && hidden.has(sel)) sel = null; rebuild(true); },
    update(nr) { data = nr; rebuild(true); },
    zoom(f) { zoomAt(W / 2, H / 2, f); },
    fit: () => fit(true),
    destroy() { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(anim); cancelAnimationFrame(vanim); cancelAnimationFrame(raf); },
  };
}

/* ---------- one map: canvas, card, address list ---------- */
function renderMap(box, r0, { compact = false, address = "", onRefresh }) {
  let r = r0;
  let hidden = defaultHidden(r), sel = null, focusCl = null, query = "", ungroup = false;
  const open = new Set();
  const holderOf = (id) => r.holders.find((x) => lc(x.address) === id) || null;
  const clusterOf = (id) => r.clusters.find((c) => c.id === id) || null;

  const stage = h("div", { class: "cm-stage" });
  const detail = h("div", { class: "cm-detail", hidden: true, "aria-live": "polite" });
  const hud = compact ? null : h("div", { class: "cm-hud" });
  const zoom = h("div", { class: "cm-zoom" },
    h("button", { class: "cm-zb", type: "button", "aria-label": "Zoom in", onclick: () => map.zoom(1.3) }, icon("plus")),
    h("button", { class: "cm-zb", type: "button", "aria-label": "Zoom out", onclick: () => map.zoom(1 / 1.3) }, h("span", { class: "cm-minus", "aria-hidden": "true" })),
    h("button", { class: "cm-zb", type: "button", "aria-label": "Fit the whole map", title: "Fit the whole map", onclick: () => map.fit() }, icon("refresh")));
  const legend = h("div", { class: "cm-legend", "aria-hidden": "true" },
    h("span", {}, h("i", { class: "cm-k cm-k-link" }), compact ? "Linked" : "Linked, a colour per cluster"),
    h("span", {}, h("i", { class: "cm-k cm-k-w" }), compact ? "Wallet" : "No link found"),
    h("span", {}, h("i", { class: "cm-k cm-k-dev" }), "Dev"),
    compact ? null : h("span", {}, h("i", { class: "cm-k cm-k-via" }), "Joins them, off the map"),
    compact ? null : h("span", {}, h("i", { class: "cm-k cm-k-arrow" }), "Where coins or ETH went"));
  stage.append(...[hud, detail, zoom, compact ? null : legend].filter(Boolean));

  const map = canvasMap(stage, r, { hidden, compact, onPick: (id) => pick(id, { center: false, from: "map" }) });

  /* the card over the map */
  function paintDetail() {
    const x = sel ? holderOf(sel) : null;
    const c = !x && focusCl ? clusterOf(focusCl) : null;
    const card = x ? holderCard(x) : c ? clusterCard(c) : null;
    detail.hidden = !card;
    clear(detail, card);
  }
  const closeBtn = () => h("button", { class: "cm-ib cm-x", type: "button", "aria-label": "Close", onclick: (e) => { e.stopPropagation(); pick(null); } }, icon("close"));
  function flowSide(side, dir, f) {
    const s = f?.[side];
    if (!s) return null;
    const word = dir === "in" ? "IN" : "OUT";
    const head = h("summary", { class: `cm-flow-h cm-flow-${dir}` },
      h("span", { class: "cm-flow-ic", "aria-hidden": "true" }, icon("arrowUp")),
      h("b", {}, !s.addresses ? word : s.usd != null ? `${money(s.usd)} ${word}` : `${coins(s.amount)} ${word}`),
      h("span", { class: "cm-flow-n" }, s.addresses ? `${dir === "in" ? "from" : "to"} ${addrWord(s.addresses)}` : `none ${dir === "in" ? "from" : "to"} other wallets`),
      s.top?.length ? h("span", { class: "cm-flow-chev", "aria-hidden": "true" }) : null);
    if (!s.top?.length) return h("div", { class: "cm-flow is-empty" }, head);
    return h("details", { class: "cm-flow" }, head,
      h("ul", { class: "cm-flow-l" }, s.top.map((p) => h("li", {},
        h("span", { class: "cm-flow-who" }, p.rank ? h("button", { class: "link mono", type: "button", onclick: () => pick(lc(p.address), { center: true }) }, `#${p.rank}`) : null,
          h("a", { class: "link mono", href: `${EXPLORER}/address/${p.address}`, target: "_blank", rel: "noopener", title: p.address }, p.name || short(p.address, 4)),
          p.contract ? h("span", { class: "cm-tag" }, "contract") : null),
        h("span", { class: "cm-flow-v" }, `${coins(p.amount)}${p.usd != null ? ` · ${money(p.usd)}` : ""}${p.transfers > 1 ? ` · ${p.transfers}×` : ""}`),
        p.tx?.url && safeUrl(p.tx.url) ? h("a", { class: "link cm-flow-tx", href: p.tx.url, target: "_blank", rel: "noopener", title: "The largest transfer, on Blockscout" }, "tx") : null))),
      s.addresses > s.top.length ? h("p", { class: "fine" }, `and ${s.addresses - s.top.length} more`) : null);
  }
  function holderCard(x) {
    const c = x.cluster && !isContract(x) ? clusterOf(x.cluster) : null;
    const col = c ? colorIndex(c.id) : -1;
    const f = x.flow;
    const typeTxt = x.type === "eoa" ? "EOA" : x.type === "contract" ? "Contract" : "type not read";
    const tags = (x.tags || []).filter((t) => t !== x.name);
    return hc("div", { class: "cm-card", c: col },
      h("div", { class: "cm-card-h" },
        h("span", { class: "cm-rank" }, x.rank ? `#${x.rank}` : x.label === "dev" ? "dev" : ""),
        h("b", { class: x.name ? "" : "mono", title: x.address }, x.name || short(x.address, 4)),
        copyBtn(x.address),
        h("a", { class: "cm-ib", href: `${EXPLORER}/address/${x.address}`, target: "_blank", rel: "noopener", "aria-label": "Open on Blockscout", title: "Open on Blockscout" }, icon("ext")),
        closeBtn()),
      h("div", { class: "cm-stats" },
        h("div", {}, h("b", {}, pc(x.pct)), h("span", {}, "of supply")),
        h("div", {}, h("b", {}, coins(x.amount)), h("span", {}, "amount")),
        h("div", {}, h("b", {}, money(x.usd)), h("span", {}, "USD value"))),
      c ? h("button", { class: "cm-clrow", type: "button", onclick: () => { pick(null); focusCluster(c.id); } },
        h("i", { class: "cm-bar" }), h("span", {}, `Cluster ${c.id.slice(1)} supply: `, h("b", {}, pc(c.pct))), h("span", { class: "fine" }, `${c.count} wallets${c.dev ? " · dev side" : ""}`)) : null,
      isContract(x) ? h("p", { class: "fine cm-p" }, x.label === "burn" ? "Burned coins: nobody can move them." : "A contract holds coins for many people (a pool, a locker, staking), so it is never put in a cluster.") : null,
      f ? h("div", { class: "cm-flows" }, flowSide("in", "in", f), flowSide("out", "out", f),
        f.bought != null && (f.bought > 0 || f.sold > 0) ? h("p", { class: "fine cm-p" }, `Through pools: bought ${coins(f.bought)}${f.boughtUsd != null ? ` (${money(f.boughtUsd)})` : ""}, sold ${coins(f.sold)}${f.soldUsd != null ? ` (${money(f.soldUsd)})` : ""}`) : null,
        f.partial ? h("p", { class: "fine cm-p" }, "From the newest transfers of this busy coin, not its full history.") : null)
        : h("p", { class: "fine cm-p" }, `Coins in and out: not read${x.flowNote ? ` (${x.flowNote})` : ""}.`),
      h("div", { class: "cm-chips" },
        h("span", { class: "cm-chip" }, typeTxt),
        f?.transfers != null ? h("span", { class: "cm-chip" }, `${f.transfers.toLocaleString("en-US")} transfer${f.transfers === 1 ? "" : "s"}`) : null,
        tags.map((t) => h("span", { class: `cm-chip${t === "dev" || t === "dev side" ? " is-dev" : ""}` }, t))),
      x.why?.length ? h("details", { class: "cm-whyd", open: !compact }, h("summary", {}, `Why it is linked (${x.why.length})`),
        h("ul", { class: "cm-why" }, x.why.map((w) => h("li", {}, h("span", {}, w.text), h("span", { class: "cm-why-c" }, `confidence ${w.confidence}`), evidenceEl(w.evidence))))) : null);
  }
  function clusterCard(c) {
    return hc("div", { class: "cm-card", c: colorIndex(c.id) },
      h("div", { class: "cm-card-h" }, h("i", { class: "cm-dot" }), h("b", {}, `Cluster ${c.id.slice(1)}${c.dev ? " · dev side" : ""}`), closeBtn()),
      h("div", { class: "cm-stats" }, h("div", {}, h("b", {}, pc(c.pct)), h("span", {}, "of supply")), h("div", {}, h("b", {}, String(c.count)), h("span", {}, "wallets")), h("div", {}, h("b", {}, c.confidence), h("span", {}, "confidence"))),
      h("p", { class: "fine cm-p" }, c.reasons.join(", ")), evidenceEl(c.evidence));
  }

  /* the address list */
  const search = h("input", { class: "input cm-search", type: "search", placeholder: "Search an address, #rank or name", "aria-label": "Search the address list", spellcheck: "false", autocomplete: "off" });
  const ungroupBtn = h("button", { class: "cm-ungroup", type: "button", "aria-pressed": "false", onclick: () => { ungroup = !ungroup; ungroupBtn.setAttribute("aria-pressed", String(ungroup)); ungroupBtn.textContent = ungroup ? "Group clusters" : "Ungroup clusters"; paintList(); } }, "Ungroup clusters");
  const rows = h("ul", { class: "cm-rows", role: "list" });
  const side = compact ? null : h("aside", { class: "cm-side", "aria-label": "Address list" },
    h("div", { class: "cm-side-h" }, h("b", {}, "Address list"), ungroupBtn), search, rows);
  search.addEventListener("input", () => { query = search.value; paintList(); });
  const eyeBtn = (ids, isHidden, what) => h("button", { class: `cm-eye${isHidden ? " is-off" : ""}`, type: "button", "aria-pressed": String(!isHidden), "aria-label": `${isHidden ? "Show" : "Hide"} ${what} on the map`, title: isHidden ? "Show on the map" : "Hide from the map",
    onclick: (e) => { e.stopPropagation(); const next = new Set(hidden); for (const id of ids) isHidden ? next.delete(id) : next.add(id); hidden = next; map.setHidden(hidden); if (sel && hidden.has(sel)) pick(null); paintList(); } }, icon("eye"));
  function paintList() {
    if (!side) return;
    const list = listRows(r, { query, ungroup, hidden, open });
    clear(rows, list.length ? list.map((x) => {
      if (x.type === "cluster") return hc("li", { class: `cm-row cm-crow${focusCl === x.id ? " is-sel" : ""}${x.hidden ? " is-hidden" : ""}`, c: x.color },
        eyeBtn(x.members, x.hidden, `cluster ${x.id.slice(1)}`),
        h("button", { class: "cm-rowb", type: "button", "aria-expanded": String(x.open), onclick: () => { x.open ? open.delete(x.id) : open.add(x.id); focusCluster(x.open ? null : x.id); } },
          h("span", { class: "cm-cpill" }, h("i", { class: "cm-dot" }), `Cluster ${x.id.slice(1)}`, h("span", { class: `cm-chev${x.open ? " is-open" : ""}`, "aria-hidden": "true" })),
          h("span", { class: "cm-cnt" }, `(${x.count})${x.dev ? " dev side" : ""}`), h("span", { class: "cm-pct cm-pct-c" }, pc(x.pct))));
      return hc("li", { class: `cm-row${x.contract ? " is-contract" : ""}${x.hidden ? " is-hidden" : ""}${sel === x.id ? " is-sel" : ""}${x.member ? " is-member" : ""}`, c: x.color, "data-id": x.id },
        eyeBtn([x.id], x.hidden, x.name || short(x.address)),
        h("button", { class: "cm-rowb", type: "button", onclick: () => pick(x.id, { center: true, from: "list" }) },
          h("span", { class: "cm-rk" }, x.rank ? `#${x.rank}` : x.dev ? "dev" : ""),
          h("span", { class: `cm-ad${x.name ? "" : " mono"}`, title: x.address }, x.name || short(x.address, 4), x.dev ? h("span", { class: "cm-tag is-dev" }, "dev") : null),
          h("span", { class: "cm-pct" }, pc(x.pct))));
    }) : [h("li", { class: "cm-none fine" }, "Nothing matches.")]);
  }

  /* picking */
  function pick(id, { center = false, from = "" } = {}) {
    sel = id && holderOf(id) ? id : null;
    if (sel) focusCl = null;
    if (sel && hidden.has(sel)) { const next = new Set(hidden); next.delete(sel); hidden = next; map.setHidden(hidden); }
    map.select(sel, { center });
    paintDetail(); paintList();
    if (from === "list") showTab(false);
    if (sel && from === "map") rows.querySelector(`[data-id="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function focusCluster(id) { focusCl = id; sel = null; map.focusCluster(id); paintDetail(); paintList(); }
  const onKey = (e) => { if (e.key === "Escape" && (sel || focusCl)) { pick(null); focusCluster(null); } };
  box.addEventListener("keydown", onKey);

  /* the header over the map */
  let agoTimer = 0;
  function paintHud() {
    if (!hud) return;
    const logo = h("img", { class: "cm-logo", src: `/api/icon/token/${r.token}?v=4`, alt: "", width: 30, height: 30, loading: "lazy" });
    const letters = h("span", { class: "cm-logo-l", "aria-hidden": "true" }, String(r.symbol || "?").slice(0, 2).toUpperCase());
    logo.addEventListener("error", () => logo.remove());
    logo.addEventListener("load", () => letters.remove());
    const when = h("span", { class: "cm-ago" }, r.partial ? "reading…" : `${ago(r.checkedAt)} ago`);
    const refresh = h("button", { class: "cm-ib", type: "button", "aria-label": "Read the holders again", title: "Read again (at most once a minute)", onclick: () => { refresh.disabled = true; when.textContent = "reading…"; onRefresh?.(); } }, icon("refresh"));
    clear(hud, h("div", { class: "cm-tok" }, h("span", { class: "cm-logo-w" }, letters, logo),
      h("span", { class: "cm-tok-t" }, h("b", {}, r.symbol ? `$${r.symbol}` : short(r.token)), h("span", { class: "fine" }, `${r.holders.length} largest holders`))),
      h("div", { class: "cm-when" }, h("i", { class: `cm-live${r.partial ? " is-reading" : ""}`, "aria-hidden": "true" }), when, refresh));
    clearInterval(agoTimer);
    agoTimer = setInterval(() => { if (!r.partial) when.textContent = `${ago(r.checkedAt)} ago`; }, 30_000);
  }

  /* the page around it */
  const tabMap = h("button", { class: "cm-tab", type: "button", "aria-pressed": "true", onclick: () => showTab(false) }, "Map");
  const tabList = h("button", { class: "cm-tab", type: "button", "aria-pressed": "false", onclick: () => showTab(true) }, "Address list");
  function showTab(list) { board?.classList.toggle("show-list", list); tabList.setAttribute("aria-pressed", String(list)); tabMap.setAttribute("aria-pressed", String(!list)); }
  const board = compact ? null : h("div", { class: "cm-board" }, stage, side);
  const proof = h("div", { class: "cm-proof" });
  function paintProof() {
    if (compact) return;
    clear(proof,
      r.clusters.length ? h("div", {}, h("h3", { class: "cm-h3" }, "Clusters and their proof"),
        h("ol", { class: "cm-list" }, r.clusters.map((c) => hc("li", { class: "cm-cl", c: colorIndex(c.id) },
          h("button", { class: "cm-cl-h", type: "button", onclick: () => { focusCluster(focusCl === c.id ? null : c.id); stage.scrollIntoView({ block: "nearest", behavior: "smooth" }); } },
            h("i", { class: "cm-dot" }), h("b", {}, `Cluster ${c.id.slice(1)}${c.dev ? " · dev side" : ""}`), h("span", {}, `${c.count} wallets · ${pc(c.pct)}`), h("span", { class: `cm-conf conf-${c.confidence}` }, `confidence ${c.confidence}`)),
          h("p", { class: "fine" }, c.reasons.join(", ")),
          evidenceEl(c.evidence))))) : null,
      r.notes?.length ? h("ul", { class: "cm-notes fine" }, r.notes.map((n) => h("li", {}, n))) : null,
      h("details", { class: "cm-cov" }, h("summary", {}, `What was read (${r.coverage.filter((c) => c.status === "done").length} of ${r.coverage.length} sources) · ${r.holdersSource || "Blockscout"} holders · ${ago(r.checkedAt)} ago`),
        h("ul", {}, r.coverage.map((c) => h("li", { class: `c-${String(c.status).replace("/", "")}` }, h("b", {}, c.source), h("span", {}, STATUS[c.status] || c.status), c.note ? h("small", {}, c.note) : null)))),
      h("p", { class: "note cm-note" }, r.note));
  }
  const sum = h("p", { class: compact ? "cm-sum cm-sum-c" : "cm-sum" }, r.summary);
  if (compact) {
    const nc = r.clusters.length;
    clear(box, sum, h("div", { class: "cm-cbox" }, stage),
      h("div", { class: "cm-foot" }, legend, h("a", { class: "link fine cm-more", href: `#/clusters/${address}` }, nc ? `${nc} cluster${nc > 1 ? "s" : ""}, every holder and the proof` : "Every holder, flows and the proof", " →")));
  } else clear(box, sum, h("div", { class: "cm-tabs", role: "group", "aria-label": "Show" }, tabMap, tabList), board, proof);
  paintHud(); paintList(); paintProof();

  return {
    update(nr) {
      r = nr;
      const keep = new Set([...hidden].filter((id) => r.holders.some((x) => lc(x.address) === id)));
      for (const id of defaultHidden(r)) keep.add(id);
      hidden = keep;
      if (sel && !holderOf(sel)) sel = null;
      if (focusCl && !clusterOf(focusCl)) focusCl = null;
      sum.textContent = r.summary;
      map.setHidden(hidden); map.update(r);
      paintHud(); paintList(); paintProof(); paintDetail();
    },
    stop() { clearInterval(agoTimer); map.destroy(); box.removeEventListener("keydown", onKey); },
  };
}

/** The Cluster map section for one coin. lazy: start reading when it scrolls near the screen. inset: no panel frame
 *  (inside the Gate result). link: a link to the full page. compact: the token page's card. */
export function clusterSection(address, { lazy = true, inset = false, link = true, standalone = false, compact = false } = {}) {
  clusterCss();
  const body = h("div", { class: "cm-out", "aria-live": "polite" }, h("div", { class: "cm-wait" }, h("span", { class: "cm-spin" }), h("span", {}, compact ? "Reading the largest holders and who is linked…" : "Reading the largest holders, their funders, the dev side and the launch…")));
  const el = h("section", { class: `cm ${compact ? "cm-compact" : inset ? "cm-inset" : "panel"}${standalone ? " cm-standalone" : ""}` },
    h("div", { class: "panel-h cm-h" }, h("h2", {}, "Cluster map"), h("span", { class: "fine cm-sub" }, compact ? "the 50 largest holders" : "who holds it, and which wallets are linked"),
      link ? h("a", { class: "link fine", href: `#/clusters/${address}` }, "Full map") : null),
    body);
  let tries = 0, view = null, timer = 0, started = false;
  const load = async (fresh = false) => {
    if (tries > 0 && !el.isConnected) return;
    tries++;
    let r;
    try { r = await api.get(`/api/clusters/${address}${fresh ? "?fresh=1" : ""}`); }
    catch (e) {
      if (!el.isConnected) return;
      if (view) { toast("The Cluster map could not be read again right now.", "error"); view.update(view.r); return; }
      clear(body, h("div", { class: "cm-empty" }, h("b", {}, "The Cluster map could not be read right now."), h("p", { class: "fine" }, e.message), h("button", { class: "btn sm", type: "button", onclick: () => { tries = 0; load(); } }, icon("refresh"), "Try again")));
      return;
    }
    if (!el.isConnected && tries > 1) return;
    if (!r.holders?.length) { view?.stop(); view = null; clear(body, h("div", { class: "cm-empty" }, h("b", {}, r.summary || "No holders to draw yet."), h("p", { class: "fine" }, r.note || ""))); }
    else if (view) { view.r = r; view.update(r); }
    else { view = renderMap(body, r, { compact, address, onRefresh: () => { clearTimeout(timer); load(true); } }); view.r = r; }
    clearTimeout(timer);
    if (r.partial && tries < 8) timer = setTimeout(() => load(), 12_000);
  };
  const start = () => { if (started) return; started = true; load(); };
  if (lazy && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "400px" });
    requestAnimationFrame(() => io.observe(el));
  } else setTimeout(start, 30);
  el.stop = () => { clearTimeout(timer); view?.stop(); };
  return el;
}

/* ---------- the page: #/clusters and #/clusters/<token> ---------- */
export async function mount(view, ctx) {
  clusterCss();
  const input = h("input", { class: "input cm-in", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "80", placeholder: "Paste a coin's contract address, or its ticker", "aria-label": "Coin address or ticker" });
  const box = coinSuggest(input, (c) => { input.value = c.address; run(c.address); }, { majors: false });
  const go = h("button", { class: "btn primary", type: "button" }, icon("search"), "Draw the map");
  const out = h("div", { class: "cm-page-out" });
  let cur = null;
  async function run(raw) {
    const text = String(raw || "").trim();
    let a = ADDR.exec(text)?.[0];
    if (!a && text) { const c = await findCoin(text).catch(() => null); if (c?.address && ADDR.test(c.address)) a = c.address; }
    if (!a) { toast("Paste a Robinhood Chain coin address (0x…), or a coin's ticker.", "error"); input.focus(); return; }
    input.value = a;
    if (location.hash !== `#/clusters/${a}`) history.replaceState(null, "", `#/clusters/${a}`);
    cur?.stop?.();
    cur = clusterSection(a, { lazy: false, link: false, standalone: true });
    clear(out, cur, h("div", { class: "dk-gate-a cm-actions" },
      h("a", { class: "btn sm", href: `#/token/${a}` }, "Token page"),
      h("a", { class: "btn sm", href: `#/gate/${a}` }, icon("shield"), "Run the Gate"),
      h("a", { class: "btn sm", href: `/check/${a}` }, "Troya Check"),
      h("a", { class: "btn sm", href: `#/heel/${a}` }, "Find its weak spot"),
      ctx.ask ? h("button", { class: "btn sm", type: "button", onclick: () => ctx.ask(`Explain the Cluster map of ${a} in plain words: which holders are linked, how sure is it, and what it means for me.`) }, icon("spark"), "Ask Troya") : null));
  }
  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  input.addEventListener("paste", () => setTimeout(() => { if (ADDR.test(input.value)) run(input.value); }, 0));
  clear(view, h("div", { class: "dk cm-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Cluster map"),
      h("h1", {}, h("em", {}, "Who holds it,"), " and who is linked."),
      h("p", { class: "dk-sub" }, "The 50 largest holders of a coin as bubbles. Wallets that shared a funder, moved coins between them, bought in one transaction or are tied to the dev share a colour and a line, with an arrow where the coins or ETH went. Click a bubble for its amount, its value and every wallet it traded coins with. Pools, lockers and staking start hidden: they are not people.")),
    h("section", { class: "panel cm-form-p" }, h("div", { class: "cm-form" }, box, go),
      h("p", { class: "fine cm-try" }, "Try: ", SAMPLES.map(([t, x]) => h("button", { class: "link", type: "button", onclick: () => run(x) }, t)))),
    out));
  const start = ctx.parts?.[0] || ctx.query?.address || "";
  if (ADDR.test(start)) run(start); else setTimeout(() => input.focus(), 30);
  return () => cur?.stop?.();
}
