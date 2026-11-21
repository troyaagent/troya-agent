// V7 F34 Arena: Strategist and Proving Ground in one, and a public arena of AI traders. Paper money only for now.
//   Strategist: a strategy in plain words becomes rules (a model reads the words; a plain parser is the fallback), and the
//     rules are replayed at once on every coin The Record has graded (take-profit, stop and hold time against each call's
//     peak, low and 1 h / 24 h price; when a coin hit both the stop and the target, the stop counts, so the replay errs low).
//   Proving Ground: "prove it" runs the rules for 7 days on paper at real prices on every launch Troya Sentry passes. After
//     7 days with 5+ closed trades and a profit, the strategy is proven and can earn small live caps once live trading opens.
//   AI arena: five AI models (Claude, GPT, Gemini, DeepSeek, Qwen) each write their own rules every day from The Record's
//     base rates and their own results, then trade them on paper side by side. Every strategy, entry and exit is sealed.
//   GET  /api/arena                 the board: every trader, its rules, results and recent trades
//   POST /api/arena/strategy        { text } → rules, the model's reading, and the replay on The Record      (session)
//   POST /api/arena/prove           { text, rules } → start (or restart) your 7-day paper run                 (session)
//   GET  /api/arena/me              your strategy, its run and its trades                                     (session)
import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "arena.json";
const PROVE_MS = 7 * 86_400_000, TICK_MS = 2 * 60_000;
const AI = [
  { id: "ai-claude", name: "Claude", model: "anthropic/claude-haiku-5.5" },
  { id: "ai-gpt", name: "GPT", model: "openai/gpt-5-nano" },
  { id: "ai-gemini", name: "Gemini", model: "google/gemini-2.5-flash-lite" },
  { id: "ai-deepseek", name: "DeepSeek", model: "deepseek/deepseek-v4-flash" },
  { id: "ai-qwen", name: "Qwen", model: "qwen/qwen3-235b-a22b-2507" },
];
const LIM = { minRaisedEth: [0, 4.2], maxRaisedEth: [0, 4.2], buyEth: [0.001, 0.05], takeProfitX: [1.05, 20], stopPct: [5, 95], maxHoldHours: [1, 168], maxOpen: [1, 10], maxBuysPerDay: [1, 30] };
const DEF = { minRaisedEth: 0.5, maxRaisedEth: 4.2, buyEth: 0.01, takeProfitX: 2, stopPct: 30, maxHoldHours: 24, maxOpen: 3, maxBuysPerDay: 5, skipRingRed: true, skipRingAmber: false, source: "any" };
const lc = (s) => String(s || "").toLowerCase();
let store = null, busy = false;

export function cleanRules(x = {}, base = DEF) {
  const o = { ...base };
  for (const [k, [lo, hi]] of Object.entries(LIM)) { const v = Number(x[k]); if (isFinite(v) && x[k] !== "" && x[k] != null) o[k] = Math.min(hi, Math.max(lo, v)); }
  if (o.maxRaisedEth < o.minRaisedEth) o.maxRaisedEth = Math.min(4.2, o.minRaisedEth + 0.5);
  for (const k of ["skipRingRed", "skipRingAmber"]) if (typeof x[k] === "boolean") o[k] = x[k];
  if (["any", "pons", "pool"].includes(x.source)) o.source = x.source;
  for (const k of ["maxOpen", "maxBuysPerDay", "maxHoldHours"]) o[k] = Math.round(o[k]);
  return o;
}
// A thesis is shown whole or cut cleanly: a reply over 200 characters ends at its last full sentence, or else at its last
// whole word with "…", never mid-word ("…buy size, and "). A thesis under 25 characters is almost always a reply the
// model's token limit cut short ("Expect near"), so it is dropped rather than shown. Applied when a thesis is written and
// again when it is read, so theses stored before this fix (cut at exactly 200 characters) read cleanly too.
export function tidyThesis(s, max = 200) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 25) return null;
  const ends = /[.!?…)"'”]$/.test(t);
  if (t.length < max || (t.length === max && ends)) return ends ? t : `${t}…`;   // a reply that stops without a full stop was cut short
  const head = t.slice(0, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) cut = m.index;
  if (cut >= max / 2) return head.slice(0, cut + 1);
  const room = t.slice(0, max - 1);                       // one character left for the "…"
  const sp = t[max - 1] === " " ? room.length : room.lastIndexOf(" ");
  const word = (sp >= 25 ? room.slice(0, sp) : room).replace(/[\s,;:–—-]+$/, "");
  return word.length >= 25 ? `${word}…` : null;
}
export const rulesText = (r) => `buy ${r.buyEth} ETH when the curve raised ${r.minRaisedEth}–${r.maxRaisedEth} ETH${r.source !== "any" ? ` (${r.source} only)` : ""}${r.skipRingRed ? ", skip Ring Radar red" : ""}${r.skipRingAmber ? " and amber" : ""}; take profit at ${r.takeProfitX}x, stop at -${r.stopPct}%, out after ${r.maxHoldHours} h; at most ${r.maxOpen} open, ${r.maxBuysPerDay} buys a day`;

