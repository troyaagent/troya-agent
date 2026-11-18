// Troya Desk (concept shell). Same pages, same API and wallet modules as /agent; only the frame changes:
// grouped sidebar, top bar with Ask, an agent drawer that stays open beside any page, and a new Desk home.
// Pages live in /agent/js/pages/<name>.js (unchanged). Desk home and Gate live next to this file.
import { h, $, clear, icon, toast, modal, short, store, chainLogo, tokenIcon, setBorn, price } from "/agent/js/ui.js";
import { padName } from "/agent/js/marketlib.js";
import { wallet, onWallet, openConnect, restore, disconnect, signIn, CHAINS, chainById } from "/agent/js/wallet.js";
import { api } from "/agent/js/api.js";
import { chromeIcon } from "./chrome-icons.js";
import { mountGuide } from "./guide.js";

const SITE = window.SITE || {};

/* ---------- icons for the sidebar (stroke, 24 grid) ---------- */
const SI = {
  spot: "M4 19h16M7 15l3-3 3 2 5-6M17 8h2v2",
  lighter: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
  stocks: "M4 20V10m6 10V4m6 16v-7m6 7V8",
  liquidity: "M12 3s6 6.4 6 10.6a6 6 0 0 1-12 0C6 9.4 12 3 12 3zM9 14.5a3 3 0 0 0 3 3",
  flywheel: "M12 3a9 9 0 1 0 9 9M12 3v4M21 12h-4M12 8a4 4 0 1 0 4 4M18.4 5.6 15 9",
  social: "M4 4l16 16M20 4 4 20M8 4H4v4M16 20h4v-4",
  sun: "M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
  moon: "M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z",
  desk: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z",
  swap: "M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4",
  perps: "M3 17l6-6 4 4 8-8M15 7h6v6",
  bridge: "M3 18h18M5 18V9m14 9V9M3 9c4 0 5-4 9-4s5 4 9 4",
  gate: "M4 21V9l8-6 8 6v12M9 21v-6a3 3 0 0 1 6 0v6",
  market: "M3 3v18h18M7 15l4-4 3 3 6-6",
  launch: "M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2M14 4l6 6-8 8-6-6zM16 2l6 6",
  create: "M12 5v14M5 12h14",
  leaderboard: "M8 21V11M12 21V5M16 21v-7M4 21h16",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z",
  wallet: "M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3m0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5m18 7h-4a2 2 0 0 0 0 4h4z",
  autopilot: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 12l4.5-4.5M12 5v2M19 12h-2M5 12h2",
  sentry: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  playbooks: "M5 3h10l4 4v14H5zM9 11h6M9 15h6M9 7h3",
  portfolio: "M3 7h18v13H3zM8 7V4h8v3M3 12h18",
  inbox: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  history: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  start: "M13 2 3 14h9l-1 8 10-12h-9z",
  docs: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6",
  verify: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M18 6 6 18M6 6l12 12",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
};
export function si(name, cls = "") {
  const chrome = chromeIcon(name, cls);         // Desk 2.0: the chrome set first, the stroke set for anything else
  if (chrome) return chrome;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("fill", "none"); el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.6"); el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = (SI[name] || SI.desk).split(/(?=M)/).map((s) => `<path d="${s}"/>`).join("");
  return el;
}

