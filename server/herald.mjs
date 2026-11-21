// V8 F42 Herald: Agamemnon's heralds carried his word to every camp. Referral links, the weekly Arena Cup and the
// contributor board. Share cards are drawn in the browser (public/agent/js/sharecard.js), with the sharer's link on them.
// No money moves in this module and there is no payout code: an "earned (pending)" figure shows only when the owner sets
// HERALD_REF_BPS, and Cup prizes show only when HERALD_CUP_PRIZE is set (display text).
//
// What counts for a referral: what a referred wallet does on Troya after it joined through the link. Troya adds no swap
// fee, so its revenue today is launches through Troya (0.1% of volume through the TroyaFeeSplitter, non-holder launches)
// and Gate sales (x402 calls, Gate API deposits). Counts come from files Troya already writes (launches.json, x402.json,
// gateapi.json, journal.jsonl); nothing hooks into a money path.
//
//   GET  /api/herald/me                     session: your code, your link, what the wallets you brought did, rewards
//   POST /api/herald/attach   { code }      session: the link you came from (first one wins, never your own)
//   GET  /api/herald/leaderboard            public: top referrers by referred wallets that did something on Troya
//   GET  /api/herald/cup[?week=prev]        public: the weekly Arena Cup, user strategies ranked by paper PnL %
//   GET  /api/herald/bounties               public: the contributor board (admins also get the submissions)
//   POST /api/herald/bounties               admin: { id?, title, detail, reward, kind, status } add, edit or close
//   POST /api/herald/bounties/:id/submit    session: { link, note } work for a bounty, stored for the admins
//   POST /api/herald/submissions/:id        admin: { status, note }
import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";

const FILE = "herald.json";
const SITE = "https://troya.codes";
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";           // no 0/o, 1/l/i
const CODE_RE = /^[a-z0-9]{4,12}$/;
const WEEK = 7 * 86_400_000;
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
const refBps = () => { const v = Math.round(Number(process.env.HERALD_REF_BPS)); return v > 0 && v <= 10_000 ? v : 0; };
const cupPrize = () => clean(process.env.HERALD_CUP_PRIZE, 200) || null;
// owner, 20 Nov 2026: referral rewards count for HERALD_REF_DAYS after a wallet joins; all rewards together are capped at
// HERALD_FEE_CAP_PCT of the week's creator-fee income (payouts scale down when fees are lower)
const refDays = () => { const v = Math.round(Number(process.env.HERALD_REF_DAYS)); return v > 0 ? v : 0; };
const feeCapPct = () => { const v = Number(process.env.HERALD_FEE_CAP_PCT); return v > 0 && v <= 100 ? v : 0; };
const inWindow = (join, t) => Number(t) >= join && (!refDays() || Number(t) < join + refDays() * 86_400_000);
const linkOf = (code) => `${SITE}/agent?ref=${code}`;
// What the public API says while HERALD_REF_BPS or HERALD_CUP_PRIZE is unset: plain words for visitors, never who has to
// switch it on (display text only; the reward and payout figures above and in payouts.mjs do not read these)
const REWARDS_OFF = "Rewards are not live yet. We will announce them on X and Telegram.";
const PRIZES_OFF = "Prizes open soon.";

/* ---------- the contributor board: seeded with work the project needs; amounts are set by the team later ---------- */
const KINDS = { code: "Code", guide: "Guide", video: "Video", translation: "Translation", bug: "Bug report" };
const B_STATUS = ["open", "review", "done", "closed"];
const S_STATUS = ["new", "seen", "accepted", "rejected"];
const SEED = [
  { id: "b-start-i18n", kind: "translation", title: "Translate the Start guide into Indonesian, Vietnamese or Spanish",
    detail: "Translate the \"Start in 60 seconds\" guide (#/start) into one of these languages. Keep the meaning and the plain tone. One language per submission, as a document or a pull request." },
  { id: "b-x-launch-video", kind: "video", title: "Video: launch a coin from X in 60 seconds",
    detail: "A screen recording of 60 seconds or less: post to @Troyaagent on X, the coin goes live, open its page on Troya. English captions or voice. Link the video file or the post." },
  { id: "b-wartable-bug", kind: "bug", title: "Bug report with steps to reproduce in the War Table",
    detail: "Something wrong on a coin page: labels, early buyers, trades or chart marks. Send the coin address, the steps, what you expected and what you saw. Screenshots help." },
  { id: "b-watchfire-guide", kind: "guide", title: "Guide: reading a Watchfire alert",
    detail: "A short written guide to the four Watchfire levels (Calm, Watch, Selling fast, Fire), each with a real coin page as the example, and what a trader can check next." },
  { id: "b-tg-gate-plugin", kind: "code", title: "Plugin: Troya Gate verdict in a Telegram group bot",
    detail: "A small open-source bot or plugin that answers a coin address posted in a Telegram group with its Troya Gate verdict, using the public Gate API (troya.codes/api-and-mcp). MIT license, a README and a short demo." },
].map((b) => ({ ...b, reward: "Set by the team", status: "open", at: Date.parse("2026-11-20T00:00:00Z") }));
const DEF = { users: {}, codes: {}, refs: {}, bounties: SEED, submissions: [] };

