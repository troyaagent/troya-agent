// #/leaderboard. On top (22 Nov 2026, community request "a leaderboard needs prizes that grow with activity"): the weekly
// prize pool, 0.1% of $TROYA volume shared by the 10 most active traders through Troya (server/prizes.mjs): the pool, live
// standings with each rank's estimated prize, last week's winners with their transactions, and the rules in plain words.
// Below (Phase 9): the Sentry Autopilot leaderboard, opted-in traders ranked by return on closed positions, live results
// ahead of practice, and a button that copies a trader's rules into your own Autopilot.
import { h, clear, pageHead, toast, useCss, seg, usd, icon } from "../ui.js";
import { api } from "../api.js";
import { wallet, openConnect, signIn } from "../wallet.js";

const ethTxt = (v) => (v == null || !isFinite(v) ? "–" : `${(+v).toFixed(v >= 1 ? 4 : 6).replace(/\.?0+$/, "") || "0"} ETH`);
const day = (ms) => new Date(ms).toUTCString().slice(0, 11);
const dollars = (v) => (v == null || !isFinite(v) ? "–" : "$" + Math.round(v).toLocaleString("en-US"));   // volume in whole dollars
function left(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000)), d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m % 60}m` : `${m % 60}m`;
}
const who = (r) => (r.name ? h("a", { class: "link", href: `#/u/${encodeURIComponent(r.name)}` }, `@${r.name}`) : h("span", { class: "mono" }, r.trader));
const MODE = { live: ["Live", "on"], dry: ["Test mode", "test"], off: ["Paused", "off"] };
const STATUS = { paid: "Paid", partial: "Partly paid", paying: "Paying", waiting: "Waiting", dry: "Dry run, not sent", pending: "Not paid yet" };