/* ---------- navigation: every page of the app, grouped by what you came to do ---------- */
export const GROUPS = [
  [null, [["Desk", "#/", "desk"]]],
  ["Trade", [["Swap", "#/swap", "swap"], ["Perps", "#/perps", "perps"], ["Spot (Hyperliquid)", "#/spot", "spot"], ["Lighter perps", "#/lighter", "lighter"], ["Stock desk", "#/stocks", "stocks"], ["Liquidity desk", "#/liquidity", "liquidity"], ["Bridge", "#/bridge", "bridge"]]],
  ["Discover", [["Gate a coin", "#/gate", "gate"], ["Market", "#/market", "market"], ["Troya Launches", "#/troya-launches", "hippodrome"], ["Create coin", "#/create", "create"], ["Creator desk", "#/creator", "creator"], ["All launches", "#/launch", "launch"], ["Leaderboard", "#/leaderboard", "leaderboard"], ["Agent registry", "#/registry", "agent"]]],
  ["Agent", [["Chat", "#/agent", "chat"], ["Agent Wallet", "#/agent/wallet", "wallet"], ["Autopilot", "#/agent/autopilot", "autopilot"], ["Sentry Autopilot", "#/agent/sentry", "sentry"], ["Playbooks", "#/agent/playbooks", "playbooks"], ["Audited rail", "#/rail", "rail"]]],
  ["You", [["Portfolio", "#/portfolio", "portfolio"], ["Inbox", "#/portfolio/inbox", "inbox"], ["History", "#/portfolio/history", "history"], ["Social", "#/social", "social"]]],
  ["Help", [["Start in 60 seconds", "#/start", "start"], ["Docs", "#/docs", "docs"], ["Is it safe?", "/safety", "verify"], ["Verify", "/verify", "verify"], ["The Record", "/record", "record"], ["$TROYA flywheel", "#/flywheel", "flywheel"]]],
];
const FLAT = GROUPS.flatMap(([g, items]) => items.map(([t, href, ic]) => ({ g, t, href, ic })));
// route table: first path segment → page module (same as /agent) plus the Desk's own Gate page
const ROUTES = {
  "": "home", market: "market", token: "token", swap: "swap", perps: "perps", launch: "launchpad",
  bridge: "bridge", agent: "agent", assistant: "agent", portfolio: "portfolio", docs: "docs", start: "start", leaderboard: "leaderboard", gate: "gate", spot: "spot", lighter: "lighter", stocks: "stocks", liquidity: "liquidity", flywheel: "flywheel", social: "social", registry: "registry", rail: "rail", "troya-launches": "hippodrome", hippodrome: "hippodrome", create: "create", creator: "creator",
};
const LOCAL = { home: "./desk-home.js", gate: "./gate.js", spot: "./spot.js", lighter: "./lighter.js", stocks: "./stocks.js", liquidity: "./liquidity.js", flywheel: "./flywheel.js", social: "./social.js", registry: "./registry.js", rail: "./rail.js", hippodrome: "./hippodrome.js", create: "./create.js", creator: "./creator.js" };
export const prefs = store("troya.prefs", { slippage: 1, density: "comfortable", motion: "system", lang: "auto" });

const view = $("#view");
let cleanup = null;
let routeId = 0;

function parse() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { name: ROUTES[parts[0] || ""] ? parts[0] || "" : null, parts: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)), raw, path: parts.join("/") };
}
export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

const SUBTITLES = { "launch/x": "Launch from X", "launch/create": "Create coin" };
// the sidebar item for a path: longest matching href (token pages sit under Market, assistant under Chat)
function activeItem(path) {
  const p = path.replace(/^token\b/, "market").replace(/^assistant\b/, "agent").replace(/^launch\/(create|x)\b/, "create");
  let best = null;
  for (const it of FLAT) {
    if (!it.href.startsWith("#/")) continue;
    const hp = it.href.slice(2);
    const hit = hp === "" ? p === "" : p === hp || p.startsWith(hp + "/");
    if (hit && (!best || hp.length > best.href.length - 2)) best = it;
  }
  return best;
}
const isChat = (r) => (r.name === "agent" || r.name === "assistant") && !["wallet", "autopilot", "sentry", "playbooks"].includes(r.parts[0]);

