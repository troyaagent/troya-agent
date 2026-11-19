// V8 F42 Herald: a referral code from the link (troya.codes/agent?ref=CODE, or #/…?ref=CODE) is kept in this browser
// and sent once, after the wallet signs in. The first link wins; the server refuses a wallet's own code.
import { wallet, onWallet } from "./wallet.js";
import { api } from "./api.js";

const KEY = "troya.ref";
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: nothing kept */ } };

(function capture() {
  const u = new URL(location.href);
  const [hp, hq = ""] = location.hash.split("?");
  const hs = new URLSearchParams(hq);
  const code = String(u.searchParams.get("ref") || hs.get("ref") || "").trim().toLowerCase();
  if (/^[a-z0-9]{4,12}$/.test(code) && !read()) write({ code, at: Date.now(), sent: false });
  // the address bar keeps the page, not the code
  if (u.searchParams.has("ref") || hs.has("ref")) {
    u.searchParams.delete("ref"); hs.delete("ref");
    const hash = hp ? `${hp}${hs.toString() ? `?${hs}` : ""}` : "";
    history.replaceState(null, "", `${u.pathname}${u.search}${hash}`);
  }
})();

let busy = false;
async function send() {
  const r = read();
  if (!r || r.sent || busy || !wallet.session) return;
  busy = true;
  try {
    const out = await api.post("herald/attach", { code: r.code });
    write({ ...r, sent: true, result: out?.already ? "already" : "joined" });
  } catch (e) {
    // a code that does not exist or is the wallet's own is dropped; a network error or an expired session tries again later
    if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) write({ ...r, sent: true, result: "refused" });
  } finally { busy = false; }
}
onWallet(() => { send(); });
