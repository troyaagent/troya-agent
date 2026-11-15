// Terminal path check: the real MCP package (mcp/index.mjs over stdio) against a local server, the way a user runs it.
//   node tools/mcp-test.mjs                                  dry: tools listed, prepare works, execute stays a dry run
//   LIVE=1 DATA=<data dir with an Agent Wallet approved on Hyperliquid> node tools/mcp-test.mjs
//        real money (test wallet only): open a $12 ETH long from the terminal, then close it from the terminal
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const LIVE = process.env.LIVE === "1";
const data = process.env.DATA || mkdtempSync(join(tmpdir(), "troya-mcp-"));
if (LIVE && !process.env.DATA) throw new Error("LIVE needs DATA=<dir> with an Agent Wallet already approved on Hyperliquid");
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "" });
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

const env = Object.fromEntries(readFileSync(`${homedir()}/.config/troya/test-wallet.env`, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const me = new Wallet(env.TEST_WALLET_KEY);
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
let aw = await call("GET", "/api/agent-wallet");
if (!aw.exists) aw = await call("POST", "/api/agent-wallet/create");
const tk = await call("POST", "/api/agent-api/tokens", { name: "mcp test", execute: true });
console.log(`${LIVE ? "LIVE (real money)" : "dry run"} · Agent Wallet ${aw.address.slice(0, 10)}… · token ${tk.item.prefix}…`);

// the MCP package, started like a user's client would start it
function mcp(extraEnv = {}) {
  const p = spawn(process.execPath, [join(root, "mcp/index.mjs")], { env: { ...process.env, TROYA_BASE_URL: BASE, TROYA_API_KEY: tk.token, ...extraEnv }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0; const waiting = new Map();
  p.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {} } });
  const rpc = (method, params) => new Promise((res) => { const k = ++id; waiting.set(k, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n"); });
  const tool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.result?.isError) throw new Error(r.result.content[0].text); return r.result.structuredContent; };
  return { rpc, tool, stop: () => p.kill() };
}

console.log("A · the terminal sees the tools");
let m = mcp();
await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const names = (await m.rpc("tools/list", {})).result.tools.map((t) => t.name);
ok(["prepare_hl_funding", "prepare_perp_order", "prepare_close_position", "execute_intent"].every((x) => names.includes(x)), "prepare_hl_funding, prepare_perp_order, prepare_close_position and execute_intent are listed", `${names.length} tools`);

console.log("B · two locks before anything is sent");
const p1 = await m.tool("prepare_perp_order", { coin: "ETH", side: "long", sizeUsd: 12, leverage: 3 });
ok(p1.ok && p1.confirmationId, "prepare_perp_order passes the Gate and returns a confirmationId");
const d1 = await m.tool("execute_intent", { confirmationId: p1.confirmationId });
ok(d1.dryRun === true && d1.executed === false, "without TROYA_LIVE=1 the MCP itself sends a dry run", d1.why || "");
m.stop();
m = mcp({ TROYA_LIVE: "1" });
await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const p2 = await m.tool("prepare_perp_order", { coin: "ETH", side: "long", sizeUsd: 12, leverage: 3 });
const d2 = await m.tool("execute_intent", { confirmationId: p2.confirmationId });
ok(d2.dryRun === true && /Dry-run is on/.test(d2.why || ""), "with TROYA_LIVE=1 but the token still in dry-run, the server keeps it a dry run");
const pc0 = await m.tool("prepare_close_position", { coin: "ETH" });
ok(LIVE ? true : pc0.ok === false && /No open ETH position/.test(pc0.reason), "prepare_close_position says when there is nothing to close", LIVE ? "(checked live below)" : "");

if (LIVE) {
  console.log("C · live from the terminal");
  await call("POST", "/api/agent-api/tokens/dry-run", { id: tk.item.id, dryRun: false });
  const before = await hl.hlUserState(me.address);
  const p3 = await m.tool("prepare_perp_order", { coin: "ETH", side: "long", sizeUsd: 12, leverage: 3 });
  const e3 = await m.tool("execute_intent", { confirmationId: p3.confirmationId });
  ok(e3.executed === true, "execute_intent opens the long from the terminal", JSON.stringify(e3.result?.response || e3.reasons || "").slice(0, 90));
  await new Promise((r) => setTimeout(r, 4000));
  const pc = await m.tool("prepare_close_position", { coin: "ETH" });
  ok(pc.ok && pc.position?.size > 0, "prepare_close_position finds it", pc.position ? `${pc.position.size} ETH @ ${pc.position.entryPx}` : pc.reason);
  const e4 = await m.tool("execute_intent", { confirmationId: pc.confirmationId });
  ok(e4.executed === true, "execute_intent closes it from the terminal", JSON.stringify(e4.result?.response || "").slice(0, 90));
  await new Promise((r) => setTimeout(r, 4000));
  const after = await hl.hlUserState(me.address);
  ok(!(after.positions || []).some((p) => p.size !== 0), "no position left open", `account $${before.accountValue.toFixed(2)} → $${after.accountValue.toFixed(2)}`);
  await call("POST", "/api/agent-api/tokens/dry-run", { id: tk.item.id, dryRun: true });
}
await call("POST", "/api/agent-api/tokens/revoke", { id: tk.item.id });
m.stop();
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
