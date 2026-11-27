// Tests for Check Watch (holder review idea E): what counts as a change, and the /follow commands. No chain reads.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStore } from "../server/store.mjs";
import { _test, botCommand as bc0, watchOf, summary, onCallback, alertMessage } from "../server/checkwatch.mjs";
const botCommand = async (...a) => { const o = await bc0(...a); return typeof o === "string" ? o : o.text; };

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
const np = { ...base, pons: false };
await t("liquidity halves (a non-Pons pool)", () => assert.match(_test.changesOf(np, { ...np, liq: 9000 }, now)[0].text, /\$20\.0K to \$9\.0K/));
await t("a Pons coin never fires a liquidity note", () => assert.equal(_test.changesOf(base, { ...base, liq: 100 }, now).length, 0));
await t("liquidity down 40% is quiet", () => assert.equal(_test.changesOf(np, { ...np, liq: 12000 }, now).length, 0));
await t("tiny pools are quiet", () => assert.equal(_test.changesOf({ ...np, liqRef: 1500 }, { ...np, liq: 100 }, now).length, 0));
await t("one liquidity note per 6 hours", () => assert.equal(_test.changesOf({ ...np, liqAt: now - 3600e3 }, { ...np, liq: 5000 }, now).length, 0));

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
await t("bare /unfollow with one coin stops it", async () => { await botCommand("follow", A, dm); assert.match(await botCommand("unfollow", "", dm), /^Stopped/); });
await t("bare /unfollow with none", async () => assert.match(await botCommand("unfollow", "", dm), /don't follow any coin/));
await t("unfollow twice", async () => assert.match(await botCommand("unfollow", A, dm), /were not following/));

// buttons
const calls = [];
const tg = async (method, body) => { calls.push({ method, body }); return { ok: true }; };
const cq = (data, text = "Following 0x…", kb = [[{ text: "Troya Check", url: "x" }, { text: "Stop alerts", callback_data: `cw:u:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074` }]]) =>
  ({ id: "q1", data, from: { id: 42 }, message: { message_id: 7, chat: { id: 42, type: "private" }, text, reply_markup: { inline_keyboard: kb } } });
await t("follow reply has Stop + Check buttons", async () => { const o = await bc0("follow", A, dm); assert.equal(o.markup.inline_keyboard[0][1].callback_data, "cw:u:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"); });
await t("Stop button unfollows and swaps to Alert me", async () => {
  calls.length = 0;
  await onCallback(cq("cw:u:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"), tg);
  assert.match(calls[0].body.text, /^Stopped/);
  assert.equal(calls[1].method, "editMessageReplyMarkup");
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][1].callback_data, "cw:f:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074");
  assert.equal(watchOf(A).followers, 0);
});
await t("Alert me button follows again", async () => {
  calls.length = 0;
  await onCallback(cq("cw:f:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", "Following …", [[{ text: "Alert me on changes", callback_data: "cw:f:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074" }]]), tg);
  assert.match(calls[0].body.text, /^Following: alerts/);
  assert.equal(watchOf(A).followers, 1);
});
await t("Stop on the /following list redraws it", async () => {
  calls.length = 0;
  await onCallback(cq("cw:u:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", "You follow 1 coin"), tg);
  assert.equal(calls[1].method, "editMessageText");
  assert.match(calls[1].body.text, /don't follow any coin/);
});
await t("buttons in a group only point to the private chat", async () => {
  calls.length = 0;
  const c = cq("cw:f:0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074"); c.message.chat = { id: -100, type: "supergroup" };
  await onCallback(c, tg);
  assert.match(calls[0].body.text, /private chat/); assert.equal(watchOf(A).followers, 0);
});
await t("following list shows the ticker and a Stop button per coin", async () => {
  await bc0("follow", A, dm);
  const o = await bc0("following", "", dm);
  assert.match(o.text, /\$TROYA · <code>0x1FA8/); assert.match(o.text, /now 71/);
  assert.equal(o.markup.inline_keyboard[0][1].text, "Stop $TROYA");
});
await t("alert text and buttons", () => {
  const o = alertMessage({ address: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", symbol: "TROYA", text: "Ownership was renounced", before: 74, after: 80, label: "Fair" });
  assert.match(o.text, /\$TROYA\nWhat changed: Ownership was renounced\.\nTroya checked it again: <b>74 → 80<\/b>/);
  assert.equal(o.markup.inline_keyboard[0].length, 2);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
