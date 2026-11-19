// Swap (#/swap?chain=&in=&out=): Robinhood Chain (Pons curves, Uniswap v3 / v4, the other launchpads through KyberSwap),
// Base and Arbitrum (KyberSwap). The network picker sits above the card; ?chain=base|arbitrum opens on that network.
// Quotes and the Troya Gate come from the server; every transaction is signed in the user's wallet.
import { h, clear, pageHead, seg, icon, modal, review, toast, tokenIcon, chainLogo, venueLogo, padLogo, tiny, num, amount, price, short, useCss, debounce, infoTip } from "../ui.js";
import { wallet, onWallet, openConnect, CHAINS } from "../wallet.js";
import { api } from "../api.js";
import { ETH, isNative, balanceOf, toRaw, fromRaw, inputNum, rawInput, sendTx, waitReceipt, errText, journal, addTransfer, updateTransfer } from "../chain.js";
import { sol, onSol, connectSol, restoreSol, signAndSendSol, solWallets } from "../solana.js";

const SLIPS = [{ value: 100, label: "1%" }, { value: 300, label: "3%" }, { value: 500, label: "5%" }];
const NETS = [{ key: "robinhood", label: "Robinhood" }, { key: "base", label: "Base" }, { key: "arbitrum", label: "Arbitrum" }, { key: "solana", label: "Solana" }];
const SOLT = { address: "native", symbol: "SOL", name: "Solana", decimals: 9 };
const SOL_KEEP = 10n ** 7n; // 0.01 SOL kept for fees and the token account rent by Max
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GAS_KEEP = 10n ** 14n; // 0.0001 ETH left for gas by Max (a swap costs well under that on these L2s)
// the tokens a multi-hop route passes through, so the middle of the route shows their logo too
const HOP = { USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", WETH: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", USDC: null };
// launchpad and venue ids as people know them (the picker badge)
const PAD_NAME = { uniswap: "Uniswap", ramses: "Ramses", pons: "Pons", long: "Long.xyz", frontier: "Frontier", clanker: "Clanker", bankr: "Bankr", virtuals: "Virtuals", mintclub: "Mint Club", pancake: "PancakeSwap", sushi: "SushiSwap", aerodrome: "Aerodrome", pumpfun: "pump.fun", "pump.fun": "pump.fun", raydium: "Raydium", meteora: "Meteora", bonk: "Bonk", kyber: "KyberSwap" };
const padName = (id) => { const k = String(id || "").toLowerCase(); return PAD_NAME[k] || (k ? k.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : ""); };
const padBadge = (id) => h("span", { class: "badge-s sw-pad" }, padLogo(id, 12), padName(id));

