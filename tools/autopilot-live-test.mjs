// Sentry Autopilot live mode, with real money (test wallet only): a launch that passed → the Agent Wallet buys
// 0.002 ETH of it through executeForUser (Gate and caps again) → Autopilot sells it all back → the result is recorded.
//   AUTOPILOT_LIVE=1 DATA=<data dir with the test Agent Wallet> node tools/autopilot-live-test.mjs [token]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
if (!process.env.DATA) throw new Error("DATA=<dir> with the test Agent Wallet is required");
const data = process.env.DATA;
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TROYA_WATCHES: "0", AUTOPILOT: "0", AUTOPILOT_LIVE: "1" });
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const ap = await import(join(root, "server/autopilot.mjs"));
const { Wallet, JsonRpcProvider, Contract, formatEther, formatUnits } = await import("ethers");
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
const dms = []; ap.useSender(async (m, p) => { dms.push(p); return { ok: true }; });
const key = (readFileSync(`${homedir()}/.config/troya/test-wallet.env`, "utf8").match(/^TEST_WALLET_KEY=(.+)$/m) || [])[1]?.trim();
const me = new Wallet(key);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
const aw = await call("GET", "/api/agent-wallet");
const TOKEN = process.argv[2] || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const rh = new JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://robinhood-rpc.publicnode.com", 4663, { staticNetwork: true });
const tok = new Contract(TOKEN, ["function balanceOf(address) view returns (uint256)"], rh);
const ethBefore = await rh.getBalance(aw.address);
console.log(`LIVE (real money) · Agent Wallet ${aw.address.slice(0, 10)}… · ${formatEther(ethBefore)} ETH`);

console.log("A · live mode");
const s = await call("POST", "/api/autopilot/settings", { on: true, mode: "live", rules: { minRaisedEth: 1, buyEth: 0.002, takeProfitX: 2, stopPct: 30, maxOpen: 3, maxBuysPerDay: 5 } });
ok(s.settings.mode === "live" && s.settings.on, "live mode is accepted with AUTOPILOT_LIVE=1 and an Agent Wallet");

console.log("B · a launch that passed → a real buy");
const tokBefore = await tok.balanceOf(aw.address);
const opened = await ap.onLaunch({ v: "passed", token: TOKEN, symbol: "TROYA", pons: { raised: 3, graduated: false, pair: { address: "native", symbol: "ETH" } } });
const pos = opened[0];
ok(pos?.mode === "live" && pos.txBuy, "the Agent Wallet bought 0.002 ETH of it (Gate and caps ran first)", pos ? `tx ${pos.txBuy}` : JSON.stringify(dms.at(-1)?.text || "").slice(0, 160));
const tokAfter = await tok.balanceOf(aw.address);
ok(tokAfter > tokBefore, "the coins are in the Agent Wallet", `+${Math.round(Number(formatUnits(tokAfter - tokBefore, 18))).toLocaleString("en-US")}`);
ok(dms.some((d) => /Sentry Autopilot bought \$TROYA/.test(d.text) && !/practice/.test(d.text)), "the user is told (live, not practice)");

console.log("C · Autopilot sells it back");
if (pos) {
  const v = await ap.valueOf(pos);
  const closed = await ap.close(pos, "live test", v);
  ok(closed?.status === "closed" && closed.txSell, "sold everything it held through the Agent Wallet", closed?.txSell ? `tx ${closed.txSell}` : closed?.lastError || "");
  ok((await tok.balanceOf(aw.address)) < 10n ** 18n, "nothing but dust left in the Agent Wallet (amounts are cut, never rounded up)");
  ok(typeof closed?.pnlEth === "number", "the result is recorded", closed ? `in 0.002 ETH · out ${closed.exitValueEth.toFixed(6)} ETH · ${closed.pnlEth >= 0 ? "+" : ""}${closed.pnlEth.toFixed(6)} ETH` : "");
}
await call("POST", "/api/autopilot/settings", { on: false, mode: "practice" });
const ethAfter = await rh.getBalance(aw.address);
console.log(`  Agent Wallet ETH ${formatEther(ethBefore)} → ${formatEther(ethAfter)}`);
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
