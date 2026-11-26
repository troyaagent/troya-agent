// Troya Check page: troya.codes/check (the dashboard) and troya.codes/check/<address> (one coin). The server writes the
// coin's first answer into #check-data (server/check.mjs renderPage), so the page shows it without a second request; a
// check still running is fetched from /api/check/<address>. Coin names and symbols are set by their creators: every string
// from the API goes in as text, never as markup.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const okHref = (h) => (/^(\/(?!\/)|https:\/\/)/.test(String(h || "")) ? String(h) : null);
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const TONE = { good: "var(--t-good)", warn: "var(--t-warn)", risky: "var(--t-risky)", bad: "var(--t-bad)", grey: "var(--t-grey)" };
const tone = (t) => TONE[t] || TONE.grey;
const ago = (t) => { const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const when = (t) => new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC").replace(/^\w+, /, "");
function toast(text, kind = "") {
  const box = $("[data-toasts]"); if (!box) return;
  const t = document.createElement("div"); t.className = `toast ${kind}`; t.textContent = text; box.append(t); setTimeout(() => t.remove(), 2600);
}

const m = /^\/check\/(0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname);
const ADDR = m ? m[1] : null;
const coinBox = $("[data-ck-coin]");

/* ---------- the dashboard ---------- */
const icon = (r, cls = "ck-ico") => {
  const letters = esc(String(r.symbol || r.address || "?").replace(/^\$/, "").slice(0, 2).toUpperCase());
  const q = r.kind === "stock" ? "" : "";
  return `<span class="${cls}" aria-hidden="true"><i>${letters}</i><img src="/api/icon/token/${esc(r.address)}${q}" alt="" loading="lazy" onload="this.parentNode.classList.add('ok')" onerror="this.remove()"></span>`;
};
const row = (r, extra = "") => {
  const name = r.symbol ? `$${esc(r.symbol)}` : short(r.address);
  const badge = r.score != null ? r.score : r.kind === "stock" ? "Stock" : r.kind === "major" ? "Major" : "–";
  return `<li class="ck-row">${icon(r)}<a href="/check/${esc(r.address)}"><b>${name}</b><small>${esc(r.label || "")}${r.reason ? ` · ${esc(r.reason)}` : ""}</small><small>${short(r.address)} · ${ago(r.at)}${extra}</small></a><span class="ck-badge" style="--c:${tone(r.tone)}">${esc(badge)}</span></li>`;
};
async function loadDash() {
  let d; try { d = await (await fetch("/api/check")).json(); } catch { return; }
  const fill = (k, rows, empty, extra) => { const el = $(`[data-board="${k}"]`); if (el) el.innerHTML = rows?.length ? rows.map((r) => row(r, extra ? extra(r) : "")).join("") : `<li class="ck-empty">${empty}</li>`; };
  fill("safest", d.safest, "No coin checked this week yet.");
  fill("flagged", d.flagged, "No coin checked this week yet.");
  fill("mostChecked", d.mostChecked, "No checks this week yet.", (r) => ` · ${r.checks} check${r.checks === 1 ? "" : "s"}`);
  fill("recent", d.recent, "No checks yet. Paste an address above.", (r) => (r.via && r.via !== "web" ? ` · via ${r.via === "x" ? "X" : r.via === "telegram" ? "Telegram" : r.via}` : ""));
  const tot = $("[data-ck-total]");
  if (tot) tot.textContent = `${Number(d.total || 0).toLocaleString("en-US")} checks recorded · ${Number(d.thisWeek || 0).toLocaleString("en-US")} in the last 7 days. ${d.note || ""}`;
  const wt = $("[data-ck-weights] tbody");
  if (wt && d.weights) {
    const names = { gate: "Troya Gate: simulated buy and test sell", ring: "Ring Radar: rigged launch pattern", devside: "Dev side wallets", holders: "Holders (The Assay)", market: "Liquidity and holders", heel: "Weak spot (Heel)", clash: "Same ticker on other contracts", age: "Token age", claims: "Website and X claims, checked on chain" };
    wt.innerHTML = Object.entries(d.weights).map(([k, w]) => `<tr><td>${esc(names[k] || k)}</td><td>${w}</td></tr>`).join("");
  }
  const cl = $("[data-ck-caps]");
  if (cl && d.caps) {
    const why = { gateFail: "the Gate fails the test sell, the exact swap, the transfer tax or the fees", ringRed: "Ring Radar flags a rigged launch", noRoute: "no route to buy it", lpPulled: "the dev pulled liquidity", devsideFail: "the dev side holds most of it or is selling now", noSellRoute: "a buy works but no route sells it back", thinFail: "the pool is too thin for a 0.01 ETH buy", gateNotRead: "the Gate could not run", claimFalse: "the project claims liquidity locked, renounced, a tax, a supply or a burn that the chain contradicts", unread: "the Gate, Ring Radar, the dev side or The Assay is not read yet" };
    cl.innerHTML = Object.entries(d.caps).sort((a, b) => a[1] - b[1]).map(([k, v]) => `<li><b>${v}</b> when ${esc(why[k] || k)}</li>`).join("");
  }
}

/* ---------- one coin ---------- */
const ICON = {
  share: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z"/></svg>',
  out: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12"/></svg>',
};
function ring(r) {
  const R = 100, C = 2 * Math.PI * R, c = tone(r.tone);
  const arc = r.score != null ? `<circle cx="120" cy="120" r="${R}" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * Math.max(0.004, r.score / 100)).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 120 120)"/>` : "";
  const mid = r.score != null ? `<text class="num" x="120" y="138" text-anchor="middle">${r.score}</text><text class="of" x="120" y="170" text-anchor="middle">/ 100</text>`
    : `<text class="word" x="120" y="130" text-anchor="middle">${r.kind === "stock" ? "Stock" : r.kind === "major" ? "Major" : r.kind === "unknown" ? "No token" : "Not read"}</text>`;
  return `<svg class="ck-ring" viewBox="0 0 240 240" role="img" aria-label="${r.score != null ? `Score ${r.score} out of 100` : esc(r.label)}"><circle cx="120" cy="120" r="${R}" fill="none" stroke="rgba(245,249,251,.08)" stroke-width="12"/>${arc}${mid}</svg>`;
}
function partHtml(p) {
  const chip = p.status === "scored" ? (p.weight > 0 ? `${Math.round(p.points ?? p.weight * p.value)} of ${p.weight}` : "info") : p.status === "n/a" ? "n/a" : "not read";
  // claims: the exact words found, where they were found, and what the chain shows
  const CL = { proven: "var(--t-good)", contradicted: "var(--t-bad)", unverified: "var(--t-grey)" };
  const claims = (p.claims || []).slice(0, 10).map((c) => { const src = okHref(c.url), ln = okHref(c.link?.href);
    return `<li style="--c:${CL[c.status] || CL.unverified}"><span class="st">${esc(c.status)}</span><b>${esc(c.name)}</b><q>${esc(c.quote)}</q><small>${esc(c.evidence)}${ln ? ` <a href="${esc(ln)}"${/^https:/.test(ln) ? ' target="_blank" rel="noopener"' : ""}>${esc(c.link.label)}</a>` : ""}${src ? ` · found on <a href="${esc(src)}" target="_blank" rel="noopener nofollow">${esc(src.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : ""}</small></li>`; }).join("");
  const ev = claims ? "" : (p.evidence || []).slice(0, 6).map((e) => `<li>${e.label ? `<b>${esc(e.label)}:</b> ` : ""}${esc(e.text)}</li>`).join("");
  const lk = (p.links || []).map((l) => { const h = okHref(l.href); return h ? `<a href="${esc(h)}"${/^https:/.test(h) ? ' target="_blank" rel="noopener"' : ""}>${esc(l.label)}</a>` : ""; }).join("");
  return `<li class="ck-part"><h3>${esc(p.name)}<small>weight ${p.weight}</small></h3><div><p>${esc(p.summary)}</p>${ev ? `<ul>${ev}</ul>` : ""}${claims ? `<ul class="ck-claims">${claims}</ul>` : ""}${lk ? `<div class="lk">${lk}</div>` : ""}</div><span class="ck-chip" style="--c:${p.status === "scored" ? tone(p.tone) : "var(--t-grey)"}">${chip}</span></li>`;
}
function showCoin(r) {
  coinBox.hidden = false;
  const name = r.symbol ? `$${r.symbol}` : short(r.address);
  $("[data-ck-h1]").textContent = name;
  $("[data-ck-lead]").textContent = r.score != null ? `Troya Check: ${r.score}/100, ${r.label}. ${r.headline || ""}` : `${r.label}. ${r.headline || ""}`;
  document.title = r.score != null ? `${name}: ${r.score}/100, ${r.label} · Troya Check` : `${name}: ${r.label} · Troya Check`;
  const page = `https://troya.codes/check/${r.address}`;
  const reasons = (r.reasons || []).map((x) => { const h = okHref(x.link?.href); return `<li style="--c:${tone(x.tone)}"><span>${esc(x.text)}${h ? ` <a href="${esc(h)}"${/^https:/.test(h) ? ' target="_blank" rel="noopener"' : ""}>${esc(x.link.label)}</a>` : ""}</span></li>`; }).join("");
  const capped = (r.caps || [])[0];
  const xText = r.score != null ? `${/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(r.symbol || "") ? "$" + r.symbol : short(r.address)} on Troya Check: ${r.score}/100, ${r.label.toLowerCase()}.` : `${name} on Troya Check: ${r.label}.`;
  const buy = r.gatePassed ? `<a class="ck-btn solid" href="/agent#/swap?out=${esc(r.address)}">Open in Swap</a>` : "";
  const coinLinks = r.kind === "unknown" ? "" : `<a class="ck-btn" href="/agent#/gate/${esc(r.address)}">Gate page</a><a class="ck-btn" href="/agent#/heel/${esc(r.address)}">Heel</a><a class="ck-btn" href="/agent#/token/${esc(r.address)}">Token page</a>`;
  coinBox.innerHTML = `
  <div class="ck-card" style="--tone:${tone(r.tone)}">
    <div>
      <p class="ck-sym">${icon(r, "ck-ico lg")}${esc(name)}</p>
      ${r.name && r.name !== r.symbol ? `<p class="ck-name">${esc(r.name)}</p>` : ""}
      <p class="ck-addr"><code>${esc(r.address)}</code><button class="ck-mini" type="button" data-copy="${esc(r.address)}">Copy</button></p>
      <ul class="ck-reasons">${reasons}</ul>
      ${capped && r.score != null ? `<p class="ck-capnote">Capped at ${capped.at}: ${esc(capped.why)}.</p>` : ""}
      <div class="ck-acts">
        ${buy}
        <button class="ck-btn" type="button" data-share>${ICON.share}Share</button>
        <a class="ck-btn" href="https://x.com/intent/post?text=${encodeURIComponent(xText)}&url=${encodeURIComponent(page)}" target="_blank" rel="noopener">${ICON.x}Post</a>
        ${coinLinks}
        ${buy ? `<p class="ck-buynote">Swap runs Troya Gate again on the pool as it is before you sign.</p>` : ""}
      </div>
    </div>
    <div class="ck-score">
      ${ring(r)}
      <span class="ck-pill">${esc(r.label)}</span>
      <p class="ck-when">Checked ${esc(when(r.checkedAt))}${r.partial ? "<br>Some parts were still reading" : ""}</p>
      ${r.partial ? '<button class="ck-mini" type="button" data-again>Check again</button>' : ""}
    </div>
  </div>
  ${(r.parts || []).length ? `<ul class="ck-parts">${r.parts.map(partHtml).join("")}</ul>` : ""}
  <p class="ck-note" style="margin-top:24px">Automated checks, not an audit. A snapshot from the chain at the time above; a coin can change after a check. Never a safe stamp and never advice to buy.</p>`;
  coinBox.querySelector("[data-copy]")?.addEventListener("click", async (e) => { try { await navigator.clipboard.writeText(e.currentTarget.dataset.copy); toast("Address copied", "ok"); } catch { toast(e.currentTarget.dataset.copy); } });
  coinBox.querySelector("[data-share]")?.addEventListener("click", async () => {
    if (navigator.share) { try { await navigator.share({ title: document.title, url: page }); return; } catch (e) { if (e?.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(page); toast("Link copied", "ok"); } catch { toast(page); }
  });
  coinBox.querySelector("[data-again]")?.addEventListener("click", () => load(true));
}
function showPending(secs = 0, slow = false) {
  coinBox.hidden = false;
  $("[data-ck-h1]").textContent = short(ADDR);
  const msg = slow
    ? `Still reading after ${secs} seconds: some of Troya's reads on this coin are slow right now. They keep running on the server; check again in a minute and the answer will be there.`
    : `Reading now${secs ? ` (${secs} s)` : ""}: Troya Gate runs a simulated buy and a test sell, then Ring Radar, the dev side, The Assay and Heel. The score shows as soon as there is one, usually within half a minute.`;
  coinBox.innerHTML = `<div class="ck-card" style="--tone:var(--t-grey)"><div><p class="ck-sym">${short(ADDR)}</p><p class="ck-addr"><code>${esc(ADDR)}</code></p><p class="ck-pending">${slow ? "" : "<i></i>"}${esc(msg)}</p>${slow ? '<p><button class="ck-mini" type="button" data-again>Check again</button></p>' : ""}</div></div>`;
  coinBox.querySelector("[data-again]")?.addEventListener("click", () => poll());
}
// The server answers { pending: true } while it reads a coin; the page asks again every 4 s, for about a minute, and renders
// only once there is a score (or the coin is a stock, a major or not a token). It never shows "not enough read" as a verdict.
const POLL_MS = 4000, POLL_FOR_MS = 75_000;
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  const t0 = Date.now();
  showPending(0);
  try {
    for (;;) {
      let d = null;
      try {
        const res = await fetch(`/api/check/${ADDR}`, { cache: "no-store" });
        d = await res.json();
        if (!res.ok && res.status !== 429) throw new Error(d.error || `HTTP ${res.status}`);
      } catch (e) { if (Date.now() - t0 > POLL_FOR_MS) throw e; }
      const secs = Math.round((Date.now() - t0) / 1000);
      const ready = d && !d.pending && !d.stillReading && (d.kind !== "coin" || d.score != null);
      if (ready) {
        showCoin(d);
        // parts still reading: one more look once the server's short cache for them has passed
        if (d.partial) setTimeout(() => refresh(), 62_000);
        return;
      }
      if (Date.now() - t0 > POLL_FOR_MS || d?.stillReading) { showPending(secs, true); return; }
      showPending(secs);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (e) {
    coinBox.hidden = false;
    coinBox.innerHTML = `<p class="ck-note">This check could not finish just now (${esc(String(e.message || e).slice(0, 140))}). <button class="ck-mini" type="button" data-again>Try again</button></p>`;
    coinBox.querySelector("[data-again]")?.addEventListener("click", () => poll());
  } finally { polling = false; }
}
// a later look at a coin already shown: replaced only by another settled answer, never by "reading"
async function refresh() {
  try {
    const d = await (await fetch(`/api/check/${ADDR}`, { cache: "no-store" })).json();
    if (d && !d.pending && !d.stillReading && (d.kind !== "coin" || d.score != null)) showCoin(d);
  } catch { /* the answer on screen stays */ }
}
const load = (again) => (again ? refresh() : poll());

if (ADDR) {
  let first = null;
  try { first = JSON.parse($("#check-data")?.textContent || "null"); } catch { first = null; }
  const inp = $("#ck-in"); if (inp) inp.value = "";
  if (first?.result && (first.result.kind !== "coin" || first.result.score != null)) { showCoin(first.result); if (first.result.partial) setTimeout(() => refresh(), 62_000); }
  else poll();
}
$("[data-ck-form]")?.addEventListener("submit", (e) => {
  const v = String($("#ck-in").value || "").trim();
  const a = (/0x[0-9a-fA-F]{40}/.exec(v) || [])[0];
  e.preventDefault();
  if (!a) { toast("Paste a token address: 0x and 40 letters or digits."); return; }
  location.href = `/check/${a}`;
});
async function loadRecord() {
  const box = $("[data-ck-record]"); if (!box) return;
  let d; try { d = await (await fetch("/api/check/record")).json(); } catch { box.innerHTML = '<p class="ck-empty">The record could not be read just now.</p>'; return; }
  const n = (v, suf = "") => (v == null ? "–" : `${v}${suf}`);
  const ch = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v}%`);
  box.innerHTML = (d.buckets || []).map((b) => `<div class="ck-rec-card" style="--c:${tone(b.tone)}"><h3>${esc(b.label)}</h3><span class="rng">score ${esc(b.band.replace("-", " to "))}</span>
    <dl><dt>Graded</dt><dd>${b.graded}</dd><dt>Went to zero</dt><dd>${b.graded ? `${b.wentToZero} (${n(b.zeroPct, "%")})` : "–"}</dd><dt>Median 24 h</dt><dd>${ch(b.median24h)}</dd><dt>Still watching</dt><dd>${b.watching}</dd></dl>
    ${b.smallSample ? `<p class="small">${b.graded ? `Only ${b.graded} graded: too few to read much into.` : "None graded yet."}</p>` : ""}</div>`).join("");
  const note = $("[data-ck-record-note]");
  if (note) note.textContent = `${d.note ? d.note + " " : ""}${d.rules || ""}`;
}
loadDash();
loadRecord();
