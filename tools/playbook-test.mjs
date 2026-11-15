// Playbooks check: stop-loss, take-profit, alert and DCA fire and run through the Agent Wallet.
//   node tools/playbook-test.mjs                                  dry: each fires and builds its action, nothing is sent
//   LIVE=1 DATA=<data dir with an Agent Wallet approved on Hyperliquid, holding a little ETH> node tools/playbook-test.mjs
//        real money (test wallet only): a $12 ETH long is closed by a stop-loss, another by a take-profit, an alert lands
//        in the inbox, and a DCA buy of 0.0002 ETH of $TROYA runs from the Agent Wallet
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const LIVE = process.env.LIVE === "1";
if (LIVE && !process.env.DATA) throw new Error("LIVE needs DATA=<dir> with an approved Agent Wallet");
const data = process.env.DATA || mkdtempSync(join(tmpdir(), "troya-playbook-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TROYA_WATCHES: "0" });
if (!LIVE) process.env.TROYA_NO_BROADCAST = "1";
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const hl = await import(join(root, "server/hl.mjs"));
const { Wallet } = await import("ethers");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || j.message || ""}`); return j;
}
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the real test wallet for LIVE runs; a dry run (and CI, which has no key file) signs in with a throwaway wallet
const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
if (LIVE && !env.TEST_WALLET_KEY) throw new Error(`LIVE needs the test wallet key in ${ENV_FILE}`);
const me = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
let aw = await call("GET", "/api/agent-wallet");
if (!aw.exists) aw = await call("POST", "/api/agent-wallet/create");
console.log(`${LIVE ? "LIVE (real money)" : "dry run"} · owner ${me.address.slice(0, 10)}… · Agent Wallet ${aw.address.slice(0, 10)}…`);

const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const mid = async () => { const m = (await call("GET", "/api/tools/analyze_ticker?coin=ETH").catch(() => null))?.result; return Number(m?.markPx || m?.midPx || m?.price) || (await hl.hlAsset("ETH")).markPx; };
const watchById = async (id) => (await call("GET", "/api/watches")).items.find((w) => w.id === id);
const position = async () => ((await hl.hlUserState(me.address)).positions || []).find((p) => p.coin === "ETH" && p.size !== 0);
async function openLong() {
  if (!LIVE) return true;
  const r = await call("POST", "/api/agent-wallet/execute", { kind: "perp", params: { coin: "ETH", side: "long", sizeUsd: 12, leverage: 3 }, rationale: "Playbook test: position to protect" });
  await sleep(4000);
  return r.executed && !!(await position());
}

for (const kind of ["stop_loss", "take_profit"]) {
  console.log(kind === "stop_loss" ? "A · stop-loss" : "B · take-profit");
  ok(await openLong(), LIVE ? "a $12 ETH long is open" : "(dry: no position needed)");
  const px = Number(await mid());
  // set so the current price already crosses it: the next tick fires
  const body = kind === "stop_loss" ? { type: "stop_loss", coin: "ETH", triggerPx: Math.round(px * 1.05), direction: "below", sizePct: 100 }
    : { type: "take_profit", coin: "ETH", levels: [{ px: Math.round(px * 0.95), sizePct: 100 }], direction: "above" };
  const w = (await call("POST", "/api/watches", body)).item;
  await call("POST", "/api/watches/tick");
  const after = await watchById(w.id);
  const out = after?.fires?.at(-1)?.outcome;
  ok(LIVE ? out === "executed" : ["built", "executed", "failed"].includes(out), `${w.title} fired on the next check`, `outcome: ${out}`);
  if (LIVE) { await sleep(4000); ok(!(await position()), "the Agent Wallet closed the position"); }
}

console.log("C · alert");
const pxA = Number(await mid());
const a = (await call("POST", "/api/watches", { type: "alert", target: "ETH", px: Math.round(pxA * 0.5), direction: "above" })).item;
await call("POST", "/api/watches/tick");
const aAfter = await watchById(a.id);
ok(aAfter?.status === "done" && aAfter.fires?.at(-1)?.outcome === "notified", `${a.title} → a note in the inbox, no funds move`);

console.log("D · DCA");
const d = (await call("POST", "/api/watches", { type: "dca", token: TROYA, symbol: "TROYA", amountEth: 0.0002, everyHours: 24, runs: 1 })).item;
ok(d.params.nextAt > Date.now(), "the first buy waits about a minute after you create it");
console.log("  waiting 65 s for the first scheduled buy …");
await sleep(65_000);
await call("POST", "/api/watches/tick");
const dAfter = await watchById(d.id);
const dOut = dAfter?.fires?.at(-1)?.outcome;
ok(LIVE ? dOut === "executed" : ["built", "executed", "blocked", "failed"].includes(dOut), "the scheduled buy ran through the Agent Wallet (Gate and caps first)", `outcome: ${dOut}${dAfter?.status === "done" ? " · playbook done after its 1 run" : ""}`);

console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