let store = null;

/* ---------- referral codes ---------- */
async function codeFor(address) {
  const a = lc(address);
  const d = await store.readJson(FILE, DEF);
  if (d.users?.[a]?.code) return d.users[a].code;
  let code = null;
  await store.update(FILE, DEF, (x) => {
    x.users ||= {}; x.codes ||= {};
    if (x.users[a]?.code) { code = x.users[a].code; return x; }
    for (let n = 6; !code; n++) {
      for (let t = 0; t < 20 && !code; t++) {
        const c = [...randomBytes(n)].map((b) => ALPHA[b % ALPHA.length]).join("");
        if (!x.codes[c]) code = c;
      }
    }
    x.codes[code] = a;
    x.users[a] = { code, at: Date.now() };
    return x;
  });
  return code;
}

/* ---------- what referred wallets did after they joined ---------- */
// Agent Wallet trades are read from journal.jsonl a slice at a time (only the new bytes on each pass), so a long journal
// is read once per server start, then a few KB per pass.
const J = { pos: 0, trades: new Map() };
const TRADE_RE = /"kind":"agent-wallet\.(swap|perp|close)"/;
async function scanJournal() {
  const file = store.path("journal.jsonl");
  const st = await stat(file).catch(() => null);
  if (!st) return;
  if (st.size < J.pos) { J.pos = 0; J.trades.clear(); }      // rotated or truncated: start over
  if (st.size === J.pos) return;
  const len = Math.min(st.size - J.pos, 32 << 20);
  const buf = Buffer.alloc(len);
  const fh = await open(file, "r");
  try { await fh.read(buf, 0, len, J.pos); } finally { await fh.close(); }
  const end = buf.lastIndexOf(10);
  if (end < 0) return;
  J.pos += end + 1;
  const refs = (await store.readJson(FILE, DEF)).refs || {};
  for (const line of buf.toString("utf8", 0, end).split("\n")) {
    if (!TRADE_RE.test(line) || !line.includes('"status":"executed"')) continue;
    try {
      const r = JSON.parse(line), ref = refs[r.address];
      if (ref && inWindow(ref.at, r.t)) J.trades.set(r.address, (J.trades.get(r.address) || 0) + 1);
    } catch { /* a broken line is skipped */ }
  }
}

