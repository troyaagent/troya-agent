// Cluster map, the parts without a screen (27 Nov 2026, the Bubblemaps-style map): which bubbles and lines are drawn, where
// they sit and in which colour, and the rows of the address list. No DOM here, so tools/clustermap-test.mjs runs it in Node.
// clusters.js draws what this returns on a canvas.
//   buildGraph(r, { hidden })         the bubbles (holders not hidden), the lines between them and the intermediates
//   layoutGraph(g, seed, { prev })    a deterministic relaxation: the same coin gives the same picture on every load
//   arrowGeometry(a, b, dir)          a line trimmed to both circle edges, with its arrowheads
//   listRows(r, { query, ungroup, hidden, open })   the address list: contracts first, then the clusters, then the wallets
export const CONTRACT = new Set(["pool", "locker", "staking", "burn", "contract"]);
export const PALETTE_SIZE = 8;
export const R_MIN = 5, R_MAX = 46, R_K = 13, R_VIA = 4;

/** FNV-1a: a coin address → a 32-bit seed. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (const c of String(str || "").toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** mulberry32: a small seeded generator (never Math.random, so a layout repeats exactly). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Bubble area follows the share of the supply, between a smallest and a largest radius. */
export function radiusOf(pct) {
  const p = Math.max(0, Number(pct) || 0);
  return Math.max(R_MIN, Math.min(R_MAX, R_K * Math.sqrt(p)));
}
/** Cluster c1 takes colour 0, c2 colour 1 … (wrapping past the palette); no cluster: -1. */
export function colorIndex(id) {
  const n = Number(String(id || "").replace(/^c/, ""));
  return id && n > 0 ? (n - 1) % PALETTE_SIZE : -1;
}
const lc = (a) => String(a || "").toLowerCase();
export const isContract = (x) => CONTRACT.has(x?.label);
/** Contracts are hidden at first (pools, lockers, staking, burn are not people). */
export function defaultHidden(r) { return new Set((r?.holders || []).filter(isContract).map((x) => lc(x.address))); }

/** What the canvas draws: nodes (bubbles), vias (intermediates), edges (lines with a direction). */
export function buildGraph(r, { hidden = defaultHidden(r) } = {}) {
  const nodes = [], by = new Map();
  for (const x of r?.holders || []) {
    const id = lc(x.address);
    if (hidden.has(id) || by.has(id)) continue;
    const contract = isContract(x);
    // a contract never joins a cluster, whatever the data says
    const cluster = contract ? null : x.cluster || null;
    const n = { id, address: x.address, pct: Number(x.pct) || 0, r: radiusOf(x.pct), rank: x.rank ?? null, cluster, color: colorIndex(cluster),
      kind: contract ? "contract" : cluster ? "linked" : "wallet", dev: x.label === "dev", extra: !!x.extra, label: x.label, name: x.name || null, x: 0, y: 0 };
    nodes.push(n); by.set(id, n);
  }
  // lines: one per pair, the directions merged (a → b and b → a is "both"); a link through an intermediate is drawn through it
  const pairs = new Map();
  const addEdge = (a, b, dir, kind, color) => {
    if (!a || !b || a === b) return;
    const [p, q, d] = a < b ? [a, b, dir] : [b, a, dir === "ab" ? "ba" : dir === "ba" ? "ab" : dir];
    const k = `${p}|${q}`;
    const e = pairs.get(k);
    if (!e) { pairs.set(k, { a: p, b: q, dir: d, kinds: [kind], color }); return; }
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    if (d && d !== e.dir) e.dir = !e.dir ? d : "both";
    if (e.color < 0 && color >= 0) e.color = color;
  };
  for (const l of r?.links || []) {
    if (l.via) continue;
    const a = lc(l.from), b = lc(l.to);
    if (!by.has(a) || !by.has(b)) continue;
    addEdge(a, b, l.dir === "forward" ? "ab" : l.dir === "both" ? "both" : null, l.kind, by.get(a).color >= 0 ? by.get(a).color : by.get(b).color);
  }
  const vias = [];
  for (const v of r?.intermediates || []) {
    const id = lc(v.address);
    if (by.has(id)) continue;
    const es = (v.edges || []).filter((e) => by.has(lc(e.wallet)));
    if (es.length < 2) continue;   // an intermediate is drawn only while it joins two bubbles on the canvas
    const color = es.map((e) => by.get(lc(e.wallet)).color).find((c) => c >= 0) ?? -1;
    const node = { id, address: v.address, kind: v.kind, why: v.why || "", r: R_VIA, color, via: true, members: es.map((e) => lc(e.wallet)), x: 0, y: 0 };
    vias.push(node);
    for (const e of es) addEdge(id, lc(e.wallet), e.dir === "out" ? "ab" : e.dir === "in" ? "ba" : null, v.kind, color);
  }
  return { nodes, vias, edges: [...pairs.values()] };
}

