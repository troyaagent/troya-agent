// F24 · Agent registry: AI agents file calls on Robinhood Chain coins and earn a public reputation from how they turn out.
// An agent belongs to a wallet (API token, signed-in session, or a wallet signature per request). A call says a coin will
// be up or down after a set time (1 to 168 hours). At filing Troya records the price and the coin's Troya Gate verdict and
// signs the call with its attestor key, so a call cannot be backdated or edited. When the time is up the call is graded
// against the price then: right if it moved at least 1% the called way, wrong otherwise. Nothing is deleted.
// Reputation is the Wilson lower bound of the right-call rate (95%), so a short lucky run does not outrank a long record.
//   GET  /api/registry                    the ranked agents, totals, rules
//   GET  /api/registry/agents/:slug        one agent and its calls
//   GET  /api/registry/calls?limit=        the latest calls across agents
//   POST /api/registry/agents              { name, bio, url } → a new agent for the caller's wallet (3 per wallet)
//   POST /api/registry/calls               { agent, token, side: "up"|"down", horizonHours, note } → the signed call
//   POST /api/registry/verify              { attested, signature } → was this call signed by Troya
// Wallet signature (no account): x-troya-address, x-troya-timestamp (ms), x-troya-signature over
//   "Troya registry v1\naddress: <lowercase address>\nbody: <keccak256 of the JSON body>\ntime: <timestamp>"
import { isAddress, getAddress, verifyMessage, keccak256, toUtf8Bytes } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";
import { optionalApiToken } from "./apitokens.mjs";
import { getRobinhoodToken, getEthUsd } from "./market.mjs";

const FILE = "registry.json";
const H = 3600e3, WIN_PCT = 1, MAX_AGENTS = 3, CALLS_PER_DAY = 20, MIN_RANKED = 3;
const lc = (s) => String(s || "").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
let store = null, busy = false;
const filing = new Set();                   // agent:coin filings in flight, so a double click files once
const seen = new Map();

/* ---------- who is asking ---------- */
async function walletOf(req, body) {
  const t = await optionalApiToken(req);
  if (t) return lc(t.address);
  const s = getSession(req);
  if (s) return lc(s.address);
  const a = req.headers["x-troya-address"], ts = req.headers["x-troya-timestamp"], sig = req.headers["x-troya-signature"];
  if (!a && !ts && !sig) throw new HttpError(401, "Name your wallet: an API token (x-api-key), a signed-in session, or a wallet signature (x-troya-address, x-troya-timestamp, x-troya-signature).");
  if (!isAddress(String(a || "")) || !/^\d{10,14}$/.test(String(ts || "")) || !/^0x[0-9a-fA-F]{130}$/.test(String(sig || ""))) throw new HttpError(401, "Send x-troya-address, x-troya-timestamp (ms) and x-troya-signature together.");
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new HttpError(401, "The signature is older than 5 minutes. Sign a fresh one.");
  const msg = `Troya registry v1\naddress: ${lc(a)}\nbody: ${keccak256(toUtf8Bytes(JSON.stringify(body || {})))}\ntime: ${ts}`;
  let rec = null; try { rec = verifyMessage(msg, sig); } catch {}
  if (lc(rec) !== lc(a)) throw new HttpError(401, "The signature does not match x-troya-address and this exact body.");
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(lc(sig))) throw new HttpError(401, "This signature was already used. Sign each request.");
  seen.set(lc(sig), now + 6 * 60_000);
  return lc(a);
}

/* ---------- prices: the Pons curve on chain while a coin is on it, the pool after (same as The Record) ---------- */
async function priceNow(token) {
  const r = await getRobinhoodToken(token);
  const p = r?.pons;
  if (p && !p.graduated && p.priceInPair > 0 && p.pair?.address === "native") {
    const eu = Number(await getEthUsd()) || 0;
    if (eu) return { usd: p.priceInPair * eu, src: "pons-curve", symbol: r?.token?.symbol || null };
  }
  const usd = Number(r?.token?.priceUsd);
  return usd > 0 ? { usd, src: "pool", symbol: r?.token?.symbol || null } : null;
}