let memo = null;
async function activity() {
  if (memo && Date.now() - memo.at < 5 * 60_000) return memo.v;
  await scanJournal().catch((e) => console.warn("[herald] journal:", e.message));
  const d = await store.readJson(FILE, DEF);
  const refs = d.refs || {};
  const per = new Map();                                     // referred wallet → counts after its join
  const row = (a) => { let r = per.get(a); if (!r) per.set(a, (r = { launches: 0, feeLaunches: 0, trades: 0, gateCalls: 0, gateUsd: 0 })); return r; };
  const after = (a, t) => refs[a] && inWindow(refs[a].at, t);
  for (const l of await store.readJson("launches.json", [])) {
    const a = lc(l.owner);
    if (l.teamTest || !after(a, l.at)) continue;
    const r = row(a);
    r.launches++;
    if (l.split && l.troyaBps > 0) r.feeLaunches++;          // a launch that pays Troya 0.1% of its volume
  }
  const x402Price = Math.max(0.001, Number(process.env.X402_PRICE_USD || 0.01));
  for (const x of (await store.readJson("x402.json", {})).last || []) {
    const a = lc(x.payer);
    if (!after(a, x.at)) continue;
    const r = row(a);
    r.gateCalls++;
    if (x.network !== "eip155:84532") r.gateUsd += x402Price;  // Base Sepolia test payments are not revenue
  }
  for (const dep of Object.values((await store.readJson("gateapi.json", {})).deposits || {})) {
    const a = lc(dep.from);
    if (!after(a, dep.at)) continue;
    row(a).gateUsd += Number(dep.usdg) || 0;                  // USDG is a dollar stablecoin
  }
  for (const [a, n] of J.trades) if (refs[a]) row(a).trades = n;
  // per referrer
  const by = new Map();
  for (const [a, ref] of Object.entries(refs)) {
    let s = by.get(ref.by);
    if (!s) by.set(ref.by, (s = { referred: 0, active: 0, launches: 0, feeLaunches: 0, trades: 0, gateCalls: 0, gateUsd: 0, wallets: [] }));
    const r = per.get(a) || { launches: 0, feeLaunches: 0, trades: 0, gateCalls: 0, gateUsd: 0 };
    const active = r.launches + r.trades + r.gateCalls > 0 || r.gateUsd > 0;
    s.referred++; if (active) s.active++;
    for (const k of ["launches", "feeLaunches", "trades", "gateCalls", "gateUsd"]) s[k] += r[k];
    s.wallets.push({ wallet: short(a), at: ref.at, active, launches: r.launches, trades: r.trades, gateCalls: r.gateCalls });
  }
  for (const s of by.values()) { s.gateUsd = +s.gateUsd.toFixed(4); s.wallets.sort((x, y) => y.at - x.at); }
  memo = { at: Date.now(), v: { by, total: Object.keys(refs).length } };
  return memo.v;
}

function rewards(s) {
  const bps = refBps();
  if (!bps) return { on: false, text: REWARDS_OFF };
  const days = refDays(), cap = feeCapPct();
  return { on: true, bps, days: days || null, capPct: cap || null, pendingUsd: +(((s?.gateUsd || 0) * bps) / 10_000).toFixed(4), paidIn: "ETH",
    text: `${bps / 100}% of what Troya earns from the wallets you brought${days ? `, for ${days} days after each one joins` : ""}, paid in ETH from Troya's fees.${cap ? ` All rewards together are capped at ${cap}% of the week's creator-fee income, so payouts scale down when fees are lower.` : ""} Shown as pending until the team pays it.`,
    covers: "Counts Gate sales (x402 calls and Gate API deposits) from the wallets you brought. Fees from their launches are not in this figure yet." };
}

