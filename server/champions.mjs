// V8 F43 Champions: follow a proven trader into your own capped Agent Wallet.
// Who can be followed: an AI trader of the Arena with a real-money record, or a user strategy that finished its seven
// days on paper as "proven". When it buys a coin on paper, each follower's Agent Wallet buys the same coin for the
// amount the follower chose; when it sells, the follower sells. Every follower trade goes through executeForUser with
// source "champions": the Gate, the wallet's caps, the Champions job cap and the trust ladder (Watch: alerts only,
// Approve: an Inbox proposal, Auto: it trades) all apply (V8 F44 Scepter). No performance fee is taken.
//   GET  /api/champions              who can be followed, their records, followers and latest buys
//   GET  /api/champions/me           your follows and the trades they made (session)
//   POST /api/champions/follow       { agentId, buyEth, on }                     (session)
import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "champions.json";
const BUY = { min: 0.001, max: 0.05, def: 0.002 };
const lc = (s) => String(s || "").toLowerCase();
let store = null;

async function followable() {
  const { arenaBoard } = await import("./arena.mjs");
  const b = await arenaBoard();
  return (b.agents || []).filter((a) => (a.kind === "ai" && a.live && a.live.closed > 0) || a.status === "proven")
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, model: a.model, status: a.status, rulesText: a.rulesText, paper: a.stats, live: a.live || null, livePaused: !!a.livePaused }));
}

/** Arena hook: these paper positions just opened. Followers buy the same coin. */
export async function onArenaOpen(list) {
  if (!store || !list?.length) return;
  const d = await store.readJson(FILE, {});
  const ok = new Set((await followable().catch(() => [])).map((a) => a.id));
  const aw = await import("./agentwallet.mjs");
  for (const p of list) {
    if (!ok.has(p.agent)) continue;
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
        const b = w?.address ? await (await import("./tools.mjs")).getBalances(w.address) : null;
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
    const list = (await followable().catch(() => [])).map((a) => ({ ...a, followers: count[a.id] || 0 }));
    const { arenaBoard } = await import("./arena.mjs");
    const b = await arenaBoard().catch(() => ({ recent: [] }));
    return { name: "Troya Champions", rule: "Only Arena traders with a real-money record, or user strategies proven after 7 days on paper, can be followed. Each follower trade passes the Gate, your caps, the Champions cap and your trust ladder. No performance fee.",
      champions: list, latest: (b.recent || []).filter((p) => list.some((a) => a.id === p.agent)).slice(0, 15), buy: BUY };
  }, { weight: 1 });
  r.get("/api/champions/me", async ({ req }) => {
    const s = requireSession(req);
    const d = await store.readJson(FILE, {});
    return { follows: d.follows?.[lc(s.address)] || {}, trades: (d.pos || []).filter((x) => x.owner === lc(s.address)).slice(0, 100), buy: BUY };
  });
  r.post("/api/champions/follow", async ({ req, body }) => {
    const s = requireSession(req);
    const id = String(body?.agentId || "").slice(0, 60);
    const list = await followable();
    if (body?.on !== false && !list.some((a) => a.id === id)) throw new HttpError(400, "Only Arena traders with a real-money record, or proven strategies, can be followed.");
    const buyEth = Math.min(BUY.max, Math.max(BUY.min, Number(body?.buyEth) || BUY.def));
    await store.update(FILE, {}, (d) => { d.follows ||= {}; const f = (d.follows[lc(s.address)] ||= {}); f[id] = { on: body?.on !== false, buyEth, at: Date.now() }; return d; });
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "champions.follow", summary: body?.on === false ? `Stopped following ${id}` : `Following ${id} with ${buyEth} ETH a trade`, source: "app" });
    return { ok: true, agentId: id, on: body?.on !== false, buyEth, owner: getAddress(s.address) };
  }, { perMin: 20 });
}
