// /verify: a "Latest proof" strip under the hero (owner, 19 Nov 2026: users should see at a glance which proofs are the
// newest, in a horizontal list, and tapping one scrolls down to that step). Built from the real-money steps already on
// the page, newest first, so a new step shows up here by itself and nothing is written twice.
(() => {
  const mount = document.querySelector("[data-latest]");
  const sec = document.getElementById("tx-h")?.closest("section");
  if (!mount || !sec) return;

  const MAX = 8;
  const DATE = /^(\d{1,2} [A-Z][a-z]{2} \d{4})(?:,[^:]*)?:?\s*/;
  const steps = [...sec.querySelectorAll("article.step")];
  const items = [];
  for (const st of steps) {
    const n = Number(st.querySelector(".n")?.textContent);
    const h = st.querySelector("h3");
    const p = st.querySelector("p");
    if (!n || !h || !p) continue;
    const txt = p.textContent.replace(/\s+/g, " ").trim();
    const m = txt.match(DATE);
    if (!m) continue; // only dated receipts belong in "latest"
    if (!st.id) st.id = `proof-${String(n).padStart(2, "0")}`;
    const title = [...h.childNodes].filter((x) => !(x.nodeType === 1 && x.matches(".new-badge"))).map((x) => x.textContent).join("").trim();
    const badge = h.querySelector("[data-new]");
    const t = badge ? Date.parse(badge.dataset.new) : 0;
    let sum = txt.slice(m[0].length);
    sum = sum.charAt(0).toUpperCase() + sum.slice(1);
    if (sum.length > 120) sum = sum.slice(0, 120).replace(/\s+\S*$/, "") + "…";
    items.push({ n, id: st.id, title, date: m[1], sum, fresh: t && Date.now() - t < 48 * 3600e3, el: st });
  }
  if (!items.length) return;
  items.sort((a, b) => b.n - a.n);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const head = el("div", "vl-head");
  const k = el("span", "vl-k"); k.append(el("i", "vl-dot"), "Latest proof");
  const all = el("a", "vl-all", `All ${steps.length} trades`); all.href = "#tx-h";
  head.append(k, el("span", "vl-sub", "Newest first. Tap one to jump to it."), all);

  const row = el("ol", "vl-row");
  for (const it of items.slice(0, MAX)) {
    const li = el("li");
    const a = el("a", "vl-card"); a.href = `#${it.id}`; a.dataset.to = it.id;
    const top = el("span", "vl-top");
    top.append(el("b", null, String(it.n).padStart(2, "0")), el("time", null, it.date));
    if (it.fresh) top.append(el("span", "new-badge", "New"));
    a.append(top, el("strong", null, it.title), el("span", "vl-sum", it.sum));
    li.append(a);
    row.append(li);
  }
  mount.append(head, row);
  mount.hidden = false;

  const ends = () => row.classList.toggle("at-end", row.scrollLeft + row.clientWidth >= row.scrollWidth - 4);
  row.addEventListener("scroll", ends, { passive: true });
  addEventListener("resize", ends, { passive: true });
  ends();

  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const go = (id, push) => {
    const st = document.getElementById(id);
    if (!st) return;
    st.classList.add("in"); // never land on a step still waiting for its reveal (.rv)
    st.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
    st.classList.remove("vl-flash"); void st.offsetWidth; st.classList.add("vl-flash");
    setTimeout(() => st.classList.remove("vl-flash"), 2600);
    if (push) history.replaceState(null, "", `#${id}`);
  };
  row.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-to]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    go(a.dataset.to, true);
  });

  // a shared link like /verify#proof-28 points at an id made above, after the browser looked for it
  const h = decodeURIComponent(location.hash.slice(1));
  if (/^proof-\d+$/.test(h)) requestAnimationFrame(() => go(h, false));
})();
