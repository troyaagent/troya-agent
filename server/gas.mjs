// Troya pays gas, two ways, from one sponsor wallet the team funds:
//   1 Gas drip for holders: a wallet holding at least HOLDER_MIN $TROYA (with its Agent Wallet) claims a little ETH on
//     Robinhood Chain once a week. Any wallet works (MetaMask, Rabby, Coinbase Wallet, OKX Wallet…): it is plain ETH.
//   2 Agent Wallet gas refund: after an Agent Wallet transaction confirms, the gas it paid is sent back to it, up to a
//     daily amount per wallet.
// Rails: a daily budget for the whole sponsor, per-wallet limits, the drip skips wallets that already hold enough ETH
// for gas, nothing runs while it is switched off or the sponsor is empty. The sponsor key is made on the server and
// stored encrypted (AES-256-GCM, its own key file); withdrawals from it go only to the creator wallet.
//   GET  /api/gas/status            signed in or not: what the drip and the refund are, and this wallet's standing
//   POST /api/gas/claim             signed in: the weekly drip
//   GET  /api/gas/admin             admin: sponsor address, balance, settings, today's spend, recent sends
//   POST /api/gas/admin/settings    admin: { enabled, dripEth, everyDays, skipAboveEth, refund, refundPerDayEth, dailyBudgetEth }
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Wallet, JsonRpcProvider, getAddress, parseEther, formatEther } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";

const RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
const DEFAULTS = { enabled: false, dripEth: 0.0002, everyDays: 7, skipAboveEth: 0.001, refund: true, refundPerDayEth: 0.0003, dailyBudgetEth: 0.01 };
const FILE = "gas.json";
const today = () => new Date().toISOString().slice(0, 10);
let store = null, dir = null, provider = null, busy = Promise.resolve();

async function masterKey() {
  const f = join(dir, "gas.key");
  try { const k = await readFile(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32); await writeFile(f, k, { mode: 0o600 }); return k;
}
async function sponsor() {
  const f = join(dir, "gas-sponsor.json");
  try {
    const j = JSON.parse(await readFile(f, "utf8"));
    const d = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(j.iv, "hex")); d.setAuthTag(Buffer.from(j.tag, "hex"));
    return new Wallet(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]).toString("utf8"), provider);
  } catch {
    const w = Wallet.createRandom();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", await masterKey(), iv);
    const ct = Buffer.concat([c.update(w.privateKey, "utf8"), c.final()]);
    await writeFile(f, JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex"), address: w.address, at: Date.now() }), { mode: 0o600 });
    return w.connect(provider);
  }
}
const settings = async () => ({ ...DEFAULTS, ...(await store.readJson(FILE, {})).settings });
const ledger = async () => { const d = await store.readJson(FILE, {}); const t = today(); return d.day === t ? d : { ...d, day: t, spentEth: 0, refunds: {} }; };

// one send at a time from the sponsor (nonce order), each one inside the day's budget
function pay(to, eth, kind, owner) {
  const run = busy.then(async () => {
    const s = await settings();
    if (!s.enabled) throw new HttpError(503, "Free gas is switched off right now.");
    const l = await ledger();
    if ((l.spentEth || 0) + eth > s.dailyBudgetEth) throw new HttpError(429, "Today's free-gas budget is used up. It resets at 00:00 UTC.");
    const w = await sponsor();
    const bal = Number(formatEther(await provider.getBalance(w.address)));
    if (bal < eth + 0.00002) throw new HttpError(503, "The gas sponsor is empty right now. The team has been told.");
    const r = await w.sendTransaction({ to: getAddress(to), value: parseEther(eth.toFixed(18)), chainId: 4663 });
    await store.update(FILE, {}, (d) => {
      const t = today(); if (d.day !== t) { d.day = t; d.spentEth = 0; d.refunds = {}; }
      d.spentEth = +((d.spentEth || 0) + eth).toFixed(10);
      if (kind === "refund") { d.refunds ||= {}; d.refunds[lc(to)] = +((d.refunds[lc(to)] || 0) + eth).toFixed(10); }
      if (kind === "drip") { d.claims ||= {}; d.claims[lc(owner)] = Date.now(); }
      d.log = [{ at: Date.now(), kind, to: getAddress(to), owner: owner || null, eth, hash: r.hash }, ...(d.log || [])].slice(0, 200);
      return d;
    });
    return { hash: r.hash, eth };
  });
  busy = run.catch(() => {});
  return run;
}

