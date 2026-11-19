// V7 F32 Oath, tier 1 ("watched"): a dev signs a public pledge for a coin, Troya watches the chain and shows it live as
// Oath kept or Oath broken, with the transactions that broke it. Pledges a dev can make:
//   · maxSellBps: the dev and the wallets it names sell at most this share of the supply per UTC day (500 = 5%)
//   · feeLockDays: the creator-fee recipient does not claim from the Pons fee escrow for this many days
//   · wallets: every wallet the dev controls or freed from the snipe tax, disclosed up front (they count toward the cap)
// Signed with EIP-712 (domain "Troya Oath" v1, chain 4663) by the coin's Pons deployer or creator-fee recipient. Tier 2
// (held by Troya's rules: a broken Oath turns the coin's Gate verdict and Sentry post to caution, and the wallets behind it cannot
// launch through Troya for 30 days) and tier 3 (an Oath Vault enforced in code and proven) build on the same record.
//   GET  /api/oath                 every oath and its status
//   GET  /api/oath/:token          one coin's oath, breaches and the evidence
//   POST /api/oath                 { token, pledge:{maxSellBps,feeLockDays,wallets,issuedAt}, signature }
import { getAddress, isAddress, verifyTypedData, zeroPadValue, id as keccakId, Interface } from "ethers";
import { rpc, ADDR, CHAINS, ponsState } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const FILE = "oath.json";
const ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const T_CLAIMED = keccakId("Claimed(address,uint256)");
const DOMAIN = { name: "Troya Oath", version: "1", chainId: 4663 };
const TYPES = { Oath: [{ name: "token", type: "address" }, { name: "maxSellBps", type: "uint16" }, { name: "feeLockDays", type: "uint16" }, { name: "wallets", type: "address[]" }, { name: "issuedAt", type: "uint64" }] };
const ERC20 = new Interface(["function totalSupply() view returns (uint256)"]);
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const day = (t) => new Date(t).toISOString().slice(0, 10);
let store = null, busy = false;

export const oathTypedData = { domain: DOMAIN, types: TYPES };

async function take({ token, pledge, signature }) {
  if (!isAddress(String(token || ""))) throw new HttpError(400, "token must be a coin address on Robinhood Chain.");
  const p = { token: getAddress(token), maxSellBps: Math.max(0, Math.min(10_000, Math.round(Number(pledge?.maxSellBps ?? 500)))), feeLockDays: Math.max(0, Math.min(365, Math.round(Number(pledge?.feeLockDays ?? 0)))),
    wallets: [...new Set((pledge?.wallets || []).filter((w) => isAddress(w)).map((w) => getAddress(w)))].slice(0, 40), issuedAt: Math.round(Number(pledge?.issuedAt || 0)) };
  if (!p.issuedAt || Math.abs(Date.now() / 1000 - p.issuedAt) > 3600) throw new HttpError(400, "issuedAt must be the signing time in seconds (within the last hour).");
  let signer;
  try { signer = verifyTypedData(DOMAIN, TYPES, p, signature); } catch { throw new HttpError(400, "The signature does not match the pledge."); }
  const ps = await ponsState(p.token).catch(() => null);
  if (!ps) throw new HttpError(400, "Oaths are for Pons coins on Robinhood Chain for now.");
  const owners = [lc(ps.deployer), lc(ps.creatorFeeRecipient)];
  if (!owners.includes(lc(signer))) throw new HttpError(403, "Only the coin's Pons deployer or creator-fee recipient can take its Oath.");
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const rec = { ...p, signer: getAddress(signer), signature, deployer: getAddress(ps.deployer), feeRecipient: getAddress(ps.creatorFeeRecipient), curve: ps.curve ? getAddress(ps.curve) : null,
    takenAt: Date.now(), startBlock: head, checkedBlock: head, status: "kept", breaches: [], soldByDay: {} };
  await store.update(FILE, {}, (d) => { d.oaths ||= {}; d.oaths[lc(p.token)] = rec; return d; });
  import("./seal.mjs").then((m) => m.seal("oath-taken", p.token, { ...p, signer: rec.signer }, `max ${p.maxSellBps / 100}%/day, fees locked ${p.feeLockDays}d`)).catch(() => {});
  return rec;
}

