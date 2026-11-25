// V10 F62 Bow: Agent Passport. A passport for an AI agent built from evidence, not claims: each stamp is one fact with the
// transaction, contract read or Troya record behind it, plus a few counts, warnings and a dated summary, signed by the
// Troya attestor ("Troya Bow"). Only Odysseus could string his own bow.
// Bow measures little that is new. It reads what other modules already keep, through their own functions and caches:
//   identity    ERC-8004 on Robinhood Chain (allies.mjs erc8004Agent / alliesOf): the agent ids, owner, agent wallet, its
//               agent card and its ERC-8004 feedback
//   record      Troya's agent registry (calls filed and graded in public), the Arena (paper strategy), its launches and
//               what Troya Gate, Ring Radar, Watchfire and Oaths say about those coins now (all via alliesOf)
//   paid jobs   USDG it paid Troya for Gate checks (gateapi.json deposits), Gate checks it paid over x402 (x402.json), and
//               whether it is listed as a seller on Virtuals ACP (the public api.acp.virtuals.io agent read)
//   receipts    Troya Seal receipts that name it or its coins, last 7 days (via alliesOf)
//   wallet      its first ETH and transaction count (devlinks.mjs firstFunder / infoOf: Blockscout PRO)
//   farms       its ERC-8004 reviewers: the first funder of up to 12 of them. Reviewers paid by the agent's own wallets,
//               the agent reviewing itself, or several reviewers first paid by one small wallet (the funder lines that
//               devlinks.mjs and clusters.mjs draw: over 3,000 transactions is a hub that links nobody) read as a farm;
//               an owner wallet that holds many ERC-8004 identities is said too
//   endpoints   the agent card URL in its registration and up to 3 https endpoints it lists: one plain GET each, 5 s, no
//               redirects followed, no payment ever sent (a 402 is recorded as "asks for payment"), private and local
//               addresses refused
// Honest limit: Bow describes what wallets and endpoints did, never who runs them. ERC-8004 registries can be filled with
// Sybil identities and feedback; every stamp says where it came from so it can be weighed.
//   GET  /api/bow                   what Bow is, and real agents Troya already knows (examples)
//   GET  /api/bow?agentId=<id>      the passport of an ERC-8004 agent by id
//   GET  /api/bow/:address          the passport of an agent wallet (?agentId= also reads that id and says if it links)
//   GET  /api/bow/:id.svg           the passport as an embeddable card (address or ERC-8004 id)
//   POST /api/bow/verify            { attested, signed } → is this a genuine Troya Bow (or Phaeacians) record
// Read-only: nothing here trades, signs a transaction or moves money.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Interface, getAddress, isAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { rpc } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";
import { untrusted } from "./tools.mjs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const SITE = "https://troya.codes";
const IDENTITY = getAddress(process.env.ERC8004_IDENTITY || "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
const REPUTATION = getAddress(process.env.ERC8004_REPUTATION || "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
const FILE = "bow.json";
const LABEL = "Troya Bow";
const TTL = 5 * 60_000, TTL_PARTIAL = 45_000;
const HUB_TXS = 3000, SMALL_TXS = 300;          // the funder lines devlinks.mjs and clusters.mjs draw
const MAX_REVIEWERS = 12, MAX_ENDPOINTS = 3, MANY_IDS = 25;
const PROBE_MS = 5000, PROBE_BYTES = 64 * 1024, PROBE_TTL = 10 * 60_000;
const UA = "TroyaBow/1 (+https://troya.codes/agent#/bow; one GET, never pays)";
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const stamp = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const withTimeout = (p, ms, v = null) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(v), ms))]);
let store = null;

const EV = {
  tx: (hash, note, base = EXPLORER) => ({ type: "tx", ref: hash, url: `${base}/tx/${hash}`, note }),
  address: (a, note) => ({ type: "address", ref: getAddress(a), url: `${EXPLORER}/address/${getAddress(a)}`, note }),
  nft: (id, note) => ({ type: "erc8004", ref: `${IDENTITY}#${id}`, url: `${EXPLORER}/token/${IDENTITY}/instance/${id}`, note }),
  read: (contract, note) => ({ type: "contract-read", ref: getAddress(contract), url: `${EXPLORER}/address/${getAddress(contract)}?tab=read_proxy`, note }),
  troya: (url, note) => ({ type: "troya", ref: url, url, note }),
  web: (url, note) => ({ type: "http", ref: url, url, note }),
};

/* ---------- small chain reads ---------- */
const idI = new Interface(["function balanceOf(address) view returns (uint256)"]);
const repI = new Interface(["function getClients(uint256) view returns (address[])"]);
async function call(to, i, fn, args) {
  const r = await rpc("robinhood", "eth_call", [{ to, data: i.encodeFunctionData(fn, args) }, "latest"], { timeoutMs: 10_000 });
  return i.decodeFunctionResult(fn, r);
}
const idsOwned = (a) => call(IDENTITY, idI, "balanceOf", [a]).then((r) => Number(r[0])).catch(() => null);
const clientsOf = (id) => call(REPUTATION, repI, "getClients", [BigInt(id)]).then((r) => [...r[0]].map(lc)).catch(() => null);

/* ---------- wallets: first ETH and size (devlinks.mjs, Blockscout PRO) ---------- */
let dl = null;
async function devlinks() {
  if (dl) return dl;
  dl = await import("./devlinks.mjs");
  dl.initDevLinks?.(store);                      // keeps the store devlinks already has; sets it in a process without one
  return dl;
}
async function funderOf(w) { const m = await devlinks(); return withTimeout(m.firstFunder(w).catch(() => null), 15_000); }
async function sizeOf(w) { const m = await devlinks(); return withTimeout(m.infoOf(w).catch(() => null), 12_000); }
const hasExplorer = async () => !!process.env.BLOCKSCOUT_API_KEY && (await import("./market.mjs").then((m) => m.hasBlockscout?.() !== false).catch(() => true));

