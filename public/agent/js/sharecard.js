// V8 F42 Herald · share cards. A 1200×630 PNG drawn on a canvas in the browser for a Troya Gate verdict, a Watchfire alert
// or a PnL, in Troya's chrome on dark, with the sharer's referral link and a QR code of it (qr.js, no network).
// The user downloads the card and posts it from their own account; "Post on X" only opens X's free post intent.
import { h, clear, icon, toast, modal, seg, useCss, short } from "./ui.js";
import { api } from "./api.js";
import { wallet, openConnect, signIn } from "./wallet.js";
import { qrMatrix } from "./qr.js";

export const W = 1200, H = 630;
const SITE = "https://troya.codes";
const C = { bg: "#05090b", fg: "#f3f8fb", fg2: "#c3cfd8", muted: "#7d8b97", faint: "#56636e", accent: "#8edff5", accent2: "#5fd3ef", up: "#8edff5", down: "#ff7d7d", warn: "#f0c46e", grey: "#9fb0bf", tile: "#eef9fc", ink: "#061016" };
const TONE = { up: ["#f7fdff", C.up], down: ["#ffd9d9", C.down], warn: ["#fff0cf", C.warn], grey: ["#e3ebf0", C.grey] };
const SANS = '"Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const GATE = { passed: ["Passed", "up", "passed"], caution: ["Caution", "warn", "shows caution"], failed: ["Failed", "down", "failed"], untested: ["Not tested yet", "grey", "is not tested yet"], error: ["Unavailable", "grey", "could not be checked"] };
const FIRE = { clear: ["Calm", "up", "Nothing unusual in this coin's transfers."], amber: ["Watch", "warn", "Weight in few hands. Nothing moving yet."], red: ["Selling fast", "down", "Holders are leaving quickly."], fire: ["Fire", "down", "A dump pattern just happened."], loading: ["Reading", "grey", "Reading this coin's transfers. Try again in a few seconds."] };
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/* ---------- the sharer's link ---------- */
let refMemo = null;
/** { code, link, linkShort } for the signed-in wallet, or null (cards then carry the plain site link). */
export async function loadRef(force = false) {
  if (!wallet.session) return null;
  if (refMemo && !force && refMemo.addr === wallet.session.address) return refMemo.v;
  try { const r = await api.get("herald/me"); refMemo = { addr: wallet.session.address, v: { code: r.code, link: r.link, linkShort: r.linkShort } }; return refMemo.v; }
  catch { return null; }
}
/** The link that goes in a post: the coin page when there is a coin, with the referral code when there is one. */
export function shareUrl(ref, address) {
  const base = `${SITE}/agent${ref?.code ? `?ref=${ref.code}` : ""}`;
  return address && ADDR.test(address) ? `${base}#/token/${address.toLowerCase()}` : base;
}
// one cashtag per post: any $TICKER after the first loses its "$"
const oneCashtag = (s) => { let seen = false; return String(s).replace(/\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g, (m, t) => (seen ? t : ((seen = true), m))); };
export const xIntent = (text, url) => `https://x.com/intent/post?text=${encodeURIComponent(oneCashtag(text).slice(0, 230))}&url=${encodeURIComponent(url)}`;

