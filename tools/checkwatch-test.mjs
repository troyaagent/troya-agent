// Tests for Check Watch (holder review idea E): what counts as a change, and the /follow commands. No chain reads.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStore } from "../server/store.mjs";
import { _test, botCommand, watchOf, summary } from "../server/checkwatch.mjs";

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "\n ", e.message); } };
const A = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
const R1 = "0x57b0" + "0".repeat(32) + "d4e4", R2 = "0x9999000000000000000000000000000000000001";
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const base = { pons: true, rec: R1, tax: 190, grad: true, impl: "0x" + "0".repeat(64), owner: undefined, liq: 20000, liqRef: 20000, liqAt: 0 };
const now = 1_800_000_000_000;

await t("no change, no event", () => assert.equal(_test.changesOf(base, { ...base }, now).length, 0));
await t("an unread field is never an event", () => assert.equal(_test.changesOf(base, { pons: true, rec: undefined, tax: undefined, grad: undefined, impl: undefined, liq: undefined }, now).length, 0));
await t("fee recipient change", () => { const c = _test.changesOf(base, { ...base, rec: R2 }, now); assert.equal(c[0].kind, "fee-recipient"); assert.match(c[0].text, /now goes to 0x9999…0001/i); });
await t("tax change", () => assert.match(_test.changesOf(base, { ...base, tax: 500 }, now)[0].text, /1\.9% to 5%/));
await t("graduation", () => assert.equal(_test.changesOf({ ...base, grad: false }, { ...base }, now)[0].kind, "graduated"));
await t("became a proxy", () => assert.match(_test.changesOf(base, { ...base, impl: pad(R2) }, now)[0].text, /became an upgradeable proxy/));
await t("upgrade", () => assert.match(_test.changesOf({ ...base, impl: pad(R1) }, { ...base, impl: pad(R2) }, now)[0].text, /upgraded: implementation 0x57b0…d4e4 → 0x9999…0001/i));
await t("owner renounced", () => assert.match(_test.changesOf({ ...base, owner: pad(R1) }, { ...base, owner: "0x" + "0".repeat(64) }, now)[0].text, /renounced/));
await t("owner moved", () => assert.match(_test.changesOf({ ...base, owner: pad(R1) }, { ...base, owner: pad(R2) }, now)[0].text, /changed from 0x57b0…d4e4 to 0x9999…0001/i));
await t("owner first read (was unknown) is not an event", () => assert.equal(_test.changesOf(base, { ...base, owner: pad(R2) }, now).length, 0));
await t("liquidity halves", () => assert.match(_test.changesOf(base, { ...base, liq: 9000 }, now)[0].text, /\$20\.0K to \$9\.0K/));
await t("liquidity down 40% is quiet", () => assert.equal(_test.changesOf(base, { ...base, liq: 12000 }, now).length, 0));
await t("tiny pools are quiet", () => assert.equal(_test.changesOf({ ...base, liqRef: 1500 }, { ...base, liq: 100 }, now).length, 0));
await t("one liquidity note per 6 hours", () => assert.equal(_test.changesOf({ ...base, liqAt: now - 3600e3 }, { ...base, liq: 5000 }, now).length, 0));

// the /follow commands with a scratch store (a coin already checked, so no chain read is needed)
const store = await initStore(mkdtempSync(join(tmpdir(), "cw-")));
await store.writeJson("checks.json", [{ address: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", kind: "coin", score: 71, label: "Fair", symbol: "TROYA", at: now }]);
_test.setStore(store);
_test.setFollows({ chats: {} });
_test.setState({ fp: {}, events: [], passAt: 0 });
const dm = { chat: { id: 42, type: "private" } };
await t("follow by address", async () => { const out = await botCommand("follow", A, dm); assert.match(out, /^Following <code>0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074<\/code> \(\$TROYA\)/); assert.match(out, /now 71, Fair/); });
await t("follow twice", async () => assert.match(await botCommand("follow", A, dm), /^Already following/));
await t("following lists it", async () => assert.match(await botCommand("following", "", dm), /You follow 1 coin/));
await t("saved to the store", async () => assert.deepEqual((await store.readJson("check-follows.json", {})).chats["42"], ["0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"]));
await t("page shows 1 follower", () => assert.equal(watchOf(A).followers, 1));
await t("summary counts", () => { const s = summary(); assert.equal(s.followedCoins, 1); assert.equal(s.followingChats, 1); });
await t("unknown coin needs a check first", async () => assert.match(await botCommand("follow", "0x" + "ab".repeat(20), dm).catch((e) => e.message), /has not checked|not/));
await t("in a group: points to the private chat", async () => assert.match(await botCommand("follow", A, { chat: { id: -100, type: "supergroup" } }), /private chat/));
await t("usage", async () => assert.match(await botCommand("follow", "", dm), /^Usage/));
await t("unfollow", async () => { assert.match(await botCommand("unfollow", A, dm), /^Stopped/); assert.match(await botCommand("following", "", dm), /don't follow any coin/); });
await t("unfollow twice", async () => assert.match(await botCommand("unfollow", A, dm), /were not following/));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
