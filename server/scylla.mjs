// V10 F59 Scylla: Safe Crossing. Every route Troya's bridge can hand you for moving ETH (or buying a coin) between
// Robinhood Chain (4663) and Base, Arbitrum or Ethereum gets a 0-100 safety score, with red lines that cap it.
//   GET /api/scylla/routes?from=8453&to=4663&amount=0.1[&token=0x…][&address=0x…]
//     amount is in ETH (the coin you send is always ETH, as on the Bridge page), 0 < amount ≤ 50.
//     token (optional): a coin bought at the end of the crossing, on Robinhood Chain, Base or Arbitrum.
//   GET /api/scylla → the rubric (weights, categories, red lines) and the fact table with every score
// Where the routes come from: the route Troya hands you is robinhood.mjs bridgeQuote (ETH → ETH) or crossBuyQuote (ETH →
// a coin, Base/Arbitrum ⇄ Robinhood Chain, which runs the destination Gate first). The other routes LI.FI offers for the
// same crossing come from LI.FI's /advanced/routes. Every route passes through LI.FI's own contract (the LiFiDiamond), so
// LI.FI is scored as a layer of every route, and the route score is its weakest layer.
// Every fact below was checked on 25 Nov 2026 against the source named beside it (L2BEAT is now ETHBEAT, ethbeat.org);
// on-chain facts were read from the chain that day. A fact Troya could not confirm is "unknown" and earns no points.
// The arriving side: the coin is read on its chain (tokenMeta), the Troya Gate runs on it, the route must end in that coin
// on that chain and go through the known LI.FI contract, and Pharos (F61) adds a warning when a watched setting on the
// route changed recently or Robinhood Chain looks unhealthy.
// Every scored answer is signed by the Troya attestor (gateapi.attest, label "Troya Scylla"): a crossing receipt.
// A score explains a risk; it never promises a bridge is safe.
import { parseUnits, formatUnits, isAddress, getAddress } from "ethers";
import { HttpError } from "./api.mjs";

const CHECKED = "2026-11-25";
const RUBRIC_VERSION = "scylla-1";
const lc = (s) => String(s || "").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const NEUTRAL = "0x000000000000000000000000000000000000dEaD"; // quotes only: LI.FI needs a sender to price a route
let store = null;

/* ---------------- the rubric ---------------- */
export const WEIGHTS = { verification: 30, control: 25, incidents: 20, track: 15, audits: 10 };
export const CATS = {
  verification: {
    canonical: [30, "Canonical rollup bridge: the chain's own proofs on Ethereum"],
    "canonical-permissioned": [24, "Canonical rollup bridge, but only whitelisted validators can prove"],
    "optimistic-bonded": [22, "Optimistic: a bonded proposer, anyone can dispute in a challenge window"],
    "intent-messaging": [18, "Intents: solvers front the funds, repaid after a signed message from an outside committee"],
    "intent-oracle": [15, "Intents: solvers front the funds, repaid after an oracle proof the operator configures"],
    mpc: [12, "A relayer group signs with MPC (threshold signature)"],
    dvn: [10, "LayerZero: the verifiers (DVNs) the app sets; the set itself not confirmed"],
    "verifier-plus-bridges": [10, "Settlement contract on another chain, assets moved by bridges of mixed trust"],
    inherited: [8, "A router over each token's own bridge: as safe as that bridge"],
    operator: [6, "The operator verifies and pays out itself: you trust one party"],
    unknown: [0, "Not published or not confirmed"],
  },
  control: {
    "timelock-7d": [25, "Upgrades need a multisig and wait at least 7 days"],
    "timelock-1d": [20, "Upgrades need a multisig and wait at least 1 day"],
    "timelock-short": [15, "Upgrades need a multisig and wait less than a day"],
    "multisig-nodelay": [10, "A multisig can upgrade or move funds with no delay"],
    "admin-unclear": [5, "An admin exists; its threshold or delay is not published"],
    "single-key": [0, "One key can change the contracts or who releases funds"],
    unknown: [0, "Not published or not confirmed"],
  },
  incidents: {
    "none-found": [20, "No incident found in the sources (not proof there was none)"],
    "related-only": [16, "No incident of its own; incidents in the stack it builds on"],
    "offchain-resolved": [14, "Incidents off the contracts (website, off-chain code), users made whole or unaffected"],
    "contract-resolved": [8, "A contract exploit, resolved (users refunded)"],
    "contract-old-unclear": [4, "A contract exploit more than a year ago, refund not confirmed"],
    "contract-unresolved": [0, "A contract exploit in the last 12 months, not resolved"],
    unknown: [0, "Not checked"],
  },
  track: { "3y": [15, "In production 3 years or more"], "2y": [12, "2 to 3 years"], "1y": [8, "1 to 2 years"], new: [4, "Less than a year"], unknown: [0, "Start date not confirmed"] },
  audits: { listed: [10, "Audits published in a list"], partial: [5, "Some audits, no full list"], unknown: [0, "No audit found"] },
};
export const RED_LINES = {
  "single-key": { cap: 40, text: "One key can change who releases the funds, with no delay." },
  "unresolved-exploit": { cap: 30, text: "A contract exploit in the last 12 months that is not resolved." },
  "unknown-contract": { cap: 20, text: "The transaction does not go to the known LI.FI contract on this chain." },
  "gate-failed": { cap: 20, text: "The coin at the end failed Troya Gate." },
  "wrong-arrival": { cap: 0, text: "The route does not end in the coin and chain you asked for." },
  storm: { cap: 50, text: "Storm watch saw a key setting on this route change in the last 24 hours, or Robinhood Chain looks unhealthy." },
};

