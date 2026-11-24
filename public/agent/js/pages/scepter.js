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
  { key: "auto", name: "Auto", what: "Jobs act on their own, inside your Budget and the Gate." },
];
const SCAN = "https://robinhoodchain.blockscout.com";
const DEFAULT_TRUST = "approve";   // what the server answers for a wallet that never picked a step
// which cap sets each Budget number (server/policy.mjs getBudget "from")
const FROM = { "agent-wallet": "Set by your Agent Wallet cap", "your-limit": "Set by your own limit", operator: "Set by the operator cap" };
// why no job can trade even though nobody pressed Stop (getBudget "stoppedBy")
const BLOCKED = {
  "operator-agent-wallets": "The operator has switched Agent Wallets off, so no job can trade.",
  "no-agent-wallet": "No Agent Wallet yet: jobs cannot trade until you create one in Agent → Wallet.",
  "agent-wallet-off": "Your Agent Wallet is switched off, so no job can trade from it.",
};

const intro = () => h("div", { class: "ag-intro" }, h("h2", {}, "Scepter"),
  h("p", {}, "One command for every agent working for you: one budget, a cap for each job, one switch that stops them all, and a receipt for every move."));

// the same sign-in step as the other Agent tabs: one tap connects the wallet when none is connected, then signs in.
// Connecting alone gives no session, so a button that only opened the connect sheet left the page on "Sign in" for good.
async function connectAndSignIn() {
  try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); }
}

// A guest sees the page as it will look, not one sentence and a button: three plain "what you get" lines, the real layout
// filled with content marked Example (templates, sample rows and dashes, never an invented balance, PnL or cap, since the
// owner's rule is no fake data on the live site) and a Sign in bar pinned to the bottom of the screen. The preview is inert,
// so nothing in it can be pressed or focused. Shared by Scepter, Agent Wallet, Autopilot and Sentry Autopilot (agent.js).
export function guestPreview({ title, intro: introText, sentence, bullets, example }) {
  return [
    h("div", { class: "ag-intro" }, h("h2", {}, title), h("p", {}, introText)),
    h("div", { class: "panel ag-panel" }, h("h3", {}, "What you get"), h("ul", { class: "ag-points" }, bullets.map((b) => h("li", {}, b)))),
    h("section", { class: "ag-ex", "aria-label": `${title}: example preview` },
      h("div", { class: "ag-ex-h" }, h("span", { class: "ag-ex-tag" }, "Example"), h("span", { class: "fine muted" }, "How this page looks once you sign in. Nothing here is real data.")),
      h("div", { class: "ag-ex-body", inert: true }, example)),
    h("div", { class: "ag-signin ag-pin" },
      h("div", {}, h("b", {}, wallet.address ? "Sign in to continue" : "Connect a wallet to continue"), h("p", {}, sentence)),
      h("button", { class: "btn primary", type: "button", onclick: connectAndSignIn }, icon("key"), wallet.address ? "Sign in" : "Connect wallet")),
  ];
}
// an Example row: a label, a line under it and a status chip, with no amount and no time
export const exampleRow = (title, line, status, label = status) => h("li", {}, h("div", {}, h("b", {}, title), h("div", { class: "fine muted" }, line)),
  h("div", { class: "sc-acts" }, h("span", { class: `sc-st s-${status}` }, label)));
const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null);

