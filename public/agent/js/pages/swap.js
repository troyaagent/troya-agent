// Swap (#/swap?chain=&in=&out=): Robinhood Chain (Pons curves, Uniswap v3 / v4, the other launchpads through KyberSwap),
// Base and Arbitrum (KyberSwap). The network picker sits above the card; ?chain=base|arbitrum opens on that network.
// Quotes and the Troya Gate come from the server; every transaction is signed in the user's wallet.
import { h, clear, pageHead, seg, icon, modal, review, toast, tokenIcon, chainLogo, venueLogo, padLogo, tiny, num, amount, compact, price, usd, pctEl, short, useCss, debounce, infoTip } from "../ui.js";
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
const PAD_NAME = { uniswap: "Uniswap", ramses: "Ramses", pons: "Pons", long: "Long.xyz", frontier: "Frontier", o1: "o1 Launchpad", clank: "Clank.trade", easya: "EasyA", hoodit: "Hoodit", clanker: "Clanker", bankr: "Bankr", virtuals: "Virtuals", mintclub: "Mint Club", pancake: "PancakeSwap", sushi: "SushiSwap", aerodrome: "Aerodrome", pumpfun: "pump.fun", "pump.fun": "pump.fun", raydium: "Raydium", meteora: "Meteora", bonk: "Bonk", kyber: "KyberSwap" };
const padName = (id) => { const k = String(id || "").toLowerCase(); return PAD_NAME[k] || (k ? k.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : ""); };
const padBadge = (id) => h("span", { class: "badge-s sw-pad" }, padLogo(id, 12), padName(id));
const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
// a dollar price only for tokens known by address: coin names are free, so a coin called "USDC" is never priced at $1
const WETHS = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x4200000000000000000000000000000000000006", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"]);
const USD1 = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]); // USDG · USDC Base · USDC, USDT Arbitrum · USDC, USDT Solana
const akey = (a) => (/^0x/i.test(String(a || "")) ? String(a).toLowerCase() : String(a || ""));
const MAJOR = /^(USDG|WETH|USDC|USDT)$/i;
/** A typed or pasted amount as a plain decimal. "2,767,478.18" (commas next to a point, or more than one comma) keeps
 *  every digit; a lone comma is a decimal point, as many keyboards type it. A second point is dropped while typing. */
