// V10 F69 Argus: Sentinel Network. The community helps watch Robinhood Chain. A signed-in wallet takes a watch on a coin,
// a dev wallet or an agent wallet (up to MAX_WATCH), and raises a flag on something it watches, with on-chain evidence
// (transaction hashes). Troya checks every flag with its own reads for WINDOW and marks it confirmed or not confirmed, with
// the reason; the first confirmed flag on an event earns the sentinel reputation. Everything is in the open.
// Reputation only: no prize pool, no stakes, no points that turn into money.
//   flag kinds and the reads behind them (each module already does the reading; nothing is re-implemented here):
//     dev-moving        the evidence receipts: Transfer logs out of the dev (a Pons coin's deployer and fee recipient from
//                       robinhood.ponsState, its linked wallets from devlinks.devSideOf, or the watched dev wallet itself),
//                       at least 0.1% of the coin's supply; else Heel (heel.mjs) naming a dev sale (devlinks.selling,
//                       coin.dev.out1h / out6h, dev.out6h, assay.dev-sold.red)
//     liquidity-pulled  the evidence receipts: a Uniswap v4 ModifyLiquidity with a negative liquidity delta, a v3 Burn or
//                       DecreaseLiquidity, or a v2 Burn, in a transaction that moves the coin; else Heel's
//                       assay.lp-pulled.red
//     ring-forming      Watchfire (watchfire.mjs: gather, whale exits, sell velocity) at fire or red, Ring Radar
//                       (ringradar.mjs) red, or Heel naming a ring, a bundle, a cluster or dev side wallets selling
//     agent-misbehaving the evidence transactions sent by the agent wallet, each through Trident (trident.mjs: approvals to a
//                       plain wallet, coins sent to a sink, EIP-7702 delegations, coins the Gate fails) at block; or Heel on
//                       the agent (allies.mjs record) at critical or high
// Every flag needs evidence that exists on Robinhood Chain and touches what it flags; evidence that does not is marked not
// confirmed at once, with that reason. Flags describe what wallets did, never who people are.
// Distinct from Myrmidons (warroom.mjs), which takes rug reports: Argus is about watching. Myrmidons' confirmed rug reports
// are shown on the board, read-only from data/warroom.json.
//   GET  /api/argus              the board: watches per coin, sentinels ranked, every flag, Myrmidons' confirmed reports, rules
//                                (signed in: also your watches)
//   POST /api/argus/watch        session: { target, kind: coin|dev|agent, on? }   (on:false stops a watch)
//   POST /api/argus/flag         session: { target, kind, evidence: "0x…tx hashes", note? }
import { getAddress, isAddress, id as topicId } from "ethers";
import { HttpError } from "./api.mjs";
import { requireSession, getSession } from "./auth.mjs";

