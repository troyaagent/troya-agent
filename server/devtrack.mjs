// Dev track record, for the Project check (projectcheck.mjs): who is behind the coin, read from Robinhood Chain.
//   · the creator's own wallets: the signed-in wallet, its Agent Wallet, wallets linked to the same X account, and
//     older wallets the creator chose to link with a signature (POST /api/launch/track-link)
//   · every Pons launch by those wallets (the factory's TokenLaunched event, deployer topic), and for each coin what
//     the dev did in its first 24 hours: no buy, held, sold out on day one, or dumped within the first hour; and
//     whether the coin graduated
//   · the wallet's age and where its first ETH came from, two steps back (The Assay's funding reader): a funder that
//     dumped coins weighs on the score; a bridge or exchange ends the trail and counts as neutral
// A fresh wallet is not punished: many honest devs use one. It is only lifted by a clean history it can show.

import { ponsState } from "./robinhood.mjs";

const RPC = process.env.ROBINHOOD_WIDE_RPC || "https://rpc.mainnet.chain.robinhood.com";   // wide eth_getLogs spans need the official RPC
const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const T_LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FIRST_LAUNCH = 27_000_000;   // the first Pons launch is at block 27,027,321
const SPAN = 9_900_000;            // the official RPC answers eth_getLogs over at most 10,000,000 blocks
const HOUR = 34_000, DAY = 820_000; // Robinhood Chain makes about 9.5 blocks a second
const lc = (s) => String(s || "").toLowerCase();
const pad = (a) => "0x" + "0".repeat(24) + lc(a).slice(2);
const hex = (n) => "0x" + Number(n).toString(16);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

let store = null;
export function initTrack(s) { store = s; }
const memo = new Map();   // key → { at, v }
async function cached(key, ms, fn) { const h = memo.get(key); if (h && Date.now() - h.at < ms) return h.v; const v = await fn(); memo.set(key, { at: Date.now(), v }); if (memo.size > 3000) memo.delete(memo.keys().next().value); return v; }

async function rpc(method, params) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "RPC error");
      return j.result;
    } catch (e) { if (i === 2) throw e; await new Promise((ok) => setTimeout(ok, 500 * (i + 1))); }
  }
}
const head = () => cached("head", 20_000, async () => Number(BigInt(await rpc("eth_blockNumber", []))));

// every coin these wallets launched on Pons (as the deployer). The official RPC takes a wide block range only with
// one value per topic, so each wallet is read on its own (about 10 reads), and kept for 30 minutes
async function launchesOf(wallet) {
  return cached(`l:${lc(wallet)}`, 30 * 60_000, async () => {
    const h = await head(), out = [];
    for (let from = FIRST_LAUNCH; from <= h; from += SPAN) {
      const logs = await rpc("eth_getLogs", [{ address: FACTORY, topics: [T_LAUNCH, null, null, pad(wallet)], fromBlock: hex(from), toBlock: hex(Math.min(h, from + SPAN - 1)) }]);
      for (const l of logs || []) out.push({ token: "0x" + l.topics[1].slice(26), block: Number(l.blockNumber), dev: lc(wallet) });
    }
    return out;
  });
}
export async function launchesBy(wallets) {
  const ws = [...new Set([...wallets].map(lc))].slice(0, 8);
  return (await Promise.all(ws.map((w) => launchesOf(w).catch(() => [])))).flat();
}

// what the dev did with a coin in its first day
export async function coinStory(token, dev, born) {
  return cached(`s:${lc(token)}:${lc(dev)}`, 60 * 60_000, async () => {
    const h = await head(), to = Math.min(h, born + DAY);
    const [ins, outs, ps] = await Promise.all([
      rpc("eth_getLogs", [{ address: token, topics: [T_TRANSFER, null, pad(dev)], fromBlock: hex(born), toBlock: hex(to) }]),
      rpc("eth_getLogs", [{ address: token, topics: [T_TRANSFER, pad(dev)], fromBlock: hex(born), toBlock: hex(to) }]),
      ponsState(token).catch(() => null),
    ]);
    const got = (ins || []).reduce((s, l) => s + BigInt(l.data === "0x" ? 0 : l.data), 0n);
    // a burn (to 0x0 or 0x…dEaD) is not a sale; everything else that leaves counts as sold or moved out
    let sent = 0n, burned = 0n, outBlock = null;
    for (const l of (outs || []).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))) {
      const v = BigInt(l.data === "0x" ? 0 : l.data), to = "0x" + l.topics[2].slice(26);
      if (/^0x0{40}$/.test(to) || lc(to) === "0x000000000000000000000000000000000000dead") { burned += v; continue; }
      sent += v;
      if (outBlock == null && got > 0n && sent * 10n >= got * 8n) outBlock = Number(l.blockNumber);
    }
    const status = got === 0n ? "no-buy" : outBlock != null ? (outBlock - born <= HOUR ? "dumped" : "sold-day1") : burned * 2n >= got ? "burned" : "held";
    return { token: lc(token), dev: lc(dev), born, status, graduated: !!ps?.graduated, young: h - born < DAY };
  });
}

