// Troya Agent — "Inside the walls" concept. Options, CA copy, menu, film, scroll scenes. No libraries.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  // options: color theme + accent serif (?t=&s= or this browser's last pick)
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const qs = new URLSearchParams(location.search);
  const opts = { t: qs.get("t") || store.get("troy.t") || "A", s: qs.get("s") || store.get("troy.s") || "instrument" };
  const apply = () => { root.dataset.t = opts.t; root.dataset.s = opts.s; $$("[data-set]").forEach((g) => $$("button", g).forEach((b) => b.classList.toggle("on", b.dataset.v === opts[g.dataset.set]))); };
  apply();
  $$("[data-set]").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    opts[g.dataset.set] = b.dataset.v; store.set("troy." + g.dataset.set, b.dataset.v); apply();
    const u = new URL(location.href); u.searchParams.set("t", opts.t); u.searchParams.set("s", opts.s); history.replaceState(null, "", u);
  }));
  $("[data-tune-toggle]")?.addEventListener("click", () => $("[data-tune]").classList.toggle("open"));

  // contract address
  const toast = (t) => { const el = $("[data-toast]"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 1600); };
  const ca = (window.SITE && window.SITE.ca) || "";
  if (ca) { $$("[data-ca-short]").forEach((e) => (e.textContent = ca.slice(0, 6) + "…" + ca.slice(-4))); $$("[data-ca-full]").forEach((e) => (e.textContent = ca)); }
  $$("[data-ca]").forEach((b) => b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(ca); toast("Contract address copied"); } catch { toast(ca); } }));

  // menu
  const burger = $("[data-burger]"), menu = $("[data-menu]");
  const setMenu = (open) => { burger.setAttribute("aria-expanded", String(open)); menu.classList.toggle("open", open); document.body.style.overflow = open ? "hidden" : ""; };
  burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => setMenu(false)));

  // film
  const modal = $("[data-modal]"), video = $("[data-video]");
  $$("[data-play]").forEach((b) => b.addEventListener("click", () => { modal.hidden = false; video.currentTime = 0; video.play().catch(() => {}); }));
  const closeModal = () => { video.pause(); modal.hidden = true; };
  $("[data-close]").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); setMenu(false); } });

  // hero title: letters, a few drift out of focus (like a lens hunting)
  const mega = $("[data-blur]");
  $$(".l1, .l2 > span:not(.gap)", mega).forEach((el) => { el.innerHTML = [...el.textContent].map((c) => (c === " " ? " " : `<span class="ch-l">${c}</span>`)).join(""); });
  const letters = $$(".ch-l", mega).filter((l) => /\p{L}/u.test(l.textContent));
  [3, 7, 13, 18].forEach((i, k) => { const l = letters[i % letters.length]; if (l) { l.classList.add("bl"); l.style.animationDelay = `${k * 1.7}s`; } });
  requestAnimationFrame(() => $(".hero").classList.add("ready"));

  // headings come out of blur on enter
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -12% 0px" });
  $$(".rv-blur").forEach((el) => io.observe(el));
  if (reduce) { $$(".rv-blur").forEach((el) => el.classList.add("in")); }

  // the MCP tool count in the facts row, read live from /api/tools (the page says 24 until it answers)
  (async () => { try {
    const r = await fetch("/api/tools", { cache: "no-store" }); if (!r.ok) return;
    const n = ((await r.json()).tools || []).length; if (!n) return;
    $$("[data-tools-num]").forEach((x) => { x.dataset.num = n; x.textContent = n; if (x.closest(".in")) setTimeout(() => { x.textContent = n; }, 1700); });
  } catch {} })();

  // scroll scenes
  const nav = $("[data-nav]"), hero = $(".hero"), horse = $("[data-horse]"), count = $("[data-count]"), countN = $("[data-count-n]");
  const arts = $$("[data-kb], .fin-art"), photos = $$("[data-par]"), chapters = $$("[data-ch]");
  const through = (el, vh) => { const r = el.getBoundingClientRect(); return clamp((vh - r.top) / (vh + r.height)); };
  let ticking = false;
  const frame = () => {
    ticking = false;
    const y = scrollY, vh = innerHeight;
    nav.classList.toggle("solid", y > 40);
    // the horse is lowered into the city as you scroll
    if (!reduce) {
      const hp = clamp(y / hero.offsetHeight);
      horse.style.transform = `translate3d(0, ${hp * 8}vh, 0)`;
      mega.style.transform = `translate3d(0, ${-hp * 120}px, 0)`;
      mega.style.opacity = String(1 - clamp(hp * 1.6));
      arts.forEach((a) => { const p = through(a, vh); a.style.setProperty("--kb", (1.16 - p * 0.16).toFixed(4)); });
      photos.forEach((ph) => { const p = through(ph.parentElement, vh); ph.style.transform = `translate3d(0, ${(p - 0.5) * vh * +ph.dataset.par}px, 0)`; });
    }
    // chapter counter
    let cur = "";
    chapters.forEach((c) => { const r = c.getBoundingClientRect(); if (r.top < vh * 0.55 && r.bottom > vh * 0.45) cur = c.dataset.ch; });
    count.classList.toggle("show", !!cur);
    if (cur) countN.textContent = cur;
  };
  const req = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", req, { passive: true });
  addEventListener("resize", req);
  frame();
})();
