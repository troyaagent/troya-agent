// V8 F41 War Table: the coin page as a trading terminal, on Watchfire's live board (/api/watchfire/:token/board):
// trades labelled dev, insider, sniper, bundler, ring, whale and bot, with filters; early buyers and what they did since;
// tags on holders; instant buys and sells that always pass the Gate; marks on the chart for dev trades and Watchfire fires.
import { h, clear, icon, toast, short, compact } from "../ui.js";
import { api } from "../api.js";
import { wallet } from "../wallet.js";

export const TAGS = {
  dev: ["Dev", "The wallet that deployed the coin"],
  insider: ["Insider", "Freed from the snipe tax in the launch itself"],
  sniper: ["Sniper", "Bought in the first ~12 seconds"],
  bundler: ["Bundler", "Bought in one transaction together with 2+ other wallets"],
  ring: ["Ring", "Sent coins into one wallet together with 4+ others within seconds (Watchfire)"],
  whale: ["Whale", "Holds 1% of the supply or more"],
  bot: ["Bot", "Bought through a trading bot's router"],
};
export const tagEl = (k) => h("span", { class: `wt-tag t-${k}`, title: TAGS[k]?.[1] || "" }, TAGS[k]?.[0] || k);
const secs = (s) => (s == null ? "–" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`);
const pctTxt = (p) => (p == null ? "–" : p < 0.001 ? "<0.001%" : p < 1 ? `${p.toFixed(3)}%` : `${p.toFixed(2)}%`);
const SCAN = "https://robinhoodchain.blockscout.com";

/* ---------- the live board, polled while the page is open ---------- */
export function startBoard(address, onData) {
  let stop = false, t = null;
  const run = async () => {
    if (stop) return;
    try { const b = await api.get(`/api/watchfire/${address}/board`); if (!stop) onData(b); } catch { /* next round */ }
    if (!stop) t = setTimeout(run, document.hidden ? 30_000 : 8_000);
  };
  run();
  return () => { stop = true; clearTimeout(t); };
}

/* ---------- Watchfire panel ---------- */
const LVL = { clear: ["Calm", "Nothing unusual in this coin's transfers."], amber: ["Watch", "Weight in few hands. Nothing moving yet."], red: ["Selling fast", "Holders are leaving quickly."], fire: ["Fire", "A dump pattern just happened."], loading: ["Reading", "Reading this coin's transfers."] };
export function watchfirePanel() {
  const badge = h("span", { class: "wt-lvl l-loading" }, "Reading");
  const sub = h("p", { class: "fine muted wt-sub" }, LVL.loading[1]);
  const why = h("ul", { class: "wt-why" });
  const met = h("div", { class: "wt-met" });
  const live = h("span", { class: "wt-live", title: "Live feed of every transfer" });
  // V8 F46: pin the coin, and every Watchfire fire on it reaches your inbox and Telegram
  let token = null;
  const pin = h("button", { class: "btn sm wt-pin", type: "button", hidden: true, onclick: async () => {
    if (!wallet.session) return toast("Sign in to pin coins to Watchfire.", "warn");
    try { const r = await api.post("/api/treasury/pins", { token, on: true }); toast(`Pinned. ${r.pins.length} of ${r.max} pins used.`, "ok"); pin.textContent = "Pinned"; pin.disabled = true; }
    catch (e) { toast(e.message, "error"); }
  } }, icon("bell"), "Pin");
  const el = h("section", { class: "panel wt-wf" },
    h("div", { class: "panel-h" }, h("h2", {}, "Watchfire"), live),
    h("div", { class: "wt-wf-b" }, badge, sub), why, met,
    h("p", { class: "fine muted wt-foot" }, "Reads every transfer of this coin: coins gathered into one wallet, a 5%+ sale, fast selling, weight in few hands. Patterns, not proof; nobody can sell ahead of a dump inside one block."),
    h("div", { class: "wt-foot" }, pin, h("a", { class: "link fine", href: "#/treasury" }, "Pins by tier")));
  el.update = (b) => {
    if (b?.token && !token) { token = b.token; pin.hidden = false; }
    const k = LVL[b?.level] ? b.level : "loading";
    badge.className = `wt-lvl l-${k}`; badge.textContent = LVL[k][0];
    sub.textContent = b?.lastFire && k === "fire" ? `${LVL[k][1]} ${Math.max(0, Math.round((Date.now() - b.lastFire.at) / 1000))}s ago.` : LVL[k][1];
    clear(why, (b?.why || []).slice(0, 4).map((x) => h("li", {}, x)));
    const m = b?.metrics;
    clear(met, m ? [
      h("div", {}, h("small", {}, "Largest holder"), h("b", {}, `${(m.topPct ?? 0).toFixed(1)}%`)),
      h("div", {}, h("small", {}, "Bought via one bot"), h("b", {}, `${Math.round(m.herdPct ?? 0)}%`)),
      h("div", {}, h("small", {}, "Sold last minute"), h("b", {}, `${(m.soldLastMinPct ?? 0).toFixed(1)}%`)),
      h("div", {}, h("small", {}, "Sellers / buyers 2m"), h("b", {}, `${m.sellers2m ?? 0} / ${m.buyers2m ?? 0}`)),
    ] : []);
    live.className = `wt-live${b?.level && b.level !== "loading" ? " on" : ""}`;
    live.textContent = b?.level && b.level !== "loading" ? "Live" : "";
  };
  return el;
}

/* ---------- instant trade: Agent Wallet (Gate + caps, server side), else Troya Swap with the amount filled in ---------- */
export function tradePanel(t, address) {
  const st = { aw: null, bal: 0, eth: null, armed: null, armT: null, busy: false };
  const BUYS = [0.001, 0.005, 0.01, 0.05], SELLS = [25, 50, 100];
  const mode = h("p", { class: "fine muted wt-mode" }, "Checking your wallet…");
  const out = h("p", { class: "fine wt-out", "aria-live": "polite" });
  const custom = h("input", { class: "wt-in", type: "text", inputmode: "decimal", placeholder: "ETH", "aria-label": "Custom ETH amount" });
  const buyRow = h("div", { class: "wt-row" });
  const sellRow = h("div", { class: "wt-row" });
  const el = h("section", { class: "panel wt-trade" },
    h("div", { class: "panel-h" }, h("h2", {}, "Trade"), h("span", { class: "fine muted" }, "Gate first, always")),
    h("div", { class: "wt-lbl" }, "Buy with ETH"), buyRow,
    h("div", { class: "wt-row wt-custom" }, custom, h("button", { class: "btn sm", type: "button", onclick: () => { const v = Number(custom.value); if (v > 0) act("buy", v); else toast("Type an ETH amount.", "warn"); } }, "Buy")),
    h("div", { class: "wt-lbl" }, `Sell $${t.symbol}`), sellRow, mode, out);
  const disarm = () => { st.armed = null; clearTimeout(st.armT); paint(); };
  function paint() {
    clear(buyRow, BUYS.map((v) => {
      const armed = st.armed?.kind === "buy" && st.armed.v === v;
      if (!st.aw) return h("a", { class: "wt-amt", href: `#/swap?out=${address}&amount=${v}` }, `${v}`);
      return h("button", { class: `wt-amt${armed ? " armed" : ""}`, type: "button", disabled: st.busy, onclick: () => act("buy", v) }, armed ? `Confirm ${v}` : `${v}`);
    }));
    clear(sellRow, st.aw && st.bal > 0 ? SELLS.map((p) => {
      const armed = st.armed?.kind === "sell" && st.armed.v === p;
      return h("button", { class: `wt-amt sell${armed ? " armed" : ""}`, type: "button", disabled: st.busy, onclick: () => act("sell", p) }, armed ? `Confirm ${p}%` : `${p}%`);
    }) : [h("a", { class: "wt-amt sell wide", href: `#/swap?in=${address}&out=ETH` }, st.aw ? `None in your Agent Wallet · sell in Swap` : `Sell in Troya Swap`)]);
  }
  async function act(kind, v) {
    if (!st.aw) return;
    if (!(st.armed?.kind === kind && st.armed.v === v)) { st.armed = { kind, v }; clearTimeout(st.armT); st.armT = setTimeout(disarm, 6000); paint(); return; }
    clearTimeout(st.armT); st.armed = null; st.busy = true; paint();
    const amountIn = kind === "buy" ? String(v) : (st.bal * (v / 100) * (v === 100 ? 0.999 : 1)).toPrecision(12).replace(/\.?0+$/, "");
    const params = kind === "buy" ? { tokenIn: "ETH", tokenOut: address, amountIn, slippagePct: 5 } : { tokenIn: address, tokenOut: "ETH", amountIn, slippagePct: 8 };
    out.textContent = kind === "buy" ? `Running the Gate, then buying with ${amountIn} ETH…` : `Running the Gate, then selling ${v}%…`;
    try {
      const r = await api.post("agent-wallet/execute", { kind: "swap", params, source: "wartable" });
      if (r.executed) { out.textContent = r.summary || "Done."; toast(r.summary || "Done.", "ok"); }
      else { out.textContent = `Not sent: ${(r.reasons || []).join(" ") || "blocked by the Gate or your caps"}`; toast("Not sent. See the reason under the buttons.", "warn"); }
    } catch (e) { out.textContent = e.message; toast(e.message, "error"); }
    st.busy = false;
    await loadAw();
  }
  async function loadAw() {
    if (!wallet.session) { st.aw = null; mode.textContent = "Not signed in: the buttons open Troya Swap with the amount filled in, and your wallet signs."; paint(); return; }
    try {
      const aw = await api.get("agent-wallet");
      st.aw = aw?.address ? aw : null;
      if (st.aw) {
        const b = await api.get("agent-wallet/balances").catch(() => null);
        st.eth = b?.robinhoodEth ?? null;
        st.bal = Number((b?.robinhoodTokens || []).find((x) => String(x.address).toLowerCase() === address)?.amount || 0);
        mode.textContent = `From your Agent Wallet${st.eth != null ? ` (${st.eth.toFixed(4)} ETH)` : ""}: one tap arms, a second tap sends. The Gate and your caps run on the server before anything is sent.`;
      } else mode.textContent = "No Agent Wallet yet: the buttons open Troya Swap with the amount filled in. An Agent Wallet makes them one-tap.";
    } catch { st.aw = null; mode.textContent = "The buttons open Troya Swap with the amount filled in."; }
    paint();
  }
  paint();
  loadAw();
  return el;
}

