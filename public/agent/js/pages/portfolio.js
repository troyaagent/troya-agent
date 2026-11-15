// Portfolio: balances on Robinhood Chain and Hyperliquid, setup checklist, positions, inbox, history.
import { h, clear, icon, pageHead, tabs, table, toast, num, usd, pct, short, useCss, every, store, ago, chainLogo, coinIcon, tokenIcon } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, reader, signIn } from "../wallet.js";
import { tradingKeyStatus } from "../hl.js";

const hideSetup = store("troya.portfolio.hideSetup", false);
const fmtPx = (p) => (p == null || !isFinite(p) ? "–" : num(p, p >= 1000 ? 1 : p >= 1 ? 4 : 6));
const asList = (r, ...keys) => { for (const k of keys) if (Array.isArray(r?.[k])) return r[k]; return Array.isArray(r) ? r : []; };
const tsOf = (x) => x.ts ?? x.time ?? x.createdAt ?? x.at ?? x.created_at ?? null;
const toMs = (t) => (t == null ? null : typeof t === "string" ? Date.parse(t) : t < 1e12 ? t * 1000 : t);

export async function mount(view, ctx) {
  useCss("portfolio");
  let alive = true;
  const stops = [];
  let tab = ctx.parts[0] === "inbox" ? "inbox" : ctx.parts[0] === "history" ? "history" : "overview";
  const st = { rh: null, toks: null, hl: null, eth: null, key: null, journal: null, errors: {} };

  const body = h("div", {});
  const tabsEl = tabs([{ value: "overview", label: "Overview" }, { value: "inbox", label: "Inbox" }, { value: "history", label: "History" }], tab, (v) => {
    tab = v;
    history.replaceState(null, "", `#/portfolio${v === "overview" ? "" : "/" + v}`);
    render();
  });
  clear(view, pageHead("Portfolio", "Your balances, positions and alerts on Robinhood Chain and Hyperliquid."), tabsEl, body);

  /* ---------- data ---------- */
  async function loadBalances() {
    if (!wallet.address) return;
    const addr = wallet.address;
    const ethers = await import("ethers");
    const one = async (key, chain) => {
      try { st[key] = Number(ethers.formatEther(await reader(chain).getBalance(addr))); delete st.errors[key]; }
      catch { st[key] = null; st.errors[key] = true; }
    };
    await Promise.all([
      one("rh", "robinhood"),
      api.get(`chain/balances?address=${addr}`).then((b) => { st.toks = (b.balances || []).filter((x) => x.address !== "native" && Number(x.amount) > 0); }).catch(() => { st.toks = null; }),
      api.get("price/eth").then((p) => { st.eth = Number(p?.usd) || st.eth; }).catch(() => {}),
      api.get(`hl/user?address=${addr}`).then((u) => { st.hl = u; delete st.errors.hl; }).catch(() => { st.hl = null; st.errors.hl = true; }),
      tradingKeyStatus(addr).then((k) => { st.key = k; }).catch(() => {}),
    ]);
    if (alive && addr === wallet.address && tab === "overview") render();
  }
  async function loadJournal() {
    if (!wallet.session) { st.journal = null; return; }
    try { st.journal = asList(await api.get("journal?limit=100"), "entries", "items", "journal"); } catch { st.journal = null; }
  }

  /* ---------- overview ---------- */
  function tile(k, v, s, tip) {
    const logo = { "Robinhood Chain": "robinhood", Tokens: "robinhood", Hyperliquid: "hyperliquid" }[k];
    return h("div", { class: "stat" }, h("div", { class: "k" }, logo ? chainLogo(logo, 14) : null, k, tip ? h("i", { class: "info", title: tip, tabindex: "0" }, "i") : null), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
  }
  function overview() {
    const connected = !!wallet.address;
    const ethUsd = (n) => (n != null && st.eth ? usd(n * st.eth) : "");
    const tiles = h("div", { class: "pf-tiles" },
      tile("Robinhood Chain", connected ? (st.errors.rh ? "–" : st.rh == null ? "…" : `${num(st.rh, 5)} ETH`) : "–", connected ? (st.errors.rh ? "Robinhood Chain RPC unavailable" : ethUsd(st.rh)) : "Not connected", "Native ETH on Robinhood Chain (chain 4663), used for gas and swaps."),
      tile("Tokens", connected ? (st.toks == null ? "…" : st.toks.length ? st.toks.slice(0, 2).map((x) => `${num(Number(x.amount), 4)} ${x.symbol}`).join(" · ") : "None") : "–", connected && st.toks?.length > 2 ? `+${st.toks.length - 2} more` : connected ? "WETH, USDG and tracked tokens" : "Not connected", "WETH, USDG and tokens Troya tracks for this wallet on Robinhood Chain."),
      tile("Hyperliquid", connected ? (st.errors.hl ? "–" : st.hl ? usd(st.hl.accountValue) : "…") : "–", connected && st.hl ? `Withdrawable ${usd(st.hl.withdrawable)}` : connected ? "" : "Not connected", "Perp account value in USDC."),
      tile("Open PnL", connected && st.hl ? h("span", { class: st.hl.unrealizedPnl > 0 ? "up" : st.hl.unrealizedPnl < 0 ? "down" : "" }, `${st.hl.unrealizedPnl > 0 ? "+" : ""}${usd(st.hl.unrealizedPnl)}`) : "–", connected && st.hl ? `${st.hl.positions.length} open position${st.hl.positions.length === 1 ? "" : "s"}` : "", "Unrealised PnL across Hyperliquid perps."));

    const parts = [tiles];
    if (!connected) parts.push(h("div", { class: "panel pf-connect" }, "Connect a wallet to see your balances.", h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet")));

    // setup checklist: a step is ticked only when there is evidence for it
    if (!hideSetup.get()) {
      const swapped = (st.journal || []).some((j) => /swap/i.test(j.kind || j.type || ""));
      const steps = [
        { t: "Connect wallet", done: connected, act: connected ? null : h("button", { class: "btn sm", type: "button", onclick: () => openConnect() }, "Connect"), tip: "Your wallet signs everything; Troya never holds its key." },
        { t: "Get ETH on Robinhood Chain", done: (st.rh || 0) > 0, act: h("a", { class: "link", href: "#/bridge" }, "Bridge"), tip: "Robinhood Chain pays gas in ETH. Bridge it from Arbitrum, Base or Ethereum." },
        { t: "Fund USDC on Hyperliquid", done: (st.hl?.accountValue || 0) > 0, act: h("a", { class: "link", href: "#/bridge?dir=hl" }, "Fund from Robinhood Chain"), tip: "Perps margin is USDC in your Hyperliquid account. Bridge → To Hyperliquid turns ETH on Robinhood Chain into it in one transaction." },
        { t: "Approve a trading key", done: st.key?.state === "approved", act: h("a", { class: "link", href: "#/perps" }, "Perps"), tip: "A trade-only key in this browser, approved once with your wallet. It cannot withdraw." },
        { t: "First swap", done: swapped, act: h("a", { class: "link", href: "#/swap" }, "Swap"), tip: wallet.session ? "Ticked once a swap appears in your journal." : "Sign in so your journal can confirm it." },
      ];
      const n = steps.filter((s) => s.done).length;
      parts.push(h("section", { class: "panel pf-setup", "aria-label": "Get set up" },
        h("div", { class: "pf-setup-h" }, h("h2", {}, "Get set up"), h("span", { class: "ct" }, `${n} of ${steps.length}`), h("div", { class: "pf-bar", "aria-hidden": "true" }, h("i", { style: { width: `${(n / steps.length) * 100}%` } })),
          h("button", { class: "icon-btn", type: "button", "aria-label": "Hide checklist", onclick: () => { hideSetup.set(true); render(); } }, icon("close"))),
        h("div", { class: "pf-steps" }, steps.map((s, i) => h("div", { class: `pf-step ${s.done ? "done" : ""}` },
          h("span", { class: "n" }, s.done ? icon("check") : i + 1), h("b", {}, s.t, h("i", { class: "info", title: s.tip, tabindex: "0" }, "i")), s.done ? null : h("div", { class: "act" }, s.act))))));
    }

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

  /* ---------- inbox ---------- */
  async function inbox(box) {
    if (!wallet.address) { clear(box, h("div", { class: "panel pf-connect" }, "Connect a wallet to see your inbox.", h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"))); return; }
    clear(box, h("div", { class: "panel" }, h("div", { class: "empty" }, "Loading your inbox…")));
    let r;
    try { r = await api.get("inbox?limit=100"); }
    catch (e) {
      if (!alive || tab !== "inbox") return;
      if (e.status === 401 || e.status === 403) {
        clear(box, h("div", { class: "panel pf-connect" }, "Sign in to see your inbox: alerts from playbooks, agent proposals and fills.",
          h("button", { class: "btn primary", type: "button", onclick: async () => { try { await signIn(); render(); } catch (err) { toast(err.message, "error"); } } }, icon("key"), "Sign in")));
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
    if (!wallet.address) { clear(box, h("div", { class: "panel pf-connect" }, "Connect a wallet to see your history.", h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"))); return; }
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
        slot.replaceWith(h("div", { class: "pf-connect" }, "Sign in to read your journal.", h("button", { class: "btn", type: "button", onclick: async () => { try { await signIn(); render(); } catch (e) { toast(e.message, "error"); } } }, icon("key"), "Sign in")));
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
        ] });
        t.setRows(u.fills);
        fBox.lastChild.replaceWith(h("div", { style: { padding: "0 6px 8px" } }, t));
      } catch (e) { if (alive) fBox.lastChild.replaceWith(h("div", { class: "empty" }, h("b", {}, "Fills could not be loaded."), e.message)); }
    })();
  }

  /* ---------- render ---------- */
  function render() {
    tabsEl.set(tab);
    if (tab === "overview") clear(body, overview());
    else if (tab === "inbox") inbox(body);
    else historyTab(body);
  }

  render();
  stops.push(onWallet(async () => {
    st.ely = st.evm = st.hl = null;
    st.key = null;
    await loadJournal();
    if (!alive) return;
    render();
    loadBalances();
  }));
  stops.push(every(15000, () => { if (wallet.address && tab === "overview") loadBalances(); }));
  return () => { alive = false; stops.forEach((f) => { try { f(); } catch {} }); };
}
