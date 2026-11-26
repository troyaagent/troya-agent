// Troya Check board (27 Nov redesign): trending coins joined with their latest complete check, the checks lists, the side
// panels, the coin page's pieces (sub-scores, findings, what would change it, history, dev record) and the page template.
//   node tools/check-board-test.mjs        offline: a fake market board and fake check rows; nothing posted
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "troya-board-"));
const C = await import("../server/check.mjs");
const { getAddress } = await import("ethers");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const A1 = "0x1111111111111111111111111111111111111111", A2 = "0x2222222222222222222222222222222222222222", A3 = "0x3333333333333333333333333333333333333333", DEV = "0xdddddddddddddddddddddddddddddddddddddddd";
const tok = (address, symbol, over = {}) => ({ address, symbol, name: `${symbol} coin`, launchpad: "pons", mcapUsd: 250_000, priceUsd: 0.002, change1h: 12.5, change24h: -4, volume24hUsd: 90_000, txns24h: 1200, liquidityUsd: 60_000, realLiquidityUsd: 40_000, holders: 800, createdAt: NOW - 86400e3, spark: [1, 2, 3], ...over });
const market = { getRobinhoodTokens: async () => ({ tokens: [tok(A1, "ONE"), tok(A2, "TWO", { launchpad: "flap" }), tok(A3, "THREE", { priceUsd: null })], total: 3, updatedAt: NOW }),
  indexRow: (a) => ({ [A1]: tok(A1, "ONE"), [A2]: tok(A2, "TWO", { launchpad: "flap" }) })[a.toLowerCase()] || null, sparkFor: () => [1, 2, 3] };
const row = (address, score, at, over = {}) => ({ address, symbol: address === A1 ? "ONE" : "TWO", kind: "coin", score, label: C.bandOf(score)?.label, tone: C.bandOf(score)?.tone, reasons: [{ tone: "warn", text: `reason ${score}` }], at, via: "web", ...over });
const rows = [
  row(A1, 40, NOW - 5 * 3600e3, { p0: 0.001, gatePassed: false, sub: { exit: 30, holders: 60 } }),
  row(A1, 62, NOW - 3600e3, { p0: null, track: { status: "dup" }, gatePassed: true, sub: { exit: 80, holders: 55 }, dev: DEV.toLowerCase() }),
  row(A2, 15, NOW - 1800e3, { p0: 0.004, gatePassed: false, sub: { exit: 5, holders: 20 }, dev: DEV.toLowerCase() }),
  { address: A3, symbol: "THREE", kind: "coin", score: null, label: "Not enough read", at: NOW - 60e3 },
  { address: "0x4444444444444444444444444444444444444444", symbol: "NVDA", kind: "stock", score: null, label: "Tokenized stock", at: NOW - 30e3 },
];

