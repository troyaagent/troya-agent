// Portfolio: balances on Robinhood Chain and Hyperliquid, the Get started checklist, positions, inbox, history, weekly review.
import { h, clear, icon, pageHead, tabs, table, toast, num, usd, pct, short, useCss, every, store, ago, chainLogo, coinIcon, tokenIcon, tiny } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, reader, signIn } from "../wallet.js";
import { getStarted } from "./start.js";

const hideSetup = store("troya.portfolio.hideSetup", false);
const fmtPx = (p) => (p == null || !isFinite(p) ? "–" : num(p, p >= 1000 ? 1 : p >= 1 ? 4 : 6));
const asList = (r, ...keys) => { for (const k of keys) if (Array.isArray(r?.[k])) return r[k]; return Array.isArray(r) ? r : []; };
const tsOf = (x) => x.ts ?? x.time ?? x.createdAt ?? x.at ?? x.created_at ?? null;
const toMs = (t) => (t == null ? null : typeof t === "string" ? Date.parse(t) : t < 1e12 ? t * 1000 : t);
// Inbox and History before a wallet is in: two plain lines on what lands there and one greyed row marked Example (an
// illustration labelled as one, with no numbers in it), then the one button that opens it up
function guestBox(lines, ex, act, cls = "panel pf-connect") {
  return h("div", { class: cls },
    lines.map((t) => h("p", { style: { margin: 0, maxWidth: "36em", textAlign: "center", lineHeight: "1.5" } }, t)),
    h("div", { class: "pf-msg", role: "img", "aria-label": `Example: ${ex.title}`, style: { width: "min(100%, 520px)", opacity: ".55", border: "1px dashed var(--line-3)", borderRadius: "10px", textAlign: "left", pointerEvents: "none" } },
      h("i", { class: "u" }),
      h("div", {}, h("b", {}, h("span", { class: "pf-kind" }, ex.kind), ex.title), h("p", {}, ex.text)),
      h("span", { class: "pf-kind", style: { margin: 0 } }, "Example")),
    act);
}
const INBOX_LINES = ["Alerts from your playbooks land here when a trigger you set fires, so you do not have to watch the chart.", "So do the tickets your agent prepares for you. Each one waits for your signature, and nothing moves before it."];
const INBOX_EX = { kind: "playbook", title: "A coin you watch crossed the trigger you set", text: "A real alert names the coin, the move and the rule that fired, with a button to act on it." };
const JOURNAL_EX = { kind: "swap", title: "A swap you signed on the Swap page", text: "Each entry says when it happened, what it was and why, and whether it came from the app, the agent or a playbook." };

