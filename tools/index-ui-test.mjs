// Drives the Troya Index pages in headless Chrome against a LOCAL anvil fork (never the real chain):
//   #/vault/deploy  the owner's deploy page, clicked through all four steps with the creator wallet (impersonated on the
//                   fork only, through an injected EIP-1193 test wallet), then the Safe accepts (impersonated, fork only)
//   #/vault         deposit ETH, keeper rebalance, zap deposit, redeem with the per-asset preview, all through the page
// /api/index* is answered by server/index-keeper.mjs in this process (reading the fork); the browser's RPC relay goes to the
// fork; every other request goes to the running app (static files from disk). Screenshots at 1280 and 390 px.
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8548 --chain-id 4663 --hardfork cancun
//   ANVIL=http://127.0.0.1:8548 APP=http://127.0.0.1:9270 OUT=<dir> node tools/index-ui-test.mjs
import puppeteer from "puppeteer-core";
import { readdirSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ANVIL = process.env.ANVIL || "http://127.0.0.1:8548";
const APP = process.env.APP || "http://127.0.0.1:9270";
const OUT = process.env.OUT || tmpdir();
mkdirSync(OUT, { recursive: true });
process.env.ROBINHOOD_RPCS = ANVIL; process.env.ROBINHOOD_RPC = ANVIL; process.env.ROBINHOOD_WIDE_RPC = ANVIL;
process.env.RPC_TIMEOUT_MS = "60000"; process.env.INDEX_OFF = "1"; process.env.KYBER = "0"; process.env.RECORD = "0";
const { JsonRpcProvider, Interface, parseEther, getAddress } = await import("ethers");
const provider = new JsonRpcProvider(ANVIL, 4663, { staticNetwork: true });
const rpcRaw = (body) => fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.text());
const anvil = (m, p = []) => provider.send(m, p);
const realNow = Date.now;
let skew = (await provider.getBlock("latest")).timestamp * 1000 - realNow();
Date.now = () => realNow() + skew;
const hours = async (k) => { await anvil("evm_increaseTime", [3600 * k]); await anvil("evm_mine"); skew += 3600_000 * k; };

const L = await import("../public/agent/desk/index-deploy-lib.js");
const DATA = await mkdtemp(join(tmpdir(), "index-ui-"));
const { initStore } = await import("../server/store.mjs");
const store = await initStore(DATA);
const routes = [];
const router = { get: (path, fn) => routes.push({ path, fn }), post() {}, del() {} };
await (await import("../server/robinhood.mjs")).register(router, { store, dataDir: DATA });
const K = await import("../server/index-keeper.mjs");
await K.register(router, { store, dataDir: DATA });
async function api(path, query) {
  if (!path.startsWith("/api/index")) return null;
  for (const x of routes) {
    const keys = [];
    const m = new RegExp("^" + x.path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$").exec(path);
    if (!m) continue;
    try { return { status: 200, body: await x.fn({ params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query }) }; }
    catch (e) { return { status: e.status || 500, body: { error: e.message } }; }
  }
  return null;
}
const ser = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// the creator wallet and the Safe, impersonated on the fork only (their keys are never involved)
await anvil("anvil_impersonateAccount", [L.CREATOR]);
await anvil("anvil_setBalance", [L.CREATOR, "0x" + parseEther("5").toString(16)]);
await anvil("anvil_impersonateAccount", [L.SAFE]);
await anvil("anvil_setBalance", [L.SAFE, "0x" + parseEther("1").toString(16)]);

const base = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${base}/${readdirSync(base).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
await page.setRequestInterception(true);
page.on("request", async (req) => {
  const u = new URL(req.url());
  const p = u.pathname.replace(/^\/agent(?=\/api\/)/, "");
  if (p.startsWith("/api/index")) {
    const r = await api(p, Object.fromEntries(u.searchParams));
    if (r) return req.respond({ status: r.status, contentType: "application/json", body: ser(r.body) });
  }
  if (p === "/api/rpc/robinhood" || u.pathname === "/__anvil") return req.respond({ status: 200, contentType: "application/json", body: await rpcRaw(req.postData()) });
  req.continue();
});
// the test wallet: EIP-1193 over EIP-6963, forwarding to the fork (where the creator is impersonated)
await page.evaluateOnNewDocument((account) => {
  let id = 1;
  const provider = {
    on() {}, removeListener() {},
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0x1237";
      if (method === "net_version") return "4663";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "personal_sign") throw Object.assign(new Error("test wallet does not sign messages"), { code: 4001 });
      if (method === "eth_sendTransaction") { const tx = { ...params[0] }; delete tx.chainId; params = [tx]; }
      const r = await fetch("/__anvil", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params || [] }) }).then((x) => x.json());
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
      return r.result;
    },
  };
  window.ethereum = provider;
  const info = { uuid: "test-wallet", name: "Test wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  // a fresh run once per test, kept across reloads (the page resumes from it, as for the owner)
  try { if (!sessionStorage.getItem("iv-test")) { localStorage.removeItem("troya.index.deploy.v1"); sessionStorage.setItem("iv-test", "1"); } localStorage.setItem("troya.gate.v1", "1"); } catch {}
}, L.CREATOR);

