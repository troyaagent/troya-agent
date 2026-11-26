// Troya Check (phase 1, 26 Nov 2026): one 0–100 score for a Robinhood Chain coin, with the three reasons that moved it most,
// each with its evidence. Asked on X ("@Troyaagent check 0x…" / "check $TICKER", or "@Troyaagent check" under a post that
// carries a contract), in Telegram (/check 0x…) and on the web (troya.codes/check). Every check made is kept for the public
// dashboard (troya.codes/check): recent checks and this week's boards.
//
// Troya Check measures nothing new. It reads the modules that already do, through their caches:
//   Troya Gate     badge.mjs badgeResult → sentry.checkLaunch → robinhood.gateCheck (a 0.01 ETH simulated buy and a test sell),
//                  memoised 10 minutes; its lines also carry Ring Radar's launch ring and the dev side wallets
//   Ring Radar     ringradar.mjs ringCheck (read only when the Gate already asked it, so it is a cache hit)
//   Dev side       the Gate's "Dev side wallets" line (devlinks.mjs), with the latest dev-side sale from devLinksCached
//   Holders        assay.mjs (The Assay: dev, top wallets, bundles, clusters, wash trades, funders)
//   Market         market.mjs getRobinhoodToken (liquidity, holders), nameClash (other contracts on the same ticker)
//   Age            tokenage.mjs bornAt (the token's creation block)
//   Weak spot      heel.mjs (the single worst finding across all of the above, ranked in code)
// The score is computed here, in code, from those reads (WEIGHTS and CAPS below; never by a model). A part that could not be
// read is shown as "not read" and left out of the score, never filled in. Tokenized stocks and majors are named as such and
// not scored like launches. It never calls a coin safe and never tells anyone to buy.
//
//   GET /api/check/:address           run the check (or return it from the 10-minute cache)
//   GET /api/check                    recent checks + this week's boards (safest, most red flags, most checked)
//   GET /api/check/:address/card.png  the 1200 × 630 card X and Telegram show for troya.codes/check/<address>
//   page /check/<address>             server.mjs serves public/check.html with this coin's link preview (renderPage)
//   page /check                       the dashboard (same file, no address)
//   Claims         checkclaims.mjs (phase 2): what the coin's website and X posts claim (liquidity locked, renounced, tax,
//                  supply, burn, audit, team, live product, listing, partner), each proven, contradicted or unverified
// Phase 2 also grades every tracked check later, as fates.mjs grades launches (GET /api/check/record), and X and Telegram
// wait for a fuller read before they answer (checkForChat).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const SITE = "https://troya.codes";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FILE = "checks.json";                       // every check made: { address, symbol, kind, score, label, reasons, at, via, by }
const MAX_ROWS = 3000;
const TTL = 10 * 60_000, TTL_PARTIAL = 60_000;
const WAIT_MS = Math.max(4000, Number(process.env.CHECK_WAIT_MS) || 22_000);   // how long one check waits for its sources
const PAGE_WAIT_MS = 3000;                        // a crawler waits a few seconds for the page; the check keeps running after
const CARD_WAIT_MS = 20_000;                      // the card may wait longer for a check already under way
const MAX_RUNNING = 3;                            // fresh checks computed at once; others queue
const WEEK = 7 * 86400_000;
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const noDot = (s) => String(s || "").trim().replace(/[.\s]+$/, "");
const cap1 = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// a coin's symbol as its creator typed it: no control or invisible characters, short (it is untrusted text everywhere)
const cleanSym = (s) => String(s || "").replace(/^\$/, "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").replace(/[<>@]/g, "").trim().slice(0, 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const within = (p, ms, v = null) => Promise.race([Promise.resolve(p).catch(() => v), sleep(ms).then(() => v)]);
let store = null;

/* ---------- how the score is made ---------- */
// Each part gives a value from 0 to 1. score = 100 × Σ(weight × value) / Σ(weight of the parts that were read), then the
// lowest cap that applies. The weights add up to 100 when every part is read.
// contract powers joined on 27 Nov (an X user: "mint authority? otherwise it's a vibe number"): 10, taken from the parts that
// say least about getting out (liquidity and holders 9 → 5, Heel 4 → 2: it re-ranks the others, same ticker 4 → 3, age 4 → 3,
// claims 10 → 8)
export const WEIGHTS = { gate: 27, ring: 14, devside: 14, holders: 14, powers: 10, market: 5, heel: 2, clash: 3, age: 3, claims: 8 };
export const CAPS = {
  gateFail: 15,       // the Gate failed a check that decides a buy: the test sell, the exact swap, the transfer tax or the fees
  ringRed: 20,        // Ring Radar: a rigged launch pattern
  noRoute: 25,        // the Gate finds no route to buy it at all
  lpPulled: 25,       // The Assay: the dev pulled liquidity
  devsideFail: 30,    // the dev and the wallets tied to it hold most of it or are selling now (the Gate blocks the buy)
  noSellRoute: 40,    // a buy works, but no route sells it back (on Troya or through KyberSwap)
  claimFalse: 35,     // the project claims liquidity locked, renounced, a tax, a supply or a burn that the chain contradicts
  thinFail: 45,       // the pool is too thin for a 0.01 ETH buy (price impact or depth failed)
  gateNotRead: 60,    // the Gate could not run: nothing shows it can be sold back
  unread: 74,         // the Gate, Ring Radar, the dev side or The Assay is still unread: never "No major flags" without them
  powersMint: 40,     // an active owner can mint more of it
  powersTrap: 45,     // an active owner can blacklist wallets, pause transfers or switch trading off
  powersUpgrade: 60,  // an upgradeable proxy with a live admin or owner: the code itself can be changed
  powersFees: 74,     // an active owner can change fees or taxes (no hard maximum read)
  flagged: 74,        // a part read badly, or a reason shown is a warning: never "No major flags" over a serious line (MOW 85, PONS 88)
  devSold: 74,        // the dev wallet sold 80%+ of its coins, or the wallets linked to it sold 80%+ of what they got
  devSoldBoth: 60,    // both of those
  washHigh: 74,       // 50%+ of all trades come from wallets trading the same amounts back and forth (bots or wash trading)
  washVeryHigh: 60,   // 70%+ of them
};
// enough read to give a number: 35 of the weight with the Gate among it (the Gate plus liquidity is 36), or 45 without it.
// A non-Pons coin has no Ring Radar or dev-side reading, so a flat 45 left it unscored whenever The Assay was still reading
// (HOOKR, Ibex in the 27 Nov calibration). The unread cap (74) still keeps such a score out of "No major flags".
const MIN_READ_WITH_GATE = 35, MIN_READ_WEIGHT = 45;
const CORE_PARTS = ["gate", "ring", "devside", "holders"];
export const BANDS = [
  { min: 75, label: "No major flags", tone: "good" },
  { min: 50, label: "Some flags", tone: "warn" },
  { min: 25, label: "Risky", tone: "risky" },
  { min: 0, label: "Red flags", tone: "bad" },
];
export const bandOf = (score) => (score == null ? null : BANDS.find((b) => score >= b.min));
export const NAMES = { gate: "Troya Gate", ring: "Ring Radar", devside: "Dev side wallets", holders: "Holders (The Assay)", market: "Liquidity and holders", heel: "Weak spot (Heel)", clash: "Same ticker", age: "Token age", claims: "Website and X claims", powers: "Contract powers" };

const links = {
  gate: (A) => ({ label: "Gate page", href: `/agent#/gate/${A}` }),
  heel: (A) => ({ label: "Heel", href: `/agent#/heel/${A}` }),
  token: (A) => ({ label: "Token page", href: `/agent#/token/${A}` }),
  tx: (h, label = "Transaction") => ({ label, href: `${EXPLORER}/tx/${h}` }),
  holders: (A) => ({ label: "Holders on Blockscout", href: `${EXPLORER}/token/${A}?tab=holders` }),
  explorer: (A) => ({ label: "Blockscout", href: `${EXPLORER}/token/${A}` }),
  dex: (A) => ({ label: "DexScreener", href: `https://dexscreener.com/robinhood/${lc(A)}` }),
};

function part(key, extra = {}) {
  return { key, name: NAMES[key], weight: WEIGHTS[key], status: "scored", value: null, tone: "good", summary: "", short: null, evidence: [], links: [], cap: null, ...extra };
}
const notRead = (p, why) => Object.assign(p, { status: "not read", value: null, tone: "grey", summary: why });
const notApplicable = (p, why) => Object.assign(p, { status: "n/a", value: null, tone: "grey", summary: why });
const toneOf = (v) => (v >= 0.8 ? "good" : v >= 0.35 ? "warn" : "bad");
const score = (p, v, summary, extra = {}) => Object.assign(p, { value: Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000, tone: toneOf(v), summary, ...extra });

/* ---------- plain words ---------- */
// The modules write for analysts ("0x1890…ebff handed coins to 199 wallets that together hold 100.0%"). The reasons people read
// on the page, the card, X and Telegram say the same facts in one clear clause each. Numbers are kept exactly.
const pctW = (v) => `${String(Number(v).toFixed(1)).replace(/\.0$/, "")}%`;
const PLAIN = [
  [/the dev and the wallets tied to it sold (\d+(?:\.\d+)?)% of the coins they received \(the dev wallet itself (\d+(?:\.\d+)?)%\)/gi,
    (m, a, b) => `${Number(a) >= 99.5 ? "wallets linked to the dev have sold everything they got" : `wallets linked to the dev have sold ${pctW(a)} of what they got`}; ${Number(b) === 0 ? "the dev wallet itself hasn't sold any" : `the dev wallet itself sold ${pctW(b)} of its coins`}`],
  [/(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}) \(the dev\) handed coins to (\d+) wallets that together hold (\d+(?:\.\d+)?)%/g, (m, w, n, x) => `the dev spread coins to ${n} wallets, and together they hold ${pctW(x)} of the supply`],
  [/(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}) handed coins to (\d+) wallets that together hold (\d+(?:\.\d+)?)%/g, (m, w, n, x) => `one wallet (${w}) spread coins to ${n} others, and together they hold ${pctW(x)} of the supply`],
  [/the dev wallet sold (\d+(?:\.\d+)?)% of the coins it received/gi, (m, a) => (Number(a) >= 99.5 ? "the dev has sold all of its coins" : `the dev has sold ${pctW(a)} of its coins`)],
  [/the dev wallet holds (\d+(?:\.\d+)?)% of the supply/gi, (m, a) => `the dev still holds ${pctW(a)} of the supply`],
  [/wallets that bought in the first 30 seconds \((\d+)\) still hold (\d+(?:\.\d+)?)% of the supply/gi, (m, n, x) => `${n} wallets that bought in the first 30 seconds still hold ${pctW(x)} of the supply`],
  [/the dev wallet removed liquidity worth (\d+(?:\.\d+)?)% of the supply from a pool/gi, (m, a) => `the dev pulled liquidity worth ${pctW(a)} of the supply`],
  [/the dev wallet sent coins to (\d+) other wallets \((\d+(?:\.\d+)?)% of the supply\)/gi, (m, n, a) => `the dev sent ${pctW(a)} of the supply to ${n} other wallets`],
  [/(\d+) wallets that buy and sell the same amounts \(bots or wash trading\) made (\d+(?:\.\d+)?)% of all trades(?:: the volume looks bigger than real demand)?/gi, (m, n, x) => `${pctW(x)} of all trades come from ${n} wallets trading the same amounts back and forth (bots or wash trading)`],
  [/the 10 biggest wallets hold (\d+(?:\.\d+)?)% of the supply/gi, (m, a) => `the 10 biggest wallets hold ${pctW(a)} of the supply`],
];
export function plainText(s) {
  let t = String(s || "");
  for (const [re, fn] of PLAIN) t = t.replace(re, fn);
  // a rewritten clause that opens a sentence starts with a capital
  return t.replace(/(^|[.:!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
/** The dev side in one sentence, from devlinks' own numbers (linked wallets, what they hold, what they sold). */
export function devsideSentence(dl) {
  const n = dl?.linked?.count, ds = dl?.devSide;
  if (n == null || !ds) return null;
  const hold = n ? `${n} wallet${n === 1 ? " is" : "s are"} linked to the dev and hold${n === 1 ? "s" : ""} ${pctW(dl.linked.holdsPct || 0)} of the supply` : "No wallets linked to the dev were found";
  const dev = ds.devHoldsPct >= 0.01 ? `the dev itself holds ${pctW(ds.devHoldsPct)}` : null;
  const sold = ds.soldPct > 0 ? (ds.soldOfGotPct >= 99.5 ? "the dev side has sold everything it got" : `the dev side has sold ${pctW(ds.soldOfGotPct)} of what it got`) : null;
  return `${[hold, dev, sold].filter(Boolean).join("; ")}.`;
}

/* ---------- the parts ---------- */
const CORE = ["route", "impact", "depth", "fee", "sim", "sell", "tax"];
const TRANSIENT = /\b(busy|timed? ?out|timeout|rate.?limit|429|50[234]|ECONN\w*|ENOTFOUND|EAI_AGAIN|socket|could not reach|upstream|try again|temporarily|unavailable)\b/i;
const NO_SELL_ROUTE = /no route to sell it back/i;
const EMPTY_CURVE = /holds no buyers|too little/i;

export function gatePart(g, A) {
  const p = part("gate", { links: [links.gate(A), { label: "Raw result (JSON)", href: `/api/badge/${A}` }] });
  if (!g) return notRead(p, "Not read: the simulated buy and test sell did not finish in time. Open the Gate page to run it.");
  const checks = Array.isArray(g.checks) ? g.checks : [];
  if (!checks.length || g.verdict === "error") return notRead(p, `Not read: the Gate could not run just now${g.error ? ` (${noDot(String(g.error).slice(0, 120))})` : ""}.`);
  const core = checks.filter((c) => CORE.includes(c.key));
  p.evidence = core.map((c) => ({ label: c.label, status: c.status, text: noDot(c.detail) }));
  p.checkedAt = g.checkedAt || null;
  const curve = !!g.curve;
  // the failing check that matters most (fees and the sell side before the route, the route before depth), not the first
  // listed: GREM read "impact 89%" first while its fee was 85% (impact includes the fee), so it was called a thin pool
  const RANK_FAIL = { sell: 0, sim: 1, tax: 2, fee: 3, route: 4, depth: 5, impact: 6 };
  const fails = core.filter((c) => c.status === "fail" && !(curve && c.key === "depth")).sort((a, b) => (RANK_FAIL[a.key] ?? 9) - (RANK_FAIL[b.key] ?? 9));
  let fail = fails[0] || null;
  // a route that failed because a node or an API was busy is no reading at all: not read, never a cap (HOOKR flipped 60 → 25)
  if (fail?.key === "route" && TRANSIENT.test(fail.detail || "")) return notRead(p, `Not read: the route could not be read just now (${noDot(String(fail.detail).slice(0, 120))}).`);
  const sell = core.find((c) => c.key === "sell");
  const noSell = sell?.status === "warn" && NO_SELL_ROUTE.test(sell.detail || "");
  p.noSellRoute = noSell;
  if (fail) {
    const d = noDot(fail.detail).replace(/^(\S+%)\s*\(([^()]+)\)$/, "$1, $2");
    if (fail.key === "route") return score(p, 0, `Blocked: Troya finds no route to buy it (${d}).`, { cap: { at: CAPS.noRoute, why: "the Gate finds no route to buy it" }, short: "Troya finds no route to buy it." });
    // "too thin" only on a real depth reading under the floor; a high price impact over a deep pool is said as it is, no cap
    if (fail.key === "depth") return score(p, 0.2, `Blocked: the pool is too thin for a 0.01 ETH buy (only ${d} on the ETH side).`, { cap: { at: CAPS.thinFail, why: "the pool is too thin for a small buy" }, short: `The pool is too thin for even a small buy (${d}).` });
    if (fail.key === "impact") { const depth = core.find((c) => c.key === "depth"); return score(p, 0.3, `A 0.01 ETH buy would move the price ${d}${depth?.status === "pass" ? `, although the pool reads ${noDot(depth.detail)} deep` : ""}. Troya will not offer that buy.`, { short: `A small buy would move the price ${d}.` }); }
    p.notSellable = fail.key === "sell" || fail.key === "sim";
    const what = { sell: "the test sell failed, so it could not be sold back", sim: "the exact swap fails when simulated", tax: `too much is lost on every transfer (${d})`, fee: `fees and taxes are too high (${d})` }[fail.key] || `${lc(fail.label)} failed`;
    return score(p, 0, `Blocked: ${what}.${fail.key === "sell" || fail.key === "sim" ? ` ${d}.` : ""}`, { cap: { at: CAPS.gateFail, why: `the Gate failed: ${what}` }, short: `${cap1(what)}.` });
  }
  if (noSell) return score(p, 0.1, "A buy goes through, but Troya finds no route to sell it back, on Troya or through KyberSwap. You may only be able to sell on the launchpad's own site.", { cap: { at: CAPS.noSellRoute, why: "a buy works but no route sells it back" }, short: "You can buy it but there's no route to sell it back." });
  if (g.word === "untestable" || (sell?.status === "skip" && EMPTY_CURVE.test(sell.detail || ""))) return score(p, 0.5, "Not testable yet: the curve holds no buyers' ETH, so the test sell has nothing to sell against.", { short: "Nobody has bought yet, so a sell back can't be tested." });
  const W = { sell: 0.4, tax: 0.45, fee: 0.6, depth: 0.7, impact: 0.75, sim: 0.6, route: 0.6 };
  const warns = core.filter((c) => c.status === "warn");
  if (warns.length) {
    const worst = warns.reduce((a, c) => ((W[c.key] ?? 0.6) < (W[a.key] ?? 0.6) ? c : a));
    return score(p, W[worst.key] ?? 0.6, `Passed with notes. ${worst.label}: ${noDot(worst.detail)}.`, { short: `The Gate passed it with a note: ${lc(worst.label)}.` });
  }
  const sold = sell?.status === "pass" ? "a test sell went back through" : "nothing failed";
  return score(p, 1, `Passed: a simulated 0.01 ETH buy succeeded and ${sold}${core.find((c) => c.key === "tax" && c.status === "pass") ? ", with no transfer tax" : ""}.`, { short: "The Gate's simulated buy and test sell both went through." });
}

export function ringPart(g, r, A) {
  const p = part("ring", { links: [links.gate(A)] });
  const line = (g?.checks || []).find((c) => c.key === "ring");
  if (!g?.checks?.length && !(r?.verdict && r.verdict !== "unknown")) return notRead(p, "Not read: it is read with the Gate, which did not finish.");
  if (r?.verdict === "unknown") return notApplicable(p, `Not a Pons launch Ring Radar can read${r.reasons?.[0] ? ` (${noDot(r.reasons[0]).replace(/^./, (c) => c.toLowerCase())})` : ""}.`);
  if (!r && line?.status === "warn" && /still reading/i.test(line.detail || "")) return notRead(p, "Not read yet: Ring Radar is still reading this launch. Check again in a minute.");
  const verdict = r?.verdict && r.verdict !== "unknown" ? r.verdict : line ? (line.status === "fail" ? "red" : line.status === "warn" ? "amber" : "clear") : null;
  if (!verdict) return notApplicable(p, "Not a Pons launch Ring Radar can read (it reads Pons launches up to about 2 days back).");
  if (r?.launch?.tx) p.links.push(links.tx(r.launch.tx, "Launch transaction"));
  if (r?.bundles?.[0]?.tx) p.links.push(links.tx(r.bundles[0].tx, "First bundle buy"));
  p.evidence = (r?.reasons || []).slice(0, 4).map((t) => ({ text: cap1(noDot(t)) }));
  if (!p.evidence.length && line?.detail) p.evidence = [{ text: noDot(line.detail) }];
  const why = noDot((r?.reasons || [])[0] || String(line?.detail || "").replace(/^(Rigged launch pattern|Needs a closer look):\s*/, ""));
  if (verdict === "red") return score(p, 0, `Red: a rigged launch pattern. ${cap1(why)}.`, { cap: { at: CAPS.ringRed, why: "Ring Radar flags a rigged launch" }, short: "Ring Radar flags a rigged launch pattern." });
  if (verdict === "amber") return score(p, 0.4, `Amber: the launch needs a closer look. ${cap1(why)}.`, { short: "Ring Radar says the launch needs a closer look." });
  return score(p, 1, "Clear: no snipe-tax exemptions beyond the dev, no bundle buys or reused bundlers in the first seconds.", { short: "Ring Radar found no rigged launch pattern." });
}

export function devsidePart(g, dl, A) {
  const p = part("devside", { links: [links.gate(A)] });
  const done = dl && ["pass", "warn", "fail"].includes(dl.status);
  if (!g?.checks?.length && !done) return notRead(p, "Not read: it is read with the Gate, which did not finish.");
  let line = (g?.checks || []).find((c) => c.key === "devlinks") || (done ? { key: "devlinks", status: "skip", detail: "" } : null);
  if (!line) return notApplicable(p, "Not measured for this token.");
  // the Gate's line is kept with its result for 10 minutes; a report finished since then (devlinks.mjs cache) is newer
  if (line.status === "skip" && done) line = { ...line, status: dl.status, detail: `${dl.label ? `${dl.label}. ` : ""}${String(dl.text || "").replace(/\.$/, "")}` };
  if (line.status === "skip") return notRead(p, `Not read: ${noDot(line.detail).replace(/^Not measured\s*/i, "not measured ").replace(/^./, (c) => c.toLowerCase())}.`);
  const sale = dl?.devSide?.lastSale;
  if (sale?.tx) p.links.push(links.tx(sale.tx, "Latest dev-side sale"));
  p.evidence = [{ text: noDot(line.detail) }];
  const said = (done && devsideSentence(dl)) || `${noDot(line.detail)}.`;
  if (line.status === "fail") return score(p, 0, `${dl?.label ? `${dl.label}. ` : ""}${said}`, { cap: { at: CAPS.devsideFail, why: "the dev side holds most of it or is selling" }, short: /selling now/i.test(line.detail) ? "The dev and wallets tied to it are selling now." : "The dev and wallets tied to it hold most of it." });
  if (line.status === "warn") return score(p, 0.4, said, { short: "The dev side wallets need a look." });
  return score(p, 1, said, { short: "The dev side wallets hold little and aren't selling." });
}

export function holdersPart(d, A) {
  const p = part("holders", { links: [links.holders(A), { label: "The Assay (JSON)", href: `/api/assay/${A}` }] });
  if (!d) return notRead(p, "Not read: The Assay did not answer in time.");
  if (d.status === "running") return notRead(p, "Not read yet: The Assay is still reading the coin's history. Check again in a minute.");
  if (d.status !== "done") return notRead(p, `Not read: The Assay could not read it${d.error ? ` (${noDot(String(d.error).slice(0, 100))})` : ""}.`);
  const flags = (d.flags || []).filter((f) => f.key !== "partial" && f.key !== "snipe");
  const red = flags.filter((f) => f.level === "red"), amber = flags.filter((f) => f.level === "amber");
  const partial = (d.flags || []).some((f) => f.key === "partial") || !!d.coverage?.partial;
  p.evidence = [...red, ...amber].slice(0, 5).map((f) => ({ status: f.level === "red" ? "fail" : "warn", label: f.title, text: noDot(f.detail) }));
  const facts = [d.holders?.top10Pct != null ? `top 10 wallets hold ${d.holders.top10Pct.toFixed(1)}%` : null, d.dev?.wallets?.length && d.dev.holdsPct != null ? `the dev holds ${d.dev.holdsPct.toFixed(1)}%` : null].filter(Boolean).join(", ");
  if (facts) p.evidence.push({ text: cap1(facts) });
  if (partial) p.evidence.push({ text: "Partial history: only the most recent transfers were read" });
  const v = 1 - 0.3 * red.length - 0.12 * amber.length;
  // explicit caps from The Assay's own numbers (27 Nov calibration: MOW 85 and PONS 88 read "No major flags" over a dump and
  // over wash trading). Every one that applies is listed; the lowest becomes the part's cap
  const caps = [];
  if (red.find((f) => f.key === "lp-pulled")) caps.push({ at: CAPS.lpPulled, why: "the dev pulled liquidity" });
  const devSold = Number(d.dev?.soldPct) || 0, sideSold = Number(d.devSide?.soldOfGotPct) || 0;
  if (devSold >= 80 && sideSold >= 80) caps.push({ at: CAPS.devSoldBoth, why: `the dev wallet sold ${Math.round(devSold)}% of its coins and the wallets linked to it sold ${Math.round(sideSold)}% of what they got` });
  else if (devSold >= 80) caps.push({ at: CAPS.devSold, why: `the dev wallet sold ${Math.round(devSold)}% of its coins` });
  else if (sideSold >= 80) caps.push({ at: CAPS.devSold, why: `the wallets linked to the dev sold ${Math.round(sideSold)}% of what they got` });
  const wash = Number(d.wash?.washPct) || 0;
  if ((d.wash?.trades || 0) >= 50 && wash >= 70) caps.push({ at: CAPS.washVeryHigh, why: `${Math.round(wash)}% of all trades look like bots or wash trading` });
  else if ((d.wash?.trades || 0) >= 50 && wash >= 50) caps.push({ at: CAPS.washHigh, why: `${Math.round(wash)}% of all trades look like bots or wash trading` });
  caps.sort((a, b) => a.at - b.at);
  // the flag that set the lowest cap leads, so the headline names the reason for the cap
  const lead = caps.length && /wash/.test(caps[0].why) ? red.find((f) => f.key === "wash") || amber.find((f) => f.key === "wash") : caps.length && /dev/.test(caps[0].why) && !/liquidity/.test(caps[0].why) ? red.find((f) => f.key === "dev-sold") || amber.find((f) => f.key === "dev-sold") : null;
  const top = lead || red[0] || amber[0];
  if (!top) return score(p, 1, `No red or amber flags in what was measured${facts ? ` (${facts})` : ""}.`, { short: "The Assay found no red or amber flags in the holders." });
  const out = score(p, v, `${red.length ? `${red.length} red` : ""}${red.length && amber.length ? " and " : ""}${amber.length ? `${amber.length} amber` : ""} flag${red.length + amber.length > 1 ? "s" : ""}: ${noDot(top.detail)}.`,
    { short: `${noDot(top.detail)}.`, ...(caps.length ? { cap: caps[0], caps } : {}) });
  // a red flag or a cap reads as red on the page and the card, whatever the points say
  if (red.length || caps.length) out.tone = "bad";
  return out;
}

const usd = (v) => (v == null || !isFinite(v) ? null : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Number(v).toFixed(v < 10 ? 2 : 0)}`);
export function marketPart(tok, A) {
  const p = part("market", { links: [links.dex(A), links.explorer(A)] });
  if (!tok) return notRead(p, "Not read: no pool on the Robinhood Chain board or DexScreener answered.");
  const liq = tok.realLiquidityUsd ?? tok.liquidityUsd ?? null;
  const holders = tok.holders ?? null;
  if (liq == null && holders == null) return notRead(p, "Not read: neither liquidity nor a holder count is known yet.");
  const lv = liq == null ? null : liq >= 100_000 ? 1 : liq >= 25_000 ? 0.8 : liq >= 5_000 ? 0.55 : liq >= 1_000 ? 0.3 : 0.1;
  const hv = holders == null ? null : holders >= 1000 ? 1 : holders >= 250 ? 0.75 : holders >= 50 ? 0.5 : holders >= 10 ? 0.25 : 0.1;
  const v = lv != null && hv != null ? 0.6 * lv + 0.4 * hv : lv ?? hv;
  const bits = [liq != null ? `${usd(liq)} of liquidity${tok.realLiquidityUsd != null ? " (the money side of its pools)" : ""}` : null, holders != null ? `${holders.toLocaleString("en-US")} holders` : null, tok.mcapUsd ? `market cap ${usd(tok.mcapUsd)}` : null].filter(Boolean);
  p.evidence = bits.map((t) => ({ text: cap1(t) }));
  const thin = liq != null && liq < 5_000;
  const short = thin ? `Thin liquidity: ${usd(liq)}.` : holders != null && holders < 50 ? `Only ${holders} holders so far.`
    : liq != null ? `${usd(liq)} of liquidity${holders != null ? ` and ${holders.toLocaleString("en-US")} holders` : ""}.` : `${holders.toLocaleString("en-US")} holders.`;
  return score(p, v, `${cap1(bits.join(", "))}.`, { short });
}

export function heelPart(h, A) {
  const p = part("heel", { links: [links.heel(A)] });
  if (!h) return notRead(p, "Not read: Heel did not finish in time.");
  if (h.kind && h.kind !== "coin") return notApplicable(p, "Heel did not read it as a coin.");
  const SEV = { none: 1, low: 0.8, medium: 0.55, high: 0.25, critical: 0 };
  if (h.partial && (h.severity || "none") === "none") return notRead(p, "Not read yet: Heel was still reading some sources.");
  const top = h.facts?.[0];
  if (top?.evidence?.url) p.links.push({ label: "Heel's evidence", href: top.evidence.url });
  p.evidence = (h.facts || []).slice(0, 3).map((f) => ({ text: noDot(f.text) }));
  const v = SEV[h.severity] ?? 1;
  const said = noDot(h.heel).replace(/^Heel:\s*/, "");
  // the headline keeps the finding's first clause ("Its $224M market cap is backed by only $15.5k of real money"), the
  // page keeps all of it
  const first = noDot(said.split(/:\s+(?=[A-Z])|;\s+|\s+\((?![^)]*%\))/)[0]).slice(0, 140);
  return score(p, v, `Weakest spot: ${said}.`, { short: v < 0.6 ? `${first.replace(/^./, (c) => c.toUpperCase())}.` : "Heel found no serious weak spot." });
}

export function clashPart(c, sym, A) {
  const p = part("clash");
  if (!c) return notRead(p, "Not read: other contracts on this ticker could not be listed.");
  if (!c.clash || !c.others?.length) return score(p, 1, c.count > 1 ? `The official contract for ${c.ticker}.` : `No other contract on Robinhood Chain uses the ticker ${c.ticker || sym}.`, { short: "No other contract uses its ticker." });
  const n = c.others.length;
  p.evidence = c.others.slice(0, 4).map((o) => ({ text: `${o.symbol || "?"} ${o.address}${o.bornAt ? `, born ${new Date(o.bornAt).toISOString().slice(0, 10)}` : ""}` }));
  if (c.oldest && lc(c.oldest) !== lc(A)) p.links.push({ label: "Check the oldest one", href: `/check/${getAddress(c.oldest)}` });
  if (c.thisOne === "oldest") return score(p, 0.8, `${n} other contract${n === 1 ? "" : "s"} use${n === 1 ? "s" : ""} the ticker ${c.ticker}. This one is the oldest.`, { short: `${n} other contract${n === 1 ? "" : "s"} share its ticker; this one is the oldest.` });
  return score(p, 0.2, `${n} other contract${n === 1 ? "" : "s"} use${n === 1 ? "s" : ""} the ticker ${c.ticker}, and this one is not the oldest. Check the address.`, { short: `${n} other contract${n === 1 ? "" : "s"} use its ticker, and this one isn't the oldest.` });
}

export function agePart(bornAt, src, A, now = Date.now()) {
  const p = part("age", { links: [links.explorer(A)] });
  if (!bornAt) return notRead(p, "Not read: the token's creation block could not be found.");
  const h = (now - bornAt) / 3600_000;
  const v = h < 1 ? 0.25 : h < 24 ? 0.55 : h < 168 ? 0.8 : 1;
  const age = h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.floor(h / 24)} days`;
  return score(p, v, `${age} old: born ${new Date(bornAt).toISOString().slice(0, 16).replace("T", " ")} UTC${src === "pool" ? " (the date of its first pool)" : ", read from its creation block"}.`, { short: h < 24 ? `It is only ${age} old.` : `It is ${age} old.` });
}

// Contract powers (27 Nov): what the token's owner can still do, from tokenHealth (robinhood.mjs: function selectors found in the
// deployed bytecode, owner(), the EIP-1967 proxy slot) plus the proxy's admin slot. Selectors are a heuristic, not an audit.
const ZERO_OR_DEAD = /^0x(0{40}|0{38}01|0{36}dead)$/i;
export function powersPart(h, A) {
  const p = part("powers", { links: [{ label: "Contract code", href: `${EXPLORER}/address/${A}?tab=contract` }, { label: "Token health (JSON)", href: `/api/token/health?address=${A}` }] });
  if (!h || h.error) return notRead(p, `Not read: the token's code could not be read just now${h?.error ? ` (${noDot(String(h.error).slice(0, 100))})` : ""}.`);
  if (h.isContract === false) return notApplicable(p, "There is no contract at this address.");
  const fn = h.functions || {};
  const has = (k) => (fn[k] || []).length > 0;
  const sigs = (k) => (fn[k] || []).slice(0, 2).join(", ");
  const ownerActive = !!h.owner && h.ownerRenounced === false;
  const upgradeable = !!h.proxy && /upgradeable/i.test(h.proxy.type || "");
  const adminLive = upgradeable && (h.proxyAdmin ? !ZERO_OR_DEAD.test(h.proxyAdmin) : ownerActive);
  if (h.kind === "pons" && !h.owner && !upgradeable) {
    p.findingKind = "info";
    return score(p, 1, "A Pons template coin: fixed supply, no owner() and no upgrade path, so nobody can mint, blacklist, pause or change its fees.", { short: "No owner powers: a Pons template coin." });
  }
  const live = [], caps = [];
  let v = 1;
  if (ownerActive && has("mint")) { v -= 0.6; live.push(`mint (${sigs("mint")})`); caps.push({ at: CAPS.powersMint, why: "an active owner can mint more of it" }); }
  if (ownerActive && has("blacklist")) { v -= 0.4; live.push(`blacklist (${sigs("blacklist")})`); }
  if (ownerActive && has("pause")) { v -= 0.3; live.push(`pause (${sigs("pause")})`); }
  if (ownerActive && has("trading")) { v -= 0.3; live.push(`trading switch (${sigs("trading")})`); }
  if (ownerActive && (has("blacklist") || has("pause") || has("trading"))) caps.push({ at: CAPS.powersTrap, why: "an active owner can blacklist wallets, pause transfers or switch trading off" });
  if (ownerActive && has("fees")) { v -= 0.2; live.push(`fee setter (${sigs("fees")})`); caps.push({ at: CAPS.powersFees, why: "an active owner can change fees or taxes (no hard maximum read)" }); }
  if (ownerActive && has("limits")) { v -= 0.1; live.push(`limits (${sigs("limits")})`); }
  // powers in the code but no owner() to say who holds them (role-based control is not read here): said, lowered, never capped
  const orphan = ["mint", "blacklist", "pause", "trading", "fees"].filter((k) => !h.owner && has(k));
  if (orphan.length) { v -= 0.35; live.push(`${orphan.join(", ")} functions (${orphan.map(sigs).join(", ")}) with no owner() to show who can call them`); }
  if (adminLive) { v -= 0.4; live.push(`upgradeable proxy (implementation ${short(h.proxy.implementation)}${h.proxyAdmin && !ZERO_OR_DEAD.test(h.proxyAdmin) ? `, admin ${short(h.proxyAdmin)}` : ", upgraded by its owner"})`); caps.push({ at: CAPS.powersUpgrade, why: "it is an upgradeable proxy with a live admin: the code can be changed" }); }
  else if (upgradeable) { v -= 0.3; live.push(`upgradeable proxy (implementation ${short(h.proxy.implementation)}; who can upgrade it was not found)`); }
  p.evidence = [
    { text: h.owner ? `owner() = ${h.owner}${h.ownerRenounced ? " (renounced)" : ""}` : "No owner() function in the contract" },
    ...live.map((x) => ({ status: "fail", text: x })),
    ...(h.flags || []).filter((x) => x.level === "risk" || x.level === "warn").slice(0, 3).map((x) => ({ status: x.level === "risk" ? "fail" : "warn", text: noDot(x.text) })),
  ];
  if (!live.length) {
    const why = !h.owner ? "the contract has no owner()" : h.ownerRenounced ? `ownership is renounced (owner() = ${short(h.owner)})` : "no mint, blacklist, pause, trading, fee or limit functions were found";
    return score(p, 1, `No live owner powers: ${why}${upgradeable ? "" : ", and it is not an upgradeable proxy"}.`, { short: "No live owner powers in the contract." });
  }
  caps.sort((a, b) => a.at - b.at);
  const first = live[0].replace(/ \(.*$/, "");
  const out = score(p, v, `${ownerActive ? `An active owner (${short(h.owner)}) can still use` : "The contract keeps"} ${live.length === 1 ? "one power" : `${live.length} powers`}: ${live.join("; ")}.`,
    { short: caps[0]?.at === CAPS.powersMint ? "Its owner can still mint more of it." : caps[0]?.at === CAPS.powersTrap ? "Its owner can still block wallets or stop trading." : caps[0]?.at === CAPS.powersUpgrade ? "Its code can still be changed (upgradeable proxy)." : `Its owner keeps a ${first}.`,
      ...(caps.length ? { cap: caps[0], caps } : {}) });
  if (caps.length) out.tone = "bad";
  return out;
}

// Phase 2: the claims a coin makes on its website and X account, each checked against the chain (checkclaims.mjs). cl =
// readClaims() + verified: [{ type, quote, url, status: proven | contradicted | unverified, evidence, link }].
const CLAIM_TYPE_NAMES = { lp: "Liquidity locked or burned", renounced: "Ownership renounced", tax: "Tax", supply: "Total supply", burn: "Supply burned", audit: "Audit", team: "Team", live: "Product live", listing: "Listing", partner: "Partnership" };
const KEY_CLAIMS = new Set(["lp", "renounced", "tax", "supply", "burn"]);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const clipQ = (q, n = 70) => (String(q).length > n ? `${String(q).slice(0, n - 1).replace(/\s+\S*$/, "")}…` : String(q));
export function claimsPart(cl) {
  const p = part("claims");
  if (!cl) return notRead(p, "Not read: the website and X posts were not read in time.");
  const srcs = cl.sources || [];
  p.links = srcs.filter((x) => x.ok).map((x) => ({ label: x.kind === "website" ? "Website" : "X account", href: x.url }));
  if (!cl.website && !cl.x) return notApplicable(p, "No website or X account is known for this coin, so there were no claims to read.");
  const ok = srcs.filter((x) => x.ok);
  const where = ok.map((x) => (x.kind === "website" ? `its website (${hostOf(x.url)})` : "its X posts")).join(" and ");
  if (!ok.length) return notRead(p, `Not read: ${srcs.map((x) => `${x.kind === "website" ? `the website (${hostOf(x.url) || x.url})` : "X"}: ${x.why || "no answer"}`).join("; ")}.`);
  const v = (cl.verified || []).filter((c) => c && c.quote && c.url);
  if (!v.length) return notApplicable(p, `No checkable claim found on ${where}${cl.model ? "" : " (fixed patterns only: the reader model is off)"}.`);
  p.claims = v.map((c) => ({ type: c.type, name: CLAIM_TYPE_NAMES[c.type] || c.type, quote: c.quote, url: c.url, status: c.status, evidence: c.evidence, link: c.link || null }));
  p.evidence = v.map((c) => ({ status: c.status === "proven" ? "pass" : c.status === "contradicted" ? "fail" : "warn", label: `${CLAIM_TYPE_NAMES[c.type] || c.type}, ${c.status}`, text: `"${c.quote}" (${hostOf(c.url)}). ${noDot(c.evidence)}` }));
  const n = (st) => v.filter((c) => c.status === st).length;
  const pr = n("proven"), co = n("contradicted"), un = n("unverified");
  const val = (pr + 0.5 * un) / v.length;
  const bad = v.find((c) => c.status === "contradicted" && KEY_CLAIMS.has(c.type)) || null;
  const anyBad = bad || v.find((c) => c.status === "contradicted");
  const tally = `${v.length} claim${v.length === 1 ? "" : "s"} on ${where}: ${pr} proven, ${co} contradicted, ${un} unverified.`;
  const summary = anyBad ? `${tally} It says "${clipQ(anyBad.quote, 90)}", but ${noDot(anyBad.evidence).replace(/^./, (x) => x.toLowerCase())}.` : tally;
  const short = bad ? `It claims "${clipQ(bad.quote, 50)}", but the chain shows otherwise.` : anyBad ? `A claim on its site doesn't hold up: "${clipQ(anyBad.quote, 50)}".` : pr ? `${pr} of its ${v.length} claim${v.length === 1 ? "" : "s"} check out on chain.` : `Its ${v.length} claim${v.length === 1 ? "" : "s"} could not be checked.`;
  return score(p, val, summary, { short, ...(bad ? { cap: { at: CAPS.claimFalse, why: `the project claims "${clipQ(bad.quote, 60)}" and the chain contradicts it` } } : {}) });
}

/* ---------- the verdict in pieces (the coin page and the dashboard rows) ---------- */
// Two sub-scores from the parts already read: "Exit" (can you get out: the Gate and Ring Radar) and "Holders" (who holds and
// what they do: the dev side and The Assay), each the weighted share of its parts' values, with a word for where it sits.
const EXIT_WORDS = [[67, "clear"], [34, "risky"], [0, "blocked"]], HOLD_WORDS = [[67, "spread"], [34, "concentrated"], [0, "rigged"]];
const wordOf = (v, words) => (v == null ? null : words.find(([m]) => v >= m)[1]);
export function subScores(parts) {
  const pick = (keys) => parts.filter((p) => keys.includes(p.key) && p.status === "scored" && p.weight > 0);
  const avg = (keys) => { const ps = pick(keys); if (!ps.length) return null; const w = ps.reduce((t, p) => t + p.weight, 0); return Math.round((100 * ps.reduce((t, p) => t + p.weight * p.value, 0)) / w); };
  const line = (keys) => { const ps = pick(keys).sort((a, b) => a.value - b.value); return ps[0] ? ps[0].short || ps[0].summary : null; };
  const exit = avg(["gate", "ring", "powers"]), holders = avg(["devside", "holders"]);
  return { exit, exitWord: wordOf(exit, EXIT_WORDS), exitLine: line(["gate", "ring", "powers"]), holders, holdersWord: wordOf(holders, HOLD_WORDS), holdersLine: line(["devside", "holders"]) };
}
/** Findings as a reader scans them: RISK, MISSING, WORKS, INFO, from the parts and the claims, each with its evidence links. */
export function findingsOf(parts) {
  const out = [];
  for (const p of parts) {
    if (p.key === "claims" && p.claims?.length) {
      for (const c of p.claims) out.push({ kind: c.status === "proven" ? "works" : c.status === "contradicted" ? "risk" : "missing", title: `Claim: ${c.name}`, text: `"${c.quote}". ${noDot(c.evidence)}.`, links: [c.link, { label: "Where it was found", href: c.url }].filter((l) => l && l.href) });
      continue;
    }
    const kind = p.findingKind || (p.status === "scored" ? (p.tone === "good" ? "works" : "risk") : p.status === "not read" ? "missing" : "info");
    out.push({ kind, title: p.name, text: p.summary, links: (p.links || []).slice(0, 3) });
  }
  const order = { risk: 0, missing: 1, works: 2, info: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}
/** What would move the verdict, from what was read: at most three short phrases. */
export function whatWouldChange(parts) {
  const P = (k) => parts.find((p) => p.key === k) || {};
  const out = [];
  const g = P("gate");
  if (g.noSellRoute) out.push("a route to sell it back opening, on Troya or through KyberSwap");
  else if (g.notSellable) out.push("the test sell going through");
  else if (g.cap && /fees and taxes/i.test(g.summary || "")) out.push("fees and taxes coming down");
  else if (g.cap && /no route to buy/i.test(g.summary || "")) out.push("a route to buy it appearing");
  else if (g.status === "scored" && g.value === 0.5) out.push("the first buyers arriving, so a sell back can be tested");
  const d = P("devside"), h = P("holders");
  if ((d.status === "scored" && d.value < 1) || (h.status === "scored" && /dev/i.test(h.summary || "") && h.tone !== "good")) out.push("the wallets linked to the dev selling what they still hold");
  if (h.status === "scored" && /round-trip|wash/i.test(h.summary || "")) out.push("real trading replacing the round-trip trades");
  else if (h.status === "scored" && /biggest wallets/i.test(h.summary || "") && h.tone !== "good") out.push("the biggest wallets spreading out");
  const unread = parts.filter((p) => CORE_PARTS.includes(p.key) && p.status === "not read").map((p) => p.name);
  if (unread.length) out.push(`${unread.join(", ")} being read`);
  const m = P("market");
  if (m.status === "scored" && m.value < 0.6) out.push("more liquidity and more holders");
  const a = P("age");
  if (a.status === "scored" && a.value < 0.8) out.push("time: it is still young");
  const pw = P("powers");
  if (pw.status === "scored" && pw.value < 1) out.unshift("the owner renouncing the powers it still holds");
  const c = P("claims");
  if (c.cap) out.push("the project correcting its claim, or the chain catching up with it");
  if (!out.length) out.push("a failed Gate check, the dev side starting to sell, or a rigged-launch finding");
  return out.slice(0, 3);
}
/** The coin's facts for the page (all read at check time; null where not read). */
function coinFacts(f) {
  const t = f.token || {};
  const dev = f.devlinks?.dev?.[0]?.wallet || f.assay?.dev?.wallets?.[0] || null;
  return { launchpad: t.launchpad || null, website: t.website || null, x: t.twitter || null, telegram: t.telegram || null, mcapUsd: t.mcapUsd ?? null, priceUsd: t.priceUsd ?? null,
    change1h: t.change1h ?? null, change24h: t.change24h ?? null, volume24hUsd: t.volume24hUsd ?? null, liquidityUsd: t.realLiquidityUsd ?? t.liquidityUsd ?? null, holders: t.holders ?? null,
    bornAt: f.bornAt || t.bornAt || null, dev: dev ? String(dev) : null };
}

/**
 * The score from the facts read at check time (pure: no network). f = { address, kind, symbol, name, gate, ring, devlinks,
 * assay, token, heel, clash, bornAt, bornSrc, now }. kind "stock" | "major" | "unknown" are named, never scored.
 */
export function scoreCheck(f) {
  const A = f.address;
  const base = { address: A, kind: f.kind || "coin", symbol: cleanSym(f.symbol) || null, name: String(f.name || "").slice(0, 60) || null, checkedAt: f.now || Date.now() };
  if (f.kind === "unknown") {
    return { ...base, score: null, label: "Not a token on Robinhood Chain", tone: "grey", headline: f.why || "There is no token at this address on Robinhood Chain.", reasons: [{ tone: "grey", text: f.why || "There is no token at this address on Robinhood Chain.", link: { label: "Blockscout", href: `${EXPLORER}/address/${A}` } }], parts: [], caps: [], gatePassed: false, partial: false };
  }
  const gate = gatePart(f.gate, A);
  if (f.kind === "stock" || f.kind === "major") {
    const what = f.kind === "stock" ? "a tokenized stock on Robinhood Chain" : "a major token on Robinhood Chain";
    const m = marketPart(f.token, A);
    const price = f.token?.priceUsd != null ? `Price ${f.token.priceUsd >= 1 ? `$${f.token.priceUsd.toFixed(2)}` : `$${Number(f.token.priceUsd).toPrecision(4)}`}${f.token.change24h != null ? ` (${f.token.change24h > 0 ? "+" : ""}${Number(f.token.change24h).toFixed(2)}% in 24 h)` : ""}.` : null;
    for (const p of [gate, m]) { p.weight = 0; }
    const reasons = [
      { tone: "grey", text: `${cap1(what)}, not a launch: it is not scored like a meme coin.`, link: links.token(A) },
      price ? { tone: "grey", text: price, link: links.dex(A) } : null,
      gate.status === "scored" ? { tone: gate.tone, text: `Troya Gate: ${gate.summary}`, link: links.gate(A) } : null,
    ].filter(Boolean).slice(0, 3);
    return { ...base, score: null, label: f.kind === "stock" ? "Tokenized stock" : "Major token", tone: "grey", headline: `${cap1(what)}, not a launch, so it gets no meme-coin score.`, reasons, parts: [gate, m], caps: [], gatePassed: gate.status === "scored" && gate.value >= 0.75 && !gate.cap, partial: gate.status === "not read", coin: coinFacts(f), priceUsd: Number(f.token?.priceUsd) > 0 ? Number(f.token.priceUsd) : null };
  }
  const parts = [gate, ringPart(f.gate, f.ring, A), devsidePart(f.gate, f.devlinks, A), holdersPart(f.assay, A), marketPart(f.token, A), heelPart(f.heel, A), clashPart(f.clash, base.symbol, A), agePart(f.bornAt, f.bornSrc, A, base.checkedAt), claimsPart(f.claims), powersPart(f.health, A)];
  for (const p of parts) { p.summary = plainText(p.summary); if (p.short) p.short = plainText(p.short); for (const e of p.evidence || []) if (e.text) e.text = plainText(e.text); }
  const read = parts.filter((p) => p.status === "scored" && p.weight > 0);
  const W = read.reduce((s, p) => s + p.weight, 0);
  const caps = parts.filter((p) => p.status === "scored" && (p.cap || p.caps)).flatMap((p) => (p.caps || [p.cap]).map((c) => ({ part: p.key, at: c.at, why: c.why })));
  if (gate.status !== "scored") caps.push({ part: "gate", at: CAPS.gateNotRead, why: "the Gate could not run, so nothing shows it can be sold back" });
  const unread = parts.filter((p) => CORE_PARTS.includes(p.key) && p.status === "not read");
  if (unread.length) caps.push({ part: unread[0].key, at: CAPS.unread, why: `${unread.map((p) => p.name).join(", ")} ${unread.length === 1 ? "was" : "were"} not read yet` });
  for (const p of read) p.points = +(p.weight * p.value).toFixed(1);
  // the three reasons: what set a cap first, then what cost the most points, then (if fewer than three) the strongest parts
  const bad = read.filter((p) => p.value < 1 || p.tone !== "good").map((p) => ({ p, k: (p.cap ? 1000 - p.cap.at : 0) + (p.tone === "bad" ? 100 : 0) + p.weight * (1 - p.value) })).sort((a, b) => b.k - a.k).map((x) => x.p);
  const good = read.filter((p) => p.value >= 0.8 && !bad.includes(p)).sort((a, b) => b.weight - a.weight);
  // two parts can tell the same fact (the dev side and The Assay both report dev-linked selling): show it once
  const seenShort = new Set();
  const pick = [...bad.filter((p) => p.weight * (1 - p.value) >= 1.5 || p.cap || p.tone === "bad"), ...good, ...bad].filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => { const k = String(p.short || p.summary || "").trim().toLowerCase(); if (!k || seenShort.has(k)) return false; seenShort.add(k); return true; }).slice(0, 3);
  const reasons = pick.map((p) => ({ part: p.key, tone: p.tone, text: `${p.name}: ${p.summary}`, short: p.short || p.summary, link: p.links[0] || null }));
  if (gate.status !== "scored" && reasons.length < 3) reasons.push({ part: "gate", tone: "grey", text: `${gate.name}: ${gate.summary}`, short: "The Gate could not run, so a sell back is not proven.", link: gate.links[0] });
  // "No major flags" only when nothing read badly and no reason shown is a warning: the label must match its own reasons
  const badPart = read.find((p) => p.tone === "bad");
  // any part read as a warning counts, shown among the three reasons or not (a small part can drop out of the reasons)
  const warnReason = reasons.find((x) => ["warn", "risky", "bad"].includes(x.tone)) || (() => { const w = read.find((p) => p.tone === "warn"); return w ? { part: w.key, tone: "warn" } : null; })();
  if (badPart || warnReason) { const w = badPart || read.find((p) => p.key === warnReason.part); caps.push({ part: w?.key || warnReason.part, at: CAPS.flagged, why: `${w?.name || "a check"} raised ${badPart ? "a red flag" : "a warning"}` }); }
  caps.sort((a, b) => a.at - b.at);
  let s = W ? Math.round((100 * read.reduce((t, p) => t + p.weight * p.value, 0)) / W) : null;
  if (s != null && caps.length) s = Math.min(s, caps[0].at);
  const enough = W >= MIN_READ_WEIGHT || (gate.status === "scored" && W >= MIN_READ_WITH_GATE);
  if (!enough) s = null;
  const band = bandOf(s);
  const partial = parts.some((p) => p.status === "not read" && /still|did not finish|in time/i.test(p.summary));
  return {
    ...base, score: s, label: enough ? band.label : "Not enough read", tone: enough ? band.tone : "grey",
    headline: enough ? (reasons[0]?.short || reasons[0]?.text || "") : "Too few checks could be read just now. Try again in a minute.",
    reasons, parts, caps, readWeight: W, partial,
    sub: subScores(parts), findings: findingsOf(parts), changes: whatWouldChange(parts), coin: coinFacts(f),
    priceUsd: Number(f.token?.priceUsd) > 0 ? Number(f.token.priceUsd) : null, notSellable: !!gate.notSellable,
    // Buy only after a passed Gate, and never while Ring Radar is red or the dev side fails (the Gate's own result is kept
    // 10 minutes, so a ring or dev-side read that finished after it still counts here; Swap runs the Gate again anyway)
    gatePassed: gate.status === "scored" && !gate.cap && !gate.noSellRoute && (f.gate?.word === "passed" || f.gate?.word === "notes")
      && !parts.some((p) => (p.key === "ring" || p.key === "devside") && p.status === "scored" && p.value === 0),
  };
}

/* ---------- reading the facts (the modules above, through their caches) ---------- */
async function gather(A, waitMs = WAIT_MS, hints = []) {
  const R = await import("./robinhood.mjs");
  const code = await R.rpc("robinhood", "eth_getCode", [A, "latest"], { timeoutMs: 12_000 }).catch((e) => { throw Object.assign(new HttpError(502, `Robinhood Chain could not be read just now (${e.message}). Try again in a minute.`), { expose: true }); });
  const now = Date.now();
  if (!code || code === "0x" || /^0xef0100/i.test(code)) return { address: A, kind: "unknown", why: code && /^0xef0100/i.test(code) ? "This is a wallet (an EIP-7702 account), not a token on Robinhood Chain." : "There is no contract at this address on Robinhood Chain, so it is not a token here.", now };
  const meta = await R.tokenMeta(A).catch(() => null);
  if (!meta || meta.symbol == null) return { address: A, kind: "unknown", why: "This contract is not a token Troya can read on Robinhood Chain (no ERC-20 name, symbol and supply).", now };
  const [M, S] = await Promise.all([import("./market.mjs"), import("./sentry.mjs").catch(() => null)]);
  const major = M.majorOf?.(A);
  const stock = !major && (M.isStock(A) || !!S?.isStock?.(A));
  const deadline = Date.now() + waitMs;
  const left = () => Math.max(500, deadline - Date.now());
  const tokP = within(M.getRobinhoodToken(A).then((r) => r?.token || null), left());   // no shorter cap: a cold coin took ~14 s here
  // the Gate, and once more when its route or pool reading failed: one failed quote must not flip a verdict (HOOKR read 60,
  // then "no route" minutes later). The second answer is the one used; an error or a timeout is "not read", never a fail
  const gateP = within(import("./badge.mjs").then(async (B) => {
    const g = await B.badgeResult(A).catch((e) => ({ verdict: "error", error: String(e?.message || e).slice(0, 160) }));
    const shaky = (g?.checks || []).some((c) => c.status === "fail" && ["route", "depth", "impact", "sim"].includes(c.key));
    if (!shaky || !B.badgeFresh) return g;
    const again = await within(B.badgeFresh(A).then((x) => ({ ...x, retried: true })), Math.max(1000, deadline - Date.now() - 1000), null);
    return again && (again.checks || []).length ? again : g;
  }), left());
  if (major || stock) {
    const [token, gate] = await Promise.all([tokP, gateP]);
    return { address: A, kind: major ? "major" : "stock", symbol: major?.symbol || token?.symbol || meta.symbol, name: major?.name || token?.name || meta.name, gate, token, now };
  }
  // Ring Radar: cache first; when it is empty a real read starts now, beside the rest (ringCheck joins the read the Gate
  // began) and is waited for within the budget, like Telegram's /gate; a slow read goes on and fills the cache for next time
  const ringP = within(import("./ringradar.mjs").then((m) => m.ringCached?.(A) || m.ringCheck(A)), left());
  const assayP = within(import("./assay.mjs").then((m) => m.assay(A, { deep: true, waitMs: left() })), left() + 500);
  // phase 2: the website and X claims, read beside the rest; checked once the Gate and The Assay are in (or out of time)
  const claimsP = within(tokP.then(async (tok) => {
    const CC = await import("./checkclaims.mjs");
    const cl = await CC.readClaims(A, { token: tok, hints });
    if (!cl.claims.length) return { ...cl, verified: [] };
    const [cf, g, as] = await Promise.all([CC.chainFacts(A), gateP, assayP]);
    return { ...cl, verified: await CC.verifyClaims(cl.claims, { address: A, gate: g, assay: as, ...cf, siteLinks: cl.siteLinks }) };
  }), left() + 1500);
  // contract powers: tokenHealth (bytecode selectors, owner(), the proxy slot) and, for a proxy, its EIP-1967 admin slot
  const healthP = within(R.tokenHealth(A).then(async (h) => {
    if (h?.proxy && /upgradeable/i.test(h.proxy.type || "")) {
      const slot = await R.rpc("robinhood", "eth_getStorageAt", [A, "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", "latest"]).catch(() => null);
      if (slot && /^0x[0-9a-f]+$/i.test(slot)) h = { ...h, proxyAdmin: "0x" + slot.slice(-40) };
    }
    return h;
  }).catch((e) => ({ error: String(e?.message || e).slice(0, 120) })), Math.min(left(), 15_000));
  const [token, gate, assay, heel, clash, bornAt, claims, health] = await Promise.all([
    tokP, gateP, assayP,
    within(import("./heel.mjs").then((m) => m.heel(A)), left()),
    within(M.nameClash(A), Math.min(left(), 8000)),
    within(import("./tokenage.mjs").then((m) => m.bornAt(A, { waitMs: Math.min(left(), 6000) })), Math.min(left(), 6500)),
    claimsP, healthP,
  ]);
  // Ring Radar and the dev side were read by the Gate itself: these are cache hits, never a second read
  // (a "still reading" line means the first read is under way: the cache is asked, never a second read)
  const RR = await import("./ringradar.mjs").catch(() => null);
  const ring = RR?.ringCached?.(A) || (await ringP);
  const devlinks = await import("./devlinks.mjs").then((m) => m.devLinksCached(A)).catch(() => null);
  const bornSrc = await import("./tokenage.mjs").then((m) => m.bornSource(A)).catch(() => null);
  return { address: A, kind: "coin", symbol: token?.symbol || gate?.symbol || meta.symbol, name: token?.name || gate?.name || meta.name, gate, ring, devlinks, assay, token, heel, clash, claims, health, bornAt: bornAt || token?.bornAt || null, bornSrc, now };
}

/* ---------- the cache, the queue and the record ---------- */
const memo = new Map();                       // address → { at, ttl, res } | { p }
let running = 0;
const waiters = [];
async function slot(fn) {
  if (running >= MAX_RUNNING) await new Promise((r) => waiters.push(r));
  running++;
  try { return await fn(); } finally { running--; waiters.shift()?.(); }
}
const cached = (A) => { const h = memo.get(lc(A)); return h?.res && Date.now() - h.at < h.ttl ? h.res : null; };

/** The check for one coin (cached 10 minutes; 1 minute while a part is still reading). via: x | telegram | web | api. */
// X and Telegram wait longer than a web page: a reply should carry as many parts as can be read
const WAIT_CHAT_MS = Math.max(WAIT_MS, Number(process.env.CHECK_WAIT_CHAT_MS) || 40_000);
export async function troyaCheck(address, { via = "web", by = null, record = true, waitMs = via === "x" || via === "telegram" ? WAIT_CHAT_MS : WAIT_MS, fresh: again = false, hints = [] } = {}) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a token address on Robinhood Chain (0x + 40 hex characters).");
  const A = getAddress(String(address).toLowerCase());
  const k = lc(A);
  // again: read once more past a cached partial answer (the parts that finished since are cache hits in their own modules)
  let res = again && (cached(A)?.partial || !settled(cached(A))) ? null : cached(A), fresh = false;
  if (!res) {
    let h = memo.get(k);
    if (!h?.p) {
      h = { p: slot(() => gather(A, waitMs, (hints || []).slice(0, 6))).then((f) => scoreCheck(f)) };
      memo.set(k, h);
      h.p.then((r) => { memo.set(k, { at: Date.now(), ttl: r.partial ? TTL_PARTIAL : TTL, res: r }); if (memo.size > 3000) memo.delete(memo.keys().next().value); }, () => { if (memo.get(k) === h) memo.delete(k); });
      fresh = true;
    }
    res = await h.p;
  }
  // every check asked from X or Telegram is kept; from the web, once per fresh computation (a reload is not a new check)
  if (record && store && complete(res) && (fresh || via === "x" || via === "telegram")) await saveRow(res, via, by).catch((e) => console.warn("[check] save", e.message));
  return { ...res, cached: !fresh };
}

/* ---------- the web: a cold coin is "reading", never "not enough read" on a first visit ---------- */
// A result people may see as the answer: a scored coin, or a stock, a major or an unknown address (those have no score).
// Complete (27 Nov, second calibration): a coin's answer is shown only once the Gate and every core part that applies (Ring
// Radar on a Pons coin, the dev side, the holders) has been read. Provisional scores jumped once the rest came in (DCTY and
// Rockstar 52 → 35, MOW 74 → 85, CASHCAT 74 → 90). Stocks, majors and unknown addresses have no parts to wait for.
export const complete = (r) => !!r && (r.kind !== "coin" || (r.score != null && !(r.parts || []).some((p) => CORE_PARTS.includes(p.key) && p.status === "not read")));
// what may stand once the time is up: the Gate was read and there is a score (shown with its "not read yet" cap)
export const usable = (r) => !!r && (r.kind !== "coin" || (r.score != null && (r.parts || []).some((p) => p.key === "gate" && p.status === "scored")));
export const settled = complete;
const WEB_BUDGET_MS = Math.max(20_000, Number(process.env.CHECK_WEB_BUDGET_MS) || 60_000);
const runs = new Map();                       // address → { at, p, done, res }: one background read per coin, the polls join it
/** The web's read of a coin: the cached answer when it is settled, else one background run (checkForChat's re-reads, up to
 *  WEB_BUDGET_MS) that keeps going after the request that started it. Returns the run. */
export function webRun(A) {
  const k = lc(A);
  const hit = cached(A);
  if (settled(hit)) return { done: true, res: { ...hit, cached: true }, p: Promise.resolve({ ...hit, cached: true }) };
  const old = runs.get(k);
  if (old && (!old.done || Date.now() - old.at < TTL_PARTIAL)) return old;
  const run = { at: Date.now(), done: false, res: null };
  // the first read gets the web's usual wait; the re-reads fill in what was still reading. Each answer is kept as it comes,
  // so the page can show the first score while the rest goes on
  run.p = checkForChat(A, { via: "web", budgetMs: WEB_BUDGET_MS, firstWaitMs: WAIT_MS, onResult: (r) => { run.res = r; } }).then((r) => { run.res = r; return r; }, (e) => { run.error = e; throw e; }).finally(() => { run.done = true; run.at = Date.now(); });
  run.p.catch(() => {});
  runs.set(k, run);
  if (runs.size > 500) for (const [key, v] of runs) if (v.done && Date.now() - v.at > TTL) runs.delete(key);
  return run;
}
/** GET /api/check/:address: the answer when there is one; otherwise { pending: true } while the reads go on (check.js polls).
 *  After the whole budget without a score the honest answer is returned with final: true; the page still says "reading". */
export async function webAnswer(address, waitMs = 8000) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a token address on Robinhood Chain (0x + 40 hex characters).");
  const A = getAddress(String(address).toLowerCase());
  const run = webRun(A);
  const t0 = Date.now();
  while (!run.done && !settled(run.res) && Date.now() - t0 < waitMs) await sleep(250);
  const r = run.res;
  if (run.error && !r) throw run.error;
  if (settled(r)) return publicResult(await enrich(r));
  // the budget is spent: the answer stands only when the Gate was read; otherwise the page keeps saying "still reading"
  if (run.done && usable(r)) return { ...publicResult(await enrich(r)), final: true };
  if (run.done) return { address: A, pending: false, stillReading: true, note: "Troya could not finish reading this coin within a minute (the Gate or other checks are slow right now). The reads go on; check again in a minute." };
  return { address: A, pending: true, startedAt: run.at, budgetSeconds: WEB_BUDGET_MS / 1000, note: "Troya is still reading this coin: the Gate's simulated buy and test sell, Ring Radar, the dev side, The Assay and Heel. Ask again in a few seconds." };
}

/**
 * X and Telegram (phase 2, cold start): one check within CHECK_WAIT_CHAT_MS, read again while parts are still reading and time
 * is left, so a slow coin is answered with a score instead of "not enough read". Recorded once, at the end.
 */
export async function checkForChat(address, { via = "telegram", by = null, hints = [], budgetMs = WAIT_CHAT_MS, firstWaitMs = budgetMs, pauseMs = 3000, onResult = null } = {}) {
  const end = Date.now() + budgetMs;
  let r = await troyaCheck(address, { via, by, hints, record: false, waitMs: Math.min(firstWaitMs, budgetMs) });
  onResult?.(r);
  for (let i = 0; i < 8 && !complete(r) && end - Date.now() > pauseMs + 4000; i++) {
    await sleep(pauseMs);
    r = await troyaCheck(address, { via, by, hints, record: false, fresh: true, waitMs: Math.max(3000, Math.min(end - Date.now() - 500, firstWaitMs)) });
    onResult?.(r);
  }
  // a check row (and its track-record price) is kept only for a complete answer
  if (store && complete(r)) await saveRow(r, via, by).catch((e) => console.warn("[check] save", e.message));
  return r;
}

async function saveRow(r, via, by) {
  const row = { address: r.address, symbol: r.symbol, kind: r.kind, score: r.score, label: r.label, tone: r.tone, reasons: (r.reasons || []).map((x) => ({ tone: x.tone, text: String(x.short || x.text).slice(0, 160) })),
    at: Date.now(), via: ["x", "telegram", "web", "api"].includes(via) ? via : "web", by: by ? String(by).replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) || null : null,
    // for the dashboard: the price at the check (since-check), the two sub-scores, the Gate (Buy) and the dev (dev record)
    p0: r.priceUsd ?? null, gatePassed: !!r.gatePassed, sub: r.sub ? { exit: r.sub.exit, holders: r.sub.holders } : null, dev: r.coin?.dev ? lc(r.coin.dev) : null, launchpad: r.coin?.launchpad || null };
  await store.update(FILE, [], (rows) => {
    const a = Array.isArray(rows) ? rows : [];
    row.track = trackOf(row, r, a);
    a.push(row);
    rowsMemo = null;
    return a.slice(-MAX_ROWS);
  });
}

