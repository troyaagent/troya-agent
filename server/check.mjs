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
// PHASE 2 HOOK: reading the claims on a coin's website and X account goes in claimsPart() below (weight 0 until then).
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
export const WEIGHTS = { gate: 30, ring: 15, devside: 15, holders: 15, market: 10, heel: 5, clash: 5, age: 5, claims: 0 };
export const CAPS = {
  gateFail: 15,       // the Gate failed a check that decides a buy: the test sell, the exact swap, the transfer tax or the fees
  ringRed: 20,        // Ring Radar: a rigged launch pattern
  noRoute: 25,        // the Gate finds no route to buy it at all
  lpPulled: 25,       // The Assay: the dev pulled liquidity
  devsideFail: 30,    // the dev and the wallets tied to it hold most of it or are selling now (the Gate blocks the buy)
  noSellRoute: 40,    // a buy works, but no route sells it back (on Troya or through KyberSwap)
  thinFail: 45,       // the pool is too thin for a 0.01 ETH buy (price impact or depth failed)
  gateNotRead: 60,    // the Gate could not run: nothing shows it can be sold back
  unread: 74,         // the Gate, Ring Radar, the dev side or The Assay is still unread: never "No major flags" without them
};
const MIN_READ_WEIGHT = 45;                         // under this, too little was read to give a number
const CORE_PARTS = ["gate", "ring", "devside", "holders"];
export const BANDS = [
  { min: 75, label: "No major flags", tone: "good" },
  { min: 50, label: "Some flags", tone: "warn" },
  { min: 25, label: "Risky", tone: "risky" },
  { min: 0, label: "Red flags", tone: "bad" },
];
export const bandOf = (score) => (score == null ? null : BANDS.find((b) => score >= b.min));
export const NAMES = { gate: "Troya Gate", ring: "Ring Radar", devside: "Dev side wallets", holders: "Holders (The Assay)", market: "Liquidity and holders", heel: "Weak spot (Heel)", clash: "Same ticker", age: "Token age", claims: "Website and X claims" };

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

