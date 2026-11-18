// Agent page: Chat · Wallet (Agent Wallet + API tokens) · Autopilot (+ limits) · Playbooks.
import { h, clear, icon, toast, modal, review, short, greeting, useCss, every, store, copyText, ago, num, usd, esc, chainLogo, tokenIcon, coinIcon } from "../ui.js";
import { api, stream } from "../api.js";
import { coinSuggest } from "../coinsearch.js";
import { wallet, onWallet, signIn, openConnect, signerFor } from "../wallet.js";
import { waitReceipt, errText } from "../chain.js";
import { parseEther } from "ethers";

const TABS = [["chat", "Chat"], ["wallet", "Wallet"], ["autopilot", "Autopilot"], ["sentry", "Sentry Autopilot"], ["playbooks", "Playbooks"]];
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

const CHAIN_NAME = { 1: "Ethereum", 42161: "Arbitrum", 8453: "Base", 4663: "Robinhood Chain" };
const CHAIN_KEY = { 1: "ethereum", 42161: "arbitrum", 8453: "base" };

export async function mount(view, ctx) {
  useCss("agent");
  const tab = TABS.some(([k]) => k === ctx.parts[0]) ? ctx.parts[0] : "chat";
  const nav = h("nav", { class: "ag-tabs", "aria-label": "Agent sections" }, TABS.map(([k, t]) => h("a", { href: k === "chat" ? "#/agent" : `#/agent/${k}`, ...(k === tab ? { "aria-current": "page" } : {}) }, t)));
  const body = h("div", { class: `ag-body ag-${tab}` });
  clear(view, h("div", { class: "ag-wrap" }, nav, body));
  const page = { chat: mountChat, wallet: mountWallet, autopilot: mountAutopilot, sentry: mountSentryAuto, playbooks: mountPlaybooks }[tab];
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

function mountChat(box, ctx) {
  let busy = false;
  let abort = null;
  const proposals = new Map();
  const hero = h("div", { class: "ag-hero" },
    h("h1", {}, `${greeting()}.`),
    h("p", {}, "You ask. Troya checks. You sign."),
    h("div", { class: "ag-suggest" }, SUGGEST.map(([ic, t]) => h("button", { type: "button", class: "ag-card", onclick: () => send(t) }, h("span", { class: "ag-ic" }, icon(ic)), h("span", {}, t)))));
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
    clear(gateBar, signed ? null : h("div", { class: "ag-signbar" }, h("span", {}, wallet.address ? "Asking as a guest: answers and Gate checks. Sign in for tickets and your balances." : "Asking as a guest: answers and Gate checks, no wallet needed. Connect and sign in for tickets and your balances.", h("i", { class: "info", title: "Signing a message proves the wallet is yours. It costs nothing and sends nothing." }, "i")),
      h("button", { class: "btn sm primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, icon("wallet"), "Sign in")));
    if (signed && !usage) { try { usage = await api.get("assistant/usage"); } catch {} }
    clear(meta,
      h("span", { class: "ag-chip" }, icon("wallet"), wallet.address ? short(wallet.address) : "No wallet"),
      usage && signed ? h("span", { class: "faint" }, `${usage.used}/${usage.limit} free messages today`) : usage?.guest ? h("span", { class: "faint" }, `Guest: ${usage.used}/${usage.limit} questions today`) : null,
      h("span", { class: "faint grow", style: { textAlign: "right" } }, "Proposals expire after 10 minutes"));
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
      await stream("assistant/stream", { message: text, lang: ctx.prefs.get().lang, slippage: ctx.prefs.get().slippage, ...(guest ? { history: prior } : {}) }, (type, data) => {
        if (type === "status") status.lastChild.textContent = data.text;
        else if (type === "tool") tools.append(h("span", { class: `ag-tool ${data.ok ? "" : "bad"}` }, icon(data.ok ? "check" : "close"), data.name));
        else if (type === "text") { acc += data.delta; body.innerHTML = md(acc); el.scrollIntoView({ block: "end" }); }
        else if (type === "proposal") el.querySelector(".ag-bubble").append(ticket(data.proposal));
        else if (type === "done") { usage = data.usage ? { ...usage, ...data.usage } : usage; if (guest && acc) guestLog.set([...guestLog.get(), { role: "user", text }, { role: "assistant", text: acc }]); }
        else if (type === "error") body.innerHTML = md(`**${data.error}**`);
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
        const r = await hl.placeOrder({ owner: wallet.address, market: m, isBuy: pr.side !== "short", size: pr.sizeUsd / (m.midPx || m.markPx), leverage: pr.leverage, tp: pr.tpPx || undefined, sl: pr.slPx || undefined });
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

  async function loadHistory(force = false) {
    if (!wallet.session) {
      if (!log.children.length) for (const m of guestLog.get().slice(-16)) addMsg(m.role, m.text);
      return;
    }
    if (log.children.length && !force) return;
    try {
      const [hist, props] = await Promise.all([api.get("assistant/history"), api.get("inbox/proposals")]);
      const pm = new Map((props.items || []).map((p) => [p.id, p]));
      for (const m of (hist.messages || []).slice(-16)) {
        const { el } = addMsg(m.role, m.text);
        for (const pid of m.proposals || []) if (pm.get(pid)) el.querySelector(".ag-bubble").append(ticket(pm.get(pid)));
      }
    } catch {}
  }

  // signing in or out swaps between the guest chat (this browser) and the wallet's saved chat
  let mode = wallet.session ? "signed" : "guest";
  const off = onWallet(() => {
    const now = wallet.session ? "signed" : "guest";
    if (now !== mode) { mode = now; resetView(); loadHistory(true); } else loadHistory();
    refreshMeta(); paintHead();
  });
  loadHistory(); paintHead();
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
function mountWallet(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  let stopBal = null;

  async function render() {
    stopBal?.();
    if (!wallet.session) { clear(main, intro(), needSignIn(main, "The Agent Wallet belongs to the wallet you sign in with.")); return; }
    let aw;
    try { aw = await api.get("agent-wallet"); } catch (e) { clear(main, h("div", { class: "alert error" }, e.message)); return; }
    if (!aw.exists) {
      clear(main, intro(),
        h("div", { class: "panel ag-panel" },
          h("div", { class: "alert warn" }, h("b", {}, "Custodial. "), "The operator stores this wallet's key, encrypted. Keep only what you are willing to lose in it. Your own wallet is never touched."),
          h("ul", { class: "ag-points" },
            h("li", {}, "Withdrawals go only to your address: ", h("span", { class: "mono" }, short(wallet.address, 6))),
            h("li", {}, "Daily and per-trade caps, plus your limits, apply to every action"),
            h("li", {}, "Export the key any time with a fresh signature"),
            h("li", {}, "On Hyperliquid it trades as an approved agent on your account: trade-only, it cannot withdraw there")),
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { await api.post("agent-wallet/create"); toast("Agent Wallet ready", "ok"); render(); } catch (e) { toast(e.message, "error"); } } }, icon("plus"), "Create Agent Wallet")),
        tokensPanel(), gateApiPanel());
      return;
    }
    const balBox = h("div", { class: "stats ag-bal" }, [["robinhood", "Robinhood Chain"], ["robinhood", "Tokens"], ["hyperliquid", "Hyperliquid"]].map(([lk, k]) => h("div", { class: "stat" }, h("div", { class: "k" }, chainLogo(lk, 14), k), h("div", { class: "v" }, h("span", { class: "sk", style: { display: "inline-block", width: "90px", height: "22px" } })))));
    const toggle = h("button", { class: `btn sm ${aw.enabled ? "" : "blue"}`, type: "button", onclick: async () => { try { await api.post("agent-wallet/settings", { enabled: !aw.enabled }); render(); } catch (e) { toast(e.message, "error"); } } }, aw.enabled ? icon("pause") : icon("play"), aw.enabled ? "Switch off" : "Switch on");
    const per = h("input", { class: "input", type: "number", min: "0", step: "1", value: aw.caps.perTradeUsd });
    const day = h("input", { class: "input", type: "number", min: "0", step: "1", value: aw.caps.dailyUsd });
    const wAmt = h("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "0.0" });
    // Max: the Agent Wallet's ETH minus 0.0001 ETH it needs for the withdrawal's own gas, cut (never rounded up) to 6 decimals
    let lastEth = null;
    const wMax = h("button", { class: "chip", type: "button", title: "Everything but 0.0001 ETH kept for gas", onclick: async () => {
      try { if (lastEth == null) lastEth = (await api.get("agent-wallet/balances")).robinhoodEth; } catch { return toast("Balance unavailable right now.", "error"); }
      const v = Math.floor(Math.max(0, Number(lastEth || 0) - 0.0001) * 1e6) / 1e6;
      if (!(v > 0)) return toast("Not enough ETH in the Agent Wallet to withdraw.", "");
      wAmt.value = String(v);
    } }, "Max");
    const wChain = h("select", { class: "select" }, h("option", { value: "robinhood" }, "Robinhood Chain"));
    // one-signature top-up from the connected wallet: the step people miss ("my ETH is in my wallet, why does the launch fail?")
    function fundRow(w) {
      const amt = h("input", { class: "input ag-fund-in", type: "number", min: "0", step: "any", value: "0.002", "aria-label": "ETH to add to the Agent Wallet" });
      const pick = (v) => h("button", { class: "chip", type: "button", onclick: () => { amt.value = v; } }, `${v} ETH`);
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
      return h("div", { class: "ag-fund" }, h("div", { class: "faint" }, "Add ETH from your wallet"), h("div", { class: "row wrap" }, pick("0.002"), pick("0.005"), pick("0.01"), amt, go));
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
        h("div", { class: "panel ag-panel" }, h("h3", {}, "Caps"),
          h("label", { class: "field" }, h("span", {}, "Per action (USD)"), per),
          h("label", { class: "field" }, h("span", {}, "Per day (USD)"), day),
          h("p", { class: "note" }, "Your general limits (Agent → Autopilot) still apply. The stricter value wins."),
          h("button", { class: "btn", type: "button", onclick: async () => { try { await api.post("agent-wallet/settings", { perTradeUsd: Number(per.value), dailyUsd: Number(day.value) }); toast("Caps saved", "ok"); render(); } catch (e) { toast(e.message, "error"); } } }, "Save caps")),
        h("div", { class: "panel ag-panel" }, h("h3", {}, "Withdraw to my wallet"),
          h("div", { class: "row" }, h("label", { class: "field grow" }, h("span", {}, "Amount (ETH)"), h("div", { class: "row", style: { gap: "6px" } }, wAmt, wMax)), h("label", { class: "field" }, h("span", {}, "Network"), wChain)),
          h("p", { class: "note" }, "Destination is fixed: ", h("span", { class: "mono" }, short(wallet.address, 6))),
          h("button", { class: "btn", type: "button", onclick: async () => {
            const amount = Number(wAmt.value);
            if (!(amount > 0)) return toast("Enter an amount.", "");
            if (!(await review({ title: "Withdraw", rows: [["Amount", `${amount} ETH`], ["Network", "Robinhood Chain"], ["To", short(wallet.address, 6)]], confirmLabel: "Withdraw" }))) return;
            try { const r = await api.post("agent-wallet/withdraw", { chain: wChain.value, amount }); toast(r.executed ? "Withdrawal sent" : r.result?.note || (r.blocked ? r.reasons.join(" ") : "Not sent"), r.executed ? "ok" : "", 5000); render(); } catch (e) { toast(e.message, "error", 6000); }
          } }, "Withdraw"))),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Hyperliquid trading"),
        h("p", { class: "note" }, "Let the Agent Wallet place perp orders on your own Hyperliquid account. You sign one approval in your wallet; the agent can trade but cannot move funds out of Hyperliquid."),
        h("button", { class: "btn", type: "button", onclick: () => approveOnHl(aw.address) }, icon("key"), "Approve on Hyperliquid")),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Key"),
        h("div", { class: "row", style: { flexWrap: "wrap" } },
          h("button", { class: "btn", type: "button", onclick: exportKey }, icon("key"), "Export private key"),
          h("button", { class: "btn danger", type: "button", onclick: del }, icon("trash"), "Delete Agent Wallet")),
        aw.exportedAt ? h("p", { class: "note" }, `Key last exported ${ago(aw.exportedAt)} ago.`) : null),
      tokensPanel(),
      gateApiPanel(),
      activityPanel());
    stopBal = every(20000, async () => {
      try {
        const b = await api.get("agent-wallet/balances");
        lastEth = b.robinhoodEth ?? lastEth;
        const vals = [b.robinhoodEth != null ? `${num(b.robinhoodEth, 5)} ETH` : "–", b.robinhoodTokens?.length ? b.robinhoodTokens.slice(0, 2).map((x) => `${num(x.amount, 4)} ${x.symbol}`).join(" · ") : "None", b.hyperliquid ? usd(b.hyperliquid.accountValueUsd) : "–"];
        [...balBox.querySelectorAll(".v")].forEach((el, i) => (el.textContent = vals[i]));
      } catch {}
    });
  }

  function intro() {
    return h("div", { class: "ag-intro" }, h("h2", {}, "Agent Wallet"), h("p", {}, "A small hot wallet the agent can use on its own, so swaps, perps and playbook actions run from chat without a wallet popup each time. Optional, capped, and yours to empty at any time."));
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

  const off = onWallet(render);
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
      } catch (e) { autoNote(`${p.summary}: ${e.message}`, "error"); }
    }
    if (!due.length) autoNote("Checked: nothing due.");
  } catch (e) { autoNote(`Check failed: ${e.message}`, "error"); }
}
function startAuto() { if (!autoTimer) { autoTimer = setInterval(() => { if (!document.hidden) autoTick(); }, 30000); autoTick(); } }
function stopAuto() { clearInterval(autoTimer); autoTimer = null; }
if (autoPref.get().on) startAuto();

function mountAutopilot(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  async function render() {
    if (!wallet.session) { clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Autopilot"), h("p", {}, "Let the Agent Wallet act on playbook triggers without asking each time, while this tab stays open.")), needSignIn(main, "Autopilot and limits belong to the wallet you sign in with.")); return; }
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
    const f = (k, v, step = "1") => h("input", { class: "input", type: "number", min: "0", step, value: v ?? "" });
    const per = f("perTradeUsd", pol.user.perTradeUsd ?? e.perTradeUsd), day = f("dailyUsd", pol.user.dailyUsd ?? e.dailyUsd), lev = f("maxLeverage", pol.user.maxLeverage ?? e.maxLeverage);
    const perps = h("input", { class: "input", placeholder: "Empty = all markets, e.g. BTC, ETH, HYPE", value: (pol.user.allowedPerps || []).join(", ") });
    clear(main,
      h("div", { class: "ag-intro" }, h("h2", {}, "Autopilot"), h("p", {}, "When a playbook fires, Autopilot runs it with your Agent Wallet instead of waiting for you. It works only while this browser tab is open on Troya, and only inside your caps.")),
      e.killSwitch ? h("div", { class: "alert error" }, "The operator kill switch is on. Nothing executes until it is lifted.") : null,
      h("div", { class: "panel ag-panel" },
        h("div", { class: "ag-auto-h" },
          h("div", {}, h("b", {}, pref.on ? "Autopilot is on in this tab" : "Autopilot is off"), h("div", { class: "faint" }, aw.exists ? "Checks for due proposals every 30 seconds." : "Create an Agent Wallet first (Agent → Wallet).")),
          sw),
        h("div", { class: "row", style: { flexWrap: "wrap", gap: "18px" } }, chk("playbooks", "Act on playbook triggers"), chk("chat", "Also act on chat tickets")),
        h("hr", { class: "hr" }),
        h("div", { class: "ag-auto-h" },
          h("div", {}, h("b", {}, e.paused ? "Agent paused" : "Agent active"), h("div", { class: "faint" }, "Pause stops every Agent Wallet action at once, on the server, in every tab.")),
          h("button", { class: `btn ${e.paused ? "blue" : "danger"}`, type: "button", onclick: async () => { try { await api.post("policy", { paused: !e.paused }); toast(e.paused ? "Resumed" : "Paused", "ok"); render(); } catch (er) { toast(er.message, "error"); } } }, e.paused ? icon("play") : icon("pause"), e.paused ? "Resume" : "Pause"))),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Your limits"),
        h("p", { class: "note", style: { marginTop: 0 } }, `Operator caps: $${pol.operator.perTradeUsd}/action · $${pol.operator.dailyUsd}/day · ${pol.operator.maxLeverage}x. You can only go stricter. Used today: ${usd(pol.usedTodayUsd)}.`),
        h("div", { class: "ag-grid3" }, h("label", { class: "field" }, h("span", {}, "Per action (USD)"), per), h("label", { class: "field" }, h("span", {}, "Per day (USD)"), day), h("label", { class: "field" }, h("span", {}, "Max leverage"), lev)),
        h("label", { class: "field", style: { marginTop: "10px" } }, h("span", {}, "Allowed perps"), perps),
        h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn primary", type: "button", onclick: async () => {
          try { await api.post("policy", { perTradeUsd: per.value, dailyUsd: day.value, maxLeverage: lev.value, allowedPerps: perps.value.split(/[\s,]+/).filter(Boolean) }); toast("Limits saved", "ok"); render(); } catch (er) { toast(er.message, "error"); }
        } }, "Save limits"))),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "This tab's Autopilot log"), logBox));
    main._cleanup = () => removeEventListener("troya:autopilot", drawLog);
  }
  const off = onWallet(() => { main._cleanup?.(); render(); });
  return () => { off(); main._cleanup?.(); };
}

