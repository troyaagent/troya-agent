// V9 F57 Phoenix (#/phoenix): what the agents learned. Every closed Arena trade, Anthropic Round call and graded Sentry
// call is a lesson; the lessons add up to win rates by pattern, each with its sample size and a Wilson lower bound, never
// a claim under 5 trades. The numbers come from GET /api/phoenix (server/phoenix.mjs); this page only shows them.
// While PHOENIX_INJECT is off (shadow mode) the page says so plainly: nothing here reaches any agent's prompt.
import { h, clear, ago, short } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const SRC = { arena: "Arena", record: "Sentry call", ant: "Anthropic Round", champions: "Champions", autopilot: "Autopilot" };
const EXIT = { stop: "Stop", "take-profit": "Take-profit", time: "Time limit", watchfire: "Watchfire", "nothing left to sell": "Nothing left" };

export function phoenixCss() {
  if (document.querySelector("link[data-phoenix-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/phoenix.css", "data-phoenix-css": "1" }));
}
const pc = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${Number(x).toFixed(1)}%`);
const rate = (t) => (t?.n ? `${t.winRate}%` : "–");

// one stat: the win rate, its count and n, the floor it is at least (95%), and a bar with the floor marked
function bar(t) {
  const w = t.n ? Math.max(0, Math.min(100, t.winRate)) : 0, lo = t.n ? Math.max(0, Math.min(100, t.wilsonLow)) : 0;
  return h("span", { class: "px-bar", role: "img", "aria-label": t.n ? `${t.winRate}% won, at least ${t.wilsonLow}% with 95% confidence` : "no trades" },
    h("i", { class: "px-bar-w", style: { width: `${w}%` } }), h("i", { class: "px-bar-lo", style: { left: `${lo}%` } }));
}
function patternRow(x) {
  return h("li", { class: `px-row${x.enough ? "" : " few"}` },
    h("span", { class: "px-b" }, x.bucket),
    bar(x),
    h("span", { class: "px-wl" }, h("b", {}, String(x.wins)), " won · ", h("b", {}, String(x.losses)), " lost"),
    h("span", { class: "px-n" }, `n=${x.n}`),
    x.enough ? h("span", { class: "px-r" }, h("b", {}, `${x.winRate}%`), h("small", {}, x.wins ? `at least ${x.wilsonLow}%` : "none won"))
      : h("span", { class: "px-r" }, h("small", {}, "too few to call")),
    h("span", { class: `px-avg ${x.avgPnlPct > 0 ? "up" : x.avgPnlPct < 0 ? "down" : ""}` }, x.avgPnlPct == null ? "–" : `avg ${pc(x.avgPnlPct)}`));
}
function patternGroups(list, { skip = [] } = {}) {
  const by = new Map();
  for (const x of list || []) { if (skip.includes(x.key)) continue; if (!by.has(x.key)) by.set(x.key, { label: x.label, rows: [], outcome: x.outcome }); by.get(x.key).rows.push(x); }
  if (!by.size) return h("p", { class: "px-none" }, "No lessons in this group yet.");
  return h("div", { class: "px-groups" }, [...by.values()].map((g) => h("section", { class: "px-group" },
    h("h3", {}, g.label, g.outcome ? h("small", {}, " · happened during the trade, not known at entry") : null),
    h("ul", { class: "px-rows" }, g.rows.sort((a, b) => b.n - a.n).map(patternRow)))));
}
function statCell(k, t, sub) {
  return h("div", { class: "px-kpi" }, h("span", {}, k), h("b", {}, t), sub ? h("small", {}, sub) : null);
}

function agentCard(a, pick) {
  const exits = Object.entries(a.exits || {}).sort((x, y) => y[1] - x[1]);
  const total = exits.reduce((s, [, n]) => s + n, 0) || 1;
  return h("button", { class: "px-agent", type: "button", onclick: () => pick(a.id), "aria-label": `${a.name}: show its patterns` },
    h("span", { class: "px-agent-h" }, h("b", {}, a.name), a.model ? h("small", {}, a.model) : null),
    h("span", { class: "px-agent-r" },
      h("span", {}, h("small", {}, "Paper"), h("b", {}, rate(a.paper)), h("i", {}, `${a.paper.wins} of ${a.paper.n}`)),
      h("span", { title: "Real-money trades from the Arena wallet" }, h("small", {}, "Live"), h("b", {}, rate(a.live)), h("i", {}, a.live.n ? `${a.live.wins} of ${a.live.n}` : "none"))),
    h("span", { class: "px-exits", "aria-label": "How its paper trades closed" }, exits.map(([k, n]) => h("i", { class: `px-ex ex-${k.replace(/[^a-z]/g, "")}`, style: { flexGrow: String(n / total) }, title: `${EXIT[k] || k}: ${n}` }))),
    h("span", { class: "px-exits-l" }, exits.map(([k, n]) => `${EXIT[k] || k} ${n}`).join(" · ")));
}

function lessonEl(l) {
  const coin = l.symbol ? `$${l.symbol}` : "";
  return h("li", { class: `px-lesson ${l.win ? "win" : "loss"}` },
    h("div", { class: "px-lesson-h" },
      h("span", { class: "px-src" }, l.source === "arena" ? `${SRC.arena} · ${l.book === "live" ? "real money" : "paper"}` : SRC[l.source] || l.source),
      h("b", {}, l.agentName),
      l.token ? h("a", { class: "link mono", href: `#/token/${l.token}`, title: l.token }, coin || short(l.token)) : coin ? h("span", { class: "mono" }, coin) : null,
      h("span", { class: `px-pnl ${l.pnlPct > 0 ? "up" : "down"}` }, pc(l.pnlPct)),
      l.backfilled ? h("span", { class: "px-tag", title: "Rebuilt from history when Phoenix started" }, "Backfilled") : null,
      h("time", { class: "fine", datetime: new Date(l.at).toISOString() }, `${ago(l.at)} ago`)),
    h("p", {}, l.fact || l.lesson),
    l.takeaway ? h("p", { class: "px-take" }, l.takeaway) : null);
}

