// Troya Agent — v9 additions on top of troy.js: cursor code rain in the hero, reveals, number count-up.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // this concept is drawn for the night palette and the Instrument accent (troy.js may restore an older pick)
  root.dataset.t = "A"; root.dataset.s = "instrument";

  // reveals + count-up
  const countUp = (el) => {
    const end = +el.dataset.num; if (!end || reduce) return;
    const t0 = performance.now(), dur = 1500;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(end * e).toLocaleString("en-US"); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in");
    const n = e.target.querySelector("[data-num]"); if (n) countUp(n);
    io.unobserve(e.target);
  }), { rootMargin: "0px 0px -8% 0px" });
  $$(".rv").forEach((el) => io.observe(el));
  if (reduce) $$(".rv").forEach((el) => el.classList.add("in"));

  /* ---------- code rain: TROYA anagrams and 0x hex fall from wherever the cursor moves ---------- */
  const cv = $("[data-rain]");
  if (!cv || reduce) return;
  const hero = cv.parentElement;
  const ctx = cv.getContext("2d");
  const WORDS = ["TROYA", "AROTY", "YORTA", "OTARY", "RAYTO", "TORYA", "ROYAT", "YATRO", "ATROY", "OYTAR", "TAYRO", "ORYAT"];
  const HEX = "0123456789abcdef";
  const CA = (window.SITE && window.SITE.ca) || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const hex = (n) => { let s = ""; for (let i = 0; i < n; i++) s += HEX[(Math.random() * 16) | 0]; return Math.random() < 0.35 ? s.toUpperCase() : s; };
  const token = () => {
    const r = Math.random();
    if (r < 0.42) return pick(WORDS);
    if (r < 0.74) return "0x" + hex(3 + ((Math.random() * 5) | 0));
    if (r < 0.86) { const i = 2 + ((Math.random() * 30) | 0); return CA.slice(i, i + 4 + ((Math.random() * 4) | 0)); }
    return "0x" + hex(4) + "…" + hex(4);
  };
  const glyphs = (len) => { let s = ""; while (s.length < len) s += (s ? " " : "") + token(); return [...s.slice(0, len)]; };

  const MAX = 90;
  let W = 0, H = 0, dpr = 1, streams = [], visible = true, running = false, last = 0, ambientAt = 0;
  let px = null, py = null, carry = 0;

  const size = () => {
    const r = hero.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // fs: glyph size; a: brightness; v: fall speed in px/s
  const spawn = (x, y, ambient) => {
    if (streams.length >= MAX) return;
    const fs = ambient ? 10 + Math.random() * 3 : 11 + Math.random() * 5;
    const col = fs * 0.95;
    const len = ambient ? 6 + ((Math.random() * 10) | 0) : 7 + ((Math.random() * 13) | 0);
    streams.push({
      x: Math.round(x / col) * col, y, fs, lh: fs * 1.18, len, chars: glyphs(len),
      v: ambient ? 70 + Math.random() * 120 : 170 + Math.random() * 280,
      a: ambient ? 0.14 + Math.random() * 0.14 : 0.5 + Math.random() * 0.5,
    });
  };

  const onMove = (x, y) => {
    if (px == null) { px = x; py = y; return; }
    const d = Math.hypot(x - px, y - py);
    px = x; py = y;
    carry += d;
    let n = 0;
    while (carry > 20 && n < 3) {
      carry -= 20; n++;
      const spread = 70 + Math.random() * 90;
      spawn(x + (Math.random() - 0.5) * 2 * spread, y - 20 - Math.random() * 120, false);
    }
    if (carry > 48) carry = 48;
    start();
  };
  hero.addEventListener("pointermove", (e) => { const r = hero.getBoundingClientRect(); onMove(e.clientX - r.left, e.clientY - r.top); }, { passive: true });
  hero.addEventListener("pointerleave", () => { px = py = null; carry = 0; });
  hero.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (!t) return; const r = hero.getBoundingClientRect(); onMove(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
  hero.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (!t) return; const r = hero.getBoundingClientRect(); px = t.clientX - r.left; py = t.clientY - r.top; for (let i = 0; i < 4; i++) spawn(px + (Math.random() - 0.5) * 160, py - Math.random() * 80, false); start(); }, { passive: true });

  const draw = (now) => {
    if (!visible || document.hidden) { running = false; return; }
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    // a faint drizzle so the black never looks dead
    if (now > ambientAt) { spawn(Math.random() * W, -Math.random() * H * 0.35, true); ambientAt = now + 240 + Math.random() * 260; }
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "top";
    let font = "";
    for (let i = streams.length - 1; i >= 0; i--) {
      const s = streams[i];
      s.y += s.v * dt;
      if (s.y - s.len * s.lh > H) { streams.splice(i, 1); continue; }
      const f = `400 ${s.fs.toFixed(1)}px "JetBrains Mono", ui-monospace, monospace`;
      if (f !== font) { ctx.font = f; font = f; }
      // the string reads top to bottom; its last glyph is the head, brightest, at s.y
      for (let k = 0; k < s.len; k++) {
        const gy = s.y - k * s.lh;
        if (gy > H || gy < -s.lh) continue;
        const ch = s.chars[s.len - 1 - k];
        if (ch === " ") continue;
        if (k === 0) { ctx.globalAlpha = Math.min(1, s.a * 1.15); ctx.fillStyle = "#f5f9fb"; }
        else { ctx.globalAlpha = s.a * 0.78 * (1 - k / s.len); ctx.fillStyle = "#8edff5"; }
        ctx.fillText(ch, s.x, gy);
      }
      // now and then a glyph flickers to another hex digit
      if (Math.random() < 0.02) { const j = (Math.random() * s.len) | 0; if (s.chars[j] !== " " && /[0-9a-fA-F]/.test(s.chars[j])) s.chars[j] = HEX[(Math.random() * 16) | 0]; }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  };
  function start() { if (running || !visible || document.hidden) return; running = true; last = 0; requestAnimationFrame(draw); }

  size();
  new ResizeObserver(size).observe(hero);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) start(); }).observe(hero);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });
  start();
})();