async function route() {
  const id = ++routeId;
  const r = parse();
  if (r.raw.split("?")[0].replace(/\/$/, "") === "settings") { history.replaceState(null, "", "#/"); openSettings(); return route(); }
  // Troya Launches lived at #/hippodrome first; old links (posts, bot replies) land on the new address
  if (r.name === "hippodrome") { history.replaceState(null, "", "#/troya-launches" + r.raw.slice("hippodrome".length)); return route(); }
  const page = r.name == null ? null : ROUTES[r.name];
  const act = activeItem(r.path);
  for (const a of document.querySelectorAll("[data-nav] a, [data-tabbar] a")) {
    const on = !!act && a.getAttribute("href") === act.href;
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  revealActive();
  clear($("[data-crumb]"), act?.g ? h("span", {}, act.g) : null, h("b", {}, act?.t || (page ? page[0].toUpperCase() + page.slice(1) : "Desk")));
  closeSide();
  // the full chat page and the drawer are the same chat: never show both
  const chat = isChat(r);
  document.body.classList.toggle("on-chat", chat);
  if (chat) closeDrawer();
  try { cleanup?.(); } catch {}
  cleanup = null;
  view.classList.toggle("wide", page === "perps" || page === "hippodrome");   // hippodrome = the Troya Launches module
  view.dataset.page = page || "";
  if (!page) { clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "This page does not exist."), h("a", { class: "link", href: "#/" }, "Back to the Desk"))); return; }
  clear(view, h("div", { style: { padding: "60px 0" } }, h("div", { class: "sk", style: { height: "40px", width: "240px" } })));
  let mod;
  try { mod = await import(LOCAL[page] || `/agent/js/pages/${page}.js`); }
  catch (e) {
    console.error(e);
    if (id === routeId) clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "This page failed to load."), h("div", {}, String(e.message || e))));
    return;
  }
  if (id !== routeId) return;
  clear(view);
  window.scrollTo(0, 0);
  // pages that share a sidebar item keep their own tab title ("Launch from X" sits under Create coin)
  document.title = `${SUBTITLES[r.path] || act?.t || page[0].toUpperCase() + page.slice(1)} · Troya Agent`;
  let cu = null;
  try { cu = (await mod.mount(view, { parts: r.parts, query: r.query, go, prefs, ask: askTroya })) || null; }
  catch (e) { console.error(e); if (id === routeId) clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "Something broke on this page."), h("div", {}, String(e.message || e)))); }
  // left before it finished loading: its timers stop now, never on the next page's watch
  if (id !== routeId) { try { cu?.(); } catch {} return; }
  cleanup = cu;
}

/* ---------- the room: soft chrome light behind every page (dark theme) ---------- */
const room = h("div", { class: "d-room", "aria-hidden": "true" }, h("canvas", { class: "d-silk" }));
document.body.prepend(room);
let silk = null;
import("./silk.js").then((m) => { silk = m.mountSilk(room.firstChild, 0.5); if (!silk) room.classList.add("flat"); }).catch(() => room.classList.add("flat"));

/* ---------- sidebar ---------- */
clear($("[data-nav]"), GROUPS.map(([g, items]) => h("div", { class: "d-group" },
  g ? h("h5", {}, g) : null,
  items.map(([t, href, ic]) => h("a", { href, ...(href.startsWith("/") ? { target: "_self" } : {}) }, si(ic), h("span", {}, t), href === "#/portfolio/inbox" ? h("i", { class: "d-count", "data-inbox": "" }) : null)))));
const caShort = SITE.ca ? short(SITE.ca, 4) : "Not live yet";
clear($("[data-side-foot]"),
  h("button", { class: "d-ca", type: "button", title: "Copy contract address", onclick: async () => {
    if (!SITE.ca) return toast("The contract address is not live yet.");
    try { await navigator.clipboard.writeText(SITE.ca); toast("Contract address copied", "ok"); } catch { toast(SITE.ca); }
  } }, h("b", {}, "$TROYA"), h("span", { class: "mono" }, caShort), icon("copy")),
  h("div", { class: "d-social" },
    SITE.telegram ? h("a", { href: SITE.telegram, target: "_blank", rel: "noopener" }, "Telegram") : null,
    SITE.x ? h("a", { href: SITE.x, target: "_blank", rel: "noopener" }, "X") : null,
    /^https:\/\/github\.com\//.test(SITE.github || "") ? h("a", { href: SITE.github, target: "_blank", rel: "noopener" }, "GitHub") : null,
    h("a", { href: "https://t.me/troyasentry", target: "_blank", rel: "noopener" }, "Sentry")));