/* ---------- what goes on a card ---------- */
const sym = (s) => String(s || "").replace(/^\$/, "").replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 16);
export async function gateSpec(address) {
  const r = await api.get(`/api/badge/${address}`);
  const checks = (r.checks || []).slice(0, 8);
  const pass = checks.filter((c) => c.status === "pass").length;
  const g = GATE[r.verdict] || GATE.error;
  return { kind: "gate", address, symbol: sym(r.symbol), word: g[0], tone: g[1], checks, pass, at: r.checkedAt || Date.now(),
    line: checks.length ? `${pass} of ${checks.length} checks passed` : r.verdict === "untested" ? "No buyers on the curve yet, so the test sell waits" : "No checks yet",
    post: `$${sym(r.symbol) || "this coin"} ${g[2]} on Troya Gate${checks.length ? `: ${pass} of ${checks.length} checks` : ""}. A simulated buy and a test sell from a fresh address, before you buy.` };
}
export async function watchfireSpec(address) {
  const r = await api.get(`/api/watchfire/${address}`);
  const f = FIRE[r.level] || FIRE.loading;
  const m = r.metrics || null;
  // partial: a coin older than the 6 hours Watchfire reads back, whose holder figures are only that window's buys and sells
  return { kind: "watchfire", address, symbol: sym(r.symbol), word: f[0], tone: f[1], sub: f[2], why: (r.why || []).slice(0, 2), metrics: m, partial: r.fullHistory === false, at: Date.now(), loading: r.level === "loading",
    post: `Watchfire on $${sym(r.symbol) || "this coin"}: ${f[0]}. ${(r.why || [])[0] || f[2]}`.trim() };
}
/** pnlPct wins; else entry and exit prices give it. */
export function pnlSpec({ symbol, entry, exit, pnlPct, label, title }) {
  const e = Number(entry), x = Number(exit);
  let p = pnlPct === "" || pnlPct == null ? NaN : Number(pnlPct);
  if (!isFinite(p) && e > 0 && x > 0) p = (x / e - 1) * 100;
  if (!isFinite(p)) throw new Error("Give a PnL %, or an entry and an exit price.");
  const s = sym(symbol);
  const pct = `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p) >= 1000 ? Math.round(Math.abs(p)).toLocaleString("en-US") : Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 1)}%`;
  return { kind: "pnl", symbol: s, title: String(title || "").slice(0, 40), word: pct, tone: p >= 0 ? "up" : "down", entry: e > 0 ? e : null, exit: x > 0 ? x : null,
    label: String(label || "").slice(0, 60), at: Date.now(), post: title ? `${pct} in ${String(title).slice(0, 40)}, shared from Troya Agent.` : `${pct} on ${s ? `$${s}` : "a trade"}, shared from Troya Agent.` };
}

