// V10 F69 Argus, the Sentinel Network (#/argus): signed-in wallets take a watch on a coin, a dev wallet or an agent wallet
// and raise flags with on-chain evidence; Troya checks every flag with its own reads and marks it confirmed or not
// confirmed, with the reason. Everything comes from GET /api/argus, POST /api/argus/watch and POST /api/argus/flag
// (server/argus.mjs). Reputation only: no prize pool, no stakes, no points that turn into money.
import { h, clear, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, signIn, openConnect } from "/agent/js/wallet.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const TK = { coin: "Coin", dev: "Dev wallet", agent: "Agent wallet" };
const ST = { open: "Checking", confirmed: "Confirmed", "not-confirmed": "Not confirmed" };
const targetLink = (t, kind, symbol) => h("a", { class: "link", href: kind === "coin" ? `#/gate/${t}` : `#/heel/${t}` }, symbol ? `$${symbol}` : short(t));

function css() {
  if (document.querySelector("style[data-argus]")) return;
  document.head.append(h("style", { "data-argus": "1" }, `
.ag-page { display: grid; gap: 16px; }
.ag-box { padding: 18px; }
.ag-box h3 { margin: 0 0 8px; font-size: 15px; }
.ag-tot { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.ag-tot div { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); }
.ag-tot small { display: block; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.ag-tot b { font-size: 20px; font-weight: 600; }
.ag-form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; }
.ag-form input, .ag-flag textarea, .ag-flag input { width: 100%; min-width: 0; }
.ag-mine { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.ag-w { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--bg-2); }
.ag-w-act { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.ag-flag { grid-column: 1 / -1; display: grid; gap: 8px; }
.ag-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.ag-tbl th, .ag-tbl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
.ag-tbl th { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); font-weight: 500; }
.ag-flags { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.ag-f { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line-2); border-left: 4px solid var(--line-3); display: grid; gap: 4px; font-size: 13.5px; }
.ag-f.confirmed { border-left-color: var(--up); } .ag-f.not-confirmed { border-left-color: var(--down); } .ag-f.open { border-left-color: var(--warn); }
.ag-f-h { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.ag-chip { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; white-space: nowrap; color: var(--muted); }
.ag-chip.confirmed { color: var(--up); border-color: var(--up); } .ag-chip.not-confirmed { color: var(--down); border-color: var(--down); } .ag-chip.open { color: var(--warn); border-color: var(--warn); }
.ag-f details { font-size: 12.5px; color: var(--muted); }
.ag-f details ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
.ag-rules { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 13.5px; }
@media (max-width: 720px) { .ag-tot { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ag-form { grid-template-columns: 1fr; } .ag-w { grid-template-columns: 1fr; } .ag-w-act { justify-content: flex-start; } .ag-tbl { font-size: 12px; } }`));
}

