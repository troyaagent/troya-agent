// V10 F61 Pharos: Storm Watch. A lighthouse for the routes in and out of Robinhood Chain (4663). Every PHAROS_EVERY_MIN
// minutes (default 12, kept between 10 and 15) it reads the on-chain settings that matter before you cross, keeps the
// snapshot in data/pharos.json, and logs every change:
//   - Robinhood Chain's Arbitrum Orbit core contracts on its parent chain, Ethereum: RollupProxy, Bridge, Inbox,
//     SequencerInbox, Outbox, EdgeChallengeManager, UpgradeExecutor, both ProxyAdmins, the 7-day TimelockController, the
//     canonical token gateways, and the four Robinhood Safes (threshold, owner set, singleton, nonce). Proxies are read at
//     their EIP-1967 implementation and admin slots (the RollupProxy also at its secondary slot).
//   - On Robinhood Chain itself: the L2 UpgradeExecutor and TimelockController, the L2 Safes, the chain owners
//     (ArbOwnerPublic precompile 0x6b), and the LI.FI contracts every Troya bridge route from Robinhood Chain goes through
//     (LiFiDiamond: owner and facet list, its timelock and Safe). LI.FI's Ethereum diamond is read the same way.
//   - Chain health: the age of Robinhood Chain's latest block, its block rate, how far its view of Ethereum lags the
//     Ethereum head, and whether new batches keep landing in the SequencerInbox.
// Addresses: Robinhood docs (docs.robinhood.com/chain/protocol-contracts) and ETHBEAT (ex-L2BEAT,
// ethbeat.org/scaling/projects/robinhood), checked on chain 25 Nov 2026; LI.FI: github.com/lifinance/contracts deployments.
// Not read (yet): LayerZero OFT DVN configs on Robinhood Chain (no OFT Troya sees could be read reliably in this version).
// Alerts: pharosAlertText(change) writes the post. Nothing is posted unless PHAROS_ALERTS=1 (owner approval):
//   PHAROS_ALERTS=1 + PHAROS_TG_CHAT=@chat → Telegram (TELEGRAM_BOT_TOKEN) · PHAROS_ALERTS_X=1 as well → X (xsocial.postTweet)
// An alert describes a change; it is never a call to buy or sell.
import { id as keccakId, getAddress } from "ethers";

const FILE = "pharos.json";
const EVERY_MIN = Math.min(15, Math.max(10, Number(process.env.PHAROS_EVERY_MIN) || 12));
const EVERY = EVERY_MIN * 60_000;
const ALERTS = process.env.PHAROS_ALERTS === "1";
const ALERTS_X = ALERTS && process.env.PHAROS_ALERTS_X === "1";
const TG_CHAT = process.env.PHAROS_TG_CHAT || "";
const RECENT_MS = 7 * 86400_000;
const lc = (s) => String(s || "").toLowerCase();
let store = null, running = null, lastRunAt = 0;

const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPL2 = "0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d"; // Arbitrum AdminFallbackProxy secondary
const EXECUTOR_ROLE = keccakId("EXECUTOR_ROLE"), PROPOSER_ROLE = keccakId("PROPOSER_ROLE");
const pad = (a) => lc(a).replace(/^0x/, "").padStart(64, "0");

