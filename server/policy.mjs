// Limits live here, outside any model. data/policy.json (operator) is re-read on every call;
// each user can only tighten them (data/limits.json) and can Pause at any time.
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

export const DEFAULT_POLICY = {
  killSwitch: false,
  maxLeverage: 10,
  perTradeUsd: 1000,
  dailyUsd: 5000,
  allowedPerps: [],          // empty = every Hyperliquid perp
  allowedTokens: [],         // empty = any Robinhood Chain token that passes Troya Gate
  blockedTokens: [],
  maxSlippagePct: 5,
  maxPriceImpactPct: 8,
  minPoolLiquidityEth: 0.25, // ETH on the pool's ETH side (or raised on a Pons curve)
  mcpDryRunDefault: true,
  freeMessagesPerDay: 20,
  agentWallet: { enabled: true, maxDailyUsd: 2000 },
  note: "Operator policy. Edit this file to change limits; it is re-read on every action.",
};

let store;
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v === "" || v == null || !isFinite(Number(v)) ? null : Number(v));

export async function operatorPolicy() {
  const p = await store.readJson("policy.json", null);
  if (!p) { await store.writeJson("policy.json", DEFAULT_POLICY); return structuredClone(DEFAULT_POLICY); }
  return { ...DEFAULT_POLICY, ...p, agentWallet: { ...DEFAULT_POLICY.agentWallet, ...(p.agentWallet || {}) } };
}

async function userLimits(address) {
  const all = await store.readJson("limits.json", {});
  return all[String(address).toLowerCase()] || {};
}

export async function usedToday(address) {
  const all = await store.readJson("usage.json", {});
  const u = all[String(address).toLowerCase()];
  return u && u.day === today() ? u.usd : 0;
}
export async function recordUsage(address, usd, source = null) {
  if (!(usd > 0)) return;
  await store.update("usage.json", {}, (all) => {
    const k = String(address).toLowerCase();
    const u = all[k] && all[k].day === today() ? all[k] : { day: today(), usd: 0 };
    u.usd = Math.round((u.usd + usd) * 100) / 100;
    // V8 F44 Scepter: what each job (autopilot, playbook, aegis…) spent today, for its own cap
    if (source) { u.bySource ||= {}; u.bySource[source] = Math.round(((u.bySource[source] || 0) + usd) * 100) / 100; }
    all[k] = u;
  });
}
export async function usedTodayBy(address) {
  const all = await store.readJson("usage.json", {});
  const u = all[String(address).toLowerCase()];
  return u && u.day === today() ? u.bySource || {} : {};
}
// V8 F44 Scepter: the jobs that act on their own. The trust ladder applies to them, never to a trade the user taps.
export const AUTO_JOBS = ["autopilot", "playbook", "aegis", "champions"];
export const TRUST = ["watch", "approve", "auto"];
// A wallet that never picked a step starts on Approve: every automated trade waits for the owner's yes until they climb
// to Auto themselves. Until 20 Nov 2026 an unset ladder meant Auto, so a brand-new user's jobs traded on their own while
// Scepter said "Climb at your pace". An explicit choice (stored by POST /api/policy) is always kept as it is.
export const DEFAULT_TRUST = "approve";

// Effective limits = the stricter of operator and user values.
export async function getPolicy(address) {
  const op = await operatorPolicy();
  const u = address ? await userLimits(address) : {};
  const min = (a, b) => (b == null ? a : Math.min(a, b));
  const perps = op.allowedPerps.length ? (u.allowedPerps?.length ? op.allowedPerps.filter((x) => u.allowedPerps.includes(x)) : op.allowedPerps) : (u.allowedPerps || []);
  return {
    operator: { killSwitch: !!op.killSwitch, maxLeverage: op.maxLeverage, perTradeUsd: op.perTradeUsd, dailyUsd: op.dailyUsd, allowedPerps: op.allowedPerps, maxSlippagePct: op.maxSlippagePct, maxPriceImpactPct: op.maxPriceImpactPct, minPoolLiquidityEth: op.minPoolLiquidityEth, mcpDryRunDefault: op.mcpDryRunDefault, freeMessagesPerDay: op.freeMessagesPerDay, agentWallet: op.agentWallet },
    user: u,
    effective: {
      killSwitch: !!op.killSwitch,
      paused: !!u.paused,
      maxLeverage: min(op.maxLeverage, num(u.maxLeverage)),
      perTradeUsd: min(op.perTradeUsd, num(u.perTradeUsd)),
      dailyUsd: min(op.dailyUsd, num(u.dailyUsd)),
      allowedPerps: perps,
      allowedTokens: op.allowedTokens,
      blockedTokens: op.blockedTokens,
      maxSlippagePct: op.maxSlippagePct,
      maxPriceImpactPct: op.maxPriceImpactPct,
      minPoolLiquidityEth: op.minPoolLiquidityEth,
      dryRun: u.dryRun == null ? !!op.mcpDryRunDefault : !!u.dryRun,
      trust: TRUST.includes(u.trust) ? u.trust : DEFAULT_TRUST,
      jobCaps: u.jobCaps || {},
    },
    usedTodayUsd: address ? await usedToday(address) : 0,
    usedTodayBySource: address ? await usedTodayBy(address) : {},
  };
}

