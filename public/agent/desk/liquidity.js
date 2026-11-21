// F18 · Liquidity desk: Uniswap v3 on Robinhood Chain.
//   New position   pick a pool; Troya proposes tight, balanced and wide ranges from the pool's own volatility, with the
//                  chance the price stays inside and the fees $1,000 would earn a day; the Liquidity Gate checks the
//                  pool, the range, both token contracts and your balances; your wallet approves and mints
//   My positions   range, in range or not, what it holds, fees to collect; Collect, Remove all, Rebalance (remove, then
//                  the new range around today's price) and a range watch that writes when the price leaves or nears an edge
import { Interface, parseUnits } from "ethers";
import { h, clear, useCss, toast, tiny, usd, pageHead, seg, review, short, tokenIcon, icon } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { coinSuggest } from "/agent/js/coinsearch.js";
import { wallet, onWallet, openConnect, signIn, reader } from "/agent/js/wallet.js";
import { balanceOf, sendTx, waitReceipt, errText } from "/agent/js/chain.js";

const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX128 = (1n << 128n) - 1n;
const GAS_RESERVE = 300_000_000_000_000n;          // 0.0003 ETH stays for network fees
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC = new Interface(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const NP = new Interface([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function sweepToken(address token,uint256 amountMinimum,address recipient) payable",
]);
const POOL = new Interface(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)"]);
const lc = (s) => String(s || "").toLowerCase();
const isEth = (t) => lc(t?.address) === WETH;
const fx = (n) => (n == null || !isFinite(n) ? "–" : tiny(n));
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 1200);
const toRaw = (x, d) => { const n = Number(x); return n > 0 && isFinite(n) ? parseUnits(n.toFixed(Math.min(d, 18)), d) : 0n; };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// the pair's two logos, base first (ETH / USDG, NVDA / USDG), overlapping like a wallet shows a pool
const pairIcons = (p, size = "sm") => {
  const [b, q] = p.invert ? [p.token1, p.token0] : [p.token0, p.token1];
  const t = (x) => tokenIcon({ symbol: isEth(x) ? "ETH" : x.label || x.symbol, address: isEth(x) ? "" : x.address }, size);
  return h("span", { class: "lq-pair", "aria-hidden": "true" }, t(b), t(q));
};

/* ---------- v3 math (floats for display and pairing; the contract does the exact math) ---------- */
const sqrtTick = (t) => Math.pow(1.0001, t / 2);
const sqrtX96 = (x) => Number(BigInt(x)) / 2 ** 96;
function amountsFor(L, sp, sa, sb) {
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
}
function stayInside(k) {
  let s = 0;
  for (let n = 0; n < 40; n++) s += ((n % 2 ? -1 : 1) / (2 * n + 1)) * Math.exp(-((2 * n + 1) ** 2) * Math.PI ** 2 / (8 * k * k));
  return Math.max(0, Math.min(1, (4 / Math.PI) * s));
}
function ticksOf(p, lo, hi) {                       // display prices → ticks aligned to the pool
  const d = 10 ** (p.token0.decimals - p.token1.decimals);
  const a = p.invert ? 1 / hi : lo, b = p.invert ? 1 / lo : hi;
  const t = (x) => Math.log(x / d) / Math.log(1.0001), ts = p.tickSpacing;
  let tl = Math.floor(t(a) / ts) * ts, tu = Math.ceil(t(b) / ts) * ts;
  if (tu <= tl) tu = tl + ts;
  return [Math.max(tl, Math.ceil(-887272 / ts) * ts), Math.min(tu, Math.floor(887272 / ts) * ts)];
}
function displayOf(p, tl, tu) {
  const d = 10 ** (p.token0.decimals - p.token1.decimals);
  const pl = Math.pow(1.0001, tl) * d, pu = Math.pow(1.0001, tu) * d;
  return p.invert ? [1 / pu, 1 / pl] : [pl, pu];
}
function estimate(p, tl, tu) {                      // the server's formula, for a custom range
  const sp = sqrtX96(p.sqrtPriceX96), [a0, a1] = amountsFor(1, sp, sqrtTick(tl), sqrtTick(tu));
  const perL = a0 / 10 ** p.token0.decimals * (p.token0.priceUsd || 0) + a1 / 10 ** p.token1.decimals * (p.token1.priceUsd || 0);
  if (!(perL > 0) || !p.volume24hUsd || p.tick < tl || p.tick >= tu) return { feesPer1kDay: 0, aprInRangePct: 0 };
  const L = 1000 / perL, f = p.volume24hUsd * p.fee / 1e6 * (L / (Number(p.liquidity) + L));
  return { feesPer1kDay: f, aprInRangePct: f * 365 / 10 };
}
// given one side, the other side the range needs right now (null: that side is not used at this price)
function pairOf(p, tl, tu, side, val) {
  const sp = sqrtX96(p.sqrtPriceX96), sa = sqrtTick(tl), sb = sqrtTick(tu);
  const d0 = 10 ** p.token0.decimals, d1 = 10 ** p.token1.decimals;
  if (side === 0) {
    if (sp >= sb) return null;
    const s = Math.max(sp, sa), L = val * d0 * s * sb / (sb - s);
    return sp <= sa ? 0 : L * (sp - sa) / d1;
  }
  if (sp <= sa) return null;
  const s = Math.min(sp, sb), L = val * d1 / (s - sa);
  return sp >= sb ? 0 : L * (sb - sp) / (sp * sb) / d0;
}
const sidesOf = (p, tl, tu) => { const sp = sqrtX96(p.sqrtPriceX96); return [sp < sqrtTick(tu), sp > sqrtTick(tl)]; };

/* ---------- exact v3 math for the 1% price guard ----------
   BigInt, in the same integer steps as Uniswap's TickMath, LiquidityAmounts and SqrtPriceMath: a minimum has to sit at
   or under what the contract itself computes, so the float helpers above are not good enough here. */