const side = $("[data-side]"), scrim = $("[data-scrim]");
function revealActive() {
  const a = side.querySelector("[data-nav] a[aria-current]");
  if (!a) return;
  const ar = a.getBoundingClientRect(), sr = side.getBoundingClientRect();
  if (ar.top < sr.top + 90 || ar.bottom > sr.bottom - 110) side.scrollTop += ar.top - sr.top - (side.clientHeight - ar.height) / 2;
}
function openSide() { side.classList.add("open"); scrim.hidden = false; revealActive(); }
function closeSide() { side.classList.remove("open"); scrim.hidden = true; }
$("[data-burger]").append(si("menu"));
$("[data-burger]").after(h("a", { class: "d-top-mark", href: "#/", "aria-label": "Desk home" }, h("img", { src: "/img/logo-3d-128.png", alt: "", width: "128", height: "128" })));
$("[data-burger]").addEventListener("click", () => (side.classList.contains("open") ? closeSide() : openSide()));
scrim.addEventListener("click", closeSide);

/* ---------- mobile tab bar ---------- */
clear($("[data-tabbar]"),
  h("a", { href: "#/" }, si("desk"), h("span", {}, "Desk")),
  h("a", { href: "#/market" }, si("market"), h("span", {}, "Market")),
  h("button", { type: "button", class: "d-tab-ask", onclick: () => askTroya() }, h("i", { class: "mark" }), h("span", {}, "Ask")),
  h("a", { href: "#/swap" }, si("swap"), h("span", {}, "Swap")),
  h("a", { href: "#/perps" }, si("perps"), h("span", {}, "Perps")));

