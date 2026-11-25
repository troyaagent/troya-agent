// Agent page: Chat · Wallet (Agent Wallet + API tokens) · Autopilot (+ limits) · Playbooks.
import { h, clear, icon, toast, modal, review, short, greeting, useCss, every, store, copyText, ago, num, usd, esc, chainLogo, tokenIcon, coinIcon } from "../ui.js";
import { api, stream } from "../api.js";
import { coinSuggest } from "../coinsearch.js";
import { wallet, onWallet, signIn, openConnect, signerFor, reader } from "../wallet.js";
import { waitReceipt, errText } from "../chain.js";
import { parseEther } from "ethers";
import { mountScepter, guestPreview, exampleRow } from "./scepter.js";

const TABS = [["chat", "Chat"], ["scepter", "Scepter"], ["wallet", "Wallet"], ["autopilot", "Autopilot"], ["sentry", "Sentry Autopilot"], ["aegis", "Aegis"], ["arena", "Arena"], ["playbooks", "Playbooks"]];
const autoPref = store("troya.autopilot", { on: false, playbooks: true, chat: false });

/* ---------- tiny safe markdown (escape first, then format) ---------- */
function md(text) {
  const lines = esc(text).split("\n");
  let html = "", list = 0;
  const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, "$1<i>$2</i>");
  for (const raw of lines) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (m) {
      const depth = m[1].length >= 2 ? 2 : 1;
      while (list < depth) { html += "<ul>"; list++; }
      while (list > depth) { html += "</ul>"; list--; }
      html += `<li>${inline(m[2])}</li>`;
    } else {
      while (list) { html += "</ul>"; list--; }
      if (raw.trim()) html += `<p>${inline(raw)}</p>`;
    }
  }
  while (list) { html += "</ul>"; list--; }
  return html;
}

