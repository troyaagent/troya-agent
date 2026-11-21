// Spot on Hyperliquid (F12): buy and sell Hyperliquid spot pairs (HYPE, UBTC, UETH, PURR …) from the user's own Hyperliquid
// account with the same trade-only key the Perps page uses. A Spot Gate reads the live order book before every order:
// the pair, 24h volume, the spread, and what your size would actually fill at. Orders are IOC with a 1% price cap, so a
// thin book can never fill you worse than that, and every order and withdrawal opens a review before anything is signed.
// USDC can be moved between the perps and spot accounts with one signature.
import { h, clear, icon, useCss, toast, tiny, num, usd, price, pctEl, coinIcon, seg, pageHead, short, modal, review } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, ensureChain } from "/agent/js/wallet.js";
import { tradingKeyStatus, approveTradingKey, placeSpotOrder, transferUsdClass, withdrawUsdc, roundSz, roundPx } from "/agent/js/hl.js";

const SLIP = 0.01;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";   // native USDC on Arbitrum: what a Hyperliquid withdrawal pays out

// typed amounts: a comma counts as the decimal point, anything else that is not a digit is dropped
const cleanNum = (s) => String(s).replace(/,/g, ".").replace(/[^\d.]/g, "");
// clean an amount field in place without throwing the caret to the end
function cleanField(el) {
  const raw = el.value, v = cleanNum(raw);
  if (v !== raw) {
    const pos = cleanNum(raw.slice(0, el.selectionStart ?? raw.length)).length;
    el.value = v;
    try { el.setSelectionRange(pos, pos); } catch {}
  }
  return v;
}
// an order size exactly as it is sent, to the coin's own step (tiny() cuts 0.37 to 0.3699 through its float digits)
const fmtSz = (v, szDecimals) => Number(v).toLocaleString("en-US", { maximumFractionDigits: szDecimals });
// one part of the card, swapped in place: the card is never rebuilt, so the amount field keeps focus while the book refreshes
function slot() {
  let node = document.createComment("");
  return { get node() { return node; }, set(el) { const next = el || document.createComment(""); if (node.parentNode) node.replaceWith(next); node = next; } };
}