const FILE = "argus.json";
const H = 3600e3, DAY = 24 * H;
const MAX_WATCH = 10;                 // watches per wallet
const FLAGS_PER_DAY = 10;             // flags per wallet per UTC day
const WINDOW = DAY;                   // a flag is checked for a day, then marked not confirmed
const RECHECK = 20 * 60e3;            // an open flag is read again every 20 minutes
const PER_TICK = 3;                   // flags checked per pass (Heel and Watchfire reads are heavy)
const EVENT_MS = 48 * H;              // flags of one kind on one target within 48 hours are one event
const EVIDENCE_MAX_AGE = 7 * DAY;     // evidence mined more than 7 days before the flag does not count
const MIN_DEV_PCT = 0.1;              // a dev transfer counts from 0.1% of the supply
const KEEP_FLAGS = 5000;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const T = {
  v4Modify: topicId("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  v3Burn: topicId("Burn(address,int24,int24,uint128,uint256,uint256)"),
  v3Decrease: topicId("DecreaseLiquidity(uint256,uint128,uint256,uint256)"),
  v2Burn: topicId("Burn(address,uint256,uint256,address)"),
};
const KINDS = {
  "dev-moving": { label: "Dev moving coins", targets: ["coin", "dev"] },
  "liquidity-pulled": { label: "Liquidity pulled", targets: ["coin"] },
  "ring-forming": { label: "Ring forming", targets: ["coin"] },
  "agent-misbehaving": { label: "Agent misbehaving", targets: ["agent"] },
};
const DEV_KEYS = new Set(["devlinks.selling", "coin.dev.out1h", "coin.dev.out6h", "dev.out6h.many", "dev.out6h", "assay.dev-sold.red"]);
const RING_KEYS = new Set(["ring.red", "watchfire.fire", "watchfire.red", "assay.cluster.red", "assay.bundle.red", "devlinks.selling", "devlinks.fail"]);
const RULES = [
  "Reputation only: no prize pool, no stakes, and no points that turn into money. Holder rewards come from staking and free gas.",
  `Sign in with a wallet and take a watch on a coin, a dev wallet or an agent wallet: up to ${MAX_WATCH} at a time.`,
  "Raise a flag on something you watch: dev moving coins, liquidity pulled, a ring forming, or an agent misbehaving, with the transaction hashes that show it.",
  "Troya checks every flag with its own reads (the evidence receipts, Watchfire, Ring Radar, Heel, Trident) for 24 hours and marks it confirmed or not confirmed, with the reason.",
  "Evidence must exist on Robinhood Chain, be at most 7 days old and touch what it flags; otherwise the flag is not confirmed at once.",
  "The first confirmed flag on an event (one kind, one target, 48 hours) earns the sentinel credit; later confirmed flags count as seconded.",
  `${FLAGS_PER_DAY} flags per wallet a day. Flags describe what wallets did, never who people are.`,
];
let store = null, busy = false;

const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const blank = () => ({ seq: 0, watches: [], flags: [] });
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} did not answer in time`)), ms))]);
const noDot = (s) => String(s || "").trim().replace(/[.\s]+$/, "");
const topicAddr = (t) => "0x" + String(t).slice(26).toLowerCase();
async function rpc(method, params) { const { rpc } = await import("./robinhood.mjs"); return timeout(rpc("robinhood", method, params), 15_000, "Robinhood Chain RPC"); }
async function isContract(a) { const c = await rpc("eth_getCode", [a, "latest"]).catch(() => null); return c == null ? null : c !== "0x" && !String(c).startsWith("0xef0100"); }

/* ---------------- watches ---------------- */
async function tokenOf(a) { const { tokenMeta } = await import("./robinhood.mjs"); return tokenMeta(a).catch(() => null); }

export async function setWatch(walletAddr, body = {}) {
  const wallet = getAddress(walletAddr);
  if (!isAddress(String(body.target || ""))) throw new HttpError(400, "Paste a Robinhood Chain address: a coin, a dev wallet or an agent wallet (0x + 40 hex).");
  const target = getAddress(lc(body.target));
  const kind = ["coin", "dev", "agent"].includes(body.kind) ? body.kind : null;
  if (body.on === false) {
    let removed = false;
    await store.update(FILE, blank(), (d) => { const n = d.watches.length; d.watches = d.watches.filter((w) => !(w.wallet === wallet && w.target === target)); removed = d.watches.length < n; return d; });
    return { ok: true, removed, note: removed ? "Stopped watching." : "You were not watching that address." };
  }
  if (!kind) throw new HttpError(400, "Say what it is: coin, dev or agent.");
  let symbol = null;
  const meta = await tokenOf(target);
  if (kind === "coin") { if (!meta) throw new HttpError(400, "That address is not a token on Robinhood Chain. Watch it as a dev or an agent wallet instead."); symbol = meta.symbol; }
  else if (meta) throw new HttpError(400, `That is a coin ($${meta.symbol}). Watch it as a coin.`);
  let out;
  await store.update(FILE, blank(), (d) => {
    const mine = d.watches.filter((w) => w.wallet === wallet);
    if (mine.some((w) => w.target === target)) { out = { ok: true, already: true, note: "You already watch this address." }; return d; }
    if (mine.length >= MAX_WATCH) throw new HttpError(409, `You watch ${MAX_WATCH} addresses already. Stop watching one first.`);
    d.watches.unshift({ wallet, target, kind, symbol, at: Date.now() });
    out = { ok: true, note: `Watching ${symbol ? `$${symbol}` : short(target)}. Raise a flag when you see something, with the transaction hashes.` };
    return d;
  });
  if (kind === "coin") import("./watchfire.mjs").then((m) => m.watch(target, "ask")).catch(() => {});   // Watchfire reads it for the next 30 minutes
  return out;
}

/* ---------------- flags ---------------- */
export async function raiseFlag(walletAddr, body = {}) {
  const wallet = getAddress(walletAddr);
  if (!isAddress(String(body.target || ""))) throw new HttpError(400, "Flag an address you watch (0x + 40 hex).");
  const target = getAddress(lc(body.target));
  const kind = KINDS[body.kind] ? body.kind : null;
  if (!kind) throw new HttpError(400, `Pick a flag: ${Object.entries(KINDS).map(([k, v]) => `${k} (${v.label.toLowerCase()})`).join(", ")}.`);
  const raw = Array.isArray(body.evidence) ? body.evidence.join(" ") : String(body.evidence || "");
  const evidence = [...new Set((raw.match(/0x[0-9a-fA-F]{64}/g) || []).map(lc))].slice(0, 5);
  if (!evidence.length) throw new HttpError(400, "A flag needs evidence: at least one transaction hash (0x + 64 hex) on Robinhood Chain.");
  const note = clean(body.note, 300) || null;
  const now = Date.now();
  let out;
  await store.update(FILE, blank(), (d) => {
    const w = d.watches.find((x) => x.wallet === wallet && x.target === target);
    if (!w) throw new HttpError(409, "Take a watch on this address first: a sentinel flags what it watches.");
    if (!KINDS[kind].targets.includes(w.kind)) throw new HttpError(400, `"${KINDS[kind].label}" is a flag for ${KINDS[kind].targets.map((t) => (t === "dev" ? "a dev wallet" : t === "agent" ? "an agent wallet" : "a coin")).join(" or ")}; you watch this as ${w.kind === "dev" ? "a dev wallet" : w.kind === "agent" ? "an agent wallet" : "a coin"}.`);
    const mineToday = d.flags.filter((f) => f.wallet === wallet && new Date(f.at).toISOString().slice(0, 10) === today()).length;
    if (mineToday >= FLAGS_PER_DAY) throw new HttpError(429, `${FLAGS_PER_DAY} flags a day per wallet. Come back tomorrow (UTC).`);
    if (d.flags.some((f) => f.wallet === wallet && f.target === target && f.kind === kind && now - f.at < EVENT_MS && f.status !== "not-confirmed")) throw new HttpError(409, "You already flagged this, and it is still open or confirmed.");
    const f = { id: ++d.seq, at: now, wallet, target, targetKind: w.kind, symbol: w.symbol || null, kind, evidence, note, status: "open", reason: null, checks: [], checkedAt: 0, tries: 0 };
    d.flags.unshift(f);
    d.flags = d.flags.slice(0, KEEP_FLAGS);
    out = { ok: true, id: f.id, note: "Flag raised. Troya checks it with its own reads now and for the next 24 hours; it lands on the board as confirmed or not confirmed, with the reason." };
    return d;
  });
  setTimeout(() => checkById(out.id).catch((e) => console.warn("[argus] first check", e.message)), 500).unref?.();
  return out;
}

/* ---------------- Troya's own reads ---------------- */
async function evidenceRead(f) {
  const rows = [];
  for (const hash of f.evidence) {
    const [rc, tx] = await Promise.all([rpc("eth_getTransactionReceipt", [hash]).catch(() => null), rpc("eth_getTransactionByHash", [hash]).catch(() => null)]);
    if (!rc || !tx) { rows.push({ hash, found: false }); continue; }
    const blk = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]).catch(() => null);
    const minedAt = blk?.timestamp ? Number(BigInt(blk.timestamp)) * 1000 : null;
    const t = lc(f.target);
    const touches = lc(tx.from) === t || lc(tx.to) === t || (rc.logs || []).some((g) => lc(g.address) === t || (g.topics || []).slice(1).some((x) => topicAddr(x) === t));
    rows.push({ hash, found: true, ok: rc.status === "0x1", minedAt, from: lc(tx.from), to: lc(tx.to), value: tx.value, input: tx.input, authorizationList: tx.authorizationList || null, logs: rc.logs || [], touches,
      tooOld: minedAt != null && minedAt < f.at - EVIDENCE_MAX_AGE });
  }
  return rows;
}
const evLink = (hash) => `${EXPLORER}/tx/${hash}`;
const pctOf = (raw, supply) => (supply > 0n ? Number((raw * 1_000_000n) / supply) / 10_000 : null);

async function devsOf(f) {
  if (f.targetKind === "dev") return { set: new Set([lc(f.target)]), names: new Map([[lc(f.target), "the watched dev wallet"]]) };
  const set = new Set(), names = new Map();
  try {
    const { ponsState } = await import("./robinhood.mjs");
    const ps = await ponsState(f.target);
    if (ps?.deployer) { set.add(lc(ps.deployer)); names.set(lc(ps.deployer), "the deployer"); }
    if (ps?.creatorFeeRecipient) { set.add(lc(ps.creatorFeeRecipient)); if (!names.has(lc(ps.creatorFeeRecipient))) names.set(lc(ps.creatorFeeRecipient), "the creator fee recipient"); }
  } catch {}
  try {
    const side = (await import("./devlinks.mjs")).devSideOf(f.target);
    for (const w of side?.linked || []) { const a = lc(typeof w === "string" ? w : w?.wallet || w?.address); if (isAddress(a) && !set.has(a)) { set.add(a); names.set(a, "a wallet tied to the dev"); } }
  } catch {}
  return { set, names };
}

async function heelOf(address) {
  try { const { heel } = await import("./heel.mjs"); return await timeout(heel(address), 60_000, "Heel"); } catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

/** One flag through Troya's own reads → { result: confirmed | not-confirmed | wait, reason, checks } */
export async function checkFlag(f) {
  const checks = [];
  const add = (source, status, text, ref) => checks.push({ source, status, text, ...(ref ? { ref } : {}) });
  const ev = await evidenceRead(f);
  const found = ev.filter((e) => e.found);
  const usable = found.filter((e) => e.ok && e.touches && !e.tooOld);
  for (const e of ev) {
    if (!e.found) add("Evidence", "miss", `${short(e.hash)} is not on Robinhood Chain.`, e.hash);
    else if (!e.ok) add("Evidence", "miss", `${short(e.hash)} reverted on chain: it moved nothing.`, e.hash);
    else if (e.tooOld) add("Evidence", "miss", `${short(e.hash)} was mined more than 7 days before the flag.`, e.hash);
    else if (!e.touches) add("Evidence", "miss", `${short(e.hash)} does not touch ${short(f.target)}.`, e.hash);
    else add("Evidence", "ok", `${short(e.hash)} is on chain and touches ${short(f.target)}.`, e.hash);
  }
  if (!usable.length) {
    // a hash that is not found may simply be very fresh: give it an hour, then decide
    if (!found.length && Date.now() - f.at < H) return { result: "wait", reason: "The evidence transactions are not on Robinhood Chain yet; Troya reads them again shortly.", checks };
    return { result: "not-confirmed", reason: found.length ? "None of the evidence transactions is a successful, recent transaction that touches what was flagged." : "None of the evidence transactions exists on Robinhood Chain.", checks };
  }
  const tokenAddr = f.targetKind === "coin" ? lc(f.target) : null;
  const meta = tokenAddr ? await tokenOf(f.target) : null;
  const supply = meta?.totalSupply ? BigInt(meta.totalSupply) : 0n;
  const sym = meta?.symbol ? `$${meta.symbol}` : "the coin";

  if (f.kind === "dev-moving") {
    const { set, names } = await devsOf(f);
    if (!set.size) add("Dev wallets", "n/a", "Troya could not tell who the dev is (not a Pons launch, and no dev wallet watched).");
    for (const e of usable) for (const g of e.logs) {
      if (g.topics?.[0] !== T_TRANSFER || g.topics.length < 3) continue;
      if (tokenAddr && lc(g.address) !== tokenAddr) continue;
      const from = topicAddr(g.topics[1]);
      if (!set.has(from)) continue;
      const raw = BigInt(g.data && g.data !== "0x" ? g.data : 0);
      const tm = tokenAddr ? meta : await tokenOf(g.address);
      const sup = tokenAddr ? supply : tm?.totalSupply ? BigInt(tm.totalSupply) : 0n;
      const p = pctOf(raw, sup);
      if (p == null || p < MIN_DEV_PCT) continue;
      const to = topicAddr(g.topics[2]);
      if (to === ZERO || to === DEAD) { add("Receipt", "none", `${short(e.hash)} burns ${p}% of the supply from ${short(from)}: a burn is not counted as the dev moving coins.`, e.hash); continue; }
      const text = `${short(e.hash)} moves ${p}% of ${tm?.symbol ? `$${tm.symbol}` : "a coin"}'s supply out of ${names.get(from) || "a dev wallet"} ${short(from)} to ${short(to)}.`;
      add("Receipt", "hit", text, e.hash);
      return { result: "confirmed", reason: `Transfer logs: ${text}`, checks };
    }
    add("Receipt", "none", `No transfer of ${MIN_DEV_PCT}% of the supply or more out of a dev wallet in the evidence.`);
    const hz = await heelOf(f.target);
    const hit = (hz.facts || []).find((x) => DEV_KEYS.has(x.key));
    if (hit) { add("Heel", "hit", hit.text, hit.evidence?.ref); return { result: "confirmed", reason: `Heel: ${hit.text}`, checks }; }
    add("Heel", hz.error ? "failed" : "none", hz.error ? `Heel could not read it: ${hz.error}` : "Heel names no dev sale on it right now.");
    return { result: "wait", reason: "Troya's reads do not show the dev moving coins yet.", checks };
  }

  if (f.kind === "liquidity-pulled") {
    for (const e of usable) {
      const movesCoin = e.logs.some((g) => lc(g.address) === tokenAddr && g.topics?.[0] === T_TRANSFER);
      if (!movesCoin) continue;
      for (const g of e.logs) {
        const t0 = g.topics?.[0];
        let what = null;
        if (t0 === T.v4Modify) { const d = String(g.data || "").replace(/^0x/, ""); const delta = d.length >= 192 ? BigInt.asIntN(256, BigInt("0x" + d.slice(128, 192))) : 0n; if (delta < 0n) what = "Uniswap v4 ModifyLiquidity with a negative liquidity delta (liquidity taken out)"; }
        else if (t0 === T.v3Burn) what = "a Uniswap v3 pool Burn (liquidity taken out)";
        else if (t0 === T.v3Decrease) what = "a Uniswap v3 position DecreaseLiquidity";
        else if (t0 === T.v2Burn) what = "a v2 pool Burn (LP tokens redeemed)";
        if (!what) continue;
        const text = `${short(e.hash)} contains ${what} and moves ${sym} in the same transaction.`;
        add("Receipt", "hit", text, e.hash);
        return { result: "confirmed", reason: `Receipt logs: ${text}`, checks };
      }
    }
    add("Receipt", "none", "No liquidity removal that moves this coin in the evidence.");
    const hz = await heelOf(f.target);
    const hit = (hz.facts || []).find((x) => x.key === "assay.lp-pulled.red");
    if (hit) { add("Heel", "hit", hit.text, hit.evidence?.ref); return { result: "confirmed", reason: `Heel: ${hit.text}`, checks }; }
    add("Heel", hz.error ? "failed" : "none", hz.error ? `Heel could not read it: ${hz.error}` : "Heel names no pulled liquidity on it right now.");
    return { result: "wait", reason: "Troya's reads do not show liquidity pulled yet.", checks };
  }

  if (f.kind === "ring-forming") {
    try {
      const wf = await import("./watchfire.mjs");
      const st = wf.watch(f.target, "ask");
      if (st?.loading) await Promise.race([st.loading, new Promise((r) => setTimeout(r, 20_000))]);
      const s = wf.watchfireState(f.target);
      // a ring is the gather pattern: at least 5 wallets sending the coin to one wallet within 5 s (Watchfire tags them
      // "ring"); a whale sale or fast selling (red) is a different signal and is noted, not counted as a ring
      const ringWallets = wf.board(f.target)?.counts?.ring || 0;
      if (s?.level === "fire" && s.lastFire?.kind === "gather") { const text = `Watchfire fired on a gather: ${noDot(s.lastFire.detail)}`; add("Watchfire", "hit", text); return { result: "confirmed", reason: text, checks }; }
      if (ringWallets >= 5) { const text = `Watchfire tagged ${ringWallets} wallets as a ring: they sent the coin to one wallet within 5 seconds`; add("Watchfire", "hit", text); return { result: "confirmed", reason: text, checks }; }
      add("Watchfire", s ? "none" : "running", s ? `Watchfire reads ${s.level}${s.why?.length ? `: ${noDot(s.why[0])}` : ""}${s.level !== "clear" ? " (not a gather, so not counted as a ring)" : ""}.` : "Watchfire is still reading this coin's transfers.");
    } catch (e) { add("Watchfire", "failed", String(e.message || e).slice(0, 160)); }
    try {
      const { ringCheck } = await import("./ringradar.mjs");
      const r = await timeout(ringCheck(f.target), 45_000, "Ring Radar");
      if (r.verdict === "red") { const text = `Ring Radar reads its launch as rigged: ${(r.reasons || []).slice(0, 2).join("; ")}`; add("Ring Radar", "hit", text, r.launch?.tx); return { result: "confirmed", reason: text, checks }; }
      add("Ring Radar", r.verdict === "unknown" ? "n/a" : "none", `Ring Radar: ${r.verdict}${r.reasons?.[0] ? `, ${noDot(r.reasons[0])}` : ""}.`);
    } catch (e) { add("Ring Radar", "failed", String(e.message || e).slice(0, 160)); }
    const hz = await heelOf(f.target);
    const hit = (hz.facts || []).find((x) => RING_KEYS.has(x.key));
    if (hit) { add("Heel", "hit", hit.text, hit.evidence?.ref); return { result: "confirmed", reason: `Heel: ${hit.text}`, checks }; }
    add("Heel", hz.error ? "failed" : "none", hz.error ? `Heel could not read it: ${hz.error}` : "Heel names no ring, bundle or cluster on it right now.");
    return { result: "wait", reason: "Watchfire, Ring Radar and Heel do not show a ring yet.", checks };
  }

  if (f.kind === "agent-misbehaving") {
    const sent = usable.filter((e) => e.from === lc(f.target));
    if (!sent.length) add("Evidence", "none", "None of the evidence transactions was sent by the agent wallet.");
    const { tridentCheck } = await import("./trident.mjs");
    for (const e of sent) {
      if (!e.to) continue;
      // no sender: a dry run now would replay a mined transaction against today's state and say nothing honest
      const t = await timeout(tridentCheck({ chainId: 4663, to: e.to, data: e.input || "0x", value: e.value || "0x0", authorizationList: e.authorizationList || undefined }), 30_000, "Trident").catch((x) => ({ error: x.message }));
      const b = (t.reasons || []).find((x) => x.level === "block");
      if (b) { const text = `Trident on ${short(e.hash)}: ${b.text}`; add("Trident", "hit", text, e.hash); return { result: "confirmed", reason: text, checks }; }
      add("Trident", t.error ? "failed" : "none", t.error ? `Trident could not read ${short(e.hash)}: ${t.error}` : `Trident on ${short(e.hash)}: ${t.verdict}${t.reasons?.[0] ? `, ${noDot(t.reasons[0].text).slice(0, 220)}` : ""}.`, e.hash);
    }
    const hz = await heelOf(f.target);
    if ((hz.severity === "critical" || hz.severity === "high") && hz.kind === "agent") { add("Heel", "hit", hz.heel); return { result: "confirmed", reason: `Heel on the agent: ${hz.heel}`, checks }; }
    add("Heel", hz.error ? "failed" : "none", hz.error ? `Heel could not read it: ${hz.error}` : `Heel on the agent: ${hz.severity || "none"}${hz.heel ? `, ${noDot(hz.heel)}` : ""}.`);
    return { result: "wait", reason: "Trident and Heel do not show the agent misbehaving.", checks };
  }
  return { result: "not-confirmed", reason: "Unknown flag kind.", checks };
}