/** Called by the Agent Wallet after a confirmed transaction: send its gas back, inside the per-wallet daily limit. */
/** Sends a contract call from the sponsor wallet (value 0) in the same one-at-a-time queue and waits for it. Used by the
 *  x402 module to settle USDG payments on Robinhood Chain (transferWithAuthorization), so Troya pays that gas. */
export async function sponsorTx({ to, data, kind = "call", maxEth = 0.0003 }) {
  const run = busy.then(async () => {
    const w = await sponsor();
    const bal = Number(formatEther(await provider.getBalance(w.address)));
    if (bal < maxEth) throw new HttpError(503, "The gas sponsor is low right now. The team has been told.");
    const est = await w.estimateGas({ to: getAddress(to), data });
    const fee = await provider.getFeeData();
    const price = fee.maxFeePerGas || fee.gasPrice || 0n;
    if (Number(formatEther(est * price)) > maxEth) throw new HttpError(503, "Gas is unusually high right now; try again shortly.");
    const tx = await w.sendTransaction({ to: getAddress(to), data, chainId: 4663, gasLimit: (est * 12n) / 10n });
    const rc = await tx.wait(1, 60_000);
    const spent = rc ? Number(formatEther((rc.gasUsed || 0n) * (rc.gasPrice || price))) : 0;
    await store.update(FILE, {}, (d) => {
      const t = today(); if (d.day !== t) { d.day = t; d.spentEth = 0; d.refunds = {}; }
      d.spentEth = +((d.spentEth || 0) + spent).toFixed(10);
      d.log = [{ at: Date.now(), kind, to: getAddress(to), eth: spent, hash: tx.hash, status: rc?.status }, ...(d.log || [])].slice(0, 200);
      return d;
    }).catch(() => {});
    return { hash: tx.hash, status: rc?.status ?? 0, feeEth: spent };
  });
  busy = run.catch(() => {});
  return run;
}

export async function refundGas(owner, agentAddress, feeWei) {
  try {
    if (!store) return null;
    const s = await settings();
    if (!s.enabled || !s.refund || !(feeWei > 0n)) return null;
    const l = await ledger();
    const used = l.refunds?.[lc(agentAddress)] || 0;
    const eth = Math.min(Number(formatEther(feeWei)), s.refundPerDayEth - used);
    if (!(eth > 0.0000001)) return null;
    return await pay(agentAddress, +eth.toFixed(12), "refund", owner);
  } catch (e) { console.warn("[gas refund]", e.message); return null; }
}

async function standing(owner) {
  const s = await settings(), d = await store.readJson(FILE, {});
  const last = d.claims?.[lc(owner)] || 0, next = last ? last + s.everyDays * 86400_000 : 0;
  const h = await import("./holders.mjs").then((m) => m.holderOf(owner)).catch(() => null);
  const eth = Number(formatEther(await provider.getBalance(owner).catch(() => 0n)));
  let can = true, why = null;
  if (!s.enabled) { can = false; why = "Free gas is switched off right now."; }
  else if (!h?.holder) { can = false; why = `Hold at least ${(h?.min || 1e6).toLocaleString("en-US")} $TROYA (this wallet plus its Agent Wallet) to claim.`; }
  else if (next > Date.now()) { can = false; why = `Claimed already. Next claim ${new Date(next).toUTCString().slice(5, 22)} UTC.`; }
  else if (eth >= s.skipAboveEth) { can = false; why = `This wallet already holds ${eth.toFixed(5)} ETH, enough for gas. Free gas is for wallets that run low.`; }
  return { can, why, holder: !!h?.holder, balance: h?.balance ?? null, min: h?.min ?? 1e6, ethBalance: eth, nextClaimAt: next || null };
}

