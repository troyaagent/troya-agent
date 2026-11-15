// Phase 8 · Start in 60 seconds (#/start): each setup step with its live status and the one action that completes it.
// Status comes from /api/onboarding (read from the chain, Hyperliquid and the journal), refreshed every few seconds.
import { h, clear, icon, pageHead, toast, useCss, copyText, short } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, signIn } from "../wallet.js";

const STEPS = [
  { key: "signin", t: "Connect and sign in", d: "Your wallet proves who you are. Signing costs nothing and sends nothing." },
  { key: "agentWallet", t: "Create your Agent Wallet", d: "A small wallet the agent trades from, with caps per trade and per day. Only you can withdraw from it." },
  { key: "funded", t: "Put a little ETH in it", d: "Send ETH on Robinhood Chain to the Agent Wallet address, or bridge it in from Arbitrum, Base or Ethereum." },
  { key: "telegram", t: "Link Telegram", d: "Trade, get the daily brief and smart alerts from a private chat with the bot." },
  { key: "hlFunded", t: "Fund Hyperliquid (for perps)", d: "One transaction turns ETH on Robinhood Chain into USDC on your own Hyperliquid account.", optional: true },
  { key: "hlApproved", t: "Let the agent trade perps", d: "Approve your Agent Wallet once on Hyperliquid. It can place and cancel orders; it cannot withdraw.", optional: true },
  { key: "firstTrade", t: "Make a first trade with the agent", d: "Ask in plain words. You get a ticket with the Gate result; nothing runs until you confirm." },
];

export async function mount(view) {
  useCss("start");
  let alive = true, st = null, busy = false;
  const list = h("ol", { class: "st-list" });
  const bar = h("div", { class: "st-bar" }, h("i"));
  const count = h("span", { class: "st-count" });
  clear(view, pageHead("Start in 60 seconds", "Set up Troya step by step. Each step ticks itself off as soon as it is done."), h("div", { class: "st-top" }, bar, count), list);

  async function load() {
    if (!wallet.session) { st = null; render(); return; }
    try { st = await api.get("onboarding"); } catch (e) { st = { error: e.message }; }
    if (alive) render();
  }
  const done = (k) => (k === "signin" ? !!wallet.session : !!st?.steps?.find((s) => s.key === k)?.done);
  const info = (k) => st?.steps?.find((s) => s.key === k) || {};

  function action(k) {
    const btn = (label, fn, cls = "btn primary sm") => h("button", { class: cls, type: "button", disabled: busy, onclick: async () => { busy = true; render(); try { await fn(); } catch (e) { toast(e.message, "error"); } busy = false; await load(); } }, label);
    if (k === "signin") return btn(wallet.address ? "Sign in" : "Connect wallet", async () => { if (!wallet.address) await openConnect(); if (wallet.address && !wallet.session) await signIn(); });
    if (!wallet.session) return null;
    if (k === "agentWallet") return btn("Create it", () => api.post("agent-wallet/create"));
    if (k === "funded") {
      const a = info("agentWallet").address;
      return h("div", { class: "row st-acts" }, a ? h("button", { class: "btn sm", type: "button", onclick: () => copyText(a, "Address copied") }, icon("copy"), short(a, 6)) : null, h("a", { class: "btn sm", href: "#/bridge?dir=in" }, icon("bridge"), "Bridge ETH in"), info("funded").eth != null ? h("span", { class: "faint" }, `${info("funded").eth.toFixed(4)} ETH now`) : null);
    }
    if (k === "telegram") return btn("Link Telegram", async () => { const r = await api.post("notify/telegram/link"); if (r.url) window.open(r.url, "_blank", "noopener"); else toast("Telegram is not configured on this server.", "error"); });
    if (k === "hlFunded") return h("a", { class: "btn sm", href: "#/bridge?dir=hl" }, "Fund Hyperliquid");
    if (k === "hlApproved") return h("a", { class: "btn sm", href: "#/agent/wallet" }, "Approve in Agent → Wallet");
    if (k === "firstTrade") return h("div", { class: "row st-acts" }, h("a", { class: "btn primary sm", href: `#/agent?q=${encodeURIComponent("What is worth watching today?")}` }, icon("spark"), "Ask the agent"), h("a", { class: "btn sm", href: "#/swap" }, "Try a small swap"));
    return null;
  }

  function render() {
    const n = STEPS.filter((s) => done(s.key)).length;
    bar.firstChild.style.width = `${(n / STEPS.length) * 100}%`;
    count.textContent = `${n} of ${STEPS.length} done`;
    let current = STEPS.findIndex((s) => !done(s.key) && !s.optional);
    if (current < 0) current = STEPS.findIndex((s) => !done(s.key));
    clear(list, STEPS.map((s, i) => h("li", { class: `st-step ${done(s.key) ? "done" : ""} ${i === current ? "now" : ""}` },
      h("span", { class: "st-n" }, done(s.key) ? icon("check") : String(i + 1)),
      h("div", { class: "st-b" }, h("b", {}, s.t, s.optional ? h("span", { class: "faint" }, " · optional") : null), h("p", {}, s.d), done(s.key) ? null : action(s.key)))));
    if (st?.error) list.append(h("li", { class: "alert error" }, st.error));
    if (n === STEPS.length) list.append(h("li", { class: "st-fin panel" }, h("b", {}, "You are set."), h("p", {}, "Try Sentry Autopilot in practice mode next: Agent → Sentry Autopilot, or /autopilot on in Telegram."), h("a", { class: "btn primary sm", href: "#/agent/sentry" }, "Open Sentry Autopilot")));
  }

  render(); load();
  const off = onWallet(() => load());
  const t = setInterval(() => { if (!document.hidden && wallet.session) load(); }, 8000);
  return () => { alive = false; off(); clearInterval(t); };
}