/* ---------- drawing ---------- */
let logo = null;
async function assets() {
  try { await Promise.all([document.fonts.load(`700 40px ${SANS}`), document.fonts.load(`500 20px ${SANS}`), document.fonts.load(`500 18px ${MONO}`)]); } catch { /* system fonts then */ }
  if (logo === null) {
    logo = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(false); i.src = "/img/logo-3d-128.png"; });
  }
}
function rrect(c, x, y, w, hh, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function font(c, size, weight = 500, fam = SANS) { c.font = `${weight} ${size}px ${fam}`; }
function fit(c, text, maxW, size, weight = 600, fam = SANS, min = 18) {
  let s = size;
  for (; s > min; s -= 2) { font(c, s, weight, fam); if (c.measureText(text).width <= maxW) break; }
  return s;
}
function wrap(c, text, maxW, lines = 2) {
  const words = String(text).split(/\s+/), out = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (c.measureText(t).width <= maxW) { cur = t; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(" ") !== out.join(" ")) {
    let l = out[lines - 1];
    while (l && c.measureText(`${l}…`).width > maxW) l = l.slice(0, -1);
    out[lines - 1] = `${l.replace(/[\s,.;:]+$/, "")}…`;
  }
  return out;
}
function mark(c, x, y, status) {
  const col = status === "pass" ? C.up : status === "fail" ? C.down : status === "warn" ? C.warn : C.grey;
  c.save();
  c.beginPath(); c.arc(x, y, 12, 0, Math.PI * 2);
  c.fillStyle = `${col}22`; c.fill(); c.lineWidth = 1.5; c.strokeStyle = `${col}aa`; c.stroke();
  c.strokeStyle = col; c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round";
  c.beginPath();
  if (status === "pass") { c.moveTo(x - 5, y + 0.5); c.lineTo(x - 1.5, y + 4); c.lineTo(x + 5.5, y - 4); }
  else if (status === "fail") { c.moveTo(x - 4.5, y - 4.5); c.lineTo(x + 4.5, y + 4.5); c.moveTo(x + 4.5, y - 4.5); c.lineTo(x - 4.5, y + 4.5); }
  else if (status === "warn") { c.moveTo(x, y - 5.5); c.lineTo(x, y + 1.5); c.moveTo(x, y + 5.2); c.lineTo(x, y + 5.3); }
  else { c.moveTo(x - 5, y); c.lineTo(x + 5, y); }
  c.stroke();
  c.restore();
}
function bigWord(c, text, x, y, maxW, size, tone) {
  const s = fit(c, text, maxW, size, 700, SANS, 48);
  const [a, b] = TONE[tone] || TONE.up;
  const g = c.createLinearGradient(0, y - s * 0.8, 0, y + s * 0.1);
  g.addColorStop(0, a); g.addColorStop(0.55, b); g.addColorStop(1, b);
  c.fillStyle = g;
  c.fillText(text, x, y);
  return s;
}
function stamp(t) {
  const d = new Date(t || Date.now());
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** Draws a card. spec from gateSpec / watchfireSpec / pnlSpec; ref from loadRef() (or null). Returns the canvas. */
export async function drawCard(spec, ref, canvas = document.createElement("canvas")) {
  await assets();
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext("2d");
  const toneCol = (TONE[spec.tone] || TONE.up)[1];
  // the room: near-black teal, two soft lights, faint horizontal slices like the horse
  c.fillStyle = C.bg; c.fillRect(0, 0, W, H);
  let g = c.createRadialGradient(170, 70, 0, 170, 70, 760);
  g.addColorStop(0, "rgba(95,211,239,.20)"); g.addColorStop(0.45, "rgba(95,211,239,.06)"); g.addColorStop(1, "rgba(95,211,239,0)");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(1060, 640, 0, 1060, 640, 620);
  g.addColorStop(0, spec.tone === "down" ? "rgba(255,125,125,.13)" : spec.tone === "warn" ? "rgba(240,196,110,.11)" : "rgba(142,223,245,.12)"); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = "rgba(255,255,255,.016)";
  for (let y = 0; y < H; y += 7) c.fillRect(0, y, W, 1);
  rrect(c, 16, 16, W - 32, H - 32, 28); c.lineWidth = 1.5; c.strokeStyle = "rgba(255,255,255,.08)"; c.stroke();

  // header
  if (logo) c.drawImage(logo, 60, 50, 60, 60);
  c.textBaseline = "alphabetic"; c.textAlign = "left";
  font(c, 30, 700); c.fillStyle = C.fg; c.fillText("Troya", logo ? 132 : 64, 91);
  const tw = c.measureText("Troya").width;
  font(c, 30, 400); c.fillStyle = C.accent; c.fillText("Agent", (logo ? 132 : 64) + tw + 8, 91);
  font(c, 17, 500, MONO); c.fillStyle = C.muted; c.textAlign = "right"; c.fillText(stamp(spec.at), W - 64, 88); c.textAlign = "left";

  // kicker
  const kick = spec.kind === "gate" ? "TROYA GATE" : spec.kind === "watchfire" ? "WATCHFIRE" : spec.title ? "RESULT" : "PNL";
  font(c, 15, 500, MONO);
  const kw = c.measureText(kick.split("").join(" ")).width + 32;
  rrect(c, 64, 140, kw, 34, 17); c.fillStyle = `${toneCol}14`; c.fill(); c.lineWidth = 1.2; c.strokeStyle = `${toneCol}66`; c.stroke();
  c.fillStyle = toneCol; c.fillText(kick.split("").join(" "), 80, 163);

  // the coin
  const L = 64, maxW = 720;
  const head = spec.kind === "pnl" && spec.title ? spec.title : spec.symbol ? `$${spec.symbol}` : spec.address ? short(spec.address) : "";
  if (head) { fit(c, head, maxW, 46, 600); c.fillStyle = C.fg; c.fillText(head, L, 236); }

  if (spec.kind === "gate") {
    bigWord(c, spec.word, L, 338, maxW, 108, spec.tone);
    font(c, 27, 500); c.fillStyle = C.fg2; c.fillText(spec.line, L, 384);
    font(c, 20, 500);
    spec.checks.forEach((ck, i) => {
      const col = i % 2, row = Math.floor(i / 2), x = L + col * 352, y = 430 + row * 38;
      mark(c, x + 12, y - 7, ck.status);
      let t = String(ck.label || ck.key || "");
      while (t && c.measureText(t).width > 300) t = t.slice(0, -1);
      c.fillStyle = ck.status === "pass" ? C.fg2 : C.fg; c.fillText(t, x + 34, y);
    });
  } else if (spec.kind === "watchfire") {
    bigWord(c, spec.word, L, 334, maxW, 104, spec.tone);
    font(c, 25, 500); c.fillStyle = C.fg2; c.fillText(wrap(c, spec.sub, maxW, 1)[0] || "", L, 378);
    font(c, 20, 400); c.fillStyle = C.muted;
    const lines = spec.why.length ? wrap(c, spec.why.join(" · "), maxW, 2) : [];
    lines.forEach((l, i) => c.fillText(l, L, 414 + i * 28));
    const m = spec.metrics;
    if (m) {
      // an older coin's figures cover its last 6 hours only: say so on the card, in labels no longer than the usual ones (the tile does not shrink its label)
      const p = spec.partial;
      const tiles = [[p ? "Top buyer, 6 h" : "Largest holder", `${(m.topPct ?? 0).toFixed(1)}%`], [p ? "Via one bot, 6 h" : "Bought via one bot", `${Math.round(m.herdPct ?? 0)}%`], ["Sold last minute", `${(m.soldLastMinPct ?? 0).toFixed(1)}%`], [p ? "Buyers, 6 h" : "Holders", m.holders != null ? Number(m.holders).toLocaleString("en-US") : "–"]];
      tiles.forEach(([k, v], i) => {
        const x = L + i * 180, y = 474;
        rrect(c, x, y, 168, 84, 16); c.fillStyle = "rgba(255,255,255,.035)"; c.fill(); c.lineWidth = 1; c.strokeStyle = "rgba(255,255,255,.08)"; c.stroke();
        font(c, 14, 500); c.fillStyle = C.muted; c.fillText(k, x + 14, y + 28);
        fit(c, v, 140, 30, 700); c.fillStyle = C.fg; c.fillText(v, x + 14, y + 66);
      });
    }
  } else {
    bigWord(c, spec.word, L, 384, maxW, 156, spec.tone);
    let y = 440;
    if (spec.entry && spec.exit) {
      const px = (v) => (v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v.toPrecision(4));
      font(c, 25, 500, MONO); c.fillStyle = C.fg2; c.fillText(`Entry ${px(spec.entry)}  →  Exit ${px(spec.exit)}`, L, y);
      y += 40;
    }
    if (spec.label) { font(c, 22, 500); c.fillStyle = C.muted; c.fillText(wrap(c, spec.label, maxW, 1)[0] || "", L, y); }
  }

  // the link and its QR code, on a light tile so every phone camera reads it
  const T = 300, tx = 852, ty = 146;
  const link = ref?.link || `${SITE}/agent`;
  c.save(); c.shadowColor = "rgba(95,211,239,.35)"; c.shadowBlur = 44;
  rrect(c, tx, ty, T, T, 26); c.fillStyle = C.tile; c.fill(); c.restore();
  try {
    const q = qrMatrix(link), ms = Math.floor(232 / q.size), off = Math.round((T - ms * q.size) / 2);
    c.fillStyle = C.ink;
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) c.fillRect(tx + off + x * ms, ty + off + y * ms, ms, ms);
  } catch { /* a link this long never happens; the tile stays blank */ }
  c.textAlign = "center";
  const label = ref?.linkShort || "troya.codes/agent";
  fit(c, label, T + 20, 19, 500, MONO, 12); c.fillStyle = C.accent; c.fillText(label, tx + T / 2, ty + T + 42);
  font(c, 16, 500); c.fillStyle = C.muted; c.fillText(ref?.code ? "Scan to open Troya with this link" : "Scan to open Troya", tx + T / 2, ty + T + 70);
  c.textAlign = "left";

  // footer
  const foot = spec.kind === "gate" ? "A simulated buy and a test sell from a fresh address. A snapshot from the chain, not a promise."
    : spec.kind === "watchfire" ? "Watchfire reads every transfer of the coin. Patterns, not proof."
      : "Shared from Troya Agent.";
  font(c, 17, 400); c.fillStyle = C.faint; c.fillText(foot, L, 598);
  return canvas;
}

/* ---------- actions under a card ---------- */
export function download(canvas, name) {
  canvas.toBlob((b) => {
    if (!b) return toast("The card could not be saved.", "error");
    const a = h("a", { href: URL.createObjectURL(b), download: `${name || "troya-card"}.png` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}
/** Three buttons for a drawn card. get() returns { canvas, spec, url } at click time. */
export function actions(get) {
  const name = (s) => ["troya", s.kind, s.symbol || s.title || ""].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return h("div", { class: "hr-acts" },
    h("button", { class: "btn primary", type: "button", onclick: () => { const g = get(); if (g?.canvas) download(g.canvas, name(g.spec)); } }, dlMark(), "Download PNG"),
    h("button", { class: "btn", type: "button", onclick: async () => { const g = get(); if (!g) return; try { await navigator.clipboard.writeText(g.url); toast("Link copied", "ok"); } catch { toast(g.url); } } }, icon("copy"), "Copy link"),
    h("button", { class: "btn", type: "button", onclick: () => { const g = get(); if (g) window.open(xIntent(g.spec.post, g.url), "_blank", "noopener"); } }, xMark(), "Post on X"));
}
function dlMark() {
  const s = h("span", { class: "hr-x", "aria-hidden": "true" });
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  return s;
}
function xMark() {
  const s = h("span", { class: "hr-x", "aria-hidden": "true" });
  s.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  return s;
}
/** "Sign in to put your link on the card", or the link itself. onRef(ref) runs after a sign-in. */
export function refNote(ref, onRef) {
  if (ref) return h("p", { class: "fine muted hr-refnote" }, "Your referral link is on the card and in the post: ", h("span", { class: "mono" }, ref.linkShort));
  return h("p", { class: "fine muted hr-refnote" }, "Sign in to put your own referral link on the card. ",
    h("button", { class: "link", type: "button", onclick: async () => {
      try { if (!wallet.address) await openConnect(); if (wallet.address && !wallet.session) await signIn(); onRef(await loadRef(true)); } catch (e) { toast(e.message, "error"); }
    } }, "Sign in"));
}

/* ---------- the Share dialog on a coin page: Gate verdict and Watchfire cards ---------- */
export async function openShare({ address, symbol, stock = false }) {
  useCss("herald");
  let kind = "gate", ref = await loadRef(), cur = null, seq = 0;
  const canvas = h("canvas", { class: "hr-canvas", width: W, height: H, "aria-label": "Share card preview" });
  const msg = h("p", { class: "fine muted hr-msg" });
  const note = h("div");
  const pick = stock ? null : seg([{ value: "gate", label: "Gate verdict" }, { value: "watchfire", label: "Watchfire" }], kind, (v) => { kind = v; paint(); });
  const paintNote = () => clear(note, refNote(ref, (r) => { ref = r; paintNote(); paint(); }));
  async function paint() {
    const my = ++seq;
    msg.textContent = kind === "gate" ? "Reading the Gate verdict…" : "Reading Watchfire…";
    canvas.classList.add("busy");
    try {
      const spec = kind === "gate" ? await gateSpec(address) : await watchfireSpec(address);
      if (!spec.symbol && symbol) { spec.symbol = sym(symbol); spec.post = spec.post.replace("$this coin", `$${spec.symbol}`); }
      if (my !== seq) return;
      await drawCard(spec, ref, canvas);
      cur = { canvas, spec, url: shareUrl(ref, address) };
      msg.textContent = spec.loading ? "Watchfire is still reading this coin. Try again in a few seconds for a full card." : "Download the card, then attach it to your post. The post links to this coin.";
    } catch (e) { if (my === seq) msg.textContent = `Could not make the card: ${e.message}`; }
    finally { if (my === seq) canvas.classList.remove("busy"); }
  }
  paintNote();
  modal({ title: `Share $${sym(symbol) || short(address)}`, wide: true, body: h("div", { class: "hr-share" },
    pick ? h("div", { class: "hr-share-top" }, pick) : null,
    h("div", { class: "hr-frame" }, canvas), msg, actions(() => cur), note) });
  paint();
}