function needSignIn(box, text) {
  return h("div", { class: "ag-signin" },
    h("div", {}, h("b", {}, wallet.address ? "Sign in to continue" : "Connect a wallet to continue"), h("p", {}, text)),
    h("button", { class: "btn primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), wallet.address ? "Sign in" : "Connect wallet"));
}

// Caps live in one place now, the Budget on Agent → Scepter (the strictest of the Agent Wallet caps, the user's limits and
// the operator caps, server/policy.mjs getBudget). The Wallet and Autopilot tabs used to carry their own cap forms, and the
// numbers on them disagreed with what applied; they keep a short link instead.
function budgetLink(text) {
  return h("div", { class: "panel ag-panel" }, h("h3", {}, "Caps"),
    h("p", { class: "note", style: { margin: 0 } }, text),
    h("div", { class: "row" }, h("a", { class: "btn", href: "#/agent/scepter" }, "Open Budget in Scepter")));
}
// an Example log line for a guest preview: text and a dot, no amount and no time
const exampleLog = (text, kind) => h("li", {}, h("span", { class: `ag-dot s-${kind}` }), h("div", { class: "grow" }, text), h("span", { class: "faint" }, "Example"));

// a tab repaints only when who is looking changes (wallet or sign-in). onWallet also fires on every network switch, and a
// switch in the middle of a signature (Add ETH, Buy checks, Follow) must not rebuild the page under the user or wipe a field.
// onWallet calls back once at once, so this is also the tab's first paint: no separate render() before it.
const whoKey = () => `${wallet.address || ""}|${wallet.session?.address || ""}`;
function onWho(fn) { let key = null; return onWallet(() => { const k = whoKey(); if (k === key) return; key = k; fn(); }); }
// repaint without losing the keyboard: the control that had focus (marked data-k) gets it back in the new markup
function keepFocus(root, paint) {
  const k = root.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
  paint();
  if (k) root.querySelector(`[data-k="${k}"]`)?.focus();
}
// a timed refresh leaves alone a part with a field being typed in: a repaint would drop the caret (and an unsaved value)
const inUse = (el) => { const a = document.activeElement; return !!a && el.contains(a) && a.matches("input, textarea, select"); };
const show = (el, on) => { el.style.display = on ? "" : "none"; };

const CHAIN_NAME = { 1: "Ethereum", 42161: "Arbitrum", 8453: "Base", 4663: "Robinhood Chain" };
const CHAIN_KEY = { 1: "ethereum", 42161: "arbitrum", 8453: "base" };

export async function mount(view, ctx) {
  useCss("agent");
  const tab = TABS.some(([k]) => k === ctx.parts[0]) ? ctx.parts[0] : "chat";
  const nav = h("nav", { class: "ag-tabs", "aria-label": "Agent sections" }, TABS.map(([k, t]) => h("a", { href: k === "chat" ? "#/agent" : `#/agent/${k}`, ...(k === tab ? { "aria-current": "page" } : {}) }, t)));
  const body = h("div", { class: `ag-body ag-${tab}` });
  clear(view, h("div", { class: "ag-wrap" }, nav, body));
  // a strip wider than the screen fades at the edge that still has tabs, and keeps the open tab in view
  const edge = () => { nav.classList.toggle("more-r", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4); nav.classList.toggle("more-l", nav.scrollLeft > 4); };
  nav.addEventListener("scroll", edge, { passive: true });
  requestAnimationFrame(() => { const on = nav.querySelector("[aria-current]"); if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2); edge(); });
  const page = { chat: mountChat, scepter: mountScepter, wallet: mountWallet, autopilot: mountAutopilot, sentry: mountSentryAuto, aegis: mountAegis, arena: mountArena, playbooks: mountPlaybooks }[tab];
  return page(body, ctx);
}

/* =====================================================================================
   CHAT
   ===================================================================================== */
const SUGGEST = [
  ["eye", "What is worth watching today?"],
  ["shield", "Guard my open positions"],
  ["pool", "Show the newest Robinhood Chain pools"],
  ["loop", "Set up a weekly DCA into a tokenized stock"],
];
// a guest gets starters the guest chat answers in full (Gate checks, markets, how Troya works); the signed-in set reaches
// into the wallet (positions, tickets), which a guest would only meet as "connect a wallet"
const SUGGEST_GUEST = [
  ["shield", "Is $TROYA safe to buy?"],
  ["spark", "What is moving on Robinhood Chain?"],
  ["bolt", "What does Sentry Autopilot do?"],
  ["eye", "Show the ANT perp"],
];
// the server counts a guest's questions per network address and UTC day (10 a day). This browser keeps the last count the
// server gave, so the composer shows what is left before the first question; every answer replaces it with the server's.
const guestUse = store("troya.guestUse", null);
const utcDay = () => new Date().toISOString().slice(0, 10);
function guestLeft() {
  const u = guestUse.get(), limit = Number(u?.limit) || 10;
  return { limit, left: u?.day === utcDay() ? Math.max(0, limit - (Number(u.used) || 0)) : limit };
}

function mountChat(box, ctx) {
  let busy = false;
  let abort = null;
  const proposals = new Map();
  const suggest = h("div", { class: "ag-suggest" });
  const paintSuggest = () => clear(suggest, (wallet.session ? SUGGEST : SUGGEST_GUEST).map(([ic, t]) => h("button", { type: "button", class: "ag-card", onclick: () => send(t) }, h("span", { class: "ag-ic" }, icon(ic)), h("span", {}, t))));
  const hero = h("div", { class: "ag-hero" },
    h("h1", {}, `${greeting()}.`),
    h("p", {}, "You ask. Troya checks. You sign."),
    suggest);
  const log = h("div", { class: "ag-log", "aria-live": "polite" });
  const input = h("textarea", { class: "ag-input", rows: "1", placeholder: "Ask Troya anything…", "aria-label": "Message", maxlength: "1000" });
  const sendBtn = h("button", { class: "ag-send", type: "button", "aria-label": "Send", onclick: () => send(input.value) }, icon("arrowUp"));
  const meta = h("div", { class: "ag-meta" });
  const gateBar = h("div", { class: "ag-gatebar" });
  const composer = h("div", { class: "ag-composer" }, h("div", { class: "ag-box" }, input, sendBtn), meta);
  // chats: New chat starts fresh (the old one is kept under Chats); a guest's chat lives in this browser
  const GUEST_KEY = "troya.guestChat";
  const guestLog = { get() { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || "[]"); } catch { return []; } }, set(v) { try { localStorage.setItem(GUEST_KEY, JSON.stringify(v.slice(-30))); } catch {} } };
  const head = h("div", { class: "ag-head" });
  let chatInfo = null;
  async function paintHead() {
    const signed = !!wallet.session;
    if (signed) { try { chatInfo = await api.get("assistant/threads"); } catch { chatInfo = null; } }
    const has = signed ? (chatInfo?.current?.count || 0) > 0 || log.children.length > 0 : guestLog.get().length > 0 || log.children.length > 0;
    clear(head,
      h("span", { class: "ag-head-t" }, signed ? (chatInfo?.current?.title || "New chat") : "Guest chat",
        h("small", {}, signed ? (chatInfo?.current?.remembers ? "Troya remembers this chat, older parts as a summary" : "Troya remembers this chat") : "Kept in this browser only")),
      signed && chatInfo?.archive?.length ? h("button", { class: "btn sm ghost", type: "button", onclick: openChats }, icon("clock"), `Chats (${chatInfo.archive.length})`) : null,
      has ? h("button", { class: "btn sm", type: "button", onclick: startNew }, icon("plus"), "New chat") : null);
  }
  function resetView() { clear(log); hero.hidden = false; }
  async function startNew() {
    if (busy) return;
    if (wallet.session) { try { await api.post("assistant/new", {}); } catch (e) { return toast(e.message, "error"); } }
    else guestLog.set([]);
    resetView(); paintHead(); input.focus();
  }
  function openChats() {
    const list = chatInfo?.archive || [];
    const m = modal({ title: "Your chats", body: h("div", { class: "ag-chats" },
      list.map((t) => h("div", { class: "ag-chat-row" },
        h("button", { class: "ag-chat-open", type: "button", onclick: async () => { try { await api.post("assistant/open", { id: t.id }); m.close(); resetView(); await loadHistory(true); paintHead(); } catch (e) { toast(e.message, "error"); } } },
          h("b", {}, t.title), h("small", {}, `${t.count} messages · ${ago(t.updatedAt)} ago`)),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Delete this chat", onclick: async (e) => { e.stopPropagation(); try { await api.post("assistant/delete-chat", { id: t.id }); e.currentTarget.closest(".ag-chat-row").remove(); paintHead(); } catch (er) { toast(er.message, "error"); } } }, icon("trash")))),
      h("p", { class: "note" }, "Up to 20 earlier chats are kept for your wallet. Opening one puts the current chat in this list.")) });
  }
  clear(box, head, hero, log, h("div", { class: "ag-dock" }, gateBar, composer));

  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });

  let usage = null;
  async function refreshMeta() {
    const signed = !!wallet.session;
    clear(gateBar, signed ? null : h("div", { class: "ag-signbar" }, h("span", {}, h("span", { class: "ag-sb-long" }, wallet.address ? "Asking as a guest: answers and Gate checks. Sign in for tickets and your balances." : "Asking as a guest: answers and Gate checks, no wallet needed. Connect and sign in for tickets and your balances."), h("span", { class: "ag-sb-short" }, "Guest mode: answers and Gate checks. Sign in for tickets."), h("i", { class: "info", title: "Signing a message proves the wallet is yours. It costs nothing and sends nothing." }, "i")),
      h("button", { class: "btn sm primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, icon("wallet"), "Sign in")));
    if (signed && !usage) { try { usage = await api.get("assistant/usage"); } catch {} }
    const g = guestLeft();
    // tickets (and their 10-minute expiry) are for a signed-in wallet only, so a guest sees the questions left instead
    clear(meta,
      h("span", { class: "ag-chip" }, icon("wallet"), wallet.address ? short(wallet.address) : "No wallet"),
      signed ? (usage ? h("span", { class: "faint" }, `${usage.used}/${usage.limit} free messages today`) : null)
        : h("span", { class: "faint" }, `${g.left} of ${g.limit} guest questions left`),
      signed ? h("span", { class: "faint grow", style: { textAlign: "right" } }, "Proposals expire after 10 minutes") : null);
    input.disabled = false;
    sendBtn.disabled = false;
  }

  function addMsg(role, text) {
    hero.hidden = true;
    const body = h("div", { class: "ag-text" });
    if (role === "user") body.textContent = text; else body.innerHTML = md(text);
    const el = h("div", { class: `ag-msg ${role}` }, role === "assistant" ? h("span", { class: "ag-av" }, h("i", { class: "mark" })) : null, h("div", { class: "ag-bubble" }, body));
    log.append(el);
    el.scrollIntoView({ block: "end", behavior: "smooth" });
    return { el, body };
  }

  async function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    // not signed in: guest mode (answers and Gate checks, no tickets), see the note under the input
    busy = true;
    input.value = "";
    input.style.height = "auto";
    addMsg("user", text);
    const { el, body } = addMsg("assistant", "");
    const status = h("div", { class: "ag-status" }, h("span", { class: "ag-spin" }), h("span", {}, "Thinking…"));
    const tools = h("div", { class: "ag-tools" });
    el.querySelector(".ag-bubble").prepend(status, tools);
    let acc = "";
    abort = new AbortController();
    try {
      const guest = !wallet.session;
      const prior = guest ? guestLog.get().slice(-8) : undefined;
      await stream("assistant/stream", { message: text, lang: ctx.prefs.get().lang || "auto", slippage: ctx.prefs.get().slippage, ...(guest ? { history: prior } : {}) }, (type, data) => {
        if (type === "status") status.lastChild.textContent = data.text;
        else if (type === "tool") tools.append(h("span", { class: `ag-tool ${data.ok ? "" : "bad"}` }, icon(data.ok ? "check" : "close"), data.name));
        else if (type === "text") { acc += data.delta; body.innerHTML = md(acc); el.scrollIntoView({ block: "end" }); }
        else if (type === "proposal") el.querySelector(".ag-bubble").append(ticket(data.proposal));
        else if (type === "done") {
          if (data.usage?.guest) guestUse.set({ day: utcDay(), used: Number(data.usage.used) || 0, limit: Number(data.usage.limit) || 10 });
          else if (data.usage) usage = { ...usage, ...data.usage };
          if (guest && acc) guestLog.set([...guestLog.get(), { role: "user", text }, { role: "assistant", text: acc }]);
        }
        else if (type === "error") {
          body.innerHTML = md(`**${data.error}**`);
          // the server's guest limit answers "Guests get 10 questions a day…" or "Guest questions are used up…"
          if (guest && /^guest/i.test(String(data.error || ""))) { const l = guestLeft().limit; guestUse.set({ day: utcDay(), used: l, limit: l }); }
        }
      }, abort.signal);
    } catch (e) {
      if (e.name !== "AbortError") body.innerHTML = md(`**${e.message}**`);
      if (e.status === 401) { wallet.session = null; }
    } finally {
      status.remove();
      if (!tools.children.length) tools.remove();
      busy = false;
      refreshMeta();
      paintHead();
    }
  }

  /* ---------- proposal ticket ---------- */
  function ticket(p) {
    proposals.set(p.id, p);
    const card = h("div", { class: `ag-ticket k-${p.kind}` });
    const render = () => {
      const pr = p.params || {};
      const rows = [];
      if (p.kind === "swap") rows.push(["Sell", `${num(pr.amountIn, 6)} ${pr.symbolIn || "ETH"}`], ["Receive (est.)", pr.amountOut != null ? `${num(pr.amountOut, pr.amountOut < 1 ? 8 : 2)} ${pr.symbolOut}` : "–"], ["Value", pr.usd ? usd(pr.usd) : "–"], ["Slippage", `${pr.slippagePct}%`], ["Network", "Robinhood Chain"]);
      if (p.kind === "perp") rows.push(["Side", pr.side === "short" ? "Short" : "Long"], ["Market", `${pr.coin}-PERP`], ["Size", usd(pr.sizeUsd)], ["Leverage", `${pr.leverage}x`], ["Margin", usd(pr.sizeUsd / (pr.leverage || 1))], pr.tpPx ? ["Take profit", pr.tpPx] : null, pr.slPx ? ["Stop loss", pr.slPx] : null);
      if (p.kind === "bridge") rows.push(["Direction", `${CHAIN_NAME[pr.fromChain] || "?"} → ${CHAIN_NAME[pr.toChain] || "?"}`], ["Amount", `${pr.amount} ${pr.asset || "ETH"}`], ["Route", "LI.FI (quoted when you open Bridge)"]);
      if (p.kind === "hl_fund") rows.push(["Route", "Robinhood Chain → Hyperliquid"], ["Send", `${pr.amount} ETH`], ["Receive (est.)", pr.usdcEstimate ? `${num(pr.usdcEstimate, 2)} USDC` : "quoted when you sign"], ["Lands on", "your own Hyperliquid account, as USDC for perps"]);
      if (p.kind === "watch") rows.push(["Playbook", pr.type?.replace("_", " ")], ["Checked", "every 20 seconds on the server"]);
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      const live = p.status === "pending" && left > 0;
      const statusText = p.status !== "pending" ? p.status : left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "expired";
      clear(card,
        h("div", { class: "tk-h" }, h("span", { class: "badge-s blue" }, { swap: "Swap", perp: "Perp", bridge: "Bridge", watch: "Playbook", hl_fund: "Fund Hyperliquid" }[p.kind] || p.kind),
          p.kind === "perp" && pr.coin ? coinIcon(pr.coin, "sm") : p.kind === "swap" ? tokenIcon(pr.symbolIn && pr.symbolIn !== "ETH" ? { symbol: pr.symbolIn, address: pr.tokenIn, chain: "robinhood" } : { symbol: pr.symbolOut, address: pr.tokenOut, chain: "robinhood" }, "sm") : p.kind === "bridge" ? chainLogo("robinhood", 20) : p.kind === "hl_fund" ? chainLogo("hyperliquid", 20) : null,
          h("b", {}, p.summary), h("span", { class: `tk-st ${live ? "" : "off"}` }, statusText)),
        h("div", { class: "rows" }, rows.filter(Boolean).map(([k, v]) => h("div", {}, h("span", {}, k), h("span", {}, String(v))))),
        p.gate?.checks?.length ? h("ul", { class: "tk-gate" }, h("li", { class: "tk-gh" }, icon("shield"), "Troya Gate"), p.gate.checks.map((c) => h("li", { class: c.status === "skip" ? "skipped" : c.status }, h("span", {}, c.name || c.label), h("b", {}, c.status === "pass" ? "pass" : c.status === "warn" ? "check" : c.status === "skip" ? "later" : "fail"), h("small", {}, c.detail)))) : null,
        live ? h("div", { class: "tk-act" }, actions(p)) : null);
    };
    render();
    const id = setInterval(() => { if (!card.isConnected) return clearInterval(id); render(); if (p.status !== "pending" || p.expiresAt < Date.now()) clearInterval(id); }, 1000);
    return card;

    function actions(p) {
      const done = (status, note) => { p.status = status; render(); if (note) toast(note, status === "done" || status === "submitted" ? "ok" : ""); };
      const dismiss = h("button", { class: "btn ghost sm", type: "button", onclick: async () => { try { await api.post("inbox/proposal-done", { id: p.id, status: "rejected" }); } catch {} done("rejected"); } }, "Dismiss");
      if (p.kind === "watch") return [h("button", { class: "btn primary sm", type: "button", onclick: async () => { try { const r = await api.post("agent-wallet/execute", { proposalId: p.id }); done("done", r.summary); } catch (e) { toast(e.message, "error"); } } }, icon("check"), "Turn on playbook"), dismiss];
      if (p.kind === "hl_fund") return [
        h("a", { class: "btn primary sm", href: `#/bridge?${new URLSearchParams({ dir: "hl", amount: String(p.params?.amount || "") })}`, onclick: () => { api.post("inbox/proposal-done", { id: p.id, status: "submitted", note: "Opened in Bridge" }).catch(() => {}); } }, icon("wallet"), "Sign in my wallet"),
        h("button", { class: "btn sm", type: "button", onclick: () => approveAgent(p, done) }, icon("bolt"), "Run with Agent Wallet"), dismiss];
      if (p.kind === "bridge") return [h("a", { class: "btn primary sm", href: `#/bridge?${new URLSearchParams({ dir: p.params?.fromChain === 4663 ? "out" : "in", chain: CHAIN_KEY[p.params?.fromChain === 4663 ? p.params?.toChain : p.params?.fromChain] || "arbitrum", amount: String(p.params?.amount || "") })}`, onclick: () => api.post("inbox/proposal-done", { id: p.id, status: "submitted", note: "Opened the Bridge page" }).catch(() => {}) }, icon("bridge"), "Open Bridge"), dismiss];
      const own = h("button", { class: "btn primary sm", type: "button", onclick: () => approveOwn(p, done) }, icon("wallet"), "Sign in my wallet");
      const agent = h("button", { class: "btn sm", type: "button", onclick: () => approveAgent(p, done) }, icon("bolt"), "Run with Agent Wallet");
      return [own, agent, dismiss];
    }
  }

  async function approveOwn(p, done) {
    const pr = p.params;
    if (p.kind === "swap") {
      const q = new URLSearchParams({ in: pr.tokenIn === "native" ? "eth" : pr.tokenIn, out: pr.tokenOut === "native" ? "eth" : pr.tokenOut, amount: String(pr.amountIn), proposal: p.id });
      api.post("inbox/proposal-done", { id: p.id, status: "submitted", note: "Opened in Swap" }).catch(() => {});
      done("submitted");
      ctx.go(`#/swap?${q}`);
      return;
    }
    if (p.kind === "perp") {
      try {
        const hl = await import("../hl.js");
        const st = await hl.tradingKeyStatus(wallet.address);
        if (st.state !== "approved") { toast("Enable trading on the Perps page first (one approval in your wallet), then approve again.", ""); ctx.go(`#/perps/${pr.coin}`); return; }
        const meta = await api.get("hl/meta");
        const m = (meta.markets || []).find((x) => x.coin === pr.coin);
        if (!m) throw new Error(`${pr.coin} is not available.`);
        const ok = await review({ title: "Place order", summary: p.summary, rows: [["Market", `${pr.coin}-PERP`], ["Side", pr.side], ["Size", usd(pr.sizeUsd)], ["Leverage", `${pr.leverage}x`], ["Mid now", m.midPx]], confirmLabel: "Place order" });
        if (!ok) return;
        // sized and capped from the live book: /api/hl/meta may answer from a copy up to a minute old while it refreshes
        const b = await api.get(`hl/book?coin=${encodeURIComponent(m.coin)}`).catch(() => null);
        const mid = (b?.bids?.[0] && b?.asks?.[0] ? (b.bids[0].px + b.asks[0].px) / 2 : null) || m.midPx || m.markPx;
        const r = await hl.placeOrder({ owner: wallet.address, market: m, isBuy: pr.side !== "short", size: pr.sizeUsd / mid, leverage: pr.leverage, tp: pr.tpPx || undefined, sl: pr.slPx || undefined, refPx: mid });
        await api.post("inbox/proposal-done", { id: p.id, status: "done", note: r.text }).catch(() => {});
        done("done", `Order sent: ${r.text || "ok"}`);
      } catch (e) { toast(e.message || "Order failed", "error"); }
    }
  }
  async function approveAgent(p, done) {
    let aw;
    try { aw = await api.get("agent-wallet"); } catch (e) { toast(e.message, "error"); return; }
    if (!aw.exists) { toast("Create an Agent Wallet first.", ""); ctx.go("#/agent/wallet"); return; }
    const ok = await review({ title: "Run with Agent Wallet", summary: p.summary, rows: [["Wallet", short(aw.address)], ["Per trade cap", usd(aw.caps.perTradeUsd)], ["Daily cap", usd(aw.caps.dailyUsd)]], warn: "No wallet popup: the Agent Wallet signs on its own, inside its caps and your limits.", confirmLabel: "Run it" });
    if (!ok) return;
    try {
      const r = await api.post("agent-wallet/execute", { proposalId: p.id });
      if (r.blocked) { done("blocked"); toast(`Blocked: ${r.reasons.join(" ")}`, "error", 6000); }
      else if (r.executed) done("done", r.summary);
      else { done("built"); toast(r.result?.note || "Built, not sent.", ""); }
    } catch (e) { toast(e.message, "error", 6000); }
  }

  let histSeq = 0;
  async function loadHistory(force = false) {
    if (!wallet.session) {
      if (!log.children.length) for (const m of guestLog.get().slice(-16)) addMsg(m.role, m.text);
      return;
    }
    if (log.children.length && !force) return;
    const seq = ++histSeq;
    try {
      const [hist, props] = await Promise.all([api.get("assistant/history"), api.get("inbox/proposals")]);
      // two loads can overlap (a sign-in switch, a network switch): only the newest one writes, so no message shows twice
      if (seq !== histSeq) return;
      const pm = new Map((props.items || []).map((p) => [p.id, p]));
      for (const m of (hist.messages || []).slice(-16)) {
        const { el } = addMsg(m.role, m.text);
        for (const pid of m.proposals || []) if (pm.get(pid)) el.querySelector(".ag-bubble").append(ticket(pm.get(pid)));
      }
    } catch {}
  }

  // signing in or out swaps between the guest chat (this browser) and the wallet's saved chat
  // (onWallet calls back once right away: that call is the first load, so nothing loads twice)
  let mode = wallet.session ? "signed" : "guest";
  paintSuggest();
  const off = onWallet(() => {
    const now = wallet.session ? "signed" : "guest";
    if (now !== mode) { mode = now; usage = null; resetView(); paintSuggest(); loadHistory(true); } else loadHistory();
    refreshMeta(); paintHead();
  });
  if (ctx.query.q) {
    const q = ctx.query.q;
    history.replaceState(null, "", "#/agent");
    setTimeout(() => (wallet.session ? send(q) : (input.value = q)), 400);
  }
  return () => { off(); abort?.abort(); };
}

/* =====================================================================================
   WALLET (Agent Wallet + API tokens)
   ===================================================================================== */
function mountWallet(box, ctx) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  let stopBal = null;
  // #/agent/wallet?panel=api (the Desk's "API and MCP" tool) lands on the Developer section, scrolled to and highlighted
  let wantApi = ctx?.query?.panel === "api";
  const devSection = (...panels) => {
    const sec = h("section", { id: "developer", class: "ag-col ag-dev", "aria-labelledby": "ag-dev-h" },
      h("div", { class: "ag-intro" }, h("h2", { id: "ag-dev-h" }, "Developer"), h("p", {}, "API tokens for MCP and REST, and Gate API credits for agents that call Troya Gate.")), ...panels);
    // once per visit: render() runs again after every withdraw or switch, and must not pull the page back down each time
    if (wantApi) {
      wantApi = false;
      requestAnimationFrame(() => {
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
        const p = sec.querySelector(".ag-panel");
        if (p) { p.style.transition = "box-shadow .6s ease"; p.style.boxShadow = "0 0 0 2px var(--blue, #4c8dff)"; setTimeout(() => { p.style.boxShadow = ""; }, 2400); }
      });
    }
    return sec;
  };

  async function render() {
    stopBal?.();
    if (!wallet.session) { clear(main, ...guestWallet()); return; }
    let aw;
    try { aw = await api.get("agent-wallet"); } catch (e) { clear(main, h("div", { class: "alert error" }, e.message)); return; }
    if (!aw.exists) {
      clear(main, intro(),
        h("div", { class: "panel ag-panel" },
          h("div", { class: "alert warn" }, h("b", {}, "Custodial. "), "The operator stores this wallet's key, encrypted. Keep only what you are willing to lose in it. Your own wallet is never touched."),
          h("ul", { class: "ag-points" },
            h("li", {}, "Withdrawals go only to your address: ", h("span", { class: "mono" }, short(wallet.address, 6))),
            h("li", {}, "Every action stays inside your Budget (Agent → Scepter): the strictest of its caps, your limits and the operator's"),
            h("li", {}, "Export the key any time with a fresh signature"),
            h("li", {}, "On Hyperliquid it trades as an approved agent on your account: trade-only, it cannot withdraw there")),
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { await api.post("agent-wallet/create"); toast("Agent Wallet ready", "ok"); render(); } catch (e) { toast(e.message, "error"); } } }, icon("plus"), "Create Agent Wallet")),
        devSection(tokensPanel(), gateApiPanel()));
      return;
    }
    const balBox = h("div", { class: "stats ag-bal" }, [["robinhood", "Robinhood Chain"], ["robinhood", "Tokens"], ["hyperliquid", "Hyperliquid"]].map(([lk, k]) => h("div", { class: "stat" }, h("div", { class: "k" }, chainLogo(lk, 14), k), h("div", { class: "v" }, h("span", { class: "sk", style: { display: "inline-block", width: "90px", height: "22px" } })))));
    const toggle = h("button", { class: `btn sm ${aw.enabled ? "" : "blue"}`, type: "button", onclick: async () => { try { await api.post("agent-wallet/settings", { enabled: !aw.enabled }); render(); } catch (e) { toast(e.message, "error"); } } }, aw.enabled ? icon("pause") : icon("play"), aw.enabled ? "Switch off" : "Switch on");
    const wAmt = h("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "0.0" });
    // Max: the Agent Wallet's ETH minus 0.0001 ETH it needs for the withdrawal's own gas, cut (never rounded up) to 6 decimals
    let lastEth = null;
    const wMax = h("button", { class: "chip", type: "button", title: "Everything but 0.0001 ETH kept for gas", onclick: async () => {
      try { if (lastEth == null) lastEth = (await api.get("agent-wallet/balances")).robinhoodEth; } catch { return toast("Balance unavailable right now.", "error"); }
      const v = Math.floor(Math.max(0, Number(lastEth || 0) - 0.0001) * 1e6) / 1e6;
      if (!(v > 0)) return toast("Not enough ETH in the Agent Wallet to withdraw.", "");
      wAmt.value = String(v);
    } }, "Max");
    // coins in the Agent Wallet (bought by Sentry Autopilot, Champions, the War Table or Aegis): each can be withdrawn to the
    // owner (an ERC-20 transfer the server only ever sends to the signed-in wallet) or sold to ETH through Troya Gate
    const coinBox = h("div", { class: "ag-coins" }, h("p", { class: "faint", style: { margin: 0 } }, "Reading coins…"));
    let coinKey = "";
    function paintCoins(list) {
      const key = JSON.stringify(list.map((x) => [x.address, x.amount]));
      if (key === coinKey || inUse(coinBox)) return;
      coinKey = key;
      if (!list.length) return clear(coinBox, h("p", { class: "faint", style: { margin: 0 } }, "No coins in the Agent Wallet."));
      clear(coinBox, h("ul", { class: "sc-list", style: { padding: 0, margin: 0 } }, list.map((x) => h("li", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
        h("div", {}, h("b", {}, `$${x.symbol || "?"}`), h("div", { class: "faint mono" }, `${num(x.amount, 6)} · ${short(x.address, 4)}`)),
        h("div", { class: "row", style: { gap: "6px" } },
          h("button", { class: "btn sm", type: "button", onclick: async (e) => {
            const btn = e.currentTarget;   // read before the await: currentTarget is null once the click has been dispatched
            if (!(await review({ title: `Withdraw $${x.symbol}`, rows: [["Amount", `All (${num(x.amount, 6)} ${x.symbol})`], ["Token", short(x.address, 6)], ["Network", "Robinhood Chain"], ["To", short(wallet.address, 6)]], confirmLabel: "Withdraw" }))) return;
            btn.disabled = true;
            try { const r = await api.post("agent-wallet/withdraw", { token: x.address, symbol: x.symbol, amount: "all" }); toast(r.executed ? `$${x.symbol} sent to your wallet` : r.result?.note || (r.blocked ? r.reasons.join(" ") : "Not sent"), r.executed ? "ok" : "", 5000); render(); } catch (err) { toast(err.message, "error", 6000); render(); }
          } }, "Withdraw"),
          h("button", { class: "btn sm ghost", type: "button", onclick: async (e) => {
            const btn = e.currentTarget;
            // the balance arrives as a decimal Number, which can round a hair above the raw balance and make the sell revert:
            // like the War Table's 100%, sell 99.9% of it, written as plain digits (the server refuses "1.2e+12")
            const v = Number(x.amount) * 0.999;
            const amountIn = v >= 1 ? String(Math.floor(v * 1e6) / 1e6) : v.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
            if (!(await review({ title: `Sell $${x.symbol} to ETH`, summary: "Checked by Troya Gate first and kept inside your Budget; the ETH stays in the Agent Wallet.", rows: [["Sell", `${num(Number(amountIn), 6)} ${x.symbol} (99.9% of it)`], ["For", "ETH"], ["Slippage", "5%"], ["Network", "Robinhood Chain"]], confirmLabel: "Sell" }))) return;
            btn.disabled = true;
            try { const r = await api.post("agent-wallet/execute", { kind: "swap", params: { tokenIn: x.address, tokenOut: "ETH", amountIn, slippagePct: 5 }, rationale: "Owner sold a coin from the Agent Wallet" }); toast(r.executed ? `Sold $${x.symbol}` : r.result?.note || (r.reasons || r.gate?.reasons || ["Not sent"]).join(" "), r.executed ? "ok" : "", 6000); render(); } catch (err) { toast(err.message, "error", 6000); render(); }
          } }, "Sell to ETH"))))));
    }
    // one-signature top-up from the connected wallet: the step people miss ("my ETH is in my wallet, why does the launch fail?")
    function fundRow(w) {
      const amt = h("input", { class: "input ag-fund-in", type: "number", min: "0", step: "any", value: "0.002", "aria-label": "ETH to add to the Agent Wallet" });
      const pick = (v) => h("button", { class: "chip", type: "button", onclick: () => { amt.value = v; } }, `${v} ETH`);
      // Max: everything the connected wallet holds on Robinhood Chain, less 0.0003 ETH for the transfer's own gas, cut to 6 decimals
      const max = h("button", { class: "chip", type: "button", onclick: async () => {
        try {
          const wei = await reader("robinhood").getBalance(wallet.address);
          const v = Math.floor((Number(wei) / 1e18 - 0.0003) * 1e6) / 1e6;
          if (!(v > 0)) return toast("Not enough ETH on Robinhood Chain in your wallet (keep a little for gas).", "");
          amt.value = String(v);
        } catch (e) { toast(errText(e), "error"); }
      } }, "Max");
      const go = h("button", { class: "btn primary", type: "button", onclick: async () => {
        const v = Number(amt.value);
        if (!(v > 0 && v <= 5)) return toast("Enter an amount between 0 and 5 ETH.", "error");
        const ok = await review({ title: "Add ETH to your Agent Wallet", summary: "A plain ETH transfer on Robinhood Chain from your wallet to your Agent Wallet. You can withdraw it back any time.",
          rows: [["From", short(wallet.address, 6)], ["To (Agent Wallet)", short(w.address, 6)], ["Amount", `${v} ETH`], ["Network", "Robinhood Chain"]], confirmLabel: "Continue in wallet" });
        if (!ok) return;
        go.disabled = true; go.textContent = "Waiting for your wallet…";
        try {
          const signer = await signerFor("robinhood");
          const tx = await signer.sendTransaction({ to: w.address, value: parseEther(String(v)) });
          go.textContent = "Confirming…";
          const rc = await waitReceipt("robinhood", tx.hash, { timeoutMs: 180_000 });
          if (rc?.status !== 1) throw new Error("The transfer failed on chain.");
          toast(`Added ${v} ETH to your Agent Wallet.`, "ok", 6000);
          render();
        } catch (e) { toast(errText(e), "error", 7000); go.disabled = false; go.textContent = "Add ETH"; }
      } }, icon("plus"), "Add ETH");
      return h("div", { class: "ag-fund" }, h("div", { class: "faint" }, "Add ETH from your wallet"), h("div", { class: "row wrap ag-fund-picks" }, pick("0.002"), pick("0.005"), pick("0.01"), max), h("div", { class: "row wrap" }, amt, go));
    }
    clear(main,
      h("div", { class: "panel ag-panel ag2-hero" },
        h("div", { class: "ag-aw-h" },
          h("div", {}, h("div", { class: "faint" }, "Agent Wallet"), h("div", { class: "ag-addr mono" }, aw.address, h("button", { class: "icon-btn", type: "button", "aria-label": "Copy address", onclick: () => copyText(aw.address, "Address copied") }, icon("copy")))),
          h("div", { class: "row" }, h("span", { class: `badge-s ${aw.enabled ? "blue" : ""}` }, aw.enabled ? "On" : "Off"), toggle)),
        balBox,
        fundRow(aw),
        h("p", { class: "note" }, "The Agent Wallet is separate from your own wallet: launches from X and Telegram, and every agent trade, are paid from it. Add ETH here in one signature, or send ETH on Robinhood Chain to the address above. Keep it small: this is pocket money for the agent."),
        h("div", { class: "alert warn" }, "Custodial: the operator holds this key encrypted. Withdrawals only go to ", h("span", { class: "mono" }, short(wallet.address, 6)), ".")),
      h("div", { class: "ag-grid2" },
        budgetLink("This wallet's caps, your own limits and the operator's now sit in one Budget, which shows the number that really applies."),
        h("div", { class: "panel ag-panel" }, h("h3", {}, "Withdraw to my wallet"),
          h("div", { class: "row" }, h("label", { class: "field grow" }, h("span", {}, "Amount (ETH on Robinhood Chain)"), h("div", { class: "row", style: { gap: "6px" } }, wAmt, wMax))),
          h("p", { class: "note" }, "Destination is fixed: ", h("span", { class: "mono" }, short(wallet.address, 6))),
          h("button", { class: "btn", type: "button", onclick: async () => {
            const amount = Number(wAmt.value);
            if (!(amount > 0)) return toast("Enter an amount.", "");
            if (!(await review({ title: "Withdraw", rows: [["Amount", `${amount} ETH`], ["Network", "Robinhood Chain"], ["To", short(wallet.address, 6)]], confirmLabel: "Withdraw" }))) return;
            try { const r = await api.post("agent-wallet/withdraw", { chain: "robinhood", amount }); toast(r.executed ? "Withdrawal sent" : r.result?.note || (r.blocked ? r.reasons.join(" ") : "Not sent"), r.executed ? "ok" : "", 5000); render(); } catch (e) { toast(e.message, "error", 6000); }
          } }, "Withdraw"))),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Coins in the Agent Wallet"), coinBox,
        h("p", { class: "note", style: { marginBottom: 0 } }, "Withdraw sends the whole balance of that coin to ", h("span", { class: "mono" }, short(wallet.address, 6)), ". Sell to ETH goes through Troya Gate and your Budget.")),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Hyperliquid trading"),
        h("p", { class: "note" }, "Let the Agent Wallet place perp orders on your own Hyperliquid account. You sign one approval in your wallet; the agent can trade but cannot move funds out of Hyperliquid."),
        h("button", { class: "btn", type: "button", onclick: () => approveOnHl(aw.address) }, icon("key"), "Approve on Hyperliquid")),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Key"),
        h("div", { class: "row", style: { flexWrap: "wrap" } },
          h("button", { class: "btn", type: "button", onclick: exportKey }, icon("key"), "Export private key"),
          h("button", { class: "btn danger", type: "button", onclick: del }, icon("trash"), "Delete Agent Wallet")),
        aw.exportedAt ? h("p", { class: "note" }, `Key last exported ${ago(aw.exportedAt)} ago.`) : null),
      activityPanel(),
      devSection(tokensPanel(), gateApiPanel()));
    // the chain read only knows WETH and USDG by itself, so the coins panel names the coins to read: those the jobs bought
    // (open lots) and those this Agent Wallet launched with a first buy (at most 10, the server's limit)
    const coinTokens = Promise.all([api.get("agent-wallet/lots?open=1").catch(() => null), api.get("launch/mine").catch(() => null)]).then(([lots, mine]) => {
      const set = new Set();
      for (const l of lots?.items || []) if (/^0x[0-9a-fA-F]{40}$/.test(l.token || "")) set.add(l.token.toLowerCase());
      for (const x of mine?.launches || []) if (/^0x[0-9a-fA-F]{40}$/.test(x.token || "") && String(x.wallet || "").toLowerCase() === String(aw.address || "").toLowerCase()) set.add(x.token.toLowerCase());
      return [...set].slice(0, 10).join(",");
    }).catch(() => "");
    stopBal = every(20000, async () => {
      try {
        const toks = await coinTokens;
        const b = await api.get(`agent-wallet/balances${toks ? `?tokens=${toks}` : ""}`);
        lastEth = b.robinhoodEth ?? lastEth;
        const vals = [b.robinhoodEth != null ? `${num(b.robinhoodEth, 5)} ETH` : "–", b.robinhoodTokens?.length ? b.robinhoodTokens.slice(0, 2).map((x) => `${num(x.amount, 4)} ${x.symbol}`).join(" · ") : "None", b.hyperliquid ? usd(b.hyperliquid.accountValueUsd) : "–"];
        [...balBox.querySelectorAll(".v")].forEach((el, i) => (el.textContent = vals[i]));
        paintCoins(b.robinhoodTokens || []);
      } catch {}
    });
  }

  const INTRO = "A small hot wallet the agent can use on its own, so swaps, perps and playbook actions run from chat without a wallet popup each time. Optional, capped, and yours to empty at any time.";
  function intro() {
    return h("div", { class: "ag-intro" }, h("h2", {}, "Agent Wallet"), h("p", {}, INTRO));
  }
  // a guest sees the page's real layout with Example content: dashes where a balance would be, sample receipts
  function guestWallet() {
    const example = [
      h("div", { class: "panel ag-panel ag2-hero" },
        h("div", { class: "ag-aw-h" },
          h("div", {}, h("div", { class: "faint" }, "Agent Wallet"), h("div", { class: "ag-addr mono" }, "0x… its own address, made when you create it")),
          h("div", { class: "row" }, h("span", { class: "badge-s" }, "Off"))),
        h("div", { class: "stats ag-bal" }, ["Robinhood Chain", "Tokens", "Hyperliquid"].map((k) => h("div", { class: "stat" }, h("div", { class: "k" }, chainLogo(k === "Hyperliquid" ? "hyperliquid" : "robinhood", 14), k), h("div", { class: "v" }, "–")))),
        h("p", { class: "note" }, "Add ETH from your wallet in one signature. Launches from X and Telegram, and every agent trade, are paid from here.")),
      h("div", { class: "ag-grid2" },
        budgetLink("Per-trade and daily caps for every agent, with the number that really applies."),
        h("div", { class: "panel ag-panel" }, h("h3", {}, "Withdraw to my wallet"), h("p", { class: "note", style: { margin: 0 } }, "Destination is fixed: the wallet you sign in with. Nothing else can be typed in."))),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Activity"),
        h("ul", { class: "sc-list", style: { padding: 0 } },
          exampleRow("Swap ETH → $EXAMPLE", "Sentry Autopilot · passed the Gate and your Budget", "executed"),
          exampleRow("Buy $EXAMPLE not sent", "Playbook · above the daily cap · the reason is kept", "blocked"),
          exampleRow("Withdraw ETH to your wallet", "You · to the one address it can go to", "executed", "done"))),
    ];
    return guestPreview({
      title: "Agent Wallet", intro: INTRO,
      sentence: "The Agent Wallet belongs to the wallet you sign in with. Signing costs nothing and sends nothing.",
      bullets: [
        "A small hot wallet the agent trades from, so swaps, perps and playbooks run without a wallet popup each time",
        "Withdrawals go only to the wallet you sign in with, and you can export the key at any time",
        "Every action passes Troya Gate and stays inside your Budget in Scepter",
      ],
      example,
    });
  }

  async function approveOnHl(agentAddress) {
    if (!wallet.eip) return toast("Connect your wallet first.", "");
    const nonce = Date.now();
    const message = { hyperliquidChain: "Mainnet", agentAddress, agentName: "Troya Agent", nonce };
    const typed = {
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
        "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }],
      },
      primaryType: "HyperliquidTransaction:ApproveAgent", message,
    };
    if (!(await review({ title: "Approve on Hyperliquid", rows: [["Agent", short(agentAddress, 6)], ["Name", message.agentName], ["Can do", "Place and cancel orders"], ["Cannot do", "Withdraw or transfer funds"]], confirmLabel: "Sign approval" }))) return;
    try {
      const { Signature } = await import("ethers");
      const raw = await wallet.eip.request({ method: "eth_signTypedData_v4", params: [wallet.address, JSON.stringify(typed)] });
      const sig = Signature.from(raw);
      const action = { type: "approveAgent", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", agentAddress, agentName: message.agentName, nonce };
      const r = await api.post("/api/hl/exchange", { action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null });
      if (r?.status === "ok") toast("Approved: the Agent Wallet can now trade your Hyperliquid account.", "ok", 5000);
      else toast(`Hyperliquid answered: ${JSON.stringify(r?.response || r).slice(0, 160)}`, "error", 7000);
    } catch (e) { toast(e.message?.includes("rejected") ? "Cancelled in the wallet." : e.message, "error"); }
  }

  async function exportKey() {
    if (!(await review({ title: "Export private key", warn: "Anyone with this key controls the Agent Wallet. Never paste it into a website or chat.", rows: [["Step", "Sign a fresh request in your wallet"]], confirmLabel: "Continue", danger: true }))) return;
    try {
      const { message } = await api.post("agent-wallet/export-nonce");
      const hex = "0x" + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const signature = await wallet.eip.request({ method: "personal_sign", params: [hex, wallet.address] });
      const r = await api.post("agent-wallet/export", { message, signature });
      const keyEl = h("code", { class: "ag-key" }, "•".repeat(32));
      let shown = false;
      modal({ title: "Agent Wallet key", body: h("div", {},
        h("div", { class: "alert warn", style: { marginBottom: "10px" } }, "Store it offline. Close this window when done."),
        h("div", { class: "rows" }, h("div", {}, h("span", {}, "Address"), h("span", { class: "mono" }, short(r.address, 6)))),
        keyEl,
        h("div", { class: "row", style: { marginTop: "12px" } },
          h("button", { class: "btn", type: "button", onclick: (e) => { shown = !shown; keyEl.textContent = shown ? r.privateKey : "•".repeat(32); e.currentTarget.textContent = shown ? "Hide" : "Reveal"; } }, "Reveal"),
          h("button", { class: "btn", type: "button", onclick: () => copyText(r.privateKey, "Key copied") }, icon("copy"), "Copy"))) });
      render();
    } catch (e) { toast(e.message?.includes("rejected") ? "Cancelled in the wallet." : e.message, "error"); }
  }

  async function del() {
    const inp = h("input", { class: "input", placeholder: "Type DELETE" });
    const m = modal({ title: "Delete Agent Wallet", body: h("div", { style: { display: "grid", gap: "12px" } },
      h("div", { class: "alert error" }, "The key is erased from the server. Funds still inside are lost unless you exported the key or withdrew first."),
      inp,
      h("div", { class: "row", style: { justifyContent: "flex-end" } }, h("button", { class: "btn danger", type: "button", onclick: async () => {
        try { await api.post("agent-wallet/delete", { confirm: inp.value.trim() }); m.close(); toast("Agent Wallet deleted", "ok"); render(); } catch (e) { toast(e.message, "error", 6000); }
      } }, "Delete"))) });
  }

  function tokensPanel() {
    const panel = h("div", { class: "panel ag-panel" }, h("h3", {}, "API tokens", h("span", { class: "faint", style: { fontWeight: 400, marginLeft: "8px", fontSize: "12px" } }, "for MCP and REST")));
    const list = h("div", { class: "ag-tokens" });
    const name = h("input", { class: "input", placeholder: "Name, e.g. Claude Desktop", maxlength: "40" });
    const exec = h("input", { type: "checkbox" });
    panel.append(list, h("div", { class: "row ag-tok-new" }, name, h("label", { class: "ag-check" }, exec, "Allow execution"), h("button", { class: "btn", type: "button", onclick: async () => {
      try {
        const r = await api.post("agent-api/tokens", { name: name.value || "My agent", execute: exec.checked });
        name.value = ""; exec.checked = false;
        modal({ title: "New API token", body: h("div", {}, h("div", { class: "alert warn", style: { marginBottom: "10px" } }, r.note), h("code", { class: "ag-key" }, r.token), h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn primary", type: "button", onclick: () => copyText(r.token, "Token copied") }, icon("copy"), "Copy token")), h("p", { class: "note" }, "Every token starts in dry-run. Switch dry-run off here when you want this token to execute for real.")) });
        load();
      } catch (e) { toast(e.message, "error"); }
    } }, icon("plus"), "Create")),
      h("p", { class: "note" }, "Tokens are stored hashed. Setup: ", h("a", { class: "link", href: "#/docs" }, "Docs → MCP")));
    async function load() {
      try {
        const r = await api.get("agent-api/tokens");
        clear(list, r.items.length ? r.items.map((t) => h("div", { class: "ag-tok" },
          h("div", { class: "grow" }, h("b", {}, t.name), h("div", { class: "faint mono" }, `${t.prefix}… · ${t.scopes.join(", ")} · ${t.lastUsedAt ? "used " + ago(t.lastUsedAt) + " ago" : "never used"}`)),
          t.scopes.includes("execute") ? h("button", { class: `btn sm ${t.dryRun === false ? "danger" : ""}`, type: "button", title: "Dry-run is switched per token", onclick: async () => {
            if (t.dryRun !== false && !(await review({ title: "Go live with this token", warn: "Agents using this token will execute through your Agent Wallet for real, inside your caps.", rows: [["Token", t.name]], confirmLabel: "Switch dry-run off", danger: true }))) return;
            try { await api.post("agent-api/tokens/dry-run", { id: t.id, dryRun: t.dryRun === false }); load(); } catch (e) { toast(e.message, "error"); }
          } }, t.dryRun === false ? "Live" : "Dry-run") : h("span", { class: "badge-s" }, "Read + prepare"),
          h("button", { class: "btn ghost sm", type: "button", onclick: async () => { try { await api.post("agent-api/tokens/revoke", { id: t.id }); toast("Token revoked", "ok"); load(); } catch (e) { toast(e.message, "error"); } } }, "Revoke")))
          : h("p", { class: "faint", style: { margin: "4px 0 10px" } }, "No tokens yet."));
      } catch (e) { clear(list, h("p", { class: "faint" }, e.message)); }
    }
    load();
    return panel;
  }

  // F23: Gate API credits. Agents calling the Gate with this wallet's API token spend these after the free checks.
  function gateApiPanel() {
    const panel = h("div", { class: "panel ag-panel ga-panel" }, h("h3", {}, "Gate API credits", h("span", { class: "faint", style: { fontWeight: 400, marginLeft: "8px", fontSize: "12px" } }, "for agents that call Troya Gate")));
    const body = h("div", {}, h("div", { class: "sk", style: { height: "64px" } }));
    panel.append(body);
    async function load() {
      try {
        const [info, me] = await Promise.all([api.get("/api/gate/v1"), api.get(`/api/gate/v1/credits/${wallet.address}`)]);
        const amt = h("input", { class: "input", type: "number", min: "0.1", step: "0.1", value: "1", inputmode: "decimal", "aria-label": "USDG to spend" });
        const checks = h("span", { class: "faint" });
        const upd = () => { const v = Number(amt.value); checks.textContent = v > 0 ? `= ${Math.floor(v / info.price.amount).toLocaleString("en-US")} checks` : ""; };
        amt.oninput = upd; upd();
        const buy = h("button", { class: "btn", type: "button", onclick: async () => {
          const v = Number(amt.value);
          if (!(v >= 0.1)) return toast("Spend at least 0.1 USDG.", "error");
          const ok = await review({ title: "Buy Gate API checks", summary: "USDG goes from your wallet to Troya on Robinhood Chain. Credit lands on this wallet within a minute.",
            rows: [["You send", `${v} USDG`], ["Checks", Math.floor(v / info.price.amount).toLocaleString("en-US")], ["To", short(info.payTo, 6)], ["Network", "Robinhood Chain"]], confirmLabel: "Send USDG" });
          if (!ok) return;
          buy.disabled = true; buy.textContent = "Confirm in your wallet…";
          try {
            const { sendTx, waitReceipt, errText } = await import("../chain.js");
            const raw = BigInt(Math.round(v * 10 ** info.price.decimals));
            const data = "0xa9059cbb" + info.payTo.slice(2).toLowerCase().padStart(64, "0") + raw.toString(16).padStart(64, "0");
            let hash;
            try { hash = await sendTx("robinhood", { to: info.price.token, data, value: 0 }); }
            catch (e) { toast(errText(e), "error", 6000); return; }
            buy.textContent = "Waiting for the chain…";
            const rc = await waitReceipt("robinhood", hash);
            if (!rc || rc.status !== 1) { toast("The payment did not confirm. Nothing was credited.", "error", 6000); return; }
            const c = await api.post("/api/gate/v1/credits/claim", { txHash: hash }).catch(() => null);
            toast(c ? `Credited: ${c.checksLeft.toLocaleString("en-US")} checks on this wallet` : "Paid. Credit lands within a minute.", "ok", 6000);
            load();
          } finally { buy.disabled = false; buy.textContent = "Buy checks"; }
        } }, "Buy checks");
        clear(body,
          h("div", { class: "stats ga-stats" },
            h("div", { class: "stat" }, h("div", { class: "k" }, "Credit"), h("div", { class: "v" }, `${me.balanceUsdg.toFixed(2)} USDG`), h("div", { class: "faint" }, `${me.checksLeft.toLocaleString("en-US")} checks`)),
            h("div", { class: "stat" }, h("div", { class: "k" }, "Free today"), h("div", { class: "v" }, `${me.freeLeftToday} of ${me.freePerDay}`), h("div", { class: "faint" }, me.holder ? "holder allowance" : "hold 1M $TROYA for 200 a day")),
            h("div", { class: "stat" }, h("div", { class: "k" }, "Price"), h("div", { class: "v" }, `${info.price.amount} USDG`), h("div", { class: "faint" }, "per fresh, signed check"))),
          h("div", { class: "row ga-buy" }, amt, h("span", { class: "faint" }, "USDG"), checks, buy),
          me.deposits.length ? h("ul", { class: "ga-deps" }, me.deposits.slice(0, 5).map((d) => h("li", {}, h("span", {}, `+${d.usdg} USDG`), h("span", { class: "faint" }, ago(d.at) + " ago"), h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/tx/${d.tx}`, target: "_blank", rel: "noopener" }, "tx")))) : null,
          h("p", { class: "note" }, "Your agents call ", h("code", { class: "mono" }, "GET /api/gate/v1/check/<token>"), " with an API token from above: free checks first, then this credit. Each result is signed, so other agents can verify it. ", h("a", { class: "link", href: "/api-and-mcp#gate-api", target: "_blank", rel: "noopener" }, "Gate API docs")));
      } catch (e) { clear(body, h("p", { class: "faint" }, e.message)); }
    }
    load();
    return panel;
  }

  function activityPanel() {
    const panel = h("div", { class: "panel ag-panel" }, h("h3", {}, "Activity"));
    const list = h("div", { class: "ag-journal" }, h("div", { class: "sk", style: { height: "40px" } }));
    panel.append(list);
    api.get("agent-wallet/activity").then((r) => clear(list, journalList(r.items, "No Agent Wallet activity yet."))).catch((e) => clear(list, h("p", { class: "faint" }, e.message)));
    return panel;
  }

  const off = onWho(render);
  return () => { off(); stopBal?.(); };
}

function journalList(items, empty) {
  if (!items?.length) return h("p", { class: "faint" }, empty);
  return h("ul", { class: "ag-jl" }, items.slice(0, 40).map((it) => h("li", {},
    h("span", { class: `ag-dot s-${it.status}` }),
    h("div", { class: "grow" }, h("div", {}, it.summary), it.rationale ? h("div", { class: "faint" }, it.rationale) : null),
    h("div", { class: "faint num", style: { textAlign: "right" } }, h("div", {}, it.status), h("div", {}, `${ago(it.t)} ago`)))));
}

/* =====================================================================================
   AUTOPILOT (+ limits)
   ===================================================================================== */
let autoTimer = null;
const autoLog = [];
function autoNote(text, kind = "") { autoLog.unshift({ t: Date.now(), text, kind }); autoLog.length = Math.min(autoLog.length, 40); dispatchEvent(new Event("troya:autopilot")); }
async function autoTick() {
  const pref = autoPref.get();
  if (!pref.on || !wallet.session) return;
  try {
    const r = await api.get("inbox/proposals?due=1");
    const due = (r.items || []).filter((p) => ["swap", "perp", "close"].includes(p.kind) && ((p.source === "playbook" && pref.playbooks) || (p.source !== "playbook" && pref.chat)));
    for (const p of due) {
      try {
        const x = await api.post("agent-wallet/execute", { proposalId: p.id, source: "autopilot" });
        autoNote(`${p.summary}: ${x.executed ? "executed" : x.blocked ? "blocked, " + x.reasons.join(" ") : x.result?.note || "built"}`, x.executed ? "ok" : x.blocked ? "error" : "");
      // held by the trust ladder (409 held: Approve or Watch in Scepter): a neutral note, not an error; it waits for your tap
      } catch (e) { autoNote(`${p.summary}: ${e.message}`, e?.data?.held ? "" : "error"); }
    }
    if (!due.length) autoNote("Checked: nothing due.");
  } catch (e) { autoNote(`Check failed: ${e.message}`, "error"); }
}
function startAuto() { if (!autoTimer) { autoTimer = setInterval(() => { if (!document.hidden) autoTick(); }, 30000); autoTick(); } }
function stopAuto() { clearInterval(autoTimer); autoTimer = null; }
if (autoPref.get().on) startAuto();

const AP_INTRO = "When a playbook fires, Autopilot runs it with your Agent Wallet instead of waiting for you. It works only while this browser tab is open on Troya, and only inside your Budget.";
// a guest sees the switch, the two choices and a sample log, marked Example
function guestAutopilot() {
  const example = [
    h("div", { class: "panel ag-panel" },
      h("div", { class: "ag-auto-h" },
        h("div", {}, h("b", {}, "Autopilot is off"), h("div", { class: "faint" }, "Checks for due proposals every 30 seconds while the tab is open.")),
        h("span", { class: "ag-switch" }, h("i"))),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "18px" } },
        h("label", { class: "ag-check" }, h("input", { type: "checkbox", checked: true }), "Act on playbook triggers"),
        h("label", { class: "ag-check" }, h("input", { type: "checkbox" }), "Also act on chat tickets"))),
    budgetLink("Autopilot spends inside your Budget. Caps, leverage and markets are changed there, next to the switch that stops every agent."),
    h("div", { class: "panel ag-panel" }, h("h3", {}, "This tab's Autopilot log"),
      h("ul", { class: "ag-jl" },
        exampleLog("Stop-loss ETH: executed through the Gate and your Budget", "executed"),
        exampleLog("DCA into $EXAMPLE: held for your yes (trust ladder on Approve)", "built"),
        exampleLog("Checked: nothing due.", "built"))),
  ];
  return guestPreview({
    title: "Autopilot", intro: AP_INTRO,
    sentence: "Autopilot belongs to the wallet you sign in with. Signing costs nothing and sends nothing.",
    bullets: [
      "Runs due playbook tickets with your Agent Wallet while this tab stays open on Troya",
      "Your choice to let it act on chat tickets too, or only on playbooks",
      "Inside your Budget and trust ladder in Scepter; Stop every agent halts it on the server",
    ],
    example,
  });
}

function mountAutopilot(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  async function render() {
    if (!wallet.session) { clear(main, ...guestAutopilot()); return; }
    let pol, aw;
    try { [pol, aw] = await Promise.all([api.get("policy"), api.get("agent-wallet")]); } catch (e) { clear(main, h("div", { class: "alert error" }, e.message)); return; }
    const pref = autoPref.get();
    const e = pol.effective;
    const sw = h("button", { class: `ag-switch ${pref.on ? "on" : ""}`, type: "button", role: "switch", "aria-checked": String(pref.on), disabled: !aw.exists, onclick: () => {
      const p = autoPref.get(); p.on = !p.on; autoPref.set(p); p.on ? startAuto() : stopAuto(); autoNote(p.on ? "Autopilot on in this tab." : "Autopilot off."); render();
    } }, h("i"));
    const chk = (key, label) => { const c = h("input", { type: "checkbox", checked: pref[key] }); c.onchange = () => { const p = autoPref.get(); p[key] = c.checked; autoPref.set(p); }; return h("label", { class: "ag-check" }, c, label); };
    const logBox = h("ul", { class: "ag-jl" });
    const drawLog = () => clear(logBox, autoLog.length ? autoLog.map((l) => h("li", {}, h("span", { class: `ag-dot s-${l.kind === "ok" ? "executed" : l.kind === "error" ? "failed" : "built"}` }), h("div", { class: "grow" }, l.text), h("span", { class: "faint num" }, `${ago(l.t)} ago`))) : h("li", { class: "faint" }, "Nothing yet."));
    drawLog();
    addEventListener("troya:autopilot", drawLog);
    clear(main,
      h("div", { class: "ag-intro" }, h("h2", {}, "Autopilot"), h("p", {}, AP_INTRO)),
      e.killSwitch ? h("div", { class: "alert error" }, "The operator kill switch is on. Nothing executes until it is lifted.") : null,
      // the one Stop switch lives in Scepter; this tab only says so, it does not carry a second Pause
      !e.killSwitch && e.paused ? h("div", { class: "alert warn" }, "Every agent is stopped in Scepter, so Autopilot will not act. ", h("a", { class: "link", href: "#/agent/scepter" }, "Resume in Scepter")) : null,
      h("div", { class: "panel ag-panel" },
        h("div", { class: "ag-auto-h" },
          h("div", {}, h("b", {}, pref.on ? "Autopilot is on in this tab" : "Autopilot is off"), h("div", { class: "faint" }, aw.exists ? "Checks for due proposals every 30 seconds." : "Create an Agent Wallet first (Agent → Wallet).")),
          sw),
        h("div", { class: "row", style: { flexWrap: "wrap", gap: "18px" } }, chk("playbooks", "Act on playbook triggers"), chk("chat", "Also act on chat tickets"))),
      budgetLink(pol.budget ? `Autopilot spends inside your Budget: ${usd(pol.budget.perTradeUsd)} a trade and ${usd(pol.budget.dailyUsd)} a day, ${usd(pol.budget.usedTodayUsd)} used today. Change caps, leverage and markets there, next to the switch that stops every agent.` : "Autopilot spends inside your Budget. Change caps, leverage and markets there, next to the switch that stops every agent."),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "This tab's Autopilot log"), logBox));
    main._cleanup = () => removeEventListener("troya:autopilot", drawLog);
  }
  const off = onWho(() => { main._cleanup?.(); render(); });
  return () => { off(); main._cleanup?.(); };
}

/* =====================================================================================
   PLAYBOOKS
   ===================================================================================== */
const TYPES = [["stop_loss", "Stop-loss guard"], ["take_profit", "Take-profit ladder"], ["dca", "DCA into a token"], ["twap", "TWAP (big order)"], ["alert", "Price alert"]];
const PB_INTRO = "Rules the server watches for you: stop-loss guards, take-profit ladders, DCA (plain or smart), TWAP for big orders and price alerts.";
const PB_HINT = "stop loss ETH at 3000";

function mountPlaybooks(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  let stop = null;
  async function render() {
    stop?.();
    // a guest sees what a playbook does before the sign-in, and the one-line way to make one from chat
    if (!wallet.session) {
      clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Playbooks"), h("p", {}, PB_INTRO)),
        needSignIn(main, "Playbooks belong to the wallet you sign in with."),
        h("div", { class: "panel ag-panel" }, h("h3", {}, "What you get"),
          h("ul", { class: "ag-points" },
            h("li", {}, "Stop-loss guards and take-profit ladders on your Hyperliquid perps"),
            h("li", {}, "DCA and TWAP into Robinhood Chain coins and tokenized stocks, plus price alerts"),
            h("li", {}, "Checked on the server every 20 seconds: a trigger runs inside your Agent Wallet caps, or comes to your inbox as a ticket to approve")),
          h("p", { class: "note", style: { margin: 0 } }, "Ask in chat: ", h("a", { class: "link", href: `#/agent?q=${encodeURIComponent(PB_HINT)}` }, `“${PB_HINT}”`))));
      return;
    }
    const listBox = h("div", { class: "ag-pb-list" });
    const journalBox = h("div", {});
    const form = h("div", { class: "panel ag-panel" });
    let type = "stop_loss";
    const typeSeg = h("div", { class: "seg" });
    const fields = h("div", { class: "ag-grid2" });
    const drawType = () => {
      clear(typeSeg, TYPES.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(v === type), onclick: () => { type = v; drawType(); } }, t)));
      const inp = (name, ph, t = "text") => h("label", { class: "field" }, h("span", {}, ph), h("input", { class: "input", name, type: t, step: "any", placeholder: ph }));
      const coinInp = (name, ph) => { const el = h("input", { class: "input", name, type: "text", placeholder: ph }); return h("label", { class: "field" }, h("span", {}, ph), coinSuggest(el, (c) => { el.value = c.address; })); };
      const dir = (def) => h("label", { class: "field" }, h("span", {}, "Fires when price is"), h("select", { class: "select", name: "direction" }, h("option", { value: "below", selected: def === "below" }, "at or below"), h("option", { value: "above", selected: def === "above" }, "at or above")));
      if (type === "stop_loss") clear(fields, inp("coin", "Perp, e.g. ETH"), inp("triggerPx", "Trigger price (USD)", "number"), dir("below"), inp("sizePct", "Close % of position (default 100)", "number"));
      if (type === "take_profit") clear(fields, inp("coin", "Perp, e.g. ETH"), inp("levels", "Levels price:% e.g. 4000:25, 4200:25"), dir("above"));
      if (type === "dca") clear(fields, coinInp("token", "Token: type a name or ticker, or paste its address"), inp("amountEth", "ETH per buy", "number"),
        h("label", { class: "field" }, h("span", {}, "Every"), h("select", { class: "select", name: "everyHours" }, [[1, "hour"], [4, "4 hours"], [24, "day"], [168, "week"]].map(([v, t]) => h("option", { value: v, selected: v === 24 }, t)))), inp("runs", "Number of buys (default 10)", "number"),
        h("label", { class: "row ag-smart" }, h("input", { type: "checkbox", name: "smart" }), h("span", {}, h("b", {}, "Smart DCA"), " · buy up to 1.5× when the price is under its 7-day average, as little as 0.5× when over it. Never more than ETH per buy × number of buys in total.")));
      if (type === "twap") clear(fields, coinInp("token", "Token: type a name or ticker, or paste its address"),
        h("label", { class: "field" }, h("span", {}, "Side"), h("select", { class: "select", name: "side" }, h("option", { value: "buy" }, "Buy with ETH"), h("option", { value: "sell" }, "Sell for ETH"))),
        inp("total", "Total (ETH to spend, or tokens to sell)", "number"), inp("slices", "Slices (2–48, default 6)", "number"),
        h("label", { class: "field" }, h("span", {}, "One slice every"), h("select", { class: "select", name: "everyMinutes" }, [[2, "2 min"], [5, "5 min"], [10, "10 min"], [30, "30 min"], [60, "hour"]].map(([v, t]) => h("option", { value: v, selected: v === 10 }, t)))),
        inp("maxImpactPct", "Max price impact per slice, % (default 0.4)", "number"),
        h("p", { class: "note ag-span2" }, "A slice that would move the price more than the cap waits for depth and asks again a minute later, so a big order never slams a thin pool."));
      if (type === "alert") clear(fields, inp("target", "Perp (e.g. BTC) or token address"), inp("px", "Price (USD for perps, ETH for tokens)", "number"), dir("above"));
    };
    drawType();
    const val = (n) => fields.querySelector(`[name="${n}"]`)?.value?.trim();
    clear(form, h("h3", {}, "New playbook"), typeSeg, fields,
      h("p", { class: "note" }, "Checked on the server every 20 seconds. With the Agent Wallet on (and Autopilot or not), triggers execute inside your caps; otherwise you get a ticket in your inbox."),
      h("button", { class: "btn primary", type: "button", onclick: async () => {
        try {
          let params = {};
          if (type === "stop_loss") params = { coin: val("coin"), triggerPx: Number(val("triggerPx")), direction: val("direction"), sizePct: Number(val("sizePct")) || 100 };
          if (type === "take_profit") params = { coin: val("coin"), direction: val("direction"), levels: String(val("levels") || "").split(/[,;\n]+/).map((s) => { const [px, pct] = s.split(":").map((x) => Number(x.trim())); return { px, sizePct: pct || 25 }; }).filter((l) => l.px > 0) };
          if (type === "dca" || type === "twap") {
            let token = val("token"), symbol = token;
            if (!/^0x[0-9a-fA-F]{40}$/.test(token || "")) {
              // stock tokens (NVDA, SPY…) are not on the coin board: check Robinhood's stock list first, then the coins
              const want = String(token || "").trim().replace(/^\$/, "").toLowerCase();
              const desk = await api.get("/api/stocks/desk").catch(() => null);
              let t = desk?.assets?.find((x) => x.symbol.toLowerCase() === want);
              if (!t) {
                const r = await api.get(`/api/tools/robinhood_tokens?q=${encodeURIComponent(want)}&limit=5`);
                t = r.result.tokens.find((x) => x.symbol.toLowerCase() === want) || r.result.tokens[0];
              }
              if (!t) throw new Error(`No Robinhood Chain token matches "${token}".`);
              token = t.address; symbol = t.symbol;
            }
            params = type === "twap"
              ? { token, symbol, side: val("side"), total: Number(val("total")), slices: Number(val("slices")) || 6, everyMinutes: Number(val("everyMinutes")) || 10, maxImpactPct: Number(val("maxImpactPct")) || 0.4 }
              : { token, symbol, amountEth: Number(val("amountEth")), everyHours: Number(val("everyHours")), runs: Number(val("runs")) || 10, smart: !!fields.querySelector('[name="smart"]')?.checked };
          }
          if (type === "alert") params = { target: val("target"), px: Number(val("px")), direction: val("direction") };
          const r = await api.post("watches", { type, params });
          toast(`Playbook on: ${r.item.title}`, "ok");
          render();
        } catch (e) { toast(e.message, "error", 5000); }
      } }, icon("plus"), "Create playbook"));
    clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Playbooks"), h("p", {}, PB_INTRO)),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Your playbooks"), listBox), form,
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Trigger journal"), journalBox));
    const load = async () => {
      try {
        const [w, j] = await Promise.all([api.get("watches"), api.get("journal?kind=watch&limit=40")]);
        clear(listBox, w.items.length ? w.items.map((it) => h("div", { class: "ag-pb" },
          h("span", { class: `badge-s ${it.status === "active" ? "blue" : it.status === "done" ? "" : "warn"}` }, it.status),
          h("div", { class: "grow" }, h("b", {}, it.title), it.type === "twap" ? h("div", { class: "faint" }, `${it.params.done}/${it.params.slices} slices · ${it.params.filled} of ${it.params.total} ${it.params.side === "buy" ? "ETH" : it.params.symbol}${it.params.lastNote ? ` · ${it.params.lastNote}` : ""}`) : it.params?.smart ? h("div", { class: "faint" }, `${it.params.done}/${it.params.runs} buys · ${it.params.spent || 0} of ${it.params.budget} ETH budget${it.params.lastMult ? ` · last ${it.params.lastMult.toFixed(2)}×` : ""}`) : null, h("div", { class: "faint" }, `${TYPES.find(([v]) => v === it.type)?.[1] || it.type} · ${it.lastCheck ? `checked ${ago(it.lastCheck)} ago` : "waiting for first check"}${it.lastPrice != null ? ` · last ${num(it.lastPrice, it.lastPrice < 1 ? 8 : 4)}` : ""}${it.fires?.length ? ` · fired ${it.fires.length}×` : ""}${it.lastError ? ` · ${it.lastError}` : ""}`)),
          it.status !== "done" ? h("button", { class: "btn ghost sm", type: "button", onclick: async () => { try { await api.post(`watches/${it.id}/toggle`); load(); } catch (e) { toast(e.message, "error"); } } }, it.status === "active" ? "Pause" : "Resume") : null,
          h("button", { class: "btn ghost sm", type: "button", "aria-label": "Delete", onclick: async () => { try { await api.del(`watches/${it.id}`); load(); } catch (e) { toast(e.message, "error"); } } }, icon("trash"))))
          : h("p", { class: "faint" }, `No playbooks yet. Create one below, or ask in chat: “${PB_HINT}”.`));
        clear(journalBox, journalList(j.items, "Nothing has fired yet."));
      } catch (e) { clear(listBox, h("p", { class: "faint" }, e.message)); }
    };
    stop = every(20000, load);
  }
  const off = onWho(render);
  return () => { off(); stop?.(); };
}

/* =====================================================================================
   ARENA (V7 F34): a strategy in plain words → rules → replay on The Record → 7 days on paper; AI traders side by side
   ===================================================================================== */
// each AI trader shows its model maker's mark (self-hosted SVGs in /img/logos/ai). Some marks are near-black, so they sit on
// a light tile (.ag-ar-logo) in both themes; the small one inside a line of text is the same tile, scaled down.
const AI_LOGOS = { "ai-claude": "claude", "ai-gpt": "gpt", "ai-gemini": "gemini", "ai-deepseek": "deepseek", "ai-qwen": "qwen" };
const aiMark = (id, size = 22, style = null) => AI_LOGOS[id] ? h("img", { class: "ag-ar-logo", src: `/img/logos/ai/${AI_LOGOS[id]}.svg`, alt: "", width: size, height: size,
  style: size < 22 ? { width: `${size}px`, height: `${size}px`, padding: "3px", borderRadius: "6px", verticalAlign: "middle", ...style } : style }) : null;

function mountArena(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  const ethf = (v) => (v == null || !isFinite(v) ? "–" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(4)} ETH`);
  const cls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
  const SCAN = "https://robinhoodchain.blockscout.com";
  const TRADES_SHOWN = 8;
  let draft = null, mine = null, agents = [], showAll = false, gen = 0;
  const champAmt = {};   // "ETH a trade" typed into Champions, kept across the 60-second refresh until it is saved
  const nameOf = (id) => agents.find((a) => a.id === id)?.name || String(id || "").replace(/^ai-/, "");
  const intro = h("div", { class: "ag-intro" }, h("h2", {}, "Arena"), h("p", {}, "Write a strategy in plain words. Troya turns it into rules, replays them on every coin The Record has graded, then runs them for seven days on paper at real prices on every launch Sentry passes. Five AI models trade their own strategies here too, side by side: on paper, and with a small real budget (0.01 ETH each, through the Gate). Your strategy runs on paper."));
  const text = h("textarea", { class: "input", rows: "3", placeholder: "e.g. Buy 0.01 ETH of new Pons coins once the curve raised 1 ETH, skip anything Ring Radar flags, take profit at 2.5x, cut at -25%, never hold more than 12 hours." });
  const out = h("div", {});
  const readBtn = h("button", { class: "btn primary", type: "button" }, "Read and replay");
  readBtn.addEventListener("click", async () => {
    if (!wallet.session) { toast("Sign in first", "error"); return; }
    readBtn.disabled = true; clear(out, h("p", { class: "faint" }, "Reading your strategy and replaying it on The Record…"));
    try {
      draft = await api.post("arena/strategy", { text: text.value });
      const x = draft.replay;
      const prove = h("button", { class: "btn primary", type: "button", onclick: () => proveIt(prove) }, mine ? "Replace my strategy" : "Prove it: 7 days on paper");
      clear(out,
        h("p", {}, h("b", {}, "Rules: "), draft.rulesText), draft.thesis ? h("p", { class: "faint" }, draft.thesis) : null,
        h("div", { class: "rows" },
          h("div", {}, h("span", {}, "Replayed trades"), h("span", {}, String(x.trades))),
          h("div", {}, h("span", {}, "Win rate"), h("span", {}, x.winRate != null ? `${Math.round(x.winRate * 100)}%` : "–")),
          h("div", {}, h("span", {}, "Average per trade"), h("span", {}, x.avgReturnPct != null ? `${x.avgReturnPct}%` : "–")),
          h("div", {}, h("span", {}, "Result at your size"), h("span", { class: x.pnlEth >= 0 ? "up" : "down" }, ethf(x.pnlEth))),
          h("div", {}, h("span", {}, "Worst drawdown"), h("span", {}, ethf(x.maxDrawdownEth))),
          h("div", {}, h("span", {}, "Exits"), h("span", {}, `${x.byExit.takeProfit} take-profit · ${x.byExit.stop} stop · ${x.byExit.time} time`))),
        h("p", { class: "note" }, x.caveats),
        prove);
    } catch (e) { clear(out, h("div", { class: "alert error" }, e.message)); }
    readBtn.disabled = false;
  });

  // proving again restarts the run, and the server drops the strategy's open paper trades, so a strategy already running is
  // never replaced without a look at what goes (asked fresh, so a refresh that has not landed yet cannot hide it)
  async function proveIt(btn) {
    if (!draft) return;
    btn.disabled = true;
    const fresh = await api.get("arena/me").catch(() => null);
    const cur = fresh ? fresh.agent || null : mine;
    if (cur) {
      const n = cur.stats?.open || 0, trades = `${n} open paper trade${n === 1 ? "" : "s"}`;
      const summary = (cur.status === "proving" ? "This restarts your 7 days" : `This replaces your ${cur.status === "proven" ? "proven " : ""}strategy and starts a fresh 7 days on paper`)
        + (n ? ` and closes ${trades}. They are paper: nothing is sold, and they do not count in your results.` : ".")
        + (cur.status === "proven" ? " It stops counting as proven, so anyone following it copies nothing until the new rules prove themselves." : "");
      const ok = await review({ title: "Replace my strategy", summary, rows: [["Now", cur.rulesText], ["New", draft.rulesText]], confirmLabel: "Replace my strategy", danger: true });
      if (!ok) { btn.disabled = false; return; }
    }
    try {
      await api.post("arena/prove", { text: text.value, rules: draft.rules });
      toast(cur ? "Replaced: your new strategy proves for 7 days on paper" : "Proving for 7 days on paper", "ok");
      draft = null; clear(out);
      load();
    } catch (e) { toast(e.message, "error"); btn.disabled = false; }
  }

  // one panel per part, each repainted on its own. The strategy card sits right under the intro, so the main action is on
  // the first screen; then the board, the Anthropic Round, Champions and the latest trades.
  const stratP = h("div", { class: "panel ag-panel" }), stratH = h("h3", {}, "Write a strategy"), mineBox = h("div", {});
  const boardP = h("div", { class: "panel ag-panel" }, h("div", { class: "sk", style: { height: "220px" } }));
  const antP = h("div", { class: "panel ag-panel" }), champP = h("div", { class: "panel ag-panel ch-panel" }), tradesP = h("div", { class: "panel ag-panel" }), howP = h("p", { class: "note" });
  for (const el of [mineBox, antP, champP, tradesP, howP]) show(el, false);
  clear(main, intro, stratP, boardP, antP, champP, tradesP, howP);

  function buildStrategy() {
    if (!wallet.session) {
      clear(stratP, h("h3", {}, "Write a strategy"),
        h("p", { class: "faint", style: { margin: 0 } }, "Describe it in plain words. Troya turns it into rules, replays them on The Record, then proves them for 7 days on paper at real prices."),
        needSignIn(main, "Sign in to write and prove a strategy."));
      return;
    }
    clear(stratP, stratH, mineBox, text, h("div", { class: "row" }, readBtn), out);
  }
  function paintMine() {
    stratH.textContent = mine ? "Your strategy" : "Write a strategy";
    show(mineBox, !!mine);
    if (!mine) return clear(mineBox);
    clear(mineBox,
      h("p", { style: { margin: "0 0 6px" } }, h("b", {}, `${mine.status === "proving" ? `Proving until ${new Date(mine.provingUntil).toUTCString().slice(5, 22)} UTC` : mine.status}`), ` · ${mine.rulesText}`),
      h("p", { class: "faint", style: { margin: 0 } }, `${mine.stats.closed} closed · ${ethf(mine.stats.pnlEth)}${mine.stats.open ? ` · ${mine.stats.open} open` : ""}. Proven = 5+ closed trades and a profit after 7 days. To change it, write a new one below.`));
  }

  function paintBoard(board) {
    if (!board) return clear(boardP, h("h3", {}, "The board"), h("p", { class: "faint", style: { margin: 0 } }, "The board is unavailable right now. It comes back on the next refresh."));
    const recent = board.recent || [], live = board.live || null;
    const sum = (f) => agents.reduce((t, a) => t + (f(a) || 0), 0);
    // totals from the server's one summary (same figures and labels as /arena)
    const S = board.summary || {}, z = { pnlEth: 0, trades: 0, open: 0 };
    const pc = S.paperClosed || z, po = S.paperOpen || z, lc = S.liveClosed || z, lo = S.liveOpen || z;
    const wins = recent.filter((p) => p.mode !== "live" && p.status === "closed" && p.pnlEth > 0).length, closedRecent = recent.filter((p) => p.mode !== "live" && p.status === "closed").length;
    const ais = agents.filter((a) => a.kind === "ai");
    const liveResult = S.anyLive ? lc.pnlEth : null;
    const liveBudget = live ? live.budgetPerTraderEth * ais.length : null;
    const liveLeft = live ? ais.reduce((t, a) => t + (a.live ? Number(a.live.equityEth) : live.budgetPerTraderEth), 0) : null;
    const stat = (k, v, sub, c = "") => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: `v ${c}` }, v), sub ? h("div", { class: "faint" }, sub) : null);
    const summary = h("div", { class: "stats ag-ar-sum" },
      stat("Live money", live ? `${liveLeft.toFixed(4)} ETH` : "Paper only", live ? `of ${liveBudget.toFixed(2)} ETH · ${live.budgetPerTraderEth} per AI trader` : "Live trading is off"),
      stat("Live result", liveResult == null ? "No trade yet" : ethf(liveResult), liveResult == null ? "Waits for a launch that fits a trader's rules and passes the Gate" : `${lc.trades} closed · ${ethf(lo.pnlEth)} incl. ${lo.open} open`, cls(liveResult)),
      stat("Paper result", ethf(pc.pnlEth), `${pc.trades} closed · ${ethf(po.pnlEth)} incl. ${po.open} open${closedRecent ? ` · ${Math.round((wins / closedRecent) * 100)}% wins lately` : ""}`, cls(pc.pnlEth)),
      stat("Traders", String(agents.length), `${ais.length} AI models${agents.length > ais.length ? " + strategies" : ""}`));
    const walletLine = live?.wallet ? h("p", { class: "ag-ar-wallet" }, "Live trades come from the Arena's own Agent Wallet ", h("a", { class: "mono link", href: `${SCAN}/address/${live.wallet}`, target: "_blank", rel: "noopener" }, short(live.wallet, 4)),
      ". Every buy and sell is a real transaction you can open on Blockscout.") : null;
    const card = (a, i) => {
      const open = recent.filter((p) => p.agent === a.id && p.status === "open");
      return h("div", { class: "ag-ar-card" },
        h("div", { class: "ag-ar-head" }, h("span", { class: "ag-ar-rank" }, String(i + 1)), aiMark(a.id), h("div", { class: "grow" }, h("b", {}, a.name), h("div", { class: "faint mono" }, a.kind === "ai" ? a.model : "strategy")),
          h("span", { class: `ag-ar-status ${a.status}` }, a.status)),
        h("div", { class: "ag-ar-books" },
          h("div", { class: "ag-ar-book" }, h("div", { class: "k" }, h("span", { class: "ag-ar-tag" }, "Paper")), h("div", { class: `v ${cls(a.stats.pnlEth)}` }, ethf(a.stats.pnlEth)),
            h("div", { class: "faint" }, `${a.stats.closed} closed${a.stats.winRate != null ? ` · ${Math.round(a.stats.winRate * 100)}% wins` : ""}${a.stats.open ? ` · ${a.stats.open} open (${ethf(a.stats.openPnlEth)})` : ""}`)),
          h("div", { class: "ag-ar-book live" }, h("div", { class: "k" }, h("span", { class: "ag-ar-tag live" }, "Live")),
            a.live ? [h("div", { class: `v ${cls(a.live.pnlEth + a.live.openPnlEth)}` }, ethf(a.live.pnlEth + a.live.openPnlEth)), h("div", { class: "faint" }, a.livePaused ? `Paused: no new live buys until Ring Radar catches wallets that dump together. ${Number(a.live.equityEth).toFixed(4)} of ${a.live.budgetEth} ETH left` : `${Number(a.live.equityEth).toFixed(4)} of ${a.live.budgetEth} ETH · ${a.live.closed} closed${a.live.open ? ` · ${a.live.open} open` : ""}`)]
              : [h("div", { class: "v ag-ar-wait" }, a.kind === "ai" && live ? "Ready" : "–"), h("div", { class: "faint" }, a.kind === "ai" && live ? `${live.budgetPerTraderEth} ETH waiting for its first live trade` : "Strategies trade on paper")])),
        h("p", { class: "ag-ar-rules" }, a.rulesText),
        a.thesis ? h("details", { class: "ag-ar-why" }, h("summary", {}, "Why these rules"), h("p", {}, a.thesis)) : null,
        open.length ? h("div", { class: "ag-ar-open" }, h("div", { class: "faint" }, "Holding now"), open.map((p) => h("a", { class: "chip", href: `#/token/${p.token}` }, p.mode === "live" ? h("span", { class: "ag-ar-dot" }) : null, `$${p.symbol}`, h("span", { class: cls(p.valueEth != null ? p.valueEth - p.amountEth : null) }, p.valueEth != null ? ethf(p.valueEth - p.amountEth) : "")))) : null);
    };
    clear(boardP, h("div", { class: "ag-ar-top" }, h("h3", {}, "The board"), h("a", { class: "link", href: "/arena", target: "_self" }, "Full Arena page")), summary, walletLine,
      agents.length ? h("div", { class: "ag-ar-grid" }, agents.map(card)) : h("p", { class: "faint", style: { margin: 0 } }, "The AI traders write their first rules within minutes of the Arena opening."));
  }

  // Anthropic Round: the same five AI traders, one call each on xyz:ANT (the trade.xyz perp that tracks the Nasdaq share)
  function paintAnt(a) {
    const traders = a?.traders || [];
    show(antP, traders.length > 0);
    if (!traders.length) return;
    const last = new Map();
    for (const c of a.recent || []) if (!last.has(c.agent)) last.set(c.agent, c);
    const m = Number(a.mark?.mark);
    clear(antP,
      h("div", { class: "ag-ar-top" }, h("h3", {}, "Anthropic Round"),
        h("span", { class: "row", style: { gap: "14px" } }, h("a", { class: "link", href: "#/perps/xyz:ANT" }, "Trade ANT"), h("a", { class: "link", href: "/arena#anthropic", target: "_self" }, "Full round"))),
      h("p", { class: "faint", style: { margin: 0 } }, `${m > 0 ? `ANT at $${m.toFixed(2)} on the trade.xyz perp` : "ANT on the trade.xyz perp"} · ${a.live ? "live money" : "paper"} · each AI trader goes long, short or flat on a $${a.stake} stake.`),
      h("div", { class: "ag-ar-open" }, traders.map((t) => {
        const c = t.open || last.get(t.agent);
        const now = c && c.side !== "flat" ? (c.status === "open" ? c.nowPct : c.pnlPct) : null;
        const side = !c ? "no call yet" : c.side === "flat" ? "flat" : `${c.side === "long" ? "long" : "short"} ${c.lev}x`;
        return h("span", { class: "chip", title: c?.thesis || "" }, aiMark(t.agent, 14), h("b", {}, t.name || nameOf(t.agent)), side,
          now != null && isFinite(now) ? h("span", { class: cls(now) }, `${now >= 0 ? "+" : ""}${Number(now).toFixed(1)}%`) : null);
      })));
  }

  // V8 F43 Champions: follow a proven trader into your own capped Agent Wallet. Traders that do not qualify (paused by
  // Troya, fewer than 5 live trades in profit, a loss on paper) are listed greyed out with the reason and Follow off;
  // a follow you already saved on one stays saved but buys nothing, and Unfollow stays open so you can drop it.
  function paintChamps(champs, myChamps) {
    show(champP, !!champs);
    if (!champs) return;
    const follows = myChamps?.follows || {};
    const champOk = (champs.champions || []).filter((c) => c.followable !== false);
    const champOff = [...(champs.champions || []).filter((c) => c.followable === false), ...(champs.others || [])];
    const champRow = (c) => {
      const f = follows[c.id], can = c.followable !== false;
      const amt = h("input", { class: "sc-in", type: "text", inputmode: "decimal", value: String(champAmt[c.id] ?? f?.buyEth ?? champs.buy?.def ?? 0.002), "aria-label": `ETH a trade when following ${c.name}` });
      amt.addEventListener("input", () => { champAmt[c.id] = amt.value; });
      const rec = [c.live ? `Live ${ethf(c.live.pnlEth + (c.live.openPnlEth || 0))} · ${c.live.closed} closed` : null, `Paper ${ethf(c.paper?.pnlEth)} · ${c.paper?.closed || 0} closed`].filter(Boolean).join(" · ");
      return h("div", { class: `ch-row${f?.on && can ? " on" : ""}` },
        h("div", { class: "ch-who", style: can ? null : { opacity: ".55" } }, aiMark(c.id),
          h("div", {}, h("b", {}, c.name), h("div", { class: "faint" }, `${rec} · ${c.followers} following`),
            can ? null : h("div", { class: "faint" }, f?.on ? `${c.reason}. Your follow is saved but buys nothing until it qualifies again.` : c.reason))),
        wallet.session ? h("div", { class: "ch-act" }, can ? [amt, h("span", { class: "faint" }, "ETH a trade")] : null,
          h("button", { class: `btn sm ${f?.on || !can ? "" : "primary"}`, type: "button", "data-k": `follow-${c.id}`, disabled: !can && !f?.on, title: can ? null : c.reason, onclick: async () => {
            try {
              await api.post("champions/follow", { agentId: c.id, buyEth: Number(amt.value), on: !f?.on });
              delete champAmt[c.id];
              toast(f?.on ? `Stopped following ${c.name}.` : `Following ${c.name}. Each trade passes the Gate, your caps and your trust ladder (Agent → Scepter).`, "ok");
              load();
            } catch (e) { toast(e.message, "error"); }
          } }, f?.on ? "Unfollow" : "Follow")) : null);
    };
    clear(champP,
      h("div", { class: "ag-ar-top" }, h("h3", {}, "Champions"), h("span", { class: "faint" }, "Follow a proven trader")),
      h("p", { class: "faint", style: { margin: "0 0 10px" } }, champs.rule),
      champOk.length ? h("div", { class: "ch-list" }, champOk.map(champRow))
        : h("p", { class: "faint", style: { margin: champOff.length ? "0 0 10px" : 0 } }, "No trader can be followed yet: AI traders need 5 live trades in profit and a profit on paper, user strategies need to finish proving in profit."),
      champOff.length ? h("div", { class: "ch-list", style: champOk.length ? { marginTop: "8px" } : null }, champOff.map(champRow)) : null,
      (myChamps?.trades || []).length ? h("div", { class: "ch-mine" }, h("h4", {}, "Your follow trades"), h("ul", { class: "sc-list" }, myChamps.trades.slice(0, 8).map((t) => h("li", {},
        h("div", {}, h("b", {}, `$${t.symbol}`), h("div", { class: "faint" }, `${nameOf(t.agent)} · ${t.result || ""}${t.exit ? ` · ${t.exit}` : ""}`)), h("span", { class: `sc-st s-${t.status === "open" ? "executed" : t.status === "skipped" ? "blocked" : "closed"}` }, t.status))))) : null,
      !wallet.session ? needSignIn(main, "Sign in to follow a champion.") : null);
  }

  const link = (href, label) => h("a", { class: "ag-ar-l", href, target: "_blank", rel: "noopener" }, label);
  const tr = (p) => h("div", { class: `ag-ar-tr ${p.mode}` },
    h("span", { class: `ag-ar-tag ${p.mode === "live" ? "live" : ""}` }, p.mode === "live" ? "Live" : "Paper"),
    h("div", { class: "grow" },
      h("div", {}, h("a", { class: "link", href: `#/token/${p.token}` }, h("b", {}, `$${p.symbol}`)),
        h("span", { class: "faint" }, " · ", aiMark(p.agent, 14, { margin: "-2px 5px 0 0" }), `${nameOf(p.agent)} · ${p.status === "open" ? `bought ${ago(p.openedAt)} ago` : `${p.reason} ${ago(p.closedAt)} ago`}`)),
      h("div", { class: "ag-ar-links" },
        p.txBuy ? link(`${SCAN}/tx/${p.txBuy}`, "Buy tx") : null,
        p.txSell ? link(`${SCAN}/tx/${p.txSell}`, "Sell tx") : null,
        p.seal ? link(`/api/seal/r/${p.seal}`, "Receipt") : null,
        link(`${SCAN}/token/${p.token}`, "Coin"))),
    h("span", { class: `ag-ar-pnl ${p.status === "open" ? "" : cls(p.pnlEth)}` }, p.status === "open" ? (p.valueEth != null ? `${ethf(p.valueEth - p.amountEth)} so far` : "open") : ethf(p.pnlEth)));
  let lastRecent = [];
  function paintTrades(recent = lastRecent) {
    lastRecent = recent;
    show(tradesP, recent.length > 0);
    if (!recent.length) return;
    const more = recent.length > TRADES_SHOWN;
    clear(tradesP,
      h("div", { class: "ag-ar-top" }, h("h3", {}, "Latest trades"),
        more ? h("button", { class: "link", type: "button", "data-k": "trades-all", onclick: () => { showAll = !showAll; keepFocus(tradesP, () => paintTrades()); } }, showAll ? "Show fewer" : `Show all ${recent.length}`) : null),
      h("p", { class: "faint", style: { margin: "0 0 6px" } }, "Live rows are real transactions: open them on Blockscout. Paper rows send nothing; each has a signed receipt instead."),
      h("div", { class: "ag-ar-trades" }, (showAll ? recent : recent.slice(0, TRADES_SHOWN)).map(tr)));
  }

  // timed: the 60-second refresh, which leaves Champions alone while an amount is being typed there; a pressed button keeps
  // its focus through the repaint (data-k)
  async function load(timed = false) {
    const g = gen;
    const [board, me, champs, myChamps, ant] = await Promise.all([api.get("arena").catch(() => null), wallet.session ? api.get("arena/me").catch(() => null) : null,
      api.get("champions").catch(() => null), wallet.session ? api.get("champions/me").catch(() => null) : null, api.get("arena/anthropic").catch(() => null)]);
    if (g !== gen || !main.isConnected) return;
    mine = me?.agent || null;
    agents = board?.agents || [];
    if (wallet.session) paintMine();
    paintBoard(board);
    paintAnt(ant);
    if (!(timed && inUse(champP))) keepFocus(champP, () => paintChamps(champs, myChamps));
    keepFocus(tradesP, () => paintTrades(board?.recent || []));
    howP.textContent = board?.how || "";
    show(howP, !!board?.how);
  }
  // a new wallet or sign-in: the strategy card changes shape and the old replay no longer belongs to anyone
  const off = onWho(() => { gen++; mine = null; draft = null; clear(out); buildStrategy(); load(); });
  const t = setInterval(() => { if (!document.hidden) load(true); }, 60000);
  return () => { off(); clearInterval(t); };
}

