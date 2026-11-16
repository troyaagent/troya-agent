// Group moderation check: today's real spam must score as spam, real member chat must not, and the warn → ban flow,
// /report and admin exemptions behave. No network: Telegram calls go to a mock.
//   node tools/tgmod-test.mjs
const mod = await import("../server/tgmod.mjs");
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };

// seen in t.me/troyaagent on 15 Nov 2026
const SPAM = [
  "Hey Dev 👋 Looking to grow your project? I have 30+ TG channels, 10 big X/Twitter accounts & 12 CoinMarketCap communities ready for promotion.",
  "Your dex rocket 🚀 vote is currently at 0 and flames 🔥 is at 0 I can add up the rocket 🚀 to 300 and flames 🔥 to 100",
  "@admin,Boost your token with @MajorsBoostsBot Increase your token’s DEX exposure and reach more potential traders.",
  "Call the big investors\n ✅ @Crypto_KingCall",
  "Hello mate! 👋\n\nWould you be interested in promoting your project?\n\nI have strong channels, communities, and private groups where I can promote your project",
  "$NIHAO — 106X AND COUNTING! \n\nCalled this one privately at just $80K MC \n\nNow sitting at $8.5M MARKET CAP!\n\nhttps://dexscreener.com/solana/4rsLuj8sBFFMwM4AK6p4R5RbZ7y2m9CGrefxVb29JbgN",
  "$NIHAO NOW AT $10.1M MC! 🔥\n\nAnother milestone reached, Chad! 🐳",
  "Everyone is printing, we are catching all runners",
  "Fade the ghost 100x insider calls at your own risk",
  "Get ready Chad will post the next play shortly make sure you don’t miss it",
  "I just made $10k from rugpull if you are interested in learning how to rugpull I can teach you dm now",
  "$BIG (30K >1.1M) NOW",
  "Make sure you don’t miss out on my next call DM 👉  @SAMMYGALL To take part in my next calls",
  "$SCHIFFY (50K> 1.74M) NOW",
  "﻿24/7 Verified Scanners",
  "Insider calls big profit big win",
  "Don’t hold for too long, but just enough to win 💶💶 insider printing 💰",
  "I invested $500 in this project $SCHIFFY and I make profit of 6K.",
  "Make sure you follow him up he gives good signals and his legit ✅❤️",
  "If you’re serious about catching early plays, make sure you follow him! 🔥\n\nHe shares quality signals, spots interesting plays, and knows his game 💯 🐳🐳",
];
const LEGIT = [
  "troya bot communicates well. great tek", "@TrojanTroya_bot what’s the live price for $troya", "We should setup the skeleton bot for raids",
  "holding nicely for past hrs is a green flag", "Ca", "X", "gm", "Gm gm guys",
  "more people should take a look at what Troya is building. definitely worth checking out if you’re interested in AI and trading",
  "not worried about price movement. the utility works really well,good potential", "Dev you alive", "yurr, dev keeps posting updates and new features on x",
  "Let's push to bond. Good way to begin the week", "soon wen pons vol kicks back in, we will see a pump soon. still believe in pons", "hello there",
  "What are the prizes for the holders?", "Think Troya will cook", "welcome in homies", "I'm 20x long ETH on Hyperliquid", "Website @TrojanTroya_bot",
  "the CA is 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074 right?", "check https://dexscreener.com/robinhood/0x1fcf92a1481e9f4f1f66ad68dfb855df5bfe6c6144009d1bf5e2615f3bcc205e",
];

console.log("A · scoring today's messages");
const missed = SPAM.filter((t) => mod.score(t) < 3);
ok(!missed.length, `all ${SPAM.length} spam messages score 3+`, missed.map((t) => `[${mod.score(t)}] ${t.slice(0, 40)}`).join(" | "));
const hit = LEGIT.filter((t) => mod.score(t) >= 2);
ok(!hit.length, `none of ${LEGIT.length} member messages score 2+`, hit.map((t) => `[${mod.score(t)}] ${t.slice(0, 40)}`).join(" | "));

// mock Telegram
const ADMIN = 1, BOT = 9;
const calls = [];
const tg = async (method, p) => {
  calls.push({ method, ...p });
  if (method === "getChatAdministrators") return { ok: true, result: [{ user: { id: ADMIN } }, { user: { id: BOT, is_bot: true } }] };
  if (method === "sendMessage") return { ok: true, result: { message_id: 9000 + calls.length } };
  return { ok: true, result: true };
};
const me = { id: BOT, username: "TrojanTroya_bot" };
let mid = 100;
const msg = (uid, text, extra = {}) => ({ message_id: ++mid, chat: { id: -100, type: "supergroup" }, from: { id: uid, first_name: `u${uid}` }, text, ...extra });
const did = (method, f = () => true) => calls.filter((c) => c.method === method && f(c));
const reset = () => (calls.length = 0);

