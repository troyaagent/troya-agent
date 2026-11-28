// Safe proposer (28 Nov 2026): the server's proposer wallet (SAFE_PROPOSER_ADDRESS; its key stays in .env) puts transactions
// in the team Safe's queue through the Safe Transaction Service, so the team only confirms and executes them in the Safe app.
// It is registered once as a delegate of the Safe: a Safe owner signs an EIP-712 message on troya.codes (#/vault/deploy) and
// this route passes it to the service's own endpoint (the Safe app charges for adding proposers; the endpoint does not).
// A delegate can only propose: it is not an owner, holds no funds, cannot confirm and cannot execute. Two of the three owners
// still confirm and one executes. The route checks the signature and that the signer is an owner before passing it on.
//   GET  /api/safe/proposer   the Safe, the proposer address, the owners and whether the proposer is registered
//   POST /api/safe/delegate   { delegator, signature, totp } from an owner's wallet → registered with the Safe Transaction Service
import { getAddress, verifyTypedData, Wallet, TypedDataEncoder } from "ethers";
import { HttpError } from "./api.mjs";

export const SAFE = "0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb";
const TX = "https://api.safe.global/tx-service/robinhood";
const CHAIN_ID = 4663;
export const DOMAIN = { name: "Safe Transaction Service", version: "1.0", chainId: CHAIN_ID };
export const TYPES = { Delegate: [{ name: "delegateAddress", type: "address" }, { name: "totp", type: "uint256" }] };
const lc = (a) => String(a || "").toLowerCase();
const headers = () => ({ "content-type": "application/json", ...(process.env.SAFE_API_KEY ? { authorization: `Bearer ${process.env.SAFE_API_KEY}` } : {}) });
const proposer = () => (process.env.SAFE_PROPOSER_ADDRESS ? getAddress(process.env.SAFE_PROPOSER_ADDRESS) : null);

async function txs(path, opts = {}) {
  const r = await fetch(`${TX}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers || {}) }, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
  return { ok: r.ok, status: r.status, json, text };
}

export async function status() {
  const p = proposer();
  const safe = await txs(`/api/v1/safes/${SAFE}/`);
  const owners = (safe.json?.owners || []).map((a) => getAddress(a));
  const del = p ? await txs(`/api/v2/delegates/?safe=${SAFE}&delegate=${p}`) : null;
  return {
    safe: SAFE, chainId: CHAIN_ID, proposer: p, owners, threshold: safe.json?.threshold ?? null, nonce: safe.json?.nonce != null ? Number(safe.json.nonce) : null,
    registered: !!(del?.json?.count > 0), delegators: (del?.json?.results || []).map((d) => getAddress(d.delegator)),
    note: "The proposer can only add transactions to the Safe queue. It cannot confirm, execute or hold funds.",
  };
}

async function registerDelegate(body = {}) {
  const p = proposer();
  if (!p) throw new HttpError(503, "The server has no proposer wallet set.");
  let delegator;
  try { delegator = getAddress(String(body.delegator || "")); } catch { throw new HttpError(400, "Bad delegator address."); }
  const totp = Number(body.totp);
  const now = Math.floor(Date.now() / 1000 / 3600);
  if (!Number.isInteger(totp) || Math.abs(totp - now) > 1) throw new HttpError(400, "The signed message is too old. Sign again.");
  const sig = String(body.signature || "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "Bad signature.");
  const signer = verifyTypedData(DOMAIN, TYPES, { delegateAddress: p, totp }, sig);
  if (lc(signer) !== lc(delegator)) throw new HttpError(400, "The signature is not from the connected wallet.");
  const st = await status();
  if (!st.owners.some((o) => lc(o) === lc(delegator))) throw new HttpError(403, "Only a signer of the team Safe can register the proposer.");
  if (st.registered) return { ok: true, already: true, proposer: p };
  const r = await txs(`/api/v2/delegates/`, { method: "POST", body: JSON.stringify({ safe: SAFE, delegate: p, delegator, signature: sig, label: "Troya server proposer" }) });
  if (!r.ok) throw new HttpError(502, `The Safe service refused it (${r.status}): ${String(r.text || "").slice(0, 200)}`);
  console.log(`[safeprop] proposer ${p} registered by ${delegator}`);
  return { ok: true, proposer: p, delegator };
}

/* ---------- proposing (the registered server proposer; owners still confirm and execute) ---------- */
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE_TX = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] };
const SAFE_DOMAIN = { chainId: CHAIN_ID, verifyingContract: SAFE };
export const safeTxHashOf = (t) => TypedDataEncoder.hash(SAFE_DOMAIN, SAFE_TX, t);

/** Puts one call in the team Safe's queue as the proposer → { nonce, safeTxHash }. Never signs as an owner or executes. */
export async function proposeSafeTx({ to, value = "0", data = "0x", origin = "Troya server proposer" }) {
  const key = process.env.SAFE_PROPOSER_KEY;
  if (!key) throw new Error("SAFE_PROPOSER_KEY is not set");
  const w = new Wallet(key);
  const safe = (await txs(`/api/v1/safes/${SAFE}/`)).json;
  if (!safe?.nonce && safe?.nonce !== 0 && safe?.nonce !== "0") throw new Error("the Safe could not be read");
  const queued = (await txs(`/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&nonce__gte=${safe.nonce}&ordering=-nonce&limit=1`)).json;
  const nonce = Math.max(Number(safe.nonce), queued?.results?.[0] ? Number(queued.results[0].nonce) + 1 : 0);
  const tx = { to: getAddress(to), value: String(value), data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce };
  const safeTxHash = safeTxHashOf(tx);
  const signature = await w.signTypedData(SAFE_DOMAIN, SAFE_TX, tx);
  const r = await txs(`/api/v1/safes/${SAFE}/multisig-transactions/`, { method: "POST",
    body: JSON.stringify({ ...tx, safeTxGas: "0", baseGas: "0", contractTransactionHash: safeTxHash, sender: w.address, signature, origin: String(origin).slice(0, 200) }) });
  if (!r.ok) throw new Error(`the Safe service refused it (${r.status}): ${String(r.text || "").slice(0, 160)}`);
  return { nonce, safeTxHash };
}
/** A queued or executed Safe transaction by its hash → { executed, successful, txHash, confirmations } or null. */
export async function safeTxStatus(safeTxHash) {
  const r = await txs(`/api/v1/multisig-transactions/${safeTxHash}/`);
  if (!r.ok || !r.json) return null;
  return { executed: !!r.json.isExecuted, successful: r.json.isSuccessful ?? null, txHash: r.json.transactionHash || null, confirmations: (r.json.confirmations || []).length, nonce: Number(r.json.nonce) };
}

export async function register(r) {
  r.get("/api/safe/proposer", () => status(), { weight: 1, perMin: 30 });
  r.post("/api/safe/delegate", ({ body }) => registerDelegate(body), { perMin: 10 });
}