/* ---------- the dashboard: trending coins joined with their latest check, one request ---------- */
let rowsMemo = null;                         // { at, rows }: data/checks.json, read at most every 15 s
async function cachedRows() {
  if (rowsMemo && Date.now() - rowsMemo.at < 15_000) return rowsMemo.rows;
  const rows = store ? await store.readJson(FILE, []) : [];
  rowsMemo = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] };
  return rowsMemo.rows;
}
/** The latest complete check per coin, with the price at the latest check that kept one. */
export function latestChecks(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (r.kind !== "coin" || r.score == null) continue;
    const k = lc(r.address), prev = out.get(k);
    const p0 = r.p0 ?? r.track?.p0 ?? null;
    out.set(k, { ...r, p0: p0 ?? prev?.p0 ?? null, checks: (prev?.checks || 0) + 1 });
  }
  return out;
}
const pctChange = (now, then) => (now > 0 && then > 0 ? Math.round(((now / then - 1) * 100) * 10) / 10 : null);
/** A board row and its latest check, in the shape the dashboard draws (market numbers only as the board has them). */
export function joinRow(t, c) {
  const m = t || {};
  return {
    address: getAddress(lc(m.address || c?.address)), symbol: cleanSym(m.symbol || c?.symbol) || null, name: String(m.name || "").slice(0, 60) || null, launchpad: m.launchpad || c?.launchpad || null,
    stock: !!m.stock, mcapUsd: m.mcapUsd ?? null, priceUsd: m.priceUsd ?? null, change1h: m.change1h ?? null, change24h: m.change24h ?? null, volume24hUsd: m.volume24hUsd ?? null,
    txns24h: m.txns24h ?? null, liquidityUsd: m.realLiquidityUsd ?? m.liquidityUsd ?? null, holders: m.holders ?? null, bornAt: m.bornAt ?? m.createdAt ?? null, spark: Array.isArray(m.spark) ? m.spark : null,
    check: c ? { score: c.score, label: c.label, tone: c.tone, headline: c.reasons?.[0]?.text || null, exit: c.sub?.exit ?? null, holders: c.sub?.holders ?? null, gatePassed: !!c.gatePassed,
      at: c.at, checks: c.checks || 1, sinceCheck: pctChange(m.priceUsd, c.p0) } : null,
  };
}
const boardMemo = new Map();                  // key → { at, v }
/** GET /api/check/board: trending coins + their checks, the checks lists, and the side panels. Cached 20 s per view. */
export async function boardView({ sort = "volume", dir = "desc", launchpad = "all" } = {}, now = Date.now(), deps = {}) {
  const key = `${sort}:${dir}:${launchpad}`;
  const hit = boardMemo.get(key);
  if (!deps.market && hit && now - hit.at < 20_000) return hit.v;
  const M = deps.market || (await import("./market.mjs"));
  const [board, rows] = await Promise.all([M.getRobinhoodTokens({ sort, dir, launchpad, limit: 60 }).catch(() => null), deps.rows || cachedRows()]);
  const latest = latestChecks(rows);
  const tokens = board?.tokens || [];
  const trending = tokens.map((t) => joinRow(t, latest.get(lc(t.address))));
  // the checks lists: every coin checked this week, with the board's numbers when the board has the coin
  const week = [...latest.values()].filter((c) => now - c.at < WEEK);
  const withMarket = (c) => joinRow(M.indexRow?.(c.address) ? { ...M.indexRow(c.address), spark: M.sparkFor?.(c.address) || null } : { address: c.address, symbol: c.symbol }, c);
  const counts = new Map();
  for (const r of rows) if (r.kind === "coin" && now - r.at < WEEK) counts.set(lc(r.address), (counts.get(lc(r.address)) || 0) + 1);
  const day = new Map();
  for (const r of rows) if (r.kind === "coin" && r.score != null && now - r.at < 86400e3) day.set(lc(r.address), (day.get(lc(r.address)) || 0) + 1);
  const checks = {
    latest: [...week].sort((a, b) => b.at - a.at).slice(0, 40).map(withMarket),
    mostChecked: [...week].sort((a, b) => (counts.get(lc(b.address)) || 0) - (counts.get(lc(a.address)) || 0) || b.at - a.at).slice(0, 40).map((c) => ({ ...withMarket(c), weekChecks: counts.get(lc(c.address)) || 0 })),
    highest: [...week].sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 40).map(withMarket),
    lowest: [...week].sort((a, b) => a.score - b.score || b.at - a.at).slice(0, 40).map(withMarket),
  };
  // side panels
  const live = [...runs.entries()].filter(([, v]) => !v.done).slice(0, 8).map(([a, v]) => { const t = M.indexRow?.(a); return { address: getAddress(a), symbol: cleanSym(t?.symbol) || null, startedAt: v.at }; });
  const seen = new Set();
  const just = [...rows].reverse().filter((r) => r.kind === "coin" && r.score != null && !seen.has(lc(r.address)) && seen.add(lc(r.address))).slice(0, 8)
    .map((r) => ({ address: getAddress(lc(r.address)), symbol: r.symbol, score: r.score, label: r.label, tone: r.tone, at: r.at }));
  const mostChecked24h = [...day.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, n]) => { const c = latest.get(a); return { address: getAddress(a), symbol: c?.symbol || null, score: c?.score ?? null, label: c?.label || null, tone: c?.tone || "grey", checks: n }; });
  // devs whose coins checked out: only from rows that kept the dev wallet (none before 27 Nov), so the panel can be empty
  const byDev = new Map();
  for (const c of latest.values()) if (c.dev) { const d = byDev.get(c.dev) || { dev: c.dev, coins: 0, good: 0 }; d.coins++; if (c.score >= 50) d.good++; byDev.set(c.dev, d); }
  const devs = [...byDev.values()].sort((a, b) => b.good - a.good || b.coins - a.coins).slice(0, 5).map((d) => ({ ...d, dev: getAddress(d.dev) }));
  const pads = new Map();
  for (const t of trending) if (t.launchpad) pads.set(t.launchpad, (pads.get(t.launchpad) || 0) + 1);
  const v = {
    name: "Troya Check board", at: now, updatedAt: board?.updatedAt || null, total: board?.total ?? tokens.length, trending, checks, live, just, mostChecked24h, devs,
    launchpads: [...pads.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n })),
    windows: { change: ["1h", "24h"], volume: "24h", trades: "24h" },
    sorts: ["volume", "mcap", "change", "liquidity", "newest", "txns", "holders"],
    note: "Market numbers from Troya's Robinhood Chain board. A coin with no complete Troya Check reads Not checked; nothing is filled in.",
  };
  if (!deps.market) boardMemo.set(key, { at: now, v });
  if (boardMemo.size > 50) boardMemo.delete(boardMemo.keys().next().value);
  return v;
}
/** The coin page's extras: every check of this coin, the dev's record from stored checks, and the board's sparkline. */
export async function enrich(r, deps = {}) {
  if (!r?.address) return r;
  const rows = deps.rows || (await cachedRows().catch(() => []));
  const k = lc(r.address);
  const history = rows.filter((x) => lc(x.address) === k && (x.score != null || x.kind !== "coin")).slice(-15).reverse().map((x) => ({ at: x.at, score: x.score, label: x.label, tone: x.tone, via: x.via }));
  const first = rows.find((x) => lc(x.address) === k && (x.p0 ?? x.track?.p0));
  let devRecord = null;
  const dev = r.coin?.dev ? lc(r.coin.dev) : null;
  if (dev) {
    const mine = [...latestChecks(rows).values()].filter((c) => c.dev === dev && lc(c.address) !== k);
    devRecord = { dev: getAddress(dev), checked: mine.length, good: mine.filter((c) => c.score >= 50).length, coins: mine.slice(0, 6).map((c) => ({ address: getAddress(lc(c.address)), symbol: c.symbol, score: c.score, tone: c.tone })) };
  }
  const M = deps.market || (await import("./market.mjs").catch(() => null));
  const spark = M?.sparkFor?.(r.address) || null;
  const p0 = first ? first.p0 ?? first.track?.p0 : null;
  return { ...r, history, devRecord, spark, sinceFirstCheck: first ? { at: first.at, change: pctChange(r.coin?.priceUsd ?? r.priceUsd, p0) } : null };
}