// one pass over every oath: dev-side sells into the curve or the pool per UTC day, and fee claims during the lock
async function watch() {
  if (busy || !store) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, {});
    const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
    for (const [k, o] of Object.entries(d.oaths || {})) {
      const from = (o.checkedBlock || o.startBlock) + 1;
      if (from > head) continue;
      const to = Math.min(head, from + 29_999);
      const devs = [...new Set([o.signer, o.deployer, o.feeRecipient, ...(o.wallets || [])].map(lc))];
      const venues = new Set([lc(o.curve), lc(ADDR.poolManager)].filter(Boolean));
      const supply = BigInt(await rpc("robinhood", "eth_call", [{ to: o.token, data: ERC20.encodeFunctionData("totalSupply") }, "latest"]));
      const logs = await rpc("robinhood", "eth_getLogs", [{ address: o.token, topics: [T_TRANSFER, devs.map((w) => zeroPadValue(w, 32))], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 20_000, only: CHAINS.robinhood.upstreams[0] }).catch(() => null);
      if (!logs) continue;
      const blockTime = new Map();
      for (const l of logs) {
        const toAddr = "0x" + l.topics[2].slice(26);
        if (!venues.has(toAddr)) continue;                                     // a sell is a transfer into the curve or the pool
        const bn = Number(BigInt(l.blockNumber));
        if (!blockTime.has(bn)) { const b = await rpc("robinhood", "eth_getBlockByNumber", [hex(bn), false]).catch(() => null); blockTime.set(bn, b ? Number(BigInt(b.timestamp)) * 1000 : Date.now()); }
        const dd = day(blockTime.get(bn));
        const amt = BigInt(l.data);
        o.soldByDay[dd] = (BigInt(o.soldByDay[dd] || 0) + amt).toString();
        const soldBps = supply > 0n ? Number((BigInt(o.soldByDay[dd]) * 10_000n) / supply) : 0;
        if (soldBps > o.maxSellBps && !o.breaches.some((b) => b.kind === "sell" && b.day === dd)) {
          o.breaches.push({ kind: "sell", day: dd, soldPct: soldBps / 100, capPct: o.maxSellBps / 100, tx: l.transactionHash, at: blockTime.get(bn) });
        }
      }
      if (o.feeLockDays > 0 && Date.now() < o.takenAt + o.feeLockDays * 86_400_000) {
        const claims = await rpc("robinhood", "eth_getLogs", [{ address: ESCROW, topics: [T_CLAIMED, zeroPadValue(lc(o.feeRecipient), 32)], fromBlock: hex(from), toBlock: hex(to) }], { timeoutMs: 20_000, only: CHAINS.robinhood.upstreams[0] }).catch(() => []);
        for (const c of claims || []) if (!o.breaches.some((b) => b.tx === c.transactionHash)) o.breaches.push({ kind: "fee-claim", tx: c.transactionHash, at: Date.now(), note: `claimed creator fees during the ${o.feeLockDays}-day lock` });
      }
      const was = o.status;
      o.status = o.breaches.length ? "broken" : "kept";
      o.checkedBlock = to;
      if (was !== o.status) import("./seal.mjs").then((m) => m.seal("oath-broken", o.token, o.breaches.slice(-1)[0], o.breaches.slice(-1)[0]?.tx)).catch(() => {});
      d.oaths[k] = o;
    }
    await store.update(FILE, {}, (x) => { x.oaths ||= {}; for (const [k, o] of Object.entries(d.oaths || {})) x.oaths[k] = { ...(x.oaths[k] || {}), ...o }; return x; });
  } catch (e) { console.warn("[oath]", e.message); }
  finally { busy = false; }
}

/* ---------- tier 3: coins locked in the Troya Oath Vault (contracts/src/TroyaOathVault.sol), read on chain ----------
   Off until OATH_VAULT holds the deployed vault's address. Each Locked event for the coin whose beneficiary is the coin's
   dev side counts: how much is locked, what has unlocked by now, the rate per day and the cliff. */
