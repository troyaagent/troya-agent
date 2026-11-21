// Get started (#/start), and the very same checklist on the Desk and in Portfolio (getStarted below).
// Until 20 Nov three lists disagreed: four steps on the Desk, five in Portfolio and eleven here, with the custodial Agent
// Wallet as a required step 2. Now three steps lead to a first trade the Gate has checked, and the Agent Wallet, Telegram,
// Hyperliquid and X are an optional "Level up" that appears after it. Every tick has evidence, read live and never set by
// this browser on its own: the session, the wallet's ETH on Robinhood Chain (from the chain), the journal (swaps and bridges
// you signed) and /api/onboarding (Agent Wallet, Telegram, Hyperliquid, X).
// A link from a bot reply (#/start?for=launch-x) shows only what that feature needs, in order (18 Nov).
import { h, clear, icon, pageHead, toast, useCss, copyText, short } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, signIn, reader } from "../wallet.js";
import { tradingKeyStatus } from "../hl.js";

// t = title, s = one line for the Desk and Portfolio tiles, d = the full line on #/start
const STEPS = {
  signin: { t: "Connect and sign in", s: "Your wallet proves it is you. Signing is free and sends nothing.", d: "Your wallet proves who you are. Signing costs nothing and sends nothing, and Troya never sees your key." },
  rhEth: { t: "Get ETH on Robinhood Chain", s: "Bridge it in, or buy a coin with ETH on Base or Arbitrum.", d: "Trades and gas on Robinhood Chain are paid in ETH, and gas costs less than a cent. Bridge some in from Arbitrum, Base or Ethereum, or buy a coin on Swap with ETH you hold on Base or Arbitrum, in one signature." },
  firstSwap: { t: "Make a first Gate-checked swap", s: "From your own wallet. The Gate checks it before you sign.", d: "A small swap from your own wallet. Troya Gate checks the coin and simulates the trade from your address before your wallet signs. The agent can also prepare it as a ticket for you to sign." },
  agentWallet: { t: "Create your Agent Wallet", d: "A small wallet the agent trades from, with caps per trade and per day. It is custodial: Troya stores its key encrypted, so keep only what you are willing to lose in it. Withdrawals go only to your own wallet." },
  agentWalletOn: { t: "Switch your Agent Wallet on", d: "It only acts while it is on, inside its caps, and you can switch it off any time." },
  funded: { t: "Put a little ETH in your Agent Wallet", d: "Send ETH on Robinhood Chain to its address, or bridge it in from Arbitrum, Base or Ethereum. 0.0006 ETH is enough to start." },
  telegram: { t: "Link Telegram", d: "Trade, get the daily brief and smart alerts from a private chat with the bot." },
  hlFunded: { t: "Fund Hyperliquid", d: "One transaction turns ETH on Robinhood Chain into USDC on your own Hyperliquid account." },
  hlKey: { t: "Approve a trading key", d: "A trade-only key in this browser, approved once with your wallet on the Perps page. It can place and cancel orders; it cannot withdraw." },
  xLinked: { t: "Link your X account", d: "So a post to @Troyaagent knows which wallet it comes from. Troya reads your public profile only." },
  launchX: { t: "Switch on Launch from X", d: "Then post \"@Troyaagent launch Name $TICKER\" with an image, and your Agent Wallet launches the coin." },
  tradeX: { t: "Switch on Trade from X", d: "Then post \"@Troyaagent buy 0.01 $TROYA\", and your Agent Wallet trades it through the Gate." },
};
const CORE = ["signin", "rhEth", "firstSwap"];
// optional, shown after the first swap; a group with several parts is done when all of them are
const LEVEL = [
  { key: "agent", t: "Agent Wallet", s: "Lets the agent trade inside your caps. Custodial, so keep it small.", d: STEPS.agentWallet.d, parts: ["agentWallet", "agentWalletOn", "funded"] },
  { key: "tg", t: "Telegram", s: "Trades, the daily brief and alerts in a private chat.", d: STEPS.telegram.d, parts: ["telegram"] },
  { key: "hl", t: "Hyperliquid perps", s: "Fund it with USDC, then approve a trade-only key.", d: "Perps margin is USDC on your own Hyperliquid account. Fund it from Robinhood Chain in one transaction, then approve a trade-only key once: it can place and cancel orders, and it cannot withdraw.", parts: ["hlFunded", "hlKey"] },
  { key: "x", t: "X account", s: "So a post to @Troyaagent knows your wallet.", d: STEPS.xLinked.d, parts: ["xLinked"] },
];
export const FOR = {
  "launch-x": { title: "Get ready to launch from X", keys: ["signin", "agentWallet", "agentWalletOn", "funded", "xLinked", "launchX"], done: "Post \"@Troyaagent launch Name $TICKER\" with an image attached. Your coin goes live in seconds." },
  "trade-x": { title: "Get ready to trade from X", keys: ["signin", "agentWallet", "agentWalletOn", "funded", "xLinked", "tradeX"], done: "Post \"@Troyaagent buy 0.01 $TROYA\" or \"sell 50% $TROYA\". Troya replies with what it did." },
  "launch-tg": { title: "Get ready to launch in Telegram", keys: ["signin", "agentWallet", "agentWalletOn", "funded", "telegram"], done: "Send /launch to @TrojanTroya_bot in your private chat." },
  "trade-tg": { title: "Get ready to trade in Telegram", keys: ["signin", "agentWallet", "agentWalletOn", "funded", "telegram"], done: "Send a coin's contract address to @TrojanTroya_bot and tap Buy." },
  // 20 Nov: the web flows get their own short lists too (a coin page or the guide can link #/start?for=buy&token=0x…)
  buy: { title: "Get ready to buy a coin", keys: ["signin", "rhEth"], done: "Pick the coin and the amount on Swap. Troya Gate checks the coin and simulates the trade before your wallet signs.", go: ["Open Swap", "#/swap"] },
  "launch-web": { title: "Get ready to launch a coin", keys: ["signin", "rhEth"], done: "Open Create coin, pick a name, a ticker and an image, and sign the launch in your own wallet.", go: ["Create a coin", "#/create"] },
  perps: { title: "Get ready to trade perps", keys: ["signin", "hlFunded", "hlKey"], done: "Open Perps, pick a market and set a stop before you size up.", go: ["Open Perps", "#/perps"] },
};