/* ---------- the track record: every tracked check graded at 1 hour and 24 hours (the rules fates.mjs uses) ---------- */
const H = 3600e3, DAY = 24 * H;
export const GRADE_ZERO = 0.1;                       // "went to zero": the 24 h price is at most 10% of the price at the check
// One graded check per coin per 24 hours, the first one: the same coin checked again an hour later is the same bet, and
// counting it twice would let a busy coin outweigh the rest. Stocks, majors and checks with no score are not graded.
export function trackOf(row, r, rows = []) {
  if (row.kind !== "coin" || row.score == null) return null;
  const dup = rows.some((x) => x.track && lc(x.address) === lc(row.address) && row.at - x.at < DAY && ["watching", "graded"].includes(x.track.status));
  if (dup) return { status: "dup" };
  if (r.notSellable) return { status: "watching", p0: r.priceUsd ?? null, notSellable: true };
  return r.priceUsd ? { status: "watching", p0: r.priceUsd } : { status: "no-price" };
}
/** One grading step for a tracked row (pure but for priceFn): fills p1h at 1 hour and grades at 24 hours. */
export async function gradeStep(row, now, priceFn) {
  const t = row.track;
  if (!t || t.status !== "watching") return false;
  const age = now - row.at;
  let changed = false;
  if (t.notSellable && age >= DAY) { Object.assign(t, { status: "graded", result: "not-sellable", gradedAt: now }); return true; }
  if (t.p1h == null && !t.tried1h && age >= H) { t.tried1h = true; t.p1h = await priceFn(row.address).catch(() => null); changed = true; }
  if (age >= DAY) {
    const p = await priceFn(row.address).catch(() => null);
    Object.assign(t, { p24h: p, status: "graded", gradedAt: now, result: t.notSellable ? "not-sellable" : !p || p <= t.p0 * GRADE_ZERO ? "zero" : p > t.p0 ? "up" : "down" });
    changed = true;
  }
  return changed;
}
const median = (a) => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
// a coin that could not be sold, or has no price left, counts as −100% in the median (as in Two Fates)
const change24 = (t) => (t.result === "not-sellable" || (t.result === "zero" && !(t.p24h > 0)) ? -100 : t.p0 > 0 && t.p24h > 0 ? (t.p24h / t.p0 - 1) * 100 : null);
export const SMALL_SAMPLE = 20;
/** The record by score band, from every graded row (nothing left out): GET /api/check/record. */
export function recordOf(rows, now = Date.now()) {
  const tracked = (rows || []).filter((x) => x.track && x.track.status !== "dup" && x.track.status !== "no-price" && x.score != null);
  const buckets = [[0, 24], [25, 49], [50, 74], [75, 100]].map(([lo, hi]) => {
    const inB = tracked.filter((x) => x.score >= lo && x.score <= hi);
    const graded = inB.filter((x) => x.track.status === "graded");
    const zero = graded.filter((x) => x.track.result === "zero" || x.track.result === "not-sellable").length;
    const ch = graded.map((x) => change24(x.track)).filter((v) => v != null);
    const label = bandOf(lo).label;
    return { band: `${lo}-${hi}`, label, tone: bandOf(lo).tone, tracked: inB.length, watching: inB.filter((x) => x.track.status === "watching").length, graded: graded.length,
      wentToZero: zero, notSellable: graded.filter((x) => x.track.result === "not-sellable").length, up24h: graded.filter((x) => x.track.result === "up").length,
      zeroPct: graded.length ? Math.round((zero / graded.length) * 1000) / 10 : null, median24h: ch.length ? Math.round(median(ch) * 10) / 10 : null,
      smallSample: graded.length < SMALL_SAMPLE };
  });
  const graded = buckets.reduce((s, b) => s + b.graded, 0);
  return {
    name: "Troya Check record", buckets, graded, watching: buckets.reduce((s, b) => s + b.watching, 0), at: now,
    note: !graded ? "No check has been graded yet: the first grades come 24 hours after the first checks." : graded < SMALL_SAMPLE * 2 ? `Only ${graded} check${graded === 1 ? "" : "s"} graded so far: too few to read much into yet.` : null,
    rules: "Every scored check of a coin is tracked, one per coin per 24 hours (the first). Its price at the check is compared with the price 1 hour and 24 hours later. Went to zero: the 24 h price is 10% of the price at the check or less, or there is no price any more. A coin the Gate could not sell in its test sell counts as a full loss. Checks with no price at the check are left out. Every graded check is counted; nothing is picked. What the price did, not a forecast or advice.",
  };
}
async function priceNow(a) {
  const M = await import("./market.mjs");
  const r = await M.getRobinhoodToken(a);
  const p = r?.pons;
  if (p && !p.graduated && p.priceInPair > 0 && p.pair?.address === "native") { const eu = Number(await M.getEthUsd()) || 0; if (eu) return p.priceInPair * eu; }
  const v = Number(r?.token?.priceUsd);
  return v > 0 ? v : null;
}
let grading = false;
async function gradeTick(now = Date.now()) {
  if (grading || !store) return;
  grading = true;
  try {
    const rows = await store.readJson(FILE, []);
    const due = new Map();                       // address → the price read once this round
    const price = (a) => { const k = lc(a); if (!due.has(k)) due.set(k, priceNow(a).catch(() => null)); return due.get(k); };
    const results = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row.track?.status !== "watching") continue;
      const copy = { ...row, track: { ...row.track } };
      if (await gradeStep(copy, now, price)) results.set(`${row.address}:${row.at}`, copy.track);
    }
    if (results.size) await store.update(FILE, [], (a) => { for (const x of Array.isArray(a) ? a : []) { const t = results.get(`${x.address}:${x.at}`); if (t) x.track = t; } return a; });
  } catch (e) { console.warn("[check] grade", e.message); }
  finally { grading = false; }
}

