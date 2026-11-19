// V8 F44 Scepter (#/agent/scepter): one command screen for every agent working for you. One budget, a cap for each job,
// approvals waiting for you, a receipt for every action and one switch that stops everything. The trust ladder (watch,
// approve, auto) is enforced on the server for every automated job (server/agentwallet.mjs executeForUser); a trade you
// tap yourself is never held back by it.
import { h, clear, icon, toast, short, ago, usd } from "../ui.js";
import { api } from "../api.js";
import { wallet, openConnect } from "../wallet.js";

const JOBS = [
  { key: "autopilot", name: "Autopilot", href: "#/agent/autopilot", what: "Buys and sells by your rules" },
  { key: "playbook", name: "Playbooks", href: "#/agent/playbooks", what: "Acts when a price or event fires" },
  { key: "aegis", name: "Aegis", href: "#/agent/aegis", what: "Exits a coin on a red alert (exit mode)" },
  { key: "champions", name: "Champions", href: "#/agent/arena", what: "Follows a proven strategy (coming in V8)" },
];
const LADDER = [
  { key: "watch", name: "Watch", what: "Automated jobs only alert you. Nothing trades on its own." },
  { key: "approve", name: "Approve", what: "Every automated trade waits in a list for your yes." },
  { key: "auto", name: "Auto", what: "Jobs act on their own, inside every cap below and the Gate." },
];
const SCAN = "https://robinhoodchain.blockscout.com";

