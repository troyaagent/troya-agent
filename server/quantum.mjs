// V7 F36 Quantum-Ready. Honest framing: Robinhood Chain, like every EVM chain, runs on ECDSA (secp256k1), which a large
// enough quantum computer could break one day. What matters now is which keys are already exposed: an EOA's public key is
// public from its first outgoing transaction, a key that never sent anything (and contracts, multisigs) are not exposed.
//   GET /api/quantum/wallet/:address   is this wallet's public key exposed, and what that means
//   GET /api/quantum/token/:token      the token's owner/dev/fee recipient and top holders: who is exposed, how much supply
//   GET /api/quantum/beacon            public randomness from NIST Beacon 2.0 and drand, combined and signed into a Seal receipt
import { Interface, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { rpc, ponsState } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
const OWNABLE = new Interface(["function owner() view returns (address)", "function admin() view returns (address)", "function getOwner() view returns (address)"]);
const memo = new Map();
const cached = async (k, ms, fn) => { const h = memo.get(k); if (h && Date.now() - h.at < ms) return h.v; const v = await fn(); memo.set(k, { at: Date.now(), v }); return v; };

/** exposed: an EOA that has sent at least one transaction (nonce > 0), so its public key is on chain. */
export async function walletExposure(address) {
  const a = getAddress(address);
  return cached(`w:${lc(a)}`, 10 * 60_000, async () => {
    const [code, nonce] = await Promise.all([rpc("robinhood", "eth_getCode", [a, "latest"]), rpc("robinhood", "eth_getTransactionCount", [a, "latest"])]);
    const isContract = code && code !== "0x";
    const n = Number(BigInt(nonce || "0x0"));
    const kind = isContract ? (code.startsWith("0xef0100") ? "eoa-7702" : "contract") : "eoa";
    const exposed = kind !== "contract" && n > 0;
    return { address: a, kind, nonce: n, exposed,
      note: kind === "contract" ? "A contract: no single private key to break. Its owner keys, if any, are what matter."
        : exposed ? "Public key exposed (this wallet has sent transactions). Fine today; in a quantum future, funds here could be at risk, so long-term holdings belong in a fresh wallet or a smart account."
          : "Public key not exposed yet (this wallet never sent a transaction). Receiving is safe; the first send exposes the key." };
  });
}

async function readOwner(token) {
  for (const f of ["owner", "admin", "getOwner"]) {
    const r = await rpc("robinhood", "eth_call", [{ to: token, data: OWNABLE.encodeFunctionData(f) }, "latest"]).catch(() => null);
    if (r && r.length >= 66) { const a = "0x" + r.slice(26, 66); if (!/^0x0{40}$/.test(a)) return { role: f, address: getAddress(a) }; }
  }
  return null;
}

export async function tokenExposure(token) {
  const t = getAddress(token);
  return cached(`t:${lc(t)}`, 15 * 60_000, async () => {
    const roles = [];
    const own = await readOwner(t);
    if (own) roles.push({ role: own.role, address: own.address });
    const ps = await ponsState(t).catch(() => null);
    if (ps?.deployer) roles.push({ role: "deployer", address: getAddress(ps.deployer) });
    if (ps?.creatorFeeRecipient && lc(ps.creatorFeeRecipient) !== lc(ps.deployer)) roles.push({ role: "creator fee recipient", address: getAddress(ps.creatorFeeRecipient) });
    const roleOut = await Promise.all(roles.map(async (r) => ({ ...r, ...(await walletExposure(r.address)) })));
    let holders = null;
    try {
      const m = await import("./market.mjs");
      const th = await m.topHolders(lc(t));
      if (th?.holders?.length) {
        const top = th.holders.slice(0, 15);
        const ex = await Promise.all(top.map(async (h) => ({ address: getAddress(h.address), pct: Number(h.pct) || 0, label: h.label || null, ...(await walletExposure(h.address).catch(() => ({ kind: "unknown", exposed: false }))) })));
        const exposedPct = +ex.filter((h) => h.exposed).reduce((s, h) => s + h.pct, 0).toFixed(2);
        holders = { checked: ex.length, exposedPct, contractsPct: +ex.filter((h) => h.kind === "contract").reduce((s, h) => s + h.pct, 0).toFixed(2), top: ex };
      }
    } catch { /* holders need Blockscout */ }
    const exposedRoles = roleOut.filter((r) => r.exposed).map((r) => r.role);
    return { token: t, roles: roleOut, holders,
      summary: `${exposedRoles.length ? `Exposed keys control: ${exposedRoles.join(", ")}.` : "No owner, dev or fee key of this coin is exposed."}${holders ? ` ${holders.exposedPct}% of the supply in the top ${holders.checked} holders sits in wallets whose public key is exposed.` : ""}`,
      framing: "Quantum-Ready, not quantum-proof: nothing on an EVM chain is immune today. This shows which keys a future quantum computer would target first." };
  });
}

/* ---------- public randomness: NIST Beacon 2.0 + drand, combined ---------- */
export async function beacon() {
  return cached("beacon", 30_000, async () => {
    const [n, d] = await Promise.all([
      fetch("https://beacon.nist.gov/beacon/2.0/pulse/last", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j) => j.pulse).catch(() => null),
      fetch("https://api.drand.sh/public/latest", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null),
    ]);
    if (!n && !d) throw new HttpError(502, "Neither randomness beacon answered right now.");
    const parts = { nist: n ? { chain: n.chainIndex, pulse: n.pulseIndex, time: n.timeStamp, output: n.outputValue } : null, drand: d ? { round: d.round, randomness: d.randomness } : null };
    const value = keccak256(toUtf8Bytes(`${parts.nist?.output || ""}|${parts.drand?.randomness || ""}`));
    const rec = await import("./seal.mjs").then((m) => m.seal("beacon", "randomness", { ...parts, value })).catch(() => null);
    return { value, ...parts, receipt: rec?.hash || null, how: "value = keccak256(nist.output + '|' + drand.randomness). Check each source yourself: beacon.nist.gov/beacon/2.0/chain/<chain>/pulse/<pulse> and api.drand.sh/public/<round>." };
  });
}

export async function register(r) {
  r.get("/api/quantum/wallet/:address", async ({ params }) => { if (!isAddress(params.address)) throw new HttpError(400, "That is not a wallet address."); return walletExposure(params.address); }, { weight: 1 });
  r.get("/api/quantum/token/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return tokenExposure(params.token); }, { weight: 3, perMin: 30 });
  r.get("/api/quantum/beacon", async () => beacon(), { weight: 1 });
}