// kind: swap | perp | send | withdraw | bridge | launch | watch
export async function checkAction(address, { kind, usd = 0, leverage = 1, market, token } = {}) {
  const p = await getPolicy(address);
  const e = p.effective;
  const reasons = [];
  if (e.killSwitch) reasons.push("The operator kill switch is on: all execution is stopped.");
  if (e.paused) reasons.push("You paused the agent. Resume it in Agent → Scepter.");
  if (usd > 0 && usd > e.perTradeUsd) reasons.push(`This is about $${usd.toFixed(2)}, above your per-trade cap of $${e.perTradeUsd}.`);
  if (usd > 0 && p.usedTodayUsd + usd > e.dailyUsd) reasons.push(`This would take today's total to $${(p.usedTodayUsd + usd).toFixed(2)}, above your daily cap of $${e.dailyUsd}.`);
  if (kind === "perp") {
    if (leverage > e.maxLeverage) reasons.push(`Leverage ${leverage}x is above your cap of ${e.maxLeverage}x.`);
    if (e.allowedPerps.length && market && !e.allowedPerps.includes(String(market).toUpperCase())) reasons.push(`${market} is not on your allowed markets list.`);
  }
  if (token) {
    const t = String(token).toLowerCase();
    if (e.blockedTokens.map((x) => String(x).toLowerCase()).includes(t)) reasons.push("This token is blocked by the operator.");
    if (e.allowedTokens.length && !e.allowedTokens.map((x) => String(x).toLowerCase()).includes(t)) reasons.push("This token is not on the operator's allowed list.");
  }
  return { ok: reasons.length === 0, reasons, effective: e, usedTodayUsd: p.usedTodayUsd };
}

export async function register(r, ctx) {
  store = ctx.store;
  await operatorPolicy(); // writes the default file on first run

  r.get("/api/policy", async ({ req }) => {
    const s = requireSession(req);
    return getPolicy(s.address);
  });
  r.get("/api/policy/public", async () => (await getPolicy(null)).operator);

  // Users may only tighten limits. Values above the operator caps are clamped.
  r.post("/api/policy", async ({ req, body }) => {
    const s = requireSession(req);
    const op = await operatorPolicy();
    const k = s.address.toLowerCase();
    await store.update("limits.json", {}, (all) => {
      const u = all[k] || {};
      const clampNum = (v, max) => { const n = num(v); return n == null ? undefined : Math.max(0, Math.min(n, max)); };
      if ("perTradeUsd" in body) u.perTradeUsd = clampNum(body.perTradeUsd, op.perTradeUsd);
      if ("dailyUsd" in body) u.dailyUsd = clampNum(body.dailyUsd, op.dailyUsd);
      if ("maxLeverage" in body) u.maxLeverage = clampNum(body.maxLeverage, op.maxLeverage);
      if ("allowedPerps" in body) u.allowedPerps = Array.isArray(body.allowedPerps) ? body.allowedPerps.map((x) => String(x).toUpperCase().replace(/[^A-Z0-9:_-]/g, "")).filter(Boolean).slice(0, 100) : [];
      if ("paused" in body) u.paused = !!body.paused;
      if ("dryRun" in body) u.dryRun = !!body.dryRun;
      if ("trust" in body && TRUST.includes(body.trust)) u.trust = body.trust;
      if ("jobCaps" in body && body.jobCaps && typeof body.jobCaps === "object") {
        const jc = {};
        for (const j of AUTO_JOBS) { const n = clampNum(body.jobCaps[j], op.dailyUsd); if (n != null) jc[j] = n; }
        u.jobCaps = jc;
      }
      for (const key of Object.keys(u)) if (u[key] === undefined) delete u[key];
      u.updatedAt = Date.now();
      all[k] = u;
    });
    const { logAction } = await import("./journal.mjs");
    if ("paused" in body) await logAction({ address: s.address, kind: body.paused ? "pause" : "resume", summary: body.paused ? "Agent paused" : "Agent resumed", source: "app" });
    else await logAction({ address: s.address, kind: "limits", summary: "Limits updated", data: body, source: "app" });
    return getPolicy(s.address);
  });
}
