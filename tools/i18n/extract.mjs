// Collect the English text of the translated pages into tools/i18n/src/<pack>.json (the keys public/js/i18n.js matches).
//   node tools/i18n/extract.mjs [base=http://127.0.0.1:9270]
// Opens each page in a headless browser with ?i18n-collect=1 (always English), reads the page as the server sent it and
// again once its scripts have built the menus, the footer and (in the app) the sidebar, top bar and a few dialogs.
// The header, menus and footer of every site page, and any line found on three or more pages, go to "common" (loaded on
// every page); the rest of a page with a pack goes to that pack. Pages without a pack (proof, verify…) stay English for now.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PW = process.env.PLAYWRIGHT || "/Users/danang/Desktop/RUMAHTANJLIG/tools/node_modules/playwright-core/index.mjs";
const EXE = process.env.CHROME || "/Users/danang/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const { chromium } = await import(PW);
const BASE = process.argv[2] || "http://127.0.0.1:9270";
const OUT = join(fileURLToPath(new URL(".", import.meta.url)), "src");
mkdirSync(OUT, { recursive: true });

// site pages: [path, pack]. Pages without a pack only feed "common" (their header, menu and footer).
const SITE = [["/", "home"], ["/roadmap", "roadmap"], ["/safety", "safety"], ["/proof", null], ["/verify", null], ["/community", null]];
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const perPage = {};
for (const [path, pack] of SITE) {
  await page.goto(BASE + path + "?i18n-collect=1", { waitUntil: "domcontentloaded" });
  await wait(2500);
  const { keys, shell } = await page.evaluate(() => {
    const all = new Map();
    for (const k of [...(window.TroyaI18n.atParse || []), ...window.TroyaI18n.collect()]) if (!all.has(k.key)) all.set(k.key, k);
    return { keys: [...all.values()], shell: window.TroyaI18n.collect(".skip, header, nav.menu, nav.pn-menu, footer, [data-pn-foot], .gas-dlg").map((k) => k.key) };
  });
  perPage[path] = { pack, keys, shell: new Set(shell) };
  console.log(path, keys.length, "shell", shell.length);
}
const count = {};
for (const { keys } of Object.values(perPage)) for (const k of keys) count[k.key] = (count[k.key] || 0) + 1;
const packs = { common: {} };
for (const { pack, keys, shell } of Object.values(perPage)) for (const k of keys) {
  const p = shell.has(k.key) || count[k.key] >= 3 ? "common" : pack;
  if (p) (packs[p] ||= {})[k.key] ||= k;
}

// the app: the shell (sidebar, top bar, tab bar, footer, drawer), Settings and Connect, the Desk home and Stake
const app = {};
const grab = async (sel) => { for (const k of await page.evaluate((s) => window.TroyaI18n.collect(s), sel)) app[k.key] ||= k; };
await page.goto(BASE + "/agent?i18n-collect=1#/stake", { waitUntil: "domcontentloaded" });
await wait(5000);
await grab(".d-side, .d-top, .d-tabbar, .d-foot, .d-drawer, .d-fab, #view");
for (const [btn, label] of [['[aria-label="Settings"]', "settings"], [".d-connect", "connect"]]) {
  try {
    await page.click(btn, { timeout: 3000 });
    await wait(1200);
    await grab(".modal, dialog, [role=dialog]");
    await page.keyboard.press("Escape");
    await wait(500);
  } catch (e) { console.log("could not open", label, e.message.split("\n")[0]); }
}
for (const route of ["#/", "#/agent", "#/swap"]) {
  await page.goto(BASE + "/agent?i18n-collect=1" + route, { waitUntil: "domcontentloaded" });
  await wait(5000);
  await grab("#view, .d-top");
}
// the top-bar trail repeats the sidebar's group and page names as plain text
for (const k of await page.evaluate(() => {
  const box = document.createElement("div");
  box.id = "i18n-tmp";
  for (const s of document.querySelectorAll(".d-nav h5 button span, .d-nav .d-group-items a span, .d-pin b")) { const p = document.createElement("p"); p.textContent = s.textContent; box.append(p); }
  document.body.append(box);
  const keys = window.TroyaI18n.collect("#i18n-tmp");
  box.remove();
  return keys;
})) app[k.key] ||= { ...k, ctx: "crumb" };
// phone width: the tab bar and the compact top bar
await page.setViewportSize({ width: 390, height: 844 });
await wait(1000);
await grab(".d-tabbar, .d-top");
packs.app = app;
await browser.close();

for (const [p, d] of Object.entries(packs)) {
  writeFileSync(join(OUT, `${p}.json`), JSON.stringify(Object.values(d), null, 1) + "\n");
  console.log(p, Object.keys(d).length);
}
