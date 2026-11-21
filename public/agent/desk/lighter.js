// Lighter on Robinhood Chain (F16): perps settled on Robinhood Chain with USDG collateral and 0% fees on Standard
// accounts. Steps: deposit USDG from your wallet on Robinhood Chain (the first deposit opens the Lighter account), set up
// a trading key with one signature (made in this browser, registered with ChangePubKey; it can trade and withdraw only
// to your own address), then trade. A Gate reads the live book before each order: minimum size, your free margin,
// what the size would fill at, and orders never fill more than 1% from the price you see.
// The trading key signs without a wallet popup, so every order, close and withdrawal opens a review first. An order
// sets its leverage on Lighter first and is not sent unless Lighter reports that leverage; afterwards the page reads
// the fills and says what really happened ("accepted" from Lighter is not "filled").
import { h, clear, useCss, toast, tiny, usd, price, fixed, pctEl, coinIcon, pageHead, review, modal, short } from "/agent/js/ui.js";
import { wallet, onWallet, openConnect } from "/agent/js/wallet.js";
import * as L from "/agent/js/lighter.js";

const SLIP = 0.01;

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  const st = { markets: [], m: null, book: null, acct: undefined, state: null, key: null, keyOk: false, usdg: null, outgoing: null, side: "long", size: "", lev: 3, busy: false, note: "", q: "", err: null };
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
    if (st.m) st.lev = Math.min(st.lev, st.m.maxLeverage);
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
  const amtIn = h("input", { class: "input", inputmode: "decimal", placeholder: "USDG", "aria-label": "USDG to deposit" });
  function paintAcct() {
    const typing = document.activeElement === amtIn;      // the strip repaints every 15 s; keep the caret in the field
    paintAcct_();
    if (typing && amtIn.isConnected) amtIn.focus();
  }
  function paintAcct_() {
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
        h("button", { class: "btn sm", type: "button", disabled: st.busy || !st.keyOk || !(s.available >= 1), onclick: openWithdraw, title: "USDG back to your own address on Robinhood Chain" }, "Withdraw to my wallet"), usdgLine),
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
  const mmfOf = (id) => st.markets.find((x) => x.id === id)?.mmf;
  // where this account would be liquidated after adding `add` base at `px` (cross margin, the whole account backs it)
  const liqAfter = (m, add, px) => (st.state && px ? L.estLiq({ equity: st.state.crossValue, positions: st.state.positions, marketId: m.id, add, px, mmfOf }) : null);
  function gate() {
    const m = st.m, amt = Number(st.size);
    if (!m || !(amt > 0)) return { state: "wait", items: [] };
    const isBuy = st.side === "long", f = fill(amt, isBuy), mid = st.book && st.book.asks[0] && st.book.bids[0] ? (st.book.asks[0].px + st.book.bids[0].px) / 2 : m.mark;
    const impact = f.avg && mid ? Math.abs(f.avg / mid - 1) * 100 : null;
    const items = [], add = (label, state, value) => items.push({ label, state, value });
    add("Minimum", amt >= m.minQuote ? "pass" : "fail", `$${m.minQuote} per order`);
    const free = st.state?.available ?? 0;
    add("Margin", amt / st.lev <= free ? "pass" : "fail", `${usd(amt / st.lev)} needed · ${usd(free)} free`);
    const cur = st.state?.margins?.[m.id];
    const levNote = !st.state || L.leverageIs(st.state.margins, m.id, st.lev) ? "" : cur ? ` · now ${cur.lev}x, set first` : " · set first";
    add("Leverage", st.lev <= m.maxLeverage ? "pass" : "fail", `${st.lev}x of ${m.maxLeverage}x${levNote}`);
    add("Book", !f.complete ? "fail" : impact > 1 ? "fail" : impact > 0.3 ? "warn" : "pass", f.complete ? `fills ~$${price(f.avg)} (${impact.toFixed(3)}%)` : "book too thin for this size");
    const liq = f.complete ? liqAfter(m, isBuy ? f.base : -f.base, f.avg) : null, liqDist = liq && mid ? Math.abs(mid - liq) / mid * 100 : null;
    if (liqDist != null) add("Liquidation", liqDist < 3 ? "warn" : "pass", `~$${price(liq)} · ${liqDist.toFixed(1)}% away`);
    return { state: items.some((i) => i.state === "fail") ? "fail" : items.some((i) => i.state === "warn") ? "warn" : "pass", items, f, mid };
  }
  // The ticket is built once and only its parts are refreshed. The size field and the leverage slider never leave the
  // page: re-creating the slider on every paint (as before) dropped the drag after the first step, and re-adding the
  // size field cost it the caret. The slots use display: contents, so the card's grid lays out their children as before.
  const sizeIn = h("input", { class: "input", inputmode: "decimal", placeholder: "Size in USD", "aria-label": "Order size in USD" });
  sizeIn.addEventListener("input", () => { st.size = sizeIn.value; paint(false); });
  const levIn = h("input", { class: "pp-range", type: "range", min: "1", max: "10", step: "1", value: String(st.lev), "aria-label": "Leverage" });
  levIn.addEventListener("input", () => { st.lev = +levIn.value; paint(false); });
  const levVal = h("b", {}, `${st.lev}x`);
  const slot = () => h("div", { style: { display: "contents" } });
  const headS = slot(), bookS = slot(), sideS = slot(), gateS = slot(), btnS = slot();
  let built = false;
  function paint(full = true) {
    const m = st.m;
    if (!m) { built = false; return clear(card, h("div", { class: "sk", style: { height: "320px" } })); }
    if (!built) {
      clear(card, headS, bookS, sideS, sizeIn, h("div", {}, h("div", { class: "pp-lev-h" }, h("span", {}, "Leverage"), levVal), levIn), gateS, btnS);
      built = true; full = true;
    }
    if (full) {
      clear(headS, h("div", { class: "lt-head" }, coinIcon(m.symbol, "pp-coin"), h("b", {}, `${m.symbol} · Lighter`), h("span", {}, `$${price(m.mark)}`), m.change24h != null ? pctEl(m.change24h) : null, h("span", { class: "fine" }, `fees ${m.takerFee ? `${(m.takerFee * 100).toFixed(3)}%` : "0%"} · up to ${m.maxLeverage}x`)));
      clear(bookS, bookView(m));
      clear(sideS, h("div", { class: "seg long" }, ["long", "short"].map((v) => h("button", { type: "button", "data-v": v, "aria-pressed": String(st.side === v), onclick: () => { st.side = v; paint(); } }, v === "long" ? "Long" : "Short"))));
    }
    // max first: a value above the old max would be clamped
    levIn.max = String(m.maxLeverage);
    if (levIn.value !== String(st.lev)) levIn.value = String(st.lev);
    levVal.textContent = `${st.lev}x`;
    if (sizeIn.value !== st.size) sizeIn.value = st.size;
    const g = gate();
    const ready = st.keyOk && (g.state === "pass" || g.state === "warn");
    const btn = !wallet.address ? h("button", { class: "btn big primary", type: "button", onclick: openConnect }, "Connect wallet")
      : st.acct == null ? h("button", { class: "btn big", type: "button", disabled: true }, "Deposit USDG first")
      : !st.keyOk ? h("button", { class: "btn big primary", type: "button", disabled: st.busy, onclick: doKey }, "Set up trading (one signature)")
      : h("button", { class: `btn big ${st.side === "long" ? "blue" : "danger"}`, type: "button", disabled: !ready || st.busy, onclick: submit },
        st.busy && st.note ? st.note : g.state === "wait" ? "Enter a size" : ready ? `${st.side === "long" ? "Long" : "Short"} ${m.symbol}` : "Blocked by the Gate");
    clear(gateS, h("div", { class: "sw-gate" }, h("div", { class: "gh" }, "Lighter Gate"),
      g.state === "wait" ? h("p", { class: "muted", style: { margin: 0 } }, "Enter a size: the Gate checks the minimum, your free margin and the live book.") : h("ul", {}, g.items.map((i) => h("li", { class: i.state }, h("span", {}, i.label), h("b", {}, i.value))))));
    clear(btnS, btn);
  }
  // the book like the Perps one: one row per price, fixed decimals, a depth bar, Bids and Asks side by side
  function bookView(m) {
    if (!st.book) return h("div", { class: "sk", style: { height: "220px" } });
    const N = 8, pd = m.priceDecimals ?? 2, sd = m.sizeDecimals ?? 4;
    const bids = st.book.bids.slice(0, N), asks = st.book.asks.slice(0, N);
    const max = Math.max(...bids.map((l) => l.sz), ...asks.map((l) => l.sz), 1e-9);
    const lv = (l, cls) => h("div", { class: `pp-lv ${cls}` }, h("i", { style: { width: `${(l.sz / max) * 100}%` } }), h("span", { class: "p" }, fixed(l.px, pd)), h("span", {}, fixed(l.sz, sd)));
    const spread = bids[0] && asks[0] ? ((asks[0].px - bids[0].px) / asks[0].px) * 100 : null;
    return h("div", { class: "lt-book" },
      h("div", { class: "lt-book-t" }, h("span", {}, "Order book"), spread != null ? h("span", { class: "muted" }, `Spread ${spread.toFixed(3)}%`) : null),
      h("div", { class: "pp-book-cols" },
        h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Bids"), h("span", {}, "Size")), bids.map((l) => lv(l, "bid"))),
        h("div", {}, h("div", { class: "pp-book-h" }, h("span", {}, "Asks"), h("span", {}, "Size")), asks.map((l) => lv(l, "ask")))));
  }

  /* ---------- actions (each signed by the user) ---------- */
  const run = async (label, fn) => {
    if (st.busy) return;
    st.busy = true; st.note = ""; paintAcct(); paint();
    try { await fn(); } catch (e) { toast(e.shortMessage || e.message, "error", 8000); }
    st.busy = false; st.note = "";
    if (alive) await loadAccount();
  };
  // what the order button says while an order runs (setting leverage, placing, checking the fill)
  const note = (s) => { st.note = s; if (alive) paint(false); };
  // a review was for one wallet and one Lighter account: if either changed meanwhile, nothing is sent
  const same = (owner, acct) => { if (wallet.address !== owner || st.acct !== acct) throw new Error("The wallet changed, so nothing was sent."); };
  const posOf = (state, marketId) => state?.positions?.find((p) => p.marketId === marketId)?.size || 0;
  // sendTx only says Lighter accepted the order: read this order's fills (about 6 s), with the position as a second
  // source when the trade feed lags, and say what happened
  async function settle(acct, m, coi, base, q0, words) {
    const sd = m.sizeDecimals ?? 4;
    const f = await L.waitFill(acct, m.id, coi, base);
    if (f.base > 0) {
      const part = f.base < base * 0.999999;
      return toast(`${part ? words.part : words.done} ${fixed(f.base, sd)}${part ? ` of ${fixed(base, sd)}` : ""} ${m.symbol} @ $${price(f.avg)}${part ? ". The rest was cancelled at the 1% cap." : ""}`, "ok", 8000);
    }
    const after = await L.accountState(acct).catch(() => null);
    if (!after) return toast(`Lighter accepted the order but has not reported a fill yet. Check your position in a moment.`, "", 9000);
    const moved = Math.abs(posOf(after, m.id) - q0);
    if (moved > 0) return toast(`${words.done} about ${fixed(moved, sd)} ${m.symbol}. Lighter has not reported the price yet.`, "ok", 8000);
    toast(`${words.none}. Lighter cancelled the order (no fill within 1% of $${price(words.ref)}, or not enough margin). Your position is unchanged.`, "error", 9000);
  }
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

  // Withdraw has its own amount field and a review. It never reads the deposit field, and a blank field is never
  // "everything": the amount is always typed or set with Max.
  function openWithdraw() {
    if (st.busy || !st.keyOk || st.acct == null) return;
    const owner = wallet.address, acct = st.acct, free = st.state?.available || 0, max = Math.floor(free * 100) / 100;
    const inp = h("input", { class: "input", inputmode: "decimal", placeholder: "0.00", autocomplete: "off", "aria-label": "USDG to withdraw" });
    const msg = h("p", { class: "note down", role: "alert", hidden: true });
    const say = (t) => { msg.textContent = t; msg.hidden = false; };
    const next = () => {
      const v = inp.value.trim(), amt = Number(v);
      if (!v) return say("Enter how much USDG to withdraw.");
      if (!Number.isFinite(amt) || amt < 1) return say("Lighter withdraws at least 1 USDG.");
      if (amt > free) return say(`You have ${tiny(free)} USDG free on Lighter.`);
      md.close();
      confirmWithdraw(owner, acct, amt);
    };
    inp.addEventListener("input", () => { msg.hidden = true; });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") next(); });
    const md = modal({ title: "Withdraw USDG to your wallet", body: h("div", { style: { display: "grid", gap: "12px" } },
      h("div", { class: "rows", style: { margin: 0 } },
        h("div", {}, h("span", {}, "Free on Lighter"), h("span", {}, `${tiny(free)} USDG`)),
        h("div", {}, h("span", {}, "To"), h("span", {}, `${short(owner, 6)} · your address on Robinhood Chain`))),
      h("div", { class: "field" }, h("span", {}, "Amount (USDG)"),
        h("div", { class: "row" }, inp, h("button", { class: "chip", type: "button", title: "All your free USDG on Lighter", onclick: () => { inp.value = max.toFixed(2); msg.hidden = true; } }, "Max"))),
      msg,
      h("div", { class: "row", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn ghost", type: "button", onclick: () => md.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: next }, "Review"))) });
  }
  async function confirmWithdraw(owner, acct, amt) {
    const ok = await review({ title: "Withdraw to your wallet", confirmLabel: "Withdraw",
      summary: "Lighter pays withdrawals only to the address that owns the account, so the trading key cannot send this anywhere else.",
      rows: [["Amount", `${amt} USDG`], ["From", `Lighter account #${acct}`], ["To", `${short(owner, 6)} (your own address)`], ["Network", "Robinhood Chain"],
        ["Arrives", "Usually within about 10 minutes"], ["Fee", "None from Troya"]] });
    if (!ok || !alive) return;
    run("withdraw", async () => {
      same(owner, acct);
      await L.withdraw(owner, acct, amt);
      st.outgoing = { amt, before: st.usdg || 0 };
      toast(`Withdrawal of ${tiny(amt)} USDG accepted by Lighter. It usually reaches your wallet on Robinhood Chain within about 10 minutes.`, "ok", 9000);
    });
  }

  // An order: a review of exactly what goes out, then the leverage on Lighter, then the order, then its fill.
  async function submit() {
    if (st.busy) return;
    const m = st.m, g = gate(), lev = st.lev, isBuy = st.side === "long", owner = wallet.address, acct = st.acct;
    if (!(g.state === "pass" || g.state === "warn")) return toast("Blocked by the Gate.", "error");
    const sd = m.sizeDecimals ?? 4;
    const base = Math.floor(g.f.base * 10 ** sd) / 10 ** sd;
    if (!(base >= m.minBase)) return toast(`Too small: ${m.symbol} needs at least ${m.minBase}.`, "error");
    const worst = isBuy ? g.mid * (1 + SLIP) : g.mid * (1 - SLIP), notional = base * g.f.avg;
    const cur = st.state?.margins?.[m.id], levOk = L.leverageIs(st.state?.margins, m.id, lev);
    const liq = liqAfter(m, isBuy ? base : -base, g.f.avg);
    const ok = await review({
      title: `${isBuy ? "Long" : "Short"} ${m.symbol} on Lighter`, confirmLabel: `Place ${isBuy ? "long" : "short"}`, danger: !isBuy,
      summary: `A market order (immediate or cancel): it fills now, never past the worst price, or it is cancelled. Your trading key signs it in this browser.${levOk ? "" : ` Lighter first switches ${m.symbol} to ${lev}x; if that does not apply, the order is not sent.`}`,
      rows: [
        ["Side", isBuy ? "Long" : "Short"],
        ["Size", `${fixed(base, sd)} ${m.symbol} · ${usd(notional)}`],
        ["Est. fill", `$${price(g.f.avg)}`],
        ["Worst price", `$${price(worst)} (1% from $${price(g.mid)})`],
        ["Leverage", `${lev}x cross${levOk ? "" : cur ? ` · now ${cur.lev}x, set first` : " · set first"}`],
        ["Margin", usd(notional / lev)],
        ["Est. liquidation", liq ? `$${price(liq)}` : "None at this size"],
        ["Fees", m.takerFee ? `${(m.takerFee * 100).toFixed(3)}%` : "0%"],
      ],
      warn: g.state === "warn" ? g.items.filter((i) => i.state === "warn").map((i) => `${i.label}: ${i.value}`).join(" · ") : null,
    });
    if (!ok || !alive) return;
    run("order", async () => {
      same(owner, acct);
      // fresh: the leverage Lighter holds now, and the position before
      const before = await L.accountState(acct).catch((e) => { throw new Error(`Your Lighter account could not be read (${e.message}), so nothing was sent.`); });
      // 1 · leverage first. Lighter applies the leverage the account holds for the market when the order runs, so an
      // order sent after a failed change would open at a leverage the review never showed. Accepted is not applied:
      // the order waits until Lighter reports the new leverage and is not sent otherwise.
      let nonce = 0;
      if (!L.leverageIs(before.margins, m.id, lev)) {
        note(`Setting ${lev}x on Lighter…`);
        let r;
        try { r = await L.setLeverage(owner, acct, m, lev); }
        catch (e) { throw new Error(`Leverage not set (${e.shortMessage || e.message}). The order was not sent.`); }
        if (!(await L.waitLeverage(acct, m.id, lev))) throw new Error(`Lighter has not applied ${lev}x on ${m.symbol}, so the order was not sent. Try again in a moment.`);
        nonce = r.nonce + 1;                                // the order follows the change in the same nonce sequence
      }
      // 2 · the order, capped at the reviewed worst price
      note("Placing the order…");
      same(owner, acct);
      const o = await L.placeOrder(owner, acct, m, { isBuy, base, price: worst, market: true, nonce });
      st.size = ""; sizeIn.value = "";
      // 3 · what filled
      note("Checking the fill…");
      await settle(acct, m, o.coi, base, posOf(before, m.id), { done: "Filled", part: "Partly filled", none: "Not filled", ref: g.mid });
    });
  }
  // closing is a reduce-only market order: it gets the same review and the same fill check
  async function closePos(p) {
    if (st.busy) return;
    const m = st.markets.find((x) => x.id === p.marketId), owner = wallet.address, acct = st.acct;
    if (!m) return toast("Market not found.", "error");
    let b;
    try { b = await L.book(m.id, 5); } catch (e) { return toast(`Lighter could not be reached: ${e.message}`, "error"); }
    const isBuy = p.size < 0, ref = isBuy ? b.asks[0]?.px : b.bids[0]?.px;
    if (!ref) return toast("No price on the book right now.", "error");
    const base = Math.abs(p.size), worst = isBuy ? ref * (1 + SLIP) : ref * (1 - SLIP), sd = m.sizeDecimals ?? 4;
    const ok = await review({ title: `Close ${p.size > 0 ? "long" : "short"} ${p.symbol}`, confirmLabel: "Close at market", danger: true,
      summary: "A reduce-only market order: it fills now within 1% of the best price or is cancelled, and it can only shrink this position.",
      rows: [["Position", `${p.size > 0 ? "Long" : "Short"} ${fixed(base, sd)} ${p.symbol}`], ["Entry", `$${price(p.entry)}`], ["Best price now", `$${price(ref)}`],
        ["Worst price", `$${price(worst)} (1% cap)`], ["Unrealised PnL", `${p.pnl >= 0 ? "+" : ""}${usd(p.pnl)}`]] });
    if (!ok || !alive) return;
    run("close", async () => {
      same(owner, acct);
      const before = await L.accountState(acct).catch(() => null);
      note("Closing…");
      const o = await L.placeOrder(owner, acct, m, { isBuy, base, price: worst, market: true, reduceOnly: true });
      await settle(acct, m, o.coi, base, before ? posOf(before, m.id) : p.size, { done: "Closed", part: "Partly closed", none: "Not closed", ref });
    });
  }

  const offWallet = onWallet(() => loadAccount());
  await loadMarkets();
  loadBook();
  // a hidden tab does not poll Lighter; coming back reads the book and the account at once
  const live = (fn) => () => { if (!document.hidden) fn(); };
  const t1 = setInterval(live(loadBook), 5000), t2 = setInterval(live(loadAccount), 15000), t3 = setInterval(live(loadMarkets), 60000);
  const onVis = () => { if (!document.hidden && alive) { loadBook(); loadAccount(); } };
  document.addEventListener("visibilitychange", onVis);
  return () => { alive = false; offWallet(); clearInterval(t1); clearInterval(t2); clearInterval(t3); document.removeEventListener("visibilitychange", onVis); };
}