const RULES_SPEC = `JSON keys (all optional): minRaisedEth (0-4.2, ETH the Pons curve raised before the buy), maxRaisedEth (0-4.2), buyEth (0.001-0.05), takeProfitX (1.05-20, e.g. 2 = sell at 2x), stopPct (5-95, sell after this % loss), maxHoldHours (1-168), maxOpen (1-10), maxBuysPerDay (1-30), skipRingRed (true/false: skip launches Ring Radar calls rigged), skipRingAmber (true/false), source ("any" | "pons" for coins still on their Pons curve | "pool" for coins in a Uniswap pool).`;

/* ---------- replay on The Record ---------- */
export async function replay(rules) {
  const rec = await store.readJson("record.json", {});
  const calls = Object.values(rec.calls || {}).filter((c) => c.p0 > 0 && c.peak > 0 && c.low > 0 && c.status === "graded" && c.source !== "x" && c.kind !== "born")
    .filter((c) => rules.source === "any" || (rules.source === "pool" ? /uniswap/i.test(c.source || "") : !c.source)).sort((a, b) => a.at - b.at);
  const perDay = new Map(), trades = [];
  for (const c of calls) {
    const d = new Date(c.at).toISOString().slice(0, 10);
    if ((perDay.get(d) || 0) >= rules.maxBuysPerDay) continue;
    perDay.set(d, (perDay.get(d) || 0) + 1);
    const tp = c.p0 * rules.takeProfitX, sl = c.p0 * (1 - rules.stopPct / 100);
    const exitPx = rules.maxHoldHours <= 1 && c.p1h ? c.p1h : c.p24h || c.now;
    let ret, how;
    if (c.low <= sl) { ret = -rules.stopPct / 100; how = "stop"; }
    else if (c.peak >= tp) { ret = rules.takeProfitX - 1; how = "take-profit"; }
    else { ret = exitPx / c.p0 - 1; how = "time"; }
    trades.push({ symbol: c.symbol, at: c.at, ret, how });
  }
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.ret * rules.buyEth; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const wins = trades.filter((t) => t.ret > 0).length;
  return { trades: trades.length, wins, winRate: trades.length ? +(wins / trades.length).toFixed(3) : null, avgReturnPct: trades.length ? +((trades.reduce((s, t) => s + t.ret, 0) / trades.length) * 100).toFixed(1) : null,
    pnlEth: +eq.toFixed(5), maxDrawdownEth: +dd.toFixed(5), byExit: { takeProfit: trades.filter((t) => t.how === "take-profit").length, stop: trades.filter((t) => t.how === "stop").length, time: trades.filter((t) => t.how === "time").length },
    from: trades[0]?.at || null, to: trades.at(-1)?.at || null,
    caveats: "Replayed on coins Troya Sentry called (it already filtered out failed ones). The curve-raised and Ring Radar filters are not in The Record, so they apply only live. When a coin hit both the stop and the target, the stop counts. Past results, not a promise." };
}

/* ---------- plain words → rules ---------- */
async function readStrategy(text, model) {
  const llm = await import("./llm.mjs");
  const system = `You turn a trader's strategy for new Robinhood Chain memecoins (Pons launches that already passed Troya Gate) into rules. ${RULES_SPEC} Reply with exactly two lines: line 1 the JSON object, line 2 "THESIS: " and the strategy in one plain sentence. No other text.`;
  const out = await llm.ask({ system, user: String(text).slice(0, 800), model, maxTokens: 1200, temperature: 0.1 }).catch(() => "");
  const m = out.match(/\{[\s\S]*?\}/);
  let rules = null;
  try { rules = m ? cleanRules(JSON.parse(m[0])) : null; } catch {}
  if (!rules) { const { parseRules } = await import("./autopilot.mjs"); rules = cleanRules(parseRules(String(text)) || {}); }
  const thesis = tidyThesis(out.match(/THESIS:\s*(.+)/i)?.[1]);
  return { rules, thesis };
}

