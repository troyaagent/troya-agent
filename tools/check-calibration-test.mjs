// Troya Check calibration fixes (27 Nov 2026, from the 20-coin run on troya.codes): Ring Radar read when its cache is empty,
// the web's "reading" state, a failed route or a transient revert never flipping the verdict, plain wording, socials.
//   node tools/check-calibration-test.mjs        offline, fixtures only; nothing posted
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "troya-calib-"));
const C = await import("../server/check.mjs");
const CC = await import("../server/checkclaims.mjs");
const { getAddress } = await import("ethers");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const A = getAddress("0xcd2d690308201f18fdb7edf9cfad83a8c4661698");
const ck = (key, status, detail, label = key) => ({ key, status, label, detail });
const gate = (over = {}, word = "blocked") => {
  const base = { route: ck("route", "pass", "Uniswap v4 · ETH → USDG → GREM"), impact: ck("impact", "pass", "0.40%"), depth: ck("depth", "pass", "9.83 ETH"), fee: ck("fee", "pass", "0.30%"),
    sim: ck("sim", "pass", "The exact swap succeeds against the current pool"), sell: ck("sell", "pass", "Selling back succeeds"), tax: ck("tax", "pass", "None on a transfer to the pool or to a wallet") };
  return { word, verdict: word === "blocked" ? "failed" : "passed", checks: Object.values({ ...base, ...over }) };
};

/* ---------- 3: one bad quote never flips the verdict; "thin" only on a real depth reading ---------- */
await t("GREM: impact 89% and fee 85% fail over a 9.83 ETH pool → the fee cap (15), not 'pool too thin'", () => {
  const p = C.gatePart(gate({ impact: ck("impact", "fail", "89.46%", "Price impact"), fee: ck("fee", "fail", "85.00%", "Fees and taxes") }), A);
  assert.equal(p.cap.at, C.CAPS.gateFail);
  assert.match(p.summary, /fees and taxes are too high \(85\.00%\)/);
  assert.ok(!/thin/i.test(p.summary));
});
await t("impact fails over a pool that reads deep: said as it is, no cap", () => {
  const p = C.gatePart(gate({ impact: ck("impact", "fail", "31.20%", "Price impact") }), A);
  assert.equal(p.cap, null);
  assert.match(p.summary, /move the price 31\.20%, although the pool reads 9\.83 ETH deep/);
});
await t("'too thin' (cap 45) only when the depth reading itself is under the floor", () => {
  const p = C.gatePart(gate({ depth: ck("depth", "fail", "0.005 ETH", "Pool depth"), impact: ck("impact", "fail", "97.05%", "Price impact") }), A);
  assert.equal(p.cap.at, C.CAPS.thinFail);
  assert.match(p.short, /0\.005 ETH/);
});
await t("a route that failed because a node was busy is 'not read', never the no-route cap", () => {
  for (const d of ["Could not reach Robinhood Chain: upstream busy (the official RPC queue is full)", "KyberSwap answered 503", "quote timed out"]) {
    const p = C.gatePart(gate({ route: ck("route", "fail", d, "Route") }), A);
    assert.equal(p.status, "not read", d);
  }
  const real = C.gatePart(gate({ route: ck("route", "fail", "Every pool reverted for this size: the pools are too thin for this amount.", "Route") }), A);
  assert.equal(real.cap.at, C.CAPS.noRoute, "a real no-route reading still caps");
});
await t("a Gate error or timeout is 'not read', never a fail", () => {
  assert.equal(C.gatePart({ verdict: "error", error: "timeout" }, A).status, "not read");
  assert.equal(C.gatePart(null, A).status, "not read");
});
await t("the failing check that matters most wins: a failed test sell beats a failed route", () => {
  const p = C.gatePart(gate({ route: ck("route", "fail", "No route", "Route"), sell: ck("sell", "fail", "The test sell reverted: TRANSFER_FAILED", "Test sell") }), A);
  assert.equal(p.cap.at, C.CAPS.gateFail); assert.equal(p.notSellable, true);
});