export async function mount(view, ctx) {
  useCss("portfolio");
  let alive = true;
  const stops = [];
  let tab = ["inbox", "history", "owl"].includes(ctx.parts[0]) ? ctx.parts[0] : "overview";
  const st = { rh: null, toks: null, hl: null, eth: null, errors: {}, brief: null, briefSum: null };
  // the same checklist as the Desk and #/start, made once so a balance refresh re-draws the page without re-reading it
  const setup = getStarted({ layout: "card", hide: hideSetup });
  setup.el.style.margin = "16px 0 18px";                    // on the card itself, so a hidden card leaves no gap
  stops.push(setup.stop);

  const body = h("div", {});
  const tabsEl = tabs([{ value: "overview", label: "Overview" }, { value: "inbox", label: "Inbox" }, { value: "history", label: "History" }, { value: "owl", label: "Weekly review" }], tab, (v) => {
    tab = v;
    history.replaceState(null, "", `#/portfolio${v === "overview" ? "" : "/" + v}`);
    render();
  });
  clear(view, h("div", { class: "pf2-tabs" }, tabsEl), body);

  /* ---------- data ---------- */
  async function loadBalances() {
    if (!wallet.address) return;
    const addr = wallet.address;
    const ethers = await import("ethers");
    const one = async (key, chain) => {
      try { st[key] = Number(ethers.formatEther(await reader(chain).getBalance(addr))); delete st.errors[key]; }
      catch { st[key] = null; st.errors[key] = true; }
    };
    // draw as each source answers (at most every 400 ms), so one slow source never holds the page back
    let queued = false;
    const soon = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; if (alive && addr === wallet.address && tab === "overview") render(); }, 400); };
    const step = (p) => p.finally(soon);
    await Promise.all([
      step(one("rh", "robinhood")),
      step(api.get(`/api/portfolio/tokens?address=${addr}`).then((b) => { st.toks = b.tokens || []; st.tokUsd = b.totalUsd || 0; })
        .catch(() => api.get(`chain/balances?address=${addr}`).then((b) => { st.toks = (b.balances || []).filter((x) => x.address !== "native" && Number(x.amount) > 0); st.tokUsd = 0; }).catch(() => { st.toks = null; }))),
      step(api.get("price/eth").then((p) => { st.eth = Number(p?.usd) || st.eth; }).catch(() => {})),
      step(api.get(`hl/user?address=${addr}`).then((u) => { st.hl = u; delete st.errors.hl; }).catch(() => { st.hl = null; st.errors.hl = true; })),
    ]);
    if (alive && addr === wallet.address && tab === "overview") render();
  }
  async function loadBrief() {
    if (!wallet.session) { st.brief = null; return; }
    try { st.brief = await api.get("brief/me"); st.briefErr = null; } catch (e) { st.brief = null; st.briefErr = e.message || "unavailable"; }
    if (alive && tab === "overview") render();
  }
  // Phase 6: the same brief Telegram gets every day, with the same settings
  function briefPanel() {
    const b = st.brief;
    if (!b) return h("div", { class: "panel pf-brief" }, h("h3", {}, "Today's brief"), st.briefErr
      ? h("p", { class: "muted" }, `Could not load it right now (${st.briefErr}). `, h("button", { class: "link", type: "button", onclick: () => { st.briefErr = null; render(); loadBrief(); } }, "Try again"))
      : h("p", { class: "muted" }, "Reading your desk, the market and Sentry…"));
    const d = b.brief, p = b.prefs;
    const fx = (v) => (v == null || !isFinite(v) ? "–" : v >= 1000 ? num(v, 0) : v >= 1 ? num(v, 3) : Number(v).toPrecision(4));
    const ch = (v) => (v == null ? "" : ` (${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%)`);
    const rows = [];
    for (const x of d.positions || []) rows.push(h("div", {}, h("span", {}, `${x.coin} ${x.side} ${x.size}`), h("span", {}, `PnL ${usd(x.pnl)}${x.liqAway != null ? ` · liq ${x.liqAway.toFixed(0)}% away` : ""}${x.fundingAgainst > 0 ? ` · funding ${x.fundingAgainst.toFixed(0)}%/yr against` : ""}`)));
    if (d.guards?.[0]?.away != null) rows.push(h("div", {}, h("span", {}, "Nearest stop"), h("span", {}, `${d.guards[0].coin} ${fx(d.guards[0].trigger)} · ${d.guards[0].away.toFixed(1)}% away`)));
    const m = d.market || {};
    rows.push(h("div", {}, h("span", {}, "Market"), h("span", {}, [m.ETH && `ETH ${fx(m.ETH.px)}${ch(m.ETH.ch)}`, m.BTC && `BTC ${fx(m.BTC.px)}${ch(m.BTC.ch)}`, m.TROYA && `$TROYA${ch(m.TROYA.ch)}`].filter(Boolean).join(" · ") || "–")));
    if (d.sentry?.day) rows.push(h("div", {}, h("span", {}, "Sentry, 24h"), h("span", {}, `${d.sentry.day.seen} launches · ${d.sentry.day.passed} passed · ${d.sentry.day.failed} failed`)));
    const sumBox = h("p", { class: "pf-brief-sum" }, st.briefSum || "");
    const write = h("button", { class: "btn sm", type: "button", onclick: async () => {
      write.disabled = true; write.textContent = "Writing…";
      try { const r = await api.post("brief/summary", {}); st.briefSum = r.summary || "The AI summary is unavailable right now; the numbers below are live."; sumBox.textContent = st.briefSum; }
      catch (e) { toast(e.message, "error"); }
      write.disabled = false; write.textContent = "AI summary";
    } }, icon("spark"), "AI summary");
    const save = async (patch) => { try { const r = await api.post("brief/settings", patch); st.brief.prefs = { ...st.brief.prefs, ...r.prefs }; toast("Saved", "ok"); render(); } catch (e) { toast(e.message, "error"); } };
    const hourSel = h("select", { class: "pf-hour", "aria-label": "Brief hour (UTC)", onchange: (e) => save({ hour: Number(e.target.value) }) }, Array.from({ length: 24 }, (_, i) => h("option", { value: i, selected: i === p.hour }, `${String(i).padStart(2, "0")}:00 UTC`)));
    const sendBtn = b.telegramLinked
      ? h("button", { class: "btn sm", type: "button", onclick: async () => { try { const r = await api.post("brief/send", {}); toast(r.ok ? "Sent to your Telegram" : r.reason || "Could not send", r.ok ? "ok" : "error"); } catch (e) { toast(e.message, "error"); } } }, icon("arrowRight"), "Send to Telegram")
      : h("a", { class: "btn sm", href: "#/settings" }, "Link Telegram for the daily brief");
    return h("div", { class: "panel pf-brief" },
      h("div", { class: "pf-brief-h" }, h("h3", {}, "Today's brief"), h("div", { class: "row" }, write, sendBtn)),
      sumBox,
      (b.alerts || []).length ? h("div", { class: "pf-alerts" }, b.alerts.map((a) => h("div", { class: "alert warn" }, a))) : null,
      h("div", { class: "rows" }, rows),
      h("div", { class: "pf-brief-set" },
        h("label", { class: "row" }, h("input", { type: "checkbox", checked: p.on, onchange: (e) => save({ on: e.target.checked }) }), "Daily brief on Telegram"), hourSel,
        h("label", { class: "row" }, h("input", { type: "checkbox", checked: p.alerts, onchange: (e) => save({ alerts: e.target.checked }) }), "Smart alerts (liquidation, stops, funding)")));
  }

  /* ---------- overview ---------- */
  function tile(k, v, s, tip) {
    const logo = { "Robinhood Chain": "robinhood", Tokens: "robinhood", Hyperliquid: "hyperliquid" }[k];
    return h("div", { class: "stat" }, h("div", { class: "k" }, logo ? chainLogo(logo, 14) : null, k, tip ? h("i", { class: "info", title: tip, tabindex: "0" }, "i") : null), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
  }
  // token PnL, fetched one at a time (it reads each trade from the chain) and kept per wallet for this visit
  const pnlCache = new Map();
  const tokPnlChip = h("span", { class: "pf2-chip", hidden: true });
  function paintPnlChip() {
    const vals = [...pnlCache.values()].filter((p) => p?.status === "ok" && p.pnlUsd != null && p.addr === wallet.address);
    if (!vals.length) { tokPnlChip.hidden = true; return; }
    const sum = vals.reduce((s, p) => s + p.pnlUsd, 0);
    tokPnlChip.hidden = false;
    tokPnlChip.className = `pf2-chip ${sum > 0 ? "up" : sum < 0 ? "down" : ""}`;
    tokPnlChip.textContent = `Token PnL ${sum > 0 ? "+" : ""}${usd(sum)}`;
  }
  function paintPnl(box, p, x) {
    if (!p || p.status !== "ok") { clear(box, p?.status === "none" && p.transfersIn ? h("span", { class: "muted" }, "Received by transfer") : null); return; }
    const buys = `${p.buys} buy${p.buys === 1 ? "" : "s"}${p.sells ? ` · ${p.sells} sell${p.sells === 1 ? "" : "s"}` : ""}`;
    // bought, but nothing prices the coin yet: what it cost, and the PnL once it has a price
    if (p.pnlEth == null) {
      clear(box, h("span", { class: "muted" }, `Cost ${num(p.costEth, 4)} ETH${p.ethUsd ? ` · ${usd(p.costEth * p.ethUsd)}` : ""} · PnL once it has a price`),
        h("small", { class: "muted" }, `${buys}${p.avgEntryUsd != null ? ` · avg entry $${tiny(p.avgEntryUsd)}` : ""}`));
      return;
    }
    const up = (p.pnlEth || 0) >= 0, sign = up ? "+" : "−";
    clear(box,
      h("span", { class: up ? "up" : "down" }, `PnL ${sign}${num(Math.abs(p.pnlEth), 4)} ETH`, p.pnlUsd != null ? ` · ${sign}${usd(Math.abs(p.pnlUsd))}` : "", p.pnlPct != null ? ` · ${sign}${Math.abs(p.pnlPct).toFixed(1)}%` : ""),
      h("small", { class: "muted" }, `${buys}${p.avgEntryUsd != null ? ` · avg entry $${tiny(p.avgEntryUsd)}` : ""}`),
      // the card re-reads these numbers from the chain itself and prints the last trade's tx, so it cannot be typed in
      p.pnlEth != null && x?.address ? h("button", { class: "link pf2-share", type: "button", style: { justifySelf: "start", fontSize: "12px" }, onclick: (e) => {
        e.preventDefault(); e.stopPropagation();       // the row is a link to the coin page
        sharePnl(() => import("../sharecard.js").then((s) => s.chainPnlSpec({ wallet: p.addr || wallet.address, token: x.address, symbol: x.symbol })), `Share PnL · $${x.symbol}`);
      } }, "Share PnL") : null);
  }
  // the share dialog is loaded on first use (it brings the card drawer and the QR code)
  function sharePnl(make, title) {
    import("../sharecard.js").then((s) => s.openPnlShare({ title, make })).catch((e) => toast(e.message, "error"));
  }
  async function fillPnl(slots) {
    const addr = wallet.address;
    // past the first 12 (each PnL reads the trades from the chain), one click reads it
    for (const [x, box] of slots.slice(12)) clear(box, h("button", { class: "link", type: "button", style: { justifySelf: "start", fontSize: "12px" }, onclick: (e) => {
      e.preventDefault(); e.stopPropagation();       // the row is a link to the coin page
      clear(box, h("span", { class: "muted" }, "PnL …"));
      fillPnl([[x, box]]);
    } }, "Show PnL"));
    for (const [x, box] of slots.slice(0, 12)) {
      if (/^(USDG|WETH)$/.test(x.symbol)) continue;
      const key = `${addr}:${x.address}`;
      if (!pnlCache.has(key)) {
        const p = await api.get(`/api/portfolio/pnl?address=${addr}&token=${x.address}`).catch(() => null);
        pnlCache.set(key, p ? { ...p, addr } : null);
      }
      if (!alive || addr !== wallet.address) return;
      paintPnl(box, pnlCache.get(key), x);
      paintPnlChip();
    }
  }
  function overview() {
    const connected = !!wallet.address;
    const ethUsd = (n) => (n != null && st.eth ? usd(n * st.eth) : "");
    const tiles = h("div", { class: "pf-tiles" },
      tile("Robinhood Chain", connected ? (st.errors.rh ? "–" : st.rh == null ? "…" : `${num(st.rh, 5)} ETH`) : "–", connected ? (st.errors.rh ? "Robinhood Chain RPC unavailable" : ethUsd(st.rh)) : "Not connected", "Native ETH on Robinhood Chain (chain 4663), used for gas and swaps."),
      tile("Tokens", connected ? (st.toks == null ? "…" : st.toks.length ? st.toks.slice(0, 2).map((x) => `${num(Number(x.amount), 4)} ${x.symbol}`).join(" · ") : "None") : "–", connected && st.toks?.length > 2 ? `+${st.toks.length - 2} more` : connected ? "WETH, USDG and tracked tokens" : "Not connected", "WETH, USDG and tokens Troya tracks for this wallet on Robinhood Chain."),
      tile("Hyperliquid", connected ? (st.errors.hl ? "–" : st.hl ? usd(st.hl.accountValue) : "…") : "–", connected && st.hl ? `Withdrawable ${usd(st.hl.withdrawable)}` : connected ? "" : "Not connected", "Perp account value in USDC."),
      tile("Open PnL", connected && st.hl ? h("span", { class: st.hl.unrealizedPnl > 0 ? "up" : st.hl.unrealizedPnl < 0 ? "down" : "" }, `${st.hl.unrealizedPnl > 0 ? "+" : ""}${usd(st.hl.unrealizedPnl)}`) : "–", connected && st.hl ? `${st.hl.positions.length} open position${st.hl.positions.length === 1 ? "" : "s"}` : "", "Unrealised PnL across Hyperliquid perps."));

    void tiles;
    // Desk 2.0: one hero with the total, the split and the open PnL, then every token as a card
    const rhUsd = st.rh != null && st.eth ? st.rh * st.eth : 0, hlUsd = st.hl?.accountValue || 0, tokUsd = st.tokUsd || 0, total = rhUsd + hlUsd + tokUsd;
    const C = 2 * Math.PI * 46, slices = [["Robinhood Chain", rhUsd, "#bff0fd"], ["Tokens", tokUsd, "#5fc3e0"], ["Hyperliquid", hlUsd, "#3c8fa8"]].filter((x) => x[1] > 0);
    let off = 0;
    const donut = h("span", { class: "pf2-donut" });
    donut.innerHTML = `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" class="bg"/>${slices.map(([, v, c]) => { const len = total ? (v / total) * C : 0; const el = `<circle cx="60" cy="60" r="46" stroke="${c}" style="stroke-dasharray:${len} ${C};stroke-dashoffset:${-off}"/>`; off += len; return el; }).join("")}</svg>`;
    donut.append(connected ? h("span", { class: "pf2-donut-c" }, h("b", {}, String(slices.length || 0)), h("small", {}, slices.length === 1 ? "account" : "accounts"))
      : h("span", { class: "pf2-donut-c off" }, h("b", {}, "No wallet")));
    const pnl = st.hl?.unrealizedPnl;
    const hero = h("section", { class: "pf2-hero" },
      h("div", { class: "pf2-txt" },
        h("p", { class: "d2-mic" }, h("i", { class: "live-dot" }), connected ? `Portfolio · ${short(wallet.address)}` : "Portfolio"),
        h("div", { class: "pf2-total" }, connected ? (st.rh == null && !st.hl ? "…" : usd(total)) : "Connect a wallet"),
        h("p", { class: "pf2-sub" }, connected ? "ETH and every token on Robinhood Chain, plus your Hyperliquid account. Each token's PnL is read from your own trades on chain." : "Your balances on Robinhood Chain and Hyperliquid, your open positions and your alerts, in one place."),
        h("div", { class: "pf2-chips" },
          tokPnlChip,
          connected && pnl != null && (pnl !== 0 || st.hl?.positions?.length) ? h("span", { class: `pf2-chip ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}` }, `Perps PnL ${pnl > 0 ? "+" : ""}${usd(pnl)}`) : null,
          connected && st.hl ? h("span", { class: "pf2-chip" }, `${st.hl.positions.length} open position${st.hl.positions.length === 1 ? "" : "s"}`) : null,
          connected && st.toks ? h("span", { class: "pf2-chip" }, `${st.toks.length} token${st.toks.length === 1 ? "" : "s"}`) : null),
        h("div", { class: "d2-acts" },
          connected ? h("a", { class: "btn primary d2-big", href: "#/swap" }, icon("swap"), "Swap") : h("button", { class: "btn primary d2-big", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"),
          h("a", { class: "btn d2-big", href: "#/bridge" }, "Bridge"), h("a", { class: "btn d2-big", href: "#/bridge?dir=hl" }, "Fund Hyperliquid"))),
      h("div", { class: "pf2-split" }, donut,
        !connected ? h("ul", { class: "pf2-legend off" }, h("li", {}, h("span", {}, "Connect a wallet to see where your funds sit: Robinhood Chain, its tokens and Hyperliquid."))) : h("ul", { class: "pf2-legend" },
          h("li", {}, h("i", { style: { background: "#bff0fd" } }), h("span", {}, "Robinhood Chain"), h("b", {}, connected ? (st.rh == null ? "…" : `${num(st.rh, 5)} ETH`) : "–"), h("small", {}, connected && st.eth && st.rh != null ? usd(rhUsd) : "")),
          h("li", {}, h("i", { style: { background: "#5fc3e0" } }), h("span", {}, "Tokens"), h("b", {}, connected ? (st.toks == null ? "…" : usd(tokUsd)) : "–"), h("small", {}, connected && st.toks ? `${st.toks.length} on Robinhood Chain` : "")),
          h("li", {}, h("i", { style: { background: "#3c8fa8" } }), h("span", {}, "Hyperliquid"), h("b", {}, connected ? (st.hl ? usd(hlUsd) : "…") : "–"), h("small", {}, connected && st.hl ? `withdrawable ${usd(st.hl.withdrawable)}` : "")))));
    // Up front: every token this wallet bought (priced or not: a coin still on its curve says "No price yet", it is never
    // hidden) and every token worth a cent or more. Folded: what only ever arrived from others (airdrops, plain transfers)
    // with no price or under a cent, and coins whose history is too old to tell. bought comes from the server: true, false
    // or null. Community report 21 Nov 2026: two of four bought coins sat in "14 more without a price".
    const all = st.toks || [];
    const front = all.filter((x) => x.bought === true || x.valueUsd >= 0.01 || (x.valueUsd == null && x.priceUsd === undefined));
    const received = all.filter((x) => !front.includes(x) && x.bought === false), older = all.filter((x) => !front.includes(x) && x.bought !== false);
    const card = (x, slots = pnlSlots) => {
      const wantPnl = !/^(USDG|WETH)$/.test(x.symbol) && (x.bought === true || x.valueUsd >= 0.5);
      const pnlBox = h("div", { class: "pf2-pnl" }, wantPnl ? h("span", { class: "muted" }, "PnL …") : null);
      if (wantPnl) slots.push([x, pnlBox]);
      return h("a", { class: "pf2-tok", href: x.address ? `#/token/${x.address}` : "#/market" },
        h("div", { class: "pf2-tok-top" },
          tokenIcon({ symbol: x.symbol, address: x.address, chain: "robinhood", image: x.image }),
          h("span", { class: "pf2-tok-id" }, h("b", {}, x.symbol), h("small", {}, `${num(Number(x.amount), Number(x.amount) >= 1000 ? 0 : 4)}${x.stock ? " · stock" : ""}${x.onCurve ? " · on curve" : ""}${x.spam ? " · flagged" : ""}`)),
          h("span", { class: "pf2-tok-v" }, h("b", {}, x.valueUsd != null ? usd(x.valueUsd) : "–"), x.change24h != null ? h("small", { class: x.change24h >= 0 ? "up" : "down" }, `${x.change24h >= 0 ? "+" : ""}${x.change24h.toFixed(1)}%`) : h("small", { class: "muted" }, x.priceUsd == null ? "No price yet" : ""))),
        pnlBox);
    };
    // 30 cards, then the rest on request: nothing is cut off
    const grid = (list) => {
      const g = h("div", { class: "pf2-grid" }, list.slice(0, 30).map((x) => card(x)));
      if (list.length > 30) {
        const more = h("button", { class: "btn sm", type: "button", style: { gridColumn: "1 / -1", justifySelf: "center" }, onclick: (e) => {
          e.preventDefault();
          const extra = [];
          more.replaceWith(...list.slice(30).map((x) => card(x, extra)));
          fillPnl(extra);
        } }, `Show all ${list.length}`);
        g.append(more);
      }
      return g;
    };
    const pnlSlots = [];
    const toks = connected && st.toks?.length ? h("section", { class: "pf2-toks" },
      h("div", { class: "pf2-sec-h" }, h("h2", {}, "Your tokens"), h("span", { class: "fine muted" }, `Robinhood Chain · ${usd(tokUsd)}`)),
      front.length ? grid(front) : null,
      received.length ? h("details", { class: "pf2-dust" }, h("summary", { class: "fine muted" }, `${received.length} token${received.length === 1 ? "" : "s"} you received but never bought (${received.every((x) => x.priceUsd == null) ? "no price" : "no price or under one cent"})`), grid(received)) : null,
      older.length ? h("details", { class: "pf2-dust" }, h("summary", { class: "fine muted" }, `${older.length} ${front.length || received.length ? "more " : ""}without a price or worth under one cent`), grid(older)) : null,
      h("p", { class: "fine muted pf2-pnl-note" }, "PnL is in ETH: what this wallet paid for the token against what it got back from sells plus what it holds now, at today's price. Gas is not counted, and tokens that arrived by plain transfer are not counted as bought.")) : null;
    fillPnl(pnlSlots);
    const gasCard = h("section", { class: "panel pf2-gas" });
    paintGas(gasCard);
    const parts = [hero, gasCard, toks];
    if (connected && wallet.session) parts.push(briefPanel());
    // the hero already offers Connect when no wallet is connected

    // Get started (then the optional Level up): every tick is read from the chain, the journal or the server, not guessed
    parts.push(setup.el);

    if (connected) {
      const pos = table({ emptyText: "No open Hyperliquid positions.", onRow: (p) => ctx.go(`#/perps/${p.coin}`), cols: [
        { key: "coin", label: "Market", align: "l", render: (p) => h("span", { class: "tok-link" }, coinIcon(p.coin, "sm"), `${p.coin}-PERP`) },
        { key: "side", label: "Side", render: (p) => h("span", { class: p.size > 0 ? "up" : "down" }, p.size > 0 ? "Long" : "Short", p.leverage ? ` ${p.leverage}x` : "") },
        { key: "size", label: "Size", render: (p) => num(Math.abs(p.size), 5) },
        { key: "val", label: "Value", render: (p) => usd(p.positionValue) },
        { key: "entry", label: "Entry", render: (p) => fmtPx(p.entryPx) },
        { key: "pnl", label: "PnL", render: (p) => h("span", { class: p.unrealizedPnl >= 0 ? "up" : "down" }, `${p.unrealizedPnl >= 0 ? "+" : ""}${usd(p.unrealizedPnl)} (${pct(p.returnOnEquity * 100)})`) },
        { key: "liq", label: "Liq. price", render: (p) => fmtPx(p.liquidationPx) },
      ] });
      if (st.hl) pos.setRows(st.hl.positions); else pos.setLoading(2);
      parts.push(h("section", { class: "panel pf-sec" }, h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid positions"), h("a", { class: "link", href: "#/perps", style: { fontSize: "12px" } }, "Open Perps")), h("div", { style: { padding: "0 6px 8px" } }, pos)));

      if (st.hl?.spot?.length) {
        const sp = table({ cols: [
          { key: "coin", label: "Asset", align: "l" },
          { key: "total", label: "Balance", render: (b) => num(b.total, 6) },
          { key: "hold", label: "In orders", render: (b) => num(b.hold, 6) },
        ] });
        sp.setRows(st.hl.spot);
        parts.push(h("section", { class: "panel pf-sec" }, h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid spot balances")), h("div", { style: { padding: "0 6px 8px" } }, sp)));
      }
    }
    return parts;
  }

  /* ---------- free gas: the weekly drip for holders, and the sponsor for admins ---------- */
  async function paintGas(box) {
    let g; try { g = await api.get("gas/status"); } catch { box.remove(); return; }
    const you = g.you;
    const claim = async (btn) => {
      btn.disabled = true; btn.textContent = "Sending…";
      try { const r = await api.post("gas/claim", {}); toast(`${r.eth} ETH sent for gas.`, "ok", 7000); window.open(r.explorer, "_blank", "noopener"); }
      catch (e) { toast(e.message, "error", 7000); }
      paintGas(box); loadBalances();
    };
    const btn = h("button", { class: "btn primary", type: "button", disabled: !you?.can, onclick: (e) => claim(e.currentTarget) }, wallet.session ? "Claim free gas" : "Sign in to claim");
    if (!wallet.session) { btn.disabled = false; btn.onclick = async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); paintGas(box); } catch (e) { toast(e.message, "error"); } }; }
    clear(box,
      h("div", { class: "pf2-gas-h" }, h("h2", {}, "Troya pays your gas"), h("span", { class: `dk-v ${g.enabled ? "v-passed" : ""}` }, g.enabled ? "On" : "Off")),
      h("p", { class: "fine", style: { margin: 0 } }, `Holders of 1,000,000 $TROYA or more claim ${g.dripEth} ETH on Robinhood Chain once every ${g.everyDays} days, enough for dozens of trades.${g.refund ? ` Agent Wallet trades also get their gas back, up to ${g.refundPerDayEth} ETH a day.` : ""}`),
      h("p", { class: "fine muted", style: { margin: 0 } }, g.wallets),
      you ? h("p", { class: `fine ${you.can ? "" : "muted"}`, style: { margin: 0 } }, you.can ? `You can claim now · you hold ${Math.round(you.balance || 0).toLocaleString("en-US")} $TROYA` : you.why) : null,
      h("div", { class: "fw-row" }, btn));
    // admins: the sponsor wallet, its balance and limits
    let a; try { a = wallet.session ? await api.get("gas/admin") : null; } catch { a = null; }
    if (!a) return;
    const s = a.settings;
    const num = (k, v, label, step) => { const el = h("input", { class: "input", type: "number", step, value: v }); el.dataset.k = k; return h("label", { class: "field" }, h("span", {}, label), el); };
    const form = h("div", { class: "fw-auto-g" }, num("dripEth", s.dripEth, "Drip (ETH)", "0.00001"), num("everyDays", s.everyDays, "Every (days)", "1"), num("refundPerDayEth", s.refundPerDayEth, "Agent refund per wallet/day (ETH)", "0.0001"), num("dailyBudgetEth", s.dailyBudgetEth, "Total budget per day (ETH)", "0.001"), num("skipAboveEth", s.skipAboveEth, "Skip wallets holding over (ETH)", "0.0001"));
    const save = async (extra = {}) => { const body = { ...extra }; for (const el of form.querySelectorAll("input")) body[el.dataset.k] = Number(el.value); try { await api.post("gas/admin/settings", body); toast("Saved", "ok"); paintGas(box); } catch (e) { toast(e.message, "error"); } };
    box.append(h("div", { class: "pf2-gas-admin" },
      h("b", {}, "Sponsor wallet (admin)"),
      h("div", { class: "fw-row" }, h("span", { class: "mono", style: { wordBreak: "break-all" } }, a.address), h("button", { class: "btn sm", type: "button", onclick: () => { navigator.clipboard?.writeText(a.address); toast("Address copied", "ok"); } }, "Copy")),
      h("p", { class: "fine", style: { margin: 0 } }, `Balance ${a.balanceEth.toFixed(5)} ETH · spent today ${a.todaySpentEth.toFixed(5)} of ${s.dailyBudgetEth} ETH · send ETH on Robinhood Chain to this address to fund it.`),
      form,
      h("div", { class: "fw-row" }, h("button", { class: "btn", type: "button", onclick: () => save() }, "Save limits"), h("button", { class: "btn", type: "button", onclick: () => save({ enabled: !s.enabled }) }, s.enabled ? "Switch off" : "Switch on"), h("button", { class: "btn", type: "button", onclick: () => save({ refund: !s.refund }) }, s.refund ? "Stop Agent refunds" : "Start Agent refunds"),
        h("button", { class: "btn danger", type: "button", onclick: async () => { if (!confirm("Send the rest of the sponsor wallet back to the creator wallet?")) return; try { const r = await api.post("gas/admin/withdraw", {}); toast(`${r.eth.toFixed(5)} ETH sent to the creator wallet.`, "ok", 7000); paintGas(box); } catch (e) { toast(e.message, "error"); } } }, "Withdraw to creator wallet")),
      a.log?.length ? h("ul", { class: "fw-auto-log" }, a.log.slice(0, 8).map((x) => h("li", {}, h("b", {}, new Date(x.at).toLocaleString()), ` · ${x.kind} · ${x.eth} ETH → ${short(x.to)} · `, h("a", { class: "ulink", href: `https://robinhoodchain.blockscout.com/tx/${x.hash}`, target: "_blank", rel: "noopener" }, "tx")))) : null));
  }

  /* ---------- inbox ---------- */
  async function inbox(box) {
    if (!wallet.address) { clear(box, guestBox(INBOX_LINES, INBOX_EX, h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"))); return; }
    clear(box, h("div", { class: "panel" }, h("div", { class: "empty" }, "Loading your inbox…")));
    let r;
    try { r = await api.get("inbox?limit=100"); }
    catch (e) {
      if (!alive || tab !== "inbox") return;
      if (e.status === 401 || e.status === 403) {
        clear(box, guestBox(INBOX_LINES, INBOX_EX,
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { await signIn(); render(); } catch (err) { toast(err.message, "error"); } } }, icon("key"), "Sign in to see your inbox")));
      } else clear(box, h("div", { class: "panel" }, h("div", { class: "empty" }, h("b", {}, "The inbox could not be loaded."), e.message)));
      return;
    }
    if (!alive || tab !== "inbox") return;
    const items = asList(r, "items", "messages", "inbox");
    const unread = items.filter((m) => !m.read && !m.readAt);
    const head = h("div", { class: "panel-h" }, h("h2", {}, "Inbox", unread.length ? h("span", { class: "badge-s blue" }, `${unread.length} new`) : null),
      unread.length ? h("button", { class: "btn sm", type: "button", onclick: async () => {
        try { await api.post("inbox/read", { all: true, ids: unread.map((m) => m.id).filter(Boolean) }); toast("Marked as read", "ok"); inbox(box); } catch (e) { toast(e.message, "error"); }
      } }, "Mark all read") : null);
    clear(box, h("section", { class: "panel" }, head,
      items.length ? h("div", { class: "pf-inbox" }, items.map((m) => {
        const t = toMs(tsOf(m));
        return h("div", { class: `pf-msg ${!m.read && !m.readAt ? "unread" : ""}` }, h("i", { class: "u" }),
          h("div", {}, h("b", {}, m.kind ? h("span", { class: "pf-kind" }, m.kind) : null, m.title || m.subject || m.summary || "Message"), (m.body || m.text || m.detail) ? h("p", {}, m.body || m.text || m.detail) : null,
            m.href || m.link ? h("a", { class: "link", href: m.href || m.link, style: { fontSize: "12px" } }, "Open") : null),
          h("time", { datetime: t ? new Date(t).toISOString() : "" }, t ? `${ago(t)} ago` : ""));
      })) : h("div", { class: "empty" }, h("b", {}, "Nothing here yet."), "Playbook alerts and agent proposals land here.")));
  }

  /* ---------- history ---------- */
  async function historyTab(box) {
    if (!wallet.address) {
      clear(box, guestBox(["Your journal lists every action Troya prepared or ran for this wallet, with the reason behind it.", "Your Hyperliquid fills sit beside it: the market, the direction, the price, the size, the closed PnL and the fee."],
        JOURNAL_EX, h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet")));
      return;
    }
    const jBox = h("section", { class: "panel pf-sec" }, h("div", { class: "panel-h" }, h("h2", {}, "Journal"), h("span", { class: "muted", style: { fontSize: "12px" } }, "Every action Troya prepared or ran, with the reason")), h("div", { class: "empty" }, "Loading…"));
    const fBox = h("section", { class: "panel pf-sec" }, h("div", { class: "panel-h" }, h("h2", {}, "Hyperliquid fills")), h("div", { class: "empty" }, "Loading…"));
    clear(box, jBox, fBox);

    // journal (needs sign-in)
    (async () => {
      let entries = null, err = null;
      try { entries = asList(await api.get("journal?limit=100"), "entries", "items", "journal"); } catch (e) { err = e; }
      if (!alive || tab !== "history") return;
      const slot = jBox.lastChild;
      if (err && (err.status === 401 || err.status === 403)) {
        slot.replaceWith(guestBox(["Sign in to read your journal: every action Troya prepared or ran for this wallet, with the reason behind it.", "Your Hyperliquid fills below are public and need no sign-in."],
          JOURNAL_EX, h("button", { class: "btn", type: "button", onclick: async () => { try { await signIn(); render(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), "Sign in"), "pf-connect"));
        return;
      }
      if (err) { slot.replaceWith(h("div", { class: "empty" }, h("b", {}, "The journal could not be loaded."), err.message)); return; }
      const t = table({ emptyText: "No journal entries yet.", cols: [
        { key: "time", label: "When", align: "l", render: (j) => { const ms = toMs(tsOf(j)); return ms ? new Date(ms).toLocaleString() : "–"; } },
        { key: "kind", label: "Kind", align: "l", render: (j) => h("span", { class: "pf-kind" }, j.kind || j.type || "action") },
        { key: "summary", label: "What happened", align: "l", render: (j) => h("span", { style: { whiteSpace: "normal" } }, j.summary || j.text || j.rationale || "–") },
        { key: "via", label: "Via", render: (j) => j.via || j.source || j.data?.via || "" },
      ] });
      t.setRows(entries);
      slot.replaceWith(h("div", { style: { padding: "0 6px 8px" } }, t));
    })();

    // fills (public data)
    (async () => {
      try {
        const u = st.hl && st.hl.address === wallet.address.toLowerCase() ? st.hl : await api.get(`hl/user?address=${wallet.address}`);
        st.hl = u;
        if (!alive || tab !== "history") return;
        const t = table({ emptyText: "No Hyperliquid fills yet.", cols: [
          { key: "time", label: "Time", align: "l", render: (f) => new Date(f.time).toLocaleString() },
          { key: "coin", label: "Market", render: (f) => (f.coin.startsWith("@") ? `spot ${f.coin}` : h("span", { class: "tok-link" }, coinIcon(f.coin, "sm"), f.coin)) },
          { key: "dir", label: "Direction", render: (f) => f.dir || f.side },
          { key: "px", label: "Price", render: (f) => fmtPx(f.px) },
          { key: "size", label: "Size", render: (f) => num(f.size, 6) },
          { key: "pnl", label: "Closed PnL", render: (f) => h("span", { class: f.closedPnl > 0 ? "up" : f.closedPnl < 0 ? "down" : "muted" }, usd(f.closedPnl)) },
          { key: "fee", label: "Fee", render: (f) => usd(f.fee) },
          // a fill that closed a position can be shared as a PnL card, read from these same public fills (all fills of
          // that order, same hash and market, add up to the trade)
          { key: "share", label: "", render: (f) => (f.closedPnl ? h("button", { class: "link", type: "button", style: { fontSize: "12px" }, onclick: (e) => {
            e.stopPropagation();
            const one = !f.hash || /^0x0*$/.test(f.hash);
            const fills = one ? [f] : u.fills.filter((g) => g.hash === f.hash && g.coin === f.coin);
            sharePnl(() => import("../sharecard.js").then((s) => s.hlPnlSpec({ wallet: u.address || wallet.address, fills })), `Share PnL · ${f.coin}`);
          } }, "Share PnL") : "") },
        ] });
        t.setRows(u.fills);
        fBox.lastChild.replaceWith(h("div", { style: { padding: "0 6px 8px" } }, t));
      } catch (e) { if (alive) fBox.lastChild.replaceWith(h("div", { class: "empty" }, h("b", {}, "Fills could not be loaded."), e.message)); }
    })();
  }

  /* ---------- V7 F35 Owl: your week, read from the chain, three plain lines of coaching (the tab says what it is:
     Weekly review, with Owl as its eyebrow) ---------- */
  async function owlTab(box) {
    const intro = h("div", { class: "panel", style: { padding: "18px 20px", marginBottom: "14px" } }, h("p", { class: "dk-eyebrow", style: { margin: "0 0 8px" } }, "Owl"), h("h2", { style: { margin: "0 0 6px" } }, "Weekly review"), h("p", { class: "muted", style: { margin: 0 } }, "Your last 7 days on Robinhood Chain: the coins you traded most, what each one really cost or made in ETH, and what Troya knew about it. Then three plain lines: keep, change, try."));
    if (!wallet.session) { clear(box, intro, h("div", { class: "empty" }, h("b", {}, "Sign in to read your week."), h("button", { class: "btn primary sm", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); } } }, wallet.address ? "Sign in" : "Connect wallet"))); return; }
    clear(box, intro, h("div", { class: "empty" }, h("b", {}, "Owl is reading your week…"), "Every trade is matched with what it cost and paid in ETH, so this takes a few seconds."));
    let v;
    try { v = await api.get("owl/me"); } catch (e) { if (alive && tab === "owl") clear(box, intro, h("div", { class: "empty" }, h("b", {}, "Owl could not read your week."), e.message)); return; }
    if (!alive || tab !== "owl") return;
    const eth = (x) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(4)} ETH`);
    const weekly = h("label", { class: "row", style: { gap: "8px", alignItems: "center" } }, h("input", { type: "checkbox", checked: v.weekly, onchange: async (e) => { try { await api.post("owl/me", { weekly: e.target.checked }); toast(e.target.checked ? "Owl will DM you every Monday" : "Weekly Owl off", "ok"); } catch (err) { toast(err.message, "error"); } } }), "Send me this card in Telegram every Monday");
    const line = (k, t) => (t ? h("p", { style: { margin: "6px 0" } }, h("b", {}, `${k}: `), t) : null);
    clear(box, intro,
      h("div", { class: "panel", style: { padding: "18px 20px", marginBottom: "14px" } },
        h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
          h("b", {}, `${v.coinsTraded} coin${v.coinsTraded === 1 ? "" : "s"} traded · ${v.wins}W / ${v.losses}L`),
          h("b", { class: v.pnlEth == null ? "" : v.pnlEth >= 0 ? "up" : "down" }, v.pnlEth == null ? "No priced trades" : `${eth(v.pnlEth)} on the ${v.read} read`)),
        line("Keep", v.coach.keep), line("Change", v.coach.change), line("Try", v.coach.try)),
      v.coins.length ? h("div", { class: "panel", style: { padding: "8px 12px", marginBottom: "14px" } },
        h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["Coin", "Trades", "Result", "Held", "Troya saw"].map((c) => h("th", {}, c)))), h("tbody", {}, v.coins.map((r) => h("tr", {}, [
          h("a", { class: "link", href: `#/gate/${r.token}` }, `$${r.symbol}`), String(r.trades),
          h("span", { class: r.pnlEth == null ? "muted" : r.pnlEth >= 0 ? "up" : "down" }, r.pnlEth == null ? "not priced" : `${eth(r.pnlEth)}${r.pnlPct != null ? ` (${r.pnlPct.toFixed(0)}%)` : ""}`),
          r.holding ? "still held" : r.heldMin != null ? `${r.heldMin} min` : "–",
          [r.ring === "red" ? "Ring Radar red" : r.ring === "amber" ? "Ring Radar amber" : "", r.aegisRed ? `${r.aegisRed} Aegis red` : ""].filter(Boolean).join(" · ") || "–"].map((c) => h("td", {}, c)))))))) : null,
      h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } }, weekly, v.receipt ? h("a", { class: "link", href: `/api/seal/r/${v.receipt}`, target: "_blank", rel: "noopener" }, "Sealed receipt") : null),
      h("p", { class: "muted", style: { fontSize: "12px" } }, `${v.note}${v.capped ? ` ${v.capped} more coins traded this week are not read.` : ""}`));
  }

  /* ---------- render ---------- */
  function render() {
    tabsEl.set(tab);
    if (tab === "overview") clear(body, overview());
    else if (tab === "inbox") inbox(body);
    else if (tab === "owl") owlTab(body);
    else historyTab(body);
  }

  render();
  stops.push(onWallet(async () => {
    st.ely = st.evm = st.hl = null;
    render();
    loadBalances();
    loadBrief();
  }));
  stops.push(every(15000, () => { if (wallet.address && tab === "overview") loadBalances(); }));
  return () => { alive = false; stops.forEach((f) => { try { f(); } catch {} }); };
}
