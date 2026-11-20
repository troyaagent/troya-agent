// V8 F44 Scepter (#/agent/scepter): one command screen for every agent working for you. One budget, a cap for each job,
// approvals waiting for you, a receipt for every action and one switch that stops everything. The trust ladder (watch,
// approve, auto) is enforced on the server for every automated job (server/agentwallet.mjs executeForUser); a trade you
// tap yourself is never held back by it. A wallet that never picked a step is on Approve (server/policy.mjs DEFAULT_TRUST).
import { h, clear, icon, toast, short, ago, usd } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, signIn } from "../wallet.js";

// the "autopilot" job is Sentry Autopilot (server/autopilot.mjs, source "autopilot"): its status and its practice/live
// switch live on #/agent/sentry, so the row links there
const JOBS = [
  { key: "autopilot", name: "Sentry Autopilot", href: "#/agent/sentry", what: "Buys launches that pass the Gate, sells by your rules" },
  { key: "playbook", name: "Playbooks", href: "#/agent/playbooks", what: "Acts when a price or event fires" },
  { key: "aegis", name: "Aegis", href: "#/agent/aegis", what: "Exits a coin on a red alert (exit mode)" },
  { key: "champions", name: "Champions", href: "#/agent/arena", what: "Follows a proven trader or strategy" },
];
const LADDER = [
  { key: "watch", name: "Watch", what: "Automated jobs only alert you. Nothing trades on its own." },
  { key: "approve", name: "Approve", what: "Every automated trade waits in a list for your yes." },
  { key: "auto", name: "Auto", what: "Jobs act on their own, inside every cap below and the Gate." },
];
const SCAN = "https://robinhoodchain.blockscout.com";
const DEFAULT_TRUST = "approve";   // what the server answers for a wallet that never picked a step

const intro = () => h("div", { class: "ag-intro" }, h("h2", {}, "Scepter"),
  h("p", {}, "One command for every agent working for you: one budget, a cap for each job, one switch that stops them all, and a receipt for every move."));

// the same sign-in block as the other Agent tabs: one tap connects the wallet when none is connected, then signs in.
// Connecting alone gives no session, so a button that only opened the connect sheet left the page on "Sign in" for good.
function signInBox(text) {
  return h("div", { class: "ag-signin" },
    h("div", {}, h("b", {}, wallet.address ? "Sign in to continue" : "Connect a wallet to continue"), h("p", {}, text)),
    h("button", { class: "btn primary", type: "button", onclick: async () => {
      try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); }
    } }, icon("key"), wallet.address ? "Sign in" : "Connect wallet"));
}

// what each job is really doing now, read from its own module (not a guess): { on, label }
function jobStatus(x) {
  const ap = x.ap?.settings;
  // live only when the user chose it and the server allows it; otherwise Sentry runs on play money (autopilot.mjs onLaunch)
  const apMode = ap?.mode === "live" && ap?.liveAvailable !== false ? "live" : "practice";
  const followed = Object.values(x.ch?.follows || {}).some((f) => f?.on);
  // a paused or finished playbook does not act: only "active" ones count (server/watches.mjs)
  const playing = (x.wa?.items || []).some((w) => w.status === "active");
  const aegis = !!x.ag?.on;
  return {
    autopilot: ap?.on ? { on: true, label: `On · ${apMode}` } : { on: false, label: "Off" },
    playbook: playing ? { on: true, label: "On" } : { on: false, label: "Off" },
    aegis: aegis && x.ag?.mode === "exit" ? { on: true, label: "On · exit" } : aegis ? { on: false, label: "Alerts only" } : { on: false, label: "Off" },
    champions: followed ? { on: true, label: "On" } : { on: false, label: "Off" },
  };
}

export function mountScepter(box) {
  const wrap = h("div", { class: "sc" });
  clear(box, wrap);
  let stop = false, seq = 0, seen;
  const load = async () => {
    const my = ++seq;   // a slower, older load never paints over a newer one (a wallet change starts a new one)
    if (!wallet.session) { clear(wrap, intro(), signInBox("Scepter belongs to the wallet you sign in with: sign in to see your budget, your jobs and the switch that stops them all.")); return; }
    const [pol, aw, props, act, ap, ag, wa, ch] = await Promise.all([
      api.get("policy").catch(() => null), api.get("agent-wallet").catch(() => null), api.get("inbox/proposals").catch(() => ({ items: [] })),
      api.get("agent-wallet/activity").catch(() => ({ items: [] })), api.get("autopilot").catch(() => null), api.get("aegis/me").catch(() => null), api.get("watches").catch(() => null),
      api.get("champions/me").catch(() => null)]);
    const bal = aw?.address ? await api.get("agent-wallet/balances").catch(() => null) : null;
    if (!stop && my === seq && wallet.session) render({ pol, aw, bal, props: (props?.items || []).filter((p) => p.status === "pending" && p.expiresAt > Date.now()), act: act?.items || [], ap, ag, wa, ch });
  };
  function render(x) {
    const e = x.pol?.effective || {};
    const trust = e.trust || DEFAULT_TRUST;
    const paused = !!e.paused, kill = !!e.killSwitch;
    const used = x.pol?.usedTodayBySource || {};
    const st = jobStatus(x);
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
      h("div", { class: "sc-steps" }, LADDER.map((l, i) => h("button", { class: `sc-step${trust === l.key ? " on" : ""}`, type: "button", onclick: async () => {
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
            h("td", { class: "l" }, h("span", { class: `sc-st${st[j.key].on ? " on" : ""}` }, st[j.key].label)),
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
        h("p", { class: "fine muted sc-pad" }, trust === "approve" ? "Nothing waiting. On Approve, every automated trade shows up here first." : "Nothing waiting."));
    // receipts
    const txOf = (it) => it.data?.result?.hash || it.data?.result?.txHash || it.data?.result?.steps?.find?.((s) => s.hash)?.hash || null;
    const rec = h("section", { class: "panel sc-rec" }, h("div", { class: "panel-h" }, h("h2", {}, "Receipts"), h("a", { class: "link fine", href: "#/portfolio/history" }, "All history")),
      x.act.length ? h("ul", { class: "sc-list" }, x.act.slice(0, 15).map((it) => h("li", {},
        h("div", {}, h("b", {}, it.summary || it.kind), h("div", { class: "fine muted" }, `${it.source || "agent"} · ${ago(it.t)} ago${it.rationale ? ` · ${String(it.rationale).slice(0, 140)}` : ""}`)),
        h("div", { class: "sc-acts" }, h("span", { class: `sc-st s-${it.status}` }, it.status), txOf(it) ? h("a", { class: "link fine", href: `${SCAN}/tx/${txOf(it)}`, target: "_blank", rel: "noopener" }, "tx ↗") : null)))) :
        h("p", { class: "fine muted sc-pad" }, "No actions yet. Every trade your agents make, or are stopped from making, lands here with its reason."));
    clear(wrap, intro(), sw, ladder, h("div", { class: "sc-grid" }, jobs, wait), rec);
  }
  // onWallet calls back at once with the current wallet: that first call is the load. After that it reloads only when the
  // wallet or the session changes (connect, sign in, switch account, sign out), not on a chain switch.
  const who = () => (wallet.session ? `s:${String(wallet.session.address || wallet.address || "").toLowerCase()}` : `g:${wallet.address || ""}`);
  const off = onWallet(() => { const k = who(); if (k !== seen) { seen = k; load(); } });
  const t = setInterval(() => { if (!document.hidden && wallet.session) load(); }, 20_000);
  return () => { stop = true; clearInterval(t); off(); };
}
