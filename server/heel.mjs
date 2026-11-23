// V9 F47 Heel: paste a coin, a dev wallet or an agent; Troya names its single most dangerous weak spot in one sentence,
// with up to three facts that each carry their on-chain evidence, a confidence label and one Guard action.
// Heel measures nothing new. It reads the modules that already do, and their caches:
//   coin   Troya Gate (badge.mjs → sentry.checkLaunch → robinhood.gateCheck, a 0.01 ETH buy), token health (bytecode),
//          The Assay (assay.mjs), Ring Radar (ringradar.mjs), dev side wallets (devlinks.mjs), Watchfire (watchfire.mjs),
//          Tribute (tribute.mjs), Oath (oath.mjs), and for a Pons coin its dev's passport (below)
//   dev    the dev passport: its Pons launches and what it did with each in the first day (devtrack.mjs launchesOf +
//          coinStory), where its first ETH came from (devtrack.walletAge → assay.fundingOf) and that funder's own launches,
//          the side wallets on its newest coin (devlinks.mjs), a broken Oath in the last 30 days (oath.mjs brokeOath)
//   agent  Allies (allies.mjs): ERC-8004 identity and reputation, Troya's registry, Arena, its launches and their Gate now
// The worst finding is picked in code (RANK below, then confidence, then key): never by a model. The words describe
// behaviour, never people, and every number comes from a module's own read. A source that fails or is still reading is
// listed in `coverage`, never filled in. With HEEL_LLM=1 an LLM may rephrase the sentence from the structured facts; its
// words are kept only when every number in them already appears in those facts, otherwise the template stands.
//   GET  /api/heel/:address     { kind: coin|dev|agent|unknown, heel, severity, confidence, facts:[{text, evidence:{type,ref,url}}],
//                               guard:{label,href,action?}, passport?, coverage, partial, checkedAt }  · cached 5 min (30 s
//                               while a source is still reading; the reads go on in the background)
//   POST /api/heel/watch        { address, on } signed in: watch a dev; its new Pons launches land in the inbox (the loop runs
//                               with HEEL_DEVWATCH=1)
//   GET  /api/heel/watching     signed in: the devs you watch
// Read-only: nothing here trades or moves money.
import { getAddress, isAddress } from "ethers";
import { rpc, tokenMeta, ponsState, tokenHealth } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const WAIT_MS = Math.max(3000, Number(process.env.HEEL_WAIT_MS) || 25_000);   // how long one ask waits for its sources
const TTL_DONE = 5 * 60_000, TTL_PARTIAL = 30_000;
const GATE_ETH = "0.01";                                                     // the badge's buy size (badge.mjs CHECK_ETH)
const FILE = "heel.json";                                                    // watched devs and the launches already seen
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const low = (s) => String(s || "").replace(/^[A-Z](?![A-Z0-9])/, (c) => c.toLowerCase());
const noDot = (s) => String(s || "").trim().replace(/[.\s]+$/, "");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
let store = null;

/* ---------- evidence: every fact points at something anyone can open on Blockscout ---------- */
const EV = {
  tx: (hash, note) => ({ type: "tx", ref: hash, url: `${EXPLORER}/tx/${hash}`, note }),
  contract: (a, note) => ({ type: "contract", ref: getAddress(a), url: `${EXPLORER}/address/${getAddress(a)}?tab=contract`, note }),
  call: (a, note) => ({ type: "eth_call", ref: getAddress(a), url: `${EXPLORER}/token/${getAddress(a)}`, note }),
  logs: (a, note, tab = "token_transfers") => ({ type: "logs", ref: getAddress(a), url: `${EXPLORER}/token/${getAddress(a)}?tab=${tab}`, note }),
  block: (n, note) => ({ type: "block", ref: String(n), url: `${EXPLORER}/block/${n}`, note }),
  address: (a, note) => ({ type: "address", ref: getAddress(a), url: `${EXPLORER}/address/${getAddress(a)}`, note }),
};

