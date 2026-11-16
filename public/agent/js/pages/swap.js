// Swap (#/swap?chain=&in=&out=): Robinhood Chain (Pons curves, Uniswap v3 / v4, the other launchpads through KyberSwap),
// Base and Arbitrum (KyberSwap). The network picker sits above the card; ?chain=base|arbitrum opens on that network.
// Quotes and the Troya Gate come from the server; every transaction is signed in the user's wallet.
import { h, clear, pageHead, seg, icon, modal, review, toast, tokenIcon, chainLogo, venueLogo, tiny, num, short, useCss, debounce, infoTip } from "../ui.js";
import { wallet, onWallet, openConnect, CHAINS } from "../wallet.js";
import { api } from "../api.js";
import { ETH, isNative, balanceOf, toRaw, fromRaw, inputNum, rawInput, sendTx, waitReceipt, errText, journal } from "../chain.js";
import { sol, onSol, connectSol, restoreSol, signAndSendSol, solWallets } from "../solana.js";

const SLIPS = [{ value: 100, label: "1%" }, { value: 300, label: "3%" }, { value: 500, label: "5%" }];
const NETS = [{ key: "robinhood", label: "Robinhood" }, { key: "base", label: "Base" }, { key: "arbitrum", label: "Arbitrum" }, { key: "solana", label: "Solana" }];
const SOLT = { address: "native", symbol: "SOL", name: "Solana", decimals: 9 };
const SOL_KEEP = 10n ** 7n; // 0.01 SOL kept for fees and the token account rent by Max
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GAS_KEEP = 10n ** 14n; // 0.0001 ETH left for gas by Max (a swap costs well under that on these L2s)

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
  clear(view,
    pageHead("Swap", "Trade on Robinhood Chain (Pons curves, Uniswap v3/v4 pools and every other Robinhood Chain launchpad), Base, Arbitrum and Solana. Troya Gate checks every swap; you sign it in your own wallet."),
    h("div", { class: "sw-wrap" }, h("div", { class: "sw-net" }, netChip), body));

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
  const gateBox = h("div", { class: "gate-box sw-gate" });
  const warnBox = h("div", { class: "sw-warn" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => act() });
  const txBox = h("div", { class: "sw-tx" });

  const card = h("div", { class: "sw-card panel" },
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "Sell"), sellBal),
      h("div", { class: "sw-leg-main" }, sellInput, sellTok),
      quick),
    h("div", { class: "sw-mid" }, flip),
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "Buy"), buySub),
      h("div", { class: "sw-leg-main" }, buyOut, buyTok)),
    h("div", { class: "sw-meta" }, h("span", { class: "muted" }, "Slippage"), slipSeg,
      infoTip("The most the price may move against you between quote and inclusion. If it moves further, the swap reverts and only the network fee is spent.")),
    rows, warnBox, gateBox, btn, txBox);
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
    clear(body, card, note);
    paint();
  }

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
      clear(sellBal, `Balance ${tiny(st.bal.amount)} ${st.sell.symbol}`);
      sellBal.disabled = false;
    } else { clear(sellBal, who() ? "Balance …" : ""); sellBal.disabled = true; }
    clear(quick, isNative(st.sell)
      ? [...(isSolNet() ? ["0.05", "0.1", "0.5", "1"] : ["0.005", "0.01", "0.05", "0.1"]).map((v) => h("button", { type: "button", class: "chip", onclick: () => { sellInput.value = v; sellInput.dispatchEvent(new Event("input")); } }, `${v} ${nativeOf().symbol}`)),
        who() && st.bal?.raw > (isSolNet() ? SOL_KEEP : GAS_KEEP) ? h("button", { type: "button", class: "chip", title: `Everything but a little ${nativeOf().symbol} kept for fees`, onclick: () => setMax() }, "Max") : null]
      : who() && st.bal?.raw > 0n ? [25, 50, 75, 100].map((p) => h("button", { type: "button", class: "chip", onclick: () => setPct(p) }, p === 100 ? "Max" : `${p}%`)) : []);
    // output
    const q = st.quote;
    clear(buyOut, q ? tiny(Number(q.amountOut)) : st.loading ? h("span", { class: "sk sw-sk" }) : "0");
    buyOut.classList.toggle("dim", !q);
    clear(buySub, q && q.side === "buy" ? `≈ ${tiny(Number(q.amountOut) / Number(q.amountIn))} per ${nativeOf().symbol}` : q?.ethUsd && q.side === "sell" ? `≈ $${tiny(Number(q.amountOut) * q.ethUsd)}` : "");
    // rows
    if (q) {
      const outSym = q.tokenOut.symbol, inSym = q.tokenIn.symbol;
      clear(rows,
        h("div", {}, h("span", {}, "Rate"), h("span", {}, `1 ${inSym} = ${tiny(q.rate)} ${outSym}`)),
        h("div", {}, h("span", {}, "Minimum received"), h("span", {}, `${tiny(Number(q.minOut))} ${outSym}`)),
        h("div", {}, h("span", {}, "Price impact"), h("span", { class: q.priceImpact > 0.05 ? "down" : "" }, q.priceImpact == null ? "–" : `${(q.priceImpact * 100).toFixed(2)}%`)),
        h("div", {}, h("span", {}, "Fees and taxes"), h("span", {}, q.feePct == null ? "–" : `${num(q.feePct, 2)}%`)),
        h("div", {}, h("span", {}, "Route"), h("span", { class: "tok-link" }, venueLogo(q.route.venue || q.route.label, 14), q.route.label)),
        q.route.pons && !q.route.pons.graduated ? h("div", {}, h("span", {}, "Pons curve"), h("span", {}, `${num(q.route.pons.progressPct, 1)}% to graduation`)) : null,
        h("div", {}, h("span", {}, "Network fee"), h("span", {}, `Shown in your wallet (${nativeOf().symbol})`)));
    } else clear(rows);
    rows.hidden = !q;
    // warnings
    const warns = [...(q?.warnings || [])];
    if (st.quoteErr) warns.unshift(st.quoteErr);
    clear(warnBox, warns.map((w) => h("div", { class: `alert ${st.quoteErr === w ? "error" : "warn"}` }, w)));
    // gate
    paintGate();
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

  function paintGate() {
    if (!st.quote && !st.gating) { gateBox.hidden = true; return; }
    gateBox.hidden = false;
    const g = st.gate;
    const head = h("div", { class: "gh" }, icon("shield"), "Troya Gate",
      g && st.gateAt ? h("span", { class: "gate-age", "data-gate-age": "" }, gateAge()) : null,
      h("span", { class: `badge-s ${g ? (g.pass ? "blue" : "down") : ""}` }, g ? (g.pass ? (g.checks.some((c) => c.status === "warn") ? "Passed with notes" : "Passed") : "Blocked") : "Checking…"));
    if (!g) { clear(gateBox, head, h("div", { class: "muted" }, "Simulating the exact swap and a test sell…")); return; }
    clear(gateBox, head, h("ul", {}, g.checks.map((c) => h("li", { class: c.status === "skip" ? "skipped" : c.status }, h("span", {}, c.label), h("b", { title: c.detail || "" }, c.status === "skip" ? (c.detail || "Skipped") : c.detail || c.status)))),
      h("div", { class: "gate-note" }, "Runs again the moment you press Swap, on the pool as it is then."));
  }
  function gateAge() {
    const s = Math.max(0, Math.round((Date.now() - st.gateAt) / 1000));
    return s < 60 ? `checked ${s}s ago` : `checked ${Math.floor(s / 60)}m ago`;
  }
  const ageTick = setInterval(() => { const el = gateBox.querySelector("[data-gate-age]"); if (el && st.gateAt) el.textContent = gateAge(); }, 1000);

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
    } catch (e) {
      if (!alive || seq !== st.seq) return;
      st.quote = null; st.quoteErr = e.message; st.loading = false;
      paint();
    }
  }, 380);

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
            ...toks.map((t) => row(t, t.launchpad ? h("span", { class: "badge-s" }, t.launchpad) : t.liquidityUsd ? h("span", { class: "badge-s" }, t.liquidityUsd >= 1e6 ? `$${num(t.liquidityUsd / 1e6, 1)}M liq.` : `$${num(t.liquidityUsd / 1e3, 0)}K liq.`) : null)),
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
              c.copy ? h("span", { class: "badge-s warn", title: "A small coin borrowing the ticker of a bigger one. Check the address." }, "Copy?")
                : h("span", { class: "badge-s" }, c.kind === "stock" ? "Stock" : c.launchpad || (c.liquidityUsd ? liq(c.liquidityUsd) : "Coin")))),
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
          ...stocks.map((t) => row({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals ?? null, image: t.image }, h("span", { class: "badge-s" }, "Stock"))),
          ...toks.map((t) => row({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals ?? null, image: t.image }, t.launchpad ? h("span", { class: "badge-s" }, t.launchpad) : null)),
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
        summary: `${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol} → about ${tiny(Number(fq.amountOut))} ${fq.tokenOut.symbol}`,
        rows: [
          ["You pay", `${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol}`],
          ["You receive (est.)", `${tiny(Number(fq.amountOut))} ${fq.tokenOut.symbol}`],
          ["Minimum received", `${tiny(Number(fq.minOut))} ${fq.tokenOut.symbol}`],
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
        toast(`Swapped ${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol} for ${fq.tokenOut.symbol}`, "ok", 5000);
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
          summary: `Exactly ${tiny(Number(q.amountIn))} ${q.tokenIn.symbol} for this swap, nothing more.`,
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
        summary: `${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol} → about ${tiny(Number(fq.amountOut))} ${fq.tokenOut.symbol}`,
        rows: [
          ["You pay", `${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol}`],
          ["You receive (est.)", `${tiny(Number(fq.amountOut))} ${fq.tokenOut.symbol}`],
          ["Minimum received", `${tiny(Number(fq.minOut))} ${fq.tokenOut.symbol}`],
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
        toast(`Swapped ${tiny(Number(fq.amountIn))} ${fq.tokenIn.symbol} for ${fq.tokenOut.symbol}`, "ok", 5000);
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
  return () => { alive = false; off(); offSol(); clearInterval(ageTick); };
}
