// Marketing site: menu, footer, contract chip, reveals.
const SITE = window.SITE || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export const NAV_BIG = [
  ["Troya", "/"], ["Launch app", "/agent"], ["Capabilities", "/capabilities"], ["Philosophy", "/philosophy"], ["Plans", "/plans"],
];
export const NAV_SMALL = [
  ["Market", "/agent#/market"], ["Swap", "/agent#/swap"], ["Perps", "/agent#/perps"], ["Bridge", "/agent#/bridge"],
  ["Launchpad", "/agent#/launch"], ["Assistant", "/agent#/agent"], ["Docs", "/agent#/docs"],
  ["Market Analysis", "/market-analysis"], ["API and MCP", "/api-and-mcp"], ["Risk Controls", "/risk-controls"], ["Verify", "/verify"], ["Insights", "/insights"],
];
const here = location.pathname.replace(/\/$/, "") || "/";
const cur = (href) => (href === here ? ' aria-current="page"' : "");

export function toast(text, kind = "") {
  const box = $("[data-toasts]");
  if (!box) return;
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.append(t);
  setTimeout(() => t.remove(), 2600);
}
async function copy(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label, "ok"); }
  catch { toast("Copy failed. Select the text and copy it manually.", "error"); }
}

/* ---------- X button (top right) ---------- */
const xUrl = /^https:\/\/(x|twitter)\.com\//.test(SITE.x || "") ? SITE.x : "";
const head = $(".s-head");
const tgUrl = /^https:\/\/t\.me\//.test(SITE.telegram || "") ? SITE.telegram : "";
if (head && (xUrl || tgUrl)) {
  const soc = document.createElement("div"); soc.className = "s-soc";
  const btn = (href, label, svg) => { const a = document.createElement("a"); a.className = "x-btn"; a.href = href; a.target = "_blank"; a.rel = "noopener"; a.setAttribute("aria-label", label); a.innerHTML = svg; soc.append(a); };
  if (xUrl) btn(xUrl, "Troya Agent on X", '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>');
  if (tgUrl) btn(tgUrl, "Troya Agent on Telegram", '<svg viewBox="0 0 24 24" aria-hidden="true" class="tg"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>');
  head.append(soc);
}

/* ---------- menu ---------- */
const panel = $("[data-menu-panel]");
const btn = $("[data-menu]");
if (panel && btn) {
  panel.innerHTML = `<ul class="big">${NAV_BIG.map(([t, h]) => `<li><a href="${h}"${cur(h)}>${t}</a></li>`).join("")}</ul>
    <ul class="small">${NAV_SMALL.map(([t, h]) => `<li><a href="${h}"${cur(h)}>${t}</a></li>`).join("")}</ul>`;
  const set = (open) => {
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Close" : "Menu";
  };
  btn.addEventListener("click", () => set(!panel.classList.contains("open")));
  addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  document.addEventListener("click", (e) => { if (panel.classList.contains("open") && !panel.contains(e.target) && e.target !== btn) set(false); });
}

/* ---------- footer ---------- */
const foot = $("[data-footer]");
if (foot) {
  const year = new Date().getFullYear();
  foot.innerHTML = `
  <div class="f-nav">
    <ul class="f-big">${NAV_BIG.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul>
    <ul class="f-small">${NAV_SMALL.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`).join("")}
      ${SITE.x ? `<li><a href="${SITE.x}" target="_blank" rel="noopener">X</a></li>` : ""}${SITE.telegram ? `<li><a href="${SITE.telegram}" target="_blank" rel="noopener">Telegram</a></li>` : ""}</ul>
  </div>
  <div class="f-ca"><div class="ca-chip" data-ca><b>CA</b><span class="sep">:</span><span class="addr" data-ca-addr>TBA</span><button type="button" data-ca-copy>COPY</button></div></div>
  <p class="f-legal">Troya Agent is software for reading markets and preparing orders on Robinhood Chain and Hyperliquid mainnet. It is in beta and handles real funds. You can sign every action in your own wallet, which Troya never holds, or switch on an optional Agent Wallet: a small custodial wallet whose key the operator stores encrypted, so the agent can act within the caps you and the operator set. Nothing on this site or in the app is investment, legal or tax advice, an offer or a solicitation. Digital assets are volatile and you can lose everything you put in. You are responsible for the limits you choose and for every action taken under them.</p>
  <div class="f-bar"><span>© ${year} Troya Agent</span><span>Mainnet beta</span><span>All rights reserved</span><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Use</a></div>
  <div class="f-word" aria-hidden="true"><span>Troya</span><div class="mark3d" data-mark3d><i class="mark lg"></i></div><span>Agent</span></div>`;
}

/* ---------- contract chip ---------- */
$$("[data-ca]").forEach((chip) => {
  const addr = $("[data-ca-addr]", chip);
  const b = $("[data-ca-copy]", chip);
  if (SITE.ca) { addr.textContent = SITE.ca; b.onclick = () => copy(SITE.ca, "Contract address copied"); }
  else { addr.textContent = "Gates still shut"; b.onclick = () => toast("The contract address is not live yet.", ""); }
});
$$("[data-copy-cmd]").forEach((b) => { b.onclick = () => copy(`npx -y ${SITE.mcpPackage || "@troyaagent/mcp"}`, "Command copied"); });
$$("[data-mcp-cmd]").forEach((c) => { c.textContent = `npx -y ${SITE.mcpPackage || "@troyaagent/mcp"}`; });

/* ---------- reveals ---------- */
$$("[data-words]").forEach((el) => {
  const words = el.textContent.trim().split(/\s+/);
  el.setAttribute("aria-label", el.textContent.trim());
  el.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true"><i style="transition-delay:${i * 55}ms">${w}</i></span>`).join(" ");
});
const io = new IntersectionObserver((list) => {
  for (const e of list) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
$$(".rv, [data-words]").forEach((el) => io.observe(el));

