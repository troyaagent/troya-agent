// Troya Sentry's channel filter: only a clean pass with real buying is posted; everything is still counted.
//   node tools/sentry-filter-test.mjs
import { worthPosting, holdReason, copyOf, formatPost, formatRecap, countSince, lookAlike, tickerKey, buyerSet, organicOf, rememberBuyers } from "../server/sentry.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };
const checks = (depth = "pass") => [{ key: "route", status: "pass", label: "Route", detail: "Pons curve" }, { key: "depth", status: depth, label: "Pool depth", detail: "x" }, { key: "sim", status: "pass" }, { key: "sell", status: "pass", detail: "ok" }, { key: "tax", status: "pass" }, { key: "fee", status: "pass", detail: "1.00%" }];
const pons = (raised, extra = {}) => ({ raised, progressPct: (raised / 4.2) * 100, graduated: false, pair: { address: "native", symbol: "ETH" }, fees: { creatorTaxBps: 100 }, ...extra });
const L = (v, p, c = checks(), extra = {}) => ({ v, token: "0x" + "ab".repeat(20), symbol: "TEST", name: "Test", checks: c, pons: p, buyers: { all: 60, organic: 40 }, why: v === "passed" ? null : { label: "Price impact", detail: "96%" }, ...extra });

ok(!worthPosting(L("passed", pons(0.002))), "a dev test buy (0.002 ETH) is not posted");
ok(!worthPosting(L("passed", pons(0.49))), "0.49 ETH raised is not posted");
ok(worthPosting(L("passed", pons(0.5))), "0.5 ETH raised and passed is posted");
ok(worthPosting(L("passed", pons(0.1, { graduated: true }))), "a graduated coin that passes is posted");
ok(!worthPosting(L("caution", pons(2))), "caution is never posted, however much was raised");
ok(!worthPosting(L("failed", pons(2))), "failed is never posted");
ok(!worthPosting(L("passed", pons(5, { pair: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA" } }))), "a curve paired with another token is not posted (raised is not ETH)");
ok(worthPosting({ v: "passed", checks: checks("pass"), buyers: { all: 50, organic: 30 } }) && !worthPosting({ v: "passed", checks: checks("warn"), buyers: { all: 50, organic: 30 } }), "a non-Pons pool needs 0.5 ETH of depth (pass), not just 0.05 (warn)");
ok(worthPosting(L("passed", pons(0.3)), 0.25), "the bar can be set by SENTRY_MIN_POST_ETH");
const post = formatPost({ ...L("passed", pons(0.8)), ageMs: 6 * 60e3 });
ok(/Checked 6 min after launch/.test(post) && /Passed/.test(post) && /40 independent buyers/.test(post), "a post says how long after launch it was checked and how many independent wallets bought");

// buyers: real money from one wallet, or from a farm that buys every new coin, is not enough
ok(!worthPosting(L("passed", pons(2), checks(), { buyers: { all: 170, organic: 1 } })), "2 ETH raised but 169 of 170 buyers are farm wallets: not posted");
ok(/only 24 independent buyers of 30/.test(holdReason(L("passed", pons(2), checks(), { buyers: { all: 30, organic: 24 } }))), "24 independent buyers is under the 25 bar, and the reason says so");
ok(worthPosting(L("passed", pons(0.6), checks(), { buyers: { all: 26, organic: 25 } })), "25 independent buyers and 0.6 ETH: posted");
ok(!worthPosting(L("passed", pons(2), checks(), { buyers: null })), "buyers that could not be counted: not posted");

// copies and look-alike names
ok(lookAlike({ symbol: "N\u0435il" }) && !lookAlike({ symbol: "Neil", name: "Neil the lemur" }) && !lookAlike({ symbol: "\u041f\u0415\u041f\u0415" }), "a Cyrillic e inside a Latin name is a look-alike; an all-Cyrillic name is not");
ok(!worthPosting(L("passed", pons(3), checks(), { symbol: "N\u0435il", name: "N\u0435il The L\u0435mur" })), "a look-alike name is not posted, however much was raised");
ok(tickerKey("N\u0435il") === tickerKey("NEIL") && tickerKey("$Rock-star") === "rockstar", "tickers fold case, look-alike letters and punctuation");
ok(/Same ticker as \$BFS/.test(holdReason(L("passed", pons(3)), { copy: { token: "0x" + "cd".repeat(20), symbol: "BFS" } })), "a second coin under a ticker posted in the last 24 hours is held as a copy");

const st = { tickers: { [tickerKey("NCAT")]: { token: "0x" + "cd".repeat(20), symbol: "NCAT", t: Date.now(), organic: 109 } } };
ok(copyOf(st, L("passed", pons(1), checks(), { symbol: "ncat", buyers: { all: 150, organic: 150 } })), "the same ticker with 150 buyers against 109: still a copy");
const big = L("passed", pons(1), checks(), { symbol: "NCAT", buyers: { all: 1553, organic: 1551 } });
ok(!copyOf(st, big) && /Another coin used this ticker earlier today/.test(formatPost(big)), "the same ticker with more than twice the buyers is posted, naming the earlier coin");

// who counts as a buyer
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const Z = "0x" + "0".repeat(40), CURVE = "0x" + "c0".repeat(20), DEV = "0x" + "de".repeat(20), W = (i) => "0x" + String(i).padStart(2, "0").repeat(20);
const tr = (f, t) => ({ topics: ["0x", topic(f), topic(t)] });
const logs = [tr(Z, CURVE), tr(CURVE, DEV), tr(CURVE, W(1)), tr(CURVE, W(2)), tr(CURVE, W(2)), tr(CURVE, W(3)), tr(W(3), W(4))];
const b = buyerSet(logs, { venues: [CURVE], exclude: [DEV] });
ok(b.length === 3 && !b.includes(DEV) && !b.includes(W(4)), "buyers = wallets that got the coin from its curve, once each; the deployer and wallet-to-wallet transfers are not counted");
for (let i = 0; i < 8; i++) rememberBuyers("0x" + String(i).padStart(40, "9"), [W(1), W(2)]);
rememberBuyers("0x" + "ef".repeat(20), [W(1), W(2), W(3)]);
ok(organicOf("0x" + "ef".repeat(20), [W(1), W(2), W(3)]) === 1, "wallets that bought 8 other new coins today are bots or a farm: only the third wallet counts");
const ev = [[Date.now(), "seen"], [Date.now(), "seen"], [Date.now(), "passed"], [Date.now(), "passed"], [Date.now(), "posted"], [Date.now(), "failed"]];
const recap = formatRecap(countSince(ev, 0), "last 24 hours");
ok(/2 passed · 0 caution · 1 failed/.test(recap) && /1 passed with real buying/.test(recap) && /api\/sentry\/recent/.test(recap), "the recap counts every result and how many were posted, and links all of them");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
