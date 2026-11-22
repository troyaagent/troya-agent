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

// rpcs: the RPCs a wallet is given when it adds the network (wallet_addEthereumChain). MetaMask keeps only the first, so the
// first must answer everywhere: the official Robinhood RPC is blocked by some ISPs (in Indonesia its name resolves to a block
// page), so a public node goes first, then the official RPC, then Troya's relay (the same /api/rpc/robinhood the app reads
// through: standard JSON-RPC with a read and send allowlist, and failover across several upstreams). Each was checked to
// answer eth_chainId 0x1237. rpc (the first) is the one shown to copy on the Bridge page. The app itself reads through relay.
export const CHAINS = {
  robinhood: { key: "robinhood", id: 4663, hex: "0x1237", name: "Robinhood Chain", rpcs: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com", "https://troya.codes/api/rpc/robinhood"], relay: "/api/rpc/robinhood", currency: "ETH", explorer: "https://robinhoodchain.blockscout.com" },
  arbitrum: { key: "arbitrum", id: 42161, hex: "0xa4b1", name: "Arbitrum One", rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"], relay: "/api/rpc/arbitrum", currency: "ETH", explorer: "https://arbiscan.io" },
  base: { key: "base", id: 8453, hex: "0x2105", name: "Base", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], relay: "/api/rpc/base", currency: "ETH", explorer: "https://basescan.org" },
  ethereum: { key: "ethereum", id: 1, hex: "0x1", name: "Ethereum", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], relay: "/api/rpc/ethereum", currency: "ETH", explorer: "https://etherscan.io" },
};
for (const c of Object.values(CHAINS)) c.rpc = c.rpcs[0];
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

/* ---------- WalletConnect (phone wallets) ---------- */
// The option appears only when the server has a WalletConnect projectId (WALLETCONNECT_PROJECT_ID, served at
// /api/walletconnect). walletconnect.js and the provider bundle load only when the visitor picks it, or on a reload after a
// WalletConnect session, so a visitor with a browser wallet never downloads them. A failed config read is forgotten.
const WC = "walletconnect";
export const WC_ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#3396FF"/><path fill="#fff" d="M4.49 5.77a5 5 0 0 1 7.02 0l.23.22a.24.24 0 0 1 0 .35l-.8.78a.13.13 0 0 1-.17 0l-.32-.31a3.47 3.47 0 0 0-4.9 0l-.34.33a.13.13 0 0 1-.17 0l-.8-.78a.24.24 0 0 1 0-.34zm8.67 1.61.71.7a.24.24 0 0 1 0 .34l-3.2 3.14a.25.25 0 0 1-.35 0L8.04 9.33a.06.06 0 0 0-.08 0l-2.27 2.23a.25.25 0 0 1-.35 0L2.13 8.42a.24.24 0 0 1 0-.34l.71-.7a.25.25 0 0 1 .35 0l2.27 2.23a.06.06 0 0 0 .09 0l2.27-2.23a.25.25 0 0 1 .35 0l2.27 2.23a.06.06 0 0 0 .09 0l2.27-2.23a.25.25 0 0 1 .35 0z"/></svg>');
let wcCfg = null, wcMod = null;
function wcConfig() {
  return (wcCfg ||= api.get("walletconnect").then((c) => (/^[0-9a-f]{32}$/i.test(c?.projectId || "") ? c : null), () => { wcCfg = null; return null; }));
}
const loadWc = () => (wcMod ||= import("./walletconnect.js").catch((e) => { wcMod = null; throw e; }));
const isWc = (eip) => !!eip?.isWalletConnect;

