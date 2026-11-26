// TroyaIndex (TIDX) on the server: the keeper, the public read API, and the public alerts on timelocked changes.
// The vault itself (contracts/src/TroyaIndex.sol) is the safety: the keeper can only make it swap with itself, inside the
// move cap, the cooldown and the median price band. This module only decides when and how much, and never signs anything
// else.
//
// Keeper (off unless INDEX_KEEPER=1 and INDEX_ADDRESS is set):
//   · its own wallet, generated on first start (data/index-keeper.key: the 32-byte AES key, data/index-keeper-wallet.json:
//     the private key encrypted with it, both mode 0600, as gas.mjs keeps the gas sponsor). Only the address leaves this
//     file. It refuses to sign if that wallet is any known team wallet (creator, Safe and its signers, team and owner
//     wallets, gas sponsor, admins, INDEX_TEAM_WALLETS).
//   · every INDEX_KEEPER_EVERY_MIN minutes (default 10): pokeAll() once per hour if a venue has no read for this hour;
//     then, if the cooldown has passed and a holding is more than driftPct (default 5) percentage points away from its
//     target weight (data/index-weights.json), one rebalance through ETH, never above the vault's move cap. Every
//     transaction is simulated first (eth_call); a buy goes through Troya Gate (robinhood.mjs gateCheck) first; minOut is
//     the simulated output minus INDEX_MIN_OUT_BUFFER_BPS (default 100). It signs only pokeAll() and rebalance() on the vault.
// Alerts (watching runs whenever INDEX_ADDRESS is set; posting only with INDEX_ALERTS=1, as Pharos): every ChangeProposed
//   and Paused event of the vault → Telegram INDEX_TG_CHAT (TELEGRAM_BOT_TOKEN). Public alerts on proposed changes are part
//   of the vault's trust model (docs/troya-index-plan.md section 7).
// Routes:
//   GET /api/index               holdings (amounts, ETH and USD value), NAV per TIDX, caps used, fee, keeper, last rebalance,
//                                pending timelock changes, addresses with Blockscout links, the "not audited" note
//   GET /api/index/me/:wallet    shares, and what a redeem would pay out now, and what is kept for it (owed)
//   GET /api/index/keeper        the keeper wallet's public address (the deploy page fills the constructor with it)
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Wallet, JsonRpcProvider, Interface, AbiCoder, getAddress, isAddress, formatEther, formatUnits } from "ethers";
import { HttpError } from "./api.mjs";
import { TOKENS, TARGETS, PARAMS, CREATOR, SAFE, FEE_ROUTER, EXPLORER } from "../public/agent/desk/index-deploy-lib.js";

const ETH = "0x0000000000000000000000000000000000000000";
const lc = (s) => String(s || "").toLowerCase();
const coder = AbiCoder.defaultAbiCoder();
const BUILD = JSON.parse(await readFile(new URL("../public/agent/desk/troya-index.json", import.meta.url), "utf8"));
export const V = new Interface(BUILD.contracts.TroyaIndex.abi);
const ERC = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const Q96 = 1n << 96n;
const OPS = ["Keeper", "Guardian", "Fee", "Caps", "RebalanceRules", "AddAsset", "RetireAsset", "AddVenue", "RemoveVenue", "MgmtFee"];
const SYMBOL = { [lc(ETH)]: "ETH", ...Object.fromEntries(Object.entries(TOKENS).map(([s, a]) => [lc(a), s])) };
export const NOT_AUDITED = "Not audited. TroyaIndex was built and tested by Troya (75 contract tests, a Robinhood Chain fork run, Slither and Wake scans), with no paid or outside audit. The contract limits what the team and the keeper can do (no withdraw, sweep or upgrade; every change waits 48 hours in public; withdrawals cannot be paused), but code can have bugs and basket tokens can be frozen by their issuers. Deposit only what you can afford to lose; caps start at 2 TIDX in total and 0.5 per wallet.";

// known team wallets the keeper must never be (a stolen or reused key would join two powers that are kept apart)
const TEAM = [CREATOR, SAFE, "0x1e1367360a080A94069ac59af3B9FF042Bb058d1", "0x70A02a0A8C820E897a2fCB16bcffe4C69aACA931", // the Safe's two signers
  "0x45611870017682Ec781EDb9F71fA72fA91159350", "0x45616165e0582adc2b0e845f12fd34ef7d8458d6", "0x39280d5f22e31d989b03f7c78990cc4f46d972ac", // team, dev side, owner
  "0x937533f8Eb47A10B529A42a7154B73CECa33390B", FEE_ROUTER];                                                                      // gas sponsor, fee router

export const cfg = () => ({
  enabled: process.env.INDEX_KEEPER === "1",
  vault: isAddress(process.env.INDEX_ADDRESS || "") ? getAddress(process.env.INDEX_ADDRESS) : null,
  zap: isAddress(process.env.INDEX_ZAP_ADDRESS || "") ? getAddress(process.env.INDEX_ZAP_ADDRESS) : null,
  deployBlock: Number(process.env.INDEX_DEPLOY_BLOCK) || null,
  alerts: process.env.INDEX_ALERTS === "1",
  tgChat: process.env.INDEX_TG_CHAT || "",
  everyMin: Math.max(2, Number(process.env.INDEX_KEEPER_EVERY_MIN) || 10),
  bufferBps: Math.min(500, Math.max(10, Number(process.env.INDEX_MIN_OUT_BUFFER_BPS) || 100)),
  rpc: process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
});

let store = null, dir = null, provider = null, keeperAddr = null, refused = null, busy = false;
const STATE = "index-keeper.json";
const WEIGHTS = "index-weights.json";

/* ---------- pure logic (tested in tools/index-keeper-test.mjs) ---------- */

/** What `amount` is worth on the other side at sqrt price s (token1 per token0, Q64.96): the vault's own _valueAt. */
export function valueAt(s, zeroForOne, amount) {
  s = BigInt(s); amount = BigInt(amount);
  if (s === 0n) return 0n;
  return zeroForOne ? (amount * s / Q96) * s / Q96 : (amount * Q96 / s) * Q96 / s;
}
/** ETH value (wei) of `amount` of `asset` priced by an ETH venue at sqrt price s. */
export function ethValue(asset, amount, venue, s) {
  if (lc(asset) === lc(ETH)) return BigInt(amount);
  if (!venue || !s) return null;
  // the token is token0 when ETH is asset1: selling token0 gives token1 (ETH) at s²
  return lc(venue.asset0) === lc(asset) ? valueAt(s, true, amount) : valueAt(s, false, amount);
}
/** How much of `asset` is worth `wei` of ETH at sqrt price s. */
export function tokenForEth(asset, wei, venue, s) {
  if (lc(asset) === lc(ETH)) return BigInt(wei);
  return lc(venue.asset0) === lc(asset) ? valueAt(s, false, wei) : valueAt(s, true, wei);
}

