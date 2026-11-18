// The Buy $TROYA menu in the site header: open/close, keyboard, outside click, copy the full contract address.
(() => {
  const root = document.querySelector("[data-bb]");
  if (!root) return;
  const btn = root.querySelector("[data-bb-btn]"), menu = root.querySelector("[data-bb-menu]");
  const ca = (window.SITE && window.SITE.ca) || "";
  if (ca) {
    // phones show the address shortened in the middle (0x1FA81d…E40Edc1a074 style), so it never wraps mid-string; Copy copies it whole
    const fit = () => root.querySelectorAll("[data-bb-ca-full]").forEach((e) => { e.textContent = matchMedia("(max-width: 520px)").matches ? `${ca.slice(0, 10)}…${ca.slice(-8)}` : ca; e.title = ca; });
    fit(); addEventListener("resize", fit, { passive: true });
    root.querySelectorAll("a[data-bb-href]").forEach((a) => (a.href = a.dataset.bbHref.replace("{ca}", ca)));
  }
  const set = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("a")?.focus({ preventScroll: true });
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !root.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") { set(false); btn.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...menu.querySelectorAll("a, button")], i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  root.querySelector("[data-bb-ca]")?.addEventListener("click", async (e) => {
    const b = e.currentTarget.querySelector("b"), full = ca || e.currentTarget.querySelector("code").textContent.trim();
    try { await navigator.clipboard.writeText(full); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
})();
