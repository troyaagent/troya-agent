// Sentry Autopilot's optional extra rules (server/autopilot-rules.mjs): X check, site up, dev didn't sell early, buy in USD.
// X, the dev-side read, the site and the ETH price are mocked; the X API is never called for real (every api.x.com request
// is answered here). Part D buys in PRACTICE mode only, with real on-chain quotes (nothing is sent, no money moves).
//   node tools/autopilot-rules-test.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const data = mkdtempSync(join(tmpdir(), "troya-ap-rules-"));
Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", OPENROUTER_API_KEY: "", TG_TRADE: "1", TROYA_WATCHES: "0", AUTOPILOT: "0", AUTOPILOT_LIVE: "", TROYA_NO_BROADCAST: "1",
  AUTOPILOT_X_DAILY: "5", X_DAILY_USERS: "8", X_DAILY_READS: "12", X_BEARER_TOKEN: "test-only-not-a-token", X_CLIENT_ID: "", X_CLIENT_SECRET: "", X_POLL: "0", X_STREAM: "0" });

// every X API request is answered by this mock (a real one would be a bug)
const X = { users: {}, tweets: {}, calls: [], methods: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url instanceof URL ? url.href : url);
  if (!u.startsWith("https://api.x.com")) return realFetch(url, opts);
  X.calls.push(u); X.methods.push(String(opts?.method || "GET"));
  const json = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  let m = /\/2\/users\/by\/username\/([A-Za-z0-9_]+)/.exec(u);
  if (m) { const x = X.users[m[1].toLowerCase()]; return x ? json(x) : json({ errors: [{ detail: "Could not find user" }] }); }
  m = /\/2\/users\/(\d+)\/tweets/.exec(u);
  if (m) return json({ data: X.tweets[m[1]] || [] });
  return json({ title: "not mocked" }, 404);
};

const root = join(import.meta.dirname, "..");
const { initApi, handleApi } = await import(join(root, "server/api.mjs"));
await initApi({ dataDir: data, root });
const ap = await import(join(root, "server/autopilot.mjs"));
const R = await import(join(root, "server/autopilot-rules.mjs"));
const xs = await import(join(root, "server/xsocial.mjs"));
const { Wallet } = await import("ethers");

let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
const dms = []; ap.useSender(async (m, p) => { dms.push(p); return { ok: true }; });

/* ---------- mocks for the rules ---------- */
let NOW = Date.now();
const COIN = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";        // $TROYA: real quotes in part D
const COIN2 = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const M = { profiles: {}, dev: {}, devCalls: [], xCalls: [], site: {}, siteCalls: 0, px: 3000 };
const E18 = 10n ** 18n;
function devReport(token, { bornAt, at, sells = [], got = 1000n * E18, status = "pass", linked = 2, partial = false } = {}) {
  return { token, status, bornAt, at, linked: { count: linked }, coverage: { partial }, _set: { sells, got } };
}
R._setDeps({
  now: () => NOW,
  profile: async (t) => M.profiles[t.toLowerCase()] ?? null,
  devLinks: async (t, o) => { M.devCalls.push({ t, fresh: !!o?.fresh }); const v = M.dev[t.toLowerCase()]; return typeof v === "function" ? v(o) : v; },
  xAccount: async (h, needle) => { M.xCalls.push(h); return xs.accountCheck(h, needle); },        // the real reader, on the mocked X API
  site: async (u) => { M.siteCalls++; return M.site[u] || { ok: false, why: "unreachable" }; },
  ethUsd: async () => { if (M.px == null) throw new Error("no price"); return M.px; },
  pons: async () => ({ raised: 3, graduated: false, pair: { address: "native", symbol: "ETH" } }),
});
const xUser = (handle, { id = String(1000 + Object.keys(X.users).length), verified = true, type = "blue", bio = "", pinned = null, protectedAcc = false } = {}) => {
  X.users[handle.toLowerCase()] = { data: { id, username: handle, verified, verified_type: type, description: bio, protected: protectedAcc, ...(pinned ? { pinned_tweet_id: "p" + id } : {}) }, ...(pinned ? { includes: { tweets: [{ id: "p" + id, text: pinned }] } } : {}) };
  return id;
};
const r0 = (token = COIN, ageMs = 95_000) => ({ v: "passed", token, symbol: "TEST", at: NOW, ageMs, pons: { raised: 3, graduated: false, pair: { address: "native", symbol: "ETH" } } });
const rules = (x) => ap.cleanRules(x);

