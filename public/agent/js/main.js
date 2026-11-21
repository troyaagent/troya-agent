// App shell: top bar, hash router, footer, Ask palette, settings. Pages live in ./pages/<name>.js
// and export `mount(view, ctx)` that returns an optional cleanup function.
import { h, $, clear, icon, toast, modal, short, store, chainLogo } from "./ui.js";
import { wallet, onWallet, openConnect, restore, disconnect, signIn, CHAINS, chainById } from "./wallet.js";
import { api } from "./api.js";

const SITE = window.SITE || {};
const NAV = [
  ["Home", "#/"], ["Market", "#/market"], ["Swap", "#/swap"], ["Perps", "#/perps"],
  ["Launchpad", "#/launch"], ["Bridge", "#/bridge"], ["Agent", "#/agent"], ["Portfolio", "#/portfolio"],
];
// route table: first path segment → page module; the rest is passed as ctx.parts
const ROUTES = {
  "": "home", market: "market", token: "token", swap: "swap", perps: "perps", launch: "launchpad",
  bridge: "bridge", agent: "agent", assistant: "agent", portfolio: "portfolio", docs: "docs", start: "start", leaderboard: "leaderboard",
  stake: "stake",
};
export const prefs = store("troya.prefs", { slippage: 1, density: "comfortable", motion: "system", lang: "auto" });

const view = $("#view");
let cleanup = null;
let routeId = 0;

function parse() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { name: ROUTES[parts[0] || ""] ? parts[0] || "" : null, parts: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)), raw };
}
export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

async function route() {
  const id = ++routeId;
  const r = parse();
  // #/settings is a dialog, not a page
  if (r.raw.split("?")[0].replace(/\/$/, "") === "settings") { history.replaceState(null, "", "#/"); openSettings(); return route(); }
  const page = r.name == null ? null : ROUTES[r.name];
  // nav highlight
  const top = "#/" + (r.name === "token" ? "market" : r.name === "assistant" ? "agent" : r.name || "");
  for (const a of document.querySelectorAll("[data-nav] a")) {
    const match = a.getAttribute("href") === (top === "#/" ? "#/" : top);
    a.toggleAttribute("aria-current", match);
    if (match) a.setAttribute("aria-current", "page");
  }
  try { cleanup?.(); } catch {}
  cleanup = null;
  view.classList.toggle("wide", page === "perps");
  if (!page) { clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "This page does not exist."), h("a", { class: "link", href: "#/" }, "Back to Home"))); return; }
  clear(view, h("div", { style: { padding: "60px 0" } }, h("div", { class: "sk", style: { height: "40px", width: "240px" } })));
  let mod;
  try { mod = await import(`./pages/${page}.js`); }
  catch (e) {
    console.error(e);
    if (id === routeId) clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "This page failed to load."), h("div", {}, String(e.message || e))));
    return;
  }
  if (id !== routeId) return;
  clear(view);
  window.scrollTo(0, 0);
  try { cleanup = (await mod.mount(view, { parts: r.parts, query: r.query, go, prefs })) || null; }
  catch (e) { console.error(e); clear(view, h("div", { class: "empty", style: { padding: "120px 0" } }, h("b", {}, "Something broke on this page."), h("div", {}, String(e.message || e)))); }
  document.title = `${(NAV.find(([, href]) => href === top)?.[0] || page[0].toUpperCase() + page.slice(1))} · Troya Agent`;
}

