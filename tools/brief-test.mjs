// Phase 6 check: the daily brief (numbers from chain, Hyperliquid and Sentry), smart alerts, settings, Telegram commands
// and the web routes. Telegram goes to a recorder. No funds move.  node tools/brief-test.mjs
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const data = mkdtempSync(join(tmpdir(), "troya-brief-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TG_TRADE: "1", TROYA_WATCHES: "0", BRIEF: "" });
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const brief = await import(join(root, "server/brief.mjs"));
const term = await import(join(root, "server/tgterm.mjs"));
const { Wallet } = await import("ethers");
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
const sent = [];
brief.useSender(async (method, payload) => { sent.push({ method, payload }); return { ok: true, result: { message_id: sent.length } }; });
const calls = []; const tg = async (method, payload) => { calls.push({ method, payload }); return { ok: true, result: { message_id: calls.length } }; };
const store = { readJson: async (n, fb) => { try { return JSON.parse(readFileSync(join(data, n), "utf8")); } catch { return fb; } } };
const lastSent = () => calls.at(-1)?.payload?.text || "";

const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
const me = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
await call("POST", "/api/agent-wallet/create").catch(() => {});
const CHAT = 5151;
writeFileSync(join(data, "telegram.json"), JSON.stringify({ links: { [me.address.toLowerCase()]: CHAT }, codes: {} }));
const dm = (text) => term.handleMessage({ message_id: Math.random(), chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text }, tg, store);

console.log("A · the brief");
const d = await brief.gather(me.address);
ok(d.market?.ETH?.px > 0 && d.market?.BTC?.px > 0, "market: ETH and BTC from Hyperliquid", `ETH ${Math.round(d.market?.ETH?.px || 0)}`);
ok(d.hasAgentWallet && d.awEth != null, "your desk: the Agent Wallet balance", `${d.awEth} ETH`);
ok(d.hl && typeof d.hl.value === "number", "your desk: the Hyperliquid account", `$${d.hl?.value?.toFixed(2)}`);
const text = brief.formatBrief(d, "A quiet day: no open perps.");
ok(/<b>Troya brief ·/.test(text) && /<b>Your desk<\/b>/.test(text) && /<b>Market<\/b>/.test(text) && /\/brief off/.test(text), "formatted with desk, market and how to stop it");

console.log("B · smart alerts");
const fake = { positions: [{ coin: "ETH", side: "long", liqAway: 6.2, mark: 1800, liqPx: 1690, fundingAgainst: 80 }, { coin: "BTC", side: "short", liqAway: 40, fundingAgainst: 0 }], guards: [{ id: "w1", title: "Stop-loss ETH ≤ 1790", away: 0.6 }, { id: "w2", title: "Stop-loss SOL ≤ 100", away: 9 }] };
const al = brief.alertsFor(fake);
ok(al.some((a) => a.key === "liq:ETH:long") && !al.some((a) => a.key.startsWith("liq:BTC")), "liquidation within 10% → an alert; 40% away → none");
ok(al.some((a) => a.key === "fund:ETH:long"), "funding 80%/yr against the position → an alert");
ok(al.some((a) => a.key === "stop:w1") && !al.some((a) => a.key === "stop:w2"), "a stop 0.6% from firing → an alert; 9% → none");

console.log("C · settings and Telegram");
calls.length = 0; await dm("/brief off");
ok(/Daily brief off/.test(lastSent()), "/brief off");
calls.length = 0; await dm("/brief hour 9");
ok(/moved to 9:00 UTC/.test(lastSent()), "/brief hour 9 (and back on)");
calls.length = 0; await dm("/alerts");
ok(/Smart alerts are on/.test(lastSent()), "/alerts explains what it watches");
sent.length = 0; await dm("/brief");
ok(sent.some((s) => s.method === "sendMessage" && s.payload.chat_id === CHAT && /Troya brief/.test(s.payload.text)), "/brief sends one now");

console.log("D · the web");
const w = await call("GET", "/api/brief/me");
ok(w.brief?.market?.ETH && w.prefs?.hour === 9 && w.prefs.on === true && w.telegramLinked === true, "GET /api/brief: the same numbers and the settings from Telegram", JSON.stringify({ prefs: w.prefs, linked: w.telegramLinked, eth: !!w.brief?.market?.ETH }));
const s2 = await call("POST", "/api/brief/settings", { alerts: false, hour: 7 });
ok(s2.prefs.alerts === false && s2.prefs.hour === 7, "POST /api/brief/settings changes them for Telegram too");
sent.length = 0; const s3 = await call("POST", "/api/brief/send", {});
ok(s3.ok && sent.some((s) => /Troya brief/.test(s.payload?.text || "")), "Send to Telegram from the web");
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