await t("latest check per coin: the newest complete row, with the price kept by an earlier check", () => {
  const m = C.latestChecks(rows);
  assert.equal(m.get(A1).score, 62);
  assert.equal(m.get(A1).p0, 0.001, "the dup row has no price: the earlier one is used for since-check");
  assert.equal(m.get(A1).checks, 2);
  assert.equal(m.has(A3), false, "a check with no score is not a check on the board");
  assert.equal(m.has("0x4444444444444444444444444444444444444444"), false, "stocks are not scored");
});
await t("join: board numbers as the board has them, the check as stored, since-check from the tracked price", () => {
  const j = C.joinRow(tok(A1, "ONE"), C.latestChecks(rows).get(A1));
  assert.equal(j.address, getAddress(A1)); assert.equal(j.liquidityUsd, 40_000, "the money side, not the two-sided pool");
  assert.equal(j.check.score, 62); assert.equal(j.check.exit, 80); assert.equal(j.check.holders, 55); assert.equal(j.check.gatePassed, true);
  assert.equal(j.check.sinceCheck, 100, "0.001 → 0.002 = +100%");
  const none = C.joinRow(tok(A3, "THREE"), null);
  assert.equal(none.check, null, "no stored check: Not checked, nothing filled in");
  assert.equal(C.joinRow(tok(A2, "TWO", { priceUsd: null }), C.latestChecks(rows).get(A2)).check.sinceCheck, null, "no price now: no since-check");
});
await t("board view: trending joined, checks lists, side panels, launchpads, honest windows", async () => {
  const v = await C.boardView({}, NOW, { market, rows });
  assert.equal(v.trending.length, 3);
  assert.equal(v.trending.find((r) => r.symbol === "ONE").check.score, 62);
  assert.equal(v.trending.find((r) => r.symbol === "THREE").check, null);
  assert.deepEqual(v.checks.latest.map((r) => r.symbol), ["TWO", "ONE"]);
  assert.deepEqual(v.checks.highest.map((r) => r.check.score), [62, 15]);
  assert.deepEqual(v.checks.lowest.map((r) => r.check.score), [15, 62]);
  assert.equal(v.checks.mostChecked[0].symbol, "ONE"); assert.equal(v.checks.mostChecked[0].weekChecks, 2);
  assert.deepEqual(v.just.map((r) => r.symbol), ["TWO", "ONE"]);
  assert.equal(v.mostChecked24h[0].checks, 2);
  assert.deepEqual(v.devs, [{ dev: getAddress(DEV), coins: 2, good: 1 }], "1 of the dev's 2 checked coins scored 50+");
  assert.deepEqual(v.launchpads.map((p) => p.id).sort(), ["flap", "pons"]);
  assert.deepEqual(v.windows.change, ["1h", "24h"], "only the windows the board has (no 5m)");
  assert.deepEqual(v.live, []);
});
await t("board view with no checks at all: every coin reads Not checked, panels empty, devs empty", async () => {
  const v = await C.boardView({}, NOW, { market, rows: [] });
  assert.ok(v.trending.every((r) => r.check === null));
  assert.equal(v.just.length, 0); assert.equal(v.devs.length, 0);
});

/* ---------- the coin page's pieces ---------- */
const ck = (key, status, detail, label = key) => ({ key, status, label, detail });
const gate = { word: "notes", verdict: "caution", checks: [ck("route", "pass", "ok"), ck("impact", "pass", "0.3%"), ck("depth", "pass", "10 ETH"), ck("fee", "pass", "0.3%"), ck("sim", "pass", "ok"), ck("sell", "warn", "Troya can buy this but finds no route to sell it back, on Troya or through KyberSwap."), ck("tax", "skip", "Not measured"), ck("ring", "pass", "No ring pattern."), ck("devlinks", "pass", "ok")] };
const f = { address: getAddress(A1), kind: "coin", symbol: "ONE", now: NOW, gate, ring: { verdict: "clear", reasons: [] }, devlinks: { status: "pass", text: "x", dev: [{ wallet: DEV }], linked: { count: 0, holdsPct: 0 }, devSide: { devHoldsPct: 0, soldPct: 0, soldOfGotPct: 0 } },
  assay: { status: "done", flags: [], dev: { soldPct: 0, wallets: [DEV.toLowerCase()] }, devSide: { soldOfGotPct: 0 }, wash: { trades: 100, washPct: 3 } }, token: { liquidityUsd: 4000, holders: 30, priceUsd: 0.002, mcapUsd: 99000, launchpad: "pons", website: "https://one.example", twitter: "https://x.com/one" },
  heel: { kind: "coin", severity: "none", partial: false, heel: "none", facts: [] }, clash: { clash: false, count: 1, ticker: "ONE", others: [] }, bornAt: NOW - 3 * 3600e3, claims: { website: null, x: null, sources: [] } };