export async function mount(view, ctx) {
  useCss("swap");
  let alive = true;
  const st = {
    sell: ETH, buy: null, amount: "", slip: Math.round((ctx.prefs.get().slippage || 1) * 100),
    quote: null, quoteErr: null, loading: false, gate: null, gateAt: 0, gating: false, bal: null, busy: false, seq: 0,
    chain: NETS.some((n) => n.key === ctx.query.chain) ? ctx.query.chain : "robinhood",
  };
  // Solana uses its own wallet (Wallet Standard) and SOL as the native coin; the EVM chains share the connected EVM wallet
  const isSolNet = () => st.chain === "solana";
  const nativeOf = () => (isSolNet() ? SOLT : ETH);
  const natParam = () => (isSolNet() ? "SOL" : "ETH");
  const who = () => (isSolNet() ? sol.address : wallet.address);
  const tokParam = (t) => (isNative(t) ? natParam() : t.address);
  if (isSolNet()) st.sell = SOLT;
  const cq = () => (st.chain === "robinhood" ? {} : { chain: st.chain });
  const netName = () => (isSolNet() ? "Solana" : `${CHAINS[st.chain].name} · ${CHAINS[st.chain].id}`);
  if (![100, 300, 500].includes(st.slip)) st.slip = 100;

  // preload tokens from ?in= / ?out=
  const pre = async (a) => {
    if (!a || /^(eth|sol)$/i.test(a)) return nativeOf();
    if (!(isSolNet() ? MINT.test(a) : /^0x[0-9a-fA-F]{40}$/.test(a))) return null;
    try { const m = await api.get(`token/meta?${new URLSearchParams({ address: a, ...cq() })}`); return { address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals }; } catch { return null; }
  };
  if (ctx.query.in || ctx.query.out) {
    const [a, b] = await Promise.all([pre(ctx.query.in), pre(ctx.query.out)]);
    if (a) st.sell = a;
    if (b) st.buy = b;
    // a link with an address that is not a token: say so instead of silently showing "Select token"
    const given = (x) => x && !/^(eth|sol|native)$/i.test(x);
    if ((given(ctx.query.in) && !a) || (given(ctx.query.out) && !b)) setTimeout(() => toast(`That address isn't a token on ${isSolNet() ? "Solana" : CHAINS[st.chain]?.name || "Robinhood Chain"}.`, "error", 6000), 300);
    if (isNative(st.sell) && isNative(st.buy)) st.buy = null;
    if (st.sell && st.buy && !isNative(st.sell) && st.sell.address === st.buy.address) st.buy = null;
  }
  if (ctx.query.amount && /^\d*\.?\d+$/.test(ctx.query.amount)) st.amount = ctx.query.amount;

  /* ---------- layout ---------- */
  // network picker: Robinhood Chain is home; Base and Arbitrum route through KyberSwap, Solana through Jupiter, each with its own Gate
  const netChip = h("div", { class: "seg sw-nets", role: "group", "aria-label": "Network" });
  const paintNets = () => clear(netChip, NETS.map((n) => h("button", { type: "button", "aria-pressed": String(st.chain === n.key), onclick: () => setChain(n.key) }, chainLogo(n.key, 16), n.label)));
  function setChain(k) {
    if (k === st.chain) return;
    st.chain = k; st.sell = nativeOf(); st.buy = null; st.amount = ""; sellInput.value = "";
    if (k === "solana" && !sol.address) restoreSol().then(() => { refreshBal(); paint(); });
    try { const u = new URL(location.href); const [path, qs = ""] = u.hash.slice(1).split("?"); const p = new URLSearchParams(qs); k === "robinhood" ? p.delete("chain") : p.set("chain", k); p.delete("in"); p.delete("out"); history.replaceState(null, "", `#${path}${p.toString() ? "?" + p : ""}`); } catch {}
    paintNets(); paintNote(); reset(); paint(); refreshBal();
  }
  paintNets();
  const body = h("div", { class: "sw-body" });
  const gateCard = h("section", { class: "panel sw2-gate" });
  const routeCard = h("section", { class: "panel sw2-route" });
  const chartCard = h("section", { class: "panel sw2-chart", hidden: true });
  clear(view,
    h("div", { class: "sw2" },
      h("div", { class: "sw2-l" }, h("div", { class: "sw-net" }, netChip), body),
      h("div", { class: "sw2-r" }, gateCard, routeCard, chartCard)));

  // sell leg
  const sellInput = h("input", { class: "sw-amt", inputmode: "decimal", placeholder: "0", autocomplete: "off", spellcheck: "false", "aria-label": "Amount to sell", value: st.amount });
  const sellTok = h("button", { class: "sw-tok", type: "button", onclick: () => pick("sell") });
  const sellBal = h("button", { class: "sw-bal", type: "button", onclick: () => setMax() });
  const quick = h("div", { class: "sw-quick" });
  // buy leg
  const buyOut = h("div", { class: "sw-amt out", "aria-live": "polite" }, "0");
  const buyTok = h("button", { class: "sw-tok", type: "button", onclick: () => pick("buy") });
  const buySub = h("div", { class: "sw-sub" });
  const flip = h("button", { class: "sw-flip", type: "button", "aria-label": "Switch tokens", onclick: () => { [st.sell, st.buy] = [st.buy || nativeOf(), st.sell]; if (isNative(st.sell) && isNative(st.buy)) st.buy = null; st.amount = ""; sellInput.value = ""; reset(); paint(); refreshBal(); } }, icon("swap"));
  const slipSeg = seg(SLIPS, st.slip, (v) => { st.slip = v; const p = ctx.prefs.get(); ctx.prefs.set({ ...p, slippage: v / 100 }); reset(); requote(); });
  slipSeg.classList.add("sm");
  const rows = h("div", { class: "rows sw-rows" });
  const warnBox = h("div", { class: "sw-warn" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => act() });
  const txBox = h("div", { class: "sw-tx" });

  const card = h("div", { class: "sw-card panel" },
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "You pay"), sellBal),
      h("div", { class: "sw-leg-main" }, sellInput, sellTok),
      quick),
    h("div", { class: "sw-mid" }, flip),
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "You get"), buySub),
      h("div", { class: "sw-leg-main" }, buyOut, buyTok)),
    h("div", { class: "sw-meta" }, h("span", { class: "muted" }, "Slippage"), slipSeg,
      infoTip("The most the price may move against you between quote and inclusion. If it moves further, the swap reverts and only the network fee is spent.", "Slippage")),
    warnBox, btn, h("p", { class: "sw2-sign" }, "Your wallet signs. Troya never holds your funds."), rows, txBox);
  const note = h("p", { class: "note sw-note" });
  function paintNote() {
    if (isSolNet()) return clear(note, "Solana: Troya routes through Jupiter (pump.fun and every other Solana launchpad and pool) and runs a Solana Troya Gate: who can freeze or mint the coin, Token-2022 traps, the exact swap simulated from your address and a sell route back to SOL. You sign in your own Solana wallet (Phantom, Solflare, Backpack or MetaMask). Troya adds no fee of its own.");
    clear(note, st.chain === "robinhood"
      ? ["Robinhood Chain is chain 4663, gas is paid in ETH. Troya routes Pons Family curves (until a coin graduates) and Uniswap v3/v4 pools, and the other Robinhood Chain launchpads and pools through KyberSwap. Troya adds no fee of its own. ",
        h("a", { class: "link", href: "#/bridge" }, "Bridge ETH in"), " · ", h("a", { class: "link", href: "#/market" }, "Browse the market")]
      : [`${CHAINS[st.chain].name} is chain ${CHAINS[st.chain].id}, gas is paid in ETH. Troya routes it through KyberSwap and runs the same Troya Gate: the exact swap simulated, a test sell and transfer tax. Troya adds no fee of its own. `,
        h("a", { class: "link", href: "#/bridge" }, "Move ETH between chains")]);
  }
  paintNote();

  sellInput.addEventListener("input", () => {
    const v = sellInput.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    const fixed = v.split(".").length > 2 ? v.slice(0, v.lastIndexOf(".")) : v;
    if (fixed !== sellInput.value) sellInput.value = fixed;
    st.amount = fixed;
    reset();
    paint();
    requote();
  });

  function render() {
    clear(body, card, xcBox, note);
    paint();
  }

  /* ---------- one balance, every chain: buy this coin with ETH that sits on another chain, one signature there ----------
     Robinhood coin: pay from Base or Arbitrum. Base or Arbitrum coin: pay with ETH on Robinhood Chain. LI.FI bridges and
     buys for exactly this amount; the server runs this chain's Troya Gate on the coin first and refuses a route if it fails. */
  const XC_SRC = { robinhood: [{ key: "base", id: 8453, name: "Base" }, { key: "arbitrum", id: 42161, name: "Arbitrum" }], base: [{ key: "robinhood", id: 4663, name: "Robinhood Chain" }], arbitrum: [{ key: "robinhood", id: 4663, name: "Robinhood Chain" }] };
  const XC_GAS = 3n * 10n ** 14n; // 0.0003 ETH left on the source chain for the transaction's own gas
  const xc = { open: false, src: null, amount: "", bal: null, q: null, qAt: 0, err: null, gate: null, loading: false, seq: 0, busy: false, key: "", status: null };
  const xcBox = h("section", { class: "panel sw-xc", hidden: true });
  const xcToggle = h("button", { class: "sw-xc-t", type: "button", "aria-expanded": "false", onclick: () => { xc.open = !xc.open; xcToggle.setAttribute("aria-expanded", String(xc.open)); xcBody.hidden = !xc.open; if (xc.open) { xcBal(); xcQuote(); } xcPaint(); } });
  const xcSrcRow = h("div", { class: "sw-xc-src" });
  const xcInput = h("input", { class: "sw-xc-in", inputmode: "decimal", placeholder: "0.0", autocomplete: "off", spellcheck: "false", "aria-label": "ETH to pay on the other chain" });
  const xcBalBtn = h("button", { class: "sw-bal", type: "button", onclick: () => xcMax() });
  const xcUnit = h("span", { class: "sw-xc-unit" });
  const xcOut = h("div", { class: "sw-xc-out" });
  const xcBody = h("div", { class: "sw-xc-b", hidden: true }, xcSrcRow,
    h("div", { class: "sw-leg sw-xc-leg" }, h("div", { class: "sw-leg-top" }, h("span", {}, "You pay"), xcBalBtn), h("div", { class: "sw-leg-main" }, xcInput, xcUnit)), xcOut);
  xcInput.addEventListener("input", () => {
    const v = xcInput.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    const fixed = v.split(".").length > 2 ? v.slice(0, v.lastIndexOf(".")) : v;
    if (fixed !== xcInput.value) xcInput.value = fixed;
    xc.amount = fixed; xc.q = null; xc.err = null; xc.gate = null; xc.seq++;
    xcPaint(); xcQuote();
  });
  const xcSrcs = () => XC_SRC[st.chain] || [];
  const xcSrc = () => xcSrcs().find((x) => x.key === xc.src) || xcSrcs()[0];
  const xcDest = () => ({ key: st.chain, id: CHAINS[st.chain]?.id, name: st.chain === "robinhood" ? "Robinhood Chain" : CHAINS[st.chain]?.name || st.chain });
  const xcCoin = () => (!isSolNet() && XC_SRC[st.chain] && st.buy && !isNative(st.buy) && /^0x[0-9a-fA-F]{40}$/.test(st.buy.address || "") && isNative(st.sell) ? st.buy : null);
  function syncXc() {
    const coin = xcCoin();
    xcBox.hidden = !coin;
    if (!coin) return;
    const key = `${st.chain}:${coin.address.toLowerCase()}`;
    if (key === xc.key) return;
    Object.assign(xc, { key, src: xcSrcs()[0].key, q: null, err: null, gate: null, bal: null, status: null }); xc.seq++;
    const srcs = xcSrcs();
    clear(xcToggle, h("span", { class: "sw-xc-logos" }, srcs.map((x) => chainLogo(x.key, 16))),
      h("span", { class: "sw-xc-tt" }, h("b", {}, srcs.length > 1 ? "Pay from Base or Arbitrum" : "Pay with ETH on Robinhood Chain"), h("small", {}, `$${coin.symbol} lands on ${xcDest().name}. One signature, no manual bridge.`)),
      icon("arrowRight", "chev"));
    clear(xcBox, xcToggle, xcBody);
    if (xc.open) { xcBal(); xcQuote(); }
    xcPaint();
  }
  async function xcBal() {
    xc.bal = null;
    if (!wallet.address || !xcCoin()) return;
    const s = xcSrc(), k = xc.key;
    try { const b = await balanceOf(wallet.address, ETH, s.key); if (k === xc.key && s.key === xcSrc().key) xc.bal = b; } catch {}
    if (alive) xcPaint();
  }
  function xcMax() {
    if (!xc.bal) return;
    const raw = xc.bal.raw > XC_GAS ? xc.bal.raw - XC_GAS : 0n;
    xcInput.value = rawInput(raw, 18, 6);
    xcInput.dispatchEvent(new Event("input"));
  }
  const xcQuote = debounce(async () => {
    const coin = xcCoin(), raw = toRaw(xc.amount, 18);
    if (!coin || !xc.open || !raw || raw <= 0n || !wallet.address) { xc.loading = false; xcPaint(); return; }
    const seq = ++xc.seq, s = xcSrc(), d = xcDest();
    xc.loading = true; xc.err = null; xc.gate = null; xcPaint();
    try {
      const q = await api.get(`bridge/cross-buy?${new URLSearchParams({ fromChain: String(s.id), toChain: String(d.id), toToken: coin.address, address: wallet.address, amountWei: raw.toString(), slippage: String(Math.max(st.slip, 300) / 10000) })}`);
      if (seq !== xc.seq || !alive) return;
      xc.q = q; xc.qAt = Date.now(); xc.gate = q.gate;
    } catch (e) { if (seq === xc.seq) { xc.err = e.message; xc.gate = e?.data?.gate || null; } }
    if (seq === xc.seq && alive) { xc.loading = false; xcPaint(); }
  }, 600);
  function xcPaint() {
    if (xcBox.hidden || !xc.open) return;
    const coin = xcCoin(), s = xcSrc(), d = xcDest(), q = xc.q, srcs = xcSrcs();
    if (!coin) return;
    clear(xcSrcRow, srcs.length > 1 ? h("div", { class: "seg sm sw-xc-seg", role: "group", "aria-label": "Pay from" }, srcs.map((x) => h("button", { type: "button", "aria-pressed": String(x.key === s.key),
      onclick: () => { if (x.key === xc.src) return; xc.src = x.key; xc.q = null; xc.err = null; xc.gate = null; xc.seq++; xcBal(); xcQuote(); xcPaint(); } }, chainLogo(x.key, 14), x.name))) : null);
    clear(xcUnit, chainLogo(s.key, 16), h("b", {}, "ETH"), h("small", { class: "muted" }, `on ${s.name}`));
    if (wallet.address && xc.bal) { clear(xcBalBtn, `Balance ${amount(xc.bal.amount)} ETH`); xcBalBtn.disabled = false; }
    else { clear(xcBalBtn, wallet.address ? "Balance …" : ""); xcBalBtn.disabled = true; }
    const g = xc.gate;
    const gateRow = g ? h("div", {}, h("span", {}, `Troya Gate on ${d.name}`), h("span", { class: g.verdict === "failed" ? "down" : g.verdict === "caution" ? "warn-t" : "up" }, `${g.verdict === "failed" ? "Blocked" : g.verdict === "caution" ? "Passed with notes" : "Passed"} · ${g.passed}/${g.total}`)) : null;
    const rows = q ? h("div", { class: "rows sw-rows" },
      h("div", {}, h("span", {}, "You get (est.)"), h("span", {}, `${amount(Number(fromRaw(q.toAmount, q.toDecimals)))} ${q.toSymbol}`)),
      h("div", {}, h("span", {}, "Minimum"), h("span", {}, `${amount(Number(fromRaw(q.toAmountMin, q.toDecimals)))} ${q.toSymbol}`)),
      h("div", {}, h("span", {}, "Route"), h("span", {}, `${q.tool} via LI.FI`)),
      h("div", {}, h("span", {}, "Time"), h("span", {}, q.executionSec ? `about ${q.executionSec < 90 ? `${Math.max(1, Math.round(q.executionSec))} s` : `${Math.round(q.executionSec / 60)} min`}` : "a few minutes")),
      h("div", {}, h("span", {}, "Route fees"), h("span", {}, `$${num(q.feeUsd + q.gasUsd, 2)}`)),
      gateRow,
      h("div", {}, h("span", {}, "Troya fee"), h("span", {}, "None"))) : g ? h("div", { class: "rows sw-rows" }, gateRow) : null;
    const notes = [];
    if (xc.err) notes.push(h("div", { class: "alert error" }, xc.err));
    else if (g?.verdict === "caution" && g.why) notes.push(h("div", { class: "alert warn" }, g.why));
    const raw = toRaw(xc.amount, 18);
    let label = `Buy $${coin.symbol} with ETH on ${s.name}`, disabled = false;
    if (!wallet.address) label = "Connect wallet";
    else if (!raw || raw <= 0n) { label = "Enter an amount"; disabled = true; }
    else if (xc.bal && raw + XC_GAS > xc.bal.raw) { label = `Not enough ETH on ${s.name}`; disabled = true; }
    else if (xc.loading) { label = `Checking $${coin.symbol} and finding a route…`; disabled = true; }
    else if (!q) { label = xc.err ? (g?.verdict === "failed" ? "Blocked by Troya Gate" : "No route") : "Finding a route…"; disabled = true; }
    if (xc.busy) { label = xc.busy; disabled = true; }
    const btnX = h("button", { class: "btn primary", type: "button", disabled, onclick: () => xcAct() }, label);
    clear(xcOut, rows, ...notes, btnX, xc.status,
      h("p", { class: "fine muted sw-xc-fine" }, `One transaction on ${s.name}, signed in your wallet. LI.FI moves the ETH and buys $${coin.symbol} on ${d.name} for this amount only, delivered to your same address. Troya adds no fee.`));
  }
  async function xcAct() {
    if (!wallet.address) { await openConnect(); xcBal(); xcQuote(); return; }
    const coin = xcCoin(), s = xcSrc(), d = xcDest(), raw = toRaw(xc.amount, 18);
    if (!coin || !raw || raw <= 0n || !xc.q) return;
    try {
      // a quote older than 45 s is fetched again: the Gate and the route are checked once more on the coin as it is now
      if (Date.now() - xc.qAt > 45_000) {
        xc.busy = "Running Troya Gate again…"; xcPaint();
        const q2 = await api.get(`bridge/cross-buy?${new URLSearchParams({ fromChain: String(s.id), toChain: String(d.id), toToken: coin.address, address: wallet.address, amountWei: raw.toString(), slippage: String(Math.max(st.slip, 300) / 10000) })}`);
        xc.q = q2; xc.qAt = Date.now(); xc.gate = q2.gate; xc.busy = false; xcPaint();
      }
      const q = xc.q, amt = fromRaw(raw), got = Number(fromRaw(q.toAmount, q.toDecimals)), min = Number(fromRaw(q.toAmountMin, q.toDecimals));
      const ok = await review({ title: "Review cross-chain buy", summary: `${tiny(amt)} ETH on ${s.name} → about ${amount(got)} ${q.toSymbol} on ${d.name}`, confirmLabel: `Buy in wallet`,
        rows: [["You pay", `${tiny(amt)} ETH on ${s.name}`], ["You receive (est.)", `${amount(got)} ${q.toSymbol} on ${d.name}`], ["Minimum", `${amount(min)} ${q.toSymbol}`], ["Troya Gate", `${q.gate.verdict === "caution" ? "Passed with notes" : "Passed"} · ${q.gate.passed}/${q.gate.total} on ${d.name}`],
          ["Route", `${q.tool} via LI.FI`], ["Time", q.executionSec ? `about ${Math.max(1, Math.round(q.executionSec))} s` : "a few minutes"], ["Route fees", `$${num(q.feeUsd + q.gasUsd, 2)}`], ["Recipient", `${short(wallet.address)} (you) on ${d.name}`], ["Contract", short(q.tx.to)]],
        warn: `Sent through a third-party route (LI.FI${q.tool ? `, ${q.tool}` : ""}): Troya cannot reverse it once it is sent.${q.gate.verdict === "caution" && q.gate.why ? ` Gate note: ${q.gate.why}` : ""}` });
      if (!ok) return;
      xc.busy = `Confirm in your wallet on ${s.name}…`; xcPaint();
      const hash = await sendTx(s.key, { to: q.tx.to, data: q.tx.data, value: q.tx.value, gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n });
      addTransfer({ kind: "lifi", hash, amount: amt, sym: "ETH", from: s.key, fromId: s.id, to: d.key, toId: d.id, at: Date.now(), status: "sent", address: wallet.address, buy: { token: q.toToken, symbol: q.toSymbol } });
      journal({ kind: "bridge", direction: "cross-buy", chain: s.key, hash, amount: amt, route: q.tool, tokenOut: q.toToken, rationale: `Cross-chain buy of $${q.toSymbol} on ${d.name} with ETH on ${s.name}, from the Swap page` });
      toast(`Sent. $${q.toSymbol} usually lands on ${d.name} within a minute.`, "ok", 6000);
      xc.amount = ""; xcInput.value = ""; xc.q = null; xc.gate = null; xc.busy = false;
      xcTrack(hash, s, d, q.toSymbol);
    } catch (e) {
      toast(errText(e), "error", 6000);
    } finally {
      xc.busy = false;
      if (alive) { xcPaint(); xcBal(); }
    }
  }
  async function xcTrack(hash, s, d, sym) {
    const line = (cls, ...kids) => { xc.status = h("div", { class: `alert ${cls} sw-xc-st` }, ...kids); xcPaint(); };
    const link = h("a", { class: "mono link", href: `${CHAINS[s.key].explorer}/tx/${hash}`, target: "_blank", rel: "noopener" }, short(hash, 6));
    line("", `Sent on ${s.name} · `, link, " · waiting for it to confirm…");
    const rc = await waitReceipt(s.key, hash, { timeoutMs: 240_000 });
    if (!rc) return line("warn", `Still waiting for ${s.name}. It is not lost: keep the hash `, link, ". The Bridge page tracks it too.");
    updateTransfer(hash, { status: rc.status === 1 ? "confirmed" : "failed" });
    if (rc.status !== 1) return line("error", "The transaction reverted on ", s.name, ". Only the network fee was spent.");
    line("", `Confirmed on ${s.name} · `, link, ` · buying $${sym} on ${d.name}…`);
    for (let i = 0; i < 120 && alive; i++) {
      const r = await api.get(`bridge/status?${new URLSearchParams({ txHash: hash, fromChain: String(s.id), toChain: String(d.id) })}`).catch(() => null);
      if (r?.status === "DONE") {
        updateTransfer(hash, { status: "done" });
        toast(`$${sym} is in your wallet on ${d.name}`, "ok", 6000);
        if (st.chain === d.key) refreshBal();
        return line("ok", icon("check"), ` Done: $${sym} is in your wallet on ${d.name} · `, link);
      }
      if (r?.status === "FAILED") { updateTransfer(hash, { status: "failed" }); return line("error", `The route failed after it left ${s.name}. LI.FI refunds to your wallet; check the hash `, link, "."); }
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
  // a long quote shrinks to fit its box (down to 20px) instead of being cut mid-number
  function fitOut() {
    buyOut.style.fontSize = "";
    if (!buyOut.isConnected || !buyOut.clientWidth) return;
    let fs = parseFloat(getComputedStyle(buyOut).fontSize) || 40;
    while (buyOut.scrollWidth > buyOut.clientWidth + 1 && fs > 20) { fs -= 2; buyOut.style.fontSize = `${fs}px`; }
  }
  const fitObs = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitOut()) : null;
  fitObs?.observe(buyOut);

  function tokBtn(el, t) {
    clear(el, t ? [tokenIcon({ ...t, chain: st.chain }, "sm"), h("b", {}, t.symbol), icon("arrowRight", "chev")] : [h("span", {}, "Select token"), icon("arrowRight", "chev")]);
    el.classList.toggle("empty", !t);
  }

  function reset() { st.quote = null; st.quoteErr = null; st.gate = null; st.gateAt = 0; st.gating = false; st.seq++; }

  function paint() {
    tokBtn(sellTok, st.sell);
    tokBtn(buyTok, st.buy);
    // balance + quick picks
    if (who() && st.bal) {
      clear(sellBal, `Balance ${amount(st.bal.amount)} ${st.sell.symbol}`);
      sellBal.disabled = false;
    } else { clear(sellBal, who() ? "Balance …" : ""); sellBal.disabled = true; }
    clear(quick, isNative(st.sell)
      ? [...(isSolNet() ? ["0.05", "0.1", "0.5", "1"] : ["0.005", "0.01", "0.05", "0.1"]).map((v) => h("button", { type: "button", class: "chip", onclick: () => { sellInput.value = v; sellInput.dispatchEvent(new Event("input")); } }, `${v} ${nativeOf().symbol}`)),
        who() && st.bal?.raw > (isSolNet() ? SOL_KEEP : GAS_KEEP) ? h("button", { type: "button", class: "chip", title: `Everything but a little ${nativeOf().symbol} kept for fees`, onclick: () => setMax() }, "Max") : null]
      : who() && st.bal?.raw > 0n ? [25, 50, 75, 100].map((p) => h("button", { type: "button", class: "chip", onclick: () => setPct(p) }, p === 100 ? "Max" : `${p}%`)) : []);
    // output
    const q = st.quote;
    clear(buyOut, q ? amount(Number(q.amountOut)) : st.loading ? h("span", { class: "sk sw-sk" }) : "0");
    buyOut.title = q ? `${amount(Number(q.amountOut))} ${q.tokenOut.symbol}` : "";
    buyOut.classList.toggle("dim", !q);
    fitOut();
    clear(buySub, q && q.side === "buy" ? `≈ ${amount(Number(q.amountOut) / Number(q.amountIn))} per ${nativeOf().symbol}` : q?.ethUsd && q.side === "sell" ? `≈ $${price(Number(q.amountOut) * q.ethUsd)}` : "");
    // rows
    if (q) {
      const outSym = q.tokenOut.symbol, inSym = q.tokenIn.symbol;
      clear(rows,
        h("div", {}, h("span", {}, "Rate"), h("span", {}, `1 ${inSym} = ${amount(q.rate)} ${outSym}`)),
        h("div", {}, h("span", {}, "Minimum received"), h("span", {}, `${amount(Number(q.minOut))} ${outSym}`)),
        h("div", {}, h("span", {}, "Price impact"), h("span", { class: q.priceImpact > 0.05 ? "down" : "" }, q.priceImpact == null ? "–" : `${(q.priceImpact * 100).toFixed(2)}%`)),
        h("div", {}, h("span", {}, "Fees and taxes"), h("span", {}, q.feePct == null ? "–" : `${Number(q.feePct).toFixed(2)}%`)),
        h("div", {}, h("span", {}, "Route"), h("span", { class: "tok-link" }, venueLogo(q.route.venue || q.route.label, 14), q.route.label)),
        q.route.pons && !q.route.pons.graduated ? h("div", {}, h("span", {}, "Pons curve"), h("span", {}, `${num(q.route.pons.progressPct, 1)}% to graduation`)) : null,
        h("div", {}, h("span", {}, "Network fee"), h("span", {}, `Shown in your wallet (${nativeOf().symbol})`)),
        h("div", {}, h("span", {}, "Troya fee"), h("span", {}, "None")));
    } else clear(rows);
    rows.hidden = !q;
    // warnings
    const warns = [...(q?.warnings || [])];
    if (st.quoteErr) warns.unshift(st.quoteErr);
    clear(warnBox, warns.map((w) => h("div", { class: `alert ${st.quoteErr === w ? "error" : "warn"}` }, w)));
    // gate, route, chart
    paintGate();
    paintRoute();
    syncChart();
    syncXc();
    // button state
    const amt = toRaw(st.amount, st.sell?.decimals ?? 18);
    let label = "Review swap", disabled = false;
    if (!who()) label = isSolNet() ? "Connect a Solana wallet" : "Connect wallet";
    else if (!st.buy || !st.sell) { label = "Select a token"; disabled = true; }
    else if (!amt || amt <= 0n) { label = "Enter an amount"; disabled = true; }
    else if (st.bal && amt > st.bal.raw) { label = `Not enough ${st.sell.symbol}`; disabled = true; }
    else if (st.loading) { label = "Getting a quote…"; disabled = true; }
    else if (!q) { label = st.quoteErr ? "No route" : "Getting a quote…"; disabled = true; }
    else if (st.gate && !st.gate.pass) { label = "Blocked by Troya Gate"; disabled = true; }
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
  }

  const RC = 2 * Math.PI * 50;
  function ringEl(passed, total, verdict) {
    const el = h("span", { class: `dk-ring sw2-ring v-${verdict}`, role: "img", "aria-label": `${passed} of ${total} checks passed` });
    el.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${RC}"/></svg><span class="sw2-ring-c"><b>${passed}/${total}</b><small>passed</small></span>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const c = el.querySelector(".rb"); if (c) c.style.strokeDasharray = `${total ? (passed / total) * RC : 0} ${RC}`; }));
    return el;
  }
  let lastGateKey = "";
  function paintGate() {
    const g = st.gate;
    const sym = st.buy && !isNative(st.buy) ? st.buy.symbol : st.sell && !isNative(st.sell) ? st.sell.symbol : null;
    const key = g ? `${st.gateAt}` : st.gating ? "gating" : st.quote ? "quote" : `idle:${sym}`;
    if (key === lastGateKey) return;
    lastGateKey = key;
    const title = h("p", { class: "sw2-mic" }, `The Gate${sym ? ` · $${sym}` : ""}`);
    if (!g) {
      clear(gateCard, h("div", { class: "sw2-gh" }, title, h("span", { class: "dk-v" }, st.gating ? "Checking…" : "Waiting")),
        h("div", { class: "sw2-gb" }, ringEl(0, 7, "idle"),
          h("p", { class: "sw2-wait" }, st.gating ? "Simulating the exact swap from your address and a test sell…" : "Pick a coin and an amount. Troya runs seven checks here, a simulated swap and a test sell included, before your wallet can sign.")));
      return;
    }
    const passed = g.checks.filter((c) => c.status === "pass").length;
    const verdict = g.pass ? (g.checks.some((c) => c.status === "warn") ? "caution" : "passed") : "failed";
    clear(gateCard,
      h("div", { class: "sw2-gh" }, title, st.gateAt ? h("span", { class: "fine muted", "data-gate-age": "" }, gateAge()) : null,
        h("span", { class: `dk-v v-${verdict}` }, g.pass ? (verdict === "caution" ? "Passed with notes" : "Passed") : "Blocked")),
      h("div", { class: "sw2-gb" }, ringEl(passed, g.checks.length, verdict),
        h("ul", { class: "sw2-checks" }, g.checks.map((c) => h("li", { class: `c-${c.status}` },
          h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")),
          h("span", { class: "l" }, c.label), h("span", { class: "d", title: c.detail || "" }, c.status === "skip" ? (c.detail || "Skipped") : c.detail || ""))))),
      h("p", { class: "fine muted sw2-gnote" }, "Runs again the moment you press Swap, on the pool as it is then."));
  }
  // the route: the exact path the quote takes, pool by pool
  let lastRouteKey = "";
  // the same coin on Fomo, for people who trade there (Robinhood Chain coins, not ETH, USDG or WETH)
  const fomoCoin = () => (st.chain === "robinhood" ? [st.buy, st.sell].find((t) => t && !isNative(t) && /^0x[0-9a-fA-F]{40}$/.test(t.address || "") && !/^(USDG|WETH)$/i.test(t.symbol || "")) : null);
  const fomoRow = () => { const t = fomoCoin(); return t ? h("a", { class: "tk2-ext sw2-fomo", href: `https://fomo.family/tokens/robinhood/${t.address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/fomo.png", alt: "" }), `Also on Fomo · $${t.symbol}`) : null; };
  function paintRoute() {
    const q = st.quote;
    const key = (q ? `${q.route?.label}|${q.amountIn}|${q.amountOut}` : "none") + `|${fomoCoin()?.address || ""}`;
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    if (!q) { clear(routeCard, h("p", { class: "sw2-mic" }, "Route"), h("p", { class: "sw2-wait" }, "The path your swap takes appears here with the quote."), fomoRow()); return; }
    const node = (t, sub) => h("div", { class: "sw2-node" }, tokenIcon({ ...t, chain: st.chain }, ""), sub instanceof Node ? sub : h("small", {}, sub));
    const venue = (label) => h("div", { class: "sw2-node v" }, h("span", { class: "sw2-pool" }, venueLogo(q.route.venue || label, 22)), h("small", {}, label));
    const hops = q.route.hops?.length ? q.route.hops : [{ from: q.tokenIn.symbol, to: q.tokenOut.symbol }];
    const vLabel = String(q.route.label || "").split(" · ")[0] + (q.route.pons ? " · Pons pool" : "");
    const amt = (v, sym) => h("small", {}, h("b", {}, amount(Number(v))), " ", h("span", {}, sym));
    const parts = [node(q.tokenIn, amt(q.amountIn, q.tokenIn.symbol))];
    // the token in the middle of a multi-hop route wears its own logo (USDG, WETH …), like both ends
    const mid = (sym, addr) => h("div", { class: "sw2-node" }, tokenIcon({ symbol: sym, address: addr || HOP[String(sym).toUpperCase()] || "", chain: st.chain }, ""), h("small", {}, sym));
    if (hops.length > 1) hops.forEach((x, i) => { parts.push(h("i", { class: "sw2-line" })); parts.push(venue(x.venue || vLabel)); if (i < hops.length - 1) { parts.push(h("i", { class: "sw2-line" })); parts.push(mid(x.to, x.toAddress)); } });
    else { parts.push(h("i", { class: "sw2-line" })); parts.push(venue(vLabel)); }
    parts.push(h("i", { class: "sw2-line" }));
    parts.push(node(q.tokenOut, amt(q.amountOut, q.tokenOut.symbol)));
    clear(routeCard, h("p", { class: "sw2-mic" }, "Route"), h("div", { class: "sw2-path" }, parts), fomoRow());
  }
  // the chart of the coin you are buying (or selling), Robinhood Chain coins
  let chartAddr = "", chartObj = null, chartSeq = 0;
  function syncChart() {
    const t = st.chain === "robinhood" ? (st.buy && !isNative(st.buy) ? st.buy : st.sell && !isNative(st.sell) ? st.sell : null) : null;
    const a = t?.address ? String(t.address).toLowerCase() : "";
    if (a === chartAddr) return;
    chartAddr = a;
    try { chartObj?.remove(); } catch {}
    chartObj = null;
    if (!a) { chartCard.hidden = true; return; }
    loadSwapChart(t, "15m");
  }
  async function loadSwapChart(t, iv, tries = 0) {
    const my = ++chartSeq, a = chartAddr;
    // a skeleton while the candles load (a new coin's first candles can take several seconds)
    const box = h("div", { class: "sw2-chart-box" }, h("div", { class: "sk sw2-chart-sk" }));
    const tf = seg(["15m", "1h", "4h"], iv, (v) => { try { chartObj?.remove(); } catch {} chartObj = null; loadSwapChart(t, v); });
    tf.classList.add("sm");
    chartCard.hidden = false;
    clear(chartCard, h("div", { class: "sw2-ch-h" }, tokenIcon({ ...t, chain: st.chain }, "sm"), h("b", {}, `$${t.symbol}`), st.gate?.pass ? h("span", { class: "dk-v v-passed" }, `Gate ${st.gate.checks.filter((c) => c.status === "pass").length}/${st.gate.checks.length}`) : null, h("span", { class: "sw2-sp" }), tf), box);
    try {
      const c = await api.get(`market/robinhood/candles?address=${a}&interval=${iv}`);
      if (!alive || my !== chartSeq || a !== chartAddr) return;
      const seen = new Set();
      const rows = (c.candles || []).filter((x) => x.close > 0 && !seen.has(x.time) && seen.add(x.time)).sort((x, y) => x.time - y.time).map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }));
      if (rows.length < 2) { clear(box, h("p", { class: "sw2-wait sw2-chart-msg" }, "Not enough trades for a chart yet.")); return; }
      const LW = await import("lightweight-charts");
      if (!alive || my !== chartSeq) return;
      const light = document.documentElement.dataset.theme === "light";
      clear(box);
      chartObj = LW.createChart(box, { autoSize: true, layout: { background: { type: "solid", color: "transparent" }, textColor: light ? "#6e685f" : "#6f7c89", fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11, attributionLogo: false },
        grid: { vertLines: { color: light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.035)" }, horzLines: { color: light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.035)" } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } }, timeScale: { borderVisible: false, timeVisible: true }, handleScroll: false, handleScale: false,
        localization: { priceFormatter: (p) => (p <= 0 ? "" : price(p)) } });
      const s = chartObj.addCandlestickSeries({ ...{ upColor: "#8edff5", downColor: "#ff7d8a", borderVisible: false, wickUpColor: "#8edff5", wickDownColor: "#ff7d8a" }, ...(light ? { upColor: "#0a7ea3", wickUpColor: "#0a7ea3", downColor: "#c8303f", wickDownColor: "#c8303f" } : {}), priceFormat: { type: "price", precision: 10, minMove: 1e-10 } });
      s.setData(rows);
      chartObj.timeScale().fitContent();
    } catch (e) {
      if (!alive || my !== chartSeq || a !== chartAddr) return;
      // the candle source sometimes answers 502 on the first try: one quiet retry, then a plain message with Retry
      if ((e.status >= 500 || e.status === 0) && tries < 1) { setTimeout(() => { if (alive && my === chartSeq && a === chartAddr) loadSwapChart(t, iv, tries + 1); }, 2000); return; }
      clear(box, h("div", { class: "sw2-chart-msg" }, h("p", { class: "sw2-wait" }, "The chart could not load just now."),
        h("button", { class: "btn sm", type: "button", onclick: () => loadSwapChart(t, iv) }, icon("refresh"), "Retry")));
    }
  }

  function gateAge() {
    const s = Math.max(0, Math.round((Date.now() - st.gateAt) / 1000));
    return s < 60 ? `checked ${s}s ago` : `checked ${Math.floor(s / 60)}m ago`;
  }
  const ageTick = setInterval(() => { const el = gateCard.querySelector("[data-gate-age]"); if (el && st.gateAt) el.textContent = gateAge(); }, 1000);

  // Troya Gate runs again at the moment of signing: on a new pool, liquidity can move between the quote and the click.
  async function regate(q, label) {
    st.busy = label || "Running Troya Gate again…"; paint();
    const qs = new URLSearchParams({ tokenIn: tokParam(q.tokenIn), tokenOut: tokParam(q.tokenOut), amountInRaw: q.amountInRaw, slippageBps: String(st.slip), from: who(), ...cq() });
    let g;
    try { g = await api.get(`swap/gate?${qs}`); }
    catch (e) { const err = new Error(`Troya Gate could not run again just now (${e.message}). Nothing was sent. Try again in a moment.`); err.gate = true; throw err; }
    if (!alive) { const err = new Error("Swap cancelled."); err.gate = true; throw err; }
    st.gate = g; st.gateAt = Date.now(); paintGate();
    if (!g.pass) {
      const why = g.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`).join(" · ");
      const err = new Error(`Troya Gate ran again and blocked this swap. ${why}`.slice(0, 300)); err.gate = true; throw err;
    }
    return g;
  }

  /* ---------- quote + gate ---------- */
  const requote = debounce(async () => {
    const amt = toRaw(st.amount, st.sell?.decimals ?? 18);
    if (!st.sell || !st.buy || !amt || amt <= 0n) { st.loading = false; paint(); return; }
    const seq = ++st.seq;
    st.loading = true;
    paint();
    const qs = new URLSearchParams({ tokenIn: tokParam(st.sell), tokenOut: tokParam(st.buy), amountInRaw: amt.toString(), slippageBps: String(st.slip), ...cq() });
    try {
      const q = await api.get(`swap/quote?${qs}`);
      if (!alive || seq !== st.seq) return;
      st.quote = q; st.quoteErr = null; st.loading = false; st.gating = true;
      paint();
      if (who()) qs.set("from", who());
      // fail closed: if the Gate can't run, the swap stays locked until it can
      const g = await api.get(`swap/gate?${qs}`).catch((e) => ({ pass: false, checks: [{ key: "gate", status: "fail", label: "Troya Gate", detail: `Could not run the checks just now (${e.message}). The swap stays locked until they pass. Try again in a moment.` }] }));
      if (!alive || seq !== st.seq) return;
      st.gate = g; st.gateAt = Date.now(); st.gating = false;
      paint();
      tellTroya();
    } catch (e) {
      if (!alive || seq !== st.seq) return;
      st.quote = null; st.quoteErr = e.message; st.loading = false;
      paint();
      tellTroya();
    }
  }, 380);
  // the Ask Troya popup reads this, so "why is it blocked?" is answered about this exact swap
  function tellTroya() {
    const q = st.quote, g = st.gate;
    const fails = g ? g.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`) : [];
    const notes = g ? g.checks.filter((c) => c.status === "warn").map((c) => `${c.label}: ${c.detail}`) : [];
    const text = [`Swap on ${CHAINS[st.chain]?.name || st.chain}: ${st.amount || "?"} ${st.sell?.symbol || "?"} for ${st.buy?.symbol || "?"}${st.buy?.address && st.buy.address !== "native" ? ` (${st.buy.address})` : ""}.`,
      q ? `Quote ${amount(Number(q.amountOut))} ${q.tokenOut.symbol}, price impact ${q.priceImpact == null ? "?" : (q.priceImpact * 100).toFixed(2) + "%"}, fees and taxes ${q.feePct == null ? "?" : q.feePct + "%"}, route ${q.route?.label}.` : st.quoteErr ? `No quote: ${st.quoteErr}.` : "",
      g ? `Troya Gate ${g.pass ? "passed" : "blocked"} (${g.checks.filter((c) => c.status === "pass").length}/${g.checks.length}).` : "",
      fails.length ? `Failed: ${fails.join("; ")}.` : "", notes.length ? `Notes: ${notes.join("; ")}.` : ""].filter(Boolean).join(" ");
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text } }));
    if (g && !g.pass) dispatchEvent(new CustomEvent("troya:nudge", { detail: { key: `swap-gate-${st.gateAt}`, text: `Troya Gate blocked this swap of ${st.buy?.symbol || "the coin"}. Want me to explain why?`, q: "Why did Troya Gate block this swap, and what can I do instead?" } }));
    else if (g && notes.length) dispatchEvent(new CustomEvent("troya:nudge", { detail: { key: `swap-note-${st.buy?.address}`, text: `The Gate passed ${st.buy?.symbol || "this coin"} with a note. Want to know what it means?`, q: "The Gate passed this swap with a note. What does the note mean for me?" } }));
  }
  const swapFailed = (e) => dispatchEvent(new CustomEvent("troya:nudge", { detail: { key: `swap-err-${Date.now()}`, text: "That swap didn't go through. Want me to explain what happened?", q: `My swap didn't go through. The app said: "${String(e?.gate ? e.message : errText(e)).slice(0, 300)}". What does it mean and what should I do?` } }));

  async function refreshBal() {
    st.bal = null;
    paint();
    if (!who() || !st.sell) return;
    if (isSolNet()) {
      const chainAt = st.chain;
      try { const b = await api.get(`sol/balance?${new URLSearchParams({ owner: sol.address, mint: isNative(st.sell) ? "native" : st.sell.address })}`); const raw = BigInt(b.raw || 0); st.bal = { raw, amount: Number(raw) / 10 ** (b.decimals ?? st.sell.decimals ?? 9) }; } catch { st.bal = null; }
      if (chainAt === st.chain && alive) paint();
      return;
    }
    const chainAt = st.chain;
    try { st.bal = await balanceOf(wallet.address, st.sell, st.chain); } catch { st.bal = null; }
    if (chainAt !== st.chain) return;
    if (alive) paint();
  }
  function setMax() {
    if (!st.bal) return;
    let raw = st.bal.raw;
    const keep = isSolNet() ? SOL_KEEP : GAS_KEEP;
    if (isNative(st.sell)) raw = raw > keep ? raw - keep : 0n; // keep a little ETH / SOL for fees
    sellInput.value = rawInput(raw, st.sell.decimals ?? 18, 8);
    sellInput.dispatchEvent(new Event("input"));
  }
  function setPct(p) {
    if (!st.bal) return;
    const raw = (st.bal.raw * BigInt(p)) / 100n;
    sellInput.value = rawInput(raw, st.sell.decimals ?? 18, 8);
    sellInput.dispatchEvent(new Event("input"));
  }

  /* ---------- token picker ---------- */
  let stocksCache = null;
  function pick(side) {
    const other = side === "sell" ? st.buy : st.sell;
    const input = h("input", { class: "input", placeholder: "Search a name, symbol or paste an address", autocomplete: "off", spellcheck: "false" });
    const list = h("div", { class: "tp-list" });
    const choose = async (t) => {
      if (t.decimals == null && t.address && t.address !== "native") {
        try { const m2 = await api.get(`token/meta?${new URLSearchParams({ address: t.address, ...cq() })}`); t = { ...t, decimals: m2.decimals, symbol: t.symbol || m2.symbol, name: t.name || m2.name }; }
        catch { toast("Could not read this token from the chain. Try again in a moment.", "error"); return; }
      }
      if (side === "sell") st.sell = t; else st.buy = t;
      if (other && (isNative(t) ? isNative(other) : !isNative(other) && other.address === t.address)) { if (side === "sell") st.buy = null; else st.sell = nativeOf(); }
      m.close(); reset(); paint(); refreshBal(); requote();
    };
    const row = (t, extra) => h("button", { class: "tp-row", type: "button", onclick: () => choose(t) }, tokenIcon({ ...t, chain: st.chain }, "sm"),
      h("span", { class: "tp-name" }, h("b", {}, t.symbol), h("small", {}, t.name || (t.address === "native" ? "Native gas token" : short(t.address)))),
      extra ? h("span", { class: "tp-extra" }, extra) : null);
    let seq = 0;
    const search = debounce(async () => {
      const q = input.value.trim();
      const my = ++seq;
      const items = [];
      if (st.chain !== "robinhood") {
        // Base / Arbitrum: popular tokens, search by name or symbol (GeckoTerminal), or paste an address
        if (!q || nativeOf().symbol.toLowerCase().startsWith(q.toLowerCase())) items.push(row(nativeOf(), "Native"));
        clear(list, ...items, h("div", { class: "tp-load muted" }, "Searching…"));
        try {
          if (isSolNet() ? MINT.test(q) : /^0x[0-9a-fA-F]{40}$/.test(q)) {
            const m2 = await api.get(`token/meta?${new URLSearchParams({ address: q, ...cq() })}`);
            if (my !== seq) return;
            clear(list, row({ address: m2.address, symbol: m2.symbol, name: m2.name, decimals: m2.decimals }, "By address"));
            return;
          }
          const r = await api.get(`swap/tokens?${new URLSearchParams({ q, ...cq() })}`);
          if (my !== seq) return;
          const toks = r.tokens || [];
          clear(list, ...items, isSolNet() && r.trending ? h("div", { class: "tp-load muted" }, "Trending on Solana right now") : null,
            ...toks.map((t) => row(t, t.launchpad ? padBadge(t.launchpad) : t.liquidityUsd ? h("span", { class: "badge-s" }, t.liquidityUsd >= 1e6 ? `$${num(t.liquidityUsd / 1e6, 1)}M liq.` : `$${num(t.liquidityUsd / 1e3, 0)}K liq.`) : null)),
            toks.length ? null : h("div", { class: "tp-load muted" }, "No match. Paste the token address instead."));
        } catch { if (my === seq) clear(list, ...items, h("div", { class: "tp-load muted" }, "The token list is unavailable right now. Paste a token address instead.")); }
        return;
      }
      const base = [[ETH, "Native"], [{ address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Global Dollar", decimals: 6 }, "Stablecoin"], [{ address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18 }, "Wrapped"]];
      for (const [t, tag] of base) if (!q || t.symbol.toLowerCase().startsWith(q.toLowerCase())) items.push(row(t, tag));
      clear(list, ...items, h("div", { class: "tp-load muted" }, "Searching…"));
      try {
        if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
          const m2 = await api.get(`token/meta?address=${q}`);
          if (my !== seq) return;
          clear(list, row({ address: m2.address, symbol: m2.symbol, name: m2.name, decimals: m2.decimals }, "By address"));
          return;
        }
        if (q) {
          // a symbol, name or ticker: the whole chain (index + stock tokens + DexScreener), real coin first, copies marked
          const [r, sk] = await Promise.all([
            api.get(`search/coins?${new URLSearchParams({ q, limit: "24" })}`),
            (stocksCache ||= api.get("market/stocks").catch(() => ({ stocks: [] }))),
          ]);
          if (my !== seq) return;
          const tradable = new Set((sk.stocks || []).filter((t) => t.tradable).map((t) => String(t.address).toLowerCase()));
          const hits = (r.coins || []).filter((c) => c.kind !== "major" && (c.kind !== "stock" || tradable.has(c.address)));
          const liq = (n) => (n >= 1e6 ? `$${num(n / 1e6, 1)}M liq.` : `$${num(n / 1e3, n >= 1e4 ? 0 : 1)}K liq.`);
          clear(list, ...items,
            ...hits.map((c) => row({ address: c.address, symbol: c.symbol, name: c.name, decimals: null, image: c.image },
              c.kind === "stock" ? h("span", { class: "badge-s sw-pad" }, padLogo("stocks", 12), "Stock") : c.launchpad ? padBadge(c.launchpad) : h("span", { class: "badge-s" }, c.liquidityUsd ? liq(c.liquidityUsd) : "Coin"))),
            hits.length || items.length ? null : h("div", { class: "tp-load muted" }, "No match. Paste the token address instead."));
          return;
        }
        const [r, sk] = await Promise.all([
          api.get(`market/robinhood?${new URLSearchParams({ q, limit: "30", sort: "volume", dir: "desc", tradable: "1" })}`),
          (stocksCache ||= api.get("market/stocks").catch(() => ({ stocks: [] }))),
        ]);
        if (my !== seq) return;
        const ql = q.toLowerCase();
        const stocks = (sk.stocks || []).filter((t) => t.tradable && (!ql || t.symbol.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql))).slice(0, q ? 12 : 6);
        const toks = (r.tokens || r.rows || []).filter((t) => t.address && t.address !== "native");
        clear(list, ...items,
          ...stocks.map((t) => row({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals ?? null, image: t.image }, h("span", { class: "badge-s sw-pad" }, padLogo("stocks", 12), "Stock"))),
          ...toks.map((t) => row({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals ?? null, image: t.image }, t.launchpad ? padBadge(t.launchpad) : null)),
          toks.length || stocks.length ? null : h("div", { class: "tp-load muted" }, q ? "No match. Paste the token address instead." : "Type to search Robinhood Chain tokens."));
      } catch (e) {
        if (my !== seq) return;
        clear(list, ...items, h("div", { class: "tp-load muted" }, "The token list is unavailable right now. Paste a token address instead."));
      }
    }, 250);
    input.addEventListener("input", search);
    const m = modal({ title: side === "sell" ? "Sell which token?" : "Buy which token?", body: h("div", { class: "tp" }, input, list,
      h("p", { class: "note" }, st.chain === "robinhood"
        ? "Troya routes Pons curves and Uniswap v3/v4 pools, and the other Robinhood Chain launchpads through KyberSwap. Paste any Robinhood Chain coin address to find it. A coin still on its Pons curve trades against its curve pair (usually ETH)."
        : isSolNet() ? "Solana coins, routed through Jupiter: pump.fun and every other launchpad. Paste any Solana token address (mint) to find it; Troya Gate checks it before you can buy."
        : `Tokens on ${CHAINS[st.chain].name}, routed through KyberSwap. Paste any ${CHAINS[st.chain].name} token address to find it; Troya Gate checks it before you can buy.`)) });
    search();
    setTimeout(() => input.focus(), 40);
  }

  /* ---------- execute ---------- */
  // Solana: pick a wallet (Wallet Standard), then sign the exact transaction Troya built with Jupiter for this address
  async function connectSolana() {
    const list = solWallets();
    if (list.length <= 1) { try { await connectSol(list[0]?.name); } catch (e) { toast(e.message, "error", 7000); } return; }
    const m = modal({ title: "Connect a Solana wallet", body: h("div", { class: "sw-solw" }, list.map((w) => h("button", { class: "sw-solw-row", type: "button", onclick: async () => { m.close(); try { await connectSol(w.name); } catch (e) { toast(e.message, "error", 6000); } } },
      w.icon ? h("img", { src: w.icon, alt: "", width: 24, height: 24 }) : null, h("b", {}, w.name))), h("p", { class: "note" }, "Troya never sees your key: your wallet signs the exact swap the Gate checked.")) });
  }
  async function actSol(q) {
    try {
      await regate(q);
      st.busy = "Preparing…"; paint();
      const args = { chain: "solana", from: sol.address, tokenIn: tokParam(q.tokenIn), tokenOut: tokParam(q.tokenOut), amountInRaw: q.amountInRaw, slippageBps: st.slip };
      let built = await api.post("swap/build", args);
      let builtAt = Date.now();
      const fq = built.quote;
      const ok = await review({
        title: "Review swap",
        summary: `${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol} → about ${amount(Number(fq.amountOut))} ${fq.tokenOut.symbol}`,
        rows: [
          ["You pay", `${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol}`],
          ["You receive (est.)", `${amount(Number(fq.amountOut))} ${fq.tokenOut.symbol}`],
          ["Minimum received", `${amount(Number(fq.minOut))} ${fq.tokenOut.symbol}`],
          ["Slippage", `${st.slip / 100}%`],
          ["Price impact", fq.priceImpact == null ? "–" : `${(fq.priceImpact * 100).toFixed(2)}%`],
          ["Route", fq.route.label],
          ["Recipient", `${short(sol.address)} (you)`],
          ["Network", "Solana"],
        ],
        warn: fq.warnings?.length ? fq.warnings.join(" ") : null,
        confirmLabel: "Swap in wallet",
      });
      if (!ok) { st.busy = false; paint(); return; }
      // a Solana transaction carries a recent blockhash that expires in about a minute: rebuild if the review took long
      if (Date.now() - st.gateAt > 45000) await regate(q, "Running Troya Gate again…");
      if (Date.now() - builtAt > 40000) { built = await api.post("swap/build", args); builtAt = Date.now(); }
      st.busy = "Confirm in your wallet…"; paint();
      const sig = await signAndSendSol(built.tx);
      const link = h("a", { class: "mono link", href: `https://solscan.io/tx/${sig}`, target: "_blank", rel: "noopener" }, short(sig, 6));
      clear(txBox, h("div", { class: "muted" }, "Submitted ", link, " · waiting for Solana…"));
      st.busy = "Waiting for Solana…"; paint();
      let res = null;
      for (let i = 0; i < 45 && alive; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const s2 = await api.get(`sol/status?sig=${encodeURIComponent(sig)}`).catch(() => null);
        if (s2?.err) { res = "err"; break; }
        if (s2?.status === "confirmed" || s2?.status === "finalized") { res = "ok"; break; }
      }
      if (res === "ok") {
        toast(`Swapped ${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol} for ${fq.tokenOut.symbol}`, "ok", 5000);
        clear(txBox, h("div", { class: "alert ok" }, icon("check"), " Swap confirmed · ", h("a", { class: "link", href: `https://solscan.io/tx/${sig}`, target: "_blank", rel: "noopener" }, short(sig, 6))));
        journal({ kind: "swap", chain: "solana", hash: sig, status: "confirmed", venue: fq.venue, tokenIn: fq.tokenIn.address, tokenOut: fq.tokenOut.address, amountIn: fq.amountIn, amountOut: fq.amountOut, rationale: "Manual swap from the Swap page" });
        st.amount = ""; sellInput.value = "";
        reset();
      } else if (res === "err") {
        clear(txBox, h("div", { class: "alert error" }, "The swap failed on Solana. Only the network fee was spent. ", link));
        journal({ kind: "swap", chain: "solana", hash: sig, status: "reverted", venue: fq.venue });
      } else {
        clear(txBox, h("div", { class: "alert warn" }, "Still waiting for Solana to confirm it. It is not lost: ", link, "."));
      }
    } catch (e) {
      toast(e?.gate ? e.message : errText(e), "error", e?.gate ? 8000 : 5000);
      swapFailed(e);
    } finally {
      st.busy = false;
      if (alive) { paint(); refreshBal(); }
    }
  }

  async function act() {
    if (isSolNet()) {
      if (!sol.address) { await connectSolana(); return; }
      if (st.quote) await actSol(st.quote);
      return;
    }
    if (!wallet.address) { await openConnect(); refreshBal(); return; }
    const q = st.quote;
    if (!q) return;
    try {
      await regate(q);
      st.busy = "Preparing…"; paint();
      const chain = st.chain, net = netName();
      const buildArgs = { from: wallet.address, tokenIn: isNative(q.tokenIn) ? "ETH" : q.tokenIn.address, tokenOut: isNative(q.tokenOut) ? "ETH" : q.tokenOut.address, amountInRaw: q.amountInRaw, slippageBps: st.slip, ...cq() };
      let built = await api.post("swap/build", buildArgs);
      const need = (built.approvals || []).filter((a) => a.needed);
      if (need.length) {
        const okA = await review({
          title: need.length > 1 ? `${need.length} approvals first` : `Approve ${q.tokenIn.symbol}`,
          summary: `Exactly ${amount(Number(q.amountIn))} ${q.tokenIn.symbol} for this swap, nothing more.`,
          rows: [...need.map((a, i) => [`Step ${i + 1}`, a.label]), ["Token", `${q.tokenIn.symbol} · ${short(q.tokenIn.address)}`], ["Network", net]],
          confirmLabel: "Approve in wallet",
        });
        if (!okA) { st.busy = false; paint(); return; }
        for (const [i, a] of need.entries()) {
          st.busy = `Approval ${i + 1} of ${need.length}: confirm in your wallet…`; paint();
          const ah = await sendTx(chain, a.tx);
          st.busy = `Waiting for approval ${i + 1}…`; paint();
          const ar = await waitReceipt(chain, ah);
          if (!ar || ar.status !== 1) throw new Error("The approval did not go through. Nothing was swapped.");
        }
        toast(`${q.tokenIn.symbol} approved`, "ok");
        await regate(q, "Running Troya Gate again after the approval…");
        built = await api.post("swap/build", buildArgs);
        if ((built.approvals || []).some((a) => a.needed)) throw new Error("The approval is not visible on chain yet. Wait a few seconds and try again.");
      }
      const fq = built.quote;
      const ok = await review({
        title: "Review swap",
        summary: `${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol} → about ${amount(Number(fq.amountOut))} ${fq.tokenOut.symbol}`,
        rows: [
          ["You pay", `${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol}`],
          ["You receive (est.)", `${amount(Number(fq.amountOut))} ${fq.tokenOut.symbol}`],
          ["Minimum received", `${amount(Number(fq.minOut))} ${fq.tokenOut.symbol}`],
          ["Slippage", `${st.slip / 100}%`],
          ["Price impact", fq.priceImpact == null ? "–" : `${(fq.priceImpact * 100).toFixed(2)}%`],
          ["Route", fq.route.label],
          ["Recipient", `${short(wallet.address)} (you)`],
          ["Network", net],
        ],
        warn: fq.warnings?.length ? fq.warnings.join(" ") : null,
        confirmLabel: "Swap in wallet",
      });
      if (!ok) { st.busy = false; paint(); return; }
      if (Date.now() - st.gateAt > 45000) await regate(q, "Running Troya Gate again…");
      st.busy = "Confirm in your wallet…"; paint();
      const hash = await sendTx(chain, built);
      const cname = CHAINS[chain].name;
      clear(txBox, h("div", { class: "muted" }, "Submitted ", h("a", { class: "mono link", href: `${CHAINS[chain].explorer}/tx/${hash}`, target: "_blank", rel: "noopener" }, short(hash, 6)), ` · waiting for ${cname}…`));
      st.busy = `Waiting for ${cname}…`; paint();
      const rc = await waitReceipt(chain, hash);
      if (rc && rc.status === 1) {
        toast(`Swapped ${amount(Number(fq.amountIn))} ${fq.tokenIn.symbol} for ${fq.tokenOut.symbol}`, "ok", 5000);
        clear(txBox, h("div", { class: "alert ok" }, icon("check"), ` Swap confirmed · `, h("button", { class: "link", type: "button", onclick: () => navigator.clipboard?.writeText(hash).then(() => toast("Hash copied", "ok")) }, short(hash, 6))));
        journal({ kind: "swap", chain, hash, status: "confirmed", venue: fq.venue, tokenIn: fq.tokenIn.address, tokenOut: fq.tokenOut.address, amountIn: fq.amountIn, amountOut: fq.amountOut, rationale: "Manual swap from the Swap page" });
        st.amount = ""; sellInput.value = "";
        reset();
      } else if (rc) {
        clear(txBox, h("div", { class: "alert error" }, "The swap reverted on chain. Only the network fee was spent."));
        journal({ kind: "swap", chain, hash, status: "reverted", venue: fq.venue });
      } else {
        clear(txBox, h("div", { class: "alert warn" }, `Still waiting for ${cname} to include it. It is not lost: keep the hash `, h("span", { class: "mono" }, short(hash, 6)), "."));
      }
    } catch (e) {
      toast(e?.gate ? e.message : errText(e), "error", e?.gate ? 8000 : 5000);
      swapFailed(e);
    } finally {
      st.busy = false;
      if (alive) { paint(); refreshBal(); }
    }
  }

  const off = onWallet(() => { if (!isSolNet()) { refreshBal(); paint(); } });
  const offSol = onSol(() => { if (isSolNet()) { refreshBal(); paint(); if (st.quote) { reset(); requote(); } } });
  if (isSolNet()) restoreSol().then(() => { refreshBal(); paint(); });
  render();
  if (st.amount) requote();
  return () => { alive = false; off(); offSol(); clearInterval(ageTick); fitObs?.disconnect(); try { chartObj?.remove(); } catch {} };
}