/* ---------- endpoints: one plain GET, never a payment ---------- */
function privateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const x = lc(ip);
  if (x.startsWith("::ffff:")) return privateIp(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
}
function toHttps(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { why: "not a URL" }; }
  if (u.protocol === "ipfs:") { const cid = u.hostname || u.pathname.replace(/^\/+/, ""); u = new URL(`https://ipfs.io/ipfs/${cid}${u.hostname ? u.pathname : ""}`); }
  if (u.protocol !== "https:") return { why: `${u.protocol.replace(":", "")} address: only https endpoints are read` };
  if (u.username || u.password) return { why: "has credentials in it: not read" };
  if (u.port && u.port !== "443") return { why: "a non-standard port: not read" };
  const host = lc(u.hostname);
  if (host === "localhost" || /\.(local|internal|localhost|lan|home)$/.test(host)) return { why: "a local name: not read" };
  return { u };
}
const probes = new Map();                         // url → { at, p }
async function fetchOnce(u) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) return { status: "down", note: "the name does not resolve" };
  if (ips.some(privateIp)) return { status: "skipped", note: "points at a private or local address: not read" };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(u.href, { method: "GET", redirect: "manual", headers: { accept: "application/json, text/plain;q=0.8, */*;q=0.5", "user-agent": UA }, signal: AbortSignal.timeout(PROBE_MS) });
  } catch (e) {
    return { status: "down", ms: Date.now() - t0, note: /timeout|abort/i.test(String(e?.name || e?.message)) ? `no answer within ${PROBE_MS / 1000} s` : "the connection failed" };
  }
  const ms = Date.now() - t0;
  // read at most PROBE_BYTES of the body (an agent card), then stop
  let text = "";
  try {
    const rd = res.body?.getReader();
    const chunks = []; let n = 0;
    while (rd) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; if (n >= PROBE_BYTES) { await rd.cancel().catch(() => {}); break; } }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, PROBE_BYTES).toString("utf8");
  } catch {}
  const code = res.status;
  const status = code === 402 ? "asks-payment" : code >= 200 && code < 300 ? "up" : code >= 300 && code < 400 ? "redirects" : [401, 403, 405, 406].includes(code) ? "answers" : code >= 500 ? "down" : "error";
  return { status, httpStatus: code, ms, contentType: untrusted(res.headers.get("content-type"), 60) || null, location: code >= 300 && code < 400 ? untrusted(res.headers.get("location"), 160) || null : null, text };
}
/** One endpoint, read once every 10 minutes at most. */
async function probe(raw) {
  const { u, why } = toHttps(raw);
  if (!u) return { url: untrusted(raw, 160), status: "skipped", note: why };
  const k = u.href;
  const hit = probes.get(k);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.p;
  const p = fetchOnce(u).catch((e) => ({ status: "down", note: String(e?.message || e).slice(0, 80) })).then((r) => ({ url: untrusted(u.href, 200), host: untrusted(u.hostname, 80), at: Date.now(), ...r }));
  probes.set(k, { at: Date.now(), p });
  if (probes.size > 500) probes.delete(probes.keys().next().value);
  return p;
}
const HEALTHY = new Set(["up", "answers", "asks-payment", "redirects"]);
const SAY = {
  up: (r) => `answered ${r.httpStatus} in ${r.ms} ms`, answers: (r) => `answered ${r.httpStatus} (needs a key or another method) in ${r.ms} ms`,
  "asks-payment": (r) => `answered 402 (asks for payment; Troya did not pay) in ${r.ms} ms`, redirects: (r) => `answered ${r.httpStatus}, a redirect${r.location ? ` to ${r.location}` : ""} (not followed), in ${r.ms} ms`,
  down: (r) => (r.httpStatus ? `answered ${r.httpStatus}, a server error, in ${r.ms} ms` : r.note || "did not answer"), error: (r) => `answered ${r.httpStatus} in ${r.ms} ms`,
  skipped: (r) => `not read: ${r.note}`,
};
const said = (r) => (SAY[r.status] || (() => r.status))(r);
// an ERC-8004 registration file (agent card) read from the web
function readCard(text) {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object") return null;
    const svc = Array.isArray(j.services) ? j.services : Array.isArray(j.endpoints) ? j.endpoints : [];
    return { name: untrusted(j.name, 60) || null, description: untrusted(j.description, 200) || null,
      services: svc.slice(0, 8).map((x) => ({ name: untrusted(x?.name || x?.type, 30) || null, endpoint: untrusted(x?.endpoint || x?.url, 200) || null })).filter((x) => x.endpoint),
      x402: j.x402support ?? j.x402Support ?? null, active: typeof j.active === "boolean" ? j.active : null };
  } catch { return null; }
}

