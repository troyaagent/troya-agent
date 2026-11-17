// F25 · The audited rail in the app: the kill switch, the policy the rail enforces, and the signed audit log.
import { h, clear, useCss, toast, pageHead, short, ago, icon } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signIn } from "/agent/js/wallet.js";

export async function mount(view) {
  useCss("perps");
  let alive = true;
  const st = { d: null, err: null, busy: false };
  const top = h("div", { class: "rl-top" }), body = h("div", { class: "rl-body" });
  clear(view, h("div", { class: "dk rl" },
    pageHead("Audited rail", "Your limits between your AI agent and Robinhood's agentic trading MCP. The rail runs on your machine; Troya checks every order against the policy below, signs the decision and keeps it here. Not affiliated with Robinhood."),
    top, body));

  async function refresh() {
    if (!wallet.session) return paint();
    try { st.d = await api.get("/api/rail/log?limit=100"); st.err = null; } catch (e) { st.err = e.message; }
    if (alive) paint();
  }
  const save = async (patch) => {
    st.busy = true; paint();
    try { st.d = { ...st.d, ...(await api.post("/api/rail/policy", patch)) }; toast("Rail policy saved. The rail uses it on the next order.", "ok"); }
    catch (e) { toast(e.message, "error", 6000); }
    st.busy = false; paint();
  };
  const kill = async (on) => {
    st.busy = true; paint();
    try { st.d = { ...st.d, ...(await api.post("/api/rail/kill", { on })) }; toast(on ? "Kill switch on: every order is refused." : "Kill switch off: orders follow your policy again.", on ? "error" : "ok", 5000); }
    catch (e) { toast(e.message, "error"); }
    st.busy = false; paint();
  };

  function setup() {
    const o = location.origin;
    return h("section", { class: "panel rl-setup" }, h("h3", {}, "Set it up"),
      h("ol", { class: "rl-steps" },
        h("li", {}, "Create an API token in ", h("a", { class: "link", href: "#/agent/wallet" }, "Agent → Wallet → API tokens"), "."),
        h("li", {}, "Add the rail to your agent instead of Robinhood's MCP. It starts Robinhood's MCP for you (mcp-remote signs you in to Robinhood in your own browser; Troya never sees that login):",
          h("pre", { class: "rg-pre" }, `claude mcp add robinhood-rail \\
  -e TROYA_API_KEY=<your-token> \\
  -- npx -y ${o}/rail/troyaagent-rail-0.1.0.tgz`)),
        h("li", {}, "Set your policy here, then trade from your agent. Every order lands in the log.")),
      h("p", { class: "fine muted" }, "Any other MCP server works too: put its command after --. Read tools pass straight through; anything else is checked first, and if Troya can't be reached the rail refuses it. ", h("a", { class: "link", href: "/api-and-mcp#rail", target: "_blank", rel: "noopener" }, "Rail docs")));
  }

  function paint() {
    if (!wallet.address || !wallet.session) {
      clear(top, h("section", { class: "panel rl-need" }, h("h3", {}, "Sign in to set your rail"), h("p", { class: "fine muted" }, "The policy and the audit log belong to the wallet you sign in with, the same wallet whose API token the rail uses."),
        !wallet.address ? h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, "Connect wallet") : h("button", { class: "btn primary", type: "button", onclick: () => signIn().then(refresh).catch((e) => toast(e.message, "error")) }, "Sign in")));
      clear(body, setup());
      return;
    }
    if (!st.d) { clear(top, st.err ? h("div", { class: "alert error" }, st.err) : h("div", { class: "sk", style: { height: "160px" } })); clear(body); return; }
    const p = st.d.policy, t = st.d.today, rails = Object.entries(st.d.rails || {});
    clear(top,
      h("section", { class: `panel rl-kill ${p.kill ? "on" : ""}` },
        h("div", {}, h("p", { class: "d2-mic" }, h("i", { class: "live-dot" }), p.kill ? "Kill switch on" : p.ordersOn ? "Orders follow your policy" : "Orders are off"),
          h("h2", {}, p.kill ? "Every order is refused." : p.ordersOn ? `Up to $${p.maxOrderUsd} an order, $${p.dailyUsd} a day.` : "Your agent can read, not trade."),
          h("p", { class: "fine muted" }, `Today (New York): ${t.orders} order${t.orders === 1 ? "" : "s"}, $${t.usd.toFixed(2)} · market ${st.d.marketOpen ? "open" : "closed"}`, rails.length ? ` · rails seen: ${rails.map(([n, at]) => `${n} ${ago(at)} ago`).join(", ")}` : " · no rail has called yet")),
        h("button", { class: `btn rl-kill-b ${p.kill ? "" : "danger"}`, type: "button", disabled: st.busy, onclick: () => kill(!p.kill) }, p.kill ? "Switch the kill switch off" : "Kill switch: stop all orders")));

    const num = (v, k) => h("input", { class: "input", type: "number", min: "1", step: "1", value: String(v), "data-k": k });
    const f = { maxOrderUsd: num(p.maxOrderUsd, "maxOrderUsd"), dailyUsd: num(p.dailyUsd, "dailyUsd"), maxOrdersPerDay: num(p.maxOrdersPerDay, "maxOrdersPerDay") };
    const syms = h("input", { class: "input", value: p.symbols.join(", "), placeholder: "Empty = any symbol. e.g. NVDA, AAPL, SPY" });
    const blocked = h("input", { class: "input", value: p.blocked.join(", "), placeholder: "Never these, e.g. GME" });
    const chk = (label, on, k) => { const i = h("input", { type: "checkbox", checked: on }); i.dataset.k = k; return h("label", { class: "rl-chk" }, i, label); };
    const cOrders = chk("Allow orders", p.ordersOn, "ordersOn"), cHours = chk("US market hours only", p.marketHoursOnly, "marketHoursOnly"), cBuy = chk("Buys only (no sells)", p.buyOnly, "buyOnly");
    const form = h("form", { class: "panel rl-form", onsubmit: (e) => {
      e.preventDefault();
      save({ ordersOn: cOrders.querySelector("input").checked, marketHoursOnly: cHours.querySelector("input").checked, buyOnly: cBuy.querySelector("input").checked,
        maxOrderUsd: Number(f.maxOrderUsd.value), dailyUsd: Number(f.dailyUsd.value), maxOrdersPerDay: Number(f.maxOrdersPerDay.value), symbols: syms.value, blocked: blocked.value });
    } }, h("h3", {}, "Policy"),
      h("div", { class: "rl-chks" }, cOrders, cHours, cBuy),
      h("div", { class: "rl-nums" }, h("label", {}, "Per order (USD)", f.maxOrderUsd), h("label", {}, "Per day (USD)", f.dailyUsd), h("label", {}, "Orders a day", f.maxOrdersPerDay)),
      h("label", { class: "rl-full" }, "Allowlist", syms), h("label", { class: "rl-full" }, "Block list", blocked),
      h("p", { class: "fine muted" }, "Always refused: moving money in or out, tools the rail does not recognise, and orders it cannot size in dollars. An order with no amount or limit price is sized from the stock's price on Robinhood Chain."),
      h("button", { class: "btn primary", type: "submit", disabled: st.busy }, "Save policy"));

    const log = st.d.log || [];
    const rows = log.length ? log.map((e) => h("li", { class: `rl-row ${e.allow ? "ok" : "no"}` },
      h("span", { class: "rl-v" }, e.allow ? "Allowed" : "Refused"),
      h("div", { class: "rl-m" },
        h("b", {}, e.order?.symbol ? `${e.order.side || ""} ${e.order.symbol}${e.order.usd != null ? ` · $${e.order.usd}` : ""}` : e.tool),
        h("small", {}, `${e.tool} · ${e.rail} · ${ago(e.at)} ago${e.result ? ` · ${e.result.ok ? "Robinhood accepted" : "Robinhood returned an error"}` : ""}`),
        !e.allow && e.reasons?.length ? h("small", { class: "rl-why" }, e.reasons.join(" ")) : null),
      h("button", { class: "rg-sig", type: "button", title: e.hash, onclick: async () => {
        const att = { v: e.v, kind: e.kind, id: e.id, owner: e.owner, rail: e.rail, tool: e.tool, class: e.class, allow: e.allow, reasons: e.reasons, order: e.order, at: e.at };
        try { const r = await api.post("/api/rail/verify", { attested: att, signature: e.signature }); toast(r.genuine ? "Genuine: signed by Troya at the moment of the decision" : "This signature does not match", r.genuine ? "ok" : "error", 5000); } catch (er) { toast(er.message, "error"); }
      } }, icon("check"), "Signed"))) : [h("p", { class: "fine muted rl-pad" }, "No orders yet. Each one your agent tries, allowed or refused, appears here with Troya's signature.")];
    clear(body, h("div", { class: "rl-grid" }, h("div", { class: "rl-col" }, form, setup()),
      h("section", { class: "panel rl-log" }, h("div", { class: "rg-h" }, h("h2", {}, "Audit log"), h("span", { class: "fine muted" }, "every decision signed by Troya")), h("ul", { class: "rl-list" }, rows))));
  }

  const off = onWallet(() => { if (alive) refresh(); });
  refresh();
  const tm = setInterval(() => { if (document.visibilityState === "visible" && wallet.session) refresh(); }, 30_000);
  return () => { alive = false; off(); clearInterval(tm); };
}
