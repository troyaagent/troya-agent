// Phase 7 check: Sentry Autopilot rules, practice entries at real prices, the skips, exits, Telegram and the web.
// Practice only: nothing is sent. Telegram goes to a recorder.  node tools/autopilot-test.mjs
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const data = mkdtempSync(join(tmpdir(), "troya-autopilot-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TG_TRADE: "1", TROYA_WATCHES: "0", AUTOPILOT: "0", AUTOPILOT_LIVE: "", TROYA_NO_BROADCAST: "1" });
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const ap = await import(join(root, "server/autopilot.mjs"));
const term = await import(join(root, "server/tgterm.mjs"));
const { Wallet } = await import("ethers");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${j.error || ""}`), { status: r.status, body: j }); return j;
}
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const dms = []; ap.useSender(async (m, p) => { dms.push(p); return { ok: true }; });
const calls = []; const tg = async (m, p) => { calls.push(p); return { ok: true, result: { message_id: calls.length } }; };
const store = { readJson: async (n, fb) => { try { return JSON.parse(readFileSync(join(data, n), "utf8")); } catch { return fb; } } };
const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
const me = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
const CHAT = 6161;
writeFileSync(join(data, "telegram.json"), JSON.stringify({ links: { [me.address.toLowerCase()]: CHAT }, codes: {} }));
const dm = async (text) => { calls.length = 0; await term.handleMessage({ message_id: Math.random(), chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text }, tg, store); return calls.at(-1)?.text || ""; };
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const launch = (raised, token = TROYA) => ({ v: "passed", token, symbol: "TROYA", pons: { raised, graduated: false, pair: { address: "native", symbol: "ETH" } } });

console.log("A · rules");
ok(JSON.stringify(ap.parseRules("buy Pons launches that pass the Gate above 1 ETH raised, 0.01 ETH each, take profit at 2x, stop at -30%")) === JSON.stringify({ minRaisedEth: 1, buyEth: 0.01, takeProfitX: 2, stopPct: 30 }), "plain words → rules");
const c = ap.cleanRules({ buyEth: 9, stopPct: 1, maxOpen: 3.7 });
ok(c.buyEth === 0.5 && c.stopPct === 5 && c.maxOpen === 4, "out-of-range values are clamped (buy ≤ 0.5 ETH, stop ≥ 5%)");
const pos0 = { amountEth: 0.01, openedAt: Date.now(), rules: { takeProfitX: 2, stopPct: 30 } };
ok(ap.exitReason(pos0, 0.021) === "take-profit" && ap.exitReason(pos0, 0.0069) === "stop" && ap.exitReason(pos0, 0.012) === null && ap.exitReason({ ...pos0, openedAt: Date.now() - 8 * 86400e3 }, 0.012) === "7 days", "exits: 2x take-profit, -30% stop, 7 days, otherwise hold");

console.log("B · practice entries at real prices");
ok((await ap.onLaunch(launch(3))).length === 0, "off → nothing");
await call("POST", "/api/autopilot/settings", { on: true, rules: { minRaisedEth: 1, buyEth: 0.01, takeProfitX: 2, stopPct: 30, maxOpen: 3 } });
ok((await ap.onLaunch(launch(0.5))).length === 0, "a launch below the raised minimum is skipped");
ok((await ap.onLaunch({ ...launch(3), v: "caution" })).length === 0, "a launch that did not pass is skipped");
const opened = await ap.onLaunch(launch(3));
ok(opened.length === 1 && opened[0].mode === "practice" && opened[0].tokens > 0, "a launch that passed with 3 ETH raised → a practice buy, quoted on chain", opened[0] ? `${Math.round(opened[0].tokens).toLocaleString("en-US")} TROYA for 0.01 ETH` : "");
ok(dms.some((d) => d.chat_id === CHAT && /Sentry Autopilot \(practice\) bought \$TROYA/.test(d.text)), "the user hears about it in Telegram");
ok((await ap.onLaunch(launch(3))).length === 0, "the same coin is not bought twice while it is open");

console.log("C · exits");
const v = await ap.valueOf(opened[0]);
ok(v > 0 && v < 0.0105, "valued by a real sell quote", `${v.toFixed(6)} ETH back now`);
const closed = await ap.close({ ...opened[0] }, "take-profit", 0.021);
ok(closed.status === "closed" && Math.abs(closed.pnlEth - 0.011) < 1e-9, "a practice close records the result", `+${closed.pnlEth} ETH`);
ok(dms.some((d) => /sold \$TROYA/.test(d.text) && /take-profit/.test(d.text)), "and tells the user");

console.log("D · Telegram");
let t = await dm("/autopilot");
ok(/Sentry Autopilot · on · practice/.test(t) && /Practice: 1 closed/.test(t), "/autopilot: status, rules and results");
t = await dm("/autopilot set min 2 buy 0.005 tp 3 sl 40 max 2");
ok(/at least 2 ETH raised: 0.005 ETH each, take profit at 3x, stop at -40%, at most 2 open/.test(t), "/autopilot set … changes the rules");
t = await dm("/autopilot live");
ok(/not switched on on this server yet/.test(t), "/autopilot live is refused until live mode passes its tests");
t = await dm("/autopilot off");
ok(/Sentry Autopilot · off/.test(t), "/autopilot off");

console.log("E · the web");
const w = await call("GET", "/api/autopilot");
ok(w.settings.rules.minRaisedEth === 2 && w.stats.practice.closed === 1 && w.positions.length === 1, "GET /api/autopilot: the rules set in Telegram and the results");
const live = await call("POST", "/api/autopilot/settings", { mode: "live" }).catch((e) => e);
ok(live.status === 400, "live mode refused from the web too");
await call("POST", "/api/autopilot/settings", { on: true, public: true });
ok((await ap.onLaunch(launch(3))).length === 0, "a coin already bought once is never bought again, even after it closed");
const o2 = await ap.onLaunch(launch(3, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"));
const cl = await call("POST", "/api/autopilot/close", { id: o2[0]?.id });
ok(cl.position?.status === "closed" && /closed by you/.test(cl.position.reason), "Close from the web");
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
