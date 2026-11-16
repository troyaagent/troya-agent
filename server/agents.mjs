// F20 · Agent factory: anyone with a wallet builds a named agent from Troya's own parts and gives it a public page.
//   POST   /api/agents {name, slug, bio, template, params} → the agent and its playbooks, on your own Agent Wallet
//   GET    /api/agents                → public directory          GET /api/agents/:slug → public page of one agent
//   GET    /api/agents/mine           → your agents
//   POST   /api/agents/:slug/toggle   → yours: pause or resume all its playbooks
//   DELETE /api/agents/:slug          → yours: retire it (its playbooks stop, the page shows it as retired)
// Templates (each is playbooks that already exist; an agent trades only through its owner's Agent Wallet, inside the
// owner's caps, with Troya Gate on every swap):
//   accumulator   smart DCA into one Robinhood Chain token
//   index         a stock basket kept near its weights (buy the basket in Stock desk first)
//   twap          one large order in slices under a price-impact cap
//   range         watches a Uniswap v3 position and writes when it nears or leaves its range
//   loan          watches a Morpho loan against a stock token
import { isAddress } from "ethers";
import { HttpError } from "./api.mjs";
import { requireSession, getSession } from "./auth.mjs";
import { createWatch } from "./watches.mjs";
import { untrusted } from "./tools.mjs";

