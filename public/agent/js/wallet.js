// Wallet layer: EIP-6963 discovery, connect, chain switching, read providers via our RPC relay, sign-in.
import { BrowserProvider, JsonRpcProvider, getAddress } from "ethers";
import { h, modal, toast, short, store, walletLogo } from "./ui.js";
import { api } from "./api.js";

export const CHAINS = {
  robinhood: { key: "robinhood", id: 4663, hex: "0x1237", name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", relay: "/api/rpc/robinhood", currency: "ETH", explorer: "https://robinhoodchain.blockscout.com" },
  arbitrum: { key: "arbitrum", id: 42161, hex: "0xa4b1", name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", relay: "/api/rpc/arbitrum", currency: "ETH", explorer: "https://arbiscan.io" },
  base: { key: "base", id: 8453, hex: "0x2105", name: "Base", rpc: "https://mainnet.base.org", relay: "/api/rpc/base", currency: "ETH", explorer: "https://basescan.org" },
  ethereum: { key: "ethereum", id: 1, hex: "0x1", name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", relay: "/api/rpc/ethereum", currency: "ETH", explorer: "https://etherscan.io" },
};
export const chainById = (id) => Object.values(CHAINS).find((c) => c.id === Number(id));

// read-only providers through the same-origin relay (CSP keeps connect-src at 'self')
const readers = {};
export function reader(chain = "robinhood") {
  const c = CHAINS[chain];
  if (!readers[chain]) readers[chain] = new JsonRpcProvider(new URL(c.relay, location.origin).href, { chainId: c.id, name: c.key }, { staticNetwork: true, batchMaxCount: 10 });
  return readers[chain];
}

/* ---------- state ---------- */
const listeners = new Set();
export const wallet = { status: "disconnected", address: null, chainId: null, eip: null, info: null, session: null };
function emit() { for (const fn of listeners) { try { fn(wallet); } catch (e) { console.error(e); } } }
export function onWallet(fn) { listeners.add(fn); fn(wallet); return () => listeners.delete(fn); }

const found = new Map();
addEventListener("eip6963:announceProvider", (e) => found.set(e.detail.info.uuid, e.detail));
dispatchEvent(new Event("eip6963:requestProvider"));
export function available() {
  const list = [...found.values()];
  if (!list.length && window.ethereum) list.push({ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "" }, provider: window.ethereum });
  return list;
}

const last = store("troya.wallet.last", null);

function bind(eip) {
  eip.on?.("accountsChanged", (accs) => {
    if (!accs?.length) { disconnect(); return; }
    wallet.address = getAddress(accs[0]);
    wallet.session = null;
    emit();
    refreshSession();
  });
  eip.on?.("chainChanged", (hex) => { wallet.chainId = Number(hex); emit(); });
}

export async function connectWith(detail) {
  const eip = detail.provider;
  const accs = await eip.request({ method: "eth_requestAccounts" });
  wallet.eip = eip;
  wallet.info = detail.info;
  wallet.address = getAddress(accs[0]);
  wallet.chainId = Number(await eip.request({ method: "eth_chainId" }));
  wallet.status = "connected";
  last.set(detail.info.rdns || detail.info.name);
  bind(eip);
  emit();
  refreshSession();
  return wallet;
}

// silent reconnect if the user connected before and the wallet still authorises us
export async function restore() {
  const want = last.get();
  if (!want) return;
  await new Promise((r) => setTimeout(r, 120));
  const d = available().find((x) => (x.info.rdns || x.info.name) === want) || available()[0];
  if (!d) return;
  try {
    const accs = await d.provider.request({ method: "eth_accounts" });
    if (!accs?.length) return;
    wallet.eip = d.provider;
    wallet.info = d.info;
    wallet.address = getAddress(accs[0]);
    wallet.chainId = Number(await d.provider.request({ method: "eth_chainId" }));
    wallet.status = "connected";
    bind(d.provider);
    emit();
    refreshSession();
  } catch {}
}

export function disconnect() {
  wallet.status = "disconnected";
  wallet.address = null;
  wallet.eip = null;
  wallet.session = null;
  last.set(null);
  api.post("auth/logout").catch(() => {});
  emit();
}

export async function ensureChain(key) {
  const c = CHAINS[key];
  if (!wallet.eip) throw new Error("Connect a wallet first.");
  if (Number(await wallet.eip.request({ method: "eth_chainId" })) === c.id) return;
  try {
    await wallet.eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hex }] });
  } catch (e) {
    if (e.code !== 4902 && !/unrecognized|not been added|unknown chain|not added/i.test(e.message || "")) throw e;
    await addChain(key);
  }
  wallet.chainId = c.id;
  emit();
}
export async function addChain(key) {
  const c = CHAINS[key];
  const eip = wallet.eip || available()[0]?.provider;
  if (!eip) throw new Error("No browser wallet found.");
  await eip.request({ method: "wallet_addEthereumChain", params: [{
    chainId: c.hex, chainName: c.name, nativeCurrency: { name: c.currency, symbol: c.currency, decimals: 18 }, rpcUrls: [c.rpc], ...(c.explorer ? { blockExplorerUrls: [c.explorer] } : {}),
  }] });
}

