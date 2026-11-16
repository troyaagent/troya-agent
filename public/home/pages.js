// Troya Agent — inner pages in the new home look: the home page's nav, full-screen menu and footer, the CA chip,
// and one serif-italic accent word in each page title. Runs after /js/site.js (which still builds the reveals, copy
// buttons and toasts on these pages).
const SITE = window.SITE || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PAGE = (p) => `/${p}`;                          // live addresses: /capabilities, /plans …
const file = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
const cur = (href) => (href === PAGE(file) ? ' aria-current="page"' : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const BIG = [["Troya", "/"], ["Open the desk", "/agent"], ["Capabilities", PAGE("capabilities")], ["Philosophy", PAGE("philosophy")], ["Plans", PAGE("plans")]];
const SMALL = [
  ["Market", "/agent#/market"], ["Swap", "/agent#/swap"], ["Perps", "/agent#/perps"], ["Bridge", "/agent#/bridge"],
  ["Launchpad", "/agent#/launch"], ["Assistant", "/agent#/agent"], ["Docs", "/agent#/docs"],
  ["Market Analysis", PAGE("market-analysis")], ["API and MCP", PAGE("api-and-mcp")], ["Risk Controls", PAGE("risk-controls")], ["Verify", PAGE("verify")], ["The Record", PAGE("record")], ["Flywheel", PAGE("flywheel")], ["Community", PAGE("community")], ["Gate badge", PAGE("badge")], ["Insights", PAGE("insights")],
];
const PAGES = [["Capabilities", "capabilities"], ["Plans", "plans"], ["Gate badge", "badge"], ["API and MCP", "api-and-mcp"], ["Market analysis", "market-analysis"], ["Insights", "insights"], ["Philosophy", "philosophy"], ["Risk controls", "risk-controls"]];
const ok = (re, u) => (re.test(u || "") ? u : "");
const X = ok(/^https:\/\/(x|twitter)\.com\//, SITE.x), TG = ok(/^https:\/\/t\.me\//, SITE.telegram), GH = ok(/^https:\/\/github\.com\//, SITE.github);
const ext = (href, label) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : "");

function toast(text, kind = "") {
  const box = $("[data-toasts]");
  if (!box) return;
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.append(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------- menu ---------- */
const menu = $("[data-pn-menu]"), burger = $("[data-pn-burger]");
if (menu && burger) {
  menu.innerHTML = `<ol>${BIG.map(([t, h], i) => `<li><a href="${h}"${cur(h)}><span>${String(i + 1).padStart(2, "0")}</span>${t}</a></li>`).join("")}</ol>
    <ul>${SMALL.map(([t, h]) => `<li><a href="${h}"${cur(h)}>${t}</a></li>`).join("")}</ul>
    <div class="pn-menu-foot">${ext(TG, "Telegram")}${ext("https://t.me/troyasentry", "Sentry")}${ext(X, "X")}${ext(GH, "GitHub")}</div>`;
  const set = (open) => {
    menu.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("pn-locked", open);
  };
  burger.addEventListener("click", () => set(!menu.classList.contains("open")));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => set(false)));
  addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
}

/* ---------- footer: the home page's, with the legal note and bar every page had ---------- */
const foot = $("[data-pn-foot]");
if (foot) {
  const year = new Date().getFullYear();
  foot.innerHTML = `
  <nav class="pn-pages" aria-label="Pages">${PAGES.map(([t, p]) => `<a href="${PAGE(p)}"${cur(PAGE(p))}>${t}</a>`).join("")}</nav>
  <div class="pn-row">
    <div class="pn-l"><a href="${PAGE("community")}">Community</a>${ext(TG, "Telegram")}${ext(X, "X")}${ext(GH, "GitHub")}<a href="${PAGE("privacy")}">Privacy policy</a></div>
    <button class="pn-ca" type="button" data-pn-ca><b>CA</b><span data-pn-ca-full></span></button>
    <div class="pn-rr"><a href="${PAGE("terms")}">Terms of service</a><a href="${PAGE("verify")}">Verify</a><a href="/agent#/docs">Docs</a></div>
  </div>
  <p class="pn-legal">Troya Agent is software for reading markets and preparing orders on Robinhood Chain, Base, Arbitrum, Solana and Hyperliquid mainnet. It is in beta and handles real funds. You can sign every action in your own wallet, which Troya never holds, or switch on an optional Agent Wallet: a small custodial wallet whose key the operator stores encrypted, so the agent can act within the caps you and the operator set. Nothing on this site or in the app is investment, legal or tax advice, an offer or a solicitation. Digital assets are volatile and you can lose everything you put in. You are responsible for the limits you choose and for every action taken under them.</p>
  <div class="pn-bar"><span>© ${year} Troya Agent</span><span>Mainnet beta</span><span>All rights reserved</span><a href="${PAGE("privacy")}">Privacy Policy</a><a href="${PAGE("terms")}">Terms of Use</a></div>`;
}

/* ---------- contract address (nav + footer) ---------- */
const ca = SITE.ca || "";
$$("[data-pn-ca-short]").forEach((e) => (e.textContent = ca ? `${ca.slice(0, 6)}…${ca.slice(-4)}` : "Soon"));
$$("[data-pn-ca-full]").forEach((e) => (e.textContent = ca || "Soon"));
$$("[data-pn-ca]").forEach((b) => b.addEventListener("click", async () => {
  if (!ca) return toast("The contract address is not live yet.");
  try { await navigator.clipboard.writeText(ca); toast("Contract address copied", "ok"); } catch { toast(ca); }
}));

/* ---------- nav turns solid once the page scrolls ---------- */
const nav = $("[data-pn-nav]");
if (nav) {
  const tick = () => nav.classList.toggle("solid", scrollY > 40);
  addEventListener("scroll", tick, { passive: true });
  tick();
}

/* ---------- one serif-italic accent word: the last word of the page title ---------- */
$$(".page-hero h1, .nf h1").forEach((h1) => {
  const words = $$(".w", h1);
  if (words.length) { words[words.length - 1].classList.add("acc"); return; }
  const t = h1.textContent.trim(), i = t.lastIndexOf(" ");
  if (i < 0) return;
  h1.setAttribute("aria-label", t);
  h1.innerHTML = `${esc(t.slice(0, i))} <em class="acc">${esc(t.slice(i + 1))}</em>`;
});
