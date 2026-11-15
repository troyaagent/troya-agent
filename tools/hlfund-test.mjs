// Fund Hyperliquid check: the quote route, the MCP/API prepare tool, the chat ticket and the Agent Wallet run.
//   ROBINHOOD_RPC=https://robinhood-rpc.publicnode.com node tools/hlfund-test.mjs        dry run, nothing is sent
//   LIVE=1 FUND=0.006 ROBINHOOD_RPC=… node tools/hlfund-test.mjs                         real money (test wallet only): fund a
//        fresh Agent Wallet with FUND ETH, run Fund Hyperliquid from it, wait for USDC on the test wallet's Hyperliquid account
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const LIVE = process.env.LIVE === "1";
const data = mkdtempSync(join(tmpdir(), "troya-hlfund-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "" });
if (!LIVE) process.env.TROYA_NO_BROADCAST = "1";
const { initApi, handleApi } = await import("../server/api.mjs");
await initApi({ dataDir: data, root: join(import.meta.dirname, "..") });
const { Wallet, JsonRpcProvider, parseEther, formatEther } = await import("ethers");
const hl = await import("../server/hl.mjs");

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
const prov = new JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://robinhood-rpc.publicnode.com", 4663, { staticNetwork: true });
const me = new Wallet(env.TEST_WALLET_KEY, prov);
console.log(`${LIVE ? "LIVE (real money)" : "dry run (no broadcast)"} · owner = test wallet ${me.address.slice(0, 8)}…`);

console.log("A · quote");
const q = await call("GET", `/api/bridge/hl-quote?address=${me.address}&amountWei=${parseEther("0.005")}`);
ok(q.toChain === 1337 && q.toSymbol === "USDC" && q.toAddress.toLowerCase() === me.address.toLowerCase() && q.tx.chainId === 4663, "ETH on Robinhood Chain → USDC on your own Hyperliquid account, signed on Robinhood Chain", `${(q.toAmount / 10 ** q.toDecimals).toFixed(2)} USDC via ${q.tool}`);
let bad = await call("GET", `/api/bridge/hl-quote?address=${me.address}&amountWei=0`).catch((e) => e.message);
ok(/400/.test(bad), "zero amount is refused");

console.log("B · sign in, Agent Wallet");
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
const aw = await call("POST", "/api/agent-wallet/create");
ok(/^0x[0-9a-fA-F]{40}$/.test(aw.address), "Agent Wallet created", aw.address);

console.log("C · MCP / API prepare tool");
const pr = (await call("POST", "/api/tools/prepare_hl_funding", { amountEth: 0.005 })).result;
ok(pr.ok && pr.confirmationId && pr.estimate.receiveUsdc > 1 && /#\/bridge\?dir=hl&amount=0\.005/.test(pr.signYourself), "prepare_hl_funding: estimate, confirmationId and a sign-it-yourself link", `${pr.estimate.receiveUsdc.toFixed(2)} USDC`);

console.log("D · chat ticket");
const chat = await call("POST", "/api/assistant/chat", { message: "fund my hyperliquid with 0.005 ETH" });
const ticket = (chat.proposals || []).find((p) => p.kind === "hl_fund");
ok(!!ticket && ticket.params.amount === 0.005 && ticket.params.toChain === 1337, "\"fund my hyperliquid with 0.005 ETH\" → a Fund Hyperliquid ticket", ticket?.summary || chat.text.slice(0, 80));

console.log("E · run with Agent Wallet");
if (LIVE) {
  const FUND = process.env.FUND || "0.006";
  const tx = await me.sendTransaction({ to: aw.address, value: parseEther(FUND) });
  await tx.wait();
  console.log(`  funded Agent Wallet with ${FUND} ETH · ${tx.hash}`);
}
const before = (await hl.hlUserState(me.address).catch(() => null))?.accountValue ?? null;
const ex = await call("POST", "/api/agent-wallet/execute", { proposalId: ticket.id });
if (!LIVE) ok(ex.executed === false && ex.result?.broadcast === false && ex.result?.route && ex.result?.usdcEstimate > 1, "built from the Agent Wallet to the owner's Hyperliquid account, not sent (dry run)", `${ex.result?.route} · ~${ex.result?.usdcEstimate?.toFixed(2)} USDC`);
else {
  ok(ex.executed && ex.result?.hash, "sent from the Agent Wallet", ex.result?.hash);
  let after = before;
  for (let i = 0; i < 36 && !(after > (before || 0) + 1); i++) { await new Promise((r) => setTimeout(r, 5000)); after = (await hl.hlUserState(me.address).catch(() => null))?.accountValue ?? after; }
  ok(after > (before || 0) + 1, "USDC arrived on the test wallet's Hyperliquid account", `$${(before || 0).toFixed(2)} → $${(after || 0).toFixed(2)}`);
}
const again = await call("POST", "/api/agent-wallet/execute", { proposalId: ticket.id }).catch((e) => e.message);
ok(/409/.test(String(again)) || again?.blocked, "the same ticket cannot run twice");
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