let passed = 0;
const ok = (n) => { passed++; console.log("  ok", n); };
const text = (sel) => page.$eval(sel, (e) => e.innerText);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await page.waitForFunction(() => [...document.querySelectorAll(".iv-out")].some((e) => /You hold/.test(e.innerText)), { timeout: 60000 }); await wait(2500); };
const typeAmount = async (v) => { await settle(); await page.click(".iv-in input", { clickCount: 3 }); await page.type(".iv-in input", v, { delay: 30 }); };
const toast = (re, ms = 120000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-toasts]")?.innerText || ""), { timeout: ms }, re.source);
const overflow = () => page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, (document.querySelector(".iv")?.scrollWidth || 0) - (document.querySelector(".iv")?.clientWidth || 0)));
const shot = async (name, width, full = true) => {
  await page.setViewport({ width, height: width < 500 ? 844 : 900, deviceScaleFactor: width < 500 ? 2 : 1 });
  // full-page captures from the top, with no toast over the content (fixed bars are drawn where the page was scrolled)
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("[data-toasts]")?.replaceChildren(); });
  await wait(900);
  if (width < 500) assert.ok((await overflow()) <= 1, `${name}: no sideways scroll at ${width} px (overflow ${await overflow()} px)`);
  await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: full });
};

/* ---------- the deploy page ---------- */
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${APP}/agent/#/vault/deploy`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => /What will be deployed/.test(document.body.innerText) && /keeper wallet/.test(document.body.innerText), { timeout: 30000 });
assert.match(await text("#view"), /Connect the creator wallet/);
await shot("deploy-0-not-connected", 1280, true);
ok("deploy page: parameters and the server's keeper shown; nothing to sign before the creator connects");
await page.evaluate(async () => { const w = await import("/agent/js/wallet.js"); await w.connectWith(w.available().find((x) => x.info.uuid === "test-wallet")); });
await page.waitForFunction(() => document.querySelectorAll(".iv-steps button").length === 4, { timeout: 15000 });
for (const [i, label] of ["TroyaIndexSwapper deployed", "TroyaIndex deployed", "TroyaIndexZap deployed", "Ownership offered to the Safe"].entries()) {
  await page.waitForFunction((k) => !document.querySelectorAll(".iv-steps li")[k].querySelector("button")?.disabled, { timeout: 30000 }, i);
  await page.evaluate((k) => document.querySelectorAll(".iv-steps li")[k].querySelector("button").click(), i);
  await page.waitForSelector(".modal .btn.primary", { timeout: 10000 });
  if (i === 1) await page.screenshot({ path: join(OUT, "deploy-1-review-1280.png") });
  await page.click(".modal .btn.primary");
  await toast(new RegExp(label));
  await wait(600);
  ok(`deploy page step ${i + 1}: ${label}`);
}
const run = await page.evaluate(() => JSON.parse(localStorage.getItem("troya.index.deploy.v1")));
const V = new Interface(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function keeper() view returns (address)", "function depositEth(uint256,address) payable", "function balanceOf(address) view returns (uint256)"]);
const read = async (fn, to = run.vault.address) => V.decodeFunctionResult(fn, await provider.call({ to, data: V.encodeFunctionData(fn, []) }))[0];
assert.equal(await read("owner"), L.CREATOR);
assert.equal(await read("pendingOwner"), L.SAFE);
assert.equal(await read("keeper"), (await api("/api/index/keeper", {})).body.address);
// the Safe accepts (fork only)
{ const gas = await anvil("eth_estimateGas", [{ from: L.SAFE, to: run.vault.address, data: L.acceptData() }]);
  const h = await anvil("eth_sendTransaction", [{ from: L.SAFE, to: run.vault.address, data: L.acceptData(), gas }]); await provider.waitForTransaction(h); }
assert.equal(await read("owner"), L.SAFE);
await page.reload({ waitUntil: "networkidle2" });
await page.evaluate(async () => { const w = await import("/agent/js/wallet.js"); await w.connectWith(w.available().find((x) => x.info.uuid === "test-wallet")); });
await page.waitForFunction(() => /the Safe \(accepted\)/.test(document.body.innerText), { timeout: 30000 });
assert.match(await text("#view"), /forge verify-contract --chain 4663 --verifier blockscout/);
assert.match(await text("#view"), /INDEX_ADDRESS=0x/);
await shot("deploy-2-done", 1280); await shot("deploy-2-done", 390);
ok("deploy page: after the Safe accepts, owner = the Safe; verify commands and server settings printed; 390 px fits");

/* ---------- the vault page ---------- */
process.env.INDEX_ADDRESS = run.vault.address; process.env.INDEX_ZAP_ADDRESS = run.zap.address; process.env.INDEX_DEPLOY_BLOCK = String(run.swapper.block); process.env.INDEX_KEEPER = "1";
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${APP}/agent/#/vault`, { waitUntil: "networkidle2" });
await page.evaluate(async () => { const w = await import("/agent/js/wallet.js"); await w.connectWith(w.available().find((x) => x.info.uuid === "test-wallet")); });
await page.waitForFunction(() => /Your TIDX/.test(document.body.innerText) && document.querySelector(".iv-in input"), { timeout: 30000 });
await typeAmount("0.4");
try { await page.waitForFunction(() => /You get/.test(document.querySelector(".iv-form .iv-out")?.innerText || ""), { timeout: 60000 }); }
catch (e) { await page.screenshot({ path: join(OUT, "debug-deposit.png"), fullPage: true }); console.log("PAGE:", (await text("#view")).slice(0, 1500)); throw e; }
await page.click(".iv-form .btn.primary");
await page.waitForSelector(".modal .btn.primary", { timeout: 10000 });
await page.click(".modal .btn.primary");
await toast(/Deposited/);
ok("vault page: ETH deposit in the ETH-only phase (quote, review, wallet)");

// the keeper's first rebalance (12 hourly reads, then a buy through the Gate)
const keeper = (await api("/api/index/keeper", {})).body.address;
await anvil("anvil_setBalance", [keeper, "0x" + parseEther("0.05").toString(16)]);
// the page is the subject here: the keeper's buy takes a stand-in Gate (the real Gate is exercised on the fork by
// tools/index-fork-test.mjs; a fork on a non-archive endpoint cannot serve every read the real Gate makes)
const gate = async () => ({ pass: true, checks: [] });
let t = await K.keeperTick({ gate });
for (let i = 0; i < 16 && t.rebalance?.action !== "trade"; i++) { await hours(1); t = await K.keeperTick({ gate }); }
assert.equal(t.rebalance?.action, "trade", JSON.stringify(t.rebalance));
await K.scanEvents({ post: async () => true });
ok(`keeper rebalanced: ${t.rebalance.reason}`);
// a weight change scheduled 48 hours ahead: the page must show it as pending
const weightPosts = [];
await K.scheduleWeights({ targets: { ETH: 30, USDG: 25, SPY: 25, NVDA: 15, TROYA: 5 }, note: "more SPY" }, { post: async (x) => { weightPosts.push(x); return true; } });
assert.match(weightPosts[0], /scheduled/);
await page.evaluate((off) => { const real = Date.now; Date.now = () => real() + off; }, skew);
await new Promise((r) => setTimeout(r, 21000));                 // past the API's 20 s cache
await page.reload({ waitUntil: "networkidle2" });
await page.evaluate(async () => { const w = await import("/agent/js/wallet.js"); await w.connectWith(w.available().find((x) => x.info.uuid === "test-wallet")); });
await page.waitForFunction(() => /USDG/.test(document.querySelector(".iv-tbl")?.innerText || "") && /zap buys/.test(document.body.innerText), { timeout: 120000 });
assert.match(await text(".iv-weights"), /Target weights/); assert.match(await text(".iv-weights"), /Scheduled change: ETH 30%/);
ok("vault page: active target weights and the scheduled change (with its time) are shown");
// zap deposit through the page
await typeAmount("0.05");
await page.waitForFunction(() => /Quoted cost/.test(document.querySelector(".iv-form .iv-out")?.innerText || ""), { timeout: 30000 });
const bal0 = await read("balanceOf").catch(() => null);
await page.click(".iv-form .btn.primary");
await page.waitForSelector(".modal .btn.primary", { timeout: 10000 });
await page.click(".modal .btn.primary");
await toast(/Deposited/);
ok("vault page: zap deposit with a quoted maximum ETH in, once the vault holds tokens");
await wait(1500);
await shot("vault-1-holdings", 1280); await shot("vault-1-holdings", 390);
ok("vault page: holdings, caps, fees, queue, risk note at 1280 and 390 px (no sideways scroll)");
// redeem half through the page, with the per-asset preview
await page.setViewport({ width: 1280, height: 900 });
await page.evaluate(() => document.querySelector(".iv-seg button[data-v='redeem']").click());
await page.waitForSelector(".iv-in input");
const mine = (await api(`/api/index/me/${L.CREATOR}`, {})).body.shares;
await typeAmount(String(+(mine / 2).toFixed(6)));
await page.waitForFunction(() => /You receive/.test(document.querySelector(".iv-form .iv-out")?.innerText || "") && /USDG/.test(document.querySelector(".iv-form .iv-out")?.innerText || ""), { timeout: 30000 });
await shot("vault-2-redeem-preview", 1280, false);
await page.click(".iv-form .btn.primary");
await page.waitForSelector(".modal .btn.primary", { timeout: 10000 });
await page.click(".modal .btn.primary");
await toast(/Redeemed/);
ok("vault page: redeem with each asset previewed, paid in kind");
await shot("vault-3-after-redeem", 390);
// the keeper refuses active weights that do not add up to 100% (a hand-edited file), and trades nothing
const saved = await store.readJson("index-weights.json", null);
await store.writeJson("index-weights.json", { ...saved, active: { ...saved.active, targets: { "0x0000000000000000000000000000000000000000": 60, [L.TOKENS.USDG.toLowerCase()]: 30 } } });
for (let i = 0; i < 6 && !/Refused: the active target weights/.test(t.rebalance?.reason || ""); i++) { await hours(1); t = await K.keeperTick({ gate }); }
assert.match(t.rebalance?.reason || "", /Refused: the active target weights are not usable \(The weights add up to 90%/, JSON.stringify(t.rebalance));
await store.writeJson("index-weights.json", saved);
ok("keeper on the fork: refuses active weights that do not add up to 100%");
const real = errors.filter((e) => /pageerror/.test(e));
if (errors.length) console.log("browser messages:\n" + errors.slice(0, 12).join("\n"));
assert.equal(real.length, 0, "no page errors");
console.log(`\n${passed} passed, screenshots in ${OUT}`);
await browser.close();
process.exit(0);
