// Bot commands check: /start (private welcome), /help, /sentry, /badge, /perks and /links answer as expected.
// Telegram calls go to a mock; /badge reads the real chain for the $TROYA contract.
//   ROBINHOOD_RPC=https://robinhood-rpc.publicnode.com node tools/botcmds-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), "troya-botcmds-")), TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", HOLDER_START: "2026-11-16T12:00:00Z" });
const { initStore } = await import("../server/store.mjs");
const store = await initStore(process.env.DATA_DIR);
const bot = await import("../server/tgbot.mjs");
bot.initBot(store);
await (await import("../server/ringradar.mjs")).register({ get() {} }, { store });
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const sent = [];
const admins = new Set([77]);   // user 77 is an admin of every test group
const tg = async (method, p) => {
  sent.push({ method, ...p });
  if (method === "getChatMember") return { ok: true, result: { status: admins.has(p.user_id) ? "administrator" : "member" } };
  return { ok: true, result: { message_id: 1 } };
};
const me = { id: 9, username: "TrojanTroya_bot" };
let n = 0;
async function ask(text, type = "private", { chat, from, extra = {} } = {}) {
  sent.length = 0;
  await bot.handleBotMessage({ message_id: ++n, chat: chat || { id: type === "private" ? 500 : -100, type }, from: { id: from || 1000 + n, first_name: "t" }, text, ...extra }, tg, me);
  return sent.find((c) => c.method === "sendMessage") || null;
}
const CA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

