// About Troya (#/about): what Troya is, in one calm page. Community request, 23 Nov 2026: the big first-visit hero used to
// open the Desk, and on a phone it filled the whole first screen before a single coin showed. People open the app to act,
// so the Desk now opens on the ask bar and the coins, and the introduction lives here, one tap away from the sidebar
// (the "About Troya" link just above the $TROYA chip) and from the Desk's top strip.
// Moved here from desk-home.js: the hero (horse, promise, lead, live numbers, the Gate and flywheel tags) and the
// "What brings you here?" chips, which still reorder the Desk (same key in this browser, nothing else is stored).
import { h, clear, icon, usd, tiny, ago, store, copyText } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { chromeIcon } from "./chrome-icons.js";

const HORSE = "/img/logo-3d-512.webp";
const EXPLORER = "https://robinhoodchain.blockscout.com";
// same list and key as the Desk home (desk-home.js): the choice only reorders the Desk's sections
const INTENTS = [["buy", "Buy a coin"], ["check", "Check a coin"], ["launch", "Launch a coin"], ["perps", "Trade perps"], ["look", "Just looking"]];
const LEADS = { buy: "the coin list", check: "the Gate", launch: "Launch", perps: "the Hyperliquid movers", look: "the coin list" };
const intentPref = store("troya.desk.intent", null);

