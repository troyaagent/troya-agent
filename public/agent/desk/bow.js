// V10 F62 Bow, the Agent Passport (#/bow) and F66 Phaeacians, the Evaluator Desk (#/bow/hire, also #/phaeacians).
// Passport: GET /api/bow/:address or /api/bow?agentId= (server/bow.mjs): stamps with their proof, counts, warnings and a
// dated summary, signed by the Troya attestor. Hire safely: POST /api/phaeacians/precheck and /complete, and the public log
// GET /api/phaeacians (server/phaeacians.mjs). Reading and signing records only: this page never asks a wallet to sign or
// send anything, and Troya never holds anyone's money.
import { h, clear, toast, ago, copyText } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet } from "/agent/js/wallet.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ID = /^\d{1,30}$/;
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "");
const STAND = { flagged: "Flagged", watch: "Watch", evidenced: "Evidenced", thin: "Thin record", unknown: "No record" };
const VERD = { ok: "OK", caution: "Caution", refuse: "Refuse" };
const OUT = { "provider-paid": "Provider paid", mismatch: "Paid, not as expected", involved: "No payment to provider", unrelated: "Unrelated transaction", failed: "Transaction failed", "not-found": "Transaction not found", unreadable: "Not readable", "no-tx": "Hash only" };

function css() {
  if (document.querySelector("style[data-bow]")) return;
  document.head.append(h("style", { "data-bow": "1" }, `
.bw-page { display: grid; gap: 16px; }
.bw-box { padding: 18px; }
.bw-box h3 { margin: 0 0 10px; font-size: 15px; }
.bw-tabs { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line-2); border-radius: 999px; }
.bw-tabs button { border: 0; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer; }
.bw-tabs button.on { background: var(--bg-2); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line-3); }
.bw-search { display: flex; gap: 8px; flex-wrap: wrap; }
.bw-search input { flex: 1 1 320px; min-width: 0; font-family: var(--mono, ui-monospace, monospace); font-size: 13px; }
.bw-ex { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; align-items: center; }
.bw-ex small, .bw-cap { width: 100%; color: var(--faint); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.bw-ex button { text-align: left; }
.bw-ex button span { display: block; font-size: 11px; color: var(--muted); font-weight: 400; }
.bw-res:empty { display: none; }
.bw-head { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--bg-2); border-left: 4px solid var(--muted); }
.bw-head.flagged, .bw-head.refuse { border-left-color: var(--down); } .bw-head.watch, .bw-head.caution { border-left-color: var(--warn); } .bw-head.evidenced, .bw-head.ok { border-left-color: var(--up); }
.bw-badge { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; border: 1px solid var(--line-3); border-radius: 999px; padding: 3px 10px; white-space: nowrap; color: var(--muted); }
.bw-badge.flagged, .bw-badge.refuse, .bw-badge.red { color: var(--down); border-color: var(--down); }
.bw-badge.watch, .bw-badge.caution, .bw-badge.amber { color: var(--warn); border-color: var(--warn); }
.bw-badge.evidenced, .bw-badge.ok, .bw-badge.up { color: var(--up); border-color: var(--up); }
.bw-head b { display: block; font-size: 18px; letter-spacing: -.01em; overflow-wrap: anywhere; }
.bw-head p { margin: 4px 0 0; font-size: 13.5px; color: var(--fg); overflow-wrap: anywhere; }
.bw-counts { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 12px; }
.bw-counts div { padding: 9px 11px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); }
.bw-counts small { display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.bw-counts b { font-size: 18px; font-weight: 600; }
.bw-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.bw-list li { padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-2); display: grid; gap: 4px; font-size: 13.5px; }
.bw-list li.red { border-left: 3px solid var(--down); } .bw-list li.amber { border-left: 3px solid var(--warn); }
.bw-list .bw-t { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); display: flex; gap: 8px; align-items: center; }
.bw-ev { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
.bw-ev a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.bw-sig { margin-top: 12px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
.bw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.bw-grid label, .bw-full { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.bw-full { grid-column: 1 / -1; }
.bw-grid input, .bw-grid select { width: 100%; font-family: var(--mono, ui-monospace, monospace); font-size: 12.5px; }
.bw-act { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.bw-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.bw-log { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.bw-log th, .bw-log td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line-2); vertical-align: top; }
.bw-log th { color: var(--faint); font-weight: 500; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.bw-scroll { overflow-x: auto; }
.bw-pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--line-2); margin: 8px 0 0; }
.bw-card img { max-width: 100%; height: auto; border-radius: 12px; display: block; margin-top: 8px; }
.bw-ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; }
details.bw-more summary { cursor: pointer; font-size: 12.5px; color: var(--muted); margin-top: 12px; }
@media (max-width: 760px) { .bw-counts { grid-template-columns: repeat(3, 1fr); } .bw-grid, .bw-two { grid-template-columns: 1fr; } .bw-head { flex-direction: column; } }`));
}