const A = {
  rollup: "0x23A19d23e89166adedbDcB432518AB01e4272D94", bridge: "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3", inbox: "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D",
  seqInbox: "0xBd0D173EEb87D57A09521c24388a12789F33ba96", outbox: "0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9", challenge: "0x6f38FC91105Fc9a43931DcA33450ab3315E3D4Fa",
  upgradeExecutor: "0x552603b4bc1f5E896AF2854548D6380f45f1B4bf", proxyAdmin: "0x1232813BDd40aa9d53066A880dE78a4Be70B90FD", proxyAdmin2: "0x4e393071053C5d95771b1B716857d65cdf5B1839",
  timelock: "0xE1e825D15192457d05a251715C3e2Cab0F8CF465", batchPoster: "0xDaa526086787d9DEbE1D7F3FFdb1fE50cf8687F4",
  ms1: "0x7Ae50886c7EA0394613aa7Dcc287a5c9650784b6", ms2: "0xbFc2b53552513174A0B006D4799B39871fe0CA1d", ms3: "0x0fc5c64074641e677Fb86bCE80303a2eE64344Ac", ms4: "0x1F3Bdec08A161Ca9e5480feF33A3B2278c2931C5",
  gatewayRouter: "0x6a2E3a1e16FC29f27Ce61429746D558d656975bB", erc20Gateway: "0x85001CC4867C5e1C22dA4B79BB8852B9e2a06da0", wethGateway: "0xF7e12b9614b509C747ab4423bC4ACF923759Cf1B", customGateway: "0x9368EAEbFe6E063C69dcF8126711A6997E0eCeE1",
  // on Robinhood Chain
  l2UpgradeExecutor: "0x2A153c6A1B66DBc930a8d7017230ab0253005C09", l2Timelock: "0x560C81fe78FcC276e460524428f1a62057Ca8173",
  l2ms1: "0x6b9F63817F1442e40Bb9c3C2207758934C323FdC", l2ms2: "0x4C0360aFedD31e53718e4343F95E40b692402462", l2ms3: "0x3A0C507Cc7F8785C877359ad49d0476966d17a1C", l2ms4: "0x59f83b75bD225b9c9981B04982639625c88dFb1E",
  arbOwnerPublic: "0x000000000000000000000000000000000000006b",
  lifiDiamondRh: "0xB477751B76CF82d00a686A1232f5fCD772414Af3", lifiTimelockRh: "0x6E9Beb6997dAE04122f1f8f8980f3dc8225443F3", lifiSafeRh: "0xE49447936F02d8be7c2b37de03329bFa8EaDa6B6",
  lifiDiamondEth: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", lifiTimelockEth: "0x55117ECcC867Db72aEb25f728CCf57C3C3B4faEe", lifiSafeEth: "0xE3C8121DF9b1c5A7d383Ab4923fF848a6510F357",
};

// one read spec per field: slot (storage) or call (eth_call), and how to decode it
const slot = (f, label, s) => ({ f, label, kind: "slot", slot: s, type: "address" });
const call = (f, label, sig, type, args = "") => ({ f, label, kind: "call", data: keccakId(sig).slice(0, 10) + args, type });
const proxy = () => [slot("impl", "Implementation (EIP-1967)", IMPL), slot("admin", "Proxy admin (EIP-1967)", ADMIN)];
const safe = () => [call("threshold", "Signatures needed", "getThreshold()", "uint"), call("owners", "Signers", "getOwners()", "addresses"),
  { ...slot("singleton", "Safe singleton (slot 0)", "0x0") }, { ...call("nonce", "Transactions executed", "nonce()", "uint"), activity: true }];
