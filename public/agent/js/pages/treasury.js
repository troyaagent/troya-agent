// V8 F46 Treasury (#/treasury): $TROYA holder tiers and what each unlocks today: Watchfire pins (live watch, fires to
// your inbox and Telegram), Gate checks a day, and the 1M perks. Pro plans show their prices once the team sets them.
import { h, clear, useCss, icon, toast, short, compact } from "../ui.js";
import { api } from "../api.js";
import { wallet, openConnect } from "../wallet.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

export async function mount(view) {
  useCss("home");
  document.title = "Treasury · Troya Agent";
  const body = h("div", { class: "ts" });
  clear(view, h("section", { class: "ts-hero" }, h("span", { class: "eyebrow fine" }, "V8 · Treasury"), h("h1", {}, "The King's Treasury"),
    h("p", { class: "muted" }, "Hold $TROYA, climb the tiers. Every tier unlocks things that work today: Watchfire pins that alert you the moment a dump pattern starts, more Gate checks a day, and from 1,000,000 $TROYA the holder perks. Counted across your signed-in wallet and its Agent Wallet.")), body);
  let stop = false;
  async function load() {
    const [t, pins] = await Promise.all([api.get("/api/treasury").catch(() => null), wallet.session ? api.get("/api/treasury/pins").catch(() => null) : null]);
    if (stop) return;
    if (!t) { clear(body, h("div", { class: "panel" }, h("div", { class: "empty" }, "The Treasury is unavailable right now."))); return; }
    const you = t.you;
    const yourCard = !wallet.session
      ? h("section", { class: "panel ts-you" }, h("div", {}, h("b", {}, "Your tier"), h("p", { class: "fine muted" }, "Sign in to see your tier, your balance and your pins.")), h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"))
      : h("section", { class: "panel ts-you" },
        h("div", {}, h("small", { class: "fine muted" }, "Your tier"), h("h2", {}, you?.name || "Visitor"),
          h("p", { class: "fine muted" }, you?.known ? `${compact(you.balance || 0, 2)} $TROYA counted.${you.next ? ` ${compact(you.next.min - you.balance, 2)} more for ${you.next.name}.` : " The top tier."}` : "Your balance could not be read right now.")),
        you?.next ? h("div", { class: "ts-bar", title: `${you.name} → ${you.next.name}` }, h("i", { style: { width: `${Math.max(2, Math.min(100, ((you.balance || 0) / you.next.min) * 100)).toFixed(1)}%` } })) : null,
        h("a", { class: "btn", href: `#/swap?out=${CA}` }, icon("swap"), "Buy $TROYA"));
    const tiers = h("section", { class: "panel" }, h("div", { class: "panel-h" }, h("h2", {}, "Tiers"), h("span", { class: "fine muted" }, t.counted)),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Tier"), h("th", {}, "Hold"), h("th", {}, "Watchfire pins"), h("th", {}, "Gate checks a day"), h("th", { class: "l" }, "Holder perks"))),
        h("tbody", {}, t.tiers.map((x) => h("tr", { class: you?.tier === x.key ? "ts-on" : "" },
          h("td", { class: "l" }, h("b", {}, x.name)), h("td", {}, x.min ? `${compact(x.min, 1)} $TROYA` : "–"),
          h("td", {}, String(x.watchfirePins)), h("td", {}, x.gateChecksPerDay != null ? String(x.gateChecksPerDay) : "–"),
          h("td", { class: "l" }, x.perks ? h("span", { class: "wt-tag t-whale" }, "Yes") : h("span", { class: "fine muted" }, "–"))))))),
      h("p", { class: "fine ts-pad" }, t.perks));
    const pinIn = h("input", { class: "wt-in", type: "text", placeholder: "Paste a Robinhood Chain coin address (0x…)", "aria-label": "Coin address to pin" });
    const pinBox = h("section", { class: "panel" }, h("div", { class: "panel-h" }, h("h2", {}, "Watchfire pins"), h("span", { class: "fine muted" }, pins ? `${pins.pins.length} of ${pins.max}` : "")),
      h("p", { class: "fine muted ts-pad" }, "Watchfire watches every transfer of a pinned coin. The moment coins are gathered into one wallet, or one wallet sells 5% of the supply, you get it in your inbox and on Telegram (link Telegram in Portfolio)."),
      wallet.session ? h("div", { class: "wt-row ts-pad" }, pinIn, h("button", { class: "btn sm primary", type: "button", onclick: async () => {
        const v = pinIn.value.trim();
        if (!ADDR.test(v)) return toast("Paste a 0x… coin address.", "warn");
        try { await api.post("/api/treasury/pins", { token: v, on: true }); toast("Pinned. Watchfire is on it.", "ok"); pinIn.value = ""; load(); } catch (e) { toast(e.message, "error"); }
      } }, "Pin")) : null,
      pins?.pins?.length ? h("ul", { class: "sc-list" }, pins.pins.map((p) => h("li", {},
        h("div", {}, h("a", { class: "link mono", href: `#/token/${p.token}` }, short(p.token, 6)), h("div", { class: "fine muted" }, p.state ? `Watchfire: ${p.state.level}${p.state.why?.[0] ? ` · ${p.state.why[0]}` : ""}` : "Reading…")),
        h("button", { class: "btn sm", type: "button", onclick: async () => { try { await api.post("/api/treasury/pins", { token: p.token, on: false }); load(); } catch (e) { toast(e.message, "error"); } } }, "Unpin")))) :
        h("p", { class: "fine muted ts-pad" }, wallet.session ? "No pins yet. Pin a coin here, or from the Watchfire panel on any coin page." : "Sign in to pin coins."));
    const pro = h("section", { class: "panel ts-pro" }, h("div", { class: "panel-h" }, h("h2", {}, "Pro"), h("span", { class: "fine muted" }, "$TROYA or a stablecoin")),
      h("p", { class: "ts-pad" }, t.pro?.note || "Pro plans are listed here with their prices."));
    clear(body, yourCard, tiers, pinBox, pro);
  }
  load();
  return () => { stop = true; };
}