/** True if `addr` is one of the team's wallets (or in `extra`). */
export function isTeamWallet(addr, extra = []) {
  const a = lc(addr);
  return [...TEAM, ...extra].some((x) => lc(x) === a);
}

/** The keeper signs nothing but pokeAll() and rebalance() on the vault, with no value. */
export function allowedTx(tx, vault) {
  if (!vault || lc(tx.to) !== lc(vault) || BigInt(tx.value || 0) !== 0n) return false;
  const sel = String(tx.data || "0x").slice(0, 10);
  return sel === V.getFunction("pokeAll").selector || sel === V.getFunction("rebalance").selector;
}

/**
 * The one trade to make now, or why none.
 * assets: [{ address, holding (bigint), buyable, venueId, venue, sqrt }]  (ETH has no venue)
 * targets: { [address lowercased]: percent }, driftBps: the band, maxMoveBps: the vault's cap, minTradeWei
 * → { action: "none", reason } | { action: "trade", venueId, zeroForOne, amountIn, assetIn, assetOut, valueWei, reason }
 */
export function planRebalance({ assets, targets, driftBps = 500, maxMoveBps, minTradeWei = 5_000_000_000_000_000n }) {
  const rows = [];
  for (const a of assets) {
    const v = ethValue(a.address, a.holding, a.venue, a.sqrt);
    if (v == null) {
      if (BigInt(a.holding) > 0n) return { action: "none", reason: `No price for ${SYMBOL[lc(a.address)] || a.address}: its pool has no median yet.` };
      continue;
    }
    rows.push({ ...a, value: v });
  }
  const total = rows.reduce((s, r) => s + r.value, 0n);
  if (total === 0n) return { action: "none", reason: "The vault holds nothing yet." };
  const tSum = Object.values(targets).reduce((s, x) => s + Number(x || 0), 0);
  if (!(tSum > 0)) return { action: "none", reason: "No target weights set." };
  for (const r of rows) {
    r.wBps = Number((r.value * 10000n) / total);
    r.tBps = Math.round((Number(targets[lc(r.address)] || 0) / tSum) * 10000);
    r.dev = r.wBps - r.tBps;
  }
  // assets with a target the vault holds none of yet still count as underweight
  for (const [addr, pct] of Object.entries(targets)) {
    if (!rows.some((r) => lc(r.address) === addr) && Number(pct) > 0) {
      const a = assets.find((x) => lc(x.address) === addr);
      if (a && a.venue && a.sqrt) rows.push({ ...a, value: 0n, wBps: 0, tBps: Math.round((Number(pct) / tSum) * 10000), dev: -Math.round((Number(pct) / tSum) * 10000) });
    }
  }
  const over = rows.reduce((m, r) => (r.dev > (m?.dev ?? 0) ? r : m), null);
  const under = rows.reduce((m, r) => (r.dev < (m?.dev ?? 0) ? r : m), null);
  const worst = Math.max(...rows.map((r) => Math.abs(r.dev)));
  if (worst < driftBps || !over || !under) return { action: "none", reason: `Every weight is within ${driftBps / 100} points of its target (largest gap ${(worst / 100).toFixed(2)}).` };
  const moveBps = Math.min(over.dev, -under.dev);
  const moveWei = (total * BigInt(moveBps)) / 10000n;
  let seller, assetOut, venueRow;
  if (lc(over.address) === lc(ETH)) { seller = over; assetOut = under.address; venueRow = under; }   // buy the light token with ETH
  else { seller = over; assetOut = ETH; venueRow = over; }                                            // sell the heavy token for ETH
  if (!venueRow.venue || venueRow.venueId == null) return { action: "none", reason: `No ETH pool listed for ${SYMBOL[lc(venueRow.address)] || venueRow.address}.` };
  let amountIn = lc(seller.address) === lc(ETH) ? moveWei : tokenForEth(seller.address, moveWei, venueRow.venue, venueRow.sqrt);
  const held = BigInt(seller.holding);
  const cap = seller.buyable === false ? held : (held * BigInt(maxMoveBps)) / 10000n;
  const capped = amountIn > cap;
  if (capped) amountIn = cap > 0n ? cap - 1n : 0n;
  const valueWei = ethValue(seller.address, amountIn, venueRow.venue, venueRow.sqrt);
  if (amountIn <= 0n || valueWei < BigInt(minTradeWei)) return { action: "none", reason: `The trade would be ${formatEther(valueWei || 0n)} ETH, under the ${formatEther(minTradeWei)} ETH minimum.` };
  const sym = (a) => SYMBOL[lc(a)] || a;
  return {
    action: "trade", venueId: venueRow.venueId, zeroForOne: lc(venueRow.venue.asset0) === lc(seller.address), amountIn, assetIn: seller.address, assetOut, valueWei, capped,
    reason: `${sym(over.address)} is ${(over.dev / 100).toFixed(2)} points over its target and ${sym(under.address)} ${(-under.dev / 100).toFixed(2)} under: sell ${formatEther(valueWei)} ETH worth of ${sym(seller.address)} for ${sym(assetOut)}${capped ? " (held to the move cap)" : ""}.`,
  };
}

/** Why the keeper must not trade now, or null. */
export function guard({ now, nextAt, rebalancesPaused, onChainKeeper, me, refusedWhy }) {
  if (refusedWhy) return refusedWhy;
  if (!me) return "No keeper wallet.";
  if (lc(onChainKeeper) !== lc(me)) return `This server's keeper ${me} is not the vault's keeper (${onChainKeeper}).`;
  if (rebalancesPaused) return "Rebalances are paused on the vault.";
  if (Number(now) < Number(nextAt)) return `Cooldown: the next rebalance is allowed at ${new Date(Number(nextAt) * 1000).toISOString()}.`;
  return null;
}