/** Recent checks and this week's boards, from data/checks.json. */
export async function dashboard(now = Date.now()) {
  const rows = store ? await store.readJson(FILE, []) : [];
  const all = Array.isArray(rows) ? rows : [];
  const week = all.filter((r) => now - r.at < WEEK);
  const latest = new Map();                 // address → its latest row this week
  for (const r of week) latest.set(lc(r.address), r);
  const coins = [...latest.values()].filter((r) => r.kind === "coin" && r.score != null);
  const counts = new Map();
  for (const r of week) if (r.kind === "coin" || r.kind === "stock" || r.kind === "major") counts.set(lc(r.address), (counts.get(lc(r.address)) || 0) + 1);
  const view = (r) => ({ address: r.address, symbol: r.symbol, kind: r.kind, score: r.score, label: r.label, tone: r.tone, reason: r.reasons?.[0]?.text || null, at: r.at, via: r.via });
  const seen = new Set();
  const recent = [...all].reverse().filter((r) => r.kind !== "unknown" && !seen.has(lc(r.address)) && seen.add(lc(r.address))).slice(0, 30).map(view);
  return {
    name: "Troya Check", total: all.length, thisWeek: week.length, coinsThisWeek: coins.length, recent,
    safest: [...coins].sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 10).map(view),
    flagged: [...coins].sort((a, b) => a.score - b.score || b.at - a.at).slice(0, 10).map(view),
    mostChecked: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a, n]) => ({ ...view(latest.get(a)), checks: n })),
    bands: BANDS, weights: WEIGHTS, caps: CAPS, at: now,
    note: "Automated checks, not an audit. A score is a snapshot of what Troya read from the chain at that moment, never a safe stamp.",
  };
}

