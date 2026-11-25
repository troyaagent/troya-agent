// V10 F66 Phaeacians: Evaluator Desk. When one AI agent hires another, Troya can be the independent judge that never holds
// the money: it checks the provider before the job is funded, looks for collusion between buyer and provider, and signs
// what it could check when the work is said to be delivered. The Phaeacians were the sailors who carried Odysseus home.
//   POST /api/phaeacians/precheck  { provider, buyer, providerAgentId?, job? }
//        → the provider's Bow passport in short (server/bow.mjs), a collusion check between the two wallets, and a verdict:
//          ok / caution / refuse with reasons, signed by the Troya attestor ("Troya Phaeacians")
//        collusion, from the links devlinks.mjs and clusters.mjs already draw: the buyer is the provider's own ERC-8004
//        owner or agent wallet; one paid the other's first ETH; both got their first ETH from one small wallet (a busy hub,
//        over 3,000 transactions, links nobody); coins or ETH sent directly between them
//   POST /api/phaeacians/complete  { jobRef, provider, buyer, deliverableHash?, evidenceTx?, chainId?, expect?: { token?, amount? } }
//        → a signed completion record of what Troya could check: that the evidence transaction exists, succeeded, and what
//          it moved (coins in and out of the buyer and the provider); that a deliverable hash was handed to Troya at time T
//          (and whether that hash was handed in before for another job). It says plainly what it did not check: the
//          deliverable itself, who submitted the record (unless signed in), and anything outside the named chain
//   GET  /api/phaeacians           the public log (?provider= ?buyer= ?jobRef= filter), totals, and how ACP fits in
//   GET  /api/phaeacians/r/:id     one record, with its attested JSON and signature
//   POST /api/phaeacians/verify    { attested, signed } → is this a genuine Troya record
// Troya never holds, escrows or releases anyone's money here; nothing in this module signs a transaction. The log lives in
// data/phaeacians.json. Completion records get a Troya Seal receipt unless PHAEACIANS_SEAL=0.
import { Interface, getAddress, isAddress } from "ethers";
import { rpc } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";
import { untrusted } from "./tools.mjs";
import { bowPassport, verifyRecord } from "./bow.mjs";

const FILE = "phaeacians.json";
const LABEL = "Troya Phaeacians";
const SITE = "https://troya.codes";
const HUB_TXS = 3000, SMALL_TXS = 300;
const KEEP_COMPLETIONS = 5000, KEEP_PRECHECKS = 2000;
const CHAINS = {
  4663: { key: "robinhood", name: "Robinhood Chain", scan: "https://robinhoodchain.blockscout.com" },
  8453: { key: "base", name: "Base", scan: "https://basescan.org" },
  42161: { key: "arbitrum", name: "Arbitrum One", scan: "https://arbiscan.io" },
};
const EXPLORER = CHAINS[4663].scan;
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "?");
const plural = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const stamp = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const withTimeout = (p, ms, v = null) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(v), ms))]);
const EV = {
  tx: (h, note, scan = EXPLORER) => ({ type: "tx", ref: h, url: `${scan}/tx/${h}`, note }),
  address: (a, note) => ({ type: "address", ref: getAddress(a), url: `${EXPLORER}/address/${getAddress(a)}`, note }),
};
let store = null;

const addr = (v, what) => {
  const s = String(v || "").trim();
  if (!isAddress(s)) throw new HttpError(400, `${what} must be a wallet address (0x + 40 hex).`);
  return getAddress(s);
};
async function who(req) {
  try { const t = await (await import("./apitokens.mjs")).optionalApiToken(req); if (t?.address) return getAddress(t.address); } catch {}
  try { const s = (await import("./auth.mjs")).getSession(req); if (s?.address) return getAddress(s.address); } catch {}
  return null;
}

