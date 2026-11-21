// Live facts for the bots (Telegram group AI and the X replies) and the in-app assistant.
// Owner, 19 Nov 2026: the bots' knowledge must always stay up to date by itself. The written prompt in tgbot.mjs goes
// stale whenever a phase ships, so every answer also gets a short block read from the site itself: which roadmap
// phases are live (a tick on troya.codes/roadmap) and which real-money receipts exist (troya.codes/verify). The block
// is cached for 15 minutes and the last good copy is kept if the site cannot be read.
// Audit, 20 Nov 2026: the in-app assistant (server/assistant.mjs) reads this block too, and the feature glossary
// (glossary() below, the same lines the in-app Guide uses) so it knows what each feature IS, not only what shipped.
// 21 Nov 2026: every block also carries WORK IN PROGRESS (workBlock() below): what the team is building right now and
// what shipped as an opt-in, so no bot calls an unbuilt feature live.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.PORT || 9270;
const TTL = 15 * 60 * 1000;
let cache = { at: 0, full: "", brief: "" };
let inflight = null;

const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
const big = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

async function page(path) {
  for (const base of [`http://127.0.0.1:${PORT}`, "https://troya.codes"]) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) }); if (r.ok) return await r.text(); } catch {}
  }
  return "";
}
async function json(path) { try { const t = await page(path); return t ? JSON.parse(t) : null; } catch { return null; } }