/** What the API and the tools hand out. */
export function publicResult(r) {
  const A = r.address;
  return { ...r, page: `${SITE}/check/${A}`, card: `${SITE}/api/check/${A}/card.png`, swap: r.gatePassed ? `${SITE}/agent#/swap?out=${A}` : null,
    note: "Automated checks, not an audit. A snapshot from the chain at checkedAt; a coin can change after a check. Never a safe stamp and never advice to buy." };
}

/* ---------- X and Telegram ---------- */
const ADDR_RE = /0x[0-9a-fA-F]{40}/;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{0,15})\b/;
const CHECK_WORD = /\bcheck\b/i;
// "check your DMs", "check my profile", "check out our project" with no coin: not a check request
const NOT_A_CHECK = /\bcheck\s+(?:your|my|our|the)\s+(?:dms?|inbox|profile|bio|page|website|site|link|pinned|post|tweet)\b/i;
export const mentionsCheck = (text) => CHECK_WORD.test(String(text || "")) && !NOT_A_CHECK.test(String(text || ""));
/** "@Troyaagent check 0x…" → { address } · "check $TICKER" → { ticker } · "check" under a post with a CA → { address, fromParent }. */
export function parseCheckRequest(text, parent = null) {
  const t = String(text || "").replace(/https?:\/\/\S+/g, " ");
  if (!mentionsCheck(t)) return null;
  const a = ADDR_RE.exec(t)?.[0];
  if (a) return { address: getAddress(a.toLowerCase()) };
  const tk = TICKER_RE.exec(t)?.[1];
  if (tk) return { ticker: tk };
  const pa = ADDR_RE.exec(String(parent || "").replace(/https?:\/\/\S+/g, " "))?.[0];
  if (pa) return { address: getAddress(pa.toLowerCase()), fromParent: true };
  return null;
}