/* ---------- the AI traders write their own rules once a day ---------- */
async function aiDaily(d) {
  const llm = await import("./llm.mjs");
  if (!llm.llmOn() || !(await llm.underCap())) return;
  const rec = await import("./record.mjs").then((m) => m.recordView({ limit: 1 })).catch(() => null);
  const st = rec?.stats || {};
  const today = new Date().toISOString().slice(0, 10);
  for (const a of AI) {
    const ag = (d.agents[a.id] ||= { id: a.id, kind: "ai", name: a.name, model: a.model, rules: { ...DEF }, createdAt: Date.now(), status: "proving", provingUntil: Date.now() + PROVE_MS, history: [] });
    ag.model = a.model; ag.name = a.name;
    if (ag.day === today || (ag.tryAt && Date.now() - ag.tryAt < 30 * 60_000)) continue;     // one try per half hour until it lands
    ag.tryAt = Date.now();
    const mine = (d.positions || []).filter((p) => p.agent === a.id && p.status === "closed" && p.closedAt > Date.now() - PROVE_MS);
    const pnl = mine.reduce((s, p) => s + (p.pnlEth || 0), 0);
    const user = `Base rates from The Record: ${st.graded || "?"} coins called and graded, ${Math.round((st.winRate || 0) * 100)}% higher after 24 h, median 24 h change ${st.median24h != null ? Number(st.median24h).toFixed(0) : "?"}%, ${st.reached2x ?? "?"} of ${st.reachedOf ?? "?"} reached 2x.\nYour current rules: ${JSON.stringify(ag.rules)}\nYour last 7 days on paper: ${mine.length} closed trades, ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} ETH, ${mine.filter((p) => p.pnlEth > 0).length} winners.\nWrite your rules for today. Keep what works, change what does not.`;
    const system = `You are ${a.name}, an AI trader in Troya's Arena on Robinhood Chain, trading paper money on new memecoin launches that already passed Troya Gate, against other AI models. Your goal is the best result after costs with controlled losses. ${RULES_SPEC} Reply with exactly two lines: line 1 the JSON object, line 2 "THESIS: " and your plan in one sentence.`;
    const out = await llm.ask({ system, user, model: a.model, maxTokens: 1500, temperature: 0.5 }).catch((e) => { console.warn("[arena]", a.name, e.message); return ""; });
    const m = out.match(/\{[\s\S]*?\}/);
    let rules = null;
    try { rules = m ? cleanRules(JSON.parse(m[0])) : null; } catch {}
    if (!rules) { console.warn("[arena]", a.name, "no rules in:", out.slice(0, 120).replace(/\s+/g, " ")); continue; }
    ag.rules = rules; ag.thesis = tidyThesis(out.match(/THESIS:\s*(.+)/i)?.[1]); ag.day = today;
    ag.history = [{ at: Date.now(), rules, thesis: ag.thesis }, ...(ag.history || [])].slice(0, 14);
    import("./seal.mjs").then((s) => s.seal("arena-strategy", a.id, { model: a.model, rules, thesis: ag.thesis }, rulesText(rules).slice(0, 150))).catch(() => {});
  }
}


/* ---------- live money (ARENA_LIVE=1): the AI traders mirror their paper trades with real ETH ----------
   One Agent Wallet, owned by the operator's own wallet (ARENA_LIVE_OWNER), holds the arena's money: it can only ever
   withdraw back to that wallet, and every buy and sell goes through Troya Gate and the wallet's caps (executeForUser).
   Each AI trader has its own budget inside it (ARENA_LIVE_BUDGET_ETH, 0.01 ETH by default): a buy is at most
   ARENA_LIVE_BUY_ETH and never more than what the trader has left after its open positions and realized losses.
   Live positions follow their paper twin: opened on the same launch, closed when the paper one closes. */
// LIVE and LIVE_PAUSED are exported for Champions (V8 F43): a trader the Arena itself may not buy for with real money
// must not buy for its followers either, so champions.mjs reads the same switches.
export const LIVE = () => process.env.ARENA_LIVE === "1" && isAddr(process.env.ARENA_LIVE_OWNER);
// traders whose real-money twin is paused (ARENA_LIVE_PAUSE=ai-qwen,...): paper keeps trading, no new live buys, open live
// positions still close with their paper twin. 19 Nov 2026: Qwen's three live trades were all hit by coordinated dumps;
// paused until Ring Radar catches clusters that sell together (owner's decision).
export const LIVE_PAUSED = () => String(process.env.ARENA_LIVE_PAUSE || "").split(",").map((s) => s.trim()).filter(Boolean);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const LIVE_BUDGET = () => Number(process.env.ARENA_LIVE_BUDGET_ETH || 0.01);
const LIVE_BUY = () => Number(process.env.ARENA_LIVE_BUY_ETH || 0.002);

function liveEquity(d, agentId) {
  const ps = (d.positions || []).filter((p) => p.agent === agentId && p.mode === "live");
  const open = ps.filter((p) => p.status === "open").reduce((s, p) => s + p.amountEth, 0);
  const realized = ps.filter((p) => p.status === "closed").reduce((s, p) => s + (p.pnlEth || 0), 0);
  return LIVE_BUDGET() + realized - open;
}

async function walletTokenRaw(addr, token) {
  const { getBalances } = await import("./robinhood.mjs");
  const b = await getBalances(addr, [token]).catch(() => null);
  const h = b?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === token.toLowerCase());
  const eth = b?.balances?.find((x) => x.address === "native");
  return { raw: h ? BigInt(h.raw) : 0n, decimals: h?.decimals ?? 18, eth: eth ? Number(eth.amount) : NaN };
}