/* ---------- the parts ---------- */
const CORE = ["route", "impact", "depth", "fee", "sim", "sell", "tax"];
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
  const fail = core.find((c) => c.status === "fail" && !(curve && c.key === "depth"));
  const sell = core.find((c) => c.key === "sell");
  const noSell = sell?.status === "warn" && NO_SELL_ROUTE.test(sell.detail || "");
  p.noSellRoute = noSell;
  if (fail) {
    const d = noDot(fail.detail);
    if (fail.key === "route") return score(p, 0, `Blocked: Troya finds no route to buy it (${d}).`, { cap: { at: CAPS.noRoute, why: "the Gate finds no route to buy it" }, short: "Troya finds no route to buy it." });
    if (fail.key === "impact" || fail.key === "depth") return score(p, 0.2, `Blocked: the pool is too thin for a 0.01 ETH buy (${fail.label}: ${d}).`, { cap: { at: CAPS.thinFail, why: "the pool is too thin for a small buy" }, short: "The pool is too thin for even a small buy." });
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
  if ((!r || r.verdict === "unknown") && line?.status === "warn" && /still reading/i.test(line.detail || "")) return notRead(p, "Not read yet: Ring Radar is still reading this launch. Check again in a minute.");
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
  if (line.status === "fail") return score(p, 0, `${noDot(line.detail)}.`, { cap: { at: CAPS.devsideFail, why: "the dev side holds most of it or is selling" }, short: /selling now/i.test(line.detail) ? "The dev and wallets tied to it are selling now." : "The dev and wallets tied to it hold most of it." });
  if (line.status === "warn") return score(p, 0.4, `${noDot(line.detail)}.`, { short: "The dev side wallets need a look." });
  return score(p, 1, `${noDot(line.detail)}.`, { short: "The dev side wallets hold little and aren't selling." });
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
  const lp = red.find((f) => f.key === "lp-pulled");
  const top = red[0] || amber[0];
  if (!top) return score(p, 1, `No red or amber flags in what was measured${facts ? ` (${facts})` : ""}.`, { short: "The Assay found no red or amber flags in the holders." });
  return score(p, v, `${red.length ? `${red.length} red` : ""}${red.length && amber.length ? " and " : ""}${amber.length ? `${amber.length} amber` : ""} flag${red.length + amber.length > 1 ? "s" : ""}: ${noDot(top.detail)}.`,
    { short: `${noDot(top.detail)}.`, ...(lp ? { cap: { at: CAPS.lpPulled, why: "the dev pulled liquidity" } } : {}) });
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
  return score(p, v, noDot(h.heel).replace(/^Heel:\s*/, "Weakest spot: ") + ".", { short: v < 0.6 ? `${noDot(h.heel).replace(/^Heel:\s*/, "Weakest spot: ")}.` : "Heel found no serious weak spot." });
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

// PHASE 2 HOOK: the claims a coin makes on its website and X account (team, partners, audits, "renounced", "locked"), read
// and compared with the chain. Phase 1 leaves it out of the score (weight 0) and says so on the page.
export function claimsPart() {
  return notApplicable(part("claims"), "Coming next: Troya will read the claims on the coin's website and X account and compare them with the chain.");
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
    return { ...base, score: null, label: f.kind === "stock" ? "Tokenized stock" : "Major token", tone: "grey", headline: `${cap1(what)}, not a launch, so it gets no meme-coin score.`, reasons, parts: [gate, m], caps: [], gatePassed: gate.status === "scored" && gate.value >= 0.75 && !gate.cap, partial: gate.status === "not read" };
  }
  const parts = [gate, ringPart(f.gate, f.ring, A), devsidePart(f.gate, f.devlinks, A), holdersPart(f.assay, A), marketPart(f.token, A), heelPart(f.heel, A), clashPart(f.clash, base.symbol, A), agePart(f.bornAt, f.bornSrc, A, base.checkedAt), claimsPart()];
  const read = parts.filter((p) => p.status === "scored" && p.weight > 0);
  const W = read.reduce((s, p) => s + p.weight, 0);
  const caps = parts.filter((p) => p.status === "scored" && p.cap).map((p) => ({ part: p.key, at: p.cap.at, why: p.cap.why }));
  if (gate.status !== "scored") caps.push({ part: "gate", at: CAPS.gateNotRead, why: "the Gate could not run, so nothing shows it can be sold back" });
  const unread = parts.filter((p) => CORE_PARTS.includes(p.key) && p.status === "not read");
  if (unread.length) caps.push({ part: unread[0].key, at: CAPS.unread, why: `${unread.map((p) => p.name).join(", ")} ${unread.length === 1 ? "was" : "were"} not read yet` });
  caps.sort((a, b) => a.at - b.at);
  for (const p of read) p.points = +(p.weight * p.value).toFixed(1);
  let s = W ? Math.round((100 * read.reduce((t, p) => t + p.weight * p.value, 0)) / W) : null;
  if (s != null && caps.length) s = Math.min(s, caps[0].at);
  const enough = W >= MIN_READ_WEIGHT;
  if (!enough) s = null;
  const band = bandOf(s);
  // the three reasons: what set a cap first, then what cost the most points, then (if fewer than three) the strongest parts
  const bad = read.filter((p) => p.value < 1).map((p) => ({ p, k: (p.cap ? 1000 - p.cap.at : 0) + p.weight * (1 - p.value) })).sort((a, b) => b.k - a.k).map((x) => x.p);
  const good = read.filter((p) => p.value >= 0.8 && !bad.includes(p)).sort((a, b) => b.weight - a.weight);
  const pick = [...bad.filter((p) => p.weight * (1 - p.value) >= 1.5 || p.cap), ...good, ...bad].filter((p, i, a) => a.indexOf(p) === i).slice(0, 3);
  const reasons = pick.map((p) => ({ part: p.key, tone: p.tone, text: `${p.name}: ${p.summary}`, short: p.short || p.summary, link: p.links[0] || null }));
  if (gate.status !== "scored" && reasons.length < 3) reasons.push({ part: "gate", tone: "grey", text: `${gate.name}: ${gate.summary}`, short: "The Gate could not run, so a sell back is not proven.", link: gate.links[0] });
  const partial = parts.some((p) => p.status === "not read" && /still|did not finish|in time/i.test(p.summary));
  return {
    ...base, score: s, label: enough ? band.label : "Not enough read", tone: enough ? band.tone : "grey",
    headline: enough ? (reasons[0]?.short || reasons[0]?.text || "") : "Too few checks could be read just now. Try again in a minute.",
    reasons, parts, caps, readWeight: W, partial,
    // Buy only after a passed Gate, and never while Ring Radar is red or the dev side fails (the Gate's own result is kept
    // 10 minutes, so a ring or dev-side read that finished after it still counts here; Swap runs the Gate again anyway)
    gatePassed: gate.status === "scored" && !gate.cap && !gate.noSellRoute && (f.gate?.word === "passed" || f.gate?.word === "notes")
      && !parts.some((p) => (p.key === "ring" || p.key === "devside") && p.status === "scored" && p.value === 0),
  };
}

