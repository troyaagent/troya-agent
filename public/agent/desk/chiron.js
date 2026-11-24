// V9 F48 Chiron (#/chiron and #/chiron/<wallet>): paste any trader wallet, no connecting needed. Chiron reads its own trades
// on Robinhood Chain and names the one habit that cost it most, in one sentence, with the trades behind it; the other habits
// follow, each with its sample size. One tap turns the habit into a rule: "no buys in a coin's first N seconds" and "at most
// N buys a day" are enforced on the server for every buy from the owner's Agent Wallet (server/policy.mjs checkAction);
// the other two are reminders, and the button says so. The numbers come from GET /api/chiron/:address (server/chiron.mjs);
// this page only shows them. It describes habits and never says what to buy or sell.
import { h, clear, icon, short, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, signIn, openConnect } from "/agent/js/wallet.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const STATE = { costly: ["Costs it most", "v-failed"], present: ["Costs it too", "v-caution"], absent: ["Not a costly habit here", "v-passed"], unmeasured: ["Not enough trades to measure", "v-quiet"] };

export function chironCss() {
  if (document.querySelector("link[data-chiron-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/chiron.css", "data-chiron-css": "1" }));
}
const okUrl = (u) => (/^https:\/\/robinhoodchain\.blockscout\.com\//.test(u || "") ? u : null);
export function eth(x) {
  if (x == null || !isFinite(x)) return "–";
  const a = Math.abs(x), d = a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return `${x < 0 ? "−" : ""}${a.toFixed(d).replace(/\.?0+$/, "") || "0"} ETH`;
}
export function pct(r) {
  if (r == null || !isFinite(r)) return "–";
  const p = r * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`;
}
export function dur(ms) {
  if (ms == null || !isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const hr = ms / 3600_000;
  return hr < 48 ? `${hr.toFixed(hr < 10 ? 1 : 0)} h` : `${(hr / 24).toFixed(1)} days`;
}
const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "?");
const n = (x) => Number(x || 0).toLocaleString("en-US");

function evidenceList(list) {
  if (!list?.length) return null;
  return h("ol", { class: "cr-ev" }, list.map((e) => h("li", {},
    okUrl(e.url) ? h("a", { class: "link mono", href: e.url, target: "_blank", rel: "noopener", title: e.tx }, short(e.tx, 6), h("span", { class: "cr-ev-out" }, " on Blockscout")) : h("span", { class: "mono" }, short(e.tx, 6)),
    h("span", { class: "cr-ev-n" }, e.note))));
}

// the button that turns a habit into a rule; honest about what it does
function ruleBox(rule, from, { compact = false } = {}) {
  if (!rule) return null;
  const btn = h("button", { class: `btn ${compact ? "sm" : "primary"}`, type: "button" }, icon(rule.enforced ? "shield" : "check"), rule.enforced ? "Make it a rule" : "Save as a reminder");
  const done = h("span", { class: "cr-rule-done", hidden: true }, icon("check"), "Saved. ", h("a", { class: "link", href: "#/agent/scepter" }, "See it in Agent control"));
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (!wallet.session) {
        if (!wallet.address) { openConnect(); toast("Connect and sign in, then press the button again.", "", 4500); return; }
        await signIn();
      }
      const body = rule.kind === "launch-wait" ? { kind: rule.kind, sec: rule.sec, from } : rule.kind === "daily-buys" ? { kind: rule.kind, n: rule.n, from } : { kind: "note", habit: rule.habit, text: rule.text, from };
      const r = await api.post("/api/chiron/rule", body);
      toast(r?.note || "Saved.", "ok", 7000);
      done.hidden = false;
    } catch (e) { toast(e.message || String(e), "error", 5000); }
    finally { btn.disabled = false; }
  });
  return h("div", { class: `cr-rule${compact ? " compact" : ""}` },
    h("div", { class: "cr-rule-t" },
      h("small", {}, rule.enforced ? "Your rule" : "Your reminder"),
      h("b", {}, rule.label),
      h("p", { class: "fine" }, rule.enforced
        ? "Enforced on the server for every buy from your Agent Wallet: your own taps, Sentry Autopilot, Playbooks, Aegis and Champions; chat tickets show it too. Swaps you sign in your own wallet on Swap are not stopped. You can remove it any time in Agent control."
        : "A reminder, not a block: Troya cannot enforce this one, because it does not hold or close your positions for you. It is shown in Agent control.")),
    h("div", { class: "cr-rule-a" }, btn, done));
}

function habitState(hb, topKey) {
  if (!hb.measured) return "unmeasured";
  if (!hb.present) return "absent";
  return hb.key === topKey ? "costly" : "present";
}
function habitCard(hb, r) {
  const st = habitState(hb, r.top);
  const [label, cls] = STATE[st];
  const sample = Object.entries(hb.sample || {}).map(([k, v]) => `${SAMPLE[k] || k} ${n(v)}`).join(" · ");
  return h("article", { class: `cr-hb s-${st}` },
    h("div", { class: "cr-hb-h" }, h("b", {}, hb.title), h("span", { class: `dk-v ${cls}` }, label)),
    h("p", { class: "cr-hb-s" }, hb.measured ? `${hb.sentence[0].toUpperCase()}${hb.sentence.slice(1)}.` : `${hb.why[0].toUpperCase()}${hb.why.slice(1)}.`),
    hb.measured && hb.facts?.length ? h("ul", { class: "cr-hb-f" }, hb.facts.map((f) => h("li", {}, `${f}.`))) : null,
    hb.present && hb.key !== r.top ? evidenceList(hb.evidence) : null,
    h("p", { class: "cr-hb-n" }, `Sample: ${sample}`),
    hb.present && hb.key !== r.top ? ruleBox(hb.rule, r.address, { compact: true }) : null);
}
const SAMPLE = { early: "early entries", later: "later entries", unknownLaunch: "launch time unknown", winners: "winners", losers: "losers", days: "active days", busyDays: "busy days", busy: "busy-day trades", quiet: "other-day trades", priced: "later price read" };
const VENUE = { "Pons curve": "Pons curve", "Uniswap v4": "Uniswap v4", "Uniswap v3": "Uniswap v3", "a pool": "another pool", "a router": "a router or aggregator" };

function sampleBox(s) {
  if (!s) return null;
  const lo = s.leftOut || {};
  const left = [[lo.soldBeforeHistory, "sales of coins bought before the history read"], [lo.mixedWithTransfers, "round trips mixed with plain transfers"], [lo.dust, `round trips under 0.0001 ETH`],
    [lo.coinForCoin, "coin-for-coin swaps"], [lo.transfers, "transfers without ETH"], [lo.stockTokens, "stock token transfers"]].filter(([v]) => v > 0);
  return h("details", { class: "cr-sample" },
    h("summary", {}, `What was read: ${n(s.trips)} closed round trips from ${n(s.buys)} buys and ${n(s.sells)} sells across ${n(s.coins)} coins`),
    h("ul", {},
      h("li", {}, `History from ${date(s.window?.from)} to ${date(s.window?.to)}${s.window?.complete ? " (the wallet's whole history)" : ` (the newest ${s.window?.pages ?? "?"} pages of each list; older trades are not read)`}, ${n(s.transactions)} transactions.`),
      h("li", {}, `Open positions not counted: ${n(s.open)}. A round trip opens on a buy while the wallet holds none of the coin and closes once 90% of it has been sold.`),
      s.launchKnown != null ? h("li", {}, `Launch time read for ${n(s.launchKnown)} of ${n(s.trips)} round trips (from the chain: the block the coin was created in${s.pons != null ? `; ${n(s.pons)} are Pons coins, whose creation is their launch` : ""}).`) : null,
      Object.keys(s.venues || {}).length ? h("li", {}, `Where the trades went: ${Object.entries(s.venues).map(([k, v]) => `${VENUE[k] || k} ${n(v)}`).join(", ")}.`) : null,
      left.length ? h("li", {}, `Left out: ${left.map(([v, w]) => `${n(v)} ${w}`).join("; ")}.`) : null,
      h("li", {}, `At least ${s.minTrips} closed round trips are needed before Chiron names a habit, and each comparison needs at least 3 trades on each side.`)));
}
function tripsTable(trips) {
  if (!trips?.length) return null;
  return h("details", { class: "cr-trips" },
    h("summary", {}, `The round trips read (newest ${trips.length})`),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl cr-tbl" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Coin"), h("th", { class: "l" }, "Bought"), h("th", {}, "Held"), h("th", {}, "Cost"), h("th", {}, "Result"), h("th", { class: "l" }, "Trades"))),
      h("tbody", {}, trips.map((t) => h("tr", {},
        h("td", { class: "l" }, h("a", { class: "link", href: `#/token/${t.token}` }, `$${t.symbol}`), h("div", { class: "fine muted" }, t.venue ? VENUE[t.venue] || t.venue : "")),
        h("td", { class: "l" }, t.entrySec != null ? `${Math.round(t.entrySec)} s after launch` : t.entryAfter ? "over 5 min after launch" : "launch unknown", h("div", { class: "fine muted" }, date(t.entryAt))),
        h("td", {}, dur(t.holdMs)), h("td", {}, eth(t.costEth)),
        h("td", { class: t.pnlEth > 0 ? "up" : t.pnlEth < 0 ? "down" : "" }, pct(t.ret), h("div", { class: "fine muted" }, eth(t.pnlEth))),
        h("td", { class: "l" }, h("a", { class: "link fine", href: `${EXPLORER}/tx/${t.entryTx}`, target: "_blank", rel: "noopener" }, "buy"), " ", h("a", { class: "link fine", href: `${EXPLORER}/tx/${t.exitTx}`, target: "_blank", rel: "noopener" }, "sell"))))))));
}