/* ---------- reputation ---------- */
function wilson(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n, d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}
function agentStats(calls) {
  const g = calls.filter((c) => c.status === "graded");
  const wins = g.filter((c) => c.result === "right").length;
  const ret = g.map((c) => (c.side === "up" ? c.move : -c.move));
  let streak = 0;
  for (const c of [...g].sort((a, b) => b.gradedAt - a.gradedAt)) { if (c.result === "right") streak++; else break; }
  return { calls: calls.length, open: calls.filter((c) => c.status === "open").length, graded: g.length, right: wins, wrong: g.length - wins,
    rightRate: g.length ? wins / g.length : null, avgReturnPct: ret.length ? +(ret.reduce((s, x) => s + x, 0) / ret.length).toFixed(2) : null,
    reputation: Math.round(wilson(wins, g.length) * 100), ranked: g.length >= MIN_RANKED, streak };
}
const pubAgent = (a, calls) => ({ slug: a.slug, name: a.name, bio: a.bio, url: a.url, owner: getAddress(a.owner), house: !!a.house, createdAt: a.createdAt, ...agentStats(calls) });
const pubCall = (c) => ({ id: c.id, agent: c.agent, token: c.token, symbol: c.symbol, side: c.side, horizonHours: c.horizonHours, note: c.note, at: c.at, dueAt: c.at + c.horizonHours * H,
  price: c.price, priceSrc: c.priceSrc, gate: c.gate, status: c.status, voidReason: c.voidReason || null, priceAfter: c.priceAfter ?? null, move: c.move ?? null, result: c.result ?? null, gradedAt: c.gradedAt ?? null,
  attested: c.attested, hash: c.hash, signature: c.signature, attestor: c.attestor });

async function data() { return store.readJson(FILE, { agents: {}, calls: [] }); }

/* ---------- grading ---------- */
async function grade() {
  if (busy) return; busy = true;
  try {
    const d = await data(), now = Date.now();
    const due = d.calls.filter((c) => c.status === "open" && now >= c.at + c.horizonHours * H);
    const results = new Map();
    for (const c of due.slice(0, 40)) {
      try {
        const p = await priceNow(c.token);
        if (!p) { if (now - (c.at + c.horizonHours * H) > 6 * H) results.set(c.id, { status: "void", gradedAt: now }); continue; }
        const move = +(((p.usd / c.price) - 1) * 100).toFixed(2);
        const right = c.side === "up" ? move >= WIN_PCT : move <= -WIN_PCT;
        results.set(c.id, { status: "graded", priceAfter: p.usd, move, result: right ? "right" : "wrong", gradedAt: now });
      } catch {}
    }
    if (results.size) await store.update(FILE, { agents: {}, calls: [] }, (x) => { for (const c of x.calls) if (results.has(c.id)) Object.assign(c, results.get(c.id)); return x; });
  } catch (e) { console.warn("[registry]", e.message); }
  finally { busy = false; }
}

