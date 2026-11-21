// V7 F33 Council. Before a buy: Counsel gives the three strongest reasons NOT to buy, ranked from Troya's own data, then
// a bull, a bear and a risk agent argue the coin out. The agents see only a numbered fact sheet built from Troya Gate,
// The Assay, Ring Radar, Quantum-Ready and The Record's base rates; every argument has to cite fact ids, and free text from
// the internet (X posts, websites) is never shown to them, so a coin cannot prompt-inject its own verdict.
// The verdict is sealed (V7 F35) like every other Troya decision. Not financial advice is not printed; the facts are.
//   GET /api/council/:token     the fact sheet, Counsel's three reasons, the debate and the verdict (cached 30 min)
import { getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const memo = new Map();
const lc = (s) => String(s || "").toLowerCase();
const pctTxt = (x) => (x == null ? "unknown" : `${(+x).toFixed(1)}%`);

async function facts(token) {
  const t = getAddress(token);
  const [{ gateCheck }, { verdict }, assayM, ringM, qM, recM, smM] = await Promise.all([
    import("./robinhood.mjs"), import("./sentry.mjs"), import("./assay.mjs"), import("./ringradar.mjs"), import("./quantum.mjs"), import("./record.mjs"), import("./smartmoney.mjs")]);
  const [g, a, ring, q, rec, sm] = await Promise.all([
    gateCheck({ tokenIn: "ETH", tokenOut: t, amountIn: "0.01", slippageBps: 100 }).catch(() => null),
    assayM.assay(t, { deep: false, waitMs: 12000 }).catch(() => null),
    ringM.ringCheck(t).catch(() => null),
    qM.tokenExposure(t).catch(() => null),
    recM.recordView({ limit: 1 }).catch(() => null),
    smM.smartIn(t).catch(() => null),
  ]);
  const F = [];
  const add = (id, text, kind = "fact") => F.push({ id, kind, text });
  if (g) {
    const vd = verdict(g);
    add("G0", `Troya Gate verdict for a 0.01 ETH buy: ${vd.v}${vd.why ? ` (${vd.why.label}: ${vd.why.detail})` : ""}`);
    g.checks.forEach((c, i) => add(`G${i + 1}`, `Gate ${c.key}: ${c.status}${c.detail ? ` - ${String(c.detail).slice(0, 140)}` : ""}`));
    if (g.quote?.priceImpact != null) add("G9", `Price impact of 0.01 ETH: ${(g.quote.priceImpact * 100).toFixed(2)}%`);
  }
  if (a?.status === "done") {
    add("A0", `Dev holds ${pctTxt(a.dev?.holdsPct)} of supply and has sold ${pctTxt(a.dev?.soldPct)} of what it received`);
    add("A1", `Top 10 holders hold ${pctTxt(a.holders?.top10Pct)}`);
    (a.flags || []).filter((f) => f.key !== "partial").slice(0, 6).forEach((f, i) => add(`A${i + 2}`, `Assay flag (${f.level}): ${f.title}${f.detail ? ` - ${String(f.detail).slice(0, 140)}` : ""}`));
  } else add("A0", "The Assay (dev, holders, bundles) has no finished reading yet");
  if (ring && ring.verdict !== "unknown") {
    add("R0", `Ring Radar: ${ring.verdict}`);
    (ring.reasons || []).slice(0, 4).forEach((r, i) => add(`R${i + 1}`, `Ring Radar: ${r}`));
  }
  if (q) add("Q0", `Quantum-Ready: ${q.summary}`);
  const app = await import("./radar.mjs").then((m) => m.appStatus(t)).catch(() => null);
  if (app?.listed) add("P0", `Robinhood app: this coin is ${app.tradable ? "tradable in the Robinhood app" : "shown in the Robinhood app with a price, not tradable there"}`);
  if (sm?.summary) add("M0", `Smart money: ${sm.summary}${sm.baseRate != null ? ` (base rate of early buyers: ${Math.round(sm.baseRate * 100)}% of graded coins reached 2x)` : ""}`);
  const st = rec?.stats;
  if (st?.graded) {
    add("S0", `Base rate from The Record: of ${st.graded} coins Troya Sentry called and graded after 24 hours, ${Math.round((st.winRate || 0) * 100)}% were higher; the median 24 h change was ${st.median24h != null ? Number(st.median24h).toFixed(0) + "%" : "unknown"}`);
    if (st.reachedOf) add("S1", `Base rate: ${st.reached2x} of ${st.reachedOf} called coins ever reached 2x their call price`);
  }
  return { token: t, symbol: g?.quote?.tokenOut?.symbol || ring?.symbol || null, facts: F, raw: { gateVerdict: g ? verdict(g).v : null, ring: ring?.verdict || null, assayRed: (a?.flags || []).filter((f) => f.level === "red").length } };
}

// Counsel: ranked from the facts alone, no model needed
function counsel(fs) {
  const score = (f) => (/fail|red|honeypot|cannot be sold|reverted/i.test(f.text) ? 100 : (/warn|amber|caution|exempt|bundle|decoy/i.test(f.text) || /sold (?!0(\.0+)?%)\d/i.test(f.text)) ? 60 : /Base rate/.test(f.text) ? 40 : /impact/i.test(f.text) ? 30 : /exposed/i.test(f.text) ? 15 : 0);
  // a clear reading ("Ring Radar: clear", "No exempt wallets…", "No wallet from the smart board…") is never a reason not to buy
  return fs.filter((f) => score(f) > 0 && !/: pass\b|verdict for a 0\.01 ETH buy: passed|: clear\b|: No |Smart money/.test(f.text)).sort((a, b) => score(b) - score(a)).slice(0, 3).map((f) => ({ fact: f.id, reason: f.text }));
}

async function debate(pack) {
  const llm = await import("./llm.mjs");
  if (!llm.llmOn() || !(await llm.underCap())) return null;
  const sheet = pack.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  // plain lines, not JSON: a reply cut short still keeps every finished line
  const system = "You are the Troya Council: three analysts (bull, bear, risk) debating one Robinhood Chain token. Use ONLY the numbered facts given. Every point must cite at least one fact id in brackets, like [G2]. Never invent numbers, never use outside knowledge, never give price targets. Answer in exactly this format, one point per line, each under 110 characters:\nVERDICT: pass|caution|avoid\nBULL: ...\nBULL: ...\nBEAR: ...\nBEAR: ...\nRISK: ...\nRISK: ...\nSUMMARY: one sentence";
  const text = await llm.chatWithTools({ system, user: `Token ${pack.symbol ? "$" + pack.symbol : pack.token}\nFacts:\n${sheet}`, tools: [], exec: async () => null, maxSteps: 1 })
    .catch((e) => { console.warn("[council] llm", e.message); return ""; });
  const ids = new Set(pack.facts.map((f) => f.id));
  const cites = (s) => (s.match(/\[([A-Z]\d+)\]/g) || []).some((x) => ids.has(x.slice(1, -1)));
  const out = { bull: [], bear: [], risk: [], verdict: null, summary: "", model: llm.llmModel() };
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.replace(/^[\s*-]+/, "").match(/^(VERDICT|BULL|BEAR|RISK|SUMMARY)\s*:\s*(.+)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim().slice(0, 220);
    if (k === "verdict") { const w = v.toLowerCase().match(/pass|caution|avoid/); if (w) out.verdict = w[0]; }
    else if (k === "summary") out.summary = v.slice(0, 240);
    else if (cites(v) && out[k].length < 3) out[k].push(v);
  }
  if (!out.bull.length && !out.bear.length && !out.risk.length) { console.warn("[council] no usable lines:", String(text).slice(0, 160)); return null; }
  out.verdict ||= "caution";
  return out;
}

export async function council(token) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "That is not a token address on Robinhood Chain.");
  const k = lc(token);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const pack = await facts(token);
  const reasons = counsel(pack.facts);
  const d = await debate(pack);
  // the floor: a failed Gate or a red Ring Radar can never come out as "pass", whatever the debate says
  let v = d?.verdict || (pack.raw.gateVerdict === "failed" || pack.raw.ring === "red" ? "avoid" : reasons.length >= 2 ? "caution" : "pass");
  if ((pack.raw.gateVerdict === "failed" || pack.raw.ring === "red" || pack.raw.assayRed) && v === "pass") v = "caution";
  if (pack.raw.gateVerdict === "failed") v = "avoid";
  const out = { token: pack.token, symbol: pack.symbol, verdict: v, counsel: reasons, debate: d, facts: pack.facts, at: Date.now(),
    note: "Every point cites Troya's own data; nothing from X or websites reaches the agents." };
  const rec = await import("./seal.mjs").then((m) => m.seal("council", pack.token, { verdict: v, counsel: reasons, debate: d, facts: pack.facts.map((f) => f.id + " " + f.text) }, v)).catch(() => null);
  out.receipt = rec?.hash || null;
  memo.set(k, { at: Date.now(), v: out });
  return out;
}