/* ---------- top bar right ---------- */
$(".d-search-ico").append(si("search"));
const right = $("[data-right]");
let inboxCount = 0;
// dark (default) or light, remembered in this browser
function setTheme(t) {
  if (t === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("troya.theme", t); } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#f5f3ee" : "#03060a");
  renderRight();
  requestAnimationFrame(() => silk?.resume());
}
function renderRight() {
  const c = chainById(wallet.chainId);
  const chip = h("span", { class: `chain-chip ${wallet.address ? "" : "off"}`, title: wallet.address ? `Wallet network: ${c?.name || "chain " + wallet.chainId}` : "Main network" },
    chainLogo(wallet.address ? (c?.key || "") : "robinhood", 16), wallet.address ? (c?.name || `Chain ${wallet.chainId}`) : "Robinhood Chain");
  const bell = h("a", { class: "icon-btn", href: "#/portfolio/inbox", "aria-label": "Inbox" }, si("inbox"), inboxCount ? h("span", { class: "badge" }, inboxCount > 9 ? "9+" : inboxCount) : null);
  const wbtn = wallet.address
    ? h("button", { class: "wallet-btn on", type: "button", onclick: walletMenu }, h("i", { class: "av" }), short(wallet.address))
    : h("button", { class: "wallet-btn d-connect", type: "button", onclick: () => openConnect(), "aria-label": "Connect wallet" }, si("wallet"), h("span", {}, "Connect", h("span", { class: "wb-more" }, " wallet")));
  const gear = h("button", { class: "icon-btn", type: "button", "aria-label": "Settings", onclick: openSettings }, si("gear"));
  const light = document.documentElement.dataset.theme === "light";
  const mode = h("button", { class: "icon-btn d-mode", type: "button", "aria-label": light ? "Dark mode" : "Light mode", title: light ? "Dark mode" : "Light mode", onclick: () => setTheme(light ? "dark" : "light") }, si(light ? "moon" : "sun"));
  clear(right, chip, bell, mode, gear, wbtn);
  for (const el of document.querySelectorAll("[data-inbox]")) el.textContent = inboxCount ? (inboxCount > 9 ? "9+" : inboxCount) : "";
}
function walletMenu() {
  const m = modal({ title: "Wallet", body: h("div", {},
    h("div", { class: "rows" },
      h("div", {}, h("span", {}, "Address"), h("span", { class: "mono" }, short(wallet.address, 6))),
      h("div", {}, h("span", {}, "Wallet"), h("span", {}, wallet.info?.name || "Browser wallet")),
      h("div", {}, h("span", {}, "Network"), h("span", {}, chainById(wallet.chainId)?.name || `Chain ${wallet.chainId}`)),
      h("div", {}, h("span", {}, "Signed in"), h("span", {}, wallet.session ? "Yes" : "No"))),
    h("div", { class: "row", style: { flexWrap: "wrap" } },
      h("button", { class: "btn", type: "button", onclick: () => { navigator.clipboard?.writeText(wallet.address); toast("Address copied", "ok"); } }, icon("copy"), "Copy address"),
      wallet.session ? null : h("button", { class: "btn", type: "button", onclick: async () => { try { await signIn(); m.close(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), "Sign in"),
      h("a", { class: "btn", href: "#/portfolio", onclick: () => m.close() }, "Portfolio"),
      h("button", { class: "btn danger", type: "button", onclick: () => { disconnect(); m.close(); } }, "Disconnect"))) });
}
function openSettings() {
  const p = prefs.get();
  const slip = h("input", { class: "input", type: "number", min: "0.1", max: "20", step: "0.1", value: p.slippage, style: { width: "90px" } });
  const lang = h("select", { class: "select" }, [["auto", "Same as my message"], ["en", "English"], ["id", "Bahasa Indonesia"]].map(([v, t]) => h("option", { value: v, selected: p.lang === v }, t)));
  const m = modal({ title: "Settings", body: h("div", { style: { display: "grid", gap: "14px" } },
    h("label", { class: "field" }, h("span", {}, "Default swap slippage (%)"), slip),
    h("label", { class: "field" }, h("span", {}, "Assistant reply language"), lang),
    h("p", { class: "note" }, "Slippage and language are kept in this browser only."),
    telegramBlock(),
    h("div", { class: "row", style: { justifyContent: "flex-end" } }, h("button", { class: "btn primary", type: "button", onclick: () => {
      const s = Math.min(20, Math.max(0.1, Number(slip.value) || 1));
      prefs.set({ ...p, slippage: s, lang: lang.value }); m.close(); toast("Settings saved", "ok");
    } }, "Save"))) });
}
// Telegram alerts: link this wallet to the Troya bot (one-time code), send a test, unlink. Needs a signed-in session.
function telegramBlock() {
  const status = h("span", { class: "faint" }, "Checking…");
  const row = h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } });
  const box = h("div", { class: "field", style: { gap: "8px" } }, h("span", {}, "Telegram alerts"), status, row,
    h("p", { class: "note" }, "Playbook alerts, fills and tickets waiting for you, sent to your Telegram by the Troya bot."));
  const btn = (t, fn, primary) => h("button", { class: `btn${primary ? " primary" : ""}`, type: "button", onclick: async (e) => {
    e.currentTarget.disabled = true; try { await fn(); } catch (err) { toast(err.message || String(err), "error"); } finally { paint(); } } }, t);
  async function paint() {
    if (!wallet.session) { status.textContent = "Sign in to link your Telegram."; clear(row, btn("Sign in", async () => { await signIn(); }, true)); return; }
    let st = null; try { st = await api.get("notify/status"); } catch {}
    if (!st?.configured) { status.textContent = "Not available on this server."; clear(row); return; }
    if (st.linked) {
      status.textContent = "Linked. Alerts go to your Telegram.";
      clear(row, btn("Send test", async () => { const r = await api.post("notify/test"); toast(r?.sent ? "Test sent to Telegram" : "Could not reach your Telegram", r?.sent ? "ok" : "error"); }),
        btn("Unlink", async () => { await api.post("notify/telegram/unlink"); toast("Telegram unlinked", "ok"); }));
    } else {
      status.textContent = "Not linked yet.";
      clear(row, btn("Link Telegram", async () => {
        const r = await api.post("notify/telegram/link");
        if (!r?.url) throw new Error("The bot is not reachable right now.");
        window.open(r.url, "_blank", "noopener");
        toast("Tap Start in Telegram to finish linking (the code works for 15 minutes).", "ok", 6000);
      }, true));
    }
  }
  paint();
  return box;
}
export { openSettings };
onWallet(() => renderRight());
async function pollInbox() {
  if (!wallet.session) { if (inboxCount) { inboxCount = 0; renderRight(); } return; }
  try { const r = await api.get("inbox?unread=1&limit=1"); const n = Number(r?.unread || 0); if (n !== inboxCount) { inboxCount = n; renderRight(); } } catch {}
}
setInterval(() => { if (!document.hidden) pollInbox(); }, 30000);
onWallet(() => pollInbox());

