// Public usage stats (community request, 20-21 Nov 2026: "how many people actually use Troya?"). Every number is read
// from files the server already writes or from public APIs; nothing is estimated. Team, admin, Arena and test wallets are
// left out of the user counts (STATS_EXCLUDE adds more, comma separated).
//   GET /api/stats   community, usage and proof numbers, each with the time it was read
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const lc = (s) => String(s || "").toLowerCase();
const size = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : Number(v) || 0);
const TEST_WALLETS = ["0x12a05719851c8375342de65c9105329c81f57054"];   // the team's real-money test wallet
let store = null, root = "", cache = null, slow = { at: 0, v: {} };

const excluded = () => new Set([
  ...TEST_WALLETS,
  ...String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(","),
  ...String(process.env.STATS_EXCLUDE || "").split(","),
  process.env.ARENA_LIVE_OWNER || "",
].map((a) => lc(a).trim()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));

async function journal() {
  const out = [];
  try { for (const l of (await readFile(join(root, "data", "journal.jsonl"), "utf8")).split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } } } catch { /* none yet */ }
  return out;
}

// Telegram members and X followers change slowly and cost an API call: read at most once an hour
async function slowNumbers() {
  if (Date.now() - slow.at < 3600_000) return slow.v;
  const v = { ...slow.v };
  try {
    const T = process.env.TELEGRAM_BOT_TOKEN;
    if (T) { const j = await fetch(`https://api.telegram.org/bot${T}/getChatMemberCount?chat_id=@troyaagent`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()); if (j.ok) v.telegramMembers = j.result; }
  } catch { /* keep the last */ }
  try {
    const x = await import("./xsocial.mjs");
    const p = await x.userProfile(process.env.X_BOT_USERNAME || "Troyaagent");
    const f = p?.public_metrics?.followers_count ?? p?.followers ?? p?.followers_count;
    if (Number.isFinite(f)) v.xFollowers = f;
  } catch { /* keep the last */ }
  try {
    const m = await import("./market.mjs");
    const ca = ((await readFile(join(root, "public", "config.js"), "utf8")).match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1];
    const t = ca ? (await m.getRobinhoodToken(ca))?.token : null;
    if (t?.holders > 0) v.holders = t.holders;
  } catch { /* keep the last */ }
  slow = { at: Date.now(), v };
  return v;
}

async function compute() {
  const ex = excluded();
  const J = await journal();
  const week = Date.now() - 7 * 86_400_000;
  const TRADE = /^agent-wallet\.(swap|perp|close)$|^perp_order$/;
  const users = new Set(), users7 = new Set();
  let trades = 0, trades7 = 0, playbooks = 0, xTg = 0;
  for (const e of J) {
    const a = lc(e.address);
    if (!a || ex.has(a) || e.source === "arena") continue;
    if (e.status === "executed" || e.status === "ok") { users.add(a); if ((e.t || 0) >= week) users7.add(a); }
    if (TRADE.test(e.kind || "") && e.status === "executed") { trades++; if ((e.t || 0) >= week) trades7++; if (e.source === "x" || e.source === "telegram" || e.source === "tg") xTg++; }
    if (e.kind === "watch.create") playbooks++;
  }
  const aw = await store.readJson("agentwallets.json", {});
  const wallets = Object.keys(aw.wallets || aw).filter((a) => /^0x[0-9a-f]{40}$/i.test(a) && !ex.has(lc(a))).length;
  const launches = (await store.readJson("launches.json", [])).filter((l) => !l.teamTest);
  const x402 = await store.readJson("x402.json", {});
  const gateapi = await store.readJson("gateapi.json", {});
  const paidGate = Number(x402.stats?.calls ?? x402.stats?.paid ?? (x402.last || []).length ?? 0) + Number(gateapi.stats?.calls ?? gateapi.usage?.calls ?? 0);
  const sentry = await store.readJson("sentry.json", {});
  const record = await store.readJson("record.json", {});
  const arena = await store.readJson("arena.json", {});
  const pos = arena.positions || [];
  const fw = await store.readJson("flywheel.json", {});
  const burned = (fw.burns || []).reduce((s, b) => s + (Number(b.troya ?? b.amount) || 0), 0);
  let verifySteps = 0;
  try { verifySteps = ((await readFile(join(root, "public", "verify.html"), "utf8")).match(/<article class="step/g) || []).length; } catch { /* none */ }
  const s = await slowNumbers();
  return {
    at: Date.now(),
    community: { telegramMembers: s.telegramMembers ?? null, xFollowers: s.xFollowers ?? null, holders: s.holders ?? null },
    usage: { walletsUsedTroya: users.size, walletsLast7Days: users7.size, agentWallets: wallets, tradesExecuted: trades, tradesLast7Days: trades7, tradesFromXOrTelegram: xTg, coinsLaunched: launches.length, playbooksCreated: playbooks, paidGateCalls: paidGate },
    proof: { launchesCheckedBySentry: size(record.calls), sentryPasses: size(sentry.posted), arenaTrades: pos.length, arenaLiveTrades: pos.filter((p) => p.mode === "live").length, troyaBurned: Math.round(burned), realMoneyTests: verifySteps },
    note: "Read from Troya's own records and public APIs. Team, admin, Arena and test wallets are not counted as users.",
  };
}

export async function register(r, ctx) {
  store = ctx.store; root = ctx.root || process.cwd();
  r.get("/api/stats", async () => {
    if (!cache || Date.now() - cache.at > 60_000) cache = await compute();
    return cache;
  }, { weight: 1 });
}
