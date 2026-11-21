// Live facts for the bots (Telegram group AI and the X replies) and the in-app assistant.
// Owner, 19 Nov 2026: the bots' knowledge must always stay up to date by itself. The written prompt in tgbot.mjs goes
// stale whenever a phase ships, so every answer also gets a short block read from the site itself: which roadmap
// phases are live (a tick on troya.codes/roadmap) and which real-money receipts exist (troya.codes/verify). The block
// is cached for 15 minutes and the last good copy is kept if the site cannot be read.
// Audit, 20 Nov 2026: the in-app assistant (server/assistant.mjs) reads this block too, and the feature glossary
// (glossary() below, the same lines the in-app Guide uses) so it knows what each feature IS, not only what shipped.
import { readFileSync, statSync } from "node:fs";

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
export async function liveFacts({ brief = false } = {}) {
  const pick = () => (brief ? cache.brief : cache.full);
  if (Date.now() - cache.at < TTL && cache.full) return pick();
  inflight ||= build().then((b) => { if (b.full) cache = { at: Date.now(), ...b }; else cache.at = Date.now() - TTL + 60_000; }).catch(() => {}).finally(() => { inflight = null; });
  await inflight;
  return pick();
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