// brief: phase names and their status only (the assistant gets what each phase does from the glossary)
function roadmap(html, { brief = false } = {}) {
  const out = [];
  for (const sec of html.split(/<section\b/).slice(1)) {
    const num = (sec.match(/<span class="rm-num">(V\d+)<\/span>/) || [])[1];
    if (!num) continue;
    const title = strip((sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
    const chip = (sec.match(/rm-chip (\w+)/) || [])[1] || "";
    // the chip's own words win: "Live, finishing" on a build-coloured chip means live, not "in build"
    const chipText = strip((sec.match(/rm-chip \w+"><i><\/i>([^<]*)</) || [])[1] || "");
    const phases = [...sec.matchAll(/<li class="rm-ph( next)?"[\s\S]*?<small>(F\d+)<\/small><b>([\s\S]*?)<\/b>(?:<span>([\s\S]*?)<\/span>)?/g)].map((m) => {
      // the name without its Open link, its "New" badge and its "From the live Arena" note
      const name = strip(m[3].replace(/<a[\s\S]*?<\/a>/g, "").replace(/<span class="new-badge"[\s\S]*?<\/span>/g, "").replace(/<em class="rm-from"[\s\S]*?<\/em>/g, ""));
      if (m[1]) return `${m[2]} ${name}: NOT live yet`;
      // a phase's own status tag ("Live · read-only", "Real-money test pending"); a pending test says what it waits for
      // (a <strong>, or an <a> when it links to its receipt on /verify)
      const st = /<(strong|a) class="rm-st (\w+)"[^>]*?(?: title="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/.exec(m[4] || "");
      const label = st ? strip(st[4]) : "";
      const status = !label ? "LIVE" : /^live\b/i.test(label) ? `LIVE${label.slice(4)}` : `LIVE, ${label.toLowerCase()}${st[2] === "wait" && st[3] ? ` (${strip(st[3])})` : ""}`;
      const desc = strip((m[4] || "").replace(st?.[0] || "", ""));
      return brief || !desc ? `${m[2]} ${name}: ${status}` : `${m[2]} ${name}: ${status} (${cut(desc, 110)})`;
    });
    const status = chip === "live" ? "shipped" : /\blive\b/i.test(chipText) ? `${chipText}: every phase running, real-money tests and switches next` : chip === "build" ? "in build" : chip || "status not shown";
    out.push(`${num} ${title} [${status}]: ${phases.join("; ")}`);
  }
  return out;
}

function receipts(html) {
  return [...html.matchAll(/<article class="step[^"]*"[^>]*>\s*<span class="n">(\d+)<\/span>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => {
    const when = (strip(m[3]).match(/^\d{1,2} \w{3} \d{4}/) || [""])[0];
    // the title without the "New" badge that sits inside it
    return when ? `${m[1]} ${strip(m[2].replace(/<span class="new-badge"[\s\S]*?<\/span>/g, ""))} (${when})` : "";
  }).filter(Boolean);
}

// the terms people ask about most and that the team changes from the admin side: read live, never written in a prompt
function tiers(t) {
  if (!Array.isArray(t?.tiers) || !t.tiers.length) return "";
  const rows = t.tiers.map((x) => `${x.name} (${x.min ? `${big(x.min)} $TROYA` : "anyone"}): ${x.watchfirePins} Watchfire pin${x.watchfirePins === 1 ? "" : "s"}, ${x.gateChecksPerDay ?? "the holder quota of"} Gate checks a day${x.perks ? ", holder perks" : ""}`);
  return `Holder tiers (troya.codes/agent#/treasury, counted across ${t.counted || "the signed-in wallet and its Agent Wallet"}): ${rows.join("; ")}.${t.perks ? ` ${t.perks}` : ""}${t.pro?.note ? ` ${t.pro.note}` : ""}`;
}
function herald(lb, cup) {
  const parts = [];
  if (lb?.rewards) parts.push(String(lb.rewards));
  if (cup?.name) parts.push(`${cup.name}: ${cup.prizeOn && cup.prize ? cup.prize : "no prize is set right now."} ${cup.rule || ""}`.trim());
  return parts.length ? `Herald terms (troya.codes/agent#/herald): ${parts.join(" ")}` : "";
}

async function build() {
  const [rm, vf, tr, lb, cup] = await Promise.all([page("/roadmap"), page("/verify"), json("/api/treasury"), json("/api/herald/leaderboard"), json("/api/herald/cup")]);
  const v = receipts(vf), t = tiers(tr), hd = herald(lb, cup);
  const make = (r) => {
    if (!r.length && !v.length) return "";
    return `\n\nLIVE STATUS, read from troya.codes just now. It is newer than anything written above: where they disagree, this block wins (a phase marked LIVE here is live even if an older line above says it is not, and a phase marked NOT live yet is never live). Use it to say what is live; for numbers still use the tools, except the tiers and terms below, which are read live and may be quoted.` +
      (r.length ? `\nRoadmap (troya.codes/roadmap):\n${r.join("\n")}` : "") +
      (v.length ? `\nReal-money receipts (troya.codes/verify, step number and title): ${v.join("; ")}` : "") +
      (t ? `\n${t}` : "") + (hd ? `\n${hd}` : "");
  };
  return { full: make(roadmap(rm)), brief: make(roadmap(rm, { brief: true })) };
}

// { brief: true } leaves out each phase's description (for a prompt that already carries the feature glossary)
// { work: false } leaves out the WORK IN PROGRESS block (for a prompt that adds workBlock() itself)
export async function liveFacts({ brief = false, work = true } = {}) {
  const pick = () => (brief ? cache.brief : cache.full) + (work ? workBlock() : "");
  if (Date.now() - cache.at < TTL && cache.full) return pick();
  inflight ||= build().then((b) => { if (b.full) cache = { at: Date.now(), ...b }; else cache.at = Date.now() - TTL + 60_000; }).catch(() => {}).finally(() => { inflight = null; });
  await inflight;
  return pick();
}

/* ---------- work in progress ----------
   Community questions on 21 Nov 2026 asked about features the team is building right now. The bots (Telegram, X) and
   the in-app assistant must answer "that one is being worked on" for these, never "live", and must describe an opt-in
   feature as opt-in. Statuses: building (not live, nothing to use yet), optin (live, off by default, the user switches
   it on), live. A status changes here, or with no deploy in data/feature-status.json, e.g. { "stake": "live" }
   (re-read every minute). A roadmap phase that the LIVE STATUS block marks LIVE still wins for that phase. */
const WORK = [
  // 21 Nov 2026: the contract and the page are built, the contract is being deployed. It turns live with
  // data/feature-status.json { "stake": "live" } (the older key "staking" is read too).
  { key: "stake", keys: ["stake", "staking"], name: "$TROYA staking", aka: ["staking", "stake", "staked", "staker", "stakers", "stake troya", "troya staking", "staking tiers", "staking rewards", "staking reward", "apy", "apr", "yield"],
    building: "coming, the contract is being deployed: staking is not open yet, so nobody can stake $TROYA today and nothing can be claimed. When it opens it will be on troya.codes/agent#/stake only: stake $TROYA on Robinhood Chain, unstake with a 3-day wait, a tier (Bronze, Silver, Gold) from how much is staked and for how long, perks inside Troya (earlier Sentry alerts, more assistant and Council use, free Gate API checks, a badge), and staked coins still count for the 1M holder perks. Stakers get a share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield; at $100k and up another 0.1% of volume buys $TROYA back and burns it. That share counts from 21 Nov 2026 and is kept in a staker pot until the contract is live; the pot (and the first 7 days after go-live) is paid on day 7 after it goes live, and from then on it is paid into the staking contract every day; claim any time. Each staked $TROYA earns the same rate: the full daily share is paid once 5% of the supply is staked; with less staked only that fraction is paid and the unpaid part stays with the team. If nobody is staked when the daily share is paid, it stays with the team (also when a day's amount is too small to send). Never quote an APY, APR, a yield, tier sizes or a date, and warn that any other site, bot or DM offering $TROYA staking is a scam.",
    live: "live at troya.codes/agent#/stake (the only place to stake): stake $TROYA on Robinhood Chain in your own wallet, unstake with a 3-day wait, then withdraw. The contract has no owner, no admin and no fee. A tier (Bronze, Silver, Gold) comes from the share of the supply staked and the days staked; the page shows the current sizes and perks (earlier Sentry alerts, more assistant and Council use, free Gate API checks, Arena Cup points shown for fun, a badge in the community chat and the Treasury). Staked and waiting coins still count for the 1M holder perks. Stakers get a share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield; each fee uses the market cap of the hour it came in (a median of several reads). Paid into the staking contract every day (01:00 UTC, for the day before); claim any time; it is shared by every coin staked at that moment, and the pot from before launch was paid on day 7 after go-live. Each staked $TROYA earns the same rate: the full daily share is paid once 5% of the supply is staked; until then only that fraction is paid (the page shows it live) and the unpaid part stays with the team. If nobody is staked when the daily share is paid, it stays with the team (also when a day's amount is too small to send). At $100k and up another 0.1% of volume buys $TROYA back and burns it. Never quote an APY, APR or a yield, never promise an amount, and send people to the page for the numbers." },

  { key: "chat", name: "Community chat inside the app", aka: ["in-app chat", "in app chat", "app chat", "chat in the app", "community chat", "chat room", "chatroom", "web chat", "chat on the website", "chat on troya.codes"],
    building: "being built, not open yet: members cannot chat with each other inside troya.codes today; the community talks in the Telegram group t.me/troyaagent. This is not Ask Troya, the AI assistant in the app, which is live." },
  { key: "passed", name: "Passed strip on the Desk", aka: ["passed strip", "pass strip", "passed lane", "passed coins strip", "passes strip"],
    building: "being built, not on the Desk yet: a live lane of the newest coins that passed Troya Sentry at the channel's bar (next to a lane of coins that just graduated from their Pons curve). Until it ships, the same passes are posted in t.me/troyasentry and shown by /sentry in Telegram." },
  { key: "permit2", name: "One-approval sells with Permit2", aka: ["permit2", "permit 2", "one approval", "one-approval", "single approval", "approve once", "approval once", "fewer approvals", "two approvals", "approve every sell", "approval every time"],
    optin: "live, opt-in, off by default: on the Swap page, for coins that route through Uniswap v4 on Robinhood Chain, a seller can approve the coin once for Uniswap's Permit2 contract (an unlimited allowance), and every later sell is then a free signature for the exact amount (valid 30 minutes) plus the swap itself, instead of two exact approvals each time. The choice is remembered on that device. Routes through KyberSwap, LI.FI, Uniswap v3 and Pons curves keep the exact approvals. It is a choice, never required: an unlimited approval is a trade-off, so say so plainly." },
  { key: "walletconnect", name: "WalletConnect (phone wallets by QR code)", aka: ["walletconnect", "wallet connect", "reown", "qr code", "scan qr", "connect with qr", "mobile wallet", "phone wallet", "connect my phone", "trust wallet", "email login", "passkey"],
    building: "being built, not live: today the app connects a browser wallet (an extension such as MetaMask, Rabby, Coinbase Wallet or OKX Wallet, or the browser inside a wallet app); connecting a phone wallet by scanning a WalletConnect QR code is coming, with no date. Email or passkey sign-in has not been announced." },
];
const STATUS_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "feature-status.json") : new URL("../data/feature-status.json", import.meta.url);
let over = { at: 0, v: {} };
function overrides() {
  if (Date.now() - over.at < 60_000) return over.v;
  let v = {};
  try { const o = JSON.parse(readFileSync(STATUS_FILE, "utf8")); if (o && typeof o === "object") v = o; } catch { /* no file: the defaults */ }
  over = { at: Date.now(), v };
  return v;
}
const statusOf = (w) => { const o = overrides(); const s = (w.keys || [w.key]).map((k) => o[k]).find((v) => ["building", "optin", "live"].includes(v)); return s || (w.optin ? "optin" : "building"); };
// an override with no written line for its status gets a plain one, never the line of another status
const sayOf = (w, st) => w[st] || (st === "live" ? "live now; for where it is and how it works use the FEATURE GLOSSARY or troya.codes/agent#/docs, never details from memory"
  : st === "optin" ? "live as an opt-in: off until the user switches it on; for where it is and how it works use the FEATURE GLOSSARY or troya.codes/agent#/docs, never details from memory" : w.building);
export function workItems() { return WORK.map((w) => { const status = statusOf(w); return { key: w.key, name: w.name, status, says: sayOf(w, status) }; }); }
// the items a question names (troya_feature tool); nothing when it names none
export function workStatus(text) {
  const s = norm(text);
  return workItems().filter((it) => { const w = WORK.find((x) => x.key === it.key); return [w.name, ...w.aka].some((a) => s.includes(norm(a))); });
}
export function workBlock() {
  return `\n\nWORK IN PROGRESS (set by the team, newer than anything written above, the feature glossary included): when someone asks about one of these, answer from its line in plain words, e.g. "that one is being worked on, it is not live yet", and never say or imply that a feature being built is live, can be used today, or has a date. An opt-in feature is live but off until the user switches it on: say both. A roadmap phase the LIVE STATUS block marks LIVE still wins for that phase.\n` +
    workItems().map((it) => `- ${it.name}: ${it.says}`).join("\n");
}

/* ---------- the feature glossary ----------
   One source for what each feature is: GLOSSARY in public/agent/desk/guide.js (the in-app Guide), between the
   GLOSSARY:BEGIN and GLOSSARY:END markers, as strict JSON. Re-read whenever the file changes, so a deploy of the page
   updates the assistant too without a restart; a broken edit keeps the last good copy and says so once in the log. */
const GUIDE = new URL("../public/agent/desk/guide.js", import.meta.url);
const MARK = ["/* GLOSSARY:BEGIN */", "/* GLOSSARY:END */"];
let gl = { mtime: -1, list: [], warned: 0 };
const okEntry = (g) => g && ["name", "page", "where", "what", "money"].every((k) => typeof g[k] === "string" && g[k].trim());
export function glossary() {
  try {
    const mtime = statSync(GUIDE).mtimeMs;
    if (mtime === gl.mtime) return gl.list;
    const src = readFileSync(GUIDE, "utf8");
    const a = src.indexOf(MARK[0]), b = src.indexOf(MARK[1]);
    if (a < 0 || b < a) throw new Error("the glossary markers are missing");
    const list = JSON.parse(src.slice(a + MARK[0].length, b));
    if (!Array.isArray(list) || !list.length) throw new Error("the glossary is empty");
    gl = { mtime, list: list.filter(okEntry).map((g) => ({ ...g, aka: Array.isArray(g.aka) ? g.aka.map(String) : [] })), warned: 0 };
  } catch (e) {
    if (Date.now() - gl.warned > 3600_000) { gl.warned = Date.now(); console.warn("[botfacts] glossary:", e.message, gl.list.length ? "(keeping the last good copy)" : ""); }
  }
  return gl.list;
}
// where a feature lives as a link people can open: an app route or a site page
export const linkOf = (g) => (g.page.startsWith("/") ? `troya.codes${g.page}` : `troya.codes/agent#/${g.page}`);
export function glossaryBlock() {
  const list = glossary();
  if (!list.length) return "";
  return `\n\nFEATURE GLOSSARY: every part of Troya, one line each: its name, where it lives and its link, what it is for, and whether it can move money. It is the same text the in-app Guide shows. It says what a feature IS; whether a phase is live comes from the LIVE STATUS block.\n` +
    list.map((g) => `- ${g.name} (${g.where}; ${linkOf(g)}): ${g.what} Money: ${g.money}`).join("\n");
}

// the features a text names, in the order it names them; longest names first, so "Sentry Autopilot" is never also read
// as "Autopilot" or "Sentry" (the same rule as featuresIn() in guide.js)
const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
export function featuresIn(text) {
  const terms = glossary().flatMap((g) => [g.name.replace(/\s*\([^)]*\)\s*$/, ""), ...g.aka].map((t) => [norm(t).trim(), g]))
    .filter(([t]) => t.length > 2).sort((a, b) => b[0].length - a[0].length);
  let s = norm(text);
  const hits = [];
  for (const [t, g] of terms) for (const form of [t, `${t}s`]) {
    const k = ` ${form} `;
    for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k)) {
      if (!hits.some((x) => x.g === g)) hits.push({ g, i });
      s = s.slice(0, i + 1) + "#".repeat(form.length) + s.slice(i + 1 + form.length);
    }
  }
  return hits.sort((a, b) => a.i - b.i).map((x) => x.g);
}

export { roadmap as _roadmap, receipts as _receipts };
