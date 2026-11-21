// Wallet layer: EIP-6963 discovery, connect, chain switching, read providers via our RPC relay, sign-in.
import { h, clear, modal, toast, short, store, walletLogo } from "./ui.js";
import { api } from "./api.js";

// ethers (about 160 KB over the wire) loads on first need: a connect, a chain read or a signer. Every page imports this
// module, so a static import made a read-only visitor wait on it before the first page could even start loading.
// A failed load (a 502 during a deploy) is forgotten, so the next attempt fetches it again.
let E = null, eLoad = null;
export function loadEthers() {
  return (eLoad ||= import("ethers").then((m) => (E = m), (e) => { eLoad = null; throw e; }));
}
const checksum = async (a) => (await loadEthers()).getAddress(a);

export const CHAINS = {
  robinhood: { key: "robinhood", id: 4663, hex: "0x1237", name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", relay: "/api/rpc/robinhood", currency: "ETH", explorer: "https://robinhoodchain.blockscout.com" },
  arbitrum: { key: "arbitrum", id: 42161, hex: "0xa4b1", name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", relay: "/api/rpc/arbitrum", currency: "ETH", explorer: "https://arbiscan.io" },
  base: { key: "base", id: 8453, hex: "0x2105", name: "Base", rpc: "https://mainnet.base.org", relay: "/api/rpc/base", currency: "ETH", explorer: "https://basescan.org" },
  ethereum: { key: "ethereum", id: 1, hex: "0x1", name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", relay: "/api/rpc/ethereum", currency: "ETH", explorer: "https://etherscan.io" },
};
export const chainById = (id) => Object.values(CHAINS).find((c) => c.id === Number(id));

// read-only providers through the same-origin relay (CSP keeps connect-src at 'self')
const readers = {}, standIns = {};
function realReader(chain) {
  const c = CHAINS[chain];
  if (!readers[chain]) readers[chain] = new E.JsonRpcProvider(new URL(c.relay, location.origin).href, { chainId: c.id, name: c.key }, { staticNetwork: true, batchMaxCount: 10 });
  return readers[chain];
}
// reader() stays synchronous for its callers. Once ethers is here it is the real JsonRpcProvider; before that it is a
// stand-in with the same read methods (an ethers Contract accepts it as its runner, since it only needs call), and each
// method loads ethers on first use and hands the call to the real provider. It has no `then`, so it is never awaited
// by mistake, and it has no write methods: sending always goes through signerFor and the user's own wallet.
const READS = ["call", "estimateGas", "getBalance", "getCode", "getStorage", "getTransactionCount", "getTransaction", "getTransactionReceipt",
  "waitForTransaction", "getBlock", "getBlockNumber", "getFeeData", "getLogs", "getNetwork", "resolveName", "lookupAddress", "send"];
export function reader(chain = "robinhood") {
  if (!CHAINS[chain]) throw new Error("Unknown network.");
  if (E) return realReader(chain);
  return (standIns[chain] ||= Object.freeze(Object.fromEntries(READS.map((k) => [k, (...a) => loadEthers().then(() => realReader(chain)[k](...a))]))));
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
  eip.on?.("accountsChanged", async (accs) => {
    if (!accs?.length) { disconnect(); return; }
    // the old address and its session go at once, before the checksum (a short await) gives the new one
    wallet.session = null;
    let a;
    try { a = await checksum(accs[0]); } catch { disconnect(); return; }
    if (wallet.eip !== eip) return;             // disconnected or switched wallets meanwhile
    wallet.address = a;
    emit();
    refreshSession();
  });
  eip.on?.("chainChanged", (hex) => { wallet.chainId = Number(hex); emit(); });
}

// Resolves once the address is known and the session check has answered, so the connect sheet can tell whether this
// browser is already signed in for the address (then no signature is asked for).
export async function connectWith(detail) {
  const eip = detail.provider;
  // ethers loads while the wallet shows its own prompt, so the checksum below does not add a wait
  const [accs] = await Promise.all([eip.request({ method: "eth_requestAccounts" }), loadEthers()]);
  if (!accs?.length) throw new Error("The wallet shared no account.");
  wallet.eip = eip;
  wallet.info = detail.info;
  wallet.address = E.getAddress(accs[0]);
  wallet.chainId = Number(await eip.request({ method: "eth_chainId" }));
  wallet.status = "connected";
  last.set(detail.info.rdns || detail.info.name);
  bind(eip);
  emit();
  await refreshSession();
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
    if (!accs?.length) return;                  // not authorised any more: ethers is never fetched for this visit
    const a = await checksum(accs[0]);
    if (wallet.address) return;                 // the user connected by hand while this was loading
    wallet.eip = d.provider;
    wallet.info = d.info;
    wallet.address = a;
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

// Switches the wallet to `key`, then reads the chain back before anything is signed. A wallet can resolve
// wallet_switchEthereumChain or wallet_addEthereumChain without moving (the network is added but the switch is declined,
// or the request is only acknowledged), and a curve buy, a router call or a bridge must never go out on another network.
const chainNow = async () => Number(await wallet.eip.request({ method: "eth_chainId" }));
const switchTo = (c) => wallet.eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hex }] });
// 4902 is the standard "unknown chain"; MetaMask Mobile wraps it in an internal error
const unknownChain = (e) => e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not been added|unknown chain|not added/i.test(e?.message || "");
export async function ensureChain(key) {
  const c = CHAINS[key];
  if (!c) throw new Error("Unknown network.");
  if (!wallet.eip) throw new Error("Connect a wallet first.");
  if ((await chainNow()) === c.id) return;
  try {
    await switchTo(c);
  } catch (e) {
    if (!unknownChain(e)) throw e;
    await addChain(key);
    // some wallets add the network without moving to it: ask for the switch once more (a refusal shows as a cancel)
    if ((await chainNow()) !== c.id) await switchTo(c);
  }
  // a phone wallet can report the new chain a moment after the request resolves, so give it about a second
  let now = await chainNow();
  for (let i = 0; i < 4 && now !== c.id; i++) { await new Promise((r) => setTimeout(r, 250)); now = await chainNow(); }
  wallet.chainId = now;
  emit();
  if (now !== c.id) throw new Error(`Switch your wallet to ${c.name} to continue.`);
}
export async function addChain(key) {
  const c = CHAINS[key];
  const eip = wallet.eip || available()[0]?.provider;
  if (!eip) throw new Error("No browser wallet found.");
  await eip.request({ method: "wallet_addEthereumChain", params: [{
    chainId: c.hex, chainName: c.name, nativeCurrency: { name: c.currency, symbol: c.currency, decimals: 18 }, rpcUrls: [c.rpc], ...(c.explorer ? { blockExplorerUrls: [c.explorer] } : {}),
  }] });
}