await t("sub-scores: Exit from the Gate and Ring Radar, Holders from the dev side and The Assay, each with its word", () => {
  const r = C.scoreCheck(f);
  assert.ok(r.sub.exit < 67 && r.sub.exit != null, `exit ${r.sub.exit}`); assert.ok(["blocked", "risky"].includes(r.sub.exitWord));
  assert.equal(r.sub.holders, 100); assert.equal(r.sub.holdersWord, "spread");
  assert.match(r.sub.exitLine, /no route to sell it back/);
});
await t("findings: RISK first, then MISSING, WORKS, INFO; each with its evidence links", () => {
  const r = C.scoreCheck(f);
  const kinds = r.findings.map((x) => x.kind);
  assert.equal(kinds[0], "risk");
  assert.deepEqual([...kinds].sort((a, b) => ["risk", "missing", "works", "info"].indexOf(a) - ["risk", "missing", "works", "info"].indexOf(b)), kinds);
  assert.ok(r.findings.find((x) => x.title === "Troya Gate").links.some((l) => /\/agent#\/gate\//.test(l.href)));
  assert.ok(r.findings.some((x) => x.kind === "info" && /Website and X claims/.test(x.title)));
});
await t("what would change this: from what was read (sell route, liquidity, age)", () => {
  const r = C.scoreCheck(f);
  assert.ok(r.changes.some((x) => /route to sell it back/.test(x)));
  assert.ok(r.changes.length <= 3);
  const clean = C.whatWouldChange([{ key: "gate", status: "scored", value: 1, tone: "good" }]);
  assert.match(clean[0], /failed Gate check/);
});
await t("coin facts and history: launchpad, links, dev wallet, every check of this coin, the dev's record", async () => {
  const r = C.scoreCheck(f);
  assert.equal(r.coin.launchpad, "pons"); assert.equal(r.coin.website, "https://one.example"); assert.equal(r.coin.dev.toLowerCase(), DEV.toLowerCase());
  const e = await C.enrich(r, { rows, market });
  assert.deepEqual(e.history.map((h) => h.score), [62, 40], "newest first, only checks with a score");
  assert.deepEqual(e.devRecord, { dev: getAddress(DEV), checked: 1, good: 0, coins: [{ address: getAddress(A2), symbol: "TWO", score: 15, tone: "bad" }] });
  assert.deepEqual(e.spark, [1, 2, 3]);
  assert.equal(e.sinceFirstCheck.change, 100);
});
await t("check rows keep what the board needs: price at check, sub-scores, Gate, dev, launchpad", async () => {
  const { initStore } = await import("../server/store.mjs");
  const store = await initStore(process.env.DATA_DIR);
  C._test.setStore(store);
  const r = { ...C.scoreCheck({ ...f, gate: { ...gate, word: "passed", checks: gate.checks.map((c) => (c.key === "sell" ? ck("sell", "pass", "Selling back returns 0.0098 ETH") : c)) } }) };
  await store.writeJson("checks.json", []);
  await C._test.saveRow(r, "web", null);
  const [x] = await store.readJson("checks.json", []);
  assert.equal(x.p0, 0.002); assert.ok(x.sub && x.sub.exit != null); assert.equal(x.gatePassed, r.gatePassed); assert.equal(x.dev, DEV.toLowerCase()); assert.equal(x.launchpad, "pons");
});

/* ---------- the page template ---------- */
await t("the page has the board, the side panels and the coin view hooks, with no inline script handlers", () => {
  const html = readFileSync(new URL("../public/check.html", import.meta.url), "utf8");
  for (const hook of ["data-ck-grid", "data-ck-live", "data-ck-just", "data-ck-most", "data-ck-devsbox", "data-ck-pads", "data-ck-verdicts", "data-ck-find", 'data-view="trending"', 'data-view="checks"', 'data-win="1h"', 'data-win="24h"', "data-ck-coin", "data-ck-record", "<!--meta-->", "<!--check-data-->"]) assert.ok(html.includes(hook), hook);
  assert.ok(!/\son[a-z]+="/i.test(html), "no inline event handlers (CSP)");
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), "self-hosted fonts only");
  assert.ok(!/data-win="5m"/.test(html), "no window the board does not have");
  const js = readFileSync(new URL("../public/home/check.js", import.meta.url), "utf8");
  assert.ok(js.includes("/api/check/board") && !/fetch\([^)]*\/api\/market/.test(js), "the board is one request to /api/check/board");
});
await t("renderPage for a coin keeps the board template and writes the coin's preview", async () => {
  const html = readFileSync(new URL("../public/check.html", import.meta.url), "utf8");
  const r = C.scoreCheck(f);
  C._test.memo.set(A1.toLowerCase(), { at: Date.now(), ttl: 60_000, res: r });
  const out = await C.renderPage(html, A1);
  assert.ok(out.html.includes("og:image") && out.html.includes(`/api/check/${getAddress(A1)}/card.png`));
  assert.ok(out.html.includes('id="check-data"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
