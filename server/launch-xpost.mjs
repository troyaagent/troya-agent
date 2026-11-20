// Born through Troya, on X: every coin launched through Troya (from X, Telegram or the web app) gets one post on
// @Troyaagent, once, with its CA, who launched it, its Troya Gate result at birth and a trading link. A coin launched
// from a post on X is quoted (the creator's own post shows under ours). Suggested by @XPinarachy, asked for by the
// owner on 18 Nov 2026.
//
// Rails:
//   · once per coin (data/launch-xpost.json keeps what was posted or skipped and why)
//   · the team's own test coins are skipped (a "test" name or ticker, or a creator in X_ADMINS / TROYA_ADMINS / the test wallet)
//   · it waits for the Gate verdict (a few minutes) and skips a coin the Gate fails or warns on ("failed", "caution");
//     "passed" and "untested" coins are posted, a coin still "launching" after 45 minutes is skipped
//   · posted a minute or so after launch, once the Gate has a verdict (checked every minute)
//   · at most LAUNCH_XPOST_DAY posts a UTC day (default 24), at least LAUNCH_XPOST_GAP_MIN minutes apart (default 3),
//     oldest first, and a coin older than 24 hours is dropped instead of posted late
//   · every post spends the shared daily X post budget in xsocial.mjs (postTweet), which also keeps one cashtag a post
//   · LAUNCH_XPOST=0 switches it off; LAUNCH_XPOST_DRY=1 logs the posts without sending them
//
//   GET /api/launch/xpost   admin: what was posted or skipped, and what waits

const STATE = "launch-xpost.json";
const TEST_WALLETS = ["0x12a05719851c8375342de65c9105329c81f57054"];   // the team's test wallet (Robinhood Chain)
const MAX_AGE = 24 * 3600_000, MIN_AGE = 60_000, GATE_WAIT = 45 * 60_000;
// Gate verdicts that keep a coin off X, and the ones that may be posted (an untested coin says its sell test is still to come)
const GATE_SKIP = new Set(["failed", "caution", "fail", "warn", "danger"]);
const GATE_POST = new Set(["passed", "untested", "nobuys"]);
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(`${process.env.X_ADMINS || ""},${process.env.TROYA_ADMINS || ""}`).split(",").map((a) => lc(a.trim())).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const team = () => new Set([...TEST_WALLETS, ...admins()]);
const gapMs = () => Math.max(1, Number(process.env.LAUNCH_XPOST_GAP_MIN) || 3) * 60_000;
const perDay = () => Math.max(1, Number(process.env.LAUNCH_XPOST_DAY) || 24);
const today = () => new Date().toISOString().slice(0, 10);

let store = null, port = 9270, busy = false;