/** A timelocked change in plain words. */
export function describeChange(op, data) {
  const name = OPS[Number(op)] ?? `op ${op}`;
  try {
    const d = (types) => coder.decode(types, data);
    switch (name) {
      case "Keeper": return `New keeper ${d(["address"])[0]}`;
      case "Guardian": return `New guardian ${d(["address"])[0]}`;
      case "Fee": { const [r, b] = d(["address", "uint16"]); return `Deposit fee ${Number(b) / 100}% to ${r}`; }
      case "Caps": { const [t, w] = d(["uint256", "uint256"]); return `Caps: ${formatEther(t)} TIDX in total, ${formatEther(w)} TIDX per wallet`; }
      case "RebalanceRules": { const [m, c] = d(["uint16", "uint32"]); return `Rebalance rules: at most ${Number(m) / 100}% of an asset per move, every ${Number(c) / 3600} hours`; }
      case "AddAsset": return `Add ${SYMBOL[lc(d(["address"])[0])] || d(["address"])[0]} to the basket`;
      case "RetireAsset": return `Retire ${SYMBOL[lc(d(["address"])[0])] || d(["address"])[0]} (sell only, then remove)`;
      case "AddVenue": { const [v] = d(["tuple(uint8,address,address,address,uint24,int24,address,uint16)"]); return v[0] === 1n ? `List the Uniswap v3 pool ${v[1]} (band ${Number(v[7]) / 100}%)` : `List the Uniswap v4 pool ${v[2]}/${v[3]} fee ${v[4]} hooks ${v[6]} (band ${Number(v[7]) / 100}%)`; }
      case "RemoveVenue": return `Remove venue #${d(["uint256"])[0]}`;
      case "MgmtFee": { const [r, b] = d(["address", "uint16"]); return `Management fee ${Number(b) / 100}% a year, minted in TIDX to ${r}`; }
    }
  } catch {}
  return `${name} (data ${String(data).slice(0, 66)}…)`;
}