export async function mount(view, ctx) {
  chironCss();
  const input = h("input", { class: "input cr-in", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "80", placeholder: "Paste any trader wallet (0x…)", "aria-label": "Trader wallet address" });
  const go = h("button", { class: "btn primary", type: "button" }, icon("search"), "Read its habits");
  const out = h("div", { class: "cr-out", "aria-live": "polite" });
  let alive = true, seq = 0, timer = 0;

  async function run(raw, { again = 0 } = {}) {
    clearTimeout(timer);
    const a = ADDR.exec(String(raw || "").trim())?.[0];
    if (!a) { toast("Paste a wallet address on Robinhood Chain (0x + 40 characters).", "error"); input.focus(); return; }
    const id = ++seq;
    input.value = a;
    if (location.hash !== `#/chiron/${a}`) history.replaceState(null, "", `#/chiron/${a}`);
    if (!again) clear(out, h("div", { class: "cr-wait" }, h("span", { class: "cr-spin" }), h("span", {}, "Reading this wallet's swaps, the launch time of each coin and what each round trip returned…")));
    go.disabled = true;
    let r;
    try { r = await api.get(`/api/chiron/${a}`); }
    catch (e) { if (!alive || id !== seq) return; go.disabled = false; clear(out, h("div", { class: "dk-empty" }, h("b", {}, "Chiron could not read this wallet right now."), h("p", {}, e.message), h("button", { class: "btn sm", type: "button", onclick: () => run(a) }, icon("refresh"), "Try again"))); return; }
    if (!alive || id !== seq) return;
    go.disabled = false;
    if (r.status === "reading") {
      clear(out, h("div", { class: "cr-wait" }, h("span", { class: "cr-spin" }), h("span", {}, r.sentence)));
      if (again < 12) timer = setTimeout(() => { if (alive && id === seq) run(a, { again: again + 1 }); }, 6000);
      return;
    }
    render(a, r);
  }

  function render(a, r) {
    const top = r.habits?.find((x) => x.key === r.top) || null;
    const rest = (r.habits || []).filter((x) => x !== top);
    const s = r.sample;
    const chip = r.status === "done" ? (top ? ["Habit found", "v-failed"] : ["No costly habit found", "v-passed"]) : r.status === "few" ? ["Too few trades", "v-caution"] : r.status === "none" ? ["No trades found", "v-quiet"] : ["Not read", "v-caution"];
    dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Troya Chiron for wallet ${a}: ${r.sentence} ${s ? `Sample: ${s.trips} closed round trips from ${s.buys} buys and ${s.sells} sells.` : ""} Chiron describes habits and never says what to buy.` } }));
    const res = r.results;
    clear(out,
      h("div", { class: "cr-id" },
        h("span", { class: "cr-kind" }, "Trader wallet"),
        h("a", { class: "link mono", href: `${EXPLORER}/address/${a}`, target: "_blank", rel: "noopener" }, short(a, 6)),
        h("span", { class: `dk-v ${chip[1]}` }, chip[0]),
        s ? h("span", { class: "cr-n" }, `${n(s.trips)} closed round trips`) : null),
      h("p", { class: `cr-sentence${top ? " s-top" : ""}` }, r.sentence),
      top ? h("div", { class: "cr-tiles" },
        h("div", { class: "cr-tile" }, h("span", {}, top.upperBound ? "Left on the table (upper bound)" : "What it cost"), h("b", {}, top.costEth != null ? `about ${eth(top.costEth)}` : "not measured"), h("small", {}, top.costPct ? `${(top.costPct * 100).toFixed(0)} percentage points ${top.upperBound ? "of what those sales brought" : "worse than the comparison"}` : "")),
        top.compare?.length === 2 ? h("div", { class: "cr-tile" }, h("span", {}, "Compared"),
          h("b", {}, top.compare.map((c) => (c.ret != null ? pct(c.ret) : dur(c.hold))).join(" vs ")),
          h("small", {}, top.compare.map((c) => `${n(c.n)} ${c.label}`).join(" vs "))) : null,
        res ? h("div", { class: "cr-tile" }, h("span", {}, "All its round trips"), h("b", {}, `${pct(res.returnPct)}`), h("small", {}, `${eth(res.pnlEth)} on ${eth(res.costEth)} · ${Math.round(res.winRate * 100)}% won · median hold ${dur(res.medianHoldMs)}`)) : null) : null,
      top?.facts?.length ? h("ul", { class: "cr-facts" }, top.facts.map((f) => h("li", {}, `${f}.`))) : null,
      top ? h("div", { class: "cr-evb" }, h("h3", {}, "The trades behind it"), evidenceList(top.evidence)) : null,
      top ? ruleBox(top.rule, a) : null,
      !top && res ? h("p", { class: "fine cr-res" }, `All its round trips: ${pct(res.returnPct)} (${eth(res.pnlEth)} on ${eth(res.costEth)}), ${Math.round(res.winRate * 100)}% won, median hold ${dur(res.medianHoldMs)}.`) : null,
      rest.length ? h("section", { class: "cr-rest" }, h("h3", {}, top ? "The other habits Chiron measures" : "The habits Chiron measures"), h("div", { class: "cr-hbs" }, rest.map((x) => habitCard(x, r)))) : null,
      sampleBox(s),
      tripsTable(r.trips),
      h("div", { class: "dk-gate-a cr-acts" },
        h("a", { class: "btn sm", href: `#/portfolio?address=${a}` }, "Its portfolio"),
        h("a", { class: "btn sm", href: `#/heel/${a}`, title: "V9 Heel: the dev passport of this wallet, if it launched coins" }, "Find its weak spot"),
        ctx.ask ? h("button", { class: "btn sm", type: "button", onclick: () => ctx.ask(`Explain this Chiron reading in plain words: ${r.sentence} (${a})`) }, icon("spark"), "Ask Troya") : null),
      h("p", { class: "fine cr-when" }, r.checkedAt ? `Read ${ago(r.checkedAt)} ago from Robinhood Chain. Answers are kept for 30 minutes.` : ""),
      h("p", { class: "note cr-note" }, r.note || "Chiron describes what a wallet's own trades did. It is not advice: it never says what to buy or sell."));
  }

  go.addEventListener("click", () => run(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  input.addEventListener("paste", () => setTimeout(() => { if (ADDR.test(input.value)) run(input.value); }, 0));
  const mine = h("button", { class: "link", type: "button", onclick: () => (wallet.address ? run(wallet.address) : openConnect()) }, "my wallet");

  clear(view, h("div", { class: "dk cr-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Chiron"),
      h("h1", {}, h("em", {}, "One"), " habit, with its cost."),
      h("p", { class: "dk-sub" }, "Paste any trader wallet, no connecting needed. Chiron reads that wallet's own swaps on Robinhood Chain and names the one habit that cost it most: buying in a launch's first minute, holding losers far longer than winners, trading too often, or selling winners early. Every number shows its sample size and links to the trades behind it. Chiron describes habits; it never says what to buy or sell.")),
    h("section", { class: "panel cr-panel" },
      h("div", { class: "cr-form" }, input, go),
      h("p", { class: "fine cr-try" }, "Try ", mine, ", or any wallet that trades on Robinhood Chain."),
      out)));

  const start = ctx.parts?.[0] || ctx.query?.address || "";
  if (ADDR.test(start)) run(start);
  else setTimeout(() => input.focus(), 30);
  return () => { alive = false; clearTimeout(timer); };
}