let r = await ask("/start");
ok(r && /Welcome to Troya Agent/.test(r.text) && r.reply_markup?.inline_keyboard?.flat().some((b) => /settings/.test(b.url)), "private /start: welcome with Open Troya and Link Telegram buttons");
ok(r?.reply_markup?.inline_keyboard?.flat().some((b) => b.text === "Add the Gate to your group" && b.url === "https://t.me/TrojanTroya_bot?startgroup=gate") && /troya\.codes\/gate-bot/.test(r.text), "private /start: Add the Gate to your group (startgroup link) and the gate-bot page");
r = await ask("/start", "supergroup");
ok(r && /\/sentry/.test(r.text) && /\/perks/.test(r.text), "/start in the group shows the full help");
r = await ask("/help");
ok(r && ["/trade", "/wallet", "/gate", "/price", "/sentry", "/badge", "/perks", "/ca", "/links", "/rules"].every((c) => r.text.includes(c)), "/help lists every command");
r = await ask("/sentry");
ok(r && /Troya Sentry/.test(r.text) && r.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/troyasentry", "/sentry answers with the channel button");
r = await ask("/perks", "supergroup");
ok(r && /1,000,000 \$TROYA/.test(r.text) && /2026-11-16 12:00 UTC|Live now/.test(r.text) && /200 assistant messages/.test(r.text), "/perks: threshold, switch-on time (or live now), perks");
r = await ask("/badge", "supergroup");
ok(r && /\/badge 0x/.test(r.text) && /troya\.codes\/badge/.test(r.reply_markup?.inline_keyboard?.[0]?.[0]?.url || ""), "/badge without an address explains it");
r = await ask(`/badge ${CA}`, "supergroup");
ok(r && /Troya Gate badge · \$TROYA: (PASSED|CAUTION|FAILED|NOT TESTED YET)/.test(r.text) && r.text.includes(`/api/badge/${CA}.svg`), "/badge 0x… gives the live verdict and the SVG line", (r?.text || "").split("\n")[0]);
r = await ask("/links");
ok(r && /t\.me\/troyasentry/.test(r.text) && /troya\.codes\/badge/.test(r.text), "/links includes Sentry and the badge page");
// every reply about a coin carries buy buttons: Troya Swap through the Gate and Fomo
const fomo = (r, a) => r?.reply_markup?.inline_keyboard?.flat().some((b) => b.url === `https://fomo.family/tokens/robinhood/${a}`);
r = await ask("/ca", "supergroup");
ok(fomo(r, CA) && r.reply_markup.inline_keyboard.flat().some((b) => /swap\?in=eth&out=/.test(b.url)), "/ca has Buy through Troya Gate and Buy on Fomo");
r = await ask(`/gate ${CA}`, "supergroup");
ok(fomo(r, CA), "/gate 0x… has Buy on Fomo");
r = await ask("/sentry", "supergroup");
ok(r && /Troya Sentry/.test(r.text) && !r.reply_markup?.inline_keyboard?.flat().some((b) => /fomo/.test(b.url)), "/sentry still answers as Sentry (the else-if chain is intact)");

// ---- the Gate in other groups (Xivor, 25 Nov 2026)
const OTHER = { id: -2001, type: "supergroup", title: "Some coin" }, HOME = { id: -3001, type: "supergroup", username: "troyaagent", title: "Troya Agent" };
const btns = (r) => (r?.reply_markup?.inline_keyboard || []).flat();
r = await ask("", "supergroup", { chat: OTHER, from: 77, extra: { new_chat_members: [{ id: 9, is_bot: true, first_name: "Troya" }] } });
ok(r && /Troya Gate is in this group/.test(r.text) && /\/gatebuttons off/.test(r.text) && /I'm a bot/.test(r.text) && /never trade/.test(r.text) && /gate-bot/.test(r.text), "bot added to another group: one hello naming /gate, /gatebuttons and that it is a bot");
r = await ask("/start@TrojanTroya_bot gate", "supergroup", { chat: OTHER, from: 77 });
ok(!r, "the /start gate that comes with the same add sends nothing more");
r = await ask("", "supergroup", { chat: OTHER, extra: { new_chat_members: [{ id: 4242, first_name: "newbie" }] } });
ok(!sent.length, "another group: no join check, no message for a newcomer");
r = await ask("", "supergroup", { chat: HOME, extra: { new_chat_members: [{ id: 4243, first_name: "newbie" }] } });
ok(r && /One quick check/.test(r.text), "community group: the join check still runs");
r = await ask(`/gate ${CA}`, "supergroup", { chat: OTHER });
ok(fomo(r, CA) && !/gatebuttons/.test(r.text), "another group, buttons on by default, no second hint after the hello");
r = await ask("/gatebuttons off", "supergroup", { chat: OTHER, from: 5555 });
ok(r && /Only this group's admins/.test(r.text), "/gatebuttons off from a member is refused");
r = await ask("/gatebuttons off", "supergroup", { chat: OTHER, from: 77 });
ok(r && /off/.test(r.text) && /gatebuttons on/.test(r.text), "/gatebuttons off from an admin", r?.text.split("\n")[0]);
r = await ask(`/gate ${CA}`, "supergroup", { chat: OTHER });
ok(r && !r.reply_markup && /Verdict/.test(r.text), "buttons off: /gate comes as text only");
r = await ask("/ca", "supergroup", { chat: OTHER });
ok(r && !r.reply_markup && r.text.includes(CA), "buttons off: /ca comes as text only");
r = await ask("/gatebuttons", "supergroup", { chat: OTHER });
ok(r && /<b>off<\/b>/.test(r.text), "/gatebuttons alone shows the state");
r = await ask(`/price ${CA}`, "supergroup");
ok(fomo(r, CA), "buttons off in one group leave the other groups alone");
r = await ask("/gatebuttons on", "supergroup", { chat: OTHER, extra: { sender_chat: { id: OTHER.id } } });
ok(r && /<b>on<\/b>/.test(r.text), "an anonymous admin (posting as the group) can switch them back on");
r = await ask(`/gate ${CA}`, "supergroup", { chat: OTHER });
ok(fomo(r, CA), "buttons back on");
r = await ask("/gatebuttons off");
ok(r && /for groups/.test(r.text), "/gatebuttons in a private chat explains itself");
// a group that had the bot before the hello existed: the first /gate names /gatebuttons once
const OLD = { id: -2002, type: "supergroup", title: "Older group" };
r = await ask(`/gate ${CA}`, "supergroup", { chat: OLD });
ok(r && /gatebuttons off/.test(r.text) && fomo(r, CA), "first /gate in a group that never got the hello carries the hint");
r = await ask(`/gate ${CA}`, "supergroup", { chat: OLD });
ok(r && !/gatebuttons off/.test(r.text), "only once");
r = await ask(`/gate ${CA}`, "supergroup", { chat: HOME });
ok(r && !/gatebuttons off/.test(r.text) && fomo(r, CA), "community group: buttons on, no hint");
r = await ask("/report", "supergroup", { chat: OTHER, extra: { reply_to_message: { message_id: 1, from: { id: 3 }, text: "x" } } });
ok(!r, "/report in another group is left to that group (nothing sent to the Troya inbox)");

// ---- the /gate text: verdict first, the score named Bytecode, the launch ring for a Pons coin
r = await ask(`/gate ${CA}`, "supergroup");
const t = r?.text || "";
ok(/Verdict: /.test(t) && t.indexOf("Verdict:") < t.indexOf("Bytecode") && /Bytecode \d+\/100/.test(t) && !/Troya Gate \d+\/100/.test(t), "/gate: the verdict comes first and the score reads Bytecode N/100");
console.log("\n--- /gate $TROYA ---\n" + t + "\n---");
const QZ = "0x60951fc692869acc31bef16ceb744e3aabd5f471";   // a recent Pons coin Ring Radar read as amber on 24 Nov 2026
await (await import("../server/ringradar.mjs")).ringCheck(QZ).catch((e) => console.log("  (ring read failed: " + e.message + ")"));
const t0 = Date.now();
r = await ask(`/gate ${QZ}`, "supergroup");
const q = r?.text || "";
ok(/Launch ring: (clear|amber|red)\./.test(q) && /exempt wallet/.test(q) && /first blocks/.test(q), "/gate on a Pons coin carries the Launch ring line (exempt wallets, first-block share, verdict)", `${Date.now() - t0} ms`);
ok(!/Launch ring: amber/.test(q) || /Verdict: (caution|red flag|high risk)/.test(q), "an amber ring never reads as a clean verdict");
console.log("\n--- /gate QZ ---\n" + q + "\n---");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