const ethc = "ethereum", rhc = "robinhood";
// group: which routes an item touches. "robinhood" = every crossing in or out of Robinhood Chain; "lifi-rh" = every LI.FI
// route that starts on Robinhood Chain; "lifi-eth" = every LI.FI route that starts on Ethereum.
export const ITEMS = [
  { key: "rollup", chain: ethc, group: "robinhood", label: "RollupProxy (the chain's state and validators)", address: A.rollup, reads: [...proxy(), slot("impl2", "Secondary implementation", IMPL2),
    call("owner", "Owner", "owner()", "address"), call("paused", "Paused", "paused()", "bool"), call("confirmPeriodBlocks", "Challenge period (Ethereum blocks)", "confirmPeriodBlocks()", "uint"),
    call("wasmModuleRoot", "State machine (wasmModuleRoot)", "wasmModuleRoot()", "bytes32"), call("validatorWhitelistDisabled", "Anyone may validate", "validatorWhitelistDisabled()", "bool"),
    call("validators", "Whitelisted validators", "getValidators()", "addresses"), call("baseStake", "Validator stake (wei)", "baseStake()", "uint")] },
  { key: "bridge", chain: ethc, group: "robinhood", label: "Bridge (holds the ETH bridged in)", address: A.bridge, reads: proxy() },
  { key: "inbox", chain: ethc, group: "robinhood", label: "Inbox (deposits and forced transactions)", address: A.inbox, reads: [...proxy(), call("paused", "Paused", "paused()", "bool")] },
  { key: "seqInbox", chain: ethc, group: "robinhood", label: "SequencerInbox (batches)", address: A.seqInbox, reads: [...proxy(), call("maxTimeVariation", "Force-inclusion delay settings", "maxTimeVariation()", "raw"),
    call("batchPoster", "Known batch poster still allowed", "isBatchPoster(address)", "bool", pad(A.batchPoster))] },
  { key: "outbox", chain: ethc, group: "robinhood", label: "Outbox (withdrawals to Ethereum)", address: A.outbox, reads: proxy() },
  { key: "challenge", chain: ethc, group: "robinhood", label: "EdgeChallengeManager (fraud proofs)", address: A.challenge, reads: proxy() },
  { key: "upgradeExecutor", chain: ethc, group: "robinhood", label: "UpgradeExecutor (runs every upgrade)", address: A.upgradeExecutor, reads: [...proxy(),
    call("execMs1", "Multisig 1 (7/8) may upgrade with no delay", "hasRole(bytes32,address)", "bool", pad(EXECUTOR_ROLE) + pad(A.ms1)),
    call("execTimelock", "TimelockController may upgrade", "hasRole(bytes32,address)", "bool", pad(EXECUTOR_ROLE) + pad(A.timelock))] },
  { key: "proxyAdmin", chain: ethc, group: "robinhood", label: "ProxyAdmin (core contracts)", address: A.proxyAdmin, reads: [call("owner", "Owner", "owner()", "address")] },
  { key: "proxyAdmin2", chain: ethc, group: "robinhood", label: "ProxyAdmin 2 (timelock)", address: A.proxyAdmin2, reads: [call("owner", "Owner", "owner()", "address")] },
  { key: "timelock", chain: ethc, group: "robinhood", label: "TimelockController (the 7-day path)", address: A.timelock, reads: [slot("impl", "Implementation (EIP-1967)", IMPL),
    call("minDelay", "Minimum delay (seconds)", "getMinDelay()", "uint"), call("proposerMs2", "Multisig 2 (6/8) proposes", "hasRole(bytes32,address)", "bool", pad(PROPOSER_ROLE) + pad(A.ms2))] },
  { key: "ms1", chain: ethc, group: "robinhood", label: "Robinhood Multisig 1 (upgrades with no delay)", address: A.ms1, reads: safe() },
  { key: "ms2", chain: ethc, group: "robinhood", label: "Robinhood Multisig 2 (upgrades through the 7-day timelock)", address: A.ms2, reads: safe() },
  { key: "ms3", chain: ethc, group: "robinhood", label: "Robinhood Multisig 3 (signer in Multisigs 1 and 2)", address: A.ms3, reads: safe() },
  { key: "ms4", chain: ethc, group: "robinhood", label: "Robinhood Multisig 4", address: A.ms4, reads: safe() },
  { key: "gatewayRouter", chain: ethc, group: "robinhood", label: "L1GatewayRouter (canonical token bridge)", address: A.gatewayRouter, reads: [...proxy(), call("owner", "Owner", "owner()", "address")] },
  { key: "erc20Gateway", chain: ethc, group: "robinhood", label: "L1ERC20Gateway", address: A.erc20Gateway, reads: proxy() },
  { key: "wethGateway", chain: ethc, group: "robinhood", label: "L1 WETH Gateway", address: A.wethGateway, reads: proxy() },
  { key: "customGateway", chain: ethc, group: "robinhood", label: "L1 Custom Gateway", address: A.customGateway, reads: [...proxy(), call("owner", "Owner", "owner()", "address")] },
  { key: "l2UpgradeExecutor", chain: rhc, group: "robinhood", label: "L2 UpgradeExecutor", address: A.l2UpgradeExecutor, reads: proxy() },
  { key: "l2Timelock", chain: rhc, group: "robinhood", label: "L2 TimelockController", address: A.l2Timelock, reads: [slot("impl", "Implementation (EIP-1967)", IMPL), call("minDelay", "Minimum delay (seconds)", "getMinDelay()", "uint")] },
  { key: "chainOwners", chain: rhc, group: "robinhood", label: "Chain owners (ArbOwnerPublic)", address: A.arbOwnerPublic, reads: [call("owners", "Chain owners", "getAllChainOwners()", "addresses")] },
  { key: "l2ms1", chain: rhc, group: "robinhood", label: "Robinhood L2 Multisig 1", address: A.l2ms1, reads: safe() },
  { key: "l2ms2", chain: rhc, group: "robinhood", label: "Robinhood L2 Multisig 2", address: A.l2ms2, reads: safe() },
  { key: "l2ms3", chain: rhc, group: "robinhood", label: "Robinhood L2 Multisig 3", address: A.l2ms3, reads: safe() },
  { key: "l2ms4", chain: rhc, group: "robinhood", label: "Robinhood L2 Multisig 4 (gas pricing)", address: A.l2ms4, reads: safe() },
  { key: "lifiDiamondRh", chain: rhc, group: "lifi-rh", label: "LI.FI Diamond on Robinhood Chain (every Troya bridge route from here)", address: A.lifiDiamondRh,
    reads: [call("owner", "Owner", "owner()", "address"), call("facets", "Code modules (facets)", "facetAddresses()", "addresses")] },
  { key: "lifiTimelockRh", chain: rhc, group: "lifi-rh", label: "LI.FI timelock on Robinhood Chain", address: A.lifiTimelockRh, reads: [call("minDelay", "Minimum delay (seconds)", "getMinDelay()", "uint")] },
  { key: "lifiSafeRh", chain: rhc, group: "lifi-rh", label: "LI.FI Safe on Robinhood Chain", address: A.lifiSafeRh, reads: safe() },
  { key: "lifiDiamondEth", chain: ethc, group: "lifi-eth", label: "LI.FI Diamond on Ethereum", address: A.lifiDiamondEth,
    reads: [call("owner", "Owner", "owner()", "address"), call("facets", "Code modules (facets)", "facetAddresses()", "addresses")] },
  { key: "lifiTimelockEth", chain: ethc, group: "lifi-eth", label: "LI.FI timelock on Ethereum", address: A.lifiTimelockEth, reads: [call("minDelay", "Minimum delay (seconds)", "getMinDelay()", "uint")] },
  { key: "lifiSafeEth", chain: ethc, group: "lifi-eth", label: "LI.FI Safe on Ethereum", address: A.lifiSafeEth, reads: safe() },
];
const GROUP_CHAINS = { robinhood: [4663], "lifi-rh": [4663], "lifi-eth": [1] };
const GROUP_LABEL = { robinhood: "Robinhood Chain core", "lifi-rh": "LI.FI on Robinhood Chain", "lifi-eth": "LI.FI on Ethereum" };
// the fields whose change matters most (who can upgrade, what code runs, how many must sign, how long the wait is)
const HIGH = new Set(["impl", "impl2", "admin", "owner", "owners", "threshold", "minDelay", "execMs1", "execTimelock", "proposerMs2", "facets", "wasmModuleRoot", "paused", "singleton", "validatorWhitelistDisabled"]);

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(chain, method, params) {
  const R = await import("./robinhood.mjs");
  return timeout(R.rpc(chain, method, params, chain === "robinhood" ? { bg: true, module: "pharos" } : {}), 12_000);
}
function decode(type, hex) {
  const h = String(hex || "0x").replace(/^0x/, "");
  if (type === "raw") return "0x" + h;
  if (!h.length) throw new Error("empty answer");
  const word = (i) => h.slice(i * 64, (i + 1) * 64);
  if (type === "address") return getAddress("0x" + word(0).slice(24));
  if (type === "uint") return BigInt("0x" + word(0)).toString();
  if (type === "bool") return BigInt("0x" + word(0)) !== 0n ? "true" : "false";
  if (type === "bytes32") return "0x" + word(0);
  if (type === "addresses") {
    const off = Number(BigInt("0x" + word(0))) / 32, n = Number(BigInt("0x" + word(off)));
    if (n > 200) throw new Error("list too long");
    const out = [];
    for (let i = 0; i < n; i++) out.push(getAddress("0x" + word(off + 1 + i).slice(24)));
    return out.map(lc).sort().join(",");
  }
  return "0x" + h;
}
async function readField(item, r) {
  const hex = r.kind === "slot" ? await rpc(item.chain, "eth_getStorageAt", [item.address, r.slot, "latest"]) : await rpc(item.chain, "eth_call", [{ to: item.address, data: r.data }, "latest"]);
  return decode(r.type, hex);
}
const short = (a) => (/^0x[0-9a-f]{40}$/i.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
// how a value reads to a person
export function display(f, v) {
  if (v == null) return "unread";
  if (f === "owners" || f === "validators" || f === "facets") { const n = v ? v.split(",").length : 0; return `${n} address${n === 1 ? "" : "es"}`; }
  if (f === "minDelay") { const s = Number(v); return s >= 86400 ? `${+(s / 86400).toFixed(2)} days` : s >= 3600 ? `${+(s / 3600).toFixed(2)} hours` : `${s} seconds`; }
  if (f === "confirmPeriodBlocks") return `${v} blocks (about ${+((Number(v) * 12) / 86400).toFixed(1)} days)`;
  if (f === "baseStake") return `${Number(BigInt(v) / 10n ** 14n) / 1e4} ETH`;
  if (f === "maxTimeVariation" && v.length >= 2 + 256) { const w = (i) => Number(BigInt("0x" + v.slice(2 + i * 64, 2 + (i + 1) * 64))); return `delay ${w(0)} blocks / ${+(w(2) / 86400).toFixed(1)} days, future ${w(1)} blocks / ${w(3)} s`; }
  if (v === "true") return "yes"; if (v === "false") return "no";
  return short(v);
}

async function snapshot() {
  const prev = await store.readJson(FILE, { items: {}, changes: [], activity: [], runs: 0 });
  const now = Date.now();
  const items = {}, changes = [], activity = [];
  for (const it of ITEMS) {
    const old = prev.items?.[it.key] || {};
    const values = { ...(old.values || {}) }, errors = {}, lastChange = { ...(old.lastChange || {}) };
    for (const r of it.reads) {
      let v;
      try { v = await readField(it, r); } catch (e) { errors[r.f] = String(e.message || e).slice(0, 120); await sleep(150); continue; }
      const before = old.values?.[r.f];
      if (before != null && before !== v) {
        const rec = { at: now, key: it.key, label: it.label, chain: it.chain, group: it.group, address: it.address, f: r.f, field: r.label, from: before, to: v, fromText: display(r.f, before), toText: display(r.f, v) };
        if (r.activity) activity.push({ ...rec, text: `${it.label}: ${Math.max(0, Number(v) - Number(before))} transaction(s) executed (nonce ${before} → ${v}).` });
        else { rec.severity = HIGH.has(r.f) ? "high" : "medium"; changes.push(rec); lastChange[r.f] = now; }
      }
      values[r.f] = v;
      await sleep(it.chain === "ethereum" ? 120 : 80);
    }
    items[it.key] = { values, errors, lastChange, checkedAt: now, baselineAt: old.baselineAt || now };
  }
  const health = await readHealth(prev.health).catch((e) => ({ status: "unknown", reasons: [`Health could not be read: ${e.message}`], checkedAt: now }));
  const out = await store.update(FILE, { items: {}, changes: [], activity: [], runs: 0 }, (d) => {
    d.items = items; d.health = health; d.runs = (d.runs || 0) + 1; d.lastRun = now; d.firstRun ||= now;
    d.changes = [...changes, ...(d.changes || [])].slice(0, 300);
    d.activity = [...activity, ...(d.activity || [])].slice(0, 200);
    return d;
  });
  lastRunAt = now;
  if (changes.length && ALERTS) for (const c of changes.filter((x) => x.severity === "high").slice(0, 3)) await postAlert(c).catch(() => {});
  return { changes, activity, health, runs: out.runs };
}

async function readHealth(prev = {}) {
  const now = Date.now(), reasons = [];
  const [b, ethHead, batch] = await Promise.all([
    rpc("robinhood", "eth_getBlockByNumber", ["latest", false]),
    rpc("ethereum", "eth_blockNumber", []).then((x) => parseInt(x, 16)),
    rpc("ethereum", "eth_call", [{ to: A.seqInbox, data: keccakId("batchCount()").slice(0, 10) }, "latest"]).then((x) => Number(BigInt(x))),
  ]);
  const block = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16) * 1000, l1Block = b.l1BlockNumber ? parseInt(b.l1BlockNumber, 16) : null;
  const ageSec = Math.max(0, Math.round((now - ts) / 1000));
  const rate = prev.block && prev.checkedAt && block >= prev.block ? (block - prev.block) / ((now - prev.checkedAt) / 1000) : null;
  const l1LagBlocks = l1Block != null ? ethHead - l1Block : null;
  const lastBatchAt = prev.batchCount != null && batch === prev.batchCount ? prev.lastBatchAt || prev.checkedAt : now;
  const batchQuietMin = prev.batchCount != null ? Math.round((now - lastBatchAt) / 60_000) : null;
  let status = "ok";
  const bump = (s) => { if (s === "bad" || (s === "warn" && status === "ok")) status = s; };
  if (ageSec > 300) { bump("bad"); reasons.push(`Robinhood Chain's latest block is ${Math.round(ageSec / 60)} minutes old: the chain may be halted.`); }
  else if (ageSec > 60) { bump("warn"); reasons.push(`Robinhood Chain's latest block is ${ageSec} seconds old (usually a second or two).`); }
  if (l1LagBlocks != null && l1LagBlocks > 300) { bump("bad"); reasons.push(`Robinhood Chain's view of Ethereum is ${l1LagBlocks} blocks behind.`); }
  else if (l1LagBlocks != null && l1LagBlocks > 75) { bump("warn"); reasons.push(`Robinhood Chain's view of Ethereum is ${l1LagBlocks} blocks behind (about ${Math.round((l1LagBlocks * 12) / 60)} minutes).`); }
  if (batchQuietMin != null && batchQuietMin > 360) { bump("bad"); reasons.push(`No new batch reached Ethereum for ${Math.round(batchQuietMin / 60)} hours.`); }
  else if (batchQuietMin != null && batchQuietMin > 60) { bump("warn"); reasons.push(`No new batch reached Ethereum for ${batchQuietMin} minutes.`); }
  if (!reasons.length) reasons.push("Blocks are fresh, Robinhood Chain follows Ethereum closely and batches keep landing.");
  return { status, reasons, block, blockTime: ts, ageSec, blocksPerSec: rate != null ? +rate.toFixed(2) : null, l1Block, ethHead, l1LagBlocks, batchCount: batch, lastBatchAt, batchQuietMin, checkedAt: now };
}

