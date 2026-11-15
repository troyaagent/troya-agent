// Phase 8 · a 60-second start: where a signed-in wallet stands on each setup step, read live, never guessed.
//   GET /api/onboarding → steps: signed in · Agent Wallet · funded · Telegram · Hyperliquid funded · Agent Wallet approved
//   on Hyperliquid · a first trade. The web page (#/start) walks through them; Telegram's /start links there.
// Phase 9 · leaderboard and copy: closed Sentry Autopilot results of users who opted in, ranked by return.
//   GET /api/leaderboard?days=7 · POST /api/leaderboard/copy {address} (copies that trader's rules into yours)
//   Telegram (via tgterm.mjs): /leaderboard · /copy 1
import { getAgentWallet } from "./agentwallet.mjs";
import { getBalances } from "./robinhood.mjs";
import { hlUserState, hlInfo } from "./hl.mjs";
import { readJournal } from "./journal.mjs";

let store = null;
export function init(st) { store = store || st; }
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function onboarding(address) {
  const a = address.toLowerCase();
  const [aw, links, st, journal] = await Promise.all([
    getAgentWallet(address).catch(() => null),
    store.readJson("telegram.json", { links: {} }).then((t) => t.links || {}).catch(() => ({})),
    hlUserState(address).catch(() => null),
    readJournal(address, { limit: 200 }).catch(() => []),
  ]);
  let awEth = null, approved = null;
  if (aw?.exists) {
    const [b, agents] = await Promise.all([getBalances(aw.address).catch(() => null), hlInfo({ type: "extraAgents", user: a }).catch(() => null)]);
    awEth = Number(b?.balances?.find((x) => x.address === "native")?.amount ?? NaN);
    if (Array.isArray(agents)) approved = agents.some((x) => String(x.address).toLowerCase() === aw.address.toLowerCase());
  }
  const traded = (journal || []).some((j) => /swap|perp|bridge|hl_fund|agent-wallet\.(swap|perp|hl_fund|close)/i.test(j.kind || "") && !/blocked|failed|dry-run/i.test(j.status || ""));
  const steps = [
    { key: "signin", done: true },
    { key: "agentWallet", done: !!aw?.exists, address: aw?.address || null },
    { key: "funded", done: isFinite(awEth) && awEth >= 0.001, eth: isFinite(awEth) ? awEth : null },
    { key: "telegram", done: !!links[a] },
    { key: "hlFunded", done: (st?.accountValue || 0) >= 1, value: st?.accountValue ?? null },
    { key: "hlApproved", done: approved === true },
    { key: "firstTrade", done: traded },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

/* ---------- leaderboard ---------- */
export async function leaderboard({ days = 7 } = {}) {
  const s = await store.readJson("autopilot.json", { users: {}, positions: [] });
  const since = Date.now() - Math.min(90, Math.max(1, days)) * 86400e3;
  const rows = [];
  for (const [address, u] of Object.entries(s.users || {})) {
    if (!u.public) continue;
    const closed = (s.positions || []).filter((p) => p.address === address && p.status === "closed" && p.closedAt >= since);
    if (!closed.length) continue;
    const live = closed.filter((p) => p.mode === "live");
    const set = live.length ? live : closed;                     // live results rank ahead of practice when a trader has them
    const invested = set.reduce((x, p) => x + p.amountEth, 0);
    const pnl = set.reduce((x, p) => x + (p.pnlEth || 0), 0);
    rows.push({ trader: short(address), address, mode: live.length ? "live" : "practice", closed: set.length, winRate: set.filter((p) => (p.pnlEth || 0) > 0).length / set.length, pnlEth: pnl, returnPct: invested ? (pnl / invested) * 100 : 0, rules: u.rules || null, on: !!u.on });
  }
  rows.sort((x, y) => (y.mode === "live") - (x.mode === "live") || y.returnPct - x.returnPct || y.closed - x.closed);
  return rows.slice(0, 50).map((r, i) => ({ rank: i + 1, ...r }));
}
export async function copyRules(toAddress, fromAddress) {
  const s = await store.readJson("autopilot.json", { users: {} });
  const src = s.users?.[String(fromAddress).toLowerCase()];
  if (!src?.public || !src.rules) throw Object.assign(new Error("That trader is not on the leaderboard."), { status: 404 });
  const ap = await import("./autopilot.mjs"); ap.init(store);
  return ap.setUser(toAddress, { rules: src.rules });
}
export async function leaderboardText(days = 7) {
  const rows = await leaderboard({ days });
  if (!rows.length) return "No one is on the leaderboard yet. Turn on Sentry Autopilot (/autopilot on) and opt in from the app: Agent → Sentry Autopilot → Show my results.";
  const L = [`<b>Sentry Autopilot leaderboard · last ${days} days</b>`];
  for (const r of rows.slice(0, 10)) L.push(`${r.rank}. <code>${r.trader}</code> · ${r.mode} · ${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}% · ${r.closed} closed · ${(r.winRate * 100).toFixed(0)}% won${r.rules ? ` · min ${r.rules.minRaisedEth} ETH, tp ${r.rules.takeProfitX}x, sl ${r.rules.stopPct}%` : ""}`);
  L.push("", "/copy 1 copies the rules of rank 1 into your Autopilot. Practice results are play money at real prices.");
  return L.join("\n");
}

export async function register(r, ctx) {
  store = ctx.store;
  const { requireSession } = await import("./auth.mjs");
  const { HttpError } = await import("./api.mjs");
  r.get("/api/onboarding", async ({ req }) => onboarding(requireSession(req).address));
  r.get("/api/leaderboard", async ({ query }) => ({ days: Number(query.days) || 7, rows: (await leaderboard({ days: Number(query.days) || 7 })).map(({ address, ...x }) => x) }), { perMin: 60 });
  r.post("/api/leaderboard/copy", async ({ req, body }) => {
    const s = requireSession(req);
    const rows = await leaderboard({ days: 90 });
    const pick = rows.find((x) => x.trader === body.trader || x.rank === Number(body.rank));
    if (!pick) throw new HttpError(404, "That trader is not on the leaderboard.");
    try { return { settings: await copyRules(s.address, pick.address), from: pick.trader }; } catch (e) { throw new HttpError(e.status || 400, e.message); }
  });
}