/* =====================================================================================
   PLAYBOOKS
   ===================================================================================== */
const TYPES = [["stop_loss", "Stop-loss guard"], ["take_profit", "Take-profit ladder"], ["dca", "DCA into a token"], ["twap", "TWAP (big order)"], ["alert", "Price alert"]];

function mountPlaybooks(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  let stop = null;
  async function render() {
    stop?.();
    if (!wallet.session) { clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Playbooks")), needSignIn(main, "Playbooks belong to the wallet you sign in with.")); return; }
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
    clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Playbooks"), h("p", {}, "Rules the server watches for you: stop-loss guards, take-profit ladders, DCA (plain or smart), TWAP for big orders and price alerts.")),
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
          : h("p", { class: "faint" }, "No playbooks yet. Create one below, or ask in chat: “stop loss ETH at 3000”."));
        clear(journalBox, journalList(j.items, "Nothing has fired yet."));
      } catch (e) { clear(listBox, h("p", { class: "faint" }, e.message)); }
    };
    stop = every(20000, load);
  }
  const off = onWallet(render);
  return () => { off(); stop?.(); };
}

/* =====================================================================================
   SENTRY AUTOPILOT (Phase 7): rules run on the server around the clock, practice or live
   ===================================================================================== */
function mountSentryAuto(box) {
  const main = h("div", { class: "ag-col" });
  clear(box, main);
  const ethf = (v, d = 4) => (v == null || !isFinite(v) ? "–" : `${Number(v).toFixed(d)} ETH`);
  async function render() {
    if (!wallet.session) { clear(main, h("div", { class: "ag-intro" }, h("h2", {}, "Sentry Autopilot"), h("p", {}, "Give the agent your rules and it buys Pons launches that pass Troya Gate, then sells at your take-profit or stop. It runs on the server around the clock.")), needSignIn(main, "Sign in to set your rules.")); return; }
    let d;
    try { d = await api.get("autopilot"); } catch (e) { clear(main, h("div", { class: "alert error" }, e.message)); return; }
    const s = d.settings, r = s.rules;
    const save = async (patch) => { try { await api.post("autopilot/settings", patch); toast("Saved", "ok"); render(); } catch (e) { toast(e.message, "error"); } };
    const sw = h("button", { class: `ag-switch ${s.on ? "on" : ""}`, type: "button", role: "switch", "aria-checked": String(s.on), onclick: () => save({ on: !s.on }) }, h("i"));
    const mode = h("div", { class: "seg" },
      h("button", { type: "button", "aria-pressed": String(s.mode === "practice"), onclick: () => save({ mode: "practice" }) }, "Practice"),
      h("button", { type: "button", "aria-pressed": String(s.mode === "live"), disabled: !s.liveAvailable, title: s.liveAvailable ? "" : "Live mode opens after it passes real-money tests", onclick: () => save({ mode: "live" }) }, "Live"));
    const f = (key, label, step, suffix) => h("label", { class: "field" }, h("span", {}, label), h("div", { class: "row" }, h("input", { class: "input", type: "number", step, min: d.limits[key][0], max: d.limits[key][1], value: r[key], name: key }), suffix ? h("span", { class: "faint" }, suffix) : null));
    const form = h("div", { class: "ag-grid3" }, f("minRaisedEth", "Curve raised at least", "0.1", "ETH"), f("buyEth", "Buy per coin", "0.001", "ETH"), f("takeProfitX", "Take profit at", "0.1", "x"), f("stopPct", "Stop at", "1", "% down"), f("maxOpen", "Open at once", "1", ""), f("maxBuysPerDay", "Buys a day", "1", ""));
    const saveRules = h("button", { class: "btn primary", type: "button", onclick: () => save({ rules: Object.fromEntries([...form.querySelectorAll("input")].map((i) => [i.name, Number(i.value)])) }) }, "Save rules");
    const pub = h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.public, onchange: (e) => save({ public: e.target.checked }) }), "Show my results on the leaderboard (address shortened)");
    const st = d.stats;
    const line = (x) => `${x.closed} closed · ${x.pnlEth >= 0 ? "+" : ""}${ethf(x.pnlEth)}${x.winRate != null ? ` · ${(x.winRate * 100).toFixed(0)}% won` : ""}`;
    const open = d.positions.filter((p) => p.status === "open"), closed = d.positions.filter((p) => p.status === "closed");
    const row = (p) => h("div", { class: "ap-row" },
      h("div", { class: "grow" }, h("b", {}, `$${p.symbol}`), h("span", { class: "faint" }, ` · ${p.mode} · in ${ethf(p.amountEth)} at ${p.raisedAtEntry != null ? Number(p.raisedAtEntry).toFixed(2) : "–"} ETH raised · ${ago(p.openedAt)} ago`)),
      p.status === "open"
        ? h("div", { class: "row" }, h("span", {}, p.lastValueEth != null ? `${ethf(p.lastValueEth)} (${((p.lastValueEth / p.amountEth - 1) * 100).toFixed(1)}%)` : "checking…"), h("button", { class: "btn sm", type: "button", onclick: async () => { try { await api.post("autopilot/close", { id: p.id }); toast("Closed", "ok"); render(); } catch (e) { toast(e.message, "error"); } } }, "Close"))
        : h("span", { class: (p.pnlEth || 0) >= 0 ? "up" : "down" }, `${(p.pnlEth || 0) >= 0 ? "+" : ""}${ethf(p.pnlEth)} · ${p.reason}`));
    clear(main,
      h("div", { class: "ag-intro" }, h("h2", {}, "Sentry Autopilot"), h("p", {}, "Every Pons launch goes through Troya Gate about 90 seconds in, and again at 5, 15 and 60 minutes while it is quiet. When one passes and its curve has raised what you set, Autopilot buys, then sells at your take-profit or stop, or after 7 days. Practice mode uses play money at real prices; live mode trades from your Agent Wallet inside its caps.")),
      h("div", { class: "panel ag-panel" },
        h("div", { class: "ag-auto-h" }, h("div", {}, h("b", {}, s.on ? `On · ${s.mode === "live" ? "live, Agent Wallet" : "practice, play money"}` : "Off"), h("div", { class: "faint" }, s.liveAvailable ? "Live mode buys and sells from your Agent Wallet." : "Live mode opens after it passes real-money tests. Practice runs at real prices meanwhile.")), h("div", { class: "row" }, mode, sw)),
        h("hr", { class: "hr" }), h("h3", {}, "Your rules"), form, h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } }, pub, saveRules),
        h("p", { class: "note", style: { margin: 0 } }, "Same rules in Telegram: /autopilot set min 1 buy 0.01 tp 2 sl 30 max 3")),
      h("div", { class: "panel ag-panel" }, h("h3", {}, "Results"), h("div", { class: "rows" }, h("div", {}, h("span", {}, "Practice"), h("span", {}, line(st.practice))), h("div", {}, h("span", {}, "Live"), h("span", {}, line(st.live))), h("div", {}, h("span", {}, "Open now"), h("span", {}, String(st.open)))),
        h("a", { class: "link", href: "#/leaderboard" }, "See the leaderboard")),
      h("div", { class: "panel ag-panel" }, h("h3", {}, `Open (${open.length})`), open.length ? h("div", { class: "ap-list" }, open.map(row)) : h("p", { class: "faint", style: { margin: 0 } }, s.on ? "Waiting for the next launch that passes your rules." : "Switch it on to start.")),
      closed.length ? h("div", { class: "panel ag-panel" }, h("h3", {}, "Closed"), h("div", { class: "ap-list" }, closed.slice(0, 30).map(row))) : null);
  }
  render();
  const off = onWallet(() => render());
  const t = setInterval(() => { if (!document.hidden) render(); }, 30000);
  return () => { off(); clearInterval(t); };
}
