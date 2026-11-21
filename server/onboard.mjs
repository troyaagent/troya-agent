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
  const [xl, prefs] = await Promise.all([
    store.readJson("x-links.json", {}).then((m) => m[a] || null).catch(() => null),
    store.readJson("launch-prefs.json", {}).then((m) => m[a] || {}).catch(() => ({})),
  ]);
  const steps = [
    { key: "signin", done: true },
    { key: "agentWallet", done: !!aw?.exists, address: aw?.address || null },
    { key: "agentWalletOn", done: !!aw?.exists && aw.enabled !== false },
    { key: "funded", done: isFinite(awEth) && awEth >= 0.0006, eth: isFinite(awEth) ? awEth : null },
    { key: "telegram", done: !!links[a] },
    { key: "hlFunded", done: (st?.accountValue || 0) >= 1, value: st?.accountValue ?? null },
    { key: "hlApproved", done: approved === true },
    { key: "firstTrade", done: traded },
    { key: "xLinked", done: !!xl, username: xl?.username || null },
    { key: "launchX", done: !!prefs.x },
    { key: "tradeX", done: !!prefs.trade },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

/* ---------- every missing step at once (18 Nov: a new user posted "launch Elon Mars $MARS" five times, each reply naming
   only the next blocker). Each feature lists what it needs; the bots answer with all of it and one link to #/start. ---------- */
const NEEDS = {
  "launch-x": ["agentWallet", "agentWalletOn", "funded", "launchX"],
  "trade-x": ["agentWallet", "agentWalletOn", "funded", "tradeX"],
  "launch-tg": ["agentWallet", "agentWalletOn", "funded"],
  "trade-tg": ["agentWallet", "agentWalletOn", "funded"],
};
const SITE = () => String(process.env.SITE_URL || "https://troya.codes").replace(/\/$/, "");
export const startLink = (purpose) => `${SITE().replace(/^https?:\/\//, "")}/agent#/start?for=${purpose}`;
/** The steps still missing for a feature, in order, as short instructions. needEth: what the Agent Wallet must hold. */
export async function gapsFor(address, purpose, { needEth = 0.0006 } = {}) {
  const o = await onboarding(address);
  const st = Object.fromEntries(o.steps.map((s) => [s.key, s]));
  const out = [];
  for (const k of NEEDS[purpose] || []) {
    if (k === "agentWallet" && !st.agentWallet.done) out.push("create your Agent Wallet");
    else if (k === "agentWalletOn" && st.agentWallet.done && !st.agentWalletOn.done) out.push("switch your Agent Wallet on");
    else if (k === "funded") {
      const eth = st.funded.eth ?? 0;
      // micro-ETH, and what is missing rounded up: at 4 decimals a wallet holding 0.00055 of 0.0006 read "add 0.0001 ETH
      // more (it holds 0.0006, needs 0.0006)", and a float gap of 0.0000499… could read "add 0 ETH more"
      const fmt = (x) => x.toFixed(6).replace(/\.?0+$/, "");
      const gap = Math.ceil((needEth - eth) * 1e6 - 1e-6) / 1e6;
      if (!st.agentWallet.done) out.push(`add ${fmt(needEth)} ETH to it on Robinhood Chain`);
      else if (eth < needEth) out.push(eth > 0.00001 ? `add ${fmt(gap)} ETH more to your Agent Wallet ${short(st.agentWallet.address)} (it holds ${fmt(Math.floor(eth * 1e6) / 1e6)}, needs ${fmt(needEth)})` : `add ${fmt(needEth)} ETH to your Agent Wallet ${short(st.agentWallet.address)} on Robinhood Chain`);
    }
    else if (k === "launchX" && !st.launchX.done) out.push("switch Launch from X on");
    else if (k === "tradeX" && !st.tradeX.done) out.push("switch Trade from X on");
  }
  return out;
}
/** One line for a reply: every step left, numbered, and the one page that does them all. */
export function gapsLine(steps, purpose) {
  return `${steps.length} step${steps.length > 1 ? "s" : ""} left, all on one page: ${startLink(purpose)} · ${steps.map((s, i) => `${i + 1}) ${s}`).join(" ")}`;
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