/** Where every bubble sits, in world units (about a pixel at zoom 1). Deterministic: the seed (the coin's address), the input
 *  order and fixed iteration counts decide everything. prev: positions to start from (a bubble shown or hidden again moves
 *  the others a little instead of reshuffling the map). */
export function layoutGraph(g, seed, { prev = null, iterations = 360 } = {}) {
  const R = rng(hashSeed(seed));
  const all = [...g.nodes, ...g.vias];
  const by = new Map(all.map((n) => [n.id, n]));
  // units on a golden-angle spiral: a cluster is one unit (its members around it), a lone wallet is one unit, biggest first
  const units = [], inUnit = new Set();
  const clusters = new Map();
  for (const n of g.nodes) if (n.cluster) { if (!clusters.has(n.cluster)) clusters.set(n.cluster, []); clusters.get(n.cluster).push(n); }
  for (const [, ms] of clusters) { units.push({ ms, w: ms.reduce((s, m) => s + m.r * m.r, 0) }); ms.forEach((m) => inUnit.add(m.id)); }
  for (const n of g.nodes) if (!inUnit.has(n.id)) units.push({ ms: [n], w: n.r * n.r });
  units.sort((a, b) => b.w - a.w || (a.ms[0].rank ?? 1e9) - (b.ms[0].rank ?? 1e9) || (a.ms[0].id < b.ms[0].id ? -1 : 1));
  const GA = Math.PI * (3 - Math.sqrt(5));
  const meanR = g.nodes.length ? g.nodes.reduce((s, n) => s + n.r, 0) / g.nodes.length : 10;
  const step = meanR * 2.6 + 16;
  const fresh = [];
  units.forEach((u, i) => {
    const a = i * GA + (R() - 0.5) * 0.5, rr = step * Math.sqrt(i + 0.35) * (0.92 + R() * 0.16);
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    u.ms.forEach((m, j) => {
      const p = prev?.get(m.id);
      if (p) { m.x = p.x; m.y = p.y; return; }
      const b = (j / Math.max(1, u.ms.length)) * Math.PI * 2 + R() * 0.4, d = u.ms.length > 1 ? m.r + 14 : 0;
      m.x = cx + Math.cos(b) * d; m.y = cy + Math.sin(b) * d;
      fresh.push(m);
    });
  });
  for (const v of g.vias) {
    const p = prev?.get(v.id);
    if (p) { v.x = p.x; v.y = p.y; continue; }
    const ms = v.members.map((id) => by.get(id)).filter(Boolean);
    v.x = ms.reduce((s, m) => s + m.x, 0) / ms.length + (R() - 0.5) * 8;
    v.y = ms.reduce((s, m) => s + m.y, 0) / ms.length + (R() - 0.5) * 8;
  }
  const E = g.edges.map((e) => [by.get(e.a), by.get(e.b)]).filter(([a, b]) => a && b);
  const warm = prev && fresh.length < all.length;
  const its = warm ? Math.round(iterations * 0.45) : iterations;
  const pad = (a, b) => (a.via || b.via ? 8 : a.cluster && a.cluster === b.cluster ? 12 : 12 + 0.35 * (a.r + b.r));
  for (let it = 0; it < its; it++) {
    const alpha = (warm ? 0.5 : 1) * (1 - it / its);
    // gravity keeps the cloud round and together
    for (const n of all) { n.x -= n.x * 0.012 * alpha; n.y -= n.y * 0.012 * alpha; }
    // lines pull their ends to a short distance
    for (const [a, b] of E) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      const want = a.r + b.r + (a.via || b.via ? 16 : 20);
      const f = ((d - want) / d) * 0.08 * (0.3 + alpha);
      const wa = b.r * b.r / (a.r * a.r + b.r * b.r), wb = 1 - wa;
      a.x += dx * f * wa; a.y += dy * f * wa; b.x -= dx * f * wb; b.y -= dy * f * wb;
    }
    // no two bubbles closer than their radii and a gap (a small bubble moves more than a big one)
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const min = a.r + b.r + pad(a, b);
      if (d >= min) continue;
      if (d < 0.01) { const t = (i * 7 + j * 13) % 360 * Math.PI / 180; dx = Math.cos(t) * 0.01; dy = Math.sin(t) * 0.01; d = 0.01; }
      const p = (min - d) / d, wa = b.r * b.r / (a.r * a.r + b.r * b.r), wb = 1 - wa;
      a.x -= dx * p * wa; a.y -= dy * p * wa; b.x += dx * p * wb; b.y += dy * p * wb;
    }
  }
  // the last passes only separate (springs could leave a pair a little too close)
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r + pad(a, b) * 0.6;
      if (d >= min) continue;
      moved = true;
      const p = (min - d) / d / 2;
      a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p;
    }
    if (!moved) break;
  }
  for (const n of all) { n.x = Math.round(n.x * 100) / 100; n.y = Math.round(n.y * 100) / 100; }
  return g;
}