/** A $TICKER → one contract, or why not: { address } | { none: true } | { many: n, oldest } */
export async function resolveTicker(ticker) {
  const M = await import("./market.mjs");
  const S = await import("./sentry.mjs").catch(() => null);
  const key = (x) => { try { return S.tickerKey(x); } catch { return lc(x).replace(/[^a-z0-9]/g, ""); } };
  const k = key(ticker);
  const res = await M.searchCoins(ticker, 30).catch(() => null);
  const same = (res?.coins || []).filter((c) => ["coin", "stock", "major"].includes(c.kind) && c.address && /^0x/.test(c.address) && key(c.symbol) === k);
  if (!same.length) return { none: true };
  const official = same.find((c) => c.official) || (same.filter((c) => c.kind !== "coin").length === 1 ? same.find((c) => c.kind !== "coin") : null);
  if (official || same.length === 1) return { address: getAddress((official || same[0]).address) };
  const T = await import("./tokenage.mjs");
  const births = await Promise.all(same.map((c) => T.bornAt(c.address, { waitMs: 3000 }).catch(() => null)));
  const dated = same.map((c, i) => ({ c, at: births[i] })).filter((x) => x.at).sort((a, b) => a.at - b.at);
  return { many: same.length, oldest: dated[0] ? getAddress(dated[0].c.address) : null };
}

