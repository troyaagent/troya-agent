// Bot commands check: /start (private welcome), /help, /sentry, /badge, /perks and /links answer as expected.
// Telegram calls go to a mock; /badge reads the real chain for the $TROYA contract.
//   ROBINHOOD_RPC=https://robinhood-rpc.publicnode.com node tools/botcmds-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), "troya-botcmds-")), TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", HOLDER_START: "2026-11-16T12:00:00Z" });
const bot = await import("../server/tgbot.mjs");
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const sent = [];
const tg = async (method, p) => { sent.push({ method, ...p }); return { ok: true, result: { message_id: 1 } }; };
const me = { id: 9, username: "TrojanTroya_bot" };
let n = 0;
async function ask(text, type = "private") {
  sent.length = 0;
  await bot.handleBotMessage({ message_id: ++n, chat: { id: type === "private" ? 500 : -100, type }, from: { id: 1000 + n, first_name: "t" }, text }, tg, me);
  return sent.find((c) => c.method === "sendMessage") || null;
}
const CA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

let r = await ask("/start");
ok(r && /Welcome to Troya Agent/.test(r.text) && r.reply_markup?.inline_keyboard?.flat().some((b) => /settings/.test(b.url)), "private /start: welcome with Open Troya and Link Telegram buttons");
r = await ask("/start", "supergroup");
ok(r && /\/sentry/.test(r.text) && /\/perks/.test(r.text), "/start in the group shows the full help");
r = await ask("/help");
ok(r && ["/trade", "/wallet", "/gate", "/price", "/sentry", "/badge", "/perks", "/ca", "/links", "/rules"].every((c) => r.text.includes(c)), "/help lists every command");
r = await ask("/sentry");
ok(r && /Troya Sentry/.test(r.text) && r.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/troyasentry", "/sentry answers with the channel button");
r = await ask("/perks", "supergroup");
ok(r && /1,000,000 \$TROYA/.test(r.text) && /2026-11-16 12:00 UTC/.test(r.text) && /200 assistant messages/.test(r.text), "/perks: threshold, switch-on time, perks");
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
