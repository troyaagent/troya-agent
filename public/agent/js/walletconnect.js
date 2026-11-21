// WalletConnect v2 for phone wallets: a QR code on a computer, a link into the wallet app on a phone.
// This module and the provider load only when the visitor picks "Phone wallet" in the connect sheet, or on a reload after
// such a session (wallet.js imports it then). The provider is the official @walletconnect/ethereum-provider at an exact
// version, bundled once and self-hosted under /vendor (about 150 KB gzipped). Its own QR modal (Reown AppKit) is left out
// of the bundle: the code below draws the QR with Troya's qr.js, so nothing comes from a CDN and the page CSP only adds the
// relay socket and the Verify frame (server.mjs, when WALLETCONNECT_PROJECT_ID is set).
// The provider is EIP-1193 like an injected wallet, so wallet.js keeps one path for both: eth_requestAccounts, personal_sign
// for sign-in, eth_signTypedData_v4 (Permit2, Hyperliquid), eth_sendTransaction through ethers' BrowserProvider, and
// wallet_switchEthereumChain / wallet_addEthereumChain in ensureChain. Reads (gas estimates, receipts) go to Troya's relay.
import { h, clear, copyText, walletLogo, logoUrl } from "./ui.js";
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
// Wallet marks, self-hosted: the ones the connect sheet already shows (/img/logos) and the official WalletConnect, Trust
// Wallet and Rainbow marks in /img/wallets. WC_MARK is WalletConnect's blue logo from its brand kit (480 × 332).
const WL = "/img/wallets/", WC_MARK = WL + "walletconnect.svg";
const LOGO = {
  "MetaMask": logoUrl("wallet", "metamask"), "Trust Wallet": WL + "trust.svg", "Rainbow": WL + "rainbow.svg",
  "OKX Wallet": logoUrl("wallet", "okx"), "Coinbase Wallet": logoUrl("wallet", "coinbase"),
};
// the apps shown under the QR code: each scans WalletConnect codes, as do most other wallet apps
const SCANS = [["MetaMask", "MetaMask"], ["Trust Wallet", "Trust"], ["Rainbow", "Rainbow"], ["OKX Wallet", "OKX"], ["Coinbase Wallet", "Coinbase"]];
function appLogo(name, size = 26) {
  if (!LOGO[name]) return walletLogo(name, null, size);
  const img = h("img", { src: LOGO[name], alt: "", decoding: "async", width: size, height: size });
  const box = h("span", { class: "wallet-logo has-img", title: name, style: { width: `${size}px`, height: `${size}px` } }, img);
  img.onerror = () => box.replaceWith(walletLogo(name, null, size));
  return box;
}
// the pairing view's own styles, added once (the page CSP allows inline styles)
function css() {
  if (document.getElementById("wc-css")) return;
  document.head.append(h("style", { id: "wc-css" }, `
.wc-stage { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; justify-items: center; }
.wc-card { max-width: 100%; border-radius: 18px; background: #fff; line-height: 0;
  box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 24px 60px -26px rgba(51,150,255,.6); }
html[data-theme="light"] .wc-card { box-shadow: 0 0 0 1px var(--line-2), 0 20px 44px -26px rgba(51,150,255,.5); }
.wc-card svg { display: block; width: 100%; height: auto; border-radius: 18px; }
.wc-wait { width: 324px; max-width: 100%; aspect-ratio: 1; border-radius: 18px; }
.wc-hint { margin: 0; max-width: 340px; text-align: center; font-size: 13px; line-height: 1.45; color: var(--fg-2); }
.wc-works { width: 100%; display: grid; gap: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
.wc-works > span { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; text-align: center; color: var(--muted); }
.wc-apps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin: 0; padding: 0; list-style: none; }
.wc-apps li { display: grid; justify-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--fg-2); }
.wc-apps li > span:last-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 400px) { .wc-apps li { font-size: 10px; } }
.wc-more { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 7px; border: 1px dashed var(--line-3); color: var(--muted); font-size: 15px; line-height: 1; }
.wc-status { margin-top: 16px; text-align: center; }
.wc-dot { display: inline-block; width: 7px; height: 7px; margin: 0 8px 1px 0; vertical-align: middle; border-radius: 50%; background: #3396ff; animation: wc-pulse 1.6s infinite; }
@keyframes wc-pulse { 0% { box-shadow: 0 0 0 0 rgba(51,150,255,.55); } 70%, 100% { box-shadow: 0 0 0 7px rgba(51,150,255,0); } }
@media (prefers-reduced-motion: reduce) { .wc-dot { animation: none; } }
.wc-title { display: inline-flex; align-items: center; gap: 9px; }
.wc-title img { width: 22px; height: auto; }
`));
}
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
    // the WalletConnect mark leads the heading while a code is up; Back puts the plain heading back
    const title = (t, mark = false) => {
      if (heading) heading.replaceChildren(mark ? h("span", { class: "wc-title" }, h("img", { src: WC_MARK, alt: "", width: 22, height: 15 }), t) : t);
      m.box.setAttribute("aria-label", t);
    };
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

    css();
    const stage = h("div", { class: "wc-stage", style: { minHeight: "120px", alignContent: "center" } });
    const status = h("p", { class: "note wc-status", role: "status", "aria-live": "polite" });
    // the status line, with a pulsing dot while the code waits for the wallet
    const say = (text, waiting = false) => status.replaceChildren(...(waiting ? [h("span", { class: "wc-dot", "aria-hidden": "true" })] : []), text);
    let link = "";
    const copy = h("button", { class: "btn", type: "button", hidden: true, onclick: () => link && copyText(link, "Link copied") }, "Copy link");
    const again = h("button", { class: "btn primary", type: "button", hidden: true, onclick: () => start() }, "New code");
    const back = h("button", { class: "btn ghost", type: "button", onclick: () => finish(null) }, "Back");
    clear(m.body, stage, status, h("div", { class: "row", style: { justifyContent: "flex-end", flexWrap: "wrap", gap: "8px", marginTop: "12px" } }, back, copy, again));
    title(phone ? "Open your wallet app" : "Scan with WalletConnect", !phone);

    function show(uri) {
      link = uri;
      copy.hidden = false;
      again.hidden = true;
      if (phone) {
        clear(stage,
          h("div", { class: "wl", style: { width: "100%" } },
            APPS.map((a) => h("a", { class: "wl-item", href: `${a.href}/wc?uri=${encodeURIComponent(uri)}`, rel: "noopener", onclick: () => remember(a) },
              appLogo(a.name), h("span", {}, `Open in ${a.name}`))),
            h("a", { class: "wl-item", href: uri, rel: "noopener", onclick: () => remember(null) }, walletLogo("WalletConnect", icon), h("span", {}, "Other wallet app"))),
          h("p", { class: "note", style: { margin: 0 } }, "Approve the connection in the wallet app, then come back to this page. Wallet not listed? Tap Other wallet app, or copy the link into the wallet's WalletConnect field."));
        say("Waiting for the wallet to approve.", true);
      } else {
        const code = qrCode(uri);
        clear(stage,
          code || h("div", { class: "alert warn" }, "This code could not be drawn. Copy the link and paste it into your wallet's WalletConnect field."),
          h("p", { class: "wc-hint" }, "Open a wallet app on your phone, tap its scan button and point the camera at this code."),
          h("div", { class: "wc-works" },
            h("span", {}, "Works with"),
            h("ul", { class: "wc-apps" },
              SCANS.map(([name, label]) => h("li", { title: name }, appLogo(name, 30), h("span", {}, label))),
              h("li", { title: "Most other wallet apps with a WalletConnect scanner" }, h("span", { class: "wc-more", "aria-hidden": "true" }, "+"), h("span", {}, "Others")))));
        say("Waiting for the wallet to approve. The code works for 5 minutes.", true);
      }
    }
    function fail(text) {
      if (done) return;
      clearTimeout(timer);
      link = "";
      copy.hidden = true;
      again.hidden = false;
      clear(stage, h("div", { class: "alert warn", role: "alert", style: { width: "100%" } }, text));
      say("");
    }
    async function start() {
      const mine = ++attempt;
      again.hidden = true;
      copy.hidden = true;
      clear(stage, phone ? h("div", { "aria-hidden": "true", class: "sk", style: { width: "100%", height: "160px", borderRadius: "8px" } })
        : h("div", { "aria-hidden": "true", class: "sk wc-wait" }));
      say("Making a secure code.");
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
// cameras read it in dark mode too. It is drawn at error correction level H (up to about 30% of the code may be lost), so
// the WalletConnect mark can sit in the middle: a white rounded tile over a square of 15 modules (about a fifth of the
// width, 4% of the area) that stops short of the alignment patterns. A WalletConnect link (187 to about 220 bytes) is a
// version 14 or 15 code, 73 or 77 modules, drawn at whole pixels per module so every module is crisp.
// Exported for the scan tests; { logo: false } draws the same code without the mark.
export function qrCode(text, { logo = true, ecl = "H" } = {}) {
  let q;
  try { q = qrMatrix(text, { ecl }); } catch { return null; }
  const NS = "http://www.w3.org/2000/svg", Z = 4, S = q.size, n = S + 2 * Z;
  const px = Math.max(2, Math.min(6, Math.floor(360 / n))) * n;
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

  // the tile: centred on the middle module, an odd number of modules wide, ending where the nearest alignment pattern begins
  const c = (S - 1) / 2;
  let half = logo ? Math.floor(S * 0.11) : 0;
  for (const a of q.align) { const d = Math.abs(a - c); if (d >= 3) half = Math.min(half, d - 3); }
  if (half < 4) half = 0;                          // too small a code for a mark
  const t0 = c - half, t1 = c + half + 1, R = 2.5;  // tile edges and corner radius, in modules
  const inTile = (x, y) => { const cx = Math.min(Math.max(x, t0 + R), t1 - R), cy = Math.min(Math.max(y, t0 + R), t1 - R); return (x - cx) ** 2 + (y - cy) ** 2 <= R * R + 1e-9; };
  const hidden = (x, y) => half > 0 && inTile(x, y) && inTile(x + 1, y) && inTile(x, y + 1) && inTile(x + 1, y + 1);
  // the three finder patterns are drawn as rounded eyes below, the other dark modules as runs along each row
  const eye = (x, y) => (x < 7 || x >= S - 7) && y < 7 || x < 7 && y >= S - 7;
  let d = "";
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!q.dark(x, y) || eye(x, y) || hidden(x, y)) continue;
      let w = 1;
      while (x + w < S && q.dark(x + w, y) && !eye(x + w, y) && !hidden(x + w, y)) w++;
      d += `M${x + Z} ${y + Z}h${w}v1h${-w}z`;
      x += w - 1;
    }
  }
  const rr = (x, y, w, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${w - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - w}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  let eyes = "";
  for (const [x, y] of [[Z, Z], [Z + S - 7, Z], [Z, Z + S - 7]]) eyes += rr(x, y, 7, 2) + rr(x + 1, y + 1, 5, 1.2) + rr(x + 2, y + 2, 3, 0.9);

  const svg = el("svg", { viewBox: `0 0 ${n} ${n}`, width: px, height: px, role: "img", "aria-label": "WalletConnect QR code" });
  svg.append(el("rect", { width: n, height: n, fill: "#fff" }),
    el("path", { d, fill: "#000", "shape-rendering": "crispEdges" }),
    el("path", { d: eyes, fill: "#000", "fill-rule": "evenodd" }));
  if (half) {
    const w = t1 - t0, mw = w * 0.64, mh = mw * 332 / 480;
    svg.append(el("rect", { x: t0 + Z, y: t0 + Z, width: w, height: w, rx: R, fill: "#fff" }),
      el("image", { href: WC_MARK, x: c + 0.5 + Z - mw / 2, y: c + 0.5 + Z - mh / 2, width: mw, height: mh }));
  }
  return h("div", { class: "wc-card", "data-wc-qr": q.version, style: { width: `${px}px` } }, svg);
}
