// V10 F58 Trident: Troya Firewall. One checkpoint for any Robinhood Chain transaction or signature request, before it is
// signed, for people, wallets and AI agents alike. Answers allow / warn / block with plain reasons, signed by the Troya
// attestor (the same key as Gate API results) so a wallet, an agent or a contract can verify it came from Troya.
//   POST /api/trident/check   { chainId?, from?, to?, data?, value?, authorizationList?, typedData? }
// What it reads (each one a reason when it fires):
//   - every coin the transaction touches, through the Gate (txInsight: target + token addresses in the calldata)
//   - a dry run of the exact call from the sender (eth_call): a call that would revert is a warning, with the reason
//   - approvals: unlimited to a contract Troya does not know (warn), any approval to a plain wallet (block: drainer pattern)
//   - transfers: coins sent to the token contract itself or to the zero address are lost (block)
//   - EIP-7702 delegations (type-4 authorizationList): handing your account to a contract Troya does not know (block)
//   - signature requests (typedData): Permit / Permit2 to an unknown spender or a plain wallet (warn / block), and
//     unlimited amounts (warn)
// A verdict is a snapshot, never a safe stamp. Robinhood Chain (4663) only in this first version.
import { getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
const MAX_U = 2n ** 255n;
const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
let store = null;

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
async function rpc(method, params) { const { rpc } = await import("./robinhood.mjs"); return timeout(rpc("robinhood", method, params), 8000); }
async function isContract(a) { const c = await rpc("eth_getCode", [a, "latest"]).catch(() => null); return c == null ? null : c !== "0x" && !String(c).startsWith("0xef0100"); }
async function knownMap() {
  const { ADDR } = await import("./robinhood.mjs");
  const K = new Map(Object.entries(ADDR).map(([k, v]) => [lc(v), k]));
  for (const [a, n] of [["0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "KyberSwap router"], ["0x204faca1764b154221e35c0d20abb3c525710498", "Uniswap router"],
    ["0xe33e9e479df8802cb0866d5d05258bec4cf62948", "Pons launch-and-buy"], ["0x000000000022d473030f116ddee9f6b43ac78ba3", "Permit2"]]) K.set(a, n);
  return K;
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// the revert reason inside an eth_call error, when the node gives one
function revertReason(e) {
  const m = String(e?.message || e || "");
  const hex = /0x08c379a0[0-9a-fA-F]+/.exec(m)?.[0];
  if (hex) { try { const b = Buffer.from(hex.slice(10 + 128), "hex"); const len = parseInt(hex.slice(10 + 64, 10 + 128), 16); return b.subarray(0, len).toString("utf8").replace(/[^\x20-\x7e]/g, "").slice(0, 160); } catch {} }
  return /execution reverted:?\s*([^"\n]{0,160})/i.exec(m)?.[1]?.trim() || null;
}

export async function tridentCheck(body = {}) {
  const cid = Number(String(body.chainId ?? 4663).replace(/^eip155:/, ""));
  if (cid !== 4663) return { verdict: "unsupported", chainId: cid, reasons: [{ level: "info", code: "chain", text: "Trident reads Robinhood Chain (4663) in this version." }] };
  const reasons = [];
  const add = (level, code, text) => reasons.push({ level, code, text });
  const K = await knownMap();
  const from = isAddress(String(body.from || "")) ? lc(body.from) : null;
  const to = isAddress(String(body.to || "")) ? lc(body.to) : null;
  const data = String(body.data || "0x").toLowerCase();
  const value = (() => { try { return BigInt(body.value || 0); } catch { return 0n; } })();
  if (!to && !body.typedData) throw new HttpError(400, "Send a transaction (to, data, value) or a signature request (typedData).");
  let coins = [];

  if (to) {
    // the coins it touches and the Gate's word on each (txInsight is the Snap's reader)
    const { txInsight } = await import("./verdictfeed.mjs");
    const ins = await timeout(txInsight({ chainId: 4663, from: from || to, to, data, value: "0x" + value.toString(16) }), 15000).catch(() => null);
    coins = ins?.items || [];
    for (const c of coins) {
      if (c.verdict === "failed") add("block", "gate", `$${c.symbol} failed Troya Gate${c.reason ? `: ${c.reason}` : ""}.`);
      else if (c.ring === "red") add("block", "ring", `$${c.symbol}: Ring Radar reads its launch as rigged.`);
      else if (c.verdict !== "passed") add("warn", "gate", `$${c.symbol}: ${c.verdict === "untested" ? "nobody has bought on its curve yet, so the test sell could not run" : c.reason || "passed with notes"}.`);
    }
    for (const w of ins?.warnings || []) add("warn", "approval", w);

    const hex = data.replace(/^0x/, ""), sel = hex.slice(0, 8), words = [];
    for (let i = 8; i + 64 <= hex.length && words.length < 8; i += 64) words.push(hex.slice(i, i + 64));
    const addrAt = (i) => (words[i] ? "0x" + words[i].slice(24) : null);
    // approve / increaseAllowance to a plain wallet: the classic drainer
    if ((sel === "095ea7b3" || sel === "39509351") && words.length >= 2) {
      const spender = addrAt(0);
      if (!K.has(spender) && (await isContract(spender)) === false) {
        // the Snap reader's generic "a contract Troya does not know" line would contradict this one: a plain wallet says more
        for (let i = reasons.length - 1; i >= 0; i--) if (reasons[i].code === "approval" && /contract Troya does not know/i.test(reasons[i].text)) reasons.splice(i, 1);
        add("block", "approval-eoa", `This approves ${short(spender)}, a plain wallet, to move your coins. Drainers ask for exactly this.`);
      }
    }
    // transfer / transferFrom into the token contract or the zero address: gone for good
    if (sel === "a9059cbb" || sel === "23b872dd") {
      const rcpt = sel === "a9059cbb" ? addrAt(0) : addrAt(1);
      if (rcpt && (rcpt === to || rcpt === ZERO)) add("block", "transfer-sink", `This sends the coins to ${rcpt === to ? "the token contract itself" : "the zero address"}; nobody can get them back.`);
      else if (rcpt === DEAD) add("warn", "transfer-burn", "This sends the coins to the dead address: a burn. Fine only if you mean to burn them.");
    }
    // ETH into a contract Troya does not know and that is not a coin
    if (value > 0n && !coins.length && !K.has(to) && (await isContract(to)) === true) add("warn", "eth-unknown", `You are sending ETH to ${short(to)}, a contract Troya does not know.`);
    // a dry run of the exact call
    if (from) {
      try { await rpc("eth_call", [{ from, to, data, value: "0x" + value.toString(16) }, "latest"]); }
      catch (e) { const why = revertReason(e); add("warn", "simulation", `A dry run of this exact call fails${why ? `: "${why}"` : ""}. It would likely revert and cost gas.`); }
    }
  }

  // EIP-7702: delegating the account itself
  for (const a of Array.isArray(body.authorizationList) ? body.authorizationList.slice(0, 5) : []) {
    const d = lc(a?.address || a?.contractAddress || "");
    if (!isAddress(d)) continue;
    if (d === ZERO) add("info", "7702-clear", "This clears an EIP-7702 delegation on your account.");
    else if (!K.has(d)) add("block", "7702", `This hands control of your whole account to ${short(d)}, a contract Troya does not know (EIP-7702). Sweepers use exactly this.`);
  }

  // signature requests: Permit (EIP-2612) and Permit2
  const td = body.typedData;
  if (td && typeof td === "object") {
    const pt = String(td.primaryType || ""), msg = td.message || {};
    if (/permit/i.test(pt)) {
      const spender = lc(msg.spender || msg.details?.spender || "");
      const amount = (() => { try { return BigInt(msg.value ?? msg.amount ?? msg.details?.amount ?? 0); } catch { return 0n; } })();
      if (isAddress(spender) && !K.has(spender)) {
        const c = await isContract(spender);
        add(c === false ? "block" : "warn", "permit", `This signature lets ${short(spender)}${c === false ? ", a plain wallet," : ", a contract Troya does not know,"} spend your coins without another approval.`);
      }
      if (amount >= MAX_U || amount >= 2n ** 160n - 1n) add("warn", "permit-unlimited", "The signature allows an unlimited amount.");
    }
  }

  const verdict = reasons.some((r) => r.level === "block") ? "block" : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  const out = {
    verdict, chainId: 4663, reasons, coins: coins.map((c) => ({ token: c.token, symbol: c.symbol, verdict: c.verdict })), checkedAt: Date.now(),
    summary: verdict === "allow" ? "Nothing Troya checks fired. A snapshot, never a safe stamp." : verdict === "block" ? `Stop: ${reasons.find((r) => r.level === "block").text}` : `Careful: ${reasons.find((r) => r.level === "warn").text}`,
  };
  try {
    const gate = await import("./gateapi.mjs");
    out.signed = await gate.attest({ verdict, reasons: reasons.map((r) => r.code), to, from, data: data.slice(0, 74), checkedAt: out.checkedAt }, "Troya Trident");
  } catch {}
  if (store) store.update("trident.json", { total: 0, block: 0, warn: 0, allow: 0 }, (d) => { d.total++; d[verdict] = (d[verdict] || 0) + 1; return d; }).catch(() => {});
  return out;
}

export async function register(r, ctx) {
  store = ctx.store;
  r.post("/api/trident/check", ({ body }) => tridentCheck(body || {}), { weight: 3, perMin: 60 });
  r.get("/api/trident", async () => ({
    name: "Troya Trident", chainId: 4663, stats: await store.readJson("trident.json", { total: 0, block: 0, warn: 0, allow: 0 }),
    how: "POST /api/trident/check with { from, to, data, value } for a transaction, { authorizationList } for an EIP-7702 delegation, or { typedData } for a signature request. Answers allow / warn / block with reasons and a signature from the Troya attestor (EIP-191 over 'Troya Trident' + newline + signed.hash).",
  }), { weight: 1 });
}
