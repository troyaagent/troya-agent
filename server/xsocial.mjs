// F20 · Social layer, X: Sign in with X and Troya answering on X.
//   GET  /api/x/login?for=link   → Sign in with X (OAuth 2.0 + PKCE) for a signed-in wallet: links that X account to it
//   GET  /api/x/login?for=bot    → the @Troyaagent account authorizes Troya to answer its mentions (only that handle counts)
//   GET  /api/x/callback         → finishes either sign-in and goes back to the app
//   GET  /api/x/me               → the X account linked to your wallet          POST /api/x/unlink → removes the link
//   GET  /api/x/handle?address=  → public: the X handle linked to an address (leaderboard, agent pages)
//   GET  /api/x/status           → public: is Troya on X connected, its mode (off, draft, live), today's X usage
//   GET  /api/x/log              → admins: the mentions Troya saw and what it drafted or posted
//   POST /api/x/mode {mode}      → admins: off | draft | live
//   POST /api/x/poll             → admins: check the mentions now instead of waiting for the next round
// Every X call goes through one daily budget (reads, posts, searches; X_DAILY_* in the env). Over the cap, no call is
// made. X is pay-per-use, so the defaults are small. The bot's tokens are stored encrypted (data/x.key).
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, getAddress } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";

const API = "https://api.x.com";
const REDIRECT = process.env.X_REDIRECT || "https://troya.codes/api/x/callback";
const BOT_NAME = String(process.env.X_BOT_USERNAME || "Troyaagent").replace(/^@/, ""), BOT = BOT_NAME.toLowerCase();
// mentions are read every minute (owner, 17 Nov 2026: launches from X should answer fast; the X API credit is paid),
// so the daily read budget covers ~1,440 polls and the post budget covers the launch replies
const CAPS = { reads: Number(process.env.X_DAILY_READS) || 3000, posts: Number(process.env.X_DAILY_POSTS) || 100, search: Number(process.env.X_DAILY_SEARCH) || 30, users: Number(process.env.X_DAILY_USERS) || 100 };
const POLL_MIN = Math.max(1, Number(process.env.X_POLL_MIN) || 1);
const admins = () => String(process.env.X_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const lc = (s) => String(s || "").toLowerCase();
const on = () => !!(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);

let store = null, dataDir = null, key = null;

/* ---------- the daily budget ---------- */
const today = () => new Date().toISOString().slice(0, 10);
export async function spend(kind, n = 1) {
  if (!store) return false;
  let ok = false;
  await store.update("x-usage.json", {}, (u) => {
    if (u.day !== today()) { u.day = today(); u.reads = 0; u.posts = 0; u.search = 0; u.users = 0; }
    if ((u[kind] || 0) + n > CAPS[kind]) return u;
    u[kind] = (u[kind] || 0) + n; ok = true;
    return u;
  });
  return ok;
}
async function left(kind) { const u = await usage(); return CAPS[kind] - (u[kind] || 0); }
async function usage() { const u = await store.readJson("x-usage.json", {}); return u.day === today() ? u : { day: today(), reads: 0, posts: 0, search: 0, users: 0 }; }

async function xApi(path, { token, method = "GET", body } = {}) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 429 ? 429 : 502, `X answered ${r.status}: ${j?.detail || j?.title || j?.errors?.[0]?.message || "error"}`);
  return j;
}
async function tokenCall(params) {
  const basic = Buffer.from(`${encodeURIComponent(process.env.X_CLIENT_ID)}:${encodeURIComponent(process.env.X_CLIENT_SECRET)}`).toString("base64");
  const r = await fetch(`${API}/2/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new HttpError(502, `X sign-in failed: ${j.error_description || j.error || r.status}`);
  return j;
}

/* ---------- encryption for the bot's tokens ---------- */
async function loadKey() {
  const f = join(dataDir, "x.key");
  try { return Buffer.from((await readFile(f, "utf8")).trim(), "hex"); }
  catch { await writeFile(f, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }).catch(() => {}); return Buffer.from((await readFile(f, "utf8")).trim(), "hex"); }
}
const seal = (obj) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]); return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") }; };
const unseal = (e) => { const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "hex")); d.setAuthTag(Buffer.from(e.tag, "hex")); return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ct, "hex")), d.final()]).toString("utf8")); };
async function botTokens() {
  const b = await store.readJson("x-bot.json", null);
  if (!b?.enc) return null;
  let t = unseal(b.enc);
  if (t.exp - Date.now() < 120_000 && t.refresh) {
    const j = await tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: process.env.X_CLIENT_ID });
    t = { ...t, access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + (j.expires_in || 7200) * 1000 };
    await store.writeJson("x-bot.json", { ...b, enc: seal(t), refreshedAt: Date.now() });
  }
  return t;
}

/* ---------- Sign in with X ---------- */
const pending = new Map();                      // state → { purpose, address, verifier, exp }
const b64u = (b) => b.toString("base64url");
function login(req, res, purpose, back) {
  if (!on()) throw new HttpError(503, "Sign in with X is not configured on this server yet.");
  let address = null;
  const home = back === "launch" ? "/agent#/launch/x" : "/agent#/social";
  if (purpose === "link") { const s = getSession(req); if (!s) return redirect(res, `${home}?x=signin`); address = s.address; }
  const state = b64u(randomBytes(18)), verifier = b64u(randomBytes(48));
  pending.set(state, { purpose, address, verifier, home, exp: Date.now() + 10 * 60_000 });
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const scope = purpose === "bot" ? "tweet.read tweet.write users.read offline.access" : "tweet.read users.read";
  const q = new URLSearchParams({ response_type: "code", client_id: process.env.X_CLIENT_ID, redirect_uri: REDIRECT, scope, state, code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" });
  return redirect(res, `https://x.com/i/oauth2/authorize?${q}`);
}
function redirect(res, to) { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); return undefined; }
async function callback(query, res) {
  const p = pending.get(String(query.state || ""));
  pending.delete(String(query.state || ""));
  if (!p || p.exp < Date.now()) return redirect(res, "/agent#/social?x=expired");
  if (query.error || !query.code) return redirect(res, "/agent#/social?x=cancelled");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code: String(query.code), redirect_uri: REDIRECT, code_verifier: p.verifier, client_id: process.env.X_CLIENT_ID });
    if (!(await spend("users"))) return redirect(res, "/agent#/social?x=busy");
    const me = (await xApi("/2/users/me?user.fields=profile_image_url", { token: t.access_token })).data;
    if (!me?.id) throw new Error("no user");
    if (p.purpose === "bot") {
      if (lc(me.username) !== BOT) return redirect(res, `/agent#/social?x=notbot&as=${encodeURIComponent(me.username)}`);
      await store.writeJson("x-bot.json", { id: me.id, username: me.username, connectedAt: Date.now(), enc: seal({ id: me.id, username: me.username, access: t.access_token, refresh: t.refresh_token || null, exp: Date.now() + (t.expires_in || 7200) * 1000 }) });
      return redirect(res, "/agent#/social?x=bot");
    }
    await store.update("x-links.json", {}, (m) => {
      for (const [a, v] of Object.entries(m)) if (v.id === me.id) delete m[a];              // one wallet per X account
      m[lc(p.address)] = { id: me.id, username: me.username, name: String(me.name || "").slice(0, 60), avatar: me.profile_image_url || null, at: Date.now() };
      return m;
    });
    return redirect(res, `${p.home || "/agent#/social"}?x=linked`);
  } catch (e) {
    console.warn("[x] sign-in:", e.message);
    return redirect(res, "/agent#/social?x=failed");
  }
}

