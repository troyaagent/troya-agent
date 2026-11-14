// Browser chain helpers for Swap / Bridge / Create coin on Robinhood Chain. Reads go through the same-origin relay (wallet.js reader),
// writes go through the user's wallet (signerFor). Nothing here holds a key.
import { Contract, Interface, formatUnits, parseUnits } from "ethers";
import { reader, signerFor, wallet } from "./wallet.js";
import { api } from "./api.js";
import { store } from "./ui.js";

export const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
]);

export const ETH = { address: "native", symbol: "ETH", name: "Ether", decimals: 18 };
export const isNative = (t) => !t || t === "native" || t?.address === "native" || /^(eth|0x0{40})$/i.test(String(t?.address ?? t));

/** Balance of a token (or native ETH) on a chain, as { raw: bigint, amount: number }. */
export async function balanceOf(owner, token = ETH, chain = "robinhood") {
  if (!owner) return null;
  const p = reader(chain);
  if (isNative(token)) { const raw = await p.getBalance(owner); return { raw, amount: Number(formatUnits(raw, 18)) }; }
  const c = new Contract(token.address, ERC20, p);
  const raw = BigInt(await c.balanceOf(owner));
  return { raw, amount: Number(formatUnits(raw, token.decimals ?? 18)) };
}

export function toRaw(amount, decimals = 18) {
  const s = String(amount ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || !s || s === ".") return null;
  const [w, f = ""] = s.split(".");
  try { return parseUnits(`${w || "0"}.${f.slice(0, decimals) || "0"}`, decimals); } catch { return null; }
}
export const fromRaw = (raw, decimals = 18) => Number(formatUnits(BigInt(raw), decimals));
/** Trims a float for an input field without exponent notation. */
export function inputNum(v, maxDp = 6) {
  if (!isFinite(v) || v <= 0) return "";
  const s = v.toFixed(Math.min(18, maxDp));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Sends a transaction through the connected wallet on `chain`; returns the hash. */
export async function sendTx(chain, tx) {
  const signer = await signerFor(chain);
  const res = await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0), ...(tx.gasLimit ? { gasLimit: BigInt(tx.gasLimit) } : {}) });
  return res.hash;
}

/** Polls a receipt through the relay until mined or timeout. Returns the receipt or null. */
export async function waitReceipt(chain, hash, { timeoutMs = 120_000, every = 1200, onTick } = {}) {
  const p = reader(chain);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await p.getTransactionReceipt(hash); if (r) return r; } catch {}
    onTick?.();
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

/** A friendlier message for wallet / RPC errors. */
export function errText(e) {
  const m = String(e?.shortMessage || e?.info?.error?.message || e?.message || e || "");
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || /user rejected|user denied|rejected the request/i.test(m)) return "You cancelled the request in your wallet.";
  if (/insufficient funds/i.test(m)) return "Not enough ETH to cover the amount plus network fee.";
  if (/TooLittleReceived|Too little received|STF|slippage/i.test(m)) return "The price moved past your slippage. Get a fresh quote and try again.";
  if (/Expired|Transaction too old/i.test(m)) return "The swap expired before it was included. Try again.";
  return m.length > 220 ? m.slice(0, 220) + "…" : m || "Something went wrong.";
}

/** Fire-and-forget audit entry (the journal module may not exist yet). */
export function journal(entry) {
  api.post("journal", { ...entry, address: wallet.address, at: Date.now() }).catch(() => {});
}

/* ---------- bridge transfers kept in this browser ---------- */
export const transfers = store("troya.transfers.v1", []);
export function addTransfer(t) { const list = transfers.get(); list.unshift(t); transfers.set(list.slice(0, 40)); }
export function updateTransfer(hash, patch) { transfers.set(transfers.get().map((t) => (t.hash === hash ? { ...t, ...patch } : t))); }

/* ---------- random 32-byte salt for a launch ---------- */
export function randomSalt() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
