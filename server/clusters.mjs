// Cluster map (community request, 24 Nov 2026: "a map cluster section on all coins we gate, I feel it is a necessary
// security feature"): a coin's biggest holders as bubbles, and which of them are linked, each link with its proof.
// Nothing new is measured here. It joins what the other modules already read, through their caches:
//   holders     Blockscout PRO (market.mjs's shared, rate-limited client): the 50 largest holders and the supply; when
//               Blockscout is paused, The Assay's own ledger (its 10 largest wallets and 6 largest contracts)
//   contracts   eth_getCode on every holder (devlinks.mjs's code cache; an EIP-7702 account is a wallet), names from
//               Blockscout and Troya's own list (PoolManager, PonsV2LaunchLocker, TroyaStake, burn). A contract is never a
//               member of a cluster: pools, lockers, staking and burn addresses hold coins for many people
//   dev side    devlinks.mjs (V8 dev side wallets): wallets tied to the dev through coins or ETH that moved between them,
//               the launch's snipe-tax exemptions, a small shared funder, trades through one private contract; its loose
//               clusters (not tied to the dev); and its wallet-to-wallet transfers (0.01% of the supply or more)
//   funders     the first ETH of every holder wallet (devlinks firstFunder: Blockscout, and The Assay's archive reads in
//               assay-funders.json), grouped by funder. A busy funder (an exchange, bridge or bot app: over 3,000
//               transactions) links nobody
//   launch      Ring Radar (ringradar.mjs): bundle buys in the first seconds (one transaction delivering coins to several
//               wallets) and the wallets the dev freed from the snipe tax, for a Pons coin launched in the last ~2 days
//   The Assay   (assay.mjs) for coverage: whether the coin's history was read in full, and the holder fallback
// Every link carries evidence (a transaction, or the funder's address) and a confidence. Grouping wallets is
// probabilistic: a link is behaviour read from the chain, never an identity. Read-only: nothing here trades.
//   GET /api/clusters/:token  → { token, symbol, supply, holders:[{address, pct, label, name, cluster, why}], clusters:[{id,
//                               wallets, pct, reason, confidence, evidence:{type,ref,url}}], links, summary, notes, coverage,
//                               partial, checkedAt } · cached 5 min (30 s while a source is still reading)
import { getAddress, isAddress } from "ethers";
import { rpc, ADDR, tokenMeta, ponsState } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const TOP = 50;
const WAIT_MS = Math.max(4000, Number(process.env.CLUSTERS_WAIT_MS) || 25_000);
const TTL_DONE = 5 * 60_000, TTL_PARTIAL = 30_000;
const HUB_TXS = 3000, SMALL_TXS = 300, DAY_MS = 86_400_000;   // the same lines devlinks.mjs draws for funders
const RING_BLOCKS = 1_800_000;                                 // Ring Radar reads launches up to about 2 days back (heel.mjs)
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const r2 = (x) => Math.round(x * 100) / 100;
const pctOf = (v, s) => (s > 0n ? Number((BigInt(v) * 1_000_000n) / s) / 10_000 : 0);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;

