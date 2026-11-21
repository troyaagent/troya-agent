// Desk (#/): one calm page that answers "where am I, what's moving, what is my agent doing, what next".
// Audit, 21 Nov 2026: the big hero filled the whole first screen (558 px on desktop, 821 px on a phone) and the coin list
// started at y=5843 on a phone, while a connected wallet saw none of its own money. So now:
//   first visit   a slim intent bar (no modal, no loader), then the big hero with the ask bar in it
//   returning     a compact top strip (one line, the ask bar, three chips, the fee line, a small horse mark), at most 220 px
//   connected     a "You" row: Robinhood Chain and Hyperliquid balances, open positions, today's PnL, approvals waiting
//   then          Troya picks and trending coins with quick buy chips, Sentry's latest checks, quick tiles, the rest.
// The intent ("Buy a coin", "Check a coin" …) only reorders the sections; it is kept in this browser and nothing else.
import { h, clear, icon, useCss, every, sparkline, pctEl, usd, tiny, toast, store, infoTip, tokenIcon, coinIcon, short, ago, table } from "/agent/js/ui.js";
import { api, cached } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signIn } from "/agent/js/wallet.js";
import { getStarted } from "/agent/js/pages/start.js";
import { tokenCell, priceCell, perpPrice, fmtApr, perpName, cleanPerpText } from "/agent/js/marketlib.js";
import { gatePanel } from "./gate.js";
import { chromeIcon } from "./chrome-icons.js";
import { mountPassStrip, mountGraduated } from "./pulse.js";   // community requests 21 Nov: Passed strip + Just graduated lane

const hideSteps = store("troya.home.hideSteps", false);
const autoPref = store("troya.autopilot", { on: false, playbooks: true, chat: false });
const visited = store("troya.desk.visited", 0);
const intentPref = store("troya.desk.intent", null);
const coinTab = store("troya.desk.coins", "picks");
const HORSE = "/img/logo-3d-512.webp";   // 66 KB; the 1024 px PNG it replaces was 651 KB
const BUY_ETH = ["0.005", "0.01", "0.05"];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const INTENTS = [["buy", "Buy a coin"], ["check", "Check a coin"], ["launch", "Launch a coin"], ["perps", "Trade perps"], ["look", "Just looking"]];

// The big hero is for the first visit only: this browser has never opened the Desk, or first did so in this browser
// session (so moving around the app on day one keeps the same page). Storage that throws counts as a first visit.
function isFirstVisit() {
  let firstThisSession = false;
  try { firstThisSession = sessionStorage.getItem("troya.desk.first") === "1"; } catch {}
  if (firstThisSession) return true;
  if (visited.get()) return false;
  visited.set(Date.now());
  try { sessionStorage.setItem("troya.desk.first", "1"); } catch {}
  return true;
}
// a quick buy opens Swap on its review: the Gate checks the coin and the wallet still signs (or not)
const buyHref = (a, eth) => `#/swap?${new URLSearchParams({ in: "eth", out: a, amount: eth, review: "1" })}`;

