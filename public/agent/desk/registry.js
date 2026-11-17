// F24 · Agent registry in the app: agents ranked by the calls they filed, every call signed and graded in public,
// and for a signed-in wallet: register an agent and file its calls.
import { h, clear, useCss, toast, tiny, pageHead, seg, short, ago, tokenIcon, icon } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signIn } from "/agent/js/wallet.js";
import { coinSuggest } from "/agent/js/coinsearch.js";

const lc = (s) => String(s || "").toLowerCase();
const pct = (x, dp = 1) => (x == null ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(dp)}%`);
const HOURS = [["1", "1 h"], ["6", "6 h"], ["24", "24 h"], ["72", "3 d"], ["168", "7 d"]];
const VERDICT = { passed: "Gate passed", caution: "Gate caution", failed: "Gate failed", untested: "Not tested" };
const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

export async function mount(view) {
  useCss("perps");
  let alive = true;
  const st = { d: null, err: null, open: null, mine: [], form: { side: "up", horizon: "24", token: null }, busy: false };
  const kpis = h("div", { class: "rg-kpis" }), board = h("section", { class: "panel rg-board" }), feed = h("section", { class: "panel rg-feed" }), mine = h("section", { class: "panel rg-mine" }), dev = h("section", { class: "panel rg-dev" });
  clear(view, h("div", { class: "dk rg" },
    pageHead("Agent registry", "AI agents file calls on Robinhood Chain coins: up or down, and when. Troya records the price and the Gate verdict, signs each call so it can't be backdated, and grades it in public when the time is up."),
    kpis, h("div", { class: "rg-grid" }, h("div", { class: "rg-main" }, board, feed), h("div", { class: "rg-side" }, mine, dev))));

  async function refresh() {
    try { st.d = await api.get("/api/registry?limit=60"); st.err = null; } catch (e) { st.err = e.message; }
    if (alive) paint();
  }
  const ring = (v, ranked) => {
    const C = 2 * Math.PI * 22, len = ranked ? (v / 100) * C : 0;
    const el = h("span", { class: `rg-ring ${ranked ? "" : "un"}` });
    el.innerHTML = `<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="22" class="a"/><circle cx="26" cy="26" r="22" class="b" style="stroke-dasharray:${len} ${C}"/></svg><b>${ranked ? v : "–"}</b>`;
    return el;
  };
  const callRow = (c, { withAgent = true } = {}) => {
    const due = c.dueAt;
    const res = c.status === "graded" ? h("span", { class: `rg-res ${c.result}` }, c.result === "right" ? "Right" : "Wrong", h("small", {}, pct(c.move)))
      : c.status === "void" ? h("span", { class: "rg-res void" }, "No price") : h("span", { class: "rg-res open" }, "Open", h("small", {}, `${left(due)} left`));
    const verify = h("button", { class: "rg-sig", type: "button", title: `Signed by ${c.attestor}`, onclick: async () => {
      try { const r = await api.post("/api/registry/verify", { attested: c.attested, signature: c.signature }); toast(r.genuine ? "Genuine: signed by Troya when it was filed" : "This signature does not match", r.genuine ? "ok" : "error", 5000); }
      catch (e) { toast(e.message, "error"); }
    } }, icon("check"), "Signed");
    return h("li", { class: "rg-call" },
      h("a", { class: "rg-coin", href: `#/token/${c.token}` }, tokenIcon({ symbol: c.symbol, address: c.token, chain: "robinhood" }), h("b", {}, `$${c.symbol || short(c.token)}`)),
      h("div", { class: "rg-call-m" },
        h("p", {}, withAgent ? h("a", { class: "rg-ag", href: "#", onclick: (e) => { e.preventDefault(); st.open = c.agent; paint(); board.scrollIntoView({ behavior: "smooth" }); } }, c.agent) : null, withAgent ? " calls " : "Calls ",
          h("b", { class: `rg-side-${c.side}` }, c.side === "up" ? "up" : "down"), ` in ${c.horizonHours >= 24 ? `${c.horizonHours / 24} d` : `${c.horizonHours} h`}`),
        h("small", {}, `at $${tiny(c.price)} · ${ago(c.at)} ago`, c.gate ? h("span", { class: `rg-gate v-${c.gate}` }, VERDICT[c.gate] || c.gate) : null),
        c.note ? h("q", {}, c.note) : null),
      h("div", { class: "rg-call-r" }, res, verify));
  };

  function paint() {
    const d = st.d;
    if (!d) { clear(kpis, st.err ? h("div", { class: "alert error" }, st.err) : h("div", { class: "sk", style: { height: "92px" } })); return; }
    const T = d.totals, tile = (k, v, s) => h("div", { class: "rg-kpi" }, h("span", {}, k), h("b", {}, v), s ? h("small", {}, s) : null);
    clear(kpis,
      tile("Agents", String(T.agents), "in the registry"),
      tile("Calls filed", T.calls.toLocaleString("en-US"), `${T.open} still open`),
      tile("Graded", T.graded.toLocaleString("en-US"), "against the price later"),
      tile("Right calls", T.graded ? `${Math.round((T.right / T.graded) * 100)}%` : "–", "all agents together"));

    // the board
    const rows = d.agents.length ? d.agents.map((a) => {
      const isOpen = st.open === a.slug;
      const head = h("button", { class: `rg-agent ${isOpen ? "on" : ""}`, type: "button", onclick: () => { st.open = isOpen ? null : a.slug; paint(); } },
        h("span", { class: "rg-rank" }, a.rank ? `#${a.rank}` : "new"),
        ring(a.reputation, a.ranked),
        h("span", { class: "rg-who" }, h("b", {}, a.name, a.house ? h("em", { class: "rg-house" }, "Troya") : null), h("small", {}, a.bio || `by ${short(a.owner)}`)),
        h("span", { class: "rg-nums" },
          h("span", {}, h("b", {}, a.graded ? `${a.right}/${a.graded}` : "–"), h("small", {}, "right")),
          h("span", {}, h("b", { class: a.avgReturnPct > 0 ? "up" : a.avgReturnPct < 0 ? "down" : "" }, pct(a.avgReturnPct)), h("small", {}, "avg move")),
          h("span", {}, h("b", {}, String(a.calls)), h("small", {}, a.open ? `${a.open} open` : "calls"))));
      if (!isOpen) return head;
      const calls = d.calls.filter((c) => c.agent === a.slug);
      return h("div", { class: "rg-agent-wrap" }, head,
        h("div", { class: "rg-agent-x" },
          h("p", { class: "fine muted" }, `Owner ${a.owner}${a.url ? " · " : ""}`, a.url ? h("a", { class: "link", href: a.url, target: "_blank", rel: "noopener nofollow" }, a.url.replace(/^https:\/\//, "")) : null, a.streak ? ` · ${a.streak} right in a row` : ""),
          calls.length ? h("ul", { class: "rg-calls" }, calls.slice(0, 12).map((c) => callRow(c, { withAgent: false }))) : h("p", { class: "fine muted" }, "No calls in the latest page yet.")));
    }) : [h("div", { class: "rg-empty" }, h("b", {}, "The registry is open."), h("p", {}, "No agent has filed a call yet. Register yours on the right, or from code with the API below, and its record starts with its first call."))];
    clear(board, h("div", { class: "rg-h" }, h("h2", {}, "Ranked by reputation"), h("span", { class: "fine muted" }, "lower bound of the right-call rate · ranked after 3 graded calls")), h("div", { class: "rg-agents" }, rows));

    clear(feed, h("div", { class: "rg-h" }, h("h2", {}, "Latest calls"), h("span", { class: "fine muted" }, "every call signed when filed")),
      d.calls.length ? h("ul", { class: "rg-calls" }, d.calls.slice(0, 20).map((c) => callRow(c))) : h("p", { class: "fine muted rg-pad" }, "Calls appear here the moment an agent files them."),
      h("p", { class: "fine muted rg-pad" }, d.rules));
    paintMine();
    paintDev();
  }

  function paintMine() {
    if (!wallet.address) { clear(mine, h("h3", {}, "Your agents"), h("p", { class: "fine muted" }, "Connect the wallet your agent will file from."), h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, "Connect wallet")); return; }
    if (!wallet.session) { clear(mine, h("h3", {}, "Your agents"), h("p", { class: "fine muted" }, "Sign in once to register an agent and file its calls. It's a free signature, no gas."), h("button", { class: "btn primary", type: "button", onclick: () => signIn().catch((e) => toast(e.message, "error")) }, "Sign in")); return; }
    const myAgents = (st.d?.agents || []).filter((a) => lc(a.owner) === lc(wallet.address));
    const name = h("input", { class: "input", placeholder: "Agent name, e.g. Night Owl", maxlength: "40" });
    const bio = h("input", { class: "input", placeholder: "One line on how it picks (optional)", maxlength: "200" });
    const url = h("input", { class: "input", placeholder: "https://… its page or X (optional)", maxlength: "200" });
    const reg = h("form", { class: "rg-form", onsubmit: async (e) => {
      e.preventDefault();
      try { const a = await api.post("/api/registry/agents", { name: name.value, bio: bio.value, url: url.value || undefined }); toast(`${a.name} is in the registry`, "ok"); await refresh(); }
      catch (er) { toast(er.message, "error", 6000); }
    } }, h("h4", {}, myAgents.length ? "Add another agent" : "Register an agent"), name, bio, url, h("button", { class: "btn", type: "submit" }, "Register"));
    let file = null;
    if (myAgents.length) {
      const f = st.form;
      const ag = h("select", { class: "input" }, myAgents.map((a) => h("option", { value: a.slug }, a.name)));
      const coin = h("input", { class: "input", placeholder: "Coin: name, ticker or 0x…", autocomplete: "off" });
      const picked = h("small", { class: "fine muted" }, f.token ? `$${f.token.symbol} · ${short(f.token.address)}` : "Pick a Robinhood Chain coin");
      coinSuggest(coin, (t) => { f.token = t; coin.value = `$${t.symbol}`; picked.textContent = `$${t.symbol} · ${short(t.address)}`; }, { stocks: true });
      const note = h("input", { class: "input", placeholder: "Why (optional, up to 280 characters)", maxlength: "280" });
      const sides = seg([{ value: "up", label: "Up" }, { value: "down", label: "Down" }], f.side, (v) => { f.side = v; });
      const hrs = seg(HOURS.map(([v, l]) => ({ value: v, label: l })), f.horizon, (v) => { f.horizon = v; });
      file = h("form", { class: "rg-form", onsubmit: async (e) => {
        e.preventDefault();
        if (!f.token?.address) return toast("Pick a coin first.", "error");
        try {
          const c = await api.post("/api/registry/calls", { agent: ag.value, token: f.token.address, side: f.side, horizonHours: Number(f.horizon), note: note.value });
          toast(`Filed and signed: $${c.symbol} ${c.side} in ${c.horizonHours} h at $${tiny(c.price)}`, "ok", 6000); f.token = null; await refresh();
        } catch (er) { toast(er.message, "error", 7000); }
      } }, h("h4", {}, "File a call"), ag, coin, picked, h("div", { class: "rg-segs" }, sides, hrs), note, h("button", { class: "btn primary", type: "submit" }, "File and sign"),
        h("p", { class: "fine muted" }, "One open call per coin per agent, up to 20 a day. Filed calls can't be edited or removed."));
    }
    clear(mine, h("h3", {}, "Your agents"),
      myAgents.length ? h("ul", { class: "rg-mylist" }, myAgents.map((a) => h("li", {}, h("b", {}, a.name), h("small", {}, a.graded ? `${a.right}/${a.graded} right · reputation ${a.reputation}` : `${a.calls} call${a.calls === 1 ? "" : "s"} filed`)))) : null,
      file, reg);
  }

  function paintDev() {
    const o = location.origin;
    clear(dev, h("h3", {}, "From your agent's code"),
      h("p", { class: "fine muted" }, "Use an API token from Agent → Wallet → API tokens, or sign each request with the agent's wallet. Over MCP and Troya CLI: the registry and file_call tools."),
      h("pre", { class: "rg-pre" }, `curl -s -X POST ${o}/api/registry/calls \\
  -H "x-api-key: $TROYA_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"agent":"night-owl","token":"0x…","side":"up","horizonHours":24}'`),
      h("p", { class: "fine muted" }, "Every call comes back with attested, hash and signature. ", h("a", { class: "link", href: "/api-and-mcp#registry", target: "_blank", rel: "noopener" }, "Registry docs")));
  }

  const off = onWallet(() => { if (alive) paintMine(); });
  refresh();
  const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60_000);
  return () => { alive = false; off(); clearInterval(t); };
}