export async function mount(view) {
  useCss("start");
  let days = 7, alive = true, timer = null;
  const prizeBox = h("section", { class: "panel pz" }, h("div", { class: "sk", style: { height: "220px" } }));
  const lastBox = h("section", { class: "panel pz pz-last", hidden: true });
  const rulesBox = h("section", { class: "panel pz pz-rules", hidden: true });
  const box = h("div", { class: "lb-box" });
  const pick = seg([{ value: 1, label: "24h" }, { value: 7, label: "7 days" }, { value: 30, label: "30 days" }], days, (v) => { days = v; load(); });
  clear(view,
    pageHead("Leaderboard", "A weekly prize pool for the most active traders on Troya, paid in ETH, and the Sentry Autopilot results traders chose to show."),
    prizeBox, rulesBox, h("div", { class: "pz-grid pz-grid-1" }, lastBox),
    h("div", { class: "lb-sec" }, h("h2", {}, "Sentry Autopilot results"), h("p", {}, "Ranked by return on closed positions. Live results rank ahead of practice.")),
    h("div", { class: "lb-top" }, pick, h("a", { class: "link", href: "#/agent/sentry" }, "Your Sentry Autopilot")), box);

  /* ---------- the weekly prize pool ---------- */
  function paintPrizes(d) {
    const [modeLabel, modeCls] = MODE[d.mode] || MODE.dry;
    const w = d.week, p = d.pool;
    const when = w.warmup ? `Warm-up week, not paid · the first prize week starts ${day(w.firstWeekStart)} 00:00 UTC` : `Week ${w.key} · ends in ${left(w.end - Date.now())} (Monday 00:00 UTC)`;
    const head = h("div", { class: "pz-head" },
      h("div", { class: "pz-title" },
        h("span", { class: "pz-kick" }, when),
        h("h2", {}, w.warmup ? "Warm-up pool: " : "This week's prize pool: ", h("b", {}, ethTxt(p.eth)), " ", h("span", { class: "pz-of" }, `(${p.pctOfVolume}% of $TROYA volume)`)),
        h("p", { class: "pz-sub" }, [p.usd != null ? `≈ ${usd(p.usd)}` : null, `from ${ethTxt(p.creditedEth)} of $TROYA creator fees`, p.readUpTo ? `read up to ${new Date(p.readUpTo).toUTCString().slice(17, 22)} UTC` : null].filter(Boolean).join(" · "))),
      h("span", { class: `pz-mode ${modeCls}` }, modeLabel));
    const note = d.mode !== "live" || w.warmup ? h("p", { class: "pz-note" }, w.warmup ? `This week only warms up the board. The first prize week runs ${day(w.firstWeekStart)} to ${day(w.firstWeekStart + 7 * 86_400_000)}, first payout Monday ${day(w.firstPayoutAt).slice(5)}.` : d.status) : null;
    const me = d.me ? h("div", { class: "pz-me" }, h("span", {}, "You"), h("b", {}, `#${d.me.rank}`), h("span", {}, `${dollars(d.me.usd)} counted over ${d.me.trades} trade${d.me.trades === 1 ? "" : "s"}`)) : null;
    const rows = d.rows.length
      ? h("div", { class: "pz-table", role: "table" },
          h("div", { class: "pz-row pz-h", role: "row" }, ["#", "Trader", "Volume", "Trades", "Est. prize"].map((x) => h("span", { role: "columnheader" }, x))),
          d.rows.map((r) => h("div", { class: `pz-row ${r.mine ? "mine" : ""} ${r.prizePct ? "paid" : ""}`, role: "row" },
            h("span", { class: "pz-rank" }, String(r.rank)),
            h("span", { class: "pz-who" }, who(r), r.mine ? h("span", { class: "badge-s blue" }, "you") : null, r.capped ? h("span", { class: "badge-s", title: r.linked ? `Linked wallets (by their funding) are counted together at up to ${d.capPct}% of the week's total volume` : `Counted at ${d.capPct}% of the week's total volume, the most one wallet can count for` }, "capped") : null,
              r.linked && !r.capped ? h("span", { class: "badge-s", title: `Linked to another ranked wallet by its funding: they count together toward the ${d.capPct}% cap` }, "linked") : null),
            h("span", { class: "pz-usd" }, dollars(r.usd)),
            h("span", { class: "pz-n" }, String(r.trades)),
            h("span", { class: "pz-prize" }, r.prizePct ? [h("b", {}, r.tooSmall ? "under the minimum" : ethTxt(r.prizeEth)), h("small", {}, `${r.prizePct}%${r.prizeUsd != null && !r.tooSmall ? ` · ≈ ${usd(r.prizeUsd)}` : ""}`)] : h("small", {}, "–")))))
      : h("div", { class: "pz-empty" }, h("b", {}, "No trades counted yet this week."), h("p", {}, `Trade $${d.minTradeUsd} or more through Troya (Swap, your Agent Wallet, Telegram, X or Perps) to enter. The pool grows with every $TROYA trade.`),
          h("div", { class: "pz-acts" }, h("a", { class: "btn primary sm", href: "#/swap" }, "Open Swap"), h("a", { class: "btn sm", href: "#/agent" }, "Agent Wallet")));
    const foot = d.rows.length ? h("p", { class: "pz-foot" }, `${d.totals.traders} trader${d.totals.traders === 1 ? "" : "s"} · ${dollars(d.totals.usd)} counted this week. Estimated prizes follow the pool as it grows; the final split is worked out Monday 00:00 UTC.`) : null;
    clear(prizeBox, head, note, me, rows, foot);
  }
  function paintLast(d) {
    const l = d.lastWeek;
    lastBox.hidden = false;
    if (!l) { clear(lastBox, h("h3", {}, "Last week's winners"), h("p", { class: "pz-sub" }, `The first winners are paid on Monday ${day(d.week.firstPayoutAt).slice(5)}, after the first prize week closes.`)); return; }
    clear(lastBox,
      h("div", { class: "pz-lh" }, h("h3", {}, "Last week's winners ", h("span", { class: "mono pz-wk" }, l.key)), h("span", { class: `pz-st ${l.status}` }, STATUS[l.status] || l.status)),
      h("p", { class: "pz-sub" }, `Pool ${ethTxt(l.poolEth)} · ${l.traders ?? 0} trader${l.traders === 1 ? "" : "s"}${l.ownerKeepsEth > 0 ? ` · ${ethTxt(l.ownerKeepsEth)} stayed with the team` : ""}`),
      l.items.length ? h("ol", { class: "pz-win" }, l.items.map((x) => h("li", {},
        h("span", { class: "pz-rank" }, String(x.rank)), h("span", { class: "pz-who" }, who(x)),
        h("span", { class: "pz-prize" }, h("b", {}, ethTxt(x.eth)), h("small", {}, `${x.pct}%`)),
        h("span", { class: "pz-tx" }, x.txUrl ? h("a", { class: "link", href: x.txUrl, target: "_blank", rel: "noopener" }, "Transaction") : h("small", {}, x.status === "too-small" ? "under the minimum, kept" : x.status === "failed" ? "failed" : STATUS[l.status] || "–")))))
        : h("p", { class: "pz-sub" }, l.note || "Nobody traded through Troya that week."),
      l.note && l.items.length ? h("p", { class: "pz-foot" }, l.note) : null);
  }
  // the rules, read from the API (server/prizes.mjs RULE_CARDS): one card per rule, line icons; a rule that changes from the
  // week of 30 Nov 2026 shows both versions with the one in force this week marked. The staking 2x line links to #/stake.
  function paintRules(d) {
    rulesBox.hidden = false;
    const cards = Array.isArray(d.ruleCards) ? d.ruleCards : null;
    if (!cards) { clear(rulesBox, h("h3", {}, "How it works"), h("ul", { class: "pz-rl" }, (d.rules || []).map((x) => h("li", {}, x)))); return; }
    const v2now = d.weekRules?.version >= 2, from = d.rulesV2From;
    const change = (c) => (c.from && c.before && c.after ? h("div", { class: "pz-chg" },
      h("span", { class: `pz-chg-i ${v2now ? "" : "now"}` }, h("small", {}, `Until ${day(c.from - 86_400_000).slice(5)}`), h("b", {}, c.before), v2now ? null : h("em", {}, "this week")),
      h("span", { class: `pz-chg-i ${v2now ? "now" : ""}` }, h("small", {}, `From ${day(c.from).slice(5)}`), h("b", {}, c.after), v2now ? h("em", {}, "this week") : null)) : null);
    const split = (c) => (Array.isArray(c.split) ? h("ol", { class: "pz-split", "aria-label": "Prize split by rank" }, c.split.map((p, i) => h("li", {}, h("small", {}, `#${i + 1}`), h("b", {}, `${p}%`)))) : null);
    const s2 = d.staking2x;
    clear(rulesBox,
      h("div", { class: "pz-rh" }, h("h3", {}, "Prize pool rules"),
        from && !v2now ? h("span", { class: "pz-rv" }, `Round trips and the cap tighten from the week of ${day(from).slice(5)}`) : null),
      h("div", { class: "pz-rc" }, cards.map((c) => h("div", { class: "pz-card" },
        h("span", { class: "pz-ic" }, icon(c.icon || "info")),
        h("div", { class: "pz-ct" }, h("b", {}, c.title), h("p", {}, c.text), split(c), change(c))))),
      s2 ? h("div", { class: "pz-stk" }, h("span", { class: "pz-ic" }, icon("bolt")),
        h("p", {}, s2.text, " ", h("a", { class: "link", href: s2.href || "#/stake" }, "Open the stake page"))) : null);
  }
  async function loadPrizes() {
    let d;
    try { d = await api.get("leaderboard/prizes"); }
    catch (e) {
      // a server without the prize module (404) shows only the Autopilot board
      if (alive) { if (e.status === 404) prizeBox.hidden = true; else clear(prizeBox, h("div", { class: "alert error" }, `The prize pool could not be read: ${e.message}`)); }
      return;
    }
    prizeBox.hidden = false;
    if (!alive) return;
    paintPrizes(d); paintLast(d); paintRules(d);
  }

  /* ---------- Sentry Autopilot ---------- */
  async function copy(r) {
    try {
      if (!wallet.session) { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); }
      if (!wallet.session) return;
      const res = await api.post("leaderboard/copy", { trader: r.trader });
      toast(`Copied ${res.from}'s rules into your Autopilot`, "ok");
    } catch (e) { toast(e.message, "error"); }
  }
  async function load() {
    clear(box, h("p", { class: "faint" }, "Loading…"));
    let d;
    try { d = await api.get(`leaderboard?days=${days}`); } catch (e) { if (alive) clear(box, h("div", { class: "alert error" }, e.message)); return; }
    if (!alive) return;
    if (!d.rows.length) { clear(box, h("div", { class: "panel lb-empty" }, h("b", {}, "No one on the board for this window yet."), h("p", {}, "Turn on Sentry Autopilot and tick \"Show my results on the leaderboard\" to appear here."), h("a", { class: "btn primary sm", href: "#/agent/sentry" }, "Open Sentry Autopilot"))); return; }
    clear(box, h("div", { class: "panel lb-table" },
      h("div", { class: "lb-row lb-h" }, ["#", "Trader", "Mode", "Return", "PnL", "Closed", "Won", "Rules", ""].map((x) => h("span", {}, x))),
      d.rows.map((r) => h("div", { class: "lb-row" },
        h("span", {}, String(r.rank)), h("span", { class: "mono" }, r.trader), h("span", { class: `badge-s ${r.mode === "live" ? "blue" : ""}` }, r.mode),
        h("span", { class: r.returnPct >= 0 ? "up" : "down" }, `${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}%`),
        h("span", {}, `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(4)} ETH`), h("span", {}, String(r.closed)), h("span", {}, `${(r.winRate * 100).toFixed(0)}%`),
        h("span", { class: "faint" }, r.rules ? `min ${r.rules.minRaisedEth} ETH · ${r.rules.buyEth} ETH · tp ${r.rules.takeProfitX}x · sl ${r.rules.stopPct}%` : "–"),
        h("button", { class: "btn sm", type: "button", onclick: () => copy(r) }, "Copy rules")))),
      h("p", { class: "note" }, "Practice results are play money at real prices. Copying sets the same rules in your Autopilot; it stays in the mode you chose."));
  }
  loadPrizes();
  load();
  timer = setInterval(() => { if (!document.hidden) loadPrizes(); }, 60_000);
  return () => { alive = false; clearInterval(timer); };
}
