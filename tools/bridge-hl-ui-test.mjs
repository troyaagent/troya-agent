// Bridge page, To Hyperliquid, driven in a real browser the way a user does it with MetaMask: connect, type an amount,
// Review funding, Fund in wallet. The in-page wallet is the dedicated test wallet; its key stays in this Node process and
// only eth_sendTransaction on Robinhood Chain, capped at the amount, is ever signed.
//   node tools/bridge-hl-ui-test.mjs [base] [amountEth]          dry: the wallet refuses to sign; checks quote and review
//   LIVE=1 node tools/bridge-hl-ui-test.mjs [base] [amountEth]   real money (test wallet only)
import puppeteer from "puppeteer-core";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Wallet, JsonRpcProvider, parseEther, formatEther, toBeHex } from "ethers";
const LIVE = process.env.LIVE === "1";
const BASE = process.argv[2] || "http://127.0.0.1:9270";
const AMOUNT = process.argv[3] || "0.0006";
const ENV_FILE = `${homedir()}/.config/troya/test-wallet.env`;
const env = existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])) : {};
if (LIVE && !env.TEST_WALLET_KEY) throw new Error(`LIVE needs the test wallet key in ${ENV_FILE}`);
const rh = new JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://robinhood-rpc.publicnode.com", 4663, { staticNetwork: true });
const signer = new Wallet(env.TEST_WALLET_KEY || Wallet.createRandom().privateKey, rh);
const CAP = parseEther(AMOUNT) + parseEther("0.00005");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };

const base = `${homedir()}/.cache/puppeteer/chrome`;
const b = await puppeteer.launch({ executablePath: `${base}/${readdirSync(base).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, headless: "new" });
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));

// the wallet the page talks to (window.ethereum → this function)
let chain = 4663, sent = null;
await page.exposeFunction("__wallet", async (method, params) => {
  try {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return { ok: [signer.address] };
    if (method === "eth_chainId") return { ok: toBeHex(chain) };
    if (method === "net_version") return { ok: String(chain) };
    if (method === "wallet_switchEthereumChain") { chain = Number(params?.[0]?.chainId); return { ok: null }; }
    if (method === "wallet_addEthereumChain") return { ok: null };
    if (method === "eth_sendTransaction") {
      const tx = params[0] || {};
      if (!LIVE) return { err: { code: 4001, message: "User rejected the request." } };
      if (chain !== 4663) return { err: { code: 4001, message: `refusing: chain ${chain}` } };
      if (String(tx.from || signer.address).toLowerCase() !== signer.address.toLowerCase()) return { err: { code: 4001, message: "refusing: other sender" } };
      if (BigInt(tx.value || 0) > CAP) return { err: { code: 4001, message: `refusing: value above ${formatEther(CAP)} ETH` } };
      const r = await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0), ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}) });
      sent = { hash: r.hash, to: tx.to, value: formatEther(BigInt(tx.value || 0)) };
      return { ok: r.hash };
    }
    if (method === "personal_sign" || method.startsWith("eth_sign")) return { err: { code: 4001, message: "not needed for this test" } };
    if (chain !== 4663) return { err: { code: -32000, message: `no reader for chain ${chain} in this test` } };
    return { ok: await rh.send(method, params || []) };
  } catch (e) { return { err: { code: -32000, message: e.shortMessage || e.message } }; }
});
await page.evaluateOnNewDocument(() => {
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => { const r = await window.__wallet(method, params); if (r.err) throw Object.assign(new Error(r.err.message), { code: r.err.code }); return r.ok; },
    on: () => {}, removeListener: () => {},
  };
});

const text = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => "");
async function waitFor(fn, sec, label) { for (let i = 0; i < sec * 4; i++) { if (await fn()) return true; await sleep(250); } console.log(`    (timeout: ${label})`); return false; }

console.log(`${LIVE ? "LIVE (real money)" : "dry run"} · ${BASE} · ${AMOUNT} ETH from ${signer.address.slice(0, 10)}…`);
const before = LIVE ? await rh.getBalance(signer.address) : 0n;
await page.goto(`${BASE}/agent#/bridge?dir=hl&amount=${AMOUNT}`, { waitUntil: "domcontentloaded" });
await page.evaluate(async () => { const m = await import("/agent/js/wallet.js"); const d = m.available()[0]; if (d && !m.wallet.address) await m.connectWith(d); });
ok(await waitFor(async () => /Review funding/.test(await text(".btn.primary.big")), 60, "quote"), "connected, quoted: the button reads Review funding", await text(".btn.primary.big"));
const recv = await text(".br-amt.out");
ok(Number(recv) > 0, "the To side shows USDC on Hyperliquid", `${recv} USDC`);
await page.$eval(".btn.primary.big", (e) => e.click());
ok(await waitFor(async () => /Review funding/.test(await text(".modal, [role=dialog]")), 20, "review"), "Review funding opens with the route and fees");
const clicked = await page.evaluate(() => { const bt = [...document.querySelectorAll(".modal button, [role=dialog] button")].find((x) => /Fund in wallet/.test(x.innerText)); bt?.click(); return !!bt; });
ok(clicked, "Fund in wallet pressed");

if (!LIVE) {
  ok(await waitFor(async () => /cancelled the request/i.test(await text("[data-toasts]")), 20, "reject toast"), "the wallet refused (dry run) and the page said so");
} else {
  ok(await waitFor(async () => !!sent, 60, "signature"), "the wallet signed one transaction on Robinhood Chain", sent ? `${sent.value} ETH → ${sent.to.slice(0, 10)}… · ${sent.hash}` : "");
  ok(await waitFor(async () => /Funding sent/.test(await text("[data-toasts]")), 30, "sent toast"), "the page confirmed: Funding sent");
  const hlMod = await import("../server/hl.mjs");
  const hv0 = (await hlMod.hlUserState(signer.address)).accountValue;
  ok(await waitFor(async () => /Arrived/.test(await text(".br-list")), 240, "arrived"), "Your transfers shows Arrived", (await text(".br-list")).replace(/\n+/g, " · ").slice(0, 120));
  let hv = hv0; for (let i = 0; i < 12 && !(hv > hv0 + 0.5); i++) { await sleep(5000); hv = (await hlMod.hlUserState(signer.address)).accountValue; }
  ok(hv > hv0 + 0.5, "USDC landed on the test wallet's Hyperliquid account", `$${hv0.toFixed(2)} → $${hv.toFixed(2)}`);
  const after = await rh.getBalance(signer.address);
  console.log(`  ETH on Robinhood Chain ${formatEther(before)} → ${formatEther(after)}`);
}
ok(!errs.length, "no page errors", errs.join(" | "));
await page.screenshot({ path: `${process.env.SHOT_DIR || "."}/bridge-hl-ui-${LIVE ? "live" : "dry"}.png` }).catch(() => {});
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