// contracts Troya knows by address. label: pool | locker | staking | burn | contract (never a person)
const STAKE = lc(process.env.STAKE_CONTRACT || "0x1C867c13BD950a90aB75158C1C45061837aa02d2");
const KNOWN = {
  [lc(ADDR.poolManager)]: ["pool", "Uniswap v4 PoolManager"], [lc(ADDR.universalRouter)]: ["contract", "Uniswap router"], [lc(ADDR.swapRouter02)]: ["contract", "Uniswap router"],
  [lc(ADDR.permit2)]: ["contract", "Permit2"], [lc(ADDR.ponsFactory)]: ["contract", "Pons factory"], [lc(ADDR.ponsHook)]: ["contract", "Pons hook"],
  "0x267444d099b10fb5ed7c3cc7b7c767adca574952": ["locker", "PonsV2LaunchLocker"], "0xe33e9e479df8802cb0866d5d05258bec4cf62948": ["contract", "PonsV2LaunchAndBuy"],
  "0x204faca1764b154221e35c0d20abb3c525710498": ["contract", "Uniswap router"], "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": ["contract", "KyberSwap router"],
  "0x73991a25c818bf1f1128deaab1492d45638de0d3": ["contract", "Uniswap v3 positions"], "0x58daec3116aae6d93017baaea7749052e8a04fa7": ["contract", "Uniswap v4 positions"],
  [STAKE]: ["staking", "TroyaStake"], [ZERO]: ["burn", "zero address (burned)"], [DEAD]: ["burn", "dead address (burned)"],
};
const CONTRACT_LABELS = new Set(["pool", "locker", "staking", "burn", "contract"]);
const byName = (n) => (/lock/i.test(n) ? "locker" : /stak/i.test(n) ? "staking" : /pool|pair|curve|poolmanager|amm/i.test(n) ? "pool" : /burn|dead/i.test(n) ? "burn" : "contract");

// what links two wallets, in words, and how much it says
const REASON = { dev: "dev side", funder: "shared funder", transfer: "transfers between them", sender: "coins from one wallet", receiver: "coins sent to one wallet",
  bundle: "same-block buys", sameblock: "same-block buys", router: "same private contract" };
const CONF = { high: 3, medium: 2, low: 1 };
const ev = (type, ref, note) => {
  if (!ref) return null;
  const url = type === "tx" ? `${EXPLORER}/tx/${ref}` : type === "block" ? `${EXPLORER}/block/${ref}` : `${EXPLORER}/address/${ref}`;
  return { type, ref: type === "address" ? getAddress(ref) : String(ref), url, ...(note ? { note } : {}) };
};
const evOf = (e, note) => (e?.type && e.ref ? ev(e.type === "block" ? "block" : e.type === "tx" ? "tx" : "address", e.ref, note) : null);

/* ---------- sources: each one timed, its outcome kept in coverage (as heel.mjs does) ---------- */
async function source(cov, name, fn, { wait = WAIT_MS, running = () => false, na = () => null } = {}) {
  const t0 = Date.now();
  const r = await Promise.race([Promise.resolve().then(fn).then((v) => ({ v }), (e) => ({ e })), sleep(wait).then(() => ({ timeout: true }))]);
  const ms = Date.now() - t0;
  if (r.timeout) { cov.push({ source: name, status: "running", note: "still reading; it goes on in the background, ask again shortly", ms }); return null; }
  if (r.e) { cov.push({ source: name, status: "failed", note: String(r.e.message || r.e).slice(0, 160), ms }); return null; }
  if (running(r.v)) { cov.push({ source: name, status: "running", note: "still reading; ask again shortly", ms }); return null; }
  const why = na(r.v);
  cov.push({ source: name, status: why ? "n/a" : "done", ...(why ? { note: why } : {}), ms });
  return why ? null : r.v;
}

/* ---------- holders ---------- */
async function holdersFromBlockscout(t) {
  const m = await import("./market.mjs");
  if (!m.hasBlockscout()) throw new Error("Blockscout is paused or not set up");
  const [tok, list] = await Promise.all([m.blockscoutApi(`/tokens/${t}`), m.blockscoutApi(`/tokens/${t}/holders`)]);
  const supply = BigInt(tok?.total_supply || 0);
  if (supply <= 0n) throw new Error("no supply from Blockscout");
  const rows = (list?.items || []).slice(0, TOP).map((x) => {
    const a = x.address || {};
    const tag = a.metadata?.tags?.find((g) => g.tagType === "name")?.name;
    return { address: lc(a.hash), raw: BigInt(x.value || 0), bsContract: !!a.is_contract, bsName: a.name || tag || null };
  }).filter((x) => isAddress(x.address) && x.raw > 0n);
  return { supply, decimals: Number(tok?.decimals || 18), count: tok?.holders_count != null ? Number(tok.holders_count) : null, rows, src: "Blockscout" };
}
// Blockscout paused: The Assay's ledger (its 10 largest wallets and 6 largest contracts), said as such
function holdersFromAssay(d, meta) {
  const supply = BigInt(meta?.totalSupply || 0);
  if (!d || d.status !== "done" || supply <= 0n) return null;
  const toRaw = (p) => (BigInt(Math.round(p * 10_000)) * supply) / 1_000_000n;
  const rows = [...(d.holders?.top || []), ...(d.holders?.contracts || [])].map((x) => ({ address: lc(x.wallet), raw: toRaw(x.pct || 0), bsContract: !!x.label, bsName: x.label || null }))
    .sort((a, b) => (b.raw > a.raw ? 1 : -1));
  return { supply, decimals: meta.decimals, count: d.holders?.count ?? null, rows, src: "The Assay" };
}