/* ---------------- the fact table (sourced) ---------------- */
const F = (cat, text, src, conf = "confirmed") => ({ cat, text, src: [].concat(src || []), confidence: conf, checked: CHECKED });
export const FACTS = {
  lifi: {
    name: "LI.FI (router)", kind: "router", site: "https://li.fi",
    verification: F("router", "Not a bridge: LI.FI's contract (the LiFiDiamond) takes your ETH and hands it to the bridge the route names. Every Troya bridge route goes through it.", "https://docs.li.fi/smart-contracts/audits"),
    control: F("timelock-short", "The LiFiDiamond's owner is a TimelockController with a 3-hour delay; a 3-of-6 Safe proposes. Read on chain: Robinhood Chain diamond 0xB477751B76CF82d00a686A1232f5fCD772414Af3, timelock 0x6E9Beb6997dAE04122f1f8f8980f3dc8225443F3 (10,800 s), Safe 0xE49447936F02d8be7c2b37de03329bFa8EaDa6B6 (3 of 6); Ethereum diamond 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE, timelock 0x55117ECcC867Db72aEb25f728CCf57C3C3B4faEe (3 h), Safe 3 of 6. A single pauser wallet can pause the diamond or remove code modules with no delay (it cannot add any).",
      ["https://github.com/lifinance/contracts/blob/main/deployments/robinhood.json", "https://github.com/lifinance/contracts/blob/main/config/global.json", "on-chain read, 25 Nov 2026"]),
    track: F("2022-03", "In production by March 2022 (the first incident).", "https://cointelegraph.com/news/li-finance-protocol-loses-600-000-in-latest-defi-exploit"),
    incidents: F("contract-old-unclear", "16 Jul 2024: about $11.6M taken from 153 wallets that had given unlimited approvals; a newly added code module allowed arbitrary calls (LI.FI: human error in deployment). The module was disabled; the report confirms no refund. 20 Mar 2022: about $600K the same way, most small wallets reimbursed.",
      ["https://li.fi/knowledge-hub/incident-report-16th-july", "https://cointelegraph.com/news/li-finance-protocol-loses-600-000-in-latest-defi-exploit"]),
    audits: F("listed", "Audit policy and reports published; bug bounty up to $1M.", ["https://docs.li.fi/smart-contracts/audits", "https://github.com/lifinance/contracts/tree/main/audit/reports"]),
  },
  across: {
    name: "Across", kind: "bridge", site: "https://across.to",
    verification: F("optimistic-bonded", "Relayers fill from their own money. A bonded proposer posts the repayment bundle on Ethereum; anyone can dispute it within 30 minutes, and disputes go to the UMA optimistic oracle vote.", "https://ethbeat.org/interop/protocols/across"),
    control: F("multisig-nodelay", "The Across Multisig 0xB524735356985D2f267FA010D681f061DfF03715 (3 of 5) upgrades the SpokePools and owns the HubPool, with no delay listed; it can also pause. A slower OptimisticGovernor path has a 2-day delay.", "https://ethbeat.org/interop/protocols/across"),
    track: F("2021-11", "Mainnet live November 2021.", "https://across.to/blog/Across-Protocol-is-live-and-you-can-be-a-Co-Founder"),
    incidents: F("offchain-resolved", "17 Jul 2026: a bug in Risk Labs' off-chain event reader (not the contracts) let an attacker forge Solana deposits; the relayer took a loss under $4M, users unaffected. 10 Nov 2026: the across.to domain was hijacked at its registrar and served a phishing site, about $350K lost; restored 11 Nov, Across says users will be made whole.",
      ["https://crypto.news/across-protocol-relayer-lose-under-4m-in-solana-attack/", "https://theblock.co/news/defi/2026-11-11-crosschain-protocol-across-restores-systems-after-domain-hijack-437843"]),
    recentFrontEnd: "2026-11-10",
    audits: F("listed", "OpenZeppelin and UMA audits listed.", "https://docs.across.to/introduction/audits"),
  },
  relaydepository: {
    name: "Relay", kind: "bridge", site: "https://relay.link",
    verification: F("operator", "A Relay-run oracle attests deposits and fills; Relay-operated solvers fill, with no solver bond and no on-chain refund path. ETHBEAT reads it as one party to trust per deposit chain.", ["https://ethbeat.org/interop/protocols/relay", "https://docs.relay.link/references/protocol/security.md"]),
    control: F("single-key", "The Depository cannot be upgraded (no proxy), but its owner, a single key (EOA 0xF61A305199fa1135d76FFaB3752D42F55cBd775A, read on Base), can replace the allocator that signs withdrawals at any time and with no delay. Relay's Security Council governs the allocator; its threshold is not published.", ["https://ethbeat.org/interop/protocols/relay", "https://docs.relay.link/references/protocol/security.md"]),
    red: ["single-key"],
    track: F("2024", "Bridge launched in 2024 (month not given).", "https://fortune.com/crypto/2025/02/05/union-square-ventures-leads-14-million-round-in-reservoir-an-nft-company-pivoting-to-bridge-technology/", "partial"),
    incidents: F("none-found", "No exploit of Relay found. 31 Oct 2026: about $38M of funds linked to North Korean hackers moved through Relay (laundering, not a loss to users).", "https://cryptobriefing.com/north-korean-hackers-relay-protocol-38m/"),
    audits: F("listed", "Spearbit (Feb 2025), Certora (Jun 2025), Zellic (Nov 2025, Apr 2026).", "https://docs.relay.link/references/protocol/security.md"),
  },
  layerswap: {
    name: "Layerswap", kind: "bridge", site: "https://layerswap.io",
    verification: F("operator", "Layerswap watches the source chain and pays out on the other side; deposits go to a Layerswap deposit address or its own Depository contract. The docs do not say who controls it.", ["https://docs.layerswap.io/concepts/funding-methods.md", "https://docs.layerswap.io/api-reference/depository"], "partial"),
    control: F("unknown", "Who can upgrade or pause the Depository is not published.", "https://docs.layerswap.io/api-reference/depository"),
    track: F("2024-03", "In production by March 2024 (the incident below); the company dates from 2021.", "https://cointelegraph.com/news/layerswap-website-hack-100k-loss", "partial"),
    incidents: F("offchain-resolved", "20 Mar 2024: the website's domain was hijacked and served a phishing page; about $100K from about 50 users. Not a contract bug; Layerswap pledged a full refund plus 10%.", "https://cointelegraph.com/news/layerswap-website-hack-100k-loss"),
    audits: F("partial", "Hexens audited the Depository contract; no audit list.", "https://docs.layerswap.io/concepts/security.md"),
  },
  lifiIntents: {
    name: "LI.FI Intents", kind: "bridge", site: "https://docs.li.fi/lifi-intents",
    verification: F("intent-oracle", "A solver fills on the destination chain first; an oracle proof (Polymer, Wormhole and others, configured by LI.FI) lets the solver claim your escrow. An unfilled order is refundable after it expires.", ["https://docs.li.fi/lifi-intents/architecture/overview.md", "https://ethbeat.org/interop/intent-bridges"]),
    control: F("unknown", "Who can upgrade or pause the escrow and oracle settings is not published.", "https://docs.li.fi/lifi-intents/architecture/overview.md"),
    track: F("2026-05", "Live in production in May 2026.", "https://eco.com/support/en/articles/15350485", "partial"),
    incidents: F("none-found", "No incident found.", "https://ethbeat.org/interop/intent-bridges"),
    audits: F("unknown", "No audit list found for the Intents contracts.", null),
  },
  symbiosis: {
    name: "Symbiosis", kind: "bridge", site: "https://symbiosis.finance",
    verification: F("mpc", "Relayers sign with MPC: at least 2/3 of a group of up to 15, plus a Veto Group chosen by Symbiosis admins. If too few relayers are online, transfers stop and recovery is manual.", "https://docs.symbiosis.finance/relayers-network/symbiosis-relayers-network-architecture-and-operations"),
    control: F("unknown", "Who can upgrade or pause the contracts is not published.", null),
    track: F("2022-03", "Beta mainnet March 2022.", "https://forklog.com/en/symbiosis-finance-launches-beta-mainnet/"),
    incidents: F("contract-unresolved", "11 Sep 2026: an exploit of its BridgeV2 contract on BNB Chain (the BTC bridge) minted unbacked syBTC; DefiLlama puts the loss at $336K, about 15 BTC were recovered. On 13 Sep the BTC bridge was still paused and compensation pending; Troya found no post-mortem.",
      "https://www.theblock.co/news/defi/2026-09-13-symbiosis-says-it-recovered-15-btc-after-bitcoin-bridge-exploit-offers-attacker-20-bounty-414568"),
    red: ["unresolved-exploit"],
    audits: F("listed", "Audits listed for six components.", ["https://docs.symbiosis.finance/main-concepts/security-audits", "https://github.com/symbiosis-finance/audits"]),
  },
  stargateV2: {
    name: "Stargate V2", kind: "bridge", site: "https://stargate.finance",
    verification: F("dvn", "Built on LayerZero V2: transfers are verified by the DVNs Stargate sets; Troya could not confirm the full set. A June 2026 upgrade lets the owner raise or lower credits without LayerZero verification.", ["https://ethbeat.org/interop/protocols/stargate", "https://docs.layerzero.network/v2/concepts/applications/stargate-finance"], "partial"),
    control: F("multisig-nodelay", "Stargate Multisig 5 of 7 and LayerZero's OneSig 5 of 9; no timelock found.", "https://ethbeat.org/interop/protocols/stargate", "partial"),
    track: F("2024-05", "Stargate V2 launched May 2024.", "https://blog.iota.org/iota-evm-welcomes-stargate/"),
    incidents: F("related-only", "No Stargate pool exploit found. In its stack: 19 Apr 2026, KelpDAO rsETH lost about $300M through a 1-of-1 LayerZero verifier setup (not Stargate's).", "https://blockport.io/latest-news/layerzero-rpc-breach-kelpdao-300m-hack/"),
    audits: F("partial", "Zellic and OtterSec audits referenced; bug bounty on Immunefi.", "https://immunefi.com/bug-bounty/stargate/"),
  },
  mayan: {
    name: "Mayan", kind: "bridge", site: "https://mayan.finance",
    verification: F("intent-messaging", "Drivers fill on the destination chain from their own money; Wormhole Guardians (13 of 19) sign the message that unlocks your funds on the source chain.", ["https://docs.mayan.finance/architecture/swift", "https://ethbeat.org/interop/protocols/mayan"]),
    control: F("admin-unclear", "Mayan says no single party can freeze or move assets (its own claim); Wormhole's core contracts can be upgraded by the Guardians.", ["https://docs.mayan.finance/resources/audits", "https://ethbeat.org/interop/protocols/mayan"], "partial"),
    track: F("unknown", "Start date not confirmed.", null),
    incidents: F("none-found", "No exploit of Mayan found.", "https://docs.mayan.finance/architecture/swift"),
    audits: F("listed", "OtterSec and Sec3 audits listed.", "https://docs.mayan.finance/resources/audits"),
  },
  near: {
    name: "NEAR Intents", kind: "bridge", site: "https://near-intents.org",
    verification: F("verifier-plus-bridges", "Settlement in the Verifier contract on NEAR; assets enter and leave through the Omni, POA (proof of authority) and HOT bridges.", ["https://docs.near-intents.org/integration/bridging/overview", "https://docs.near-intents.org/getting-started/what-are-intents"]),
    control: F("admin-unclear", "Upgradeable and pausable; a DAO account (threshold not given) and named roles can upgrade it and withdraw any funds; no timelock found.", "https://hacken.io/audits/aurora-labs-limited/sca-aurora-labs-defuse-contracts-dec2024/"),
    track: F("unknown", "Start date not confirmed.", null),
    incidents: F("contract-unresolved", "1 Oct 2026: about $3.8M drained through the Omni deposit/withdraw flow; paused, resumed about an hour later; full compensation and a post-mortem promised, not yet confirmed by Troya's sources.", "https://crypto.news/near-intents-resumes-service-after-3-8m-exploit/"),
    red: ["unresolved-exploit"],
    audits: F("listed", "Hacken audit of the contracts (Dec 2024).", "https://hacken.io/audits/aurora-labs-limited/sca-aurora-labs-defuse-contracts-dec2024/"),
  },
  glacis: {
    name: "Glacis", kind: "bridge", site: "https://glacislabs.com",
    verification: F("inherited", "A router over each token's own bridge (LayerZero OFT, Wormhole NTT, Chainlink CCT, Hyperlane, CCTP, xERC20): its safety is that bridge's.", "https://docs.glacislabs.com/airlift/why-airlift", "partial"),
    control: F("admin-unclear", "Adapters and trusted remotes are set by 'the Glacis owner account'; its type, threshold, delay and pause are not published.", "https://docs.glacislabs.com/glacis-core/concepts/governance-model"),
    track: F("2025-02", "LI.FI partnership announced February 2025.", "https://li.fi/knowledge-hub/li-fi-partners-with-glacis-to-accelerate-the-adoption-of-interop-token/", "partial"),
    incidents: F("none-found", "No incident found.", null),
    audits: F("unknown", "No audit found.", null),
  },
};
// the chain itself: shared by every route that touches Robinhood Chain, shown beside the routes (not inside their score)
export const CHAIN_FACTS = {
  robinhood: {
    name: "Robinhood Chain (the chain itself)", kind: "chain", site: "https://docs.robinhood.com/chain",
    verification: F("canonical-permissioned", "An Arbitrum Orbit rollup on Ethereum, all data posted to Ethereum as blobs; fraud proofs with a 6 d 8 h challenge period, but only 2 whitelisted validators can prove (anyone after 28 days of silence). One batch poster; a transaction filterer can make any transaction fail, so forced inclusion is not a reliable way out.", "https://ethbeat.org/scaling/projects/robinhood"),
    control: F("multisig-nodelay", "Multisig 1 (7 of 8) can upgrade the core contracts with no delay, bypassing the 7-day TimelockController that Multisig 2 (6 of 8) uses. ETHBEAT: not even Stage 0, no exit window. Thresholds, roles and the 7-day delay read on Ethereum on 25 Nov 2026; Pharos watches them.", ["https://ethbeat.org/scaling/projects/robinhood", "on-chain read, 25 Nov 2026"]),
    track: F("2026-07", "Mainnet open 1 Jul 2026.", "https://blog.arbitrum.io/robinhood-chain-mainnet/"),
    incidents: F("none-found", "No incident found.", "https://ethbeat.org/scaling/projects/robinhood"),
    audits: F("unknown", "No audit list for this chain's deployment found (it runs Arbitrum Nitro code).", null),
    canonicalBridge: "The canonical bridge (through Ethereum) is not a route Troya's bridge offers: deposits from Ethereum arrive in minutes, withdrawals to Ethereum wait the 6 d 8 h challenge period plus 2 days.",
  },
};
const IGNORE_TOOLS = new Set(["feeCollection", "wrapper"]);
const LIFI_DIAMOND = { 4663: "0xb477751b76cf82d00a686a1232f5fcd772414af3", default: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" };
const NAMES = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 4663: "Robinhood Chain" };
const ALIAS = { robinhood: 4663, rh: 4663, base: 8453, arbitrum: 42161, arb: 42161, ethereum: 1, eth: 1, mainnet: 1 };