/** The public alert for a vault event (posted only with INDEX_ALERTS=1). */
export function alertText(ev, vault) {
  const link = `${EXPLORER}/tx/${ev.tx}`;
  if (ev.name === "ChangeProposed") {
    const eta = new Date(Number(ev.eta) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    return [`Troya Index: a change was proposed on chain.`, ``, describeChange(ev.op, ev.data), `It can be executed from ${eta} (48 hours after the proposal), unless the team cancels it.`, ``,
      `Holders can redeem in kind at any time, before or after: troya.codes/agent#/vault`, `Proposal: ${link}`, `Vault: ${EXPLORER}/address/${vault}`].join("\n");
  }
  if (ev.name === "Paused") {
    const what = ev.deposits && ev.rebalances ? "New deposits and rebalances are paused" : ev.deposits ? "New deposits are paused" : ev.rebalances ? "Rebalances are paused" : "Deposits and rebalances are running again";
    return [`Troya Index: ${what}.`, `Withdrawals are never paused: holders can redeem in kind at any time at troya.codes/agent#/vault`, `Transaction: ${link}`].join("\n");
  }
  return `Troya Index: ${ev.name} ${link}`;
}

/* ---------- the keeper wallet: generated here, encrypted at rest, only its address leaves ---------- */
async function masterKey() {
  const f = join(dir, "index-keeper.key");
  try { const k = await readFile(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32);
  await writeFile(f, k, { mode: 0o600 });
  return k;
}
async function loadOrCreateKeeper() {
  const f = join(dir, "index-keeper-wallet.json");
  const mk = await masterKey();
  try {
    const j = JSON.parse(await readFile(f, "utf8"));
    const d = createDecipheriv("aes-256-gcm", mk, Buffer.from(j.iv, "hex")); d.setAuthTag(Buffer.from(j.tag, "hex"));
    const w = new Wallet(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]).toString("utf8"));
    if (j.address && lc(j.address) !== lc(w.address)) throw new Error("index-keeper-wallet.json: the stored address does not match its key");
    return w;
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;      // a damaged file is never silently replaced: a new key would orphan the vault's keeper
    const w = Wallet.createRandom();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", mk, iv);
    const ct = Buffer.concat([c.update(w.privateKey, "utf8"), c.final()]);
    await writeFile(f, JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex"), address: w.address, at: Date.now() }), { mode: 0o600 });
    return new Wallet(w.privateKey);
  }
}
async function extraTeam() {
  const out = String(process.env.INDEX_TEAM_WALLETS || "").split(",").map((s) => s.trim()).filter((s) => isAddress(s));
  out.push(...String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((s) => s.trim()).filter((s) => isAddress(s)));
  try { const g = await import("./gas.mjs"); const a = await g.sponsorAddress?.(); if (a) out.push(a); } catch {}
  try { const j = JSON.parse(await readFile(join(dir, "flywheel-key.json"), "utf8")); if (isAddress(j.addr || "")) out.push(j.addr); } catch {}
  return out;
}
async function signer() {
  if (refused) return null;
  const w = await loadOrCreateKeeper();
  if (isTeamWallet(w.address, await extraTeam())) { refused = `Refused: the keeper key ${w.address} is a team wallet.`; return null; }
  return w.connect(provider);
}

/* ---------- chain reads (through the relay: paid node first, with failover) ---------- */
async function rpc(method, params, opts = {}) {
  const R = await import("./robinhood.mjs");
  return R.rpc("robinhood", method, params, { module: "index", ...opts });
}
async function vcall(fn, args = [], opts = {}) {
  const out = await rpc("eth_call", [{ to: opts.to || cfg().vault, data: (opts.iface || V).encodeFunctionData(fn, args), ...(opts.from ? { from: opts.from } : {}) }, "latest"], opts);
  return (opts.iface || V).decodeFunctionResult(fn, out);
}
const meta = new Map();
async function tokenMeta(a) {
  if (lc(a) === lc(ETH)) return { symbol: "ETH", decimals: 18 };
  if (meta.has(lc(a))) return meta.get(lc(a));
  let symbol = SYMBOL[lc(a)], decimals = 18;
  try { decimals = Number((await vcall("decimals", [], { to: a, iface: ERC }))[0]); } catch {}
  if (!symbol) try { symbol = (await vcall("symbol", [], { to: a, iface: ERC }))[0]; } catch { symbol = a.slice(0, 8); }
  const m = { symbol, decimals };
  meta.set(lc(a), m);
  return m;
}

/** Everything the keeper and the API read from the vault, in one pass. */
export async function readVault(vault = cfg().vault) {
  const o = { to: vault };
  const [assetsR, nVen, supply, keeper, owner, pendingOwner, feeBps, feeRecipient, totalCap, walletCap, maxMoveBps, cooldown, dP, rP, nextAt, lastAt, fees, swapper] = await Promise.all([
    vcall("assets", [], o), vcall("venueCount", [], o), vcall("totalSupply", [], o), vcall("keeper", [], o), vcall("owner", [], o), vcall("pendingOwner", [], o), vcall("feeBps", [], o),
    vcall("feeRecipient", [], o), vcall("totalCap", [], o), vcall("walletCap", [], o), vcall("maxMoveBps", [], o), vcall("cooldown", [], o), vcall("depositsPaused", [], o),
    vcall("rebalancesPaused", [], o), vcall("nextRebalanceAt", [], o), vcall("lastRebalanceAt", [], o), vcall("feesAccrued", [], o), vcall("swapper", [], o)]);
  const [mgmtBps, mgmtTo, lastAccrual] = await Promise.all([vcall("mgmtFeeBps", [], o), vcall("mgmtFeeRecipient", [], o), vcall("lastAccrual", [], o)]);
  const venues = [];
  for (let i = 0; i < Number(nVen[0]); i++) {
    const [v] = await vcall("getVenue", [i], o);
    const [med, n] = await vcall("medianSqrtPrice", [i], o);
    const [lastHour] = await vcall("lastObservedHour", [i], o);
    let spot = 0n; try { spot = (await vcall("spotSqrtPrice", [i], o))[0]; } catch {}
    venues.push({ id: i, kind: Number(v.kind), active: v.active, slippageBps: Number(v.slippageBps), pool: v.pool, asset0: v.asset0, asset1: v.asset1, token0: v.token0, token1: v.token1, fee: Number(v.fee), tickSpacing: Number(v.tickSpacing), hooks: v.hooks,
      median: med, reads: Number(n), lastObservedHour: Number(lastHour), spot });
  }
  const assets = [];
  for (const a of assetsR[0]) {
    const [holding] = await vcall("holdings", [a], o);
    const [listed, buyable] = await vcall("assetInfo", [a], o);
    const venue = lc(a) === lc(ETH) ? null : venues.find((v) => v.active && ((lc(v.asset0) === lc(ETH) && lc(v.asset1) === lc(a)) || (lc(v.asset1) === lc(ETH) && lc(v.asset0) === lc(a)))) || null;
    assets.push({ address: getAddress(a), holding, listed, buyable, venueId: venue?.id ?? null, venue, ...(await tokenMeta(a)) });
  }
  return { vault, assets, venues, supply: supply[0], keeper: keeper[0], owner: owner[0], pendingOwner: pendingOwner[0], feeBps: Number(feeBps[0]), feeRecipient: feeRecipient[0],
    totalCap: totalCap[0], walletCap: walletCap[0], maxMoveBps: Number(maxMoveBps[0]), cooldown: Number(cooldown[0]), depositsPaused: dP[0], rebalancesPaused: rP[0],
    nextAt: Number(nextAt[0]), lastAt: Number(lastAt[0]), feesAccrued: fees[0], swapper: swapper[0],
    mgmtFeeBps: Number(mgmtBps[0]), mgmtFeeRecipient: mgmtTo[0], lastAccrual: Number(lastAccrual[0]) };
}
async function chainNow() {
  const b = await rpc("eth_getBlockByNumber", ["latest", false]);
  return { number: Number(BigInt(b.number)), time: Number(BigInt(b.timestamp)) };
}
/* ---------- target weights: published, scheduled 48 hours ahead, never changed silently (Xivor, 26 Nov 2026) ---------- */
// data/index-weights.json = { active: { targets, driftPct, minTradeEth, since }, pending: { targets, driftPct, minTradeEth,
// scheduledAt, activatesAt, note } | null, history: [...] }. A change is written as pending with an activation time at least
// WEIGHT_DELAY later; the keeper keeps the active weights until then; the change can be cancelled before; scheduling and
// activation are posted publicly (INDEX_ALERTS=1). Weights naming an asset that is not on the vault's allow-list, or that do
// not add up to 100%, are refused when scheduled and again when they would activate or be used.
export const WEIGHT_DELAY_MS = 48 * 3600_000;
const keyOf = (k) => lc(k === "ETH" ? ETH : TOKENS[k] || TOKENS[String(k).toUpperCase()] || k);
const symOf = (a) => SYMBOL[lc(a)] || a;
export const DEFAULT_WEIGHTS = { targets: Object.fromEntries(Object.entries(TARGETS).map(([k, p]) => [keyOf(k), p])), driftPct: 5, minTradeEth: 0.005 };

/** Normalises and checks a set of weights against the vault's allow-list. → { ok, targets (lowercased addresses), reason } */
export function validateWeights(targets, allowed) {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return { ok: false, reason: "No weights given." };
  const allow = new Set(allowed.map(lc));
  const out = {};
  for (const [k, v] of Object.entries(targets)) {
    const a = keyOf(k);
    if (!isAddress(a) && a !== lc(ETH)) return { ok: false, reason: `${k} is not an asset address or a known symbol.` };
    if (!allow.has(a)) return { ok: false, reason: `${symOf(a)} is not on the vault's allow-list.` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { ok: false, reason: `The weight of ${symOf(a)} must be a number of at least 0.` };
    if (out[a] != null) return { ok: false, reason: `${symOf(a)} is named twice.` };
    out[a] = n;
  }
  const sum = Object.values(out).reduce((x, y) => x + y, 0);
  if (Math.abs(sum - 100) > 1e-6) return { ok: false, reason: `The weights add up to ${+sum.toFixed(6)}%, not 100%.` };
  return { ok: true, targets: out };
}
const readWeights = async () => {
  const w = store ? await store.readJson(WEIGHTS, null) : null;
  if (!w) return { active: { ...DEFAULT_WEIGHTS, since: null }, pending: null, history: [] };
  if (!w.active && w.targets) return { active: { targets: w.targets, driftPct: w.driftPct, minTradeEth: w.minTradeEth, since: null }, pending: null, history: [] };   // the first format
  return { active: w.active || { ...DEFAULT_WEIGHTS, since: null }, pending: w.pending || null, history: w.history || [] };
};
/** The assets the vault allows (ETH + its listed assets), or the planned basket before deployment. */
async function allowList() {
  const c = cfg();
  if (!c.vault) return [ETH, ...PARAMS.assets];
  return (await vcall("assets", [], { to: c.vault }))[0].map((a) => getAddress(a));
}
const pct = (t) => Object.entries(t).map(([a, p]) => `${symOf(a)} ${p}%`).join(", ");
export function weightAlertText(kind, w) {
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (kind === "scheduled") return [`Troya Index: new target weights were scheduled.`, ``, `New: ${pct(w.targets)}`, `They take effect from ${when(w.activatesAt)} (48 hours after scheduling) unless cancelled; until then the keeper keeps the current weights.`, ``, `Weights only steer the keeper; the vault's own limits still bind every trade. Holders can redeem in kind at any time: troya.codes/agent#/vault`].join("\n");
  if (kind === "activated") return [`Troya Index: the new target weights are now active.`, ``, pct(w.targets), ``, `Scheduled ${when(w.scheduledAt)}, announced 48 hours ahead. Details: troya.codes/agent#/vault`].join("\n");
  if (kind === "cancelled") return [`Troya Index: the scheduled weight change was cancelled; the current weights stay.`, ``, `Cancelled: ${pct(w.targets)}`].join("\n");
  return `Troya Index weights: ${kind}`;
}
/** Schedules new weights (admin). They activate no sooner than 48 hours from `now`. */
export async function scheduleWeights({ targets, driftPct, minTradeEth, delayMs = WEIGHT_DELAY_MS, note } = {}, deps = {}) {
  const v = validateWeights(targets, deps.allowed || (await allowList()));
  if (!v.ok) throw new HttpError(400, `Refused: ${v.reason}`);
  const now = deps.now ?? Date.now();
  const w = await readWeights();
  if (w.pending) throw new HttpError(409, "A weight change is already scheduled; cancel it first.");
  const drift = driftPct == null ? w.active.driftPct ?? 5 : Number(driftPct);
  const minEth = minTradeEth == null ? w.active.minTradeEth ?? 0.005 : Number(minTradeEth);
  if (!(drift >= 1 && drift <= 50) || !(minEth > 0 && minEth <= 1)) throw new HttpError(400, "Refused: driftPct must be 1 to 50 and minTradeEth above 0 and at most 1.");
  w.pending = { targets: v.targets, driftPct: drift, minTradeEth: minEth, scheduledAt: now, activatesAt: now + Math.max(WEIGHT_DELAY_MS, Number(delayMs) || 0), note: note ? String(note).slice(0, 200) : null };
  await store.writeJson(WEIGHTS, w);
  viewMemo.at = 0;
  await (deps.post || postAlert)(weightAlertText("scheduled", w.pending));
  return w;
}
/** Cancels the scheduled change before it activates (admin). */
export async function cancelWeights(deps = {}) {
  const w = await readWeights();
  if (!w.pending) throw new HttpError(409, "No weight change is scheduled.");
  const was = w.pending;
  w.history = [{ ...was, cancelledAt: deps.now ?? Date.now() }, ...w.history].slice(0, 30);
  w.pending = null;
  await store.writeJson(WEIGHTS, w);
  viewMemo.at = 0;
  await (deps.post || postAlert)(weightAlertText("cancelled", was));
  return w;
}
/** Makes a scheduled change active once its time has come (re-checked against the allow-list then). */
export async function activateDueWeights(deps = {}) {
  const w = await readWeights();
  const now = deps.now ?? Date.now();
  if (!w.pending || now < w.pending.activatesAt) return { activated: false, weights: w };
  const v = validateWeights(w.pending.targets, deps.allowed || (await allowList()));
  if (!v.ok) {
    w.history = [{ ...w.pending, rejectedAt: now, reason: v.reason }, ...w.history].slice(0, 30);
    w.pending = null;
    await store.writeJson(WEIGHTS, w);
    await log({ kind: "weights", reason: `Scheduled weights dropped at activation: ${v.reason}` }).catch(() => {});
    return { activated: false, rejected: v.reason, weights: w };
  }
  w.history = [{ ...w.active, replacedAt: now }, ...w.history].slice(0, 30);
  w.active = { targets: v.targets, driftPct: w.pending.driftPct, minTradeEth: w.pending.minTradeEth, since: now, scheduledAt: w.pending.scheduledAt };
  const done = w.pending;
  w.pending = null;
  await store.writeJson(WEIGHTS, w);
  viewMemo.at = 0;
  await (deps.post || postAlert)(weightAlertText("activated", done));
  return { activated: true, weights: w };
}
/** The weights the keeper uses now (the active set, checked against the allow-list). */
export async function activeWeights(allowed) { return weights(allowed); }
async function weights(allowed) {
  const w = await readWeights();
  const v = validateWeights(w.active.targets, allowed || (await allowList()));
  return { ok: v.ok, reason: v.reason, targets: v.ok ? v.targets : {}, driftBps: Math.round((Number(w.active.driftPct) || 5) * 100), minTradeWei: BigInt(Math.round((Number(w.active.minTradeEth) || 0.005) * 1e18)) };
}
/** The published view: active and pending weights by symbol. */
async function weightsView() {
  const w = await readWeights();
  const bySym = (t) => Object.fromEntries(Object.entries(t || {}).map(([a, p]) => [symOf(a), p]));
  return { active: { targets: bySym(w.active.targets), driftPct: w.active.driftPct ?? 5, since: w.active.since || null },
    pending: w.pending ? { targets: bySym(w.pending.targets), driftPct: w.pending.driftPct, scheduledAt: w.pending.scheduledAt, activatesAt: w.pending.activatesAt, note: w.pending.note } : null,
    rule: "A change of weights is scheduled at least 48 hours ahead, announced, and can be cancelled before it activates. Weights must name only assets on the vault's allow-list and add up to 100%." };
}

/* ---------- the keeper ---------- */
async function log(entry) {
  const s = await store.readJson(STATE, {});
  s.log = [{ at: Date.now(), ...entry }, ...(s.log || [])].slice(0, 60);
  if (entry.kind === "rebalance" && entry.tx) s.lastRebalance = { at: Date.now(), tx: entry.tx, reason: entry.reason };
  await store.writeJson(STATE, s);
}
const ser = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
async function send(w, tx, label) {
  const c = cfg();
  if (!allowedTx(tx, c.vault)) throw new Error(`Refused to sign ${label}: not pokeAll() or rebalance() on the vault.`);
  await rpc("eth_call", [{ from: w.address, to: tx.to, data: tx.data }, "latest"]);   // simulate: throws on a revert
  const gas = BigInt(await rpc("eth_estimateGas", [{ from: w.address, to: tx.to, data: tx.data }]));
  // the nonce read fresh for every transaction (a provider's short read cache could hand out the same one twice)
  const nonce = Number(BigInt(await rpc("eth_getTransactionCount", [w.address, "pending"])));
  const r = await w.sendTransaction({ to: tx.to, data: tx.data, value: 0n, chainId: 4663, nonce, gasLimit: (gas * 13n) / 10n + 20_000n });
  const rc = await r.wait(1, 180_000);
  if (!rc || rc.status !== 1) throw new Error(`${label} failed on chain (${r.hash}).`);
  return r.hash;
}

/** One keeper pass. `deps.gate` replaces Troya Gate in tests. Returns what it did. */
export async function keeperTick(deps = {}) {
  const c = cfg();
  if (!c.vault) return { skipped: "INDEX_ADDRESS is not set (the vault is not deployed yet)." };
  if (!c.enabled && !deps.force) return { skipped: "The keeper is off (INDEX_KEEPER=1 turns it on)." };
  if (busy) return { skipped: "A keeper pass is already running." };
  busy = true;
  const out = { at: Date.now(), poked: null, rebalance: null };
  try {
    const w = await signer();
    if (!w) { out.skipped = refused || "No keeper wallet."; await log({ kind: "refused", reason: out.skipped }); return out; }
    const bal = BigInt(await rpc("eth_getBalance", [w.address, "latest"]));
    if (bal < 300_000_000_000_000n) { out.skipped = `The keeper wallet ${w.address} holds ${formatEther(bal)} ETH; it needs at least 0.0003 ETH for gas.`; return out; }
    const [d, now] = await Promise.all([readVault(c.vault), chainNow()]);
    if (lc(d.keeper) !== lc(w.address)) { out.skipped = guard({ now: now.time, nextAt: 0, onChainKeeper: d.keeper, me: w.address }); return out; }
    // 1 the hourly price reads
    const hour = Math.floor(now.time / 3600);
    if (d.venues.some((v) => v.active && v.lastObservedHour < hour)) {
      try { out.poked = await send(w, { to: c.vault, data: V.encodeFunctionData("pokeAll") }, "pokeAll"); await log({ kind: "poke", tx: out.poked }); }
      catch (e) { out.pokeError = e.message; }
    }
    // 2 a rebalance, if one is due
    const why = guard({ now: now.time, nextAt: d.nextAt, rebalancesPaused: d.rebalancesPaused, onChainKeeper: d.keeper, me: w.address });
    if (why) { out.rebalance = { action: "none", reason: why }; return out; }
    const d2 = out.poked ? await readVault(c.vault) : d;
    const allowed = d2.assets.map((a) => a.address);
    await activateDueWeights({ allowed, post: deps.post });
    const wt = await weights(allowed);
    if (!wt.ok) { out.rebalance = { action: "none", reason: `Refused: the active target weights are not usable (${wt.reason}).` }; await log({ kind: "weights", reason: out.rebalance.reason }); return out; }
    const plan = planRebalance({ assets: d2.assets.map((a) => ({ ...a, sqrt: a.venue?.median })), targets: wt.targets, driftBps: wt.driftBps, maxMoveBps: d2.maxMoveBps, minTradeWei: wt.minTradeWei });
    out.rebalance = ser(plan);
    if (plan.action !== "trade") return out;
    const venue = d2.venues[plan.venueId];
    if (venue.reads < 12) { out.rebalance = { action: "none", reason: `Venue #${venue.id} has ${venue.reads} hourly reads; the vault needs 12.` }; return out; }
    // a buy goes through Troya Gate first
    if (lc(plan.assetOut) !== lc(ETH)) {
      const gateFn = deps.gate || (async (q) => (await import("./robinhood.mjs")).gateCheck(q));
      const g = await gateFn({ tokenIn: "ETH", tokenOut: plan.assetOut, amountIn: Number(formatEther(plan.valueWei)).toFixed(8), slippageBps: venue.slippageBps });
      if (g?.pass === false) {
        const fails = (g.checks || []).filter((x) => x.status === "fail").map((x) => `${x.label}: ${x.detail}`).join("; ");
        out.rebalance = { ...ser(plan), action: "blocked", reason: `Troya Gate stopped the buy: ${fails}` };
        await log({ kind: "gate", reason: out.rebalance.reason });
        return out;
      }
    }
    // simulate with no minOut to see what the pool gives, then trade with minOut = that minus the buffer
    const sim = V.decodeFunctionResult("rebalance", await rpc("eth_call", [{ from: w.address, to: c.vault, data: V.encodeFunctionData("rebalance", [plan.venueId, plan.zeroForOne, plan.amountIn, 0n]) }, "latest"]));
    const minOut = (sim[1] * BigInt(10000 - c.bufferBps)) / 10000n;
    const tx = await send(w, { to: c.vault, data: V.encodeFunctionData("rebalance", [plan.venueId, plan.zeroForOne, plan.amountIn, minOut]) }, "rebalance");
    out.rebalance = { ...ser(plan), tx, simulated: { spent: sim[0].toString(), received: sim[1].toString() }, minOut: minOut.toString() };
    await log({ kind: "rebalance", tx, reason: plan.reason });
    return out;
  } catch (e) {
    out.error = e.shortMessage || e.message;
    await log({ kind: "error", reason: out.error }).catch(() => {});
    return out;
  } finally {
    busy = false;
  }
}

/* ---------- events: the timelock queue, the rebalance history, public alerts ---------- */
const WATCH = ["ChangeProposed", "ChangeExecuted", "ChangeCancelled", "Paused", "Rebalanced", "OwnershipTransferStarted", "OwnershipTransferred"];
async function postAlert(text) {
  const c = cfg();
  if (!c.alerts || !c.tgChat || !process.env.TELEGRAM_BOT_TOKEN) return false;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: c.tgChat, text, link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(15_000) }).catch(() => {});
  return true;
}
/** Reads the vault's new events since the last scan; alerts on ChangeProposed and Paused found after the first scan. */
export async function scanEvents(deps = {}) {
  const c = cfg();
  if (!c.vault) return { skipped: "INDEX_ADDRESS is not set." };
  const s = await store.readJson(STATE, {});
  const head = (await chainNow()).number;
  const first = s.lastBlock == null;
  let from = first ? (c.deployBlock || Math.max(0, head - 200_000)) : s.lastBlock + 1;
  const events = s.events || [];
  const fresh = [];
  const topics = WATCH.map((n) => V.getEvent(n).topicHash);
  while (from <= head) {
    const to = Math.min(head, from + 8_999);
    const logs = await rpc("eth_getLogs", [{ address: c.vault, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [topics] }]);
    for (const l of logs) {
      let p; try { p = V.parseLog(l); } catch { continue; }
      const ev = { name: p.name, tx: l.transactionHash, block: Number(BigInt(l.blockNumber)) };
      if (p.name === "ChangeProposed") Object.assign(ev, { id: p.args.id, op: Number(p.args.op), data: p.args.data, eta: Number(p.args.eta), text: describeChange(p.args.op, p.args.data) });
      if (p.name === "ChangeExecuted") Object.assign(ev, { id: p.args.id, op: Number(p.args.op), text: describeChange(p.args.op, p.args.data) });
      if (p.name === "ChangeCancelled") ev.id = p.args.id;
      if (p.name === "Paused") Object.assign(ev, { deposits: p.args.deposits, rebalances: p.args.rebalances, by: p.args.by });
      if (p.name === "Rebalanced") Object.assign(ev, { venueId: Number(p.args.venueId), assetIn: p.args.assetIn, assetOut: p.args.assetOut, spent: p.args.spent.toString(), received: p.args.received.toString() });
      if (p.name.startsWith("Ownership")) Object.assign(ev, { from: p.args.previousOwner, to: p.args.newOwner });
      if (!events.some((x) => x.tx === ev.tx && x.name === ev.name && x.id === ev.id)) { events.push(ev); fresh.push(ev); }
    }
    from = to + 1;
  }
  let alerted = 0;
  if (!first) for (const ev of fresh) if (ev.name === "ChangeProposed" || ev.name === "Paused") { if (await (deps.post || postAlert)(alertText(ev, c.vault))) alerted++; }
  s.lastBlock = head;
  s.events = events.slice(-300);
  await store.writeJson(STATE, s);
  if (fresh.length) viewMemo.at = 0;       // a new proposal, pause or rebalance shows on the next read, not 20 s later
  return { scanned: true, first, fresh: fresh.length, alerted };
}