/* ---------- tabs: trades with filters, early buyers ---------- */
export function renderTrades(box, b, filter, setFilter, symbol) {
  const counts = b?.counts || {};
  const chips = h("div", { class: "wt-chips" },
    h("button", { class: `wt-chip${filter === "all" ? " on" : ""}`, type: "button", onclick: () => setFilter("all") }, "All"),
    Object.keys(TAGS).map((k) => h("button", { class: `wt-chip${filter === k ? " on" : ""}`, type: "button", title: TAGS[k][1], onclick: () => setFilter(k) }, TAGS[k][0], counts[k] ? h("small", {}, String(counts[k])) : null)));
  const list = (b?.trades || []).filter((x) => filter === "all" || x.tags.includes(filter));
  clear(box, h("div", { class: "panel mk-panel wt-panel" }, chips,
    list.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl wt-tbl" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Age"), h("th", { class: "l" }, "Side"), h("th", {}, "% supply"), h("th", {}, symbol), h("th", { class: "l" }, "Trader"))),
      h("tbody", {}, list.slice(0, 120).map((x) => h("tr", {},
        h("td", { class: "l muted" }, h("a", { class: "link", href: `${SCAN}/tx/${x.tx}`, target: "_blank", rel: "noopener" }, secs(x.secsAgo))),
        h("td", { class: `l ${x.kind === "buy" ? "tk-trade-buy" : "tk-trade-sell"}` }, x.kind === "buy" ? "Buy" : "Sell"),
        h("td", {}, pctTxt(x.pct)), h("td", {}, compact(x.tokens, 2)),
        h("td", { class: "l" }, h("a", { class: "link mono", href: `${SCAN}/address/${x.wallet}`, target: "_blank", rel: "noopener" }, short(x.wallet, 4)), " ", x.tags.map(tagEl))))))) :
      h("div", { class: "empty" }, filter === "all" ? (b?.level === "loading" ? "Reading this coin's transfers…" : "No trades in the window Watchfire reads yet.") : `No ${TAGS[filter][0].toLowerCase()} trades in this window.`),
    h("p", { class: "fine" }, `Every buy and sell of the coin, read live from the chain by Watchfire${b && !b.fullHistory ? " (this coin is older than 6 hours: the last 6 hours)" : ""}. Tags are patterns, not accusations.`)));
}
export function renderEarly(box, b) {
  const list = b?.early || [];
  if (b && !b.fullHistory) { clear(box, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "This coin is older than 6 hours, so Watchfire did not see its first buyers."))); return; }
  clear(box, h("div", { class: "panel mk-panel wt-panel" },
    list.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl wt-tbl" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, "#"), h("th", { class: "l" }, "Wallet"), h("th", {}, "In after"), h("th", {}, "Bought"), h("th", {}, "Holds now"), h("th", { class: "l" }, "Since"))),
      h("tbody", {}, list.map((x, i) => h("tr", {},
        h("td", { class: "l rank" }, i + 1),
        h("td", { class: "l" }, h("a", { class: "link mono", href: `${SCAN}/address/${x.wallet}`, target: "_blank", rel: "noopener" }, short(x.wallet, 4)), " ", x.tags.map(tagEl)),
        h("td", {}, secs(x.secsAfterLaunch)), h("td", {}, pctTxt(x.boughtPct)), h("td", {}, pctTxt(x.nowPct)),
        h("td", { class: `l wt-st s-${x.status.replace(/\s/g, "-")}` }, x.status)))))) : h("div", { class: "empty" }, "No buyers yet."),
    h("p", { class: "fine" }, "The first buyers after the launch and what each did since. Snipers who sold everything early are normal; a wave of them is a warning.")));
}

/* ---------- chart marks: dev buys and sells, Watchfire fires ---------- */
export function chartMarks(b, times, ivSecs) {
  if (!b || !times?.length) return [];
  const now = Date.now() / 1000;
  const snap = (ts) => { let best = null; for (const x of times) { if (x <= ts) best = x; else break; } return best ?? (ts - times[0] < ivSecs ? times[0] : null); };
  const marks = [];
  for (const x of b.trades || []) {
    if (!x.tags.includes("dev")) continue;
    const tm = snap(now - x.secsAgo);
    if (tm != null) marks.push({ time: tm, position: x.kind === "buy" ? "belowBar" : "aboveBar", color: x.kind === "buy" ? "#6fd39a" : "#ff6b7d", shape: x.kind === "buy" ? "arrowUp" : "arrowDown", text: x.kind === "buy" ? "DB" : "DS" });
  }
  if (b.lastFire?.at) { const tm = snap(b.lastFire.at / 1000); if (tm != null) marks.push({ time: tm, position: "aboveBar", color: "#ffb454", shape: "circle", text: "WF" }); }
  const seen = new Set();
  return marks.sort((a, c) => a.time - c.time).filter((m) => { const k = `${m.time}${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export { icon };
