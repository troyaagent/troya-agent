// Phase 2 test: trading in a private Telegram chat, end to end in one process, against a fresh data dir.
// The real server modules run (auth, Agent Wallet, Gate, policy, journal); Telegram is a recorder, so nothing is sent
// to Telegram. By default TROYA_NO_BROADCAST=1: transactions are built, never sent.
//   node tools/tgtrade-test.mjs                      dry run: every path, no transaction
//   LIVE=1 FUND=0.012 node tools/tgtrade-test.mjs    real money (test wallet only): fund a fresh Agent Wallet, buy 0.01 ETH of
//                                                    $TROYA through the Telegram flow, sell 100% back, withdraw everything
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const LIVE = process.env.LIVE === "1";
const data = mkdtempSync(join(tmpdir(), "troya-tgtrade-"));
Object.assign(process.env, { TG_TRADE_BUYS: process.env.TG_TRADE_BUYS || "", TG_TRADE: "1", DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "" });
if (!LIVE) process.env.TROYA_NO_BROADCAST = "1";
const { initApi, handleApi } = await import("../server/api.mjs");
await initApi({ dataDir: data, root: join(import.meta.dirname, "..") });
const trade = await import("../server/tgtrade.mjs");
const { Wallet, JsonRpcProvider, parseEther, formatEther } = await import("ethers");

const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || ""}`); return j;
}
// Telegram recorder
let calls = [], mid = 100;
const tg = async (method, payload) => { calls.push({ method, payload }); return { ok: true, result: { message_id: ++mid } }; };
const last = (m) => [...calls].reverse().find((c) => !m || c.method === m)?.payload || {};
const btns = () => (last().reply_markup?.inline_keyboard || []).flat();
const store = { readJson: async (n, fb) => { try { return JSON.parse(readFileSync(join(data, n), "utf8")); } catch { return fb; } } };
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const msg = (chat, text, type = "private", from = chat) => ({ message_id: ++mid, chat: { id: chat, type }, from: { id: from }, text });
const cq = (data, from, chat) => ({ id: "cq" + ++mid, data, from: { id: from }, message: { chat: { id: chat }, message_id: mid } });
const ME = 777, OTHER = 999, GROUP = -100123;
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const YOUNG = process.env.YOUNG || "0x5239b9e9f986f63794d8f8e55282c0895dd99590";

const env = Object.fromEntries(readFileSync(`${homedir()}/.config/troya/test-wallet.env`, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const prov = new JsonRpcProvider(process.env.RPC || "https://robinhood-rpc.publicnode.com", 4663, { staticNetwork: true });
const me = new Wallet(env.TEST_WALLET_KEY, prov);
console.log(`${LIVE ? "LIVE (real money)" : "dry run (no broadcast)"} · owner = test wallet ${me.address.slice(0, 8)}… · data ${data}`);

console.log("A · who may trade");
ok(!(await trade.handleMessage(msg(ME, "hello"), tg, store)), "ordinary text falls through to the normal bot");
ok(!(await trade.handleMessage(msg(GROUP, TROYA, "supergroup", ME), tg, store)), "an address pasted in the group is left to the group bot");
calls = []; ok(await trade.handleMessage(msg(GROUP, `/trade ${TROYA}`, "supergroup", ME), tg, store) && /private chat/.test(last().text), "/trade in the group → private chat only");
calls = []; ok(await trade.handleMessage(msg(OTHER, `/trade ${TROYA}`), tg, store) && /Link this chat/.test(last().text), "unlinked chat → link first");

const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
writeFileSync(join(data, "telegram.json"), JSON.stringify({ links: { [me.address.toLowerCase()]: ME }, codes: {} }));
calls = []; ok(await trade.handleMessage(msg(ME, `/trade ${TROYA}`), tg, store) && /need an Agent Wallet/.test(last().text), "linked, no Agent Wallet → create one first");

const aw = await call("POST", "/api/agent-wallet/create");
console.log(`  Agent Wallet ${aw.address} · caps $${aw.caps?.perTradeUsd}/trade, $${aw.caps?.dailyUsd}/day`);
if (aw.caps?.perTradeUsd != null && aw.caps.perTradeUsd < 60) await call("POST", "/api/agent-wallet/settings", { caps: { perTradeUsd: 60, dailyUsd: 200 } }).catch((e) => console.log("  (caps unchanged:", e.message + ")"));
calls = []; ok(await trade.handleMessage(msg(ME, "/wallet"), tg, store) && last().text.includes(aw.address), "/wallet shows the Agent Wallet address and caps");

if (LIVE) {
  const fund = await me.sendTransaction({ to: aw.address, value: parseEther(process.env.FUND || "0.012") });
  await fund.wait(); console.log(`  funded ${process.env.FUND || "0.012"} ETH · https://robinhoodchain.blockscout.com/tx/${fund.hash}`);
}