/* ---------- 1: Ring Radar ---------- */
await t("Ring Radar: a finished 'unknown' radar is n/a even while the Gate's kept line still says 'still reading'", () => {
  const g = gate({}, "notes"); g.checks.push(ck("ring", "warn", "Ring Radar is still reading this launch (exempt wallets, first-block buys). Check again in a minute.", "Launch ring"));
  assert.equal(C.ringPart(g, { verdict: "unknown", reasons: ["No Pons V2 launch found for this coin, so Ring Radar has nothing to read."] }, A).status, "n/a");
  assert.equal(C.ringPart(g, null, A).status, "not read");
  assert.equal(C.ringPart(g, { verdict: "clear", reasons: [] }, A).value, 1, "a finished read wins over the stale line");
});

/* ---------- 2: the web never shows "not enough read" as an answer ---------- */
await t("settled: a scored coin, a stock, a major or an unknown address; never a coin without a score", () => {
  assert.equal(C.settled({ kind: "coin", score: 41 }), true);
  assert.equal(C.settled({ kind: "coin", score: 0 }), true);
  assert.equal(C.settled({ kind: "coin", score: null, label: "Not enough read" }), false);
  assert.equal(C.settled({ kind: "stock", score: null }), true);
  assert.equal(C.settled({ kind: "unknown", score: null }), true);
  assert.equal(C.settled(null), false);
});
await t("webAnswer: a settled answer in the cache comes back at once (no read started)", async () => {
  const r = { address: A, kind: "coin", symbol: "GREM", score: 15, label: "Red flags", tone: "bad", reasons: [], parts: [], caps: [], checkedAt: Date.now(), partial: false };
  C._test.memo.set(A.toLowerCase(), { at: Date.now(), ttl: 60_000, res: r });
  const out = await C.webAnswer(A, 100);
  assert.equal(out.score, 15); assert.equal(out.pending, undefined); assert.equal(out.page, `https://troya.codes/check/${A}`);
  await assert.rejects(() => C.webAnswer("0x123"), /token address/);
});

/* ---------- 4: plain words ---------- */
await t("wording: IShowSpace's dev-side line and HOOKR's cluster line, same numbers, one clear clause each", () => {
  assert.equal(C.plainText("1 red flag: The dev and the wallets tied to it sold 100% of the coins they received (the dev wallet itself 0%)."),
    "1 red flag: Wallets linked to the dev have sold everything they got; the dev wallet itself hasn't sold any.");
  assert.equal(C.plainText("0x1890…ebff handed coins to 199 wallets that together hold 100.0%."), "One wallet (0x1890…ebff) spread coins to 199 others, and together they hold 100% of the supply.");
  assert.equal(C.plainText("The dev and the wallets tied to it sold 62% of the coins they received (the dev wallet itself 12%)."), "Wallets linked to the dev have sold 62% of what they got; the dev wallet itself sold 12% of its coins.");
  assert.equal(C.plainText("Wallets that bought in the first 30 seconds (14) still hold 33.5% of the supply."), "14 wallets that bought in the first 30 seconds still hold 33.5% of the supply.");
  assert.equal(C.plainText("Weakest spot: the dev wallet holds 12.0% of the supply."), "Weakest spot: The dev still holds 12% of the supply.");
  assert.equal(C.plainText("Nothing to rewrite here."), "Nothing to rewrite here.");
});
await t("wording: the dev side in one sentence from devlinks' own numbers", () => {
  assert.equal(C.devsideSentence({ linked: { count: 4, holdsPct: 0 }, devSide: { devHoldsPct: 0, soldPct: 26, soldOfGotPct: 100 } }), "4 wallets are linked to the dev and hold 0% of the supply; the dev side has sold everything it got.");
  assert.equal(C.devsideSentence({ linked: { count: 0, holdsPct: 0 }, devSide: { devHoldsPct: 100, soldPct: 0, soldOfGotPct: 0 } }), "No wallets linked to the dev were found; the dev itself holds 100%.");
  assert.equal(C.devsideSentence(null), null);
});
await t("wording reaches the score's reasons and evidence", () => {
  const r = C.scoreCheck({ address: A, kind: "coin", symbol: "HOOKR", now: Date.now(), gate: gate({}, "passed"), assay: { status: "done", flags: [{ level: "red", key: "cluster", title: "Wallet cluster", detail: "0x1890…ebff handed coins to 199 wallets that together hold 100.0%." }] }, token: { liquidityUsd: 9000, holders: 300 } });
  const h = r.parts.find((p) => p.key === "holders");
  assert.match(h.summary, /One wallet \(0x1890…ebff\) spread coins to 199 others/);
  assert.ok(!/handed coins/.test(JSON.stringify(r.reasons)));
});