/* =====================================================================================
   AEGIS (V7 F31): a guard on every coin you hold, alerts in the inbox and Telegram, exit tickets on red
   ===================================================================================== */
const AEGIS_KIND = { "dev-sell": "Dev sold", "dev-moved": "Dev moved coins", "whale-sell": "Whale sold", "tax-up": "Sell tax up", "cannot-sell": "Cannot sell", "oath-broken": "Oath broken", ring: "Ring Radar", "curve-drain": "Curve draining" };
function mountAegis(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  const evRow = (e) => h("div", { class: "ap-row" },
    h("div", { class: "grow" }, (() => { const b = h("b", { class: e.level === "red" ? "down" : "" }, `${e.level === "red" ? "RED" : "Amber"} · ${AEGIS_KIND[e.kind] || e.kind}`); return e.token ? h("a", { class: "link", href: `#/gate/${e.token}`, title: "Open this coin on the Gate: its Oath, Aegis and verdict" }, b) : b; })(), h("span", { class: "faint" }, ` · $${e.symbol || "?"} · ${ago(e.at)} ago`), h("div", { class: "faint" }, e.text)),
    e.token ? h("a", { class: "link", href: `#/gate/${e.token}` }, "Gate") : null,
    e.tx ? h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/tx/${e.tx}`, target: "_blank", rel: "noopener" }, "Tx") : null);
  const intro = h("div", { class: "ag-intro" }, h("h2", {}, "Aegis"), h("p", {}, "A guard on every coin you hold on Robinhood Chain. Once a minute Aegis reads what the dev, the wallets it disclosed and the top holders do, and test-sells your coin every five minutes. When the dev dumps, a whale sells, the sell tax jumps, the coin stops selling or the dev breaks its Oath, you get an alert in your inbox and on Telegram. In exit mode a red alert also prepares the sell to ETH for you to approve."));
  // d: this wallet's settings and guarded coins, f: the public feed. A tap changes d at once and paints; the save and the
  // refresh run behind it, so a second tap reads the new state instead of the old one.
  let d = null, f = null, gen = 0, saveSeq = 0, pending = 0, later = null;

  function paint() {
    const caught = h("div", { class: "panel ag-panel" }, h("h3", {}, "What Aegis caught lately"), f?.events?.length ? h("div", { class: "ap-list" }, f.events.slice(0, 15).map(evRow)) : h("p", { class: "faint", style: { margin: 0 } }, "Nothing raised yet on the coins people guard."));
    if (!wallet.session) { clear(main, intro, needSignIn(main, "Sign in to guard your coins."), caught); return; }
    if (!d) { clear(main, intro, h("div", { class: "sk", style: { height: "160px" } })); return; }
    if (d.error) { clear(main, intro, h("div", { class: "alert error" }, d.error)); return; }
    const sw = h("button", { class: `ag-switch ${d.on ? "on" : ""}`, type: "button", role: "switch", "aria-checked": String(d.on), "aria-label": "Aegis on or off", "data-k": "sw", onclick: () => save({ on: !d.on }) }, h("i"));
    const mode = h("div", { class: "seg" },
      h("button", { type: "button", "aria-pressed": String(d.mode === "alert"), "data-k": "alert", onclick: () => save({ mode: "alert" }) }, "Alert"),
      h("button", { type: "button", "aria-pressed": String(d.mode === "exit"), "data-k": "exit", onclick: () => save({ mode: "exit" }) }, "Exit"));
    const coin = (c) => h("div", { class: "ap-row" },
      h("div", { class: "grow" }, h("b", {}, `$${c.symbol}`), h("span", { class: "faint" }, `${c.usd != null ? ` · ${usd(c.usd)}` : ""}${c.inAgentWallet ? " · Agent Wallet" : ""}`),
        c.events?.length ? h("div", { class: c.events[0].level === "red" ? "down" : "faint" }, `${AEGIS_KIND[c.events[0].kind] || c.events[0].kind}: ${c.events[0].text}`) : h("div", { class: "faint" }, "Quiet so far.")),
      h("span", { class: "faint" }, c.sellTest ? (c.sellTest.ok ? `sells · tax ${Number(c.sellTest.tax || 0).toFixed(1)}%` : "sell test failed") : "sell test pending"));
    const coins = d.coins || [];
    clear(main, intro,
      h("div", { class: "panel ag-panel" },
        h("div", { class: "ag-auto-h" }, h("div", {}, h("b", {}, d.on ? `On · ${d.mode === "exit" ? "exit tickets on red" : "alerts only"}` : "Off"),
          h("div", { class: "faint" }, d.mode === "exit" ? (d.autoExit ? "A red alert sells coins held in your Agent Wallet through the Gate and its caps; coins in your own wallet get a ticket to approve." : "A red alert prepares a sell to ETH for you to approve in Portfolio, Inbox.") : "You decide every exit; Aegis only tells you.")),
          h("div", { class: "row" }, mode, sw)),
        h("p", { class: "note", style: { margin: "10px 0 0" } }, `Guards up to ${d.limit} coins${d.limit < 10 ? " (Holder Pass: up to 50)" : ""}, largest first${d.capped ? `; ${d.capped} more not guarded` : ""}. Link Telegram in Settings to get the alerts there.`)),
      h("div", { class: "panel ag-panel" }, h("h3", {}, `Guarded coins (${coins.length})`), coins.length ? h("div", { class: "ap-list" }, coins.map(coin)) : h("p", { class: "faint", style: { margin: 0 } }, d.on ? "Reading your wallet. Coins show up here within a minute." : "Switch it on and every coin in your wallet and Agent Wallet is guarded.")),
      caught);
  }
  async function load() {
    const g = gen, s0 = saveSeq;
    const [feed, me] = await Promise.all([api.get("aegis/feed").catch(() => null), wallet.session ? api.get("aegis/me").catch((e) => ({ error: e.message })) : null]);
    // a newer sign-in, or a tap since this started (or still saving): that tap's own refresh paints instead
    if (g !== gen || s0 !== saveSeq || pending || !main.isConnected) return;
    f = feed; d = me;
    keepFocus(main, paint);
  }
  async function save(patch) {
    if (!d || d.error) return;
    const before = { on: d.on, mode: d.mode }, seq = ++saveSeq;
    Object.assign(d, patch);
    keepFocus(main, paint);
    pending++;
    try { await api.post("aegis/me", { on: d.on, mode: d.mode, minUsd: d.minUsd }); if (seq === saveSeq) toast("Saved", "ok"); }
    catch (e) { if (seq === saveSeq) { Object.assign(d, before); keepFocus(main, paint); } toast(e.message, "error"); return; }
    finally { pending--; }
    // the guarded list follows in the background: Aegis reads the wallet a moment after it is switched on
    clearTimeout(later); later = setTimeout(load, 2500);
  }
  const off = onWho(() => { gen++; d = null; paint(); load(); });
  const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
  return () => { off(); clearInterval(t); clearTimeout(later); };
}

/* =====================================================================================
   SENTRY AUTOPILOT (Phase 7): rules run on the server around the clock, practice or live
   ===================================================================================== */
// a guest sees the rules as a template (the starting rules every wallet gets, server/autopilot.mjs DEFAULTS), and the
// results and positions as empty Example rows: no invented PnL, no invented trades
const SENTRY_TEMPLATE = [["Curve raised at least", "1 ETH"], ["Buy per coin", "0.01 ETH"], ["Take profit at", "2x"], ["Stop at", "30% down"], ["Open at once", "3"], ["Buys a day", "5"], ["Extra checks", "Off (X check, site up, dev early sale, buy in USD)"]];
function guestSentry() {
  const example = [
    h("div", { class: "panel ag-panel" },
      h("div", { class: "ag-auto-h" }, h("div", {}, h("b", {}, "Off"), h("div", { class: "faint" }, "Practice runs on play money at real prices. Live trades from your Agent Wallet.")),
        h("div", { class: "row" }, h("div", { class: "seg" }, h("button", { type: "button", "aria-pressed": "true" }, "Practice"), h("button", { type: "button", "aria-pressed": "false" }, "Live")), h("span", { class: "ag-switch" }, h("i")))),
      h("hr", { class: "hr" }), h("h3", {}, "Your rules (template: the starting rules)"),
      h("div", { class: "rows" }, SENTRY_TEMPLATE.map(([k, v]) => h("div", {}, h("span", {}, k), h("span", {}, v)))),
      h("p", { class: "note", style: { margin: 0 } }, "Same rules in Telegram: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3")),
    h("div", { class: "panel ag-panel" }, h("h3", {}, "Results"),
      h("div", { class: "rows" }, h("div", {}, h("span", {}, "Practice"), h("span", {}, "–")), h("div", {}, h("span", {}, "Live"), h("span", {}, "–")), h("div", {}, h("span", {}, "Open now"), h("span", {}, "–")))),
    h("div", { class: "panel ag-panel" }, h("h3", {}, "Open"),
      h("ul", { class: "sc-list", style: { padding: 0 } },
        exampleRow("$EXAMPLE", "practice · bought after it passed the Gate and its curve raised what you set", "executed", "open"),
        exampleRow("$EXAMPLE", "closed at your take-profit, your stop or after 7 days, with the reason", "built", "closed"))),
  ];
  return guestPreview({
    title: "Sentry Autopilot",
    intro: "Give the agent your rules and it buys Pons launches that pass Troya Gate, then sells at your take-profit or stop. It runs on the server around the clock.",
    sentence: "Your rules belong to the wallet you sign in with. Signing costs nothing and sends nothing.",
    bullets: [
      "Buys Pons launches that pass Troya Gate and your rules, then sells at your take-profit or stop, or after 7 days",
      "Runs on the server around the clock; practice mode uses play money at real prices",
      "Live mode, once it is open, trades from your Agent Wallet inside your Budget and trust ladder",
    ],
    example,
  });
}

function mountSentryAuto(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  const ethf = (v, d = 4) => (v == null || !isFinite(v) ? "–" : `${Number(v).toFixed(d)} ETH`);
  // the rules form is built once per sign-in and again only after its own save: the 30-second refresh repaints the switch,
  // the results and the positions, never a field someone is typing in
  let d = null, gen = 0;
  const head = h("div", { class: "ag-auto-h" }), formBox = h("div", { style: { display: "grid", gap: "12px" } });
  const resultsP = h("div", { class: "panel ag-panel" }), openP = h("div", { class: "panel ag-panel" }), closedP = h("div", { class: "panel ag-panel" }), actP = h("div", { class: "panel ag-panel" });
  // returns whether it saved; a failed save leaves typed rules as they are, and the refresh puts the switches back
  const save = async (patch, rules = false) => {
    let ok = true;
    try { await api.post("autopilot/settings", patch); toast("Saved", "ok"); } catch (e) { ok = false; toast(e.message, "error"); }
    await refresh({ rules: rules && ok });
    return ok;
  };

  function paintForm() {
    const s = d.settings, r = s.rules;
    const f = (key, label, step, suffix) => h("label", { class: "field" }, h("span", {}, label), h("div", { class: "row" }, h("input", { class: "input", type: "number", step, min: d.limits[key][0], max: d.limits[key][1], value: r[key], name: key }), suffix ? h("span", { class: "faint" }, suffix) : null));
    const form = h("div", { class: "ag-grid3" }, f("minRaisedEth", "Curve raised at least", "0.1", "ETH"), f("buyEth", "Buy per coin", "0.001", "ETH"), f("takeProfitX", "Take profit at", "0.1", "x"), f("stopPct", "Stop at", "1", "% down"), f("maxOpen", "Open at once", "1", ""), f("maxBuysPerDay", "Buys a day", "1", ""));
    // the optional extra checks (server/autopilot-rules.mjs), all off until switched on here or in Telegram
    const box = (key, title, text) => h("label", { class: "ap-x" }, h("input", { type: "checkbox", name: key, checked: !!r[key] }), h("span", {}, h("b", {}, title), h("span", { class: "faint" }, text)));
    const small = (key, step, suffix) => h("span", { class: "ap-num" }, h("input", { class: "input", type: "number", step, min: d.limits[key]?.[0], max: d.limits[key]?.[1], value: r[key], name: key, "aria-label": suffix }), h("span", { class: "faint" }, suffix));
    const extra = h("div", { class: "ap-extra" },
      h("div", { class: "ap-extra-h" }, h("b", {}, "Extra checks"), h("span", { class: "faint" }, "Optional, off by default. A check that cannot be read counts as a no: no buy.")),
      box("xCheck", "X check", "The coin's own X account (from its Pons profile) has a verified badge and shows this coin's contract address in its bio, pinned post or 5 newest posts."),
      box("siteUp", "Site up", "The coin's website (from its Pons profile) answers HTTP 200 within 5 seconds."),
      h("div", { class: "ap-x" }, h("input", { type: "checkbox", name: "devEarly", checked: !!r.devEarly, id: "ap-dev" }),
        h("span", {}, h("label", { for: "ap-dev" }, h("b", {}, "Dev didn't sell early")),
          h("span", { class: "faint ap-inline" }, "Skip if the dev or wallets tied to it sold more than ", small("devEarlyPct", "1", "%"), " of what they got in the first ", small("devEarlyMin", "1", "min")),
          h("span", { class: "faint ap-inline" }, "0% means any sale. A coin seen before that time is checked once it has passed, never bought earlier."))),
      h("div", { class: "ap-x" }, h("span", { class: "ap-x-pad" }), h("span", {}, h("b", {}, "Buy in USD"),
        h("span", { class: "faint ap-inline" }, "Buy ", small("buyUsd", "1", "USD"), " per coin, in ETH at the live price when it buys. 0 uses the ETH amount above."))));
    const collect = () => {
      const out = {};
      for (const i of [...form.querySelectorAll("input"), ...extra.querySelectorAll("input[type=number]")]) out[i.name] = Number(i.value);
      for (const i of extra.querySelectorAll("input[type=checkbox]")) out[i.name] = i.checked;
      return out;
    };
    const saveRules = h("button", { class: "btn primary", type: "button", onclick: () => save({ rules: collect() }, true) }, "Save rules");
    const pub = h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.public, onchange: async (e) => { const want = e.target.checked; if (!(await save({ public: want }))) e.target.checked = !want; } }), "Show my results on the leaderboard (address shortened)");
    clear(formBox, form, extra, h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } }, pub, saveRules));
  }
  // a pressed control (the switch, a Close button) keeps its focus through the repaint (data-k)
  function paintLive() {
    const s = d.settings, st = d.stats;
    keepFocus(head, () => {
      const sw = h("button", { class: `ag-switch ${s.on ? "on" : ""}`, type: "button", role: "switch", "aria-checked": String(s.on), "aria-label": "Sentry Autopilot on or off", "data-k": "sw", onclick: () => save({ on: !s.on }) }, h("i"));
      const mode = h("div", { class: "seg" },
        h("button", { type: "button", "aria-pressed": String(s.mode === "practice"), "data-k": "practice", onclick: () => save({ mode: "practice" }) }, "Practice"),
        h("button", { type: "button", "aria-pressed": String(s.mode === "live"), "data-k": "live", disabled: !s.liveAvailable, title: s.liveAvailable ? "" : "Live mode opens after it passes real-money tests", onclick: () => save({ mode: "live" }) }, "Live"));
      clear(head, h("div", {}, h("b", {}, s.on ? `On · ${s.mode === "live" ? "live, Agent Wallet" : "practice, play money"}` : "Off"), h("div", { class: "faint" }, s.liveAvailable ? "Live mode buys and sells from your Agent Wallet." : "Live mode opens after it passes real-money tests. Practice runs at real prices meanwhile.")), h("div", { class: "row" }, mode, sw));
    });
    const line = (x) => `${x.closed} closed · ${x.pnlEth >= 0 ? "+" : ""}${ethf(x.pnlEth)}${x.winRate != null ? ` · ${(x.winRate * 100).toFixed(0)}% won` : ""}`;
    const open = d.positions.filter((p) => p.status === "open"), closed = d.positions.filter((p) => p.status === "closed");
    const row = (p) => h("div", { class: "ap-row" },
      h("div", { class: "grow" }, h("b", {}, `$${p.symbol}`), h("span", { class: "faint" }, ` · ${p.mode} · in ${ethf(p.amountEth)}${p.amountUsd ? ` ($${p.amountUsd})` : ""} at ${p.raisedAtEntry != null ? Number(p.raisedAtEntry).toFixed(2) : "–"} ETH raised · ${ago(p.openedAt)} ago`)),
      p.status === "open"
        ? h("div", { class: "row" }, h("span", {}, p.lastValueEth != null ? `${ethf(p.lastValueEth)} (${((p.lastValueEth / p.amountEth - 1) * 100).toFixed(1)}%)` : "checking…"), h("button", { class: "btn sm", type: "button", "data-k": `close-${p.id}`, onclick: async (e) => { e.currentTarget.disabled = true; try { await api.post("autopilot/close", { id: p.id }); toast("Closed", "ok"); } catch (er) { toast(er.message, "error"); } refresh(); } }, "Close"))
        : h("span", { class: (p.pnlEth || 0) >= 0 ? "up" : "down" }, `${(p.pnlEth || 0) >= 0 ? "+" : ""}${ethf(p.pnlEth)} · ${p.reason}`));
    clear(resultsP, h("h3", {}, "Results"), h("div", { class: "rows" }, h("div", {}, h("span", {}, "Practice"), h("span", {}, line(st.practice))), h("div", {}, h("span", {}, "Live"), h("span", {}, line(st.live))), h("div", {}, h("span", {}, "Open now"), h("span", {}, String(st.open)))),
      h("a", { class: "link", href: "#/leaderboard" }, "See the leaderboard"));
    keepFocus(openP, () => clear(openP, h("h3", {}, `Open (${open.length})`), open.length ? h("div", { class: "ap-list" }, open.map(row)) : h("p", { class: "faint", style: { margin: 0 } }, s.on ? "Waiting for the next launch that passes your rules." : "Switch it on to start.")));
    // each extra check's pass or fail, per coin (only users with an extra rule on have rows)
    const acts = d.activity || [];
    const r0 = s.rules, anyX = r0.xCheck || r0.siteUp || r0.devEarly || r0.buyUsd > 0;
    show(actP, acts.length > 0 || anyX);
    const ST = { pass: "pass", fail: "fail", wait: "wait", "not-run": "not run" };
    const OUT = { bought: "Bought", skipped: "Skipped", waiting: "Waiting", "not bought": "Not bought" };
    clear(actP, h("h3", {}, "Extra checks: activity"),
      acts.length ? h("div", { class: "ap-list" }, acts.slice(0, 20).map((a) => h("div", { class: "ap-act" },
        h("div", { class: "ap-act-h" }, h("b", {}, `$${a.symbol}`), h("span", { class: `ap-out o-${a.outcome.replace(/\s/g, "-")}` }, OUT[a.outcome] || a.outcome), h("span", { class: "faint" }, `${a.mode || "practice"} · ${ago(a.at)} ago${a.seen > 1 ? ` · seen ${a.seen}x` : ""}`)),
        h("ul", { class: "ap-chk" }, a.checks.map((c) => h("li", {}, h("span", { class: `ap-st s-${c.status}` }, ST[c.status] || c.status), h("span", {}, h("b", {}, c.label), ` ${c.detail}`)))))))
        : h("p", { class: "faint", style: { margin: 0 } }, "Each coin your extra checks look at shows here with every check's result and reason, and a skip is also sent to you on Telegram."),
      d.xBudget && r0.xCheck ? h("p", { class: "note", style: { margin: "8px 0 0" } }, `X lookups by Autopilot today: ${d.xBudget.used} of ${d.xBudget.of} (shared by all users; each coin is looked up once). When they run out, X check says no.`) : null);
    show(closedP, closed.length > 0);
    clear(closedP, closed.length ? [h("h3", {}, "Closed"), h("div", { class: "ap-list" }, closed.slice(0, 30).map(row))] : null);
  }

  async function build() {
    const g = ++gen;
    d = null;
    if (!wallet.session) { clear(main, ...guestSentry()); return; }
    let x;
    try { x = await api.get("autopilot"); } catch (e) { if (g === gen) clear(main, h("div", { class: "alert error" }, e.message)); return; }
    if (g !== gen || !main.isConnected) return;
    d = x;
    clear(main,
      h("div", { class: "ag-intro" }, h("h2", {}, "Sentry Autopilot"), h("p", {}, "Every Pons launch goes through Troya Gate about 90 seconds in, and again at 5, 15 and 60 minutes while it is quiet. When one passes and its curve has raised what you set, Autopilot buys, then sells at your take-profit or stop, or after 7 days. Practice mode uses play money at real prices; live mode trades from your Agent Wallet inside its caps.")),
      h("div", { class: "panel ag-panel" }, head, h("hr", { class: "hr" }), h("h3", {}, "Your rules"), formBox,
        h("p", { class: "note", style: { margin: 0 } }, "Same rules in Telegram: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3 · extra checks: /autopilot set xcheck on site on devsell 1m 0% buy $10")),
      resultsP, actP, openP, closedP);
    paintForm();
    paintLive();
  }
  // rules: also rebuild the rules form from what the server saved (only after its own successful save)
  async function refresh({ rules = false } = {}) {
    if (!d) return;
    const g = gen;
    let x;
    try { x = await api.get("autopilot"); } catch { return; }
    if (g !== gen || !main.isConnected) return;
    d = x;
    if (rules) paintForm();
    paintLive();
  }
  const off = onWho(build);
  // a page that failed to load tries again on the next tick; a loaded one only refreshes its live parts
  const t = setInterval(() => { if (!document.hidden && wallet.session) (d ? refresh() : build()); }, 30000);
  return () => { off(); clearInterval(t); };
}
