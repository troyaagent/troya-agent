// V8 F43 Champions: follow a proven trader into your own capped Agent Wallet.
// Who can be followed (tightened 20 Nov 2026, see qualify()): an AI trader of the Arena with 5+ closed live trades in
// profit, a profit on paper and no pause from Troya, or a user strategy that finished its seven days on paper as
// "proven" and is still in profit. When it buys a coin on paper, each follower's Agent Wallet buys the same coin for the
// amount the follower chose; when it sells, the follower sells. Every follower trade goes through executeForUser with
// source "champions": the Gate, the wallet's caps, the Champions job cap and the trust ladder (Watch: alerts only,
// Approve: an Inbox proposal, Auto: it trades) all apply (V8 F44 Scepter). No performance fee is taken.
// A follow saved on a trader that stops qualifying stays stored but buys nothing until the trader qualifies again;
// coins it already bought are still sold when the trader sells.
//   GET  /api/champions              who can be followed (champions), who cannot yet and why (others), latest buys
//   GET  /api/champions/me           your follows and the trades they made (session)
//   POST /api/champions/follow       { agentId, buyEth, on }                     (session)
import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "champions.json";
const BUY = { min: 0.001, max: 0.05, def: 0.002 };
const MIN_LIVE = 5;                                   // closed live trades an AI trader needs before anyone can follow it
const lc = (s) => String(s || "").toLowerCase();
const total = (s) => (Number(s?.pnlEth) || 0) + (Number(s?.openPnlEth) || 0);
let store = null;

// Why a trader cannot be followed now, or null when it can. A follower buys with real ETH, so one live trade or a paper
// record is not enough (20 Nov 2026: Qwen was followable on 3 live trades, all losses, while Troya had paused its own
// live buying). A pause from Troya (ARENA_LIVE_PAUSE) or the Arena's live trading being off wins over any record: what
// the Arena may not buy with its own money, it must not buy with a follower's.
function qualify(a, { paused, liveOn }) {
  if (paused.includes(a.id)) return "Paused by Troya";
  if (a.kind === "ai") {
    if (!liveOn) return "Arena live trading is off";
    if (!a.live || !(a.live.closed >= MIN_LIVE) || !(total(a.live) > 0)) return `Needs ${MIN_LIVE} live trades in profit`;
  } else if (a.status !== "proven") return "Still proving on paper";
  // paper must be in profit on closed trades and with the open ones counted, so a big open loss is not hidden
  if (!(Number(a.stats?.pnlEth) > 0 && total(a.stats) > 0)) return "Needs a profit on paper";
  return null;
}

/** Every Arena trader with { followable, reason }. Errors are thrown: callers fail closed (nobody followable). */
async function candidates() {
  const { arenaBoard, LIVE, LIVE_PAUSED } = await import("./arena.mjs");
  const b = await arenaBoard();
  const ctx = { paused: LIVE_PAUSED(), liveOn: LIVE() };
  return (b.agents || []).map((a) => {
    const reason = qualify(a, ctx);
    return { id: a.id, name: a.name, kind: a.kind, model: a.model, status: a.status, rulesText: a.rulesText, paper: a.stats, live: a.live || null,
      livePaused: ctx.paused.includes(a.id), followable: !reason, reason };
  });
}
const followable = async () => (await candidates()).filter((a) => a.followable);

