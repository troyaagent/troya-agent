// The Record page (/record): reads /api/record and draws the score and every call. Plain DOM, no framework.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const price = (p) => {
    if (p == null) return "–";
    if (p >= 1) return "$" + p.toFixed(2);
    const z = Math.max(0, -Math.floor(Math.log10(p)) - 1);
    return z >= 4 ? `$0.0<sub>${z}</sub>${Math.round(p * 10 ** (z + 3))}` : "$" + p.toPrecision(3);
  };
  const ch = (x) => (x == null ? '<span class="rec-na">–</span>' : `<span class="${x >= 0 ? "rec-up" : "rec-dn"}">${x >= 0 ? "+" : ""}${Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1)}%</span>`);
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`; };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  function stats(s) {
    const tile = (k, v, sub = "") => `<div class="rec-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
    $("[data-rec-stats]").innerHTML = [
      tile("Calls recorded", s.calls.toLocaleString("en-US"), `${s.watching} still inside their first day`),
      tile("Graded", s.graded.toLocaleString("en-US"), `${s.wins} wins · ${s.graded - s.wins} misses`),
      tile("Win rate, 24 h", pct(s.winRate), "higher 24 hours after the call"),
      tile("Median at 24 h", s.median24h == null ? "–" : `${s.median24h >= 0 ? "+" : ""}${s.median24h.toFixed(1)}%`, "half did better, half worse"),
      tile("Median peak", s.medianPeakX == null ? "–" : `${s.medianPeakX.toFixed(2)}×`, "highest price in the first day"),
      tile("Reached 2×", s.reachedOf ? `${s.reached2x} of ${s.reachedOf}` : "–", "at some point in the first day"),
    ].join("");
  }

  function rows(calls) {
    if (!calls.length) { $("[data-rec-rows]").innerHTML = '<tr><td colspan="7" class="rec-empty">No calls recorded yet. The first Sentry post starts the ledger.</td></tr>'; return; }
    $("[data-rec-rows]").innerHTML = calls.map((c) => {
      const res = c.result === "win" ? '<b class="rec-win">Win</b>' : c.result === "miss" ? '<b class="rec-miss">Miss</b>'
        : c.status === "watching" ? `<span class="rec-watch">Watching${c.changeNow != null ? " · " + ch(c.changeNow) : ""}</span>` : '<span class="rec-na">No price</span>';
      const sym = c.symbol ? "$" + esc(c.symbol) : short(c.token);
      const via = c.via && c.via.startsWith("candles") ? ' <em class="rec-via">candles</em>' : "";
      return `<tr>
        <td><a class="rec-coin" href="/agent#/gate/${esc(c.token)}">${sym}</a>${c.post ? ` <a class="rec-post" href="${esc(c.post)}" target="_blank" rel="noopener">post</a>` : ""}${c.source ? `<small>${esc(c.source)}</small>` : ""}</td>
        <td>${ago(c.at)}</td><td>${price(c.priceAtCall)}${via}</td><td>${ch(c.change1h)}</td><td>${ch(c.change24h)}</td>
        <td>${c.peakX == null ? '<span class="rec-na">–</span>' : `${c.peakX.toFixed(2)}×`}</td><td>${res}${c.late ? ' <em class="rec-via">late</em>' : ""}</td></tr>`;
    }).join("");
  }

  async function load() {
    try {
      const d = await (await fetch("/api/record?limit=300", { cache: "no-store" })).json();
      $("[data-rec-rules]").textContent = d.rules;
      stats(d.stats); rows(d.calls);
    } catch {
      $("[data-rec-rules]").textContent = "The ledger could not be read right now. Try again in a minute.";
    }
  }
  load();
  setInterval(load, 60_000);

  /* F21 · the chart oracle */
  const LEAN = { up: "Leaning up", down: "Leaning down", sideways: "Sideways" };
  const num = (p) => (p == null ? "–" : p >= 100 ? "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 }) : price(p));
  const coinHref = (n) => (n.kind === "hl" ? `/agent#/perps/${esc(n.id)}` : `/agent#/token/${esc(n.id)}`);
  function oracleNow(notes) {
    const seen = new Set(), now = [];
    for (const n of notes) if (!seen.has(n.id)) { seen.add(n.id); now.push(n); }
    $("[data-orc-now]").innerHTML = now.length ? now.map((n) => {
      const span = n.resistance - n.support, pos = span > 0 ? Math.max(0, Math.min(1, (n.price - n.support) / span)) : 0.5;
      return `<article class="orc-card orc-${n.call}">
        <header><a class="rec-coin" href="${coinHref(n)}">${n.kind === "rh" ? "$" : ""}${esc(n.symbol)}</a><b class="orc-lean">${LEAN[n.call] || esc(n.call)}</b></header>
        <p class="orc-text">${n.call === "up" ? `Leaning up toward ${num(n.resistance)}, support at ${num(n.support)}.` : n.call === "down" ? `Leaning down toward ${num(n.support)}, resistance at ${num(n.resistance)}.` : `Sideways between ${num(n.support)} and ${num(n.resistance)} more likely than a break.`}</p>
        <div class="orc-range" aria-label="Price inside its two-day range"><i style="left:${(pos * 100).toFixed(1)}%"></i></div>
        <div class="orc-ends"><span>${num(n.support)}</span><span>${num(n.price)} now</span><span>${num(n.resistance)}</span></div>
        <ul class="orc-why">${n.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
        <small class="orc-at">Written ${ago(n.at)} · graded ${n.status === "graded" ? "already" : "in " + Math.max(0, Math.round((n.at + 864e5 - Date.now()) / 36e5)) + " h"}</small>
      </article>`;
    }).join("") : '<p class="rec-empty">The first notes are written a minute after the server starts.</p>';
  }
  function oracleStats(s) {
    const tile = (k, v, sub = "") => `<div class="rec-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const rate = (o) => (o.graded ? `${Math.round((o.wins / o.graded) * 100)}%` : "–");
    $("[data-orc-stats]").innerHTML = [
      tile("Notes written", s.notes.toLocaleString("en-US"), `${s.open} still inside their 24 hours`),
      tile("Graded", s.graded.toLocaleString("en-US"), `${s.wins} right · ${s.graded - s.wins} wrong`),
      tile("Right, all leans", s.winRate == null ? "–" : `${Math.round(s.winRate * 100)}%`, "graded against the price 24 h later"),
      tile("Leaning up", rate(s.up), `${s.up.graded} graded`),
      tile("Leaning down", rate(s.down), `${s.down.graded} graded`),
      tile("Sideways", rate(s.sideways), `${s.sideways.graded} graded`),
    ].join("");
  }
  function oracleRows(notes) {
    const g = notes.filter((n) => n.status === "graded");
    if (!g.length) { $("[data-orc-rows]").innerHTML = '<tr><td colspan="7" class="rec-empty">No note is a day old yet. The first grades land 24 hours after the first notes.</td></tr>'; return; }
    $("[data-orc-rows]").innerHTML = g.map((n) => `<tr>
      <td><a class="rec-coin" href="${coinHref(n)}">${n.kind === "rh" ? "$" : ""}${esc(n.symbol)}</a></td>
      <td>${ago(n.at)}</td><td><span class="orc-tag orc-${n.call}">${LEAN[n.call] || esc(n.call)}</span></td>
      <td>${num(n.price)}</td><td>${num(n.support)} – ${num(n.resistance)}</td><td>${ch(n.move)}</td>
      <td>${n.result === "win" ? '<b class="rec-win">Right</b>' : '<b class="rec-miss">Wrong</b>'}</td></tr>`).join("");
  }
  async function loadOracle() {
    try {
      const d = await (await fetch("/api/oracle?limit=300", { cache: "no-store" })).json();
      $("[data-orc-rules]").textContent = d.rules;
      oracleNow(d.notes); oracleStats(d.stats); oracleRows(d.notes);
    } catch {
      $("[data-orc-rules]").textContent = "The chart notes could not be read right now. Try again in a minute.";
    }
  }
  if ($("[data-orc-now]")) { loadOracle(); setInterval(loadOracle, 120_000); }
})();
