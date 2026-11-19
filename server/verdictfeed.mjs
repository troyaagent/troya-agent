// V7 F38 Gate in your wallet, the server side.
//   GET  /api/gate/feed?since=<ms>&limit=   every verdict Troya Sentry reached on new Robinhood Chain coins, newest first, with
//                                          Ring Radar's reading and the last red Aegis alert; the whole page is signed by the
//                                          Troya attestor, so a bot or launchpad can prove it came from Troya. Free, poll it.
//   POST /api/gate/tx { chainId, from, to, data, value }
//        what the Troya Snap shows on MetaMask's confirm screen: the coins a Robinhood Chain transaction touches (the target
//        and any token address inside its calldata, routers and known infrastructure left out), each with its Gate verdict,
//        and warnings for unlimited approvals to contracts Troya does not know.
import { getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const lc = (s) => String(s || "").toLowerCase();
let store = null, KNOWN = null;
const MAX_U = 2n ** 255n;

async function known() {
  if (KNOWN) return KNOWN;
  const { ADDR } = await import("./robinhood.mjs");
  KNOWN = new Map(Object.entries(ADDR).map(([k, v]) => [lc(v), k]));
  for (const [a, n] of [["0x6131b5fae19ea4f9d964eac0408e4408b66337b5", "KyberSwap router"], ["0x204faca1764b154221e35c0d20abb3c525710498", "Uniswap router"],
    ["0xe33e9e479df8802cb0866d5d05258bec4cf62948", "Pons launch-and-buy"], ["0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e", "Pons fee escrow"],
    ["0x266323d6ce63e4dfe62cc87bd14ca6c97bb2f525", "Troya fee splitter factory"], ["0x439ebc38c756f4f729c1474ed8de337cfe3aa77e", "Troya Holder Pass"]]) KNOWN.set(a, n);
  return KNOWN;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export async function txInsight({ chainId, from, to, data = "0x", value = "0x0" }) {
  const cid = Number(typeof chainId === "string" && chainId.startsWith("eip155:") ? chainId.slice(7) : chainId);
  if (cid && cid !== 4663) return { chainId: cid, items: [], warnings: [], summary: "Troya Gate reads Robinhood Chain (4663) transactions." };
  if (!isAddress(String(to || ""))) throw new HttpError(400, "to must be the transaction's target address.");
  const K = await known();
  const hex = String(data || "0x").toLowerCase().replace(/^0x/, "");
  const sel = hex.slice(0, 8), words = [];
  for (let i = 8; i + 64 <= hex.length && words.length < 200; i += 64) words.push(hex.slice(i, i + 64));
  const warnings = [];
  // approvals: unlimited to an unknown spender is the classic drainer pattern
  if (sel === "095ea7b3" && words.length >= 2) {
    const spender = "0x" + words[0].slice(24), amt = BigInt("0x" + words[1]);
    if (amt >= MAX_U && !K.has(spender)) warnings.push(`Unlimited approval of this token to ${spender.slice(0, 10)}…, a contract Troya does not know. Approve only the amount you trade.`);
  }
  if (sel === "a22cb465" && words.length >= 2 && BigInt("0x" + words[1]) === 1n && !K.has("0x" + words[0].slice(24))) warnings.push("Approval for all of your items to a contract Troya does not know.");
  // candidate token addresses: the target, then any address-shaped word in the calldata
  const cands = [lc(to)];
  for (const w of words) if (w.startsWith("000000000000000000000000") && BigInt("0x" + w.slice(24)) > 2n ** 100n) cands.push("0x" + w.slice(24));
  const pick = [...new Set(cands)].filter((a) => !K.has(a) && a !== lc(from)).slice(0, 5);
  const { tokenMeta } = await import("./robinhood.mjs");
  const { badgeResult } = await import("./badge.mjs");
  const ring = await import("./ringradar.mjs").catch(() => null);
  const items = [];
  await Promise.all(pick.map(async (a) => {
    const meta = await withTimeout(tokenMeta(a), 4000).catch(() => null);
    if (!meta?.symbol || meta.decimals == null) return;
    const b = await withTimeout(badgeResult(getAddress(a)), 9000).catch(() => null);
    items.push({ token: getAddress(a), symbol: meta.symbol, verdict: b?.verdict || "unchecked", reason: b?.reason || (b ? null : "The Gate did not answer in time."),
      ring: ring?.ringFlags(a)?.[0]?.level || null, url: `https://troya.codes/agent#/gate/${getAddress(a)}` });
  }));
  if (BigInt(value || 0) > 0n && !items.length && !K.has(lc(to))) {
    const code = await (await import("./robinhood.mjs")).rpc("robinhood", "eth_getCode", [to, "latest"]).catch(() => "0x");
    if (code && code !== "0x" && !code.startsWith("0xef0100")) warnings.push("You are sending ETH to a contract Troya does not know and that is not a coin it can check.");
  }
  const worst = items.find((i) => i.verdict === "failed") || items.find((i) => i.ring === "red") || items.find((i) => i.verdict !== "passed");
  const summary = !items.length ? (warnings.length ? "No coin to check; read the warning." : "No Robinhood Chain coin in this transaction for the Gate to check.")
    : worst ? `$${worst.symbol}: ${worst.verdict === "failed" ? "failed the Gate" : worst.ring === "red" ? "Ring Radar calls the launch rigged" : worst.verdict === "untested" ? "nobody has bought on its curve yet, so the test sell could not run" : worst.verdict === "unchecked" ? "the Gate did not answer in time" : "needs a look"}`
      : `${items.map((i) => "$" + i.symbol).join(", ")} passed the Gate at this moment`;
  return { chainId: 4663, items, warnings, summary, note: "A snapshot from Troya Gate, never a safe stamp." };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/gate/feed", async ({ query }) => {
    const since = Number(query.since) || 0, limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const s = await store.readJson("sentry.json", {});
    const ag = await store.readJson("aegis.json", {});
    const ring = await import("./ringradar.mjs").catch(() => null);
    const lastRed = new Map();
    for (const e of ag.feed || []) if (e.level === "red" && !lastRed.has(lc(e.token))) lastRed.set(lc(e.token), { kind: e.kind, text: e.text, at: e.at });
    const items = (s.recent || []).filter((x) => x.at > since).slice(0, limit).map((x) => ({ at: x.at, token: getAddress(x.token), symbol: x.symbol || null, verdict: x.verdict === "nobuys" ? "untested" : x.verdict,
      reason: x.reason || null, raisedEth: x.raised ?? null, buyers: x.buyers ?? null, ring: ring?.ringFlags(x.token)?.[0]?.level || null, aegis: lastRed.get(lc(x.token)) || null, post: x.post || null }));
    const body = { name: "Troya Gate verdict feed", chainId: 4663, count: items.length, next: items[0]?.at || since, items };
    const gate = await import("./gateapi.mjs");
    const signed = await gate.attest(items, "Troya Gate feed").catch(() => null);   // hash = keccak256(JSON.stringify(items))
    return { ...body, signed, how: "Poll with ?since=<next>. signed.signature = EIP-191 over 'Troya Gate feed' + newline + signed.hash by signed.attestor (the same key as Gate API results), where signed.hash = keccak256(JSON.stringify(items))." };
  }, { weight: 1 });
  r.post("/api/gate/tx", async ({ body }) => txInsight(body || {}), { weight: 3, perMin: 60 });
}