const bound = new WeakSet();
function bind(eip) {
  if (bound.has(eip)) return;                   // the WalletConnect provider lives for the page: one set of listeners
  bound.add(eip);
  eip.on?.("accountsChanged", async (accs) => {
    if (wallet.eip !== eip) return;             // an event from a wallet that is no longer the connected one
    // WalletConnect reports no account while its default chain is one the phone wallet did not approve; the end of its
    // session comes as "disconnect" below, so only an injected wallet's empty list means it disconnected
    if (!accs?.length) { if (!isWc(eip)) disconnect(); return; }
    // the same account announced again (WalletConnect does on chain switches): nothing changes, the session stays
    if (String(accs[0]).toLowerCase() === wallet.address?.toLowerCase()) return;
    // the old address and its session go at once, before the checksum (a short await) gives the new one
    wallet.session = null;
    let a;
    try { a = await checksum(accs[0]); } catch { disconnect(); return; }
    if (wallet.eip !== eip) return;             // disconnected or switched wallets meanwhile
    wallet.address = a;
    emit();
    refreshSession();
  });
  eip.on?.("chainChanged", (hex) => { if (wallet.eip !== eip) return; wallet.chainId = Number(hex); emit(); });
  // the phone wallet ended the session (or WalletConnect expired it): this browser lets go too. An injected wallet's
  // "disconnect" only means it lost its own RPC, so it is not listened to.
  if (isWc(eip)) eip.on?.("disconnect", () => { if (wallet.eip === eip) disconnect(); });
}

// Resolves once the address is known and the session check has answered, so the connect sheet can tell whether this
// browser is already signed in for the address (then no signature is asked for).
export async function connectWith(detail) {
  const eip = detail.provider;
  // ethers loads while the wallet shows its own prompt, so the checksum below does not add a wait
  const [accs] = await Promise.all([eip.request({ method: "eth_requestAccounts" }), loadEthers()]);
  if (!accs?.length) throw new Error("The wallet shared no account.");
  const before = wallet.eip;
  wallet.eip = eip;
  wallet.info = detail.info;
  wallet.address = E.getAddress(accs[0]);
  wallet.chainId = Number(await eip.request({ method: "eth_chainId" }));
  wallet.status = "connected";
  last.set(detail.info.rdns || detail.info.name);
  bind(eip);
  // moving from a phone wallet to a browser wallet ends the WalletConnect session, so it does not linger in the phone app
  if (before !== eip && isWc(before) && before.session) before.disconnect().catch(() => {});
  emit();
  await refreshSession();
  return wallet;
}