const Q96 = 1n << 96n;
const TICK_MUL = [0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n];
function sqrtAtTick(tick) {                        // TickMath.getSqrtRatioAtTick
  const a = BigInt(Math.abs(tick));
  let r = a & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  TICK_MUL.forEach((m, i) => { if (a & (2n << BigInt(i))) r = (r * m) >> 128n; });
  if (tick > 0) r = ((1n << 256n) - 1n) / r;
  return (r >> 32n) + (r % (1n << 32n) ? 1n : 0n);
}
function isqrt(n) {                                // floor(√n), Newton's method from above
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
const divUp = (a, b) => (a + b - 1n) / b;
const liq0 = (sa, sb, a) => a * (sa * sb / Q96) / (sb - sa);
const liq1 = (sa, sb, a) => a * Q96 / (sb - sa);
// the liquidity the position manager mints from two budgets at a price (LiquidityAmounts.getLiquidityForAmounts)
function liquidityFor(sp, sa, sb, a0, a1) {
  if (sp <= sa) return liq0(sa, sb, a0);
  if (sp < sb) { const x = liq0(sp, sb, a0), y = liq1(sa, sp, a1); return x < y ? x : y; }
  return liq1(sa, sb, a1);
}
// what that liquidity holds at a price; up = the pool's rounding when it takes tokens in (mint), else when it pays out
function amountsAt(sp, sa, sb, L, up = false) {
  const d0 = (x, y) => { const n = (L << 96n) * (y - x); return up ? divUp(divUp(n, y), x) : n / y / x; };
  const d1 = (x, y) => (up ? divUp(L * (y - x), Q96) : L * (y - x) / Q96);
  if (sp < sa) return [d0(sa, sb), 0n];
  if (sp < sb) return [d0(sp, sb), d1(sa, sp)];
  return [0n, d1(sa, sb)];
}
// the price 1% up or down, as a square root (pct = 101n or 99n)
const shifted = (sp, pct) => isqrt(sp * sp * pct / 100n);
// A true 1% price band. Token0 is scarcest when the price has risen 1%, token1 when it has fallen 1%: the minimums are
// what the mint (or a removal) takes at those two edges, so it lands anywhere inside and reverts past either one.
// Desired × 99% is not that: in a tight range a 0.1% move already leaves 2% of one side unused, and the mint reverts.
function mintMins(sp, sa, sb, a0, a1) {
  const up = shifted(sp, 101n), dn = shifted(sp, 99n);
  return [amountsAt(up, sa, sb, liquidityFor(up, sa, sb, a0, a1))[0], amountsAt(dn, sa, sb, liquidityFor(dn, sa, sb, a0, a1))[1]];
}
const mintTakes = (sp, sa, sb, a0, a1) => amountsAt(sp, sa, sb, liquidityFor(sp, sa, sb, a0, a1), true);
const burnMins = (sp, sa, sb, L) => [amountsAt(shifted(sp, 101n), sa, sb, L)[0], amountsAt(shifted(sp, 99n), sa, sb, L)[1]];

// the pool's price read on chain at this moment (the suggestion on screen can be minutes old)
async function readPrice(pool) {
  const r = POOL.decodeFunctionResult("slot0", await reader("robinhood").call({ to: pool, data: POOL.encodeFunctionData("slot0") }));
  return { sqrtPriceX96: BigInt(r[0]), tick: Number(r[1]) };
}
// put a fresh price into the pool on screen: the tick and the display price follow it
function setPrice(p, s) {
  p.sqrtPriceX96 = s.sqrtPriceX96.toString(); p.tick = s.tick;
  p.price = sqrtX96(p.sqrtPriceX96) ** 2 * 10 ** (p.token0.decimals - p.token1.decimals);
  p.display = p.invert ? 1 / p.price : p.price;
}
// the one sign-in path the app uses everywhere (as the Agent page's needSignIn): connect first if needed, then one free signature
async function signInNow() { try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(errText(e), "error"); } }

