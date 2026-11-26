// Troya Check (server/check.mjs): scoring, the X request parser, the X and Telegram texts, the dashboard boards and the card.
//   node tools/check-test.mjs                         offline: fixtures only, no network, nothing posted
//   node tools/check-test.mjs --live http://127.0.0.1:9271 [outDir]
//                                                     also asks a running server for real coins ($TROYA, two OASIS
//                                                     contracts, a stock token) and saves their cards to outDir
// Uses a fresh data folder in the system temp dir, so nothing in data/ changes. Nothing here signs, trades or posts.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "troya-check-"));
process.env.DATA_DIR = data;
const C = await import("../server/check.mjs");
const { initStore } = await import("../server/store.mjs");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };

/* ---------- fixtures, in the shapes the modules return ---------- */
const { getAddress } = await import("ethers");
const A = getAddress("0x3eaf76055acfaa9a6984929fe35d3ab591f67777");
const NOW = Date.UTC(2026, 10, 26, 12, 0);
const ck = (key, status, label, detail) => ({ key, status, label, detail });
const passedGate = (extra = []) => ({
  verdict: "passed", word: "passed", label: "Passed", symbol: "GOOD", checkedAt: NOW, curve: null,
  checks: [ck("route", "pass", "Route", "Uniswap v4 · ETH → GOOD"), ck("impact", "pass", "Price impact", "0.40%"), ck("depth", "pass", "Pool depth", "12.40 ETH"),
    ck("fee", "pass", "Fees and taxes", "0.30%"), ck("sim", "pass", "Transaction simulation", "The exact swap succeeds against the current pool"),
    ck("sell", "pass", "Test sell", "Selling back returns 0.0098712 ETH"), ck("tax", "pass", "Transfer tax", "None detected"),
    ck("ring", "pass", "Launch ring", "1 snipe-tax exempt wallet set at launch (0 besides the dev); the dev and exempt wallets bought 2.1% of the supply in the first blocks. No ring pattern."),
    ck("devlinks", "pass", "Dev side wallets", "The dev side holds 1.2% and sold none"), ...extra],
});
const cleanRest = {
  ring: { verdict: "clear", reasons: ["No exempt wallets beyond the dev, no bundle buys in the first seconds, no reused bundler and no same-name coins seen."], launch: { tx: "0x" + "ab".repeat(32), block: 1 } },
  devlinks: null,
  assay: { status: "done", flags: [], holders: { top10Pct: 18.4 }, dev: { wallets: ["0x1"], holdsPct: 1.2 } },
  token: { liquidityUsd: 150_000, realLiquidityUsd: 140_000, holders: 1200, mcapUsd: 2_400_000 },
  heel: { kind: "coin", severity: "none", partial: false, heel: "No weak spot found in what was measured (9 sources read). Not a safe stamp: a coin can change after a check.", facts: [] },
  clash: { ticker: "GOOD", count: 1, others: [], clash: false },
  bornAt: NOW - 10 * 86400_000, bornSrc: "creation",
  health: { isContract: true, kind: "pons", owner: null, ownerRenounced: null, functions: { mint: [], pause: [], blacklist: [], fees: [], limits: [], trading: [], owner: [] }, proxy: null, flags: [] },
};
const coin = (over) => ({ address: A, kind: "coin", symbol: "GOOD", name: "Good Coin", now: NOW, gate: passedGate(), ...cleanRest, ...over });
const NO_SELL = "Troya can buy this (KyberSwap via flap) but finds no route to sell it back, on Troya or through KyberSwap. You may only be able to sell on the launchpad's own site. Buy only if you know how you will get out.";

await t("passed coin: high score, top band, Buy allowed", () => {
  const r = C.scoreCheck(coin());
  assert.ok(r.score >= 75, `score ${r.score}`);
  assert.equal(r.label, "No major flags");
  assert.equal(r.gatePassed, true);
  assert.equal(r.reasons.length, 3);
  assert.equal(r.caps.length, 0);
  assert.equal(r.parts.find((p) => p.key === "claims").status, "not read", "no claims read in this fixture: left out of the score, said so");
  assert.ok(!/\bsafe\b/i.test(JSON.stringify(r.reasons)), "never says safe in reasons");
});

