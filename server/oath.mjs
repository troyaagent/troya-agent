// V7 F32 Oath, tier 1 ("watched"): a dev signs a public pledge for a coin, Troya watches the chain and shows it live as
// Oath kept or Oath broken, with the transactions that broke it. Pledges a dev can make:
//   · maxSellBps: the dev and the wallets it names sell at most this share of the supply per UTC day (500 = 5%)
//   · feeLockDays: the creator-fee recipient does not claim from the Pons fee escrow for this many days
//   · wallets: every wallet the dev controls or freed from the snipe tax, disclosed up front (they count toward the cap)
// Signed with EIP-712 (domain "Troya Oath" v1, chain 4663) by the coin's Pons deployer or creator-fee recipient. Tier 2
// (held by Troya's rules) and tier 3 (an Oath Vault enforced in code and proven) build on the same record.
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

const view = (o) => ({ token: o.token, status: o.status, pledge: { maxSellPctPerDay: o.maxSellBps / 100, feeLockDays: o.feeLockDays, wallets: o.wallets },
  signer: o.signer, takenAt: o.takenAt, breaches: o.breaches, checkedBlock: o.checkedBlock,
  feeLockUntil: o.feeLockDays ? o.takenAt + o.feeLockDays * 86_400_000 : null, tier: "watched" });

export async function oathOf(token) { const d = await store.readJson(FILE, {}); const o = d.oaths?.[lc(token)]; return o ? view(o) : null; }

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => watch().catch(() => {}), 45_000);
  setInterval(() => watch().catch(() => {}), 10 * 60_000).unref();
  r.get("/api/oath", async () => { const d = await store.readJson(FILE, {}); return { typedData: oathTypedData, oaths: Object.values(d.oaths || {}).map(view) }; }, { weight: 1 });
  r.get("/api/oath/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return (await oathOf(params.token)) || { token: getAddress(params.token), status: "none", note: "No Oath taken for this coin yet.", typedData: oathTypedData }; }, { weight: 1 });
  r.post("/api/oath", async ({ body }) => view(await take(body || {})), { weight: 4, perMin: 10 });
}
