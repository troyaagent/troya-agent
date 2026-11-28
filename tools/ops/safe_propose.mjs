// Puts one transaction in the team Safe's queue as the registered server proposer (SAFE_PROPOSER_KEY in /srv/troya/.env).
// The proposer only proposes: two of the three owners still confirm it in the Safe app, and one executes it. Nothing here
// signs as an owner, sends funds or executes. Run on the server as troya:
//   sudo -u troya node --env-file-if-exists=/srv/troya/.env tools/ops/safe_propose.mjs <to> <data> [value-wei] [--dry]
//   ... safe_propose.mjs --check-hash <nonce>    recomputes an existing transaction's safeTxHash (self-test, no write)
// Named shortcuts:  open-deposits  → TroyaIndex.setPaused(false, false)    pause → TroyaIndex.setPaused(true, true)
import { Wallet, Interface, TypedDataEncoder, getAddress } from "ethers";

const SAFE = "0xbF418C9e3a56acae5Bf5AeA7905Ea127763D7Fbb";
const VAULT = "0x6bf23c990602254ba066d3FFA4Fa1598425EE279";
const TX = "https://api.safe.global/tx-service/robinhood";
const CHAIN_ID = 4663;
const ZERO = "0x0000000000000000000000000000000000000000";
const TYPES = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] };
const DOMAIN = { chainId: CHAIN_ID, verifyingContract: SAFE };
const headers = () => ({ "content-type": "application/json", ...(process.env.SAFE_API_KEY ? { authorization: `Bearer ${process.env.SAFE_API_KEY}` } : {}) });
const get = (p) => fetch(`${TX}${p}`, { headers: headers() }).then((r) => r.json());
const hashOf = (t) => TypedDataEncoder.hash(DOMAIN, TYPES, t);

const args = process.argv.slice(2);
if (args[0] === "--check-hash") {
  const t = (await get(`/api/v1/safes/${SAFE}/multisig-transactions/?nonce=${Number(args[1])}`)).results?.[0];
  if (!t) { console.log("no transaction with that nonce"); process.exit(1); }
  const mine = hashOf({ to: t.to, value: t.value, data: t.data || "0x", operation: t.operation, safeTxGas: t.safeTxGas, baseGas: t.baseGas, gasPrice: t.gasPrice, gasToken: t.gasToken, refundReceiver: t.refundReceiver, nonce: t.nonce });
  console.log(mine === t.safeTxHash ? `hash ok ${mine}` : `HASH MISMATCH mine ${mine} service ${t.safeTxHash}`);
  process.exit(mine === t.safeTxHash ? 0 : 1);
}
const V = new Interface(["function setPaused(bool deposits, bool rebalances)"]);
const named = { "open-deposits": [VAULT, V.encodeFunctionData("setPaused", [false, false])], pause: [VAULT, V.encodeFunctionData("setPaused", [true, true])] };
const dry = args.includes("--dry");
const pos = args.filter((a) => a !== "--dry");
const [to, data] = named[pos[0]] || [pos[0], pos[1]];
const value = named[pos[0]] ? "0" : String(pos[2] || "0");
if (!to || !/^0x[0-9a-fA-F]*$/.test(data || "")) { console.log("usage: safe_propose.mjs <to> <data> [value] [--dry] | open-deposits | pause | --check-hash <nonce>"); process.exit(1); }
const key = process.env.SAFE_PROPOSER_KEY;
if (!key) { console.log("SAFE_PROPOSER_KEY is not set"); process.exit(1); }
const w = new Wallet(key);
const safe = await get(`/api/v1/safes/${SAFE}/`);
// the next free nonce: after the Safe's own nonce and every transaction already queued
const queued = await get(`/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&nonce__gte=${safe.nonce}&ordering=-nonce&limit=1`);
const nonce = Math.max(Number(safe.nonce), queued.results?.[0] ? Number(queued.results[0].nonce) + 1 : 0);
const tx = { to: getAddress(to), value, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce };
const safeTxHash = hashOf(tx);
const signature = await w.signTypedData(DOMAIN, TYPES, tx);
console.log(`proposer ${w.address} · Safe nonce ${safe.nonce} · this one ${nonce} · ${pos[0]} · safeTxHash ${safeTxHash}`);
if (dry) { console.log("dry run: nothing sent"); process.exit(0); }
const r = await fetch(`${TX}/api/v1/safes/${SAFE}/multisig-transactions/`, { method: "POST", headers: headers(),
  body: JSON.stringify({ ...tx, safeTxGas: "0", baseGas: "0", contractTransactionHash: safeTxHash, sender: w.address, signature, origin: "Troya server proposer" }) });
const text = await r.text();
console.log(r.ok ? `queued: open the Safe app → Transactions → Queue, nonce ${nonce}` : `refused ${r.status}: ${text.slice(0, 300)}`);
process.exit(r.ok ? 0 : 1);