// signer for a chain: switches first, then returns an ethers Signer
export async function signerFor(key) {
  await ensureChain(key);
  const provider = new BrowserProvider(wallet.eip, "any");
  return provider.getSigner(wallet.address);
}

/* ---------- sign-in (session for chat, inbox, agent wallet, playbooks) ---------- */
async function refreshSession() {
  try { const me = await api.get("me"); wallet.session = me?.address && me.address.toLowerCase() === wallet.address?.toLowerCase() ? me : null; }
  catch { wallet.session = null; }
  emit();
}
export async function signIn() {
  if (!wallet.address) await openConnect();
  if (!wallet.address) throw new Error("Connect a wallet to sign in.");
  const { message } = await api.post("auth/nonce", { address: wallet.address });
  const signature = await wallet.eip.request({ method: "personal_sign", params: [toHex(message), wallet.address] });
  const me = await api.post("auth/verify", { address: wallet.address, message, signature });
  wallet.session = me;
  emit();
  toast("Signed in", "ok");
  return me;
}
const toHex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

/* ---------- connect dialog ---------- */
const KNOWN = [
  { name: "MetaMask", install: "https://metamask.io/download/" },
  { name: "Rabby", install: "https://rabby.io/" },
  { name: "OKX Wallet", install: "https://web3.okx.com/download" },
  { name: "Coinbase Wallet", install: "https://www.coinbase.com/wallet/downloads" },
];
// a phone browser (Safari, Chrome) has no wallet inside it: these links open this same page in the wallet app's own browser
const OPEN_IN = [
  { name: "MetaMask", href: () => `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.hash}` },
  { name: "Coinbase Wallet", href: () => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}` },
  { name: "OKX Wallet", href: () => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(location.href)}` },
];
const onPhone = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(hover: hover)").matches;
export function openConnect() {
  return new Promise((resolve) => {
    const list = available();
    const body = h("div", {},
      list.length
        ? h("div", { class: "wl" }, list.map((d) => h("button", { class: "wl-item", type: "button", onclick: async () => {
            try { await connectWith(d); m.close(); toast(`Connected ${short(wallet.address)}`, "ok"); resolve(wallet); }
            catch (e) { toast(e?.message?.includes("rejected") ? "Request cancelled in the wallet." : (e.message || "Could not connect"), "error"); }
          } }, walletLogo(d.info.name, d.info.icon), h("span", {}, d.info.name || "Browser wallet"), h("em", {}, "Detected"))))
        : onPhone()
          ? h("div", {}, h("div", { class: "wl" }, OPEN_IN.map((k) => h("a", { class: "wl-item", href: k.href(), rel: "noopener" }, walletLogo(k.name), h("span", {}, `Open in ${k.name}`), h("em", {}, "App")))),
              h("p", { class: "note" }, "This browser has no wallet inside it. Each link opens this page in the wallet app's own browser, where Connect works. No wallet app yet? Install one from your app store first."))
          : h("div", {}, h("div", { class: "wl" }, KNOWN.map((k) => h("a", { class: "wl-item", href: k.install, target: "_blank", rel: "noopener" }, walletLogo(k.name), h("span", {}, k.name), h("em", {}, "Install")))),
            h("p", { class: "note" }, "No browser wallet was found. Install one, reload this page, then connect.")),
      h("p", { class: "note" }, "Troya never holds your wallet's key. You approve every transaction in the wallet itself."));
    const m = modal({ title: "Connect a wallet", body, onClose: () => resolve(wallet.address ? wallet : null) });
  });
}
