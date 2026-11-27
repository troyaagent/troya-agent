// The Start here page (holder review idea H, 27 Nov 2026): the glossary drawn from the in-app Guide's own list
// (public/agent/desk/guide.js, between the GLOSSARY markers), so this page, the Guide and the bots never drift apart.
(() => {
  const box = document.querySelector("[data-st-gl]"), q = document.querySelector("[data-st-q]");
  if (!box) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const link = (p) => (String(p || "").startsWith("/") ? p : `/agent#/${p}`);
  let list = [];
  const draw = () => {
    const t = String(q?.value || "").trim().toLowerCase();
    const rows = list.filter((g) => !t || [g.name, ...(g.aka || []), g.what, g.where].join(" ").toLowerCase().includes(t));
    box.innerHTML = rows.length ? rows.map((g) => `<article class="st-item"><h3><a class="ulink" href="${esc(link(g.page))}">${esc(g.name)}</a>${g.aka?.length ? ` <small>${esc(g.aka.join(", "))}</small>` : ""}</h3>
      <p>${esc(g.what)}</p><p class="st-meta"><span>Where: ${esc(g.where)}</span><span class="${/^No\b/.test(g.money || "") ? "st-safe" : "st-money"}">Moves money: ${esc(g.money)}</span></p></article>`).join("")
      : '<p class="st-note">No name matches that search.</p>';
  };
  fetch("/agent/desk/guide.js").then((r) => r.text()).then((s) => {
    const a = s.indexOf("/* GLOSSARY:BEGIN */"), b = s.indexOf("/* GLOSSARY:END */");
    let j = s.slice(a + 20, b).trim().replace(/;\s*$/, "");
    j = j.slice(j.indexOf("["));
    list = JSON.parse(j).sort((x, y) => x.name.localeCompare(y.name));
    draw();
  }).catch(() => { box.innerHTML = '<p class="st-note">The glossary could not load right now. The same list is in the app: <a class="ulink" href="/agent#/guide">Guide</a>.</p>'; });
  q?.addEventListener("input", draw);
})();