/* ---------- the public view ---------- */
let viewMemo = { at: 0, v: null, p: null };
async function priceUsd(asset, ethUsd, valueEthPerUnit) {
  if (lc(asset) === lc(ETH)) return { usd: ethUsd, source: "Hyperliquid / GeckoTerminal ETH price" };
  try {
    const m = await import("./market.mjs");
    const t = await Promise.race([m.getRobinhoodToken(asset), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 5000))]);
    const p = Number(t?.priceUsd ?? t?.token?.priceUsd);
    if (p > 0) return { usd: p, source: "market (DexScreener / GeckoTerminal)" };
  } catch {}
  return valueEthPerUnit != null && ethUsd ? { usd: valueEthPerUnit * ethUsd, source: "the vault's pool, x ETH price" } : { usd: null, source: null };
}
export async function indexView() {
  const c = cfg();
  const keeper = { address: keeperAddr, enabled: c.enabled, refused };
  const base = { name: "Troya Index", symbol: "TIDX", chainId: 4663, notAudited: NOT_AUDITED, keeper, docs: "https://github.com/troyaagent/troya-agent/blob/main/contracts/docs/troya-index-plan.md" };
  if (!c.vault) return { ...base, deployed: false, weights: await weightsView(), planned: { assets: ["ETH", ...PARAMS.assets.map((a) => SYMBOL[lc(a)])], targets: TARGETS, feePct: PARAMS.feeBps / 100, mgmtPctPerYear: PARAMS.mgmtFeeBps / 100, totalCap: 2, walletCap: 0.5, timelockHours: 48 } };
  if (viewMemo.v && Date.now() - viewMemo.at < 20_000) return viewMemo.v;
  if (viewMemo.p) return viewMemo.p;
  viewMemo.p = (async () => {
    const [d, s, ethUsd, wt] = await Promise.all([readVault(c.vault), store.readJson(STATE, {}), import("./market.mjs").then((m) => m.getEthUsd()).catch(() => null), weights(null).catch(() => ({ targets: {}, driftBps: 500 }))]);
    const supply = d.supply;
    let totalWei = 0n;
    const rows = [];
    for (const a of d.assets) {
      const sqrt = a.venue ? (a.venue.median || a.venue.spot) : null;
      const wei = ethValue(a.address, a.holding, a.venue, sqrt);
      if (wei != null) totalWei += wei;
      const unit = 10n ** BigInt(a.decimals);
      const perUnitEth = a.venue && sqrt ? Number(formatEther(ethValue(a.address, unit, a.venue, sqrt))) : lc(a.address) === lc(ETH) ? 1 : null;
      const pr = await priceUsd(a.address, ethUsd, perUnitEth);
      const amount = Number(formatUnits(a.holding, a.decimals));
      rows.push({ address: a.address, symbol: a.symbol, decimals: a.decimals, amount, raw: a.holding.toString(), valueEth: wei != null ? Number(formatEther(wei)) : null,
        priceUsd: pr.usd, priceSource: pr.source, valueUsd: pr.usd != null ? amount * pr.usd : null, buyable: a.buyable, venueId: a.venueId,
        venue: a.venue ? { id: a.venue.id, kind: a.venue.kind === 1 ? "Uniswap v3" : "Uniswap v4", pool: a.venue.pool, reads: a.venue.reads, slippageBps: a.venue.slippageBps } : null,
        targetPct: wt.targets[lc(a.address)] ?? 0 });
    }
    const totalEth = Number(formatEther(totalWei));
    for (const r of rows) r.weightPct = totalEth > 0 && r.valueEth != null ? (r.valueEth / totalEth) * 100 : 0;
    const totalUsd = rows.reduce((x, r) => x + (r.valueUsd || 0), 0);
    const sup = Number(formatEther(supply));
    const events = s.events || [];
    const pending = [];
    for (const ev of events.filter((e) => e.name === "ChangeProposed")) {
      let eta = 0; try { eta = Number((await vcall("etaOf", [ev.id]))[0]); } catch {}
      if (eta) pending.push({ id: ev.id, op: OPS[ev.op], text: ev.text, eta, executableFrom: new Date(eta * 1000).toISOString(), expiresAt: new Date((eta + 7 * 86400) * 1000).toISOString(), tx: ev.tx, link: `${EXPLORER}/tx/${ev.tx}` });
    }
    const lastReb = [...events].reverse().find((e) => e.name === "Rebalanced");
    const link = (a) => `${EXPLORER}/address/${a}`;
    const v = {
      ...base, deployed: true,
      contracts: { vault: { address: d.vault, link: link(d.vault) }, zap: c.zap ? { address: c.zap, link: link(c.zap) } : null, swapper: { address: d.swapper, link: link(d.swapper) } },
      owner: d.owner, pendingOwner: /^0x0{40}$/i.test(d.pendingOwner) ? null : d.pendingOwner, ownerIsSafe: lc(d.owner) === lc(SAFE),
      holdings: rows, nav: { totalEth, totalUsd, perTidxEth: sup > 0 ? totalEth / sup : null, perTidxUsd: sup > 0 ? totalUsd / sup : null, ethUsd },
      supply: sup, caps: { total: Number(formatEther(d.totalCap)), wallet: Number(formatEther(d.walletCap)), usedPct: d.totalCap > 0n ? (sup / Number(formatEther(d.totalCap))) * 100 : 0 },
      fee: { pct: d.feeBps / 100, recipient: d.feeRecipient, recipientIsFeeRouter: lc(d.feeRecipient) === lc(FEE_ROUTER), accruedEth: Number(formatEther(d.feesAccrued)),
        mgmtPctPerYear: d.mgmtFeeBps / 100, mgmtRecipient: d.mgmtFeeRecipient, lastAccrual: d.lastAccrual, maxDepositPct: 2, maxMgmtPctPerYear: 2 },
      rules: { maxMovePct: d.maxMoveBps / 100, cooldownHours: d.cooldown / 3600, timelockHours: 48, nextRebalanceAt: d.nextAt, lastRebalanceAt: d.lastAt },
      paused: { deposits: d.depositsPaused, rebalances: d.rebalancesPaused }, ethOnly: d.assets.every((a) => lc(a.address) === lc(ETH) || a.holding === 0n),
      keeper: { ...keeper, onChain: d.keeper, matches: !!keeperAddr && lc(d.keeper) === lc(keeperAddr) },
      lastRebalance: lastReb ? { tx: lastReb.tx, link: `${EXPLORER}/tx/${lastReb.tx}`, block: lastReb.block, assetIn: SYMBOL[lc(lastReb.assetIn)] || lastReb.assetIn, assetOut: SYMBOL[lc(lastReb.assetOut)] || lastReb.assetOut } : (s.lastRebalance || null),
      pending, recent: events.slice(-12).reverse().map((e) => ({ name: e.name, tx: e.tx, block: e.block, text: e.text || null })),
      zapVenues: rows.map((r) => r.venueId ?? 0), targets: wt.targets, driftPct: wt.driftBps / 100, weights: await weightsView(),
      updatedAt: Date.now(),
    };
    viewMemo = { at: Date.now(), v, p: null };
    return v;
  })().finally(() => { viewMemo.p = null; });
  return viewMemo.p;
}