console.log("B · the card");
calls = []; await trade.handleMessage(msg(ME, `/start t_${TROYA}`), tg, store);
const c1 = last("editMessageText"); if (process.env.SHOW) console.log("-----\n" + c1.text + "\n-----");
ok(/Troya Gate: <b>Passed<\/b>/.test(c1.text || ""), "deep link from a Sentry post opens the $TROYA card, Gate passed", (c1.text || "").split("\n")[1]);
const b1 = btns(); const buy = b1.find((b) => /^Buy /.test(b.text) && b.callback_data);
ok(!!buy && b1.every((b) => !b.callback_data || /^tt:[0-9a-f]{12}$/.test(b.callback_data)), "three Buy buttons with opaque ids", b1.map((b) => b.text).join(" | "));

calls = []; await trade.handleMessage(msg(ME, YOUNG), tg, store);
const c2 = last("editMessageText");
ok(/Blocked/.test(c2.text || "") && btns().some((b) => /Buy locked/.test(b.text)) && !btns().some((b) => /^Buy 0/.test(b.text)), "a thin young curve → Blocked, no Buy buttons", (c2.text || "").split("\n")[1]);
const why = btns().find((b) => /Buy locked/.test(b.text));
calls = []; await trade.handleCallback(cq(why.callback_data, ME, ME), tg); ok(last().show_alert && /depth|Pool|fail/i.test(last().text || ""), "Buy locked · why explains the failed check", (last().text || "").slice(0, 70));

console.log("C · two taps, only the owner");
calls = []; await trade.handleCallback(cq(buy.callback_data, OTHER, OTHER), tg); ok(/someone else/.test(last().text || ""), "another user can't use the buttons");
calls = []; await trade.handleCallback(cq("tt:000000000000", ME, ME), tg); ok(/expired/.test(last().text || ""), "unknown or old ids are refused");
calls = []; await trade.handleCallback(cq(buy.callback_data, ME, ME), tg);
const conf = btns().find((b) => b.text === "Confirm");
ok(!!conf && /Buy <b>[\d.]+ ETH<\/b>/.test(last("editMessageText").text || ""), `${buy.text} → confirm step, nothing sent yet`);
calls = []; await trade.handleCallback(cq(buy.callback_data, ME, ME), tg); ok(/expired/.test(last().text || ""), "a used pick button can't be replayed");
calls = []; await trade.handleCallback(cq(conf.callback_data, ME, ME), tg);
const res = last("editMessageText").text || "";
ok(LIVE ? /Done|Sent/.test(res) : /Built, not sent|Not sent/.test(res), "Confirm runs the Agent Wallet (Gate + caps again)", res.replace(/\n/g, " · ").slice(0, 160));
calls = []; await trade.handleCallback(cq(conf.callback_data, ME, ME), tg); ok(/expired/.test(last().text || ""), "Confirm can't be pressed twice");

if (LIVE) {
  console.log("D · sell back and withdraw");
  await new Promise((r) => setTimeout(r, 6000));                    // let the RPC catch up with the buy
  calls = []; await trade.handleMessage(msg(ME, `/trade ${TROYA}`), tg, store);
  const sell = btns().find((b) => b.text === "Sell 100%");
  ok(!!sell, "the card now offers Sell 25 / 50 / 100%");
  if (sell) {
    calls = []; await trade.handleCallback(cq(sell.callback_data, ME, ME), tg);
    const c = btns().find((b) => b.text === "Confirm");
    calls = []; await trade.handleCallback(cq(c.callback_data, ME, ME), tg);
    const r = last("editMessageText").text || ""; ok(/Done|Sent/.test(r), "Sell 100% → Confirm → sold", r.replace(/\n/g, " · ").slice(0, 160));
  }
  await new Promise((r) => setTimeout(r, 4000));
  const bal = Number(formatEther(await prov.getBalance(aw.address)));
  const gas = 0.00002;
  if (bal > gas) { const w = await call("POST", "/api/agent-wallet/withdraw", { amount: +(bal - gas).toFixed(8) }); ok(w.executed, `withdrew ${(bal - gas).toFixed(6)} ETH back to the test wallet`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
srv.close(); process.exit(fail ? 1 : 0);
