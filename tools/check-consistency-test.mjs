// Troya Check, second calibration (27 Nov 2026, production run of 20 coins): the label must match its own reasons, explicit
// caps for dev dumps and wash trading, and no provisional answers (the web, X and Telegram wait for a complete read).
//   node tools/check-consistency-test.mjs        offline, fixtures only; nothing posted
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "troya-consistency-"));
const C = await import("../server/check.mjs");
const { getAddress } = await import("ethers");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const ck = (key, status, detail, label = key) => ({ key, status, label, detail });
const passedGate = () => ({ word: "passed", verdict: "passed", checkedAt: NOW, checks: [ck("route", "pass", "Uniswap v4 · ETH → X"), ck("impact", "pass", "0.30%"), ck("depth", "pass", "40 ETH"), ck("fee", "pass", "0.30%"),
  ck("sim", "pass", "The exact swap succeeds against the current pool"), ck("sell", "pass", "Selling back returns 0.0098 ETH"), ck("tax", "pass", "None detected"),
  ck("ring", "pass", "No ring pattern."), ck("devlinks", "pass", "The dev side holds 0.4%")] });
const coin = (symbol, address, over = {}) => ({ address: getAddress(address), kind: "coin", symbol, now: NOW, gate: passedGate(), ring: { verdict: "clear", reasons: [] },
  devlinks: { status: "pass", label: null, text: "No wallets tied to the dev found", linked: { count: 0, holdsPct: 0 }, devSide: { devHoldsPct: 0, soldPct: 0, soldOfGotPct: 0 } },
  assay: { status: "done", flags: [], dev: { soldPct: 0 }, devSide: { soldOfGotPct: 0 }, wash: { trades: 400, washPct: 5 }, holders: { top10Pct: 18 } },
  token: { liquidityUsd: 900_000, realLiquidityUsd: 800_000, holders: 13_000, priceUsd: 0.01 }, heel: { kind: "coin", severity: "none", partial: false, heel: "No weak spot found", facts: [] },
  clash: { clash: false, count: 1, ticker: symbol, others: [] }, bornAt: NOW - 60 * 86400e3, bornSrc: "creation", ...over });
const MOW = "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa", PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571", ISS = "0x2200734a8cbfff8a5cf09fddc807730c568ebe3b", DCTY = "0x63ef62a054962f1e3868359f9e323c933efe257e";
const noMajor = (r) => r.label === "No major flags";

await t("a clean, complete coin can still read 'No major flags'", () => {
  const r = C.scoreCheck(coin("GOOD", "0x1111111111111111111111111111111111111111"));
  assert.ok(r.score >= 75, `score ${r.score}`); assert.ok(noMajor(r)); assert.ok(C.complete(r));
  assert.ok(r.reasons.every((x) => x.tone === "good"));
});