export async function meView(wallet) {
  const c = cfg();
  if (!isAddress(wallet || "")) throw new HttpError(400, "That is not a wallet address.");
  if (!c.vault) return { deployed: false };
  const a = getAddress(wallet);
  const v = await indexView();
  const [bal] = await vcall("balanceOf", [a]);
  const [out] = await vcall("previewRedeem", [bal]);
  const owed = [];
  for (const h of v.holdings) { const [o] = await vcall("owed", [a, h.address]); if (o > 0n) owed.push({ asset: h.address, symbol: h.symbol, amount: Number(formatUnits(o, h.decimals)), raw: o.toString() }); }
  const redeem = v.holdings.map((h, i) => { const amt = Number(formatUnits(out[i] ?? 0n, h.decimals)); return { asset: h.address, symbol: h.symbol, amount: amt, raw: (out[i] ?? 0n).toString(), valueUsd: h.priceUsd != null ? amt * h.priceUsd : null }; });
  const shares = Number(formatEther(bal));
  return { deployed: true, wallet: a, shares, sharesRaw: bal.toString(), sharePct: v.supply > 0 ? (shares / v.supply) * 100 : 0, redeemNow: redeem, redeemUsd: redeem.reduce((x, r) => x + (r.valueUsd || 0), 0), owed, walletCapLeft: Math.max(0, v.caps.wallet - shares) };
}

