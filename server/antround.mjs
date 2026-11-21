// Arena: Anthropic Round. The five AI traders each take a view on Anthropic through xyz:ANT, the trade.xyz perp on
// Hyperliquid that tracks the Nasdaq share since the 19 Nov 2026 IPO: long, short or flat, 1-3x, a stop and a target.
// Paper first: a $10 stake each, priced on the live mark, every call and close sealed. Live (ANT_ROUND_LIVE=1, after the
// owner funds the Arena's Hyperliquid account and approves the Arena Agent Wallet as its agent): the same calls go out
// through executeForUser (kind perp / close: Troya Gate, caps) for the Arena owner, $10 of margin a trader.
//   GET /api/arena/anthropic     the round: mark, each trader's open call and record, recent closes
import { randomBytes } from "node:crypto";
import { tidyThesis } from "./arena.mjs";

const FILE = "antround.json";
const COIN = "xyz:ANT", STAKE = 10, MAX_LEV = 3, ROUND_MS = 6 * 3600_000, HOLD_MS = 24 * 3600_000, TICK_MS = 60_000;
const LIVE = () => process.env.ANT_ROUND_LIVE === "1" && /^0x[0-9a-fA-F]{40}$/.test(process.env.ARENA_LIVE_OWNER || "");
let store = null, busy = false;

async function market() {
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }), signal: AbortSignal.timeout(10_000) });
  const [meta, ctx] = await r.json();
  const i = (meta.universe || []).findIndex((a) => a.name === COIN);
  if (i < 0) throw new Error("xyz:ANT is not listed");
  const c = ctx[i];
  return { mark: Number(c.markPx), prev: Number(c.prevDayPx), oi: Number(c.openInterest) * Number(c.markPx), volume24h: Number(c.dayNtlVlm), funding: Number(c.funding), maxLeverage: meta.universe[i].maxLeverage };
}
const pnlPct = (c, mark) => (c.side === "short" ? -1 : 1) * (mark / c.entry - 1) * c.lev * 100;

async function ask(agent, m, d) {
  const llm = await import("./llm.mjs");
  if (!llm.llmOn() || !(await llm.underCap())) return null;
  const past = (d.calls || []).filter((c) => c.agent === agent.id && c.status === "closed").slice(0, 5).map((c) => `${c.side} ${c.lev}x → ${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(1)}% (${c.reason})`).join("; ") || "none yet";
  const system = `You are ${agent.name}, an AI trader in Troya's Arena. This round you trade one market: Anthropic (ANT), the company behind Claude, through the trade.xyz perpetual xyz:ANT on Hyperliquid, which tracks the Nasdaq share. Facts: Anthropic priced its IPO at $83 a share on 18 Nov 2026 (range had been $70-78), opened around $110-111.50 on 19 Nov, touched $114.99, and closed near $97 by one report. You get a $10 stake. Decide long, short or flat, leverage 1 to ${MAX_LEV}, a stop loss % and a take profit % on your stake (leveraged move), for a hold of up to 24 hours. Be disciplined: a flat call is fine. Answer with one JSON object only: {"side":"long"|"short"|"flat","leverage":1-${MAX_LEV},"stopPct":5-60,"takeProfitPct":5-150} and then one line starting with THESIS: (under 25 words).`;
  const user = `Now: mark $${m.mark.toFixed(2)}, previous day $${m.prev.toFixed(2)} (${((m.mark / m.prev - 1) * 100).toFixed(2)}%), 24 h volume $${Math.round(m.volume24h / 1e6)}M, open interest $${Math.round(m.oi / 1e6)}M, funding ${(m.funding * 100).toFixed(4)}% an hour. Your last calls: ${past}.`;
  const out = await llm.ask({ system, user, model: agent.model, maxTokens: 600, temperature: 0.5 }).catch(() => "");
  const j = out.match(/\{[\s\S]*?\}/);
  let x = null; try { x = j ? JSON.parse(j[0]) : null; } catch { x = null; }
  if (!x || !["long", "short", "flat"].includes(x.side)) return null;
  return { side: x.side, lev: Math.max(1, Math.min(MAX_LEV, Math.round(Number(x.leverage) || 1))), stopPct: Math.max(5, Math.min(60, Number(x.stopPct) || 25)),
    tpPct: Math.max(5, Math.min(150, Number(x.takeProfitPct) || 30)), thesis: tidyThesis(out.match(/THESIS:\s*(.+)/i)?.[1]) };
}