function trackCat(since) {
  if (!since || since === "unknown" || !/^\d{4}(-\d{2})?$/.test(since)) return "unknown";
  const [y, m] = since.split("-").map(Number);
  const start = Date.UTC(y, (m || 12) - 1, 1); // a year alone counts from its last month: the safe side
  const yrs = (Date.now() - start) / (365.25 * 86400_000);
  return yrs >= 3 ? "3y" : yrs >= 2 ? "2y" : yrs >= 1 ? "1y" : "new";
}
/** Score one fact sheet with the published rubric. */
export function scoreFacts(key, f) {
  if (!f) return { key, name: key, kind: "bridge", score: 0, known: false, parts: [], redLines: [], unknowns: ["Troya has no checked facts on this bridge yet."], cap: null };
  const parts = [], unknowns = [];
  const crit = f.kind === "router" ? ["control", "incidents", "track", "audits"] : ["verification", "control", "incidents", "track", "audits"];
  let got = 0, max = 0;
  for (const c of crit) {
    const fact = f[c];
    const cat = c === "track" ? trackCat(fact?.cat) : fact?.cat || "unknown";
    const [pts, catText] = CATS[c][cat] || [0, "Not published or not confirmed"];
    got += pts; max += WEIGHTS[c];
    if (cat === "unknown") unknowns.push(`${c}: ${fact?.text || "not confirmed"}`);
    parts.push({ criterion: c, weight: WEIGHTS[c], points: pts, category: cat, categoryText: catText, text: fact?.text || null, since: c === "track" ? fact?.cat : undefined, sources: fact?.src || [], confidence: fact?.confidence || "unknown", checked: fact?.checked || CHECKED });
  }
  let score = Math.round((got / max) * 100);
  const redLines = (f.red || []).map((k) => ({ key: k, ...RED_LINES[k] }));
  const cap = redLines.length ? Math.min(...redLines.map((r) => r.cap)) : null;
  if (cap != null) score = Math.min(score, cap);
  const warnings = [];
  if (f.recentFrontEnd && Date.now() - Date.parse(f.recentFrontEnd) < 45 * 86400_000) warnings.push(`${f.name}'s website was hijacked on ${f.recentFrontEnd}. Type the address yourself; Troya's bridge calls the contract directly.`);
  return { key, name: f.name, kind: f.kind, site: f.site, score, known: true, parts, redLines, unknowns, warnings, cap };
}