/** Arena hook: these paper positions just opened. Followers of a trader that qualifies buy the same coin. */
export async function onArenaOpen(list) {
  if (!store || !list?.length) return;
  const d = await store.readJson(FILE, {});
  const ok = new Set((await followable().catch(() => [])).map((a) => a.id));
  // the pause is read again here, on its own: it always wins over the list above; if it cannot be read, nothing is bought
  let paused;
  try { paused = new Set((await import("./arena.mjs")).LIVE_PAUSED()); } catch { return; }
  const aw = await import("./agentwallet.mjs");
  for (const p of list) {
    if (paused.has(p.agent) || !ok.has(p.agent)) continue;
    for (const [owner, f] of Object.entries(d.follows || {})) {
      const rule = f?.[p.agent];
      if (!rule?.on) continue;
      const amountIn = String(Math.min(BUY.max, Math.max(BUY.min, Number(rule.buyEth) || BUY.def)));
      const rec = { id: randomBytes(6).toString("hex"), owner, agent: p.agent, from: p.id, token: p.token, symbol: p.symbol, amountEth: Number(amountIn), openedAt: Date.now(), status: "open" };
      try {
        const r = await aw.executeForUser(owner, { kind: "swap", params: { tokenIn: "ETH", tokenOut: p.token, amountIn, slippagePct: 5 }, rationale: `Champions: following ${p.agent} into $${p.symbol}`, source: "champions" });
        rec.result = r.executed ? "bought" : r.proposed ? "waiting for your approval" : `not sent: ${(r.reasons || []).join(" ").slice(0, 200)}`;
        if (!r.executed && !r.proposed) rec.status = "skipped";
      } catch (e) { rec.result = `failed: ${e.message.slice(0, 160)}`; rec.status = "skipped"; }
      await store.update(FILE, {}, (x) => { x.pos = [rec, ...(x.pos || [])].slice(0, 2000); return x; });
    }
  }
}
/** Arena hook: these paper positions just closed. Followers who bought sell the coin they still hold. */
export async function onArenaClose(list) {
  if (!store || !list?.length) return;
  const d = await store.readJson(FILE, {});
  const aw = await import("./agentwallet.mjs");
  for (const p of list) {
    const mine = (d.pos || []).filter((x) => x.from === p.id && x.status === "open" && x.result === "bought");
    for (const x of mine) {
      let out = "";
      try {
        const w = await aw.getAgentWallet(x.owner);
        const b = w?.address ? await (await import("./tools.mjs")).getBalances(w.address, [x.token]) : null;
        const have = Number((b?.robinhoodTokens || []).find((t) => lc(t.address) === lc(x.token))?.amount || 0);
        if (have > 0) {
          const amountIn = (have * 0.999).toPrecision(12).replace(/\.?0+$/, "");
          const r = await aw.executeForUser(x.owner, { kind: "swap", params: { tokenIn: x.token, tokenOut: "ETH", amountIn, slippagePct: 8 }, rationale: `Champions: ${p.agent} sold $${x.symbol} (${p.reason})`, source: "champions" });
          out = r.executed ? "sold" : r.proposed ? "sell waiting for your approval" : `sell not sent: ${(r.reasons || []).join(" ").slice(0, 200)}`;
        } else out = "nothing left to sell";
      } catch (e) { out = `sell failed: ${e.message.slice(0, 160)}`; }
      await store.update(FILE, {}, (s) => { const r = (s.pos || []).find((y) => y.id === x.id); if (r) Object.assign(r, { status: "closed", closedAt: Date.now(), exit: out, reason: p.reason }); return s; });
    }
  }
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/champions", async () => {
    const d = await store.readJson(FILE, {});
    const count = {};
    for (const f of Object.values(d.follows || {})) for (const [id, rule] of Object.entries(f || {})) if (rule?.on) count[id] = (count[id] || 0) + 1;
    const all = (await candidates().catch(() => [])).map((a) => ({ ...a, followers: count[a.id] || 0 }));
    const list = all.filter((a) => a.followable);
    // the ones that cannot be followed yet are listed too, with the reason: every AI trader, proven strategies that fell
    // back into a loss, and any trader someone still follows (so its followers can see why it buys nothing and unfollow)
    const others = all.filter((a) => !a.followable && (a.kind === "ai" || a.status === "proven" || a.followers > 0));
    const { arenaBoard } = await import("./arena.mjs");
    const b = await arenaBoard().catch(() => ({ recent: [] }));
    return { name: "Troya Champions", rule: `Only AI traders with ${MIN_LIVE}+ live trades in profit and a profit on paper, not paused by Troya, or user strategies proven after 7 days on paper and still in profit, can be followed. Each follower trade passes the Gate, your caps, the Champions cap and your trust ladder. No performance fee.`,
      champions: list, others, latest: (b.recent || []).filter((p) => list.some((a) => a.id === p.agent)).slice(0, 15), buy: BUY };
  }, { weight: 1 });
  r.get("/api/champions/me", async ({ req }) => {
    const s = requireSession(req);
    const d = await store.readJson(FILE, {});
    return { follows: d.follows?.[lc(s.address)] || {}, trades: (d.pos || []).filter((x) => x.owner === lc(s.address)).slice(0, 100), buy: BUY };
  });
  r.post("/api/champions/follow", async ({ req, body }) => {
    const s = requireSession(req);
    const id = String(body?.agentId || "").slice(0, 60);
    // stopping a follow is always allowed; starting one needs a trader that qualifies right now
    if (body?.on !== false) {
      const c = (await candidates()).find((a) => a.id === id);
      if (!c) throw new HttpError(400, "No such trader in the Arena.");
      if (!c.followable) throw new HttpError(400, `${c.name} cannot be followed now: ${c.reason}.`);
    }
    const buyEth = Math.min(BUY.max, Math.max(BUY.min, Number(body?.buyEth) || BUY.def));
    await store.update(FILE, {}, (d) => { d.follows ||= {}; const f = (d.follows[lc(s.address)] ||= {}); f[id] = { on: body?.on !== false, buyEth, at: Date.now() }; return d; });
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "champions.follow", summary: body?.on === false ? `Stopped following ${id}` : `Following ${id} with ${buyEth} ETH a trade`, source: "app" });
    return { ok: true, agentId: id, on: body?.on !== false, buyEth, owner: getAddress(s.address) };
  }, { perMin: 20 });
}
