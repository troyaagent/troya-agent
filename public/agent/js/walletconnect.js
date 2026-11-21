// WalletConnect v2 for phone wallets: a QR code on a computer, a link into the wallet app on a phone.
// This module and the provider load only when the visitor picks "Phone wallet" in the connect sheet, or on a reload after
// such a session (wallet.js imports it then). The provider is the official @walletconnect/ethereum-provider at an exact
// version, bundled once and self-hosted under /vendor (about 150 KB gzipped). Its own QR modal (Reown AppKit) is left out
// of the bundle: the code below draws the QR with Troya's qr.js, so nothing comes from a CDN and the page CSP only adds the
// relay socket and the Verify frame (server.mjs, when WALLETCONNECT_PROJECT_ID is set).
// The provider is EIP-1193 like an injected wallet, so wallet.js keeps one path for both: eth_requestAccounts, personal_sign
// for sign-in, eth_signTypedData_v4 (Permit2, Hyperliquid), eth_sendTransaction through ethers' BrowserProvider, and
// wallet_switchEthereumChain / wallet_addEthereumChain in ensureChain. Reads (gas estimates, receipts) go to Troya's relay.
import { h, clear, copyText, walletLogo } from "./ui.js";
import { qrMatrix } from "./qr.js";

const VENDOR = "/vendor/walletconnect/ethereum-provider-2.26.0.mjs";
// sign-client reads this key before each request and, on a phone, opens the wallet app at that link so the visitor does not
// have to switch apps by hand for every signature. It is set only on a phone, when the visitor taps one of the apps below.
const DEEPLINK = "WALLETCONNECT_DEEPLINK_CHOICE";
// links that open the wallet app at the pairing request ("/wc?uri=…"); the universal ones open the app store when it is missing
const APPS = [
  { name: "MetaMask", href: "https://metamask.app.link" },
  { name: "Trust Wallet", href: "https://link.trustwallet.com" },
  { name: "Rainbow", href: "https://rnbwapp.com" },
  { name: "OKX Wallet", href: "okex://main" },
];
const remember = (app) => { try { app ? localStorage.setItem(DEEPLINK, JSON.stringify({ href: app.href, name: app.name })) : localStorage.removeItem(DEEPLINK); } catch {} };
export const forgetDeepLink = () => remember(null);
export const deepLinkName = () => { try { return JSON.parse(localStorage.getItem(DEEPLINK) || "null")?.name || ""; } catch { return ""; } };

// One provider per page: it holds the relay socket and the session (kept in IndexedDB by WalletConnect, so a reload finds it).
// A failed load or init (a 502 during a deploy, no network) is forgotten, so the next attempt starts over.
let mod = null, prov = null;
function provider(cfg, chains) {
  return (prov ||= (async () => {
    const { EthereumProvider } = await (mod ||= import(VENDOR).catch((e) => { mod = null; throw e; }));
    const list = Object.values(chains);
    return EthereumProvider.init({
      projectId: cfg.projectId,
      // Robinhood Chain first, so it is the default chain of a new session. Every chain is optional (WalletConnect turns
      // required chains into optional ones anyway), so a wallet that lacks one still connects; ensureChain then asks it to
      // switch, or to add the network with its name, RPCs and explorer, and stops before signing on a chain it did not approve.
      optionalChains: list.map((c) => c.id),
      rpcMap: Object.fromEntries(list.map((c) => [c.id, new URL(c.relay, location.origin).href])),
      showQrModal: false,
      telemetryEnabled: false,
      metadata: {
        name: "Troya Agent",
        description: "Trade, launch and swap on Robinhood Chain, Base and Arbitrum. You approve every transaction in your wallet.",
        url: location.origin,
        icons: [new URL("/img/favicon-192.png", location.origin).href],
      },
      // only a test relay on this machine may replace WalletConnect's own
      ...(/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(cfg.relayUrl || "") ? { relayUrl: cfg.relayUrl } : {}),
    });
  })().catch((e) => { prov = null; throw e; }));
}