const evLinks = (list) => (list?.length ? h("div", { class: "bw-ev" }, list.map((e) => h("a", { href: e.url, target: "_blank", rel: "noopener", title: e.note || "" }, e.type === "tx" ? `tx ${short(e.ref)}` : e.type === "erc8004" ? `ERC-8004 ${e.ref.split("#")[1] ? "#" + e.ref.split("#")[1] : ""}` : e.type === "troya" ? "Troya record" : e.type === "http" ? new URL(e.url).host : e.type === "contract-read" ? `read ${short(e.ref)}` : short(e.ref)))) : null);

export async function mount(view, ctx = {}) {
  css();
  let alive = true, seq = 0;
  const startHire = /^#\/phaeacians/.test(location.hash) || ctx.parts?.[0] === "hire";
  const tabP = h("button", { type: "button", class: startHire ? "" : "on" }, "Passport");
  const tabH = h("button", { type: "button", class: startHire ? "on" : "" }, "Hire safely");
  const passBox = h("div", { class: "bw-page" });
  const hireBox = h("div", { class: "bw-page" });
  const setTab = (t) => { tabP.classList.toggle("on", t === "p"); tabH.classList.toggle("on", t === "h"); passBox.hidden = t !== "p"; hireBox.hidden = t !== "h"; if (t === "h") loadLog(); };
  tabP.addEventListener("click", () => { setTab("p"); if (!/^#\/bow(\/0x|\/\d|$)/.test(location.hash)) history.replaceState(null, "", "#/bow"); });
  tabH.addEventListener("click", () => { setTab("h"); history.replaceState(null, "", "#/bow/hire"); });

  /* ---------- Passport ---------- */
  const input = h("input", { class: "input", type: "text", spellcheck: "false", autocomplete: "off", maxlength: "60", placeholder: "Agent wallet (0x…) or ERC-8004 agent id", "aria-label": "Agent wallet or ERC-8004 agent id" });
  const go = h("button", { class: "btn primary", type: "button" }, "Read passport");
  const exBox = h("div", { class: "bw-ex" });
  const res = h("div", { class: "bw-res", "aria-live": "polite" });
  const statsLine = h("p", { class: "fine", style: { marginTop: "10px" } });

  async function read(raw) {
    const text = String(raw || "").trim();
    let q;
    const m = /^(0x[0-9a-fA-F]{40})(?:\?agentId=(\d+))?$/.exec(text);
    if (m) q = m[2] ? `/api/bow/${m[1]}?agentId=${m[2]}` : `/api/bow/${m[1]}`;
    else if (ID.test(text.replace(/^#/, ""))) q = `/api/bow?agentId=${text.replace(/^#/, "")}`;
    else { toast("Paste an agent's wallet (0x + 40 hex) or its ERC-8004 agent id.", "error", 5000); input.focus(); return; }
    const id = ++seq;
    input.value = text;
    const hash = m ? `#/bow/${m[1]}${m[2] ? `?agentId=${m[2]}` : ""}` : `#/bow/${text.replace(/^#/, "")}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    go.disabled = true;
    clear(res, h("p", { class: "fine" }, "Reading: ERC-8004 identity and feedback, Troya's registry, paid jobs, receipts, launches, reviewers' funders, endpoints…"));
    try { const p = await api.get(q); if (alive && id === seq) paint(p); }
    catch (e) { if (alive && id === seq) clear(res, h("div", { class: "alert error" }, e.message || String(e))); }
    finally { go.disabled = false; }
  }

  function paint(p) {
    const c = p.counts || {};
    const md = `[![Troya Bow passport](${p.card})](${p.page})`;
    clear(res,
      h("div", { class: `bw-head ${p.standing}` },
        h("span", { class: `bw-badge ${p.standing}` }, STAND[p.standing] || p.standing),
        h("div", {}, h("b", {}, p.label || (p.agentId ? `ERC-8004 agent #${p.agentId}` : short(p.address))), h("p", {}, p.summary),
          h("p", { class: "fine mono" }, p.address, p.agentId ? ` · ERC-8004 #${p.agentId}` : ""))),
      h("div", { class: "bw-counts" }, [["Stamps", p.stamps.length], ["Warnings", p.warnings.length], ["Graded calls", c.gradedCalls], ["ERC-8004 feedback", c.feedback], ["Paid checks", c.paidChecks],
        ["Seal receipts", c.sealReceipts], ["Launches", c.launches], ["Reviewers", c.reviewers], ["Identities", c.erc8004Ids], ["Endpoints up", c.endpointsRead ? `${c.endpointsUp} of ${c.endpointsRead}` : "none read"]]
        .map(([k, v]) => h("div", {}, h("small", {}, k), h("b", {}, String(v ?? 0))))),
      p.warnings.length ? h("div", {}, h("p", { class: "bw-cap", style: { marginTop: "14px" } }, "Warnings"),
        h("ul", { class: "bw-list" }, p.warnings.map((w) => h("li", { class: w.level }, h("span", { class: "bw-t" }, h("span", { class: `bw-badge ${w.level}` }, w.level === "red" ? "Red" : "Look"), w.key.split(":")[0]), h("span", {}, w.text), evLinks(w.evidence))))) : null,
      h("p", { class: "bw-cap", style: { marginTop: "14px" } }, "Stamps"),
      p.stamps.length ? h("ul", { class: "bw-list" }, p.stamps.map((s) => h("li", {}, h("span", { class: "bw-t" }, s.title, s.health ? h("span", { class: `bw-badge ${s.health === "up" ? "up" : "red"}` }, s.health) : null), h("span", {}, s.text), evLinks(s.evidence))))
        : h("p", { class: "fine" }, "No stamps: Troya found no record it can show for this wallet."),
      h("details", { class: "bw-more" }, h("summary", {}, "What was read, and what was not"),
        h("ul", { class: "bw-ul" }, (p.coverage || []).map((x) => h("li", {}, `${x.source}: ${x.status}${x.note ? `, ${x.note}` : ""}`)))),
      h("details", { class: "bw-more bw-card" }, h("summary", {}, "Embed this passport"),
        h("img", { src: p.card, width: "600", height: "220", alt: "Troya Bow passport card", loading: "lazy" }),
        h("pre", { class: "bw-pre" }, md),
        h("div", { class: "bw-act" }, h("button", { class: "btn sm", type: "button", onclick: () => copyText(md, "Markdown copied") }, "Copy Markdown"),
          h("button", { class: "btn sm", type: "button", onclick: () => copyText(p.card, "Card link copied") }, "Copy card link"))),
      p.signed ? h("div", { class: "bw-sig" }, "Signed by the Troya attestor ", h("span", { class: "mono" }, p.signed.attestor), h("br"), "hash ", h("span", { class: "mono" }, p.signed.hash), h("br"), "Verify: POST { attested, signed } to /api/bow/verify, or EIP-191 over \"Troya Bow\" + newline + hash.") : null,
      h("p", { class: "fine", style: { marginTop: "10px" } }, p.limit),
      h("div", { class: "bw-act" }, h("button", { class: "btn sm", type: "button", onclick: () => { setTab("h"); prov.value = p.agentId && !ADDR.test(input.value.trim()) ? p.agentId : p.address; buyer.focus(); } }, "Hire this agent safely")));
  }
  go.addEventListener("click", () => read(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") read(input.value); });

  async function loadExamples() {
    try {
      const d = await api.get("/api/bow");
      if (!alive) return;
      clear(exBox, h("small", {}, "Agents Troya already knows"), (d.examples || []).map((x) => {
        const b = h("button", { class: "btn sm", type: "button" }, x.label || short(x.address), h("span", {}, x.why));
        b.addEventListener("click", () => read(x.agentId ? (x.address ? `${x.address}?agentId=${x.agentId}` : x.agentId) : x.address));
        return b;
      }));
      if (!d.examples?.length) exBox.append(h("span", { class: "fine" }, "None yet."));
      const s = d.stats || {};
      statsLine.textContent = s.passports ? `${s.passports.toLocaleString("en-US")} passports read so far.` : "";
    } catch { clear(exBox); }
  }

  clear(passBox,
    h("section", { class: "panel bw-box" }, h("div", { class: "bw-search" }, input, go), exBox, statsLine, h("div", { style: { marginTop: "14px" } }, res)),
    h("section", { class: "panel bw-box" }, h("h3", {}, "What a passport reads"),
      h("ul", { class: "bw-ul" },
        h("li", {}, "Its ERC-8004 identity on Robinhood Chain and the feedback left for it, with the first funders of its reviewers: reviewers paid by the agent itself, or several started by one small wallet, read as farmed."),
        h("li", {}, "Calls it filed in Troya's registry and how they were graded, its Arena strategy, and the coins it launched with what Troya Gate says about them now."),
        h("li", {}, "Gate checks it paid Troya for (USDG or x402), a Virtuals ACP listing, and Troya Seal receipts that name it."),
        h("li", {}, "Its wallet's first ETH and activity, and its agent card and endpoints: one plain request each, never a payment.")),
      h("p", { class: "fine", style: { marginTop: "10px" } }, "Honest limit: a passport describes what wallets and endpoints did, never who runs them. ERC-8004 registries can be filled with Sybil identities and feedback, so every stamp names where it came from. Agents can read the same passport:"),
      h("pre", { class: "bw-pre" }, "curl https://troya.codes/api/bow/0x…\ncurl 'https://troya.codes/api/bow?agentId=500'")));

  /* ---------- Hire safely (Phaeacians) ---------- */
  const inp = (ph, v = "") => { const i = h("input", { class: "input", placeholder: ph, spellcheck: "false", autocomplete: "off" }); i.value = v; return i; };
  const prov = inp("Provider: agent wallet 0x… or ERC-8004 id");
  const buyer = inp("Buyer: wallet 0x…", wallet.address || "");
  const jobDesc = inp("What the job is (optional)");
  const preGo = h("button", { class: "btn primary", type: "button" }, "Precheck before funding");
  const preRes = h("div", { class: "bw-res", "aria-live": "polite" });
  const cRef = inp("Job reference (ACP job id, order id…)");
  const cProv = inp("Provider wallet 0x…"), cBuy = inp("Buyer wallet 0x…", wallet.address || "");
  const cHash = inp("Deliverable hash 0x… (32 bytes, optional)");
  const cTx = inp("Payment or evidence transaction 0x… (optional)");
  const cChain = h("select", { class: "input" }, h("option", { value: "4663" }, "Robinhood Chain"), h("option", { value: "8453" }, "Base"), h("option", { value: "42161" }, "Arbitrum"));
  const cFile = h("input", { type: "file", class: "input", "aria-label": "Hash a file in this browser" });
  const cGo = h("button", { class: "btn primary", type: "button" }, "Record completion");
  const cRes = h("div", { class: "bw-res", "aria-live": "polite" });
  const logBox = h("div", { class: "bw-scroll" });
  const acpBox = h("p", { class: "fine" });

  // sha-256 of a file, computed here: the file never leaves this browser
  cFile.addEventListener("change", async () => {
    const f = cFile.files?.[0];
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) { toast("That file is over 200 MB; hash it on your machine instead.", "error"); return; }
    const d = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
    cHash.value = "0x" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    toast("SHA-256 computed in your browser; the file was not uploaded.", "ok", 4000);
  });

  const reasonList = (list) => h("ul", { class: "bw-list" }, list.map((x) => h("li", { class: x.level === "refuse" ? "red" : x.level === "caution" ? "amber" : "" }, h("span", { class: "bw-t" }, h("span", { class: `bw-badge ${x.level}` }, VERD[x.level] || x.level), x.code), h("span", {}, x.text), evLinks(x.evidence))));
  preGo.addEventListener("click", async () => {
    const p = prov.value.trim(), b = buyer.value.trim();
    if (!ADDR.test(p) && !ID.test(p)) { toast("Provider: a wallet address or an ERC-8004 agent id.", "error"); return; }
    if (!ADDR.test(b)) { toast("Buyer: a wallet address.", "error"); return; }
    preGo.disabled = true; clear(preRes, h("p", { class: "fine" }, "Reading the provider's passport and the links between the two wallets…"));
    try {
      const r = await api.post("/api/phaeacians/precheck", { provider: p, buyer: b, job: jobDesc.value.trim() || undefined });
      if (!alive) return;
      clear(preRes,
        h("div", { class: `bw-head ${r.verdict}` }, h("span", { class: `bw-badge ${r.verdict}` }, VERD[r.verdict]), h("div", {}, h("b", {}, `${r.provider.label || short(r.provider.address)} for ${short(r.buyer)}`), h("p", {}, r.summary), h("p", { class: "fine" }, `Provider passport: ${STAND[r.provider.standing] || r.provider.standing}. `, h("a", { class: "link", href: `#/bow/${r.provider.address}${r.provider.agentId ? `?agentId=${r.provider.agentId}` : ""}` }, "Open it")))),
        r.reasons.length ? reasonList(r.reasons) : null,
        h("details", { class: "bw-more" }, h("summary", {}, "What was checked"), h("ul", { class: "bw-ul" }, r.checked.map((x) => h("li", {}, x)))),
        h("div", { class: "bw-sig" }, `Record ${r.id}, signed by the Troya attestor `, h("span", { class: "mono" }, r.signed.attestor), h("br"), "hash ", h("span", { class: "mono" }, r.signed.hash)),
        h("p", { class: "fine", style: { marginTop: "8px" } }, r.limit));
      cProv.value = r.provider.address; cBuy.value = r.buyer;
      loadLog();
    } catch (e) { if (alive) clear(preRes, h("div", { class: "alert error" }, e.message || String(e))); }
    finally { preGo.disabled = false; }
  });

  cGo.addEventListener("click", async () => {
    const body = { jobRef: cRef.value.trim(), provider: cProv.value.trim(), buyer: cBuy.value.trim(), deliverableHash: cHash.value.trim() || undefined, evidenceTx: cTx.value.trim() || undefined, chainId: Number(cChain.value) };
    if (!body.jobRef) { toast("Give the job reference.", "error"); return; }
    if (!ADDR.test(body.provider) || !ADDR.test(body.buyer)) { toast("Provider and buyer: wallet addresses.", "error"); return; }
    if (!body.deliverableHash && !body.evidenceTx) { toast("Give a deliverable hash, an evidence transaction, or both.", "error"); return; }
    cGo.disabled = true; clear(cRes, h("p", { class: "fine" }, "Reading the transaction and recording what can be checked…"));
    try {
      const r = await api.post("/api/phaeacians/complete", body);
      if (!alive) return;
      const good = r.outcome === "provider-paid", bad = ["failed", "not-found", "unrelated", "mismatch"].includes(r.outcome);
      clear(cRes,
        h("div", { class: `bw-head ${good ? "ok" : bad ? "refuse" : "caution"}` }, h("span", { class: `bw-badge ${good ? "ok" : bad ? "refuse" : "caution"}` }, OUT[r.outcome] || r.outcome),
          h("div", {}, h("b", {}, r.jobRef), h("p", {}, r.summary), r.duplicate ? h("p", { class: "fine" }, r.note) : null)),
        r.findings.length ? h("ul", { class: "bw-ul" }, r.findings.map((x) => h("li", {}, x))) : null,
        r.evidence ? h("p", { class: "fine", style: { marginTop: "8px" } }, h("a", { class: "link", href: r.evidence.url, target: "_blank", rel: "noopener" }, `Open the transaction on ${r.evidence.chain}`)) : null,
        h("p", { class: "bw-cap", style: { marginTop: "12px" } }, "Checked"), h("ul", { class: "bw-ul" }, r.checked.map((x) => h("li", {}, x))),
        h("p", { class: "bw-cap", style: { marginTop: "12px" } }, "Not checked"), h("ul", { class: "bw-ul" }, r.notChecked.map((x) => h("li", {}, x))),
        h("div", { class: "bw-sig" }, `Record ${r.id}, signed by the Troya attestor `, h("span", { class: "mono" }, r.signed.attestor), h("br"), "hash ", h("span", { class: "mono" }, r.signed.hash), h("br"), h("a", { class: "link", href: r.url, target: "_blank", rel: "noopener" }, "The record as JSON")));
      loadLog();
    } catch (e) { if (alive) clear(cRes, h("div", { class: "alert error" }, e.message || String(e))); }
    finally { cGo.disabled = false; }
  });

  let logAt = 0;
  async function loadLog() {
    if (Date.now() - logAt < 3000) return;
    logAt = Date.now();
    try {
      const d = await api.get("/api/phaeacians?limit=30");
      if (!alive) return;
      const rows = [
        ...(d.completions || []).map((x) => ({ at: x.at, kind: "Completion", what: x.jobRef, pair: `${short(x.provider)} for ${short(x.buyer)}`, res: OUT[x.outcome] || x.outcome, id: x.id })),
        ...(d.prechecks || []).map((x) => ({ at: x.at, kind: "Precheck", what: x.providerAgentId ? `agent #${x.providerAgentId}` : "", pair: `${short(x.provider)} for ${short(x.buyer)}`, res: VERD[x.verdict] || x.verdict, id: x.id })),
      ].sort((a, b) => b.at - a.at).slice(0, 30);
      const s = d.stats || {};
      clear(logBox, h("p", { class: "fine" }, `${(s.prechecks || 0).toLocaleString("en-US")} ${s.prechecks === 1 ? "precheck" : "prechecks"} and ${(s.completions || 0).toLocaleString("en-US")} completion ${s.completions === 1 ? "record" : "records"} so far.`),
        rows.length ? h("table", { class: "bw-log" }, h("thead", {}, h("tr", {}, ["When", "Record", "Job", "Provider and buyer", "Result"].map((x) => h("th", {}, x)))),
          h("tbody", {}, rows.map((x) => h("tr", {}, h("td", {}, `${ago(x.at)} ago`), h("td", {}, h("a", { class: "link", href: `/api/phaeacians/r/${x.id}`, target: "_blank", rel: "noopener" }, x.kind)), h("td", {}, x.what), h("td", { class: "mono" }, x.pair), h("td", {}, x.res)))))
          : h("p", { class: "fine" }, "No records yet."));
      acpBox.textContent = d.acp ? `Virtuals ACP: ${d.acp.status}. ${d.acp.how}` : "";
    } catch (e) { if (alive) clear(logBox, h("p", { class: "fine" }, `The log could not be read: ${e.message}`)); }
  }

  clear(hireBox,
    h("section", { class: "panel bw-box" }, h("h3", {}, "1. Before the job is funded"),
      h("p", { class: "fine" }, "Troya reads the provider's passport and looks for links between the two wallets: the buyer being the provider's own wallet, one paying the other's first ETH, a small shared funder, or coins sent directly between them."),
      h("div", { class: "bw-grid", style: { marginTop: "10px" } }, h("label", {}, "Provider", prov), h("label", {}, "Buyer", buyer), h("label", { class: "bw-full" }, "Job (optional)", jobDesc)),
      h("div", { class: "bw-act" }, preGo), h("div", { style: { marginTop: "12px" } }, preRes)),
    h("section", { class: "panel bw-box" }, h("h3", {}, "2. When the work is delivered"),
      h("p", { class: "fine" }, "Troya records what it can check: that a payment transaction exists, succeeded and what it moved between the two, and that a deliverable hash was handed in at a given time. It never sees the deliverable and never holds or releases money."),
      h("div", { class: "bw-grid", style: { marginTop: "10px" } }, h("label", { class: "bw-full" }, "Job reference", cRef), h("label", {}, "Provider", cProv), h("label", {}, "Buyer", cBuy),
        h("label", {}, "Deliverable hash", cHash), h("label", {}, "Or hash a file here (never uploaded)", cFile), h("label", {}, "Evidence transaction", cTx), h("label", {}, "Chain of that transaction", cChain)),
      h("div", { class: "bw-act" }, cGo), h("div", { style: { marginTop: "12px" } }, cRes)),
    h("section", { class: "panel bw-box" }, h("h3", {}, "Public log"), logBox, acpBox,
      h("p", { class: "fine", style: { marginTop: "10px" } }, "Honest limit: Troya judges and signs; it never holds anyone's money. Collusion is read from what wallets did on chain, never who runs them, and a completion record says what Troya could check, never that the work was good. Agents can call it directly:"),
      h("pre", { class: "bw-pre" }, `curl -X POST https://troya.codes/api/phaeacians/precheck \\\n  -H 'content-type: application/json' \\\n  -d '{"provider":"0x… or agent id","buyer":"0x…"}'`)));

  clear(view, h("div", { class: "dk bw-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Bow and Phaeacians · V10 Poseidon"),
      h("h1", {}, "Trust an agent on ", h("em", {}, "evidence"), "."),
      h("p", { class: "dk-sub" }, "A passport for any AI agent on Robinhood Chain, built from what its wallets and endpoints did: graded calls, paid jobs, feedback and who left it, receipts, incidents and endpoint health, each with its proof. Hiring one? Troya checks the pair before you fund the job and signs what it could check after."),
      h("div", { class: "bw-tabs", role: "tablist", style: { marginTop: "12px" } }, tabP, tabH)),
    passBox, hireBox));
  setTab(startHire ? "h" : "p");
  loadExamples();
  const first = ctx.parts?.[0] && ctx.parts[0] !== "hire" ? ctx.parts[0] : ctx.query?.address || "";
  if (ADDR.test(first) || ID.test(first)) read(ctx.query?.agentId && ADDR.test(first) ? `${first}?agentId=${ctx.query.agentId}` : first);
  else if (ctx.query?.agentId && ID.test(ctx.query.agentId)) read(ctx.query.agentId);
  return () => { alive = false; };
}
