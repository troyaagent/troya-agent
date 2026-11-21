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
// One site navigation, shared by the homepage (index.html imports NAV and renderGroups) and every inner page, so the
// menu and the footer can no longer drift apart. Proof pages sit in their own group: they are why people trust us.
export const NAV = [
  ["Product", [["Desk", "/agent"], ["Swap", "/agent#/swap"], ["Perps", "/agent#/perps"], ["Stocks", "/agent#/stocks"], ["Launch", "/agent#/launch"], ["Bridge", "/agent#/bridge"], ["Launch on X", PAGE("launch-on-x")]]],
  ["Proof", [["Verify", PAGE("verify")], ["The Record", PAGE("record")], ["Seal", PAGE("seal")], ["Arena", PAGE("arena")], ["Oath", PAGE("oath")], ["Flywheel", PAGE("flywheel")]]],
  ["Build", [["API and MCP", PAGE("api-and-mcp")], ["Gate badge", PAGE("badge")], ["Gate in MetaMask", PAGE("snap")], ["llms.txt", "/llms.txt"], ["Docs", "/agent#/docs"]]],
  ["Company", [["Roadmap", PAGE("roadmap")], ["Community", PAGE("community")], ["Stake $TROYA", "/stake"], ["Plans", PAGE("plans")], ["Capabilities", PAGE("capabilities")], ["Philosophy", PAGE("philosophy")], ["Market analysis", PAGE("market-analysis")], ["Insights", PAGE("insights")], ["Risk controls", PAGE("risk-controls")], ["Safety", PAGE("safety")], ["Privacy Policy", PAGE("privacy")], ["Terms of Use", PAGE("terms")]]],
];
// The same groups as HTML: one <div> per group with a small label, used by both menus and both footers.
// Styling comes from the caller's class (pn-groups on inner pages, menu-groups / foot-groups on the homepage).
export const renderGroups = (cls) => `<div class="${cls}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:24px 32px;text-align:left">${NAV.map(([g, links]) =>
  `<div><p style="margin:0 0 10px;color:var(--accent)">${g}</p><ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${links.map(([t, h]) => `<li><a href="${h}"${cur(h)}>${t}</a></li>`).join("")}</ul></div>`).join("")}</div>`;
export const LEGAL = "Troya Agent is software for reading markets and preparing orders on Robinhood Chain, Base, Arbitrum, Solana and Hyperliquid mainnet. It is in beta and handles real funds. You can sign every action in your own wallet, which Troya never holds, or switch on an optional Agent Wallet: a small custodial wallet whose key the operator stores encrypted, so the agent can act within the caps you and the operator set. Nothing on this site or in the app is investment, legal or tax advice, an offer or a solicitation. Digital assets are volatile and you can lose everything you put in. You are responsible for the limits you choose and for every action taken under them.";
export const BAR = () => `<span>© ${new Date().getFullYear()} Troya Agent</span><span>Mainnet beta</span><span>All rights reserved</span>`;
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
    ${renderGroups("pn-groups")}
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
  foot.innerHTML = `
  <nav class="pn-pages" aria-label="Pages" style="display:block">${renderGroups("pn-groups")}</nav>
  <div class="pn-row">
    <div class="pn-l"><a href="${PAGE("community")}">Community</a><a href="/stake">Stake</a>${ext(TG, "Telegram")}${ext(X, "X")}${ext(GH, "GitHub")}</div>
    <button class="pn-ca" type="button" data-pn-ca><b>CA</b><span data-pn-ca-full></span></button>
    <div class="pn-rr"><a href="${PAGE("privacy")}">Privacy Policy</a><a href="${PAGE("terms")}">Terms of Use</a></div>
  </div>
  <p class="pn-legal">${LEGAL}</p>
  <div class="pn-bar">${BAR()}</div>`;
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