/* ---------- evidence: one reading, shared by every place that shows the checklist ---------- */
const BAD = /revert|fail|block|reject|dry-run|cancel/i;
const SERVER_KEYS = ["agentWallet", "agentWalletOn", "funded", "telegram", "hlFunded", "xLinked", "launchX", "tradeX"];
/** Which steps are done, from one reading (see readSetup) and the session. Pure, so the Desk, Portfolio and #/start can
 *  never disagree for the same wallet. */
export function setupDone(v, session) {
  const j = Array.isArray(v?.journal) ? v.journal : [];
  const ok = (x) => !BAD.test(String(x?.status || ""));
  const dir = (x) => x?.data?.direction || x?.direction || "";
  // a first swap from your own wallet: a swap signed on Swap, a cross-chain buy (the server runs the Gate on the coin
  // before it quotes a route) or an agent ticket for a swap that you signed
  const swapped = j.some((x) => ok(x) && (x.kind === "swap" || x.kind === "proposal.swap" || (x.kind === "bridge" && dir(x) === "cross-buy")));
  const bridged = j.some((x) => ok(x) && x.kind === "bridge");
  const srv = {};
  for (const s of v?.server?.steps || []) if (s?.key) srv[s.key] = s;
  const done = {
    signin: !!session,
    // ETH there now, or proof it got there: a bridge you signed, or a swap (which paid gas on Robinhood Chain)
    rhEth: (typeof v?.eth === "bigint" && v.eth > 0n) || bridged || swapped,
    firstSwap: swapped,
    hlKey: v?.key === "approved",
  };
  for (const k of SERVER_KEYS) done[k] = !!srv[k]?.done;
  return { done, srv };
}
const levelOf = (d) => LEVEL.map((g) => { const next = g.parts.find((k) => !d[k]) || null; return { ...g, next, done: !next }; });