export async function mount(view) {
  css();
  let alive = true, timer = 0, data = null;
  const totBox = h("div", { class: "ag-tot" });
  const meBox = h("section", { class: "panel ag-box" });
  const watchedBox = h("section", { class: "panel ag-box" });
  const repBox = h("section", { class: "panel ag-box" });
  const flagsBox = h("section", { class: "panel ag-box" });
  const myrBox = h("section", { class: "panel ag-box" });
  const rulesBox = h("section", { class: "panel ag-box" });

  async function ensureSession() {
    if (wallet.session) return true;
    if (!wallet.address) { openConnect(); toast("Connect and sign in, then try again.", "", 4500); return false; }
    await signIn();
    return !!wallet.session;
  }
  async function send(path, body, btn) {
    if (btn) btn.disabled = true;
    try {
      if (!(await ensureSession())) return null;
      const r = await api.post(path, body);
      toast(r.note || "Done.", "ok", 4500);
      await load();
      return r;
    } catch (e) { toast(e.message || String(e), "error", 6000); return null; }
    finally { if (btn) btn.disabled = false; }
  }

  function flagForm(w, li, kinds) {
    const allowed = kinds.filter((k) => k.targets.includes(w.kind));
    const sel = h("select", { class: "input" }, allowed.map((k) => h("option", { value: k.key }, k.label)));
    const ev = h("textarea", { class: "input", rows: "3", maxlength: "800", placeholder: "Evidence: the transaction hashes on Robinhood Chain that show it (0x + 64 hex each, up to 5)." });
    const note = h("input", { class: "input", maxlength: "300", placeholder: "What you saw, in a line (optional). What wallets did, never who people are." });
    const go = h("button", { class: "btn sm primary", type: "button" }, "Raise the flag");
    go.addEventListener("click", async () => { if (await send("/api/argus/flag", { target: w.target, kind: sel.value, evidence: ev.value, note: note.value }, go)) li.querySelector(".ag-flag")?.remove(); });
    return h("div", { class: "ag-flag" }, sel, ev, note, go);
  }

  function paintMe(d) {
    const target = h("input", { class: "input", placeholder: "0x… a coin, a dev wallet or an agent wallet on Robinhood Chain", spellcheck: "false", maxlength: "42" });
    const kind = h("select", { class: "input" }, h("option", { value: "coin" }, "Coin"), h("option", { value: "dev" }, "Dev wallet"), h("option", { value: "agent" }, "Agent wallet"));
    const go = h("button", { class: "btn primary", type: "button" }, "Take a watch");
    go.addEventListener("click", async () => {
      const t = target.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(t)) { toast("Paste an address: 0x and 40 hex characters.", "error", 4000); return; }
      if (await send("/api/argus/watch", { target: t, kind: kind.value }, go)) target.value = "";
    });
    const me = d.me;
    clear(meBox, h("h3", {}, "Your watches"),
      h("p", { class: "fine" }, me ? `Signed in as ${short(me.wallet)}. ${me.watches.length} of ${me.max} watches.` : `Sign in with a wallet to take up to ${d.limits.maxWatches} watches and raise flags on what you watch.`),
      h("div", { class: "ag-form" }, target, kind, go),
      me?.watches?.length ? h("ul", { class: "ag-mine" }, me.watches.map((w) => {
        const li = h("li", { class: "ag-w" });
        const flag = h("button", { class: "btn sm", type: "button" }, "Raise a flag");
        const stop = h("button", { class: "btn sm", type: "button" }, "Stop watching");
        flag.addEventListener("click", () => { if (!li.querySelector(".ag-flag")) li.append(flagForm(w, li, d.kinds)); });
        stop.addEventListener("click", () => send("/api/argus/watch", { target: w.target, on: false }, stop));
        li.append(h("div", {}, targetLink(w.target, w.kind, w.symbol), h("span", { class: "fine" }, ` · ${TK[w.kind]} · since ${ago(w.at)} ago`)), h("div", { class: "ag-w-act" }, flag, stop));
        return li;
      })) : null,
      !me ? h("div", { style: { marginTop: "10px" } }, h("button", { class: "btn", type: "button", onclick: async () => { try { if (await ensureSession()) load(); } catch (e) { toast(e.message || String(e), "error", 5000); } } }, "Sign in")) : null);
  }

  function paint(d) {
    data = d;
    const t = d.totals;
    clear(totBox, [["Sentinels", t.sentinels], ["Watches", t.watches], ["Checking", t.open], ["Confirmed", t.confirmed], ["Not confirmed", t.notConfirmed]].map(([k, n]) => h("div", {}, h("small", {}, k), h("b", {}, String(n || 0)))));
    paintMe(d);
    clear(watchedBox, h("h3", {}, "Watched now"),
      d.watched.length ? h("table", { class: "ag-tbl" }, h("thead", {}, h("tr", {}, ["What", "Kind", "Watchers", "Checking", "Confirmed flags"].map((x) => h("th", {}, x)))),
        h("tbody", {}, d.watched.map((w) => h("tr", {}, h("td", {}, targetLink(w.target, w.kind, w.symbol)), h("td", {}, TK[w.kind] || w.kind), h("td", {}, String(w.watchers)), h("td", {}, String(w.flagsOpen)), h("td", {}, String(w.flagsConfirmed))))))
        : h("p", { class: "fine" }, "Nobody is watching anything yet. The first watch lands here."));
    clear(repBox, h("h3", {}, "Sentinels"), h("p", { class: "fine" }, "Ranked by first confirmed flags, then confirmed flags, then accuracy. Reputation only: no prize pool and no points that turn into money."),
      d.sentinels.length ? h("table", { class: "ag-tbl" }, h("thead", {}, h("tr", {}, ["Wallet", "First", "Seconded", "Not confirmed", "Accuracy", "Checking"].map((x) => h("th", {}, x)))),
        h("tbody", {}, d.sentinels.map((r) => h("tr", {}, h("td", { class: "mono" }, r.wallet), h("td", {}, h("b", {}, String(r.first))), h("td", {}, String(r.seconded)), h("td", {}, String(r.notConfirmed)), h("td", {}, r.accuracyPct != null ? `${r.accuracyPct}%` : "–"), h("td", {}, String(r.open))))))
        : h("p", { class: "fine" }, "No flag has been decided yet, so nobody is ranked."));
    clear(flagsBox, h("h3", {}, "Every flag, in the open"),
      d.flags.length ? h("ol", { class: "ag-flags" }, d.flags.map((f) => h("li", { class: `ag-f ${f.status}` },
        h("div", { class: "ag-f-h" }, h("span", { class: `ag-chip ${f.status}` }, ST[f.status] || f.status), h("b", {}, f.label), targetLink(f.target, f.targetKind, f.symbol),
          h("span", { class: "fine mono" }, f.wallet), h("span", { class: "fine" }, `${ago(f.at)} ago`),
          f.first === true ? h("span", { class: "ag-chip confirmed" }, "First") : f.first === false ? h("span", { class: "ag-chip" }, "Seconded") : null),
        f.note ? h("span", {}, f.note) : null,
        h("span", { class: "fine" }, "Evidence: ", ...f.evidence.flatMap((e, i) => [i ? ", " : "", h("a", { class: "link mono", href: e.url, target: "_blank", rel: "noopener" }, short(e.hash))])),
        f.reason ? h("span", {}, h("small", {}, "Troya: "), f.reason) : f.lastRead ? h("span", { class: "fine" }, `Last read: ${f.lastRead} Checking until ${new Date(f.closesAt).toLocaleString()}.`) : h("span", { class: "fine" }, "Waiting for Troya's first read."),
        f.checks?.length ? h("details", {}, h("summary", {}, "What Troya read"), h("ul", {}, f.checks.map((c) => h("li", {}, `${c.source}: ${c.text}`)))) : null)))
        : h("p", { class: "fine" }, "No flags yet."));
    clear(myrBox, h("h3", {}, "Myrmidons: confirmed rug reports"),
      h("p", { class: "fine" }, "Rug reports from the War Room that Troya's own reads confirmed, shown here read-only. Report a rug in the ", h("a", { class: "link", href: "#/warroom" }, "War Room"), "."),
      d.myrmidons.length ? h("ul", { class: "ag-rules" }, d.myrmidons.map((m) => h("li", {}, h("a", { class: "link", href: `#/gate/${m.token}` }, m.symbol ? `$${m.symbol}` : short(m.token)), ` · reported by ${m.wallet} · ${ago(m.at)} ago${m.note ? ` · ${m.note}` : ""}`)))
        : h("p", { class: "fine" }, "No confirmed rug report yet."));
    clear(rulesBox, h("h3", {}, "Rules"), h("ul", { class: "ag-rules" }, d.rules.map((x) => h("li", {}, x))), h("p", { class: "fine", style: { marginTop: "10px" } }, d.note));
  }

  async function load() {
    try { const d = await api.get("/api/argus"); if (alive) paint(d); }
    catch (e) { if (alive) clear(watchedBox, h("div", { class: "alert error" }, e.message || String(e))); }
  }

  clear(view, h("div", { class: "dk ag-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Argus · V10 Poseidon"),
      h("h1", {}, "A hundred ", h("em", {}, "eyes"), " on the chain."),
      h("p", { class: "dk-sub" }, "Watch a coin, a dev wallet or an agent wallet on Robinhood Chain. When you see the dev moving coins, liquidity pulled, a ring forming or an agent misbehaving, raise a flag with the transaction hashes. Troya checks every flag with its own reads and marks it confirmed or not, in the open. Reputation only, no prize pool.")),
    totBox, meBox, flagsBox, repBox, watchedBox, myrBox, rulesBox));
  load();
  timer = setInterval(() => { if (alive && document.visibilityState === "visible" && !meBox.querySelector(".ag-flag")) load(); }, 60_000);
  return () => { alive = false; clearInterval(timer); };
}
