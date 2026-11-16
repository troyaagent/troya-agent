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
})();