await t("wording: no brackets inside brackets in the fee line, and Heel's headline is its first clause", () => {
  const g = C.gatePart(gate({ fee: ck("fee", "fail", "48.33% (half of a small round trip)", "Fees and taxes") }), A);
  assert.equal(g.short, "Fees and taxes are too high (48.33%, half of a small round trip).");
  const h = C.heelPart({ kind: "coin", severity: "high", partial: false, heel: "Heel: its $224.35M market cap is backed by only $15.5k of real money (ETH) in its pools: At most 0.007% of it could ever be sold", facts: [] }, A);
  assert.equal(h.short, "Its $224.35M market cap is backed by only $15.5k of real money.");
  assert.match(h.summary, /At most 0\.007%/, "the page keeps the whole finding");
});

await t("a non-Pons coin with the Gate and the market read gets a number even while The Assay reads (capped at 74)", () => {
  const r = C.scoreCheck({ address: A, kind: "coin", symbol: "HOOKR", now: Date.now(), gate: gate({}, "passed"), ring: { verdict: "unknown", reasons: [] }, assay: { status: "running" },
    token: { liquidityUsd: 9000, holders: 300 }, heel: null, clash: { clash: false, count: 1, ticker: "HOOKR", others: [] }, bornAt: null });
  assert.ok(r.score != null && r.score <= C.CAPS.unread, `score ${r.score}`);
  const none = C.scoreCheck({ address: A, kind: "coin", symbol: "X", now: Date.now(), gate: null, token: { liquidityUsd: 9000, holders: 300 }, bornAt: Date.now() - 864e5 * 9 });
  assert.equal(none.score, null, "without the Gate, price and age alone are not enough");
});

/* ---------- 5: socials are not websites ---------- */
await t("socials: a facebook post is not IShowSpace's website, nor a third party's X post its X account", () => {
  assert.deepEqual(CC.sourcesOf({ website: "https://www.facebook.com/GossipTimesNG/posts/ishowspeed-confirms/1143135818434424/", twitter: "https://x.com/DailyLoud/status/2125751388466774273" }), { website: null, x: null });
  for (const u of ["https://instagram.com/coin", "https://www.tiktok.com/@coin", "https://youtu.be/x", "https://linktr.ee/coin", "https://t.me/coin", "https://discord.gg/abc", "https://medium.com/@coin/post", "https://github.com/coin/repo", "https://m.facebook.com/coin"])
    assert.equal(CC.isSocialLink(u), true, u);
  assert.equal(CC.isSocialLink("https://cashcat.cc/"), false);
  assert.equal(CC.isSocialLink("https://docs.coin.xyz/"), false);
});
await t("socials: a real project domain among the links is picked", () => {
  assert.deepEqual(CC.sourcesOf({ website: "https://linktr.ee/coolcoin" }, ["https://instagram.com/coolcoin", "https://coolcoin.xyz/", "https://x.com/coolcoin"]), { website: "https://coolcoin.xyz/", x: "coolcoin" });
  assert.equal(CC.sourcesOf({ website: "https://troya.codes" }).website, "https://troya.codes/", "$TROYA's own site still counts");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
