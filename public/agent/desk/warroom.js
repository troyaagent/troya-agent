// V9 F52 War Room and F53 Myrmidons (#/warroom): call a fresh launch's fate, challenge Troya's verdict, report a rug.
// Everything comes from GET /api/warroom (server/warroom.mjs); entries are POST /api/warroom/entry from a signed-in wallet.
// No stakes and no money: a public record and reputation only.
import { h, clear, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, signIn, openConnect } from "/agent/js/wallet.js";

function css() {
  if (!document.querySelector("link[data-heelhunt-css]")) document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/heelhunt.css", "data-heelhunt-css": "1" }));
  if (document.querySelector("style[data-warroom]")) return;
  document.head.append(h("style", { "data-warroom": "1" }, `
.wr-open { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.wr-c { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--bg-2); }
.wr-c .fine { display: block; }
.wr-act { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.wr-v { font-size: 11px; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
.wr-v.passed { color: var(--up); border-color: var(--up); } .wr-v.blocked { color: var(--down); border-color: var(--down); }
.wr-form { display: grid; gap: 8px; }
.wr-form input, .wr-form textarea { width: 100%; }
.wr-board { width: 100%; border-collapse: collapse; font-size: 13px; }
.wr-board th, .wr-board td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
.wr-res.right, .wr-res.confirmed { color: var(--up); } .wr-res.wrong, .wr-res.unconfirmed { color: var(--down); }
@media (max-width: 640px) { .wr-c { grid-template-columns: 1fr; } .wr-act { justify-content: flex-start; } }`));
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND = { call: "Call", challenge: "Challenge", rug: "Rug report" };
const SIDE = { survives: "survives its first day", zero: "goes to zero", "should-block": "Troya should have blocked it", "should-pass": "Troya should have passed it" };
const RES = { right: "Right", wrong: "Wrong", confirmed: "Confirmed", unconfirmed: "Not confirmed" };

export async function mount(view) {
  css();
  let alive = true, timer = 0;
  const openBox = h("section", { class: "panel hh-play" });
  const rugBox = h("section", { class: "panel hh-play" });
  const boardBox = h("section", { class: "panel hh-rules" });
  const feedBox = h("section", { class: "panel hh-feed" });

  async function send(body, btn) {
    if (btn) btn.disabled = true;
    try {
      if (!wallet.session) {
        if (!wallet.address) { openConnect(); toast("Connect and sign in, then try again.", "", 4500); return false; }
        await signIn();
      }
      const r = await api.post("/api/warroom/entry", body);
      toast(r.note || "Logged.", "ok", 4000);
      load();
      return true;
    } catch (e) { toast(e.message || String(e), "error", 6000); return false; }
    finally { if (btn) btn.disabled = false; }
  }

  function challengeForm(c, li) {
    const ta = h("textarea", { class: "input", rows: "3", maxlength: "600", placeholder: c.verdict === "passed" ? "Why should Troya have blocked it? Transactions, wallets, what you saw…" : "Why should Troya have let it through?" });
    const go = h("button", { class: "btn sm primary", type: "button" }, "Send challenge");
    go.addEventListener("click", async () => { if (await send({ kind: "challenge", token: c.token, evidence: ta.value }, go)) li.querySelector(".wr-ch")?.remove(); });
    return h("div", { class: "wr-ch wr-form", style: { gridColumn: "1 / -1" } }, ta, go);
  }

  function paint(d) {
    clear(openBox, h("h2", {}, "Call a fresh launch"),
      h("p", { class: "fine" }, "Launches Troya checked in the last 6 hours. Say whether each survives its first day or goes to zero, or challenge Troya's verdict. Graded by Two Fates at 24 hours."),
      d.open.length ? h("ul", { class: "wr-open" }, d.open.map((c) => {
        const li = h("li", { class: "wr-c" });
        const sv = h("button", { class: "btn sm", type: "button" }, "Survives");
        const zr = h("button", { class: "btn sm", type: "button" }, "Goes to zero");
        const ch = h("button", { class: "btn sm", type: "button" }, "Challenge verdict");
        sv.addEventListener("click", () => send({ kind: "call", token: c.token, side: "survives" }, sv));
        zr.addEventListener("click", () => send({ kind: "call", token: c.token, side: "zero" }, zr));
        ch.addEventListener("click", () => { if (!li.querySelector(".wr-ch")) li.append(challengeForm(c, li)); });
        li.append(
          h("div", {}, h("a", { class: "link", href: `#/gate/${c.token}` }, c.symbol ? `$${c.symbol}` : short(c.token)), h("span", { class: `wr-v ${c.verdict}` }, c.verdict === "passed" ? "Troya: passed" : "Troya: blocked"),
            h("span", { class: "fine" }, `checked ${ago(c.at)} ago${c.reason ? ` · ${c.reason.split(":")[0]}` : ""} · open ${(() => { const m = Math.max(0, Math.round((c.closesAt - Date.now()) / 60e3)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; })()} more`)),
          h("div", { class: "wr-act" }, sv, zr, ch));
        return li;
      })) : h("p", { class: "fine" }, "No launch is open right now. New ones appear here as Sentry checks them."));

    const tok = h("input", { class: "input", placeholder: "Coin address (0x…)", spellcheck: "false" });
    const ev = h("textarea", { class: "input", rows: "4", maxlength: "600", placeholder: "On-chain evidence: transaction hashes, wallets, and what they did (for example: 0x… funded 8 wallets that bought in block 1, all sold within 10 minutes)." });
    const go = h("button", { class: "btn primary", type: "button" }, "Report to Troya");
    go.addEventListener("click", async () => { if (await send({ kind: "rug", token: tok.value.trim(), evidence: ev.value }, go)) { tok.value = ""; ev.value = ""; } });
    clear(rugBox, h("h2", {}, "Myrmidons: report a rug"),
      h("p", { class: "fine" }, "Spotted a ring or a rug on any Robinhood Chain coin? Send the on-chain evidence. Troya checks it with its own reads (Two Fates, Heel) for up to 48 hours; confirmed reports count on the board. What wallets did, never who people are."),
      h("div", { class: "wr-form" }, tok, ev, go));

    clear(boardBox, h("h3", {}, "Leaderboard"), h("p", { class: "fine" }, d.points),
      d.leaderboard.length ? h("table", { class: "wr-board" }, h("thead", {}, h("tr", {}, ["Wallet", "Points", "Calls right", "Challenges won", "Rugs confirmed"].map((x) => h("th", {}, x)))),
        h("tbody", {}, d.leaderboard.map((r) => h("tr", {}, h("td", { class: "mono" }, r.wallet), h("td", {}, h("b", {}, String(r.score))), h("td", {}, `${r.right} of ${r.calls}`), h("td", {}, `${r.challengesWon} of ${r.challenges}`), h("td", {}, `${r.rugsConfirmed} of ${r.rugs}`)))))
        : h("p", { class: "fine" }, "Nobody on the board yet. The first graded entries put names here."),
      h("h3", { style: { marginTop: "16px" } }, "Rules"), h("ul", { class: "hh-rl" }, d.rules.map((x) => h("li", {}, x))));

    clear(feedBox, h("h3", {}, "Every entry, in the open"),
      d.entries.length ? h("ol", { class: "hh-list" }, d.entries.map((e) => h("li", { class: "hh-a" },
        h("div", { class: "hh-a-h" }, h("b", { class: "mono" }, e.wallet), h("span", { class: "fine" }, `${KIND[e.kind]} · ${ago(e.at)} ago`),
          h("a", { class: "link fine", href: `#/gate/${e.token}` }, e.symbol ? `$${e.symbol}` : short(e.token)),
          e.result ? h("span", { class: `wr-res ${e.result}` }, RES[e.result] || e.result) : h("span", { class: "fine" }, e.status === "void" ? "Void" : "Open")),
        e.side ? h("p", { class: "hh-q" }, SIDE[e.side] || e.side) : null,
        e.evidence ? h("p", { class: "hh-r" }, e.evidence) : null,
        e.note ? h("p", { class: "hh-r" }, h("small", {}, "Troya: "), e.note) : null))) : h("p", { class: "fine" }, "No entries yet."));
  }

  async function load() {
    try { const d = await api.get("/api/warroom"); if (alive) paint(d); }
    catch (e) { if (alive) clear(openBox, h("div", { class: "alert error" }, e.message)); }
  }

  clear(view, h("div", { class: "dk hh-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · War Room"),
      h("h1", {}, "Prove Troya ", h("em", {}, "wrong"), "."),
      h("p", { class: "dk-sub" }, "Call a launch's fate, challenge any Troya verdict, or report a rug with on-chain proof. Everything is graded in public by the same 24-hour clock. A scorecard, not a betting market: no stakes, no money.")),
    openBox, rugBox, boardBox, feedBox));
  load();
  timer = setInterval(() => { if (alive && document.visibilityState === "visible") load(); }, 60_000);
  return () => { alive = false; clearInterval(timer); };
}