/* ---------- the map ---------- */
async function compute(address) {
  const A = getAddress(address), t = lc(A);
  const code = await rpc("robinhood", "eth_getCode", [A, "latest"], { timeoutMs: 12_000 }).catch((e) => { throw Object.assign(new HttpError(502, `Robinhood Chain could not be read just now (${e.message}). Ask again in a minute.`), { expose: true }); });
  if (!code || code === "0x" || /^0xef0100/i.test(code)) throw new HttpError(400, "That address is a wallet, not a coin. Paste a coin's contract address.");
  const meta = await tokenMeta(A).catch(() => null);
  if (!meta) throw new HttpError(404, "That contract does not look like a token on Robinhood Chain.");
  const ps = await ponsState(A).catch(() => null);
  const dl = await import("./devlinks.mjs");
  const cov = [], notes = [];

  // the deployer's launches: the launch transaction (evidence for the dev's own wallets) and where Ring Radar looks
  const dt = await import("./devtrack.mjs");
  const launchP = ps?.deployer ? dt.launchesOf(lc(ps.deployer)).then((ls) => ls.find((l) => l.token === t) || null) : Promise.resolve(null);
  launchP.catch(() => {});

  // first funders of every holder wallet start as soon as the holder list is in, beside the other reads
  const t0 = Date.now(), fund = new Map(), fundFor = new Set();
  const startFunders = async (rows) => {
    const as = rows.map((x) => x.address).filter((a) => !KNOWN[a]);
    await dl._codeOf(as).catch(() => {});
    const ws = as.filter((a) => dl._codes.get(a) === false);
    for (const w of ws) fundFor.add(w);
    for (let i = 0; i < ws.length; i += 4) await Promise.all(ws.slice(i, i + 4).map(async (w) => { const r = await dl.firstFunder(w).catch(() => null); if (r) fund.set(w, r); }));
  };
  const holdersP = holdersFromBlockscout(t);
  let fundRun = holdersP.then((H) => startFunders(H.rows), () => null);
  const [bsHolders, side, assay, ring] = await Promise.all([
    source(cov, "Holders (Blockscout)", () => holdersP, { wait: 15_000 }),
    source(cov, "Dev side wallets", () => dl.devLinks(A, { deep: true, waitMs: WAIT_MS }), { wait: WAIT_MS + 2000, running: (v) => v?.status === "running", na: (v) => (v?.status === "unknown" ? v.reason || "not measured" : null) }),
    source(cov, "The Assay", () => import("./assay.mjs").then((m) => m.assay(A, { deep: true, waitMs: WAIT_MS })), { wait: WAIT_MS + 2000, running: (v) => v?.status === "running", na: (v) => (v?.status === "error" ? `could not run: ${v.error}` : null) }),
    ps ? source(cov, "Ring Radar", async () => {
      const me = await launchP.catch(() => null);
      if (me) {
        const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
        if (head - me.block > RING_BLOCKS) return { verdict: "unknown", reasons: [`launched ${((head - me.block) / dt.BLOCKS.DAY).toFixed(1)} days ago: Ring Radar reads launches up to about 2 days back`] };
      }
      return (await import("./ringradar.mjs")).ringCheck(A, me?.tx ? { tx: me.tx, block: me.block } : null);
    }, { na: (v) => (v?.verdict === "unknown" ? String(v.reasons?.[0] || "nothing to read").replace(/\.$/, "") : null) }) : (cov.push({ source: "Ring Radar", status: "n/a", note: "not a Pons launch" }), null),
  ]);

  if (side?.stale) { const c = cov.find((x) => x.source === "Dev side wallets"); if (c) { c.status = "running"; c.note = "an earlier read is shown while a fresh one runs"; } }
  const H = bsHolders || holdersFromAssay(assay, meta);
  if (!H) {
    return { token: A, symbol: meta.symbol, name: meta.name, status: "unavailable", holders: [], clusters: [], links: [], coverage: cov, partial: cov.some((c) => c.status === "running"),
      summary: "The holder list could not be read just now (Blockscout and The Assay gave no answer). Ask again in a minute.", notes, checkedAt: Date.now(), note: NOTE };
  }
  if (!bsHolders) notes.push(`Holders come from The Assay's own ledger (Blockscout did not answer): only its ${H.rows.length} largest holders are shown`);
  const supply = H.supply;

  /* nodes: every holder, labelled. Contracts are read from the chain (an EIP-7702 account is a wallet) */
  await dl._codeOf(H.rows.map((x) => x.address)).catch(() => {});
  const devs = new Set([...(side?.dev || []).map((d) => lc(d.wallet)), ...(ps ? [lc(ps.deployer), lc(ps.creatorFeeRecipient)] : [])].filter((a) => a && a !== ZERO));
  await dl._codeOf([...devs]).catch(() => {});
  const isCode = (a) => (dl._codes.has(a) ? dl._codes.get(a) === true : null);
  const curve = ps?.curve ? lc(ps.curve) : null;
  const nodes = new Map();
  for (const [i, x] of H.rows.entries()) {
    const known = KNOWN[x.address];
    const code = isCode(x.address);
    let label, name = known?.[1] || x.bsName || null;
    if (known) label = known[0];
    else if (x.address === curve) { label = "pool"; name = "Pons curve"; }
    else if (code === true || (code == null && x.bsContract)) label = name ? byName(name) : "contract";
    else label = devs.has(x.address) ? "dev" : "wallet";
    nodes.set(x.address, { address: x.address, raw: x.raw, pct: pctOf(x.raw, supply), label, name, rank: i + 1, why: [] });
  }
  // a contract with no name that answers token0() is a pool
  await Promise.all([...nodes.values()].filter((n) => n.label === "contract" && !n.name).slice(0, 12).map(async (n) => {
    const r = await rpc("robinhood", "eth_call", [{ to: n.address, data: "0x0dfe1681" }, "latest"], { timeoutMs: 8000 }).catch(() => null);
    if (r && r !== "0x" && r.length >= 66) { n.label = "pool"; n.name = "pool"; }
  }));
  const wallet = (a) => { const n = nodes.get(a); return !!n && !CONTRACT_LABELS.has(n.label); };
  const devWallets = [...devs].filter((a) => isCode(a) === false);

  /* links: each one names what connects two wallets on the map, with its proof */
  const links = [], seen = new Set();
  const addLink = (a, b, kind, why, confidence, evidence) => {
    if (!a || !b || a === b || !wallet(a) || !wallet(b) || !evidence) return;
    const k = [a, b].sort().join("|") + "|" + kind;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ from: a, to: b, kind, why, confidence, evidence });
  };
  // the dev node: a dev wallet on the map, or the dev added beside it when wallets on the map are tied to it
  let devNode = devWallets.find((a) => nodes.has(a)) || null;
  const ensureDev = () => {
    if (devNode || !devWallets.length) return devNode;
    const d = devWallets[0];
    const p = (side?.dev || []).find((x) => lc(x.wallet) === d)?.holdsPct ?? 0;
    nodes.set(d, { address: d, raw: null, pct: p, label: "dev", name: null, rank: null, extra: true, why: [] });
    devNode = d;
    return d;
  };
  const launchTx = await launchP.catch(() => null).then((l) => l?.tx || ring?.launch?.tx || null);
  // the dev's own wallets (the Pons deployer and its fee recipient) belong together: both are named in the launch
  if (devWallets.length > 1) for (const d of devWallets.slice(1)) if (nodes.has(d) && nodes.has(devWallets[0])) addLink(devWallets[0], d, "dev", "the deployer and the fee recipient named in the Pons launch", "high", ev("tx", launchTx, "the launch transaction"));

  // 1 · dev side wallets (devlinks.mjs)
  for (const w of side?.wallets || []) {
    const a = lc(w.wallet);
    if (!wallet(a)) continue;
    const i = (w.evidence || []).findIndex(Boolean);
    const e = i >= 0 ? evOf(w.evidence[i], w.why[i]) : null;
    if (!e) continue;
    const strong = /snipe tax|first buy|of the supply from the dev|sent coins to the dev/.test(w.why[i] || "");
    const conf = w.hop <= 1 ? (strong ? "high" : "medium") : w.hop === 2 ? "medium" : "low";
    const d = ensureDev();
    if (d) addLink(d, a, "dev", w.why[i], conf, e);
  }
  // Ring Radar: wallets the dev freed from the snipe tax in the launch itself
  for (const w of ring?.exemptions?.wallets || []) {
    const a = lc(w);
    if (!wallet(a) || devs.has(a)) continue;
    const d = ensureDev();
    if (d) addLink(d, a, "dev", "freed from the snipe tax by the dev in the launch (Ring Radar)", "high", ev("tx", ring.launch?.tx, "the launch transaction: its exemption list"));
  }
  // 2 · devlinks' clusters not tied to the dev (a small shared funder, coins gathered into one wallet, one private contract)
  const KIND = { funded: "funder", gathered: "receiver", "one router": "router", "bought together": "sameblock", "sold together": "sameblock" };
  for (const c of side?.clusters || []) {
    const on = (c.members || []).map(lc).filter(wallet);
    if (on.length < 2) continue;
    const kind = KIND[c.kind] || "router";
    const conf = kind === "sameblock" && /one transaction/.test(c.why) ? "high" : "medium";
    for (const a of on.slice(1)) addLink(on[0], a, kind, c.why, conf, evOf(c.memberEvidence?.[getAddress(a)] || c.evidence, c.why));
  }
  // 3 · coins moved between wallets (devlinks' transfer ledger, 0.01% of the supply or more)
  const edges = side?._set?.edges || [];
  if (side && !side._set) notes.push("The dev side read came from an older cache without its transfer list: transfers between holders were not read this time");
  const pair = new Map(), fromX = new Map(), toX = new Map();
  for (const x of edges) {
    const fw = wallet(x.from), tw = wallet(x.to);
    if (fw && tw) { const k = [x.from, x.to].sort().join("|"); const p = pair.get(k) || { a: x.from, b: x.to, v: 0n, n: 0, tx: x.tx }; p.v += x.v; p.n++; pair.set(k, p); }
    else if (tw && !nodes.has(x.from) && x.from !== ZERO && x.from !== DEAD) { if (!fromX.has(x.from)) fromX.set(x.from, new Map()); const m = fromX.get(x.from); if (!m.has(x.to)) m.set(x.to, x.tx); }
    else if (fw && !nodes.has(x.to) && x.to !== ZERO && x.to !== DEAD) { if (!toX.has(x.to)) toX.set(x.to, new Map()); const m = toX.get(x.to); if (!m.has(x.from)) m.set(x.from, x.tx); }
  }
  for (const p of pair.values()) addLink(p.a, p.b, "transfer", `moved ${r2(pctOf(p.v, supply))}% of the supply between them${p.n > 1 ? ` in ${p.n} transfers` : ""}`, pctOf(p.v, supply) >= 0.1 ? "high" : "medium", ev("tx", p.tx, "a transfer between the two wallets"));
  // a wallet off the map that handed coins to (or collected coins from) two or more holders: only a person-sized wallet counts
  const hubs = [...[...fromX].filter(([, m]) => m.size >= 2).map(([x, m]) => ["sender", x, m]), ...[...toX].filter(([, m]) => m.size >= 2).map(([x, m]) => ["receiver", x, m])]
    .sort((a, b) => b[2].size - a[2].size).slice(0, 12);
  await dl._codeOf(hubs.map((h) => h[1])).catch(() => {});
  let hubsSkipped = 0;
  for (const [kind, x, m] of hubs) {
    if (isCode(x) !== false) { hubsSkipped++; continue; }
    const inf = await dl.infoOf(x).catch(() => null);
    if (!inf || inf.txs == null || inf.txs > HUB_TXS || inf.contract) { hubsSkipped++; continue; }
    const on = [...m.keys()];
    const why = kind === "sender" ? `got coins from the same wallet ${short(x)} (not on the map)` : `sent coins to the same wallet ${short(x)} (not on the map)`;
    for (const a of on.slice(1)) addLink(on[0], a, kind, why, "medium", ev("tx", m.get(a), `the transfer ${kind === "sender" ? "from" : "to"} ${short(x)}`));
  }
  if (hubsSkipped) notes.push(`${plural(hubsSkipped, "wallet")} that moved coins with several holders ${hubsSkipped === 1 ? "was" : "were"} left out: a contract or a busy wallet (an exchange or an app) links nobody`);

  // 4 · first funders of every wallet on the map (Blockscout, and The Assay's archive reads)
  if (!bsHolders) fundRun = startFunders(H.rows);
  fundRun.catch(() => {});
  const fundDone = await Promise.race([fundRun.then(() => true, () => true), sleep(Math.max(3000, WAIT_MS + 6000 - (Date.now() - t0))).then(() => false)]);
  const ws = [...fundFor].filter(wallet);
  cov.push({ source: "First funders", status: fundDone ? "done" : "running", note: `${ws.filter((w) => fund.has(w)).length} of ${ws.length} wallets read${fundDone ? "" : "; the rest go on in the background"}` });
  const groups = new Map();
  for (const [w, r] of fund) {
    if (!wallet(w)) continue;
    const k = r.funder || (r.viaFrom && r.viaFrom !== w ? r.viaFrom : null);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ w, r });
  }
  let busyFunders = 0;
  for (const [k, ms] of groups) {
    const toDev = devs.has(k), onMap = wallet(k);
    if (ms.length < 2 && !toDev && !onMap) continue;
    if (toDev) { const d = ensureDev(); for (const m of ms) if (d) addLink(d, m.w, "dev", "its first ETH came from the dev", "high", ev("tx", m.r.tx, "its first ETH") || ev("address", k)); continue; }
    if (onMap) { for (const m of ms) addLink(k, m.w, "funder", `its first ETH came from ${short(k)}, also on the map`, "high", ev("tx", m.r.tx, "its first ETH") || ev("address", k)); continue; }
    const inf = await dl.infoOf(k).catch(() => null);
    if (!inf || inf.contract || inf.txs == null || inf.txs > HUB_TXS) { busyFunders++; continue; }
    const ats = ms.map((m) => m.r.at).filter(Boolean).sort((a, b) => a - b);
    if (inf.txs > SMALL_TXS && !(ats.length >= 2 && ats.at(-1) - ats[0] <= DAY_MS)) { busyFunders++; continue; }
    const conf = inf.txs <= SMALL_TXS ? "medium" : "low";
    const why = `first ETH from the same wallet ${short(k)} (${inf.txs.toLocaleString("en-US")} transactions)${ms[0].r.how === "contract" ? ", through a contract" : ""}`;
    for (const m of ms.slice(1)) addLink(ms[0].w, m.w, "funder", why, conf, ev("tx", m.r.tx, `its first ETH, from ${short(k)}`) || ev("address", k, "the shared funder"));
  }
  if (busyFunders) notes.push(`${plural(busyFunders, "shared funder")} left out as too busy to link anyone (an exchange, a bridge or a bot app funds thousands of wallets)`);

  // 5 · Ring Radar: one transaction delivering curve coins to several wallets in the first seconds
  if (ring?.bundles?.length && curve) {
    for (const b of ring.bundles.slice(0, 6)) {
      const rc = await rpc("robinhood", "eth_getTransactionReceipt", [b.tx], { timeoutMs: 12_000 }).catch(() => null);
      const got = [...new Set((rc?.logs || []).filter((l) => lc(l.address) === t && l.topics?.[0] === T_TRANSFER && lc("0x" + l.topics[1].slice(26)) === curve).map((l) => lc("0x" + l.topics[2].slice(26))))].filter(wallet);
      for (const a of got.slice(1)) addLink(got[0], a, "bundle", `bought in the same transaction in the first seconds (${b.wallets} wallets in it)`, "high", ev("tx", b.tx, "the bundle buy"));
    }
  }

  /* clusters: wallets joined by links (union-find); contracts never join */
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const n of nodes.values()) if (wallet(n.address)) parent.set(n.address, n.address);
  for (const l of links) { const x = find(l.from), y = find(l.to); if (x !== y) parent.set(x, y); }
  const comps = new Map();
  for (const a of parent.keys()) { const r = find(a); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(a); }
  const best = new Map();   // wallet → its strongest link
  for (const l of links) for (const a of [l.from, l.to]) if (!best.has(a) || CONF[l.confidence] > CONF[best.get(a)]) best.set(a, l.confidence);
  const clusters = [...comps.values()].filter((m) => m.length >= 2).map((m) => {
    const ls = links.filter((l) => m.includes(l.from));
    const kinds = new Map();
    for (const l of ls) kinds.set(l.kind, (kinds.get(l.kind) || 0) + 1);
    const kindList = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (m.includes(devNode)) kindList.sort((a, b) => (a === "dev" ? -1 : b === "dev" ? 1 : 0));
    const conf = m.reduce((c, a) => (CONF[best.get(a) || "low"] < CONF[c] ? best.get(a) || "low" : c), "high");
    const top = [...ls].sort((a, b) => CONF[b.confidence] - CONF[a.confidence])[0];
    const pct = r2(m.reduce((s, a) => s + (nodes.get(a)?.pct || 0), 0));
    return { wallets: m.sort((a, b) => (nodes.get(b)?.pct || 0) - (nodes.get(a)?.pct || 0)), pct, kinds: kindList, confidence: conf, evidence: top.evidence, dev: m.includes(devNode), links: ls.length };
  }).sort((a, b) => b.pct - a.pct);
  clusters.forEach((c, i) => { c.id = `c${i + 1}`; for (const a of c.wallets) nodes.get(a).cluster = c.id; });
  for (const l of links) for (const [a, b] of [[l.from, l.to], [l.to, l.from]]) { const n = nodes.get(a); if (n.why.length < 4) n.why.push({ text: `${l.why} (with ${short(b)})`, confidence: l.confidence, evidence: l.evidence }); }

  /* outside the map: dev-side wallets beyond the top 50 */
  if (side?.linked?.count) {
    const onMap = (side.wallets || []).filter((w) => nodes.has(lc(w.wallet)));
    const off = side.linked.count - onMap.length;
    if (off > 0) notes.push(`${plural(off, "more wallet")} tied to the dev ${off === 1 ? "is" : "are"} not among the holders on the map (Dev side wallets: ${side.linked.count} linked, holding ${side.linked.holdsPct}% in all)`);
  }
  if (assay?.coverage?.partial) notes.push(`The Assay read only the most recent ${(assay.coverage.transfers || 0).toLocaleString("en-US")} transfers of this busy coin`);
  if (side?.coverage?.partial) notes.push(`Dev side wallets read the newest ${(side.coverage.transfers || 0).toLocaleString("en-US")} transfers (and the dev's own in full): older transfers between holders may be missing`);
  if (side?.coverage && !side.coverage.deep) notes.push("Dev side wallets gave its fast read only: funders of the biggest holders were not part of it");

  /* the line above the map */
  const list = [...nodes.values()].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const wallets = list.filter((n) => !n.extra && !CONTRACT_LABELS.has(n.label));
  const top10 = r2(wallets.slice(0, 10).reduce((s, n) => s + n.pct, 0));
  const inContracts = r2(list.filter((n) => CONTRACT_LABELS.has(n.label) && n.label !== "burn").reduce((s, n) => s + n.pct, 0));
  const burned = r2(list.filter((n) => n.label === "burn").reduce((s, n) => s + n.pct, 0));
  const partial = cov.some((c) => c.status === "running");
  const reasonOf = (c) => c.kinds.map((k) => REASON[k]).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2).join(", ");
  const cl = clusters.length, clPct = r2(clusters.reduce((s, c) => s + c.pct, 0));
  const summary = `Top 10 wallets hold ${top10}%; ` +
    (cl ? `${plural(cl, "linked cluster")} hold${cl === 1 ? "s" : ""} ${clPct}% (${cl === 1 ? "" : `largest ${clusters[0].pct}%: `}${reasonOf(clusters[0])}, confidence ${clusters[0].confidence})`
      : `no linked wallets found among the ${H.rows.length} largest holders in what was read`) +
    (inContracts ? `. Contracts (pools, lockers, staking) hold ${inContracts}% and are never grouped` : "") + (partial ? ". Some sources are still reading" : "") + ".";

  const out = (a) => getAddress(a);
  return {
    token: A, symbol: meta.symbol, name: meta.name, decimals: H.decimals, supply: Number(supply) / 10 ** H.decimals, holdersCount: H.count, holdersSource: H.src,
    pons: !!ps, dev: devWallets.map(out),
    summary, top10Pct: top10, contractsPct: inContracts, burnedPct: burned,
    holders: list.map((n) => ({ address: out(n.address), pct: r2(n.pct), label: n.label, name: n.name, rank: n.rank, cluster: n.cluster || null, ...(n.extra ? { extra: true, note: "the dev wallet, shown beside the 50 largest holders" } : {}), why: n.why })),
    clusters: clusters.map((c) => ({ id: c.id, wallets: c.wallets.map(out), count: c.wallets.length, pct: c.pct, dev: c.dev, reason: reasonOf(c), reasons: c.kinds.map((k) => REASON[k]).filter((x, i, a) => a.indexOf(x) === i), confidence: c.confidence, evidence: c.evidence, links: c.links })),
    links: links.map((l) => ({ ...l, from: out(l.from), to: out(l.to), reason: REASON[l.kind] })),
    notes, coverage: cov, partial, checkedAt: Date.now(), note: NOTE,
  };
}
const NOTE = "Behaviour read from Robinhood Chain, not identities. A link means wallets shared a funder, moved coins between them, bought in one transaction or are tied to the dev's wallet; it is probable, never proof that one person controls them. Pools, lockers, staking and burn addresses hold coins for many people and are never grouped. No cluster found is not a safe stamp: wallets kept fully apart stay hidden.";

const memo = new Map(), inflight = new Map();
/** The Cluster map for one coin (cached 5 minutes; 30 seconds while a source is still reading). */
export async function clusterMap(token) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "Paste a coin's contract address (0x + 40 hex).");
  const k = lc(token);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.res;
  if (!inflight.has(k)) inflight.set(k, compute(token).then((res) => {
    memo.set(k, { at: Date.now(), ttl: res.partial || res.status === "unavailable" ? TTL_PARTIAL : TTL_DONE, res });
    if (memo.size > 1000) memo.delete(memo.keys().next().value);
    return res;
  }).finally(() => inflight.delete(k)));
  return inflight.get(k);
}

export async function register(r, ctx) {
  import("./devlinks.mjs").then((m) => m.initDevLinks(ctx.store)).catch(() => {});   // its funder and birth caches
  r.get("/api/clusters/:token", ({ params }) => clusterMap(params.token), { weight: 3, perMin: 30 });
}
