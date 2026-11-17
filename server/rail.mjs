// F25 · The audited rail: limits, an allowlist and a kill switch for AI agents that trade stocks through Robinhood's
// agentic MCP (agent.robinhood.com/mcp/trading). Not a partnership with Robinhood, and Troya never holds Robinhood
// credentials: the rail runs on the user's own machine (npx @troyaagent/rail) between their agent and Robinhood's MCP,
// and asks Troya before every order. Troya checks the order against the policy the user set in the app, keeps the
// day's totals, signs the decision with its attestor key and keeps it in the user's audit log.
//   GET  /api/rail/policy      API token or session: the policy and the kill switch (the rail reads it)
//   POST /api/rail/policy      session: { ordersOn, maxOrderUsd, dailyUsd, maxOrdersPerDay, symbols, blocked, marketHoursOnly, buyOnly }
//   POST /api/rail/kill        session: { on } — the kill switch: every order is refused while it is on
//   POST /api/rail/check       API token: { tool, args, rail } → { allow, reasons, order, receipt } (signed)
//   POST /api/rail/report      API token: { id, ok, summary } → what Robinhood answered for an allowed order
//   GET  /api/rail/log         API token or session: the audit log, newest first
//   POST /api/rail/verify      { attested, signature } → was this decision signed by Troya
import { getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";
import { optionalApiToken } from "./apitokens.mjs";
import { getStocks } from "./market.mjs";

const FILE = "rail.json";
const lc = (s) => String(s || "").toLowerCase();
const DEFAULTS = { ordersOn: false, maxOrderUsd: 100, dailyUsd: 250, maxOrdersPerDay: 10, symbols: [], blocked: [], marketHoursOnly: true, buyOnly: false, kill: false };
let store = null;

const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
function marketOpen(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  if (["Sat", "Sun"].includes(p.weekday)) return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 9 * 60 + 30 && m < 16 * 60;           // regular session; US market holidays are not modelled
}

async function owner(req, { needToken = false } = {}) {
  const t = await optionalApiToken(req);
  if (t) return lc(t.address);
  if (needToken) throw new HttpError(401, "The rail sends your API token in x-api-key.");
  const s = getSession(req);
  if (s) return lc(s.address);
  throw new HttpError(401, "Sign in, or send your API token in x-api-key.");
}
async function acct(a) { const d = await store.readJson(FILE, { accounts: {} }); return d.accounts?.[a] || null; }
const policyOf = (x) => ({ ...DEFAULTS, ...(x?.policy || {}) });

// what an order tool call says, whatever the exact argument names are
const ORDER_TOOL = /order|trade|buy|sell|place|submit|execute|cancel|replace|transfer|withdraw|deposit/i;
const READ_TOOL = /^(get|list|search|read|fetch|view|lookup|find|describe|quote|show)[_-]?/i;
export function classify(tool, annotations) {
  if (annotations?.readOnlyHint === true) return "read";
  if (READ_TOOL.test(tool) && !/place|submit|execute/i.test(tool)) return "read";
  if (/cancel/i.test(tool)) return "cancel";
  if (/transfer|withdraw|deposit/i.test(tool)) return "money";
  return ORDER_TOOL.test(tool) ? "order" : "other";
}
function pick(args, keys) { for (const k of Object.keys(args || {})) if (keys.includes(k.toLowerCase())) return args[k]; return undefined; }
export function readOrder(args = {}) {
  const sym = pick(args, ["symbol", "ticker", "instrument", "instrument_symbol", "stock", "asset"]);
  const side = lc(pick(args, ["side", "direction", "action", "order_side"]));
  const qty = Number(pick(args, ["quantity", "qty", "shares", "share_quantity", "units"]));
  const amount = Number(pick(args, ["amount", "notional", "dollar_amount", "dollars", "amount_usd", "notional_usd", "value"]));
  const price = Number(pick(args, ["limit_price", "price", "stop_price", "limitprice"]));
  const type = lc(pick(args, ["type", "order_type", "ordertype"]));
  return { symbol: sym ? String(sym).toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 12) : null, side: /sell|short/.test(side) ? "sell" : /buy|long/.test(side) ? "buy" : side || null,
    quantity: qty > 0 ? qty : null, amountUsd: amount > 0 ? amount : null, limitPrice: price > 0 ? price : null, type: type || null };
}

