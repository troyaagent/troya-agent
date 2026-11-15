// Phase 8 + 9 check: the 60-second start reads each step live; the leaderboard ranks opted-in traders (live ahead of
// practice), hides full addresses and lets you copy rules, on the web and in Telegram. No funds move.
//   node tools/onboard-test.mjs
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const data = mkdtempSync(join(tmpdir(), "troya-onboard-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TG_TRADE: "1", TROYA_WATCHES: "0", AUTOPILOT: "0", TROYA_NO_BROADCAST: "1" });
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const ob = await import(join(root, "server/onboard.mjs"));
const term = await import(join(root, "server/tgterm.mjs"));
const { Wallet } = await import("ethers");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${j.error || ""}`), { status: r.status }); return j;
}
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const calls = []; const tg = async (m, p) => { calls.push(p); return { ok: true, result: { message_id: calls.length } }; };
const store = { readJson: async (n, fb) => { try { return JSON.parse(readFileSync(join(data, n), "utf8")); } catch { return fb; } } };
const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
const me = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
const step = (o, k) => o.steps.find((s) => s.key === k);

console.log("A · 60-second start");
let o = await call("GET", "/api/onboarding");
ok(step(o, "signin").done && !step(o, "agentWallet").done && !step(o, "telegram").done && o.total === 7, "signed in; no Agent Wallet or Telegram yet", `${o.done} of ${o.total}`);
await call("POST", "/api/agent-wallet/create");
const CHAT = 7171;
writeFileSync(join(data, "telegram.json"), JSON.stringify({ links: { [me.address.toLowerCase()]: CHAT }, codes: {} }));
o = await call("GET", "/api/onboarding");
ok(step(o, "agentWallet").done && step(o, "agentWallet").address && step(o, "telegram").done, "after creating the Agent Wallet and linking Telegram, both tick themselves off");
ok(step(o, "funded").done === false && step(o, "hlApproved").done === false, "a fresh Agent Wallet: not funded, not approved on Hyperliquid (read live)");
ok(typeof step(o, "hlFunded").value === "number", "Hyperliquid account value read live", `$${step(o, "hlFunded").value?.toFixed(2)}`);

console.log("B · leaderboard");
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
const now = Date.now();
const P = (address, mode, amountEth, pnlEth) => ({ id: Math.random().toString(16).slice(2), address, mode, token: "0x1", symbol: "X", amountEth, pnlEth, status: "closed", openedAt: now - 3600e3, closedAt: now - 1800e3 });
writeFileSync(join(data, "autopilot.json"), JSON.stringify({ users: {
  [A]: { on: true, mode: "practice", public: true, rules: { minRaisedEth: 1, buyEth: 0.01, takeProfitX: 3, stopPct: 25, maxOpen: 3, maxBuysPerDay: 5 } },
  [B]: { on: true, mode: "live", public: true, rules: { minRaisedEth: 2, buyEth: 0.02, takeProfitX: 2, stopPct: 30, maxOpen: 2, maxBuysPerDay: 4 } },
  [C]: { on: true, mode: "practice", public: false, rules: { minRaisedEth: 0.5, buyEth: 0.01, takeProfitX: 5, stopPct: 50, maxOpen: 5, maxBuysPerDay: 9 } },
}, positions: [P(A, "practice", 0.01, 0.02), P(A, "practice", 0.01, -0.003), P(B, "live", 0.02, 0.004), P(C, "practice", 0.01, 0.05)] }));
const lb = await call("GET", "/api/leaderboard?days=7");
ok(lb.rows.length === 2 && !lb.rows.some((r) => r.trader.startsWith("0xcccc")), "only traders who opted in are listed");
ok(lb.rows[0].mode === "live" && lb.rows[0].trader.startsWith("0xbbbb"), "live results rank ahead of practice", lb.rows.map((r) => `${r.rank}. ${r.trader} ${r.mode} ${r.returnPct.toFixed(0)}%`).join(" · "));
ok(Math.abs(lb.rows[1].returnPct - 85) < 1e-6 && lb.rows[1].winRate === 0.5, "return and win rate from closed positions", `${lb.rows[1].returnPct}% · ${lb.rows[1].winRate * 100}% won`);
ok(!JSON.stringify(lb).includes("a".repeat(40)), "full addresses are not exposed");

console.log("C · copy rules");
const cp = await call("POST", "/api/leaderboard/copy", { trader: lb.rows[1].trader });
ok(cp.settings.rules.takeProfitX === 3 && cp.settings.rules.stopPct === 25, "Copy rules (web) sets that trader's rules in your Autopilot", `tp ${cp.settings.rules.takeProfitX}x · sl ${cp.settings.rules.stopPct}%`);
const priv = await call("POST", "/api/leaderboard/copy", { trader: "0xcccc…cccc" }).catch((e) => e);
ok(priv.status === 404, "a trader who did not opt in cannot be copied");
calls.length = 0; await term.handleMessage({ message_id: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "/leaderboard" }, tg, store);
ok(/Sentry Autopilot leaderboard/.test(calls.at(-1)?.text || "") && /1\. <code>0xbbbb/.test(calls.at(-1)?.text || ""), "/leaderboard in Telegram");
calls.length = 0; await term.handleMessage({ message_id: 2, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "/copy 1" }, tg, store);
ok(/Copied the rules of <code>0xbbbb/.test(calls.at(-1)?.text || "") && /take profit at 2x, stop at -30%/.test(calls.at(-1)?.text || ""), "/copy 1 copies rank 1's rules");
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