// a symbol as one X cashtag only when it is a plain ticker; anything else is written as the short address
const tagOf = (r) => (/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(r.symbol || "") ? `$${r.symbol}` : short(r.address));
const X_URL_LEN = 23;                          // X counts every link as 23 characters
/** The one-line reply on X (under 280 characters, at most one cashtag, the link on its own line, no media). */
export function xReplyText(r) {
  const link = `${SITE}/check/${r.address}`;
  if (r.kind === "unknown") return `${noDot(r.headline)}.`;
  let head;
  if (r.kind === "stock" || r.kind === "major") head = `${tagOf(r)} is ${r.kind === "stock" ? "a tokenized stock" : "a major token"} on Robinhood Chain, not a launch, so it gets no meme-coin score.`;
  else if (r.score == null) head = `${tagOf(r)}: too few checks could be read just now. Try again in a minute.`;
  // the verdict in plain words first, then the score (Xivor, 26 Nov 2026)
  else head = `${tagOf(r)}: ${lc(r.label)} (${r.score}/100). ${noDot(r.headline)}.`;
  let tags = 0;
  head = head.replace(/\$(?=[A-Za-z])/g, () => (tags++ ? "" : "$"));   // one cashtag at most (X refuses more)
  const room = 280 - X_URL_LEN - 1;
  if (head.length > room) head = head.slice(0, room - 1).replace(/\s+\S*$/, "") + "…";
  return `${head}\n${link}`;
}
/** A check request from X → { reply, address?, result? } (the caller posts it within its own caps). */
export async function xCheckReply(req, { by = null, hints = [] } = {}) {
  let address = req.address || null;
  if (!address && req.ticker) {
    const t = await resolveTicker(req.ticker);
    const tag = /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(req.ticker) ? `$${req.ticker}` : req.ticker;
    if (t.none) return { reply: `No coin called ${tag} found on Robinhood Chain. Reply "check" with its contract address.` };
    if (t.many) return { reply: `${t.many} contracts on Robinhood Chain use ${tag}, so Troya won't pick one. Reply "check" with the address you mean.${t.oldest ? `\nOldest: ${SITE}/check/${t.oldest}` : ""}`, many: t.many, address: t.oldest };
    address = t.address;
  }
  const r = await checkForChat(address, { via: "x", by, hints });
  // render the card before the reply goes out, so X's crawler finds it ready (a cold render took ~20 s, 27 Nov 2026)
  if (r && r.score != null) await Promise.race([cardFor(getAddress(lc(r.address || address))), sleep(30_000)]).catch(() => {});
  return xAnswer(r);
}
/** What X gets for a finished check: never "not enough read" (no score on a coin = no reply; logged, the next mention reads again). */
export function xAnswer(r) {
  if (!complete(r)) return { reply: null, silent: true, why: r.score == null ? "no score yet (not enough read): stayed silent" : "not every check was read in time (provisional score): stayed silent", address: r.address, result: r };
  return { reply: xReplyText(r), address: r.address, result: r };
}

const tgEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Telegram /check: short HTML, the score first, three reasons, the link (its preview is the card). */
export function tgText(r) {
  const link = `${SITE}/check/${r.address}`;
  // a check that did not complete is said as "still reading", never a provisional score
  if (!complete(r)) {
    const missing = (r.parts || []).filter((p) => CORE_PARTS.includes(p.key) && p.status === "not read").map((p) => p.name).join(", ") || "some checks";
    return [`<b>Troya Check</b> · ${r.symbol ? `$${tgEsc(r.symbol)}` : `<code>${short(r.address)}</code>`}`,
      `Still reading this coin: ${tgEsc(missing)} did not finish in time. Send /check again in a minute, or open <a href="${link}">the page</a>, which keeps reading.`,
      "<i>Automated checks, not an audit.</i>"].join("\n");
  }
  const name = r.symbol ? `$${tgEsc(r.symbol)}` : `<code>${short(r.address)}</code>`;
  if (r.kind === "unknown") return `<b>Troya Check</b> · <code>${r.address}</code>\n${tgEsc(r.headline)}`;
  const head = r.score != null ? `<b>${tgEsc(r.label)} · ${r.score}/100</b>` : `<b>${tgEsc(r.label)}</b>`;
  const mark = { good: "·", warn: "!", risky: "!", bad: "✕", grey: "·" };
  const lines = (r.reasons || []).slice(0, 3).map((x) => `${mark[x.tone] || "·"} ${tgEsc(x.text)}`);
  return [`<b>Troya Check</b> · ${name}`, head, ...lines, `<a href="${link}">Full check</a>${r.gatePassed ? ` · <a href="${SITE}/agent#/swap?out=${r.address}">Open in Swap</a> (the Gate runs again before you sign)` : ""}`, "<i>Automated checks, not an audit.</i>"].join("\n");
}

