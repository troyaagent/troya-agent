// Troya Desk (concept shell). Same pages, same API and wallet modules as /agent; only the frame changes:
// grouped sidebar, top bar with Search (⌘K), an agent drawer that stays open beside any page, and a new Desk home.
// Pages live in /agent/js/pages/<name>.js (unchanged). Desk home and Gate live next to this file.
import { h, $, clear, icon, toast, modal, short, store, chainLogo, tokenIcon, coinIcon, setBorn, price, seg, useCss } from "/agent/js/ui.js";
import { padName } from "/agent/js/marketlib.js";
import { wallet, onWallet, openConnect, restore, disconnect, signIn, ensureChain, CHAINS, chainById } from "/agent/js/wallet.js";
import { api } from "/agent/js/api.js";
import { chromeIcon } from "./chrome-icons.js";
import { mountGuide } from "./guide.js";
import { mountChat } from "./chat.js";   // community chat in the app (21 Nov)
import "/agent/js/herald-ref.js";      // V8 F42 Herald: keeps a ?ref= code from the link, sends it once after sign-in

const SITE = window.SITE || {};

/* ---------- icons for the sidebar (stroke, 24 grid) ---------- */
const SI = {
  arena: "M4 20l6-6M14 4l6 6-9 9-3-3 9-9M4 14l6 6M15 9l-2-2",
  aegis: "M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3zM9 12l2 2 4-4",
  scepter: "M12 9v12M8 5l2 3h4l2-3-2.5 1L12 3l-1.5 3zM10 13h4",
  treasury: "M4 10h16v10H4zM2 10l10-6 10 6M8 14v3M12 14v3M16 14v3",
  stake: "M12 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8.6 13.4 7 21l5-2.6 5 2.6-1.6-7.6M12 6.4l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z",
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
  about: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01",
  verify: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M18 6 6 18M6 6l12 12",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  heel: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 1v4M12 19v4M1 12h4M19 12h4",
  chiron: "M6 3c4.5 2.3 7 5.6 7 9s-2.5 6.7-7 9M6 3v18M3 12h17M17 8.5l3.5 3.5-3.5 3.5",   // V9 F48 Chiron: the centaur's bow
  swift: "M3 7h9M3 12h13M3 17h9M14 5l6 7-6 7",
  clusters: "M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM9 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9.6 7.6l3.7 1M8 9.8l.6 5.2M14.5 11.4l-4 4.4",   // Cluster map
  trident: "M12 22V8M7 3v5a5 5 0 0 0 10 0V3M12 3v5",   // V10 F58 Trident
  vault: "M4 4h16v15H4zM6 19v2M18 19v2M14.5 11.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM12 9V7.5M12 15.5V14M17 9v5",   // Troya Index (26 Nov)
  bow: "M6 3c5 3 7 6 7 9s-2 6-7 9M6 3v18M3 12h17M17 8.5l3.5 3.5-3.5 3.5",   // V10
  sirens: "M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14",   // V10
  proteus: "M4 7h12l-3-3M20 17H8l3 3",   // V10
  voyage: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",   // V10
  argus: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z",   // V10
  scylla: "M3 12c3-4 6-4 9 0s6 4 9 0M3 17c3-4 6-4 9 0s6 4 9 0",   // V10
  mentor: "M4 19.5V5a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12M9 8h6M9 12h4",   // V10
  nekyia: "M12 3a7 7 0 0 0-7 7v11l2.5-2 2.5 2 2-2 2 2 2.5-2 2.5 2V10a7 7 0 0 0-7-7zM9.5 10h.01M14.5 10h.01",   // V10
  tiresias: "M12 7v5l3 2M3.05 11a9 9 0 1 1 .5 4M3 4v7h7",   // V10
  phoenix: "M12 21c-3.9 0-6.5-2.7-6.5-6.2 0-3.4 2.6-5.2 3.4-8.8 1.9 1.5 2.9 3.4 3 5.4 1-.9 1.7-2.2 1.9-3.8 2.5 2 4.7 4.8 4.7 7.6 0 3.3-2.8 5.8-6.5 5.8zM12 21c-1.6 0-2.7-1.1-2.7-2.6 0-1.6 1.4-2.6 2.7-4.4 1.3 1.8 2.7 2.8 2.7 4.4 0 1.5-1.1 2.6-2.7 2.6z",   // V9 F57 Phoenix
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

/* ---------- navigation: every page of the app, grouped by the job you came to do ---------- */
// Labels are plain words; each page keeps its myth name (Scepter, Aegis, Herald, Treasury, Arena) as its eyebrow.
// No route was removed in the regroup: every old address still resolves through ROUTES below.
export const GROUPS = [
  [null, [["Home", "#/", "desk"]]],
  ["Discover", [["Market", "#/market", "market"], ["Troya Launches", "#/troya-launches", "hippodrome"], ["All Robinhood coins", "#/launch", "launch"], ["Gate a coin", "#/gate", "gate"], ["Find the weak spot", "#/heel", "heel"], ["Heel Hunt", "#/heelhunt", "heel"], ["War Room", "#/warroom", "leaderboard"], ["Check before signing", "#/trident", "trident"], ["Agent passport", "#/bow", "bow"], ["Real depth", "#/sirens", "sirens"], ["One stock, many seas", "#/proteus", "proteus"], ["Plan a trade", "#/voyage", "voyage"], ["Sentinel network", "#/argus", "argus"], ["Safe crossing", "#/scylla", "scylla"], ["Blocked, and why", "#/mentor", "mentor"], ["Ghost trades", "#/nekyia", "nekyia"], ["Time machine", "#/tiresias", "tiresias"], ["Trader habits", "#/chiron", "chiron"], ["Leaderboard", "#/leaderboard", "leaderboard"]]],
  ["Trade", [["Swift", "#/swift", "swift"], ["Swap", "#/swap", "swap"], ["Perps", "#/perps", "perps"], ["Spot (Hyperliquid)", "#/spot", "spot"], ["Stock desk", "#/stocks", "stocks"], ["Liquidity desk", "#/liquidity", "liquidity"], ["Lighter perps", "#/lighter", "lighter"], ["Bridge", "#/bridge", "bridge"]]],
  ["Launch", [["Create coin", "#/create", "create"], ["My coins & fees", "#/creator", "creator"]]],
  // Autopilot keeps its place until the owner decides where it belongs
  ["Agent", [["Chat", "#/agent", "chat"], ["Agent control", "#/agent/scepter", "scepter"], ["Agent Wallet", "#/agent/wallet", "wallet"], ["Autopilot", "#/agent/autopilot", "autopilot"], ["Launch Autopilot", "#/agent/sentry", "sentry"], ["Playbooks", "#/agent/playbooks", "playbooks"], ["Exit guard", "#/agent/aegis", "aegis"], ["Strategy arena", "#/agent/arena", "arena"], ["What the agents learned", "#/phoenix", "phoenix"]]],
  ["Portfolio", [["Overview", "#/portfolio", "portfolio"], ["Stake $TROYA", "#/stake", "stake"], ["Troya Index", "#/vault", "vault"], ["History", "#/portfolio/history", "history"], ["Weekly review", "#/portfolio/owl", "news"]]],
  // Safety, Verify and The Record are public pages: one entry, opened in a new tab so the app keeps its place
  ["More", [["Invite & earn", "#/herald", "herald"], ["Holder tiers", "#/treasury", "treasury"], ["$TROYA flywheel", "#/flywheel", "flywheel"], ["AI calls", "#/registry", "agent"], ["Robinhood MCP rail", "#/rail", "rail"], ["Social", "#/social", "social"], ["Start in 60 seconds", "#/start", "start"], ["Docs", "#/docs", "docs"], ["Safety", "/safety", "verify"], ["What's new", "/roadmap#v8", "news"], ["Plans and tiers", "/plans", "plans"], ["Report a bug", "/community", "bug"]]],
];
// not in the sidebar, still found by Search (⌘K): the Inbox has the bell and the Portfolio badge; Verify and The Record sit under Safety
// About Troya has its own link at the foot of the sidebar, just above the $TROYA chip (community request, 23 Nov 2026)
const SEARCH_ONLY = [["Discover", [["Cluster map", "#/clusters", "clusters"]]], ["Portfolio", [["Inbox", "#/portfolio/inbox", "inbox"]]], ["More", [["About Troya", "#/about", "about"], ["Verify", "/verify", "proof"], ["The Record", "/record", "record"]]]];
const COLLAPSED_DEFAULT = { Agent: true, More: true };   // with these two shut the sidebar fits a 900 px screen
const NAV_KEY = "troya.navGroups";
const navState = (() => { try { return { ...COLLAPSED_DEFAULT, ...JSON.parse(localStorage.getItem(NAV_KEY) || "{}") }; } catch { return { ...COLLAPSED_DEFAULT }; } })();
const saveNav = () => { try { localStorage.setItem(NAV_KEY, JSON.stringify(navState)); } catch {} };
const FLAT = [...GROUPS, ...SEARCH_ONLY].flatMap(([g, items]) => items.map(([t, href, ic]) => ({ g, t, href, ic })));
// route table: first path segment → page module (same as /agent) plus the Desk's own Gate page
const ROUTES = {
  "": "home", market: "market", token: "token", swap: "swap", perps: "perps", launch: "launchpad",
  bridge: "bridge", agent: "agent", assistant: "agent", portfolio: "portfolio", docs: "docs", start: "start", leaderboard: "leaderboard", gate: "gate", spot: "spot", lighter: "lighter", stocks: "stocks", liquidity: "liquidity", flywheel: "flywheel", social: "social", registry: "registry", rail: "rail", "troya-launches": "hippodrome", hippodrome: "hippodrome", create: "create", creator: "creator",
  herald: "herald", treasury: "treasury",                    // V8 F42: /agent/js/pages/herald.js
  stake: "stake",                                            // $TROYA staking (21 Nov): /agent/js/pages/stake.js
  heel: "heel",                                              // V9 F47 Heel: ./heel.js (loads its own heel.css)
  chiron: "chiron",                                          // V9 F48 Chiron: ./chiron.js (loads its own chiron.css)
  clusters: "clusters",                                      // Cluster map (24 Nov): ./clusters.js (loads its own clusters.css)
  swift: "swift",                                            // V9 F49 Swift: ./swift.js (loads its own swift.css)
  about: "about",                                            // About Troya (23 Nov): ./about.js, the intro that used to open the Desk
  phoenix: "phoenix",                                        // V9 F57 Phoenix: ./phoenix.js (loads its own phoenix.css)
  heelhunt: "heelhunt",                                      // V9 F50 Heel Hunt: ./heelhunt.js (loads its own heelhunt.css)
  warroom: "warroom",                                        // V9 F52 War Room + F53 Myrmidons: ./warroom.js
  trident: "trident",                                        // V10 F58 Trident, the Troya Firewall: ./trident.js
  vault: "vault",                                            // Troya Index (26 Nov): ./index-vault.js (#/vault, and the owner's #/vault/deploy)
  tiresias: "tiresias",                        // V10
  nekyia: "nekyia",                            // V10
  mentor: "mentor",                            // V10
  scylla: "scylla",                            // V10
  argus: "argus",                              // V10
  voyage: "voyage",                            // V10
  proteus: "proteus",                          // V10
  sirens: "sirens",                            // V10
  phaeacians: "bow",                           // V10
  bow: "bow",                                  // V10
  u: "portfolio",                                            // profiles (21 Nov): #/u/<username> → a wallet's public page
};
const LOCAL = { home: "./desk-home.js", gate: "./gate.js", spot: "./spot.js", lighter: "./lighter.js", stocks: "./stocks.js", liquidity: "./liquidity.js", flywheel: "./flywheel.js", social: "./social.js", registry: "./registry.js", rail: "./rail.js", hippodrome: "./hippodrome.js", create: "./create.js", creator: "./creator.js", heel: "./heel.js", chiron: "./chiron.js", clusters: "./clusters.js", swift: "./swift.js", about: "./about.js", phoenix: "./phoenix.js", heelhunt: "./heelhunt.js", warroom: "./warroom.js", trident: "./trident.js", vault: "./index-vault.js", bow: "./bow.js", sirens: "./sirens.js", proteus: "./proteus.js", voyage: "./voyage.js", argus: "./argus.js", scylla: "./scylla.js", mentor: "./mentor.js", nekyia: "./nekyia.js", tiresias: "./tiresias.js" };
// The sheets each page asks for with useCss at mount. route() requests them together with the module, so the stylesheet
// is not one more round trip after the code. The boot script in /agent/index.html keeps a copy of this table and of the
// routes above to start the same downloads before this file has even arrived: change both together.
const PAGE_CSS = {
  home: ["home", "start"], market: ["home", "market"], token: ["home", "market"], launchpad: ["home", "market"], gate: ["home"], treasury: ["home", "agent"],
  swap: ["swap"], perps: ["perps"], bridge: ["bridge"], agent: ["agent"], portfolio: ["portfolio", "start", "profile"], docs: ["docs"], start: ["start"], leaderboard: ["start"], herald: ["herald"],
  spot: ["perps"], registry: ["perps"], rail: ["perps"], hippodrome: ["perps"], create: ["perps"], creator: ["perps"],
  lighter: ["perps", "swap"], stocks: ["perps", "swap"], liquidity: ["perps", "swap"], flywheel: ["perps", "swap"], social: ["perps", "swap"],
  stake: ["stake"], about: ["home"],
};
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
// only the chat tab itself counts: an exclusion list went stale when Scepter arrived and hid the Ask orb there
const isChat = (r) => (r.name === "agent" || r.name === "assistant") && (!r.parts[0] || r.parts[0] === "chat");
// the top-bar trail: [label, href?] from the outside in; the last one is the page you are on
function crumbsFor(r, act, page) {
  if (!page) return [["Not found"]];
  if (page === "token") return [["Market", "#/market"], ["Coin"]];
  const sub = SUBTITLES[r.path];
  // a page that shares a sidebar item gets its own last crumb (Discover / Create coin / Launch from X)
  if (act && sub && sub !== act.t) return [[act.g], [act.t, act.href], [sub]].filter(([t]) => t);
  if (act) return [[act.g], [act.t]].filter(([t]) => t);
  return [[page[0].toUpperCase() + page.slice(1)]];
}
function renderCrumbs(list) {
  const last = list.length - 1;
  clear($("[data-crumb]"), list.map(([t, href], i) => i === last ? h("b", { "aria-current": "page" }, t)
    : href ? h("a", { href }, t) : h("span", { class: "g" }, t)));
}

async function route() {
  const id = ++routeId;
  const r = parse();
  if (r.raw.split("?")[0].replace(/\/$/, "") === "settings") { history.replaceState(null, "", "#/"); openSettings(); return route(); }
  // Troya Launches lived at #/hippodrome first; old links (posts, bot replies) land on the new address
  if (r.name === "hippodrome") { history.replaceState(null, "", "#/troya-launches" + r.raw.slice("hippodrome".length)); return route(); }
  const page = r.name == null ? null : ROUTES[r.name];
  const act = activeItem(r.path);
  // items only: the "Launch a coin" shortcut in the Discover header must not light up (or be revealed) as the page
  for (const a of document.querySelectorAll("[data-nav] .d-group-items a, [data-nav] .d-pin a, [data-tabbar] a, [data-side-foot] a.d-about")) {
    // a tab lights for any page of its group (Troya Launches under Discover, Perps under Trade)
    const tab = a.dataset.tab;
    const on = !!act && (tab != null ? (tab ? act.g === tab : act.href === "#/") : a.getAttribute("href") === act.href);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  revealActive();
  renderCrumbs(crumbsFor(r, act, page));
  closeSide();
  closePop();
  // the full chat page and the drawer are the same chat: never show both
  const chat = isChat(r);
  document.body.classList.toggle("on-chat", chat);
  if (chat) closeDrawer();
  try { cleanup?.(); } catch {}
  cleanup = null;
  view.classList.toggle("wide", page === "perps" || page === "hippodrome");   // hippodrome = the Troya Launches module
  view.dataset.page = page || "";
  if (!page) { notFound(r); startSilk(); return; }
  clear(view, h("div", { style: { padding: "60px 0" } }, h("div", { class: "sk", style: { height: "40px", width: "240px" } })));
  for (const c of PAGE_CSS[page] || []) useCss(c);
  if (r.name === "launch" && (r.parts[0] === "create" || r.parts[0] === "x")) useCss("launch");
  let mod;
  try { mod = await import(LOCAL[page] || `/agent/js/pages/${page}.js`); }
  catch (e) {
    console.error(e);
    if (id === routeId) clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "This page failed to load."), h("div", {}, String(e.message || e))));
    startSilk();
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
  startSilk();
}