console.log("B · warn, then ban");
reset();
let r = await mod.screen(msg(50, "", { text: undefined, caption: "", photo: [{}], forward_origin: { type: "channel", chat: { id: -2001, title: "SAMMY Galaxy BIG VIP" } } }), tg, me);
ok(r && did("deleteMessage").length === 1 && !did("banChatMember").length && did("sendMessage", (c) => /warning/.test(c.text)).length === 1, "a forwarded channel ad is removed with a warning, no ban");
reset();
r = await mod.screen(msg(50, "$BIG (30K >1.1M) NOW"), tg, me);
ok(r && did("banChatMember", (c) => c.user_id === 50 && c.revoke_messages).length === 1, "the next promo from the same person is a ban, messages revoked");
reset();
r = await mod.screen(msg(51, "I just made $10k from rugpull if you are interested in learning how to rugpull I can teach you dm now"), tg, me);
ok(r && did("banChatMember", (c) => c.user_id === 51).length === 1, "a scam is a ban on the first message");
reset();
r = await mod.screen(msg(52, "$NIHAO — 106X AND COUNTING! https://dexscreener.com/solana/4rsLuj8sBFFMwM4AK6p4R5RbZ7y2m9CGrefxVb29JbgN"), tg, me);
ok(r && did("banChatMember", (c) => c.user_id === 52).length === 1, "plain spam (many signals) is a ban on the first message");
reset();
await mod.screen(msg(53, "24/7 Verified Scanners"), tg, me);
r = await mod.screen(msg(53, "sorry, did not know the rules"), tg, me);
ok(!r && !did("banChatMember").length, "after a warning, a plain chat line still goes through");

console.log("C · /report");
reset();
const shill = msg(60, "Make sure you follow him up he gives good signals and his legit ✅❤️");
r = await mod.screen(msg(61, "/report", { reply_to_message: shill }), tg, me);
ok(r && did("deleteMessage", (c) => c.message_id === shill.message_id).length === 1, "a reported promo message is removed at once");
reset();
const normal = msg(62, "this coin is mid tbh");
await mod.screen(msg(63, "/report", { reply_to_message: normal }), tg, me);
ok(!did("deleteMessage", (c) => c.message_id === normal.message_id).length, "one report on a normal message only notes it");
await mod.screen(msg(64, "/report", { reply_to_message: normal }), tg, me);
ok(did("deleteMessage", (c) => c.message_id === normal.message_id).length === 1, "a second member's report removes it");
reset();
const adminMsg = msg(ADMIN, "Call the big investors ✅ @Crypto_KingCall");
await mod.screen(msg(65, "/report", { reply_to_message: adminMsg }), tg, me);
ok(!did("deleteMessage", (c) => c.message_id === adminMsg.message_id).length, "admins' messages can't be reported away");
reset();
const target = msg(66, "hello there");
await mod.screen(msg(ADMIN, "/ban", { reply_to_message: target }), tg, me);
ok(did("banChatMember", (c) => c.user_id === 66).length === 1, "an admin's /ban bans at once");

console.log("D · never touched");
reset();
r = await mod.screen(msg(ADMIN, "$BIG (30K >1.1M) NOW https://pump.fun/x"), tg, me);
ok(!r && !did("deleteMessage").length, "admins are never moderated");
r = await mod.screen(msg(70, "gm, holding $TROYA"), tg, me);
ok(!r, "normal chat passes");
r = await mod.screen(msg(71, "", { text: undefined, caption: "new Sentry post", forward_origin: { type: "channel", chat: { id: -1004430431881 } } }), tg, me);
ok(!r, "a forward from Troya Sentry passes");
ok(/1FA81ddaAAc83240803B3F2d20595E40Edc1a074/.test(mod.rulesText()), "rules carry the official CA");

// blacklist (Calvin, 15 Nov): every logged message naming these services is removed; ordinary words nearby are not
const BL = ["dex gempump listed update coming mate?", "Gempump listed next ?", "Gempump incoming?", "when list on dexvra bro", "when fourtis listing?",
  "heard about dexvra listing @dexvrabot", "can you list on dexvra.io? @dexvrabot", "fourvote soon?", "you should add the fourvote bot @fourtistechbot — more votes, more volume",
  "@admin we need to keep momentum, start MajorBoostBot lets top 1-3 trending and get free post in fourtis announcement it will get more eyes and new buyers",
  "would be nice to see this listed on @coin_trending.", "hello champ, CoinTrending could be a valuable platform for our coin Let's get this gem trending on coin_trendi",
  "@admin,Boost your token with @MajorsBoostsBot\nIncrease your token’s DEX exposure and reach more potential traders.",
  "Your dex rocket 🚀 vote is currently at 0 and flames 🔥 is at 0 I can add up the rocket 🚀 to 300 and flames 🔥 to 100 or any number of your choice not bot not fake users real people",
  "🔥 TRENDING 🔥\n\nSymbol: $TROYA\nName: Troya Agent\n⏰ Age:  18 hours ago", "get it trending with @trendingsolbot", "🔥 $AKE has received a new Fourvote!\n\n🚀 Total Fourvotes: 349 💎\n📊 FourRank: #1", "gem pump when", "F0URTIS listing"];