await t("honeypot (test sell reverts): capped at 15, red flags, no Buy, the Gate is reason one", () => {
  const g = passedGate(); g.word = "blocked"; g.verdict = "failed";
  g.checks = g.checks.map((c) => (c.key === "sell" ? ck("sell", "fail", "Test sell", "The test sell reverted: execution reverted: TRANSFER_FAILED") : c));
  const r = C.scoreCheck(coin({ gate: g }));
  assert.ok(r.score <= C.CAPS.gateFail, `score ${r.score}`);
  assert.equal(r.label, "Red flags");
  assert.equal(r.gatePassed, false);
  assert.equal(r.reasons[0].part, "gate");
  assert.match(r.headline, /could not be sold back/);
});

await t("high transfer tax: capped at 15", () => {
  const g = passedGate(); g.word = "blocked"; g.verdict = "failed";
  g.checks = g.checks.map((c) => (c.key === "tax" ? ck("tax", "fail", "Transfer tax", "About 24.0% is lost on transfer") : c));
  const r = C.scoreCheck(coin({ gate: g }));
  assert.ok(r.score <= 15, `score ${r.score}`);
  assert.match(r.reasons[0].text, /24\.0%/);
});

await t("buy works, no route to sell back: risky (25-40), strong reason, no Buy", () => {
  const g = passedGate(); g.word = "notes"; g.verdict = "caution";
  g.checks = g.checks.map((c) => (c.key === "sell" ? ck("sell", "warn", "Test sell", NO_SELL) : c.key === "tax" ? ck("tax", "skip", "Transfer tax", "Not measured") : c));
  const r = C.scoreCheck(coin({ gate: g }));
  assert.ok(r.score <= C.CAPS.noSellRoute && r.score >= 25, `score ${r.score}`);
  assert.equal(r.label, "Risky");
  assert.equal(r.gatePassed, false);
  assert.equal(r.headline, "You can buy it but there's no route to sell it back.");
});

await t("red Ring Radar: capped at 20, red flags, ring among the reasons", () => {
  const g = passedGate(); g.word = "blocked"; g.verdict = "failed";
  g.checks = g.checks.map((c) => (c.key === "ring" ? ck("ring", "fail", "Launch ring", "Rigged launch pattern: 14 snipe-tax exempt wallets set at launch (13 besides the dev); the dev and exempt wallets bought 61% of the supply in the first blocks. 13 wallets besides the dev were freed from the snipe tax in the launch itself.") : c));
  const ring = { verdict: "red", reasons: ["13 wallets besides the dev were freed from the snipe tax in the launch itself", "the exempt wallets bought 61% of the supply in the first seconds"], launch: { tx: "0x" + "cd".repeat(32), block: 5 }, bundles: [] };
  const r = C.scoreCheck(coin({ gate: g, ring }));
  assert.ok(r.score <= C.CAPS.ringRed, `score ${r.score}`);
  assert.equal(r.label, "Red flags");
  assert.equal(r.gatePassed, false);
  assert.equal(r.reasons[0].part, "ring");
  assert.ok(r.parts.find((p) => p.key === "ring").links.some((l) => /\/tx\/0xcd/.test(l.href)), "launch tx linked as evidence");
});

await t("Gate result kept from before Ring Radar finished: the finished red radar still caps it and hides Buy", () => {
  const g = passedGate(); g.word = "notes"; g.verdict = "caution";
  g.checks = g.checks.map((c) => (c.key === "ring" ? ck("ring", "warn", "Launch ring", "Ring Radar is still reading this launch (exempt wallets, first-block buys). Check again in a minute.") : c));
  const r = C.scoreCheck(coin({ gate: g, ring: { verdict: "red", reasons: ["the bundler contract 0x5e1f2c… was also used on 3 other launches"], bundles: [{ tx: "0x" + "ef".repeat(32), wallets: 9, pctOfSupply: 31 }] } }));
  assert.ok(r.score <= C.CAPS.ringRed, `score ${r.score}`);
  assert.equal(r.gatePassed, false);
});