/* ---------- top bar ---------- */
clear($("[data-nav]"), NAV.map(([t, href]) => h("a", { href }, t)));
const right = $("[data-right]");
let inboxCount = 0;
function renderRight() {
  const c = chainById(wallet.chainId);
  const chip = h("span", { class: `chain-chip ${wallet.address ? "" : "off"}`, title: wallet.address ? `Wallet network: ${c?.name || "chain " + wallet.chainId}` : "Main network" },
    chainLogo(wallet.address ? (c?.key || "") : "robinhood", 16), wallet.address ? (c?.name || `Chain ${wallet.chainId}`) : "Robinhood Chain");
  const xLink = /^https:\/\/(x|twitter)\.com\//.test(SITE.x || "") ? h("a", { class: "icon-btn x-link", href: SITE.x, target: "_blank", rel: "noopener", "aria-label": "Troya Agent on X", title: "Troya Agent on X" }) : null;
  if (xLink) xLink.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const tgLink = /^https:\/\/t\.me\//.test(SITE.telegram || "") ? h("a", { class: "icon-btn x-link", href: SITE.telegram, target: "_blank", rel: "noopener", "aria-label": "Troya Agent on Telegram", title: "Troya Agent on Telegram" }) : null;
  if (tgLink) tgLink.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="tg"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>';
  const ghLink = /^https:\/\/github\.com\//.test(SITE.github || "") ? h("a", { class: "icon-btn x-link gh-link", href: SITE.github, target: "_blank", rel: "noopener", "aria-label": "Troya Agent on GitHub", title: "Troya Agent on GitHub" }) : null;
  if (ghLink) ghLink.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" class="gh"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  const bell = h("a", { class: "icon-btn", href: "#/portfolio/inbox", "aria-label": "Inbox" }, icon("bell"), inboxCount ? h("span", { class: "badge" }, inboxCount > 9 ? "9+" : inboxCount) : null);
  const wbtn = wallet.address
    ? h("button", { class: "wallet-btn on", type: "button", onclick: walletMenu }, h("i", { class: "av" }), short(wallet.address))
    : h("button", { class: "wallet-btn", type: "button", onclick: () => openConnect(), "aria-label": "Connect wallet" }, icon("wallet"), h("span", {}, "Connect", h("span", { class: "wb-more" }, " wallet")));
  const gear = h("button", { class: "icon-btn", type: "button", "aria-label": "Settings", onclick: openSettings }, icon("gear"));
  clear(right, chip, xLink, tgLink, ghLink, bell, wbtn, gear);
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
  const lang = h("select", { class: "select" }, [["auto", "Same as my message"], ["en", "English"]].map(([v, t]) => h("option", { value: v, selected: p.lang === v }, t)));
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

/* ---------- Ask palette (⌘K) ---------- */
const QUICK = [
  ["What is moving on Robinhood Chain right now?", "Ask"], ["Show funding extremes on Hyperliquid", "Ask"], ["Is this token safe? (paste an address)", "Ask"],
  ["Open Swap", "#/swap"], ["Open Perps", "#/perps"], ["Open Bridge", "#/bridge"], ["Create coin", "#/launch/create"], ["Read the docs", "#/docs"],
];
function openAsk(prefill = "") {
  const input = h("input", { placeholder: "Ask Troya, or jump to a page…", value: prefill, "aria-label": "Ask Troya" });
  let sel = 0;
  const opts = h("div", { class: "opts" });
  const items = () => {
    const q = input.value.trim().toLowerCase();
    const list = QUICK.filter(([t]) => !q || t.toLowerCase().includes(q));
    if (q) list.unshift([input.value.trim(), "Ask"]);
    return list.slice(0, 8);
  };
  const run = ([t, target]) => { m.close(); if (target === "Ask") go(`#/agent?q=${encodeURIComponent(t)}`); else go(target); };
  const render = () => {
    const list = items();
    sel = Math.min(sel, list.length - 1);
    clear(opts, list.map((it, i) => h("button", { class: `opt ${i === sel ? "sel" : ""}`, type: "button", onclick: () => run(it) }, icon(it[1] === "Ask" ? "spark" : "arrowRight"), it[0], h("small", {}, it[1] === "Ask" ? "Ask the agent" : "Go"))));
  };
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    const list = items();
    if (e.key === "ArrowDown") { sel = (sel + 1) % list.length; render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = (sel - 1 + list.length) % list.length; render(); e.preventDefault(); }
    else if (e.key === "Enter" && list[sel]) run(list[sel]);
  });
  const m = modal({ body: h("div", { class: "palette" }, input, opts) });
  m.box.classList.add("palette");
  m.body.style.padding = "0";
  render();
  setTimeout(() => input.focus(), 30);
}
$("[data-ask]").addEventListener("click", () => openAsk());
addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openAsk(); } });
window.troya = { go, openAsk, openConnect, signIn, CHAINS };

addEventListener("hashchange", route);
restore();
route();
// Autopilot lives in the Agent page module and starts itself when switched on; load it on any page so it keeps running in this tab
if (store("troya.autopilot", { on: false }).get().on) import("./pages/agent.js").catch(() => {});
