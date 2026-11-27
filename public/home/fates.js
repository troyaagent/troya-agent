// The Record page, V9 F52 Two Fates part 1: passed vs blocked launches, graded on the same clock (/api/fates).
// Plain DOM. Both columns are shown whatever they say, as promised in the group (Xivor's spec, 25 Nov 2026).
(() => {
  const $ = (s) => document.querySelector(s);
  const box = $("[data-fates]");
  if (!box) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1)}%`);
  const share = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const RES = { up: '<b class="rec-win">Up</b>', down: '<b class="rec-miss">Down</b>', zero: '<b class="rec-miss">Went to zero</b>', "not-sellable": '<b class="rec-miss">Not sellable</b>' };

  function col(name, s, note) {
    const row = (k, v) => `<div class="fx-r"><span>${k}</span><b>${v}</b></div>`;
    return `<div class="rec-tile fx-col"><span>${name}</span>
      ${row("Checked", s.checked.toLocaleString("en-US"))}
      ${row("Graded at 24 h", `${s.graded.toLocaleString("en-US")}${s.watching ? ` <small>(${s.watching} watching)</small>` : ""}`)}
      ${row("Median at 24 h", s.graded ? pct(s.median24h) : "–")}
      ${row("Went to zero", s.graded ? `${s.wentToZero}${s.notSellable ? ` + ${s.notSellable} not sellable` : ""} <small>(${share(s.zeroShare)})</small>` : "–")}
      ${row("Higher after a day", s.graded ? `${s.up24h} of ${s.graded}` : "–")}
      <small>${note}</small></div>`;
  }

  // one 2x2 table per horizon (holder review idea A, 27 Nov 2026): passed or blocked at the check, against went bad or still
  // tradable, with the base rate, so "block everything" cannot look accurate by itself
  function table(name, t) {
    if (!t || !t.graded) return `<div class="rec-tile fx-t"><span>${name}</span><p class="rec-empty" style="margin:8px 0 0">Not graded yet${name === "7 days" ? ": the first 7 day grades land from 2 Dec 2026" : name === "30 days" ? ": the first 30 day grades land from 25 Dec 2026" : ""}.</p></div>`;
    const c = (n) => n.toLocaleString("en-US");
    return `<div class="rec-tile fx-t"><span>${name} <small>(${c(t.graded)} graded)</small></span>
      <table class="rec-tbl fx-2x2"><thead><tr><th></th><th>Went bad</th><th>Still tradable</th></tr></thead><tbody>
      <tr><th>Troya passed it</th><td class="rec-miss">${c(t.passed.wentBad)} <small>missed</small></td><td class="rec-win">${c(t.passed.stillTradable)} <small>right</small></td></tr>
      <tr><th>Troya blocked it</th><td class="rec-win">${c(t.blocked.wentBad)} <small>right</small></td><td class="rec-miss">${c(t.blocked.stillTradable)} <small>false alarm</small></td></tr>
      </tbody></table>
      <small>Base rate: ${share(t.baseRate)} of all graded coins went bad · passed and went bad: ${share(t.passedWentBad)} · blocked but still tradable: ${share(t.blockedStillTradable)}</small></div>`;
  }
  function csv(list) {
    const head = ["token", "symbol", "list", "checked_utc", "price_at_check", "change_1h", "change_24h", "result_24h", "change_7d", "went_bad_7d", "sellable_7d", "change_30d", "went_bad_30d", "sellable_30d"];
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = list.map((c) => [c.token, c.symbol, c.cohort, new Date(c.at).toISOString(), c.priceAtCheck, c.change1h, c.change24h, c.result, c.change7d, c.bad7d, c.sellable7d, c.change30d, c.bad30d, c.sellable30d].map(q).join(","));
    return [head.join(","), ...rows].join("\n");
  }
  async function download(e) {
    e.preventDefault();
    try {
      const d = await fetch("/api/fates?limit=3000").then((r) => r.json());
      const url = URL.createObjectURL(new Blob([csv(d.recent || [])], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = `troya-two-fates-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { alert("Could not build the CSV right now."); }
  }

  async function load() {
    let d;
    try { d = await fetch("/api/fates?limit=60").then((r) => r.json()); } catch { box.innerHTML = '<p class="rec-empty">Could not load the two lists right now.</p>'; return; }
    const first = d.since ? new Date(d.since + 86400e3).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
    const graded = d.passed.graded + d.blocked.graded;
    box.innerHTML = `
      ${graded ? "" : `<p class="lead fx-wait">Collecting since ${esc(new Date(d.since).toISOString().slice(0, 10))}. The first coins are graded 24 hours after their check${first ? `, from about ${esc(first)}` : ""}.</p>`}
      <div class="rec-stats fx-cols">
        ${col("Passed the Gate", d.passed, "passed, or passed with notes")}
        ${col("Blocked by the Gate", d.blocked, "blocked for a safety reason; route-only blocks left out")}
      </div>
      <h3 class="fx-h3">Did the Gate get it right? One table per horizon</h3>
      <div class="rec-stats fx-cols fx-3">${table("24 hours", d.tables?.["24h"])}${table("7 days", d.tables?.["7d"])}${table("30 days", d.tables?.["30d"])}</div>
      ${d.wentBadRule ? `<p class="rec-note"><b>Went bad, rule ${esc(d.wentBadRule.version)}</b> (set ${esc(d.wentBadRule.setAt)}, before the first 7 day grade): ${esc(d.wentBadRule.text)}</p>` : ""}
      <div class="rec-wrap"><table class="rec-tbl rec-calls"><thead><tr><th>Coin</th><th>List</th><th>Checked</th><th>1 h</th><th>24 h</th><th>7 d</th><th>Result</th></tr></thead><tbody>
      ${(d.recent || []).filter((c) => c.status !== "no-price").slice(0, 40).map((c) => `<tr>
        <td><a class="rec-coin" href="/agent#/gate/${esc(c.token)}">${c.symbol ? "$" + esc(c.symbol) : short(c.token)}</a>${c.symbol ? ` <code class="rec-ca" title="${esc(c.token)}" style="font-size:11px;opacity:.65">${esc(c.token.slice(0, 6))}…${esc(c.token.slice(-4))}</code>` : ""}${c.reason ? `<small title="${esc(c.reason)}">${esc(c.reason.split(":")[0])}</small>` : ""}</td>
        <td>${c.cohort === "passed" ? "Passed" : "Blocked"}</td><td>${ago(c.at)}</td>
        <td>${c.change1h == null ? '<span class="rec-na">–</span>' : pct(c.change1h)}</td>
        <td>${c.change24h == null ? '<span class="rec-na">–</span>' : pct(c.change24h)}</td>
        <td>${c.bad7d == null ? '<span class="rec-na">–</span>' : `${c.change7d == null ? "" : pct(c.change7d) + " "}${c.bad7d ? `<b class="rec-miss" title="${esc(c.why7d || "")}">bad</b>` : '<b class="rec-win">tradable</b>'}`}</td>
        <td>${c.result ? RES[c.result] || esc(c.result) : c.notSellable ? '<span class="rec-watch">Watching · could not be sold</span>' : '<span class="rec-watch">Watching</span>'}</td></tr>`).join("") || '<tr><td colspan="7" class="rec-empty">No launches checked yet.</td></tr>'}
      </tbody></table></div>
      <p class="rec-note">${esc(d.rules)} Raw data: <a class="ulink" href="/api/fates?limit=3000" target="_blank" rel="noopener">JSON</a> · <a class="ulink" href="#" data-fates-csv>CSV</a>.</p>`;
    box.querySelector("[data-fates-csv]")?.addEventListener("click", download);
  }
  load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
})();
