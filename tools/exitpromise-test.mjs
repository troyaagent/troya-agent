// Tests for the Exit Promise pilot: what confirms a coin cannot be sold, how claims are sized and who is not covered.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStore } from "../server/store.mjs";
import { _test, SINCE, PER_CLAIM_USD, FUND_CAP_ETH, noteWebBuy } from "../server/exitpromise.mjs";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "\n ", e.message); } };
const H = 3600e3, now = Date.now();
const F = (dt, ok) => ({ at: now - dt, ok, detail: ok === false ? "Test sell: reverted" : null });

await t("one failed sell is not enough", () => assert.equal(_test.confirmedFails([F(1 * H, false)]), null));
await t("two fails less than 3 h apart: not yet", () => assert.equal(_test.confirmedFails([F(2 * H, false), F(0, false)]), null));
await t("two fails 3 h or more apart: confirmed", () => assert.equal(_test.confirmedFails([F(6 * H, false), F(0, false)]).length, 2));
await t("a passing sell in between resets it", () => assert.equal(_test.confirmedFails([F(12 * H, false), F(6 * H, true), F(0, false)]), null));
await t("unknown reads are ignored", () => assert.equal(_test.confirmedFails([F(7 * H, false), F(5 * H, null), F(0, false)]).length, 2));
await t("pilot limits", () => { assert.equal(PER_CLAIM_USD, 10); assert.equal(FUND_CAP_ETH, 0.1); });

const store = await initStore(mkdtempSync(join(tmpdir(), "ep-")));
_test.setStore(store);
const T = "0x" + "ab".repeat(20), W1 = "0x" + "11".repeat(20), W2 = "0x" + "22".repeat(20);
const CREATOR = "0x57b09fe6dab0a7d3776e56e6388c773d6c4d09e4";
_test.setState({ buys: {
  a: { wallet: W1, token: T, at: now - 2 * 86400e3, eth: 0.02, usd: 33.2, covered: true, source: "swap page" },
  b: { wallet: W2, token: T, at: now - 1 * 86400e3, eth: 0.003, usd: 4.98, covered: true, source: "Telegram" },
  c: { wallet: CREATOR, token: T, at: now - 1 * 86400e3, eth: 0.01, usd: 16.6, covered: true, source: "Agent Wallet" },
  d: { wallet: "0x" + "33".repeat(20), token: T, at: now - 9 * 86400e3, eth: 0.01, usd: 16.6, covered: true, source: "swap page" },
  e: { wallet: "0x" + "44".repeat(20), token: T, at: now - 1 * 86400e3, eth: 0.01, usd: 16.6, covered: false, source: "swap page" },
}, coins: {}, claims: [], journalAt: SINCE, at: 0 });
await _test.openClaims(T, [{ at: now - 6 * H, detail: "Test sell: reverted" }, { at: now, detail: "Test sell: reverted" }]);
const claims = _test.getState().claims;
await t("one claim per covered wallet inside 7 days", () => assert.deepEqual(claims.map((c) => c.wallet).sort(), [W1, W2, CREATOR].sort()));
await t("a buy older than 7 days is not covered", () => assert.ok(!claims.some((c) => c.wallet === "0x" + "33".repeat(20))));
await t("a buy the Gate did not pass is not covered", () => assert.ok(!claims.some((c) => c.wallet === "0x" + "44".repeat(20))));
await t("refund capped at $10", () => assert.equal(claims.find((c) => c.wallet === W1).refundUsd, 10));
await t("a small buy is refunded in full", () => assert.equal(claims.find((c) => c.wallet === W2).refundUsd, 4.98));
await t("the creator wallet is not covered", () => { const c = claims.find((x) => x.wallet === CREATOR); assert.equal(c.status, "not covered"); assert.match(c.why, /team|deployer/); });
await t("covered claims wait in the queue", () => assert.equal(claims.find((c) => c.wallet === W1).status, "queued"));
await t("no second claim for the same wallet and coin", async () => { await _test.openClaims(T, []); assert.equal(_test.getState().claims.length, 3); });
await t("used counts proposed and paid only", () => {
  const st = _test.getState();
  st.claims[0].status = "proposed"; st.claims[0].refundEth = 0.006; st.claims[1].status = "paid"; st.claims[1].refundEth = 0.003;
  assert.equal(Math.round(_test.usedEth() * 1e6) / 1e6, 0.009);
});
await t("a sell (coin into ETH) is not a covered buy", async () => assert.equal(await noteWebBuy({ address: W1, t: now, hash: "0x" + "9".repeat(64), usd: 20, tokenIn: T, tokenOut: "ETH" }), null));
await t("a buy before the pilot started is not covered", async () => assert.equal(await noteWebBuy({ address: W1, t: SINCE - 1000, hash: "0x" + "8".repeat(64), usd: 20, tokenIn: "ETH", tokenOut: T }), null));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
