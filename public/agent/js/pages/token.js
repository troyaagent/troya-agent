// Token detail (#/token/<address>): price, chart, stats, holders, trades, links. Since V8 F41 it is the War Table:
// Watchfire's live board (labelled trades, early buyers, holder tags), instant trades and chart marks (wartable.js).
import { h, clear, useCss, icon, tokenIcon, padLogo, tiny, price, usd, compact, pctEl, short, ago, copyText, tabs, seg, emptyState } from "../ui.js";
import { api, cached } from "../api.js";
import { padName, ethAmount, ageText } from "../marketlib.js";
import { startBoard, watchfirePanel, tradePanel, renderTrades, renderEarly, chartMarks, tagEl, renderCallouts, calloutLayer, tributePanel } from "./wartable.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = (x) => String(x || "").toLowerCase();

export async function mount(view, { parts, go }) {
  useCss("home");
  useCss("market");
  const address = String(parts[0] || "").toLowerCase();
  const back = h("a", { class: "tk-back", href: "#/market" }, "← Market");
  if (!ADDR.test(address)) {
    clear(view, back, emptyState("That is not a token address.", "Token pages need a 0x… contract address on Robinhood Chain.", h("a", { class: "link", href: "#/market" }, "Back to the market")));
    return;
  }
  const slow = h("p", { class: "fine muted", style: { margin: "14px 0 0" } });
  clear(view, back, h("div", { style: { padding: "40px 0" } }, h("div", { class: "sk", style: { height: "52px", width: "320px", marginBottom: "18px" } }), h("div", { class: "sk", style: { height: "380px" } }), slow));
  const slowT = setTimeout(() => { slow.textContent = "Still reading this coin from GeckoTerminal and the chain. A coin nobody opened lately can take up to half a minute."; }, 6000);

  let d;
  try { d = await api.get(`market/robinhood/token?address=${address}`); clearTimeout(slowT); }
  catch (e) {
    clearTimeout(slowT);
    clear(view, back, emptyState(e.status === 404 ? "This token is not on the Robinhood Chain board yet." : "The token could not be loaded.", e.message,
      h("div", { class: "row" }, h("a", { class: "link", href: "#/market" }, "Back to the market"), h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/token/${address}`, target: "_blank", rel: "noopener" }, "Look it up on Blockscout ↗"))));
    return;
  }
  const t = d.token;
  const pons = d.pons;
  document.title = `${t.name && t.name !== t.symbol ? `${t.name} ($${t.symbol})` : `$${t.symbol}`} · Troya Agent`;
  let launch = null;
  try { const b = await cached("launch/board", 60000); launch = [...(b.new || []), ...(b.almost || []), ...(b.migrated || [])].find((x) => lc(x.token) === address) || null; } catch {}
  // a stock token's metadata carries Robinhood's own accounts; on a page named after the company they read as its accounts
  const rhOwn = (u) => { try { const x = new URL(/^https?:/i.test(u) ? u : `https://${u}`); return /(^|\.)robinhood\.com$/i.test(x.hostname) || (/(^|\.)(twitter|x)\.com$/i.test(x.hostname) && /^\/robinhood/i.test(x.pathname)); } catch { return /robinhood/i.test(String(u)); } };
  if (t.stock) for (const k of ["website", "twitter", "telegram", "discord"]) if (t[k] && rhOwn(t[k])) t[k] = null;
  let chart = null, ro = null, chartStop = false;

  const head = h("div", { class: "tk-head" },
    h("div", { class: "tk-id" }, tokenIcon({ ...t, chain: "robinhood" }),
      h("div", { style: { minWidth: 0 } },
        h("h1", {}, t.name || t.symbol, h("span", { class: "sym" }, `$${t.symbol}`), t.stock ? h("span", { class: "badge-s pad-badge" }, padLogo("stocks", 14), "Tokenized stock") : h("span", { class: "badge-s pad-badge" }, padLogo(t.launchpad, 14), padName(t.launchpad)),
          pons ? h("span", { class: `badge-s ${pons.graduated ? "blue" : ""}` }, pons.graduated ? "Graduated" : `Curve ${pons.progressPct != null ? pons.progressPct.toFixed(1) : "?"}%`) : null,
          !t.tradable ? h("span", { class: "badge-s warn" }, "Not routed by Troya") : null),
        h("div", { class: "tk-addr" }, h("span", { class: "mono tk2-ca" }, address), h("button", { type: "button", "aria-label": "Copy address", onclick: () => copyText(address, "Address copied") }, icon("copy"))),
        socialRow(t))),
    h("div", { class: "tk-px" },
      h("div", { class: "p" }, t.priceUsd != null ? `$${price(t.priceUsd)}` : pons?.priceInPair != null ? `${tiny(pons.priceInPair)} ${pons.pair.symbol}` : "No price yet"),
      h("div", { class: "u" }, t.priceEth != null ? `${tiny(t.priceEth)} ETH` : null, pctEl(t.change24h), h("span", { class: "faint" }, "24h"))));

  const actions = h("div", { class: "tk-act" },
    h("a", { class: "btn primary", href: `#/swap?out=${address}` }, icon("swap"), "Buy with Troya Swap"),
    h("a", { class: "btn", href: `#/gate/${address}` }, icon("shield"), "Run the Gate"),
    h("a", { class: "btn", href: `#/agent?q=${encodeURIComponent(`Give me a read on ${t.symbol} (${address}) on Robinhood Chain: liquidity, contract risk and recent flow.`)}` }, icon("spark"), "Ask about it"),
    h("button", { class: "btn", type: "button", onclick: () => copyText(address, "Address copied") }, icon("copy"), "Copy address"),
    // V8 F42 Herald: share cards (Gate verdict + Watchfire) with the viewer's referral link, drawn in the browser
    h("button", { class: "btn", type: "button", onclick: () => import("../sharecard.js").then((m) => m.openShare({ address, symbol: t.symbol, stock: !!(t.stock || t.hub) })).catch((e) => console.error(e)) }, icon("ext"), "Share"));

  // chart
  const chartBox = h("div", { class: "tk-chart" });
  let interval = "1h";
  const ivSeg = seg(["5m", "15m", "1h", "4h", "1d"], interval, (v) => { interval = v; loadChart(); });
  const IV_SECS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  let candleSeries = null, candleTimes = [], board = null, calls = null, placeCalls = null;
  const applyMarks = () => { try { candleSeries?.setMarkers(chartMarks(board, candleTimes, IV_SECS[interval] || 3600)); } catch { /* chart gone */ } };
  const chartSrc = h("span", { class: "fine" });
  const chartPanel = h("section", { class: "panel" }, h("div", { class: "tk-chart-bar" }, ivSeg, chartSrc), chartBox);

  const C = 2 * Math.PI * 50;
  const gRing = h("span", { class: "dk-ring tk2-ring" });
  gRing.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ra" cx="60" cy="60" r="50"/><circle class="rb" cx="60" cy="60" r="50" style="stroke-dasharray:0 ${C}"/></svg><b>…</b>`;
  const gVerdict = h("span", { class: "dk-v" }, "Checking"), gNote = h("p", { class: "fine", style: { margin: "6px 0 0" } }, "A simulated buy and a test sell from a fresh address, the same checks Swap runs.");
  const gList = h("ul", { class: "tk2-checks" });
  const gateCard = h("section", { class: "panel tk2-gate" },
    h("div", { class: "panel-h" }, h("h2", {}, "Troya Gate"), h("a", { class: "link fine", href: `#/gate/${address}` }, "Full result")),
    h("div", { class: "tk2-gate-b" }, gRing, h("div", {}, gVerdict, gNote)), gList,
    h("a", { class: "btn primary tk2-buy", href: `#/swap?out=${address}` }, icon("swap"), `Buy $${t.symbol} with Troya Swap`),
    h("div", { class: "tk2-also" }, h("span", { class: "fine muted" }, "Also on"),
      t.launchpad === "pons" ? h("a", { class: "tk2-ext", href: `https://ponsfamily.com/launchpad/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/pons.svg", alt: "" }), "Pons") : null,
      h("a", { class: "tk2-ext", href: `https://fomo.family/tokens/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/fomo.png", alt: "" }), "Fomo"),
      h("a", { class: "tk2-ext", href: `https://dexscreener.com/robinhood/${address}`, target: "_blank", rel: "noopener" }, h("img", { src: "/img/logos/dexscreener.png", alt: "" }), "DEX Screener")));
  let ctxGate = "", ctxNote = "";
  const tell = (gateLine) => { if (gateLine != null) ctxGate = gateLine; dispatchEvent(new CustomEvent("troya:ctx", { detail: { text: `Token page for $${t.symbol} (${address})${t.stock ? ", a Robinhood stock token" : ""}: price ${t.priceUsd != null ? "$" + tiny(t.priceUsd) : "unknown"}, 24h ${t.change24h != null ? t.change24h.toFixed(1) + "%" : "?"}, liquidity ${t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : "?"}, 24h volume ${t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : "?"}, holders ${t.holders ?? "?"}, launchpad ${t.launchpad || "?"}. ${ctxGate} ${ctxNote}`.trim() } })); };
  tell();
  api.get(`/api/badge/${address}`).then((r) => {
    const checks = r.checks || [];
    tell(`Troya Gate: ${r.verdict}; ${checks.map((c) => `${c.label} ${c.status}`).join(", ")}.`);
    if (!checks.length) { gVerdict.textContent = r.verdict === "untested" ? "No buyers yet" : "Not checked yet"; return; }
    const pass = checks.filter((c) => c.status === "pass").length;
    gRing.className = `dk-ring tk2-ring v-${r.verdict}`;
    gRing.querySelector("b").textContent = `${pass}/${checks.length}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { gRing.querySelector(".rb").style.strokeDasharray = `${(pass / checks.length) * C} ${C}`; }));
    gVerdict.className = `dk-v v-${r.verdict}`;
    gVerdict.textContent = { passed: "Passed", caution: "Caution", failed: "Failed", untested: "No buyers yet" }[r.verdict] || r.verdict;
    if (r.verdict === "untested") gNote.textContent = `Nobody has bought on the curve yet, so the test sell waits for the first buy.${r.checkedAt ? ` Checked ${ago(r.checkedAt)} ago.` : ""}`;
    else if (r.checkedAt) gNote.textContent = `Checked ${ago(r.checkedAt)} ago. A snapshot, never a safe stamp.`;
    clear(gList, checks.map((c) => h("li", { class: `c-${c.status}` }, h("span", { class: "dk-ck" }, c.status === "pass" ? icon("check") : c.status === "fail" ? icon("close") : h("b", {}, c.status === "warn" ? "!" : "–")), h("span", {}, c.label))));
  }).catch(() => { gVerdict.textContent = "Gate unavailable"; });

  const stat = (k, v) => h("div", {}, h("div", { class: "k" }, k), h("div", { class: "v" }, v ?? "–"));
  const stats = h("section", { class: "panel tk-stats" },
    t.stock
      ? h("div", { title: `Value of the ${t.symbol} tokens on Robinhood Chain, not ${String(t.name || t.symbol).replace(/\s•.*$/, "")}'s market cap` }, h("div", { class: "k" }, "Tokenized on chain"), h("div", { class: "v" }, t.mcapUsd > 0 ? `≈ ${usd(t.mcapUsd, { compact: true })}` : "–"))
      : stat("Market cap", t.mcapUsd > 0 ? `≈ ${usd(t.mcapUsd, { compact: true })}` : t.mcapEth > 0 ? ethAmount(t.mcapEth) : null),
    stat("Liquidity", t.liquidityUsd != null ? usd(t.liquidityUsd, { compact: true }) : null),
    stat("24h volume", t.volume24hUsd != null ? usd(t.volume24hUsd, { compact: true }) : null),
    stat("Trades 24h", t.txns24h != null ? h("span", {}, compact(t.txns24h, 1), t.buys24h != null ? h("small", { class: "tk2-sub" }, `${compact(t.buys24h, 1)} buys`) : null) : null),
    stat("Holders", t.holders != null ? compact(t.holders, 1).replace(/\.0(?=[KMB]$)/, "") : null),
    stat("Top 10 hold", t.top10Pct != null ? `${Number(t.top10Pct).toFixed(1)}%` : null),
    pons && !pons.graduated ? stat("Curve raised", `${!(pons.raised >= 1e-6) ? "0" : pons.raised < 1 ? (+pons.raised).toFixed(4) : tiny(pons.raised)} / ${tiny(pons.threshold)} ${pons.pair.symbol}`) : stat("1h change", t.change1h != null ? pctEl(t.change1h) : null),
    stat("Age", launch?.at ? ageText(launch.at) : t.createdAt ? ageText(t.createdAt) : null));

  const info = h("section", { class: "panel tk-info" },
    t.description ? h("p", { style: { margin: 0 } }, t.description) : null,
    h("div", { class: "rows", style: { margin: 0 } },
      launch?.creator ? h("div", {}, h("span", {}, "Creator"), h("span", { class: "mono" }, short(launch.creator, 4))) : null,
      pons && (!launch?.creator || lc(launch.creator) !== lc(pons.deployer)) ? h("div", {}, h("span", {}, launch?.creator ? "Deployed by" : "Creator"), h("span", { class: "mono" }, short(pons.deployer, 5))) : null,
      pons ? h("div", {}, h("span", {}, "Tax"), h("span", {}, `${Number((1 + (pons.fees.creatorTaxBps || 0) / 100).toFixed(2))}% per trade: 1% Pons fee (0.7% creator, 0.3% Pons)${pons.fees.creatorTaxBps ? ` + ${Number((pons.fees.creatorTaxBps / 100).toFixed(2))}% creator tax` : ""}`)) : null,
      pons ? h("div", {}, h("span", {}, "Curve pair"), h("span", {}, pons.pair.symbol)) : null,
      t.poolDex ? h("div", {}, h("span", {}, "Main pool"), h("span", {}, dexName(t.poolDex))) : null,
      t.pools?.length > 1 ? h("div", {}, h("span", {}, "Pools"), h("span", {}, String(t.pools.length))) : null),
    h("div", { class: "links" },
      t.website ? h("a", { class: "link", href: safeUrl(t.website), target: "_blank", rel: "noopener nofollow" }, "Website ↗") : null,
      t.twitter ? h("a", { class: "link", href: safeUrl(t.twitter), target: "_blank", rel: "noopener nofollow" }, "X ↗") : null,
      t.telegram ? h("a", { class: "link", href: safeUrl(t.telegram), target: "_blank", rel: "noopener nofollow" }, "Telegram ↗") : null,
      d.links.pons ? h("a", { class: "link", href: d.links.pons, target: "_blank", rel: "noopener" }, "Pons ↗") : null,
      h("a", { class: "link", href: d.links.dexscreener, target: "_blank", rel: "noopener" }, "DexScreener ↗"),
      h("a", { class: "link", href: d.links.geckoterminal, target: "_blank", rel: "noopener" }, "GeckoTerminal ↗"),
      h("a", { class: "link", href: d.links.explorer, target: "_blank", rel: "noopener" }, "Blockscout ↗")),
    h("p", { class: "fine", style: { margin: 0 } }, `Data: ${d.sources.join(" + ")}. This page is information, not a safety check. Ask the agent for a contract health read before trading.`));

  // activity / holders tabs (only where a source serves them)
  const tabList = [{ value: "trades", label: "Trades" }, { value: "callouts", label: "Callouts and X" }, { value: "holders", label: "Holders" }, { value: "early", label: "Early buyers" }, { value: "activity", label: "Activity (USD)" }];
  // V8 F41 stage 2: callouts (stamped at the price of the moment, graded at 24 h) and posts on X about this contract
  const loadCalls = async () => { try { calls = await api.get(`/api/callouts/${address}`); placeCalls?.(); if (curTab === "callouts") renderTab("callouts"); } catch { /* next round */ } };
  const tabBody = h("div", {}, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Reading this coin's trades…")));
  let curTab = "trades", tradeFilter = "all";
  const tabsEl = tabs(tabList, "trades", (v) => renderTab(v));
  function renderTab(v) {
    curTab = v;
    if (v === "trades") { renderTrades(tabBody, board, tradeFilter, (f) => { tradeFilter = f; renderTab("trades"); }, t.symbol); return; }
    if (v === "early") { renderEarly(tabBody, board); return; }
    if (v === "callouts") { if (!calls) { clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading callouts and posts on X…"))); loadCalls(); return; } renderCallouts(tabBody, calls, address, t.symbol, loadCalls); return; }
    if (v === "activity") {
      if (!d.trades) { clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading recent trades…"))); return; }
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "Time"), h("th", { class: "l" }, "Side"), h("th", {}, "USD"), h("th", {}, t.symbol), h("th", { class: "l" }, "Trader"))),
        h("tbody", {}, d.trades.map((x) => h("tr", {},
          h("td", { class: "l muted" }, `${ago(x.t)} ago`),
          h("td", { class: `l ${x.side === "buy" ? "tk-trade-buy" : "tk-trade-sell"}` }, x.side === "buy" ? "Buy" : "Sell"),
          h("td", {}, x.usd != null ? usd(x.usd, { compact: x.usd >= 1e4 }) : "–"), h("td", {}, x.tokens != null ? compact(x.tokens, 2) : "–"),
          h("td", { class: "l mono muted" }, h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/tx/${x.tx}`, target: "_blank", rel: "noopener" }, short(x.trader, 4))))))))),
        h("p", { class: "fine" }, "Most recent trades in the main pool, from GeckoTerminal."));
    } else if (!d.holders) {
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, "Loading the largest wallets…")));
      api.get(`market/robinhood/holders?address=${address}`).then((r) => {
        const creator = lc(launch?.creator || pons?.deployer || "");
        d.holders = (r.holders || []).map((x) => ({ ...x, isCreator: lc(x.address) === creator }));
        d.holdersCount = r.count; d.holdersTop10 = r.top10; d.holdersSource = r.source || "Blockscout"; d.holdersNote = r.note || null;
        renderTab("holders");
      }).catch((e) => clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, e.message))));
    } else if (!d.holders.length) {
      // the per-wallet list is unavailable (Blockscout paused): the live count and top-10 share, said plainly
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" },
        h("b", {}, d.holdersCount != null ? `${d.holdersCount.toLocaleString("en-US")} holders` : "Holders"),
        d.holdersTop10 != null ? h("div", {}, `The 10 largest wallets hold ${Number(d.holdersTop10).toFixed(1)}% of the supply.`) : null,
        h("div", { class: "fine" }, d.holdersNote || "The list of top wallets is unavailable right now."))));
    } else {
      const max = Math.max(...d.holders.map((x) => x.pct || 0), 1);
      clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { class: "l" }, "#"), h("th", { class: "l" }, "Holder"), h("th", {}, "Balance"), h("th", {}, "Share"))),
        h("tbody", {}, d.holders.map((x, i) => h("tr", {},
          h("td", { class: "l rank" }, i + 1),
          h("td", { class: "l mono" }, h("a", { class: "link", href: `https://robinhoodchain.blockscout.com/address/${x.address}`, target: "_blank", rel: "noopener" }, short(x.address, 5)),
            x.isCreator ? h("span", { class: "pad-tag warn" }, "dev / creator") : null, x.label ? h("span", { class: "pad-tag" }, x.label) : x.contract ? h("span", { class: "pad-tag" }, "contract") : null,
            ...((board?.holders || []).find((y) => lc(y.wallet) === lc(x.address))?.tags || []).filter((k) => k !== "whale").map(tagEl)),
          h("td", {}, x.balance != null ? compact(x.balance, 2) : "–"),
          h("td", {}, x.pct != null ? `${x.pct.toFixed(2)}%` : "–", h("span", { class: "tk-bar", style: { width: `${Math.max(2, ((x.pct || 0) / max) * 60)}px` } })))))))),
        h("p", { class: "fine" }, `The ${d.holders.length} largest of ${d.holdersCount != null ? d.holdersCount.toLocaleString("en-US") : "all"} holders, from ${d.holdersSource || "Blockscout"}. Pools, lockers and the dead address are labelled; they are not people.`));
    }
  }
  function loadTrades() {
    const ac = new AbortController();
    const msg = (text, retry) => { if (curTab === "activity") clear(tabBody, h("div", { class: "panel mk-panel" }, h("div", { class: "empty" }, text, retry ? h("button", { class: "btn sm", type: "button", onclick: loadTrades }, icon("refresh"), "Try again") : null))); };
    const slowT = setTimeout(() => msg("Still loading recent trades from GeckoTerminal. Busy coins can take up to a minute."), 8000);
    const stopT = setTimeout(() => ac.abort(), 60000);
    api.get(`market/robinhood/trades?address=${address}`, { signal: ac.signal }).then((r) => {
      if (chartStop) return;
      d.trades = r.trades || [];
      if (curTab === "activity") renderTab("activity");
    }).catch((e) => { if (!chartStop) msg(e.name === "AbortError" ? "Recent trades are taking too long to load." : "Recent trades are unavailable right now.", true); })
      .finally(() => { clearTimeout(slowT); clearTimeout(stopT); });
  }
  loadTrades();

  // F21: the chart oracle's latest note for this coin, when Troya has written one
  const orcCard = h("div", { hidden: true });
  api.get(`/api/oracle/coin/${address}`).then((r) => {
    const n = r?.note;
    if (!n || !n.text) return;
    const lean = { up: "Leaning up", down: "Leaning down", sideways: "Sideways" }[n.call] || n.call;
    const span = n.resistance - n.support, pos = span > 0 ? Math.max(0, Math.min(1, (n.price - n.support) / span)) : 0.5;
    const dot = h("i", { style: { left: `${(pos * 100).toFixed(1)}%` } });
    orcCard.replaceWith(h("section", { class: `panel tk2-orc orc-${n.call}` },
      h("div", { class: "panel-h" }, h("h2", {}, "Chart note"), h("span", { class: "tk2-lean" }, lean)),
      h("p", { class: "tk2-orc-t" }, n.call === "up" ? `Leaning up toward $${tiny(n.resistance)}, support at $${tiny(n.support)}.` : n.call === "down" ? `Leaning down toward $${tiny(n.support)}, resistance at $${tiny(n.resistance)}.` : `Sideways between $${tiny(n.support)} and $${tiny(n.resistance)} more likely than a break.`),
      h("div", { class: "tk2-orc-r" }, dot),
      h("div", { class: "tk2-orc-e fine muted" }, h("span", {}, "$" + tiny(n.support)), h("span", {}, "$" + tiny(n.price) + " then"), h("span", {}, "$" + tiny(n.resistance))),
      h("p", { class: "fine muted tk2-orc-w" }, (n.why || []).join(" · ")),
      h("p", { class: "fine tk2-orc-f" }, `Written ${ago(n.at)}, graded 24 hours later in public. `, h("a", { class: "link", href: "/record#chart-oracle" }, "Every note"))));
    ctxNote = `Troya's chart note (${lean}, graded in public 24 h later): ${n.text}`; tell();
  }).catch(() => {});

  const wfCard = watchfirePanel();
  const trCard = t.stock || t.hub ? null : tributePanel(address);
  const tradeCard = t.tradable || pons ? tradePanel(t, address) : null;
  clear(view, back, head, actions,
    h("div", { class: "tk-grid" }, h("div", {}, chartPanel, tabsEl ? h("div", { class: "tk-tabs" }, tabsEl, tabBody) : null), h("div", { class: "tk-side" }, tradeCard, gateCard, wfCard, trCard, orcCard, stats, info)));
  renderTab("trades");
  if (!t.stock && !t.hub) { loadCalls(); }
  const callsT = setInterval(() => { if (!document.hidden && !t.stock && !t.hub) loadCalls(); }, 60_000);
  const stopBoard = t.stock || t.hub ? () => {} : startBoard(address, (b) => {
    board = b; wfCard.update(b);
    if (curTab === "trades" || curTab === "early") renderTab(curTab);
    applyMarks();
  });
  if (t.stock || t.hub) { wfCard.update({ level: "clear", why: ["Stock tokens and core tokens are not memecoins; Watchfire watches coins from launchpads and pools."] }); renderTab("activity"); }
  view.classList.add("tk2");
  const offClass = () => view.classList.remove("tk2");

  let chartSeq = 0;
  async function loadChart() {
    const my = ++chartSeq, ac = new AbortController();
    const wait = h("span", { class: "tk-chart-wait fine muted" });
    clear(chartBox, h("div", { class: "tk-chart-msg" }, h("div", { class: "sk", style: { height: "300px", width: "100%" } }), wait));
    const slowT = setTimeout(() => {
      const quiet = board && board.level !== "loading" && !(board.trades || []).length;
      wait.textContent = quiet ? "No trades on this coin in the last hours; checking GeckoTerminal for older price history…" : "Still loading the price history from GeckoTerminal…";
    }, 6000);
    const stopT = setTimeout(() => ac.abort(), 60000);
    try {
      const c = await api.get(`market/robinhood/candles?address=${address}&interval=${interval}`, { signal: ac.signal });
      clearTimeout(slowT); clearTimeout(stopT);
      if (chartStop || my !== chartSeq) return;
      chartSrc.textContent = `${c.source} · ${c.interval} candles · priced in USD`;
      if (!c.candles?.length || c.candles.length < 2) {
        clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, c.candles?.length ? "Not enough trades for a chart yet" : "No trades yet"), h("span", {}, pons && !pons.graduated ? "The chart starts once a few buys and sells land on the curve." : "The chart starts once a few swaps have been indexed.")));
        return;
      }
      const LW = await import("lightweight-charts");
      if (chartStop) return;
      clear(chartBox);
      try { chart?.remove(); } catch {}
      chart = LW.createChart(chartBox, {
        autoSize: true,
        layout: { background: { type: "solid", color: "transparent" }, textColor: "#748b94", fontFamily: "Instrument Sans, system-ui, sans-serif", fontSize: 11 },
        grid: { vertLines: { color: "rgba(29,45,52,.35)" }, horzLines: { color: "rgba(29,45,52,.35)" } },
        rightPriceScale: { borderColor: "#142026", scaleMargins: { top: 0.12, bottom: 0.22 } },
        timeScale: { borderColor: "#142026", timeVisible: interval !== "1d" },
        crosshair: { mode: 1 },
        localization: { priceFormatter: (p) => (p < 0 ? "" : p < 1e-15 ? "0" : tiny(p, 4)) },
      });
      const candles = chart.addCandlestickSeries({ upColor: "#5fd3ef", downColor: "#ff6b7d", borderVisible: false, wickUpColor: "#5fd3ef", wickDownColor: "#ff6b7d", priceFormat: { type: "custom", formatter: (p) => (p < 0 ? "" : p < 1e-15 ? "0" : tiny(p, 4)), minMove: 1e-12 } });
      const seen = new Set();
      const rows = c.candles.filter((x) => !seen.has(x.time) && seen.add(x.time)).sort((a, b) => a.time - b.time);
      candles.setData(rows.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
      candleSeries = candles; candleTimes = rows.map((x) => x.time); applyMarks();
      placeCalls = calloutLayer(chartBox, chart, candles, () => (calls?.callouts || []).filter((c) => c.at / 1000 >= (candleTimes[0] || 0)));
      if (rows.some((x) => x.volume != null)) {
        const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, color: "rgba(95,211,239,.25)", lastValueVisible: false, priceLineVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(rows.map((x) => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? "rgba(95,211,239,.28)" : "rgba(255,107,125,.28)" })));
      }
      chart.timeScale().fitContent();
    } catch (e) {
      clearTimeout(slowT); clearTimeout(stopT);
      if (chartStop || my !== chartSeq) return;
      clear(chartBox, h("div", { class: "tk-chart-msg" }, h("b", {}, e.name === "AbortError" ? "The chart is taking too long" : "The chart could not load"),
        h("span", {}, e.name === "AbortError" ? "GeckoTerminal has not answered for a minute." : e.message), h("button", { class: "btn sm", type: "button", onclick: loadChart }, icon("refresh"), "Try again")));
    }
  }
  loadChart();
  return () => { chartStop = true; stopBoard(); clearInterval(callsT); offClass(); try { chart?.remove(); } catch {} ro?.disconnect(); };
}