/* ---------- Troya answering on X ---------- */
const mode = async () => (await store.readJson("x-state.json", {})).mode || (["off", "draft", "live"].includes(process.env.X_REPLY) ? process.env.X_REPLY : "draft");
const LINK_OK = /^(https?:\/\/)?(www\.)?(troya\.codes|t\.me\/troyaagent|x\.com\/troyaagent|dexscreener\.com\/robinhood)/i;
function tidy(t) {
  let s = String(t || "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/\s+\n/g, "\n").trim();
  s = s.replace(/(^|\s)@\w+/g, "$1").replace(/https?:\/\/\S+/g, (u) => (LINK_OK.test(u) ? u : "")).replace(/[ \t]{2,}/g, " ").trim();
  if (s.length > 270) s = s.slice(0, 267).replace(/\s+\S*$/, "") + "…";
  return s;
}
let polling = false, lastPollAt = 0;
const handled = new Set();           // post ids answered by this process: the stream and the poll never answer one twice
const FIELDS = { "tweet.fields": "author_id,conversation_id,created_at,referenced_tweets,lang,attachments", expansions: "author_id,attachments.media_keys", "user.fields": "username,name", "media.fields": "url,type" };

/** One mention of @Troyaagent, from the stream or the poll → the log entry (or null when it is not ours to answer). */
async function handleMention(t, { users, media, bot, m, L }) {
  if (!t?.id || handled.has(t.id)) return null;
  handled.add(t.id);
  if (handled.size > 3000) handled.delete(handled.values().next().value);
  if (t.author_id === bot.id || (t.referenced_tweets || []).some((x) => x.type === "retweeted")) return null;
  const log = await store.readJson("x-log.json", []);
  if (log.some((x) => x.id === t.id)) return null;                        // answered before a restart
  const u = users.get(t.author_id) || {};
  const text = String(t.text || "").replace(/(^|\s)@\w+/g, " ").replace(/\s+/g, " ").trim();
  const recent = log.filter((x) => x.authorId === t.author_id && Date.now() - x.at < 6 * 3600_000).length;
  const entry = { id: t.id, at: Date.now(), authorId: t.author_id, author: u.username || null, text: text.slice(0, 400), status: "skipped", reply: null };
  // V6 F26: a launch request is answered by launch.mjs with a fixed text, never by the model
  const photo = (t.attachments?.media_keys || []).map((k) => media.get(k)).find((x) => x?.type === "photo" && x.url);
  const lx = L ? await L.fromX({ tweetId: t.id, authorId: t.author_id, text: t.text, mediaUrl: photo?.url || null }).catch((e) => ({ reply: null, error: e.message })) : null;
  if (lx) {
    entry.kind = "launch"; entry.token = lx.launch?.token || null; entry.why = lx.error || null;
    if (lx.reply) {
      entry.reply = lx.reply;
      if (await spend("posts")) {
        const p = await xApi("/2/tweets", { token: bot.access, method: "POST", body: { text: lx.reply, reply: { in_reply_to_tweet_id: t.id } } }).catch((e) => { entry.why = e.message; return null; });
        entry.status = p?.data?.id ? "posted" : "failed"; entry.replyId = p?.data?.id || null;
      } else { entry.status = "draft"; entry.why = "daily post cap reached"; }
    }
    return entry;
  }
  if (m === "off") entry.why = "AI replies are off";
  else if (!text || text.length < 3) entry.why = "nothing to answer";
  else if (recent >= 3) entry.why = "3 answers to this account in 6 hours";
  else {
    const reply = await compose(u.username || "someone", text).catch((e) => { entry.why = e.message; return null; });
    if (reply) {
      entry.reply = reply;
      if (m === "live" && (await spend("posts"))) {
        const p = await xApi("/2/tweets", { token: bot.access, method: "POST", body: { text: reply, reply: { in_reply_to_tweet_id: t.id } } }).catch((e) => { entry.why = e.message; return null; });
        entry.status = p?.data?.id ? "posted" : "failed"; entry.replyId = p?.data?.id || null;
      } else { entry.status = "draft"; if (m === "live") entry.why = "daily post cap reached"; }
    }
  }
  return entry;
}
const listening = async () => (await mode()) !== "off" || (await import("./launch.mjs").then((x) => x.xLaunchOn()).catch(() => false));

async function poll() {
  if (polling || !on()) return;
  // with the stream connected, mentions arrive as they are posted; the poll only sweeps every 10 minutes as a safety net
  // (it reads from the newest post the stream saw, so normally nothing comes back and nothing is billed)
  if (streamHealthy() && Date.now() - lastPollAt < 10 * 60_000) return;
  polling = true;
  try {
    const m = await mode();
    if (!(await listening())) return;                                       // AI replies off and Launch on X off: nothing to read
    const bot = await botTokens().catch((e) => { console.warn("[x] bot token:", e.message); return null; });
    if (!bot) return;
    const st = await store.readJson("x-state.json", {});
    if ((await left("reads")) < 10) return;                                // room for a full page of mentions
    const q = new URLSearchParams({ max_results: "10", ...FIELDS });
    if (st.sinceId) q.set("since_id", st.sinceId);
    lastPollAt = Date.now();
    const r = await xApi(`/2/users/${bot.id}/mentions?${q}`, { token: bot.access });
    await spend("reads", Math.max(1, (r.data || []).length));                // counted by the posts X returned
    const tweets = (r.data || []).slice().reverse();
    const users = new Map((r.includes?.users || []).map((u) => [u.id, u]));
    const media = new Map((r.includes?.media || []).map((x) => [x.media_key, x]));
    const L = await import("./launch.mjs").catch(() => null);
    const newest = r.meta?.newest_id || st.sinceId || null;
    // the first look only marks where to start: no replies to an old backlog
    if (!st.sinceId) { await store.update("x-state.json", {}, (s) => ({ ...s, sinceId: newest, lastPoll: Date.now() })); return; }
    const log = [];
    for (const t of tweets) { const e = await handleMention(t, { users, media, bot, m, L }); if (e) log.push(e); }
    if (log.length) await store.update("x-log.json", [], (l) => [...l, ...log].slice(-300));
    await store.update("x-state.json", {}, (s) => ({ ...s, sinceId: newest && (!s.sinceId || BigInt(newest) > BigInt(s.sinceId)) ? newest : s.sinceId, lastPoll: Date.now() }));
  } catch (e) {
    console.warn("[x] poll:", e.message);
    await store.update("x-state.json", {}, (s) => ({ ...s, lastError: String(e.message).slice(0, 200), lastPoll: Date.now() })).catch(() => {});
  } finally { polling = false; }
}

/* ---------- the filtered stream: X pushes each mention as it is posted (pay-per-use: billed per post delivered) ---------- */
const stream = { alive: false, lastBeat: 0, connectedAt: 0, retries: 0, error: null, posts: 0, pausedUntil: 0 };
const streamHealthy = () => stream.alive && Date.now() - stream.lastBeat < 75_000;
const streamWanted = () => on() && !!process.env.X_BEARER_TOKEN && process.env.X_STREAM !== "0" && process.env.X_POLL !== "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function appApi(path, { method = "GET", body } = {}) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`X answered ${r.status}: ${j?.detail || j?.title || j?.errors?.[0]?.message || "error"}`), { status: r.status });
  return j;
}
async function ensureRule() {
  const value = `@${BOT_NAME} -is:retweet`;
  const r = await appApi("/2/tweets/search/stream/rules");
  if ((r.data || []).some((x) => x.value === value)) return;
  await appApi("/2/tweets/search/stream/rules", { method: "POST", body: { add: [{ value, tag: "troya-mentions" }] } });
}
let queue = Promise.resolve();
async function onStreamPost(j) {
  const t = j.data;
  stream.posts++;
  await spend("reads", 1);
  const bot = await botTokens().catch(() => null);
  if (!bot) return;
  const users = new Map((j.includes?.users || []).map((u) => [u.id, u]));
  const media = new Map((j.includes?.media || []).map((x) => [x.media_key, x]));
  const L = await import("./launch.mjs").catch(() => null);
  const entry = await handleMention(t, { users, media, bot, m: await mode(), L });
  if (entry) await store.update("x-log.json", [], (l) => [...l, entry].slice(-300));
  // if the stream drops, the poll resumes right after the newest post the stream saw
  await store.update("x-state.json", {}, (s) => ({ ...s, sinceId: !s.sinceId || BigInt(t.id) > BigInt(s.sinceId) ? t.id : s.sinceId, lastStream: Date.now() }));
}
async function runStream() {
  while (streamWanted()) {
    if (Date.now() < stream.pausedUntil || !(await listening())) { await sleep(60_000); continue; }
    try {
      await ensureRule();
      const ctrl = new AbortController();
      const res = await fetch(`${API}/2/tweets/search/stream?${new URLSearchParams(FIELDS)}`, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }, signal: ctrl.signal });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(`stream ${res.status}: ${j?.detail || j?.title || j?.errors?.[0]?.message || "refused"}`), { status: res.status }); }
      Object.assign(stream, { alive: true, lastBeat: Date.now(), connectedAt: Date.now(), retries: 0, error: null });
      console.log("[x] stream connected: mentions arrive as they are posted");
      const watchdog = setInterval(() => { if (Date.now() - stream.lastBeat > 75_000) ctrl.abort(); }, 15_000);   // X sends a heartbeat every ~20 s
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          stream.lastBeat = Date.now();
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\r\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (!line) continue;                                             // heartbeat
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            if (j.data) queue = queue.then(() => onStreamPost(j)).catch((e) => console.warn("[x] stream post:", e.message));
          }
        }
      } finally { clearInterval(watchdog); stream.alive = false; }
      throw new Error("the stream closed");
    } catch (e) {
      stream.alive = false; stream.retries++;
      stream.error = String(e.message || e).slice(0, 200);
      // not allowed on this X plan (403): stop trying for an hour, the poll keeps answering every minute
      if (e.status === 403 || e.status === 401) { stream.pausedUntil = Date.now() + 3600_000; console.warn("[x] stream unavailable:", stream.error, "· polling every minute instead"); continue; }
      const wait = e.status === 429 ? 60_000 * Math.min(15, stream.retries) : Math.min(300_000, 5_000 * 2 ** Math.min(6, stream.retries));
      console.warn("[x] stream:", stream.error, `· reconnecting in ${Math.round(wait / 1000)} s (the poll covers the gap)`);
      await sleep(wait);
    }
  }
}
/** A reply the team wrote (not composed by the model), posted as @Troyaagent inside the daily X budget and logged. */
export async function postReply(text, inReplyTo) {
  const bot = await botTokens();
  if (!bot?.access) throw new Error("Troya is not connected to X.");
  if (!(await spend("posts"))) throw new Error("Today's X post cap is reached.");
  const p = await xApi("/2/tweets", { token: bot.access, method: "POST", body: { text: String(text), reply: { in_reply_to_tweet_id: String(inReplyTo) } } });
  const id = p?.data?.id || null;
  await store.update("x-log.json", [], (l) => [...l, { id: String(inReplyTo), at: Date.now(), author: "(team reply)", text: "", status: id ? "posted" : "failed", reply: String(text), replyId: id, manual: true }].slice(-300));
  return id;
}
/** A post the team wrote (an approved update, not composed by the model), posted as @Troyaagent inside the daily X budget and logged. */
export async function postTweet(text) {
  const bot = await botTokens();
  if (!bot?.access) throw new Error("Troya is not connected to X.");
  if (!(await spend("posts"))) throw new Error("Today's X post cap is reached.");
  const p = await xApi("/2/tweets", { token: bot.access, method: "POST", body: { text: String(text) } });
  const id = p?.data?.id || p?.id || null;      // X accepted it (xApi throws otherwise), even when no id comes back
  await store.update("x-log.json", [], (l) => [...l, { id: id || "post", at: Date.now(), author: "(team post)", text: "", status: "posted", reply: String(text), replyId: id, manual: true }].slice(-300));
  return id;
}
async function compose(name, text) {
  const llm = await import("./llm.mjs");
  if (!llm.llmOn() || !(await llm.underCap())) throw new Error("the AI is off or over its daily cap");
  const tg = await import("./tgbot.mjs");
  const system = `${tg.TG_SYSTEM}

NOW YOU ARE ON X, not Telegram: you are replying publicly as @Troyaagent to a post that mentions you. Rules on X: answer in the language of the post (English if unsure); one short reply, at most 260 characters; no hashtags, no emojis, no markdown, never tag anyone; the only links you may give are troya.codes pages, t.me/troyaagent and x.com/Troyaagent; live numbers only from tools; never predict prices or tell anyone to buy or sell; if the post is spam, a scam, an insult or has nothing to answer, reply with exactly SKIP. Current time: ${new Date().toISOString().slice(0, 16)} UTC.`;
  const out = await llm.chatWithTools({ system, history: [], user: `${String(name).slice(0, 30)} on X: <untrusted>${text.slice(0, 500)}</untrusted>`, tools: tg.TG_TOOLS, exec: tg.tgExec, maxSteps: 3 });
  const s = tidy(out);
  if (!s || /^SKIP\b/i.test(s)) throw new Error("nothing worth answering");
  return s;
}