/* ---------- the Arena Cup: Monday 00:00 UTC to the next Monday ---------- */
function weekOf(offset = 0) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)) - offset * WEEK;
  const thu = new Date(start + 3 * 86_400_000), y = thu.getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4), wk1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  return { start, end: start + WEEK, label: `${y}-W${String(1 + Math.floor((start - wk1) / WEEK)).padStart(2, "0")}` };
}
const cupMemo = new Map();
async function cup(offset, me) {
  const w = weekOf(offset);
  let base = cupMemo.get(w.label);
  if (!base || Date.now() - base.at > (offset ? 10 * 60_000 : 60_000)) {
    const d = await store.readJson("arena.json", {});
    const agents = d.agents || {};
    const per = new Map();
    for (const p of d.positions || []) {
      if (p.mode === "live" || p.status !== "closed" || !(p.closedAt >= w.start && p.closedAt < w.end) || !(p.amountEth > 0)) continue;
      let s = per.get(p.agent);
      if (!s) per.set(p.agent, (s = { closed: 0, wins: 0, staked: 0, pnl: 0 }));
      s.closed++; s.staked += p.amountEth; s.pnl += Number(p.pnlEth) || 0; if (p.pnlEth > 0) s.wins++;
    }
    const rowOf = (ag) => {
      const s = per.get(ag.id) || { closed: 0, wins: 0, staked: 0, pnl: 0 };
      return { id: ag.id, owner: ag.owner || null, name: ag.kind === "ai" ? ag.name : short(ag.owner || ""), model: ag.model || null, status: ag.status, closed: s.closed, wins: s.wins,
        pnlEth: +s.pnl.toFixed(5), pnlPct: s.staked ? +((s.pnl / s.staked) * 100).toFixed(2) : null };
    };
    const byPct = (a, b) => b.pnlPct - a.pnlPct || b.closed - a.closed;
    const users = Object.values(agents).filter((a) => a.kind !== "ai" && a.public !== false && a.owner).map(rowOf);
    base = { at: Date.now(),
      ranked: users.filter((r) => r.closed >= 3).sort(byPct).map((r, i) => ({ rank: i + 1, ...r })),
      running: users.filter((r) => r.closed > 0 && r.closed < 3).sort((a, b) => b.closed - a.closed),
      ai: Object.values(agents).filter((a) => a.kind === "ai").map(rowOf).sort((a, b) => (b.pnlPct ?? -1e9) - (a.pnlPct ?? -1e9)) };
    cupMemo.set(w.label, base);
    if (cupMemo.size > 8) cupMemo.delete(cupMemo.keys().next().value);
  }
  const pub = (r) => { const { owner, ...rest } = r; return { ...rest, mine: !!me && lc(owner) === me }; };
  const ranked = base.ranked.map(pub);
  return { name: "Arena Cup", season: w.label, start: w.start, end: w.end, final: offset > 0, endsIn: offset ? 0 : Math.max(0, w.end - Date.now()),
    rule: "User strategies on paper, ranked by PnL % over the week (profit divided by the ETH put in), not by volume. At least 3 closed trades. Trades count in the week they close.",
    prize: cupPrize() || PRIZES_OFF, prizeOn: !!cupPrize(),
    ranked: ranked.slice(0, 50), running: base.running.slice(0, 20).map(pub), ai: base.ai.map(pub), mine: ranked.find((r) => r.mine) || base.running.map(pub).find((r) => r.mine) || null,
    note: "Paper money at real prices, quoted on chain the moment a trade opens and closes. AI traders are shown for reference and are not in the Cup." };
}

/* ---------- submissions: a few per wallet per hour ---------- */
const recent = new Map();
function allow(key, max, windowMs) {
  const now = Date.now(), l = (recent.get(key) || []).filter((t) => now - t < windowMs);
  if (l.length >= max) { recent.set(key, l); return false; }
  l.push(now); recent.set(key, l);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return true;
}
const pubBounty = (b, subs) => ({ id: b.id, kind: b.kind, kindLabel: KINDS[b.kind] || b.kind, title: b.title, detail: b.detail, reward: b.reward || "Set by the team", status: b.status, at: b.at, updatedAt: b.updatedAt || null,
  submissions: subs.filter((s) => s.bounty === b.id).length });
const pubSub = (s, bounties) => ({ id: s.id, bounty: s.bounty, bountyTitle: bounties.find((b) => b.id === s.bounty)?.title || s.bounty, link: s.link, note: s.note, status: s.status, at: s.at, adminNote: s.adminNote || "" });

// For the automatic weekly payouts (server/payouts.mjs): last week's Cup with each strategy's owner wallet (one entry per
// wallet: its best strategy), and every referrer's rewards so far with the wallet they go to. Read-only, nothing is sent.
export async function payoutInputs() {
  const prev = await cup(1, null);
  const base = cupMemo.get(prev.season);
  const seen = new Set(), cupRows = [];
  for (const r of base?.ranked || []) { const o = lc(r.owner); if (!o || seen.has(o)) continue; seen.add(o); cupRows.push({ owner: o, strategy: r.id, pnlPct: r.pnlPct, closed: r.closed }); }
  const act = await activity();
  const refs = [...act.by.entries()].map(([by, s]) => ({ referrer: lc(by), ...rewards(s), referred: s.referred, active: s.active }));
  return { season: prev.season, start: prev.start, end: prev.end, cup: cupRows, referrals: refs, refBps: refBps(), refDays: refDays(), capPct: feeCapPct(), admins: admins() };
}