export async function checkById(id) {
  const d0 = await store.readJson(FILE, blank());
  const f = d0.flags.find((x) => x.id === id);
  if (!f || f.status !== "open") return null;
  let r;
  try { r = await checkFlag(f); } catch (e) { r = { result: "wait", reason: `A read failed: ${String(e.message || e).slice(0, 160)}`, checks: [] }; }
  const now = Date.now();
  if (r.result === "wait" && now - f.at > WINDOW) r = { ...r, result: "not-confirmed", reason: `Troya's own reads did not confirm it within 24 hours. Last read: ${r.reason}` };
  await store.update(FILE, blank(), (d) => {
    const x = d.flags.find((y) => y.id === id);
    if (!x || x.status !== "open") return d;
    x.checkedAt = now; x.tries = (x.tries || 0) + 1; x.checks = r.checks.slice(0, 12); x.lastRead = r.reason;
    if (r.result === "wait") return d;
    x.status = r.result; x.reason = r.reason; x.decidedAt = now;
    if (r.result === "confirmed") {
      // the first confirmed flag on the event (one kind, one target, 48 hours) earns the credit, by when it was raised
      const same = d.flags.filter((y) => y.id !== x.id && y.status === "confirmed" && y.kind === x.kind && y.target === x.target && Math.abs(y.at - x.at) < EVENT_MS);
      const earlier = same.filter((y) => y.at < x.at).sort((a, b) => a.at - b.at)[0];
      if (earlier) { x.first = false; x.firstId = earlier.firstId || earlier.id; }
      else { x.first = true; for (const y of same) { y.first = false; y.firstId = x.id; } }
    }
    return d;
  });
  return r;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, blank());
    const now = Date.now();
    const due = d.flags.filter((f) => f.status === "open" && now - (f.checkedAt || 0) > RECHECK).sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, PER_TICK);
    for (const f of due) await checkById(f.id).catch((e) => console.warn("[argus]", e.message));
  } finally { busy = false; }
}