const blMiss = BL.filter((t) => mod.score(t) < 3);
ok(!blMiss.length, `all ${BL.length} blacklisted messages score 3+ (removed)`, blMiss.join(" | "));
const NEAR = ["we got four votes on the proposal", "go vote rocket on dexscreener guys", "when listing on coingecko?", "@Carl_NFT thanks for the listing tip", "troya is trending on dexscreener today", "@TrojanTroya_bot is troya listed on dexscreener?", "that was a major boost for the project", "four times in a row", "dex paid is done", "is troya on dexscreener?"];
const nearHit = NEAR.filter((t) => mod.score(t) >= 2);
ok(!nearHit.length, `none of ${NEAR.length} near-miss messages are touched`, nearHit.join(" | "));

// 16 Nov: a listing crew seeding "not listed on HoodHunters" / DexSocials, and a fake V2 migration pointing at a look-alike DexScreener bot
const SCAM_V2 = "📢 Official Announcement\n\nAfter extensive discussions regarding the project’s marketing direction, we’ve decided to move forward with a rebrand and relaunch designed to align with the project’s new direction.\n\n🔄 V2 Relaunch & Migration\n\nThe relaunch process is expected to take approximately one hour. Supporting KOLs have been notified and will be updated as the relaunch progresses.\n\n🎁 Holder Migration\n\nTo process the V2 allocation, all eligible holders should use the designated migration portal to verify their previous token holdings and updated V2 allocation.\n\n👉 Migration Portal: @DexSreeenerTrading_Bot\n\n📌 Stay tuned for further official updates.";
const LIST16 = ["We are still early boys, still not listed on HoodHunters", "The more, the merrier! Let’s aim to be listed on all major platforms for maximum attention!",
  "Updating DexSocials is a smart move.", "Keep Buying Guys!!  HoodHunters .app listing soon", "Hello! Please update our Telegram, X & website on DexSocials . Thanks!",
  "The more listings, the better! Let’s get on more sites and boost our visibility!", "Could you confirm our listing on hoodHunters .app?",
  "Have you considered listing on cointrending sir?", "have you considered listing on Coinsniper?", "please update our website on tokenlistr",
  SCAM_V2, "Migration portal: @TroyaV2Claim_bot", "V2 airdrop is live, check your allocation here: https://troya-v2.app", "use @DexScreenerMigrationBot to verify your holdings"];
const l16Miss = LIST16.filter((t) => mod.score(t) < 3);
ok(!l16Miss.length, `all ${LIST16.length} listing-crew and fake-migration messages score 3+ (removed)`, l16Miss.map((t) => `[${mod.score(t)}] ${t.slice(0, 40)}`).join(" | "));
const NEAR16 = ["is there a v2 coming?", "is this migration real?", "someone posted a migration thing, is it legit?", "when cmc listing?", "are we listed on dexscreener yet?",
  "not listed on coingecko yet, soon?", "can you update the website on dexscreener?", "Tweet away, everyone! Let’s get the word out — I scooped some coins.",
  "airdrop for holders? the link is https://troya.codes/holders", "is the holder airdrop on the bot @TrojanTroya_bot", "the update is on x.com/Troyaagent",
  "great listing on uniswap", "dexscreener shows the chart", "Keep Buying Guys!!", "Profile Updated?", "is there an allocation for early holders?"];
const near16 = NEAR16.filter((t) => mod.score(t) >= 2);
ok(!near16.length, `none of ${NEAR16.length} holder questions are touched`, near16.map((t) => `[${mod.score(t)}] ${t}`).join(" | "));
reset();
r = await mod.screen(msg(80, SCAM_V2), tg, me);
ok(r && did("banChatMember", (c) => c.user_id === 80 && c.revoke_messages).length === 1, "a fake V2 migration post is a ban on the first message, messages revoked");
reset();
r = await mod.screen(msg(81, "Updating DexSocials is a smart move."), tg, me);
ok(r && did("deleteMessage").length === 1 && !did("banChatMember").length, "a one-line listing pitch is removed with a warning, no ban the first time");
reset();
r = await mod.screen(msg(82, "Could you confirm our listing on hoodHunters .app?"), tg, me);
ok(r && did("banChatMember", (c) => c.user_id === 82).length === 1, "a blacklisted name inside the listing script (two signals) is a ban at once");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