export async function mount(view, ctx) {
  useCss("perps");
  let alive = true;
  const st = { pairs: [], pair: null, side: "buy", amount: "", user: null, key: null, book: null, busy: false, q: "", live: false, wd: false };
  // orders open after the real-money test; until then the page shows prices, balances and the Spot Gate
  api.get("features").then((f) => { st.live = !!f.spot; paintLive(); }).catch(() => {});

  const list = h("div", { class: "sp-list" });
  const search = h("input", { class: "input", placeholder: "Search HYPE, UBTC, PURR…", "aria-label": "Search spot pairs", autocomplete: "off" });
  const card = h("div", { class: "panel sp-card" });
  clear(view, h("div", { class: "dk sp" },
    pageHead("Spot on Hyperliquid", "Buy and sell Hyperliquid spot coins from your own Hyperliquid account. The Spot Gate reads the order book first; orders never fill more than 1% from the price you see."),
    h("div", { class: "sp-grid" }, h("div", { class: "panel sp-side" }, search, list), card)));
  search.addEventListener("input", () => { st.q = search.value.trim().toLowerCase(); paintList(); });

  const spotBal = (coin) => Number((st.user?.spot || []).find((b) => b.coin === coin)?.total || 0) - Number((st.user?.spot || []).find((b) => b.coin === coin)?.hold || 0);
  const perpUsdc = () => Number(st.user?.withdrawable ?? st.user?.account?.withdrawable ?? 0);
  const sideBal = () => (st.side === "buy" ? spotBal("USDC") : spotBal(st.pair?.base));

  // the parts of the card that never get re-created: the amount field (focus, caret, phone keyboard), the Buy/Sell
  // switch and the main button; everything else sits in slots that are swapped in place
  const amtIn = h("input", { class: "input sp-amt", inputmode: "decimal", placeholder: "0", autocomplete: "off", "aria-label": "USDC to spend" });
  amtIn.addEventListener("input", () => { st.amount = cleanField(amtIn); paintLive(); });
  const sideSeg = seg([{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }], st.side, (v) => { st.side = v; st.amount = ""; paint(); }, "sp-seg");
  let btnAct = null;
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => btnAct?.() });
  const note = h("p", { class: "note" }, "Needs USDC in your Hyperliquid spot account. No USDC on Hyperliquid yet? ", h("a", { class: "link", href: "#/bridge?dir=hl" }, "Fund Hyperliquid"), " from Robinhood Chain in one transaction.");
  const headS = slot(), acctS = slot(), legTopS = slot(), chipsS = slot(), dustS = slot(), estS = slot(), gateS = slot(), alertS = slot();
  const leg = h("div", { class: "sp-leg" }, legTopS.node, amtIn, chipsS.node, dustS.node);
  const ensureCard = () => { if (leg.parentNode !== card) clear(card, headS.node, acctS.node, sideSeg, leg, estS.node, gateS.node, alertS.node, btn, note); };

  function paintList() {
    const rows = st.pairs.filter((p) => !st.q || p.label.toLowerCase().includes(st.q)).slice(0, 60);
    clear(list, rows.map((p) => h("button", { class: `sp-row ${st.pair?.pair === p.pair ? "on" : ""}`, type: "button", onclick: () => pick(p) },
      coinIcon(`${p.base}_spot`, "sm"), h("span", { class: "sp-row-n" }, h("b", {}, p.label), h("small", {}, `Vol ${usd(p.volumeUsd, { compact: true })}`)),
      h("span", { class: "sp-row-p" }, h("b", {}, `$${price(p.mark)}`), pctEl(p.change24h)))),
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
  // true only when a fresh book for the current pair arrived: an order never goes out on a book that failed to reload
  async function loadBook() {
    if (!st.pair) return false;
    const at = st.pair.pair;
    try {
      const b = await api.get(`hl/book?coin=${encodeURIComponent(at)}`);
      if (!alive || st.pair?.pair !== at) return false;
      st.book = b; paintLive();
      return true;
    } catch { return false; }
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
    return { avg, impact, filledAll, receive: got, mid };
  }
  // the order that would really be sent, worked out the same way placeSpotOrder does it: a buy is sized so the 1% cap
  // can never spend more than the amount typed, so it buys about 1% less than the whole amount would at the average fill
  function plan(est) {
    const p = st.pair, amt = Number(st.amount), buy = st.side === "buy";
    if (!est || !(est.avg > 0) || !(est.mid > 0)) return null;
    const rawSize = buy ? amt / (est.avg * (1 + SLIP)) : amt;
    const size = roundSz(rawSize, p.szDecimals);
    let cap;
    try { cap = roundPx(est.mid * (buy ? 1 + SLIP : 1 - SLIP), p.szDecimals, 8); } catch { return null; }
    return { rawSize, size, cap, value: size * est.avg, bound: size * cap };
  }

  function gateChecks(est) {
    const p = st.pair, b = st.book, out = [];
    const vol = p.volumeUsd || 0;
    out.push({ s: p.canonical || vol >= 1_000_000 ? "pass" : "warn", l: "Pair", d: p.canonical ? "A canonical Hyperliquid spot pair" : vol >= 1_000_000 ? `Listed on Hyperliquid spot, ${usd(vol, { compact: true })} traded today` : "A permissionless spot pair with little trading: check the token before buying" });
    out.push({ s: (p.volumeUsd || 0) >= 50000 ? "pass" : (p.volumeUsd || 0) >= 5000 ? "warn" : "fail", l: "24h volume", d: usd(p.volumeUsd || 0, { compact: true }) });
    if (b?.bids?.[0] && b?.asks?.[0]) {
      const spread = (b.asks[0].px - b.bids[0].px) / ((b.asks[0].px + b.bids[0].px) / 2);
      // a deep pair's spread is a few thousandths of a percent: never round it down to a misleading 0.00%
      out.push({ s: spread <= 0.005 ? "pass" : spread <= 0.02 ? "warn" : "fail", l: "Spread", d: spread < 0.0001 ? "under 0.01%" : `${(spread * 100).toFixed(spread < 0.001 ? 3 : 2)}%` });
    } else out.push({ s: "fail", l: "Order book", d: "No bids or asks right now" });
    if (est) {
      out.push({ s: !est.filledAll ? "fail" : est.impact > 0.05 ? "fail" : est.impact > 0.01 ? "warn" : "pass", l: "Your size", d: !est.filledAll ? "The visible book cannot fill this size" : `Fills at about $${price(est.avg)} (${(est.impact * 100).toFixed(2)}% from mid)` });
      // Hyperliquid refuses orders worth less than $10; judged on the order really sent (a buy keeps 1% aside for the cap)
      const pl = plan(est);
      if (pl && pl.value < 10) out.push({ s: "fail", l: "Order size", d: `Hyperliquid's minimum order is $10 (this one is about $${tiny(pl.value)}${st.side === "buy" ? " after 1% is kept aside for the price cap" : ""})` });
    }
    return out;
  }

  // everything on the card; called when the pair, the side, the wallet or the balances change
  function paint() {
    if (!st.pair) { clear(card, h("p", { class: "muted" }, "Pick a pair on the left.")); return; }
    ensureCard();
    const p = st.pair, usdc = spotBal("USDC"), bal = sideBal();
    headS.set(h("div", { class: "sp-head" }, coinIcon(`${p.base}_spot`), h("div", {}, h("b", {}, p.label), h("small", {}, `$${price(p.mark)} · `, pctEl(p.change24h))),
      h("a", { class: "link fine", href: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(p.pair)}`, target: "_blank", rel: "noopener" }, "On Hyperliquid")));
    // the user's Hyperliquid USDC: move between spot and perps, or take it home to the same address on Arbitrum
    const wdBtn = perpUsdc() > 1 ? h("button", { class: "btn sm", type: "button", onclick: withdrawHome }, "Withdraw to my wallet") : null;
    acctS.set(wallet.address && st.user && st.user.unified ? h("div", { class: "sp-acct" },
        h("span", {}, "Unified account ", h("b", {}, `${tiny(usdc)} USDC`), " for spot, perps and trade.xyz at once"), wdBtn)
      : wallet.address && st.user ? h("div", { class: "sp-acct" },
        h("span", {}, "Perps ", h("b", {}, `${tiny(perpUsdc())} USDC`)), h("span", {}, "Spot ", h("b", {}, `${tiny(usdc)} USDC`)),
        usdc > 0 ? h("button", { class: "btn sm", type: "button", onclick: moveToPerps }, "Move to perps") : null, wdBtn) : null);
    if (sideSeg.get() !== st.side) sideSeg.set(st.side);
    legTopS.set(h("div", { class: "sp-leg-top" }, h("span", {}, st.side === "buy" ? "Spend (USDC)" : `Sell (${p.base})`),
      wallet.address ? h("span", { class: "muted" }, `Spot balance ${tiny(bal)} ${st.side === "buy" ? "USDC" : p.base}`) : null));
    amtIn.setAttribute("aria-label", st.side === "buy" ? "USDC to spend" : `${p.base} to sell`);
    // a sell can only be a multiple of the coin's step (10^-szDecimals): cut to it so Max shows what really sells
    const step = st.side === "sell" ? 10 ** p.szDecimals : 1e6;
    chipsS.set(h("div", { class: "sw-quick" }, wallet.address && bal > 0 ? [25, 50, 75, 100].map((x) => h("button", { class: "chip", type: "button",
      onclick: () => { st.amount = String(Math.floor(sideBal() * x / 100 * step + 1e-9) / step); paintLive(); } }, x === 100 ? "Max" : `${x}%`)) : []));
    const dust = st.side === "sell" && bal > 0 ? bal - Math.floor(bal * 10 ** p.szDecimals + 1e-9) / 10 ** p.szDecimals : 0;
    dustS.set(dust > 1e-12 ? h("small", { class: "muted" }, `${p.base} sells in steps of ${10 ** -p.szDecimals}; ${tiny(dust)} ${p.base} stays in your account until it adds up to a full step.`) : null);
    paintLive();
  }

  // only what moves with the amount and the book: the estimate, the Gate, the transfer hint and the button.
  // The amount field is left alone (its value is only written when it differs, e.g. after Max or a filled order).
  function paintLive() {
    if (!st.pair || leg.parentNode !== card) return paint();
    if (amtIn.value !== st.amount) amtIn.value = st.amount;
    const p = st.pair, amt = Number(st.amount), est = fillEstimate(), pl = plan(est);
    const usdc = spotBal("USDC"), bal = sideBal(), buy = st.side === "buy";
    const checks = gateChecks(est), blocked = checks.some((c) => c.s === "fail");
    estS.set(est ? h("div", { class: "rows" },
      h("div", {}, h("span", {}, "You receive (est.)"), h("span", {}, buy ? (pl ? `${fmtSz(pl.size, p.szDecimals)} ${p.base}` : "–") : `${tiny(est.receive)} USDC`)),
      h("div", {}, h("span", {}, buy ? "Price cap" : "Price floor"), h("span", {}, pl ? `$${price(pl.cap)}, 1% ${buy ? "above" : "below"} mid` : "1% from the price at sending")),
      h("div", {}, h("span", {}, "Fees"), h("span", {}, "Hyperliquid's spot fee, shown in your fills"))) : null);
    // like the Swap and Perps Gates: a verdict only once there is an amount to check
    const waiting = !(amt > 0);
    const verdict = !st.book ? "Reading the book…" : blocked ? "Blocked" : waiting ? "Waiting" : "Passed";
    gateS.set(h("div", { class: "gate-box" }, h("div", { class: "gh" }, icon("shield"), "Spot Gate",
      h("span", { class: `badge-s ${!st.book || (waiting && !blocked) ? "" : blocked ? "down" : "blue"}` }, verdict)),
      h("ul", {}, checks.map((c) => h("li", { class: c.s }, h("span", {}, c.l), h("b", {}, c.d))))));
    // show the transfer as soon as spot is short (not only after typing an amount)
    const needUsdc = !st.user?.unified && buy && perpUsdc() > 0 && (amt > usdc || usdc < 10);
    alertS.set(needUsdc ? h("div", { class: "alert warn" }, `Your USDC is in the perps account (${tiny(perpUsdc())} USDC). Move some to spot first. `,
      h("button", { class: "btn sm", type: "button", onclick: moveUsdc }, "Move USDC to spot")) : null);
    // the main button is updated in place, so a keyboard user's focus survives the refresh too
    const keyOk = st.key?.state === "approved";
    let kids, act = null, off = false;
    if (!wallet.address) { kids = ["Connect wallet"]; act = () => openConnect(); }
    else if (!keyOk) { kids = [icon("key"), "Enable trading (one signature)"]; act = enable; }
    else if (!st.live) { kids = ["Spot orders open after their real-money test, very soon"]; off = true; }
    else {
      off = !!st.busy || blocked || !(amt > 0) || amt > bal; act = order;
      kids = [st.busy || (blocked ? "Blocked by the Spot Gate" : amt > bal ? `Not enough ${buy ? "USDC in spot" : p.base}` : `${buy ? "Buy" : "Sell"} ${p.base}`)];
    }
    btnAct = off ? null : act;
    btn.disabled = off;
    clear(btn, kids);
  }

  async function enable() {
    try { await ensureChain("arbitrum"); await approveTradingKey(wallet.address, wallet.eip); toast("Trading enabled for Perps and Spot", "ok"); await loadUser(); }
    catch (e) { toast(e.message || "Could not enable trading", "error", 6000); }
  }
  // Withdraw: the user chooses the amount and sees the network, the fee and the way back before anything is signed.
  // The destination is always the signer's own address (withdrawUsdc sends to the owner, never anywhere else).
  async function withdrawHome() {
    if (st.wd || !wallet.address) return;     // one withdraw dialog at a time
    const owner = wallet.address;
    st.wd = true;
    try { const u = await api.get(`hl/user?address=${owner}`); if (u && wallet.address === owner) st.user = u; } catch {}   // the latest withdrawable, not the one from page load
    if (!alive || wallet.address !== owner) { st.wd = false; return; }
    const max = Math.floor(perpUsdc() * 1e6) / 1e6;
    if (!(max > 1)) { st.wd = false; paint(); return toast("Nothing to withdraw yet: a Hyperliquid withdrawal must be above its 1 USDC fee.", "", 6000); }
    let busy = false;
    const amtW = h("input", { class: "input", inputmode: "decimal", placeholder: "0", autocomplete: "off", "aria-label": "USDC to withdraw" });
    const maxBtn = h("button", { class: "chip", type: "button", onclick: () => { amtW.value = String(max); upd(); } }, "Max");
    const hint = h("small", { class: "muted", "aria-live": "polite" });
    const gets = h("span", {}, "–");
    const go = h("button", { class: "btn primary", type: "button", disabled: true, onclick: send }, "Sign withdrawal");
    const want = () => Math.floor(Number(amtW.value) * 1e6) / 1e6;   // withdrawUsdc sends 6 decimals at most
    function upd() {
      const v = cleanField(amtW), a = want();
      gets.textContent = a > 1 ? `about ${tiny(Math.min(a, max) - 1)} USDC` : "–";
      hint.textContent = !v ? "" : !(a > 1) ? "Withdrawals must be above 1 USDC, Hyperliquid's fee." : a > max ? `You can withdraw up to ${tiny(max)} USDC.` : "";
      go.disabled = busy || !(a > 1 && a <= max);
    }
    amtW.addEventListener("input", upd);
    const swapBack = `#/swap?chain=arbitrum&in=${ARB_USDC}&out=ETH`;
    const body = h("div", {},
      h("label", { class: "field" }, h("span", {}, `Amount (USDC) · ${tiny(max)} withdrawable now`), h("div", { class: "row", style: { gap: "6px" } }, amtW, maxBtn)),
      hint,
      h("div", { class: "rows" },
        h("div", {}, h("span", {}, "From"), h("span", {}, "Your Hyperliquid account")),
        h("div", {}, h("span", {}, "To (your own address)"), h("span", { class: "mono" }, short(owner, 6))),
        h("div", {}, h("span", {}, "Destination"), h("span", {}, "Arbitrum, as USDC")),
        h("div", {}, h("span", {}, "Hyperliquid fee"), h("span", {}, "1 USDC")),
        h("div", {}, h("span", {}, "You receive (est.)"), gets),
        h("div", {}, h("span", {}, "Arrives"), h("span", {}, "usually within a few minutes"))),
      h("p", { class: "note" }, "Back to Robinhood Chain: ", h("a", { class: "link", href: swapBack }, "swap the USDC to ETH on Arbitrum"),
        ", then ", h("a", { class: "link", href: "#/bridge?dir=in&chain=arbitrum" }, "bridge the ETH to Robinhood Chain"), ". Both need a little ETH on Arbitrum for gas."),
      h("div", { class: "row", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Cancel"), go));
    const m = modal({ title: "Withdraw USDC to Arbitrum", body, onClose: () => { st.wd = false; } });
    setTimeout(() => amtW.focus(), 40);   // the dialog is about the amount: start there (modal() focuses its close button first)
    async function send() {
      const a = want();
      if (busy || !(a > 1 && a <= max)) return upd();
      if (wallet.address !== owner) { m.close(); return toast("Your wallet changed. Open Withdraw again.", "", 6000); }
      busy = true; go.disabled = true; amtW.disabled = true; maxBtn.disabled = true; clear(go, "Confirm in your wallet…");
      try {
        await ensureChain("arbitrum");
        await withdrawUsdc(owner, wallet.eip, a);
        m.close();
        toast(`Withdrawing ${tiny(a)} USDC to your wallet on Arbitrum (about ${tiny(a - 1)} after Hyperliquid's 1 USDC fee). It usually lands within a few minutes.`, "ok", 9000);
        await loadUser();
      } catch (e) {
        toast(e.message || "The withdrawal failed", "error", 7000);
        busy = false; amtW.disabled = false; maxBtn.disabled = false; clear(go, "Sign withdrawal"); upd();
      }
    }
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
  // fresh book → Spot Gate → review → order. The review shows the exact order: size, estimated fill, price cap and
  // what you spend or receive; the cap is anchored to the price in the review, so nothing fills worse than what was shown.
  async function order() {
    const p = st.pair, side = st.side, amt = Number(st.amount), owner = wallet.address, buy = side === "buy";
    const same = () => alive && st.pair === p && st.side === side && Number(st.amount) === amt && wallet.address === owner;
    const stop = (msg, kind = "error") => { st.busy = false; paintLive(); if (msg) toast(msg, kind, 6000); };
    st.busy = "Reading the book again…"; paintLive();
    const fresh = await loadBook();
    if (!same()) return stop(null);
    if (!fresh) return stop("Could not read the order book again. Try once more.");
    const est = fillEstimate(), pl = plan(est), checks = gateChecks(est);
    if (!est || !pl || checks.some((c) => c.s === "fail")) return stop("The Spot Gate blocked this order on the latest book.");
    st.busy = "Review the order…"; paintLive();
    const warns = checks.filter((c) => c.s === "warn");
    const ok = await review({
      title: `${buy ? "Buy" : "Sell"} ${p.base}`,
      summary: buy ? `Spend up to ${tiny(amt)} USDC from your Hyperliquid spot account.` : `Sell ${fmtSz(pl.size, p.szDecimals)} ${p.base} from your Hyperliquid spot account.`,
      rows: [
        ["Pair", p.label],
        ["Order", `${buy ? "Buy" : "Sell"} ${fmtSz(pl.size, p.szDecimals)} ${p.base}, immediate or cancel`],
        ["Est. fill", `$${price(est.avg)} (${(est.impact * 100).toFixed(2)}% from mid)`],
        // the exact limit price that is signed (Hyperliquid prices have at most 5 significant digits), not a rounded one
        [buy ? "Price cap" : "Price floor", `$${pl.cap.toLocaleString("en-US", { maximumSignificantDigits: 8 })}, 1% ${buy ? "above" : "below"} mid $${price(est.mid)}`],
        buy ? ["You spend (est.)", `${tiny(pl.value)} USDC, at most ${tiny(Math.min(pl.bound, amt))}`] : ["You receive (est.)", `${tiny(pl.value)} USDC`],
        buy ? ["You receive (est.)", `${fmtSz(pl.size, p.szDecimals)} ${p.base}`] : null,
        ["Fees", "Hyperliquid's spot fee, shown in your fills"],
        ["Account", short(owner, 6)],
      ],
      extra: h("p", { class: "note" }, `Immediate or cancel: whatever cannot fill inside the price ${buy ? "cap" : "floor"} is cancelled, never left open on the book.`),
      warn: warns.length ? warns.map((c) => `${c.l}: ${c.d}`).join(" · ") : null,
      confirmLabel: `${buy ? "Buy" : "Sell"} ${p.base}`,
    });
    if (!ok) return stop(null);
    // the review covers the page, but a wallet switch or a keyboard user can still change the order behind it
    if (!same()) return stop("The order changed while the review was open. Check it and try again.", "");
    st.busy = "Sending…"; paintLive();
    try {
      // a buy is sized so it can't spend more than you typed; the cap is 1% from the mid shown in the review
      const r = await placeSpotOrder({ owner, pair: { ...p, mid: est.mid }, isBuy: buy, size: pl.rawSize, slippage: SLIP });
      const filled = /filled/.test(r.text);
      toast(filled ? `${buy ? "Bought" : "Sold"} ${p.base}: ${r.text}` : `Not filled: ${r.text}`, filled ? "ok" : "error", 7000);
      if (filled && st.pair === p) st.amount = "";
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
  // a hidden tab does not poll Hyperliquid; the order path reads the book again on its own before sending
  const t = setInterval(() => { if (document.hidden) return; if (alive && !st.busy) loadBook(); }, 6000);
  return () => { alive = false; off(); clearInterval(t); };
}