async function openLive(d, ag, paper) {
  if (LIVE_PAUSED().includes(ag.id)) return null;
  if (!LIVE() || ag.kind !== "ai") return null;
  const owner = process.env.ARENA_LIVE_OWNER;
  const aw = await (await import("./agentwallet.mjs")).getAgentWallet(owner).catch(() => null);
  if (!aw?.address || !aw.enabled) return null;
  const size = Math.min(paper.amountEth, LIVE_BUY(), liveEquity(d, ag.id));
  if (!(size >= 0.0005)) return null;
  const before = await walletTokenRaw(aw.address, paper.token);
  const amountIn = size.toFixed(6);
  const ex = await (await import("./agentwallet.mjs")).executeForUser(owner, { kind: "swap", params: { tokenIn: "ETH", tokenOut: paper.token, amountIn, slippagePct: 3 }, rationale: `Arena ${ag.name}: ${rulesText(cleanRules(ag.rules)).slice(0, 160)}`, source: "arena" }).catch((e) => ({ executed: false, reasons: [e.message] }));
  if (!ex.executed) { console.log(`[arena] live ${ag.name} skipped $${paper.symbol}: ${(ex.reasons || []).join(" ").slice(0, 120)}`); return null; }
  let after = before;
  for (let i = 0; i < 6; i++) { after = await walletTokenRaw(aw.address, paper.token); if (after.raw > before.raw) break; await new Promise((r) => setTimeout(r, 2500)); }
  const got = after.raw - before.raw;
  const pos = { id: randomBytes(6).toString("hex"), agent: ag.id, mode: "live", twin: paper.id, token: paper.token, symbol: paper.symbol, amountEth: Number(amountIn), tokensRaw: got.toString(), decimals: after.decimals,
    tokens: Number(got) / 10 ** after.decimals, openedAt: Date.now(), rules: paper.rules, status: "open", txBuy: (ex.result?.steps || []).at(-1)?.hash || null };
  // the receipt's hash stays on the position, so the board can link each trade to its proof
  pos.sealOpen = (await import("./seal.mjs").then((s) => s.seal("arena-live-open", pos.token, { agent: ag.id, ...pos }, `${ag.name} bought $${pos.symbol} with ${amountIn} ETH`)).catch(() => null))?.hash || null;
  console.log(`[arena] live ${ag.name} bought $${pos.symbol} for ${amountIn} ETH`);
  return pos;
}

// ETH a live sell really returned, read from its own transaction: the wallet's balance at the sell's block against the
// block before, plus the gas it paid. The Arena wallet is shared by every AI trader, so a plain before/after balance read
// can catch another trader's buy in between (20 Nov 2026: a real 0.00192 ETH exit was booked as 0). Only trusted when this
// wallet sent exactly one transaction in that block.
async function ethBackFromTx(wallet, hash) {
  if (!hash || !wallet) return null;
  const { rpc } = await import("./robinhood.mjs");
  let rc = null;
  for (let i = 0; i < 8 && !rc; i++) { rc = await rpc("robinhood", "eth_getTransactionReceipt", [hash]).catch(() => null); if (!rc) await new Promise((x) => setTimeout(x, 2000)); }
  if (!rc || rc.status !== "0x1") return null;
  const bn = Number(BigInt(rc.blockNumber)), h = (n) => "0x" + n.toString(16);
  const [b0, b1, n0, n1] = await Promise.all([
    rpc("robinhood", "eth_getBalance", [wallet, h(bn - 1)]), rpc("robinhood", "eth_getBalance", [wallet, h(bn)]),
    rpc("robinhood", "eth_getTransactionCount", [wallet, h(bn - 1)]), rpc("robinhood", "eth_getTransactionCount", [wallet, h(bn)]),
  ]);
  if (Number(BigInt(n1)) - Number(BigInt(n0)) !== 1) return null;
  const gas = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || "0x0");
  const back = BigInt(b1) - BigInt(b0) + gas;
  return back > 0n ? Number(back) / 1e18 : null;
}

async function closeLive(pos, why) {
  const owner = process.env.ARENA_LIVE_OWNER;
  const aw = await (await import("./agentwallet.mjs")).getAgentWallet(owner).catch(() => null);
  if (!aw?.address) return false;
  const have = await walletTokenRaw(aw.address, pos.token);
  const raw = BigInt(pos.tokensRaw || 0) < have.raw ? BigInt(pos.tokensRaw || 0) : have.raw;
  if (raw <= 0n) { Object.assign(pos, { status: "closed", closedAt: Date.now(), reason: "nothing left to sell", exitValueEth: 0, pnlEth: -pos.amountEth }); return true; }
  const amountIn = (Number(raw) / 10 ** (pos.decimals ?? 18) * 0.9999).toPrecision(12).replace(/\.?0+$/, "");
  const ethBefore = have.eth;
  const ex = await (await import("./agentwallet.mjs")).executeForUser(owner, { kind: "swap", params: { tokenIn: pos.token, tokenOut: "ETH", amountIn, slippagePct: 8 }, rationale: `Arena exit (${why}) on $${pos.symbol}`, source: "arena" }).catch((e) => ({ executed: false, reasons: [e.message] }));
  if (!ex.executed) { pos.lastError = (ex.reasons || []).join(" ").slice(0, 200); return false; }
  let ethAfter = ethBefore;
  for (let i = 0; i < 6; i++) { ethAfter = (await walletTokenRaw(aw.address, pos.token)).eth; if (isFinite(ethBefore) && ethAfter > ethBefore) break; await new Promise((r) => setTimeout(r, 2500)); }
  const txSell = (ex.result?.steps || []).at(-1)?.hash || null;
  const exact = await ethBackFromTx(aw.address, txSell).catch(() => null);
  const back = exact > 0 ? exact : isFinite(ethBefore) && ethAfter > ethBefore ? ethAfter - ethBefore : 0;
  Object.assign(pos, { status: "closed", closedAt: Date.now(), reason: why, exitValueEth: +back.toFixed(8), pnlEth: +(back - pos.amountEth).toFixed(8), txSell });
  pos.sealClose = (await import("./seal.mjs").then((s) => s.seal("arena-live-close", pos.token, { agent: pos.agent, id: pos.id, reason: why, exitValueEth: back, pnlEth: pos.pnlEth }, `${pos.agent} sold $${pos.symbol}: ${why}`)).catch(() => null))?.hash || null;
  console.log(`[arena] live ${pos.agent} sold $${pos.symbol}: ${why}, ${back.toFixed(6)} ETH back`);
  return true;
}