// extra = also read /api/onboarding and the Hyperliquid trading key; the Desk and Portfolio need them only after the first swap
const snap = { key: "", at: 0, v: null, p: null };
async function readSetup({ extra = false, force = false } = {}) {
  const addr = wallet.address || null, signed = !!wallet.session, key = `${addr || "-"}:${signed ? 1 : 0}`;
  if (!force && snap.key === key && snap.v && Date.now() - snap.at < 5000 && (snap.v.extra || !extra)) return snap.v;
  if (!force && snap.key === key && snap.p && (snap.p.extra || !extra)) return snap.p;
  const p = (async () => {
    const v = { addr, signed, extra, eth: null, journal: null, server: null, key: null, error: null };
    if (!addr) return v;
    await Promise.all([
      reader("robinhood").getBalance(addr).then((b) => { v.eth = b; }, () => {}),
      signed ? api.get("journal?limit=200").then((r) => { v.journal = Array.isArray(r?.items) ? r.items : []; }, () => {}) : null,
      extra ? tradingKeyStatus(addr).then((k) => { v.key = k?.state || null; }, () => {}) : null,
      extra && signed ? api.get("onboarding").then((r) => { v.server = r; }, (e) => { v.error = e.message; }) : null,
    ]);
    return v;
  })();
  p.extra = extra;
  snap.key = key; snap.p = p;
  const v = await p;
  if (snap.p === p) { snap.p = null; snap.v = v; snap.at = Date.now(); }
  return v;
}

/**
 * The checklist. layout "page" is #/start (full lines, every action, the Level up list); "card" is the Desk and Portfolio
 * tile row (desk.css .dk-steps), which turns into the Level up row after the first swap and hides once that is done too.
 * focus = a FOR key (page only). hide = a store() the card's Hide button writes. Returns { el, stop, refresh }.
 */
