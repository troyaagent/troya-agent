// Guest mode check: the agent answers and runs Troya Gate without sign-in (read-only, no tickets, 10 a day per IP);
// signed-in chat is unchanged.  node tools/guest-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const data = mkdtempSync(join(tmpdir(), "troya-guest-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TROYA_WATCHES: "0", AUTOPILOT: "0" });
const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const { Wallet } = await import("ethers");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
async function call(method, path, body, cookie = "") {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const ask = (message) => call("POST", "/api/assistant/chat", { message });
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

console.log("A · a guest, no wallet");
let r = await ask("price NVDA");
ok(r.status === 200 && r.body.guest && /NVDA/i.test(r.body.text), "a guest asks a price and gets a live answer", r.body.text?.split("\n")[0]?.slice(0, 80));
r = await ask(`gate ${TROYA}`);
ok(r.status === 200 && /Troya Gate · \$TROYA: (Passed|Blocked)/.test(r.body.text) && /Sell simulation|Route/.test(r.body.text), "a guest runs a full Troya Gate check on a coin", r.body.text?.split("\n")[0]?.slice(0, 80));
r = await ask(`buy 0.01 ETH of ${TROYA}`);
ok(r.status === 200 && (r.body.proposals || []).length === 0 && /sign in to turn this into a ticket/i.test(r.body.text), "a guest's buy request gets the Gate answer and no ticket, with a pointer to sign in");
r = await ask("show my balances");
ok(r.status === 200 && /Connect a wallet and sign in to see your balances/.test(r.body.text), "balances need a wallet");
const st = await fetch(BASE + "/api/assistant/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "price ETH" }) });
const stText = await st.text();
ok(st.status === 200 && /event: done/.test(stText) && /event: text/.test(stText), "the web chat's stream works for a guest too (no 401)");
for (let i = 0; i < 5; i++) await ask("price ETH");
r = await ask("price BTC");
ok(r.status === 429 && /10 questions a day/.test(r.body.error || ""), "the 11th question from the same IP in a day is refused", r.body.error?.slice(0, 70));

console.log("B · signed in, unchanged");
const me = Wallet.createRandom();
const n = await call("POST", "/api/auth/nonce", { address: me.address });
const v = await call("POST", "/api/auth/verify", { address: me.address, message: n.body.message, signature: await me.signMessage(n.body.message) });
const s = await call("POST", "/api/assistant/chat", { message: `buy 0.001 ETH of ${TROYA}` }, v.cookie);
ok(s.status === 200 && !s.body.guest && (s.body.proposals || []).length === 1, "a signed-in wallet still gets its ticket", s.body.proposals?.[0]?.summary);
console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