/* ---------- reading the facts (the modules above, through their caches) ---------- */
async function gather(A, waitMs = WAIT_MS) {
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
  const tokP = within(M.getRobinhoodToken(A).then((r) => r?.token || null), Math.min(left(), 12_000));
  const gateP = within(import("./badge.mjs").then((m) => m.badgeResult(A)).catch((e) => ({ verdict: "error", error: String(e?.message || e).slice(0, 160) })), left());
  if (major || stock) {
    const [token, gate] = await Promise.all([tokP, gateP]);
    return { address: A, kind: major ? "major" : "stock", symbol: major?.symbol || token?.symbol || meta.symbol, name: major?.name || token?.name || meta.name, gate, token, now };
  }
  const [token, gate, assay, heel, clash, bornAt] = await Promise.all([
    tokP, gateP,
    within(import("./assay.mjs").then((m) => m.assay(A, { deep: true, waitMs: left() })), left() + 500),
    within(import("./heel.mjs").then((m) => m.heel(A)), left()),
    within(M.nameClash(A), Math.min(left(), 8000)),
    within(import("./tokenage.mjs").then((m) => m.bornAt(A, { waitMs: Math.min(left(), 6000) })), Math.min(left(), 6500)),
  ]);
  // Ring Radar and the dev side were read by the Gate itself: these are cache hits, never a second read
  // (a "still reading" line means the first read is under way: the cache is asked, never a second read)
  const RR = await import("./ringradar.mjs").catch(() => null);
  const ringLine = (gate?.checks || []).find((c) => c.key === "ring");
  const ring = RR?.ringCached?.(A) || (ringLine && !/still reading/i.test(ringLine.detail || "") ? await within(RR.ringCheck(A), 3000) : null);
  const devlinks = await import("./devlinks.mjs").then((m) => m.devLinksCached(A)).catch(() => null);
  const bornSrc = await import("./tokenage.mjs").then((m) => m.bornSource(A)).catch(() => null);
  return { address: A, kind: "coin", symbol: token?.symbol || gate?.symbol || meta.symbol, name: token?.name || gate?.name || meta.name, gate, ring, devlinks, assay, token, heel, clash, bornAt: bornAt || token?.bornAt || null, bornSrc, now };
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
export async function troyaCheck(address, { via = "web", by = null, record = true, waitMs = via === "x" || via === "telegram" ? WAIT_CHAT_MS : WAIT_MS } = {}) {
  if (!isAddress(String(address || ""))) throw new HttpError(400, "Paste a token address on Robinhood Chain (0x + 40 hex characters).");
  const A = getAddress(String(address).toLowerCase());
  const k = lc(A);
  let res = cached(A), fresh = false;
  if (!res) {
    let h = memo.get(k);
    if (!h?.p) {
      h = { p: slot(() => gather(A, waitMs)).then((f) => scoreCheck(f)) };
      memo.set(k, h);
      h.p.then((r) => { memo.set(k, { at: Date.now(), ttl: r.partial ? TTL_PARTIAL : TTL, res: r }); if (memo.size > 3000) memo.delete(memo.keys().next().value); }, () => { if (memo.get(k) === h) memo.delete(k); });
      fresh = true;
    }
    res = await h.p;
  }
  // every check asked from X or Telegram is kept; from the web, once per fresh computation (a reload is not a new check)
  if (record && store && (fresh || via === "x" || via === "telegram")) await saveRow(res, via, by).catch((e) => console.warn("[check] save", e.message));
  return { ...res, cached: !fresh };
}
/** The check if one is cached or finishes within ms, else null (the page and the card use it). */
async function checkWithin(A, ms, opts) {
  const hit = cached(A);
  if (hit) return { ...hit, cached: true };
  return within(troyaCheck(A, opts), ms, null);
}

async function saveRow(r, via, by) {
  const row = { address: r.address, symbol: r.symbol, kind: r.kind, score: r.score, label: r.label, tone: r.tone, reasons: (r.reasons || []).map((x) => ({ tone: x.tone, text: String(x.short || x.text).slice(0, 160) })),
    at: Date.now(), via: ["x", "telegram", "web", "api"].includes(via) ? via : "web", by: by ? String(by).replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) || null : null };
  await store.update(FILE, [], (rows) => { const a = Array.isArray(rows) ? rows : []; a.push(row); return a.slice(-MAX_ROWS); });
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
export async function xCheckReply(req, { by = null } = {}) {
  let address = req.address || null;
  if (!address && req.ticker) {
    const t = await resolveTicker(req.ticker);
    const tag = /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(req.ticker) ? `$${req.ticker}` : req.ticker;
    if (t.none) return { reply: `No coin called ${tag} found on Robinhood Chain. Reply "check" with its contract address.` };
    if (t.many) return { reply: `${t.many} contracts on Robinhood Chain use ${tag}, so Troya won't pick one. Reply "check" with the address you mean.${t.oldest ? `\nOldest: ${SITE}/check/${t.oldest}` : ""}`, many: t.many, address: t.oldest };
    address = t.address;
  }
  const r = await troyaCheck(address, { via: "x", by });
  return { reply: xReplyText(r), address: r.address, result: r };
}

const tgEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Telegram /check: short HTML, the score first, three reasons, the link (its preview is the card). */
export function tgText(r) {
  const link = `${SITE}/check/${r.address}`;
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
  const r = await checkWithin(A, CARD_WAIT_MS, { via: "web" }).catch(() => null);
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
  const r = await checkWithin(A, PAGE_WAIT_MS, { via: "web" }).catch(() => null);
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
  const data = JSON.stringify({ address: A, result: r ? publicResult(r) : null }).replace(/</g, "\\u003c");
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
  r.get("/api/check", async () => dashboard(), { weight: 1, perMin: 60 });
  r.get("/api/check/:address", async ({ params }) => publicResult(await troyaCheck(params.address, { via: "web" })), { weight: 2, perMin: 20 });
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

export const _test = { cardSvg, measure, wrap2, titleOf, descOf, tagOf, memo, setStore: (s) => { store = s; } };
