// Troya Check page: troya.codes/check (the board: trending coins with their checks, the checks lists, live panels) and
// troya.codes/check/<address> (one coin). The server writes the coin's first answer into #check-data (server/check.mjs
// renderPage); a check still running is polled from /api/check/<address>. The board is one request (/api/check/board).
// Coin names and symbols are set by their creators: every string from the API goes in as text, never as markup.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const okHref = (h) => (/^(\/(?!\/)|https:\/\/)/.test(String(h || "")) ? String(h) : null);
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const TONE = { good: "var(--t-good)", warn: "var(--t-warn)", risky: "var(--t-risky)", bad: "var(--t-bad)", grey: "var(--t-grey)" };
const tone = (t) => TONE[t] || TONE.grey;
const ago = (t) => { if (!t) return "–"; const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const when = (t) => new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC").replace(/^\w+, /, "");
const usd = (v) => (v == null || !isFinite(v) ? "–" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v >= 1 ? v.toFixed(0) : v.toPrecision(2)}`);
const num = (v) => (v == null || !isFinite(v) ? "–" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : Number(v).toLocaleString("en-US"));
const pct = (v) => (v == null || !isFinite(v) ? '<span class="mut">–</span>' : `<span class="${v > 0 ? "up" : v < 0 ? "dn" : "mut"}">${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(1)}%</span>`);
const subTone = (v) => (v == null ? "grey" : v >= 67 ? "good" : v >= 34 ? "warn" : "bad");
const xCash = (r) => (/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(r.symbol || "") ? `$${r.symbol}` : short(r.address));

// what is behind the number, one line under the score (holder review, 27 Nov 2026): the raw weighted sum, the cap that
// lowered it, how many parts were read and the method version (the weights changed on 27 Nov: v2)
// a score the token team has contested (idea J): said plainly, the number stays as read from the chain
function disputeLine(d) {
  const when = d.since ? new Date(d.since).toISOString().slice(0, 10) : "";
  return `<p class="cv-dispute"><b>Disputed${when ? ` since ${when}` : ""}.</b> The token team contested this score and the Troya team is reviewing it. The score stays as read from the chain until the review ends.${d.note ? ` Note: ${esc(d.note)}` : ""}</p>`;
}

// idea E: Check Watch, what changed on chain since Troya started reading this coin (each change → a fresh check)
function watchCard(r) {
  const w = r.watch || {};
  const list = (w.changes || []).map((c) => `<li><span>${esc(c.text)}${c.after != null ? ` <b class="cv-dc-v">· checked again: ${c.before ?? "–"} → ${c.after}</b>` : ""}</span><span class="cv-dc-at">${ago(c.at)} ago</span></li>`).join("");
  const none = `<p class="cv-basis">${w.since ? `No change since Troya started watching this coin ${ago(w.since)} ago.` : "Troya starts watching this coin now that it has been checked."} Read every few minutes: creator fee recipient and tax, graduation, code upgrades, owner, pool liquidity. Any change runs the check again.</p>`;
  return `<div class="ck-card2 cv-watch"><h3>Watched for changes</h3>${list ? `<ul>${list}</ul>` : none}<p class="cv-follow"><a href="https://t.me/TrojanTroya_bot?start=follow_${esc(r.address)}" target="_blank" rel="noopener">Alert me on Telegram when this changes</a>${w.followers ? ` · ${w.followers} following` : ""}</p></div>`;
}

// idea D: the creator fee recipient and what that wallet has collected (the escrow counts per wallet, across its coins)
function creatorFeeRow(c) {
  const who = c.recipient ? `<a href="https://robinhoodchain.blockscout.com/address/${esc(c.recipient)}" target="_blank" rel="noopener"><code>${short(c.recipient)}</code></a>${c.recipientIsDeployer ? " (the deployer)" : " (not the deployer)"}` : "–";
  const tax = c.creatorTaxPct != null ? `${c.creatorTaxPct}% tax · ` : "";
  const f = c.fees;
  const money = f ? ` · this wallet received ${f.creditedEth != null ? f.creditedEth.toFixed(3) : "–"} ETH and claimed ${f.claimedEth != null ? f.claimedEth.toFixed(3) : "–"} ETH${f.claims ? ` in ${f.claims} claim${f.claims === 1 ? "" : "s"}` : ""}${f.lastClaimAt ? `, last ${ago(f.lastClaimAt)} ago` : ""} (across all its coins)` : "";
  return `${tax}${who}${money}`;
}

function basisLine(r) {
  const b = r.basis, when = r.checkedAt ? `${new Date(r.checkedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const bits = [`raw ${b.raw}`, b.cap ? `capped at ${b.cap.at}: ${esc(b.cap.why)}` : "no cap applied", `${b.read} of ${b.of} parts read`, `method ${esc(b.method)}`, when ? `checked ${when}` : ""].filter(Boolean);
  return `<p class="cv-basis" title="${esc(b.methodNote || "")}">${r.score} / 100 · ${bits.join(" · ")}</p>`;
}

function toast(text, kind = "") {
  const box = $("[data-toasts]"); if (!box) return;
  const t = document.createElement("div"); t.className = `toast ${kind}`; t.textContent = text; box.append(t); setTimeout(() => t.remove(), 2600);
}
const m = /^\/check\/(0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname);
const ADDR = m ? m[1] : null;
const coinBox = $("[data-ck-coin]");

// a coin's logo in a rounded square, its first letters behind it (a logo that fails is removed: no inline handlers, CSP)
const icon = (r, cls = "ck-ico") => `<span class="${cls}" aria-hidden="true"><i>${esc(String(r.symbol || r.address || "?").replace(/^\$/, "").slice(0, 2).toUpperCase())}</i><img src="/api/icon/token/${esc(r.address)}" alt="" loading="lazy" decoding="async"></span>`;
document.addEventListener("error", (e) => { const t = e.target; if (t && t.tagName === "IMG" && t.parentNode?.classList?.contains("ck-ico")) t.remove(); }, true);
// a 24-point price line (the board's own sparkline)
function spark(arr, w = 96, h = 28) {
  const a = (arr || []).filter((x) => x > 0);
  if (a.length < 2) return "";
  const lo = Math.min(...a), hi = Math.max(...a), span = hi - lo || hi || 1;
  const pts = a.map((v, i) => `${((i / (a.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const up = a.at(-1) >= a[0];
  return `<svg class="ck-spark ${up ? "up" : "dn"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" vector-effect="non-scaling-stroke"/></svg>`;
}
const padName = (p) => ({ pons: "Pons", flap: "Flap", clanker: "Clanker", bankr: "Bankr", virtuals: "Virtuals", uniswap: "Uniswap", "uniswap-v3": "Uniswap", "uniswap-v4": "Uniswap", other: "Other" }[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""));

/* =================================================================== the board ================================================= */
const S = { data: null, view: "trending", win: "1h", list: "latest", pad: "all", verdict: "all", find: "", sort: null, dir: -1, reading: new Map() };
const grid = $("[data-ck-grid]");
const bandOf = (c) => (!c ? "none" : c.tone || "grey");
const rightNow = (ch) => (ch == null ? null : ch >= 10 ? ["Pumping", "up"] : ch <= -10 ? ["Falling", "dn"] : ["Flat", "mut"]);

function verdictCell(r) {
  const c = r.check;
  if (!c) {
    const st = S.reading.get(r.address);
    return `<span class="vb none"><span class="vb-n">${st === "slow" ? "Still reading" : "Not checked"}</span><button type="button" class="ck-chk" data-check="${esc(r.address)}"${st === "busy" ? " disabled" : ""}>${st === "busy" ? "Reading…" : "Check"}</button></span>`;
  }
  const bar = (label, v) => `<span class="bar" title="${label} ${v ?? "not read"}/100" aria-label="${label} ${v ?? "not read"} of 100"><em>${label}</em><i style="--w:${v ?? 0}%;--c:${tone(subTone(v))}"></i></span>`;
  // the bars come from the check's stored sub-scores (checks recorded before 27 Nov have none: no bars, nothing made up)
  const bars = c.exit != null || c.holders != null ? `<span class="bars">${bar("Exit", c.exit)}${bar("Holders", c.holders)}</span>` : "";
  return `<span class="vb"><b class="sc" style="--c:${tone(c.tone)}">${c.score}</b><span class="vb-r"><span class="lbl" style="--c:${tone(c.tone)}">${esc(c.label)}</span>${bars}</span></span>`;
}
const pill = (word, v) => (v == null ? '<span class="pl mut">–</span>' : `<span class="pl" style="--c:${tone(subTone(v))}">${word} <b>${v}</b></span>`);
const exitWord = (v) => (v == null ? "" : v >= 67 ? "Clear" : v >= 34 ? "Risky" : "Blocked");
const holdWord = (v) => (v == null ? "" : v >= 67 ? "Spread" : v >= 34 ? "Concentrated" : "Rigged");

const COLS = {
  trending: [["n", "#"], ["coin", "Coin"], ["v", "Troya verdict", "score"], ["call", "The call"], ["mc", "MC", "mcapUsd"], ["ch", "Change", "chg"], ["vol", "Vol 24h", "volume24hUsd"], ["tx", "Trades 24h", "txns24h"], ["liq", "Liquidity", "liquidityUsd"], ["hold", "Holders", "holders"], ["since", "Since check", "since"], ["buy", ""]],
  checks: [["n", "#"], ["coin", "Coin"], ["ex", "Exit", "exit"], ["ho", "Holders", "hold2"], ["tot", "Score", "score"], ["call", "Summary"], ["mc", "MC", "mcapUsd"], ["ch", "24h", "change24h"], ["since", "Since check", "since"], ["now", "Right now · 1h", "change1h"], ["age", "Checked", "at"]],
};
const valOf = (r, k) => ({ score: r.check?.score, chg: S.win === "1h" ? r.change1h : r.change24h, since: r.check?.sinceCheck, exit: r.check?.exit, hold2: r.check?.holders, at: r.check?.at })[k] ?? r[k];

function rowHtml(r, i) {
  const c = r.check;
  const coin = `<a class="c-coin" href="/check/${esc(r.address)}">${icon(r)}<span class="cc"><span class="cc1"><b>${r.symbol ? `$${esc(r.symbol)}` : short(r.address)}</b></span><small>${r.launchpad ? `<em class="pad" data-pad="${esc(String(r.launchpad).replace(/^uniswap-v[34]$/, "uniswap"))}">${esc(padName(r.launchpad))}</em>` : ""}${esc(r.name || short(r.address))}</small></span></a>`;
  const call = c ? `<span class="c-call">${esc(c.headline || c.label)}<small>checked ${ago(c.at)} ago${c.checks > 1 ? ` · ${c.checks} checks` : ""}</small></span>` : `<span class="c-call mut">Not checked yet. One click reads its Gate, launch, dev wallets and holders.</span>`;
  const since = `<span class="c-since" data-l="Since check">${c ? pct(c.sinceCheck) : '<span class="mut">–</span>'}</span>`;
  if (S.view === "checks") {
    const rn = rightNow(r.change1h);
    return `<div class="ck-r" role="row"><span class="c-n">${i + 1}</span>${coin}<span class="c-ex">${pill(exitWord(c?.exit), c?.exit)}</span><span class="c-ho">${pill(holdWord(c?.holders), c?.holders)}</span>
      <span class="c-tot"><b class="sc" style="--c:${tone(c?.tone)}">${c?.score ?? "–"}</b></span>${call}<span class="c-mc" data-l="MC">${usd(r.mcapUsd)}</span><span class="c-ch" data-l="24h">${pct(r.change24h)}</span>${since}
      <span class="c-now" data-l="Right now">${rn ? `<span class="rn ${rn[1]}">${rn[0]}</span> ${pct(r.change1h)}` : '<span class="mut">–</span>'}</span><span class="c-age" data-l="Checked">${ago(c?.at)}${r.weekChecks > 1 ? `<small> · ${r.weekChecks}×</small>` : ""}</span></div>`;
  }
  const buy = c?.gatePassed ? `<a class="ck-buy" href="/agent#/swap?out=${esc(r.address)}" title="Swap runs Troya Gate again before you sign">Buy</a>` : "";
  return `<div class="ck-r" role="row"><span class="c-n">${i + 1}</span>${coin}<span class="c-v">${verdictCell(r)}</span>${call}
    <span class="c-mc" data-l="MC">${usd(r.mcapUsd)}${spark(r.spark, 56, 18)}</span><span class="c-ch" data-l="${S.win}">${pct(S.win === "1h" ? r.change1h : r.change24h)}</span><span class="c-vol" data-l="Vol 24h">${usd(r.volume24hUsd)}</span>
    <span class="c-tx" data-l="Trades 24h">${num(r.txns24h)}</span><span class="c-liq" data-l="Liquidity">${usd(r.liquidityUsd)}</span><span class="c-hold" data-l="Holders">${num(r.holders)}</span>${since}<span class="c-buy">${buy}</span></div>`;
}
function rowsNow() {
  if (!S.data) return [];
  let rows = S.view === "trending" ? S.data.trending : S.data.checks?.[S.list] || [];
  if (S.pad !== "all") rows = rows.filter((r) => r.launchpad === S.pad);
  if (S.verdict !== "all") rows = rows.filter((r) => (S.verdict === "none" ? !r.check : r.check && bandOf(r.check) === S.verdict));
  const q = S.find.trim().toLowerCase().replace(/^\$/, "");
  if (q) rows = rows.filter((r) => `${r.symbol || ""} ${r.name || ""} ${r.address}`.toLowerCase().includes(q));
  if (S.sort) rows = [...rows].sort((a, b) => { const x = valOf(a, S.sort), y = valOf(b, S.sort); return x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : (x - y) * S.dir; });
  return rows;
}
function drawGrid() {
  const cols = COLS[S.view];
  const rows = rowsNow();
  grid.className = `ck-grid is-${S.view}`;
  const head = `<div class="ck-r ck-h" role="row">${cols.map(([k, label, sk]) => `<span class="c-${k}" role="columnheader">${sk ? `<button type="button" data-sort="${sk}" aria-pressed="${S.sort === sk}">${esc(k === "ch" && S.view === "trending" ? `${S.win} %` : label)}${S.sort === sk ? (S.dir < 0 ? " ↓" : " ↑") : ""}</button>` : esc(label)}</span>`).join("")}</div>`;
  grid.innerHTML = head + (rows.length ? rows.map(rowHtml).join("") : `<p class="ck-empty">${S.data ? "No coin matches these filters." : "Loading the board…"}</p>`);
  const meta = $("[data-ck-meta]");
  if (meta && S.data) meta.textContent = `${S.view === "trending" ? `${S.data.trending.length} coins` : `${rows.length} checked this week`} · updated ${ago(S.data.at)} ago`;
}
function drawSide(d) {
  const li = (r, right) => `<li><a href="/check/${esc(r.address)}">${icon(r, "ck-ico sm")}<b>${r.symbol ? `$${esc(r.symbol)}` : short(r.address)}</b></a>${right}</li>`;
  const lbl = (r) => (r.label ? `<span class="lbl" style="--c:${tone(r.tone)}">${esc(r.label)}</span>` : "");
  $("[data-ck-live]").innerHTML = d.live?.length ? d.live.map((r) => li(r, `<small class="mut">${ago(r.startedAt)}</small>`)).join("") : '<li class="ck-empty">Nothing is being read right now.</li>';
  $("[data-ck-just]").innerHTML = d.just?.length ? d.just.map((r) => li(r, lbl(r))).join("") : '<li class="ck-empty">No checks yet.</li>';
  $("[data-ck-most]").innerHTML = d.mostChecked24h?.length ? d.mostChecked24h.map((r) => li(r, `${lbl(r)}<small class="cnt">${r.checks}</small>`)).join("") : '<li class="ck-empty">No checks in the last 24 hours.</li>';
  const ch = $("[data-ck-changed]");
  if (ch) ch.innerHTML = d.changed?.length ? d.changed.map((r) => `<li class="ck-chg"><a href="/check/${esc(r.address)}">${icon(r, "ck-ico sm")}<b>${r.symbol ? `$${esc(r.symbol)}` : short(r.address)}</b></a><small class="mut" title="${esc(r.text)}">${esc(r.kinds.map((k) => ({ "fee-recipient": "fee recipient", tax: "tax", graduated: "graduated", upgrade: "code upgrade", owner: "owner", liquidity: "liquidity" }[k] || k)).join(", "))} · ${r.after != null ? `${r.before ?? "–"} → ${r.after}` : "re-checking"} · ${ago(r.at)}</small></li>`).join("") : '<li class="ck-empty">No on-chain change in the last 7 days.</li>';
  const devs = $("[data-ck-devsbox]");
  if (devs) { devs.hidden = !d.devs?.length; $("[data-ck-devs]").innerHTML = (d.devs || []).map((x) => `<li><a href="https://robinhoodchain.blockscout.com/address/${esc(x.dev)}" target="_blank" rel="noopener"><code>${short(x.dev)}</code></a><small class="${x.good ? "up" : "mut"}">${x.good} of ${x.coins} scored 50+</small></li>`).join(""); }
  const pads = $("[data-ck-pads]");
  if (pads) pads.innerHTML = [`<button type="button" data-pad="all" aria-pressed="${S.pad === "all"}">All launchpads</button>`, ...(d.launchpads || []).map((p) => `<button type="button" data-pad="${esc(p.id)}" aria-pressed="${S.pad === p.id}">${esc(padName(p.id))} <small>${p.n}</small></button>`)].join("");
  const note = $("[data-ck-boardnote]");
  if (note) note.textContent = `${d.note || ""} The verdict bars: Exit (the Gate and Ring Radar) and Holders (the dev side and The Assay), each out of 100.`;
}
async function loadBoard() {
  if (!grid) return;
  try {
    const d = await (await fetch("/api/check/board", { cache: "no-store" })).json();
    if (!d?.trending) throw new Error(d?.error || "no board");
    // a coin checked from this page keeps its fresh answer until the board has it too
    for (const r of d.trending) { const mine = S.data?.trending?.find((x) => x.address === r.address); if (!r.check && mine?.check) r.check = mine.check; }
    S.data = d; drawSide(d); drawGrid();
  } catch (e) { if (!S.data) grid.innerHTML = `<p class="ck-empty">The board could not be read just now (${esc(String(e.message).slice(0, 80))}).</p>`; }
}
// one click runs the check inline and polls like the coin page (every 4 s, up to 75 s)
async function checkInline(a) {
  if (S.reading.get(a) === "busy") return;
  S.reading.set(a, "busy"); drawGrid();
  const t0 = Date.now();
  while (Date.now() - t0 < 75_000) {
    let d = null;
    try { d = await (await fetch(`/api/check/${a}`, { cache: "no-store" })).json(); } catch {}
    if (d && !d.pending && !d.stillReading && d.score != null) {
      const row = S.data?.trending?.find((x) => x.address === a);
      if (row) row.check = { score: d.score, label: d.label, tone: d.tone, headline: d.reasons?.[0]?.short || d.headline, exit: d.sub?.exit ?? null, holders: d.sub?.holders ?? null, gatePassed: !!d.gatePassed, at: d.checkedAt, checks: 1, sinceCheck: 0 };
      S.reading.delete(a); drawGrid(); return;
    }
    if (d && (d.stillReading || (d.kind && d.kind !== "coin"))) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  S.reading.set(a, "slow"); drawGrid();
}
function wireBoard() {
  if (!grid) return;
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view; S.sort = null;
    $$("[data-view]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$("[data-ck-sub]").forEach((x) => { x.hidden = x.dataset.ckSub !== S.view; });
    drawGrid();
  }));
  $$("[data-win]").forEach((b) => b.addEventListener("click", () => { S.win = b.dataset.win; $$("[data-win]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawGrid(); }));
  $$("[data-list]").forEach((b) => b.addEventListener("click", () => { S.list = b.dataset.list; S.sort = null; $$("[data-list]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawGrid(); }));
  $$("[data-v]").forEach((b) => b.addEventListener("click", () => { S.verdict = b.dataset.v; $$("[data-v]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawGrid(); }));
  $("[data-ck-pads]")?.addEventListener("click", (e) => { const b = e.target.closest("[data-pad]"); if (!b) return; S.pad = b.dataset.pad; $$("[data-pad]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawGrid(); });
  $("[data-ck-find]")?.addEventListener("input", (e) => { S.find = e.target.value; drawGrid(); });
  grid.addEventListener("click", (e) => {
    const s = e.target.closest("[data-sort]");
    if (s) { const k = s.dataset.sort; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = -1; } drawGrid(); return; }
    const c = e.target.closest("[data-check]");
    if (c) { e.preventDefault(); checkInline(c.dataset.check); }
  });
  loadBoard();
  setInterval(() => { if (!document.hidden) loadBoard(); }, 30_000);
}

/* leaderboards, recent checks and the record (below the board) */
const row = (r, extra = "") => {
  const name = r.symbol ? `$${esc(r.symbol)}` : short(r.address);
  const badge = r.score != null ? r.score : r.kind === "stock" ? "Stock" : r.kind === "major" ? "Major" : "–";
  return `<li class="ck-row">${icon(r)}<a href="/check/${esc(r.address)}"><b>${name}</b><small>${esc(r.label || "")}${r.reason ? ` · ${esc(r.reason)}` : ""}</small><small>${short(r.address)} · ${ago(r.at)} ago${extra}</small></a><span class="ck-badge" style="--c:${tone(r.tone)}">${esc(badge)}</span></li>`;
};
async function loadDash() {
  let d; try { d = await (await fetch("/api/check")).json(); } catch { return; }
  const fill = (k, rows, empty, extra) => { const el = $(`[data-board="${k}"]`); if (el) el.innerHTML = rows?.length ? rows.slice(0, 6).map((r) => row(r, extra ? extra(r) : "")).join("") : `<li class="ck-empty">${empty}</li>`; };
  fill("safest", d.safest, "No coin checked this week yet.");
  fill("flagged", d.flagged, "No coin checked this week yet.");
  fill("mostChecked", d.mostChecked, "No checks this week yet.", (r) => ` · ${r.checks} check${r.checks === 1 ? "" : "s"}`);
  fill("recent", d.recent, "No checks yet. Paste an address above.", (r) => (r.via && r.via !== "web" ? ` · via ${r.via === "x" ? "X" : r.via === "telegram" ? "Telegram" : r.via}` : ""));
  const tot = $("[data-ck-total]");
  if (tot) tot.textContent = `${Number(d.total || 0).toLocaleString("en-US")} checks recorded · ${Number(d.thisWeek || 0).toLocaleString("en-US")} in the last 7 days. ${d.note || ""}`;
  const wt = $("[data-ck-weights] tbody");
  if (wt && d.weights) {
    const names = { gate: "Troya Gate: simulated buy and test sell", ring: "Ring Radar: rigged launch pattern", devside: "Dev side wallets", holders: "Holders (The Assay)", market: "Liquidity and holders", heel: "Weak spot (Heel)", clash: "Same ticker on other contracts", age: "Token age", claims: "Website and X claims, checked on chain", powers: "Contract powers: mint, blacklist, pause, fees, upgrades" };
    wt.innerHTML = Object.entries(d.weights).map(([k, w]) => `<tr><td>${esc(names[k] || k)}</td><td>${w}</td></tr>`).join("");
  }
  const cl = $("[data-ck-caps]");
  if (cl && d.caps) {
    const why = { gateFail: "the Gate fails the test sell, the exact swap, the transfer tax or the fees", ringRed: "Ring Radar flags a rigged launch", noRoute: "no route to buy it", lpPulled: "the dev pulled liquidity", devsideFail: "the dev side holds most of it or is selling now", noSellRoute: "a buy works but no route sells it back", thinFail: "the pool is too thin for a 0.01 ETH buy", gateNotRead: "the Gate could not run", claimFalse: "the project claims liquidity locked, renounced, a tax, a supply or a burn that the chain contradicts", unread: "the Gate, Ring Radar, the dev side or The Assay is not read yet", flagged: "any part reads red or a reason shown is a warning", devSold: "the dev wallet, or the wallets linked to it, sold 80% or more", devSoldBoth: "both the dev wallet and its linked wallets sold 80% or more", washHigh: "half or more of all trades look like bots or wash trading", washVeryHigh: "70% or more of all trades look like bots or wash trading", powersMint: "an active owner can still mint more of it", powersTrap: "an active owner can blacklist wallets, pause transfers or switch trading off", powersUpgrade: "it is an upgradeable proxy with a live admin", powersFees: "an active owner can change fees or taxes (no hard maximum read)" };
    cl.innerHTML = Object.entries(d.caps).sort((a, b) => a[1] - b[1]).map(([k, v]) => `<li><b>${v}</b> when ${esc(why[k] || k)}</li>`).join("");
  }
}
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

/* =================================================================== one coin ================================================== */
const ICON = {
  share: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
};
const KIND = { works: ["Works", "var(--t-good)"], risk: ["Risk", "var(--t-bad)"], missing: ["Missing", "var(--t-warn)"], info: ["Info", "var(--t-grey)"] };
const linkA = (l) => { const h = okHref(l?.href); return h ? `<a href="${esc(h)}"${/^https:/.test(h) ? ' target="_blank" rel="noopener nofollow"' : ""}>${esc(l.label)}</a>` : ""; };
function gauge(name, v, word, ticks, line) {
  const c = tone(subTone(v));
  return `<div class="cv-g" style="--v:${v ?? 0}%;--c:${c}"><div class="cv-g-top"><span>${name}</span><b>${v ?? "–"}<small>/100</small></b></div>
    <b class="cv-g-word">${esc(v == null ? "Not read" : word)}</b><div class="cv-g-track"${v == null ? ' data-empty=""' : ""}><i></i></div><div class="cv-g-ticks">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>${line ? `<p>${esc(line)}</p>` : ""}</div>`;
}
function partHtml(p) {
  const chip = p.status === "scored" ? (p.weight > 0 ? `${Math.round(p.points ?? p.weight * p.value)} of ${p.weight}` : "info") : p.status === "n/a" ? "n/a" : "not read";
  const ev = (p.evidence || []).slice(0, 6).map((e) => `<li>${e.label ? `<b>${esc(e.label)}:</b> ` : ""}${esc(e.text)}</li>`).join("");
  const lk = (p.links || []).map(linkA).join("");
  return `<li class="ck-part"><h3>${esc(p.name)}<small>weight ${p.weight}</small></h3><div><p>${esc(p.summary)}</p>${ev ? `<ul>${ev}</ul>` : ""}${lk ? `<div class="lk">${lk}</div>` : ""}</div><span class="ck-chip" style="--c:${p.status === "scored" ? tone(p.tone) : "var(--t-grey)"}">${chip}</span></li>`;
}
const sentence = (s) => { const t = String(s || "").trim(); return t ? t.replace(/^./, (c) => c.toUpperCase()).replace(/[^.!?]$/, (c) => `${c}.`) : ""; };
function showCoin(r) {
  coinBox.hidden = false;
  const name = r.symbol ? `$${r.symbol}` : short(r.address);
  document.title = r.score != null ? `${name}: ${r.label}, ${r.score}/100 · Troya Check` : `${name}: ${r.label} · Troya Check`;
  const page = `https://troya.codes/check/${r.address}`;
  const k = r.coin || {};
  const capped = (r.caps || [])[0];
  const xText = r.score != null ? `${xCash(r)} on Troya Check: ${r.label.toLowerCase()} (${r.score}/100).` : `${name} on Troya Check: ${r.label}.`;
  const since = r.sinceFirstCheck?.change != null && r.history?.length > 1 ? `${pct(r.sinceFirstCheck.change)} <small>since first check ${ago(r.sinceFirstCheck.at)} ago</small>` : "";
  const f = r.findings || [];
  const count = (kd) => f.filter((x) => x.kind === kd).length;
  const findings = f.map((x) => `<li style="--c:${KIND[x.kind][1]}"><span class="fk">${KIND[x.kind][0]}</span><div><b>${esc(x.title)}</b><p>${esc(x.text)}</p>${x.links?.length ? `<div class="lk">${x.links.map(linkA).join("")}</div>` : ""}</div></li>`).join("");
  const sub = r.sub || {};
  const facts = [
    ["Contract", `<code>${short(r.address)}</code> <button type="button" class="cv-copy" data-copy="${esc(r.address)}" aria-label="Copy the contract address">${ICON.copy}</button>`],
    k.dev ? ["Dev wallet", `<a href="https://robinhoodchain.blockscout.com/address/${esc(k.dev)}" target="_blank" rel="noopener"><code>${short(k.dev)}</code></a>`] : null,
    r.devRecord ? ["Dev record", r.devRecord.checked ? `${r.devRecord.checked} other coin${r.devRecord.checked === 1 ? "" : "s"} checked, ${r.devRecord.good} scored 50+` : "No other coin of this dev checked yet"] : null,
    r.creator ? ["Creator fee", creatorFeeRow(r.creator)] : null,
    r.creator?.deployerCoins ? ["Deployer's launches", r.creator.deployerCoins.count <= 1 ? "This is the deployer's only Pons coin" : `${r.creator.deployerCoins.count} Pons coins, ${r.creator.deployerCoins.count - 1} besides this one`] : null,
    ["Launched", [k.launchpad ? esc(padName(k.launchpad)) : null, k.bornAt ? `${ago(k.bornAt)} ago` : null].filter(Boolean).join(" · ") || "–"],
    ["Links", [k.website && okHref(k.website) ? `<a href="${esc(k.website)}" target="_blank" rel="noopener nofollow">Site</a>` : "", k.x ? `<a href="${esc(/^https:/.test(k.x) ? k.x : `https://x.com/${String(k.x).replace(/^@/, "")}`)}" target="_blank" rel="noopener nofollow">X</a>` : "",
      `<a href="https://dexscreener.com/robinhood/${esc(r.address.toLowerCase())}" target="_blank" rel="noopener">DexScreener</a>`, `<a href="https://robinhoodchain.blockscout.com/token/${esc(r.address)}" target="_blank" rel="noopener">Blockscout</a>`].filter(Boolean).join(" ")],
  ].filter(Boolean);
  const hist = (r.history || []).map((h) => `<li><b class="sc sm" style="--c:${tone(h.tone)}">${h.score ?? "–"}</b><span>${esc(h.label || "")}</span><small>${ago(h.at)} ago${h.via && h.via !== "web" ? ` · ${h.via === "x" ? "X" : h.via === "telegram" ? "Telegram" : esc(h.via)}` : ""}</small></li>`).join("");
  const scored = r.score != null;
  coinBox.innerHTML = `
  <div class="cv">
    <div class="cv-bar">
      <div class="cv-id">${icon(r, "ck-ico lg")}<div><h1>${esc(name)}</h1>${r.name && r.name !== r.symbol ? `<span>${esc(r.name)}</span>` : ""}</div></div>
      <div class="cv-mkt">${k.mcapUsd != null ? `<span><small>MC</small> ${usd(k.mcapUsd)}</span>` : ""}${spark(r.spark, 110, 30)}${since ? `<span class="cv-since">${since}</span>` : ""}</div>
      <div class="cv-acts">
        <button type="button" class="cv-ca" data-copy="${esc(r.address)}" title="Copy the contract address"><small>CA</small> <code>${short(r.address)}</code>${ICON.copy}</button>
        <button class="ck-btn" type="button" data-share>${ICON.share}Share</button>
        <a class="ck-btn" href="https://x.com/intent/post?text=${encodeURIComponent(xText)}&url=${encodeURIComponent(page)}" target="_blank" rel="noopener">${ICON.x}Post</a>
        ${r.gatePassed ? `<a class="ck-btn solid" href="/agent#/swap?out=${esc(r.address)}" title="Swap runs Troya Gate again on the pool before you sign">Buy ${esc(name)}</a>` : ""}
      </div>
    </div>
    <div class="cv-grid">
      <div class="cv-main">
        <article class="cv-verdict" style="--tone:${tone(r.tone)}">
          <p class="cv-kick">Troya Check · checked ${ago(r.checkedAt)} ago${r.partial ? " · some parts still reading" : ""}</p>
          <h2 class="cv-sentence">${esc(sentence(r.headline || r.label))}</h2>
          <div class="cv-scores${scored ? "" : " one"}">
            <div class="cv-total"><span>Total score</span><b style="color:${tone(r.tone)}">${scored ? r.score : "–"}<small>${scored ? "/100" : ""}</small></b><span class="lbl" style="--c:${tone(r.tone)}">${esc(r.label)}</span><p>${scored ? "Weighted from every part read, then capped by the most serious finding." : esc(r.headline || "")}</p>${scored && r.basis ? basisLine(r) : ""}${r.dispute ? disputeLine(r.dispute) : ""}</div>
            ${scored ? gauge("Exit", sub.exit, sub.exitWord ? sub.exitWord[0].toUpperCase() + sub.exitWord.slice(1) : "", ["blocked", "risky", "clear"], sub.exitLine) + gauge("Holders", sub.holders, sub.holdersWord ? sub.holdersWord[0].toUpperCase() + sub.holdersWord.slice(1) : "", ["rigged", "concentrated", "spread"], sub.holdersLine) : ""}
          </div>
          ${capped && scored ? `<p class="cv-cap">Capped at ${capped.at}: ${esc(capped.why)}.</p>` : ""}
        </article>
        ${f.length ? `<section class="cv-find"><div class="cv-find-h"><h3>Findings <small>${f.length}</small></h3><span class="cv-counts">${["risk", "missing", "works", "info"].filter(count).map((kd) => `<i style="--c:${KIND[kd][1]}"></i>${KIND[kd][0]} ${count(kd)}`).join("")}</span></div><ul class="cv-flist">${findings}</ul></section>` : ""}
        ${r.changes?.length ? `<p class="cv-change"><b>What would change this</b>${esc(sentence(r.changes.length > 1 ? `${r.changes.slice(0, -1).join(", ")} or ${r.changes.at(-1)}` : r.changes[0]))}</p>` : ""}
        ${(r.parts || []).length ? `<details class="cv-parts"><summary>Every part, its weight and its evidence</summary><ul class="ck-parts">${r.parts.map(partHtml).join("")}</ul></details>` : ""}
        <p class="ck-note">Automated checks, not an audit. A snapshot from the chain at the time above; a coin can change after a check. Never a safe stamp and never advice to buy.</p>
      </div>
      <aside class="cv-side">
        <div class="ck-card2 cv-chart">${spark(r.spark, 320, 96) || '<p class="ck-empty">No price history on the board yet.</p>'}
          <dl><dt>Market cap</dt><dd>${usd(k.mcapUsd)}</dd><dt>Since first check</dt><dd>${r.sinceFirstCheck?.change != null ? pct(r.sinceFirstCheck.change) : "–"}</dd><dt>Volume 24h</dt><dd>${usd(k.volume24hUsd)}</dd><dt>Liquidity</dt><dd>${usd(k.liquidityUsd)}</dd></dl></div>
        <div class="ck-card2"><table class="cv-facts">${facts.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join("")}</table>
          ${r.devRecord?.coins?.length ? `<ul class="cv-devcoins">${r.devRecord.coins.map((c) => `<li><a href="/check/${esc(c.address)}">${c.symbol ? `$${esc(c.symbol)}` : short(c.address)}</a><b class="sc sm" style="--c:${tone(c.tone)}">${c.score}</b></li>`).join("")}</ul>` : ""}</div>
        ${r.kind === "coin" ? watchCard(r) : ""}
        ${r.creator?.deployerCoins?.others?.length ? `<div class="ck-card2"><h3>The deployer's other coins</h3><ul class="cv-devcoins">${r.creator.deployerCoins.others.map((c) => `<li><a href="/check/${esc(c.address)}">${short(c.address)}</a><span class="cv-dc-at">${ago(c.at)} ago</span><b class="cv-dc-v">${c.launchVerdict === "blocked" ? "Gate blocked at launch" : c.launchVerdict === "notes" ? "Gate passed with notes" : c.launchVerdict === "passed" ? "Gate passed at launch" : "not checked at launch"}</b></li>`).join("")}</ul></div>` : ""}
        <div class="ck-card2"><h3>Every check of this coin</h3>${hist ? `<ol class="cv-hist">${hist}</ol>` : '<p class="ck-empty">This is the first.</p>'}</div>
      </aside>
    </div>
  </div>`;
  coinBox.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async (e) => { const v = e.currentTarget.dataset.copy; try { await navigator.clipboard.writeText(v); toast("Address copied", "ok"); } catch { toast(v); } }));
  coinBox.querySelector("[data-share]")?.addEventListener("click", async () => {
    if (navigator.share) { try { await navigator.share({ title: document.title, url: page }); return; } catch (e) { if (e?.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(page); toast("Link copied", "ok"); } catch { toast(page); }
  });
}
function showPending(secs = 0, slow = false) {
  coinBox.hidden = false;
  const msg = slow
    ? `Still reading after ${secs} seconds: some of Troya's reads on this coin are slow right now. They keep running on the server; check again in a minute and the answer will be there.`
    : `Reading now${secs ? ` (${secs} s)` : ""}: Troya Gate runs a simulated buy and a test sell, then Ring Radar, the dev side, The Assay and Heel. The verdict shows once every part is in, usually within half a minute.`;
  coinBox.innerHTML = `<div class="cv"><div class="cv-bar"><div class="cv-id">${icon({ address: ADDR }, "ck-ico lg")}<div><h1>${short(ADDR)}</h1><span><code>${esc(ADDR)}</code></span></div></div></div>
    <article class="cv-verdict" style="--tone:var(--t-grey)"><p class="ck-pending">${slow ? "" : "<i></i>"}${esc(msg)}</p>${slow ? '<p><button class="ck-mini" type="button" data-again>Check again</button></p>' : ""}</article></div>`;
  coinBox.querySelector("[data-again]")?.addEventListener("click", () => poll());
}
// The server answers { pending: true } while it reads a coin; the page asks again every 4 s, for about a minute, and renders
// only once there is a verdict (or the coin is a stock, a major or not a token). It never shows "not enough read" as a verdict.
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
      if (d && !d.pending && !d.stillReading && (d.kind !== "coin" || d.score != null)) { showCoin(d); if (d.partial) setTimeout(() => refresh(), 62_000); return; }
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

/* =================================================================== start ===================================================== */
// the paste box: an address opens its page; a $TICKER is resolved (one contract, or "N contracts share it")
$("[data-ck-form]")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = String($("#ck-in").value || "").trim();
  const a = (/0x[0-9a-fA-F]{40}/.exec(v) || [])[0];
  if (a) { location.href = `/check/${a}`; return; }
  const t = v.replace(/^\$/, "");
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(t)) { toast("Paste a contract address (0x…) or a ticker like $TROYA."); return; }
  try {
    const d = await (await fetch(`/api/check/resolve?q=${encodeURIComponent(t)}`)).json();
    if (d.address) { location.href = `/check/${d.address}`; return; }
    if (d.many) { toast(`${d.many} contracts use $${t}. Paste the address you mean${d.oldest ? "; opening the oldest" : ""}.`); if (d.oldest) setTimeout(() => { location.href = `/check/${d.oldest}`; }, 1600); return; }
    toast(`No coin called $${t} found on Robinhood Chain.`);
  } catch { toast("Could not look that up just now."); }
});
if (ADDR) {
  // one coin: the board and the lists step aside; the method stays below
  for (const s of ["[data-ck-hero]", "[data-ck-dashwrap]", "[data-ck-dash]", "[data-ck-rec]"]) { const el = $(s); if (el) el.hidden = true; }
  document.body.classList.add("ck-coinpage");
  loadDash();   // fills the weights and caps in "How the score works"
  let first = null;
  try { first = JSON.parse($("#check-data")?.textContent || "null"); } catch { first = null; }
  if (first?.result && (first.result.kind !== "coin" || first.result.score != null)) { showCoin(first.result); if (first.result.partial) setTimeout(() => refresh(), 62_000); }
  else poll();
} else {
  wireBoard();
  loadDash();
  loadRecord();
}
