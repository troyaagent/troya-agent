// Phase 9 · Sentry Autopilot leaderboard (#/leaderboard): opted-in traders ranked by return on closed positions, live
// results ahead of practice, and a button that copies a trader's rules into your own Autopilot.
import { h, clear, pageHead, toast, useCss, seg } from "../ui.js";
import { api } from "../api.js";
import { wallet, openConnect, signIn } from "../wallet.js";

export async function mount(view) {
  useCss("start");
  let days = 7, alive = true;
  const box = h("div", { class: "lb-box" });
  const pick = seg([{ value: 1, label: "24h" }, { value: 7, label: "7 days" }, { value: 30, label: "30 days" }], days, (v) => { days = v; load(); });
  clear(view, pageHead("Leaderboard", "Sentry Autopilot results of traders who chose to show them, ranked by return on closed positions. Live results rank ahead of practice."), h("div", { class: "lb-top" }, pick, h("a", { class: "link", href: "#/agent/sentry" }, "Your Sentry Autopilot")), box);

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
  load();
  return () => { alive = false; };
}
