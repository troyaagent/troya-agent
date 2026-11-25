// V10 F58 Trident, the Troya Firewall (#/trident): paste a transaction or a signature request before you sign it and get
// allow / warn / block with plain reasons, signed by the Troya attestor. Everything comes from POST /api/trident/check and
// GET /api/trident (server/trident.mjs). Reading only: this page never asks a wallet to sign or send anything.
import { h, clear, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet } from "/agent/js/wallet.js";

const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const PLAIN = "0x1111111111111111111111111111111111111111";   // an address with no code: what a drainer's wallet looks like
const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const MAX = "f".repeat(64);
const EXAMPLES = [
  { k: "approve", t: "Unlimited approval to a plain wallet", tx: { to: TROYA, data: "0x095ea7b3" + pad(PLAIN) + MAX, value: "0" } },
  { k: "sink", t: "Coins sent to the token contract", tx: { to: TROYA, data: "0xa9059cbb" + pad(TROYA) + pad((10n ** 18n).toString(16)), value: "0" } },
  { k: "permit", t: "A Permit signature to a plain wallet", sig: { primaryType: "Permit", domain: { name: "Troya Agent", chainId: 4663, verifyingContract: TROYA }, message: { owner: "0x…you", spender: PLAIN, value: "115792089237316195423570985008687907853269984665640564039457584007913129639935", nonce: 0, deadline: 1999999999 } } },
  { k: "delegate", t: "An EIP-7702 delegation to an unknown contract", tx: { to: PLAIN, data: "0x", value: "0", authorizationList: [{ address: "0x2222222222222222222222222222222222222222", chainId: 4663, nonce: 0 }] } },
];
const LV = { block: "Block", warn: "Careful", allow: "Allow", info: "Note", unsupported: "Not supported" };

function css() {
  if (document.querySelector("style[data-trident]")) return;
  document.head.append(h("style", { "data-trident": "1" }, `
.tr-page { display: grid; gap: 16px; }
.tr-box { padding: 18px; }
.tr-tabs { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line-2); border-radius: 999px; margin-bottom: 12px; }
.tr-tabs button { border: 0; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer; }
.tr-tabs button.on { background: var(--bg-3, var(--bg-2)); color: var(--fg); }
.tr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tr-grid label, .tr-full { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.tr-full { grid-column: 1 / -1; }
.tr-grid input, .tr-grid textarea, .tr-sig { width: 100%; font-family: var(--mono, ui-monospace, monospace); font-size: 12.5px; }
.tr-grid textarea, .tr-sig { min-height: 92px; resize: vertical; }
.tr-sig { min-height: 180px; }
.tr-act { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.tr-ex { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tr-ex small { width: 100%; color: var(--faint); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.tr-res:empty { display: none; }
.tr-v { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--bg-2); border-left: 4px solid var(--muted); }
.tr-v b { font-size: 22px; letter-spacing: -0.01em; }
.tr-v.block { border-left-color: var(--down); } .tr-v.block b { color: var(--down); }
.tr-v.warn { border-left-color: var(--warn); } .tr-v.warn b { color: var(--warn); }
.tr-v.allow { border-left-color: var(--up); } .tr-v.allow b { color: var(--up); }
.tr-v p { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }
.tr-rs { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.tr-rs li { display: grid; grid-template-columns: auto 1fr; gap: 10px; font-size: 13.5px; align-items: baseline; }
.tr-l { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.tr-l.block { color: var(--down); border-color: var(--down); } .tr-l.warn { color: var(--warn); border-color: var(--warn); } .tr-l.info { color: var(--muted); }
.tr-sigd { margin-top: 12px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.tr-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.tr-stats div { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); }
.tr-stats small { display: block; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.tr-stats b { font-size: 20px; font-weight: 600; }
.tr-pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--line-2); margin: 8px 0 0; }
.tr-box h3 { margin: 0 0 8px; font-size: 15px; }
.tr-box ul.tr-what { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 13.5px; }
@media (max-width: 640px) { .tr-grid { grid-template-columns: 1fr; } .tr-stats { grid-template-columns: 1fr 1fr; } }`));
}