/* ---------- Troya's own ledgers: what it paid Troya ---------- */
async function paidJobs(a) {
  const A = lc(a);
  const [g, x] = await Promise.all([store.readJson("gateapi.json", {}).catch(() => ({})), store.readJson("x402.json", {}).catch(() => ({}))]);
  const deposits = Object.entries(g.deposits || {}).filter(([, d]) => lc(d.from) === A).map(([k, d]) => ({ tx: k.split(":")[0], usdg: d.usdg, at: d.at, block: d.block })).sort((p, q) => q.at - p.at);
  const scans = { "eip155:4663": EXPLORER, "eip155:8453": "https://basescan.org", "eip155:42161": "https://arbiscan.io", "eip155:137": "https://polygonscan.com", "eip155:84532": "https://sepolia.basescan.org" };
  const names = { "eip155:4663": "Robinhood Chain", "eip155:8453": "Base", "eip155:42161": "Arbitrum", "eip155:137": "Polygon", "eip155:84532": "Base Sepolia" };
  const x402 = (x.last || []).filter((p) => lc(p.payer) === A).map((p) => ({ tx: p.tx, network: p.network, chain: names[p.network] || p.network, scan: scans[p.network] || null, token: p.token, verdict: p.verdict, at: p.at }));
  return { deposits, x402, creditUsdg: (g.credits?.[A] || 0) / 1e6, x402Window: (x.last || []).length };
}
// listed as an agent on Virtuals ACP (a public read; ACP's own job counts are not public there)
const acpMemo = new Map();
async function acpListing(a) {
  const k = lc(a), hit = acpMemo.get(k);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const url = `https://api.acp.virtuals.io/agents/wallet/${k}`;
  const v = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(6000) }).then(async (r) => {
    if (r.status === 404) return { listed: false, url };
    if (!r.ok) return { error: `ACP answered ${r.status}`, url };
    const d = (await r.json())?.data;
    if (!d || lc(d.walletAddress) !== k) return { listed: false, url };
    return { listed: true, url, name: untrusted(d.name, 60), role: untrusted(d.role, 20) || null, rating: d.rating ?? null, createdAt: Date.parse(d.createdAt) || null,
      chains: (d.chains || []).map((c) => Number(c.chainId)).filter(Boolean).slice(0, 6),
      offerings: (d.offerings || []).filter((o) => !o.isHidden && !o.isPrivate).slice(0, 6).map((o) => ({ name: untrusted(o.name, 60), price: Number(o.priceValue) || null, priceType: untrusted(o.priceType, 20) || null, slaMinutes: Number(o.slaMinutes) || null })) };
  }).catch((e) => ({ error: String(e?.message || e).slice(0, 80), url }));
  acpMemo.set(k, { at: Date.now(), v });
  if (acpMemo.size > 1000) acpMemo.delete(acpMemo.keys().next().value);
  return v;
}

/* ---------- farm-like reviewers ---------- */
async function reviewers(agent, own) {
  const clients = await clientsOf(agent.agentId);
  if (!clients) return { status: "unknown", note: "the reputation registry could not be read just now" };
  if (!clients.length) return { status: "none", clients: 0 };
  const sample = clients.slice(0, MAX_REVIEWERS);
  const self = sample.filter((c) => own.has(c));
  if (!(await hasExplorer())) return { status: "partial", clients: clients.length, sampled: 0, self, note: "the explorer key is not set or paused, so the reviewers' first funders were not read" };
  const ff = new Map();
  for (let i = 0; i < sample.length; i += 3) {
    const got = await Promise.all(sample.slice(i, i + 3).map((c) => funderOf(c).then((f) => [c, f])));
    for (const [c, f] of got) ff.set(c, f);
  }
  const byAgent = sample.filter((c) => own.has(lc(ff.get(c)?.funder)));
  const groups = new Map();
  for (const c of sample) { const f = lc(ff.get(c)?.funder); if (f && !own.has(f)) { if (!groups.has(f)) groups.set(f, []); groups.get(f).push(c); } }
  const shared = [];
  for (const [f, cs] of groups) {
    if (cs.length < 2) continue;
    const sz = await sizeOf(f);
    shared.push({ funder: f, clients: cs, txs: sz?.txs ?? null, hub: sz?.txs != null && sz.txs > HUB_TXS, small: sz?.txs != null && sz.txs <= SMALL_TXS });
  }
  const read = sample.filter((c) => ff.get(c) && ff.get(c).how !== "unknown").length;
  return { status: "done", clients: clients.length, sampled: sample.length, read, self, byAgent, shared, ff };
}