// silent reconnect if the user connected before and the wallet still authorises us
export async function restore() {
  const want = last.get();
  if (!want) return;
  if (want === WC) return restoreWc();
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
// a WalletConnect session lives in this browser's storage (WalletConnect keeps it for up to 7 days): picked up without a
// prompt. No session any more (ended on the phone, expired): the reminder is cleared and nothing loads on the next visit.
async function restoreWc() {
  try {
    const cfg = await wcConfig();
    if (!cfg) return;                           // not offered right now (or the config did not load): kept for the next visit
    const wc = await loadWc();
    const p = await wc.restoreSession(cfg, CHAINS);
    if (!p) { if (last.get() === WC) last.set(null); return; }
    const a = await checksum(p.accounts[0]);
    if (wallet.address) return;                 // the user connected by hand while this was loading
    wallet.eip = p;
    wallet.info = wc.infoOf(p);
    wallet.address = a;
    wallet.chainId = Number(await p.request({ method: "eth_chainId" }));
    wallet.status = "connected";
    bind(p);
    emit();
    refreshSession();
  } catch {}
}

export function disconnect() {
  const eip = wallet.eip;
  wallet.status = "disconnected";
  wallet.address = null;
  wallet.eip = null;
  wallet.session = null;
  last.set(null);
  // a WalletConnect session is ended on the phone too, so it does not stay in the wallet's list of connected sites
  if (isWc(eip)) { if (eip.session) eip.disconnect().catch(() => {}); wcMod?.then((wc) => wc.forgetDeepLink(), () => {}); }
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
  // A WalletConnect session signs only on the chains the phone wallet approved when it connected. For another chain the
  // wallet is asked to add the network (name, RPCs, explorer); a wallet that then adds it to the session carries on. A
  // switch to a chain outside the session would leave the provider with no account, and WalletConnect would refuse the
  // request anyway, with a message nobody could act on.
  if (isWc(wallet.eip)) {
    const wc = await loadWc();
    if (!wc.approved(wallet.eip, c.id)) {
      await addChain(key);
      for (let i = 0; i < 8 && !wc.approved(wallet.eip, c.id); i++) await new Promise((r) => setTimeout(r, 250));
      if (!wc.approved(wallet.eip, c.id))
        throw new Error(`Your phone wallet did not approve ${c.name} for this connection. Add ${c.name} in the wallet app, then disconnect and connect again.`);
    }
  }
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
    chainId: c.hex, chainName: c.name, nativeCurrency: { name: c.currency, symbol: c.currency, decimals: 18 }, rpcUrls: c.rpcs, ...(c.explorer ? { blockExplorerUrls: [c.explorer] } : {}),
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
  signer.sendUncheckedTransaction = async (tx) => {
    const t = { ...tx, chainId: CHAINS[key].id };
    return send(key === "robinhood" ? { ...t, ...(await robinhoodGas(t, wallet.address)) } : t);
  };
  return signer;
}
// Robinhood Chain (an Arbitrum Orbit chain) costs about 0.02 gwei per gas. Some phone wallets don't know the chain and price
// gas with Ethereum-style defaults: a launch (about 3.5M gas) then "needs" several times the balance and the wallet refuses
// with "make sure you have enough funds" while the balance is plenty (a holder with 0.0024 ETH, 23 Nov 2026). So every
// Robinhood Chain transaction carries the chain's real fee cap (twice the current gas price; only the actual fee is charged)
// and a gas limit estimated here with headroom. Anything the caller already set is kept; if a read fails, the wallet decides.
async function robinhoodGas(tx, from) {
  const p = realReader("robinhood"), out = {};
  if (tx.gasPrice == null && tx.maxFeePerGas == null) {
    try { const gp = BigInt(await p.send("eth_gasPrice", [])); if (gp > 0n) { out.maxFeePerGas = gp * 2n; out.maxPriorityFeePerGas = 0n; } } catch {}
  }
  if (tx.gasLimit == null) {
    try { const g = await p.estimateGas({ from, to: tx.to, data: tx.data, value: tx.value }); out.gasLimit = (g * 125n) / 100n + 20000n; } catch {}
  }
  return out;
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
    const list = available(), phone = onPhone();
    const ac = new AbortController();          // closing the sheet stops a WalletConnect pairing in progress
    let wcRow = null, host = null, note = null;
    // the wallets this browser has, or (none) links into wallet apps on a phone and install links on a computer. The
    // WalletConnect row joins once the server confirms a projectId: under the detected wallets and the app links, and on a
    // computer without a wallet above the install links, since it is the one way in that needs no install.
    function view() {
      host = list.length
        ? h("div", { class: "wl" }, list.map((d) => h("button", { class: "wl-item", type: "button", onclick: () => use(d) }, walletLogo(d.info.name, d.info.icon), h("span", {}, d.info.name || "Browser wallet"), h("em", {}, "Detected"))))
        : phone
          ? h("div", { class: "wl" }, OPEN_IN.map((k) => h("a", { class: "wl-item", href: k.href(dappUrl()), rel: "noopener" }, walletLogo(k.name), h("span", {}, `Open in ${k.name}`), h("em", {}, "App"))))
          : h("div", { class: "wl" }, KNOWN.map((k) => h("a", { class: "wl-item", href: k.install, target: "_blank", rel: "noopener" }, walletLogo(k.name), h("span", {}, k.name), h("em", {}, "Install"))));
      note = list.length ? null : h("p", { class: "note" });
      place();
      return h("div", {}, host, note, h("p", { class: "note" }, "Troya never holds your wallet's key. You approve every transaction in the wallet itself."));
    }
    function place() {
      if (wcRow) { if (list.length || phone) host.append(wcRow); else host.prepend(wcRow); }
      if (note) note.textContent = phone
        ? (wcRow ? "This browser has no wallet inside it. \"Open in\" opens this page in the wallet app's own browser, where Connect works; WalletConnect links the wallet app to this browser instead. No wallet app yet? Install one from your app store first."
          : "This browser has no wallet inside it. Each link opens this page in the wallet app's own browser, where Connect works. No wallet app yet? Install one from your app store first.")
        : (wcRow ? "No browser wallet was found. Scan a code with a wallet app on your phone, or install a browser wallet, reload this page, then connect."
          : "No browser wallet was found. Install one, reload this page, then connect.");
    }
    let closed = false;
    const m = modal({ title: "Connect a wallet", body: view(), onClose: () => { closed = true; ac.abort(); resolve(wallet.address ? wallet : null); } });
    wcConfig().then((cfg) => {
      // inside a wallet app's own browser (a phone with a detected wallet) the wallet is already here
      if (!cfg || closed || (phone && list.length)) return;
      wcRow = h("button", { class: "wl-item", type: "button", onclick: () => pickWc(cfg) }, walletLogo("WalletConnect", WC_ICON),
        h("span", {}, phone ? "Wallet app (WalletConnect)" : "Phone wallet (QR code)"), h("em", {}, phone ? "Link" : "Scan"));
      place();
    });
    async function pickWc(cfg) {
      let wc;
      try { wc = await loadWc(); } catch { if (!closed) toast("WalletConnect could not load. Check your connection and try again.", "error"); return; }
      if (closed) return;
      const d = await wc.pair(cfg, CHAINS, { m, phone, signal: ac.signal, inUse: (p) => wallet.eip === p, icon: WC_ICON });
      if (closed) return;
      if (!d) { clear(m.body, view()); return; }   // Back: the wallet list again
      use(d);
    }
    async function use(d) {
      try { await connectWith(d); }
      catch (e) {
        if (closed) return;
        toast(rejected(e) ? "Request cancelled in the wallet." : (e.message || "Could not connect"), "error");
        if (d.info.rdns === WC) clear(m.body, view());
        return;
      }
      if (closed) return;
      // this browser already holds a session for the address: nothing more to sign
      if (wallet.session || !wallet.address) { m.close(); toast(`Connected ${short(wallet.address)}`, "ok"); resolve(wallet); return; }
      if (opts.signIn === false) { m.close(); resolve(wallet); return; }
      proveIt();
    }
    // step two, in the same sheet: a free signature that proves the address is yours (no transaction, no gas)
    function proveIt() {
      const heading = m.box.querySelector(".modal-h h2");
      if (heading) heading.textContent = "Sign in";
      m.box.setAttribute("aria-label", "Sign in");
      // with WalletConnect the prompt is on the phone: a phone wallet's app opens for it (sign-client follows the app the
      // visitor picked), a computer shows nothing, so say where to look
      const where = isWc(wallet.eip) ? (phone ? " Your wallet app opens for it; if it does not, open the app yourself, sign, then come back here." : " Approve it in the wallet app on your phone.") : "";
      const status = h("p", { class: "note", role: "status", "aria-live": "polite" }, "Your wallet is asking for the signature now." + where);
      const later = h("button", { class: "btn ghost", type: "button", onclick: () => m.close() }, "Not now");
      const sign = h("button", { class: "btn primary", type: "button", onclick: () => ask() }, "Sign message");
      clear(m.body,
        h("p", { style: { margin: "0 0 6px", fontSize: "14px" } }, h("b", {}, `Connected ${short(wallet.address)}.`), " One more tap: sign a free message to prove it is you."),
        h("p", { class: "note" }, "It is a message, not a transaction: it costs no gas and moves nothing. It signs you in for chat, the inbox, the Agent Wallet and playbooks in this browser."),
        h("div", { class: "row", style: { justifyContent: "flex-end", flexWrap: "wrap" } }, later, sign),
        status);
      async function ask() {
        sign.disabled = true;
        status.textContent = "Confirm the message in your wallet." + where;
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