/* ---------- paper entries on every launch Sentry passes ---------- */
export async function onLaunch(r) {
  if (!store || r?.v !== "passed" || !r.token) return;
  const raised = r.pons && !r.pons.graduated && (r.pons.pair?.address === "native" || /ETH/i.test(r.pons.pair?.symbol || "")) ? Number(r.pons.raised) : null;
  const ring = (await import("./ringradar.mjs").catch(() => null))?.ringFlags(r.token)?.[0]?.level || null;
  const wfLevel = (await import("./watchfire.mjs").catch(() => null))?.watchfireState(r.token)?.level || null;
  const d = await store.readJson(FILE, {});
  const { quoteSwap } = await import("./tools.mjs");
  const opened = [];
  for (const ag of Object.values(d.agents || {})) {
    if (!["proving", "proven"].includes(ag.status)) continue;
    const R = cleanRules(ag.rules || {});
    if (R.source === "pons" && raised == null) continue;
    if (R.source === "pool" && raised != null) continue;
    if (raised != null && (raised < R.minRaisedEth || raised > R.maxRaisedEth)) continue;
    if (raised == null && R.minRaisedEth > 0 && R.source !== "pool") continue;
    if ((R.skipRingRed && ring === "red") || (R.skipRingAmber && ring === "amber")) continue;
    if (["red", "fire"].includes(wfLevel)) continue;
    const mine = (d.positions || []).filter((p) => p.agent === ag.id && p.mode !== "live");
    if (mine.some((p) => lc(p.token) === lc(r.token))) continue;
    if (mine.filter((p) => p.status === "open").length >= R.maxOpen) continue;
    if (mine.filter((p) => p.openedAt > Date.now() - 86_400_000).length >= R.maxBuysPerDay) continue;
    const q = await quoteSwap({ tokenIn: "ETH", tokenOut: r.token, amountIn: R.buyEth, slippagePct: 3 }).catch(() => null);
    if (!(q?.amountOut > 0)) continue;
    const pos = { id: randomBytes(6).toString("hex"), agent: ag.id, token: getAddress(r.token), symbol: r.symbol || q.tokenOut?.symbol || "?", amountEth: R.buyEth, tokens: Number(q.amountOut), openedAt: Date.now(), raisedAtEntry: raised, rules: { takeProfitX: R.takeProfitX, stopPct: R.stopPct, maxHoldHours: R.maxHoldHours }, status: "open" };
    opened.push(pos);
    const twin = await openLive(d, ag, pos).catch((e) => { console.warn("[arena] live open", e.message); return null; });
    if (twin) { d.positions = [...(d.positions || []), twin]; opened.push(twin); }
    pos.sealOpen = (await import("./seal.mjs").then((s) => s.seal("arena-open", pos.token, { agent: ag.id, ...pos }, `${ag.name || ag.id} bought $${pos.symbol}`)).catch(() => null))?.hash || null;
  }
  if (opened.length) await store.update(FILE, {}, (x) => { x.positions = [...(x.positions || []), ...opened]; return x; });
  // V8 F43 Champions: followers of these traders buy the same coin from their own Agent Wallets, only while the trader
  // qualifies (5+ live trades in profit, not paused: qualify() in champions.mjs) (not awaited)
  const papers = opened.filter((p) => p.mode !== "live");
  if (papers.length) import("./champions.mjs").then((m) => m.onArenaOpen(papers)).catch((e) => console.warn("[champions] open", e.message));
}

/* Stops and take-profits run on their own loop (19 Nov 2026): the first live trade's stop at -25% filled at -64% because
   the old 2-minute round was still busy after a restart and its next round was skipped, so the coin was first priced
   five minutes after the buy. Now: every 30 seconds while a live position is open (every 90 seconds on paper only),
   never waiting on the AI rules or the weekly verdicts, and the sell goes out before the receipt is written. */