/* ---------- routes ---------- */
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
export async function handleOf(address) { const m = await store.readJson("x-links.json", {}); const v = m[lc(address)]; return v ? { username: v.username, name: v.name, avatar: v.avatar } : null; }

export async function register(r, ctx) {
  store = ctx.store; dataDir = ctx.dataDir;
  key = await loadKey();
  r.get("/api/x/login", ({ req, res, query }) => login(req, res, query.for === "bot" ? "bot" : "link", query.back), { perMin: 20 });
  r.get("/api/x/callback", ({ res, query }) => callback(query, res), { perMin: 20 });
  r.get("/api/x/me", async ({ req }) => ({ configured: on(), x: await handleOf(requireSession(req).address) }));
  r.post("/api/x/unlink", async ({ req }) => { const a = lc(requireSession(req).address); await store.update("x-links.json", {}, (m) => { delete m[a]; return m; }); return { ok: true }; });
  r.get("/api/x/handle", async ({ query }) => { if (!isAddress(String(query.address || ""))) throw new HttpError(400, "Bad address."); return { address: getAddress(query.address), x: await handleOf(query.address) }; });
  r.get("/api/x/status", async ({ req }) => {
    const b = await store.readJson("x-bot.json", null), st = await store.readJson("x-state.json", {});
    const log = await store.readJson("x-log.json", []);
    return { configured: on(), bot: b ? { username: b.username, connectedAt: b.connectedAt } : null, expected: BOT_NAME, mode: await mode(), pollEveryMin: POLL_MIN, lastPoll: st.lastPoll || null, lastError: st.lastError || null,
      stream: { wanted: streamWanted(), live: streamHealthy(), connectedAt: stream.connectedAt || null, posts: stream.posts, error: stream.error, lastStream: st.lastStream || null },
      usage: await usage(), caps: CAPS, posted: log.filter((x) => x.status === "posted").slice(-10).reverse().map((x) => ({ at: x.at, author: x.author, replyId: x.replyId })), admin: isAdmin(req) };
  });
  r.get("/api/x/log", async ({ req }) => { if (!isAdmin(req)) throw new HttpError(403, "Admins only."); return { log: (await store.readJson("x-log.json", [])).slice(-100).reverse() }; });
  r.post("/api/x/mode", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const m = String(body?.mode || "");
    if (!["off", "draft", "live"].includes(m)) throw new HttpError(400, "Mode must be off, draft or live.");
    await store.update("x-state.json", {}, (s) => ({ ...s, mode: m, modeBy: requireSession(req).address, modeAt: Date.now() }));
    return { ok: true, mode: m };
  });
  r.post("/api/x/launch", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const v = String(body?.launch || "");
    if (!["off", "test", "live"].includes(v)) throw new HttpError(400, "Launch on X must be off, test or live.");
    await store.update("x-state.json", {}, (s) => ({ ...s, launch: v, launchBy: requireSession(req).address, launchAt: Date.now() }));
    return { ok: true, launch: v };
  });
  r.post("/api/x/poll", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    await poll();
    const st = await store.readJson("x-state.json", {});
    return { ok: true, lastPoll: st.lastPoll || null, lastError: st.lastError || null, started: !!st.sinceId };
  }, { perMin: 6 });
  if (on() && process.env.X_POLL !== "0") { setTimeout(() => poll().catch(() => {}), 60_000).unref?.(); setInterval(() => poll().catch(() => {}), POLL_MIN * 60_000).unref?.(); }
  if (streamWanted()) setTimeout(() => runStream().catch((e) => console.warn("[x] stream stopped:", e.message)), 5_000).unref?.();
}
