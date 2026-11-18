// F17 · Stock desk: Robinhood stock tokens on Robinhood Chain.
//   Stocks             every token with its price and the multiplier that dividends and splits move
//   Dividends & splits the corporate actions calendar from Robinhood's stock token API
//   Baskets            several stocks in one go: each leg is quoted and checked by Troya Gate, your wallet signs each
//   Borrow             USDG against your stock tokens on Morpho Blue, with health factor, liquidation price and an alert
import { Interface, parseUnits } from "ethers";
import { h, clear, useCss, toast, tiny, usd, price, compact, num, pctEl, pageHead, seg, review, short, tokenIcon, icon } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect } from "/agent/js/wallet.js";
import { balanceOf, sendTx, waitReceipt, errText } from "/agent/js/chain.js";

const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ERC = new Interface(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const MO = new Interface([
  "function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256,uint256)",
  "function repay((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256,uint256)",
  "function withdrawCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, uint256 assets, address onBehalf, address receiver)",
]);
const BASKETS = [
  ["Magnificent 7", ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"]],
  ["Index core", ["SPY", "QQQ"]],
  ["Chips", ["NVDA", "MU", "TSM", "AVGO", "AMD"]],
  ["Dividend payers", ["JNJ", "COST", "UNH", "KO", "PG"]],
];
const SAFE_HEALTH = 1.5, MIN_HEALTH = 1.25;
const MIN_FREE = 100;   // Morpho markets with less USDG than this to lend sit behind "More markets"
// dates as people read them: "Nov 13, 2026" (the API gives a calendar date, so it is read in UTC)
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDate = (d) => { const t = d ? Date.parse(`${d}T00:00:00Z`) : NaN; return isFinite(t) ? DATE.format(t) : "–"; };
// one compact money format for every amount in the market picker: $17.6K, $1.1K, $290
const money = (v) => (v == null || !isFinite(v) ? "–" : v >= 1000 ? `$${compact(v, 1)}` : `$${num(v, v < 10 ? 2 : 0)}`);
const stockIcon = (a, size = "sm") => tokenIcon({ symbol: a.symbol, address: a.address || "" }, size);

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  // one wallet action at a time: a double click must not start the same transaction twice
  let acting = false;
  const guarded = async (fn) => { if (acting) return; acting = true; try { return await fn(); } finally { acting = false; } };
  const st = { tab: ctx.parts[0] || "stocks", desk: null, loans: null, q: "", basket: 0, basketEth: "", busy: null, mkId: null, allMk: false, coll: "", borrow: "", repay: "" };
  const body = h("div", { class: "sd-body" });
  const tabs = h("div", { class: "sd-tabs" });
  clear(view, h("div", { class: "dk sd" },
    pageHead("Stock desk", "Robinhood stock tokens on Robinhood Chain: prices, dividends and splits, baskets in one go, and USDG loans against your stocks on Morpho Blue."),
    tabs, body,
    h("p", { class: "fine lt-legal" }, "Stock tokens are issued by Robinhood Assets (Jersey) Limited and are not offered to US persons. Data from Robinhood's stock token API, DexScreener and Morpho Blue on chain. Not financial advice.")));

  const opts = (xs) => xs.map(([value, label]) => ({ value, label }));
  const paintTabs = () => clear(tabs, seg(opts([["stocks", "Stocks"], ["actions", "Dividends & splits"], ["baskets", "Baskets"], ["borrow", "Borrow"]]), st.tab, (v) => { st.tab = v; history.replaceState(null, "", `#/stocks/${v}`); paint(); }));
  async function load() {
    try { st.desk = await api.get("stocks/desk"); } catch (e) { st.err = e.message; }
    try { st.loans = await api.get(`stocks/loans${wallet.address ? `?address=${wallet.address}` : ""}`); } catch {}
    if (wallet.session) { const w = await api.get("watches").catch(() => null); if (w) st.alerts = new Set(w.items.filter((x) => x.type === "loan_guard" && x.status !== "done").map((x) => x.params.marketId)); }
    if (alive) paint();
  }
  const bySym = (s) => st.desk?.assets.find((a) => a.symbol === s);

  function paint() {
    paintTabs();
    if (!st.desk) return clear(body, st.err ? h("div", { class: "alert error" }, st.err) : h("div", { class: "sk", style: { height: "360px" } }));
    ({ stocks, actions, baskets, borrow })[st.tab]?.();
  }

  /* ---------- stocks ---------- */
  function stocks() {
    const qIn = h("input", { class: "input", placeholder: "Search NVDA, Apple, SPY…", value: st.q, "aria-label": "Search stocks" });
    qIn.addEventListener("input", () => { st.q = qIn.value.trim().toLowerCase(); draw(); qIn.focus(); });
    const tbl = h("div", { class: "sd-tbl" });
    const count = h("span", { class: "sd-count" });
    // every stock (about 200 rows is light), with the count, so nothing is silently left out
    const draw = () => {
      const rows = st.desk.assets.filter((a) => !st.q || a.symbol.toLowerCase().includes(st.q) || a.name.toLowerCase().includes(st.q));
      count.textContent = st.q ? `${rows.length} of ${st.desk.assets.length}` : `${st.desk.assets.length} stocks`;
      clear(tbl, h("div", { class: "sd-row sd-hd" }, h("span", {}, "Stock"), h("span", {}, "Price"), h("span", {}, "24h"), h("span", {}, "Multiplier"), h("span", {}, "")),
      rows.length ? null : h("p", { class: "muted sd-none" }, "No stock matches that search."),
      rows.map((a) => h("div", { class: "sd-row" },
        h("span", { class: "sd-name" }, stockIcon(a), h("b", {}, a.symbol), h("small", {}, a.name)),
        h("span", {}, a.priceUsd ? `$${price(a.priceUsd)}` : h("span", { class: "muted" }, "no pool")), h("span", {}, a.change24h != null ? pctEl(a.change24h) : "–"),
        h("span", { title: "Dividends are reinvested and splits multiply it: each token stands for this many shares" }, `${a.multiplier.toFixed(4)}×`, a.pendingMultiplier ? h("small", { class: "sd-pend" }, ` → ${a.pendingMultiplier.toFixed(4)}× soon`) : null),
        a.priceUsd ? h("a", { class: "btn sm", href: `#/swap?in=eth&out=${a.address}` }, "Buy") : h("span", {}))));
    };
    draw();
    clear(body, h("div", { class: "panel sd-panel" }, h("div", { class: "sd-ph" }, h("h3", {}, "Stocks"), count), h("p", { class: "fine" }, st.desk.note), qIn, tbl));
  }

  /* ---------- dividends & splits ---------- */
  function actions() {
    // coming up = not paid yet and dated today or later (the server marks a past one still in progress as "paying")
    const today = new Date().toISOString().slice(0, 10);
    const up = st.desk.actions.filter((a) => a.status === "upcoming" && (!a.date || a.date >= today)).sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const done = st.desk.actions.filter((a) => !up.includes(a)).sort((x, y) => String(y.date).localeCompare(String(x.date)));
    // $1.47, $0.50, and up to 4 decimals only for a small payment ($0.2544, $0.08)
    const rate = (r) => `$${r >= 0.1 ? r.toFixed(2) : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(r)} per share`;
    const what = (a) => a.type === "dividend" ? (a.dividendPerShare != null ? rate(a.dividendPerShare) : "Amount pending")
      : a.ratio?.[0] && a.ratio?.[1] ? `${a.ratio[0]}-for-${a.ratio[1]} ${a.type}` : `${a.type[0].toUpperCase()}${a.type.slice(1)} · ratio pending`;
    const head = h("div", { class: "sd-row sd-hd" }, h("span", {}, "Stock"), h("span", {}, "Date"), h("span", {}, "Amount"), h("span", {}, "Against the price"), h("span", {}, ""));
    const row = (a) => h("div", { class: "sd-row" },
      h("span", { class: "sd-name" }, stockIcon(a), h("b", {}, a.symbol), h("small", {}, a.type === "dividend" ? "Dividend" : a.type === "reverse split" ? "Reverse split" : "Split")),
      h("span", { class: "sd-date" }, fmtDate(a.date), a.status === "paying" ? h("small", { class: "sd-st" }, "Paying") : a.status === "done" ? h("small", { class: "sd-st done" }, a.type === "dividend" ? "Paid" : "Done") : null),
      h("span", {}, what(a)),
      h("span", { class: "muted" }, a.yieldPct != null ? `≈ ${a.yieldPct.toFixed(2)}% of the price` : "–"),
      a.address ? h("a", { class: "btn sm", href: `#/swap?in=eth&out=${a.address}` }, "Trade") : h("span", {}));
    clear(body, h("div", { class: "panel sd-panel" }, h("h3", {}, `Coming up · ${up.length}`), up.length ? [head, up.map(row)] : h("p", { class: "muted" }, "Nothing scheduled right now.")),
      h("div", { class: "panel sd-panel" }, h("h3", {}, `Recent · ${done.length}`), done.length ? [head.cloneNode(true), done.map(row)] : h("p", { class: "muted" }, "Nothing paid in the last weeks.")));
  }

  /* ---------- baskets ---------- */
  function baskets() {
    const [name, syms] = BASKETS[st.basket];
    const legs = syms.map(bySym).filter((a) => a?.priceUsd && (a.liquidityUsd || 0) > 2000);
    const amtIn = h("input", { class: "input", inputmode: "decimal", placeholder: "ETH to spend", value: st.basketEth, "aria-label": "ETH to spend" });
    amtIn.addEventListener("input", () => { st.basketEth = amtIn.value; });
    const each = Number(st.basketEth) / (legs.length || 1);
    clear(body, h("div", { class: "panel sd-panel" },
      seg(BASKETS.map(([n], i) => ({ value: String(i), label: n })), String(st.basket), (v) => { st.basket = +v; paint(); }),
      h("p", { class: "fine" }, `${name}: equal parts, one swap per stock. Each leg is quoted and checked by Troya Gate before your wallet signs it; a leg that fails the Gate is skipped, the rest go on. Stocks without a deep enough pool are left out.`),
      h("div", { class: "sd-legs" }, legs.map((a) => h("span", { class: "chip-s" }, stockIcon(a, "xs"), h("b", {}, a.symbol), h("small", {}, `$${price(a.priceUsd)}`)))),
      h("div", { class: "lt-row" }, amtIn, h("button", { class: "btn primary", type: "button", disabled: !!st.busy, onclick: () => buyBasket(legs) }, st.busy || `Buy ${legs.length} stocks`)),
      Number(st.basketEth) > 0 ? h("p", { class: "fine" }, `About ${tiny(each)} ETH into each of ${legs.length} stocks.`) : null,
      h("div", { class: "lt-row" }, h("button", { class: "btn sm", type: "button", onclick: () => keepBalanced(name, legs) }, "Keep it balanced"),
        h("span", { class: "fine" }, "A playbook watches this basket in your Agent Wallet and rebalances to equal weights when one stock drifts 5% away (checked daily)."))));
  }
  async function keepBalanced(name, legs) {
    if (!wallet.session) return toast("Sign in first (Agent → Chat): the playbook belongs to your account.", "error", 6000);
    try {
      const r = await api.post("watches", { type: "rebalance", params: { name, driftPct: 5, everyHours: 24, tokens: legs.map((a) => ({ token: a.address, symbol: a.symbol, weight: 1 })) } });
      toast(`Playbook on: ${r.item.title}`, "ok", 6000);
    } catch (e) { toast(e.message, "error"); }
  }
  async function buyBasket(legs) { return guarded(() => _buyBasket(legs)); }
  async function _buyBasket(legs) {
    if (!wallet.address) return openConnect();
    const total = Number(st.basketEth);
    if (!(total > 0) || !legs.length) return toast("Enter the ETH to spend.", "error");
    const each = +(total / legs.length).toFixed(8);
    const ok = await review({ title: `Buy ${legs.length} stocks`, summary: `${tiny(total)} ETH split into ${legs.length} swaps of ${tiny(each)} ETH`, rows: legs.map((a) => [a.symbol, `${tiny(each)} ETH`]), confirmLabel: "Start", warn: "Your wallet asks once per stock. Each leg runs Troya Gate first." });
    if (!ok) return;
    const done = [];
    try {
      for (const [i, a] of legs.entries()) {
        st.busy = `Leg ${i + 1} of ${legs.length}: ${a.symbol}…`; paint();
        const gate = await api.get(`swap/gate?in=eth&out=${a.address}&amount=${each}`).catch((e) => ({ error: e.message }));
        if (gate.error || gate.pass === false) { toast(`${a.symbol} skipped: ${gate.error || "failed Troya Gate"}`, "error", 5000); continue; }
        const built = await api.post("swap/build", { from: wallet.address, tokenIn: "ETH", tokenOut: a.address, amountIn: String(each), slippageBps: 100 });
        const hash = await sendTx("robinhood", built);
        const rc = await waitReceipt("robinhood", hash);
        if (rc?.status === 1) done.push(a.symbol); else toast(`${a.symbol} did not go through`, "error");
      }
      toast(`Basket done: ${done.join(", ") || "nothing bought"}`, done.length ? "ok" : "error", 7000);
    } catch (e) { toast(errText(e), "error", 7000); }
    st.busy = null; paint();
  }

  /* ---------- borrow (Morpho Blue) ---------- */
  function borrow() {
    const L = st.loans;
    if (!L) return clear(body, h("div", { class: "sk", style: { height: "300px" } }));
    const mine = L.loans || [];
    // deepest market first; markets with less than $100 to lend sit behind "More markets" (unless you hold a loan there)
    const ms = [...L.markets].sort((a, b) => (b.liquidityUsdg || 0) - (a.liquidityUsdg || 0));
    const held = new Set(mine.map((x) => x.marketId));
    const shown = st.allMk ? ms : ms.filter((x) => (x.liquidityUsdg || 0) >= MIN_FREE || held.has(x.id) || x.id === st.mkId);
    const m = ms.find((x) => x.id === st.mkId) || shown[0] || ms[0];
    st.mkId = m.id;
    const twin = (x) => shown.filter((y) => y.symbol === x.symbol && y.lltvPct === x.lltvPct).length > 1;
    const params = { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: BigInt(m.lltv) };
    const loan = mine.find((x) => x.marketId === m.id);
    const collIn = h("input", { class: "input", inputmode: "decimal", placeholder: `${m.symbol} to post`, value: st.coll });
    const borIn = h("input", { class: "input", inputmode: "decimal", placeholder: "USDG to borrow", value: st.borrow });
    const repIn = h("input", { class: "input", inputmode: "decimal", placeholder: "USDG to repay", value: st.repay });
    collIn.addEventListener("input", () => { st.coll = collIn.value; check(); });
    borIn.addEventListener("input", () => { st.borrow = borIn.value; check(); });
    repIn.addEventListener("input", () => { st.repay = repIn.value; });
    const gateBox = h("div", { class: "sw-gate" });
    const check = () => {
      const coll = (loan?.collateral || 0) + (Number(st.coll) || 0), debt = (loan?.borrowUsdg || 0) + (Number(st.borrow) || 0);
      const max = coll * (m.priceUsd || 0) * m.lltvPct / 100, hf = debt > 0 ? max / debt : null;
      const items = [["Health after", hf == null ? "–" : hf.toFixed(2), hf == null ? "wait" : hf < MIN_HEALTH ? "fail" : hf < SAFE_HEALTH ? "warn" : "pass"],
        ["Liquidation price", debt > 0 && coll > 0 ? `$${price(debt / (coll * m.lltvPct / 100))} per ${m.symbol} (now $${price(m.priceUsd)})` : "–", "pass"],
        ["Market liquidity", `${usd(m.liquidityUsdg, { compact: true })} USDG left`, (Number(st.borrow) || 0) <= m.liquidityUsdg ? "pass" : "fail"]];
      clear(gateBox, h("div", { class: "gh" }, "Loan Gate"), h("ul", {}, items.map(([k, v, s]) => h("li", { class: s }, h("span", {}, k), h("b", {}, v)))),
        h("p", { class: "fine", style: { margin: "6px 0 0" } }, `Troya keeps the health factor at ${MIN_HEALTH} or more and asks for ${SAFE_HEALTH}+: at 1.0 Morpho can liquidate.`));
      gateBox.dataset.state = items.some((i) => i[2] === "fail") ? "fail" : "ok";
    };
    check();
    clear(body,
      h("div", { class: "panel sd-panel" }, h("h3", {}, "Your loans"),
        !wallet.address ? h("div", { class: "sd-empty" }, h("span", { class: "sd-empty-ico" }, icon("wallet")),
          h("p", {}, "Connect the wallet that holds your stock tokens to see its Morpho loans, health and liquidation price."),
          h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet"))
          : mine.length ? mine.map((x) => h("div", { class: "sd-row" }, h("b", {}, x.symbol), h("span", {}, `${tiny(x.collateral)} posted`), h("span", {}, `${tiny(x.borrowUsdg)} USDG owed`),
            h("span", { class: x.health < SAFE_HEALTH ? "down" : "up" }, `health ${x.health ? x.health.toFixed(2) : "–"}`), h("span", { class: "muted" }, x.liquidationPriceUsd ? `liq $${price(x.liquidationPriceUsd)}` : ""),
            st.alerts?.has(x.marketId) ? h("button", { class: "btn sm", type: "button", disabled: true }, icon("check"), "Alert on") : h("button", { class: "btn sm", type: "button", disabled: st.guarding === x.marketId, onclick: () => guard(x) }, st.guarding === x.marketId ? "Saving…" : "Alert me")))
          : h("p", { class: "muted" }, "No Morpho loans on stock tokens from this wallet.")),
      h("div", { class: "panel sd-panel" },
        h("div", { class: "sd-mk-h" }, h("h3", {}, "Borrow USDG"), h("span", { class: "fine" }, `${shown.length} of ${ms.length} Morpho markets`)),
        seg(shown.map((x) => ({ value: x.id, label: h("span", { class: "sd-mk-o" }, stockIcon({ symbol: x.symbol, address: x.collateralToken }, "xs"), h("b", {}, x.symbol), ` ${x.lltvPct}% LLTV · ${money(x.liquidityUsdg)} free`, twin(x) ? h("small", {}, ` · ${x.id.slice(0, 6)}…`) : null) })), m.id, (v) => { st.mkId = v; st.coll = st.borrow = ""; paint(); }, "sd-mk"),
        ms.length > shown.length || st.allMk ? h("button", { class: "link fine sd-more", type: "button", onclick: () => { st.allMk = !st.allMk; paint(); } }, st.allMk ? `Hide markets under ${money(MIN_FREE)} free` : `More markets (${ms.length - shown.length} with under ${money(MIN_FREE)} free)`) : null,
        h("p", { class: "fine" }, `Morpho market ${short(m.id)} · LLTV ${m.lltvPct}% · ${money(m.borrowUsdg)} borrowed of ${money(m.supplyUsdg)} · oracle $${price(m.priceUsd)}`),
        h("div", { class: "lt-row" }, collIn, borIn, h("button", { class: "btn primary", type: "button", disabled: !!st.busy, onclick: () => doBorrow(m, params) }, st.busy || "Post and borrow")),
        gateBox,
        loan ? h("div", { class: "lt-row" }, repIn, h("button", { class: "btn", type: "button", disabled: !!st.busy || !owes(loan), onclick: () => doRepay(m, params, loan) }, "Repay"),
          h("button", { class: "btn", type: "button", disabled: !!st.busy || !owes(loan), onclick: () => doRepay(m, params, loan, true) }, "Repay all"),
          h("button", { class: "btn", type: "button", disabled: !!st.busy || owes(loan) || !(BigInt(loan.collateralRaw || 0) > 0n), onclick: () => doWithdraw(m, params, loan), title: owes(loan) ? "Repay the loan first" : "All of it back to your wallet" }, "Withdraw collateral")) : null),
      h("p", { class: "fine" }, L.note));
  }
  const step = async (label, tx) => { st.busy = label; paint(); const hsh = await sendTx("robinhood", tx); const rc = await waitReceipt("robinhood", hsh); if (rc?.status !== 1) throw new Error(`${label} failed.`); return hsh; };
  async function ensureAllowance(token, amount, label) {
    const { reader } = await import("/agent/js/wallet.js");
    const raw = await reader("robinhood").call({ to: token, data: ERC.encodeFunctionData("allowance", [wallet.address, MORPHO]) });
    if (BigInt(raw) < amount) await step(label, { to: token, data: ERC.encodeFunctionData("approve", [MORPHO, amount]), value: "0" });
  }
  async function doBorrow(m, params) { return guarded(() => _doBorrow(m, params)); }
  async function _doBorrow(m, params) {
    if (!wallet.address) return openConnect();
    try {
      const coll = Number(st.coll) || 0, bor = Number(st.borrow) || 0;
      if (!(coll > 0 || bor > 0)) throw new Error("Enter collateral to post and/or USDG to borrow.");
      const box = body.querySelector(".sw-gate");
      if (box?.dataset.state === "fail") throw new Error("Blocked by the Loan Gate: post more collateral or borrow less.");
      if (coll > 0) {
        const bal = await balanceOf(wallet.address, { address: m.collateralToken, decimals: 18 });
        if (coll > (bal?.amount ?? 0)) throw new Error(`You have ${tiny(bal?.amount ?? 0)} ${m.symbol}.`);
      }
      const ok = await review({ title: `Morpho loan on ${m.symbol}`, summary: `${coll ? `Post ${tiny(coll)} ${m.symbol}` : ""}${coll && bor ? " and " : ""}${bor ? `borrow ${tiny(bor)} USDG` : ""}`,
        rows: [["Market", `${m.symbol}/USDG · LLTV ${m.lltvPct}%`], ["Contract", `Morpho Blue ${short(MORPHO)}`], ["Receiver", `${short(wallet.address)} (you)`]], confirmLabel: "Continue in wallet" });
      if (!ok) return;
      if (coll > 0) {
        const amt = parseUnits(String(coll), 18);
        await ensureAllowance(m.collateralToken, amt, `Approve ${m.symbol}…`);
        await step("Posting collateral…", { to: MORPHO, data: MO.encodeFunctionData("supplyCollateral", [params, amt, wallet.address, "0x"]), value: "0" });
      }
      if (bor > 0) await step("Borrowing…", { to: MORPHO, data: MO.encodeFunctionData("borrow", [params, parseUnits(String(bor), 6), 0n, wallet.address, wallet.address]), value: "0" });
      toast("Done on Morpho", "ok"); st.coll = st.borrow = "";
    } catch (e) { toast(errText(e), "error", 7000); }
    st.busy = null; await load();
  }
  async function doRepay(m, params, loan, all = false) { return guarded(() => _doRepay(m, params, loan, all)); }
  async function _doRepay(m, params, loan, all = false) {
    try {
      const amt = all ? loan.borrowUsdg : Math.min(Number(st.repay) || 0, loan.borrowUsdg);
      if (!(amt > 0)) throw new Error("Enter USDG to repay, or use Repay all.");
      // paying the whole debt goes by borrow shares: interest accrues every second, so an amount would leave dust
      const full = all || amt >= loan.borrowUsdg - 0.000001;
      const owed = BigInt(loan.borrowRaw || 0), shares = BigInt(loan.borrowShares || 0);
      const raw = full ? owed + owed / 1000n + 1000n : parseUnits(amt.toFixed(6), 6);     // full: room for interest since the last read
      const have = await balanceOf(wallet.address, { address: USDG, decimals: 6 });
      if ((have?.amount ?? 0) < amt) throw new Error(`You have ${tiny(have?.amount ?? 0)} USDG; the loan needs ${tiny(amt)}.`);
      await ensureAllowance(USDG, raw, "Approve USDG…");
      await step("Repaying…", { to: MORPHO, data: full && shares > 0n
        ? MO.encodeFunctionData("repay", [params, 0n, shares, wallet.address, "0x"])
        : MO.encodeFunctionData("repay", [params, raw, 0n, wallet.address, "0x"]), value: "0" });
      toast(full ? `Loan repaid in full (${tiny(amt)} USDG)` : `Repaid ${tiny(amt)} USDG`, "ok"); st.repay = "";
    } catch (e) { toast(errText(e), "error", 7000); }
    st.busy = null; await load();
  }
  function owes(loan) { return BigInt(loan?.borrowShares || 0) > 0n; }
  async function doWithdraw(m, params, loan) { return guarded(() => _doWithdraw(m, params, loan)); }
  async function _doWithdraw(m, params, loan) {
    try {
      await step("Withdrawing collateral…", { to: MORPHO, data: MO.encodeFunctionData("withdrawCollateral", [params, BigInt(loan.collateralRaw), wallet.address, wallet.address]), value: "0" });
      toast(`${tiny(loan.collateral)} ${m.symbol} back in your wallet`, "ok");
    } catch (e) { toast(errText(e), "error", 7000); }
    st.busy = null; await load();
  }
  async function guard(x) {
    if (!wallet.session) return toast("Sign in first (Social → Sign in) so the alert can reach your inbox.", "error", 6000);
    if (st.guarding || st.alerts?.has(x.marketId)) return;
    st.guarding = x.marketId; paint();
    try {
      const r = await api.post("watches", { type: "loan_guard", params: { marketId: x.marketId, symbol: x.symbol, healthBelow: 1.3 } });
      toast(`Alert on: ${r.item.title}`, "ok");
      (st.alerts ||= new Set()).add(x.marketId);
    } catch (e) { if (/already has an alert/i.test(e.message)) (st.alerts ||= new Set()).add(x.marketId); toast(e.message, "error"); }
    st.guarding = null; paint();
  }


  const off = onWallet(() => load());
  await load();
  const t = setInterval(load, 60000);
  return () => { alive = false; off(); clearInterval(t); };
}