/* ---------------- routes ---------------- */
function chainOf(v, def) {
  if (v == null || v === "") return def;
  const n = ALIAS[lc(v)] ?? Number(String(v).replace(/^eip155:/, ""));
  if (!NAMES[n]) throw new HttpError(400, "Chains: robinhood (4663), base (8453), arbitrum (42161), ethereum (1).");
  return n;
}
const cache = new Map();
async function lifiRoutes({ from, to, amountWei, toToken, address }) {
  const k = `${from}|${to}|${amountWei}|${lc(toToken)}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 90_000) return hit.v;
  const res = await fetch("https://li.quest/v1/advanced/routes", {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "troya-agent/0.2", ...(process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : {}) },
    body: JSON.stringify({ fromChainId: from, toChainId: to, fromTokenAddress: ZERO, toTokenAddress: toToken || ZERO, fromAmount: String(amountWei), fromAddress: address, toAddress: address,
      options: { slippage: 0.03, order: "RECOMMENDED", integrator: "troya-agent" } }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new HttpError(502, `LI.FI answered ${res.status} for the route list.`);
  const v = { routes: j.routes || [], filtered: (j.unavailableRoutes?.filteredOut || []).length, failed: (j.unavailableRoutes?.failed || []).length };
  cache.set(k, { at: Date.now(), v });
  if (cache.size > 300) for (const [kk, x] of cache) if (Date.now() - x.at > 90_000) cache.delete(kk);
  return v;
}
// a route's bridges (cross-chain steps) and its swaps (same-chain DEX steps, e.g. buying the coin at the end)
const stepsOf = (route) => (route.steps || []).flatMap((s) => (s.includedSteps?.length ? s.includedSteps : [s]));
const toolsOf = (route) => [...new Set(stepsOf(route).filter((i) => i.type === "cross" || (!i.type && Number(i.action?.fromChainId) !== Number(i.action?.toChainId))).map((i) => keyOfName(i.tool)).filter((t) => t && !IGNORE_TOOLS.has(t)))];
const swapsOf = (route) => [...new Set(stepsOf(route).filter((i) => i.type === "swap").map((i) => `${i.toolDetails?.name || i.tool} on ${NAMES[Number(i.action?.fromChainId)] || i.action?.fromChainId}`))];

async function arrival({ to, token, ethIn, slipBps, from, amountWei, address }) {
  // the coin at the end: is it a real token on that chain, and what does the Gate say
  const R = await import("./robinhood.mjs");
  const out = { token, chain: NAMES[to], meta: null, gate: null, primary: null, notes: [] };
  if (to === 4663) out.meta = await R.tokenMeta(token).then((m) => ({ address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals })).catch(() => null);
  else out.meta = await import("./evmswap.mjs").then((m) => m.evmTokenMeta(to === 8453 ? "base" : "arbitrum", token)).then((m) => ({ address: m.address, symbol: m.symbol, name: m.name, decimals: m.decimals })).catch(() => null);
  if (!out.meta) return out;
  const crossOk = ((from === 4663 && (to === 8453 || to === 42161)) || (to === 4663 && (from === 8453 || from === 42161))) && amountWei <= parseUnits("2", 18);
  if (crossOk) {
    // the path Troya's cross-chain buy takes: the destination Gate, then the LI.FI route (one call)
    try { out.primary = await R.crossBuyQuote({ fromChain: from, toChain: to, toToken: token, address, amountWei: String(amountWei), slippage: slipBps / 10000 }); out.gate = out.primary.gate; }
    catch (e) { if (e?.extra?.gate) out.gate = e.extra.gate; else out.notes.push(`Troya's cross-chain buy gave no route: ${e.message}`); }
  }
  if (!out.gate) {
    try {
      const g = to === 4663 ? await R.gateCheck({ tokenIn: "ETH", tokenOut: token, amountIn: ethIn, slippageBps: slipBps })
        : await (await import("./evmswap.mjs")).evmGate({ chain: to === 8453 ? "base" : "arbitrum", tokenIn: "native", tokenOut: token, amountIn: ethIn, slippageBps: slipBps });
      const checks = (g.checks || []).map((c) => ({ key: c.key, status: c.status, label: c.label, detail: c.detail }));
      const fail = checks.find((c) => c.status === "fail"), warn = checks.find((c) => c.status === "warn");
      out.gate = { verdict: fail || !g.pass ? "failed" : warn ? "caution" : "passed", passed: checks.filter((c) => c.status === "pass").length, total: checks.filter((c) => c.status !== "skip").length,
        why: fail ? `${fail.label}: ${fail.detail}` : warn ? `${warn.label}: ${warn.detail}` : null, checks };
    } catch (e) { out.notes.push(`The Gate could not run: ${e.message}`); }
  }
  return out;
}