export function mountScepter(box) {
  const wrap = h("div", { class: "sc" });
  clear(box, wrap);
  if (!wallet.session) {
    clear(wrap, h("section", { class: "panel sc-empty" }, h("h2", {}, "Scepter"), h("p", { class: "muted" }, "One command screen for every agent working for you. Sign in to see your budget, your jobs and the switch that stops them all."),
      h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet")));
    return () => {};
  }
  let stop = false;
  const load = async () => {
    const [pol, aw, props, act, ap, ag, wa] = await Promise.all([
      api.get("policy").catch(() => null), api.get("agent-wallet").catch(() => null), api.get("inbox/proposals").catch(() => ({ items: [] })),
      api.get("agent-wallet/activity").catch(() => ({ items: [] })), api.get("autopilot").catch(() => null), api.get("aegis/me").catch(() => null), api.get("watches").catch(() => null)]);
    const bal = aw?.address ? await api.get("agent-wallet/balances").catch(() => null) : null;
    if (!stop) render({ pol, aw, bal, props: (props?.items || []).filter((p) => p.status === "pending" && p.expiresAt > Date.now()), act: act?.items || [], ap, ag, wa });
  };
  function render(x) {
    const e = x.pol?.effective || {};
    const paused = !!e.paused, kill = !!e.killSwitch;
    const used = x.pol?.usedTodayBySource || {};
    const jobOn = { autopilot: !!x.ap?.settings?.on, playbook: (x.wa?.items || x.wa?.watches || []).some?.((w) => w.active !== false && w.status !== "done") || false, aegis: !!x.ag?.on && x.ag?.mode === "exit", champions: false };
    // the switch
    const sw = h("section", { class: `panel sc-cmd${paused || kill ? " stopped" : ""}` },
      h("div", { class: "sc-cmd-l" }, h("span", { class: `sc-dot${paused || kill ? "" : " on"}` }), h("div", {},
        h("b", {}, kill ? "Stopped by the operator" : paused ? "Every agent is stopped" : "Your agents are running"),
        h("p", { class: "fine muted" }, kill ? "The operator kill switch is on: nothing can trade." : paused ? "Nothing trades from your Agent Wallet until you resume, whatever any job wants." : `Inside $${e.perTradeUsd ?? "?"} a trade and $${e.dailyUsd ?? "?"} a day, the Gate first. $${(x.pol?.usedTodayUsd || 0).toFixed(2)} used today.`))),
      h("button", { class: `btn ${paused ? "primary" : "danger"} sc-kill`, type: "button", disabled: kill, onclick: async () => {
        try { await api.post("policy", { paused: !paused }); toast(paused ? "Your agents are running again." : "Every agent is stopped.", paused ? "ok" : "warn"); load(); } catch (err) { toast(err.message, "error"); }
      } }, icon(paused ? "play" : "pause"), paused ? "Resume" : "Stop every agent"));
    // the ladder
    const ladder = h("section", { class: "panel sc-ladder" }, h("div", { class: "panel-h" }, h("h2", {}, "Trust ladder"), h("span", { class: "fine muted" }, "Climb at your pace")),
      h("div", { class: "sc-steps" }, LADDER.map((l, i) => h("button", { class: `sc-step${(e.trust || "auto") === l.key ? " on" : ""}`, type: "button", onclick: async () => {
        try { await api.post("policy", { trust: l.key }); toast(`Trust ladder: ${l.name}.`, "ok"); load(); } catch (err) { toast(err.message, "error"); }
      } }, h("small", {}, `Step ${i + 1}`), h("b", {}, l.name), h("span", {}, l.what)))));
    // budget and jobs
    const capIn = {};
    const jobs = h("section", { class: "panel sc-jobs" }, h("div", { class: "panel-h" }, h("h2", {}, "Jobs and their caps"), h("span", { class: "fine muted" }, "USD a day, inside your wallet caps")),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Job"), h("th", { class: "l" }, "Status"), h("th", {}, "Used today"), h("th", {}, "Daily cap"))),
        h("tbody", {}, JOBS.map((j) => {
          capIn[j.key] = h("input", { class: "sc-in", type: "text", inputmode: "decimal", placeholder: "no cap", value: e.jobCaps?.[j.key] ?? "" });
          return h("tr", {}, h("td", { class: "l" }, h("a", { class: "link", href: j.href }, j.name), h("div", { class: "fine muted" }, j.what)),
            h("td", { class: "l" }, h("span", { class: `sc-st${jobOn[j.key] ? " on" : ""}` }, jobOn[j.key] ? "On" : "Off")),
            h("td", {}, usd(used[j.key] || 0)), h("td", {}, capIn[j.key]));
        })))),
      h("div", { class: "sc-row" }, h("p", { class: "fine muted" }, x.aw?.address ? `Agent Wallet ${short(x.aw.address, 4)}: ${x.bal?.robinhoodEth != null ? `${x.bal.robinhoodEth.toFixed(4)} ETH` : "balance unknown"}.` : "No Agent Wallet yet: jobs cannot trade until you create one in Agent → Wallet."),
        h("button", { class: "btn sm", type: "button", onclick: async () => {
          const jc = {}; for (const j of JOBS) { const v = capIn[j.key].value.trim(); if (v !== "") jc[j.key] = Number(v); }
          try { await api.post("policy", { jobCaps: jc }); toast("Job caps saved.", "ok"); load(); } catch (err) { toast(err.message, "error"); }
        } }, "Save caps")));
    // waiting for you
    const wait = h("section", { class: "panel sc-wait" }, h("div", { class: "panel-h" }, h("h2", {}, "Waiting for you"), h("span", { class: "fine muted" }, `${x.props.length} pending`)),
      x.props.length ? h("ul", { class: "sc-list" }, x.props.slice(0, 20).map((p) => h("li", {},
        h("div", {}, h("b", {}, p.summary || p.kind), h("div", { class: "fine muted" }, `${p.source || "agent"} · ${ago(p.createdAt)} ago${p.rationale ? ` · ${p.rationale}` : ""}`)),
        h("div", { class: "sc-acts" },
          h("button", { class: "btn sm primary", type: "button", onclick: async () => { try { const r = await api.post("agent-wallet/execute", { proposalId: p.id }); toast(r.executed ? r.summary || "Done." : `Not sent: ${(r.reasons || []).join(" ")}`, r.executed ? "ok" : "warn"); load(); } catch (err) { toast(err.message, "error"); } } }, "Approve"),
          h("button", { class: "btn sm", type: "button", onclick: async () => { try { await api.post("inbox/proposal-done", { id: p.id, status: "rejected" }); load(); } catch (err) { toast(err.message, "error"); } } }, "Dismiss"))))) :
        h("p", { class: "fine muted sc-pad" }, (e.trust || "auto") === "approve" ? "Nothing waiting. On Approve, every automated trade shows up here first." : "Nothing waiting."));
    // receipts
    const txOf = (it) => it.data?.result?.hash || it.data?.result?.txHash || it.data?.result?.steps?.find?.((s) => s.hash)?.hash || null;
    const rec = h("section", { class: "panel sc-rec" }, h("div", { class: "panel-h" }, h("h2", {}, "Receipts"), h("a", { class: "link fine", href: "#/history" }, "All history")),
      x.act.length ? h("ul", { class: "sc-list" }, x.act.slice(0, 15).map((it) => h("li", {},
        h("div", {}, h("b", {}, it.summary || it.kind), h("div", { class: "fine muted" }, `${it.source || "agent"} · ${ago(it.t)} ago${it.rationale ? ` · ${String(it.rationale).slice(0, 140)}` : ""}`)),
        h("div", { class: "sc-acts" }, h("span", { class: `sc-st s-${it.status}` }, it.status), txOf(it) ? h("a", { class: "link fine", href: `${SCAN}/tx/${txOf(it)}`, target: "_blank", rel: "noopener" }, "tx ↗") : null)))) :
        h("p", { class: "fine muted sc-pad" }, "No actions yet. Every trade your agents make, or are stopped from making, lands here with its reason."));
    clear(wrap, h("div", { class: "sc-hero" }, h("h1", { class: "sc-title" }, "Scepter"), h("p", { class: "muted" }, "One command for every agent working for you: one budget, a cap for each job, one switch that stops them all, and a receipt for every move.")),
      sw, ladder, h("div", { class: "sc-grid" }, jobs, wait), rec);
  }
  load();
  const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
  return () => { stop = true; clearInterval(t); };
}