await t("a core part still reading: never 'No major flags' (capped at 74), and it says which", () => {
  const r = C.scoreCheck(coin({ assay: { status: "running" } }));
  assert.ok(r.score <= C.CAPS.unread, `score ${r.score}`);
  assert.equal(r.label, "Some flags");
  assert.ok(r.caps.some((c) => /Holders \(The Assay\) was not read yet/.test(c.why)));
  assert.equal(r.partial, true);
});

await t("stock token: named, not scored", () => {
  const r = C.scoreCheck({ address: A, kind: "stock", symbol: "NVDA", name: "NVIDIA", now: NOW, gate: passedGate(), token: { priceUsd: 181.2, change24h: 1.4, liquidityUsd: 900_000 } });
  assert.equal(r.score, null);
  assert.equal(r.label, "Tokenized stock");
  assert.match(r.reasons[0].text, /tokenized stock/i);
  assert.match(C.xReplyText(r), /tokenized stock on Robinhood Chain, not a launch/);
});

await t("unknown address: not a token on Robinhood Chain", () => {
  const r = C.scoreCheck({ address: A, kind: "unknown", why: "There is no contract at this address on Robinhood Chain, so it is not a token here.", now: NOW });
  assert.equal(r.score, null);
  assert.equal(r.label, "Not a token on Robinhood Chain");
  assert.equal(r.parts.length, 0);
});

await t("nothing read but price and age: no number, 'Not enough read'", () => {
  const r = C.scoreCheck(coin({ gate: null, ring: null, assay: null, heel: null, clash: null }));
  assert.equal(r.score, null);
  assert.equal(r.label, "Not enough read");
  assert.ok(r.parts.filter((p) => p.status === "not read").length >= 5);
});

await t("Gate not read, the rest clean: capped at 60 and said so", () => {
  const r = C.scoreCheck(coin({ gate: { verdict: "error", error: "timeout" } }));
  assert.ok(r.score != null && r.score <= C.CAPS.gateNotRead, `score ${r.score}`);
  assert.equal(r.parts.find((p) => p.key === "gate").status, "not read");
  assert.equal(r.gatePassed, false);
});

await t("Assay flags and a copy ticker lower the score", () => {
  const r = C.scoreCheck(coin({ assay: { status: "done", flags: [{ level: "red", key: "top10", title: "Top wallets hold most of it", detail: "The 10 biggest wallets hold 71.0% of the supply." }, { level: "amber", key: "dev-holds", title: "Dev holds a large bag", detail: "The dev wallet holds 6.1% of the supply." }], holders: { top10Pct: 71 } },
    clash: { ticker: "GOOD", count: 3, clash: true, thisOne: null, oldest: "0x1111111111111111111111111111111111111111", others: [{ address: "0x1111111111111111111111111111111111111111", symbol: "GOOD" }, { address: "0x2222222222222222222222222222222222222222", symbol: "GOOD" }] } }));
  const base = C.scoreCheck(coin());
  assert.ok(r.score < base.score, `${r.score} < ${base.score}`);
  assert.equal(r.parts.find((p) => p.key === "clash").tone, "bad");
});