/** The alert text for one change (used only when PHAROS_ALERTS=1; the owner approves automatic posts). */
export function pharosAlertText(c) {
  const where = c.chain === "ethereum" ? "on Ethereum" : "on Robinhood Chain";
  const when = new Date(c.at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [`Pharos storm watch: a setting changed on a route in or out of Robinhood Chain.`, ``,
    `${c.label} (${short(c.address)} ${where})`, `${c.field}: ${c.fromText} → ${c.toText}`, `Seen ${when}.`, ``,
    `A change is not proof of harm. Read what changed before you cross: troya.codes/agent#/scylla`].join("\n");
}
async function postAlert(c) {
  if (!ALERTS) return;
  const text = pharosAlertText(c);
  if (TG_CHAT && process.env.TELEGRAM_BOT_TOKEN)
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(15_000) }).catch(() => {});
  if (ALERTS_X) {
    // X keeps the link: a short form under 280 characters instead of the Telegram text cut mid-sentence
    const where = c.chain === "ethereum" ? "on Ethereum" : "on Robinhood Chain";
    let x = `Pharos storm watch: ${c.label} ${where}, ${c.field} changed: ${c.fromText} → ${c.toText}. Not proof of harm; read it before you cross: troya.codes/agent#/scylla`;
    if (x.length > 280) x = `Pharos storm watch: ${String(c.label).slice(0, 60)} ${where}, ${String(c.field).slice(0, 40)} changed. Not proof of harm; read it before you cross: troya.codes/agent#/scylla`;
    await import("./xsocial.mjs").then((m) => m.postTweet(x)).catch(() => {});
  }
}