/* ---------------- the board ---------------- */
async function myrmidons() {
  const w = await store.readJson("warroom.json", { entries: [] }).catch(() => ({ entries: [] }));   // read-only: Myrmidons' own file
  return (w.entries || []).filter((e) => e.kind === "rug" && e.result === "confirmed").slice(0, 30)
    .map((e) => ({ id: e.id, at: e.at, wallet: short(e.wallet), token: e.token, symbol: e.symbol || null, note: e.note || null }));
}

export async function board(req) {
  const d = await store.readJson(FILE, blank());
  const targets = new Map();
  for (const w of d.watches) {
    const t = targets.get(w.target) || { target: w.target, kind: w.kind, symbol: w.symbol, watchers: 0, flagsOpen: 0, flagsConfirmed: 0 };
    t.watchers++; targets.set(w.target, t);
  }
  for (const f of d.flags) {
    const t = targets.get(f.target);
    if (!t) continue;
    if (f.status === "open") t.flagsOpen++;
    if (f.status === "confirmed") t.flagsConfirmed++;
  }
  const rep = new Map();
  for (const f of d.flags) {
    const r = rep.get(f.wallet) || { wallet: f.wallet, flags: 0, open: 0, confirmed: 0, first: 0, seconded: 0, notConfirmed: 0 };
    r.flags++;
    if (f.status === "open") r.open++;
    else if (f.status === "confirmed") { r.confirmed++; if (f.first) r.first++; else r.seconded++; }
    else r.notConfirmed++;
    rep.set(f.wallet, r);
  }
  const sentinels = [...rep.values()].map((r) => ({ ...r, wallet: short(r.wallet), accuracyPct: r.confirmed + r.notConfirmed ? Math.round((100 * r.confirmed) / (r.confirmed + r.notConfirmed)) : null }))
    .filter((r) => r.confirmed > 0 || r.notConfirmed > 0)
    .sort((a, b) => b.first - a.first || b.confirmed - a.confirmed || (b.accuracyPct ?? 0) - (a.accuracyPct ?? 0) || a.notConfirmed - b.notConfirmed).slice(0, 50);
  let s = null;
  try { s = req ? getSession(req) : null; } catch { s = null; }
  const meW = s?.address ? getAddress(s.address) : null;
  const pubFlag = (f) => ({ id: f.id, at: f.at, wallet: short(f.wallet), mine: !!meW && f.wallet === meW, target: f.target, targetKind: f.targetKind, symbol: f.symbol, kind: f.kind, label: KINDS[f.kind]?.label || f.kind,
    evidence: f.evidence.map((hash) => ({ hash, url: evLink(hash) })), note: f.note, status: f.status, reason: f.reason, lastRead: f.status === "open" ? f.lastRead || null : null,
    checks: f.checks || [], checkedAt: f.checkedAt || null, first: f.status === "confirmed" ? !!f.first : null, decidedAt: f.decidedAt || null, closesAt: f.at + WINDOW });
  return {
    name: "Troya Argus", kinds: Object.entries(KINDS).map(([k, v]) => ({ key: k, label: v.label, targets: v.targets })),
    totals: { watches: d.watches.length, sentinels: new Set(d.watches.map((w) => w.wallet)).size, targets: targets.size, flags: d.flags.length,
      open: d.flags.filter((f) => f.status === "open").length, confirmed: d.flags.filter((f) => f.status === "confirmed").length, notConfirmed: d.flags.filter((f) => f.status === "not-confirmed").length },
    watched: [...targets.values()].sort((a, b) => b.watchers - a.watchers || b.flagsConfirmed - a.flagsConfirmed).slice(0, 60),
    sentinels, flags: d.flags.slice(0, 200).map(pubFlag), myrmidons: await myrmidons(),
    me: meW ? { wallet: meW, watches: d.watches.filter((w) => w.wallet === meW).map((w) => ({ target: w.target, kind: w.kind, symbol: w.symbol, at: w.at })), max: MAX_WATCH } : null,
    rules: RULES, limits: { maxWatches: MAX_WATCH, flagsPerDay: FLAGS_PER_DAY, windowHours: WINDOW / H },
    note: "Reputation only: no prize pool and no points that turn into money. A confirmed flag means Troya's own reads agree with it at that time; a flag that is not confirmed can still be right about something Troya cannot read.",
    updatedAt: Date.now(),
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/argus", ({ req }) => board(req), { weight: 1, perMin: 120 });
  r.post("/api/argus/watch", ({ req, body }) => setWatch(requireSession(req).address, body || {}), { weight: 1, perMin: 30, maxBody: 2048 });
  r.post("/api/argus/flag", ({ req, body }) => raiseFlag(requireSession(req).address, body || {}), { weight: 2, perMin: 10, maxBody: 4096 });
  setInterval(() => tick().catch(() => {}), 3 * 60_000).unref?.();
  setTimeout(() => tick().catch(() => {}), 60_000).unref?.();
}