/* ---------- the passport ---------- */
async function build(address, askedId) {
  const cov = [];
  const note = (source, status, n) => cov.push({ source, status, ...(n ? { note: n } : {}) });
  const allies = await import("./allies.mjs");
  const al = await withTimeout(allies.alliesOf(address, { agentId: askedId }), 40_000);
  if (!al) throw Object.assign(new HttpError(504, "The agent record did not finish in time. Ask again in a minute."), { expose: true });
  note("Allies (ERC-8004, registry, Arena, launches, Seal)", "done");
  const A = al.address;
  const agents = al.identity?.erc8004?.agents || [];
  const primary = agents.find((g) => g.agentId === String(askedId)) || agents[0] || null;
  const own = new Set([lc(A), ...agents.flatMap((g) => [lc(g.owner), lc(g.agentWallet)]).filter(Boolean)]);
  const owners = [...new Set(agents.map((g) => lc(g.owner)).filter((o) => o && o !== lc(A)))];

  // everything Bow reads on top of Allies, at once
  const cardUrl = primary?.uri && !String(primary.uri).startsWith("data:") ? primary.uri : null;
  const [paid, acp, wallet, size, rev, ownerIds, card] = await Promise.all([
    paidJobs(A).catch(() => null),
    acpListing(A),
    (async () => ((await hasExplorer()) ? funderOf(A) : "no-explorer"))(),
    (async () => ((await hasExplorer()) ? sizeOf(A) : null))(),
    primary && (primary.reputation?.clients || 0) > 0 ? reviewers(primary, own).catch((e) => ({ status: "unknown", note: e.message })) : null,
    Promise.all(owners.slice(0, 2).map(async (o) => [o, await idsOwned(o)])),
    cardUrl ? probe(cardUrl) : null,
  ]);
  const webCard = card?.text ? readCard(card.text) : null;
  const chainCard = primary?.card || null;
  const services = (webCard?.services?.length ? webCard.services : chainCard?.services || []).filter((s) => s.endpoint && /^(https|ipfs):\/\//i.test(s.endpoint));
  const seenUrl = new Set(card ? [card.url] : []);
  const svc = [];
  for (const s of services) { const t = toHttps(s.endpoint); const k = t.u?.href; if (k && !seenUrl.has(k)) { seenUrl.add(k); svc.push(s); } if (svc.length >= MAX_ENDPOINTS) break; }
  const svcProbes = await Promise.all(svc.map((s) => probe(s.endpoint).then((r) => ({ ...r, name: s.name }))));
  const endpoints = [...(card ? [{ ...card, name: "agent card", text: undefined }] : []), ...svcProbes.map((r) => ({ ...r, text: undefined }))];

  const stamps = [], warnings = [];
  const S = (key, title, text, evidence = [], extra = {}) => stamps.push({ key, title, text, evidence: evidence.filter(Boolean), ...extra });
  const W = (key, level, text, evidence = []) => warnings.push({ key, level, text, evidence: evidence.filter(Boolean) });
  const name = webCard?.name || chainCard?.name || (al.identity?.troya || [])[0]?.name || (acp?.listed ? acp.name : null) || null;

  /* identity */
  for (const g of agents) {
    S(`erc8004:${g.agentId}`, "ERC-8004 identity", `Agent #${g.agentId}${g.card?.name ? ` "${g.card.name}"` : g === primary && webCard?.name ? ` "${webCard.name}"` : ""} on Robinhood Chain; this wallet is its ${g.role}${g.role === "agent wallet" ? `, owner ${short(g.owner)}` : g.agentWallet && lc(g.agentWallet) !== lc(A) ? `, agent wallet ${short(g.agentWallet)}` : ""}.`,
      [EV.nft(g.agentId, "ownerOf, tokenURI and the agentWallet metadata read from the IdentityRegistry")]);
  }
  const idsHere = al.identity?.erc8004?.owned;
  if (!agents.length && idsHere > 0) S("erc8004:owned", "ERC-8004 identity", `Owns ${plural(idsHere, "ERC-8004 identity", "ERC-8004 identities")} on Robinhood Chain; pass its agent id to read one.`, [EV.read(IDENTITY, "balanceOf on the IdentityRegistry")]);
  const askedCheck = (al.checks || []).find((c) => c.name === "ERC-8004 agentId");
  if (askedCheck?.status === "flag") W("erc8004:not-linked", "red", askedCheck.detail, [EV.nft(askedId, "owner and agent wallet of the id you asked about")]);
  if (askedCheck?.status === "none") W("erc8004:missing", "amber", askedCheck.detail, [EV.read(IDENTITY, "ownerOf reverts for an id that does not exist")]);

  /* ERC-8004 feedback */
  for (const g of agents.filter((x) => x.reputation?.feedback)) {
    S(`feedback:${g.agentId}`, "ERC-8004 feedback", `#${g.agentId}: ${plural(g.reputation.feedback, "feedback entry", "feedback entries")} from ${plural(g.reputation.clients, "client")}${g.reputation.average != null ? `, average ${g.reputation.average}` : ""}${g.reputation.note ? ` (${g.reputation.note})` : ""}. Whatever its clients chose to leave, unfiltered.`,
      [EV.read(REPUTATION, "getClients and getSummary on the ReputationRegistry")]);
  }
  if (rev?.status === "done" || rev?.status === "partial") {
    const ffEv = (c) => { const f = rev.ff?.get(c); return f?.tx ? EV.tx(f.tx, `first ETH of reviewer ${short(c)}`) : EV.address(c, "reviewer"); };
    if (rev.self?.length) W("farm:self-review", "red", `${plural(rev.self.length, "reviewer")} of agent #${primary.agentId} ${rev.self.length === 1 ? "is" : "are"} the agent's own wallet: it reviewed itself.`, rev.self.slice(0, 3).map((c) => EV.address(c, "a reviewer that is the agent's owner or agent wallet")));
    if (rev.byAgent?.length) W("farm:funded-by-agent", "red", `${plural(rev.byAgent.length, "reviewer")} of agent #${primary.agentId} got ${rev.byAgent.length === 1 ? "its" : "their"} first ETH from the agent's own wallets.`, rev.byAgent.slice(0, 3).map(ffEv));
    for (const s of rev.shared || []) {
      if (s.hub) continue;
      const big = s.clients.length >= 3 || s.clients.length * 2 >= rev.sampled;
      W("farm:shared-funder", s.small || (big && s.clients.length >= 3) ? "red" : "amber", `${s.clients.length} of the ${rev.sampled} reviewers read for agent #${primary.agentId} got their first ETH from one wallet, ${short(s.funder)}${s.txs != null ? ` (${plural(s.txs, "transaction")} in all)` : ""}. Feedback that looks farmed.`,
        [EV.address(s.funder, "the shared first funder"), ...s.clients.slice(0, 2).map(ffEv)]);
    }
    if (rev.status === "done") {
      const hubs = (rev.shared || []).filter((s) => s.hub).length;
      const clean = !rev.self?.length && !rev.byAgent?.length && !(rev.shared || []).some((s) => !s.hub);
      if (clean) S(`reviewers:${primary.agentId}`, "Reviewers read", `The first funders of ${rev.read} of its ${plural(rev.clients, "ERC-8004 reviewer")} were read: none is the agent itself, none was paid by it, no small wallet funded several${hubs ? ` (${plural(hubs, "busy hub")}, such as an exchange or bridge, funded more than one, which links nobody)` : ""}.`,
        [EV.read(REPUTATION, "getClients on the ReputationRegistry; first funders read from Blockscout")]);
      note("ERC-8004 reviewers", "done", `${rev.sampled} of ${rev.clients} read${rev.clients > rev.sampled ? ` (the first ${MAX_REVIEWERS})` : ""}`);
    } else note("ERC-8004 reviewers", "partial", rev.note);
  } else if (rev?.status === "unknown") note("ERC-8004 reviewers", "failed", rev.note);
  else if (primary) note("ERC-8004 reviewers", "n/a", "no ERC-8004 feedback to read");
  for (const [o, n] of ownerIds) if (n >= MANY_IDS) W("farm:many-identities", "amber", `Its owner wallet ${short(o)} holds ${n.toLocaleString("en-US")} ERC-8004 identities. Registries can be filled in bulk; one owner with many agents is worth knowing.`, [EV.read(IDENTITY, `balanceOf(${short(o)}) on the IdentityRegistry`)]);
  if (!agents.length && idsHere >= MANY_IDS) W("farm:many-identities", "amber", `This wallet holds ${idsHere.toLocaleString("en-US")} ERC-8004 identities. Registries can be filled in bulk.`, [EV.read(IDENTITY, "balanceOf on the IdentityRegistry")]);

  /* Troya registry: calls filed and graded in public */
  for (const g of al.identity?.troya || []) {
    S(`registry:${g.slug}`, "Graded calls", g.graded ? `"${g.name}" in Troya's registry: ${g.right} right of ${g.graded} graded calls${g.reputation != null ? `, reputation ${g.reputation} of 100` : ""}${g.rank ? `, rank ${g.rank}` : ""}${g.avgReturnPct != null ? `, average move ${g.avgReturnPct >= 0 ? "+" : ""}${g.avgReturnPct}% the called way` : ""}.`
      : `"${g.name}" in Troya's registry: ${plural(g.calls, "call")} filed, none graded yet.`, [EV.troya(g.url, "every call signed by the Troya attestor at filing and graded against the price after")], { house: g.house || undefined });
  }
  /* Arena */
  if (al.arena) {
    const s = al.arena.stats || {};
    S("arena", "Arena strategy", `A ${al.arena.status} paper strategy in the Arena: ${plural(s.closed || 0, "closed trade")}, ${s.pnlEth >= 0 ? "+" : ""}${s.pnlEth ?? 0} ETH${s.winRate != null ? `, ${Math.round(s.winRate * 100)}% won` : ""}. Paper money, not real trades.`, [EV.troya(`${SITE}/agent#/leaderboard`, "the Arena board")]);
  }
  /* paid jobs */
  if (paid?.deposits.length) {
    const tot = +paid.deposits.reduce((s, d) => s + (d.usdg || 0), 0).toFixed(6);
    S("paid:usdg", "Paid for Gate checks", `Paid Troya ${tot} USDG for Gate checks on Robinhood Chain in ${plural(paid.deposits.length, "payment")}, the latest on ${day(paid.deposits[0].at)}.`, paid.deposits.slice(0, 3).map((d) => EV.tx(d.tx, `${d.usdg} USDG to the Gate API's pay-to address`)));
  }
  if (paid?.x402.length) {
    S("paid:x402", "Paid for Gate checks", `Paid for ${plural(paid.x402.length, "Troya Gate check")} over x402 (${[...new Set(paid.x402.map((p) => p.chain))].join(", ")}), the latest on ${day(paid.x402[0].at)}.`, paid.x402.slice(0, 3).map((p) => (p.scan ? EV.tx(p.tx, `x402 settlement on ${p.chain}`, p.scan) : null)));
  }
  if (paid) note("Troya ledgers (Gate API, x402)", "done", `x402 keeps its latest ${paid.x402Window} payments`); else note("Troya ledgers (Gate API, x402)", "failed");
  if (acp?.listed) {
    S("acp", "Virtuals ACP", `Listed on Virtuals ACP as "${acp.name}"${acp.role ? ` (${acp.role.toLowerCase()})` : ""}${acp.offerings.length ? `, selling ${acp.offerings.map((o) => `${o.name}${o.price != null ? ` at ${o.price}` : ""}`).join(", ")}` : ""}${acp.rating != null ? `, rating ${acp.rating}` : ", no rating yet"}. ACP does not publish its job count here.`, [EV.web(acp.url, "Virtuals ACP's public agent read")]);
    note("Virtuals ACP", "done");
  } else note("Virtuals ACP", acp?.error ? "failed" : "done", acp?.error || "not listed as an ACP agent");
  /* receipts */
  if (al.seal?.count) {
    S("seal", "Seal receipts", `${plural(al.seal.count, "Troya Seal receipt")} in the last ${al.seal.days} days name this wallet or its coins: ${Object.entries(al.seal.byKind || {}).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(", ")}.`, (al.seal.recent || []).slice(0, 2).map((r) => EV.troya(r.url, `receipt ${r.kind}`)));
  }
  /* launches and incidents */
  const coins = al.launches?.coins || [];
  if (coins.length) S("launches", "Coins launched", `Launched ${coins.map((c) => `$${c.symbol || "?"} (Gate ${c.gate?.verdict || "unknown"})`).join(", ")}.`, coins.slice(0, 3).map((c) => (c.tx ? EV.tx(c.tx, "the launch") : EV.address(c.token, "the coin"))));
  const coinsCheck = (al.checks || []).find((c) => c.name === "Its coins now");
  if (coinsCheck?.status === "flag") W("incident:coins", "red", `Red flags on coins it launched: ${coinsCheck.detail}`, coins.filter((c) => c.gate?.verdict === "failed" || c.ring === "red" || c.oath === "broken" || c.watchfire === "fire").slice(0, 3).map((c) => EV.troya(`${SITE}/agent#/heel/${c.token}`, `$${c.symbol || "?"} read again now`)));
  else if (coinsCheck?.status === "warn") W("incident:coins", "amber", `Coins it launched need a look: ${coinsCheck.detail}`, coins.slice(0, 2).map((c) => EV.troya(`${SITE}/agent#/heel/${c.token}`, `$${c.symbol || "?"}`)));
  if (al.launches?.outsideTroya?.status === "unknown") note("Pons launches outside Troya", "n/a", al.launches.outsideTroya.note);
  /* wallet */
  if (wallet === "no-explorer") note("Wallet history", "n/a", "the explorer key is not set or paused on this server");
  else if (wallet?.funder) S("wallet:funder", "First ETH", `First ETH came from ${short(wallet.funder)}${wallet.eth ? ` (${+wallet.eth.toFixed(5)} ETH)` : ""}${wallet.at ? ` on ${day(wallet.at)}` : ""}.`, [wallet.tx ? EV.tx(wallet.tx, "the first transaction paying this wallet") : EV.address(wallet.funder, "the first funder")]);
  else if (wallet?.how === "contract") S("wallet:funder", "First ETH", `First ETH came through a contract, ${short(wallet.via)}${wallet.viaFrom ? `, called by ${short(wallet.viaFrom)}` : ""}${wallet.at ? ` on ${day(wallet.at)}` : ""} (a bridge, exchange or app).`, [wallet.tx ? EV.tx(wallet.tx, "the funding transaction") : null]);
  if (size?.txs != null) S("wallet:size", "Activity", `${size.txs.toLocaleString("en-US")} transactions on Robinhood Chain; it is ${al.kind === "contract" ? "a contract" : al.kind === "unknown" ? "of unknown kind" : `a ${al.kind}`}.`, [EV.address(A, "Blockscout counters")]);
  if (wallet !== "no-explorer") note("Wallet history", wallet || size ? "done" : "failed");
  /* endpoints */
  if (!endpoints.length) note("Endpoint health", "n/a", primary ? (primary.uri === "data: (agent card written on chain)" ? "its on-chain card lists no https endpoint" : primary.uri ? `its registration points at "${untrusted(primary.uri, 60)}", not an https address` : "no registration URI") : "no ERC-8004 registration to read endpoints from");
  else {
    for (const r of endpoints) {
      if (r.status === "skipped") continue;
      S(`endpoint:${endpoints.indexOf(r)}`, r.name === "agent card" ? "Agent card" : "Endpoint", `${r.name === "agent card" ? "The agent card" : `Endpoint${r.name ? ` "${r.name}"` : ""}`} at ${r.host} ${said(r)} on ${stamp(r.at)}.`, [EV.web(r.url, "one plain GET from the Troya server; no payment sent")], { health: HEALTHY.has(r.status) ? "up" : "down" });
    }
    const read = endpoints.filter((r) => r.status !== "skipped");
    if (read.length && read.every((r) => !HEALTHY.has(r.status))) W("endpoints:down", "amber", `None of the ${plural(read.length, "endpoint")} in its registration answered properly: ${read.map((r) => `${r.host} ${said(r)}`).join("; ")}.`, read.slice(0, 2).map((r) => EV.web(r.url, "one plain GET")));
    if (card && card.status === "up" && !webCard) W("endpoints:card", "amber", `Its agent card at ${card.host} answered but is not readable JSON.`, [EV.web(card.url, "the registration URI")]);
    if (webCard?.active === false) W("endpoints:inactive", "amber", "Its own agent card says it is not active.", [EV.web(card.url, "\"active\": false in the registration file")]);
    note("Endpoint health", "done", `${plural(read.length, "endpoint")} read, ${read.filter((r) => HEALTHY.has(r.status)).length} answered`);
  }

  /* counts, standing, summary */
  const reg = al.identity?.troya || [];
  const counts = {
    erc8004Ids: agents.length || idsHere || 0,
    feedback: agents.reduce((s, g) => s + (g.reputation?.feedback || 0), 0),
    reviewers: agents.reduce((s, g) => s + (g.reputation?.clients || 0), 0),
    gradedCalls: reg.reduce((s, g) => s + (g.graded || 0), 0),
    rightCalls: reg.reduce((s, g) => s + (g.right || 0), 0),
    paidChecks: (paid?.deposits.length || 0) + (paid?.x402.length || 0),
    sealReceipts: al.seal?.count || 0,
    launches: coins.length,
    endpointsRead: endpoints.filter((r) => r.status !== "skipped").length,
    endpointsUp: endpoints.filter((r) => HEALTHY.has(r.status)).length,
  };
  const track = counts.gradedCalls || counts.feedback || counts.paidChecks || counts.sealReceipts || al.arena || acp?.listed;
  const standing = warnings.some((w) => w.level === "red") ? "flagged" : warnings.length ? "watch" : track ? "evidenced" : stamps.length ? "thin" : "unknown";
  const STAND = {
    flagged: "Read the red warnings before giving it money or work.",
    watch: "Some of the evidence needs a second look.",
    evidenced: "It has a public track record Troya can show. A record is history, not a promise.",
    thin: "It is registered but has no track record Troya can read yet: untested, so start small.",
    unknown: "Troya has no record of it. Unknown is untested, not bad.",
  };
  const at = Date.now();
  const label = name ? `"${name}"` : primary ? `ERC-8004 agent #${primary.agentId}` : short(A);
  const summary = `As of ${stamp(at)}, ${label}${label === short(A) ? "" : ` (${short(A)})`} carries ${plural(stamps.length, "stamp")} and ${warnings.length ? `${plural(warnings.length, "warning")}${warnings[0] ? `, first: ${warnings[0].text.replace(/\.$/, "")}` : ""}` : "no warnings"}. ${STAND[standing]}`;

  const attested = {
    v: 1, kind: "troya-bow", chainId: 4663, address: A, agentId: primary?.agentId ?? (askedId != null ? String(askedId) : null), standing, counts,
    stamps: stamps.map((s) => ({ key: s.key, ref: s.evidence[0]?.ref || null })), warnings: warnings.map((w) => ({ key: w.key, level: w.level })), at,
  };
  let signed = null;
  try { signed = await (await import("./gateapi.mjs")).attest(attested, LABEL); } catch (e) { note("Signature", "failed", e.message); }
  const partial = cov.some((c) => c.status === "failed" || c.status === "partial");
  return {
    name: "Troya Bow", address: A, agentId: attested.agentId, label: name, kind: al.kind, standing, summary, counts, stamps, warnings,
    identity: { agents: agents.map((g) => ({ agentId: g.agentId, role: g.role, owner: g.owner, agentWallet: g.agentWallet, uri: g.uri, card: g === primary ? (webCard || g.card) : g.card, reputation: g.reputation })), registry: IDENTITY, reputationRegistry: REPUTATION },
    endpoints: endpoints.map(({ text, ...r }) => r), acp: acp?.listed ? acp : null,
    coverage: cov, partial, at, attested, signed,
    card: `${SITE}/api/bow/${primary && askedId != null ? primary.agentId : A}.svg`,
    page: `${SITE}/agent#/bow/${A}${primary ? `?agentId=${primary.agentId}` : ""}`,
    verify: `keccak256(JSON.stringify(attested)) = signed.hash; EIP-191 over "${LABEL}\\n" + hash recovers to signed.attestor (the Troya attestor, the same key as Gate API results). Or POST { attested, signed } to ${SITE}/api/bow/verify.`,
    limit: "Bow describes what wallets and endpoints did, never who runs them. ERC-8004 identities and feedback can be Sybil-farmed; agent cards and names are the agent's own claims. A passport is a dated snapshot, never a safe stamp.",
  };
}

/* ---------- entry points ---------- */
const memo = new Map(), inflight = new Map();
const idParam = (v) => {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{1,30}$/.test(s)) throw new HttpError(400, "agentId is a whole number (the ERC-8004 agent id).");
  return s;
};
/** The passport of an agent: by wallet (address), by ERC-8004 id (agentId), or both. Cached 5 minutes. */
export async function bowPassport({ address = null, agentId = null } = {}) {
  let id = idParam(agentId);
  let a = address ? String(address).trim() : null;
  if (a && /^\d{1,30}$/.test(a)) { id = a; a = null; }
  if (a && !isAddress(a)) throw new HttpError(400, "Give an agent's wallet address on Robinhood Chain (0x + 40 hex) or its ERC-8004 agent id.");
  if (!a && id == null) throw new HttpError(400, "Give an agent's wallet address or its ERC-8004 agent id.");
  if (!a) {
    const ag = await (await import("./allies.mjs")).erc8004Agent(id).catch(() => null);
    if (!ag) throw new HttpError(404, `No ERC-8004 agent #${id} on Robinhood Chain (IdentityRegistry ${short(IDENTITY)}).`);
    a = ag.agentWallet || ag.owner;
  }
  const A = getAddress(a), k = `${lc(A)}:${id ?? ""}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) inflight.set(k, build(A, id).then((res) => {
    memo.set(k, { at: Date.now(), ttl: res.partial ? TTL_PARTIAL : TTL, res });
    if (memo.size > 1000) memo.delete(memo.keys().next().value);
    if (store) store.update(FILE, {}, (d) => {
      d.stats ||= { passports: 0 }; d.stats.passports++; d.stats[res.standing] = (d.stats[res.standing] || 0) + 1;
      d.recent = [{ address: res.address, agentId: res.agentId, label: res.label ? untrusted(res.label, 40) : null, standing: res.standing, stamps: res.stamps.length, warnings: res.warnings.length, at: res.at, hash: res.signed?.hash || null },
        ...(d.recent || []).filter((x) => !(lc(x.address) === lc(res.address) && x.agentId === res.agentId))].slice(0, 200);
      return d;
    }).catch(() => {});
    return res;
  }).finally(() => inflight.delete(k)));
  return inflight.get(k);
}

/** Real agents Troya already knows, for one-tap examples: Troya's registry, ERC-8004 ids asked about, Gate API payers. */
async function examples() {
  const out = [], seen = new Set();
  const add = (x) => { const k = `${lc(x.address || "")}:${x.agentId || ""}`; if (seen.has(k) || out.length >= 8) return; seen.add(k); out.push(x); };
  const reg = await import("./registry.mjs").then((m) => m.registryView({ limit: 1 })).catch(() => null);
  for (const g of (reg?.agents || []).filter((x) => !x.house).slice(0, 3)) add({ address: g.owner, label: untrusted(g.name, 40), why: `files calls in Troya's registry (${g.graded} graded)` });
  for (const g of (reg?.agents || []).filter((x) => x.house).slice(0, 1)) add({ address: g.owner, label: untrusted(g.name, 40), why: "Troya's own house agent in the registry" });
  const al = await store.readJson("allies.json", {}).catch(() => ({}));
  for (const [w, ids] of Object.entries(al.byWallet || {}).slice(-3)) add({ address: getAddress(w), agentId: String(ids[ids.length - 1]), label: `ERC-8004 agent #${ids[ids.length - 1]}`, why: "an ERC-8004 agent Troya was asked about" });
  const pj = await Promise.all([store.readJson("gateapi.json", {}).catch(() => ({})), store.readJson("x402.json", {}).catch(() => ({}))]);
  for (const d of Object.values(pj[0].deposits || {}).slice(-3)) add({ address: getAddress(d.from), label: short(d.from), why: "paid Troya in USDG for Gate checks" });
  for (const p of (pj[1].last || []).slice(0, 3)) add({ address: getAddress(p.payer), label: short(p.payer), why: "paid for a Troya Gate check over x402" });
  const b = await store.readJson(FILE, {}).catch(() => ({}));
  for (const x of (b.recent || []).filter((x) => x.agentId && x.stamps >= 3).slice(0, 4)) add({ address: x.address, agentId: x.agentId, label: x.label || `ERC-8004 agent #${x.agentId}`, why: "an agent with a passport read here before" });
  return out;
}

