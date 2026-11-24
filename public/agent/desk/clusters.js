// Cluster map (community request, 24 Nov 2026): a coin's 50 largest holders as bubbles, sized by the share they hold;
// wallets linked to each other are joined by lines and coloured by cluster; pools, lockers, staking and burn addresses are
// drawn apart in grey and never grouped. Tap or hover a bubble: its address, its share and why it is linked, with the
// transaction behind each link. The data is GET /api/clusters/:token (server/clusters.mjs); this file only draws it.
//   clusterSection(address, { lazy, inset, link })  the section for the token page and the Gate result
//   mount(view, ctx)                                the page at #/clusters and #/clusters/<token>
import { h, clear, icon, short, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest, findCoin } from "/agent/js/coinsearch.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const NS = "http://www.w3.org/2000/svg";
const LABEL = { wallet: "Wallet", dev: "Dev wallet", pool: "Pool", locker: "Locker", staking: "Staking contract", burn: "Burn address", contract: "Contract" };
const CONTRACT = new Set(["pool", "locker", "staking", "burn", "contract"]);
const EVTYPE = { tx: "Transaction", address: "Address", block: "Block" };
const STATUS = { done: "read", running: "still reading", failed: "could not be read", "n/a": "not applicable" };
const PALETTE = 6;
const SAMPLES = [["$TROYA", "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"]];

export function clusterCss() {
  if (document.querySelector("link[data-cm-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/clusters.css", "data-cm-css": "1" }));
}
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
const pc = (x) => (x == null ? "–" : `${x > 0 && x < 0.01 ? "<0.01" : x < 10 ? x.toFixed(2) : x.toFixed(1)}%`);
const safeUrl = (u) => (/^https:\/\/robinhoodchain\.blockscout\.com\//.test(u || "") ? u : null);
const colorOf = (id) => (id ? ((Number(String(id).slice(1)) - 1) % PALETTE) + 1 : 0);
const SHORT = { "Uniswap v4 PoolManager": "PoolManager", PonsV2LaunchLocker: "Pons locker", "zero address (burned)": "burned", "dead address (burned)": "burned" };
const shortName = (n) => SHORT[n] || String(n || "");

function evidenceEl(e) {
  if (!e) return null;
  const url = safeUrl(e.url);
  const ref = e.type === "block" ? `#${Number(e.ref).toLocaleString("en-US")}` : short(e.ref, 6);
  return h("span", { class: "cm-ev" }, h("span", { class: "cm-ev-t" }, EVTYPE[e.type] || e.type),
    url ? h("a", { class: "link mono", href: url, target: "_blank", rel: "noopener", title: e.ref }, ref, h("span", { class: "cm-ev-out" }, " on Blockscout")) : h("span", { class: "mono" }, ref));
}

/* ---------- layout: a small deterministic force layout (no library) ---------- */
function layout(nodes, links, W, H) {
  const total = nodes.reduce((t, n) => t + Math.max(n.pct, 0.03), 0) || 1;
  const k = Math.sqrt((W * H * 0.4) / (Math.PI * total));
  const rMax = Math.min(W, H) * 0.2, rMin = W < 520 ? 3.5 : 4.5;
  for (const n of nodes) n.r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(Math.max(n.pct, 0.03))));
  // seeds: clusters on a ring of their own, everything else on a golden-angle spiral by rank (same input, same picture)
  const cl = [...new Set(nodes.map((n) => n.cluster).filter(Boolean))];
  const cx = W / 2, cy = H / 2, ga = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((n, i) => {
    if (n.cluster) {
      const j = cl.indexOf(n.cluster), a = (j / Math.max(1, cl.length)) * 2 * Math.PI + 0.6;
      const off = ((i % 7) - 3) * 6;
      n.x = cx + Math.cos(a) * W * 0.26 + off; n.y = cy + Math.sin(a) * H * 0.26 + off * 0.7;
    } else {
      const rr = Math.sqrt(i + 1) * Math.min(W, H) * 0.055;
      n.x = cx + Math.cos(i * ga) * rr * (W / H > 1.3 ? 1.7 : 1); n.y = cy + Math.sin(i * ga) * rr;
    }
  });
  const by = new Map(nodes.map((n) => [n.address, n]));
  const L = links.map((l) => [by.get(l.from), by.get(l.to)]).filter(([a, b]) => a && b);
  for (let it = 0; it < 260; it++) {
    const cool = 1 - it / 260;
    const gx = W > H * 1.2 ? 0.005 : 0.01;
    for (const n of nodes) { n.x += (cx - n.x) * gx * cool; n.y += (cy - n.y) * 0.012 * cool; }
    for (const [a, b] of L) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, want = a.r + b.r + 16;
      const f = ((d - want) / d) * 0.06;
      a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r + 3;
      if (d < min) { const p = (min - d) / d / 2; a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p; }
    }
    for (const n of nodes) { n.x = Math.max(n.r + 2, Math.min(W - n.r - 2, n.x)); n.y = Math.max(n.r + 2, Math.min(H - n.r - 2, n.y)); }
  }
}