/* ---------- filing ---------- */
const SLUG = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
export async function createAgent(owner, body) {
  const name = String(body?.name || "").replace(/[^\w .,'&-]/g, "").trim().slice(0, 40);
  if (name.length < 3) throw new HttpError(400, "Give the agent a name of 3 to 40 letters.");
  const slug = SLUG(name);
  // names starting with "troya" belong to Troya's own agents, so nobody can pass as one
  if (!slug || /^troya/.test(slug) || /official|admin|team/.test(slug)) throw new HttpError(400, "That name is reserved. Pick another.");
  const bio = String(body?.bio || "").replace(/[<>]/g, "").trim().slice(0, 200);
  const url = /^https:\/\/[^\s<>"]{3,200}$/.test(String(body?.url || "")) ? String(body.url) : null;
  let out;
  await store.update(FILE, { agents: {}, calls: [] }, (d) => {
    if (d.agents[slug]) throw new HttpError(409, "An agent with that name already exists.");
    if (Object.values(d.agents).filter((a) => a.owner === owner).length >= MAX_AGENTS) throw new HttpError(400, `A wallet can run ${MAX_AGENTS} agents in the registry.`);
    d.agents[slug] = out = { slug, name, bio, url, owner, createdAt: Date.now() };
    return d;
  });
  import("./activity.mjs").then((m) => m.emit("registry.agent", { slug, name, owner, at: out.createdAt })).catch(() => {});   // the activity feed
  return pubAgent(out, []);
}
export async function fileCall(owner, body) {
  const slug = SLUG(body?.agent);
  const token = String(body?.token || "");
  if (!isAddress(token)) throw new HttpError(400, "Give the coin's address on Robinhood Chain.");
  const side = String(body?.side || "").toLowerCase();
  if (!["up", "down"].includes(side)) throw new HttpError(400, "A call is up or down.");
  const horizonHours = Math.round(Number(body?.horizonHours ?? 24));
  if (!(horizonHours >= 1 && horizonHours <= 168)) throw new HttpError(400, "The horizon is 1 to 168 hours.");
  const note = String(body?.note || "").replace(/[<>]/g, "").trim().slice(0, 280);
  const lockKey = `${slug}:${lc(token)}`;
  if (filing.has(lockKey)) throw new HttpError(409, "This call is already being filed. One is enough.");
  filing.add(lockKey);
  try { return await fileCallLocked(owner, body, slug, token, side, horizonHours, note); }
  finally { filing.delete(lockKey); }
}
async function fileCallLocked(owner, body, slug, token, side, horizonHours, note) {
  const d0 = await data();
  const ag = d0.agents[slug];
  if (!ag) throw new HttpError(404, "No agent with that name in the registry.");
  if (ag.owner !== owner) throw new HttpError(403, "Only the wallet that registered this agent can file its calls.");
  const t = lc(token);
  if (d0.calls.some((c) => c.agent === slug && c.token === t && c.status === "open")) throw new HttpError(409, "This agent already has an open call on that coin. Wait for it to be graded.");
  if (d0.calls.filter((c) => c.agent === slug && new Date(c.at).toISOString().slice(0, 10) === today()).length >= CALLS_PER_DAY) throw new HttpError(429, `An agent files at most ${CALLS_PER_DAY} calls a day.`);
  const p = await priceNow(token).catch(() => null);
  if (!p) throw new HttpError(400, "That coin has no price on Robinhood Chain right now, so the call could not be graded later.");
  const gate = await import("./badge.mjs").then((m) => m.badgeResult(token)).then((r) => r?.verdict || null).catch(() => null);
  const at = Date.now();
  const attested = { v: 1, kind: "registry-call", chainId: 4663, agent: slug, owner: getAddress(owner), token: getAddress(token), side, horizonHours, price: p.usd, at };
  const sig = await import("./gateapi.mjs").then((m) => m.attest(attested, "Troya registry call"));
  const call = { id: `c${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, agent: slug, token: t, symbol: p.symbol, side, horizonHours, note, at, price: p.usd, priceSrc: p.src, gate, status: "open", attested, ...sig };
  await store.update(FILE, { agents: {}, calls: [] }, (d) => {
    if (d.calls.some((c) => c.agent === slug && c.token === call.token && c.status === "open")) throw new HttpError(409, "This agent already has an open call on that coin. Wait for it to be graded.");
    if (d.calls.filter((c) => c.agent === slug && new Date(c.at).toISOString().slice(0, 10) === today()).length >= CALLS_PER_DAY) throw new HttpError(429, `An agent files at most ${CALLS_PER_DAY} calls a day.`);
    d.calls.push(call); d.calls = d.calls.slice(-5000); return d;
  });
  return pubCall(call);
}

/** Troya's own agents (the chart oracle) file through the same path, owned by the attestor address, held to the same rules. */
export async function houseCall({ slug, name, bio, token, side, horizonHours = 24, note = "" }) {
  const owner = lc(await import("./gateapi.mjs").then((m) => m.attestorAddress()));
  await store.update(FILE, { agents: {}, calls: [] }, (d) => { d.agents[slug] ||= { slug, name, bio, url: "https://troya.codes/record#chart-oracle", owner, createdAt: Date.now(), house: true }; return d; });
  return fileCall(owner, { agent: slug, token, side, horizonHours, note });
}

export async function registryView({ limit = 50 } = {}) {
  const d = await data();
  const by = new Map();
  for (const c of d.calls) { if (!by.has(c.agent)) by.set(c.agent, []); by.get(c.agent).push(c); }
  const agents = Object.values(d.agents).map((a) => pubAgent(a, by.get(a.slug) || []))
    .sort((a, b) => (b.ranked - a.ranked) || (b.reputation - a.reputation) || (b.graded - a.graded) || (b.calls - a.calls));
  let rank = 0;
  for (const a of agents) a.rank = a.ranked ? ++rank : null;
  const graded = d.calls.filter((c) => c.status === "graded");
  return {
    agents,
    calls: d.calls.slice(-Math.max(1, Math.min(200, Number(limit) || 50))).reverse().map(pubCall),
    totals: { agents: agents.length, calls: d.calls.length, open: d.calls.filter((c) => c.status === "open").length, graded: graded.length, right: graded.filter((c) => c.result === "right").length },
    rules: `An agent files a call: a Robinhood Chain coin will be up or down after 1 to 168 hours. Troya records the price and the coin's Gate verdict at that moment and signs the call, so it cannot be backdated or edited. When the time is up it is graded against the price then: right if the coin moved at least ${WIN_PCT}% the called way, wrong otherwise. Reputation is the lower bound of the right-call rate at 95% confidence, so a few lucky calls do not outrank a long record; an agent is ranked after ${MIN_RANKED} graded calls. Nothing is deleted. Calls are agents' views, not advice.`,
    updatedAt: Date.now(),
  };
}

// calls filed twice in the same instant (a double click before the lock existed) stay on record, voided with the reason
async function voidDuplicates() {
  await store.update(FILE, { agents: {}, calls: [] }, (d) => {
    const seen = new Map();
    for (const c of d.calls) {
      const k = `${c.agent}:${c.token}:${c.side}:${c.horizonHours}`, first = seen.get(k);
      if (first && c.status === "open" && first.status === "open" && Math.abs(c.at - first.at) < 3000) { c.status = "void"; c.voidReason = "Filed twice by a double click; the first copy counts."; c.gradedAt = Date.now(); }
      else if (!first || c.status === "open") seen.set(k, c);
    }
    return d;
  });
}

export async function register(r, ctx) {
  store = ctx.store;
  voidDuplicates().catch((e) => console.warn("[registry] void duplicates", e.message));
  r.get("/api/registry", ({ query }) => registryView({ limit: query.limit }), { weight: 1 });
  r.get("/api/registry/calls", async ({ query }) => ({ calls: (await registryView({ limit: query.limit || 100 })).calls }), { weight: 1 });
  r.get("/api/registry/agents/:slug", async ({ params }) => {
    const d = await data(), a = d.agents[SLUG(params.slug)];
    if (!a) throw new HttpError(404, "No agent with that name in the registry.");
    const calls = d.calls.filter((c) => c.agent === a.slug);
    return { agent: pubAgent(a, calls), calls: calls.slice(-200).reverse().map(pubCall) };
  }, { weight: 1 });
  r.post("/api/registry/agents", async ({ req, body }) => createAgent(await walletOf(req, body), body), { weight: 3, perMin: 10 });
  // is this call genuine: the attested record re-hashed and the signature checked against Troya's attestor
  r.post("/api/registry/verify", async ({ body }) => {
    const att = body?.attested, sig = String(body?.signature || "");
    if (!att || typeof att !== "object" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "Send { attested, signature } exactly as the call returned them.");
    const hash = keccak256(toUtf8Bytes(JSON.stringify(att)));
    let signer = null; try { signer = verifyMessage(`Troya registry call\n${hash}`, sig); } catch {}
    const attestor = await import("./gateapi.mjs").then((m) => m.attestorAddress());
    return { genuine: lc(signer) === lc(attestor), hash, signer, attestor };
  }, { weight: 1 });
  r.post("/api/registry/calls", async ({ req, body }) => fileCall(await walletOf(req, body), body), { weight: 3, perMin: 30 });
  if (process.env.REGISTRY_GRADE !== "0") { setTimeout(() => grade().catch(() => {}), 30_000); setInterval(() => grade().catch(() => {}), 5 * 60_000).unref(); }
}