/* ---------- wallets (devlinks.mjs: first funders and sizes, Blockscout PRO) ---------- */
let dl = null;
async function devlinks() { if (!dl) { dl = await import("./devlinks.mjs"); dl.initDevLinks?.(store); } return dl; }
const funderOf = async (w) => withTimeout((await devlinks()).firstFunder(w).catch(() => null), 15_000);
const sizeOf = async (w) => withTimeout((await devlinks()).infoOf(w).catch(() => null), 12_000);
async function explorer() {
  const m = await import("./market.mjs").catch(() => ({}));
  return !!process.env.BLOCKSCOUT_API_KEY && m.hasBlockscout?.() !== false ? m : null;
}
async function pages(m, path, n = 2) {
  const out = [];
  let q = "";
  for (let i = 0; i < n; i++) {
    const j = await m.blockscoutApi(path + (q ? (path.includes("?") ? "&" : "?") + q : "")).catch(() => null);
    if (!j) { if (!i) return null; break; }
    out.push(...(j.items || []));
    if (!j.next_page_params || !(j.items || []).length) break;
    q = new URLSearchParams(Object.entries(j.next_page_params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
  }
  return out;
}

/* ---------- collusion between a buyer and a provider ---------- */
async function collusion(buyer, pp) {
  const B = lc(buyer), P = lc(pp.address);
  const side = new Set([P, ...(pp.identity?.agents || []).flatMap((g) => [g.owner, g.agentWallet]).filter(Boolean).map(lc)]);
  const reasons = [], checked = [], coverage = [];
  const add = (level, code, text, evidence = []) => reasons.push({ level, code, text, evidence: evidence.filter(Boolean) });
  if (side.has(B)) {
    const g = (pp.identity?.agents || []).find((x) => lc(x.owner) === B || lc(x.agentWallet) === B);
    add("refuse", "self-deal", B === P ? "The buyer and the provider are the same wallet." : `The buyer is the ${lc(g?.owner) === B ? "owner" : "agent wallet"} of the provider's own ERC-8004 identity #${g?.agentId}: the agent would be hiring itself.`,
      g ? [{ type: "erc8004", ref: `#${g.agentId}`, url: `${EXPLORER}/token/${pp.identity.registry}/instance/${g.agentId}`, note: "ownerOf and agentWallet on the IdentityRegistry" }] : []);
  }
  checked.push("whether the buyer is the provider's own wallet, ERC-8004 owner or agent wallet");
  if (B === P) return { reasons, checked, coverage };
  const m = await explorer();
  if (!m) {
    add("caution", "unchecked", "Funders and direct transfers could not be read: the explorer is not available on this server just now, so collusion was only partly checked.");
    coverage.push({ source: "funders and transfers", status: "n/a", note: "explorer key not set or paused" });
    return { reasons, checked, coverage };
  }
  // first funders: the buyer, the provider and its ERC-8004 owner / agent wallet (up to 3)
  const sideList = [...side].slice(0, 3);
  const [fb, ...fs] = await Promise.all([funderOf(B), ...sideList.map((w) => funderOf(w))]);
  const fside = new Map(sideList.map((w, i) => [w, fs[i]]));
  for (const [w, f] of fside) if (lc(f?.funder) === B) add("refuse", "funded-by-buyer", `The buyer paid the first ETH of ${w === P ? "the provider" : `the provider's ${short(w)}`}${f.eth ? ` (${+f.eth.toFixed(6)} ETH)` : ""}: the provider's wallet was started by the buyer.`, [f.tx ? EV.tx(f.tx, "the first transaction paying that wallet") : EV.address(B, "the buyer")]);
  if (fb?.funder && side.has(lc(fb.funder))) add("refuse", "funded-by-provider", `The provider's side (${short(fb.funder)}) paid the buyer's first ETH: the buyer's wallet was started by the provider.`, [fb.tx ? EV.tx(fb.tx, "the buyer's first funding") : null]);
  const shared = fb?.funder && !side.has(lc(fb.funder)) && lc(fb.funder) !== B ? [...fside].filter(([, f]) => lc(f?.funder) === lc(fb.funder)) : [];
  if (shared.length) {
    const sz = await sizeOf(fb.funder);
    const ev = [EV.address(fb.funder, "the shared first funder"), fb.tx ? EV.tx(fb.tx, "the buyer's first funding") : null, shared[0][1]?.tx ? EV.tx(shared[0][1].tx, "the provider side's first funding") : null];
    if (sz?.txs != null && sz.txs > HUB_TXS) checked.push(`both got their first ETH from ${short(fb.funder)}, a busy wallet (${sz.txs.toLocaleString("en-US")} transactions: an exchange, bridge or app), which links nobody`);
    else add(sz?.txs != null && sz.txs <= SMALL_TXS ? "refuse" : "caution", "shared-funder", `The buyer and the provider got their first ETH from the same wallet, ${short(fb.funder)}${sz?.txs != null ? `, which has only ${plural(sz.txs, "transaction")}` : ""}. Wallets started by one small funder are often run together.`, ev);
  }
  checked.push("who paid the first ETH of the buyer and of the provider's wallets");
  coverage.push({ source: "first funders", status: fb || fs.some(Boolean) ? "done" : "failed" });

  // direct transfers between them, read from the side with fewer transactions (its history is read more completely)
  const [sb, sp] = await Promise.all([sizeOf(B), sizeOf(P)]);
  const scanB = (sb?.txs ?? Infinity) <= (sp?.txs ?? Infinity);
  const me = scanB ? B : P, other = scanB ? side : new Set([B]);
  const [txs, tts] = await Promise.all([pages(m, `/addresses/${me}/transactions`), pages(m, `/addresses/${me}/token-transfers?type=ERC-20`)]);
  if (!txs && !tts) { add("caution", "unchecked", "Direct transfers between the two could not be read just now."); coverage.push({ source: "direct transfers", status: "failed" }); }
  else {
    const hits = [];
    for (const t of txs || []) {
      const f = lc(t.from?.hash), to = lc(t.to?.hash);
      if ((f === me && other.has(to)) || (to === me && other.has(f))) hits.push({ tx: t.hash, at: Date.parse(t.timestamp) || 0, what: `${t.value && BigInt(t.value) > 0n ? `${+(Number(BigInt(t.value)) / 1e18).toFixed(6)} ETH` : "a call"} from ${short(f)} to ${short(to)}` });
    }
    for (const t of tts || []) {
      const f = lc(t.from?.hash), to = lc(t.to?.hash);
      if ((f === me && other.has(to)) || (to === me && other.has(f))) {
        const dec = Number(t.total?.decimals ?? t.token?.decimals ?? 18), v = t.total?.value != null ? Number(t.total.value) / 10 ** dec : null;
        hits.push({ tx: t.transaction_hash || t.tx_hash, at: Date.parse(t.timestamp) || 0, what: `${v != null ? +v.toPrecision(6) : "some"} ${untrusted(t.token?.symbol, 16) || "coins"} from ${short(f)} to ${short(to)}` });
      }
    }
    if (!txs || !tts) add("caution", "unchecked", `Direct ${!txs ? "ETH transactions" : "coin transfers"} between the two could not be read just now; only ${!txs ? "coin transfers" : "ETH transactions"} were checked.`);
    const uniq = [...new Map(hits.map((x) => [x.tx + x.what, x])).values()].sort((a, b) => b.at - a.at);
    const read = (txs?.length || 0) + (tts?.length || 0), total = scanB ? sb?.txs : sp?.txs;
    if (uniq.length) add("caution", "direct-transfers", `${plural(uniq.length, "direct transfer")} between the buyer and the provider's side already: ${uniq.slice(0, 3).map((x) => x.what).join("; ")}${uniq.length > 3 ? "; …" : ""}. A repeat client can be normal; paired with feedback it can also be a wash job.`, uniq.slice(0, 3).map((x) => EV.tx(x.tx, x.what)));
    checked.push(`direct ETH and coin transfers between them, read from the ${scanB ? "buyer" : "provider"}'s latest ${plural(read, "transaction and coin transfer", "transactions and coin transfers")}${total != null ? ` (${total.toLocaleString("en-US")} transactions in all)` : ""}`);
    coverage.push({ source: "direct transfers", status: txs && tts ? "done" : "partial", note: `${read} read from ${short(me)}` });
  }
  return { reasons, checked, coverage };
}

/* ---------- precheck ---------- */
function cleanJob(j) {
  if (j == null || j === "") return null;
  if (typeof j === "string") return { description: untrusted(j, 200) };
  if (typeof j !== "object") return null;
  const o = {};
  for (const k of ["ref", "description", "offering", "token", "amount", "currency", "chainId", "deadline"]) if (j[k] != null && j[k] !== "") o[k] = typeof j[k] === "number" ? j[k] : untrusted(j[k], k === "description" ? 200 : 80);
  return Object.keys(o).length ? o : null;
}
export async function precheck(body = {}, submittedBy = null) {
  const buyer = addr(body.buyer, "buyer");
  const pid = body.providerAgentId != null && body.providerAgentId !== "" ? String(body.providerAgentId) : /^\d{1,30}$/.test(String(body.provider || "").trim()) ? String(body.provider).trim() : null;
  const pAddr = pid && !isAddress(String(body.provider || "")) ? null : addr(body.provider, "provider");
  const pp = await bowPassport({ address: pAddr, agentId: pid });
  const col = await collusion(buyer, pp);
  const reasons = [...col.reasons];
  // the provider's own record
  const red = pp.warnings.filter((w) => w.level === "red"), amber = pp.warnings.filter((w) => w.level !== "red");
  if (red.length) reasons.push({ level: "caution", code: "passport-red", text: `The provider's passport has ${plural(red.length, "red warning")}: ${red[0].text}`, evidence: red[0].evidence.slice(0, 2) });
  else if (amber.length) reasons.push({ level: "caution", code: "passport-watch", text: `The provider's passport has ${plural(amber.length, "warning")}: ${amber[0].text}`, evidence: amber[0].evidence.slice(0, 2) });
  if (pp.standing === "unknown") reasons.push({ level: "caution", code: "no-record", text: "Troya has no record of the provider: untested, not bad. Start with a small job.", evidence: [] });
  else if (pp.standing === "thin") reasons.push({ level: "caution", code: "thin-record", text: "The provider is registered but has no track record Troya can read yet (no graded calls, feedback, paid jobs or receipts). Start with a small job.", evidence: [] });
  const verdict = reasons.some((x) => x.level === "refuse") ? "refuse" : reasons.some((x) => x.level === "caution") ? "caution" : "ok";
  const at = Date.now();
  const job = cleanJob(body.job);
  const attested = {
    v: 1, kind: "troya-phaeacians-precheck", chainId: 4663, provider: pp.address, providerAgentId: pp.agentId || null, buyer, verdict,
    reasons: reasons.map((x) => x.code), passport: { standing: pp.standing, hash: pp.signed?.hash || null, at: pp.at }, job, submittedBy, at,
  };
  const signed = await (await import("./gateapi.mjs")).attest(attested, LABEL);
  const id = "pc_" + signed.hash.slice(2, 14);
  const say = { ok: "Nothing Troya checks fired: no collusion found between these wallets and the provider has a public record. A snapshot, never a guarantee.", caution: "Go carefully, for the reasons below.", refuse: "Troya would not evaluate this job as independent: the reasons below tie the buyer and the provider together." };
  const out = {
    id, name: "Troya Phaeacians", type: "precheck", verdict, summary: say[verdict], reasons,
    provider: { address: pp.address, agentId: pp.agentId || null, label: pp.label, standing: pp.standing, summary: pp.summary, counts: pp.counts, warnings: pp.warnings, passport: pp.page, passportHash: pp.signed?.hash || null },
    buyer, job, checked: col.checked, coverage: col.coverage, submittedBy, at, attested, signed,
    url: `${SITE}/api/phaeacians/r/${id}`,
    limit: "Collusion is read from what wallets did on Robinhood Chain: shared funders and transfers are probabilities, never identities. Wallets that never touched each other on chain can still be run by one person.",
  };
  await store.update(FILE, {}, (d) => {
    d.stats ||= { prechecks: 0, completions: 0 }; d.stats.prechecks++; d.stats[verdict] = (d.stats[verdict] || 0) + 1;
    d.prechecks = [{ id, at, provider: pp.address, providerAgentId: pp.agentId || null, buyer, verdict, reasons: reasons.map((x) => ({ level: x.level, code: x.code, text: x.text })), standing: pp.standing, attested, signed }, ...(d.prechecks || [])].slice(0, KEEP_PRECHECKS);
    return d;
  });
  return out;
}

/* ---------- complete: what Troya can check about a delivery ---------- */
const erc20 = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const metaMemo = new Map();
async function coinMeta(chain, token) {
  const k = `${chain}:${lc(token)}`;
  if (metaMemo.has(k)) return metaMemo.get(k);
  const one = (fn) => rpc(chain, "eth_call", [{ to: token, data: erc20.encodeFunctionData(fn) }, "latest"], { timeoutMs: 8000 }).then((r) => erc20.decodeFunctionResult(fn, r)[0]).catch(() => null);
  const [sym, dec] = await Promise.all([one("symbol"), one("decimals")]);
  const v = { symbol: sym ? untrusted(sym, 16) : null, decimals: dec != null ? Number(dec) : null };
  metaMemo.set(k, v);
  if (metaMemo.size > 2000) metaMemo.delete(metaMemo.keys().next().value);
  return v;
}
async function readTx(chainId, hash) {
  const c = CHAINS[chainId];
  const [tx, rc] = await Promise.all([
    rpc(c.key, "eth_getTransactionByHash", [hash], { timeoutMs: 10_000 }),
    rpc(c.key, "eth_getTransactionReceipt", [hash], { timeoutMs: 10_000 }),
  ]);
  if (!tx || !rc) return { found: false };
  const blk = await rpc(c.key, "eth_getBlockByNumber", [rc.blockNumber, false], { timeoutMs: 10_000 }).catch(() => null);
  const transfers = [];
  for (const l of (rc.logs || []).slice(0, 200)) {
    if (l.topics?.[0] !== T_TRANSFER || l.topics.length !== 3) continue;          // ERC-20 Transfer (an NFT has 4 topics)
    const m = await coinMeta(c.key, l.address);
    const raw = (() => { try { return BigInt(l.data); } catch { return 0n; } })();
    transfers.push({ token: getAddress(l.address), symbol: m.symbol, decimals: m.decimals, from: getAddress("0x" + l.topics[1].slice(26)), to: getAddress("0x" + l.topics[2].slice(26)), raw: raw.toString(), amount: m.decimals != null ? Number(raw) / 10 ** m.decimals : null });
  }
  return { found: true, success: rc.status === "0x1", block: Number(BigInt(rc.blockNumber)), at: blk?.timestamp ? Number(BigInt(blk.timestamp)) * 1000 : null,
    from: tx.from ? getAddress(tx.from) : null, to: tx.to ? getAddress(tx.to) : null, valueEth: Number(BigInt(tx.value || 0)) / 1e18, transfers };
}
const amt = (t) => `${t.amount != null ? +t.amount.toPrecision(8) : `${t.raw} (raw)`} ${t.symbol || short(t.token)}`;

export async function complete(body = {}, submittedBy = null) {
  const jobRef = untrusted(String(body.jobRef ?? "").trim(), 120);
  if (!jobRef) throw new HttpError(400, "jobRef is required: the job's id where it was agreed (an ACP job id, an order id, any reference both sides know).");
  const provider = addr(body.provider, "provider"), buyer = addr(body.buyer, "buyer");
  if (lc(provider) === lc(buyer)) throw new HttpError(400, "The buyer and the provider are the same wallet; there is nothing independent to record.");
  const dh = body.deliverableHash != null && body.deliverableHash !== "" ? String(body.deliverableHash).trim() : null;
  if (dh && !/^(0x)?[0-9a-fA-F]{64}$/.test(dh)) throw new HttpError(400, "deliverableHash is a 32-byte hash in hex (for example the sha256 or keccak256 of the delivered file).");
  const deliverableHash = dh ? "0x" + dh.replace(/^0x/i, "").toLowerCase() : null;
  const et = body.evidenceTx != null && body.evidenceTx !== "" ? String(body.evidenceTx).trim() : null;
  if (et && !/^0x[0-9a-fA-F]{64}$/.test(et)) throw new HttpError(400, "evidenceTx is a transaction hash (0x + 64 hex).");
  const evidenceTx = et ? lc(et) : null;
  const chainId = Number(String(body.chainId ?? 4663).replace(/^eip155:/, ""));
  if (evidenceTx && !CHAINS[chainId]) throw new HttpError(400, "chainId: Robinhood Chain (4663), Base (8453) or Arbitrum (42161).");
  if (!deliverableHash && !evidenceTx) throw new HttpError(400, "Send a deliverableHash, an evidenceTx, or both: Troya records what it can check, and with neither there is nothing to check.");
  const expect = body.expect && typeof body.expect === "object" ? { token: isAddress(String(body.expect.token || "")) ? getAddress(body.expect.token) : null, amount: Number(body.expect.amount) > 0 ? Number(body.expect.amount) : null } : null;

  const d0 = await store.readJson(FILE, {});
  const dup = (d0.completions || []).find((x) => x.jobRef === jobRef && lc(x.provider) === lc(provider) && lc(x.buyer) === lc(buyer) && x.deliverableHash === deliverableHash && x.evidenceTx === evidenceTx && (!evidenceTx || x.chainId === chainId));
  if (dup) return { ...(await recordView(dup)), duplicate: true, note: "This exact completion was recorded before; the original record is returned." };

  const at = Date.now();
  const checked = [], notChecked = [], findings = [];
  let evidence = null, outcome = evidenceTx ? null : "no-tx";
  if (evidenceTx) {
    const c = CHAINS[chainId];
    const t = await withTimeout(readTx(chainId, evidenceTx).catch((e) => ({ error: e.message })), 25_000, { error: "timeout" });
    if (t.error) { outcome = "unreadable"; findings.push(`The evidence transaction could not be read on ${c.name} just now (${String(t.error).slice(0, 80)}).`); }
    else if (!t.found) { outcome = "not-found"; findings.push(`No transaction ${short(evidenceTx)} on ${c.name}.`); }
    else {
      const P = lc(provider), B = lc(buyer);
      const toP = t.transfers.filter((x) => lc(x.to) === P), fromB = t.transfers.filter((x) => lc(x.from) === B);
      const bToP = t.transfers.filter((x) => lc(x.from) === B && lc(x.to) === P);
      const involved = [t.from, t.to, ...t.transfers.flatMap((x) => [x.from, x.to])].map(lc);
      const ethBtoP = lc(t.from) === B && lc(t.to) === P && t.valueEth > 0;
      checked.push(`transaction ${short(evidenceTx)} exists on ${c.name}, block ${t.block}${t.at ? `, ${stamp(t.at)}` : ""}, sent by ${short(t.from)} to ${short(t.to)}`);
      if (!t.success) { outcome = "failed"; findings.push("The evidence transaction failed on chain (reverted): it moved nothing."); }
      else {
        checked.push("it succeeded");
        if (ethBtoP) findings.push(`It sent ${+t.valueEth.toFixed(8)} ETH from the buyer to the provider.`);
        for (const x of bToP) findings.push(`It moved ${amt(x)} from the buyer to the provider.`);
        for (const x of toP.filter((y) => !bToP.includes(y))) findings.push(`The provider received ${amt(x)} from ${short(x.from)} in it.`);
        for (const x of fromB.filter((y) => !bToP.includes(y))) findings.push(`The buyer sent ${amt(x)} to ${short(x.to)} in it.`);
        if (!t.transfers.length && t.valueEth > 0 && !ethBtoP) findings.push(`It sent ${+t.valueEth.toFixed(8)} ETH from ${short(t.from)} to ${short(t.to)}.`);
        checked.push(`its ${plural(t.transfers.length, "coin transfer")} (ERC-20 Transfer logs) and the ETH it carried`);
        const paidProvider = toP.length > 0 || ethBtoP;
        outcome = paidProvider ? "provider-paid" : involved.includes(P) || involved.includes(B) ? "involved" : "unrelated";
        if (outcome === "involved") findings.push("The buyer or the provider appears in it, but nothing was paid to the provider in this transaction.");
        if (outcome === "unrelated") findings.push("Neither the buyer nor the provider appears in this transaction.");
        if (expect && (expect.token || expect.amount)) {
          const pool = expect.token ? toP.filter((x) => lc(x.token) === lc(expect.token)) : toP;
          const got = pool.reduce((s, x) => s + (x.amount || 0), 0);
          const match = pool.length > 0 && (!expect.amount || got + 1e-12 >= expect.amount);
          findings.push(match ? `It matches what was expected: the provider received ${+got.toPrecision(8)} ${pool[0]?.symbol || ""}${expect.amount ? ` (expected ${expect.amount})` : ""}.` : `It does not match what was expected: ${pool.length ? `the provider received ${+got.toPrecision(8)} ${pool[0]?.symbol || ""}, expected ${expect.amount}` : `no ${expect.token ? short(expect.token) : "coin"} reached the provider in it`}.`);
          if (!match && outcome === "provider-paid") outcome = "mismatch";
          checked.push("whether it paid the provider what was expected");
        }
      }
      evidence = { chainId, chain: c.name, tx: evidenceTx, url: `${c.scan}/tx/${evidenceTx}`, success: t.success, block: t.block, at: t.at, from: t.from, to: t.to, valueEth: t.valueEth,
        transfers: t.transfers.slice(0, 20).map(({ raw, ...x }) => ({ ...x, raw })) };
    }
  }
  let reused = null;
  if (deliverableHash) {
    checked.push(`a deliverable hash ${deliverableHash.slice(0, 10)}… was handed to Troya at ${stamp(at)}`);
    const before = (d0.completions || []).filter((x) => x.deliverableHash === deliverableHash && x.jobRef !== jobRef);
    if (before.length) { reused = before.slice(0, 3).map((x) => ({ id: x.id, jobRef: x.jobRef, at: x.at })); findings.push(`This deliverable hash was handed in before for ${plural(before.length, "other job")} (first: "${before[before.length - 1].jobRef}" on ${stamp(before[before.length - 1].at)}). The same file delivered twice is worth a look.`); }
    checked.push("whether the same hash was handed in before for another job");
  }
  const pre = (d0.prechecks || []).find((x) => lc(x.provider) === lc(provider) && lc(x.buyer) === lc(buyer) && at - x.at < 30 * 86_400_000);
  if (pre) checked.push(`a precheck of this pair exists from ${stamp(pre.at)}: ${pre.verdict}`);
  notChecked.push("The deliverable itself: Troya never sees it and does not judge its quality or whether it meets the job.");
  if (!submittedBy) notChecked.push("Who sent this record: it came without a sign-in, so anyone could have submitted it.");
  else if (![lc(provider), lc(buyer)].includes(lc(submittedBy))) notChecked.push(`Whether the buyer or the provider agrees: it was sent by ${short(submittedBy)}, who is neither.`);
  notChecked.push("ETH moved inside contract calls (internal transfers), escrow state on any marketplace, and anything outside the named chain.");
  if (!evidenceTx) notChecked.push("Any payment: no evidence transaction was given.");

  const attested = {
    v: 1, kind: "troya-phaeacians-completion", jobRef, provider, buyer, deliverableHash,
    evidence: evidence ? { chainId, tx: evidenceTx, outcome, success: evidence.success, block: evidence.block, toProvider: evidence.transfers.filter((x) => lc(x.to) === lc(provider)).map((x) => ({ token: x.token, raw: x.raw })) } : null,
    precheck: pre?.id || null, reused: reused ? reused.map((x) => x.id) : null, submittedBy, at,
  };
  const signed = await (await import("./gateapi.mjs")).attest(attested, LABEL);
  const id = "jc_" + signed.hash.slice(2, 14);
  const rec = { id, at, jobRef, provider, buyer, deliverableHash, evidenceTx, chainId: evidenceTx ? chainId : null, outcome, findings, checked, notChecked, evidence, precheck: pre ? { id: pre.id, verdict: pre.verdict, at: pre.at } : null, reused, submittedBy, attested, signed };
  await store.update(FILE, {}, (d) => {
    d.stats ||= { prechecks: 0, completions: 0 }; d.stats.completions++;
    d.stats.outcomes ||= {}; d.stats.outcomes[outcome] = (d.stats.outcomes[outcome] || 0) + 1;
    d.completions = [rec, ...(d.completions || [])].slice(0, KEEP_COMPLETIONS);
    return d;
  });
  if (process.env.PHAEACIANS_SEAL !== "0") import("./seal.mjs").then((m) => m.seal("phaeacians-complete", provider, signed.hash, `${jobRef.slice(0, 60)} ${outcome}`)).catch(() => {});
  return recordView(rec);
}

const OUTCOME = {
  "provider-paid": "The evidence transaction succeeded and paid the provider.", mismatch: "The evidence transaction paid the provider, but not what was expected.",
  involved: "The evidence transaction succeeded but paid the provider nothing.", unrelated: "The evidence transaction does not involve the buyer or the provider.",
  failed: "The evidence transaction failed on chain.", "not-found": "The evidence transaction was not found.", unreadable: "The evidence transaction could not be read just now.",
  "no-tx": "No payment evidence was given; only the deliverable hash was recorded.",
};
async function recordView(rec) {
  return { id: rec.id, name: "Troya Phaeacians", type: "completion", outcome: rec.outcome, summary: OUTCOME[rec.outcome] || rec.outcome, jobRef: rec.jobRef, provider: rec.provider, buyer: rec.buyer,
    deliverableHash: rec.deliverableHash, evidence: rec.evidence, findings: rec.findings, checked: rec.checked, notChecked: rec.notChecked, precheck: rec.precheck, reused: rec.reused,
    submittedBy: rec.submittedBy, at: rec.at, attested: rec.attested, signed: rec.signed, url: `${SITE}/api/phaeacians/r/${rec.id}`,
    limit: "Troya judges and signs; it never holds anyone's money. A completion record says what Troya could check, never that the work was good." };
}

const ACP = {
  status: "live",
  evaluator: "0x1731a0D264A4fd6aB6702bD849Aa6A13533c7E6C",
  how: "On Virtuals ACP v2 a buyer can name Troya Gate's agent wallet (0x1731a0D264A4fd6aB6702bD849Aa6A13533c7E6C, on Base and Robinhood Chain) as a job's evaluator with createJobFromOffering(..., { evaluatorAddress }). When the provider submits, Troya runs this precheck and signs a completion record, then completes the job (escrow pays the provider) or rejects it (escrow refunds the buyer). It rejects only when nothing was delivered or the pair is refused (self-deal, the buyer funded the provider, or both); otherwise it completes. Troya never holds the money and never judges whether the work is good. Troya does not evaluate jobs where it is the provider.",
};

export async function register(r, ctx) {
  store = ctx.store;
  r.post("/api/phaeacians/precheck", async ({ req, body }) => precheck(body || {}, await who(req)), { weight: 5, perMin: 20, maxBody: 8 * 1024 });
  r.post("/api/phaeacians/complete", async ({ req, body }) => complete(body || {}, await who(req)), { weight: 4, perMin: 24, maxBody: 8 * 1024 });
  r.post("/api/phaeacians/verify", ({ body }) => verifyRecord(body?.attested, body?.signed ?? body?.signature), { weight: 1, perMin: 60 });
  r.get("/api/phaeacians/r/:id", async ({ params }) => {
    const id = String(params.id || "");
    if (!/^(pc|jc)_[0-9a-f]{12}$/.test(id)) throw new HttpError(400, "That is not a Phaeacians record id.");
    const d = await store.readJson(FILE, {});
    if (id.startsWith("jc_")) { const x = (d.completions || []).find((y) => y.id === id); if (!x) throw new HttpError(404, "No completion record with that id."); return recordView(x); }
    const x = (d.prechecks || []).find((y) => y.id === id);
    if (!x) throw new HttpError(404, "No precheck with that id.");
    return { name: "Troya Phaeacians", type: "precheck", ...x, url: `${SITE}/api/phaeacians/r/${id}` };
  }, { weight: 1 });
  r.get("/api/phaeacians", async ({ query }) => {
    const d = await store.readJson(FILE, {});
    const f = (x) => (!query.provider || lc(x.provider) === lc(query.provider)) && (!query.buyer || lc(x.buyer) === lc(query.buyer)) && (!query.jobRef || x.jobRef === String(query.jobRef));
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    return {
      name: "Troya Phaeacians", what: "An independent evaluator for agent-to-agent jobs that never holds the money: a precheck of the provider and of collusion before a job is funded, and a signed record of what Troya could check when the work is said to be delivered.",
      stats: d.stats || { prechecks: 0, completions: 0 },
      completions: (d.completions || []).filter(f).slice(0, limit).map((x) => ({ id: x.id, at: x.at, jobRef: x.jobRef, provider: x.provider, buyer: x.buyer, outcome: x.outcome, deliverableHash: x.deliverableHash, evidenceTx: x.evidenceTx, chainId: x.chainId, submittedBy: x.submittedBy, findings: x.findings.slice(0, 3), hash: x.signed?.hash })),
      prechecks: (d.prechecks || []).filter((x) => !query.jobRef && f(x)).slice(0, Math.min(limit, 50)).map((x) => ({ id: x.id, at: x.at, provider: x.provider, providerAgentId: x.providerAgentId, buyer: x.buyer, verdict: x.verdict, reasons: x.reasons.map((y) => y.code), standing: x.standing, hash: x.signed?.hash })),
      how: { precheck: "POST /api/phaeacians/precheck { provider, buyer, providerAgentId?, job? }", complete: "POST /api/phaeacians/complete { jobRef, provider, buyer, deliverableHash?, evidenceTx?, chainId?, expect? }", verify: "POST /api/phaeacians/verify { attested, signed }: EIP-191 over \"Troya Phaeacians\\n\" + keccak256(JSON.stringify(attested))" },
      acp: ACP,
      limit: "Troya judges and signs; it never holds anyone's money. Collusion is read from what wallets did, never who runs them.",
    };
  }, { weight: 1 });
}