console.log("A · rules are off by default, and the words for them");
const d = ap.cleanRules({});
ok(!d.xCheck && !d.siteUp && !d.devEarly && d.buyUsd === 0 && d.devEarlyMin === 1 && d.devEarlyPct === 0 && !R.anyCheck(d), "a user with no extra rules: X check, site up and dev rule all off, buy in ETH");
ok(JSON.stringify(ap.parseRules("buy Pons launches that pass the Gate above 1 ETH raised, 0.01 ETH each, take profit at 2x, stop at -30%")) === JSON.stringify({ minRaisedEth: 1, buyEth: 0.01, takeProfitX: 2, stopPct: 30 }), "the plain-words rules read exactly as before");
const p1 = ap.parseRules("set xcheck on site on devsell 2 min 10% buy $10 tp 3 sl 25");
ok(p1.xCheck === true && p1.siteUp === true && p1.devEarly === true && p1.devEarlyMin === 2 && p1.devEarlyPct === 10 && p1.buyUsd === 10 && p1.takeProfitX === 3 && p1.stopPct === 25 && p1.minRaisedEth == null && p1.buyEth == null,
  "/autopilot set xcheck on site on devsell 2 min 10% buy $10 tp 3 sl 25", "(\"2 min\" is not a 2 ETH minimum, $10 is not 10 ETH)");
ok(ap.parseRules("buy 10 usd").buyUsd === 10 && ap.parseRules("buy 10 usd").buyEth == null, "buy 10 usd → $10, never 10 ETH");
ok(ap.parseRules("devsell off usd off").devEarly === false && ap.parseRules("devsell off usd off").buyUsd === 0, "devsell off · usd off");
const c1 = ap.cleanRules({ devEarlyMin: 99, devEarlyPct: -4, buyUsd: 5000, xCheck: "true" });
ok(c1.devEarlyMin === 15 && c1.devEarlyPct === 0 && c1.buyUsd === 1000 && c1.xCheck === true, "limits: dev window 1 to 15 min, 0 to 100 %, $1 to $1,000");

console.log("B · dev didn't sell early (mocked dev-side read)");
const born = NOW - 95_000;
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: born, at: NOW - 2_000 });
let ev = await R.evaluate(r0(), rules({ devEarly: true }), { born });
ok(ev.verdict === "pass" && ev.checks[0].status === "pass" && /No sale by the dev side in the first 1 min/.test(ev.checks[0].detail), "no sale in the first minute → pass", ev.checks[0].detail);
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: born, at: NOW - 2_000, sells: [{ at: born + 40_000, v: 5n * E18, dev: true }] });
ev = await R.evaluate(r0(), rules({ devEarly: true }), { born });
ok(ev.verdict === "fail" && /The dev sold 0.50% of what the dev side got within the first 1 min/.test(ev.checks[0].detail), "the dev sold 0.5 % at 40 s, limit 0 (any sale) → fail", ev.checks[0].detail);
ev = await R.evaluate(r0(), rules({ devEarly: true, devEarlyPct: 1 }), { born });
ok(ev.verdict === "pass", "the same sale with a 1 % limit → pass", ev.checks[0].detail);
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: born, at: NOW - 2_000, sells: [{ at: born + 30_000, v: 200n * E18, dev: false }, { at: born + 80_000, v: 500n * E18, dev: true }] });
ev = await R.evaluate(r0(), rules({ devEarly: true, devEarlyPct: 10 }), { born });
ok(ev.verdict === "fail" && /Wallets tied to the dev sold 20.0%/.test(ev.checks[0].detail), "a linked wallet sold 20 % at 30 s (the dev's own sale at 80 s is after the window), limit 10 % → fail", ev.checks[0].detail);
M.devCalls.length = 0;
ev = await R.evaluate(r0(COIN, 30_000), rules({ devEarly: true, xCheck: true }), { born: NOW - 30_000 });
ok(ev.verdict === "wait" && ev.waitUntil === NOW - 30_000 + 60_000 + 20_000 && M.devCalls.length === 0 && ev.checks.find((c) => c.key === "xCheck")?.status === "not-run", "seen 30 s after launch with a 1 min window → WAIT until 80 s (window + 20 s), nothing read, X not checked yet");
ev = await R.evaluate(r0(), rules({ devEarly: true, devEarlyMin: 5 }), { born });
ok(ev.verdict === "wait" && ev.waitUntil === born + 5 * 60_000 + 20_000, "a 5 min window seen at 95 s → wait until 5 min 20 s");
let freshAsked = false;
M.dev[COIN.toLowerCase()] = (o) => { if (o.fresh) { freshAsked = true; return devReport(COIN, { bornAt: born, at: NOW - 1_000 }); } return devReport(COIN, { bornAt: born, at: born + 45_000 }); };
ev = await R.evaluate(r0(), rules({ devEarly: true }), { born });
ok(ev.verdict === "pass" && freshAsked, "a cached report from before the window closed (45 s) is read again fresh");
M.dev[COIN.toLowerCase()] = { status: "running" };
ev = await R.evaluate(r0(), rules({ devEarly: true }), { born, attempt: 0 });
const ev2 = await R.evaluate(r0(), rules({ devEarly: true }), { born, attempt: 3 });
ok(ev.verdict === "wait" && ev2.verdict === "fail" && /could not be read in time/.test(ev2.checks[0].detail), "a read still running → wait and ask again; after 4 tries → fail closed");
M.dev[COIN.toLowerCase()] = { status: "unknown", reason: "RPC down" };
ev = await R.evaluate(r0(), rules({ devEarly: true }), { born });
ok(ev.verdict === "fail" && /could not be read \(RPC down\)/.test(ev.checks[0].detail), "the chain cannot be read → fail closed (no buy)");