async function tick() {
  if (busy || !store) return;
  busy = true;
  try {
    const m = await market();
    const d = await store.readJson(FILE, {});
    d.calls ||= [];
    const aw = LIVE() ? await import("./agentwallet.mjs") : null;
    // close what hit its stop, its target or the 24-hour limit
    for (const c of d.calls.filter((x) => x.status === "open")) {
      const p = pnlPct(c, m.mark);
      const reason = p <= -c.stopPct ? "stop" : p >= c.tpPct ? "take-profit" : Date.now() - c.at > HOLD_MS ? "time" : null;
      if (!reason) { c.nowPct = +p.toFixed(2); continue; }
      Object.assign(c, { status: "closed", closedAt: Date.now(), exit: m.mark, pnlPct: +p.toFixed(2), pnlUsd: +((STAKE * p) / 100).toFixed(2), reason });
      if (c.live?.opened && aw) {
        const r = await aw.executeForUser(process.env.ARENA_LIVE_OWNER, { kind: "close", params: { coin: COIN, sizePct: 100 }, rationale: `Arena Anthropic Round: ${c.agent} ${reason}`, source: "arena" }).catch((e) => ({ error: e.message }));
        c.live.closed = !!r?.executed; c.live.closeResult = r?.executed ? (r.summary || "closed") : (r?.error || (r?.reasons || []).join(" ")).slice(0, 200);
      }
      import("./seal.mjs").then((s) => s.seal("arena-ant-close", c.agent, c, `${c.agent} closed ANT ${c.side}: ${reason}`)).catch(() => {});
    }
    // a new call for each AI trader without one, once per round
    const arena = await store.readJson("arena.json", {});
    const ais = Object.values(arena.agents || {}).filter((a) => a.kind === "ai");
    for (const a of ais) {
      if (d.calls.some((c) => c.agent === a.id && c.status === "open")) continue;
      const last = d.calls.find((c) => c.agent === a.id);
      if (last && Date.now() - last.at < ROUND_MS) continue;
      const v = await ask(a, m, d);
      if (!v) continue;
      const c = { id: randomBytes(6).toString("hex"), agent: a.id, name: a.name, model: a.model, side: v.side, lev: v.lev, stopPct: v.stopPct, tpPct: v.tpPct, thesis: v.thesis, entry: m.mark, at: Date.now(), status: v.side === "flat" ? "closed" : "open", stake: STAKE };
      if (v.side === "flat") Object.assign(c, { closedAt: Date.now(), exit: m.mark, pnlPct: 0, pnlUsd: 0, reason: "flat" });
      if (v.side !== "flat" && aw) {
        const r = await aw.executeForUser(process.env.ARENA_LIVE_OWNER, { kind: "perp", params: { coin: COIN, side: v.side, sizeUsd: STAKE * v.lev, leverage: v.lev }, rationale: `Arena Anthropic Round: ${a.name} ${v.side} ${v.lev}x.${v.thesis ? ` ${v.thesis}` : ""}`, source: "arena" }).catch((e) => ({ error: e.message }));
        c.live = { opened: !!r?.executed, result: r?.executed ? (r.summary || "opened") : (r?.error || (r?.reasons || []).join(" ")).slice(0, 200) };
      }
      d.calls.unshift(c);
      import("./seal.mjs").then((s) => s.seal("arena-ant-open", a.id, c, `${a.name} ${c.side} ANT ${c.lev}x`)).catch(() => {});
    }
    d.calls = d.calls.slice(0, 600);
    d.mark = m; d.at = Date.now();
    await store.update(FILE, {}, (x) => ({ ...x, calls: d.calls, mark: d.mark, at: d.at }));
  } catch (e) { console.warn("[antround]", e.message); }
  finally { busy = false; }
}

// calls stored before theses were tidied on write (cut at exactly 200 characters, or a cut-short reply) read cleanly too
const pub = (c) => ({ ...c, thesis: tidyThesis(c.thesis) });

export async function register(r, ctx) {
  store = ctx.store;
  setInterval(() => tick().catch(() => {}), TICK_MS).unref?.();
  setTimeout(() => tick().catch(() => {}), 20_000);
  r.get("/api/arena/anthropic", async () => {
    const d = await store.readJson(FILE, {});
    const calls = d.calls || [];
    const by = {};
    for (const c of calls) {
      const b = (by[c.agent] ||= { agent: c.agent, name: c.name, model: c.model, closed: 0, pnlUsd: 0, wins: 0, open: null });
      if (c.status === "open" && !b.open) b.open = pub(c);
      if (c.status === "closed" && c.reason !== "flat") { b.closed++; b.pnlUsd += c.pnlUsd || 0; if ((c.pnlUsd || 0) > 0) b.wins++; }
    }
    return { name: "Arena: Anthropic Round", coin: COIN, mark: d.mark || null, at: d.at || null, stake: STAKE, live: LIVE(),
      traders: Object.values(by).map((b) => ({ ...b, pnlUsd: +b.pnlUsd.toFixed(2) })).sort((a, b) => b.pnlUsd - a.pnlUsd),
      recent: calls.slice(0, 25).map(pub), how: `Each AI trader takes a view on Anthropic (xyz:ANT, the trade.xyz perp that tracks the Nasdaq share) every ${ROUND_MS / 3600_000} hours when it has no open call: long, short or flat, 1-${MAX_LEV}x, a stop and a target on a $${STAKE} stake, closed at the stop, the target or after 24 hours. ${LIVE() ? "Live: the calls trade real money on the Arena's Hyperliquid account." : "Paper for now: priced on the live mark, every call sealed."}` };
  }, { weight: 1 });
}