export async function mount(view) {
  const stops = [];
  let alive = true;
  stops.push(() => { alive = false; });
  const CA = (window.SITE && window.SITE.ca) || "";
  const tile = (ic) => h("span", { class: "d2-tile" }, chromeIcon(ic));
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
  const troyaPx = (n) => `$${tiny(n)}`;
  const ext = { target: "_blank", rel: "noopener" };

  /* ---------- the hero: the horse, the promise, live numbers ---------- */
  const kpi = (label, v, s) => h("div", { class: "d2-kpi" }, h("div", { class: "l" }, label), v, s);
  const kEth = h("div", { class: "v" }, "–"), kEthS = h("div", { class: "s" }, "gas under $0.01");
  const kTro = h("div", { class: "v" }, "–"), kTroS = h("div", { class: "s" }, "on chain, live");
  const kSen = h("div", { class: "v" }, "–"), kSenS = h("div", { class: "s" }, "Sentry calls");
  const kBurn = h("div", { class: "v" }, "–"), kBurnS = h("div", { class: "s" }, "of the 1B minted");
  const tagGateB = h("b", {}, "Troya Gate"), tagGateS = h("small", {}, "$TROYA, checking…");
  const tagFlyB = h("b", {}, "Flywheel"), tagFlyS = h("small", {}, "reading the chain…");
  const hero = h("section", { class: "d2-hero ab-hero", "aria-labelledby": "ab-h" },
    h("div", { class: "d2-beams", "aria-hidden": "true" }),
    h("div", { class: "d2-txt" },
      h("p", { class: "d2-mic" }, h("i", { class: "live-dot" }), "About Troya · Robinhood Chain"),
      h("h1", { id: "ab-h" }, "Every coin", h("br"), h("em", {}, "opened"), h("span", {}, " at the"), h("br"), h("span", {}, "gate.")),
      h("p", { class: "d2-lead" }, "Troya reads the chain, simulates every trade from your own address and tells you what it found, before your wallet signs anything."),
      h("div", { class: "ab-cta" },
        h("a", { class: "btn primary", href: "#/" }, "Open the Desk", icon("arrowRight")),
        h("a", { class: "btn", href: "#/gate" }, "Gate a coin"),
        h("a", { class: "btn ghost", href: "#/start" }, "Start in 60 seconds")),
      h("div", { class: "d2-kpis" }, kpi("ETH", kEth, kEthS), kpi("$TROYA", kTro, kTroS), kpi("Sentry", kSen, kSenS), kpi("Burned", kBurn, kBurnS))),
    h("div", { class: "d2-stage" },
      h("div", { class: "d2-floor", "aria-hidden": "true" }), h("div", { class: "d2-logo-w", "aria-hidden": "true" }, h("img", { class: "d2-logo", src: HORSE, alt: "", width: "512", height: "512", decoding: "async" })),
      h("a", { class: "d2-tag t1", href: CA ? `#/gate/${CA}` : "#/gate" }, tile("verify"), h("span", {}, tagGateB, tagGateS)),
      h("a", { class: "d2-tag t2", href: "#/flywheel" }, tile("flywheel"), h("span", {}, tagFlyB, tagFlyS))));

  async function heroNumbers() {
    if (!alive) return;
    // the burn first, from the light proof read (1,000,000,000 − totalSupply() on chain, cached 5 minutes)
    try { const pb = await api.get("/api/proof/burn"); if (alive && pb?.burnedWhole > 0) { kBurn.textContent = compact(pb.burnedWhole); kBurnS.textContent = `${Number(pb.pctOfMinted).toFixed(2)}% of the 1B minted`; tagFlyB.textContent = `${compact(pb.burnedWhole)} burned`; } } catch {}
    try {
      const f = await api.get("flywheel");
      if (!alive) return;
      if (f.price?.troyaUsd) kTro.textContent = troyaPx(f.price.troyaUsd);
      if (f.burned) { kBurn.textContent = compact(f.burned.total); kBurnS.textContent = `${f.burned.pctOfMinted.toFixed(2)}% of the 1B minted`; tagFlyB.textContent = `${compact(f.burned.total)} burned`; }
      const c = f.totals?.cycles || 0; tagFlyS.textContent = `flywheel · ${c} cycle${c === 1 ? "" : "s"}`;
    } catch { tagFlyS.textContent = "flywheel"; }
    try { const r = await api.get("record?limit=1"); if (alive) { kSen.textContent = String(r.stats.calls); kSenS.textContent = `calls, ${r.stats.graded} graded in public`; } } catch {}
    if (CA) try {
      const b = await api.get(`/api/badge/${CA}`);
      const n = (b.checks || []).length, pass = (b.checks || []).filter((c) => c.status === "pass").length;
      if (alive && n) { tagGateB.textContent = `${pass} / ${n} passed`; tagGateS.textContent = `$TROYA · Gate${b.checkedAt ? `, ${ago(b.checkedAt)}` : ""}`; }
    } catch { tagGateS.textContent = "$TROYA · open the Gate"; }
  }
  async function ethPrice() {
    try { const p = await api.get("price/eth"); if (alive) kEth.textContent = usd(p.usd); } catch { kEthS.textContent = "price unavailable"; }
  }

  /* ---------- how it works: ask, check, sign ---------- */
  const step = (n, ic, t, d) => h("li", { class: "ab-step" }, h("span", { class: "ab-step-n" }, n), tile(ic), h("b", {}, t), h("p", {}, d));
  const how = h("section", { class: "panel ab-how", "aria-labelledby": "ab-how-h" },
    h("div", { class: "panel-h" }, h("h2", { id: "ab-how-h" }, "How Troya works"), h("a", { class: "link fine", href: "/plans", target: "_self" }, "0% Troya fee · your keys")),
    h("ol", { class: "ab-steps" },
      step("1", "chat", "You ask", "Paste a coin address or ask in plain words. No wallet needed to look around."),
      step("2", "gate", "Troya checks", "The Gate reads the coin on chain and simulates your trade from your own address, then says what it found."),
      step("3", "wallet", "You sign", "Your keys, your wallet. Nothing moves without your signature, or your agent's caps and rules.")));

  /* ---------- make the Desk yours: the intent chips that used to sit above the hero ---------- */
  const intentChips = h("div", { class: "chips dk-intent-c", role: "group", "aria-label": "What brings you here?" });
  const intentNote = h("p", { class: "ab-note" });
  const paintIntent = () => {
    const cur = intentPref.get();
    clear(intentChips, INTENTS.map(([k, t]) => h("button", { class: "chip", type: "button", "aria-pressed": String(cur === k), onclick: () => { intentPref.set(cur === k ? null : k); paintIntent(); } }, t)));
    clear(intentNote, cur ? ["The Desk now puts ", h("b", {}, LEADS[cur] || "it"), " first. ", h("a", { class: "link", href: "#/" }, "Open the Desk")] : "Pick one and the Desk puts it first. It is kept in this browser only.");
  };
  paintIntent();
  const yours = h("section", { class: "panel ab-yours", "aria-labelledby": "ab-yours-h" },
    h("div", { class: "panel-h" }, h("h2", { id: "ab-yours-h" }, "What brings you here?")),
    h("div", { class: "ab-body" }, intentChips, intentNote));

  /* ---------- the $TROYA contract ---------- */
  const token = h("section", { class: "panel ab-token", "aria-labelledby": "ab-token-h" },
    h("div", { class: "panel-h" }, h("h2", { id: "ab-token-h" }, "$TROYA contract"), h("span", { class: "fine muted" }, "Robinhood Chain")),
    h("div", { class: "ab-body" },
      CA ? h("button", { class: "ab-ca mono", type: "button", title: "Copy contract address", onclick: () => copyText(CA, "Contract address copied") }, h("span", {}, CA), icon("copy")) : h("p", { class: "muted" }, "The contract address is not live yet."),
      CA ? h("div", { class: "ab-ca-a" },
        h("a", { class: "btn sm", href: `#/gate/${CA}` }, chromeIcon("gate"), "Gate it"),
        h("a", { class: "btn sm", href: "#/flywheel" }, chromeIcon("flywheel"), "Flywheel"),
        h("a", { class: "btn sm ghost", href: `${EXPLORER}/token/${CA}`, ...ext }, "Blockscout", icon("ext"))) : null,
      h("p", { class: "ab-note" }, "Only trust this address. Troya never asks for your seed phrase or private key.")));

  /* ---------- read more ---------- */
  const card = (ic, t, d, href) => h("a", { class: "ab-link", href, ...(href.startsWith("/") ? ext : {}) }, tile(ic), h("span", {}, h("b", {}, t), h("small", {}, d)), h("i", { "aria-hidden": "true" }, href.startsWith("/") ? "↗" : "→"));
  const more = h("section", { class: "ab-links", "aria-label": "Read more" },
    card("docs", "Docs", "How every page works, the Gate, limits and the agent", "#/docs"),
    card("verify", "Safety", "Who holds what, and what Troya can and cannot do", "/safety"),
    card("proof", "Proof", "The burn, the Gate run live, every agent trade with its transaction", "/proof"),
    card("news", "Roadmap", "What is shipped and what is being built", "/roadmap"));

  const SITE = window.SITE || {};
  const social = h("p", { class: "ab-social" }, "Community: ",
    [SITE.telegram ? h("a", { href: SITE.telegram, ...ext }, "Telegram") : null, SITE.x ? h("a", { href: SITE.x, ...ext }, "X") : null,
     /^https:\/\/github\.com\//.test(SITE.github || "") ? h("a", { href: SITE.github, ...ext }, "GitHub") : null,
     h("a", { href: "https://t.me/troyasentry", ...ext }, "Sentry channel")].filter(Boolean).flatMap((a, i) => (i ? [" · ", a] : [a])));

  clear(view, h("div", { class: "ab" }, hero, how, h("div", { class: "ab-cols" }, yours, token), more, social));
  heroNumbers(); ethPrice();
  const t1 = setInterval(heroNumbers, 60000), t2 = setInterval(ethPrice, 15000);
  stops.push(() => { clearInterval(t1); clearInterval(t2); });
  return () => stops.forEach((f) => { try { f(); } catch {} });
}