await t("bands", () => {
  assert.equal(C.bandOf(100).label, "No major flags"); assert.equal(C.bandOf(75).label, "No major flags");
  assert.equal(C.bandOf(74).label, "Some flags"); assert.equal(C.bandOf(50).label, "Some flags");
  assert.equal(C.bandOf(49).label, "Risky"); assert.equal(C.bandOf(25).label, "Risky");
  assert.equal(C.bandOf(24).label, "Red flags"); assert.equal(C.bandOf(0).label, "Red flags");
  assert.equal(Object.values(C.WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

/* ---------- the X request parser ---------- */
await t("parser: address", () => {
  assert.deepEqual(C.parseCheckRequest("check 0x3eaf76055acfaa9a6984929fe35d3ab591f67777 pls"), { address: A });
  assert.deepEqual(C.parseCheckRequest("Can you CHECK this one? 0x3eaf76055acfaa9a6984929fe35d3ab591f67777"), { address: A });
});
await t("parser: $ticker", () => {
  assert.deepEqual(C.parseCheckRequest("check $OASIS"), { ticker: "OASIS" });
  assert.deepEqual(C.parseCheckRequest("hey can you check $troya for me"), { ticker: "troya" });
});
await t("parser: reply with the contract in the parent post", () => {
  const parent = "OASIS is live on Robinhood Chain! CA: 0xc4f6470fa6a21e5f58f17a203cabe3afd315f2d5 https://t.co/abc";
  const r = C.parseCheckRequest("check", parent);
  assert.equal(r.fromParent, true);
  assert.equal(r.address.toLowerCase(), "0xc4f6470fa6a21e5f58f17a203cabe3afd315f2d5");
  assert.equal(C.parseCheckRequest("@Troyaagent can you check this?", parent).fromParent, true);
  assert.equal(C.parseCheckRequest("check", "no contract here, just vibes"), null);
  assert.ok(C.mentionsCheck("check"));
});
await t("parser: not a check", () => {
  assert.equal(C.parseCheckRequest("gm troya, love the product"), null);
  assert.equal(C.parseCheckRequest("bought 0x3eaf76055acfaa9a6984929fe35d3ab591f67777 today"), null);
  assert.equal(C.parseCheckRequest("I checked 0x3eaf76055acfaa9a6984929fe35d3ab591f67777 already"), null);
  assert.equal(C.parseCheckRequest("check your dms bro"), null);
  assert.equal(C.parseCheckRequest("check my profile", "CA 0x3eaf76055acfaa9a6984929fe35d3ab591f67777"), null);
  assert.equal(C.parseCheckRequest("how does troya check work?"), null);
});

/* ---------- the texts ---------- */
await t("X reply: one line + link, under 280 (links count 23), one cashtag, no 'safe', no advice", () => {
  const g = passedGate(); g.word = "notes";
  g.checks = g.checks.map((c) => (c.key === "sell" ? ck("sell", "warn", "Test sell", NO_SELL) : c));
  const r = C.scoreCheck(coin({ symbol: "OASIS", gate: g, clash: { ticker: "OASIS", count: 4, clash: true, thisOne: "newest", oldest: "0x1111111111111111111111111111111111111111", others: [{ address: "0x1111111111111111111111111111111111111111" }, { address: "0x2", symbol: "$OASIS" }, { address: "0x3" }] } }));
  const x = C.xReplyText(r);
  const [line, link] = x.split("\n");
  assert.match(line, /^\$OASIS: risky \(\d+\/100\)\. You can buy it but there's no route to sell it back\.$/);
  assert.equal(link, `https://troya.codes/check/${A}`);
  assert.ok(line.length + 1 + 23 <= 280);
  assert.ok((x.match(/\$[A-Za-z]/g) || []).length <= 1);
  assert.ok(!/\bsafe\b|financial advice|\bbuy now\b/i.test(x));
});
await t("X reply: a symbol that is not a plain ticker becomes the short address (no stray cashtag or @)", () => {
  assert.equal(C.scoreCheck(coin({ symbol: "@evil<b>" })).symbol, "evilb", "markup and @ are stripped from symbols");
  const r = C.scoreCheck(coin({ symbol: "TRUMP 2.0", name: "x" }));
  const x = C.xReplyText(r);
  assert.ok(!/[@<$]/.test(x), x);
  assert.match(x, /^0x3eaf…7777: /i);
});
await t("Telegram text: HTML escaped, score, three reasons, link", () => {
  const r = C.scoreCheck(coin({ symbol: "A&B" }));
  const h = C.tgText(r);
  assert.ok(h.includes("$A&amp;B"));
  assert.match(h, /No major flags · \d+\/100/);
  assert.ok(h.includes(`https://troya.codes/check/${A}`));
  assert.ok(h.includes("Automated checks, not an audit."));
});

/* ---------- the dashboard boards ---------- */
await t("dashboard: recent, highest, most red flags, most checked (this week only)", async () => {
  const store = await initStore(data);
  C._test.setStore(store);
  const row = (a, sym, score, at, kind = "coin") => ({ address: a, symbol: sym, kind, score, label: score == null ? "Tokenized stock" : C.bandOf(score).label, tone: "good", reasons: [{ tone: "good", text: "x" }], at, via: "web", by: null });
  const a1 = "0x1111111111111111111111111111111111111111", a2 = "0x2222222222222222222222222222222222222222", a3 = "0x3333333333333333333333333333333333333333";
  await store.writeJson("checks.json", [row(a1, "OLD", 99, NOW - 9 * 86400_000), row(a1, "ONE", 82, NOW - 3600_000), row(a2, "TWO", 12, NOW - 1800_000), row(a2, "TWO", 15, NOW - 600_000), row(a3, "NVDA", null, NOW - 60_000, "stock")]);
  const d = await C.dashboard(NOW);
  assert.equal(d.safest[0].symbol, "ONE");
  assert.equal(d.flagged[0].symbol, "TWO");
  assert.equal(d.flagged[0].score, 15, "latest check of a coin counts");
  assert.equal(d.mostChecked[0].address, a2);
  assert.equal(d.mostChecked[0].checks, 2);
  assert.equal(d.recent[0].symbol, "NVDA");
  assert.equal(d.recent.length, 3, "one row per coin in recent");
  assert.ok(!d.safest.some((r) => r.kind === "stock"), "stocks never on the score boards");
});

/* ---------- the card ---------- */
await t("card: a 1200 × 630 PNG for a scored coin, a stock, an unknown address and a pending check", async () => {
  const sharp = (await import("sharp")).default;
  const out = process.argv.includes("--live") ? null : process.argv[2] || null;
  for (const [name, r] of [["scored", C.scoreCheck(coin())], ["stock", C.scoreCheck({ address: A, kind: "stock", symbol: "NVDA", now: NOW, gate: passedGate(), token: { priceUsd: 181.2 } })], ["unknown", C.scoreCheck({ address: A, kind: "unknown", now: NOW })], ["pending", { address: A, pending: true }]]) {
    const png = await C.cardPng(r);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const m = await sharp(png).metadata();
    assert.equal(m.width, 1200); assert.equal(m.height, 630);
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `fixture-${name}.png`), png); }
  }
});

/* ---------- live, against a running server ---------- */
const li = process.argv.indexOf("--live");
if (li > 0) {
  const base = process.argv[li + 1] || "http://127.0.0.1:9271";
  const out = process.argv[li + 2] || join(data, "cards");
  mkdirSync(out, { recursive: true });
  const LIVE = [["troya", "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"], ["oasis-nosell", "0x3eaf76055acfaa9a6984929fe35d3ab591f67777"], ["oasis-ring", "0xc4f6470fa6a21e5f58f17a203cabe3afd315f2d5"], ["stock-nvda", process.env.CHECK_STOCK || ""]];
  if (!LIVE[3][1]) { const s = await fetch(`${base}/api/market/stocks`).then((r) => r.json()).catch(() => null); const n = (s?.stocks || []).find((x) => /^NVDA$/i.test(x.symbol)) || (s?.stocks || [])[0]; LIVE[3][1] = n?.address || ""; }
  for (const [name, a] of LIVE) {
    if (!a) { console.log("skip", name, "(no address)"); continue; }
    await t(`live ${name}: /api/check, the card and the page`, async () => {
      const r = await fetch(`${base}/api/check/${a}`).then((x) => x.json());
      assert.ok(r.address, JSON.stringify(r).slice(0, 200));
      console.log(`      ${name}: ${r.symbol} ${r.score ?? "–"} ${r.label} · ${r.headline}`);
      for (const p of r.parts || []) console.log(`        ${p.key.padEnd(8)} ${String(p.status).padEnd(9)} ${p.value ?? ""} ${p.summary.slice(0, 120)}`);
      console.log(`      X: ${C.xReplyText(r).replace(/\n/g, " ⏎ ")}`);
      const png = Buffer.from(await (await fetch(`${base}/api/check/${a}/card.png`)).arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      writeFileSync(join(out, `${name}.png`), png);
      const html = await (await fetch(`${base}/check/${a}`)).text();
      assert.ok(html.includes(`content="https://troya.codes/api/check/${r.address}/card.png`), "og:image");
      assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
      if (name === "oasis-nosell") assert.equal(r.gatePassed, false, "no Buy for a coin with no sell route");
      if (name === "stock-nvda") assert.equal(r.kind, "stock");
    });
  }
  console.log("cards saved to", out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