async function localJson(path) {
  try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// why a coin is not posted (null: it may be posted now; "wait": not yet)
export function verdictFor(c, rec, { now = Date.now(), teamSet = team() } = {}) {
  const born = Number(c.at || rec?.at) || 0;
  const name = `${c.symbol || ""} ${c.name || ""}`;
  if (c.source === "origin") return "this is $TROYA itself";
  if (/test/i.test(name)) return "a team test coin";
  if (teamSet.has(lc(c.creator || rec?.owner))) return "launched by a team wallet";
  if (!born || now - born > MAX_AGE) return "older than 24 hours";
  if (now - born < MIN_AGE) return "wait";
  // the board's words (bornGate in launch.mjs, from sentry.verdict): "passed", "caution", "failed", "untested" (sentry's
  // "nobuys": the sell test waits for the first buys) and "launching" (the snipe tax still runs, checked again in 30 s).
  // The older words fail/warn/danger are still skipped, so a caller that sends them can never get a coin posted.
  const v = c.gate?.verdict;
  if (GATE_SKIP.has(v)) return `Troya Gate: ${v}${c.gate?.why ? ` (${c.gate.why})` : ""}`;
  if (GATE_POST.has(v)) return null;
  // launching, no verdict yet, or a word this file does not know: wait for a real verdict, and give up after GATE_WAIT
  return now - born > GATE_WAIT ? "no Gate verdict in time" : "wait";
}

const tweetIdOf = (rec) => { const m = /^x:(\d{5,25})$/.exec(String(rec?.ref || "")); return m ? m[1] : null; };

export function textFor(c, rec, handle) {
  const sym = String(c.symbol || "").trim(), name = String(c.name || "").trim();
  const tag = /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(sym) ? `$${sym}` : sym;
  const title = name && lc(name) !== lc(sym) ? `${tag} (${name})` : tag;
  const by = handle ? `by @${handle} ` : "";
  const how = c.source === "x" ? `Launched ${by}from a post on X.` : c.source === "tg" ? `Launched ${by}from Telegram.` : `Launched ${by}on troya.codes.`;
  const g = c.gate || {};
  const gate = g.verdict === "passed" ? "Troya Gate: passed at birth." : `Troya Gate: ${g.passed ?? "?"} of ${g.total ?? "?"} checks passed, the sell test runs after the first buys.`;
  const quote = c.source === "x" && tweetIdOf(rec) ? `\n\nhttps://x.com/i/status/${tweetIdOf(rec)}` : "";
  return `Born through Troya: ${title}\n${how}\n\nCA ${c.token}\n${gate}\n\nTrade it: https://troya.codes/agent#/token/${lc(c.token)}${quote}`;
}

async function logoMedia(c, rec, xs) {
  const url = c.image || rec?.logo;
  if (!url || !/^https:\/\//.test(url)) return [];
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = r.headers.get("content-type") || "image/jpeg";
    if (!r.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_500_000) return [];
    return [await xs.uploadImage(buf, type)];
  } catch { return []; }
}

export async function tick(now = Date.now()) {
  if (busy || process.env.LAUNCH_XPOST === "0" || !store) return;
  busy = true;
  try {
    const st = await store.readJson(STATE, { done: {}, day: null, posts: 0, lastAt: 0 });
    if (st.day !== today()) { st.day = today(); st.posts = 0; }
    const board = await localJson("/api/launch/board");
    if (!board) return;
    const recs = new Map((await store.readJson("launches.json", [])).map((x) => [lc(x.token), x]));
    const coins = [...(board.new || []), ...(board.almost || []), ...(board.migrated || [])]
      .filter((c) => c?.token && !st.done[lc(c.token)])
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    let changed = false, next = null;
    for (const c of coins) {
      const rec = recs.get(lc(c.token));
      const why = verdictFor(c, rec, { now });
      if (why === "wait") continue;
      if (why) { st.done[lc(c.token)] = { at: now, skipped: why, symbol: c.symbol }; changed = true; continue; }
      if (!next) next = { c, rec };
    }
    if (next && st.posts < perDay() && now - (st.lastAt || 0) >= gapMs()) {
      const { c, rec } = next;
      const xs = await import("./xsocial.mjs");
      const handle = (await xs.handleOf(rec?.owner || c.creator).catch(() => null))?.username || null;
      const text = textFor(c, rec, handle);
      if (process.env.LAUNCH_XPOST_DRY === "1") {
        console.log("[launch-xpost] dry run:\n" + text);
        st.done[lc(c.token)] = { at: now, dry: true, symbol: c.symbol, text };
      } else {
        try {
          const media = c.source === "x" && tweetIdOf(rec) ? [] : await logoMedia(c, rec, xs);
          const id = await xs.postTweet(text, { mediaIds: media });
          st.done[lc(c.token)] = { at: now, posted: id || true, symbol: c.symbol, text };
          st.posts++; st.lastAt = now;
          console.log(`[launch-xpost] posted ${c.symbol} ${id || ""}`);
        } catch (e) {
          st.lastAt = now - gapMs() + 10 * 60_000;   // try again in 10 minutes
          st.error = { at: now, symbol: c.symbol, msg: String(e?.message || e).slice(0, 200) };
          console.warn("[launch-xpost]", c.symbol, st.error.msg);
        }
      }
      changed = true;
    }
    if (changed) await store.writeJson(STATE, st);
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store; port = Number(process.env.PORT) || 9270;
  r.get("/api/launch/xpost", async ({ req }) => {
    const { getSession } = await import("./auth.mjs");
    const s = getSession(req);
    if (!s?.address || !admins().includes(lc(s.address))) return { error: "Admins only." };
    return { on: process.env.LAUNCH_XPOST !== "0", dry: process.env.LAUNCH_XPOST_DRY === "1", perDay: perDay(), gapMinutes: gapMs() / 60_000, state: await store.readJson(STATE, null) };
  });
  if (process.env.LAUNCH_XPOST !== "0") {
    setTimeout(() => tick().catch((e) => console.warn("[launch-xpost]", e.message)), 30_000).unref?.();
    setInterval(() => tick().catch((e) => console.warn("[launch-xpost]", e.message)), 60_000).unref?.();
  }
}