// signer for a chain: switches and checks first, then returns an ethers Signer whose transactions carry that chain's id.
// If the wallet moves to another network between the check and the prompt, it refuses the request instead of signing it
// there. sendTransaction (and every Contract call) goes through sendUncheckedTransaction, so this one override covers all.
export async function signerFor(key) {
  await Promise.all([ensureChain(key), loadEthers()]);
  const provider = new E.BrowserProvider(wallet.eip, "any");
  const signer = await provider.getSigner(wallet.address);
  const send = signer.sendUncheckedTransaction.bind(signer);
  signer.sendUncheckedTransaction = (tx) => send({ ...tx, chainId: CHAINS[key].id });
  return signer;
}

/* ---------- sign-in (session for chat, inbox, agent wallet, playbooks) ---------- */
// The session the server confirmed last, and when. Many buttons run `await openConnect(); await signIn()`, and the sheet
// has just signed in (or found a live session): a second wallet prompt moments later would only confuse. A session older
// than this, or one a page dropped after a 401, is signed for again as before.
let confirmed = null;
const FRESH_MS = 15_000;
async function refreshSession() {
  try { const me = await api.get("me"); wallet.session = me?.address && me.address.toLowerCase() === wallet.address?.toLowerCase() ? me : null; }
  catch { wallet.session = null; }
  if (wallet.session) confirmed = { me: wallet.session, at: Date.now() };
  emit();
}
// One signature at a time: the connect sheet and a page's own Sign in button never open two wallet prompts at once.
let signing = null;
function signMessage() {
  return (signing ||= (async () => {
    const address = wallet.address;
    const { message } = await api.post("auth/nonce", { address });
    const signature = await wallet.eip.request({ method: "personal_sign", params: [toHex(message), address] });
    const me = await api.post("auth/verify", { address, message, signature });
    if (wallet.address !== address) throw new Error("The wallet switched accounts. Sign in again.");
    wallet.session = me;
    confirmed = { me, at: Date.now() };
    emit();
    toast("Signed in", "ok");
    return me;
  })().finally(() => { signing = null; }));
}
export async function signIn() {
  if (!wallet.address) {
    // the connect sheet asks for the sign-in signature itself, right after the wallet connects
    await openConnect();
    if (wallet.session) return wallet.session;
    throw new Error(wallet.address ? "Sign in to continue." : "Connect a wallet to sign in.");
  }
  if (wallet.session && confirmed?.me === wallet.session && Date.now() - confirmed.at < FRESH_MS) return wallet.session;
  return signMessage();
}
const rejected = (e) => e?.code === 4001 || e?.code === "ACTION_REJECTED" || /reject|denied|cancel/i.test(e?.message || "");
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
  { name: "MetaMask", href: (u) => `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}${u.hash}` },
  { name: "Coinbase Wallet", href: (u) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u.href)}` },
  { name: "OKX Wallet", href: (u) => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(u.href)}` },
  { name: "Rabby", href: (u) => `https://go.rabby.io/mobile/?_cmd=open-dapp&dapp=${encodeURIComponent(u.href)}` },
];
// The page to open in the wallet app. The app's browser keeps its own storage, so a referral code that herald-ref.js took
// out of the address bar (and kept in this browser) rides along as ?ref=, or it would never reach sign-in there. It is
// read from storage here rather than imported, because herald-ref.js imports this module.
function dappUrl() {
  const u = new URL(location.href);
  let r = null;
  try { r = JSON.parse(localStorage.getItem("troya.ref") || "null"); } catch { r = null; }
  const code = String(r?.code || "");
  if (r && !r.sent && /^[a-z0-9]{4,12}$/.test(code)) u.searchParams.set("ref", code);
  return u;
}
const onPhone = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(hover: hover)").matches;
// After a first connect the sheet stays open for the sign-in signature, so one flow ends signed in instead of every
// feature asking "Sign in to continue" on its own. openConnect({ signIn: false }) stops at the connect.
export function openConnect(opts = {}) {
  return new Promise((resolve) => {
    const list = available();
    const body = h("div", {},
      list.length
        ? h("div", { class: "wl" }, list.map((d) => h("button", { class: "wl-item", type: "button", onclick: async () => {
            try { await connectWith(d); }
            catch (e) { toast(rejected(e) ? "Request cancelled in the wallet." : (e.message || "Could not connect"), "error"); return; }
            // this browser already holds a session for the address: nothing more to sign
            if (wallet.session || !wallet.address) { m.close(); toast(`Connected ${short(wallet.address)}`, "ok"); resolve(wallet); return; }
            if (opts.signIn === false) { m.close(); resolve(wallet); return; }
            proveIt();
          } }, walletLogo(d.info.name, d.info.icon), h("span", {}, d.info.name || "Browser wallet"), h("em", {}, "Detected"))))
        : onPhone()
          ? h("div", {}, h("div", { class: "wl" }, OPEN_IN.map((k) => h("a", { class: "wl-item", href: k.href(dappUrl()), rel: "noopener" }, walletLogo(k.name), h("span", {}, `Open in ${k.name}`), h("em", {}, "App")))),
              h("p", { class: "note" }, "This browser has no wallet inside it. Each link opens this page in the wallet app's own browser, where Connect works. No wallet app yet? Install one from your app store first."))
          : h("div", {}, h("div", { class: "wl" }, KNOWN.map((k) => h("a", { class: "wl-item", href: k.install, target: "_blank", rel: "noopener" }, walletLogo(k.name), h("span", {}, k.name), h("em", {}, "Install")))),
            h("p", { class: "note" }, "No browser wallet was found. Install one, reload this page, then connect.")),
      h("p", { class: "note" }, "Troya never holds your wallet's key. You approve every transaction in the wallet itself."));
    let closed = false;
    const m = modal({ title: "Connect a wallet", body, onClose: () => { closed = true; resolve(wallet.address ? wallet : null); } });
    // step two, in the same sheet: a free signature that proves the address is yours (no transaction, no gas)
    function proveIt() {
      const heading = m.box.querySelector(".modal-h h2");
      if (heading) heading.textContent = "Sign in";
      m.box.setAttribute("aria-label", "Sign in");
      const status = h("p", { class: "note", role: "status", "aria-live": "polite" }, "Your wallet is asking for the signature now.");
      const later = h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Not now");
      const sign = h("button", { class: "btn primary", type: "button", onclick: () => ask() }, "Sign message");
      clear(m.body,
        h("p", { style: { margin: "0 0 6px", fontSize: "14px" } }, h("b", {}, `Connected ${short(wallet.address)}.`), " One more tap: sign a free message to prove it is you."),
        h("p", { class: "note" }, "It is a message, not a transaction: it costs no gas and moves nothing. It signs you in for chat, the inbox, the Agent Wallet and playbooks in this browser."),
        h("div", { class: "row", style: { justifyContent: "flex-end", flexWrap: "wrap" } }, later, sign),
        status);
      async function ask() {
        sign.disabled = true;
        status.textContent = "Confirm the message in your wallet.";
        try { await signMessage(); if (!closed) m.close(); resolve(wallet); }
        catch (e) {
          if (closed) return;
          sign.disabled = false;
          status.textContent = rejected(e) ? "Signature cancelled in the wallet. Sign when you are ready, or skip it for now." : (e?.message || "Could not sign in. Try again.");
        }
      }
      ask();
    }
  });
}
