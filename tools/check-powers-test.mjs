// Troya Check: contract powers (27 Nov). What a token's owner can still do, from tokenHealth (bytecode selectors, owner(), the
// EIP-1967 proxy and admin slots): the part's value, its caps, its findings, the new weights, and tokenHealth failing.
//   node tools/check-powers-test.mjs        offline, fixtures only; nothing posted
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "troya-powers-"));
const C = await import("../server/check.mjs");
const { getAddress } = await import("ethers");
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const A = getAddress("0x9999999999999999999999999999999999999999");
const OWNER = "0x2222222222222222222222222222222222222222", DEAD = "0x000000000000000000000000000000000000dEaD";
const none = { mint: [], pause: [], blacklist: [], fees: [], limits: [], trading: [], owner: [] };
const health = (over = {}) => ({ address: A, isContract: true, kind: "unknown", proxy: null, owner: OWNER, ownerRenounced: false, functions: { ...none, owner: ["owner()"] }, flags: [], ...over });
const fns = (o) => ({ ...none, owner: ["owner()", "transferOwnership(address)"], ...o });

const NOW = Date.UTC(2026, 10, 27, 12, 0);
const ck = (key, status, detail) => ({ key, status, label: key, detail });
const coin = (h) => ({ address: A, kind: "coin", symbol: "TOKEN", now: NOW, health: h,
  gate: { word: "passed", verdict: "passed", checks: [ck("route", "pass", "ok"), ck("impact", "pass", "0.3%"), ck("depth", "pass", "40 ETH"), ck("fee", "pass", "0.3%"), ck("sim", "pass", "ok"), ck("sell", "pass", "Selling back returns 0.0098 ETH"), ck("tax", "pass", "None detected"), ck("ring", "pass", "No ring pattern."), ck("devlinks", "pass", "ok")] },
  ring: { verdict: "clear", reasons: [] }, devlinks: { status: "pass", linked: { count: 0, holdsPct: 0 }, devSide: { devHoldsPct: 0, soldPct: 0, soldOfGotPct: 0 } },
  assay: { status: "done", flags: [], dev: { soldPct: 0 }, devSide: { soldOfGotPct: 0 }, wash: { trades: 300, washPct: 2 } }, token: { liquidityUsd: 900_000, holders: 13_000, priceUsd: 1 },
  heel: { kind: "coin", severity: "none", partial: false, heel: "none", facts: [] }, clash: { clash: false, count: 1, ticker: "TOKEN", others: [] }, bornAt: NOW - 60 * 86400e3 });