async function decide(a, tool, args, kind) {
  const ac = await acct(a), p = policyOf(ac), reasons = [];
  const order = kind === "order" ? readOrder(args) : null;
  let usd = null, priceSrc = null;
  if (p.kill) reasons.push("The kill switch is on: every order is refused until you switch it off in the app.");
  if (kind === "money") reasons.push("Moving money in or out of the account is never allowed through the rail.");
  if (kind === "other") reasons.push(`"${tool}" is not a read tool and the rail does not know what it does, so it is refused.`);
  if (kind === "order") {
    if (!p.ordersOn) reasons.push("Orders are switched off in your rail policy.");
    if (!order.symbol) reasons.push("The order names no symbol the rail can read.");
    if (order.symbol && p.symbols.length && !p.symbols.includes(order.symbol)) reasons.push(`${order.symbol} is not on your allowlist (${p.symbols.join(", ")}).`);
    if (order.symbol && p.blocked.includes(order.symbol)) reasons.push(`${order.symbol} is on your block list.`);
    if (p.buyOnly && order.side === "sell") reasons.push("Your policy allows buys only.");
    if (p.marketHoursOnly && !marketOpen()) reasons.push("Outside US market hours (9:30 to 16:00 New York time, Monday to Friday).");
    if (order.amountUsd) { usd = order.amountUsd; priceSrc = "order amount"; }
    else if (order.quantity && order.limitPrice) { usd = order.quantity * order.limitPrice; priceSrc = "limit price"; }
    else if (order.quantity && order.symbol) {
      const s = (await getStocks().catch(() => ({ stocks: [] }))).stocks?.find((x) => x.symbol === order.symbol);
      if (s?.priceUsd) { usd = order.quantity * s.priceUsd; priceSrc = "Robinhood Chain stock token price"; }
    }
    if (usd == null) reasons.push("The rail could not size the order in dollars (no amount, no limit price, no known price), so it is refused.");
    else {
      if (usd > p.maxOrderUsd) reasons.push(`$${usd.toFixed(2)} is over your $${p.maxOrderUsd} limit per order.`);
      const day = ac?.day === nyDay() ? ac : { usd: 0, orders: 0 };
      if ((day.usd || 0) + usd > p.dailyUsd) reasons.push(`It would take today to $${((day.usd || 0) + usd).toFixed(2)}, over your $${p.dailyUsd} daily limit.`);
      if ((day.orders || 0) + 1 > p.maxOrdersPerDay) reasons.push(`That would be order ${(day.orders || 0) + 1} today; your limit is ${p.maxOrdersPerDay}.`);
    }
  }
  return { allow: !reasons.length, reasons, order: order ? { ...order, usd: usd != null ? +usd.toFixed(2) : null, priceSrc } : null, policy: p };
}