export function getStarted({ layout = "card", focus = null, hide = null, token = null } = {}) {
  useCss("start");
  const page = layout === "page";
  const F = page && focus && Object.hasOwn(FOR, focus) ? FOR[focus] : null;
  let v = null, busy = false, alive = true, peek = false, complete = false;
  const el = h(page ? "div" : "section", { class: page ? "st-page" : "dk-steps st-card", "aria-label": F ? F.title : "Get started" });
  const bar = h("div", { class: "st-bar" }, h("i")), count = h("span", { class: "st-count" });
  const list = h("ol", { class: "st-list" }), more = h("div", {});
  if (page) clear(el, pageHead(F ? F.title : "Get started", F ? "Only what this needs, in order. Each step ticks itself off as soon as it is done." : "Three steps to a first trade checked by Troya Gate. Each step ticks itself off as soon as it is done."),
    h("div", { class: "st-top" }, bar, count), list, more);

  async function load(force = false) {
    // the card reads the Level up sources only once this wallet has made its first swap
    const same = v && v.addr === (wallet.address || null) && v.signed === !!wallet.session;
    let x = await readSetup({ extra: page || !!(same && setupDone(v, wallet.session).done.firstSwap), force });
    if (!x.extra && setupDone(x, wallet.session).done.firstSwap) x = await readSetup({ extra: true });
    // a reading for a wallet or session that has changed since is dropped; the newer one is on its way
    if (!alive || x.addr !== (wallet.address || null) || x.signed !== !!wallet.session) return;
    v = x; paint();
  }
  const paint = () => (page ? paintPage() : paintCard());

  /* ---------- the one action that completes a step ---------- */
  function action(k, primary = true, compact = false) {
    const cls = `btn sm${primary ? " primary" : ""}`;
    const link = (label, href, c = cls) => h("a", { class: c, href }, label);
    const run = (label, fn) => h("button", { class: cls, type: "button", disabled: busy, onclick: async () => {
      busy = true; paint();
      try { await fn(); } catch (e) { toast(e.message, "error"); }
      busy = false; await load(true);
    } }, label);
    const info = (key) => v?.server?.steps?.find((s) => s.key === key) || {};
    if (k === "signin") return run(wallet.address ? "Sign in" : "Connect wallet", async () => { if (!wallet.address) await openConnect(); if (wallet.address && !wallet.session) await signIn(); });
    if (k === "rhEth") {
      if (compact) return link("Bridge ETH in", "#/bridge?dir=in");
      const eth = typeof v?.eth === "bigint" ? Number(v.eth) / 1e18 : null;
      return h("div", { class: "row st-acts" }, link([icon("bridge"), "Bridge ETH in"], "#/bridge?dir=in"), link("Buy from Base or Arbitrum", "#/swap", "btn sm"), eth != null ? h("span", { class: "faint" }, `${eth.toFixed(5)} ETH now`) : null);
    }
    if (k === "firstSwap") {
      if (compact) return link("Try a small swap", "#/swap");
      return h("div", { class: "row st-acts" }, link([icon("swap"), "Open Swap"], "#/swap"), link([icon("spark"), "Ask the agent for a ticket"], `#/agent?q=${encodeURIComponent("Help me make a first small swap on Robinhood Chain, checked by the Gate.")}`, "btn sm"));
    }
    if (k === "hlFunded") return link("Fund Hyperliquid", "#/bridge?dir=hl");
    if (k === "hlKey") return link(compact ? "Approve a key" : "Approve on Perps", "#/perps");
    if (!wallet.session) return null;                        // what follows changes your Troya account: sign in first
    // the Desk and Portfolio send the Agent Wallet steps to its own page, where its caps and the custody note sit
    if (compact && ["agentWallet", "agentWalletOn", "funded"].includes(k)) return link({ agentWallet: "Set it up", agentWalletOn: "Switch it on", funded: "Add ETH" }[k], "#/agent/wallet");
    if (k === "agentWallet") return run("Create it", () => api.post("agent-wallet/create"));
    if (k === "agentWalletOn") return run("Switch it on", () => api.post("agent-wallet/settings", { enabled: true }));
    if (k === "funded") {
      const a = info("agentWallet").address, eth = info("funded").eth;
      return h("div", { class: "row st-acts" }, link("Add ETH from my wallet", "#/agent/wallet"), a ? h("button", { class: "btn sm", type: "button", onclick: () => copyText(a, "Address copied") }, icon("copy"), short(a, 6)) : null, link([icon("bridge"), "Bridge ETH in"], "#/bridge?dir=in", "btn sm"), eth != null ? h("span", { class: "faint" }, `${Number(eth).toFixed(4)} ETH now`) : null);
    }
    if (k === "telegram") return run("Link Telegram", async () => { const r = await api.post("notify/telegram/link"); if (r.url) window.open(r.url, "_blank", "noopener"); else toast("Telegram is not configured on this server.", "error"); });
    if (k === "xLinked") return link("Link X", "/api/x/login?for=link&back=start");
    if (k === "launchX") return run("Switch on", () => api.post("launch/prefs", { x: true }));
    if (k === "tradeX") return run("Switch on", () => api.post("launch/prefs", { trade: true }));
    return null;
  }

  /* ---------- #/start ---------- */
  function paintPage() {
    const { done: d } = setupDone(v, wallet.session);
    const steps = (F ? F.keys : CORE).map((k) => ({ key: k, ...STEPS[k], done: d[k] }));
    const n = steps.filter((s) => s.done).length, all = n === steps.length, cur = steps.findIndex((s) => !s.done);
    bar.firstChild.style.width = `${(n / steps.length) * 100}%`;
    count.textContent = !v && wallet.address ? "Checking…" : `${n} of ${steps.length} done`;
    clear(list, steps.map((s, i) => h("li", { class: `st-step ${s.done ? "done" : ""} ${i === cur ? "now" : ""}` },
      h("span", { class: "st-n" }, s.done ? icon("check") : String(i + 1)),
      h("div", { class: "st-b" }, h("b", {}, s.t), h("p", {}, s.d), s.done ? null : action(s.key, i === cur)))));
    if (v?.error) list.append(h("li", { class: "alert error" }, v.error));
    if (F) {
      const go = F.go && (F === FOR.buy && token ? [F.go[0], `#/swap?in=eth&out=${token}`] : F.go);
      if (all) list.append(h("li", { class: "st-fin panel" }, h("b", {}, "You are set."), h("p", {}, F.done), go ? h("a", { class: "btn primary sm", href: go[1] }, go[0]) : null));
      clear(more, h("p", { class: "faint" }, h("a", { class: "link", href: "#/start" }, "See Get started")));
      return;
    }
    if (all) list.append(h("li", { class: "st-fin panel" }, h("b", {}, "You are set."), h("p", {}, "Your first trade went through the Gate. Everything below is optional. A good next step is Sentry Autopilot in practice mode: Agent → Sentry Autopilot, or /autopilot on in Telegram."), h("a", { class: "btn primary sm", href: "#/agent/sentry" }, "Open Sentry Autopilot")));
    if (!all && !peek) {
      clear(more, h("p", { class: "faint st-peek" }, "After your first swap, four optional extras appear here: the Agent Wallet, Telegram, Hyperliquid perps and your X account. ",
        h("button", { class: "link", type: "button", onclick: () => { peek = true; paint(); } }, "Show them now")));
      return;
    }
    const L = levelOf(d), m = L.filter((g) => g.done).length;
    clear(more, h("div", { class: "st-lv-h" }, h("h2", {}, "Level up"), h("span", { class: "st-count" }, `Optional · ${m} of ${L.length} done`)),
      h("ol", { class: "st-list" }, L.map((g, i) => h("li", { class: `st-step ${g.done ? "done" : ""}` },
        h("span", { class: "st-n" }, g.done ? icon("check") : String(i + 1)),
        h("div", { class: "st-b" }, h("b", {}, g.t, h("span", { class: "faint" }, " · optional")), h("p", {}, g.d),
          g.parts.length > 1 ? h("ul", { class: "st-parts" }, g.parts.map((k) => h("li", { class: d[k] ? "done" : k === g.next ? "now" : "" }, d[k] ? icon("check") : h("i"), STEPS[k].t))) : null,
          g.done ? null : wallet.session ? action(g.next, false) : h("span", { class: "faint" }, "Sign in first (step 1)."))))));
  }

  /* ---------- the Desk and Portfolio ---------- */
  function paintCard() {
    if (hide?.get()) { el.hidden = true; return; }
    const { done: d } = setupDone(v, wallet.session);
    const core = CORE.map((k) => ({ next: k, t: STEPS[k].t, s: STEPS[k].s, done: d[k] }));
    const n = core.filter((s) => s.done).length;
    const level = n === core.length && !!v?.extra;
    const items = level ? levelOf(d) : core;
    const m = items.filter((s) => s.done).length, nx = items.findIndex((s) => !s.done);
    complete = level && m === items.length;
    el.hidden = complete;
    if (complete) return;
    const pb = h("div", { class: "dk-bar", "aria-hidden": "true" }, h("i"));
    pb.style.setProperty("--p", `${(m / items.length) * 100}%`);       // a custom property needs setProperty, not style.x
    clear(el,
      h("div", { class: "dk-steps-h" },
        h("div", {}, h("b", {}, level ? "Level up" : "Get started"), h("span", { class: "fine" }, level ? ` Optional · ${m} of ${items.length} done` : !v && wallet.address ? " Checking…" : ` ${n} of ${core.length} done`)),
        pb,
        h("a", { class: "link fine", href: "#/start" }, level ? "Details" : "All steps"),
        hide ? h("button", { class: "link fine", type: "button", onclick: () => { hide.set(true); paint(); } }, "Hide") : null),
      h("ol", { class: `dk-steps-list${level ? "" : " st-3"}` }, items.map((s, i) => h("li", { class: s.done ? "done" : i === nx ? "next" : "" },
        h("span", { class: "sn" }, s.done ? icon("check") : String(i + 1)),
        h("div", { class: "st" }, h("b", {}, s.t), h("p", {}, s.s)),
        s.done ? h("span", { class: "fine" }, "Done") : action(s.next, i === nx, true) || h("a", { class: "btn sm", href: "#/start" }, "Open")))));
  }

  paint();
  const offW = onWallet(() => load());                        // also runs once now, for the first reading
  const t = setInterval(() => {
    if (document.hidden || !wallet.address || !el.isConnected || (!page && (complete || hide?.get()))) return;
    load();
  }, page ? 8000 : 30000);
  // back from a bridge or a swap in another tab: read again at once
  const vis = () => { if (!document.hidden && wallet.address && el.isConnected) load(); };
  document.addEventListener("visibilitychange", vis);
  return { el, refresh: () => load(true), stop() { alive = false; offW(); clearInterval(t); document.removeEventListener("visibilitychange", vis); } };
}

export async function mount(view, ctx) {
  const token = /^0x[0-9a-fA-F]{40}$/.test(ctx?.query?.token || "") ? ctx.query.token : null;
  const g = getStarted({ layout: "page", focus: ctx?.query?.for || null, token });
  clear(view, g.el);
  return () => g.stop();
}