export async function mount(view, { go, ask: askDrawer }) {
  useCss("home");
  const stops = [];
  let alive = true;
  stops.push(() => { alive = false; });
  const ask = (q) => (askDrawer ? askDrawer(q) : go(`#/agent?q=${encodeURIComponent(q)}`));
  const first = isFirstVisit();
  let intent = INTENTS.some(([k]) => k === intentPref.get()) ? intentPref.get() : null;

  /* ---------- the ask bar: paste a coin (opens it in the Gate) or ask Troya ---------- */
  const CHIPS = [["What's running hot?", "What is moving most on Robinhood Chain and Hyperliquid in the last 24 hours?"],
    ["Crowded funding", "Which Hyperliquid perps have the most stretched funding right now, and who is paying whom?"],
    ["How Troya works", "How does Troya work, and what can it do without my signature?"]];
  const inputs = [];
  function askBlock(cls) {
    const input = h("input", { class: "ask-in", type: "text", placeholder: "Paste a coin or ask Troya…", "aria-label": "Paste a coin address or ask your agent", maxlength: "500", autocomplete: "off", spellcheck: "false" });
    inputs.push(input);
    const submit = () => {
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      input.value = "";
      if (ADDR_RE.test(q)) go(`#/gate/${q}`); else ask(q);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    return h("div", { class: `dk-askb ${cls}` },
      h("div", { class: "ask-bar" }, icon("spark", "ask-ico"), input, h("kbd", {}, "/"), h("button", { class: "btn primary", type: "button", onclick: submit }, "Ask", icon("arrowUp"))),
      h("div", { class: "chips ask-chips dk-chips" }, CHIPS.map(([t, q]) => h("button", { class: "chip", type: "button", onclick: () => ask(q) }, t))));
  }
  // "/" jumps to whichever ask bar is on screen
  const slash = (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable) return;
    const el = inputs.find((x) => x.isConnected && x.offsetParent);
    if (el) { e.preventDefault(); el.focus(); }
  };
  document.addEventListener("keydown", slash);
  stops.push(() => document.removeEventListener("keydown", slash));
  const feeLine = h("a", { class: "dk-fee", href: "/plans", target: "_self" }, "0% Troya fee · Gate on every order · your keys");

  /* ---------- returning visitors and connected wallets: the compact top strip ---------- */
  const strip = h("section", { class: "dk-strip", "aria-label": "Ask Troya" },
    h("a", { class: "dk-mark", href: "#/flywheel", "aria-label": "$TROYA flywheel" }, h("img", { src: HORSE, alt: "", width: "512", height: "512", decoding: "async" })),
    h("div", { class: "dk-strip-b" },
      h("p", { class: "dk-promise" }, h("b", {}, "Every coin opened at the gate."), h("span", {}, " Troya checks the coin and simulates your trade before your wallet signs.")),
      askBlock("in-strip"),
      feeLine));

  /* ---------- first visit: what brought you here (reorders the page, nothing else) ---------- */
  const intentChips = h("div", { class: "chips dk-intent-c", role: "group", "aria-label": "What brings you here?" });
  const paintIntent = () => clear(intentChips, INTENTS.map(([k, t]) => h("button", { class: "chip", type: "button", "aria-pressed": String(intent === k), onclick: () => { intent = intent === k ? null : k; intentPref.set(intent); paintIntent(); layout(); } }, t)));
  paintIntent();
  const intentBar = h("section", { class: "dk-intent" },
    h("div", { class: "dk-intent-h" }, h("b", {}, "What brings you here?"), intentChips),
    h("p", { class: "dk-intent-n" }, "No wallet needed to look around: ask Troya or gate any coin."));

  /* ---------- Get started: the same three steps (then the optional Level up) as Portfolio and #/start ---------- */
  const setup = getStarted({ layout: "card", hide: hideSteps });
  stops.push(setup.stop);

  /* ---------- You: the connected wallet's money and what waits for it ---------- */
  const youCell = (label, tip, href) => {
    const v = h("div", { class: "v" }, "…"), s = h("div", { class: "s" }, " ");
    return { v, s, el: h("a", { class: "dk-me-c", href }, h("div", { class: "k" }, label, tip ? infoTip(tip) : null), v, s) };
  };
  const yRh = youCell("Robinhood Chain", "ETH plus the coins and stock tokens this wallet holds on Robinhood Chain, at live prices.", "#/portfolio");
  const yHl = youCell("Hyperliquid", "Perp account value in USDC on your own Hyperliquid account.", "#/portfolio");
  const yPos = youCell("Open positions", "Hyperliquid perps open now, with their unrealised PnL.", "#/perps");
  const yPnl = youCell("PnL today", "Closed Hyperliquid trades since midnight on this device's clock, after fees. Open positions are shown apart.", "#/portfolio/history");
  const yWait = youCell("Waiting for you", "Agent tickets waiting for your approval in Scepter, and unread messages in your Inbox.", "#/agent/scepter");
  const you = h("section", { class: "dk-me", "aria-label": "You" }, yRh.el, yHl.el, yPos.el, yPnl.el, yWait.el);
  const signed = (v) => h("span", { class: v > 0 ? "up" : v < 0 ? "down" : "" }, `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v))}`);
  let youSeq = 0;
  async function loadYou() {
    const addr = wallet.address;
    if (!addr || !alive) return;
    const my = ++youSeq;
    const [bal, toks, px, hl, props, inbox] = await Promise.all([
      api.get(`chain/balances?address=${addr}`).catch(() => null),
      api.get(`/api/portfolio/tokens?address=${addr}`).catch(() => null),
      api.get("price/eth").catch(() => null),
      api.get(`hl/user?address=${addr}`).catch(() => null),
      wallet.session ? api.get("inbox/proposals?due=1").catch(() => null) : null,
      wallet.session ? api.get("inbox?unread=1&limit=1").catch(() => null) : null]);
    if (!alive || my !== youSeq || addr !== wallet.address) return;
    const ethUsd = Number(px?.usd) || Number(toks?.ethUsd) || 0;
    const list = bal?.balances || [];
    const ethAmt = Number(list.find((b) => b.address === "native" || b.symbol === "ETH")?.amount ?? NaN);
    // coins at live prices from Portfolio's own source; without it, at least WETH and USDG from the chain read
    let tokUsd = toks ? Number(toks.totalUsd) || 0 : null, nToks = toks ? (toks.tokens || []).filter((t) => Number(t.valueUsd) > 0.01).length : null;
    if (tokUsd == null && list.length) {
      tokUsd = list.reduce((s, b) => s + (b.symbol === "USDG" ? Number(b.amount) : b.symbol === "WETH" ? Number(b.amount) * ethUsd : 0), 0);
      nToks = list.filter((b) => b.address !== "native" && Number(b.amount) > 0).length;
    }
    if (!bal && !toks) { yRh.v.textContent = "–"; yRh.s.textContent = "balances unavailable right now"; }
    else {
      yRh.v.textContent = usd((Number.isFinite(ethAmt) && ethUsd ? ethAmt * ethUsd : 0) + (tokUsd || 0));
      yRh.s.textContent = `${Number.isFinite(ethAmt) ? `${tiny(ethAmt)} ETH` : "ETH –"}${nToks ? ` · ${nToks} coin${nToks === 1 ? "" : "s"}` : ""}`;
    }
    if (!hl) {
      for (const c of [yHl, yPos, yPnl]) { c.v.textContent = "–"; c.s.textContent = "Hyperliquid unavailable right now"; }
    } else {
      yHl.v.textContent = usd(hl.accountValue || 0);
      yHl.s.textContent = `withdrawable ${usd(hl.withdrawable || 0)}`;
      const n = (hl.positions || []).length;
      yPos.v.textContent = String(n);
      clear(yPos.s, n ? h("span", {}, "open PnL ", signed(hl.unrealizedPnl || 0)) : "none open");
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const today = (hl.fills || []).filter((f) => f.time >= midnight.getTime());
      const closed = today.reduce((s, f) => s + (Number(f.closedPnl) || 0) - (Number(f.fee) || 0), 0);
      clear(yPnl.v, today.length ? signed(closed) : usd(0));
      yPnl.s.textContent = today.length ? `${today.length} fill${today.length === 1 ? "" : "s"} on Hyperliquid` : "no closed trades today";
    }
    if (!wallet.session) {
      yWait.v.textContent = "–";
      clear(yWait.s, h("button", { class: "link", type: "button", onclick: async (e) => { e.preventDefault(); e.stopPropagation(); try { await signIn(); } catch (err) { toast(err.message, "error"); } } }, "Sign in to see approvals"));
    } else {
      const pend = (props?.items || []).filter((p) => p.status === "pending" && (!p.expiresAt || p.expiresAt > Date.now())).length;
      const unread = Number(inbox?.unread || 0);
      yWait.v.textContent = props || inbox ? String(pend + unread) : "–";
      yWait.s.textContent = props || inbox ? `${pend} to approve · ${unread} unread` : "unavailable right now";
      yWait.el.setAttribute("href", pend || !unread ? "#/agent/scepter" : "#/portfolio/inbox");
      yWait.el.classList.toggle("hot", pend + unread > 0);
    }
  }
  stops.push(every(60000, () => loadYou()));

  /* ---------- the agent: wallet, autopilots, playbooks, alerts ---------- */
  const agentBody = h("div", { class: "dk-agent-b" });
  const agent = h("section", { class: "panel dk-agent" },
    h("div", { class: "panel-h" }, h("h2", {}, "Your agent", infoTip("What the agent may do for you, and what is running now. Nothing moves without your caps and your rules.")), h("a", { class: "link fine", href: "#/agent/wallet" }, "Agent settings")),
    agentBody);
  const line = (ic, t, val, href, cls = "") => h("a", { class: `dk-line ${cls}`, href }, h("span", { class: "dk-line-ic" }, icon(ic)), h("span", { class: "dk-line-t" }, t), h("span", { class: "dk-line-v" }, val), icon("arrowRight", "dk-line-go"));
  async function renderAgent() {
    if (!wallet.session) {
      clear(agentBody,
        h("div", { class: "dk-lock" },
          h("p", {}, wallet.address ? "Sign in once to see your Agent Wallet, Autopilot and playbooks. Signing proves the wallet is yours; it costs nothing and sends nothing." : "Connect a wallet and sign in to give Troya an Agent Wallet with caps, rules for Autopilot and playbooks that watch for you."),
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), wallet.address ? "Sign in" : "Connect wallet")),
        line("wallet", "Agent Wallet", "Small wallet with daily caps", "#/agent/wallet", "dim"),
        line("bolt", "Autopilot", "Runs approved tickets in this tab", "#/agent/autopilot", "dim"),
        line("eye", "Sentry Autopilot", "Your rules on every new launch", "#/agent/sentry", "dim"),
        line("clock", "Playbooks", "Alerts and orders on triggers", "#/agent/playbooks", "dim"));
      return;
    }
    clear(agentBody, h("div", { class: "sk", style: { height: "150px" } }));
    const [aw, ap, wt, nt] = await Promise.all([
      api.get("agent-wallet").catch(() => null), api.get("autopilot").catch(() => null),
      api.get("watches").catch(() => null), api.get("notify/status").catch(() => null)]);
    const pilot = !!autoPref.get().on;
    const sa = ap?.settings;
    const active = (wt?.items || []).filter((w) => w.status === "active").length;
    clear(agentBody,
      line("wallet", "Agent Wallet", !aw?.exists ? "Not created yet" : `${aw.enabled ? "On" : "Off"}${aw.caps ? ` · ${usd(aw.caps.perTradeUsd)} a trade · ${usd(aw.caps.dailyUsd)} a day` : ""}`, "#/agent/wallet", aw?.exists && aw.enabled ? "on" : ""),
      line("bolt", "Autopilot", pilot ? "On in this tab" : "Off", "#/agent/autopilot", pilot ? "on" : ""),
      line("eye", "Sentry Autopilot", sa ? (sa.on ? `On · ${sa.mode === "live" ? "live" : "practice"}` : `Off · ${sa.mode === "live" ? "live" : "practice"} mode`) : "Set your rules", "#/agent/sentry", sa?.on ? "on" : ""),
      line("clock", "Playbooks", wt ? `${active} active of ${(wt.items || []).length}` : "None yet", "#/agent/playbooks", active ? "on" : ""),
      line("bell", "Telegram alerts", nt?.configured ? (nt.linked ? "Linked" : "Not linked") : "Not available here", "#/settings", nt?.linked ? "on" : ""));
  }

  /* ---------- brief + signals (same sources as before) ---------- */
  const briefBody = h("div", { class: "panel-b" }, h("div", { class: "sk", style: { height: "80px" } }));
  const briefTime = h("span", { class: "fine" });
  const brief = h("section", { class: "panel brief" },
    h("div", { class: "panel-h" }, h("h2", {}, "Brief", infoTip("Written from live Hyperliquid and Robinhood Chain data each minute. Facts only, no forecasts.")), h("span", { class: "row" }, h("span", { class: "live-dot" }), briefTime)),
    briefBody);
  const sigBody = h("div", { class: "panel-b sig-list" }, h("div", { class: "sk", style: { height: "80px" } }));
  const sigs = h("section", { class: "panel signals" }, h("div", { class: "panel-h" }, h("h2", {}, "Signals", infoTip("Things worth a look right now. They are thresholds, not recommendations."))), sigBody);

  /* ---------- Hyperliquid movers: real links, so cmd-click opens a new tab ---------- */
  let sparks = {};
  const hlTbl = table({
    href: (m) => `#/perps/${encodeURIComponent(m.coin)}`,
    emptyText: "No Hyperliquid perp moved enough to list.",
    cols: [
      { key: "coin", label: "Market", align: "l", render: (m) => h("div", { class: "tok" }, coinIcon(m.coin), h("div", {}, h("b", {}, perpName(m)), h("small", {}, `OI ${usd(m.oiUsd, { compact: true })}`))) },
      { key: "spark", label: "", cls: "hide-s", render: (m) => sparkline(sparks[m.coin]) },
      { key: "mark", label: "Price", render: (m) => perpPrice(m.mark) },
      { key: "change24h", label: "24h", render: (m) => pctEl(m.change24h) },
      { key: "fundingApr", label: "Funding/yr", cls: "hide-s", render: (m) => h("span", { class: Math.abs(m.fundingApr) >= 100 ? (m.fundingApr > 0 ? "warnc" : "down") : "muted" }, fmtApr(m.fundingApr)) },
      { key: "volumeUsd", label: "Volume", cls: "hide-s", render: (m) => usd(m.volumeUsd, { compact: true }) },
    ] });
  hlTbl.setLoading(6);
  const hlTable = h("section", { class: "panel movers" },
    h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid movers", infoTip("Perps with more than $1M of 24h volume, sorted by the size of the 24h move.")), h("a", { class: "link fine", href: "#/market?tab=perps" }, "All perps")),
    hlTbl);

  /* ---------- coins: Troya picks first (not raw volume), trending a tap away, quick buy chips on each row ---------- */
  // a price no source refreshed for 15 minutes says how old it is, as on the Market (server clock: d.now)
  let coinNow = Date.now();
  const hotPrice = (t) => {
    const c = priceCell(t.priceEth, t.priceUsd), age = t.priceAt ? coinNow - t.priceAt : 0;
    if (age > 15 * 60_000) c.append(h("span", { class: "sub warnc" }, `price ${age < 3600_000 ? `${Math.round(age / 60_000)} min` : `${Math.floor(age / 3600_000)} h`} old`));
    return c;
  };
  const liqCell = (t) => h("div", { class: "pcell", title: t.liquidityUsd != null ? `Pool total ${usd(t.liquidityUsd, { compact: true })} incl. the coin side` : "" },
    h("span", {}, t.realLiquidityUsd != null ? usd(t.realLiquidityUsd, { compact: true }) : "–"));
  const buyChips = (t) => h("div", { class: "dk-buy", role: "group", "aria-label": `Buy ${t.symbol || "this coin"} with ETH` },
    BUY_ETH.map((a) => h("a", { class: "chip", href: buyHref(t.address, a), title: `Review a ${a} ETH buy of ${t.symbol || "this coin"}: the Gate checks it and your wallet signs` }, a)));
  const coinTbl = table({
    href: (t) => `#/token/${t.address}`,
    emptyText: "No coins to show right now.",
    cols: [
      { key: "symbol", label: "Coin", align: "l", render: (t) => h("div", { class: "dk-coin" }, tokenCell(t), t.pick?.why?.[0] ? h("span", { class: "dk-why" }, t.pick.why[0]) : null) },
      { key: "priceUsd", label: "Price", cls: "hide-s", render: hotPrice },
      { key: "change24h", label: "24h", render: (t) => pctEl(t.change24h) },
      { key: "realLiquidityUsd", label: "Liquidity", cls: "hide-s", render: liqCell },
      { key: "buy", label: "Buy (ETH)", cls: "dk-buy-td", render: buyChips },
    ] });
  coinTbl.setLoading(6);
  const coinSeg = h("div", { class: "seg dk-coin-seg" });
  const coinNote = h("p", { class: "fine muted dk-coin-note" });
  const paintSeg = () => clear(coinSeg, [["picks", "Troya picks"], ["trending", "Trending"]].map(([k, t]) => h("button", { type: "button", "aria-pressed": String(coinTab.get() === k), onclick: () => { if (coinTab.get() === k) return; coinTab.set(k); paintSeg(); coinTbl.setLoading(6); loadCoins(); } }, t)));
  paintSeg();
  const coins = h("section", { class: "panel movers dk-coins" },
    h("div", { class: "panel-h" }, h("h2", {}, "Coins on Robinhood Chain", infoTip("Troya picks: coins with real money in their pools, real trading and spread-out holders, scored by the Market. Trending: the most traded today, wash-traded pools left out. A buy chip opens Swap on its review: the Gate checks the coin and nothing moves until your wallet signs.")),
      h("span", { class: "row" }, coinSeg, h("a", { class: "link fine", href: "#/market" }, "Full market"))),
    coinTbl, coinNote);
  let coinSeq = 0;
  async function loadCoins() {
    const my = ++coinSeq, tab = coinTab.get() === "trending" ? "trending" : "picks";
    try {
      const d = await cached(tab === "picks" ? "market/robinhood?cat=picks&sort=picks&limit=7" : "market/robinhood?cat=trending&sort=volume&limit=7", 15000);
      if (!alive || my !== coinSeq) return;
      coinNow = d.now || Date.now();
      coinTbl.setRows((d.tokens || []).slice(0, 7));
      coinNote.textContent = tab === "picks" ? `${d.catCounts?.picks ?? d.total ?? 0} coins pass the picks bar today. Scores, not advice.` : "Most traded in the last 24 hours. Volume alone is not quality: open the Gate before you buy.";
    } catch (e) { if (my === coinSeq && alive) { tblMsg(coinTbl, `The Robinhood Chain board is unavailable: ${e.message}`); coinNote.textContent = ""; } }
  }

  /* ---------- Sentry: latest results, green only for real buying ---------- */
  const senBody = h("div", { class: "dk-sentry-b" }, h("div", { class: "sk", style: { height: "120px" } }));
  const sentry = h("section", { class: "panel dk-sentry" },
    h("div", { class: "panel-h" }, h("h2", {}, "Sentry", infoTip("Every new Pons launch, and every new pool on Uniswap and the other Robinhood Chain launchpads, goes through the Gate. Green means it passed and has real buying (at least 0.5 ETH in from 25 independent buyers), the channel's bar. Checks passed means nothing failed, but real buying has not shown up yet.")),
      h("span", { class: "row" }, h("a", { class: "link fine", href: "#/agent/sentry" }, "Sentry Autopilot"), h("a", { class: "link fine", href: "https://t.me/troyasentry", target: "_blank", rel: "noopener" }, "Channel"))),
    senBody);

  /* ---------- quick tiles ---------- */
  const tile = (ic) => h("span", { class: "d2-tile" }, chromeIcon(ic));
  const quick = h("section", { class: "d2-quick" },
    [["market", "Buy a coin", "Every coin on Robinhood Chain", "#/market"], ["gate", "Gate a coin", "Seven checks before you buy", "#/gate"],
     ["launch", "Launch", "Create a coin with the Gate on it", "#/create"], ["perps", "Perps", "Crypto, stocks and metals", "#/perps"]]
      .map(([ic, t, d, href]) => h("a", { class: "d2-q", href }, tile(ic), h("span", {}, h("b", {}, t), h("small", {}, d)))));

  /* ---------- shortcuts: every tool, one line each ---------- */
  const COPY = ["leaderboard", "Copy", "Follow traders from the leaderboard", "#/leaderboard"];
  const STOCKS = ["stocks", "Stocks", "Tokenized stocks with live prices and dividends", "#/stocks"];
  const tools = [
    ["swap", "Swap", "Coins and tokenized stocks on Robinhood Chain", "#/swap"],
    ["liquidity", "Earn on liquidity", "Ranges set from volatility", "#/liquidity"],
    ["bridge", "Bridge", "Bring ETH in from Ethereum, Arbitrum or Base", "#/bridge"],
    ["spark", "Build an agent", "From your own playbooks", "#/social/agents"],
    STOCKS,
    ["agent", "API and MCP", "Give your own agent a scoped token", "#/agent/wallet?panel=api"],
  ];
  const toolsGrid = h("div", { class: "dk-tools-g" });
  const paintTools = () => clear(toolsGrid, tools.map(([ic, t, d, href]) => h("a", { class: "dk-tool", href }, h("span", { class: "dk-tool-ic d2-tile" }, chromeIcon(ic)), h("b", {}, t), h("span", {}, d))));
  paintTools();
  // the leaderboard is empty until traders opt in; until then the Copy shortcut would lead nowhere, so Stocks takes its place
  api.get("leaderboard?days=30").then((d) => { if (d?.rows?.length && alive) { tools[4] = COPY; paintTools(); } }).catch(() => {});
  const shortcuts = h("section", { class: "panel dk-tools" },
    h("div", { class: "panel-h" }, h("h2", {}, "Tools"), h("a", { class: "link fine", href: "#/docs" }, "Docs")),
    toolsGrid);

  const gate = gatePanel({ go, ask, compact: true });
  stops.push(gate.stop);

  /* ---------- first-visit hero: the Troya horse, the promise, the ask bar, live numbers ---------- */
  const CA = (window.SITE && window.SITE.ca) || "";
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
  const troyaPx = (n) => `$${tiny(n)}`;
  const kpi = (label, v, s) => h("div", { class: "d2-kpi" }, h("div", { class: "l" }, label), v, s);
  const kEth = h("div", { class: "v" }, "–"), kEthS = h("div", { class: "s" }, "gas under $0.01");
  const kTro = h("div", { class: "v" }, "–"), kTroS = h("div", { class: "s" }, "on chain, live");
  const kSen = h("div", { class: "v" }, "–"), kSenS = h("div", { class: "s" }, "Sentry calls");
  const kBurn = h("div", { class: "v" }, "–"), kBurnS = h("div", { class: "s" }, "of the 1B minted");
  const tagGateB = h("b", {}, "Troya Gate"), tagGateS = h("small", {}, "$TROYA, checking…");
  const tagFlyB = h("b", {}, "Flywheel"), tagFlyS = h("small", {}, "reading the chain…");
  const hero = h("section", { class: "d2-hero dk-first" },
    h("div", { class: "d2-beams", "aria-hidden": "true" }),
    h("div", { class: "d2-txt" },
      h("p", { class: "d2-mic" }, h("i", { class: "live-dot" }), "Live · Robinhood Chain"),
      h("h1", {}, "Every coin", h("br"), h("em", {}, "opened"), h("span", {}, " at the"), h("br"), h("span", {}, "gate.")),
      h("p", { class: "d2-lead" }, "Troya reads the chain, simulates every trade from your own address and tells you what it found, before your wallet signs anything."),
      askBlock("in-hero"),
      h("div", { class: "d2-kpis" }, kpi("ETH", kEth, kEthS), kpi("$TROYA", kTro, kTroS), kpi("Sentry", kSen, kSenS), kpi("Burned", kBurn, kBurnS))),
    h("div", { class: "d2-stage" },
      h("div", { class: "d2-floor", "aria-hidden": "true" }), h("div", { class: "d2-logo-w", "aria-hidden": "true" }, h("img", { class: "d2-logo", src: HORSE, alt: "", width: "512", height: "512", decoding: "async" })),
      h("a", { class: "d2-tag t1", href: CA ? `#/gate/${CA}` : "#/gate" }, tile("verify"), h("span", {}, tagGateB, tagGateS)),
      h("a", { class: "d2-tag t2", href: "#/flywheel" }, tile("flywheel"), h("span", {}, tagFlyB, tagFlyS))));
  // the hero's numbers are read only while the hero is on the page
  const heroOn = () => alive && hero.isConnected;
  async function heroNumbers() {
    if (!heroOn()) return;
    try {
      const f = await api.get("flywheel");
      if (f.price?.troyaUsd) kTro.textContent = troyaPx(f.price.troyaUsd);
      if (f.burned) { kBurn.textContent = compact(f.burned.total); kBurnS.textContent = `${f.burned.pctOfMinted.toFixed(2)}% of the 1B minted`; tagFlyB.textContent = `${compact(f.burned.total)} burned`; }
      const c = f.totals?.cycles || 0; tagFlyS.textContent = `flywheel · ${c} cycle${c === 1 ? "" : "s"}`;
    } catch { tagFlyS.textContent = "flywheel"; }
    try { const r = await api.get("record?limit=1"); kSen.textContent = String(r.stats.calls); kSenS.textContent = `calls, ${r.stats.graded} graded in public`; } catch {}
    if (CA) try {
      const b = await api.get(`/api/badge/${CA}`);
      const n = (b.checks || []).length, pass = (b.checks || []).filter((c) => c.status === "pass").length;
      if (n) { tagGateB.textContent = `${pass} / ${n} passed`; tagGateS.textContent = `$TROYA · Gate${b.checkedAt ? `, ${ago(b.checkedAt)}` : ""}`; }
    } catch { tagGateS.textContent = "$TROYA · open the Gate"; }
  }

  /* ---------- ETH / $TROYA chart ---------- */
  const TF = { "1D": { hl: ["15m", 24], rh: "15m" }, "1W": { hl: ["1h", 168], rh: "1h" }, "1M": { hl: ["4h", 720], rh: "4h" } };
  const cst = { sym: "ETH", tf: "1W", chart: null, series: null, seq: 0 };
  const chBox = h("div", { class: "d2-chart-box" }), chPx = h("span", { class: "d2-chart-px" }, "–"), chCh = h("span", { class: "d2-chart-ch" }), chSrc = h("span", { class: "fine muted" });
  const segOf = (list, cur, on) => h("div", { class: "seg" }, list.map((v) => h("button", { type: "button", "aria-pressed": String(v === cur), onclick: () => on(v) }, v)));
  const chartHead = h("div", { class: "panel-h d2-chart-top" });
  const chart = h("section", { class: "panel d2-chart" }, chartHead, h("div", { class: "d2-chart-h" }, chPx, chCh, chSrc), chBox);
  const paintChartHead = () => clear(chartHead,
    h("div", { class: "d2-chart-sym" }, tokenIcon(cst.sym === "ETH" ? { symbol: "ETH" } : { symbol: "TROYA", address: CA }, "sm"), segOf(["ETH", ...(CA ? ["$TROYA"] : [])], cst.sym === "ETH" ? "ETH" : "$TROYA", (v) => { cst.sym = v === "ETH" ? "ETH" : "TROYA"; paintChartHead(); loadChart(); })),
    segOf(Object.keys(TF), cst.tf, (v) => { cst.tf = v; paintChartHead(); loadChart(); }));
  async function loadChart() {
    const my = ++cst.seq;
    try {
      const t = TF[cst.tf];
      const d = cst.sym === "ETH" ? await api.get(`market/hl/candles?coin=ETH&interval=${t.hl[0]}&hours=${t.hl[1]}`) : await api.get(`market/robinhood/candles?address=${CA}&interval=${t.rh}`);
      if (my !== cst.seq || !alive) return;
      const seen = new Set();
      const rows = (d.candles || []).filter((c) => c && c.close > 0 && !seen.has(c.time) && seen.add(c.time)).sort((x, y) => x.time - y.time).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, value: c.close }));
      if (rows.length < 2) { cst.series?.setData([]); clear(chCh); chSrc.textContent = "Not enough trades for a chart yet."; return; }
      const first = rows[0].value, last = rows[rows.length - 1].value, ch = (last / first - 1) * 100;
      chPx.textContent = cst.sym === "ETH" ? usd(last) : troyaPx(last);
      clear(chCh, h("span", { class: ch >= 0 ? "up" : "down" }, `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`), ` · ${cst.tf === "1D" ? "24 hours" : cst.tf === "1W" ? "7 days" : "30 days"}`);
      chSrc.textContent = cst.sym === "ETH" ? "Hyperliquid" : (d.source || "GeckoTerminal");
      if (!cst.chart) {
        const LW = await import("lightweight-charts");
        // two loads can overlap at mount: only the newest one draws, and only one chart is ever made
        if (!alive || my !== cst.seq) return;
        if (!cst.chart) {
          const light = document.documentElement.dataset.theme === "light";
          cst.chart = LW.createChart(chBox, { autoSize: true, layout: { background: { type: "solid", color: "transparent" }, textColor: light ? "#6e685f" : "#6f7c89", fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11 },
            grid: { vertLines: { color: light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.035)" }, horzLines: { color: light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.035)" } },
            rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true }, handleScroll: false, handleScale: false,
            crosshair: { vertLine: { color: "rgba(142,223,245,.4)", labelBackgroundColor: "#0f1820" }, horzLine: { color: "rgba(142,223,245,.4)", labelBackgroundColor: "#0f1820" } } });
          cst.series = cst.chart.addCandlestickSeries({ ...{ upColor: "#8edff5", downColor: "#ff7d8a", borderVisible: false, wickUpColor: "#8edff5", wickDownColor: "#ff7d8a" }, ...(light ? { upColor: "#0a7ea3", wickUpColor: "#0a7ea3", downColor: "#c8303f", wickDownColor: "#c8303f" } : {}) });
        }
      }
      cst.series.applyOptions({ priceFormat: cst.sym === "ETH" ? { type: "price", precision: 2, minMove: 0.01 } : { type: "price", precision: 10, minMove: 1e-10 } });
      cst.series.setData(rows.map(({ value, ...c }) => c));
      cst.chart.timeScale().fitContent();
    } catch (e) { if (my === cst.seq) chSrc.textContent = `Chart unavailable (${e.message}).`; }
  }
  paintChartHead();
  stops.push(() => { try { cst.chart?.remove(); } catch {} });

  /* ---------- layout: first visit or returning, connected or not, ordered by the intent ---------- */
  // The lead section moves to just under the top; the rest keep their places. An element can sit in one place only, so
  // whatever leads is left out of the columns below.
  const LEAD = { check: gate.el, perps: hlTable, launch: quick };
  const live = h("div", { class: "dk-live" }, coins, sentry);
  const passStrip = h("div"); stops.push(mountPassStrip(passStrip));
  const gradLane = h("div"); stops.push(mountGraduated(gradLane));
  const root = h("div", { class: "dk" });
  let wasHero = null;
  function layout() {
    const showHero = first && !wallet.address;
    const lead = LEAD[intent] || null;
    const parts = showHero ? [intentBar, hero] : [strip];
    if (wallet.address) parts.push(you);
    if (lead) parts.push(lead);
    if (intent === "launch") parts.push(passStrip, live, gradLane); else parts.push(passStrip, live, gradLane, quick);
    parts.push(setup.el,
      h("div", { class: "dk-cols" },
        h("div", { class: "dk-col" }, chart, lead === gate.el ? null : gate.el, brief, lead === hlTable ? null : hlTable),
        h("div", { class: "dk-col" }, agent, sigs, shortcuts)));
    clear(root, parts);
    if (showHero && wasHero !== true) heroNumbers();
    wasHero = showHero;
  }
  layout();
  clear(view, root);
  let lastAddr = wallet.address || null, lastSession = !!wallet.session;
  stops.push(onWallet(() => {
    const a = wallet.address || null, s = !!wallet.session;
    if (a === lastAddr && s === lastSession) return;
    const relayout = !!a !== !!lastAddr;
    lastAddr = a; lastSession = s;
    if (relayout) layout();
    renderAgent();
    loadYou();
  }));
  renderAgent();

  /* ---------- data ---------- */
  setTimeout(() => { if (alive) loadChart(); }, 60);
  stops.push(every(120000, () => loadChart()));
  stops.push(every(60000, () => heroNumbers()));
  stops.push(every(10000, async () => {
    if (!heroOn()) return;
    try { const p = await api.get("price/eth"); kEth.textContent = usd(p.usd); } catch { kEthS.textContent = "price unavailable"; }
  }));
  stops.push(every(30000, async () => {
    try {
      // the server ranks and trims the movers ($1M+ volume, biggest 24 h move): a couple of KB instead of every market
      const movers = (await cached("market/hl?top=7&sort=change", 8000)).markets || [];
      try { sparks = (await cached(`market/hl/sparks?coins=${movers.map((m) => encodeURIComponent(m.coin)).join(",")}`, 120000)).sparks || {}; } catch {}
      if (alive) hlTbl.setRows(movers);
    } catch (e) { if (alive) tblMsg(hlTbl, `Hyperliquid data is unavailable: ${e.message}`); }
  }));
  stops.push(every(30000, () => loadCoins()));
  stops.push(every(60000, async () => {
    try {
      const b = await api.get("brief");
      briefTime.textContent = b.stale ? "last good copy" : "live";
      clear(briefBody, h("ul", { class: "brief-list" }, b.items.map((it) => h("li", {}, cleanPerpText(it.text)))),
        h("button", { class: "link", type: "button", onclick: () => ask("Walk me through today's brief: what stands out and what should I watch?") }, "Ask about the brief →"),
        b.stale ? h("p", { class: "note" }, "A source is slow right now, so this is the last good copy.") : null);
    } catch (e) { clear(briefBody, h("p", { class: "muted" }, `The brief could not be built right now (${e.message}).`)); }
  }));
  let showAll = false;
  let lastSignals = [];
  const renderSignals = () => {
    const list = showAll ? lastSignals : lastSignals.slice(0, 5);
    if (!lastSignals.length) { clear(sigBody, h("p", { class: "muted" }, "Nothing crosses the thresholds right now.")); return; }
    clear(sigBody, list.map((s) => h("div", { class: `sig ${s.kind}` },
      h("span", { class: "sig-k" }, { funding: "Funding", move: "Move", volume: "Volume", new: "New" }[s.kind] || s.kind),
      h("div", { class: "sig-t" }, h("b", { class: "tok-link" }, s.coin ? coinIcon(s.coin, "sm") : s.address ? tokenIcon({ symbol: s.symbol || (([, d, c]) => d || c)(String(s.title || "").match(/\$([A-Za-z0-9]{2,12})|:\s*([A-Za-z0-9]{2,12})\s*$/) || []), address: s.address, image: s.image }, "sm") : null, h("span", { class: "sig-tt", title: s.title || "" }, String(s.title || "").replace(/\b[a-z0-9]+:(?=[A-Z])/g, ""))), h("span", {}, s.detail)),
      h("div", { class: "sig-a" },
        h("button", { class: "link", type: "button", onclick: () => watch(s) }, "Watch"),
        h("button", { class: "link", type: "button", onclick: () => ask(`${s.title}. ${s.detail} What does this mean and is there a trade here inside my limits?`) }, "Ask"),
        h("button", { class: "link", type: "button", onclick: () => go(s.coin ? `#/perps/${encodeURIComponent(s.coin)}` : `#/token/${s.address}`) }, "Open")))),
      lastSignals.length > 5 ? h("button", { class: "link fine", type: "button", onclick: () => { showAll = !showAll; renderSignals(); } }, showAll ? "Show fewer" : `${lastSignals.length - 5} more`) : null);
  };
  stops.push(every(45000, async () => {
    try {
      const d = await api.get("signals");
      lastSignals = d.signals || [];
      renderSignals();
    } catch (e) { clear(sigBody, h("p", { class: "muted" }, `Signals are unavailable right now (${e.message}).`)); }
  }));
  stops.push(every(60000, async () => {
    try {
      const d = await api.get("sentry/recent?limit=6");
      const items = d.items || [];
      if (!items.length) {
        clear(senBody, h("div", { class: "dk-empty" }, h("b", {}, d.live ? "Nothing checked in the last while." : "Sentry is not watching on this server."), h("p", {}, "Every result the channel sees is listed here as it comes in. "), h("a", { class: "btn sm", href: d.channel || "https://t.me/troyasentry", target: "_blank", rel: "noopener" }, "Open t.me/troyasentry")));
        return;
      }
      clear(senBody, h("ul", { class: "dk-sen" }, items.map((it) => {
        const p = senPill(it);
        const who = it.symbol ? `$${it.symbol}` : it.name || short(it.token);
        const meta = [it.name && it.name.toUpperCase() !== String(it.symbol || "").toUpperCase() ? it.name : null, it.source || "Pons", p.note].filter(Boolean).join(" · ");
        return h("li", {},
          tokenIcon({ symbol: it.symbol, address: it.token }, "sm"),
          h("a", { class: "dk-sen-t", href: `#/gate/${it.token}`, title: it.reason || "" }, h("b", {}, who), h("span", {}, meta)),
          h("span", { class: `dk-v ${p.cls}`, title: it.reason || "" }, p.word),
          h("span", { class: "fine dk-sen-at" }, ago(it.at)),
          h("span", { class: "dk-sen-a" },
            h("a", { class: "link", href: `#/gate/${it.token}` }, "Gate"),
            h("a", { class: "link", href: `#/token/${it.token}` }, "Open"),
            it.post ? h("a", { class: "link", href: it.post, target: "_blank", rel: "noopener" }, "Post") : null));
      })));
    } catch (e) { clear(senBody, h("p", { class: "muted" }, `Sentry results are unavailable right now (${e.message}).`)); }
  }));

  async function watch(s) {
    if (!wallet.session) { toast("Sign in from the Agent page to set up watches.", ""); go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}`); return; }
    go(`#/agent/playbooks?watch=${encodeURIComponent(s.coin || s.address)}&kind=${s.kind}`);
  }

  return () => stops.forEach((f) => { try { f(); } catch {} });
}