export async function scyllaRoutes(q = {}) {
  const from = chainOf(q.from, 8453), to = chainOf(q.to, 4663);
  if (from === to) throw new HttpError(400, "Pick two different chains.");
  if (from !== 4663 && to !== 4663) throw new HttpError(400, "One side must be Robinhood Chain (4663), as on Troya's bridge.");
  const amtText = String(q.amount ?? "0.1").trim().replace(/^\./, "0.");
  const amount = Number(amtText);
  if (!/^\d+(\.\d{1,18})?$/.test(amtText) || !(amount > 0) || amount > 50) throw new HttpError(400, "amount is in ETH: more than 0 and at most 50.");
  const amountWei = parseUnits(amtText, 18);
  const address = q.address && isAddress(String(q.address)) ? getAddress(String(q.address)) : NEUTRAL;
  let token = null;
  if (q.token && !/^(eth|native|0x0{40})$/i.test(String(q.token))) {
    if (!isAddress(String(q.token))) throw new HttpError(400, "token must be a 0x coin address.");
    if (to === 1) throw new HttpError(400, "Buying a coin at the end runs on Robinhood Chain, Base or Arbitrum.");
    token = getAddress(String(q.token));
  }
  const slipBps = 300, ethIn = formatUnits((amountWei * 97n) / 100n, 18);
  const R = await import("./robinhood.mjs");

  // 1) the arriving side (a coin at the end) and Troya's own route
  let arr = null, primary = null, primaryNote = null;
  if (token) {
    arr = await arrival({ to, token, ethIn, slipBps, from, amountWei, address });
    if (!arr.meta) throw new HttpError(404, `${token} does not read as a token on ${NAMES[to]}.`);
    primary = arr.primary;
    if (!primary) primaryNote = arr.gate?.verdict === "failed" ? "Troya's cross-chain buy refuses this coin: it failed the Gate." : "Troya's cross-chain buy runs Base or Arbitrum ⇄ Robinhood Chain up to 2 ETH; the routes below are LI.FI's.";
  } else {
    try { primary = await R.bridgeQuote({ fromChain: from, toChain: to, address, amountWei: String(amountWei) }); }
    catch (e) { primaryNote = `Troya's bridge gave no route right now: ${e.message}`; }
  }

  // 2) every route LI.FI offers for the same crossing
  let list = { routes: [], filtered: 0, failed: 0 }, listNote = null;
  try { list = await lifiRoutes({ from, to, amountWei, toToken: token, address }); } catch (e) { listNote = e.message; }

  // 3) storm watch on these chains
  const storm = await import("./pharos.mjs").then((m) => m.stormFor([from, to])).catch(() => ({ level: "unknown", warnings: ["Storm watch is not running."], watched: false }));
  const lifiScore = scoreFacts("lifi", FACTS.lifi);
  const wantToken = lc(token || ZERO);
  const known = lc(LIFI_DIAMOND[from] || LIFI_DIAMOND.default);

  const routes = [];
  const scoreRoute = ({ id, tools, swaps, toAmount, toAmountMin, toAmountUsd, fromAmountUsd, toTokenAddr, toChainId, contract, seconds, tags, source }) => {
    if (!tools.length) tools = ["unlisted bridge"];
    const comps = [lifiScore, ...tools.map((t) => scoreFacts(t, FACTS[t]))];
    const weakest = comps.reduce((a, b) => (b.score < a.score ? b : a), comps[0]);
    let score = weakest.score;
    const redLines = comps.flatMap((c) => c.redLines.map((r) => ({ ...r, from: c.name })));
    const warnings = comps.flatMap((c) => c.warnings || []);
    const addRed = (k, from_) => { redLines.push({ key: k, ...RED_LINES[k], from: from_ }); };
    if (Number(toChainId) !== to || lc(toTokenAddr || ZERO) !== wantToken) addRed("wrong-arrival", "this route");
    if (contract && lc(contract) !== known) addRed("unknown-contract", "this route");
    if (arr?.gate?.verdict === "failed") addRed("gate-failed", "Troya Gate");
    else if (arr?.gate?.verdict === "caution") warnings.push(`Troya Gate passed the coin with a note: ${arr.gate.why}`);
    if (storm.level === "storm") addRed("storm", "Pharos");
    else if (storm.level === "watch") { score = Math.max(0, score - 10); warnings.push("Storm watch: a setting on this route changed in the last 7 days (10 points off)."); }
    const caps = redLines.map((r) => r.cap);
    if (caps.length) score = Math.min(score, ...caps);
    // value lost in the quote (fees, bridge cut, price impact), from LI.FI's USD prices; a negative number means LI.FI has no
    // reliable price for the coin, so it is left out
    let loss = fromAmountUsd > 0 && toAmountUsd > 0 ? +(((fromAmountUsd - toAmountUsd) / fromAmountUsd) * 100).toFixed(2) : null;
    if (loss != null && loss < -0.5) loss = null;
    routes.push({ id, source, tools: tools.map((t) => FACTS[t]?.name || t), toolKeys: tools, swaps: swaps || [], score, band: redLines.length || score < 40 ? "red" : score < 70 ? "amber" : "green",
      weakest: weakest.name, components: comps.map((c) => ({ key: c.key, name: c.name, score: c.score, known: c.known })), redLines, warnings, tags: tags || [],
      toAmount: String(toAmount || 0), toAmountMin: String(toAmountMin || 0), toAmountUsd: toAmountUsd || null, fromAmountUsd: fromAmountUsd || null, valueLostPct: loss, seconds: seconds || null, contract: contract || null });
  };
  // Troya's route names only its main tool: borrow the swap steps from LI.FI's route with the same bridge
  const twinOf = (k) => list.routes.find((x) => toolsOf(x).join() === k);
  const twin = primary ? twinOf(keyOfName(primary.tool)) : null;
  if (primary) scoreRoute({ id: "troya", source: "troya", tools: [keyOfName(primary.tool)], swaps: twin ? swapsOf(twin) : [], toAmount: primary.toAmount, toAmountMin: primary.toAmountMin,
    toAmountUsd: primary.toAmountUsd || (twin ? Number(twin.toAmountUSD) * (Number(primary.toAmount) / Number(twin.toAmount || 1)) : null), fromAmountUsd: primary.fromAmountUsd || (twin ? Number(twin.fromAmountUSD) : null),
    toTokenAddr: token || ZERO, toChainId: primary.toChain, contract: primary.tx?.to, seconds: primary.executionSec, tags: ["Troya's route"] });
  for (const r of list.routes.slice(0, 10)) {
    const steps = r.steps || [];
    scoreRoute({ id: r.id, source: "lifi", tools: toolsOf(r), swaps: swapsOf(r), toAmount: r.toAmount, toAmountMin: r.toAmountMin, toAmountUsd: Number(r.toAmountUSD) || null, fromAmountUsd: Number(r.fromAmountUSD) || null,
      toTokenAddr: r.toToken?.address, toChainId: r.toChainId, contract: steps[0]?.estimate?.approvalAddress, seconds: steps.reduce((s, x) => s + (Number(x.estimate?.executionDuration) || 0), 0), tags: r.tags || [] });
  }
  routes.sort((a, b) => (a.source === "troya" ? -1 : b.source === "troya" ? 1 : b.score - a.score));
  // Troya's route repeats one of LI.FI's: mark it on the matching row instead of listing the tool twice
  if (routes[0]?.source === "troya") { const twin = routes.slice(1).find((x) => x.toolKeys.join() === routes[0].toolKeys.join()); if (twin) twin.tags = [...twin.tags, "same bridge as Troya's route"]; }

  const chainSheet = from === 4663 || to === 4663 ? scoreFacts("robinhood", CHAIN_FACTS.robinhood) : null;
  const out = {
    name: "Troya Scylla", rubric: RUBRIC_VERSION, from: { id: from, name: NAMES[from] }, to: { id: to, name: NAMES[to] }, amountEth: amount, amountWei: String(amountWei), quotedFor: address === NEUTRAL ? "a neutral address (quotes only)" : address,
    token: token ? { address: token, ...(arr?.meta || {}) } : null, gate: arr?.gate ? { verdict: arr.gate.verdict, passed: arr.gate.passed, total: arr.gate.total, why: arr.gate.why } : null, arrivalNotes: arr?.notes || [],
    routes, primaryNote, listNote, lifiFiltered: list.filtered, storm: { level: storm.level, warnings: storm.warnings, lastRun: storm.lastRun || null },
    chain: chainSheet && { name: chainSheet.name, score: chainSheet.score, parts: chainSheet.parts, note: "Shared by every route in or out of Robinhood Chain; shown beside the routes, not inside their score.", canonicalBridge: CHAIN_FACTS.robinhood.canonicalBridge },
    checkedAt: Date.now(),
    limit: "A score explains a risk; it never promises a bridge is safe. Facts were checked on " + CHECKED + "; a bridge can change after that, and an unknown earns no points. Routes are quotes, not sent transactions.",
  };
  try {
    const gate = await import("./gateapi.mjs");
    out.receipt = await gate.attest({ kind: "scylla-crossing", rubric: RUBRIC_VERSION, from, to, amountWei: out.amountWei, token, gate: out.gate?.verdict || null, storm: storm.level,
      routes: routes.map((r) => ({ id: r.id, tools: r.toolKeys, score: r.score, red: r.redLines.map((x) => x.key) })), checkedAt: out.checkedAt }, "Troya Scylla");
  } catch {}
  if (store) store.update("scylla.json", { total: 0, pairs: {} }, (d) => { d.total++; const k = `${from}-${to}`; d.pairs[k] = (d.pairs[k] || 0) + 1; return d; }).catch(() => {});
  return out;
}
// bridgeQuote / crossBuyQuote name the tool by its LI.FI display name ("Layerswap") or key: map it back to a fact sheet
function keyOfName(n) {
  const s = lc(n).replace(/[^a-z0-9]/g, "");
  for (const [k, f] of Object.entries(FACTS)) if (lc(k) === s || lc(f.name).replace(/[^a-z0-9]/g, "") === s) return k;
  if (/^across(v\d+)?$/.test(s)) return "across";
  if (s.includes("relay")) return "relaydepository";
  if (s.includes("stargate")) return "stargateV2";
  if (s.includes("intent") && s.includes("lifi")) return "lifiIntents";
  if (s === "nearintents") return "near";
  return n;
}

