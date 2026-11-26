// Tests for the Cluster map's placement, colours, lines and address list (public/agent/desk/cluster-layout.js, no DOM).
// node tools/clustermap-test.mjs
import { buildGraph, layoutGraph, bounds, arrowGeometry, listRows, defaultHidden, colorIndex, radiusOf, hashSeed, R_MIN, R_MAX, PALETTE_SIZE } from "../public/agent/desk/cluster-layout.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };
const A = (i) => "0x" + i.toString(16).padStart(40, "0");
const TOKEN = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

// a coin: a pool and a burn address (contracts), the dev, two clusters, loose wallets
function coin() {
  const holders = [
    { address: A(1), pct: 22, label: "pool", name: "Uniswap: PoolManager", rank: 1, cluster: null },
    { address: A(2), pct: 8, label: "burn", name: "Troya burn (dead address)", rank: 2, cluster: "c1" },   // a contract never joins a cluster
    { address: A(3), pct: 3.1, label: "dev", rank: 3, cluster: "c1" },
    { address: A(4), pct: 2.4, label: "wallet", rank: 4, cluster: "c1" },
    { address: A(5), pct: 1.9, label: "wallet", rank: 5, cluster: "c2" },
    { address: A(6), pct: 1.2, label: "wallet", rank: 6, cluster: "c2" },
    { address: A(7), pct: 0.9, label: "wallet", rank: 7, cluster: "c2" },
  ];
  for (let i = 8; i <= 40; i++) holders.push({ address: A(i), pct: Math.max(0.05, 3 / i), label: "wallet", rank: i, cluster: null });
  return {
    token: TOKEN,
    holders,
    clusters: [
      { id: "c1", wallets: [A(3), A(4)], count: 2, pct: 5.5, dev: true, reasons: ["dev side"], confidence: "high" },
      { id: "c2", wallets: [A(5), A(6), A(7)], count: 3, pct: 4, dev: false, reasons: ["shared funder"], confidence: "medium" },
    ],
    links: [
      { from: A(3), to: A(4), kind: "dev", dir: "forward" },
      { from: A(4), to: A(3), kind: "transfer", dir: "forward" },        // the other way: the pair becomes "both"
      { from: A(5), to: A(6), kind: "funder", dir: null, via: A(999) },   // drawn through the intermediate, not directly
    ],
    intermediates: [
      { address: A(999), kind: "funder", wallets: [A(5), A(6), A(7)], edges: [{ wallet: A(5), dir: "out" }, { wallet: A(6), dir: "out" }, { wallet: A(7), dir: "out" }] },
      { address: A(998), kind: "sender", wallets: [A(8), A(1)], edges: [{ wallet: A(8), dir: "out" }, { wallet: A(1), dir: "out" }] },   // one end is a hidden contract
    ],
  };
}
const lc = (a) => a.toLowerCase();

/* colours */
ok(colorIndex("c1") === 0 && colorIndex("c2") === 1, "cluster c1 → colour 0, c2 → colour 1");
ok(colorIndex(`c${PALETTE_SIZE + 1}`) === 0, "colours wrap past the palette");
ok(colorIndex(null) === -1 && colorIndex("") === -1, "no cluster → no colour");

/* sizes */
ok(radiusOf(0) === R_MIN && radiusOf(100) === R_MAX, "radius between the smallest and the largest");
ok(radiusOf(4) > radiusOf(1), "a bigger share is a bigger bubble");

/* contracts: hidden by default, never in a cluster */
const r = coin();
const hid = defaultHidden(r);
ok(hid.has(lc(A(1))) && hid.has(lc(A(2))) && hid.size === 2, "pool and burn start hidden");
let g = buildGraph(r);
ok(!g.nodes.some((n) => n.id === lc(A(1)) || n.id === lc(A(2))), "hidden contracts are not drawn");
const shown = buildGraph(r, { hidden: new Set() });
const burn = shown.nodes.find((n) => n.id === lc(A(2)));
ok(burn && burn.cluster === null && burn.color === -1 && burn.kind === "contract", "a shown contract has no cluster and no colour");

/* lines and intermediates */
const e34 = g.edges.find((e) => [e.a, e.b].sort().join() === [lc(A(3)), lc(A(4))].sort().join());
ok(e34 && e34.dir === "both" && e34.kinds.includes("dev") && e34.kinds.includes("transfer"), "both directions merge into one line, dir both");
ok(e34.color === 0, "a line inside cluster 1 takes its colour");
ok(!g.edges.some((e) => [e.a, e.b].includes(lc(A(5))) && [e.a, e.b].includes(lc(A(6)))), "a link through an intermediate is not drawn directly");
const via = g.vias.find((v) => v.id === lc(A(999)));
ok(via && via.members.length === 3 && via.color === 1, "the shared funder is drawn as an intermediate in cluster 2's colour");
const viaEdges = g.edges.filter((e) => e.a === lc(A(999)) || e.b === lc(A(999)));
ok(viaEdges.length === 3, "one line from the intermediate to each holder it joins");
const ve = viaEdges[0];
const fromVia = ve.a === lc(A(999)) ? ve.dir === "ab" : ve.dir === "ba";
ok(fromVia, "the arrow points from the funder to the holder");
ok(!g.vias.some((v) => v.id === lc(A(998))), "an intermediate joining fewer than two drawn bubbles is skipped");
const dev = g.nodes.find((n) => n.id === lc(A(3)));
ok(dev.dev === true, "the dev bubble is marked");