console.log("C · X check and site up (mocked X API, real reader and real budget)");
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: born, at: NOW - 2_000 });
M.profiles[COIN.toLowerCase()] = { twitter: "https://x.com/goodcoin", website: "https://good.example" };
xUser("goodcoin", { bio: `Official. CA: ${COIN}` });
M.site["https://good.example"] = { ok: true, status: 200, host: "good.example", ms: 420 };
ev = await R.evaluate(r0(), rules({ xCheck: true, siteUp: true, devEarly: true }), { born });
ok(ev.verdict === "pass" && ev.checks.map((c) => c.status).join() === "pass,pass,pass" && /@goodcoin is verified \(blue\) and shows this coin's contract address in its bio/.test(ev.checks[2].detail), "verified, CA in the bio, site 200, no early sale → pass", ev.checks[2].detail);
M.xCalls.length = 0; X.calls.length = 0;
ev = await R.evaluate(r0(), rules({ xCheck: true }), { born });
ok(ev.verdict === "pass" && M.xCalls.length === 0 && X.calls.length === 0, "the same coin for another user: from the per-coin cache, no X read");

// pinned post, then a recent post
M.profiles[COIN2.toLowerCase()] = { twitter: "x.com/pinnedcoin/status/123", website: "" };
xUser("pinnedcoin", { bio: "no address here", pinned: `buy here ponsfamily.com/launchpad/${COIN2.toLowerCase()}` });
ev = await R.evaluate(r0(COIN2), rules({ xCheck: true }), {});
ok(ev.verdict === "pass" && /pinned post/.test(ev.checks[0].detail) && X.calls.every((u) => !/\/tweets/.test(u)), "CA in the pinned post (link given as a post URL) → pass with ONE user lookup, no post read");
const C3 = "0x3333333333333333333333333333333333333333";
M.profiles[C3] = { twitter: "@recentcoin" };
const rid = xUser("recentcoin", { bio: "soon" });
X.tweets[rid] = [{ id: "1", text: "gm" }, { id: "2", text: `we are live ${C3}` }];
X.calls.length = 0;
ev = await R.evaluate(r0(C3), rules({ xCheck: true }), {});
ok(ev.verdict === "pass" && /a recent post/.test(ev.checks[0].detail) && X.calls.length === 2, "CA only in a recent post → pass with one lookup + one read of the 5 newest posts");
const usage1 = JSON.parse(readFileSync(join(data, "x-usage.json"), "utf8"));
ok(usage1.users >= 3 && usage1.reads === 2, "X's daily budget counted (users per lookup, reads per post returned)", `users ${usage1.users}, reads ${usage1.reads}`);

// failures
const C4 = "0x4444444444444444444444444444444444444444";
M.profiles[C4] = { twitter: "https://x.com/plaincoin" };
xUser("plaincoin", { verified: false, type: "none", bio: `CA ${C4}` });
ev = await R.evaluate(r0(C4), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /has no verified badge/.test(ev.checks[0].detail), "no verified badge → fail", ev.checks[0].detail);
const C5 = "0x5555555555555555555555555555555555555555";
M.profiles[C5] = { twitter: "https://x.com/i/communities/1888" };
ev = await R.evaluate(r0(C5), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /not an account/.test(ev.checks[0].detail), "an X community link is not an account → fail");
M.profiles[C5] = { twitter: "" }; R._reset();
const xCallsBefore = X.calls.length;
ev = await R.evaluate(r0(C5, 10), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /lists no X account/.test(ev.checks[0].detail) && X.calls.length === xCallsBefore, "no X link on Pons → fail, nothing read");
M.profiles[C5] = { twitter: "https://x.com/goodcoin" }; R._reset();      // another coin pointing at a verified account that does not show THIS coin's CA
xUser("goodcoin", { bio: `Official. CA: ${COIN}` });
ev = await R.evaluate(r0(C5), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /do not show this coin's contract address/.test(ev.checks[0].detail), "a verified account that shows ANOTHER coin's CA (a copycat listing the real project's X) → fail", ev.checks[0].detail);

// Autopilot's own share of the X budget (AUTOPILOT_X_DAILY=5 here): used up → fail closed, nothing read
const C6 = "0x6666666666666666666666666666666666666666";
M.profiles[C6] = { twitter: "https://x.com/sixcoin" };
xUser("sixcoin", { bio: `CA ${C6}` });
const bud = await R.xBudgetToday();
X.calls.length = 0;
ev = await R.evaluate(r0(C6), rules({ xCheck: true }), {});
ok(bud.used === 5 && ev.verdict === "fail" && /lookups for today are used up \(5 coins\)/.test(ev.checks[0].detail) && X.calls.length === 0, "Autopilot's X lookups used up (5 of 5) → FAIL CLOSED, no X call", ev.checks[0].detail);
// X's own users cap (X_DAILY_USERS=8): reached → fail closed
writeFileSync(join(data, "autopilot-x.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 0 }));
await xs.spend("users", 8 - JSON.parse(readFileSync(join(data, "x-usage.json"), "utf8")).users);
R._reset(); X.calls.length = 0;
ev = await R.evaluate(r0(C6), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /daily X lookups are used up/.test(ev.checks[0].detail) && X.calls.length === 0 && ev.checks[0].capped === "users", "X's daily users cap reached → FAIL CLOSED, no X call", ev.checks[0].detail);
// X's reads cap: the lookup happens, the CA is not in bio or pinned, no reads left → fail closed
const C7 = "0x7777777777777777777777777777777777777777";
M.profiles[C7] = { twitter: "https://x.com/sevencoin" };
xUser("sevencoin", { bio: "hello" });
writeFileSync(join(data, "x-usage.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), reads: 10, posts: 0, search: 0, users: 0 }));
R._reset(); X.calls.length = 0;
ev = await R.evaluate(r0(C7), rules({ xCheck: true }), {});
ok(ev.verdict === "fail" && /daily X reads are used up/.test(ev.checks[0].detail) && X.calls.length === 1, "CA not in bio/pinned and X reads used up → FAIL CLOSED after one lookup", ev.checks[0].detail);
// order: an early dev sale stops before any X spend
R._reset(); X.calls.length = 0;
M.dev[C7] = devReport(C7, { bornAt: born, at: NOW - 1000, sells: [{ at: born + 10_000, v: E18, dev: true }] });
ev = await R.evaluate(r0(C7), rules({ xCheck: true, devEarly: true }), { born });
ok(ev.verdict === "fail" && X.calls.length === 0 && ev.checks[1]?.status === "not-run", "the dev rule fails first → X is never read (no X budget spent)");
// site
const C8 = "0x8888888888888888888888888888888888888888";
M.profiles[C8] = { twitter: "", website: "https://down.example" };
M.site["https://down.example"] = { ok: false, status: 503, host: "down.example" };
ev = await R.evaluate(r0(C8), rules({ siteUp: true }), {});
ok(ev.verdict === "fail" && /answered 503, not 200/.test(ev.checks[0].detail), "site answers 503 → fail");
M.profiles[C8] = { website: "" };
R._reset();
ev = await R.evaluate(r0(C8), rules({ siteUp: true }), {});
ok(ev.verdict === "fail" && /lists no website/.test(ev.checks[0].detail), "no website on Pons → fail");
const sc = await R.siteCheck("http://127.0.0.1:9270/");
ok(!sc.ok && /not allowed/.test(sc.why), "the site check refuses private addresses (no requests into the server's own network)");
// USD
let z = await R.usdToEth(10, [0.001, 0.5]);
ok(z.ok && z.eth === 0.003333 && /\$10 = 0.003333 ETH at \$3000 per ETH/.test(z.check.detail), "$10 at $3,000 → 0.003333 ETH");
M.px = null; z = await R.usdToEth(10, [0.001, 0.5]); M.px = 3000;
ok(!z.ok && /could not be read/.test(z.check.detail), "no live ETH price → no buy");
M.px = 1000; z = await R.usdToEth(1000, [0.001, 0.5]); M.px = 3000;
ok(!z.ok && /outside the 0.001 to 0.5 ETH/.test(z.check.detail), "$1,000 at $1,000 = 1 ETH: over the 0.5 ETH a buy may be → skipped, not resized");

console.log("D · end to end through Sentry's onLaunch (PRACTICE only, real quotes, nothing sent)");
R._reset();
writeFileSync(join(data, "x-usage.json"), JSON.stringify({}));
writeFileSync(join(data, "autopilot-x.json"), JSON.stringify({}));
const plain = Wallet.createRandom().address.toLowerCase(), picky = Wallet.createRandom().address.toLowerCase(), usd = Wallet.createRandom().address.toLowerCase(), waiter = Wallet.createRandom().address.toLowerCase();
writeFileSync(join(data, "telegram.json"), JSON.stringify({ links: { [plain]: 1, [picky]: 2, [usd]: 3, [waiter]: 4 }, codes: {} }));
await ap.setUser(plain, { on: true, rules: { minRaisedEth: 1, buyEth: 0.01 } });
await ap.setUser(picky, { on: true, rules: { minRaisedEth: 1, buyEth: 0.01, xCheck: true } });
await ap.setUser(usd, { on: true, rules: { minRaisedEth: 1, buyUsd: 10, devEarly: true } });
await ap.setUser(waiter, { on: true, rules: { minRaisedEth: 1, buyEth: 0.002, devEarly: true, devEarlyMin: 3 } });
M.profiles[COIN.toLowerCase()] = { twitter: "https://x.com/copycat" };           // verified, but its CA is not this coin's
xUser("copycat", { bio: "the real one: 0x000000000000000000000000000000000000beef" });
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: NOW - 95_000, at: NOW - 1000 });
const lr = { ...r0(COIN), symbol: "TROYA", at: NOW, ageMs: 95_000 };
dms.length = 0;
const opened = await ap.onLaunch(lr);
const by = (a) => opened.find((p) => p.address === a);
ok(by(plain) && by(plain).mode === "practice" && by(plain).amountEth === 0.01 && !by(plain).checks, "no extra rules → bought exactly as before (0.01 ETH, practice)");
ok(!by(picky), "X check on, the coin's X does not show its CA → not bought");
ok(by(usd) && by(usd).amountEth === 0.003333 && by(usd).amountUsd === 10 && by(usd).ethUsd === 3000, "buy $10 → 0.003333 ETH at the live price (mocked $3,000), practice", by(usd) ? `${Math.round(by(usd).tokens).toLocaleString("en-US")} TROYA` : "");
ok(!by(waiter) && ap._waits.has(`${waiter}:${COIN.toLowerCase()}`), "a 3 min dev window seen at 95 s → waiting, not bought");
const act = await ap.activityOf(picky);
ok(act[0]?.outcome === "skipped" && act[0].checks[0].key === "xCheck" && act[0].checks[0].status === "fail", "the skip and its reason are in the activity", act[0]?.checks[0]?.detail);
ok(dms.some((m) => m.chat_id === 2 && /skipped \$TROYA/.test(m.text) && /FAIL · X check: @copycat is verified, but/.test(m.text)), "and in the DM");
ok(dms.some((m) => m.chat_id === 3 && /bought \$TROYA/.test(m.text) && /\(\$10 at \$3000 per ETH\)/.test(m.text) && /pass · Dev didn't sell early/.test(m.text)), "the buy DM shows the dollar size and each check");
ok(!dms.some((m) => m.chat_id === 1 && /pass ·|FAIL ·/.test(m.text)) && (await ap.activityOf(plain)).length === 0, "the plain user's DM and activity carry no extra lines");
await ap.onLaunch(lr);
ok((await ap.activityOf(picky)).length === 1 && dms.filter((m) => m.chat_id === 2).length === 1, "Sentry's re-check of the same coin: no second row, no second DM");
// the wait ends: the look after it reads the curve again and runs the rules again
NOW += 3 * 60_000;
M.dev[COIN.toLowerCase()] = devReport(COIN, { bornAt: NOW - 3 * 60_000 - 95_000, at: NOW - 1000, sells: [{ at: NOW - 3 * 60_000 - 95_000 + 150_000, v: E18, dev: true }] });
const later = await ap._lookAgainNow(waiter, COIN);
const wa = await ap.activityOf(waiter);
ok(later == null && wa[0]?.outcome === "skipped" && /within the first 3 min/.test(wa[0].checks[0].detail), "after the wait: the dev sold at 2.5 min (inside the 3 min window) → skipped", wa[0]?.checks[0]?.detail);

console.log("E · the web");
const srv = createServer(async (req, res) => { const url = new URL(req.url, "http://x"); if (!(await handleApi(req, res, url))) { res.statusCode = 404; res.end(); } }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
let cookie = "";
async function call(method, path, body) {
  const r = await realFetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc2 = r.headers.get("set-cookie"); if (sc2) cookie = sc2.split(";")[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${j.error || ""}`), { status: r.status }); return j;
}
const me = Wallet.createRandom();
const n = await call("POST", "/api/auth/nonce", { address: me.address });
await call("POST", "/api/auth/verify", { address: me.address, message: n.message, signature: await me.signMessage(n.message) });
let w = await call("GET", "/api/autopilot");
ok(w.settings.rules.xCheck === false && w.settings.rules.buyUsd === 0 && Array.isArray(w.activity) && w.limits.devEarlyMin[1] === 15 && w.xBudget.of === 5, "GET /api/autopilot: extra rules off for a new wallet, their limits, the activity and the X budget");
await call("POST", "/api/autopilot/settings", { rules: { xCheck: true, siteUp: true, devEarly: true, devEarlyMin: 2, devEarlyPct: 5, buyUsd: 10 } });
w = await call("GET", "/api/autopilot");
ok(w.settings.rules.xCheck && w.settings.rules.siteUp && w.settings.rules.devEarly && w.settings.rules.devEarlyMin === 2 && w.settings.rules.devEarlyPct === 5 && w.settings.rules.buyUsd === 10 && w.settings.rules.buyEth === 0.01 && w.settings.mode === "practice", "saved from the web; the ETH amount and practice mode untouched");
const st = await ap.statusText(me.address);
ok(/\$10 each \(in ETH at the live price\)/.test(st) && /Extra rules: skip if the dev side sold more than 5% of what it got in the first 2 min; the coin's website must answer; its X account must be verified and show the CA/.test(st), "/autopilot status lists them");
await ap.command(me.address, "set buy 0.02");
w = await call("GET", "/api/autopilot");
ok(w.settings.rules.buyEth === 0.02 && w.settings.rules.buyUsd === 0 && w.settings.rules.xCheck === true, "/autopilot set buy 0.02 switches back to the ETH amount, other rules kept");
await ap.command(me.address, "xcheck off site off devsell off");
w = await call("GET", "/api/autopilot");
ok(!w.settings.rules.xCheck && !w.settings.rules.siteUp && !w.settings.rules.devEarly, "/autopilot xcheck off site off devsell off");
const plainStatus = await ap.statusText(me.address);
ok(!/Extra rules/.test(plainStatus) && /0.02 ETH each/.test(plainStatus), "with them off, the status reads as before");
const live = await call("POST", "/api/autopilot/settings", { mode: "live" }).catch((e) => e);
ok(live.status === 400, "live mode is still refused here (AUTOPILOT_LIVE is off)");
ok(X.methods.every((m) => m === "GET") && X.calls.filter((u) => /\/2\/users\//.test(u)).length > 0, "every X request went to the mock, and all were reads (nothing posted)");

console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
process.exit(fail ? 1 : 0);