const VAULT = process.env.OATH_VAULT || "";
const T_LOCKED = keccakId("Locked(uint256,address,address,uint256,uint64,uint256)");
const VAULT_IF = new Interface(["function locks(uint256) view returns (address token, address beneficiary, uint128 amount, uint128 withdrawn, uint64 cliff, uint128 ratePerDay)", "function available(uint256) view returns (uint256)"]);
const vaultMemo = new Map();
export async function vaultOf(token) {
  if (!isAddress(VAULT)) return null;
  const t = lc(token), hit = vaultMemo.get(t);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const logs = await rpc("robinhood", "eth_getLogs", [{ address: VAULT, topics: [T_LOCKED, null, zeroPadValue(t, 32)], fromBlock: hex(Number(process.env.OATH_VAULT_BLOCK || 0)), toBlock: "latest" }], { timeoutMs: 20_000, only: CHAINS.robinhood.upstreams[0] }).catch(() => null);
  if (!logs) return null;
  const ps = await ponsState(t).catch(() => null);
  const dev = new Set([ps?.deployer, ps?.creatorFeeRecipient].filter(Boolean).map(lc));
  const out = [];
  for (const l of logs) {
    const id = BigInt(l.topics[1]);
    const r = await rpc("robinhood", "eth_call", [{ to: VAULT, data: VAULT_IF.encodeFunctionData("locks", [id]) }, "latest"]).catch(() => null);
    if (!r) continue;
    const [, beneficiary, amount, withdrawn, cliff, rate] = VAULT_IF.decodeFunctionResult("locks", r);
    out.push({ id: Number(id), beneficiary: getAddress(beneficiary), dev: dev.has(lc(beneficiary)), amount: amount.toString(), withdrawn: withdrawn.toString(), cliff: Number(cliff) * 1000, ratePerDay: rate.toString(), tx: l.transactionHash });
  }
  const supply = BigInt(await rpc("robinhood", "eth_call", [{ to: t, data: ERC20.encodeFunctionData("totalSupply") }, "latest"]).catch(() => "0x0"));
  const devLocks = out.filter((x) => x.dev);
  const locked = devLocks.reduce((s2, x) => s2 + BigInt(x.amount) - BigInt(x.withdrawn), 0n);
  const v = { vault: getAddress(VAULT), locks: out, devLockedPct: supply > 0n ? Number((locked * 10_000n) / supply) / 100 : null };
  vaultMemo.set(t, { at: Date.now(), v });
  return v;
}

const view = (o) => ({ token: o.token, status: o.status, pledge: { maxSellPctPerDay: o.maxSellBps / 100, feeLockDays: o.feeLockDays, wallets: o.wallets },
  signer: o.signer, takenAt: o.takenAt, breaches: o.breaches, checkedBlock: o.checkedBlock,
  feeLockUntil: o.feeLockDays ? o.takenAt + o.feeLockDays * 86_400_000 : null, tier: "watched" });

/** Tier 2, held by Troya's rules: the newest Oath one of these wallets broke in the last 30 days, or null. */
export async function brokeOath(wallets) {
  const want = new Set((wallets || []).filter(Boolean).map(lc));
  const d = await store.readJson(FILE, {});
  let hit = null;
  for (const o of Object.values(d.oaths || {})) {
    if (o.status !== "broken") continue;
    const at = Math.max(...o.breaches.map((b) => b.at || 0));
    if (Date.now() - at > 30 * 86_400_000) continue;
    if (![o.signer, o.deployer, o.feeRecipient, ...(o.wallets || [])].some((w) => want.has(lc(w)))) continue;
    if (!hit || at > hit.at) hit = { token: o.token, at, until: at + 30 * 86_400_000, breach: o.breaches.at(-1) };
  }
  return hit;
}

export async function oathOf(token) {
  const d = await store.readJson(FILE, {});
  const o = d.oaths?.[lc(token)];
  if (!o) return null;
  const v = view(o);
  const vault = await vaultOf(token).catch(() => null);
  if (vault?.locks?.some((x) => x.dev)) { v.vault = vault; v.tier = "vault"; }
  return v;
}

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => watch().catch(() => {}), 45_000);
  setInterval(() => watch().catch(() => {}), 10 * 60_000).unref();
  r.get("/api/oath", async () => { const d = await store.readJson(FILE, {}); return { typedData: oathTypedData, oaths: Object.values(d.oaths || {}).map(view) }; }, { weight: 1 });
  r.get("/api/oath/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return (await oathOf(params.token)) || { token: getAddress(params.token), status: "none", note: "No Oath taken for this coin yet.", typedData: oathTypedData }; }, { weight: 1 });
  r.post("/api/oath", async ({ body }) => view(await take(body || {})), { weight: 4, perMin: 10 });
}
