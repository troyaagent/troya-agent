// Spot on Hyperliquid (F12): buy and sell Hyperliquid spot pairs (HYPE, UBTC, UETH, PURR …) from the user's own Hyperliquid
// account with the same trade-only key the Perps page uses. A Spot Gate reads the live order book before every order:
// the pair, 24h volume, the spread, and what your size would actually fill at. Orders are IOC with a 1% price cap, so a
// thin book can never fill you worse than that. USDC can be moved between the perps and spot accounts with one signature.
import { h, clear, icon, useCss, toast, tiny, num, usd, pctEl, coinIcon, seg, pageHead } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, ensureChain } from "/agent/js/wallet.js";
import { tradingKeyStatus, approveTradingKey, placeSpotOrder, transferUsdClass, withdrawUsdc } from "/agent/js/hl.js";

const SLIP = 0.01;

export async function mount(view, ctx) {
  useCss("perps");
  let alive = true;
  const st = { pairs: [], pair: null, side: "buy", amount: "", user: null, key: null, book: null, busy: false, q: "", live: false };
  // orders open after the real-money test; until then the page shows prices, balances and the Spot Gate
  api.get("features").then((f) => { st.live = !!f.spot; paint(); }).catch(() => {});

  const list = h("div", { class: "sp-list" });
  const search = h("input", { class: "input", placeholder: "Search HYPE, UBTC, PURR…", "aria-label": "Search spot pairs", autocomplete: "off" });
  const card = h("div", { class: "panel sp-card" });
  clear(view, h("div", { class: "dk sp" },
    pageHead("Spot on Hyperliquid", "Buy and sell Hyperliquid spot coins from your own Hyperliquid account. The Spot Gate reads the order book first; orders never fill more than 1% from the price you see."),
    h("div", { class: "sp-grid" }, h("div", { class: "panel sp-side" }, search, list), card)));
  search.addEventListener("input", () => { st.q = search.value.trim().toLowerCase(); paintList(); });

  const spotBal = (coin) => Number((st.user?.spot || []).find((b) => b.coin === coin)?.total || 0) - Number((st.user?.spot || []).find((b) => b.coin === coin)?.hold || 0);
  const perpUsdc = () => Number(st.user?.withdrawable ?? st.user?.account?.withdrawable ?? 0);

  function paintList() {
    const rows = st.pairs.filter((p) => !st.q || p.label.toLowerCase().includes(st.q)).slice(0, 60);
    clear(list, rows.map((p) => h("button", { class: `sp-row ${st.pair?.pair === p.pair ? "on" : ""}`, type: "button", onclick: () => pick(p) },
      coinIcon(`${p.base}_spot`, "sm"), h("span", { class: "sp-row-n" }, h("b", {}, p.label), h("small", {}, `Vol ${usd(p.volumeUsd, { compact: true })}`)),
      h("span", { class: "sp-row-p" }, h("b", {}, `$${tiny(p.mark)}`), pctEl(p.change24h)))),
      rows.length ? null : h("p", { class: "muted", style: { padding: "12px" } }, "No pair matches."));
  }
  async function pick(p) {
    st.pair = p; st.amount = ""; st.book = null;
    paintList(); paint(); loadBook();
  }
  async function loadUser() {
    if (!wallet.address) { st.user = null; st.key = null; return paint(); }
    try { st.user = await api.get(`hl/user?address=${wallet.address}`); } catch { st.user = null; }
    try { st.key = await tradingKeyStatus(wallet.address); } catch { st.key = null; }
    if (alive) paint();
  }
  async function loadBook() {
    if (!st.pair) return;
    const at = st.pair.pair;
    try { const b = await api.get(`hl/book?coin=${encodeURIComponent(st.pair.pair)}`); if (st.pair?.pair === at) { st.book = b; paint(); } } catch {}
  }

  // walk the book: what does this size actually fill at?
  function fillEstimate() {
    const amt = Number(st.amount);
    if (!st.book || !(amt > 0)) return null;
    const levels = st.side === "buy" ? st.book.asks : st.book.bids;
    let left = amt, cost = 0, got = 0;
    for (const lv of levels) {
      if (st.side === "buy") { const take = Math.min(left, lv.px * lv.sz); got += take / lv.px; cost += take; left -= take; }
      else { const take = Math.min(left, lv.sz); got += take * lv.px; cost += take; left -= take; }
      if (left <= 1e-12) break;
    }
    const filledAll = left <= 1e-9;
    const avg = st.side === "buy" ? (got > 0 ? cost / got : null) : (cost > 0 ? got / cost : null);
    const mid = st.book.bids[0] && st.book.asks[0] ? (st.book.bids[0].px + st.book.asks[0].px) / 2 : st.pair.mid;
    const impact = avg && mid ? Math.abs(avg / mid - 1) : null;
    return { avg, impact, filledAll, receive: st.side === "buy" ? got : got, mid };
  }

  function gateChecks(est) {
    const p = st.pair, b = st.book, out = [];
    const vol = p.volumeUsd || 0;
    out.push({ s: p.canonical || vol >= 1_000_000 ? "pass" : "warn", l: "Pair", d: p.canonical ? "A canonical Hyperliquid spot pair" : vol >= 1_000_000 ? `Listed on Hyperliquid spot, ${usd(vol, { compact: true })} traded today` : "A permissionless spot pair with little trading: check the token before buying" });
    out.push({ s: (p.volumeUsd || 0) >= 50000 ? "pass" : (p.volumeUsd || 0) >= 5000 ? "warn" : "fail", l: "24h volume", d: usd(p.volumeUsd || 0, { compact: true }) });
    if (b?.bids?.[0] && b?.asks?.[0]) {
      const spread = (b.asks[0].px - b.bids[0].px) / ((b.asks[0].px + b.bids[0].px) / 2);
      out.push({ s: spread <= 0.005 ? "pass" : spread <= 0.02 ? "warn" : "fail", l: "Spread", d: `${(spread * 100).toFixed(2)}%` });
    } else out.push({ s: "fail", l: "Order book", d: "No bids or asks right now" });
    if (est) {
      out.push({ s: !est.filledAll ? "fail" : est.impact > 0.05 ? "fail" : est.impact > 0.01 ? "warn" : "pass", l: "Your size", d: !est.filledAll ? "The visible book cannot fill this size" : `Fills at about $${tiny(est.avg)} (${(est.impact * 100).toFixed(2)}% from mid)` });
      // Hyperliquid refuses orders worth less than $10
      const value = st.side === "buy" ? Number(st.amount) : Number(st.amount) * (est.avg || 0);
      if (value < 10) out.push({ s: "fail", l: "Order size", d: `Hyperliquid's minimum order is $10 (this one is about $${tiny(value)})` });
    }
    return out;
  }

  function paint() {
    if (!st.pair) { clear(card, h("p", { class: "muted" }, "Pick a pair on the left.")); return; }
    const p = st.pair, est = fillEstimate();
    const usdc = spotBal("USDC"), baseBal = spotBal(p.base);
    const input = h("input", { class: "input sp-amt", inputmode: "decimal", placeholder: "0", value: st.amount, "aria-label": st.side === "buy" ? "USDC to spend" : `${p.base} to sell` });
    input.addEventListener("input", () => { st.amount = input.value.replace(/,/g, ".").replace(/[^\d.]/g, ""); const pos = input.selectionStart; paint(); const ni = card.querySelector(".sp-amt"); ni.focus(); ni.setSelectionRange(pos, pos); });
    const bal = st.side === "buy" ? usdc : baseBal;
    // a sell can only be a multiple of the coin's step (10^-szDecimals): cut to it so Max shows what really sells
    const step = st.side === "sell" ? 10 ** p.szDecimals : 1e6;
    const chips = wallet.address && bal > 0 ? [25, 50, 75, 100].map((x) => h("button", { class: "chip", type: "button", onclick: () => { st.amount = String(Math.floor(bal * x / 100 * step + 1e-9) / step); paint(); } }, x === 100 ? "Max" : `${x}%`)) : [];
    const dust = st.side === "sell" && bal > 0 ? bal - Math.floor(bal * 10 ** p.szDecimals + 1e-9) / 10 ** p.szDecimals : 0;
    const checks = gateChecks(est), blocked = checks.some((c) => c.s === "fail");
    const keyOk = st.key?.state === "approved";
    // show the transfer as soon as spot is short (not only after typing an amount)
    const needUsdc = !st.user?.unified && st.side === "buy" && perpUsdc() > 0 && (Number(st.amount) > usdc || usdc < 10);
    let btn;
    if (!wallet.address) btn = h("button", { class: "btn primary big", type: "button", onclick: () => openConnect() }, "Connect wallet");
    else if (!keyOk) btn = h("button", { class: "btn primary big", type: "button", onclick: enable }, icon("key"), "Enable trading (one signature)");
    else if (!st.live) btn = h("button", { class: "btn primary big", type: "button", disabled: true }, "Spot orders open after their real-money test, very soon");
    else btn = h("button", { class: "btn primary big", type: "button", disabled: st.busy || blocked || !(Number(st.amount) > 0) || Number(st.amount) > bal, onclick: order },
      st.busy || (blocked ? "Blocked by the Spot Gate" : Number(st.amount) > bal ? `Not enough ${st.side === "buy" ? "USDC in spot" : p.base}` : `${st.side === "buy" ? "Buy" : "Sell"} ${p.base}`));
    clear(card,
      h("div", { class: "sp-head" }, coinIcon(`${p.base}_spot`), h("div", {}, h("b", {}, p.label), h("small", {}, `$${tiny(p.mark)} · `, pctEl(p.change24h))),
        h("a", { class: "link fine", href: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(p.pair)}`, target: "_blank", rel: "noopener" }, "On Hyperliquid")),
      // the user's Hyperliquid USDC: move between spot and perps, or take it home to the same address on Arbitrum
      wallet.address && st.user && st.user.unified ? h("div", { class: "sp-acct" },
        h("span", {}, "Unified account ", h("b", {}, `${tiny(spotBal("USDC"))} USDC`), " for spot, perps and trade.xyz at once"),
        perpUsdc() > 1 ? h("button", { class: "btn sm", type: "button", onclick: withdrawHome, title: "To your own address on Arbitrum; Hyperliquid keeps 1 USDC as the fee" }, "Withdraw to my wallet") : null)
      : wallet.address && st.user ? h("div", { class: "sp-acct" },
        h("span", {}, "Perps ", h("b", {}, `${tiny(perpUsdc())} USDC`)), h("span", {}, "Spot ", h("b", {}, `${tiny(spotBal("USDC"))} USDC`)),
        spotBal("USDC") > 0 ? h("button", { class: "btn sm", type: "button", onclick: moveToPerps }, "Move to perps") : null,
        perpUsdc() > 1 ? h("button", { class: "btn sm", type: "button", onclick: withdrawHome, title: "To your own address on Arbitrum; Hyperliquid keeps 1 USDC as the fee" }, "Withdraw to my wallet") : null) : null,
      seg([{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }], st.side, (v) => { st.side = v; st.amount = ""; paint(); }, "sp-seg"),
      h("div", { class: "sp-leg" }, h("div", { class: "sp-leg-top" }, h("span", {}, st.side === "buy" ? "Spend (USDC)" : `Sell (${p.base})`),
        wallet.address ? h("span", { class: "muted" }, `Spot balance ${tiny(bal)} ${st.side === "buy" ? "USDC" : p.base}`) : null), input, h("div", { class: "sw-quick" }, chips),
        dust > 1e-12 ? h("small", { class: "muted" }, `${p.base} sells in steps of ${10 ** -p.szDecimals}; ${tiny(dust)} ${p.base} stays in your account until it adds up to a full step.`) : null),
      est ? h("div", { class: "rows" },
        h("div", {}, h("span", {}, "You receive (est.)"), h("span", {}, `${tiny(est.receive)} ${st.side === "buy" ? p.base : "USDC"}`)),
        h("div", {}, h("span", {}, "Price cap"), h("span", {}, `1% from the price at sending`)),
        h("div", {}, h("span", {}, "Fees"), h("span", {}, "Hyperliquid's spot fee, shown in your fills"))) : null,
      h("div", { class: "gate-box" }, h("div", { class: "gh" }, icon("shield"), "Spot Gate", h("span", { class: `badge-s ${blocked ? "down" : "blue"}` }, st.book ? (blocked ? "Blocked" : "Passed") : "Reading the book…")),
        h("ul", {}, checks.map((c) => h("li", { class: c.s }, h("span", {}, c.l), h("b", {}, c.d))))),
      needUsdc ? h("div", { class: "alert warn" }, `Your USDC is in the perps account (${tiny(perpUsdc())} USDC). Move some to spot first. `,
        h("button", { class: "btn sm", type: "button", onclick: moveUsdc }, "Move USDC to spot")) : null,
      btn,
      h("p", { class: "note" }, "Needs USDC in your Hyperliquid spot account. No USDC on Hyperliquid yet? ", h("a", { class: "link", href: "#/bridge?dir=hl" }, "Fund Hyperliquid"), " from Robinhood Chain in one transaction."));
  }

  async function enable() {
    try { await ensureChain("arbitrum"); await approveTradingKey(wallet.address, wallet.eip); toast("Trading enabled for Perps and Spot", "ok"); await loadUser(); }
    catch (e) { toast(e.message || "Could not enable trading", "error", 6000); }
  }
  async function withdrawHome() {
    const amt = Math.floor(perpUsdc() * 1e6) / 1e6;
    try {
      await ensureChain("arbitrum");
      await withdrawUsdc(wallet.address, wallet.eip, amt);
      toast(`Withdrawing ${tiny(amt)} USDC to your wallet on Arbitrum (about ${tiny(amt - 1)} after Hyperliquid's 1 USDC fee). It usually lands within a few minutes.`, "ok", 9000);
      await loadUser();
    } catch (e) { toast(e.message || "The withdrawal failed", "error", 7000); }
  }
  // all spot USDC back to the perps (main) account, one signature, no gas
  async function moveToPerps() {
    const amt = Math.floor(spotBal("USDC") * 1e6) / 1e6;
    if (!(amt > 0)) return toast("No USDC in the spot account.", "");
    try { await ensureChain("arbitrum"); await transferUsdClass(wallet.address, wallet.eip, amt, true); toast(`Moved ${tiny(amt)} USDC to perps`, "ok"); await loadUser(); }
    catch (e) { toast(e.message || "The transfer failed", "error", 6000); }
  }
  async function moveUsdc() {
    const need = Math.max(0, Number(st.amount) - spotBal("USDC"));
    const amt = Math.min(perpUsdc(), Math.ceil(need * 100) / 100 || perpUsdc());
    try { await ensureChain("arbitrum"); await transferUsdClass(wallet.address, wallet.eip, amt, false); toast(`Moved ${tiny(amt)} USDC to spot`, "ok"); await loadUser(); }
    catch (e) { toast(e.message || "The transfer failed", "error", 6000); }
  }
  async function order() {
    const p = st.pair, amt = Number(st.amount);
    st.busy = "Reading the book again…"; paint();
    await loadBook();
    const est = fillEstimate();
    if (!est || gateChecks(est).some((c) => c.s === "fail")) { st.busy = false; paint(); return toast("The Spot Gate blocked this order on the latest book.", "error", 6000); }
    st.busy = "Sending…"; paint();
    try {
      const size = st.side === "buy" ? amt / (est.avg * (1 + SLIP)) : amt;  // a buy is sized so it can't spend more than you typed
      const r = await placeSpotOrder({ owner: wallet.address, pair: { ...p, mid: est.mid }, isBuy: st.side === "buy", size, slippage: SLIP });
      const ok = /filled/.test(r.text);
      toast(ok ? `${st.side === "buy" ? "Bought" : "Sold"} ${p.base}: ${r.text}` : `Not filled: ${r.text}`, ok ? "ok" : "error", 7000);
      if (ok) st.amount = "";
    } catch (e) { toast(e.message || "The order failed", "error", 7000); }
    st.busy = false;
    await loadUser(); loadBook();
  }

  try {
    const d = await api.get("market/hl/spot");
    st.pairs = (d.pairs || []).filter((p) => p.asset != null && p.mark > 0).sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0));
  } catch (e) { clear(list, h("p", { class: "muted" }, "Spot markets are unavailable right now.")); }
  const want = String(ctx.query.pair || ctx.parts?.[0] || "").toUpperCase();
  st.pair = st.pairs.find((p) => p.label.toUpperCase() === want || p.base?.toUpperCase() === want || p.pair === want) || st.pairs[0] || null;
  paintList(); paint(); loadBook(); loadUser();
  const off = onWallet(() => loadUser());
  const t = setInterval(() => { if (alive && !st.busy) loadBook(); }, 6000);
  return () => { alive = false; off(); clearInterval(t); };
}