/** For Scylla: warnings for routes touching these chain ids (recent setting changes, chain health). */
export async function stormFor(chainIds = []) {
  if (!store) return { level: "unknown", warnings: [], watched: false };
  const d = await store.readJson(FILE, null);
  if (!d?.lastRun) return { level: "unknown", warnings: ["Storm watch has not taken its first reading yet."], watched: false };
  const ids = new Set(chainIds.map(Number)), now = Date.now(), warnings = [];
  let level = "calm";
  const recent = (d.changes || []).filter((c) => now - c.at < RECENT_MS && (GROUP_CHAINS[c.group] || []).some((x) => ids.has(x)));
  for (const c of recent.slice(0, 5)) {
    const mins = Math.round((now - c.at) / 60_000), ago = mins < 60 ? `${Math.max(1, mins)} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
    warnings.push(`${GROUP_LABEL[c.group]}: ${c.label}, ${c.field} changed ${ago} ago (${c.fromText} → ${c.toText}).`);
    if (c.severity === "high") level = now - c.at < 86400_000 ? "storm" : level === "storm" ? "storm" : "watch";
    else if (level === "calm") level = "watch";
  }
  if (ids.has(4663) && d.health && d.health.status !== "ok") { warnings.push(...d.health.reasons); level = d.health.status === "bad" ? "storm" : level === "calm" ? "watch" : level; }
  if (now - d.lastRun > 3 * EVERY) warnings.push(`The last storm-watch reading is ${Math.round((now - d.lastRun) / 60_000)} minutes old.`);
  return { level, warnings, recent: recent.slice(0, 5), watched: true, lastRun: d.lastRun, health: ids.has(4663) ? d.health?.status : undefined };
}

export async function pharosState() {
  const d = await store.readJson(FILE, { items: {}, changes: [], activity: [], runs: 0 });
  return {
    name: "Troya Pharos", every: `${EVERY_MIN} minutes`, alerts: ALERTS ? (ALERTS_X ? "Telegram and X" : TG_CHAT ? "Telegram" : "on, no chat set") : "off (needs the owner's approval: PHAROS_ALERTS=1)",
    lastRun: d.lastRun || null, firstRun: d.firstRun || null, nextRunAt: d.lastRun ? d.lastRun + EVERY : null, runs: d.runs || 0, health: d.health || null,
    items: ITEMS.map((it) => {
      const s = d.items?.[it.key] || {};
      const lc_ = Object.values(s.lastChange || {});
      return { key: it.key, label: it.label, chain: it.chain, group: it.group, groupLabel: GROUP_LABEL[it.group], address: it.address, checkedAt: s.checkedAt || null, watchedSince: s.baselineAt || null,
        lastChange: lc_.length ? Math.max(...lc_) : null,
        fields: it.reads.map((r) => ({ f: r.f, label: r.label, value: s.values?.[r.f] ?? null, text: display(r.f, s.values?.[r.f]), lastChange: s.lastChange?.[r.f] || null, error: s.errors?.[r.f] || null, activity: !!r.activity })) };
    }),
    changes: (d.changes || []).slice(0, 60), activity: (d.activity || []).slice(0, 30),
    sources: ["https://docs.robinhood.com/chain/protocol-contracts", "https://ethbeat.org/scaling/projects/robinhood", "https://github.com/lifinance/contracts/blob/main/deployments/robinhood.json"],
    limits: "Reads public settings only; a change is logged from the moment Pharos first saw the setting (its baseline), not before. A change is not proof of harm, and no change is not proof of safety. LayerZero OFT DVN settings are not read in this version.",
  };
}

async function tick() {
  if (running) return running;
  running = snapshot().catch((e) => { console.warn("[pharos]", e.message); }).finally(() => { running = null; });
  return running;
}
export const pharosTick = tick;

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/pharos", () => pharosState(), { weight: 1, perMin: 120 });
  if (process.env.PHAROS_OFF !== "1") {
    setInterval(() => tick(), EVERY).unref?.();
    setTimeout(() => tick(), 90_000).unref?.();
  }
}
