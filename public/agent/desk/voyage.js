// V10 F65 Voyage (#/voyage, #/voyage/<id>): write a goal in one sentence and see the plan laid out from Troya's own reads
// (Troya Atlas venues, the Gate verdict, bridge quotes, costs and risks), signed by Troya; afterwards log the transaction to
// see what the plan quoted against what the wallet got. Everything comes from server/voyage.mjs. This page never asks a
// wallet to sign or send anything: "Open in Swap" hands over to Swap, which quotes again and runs the Gate first.
import { h, clear, toast, ago } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet } from "/agent/js/wallet.js";

const FALLBACK_EXAMPLES = ["Buy 0.01 ETH of $TROYA the safest way", "DCA 0.005 ETH into $TROYA every week for a month", "Move 0.02 ETH from Base to Robinhood Chain and buy $TROYA", "Bridge 0.05 ETH from Arbitrum to Robinhood Chain"];
const KIND = { buy: "One buy", dca: "DCA schedule", "bridge-buy": "Cross and buy", bridge: "Crossing" };
const nf = (v, d = 6) => (v == null || !Number.isFinite(Number(v)) ? "–" : Number(v) >= 1000 ? Math.round(Number(v)).toLocaleString("en-US") : String(+Number(v).toPrecision(d)));
const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `$${Number(v) < 0.01 ? Number(v).toPrecision(2) : Number(v).toFixed(2)}`);
const eta = (s) => (s == null ? null : s < 90 ? `about ${Math.max(1, Math.round(s))} s` : `about ${Math.round(s / 60)} min`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function css() {
  if (document.querySelector("style[data-voyage]")) return;
  document.head.append(h("style", { "data-voyage": "1" }, `
.vy-page { display: grid; gap: 16px; }
.vy-box { padding: 18px; }
.vy-box h3 { margin: 0 0 8px; font-size: 15px; }
.vy-line { display: flex; gap: 8px; }
.vy-line input { flex: 1; min-width: 0; font-size: 15px; }
.vy-opt { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.vy-opt small { color: var(--faint); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-right: 4px; }
.vy-me { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-top: 10px; }
.vy-sum { padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--bg-2); border-left: 4px solid var(--muted); font-size: 14px; line-height: 1.5; }
.vy-sum.passed { border-left-color: var(--up); } .vy-sum.caution { border-left-color: var(--warn); } .vy-sum.blocked, .vy-sum.failed { border-left-color: var(--down); }
.vy-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.vy-chip { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; white-space: nowrap; color: var(--muted); }
.vy-chip.up { color: var(--up); border-color: var(--up); } .vy-chip.warn { color: var(--warn); border-color: var(--warn); } .vy-chip.down { color: var(--down); border-color: var(--down); }
.vy-opts { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }
.vy-o { padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 12px; display: grid; gap: 8px; }
.vy-o-h { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.vy-o-h b { font-size: 14.5px; }
.vy-nums { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.vy-nums div { padding: 6px 8px; border-radius: 8px; background: var(--bg-2); border: 1px solid var(--line-2); min-width: 0; }
.vy-nums small { display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.vy-nums span { font-size: 13px; overflow-wrap: anywhere; }
.vy-steps { margin: 0; padding-left: 20px; display: grid; gap: 3px; font-size: 13px; color: var(--fg); }
.vy-o .fine { margin: 0; }
.vy-risks { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 13.5px; }
.vy-sched { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.vy-sched span { font-size: 12px; border: 1px solid var(--line-2); border-radius: 8px; padding: 3px 8px; background: var(--bg-2); }
.vy-share { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.vy-share input { flex: 1; min-width: 200px; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
.vy-sig { margin-top: 10px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.vy-logs { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.vy-logs li { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--bg-2); font-size: 13.5px; display: grid; gap: 4px; }
.vy-d.up { color: var(--up); } .vy-d.down { color: var(--down); }
.vy-res:empty { display: none; }
@media (max-width: 720px) { .vy-nums { grid-template-columns: repeat(2, minmax(0, 1fr)); } .vy-line { flex-direction: column; } }`));
}

function gateChip(g) {
  if (!g) return null;
  const cls = g.verdict === "passed" ? "up" : g.verdict === "caution" ? "warn" : "down";
  return h("span", { class: `vy-chip ${cls}` }, `Gate: ${g.label}`);
}

function optionCard(o, plan) {
  const sym = plan.coin ? `$${plan.coin.symbol}` : o.expectedOutSymbol || "ETH";
  const nums = [
    [plan.kind === "bridge" ? "Arrives" : "After gas", plan.kind === "bridge" ? `${nf(o.expectedOut)} ETH` : `${nf(o.netOut)} ${sym}`],
    ["Price impact", o.priceImpactPct != null ? `${o.priceImpactPct}%` : "–"],
    ["Fees", o.feesPct != null ? `${Number(o.feesPct).toFixed(2)}%` : o.feeUsd != null ? usd(o.feeUsd) : o.lostPct != null ? `${o.lostPct}% lost` : "–"],
    ["Gas", o.gasEth != null ? `${nf(o.gasEth, 3)} ETH${o.gasUsd != null ? ` (${usd(o.gasUsd)})` : ""}` : o.gasUsd != null ? usd(o.gasUsd) : "–"],
    ["Time", eta(o.etaSec) || "–"],
  ];
  return h("li", { class: "vy-o" },
    h("div", { class: "vy-o-h" }, h("b", {}, o.title), ...(o.tags || []).map((t) => h("span", { class: `vy-chip${/sign/.test(t) ? " up" : ""}` }, t))),
    h("div", { class: "vy-nums" }, nums.map(([k, v]) => h("div", {}, h("small", {}, k), h("span", {}, v)))),
    h("ol", { class: "vy-steps" }, (o.steps || []).map((s) => h("li", {}, s.text, s.note ? h("span", { class: "fine" }, ` ${s.note}`) : null))),
    o.gateBlocks ? h("p", { class: "fine" }, "The Troya Gate blocks this coin right now, so Swap will not offer this buy. Shown for comparison only.")
      : o.href ? h("p", { class: "fine" }, h("a", { class: "link", href: o.href }, plan.kind === "bridge" ? "Open in Bridge" : "Open in Swap"), o.signable ? " · it quotes again and runs the Gate before your wallet signs." : " · shown for comparison: Troya's Swap does not sign this route.") : null);
}

function logItem(l, plan) {
  const d = l.diffPct;
  const tone = d == null ? "" : d >= 0 ? "up" : "down";
  return h("li", {},
    h("div", { class: "vy-o-h" }, h("b", {}, l.kind === "paper" ? "Paper log" : "Transaction"), h("span", { class: "fine" }, `${ago(l.at)} ago`),
      l.txHash ? h("a", { class: "link fine mono", href: `${l.chain === "base" ? "https://basescan.org" : l.chain === "arbitrum" ? "https://arbiscan.io" : l.chain === "ethereum" ? "https://etherscan.io" : "https://robinhoodchain.blockscout.com"}/tx/${l.txHash}`, target: "_blank", rel: "noopener" }, short(l.txHash)) : null,
      d != null ? h("span", { class: `vy-d ${tone}` }, `${d >= 0 ? "+" : ""}${d}% vs quote`) : l.status && l.status !== "done" ? h("span", { class: "vy-chip warn" }, l.status) : null),
    h("span", {}, l.text),
    l.gasPaidEth != null ? h("span", { class: "fine" }, `Gas paid: ${nf(l.gasPaidEth, 3)} ETH${l.mostOption ? ` · on ${l.mostOption} the plan quoted about ${nf(l.mostCoins)} for the same ETH` : ""}`) : null,
    (l.compare || []).length > 1 ? h("span", { class: "fine" }, l.compare.slice(1).map((c) => `${c.option}: ${c.now != null ? `${nf(c.now)} now vs ${nf(c.planned)}` : "no quote now"}`).join(" · ")) : null,
    ...(l.notes || []).map((n) => h("span", { class: "fine" }, n)));
}

export async function mount(view, ctx = {}) {
  css();
  let alive = true, plan = null;
  const input = h("input", { class: "input", placeholder: "One sentence: buy 0.01 ETH of $TROYA the safest way", maxlength: "280", spellcheck: "false", autocomplete: "off" });
  const go = h("button", { class: "btn primary", type: "button" }, "Lay out the plan");
  const useMe = h("input", { type: "checkbox" });
  const meRow = h("label", { class: "vy-me" }, useMe, h("span", {}, "Quote for my connected wallet (balances and the cross-chain quote use it)"));
  const exBox = h("div", { class: "vy-opt" });
  const planBox = h("div", { class: "vy-res", "aria-live": "polite" });
  const logBox = h("section", { class: "panel vy-box", hidden: true });
  const statBox = h("p", { class: "fine", style: { margin: "10px 0 0" } });

  function paintExamples(list) {
    clear(exBox, h("small", {}, "Try"), list.map((t) => h("button", { class: "btn sm", type: "button", onclick: () => { input.value = t; run(); } }, t)));
  }

  function paintPlan(p) {
    plan = p;
    const link = `${location.origin}/agent#/voyage/${p.id}`;
    const linkIn = h("input", { class: "input", readonly: true, value: link });
    const copy = h("button", { class: "btn sm", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(link); toast("Plan link copied.", "ok", 2500); } catch { linkIn.select(); } } }, "Copy link");
    clear(planBox,
      h("section", { class: "panel vy-box" },
        h("p", { class: "vy-meta" }, h("span", { class: "vy-chip" }, KIND[p.kind] || p.kind), gateChip(p.gate),
          p.coin ? h("a", { class: "link", href: `#/gate/${p.coin.address}` }, `$${p.coin.symbol} · ${short(p.coin.address)}${p.coin.official ? " · official" : ""}`) : null,
          h("span", {}, `Quoted ${new Date(p.quotedAt).toLocaleString()}`), h("span", {}, `Read by ${p.parsedBy === "model" ? "Troya's model" : "Troya's rules"}`)),
        h("p", { class: "fine", style: { margin: "0 0 8px" } }, `“${p.goal}”`),
        h("div", { class: `vy-sum ${p.gate?.verdict || ""}` }, p.summary),
        p.dca ? h("div", { style: { marginTop: "14px" } }, h("h3", {}, `Schedule: ${p.dca.count} buys of ${p.dca.perBuyEth} ETH, every ${p.dca.every}`),
          h("div", { class: "vy-sched" }, p.dca.schedule.map((s) => h("span", {}, `${s.n}. ${s.date}`))),
          h("p", { class: "fine" }, `At today's quote on ${p.dca.atTodaysQuote.option}: about ${nf(p.dca.atTodaysQuote.coins)} $${p.coin.symbol} for ${p.dca.totalEth} ETH${p.dca.atTodaysQuote.gasEth != null ? `, about ${nf(p.dca.atTodaysQuote.gasEth, 3)} ETH of gas in all` : ""}. ${p.dca.note}`)) : null,
        h("h3", { style: { marginTop: "16px" } }, p.options.length > 1 ? `${p.options.length} routes, most ${p.kind === "bridge" ? "ETH" : "coins"} after gas first` : "The route"),
        h("ul", { class: "vy-opts" }, p.options.map((o) => optionCard(o, p))),
        (p.alsoAvailable || []).length ? h("p", { class: "fine", style: { marginTop: "10px" } }, "Also on other venues, not a buy of the coin: ", ...p.alsoAvailable.flatMap((x, i) => [i ? " · " : "", h("a", { class: "link", href: x.href }, x.label)])) : null,
        p.risks?.length ? h("div", { style: { marginTop: "16px" } }, h("h3", {}, "Risks Troya reads"), h("ul", { class: "vy-risks" }, p.risks.map((r) => h("li", {}, r)))) : null,
        h("div", { class: "vy-share" }, linkIn, copy),
        p.signed ? h("div", { class: "vy-sig" }, "Signed by the Troya attestor ", h("span", { class: "mono" }, p.signed.attestor), h("br"), "hash ", h("span", { class: "mono" }, p.signed.hash), h("br"), "Verify: EIP-191 over \"Troya Voyage\" + newline + hash.") : null,
        h("p", { class: "fine", style: { marginTop: "10px" } }, p.limit)));
    paintLog(p);
  }

  function paintLog(p) {
    logBox.hidden = false;
    const tx = h("input", { class: "input", placeholder: p.kind === "bridge" ? "0x… the bridge transaction hash" : "0x… the buy transaction hash (Robinhood Chain, or the cross-chain buy on Base or Arbitrum)", spellcheck: "false", maxlength: "66" });
    const send = h("button", { class: "btn primary", type: "button" }, "Log it");
    const paper = h("button", { class: "btn", type: "button" }, "Paper log: quote it again now");
    const post = async (body, btn) => {
      btn.disabled = true;
      try { const l = await api.post(`/api/voyage/${p.id}/log`, body); if (!alive) return; p.logs = [l, ...(p.logs || []).filter((x) => !(l.txHash && x.txHash === l.txHash))]; paintLog(p); toast("Logged.", "ok", 2500); }
      catch (e) { toast(e.message || String(e), "error", 6000); }
      finally { btn.disabled = false; }
    };
    send.addEventListener("click", () => { const v = tx.value.trim(); if (!/^0x[0-9a-fA-F]{64}$/.test(v)) { toast("Paste a transaction hash: 0x and 64 hex characters.", "error", 4500); return; } post({ txHash: v }, send); });
    paper.addEventListener("click", () => post({ paper: true }, paper));
    clear(logBox, h("h3", {}, "Log: promised against what you got"),
      h("p", { class: "fine" }, p.kind === "bridge" ? "Paste the bridge transaction once it lands. Troya reads LI.FI's record of what arrived and sets it next to the plan's quote." : "Paste the transaction once it is mined. Troya reads its receipt: the coins that reached the sending wallet (Transfer logs), the ETH spent and the gas paid, next to what the plan quoted for that ETH. No transaction? A paper log quotes the same plan again now."),
      h("div", { class: "vy-line" }, tx, send), h("div", { class: "vy-opt" }, paper),
      (p.logs || []).length ? h("ul", { class: "vy-logs" }, p.logs.map((l) => logItem(l, p))) : h("p", { class: "fine", style: { marginTop: "10px" } }, "Nothing logged on this plan yet."));
  }

  async function run() {
    const text = input.value.trim();
    if (text.length < 6) { toast("Write the goal in one sentence.", "error", 3500); return; }
    go.disabled = true; logBox.hidden = true;
    clear(planBox, h("section", { class: "panel vy-box" }, h("p", { class: "fine" }, "Reading every venue, the Gate and the crossings at this moment. This can take up to a minute…")));
    try {
      const p = await api.post("/api/voyage/plan", { text, from: useMe.checked && wallet.address ? wallet.address : undefined });
      if (!alive) return;
      history.replaceState(null, "", `#/voyage/${p.id}`);
      paintPlan(p);
    } catch (e) {
      if (alive) clear(planBox, h("section", { class: "panel vy-box" }, h("div", { class: "alert error" }, e.message || String(e))));
    } finally { go.disabled = false; }
  }
  go.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  clear(view, h("div", { class: "dk vy-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Voyage · V10 Poseidon"),
      h("h1", {}, "Plan the ", h("em", {}, "voyage"), " first."),
      h("p", { class: "dk-sub" }, "Write the goal in one sentence: a buy, a weekly DCA, or moving ETH from Base, Arbitrum or Ethereum and buying on Robinhood Chain. Voyage lays out every route Troya reads right now, the Gate's word on the coin, the costs and the risks, signed by Troya. Afterwards, log the transaction to see what was promised against what you got.")),
    h("section", { class: "panel vy-box" }, h("div", { class: "vy-line" }, input, go), wallet.address ? meRow : null, exBox, statBox),
    planBox, logBox,
    h("section", { class: "panel vy-box" }, h("h3", {}, "What Voyage does and does not do"),
      h("ul", { class: "vy-risks" },
        h("li", {}, "Venues come from Troya Atlas (the Pons curve, Uniswap v3 and v4, KyberSwap, Lighter, and one-transaction buys from Base and Arbitrum through LI.FI), ranked by coins after gas."),
        h("li", {}, "The coin goes through the Troya Gate first. Crossings are quoted by LI.FI; Troya does not score bridge safety yet."),
        h("li", {}, "It describes the options and never tells anyone what to buy. It never signs, sends or buys anything, and a DCA plan is a schedule, not automation."),
        h("li", {}, "Buys of Robinhood Chain coins and ETH crossings only in this version; it does not plan sells."))),
  ));
  paintExamples(FALLBACK_EXAMPLES);
  api.get("/api/voyage").then((d) => { if (!alive) return; if (d.examples?.length) paintExamples(d.examples); statBox.textContent = `${d.plans || 0} plans laid out, ${d.logs || 0} logged so far.`; }).catch(() => {});

  const id = ctx.parts?.[0];
  if (id) {
    clear(planBox, h("section", { class: "panel vy-box" }, h("p", { class: "fine" }, "Loading the plan…")));
    api.get(`/api/voyage/${encodeURIComponent(id)}`).then((p) => { if (alive) { input.value = p.goal; paintPlan(p); } })
      .catch((e) => { if (alive) clear(planBox, h("section", { class: "panel vy-box" }, h("div", { class: "alert error" }, e.message || String(e)))); });
  }
  return () => { alive = false; };
}
