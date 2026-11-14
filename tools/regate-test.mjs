// Swap page: Troya Gate runs again when Swap is pressed (local check, never sends anything).
// The in-page wallet answers with a read-only address that holds ETH and refuses every transaction.
//   node tools/regate-test.mjs [base]
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const base = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${base}/${readdirSync(base).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const BASE = process.argv[2] || "http://127.0.0.1:9270";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const READ_ONLY = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH contract: holds ETH, used only as a balance to read
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(cond ? "  ✓" : "  ✕", name, extra); };

const b = await puppeteer.launch({ executablePath: exe, headless: "new" });
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.evaluateOnNewDocument((addr) => {
  window.__sent = 0;
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
      if (method === "eth_chainId") return "0x1237";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      window.__asked = (window.__asked || []).concat(method);
      if (method === "eth_sendTransaction") window.__sent++;
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    },
    on: () => {}, removeListener: () => {},
  };
}, READ_ONLY);

let fake = null; // null | "fail" | "down"
const seen = [];
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/swap/gate") || u.includes("/api/swap/build")) seen.push(u.includes("/gate") ? "gate" : "build");
  if (fake && u.includes("/api/swap/gate")) {
    const mode = fake; fake = null;
    if (mode === "down") return r.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "upstream busy" }) });
    return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ pass: false, checks: [{ key: "route", status: "pass", label: "Route", detail: "Uniswap v3" }, { key: "depth", status: "fail", label: "Pool depth", detail: "0.010 ETH" }] }) });
  }
  r.continue();
});

const count = (k) => seen.filter((x) => x === k).length;
const text = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => "");
const toasts = () => text("[data-toasts]");
const btnText = () => text(".btn.primary.big");
const clickBtn = () => page.$eval(".btn.primary.big", (e) => e.click());
async function waitFor(fn, sec, label) { for (let i = 0; i < sec * 4; i++) { if (await fn()) return true; await sleep(250); } console.log("    (timeout:", label + ")"); return false; }
async function open() {
  await page.goto("about:blank");
  await page.goto(`${BASE}/agent#/swap?in=eth&out=${NVDA}&amount=0.0005`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => { const m = await import("/agent/js/wallet.js"); const d = m.available()[0]; if (d && !m.wallet.address) await m.connectWith(d); });
  await waitFor(async () => /Passed/.test(await text(".sw-gate")), 90, "first gate");
}

console.log("A · gate passes, runs again on Swap and again after a slow review");
await open();
const g0 = await text(".sw-gate");
ok("gate box shows its age", /checked \d+s ago/.test(g0), JSON.stringify(g0.match(/checked \d+s ago/)?.[0]));
ok("gate box says it runs again on Swap", /Runs again the moment you press Swap/.test(g0));
await sleep(2200);
const g1 = await text(".sw-gate");
ok("the age counts up", g1.match(/checked (\d+)s/)?.[1] !== g0.match(/checked (\d+)s/)?.[1], `${g0.match(/checked \d+s/)?.[0]} → ${g1.match(/checked \d+s/)?.[0]}`);
ok("button ready", /Review swap/.test(await btnText()), await btnText());
let gates = count("gate"), builds = count("build");
await clickBtn();
const modalUp = await waitFor(async () => /Review swap/.test(await text(".modal, [role=dialog]")), 60, "review modal");
ok("Swap pressed → gate ran again", count("gate") === gates + 1, `gate calls ${gates} → ${count("gate")}`);
ok("…then the swap was built", count("build") === builds + 1);
ok("review modal opened", modalUp);
console.log("    waiting 46 s with the review open…");
await sleep(46000);
gates = count("gate");
await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Swap in wallet/.test(x.innerText))?.click());
await waitFor(async () => /cancelled/i.test(await toasts()), 60, "wallet refusal toast");
ok("slow review → gate ran again before the wallet", count("gate") === gates + 1, `gate calls ${gates} → ${count("gate")}`);
const asked = await page.evaluate(() => (window.__asked || []).filter((m) => !/^eth_(chainId|accounts|requestAccounts)$/.test(m)));
ok("the wallet refused and nothing was sent", /cancelled/i.test(await toasts()) && asked.length > 0, `wallet calls: ${asked.join(", ")} · toast: ${JSON.stringify((await toasts()).split("\n").pop())}`);

console.log("B · gate fails at the moment of Swap");
await open();
gates = count("gate"); builds = count("build");
fake = "fail";
await clickBtn();
await waitFor(async () => /ran again and blocked/.test(await toasts()), 30, "block toast");
const tb = await toasts();
ok("blocked with the reason", /Troya Gate ran again and blocked this swap\. Pool depth: 0\.010 ETH/.test(tb), JSON.stringify(tb.split("\n").pop()));
ok("nothing built", count("build") === builds);
ok("button now says blocked", /Blocked by Troya Gate/.test(await btnText()), await btnText());
ok("gate box shows Blocked", /Blocked/.test(await text(".sw-gate")));

console.log("C · gate cannot be reached at the moment of Swap");
await open();
builds = count("build");
fake = "down";
await clickBtn();
await waitFor(async () => /could not run again/.test(await toasts()), 30, "unavailable toast");
ok("refuses to continue without the gate", /Troya Gate could not run again just now/.test(await toasts()));
ok("nothing built", count("build") === builds);
ok("button usable again", /Review swap/.test(await btnText()), await btnText());

ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await page.screenshot({ path: process.env.SHOT || "/tmp/regate.png" });
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