export async function register(r, ctx) {
  store = ctx.store;
  dir = ctx.dataDir;
  provider = new JsonRpcProvider(cfg().rpc, 4663, { staticNetwork: true });
  try {
    const w = await loadOrCreateKeeper();
    keeperAddr = w.address;
    if (isTeamWallet(w.address, await extraTeam())) refused = `Refused: the keeper key ${w.address} is a team wallet.`;
  } catch (e) { refused = `Keeper key unavailable: ${e.message}`; console.warn("[index-keeper]", refused); }
  r.get("/api/index", () => indexView(), { weight: 2, perMin: 120 });
  r.get("/api/index/me/:wallet", ({ params }) => meView(params.wallet), { weight: 2, perMin: 120 });
  const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const admin = async (req) => { const { getSession } = await import("./auth.mjs"); const s = getSession(req); if (!s || !admins().includes(lc(s.address))) throw new HttpError(403, "Admins only."); };
  r.get("/api/index/weights", () => weightsView(), { perMin: 120 });
  r.post("/api/index/weights", async ({ req, body }) => { await admin(req); return weightsView(await scheduleWeights(body || {})); }, { perMin: 10 });
  r.post("/api/index/weights/cancel", async ({ req }) => { await admin(req); await cancelWeights(); return weightsView(); }, { perMin: 10 });
  r.get("/api/index/keeper", async () => {
    const c = cfg();
    let balanceEth = null; try { balanceEth = Number(formatEther(BigInt(await rpc("eth_getBalance", [keeperAddr, "latest"])))); } catch {}
    return { address: keeperAddr, enabled: c.enabled, refused, balanceEth, vault: c.vault, note: "The keeper can only make the vault swap with itself (pokeAll and rebalance). Fund it with a little ETH for gas." };
  }, { perMin: 60 });
  const c = cfg();
  if (process.env.INDEX_OFF !== "1" && c.vault) {
    setInterval(() => scanEvents().catch((e) => console.warn("[index-keeper] events", e.message)), 5 * 60_000).unref?.();
    setTimeout(() => scanEvents().catch(() => {}), 60_000).unref?.();
    setInterval(() => activateDueWeights().catch((e) => console.warn("[index-keeper] weights", e.message)), 5 * 60_000).unref?.();
    if (c.enabled) setInterval(() => keeperTick().then((x) => x.error && console.warn("[index-keeper]", x.error)), c.everyMin * 60_000).unref?.();
  }
}
