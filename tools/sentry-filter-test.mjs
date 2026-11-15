// Troya Sentry's channel filter: only a clean pass with real buying is posted; everything is still counted.
//   node tools/sentry-filter-test.mjs
import { worthPosting, formatPost, formatRecap, countSince } from "../server/sentry.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };
const checks = (depth = "pass") => [{ key: "route", status: "pass", label: "Route", detail: "Pons curve" }, { key: "depth", status: depth, label: "Pool depth", detail: "x" }, { key: "sim", status: "pass" }, { key: "sell", status: "pass", detail: "ok" }, { key: "tax", status: "pass" }, { key: "fee", status: "pass", detail: "1.00%" }];
const pons = (raised, extra = {}) => ({ raised, progressPct: (raised / 4.2) * 100, graduated: false, pair: { address: "native", symbol: "ETH" }, fees: { creatorTaxBps: 100 }, ...extra });
const L = (v, p, c = checks()) => ({ v, token: "0x" + "ab".repeat(20), symbol: "TEST", name: "Test", checks: c, pons: p, why: v === "passed" ? null : { label: "Price impact", detail: "96%" } });

ok(!worthPosting(L("passed", pons(0.002))), "a dev test buy (0.002 ETH) is not posted");
ok(!worthPosting(L("passed", pons(0.49))), "0.49 ETH raised is not posted");
ok(worthPosting(L("passed", pons(0.5))), "0.5 ETH raised and passed is posted");
ok(worthPosting(L("passed", pons(0.1, { graduated: true }))), "a graduated coin that passes is posted");
ok(!worthPosting(L("caution", pons(2))), "caution is never posted, however much was raised");
ok(!worthPosting(L("failed", pons(2))), "failed is never posted");
ok(!worthPosting(L("passed", pons(5, { pair: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA" } }))), "a curve paired with another token is not posted (raised is not ETH)");
ok(worthPosting({ v: "passed", checks: checks("pass") }) && !worthPosting({ v: "passed", checks: checks("warn") }), "a non-Pons pool needs 0.5 ETH of depth (pass), not just 0.05 (warn)");
ok(worthPosting(L("passed", pons(0.3)), 0.25), "the bar can be set by SENTRY_MIN_POST_ETH");
const post = formatPost({ ...L("passed", pons(0.8)), ageMs: 6 * 60e3 });
ok(/Checked 6 min after launch/.test(post) && /Passed/.test(post), "a post says how long after launch it was checked");
const ev = [[Date.now(), "seen"], [Date.now(), "seen"], [Date.now(), "passed"], [Date.now(), "passed"], [Date.now(), "posted"], [Date.now(), "failed"]];
const recap = formatRecap(countSince(ev, 0), "last 24 hours");
ok(/2 passed · 0 caution · 1 failed/.test(recap) && /1 passed with real buying/.test(recap) && /api\/sentry\/recent/.test(recap), "the recap counts every result and how many were posted, and links all of them");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