export async function register(r, ctx) {
  store = ctx.store;
  const pub = (ac) => ({ policy: policyOf(ac), today: ac?.day === nyDay() ? { usd: ac.usd || 0, orders: ac.orders || 0 } : { usd: 0, orders: 0 }, marketOpen: marketOpen(), rails: ac?.rails || {}, updatedAt: ac?.updatedAt || null });

  r.get("/api/rail/policy", async ({ req }) => pub(await acct(await owner(req))), { weight: 1, perMin: 120 });

  r.post("/api/rail/policy", async ({ req, body }) => {
    const a = lc(requireSession(req).address);
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const syms = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,]+/)).map((x) => String(x).toUpperCase().replace(/[^A-Z0-9.]/g, "")).filter(Boolean))].slice(0, 100);
    let out;
    await store.update(FILE, { accounts: {} }, (d) => {
      d.accounts ||= {};
      const ac = d.accounts[a] ||= {};
      const p = policyOf(ac);
      if (body?.ordersOn != null) p.ordersOn = !!body.ordersOn;
      if (body?.marketHoursOnly != null) p.marketHoursOnly = !!body.marketHoursOnly;
      if (body?.buyOnly != null) p.buyOnly = !!body.buyOnly;
      p.maxOrderUsd = num(body?.maxOrderUsd ?? p.maxOrderUsd, 1, 100000, p.maxOrderUsd);
      p.dailyUsd = num(body?.dailyUsd ?? p.dailyUsd, 1, 1000000, p.dailyUsd);
      p.maxOrdersPerDay = Math.round(num(body?.maxOrdersPerDay ?? p.maxOrdersPerDay, 1, 500, p.maxOrdersPerDay));
      if (body?.symbols != null) p.symbols = syms(body.symbols);
      if (body?.blocked != null) p.blocked = syms(body.blocked);
      ac.policy = p; ac.updatedAt = Date.now(); out = pub(ac);
      return d;
    });
    return out;
  }, { weight: 2, perMin: 30 });

  r.post("/api/rail/kill", async ({ req, body }) => {
    const a = lc(requireSession(req).address);
    let out;
    await store.update(FILE, { accounts: {} }, (d) => { d.accounts ||= {}; const ac = d.accounts[a] ||= {}; ac.policy = { ...policyOf(ac), kill: !!body?.on }; ac.updatedAt = Date.now(); out = pub(ac); return d; });
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: a, kind: "rail.kill", summary: `Rail kill switch ${body?.on ? "on" : "off"}`, source: "app" }).catch(() => {});
    return out;
  }, { weight: 2, perMin: 30 });

  r.post("/api/rail/check", async ({ req, body }) => {
    const a = await owner(req, { needToken: true });
    const tool = String(body?.tool || "").slice(0, 80);
    if (!tool) throw new HttpError(400, "Send the tool name the agent is calling.");
    const args = body?.args && typeof body.args === "object" ? body.args : {};
    const kind = classify(tool, body?.annotations);
    const rail = String(body?.rail || "rail").replace(/[^\w .-]/g, "").slice(0, 40) || "rail";
    const dec = kind === "read" ? { allow: true, reasons: [], order: null } : await decide(a, tool, args, kind);
    const at = Date.now(), id = `r${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const attested = { v: 1, kind: "rail-decision", id, owner: getAddress(a), rail, tool, class: kind, allow: dec.allow, reasons: dec.reasons, order: dec.order, at };
    const receipt = await import("./gateapi.mjs").then((m) => m.attest(attested, "Troya rail decision"));
    await store.update(FILE, { accounts: {} }, (d) => {
      d.accounts ||= {};
      const ac = d.accounts[a] ||= {};
      ac.rails = { ...(ac.rails || {}), [rail]: at };
      if (kind !== "read") {
        if (dec.allow && kind === "order") { const t = nyDay(); if (ac.day !== t) { ac.day = t; ac.usd = 0; ac.orders = 0; } ac.usd = +((ac.usd || 0) + (dec.order?.usd || 0)).toFixed(2); ac.orders = (ac.orders || 0) + 1; }
        ac.log = [{ ...attested, ...receipt, argsHash: keccak256(toUtf8Bytes(JSON.stringify(args))) }, ...(ac.log || [])].slice(0, 500);
      }
      return d;
    });
    return { allow: dec.allow, reasons: dec.reasons, class: kind, order: dec.order, id, receipt: kind === "read" ? null : { attested, ...receipt } };
  }, { weight: 2, perMin: 240 });

  r.post("/api/rail/report", async ({ req, body }) => {
    const a = await owner(req, { needToken: true });
    const id = String(body?.id || "");
    await store.update(FILE, { accounts: {} }, (d) => {
      const e = d.accounts?.[a]?.log?.find((x) => x.id === id);
      if (e) e.result = { ok: !!body?.ok, summary: String(body?.summary || "").slice(0, 300), at: Date.now() };
      return d;
    });
    return { ok: true };
  }, { weight: 1, perMin: 240 });

  r.get("/api/rail/log", async ({ req, query }) => {
    const ac = await acct(await owner(req));
    return { log: (ac?.log || []).slice(0, Math.max(1, Math.min(500, Number(query.limit) || 100))), ...pub(ac) };
  }, { weight: 1, perMin: 120 });

  r.post("/api/rail/verify", async ({ body }) => {
    const att = body?.attested, sig = String(body?.signature || "");
    if (!att || typeof att !== "object" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "Send { attested, signature } exactly as the rail got them.");
    const hash = keccak256(toUtf8Bytes(JSON.stringify(att)));
    let signer = null; try { signer = verifyMessage(`Troya rail decision\n${hash}`, sig); } catch {}
    const attestor = await import("./gateapi.mjs").then((m) => m.attestorAddress());
    return { genuine: lc(signer) === lc(attestor), hash, signer, attestor };
  }, { weight: 1 });
}