// The wallet as the connect sheet and the account menu show it: the phone wallet's own name and icon, from the session.
export function infoOf(p) {
  const md = p?.session?.peer?.metadata || {};
  const icon = (md.icons || []).find((u) => /^https:\/\//.test(String(u))) || "";
  return { uuid: "walletconnect", rdns: "walletconnect", name: md.name ? `${String(md.name).slice(0, 40)} (WalletConnect)` : "WalletConnect", icon };
}
// the chains the phone wallet approved for this session (a request on any other is refused by WalletConnect itself)
export function approved(p, chainId) {
  const ns = p?.session?.namespaces?.eip155;
  return [...(ns?.accounts || []), ...(ns?.chains || [])].some((a) => { const [n, id] = String(a).split(":"); return n === "eip155" && id === String(chainId); });
}

// A session from an earlier visit, or null. Nothing is shown and nothing is asked of the wallet.
export async function restoreSession(cfg, chains) {
  const p = await provider(cfg, chains);
  return p.session && p.accounts?.length ? p : null;
}

/* ---------- pairing, inside the connect sheet ---------- */
// Resolves { info, provider } once the wallet approves, or null when the visitor goes back or closes the sheet.
// inUse(p) tells whether wallet.js is connected through this provider: a late approval (the visitor scanned, then closed the
// sheet) is ended at once instead of staying connected in the background.
export function pair(cfg, chains, { m, phone, signal, inUse, icon }) {
  return new Promise((resolve) => {
    let done = false, attempt = 0, p = null, timer = 0;
    const heading = m.box.querySelector(".modal-h h2"), title0 = heading?.textContent || "Connect a wallet";
    const title = (t) => { if (heading) heading.textContent = t; m.box.setAttribute("aria-label", t); };
    const onUri = (uri) => { if (!done) { clearTimeout(timer); show(String(uri)); } };
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p?.removeListener?.("display_uri", onUri);
      signal.removeEventListener("abort", onAbort);
      if (!v) title(title0);
      resolve(v);
    };
    const onAbort = () => finish(null);
    if (signal.aborted) { resolve(null); return; }
    signal.addEventListener("abort", onAbort);

    const stage = h("div", { style: { display: "grid", gap: "10px", justifyItems: "center", minHeight: "120px", alignContent: "center" } });
    const status = h("p", { class: "note", role: "status", "aria-live": "polite", style: { textAlign: "center" } });
    let link = "";
    const copy = h("button", { class: "btn", type: "button", hidden: true, onclick: () => link && copyText(link, "Link copied") }, "Copy link");
    const again = h("button", { class: "btn primary", type: "button", hidden: true, onclick: () => start() }, "New code");
    const back = h("button", { class: "btn ghost", type: "button", onclick: () => finish(null) }, "Back");
    clear(m.body, stage, status, h("div", { class: "row", style: { justifyContent: "flex-end", flexWrap: "wrap", gap: "8px" } }, back, copy, again));
    title(phone ? "Open your wallet app" : "Scan with your phone");

    function show(uri) {
      link = uri;
      copy.hidden = false;
      again.hidden = true;
      if (phone) {
        clear(stage,
          h("div", { class: "wl", style: { width: "100%" } },
            APPS.map((a) => h("a", { class: "wl-item", href: `${a.href}/wc?uri=${encodeURIComponent(uri)}`, rel: "noopener", onclick: () => remember(a) },
              walletLogo(a.name), h("span", {}, a.name), h("em", {}, "Open"))),
            h("a", { class: "wl-item", href: uri, rel: "noopener", onclick: () => remember(null) }, walletLogo("WalletConnect", icon), h("span", {}, "Other wallet app"), h("em", {}, "Open"))),
          h("p", { class: "note", style: { margin: 0 } }, "Approve the connection in the wallet app, then come back to this page. Wallet not listed? Tap Other wallet app, or copy the link into the wallet's WalletConnect field."));
        status.textContent = "Waiting for the wallet to approve.";
      } else {
        const code = qrBox(uri);
        clear(stage,
          code || h("div", { class: "alert warn" }, "This code could not be drawn. Copy the link and paste it into your wallet's WalletConnect field."),
          h("p", { class: "note", style: { margin: 0, textAlign: "center", maxWidth: "320px" } },
            "Open a wallet app on your phone (MetaMask, Trust Wallet, Rainbow, OKX and most others), tap its scan button and point it at this code."));
        status.textContent = "Waiting for the wallet to approve. The code works for 5 minutes.";
      }
    }
    function fail(text) {
      if (done) return;
      clearTimeout(timer);
      link = "";
      copy.hidden = true;
      again.hidden = false;
      clear(stage, h("div", { class: "alert warn", role: "alert", style: { width: "100%" } }, text));
      status.textContent = "";
    }
    async function start() {
      const mine = ++attempt;
      again.hidden = true;
      copy.hidden = true;
      clear(stage, h("div", { "aria-hidden": "true", style: { width: "232px", height: "232px", borderRadius: "12px", background: "var(--bg-2, #f2f2f2)" } }));
      status.textContent = "Making a secure code.";
      // a desktop session never opens wallet links by itself; a phone remembers the app the visitor taps below
      if (!phone) remember(null);
      try { p = await provider(cfg, chains); }
      catch { if (mine === attempt) fail("WalletConnect could not load. Check your connection and try again."); return; }
      if (done || mine !== attempt) return;
      p.removeListener("display_uri", onUri);
      p.on("display_uri", onUri);
      // a session left over from an earlier visit that is not the connected wallet (wallet.js restores a live one): end it,
      // so this code starts a fresh session with the wallet the visitor scans now
      if (p.session && !inUse(p)) await Promise.race([p.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      if (done || mine !== attempt) return;
      timer = setTimeout(() => { if (mine === attempt) fail("WalletConnect did not answer. Check your connection and try again."); }, 20_000);
      p.connect().then(() => {
        if (done || mine !== attempt) { if (!inUse(p)) p.disconnect().catch(() => {}); return; }
        if (!p.accounts?.length) { fail("The wallet shared no account. Try again, or pick another wallet."); return; }
        finish({ info: infoOf(p), provider: p });
      }, (e) => { if (!done && mine === attempt) fail(why(e)); });
    }
    start();
  });
}

function why(e) {
  const t = String(e?.message || e || "");
  if (/expired/i.test(t)) return "This code expired. Make a new one and scan it within 5 minutes.";
  if (/reject|denied|declin/i.test(t)) return "The wallet declined the connection. Make a new code to try again.";
  if (/project|unauthori[sz]ed|invalid key|forbidden|origin/i.test(t)) return "WalletConnect is not available on this site right now. Use a browser wallet instead.";
  return "Could not reach WalletConnect. Check your connection and try again.";
}

// The pairing link as a QR code: dark modules on white with a four-module quiet zone, whatever the page theme, so phone
// cameras read it in dark mode too. qr.js goes up to version 10 (213 bytes); a WalletConnect link is about 190.
function qrBox(text) {
  let q;
  try { q = qrMatrix(text); } catch { return null; }
  const NS = "http://www.w3.org/2000/svg", n = q.size + 8;
  let d = "";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("width", "232");
  svg.setAttribute("height", "232");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "WalletConnect QR code");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(n));
  bg.setAttribute("height", String(n));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return h("div", { "data-wc-qr": "", style: { width: "232px", height: "232px", borderRadius: "12px", overflow: "hidden", background: "#fff", lineHeight: 0 } }, svg);
}