let watchBusy = false, lastWatch = 0;
// V8 F39 Watchfire fires (gathering into one wallet, a whale sale): paper positions in that coin close at once. A live
// twin closes with it only when ARENA_WATCHFIRE_LIVE=1 (after its real-money test); until then the paper position is
// marked and keeps its normal stop, so paper and live stay one trade.
const WF = new Map();                                  // token → { at, kind, detail }
const WF_LIVE = () => process.env.ARENA_WATCHFIRE_LIVE === "1";
export function watchfireFire(token, f) {
  WF.set(lc(token), { at: Date.now(), kind: f?.kind, detail: f?.detail });
  lastWatch = 0;
  watch().catch(() => {});
}
async function watch() {
  if (watchBusy || !store) return;
  watchBusy = true;
  try {
    const d = await store.readJson(FILE, {});
    d.positions ||= [];
    const liveOpen = d.positions.some((x) => x.mode === "live" && x.status === "open");
    if (!liveOpen && Date.now() - lastWatch < 85_000) return;
    lastWatch = Date.now();
    const { valueOf } = await import("./autopilot.mjs");
    const t0 = Date.now();
    // every open position is priced at once, each within 15 s: one slow or stuck quote never holds up a stop on another
    const limit = (pr, ms) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error("quote timeout")), ms))]);
    const priced = async (list) => Promise.all(list.map((x) => limit(valueOf(x), 15_000).catch(() => null)));
    const closed = [], seals = [];
    const papers = d.positions.filter((x) => x.status === "open" && x.mode !== "live");
    const vals = await priced(papers);
    for (let k = 0; k < papers.length; k++) {
      const p = papers[k], v = vals[k];
      if (v == null) continue;
      p.lastValueEth = v; p.lastAt = Date.now();
      const ratio = v / p.amountEth;
      const wf = WF.get(lc(p.token));
      const wfHit = wf && wf.at > p.openedAt && Date.now() - wf.at < 10 * 60_000;
      const hasLive = d.positions.some((x) => x.mode === "live" && x.twin === p.id && x.status === "open");
      if (wfHit && !p.watchfire) p.watchfire = { at: wf.at, kind: wf.kind, detail: wf.detail };
      const why = ratio >= p.rules.takeProfitX ? "take-profit" : wfHit && (!hasLive || WF_LIVE()) ? "watchfire" : ratio <= 1 - p.rules.stopPct / 100 ? "stop" : Date.now() - p.openedAt > p.rules.maxHoldHours * 3600_000 ? "time" : null;
      if (!why) continue;
      Object.assign(p, { status: "closed", closedAt: Date.now(), reason: why, exitValueEth: v, pnlEth: v - p.amountEth });
      closed.push(p);
      const twin = d.positions.find((x) => x.mode === "live" && x.twin === p.id && x.status === "open");
      if (twin) await closeLive(twin, why).catch((e) => { twin.lastError = e.message; });
      seals.push(import("./seal.mjs").then((m) => m.seal("arena-close", p.token, { agent: p.agent, id: p.id, reason: why, exitValueEth: v, pnlEth: p.pnlEth }, `${p.agent} sold $${p.symbol}: ${why}`)).then((r) => { p.sealClose = r?.hash || null; }).catch(() => {}));
    }
    for (const t of d.positions.filter((x) => x.mode === "live" && x.status === "open" && x.lastError)) {
      const paper = d.positions.find((x) => x.id === t.twin);
      if (paper?.status === "closed") await closeLive(t, paper.reason || "retry").catch(() => {});
    }
    const lives = d.positions.filter((x) => x.mode === "live" && x.status === "open");
    (await priced(lives)).forEach((v, k) => { if (v != null) { lives[k].lastValueEth = v; lives[k].lastAt = Date.now(); } });
    await Promise.all(seals);
    if (Date.now() - t0 > 25_000) console.warn(`[arena] watch pass took ${Math.round((Date.now() - t0) / 1000)} s for ${papers.length + lives.length} positions`);
    const open = d.positions.filter((x) => x.status === "open");
    const done = d.positions.filter((x) => x.status === "closed").sort((a, b) => b.closedAt - a.closedAt).slice(0, 3000);
    await store.update(FILE, {}, (x) => { x.positions = [...open, ...done, ...(x.positions || []).filter((q) => q.status === "open" && !open.some((o) => o.id === q.id) && !done.some((o) => o.id === q.id))]; return x; });
    if (closed.length) console.log(`[arena] closed ${closed.length} paper trade(s)`);
    if (closed.length) import("./champions.mjs").then((m) => m.onArenaClose(closed)).catch((e) => console.warn("[champions] close", e.message));
  } catch (e) { console.warn("[arena] watch", e.message); }
  finally { watchBusy = false; }
}

// the slow round, every 2 minutes: the AI traders' rules for the day and the 7-day verdicts (agents only)
async function tick() {
  if (busy || !store) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, {});
    d.agents ||= {}; d.positions ||= [];
    await aiDaily(d).catch((e) => console.warn("[arena] ai", e.message));
    for (const ag of Object.values(d.agents)) {
      if (ag.status !== "proving" || Date.now() < ag.provingUntil) continue;
      const mine = d.positions.filter((p) => p.agent === ag.id && p.status === "closed" && p.openedAt >= ag.provingUntil - PROVE_MS);
      const pnl = mine.reduce((s, p) => s + (p.pnlEth || 0), 0);
      ag.status = mine.length >= 5 && pnl > 0 ? "proven" : ag.kind === "ai" ? "proving" : "not proven";
      if (ag.kind === "ai") ag.provingUntil = Date.now() + PROVE_MS;                // the AI traders keep competing week after week
      ag.verdictAt = Date.now(); ag.verdict = { trades: mine.length, pnlEth: +pnl.toFixed(5) };
    }
    await store.update(FILE, {}, (x) => { x.agents = { ...(x.agents || {}), ...d.agents }; return x; });
  } catch (e) { console.warn("[arena]", e.message); }
  finally { busy = false; }
}