export function councilText(c) {
  const sym = c.symbol ? `$${c.symbol}` : c.token.slice(0, 10) + "…";
  const lines = [`Troya Council on ${sym}: ${c.verdict.toUpperCase()}`];
  if (c.counsel.length) { lines.push("", "Three reasons not to buy:"); c.counsel.forEach((r, i) => lines.push(`${i + 1}. ${r.reason}`)); }
  if (c.debate) {
    if (c.debate.bull.length) lines.push("", "Bull:", ...c.debate.bull.map((s) => `+ ${s}`));
    if (c.debate.bear.length) lines.push("", "Bear:", ...c.debate.bear.map((s) => `- ${s}`));
    if (c.debate.risk.length) lines.push("", "Risk:", ...c.debate.risk.map((s) => `! ${s}`));
    if (c.debate.summary) lines.push("", c.debate.summary);
  }
  if (c.receipt) lines.push("", `Sealed: troya.codes/api/seal/r/${c.receipt}`);
  return lines.join("\n");
}

// Council sittings a minute (owner, 21 Nov 2026: $TROYA stakers get their tier's aiQuotaX on the Council too). The budget is
// the one the router held per IP before (weight 6 against 10 a minute: one sitting a minute, the window starting at the
// first call), now counted here: per IP as before, or per signed-in wallet with its stake multiplier once the stake perks
// are on. The router's own bucket for this route is set wide enough (60) for a Gold staker; its global per-IP ceiling is
// unchanged. Without stake perks this is exactly the old limit and the same 429.
const COST = 6, BUDGET = 10, sittings = new Map();
function overBudget(key, x) {
  const now = Date.now();
  let b = sittings.get(key);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; sittings.set(key, b); }
  b.n += COST;
  if (sittings.size > 20000) for (const [k, v] of sittings) if (now - v.t > 60_000) sittings.delete(k);
  return b.n > BUDGET * x;
}
async function stakeX(req) {
  const s = await import("./auth.mjs").then((m) => m.getSession(req)).catch(() => null);
  if (!s?.address) return { x: 1 };
  const p = await import("./stake.mjs").then((m) => m.activePerks(s.address)).catch(() => null);
  const x = Number(p?.aiQuotaX);
  return x > 1 && isFinite(x) ? { x: Math.min(x, 10), address: lc(s.address) } : { x: 1 };
}

export async function register(r) {
  r.get("/api/council/:token", async ({ req, params, ip }) => {
    const { x, address } = await stakeX(req);
    if (overBudget(x > 1 ? `w:${address}` : `ip:${ip}`, x)) throw new HttpError(429, "Too many requests, slow down.");
    return council(params.token);
  }, { weight: 6, perMin: 60 });
}