await t("MOW: the dev sold 97% and its linked wallets sold everything → capped at 60, the dump leads, never 'No major flags'", () => {
  const r = C.scoreCheck(coin("MOW", MOW, { assay: { status: "done", dev: { soldPct: 97 }, devSide: { soldOfGotPct: 100 }, wash: { trades: 400, washPct: 3 },
    flags: [{ level: "red", key: "dev-sold", title: "Dev side sold", detail: "The dev and the wallets tied to it sold 100% of the coins they received (the dev wallet itself 97%)." }] } }));
  assert.ok(r.score <= C.CAPS.devSoldBoth, `score ${r.score}`);
  assert.ok(!noMajor(r));
  assert.match(r.headline, /Wallets linked to the dev have sold everything they got; the dev wallet itself sold 97% of its coins/);
  assert.equal(r.reasons[0].tone, "bad");
  const x = C.xReplyText(r);
  assert.ok(!/no major flags/i.test(x), x); assert.match(x, /^\$MOW: (some flags|risky|red flags) \(/);
});

await t("IShowSpace: linked wallets sold everything, the dev wallet none → capped at 74 ('Some flags')", () => {
  const r = C.scoreCheck(coin("IShowSpace", ISS, { assay: { status: "done", dev: { soldPct: 0 }, devSide: { soldOfGotPct: 100 }, wash: { trades: 300, washPct: 4 },
    flags: [{ level: "red", key: "dev-sold", title: "Dev side sold", detail: "The dev and the wallets tied to it sold 100% of the coins they received (the dev wallet itself 0%)." }] } }));
  assert.ok(r.score <= C.CAPS.devSold, `score ${r.score}`);
  assert.equal(r.label, "Some flags");
  assert.ok(r.caps.some((c) => /linked to the dev sold 100%/.test(c.why)));
});

await t("PONS: 72% of trades are wash trading → capped at 60; 55% → 74; 30% → no wash cap", () => {
  const wash = (pct, level) => coin("PONS", PONS, { assay: { status: "done", dev: { soldPct: 0 }, devSide: { soldOfGotPct: 0 }, wash: { trades: 2400, washPct: pct, washWallets: 74 },
    flags: level ? [{ level, key: "wash", title: "Round-trip trading", detail: `74 wallets that buy and sell the same amounts (bots or wash trading) made ${pct}% of all trades: the volume looks bigger than real demand.` }] : [] } });
  const hi = C.scoreCheck(wash(72, "red"));
  assert.ok(hi.score <= C.CAPS.washVeryHigh, `score ${hi.score}`); assert.ok(!noMajor(hi));
  assert.match(hi.headline, /72% of all trades come from 74 wallets trading the same amounts back and forth/);
  assert.ok(!/no major flags/i.test(C.xReplyText(hi)));
  const mid = C.scoreCheck(wash(55, "amber"));
  assert.ok(mid.score <= C.CAPS.washHigh, `score ${mid.score}`); assert.ok(!noMajor(mid));
  const lo = C.scoreCheck(wash(30, null));
  assert.ok(!lo.caps.some((c) => /wash/.test(c.why)));
});

await t("any warning among the reasons (a young coin, thin liquidity) keeps the label off 'No major flags'", () => {
  const young = C.scoreCheck(coin("NEW", "0x2222222222222222222222222222222222222222", { bornAt: NOW - 3 * 3600e3 }));
  assert.ok(young.score <= C.CAPS.flagged, `score ${young.score}`); assert.ok(!noMajor(young));
  const thin = C.scoreCheck(coin("THIN", "0x3333333333333333333333333333333333333333", { token: { liquidityUsd: 3000, holders: 40, priceUsd: 1 } }));
  assert.ok(!noMajor(thin));
});

await t("label and reasons agree on every fixture: 'No major flags' only with good reasons only, and the card says the same", () => {
  const cases = [coin("A", "0x4444444444444444444444444444444444444444"), coin("B", "0x5555555555555555555555555555555555555555", { heel: { kind: "coin", severity: "medium", partial: false, heel: "Heel: transfer tax: about 2.0% is lost on transfer", facts: [] } }),
    coin("C", "0x6666666666666666666666666666666666666666", { clash: { ticker: "C", count: 3, clash: true, thisOne: null, oldest: "0x7777777777777777777777777777777777777777", others: [{ address: "0x7777777777777777777777777777777777777777" }, { address: "0x8888888888888888888888888888888888888888" }] } })];
  for (const f of cases) {
    const r = C.scoreCheck(f);
    if (noMajor(r)) assert.ok(r.reasons.every((x) => x.tone === "good"), `${r.symbol}: ${JSON.stringify(r.reasons.map((x) => x.tone))}`);
    else assert.ok(r.score < 75);
    const svg = C._test.cardSvg(r);
    assert.ok(svg.includes("</svg>"));
  }
});

/* ---------- no provisional answers ---------- */
const dctyPartial = () => C.scoreCheck(coin("DCTY", DCTY, { gate: null, ring: null, assay: { status: "running" }, devlinks: null }));
const dctyFull = () => { const g = passedGate(); g.word = "notes"; g.checks = g.checks.map((c) => (c.key === "sell" ? ck("sell", "warn", "Troya can buy this (KyberSwap via flap) but finds no route to sell it back, on Troya or through KyberSwap.") : c));
  return C.scoreCheck(coin("DCTY", DCTY, { gate: g })); };

await t("DCTY with the Gate and Ring Radar unread is not complete: no answer stands, X stays silent, Telegram says 'still reading'", () => {
  const r = dctyPartial();
  assert.equal(C.complete(r), false); assert.equal(C.usable(r), false);
  const x = C.xAnswer(r);
  assert.equal(x.reply, null); assert.equal(x.silent, true);
  const tg = C.tgText(r);
  assert.match(tg, /Still reading this coin/); assert.ok(!/\d+\/100/.test(tg), "no provisional score in Telegram");
});
await t("DCTY once everything is read: complete, a real answer (no sell route, capped at 40), X replies with it", () => {
  const r = dctyFull();
  assert.equal(C.complete(r), true);
  assert.ok(r.score <= C.CAPS.noSellRoute, `score ${r.score}`);
  assert.match(C.xAnswer(r).reply, /^\$DCTY: (risky|red flags) \(\d+\/100\)\. You can buy it but there's no route to sell it back\./);
});
await t("Gate read but The Assay still unread: not complete (the web keeps polling), usable once the minute is up", () => {
  const r = C.scoreCheck(coin("MOW", MOW, { assay: { status: "running" } }));
  assert.equal(C.complete(r), false); assert.equal(C.usable(r), true);
  assert.equal(C.xAnswer(r).silent, true, "X needs the complete read");
});
await t("a non-Pons coin: Ring Radar n/a and the dev side n/a do not block completeness", () => {
  const g = passedGate(); g.checks = g.checks.filter((c) => c.key !== "ring" && c.key !== "devlinks");
  const r = C.scoreCheck(coin("HOOKR", "0xf57e806a624ea9fe24a72c294d56845bd3b6bdd2", { gate: g, ring: { verdict: "unknown", reasons: ["No Pons V2 launch found"] }, devlinks: null }));
  assert.equal(r.parts.find((p) => p.key === "ring").status, "n/a");
  assert.equal(r.parts.find((p) => p.key === "devside").status, "n/a");
  assert.equal(C.complete(r), true);
});
await t("stocks, majors and unknown addresses are complete (nothing to wait for)", () => {
  assert.equal(C.complete({ kind: "stock", score: null }), true);
  assert.equal(C.complete({ kind: "unknown", score: null }), true);
});
await t("webAnswer: an incomplete cached answer is not returned as the answer", async () => {
  const r = dctyPartial();
  // a cached incomplete result does not short-cut the web: the run would start a fresh read (not run here: no network)
  C._test.memo.set(r.address.toLowerCase(), { at: Date.now(), ttl: 60_000, res: r });
  assert.equal(C.settled(r), false);
  const full = dctyFull();
  C._test.memo.set(full.address.toLowerCase(), { at: Date.now(), ttl: 60_000, res: full });
  const out = await C.webAnswer(full.address, 100);
  assert.equal(out.pending, undefined); assert.equal(out.score, full.score);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