function statsOf(d, id, mode = "paper") {
  const ps = (d.positions || []).filter((p) => p.agent === id && (mode === "live" ? p.mode === "live" : p.mode !== "live"));
  const c = ps.filter((p) => p.status === "closed");
  const pnl = c.reduce((s, p) => s + (p.pnlEth || 0), 0);
  const openPnl = ps.filter((p) => p.status === "open" && p.lastValueEth != null).reduce((s, p) => s + (p.lastValueEth - p.amountEth), 0);
  return { closed: c.length, open: ps.length - c.length, pnlEth: +pnl.toFixed(5), openPnlEth: +openPnl.toFixed(5), winRate: c.length ? +(c.filter((p) => p.pnlEth > 0).length / c.length).toFixed(3) : null };
}
const pubAgent = (d, ag) => ({ id: ag.id, kind: ag.kind, name: ag.kind === "ai" ? ag.name : `${ag.owner.slice(0, 6)}…${ag.owner.slice(-4)}`, model: ag.model || null, status: ag.status,
  rules: ag.rules, rulesText: rulesText(cleanRules(ag.rules)), thesis: tidyThesis(ag.thesis), since: ag.createdAt, provingUntil: ag.provingUntil, verdict: ag.verdict || null, stats: statsOf(d, ag.id),
  live: ag.kind === "ai" && (d.positions || []).some((p) => p.agent === ag.id && p.mode === "live") ? { ...statsOf(d, ag.id, "live"), budgetEth: LIVE_BUDGET(), equityEth: +liveEquity(d, ag.id).toFixed(6) } : null,
  livePaused: ag.kind === "ai" && LIVE_PAUSED().includes(ag.id) });
const pubPos = (p) => ({ agent: p.agent, mode: p.mode === "live" ? "live" : "paper", tx: p.txSell || p.txBuy || null, txBuy: p.txBuy || null, txSell: p.txSell || null, seal: p.sealClose || p.sealOpen || null, token: p.token, symbol: p.symbol, amountEth: p.amountEth, openedAt: p.openedAt, status: p.status, reason: p.reason || null, pnlEth: p.pnlEth ?? null, valueEth: p.lastValueEth ?? null, closedAt: p.closedAt || null });

/** The public board, for the assistant and MCP tools. */
export async function arenaBoard() {
  const d = await store.readJson(FILE, {});
  return { mode: "paper", agents: Object.values(d.agents || {}).filter((a) => a.kind === "ai" || a.public !== false).map((a) => pubAgent(d, a)).sort((a, b) => (b.stats.pnlEth + b.stats.openPnlEth) - (a.stats.pnlEth + a.stats.openPnlEth)), recent: (d.positions || []).slice(-15).reverse().map(pubPos) };
}

// Receipts for trades made before the board linked them (19 Nov 2026): each older trade is matched once to its Seal
// receipt by kind, coin, wording and time (within 3 minutes), never guessed. Runs at start; a no-op once all are linked.
async function backfillSeals(dataDir) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(dataDir, "seal");
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-10);
  const recs = [];
  for (const f of files) for (const line of (await readFile(join(dir, f), "utf8").catch(() => "")).split("\n")) {
    if (!line.includes('"arena-')) continue;
    try { const x = JSON.parse(line); if (/^arena-(live-)?(open|close)$/.test(x.kind)) recs.push(x); } catch {}
  }
  if (!recs.length) return;
  let n = 0;
  await store.update(FILE, {}, (d) => {
    const names = Object.fromEntries(Object.values(d.agents || {}).map((g) => [g.id, g.name || g.id]));
    const used = new Set((d.positions || []).flatMap((x) => [x.sealOpen, x.sealClose]).filter(Boolean));
    const find = (kind, token, t, test) => {
      let best = null;
      for (const x of recs) {
        if (x.kind !== kind || used.has(x.hash) || lc(x.subject) !== lc(token) || !test(x.ref || "")) continue;
        const dt = Math.abs(x.at - t);
        if (dt < 180_000 && (!best || dt < best.dt)) best = { x, dt };
      }
      if (best) used.add(best.x.hash);
      return best?.x.hash || null;
    };
    for (const q of d.positions || []) {
      const live = q.mode === "live";
      if (!q.sealOpen && q.openedAt) { const h = find(live ? "arena-live-open" : "arena-open", q.token, q.openedAt, (ref) => ref.startsWith(`${names[q.agent] || q.agent} bought $${q.symbol}`)); if (h) { q.sealOpen = h; n++; } }
      if (!q.sealClose && q.closedAt) { const h = find(live ? "arena-live-close" : "arena-close", q.token, q.closedAt, (ref) => ref.startsWith(`${q.agent} sold $${q.symbol}`)); if (h) { q.sealClose = h; n++; } }
    }
    return d;
  });
  if (n) console.log(`[arena] linked ${n} older trades to their Seal receipts`);
}

