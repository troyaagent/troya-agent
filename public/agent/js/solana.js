// Solana wallets for Swap (F12), without a Solana library: wallets are found through the Wallet Standard (Phantom, Solflare,
// Backpack, MetaMask and others register themselves), connected with standard:connect, and asked to sign and send the
// exact transaction Troya's server built with Jupiter for this address (solana:signAndSendTransaction). Troya never sees a key.
const found = new Map();
const api = { register: (...ws) => { for (const w of ws) if (w?.features?.["solana:signAndSendTransaction"]) found.set(w.name, w); return () => {}; } };
try {
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(api); } catch {} });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
} catch {}

const listeners = new Set();
export const sol = { address: null, wallet: null, account: null };
const emit = () => { for (const f of listeners) try { f(sol); } catch {} };
export const onSol = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const solWallets = () => [...found.values()];

export async function connectSol(name) {
  const list = solWallets();
  const w = name ? found.get(name) : list[0];
  if (!w) throw new Error("No Solana wallet found in this browser. Install Phantom or Solflare, or enable Solana in MetaMask, then reload.");
  const res = await w.features["standard:connect"].connect();
  const acc = (res?.accounts || w.accounts || [])[0];
  if (!acc?.address) throw new Error("The wallet did not share an address.");
  Object.assign(sol, { address: acc.address, wallet: w, account: acc });
  try { localStorage.setItem("troya.solWallet", w.name); } catch {}
  emit();
  return sol.address;
}
export async function disconnectSol() {
  try { await sol.wallet?.features?.["standard:disconnect"]?.disconnect(); } catch {}
  Object.assign(sol, { address: null, wallet: null, account: null });
  try { localStorage.removeItem("troya.solWallet"); } catch {}
  emit();
}
// reconnect quietly to the wallet used last time (no popup if the site is already trusted)
export async function restoreSol() {
  let name = null;
  try { name = localStorage.getItem("troya.solWallet"); } catch {}
  const w = name && found.get(name);
  if (!w) return null;
  try {
    const res = await w.features["standard:connect"].connect({ silent: true });
    const acc = (res?.accounts || w.accounts || [])[0];
    if (acc?.address) { Object.assign(sol, { address: acc.address, wallet: w, account: acc }); emit(); }
  } catch {}
  return sol.address;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
/** Signs and sends a base64 transaction from Troya's server; returns the signature (base58). */
export async function signAndSendSol(base64Tx) {
  if (!sol.wallet || !sol.account) throw new Error("Connect a Solana wallet first.");
  const bytes = Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
  const [res] = await sol.wallet.features["solana:signAndSendTransaction"].signAndSendTransaction({
    account: sol.account, transaction: bytes, chain: "solana:mainnet", options: { commitment: "confirmed" },
  });
  const sig = res?.signature;
  if (!sig) throw new Error("The wallet did not return a signature.");
  return typeof sig === "string" ? sig : b58(sig);
}