const MAX_AGENTS = 5;
const RESERVED = new Set(["new", "mine", "templates", "admin", "troya", "troyaagent", "official", "team", "dev", "support", "api", "agent", "agents"]);
const BASKETS = { "index-core": ["Index core", ["SPY", "QQQ"]], mag7: ["Magnificent 7", ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"]], chips: ["Chips", ["NVDA", "MU", "TSM", "AVGO", "AMD"]], dividends: ["Dividend payers", ["JNJ", "COST", "UNH", "KO", "PG"]] };
export const TEMPLATES = {
  accumulator: { label: "Accumulator", line: "Buys one coin on a schedule, more when it trades under its 7-day average" },
  index: { label: "Stock index", line: "Keeps a basket of stock tokens near its weights" },
  twap: { label: "Silent buyer", line: "Fills one large order in slices that never move the price past a cap" },
  range: { label: "Range keeper", line: "Watches a Uniswap v3 position and calls the rebalance" },
  loan: { label: "Loan guard", line: "Watches a Morpho loan and warns before liquidation" },
};
const lc = (s) => String(s || "").toLowerCase();
const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
let store = null;

async function playbooksFor(address, t, p, name) {
  const out = [];
  const add = async (input) => out.push((await createWatch(address, input)).id);
  if (t === "accumulator") {
    if (!isAddress(String(p.token || ""))) throw new HttpError(400, "Pick the coin to accumulate (its address).");
    const amountEth = num(p.amountEth), everyHours = num(p.everyHours) || 24, runs = num(p.runs) || 14;
    if (!(amountEth > 0)) throw new HttpError(400, "Enter the ETH per buy.");
    await add({ type: "dca", params: { token: p.token, symbol: p.symbol, amountEth, everyHours, runs, smart: true } });
  } else if (t === "index") {
    const b = BASKETS[p.basket] || BASKETS["index-core"];
    const { stockDesk } = await import("./stocks.mjs");
    const desk = await stockDesk();
    const tokens = b[1].map((s) => desk.assets.find((a) => a.symbol === s)).filter(Boolean).map((a) => ({ token: a.address, symbol: a.symbol, weight: 1 }));
    await add({ type: "rebalance", params: { tokens, driftPct: num(p.driftPct) || 5, everyHours: num(p.everyHours) || 24, name: `${name} · ${b[0]}` } });
  } else if (t === "twap") {
    if (!isAddress(String(p.token || ""))) throw new HttpError(400, "Pick the coin to buy (its address).");
    await add({ type: "twap", params: { token: p.token, symbol: p.symbol, side: "buy", total: num(p.total), slices: num(p.slices) || 6, everyMinutes: num(p.everyMinutes) || 30, maxImpactPct: num(p.maxImpactPct) || 0.5 } });
  } else if (t === "range") {
    await add({ type: "lp_range", params: { tokenId: String(p.tokenId || ""), name, edgePct: num(p.edgePct) || 5 } });
  } else if (t === "loan") {
    await add({ type: "loan_guard", params: { marketId: p.marketId, symbol: p.symbol, healthBelow: num(p.healthBelow) || 1.3 } });
  } else throw new HttpError(400, "Pick a template.");
  return out;
}

async function create(req, body) {
  const s = requireSession(req);
  const name = untrusted(String(body?.name || "").trim(), 32).replace(/[<>]/g, "");
  const slug = lc(String(body?.slug || name).trim()).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const bio = untrusted(String(body?.bio || "").trim(), 200).replace(/[<>]/g, "");
  const t = String(body?.template || "");
  if (name.length < 3) throw new HttpError(400, "Give your agent a name (3 characters or more).");
  if (slug.length < 3 || RESERVED.has(slug)) throw new HttpError(400, "Pick another handle.");
  if (!TEMPLATES[t]) throw new HttpError(400, "Pick a template.");
  const all = await store.readJson("agents.json", []);
  if (all.some((a) => a.slug === slug)) throw new HttpError(409, "That handle is taken.");
  if (all.filter((a) => a.owner === lc(s.address) && !a.retired).length >= MAX_AGENTS) throw new HttpError(400, `You can run up to ${MAX_AGENTS} agents.`);
  const watchIds = await playbooksFor(s.address, t, body?.params || {}, name);
  const a = { slug, name, bio, template: t, owner: lc(s.address), watchIds, createdAt: Date.now(), retired: false };
  await store.update("agents.json", [], (l) => { if (l.some((x) => x.slug === slug)) throw new HttpError(409, "That handle is taken."); l.push(a); return l; });
  return view(a, true);
}

async function view(a, full = false) {
  const watches = (await store.readJson("watches.json", [])).filter((w) => a.watchIds.includes(w.id));
  const xs = await import("./xsocial.mjs").catch(() => null);
  const x = xs ? await xs.handleOf(a.owner).catch(() => null) : null;
  const fires = watches.flatMap((w) => (w.fires || []).map((f) => ({ ...f, playbook: w.title }))).sort((p, q) => q.t - p.t);
  const active = watches.some((w) => w.status === "active");
  return {
    slug: a.slug, name: a.name, bio: a.bio, template: a.template, templateLabel: TEMPLATES[a.template]?.label, templateLine: TEMPLATES[a.template]?.line,
    owner: `${a.owner.slice(0, 6)}…${a.owner.slice(-4)}`, ownerX: x ? x.username : null, createdAt: a.createdAt,
    status: a.retired ? "retired" : active ? "running" : watches.every((w) => w.status === "done") ? "finished" : "paused",
    actions: fires.length, lastAction: fires[0]?.t || null,
    ...(full ? { playbooks: watches.map((w) => ({ id: w.id, title: w.title, type: w.type, status: w.status, lastCheck: w.lastCheck, lastNote: w.params?.lastNote || null, error: w.lastError || null, fires: (w.fires || []).length })),
      recent: fires.slice(0, 20).map((f) => ({ t: f.t, playbook: f.playbook, outcome: f.outcome, note: f.slice ? `slice ${f.slice}` : f.amount ? `${f.amount} ETH` : f.state || null })) } : {}),
  };
}

async function mine(req, slug) {
  const s = requireSession(req);
  const all = await store.readJson("agents.json", []);
  const a = all.find((x) => x.slug === slug);
  if (!a || a.owner !== lc(s.address)) throw new HttpError(404, "Not one of your agents.");
  return a;
}
async function setWatches(owner, ids, status) {
  await store.update("watches.json", [], (all) => { for (const w of all) if (ids.includes(w.id) && w.address === owner && w.status !== "done") w.status = status; return all; });
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/agents/templates", () => ({ templates: TEMPLATES, baskets: Object.fromEntries(Object.entries(BASKETS).map(([k, v]) => [k, { label: v[0], symbols: v[1] }])) }));
  r.get("/api/agents", async () => {
    const all = (await store.readJson("agents.json", [])).filter((a) => !a.retired);
    const list = await Promise.all(all.slice(-200).map((a) => view(a)));
    return { agents: list.sort((p, q) => (q.lastAction || q.createdAt) - (p.lastAction || p.createdAt)).slice(0, 60) };
  }, { weight: 2 });
  r.get("/api/agents/mine", async ({ req }) => {
    const s = requireSession(req);
    const all = (await store.readJson("agents.json", [])).filter((a) => a.owner === lc(s.address));
    return { agents: await Promise.all(all.reverse().map((a) => view(a, true))) };
  });
  r.get("/api/agents/:slug", async ({ params, req }) => {
    const a = (await store.readJson("agents.json", [])).find((x) => x.slug === lc(params.slug));
    if (!a) throw new HttpError(404, "No agent with that handle.");
    const s = getSession(req);
    return { ...(await view(a, true)), yours: !!s && lc(s.address) === a.owner };
  });
  r.post("/api/agents", ({ req, body }) => create(req, body), { perMin: 10 });
  r.post("/api/agents/:slug/toggle", async ({ req, params }) => {
    const a = await mine(req, lc(params.slug));
    if (a.retired) throw new HttpError(409, "This agent is retired.");
    const watches = (await store.readJson("watches.json", [])).filter((w) => a.watchIds.includes(w.id));
    const next = watches.some((w) => w.status === "active") ? "paused" : "active";
    await setWatches(a.owner, a.watchIds, next);
    return { ok: true, status: next === "active" ? "running" : "paused" };
  });
  r.del("/api/agents/:slug", async ({ req, params }) => {
    const a = await mine(req, lc(params.slug));
    await setWatches(a.owner, a.watchIds, "paused");
    await store.update("agents.json", [], (l) => { const x = l.find((y) => y.slug === a.slug); if (x) { x.retired = true; x.retiredAt = Date.now(); } return l; });
    return { ok: true };
  });
}