function guestScepter() {
  const sw = h("section", { class: "panel sc-cmd" },
    h("div", { class: "sc-cmd-l" }, h("span", { class: "sc-dot on" }), h("div", {},
      h("b", {}, "Your agents are running"),
      h("p", { class: "fine muted" }, "Every job spends inside your Budget, the Gate first."))),
    h("button", { class: "btn danger sc-kill", type: "button", tabindex: "-1" }, icon("pause"), "Stop every agent"));
  const budget = h("section", { class: "panel sc-bud" }, h("div", { class: "panel-h" }, h("h2", {}, "Budget"), h("span", { class: "fine muted" }, "The strictest cap wins")),
    h("div", { class: "stats sc-stats" }, stat("Per trade", "–", "Your number, from the strictest cap"), stat("Per day", "–", "Agent Wallet, your limit or the operator"), stat("Left today", "–", "Resets at 00:00 UTC")),
    h("p", { class: "fine muted sc-pad" }, "Leverage and allowed perp markets sit here too, with one place to change them."));
  const ladder = h("section", { class: "panel sc-ladder" }, h("div", { class: "panel-h" }, h("h2", {}, "Trust ladder"), h("span", { class: "fine muted" }, "New wallets start on Approve")),
    h("div", { class: "sc-steps" }, LADDER.map((l, i) => h("div", { class: `sc-step${l.key === DEFAULT_TRUST ? " on" : ""}` }, h("small", {}, `Step ${i + 1}`), h("b", {}, l.name), h("span", {}, l.what)))));
  const jobs = h("section", { class: "panel sc-jobs" }, h("div", { class: "panel-h" }, h("h2", {}, "Jobs and their caps"), h("span", { class: "fine muted" }, "USD a day, inside your Budget")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Job"), h("th", { class: "l" }, "Status"), h("th", {}, "Used today"), h("th", {}, "Daily cap"))),
      h("tbody", {}, JOBS.map((j) => h("tr", {}, h("td", { class: "l" }, h("b", {}, j.name), h("div", { class: "fine muted" }, j.what)),
        h("td", { class: "l" }, h("span", { class: "sc-st" }, "Off")), h("td", {}, "–"), h("td", { class: "muted" }, "no cap")))))));
  const wait = h("section", { class: "panel sc-wait" }, h("div", { class: "panel-h" }, h("h2", {}, "Waiting for you"), h("span", { class: "fine muted" }, "Example")),
    h("ul", { class: "sc-list" }, exampleRow("Buy $EXAMPLE", "Sentry Autopilot · passed the Gate · waits for your Approve or Dismiss", "proposed", "waiting")));
  const rec = h("section", { class: "panel sc-rec" }, h("div", { class: "panel-h" }, h("h2", {}, "Receipts"), h("span", { class: "fine muted" }, "Example")),
    h("ul", { class: "sc-list" },
      exampleRow("Bought $EXAMPLE", "Sentry Autopilot · passed the Gate and your rules · with a link to the transaction", "executed"),
      exampleRow("Exit ticket for $EXAMPLE", "Aegis · red alert: the dev sold · waits for your yes", "proposed"),
      exampleRow("Stop-loss not sent", "Playbook · above the job's daily cap · the reason is always written down", "blocked")));
  return guestPreview({
    title: "Scepter",
    intro: "One command for every agent working for you: one budget, a cap for each job, one switch that stops them all, and a receipt for every move.",
    sentence: "Scepter belongs to the wallet you sign in with. Signing costs nothing and sends nothing.",
    bullets: [
      "One Budget: the strictest of your Agent Wallet caps, your own limits and the operator's, shown as the number that really applies",
      "A trust ladder (Watch, Approve, Auto) and a daily cap for each job: Sentry Autopilot, Playbooks, Aegis and Champions",
      "One switch that stops every agent on the server, and a receipt with its reason for every move",
    ],
    example: [sw, budget, ladder, h("div", { class: "sc-grid" }, jobs, wait), rec],
  });
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
  let stop = false, seq = 0, seen, dirty = false, editOpen = false;
  // a typed, unsaved cap survives the 20-second refresh: the refresh waits until it is saved or the page is left
  wrap.addEventListener("input", (ev) => { if (ev.target.matches?.("input, textarea, select")) dirty = true; });
  const load = async () => {
    const my = ++seq;   // a slower, older load never paints over a newer one (a wallet change starts a new one)
    if (!wallet.session) { dirty = false; clear(wrap, ...guestScepter()); return; }
    const [pol, aw, props, act, ap, ag, wa, ch] = await Promise.all([
      api.get("policy").catch(() => null), api.get("agent-wallet").catch(() => null), api.get("inbox/proposals").catch(() => ({ items: [] })),
      api.get("agent-wallet/activity").catch(() => ({ items: [] })), api.get("autopilot").catch(() => null), api.get("aegis/me").catch(() => null), api.get("watches").catch(() => null),
      api.get("champions/me").catch(() => null)]);
    const chi = await api.get("chiron/rules").catch(() => null);   // V9 F48 Chiron: the owner's habit rules
    const bal = aw?.address ? await api.get("agent-wallet/balances").catch(() => null) : null;
    if (!stop && my === seq && wallet.session) { dirty = false; render({ pol, aw, bal, props: (props?.items || []).filter((p) => p.status === "pending" && p.expiresAt > Date.now()), act: act?.items || [], ap, ag, wa, ch, chi }); }
  };

  // Budget: the numbers that really apply (server/policy.mjs getBudget: the strictest of the Agent Wallet caps, the user's
  // own limits and the operator caps), the one switch that stops every agent, and the one place to change any of the caps.
  // It replaces the Caps panel on Agent → Wallet and Your limits on Agent → Autopilot, which now link here.
  function budgetPanel(x) {
    const e = x.pol?.effective || {}, b = x.pol?.budget || {}, op = b.operator || x.pol?.operator || {};
    const paused = !!e.paused, kill = !!e.killSwitch;
    const blocked = !kill && !paused ? BLOCKED[b.stoppedBy] : null;
    const running = !kill && !paused && !blocked;
    const head = h("div", { class: "sc-cmd" },
      h("div", { class: "sc-cmd-l" }, h("span", { class: `sc-dot${running ? " on" : ""}` }), h("div", {},
        h("b", {}, kill ? "Stopped by the operator" : paused ? "Every agent is stopped" : blocked ? "Your agents cannot trade yet" : "Your agents are running"),
        h("p", { class: "fine muted" }, kill ? "The operator kill switch is on: nothing can trade." : paused ? "Nothing trades from your Agent Wallet until you resume, whatever any job wants." : blocked || `Every job spends inside ${usd(b.perTradeUsd)} a trade and ${usd(b.dailyUsd)} a day, the Gate first.`))),
      h("button", { class: `btn ${paused ? "primary" : "danger"} sc-kill`, type: "button", disabled: kill, onclick: async () => {
        try { await api.post("policy", { paused: !paused }); toast(paused ? "Your agents are running again." : "Every agent is stopped.", paused ? "ok" : "warn"); load(); } catch (err) { toast(err.message, "error"); }
      } }, icon(paused ? "play" : "pause"), paused ? "Resume" : "Stop every agent"));
    const perps = b.allowedPerps?.length ? b.allowedPerps.join(", ") : "every Hyperliquid market";
    const stats = h("div", { class: "stats sc-stats" },
      stat("Per trade", usd(b.perTradeUsd), FROM[b.perTradeFrom] || ""),
      stat("Per day", usd(b.dailyUsd), FROM[b.dailyFrom] || ""),
      stat("Left today", usd(b.leftTodayUsd), `${usd(b.usedTodayUsd)} used · resets at 00:00 UTC`));
    // the form: the Agent Wallet's own caps (agent-wallet/settings) and the user's limits (policy), each clamped on the
    // server to the operator caps. Empty "your limit" fields mean no own limit (the operator cap applies).
    const fld = (label, value, ph, k) => { const i = h("input", { class: "input", type: "text", inputmode: "decimal", value: value ?? "", placeholder: ph, "data-k": k }); return [i, h("label", { class: "field" }, h("span", {}, label), i)]; };
    const u = x.pol?.user || {}, aw = b.agentWallet?.exists ? b.agentWallet : null;
    const [wPer, wPerF] = fld("Per trade (USD)", aw?.perTradeUsd, `up to ${op.perTradeUsd ?? "–"}`, "wper");
    const [wDay, wDayF] = fld("Per day (USD)", aw?.dailyUsd, `up to ${op.agentWalletDailyUsd ?? op.dailyUsd ?? "–"}`, "wday");
    const [uPer, uPerF] = fld("Per trade (USD)", u.perTradeUsd, `operator: ${op.perTradeUsd ?? "–"}`, "uper");
    const [uDay, uDayF] = fld("Per day (USD)", u.dailyUsd, `operator: ${op.dailyUsd ?? "–"}`, "uday");
    const [uLev, uLevF] = fld("Max leverage", u.maxLeverage, `operator: ${op.maxLeverage ?? "–"}x`, "ulev");
    const uPerps = h("input", { class: "input", placeholder: "Empty = every market, e.g. BTC, ETH, HYPE", value: (u.allowedPerps || []).join(", "), "data-k": "uperps" });
    const bad = (el) => el.value.trim() !== "" && !(Number(el.value) >= 0);
    const save = h("button", { class: "btn primary", type: "button", onclick: async () => {
      if ([wPer, wDay, uPer, uDay, uLev].some(bad)) return toast("Caps are amounts in USD (leverage in x): a number of 0 or more, or empty.", "error");
      save.disabled = true;
      try {
        if (aw) {
          // the Agent Wallet always has caps: an empty field leaves that cap as it is
          const wb = {}; if (wPer.value.trim() !== "") wb.perTradeUsd = Number(wPer.value); if (wDay.value.trim() !== "") wb.dailyUsd = Number(wDay.value);
          if (Object.keys(wb).length) await api.post("agent-wallet/settings", wb);
        }
        await api.post("policy", { perTradeUsd: uPer.value.trim(), dailyUsd: uDay.value.trim(), maxLeverage: uLev.value.trim(), allowedPerps: uPerps.value.split(/[\s,]+/).filter(Boolean) });
        toast("Budget saved. The strictest cap applies.", "ok");
      } catch (err) { toast(err.message, "error"); }
      save.disabled = false; dirty = false; load();
    } }, "Save budget");
    const edit = h("details", { class: "sc-edit", ...(editOpen ? { open: true } : {}), ontoggle: (ev) => { editOpen = ev.currentTarget.open; } },
      h("summary", {}, "Change caps"),
      aw ? h("div", { class: "sc-edit-g" }, h("b", {}, "Agent Wallet caps"), h("p", { class: "fine muted" }, "Every automated job and every trade from the Agent Wallet."), h("div", { class: "ag-grid2" }, wPerF, wDayF)) : null,
      h("div", { class: "sc-edit-g" }, h("b", {}, "Your limits"), h("p", { class: "fine muted" }, "Also apply to chat tickets you sign from your own wallet. Empty = the operator cap. You can only go stricter than the operator."),
        h("div", { class: "ag-grid3" }, uPerF, uDayF, uLevF), h("label", { class: "field" }, h("span", {}, "Allowed perps"), uPerps)),
      h("div", { class: "row" }, save));
    return h("section", { class: `panel sc-bud${paused || kill ? " stopped" : ""}` },
      head,
      h("div", { class: "panel-h" }, h("h2", {}, "Budget"), h("span", { class: "fine muted" }, "The strictest cap wins")),
      stats,
      h("p", { class: "fine muted sc-pad" }, `Leverage up to ${b.maxLeverage ?? e.maxLeverage ?? "–"}x on ${perps}. Each job below can also have its own daily cap inside this budget.`),
      edit);
  }

  // V9 F48 Chiron: habit rules made from a trader's own history (#/chiron). The enforced ones block buys from the Agent
  // Wallet on the server (policy.mjs checkAction); reminders are only shown here. Remove takes a rule off at once.
  function chironPanel(x) {
    const rules = x.chi?.rules || [];
    return h("section", { class: "panel sc-chi" },
      h("div", { class: "panel-h" }, h("h2", {}, "Habit rules"), h("a", { class: "link fine", href: "#/chiron" }, "Chiron: read a wallet's habits")),
      rules.length ? h("ul", { class: "sc-list" }, rules.map((r) => h("li", {},
        h("div", {}, h("b", {}, r.text), h("div", { class: "fine muted" }, `${r.enforced ? "Enforced on every buy from your Agent Wallet" : "A reminder: not enforced"} · set ${ago(r.at)} ago${r.from ? ` from ${short(r.from, 4)}'s habits` : ""}${r.kind === "daily-buys" ? ` · ${x.chi.buysToday ?? 0} buys today` : ""}`)),
        h("div", { class: "sc-acts" }, h("span", { class: `sc-st${r.enforced ? " on" : ""}` }, r.enforced ? "enforced" : "reminder"),
          h("button", { class: "btn sm", type: "button", onclick: async () => {
            try { await api.post("chiron/rule", { kind: r.kind, habit: r.habit, on: false }); toast("Rule removed.", "ok"); } catch (err) { toast(err.message, "error"); }
            load();
          } }, "Remove"))))) :
        h("p", { class: "fine muted sc-pad" }, "No habit rules yet. Chiron reads any trader wallet's swaps and turns the habit that cost it most into a rule: no buys in a coin's first 60 seconds, or at most a few buys a day."),
      rules.some((r) => r.enforced) ? h("p", { class: "fine muted sc-pad" }, x.chi.enforcedOn) : null);
  }

  function render(x) {
    const e = x.pol?.effective || {};
    const b = x.pol?.budget || {};
    const trust = e.trust || DEFAULT_TRUST;
    const used = x.pol?.usedTodayBySource || {};
    const st = jobStatus(x);
    // the ladder
    const ladder = h("section", { class: "panel sc-ladder" }, h("div", { class: "panel-h" }, h("h2", {}, "Trust ladder"), h("span", { class: "fine muted" }, "Climb at your pace")),
      h("div", { class: "sc-steps" }, LADDER.map((l, i) => h("button", { class: `sc-step${trust === l.key ? " on" : ""}`, type: "button", onclick: async () => {
        try { await api.post("policy", { trust: l.key }); toast(`Trust ladder: ${l.name}.`, "ok"); load(); } catch (err) { toast(err.message, "error"); }
      } }, h("small", {}, `Step ${i + 1}`), h("b", {}, l.name), h("span", {}, l.what)))));
    // jobs and their own daily caps (inside the Budget: a job never spends more than the day budget, whatever its cap)
    const capIn = {};
    const jobs = h("section", { class: "panel sc-jobs" }, h("div", { class: "panel-h" }, h("h2", {}, "Jobs and their caps"), h("span", { class: "fine muted" }, "USD a day, inside your Budget")),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Job"), h("th", { class: "l" }, "Status"), h("th", {}, "Used today"), h("th", {}, "Daily cap"))),
        h("tbody", {}, JOBS.map((j) => {
          capIn[j.key] = h("input", { class: "sc-in", type: "text", inputmode: "decimal", placeholder: "no cap", value: e.jobCaps?.[j.key] ?? "", "data-k": `job-${j.key}`,
            title: b.dailyUsd != null ? `Empty: up to the day budget (${usd(b.dailyUsd)})` : "Empty: up to the day budget" });
          return h("tr", {}, h("td", { class: "l" }, h("a", { class: "link", href: j.href }, j.name), h("div", { class: "fine muted" }, j.what)),
            h("td", { class: "l" }, h("span", { class: `sc-st${st[j.key].on ? " on" : ""}` }, st[j.key].label)),
            h("td", {}, usd(used[j.key] || 0)), h("td", {}, capIn[j.key]));
        })))),
      h("div", { class: "sc-row" }, h("p", { class: "fine muted" }, x.aw?.address ? `Agent Wallet ${short(x.aw.address, 4)}: ${x.bal?.robinhoodEth != null ? `${x.bal.robinhoodEth.toFixed(4)} ETH` : "balance unknown"}.` : "No Agent Wallet yet: jobs cannot trade until you create one in Agent → Wallet."),
        h("button", { class: "btn sm", type: "button", onclick: async () => {
          const jc = {}; for (const j of JOBS) { const v = capIn[j.key].value.trim(); if (v !== "") jc[j.key] = Number(v); }
          if (Object.values(jc).some((v) => !(v >= 0))) return toast("A job cap is an amount in USD (0 or more), or empty for no cap.", "error");
          try { await api.post("policy", { jobCaps: jc }); toast("Job caps saved.", "ok"); } catch (err) { toast(err.message, "error"); }
          dirty = false; load();
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
    // a repaint gives the keyboard back to the field or button that had it (data-k)
    const k = wrap.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
    clear(wrap, intro(), budgetPanel(x), ladder, h("div", { class: "sc-grid" }, jobs, wait), chironPanel(x), rec);
    if (k) wrap.querySelector(`[data-k="${k}"]`)?.focus();
  }
  // onWallet calls back at once with the current wallet: that first call is the load. After that it reloads only when the
  // wallet or the session changes (connect, sign in, switch account, sign out), not on a chain switch.
  const who = () => (wallet.session ? `s:${String(wallet.session.address || wallet.address || "").toLowerCase()}` : `g:${wallet.address || ""}`);
  const off = onWallet(() => { const k = who(); if (k !== seen) { seen = k; load(); } });
  // the timed refresh leaves the page alone while a cap is being typed or waits unsaved
  const typing = () => { const a = document.activeElement; return !!a && wrap.contains(a) && a.matches("input, textarea, select"); };
  const t = setInterval(() => { if (!document.hidden && wallet.session && !dirty && !typing()) load(); }, 20_000);
  return () => { stop = true; clearInterval(t); off(); };
}