/* ---------- the card: an SVG with the site's own fonts as paths, turned into a PNG by sharp ---------- */
let GL = null;
function faces() { return (GL ||= JSON.parse(readFileSync(join(HERE, "check-assets", "glyphs.json"), "utf8")).faces); }
const r1 = (n) => Math.round(n * 10) / 10;
const glyph = (f, ch) => f.glyphs[ch] || f.glyphs["?"];
function measure(face, s, size, ls = 0) {
  const f = faces()[face], k = size / f.upm, ch = [...String(s)];
  let w = 0;
  ch.forEach((c, i) => { w += glyph(f, c).a * k + (i < ch.length - 1 ? ls + (f.kern[c + ch[i + 1]] || 0) * k : 0); });
  return w;
}
const canDraw = (face, s) => [...String(s)].every((c) => faces()[face].glyphs[c]);
function clipText(face, s, size, maxW, ls = 0) {
  let t = String(s);
  if (measure(face, t, size, ls) <= maxW) return t;
  while (t && measure(face, `${t}…`, size, ls) > maxW) t = [...t].slice(0, -1).join("");
  return `${t.replace(/[\s,.;:]+$/, "")}…`;
}
const fitSize = (face, s, size, maxW, min) => Math.max(min, Math.min(size, (size * maxW) / Math.max(1, measure(face, s, size))));
function textSvg(face, s, x, y, size, fill, { align = "left", ls = 0, opacity = 1 } = {}) {
  const f = faces()[face], k = size / f.upm, ch = [...String(s)];
  const w = measure(face, s, size, ls);
  let pen = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const out = [];
  ch.forEach((c, i) => {
    const g = glyph(f, c);
    if (g.d) out.push(`<path transform="translate(${r1(pen)} ${r1(y)}) scale(${k.toFixed(5)})" d="${g.d}"/>`);
    pen += g.a * k + (i < ch.length - 1 ? ls + (f.kern[c + ch[i + 1]] || 0) * k : 0);
  });
  return `<g fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}>${out.join("")}</g>`;
}
// two lines at most, broken at spaces, the second cut with an ellipsis
function wrap2(face, s, size, maxW) {
  const words = String(s).split(/\s+/);
  let a = "";
  while (words.length && measure(face, (a ? a + " " : "") + words[0], size) <= maxW) a = (a ? a + " " : "") + words.shift();
  if (!a) return [clipText(face, words.join(" "), size, maxW)];
  return words.length ? [a, clipText(face, words.join(" "), size, maxW)] : [a];
}
const COL = { bg: "#0a0d10", fg: "#f5f9fb", fg2: "#d3dde2", muted: "#8b99a2", faint: "#5d6a72", accent: "#8edff5", good: "#8edff5", warn: "#f0c46e", risky: "#f59a5b", bad: "#ff7d7d", grey: "#9fb0bf" };
let LOGO = undefined;
function logoUri() {
  if (LOGO !== undefined) return LOGO;
  try { LOGO = `data:image/png;base64,${readFileSync(join(HERE, "..", "public", "img", "logo-3d-128.png")).toString("base64")}`; } catch { LOGO = null; }
  return LOGO;
}
function stamp(t) {
  const d = new Date(t || Date.now());
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The card as SVG (1200 × 630). r = a check result, or { address, pending: true } while it runs. */
export function cardSvg(r) {
  const W = 1200, H = 630, A = r.address;
  const tone = r.pending ? "grey" : r.tone || "grey", tc = COL[tone] || COL.grey;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  o.push(`<defs><radialGradient id="g1" cx="170" cy="60" r="760" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5fd3ef" stop-opacity=".18"/><stop offset=".45" stop-color="#5fd3ef" stop-opacity=".05"/><stop offset="1" stop-color="#5fd3ef" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="g2" cx="960" cy="290" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${tc}" stop-opacity=".16"/><stop offset="1" stop-color="${tc}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="${tc}"/><stop offset="1" stop-color="${tc}"/></linearGradient></defs>`);
  o.push(`<rect width="${W}" height="${H}" fill="${COL.bg}"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>`);
  for (let y = 0; y < H; y += 7) o.push(`<rect x="0" y="${y}" width="${W}" height="1" fill="#ffffff" fill-opacity=".014"/>`);
  o.push(`<rect x="16.75" y="16.75" width="${W - 33.5}" height="${H - 33.5}" rx="28" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="1.5"/>`);
  // header: the mark, TROYA CHECK, the time of the check
  const logo = logoUri();
  if (logo) o.push(`<image x="60" y="48" width="56" height="56" href="${logo}"/>`);
  const hx = logo ? 132 : 64;
  o.push(textSvg("mono500", "TROYA CHECK", hx, 85, 19, COL.accent, { ls: 4.2 }));
  o.push(textSvg("mono500", r.pending ? "checking now" : `checked ${stamp(r.checkedAt)}`, W - 64, 84, 16, COL.muted, { align: "right" }));
  // the coin
  const L = 64, maxW = 640;
  const sym = r.symbol && canDraw("sans600", `$${r.symbol}`) ? `$${r.symbol}` : short(A);
  const hs = fitSize("sans600", sym, 72, maxW, 40);
  o.push(textSvg("sans600", clipText("sans600", sym, hs, maxW), L, 214, hs, COL.fg, { ls: -1 }));
  o.push(textSvg("mono500", short(A), L, 254, 20, COL.muted));
  if (r.name && r.name !== r.symbol && canDraw("sans500", r.name)) o.push(textSvg("sans500", clipText("sans500", r.name, 20, maxW - 170), L + 168, 254, 20, COL.faint));
  // the three reasons, one line each (two when long)
  const reasons = r.pending ? [{ tone: "grey", text: "Troya Gate, Ring Radar, the dev side, The Assay and Heel are reading it now." }] : (r.reasons || []).slice(0, 3);
  let y = 322;
  for (const x of reasons) {
    const c = COL[x.tone] || COL.grey;
    const txt = String(x.short || x.text || "").replace(/[^ -~ -ÿ·–—…→’‘“”×−•]/g, "");
    const lines = wrap2("sans500", txt, 25, maxW - 36);
    o.push(`<circle cx="${L + 9}" cy="${y - 9}" r="6.5" fill="${c}" fill-opacity=".9"/>`);
    lines.forEach((ln, i) => o.push(textSvg("sans500", ln, L + 32, y + i * 33, 25, i ? COL.fg2 : COL.fg)));
    y += lines.length * 33 + 24;
  }
  // the score ring
  const cx = 960, cy = 282, R = 150;
  o.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="#ffffff" fill-opacity=".025" stroke="#ffffff" stroke-opacity=".09" stroke-width="16"/>`);
  if (r.score != null) {
    const C = 2 * Math.PI * R, f = Math.max(0.004, r.score / 100);
    o.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${tc}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${r1(C * f)} ${r1(C)}" transform="rotate(-90 ${cx} ${cy})"/>`);
    const big = String(r.score);
    o.push(textSvg("sans700", big, cx, cy + 46, 138, "url(#sg)", { align: "center", ls: -4 }));
    o.push(textSvg("mono500", "/ 100", cx, cy + 92, 20, COL.muted, { align: "center", ls: 2 }));
  } else {
    const word = r.pending ? "Checking" : r.kind === "stock" ? "Stock" : r.kind === "major" ? "Major" : r.kind === "unknown" ? "No token" : "Not read";
    o.push(textSvg("sans600", word, cx, cy + 18, fitSize("sans600", word, 52, 230, 30), COL.fg2, { align: "center" }));
    o.push(textSvg("mono500", r.pending ? "a few seconds" : "not scored", cx, cy + 62, 18, COL.muted, { align: "center", ls: 1 }));
  }
  // the label pill
  const label = (r.pending ? "Checking" : r.label || "").toUpperCase();
  const ps = fitSize("sans700", label, 20, 300, 13), pw = measure("sans700", label, ps, 2) + 44;
  o.push(`<rect x="${r1(cx - pw / 2)}" y="${cy + R + 30}" width="${r1(pw)}" height="44" rx="22" fill="${tc}" fill-opacity=".12" stroke="${tc}" stroke-opacity=".55" stroke-width="1.4"/>`);
  o.push(textSvg("sans700", label, cx, cy + R + 59, ps, tc, { align: "center", ls: 2 }));
  // footer
  o.push(textSvg("sans400", "Automated checks, not an audit.", L, 588, 18, COL.faint));
  o.push(textSvg("mono500", "troya.codes", W - 64, 588, 20, COL.accent, { align: "right", ls: 1 }));
  o.push("</svg>");
  return o.join("");
}

let sharpLib;                                   // undefined: not tried · null: could not load (the card answers with og.png)
async function getSharp() {
  if (sharpLib !== undefined) return sharpLib;
  try { sharpLib = (await import("sharp")).default; sharpLib.cache(false); }
  catch (e) { console.warn("[check] sharp could not load, cards fall back to og.png:", e.message); sharpLib = null; }
  return sharpLib;
}
export async function cardPng(r) {
  const sharp = await getSharp();
  if (!sharp) throw new Error("sharp unavailable");
  return sharp(Buffer.from(cardSvg(r))).png({ compressionLevel: 8 }).toBuffer();
}
const cards = new Map();                        // address → { key, at, png }
async function cardFor(A) {
  const run = webRun(A), t0 = Date.now();
  while (!run.done && !settled(run.res) && Date.now() - t0 < CARD_WAIT_MS) await sleep(300);
  const r = settled(run.res) || (run.done && usable(run.res)) ? run.res : null;
  const key = r ? `${r.checkedAt}` : "pending";
  const hit = cards.get(lc(A));
  if (hit && hit.key === key && Date.now() - hit.at < TTL) return { png: hit.png, done: !!r };
  const png = await cardPng(r || { address: A, pending: true });
  if (r) { cards.set(lc(A), { key, at: Date.now(), png }); if (cards.size > 300) cards.delete(cards.keys().next().value); }
  return { png, done: !!r };
}

/* ---------- the page: public/check.html with this coin's link preview ---------- */
const titleOf = (r, A) => {
  const name = r?.symbol ? `$${r.symbol}` : short(A);
  if (!r) return `${name} · Troya Check`;
  if (r.score != null) return `${name}: ${r.score}/100, ${r.label} · Troya Check`;
  return `${name}: ${r.label} · Troya Check`;
};
const descOf = (r) => (r ? `${(r.reasons || []).map((x) => noDot(x.short || x.text)).join(". ")}. Automated checks, not an audit.` : "Troya Gate, Ring Radar, the dev side, The Assay and Heel are reading this coin now. Automated checks, not an audit.").slice(0, 300);
/** html = public/check.html; address = the coin. Replaces the dashboard's meta block and fills the first answer. */
export async function renderPage(html, address) {
  const A = getAddress(String(address).toLowerCase());
  // only a settled answer goes into the page; otherwise the page opens in its "reading" state and check.js polls
  const run = webRun(A), t0 = Date.now();
  while (!run.done && !settled(run.res) && Date.now() - t0 < PAGE_WAIT_MS) await sleep(250);
  const r = settled(run.res) || (run.done && usable(run.res)) ? run.res : null;
  const v = r ? Math.floor((r.checkedAt || 0) / 60_000).toString(36) : "p";
  const url = `${SITE}/check/${A}`, img = `${SITE}/api/check/${A}/card.png?v=${v}`, title = titleOf(r, A), desc = descOf(r);
  const meta = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Troya Agent">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(r ? `Troya Check card: ${title}` : `Troya Check for ${short(A)}`)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@Troyaagent">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">`;
  // the first answer for the script (no second request) and for readers without JavaScript; never executed (type json)
  const data = JSON.stringify({ address: A, result: r ? publicResult(await enrich(r)) : null }).replace(/</g, "\\u003c");
  const noscript = r ? `<p class="ck-ssr"><b>${esc(title)}</b><br>${(r.reasons || []).map((x) => esc(x.text)).join("<br>")}</p>` : `<p class="ck-ssr">Checking ${esc(A)}…</p>`;
  return { html: html.replace(/<!--meta-->[\s\S]*?<!--\/meta-->/, meta).replace("<!--check-data-->", `<script type="application/json" id="check-data">${data}</script>`).replace("<!--check-ssr-->", noscript), pending: !r };
}

/* ---------- routes ---------- */
// per IP, for the page and the card (a crawler reads each once; this only stops a script walking random addresses)
const hits = new Map();
export function pageLimited(ip, n = 60) {
  const now = Date.now();
  let b = hits.get(ip);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; hits.set(ip, b); }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60_000) hits.delete(k);
  return ++b.n > n;
}

export async function register(r, ctx) {
  store = ctx.store;
  if (process.env.CHECK_GRADE !== "0") setInterval(() => gradeTick().catch(() => {}), 5 * 60_000).unref?.();
  r.get("/api/check", async () => dashboard(), { weight: 1, perMin: 60 });
  // before /api/check/:address, which would also match these paths
  r.get("/api/check/board", async ({ query }) => boardView({ sort: ["volume", "mcap", "change", "liquidity", "newest", "txns", "holders"].includes(query.sort) ? query.sort : "volume",
    dir: query.dir === "asc" ? "asc" : "desc", launchpad: /^[a-z0-9-]{1,20}$/.test(query.launchpad || "") ? query.launchpad : "all" }), { weight: 1, perMin: 40 });
  // the paste box: a $TICKER → its contract, or "N contracts share it" (with the oldest), or none
  r.get("/api/check/resolve", async ({ query }) => {
    const q = String(query.q || "").trim().replace(/^\$/, "");
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { address: getAddress(q.toLowerCase()) };
    if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(q)) throw new HttpError(400, "Paste a contract address or a ticker like $TROYA.");
    return resolveTicker(q);
  }, { weight: 1, perMin: 30 });
  r.get("/api/check/record", async () => recordOf(store ? await store.readJson(FILE, []) : []), { weight: 1, perMin: 60 });
  // polled every 4 s by the page while a coin is being read, so the limit leaves room for a minute of polling and a few coins
  r.get("/api/check/:address", async ({ params }) => webAnswer(params.address), { weight: 1, perMin: 40 });
  r.get("/api/check/:address/card.png", async ({ params, req, res }) => {
    if (!isAddress(String(params.address || ""))) throw new HttpError(400, "That is not a token address.");
    try {
      const c = await cardFor(getAddress(lc(params.address)));
      res.writeHead(200, { "content-type": "image/png", "content-length": c.png.length, "cache-control": `public, max-age=${c.done ? 600 : 30}`, "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : c.png);
    } catch (e) {
      console.warn("[check] card", params.address, e?.message);
      res.writeHead(302, { location: `${SITE}/og.png?v=2`, "cache-control": "no-store" }).end();
    }
  }, { weight: 1, perMin: 60 });
}

export const _test = { saveRow, gradeTick, cardSvg, measure, wrap2, titleOf, descOf, tagOf, memo, setStore: (s) => { store = s; } };
