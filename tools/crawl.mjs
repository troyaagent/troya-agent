// Glitch hunt: open every page at desktop and phone size and report page errors, failed requests, broken images,
// sideways overflow and a truncated contract address. Screenshots go to OUT.
// BASE=http://127.0.0.1:9270 OUT=/tmp/crawl [CA=0x…] node tools/crawl.mjs
// CA only rewrites /config.js inside this headless browser so the chip can be checked with a real-length address.
import puppeteer from "puppeteer-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const BASE = process.env.BASE || "http://127.0.0.1:9270";
const OUT = process.env.OUT || "/tmp/crawl";
const CA = process.env.CA || "";
mkdirSync(OUT, { recursive: true });
const cdir = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${cdir}/${readdirSync(cdir).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const tok = await fetch(`${BASE}/api/market/robinhood?limit=1`).then((r) => r.json()).then((d) => (d.tokens || d.items || [])[0]?.address).catch(() => null);
const PAGES = [
  "/", "/capabilities", "/philosophy", "/plans", "/api-and-mcp", "/risk-controls", "/verify", "/market-analysis", "/insights", "/terms", "/privacy", "/does-not-exist",
  "/agent#/", "/agent#/market", "/agent#/market?tab=perps", "/agent#/market?tab=spot", "/agent#/market?tab=stocks",
  tok ? `/agent#/token/${tok}` : null, "/agent#/swap", "/agent#/perps", "/agent#/launch", "/agent#/launch/create", "/agent#/bridge",
  "/agent#/agent", "/agent#/portfolio", "/agent#/docs", "/agent#/settings",
].filter(Boolean);
const SIZES = [["desk", 1440, 900, 1], ["tab", 820, 1180, 1], ["phone", 390, 844, 2]];

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const report = [];
for (const [sz, w, hgt, dpr] of SIZES) {
  for (const path of PAGES) {
    const page = await browser.newPage();
    const issues = [];
    await page.setViewport({ width: w, height: hgt, deviceScaleFactor: dpr });
    await page.setRequestInterception(true);
    page.on("request", (rq) => {
      if (CA && new URL(rq.url()).pathname === "/config.js") {
        return rq.respond({ status: 200, contentType: "application/javascript", body: `window.SITE={name:"Troya Agent",ca:${JSON.stringify(CA)},x:"",telegram:"",operator:"",mcpPackage:"@troyaagent/mcp"};` });
      }
      rq.continue();
    });
    page.on("pageerror", (e) => issues.push("JS error: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) issues.push("console: " + m.text().slice(0, 200)); });
    page.on("response", (r) => {
      const u = new URL(r.url());
      // /api/icon 404 = "no logo exists", the UI falls back to initials on purpose
      if (u.origin === BASE && r.status() >= 400 && !u.pathname.startsWith("/api/icon/") && path !== "/does-not-exist") issues.push(`HTTP ${r.status()} ${u.pathname}${u.search}`);
    });
    page.on("requestfailed", (r) => { const t = r.failure()?.errorText || ""; if (!/ERR_ABORTED/.test(t)) issues.push(`failed ${r.url().slice(0, 120)} ${t}`); });
    await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 45000 }).catch((e) => issues.push("goto: " + e.message));
    await new Promise((r) => setTimeout(r, 1800));
    // scroll through so lazy parts (footer 3D, reveals) run
    await page.evaluate(async () => { const H = document.documentElement.scrollHeight; for (let y = 0; y <= H; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } scrollTo(0, H); });
    await new Promise((r) => setTimeout(r, 900));
    const dom = await page.evaluate((ca) => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > vw + 1) {
        const wide = [...document.querySelectorAll("body *")].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1 && getComputedStyle(el).position !== "fixed"; })
          .filter((el) => !el.closest(".tbl-wrap, .table-wrap, [data-scroll-x], .seg, .chips, .ticker, .scroll-x")).slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} right=${Math.round(el.getBoundingClientRect().right)}`);
        out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw}) ${wide.join(" | ")}`);
      }
      for (const img of document.images) if (img.complete && img.naturalWidth === 0 && img.getAttribute("src") && !img.closest(".tok-ico, .chain-logo, .pad-logo, .wallet-logo")) out.push("broken image " + img.getAttribute("src"));
      for (const el of document.querySelectorAll(".mark")) { const b = el.getBoundingClientRect(); if (b.width > 0 && getComputedStyle(el).backgroundImage === "none") out.push("logo mark has no image"); }
      for (const a of document.querySelectorAll(".ca-chip .addr")) {
        const b = a.getBoundingClientRect();
        if (!b.width) continue;
        if (ca && a.textContent.trim() !== ca) out.push(`CA text differs: "${a.textContent.trim()}"`);
        if (a.scrollWidth > a.clientWidth + 1 || b.right > vw + 1 || b.left < -1) out.push(`CA cut off (right=${Math.round(b.right)} vw=${vw})`);
      }
      return { out, cas: document.querySelectorAll(".ca-chip .addr").length };
    }, CA);
    issues.push(...dom.out);
    const name = `${sz}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}`;
    await page.evaluate(() => scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
    if (path === "/" || path === "/agent#/") {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await new Promise((r) => setTimeout(r, 1500));
      await page.screenshot({ path: `${OUT}/${name}-bottom.png` }).catch(() => {});
    }
    report.push({ size: sz, path, cas: dom.cas, issues: [...new Set(issues)] });
    await page.close();
  }
}
await browser.close();
let bad = 0;
for (const r of report) { if (r.issues.length) bad++; console.log(`${r.issues.length ? "✗" : "✓"} ${r.size.padEnd(5)} ${r.path}${r.cas ? `  [CA chips: ${r.cas}]` : ""}`); for (const i of r.issues) console.log("    - " + i); }
console.log(`\n${report.length - bad}/${report.length} clean`);