// a table from ui.js that could not load: one muted line in place of its rows (its empty text would say "nothing moved")
function tblMsg(tbl, text) {
  const body = tbl.querySelector("tbody"), n = tbl.querySelectorAll("thead th").length || 1;
  if (body) body.replaceChildren(h("tr", {}, h("td", { colspan: n, class: "l muted" }, text)));
}

// Sentry's pill. Green only for a pass that met the channel's bar (eligible: at least 0.5 ETH in from 25 independent
// buyers); a pass without that is neutral, never green. An older server without the flag: green only when it was posted.
export function senPill(it) {
  const buyers = it.buyers != null ? (it.buyers === 0 ? "no buyers yet" : `${it.buyers} buyer${it.buyers === 1 ? "" : "s"}`) : null;
  if (it.stock) return { word: "Stock", cls: "v-quiet", note: "tokenized stock, not a launch" };
  if (it.verdict === "passed") {
    const ok = typeof it.eligible === "boolean" ? it.eligible : !!it.posted;
    return ok ? { word: "Passed", cls: "v-passed", note: buyers } : { word: "Checks passed", cls: "v-quiet", note: `no real buying yet${it.buyers ? ` (${buyers})` : ""}` };
  }
  if (it.verdict === "caution") return { word: "Caution", cls: "v-caution", note: buyers };
  if (it.verdict === "failed") return { word: "Failed", cls: "v-failed", note: null };
  return { word: "Checked", cls: "v-quiet", note: buyers };
}