// a mistyped or retired address: say so plainly, offer a search for its words and the four places people go most
const LOST = [
  ["Swap", "#/swap", "swap", "Coins and stock tokens, checked by the Gate"],
  ["Market", "#/market", "market", "Every coin on Robinhood Chain with a real pool"],
  ["Gate a coin", "#/gate", "gate", "Nine checks before you buy"],
  ["Troya Launches", "#/troya-launches", "hippodrome", "Coins born through Troya"],
];
function notFound(r) {
  // the tab must not keep the last page's title
  document.title = "Not found · Troya Agent";
  // "#/stock-desk/nvda" → "stock desk nvda"; a pasted contract address stays whole, so the palette offers the Gate for it
  const words = r.path.replace(/[\/_+-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  clear(view, h("section", { class: "d-404", "aria-labelledby": "d-404-h" },
    h("p", { class: "dk-eyebrow" }, "Error 404"),
    h("h1", { id: "d-404-h" }, "This page ", h("em", {}, "does not exist.")),
    h("p", { class: "d-404-sub" }, "Nothing lives at ", h("code", {}, `#/${r.path}`), ". The link may have a typo, or the page has moved."),
    h("div", { class: "d-404-act" },
      h("button", { class: "btn primary", type: "button", onclick: () => openAsk(words) }, si("search"), words ? `Search for “${words}”` : "Search the Desk"),
      h("a", { class: "btn", href: "#/" }, "Back to the Desk")),
    h("nav", { class: "d-404-links", "aria-label": "Popular pages" }, LOST.map(([t, href, ic, d]) =>
      h("a", { href }, h("span", { class: "d-404-ic" }, si(ic)), h("span", { class: "d-404-t" }, h("b", {}, t), h("small", {}, d)), h("i", { "aria-hidden": "true" }, "→"))))));
  window.scrollTo(0, 0);
}

/* ---------- the room: soft chrome light behind every page (dark theme) ---------- */
const room = h("div", { class: "d-room", "aria-hidden": "true" }, h("canvas", { class: "d-silk" }));
document.body.prepend(room);
let silk = null, silkStarted = false;
// The light is decoration: it starts once the first page has mounted and the browser is idle (at most 2 s later), so
// compiling its shader never competes with the page people came for. Until then the room shows its flat backdrop.
function startSilk() {
  if (silkStarted) return;
  silkStarted = true;
  const mount = () => import("./silk.js").then((m) => { silk = m.mountSilk(room.firstChild, 0.5); if (!silk) room.classList.add("flat"); }).catch(() => room.classList.add("flat"));
  if ("requestIdleCallback" in window) requestIdleCallback(mount, { timeout: 2000 }); else setTimeout(mount, 300);
}
setTimeout(startSilk, 6000);          // a first page whose mount never settles still gets its light

/* ---------- sidebar ---------- */
const external = (href) => href.startsWith("/") ? { target: "_blank", rel: "noopener" } : {};
function navGroup([g, items]) {
  const list = h("div", { class: "d-group-items", style: { display: "grid", gap: "1px" } },
    items.map(([t, href, ic]) => h("a", { href, ...external(href), ...(href === "#/leaderboard" ? { hidden: true, "data-leaderboard": "" } : {}) }, si(ic), h("span", {}, t))));
  if (!g) return h("div", { class: "d-group" }, list);
  const id = `d-grp-${g.toLowerCase()}`;
  list.id = id;
  list.hidden = !!navState[g];
  const btn = h("button", { type: "button", "aria-expanded": String(!list.hidden), "aria-controls": id,
    style: { all: "inherit", display: "flex", alignItems: "center", gap: "6px", width: "100%", margin: 0, padding: 0, cursor: "pointer" },
    onclick: () => { list.hidden = !list.hidden; navState[g] = list.hidden; btn.setAttribute("aria-expanded", String(!list.hidden)); mark.textContent = list.hidden ? "+" : "−"; saveNav(); } },
    h("span", { style: { flex: 1 } }, g));
  const mark = h("i", { "aria-hidden": "true", style: { fontStyle: "normal", opacity: ".6" } }, list.hidden ? "+" : "−");
  btn.append(mark);
  return h("div", { class: "d-group" }, h("h5", { style: { display: "flex", alignItems: "center", gap: "8px" } }, btn), list);
}
clear($("[data-nav]"), GROUPS.map(navGroup));
// the two things people come to Troya for, pinned under Home: the AI agent and the launchpad (community request,
// 23 Nov 2026). They used to sit under Launch and a shut Agent group near the bottom; the groups stay for every sub-page.
// A tile lights for any page of its group (data-tab, the same rule as the phone tabs).
const PINNED = [["Agent", "#/agent/scepter", "agent", "Trades for you"], ["Launch", "#/create", "launch", "Create a coin"]];
$("[data-nav]").firstElementChild.after(h("div", { class: "d-pin" },
  PINNED.map(([g, href, ic, sub]) => h("a", { href, "data-tab": g }, si(ic), h("b", {}, g), h("small", {}, sub)))));
// Leaderboard stays hidden until traders opt in (the same check as the Desk home) or the weekly prize pool runs
// (prizes.show, 22 Nov 2026); the route itself always works
api.get("leaderboard?days=30").then((d) => { if (d?.rows?.length || d?.prizes?.show) for (const a of document.querySelectorAll("[data-leaderboard]")) a.hidden = false; }).catch(() => {});
const caShort = SITE.ca ? short(SITE.ca, 4) : "Not live yet";
clear($("[data-side-foot]"),
  // what Troya is, one tap away: the Desk opens straight on markets and the ask bar (community request, 23 Nov 2026)
  h("a", { class: "d-about", href: "#/about" }, si("about"), h("span", {}, "About Troya"), h("i", { "aria-hidden": "true" }, "→")),
  // the language picker again at the foot of the sidebar (the top bar shows only a globe on phones)
  window.TroyaI18n?.picker({ cls: "d-lang-side" }) || null,
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
  const a = side.querySelector("[data-nav] .d-group-items a[aria-current]");
  if (!a) return;
  const list = a.closest(".d-group-items");
  if (list?.hidden) { list.hidden = false; list.parentElement.querySelector("h5 button")?.setAttribute("aria-expanded", "true"); const m = list.parentElement.querySelector("h5 button i"); if (m) m.textContent = "−"; }
  if (side.querySelector(".d-pin a[aria-current]")) return;   // the lit Agent or Launch tile at the top already says where you are
  const ar = a.getBoundingClientRect(), sr = side.getBoundingClientRect();
  // the brand and Search stay pinned at the top of the sidebar, so an item under them counts as hidden too
  const pinned = side.querySelector(".d-side-top")?.offsetHeight || 90;
  if (ar.top < sr.top + pinned + 8 || ar.bottom > sr.bottom - 110) side.scrollTop += ar.top - sr.top - (side.clientHeight - ar.height) / 2;
}
function openSide() { side.classList.add("open"); scrim.hidden = false; revealActive(); }
function closeSide() { side.classList.remove("open"); scrim.hidden = true; }
$("[data-burger]").append(si("menu"));
$("[data-burger]").after(h("a", { class: "d-top-mark", href: "#/", "aria-label": "Desk home" }, h("img", { src: "/img/logo-3d-128.png", alt: "", width: "128", height: "128" })));
$("[data-burger]").addEventListener("click", () => (side.classList.contains("open") ? closeSide() : openSide()));
scrim.addEventListener("click", closeSide);

/* ---------- mobile tab bar ---------- */
// 24 Nov 2026 (same member, correction): Market is the main target for users, so it takes back the Launch slot; Launch stays
// one tap away on Home, in the menu (pinned tile on desktop) and in Search.
// one tap to each job: Home, Market, Ask, Agent, Portfolio (the Inbox count rides on Portfolio). Launch and Agent took the
// Discover and Chat places (community request, 23 Nov 2026: "the agent and the launchpad are the important things on the
// platform"). Nothing left the phone: Market is on Home ("Buy a coin", "Full market"), in Search and in the menu, and the
// community chat moved to a button in the top bar with its unread count (Trade gave its tab to Chat earlier the same day;
// Swap is on every coin's Buy). The chat module (chat.js) answers the "troya:chat-open" event and reports
// { open, unread } back with "troya:chat-state".
const chatBadge = h("span", { class: "badge", hidden: true });
const chatTop = h("button", { type: "button", class: "icon-btn d-chat-top", "aria-label": "Community chat", title: "Community chat", "aria-pressed": "false",
  onclick: () => dispatchEvent(new CustomEvent("troya:chat-open")) }, si("chat"), chatBadge);
addEventListener("troya:chat-state", (e) => {
  const { open = false, unread = 0 } = e.detail || {};
  chatTop.setAttribute("aria-pressed", String(!!open));
  chatTop.setAttribute("aria-label", unread && !open ? `Community chat, ${unread} new` : "Community chat");
  chatBadge.hidden = !unread || open; chatBadge.textContent = unread > 9 ? "9+" : String(unread || "");
});
clear($("[data-tabbar]"),
  h("a", { href: "#/", "data-tab": "" }, si("desk"), h("span", {}, "Home")),
  h("a", { href: "#/market", "data-tab": "Discover" }, si("market"), h("span", {}, "Market")),
  h("button", { type: "button", class: "d-tab-ask", onclick: () => askTroya() }, h("i", { class: "mark" }), h("span", {}, "Ask")),
  h("a", { href: "#/agent/scepter", "data-tab": "Agent" }, si("agent"), h("span", {}, "Agent")),
  h("a", { href: "#/portfolio", "data-tab": "Portfolio", style: { position: "relative" } }, si("portfolio"), h("span", {}, "Portfolio"),
    h("i", { class: "badge", "data-inbox": "", style: { position: "absolute", top: "6px", left: "calc(50% + 6px)", fontStyle: "normal" } })));

/* ---------- top bar right ---------- */
$(".d-search-ico").append(si("search"));
const right = $("[data-right]");
let inboxCount = 0;
// dark (default) or light, remembered in this browser
function setTheme(t) {
  if (t === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("troya.theme", t); } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#ffffff" : "#000000");
  renderRight();
  requestAnimationFrame(() => silk?.resume());
}
/* the chain chip: a real button. Not connected or already on Robinhood Chain: a small card says where Troya trades.
   Connected elsewhere: a warning tint, and a click asks the wallet to switch (the wallet shows its own prompt; nothing is signed or sent). */
const MAIN = CHAINS.robinhood;
let pop = null;
function closePop() {
  if (!pop) return;
  pop.el.remove(); pop.anchor?.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", pop.outside, true);
  removeEventListener("resize", closePop);
  pop = null;
}
function chainPop(anchor) {
  if (pop) { const again = pop.anchor === anchor; closePop(); if (again) return; }
  const on = !!wallet.address;
  const el = h("div", { class: "d-pop", role: "dialog", "aria-label": "Network", id: "d-chain-pop" },
    h("div", { class: "d-pop-h" }, chainLogo("robinhood", 22), h("b", {}, `Troya trades on ${MAIN.name} (${MAIN.id})`)),
    h("p", {}, on ? `Your wallet is on ${MAIN.name}, where swaps, launches and the Gate run. A trade on another network asks your wallet to switch first.`
      : "Connect a wallet and Troya adds the network for you the first time a trade needs it. Nothing is signed until you approve it in your wallet."),
    h("div", { class: "d-pop-a" },
      on ? h("a", { class: "btn", href: "#/bridge" }, "Bridge ETH in")
        : h("button", { class: "btn primary", type: "button", onclick: () => { closePop(); openConnect(); } }, "Connect wallet"),
      h("a", { class: "link", href: MAIN.explorer, target: "_blank", rel: "noopener" }, "Explorer")));
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth;
  el.style.top = `${r.bottom + 8}px`;
  el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  pop = { el, anchor, outside };
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  addEventListener("resize", closePop);
  el.addEventListener("click", (e) => { if (e.target.closest("a")) closePop(); });
}
async function switchToMain(btn) {
  btn.disabled = true;
  try { await ensureChain("robinhood"); toast(`Wallet switched to ${MAIN.name}`, "ok"); }
  catch (e) { toast(e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || "") ? "Network switch cancelled in the wallet." : (e?.message || "Could not switch the network."), "error"); }
  finally { btn.disabled = false; }
}
function renderRight() {
  const c = chainById(wallet.chainId);
  const elsewhere = !!wallet.address && wallet.chainId != null && Number(wallet.chainId) !== MAIN.id;
  const name = c?.name || `Chain ${wallet.chainId}`;
  const chip = h("button", { class: `chain-chip${wallet.address ? "" : " off"}${elsewhere ? " warn" : ""}`, type: "button",
    title: elsewhere ? `Your wallet is on ${name}. Click to switch to ${MAIN.name}.` : wallet.address ? `Your wallet is on ${MAIN.name}` : `Troya trades on ${MAIN.name}`,
    "aria-label": elsewhere ? `Wallet on ${name}. Switch to ${MAIN.name}` : `Network: ${MAIN.name}`,
    ...(elsewhere ? {} : { "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "d-chain-pop" }),
    onclick: (e) => (elsewhere ? switchToMain(e.currentTarget) : chainPop(e.currentTarget)) },
    chainLogo(wallet.address ? (c?.key || "") : "robinhood", 16), wallet.address ? name : MAIN.name);
  if (pop) closePop();          // the chip is drawn anew, so a card left open would point at nothing
  const bell = h("a", { class: "icon-btn d-bell", href: "#/portfolio/inbox", "aria-label": "Inbox" }, si("inbox"), inboxCount ? h("span", { class: "badge" }, inboxCount > 9 ? "9+" : inboxCount) : null);
  // connected but not signed in: a small "Sign in" tag on the button, so the missing step is visible before a feature asks
  const unsigned = !!wallet.address && !wallet.session;
  const wbtn = wallet.address
    ? h("button", { class: `wallet-btn on${unsigned ? " unsigned" : ""}`, type: "button", onclick: walletMenu,
        ...(unsigned ? { title: "Connected, not signed in", "aria-label": `Wallet ${short(wallet.address)}, not signed in` } : {}) },
        h("i", { class: "av" }), short(wallet.address), unsigned ? h("span", { class: "wb-sign", "aria-hidden": "true" }, "Sign in") : null)
    : h("button", { class: "wallet-btn d-connect", type: "button", onclick: () => openConnect(), "aria-label": "Connect wallet" }, si("wallet"), h("span", {}, "Connect", h("span", { class: "wb-more" }, " wallet")));
  const gear = h("button", { class: "icon-btn", type: "button", "aria-label": "Settings", onclick: openSettings }, si("gear"));
  const light = document.documentElement.dataset.theme === "light";
  const mode = h("button", { class: "icon-btn d-mode", type: "button", "aria-label": light ? "Dark mode" : "Light mode", title: light ? "Dark mode" : "Light mode", onclick: () => setTheme(light ? "dark" : "light") }, si(light ? "moon" : "sun"));
  // the site language (public/js/i18n.js): English, 中文, 日本語 … ; it also sets the assistant's reply language
  const langPick = window.TroyaI18n?.picker({ compact: true, cls: "d-lang" }) || null;
  clear(right, chip, langPick, chatTop, bell, mode, gear, wbtn);
  for (const el of document.querySelectorAll("[data-inbox]")) { el.textContent = inboxCount ? (inboxCount > 9 ? "9+" : inboxCount) : ""; el.hidden = !inboxCount; }
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
  // every language the site has, by its own name (public/js/i18n.js); the picker sets this too, Settings can override it
  const replyLangs = [["auto", "Same as my message"], ...(window.TroyaI18n?.langs || [["en", "EN", "English", "en"]]).map(([, , name, code]) => [code === "auto" ? "en" : code, name])];
  const lang = h("select", { class: "select" }, replyLangs.map(([v, t]) => h("option", { value: v, selected: p.lang === v }, t)));
  // the top-bar sun/moon is hidden on small phones, so the theme lives here too; it applies at once, no Save needed
  const look = seg([{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }], document.documentElement.dataset.theme === "light" ? "light" : "dark", (v) => setTheme(v), "d-look");
  look.setAttribute("aria-label", "Appearance");
  const m = modal({ title: "Settings", body: h("div", { style: { display: "grid", gap: "14px" } },
    h("div", { class: "field" }, h("span", {}, "Appearance"), look),
    window.TroyaI18n ? h("div", { class: "field" }, h("span", {}, "Language"), window.TroyaI18n.picker({ cls: "d-lang-set" })) : null,
    h("label", { class: "field" }, h("span", {}, "Default swap slippage (%)"), slip),
    h("label", { class: "field" }, h("span", {}, "Assistant reply language"), lang),
    h("p", { class: "note" }, "Appearance, slippage and language are kept in this browser only."),
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
clear($("[data-foot]"),
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

/* ---------- Search palette (⌘K): find a coin or a page, gate a pasted address, or hand a question to Ask Troya ---------- */
// it is called Search everywhere; "Ask Troya" names only the chat panel, so the two never get mixed up
const ASKS = ["What is moving on Robinhood Chain right now?", "Show funding extremes on Hyperliquid", "What should I watch today?"];
function openAsk(prefill = "") {
  const input = h("input", { class: "d-pal-in", placeholder: matchMedia("(max-width: 560px)").matches ? "Search coins and pages" : "Search coins and pages, paste an address, or type a question", value: prefill, "aria-label": "Search", autocomplete: "off", spellcheck: "false" });
  let sel = 0, flat = [], coins = [], perps = [], coinQ = "", majorQ = false, coinSeq = 0, coinTimer = 0, ethPx = null, ethAsked = false;
  const opts = h("div", { class: "d-pal-list", role: "listbox" });
  // coins by symbol, name or ticker: the server searches the whole chain (index, stock tokens, DexScreener) and sends
  // the matching perps (Hyperliquid and trade.xyz, by ticker or name) with them
  const findCoins = () => {
    clearTimeout(coinTimer);
    const raw = input.value.trim().replace(/^\$/, "");
    if (raw.length < 2 || /0x[0-9a-fA-F]{40}/.test(raw) || raw.split(/\s+/).length > 3) { coins = []; perps = []; coinQ = ""; return; }
    coinTimer = setTimeout(async () => {
      const my = ++coinSeq;
      try {
        const r = await api.get(`search/coins?q=${encodeURIComponent(raw)}&limit=8`);
        if (my !== coinSeq) return;
        coins = r.coins || []; perps = r.perps || []; majorQ = !!r.majorQuery; coinQ = raw; render();
      } catch {}
    }, 180);
  };
  // the majors' ETH price, when the search row came without one: the same Hyperliquid mid as /api/price/eth
  const ethPrice = () => {
    if (ethAsked) return ethPx;
    ethAsked = true;
    api.get("price/eth").then((r) => { if (r?.usd > 0) { ethPx = r.usd; render(); } }).catch(() => {});
    return null;
  };
  // the quick Swap / Gate rows go with a coin people can mean by its name: a major, a stock token, the official $TROYA,
  // or a coin with $50K of real money in its pools ("btc" offered "Swap into BTC" for a $2.4K copy)
  const quickOk = (c) => !!c && c.address !== "native" && !c.copy && !c.teamTest
    && (c.kind === "major" || c.kind === "stock" || c.official || (Number(c.realLiquidityUsd) || 0) >= 50_000);
  // a coin row goes straight to Swap when Troya can route it (tradable from the search, or a major / stock token)
  const swapOk = (c) => !!c && /^0x[0-9a-fA-F]{40}$/.test(String(c.address || "")) && (c.tradable === true || c.kind === "major" || c.kind === "stock");
  // rows: { kind: "ask" | "coin" | "perp" | "page", title, hint, icon, target }
  const sections = () => {
    const raw = input.value.trim(), q = raw.toLowerCase();
    const ca = (/0x[0-9a-fA-F]{40}/.exec(raw) || [])[0];
    const out = [];
    const asks = [];
    const fmt = (n) => (n == null ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
    const px = (n) => (n == null || !(n > 0) ? null : `$${price(n)}`);
    // a single word that names a page ("swap", "perps") puts Go to first, before the coin rows that arrive ~180 ms
    // later, so Enter always opens the page; anything longer reads as a question
    const pages = FLAT.filter((it) => !q || it.t.toLowerCase().includes(q) || String(it.g || "").toLowerCase().includes(q))
      .map((it) => ({ kind: "page", title: it.t, hint: it.g || "Home", icon: it.ic, target: it.href }));
    const goTo = ["Go to", q ? pages.slice(0, 6) : pages.slice(0, 8)];
    const pageFirst = q && !/\s/.test(q) && pages.some((p) => p.title.toLowerCase().startsWith(q));
    if (pageFirst && pages.length) out.push(goTo);
    if (ca) out.push(["Check this coin", [
      { kind: "page", title: `Run Troya Gate on ${short(ca)}`, hint: "Nine checks: route, impact, depth, fees, simulation, test sell, tax", icon: "gate", target: `#/gate/${ca}` },
      { kind: "page", title: `Find the weak spot of ${short(ca)}`, hint: "Heel: a coin, a dev wallet or an agent, in one sentence with proof", icon: "heel", target: `#/heel/${ca}` },
      { kind: "page", title: `Cluster map of ${short(ca)}`, hint: "Its largest holders as bubbles, and which wallets are linked, with proof", icon: "clusters", target: `#/clusters/${ca}` },
      { kind: "page", title: `Open the token page`, hint: "Price, chart, pools and trades", icon: "market", target: `#/token/${ca}` },
      { kind: "ask", title: `Ask Troya about ${short(ca)}`, hint: "Is it safe to buy? The agent reads the checks and explains", icon: "spark", target: `Is this token safe? ${ca}` },
      { kind: "page", title: `Swap into it`, hint: "Opens Swap with the coin selected", icon: "swap", target: `#/swap?out=${ca}` },
    ]]);
    const fresh = coinQ && q.replace(/^\$/, "").startsWith(coinQ.toLowerCase().slice(0, 2));
    const coinSec = [], perpSec = [];
    if (coins.length && fresh) {
      const rows = coins.map((c) => {
        const ethLike = c.kind === "major" && (c.address === "native" || c.symbol === "WETH");
        const usd = c.priceUsd ?? (ethLike ? ethPrice() : null);
        // the money side when it is known, else the pool figure, so the rows of one ticker compare like for like (a
        // $0.00000000000004 money side read as "liq $0" next to $2.8K rows, Xivor 26 Nov 2026)
        const liq = c.realLiquidityUsd != null && c.realLiquidityUsd >= 1 ? c.realLiquidityUsd : c.liquidityUsd;
        return { kind: "coin", coin: c, title: `${c.symbol}${c.name && c.name.toLowerCase() !== String(c.symbol).toLowerCase() ? ` · ${c.name}` : ""}`,
          // the launch verdict leads the hint: at the end it was cut on a phone ("Gate at launch: pas…", Xivor 26 Nov 2026)
          hint: [c.gate ? `Gate: ${c.gate.v === "notes" ? "passed w/ notes" : c.gate.v}` : null, swapOk(c) ? "Buy on Swap" : null, c.official ? "Official" : c.teamTest ? "Team test" : null,
            c.kind === "stock" ? "Robinhood stock token" : c.kind === "major" ? "Major" : c.launchpad ? padName(c.launchpad) : null,
            px(usd), liq ? `liq ${fmt(liq)}` : null, c.address === "native" ? "Native" : short(c.address)].filter(Boolean).join(" · "),
          // a coin Troya can route opens Swap with it selected, ready to buy (community request, 23 Nov 2026: one tap
          // from search to Swap, as the Market's Buy does); the Gate still runs there before anything is signed
          target: c.address === "native" ? "#/swap" : swapOk(c) ? `#/swap?out=${c.address}` : `#/token/${c.address}` };
      });
      const t = coins[0];
      if (t && t.address !== "native" && swapOk(t)) rows.splice(1, 0,
        { kind: "page", title: `Open the ${t.symbol} page`, hint: "Price, chart, holders and trades", icon: "market", target: `#/token/${t.address}` },
        ...(quickOk(t) ? [{ kind: "page", title: `Gate ${t.symbol}`, hint: "Nine checks before you buy", icon: "gate", target: `#/gate/${t.address}` }] : []));
      // V10 name clash: more contracts carry this ticker than the list shows, so say how many and open them all
      const shown = coins.filter((c) => c.kind === "coin" && String(c.symbol).toLowerCase() === String(t?.symbol).toLowerCase()).length;
      if (t?.kind === "coin" && (t.sameTicker || 1) > 1) rows.push({ kind: "page", title: `${t.sameTicker} contracts share the ticker ${t.symbol}`, hint: shown < t.sameTicker ? `${t.sameTicker - shown} more not shown here · see all with liquidity` : "Same name, different coins · see all side by side", icon: "market", target: `#/market?q=${encodeURIComponent(t.symbol)}` });
      coinSec.push(["Coins", rows]);
    }
    if (perps.length && fresh) {
      const names = perps.map((p) => p.displayName);
      perpSec.push(["Perps", perps.map((p) => ({ kind: "perp", perp: p,
        // two markets under one name (SK hynix) say which ticker each is
        title: names.filter((n) => n === p.displayName).length > 1 ? `${p.displayName} (${p.label})` : p.displayName,
        hint: [p.dex === "xyz" ? "perp on Hyperliquid (trade.xyz)" : "perp on Hyperliquid", px(p.priceUsd), p.maxLeverage ? `up to ${p.maxLeverage}x` : null].filter(Boolean).join(" · "),
        target: `#/perps/${p.coin}` }))]);
    }
    // BTC, ETH and SOL: the majors and their perps lead (a $2.4K "BTC" copy came first); otherwise the coins do
    if (majorQ) out.push(...perpSec, ...coinSec); else out.push(...coinSec, ...perpSec);
    if (raw && !ca) asks.push({ kind: "ask", title: raw, hint: "Ask Troya: answered right here, in the popup", icon: "spark", target: raw });
    for (const a of ASKS) if (!q || a.toLowerCase().includes(q)) asks.push({ kind: "ask", title: a, hint: "Ask Troya", icon: "spark", target: a });
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
        it.coin ? h("span", { class: "d-pal-ic coin" }, tokenIcon(it.coin)) : it.perp ? h("span", { class: "d-pal-ic coin" }, coinIcon(it.perp.coin))
          : h("span", { class: `d-pal-ic ${it.kind}` }, si(it.icon || "desk")), h("span", { class: "d-pal-t" }, h("b", {}, it.title), h("small", {}, it.hint)), h("kbd", {}, "↵")); }))));
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
  const m = modal({ body: h("div", { class: "d-pal" }, h("div", { class: "d-pal-top" }, h("span", { class: "d-pal-spark" }, si("search")), input), opts, foot) });
  m.box.classList.add("palette", "d-pal-box");
  m.body.style.padding = "0";
  render();
  if (prefill) findCoins();          // opened with words already in it (the 404 page): look for coins too, as if they were typed
  setTimeout(() => input.focus(), 30);
}
for (const b of document.querySelectorAll("[data-ask]")) b.addEventListener("click", () => openAsk());
for (const b of document.querySelectorAll(".d-ask-ico")) b.append(si("search"));   // the sidebar button is Search now; the spark stays with Ask Troya
// Troya Guide on every page: what it is for, a walk-through, questions for the agent (answered in the drawer)
mountGuide({ askFn: (q) => openDrawer(q) });
mountChat(document.body);
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openAsk(); }
  else if (e.key === "Escape" && pop) { const a = pop.anchor; closePop(); a?.focus(); }
  else if (e.key === "Escape" && document.body.classList.contains("drawer-open") && !document.querySelector(".modal-bg")) closeDrawer();
});
window.troya = { go, openAsk, openConnect, signIn, CHAINS, ask: openDrawer };

// the coins born through Troya, so every logo of one carries the horse badge
api.get("/api/launch/born").then((d) => setBorn(d?.tokens, d?.graduated, { all: true })).catch(() => {});
addEventListener("hashchange", route);
restore();
renderRight();
route();
// a web launch whose record call missed (closed tab, slow block) is sent again on any Desk visit, not only from two pages;
// the module loads only when this browser holds one
try { if (JSON.parse(localStorage.getItem("troya.pendingLaunches") || "[]").length) import("/agent/js/pages/launch-create.js").then((m) => (m.hasPending() ? m.recordPending() : null)).catch(() => {}); } catch {}
// Autopilot lives in the Agent page module and starts itself when switched on; load it on any page so it keeps running in this tab
if (store("troya.autopilot", { on: false }).get().on) import("/agent/js/pages/agent.js").catch(() => {});