export async function register(r, ctx) {
  store = ctx.store;

  r.get("/api/herald/me", async ({ req }) => {
    const me = lc(requireSession(req).address);
    const code = await codeFor(me);
    const d = await store.readJson(FILE, DEF);
    const { by } = await activity();
    const s = by.get(me) || { referred: 0, active: 0, launches: 0, feeLaunches: 0, trades: 0, gateCalls: 0, gateUsd: 0, wallets: [] };
    const ref = d.refs?.[me];
    const ranked = [...by.entries()].filter(([, v]) => v.active > 0).sort((a, b) => b[1].active - a[1].active || b[1].referred - a[1].referred);
    const rank = ranked.findIndex(([a]) => a === me);
    return { code, link: linkOf(code), linkShort: `troya.codes/agent?ref=${code}`,
      referredBy: ref ? { wallet: short(ref.by), code: ref.code, at: ref.at } : null,
      stats: { referred: s.referred, active: s.active, launches: s.launches, feeLaunches: s.feeLaunches, trades: s.trades, gateCalls: s.gateCalls },
      wallets: s.wallets.slice(0, 30), rank: rank >= 0 ? rank + 1 : null, rewards: rewards(s),
      how: "A wallet counts once it signs in through your link. Only what it does after that counts: launches through Troya, Agent Wallet trades and Gate calls. Updated every few minutes." };
  }, { weight: 2, perMin: 30 });

  r.post("/api/herald/attach", async ({ req, body }) => {
    const me = lc(requireSession(req).address);
    const code = lc(clean(body?.code, 16));
    if (!CODE_RE.test(code)) throw new HttpError(400, "That is not a referral code.");
    let out = null;
    await store.update(FILE, DEF, (x) => {
      x.refs ||= {}; x.codes ||= {};
      const by = x.codes[code];
      if (!by) { out = { status: 404, error: "That referral code does not exist." }; return x; }
      if (x.refs[me]) { out = { ok: true, already: true, by: short(x.refs[me].by) }; return x; }   // the first link wins
      if (by === me) { out = { status: 400, error: "That is your own link." }; return x; }
      if (x.refs[by]?.by === me) { out = { status: 400, error: "That wallet joined through your link." }; return x; }
      x.refs[me] = { by, code, at: Date.now() };
      out = { ok: true, by: short(by) };
      return x;
    });
    if (out.status) throw new HttpError(out.status, out.error);
    if (!out.already) memo = null;
    return out;
  }, { weight: 2, perMin: 10 });

  r.get("/api/herald/leaderboard", async () => {
    const { by, total } = await activity();
    const rows = [...by.entries()].filter(([, s]) => s.referred > 0)
      .sort((a, b) => b[1].active - a[1].active || b[1].referred - a[1].referred || b[1].launches - a[1].launches)
      .slice(0, 25)
      .map(([a, s], i) => ({ rank: i + 1, referrer: short(a), active: s.active, referred: s.referred, launches: s.launches, trades: s.trades, gateCalls: s.gateCalls }));
    return { rows, totals: { referred: total, referrers: by.size, active: [...by.values()].reduce((n, s) => n + s.active, 0) },
      rule: "Ranked by referred wallets that did something on Troya after joining (a launch, an Agent Wallet trade or a Gate call), then by wallets referred.",
      rewards: refBps() ? `Referral rewards: ${refBps() / 100}% of what Troya earns from referred wallets, paid in ETH from fees.` : REWARDS_OFF, updatedAt: memo?.at || Date.now() };
  }, { weight: 1, perMin: 60 });

  r.get("/api/herald/cup", async ({ req, query }) => {
    const s = getSession(req);
    return cup(query.week === "prev" ? 1 : 0, s ? lc(s.address) : null);
  }, { weight: 1, perMin: 60 });

  r.get("/api/herald/bounties", async ({ req }) => {
    const d = await store.readJson(FILE, DEF);
    const bounties = d.bounties || SEED, subs = d.submissions || [];
    const order = { open: 0, review: 1, done: 2, closed: 3 };
    const out = { bounties: bounties.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.at - a.at).map((b) => pubBounty(b, subs)), kinds: KINDS, statuses: B_STATUS,
      rule: "Pays for real work: code, guides, videos, translations and bug reports with steps to reproduce. Never for posts, likes or follows. Rewards are set by the team for each accepted piece." };
    const s = getSession(req);
    if (s) out.mine = subs.filter((x) => x.by === lc(s.address)).slice(-20).reverse().map((x) => pubSub(x, bounties));
    if (isAdmin(req)) { out.admin = true; out.submissions = subs.slice(-200).reverse().map((x) => ({ ...pubSub(x, bounties), by: x.by })); out.submissionStatuses = S_STATUS; }
    return out;
  }, { weight: 1, perMin: 60 });

  r.post("/api/herald/bounties", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const who = lc(getSession(req)?.address);
    let out = null;
    await store.update(FILE, DEF, (x) => {
      x.bounties ||= structuredClone(SEED);
      const b = body?.id ? x.bounties.find((y) => y.id === String(body.id)) : null;
      if (body?.id && !b) return x;
      const patch = {};
      if (body?.title != null) patch.title = clean(body.title, 140);
      if (body?.detail != null) patch.detail = clean(body.detail, 1200);
      if (body?.reward != null) patch.reward = clean(body.reward, 80) || "Set by the team";
      if (KINDS[body?.kind]) patch.kind = body.kind;
      if (B_STATUS.includes(body?.status)) patch.status = body.status;
      if (b) { Object.assign(b, patch, { updatedAt: Date.now(), updatedBy: who }); out = b; return x; }
      if (!patch.title || patch.title.length < 4) return x;
      out = { id: `b-${randomBytes(4).toString("hex")}`, kind: patch.kind || "code", title: patch.title, detail: patch.detail || "", reward: patch.reward || "Set by the team", status: patch.status || "open", at: Date.now(), by: who };
      x.bounties.push(out);
      return x;
    });
    if (!out) throw new HttpError(body?.id ? 404 : 400, body?.id ? "No bounty with that id." : "A bounty needs a title (4 characters or more).");
    return { bounty: pubBounty(out, []) };
  }, { weight: 2, perMin: 30 });

  r.post("/api/herald/bounties/:id/submit", async ({ req, params, body }) => {
    const me = lc(requireSession(req).address);
    const link = clean(body?.link, 300), note = clean(body?.note, 1000);
    let u = null;
    try { u = new URL(link); } catch { /* checked below */ }
    if (!u || u.protocol !== "https:") throw new HttpError(400, "Add a link to the work that starts with https:// (a repo, a document, a video or a post that shows it).");
    if (!allow(`sub:${me}`, 5, 3600_000)) throw new HttpError(429, "That is five submissions in an hour. Try again later.");
    let out = null, title = "";
    await store.update(FILE, DEF, (x) => {
      x.bounties ||= structuredClone(SEED); x.submissions ||= [];
      const b = x.bounties.find((y) => y.id === params.id);
      if (!b) { out = { status: 404, error: "No bounty with that id." }; return x; }
      if (b.status !== "open") { out = { status: 400, error: "This bounty is not open for submissions." }; return x; }
      if (x.submissions.some((s) => s.bounty === b.id && s.by === me && s.link === link)) { out = { status: 400, error: "You already sent this link for this bounty." }; return x; }
      title = b.title;
      const s = { id: randomBytes(4).toString("hex"), bounty: b.id, by: me, link, note, status: "new", at: Date.now() };
      x.submissions.push(s);
      if (x.submissions.length > 3000) x.submissions.splice(0, x.submissions.length - 3000);
      out = { ok: true, id: s.id };
      return x;
    });
    if (out.status) throw new HttpError(out.status, out.error);
    // the admins' linked Telegram chats (the same ones that get community reports); never a public chat
    import("./community.mjs").then((m) => m.notifyAdmins(`<b>Herald: new bounty submission</b>\n${title.replace(/[&<>]/g, "")}\nFrom ${short(me)}\n${link.replace(/[&<>]/g, "")}\n\nReview: troya.codes/agent#/herald`)).catch(() => {});
    return { ...out, message: "Sent. The team reviews every submission; you can follow its status here." };
  }, { weight: 3, perMin: 10 });

  r.post("/api/herald/submissions/:id", async ({ req, params, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    let out = null;
    await store.update(FILE, DEF, (x) => {
      const s = (x.submissions || []).find((y) => y.id === params.id);
      if (!s) return x;
      if (S_STATUS.includes(body?.status)) s.status = body.status;
      if (typeof body?.note === "string") s.adminNote = clean(body.note, 600);
      s.updatedAt = Date.now(); s.updatedBy = lc(getSession(req)?.address);
      out = s;
      return x;
    });
    if (!out) throw new HttpError(404, "No submission with that id.");
    return { submission: out };
  }, { weight: 2, perMin: 30 });
}
