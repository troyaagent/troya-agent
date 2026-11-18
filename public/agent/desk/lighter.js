// Lighter on Robinhood Chain (F16): perps settled on Robinhood Chain with USDG collateral and 0% fees on Standard
// accounts. Steps: deposit USDG from your wallet on Robinhood Chain (the first deposit opens the Lighter account), set up
// a trading key with one signature (made in this browser, registered with ChangePubKey; it can trade and withdraw only
// to your own address), then trade. A Gate reads the live book before each order: minimum size, your free margin,
// what the size would fill at, and orders never fill more than 1% from the price you see.
import { h, clear, useCss, toast, tiny, usd, price, fixed, pctEl, coinIcon, pageHead } from "/agent/js/ui.js";
import { wallet, onWallet, openConnect } from "/agent/js/wallet.js";
import * as L from "/agent/js/lighter.js";

const SLIP = 0.01;

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  const st = { markets: [], m: null, book: null, acct: undefined, state: null, key: null, keyOk: false, usdg: null, outgoing: null, side: "long", size: "", lev: 3, busy: false, q: "", err: null };
  const list = h("div", { class: "sp-list" });
  const search = h("input", { class: "input", placeholder: "Search TSLA, ETH, NVDA…", "aria-label": "Search Lighter markets", autocomplete: "off" });
  const card = h("div", { class: "panel sp-card lt-card" });
  const acctBox = h("div", { class: "panel lt-acct" });
  clear(view, h("div", { class: "dk sp" },
    pageHead("Lighter on Robinhood Chain", "Perps settled on Robinhood Chain, margined in USDG, 0% fees on Standard accounts. Your trading key is made in this browser and never reaches Troya."),
    acctBox,
    h("div", { class: "sp-grid" }, h("div", { class: "panel sp-side" }, search, list), card),
    h("p", { class: "fine lt-legal" }, "Lighter is a separate exchange (lighter.xyz). It is not available to people in the US, the UK, Canada and the other places its terms exclude. Troya routes nothing through its own servers here and takes no fee.")));
  search.addEventListener("input", () => { st.q = search.value.trim().toLowerCase(); paintList(); });

  /* ---------- data ---------- */
  async function loadMarkets() {
    try { st.markets = await L.markets(); st.err = null; } catch (e) { st.err = e.message; }
    if (!st.m) st.m = st.markets.find((x) => x.symbol === (ctx.parts[0] || "ETH").toUpperCase()) || st.markets[0] || null;
    else st.m = st.markets.find((x) => x.id === st.m.id) || st.m;
    paintList(); paint();
  }
  async function loadBook() {
    if (!st.m || document.hidden) return;
    const id = st.m.id;
    try { const b = await L.book(id, 60); if (st.m?.id === id) { st.book = b; paint(); } } catch {}
  }
  async function loadAccount() {
    if (!wallet.address) { st.acct = undefined; st.state = null; st.key = null; return paintAcct(); }
    try { st.acct = await L.accountOf(wallet.address); } catch { st.acct = undefined; }
    try { st.usdg = await L.usdgBalance(wallet.address); } catch { st.usdg = null; }
    if (st.outgoing && st.usdg != null && st.usdg >= st.outgoing.before + st.outgoing.amt * 0.99) { toast(`${tiny(st.outgoing.amt)} USDG arrived in your wallet on Robinhood Chain`, "ok", 8000); st.outgoing = null; }
    if (st.acct != null) {
      try { st.state = await L.accountState(st.acct); } catch { st.state = null; }
      st.key = L.getKey(wallet.address, st.acct);
      st.keyOk = st.key ? await L.keyRegistered(st.acct, st.key.pk).catch(() => false) : false;
    }
    if (alive) { paintAcct(); paint(); }
  }

  /* ---------- the account strip ---------- */
  const amtIn = h("input", { class: "input", inputmode: "decimal", placeholder: "USDG", "aria-label": "Amount of USDG" });
  function paintAcct() {
    if (!wallet.address) return clear(acctBox, h("div", { class: "lt-row" }, h("span", {}, "Connect the wallet you will trade from."), h("button", { class: "btn primary sm", type: "button", onclick: openConnect }, "Connect wallet")));
    if (st.acct === undefined) return clear(acctBox, h("p", { class: "muted", style: { margin: 0 } }, "Reading your Lighter account…"));
    const depositBtn = h("button", { class: "btn sm blue", type: "button", disabled: st.busy, onclick: doDeposit }, st.acct == null ? "Deposit and open my account" : "Deposit");
    const usdgLine = h("span", { class: "fine" }, `Wallet on Robinhood Chain: ${st.usdg == null ? "–" : `${tiny(st.usdg)} USDG`}`,
      st.outgoing ? h("b", { class: "up" }, ` · ${tiny(st.outgoing.amt)} USDG on its way from Lighter`) : null);
    if (st.acct == null) {
      return clear(acctBox, h("div", { class: "lt-steps" },
        h("div", {}, h("b", {}, "1 · Open your Lighter account"), h("p", { class: "fine" }, "Lighter opens an account on your first deposit: USDG from your wallet on Robinhood Chain into Lighter's contract (at least 1 USDG). Two signatures: approve, then deposit.")),
        h("div", { class: "lt-row" }, amtIn, depositBtn, usdgLine)));
    }
    const s = st.state || {};
    const keyPart = st.keyOk
      ? h("span", { class: "fine" }, `Trading key active · `, h("button", { class: "link", type: "button", onclick: () => { L.forgetKey(wallet.address, st.acct); loadAccount(); } }, "Forget on this device"))
      : h("button", { class: "btn sm primary", type: "button", disabled: st.busy, onclick: doKey }, st.key ? "Finish trading key setup" : "Set up trading (one signature)");
    clear(acctBox,
      h("div", { class: "lt-row" },
        h("span", {}, h("b", {}, `Lighter account #${st.acct}`), h("span", { class: "fine" }, ` · collateral ${usd(s.collateral || 0)} · free ${usd(s.available || 0)}`)), keyPart),
      h("div", { class: "lt-row" }, amtIn, depositBtn,
        h("button", { class: "btn sm", type: "button", disabled: st.busy || !st.keyOk || !(s.available > 1), onclick: doWithdraw, title: "USDG back to your own address on Robinhood Chain" }, "Withdraw to my wallet"), usdgLine),
      positions());
  }
  function positions() {
    const ps = st.state?.positions || [];
    if (!ps.length) return null;
    return h("div", { class: "lt-pos" }, ps.map((p) => h("div", { class: "lt-row" },
      h("b", {}, `${p.size > 0 ? "Long" : "Short"} ${p.symbol}`), h("span", {}, `${tiny(Math.abs(p.size))} @ $${price(p.entry)}`),
      h("span", { class: p.pnl >= 0 ? "up" : "down" }, `${p.pnl >= 0 ? "+" : ""}${usd(p.pnl)}`), p.liq ? h("span", { class: "fine" }, `liq $${price(p.liq)}`) : null,
      h("button", { class: "btn sm", type: "button", disabled: st.busy || !st.keyOk, onclick: () => closePos(p) }, "Close"))));
  }

  /* ---------- markets list + ticket ---------- */
  function paintList() {
    const rows = st.markets.filter((m) => !st.q || m.symbol.toLowerCase().includes(st.q)).slice(0, 80);
    clear(list, rows.map((m) => h("button", { class: `sp-row ${st.m?.id === m.id ? "on" : ""}`, type: "button", onclick: () => { st.m = m; st.book = null; st.size = ""; st.lev = Math.min(st.lev, m.maxLeverage); paintList(); paint(); loadBook(); } },
      coinIcon(m.symbol, "sm"), h("span", { class: "sp-row-n" }, h("b", {}, m.symbol), h("small", {}, `Vol ${usd(m.volumeUsd, { compact: true })} · ${m.maxLeverage}x`)),
      h("span", { class: "sp-row-p" }, h("b", {}, `$${price(m.mark)}`), m.change24h != null ? pctEl(m.change24h) : null))),
      rows.length ? null : h("p", { class: "muted", style: { padding: "12px" } }, st.err ? `Lighter could not be reached: ${st.err}` : "No market matches."));
  }
  // walk the book: what does this USD size fill at?
  function fill(usdAmt, isBuy) {
    const lv = st.book ? (isBuy ? st.book.asks : st.book.bids) : [];
    let left = usdAmt, base = 0, cost = 0;
    for (const l of lv) { const take = Math.min(left, l.px * l.sz); base += take / l.px; cost += take; left -= take; if (left <= 1e-9) break; }
    return { base, avg: base ? cost / base : null, complete: left <= 1e-6 };
  }
  function gate() {
    const m = st.m, amt = Number(st.size);
    if (!m || !(amt > 0)) return { state: "wait", items: [] };
    const isBuy = st.side === "long", f = fill(amt, isBuy), mid = st.book && st.book.asks[0] && st.book.bids[0] ? (st.book.asks[0].px + st.book.bids[0].px) / 2 : m.mark;
    const impact = f.avg && mid ? Math.abs(f.avg / mid - 1) * 100 : null;
    const items = [], add = (label, state, value) => items.push({ label, state, value });
    add("Minimum", amt >= m.minQuote ? "pass" : "fail", `$${m.minQuote} per order`);
    const free = st.state?.available ?? 0;
    add("Margin", amt / st.lev <= free ? "pass" : "fail", `${usd(amt / st.lev)} needed · ${usd(free)} free`);
    add("Leverage", st.lev <= m.maxLeverage ? "pass" : "fail", `${st.lev}x of ${m.maxLeverage}x`);
    add("Book", !f.complete ? "fail" : impact > 1 ? "fail" : impact > 0.3 ? "warn" : "pass", f.complete ? `fills ~$${price(f.avg)} (${impact.toFixed(3)}%)` : "book too thin for this size");
    return { state: items.some((i) => i.state === "fail") ? "fail" : items.some((i) => i.state === "warn") ? "warn" : "pass", items, f, mid };
  }
  const sizeIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Size in USD", "aria-label": "Order size in USD" });
  sizeIn.addEventListener("input", () => { st.size = sizeIn.value; paint(false); });
  function paint(full = true) {
    const m = st.m;
    if (!m) return clear(card, h("div", { class: "sk", style: { height: "320px" } }));
    const g = gate();
    const levIn = h("input", { class: "pp-range", type: "range", min: "1", max: String(m.maxLeverage), step: "1", value: String(st.lev), "aria-label": "Leverage" });
    levIn.addEventListener("input", () => { st.lev = +levIn.value; paint(false); });
    const sideSeg = h("div", { class: "seg long" }, ["long", "short"].map((v) => h("button", { type: "button", "data-v": v, "aria-pressed": String(st.side === v), onclick: () => { st.side = v; paint(); } }, v === "long" ? "Long" : "Short")));
    // the book like the Perps one: one row per price, fixed decimals, a depth bar, Bids and Asks side by side
    const N = 8, pd = m.priceDecimals ?? 2, sd = m.sizeDecimals ?? 4;
    const bookView = st.book ? (() => {
      const bids = st.book.bids.slice(0, N), asks = st.book.asks.slice(0, N);
      const max = Math.max(...bids.map((l) => l.sz), ...asks.map((l) => l.sz), 1e-9);
      const lv = (l, cls) => h("div", { class: `pp-lv ${cls}` }, h("i", { style: { width: `${(l.sz / max) * 100}%` } }), h("span", { class: "p" }, fixed(l.px, pd)), h("span", {}, fixed(l.sz, sd)));
      const spread = bids[0] && asks[0] ? ((asks[0].px - bids[0].px) / asks[0].px) * 100 : null;
      return h("div", { class: "lt-book" },
        h("div", { class: "lt-book-t" }, h("span", {}, "Order book"), spread != null ? h("span", { class: "muted" }, `Spread ${spread.toFixed(3)}%`) : null),
        h("div", { class: "pp-book-cols" },
          h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Bids"), h("span", {}, "Size")), bids.map((l) => lv(l, "bid"))),
          h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Asks"), h("span", {}, "Size")), asks.map((l) => lv(l, "ask")))));
    })() : h("div", { class: "sk", style: { height: "220px" } });
    const ready = st.keyOk && (g.state === "pass" || g.state === "warn");
    const btn = !wallet.address ? h("button", { class: "btn big primary", type: "button", onclick: openConnect }, "Connect wallet")
      : st.acct == null ? h("button", { class: "btn big", type: "button", disabled: true }, "Deposit USDG first")
      : !st.keyOk ? h("button", { class: "btn big primary", type: "button", disabled: st.busy, onclick: doKey }, "Set up trading (one signature)")
      : h("button", { class: `btn big ${st.side === "long" ? "blue" : "danger"}`, type: "button", disabled: !ready || st.busy, onclick: submit }, g.state === "wait" ? "Enter a size" : ready ? `${st.side === "long" ? "Long" : "Short"} ${m.symbol}` : "Blocked by the Gate");
    const active = document.activeElement === sizeIn;
    clear(card,
      h("div", { class: "lt-head" }, coinIcon(m.symbol, "pp-coin"), h("b", {}, `${m.symbol} · Lighter`), h("span", {}, `$${price(m.mark)}`), m.change24h != null ? pctEl(m.change24h) : null, h("span", { class: "fine" }, `fees ${m.takerFee ? `${(m.takerFee * 100).toFixed(3)}%` : "0%"} · up to ${m.maxLeverage}x`)),
      bookView, sideSeg, sizeIn,
      h("div", {}, h("div", { class: "pp-lev-h" }, h("span", {}, "Leverage"), h("b", {}, `${st.lev}x`)), levIn),
      h("div", { class: "sw-gate" }, h("div", { class: "gh" }, "Lighter Gate"),
        g.state === "wait" ? h("p", { class: "muted", style: { margin: 0 } }, "Enter a size: the Gate checks the minimum, your free margin and the live book.") : h("ul", {}, g.items.map((i) => h("li", { class: i.state }, h("span", {}, i.label), h("b", {}, i.value))))),
      btn);
    if (active) { sizeIn.focus(); const n = sizeIn.value.length; try { sizeIn.setSelectionRange(n, n); } catch {} }
  }

  /* ---------- actions (each signed by the user) ---------- */
  const run = async (label, fn) => {
    if (st.busy) return;
    st.busy = true; paintAcct(); paint();
    try { await fn(); } catch (e) { toast(e.shortMessage || e.message, "error", 7000); }
    st.busy = false; await loadAccount();
  };
  const doDeposit = () => run("deposit", async () => {
    const amt = Number(amtIn.value);
    if (!(amt >= 1)) throw new Error("Lighter takes at least 1 USDG per deposit.");
    const hash = await L.deposit(wallet.address, amt, (s) => toast(s === "approve" ? "Approve USDG for Lighter in your wallet…" : "Confirm the deposit in your wallet…", ""));
    toast(`Deposit sent (${hash.slice(0, 10)}…). Lighter credits it in about a minute.`, "ok", 7000);
    amtIn.value = "";
    setTimeout(loadAccount, 30000);
  });
  const doKey = () => run("key", async () => {
    toast("Sign the Lighter key registration in your wallet…", "");
    const ok = await L.setupKey(wallet.address, st.acct);
    toast(ok ? "Trading key active on Lighter" : "Key sent; Lighter is still registering it. Check again in a minute.", ok ? "ok" : "", 6000);
  });
  const doWithdraw = () => run("withdraw", async () => {
    const free = st.state?.available || 0;
    const amt = Number(amtIn.value) || Math.floor(free * 100) / 100;
    if (!(amt >= 1) || amt > free) throw new Error(`Withdraw between 1 and ${tiny(free)} USDG.`);
    await L.withdraw(wallet.address, st.acct, amt);
    st.outgoing = { amt, before: st.usdg || 0 };
    toast(`Withdrawal of ${tiny(amt)} USDG to your own address accepted. It settles on Robinhood Chain.`, "ok", 8000);
  });
  const submit = () => run("order", async () => {
    const m = st.m, g = gate();
    if (!(g.state === "pass" || g.state === "warn")) throw new Error("Blocked by the Gate.");
    const isBuy = st.side === "long";
    await L.setLeverage(wallet.address, st.acct, m, st.lev).catch(() => {});      // best effort; the order still checks margin
    const worst = isBuy ? g.mid * (1 + SLIP) : g.mid * (1 - SLIP);
    const base = Math.floor(g.f.base * 10 ** m.sizeDecimals) / 10 ** m.sizeDecimals;
    if (!(base >= m.minBase)) throw new Error(`Too small: ${m.symbol} needs at least ${m.minBase}.`);
    await L.placeOrder(wallet.address, st.acct, m, { isBuy, base, price: worst, market: true });
    toast(`${isBuy ? "Long" : "Short"} ${tiny(base)} ${m.symbol} sent to Lighter (never more than 1% from $${price(g.mid)})`, "ok", 7000);
    st.size = ""; sizeIn.value = "";
  });
  const closePos = (p) => run("close", async () => {
    const m = st.markets.find((x) => x.id === p.marketId);
    if (!m) throw new Error("Market not found.");
    const b = await L.book(m.id, 5);
    const isBuy = p.size < 0, ref = isBuy ? b.asks[0]?.px : b.bids[0]?.px;
    if (!ref) throw new Error("No price on the book right now.");
    await L.placeOrder(wallet.address, st.acct, m, { isBuy, base: Math.abs(p.size), price: isBuy ? ref * (1 + SLIP) : ref * (1 - SLIP), market: true, reduceOnly: true });
    toast(`Closing ${p.symbol} sent`, "ok");
  });

  const offWallet = onWallet(() => loadAccount());
  await loadMarkets();
  loadBook();
  const t1 = setInterval(loadBook, 5000), t2 = setInterval(loadAccount, 15000), t3 = setInterval(loadMarkets, 60000);
  return () => { alive = false; offWallet(); clearInterval(t1); clearInterval(t2); clearInterval(t3); };
}