export async function mount(view) {
  css();
  let alive = true, mode = "tx";
  const inp = (ph) => h("input", { class: "input", placeholder: ph, spellcheck: "false", autocomplete: "off" });
  const from = inp("0x… the wallet that would sign (optional, enables the dry run)");
  if (wallet.address) from.value = wallet.address;
  const to = inp("0x… contract or wallet the transaction goes to");
  const value = inp("0 (in wei)");
  const data = h("textarea", { class: "input", placeholder: "0x… calldata, as your wallet shows it under Hex or Data", spellcheck: "false" });
  const auth = h("textarea", { class: "input", placeholder: 'Optional, EIP-7702 only: [{"address":"0x…","chainId":4663,"nonce":0}]', spellcheck: "false", rows: "2" });
  const sig = h("textarea", { class: "input tr-sig", placeholder: "Paste the typed data your wallet asks you to sign (eth_signTypedData_v4 JSON: domain, primaryType, message)", spellcheck: "false" });
  const txForm = h("div", { class: "tr-grid" },
    h("label", {}, "From", from), h("label", {}, "To", to),
    h("label", { class: "tr-full" }, "Data", data),
    h("label", {}, "Value (wei)", value), h("label", {}, "EIP-7702 authorizations", auth));
  const sigForm = h("label", { class: "tr-full", hidden: true }, "Signature request", sig);
  const tabTx = h("button", { type: "button", class: "on" }, "Transaction");
  const tabSig = h("button", { type: "button" }, "Signature");
  const setMode = (m) => { mode = m; tabTx.classList.toggle("on", m === "tx"); tabSig.classList.toggle("on", m === "sig"); txForm.hidden = m !== "tx"; sigForm.hidden = m !== "sig"; };
  tabTx.addEventListener("click", () => setMode("tx"));
  tabSig.addEventListener("click", () => setMode("sig"));
  const res = h("div", { class: "tr-res", "aria-live": "polite" });
  const go = h("button", { class: "btn primary", type: "button" }, "Check before signing");
  const clr = h("button", { class: "btn", type: "button" }, "Clear");
  const statsBox = h("div", { class: "tr-stats" });

  function body() {
    if (mode === "sig") {
      let td; try { td = JSON.parse(sig.value); } catch { throw new Error("The signature request is not valid JSON."); }
      if (td && typeof td === "object" && td.params) td = typeof td.params[1] === "string" ? JSON.parse(td.params[1]) : td.params[1];
      return { chainId: 4663, from: from.value.trim() || undefined, typedData: td };
    }
    const b = { chainId: 4663, from: from.value.trim() || undefined, to: to.value.trim(), data: data.value.trim() || "0x", value: value.value.trim() || "0" };
    if (auth.value.trim()) { try { b.authorizationList = JSON.parse(auth.value); } catch { throw new Error("The EIP-7702 authorizations are not valid JSON."); } }
    return b;
  }

  function paint(r) {
    const v = r.verdict;
    clear(res,
      h("div", { class: `tr-v ${v}` }, h("b", {}, LV[v] || v), h("p", {}, r.summary || "")),
      r.reasons?.length ? h("ul", { class: "tr-rs" }, r.reasons.map((x) => h("li", {}, h("span", { class: `tr-l ${x.level}` }, LV[x.level] || x.level), h("span", {}, x.text)))) : null,
      r.coins?.length ? h("p", { class: "fine", style: { marginTop: "10px" } }, "Coins it touches: ", ...r.coins.flatMap((c, i) => [i ? ", " : "", h("a", { class: "link", href: `#/gate/${c.token}` }, c.symbol ? `$${c.symbol}` : c.token), ` (${c.verdict})`])) : null,
      r.signed ? h("div", { class: "tr-sigd" }, "Signed by the Troya attestor ", h("span", { class: "mono" }, r.signed.attestor), h("br"), "hash ", h("span", { class: "mono" }, r.signed.hash), h("br"), "Verify: EIP-191 over \"Troya Trident\" + newline + hash.") : null,
      h("p", { class: "fine", style: { marginTop: "10px" } }, "A snapshot of what Troya reads right now, never a safe stamp. Troya does not see your wallet; nothing was signed or sent."));
  }

  go.addEventListener("click", async () => {
    let b; try { b = body(); } catch (e) { toast(e.message, "error", 5000); return; }
    if (mode === "tx" && !/^0x[0-9a-fA-F]{40}$/.test(b.to)) { toast("Paste the address the transaction goes to (To).", "error", 5000); return; }
    go.disabled = true; clear(res, h("p", { class: "fine" }, "Checking: coins through the Gate, approvals, transfers, delegations and a dry run…"));
    try { const r = await api.post("/api/trident/check", b); if (alive) { paint(r); stats(); } }
    catch (e) { if (alive) clear(res, h("div", { class: "alert error" }, e.message || String(e))); }
    finally { go.disabled = false; }
  });
  clr.addEventListener("click", () => { for (const el of [to, value, data, auth, sig]) el.value = ""; clear(res); });

  const ex = h("div", { class: "tr-ex" }, h("small", {}, "Try a trap"), EXAMPLES.map((e) => {
    const b = h("button", { class: "btn sm", type: "button" }, e.t);
    b.addEventListener("click", () => {
      if (e.sig) { setMode("sig"); sig.value = JSON.stringify(e.sig, null, 2); }
      else { setMode("tx"); to.value = e.tx.to; data.value = e.tx.data; value.value = e.tx.value; auth.value = e.tx.authorizationList ? JSON.stringify(e.tx.authorizationList) : ""; }
      go.click();
    });
    return b;
  }));

  async function stats() {
    try {
      const d = await api.get("/api/trident");
      const s = d.stats || {};
      if (alive) clear(statsBox, [["Checks", s.total], ["Blocked", s.block], ["Careful", s.warn], ["Allowed", s.allow]].map(([k, n]) => h("div", {}, h("small", {}, k), h("b", {}, String(n || 0)))));
    } catch {}
  }

  clear(view, h("div", { class: "dk tr-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Trident · V10 Poseidon"),
      h("h1", {}, "Check it ", h("em", {}, "before"), " you sign."),
      h("p", { class: "dk-sub" }, "Paste any Robinhood Chain transaction or signature request your wallet is asking you to approve. Trident reads every coin it touches through the Gate, does a dry run, and stops the classic traps. The answer is allow, careful or block, with the reasons, signed by Troya.")),
    h("section", { class: "panel tr-box" }, h("div", { class: "tr-tabs", role: "tablist" }, tabTx, tabSig), txForm, sigForm,
      h("div", { class: "tr-act" }, go, clr), ex, h("div", { style: { marginTop: "14px" } }, res)),
    h("section", { class: "panel tr-box" }, h("h3", {}, "Checks so far"), statsBox),
    h("section", { class: "panel tr-box" }, h("h3", {}, "What Trident stops"),
      h("ul", { class: "tr-what" },
        h("li", {}, "Coins that fail Troya Gate or whose launch Ring Radar reads as rigged."),
        h("li", {}, "Approvals to a plain wallet: drainers ask for exactly this. Unlimited approvals to a contract Troya does not know get a warning."),
        h("li", {}, "Coins sent to the token contract itself or to the zero address, where nobody can get them back."),
        h("li", {}, "EIP-7702 delegations that hand your whole account to a contract Troya does not know."),
        h("li", {}, "Permit and Permit2 signatures to an unknown spender, and unlimited amounts."),
        h("li", {}, "A call that would revert in a dry run, so you do not pay gas for nothing.")),
      h("p", { class: "fine", style: { marginTop: "10px" } }, "Robinhood Chain (4663) only in this first version. Wallets and AI agents can call the same check:"),
      h("pre", { class: "tr-pre" }, `curl -X POST https://troya.codes/api/trident/check \\\n  -H 'content-type: application/json' \\\n  -d '{"from":"0x…","to":"0x…","data":"0x…","value":"0"}'`))));
  stats();
  return () => { alive = false; };
}
