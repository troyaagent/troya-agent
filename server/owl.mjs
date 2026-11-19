// V7 F35 Owl: your trading week, read from the chain and from what Troya saw, with three plain lines of coaching.
// Owl reads the wallet's last 7 days of token transfers on Robinhood Chain, takes the coins it traded most, and for each one
// the real cost and proceeds in ETH (the same reading as Portfolio's PnL), how long it was held, and what Troya knew about it
// (Ring Radar, Aegis alerts). The coaching is plain rules on those numbers, no model: what to keep, what to change, one thing
// to try. Each weekly card is sealed (V7 F35) under a hash of the wallet, so the card can be proven without listing the wallet.
//   GET  /api/owl/me              this week's card for the signed-in wallet (cached 6 h; ?fresh=1 rebuilds once an hour)
//   POST /api/owl/me              { weekly: true|false } → a weekly Owl card in Telegram every Monday
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "owl.json";
const WEEK = 7 * 86_400_000, TOP = 6;
const SKIP = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "0x0bd7d308f8e1639fab988df18a8011f41eacad73"]);   // USDG, WETH
const lc = (s) => String(s || "").toLowerCase();
const memo = new Map();
let store = null;

async function transfersThisWeek(a) {
  const { blockscoutApi, hasBlockscout } = await import("./market.mjs");
  if (!hasBlockscout()) throw new HttpError(503, "Trade history is not configured on this server.");
  const since = Date.now() - WEEK, out = [];
  let q = "", pages = 0;
  while (pages++ < 5) {
    const r = await blockscoutApi(`/addresses/${a}/token-transfers?type=ERC-20${q}`);
    const items = r?.items || [];
    for (const x of items) { const t = x.timestamp ? Date.parse(x.timestamp) : 0; if (t >= since) out.push(x); }
    const oldest = items.length ? Date.parse(items.at(-1).timestamp || 0) : 0;
    if (!r?.next_page_params || oldest < since) break;
    q = "&" + new URLSearchParams(r.next_page_params).toString();
  }
  return out;
}

export async function owlWeek(address, { fresh = false } = {}) {
  const a = lc(getAddress(address));
  const hit = memo.get(a);
  if (hit && Date.now() - hit.at < (fresh ? 3600_000 : 6 * 3600_000)) return hit.v;
  const tr = await transfersThisWeek(a);
  const coins = new Map();
  for (const x of tr) {
    const t = lc(x.token?.address_hash);
    if (!t || SKIP.has(t) || x.token?.type !== "ERC-20") continue;
    const c = coins.get(t) || { token: t, symbol: String(x.token?.symbol || "?").replace(/\s•.*$/, ""), txs: new Set(), first: Infinity, last: 0, inAt: [], outAt: [], hours: [] };
    const at = Date.parse(x.timestamp);
    c.txs.add(x.transaction_hash); c.first = Math.min(c.first, at); c.last = Math.max(c.last, at);
    if (lc(x.to?.hash) === a) c.inAt.push(at); if (lc(x.from?.hash) === a) c.outAt.push(at);
    c.hours.push(new Date(at).getUTCHours());
    coins.set(t, c);
  }
  const ranked = [...coins.values()].sort((x, y) => y.txs.size - x.txs.size);
  const top = ranked.slice(0, TOP);
  const { tokenPnl } = await import("./portfolio.mjs");
  const ring = await import("./ringradar.mjs").catch(() => null);
  const aegis = await import("./aegis.mjs").catch(() => null);
  const rows = [];
  for (const c of top) {
    const p = await tokenPnl(a, c.token).catch(() => null);
    const firstIn = c.inAt.length ? Math.min(...c.inAt) : null, lastOut = c.outAt.length ? Math.max(...c.outAt) : null;
    const ag = await aegis?.aegisToken(c.token).catch(() => null);
    rows.push({ token: getAddress(c.token), symbol: c.symbol, trades: c.txs.size,
      buys: p?.buys ?? null, sells: p?.sells ?? null, costEth: p?.costEth ?? null, proceedsEth: p?.proceedsEth ?? null, valueEth: p?.valueEth ?? null, pnlEth: p?.pnlEth ?? null, pnlPct: p?.pnlPct ?? null,
      holding: (p?.amount || 0) > 0, heldMin: firstIn && lastOut && lastOut > firstIn ? Math.round((lastOut - firstIn) / 60_000) : null,
      ring: ring?.ringFlags(c.token)?.[0]?.level || null, aegisRed: (ag?.events || []).filter((e) => e.level === "red" && e.at >= Date.now() - WEEK).length });
  }
  // habits, from the numbers alone
  const priced = rows.filter((r) => r.pnlEth != null);
  const wins = priced.filter((r) => r.pnlEth > 0), losses = priced.filter((r) => r.pnlEth < 0);
  const pnl = priced.reduce((s, r) => s + r.pnlEth, 0);
  const allHours = [...coins.values()].flatMap((c) => c.hours);
  const night = allHours.length ? allHours.filter((h) => h < 6).length / allHours.length : 0;
  const scalps = rows.filter((r) => r.heldMin != null && r.heldMin <= 15).length;
  const heldLosers = rows.filter((r) => r.holding && r.pnlPct != null && r.pnlPct <= -50);
  const rigged = rows.filter((r) => r.ring === "red");
  const big = (xs, f) => xs.length ? xs.reduce((m, r) => (f(r) > f(m) ? r : m)) : null;
  const best = big(wins, (r) => r.pnlEth), worst = big(losses, (r) => -r.pnlEth);
  const coach = { keep: null, change: null, try: null };
  if (best) coach.keep = `$${best.symbol} was your best trade (+${best.pnlEth.toFixed(4)} ETH${best.heldMin != null ? `, held ${best.heldMin} min` : ""}). Do more of what you did there.`;
  else if (!rows.length) coach.keep = "A quiet week: no coin trades from this wallet in the last 7 days.";
  else coach.keep = "No winning trade this week. Sitting out a bad week is a skill too.";
  if (rigged.length) coach.change = `You traded ${rigged.length} coin${rigged.length > 1 ? "s" : ""} Ring Radar called rigged (${rigged.map((r) => "$" + r.symbol).join(", ")}). Check the Gate page's Athena box before the buy.`;
  else if (heldLosers.length) coach.change = `Still holding ${heldLosers.map((r) => `$${r.symbol} (${r.pnlPct.toFixed(0)}%)`).join(", ")}. Decide on purpose: cut it, or keep it with Aegis on.`;
  else if (losses.length >= 3 && losses.length > wins.length) coach.change = `${losses.length} losing coins against ${wins.length} winners. Fewer coins, smaller size, until the hit rate turns.`;
  else if (worst) coach.change = `$${worst.symbol} cost ${(-worst.pnlEth).toFixed(4)} ETH. Write down why you bought it before the next one like it.`;
  if (night >= 0.4 && allHours.length >= 5) coach.try = `${Math.round(night * 100)}% of your trades were between 00:00 and 06:00 UTC. Try a cooldown: pause the Agent Wallet at night in Agent → Wallet.`;
  else if (scalps >= 2) coach.try = `${scalps} coins in and out within 15 minutes. Try Sentry Autopilot in practice mode with the same idea and compare after a week.`;
  else coach.try = "Turn Aegis on: every coin you hold gets watched for dev and whale sells and a failing sell test.";
  const v = { wallet: getAddress(a), from: Date.now() - WEEK, to: Date.now(), coinsTraded: coins.size, transfers: tr.length, read: rows.length, capped: Math.max(0, ranked.length - TOP),
    pnlEth: priced.length ? +pnl.toFixed(6) : null, wins: wins.length, losses: losses.length, nightShare: +night.toFixed(2), scalps, coins: rows, coach,
    note: "PnL in ETH at today's ETH price, gas not counted, from this wallet's own trades (tokens that arrived by transfer are not counted as bought). Ring Radar and Aegis readings are as Troya has them now." };
  const rec = await import("./seal.mjs").then((m) => m.seal("owl", keccak256(toUtf8Bytes(a)), v, `${rows.length} coins, ${wins.length}W/${losses.length}L`)).catch(() => null);
  v.receipt = rec?.hash || null;
  memo.set(a, { at: Date.now(), v });
  return v;
}

