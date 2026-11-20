// Safety page (/safety): the live part that shows Troya is still being built, all from sources anyone can open.
//   GET /api/status/alive → { code: latest public commits, launches: coins born through Troya, burn: $TROYA burned,
//                             sentry: the last coin Troya Sentry posted, roadmap: the current chapter }
// Owner, 18 Nov 2026: people worry the project stops and that they hand over keys; this page answers both with proof
// instead of promises. Nothing here is a guarantee; every number links to where it comes from.
const REPO = process.env.GITHUB_REPO || "troyaagent/troya-agent";
const TTL = 10 * 60_000;
// The one place the Safety page's roadmap status comes from. safety.html carries no version number on purpose, so the page
// can never show two chapters at once; move this (and the fallback in public/home/safety.js) the day a chapter goes live.
// Audit, 20 Nov 2026: this still said "V7 Athena shipped" while every V8 phase was already running on the live site.
const ROADMAP = { now: "V8 Agamemnon live", next: "V9 Achilles", named: "V9 to V14", url: "/roadmap" };
let store = null, memo = null, memoAt = 0, inflight = null;

async function github(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "troya-agent-status" }, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

async function build() {
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [recent, weekList, launches, fly, sentry] = await Promise.all([
    github("/commits?per_page=8").catch(() => null),
    github(`/commits?per_page=100&since=${week}`).catch(() => null),
    import("./launch.mjs").then((m) => m.bornTokens()).catch(() => null),
    import("./flywheel.mjs").then((m) => m.flywheelView?.()).catch(() => null),
    store ? store.readJson("sentry.json", {}).catch(() => ({})) : {},
  ]);
  const commits = (recent || []).map((c) => ({
    title: ((t) => (t.length > 140 ? t.slice(0, 140).replace(/[\s,;:(]+\S*$/, "") + "…" : t))(String(c.commit?.message || "").split("\n")[0]),
    at: Date.parse(c.commit?.committer?.date || c.commit?.author?.date || "") || null,
    url: c.html_url || null,
  })).filter((c) => c.title && c.at);
  const posted = (sentry.recent || []).filter((r) => r.posted).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  return {
    code: { repo: `https://github.com/${REPO}`, commits, thisWeek: Array.isArray(weekList) ? weekList.length : null, capped: Array.isArray(weekList) && weekList.length >= 100 },
    launches: launches ? { born: launches.length } : null,
    burn: fly?.burned ? { total: fly.burned.total, pctOfMinted: fly.burned.pctOfMinted, burns: (fly.burned.burns || []).length } : null,
    sentry: posted ? { symbol: posted.symbol || null, at: posted.at || null } : null,
    roadmap: { ...ROADMAP },
    updatedAt: Date.now(),
  };
}

export async function alive() {
  if (memo && Date.now() - memoAt < TTL) return memo;
  if (!inflight) inflight = build().then((v) => { memo = v; memoAt = Date.now(); return v; }).finally(() => { inflight = null; });
  return memo || inflight;    // a stale answer at once while a fresh one is read
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/status/alive", () => alive(), { perMin: 60 });
}