function cleanAmt(s) {
  let v = String(s ?? "").replace(/[\s _'’]/g, "");
  const commas = (v.match(/,/g) || []).length;
  v = (commas && v.includes(".")) || commas > 1 ? v.replace(/,/g, "") : v.replace(/,/g, ".");
  v = v.replace(/[^\d.]/g, "");
  return v.split(".").length > 2 ? v.slice(0, v.lastIndexOf(".")) : v;
}
/** "about 40 s" under a minute and a half, "about 10 min" from there (route times from LI.FI). */
const secText = (s) => (s ? `about ${s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`}` : "a few minutes");
/** The Gate's own count: a check that did not run ("skip") is neither passed nor failed, so the ring and the tally leave it out. */
function gateCount(g) {
  const cs = g?.checks || [];
  const n = (s) => cs.filter((c) => c.status === s).length;
  const passed = n("pass"), failed = n("fail"), notes = n("warn"), skipped = n("skip");
  // "6 passed · 1 not measured" reads clearer than "6 of 7 passed" next to a Passed verdict (the Gate card's wording)
  const tally = [`${passed} passed`, failed ? `${failed} failed` : "", notes ? `${notes} to note` : "", skipped ? `${skipped} not measured` : ""].filter(Boolean).join(" · ");
  return { passed, failed, notes, skipped, total: cs.length - skipped, tally };
}
const GATE_COPY = "Pick a coin and an amount. Troya runs its checks (seven on Robinhood Chain), a simulated swap and a test sell included, before your wallet can sign.";
// A stand-in sender for cross-chain quotes before a wallet is connected (LI.FI quotes the burn address like any wallet).
// A quote made for it is a preview only: it is never signed, Review always fetches the route again for the real wallet.
const PREVIEW_FROM = "0x000000000000000000000000000000000000dEaD";
const QUOTE_EVERY = 25_000;      // a quote on screen is fetched again this often while the page is visible
const QUOTE_MAX_AGE = 30_000;    // a cross-chain route older than this is fetched again before its review opens
const REVIEW_MAX_AGE = 120_000;  // a route whose review stayed open longer is fetched and shown once more before signing
/* ---------- the picker remembers the last coins picked on each network (this browser only) ---------- */
const RECENT_KEY = "troya.swap.recent";
const recentOk = (chain, x) => !!x && typeof x.symbol === "string" && typeof x.address === "string"
  && (chain === "solana" ? MINT.test(x.address) : /^0x[0-9a-fA-F]{40}$/.test(x.address));
function recentPicks(chain) {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => x?.chain === chain && recentOk(chain, x)).slice(0, 5) : [];
  } catch { return []; }
}
function rememberPick(chain, t) {
  if (!t || isNative(t) || !recentOk(chain, t)) return;
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    const was = Array.isArray(v) ? v.filter((x) => recentOk(x?.chain, x) && !(x.chain === chain && akey(x.address) === akey(t.address))) : [];
    // decimals are not kept: the picker reads them from the chain again, so a stale entry can never size an amount
    const img = /^(https:|\/)/.test(String(t.image || "")) ? String(t.image).slice(0, 300) : null;
    was.unshift({ chain, address: t.address, symbol: String(t.symbol).slice(0, 32), name: String(t.name || "").slice(0, 64), image: img });
    localStorage.setItem(RECENT_KEY, JSON.stringify(was.slice(0, 30)));
  } catch { /* private mode or storage full: the picker still works, only without Recent */ }
}

export async function mount(view, ctx) {
  useCss("swap");
  let alive = true;
  const st = {
    sell: ETH, buy: null, amount: "", slip: Math.round((ctx.prefs.get().slippage || 1) * 100),
    quote: null, quoteAt: 0, quoteErr: null, loading: false, refreshing: false, loadAt: 0, gate: null, gateAt: 0, gating: false, bal: null, busy: false, seq: 0, ethUsd: null,
    chain: NETS.some((n) => n.key === ctx.query.chain) ? ctx.query.chain : "robinhood",
  };
  const blocked = () => !!(st.gate && !st.gate.pass);
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
  // with no coin chosen yet, the right column offers a few to start from instead of an empty Gate
  const popCard = h("section", { class: "panel sw2-route sw2-pop", hidden: true });
  const gateCard = h("section", { class: "panel sw2-gate" });
  const routeCard = h("section", { class: "panel sw2-route" });
  const chartCard = h("section", { class: "panel sw2-chart", hidden: true });
  clear(view,
    h("div", { class: "sw2" },
      h("div", { class: "sw2-l" }, h("div", { class: "sw-net" }, netChip), body),
      h("div", { class: "sw2-r" }, popCard, gateCard, routeCard, chartCard)));

  // sell leg
  const sellInput = h("input", { class: "sw-amt", inputmode: "decimal", placeholder: "0", autocomplete: "off", spellcheck: "false", "aria-label": "Amount to sell", value: st.amount });
  const sellTok = h("button", { class: "sw-tok", type: "button", onclick: () => pick("sell") });
  const sellBal = h("button", { class: "sw-bal", type: "button", onclick: () => setMax() });
  const quick = h("div", { class: "sw-quick" });
  const payUsd = h("div", { class: "sw-sub" });
  // buy leg
  const buyOut = h("div", { class: "sw-amt out", "aria-live": "polite" }, "0");
  const buyTok = h("button", { class: "sw-tok", type: "button", onclick: () => pick("buy") });
  const buySub = h("div", { class: "sw-sub" });
  const getUsd = h("div", { class: "sw-sub" });
  const flip = h("button", { class: "sw-flip", type: "button", "aria-label": "Switch tokens", onclick: () => flipPair() }, icon("swap"));
  // the two boxes trade places: what you would get becomes what you pay (the typed number when there is no quote yet),
  // kept only when the new balance covers it, so a flip never leaves an amount the wallet cannot pay
  async function flipPair() {
    const q = st.quote;
    const carry = q?.amountOutRaw ? { raw: BigInt(q.amountOutRaw) } : st.amount ? { text: st.amount } : null;
    [st.sell, st.buy] = [st.buy || nativeOf(), st.sell];
    if (isNative(st.sell) && isNative(st.buy)) st.buy = null;
    st.amount = ""; sellInput.value = ""; reset(); paint();
    const s = st.sell;
    await refreshBal();
    if (!alive || !carry || st.sell !== s || st.amount || !st.bal) return;
    const dec = s?.decimals ?? 18;
    const raw = carry.raw ?? toRaw(carry.text, dec);
    if (!raw || raw <= 0n || raw > st.bal.raw) return;
    sellInput.value = carry.raw != null ? rawInput(raw, dec, 8) : carry.text;
    sellInput.dispatchEvent(new Event("input"));
  }
  const slipSeg = seg(SLIPS, st.slip, (v) => { st.slip = v; const p = ctx.prefs.get(); ctx.prefs.set({ ...p, slippage: v / 100 }); reset(); requote(); });
  slipSeg.classList.add("sm");
  const rows = h("div", { class: "rows sw-rows" });
  const warnBox = h("div", { class: "sw-warn" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => act() });
  // what the page is doing right now (finding a route, running the checks), under the button as well as in the Gate card
  const statusLine = h("p", { class: "sw2-sign sw-status", hidden: true });
  const txBox = h("div", { class: "sw-tx" });
  // the quote on screen is fetched again every 25 s while the page is visible; this line says when
  const freshLine = h("p", { class: "sw-fresh", hidden: true });
  // phones: the Gate card sits far below the button, so a one-line strip of it sits right above the button (CSS shows
  // it at 760 px and under); a tap scrolls to the full card
  const gateStrip = h("button", { class: "sw-gstrip", type: "button", hidden: true, onclick: () => gateCard.scrollIntoView({ behavior: "smooth", block: "start" }) });

  const card = h("div", { class: "sw-card panel" },
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "You pay"), sellBal),
      h("div", { class: "sw-leg-main" }, sellInput, sellTok),
      payUsd, quick),
    h("div", { class: "sw-mid" }, flip),
    h("div", { class: "sw-leg" },
      h("div", { class: "sw-leg-top" }, h("span", {}, "You get"), buySub),
      h("div", { class: "sw-leg-main" }, buyOut, buyTok), getUsd),
    h("div", { class: "sw-meta" }, h("span", { class: "muted" }, "Slippage"), slipSeg,
      infoTip("The most the price may move against you between quote and inclusion. If it moves further, the swap reverts and only the network fee is spent.", "Slippage")),
    warnBox, gateStrip, btn, statusLine,
    h("p", { class: "sw2-sign" }, "Your wallet signs. Troya never holds your funds. ", h("span", { class: "badge-s", title: "Troya adds no fee of its own to any swap" }, "Troya fee 0%")), rows, freshLine, txBox);
  const note = h("p", { class: "note sw-note" });
  // phones: the network note moves under the Gate card, so the card, the Gate strip and the button come first
  const phoneMq = typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null;
  function placeNote() {
    if (phoneMq?.matches) { if (note.previousElementSibling !== gateCard) gateCard.after(note); }
    else if (note.parentNode !== body || body.lastElementChild !== note) body.append(note);
  }
  phoneMq?.addEventListener?.("change", placeNote);
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
    const fixed = cleanAmt(sellInput.value);
    if (fixed !== sellInput.value) sellInput.value = fixed;
    st.amount = fixed;
    reset();
    paint();
    requote();
  });

  function render() {
    clear(body, card, xcBox, note);
    placeNote();
    paint();
  }

  /* ---------- one balance, every chain: buy this coin with ETH that sits on another chain, one signature there ----------
     Robinhood coin: pay from Base or Arbitrum. Base or Arbitrum coin: pay with ETH on Robinhood Chain. LI.FI bridges and
     buys for exactly this amount; the server runs this chain's Troya Gate on the coin first and refuses a route if it fails. */
  const XC_SRC = { robinhood: [{ key: "base", id: 8453, name: "Base" }, { key: "arbitrum", id: 42161, name: "Arbitrum" }], base: [{ key: "robinhood", id: 4663, name: "Robinhood Chain" }], arbitrum: [{ key: "robinhood", id: 4663, name: "Robinhood Chain" }] };
  const XC_GAS = 3n * 10n ** 14n; // 0.0003 ETH left on the source chain for the transaction's own gas
  // qFor: the address the route was quoted for (the stand-in PREVIEW_FROM until a wallet is connected)
  const xc = { open: false, src: null, amount: "", bal: null, q: null, qAt: 0, qFor: "", err: null, gate: null, loading: false, refreshing: false, seq: 0, busy: false, key: "", status: null, auto: "" };
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
    const fixed = cleanAmt(xcInput.value);
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
    // a coin the Gate blocked here is not offered through another chain either (the server would refuse it too)
    const was = xcBox.hidden;
    xcBox.hidden = !coin || blocked();
    if (xcBox.hidden) return;
    const key = `${st.chain}:${coin.address.toLowerCase()}`;
    if (key === xc.key) { if (was) xcPaint(); return; }
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
  const xcGet = (coin, s, d, raw, from) => api.get(`bridge/cross-buy?${new URLSearchParams({ fromChain: String(s.id), toChain: String(d.id), toToken: coin.address, address: from, amountWei: raw.toString(), slippage: String(Math.max(st.slip, 300) / 10000) })}`);
  const xcPreview = () => !!xc.q && xc.qFor !== String(wallet.address || "").toLowerCase();
  // without a wallet the route is quoted for a stand-in address, so the amount, fees and time show before connecting;
  // quiet: a refresh of the route already on screen (it stays visible while the new one loads)
  async function xcFetch(quiet = false) {
    if (xc.busy) return;   // Review is fetching the exact route itself
    const coin = xcCoin(), raw = toRaw(xc.amount, 18);
    if (!coin || !xc.open || !raw || raw <= 0n) { xc.loading = false; xc.refreshing = false; xcPaint(); return; }
    const seq = ++xc.seq, s = xcSrc(), d = xcDest(), from = wallet.address || PREVIEW_FROM;
    xc.refreshing = quiet;
    if (!quiet) { xc.loading = true; xc.err = null; xc.gate = null; }
    xcPaint();
    try {
      const q = await xcGet(coin, s, d, raw, from);
      if (seq !== xc.seq || !alive) return;
      xc.q = q; xc.qAt = Date.now(); xc.qFor = from.toLowerCase(); xc.gate = q.gate; xc.err = null;
    } catch (e) {
      if (seq !== xc.seq || !alive) return;
      // a refresh that misses for a network reason tries once the normal way; a Gate that now blocks the coin shows at once
      if (quiet && !e?.data?.gate) { xc.refreshing = false; xcFetch(false); return; }
      xc.q = null; xc.err = e.message; xc.gate = e?.data?.gate || null;
    }
    xc.loading = false; xc.refreshing = false; xcPaint();
  }
  const xcQuote = debounce(() => xcFetch(false), 600);
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
    const preview = xcPreview();
    const rows = q ? h("div", { class: "rows sw-rows" },
      preview ? h("p", { class: "sw-preview" }, icon("info"), "Preview, connect to get your exact route") : null,
      h("div", {}, h("span", {}, "You get (est.)"), h("span", {}, `${amount(Number(fromRaw(q.toAmount, q.toDecimals)))} ${q.toSymbol}`)),
      h("div", {}, h("span", {}, "Minimum"), h("span", {}, `${amount(Number(fromRaw(q.toAmountMin, q.toDecimals)))} ${q.toSymbol}`)),
      h("div", {}, h("span", {}, "Route"), h("span", {}, `${q.tool} via LI.FI`)),
      h("div", {}, h("span", {}, "Time"), h("span", {}, secText(q.executionSec))),
      h("div", {}, h("span", {}, "Route fees"), h("span", {}, `$${num(q.feeUsd + q.gasUsd, 2)}`)),
      gateRow,
      h("div", {}, h("span", {}, "Troya fee"), h("span", {}, "None"))) : g ? h("div", { class: "rows sw-rows" }, gateRow) : null;
    const notes = [];
    if (xc.err) notes.push(h("div", { class: "alert error" }, xc.err));
    else if (g?.verdict === "caution" && g.why) notes.push(h("div", { class: "alert warn" }, g.why));
    const raw = toRaw(xc.amount, 18);
    // the wallet is asked for at Review: before that the route is a preview quoted for a stand-in address
    let label = `Buy $${coin.symbol} with ETH on ${s.name}`, disabled = false;
    if (!raw || raw <= 0n) { if (wallet.address) { label = "Enter an amount"; disabled = true; } else label = "Connect wallet"; }
    else if (wallet.address && xc.bal && raw + XC_GAS > xc.bal.raw) { label = `Not enough ETH on ${s.name}`; disabled = true; }
    else if (xc.loading) { label = `Checking $${coin.symbol} and finding a route…`; disabled = true; }
    else if (!q) { label = xc.err ? (g?.verdict === "failed" ? "Blocked by Troya Gate" : "No route") : "Finding a route…"; disabled = true; }
    else if (!wallet.address) label = "Connect and review";
    if (xc.busy) { label = xc.busy; disabled = true; }
    const btnX = h("button", { class: "btn primary", type: "button", disabled, onclick: () => xcAct() }, label);
    const fresh = q && raw && !xc.busy ? h("p", { class: "sw-fresh", "data-xc-fresh": "" }, xcFreshText()) : null;
    clear(xcOut, rows, ...notes, btnX, fresh, xc.status,
      h("p", { class: "fine muted sw-xc-fine" }, `One transaction on ${s.name}, signed in your wallet. LI.FI moves the ETH and buys $${coin.symbol} on ${d.name} for this amount only, delivered to your same address. Troya adds no fee.`));
  }
  async function xcAct() {
    if (xc.busy) return;
    if (!wallet.address) {
      // the wallet is asked for here, at Review: with one connected, the review below opens on its exact route
      await openConnect();
      if (!alive || !wallet.address) return;
      if (!xc.q) { xcBal(); xcQuote(); return; }
    }
    const coin = xcCoin(), s = xcSrc(), d = xcDest(), raw = toRaw(xc.amount, 18);
    if (!coin || !raw || raw <= 0n || !xc.q) return;
    const me = wallet.address.toLowerCase();
    try {
      if (!xc.bal) { xc.busy = "Reading your balance…"; xcPaint(); await xcBal(); }
      if (xc.bal && raw + XC_GAS > xc.bal.raw) { toast(`Not enough ETH on ${s.name} for this amount and its gas.`, "error", 6000); return; }
      let q = null;
      const amt = fromRaw(raw);
      for (let round = 0; ; round++) {
        // the route is fetched again for this wallet when it was a preview (a stand-in address) or is older than 30 s:
        // the Gate and the route are checked once more on the coin as it is now
        if (!q && (!xc.q || xc.qFor !== me || Date.now() - xc.qAt > QUOTE_MAX_AGE)) {
          xc.busy = xc.qFor !== me ? "Finding your exact route…" : "Running Troya Gate again…"; xcPaint();
          xc.seq++;   // a refresh already on its way answers for the old route
          try {
            const q2 = await xcGet(coin, s, d, raw, wallet.address);
            Object.assign(xc, { q: q2, qAt: Date.now(), qFor: me, gate: q2.gate, err: null });
          } catch (e) { if (e?.data?.gate) Object.assign(xc, { q: null, err: e.message, gate: e.data.gate }); throw e; }
          if (!alive) return;
        }
        q = q || xc.q;
        // only a route quoted for this wallet is ever signed (a preview delivers to the stand-in address)
        if (xc.qFor !== me || !q?.tx?.to || String(q.toAddress || me).toLowerCase() !== me) throw new Error("That route was not quoted for your wallet. Nothing was sent. Try again.");
        const got = Number(fromRaw(q.toAmount, q.toDecimals)), min = Number(fromRaw(q.toAmountMin, q.toDecimals));
        xc.busy = "Waiting for your review…"; xcPaint();
        const ok = await review({ title: "Review cross-chain buy", summary: `${tiny(amt)} ETH on ${s.name} → about ${amount(got)} ${q.toSymbol} on ${d.name}`, confirmLabel: `Buy in wallet`,
          rows: [["You pay", `${tiny(amt)} ETH on ${s.name}`], ["You receive (est.)", `${amount(got)} ${q.toSymbol} on ${d.name}`], ["Minimum", `${amount(min)} ${q.toSymbol}`], ["Troya Gate", `${q.gate.verdict === "caution" ? "Passed with notes" : "Passed"} · ${q.gate.passed}/${q.gate.total} on ${d.name}`],
            ["Route", `${q.tool} via LI.FI`], ["Time", secText(q.executionSec)], ["Route fees", `$${num(q.feeUsd + q.gasUsd, 2)}`], ["Recipient", `${short(wallet.address)} (you) on ${d.name}`], ["Contract", short(q.tx.to)]],
          warn: `Sent through a third-party route (LI.FI${q.tool ? `, ${q.tool}` : ""}): Troya cannot reverse it once it is sent.${q.gate.verdict === "caution" && q.gate.why ? ` Gate note: ${q.gate.why}` : ""}` });
        if (!ok || !alive) return;
        // a review left open for two minutes: the route and the Gate run again and the review shows once more
        if (Date.now() - xc.qAt <= REVIEW_MAX_AGE && xc.q === q) break;
        if (round >= 2) throw new Error("The route kept changing while the review was open. Nothing was sent. Try again.");
        q = null; xc.qAt = 0;
        toast("The review stayed open a while, so the route was fetched again. Check it once more.", "", 5000);
      }
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
  /* ---------- not enough ETH on Robinhood Chain: pay from Base or Arbitrum, or bridge in ----------
     Base and Arbitrum ETH are read once per connected address. The panel only opens and fills an amount: the person
     still reviews the route and signs on the other chain, and the server runs this chain's Troya Gate first. */
  const xb = { addr: "", base: null, arbitrum: null, p: null };
  function readOtherEth() {
    if (!wallet.address || xb.addr === wallet.address) return xb.p;
    const a = wallet.address;
    Object.assign(xb, { addr: a, base: null, arbitrum: null });
    xb.p = Promise.all(["base", "arbitrum"].map((k) => balanceOf(a, ETH, k).then((b) => { if (xb.addr === a) xb[k] = b; }).catch(() => {})))
      .then(() => { if (alive && xb.addr === a) paint(); });
    return xb.p;
  }
  // the ETH shortfall on Robinhood Chain for this buy (0n when there is none or it is not an ETH buy there)
  const ethShort = () => {
    if (st.chain !== "robinhood" || !isNative(st.sell) || !st.bal || !wallet.address) return 0n;
    const amt = toRaw(st.amount, 18);
    return amt && amt > st.bal.raw ? amt - st.bal.raw : 0n;
  };
  // the source chain holding the most ETH above its own gas, or null
  const richSrc = () => xcSrcs().map((x) => ({ k: x.key, raw: xb[x.key]?.raw ?? 0n })).filter((x) => x.raw > XC_GAS).sort((a, b) => (b.raw > a.raw ? 1 : -1))[0]?.k || null;
  function openXc(src) {
    syncXc();
    if (xcBox.hidden) return false;
    if (src && src !== xc.src) { xc.src = src; xc.q = null; xc.err = null; xc.gate = null; xc.seq++; }
    if (!xc.open) { xc.open = true; xcToggle.setAttribute("aria-expanded", "true"); xcBody.hidden = false; }
    xcBal(); xcPaint();
    // the amount they meant to pay, when that chain holds it plus gas
    const raw = toRaw(st.amount, 18), b = xb[xc.src];
    if (!xc.amount && raw && b && raw + XC_GAS <= b.raw) { xcInput.value = st.amount; xcInput.dispatchEvent(new Event("input")); }
    else xcQuote();
    return true;
  }
  async function addEth() {
    await readOtherEth();
    if (!alive) return;
    const src = richSrc();
    if (src && openXc(src)) { xcBox.scrollIntoView({ behavior: "smooth", block: "nearest" }); setTimeout(() => xcInput.focus(), 350); return; }
    // neither chain holds ETH: the Bridge page, with the missing amount (rounded up, plus a little for gas) filled in
    const need = ethShort() + GAS_KEEP, step = 10n ** 12n;
    location.hash = `#/bridge?amount=${rawInput(((need + step - 1n) / step) * step, 18, 6)}`;
  }
  // a long quote shrinks to fit its box (down to 22px), then reads in compact notation (5.86M) and may shrink to 16px,
  // instead of being cut mid-number; the full amount stays in the title
  function fitOut() {
    buyOut.style.fontSize = "";
    const q = st.quote, v = q ? Number(q.amountOut) : NaN;
    if (q && !buyOut.querySelector(".sk")) buyOut.textContent = amount(v);
    if (!buyOut.isConnected || !buyOut.clientWidth) return;
    const over = () => buyOut.scrollWidth > buyOut.clientWidth + 1;
    const base = parseFloat(getComputedStyle(buyOut).fontSize) || 40;
    const shrink = (min) => { let fs = parseFloat(buyOut.style.fontSize) || base; while (over() && fs > min) { fs -= 2; buyOut.style.fontSize = `${fs}px`; } };
    shrink(22);
    if (over() && q && Math.abs(v) >= 1e4) { buyOut.textContent = compact(v, 2); buyOut.style.fontSize = ""; }
    shrink(16);
  }
  const fitObs = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitOut()) : null;
  fitObs?.observe(buyOut);

  function tokBtn(el, t) {
    clear(el, t ? [tokenIcon({ ...t, chain: st.chain }, "sm"), h("b", {}, t.symbol), icon("arrowRight", "chev")] : [h("span", {}, "Select token"), icon("arrowRight", "chev")]);
    el.classList.toggle("empty", !t);
  }

  function reset() { st.quote = null; st.quoteAt = 0; st.quoteErr = null; st.gate = null; st.gateAt = 0; st.gating = false; st.refreshing = false; st.seq++; }

  function paint() {
    tokBtn(sellTok, st.sell);
    tokBtn(buyTok, st.buy);
    // balance + quick picks
    if (who() && st.bal) {
      clear(sellBal, `Balance ${amount(st.bal.amount)} ${st.sell.symbol}`);
      sellBal.disabled = false;
    } else { clear(sellBal, who() ? "Balance …" : ""); sellBal.disabled = true; }
    const keep = isSolNet() ? SOL_KEEP : GAS_KEEP;
    // the chip matching the amount in the box is shown pressed
    const on = (v) => String(!!st.amount && v === st.amount);
    clear(quick, isNative(st.sell)
      ? [...(isSolNet() ? ["0.05", "0.1", "0.5", "1"] : ["0.005", "0.01", "0.05", "0.1"]).map((v) => h("button", { type: "button", class: "chip", "aria-pressed": String(!!st.amount && Number(st.amount) === Number(v)), onclick: () => { sellInput.value = v; sellInput.dispatchEvent(new Event("input")); } }, `${v} ${nativeOf().symbol}`)),
        who() && st.bal?.raw > keep ? h("button", { type: "button", class: "chip", "aria-pressed": on(maxStr()), title: `Everything but a little ${nativeOf().symbol} kept for fees`, onclick: () => setMax() }, "Max") : null]
      : who() && st.bal?.raw > 0n ? [25, 50, 75, 100].map((p) => h("button", { type: "button", class: "chip", "aria-pressed": on(pctStr(p)), onclick: () => setPct(p) }, p === 100 ? "Max" : `${p}%`)) : []);
    // output
    const q = st.quote;
    clear(buyOut, q ? amount(Number(q.amountOut)) : st.loading ? h("span", { class: "sk sw-sk" }) : "0");
    buyOut.title = q ? `${amount(Number(q.amountOut))} ${q.tokenOut.symbol}` : "";
    buyOut.classList.toggle("dim", !q);
    fitOut();
    clear(buySub, q && q.side === "buy" ? `≈ ${amount(Number(q.amountOut) / Number(q.amountIn))} per ${nativeOf().symbol}` : "");
    const u = usdLegs();
    clear(payUsd, u.pay != null ? `≈ ${usd(u.pay)}` : "");
    clear(getUsd, u.get != null ? `≈ ${usd(u.get)}` : "");
    getUsd.title = u.derived ? "What the coins are worth at today's price, after fees, taxes and price impact" : "";
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
    // popular coins (no coin yet), gate, route, chart
    paintPop();
    paintGate();
    routeCard.hidden = !st.buy;
    paintRoute();
    syncChart();
    syncXc();
    // the first time this coin meets an ETH shortfall here, "Pay from Base or Arbitrum" opens on the chain that holds ETH
    const lack = ethShort();
    if (lack > 0n && !xcBox.hidden && xc.auto !== xc.key) { readOtherEth(); const src = richSrc(); if (src) { xc.auto = xc.key; openXc(src); } }
    // button state
    const amt = toRaw(st.amount, st.sell?.decimals ?? 18);
    let label = "Review swap", disabled = false;
    if (!who()) label = isSolNet() ? "Connect a Solana wallet" : "Connect wallet";
    else if (!st.buy || !st.sell) { label = "Select a token"; disabled = true; }
    else if (!amt || amt <= 0n) { label = "Enter an amount"; disabled = true; }
    else if (lack > 0n) { if (blocked()) { label = "Blocked by Troya Gate"; disabled = true; } else label = "Add ETH to buy"; }
    else if (st.bal && amt > st.bal.raw) { label = `Not enough ${st.sell.symbol}`; disabled = true; }
    else if (st.loading) { label = "Getting a quote…"; disabled = true; }
    else if (!q) { label = st.quoteErr ? "No route" : "Getting a quote…"; disabled = true; }
    else if (st.gate && !st.gate.pass) { label = "Blocked by Troya Gate"; disabled = true; }
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
    paintStrip();
    tickBusy();
    tickFresh();
  }
  // the Gate in one line above the button (phones): verdict, checks passed and the first reason that failed (or a note)
  function paintStrip() {
    const g = st.gate;
    if (!st.buy || (!g && !st.gating && !st.loading)) { gateStrip.hidden = true; gateStrip.dataset.k = ""; return; }
    gateStrip.hidden = false;
    let verdict = "idle", pill = st.gating ? "Checking…" : "Routing…", count = "",
      why = st.gating ? "Simulating the exact swap and a test sell…" : "Finding a route, then Troya runs its checks.";
    if (g) {
      const c = gateCount(g);
      verdict = g.pass ? (c.notes ? "caution" : "passed") : "failed";
      pill = g.pass ? (verdict === "caution" ? "Passed with notes" : "Passed") : "Blocked";
      count = `${c.passed}/${c.total}`;
      const first = (g.checks || []).find((x) => x.status === "fail") || (g.checks || []).find((x) => x.status === "warn");
      why = first ? `${first.label}${first.detail ? `: ${first.detail}` : ""}` : c.tally;
    }
    const k = `${verdict}|${pill}|${count}|${why}`;
    if (gateStrip.dataset.k === k) return;
    gateStrip.dataset.k = k;
    clear(gateStrip, h("span", { class: `dk-v v-${verdict}` }, pill), count ? h("b", { class: "sw-gs-n" }, count) : null,
      h("span", { class: "sw-gs-why" }, why), icon("arrowRight", "chev"));
    gateStrip.title = why;
    gateStrip.setAttribute("aria-label", `Troya Gate: ${pill}${count ? `, ${count} checks passed` : ""}. ${why}. Show every check`);
  }
  /* ---------- fresh quotes: the quote on screen is fetched again every 25 s while the page is visible ----------
     Only the quote: the Gate keeps its verdict and runs again the moment you press Swap. A refresh never blanks the
     numbers; a cross-chain route open below the card refreshes the same way (its Gate runs on the server each time). */
  const secsLeft = (at) => Math.max(0, Math.ceil((at + QUOTE_EVERY - Date.now()) / 1000));
  function xcFreshText() { return xc.refreshing ? "Refreshing the route…" : `Route refreshes in ${secsLeft(xc.qAt)}s`; }
  function tickFresh() {
    const seen = document.visibilityState !== "hidden";
    const on = !!st.quote && !!st.amount && !st.busy;
    if (on && seen && !st.loading && !st.gating && !st.refreshing && Date.now() - st.quoteAt >= QUOTE_EVERY) runQuote(true);
    const t = !on ? "" : st.refreshing ? "Refreshing the quote…" : `Quote refreshes in ${secsLeft(st.quoteAt)}s`;
    if (freshLine.textContent !== t) freshLine.textContent = t;
    freshLine.hidden = !t;
    if (xc.open && !xcBox.hidden && xc.q && toRaw(xc.amount, 18) && !xc.busy && !xc.loading && !xc.refreshing && seen && Date.now() - xc.qAt >= QUOTE_EVERY) xcFetch(true);
    const el = xcOut.querySelector("[data-xc-fresh]");
    if (el) { const x = xcFreshText(); if (el.textContent !== x) el.textContent = x; }
  }
  // ≈ dollars on both legs. A side known by address (ETH, WETH, a dollar stablecoin) is priced directly, at the quote's
  // ETH price; the other side follows through the quote's own fees and price impact, so "You get" is what the coins are
  // worth at today's price. Nothing is shown when neither side has a known price.
  function usdLegs() {
    const q = st.quote, eu = q?.ethUsd || st.ethUsd;
    const unit = (t) => {
      if (!t) return null;
      const a = akey(t.address);
      if (USD1.has(a)) return 1;
      if (isSolNet()) return null;                     // SOL has no price in the quote
      return (isNative(t) || WETHS.has(a)) && eu > 0 ? eu : null;
    };
    const typed = Number(st.amount) || 0;
    let pay = typed > 0 && unit(st.sell) != null ? typed * unit(st.sell) : null, get = null, derived = false;
    if (q) {
      const ui = unit(q.tokenIn), uo = unit(q.tokenOut);
      if (ui != null) pay = Number(q.amountIn) * ui;
      if (uo != null) get = Number(q.amountOut) * uo;
      const keep = q.feePct != null && q.priceImpact != null ? (1 - Number(q.feePct) / 100) * (1 - Number(q.priceImpact)) : null;
      if (keep > 0 && keep <= 1) {
        if (get == null && pay != null) { get = pay * keep; derived = true; }
        else if (pay == null && get != null) pay = get / keep;
      }
    }
    const ok = (v) => (v != null && isFinite(v) && v > 0 ? v : null);
    return { pay: ok(pay), get: ok(get), derived: derived && ok(get) != null };
  }
  const busyLine = () => (st.loading ? `Finding the best route… ${Math.max(0, Math.floor((Date.now() - st.loadAt) / 1000))}s` : st.gating ? "Running the checks…" : "");
  function tickBusy() {
    const t = st.busy ? "" : busyLine();
    if (statusLine.textContent !== t) statusLine.textContent = t;
    statusLine.hidden = !t;
    const el = gateCard.querySelector("[data-busy]");
    if (el && t && el.textContent !== t) el.textContent = t;
  }

  const RC = 2 * Math.PI * 50;
  // the ring is drawn over the checks that ran; before a result it shows what the page is doing instead of a "0/7"
  function ringEl(passed, total, verdict, center) {
    const [big, small] = center || [`${passed}/${total}`, "passed"];
    const el = h("span", { class: `dk-ring sw2-ring v-${verdict}`, role: "img", "aria-label": center ? `Troya Gate: ${small}` : `${passed} of ${total} checks passed` });
    el.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${RC}"/></svg><span class="sw2-ring-c"><b>${big}</b><small>${small}</small></span>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const c = el.querySelector(".rb"); if (c) c.style.strokeDasharray = `${total ? (passed / total) * RC : 0} ${RC}`; }));
    return el;
  }
  let lastGateKey = "";
  function paintGate() {
    const g = st.gate;
    const sym = st.buy && !isNative(st.buy) ? st.buy.symbol : st.sell && !isNative(st.sell) ? st.sell.symbol : null;
    const key = g ? `${st.gateAt}` : !st.buy ? `none:${sym}` : st.gating ? "gating" : st.loading ? "loading" : st.quote ? "quote" : `idle:${sym}`;
    if (key === lastGateKey) return;
    lastGateKey = key;
    const title = h("p", { class: "sw2-mic" }, `The Gate${sym ? ` · $${sym}` : ""}`);
    // no coin chosen yet: what the Gate does, without an empty ring
    if (!g && !st.buy) { clear(gateCard, h("div", { class: "sw2-gh" }, title, h("span", { class: "dk-v" }, "Waiting")), h("p", { class: "sw2-wait" }, GATE_COPY)); return; }
    if (!g) {
      const busy = st.loading || st.gating;
      clear(gateCard, h("div", { class: "sw2-gh" }, title, h("span", { class: "dk-v" }, st.gating ? "Checking…" : st.loading ? "Routing…" : "Waiting")),
        h("div", { class: "sw2-gb" }, ringEl(0, 0, "idle", st.gating ? ["…", "checking"] : st.loading ? ["…", "routing"] : ["–", "waiting"]),
          h("div", {},
            busy ? h("p", { class: "sw2-wait", "data-busy": "" }, busyLine()) : null,
            h("p", { class: busy ? "fine muted" : "sw2-wait" }, st.gating ? "Simulating the exact swap from your address and a test sell…"
              : st.loading ? "Then Troya runs its checks (seven on Robinhood Chain) before your wallet can sign." : GATE_COPY))));
      return;
    }
    const c = gateCount(g);
    const verdict = g.pass ? (c.notes ? "caution" : "passed") : "failed";
    clear(gateCard,
      h("div", { class: "sw2-gh" }, title, st.gateAt ? h("span", { class: "fine muted", "data-gate-age": "" }, gateAge()) : null,
        h("span", { class: `dk-v v-${verdict}` }, g.pass ? (verdict === "caution" ? "Passed with notes" : "Passed") : "Blocked")),
      h("div", { class: "sw2-gb" }, ringEl(c.passed, c.total, verdict),
        h("ul", { class: "sw2-checks" }, g.checks.map((x) => h("li", { class: `c-${x.status}` },
          h("span", { class: "dk-ck" }, x.status === "pass" ? icon("check") : x.status === "fail" ? icon("close") : h("b", {}, x.status === "warn" ? "!" : "–")),
          h("span", { class: "l" }, x.label), h("span", { class: "d", title: x.detail || "" }, x.status === "skip" ? (x.detail || "Skipped") : x.detail || ""))))),
      h("p", { class: "fine muted sw2-gnote" }, `${c.tally}. Runs again the moment you press Swap, on the pool as it is then.`));
  }
  /* ---------- Popular now: a few coins to start from while none is chosen ----------
     Robinhood Chain: $TROYA, the top five Troya picks (a read of live data, never advice) and three stock tokens.
     Base, Arbitrum and Solana: the same popular list the token picker opens with. */
  const pop = { chain: "", rows: null, loading: false, seq: 0 };
  async function loadPop() {
    const chain = st.chain, my = ++pop.seq;
    Object.assign(pop, { chain, rows: null, loading: true });
    let rows = [];
    try {
      if (chain === "robinhood") {
        const [tr, pk, sk] = await Promise.all([
          api.get(`market/robinhood?${new URLSearchParams({ q: TROYA, limit: "3", tradable: "1" })}`).catch(() => null),
          api.get(`market/robinhood?${new URLSearchParams({ cat: "picks", sort: "picks", limit: "8", tradable: "1" })}`).catch(() => null),
          (stocksCache ||= api.get("market/stocks").catch(() => ({ stocks: [] }))),
        ]);
        const troya = (tr?.tokens || []).find((t) => akey(t.address) === TROYA) || { address: TROYA, symbol: "TROYA", name: "Troya Agent" };
        const seen = new Set([TROYA]);
        const take = (t) => !!t?.address && !seen.has(akey(t.address)) && !!seen.add(akey(t.address));
        const picks = (pk?.tokens || []).filter(take).slice(0, 5);
        const stocks = (sk?.stocks || []).filter((t) => t.tradable).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).filter(take).slice(0, 3);
        rows = [{ ...troya, group: "Troya" }, ...picks.map((t, i) => ({ ...t, group: i ? null : "Troya picks" })), ...stocks.map((t, i) => ({ ...t, group: i ? null : "Stock tokens" }))];
      } else {
        const r = await api.get(`swap/tokens?${new URLSearchParams({ q: "", ...cq() })}`);
        rows = (r.tokens || []).filter((t) => t.address && t.address !== "native" && !MAJOR.test(t.symbol || "")).slice(0, 8);
      }
    } catch { rows = []; }
    if (my !== pop.seq || !alive) return;
    pop.rows = rows; pop.loading = false;
    paintPop();
  }
  let lastPopKey = "";
  function paintPop() {
    popCard.hidden = !!st.buy;
    if (st.buy) return;
    if (pop.chain !== st.chain) loadPop();
    const key = `${st.chain}|${pop.seq}|${pop.loading}`;
    if (key === lastPopKey) return;
    lastPopKey = key;
    const head = h("p", { class: "sw2-mic" }, "Popular now");
    if (pop.loading) { clear(popCard, head, h("div", { class: "sk", style: { height: "180px", marginTop: "14px", borderRadius: "14px" } })); return; }
    if (!pop.rows?.length) { clear(popCard, head, h("p", { class: "sw2-wait", style: { marginTop: "10px" } }, "The list is unavailable right now. Choose a coin with Select token.")); return; }
    const liq = (n) => (n >= 1e6 ? `$${num(n / 1e6, 1)}M liq.` : `$${num(n / 1e3, n >= 1e4 ? 0 : 1)}K liq.`);
    const row = (t) => h("div", { class: "tp-row" },
      tokenIcon({ address: t.address, symbol: t.symbol, image: t.image, chain: st.chain }, "sm"),
      h("span", { class: "tp-name" }, h("b", {}, `$${t.symbol}`), h("small", {}, t.name || short(t.address))),
      // the change and the chip keep one line; a long name shortens instead
      h("span", { class: "tp-extra", style: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none" } },
        t.change24h != null ? pctEl(t.change24h) : t.liquidityUsd ? h("span", { class: "badge-s" }, liq(t.liquidityUsd)) : null,
        h("button", { class: "chip", type: "button", "aria-label": `Select $${t.symbol}`, onclick: () => selectBuy(t) }, "Select")));
    clear(popCard, head,
      h("div", { style: { display: "grid", gap: "2px", marginTop: "10px" } }, pop.rows.map((t) => [t.group ? h("div", { class: "tp-load muted", style: { padding: "8px 8px 2px" } }, t.group) : null, row(t)])),
      h("p", { class: "fine muted", style: { margin: "10px 0 0" } }, st.chain === "robinhood" ? "24 h change. Selecting a coin runs Troya Gate on it before you can sign." : "Selecting a coin runs Troya Gate on it before you can sign."));
  }
  async function selectBuy(t) {
    let c = { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals ?? null, image: t.image || null };
    if (c.decimals == null) {
      try { const m2 = await api.get(`token/meta?${new URLSearchParams({ address: c.address, ...cq() })}`); c = { ...c, decimals: m2.decimals, symbol: c.symbol || m2.symbol, name: c.name || m2.name }; }
      catch { toast("Could not read this token from the chain. Try again in a moment.", "error"); return; }
    }
    if (!alive || st.buy) return;
    st.buy = c;
    if (!isNative(st.sell) && akey(st.sell?.address) === akey(c.address)) st.sell = nativeOf();
    reset(); paint(); refreshBal(); requote();
  }
  // the route: the exact path the quote takes, pool by pool
  let lastRouteKey = "";
  // the same coin on Fomo, for people who trade there (Robinhood Chain coins, not ETH, USDG or WETH)
  // a coin the Gate blocked is not pointed to elsewhere either
  const fomoCoin = () => (st.chain === "robinhood" && !blocked() ? [st.buy, st.sell].find((t) => t && !isNative(t) && /^0x[0-9a-fA-F]{40}$/.test(t.address || "") && !/^(USDG|WETH)$/i.test(t.symbol || "")) : null);
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
    // a graduated Pons coin trades in its Pons pool on Uniswap; a coin still on its curve already says "Pons curve"
    const vLabel = String(q.route.label || "").split(" · ")[0] + (q.route.pons && q.venue !== "pons-curve" ? " · Pons pool" : "");
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
    clear(chartCard, h("div", { class: "sw2-ch-h" }, tokenIcon({ ...t, chain: st.chain }, "sm"), h("b", {}, `$${t.symbol}`), st.gate?.pass ? h("span", { class: "dk-v v-passed" }, `Gate ${gateCount(st.gate).passed}/${gateCount(st.gate).total}`) : null, h("span", { class: "sw2-sp" }), tf), box);
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
  // twice a second, so the route timer never skips a second when a tick runs late
  const ageTick = setInterval(() => { const el = gateCard.querySelector("[data-gate-age]"); if (el && st.gateAt) { const t = gateAge(); if (el.textContent !== t) el.textContent = t; } tickBusy(); tickFresh(); }, 500);

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
  // quiet: the 25 s refresh of a quote already on screen. The numbers stay up while it loads and the button stays
  // usable (Swap runs the Gate again and builds from a fresh quote anyway); one miss falls back to a normal requote
  async function runQuote(quiet = false) {
    const amt = toRaw(st.amount, st.sell?.decimals ?? 18);
    if (!st.sell || !st.buy || !amt || amt <= 0n) { st.loading = false; st.refreshing = false; paint(); return; }
    const seq = ++st.seq;
    st.refreshing = quiet;
    if (!quiet) { st.loading = true; st.loadAt = Date.now(); }
    paint();
    const qs = new URLSearchParams({ tokenIn: tokParam(st.sell), tokenOut: tokParam(st.buy), amountInRaw: amt.toString(), slippageBps: String(st.slip), ...cq() });
    try {
      const q = await api.get(`swap/quote?${qs}`);
      if (!alive || seq !== st.seq) return;
      st.quote = q; st.quoteAt = Date.now(); st.quoteErr = null;
      if (q.ethUsd > 0) st.ethUsd = q.ethUsd;
      if (quiet) { st.refreshing = false; paint(); return; }
      st.loading = false; st.gating = true;
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
      // (called straight away: the 500 ms ticker would keep pushing a debounced call back)
      if (quiet) { st.refreshing = false; runQuote(false); return; }
      st.quote = null; st.quoteErr = e.message; st.loading = false;
      paint();
      tellTroya();
    }
  }
  const requote = debounce(() => runQuote(false), 380);
  // the Ask Troya popup reads this, so "why is it blocked?" is answered about this exact swap
  function tellTroya() {
    const q = st.quote, g = st.gate;
    const fails = g ? g.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`) : [];
    const notes = g ? g.checks.filter((c) => c.status === "warn").map((c) => `${c.label}: ${c.detail}`) : [];
    const text = [`Swap on ${CHAINS[st.chain]?.name || st.chain}: ${st.amount || "?"} ${st.sell?.symbol || "?"} for ${st.buy?.symbol || "?"}${st.buy?.address && st.buy.address !== "native" ? ` (${st.buy.address})` : ""}.`,
      q ? `Quote ${amount(Number(q.amountOut))} ${q.tokenOut.symbol}, price impact ${q.priceImpact == null ? "?" : (q.priceImpact * 100).toFixed(2) + "%"}, fees and taxes ${q.feePct == null ? "?" : q.feePct + "%"}, route ${q.route?.label}.` : st.quoteErr ? `No quote: ${st.quoteErr}.` : "",
      g ? `Troya Gate ${g.pass ? "passed" : "blocked"} (${gateCount(g).tally}).` : "",
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
  // the amounts Max and 25 / 50 / 75 % put in the box (the quick chips compare against them to show which is pressed)
  function maxStr() {
    if (!st.bal) return "";
    let raw = st.bal.raw;
    const keep = isSolNet() ? SOL_KEEP : GAS_KEEP;
    if (isNative(st.sell)) raw = raw > keep ? raw - keep : 0n; // keep a little ETH / SOL for fees
    return rawInput(raw, st.sell.decimals ?? 18, 8);
  }
  const pctStr = (p) => (st.bal ? rawInput((st.bal.raw * BigInt(p)) / 100n, st.sell.decimals ?? 18, 8) : "");
  function setMax() {
    if (!st.bal) return;
    sellInput.value = maxStr();
    sellInput.dispatchEvent(new Event("input"));
  }
  function setPct(p) {
    if (!st.bal) return;
    sellInput.value = pctStr(p);
    sellInput.dispatchEvent(new Event("input"));
  }

  /* ---------- token picker (Picker 2.0) ----------
     Robinhood Chain, before a search: ETH, USDG and WETH as one-tap chips, then $TROYA (Official), your tokens with their
     balances (Portfolio, by value), your last five picks, stock tokens and the most traded coins. Every row shows its
     address. Stock tokens wear Verified; a coin that reuses a bigger coin's ticker wears "Copy?" and the team's own test
     launches "Team test" (hints from the server: names stay free and no row is hidden for them). A field the server
     does not send simply shows nothing. Other networks: the native coin, your recent picks, then the popular list. */
  let stocksCache = null;
  const pfCache = { addr: "", at: 0, p: null };
  // your Robinhood Chain tokens, read at most every 30 s per wallet (the server keeps them as long)
  function myTokens() {
    const a = String(wallet.address || "").toLowerCase();
    if (!a || st.chain !== "robinhood") return Promise.resolve([]);
    if (pfCache.addr !== a || !pfCache.p || Date.now() - pfCache.at > 30_000) {
      Object.assign(pfCache, { addr: a, at: Date.now(), p: api.get(`portfolio/tokens?${new URLSearchParams({ address: a })}`).then((r) => (Array.isArray(r?.tokens) ? r.tokens : [])).catch(() => { pfCache.at = 0; return null; }) });
    }
    return pfCache.p;
  }
  const officialCa = () => (window.SITE?.ca && /^0x[0-9a-fA-F]{40}$/.test(window.SITE.ca) ? window.SITE.ca : TROYA);
  const RH_BASE = [[ETH, "Native"], [{ address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Global Dollar", decimals: 6 }, "Stablecoin"], [{ address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18 }, "Wrapped"]];
  /** What a row is: Official ($TROYA), Verified (a Robinhood stock token), Team test, Copy? */
  function marks(t, stockSet) {
    const a = akey(t?.address), out = [];
    const official = !!t?.official || (st.chain === "robinhood" && a === akey(officialCa()));
    const stock = t?.kind === "stock" || t?.stock === true || !!stockSet?.has(a);
    if (official) out.push(h("span", { class: "badge-s tp-off", title: "The official $TROYA contract" }, icon("check"), "Official"));
    else if (stock) out.push(h("span", { class: "badge-s sw-pad tp-ver", title: "A Robinhood stock token" }, padLogo("stocks", 12), "Verified"));
    if (!official && !stock && t?.teamTest === true) out.push(h("span", { class: "badge-s tp-test", title: "One of the Troya team's own test launches" }, "Team test"));
    if (!official && !stock && t?.copy === true) out.push(h("span", { class: "badge-s tp-copy", title: "Reuses the ticker of a stock token, a major, $TROYA or a bigger coin. Check the address before you trade it." }, "Copy?"));
    return out;
  }
  // a held balance: the amount, and its value when the coin has a price
  const balEl = (t) => h("span", { class: "tp-bal" }, h("b", {}, amount(Number(t.amount))), Number(t.valueUsd) > 0 ? h("small", {}, usd(Number(t.valueUsd))) : null);
  // decimals from a list are not trusted with an amount: null makes the picker read them from the chain
  const plain = (t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: null, image: t.image || null });
  function pick(side) {
    const other = side === "sell" ? st.buy : st.sell;
    const input = h("input", { class: "input", placeholder: "Search a name, symbol or paste an address", autocomplete: "off", spellcheck: "false", "aria-label": "Search tokens" });
    const list = h("div", { class: "tp-list" });
    const choose = async (t) => {
      if (t.decimals == null && t.address && t.address !== "native") {
        try { const m2 = await api.get(`token/meta?${new URLSearchParams({ address: t.address, ...cq() })}`); t = { ...t, decimals: m2.decimals, symbol: t.symbol || m2.symbol, name: t.name || m2.name }; }
        catch { toast("Could not read this token from the chain. Try again in a moment.", "error"); return; }
      }
      rememberPick(st.chain, t);
      if (side === "sell") st.sell = t; else st.buy = t;
      if (other && (isNative(t) ? isNative(other) : !isNative(other) && other.address === t.address)) { if (side === "sell") st.buy = null; else st.sell = nativeOf(); }
      m.close(); reset(); paint(); refreshBal(); requote();
    };
    const row = (t, extra) => h("button", { class: "tp-row", type: "button", title: isNative(t) ? "" : t.address, onclick: () => choose(t) }, tokenIcon({ ...t, chain: st.chain }, ""),
      h("span", { class: "tp-name" }, h("b", {}, t.symbol),
        h("small", {}, isNative(t) ? "Native gas token" : [t.name && t.name !== t.symbol ? h("span", { class: "tp-nm" }, t.name) : null, h("span", { class: "tp-addr" }, short(t.address))])),
      extra && (!Array.isArray(extra) || extra.some(Boolean)) ? h("span", { class: "tp-extra" }, extra) : null);
    const grp = (label) => h("div", { class: "tp-grp" }, label);
    const chips = st.chain === "robinhood" ? h("div", { class: "tp-chips", role: "group", "aria-label": "Common tokens" },
      RH_BASE.map(([t]) => h("button", { class: "chip tp-chip", type: "button", onclick: () => choose(t) }, tokenIcon({ ...t, chain: st.chain }, "xs"), t.symbol))) : null;
    const liq = (n) => (n >= 1e6 ? `$${num(n / 1e6, 1)}M liq.` : `$${num(n / 1e3, n >= 1e4 ? 0 : 1)}K liq.`);
    // Robinhood Chain before a search; drawn again as each part arrives (your balances can take a few seconds)
    function paintHome(my, d) {
      if (my !== seq) return;
      const shown = new Set();
      const take = (t) => { const a = akey(t?.address); if (!a || a === "native" || shown.has(a)) return false; shown.add(a); return true; };
      const parts = [], off = officialCa();
      const held = (d.pf || []).filter((t) => t?.address && Number(t.amount) > 0);
      const mine = new Map(held.map((t) => [akey(t.address), t]));
      const troya = { address: off, symbol: "TROYA", name: "Troya Agent", decimals: null };
      take(troya);
      parts.push(grp("Official"), row(troya, [...marks({ ...troya, official: true }), mine.has(akey(off)) ? balEl(mine.get(akey(off))) : null]));
      const yours = held.slice().sort((a, b) => (Number(b.valueUsd) || 0) - (Number(a.valueUsd) || 0)).filter(take).slice(0, 12);
      if (yours.length) parts.push(grp("Your tokens"), ...yours.map((t) => row(plain(t), [...marks(t, d.stockSet), balEl(t)])));
      else if (wallet.address && d.pf === undefined) parts.push(grp("Your tokens"), h("div", { class: "tp-load muted" }, "Reading your balances…"));
      const rec = recentPicks(st.chain).filter(take);
      if (rec.length) parts.push(grp("Recent"), ...rec.map((t) => row(plain(t), marks(t, d.stockSet))));
      if (!d.mk) parts.push(h("div", { class: "tp-load muted" }, "Loading the market…"));
      else {
        const stocks = (d.sk?.stocks || []).filter((t) => t.tradable).filter(take).slice(0, 6);
        const toks = (d.mk.tokens || d.mk.rows || []).filter((t) => t.address && t.address !== "native").filter(take);
        if (stocks.length) parts.push(grp("Stock tokens"), ...stocks.map((t) => row({ ...plain(t), decimals: t.decimals ?? null }, marks({ ...t, kind: "stock" }))));
        if (toks.length) parts.push(grp("Most traded today"), ...toks.map((t) => row(plain(t), [...marks(t, d.stockSet), t.launchpad ? padBadge(t.launchpad) : null])));
        if (d.mkErr) parts.push(h("div", { class: "tp-load muted" }, "The market list is unavailable right now. Search, or paste a token address."));
      }
      clear(list, ...parts);
    }
    let seq = 0;
    const search = debounce(async () => {
      const q = input.value.trim();
      const my = ++seq;
      const items = [];
      if (st.chain !== "robinhood") {
        // Base / Arbitrum: popular tokens, search by name or symbol (GeckoTerminal), or paste an address
        if (!q || nativeOf().symbol.toLowerCase().startsWith(q.toLowerCase())) items.push(row(nativeOf(), "Native"));
        const rec = q ? [] : recentPicks(st.chain);
        if (rec.length) items.push(grp("Recent"), ...rec.map((t) => row(plain(t))));
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
          const seen = new Set(rec.map((t) => akey(t.address)));
          const toks = (r.tokens || []).filter((t) => !seen.has(akey(t.address)));
          const head = isSolNet() && r.trending ? "Trending on Solana right now" : rec.length && toks.length ? "Popular" : null;
          clear(list, ...items, head ? grp(head) : null,
            ...toks.map((t) => row(t, t.launchpad ? padBadge(t.launchpad) : t.liquidityUsd ? h("span", { class: "badge-s" }, liq(t.liquidityUsd)) : null)),
            toks.length || rec.length ? null : h("div", { class: "tp-load muted" }, "No match. Paste the token address instead."));
        } catch { if (my === seq) clear(list, ...items, h("div", { class: "tp-load muted" }, "The token list is unavailable right now. Paste a token address instead.")); }
        return;
      }
      if (!q) {
        // nothing typed: draw at once, then fill in your balances and the market as they arrive
        const d = { pf: wallet.address ? undefined : [], mk: null, mkErr: false, sk: null, stockSet: null };
        paintHome(my, d);
        myTokens().then((pf) => { d.pf = pf || []; paintHome(my, d); });
        Promise.all([api.get(`market/robinhood?${new URLSearchParams({ q: "", limit: "30", sort: "volume", dir: "desc", tradable: "1" })}`).catch(() => null),
          (stocksCache ||= api.get("market/stocks").catch(() => ({ stocks: [] })))]).then(([r, sk]) => {
          d.mk = r || { tokens: [] }; d.mkErr = !r; d.sk = sk;
          d.stockSet = new Set((sk?.stocks || []).map((t) => akey(t.address)));
          paintHome(my, d);
        });
        return;
      }
      for (const [t, tag] of RH_BASE) if (t.symbol.toLowerCase().startsWith(q.toLowerCase())) items.push(row(t, tag));
      clear(list, ...items, h("div", { class: "tp-load muted" }, "Searching…"));
      try {
        if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
          const m2 = await api.get(`token/meta?address=${q}`);
          if (my !== seq) return;
          const t = { address: m2.address, symbol: m2.symbol, name: m2.name, decimals: m2.decimals };
          clear(list, row(t, [...marks(t), h("span", {}, "By address")]));
          return;
        }
        // a symbol, name or ticker: the whole chain (index + stock tokens + DexScreener), real coin first, copies marked
        const [r, sk] = await Promise.all([
          api.get(`search/coins?${new URLSearchParams({ q, limit: "24" })}`),
          (stocksCache ||= api.get("market/stocks").catch(() => ({ stocks: [] }))),
        ]);
        if (my !== seq) return;
        const tradable = new Set((sk.stocks || []).filter((t) => t.tradable).map((t) => String(t.address).toLowerCase()));
        const hits = (r.coins || []).filter((c) => c.kind !== "major" && (c.kind !== "stock" || tradable.has(c.address)));
        clear(list, ...items,
          ...hits.map((c) => row(plain(c),
            [...marks(c, tradable), c.kind === "stock" ? null : c.launchpad ? padBadge(c.launchpad) : h("span", { class: "badge-s" }, c.liquidityUsd ? liq(c.liquidityUsd) : "Coin")])),
          hits.length || items.length ? null : h("div", { class: "tp-load muted" }, "No match. Paste the token address instead."));
      } catch (e) {
        if (my !== seq) return;
        clear(list, ...items, h("div", { class: "tp-load muted" }, "The token list is unavailable right now. Paste a token address instead."));
      }
    }, 250);
    input.addEventListener("input", search);
    const m = modal({ title: side === "sell" ? "Sell which token?" : "Buy which token?", body: h("div", { class: "tp" }, input, chips, list,
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
  // the two rows every review adds: what the route keeps in fees and taxes, and the Gate as it just ran
  const feeRow = (fq) => ["Fees and taxes", fq.feePct == null ? "–" : `${Number(fq.feePct).toFixed(2)}%`];
  const gateRow = () => { const g = st.gate, c = gateCount(g); return g?.pass ? ["Troya Gate", `${c.notes ? "Passed with notes" : "Passed"} ${c.passed}/${c.total}`] : null; };
  // after a confirmed swap: the next things people do with the coin they now hold (each opens a page; nothing is sent)
  function doneChips(chain, paid, got, outRaw) {
    const coin = !isNative(got) ? got : !isNative(paid) ? paid : null;
    const rh = chain === "robinhood" && /^0x[0-9a-fA-F]{40}$/.test(coin?.address || "");
    const holds = !!coin && coin === got && !MAJOR.test(coin.symbol || "");
    return h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", marginTop: "8px" } },
      rh ? h("a", { class: "chip", href: `#/token/${coin.address.toLowerCase()}` }, `Open $${coin.symbol}`) : null,
      chain !== "solana" ? h("a", { class: "chip", href: "#/portfolio" }, "View in Portfolio") : null,
      rh && holds ? h("a", { class: "chip", href: "#/agent/aegis" }, "Guard with Aegis") : null,
      got && !isNative(got) ? h("button", { class: "chip", type: "button", onclick: () => sellBack(paid, got, outRaw) }, "Sell") : null);
  }
  // "Sell": the same pair the other way, filled with what the swap returned (or the balance, if that is less)
  async function sellBack(paid, got, outRaw) {
    st.sell = got; st.buy = paid; st.amount = ""; sellInput.value = ""; reset(); paint();
    await refreshBal();
    if (!alive || st.sell !== got || st.amount) return;
    let raw = 0n;
    try { raw = BigInt(outRaw || 0); } catch {}
    if (st.bal && st.bal.raw > 0n && raw > st.bal.raw) raw = st.bal.raw;
    if (raw > 0n) { sellInput.value = rawInput(raw, got.decimals ?? 18, 8); sellInput.dispatchEvent(new Event("input")); }
    sellInput.focus();
  }
  async function actSol(q) {
    const paid = st.sell, got = st.buy;
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
          feeRow(fq),
          ["Route", fq.route.label],
          gateRow(),
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
        clear(txBox, h("div", { class: "alert ok" }, icon("check"), " Swap confirmed · ", h("a", { class: "link", href: `https://solscan.io/tx/${sig}`, target: "_blank", rel: "noopener" }, short(sig, 6))),
          doneChips("solana", paid, got, fq.amountOutRaw));
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
    // not enough ETH on Robinhood Chain: "Add ETH to buy" opens the cross-chain panel (or the Bridge), it never signs here
    if (ethShort() > 0n) { if (!blocked()) await addEth(); return; }
    const q = st.quote;
    if (!q) return;
    const paid = st.sell, got = st.buy;
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
        // the RPC that builds the swap can lag a block behind the receipt: three more tries, 1.5 s apart, before giving up
        for (let tries = 0; ; tries++) {
          built = await api.post("swap/build", buildArgs);
          if (!(built.approvals || []).some((a) => a.needed)) break;
          if (tries >= 3 || !alive) throw new Error("The approval is not visible on chain yet. Wait a few seconds and try again.");
          st.busy = "Waiting for the approval to show on chain…"; paint();
          await new Promise((r) => setTimeout(r, 1500));
        }
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
          feeRow(fq),
          ["Route", fq.route.label],
          gateRow(),
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
        clear(txBox, h("div", { class: "alert ok" }, icon("check"), ` Swap confirmed · `, h("a", { class: "mono link", href: `${CHAINS[chain].explorer}/tx/${hash}`, target: "_blank", rel: "noopener", title: `View it on the ${cname} explorer` }, short(hash, 6))),
          doneChips(chain, paid, got, fq.amountOutRaw));
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

  const off = onWallet(() => {
    if (isSolNet()) return;
    if (st.chain === "robinhood") readOtherEth();
    refreshBal(); paint();
    // a cross-chain preview (quoted for a stand-in address) becomes the exact route for the wallet just connected
    if (xc.open && !xcBox.hidden && xc.amount && !xc.busy && xc.qFor !== String(wallet.address || PREVIEW_FROM).toLowerCase()) { xcBal(); xcQuote(); }
  });
  if (st.chain === "robinhood") readOtherEth();
  const offSol = onSol(() => { if (isSolNet()) { refreshBal(); paint(); if (st.quote) { reset(); requote(); } } });
  if (isSolNet()) restoreSol().then(() => { refreshBal(); paint(); });
  render();
  if (st.amount) requote();
  return () => { alive = false; off(); offSol(); clearInterval(ageTick); fitObs?.disconnect(); phoneMq?.removeEventListener?.("change", placeNote); try { chartObj?.remove(); } catch {} };
}