await t("weights: contract powers 10, still 100 in all", () => {
  assert.equal(C.WEIGHTS.powers, 10);
  assert.equal(Object.values(C.WEIGHTS).reduce((a, b) => a + b, 0), 100);
});
await t("mintable token with an active owner: value low, capped at 40, the mint signature named", () => {
  const p = C.powersPart(health({ functions: fns({ mint: ["mint(address,uint256)"] }) }), A);
  assert.ok(p.value <= 0.4, `value ${p.value}`); assert.equal(p.cap.at, C.CAPS.powersMint); assert.equal(p.tone, "bad");
  assert.match(p.summary, /mint \(mint\(address,uint256\)\)/);
  const r = C.scoreCheck(coin(health({ functions: fns({ mint: ["mint(address,uint256)"] }) })));
  assert.ok(r.score <= C.CAPS.powersMint, `score ${r.score}`);
  const f = r.findings.find((x) => x.title === "Contract powers");
  assert.equal(f.kind, "risk"); assert.match(f.text, /mint\(address,uint256\)/);
});
await t("blacklist / pause / trading switch with an active owner: capped at 45", () => {
  for (const o of [{ blacklist: ["blacklist(address)"] }, { pause: ["pause()", "unpause()"] }, { trading: ["setTradingEnabled(bool)"] }]) {
    const r = C.scoreCheck(coin(health({ functions: fns(o) })));
    assert.ok(r.score <= C.CAPS.powersTrap, `${Object.keys(o)[0]}: score ${r.score}`);
    assert.ok(r.caps.some((c) => c.at === C.CAPS.powersTrap));
  }
});
await t("fee setter with an active owner: capped at 74 (no hard maximum read)", () => {
  const r = C.scoreCheck(coin(health({ functions: fns({ fees: ["setFees(uint256,uint256)"] }) })));
  assert.ok(r.score <= C.CAPS.powersFees, `score ${r.score}`);
  assert.ok(r.caps.some((c) => /no hard maximum/.test(c.why)));
});
await t("upgradeable proxy with a live admin: capped at 60; with no admin and no owner: lowered, not capped", () => {
  const proxy = { type: "EIP-1967 upgradeable proxy", implementation: "0x3333333333333333333333333333333333333333" };
  const live = C.powersPart(health({ owner: null, ownerRenounced: null, functions: none, proxy, proxyAdmin: "0x4444444444444444444444444444444444444444" }), A);
  assert.equal(live.cap.at, C.CAPS.powersUpgrade); assert.match(live.summary, /admin 0x4444…4444/);
  const unknown = C.powersPart(health({ owner: null, ownerRenounced: null, functions: none, proxy, proxyAdmin: "0x0000000000000000000000000000000000000000" }), A);
  assert.equal(unknown.cap, null); assert.ok(unknown.value < 1); assert.match(unknown.summary, /who can upgrade it was not found/);
  const byOwner = C.powersPart(health({ functions: none, proxy }), A);
  assert.equal(byOwner.cap.at, C.CAPS.powersUpgrade, "no admin slot, but an active owner upgrades it");
});
await t("renounced owner: full value, WORKS, even with mint and fee functions in the code", () => {
  const p = C.powersPart(health({ owner: DEAD, ownerRenounced: true, functions: fns({ mint: ["mint(address,uint256)"], fees: ["setFee(uint256)"] }) }), A);
  assert.equal(p.value, 1); assert.equal(p.cap, null); assert.match(p.summary, /renounced/);
  const r = C.scoreCheck(coin(health({ owner: DEAD, ownerRenounced: true, functions: fns({ mint: ["mint(address,uint256)"] }) })));
  assert.equal(r.findings.find((x) => x.title === "Contract powers").kind, "works");
  assert.equal(r.label, "No major flags");
});
await t("Pons template coin (no owner): a clean 1.0 with an INFO finding saying so", () => {
  const h = health({ kind: "pons", owner: null, ownerRenounced: null, functions: { ...none, mint: ["mint(address,uint256)"] } });
  const p = C.powersPart(h, A);
  assert.equal(p.value, 1); assert.match(p.summary, /Pons template coin/);
  const r = C.scoreCheck(coin(h));
  assert.equal(r.findings.find((x) => x.title === "Contract powers").kind, "info");
  assert.equal(r.label, "No major flags");
});
await t("mint functions but no owner() (role-based control): a warning, not clean, not capped", () => {
  const p = C.powersPart(health({ owner: null, ownerRenounced: null, functions: { ...none, mint: ["mint(address,uint256)"] } }), A);
  assert.ok(p.value < 1 && p.value > 0.5, `value ${p.value}`); assert.equal(p.cap, null); assert.equal(p.tone, "warn");
  assert.match(p.summary, /no owner\(\) to show who can call them/);
});
await t("tokenHealth failing: 'not read', left out of the score, listed as MISSING", () => {
  for (const h of [null, { error: "Robinhood Chain could not be read" }]) {
    const r = C.scoreCheck(coin(h));
    const p = r.parts.find((x) => x.key === "powers");
    assert.equal(p.status, "not read"); assert.equal(p.points, undefined);
    assert.equal(r.findings.find((x) => x.title === "Contract powers").kind, "missing");
    assert.ok(C.complete(r), "contract powers are not a core part: the answer still completes");
  }
});
await t("the Exit gauge counts contract powers; 'what would change this' names the owner renouncing", () => {
  const clean = C.scoreCheck(coin(health({ owner: DEAD, ownerRenounced: true })));
  const owned = C.scoreCheck(coin(health({ functions: fns({ blacklist: ["blacklist(address)"] }) })));
  assert.ok(owned.sub.exit < clean.sub.exit, `${owned.sub.exit} < ${clean.sub.exit}`);
  assert.ok(owned.changes.some((x) => /renouncing/.test(x)));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