/** The box around what is drawn (for fitting the view). */
export function bounds(g) {
  const all = [...g.nodes, ...g.vias];
  if (!all.length) return { x0: -50, y0: -50, x1: 50, y1: 50 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of all) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  return { x0, y0, x1, y1 };
}

/** A line from circle a to circle b, trimmed at both edges, with arrowheads where the coins or ETH went.
 *  dir: "ab" (a → b), "ba", "both" or null. Returns null when the circles touch. */
export function arrowGeometry(a, b, dir, { head = 5, gap = 2 } = {}) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (d <= a.r + b.r + gap * 2) return null;
  const ux = dx / d, uy = dy / d;
  const x1 = a.x + ux * (a.r + gap), y1 = a.y + uy * (a.r + gap), x2 = b.x - ux * (b.r + gap), y2 = b.y - uy * (b.r + gap);
  const tip = (x, y, sx, sy) => [[x, y], [x - sx * head - sy * head * 0.55, y - sy * head + sx * head * 0.55], [x - sx * head + sy * head * 0.55, y - sy * head - sx * head * 0.55]];
  const heads = [];
  if (dir === "ab" || dir === "both") heads.push(tip(x2, y2, ux, uy));
  if (dir === "ba" || dir === "both") heads.push(tip(x1, y1, -ux, -uy));
  return { x1, y1, x2, y2, heads };
}

/** The rows of the address list. hidden: addresses off the canvas; open: cluster ids unfolded; query: search text. */
export function listRows(r, { query = "", ungroup = false, hidden = defaultHidden(r), open = new Set() } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const holders = (r?.holders || []).slice().sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const match = (x) => !q || lc(x.address).includes(q.replace(/^#/, "x")) || lc(x.address).includes(q) || lc(x.name).includes(q) || (q.startsWith("#") && String(x.rank) === q.slice(1)) || (/^\d+$/.test(q) && String(x.rank) === q);
  const row = (x, extra = {}) => ({ type: "holder", id: lc(x.address), address: x.address, rank: x.rank ?? null, pct: Number(x.pct) || 0, name: x.name || null, label: x.label,
    contract: isContract(x), dev: x.label === "dev", cluster: isContract(x) ? null : x.cluster || null, color: isContract(x) ? -1 : colorIndex(x.cluster), hidden: hidden.has(lc(x.address)), ...extra });
  const contracts = holders.filter(isContract).filter(match).map((x) => row(x));
  if (ungroup || q) return [...contracts, ...holders.filter((x) => !isContract(x)).filter(match).map((x) => row(x))];
  const out = [...contracts];
  const done = new Set();
  for (const c of r?.clusters || []) {
    const ms = c.wallets.map((w) => holders.find((x) => lc(x.address) === lc(w))).filter((x) => x && !isContract(x));
    if (!ms.length) continue;
    ms.forEach((x) => done.add(lc(x.address)));
    const isOpen = open.has(c.id);
    out.push({ type: "cluster", id: c.id, count: ms.length, pct: Number(c.pct) || 0, color: colorIndex(c.id), dev: !!c.dev, open: isOpen, hidden: ms.every((x) => hidden.has(lc(x.address))), members: ms.map((x) => lc(x.address)) });
    if (isOpen) for (const x of ms) out.push(row(x, { member: c.id }));
  }
  for (const x of holders) if (!isContract(x) && !done.has(lc(x.address))) out.push(row(x));
  return out;
}