/* ---------- the card ---------- */
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TONE = { flagged: ["FLAGGED", "#f0606d"], watch: ["WATCH", "#f2c26b"], evidenced: ["EVIDENCED", "#5fd38d"], thin: ["THIN RECORD", "#9fb0bf"], unknown: ["NO RECORD", "#9fb0bf"], reading: ["READING", "#9fb0bf"] };
export function bowCard(r, ref) {
  const W = 600, H = 220;
  const [word, fg] = TONE[r?.standing || "reading"];
  const title = r ? (r.label ? untrusted(r.label, 34) : r.agentId ? `ERC-8004 agent #${r.agentId}` : `Agent ${short(r.address)}`) : `Agent ${/^\d+$/.test(ref) ? `#${ref}` : short(ref)}`;
  const c = r?.counts || {};
  const facts = r ? [["Stamps", r.stamps.length], ["Warnings", r.warnings.length], ["Graded", c.gradedCalls || 0], ["Feedback", c.feedback || 0], ["Paid checks", c.paidChecks || 0], ["Endpoints up", c.endpointsRead ? `${c.endpointsUp}/${c.endpointsRead}` : "–"]] : [];
  const line = r ? (r.warnings[0]?.text || r.stamps.find((s) => !s.key.startsWith("wallet"))?.text || r.summary) : "Troya is reading this agent on Robinhood Chain. Load the card again in a minute.";
  const words = String(line).split(/\s+/); const lines = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 70) { lines.push(cur.trim()); cur = w; if (lines.length === 2) break; } else cur += " " + w; }
  if (lines.length < 2 && cur.trim()) lines.push(cur.trim());
  if (lines.length === 2 && words.join(" ").length > lines.join(" ").length + 1) lines[1] = lines[1].replace(/[\s,.;:]*\S{0,10}$/, "") + "…";
  const pillW = Math.ceil(word.length * 8.2 + 22);
  const when = r?.at ? `read ${stamp(r.at)}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Troya Bow passport for ${xml(title)}: ${xml(word)}">
<title>Troya Bow · ${xml(title)}${when ? ` · ${xml(when)}` : ""}</title>
<rect width="${W}" height="${H}" rx="14" fill="#071014"/><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="rgba(216,247,255,.16)"/>
<path d="M27 17c8 5 11 10 11 15s-3 10-11 15M27 17v30M23 32h21M40 28l4 4-4 4" fill="none" stroke="#5fd3ef" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
<text x="58" y="29" font-family="Menlo,Consolas,monospace" font-size="12" letter-spacing="2" fill="#5fd3ef">TROYA BOW · AGENT PASSPORT</text>
<text x="58" y="47" font-family="Verdana,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="#e8f6fb">${xml(title)}</text>
<rect x="${W - pillW - 22}" y="20" width="${pillW}" height="26" rx="6" fill="rgba(255,255,255,.06)" stroke="${fg}" stroke-opacity=".5"/>
<text x="${W - pillW / 2 - 22}" y="38" text-anchor="middle" font-family="Verdana,Segoe UI,sans-serif" font-size="12" font-weight="700" letter-spacing=".6" fill="${fg}">${word}</text>
${facts.map(([k, v], i) => `<text x="${26 + i * 93}" y="84" font-family="Verdana,Segoe UI,sans-serif" font-size="10" letter-spacing=".5" fill="#6f8593">${xml(k.toUpperCase())}</text><text x="${26 + i * 93}" y="104" font-family="Verdana,Segoe UI,sans-serif" font-size="17" font-weight="700" fill="#e8f6fb">${xml(v)}</text>`).join("\n")}
${lines.map((l, i) => `<text x="26" y="${(r ? 136 : 96) + i * 20}" font-family="Verdana,Segoe UI,sans-serif" font-size="13" fill="#d7e6ec">${xml(l)}</text>`).join("\n")}
<line x1="26" y1="170" x2="${W - 26}" y2="170" stroke="rgba(216,247,255,.10)"/>
<text x="26" y="189" font-family="Verdana,Segoe UI,sans-serif" font-size="11" fill="#8fa3b1">${xml([r ? short(r.address) : "", when].filter(Boolean).join(" · ") || "Robinhood Chain")}</text>
<text x="26" y="206" font-family="Verdana,Segoe UI,sans-serif" font-size="11" fill="#6f8593">What wallets and endpoints did, never who runs them</text>
<text x="${W - 26}" y="206" text-anchor="end" font-family="Menlo,Consolas,monospace" font-size="11" letter-spacing="1" fill="#5fd3ef">troya.codes/bow</text>
</svg>`;
}