/* ---------- footer ---------- */
const caChip = h("div", { class: "ca-chip" }, h("b", {}, "CA"), h("span", { class: "sep" }, ":"),
  h("span", { class: "addr" }, SITE.ca || "Gates still shut"),
  h("button", { type: "button", onclick: async () => {
    if (!SITE.ca) return toast("The contract address is not live yet.");
    try { await navigator.clipboard.writeText(SITE.ca); toast("Contract address copied", "ok"); } catch { toast("Copy failed. Select the address and copy it manually.", "error"); }
  } }, "COPY"));
clear($("[data-foot]"),
  caChip,
  h("span", {}, "Non-custodial by default · You sign every transaction · Not financial advice"),
  h("nav", { "aria-label": "Footer" },
    h("a", { href: "/" }, "Troya Agent"),
    SITE.x ? h("a", { href: SITE.x, target: "_blank", rel: "noopener" }, "X") : null,
    SITE.telegram ? h("a", { href: SITE.telegram, target: "_blank", rel: "noopener" }, "Telegram") : null,
    /^https:\/\/github\.com\//.test(SITE.github || "") ? h("a", { href: SITE.github, target: "_blank", rel: "noopener" }, "GitHub") : null,
    h("a", { href: "#/bridge" }, "Bridge"),
    h("a", { href: "#/docs" }, "Docs"),
    h("a", { href: "/verify" }, "Verify"),
    h("a", { href: "https://www.tradingview.com/", target: "_blank", rel: "noopener" }, "Charts by TradingView"),
    SITE.operator ? h("a", { href: SITE.operator, target: "_blank", rel: "noopener" }, "Operator") : null));

/* ---------- agent drawer: the full chat (same module as #/agent), docked beside any page ---------- */
const drawer = $("[data-drawer]"), dBody = $("[data-drawer-body]");
$("[data-drawer-close]").append(si("close"));
$("[data-drawer-full]").append(si("expand"));
$("[data-drawer-close]").addEventListener("click", () => closeDrawer());
$("[data-drawer-full]").addEventListener("click", () => closeDrawer());
let dMounted = null;
function sendIn(root, q) {
  const inp = root.querySelector(".ag-input");
  if (!inp) return;
  inp.value = q;
  inp.dispatchEvent(new Event("input"));
  // same rule as the chat page's ?q=: signed in → send now; guest → leave it ready to send
  if (wallet.session) inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  else inp.focus();
}
// questions go to the Ask Troya popup; the drawer stays for the full chat
export function askTroya(q = "") { if (window.TroyaGuide) window.TroyaGuide.ask(q); else openDrawer(q); }
export async function openDrawer(q = "") {
  if (document.body.classList.contains("on-chat")) { if (q) sendIn(view, q); else view.querySelector(".ag-input")?.focus(); return; }
  drawer.hidden = false;
  requestAnimationFrame(() => document.body.classList.add("drawer-open"));
  if (!dMounted) {
    dMounted = (async () => {
      const mod = await import("/agent/js/pages/agent.js");
      await mod.mount(dBody, { parts: [], query: {}, go, prefs });
    })();
  }
  try { await dMounted; } catch (e) { clear(dBody, h("div", { class: "empty" }, h("b", {}, "The agent failed to load."), h("div", {}, String(e.message || e)))); return; }
  setTimeout(() => (q ? sendIn(dBody, q) : dBody.querySelector(".ag-input")?.focus()), q ? 120 : 60);
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
  setTimeout(() => { if (!document.body.classList.contains("drawer-open")) drawer.hidden = true; }, 260);
}
$("[data-ask-fab]").addEventListener("click", () => openDrawer());