/* ---------- one map ---------- */
function renderMap(box, r, { standalone }) {
  const stage = h("div", { class: "cm-stage" });
  const detail = h("div", { class: "cm-detail", "aria-live": "polite" });
  const legend = h("div", { class: "cm-legend", "aria-hidden": "true" },
    h("span", {}, h("i", { class: "cm-k cm-k-link" }), "Linked wallets (one colour per cluster)"),
    h("span", {}, h("i", { class: "cm-k cm-k-w" }), "Wallet, no link found"),
    h("span", {}, h("i", { class: "cm-k cm-k-dev" }), "Dev wallet"),
    h("span", {}, h("i", { class: "cm-k cm-k-c" }), "Contract (pool, locker, staking, burn): not a person, never grouped"));
  const nodes = r.holders.map((x) => ({ ...x, address: x.address }));
  const byAddr = new Map(nodes.map((n) => [n.address, n]));
  const clusterOf = new Map(r.clusters.map((c) => [c.id, c]));
  let sel = null, svg = null, focusCl = null;

  const draw = () => {
    const W = Math.max(300, Math.round(stage.clientWidth || 700));
    const H = Math.round(W < 520 ? Math.max(340, W * 1.05) : Math.min(520, Math.max(380, W * 0.56)));
    layout(nodes, r.links, W, H);
    svg = s("svg", { class: "cm-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": `Bubble map of the ${nodes.length} largest holders` });
    const gl = s("g", { class: "cm-lines" }), gn = s("g", { class: "cm-nodes" });
    for (const l of r.links) {
      const a = byAddr.get(l.from), b = byAddr.get(l.to);
      if (!a || !b) continue;
      gl.append(s("line", { x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1), class: `cm-l cm-c${colorOf(a.cluster)} conf-${l.confidence}`, "data-a": a.address, "data-b": b.address, "data-cl": a.cluster || "" }));
    }
    for (const n of [...nodes].sort((a, b) => b.r - a.r)) {
      const kind = CONTRACT.has(n.label) ? "contract" : n.cluster ? "linked" : n.label === "dev" ? "dev" : "wallet";
      const g = s("g", { class: `cm-n cm-${kind} cm-c${colorOf(n.cluster)}${n.label === "burn" ? " cm-burn" : ""}`, tabindex: "0", role: "button", "data-a": n.address, "data-cl": n.cluster || "",
        "aria-label": `${LABEL[n.label] || n.label}${n.name ? ` ${n.name}` : ""} ${short(n.address)}, ${pc(n.pct)} of the supply${n.cluster ? `, in a linked cluster` : ""}` });
      g.append(s("circle", { cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: n.r.toFixed(1), class: "cm-b" }));
      if (n.label === "dev") g.append(s("circle", { cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: (n.r + 3.5).toFixed(1), class: "cm-ring" }));
      if (n.r >= 15) {
        const big = n.r >= 30 && (n.name || n.label === "dev");
        g.append(s("text", { x: n.x.toFixed(1), y: (n.y + (big ? -2 : 4)).toFixed(1), class: "cm-t" }, pc(n.pct)));
        if (big) g.append(s("text", { x: n.x.toFixed(1), y: (n.y + 12).toFixed(1), class: "cm-t2" }, n.label === "dev" ? "dev" : shortName(n.name).slice(0, Math.floor(n.r / 3))));
      }
      g.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") pick(n.address, false); });
      g.addEventListener("click", (e) => { e.stopPropagation(); pick(n.address, true); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(n.address, true); } });
      gn.append(g);
    }
    svg.append(gl, gn);
    svg.addEventListener("click", () => pick(null, true));
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pinned) pick(null, false); });
    clear(stage, svg);
    paint();
  };
  let pinned = false;
  function pick(a, pin) {
    if (pin) pinned = !!a;
    else if (pinned) return;
    sel = a ? byAddr.get(a) : null;
    focusCl = sel?.cluster || null;
    paint();
  }
  function paint() {
    if (!svg) return;
    const on = !!sel || !!focusCl;
    for (const g of svg.querySelectorAll(".cm-n")) {
      const a = g.getAttribute("data-a"), c = g.getAttribute("data-cl");
      g.classList.toggle("is-sel", !!sel && a === sel.address);
      g.classList.toggle("is-dim", on && !(sel && a === sel.address) && !(focusCl && c === focusCl));
    }
    for (const l of svg.querySelectorAll(".cm-l")) l.classList.toggle("is-dim", on && !(focusCl && l.getAttribute("data-cl") === focusCl));
    clear(detail, sel ? nodeCard(sel) : focusCl ? clusterCard(clusterOf.get(focusCl)) : h("p", { class: "fine cm-hint" }, "Tap or hover a bubble: its address, its share and why it is linked. Bubble size is the share of the supply it holds."));
  }
  function nodeCard(n) {
    const c = n.cluster ? clusterOf.get(n.cluster) : null;
    return h("div", { class: "cm-card" },
      h("div", { class: "cm-card-h" },
        h("span", { class: `cm-chip cm-chip-${CONTRACT.has(n.label) ? "c" : n.cluster ? `l cm-c${colorOf(n.cluster)}` : n.label === "dev" ? "dev" : "w"}` }, LABEL[n.label] || n.label),
        n.name ? h("b", {}, n.name) : null,
        h("a", { class: "link mono", href: `${EXPLORER}/address/${n.address}`, target: "_blank", rel: "noopener", title: n.address }, short(n.address, 5))),
      h("p", { class: "cm-card-p" }, h("b", {}, pc(n.pct)), " of the supply", n.rank ? ` · #${n.rank} holder` : " · shown beside the 50 largest holders"),
      CONTRACT.has(n.label) ? h("p", { class: "fine" }, n.label === "burn" ? "Burned coins: nobody can move them." : "A contract holds coins for many people (a pool, a locker, staking), so it is never put in a cluster.") : null,
      c ? h("p", { class: "fine" }, `In cluster ${c.id.slice(1)}${c.dev ? " (dev side)" : ""}: ${c.count} wallets, ${pc(c.pct)} together · ${c.reason} · confidence ${c.confidence}`) : null,
      n.why?.length ? h("ul", { class: "cm-why" }, n.why.map((w) => h("li", {}, h("span", {}, w.text), h("span", { class: "cm-why-c" }, `confidence ${w.confidence}`), evidenceEl(w.evidence))))
        : !CONTRACT.has(n.label) ? h("p", { class: "fine" }, "No link to the other wallets on the map in what was read.") : null);
  }
  function clusterCard(c) {
    if (!c) return null;
    return h("div", { class: "cm-card" },
      h("div", { class: "cm-card-h" }, h("span", { class: `cm-chip cm-chip-l cm-c${colorOf(c.id)}` }, `Cluster ${c.id.slice(1)}`), h("b", {}, `${c.count} wallets · ${pc(c.pct)}`)),
      h("p", { class: "fine" }, `${c.reasons.join(", ")} · confidence ${c.confidence}`), evidenceEl(c.evidence));
  }

  const list = r.clusters.length ? h("ol", { class: "cm-list" }, r.clusters.map((c) => h("li", { class: `cm-cl cm-c${colorOf(c.id)}` },
    h("button", { class: "cm-cl-h", type: "button", onclick: () => { sel = null; pinned = true; focusCl = focusCl === c.id ? null : c.id; paint(); stage.scrollIntoView({ block: "nearest", behavior: "smooth" }); } },
      h("i", { class: "cm-sw" }), h("b", {}, `Cluster ${c.id.slice(1)}${c.dev ? " · dev side" : ""}`), h("span", {}, `${c.count} wallets · ${pc(c.pct)}`), h("span", { class: `cm-conf conf-${c.confidence}` }, `confidence ${c.confidence}`)),
    h("p", { class: "fine" }, c.reasons.join(", ")),
    evidenceEl(c.evidence),
    h("div", { class: "cm-ws" }, c.wallets.slice(0, 8).map((w) => h("button", { class: "cm-w mono", type: "button", title: w, onclick: () => pick(w, true) }, short(w, 4))), c.wallets.length > 8 ? h("span", { class: "fine" }, `+${c.wallets.length - 8} more`) : null))))
    : null;

  const stopList = [];
  clear(box,
    h("p", { class: "cm-sum" }, r.summary),
    h("div", { class: "cm-body" }, h("div", { class: "cm-left" }, stage, legend), detail),
    list,
    r.notes?.length ? h("ul", { class: "cm-notes fine" }, r.notes.map((n) => h("li", {}, n))) : null,
    h("details", { class: "cm-cov" }, h("summary", {}, `What was read (${r.coverage.filter((c) => c.status === "done").length} of ${r.coverage.length} sources) · ${r.holdersSource || "Blockscout"} holders · ${ago(r.checkedAt)} ago`),
      h("ul", {}, r.coverage.map((c) => h("li", { class: `c-${String(c.status).replace("/", "")}` }, h("b", {}, c.source), h("span", {}, STATUS[c.status] || c.status), c.note ? h("small", {}, c.note) : null)))),
    h("p", { class: "note cm-note" }, r.note));
  // drawn once the stage has a width; redrawn when it changes (a phone turned, a sidebar opened)
  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = Math.round(stage.clientWidth); if (w && Math.abs(w - lastW) > 24) { lastW = w; draw(); } });
  ro.observe(stage);
  stopList.push(() => ro.disconnect());
  return () => stopList.forEach((f) => f());
}