export async function register(r, ctx) {
  store = ctx.store; dir = ctx.dataDir;
  provider = new JsonRpcProvider(RPC, { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
  sponsor().catch((e) => console.warn("[gas] sponsor", e.message));   // make the sponsor wallet at boot so its address is ready to fund

  r.get("/api/gas/status", async ({ req }) => {
    const s = await settings();
    const out = { enabled: s.enabled, dripEth: s.dripEth, everyDays: s.everyDays, refund: s.enabled && s.refund, refundPerDayEth: s.refundPerDayEth,
      wallets: "Any wallet on Robinhood Chain: MetaMask, Rabby, Coinbase Wallet, OKX Wallet and others. It is plain ETH sent to your address." };
    const sess = getSession(req);
    if (sess) out.you = await standing(sess.address);
    return out;
  }, { weight: 2, perMin: 60 });

  r.post("/api/gas/claim", async ({ req }) => {
    const sess = requireSession(req);
    const st = await standing(sess.address);
    if (!st.can) throw new HttpError(400, st.why);
    const s = await settings();
    const p = await pay(sess.address, s.dripEth, "drip", sess.address);
    return { ok: true, ...p, explorer: `https://robinhoodchain.blockscout.com/tx/${p.hash}` };
  }, { weight: 5, perMin: 6 });

  r.get("/api/gas/admin", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const w = await sponsor(), d = await ledger(), s = await settings();
    return { address: w.address, balanceEth: Number(formatEther(await provider.getBalance(w.address))), settings: s, todaySpentEth: d.spentEth || 0, log: ((await store.readJson(FILE, {})).log || []).slice(0, 30) };
  }, { weight: 2 });

  // the rest of the sponsor goes back only to the $TROYA creator wallet
  r.post("/api/gas/admin/withdraw", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const CREATOR = "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4";
    const run = busy.then(async () => {
      const w = await sponsor(), bal = await provider.getBalance(w.address), fee = await provider.getFeeData();
      const gas = 21000n * ((fee.maxFeePerGas || fee.gasPrice || 0n) * 2n);
      if (bal <= gas) throw new HttpError(400, "Nothing to withdraw.");
      const r = await w.sendTransaction({ to: CREATOR, value: bal - gas, chainId: 4663 });
      return { hash: r.hash, eth: Number(formatEther(bal - gas)), to: CREATOR };
    });
    busy = run.catch(() => {});
    return await run;
  }, { weight: 3, perMin: 3 });

  r.post("/api/gas/admin/settings", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    let out;
    await store.update(FILE, {}, (d) => {
      const s = { ...DEFAULTS, ...(d.settings || {}) };
      if (body?.enabled != null) s.enabled = !!body.enabled;
      if (body?.refund != null) s.refund = !!body.refund;
      s.dripEth = num(body?.dripEth ?? s.dripEth, 0.00002, 0.01, s.dripEth);
      s.everyDays = num(body?.everyDays ?? s.everyDays, 1, 60, s.everyDays);
      s.skipAboveEth = num(body?.skipAboveEth ?? s.skipAboveEth, 0.0001, 1, s.skipAboveEth);
      s.refundPerDayEth = num(body?.refundPerDayEth ?? s.refundPerDayEth, 0, 0.05, s.refundPerDayEth);
      s.dailyBudgetEth = num(body?.dailyBudgetEth ?? s.dailyBudgetEth, 0, 1, s.dailyBudgetEth);
      d.settings = s; out = s; return d;
    });
    return { settings: out };
  }, { weight: 2 });
}
