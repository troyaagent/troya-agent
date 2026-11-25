// V10 F67 Nekyia, the Ghost Trade (#/nekyia): a wallet's own trades on Robinhood Chain replayed as the paths not taken: held
// until now, sold at the best price while it was held, or the Gate's verdict at buy time followed. Every number in ETH with the
// transactions and blocks behind it. Everything comes from GET /api/nekyia/:wallet (server/nekyia.mjs). A replay, never a
// forecast; reading only, this page never asks a wallet to sign anything.
import { h, clear, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, openConnect } from "/agent/js/wallet.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
function eth(x) {
  if (x == null || !isFinite(x)) return "–";
  const a = Math.abs(x), d = a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${a.toFixed(d).replace(/\.?0+$/, "") || "0"} ETH`;
}
const plainEth = (x) => eth(x).replace(/^\+/, "");
const when = (ms) => (ms ? `${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${new Date(ms).toISOString().slice(11, 16)} UTC` : "–");
const tone = (x) => (x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "");
const PATHS = [["actual", "What happened"], ["hold", "Held until now"], ["top", "Sold at the top"], ["gate", "Followed the Gate"]];

function css() {
  if (document.querySelector("style[data-nekyia]")) return;
  document.head.append(h("style", { "data-nekyia": "1" }, `
.nk-page { display: grid; gap: 16px; }
.nk-box { padding: 18px; }
.nk-box h3 { margin: 0 0 8px; font-size: 15px; }
.nk-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.nk-form input { font-family: var(--mono, ui-monospace, monospace); font-size: 13px; }
.nk-opts { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-top: 10px; font-size: 12.5px; color: var(--muted); }
.nk-opts input { width: 7em; }
.nk-opts .coin { width: 22em; max-width: 100%; font-family: var(--mono, ui-monospace, monospace); }
.nk-wait { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 13.5px; padding: 12px 0; }
.nk-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line-3); border-top-color: var(--fg); animation: nkspin 0.9s linear infinite; }
@keyframes nkspin { to { transform: rotate(360deg); } }
.nk-sent { font-size: 14.5px; margin: 4px 0 12px; }
.nk-tot { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.nk-tot div { border: 1px solid var(--line-2); border-radius: 10px; padding: 10px 12px; background: var(--bg-2); }
.nk-tot small { display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.nk-tot b { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.nk-tot .up, .nk-path .up { color: var(--up); } .nk-tot .down, .nk-path .down { color: var(--down); }
.nk-tot span { display: block; font-size: 11.5px; color: var(--muted); }
.nk-trips { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.nk-trip { border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; }
.nk-trip header { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin-bottom: 8px; }
.nk-trip header b { font-size: 15px; }
.nk-tag { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
.nk-legs { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.nk-paths { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.nk-path { border: 1px solid var(--line-2); border-radius: 10px; padding: 9px 11px; background: var(--bg-2); display: grid; gap: 3px; align-content: start; }
.nk-path small { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.nk-path b { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.nk-path p { margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.4; }
.nk-path a { font-size: 11.5px; }
.nk-why { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; }
.nk-note { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin: 12px 0 0; }
@media (max-width: 760px) { .nk-paths, .nk-tot { grid-template-columns: 1fr 1fr; } .nk-form { grid-template-columns: 1fr; } }`));
}

function pathCard(key, label, p) {
  if (!p) return h("div", { class: "nk-path" }, h("small", {}, label), h("b", {}, "–"), h("p", {}, "Not read for this trade."));
  const links = [];
  for (const tx of (p.txs || []).filter(Boolean)) links.push(h("a", { class: "link", href: `${EXPLORER}/tx/${tx}`, target: "_blank", rel: "noopener" }, `tx ${short(tx)}`));
  if (p.block) links.push(h("a", { class: "link", href: p.blockUrl || `${EXPLORER}/block/${p.block}`, target: "_blank", rel: "noopener" }, `block ${p.block.toLocaleString("en-US")}`));
  if (p.post) links.push(h("a", { class: "link", href: p.post, target: "_blank", rel: "noopener" }, "Sentry's post"));
  let extra = null;
  if (key === "top" && p.eth != null) extra = h("p", {}, `${when(p.at)}${p.xOfEntry ? ` · ${p.xOfEntry.toFixed(2)}x the price at the buy` : ""}`);
  if (key === "gate") extra = p.verdict ? h("p", {}, `The Gate: ${p.said}, ${when(p.at)}, from ${p.source}.${p.reason ? ` "${p.reason}"` : ""}`)
    : p.later ? h("p", {}, `A verdict came only after the buy (${p.later.verdict}, ${when(p.later.at)}, ${p.later.source}).`) : null;
  return h("div", { class: "nk-path" }, h("small", {}, label), h("b", { class: tone(p.eth) }, p.eth == null ? "–" : eth(p.eth)), h("p", {}, p.text || ""), extra,
    p.method ? h("p", {}, `Priced by ${p.method}.`) : null, links.length ? h("p", {}, ...links.flatMap((l, i) => (i ? [" · ", l] : [l]))) : null);
}

export async function mount(view, ctx = {}) {
  css();
  let alive = true, seq = 0, timer = null;
  const input = h("input", { class: "input", placeholder: "0x… a wallet that trades on Robinhood Chain", spellcheck: "false", autocomplete: "off" });
  if (wallet.address) input.value = wallet.address;
  const coin = h("input", { class: "input coin", placeholder: "0x… one coin only (optional)", spellcheck: "false", autocomplete: "off" });
  const days = h("input", { class: "input", type: "number", min: "1", max: "30", placeholder: "days" });
  const go = h("button", { class: "btn primary", type: "button" }, "Replay");
  const out = h("div", { "aria-live": "polite" });

  async function run(raw, { again = 0 } = {}) {
    clearTimeout(timer);
    const a = ADDR.exec(String(raw || "").trim())?.[0];
    if (!a) { toast("Paste a wallet address on Robinhood Chain (0x + 40 characters).", "error"); input.focus(); return; }
    const tk = coin.value.trim() ? ADDR.exec(coin.value.trim())?.[0] : null;
    if (coin.value.trim() && !tk) { toast("The coin is not a valid 0x address.", "error"); return; }
    const dd = days.value.trim() ? Math.round(Number(days.value)) : null;
    if (dd != null && !(dd >= 1 && dd <= 30)) { toast("Days is 1 to 30.", "error"); return; }
    const id = ++seq;
    input.value = a;
    if (location.hash !== `#/nekyia/${a}`) history.replaceState(null, "", `#/nekyia/${a}`);
    if (!again) clear(out, h("div", { class: "nk-wait" }, h("span", { class: "nk-spin" }), h("span", {}, "Reading this wallet's trades and the prices the chain recorded while it held them…")));
    go.disabled = true;
    const q = new URLSearchParams();
    if (tk) q.set("token", tk);
    if (dd) q.set("days", String(dd));
    let r;
    try { r = await api.get(`/api/nekyia/${a}${q.toString() ? `?${q}` : ""}`); }
    catch (e) { if (!alive || id !== seq) return; go.disabled = false; clear(out, h("div", { class: "dk-empty" }, h("b", {}, "Nekyia could not read this wallet right now."), h("p", {}, e.message))); return; }
    if (!alive || id !== seq) return;
    go.disabled = false;
    if (r.status === "reading") {
      clear(out, h("div", { class: "nk-wait" }, h("span", { class: "nk-spin" }), h("span", {}, r.sentence)));
      if (again < 12) timer = setTimeout(() => { if (alive && id === seq) run(a, { again: again + 1 }); }, 6000);
      return;
    }
    render(r);
  }

  function render(r) {
    if (r.status !== "done") { clear(out, h("div", { class: "dk-empty" }, h("b", {}, r.sentence || "Nothing to replay."), r.note ? h("p", {}, r.note) : null)); return; }
    const T = r.totals || {}, C = T.comparable || {};
    const tot = (k, label) => {
      const x = T[k] || {};
      return h("div", {}, h("small", {}, label), h("b", { class: tone(x.eth) }, x.trips ? eth(x.eth) : "–"), h("span", {}, `over ${x.trips || 0} trade${x.trips === 1 ? "" : "s"} with a number`));
    };
    clear(out,
      h("p", { class: "nk-sent" }, r.sentence),
      h("div", { class: "nk-tot" }, tot("actual", "What happened"), tot("hold", "Held until now"), tot("top", "Sold at the top"), tot("gate", "Followed the Gate")),
      C.trips ? h("p", { class: "fine", style: { marginTop: "8px" } }, `On the ${C.trips} trade${C.trips === 1 ? "" : "s"} where all four have a number: what happened ${eth(C.actual)}, held ${eth(C.hold)}, at the top ${eth(C.top)}, following the Gate ${eth(C.gate)}.`) : null,
      h("ul", { class: "nk-trips", style: { marginTop: "14px" } }, r.trips.map((t) => h("li", { class: "nk-trip" },
        h("header", {}, h("b", {}, `$${t.symbol}`), h("a", { class: "link mono", href: `#/gate/${t.token}`, style: { fontSize: "11.5px" } }, short(t.token)), h("span", { class: "nk-tag" }, t.state === "open" ? "Still open" : "Closed")),
        h("div", { class: "nk-legs" },
          h("span", {}, `Bought ${when(t.entry.at)} for ${plainEth(t.entry.costEth)}${t.entry.buys > 1 ? ` in ${t.entry.buys} buys` : ""} · `, h("a", { class: "link", href: t.entry.url, target: "_blank", rel: "noopener" }, "first buy")),
          t.exit && !t.exit.partial ? h("span", {}, `Sold ${when(t.exit.at)} for ${plainEth(t.exit.proceedsEth)}${t.exit.sells > 1 ? ` in ${t.exit.sells} sells` : ""} · `, h("a", { class: "link", href: t.exit.url, target: "_blank", rel: "noopener" }, "last sale")) : null,
          t.exit?.partial ? h("span", {}, `Sold part so far for ${plainEth(t.exit.proceedsEth)}`) : null),
        h("div", { class: "nk-paths" }, PATHS.map(([k, label]) => pathCard(k, label, t.paths?.[k]))),
        t.why ? h("p", { class: "nk-why" }, t.why) : null))),
      r.replayed && r.replayed.of > r.replayed.shown ? h("p", { class: "fine", style: { marginTop: "10px" } }, `${r.replayed.of - r.replayed.shown} older round trip${r.replayed.of - r.replayed.shown === 1 ? " is" : "s are"} not replayed (the newest ${r.replayed.limit} are). Pick one coin above to replay only its trades.`) : null,
      h("p", { class: "nk-note" }, r.note),
      h("p", { class: "fine" }, `Read ${r.sample?.transactions ?? "–"} transactions; left out: ${r.sample?.leftOut?.mixedWithTransfers ?? 0} trades mixed with plain transfers (their cost is not known), ${r.sample?.leftOut?.soldBeforeHistory ?? 0} sales of coins bought before the history read. Gas is not counted.`));
  }

  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  const mine = h("button", { class: "link", type: "button", onclick: () => (wallet.address ? run(wallet.address) : openConnect()) }, "my wallet");

  clear(view, h("div", { class: "dk nk-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Nekyia · V10 Poseidon"),
      h("h1", {}, "The trades you ", h("em", {}, "didn't"), " make."),
      h("p", { class: "dk-sub" }, "Replay a wallet's own trades on Robinhood Chain as the paths not taken: if it had held until now, sold at the highest price reached while it held, or followed Troya Gate's verdict at the time it bought. Every number is in ETH, priced from the chain at a given block, with the transactions behind it. A replay from history, never a forecast.")),
    h("section", { class: "panel nk-box" },
      h("div", { class: "nk-form" }, input, go),
      h("div", { class: "nk-opts" }, h("span", {}, "Try ", mine, "."), h("label", {}, "Coin ", coin), h("label", {}, "Top within ", days, " days after the buy (empty: while it was held)")),
      h("div", { style: { marginTop: "14px" } }, out)),
    h("section", { class: "panel nk-box" }, h("h3", {}, "How the ghosts are priced"),
      h("ul", { class: "nk-note", style: { paddingLeft: "18px", display: "grid", gap: "5px" } },
        h("li", {}, "What happened: the ETH the wallet's own buys and sells moved. An open trade adds the coins still held at the price now."),
        h("li", {}, "Held until now: everything bought, valued at the latest block. On the Pons curve it is the curve's own sale of that size after its fee and tax; in a Uniswap pool it is the spot price, before the price impact, so an upper bound."),
        h("li", {}, "Sold at the top: the best of a set of price reads between the buy and the sale (or the N days after the buy). The real peak can sit between two reads."),
        h("li", {}, "Followed the Gate: the latest verdict Troya had recorded before the buy. Blocked for a safety reason means no buy, so nothing gained or lost. Without a verdict on record it says so. Troya kept blocked verdicts only from 25 Nov 2026."),
        h("li", {}, "Only coins launched on Pons and paired with ETH get the three ghost paths. Gas is not counted.")))));

  const start = ctx.parts?.[0] || ctx.query?.address || "";
  if (ctx.query?.token) coin.value = ctx.query.token;
  if (ADDR.test(start)) run(start);
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; clearTimeout(timer); };
}
