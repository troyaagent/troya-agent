// V9 F52 Two Fates part 2 (War Room) and F53 Myrmidons. A scorecard, not a betting market: no stakes, no money, only a
// public record and reputation.
//   call       predict a fresh launch's fate: "survives" its first day, or goes to "zero"
//   challenge  dispute Troya's own verdict on a fresh launch ("should have been blocked" / "should have passed"), with evidence
//   rug        (Myrmidons) report a ring or a rug on any Robinhood Chain coin, with on-chain evidence; Troya checks it itself
// Calls and challenges are graded by the same 24 h fate Two Fates records (server/fates.mjs): went to zero or not sellable
// counts as "zero", anything else as "survives". A rug report is confirmed when Troya's own reads agree: the coin went to
// zero or could not be sold in Two Fates, or Heel names a critical weak spot, or a high one about dev sales, liquidity, a
// ring or the sell itself. Reports describe what wallets did, never who people are.
//   GET  /api/warroom              open coins, recent entries, the leaderboard, rules
//   POST /api/warroom/entry        session: { kind, token, side?, evidence? }
import { getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";
import { requireSession } from "./auth.mjs";

const FILE = "warroom.json";
const FATES = "fates.json";
const H = 3600e3, DAY = 24 * H;
const OPEN_FOR = 6 * H;             // calls and challenges only on launches checked in the last 6 hours
const RUG_WINDOW = 48 * H;          // a rug report is re-checked for two days, then left unconfirmed
const PER_DAY = 10;
const KEEP = 5000;
const RUG_KEYS = /dev-sold|devside|liquidity|pull|gather|ring|honeypot|sell|tax|drain|remove/i;
let store, busy = false;

const lc = (s) => String(s || "").toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const today = () => new Date().toISOString().slice(0, 10);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const blank = () => ({ entries: [] });
const fateOf = (c) => (!c || c.status !== "graded" ? null : c.result === "zero" || c.result === "not-sellable" ? "zero" : "survives");

async function fates() { return (await store.readJson(FATES, { coins: {} })).coins || {}; }

async function view() {
  const d = await store.readJson(FILE, blank());
  const coins = await fates();
  const now = Date.now();
  const open = Object.values(coins).filter((c) => c.status === "watching" && now - c.at < OPEN_FOR).sort((a, b) => b.at - a.at)
    .map((c) => ({ token: c.token, symbol: c.symbol, at: c.at, verdict: c.cohort, reason: c.reason, closesAt: c.at + OPEN_FOR }));
  const rep = new Map();
  for (const e of d.entries) {
    const r = rep.get(e.wallet) || { wallet: e.wallet, calls: 0, right: 0, challenges: 0, challengesWon: 0, rugs: 0, rugsConfirmed: 0 };
    if (e.kind === "call") { r.calls++; if (e.result === "right") r.right++; }
    if (e.kind === "challenge") { r.challenges++; if (e.result === "right") r.challengesWon++; }
    if (e.kind === "rug") { r.rugs++; if (e.result === "confirmed") r.rugsConfirmed++; }
    rep.set(e.wallet, r);
  }
  const score = (r) => r.right + 2 * r.challengesWon + 3 * r.rugsConfirmed;
  const board = [...rep.values()].map((r) => ({ ...r, wallet: short(r.wallet), score: score(r) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 25);
  return {
    open, leaderboard: board,
    entries: d.entries.slice(0, 150).map((e) => ({ id: e.id, at: e.at, kind: e.kind, wallet: short(e.wallet), token: e.token, symbol: e.symbol, side: e.side, evidence: e.evidence, status: e.status, result: e.result || null, note: e.note || null })),
    rules: [
      "A scorecard, not a betting market: no stakes and no money, only a public record and reputation.",
      "Call: on a launch Troya checked in the last 6 hours, say whether it survives its first day or goes to zero. Graded by Two Fates at 24 hours.",
      "Challenge: think Troya got a verdict wrong? Say why. If a coin Troya passed goes to zero, or a coin it blocked survives, the challenger was right, and that goes on the record too.",
      "Myrmidons: report a ring or a rug on any Robinhood Chain coin with on-chain evidence. Troya checks it with its own reads (Two Fates, Heel) for up to 48 hours; confirmed reports count on the board.",
      "Went to zero means the 24 hour price is 10% of the price at the check or less, no price at all, or not sellable. Anything else counts as survived.",
      "Ten entries per wallet a day, one per coin and kind. Reports describe what wallets did, never who people are.",
    ],
    points: "Leaderboard: 1 point per right call, 2 per challenge won, 3 per confirmed rug report.",
    updatedAt: now,
  };
}

async function entry(req, body) {
  const s = requireSession(req);
  const wallet = getAddress(s.address);
  const kind = ["call", "challenge", "rug"].includes(body?.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, "Pick call, challenge or rug.");
  if (!isAddress(String(body?.token || ""))) throw new HttpError(400, "That is not a token address.");
  const token = lc(body.token);
  const evidence = clean(body?.evidence, 600);
  const d = await store.readJson(FILE, blank());
  const now = Date.now();
  const mineToday = d.entries.filter((e) => e.wallet === wallet && new Date(e.at).toISOString().slice(0, 10) === today()).length;
  if (mineToday >= PER_DAY) throw new HttpError(429, `Ten entries a day per wallet. Come back tomorrow (UTC).`);
  if (d.entries.some((e) => e.wallet === wallet && e.token === token && e.kind === kind)) throw new HttpError(409, "You already have an entry of this kind on this coin.");
  const e = { id: (d.entries[0]?.id || 0) + 1, at: now, kind, wallet, token, evidence: evidence || null, status: "open" };
  if (kind === "call" || kind === "challenge") {
    const c = (await fates())[token];
    if (!c || c.status !== "watching" || now - c.at >= OPEN_FOR) throw new HttpError(409, "Calls and challenges are open only on launches Troya checked in the last 6 hours. Pick one from the list.");
    e.symbol = c.symbol || null; e.verdict = c.cohort;
    if (kind === "call") {
      if (!["survives", "zero"].includes(body?.side)) throw new HttpError(400, "Say survives or zero.");
      e.side = body.side;
    } else {
      if (!evidence || evidence.length < 20) throw new HttpError(400, "A challenge needs a reason of at least 20 characters.");
      e.side = c.cohort === "passed" ? "should-block" : "should-pass";
    }
  } else {
    if (!evidence || evidence.length < 20) throw new HttpError(400, "A rug report needs on-chain evidence: transactions, wallets or what they did (20 characters or more).");
    if (!/0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}/.test(evidence)) throw new HttpError(400, "Include at least one transaction hash or wallet address as evidence.");
    try { const { getRobinhoodToken } = await import("./market.mjs"); e.symbol = (await getRobinhoodToken(token).catch(() => null))?.token?.symbol || null; } catch {}
  }
  await store.update(FILE, blank(), (x) => { x.entries = [e, ...(x.entries || [])].slice(0, KEEP); return x; });
  return { ok: true, id: e.id, note: kind === "rug" ? "Logged. Troya checks it with its own reads for up to 48 hours." : "Logged. It is graded when the coin's first day ends." };
}

// grading: calls and challenges by Two Fates' 24 h result; rug reports by Troya's own reads, a few per pass
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, blank());
    const coins = await fates();
    const now = Date.now();
    let changed = false, heelReads = 0;
    for (const e of d.entries) {
      if (e.status !== "open") continue;
      if (e.kind === "call" || e.kind === "challenge") {
        const f = fateOf(coins[e.token]);
        if (!f) { if (now - e.at > 3 * DAY) { e.status = "void"; e.note = "The coin's first day could not be graded."; changed = true; } continue; }
        const right = e.kind === "call" ? e.side === f : (e.side === "should-block" ? f === "zero" : f === "survives");
        e.status = "graded"; e.result = right ? "right" : "wrong"; e.fate = f; changed = true;
        continue;
      }
      // rug report
      const f = fateOf(coins[e.token]);
      if (f === "zero") { e.status = "graded"; e.result = "confirmed"; e.note = "Two Fates: went to zero or could not be sold within a day."; changed = true; continue; }
      if (heelReads < 3 && now - (e.checkedAt || 0) > 30 * 60e3) {
        heelReads++; e.checkedAt = now; changed = true;
        try {
          const { heel } = await import("./heel.mjs");
          const r = await heel(e.token);
          const hit = r && (r.severity === "critical" || (r.severity === "high" && (r.facts || []).some((x) => RUG_KEYS.test(x.key || ""))));
          if (hit) { e.status = "graded"; e.result = "confirmed"; e.note = `Heel: ${String(r.heel || "").slice(0, 220)}`; continue; }
        } catch {}
      }
      if (now - e.at > RUG_WINDOW) { e.status = "graded"; e.result = "unconfirmed"; e.note = "Troya's own reads did not confirm it within 48 hours."; changed = true; }
    }
    if (changed) await store.update(FILE, blank(), (x) => {
      const byId = new Map(d.entries.map((e) => [e.id, e]));
      x.entries = (x.entries || []).map((e) => byId.get(e.id) || e);
      return x;
    });
  } catch (e) {
    console.warn("[warroom]", e.message);
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/warroom", () => view(), { weight: 1, perMin: 120 });
  r.post("/api/warroom/entry", ({ req, body }) => entry(req, body), { weight: 2, perMin: 20 });
  setInterval(() => tick().catch(() => {}), 5 * 60_000).unref?.();
  setTimeout(() => tick().catch(() => {}), 40_000).unref?.();
}