// the coin's own accounts, as buttons (X, Telegram, website, Discord); nothing when the coin lists none
const SOC_PATH = { x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z", telegram: "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z", website: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a8.2 8.2 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4zm.81 2h2.95c.32 1.25.78 2.45 1.38 3.56A8 8 0 0 1 5.07 16zM8.02 8H5.07a8 8 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.02 8zM12 19.96A14.1 14.1 0 0 1 10.09 16h3.82A14.1 14.1 0 0 1 12 19.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm.26 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38a8.2 8.2 0 0 1 0 4z", discord: "M20.32 4.37A19.8 19.8 0 0 0 15.4 2.8a13.9 13.9 0 0 0-.63 1.3 18.3 18.3 0 0 0-5.5 0 13 13 0 0 0-.64-1.3 19.7 19.7 0 0 0-4.92 1.53C.6 9.05-.24 13.6.18 18.1a19.9 19.9 0 0 0 6.03 3.05c.49-.66.92-1.36 1.29-2.1a12.9 12.9 0 0 1-2.03-.97l.5-.39a14.2 14.2 0 0 0 12.06 0l.5.39c-.65.38-1.33.71-2.04.97.37.74.8 1.44 1.29 2.1a19.8 19.8 0 0 0 6.04-3.05c.5-5.22-.84-9.73-3.5-13.73zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42 2.18 1.09 2.16 2.42c0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42s.95-2.42 2.15-2.42 2.18 1.09 2.16 2.42c0 1.34-.95 2.42-2.16 2.42z" };
function socialRow(t) {
  const items = [["x", "X", t.twitter], ["telegram", "Telegram", t.telegram], ["website", "Website", t.website], ["discord", "Discord", t.discord]].filter(([, , u]) => u);
  // a stock token is a tokenized share, not a project with its own socials; WETH and USDG are core tokens
  if (!items.length && t.stock) return h("p", { class: "fine muted tk2-nosoc" }, `Tokenized ${String(t.name || t.symbol || "stock").replace(/\s•.*$/, "")} share on Robinhood Chain, issued through Robinhood.`);
  if (!items.length && t.hub) return h("p", { class: "fine muted tk2-nosoc" }, "A core token of Robinhood Chain, used as a base pair by its pools.");
  if (!items.length) return h("p", { class: "fine muted tk2-nosoc" }, "This coin lists no X, Telegram or website.");
  return h("div", { class: "tk2-soc" }, items.map(([k, label, u]) => {
    const a = h("a", { class: "tk2-soc-a", href: safeUrl(/^https?:/i.test(u) ? u : k === "x" ? `https://x.com/${String(u).replace(/^@/, "")}` : k === "telegram" ? `https://t.me/${String(u).replace(/^@/, "")}` : `https://${u}`), target: "_blank", rel: "noopener nofollow" });
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SOC_PATH[k]}"/></svg>`;
    a.append(label);
    return a;
  }));
}

const DEX = { "uniswap-v3": "Uniswap v3", "uniswap-v4": "Uniswap v4", "uniswap-v2": "Uniswap v2", "pons-v2": "Pons", pons: "Pons", metric: "Metric", ramses: "Ramses", kyberswap: "KyberSwap" };
function dexName(id) {
  const k = String(id || "").toLowerCase().replace(/-robinhood$/, "").replace(/-dex$/, "");
  return DEX[k] || k.split("-").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : "#"; } catch { return "#"; }
}
