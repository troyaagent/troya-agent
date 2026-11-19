// Live facts for the bots (Telegram group AI and the X replies).
// Owner, 19 Nov 2026: the bots' knowledge must always stay up to date by itself. The written prompt in tgbot.mjs goes
// stale whenever a phase ships, so every answer also gets a short block read from the site itself: which roadmap
// phases are live (a tick on troya.codes/roadmap) and which real-money receipts exist (troya.codes/verify). The block
// is cached for 15 minutes and the last good copy is kept if the site cannot be read.

const PORT = process.env.PORT || 9270;
const TTL = 15 * 60 * 1000;
let cache = { at: 0, text: "" };
let inflight = null;

const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);

async function page(path) {
  for (const base of [`http://127.0.0.1:${PORT}`, "https://troya.codes"]) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) }); if (r.ok) return await r.text(); } catch {}
  }
  return "";
}

function roadmap(html) {
  const out = [];
  for (const sec of html.split(/<section\b/).slice(1)) {
    const num = (sec.match(/<span class="rm-num">(V\d+)<\/span>/) || [])[1];
    if (!num) continue;
    const title = strip((sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
    const chip = (sec.match(/rm-chip (\w+)/) || [])[1] || "";
    const phases = [...sec.matchAll(/<li class="rm-ph( next)?"[\s\S]*?<small>(F\d+)<\/small><b>([\s\S]*?)<\/b>(?:<span>([\s\S]*?)<\/span>)?/g)].map((m) => {
      const name = strip(m[3].replace(/<a[\s\S]*?<\/a>/g, ""));
      return m[1] ? `${m[2]} ${name}: NOT live yet` : `${m[2]} ${name}: LIVE (${cut(strip(m[4]), 110)})`;
    });
    out.push(`${num} ${title} [${chip === "live" ? "shipped" : chip === "build" ? "in build" : chip || "status not shown"}]: ${phases.join("; ")}`);
  }
  return out;
}

function receipts(html) {
  return [...html.matchAll(/<article class="step[^"]*"[^>]*>\s*<span class="n">(\d+)<\/span>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => {
    const when = (strip(m[3]).match(/^\d{1,2} \w{3} \d{4}/) || [""])[0];
    return when ? `${m[1]} ${strip(m[2])} (${when})` : "";
  }).filter(Boolean);
}

async function build() {
  const [rm, vf] = await Promise.all([page("/roadmap"), page("/verify")]);
  const r = roadmap(rm), v = receipts(vf);
  if (!r.length && !v.length) return "";
  return `\n\nLIVE STATUS, read from troya.codes just now. It is newer than anything written above: where they disagree, this block wins (a phase marked LIVE here is live even if an older line above says it is not, and a phase marked NOT live yet is never live). Use it to say what is live; for numbers still use the tools.` +
    (r.length ? `\nRoadmap (troya.codes/roadmap):\n${r.join("\n")}` : "") +
    (v.length ? `\nReal-money receipts (troya.codes/verify, step number and title): ${v.join("; ")}` : "");
}

export async function liveFacts() {
  if (Date.now() - cache.at < TTL && cache.text) return cache.text;
  inflight ||= build().then((t) => { if (t) cache = { at: Date.now(), text: t }; else cache.at = Date.now() - TTL + 60_000; return cache.text; }).catch(() => cache.text).finally(() => { inflight = null; });
  return inflight;
}

export { roadmap as _roadmap, receipts as _receipts };