/** Is this a genuine Troya Bow or Phaeacians record: the hash re-computed and the signature checked against the attestor. */
export async function verifyRecord(attested, signed) {
  if (!attested || typeof attested !== "object") throw new HttpError(400, "Send { attested, signed } exactly as Bow or Phaeacians returned them.");
  const sig = String(signed?.signature || signed || "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "signed.signature is missing.");
  const hash = keccak256(toUtf8Bytes(JSON.stringify(attested)));
  const label = attested.kind === "troya-bow" ? LABEL : "Troya Phaeacians";
  let signer = null; try { signer = verifyMessage(`${label}\n${hash}`, sig); } catch {}
  const attestor = await (await import("./gateapi.mjs")).attestorAddress();
  return { genuine: lc(signer) === lc(attestor), label, hash, hashMatches: !signed?.hash || lc(signed.hash) === lc(hash), signer, attestor, ageSeconds: attested.at ? Math.round((Date.now() - attested.at) / 1000) : null };
}

export async function register(r, ctx) {
  store = ctx.store;
  // the card first: /api/bow/:address would also match "<address>.svg"
  r.get("/api/bow/:id.svg", async ({ params, res }) => {
    const ref = String(params.id || "");
    const ok = /^0x[0-9a-fA-F]{40}$/.test(ref) || /^\d{1,30}$/.test(ref);
    let data = null;
    if (ok) data = await withTimeout(bowPassport(/^\d+$/.test(ref) ? { agentId: ref } : { address: ref }).catch(() => null), 9000);
    res.writeHead(ok ? 200 : 400, {
      "content-type": "image/svg+xml; charset=utf-8", "cache-control": data && !data.partial ? "public, max-age=300" : "public, max-age=30",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "access-control-allow-origin": "*",
    });
    res.end(bowCard(data, ok ? ref : "?"));
  }, { weight: 1, perMin: 120 });
  r.get("/api/bow", async ({ query }) => {
    if (query.agentId) return bowPassport({ agentId: query.agentId, address: query.address || null });
    const b = await store.readJson(FILE, {}).catch(() => ({}));
    return {
      name: "Troya Bow", what: "A passport for an AI agent built from evidence, not claims: ERC-8004 identity and feedback, calls graded in public, paid jobs, Seal receipts, launches, farm-like reviewers and endpoint health, each stamp with its proof, signed by the Troya attestor.",
      how: "GET /api/bow/<wallet address> or /api/bow?agentId=<ERC-8004 id>; a card at /api/bow/<address or id>.svg",
      examples: await examples(), stats: b.stats || { passports: 0 },
      limit: "It describes what wallets and endpoints did, never who runs them. ERC-8004 registries can be Sybil-farmed.",
    };
  }, { weight: 1 });
  r.post("/api/bow/verify", ({ body }) => verifyRecord(body?.attested, body?.signed ?? body?.signature), { weight: 1, perMin: 60 });
  r.get("/api/bow/:address", ({ params, query }) => bowPassport({ address: params.address, agentId: query.agentId }), { weight: 3, perMin: 30 });
}