async function walletAge(wallet) {
  return cached(`a:${lc(wallet)}`, 6 * 3600_000, async () => {
    const [nonce, fund] = await Promise.all([rpc("eth_getTransactionCount", [wallet, "latest"]).then((n) => Number(BigInt(n || 0))).catch(() => null), funding(wallet)]);
    let days = null;
    if (fund?.block) { const b = await rpc("eth_getBlockByNumber", [hex(fund.block), false]).catch(() => null); if (b?.timestamp) days = Math.floor((Date.now() / 1000 - Number(BigInt(b.timestamp))) / 86400); }
    return { nonce, days, fund };
  });
}
async function funding(wallet) {
  try { const a = await import("./assay.mjs"); return await a.fundingOf(wallet, await head()); } catch { return null; }
}

// the creator's own wallets: Agent Wallet, other wallets on the same X account, older wallets linked by signature
async function ownWallets(creator, xHandle) {
  const c = lc(creator), out = new Map([[c, "your wallet"]]);
  const [aw, links, tl, launches] = await Promise.all([
    store.readJson("agentwallets.json", {}), store.readJson("x-links.json", {}), store.readJson("track-links.json", {}), store.readJson("launches.json", []),
  ]);
  if (aw[c]?.address) out.set(lc(aw[c].address), "your Agent Wallet");
  for (const l of launches) if (lc(l.owner) === c && l.wallet && !out.has(lc(l.wallet))) out.set(lc(l.wallet), "your Agent Wallet");
  const handle = lc(xHandle || links[c]?.username || "");
  if (handle) for (const [w, v] of Object.entries(links)) if (lc(v?.username) === handle && !out.has(lc(w))) {
    out.set(lc(w), `another wallet on @${v.username}`);
    if (aw[lc(w)]?.address) out.set(lc(aw[lc(w)].address), `the Agent Wallet of another wallet on @${v.username}`);
  }
  for (const x of tl[c] || []) if (!out.has(lc(x.address))) out.set(lc(x.address), "an older wallet you linked");
  return out;
}

const tally = (stories) => ({ total: stories.length, dumped: stories.filter((s) => s.status === "dumped").length, sold: stories.filter((s) => s.status === "sold-day1").length, burned: stories.filter((s) => s.status === "burned").length, grads: stories.filter((s) => s.graduated).length });
async function storiesOf(wallets, max) {
  const all = (await launchesBy(wallets).catch(() => [])).sort((a, b) => b.block - a.block);
  const seen = new Set(), pick = [];
  for (const l of all) if (!seen.has(l.token)) { seen.add(l.token); pick.push(l); }
  const stories = await Promise.all(pick.slice(0, max).map((l) => coinStory(l.token, l.dev, l.block).catch(() => null)));
  return { stories: stories.filter(Boolean), more: Math.max(0, pick.length - max) };
}