export async function scyllaInfo() {
  const sheets = Object.entries(FACTS).map(([k, f]) => ({ ...scoreFacts(k, f), facts: f }));
  const storm = await import("./pharos.mjs").then((m) => m.stormFor([4663, 1, 8453, 42161])).catch(() => null);
  return {
    name: "Troya Scylla", rubric: RUBRIC_VERSION, checked: CHECKED,
    how: "GET /api/scylla/routes?from=8453&to=4663&amount=0.1 (amount in ETH; from/to: robinhood, base, arbitrum, ethereum or the chain id; optional token=0x… for a coin bought at the end, optional address=0x… to quote for your wallet). Every answer is signed by the Troya attestor: EIP-191 over 'Troya Scylla' + newline + receipt.hash.",
    weights: WEIGHTS, categories: Object.fromEntries(Object.entries(CATS).map(([c, m]) => [c, Object.entries(m).map(([k, [p, t]]) => ({ key: k, points: p, text: t }))])),
    redLines: Object.entries(RED_LINES).map(([k, v]) => ({ key: k, ...v })),
    scoring: "Each bridge earns points per criterion from its sourced facts; LI.FI, a router and not a bridge, is scored without the verification criterion and scaled to 100. A route's score is its weakest layer (LI.FI or the bridge), then red lines cap it and a recent storm-watch change takes 10 points off. Green 70 and up, amber 40 to 69, red under 40 or any red line.",
    bridges: sheets, chain: { ...scoreFacts("robinhood", CHAIN_FACTS.robinhood), facts: CHAIN_FACTS.robinhood }, storm,
    stats: store ? await store.readJson("scylla.json", { total: 0, pairs: {} }) : null,
    limit: "A score explains a risk; it never promises a bridge is safe. Facts come from public sources checked on " + CHECKED + " and from on-chain reads; unknowns earn no points. Solana is not scored: Troya's bridge does not cross to Solana.",
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/scylla", () => scyllaInfo(), { weight: 1, perMin: 120 });
  r.get("/api/scylla/routes", ({ query }) => scyllaRoutes(query || {}), { weight: 3, perMin: 30 });
}