// live exits booked as 0 ETH while the sell transaction is on chain (the shared-wallet read above): read them again, once
async function fixZeroExits() {
  const owner = process.env.ARENA_LIVE_OWNER;
  const aw = owner ? await (await import("./agentwallet.mjs")).getAgentWallet(owner).catch(() => null) : null;
  if (!aw?.address) return;
  const d = await store.readJson(FILE, {});
  const fixes = new Map();
  for (const p of d.positions || []) {
    if (p.mode !== "live" || p.status !== "closed" || p.exitValueEth !== 0 || !p.txSell || p.reason === "nothing left to sell") continue;
    const back = await ethBackFromTx(aw.address, p.txSell).catch(() => null);
    if (back > 0) fixes.set(p.id, back);
  }
  if (!fixes.size) return;
  await store.update(FILE, {}, (x) => {
    for (const p of x.positions || []) if (fixes.has(p.id) && p.exitValueEth === 0) { const v = fixes.get(p.id); Object.assign(p, { exitValueEth: +v.toFixed(8), pnlEth: +(v - p.amountEth).toFixed(8), exitFixed: Date.now() }); }
    return x;
  });
  console.log(`[arena] corrected ${fixes.size} live exit(s) booked as 0 ETH from their sell transactions`);
}

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => tick().catch(() => {}), 100_000);
  setTimeout(() => backfillSeals(ctx.dataDir).catch((e) => console.warn("[arena] seal backfill:", e.message)), 30_000);
  setTimeout(() => fixZeroExits().catch((e) => console.warn("[arena] exit fix:", e.message)), 45_000);
  setInterval(() => tick().catch(() => {}), TICK_MS).unref();
  setTimeout(() => watch().catch(() => {}), 20_000);
  setInterval(() => watch().catch(() => {}), 30_000).unref();
  r.get("/api/arena", async () => {
    const d = await store.readJson(FILE, {});
    const agents = Object.values(d.agents || {}).filter((a) => a.kind === "ai" || a.public !== false).map((a) => pubAgent(d, a)).sort((a, b) => (b.stats.pnlEth + b.stats.openPnlEth) - (a.stats.pnlEth + a.stats.openPnlEth));
    const liveWallet = LIVE() ? await (await import("./agentwallet.mjs")).getAgentWallet(process.env.ARENA_LIVE_OWNER).then((w) => w?.address || null).catch(() => null) : null;
    return { mode: LIVE() ? "paper + live" : "paper", live: LIVE() ? { budgetPerTraderEth: LIVE_BUDGET(), maxBuyEth: LIVE_BUY(), wallet: liveWallet } : null, agents, recent: (d.positions || []).slice().sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt)).slice(0, 40).map(pubPos),
      how: LIVE() ? `Two books side by side. Paper: real prices quoted on chain the moment a trader buys or sells, nothing sent. Live: real transactions from the Arena's own Agent Wallet through Troya Gate, ${LIVE_BUDGET()} ETH per AI trader, each with its link on Blockscout. Every strategy, entry and exit is sealed (signed twice, anchored on Robinhood Chain) and linked as a receipt.`
        : "Paper money at real prices: entries and exits are quoted on chain the moment they happen, nothing is sent. Every strategy, entry and exit is sealed and linked as a receipt." };
  }, { weight: 1 });
  r.post("/api/arena/strategy", async ({ req, body }) => {
    requireSession(req);
    const text = String(body?.text || "").trim();
    if (text.length < 8) throw new HttpError(400, "Describe the strategy in a sentence or two.");
    const { rules, thesis } = await readStrategy(text);
    return { rules, rulesText: rulesText(rules), thesis, replay: await replay(rules) };
  }, { weight: 4, perMin: 6 });
  r.post("/api/arena/prove", async ({ req, body }) => {
    const me = lc(requireSession(req).address);
    const rules = cleanRules(body?.rules || {});
    const id = `u-${me.slice(2, 12)}`;
    await store.update(FILE, {}, (x) => {
      x.agents ||= {};
      x.agents[id] = { id, kind: "user", owner: me, text: String(body?.text || "").slice(0, 800), rules, createdAt: Date.now(), status: "proving", provingUntil: Date.now() + PROVE_MS, public: body?.public !== false, history: [{ at: Date.now(), rules }, ...(x.agents[id]?.history || [])].slice(0, 10) };
      x.positions = (x.positions || []).filter((p) => !(p.agent === id && p.status === "open"));     // a restart starts clean
      return x;
    });
    import("./seal.mjs").then((s) => s.seal("arena-strategy", id, { rules }, rulesText(rules).slice(0, 150))).catch(() => {});
    return { ok: true, id, rules, rulesText: rulesText(rules), provingUntil: Date.now() + PROVE_MS };
  }, { weight: 2, perMin: 6 });
  r.get("/api/arena/me", async ({ req }) => {
    const me = lc(requireSession(req).address);
    const d = await store.readJson(FILE, {});
    const ag = Object.values(d.agents || {}).find((a) => a.owner === me);
    return { agent: ag ? { ...pubAgent(d, ag), text: ag.text } : null, positions: ag ? (d.positions || []).filter((p) => p.agent === ag.id).slice(-40).reverse().map(pubPos) : [] };
  }, { weight: 1 });
}