/* ---------- Ask palette (⌘K): ask the agent, gate a pasted coin, or jump to any page ---------- */
const ASKS = ["What is moving on Robinhood Chain right now?", "Show funding extremes on Hyperliquid", "What should I watch today?"];
function openAsk(prefill = "") {
  const input = h("input", { class: "d-pal-in", placeholder: matchMedia("(max-width: 560px)").matches ? "Ask, paste a coin or find a page" : "Ask Troya anything, paste a coin address, or type a page name", value: prefill, "aria-label": "Ask Troya", autocomplete: "off", spellcheck: "false" });
  let sel = 0, flat = [], coins = [], coinQ = "", coinSeq = 0, coinTimer = 0;
  const opts = h("div", { class: "d-pal-list", role: "listbox" });
  // coins by symbol, name or ticker: the server searches the whole chain (index, stock tokens, DexScreener)
  const findCoins = () => {
    clearTimeout(coinTimer);
    const raw = input.value.trim().replace(/^\$/, "");
    if (raw.length < 2 || /0x[0-9a-fA-F]{40}/.test(raw) || raw.split(/\s+/).length > 3) { coins = []; coinQ = ""; return; }
    coinTimer = setTimeout(async () => {
      const my = ++coinSeq;
      try { const r = await api.get(`search/coins?q=${encodeURIComponent(raw)}&limit=6`); if (my !== coinSeq) return; coins = r.coins || []; coinQ = raw; render(); } catch {}
    }, 180);
  };
  // rows: { kind: "ask" | "coin" | "page", title, hint, icon, target }
  const sections = () => {
    const raw = input.value.trim(), q = raw.toLowerCase();
    const ca = (/0x[0-9a-fA-F]{40}/.exec(raw) || [])[0];
    const out = [];
    const asks = [];
    const fmt = (n) => (n == null ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
    const px = (n) => (n == null || !(n > 0) ? null : `$${price(n)}`);
    if (coins.length && coinQ && q.replace(/^\$/, "").startsWith(coinQ.toLowerCase().slice(0, 2))) {
      const rows = coins.map((c) => ({ kind: "coin", coin: c, title: `${c.symbol}${c.name && c.name.toLowerCase() !== c.symbol.toLowerCase() ? ` · ${c.name}` : ""}`,
        hint: [c.kind === "stock" ? "Robinhood stock token" : c.kind === "major" ? "Major" : c.launchpad ? padName(c.launchpad) : null, px(c.priceUsd), c.liquidityUsd ? `liq ${fmt(c.liquidityUsd)}` : null].filter(Boolean).join(" · "),
        target: c.address === "native" ? "#/swap" : `#/token/${c.address}` }));
      const t = coins[0];
      if (t && t.address !== "native") rows.splice(1, 0,
        { kind: "page", title: `Swap into ${t.symbol}`, hint: "Opens Swap with it selected; the Gate runs first", icon: "swap", target: `#/swap?out=${t.address}` },
        { kind: "page", title: `Gate ${t.symbol}`, hint: "Seven checks before you buy", icon: "gate", target: `#/gate/${t.address}` });
      out.push(["Coins", rows]);
    }
    if (raw && !ca) asks.push({ kind: "ask", title: raw, hint: "Ask Troya: answered right here, in the popup", icon: "spark", target: raw });
    for (const a of ASKS) if (!q || a.toLowerCase().includes(q)) asks.push({ kind: "ask", title: a, hint: "Ask Troya", icon: "spark", target: a });
    if (ca) out.push(["Check this coin", [
      { kind: "page", title: `Run Troya Gate on ${short(ca)}`, hint: "Seven checks: route, impact, depth, fees, simulation, test sell, tax", icon: "gate", target: `#/gate/${ca}` },
      { kind: "page", title: `Open the token page`, hint: "Price, chart, pools and trades", icon: "market", target: `#/token/${ca}` },
      { kind: "ask", title: `Ask Troya about ${short(ca)}`, hint: "Is it safe to buy? The agent reads the checks and explains", icon: "spark", target: `Is this token safe? ${ca}` },
      { kind: "page", title: `Swap into it`, hint: "Opens Swap with the coin selected", icon: "swap", target: `#/swap?out=${ca}` },
    ]]);
    const pages = FLAT.filter((it) => !q || it.t.toLowerCase().includes(q) || String(it.g || "").toLowerCase().includes(q))
      .map((it) => ({ kind: "page", title: it.t, hint: it.g || "Home", icon: it.ic, target: it.href }));
    const goTo = ["Go to", q ? pages.slice(0, 6) : pages.slice(0, 8)];
    // a single word that names a page ("swap", "perps") jumps there first; anything longer reads as a question
    const pageFirst = q && !/\s/.test(q) && pages.some((p) => p.title.toLowerCase().startsWith(q));
    if (pageFirst && pages.length) out.push(goTo);
    if (asks.length) out.push(["Ask Troya", asks.slice(0, 4)]);
    if (!pageFirst && pages.length) out.push(goTo);
    return out;
  };
  const run = (it) => { m.close(); if (it.kind === "ask") askTroya(it.target); else if (it.target.startsWith("/")) location.href = it.target; else go(it.target); };
  const render = () => {
    const secs = sections();
    flat = secs.flatMap(([, rows]) => rows);
    sel = Math.max(0, Math.min(sel, flat.length - 1));
    let i = 0;
    clear(opts, secs.map(([label, rows]) => h("div", { class: "d-pal-sec" }, h("div", { class: "d-pal-h" }, label),
      rows.map((it) => { const idx = i++; return h("button", { class: `d-pal-row ${idx === sel ? "sel" : ""}`, type: "button", role: "option", "aria-selected": String(idx === sel), onclick: () => run(it), onmousemove: () => { if (sel !== idx) { sel = idx; render(); } } },
        it.coin ? h("span", { class: "d-pal-ic coin" }, tokenIcon(it.coin)) : h("span", { class: `d-pal-ic ${it.kind}` }, si(it.icon || "desk")), h("span", { class: "d-pal-t" }, h("b", {}, it.title), h("small", {}, it.hint)), h("kbd", {}, "↵")); }))));
    opts.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { sel = 0; findCoins(); render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = (sel + 1) % Math.max(1, flat.length); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = (sel - 1 + flat.length) % Math.max(1, flat.length); render(); e.preventDefault(); }
    else if (e.key === "Enter" && flat[sel]) { e.preventDefault(); run(flat[sel]); }
  });
  const foot = h("div", { class: "d-pal-foot" }, h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " move"), h("span", {}, h("kbd", {}, "↵"), " open"), h("span", {}, h("kbd", {}, "esc"), " close"),
    h("span", { class: "d-pal-note" }, "Answers open beside the page you are on"));
  const m = modal({ body: h("div", { class: "d-pal" }, h("div", { class: "d-pal-top" }, h("span", { class: "d-pal-spark" }, si("spark")), input), opts, foot) });
  m.box.classList.add("palette", "d-pal-box");
  m.body.style.padding = "0";
  render();
  setTimeout(() => input.focus(), 30);
}
for (const b of document.querySelectorAll("[data-ask]")) b.addEventListener("click", () => openAsk());
for (const b of document.querySelectorAll(".d-ask-ico")) b.append(si("spark"));
// Troya Guide on every page: what it is for, a walk-through, questions for the agent (answered in the drawer)
mountGuide({ askFn: (q) => openDrawer(q) });
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openAsk(); }
  else if (e.key === "Escape" && document.body.classList.contains("drawer-open") && !document.querySelector(".modal-bg")) closeDrawer();
});
window.troya = { go, openAsk, openConnect, signIn, CHAINS, ask: openDrawer };

// the coins born through Troya, so every logo of one carries the horse badge
api.get("/api/launch/born").then((d) => setBorn(d?.tokens, d?.graduated, { all: true })).catch(() => {});
addEventListener("hashchange", route);
restore();
renderRight();
route();
// Autopilot lives in the Agent page module and starts itself when switched on; load it on any page so it keeps running in this tab
if (store("troya.autopilot", { on: false }).get().on) import("/agent/js/pages/agent.js").catch(() => {});