/* layout: deterministic, no overlaps, stable when a bubble is hidden */
const L1 = layoutGraph(buildGraph(r), TOKEN);
const L2 = layoutGraph(buildGraph(r), TOKEN);
const pos = (L) => [...L.nodes, ...L.vias].map((n) => `${n.id}:${n.x},${n.y}`).join("|");
ok(pos(L1) === pos(L2), "the same coin gives the same picture");
const L3 = layoutGraph(buildGraph(r), "0x" + "ab".repeat(20));
ok(pos(L1) !== pos(L3), "another coin gives another picture");
let overlaps = 0;
for (let i = 0; i < L1.nodes.length; i++) for (let j = i + 1; j < L1.nodes.length; j++) {
  const a = L1.nodes[i], b = L1.nodes[j];
  if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) overlaps++;
}
ok(overlaps === 0, `no two bubbles overlap (${overlaps})`);
const c2 = L1.nodes.filter((n) => n.cluster === "c2");
const c2d = Math.max(...c2.flatMap((a) => c2.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
const meanD = (() => { let s = 0, n = 0; for (const a of L1.nodes) for (const b of L1.nodes) if (a !== b) { s += Math.hypot(a.x - b.x, a.y - b.y); n++; } return s / n; })();
ok(c2d < meanD, "a cluster's members sit closer together than bubbles on average");
const prev = new Map([...L1.nodes, ...L1.vias].map((n) => [n.id, { x: n.x, y: n.y }]));
const hidden2 = new Set([...defaultHidden(r), lc(A(20))]);
const L4 = layoutGraph(buildGraph(r, { hidden: hidden2 }), TOKEN, { prev });
const shift = L4.nodes.reduce((s, n) => s + Math.hypot(n.x - prev.get(n.id).x, n.y - prev.get(n.id).y), 0) / L4.nodes.length;
ok(shift < 12, `hiding one bubble moves the others only a little (mean ${shift.toFixed(2)})`);
const b = bounds(L1);
ok(b.x1 > b.x0 && b.y1 > b.y0 && L1.nodes.every((n) => n.x - n.r >= b.x0 - 1e-9 && n.y + n.r <= b.y1 + 1e-9), "bounds hold every bubble");
ok(bounds({ nodes: [], vias: [] }).x0 === -50, "bounds of an empty map");

/* arrows */
const p = { x: 0, y: 0, r: 10 }, q = { x: 100, y: 0, r: 20 };
const ab = arrowGeometry(p, q, "ab", { head: 5, gap: 2 });
ok(Math.abs(ab.x1 - 12) < 1e-9 && Math.abs(ab.x2 - 78) < 1e-9, "a line is trimmed to both circle edges");
ok(ab.heads.length === 1 && Math.abs(ab.heads[0][0][0] - 78) < 1e-9, "one arrowhead at b's edge for a → b");
ok(arrowGeometry(p, q, "ba").heads.length === 1 && arrowGeometry(p, q, "ba").heads[0][0][0] < 20, "b → a puts the head at a");
ok(arrowGeometry(p, q, "both").heads.length === 2, "both ways: two heads");
ok(arrowGeometry(p, q, null).heads.length === 0, "no direction: no head");
ok(arrowGeometry(p, { x: 25, y: 0, r: 15 }, "ab") === null, "touching circles: no line");

/* address list */
let rows = listRows(r);
ok(rows[0].contract && rows[1].contract && rows[0].hidden && rows[1].hidden, "contracts first, hidden");
ok(rows[2].type === "cluster" && rows[2].id === "c1" && rows[2].count === 2 && rows[2].dev === true, "cluster 1 next, as one row");
ok(rows[3].type === "cluster" && rows[3].id === "c2" && rows[3].count === 3, "cluster 2 next");
ok(rows[4].type === "holder" && rows[4].rank === 8, "then the loose wallets by rank");
ok(!rows.some((x) => x.type === "holder" && x.cluster), "folded clusters hide their members");
rows = listRows(r, { open: new Set(["c2"]) });
const i2 = rows.findIndex((x) => x.id === "c2");
ok(rows[i2].open && rows[i2 + 1].member === "c2" && rows[i2 + 3].member === "c2", "an open cluster lists its members under it");
rows = listRows(r, { ungroup: true });
ok(!rows.some((x) => x.type === "cluster") && rows.filter((x) => x.type === "holder").length === r.holders.length, "ungroup lists every holder");
ok(listRows(r, { query: "#5" }).filter((x) => !x.contract).length === 1 && listRows(r, { query: "#5" }).some((x) => x.rank === 5), "search by #rank");
ok(listRows(r, { query: "poolmanager" }).some((x) => x.rank === 1), "search by name");
ok(listRows(r, { hidden: new Set([lc(A(5)), lc(A(6)), lc(A(7))]) }).find((x) => x.id === "c2").hidden, "a cluster with every member hidden reads hidden");
ok(hashSeed(TOKEN) === hashSeed(TOKEN.toUpperCase().replace("0X", "0x")), "the seed ignores letter case");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
