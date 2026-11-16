// Troya Agent — v10: the four posters follow the text you are reading; copy the MCP command;
// the concept switcher steps aside at the footer.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const split = $("[data-iw]");
  if (split) {
    const items = $$(".iw-item", split), imgs = $$(".iw-frame img", split), dots = $$(".iw-dots button", split);
    let cur = 0, ticking = false;
    const set = (i) => {
      if (i === cur) return;
      cur = i;
      items.forEach((el, k) => el.classList.toggle("on", k === i));
      imgs.forEach((el, k) => el.classList.toggle("on", k === i));
      dots.forEach((el, k) => el.classList.toggle("on", k === i));
    };
    // the item nearest the middle of the screen is the one being read
    const pick = () => {
      ticking = false;
      if (getComputedStyle($(".iw-stage", split)).display === "none") return;
      const mid = innerHeight / 2;
      let best = 0, bd = Infinity;
      items.forEach((el, k) => { const r = el.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = k; } });
      set(best);
    };
    const req = () => { if (!ticking) { ticking = true; requestAnimationFrame(pick); } };
    addEventListener("scroll", req, { passive: true });
    addEventListener("resize", req);
    dots.forEach((b) => b.addEventListener("click", () => items[+b.dataset.go].scrollIntoView({ behavior: "smooth", block: "center" })));
    pick();
  }

  // MCP command
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const t = b.dataset.copy, el = $("[data-toast]");
    let ok = true; try { await navigator.clipboard.writeText(t); } catch { ok = false; }
    if (el) { el.textContent = ok ? "Command copied" : t; el.classList.add("show"); clearTimeout(b._t); b._t = setTimeout(() => el.classList.remove("show"), 1600); }
  }));

  // keep the Options pill off the footer links
  const tune = $("[data-tune]"), foot = $(".foot");
  if (tune && foot) new IntersectionObserver((es) => tune.classList.toggle("away", es[0].isIntersecting && !tune.classList.contains("open"))).observe(foot);
})();