/* ---------- the priority engine: worst first, decided here ---------- */
// score 0–100 per finding key. Ties: higher confidence first, then the key (so the same facts always give the same heel).
const RANK = {
  "gate.sell.fail": 100, "gate.tax.fail": 96, "gate.sim.fail": 92, "oath.broken": 90, "assay.lp-pulled.red": 90, "devlinks.selling": 88,
  "watchfire.fire": 86, "dev.out6h.many": 85, "ring.red": 84, "devlinks.fail": 80, "health.blacklist": 78, "health.mint": 76,
  "assay.dev-sold.red": 74, "agent.coins.flag": 74, "tribute.fake": 72, "gate.route.fail": 70, "assay.dev-holds.red": 70,
  "assay.bundle.red": 68, "assay.funder.red": 66, "dev.out6h": 65, "dev.out6h.small": 35, "coin.dev.out.small": 34, "coin.dev.out1h": 74, "coin.dev.out6h": 72, "coin.dev.day1": 60, "assay.cluster.red": 64, "watchfire.red": 62, "gate.fee.fail": 60,
  "dev.funder": 60, "agent.id.flag": 60, "assay.top10.red": 58, "assay.wash.red": 56, "gate.impact.fail": 55, "gate.tax.warn": 52,
  "gate.sell.warn": 50, "health.upgradeable": 50, "gate.sell.empty": 48, "dev.day1": 45, "health.pause": 45, "ring.amber": 45, "devlinks.warn": 44,
  "agent.warn": 40, "assay.dev-sold.amber": 40, "assay.dev-holds.amber": 38, "assay.funder.amber": 28, "assay.bundle.amber": 36,
  "tribute.caution": 36, "assay.cluster.amber": 35, "assay.dev-spread.amber": 34, "assay.wash.amber": 33, "watchfire.amber": 32,
  "gate.fee.warn": 30, "assay.top10.amber": 30, "health.owner": 30, "health.fees": 28, "health.trading": 28, "health.limits": 25,
  "assay.snipe.amber": 15, "agent.none": 10,
};
const CONF = { high: 3, medium: 2, low: 1 };
const levelOf = (s) => (s >= 80 ? "critical" : s >= 55 ? "high" : s >= 30 ? "medium" : s > 0 ? "low" : "none");
const lower1 = (c) => (c === "high" ? "medium" : "low");
/** one finding: key (RANK), heel (the phrase for the sentence), text (the fact), evidence, confidence */
function F(key, { heel, text, evidence, confidence = "high", source }) {
  return { key, score: RANK[key] ?? 20, heel: noDot(heel), text: cap(noDot(text)) + ".", evidence, confidence, source };
}
export function rankFindings(list) {
  return [...list].sort((a, b) => b.score - a.score || CONF[b.confidence] - CONF[a.confidence] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* ---------- sources: each one timed, its outcome kept in coverage ---------- */
async function source(cov, name, fn, { wait = WAIT_MS, running = (v) => false, na = (v) => null } = {}) {
  const t0 = Date.now();
  const r = await Promise.race([Promise.resolve().then(fn).then((v) => ({ v }), (e) => ({ e })), sleep(wait).then(() => ({ timeout: true }))]);
  const ms = Date.now() - t0;
  if (r.timeout) { cov.push({ source: name, status: "running", note: "still reading; it goes on in the background, ask again shortly", ms }); return null; }
  if (r.e) { cov.push({ source: name, status: "failed", note: String(r.e.message || r.e).slice(0, 160), ms }); return null; }
  if (running(r.v)) { cov.push({ source: name, status: "running", note: "still reading; ask again shortly", ms }); return null; }
  const why = na(r.v);
  cov.push({ source: name, status: why ? "n/a" : "done", ...(why ? { note: why } : {}), ms });
  return why ? null : r.v;
}

/* ---------- coin ---------- */
const GATE_KEYS = { sell: { fail: "gate.sell.fail", warn: "gate.sell.warn" }, tax: { fail: "gate.tax.fail", warn: "gate.tax.warn" }, sim: { fail: "gate.sim.fail" },
  route: { fail: "gate.route.fail" }, impact: { fail: "gate.impact.fail" }, fee: { fail: "gate.fee.fail", warn: "gate.fee.warn" } };
function gateFindings(A, g) {
  const out = [];
  for (const c of g?.checks || []) {
    if (c.key === "sell" && c.status === "skip" && /holds no buyers|too little/i.test(c.detail || "")) {
      out.push(F("gate.sell.empty", { source: "Gate", heel: `selling back cannot be tested: ${low(noDot(c.detail))}`, text: `Troya Gate, test sell for a ${GATE_ETH} ETH buy: ${noDot(c.detail)}`,
        evidence: EV.call(A, "eth_call reads of the Pons curve's reserves at the latest block"), confidence: "high" }));
      continue;
    }
    const key = GATE_KEYS[c.key]?.[c.status];
    if (!key) continue;                          // depth on a young curve informs, never decides (as Swap and Sentry read it)
    const what = { sell: "a test sell", tax: "the transfer-tax probe", sim: "the swap simulation", route: "the route", impact: "price impact", fee: "fees and taxes" }[c.key];
    out.push(F(key, {
      source: "Gate", heel: c.key === "sell" ? `${c.status === "fail" ? "selling back fails" : "selling back needs a look"} in Troya Gate's test sell (${low(noDot(c.detail))})`
        : c.key === "tax" ? `transfer tax: ${low(noDot(c.detail))}` : c.key === "route" ? `there is no working route to buy it (${low(noDot(c.detail))})` : `${what}: ${low(noDot(c.detail))}`,
      text: `Troya Gate, ${c.label.toLowerCase()} for a ${GATE_ETH} ETH buy: ${noDot(c.detail)}`,
      evidence: EV.call(A, `eth_call simulation against the latest block${g.checkedAt ? `, ${new Date(g.checkedAt).toISOString()}` : ""}`),
      confidence: c.key === "sell" || c.key === "sim" || c.key === "tax" ? "high" : "medium",
    }));
  }
  return out;
}
const HEALTH = { blacklist: "health.blacklist", mint: "health.mint", upgradeable: "health.upgradeable", pause: "health.pause", fees: "health.fees", trading: "health.trading", limits: "health.limits", owner: "health.owner" };
function healthFindings(A, h) {
  const out = [];
  const where = h?.proxy?.implementation || A;
  for (const f of h?.flags || []) {
    if (f.level !== "risk" && f.level !== "warn") continue;
    const key = HEALTH[f.key];
    if (!key) continue;
    out.push(F(key, { source: "Token code", heel: low(f.text), text: `In the token's bytecode: ${noDot(f.text)}`, evidence: EV.contract(where, "function selectors found in the deployed bytecode (a heuristic, not an audit)"), confidence: "medium" }));
  }
  return out;
}
const PROBABILISTIC = new Set(["cluster", "funder"]);
// The Assay read only part of the history: its own coverage says so, or it raised its "partial" flag (no readable birth block)
const assayPartial = (d) => !!d?.coverage?.partial || (d?.flags || []).some((f) => f.key === "partial");   // wallet grouping: a link, not proof of one person
function assayFindings(A, d) {
  if (!d || d.status !== "done") return [];
  const out = [];
  const partial = assayPartial(d);
  const range = d.coverage ? `Transfer logs from block ${d.coverage.fromBlock ?? "?"} to ${d.coverage.head ?? "?"} (${(d.coverage.transfers || 0).toLocaleString("en-US")} transfers${partial ? ", most recent only" : ""})` : "Transfer logs";
  const dev = d.dev?.wallets?.[0];
  for (const f of d.flags || []) {
    const key = `assay.${f.key}.${f.level}`;
    if (!(key in RANK)) continue;
    let evidence = EV.logs(A, range, f.key === "top10" ? "holders" : "token_transfers");
    if (f.key === "funder") {
      const fd = (d.funding?.dev || []).find((x) => x.tx);
      if (fd?.tx) evidence = EV.tx(fd.tx, `the dev wallet's first ETH${fd.funder ? ` (from ${short(fd.funder)})` : ""}`);
      else if (d.funding?.shared?.[0]?.funder) evidence = EV.address(d.funding.shared[0].funder, "the shared funder");
    } else if (f.key === "cluster" && d.clusters?.[0]?.source) evidence = EV.address(d.clusters[0].source, `the wallet that handed coins out; ${range}`);
    else if (f.key === "bundle" && d.launch?.block) evidence = EV.block(d.launch.block, "the launch block; buys in the next 30 seconds were counted");
    else if (/^dev-|^lp-/.test(f.key) && dev) evidence = EV.address(dev, `the dev wallet; ${range}`);
    let conf = PROBABILISTIC.has(f.key) || f.key === "wash" ? "medium" : "high";
    if (partial) conf = lower1(conf);
    const heel = f.key === "cluster" || f.key === "funder" ? `${low(noDot(f.detail))} (a probable cluster: wallets linked by who paid or fed them)` : low(noDot(f.detail));
    out.push(F(key, { source: "The Assay", heel, text: `The Assay, ${f.title.toLowerCase()}: ${noDot(f.detail)}`, evidence, confidence: conf }));
  }
  return out;
}
function ringFindings(A, r) {
  if (!r || (r.verdict !== "red" && r.verdict !== "amber")) return [];
  const b = r.bundles?.[0];
  const evidence = b?.tx ? EV.tx(b.tx, `a bundle buy in the first seconds (${b.wallets} wallets, ${b.pctOfSupply}% of the supply)`) : r.launch?.tx ? EV.tx(r.launch.tx, "the launch transaction (snipe-tax exemptions decoded from it)") : EV.logs(A, "the launch and its first seconds");
  const reasons = (r.reasons || []).slice(0, 2);
  return [F(r.verdict === "red" ? "ring.red" : "ring.amber", { source: "Ring Radar", heel: `its launch pattern: ${reasons.join(", and ")}`, text: `Ring Radar (${r.verdict}): ${reasons.join("; ")}`, evidence, confidence: "high" })];
}
function devlinksFindings(A, r) {
  if (!r || (r.status !== "fail" && r.status !== "warn")) return [];
  const key = r.status === "fail" ? (/selling now/i.test(r.label || "") ? "devlinks.selling" : "devlinks.fail") : "devlinks.warn";
  const s = r.devSide?.lastSale;
  const evidence = s?.tx ? EV.tx(s.tx, `the dev side's latest sale (${short(s.wallet)})`) : r.dev?.[0]?.wallet ? EV.address(r.dev[0].wallet, "the dev wallet; links read from coin and ETH transfers") : EV.logs(A, "coin and ETH transfers between the dev and other wallets");
  const first = noDot(String(r.text || "").split("; ").slice(0, 2).join("; "));
  return [F(key, { source: "Dev side wallets", heel: `${r.label ? `${low(r.label)}: ` : ""}${low(first)} (wallet links are probable, read from transfers)`, text: `Dev side wallets: ${noDot(r.text)}`, evidence, confidence: "medium" })];
}
function watchfireFindings(A, w) {
  if (!w || !["fire", "red", "amber"].includes(w.level)) return [];
  const why = noDot(w.why?.[0] || "");
  if (!why) return [];
  const evidence = w.lastFire?.block && w.level === "fire" ? EV.block(w.lastFire.block, `the block of the ${w.lastFire.kind} signal`) : EV.logs(A, "live Transfer logs, read by Watchfire");
  return [F(`watchfire.${w.level}`, { source: "Watchfire", heel: low(why), text: `Watchfire (${w.level}): ${(w.why || []).slice(0, 2).map(noDot).join("; ")}`, evidence, confidence: w.level === "fire" ? "high" : "medium" })];
}
function tributeFindings(A, t) {
  if (!t || (t.verdict !== "fake" && t.verdict !== "caution")) return [];
  const why = noDot(t.reasons?.[0] || "");
  return [F(t.verdict === "fake" ? "tribute.fake" : "tribute.caution", { source: "Tribute", heel: low(why), text: `Tribute (${t.verdict === "fake" ? "not real" : "needs a look"}): ${(t.reasons || []).slice(0, 2).map(noDot).join(" ")}`, evidence: EV.logs(A, "payments to holders and the money in its pools (chain, Blockscout, DexScreener)"), confidence: "medium" })];
}
function oathFindings(A, o) {
  if (o?.status !== "broken" || !o.breaches?.length) return [];
  const b = o.breaches.at(-1);
  const what = b.kind === "sell" ? `sold ${b.soldPct}% of the supply on ${b.day} against a signed cap of ${b.capPct}% a day` : noDot(b.note || "broke a pledge");
  return [F("oath.broken", { source: "Oath", heel: `the dev broke its signed Oath: it ${what}`, text: `Oath broken (${plural(o.breaches.length, "breach", "breaches")}): ${what}`, evidence: b.tx ? EV.tx(b.tx, "the transaction that broke the Oath") : EV.logs(A, "the coin's transfers since the Oath"), confidence: "high" })];
}

/* ---------- dev passport ---------- */
// how big the dev's own buy was: what it got in the first day, as a share of the supply (tokenMeta is cached 30 min)
const SMALL_BUY_PCT = 1;   // a dev that sells a buy under 1% of the supply early is said, but not ranked as a dump
async function gotPctOf(story) {
  try { const m = await tokenMeta(story.token); const sup = BigInt(m.totalSupply || 0), got = BigInt(story.got || 0); return sup > 0n ? Math.round(Number((got * 1_000_000n) / sup) / 100) / 100 : null; } catch { return null; }
}
async function passportOf(dev, { exclude = null, max = 12, cov, launchesP = null }) {
  const dt = await import("./devtrack.mjs");
  const { HOUR } = dt.BLOCKS;
  const d = lc(dev);
  const [launches, age, oath] = await Promise.all([
    source(cov, "Pons launches", () => launchesP || dt.launchesOf(d)),
    source(cov, "Wallet age and funding", () => dt.walletAge(d)),
    source(cov, "Oath", () => import("./oath.mjs").then((m) => m.brokeOath([d]))),
  ]);
  const P = { wallet: getAddress(d), launches: null, funding: null, age: null, oath: null, latestCoin: null, notes: [] };
  const findings = [];
  if (launches) {
    const seen = new Set(), pick = [];
    for (const l of [...launches].sort((a, b) => b.block - a.block)) if (!seen.has(l.token) && l.token !== lc(exclude)) { seen.add(l.token); pick.push(l); }
    const stories = (await Promise.all(pick.slice(0, max).map((l) => dt.coinStory(l.token, l.dev, l.block).then(async (st) => ({ ...st, gotPct: await gotPctOf(st) })).catch(() => null)))).filter(Boolean);
    const unread = Math.min(max, pick.length) - stories.length;
    const bought = stories.filter((s) => s.status !== "no-buy");
    const out6 = stories.filter((s) => s.outBlock != null && s.outBlock - s.born <= 6 * HOUR);
    const d1 = stories.filter((s) => s.status === "dumped");
    const day1Late = stories.filter((s) => s.status === "sold-day1" && !out6.includes(s));
    P.launches = {
      total: pick.length, read: stories.length, unread, more: Math.max(0, pick.length - max), graduated: stories.filter((s) => s.graduated).length,
      devBought: bought.length, outWithin6h: out6.length, outWithin1h: d1.length, soldDay1After6h: day1Late.length, burned: stories.filter((s) => s.status === "burned").length,
      held: stories.filter((s) => s.status === "held").length, noBuy: stories.length - bought.length, young: stories.filter((s) => s.young).length,
      coins: stories.map((s) => ({ token: getAddress(s.token), block: s.born, status: s.status, graduated: s.graduated, devGotPct: s.gotPct, outTx: s.outTx || null, outAfterHours: s.outBlock != null ? +((s.outBlock - s.born) / HOUR).toFixed(1) : null })),
      liquidityPulls: null,
      rule: "out = the dev wallet sold or moved out at least 80% of the coins it got in the coin's first day (burns excluded); hours from block counts at about 34,000 blocks an hour",
    };
    // a coin: what its dev did with this coin in its first day (the same coinStory reading)
    const own = exclude ? launches.find((l) => l.token === lc(exclude)) : null;
    if (own) {
      const s = await dt.coinStory(own.token, own.dev, own.block).catch(() => null);
      if (s) {
        const hrs = s.outBlock != null ? (s.outBlock - s.born) / HOUR : null;
        const gp = await gotPctOf(s);
        P.thisCoin = { token: getAddress(s.token), launchBlock: s.born, launchTx: own.tx || null, status: s.status, devGotPct: gp, outTx: s.outTx || null, outAfterHours: hrs != null ? +hrs.toFixed(1) : null, young: s.young };
        if (hrs != null) {
          const smallBuy = gp != null && gp < SMALL_BUY_PCT;
          const key = smallBuy ? "coin.dev.out.small" : hrs <= 1 ? "coin.dev.out1h" : hrs <= 6 ? "coin.dev.out6h" : "coin.dev.day1";
          const bag = gp != null ? ` (${gp}% of the supply)` : "";
          findings.push(F(key, { source: "Dev passport", heel: `its dev wallet ${short(d)} sold or moved out at least 80% of ${smallBuy ? "its small launch buy" : "the coins it got"}${bag}, ${hrs.toFixed(1)} h after launch`,
            text: `Dev wallet ${short(d)} sold or moved out 80%+ of what it got on this coin${bag} ${hrs.toFixed(1)} h after launch (burns excluded)`,
            evidence: s.outTx ? EV.tx(s.outTx, "the transfer that took the dev past 80% out") : EV.address(d, "the dev wallet's Transfer logs"), confidence: "high" }));
        }
      } else P.notes.push("what the dev did with this coin could not be read just now");
    }
    if (unread) P.notes.push(`${plural(unread, "launch", "launches")} could not be read just now`);
    if (P.launches.more) P.notes.push(`only the newest ${max} launches were read`);
    P.notes.push("Liquidity pulls are measured per coin by The Assay, not across launches yet");
    // a dump needs a real bag: buys under SMALL_BUY_PCT of the supply are counted apart
    const big = out6.filter((s) => s.gotPct == null || s.gotPct >= SMALL_BUY_PCT), small = out6.filter((s) => !big.includes(s));
    P.launches.outWithin6hSmallBuy = small.length;
    if (!big.length && small.length) {
      const s0 = small[0], n = stories.length;
      findings.push(F("dev.out6h.small", { source: "Dev passport",
        heel: `${exclude ? `its dev wallet ${short(d)}` : "this wallet"} sold its own small launch buy within 6 h on ${n === 1 ? (exclude ? "its one earlier Pons launch read" : "its one Pons launch read") : `${small.length} of ${n} Pons launches read`} (${small.map((x) => `${x.gotPct}%`).slice(0, 3).join(", ")} of the supply)`,
        text: `Dev passport: on ${small.length} of ${plural(n, "launch", "launches")} read the dev sold or moved out 80%+ of a buy under ${SMALL_BUY_PCT}% of the supply within 6 h; newest: ${short(s0.token)}, ${((s0.outBlock - s0.born) / HOUR).toFixed(1)} h after launch`,
        evidence: s0.outTx ? EV.tx(s0.outTx, `the transfer that took ${short(s0.token)} past 80% out`) : EV.address(d, "Transfer logs"), confidence: "high" }));
    }
    if (big.length) {
      const k = big.length, n = stories.length, s0 = big[0];
      // "many": a habit, not one coin (two or more, and three or more or at least half of the launches read)
      const of = n === 1 ? "its one Pons launch read" : `${k} of the ${n} Pons launches read`;
      findings.push(F(k >= 2 && (k >= 3 || k * 2 >= n) ? "dev.out6h.many" : "dev.out6h", {
        source: "Dev passport",
        heel: exclude ? `its dev wallet ${short(d)} sold or moved out at least 80% of its own buy within 6 h on ${n === 1 ? "its one earlier Pons launch read" : `${k} of ${n} earlier Pons launches read`}${d1.length ? ` (${d1.length === k && k === 1 ? "within the first hour" : `${d1.length} within the first hour`})` : ""}`
          : `on ${of}, this wallet sold or moved out at least 80% of its own buy within 6 h${d1.length ? ` (${d1.length === k && k === 1 ? "within the first hour" : `${d1.length} within the first hour`})` : ""}`,
        text: `Dev passport: ${k} of ${plural(n, "launch", "launches")} read saw the dev sell or move out 80%+ of its buy (1% of the supply or more) within 6 h; newest: ${short(s0.token)}, ${s0.gotPct != null ? `${s0.gotPct}% of the supply, ` : ""}${((s0.outBlock - s0.born) / HOUR).toFixed(1)} h after launch`,
        evidence: s0.outTx ? EV.tx(s0.outTx, `the transfer that took ${short(s0.token)} past 80% out`) : EV.address(d, "TokenLaunched logs (Pons factory, deployer topic) and Transfer logs"),
        confidence: "high",
      }));
    }
    if (day1Late.length) {
      const s0 = day1Late[0];
      findings.push(F("dev.day1", { source: "Dev passport", heel: `${exclude ? `its dev wallet ${short(d)}` : "this wallet"} sold out its own buy on day one on ${day1Late.length} of ${plural(stories.length, "launch", "launches")} read (after the first 6 h)`,
        text: `Dev passport: ${day1Late.length} more launch${day1Late.length === 1 ? "" : "es"} sold out by the dev on day one, after 6 h`, evidence: s0.outTx ? EV.tx(s0.outTx, `the transfer that took ${short(s0.token)} past 80% out`) : EV.address(d, "Transfer logs"), confidence: "high" }));
    }
    // the newest coin's side wallets (the fast read; a deep read already cached is used as is)
    const latest = pick[0];
    if (latest && !exclude) {
      const dl = await source(cov, "Side wallets on its newest coin", () => import("./devlinks.mjs").then((m) => m.devLinks(latest.token, { deep: false, waitMs: Math.min(WAIT_MS, 20_000) }).then(m.publicView)),
        { wait: Math.min(WAIT_MS, 22_000), running: (v) => v?.status === "running", na: (v) => (v?.status === "unknown" ? v.reason || "not measured" : null) });
      if (dl) {
        P.latestCoin = { token: getAddress(latest.token), status: dl.status, label: dl.label || null, text: dl.text, linked: dl.linked?.count ?? null, devSideHoldsPct: dl.devSide?.holdsPct ?? null };
        for (const f of devlinksFindings(getAddress(latest.token), dl)) findings.push({ ...f, heel: `on its newest coin ${short(latest.token)}, ${f.heel}`, text: f.text.replace(/^Dev side wallets:/, `Newest coin ${short(latest.token)}, dev side wallets:`) });
      }
    }
  }
  if (age) {
    P.age = { days: age.days ?? null, transactions: age.nonce ?? null };
    const f = age.fund;
    if (f) {
      P.funding = { block: f.block ?? null, how: f.how, funder: f.funder ? getAddress(f.funder) : null, via: f.via ? getAddress(f.via) : null, tx: f.tx || null, funderLaunches: null };
      if (f.funder) {
        const fl = await source(cov, "The funder's launches", () => dt.launchesOf(f.funder));
        if (fl) {
          const seen = new Set(), pick = [];
          for (const l of [...fl].sort((a, b) => b.block - a.block)) if (!seen.has(l.token)) { seen.add(l.token); pick.push(l); }
          const st = (await Promise.all(pick.slice(0, 6).map((l) => dt.coinStory(l.token, l.dev, l.block).catch(() => null)))).filter(Boolean);
          const bad = st.filter((s) => s.status === "dumped" || s.status === "sold-day1");
          P.funding.funderLaunches = { total: pick.length, read: st.length, soldOutDay1: bad.length, outWithin1h: st.filter((s) => s.status === "dumped").length };
          if (bad.length) findings.push(F("dev.funder", { source: "Dev passport",
            heel: `${exclude ? "its dev's" : "this wallet's"} first ETH came from ${short(f.funder)}, a wallet whose own dev wallet sold out its buy on day one on ${bad.length} of ${plural(st.length, "launch", "launches")} read (a funding link, not proof of one person)`,
            text: `First ETH from ${short(f.funder)}, which launched ${pick.length} Pons coin${pick.length === 1 ? "" : "s"}; on ${bad.length} of ${st.length} read it sold out its own buy on day one`,
            evidence: f.tx ? EV.tx(f.tx, "the first ETH this wallet received") : EV.address(f.funder, "the funder"), confidence: "medium" }));
        }
      } else if (f.how === "contract") P.notes.push(`its first ETH came through a contract call${f.via ? ` (${short(f.via)})` : ""}: a bridge, an exchange or a batch sender, so the trail stops there`);
    } else P.notes.push("where its first ETH came from was not found");
  }
  if (oath) {
    P.oath = { token: getAddress(oath.token), at: oath.at, until: oath.until, breach: oath.breach || null };
    findings.push(F("oath.broken", { source: "Oath", heel: `${exclude ? "its dev" : "this wallet"} broke a signed Oath on ${short(oath.token)} in the last 30 days`, text: `Oath broken on ${short(oath.token)} (${new Date(oath.at).toISOString().slice(0, 10)})`,
      evidence: oath.breach?.tx ? EV.tx(oath.breach.tx, "the transaction that broke the Oath") : EV.address(oath.token, "the coin"), confidence: "high" }));
  }
  return { passport: P, findings };
}

/* ---------- agent ---------- */
function agentFindings(A, al) {
  const out = [];
  if (!al) return out;
  const coins = al.launches?.coins || [];
  for (const c of al.checks || []) {
    if (c.name === "Its coins now" && c.status === "flag") {
      const bad = coins.find((x) => x.gate?.verdict === "failed" || x.ring === "red" || x.oath === "broken" || x.watchfire === "fire");
      out.push(F("agent.coins.flag", { source: "Allies", heel: `coins it launched carry red flags now: ${low(noDot(c.detail))}`, text: `Allies, its coins now: ${noDot(c.detail)}`, evidence: bad?.token ? EV.call(bad.token, "Troya Gate on the coin it launched, at the latest block") : EV.address(A, "its launches"), confidence: "high" }));
    } else if (c.name === "ERC-8004 agentId" && c.status === "flag") {
      out.push(F("agent.id.flag", { source: "Allies", heel: low(noDot(c.detail)), text: `ERC-8004: ${noDot(c.detail)}`, evidence: EV.contract(al.identity?.erc8004?.registry || "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", "ownerOf / getMetadata on the ERC-8004 identity registry"), confidence: "high" }));
    } else if (c.status === "warn") {
      out.push(F("agent.warn", { source: "Allies", heel: `${c.name.toLowerCase()}: ${low(noDot(c.detail))}`, text: `Allies, ${c.name.toLowerCase()}: ${noDot(c.detail)}`, evidence: EV.address(A, "the records Allies read"), confidence: "medium" }));
    }
  }
  if (al.verdict === "unknown") out.push(F("agent.none", { source: "Allies", heel: "Troya has no track record for it: no ERC-8004 identity, registry calls, Arena strategy, launches or receipts it can read", text: "Allies: no ERC-8004 identity, no registry calls, no Arena strategy, no launches and no receipts found. Unknown is untested, not bad", evidence: EV.address(A, "ERC-8004 identity registry, Troya registry, Arena, launches"), confidence: "high" }));
  return out;
}
const isAgent = (al) => (al?.checks || []).some((c) => ["ERC-8004 identity", "Troya registry", "Arena"].includes(c.name) && c.status === "found");

/* ---------- facts that show what was measured, for a clean answer ---------- */
function cleanFacts(A, { gate, health, assay, ring, dl }) {
  const out = [];
  const sell = gate?.checks?.find((c) => c.key === "sell" && c.status === "pass");
  if (sell) out.push({ text: `Troya Gate test sell for a ${GATE_ETH} ETH buy: ${noDot(sell.detail)}.`, evidence: EV.call(A, "eth_call sell simulation against the latest block"), confidence: "high", source: "Gate" });
  if (assay?.status === "done" && !(assay.flags || []).some((f) => f.key !== "partial")) {
    const n = (assay.coverage?.transfers || 0).toLocaleString("en-US");
    out.push(assayPartial(assay)
      ? { text: `The Assay read only the most recent ${n} transfers (not the whole history) and found no red or amber flag in them.`, evidence: EV.logs(A, "Transfer logs, partial"), confidence: "low", source: "The Assay" }
      : { text: `The Assay found no red or amber flag across ${n} transfers since launch.`, evidence: EV.logs(A, "Transfer logs"), confidence: "high", source: "The Assay" });
  }
  if (ring?.verdict === "clear") out.push({ text: `Ring Radar: ${noDot(ring.reasons?.[0])}.`, evidence: ring.launch?.tx ? EV.tx(ring.launch.tx, "the launch transaction") : EV.logs(A, "the launch"), confidence: "high", source: "Ring Radar" });
  if (dl?.status === "pass") out.push({ text: `Dev side wallets: ${noDot(dl.text)}.`, evidence: EV.logs(A, "coin and ETH transfers"), confidence: "medium", source: "Dev side wallets" });
  if (health && !(health.flags || []).some((f) => f.level === "risk" || f.level === "warn")) out.push({ text: "No pause, blacklist, fee-change or owner-mint function found in the token's bytecode.", evidence: EV.contract(health.proxy?.implementation || A, "function selectors in the deployed bytecode (a heuristic)"), confidence: "medium", source: "Token code" });
  return out.slice(0, 3);
}

/* ---------- the sentence ---------- */
const BANNED = /\b(scam\w*|rug ?pull\w*|fraud\w*|thie\w+|criminal\w*|steal\w*|crook\w*)\b/i;
async function llmSentence(top, facts) {
  if (process.env.HEEL_LLM !== "1") return null;
  try {
    const llm = await import("./llm.mjs");
    if (!llm.llmOn() || !(await llm.underCap())) return null;
    const out = await llm.ask({ maxTokens: 120, temperature: 0.2,
      system: "You rewrite one finding into one short plain-English sentence that starts with \"Heel:\". Use only the facts given. Describe behaviour, never accuse anyone, never call anything a scam or safe. Keep every number exactly as given and add none. Reply with the sentence only.",
      user: JSON.stringify({ weakSpot: top.heel, facts: facts.map((f) => f.text) }) });
    const s = String(out || "").trim().split("\n")[0].replace(/^["'`]+|["'`]+$/g, "");
    const nums = (x) => (String(x).match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ""));
    const allowed = new Set(nums([top.heel, ...facts.map((f) => f.text)].join(" ")));
    if (!s.startsWith("Heel:") || s.length > 240 || BANNED.test(s) || nums(s).some((n) => !allowed.has(n))) return null;
    return s;
  } catch { return null; }
}
async function answer({ A, kind, findings, clean, cov, guard, passport, extra }) {
  const ranked = rankFindings(findings);
  const top = ranked[0] || null;
  const partial = cov.some((c) => c.status === "running");
  const failed = cov.filter((c) => c.status === "failed").map((c) => c.source);
  const facts = (top ? ranked.slice(0, 3) : clean).map((f) => ({ text: f.text, evidence: f.evidence, confidence: f.confidence, source: f.source, ...(f.key ? { key: f.key, severity: levelOf(f.score) } : {}) }));
  let heel, confidence;
  if (top) {
    heel = `Heel: ${top.heel}.`;
    confidence = top.confidence;
    const said = await llmSentence(top, facts);
    if (said) heel = said;
  } else {
    const ran = cov.filter((c) => c.status === "done").length;
    heel = kind === "coin" ? `No weak spot found in what was measured (${plural(ran, "source")} read${partial ? ", some still reading" : ""}${failed.length ? `, ${failed.join(", ")} could not be read` : ""}). Not a safe stamp: a coin can change after a check.`
      : kind === "dev" ? `No weak spot found in this dev's launches, funding or Oaths${partial || failed.length ? " so far (some reads did not finish)" : ""}. A clean history is a record, not a promise.`
        : kind === "agent" ? "No red flag in this agent's record. A record is not a promise."
          : extra?.unknownSentence || "Nothing to judge yet: Troya found no coin, no Pons launch and no agent record at this address.";
    confidence = partial || failed.length || cov.some((c) => /^partial/.test(c.note || "")) ? "low" : "medium";
  }
  return {
    address: A, kind, heel, severity: levelOf(top?.score || 0), score: top?.score || 0, confidence,
    facts, more: Math.max(0, ranked.length - facts.length), guard, ...(passport ? { passport } : {}), ...(extra?.coin ? { coin: extra.coin } : {}),
    coverage: cov, partial, checkedAt: Date.now(),
    note: "Behaviour read from Robinhood Chain, not a judgement of people. Wallet grouping (clusters, side wallets, shared funders) is probabilistic. No weak spot is not a safe stamp.",
  };
}

/* ---------- one address ---------- */
// Ring Radar searches about 2 days of launch logs (ringradar.mjs findLaunchTx: 60 × 30,000 blocks) and keeps no in-flight
// promise, so Heel asks it once per coin at a time, and not at all for an older coin
const RING_BLOCKS = 1_800_000;
const ringP = new Map();
function ringOnce(A, launch) {
  const k = lc(A);
  if (!ringP.has(k)) ringP.set(k, import("./ringradar.mjs").then((m) => m.ringCheck(A, launch)).finally(() => ringP.delete(k)));
  return ringP.get(k);
}
async function compute(address) {
  const A = getAddress(address);
  const code = await rpc("robinhood", "eth_getCode", [A, "latest"], { timeoutMs: 12_000 }).catch((e) => { throw Object.assign(new HttpError(502, `Robinhood Chain could not be read just now (${e.message}). Ask again in a minute.`), { expose: true }); });
  const contract = !!code && code !== "0x" && !/^0xef0100/i.test(code);
  const cov = [];
  const meta = contract ? await tokenMeta(A).catch(() => null) : null;

  if (meta) {
    // a coin: every source at once
    const ps = await ponsState(A).catch(() => null);
    const deployer = ps?.deployer ? lc(ps.deployer) : null;
    // the deployer's launches, read once: the passport uses them, and this coin's own launch log tells Ring Radar where to look
    const dt = await import("./devtrack.mjs");
    const launchesP = deployer ? dt.launchesOf(deployer) : null;
    launchesP?.catch(() => {});
    const [gate, health, assay, ring, dl, wf, tribute, oath, dev] = await Promise.all([
      source(cov, "Gate", () => import("./badge.mjs").then((m) => m.badgeResult(A))),
      source(cov, "Token code", () => tokenHealth(A)),
      source(cov, "The Assay", () => import("./assay.mjs").then((m) => m.assay(A, { deep: true, waitMs: WAIT_MS })), { wait: WAIT_MS + 2000, running: (v) => v?.status === "running" }),
      ps ? source(cov, "Ring Radar", async () => {
        const me = await launchesP.then((ls) => ls.find((l) => l.token === lc(A)), () => null);
        if (me) {
          const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
          if (head - me.block > RING_BLOCKS) return { verdict: "unknown", reasons: [`Launched ${((head - me.block) / dt.BLOCKS.DAY).toFixed(1)} days ago: Ring Radar reads launches up to about 2 days back`] };
        }
        return ringOnce(A, me?.tx ? { tx: me.tx, block: me.block } : null);
      }, { na: (v) => (v?.verdict === "unknown" ? noDot(v.reasons?.[0] || "nothing to read") : null) }) : (cov.push({ source: "Ring Radar", status: "n/a", note: "not a Pons launch" }), null),
      source(cov, "Dev side wallets", () => import("./devlinks.mjs").then((m) => m.devLinks(A, { deep: true, waitMs: WAIT_MS }).then(m.publicView)), { wait: WAIT_MS + 2000, running: (v) => v?.status === "running", na: (v) => (v?.status === "unknown" ? v.reason || "not measured" : null) }),
      source(cov, "Watchfire", async () => {
        const m = await import("./watchfire.mjs");
        const st = m.watch(A, "ask");                       // starts the live watch, as /api/watchfire/:token does (30 minutes)
        if (st?.loading) await st.loading;
        return m.watchfireState(A);
      }, { running: (v) => v == null }),
      // Tribute's "unknown" is a reading with a check cut short (or nothing to read): no verdict, said as such
      source(cov, "Tribute", () => import("./tribute.mjs").then((m) => m.tributeCheck(A)), { na: (v) => (v?.verdict === "unknown" ? `no verdict this time: ${low(noDot((v.reasons || []).find((x) => /could not|cut short|unavailable|no pools|no contract|not answer/i.test(x)) || "not every check finished"))}` : null) }),
      source(cov, "Oath", () => import("./oath.mjs").then((m) => m.oathOf(A))),
      // a Pons coin: its dev's record on earlier launches (the passport's own sources are listed as "Dev passport · …")
      deployer ? (async () => { const sub = []; try { return await passportOf(deployer, { exclude: A, cov: sub, launchesP }); } catch (e) { sub.push({ source: "passport", status: "failed", note: e.message }); return null; } finally { for (const c of sub) cov.push({ ...c, source: `Dev passport · ${c.source}` }); } })() : null,
    ]);
    if (assay?.status === "done" && assayPartial(assay)) { const c = cov.find((x) => x.source === "The Assay"); if (c) c.note = `partial: only the most recent ${(assay.coverage?.transfers || 0).toLocaleString("en-US")} transfers were read`; }
    if (assay?.status === "error") { const c = cov.find((x) => x.source === "The Assay"); if (c) { c.status = "failed"; c.note = String(assay.error || "error").slice(0, 160); } }
    const findings = [...gateFindings(A, gate), ...healthFindings(A, health), ...assayFindings(A, assay?.status === "done" ? assay : null), ...ringFindings(A, ring),
      ...devlinksFindings(A, dl), ...watchfireFindings(A, wf), ...tributeFindings(A, tribute), ...oathFindings(A, oath), ...(dev?.findings || []).filter((f) => f.key !== "oath.broken" || !oath)];
    const sym = gate?.symbol || meta.symbol;
    return answer({ A, kind: "coin", findings, cov, clean: cleanFacts(A, { gate, health, assay, ring, dl }), passport: dev?.passport || null,
      guard: { label: "Pin it to Watchfire", href: `#/gate/${A}`, action: { kind: "watchfire-pin", method: "POST", path: "/api/treasury/pins", body: { token: A, on: true }, needs: "sign-in" }, alt: { label: "Run the Gate", href: `#/gate/${A}` } },
      extra: { coin: { symbol: sym || null, name: gate?.name || meta.name || null, pons: !!ps, graduated: !!ps?.graduated, deployer: deployer ? getAddress(deployer) : null, gate: gate ? { word: gate.word, label: gate.label, reason: gate.reason } : null } } });
  }

  // a wallet (or a contract that is not a token): agent record and dev passport side by side
  const [al, pp] = await Promise.all([
    source(cov, "Allies (agent record)", () => import("./allies.mjs").then((m) => m.alliesOf(A))),
    contract ? null : passportOf(A, { cov }),
  ]);
  const agent = isAgent(al);
  const devLaunches = pp?.passport?.launches?.total || 0;
  const kind = agent ? "agent" : devLaunches ? "dev" : "unknown";
  const findings = [...(pp?.findings || []), ...(agent ? agentFindings(A, al) : (al?.checks || []).some((c) => c.name === "Its coins now" && c.status === "flag") ? agentFindings(A, al).filter((f) => f.key === "agent.coins.flag") : [])];
  const launchesRead = cov.find((c) => c.source === "Pons launches");
  const unknownSentence = contract ? "Not a token: a contract with no agent record Troya can read, so there is nothing to judge yet."
    : launchesRead?.status !== "done" ? `Its Pons launches could not be read just now (${launchesRead?.note || "no answer"}), and Troya has no agent record for it. Ask again in a minute.`
      : "Nothing to judge yet: this wallet launched no Pons coin and has no agent record Troya can read.";
  return answer({ A, kind, findings, cov, clean: [], passport: pp?.passport || null,
    guard: { label: kind === "agent" ? "Watch this agent" : kind === "dev" ? "Watch this dev" : "Watch this wallet", href: `#/heel/${A}`, action: { kind: "watch-dev", method: "POST", path: "/api/heel/watch", body: { address: A, on: true }, needs: "sign-in" } },
    extra: { unknownSentence } });
}

const memo = new Map(), inflight = new Map();
const sealedAt = new Map();
/** The Heel for one address (cached 5 minutes; 30 seconds while a source is still reading). */
export async function heel(address) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a Robinhood Chain address: a coin, a dev wallet or an agent (0x + 40 hex).");
  const k = lc(address);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) inflight.set(k, compute(address).then((res) => {
    memo.set(k, { at: Date.now(), ttl: res.partial ? TTL_PARTIAL : TTL_DONE, res });
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    // V7 F35: a critical or high Heel gets a sealed receipt, once per address every 6 hours
    if (!res.partial && res.score >= 55 && Date.now() - (sealedAt.get(k) || 0) > 6 * 3600_000 && process.env.HEEL_SEAL !== "0") {
      sealedAt.set(k, Date.now());
      import("./seal.mjs").then((m) => m.seal("heel", res.address, { heel: res.heel, facts: res.facts, kind: res.kind }, res.heel.slice(0, 150))).catch(() => {});
    }
    return res;
  }).finally(() => inflight.delete(k)));
  return inflight.get(k);
}

/* ---------- Guard for a dev: watch its new launches ---------- */
async function watchList(owner) { const d = await store.readJson(FILE, {}); return (d.users?.[lc(owner)] || []).map((x) => ({ address: getAddress(x.address), at: x.at })); }
async function setWatch(owner, address, on) {
  const a = lc(address), o = lc(owner);
  let seed = null;
  if (on) seed = await import("./devtrack.mjs").then((m) => m.launchesOf(a)).then((ls) => ls.map((l) => l.token)).catch(() => null);
  let out = [];
  await store.update(FILE, {}, (d) => {
    d.users ||= {}; d.seen ||= {};
    const list = (d.users[o] || []).filter((x) => x.address !== a);
    if (on) {
      if (list.length >= 20) throw new HttpError(400, "You watch 20 wallets already. Stop watching one first.");
      list.unshift({ address: a, at: Date.now() });
      if (seed && !d.seen[a]) d.seen[a] = seed;
    }
    d.users[o] = list;
    out = list;
    return d;
  });
  return out.map((x) => getAddress(x.address));
}
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const d = await store.readJson(FILE, {});
    const by = new Map();
    for (const [o, list] of Object.entries(d.users || {})) for (const x of list || []) { if (!by.has(x.address)) by.set(x.address, []); by.get(x.address).push(o); }
    const dt = await import("./devtrack.mjs"), inbox = await import("./inbox.mjs");
    for (const [dev, owners] of [...by].slice(0, 200)) {
      const ls = await dt.launchesOf(dev).catch(() => null);
      if (!ls) continue;
      const seen = new Set(d.seen?.[dev] || []);
      const fresh = ls.filter((l) => !seen.has(l.token));
      if (!d.seen?.[dev]) { await store.update(FILE, {}, (x) => { x.seen ||= {}; x.seen[dev] = ls.map((l) => l.token); return x; }); continue; }
      if (!fresh.length) continue;
      await store.update(FILE, {}, (x) => { x.seen ||= {}; x.seen[dev] = [...new Set([...(x.seen[dev] || []), ...fresh.map((l) => l.token)])].slice(-500); return x; });
      for (const l of fresh.slice(0, 3)) for (const o of owners) await inbox.addInbox(o, { kind: "alert", title: `A wallet you watch launched a coin on Pons`,
        body: `${short(dev)} launched ${getAddress(l.token)}. Read its Heel before you buy: troya.codes/agent#/heel/${getAddress(l.token)}`, data: { token: getAddress(l.token), dev: getAddress(dev) } }).catch(() => {});
    }
  } finally { ticking = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  const { requireSession } = await import("./auth.mjs");
  // before /api/heel/:address, which would also match this path
  r.get("/api/heel/watching", async ({ req }) => ({ watching: await watchList(requireSession(req).address), loop: process.env.HEEL_DEVWATCH === "1" }), { weight: 1 });
  r.get("/api/heel/:address", ({ params }) => heel(params.address), { weight: 3, perMin: 30 });
  r.post("/api/heel/watch", async ({ req, body }) => {
    const s = requireSession(req);
    if (!isAddress(String(body?.address || ""))) throw new HttpError(400, "That is not a wallet address.");
    const list = await setWatch(s.address, body.address, body.on !== false);
    return { ok: true, watching: list, loop: process.env.HEEL_DEVWATCH === "1", note: process.env.HEEL_DEVWATCH === "1" ? "New Pons launches by these wallets land in your inbox." : "Saved. Launch alerts start once the owner turns the dev watch on." };
  }, { perMin: 20 });
  if (process.env.HEEL_DEVWATCH === "1") setInterval(() => tick().catch((e) => console.warn("[heel] watch", e.message)), 10 * 60_000).unref?.();
}