function rangeBar(lo, hi, now) {
  const a = Math.min(lo, now), b = Math.max(hi, now);
  const pad = (Math.log(b) - Math.log(a)) * 0.3 || 0.05;
  const L = Math.log(a) - pad, R = Math.log(b) + pad, pos = (v) => `${(((Math.log(v) - L) / (R - L)) * 100).toFixed(2)}%`;
  const out = now < lo || now > hi;
  return h("div", { class: "lq-bar", "aria-hidden": "true" },
    h("span", { class: "lq-bar-r", style: { left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` } }),
    h("span", { class: `lq-bar-now ${out ? "out" : ""}`, style: { left: pos(now) } }));
}

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  // one wallet action at a time: a double click must not start the same transaction twice
  let acting = false;
  const guarded = async (fn) => { if (acting) return; acting = true; try { return await fn(); } finally { acting = false; } };
  const first = ctx.parts[0] || "";
  const st = { tab: first === "positions" ? "positions" : "new", pools: [], q: "", pool: ADDR_RE.test(first) ? lc(first) : null, sug: null, sugErr: null, days: 7, preset: "balanced", custom: null,
    a: ["", ""], edit: 0, bal: {}, health: {}, positions: null, busy: null, err: null, prefill: null, watched: new Set(), watching: null };
  const tabs = h("div", { class: "sd-tabs" });
  const body = h("div", { class: "lq-body" });
  clear(view, h("div", { class: "dk lq" },
    pageHead("Liquidity desk", "Uniswap v3 on Robinhood Chain. Troya sets the range from the pool's volatility, watches it around the clock and tells you when to rebalance. Your wallet signs every step."),
    tabs, body,
    h("p", { class: "fine lt-legal" }, "A liquidity position earns trading fees only while the price is inside its range, and it holds more of whichever token is falling (impermanent loss). Estimates use past volatility and today's volume; they are not forecasts. Not financial advice.")));

  const paintTabs = () => clear(tabs, seg([{ value: "new", label: "New position" }, { value: "positions", label: "My positions" }], st.tab, (v) => { st.tab = v; history.replaceState(null, "", `#/liquidity${v === "positions" ? "/positions" : st.pool ? `/${st.pool}` : ""}`); paint(); }));
  function paint() { paintTabs(); st.tab === "positions" ? positions() : newPos(); }

  /* ---------- data ---------- */
  async function loadPools(token = null) {
    try { const r = await api.get(`lp/pools${token ? `?token=${token}` : ""}`); st.pools = r.pools; st.byToken = !!token; st.err = r.pools.length ? null : r.note || "No pools."; } catch (e) { st.err = e.message; }
    if (!st.pool && st.pools[0]) st.pool = st.pools[0].address;
    if (alive) { paintList(); if (st.pool && !st.sug) { if (st.tab === "new") paintCard(); loadSug(); } }
  }
  async function loadSug(timed = false) {
    const pool = st.pool;
    if (!pool) return;
    st.sugErr = null;
    try {
      const s = await api.get(`lp/suggest?pool=${pool}&days=${st.days}`);
      if (st.pool !== pool) return;
      // a timed refresh that lands while someone types in the ticket waits for the next one (a repaint takes the focus)
      if (timed && card.contains(document.activeElement)) return;
      // new price, new ranges: the side you did not type follows them
      st.sug = s; repair();
      checkTokens(s.pool);
      loadBalances(s.pool);
    } catch (e) { st.sugErr = e.message; }
    if (alive && st.tab === "new") paintCard();
  }
  async function loadBalances(p) {
    if (!wallet.address) return;
    for (const t of [p.token0, p.token1]) {
      try {
        const b = isEth(t) ? await balanceOf(wallet.address) : await balanceOf(wallet.address, { address: t.address, decimals: t.decimals });
        const raw = isEth(t) ? (b.raw > GAS_RESERVE ? b.raw - GAS_RESERVE : 0n) : b.raw;
        st.bal[lc(t.address)] = { raw, amount: Number(raw) / 10 ** t.decimals };
      } catch {}
    }
    if (alive && st.tab === "new") paintLive();
  }
  async function checkTokens(p) {
    for (const t of [p.token0, p.token1]) {
      const a = lc(t.address);
      if (isEth(t) || a === USDG || st.health[a]) continue;
      api.get(`token/health?address=${a}`).then((r) => { st.health[a] = r; if (alive && st.tab === "new") paintLive(); }).catch(() => { st.health[a] = { risk: "unknown" }; });
    }
  }
  async function loadPositions() {
    if (!wallet.address) { st.positions = null; return st.tab === "positions" && paint(); }
    try { st.positions = (await api.get(`lp/positions?address=${wallet.address}`)).positions; st.posErr = null; } catch (e) { st.posErr = e.message; }
    if (wallet.session) { const w = await api.get("watches").catch(() => null); if (w) st.watched = new Set(w.items.filter((x) => x.type === "lp_range" && x.status !== "done").map((x) => String(x.params.tokenId))); }
    if (alive && st.tab === "positions") paint();
  }

  /* ---------- new position ---------- */
  const search = h("input", { class: "input", placeholder: "Search ETH, NVDA… or paste a token address", "aria-label": "Search pools", autocomplete: "off" });
  const list = h("div", { class: "sp-list" });
  const card = h("div", { class: "panel sp-card lq-card" });
  const searchBox = coinSuggest(search, (c) => {
    search.value = c.symbol; st.q = "";
    if (c.address === "native") { loadPools(); st.q = "eth"; paintList(); } else loadPools(lc(c.address));
  }, { majors: true });
  const grid = h("div", { class: "sp-grid" }, h("div", { class: "panel sp-side" }, searchBox, list), card);
  search.addEventListener("input", () => {
    const q = search.value.trim();
    if (ADDR_RE.test(q)) { st.q = ""; loadPools(lc(q)); return; }
    if (!q && st.byToken) loadPools();
    st.q = q.toLowerCase(); paintList();
  });
  function newPos() {
    clear(body, grid);
    paintList(); paintCard();
  }
  function paintList() {
    const rows = st.pools.filter((p) => !st.q || p.name.toLowerCase().includes(st.q));
    clear(list, rows.map((p) => h("button", { class: `sp-row lq-row ${st.pool === p.address ? "on" : ""}`, type: "button", onclick: () => pick(p.address) },
      p.token0 && p.token1 ? pairIcons(p) : h("span", {}),
      h("span", { class: "sp-row-n" }, h("b", {}, p.name), h("small", {}, `${p.feePct}% · TVL ${usd(p.tvlUsd, { compact: true })}`)),
      h("span", { class: "sp-row-p" }, h("b", {}, p.feeAprPct != null ? `${p.feeAprPct.toFixed(0)}% APR` : "–"), h("small", {}, `vol ${usd(p.volume24hUsd, { compact: true })}`)))),
      rows.length ? null : h("p", { class: "muted", style: { padding: "12px" } }, st.err || (st.pools.length ? "No pool matches." : "Loading pools…")));
  }
  function pick(addr) {
    if (st.pool === addr) return;
    st.pool = addr; st.sug = null; st.preset = "balanced"; st.custom = null; st.a = ["", ""];
    history.replaceState(null, "", `#/liquidity/${addr}`);
    paintList(); paintCard(); loadSug();
  }
  function sel() {
    const s = st.sug;
    if (!s) return null;
    const p = s.pool;
    if (st.preset === "custom" && st.custom) {
      const [tl, tu] = ticksOf(p, st.custom[0], st.custom[1]), [lo, hi] = displayOf(p, tl, tu);
      const sT = s.volatility.periodPct / 100, now = p.display;
      const k = sT > 0 ? Math.min(Math.log(now / lo), Math.log(hi / now)) / sT : 0;
      return { tl, tu, lo, hi, stayPct: k > 0 ? stayInside(k) * 100 : 0, ...estimate(p, tl, tu) };
    }
    const x = s.presets.find((y) => y.key === st.preset) || s.presets[1];
    return { tl: x.lowerTick, tu: x.upperTick, lo: x.displayLower, hi: x.displayUpper, stayPct: x.stayPct, feesPer1kDay: x.feesPer1kDay, aprInRangePct: x.aprInRangePct };
  }
  // keep the side the user typed and recompute the other for the current range
  function repair() {
    const s = st.sug, r = sel();
    if (!s || !r) return;
    const [u0, u1] = sidesOf(s.pool, r.tl, r.tu);
    if (!u0) st.a[0] = ""; if (!u1) st.a[1] = "";
    const side = st.edit === 0 && u0 ? 0 : u1 ? 1 : 0, v = Number(st.a[side]);
    if (!(v > 0)) { st.a[1 - side] = ""; return; }
    const o = pairOf(s.pool, r.tl, r.tu, side, v);
    st.a[1 - side] = o == null || o === 0 ? "" : String(+o.toPrecision(10));
  }
  function need() {
    const p = st.sug?.pool;
    if (!p) return null;
    const r0 = toRaw(st.a[0], p.token0.decimals), r1 = toRaw(st.a[1], p.token1.decimals);
    return r0 === 0n && r1 === 0n ? null : [r0, r1];
  }
  function gate() {
    const s = st.sug, r = sel();
    if (!s || !r) return { state: "wait", items: [] };
    const p = s.pool, items = [], add = (label, state, value) => items.push({ label, state, value });
    add("Pool", "pass", `Uniswap v3 ${p.feePct}%, read on chain`);
    add("Depth", p.tvlUsd >= 50_000 ? "pass" : p.tvlUsd >= 5_000 ? "warn" : "fail", p.tvlUsd != null ? `${usd(p.tvlUsd, { compact: true })} in the pool` : "unknown");
    const inside = p.tick >= r.tl && p.tick < r.tu;
    add("Price now", inside ? "pass" : "warn", inside ? "inside your range: earns from the next trade" : "outside your range: one token only, no fees until the price enters");
    add("Range", r.stayPct >= 60 ? "pass" : "warn", `${r.stayPct.toFixed(0)}% chance to stay inside for ${s.days} day${s.days > 1 ? "s" : ""}${r.stayPct < 60 ? ": expect to rebalance" : ""}`);
    for (const t of [p.token0, p.token1]) {
      const a = lc(t.address);
      if (isEth(t) || a === USDG) continue;
      const x = st.health[a], flag = x?.flags?.find((f) => f.level === "risk") || x?.flags?.find((f) => f.level === "warn");
      add(`${t.label} contract`, !x ? "wait" : x.risk === "high" ? "fail" : x.risk === "medium" || x.risk === "unknown" ? "warn" : "pass",
        !x ? "checking…" : x.kind === "stock" ? "Robinhood stock token" : x.risk === "unknown" ? "could not be read" : `${x.risk} risk${flag ? `: ${flag.text}` : ""}`);
    }
    const n = need();
    if (n && wallet.address) for (const [i, t] of [[0, p.token0], [1, p.token1]]) {
      if (n[i] === 0n) continue;
      const b = st.bal[lc(t.address)];
      add(`${t.label} balance`, !b ? "wait" : b.raw >= n[i] ? "pass" : "fail", !b ? "reading…" : `${fx(Number(n[i]) / 10 ** t.decimals)} needed · ${fx(b.amount)}${isEth(t) ? " spendable" : ""} in wallet`);
    }
    add("Price guard", "pass", "reverts if the price moves more than 1% before it lands");
    const state = items.some((i) => i.state === "fail") ? "fail" : items.some((i) => i.state === "wait") ? "wait" : items.some((i) => i.state === "warn") ? "warn" : "pass";
    return { state, items, r, p };
  }

  const gateBox = h("div", { class: "sw-gate" }), btnBox = h("div", {}), hintBox = h("div", {});
  const ins = [0, 1].map((i) => {
    const el = h("input", { class: "input", inputmode: "decimal", placeholder: "0.0", autocomplete: "off" });
    el.addEventListener("input", () => { st.a[i] = el.value; st.edit = i; repair(); ins[1 - i].value = st.a[1 - i]; paintLive(); });
    return el;
  });
  function paintCard() {
    const s = st.sug;
    if (st.sugErr) return clear(card, h("div", { class: "alert error" }, st.sugErr));
    if (!s) {
      const q = st.pools.find((x) => x.address === st.pool);
      return clear(card, q ? h("div", { class: "lq-head" }, q.token0 && q.token1 ? pairIcons(q) : null, h("b", {}, q.name), h("span", { class: "chip" }, `${q.feePct}%`), h("span", {}, `${fx(q.display)} ${q.quote} per ${q.base}`)) : null,
        q ? h("div", { class: "lq-stats" }, h("span", {}, "TVL ", h("b", {}, usd(q.tvlUsd, { compact: true }))), h("span", {}, "24h volume ", h("b", {}, usd(q.volume24hUsd, { compact: true }))), h("span", {}, "Pool fee APR ", h("b", {}, q.feeAprPct != null ? `${q.feeAprPct.toFixed(1)}%` : "–"))) : null,
        h("p", { class: "muted", style: { margin: 0 } }, "Measuring this pool's volatility from its hourly candles…"),
        h("div", { class: "sk", style: { height: "300px" } }));
    }
    const p = s.pool, r = sel();
    const daysSeg = seg([{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }], String(st.days), (v) => { st.days = +v; st.sug = null; paintCard(); loadSug(); }, "lq-days");
    const presetBtn = (x) => h("button", { class: `lq-preset ${st.preset === x.key ? "on" : ""}`, type: "button", "aria-pressed": String(st.preset === x.key), onclick: () => { st.preset = x.key; repair(); paintCard(); } },
      h("b", {}, x.label), h("span", { class: "lq-pr" }, `${fx(x.displayLower)} – ${fx(x.displayUpper)}`), h("span", { class: "fine" }, `±${x.widthPct.toFixed(1)}% · stays inside ${x.stayPct.toFixed(0)}%`),
      h("span", { class: "fine" }, x.feesPer1kDay > 0 ? `≈ ${usd(x.feesPer1kDay)}/day per $1,000` : "earns nothing at today's price"));
    const lo = h("input", { class: "input", inputmode: "decimal", value: st.custom ? String(+st.custom[0].toPrecision(8)) : String(+r.lo.toPrecision(8)), "aria-label": "Lowest price" });
    const hi = h("input", { class: "input", inputmode: "decimal", value: st.custom ? String(+st.custom[1].toPrecision(8)) : String(+r.hi.toPrecision(8)), "aria-label": "Highest price" });
    const setCustom = () => { const a = Number(lo.value), b = Number(hi.value); if (a > 0 && b > a) { st.custom = [a, b]; st.preset = "custom"; repair(); paintCard(); } else toast("The lowest price must be above 0 and under the highest.", "error"); };
    lo.addEventListener("change", setCustom); hi.addEventListener("change", setCustom);
    const [u0, u1] = sidesOf(p, r.tl, r.tu);
    const order = p.invert ? [1, 0] : [0, 1];
    order.forEach((i) => { ins[i].value = st.a[i]; ins[i].disabled = !(i === 0 ? u0 : u1); });
    const tok = (i) => (i === 0 ? p.token0 : p.token1);
    const amtRow = (i) => {
      const t = tok(i), b = st.bal[lc(t.address)];
      return h("div", { class: "lq-amt" }, h("label", {}, h("span", {}, t.label), b ? h("button", { class: "link", type: "button", onclick: () => { ins[i].value = String(+b.amount.toPrecision(10)); ins[i].dispatchEvent(new Event("input")); } }, `Balance ${fx(b.amount)} · Max`) : null),
        ins[i], ins[i].disabled ? h("span", { class: "fine" }, `Not used: the price is ${i === 0 ? "above" : "below"} this range, so it holds only ${tok(1 - i).label}.`) : null);
    };
    clear(card,
      h("div", { class: "lq-head" }, p.token0 && p.token1 ? pairIcons(p) : null, h("b", {}, `${p.name}`), h("span", { class: "chip" }, `${p.feePct}%`), h("span", {}, `${fx(p.display)} ${p.quote} per ${p.base}`), h("a", { class: "ulink fine", href: p.chart, target: "_blank", rel: "noopener" }, "Chart")),
      h("div", { class: "lq-stats" },
        h("span", {}, "TVL ", h("b", {}, usd(p.tvlUsd, { compact: true }))), h("span", {}, "24h volume ", h("b", {}, usd(p.volume24hUsd, { compact: true }))),
        h("span", {}, "Pool fee APR ", h("b", {}, p.feeAprPct != null ? `${p.feeAprPct.toFixed(1)}%` : "–")), h("span", {}, "Volatility ", h("b", {}, `${s.volatility.annualPct.toFixed(0)}%/yr`))),
      h("div", { class: "lq-sec" }, h("span", { class: "lq-sec-h" }, "Range for the next"), daysSeg),
      h("div", { class: "lq-presets" }, s.presets.map(presetBtn)),
      h("div", { class: "lq-custom" }, h("span", { class: "fine" }, `Custom (${p.quote} per ${p.base})`), lo, h("span", { class: "fine" }, "to"), hi),
      h("div", { class: "lq-range" }, rangeBar(r.lo, r.hi, p.display),
        h("div", { class: "lq-range-l" }, h("span", {}, `Min ${fx(r.lo)}`), h("span", {}, `Now ${fx(p.display)}`), h("span", {}, `Max ${fx(r.hi)}`)),
        h("p", { class: "fine", style: { margin: "6px 0 0" } }, `${st.preset === "custom" ? "Custom" : (s.presets.find((x) => x.key === st.preset) || {}).label} range: ${r.stayPct.toFixed(0)}% chance to stay inside for ${s.days} day${s.days > 1 ? "s" : ""} at the past ${s.volatility.samples} hours' volatility${r.feesPer1kDay > 0 ? `; about ${usd(r.feesPer1kDay)} a day per $1,000 while inside (${r.aprInRangePct.toFixed(0)}% APR)` : ""}.`)),
      h("div", { class: "lq-amts" }, order.map(amtRow)),
      hintBox, gateBox, btnBox);
    paintLive();
  }
  function paintLive() {
    if (!st.sug) return;
    const g = gate(), p = st.sug.pool;
    clear(gateBox, h("div", { class: "gh" }, "Liquidity Gate"), h("ul", {}, g.items.map((i) => h("li", { class: i.state }, h("span", {}, i.label), h("b", {}, i.value)))));
    const n = need();
    const ok = n && (g.state === "pass" || g.state === "warn");
    clear(btnBox, !wallet.address ? h("button", { class: "btn big primary", type: "button", onclick: openConnect }, "Connect wallet")
      : h("button", { class: "btn big blue", type: "button", disabled: !ok || !!st.busy, onclick: doMint }, st.busy || (!n ? "Enter an amount" : g.state === "fail" ? "Blocked by the Liquidity Gate" : g.state === "wait" ? "Checking…" : "Add liquidity")));
    // a centered range needs both tokens: say so when the wallet holds only one
    const [u0, u1] = sidesOf(p, g.r?.tl ?? 0, g.r?.tu ?? 0);
    const b0 = st.bal[lc(p.token0.address)], b1 = st.bal[lc(p.token1.address)];
    const short0 = u0 && u1 && b0 && b1 && (b0.raw === 0n || b1.raw === 0n);
    clear(hintBox, short0 ? h("p", { class: "fine lq-hint" }, `This range needs both ${p.token0.label} and ${p.token1.label}. You hold only ${b0.raw === 0n ? p.token1.label : p.token0.label}: swap about half of it on the `, h("a", { class: "ulink", href: `#/swap?out=${b0.raw === 0n ? (isEth(p.token0) ? "eth" : p.token0.address) : (isEth(p.token1) ? "eth" : p.token1.address)}` }, "Swap page"), " first.") : null);
  }

  /* ---------- transactions (each signed in the user's wallet) ---------- */
  const step = async (label, tx) => {
    st.busy = label; st.tab === "new" ? paintLive() : paint();
    const hash = await sendTx("robinhood", tx);
    const rc = await waitReceipt("robinhood", hash);
    if (rc?.status !== 1) throw new Error(`${label.replace(/…$/, "")} failed.`);
    return { hash, rc };
  };
  async function ensureAllowance(token, amount, label) {
    const { reader } = await import("/agent/js/wallet.js");
    const raw = await reader("robinhood").call({ to: token, data: ERC.encodeFunctionData("allowance", [wallet.address, NPM]) });
    if (BigInt(raw) < amount) await step(label, { to: token, data: ERC.encodeFunctionData("approve", [NPM, amount]), value: "0" });
  }
  // errText turns any "slippage" into the swap wording, so the pool's own revert reason is read from the raw error first
  const said = (e) => /Price slippage check/i.test(String(e?.shortMessage || e?.info?.error?.message || e?.message || ""))
    ? "The price moved more than 1% before this landed, so the price guard stopped it and nothing changed. Check the amounts and try again." : errText(e);
  const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

  async function doMint() { return guarded(_doMint); }
  async function _doMint() {
    if (!wallet.address) return openConnect();
    if (!need()) return toast("Enter an amount.", "error");
    // the pairing on screen can be minutes old (the refresh waits while you type): read the pool now and pair again
    const sug = st.sug;
    try { setPrice(sug.pool, await readPrice(sug.pool.address)); } catch (e) { return toast(`Could not read the pool's price: ${errText(e)}`, "error"); }
    if (!alive || st.sug !== sug) return;
    repair(); paintCard();
    const g = gate(), n = need();
    if (!n) return toast("Enter an amount.", "error");
    if (!(g.state === "pass" || g.state === "warn")) return toast(g.state === "wait" ? "Wait for the checks to finish." : "Blocked by the Liquidity Gate.", "error");
    const p = g.p, r = g.r, ref = BigInt(p.sqrtPriceX96), sa = sqrtAtTick(r.tl), sb = sqrtAtTick(r.tu);
    // the band is anchored to the price in this review, so "1%" means 1% from the number you agreed to
    const [min0, min1] = mintMins(ref, sa, sb, n[0], n[1]);
    const amt = [0, 1].filter((i) => n[i] > 0n).map((i) => { const t = i ? p.token1 : p.token0; return `${fx(Number(n[i]) / 10 ** t.decimals)} ${t.label}`; }).join(" + ");
    const ok = await review({ title: `Add liquidity · ${p.name} ${p.feePct}%`, summary: `Deposit ${amt}`,
      rows: [["Range", `${fx(r.lo)} to ${fx(r.hi)} ${p.quote} per ${p.base}`], ["Stays inside", `${r.stayPct.toFixed(0)}% chance over ${st.sug.days} day${st.sug.days > 1 ? "s" : ""}`],
        ["Fees (estimate)", r.feesPer1kDay > 0 ? `${usd(r.feesPer1kDay)} a day per $1,000 while inside` : "none until the price enters"],
        ["Price guard", `lands only within 1% of ${fx(p.display)} ${p.quote} per ${p.base}`],
        ["Contract", `Uniswap v3 positions ${short(NPM)}`], ["Position NFT to", `${short(wallet.address)} (you)`]],
      confirmLabel: "Continue in wallet" });
    if (!ok) return;
    try {
      let value = 0n;
      for (const [i, t] of [[0, p.token0], [1, p.token1]]) {
        if (n[i] === 0n) continue;
        if (isEth(t)) value = n[i]; else await ensureAllowance(t.address, n[i], `Approve ${t.label}…`);
      }
      // right before the mint, the price once more: past the band the mint would only revert, so stop before it costs gas
      st.busy = "Checking the price…"; paintLive();
      const now = await readPrice(p.address), took = mintTakes(now.sqrtPriceX96, sa, sb, n[0], n[1]);
      if (took[0] < min0 || took[1] < min1) {
        const moved = (Number(now.sqrtPriceX96) / Number(ref)) ** 2 - 1;
        setPrice(p, now); repair(); st.busy = null;
        if (alive && st.tab === "new") paintCard();
        return toast(`The price moved ${pct(p.invert ? 1 / (1 + moved) - 1 : moved)} since your review, past the 1% guard. Nothing was deposited: the amounts now follow the new price. Check them and add again.`, "error", 10000);
      }
      const params = { token0: p.token0.address, token1: p.token1.address, fee: p.fee, tickLower: r.tl, tickUpper: r.tu, amount0Desired: n[0], amount1Desired: n[1],
        amount0Min: min0, amount1Min: min1, recipient: wallet.address, deadline: dl() };
      const calls = [NP.encodeFunctionData("mint", [params])];
      if (value > 0n) calls.push(NP.encodeFunctionData("refundETH"));
      const { rc } = await step("Adding liquidity…", { to: NPM, data: calls.length > 1 ? NP.encodeFunctionData("multicall", [calls]) : calls[0], value: value.toString() });
      const log = rc.logs.find((l) => lc(l.address) === lc(NPM) && l.topics[0] === TRANSFER && BigInt(l.topics[1]) === 0n);
      const id = log ? BigInt(log.topics[3]).toString() : null;
      toast(id ? `Position #${id} is open. Watch it from My positions.` : "Liquidity added.", "ok", 8000);
      st.a = ["", ""]; ins.forEach((x) => { x.value = ""; });
      st.busy = null; st.tab = "positions"; history.replaceState(null, "", "#/liquidity/positions");
      await loadPositions(); loadBalances(p);
    } catch (e) {
      // a mint that reverted on chain (status 0) has no reason attached: the guard is the usual one
      toast(/^Adding liquidity failed/.test(e?.message || "") ? "The deposit was reverted on chain, so your tokens stayed in your wallet (only the network fee was spent). The usual cause is the price moving more than 1% before it landed: check the amounts and try again." : said(e), "error", 9000);
      // and the ticket follows today's price for the next try
      readPrice(p.address).then((s) => { setPrice(p, s); repair(); if (alive && st.tab === "new") paintCard(); }).catch(() => {});
    }
    st.busy = null; st.tab === "new" ? paintLive() : paint();
  }

  // decrease (all), collect, and turn WETH back into ETH in one transaction
  function exitData(x, liquidity, min0, min1) {
    const eth = isEth(x.token0) || isEth(x.token1), id = BigInt(x.tokenId), calls = [];
    if (liquidity > 0n) calls.push(NP.encodeFunctionData("decreaseLiquidity", [{ tokenId: id, liquidity, amount0Min: min0, amount1Min: min1, deadline: dl() }]));
    calls.push(NP.encodeFunctionData("collect", [{ tokenId: id, recipient: eth ? ZERO : wallet.address, amount0Max: MAX128, amount1Max: MAX128 }]));
    if (eth) {
      const other = isEth(x.token0) ? x.token1 : x.token0;
      calls.push(NP.encodeFunctionData("unwrapWETH9", [0n, wallet.address]), NP.encodeFunctionData("sweepToken", [other.address, 0n, wallet.address]));
    }
    return calls.length > 1 ? NP.encodeFunctionData("multicall", [calls]) : calls[0];
  }
  async function doCollect(x) { return guarded(() => _doCollect(x)); }
  async function _doCollect(x) {
    try {
      await step("Collecting fees…", { to: NPM, data: exitData(x, 0n, 0n, 0n), value: "0" });
      toast(`Fees from #${x.tokenId} are in your wallet.`, "ok");
    } catch (e) { toast(said(e), "error", 8000); }
    st.busy = null; await loadPositions();
  }
  async function doRemove(x, rebalance = false) { return guarded(() => _doRemove(x, rebalance)); }
  async function _doRemove(x, rebalance = false) {
    const amt = `${fx(x.amount0 + x.fees0)} ${x.token0.label} + ${fx(x.amount1 + x.fees1)} ${x.token1.label}`;
    const ok = await review({ title: rebalance ? `Rebalance #${x.tokenId}` : `Remove #${x.tokenId}`,
      summary: rebalance ? `Step 1 of 2: remove everything and collect the fees (about ${amt}). Step 2: a new balanced range around today's price, filled with what comes back, for you to check and sign.` : `Remove everything and collect the fees: about ${amt} back to your wallet.`,
      rows: [["Position", `${x.name} ${x.feePct}% #${x.tokenId}`], ["Price guard", "reverts if the price moves more than 1% first"], ["Contract", `Uniswap v3 positions ${short(NPM)}`]], confirmLabel: "Continue in wallet" });
    if (!ok) return;
    try {
      // the 1% guard is taken from a fresh read, not from the list on screen (the price keeps moving)
      st.busy = "Reading the position…"; paint();
      const now = (await api.get(`lp/positions?address=${wallet.address}`)).positions.find((y) => y.tokenId === x.tokenId);
      if (!now || now.closed) throw new Error("That position is already empty.");
      // the same 1% price band as a mint, around the pool's price on chain now (amount × 99% reverts on a tiny move in a tight range)
      const s0 = await readPrice(now.pool);
      const [min0, min1] = burnMins(s0.sqrtPriceX96, sqrtAtTick(now.tickLower), sqrtAtTick(now.tickUpper), BigInt(now.liquidity));
      await step("Removing…", { to: NPM, data: exitData(now, BigInt(now.liquidity), min0, min1), value: "0" });
      x = now;
      toast(`#${x.tokenId} removed: the tokens are back in your wallet.`, "ok", 7000);
      if (rebalance) {
        st.busy = null; st.tab = "new"; st.pool = x.pool; st.sug = null; st.preset = "balanced"; st.custom = null; st.a = ["", ""];
        st.prefill = { have: [x.amount0 + x.fees0, x.amount1 + x.fees1] };
        history.replaceState(null, "", `#/liquidity/${x.pool}`);
        paint(); await loadSug(); await prefill();
        loadPositions();
        return;
      }
    } catch (e) { toast(said(e), "error", 8000); }
    st.busy = null; await loadPositions();
  }
  // after a rebalance: the largest deposit the new range takes from what came back, paired the way the mint pairs it
  // (the pool's price read on chain now, the exact liquidity math), with 0.5% kept back for the price moving before you sign
  async function prefill() {
    const f = st.prefill, s = st.sug, r = sel();
    st.prefill = null;
    if (!f || !s || !r) return;
    const p = s.pool;
    try { setPrice(p, await readPrice(p.address)); } catch {}
    if (!alive || st.sug !== s) return;
    const sp = BigInt(p.sqrtPriceX96), sa = sqrtAtTick(r.tl), sb = sqrtAtTick(r.tu);
    const have = [toRaw(f.have[0] * 0.995, p.token0.decimals), toRaw(f.have[1] * 0.995, p.token1.decimals)];
    const [a0, a1] = amountsAt(sp, sa, sb, liquidityFor(sp, sa, sb, have[0], have[1]));
    const out = (raw, d) => (raw > 0n ? String(+(Number(raw) / 10 ** d).toPrecision(10)) : "");
    st.a = [out(a0, p.token0.decimals), out(a1, p.token1.decimals)];
    // the side that ran out first stays fixed when the ticket pairs again at the click, so it never asks for more than came back
    st.edit = sp <= sa ? 0 : sp >= sb ? 1 : liq0(sp, sb, have[0]) <= liq1(sa, sp, have[1]) ? 0 : 1;
    paintCard();
    toast("Step 2: check the new range and sign Add liquidity.", "", 7000);
  }
  async function doWatch(x) {
    if (!wallet.session) return signInNow();
    if (st.watching || st.watched.has(x.tokenId)) return;
    st.watching = x.tokenId; paint();
    try {
      const r = await api.post("watches", { type: "lp_range", params: { tokenId: x.tokenId, name: x.name, edgePct: 5 } });
      toast(`Watching: ${r.item.title}`, "ok", 6000);
      st.watched.add(x.tokenId);
    } catch (e) { if (/already watched/i.test(e.message)) st.watched.add(x.tokenId); toast(e.message, "error"); }
    st.watching = null; paint();
  }

  /* ---------- my positions ---------- */
  function positions() {
    if (!wallet.address) return clear(body, h("div", { class: "panel sd-panel" }, h("div", { class: "sd-empty" }, h("span", { class: "sd-empty-ico" }, icon("wallet")),
      h("p", {}, "Connect your wallet to see your Uniswap v3 positions on Robinhood Chain: range, fees to collect and a rebalance button."),
      h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet"))));
    if (st.posErr) return clear(body, h("div", { class: "alert error" }, st.posErr));
    if (!st.positions) return clear(body, h("div", { class: "sk", style: { height: "260px" } }));
    if (!st.positions.length) return clear(body, h("div", { class: "panel sd-panel" }, h("div", { class: "sd-empty" }, h("span", { class: "sd-empty-ico" }, icon("pool")),
      h("p", {}, "No Uniswap v3 positions in this wallet yet."),
      h("button", { class: "btn primary", type: "button", onclick: () => { st.tab = "new"; history.replaceState(null, "", `#/liquidity${st.pool ? `/${st.pool}` : ""}`); paint(); } }, "Open a position"))));
    clear(body, h("div", { class: "lq-pos" }, st.positions.map((x) => {
      const room = Math.min(x.roomDownPct ?? 1e9, x.roomUpPct ?? 1e9);
      const [cls, label] = x.closed ? ["muted", "Closed"] : !x.inRange ? ["down", "Out of range"] : room <= 5 ? ["warn", "Near the edge"] : ["up", "In range"];
      return h("div", { class: "panel lq-p" },
        h("div", { class: "lq-p-h" }, x.token0 && x.token1 ? pairIcons(x) : null, h("b", {}, x.name), h("span", { class: "chip" }, `${x.feePct}%`), h("span", { class: "fine" }, `#${x.tokenId}`), h("span", { class: `lq-badge ${cls}` }, label)),
        x.closed ? null : rangeBar(x.displayLower, x.displayUpper, x.price),
        h("div", { class: "lq-range-l" }, h("span", {}, `Min ${fx(x.displayLower)}`), h("span", {}, `Now ${fx(x.price)}`), h("span", {}, `Max ${fx(x.displayUpper)}`)),
        h("div", { class: "lq-p-rows" },
          h("span", {}, "Holds ", h("b", {}, `${fx(x.amount0)} ${x.token0.label} + ${fx(x.amount1)} ${x.token1.label}`), x.valueUsd != null ? h("span", { class: "fine" }, ` ≈ ${usd(x.valueUsd)}`) : null),
          h("span", {}, "Fees to collect ", h("b", {}, `${fx(x.fees0)} ${x.token0.label} + ${fx(x.fees1)} ${x.token1.label}`), x.feesUsd != null ? h("span", { class: "fine" }, ` ≈ ${usd(x.feesUsd)}`) : null),
          !x.closed && x.inRange ? h("span", { class: "fine" }, `Room before it leaves: ${fx(x.roomDownPct)}% down, ${fx(x.roomUpPct)}% up`) : null),
        h("div", { class: "lq-p-act" },
          h("button", { class: "btn sm", type: "button", disabled: !!st.busy || !(x.fees0 > 0 || x.fees1 > 0), onclick: () => doCollect(x) }, "Collect fees"),
          x.closed ? null : h("button", { class: "btn sm", type: "button", disabled: !!st.busy, onclick: () => doRemove(x) }, "Remove all"),
          x.closed ? null : h("button", { class: "btn sm blue", type: "button", disabled: !!st.busy, onclick: () => doRemove(x, true), title: "Remove it, then open a new balanced range around today's price" }, "Rebalance"),
          x.closed ? null : st.watched.has(x.tokenId) ? h("button", { class: "btn sm", type: "button", disabled: true, title: "Range watch on: inbox and Telegram" }, icon("check"), "Watching")
            // the watch writes to your inbox, so it needs a session: sign in right here, the button turns into Watch it
            : !wallet.session ? h("button", { class: "btn sm", type: "button", onclick: signInNow, title: "Sign in once (a free signature, no gas) so the range watch can write to your inbox and Telegram" }, icon("key"), "Sign in to watch")
            : h("button", { class: "btn sm", type: "button", disabled: st.watching === x.tokenId, onclick: () => doWatch(x), title: "A note in your inbox and Telegram when the price leaves the range or comes within 5% of an edge" }, st.watching === x.tokenId ? "Saving…" : "Watch it")));
    })), st.busy ? h("p", { class: "fine" }, st.busy) : null);
  }

  const off = onWallet(() => { st.bal = {}; if (st.sug) loadBalances(st.sug.pool); loadPositions(); });
  paint();
  loadPools(); loadPositions();
  // refresh once a minute, but never while someone is typing in the ticket
  const t = setInterval(() => { if (document.hidden || st.busy || card.contains(document.activeElement)) return; if (st.tab === "positions") loadPositions(); else if (st.pool) loadSug(true); }, 60_000);
  return () => { alive = false; off(); clearInterval(t); };
}
