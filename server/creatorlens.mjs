// Creator lens (holder review idea D, 27 Nov 2026): for a Pons coin, who takes its creator fee and how much that wallet has
// collected, and every coin the same deployer launched, with what Troya's Gate said at each launch. The VLAD case on Robinhood
// Chain (liquidity locked for good while the creator kept claiming trading fees) is what this makes visible.
// Read from the chain through Blockscout PRO's log index, one call each:
//   PonsFactory TokenLaunched  topics [sig, token, curve, deployer]        → the deployer's coins
//   Pons fee escrow Credited   topics [sig, recipient, source], data amount → ETH credited to the fee recipient
//   Pons fee escrow Claimed    topics [sig, recipient], data amount         → ETH the recipient took out
// The escrow keys credits by wallet, not by coin, so the fee figures cover every coin that wallet receives fees from; the
// page says so. Shown as information, not scored. Cached 10 minutes per coin. Nothing here trades.
import { getAddress } from "ethers";
import { ADDR, ponsState } from "./robinhood.mjs";

const LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const ESCROW = "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e";
const CREDITED = "0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5";
const CLAIMED = "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";
const TTL = 10 * 60_000;
const memo = new Map();
const lc = (a) => String(a || "").toLowerCase();
const pad = (a) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const eth = (logs) => Number(logs.reduce((s, l) => s + BigInt("0x" + (String(l.data || "0x").slice(2, 66) || "0")), 0n)) / 1e18;

async function logs(q) {
  const key = process.env.BLOCKSCOUT_API_KEY || "";
  if (!key) return null;
  const u = `https://api.blockscout.com/4663/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&apikey=${key}&${q}`;
  // Blockscout's log index is sometimes slow on a wide filter (7 s to over 15 s for the same query): 30 s, then one retry
  for (let i = 0; i < 2; i++) {
    const j = await fetch(u, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null);
    if (Array.isArray(j?.result)) return j.result;
    if (j?.message === "No records found") return [];
  }
  return null;
}
// a deployer's launches change rarely: kept 6 hours once read
const devMemo = new Map();
async function launchesOf(deployer) {
  const k = lc(deployer), hit = devMemo.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  const v = await logs(`address=${ADDR.ponsFactory}&topic0=${LAUNCH}&topic3=${pad(deployer)}&topic0_3_opr=and`);
  if (v) { devMemo.set(k, { at: Date.now(), v }); if (devMemo.size > 2000) devMemo.delete(devMemo.keys().next().value); }
  return v;
}

async function compute(token) {
  const ps = await ponsState(token).catch(() => null);
  if (!ps) return { pons: false };
  const deployer = ps.deployer ? getAddress(lc(ps.deployer)) : null;
  const recipient = ps.creatorFeeRecipient ? getAddress(lc(ps.creatorFeeRecipient)) : null;
  const [launches, credits, claims] = await Promise.all([
    deployer ? launchesOf(deployer) : null,
    recipient ? logs(`address=${ESCROW}&topic0=${CREDITED}&topic1=${pad(recipient)}&topic0_1_opr=and`) : null,
    recipient ? logs(`address=${ESCROW}&topic0=${CLAIMED}&topic1=${pad(recipient)}&topic0_1_opr=and`) : null,
  ]);
  const coins = (launches || []).map((l) => ({ address: getAddress("0x" + l.topics[1].slice(26)), at: Number(BigInt(l.timeStamp)) * 1000 }))
    .sort((a, b) => b.at - a.at);
  // what the Gate said when Sentry checked each of the deployer's launches (Two Fates), and their latest Troya Check
  const F = await import("./fates.mjs").catch(() => null);
  const verdicts = F ? await F.launchVerdicts(coins.map((c) => c.address)).catch(() => ({})) : {};
  const last = claims?.length ? claims.reduce((a, b) => (Number(BigInt(b.timeStamp)) > Number(BigInt(a.timeStamp)) ? b : a)) : null;
  return {
    pons: true, deployer, recipient, recipientIsDeployer: !!deployer && !!recipient && lc(deployer) === lc(recipient),
    creatorTaxPct: ps.taxBps != null ? Number(ps.taxBps) / 100 : null,
    fees: credits || claims ? { creditedEth: credits ? eth(credits) : null, claimedEth: claims ? eth(claims) : null, claims: claims ? claims.length : null,
      lastClaimAt: last ? Number(BigInt(last.timeStamp)) * 1000 : null, scope: "every coin this wallet receives creator fees from" } : null,
    deployerCoins: launches ? { count: coins.length, others: coins.filter((c) => lc(c.address) !== lc(token)).slice(0, 12).map((c) => ({ ...c, launchVerdict: verdicts[lc(c.address)]?.v || null })) } : null,
    note: launches || credits ? null : "Blockscout's log index did not answer just now: creator fees and the deployer's other coins were not read",
  };
}

/** The creator lens for one coin, or null when it is not a Pons coin or nothing could be read.
 * Stale while revalidate: Blockscout's log index can take 15 s or more, so a known answer is returned at once and read
 * again in the background once it is old (1 minute for a read with a part missing, 10 minutes otherwise). A part that
 * did not answer keeps its last value. */
const inflight = new Map();
const partialOf = (v) => !!v?.pons && (!v.deployerCoins || !v.fees);
export async function creatorLens(token) {
  const k = lc(token);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < (partialOf(hit.v) ? 60_000 : TTL)) return hit.v;
  let p = inflight.get(k);
  if (!p) {
    p = compute(token).catch(() => null).then((v) => {
      inflight.delete(k);
      const old = memo.get(k)?.v;
      if (v?.pons && old?.pons) { v.deployerCoins = v.deployerCoins || old.deployerCoins; v.fees = v.fees || old.fees; if (v.deployerCoins && v.fees) v.note = null; }
      if (v) { memo.set(k, { at: Date.now(), v }); if (memo.size > 2000) memo.delete(memo.keys().next().value); }
      return v || old || null;
    });
    inflight.set(k, p);
  }
  return hit ? hit.v : p;
}