// the section, 20 points: neutral 12; clean history lifts it, dumps (own, same X, or the funder's) bring it down
export async function track(creator, { xHandle, exclude = [] } = {}) {
  if (!creator) return { points: 10, items: [{ ok: null, text: "Sign in with the wallet you will launch from to read its track record" }] };
  const items = [];
  let pts = 12;
  const own = await ownWallets(creator, xHandle);
  const skip = new Set(exclude.map(lc));
  const [{ stories, more }, age] = await Promise.all([storiesOf(own.keys(), 12), walletAge(creator).catch(() => null)]);
  const mine = stories.filter((s) => !skip.has(s.token));   // a coin under a day old counts once it is dumped or sold out
  const t = tally(mine);
  if (!t.total) items.push({ ok: null, text: "No earlier Pons launches from this wallet" + (own.size > 1 ? " or its linked wallets" : "") });
  else {
    pts += Math.min(4, t.grads * 2) + Math.min(2, t.burned) - 8 * t.dumped - 4 * t.sold;
    items.push({ ok: t.dumped || t.sold ? false : true, text: `${t.total}${more ? "+" : ""} earlier launch${t.total === 1 ? "" : "es"}: ${t.grads} graduated, ${t.burned} where the dev burned its buy, ${t.dumped} dumped by the dev within the first hour, ${t.sold} sold out by the dev on day one` });
    for (const s of mine.filter((x) => x.status === "dumped").slice(0, 3)) items.push({ ok: false, text: `Dumped: ${short(s.token)} (dev ${short(s.dev)} sold or moved out 80% of what it bought within an hour)` });
  }
  for (const [w, why] of own) if (why.startsWith("another wallet") || why === "an older wallet you linked") items.push({ ok: null, text: `Counted too: ${short(w)}, ${why}` });
  if (age) {
    if (age.days != null && age.days >= 30) { pts += 3; items.push({ ok: true, text: `Wallet active on Robinhood Chain for ${age.days} days${age.nonce != null ? `, ${age.nonce} transactions` : ""}` }); }
    else items.push({ ok: null, text: age.days != null ? `Fresh wallet: first active ${age.days} day${age.days === 1 ? "" : "s"} ago${age.nonce != null ? `, ${age.nonce} transactions` : ""}` : "Wallet age unknown" });
    if (age.nonce >= 20) pts += 1;
    const f = age.fund;
    if (f?.funder && !own.has(f.funder)) {
      const fs = tally((await storiesOf([f.funder], 6)).stories);
      let hop2 = null;
      const f2 = await funding(f.funder).catch(() => null);
      if (f2?.funder && !own.has(f2.funder)) hop2 = { w: f2.funder, ...tally((await storiesOf([f2.funder], 4)).stories) };
      if (fs.dumped || fs.sold) { pts -= 8; items.push({ ok: false, text: `Its first ETH came from ${short(f.funder)}, a wallet whose coins were dumped or sold out on day one (${fs.dumped + fs.sold} of ${fs.total})` }); }
      else items.push({ ok: null, text: `Its first ETH came from ${short(f.funder)}${fs.total ? `, which launched ${fs.total} coin${fs.total === 1 ? "" : "s"} with no dumps` : ", a wallet with no launches"}` });
      if (hop2 && (hop2.dumped || hop2.sold)) { pts -= 4; items.push({ ok: false, text: `One step further back, ${short(hop2.w)} dumped or sold out ${hop2.dumped + hop2.sold} coin${hop2.dumped + hop2.sold === 1 ? "" : "s"}` }); }
    } else if (f?.how === "contract") items.push({ ok: null, text: "Its first ETH came through a contract (a bridge, an exchange or a batch sender): the trail stops there" });
  }
  return { points: Math.max(0, Math.min(20, pts)), items };
}

export async function register(r, ctx) {
  store = ctx.store;
  // link an older wallet: it signs a message naming itself and the signed-in creator; both have to agree
  r.post("/api/launch/track-link", async ({ req, body }) => {
    const { getSession } = await import("./auth.mjs");
    const { HttpError } = await import("./api.mjs");
    const { verifyMessage } = await import("ethers");
    const s = getSession(req);
    if (!s?.address) throw new HttpError(401, "Sign in with the wallet you will launch from first.");
    const message = String(body?.message || "").slice(0, 600), sig = String(body?.signature || "");
    const m = /I own (0x[0-9a-fA-F]{40}) and link it to (0x[0-9a-fA-F]{40}) for my Troya track record\.\nTime: (\S+)/.exec(message);
    if (!m) throw new HttpError(400, "That message is not a Troya track record link.");
    if (lc(m[2]) !== lc(s.address)) throw new HttpError(400, "The message names a different creator wallet.");
    if (lc(m[1]) === lc(s.address)) throw new HttpError(400, "Switch to the older wallet in your wallet app, then sign again.");
    if (!(Math.abs(Date.now() - Date.parse(m[3])) < 15 * 60_000)) throw new HttpError(400, "The signature is too old. Sign again.");
    let signer = "";
    try { signer = verifyMessage(message, sig); } catch {}
    if (lc(signer) !== lc(m[1])) throw new HttpError(400, "The signature does not come from that wallet.");
    await store.update("track-links.json", {}, (all) => { const c = lc(s.address), l = (all[c] || []).filter((x) => lc(x.address) !== lc(m[1])); l.push({ address: lc(m[1]), at: Date.now() }); all[c] = l.slice(-5); return all; });
    return { ok: true, linked: lc(m[1]) };
  }, { perMin: 6 });
}
