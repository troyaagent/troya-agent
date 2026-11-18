// Safety page (/safety): the live "still building" numbers from /api/status/alive. Plain DOM, no framework.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
  const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
  async function load() {
    let d;
    try { d = await (await fetch("/api/status/alive", { cache: "no-store" })).json(); } catch { return; }
    const tile = (k, v, sub = "") => `<div class="rec-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const last = d.code?.commits?.[0];
    $("[data-alive-stats]").innerHTML = [
      tile("Last change to the code", last ? ago(last.at) : "–", last ? "in the public repository" : "the repository could not be read just now"),
      tile("Changes this week", d.code?.thisWeek != null ? `${d.code.thisWeek}${d.code.capped ? "+" : ""}` : "–", "commits in the last 7 days"),
      tile("Roadmap", esc(d.roadmap?.now || "V6 Hermes live"), `next: ${esc(d.roadmap?.next || "V7 Athena")}, ${esc(d.roadmap?.named || "V7 to V14")} named`),
      tile("Coins born through Troya", d.launches ? big(d.launches.born) : "–", "launched from X, Telegram or troya.codes"),
      tile("$TROYA burned", d.burn ? big(d.burn.total) : "–", d.burn ? `${d.burn.pctOfMinted.toFixed(2)}% of all minted, ${d.burn.burns} burns on chain` : "read from the chain"),
      tile("Last Sentry post", d.sentry?.at ? ago(d.sentry.at) : "–", d.sentry?.symbol ? `$${esc(d.sentry.symbol)}, graded on The Record` : "graded on The Record"),
    ].join("");
    const list = d.code?.commits || [];
    $("[data-alive-commits]").innerHTML = list.length
      ? `<ul class="alive-list">${list.map((c) => `<li><a class="ulink" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a><span>${ago(c.at)}</span></li>`).join("")}</ul><p style="margin-top:12px"><a class="ulink" href="${esc(d.code.repo)}/commits/main" target="_blank" rel="noopener">Every change, newest first</a></p>`
      : '<p>The public repository could not be read just now. <a class="ulink" href="https://github.com/troyaagent/troya-agent/commits/main" target="_blank" rel="noopener">Open it on GitHub</a>.</p>';
  }
  load();
  setInterval(load, 5 * 60_000);
})();
