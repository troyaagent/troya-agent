// Phase 5 check: Telegram as a full terminal (perps, positions, close, fund, stop/tp playbooks, plain words → ticket).
// Telegram calls go to a recorder; the server modules are the real ones.
//   node tools/tgterm-test.mjs                                   dry: cards, blockers, buttons; nothing is sent
//   LIVE=1 DATA=<data dir with an Agent Wallet approved on Hyperliquid> node tools/tgterm-test.mjs
//        real money (test wallet only): /long ETH 12 3x → Confirm → /positions → Close 100% → Confirm, then the same long
//        from plain words ("long ETH $12 at 3x") → ticket → Confirm, closed with /close ETH
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const LIVE = process.env.LIVE === "1";
if (LIVE && !process.env.DATA) throw new Error("LIVE needs DATA=<dir> with an approved Agent Wallet");
const data = process.env.DATA || mkdtempSync(join(tmpdir(), "troya-tgterm-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TG_TRADE: "1", TROYA_WATCHES: "0" });
if (!LIVE) process.env.TROYA_NO_BROADCAST = "1";
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const term = await import(join(root, "server/tgterm.mjs"));
const { Wallet } = await import("ethers");
const { createServer } = await import("node:http");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || ""}`); return j;
}
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram recorder
let calls = [], mid = 100;
const tg = async (method, payload) => { calls.push({ method, payload }); return { ok: true, result: { message_id: ++mid } }; };
const lastText = () => [...calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")?.payload || {};
const btns = () => (lastText().reply_markup?.inline_keyboard || []).flat();
const btn = (re) => btns().find((b) => re.test(b.text));
const store = { readJson: async (n, fb) => { try { return JSON.parse(readFileSync(join(data, n), "utf8")); } catch { return fb; } } };
const ME = 4242, OTHER = 9999;
const msg = (chat, text) => ({ message_id: ++mid, chat: { id: chat, type: "private" }, from: { id: chat }, text });
const tap = async (b, from = ME) => { calls = []; await term.handleCallback({ id: "cq" + ++mid, data: b.callback_data, from: { id: from }, message: { chat: { id: from }, message_id: mid } }, tg); };
const say = async (text, chat = ME) => { calls = []; return term.handleMessage(msg(chat, text), tg, store); };

const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
if (LIVE && !env.TEST_WALLET_KEY) throw new Error(`LIVE needs the test wallet key in ${ENV_FILE}`);
const me = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey);
console.log(`${LIVE ? "LIVE (real money)" : "dry run"} · owner ${me.address.slice(0, 10)}…`);

console.log("A · who may use it");
ok(!(await say("hello there")), "plain words from an unlinked chat fall through to the normal bot");
ok((await say("/long ETH 12 3x")) && /Link this chat/.test(lastText().text), "a terminal command from an unlinked chat → link first");
ok((await say("/long ETH")) && /Usage: \/long/.test(lastText().text), "a malformed command shows its usage");

const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
let aw = await call("GET", "/api/agent-wallet");
if (!aw.exists) aw = await call("POST", "/api/agent-wallet/create");
const tgFile = join(data, "telegram.json");
const prevLinks = existsSync(tgFile) ? readFileSync(tgFile, "utf8") : null;
writeFileSync(tgFile, JSON.stringify({ links: { [me.address.toLowerCase()]: ME }, codes: {} }));

console.log("B · positions and a perp card");
await say("/positions");
ok(/Hyperliquid ·/.test(lastText().text) && /Account \$/.test(lastText().text), "/positions shows the Hyperliquid account", lastText().text.split("\n")[1]);
await say("/long ETH 12 3x sl 1000");
const card = lastText().text || "";
ok(/Long ETH · \$12\.00 at 3x/.test(card) && /Troya Gate: <b>(Passed|Blocked)/.test(card) && /Stop 1000/.test(card), "/long ETH 12 3x sl 1000 → a card with the Gate, margin and the stop");
if (!LIVE) ok(/Approve your Agent Wallet|Not enough free USDC/.test(card) && !btn(/^Confirm$/), "a fresh, unapproved Agent Wallet gets no Confirm, only what to do first");

if (LIVE) {
  const confirm = btn(/^Confirm$/);
  ok(!!confirm, "approved and funded → Confirm is offered");
  await tap(confirm, OTHER);
  ok(calls.some((c) => c.method === "answerCallbackQuery" && /someone else/.test(c.payload.text)), "another chat cannot press it");
  await say("/long ETH 12 3x");
  await tap(btn(/^Confirm$/));
  ok(/<b>Done\.<\/b>/.test(lastText().text) && /Filled/.test(lastText().text), "Confirm → the long is filled", lastText().text.replace(/\n/g, " · ").slice(0, 110));
  await sleep(3500);
  await tap(btn(/^Positions$/));
  ok(/ETH long/.test(lastText().text), "Positions shows the ETH long", (lastText().text.match(/ETH long[^\n]*/) || [""])[0]);
  await tap(btn(/Close ETH 100%/));
  await tap(btn(/^Confirm$/));
  ok(/<b>Done\.<\/b>/.test(lastText().text), "Close 100% → Confirm → closed", lastText().text.replace(/\n/g, " · ").slice(0, 110));
  await sleep(3500);
}

console.log("C · plain words → the assistant's ticket");
await say("long ETH $12 at 3x");
const run = btn(/^Run:/);
ok(!!run, "\"long ETH $12 at 3x\" → the assistant answers with a ticket button", run?.text);
if (run) {
  await tap(run);
  ok(/Run it with your Agent Wallet/.test(lastText().text) && btn(/^Confirm$/), "the ticket opens a Confirm step");
  await tap(btn(/^Confirm$/));
  const out = lastText().text;
  ok(LIVE ? /<b>Done\.<\/b>/.test(out) : /Built, not sent|Not sent|refused/.test(out), LIVE ? "Confirm → the long from plain words is filled" : "Confirm → built, not sent (dry run)", out.replace(/\n/g, " · ").slice(0, 110));
  if (LIVE) {
    await sleep(3500);
    await say("/close ETH");
    await tap(btn(/^Confirm$/));
    ok(/<b>Done\.<\/b>/.test(lastText().text), "/close ETH → Confirm → closed");
    await sleep(3500);
  }
}

console.log("D · fund, guard and playbooks");
await say("/fund 0.01");
ok(/Fund Hyperliquid · 0\.01 ETH/.test(lastText().text) && /USDC lands on your own Hyperliquid account/.test(lastText().text), "/fund 0.01 → route, estimate and the Agent Wallet balance", (lastText().text.match(/About [\d.]+ USDC/) || [""])[0]);
await say("/stop ETH 1000");
ok(/Stop-loss: close 100% of ETH/.test(lastText().text), "/stop ETH 1000 → a stop-loss card");
await tap(btn(/^Confirm$/));
ok(/Playbook on/.test(lastText().text), "Confirm → the playbook is on");
await say("/playbooks");
ok(/Stop-loss ETH/.test(lastText().text), "/playbooks lists it");
// switch the test playbook off again so it can never act later
const ws = await call("GET", "/api/watches");
for (const w of ws.items.filter((x) => x.status === "active" && /Stop-loss ETH ≤ 1000/.test(x.title))) await call("POST", `/api/watches/${w.id}/toggle`);
ok(!(await call("GET", "/api/watches")).items.some((x) => x.status === "active" && /≤ 1000/.test(x.title)), "the test playbook is switched off again");

if (prevLinks != null) writeFileSync(tgFile, prevLinks);
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