/** The Cluster map section for one coin. lazy: start reading when it scrolls near the screen. inset: no panel frame
 *  (inside the Gate result). link: a link to the full page. */
export function clusterSection(address, { lazy = true, inset = false, link = true, standalone = false } = {}) {
  clusterCss();
  const body = h("div", { class: "cm-out", "aria-live": "polite" }, h("div", { class: "cm-wait" }, h("span", { class: "cm-spin" }), h("span", {}, "Reading the largest holders, their funders, the dev side and the launch…")));
  const el = h("section", { class: `cm ${inset ? "cm-inset" : "panel"}` },
    h("div", { class: "panel-h cm-h" }, h("h2", {}, "Cluster map"), h("span", { class: "fine cm-sub" }, "who holds it, and which wallets are linked"),
      link ? h("a", { class: "link fine", href: `#/clusters/${address}` }, "Full map") : null),
    body);
  let tries = 0, stop = null, timer = 0, started = false;
  const load = async () => {
    if (tries > 0 && !el.isConnected) return;
    tries++;
    let r;
    try { r = await api.get(`/api/clusters/${address}`); }
    catch (e) {
      if (!el.isConnected) return;
      clear(body, h("div", { class: "cm-empty" }, h("b", {}, "The Cluster map could not be read right now."), h("p", { class: "fine" }, e.message), h("button", { class: "btn sm", type: "button", onclick: () => { tries = 0; load(); } }, icon("refresh"), "Try again")));
      return;
    }
    if (!el.isConnected && tries > 1) return;
    stop?.();
    if (!r.holders?.length) clear(body, h("div", { class: "cm-empty" }, h("b", {}, r.summary || "No holders to draw yet."), h("p", { class: "fine" }, r.note || "")));
    else stop = renderMap(body, r, { standalone });
    if (r.partial && tries < 8) timer = setTimeout(load, 12_000);
  };
  const start = () => { if (started) return; started = true; load(); };
  if (lazy && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "400px" });
    requestAnimationFrame(() => io.observe(el));
  } else setTimeout(start, 30);
  el.stop = () => { clearTimeout(timer); stop?.(); };
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
      h("p", { class: "dk-sub" }, "The 50 largest holders of a coin as bubbles. Wallets that shared a funder, moved coins between them, bought in one transaction or are tied to the dev are joined by a line, each link with the transaction behind it. Pools, lockers and staking are shown apart: they are not people.")),
    h("section", { class: "panel cm-form-p" }, h("div", { class: "cm-form" }, box, go),
      h("p", { class: "fine cm-try" }, "Try: ", SAMPLES.map(([t, x]) => h("button", { class: "link", type: "button", onclick: () => run(x) }, t)))),
    out));
  const start = ctx.parts?.[0] || ctx.query?.address || "";
  if (ADDR.test(start)) run(start); else setTimeout(() => input.focus(), 30);
  return () => cur?.stop?.();
}