export function owlText(v) {
  const s = [`<b>Owl · your week on Robinhood Chain</b>`, `${v.coinsTraded} coin${v.coinsTraded === 1 ? "" : "s"} traded${v.pnlEth != null ? ` · ${v.pnlEth >= 0 ? "+" : ""}${v.pnlEth.toFixed(4)} ETH on the ${v.read} read` : ""} · ${v.wins}W/${v.losses}L`];
  for (const r of v.coins.slice(0, 4)) s.push(`• $${r.symbol}: ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(4)} ETH` : "no priced trades"}${r.holding ? " · still held" : ""}${r.ring === "red" ? " · Ring Radar red" : ""}`);
  s.push("", `Keep: ${v.coach.keep}`);
  if (v.coach.change) s.push(`Change: ${v.coach.change}`);
  if (v.coach.try) s.push(`Try: ${v.coach.try}`);
  return s.join("\n");
}

async function weeklyTick() {
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return;                 // Mondays, 09:00 UTC
  const d = await store.readJson(FILE, {});
  const key = now.toISOString().slice(0, 10);
  if (d.sentFor === key) return;
  const { sendTelegram } = await import("./inbox.mjs");
  for (const [a, sub] of Object.entries(d.subs || {})) {
    if (!sub.weekly) continue;
    try { await sendTelegram(a, owlText(await owlWeek(a, { fresh: true }))); } catch (e) { console.warn("[owl]", e.message); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await store.update(FILE, {}, (x) => { x.sentFor = key; return x; });
}

export async function register(r, ctx) {
  store = ctx.store;
  setInterval(() => weeklyTick().catch(() => {}), 10 * 60_000).unref();
  r.get("/api/owl/me", async ({ req, query }) => {
    const me = requireSession(req).address;
    const v = await owlWeek(me, { fresh: query.fresh === "1" });
    const d = await store.readJson(FILE, {});
    return { ...v, weekly: !!d.subs?.[lc(me)]?.weekly };
  }, { weight: 4, perMin: 6 });
  r.post("/api/owl/me", async ({ req, body }) => {
    const me = lc(requireSession(req).address);
    const weekly = body?.weekly === true;
    await store.update(FILE, {}, (x) => { x.subs ||= {}; x.subs[me] = { weekly, at: Date.now() }; return x; });
    return { ok: true, weekly };
  }, { weight: 1, perMin: 20 });
}