export async function mount(view, ctx) {
  phoenixCss();
  let alive = true, data = null, sel = "all", showAll = false;
  const body = h("div", { class: "px-body" }, h("div", { class: "sk", style: { height: "160px" } }));
  clear(view, h("div", { class: "dk px-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Agent · Phoenix"),
      h("h1", {}, "What the agents ", h("em", {}, "learned.")),
      h("p", { class: "dk-sub" }, "Every closed Arena trade, every Anthropic Round call and every Sentry call graded in The Record becomes a lesson: the setup Troya stored at the time, how it ended, and one plain line. The lessons add up to win rates by pattern, each with its sample size. Phoenix was the tutor who raised Achilles.")),
    body));

  async function load() {
    try { data = await api.get("/api/phoenix"); }
    catch (e) { if (alive) clear(body, h("div", { class: "dk-empty" }, h("b", {}, "The lessons could not be read right now."), h("p", {}, e.message), h("button", { class: "btn sm", type: "button", onclick: load }, "Try again"))); return; }
    if (alive) render();
  }

  function render() {
    const d = data, A = d.arena;
    const agent = A.agents.find((a) => a.id === sel) || null;
    const picker = h("div", { class: "seg px-seg", role: "group", "aria-label": "Whose patterns" },
      [{ id: "all", name: "All five" }, ...A.agents].map((a) => h("button", { type: "button", "aria-pressed": String(sel === a.id), onclick: () => { sel = a.id; render(); } }, a.name)));
    const lessons = d.recent.filter((l) => showAll || !l.backfilled);
    const shownLessons = (lessons.length ? lessons : d.recent).slice(0, 30);
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Phoenix (${d.mode} mode): ${d.totals.lessons} lessons. AI traders on paper ${A.paper.wins} of ${A.paper.n} won; real money ${A.live.wins} of ${A.live.n}; Sentry calls ${d.sentry.overall.wins} of ${d.sentry.overall.n} higher after 24 h.` } }));
    clear(body,
      h("section", { class: `px-mode ${d.inject ? "on" : "shadow"}`, role: "status" },
        h("span", { class: `dk-v ${d.inject ? "v-passed" : "v-caution"}` }, d.inject ? "In use" : "Shadow mode"),
        h("p", {}, d.note)),
      h("div", { class: "px-kpis" },
        statCell("Lessons", d.totals.lessons.toLocaleString("en-US"), `${d.totals.backfilled} backfilled · ${d.totals.live} since Phoenix started`),
        statCell("AI traders, paper", rate(A.paper), A.paper.n ? `${A.paper.wins} of ${A.paper.n} won · at least ${A.paper.wilsonLow}%` : "no trades yet"),
        statCell("AI traders, real money", rate(A.live), A.live.n ? `${A.live.wins} of ${A.live.n} won · avg ${pc(A.live.avgPnlPct)}` : "no trades yet"),
        statCell("Sentry calls, higher at 24 h", rate(d.sentry.overall), d.sentry.overall.n ? `${d.sentry.overall.wins} of ${d.sentry.overall.n} graded calls` : "none graded yet")),
      h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "The five AI traders"), h("span", { class: "fine" }, "Tap one for its patterns")),
        h("div", { class: "px-agents" }, A.agents.map((a) => agentCard(a, (id) => { sel = id; render(); document.querySelector(".px-pat")?.scrollIntoView({ behavior: "smooth", block: "start" }); })))),
      h("section", { class: "panel px-panel px-pat" },
        h("div", { class: "panel-h px-pat-h" }, h("h2", {}, agent ? `${agent.name}: win rate by pattern` : "All five traders: win rate by pattern"), picker),
        h("p", { class: "fine px-lead" }, agent ? `${agent.name}'s paper trades (${agent.paper.n}). ` : `The paper book (${A.paper.n} trades), where every AI trader takes every trade its rules allow. `,
          "The bar is the win rate; the tick marks the rate it is at least, with 95% confidence (Wilson). Groups under 5 trades are shown faded and never called a pattern."),
        patternGroups(agent ? agent.patterns : A.patterns),
        agent?.wouldTell ? h("details", { class: "px-tell" },
          h("summary", {}, d.inject ? `What ${agent.name} reads before it writes its rules` : `What ${agent.name} would read before it writes its rules (not sent in shadow mode)`),
          h("pre", {}, agent.wouldTell)) : null),
      h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "Sentry's calls, graded in The Record"), h("a", { class: "link fine", href: "/record", target: "_blank", rel: "noopener" }, "The Record")),
        h("p", { class: "fine px-lead" }, `A win is a coin higher 24 hours after Sentry posted it (${d.sentry.overall.n} graded calls, average ${pc(d.sentry.overall.avgPnlPct)}, median ${pc(d.sentry.overall.medianPnlPct)}).`),
        patternGroups(d.sentry.patterns)),
      d.antRound.overall.n ? h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "Anthropic Round on xyz:ANT"), h("span", { class: "fine" }, `${d.antRound.overall.wins} of ${d.antRound.overall.n} closed calls won`)),
        h("p", { class: "fine px-lead" }, d.antRound.agents.map((a) => `${a.name} ${a.overall.wins} of ${a.overall.n}`).join(" · ")),
        patternGroups(d.antRound.patterns, { skip: ["hour"] })) : null,
      d.followers.champions || d.followers.autopilot ? h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "People's agents")),
        h("p", { class: "fine px-lead" }, [d.followers.champions ? `Champions followers: ${d.followers.champions.wins} of ${d.followers.champions.n} trades won.` : "", d.followers.autopilot ? `Sentry Autopilot users: ${d.followers.autopilot.wins} of ${d.followers.autopilot.n} trades won.` : ""].join(" "), " Counted together, never by wallet.")) : null,
      h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "Recent lessons"),
          d.totals.live ? h("label", { class: "px-toggle fine" }, h("input", { type: "checkbox", checked: showAll, onchange: (e) => { showAll = e.target.checked; render(); } }), "Include backfilled") : null),
        !d.totals.live ? h("p", { class: "fine px-lead" }, "Every lesson so far was rebuilt from history when Phoenix started; new ones are written as trades close and calls are graded.") : null,
        h("ul", { class: "px-lessons" }, shownLessons.map(lessonEl))),
      h("section", { class: "panel px-panel" },
        h("div", { class: "panel-h" }, h("h2", {}, "Corrections the community bot follows"), h("span", { class: "fine" }, `${d.corrections.length} active`)),
        h("p", { class: "fine px-lead" }, "When the Telegram bot gets something wrong, the team writes the correction once. Every bot answer carries these, so the same mistake is not made again."),
        d.corrections.length ? h("ol", { class: "px-corr" }, d.corrections.map((c) => h("li", {},
          h("p", { class: "px-wrong" }, h("span", {}, "Wrong"), c.wrong),
          h("p", { class: "px-right" }, h("span", {}, "Right"), c.right),
          h("small", { class: "fine" }, `${c.source || "team"} · ${new Date(c.at).toISOString().slice(0, 10)}`)))) : h("p", { class: "px-none" }, "No corrections yet.")),
      h("p", { class: "note px-rules" }, d.rules, d.updatedAt ? ` Updated ${ago(d.updatedAt)} ago.` : ""));
  }

  await load();
  const timer = setInterval(() => { if (alive && document.visibilityState === "visible") load(); }, 120_000);
  return () => { alive = false; clearInterval(timer); };
}
