// /badge: make a live Troya Gate badge for a Robinhood Chain coin, show the result it is based on, and the embed code.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// the shared Gate words (public/agent/js/verdict.js LABEL), as the badge image and Swap read them
const WORD = { passed: "Passed", caution: "Passed with notes", failed: "Blocked", untested: "Not testable yet", error: "Unavailable" };
const form = $("[data-badge-form]"), input = $("[data-badge-ca]"), out = $("[data-badge-out]");
async function copyText(t, b) { try { await navigator.clipboard.writeText(t); b.textContent = "COPIED"; setTimeout(() => (b.textContent = "COPY"), 1400); } catch { b.textContent = "SELECT"; } }
async function show(ca) {
  out.hidden = false;
  const img = $("[data-badge-img]"), grid = out.querySelector(".code-grid");
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
    // never leave the previous coin's badge, checks or embed code on screen next to this message
    img.hidden = true; img.removeAttribute("src");
    $("[data-badge-checks]").innerHTML = "";
    $("[data-code-html]").textContent = ""; $("[data-code-md]").textContent = "";
    grid.hidden = true;
    $("[data-badge-status]").textContent = "That is not a token address. Paste a 0x… contract of 42 characters.";
    return;
  }
  const svg = `https://troya.codes/api/badge/${ca}.svg`, page = `https://troya.codes/badge?ca=${ca}`;
  img.hidden = false; grid.hidden = false;
  img.src = `/api/badge/${ca}.svg?t=${Date.now()}`;
  $("[data-badge-status]").textContent = "Running Troya Gate…";
  $("[data-badge-checks]").innerHTML = "";
  const html = `<a href="${page}"><img src="${svg}" alt="Troya Gate result" height="44"></a>`;
  const md = `[![Troya Gate result](${svg})](${page})`;
  $("[data-code-html]").textContent = html; $("[data-code-md]").textContent = md;
  $("[data-copy-html]").onclick = (e) => copyText(html, e.currentTarget);
  $("[data-copy-md]").onclick = (e) => copyText(md, e.currentTarget);
  history.replaceState(null, "", `/badge?ca=${ca}`);
  try {
    const r = await fetch(`/api/badge/${ca}`).then((x) => x.json());
    const when = r.checkedAt ? new Date(r.checkedAt).toISOString().slice(11, 16) + " UTC" : "";
    $("[data-badge-status]").innerHTML = `<b style="color:var(--fg)">${esc(WORD[r.verdict] || "Unavailable")}</b>${r.symbol ? ` · $${esc(r.symbol)}` : ""}${when ? ` · checked ${when}` : ""}${r.curve ? ` · curve ${Number(r.curve.raised).toFixed(3)} ${esc(r.curve.pair)} raised` : ""}`;
    $("[data-badge-checks]").innerHTML = (r.checks || []).map((c) => `<li style="display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0;font-size:14px"><span style="color:var(--muted)">${esc(c.label)}</span><span style="text-align:right;color:${c.status === "pass" ? "#5fd38d" : c.status === "fail" ? "#f0606d" : "#f2c26b"}">${esc(c.detail)}</span></li>`).join("");
  } catch { $("[data-badge-status]").textContent = "Could not reach the Gate. Try again in a minute."; }
}
form.addEventListener("submit", (e) => { e.preventDefault(); show(input.value.trim()); });
const q = new URLSearchParams(location.search).get("ca");
if (q) { input.value = q; show(q); }
