// Proof a checker can read without a wallet or a browser app. larpcheck.app (21 Nov 2026) scored $TROYA "partly real":
// it could not confirm the burn figure, the Gate or the agents' trades. Everything here is read from the chain or from
// files the server already writes; nothing is typed in, and a row without a transaction hash is left out.
//   GET /api/proof/hl-fills   the test wallet's Hyperliquid fills, live from Hyperliquid's own API
//   GET /api/proof/burn       $TROYA burned = 1,000,000,000 minted − totalSupply(), read on chain (≤ 5 minutes old), with
//                             every burn transaction and who signed it
//   GET /api/proof/gate       the last Troya Gate run on $TROYA (this server runs it every 10 minutes), check by check with
//                             what each one read, and the simulated buy as an eth_call anyone can send again
//   GET /api/proof/trades     real transactions by Troya's agents: Arena live trades, the /verify real-money tests, Agent
//                             Wallet jobs, coins launched through Troya, paid Gate checks, Herald payouts
//   GET /api/proof/claims     every claim on the site with status live|planned and its evidence; also served at /proof.json
//                             (server.mjs). The /verify transaction log it carries is public/proof.json (tools/build-proof.mjs)
// The pages /proof, /verify, /flywheel, /stats and the homepage get these numbers and tables written into their HTML as they
// are served (server/livehtml.mjs), so a crawler sees them without running JavaScript.
// The same data straight from Hyperliquid: POST https://api.hyperliquid.xyz/info {"type":"userFills","user":"<address>"}
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress } from "ethers";
import { hlInfo } from "./hl.mjs";
import { setFragment, setValue, fragments } from "./livehtml.mjs";
import { gateHtml, evidenceOf, replayCall, esc } from "../public/home/gate-evidence.js";

export const TEST_WALLET = "0x12a05719851c8375342DE65c9105329c81f57054";
const SITE = (process.env.SITE_URL || "https://troya.codes").replace(/\/$/, "");
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const CREATOR = "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4";
const TEAM_WALLET = "0x45611870017682Ec781EDb9F71fA72fA91159350";
const ARENA_WALLET = "0xba9e826D5eb02061c3323E7F163F0645073E377d";      // shown on /verify (step 34) and by GET /api/arena
const ATTESTOR = "0xbEa3056612704eEE964B892862d969D2d4bB5fDE";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const POSM = "0x58daec3116aae6D93017bAAea7749052E8a04fA7";              // Uniswap v4 PositionManager
const STAKE = process.env.STAKE_CONTRACT || "0x1C867c13BD950a90aB75158C1C45061837aa02d2";
const PASS = "0x439EBc38c756f4F729c1474ED8DE337cFe3Aa77E";
const SPLIT_FACTORY = "0x266323d6ce63E4dfE62cC87bD14cA6C97BB2F525";
const SPLIT_DEPLOY_TX = "0x828c0679ad91873334c85853edbfba8e85697352b6a956f2a0632676163e95e8";
const OATH_VAULT = "0x6Bb959367a71d07F5bBCb91eb41b62949440a4e8";
const ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";             // Pons fee escrow (Pons's contract)
const LAUNCH_TX = "0xf5e33fcd6b28c87ec4bd25b0d7b35477d019a0ed2386963f8089265b294cad2e";
const LP_BURN_TX = "0xfe7f12591df9b9f53a0366a31cf36d1cf00b8200b6ae05fb8eeb7989afc24ea0";
const LP_NFT = 4293939;
const MINTED_RAW = 10n ** 27n;                                            // 1,000,000,000 × 10^18, minted once at launch
const GITHUB = "https://github.com/troyaagent/troya-agent";
const SRC = `${GITHUB}/blob/main/contracts/src`;
const BS = "https://robinhoodchain.blockscout.com";
const RPC_PUBLIC = "https://rpc.mainnet.chain.robinhood.com";
const SEL = { totalSupply: "0x18160ddd", balanceOf: "0x70a08231", owner: "0x8da5cb5b", ownerOf: "0x6352211e", token: "0xfc0c546a", cooldown: "0xa2724a4d", burn: "0x42966c68" };
const lc = (s) => String(s || "").toLowerCase();
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h || ""));
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");
const word = (a) => lc(a).replace(/^0x/, "").padStart(64, "0");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const int = (raw) => Number(raw / 10n ** 18n);                            // whole tokens, rounded down
const commas = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const tok = (raw) => { const s = (raw / 10n ** 14n).toString().padStart(5, "0"); return `${BigInt(s.slice(0, -4)).toLocaleString("en-US")}.${s.slice(-4)}`; };
const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPLORER = { robinhood: `${BS}/tx/`, base: "https://basescan.org/tx/", arbitrum: "https://arbiscan.io/tx/", solana: "https://solscan.io/tx/", polygon: "https://polygonscan.com/tx/" };
const NET = { "eip155:4663": "robinhood", "eip155:8453": "base", "eip155:42161": "arbitrum", "eip155:137": "polygon" };
const txUrl = (hash, chain = "robinhood") => (EXPLORER[chain] || EXPLORER.robinhood) + hash;
const addrUrl = (a) => `${BS}/address/${a}`;

// Wallets the site already names in public (/verify, /arena, /flywheel); nothing else is named here
const WALLETS = {
  [lc(CREATOR)]: { name: "Creator wallet", role: "launched $TROYA on Pons; signs the flywheel, every burn and the Herald payouts; Gate API payments go to it" },
  [lc(TEAM_WALLET)]: { name: "Team wallet", role: "signs real-money tests from 16 Nov 2026 in its own browser wallet; owner of the fee-split factory" },
  [lc(TEST_WALLET)]: { name: "Test wallet", role: "the team's real-money test wallet since 11 Nov 2026, signing in its own browser wallet" },
  [lc(ARENA_WALLET)]: { name: "Arena Agent Wallet", role: "the five AI traders' real-money trades in the Arena, through Troya Gate and inside its caps" },
  [lc(ATTESTOR)]: { name: "Gate attestor", role: "signs Troya Gate results and Seal receipts; holds no funds" },
  "0xa5c01a8c15eefc4f32fd9cfaf0e5e0cea02581fa": { name: "Test wallet's Agent Wallet", role: "created by the Troya server for the test wallet; pays back only to it" },
  "0x86030ce2975432227ede83027a31a16f33d68b80": { name: "Test wallet's Agent Wallet", role: "created by the Troya server for the test wallet; pays back only to it" },
  "0x8ed334bc7affecb524793abb8dbe9e88219473dc": { name: "Test wallet's Agent Wallet", role: "created by the Troya server for the test wallet; pays back only to it" },
  "0xb584fc6073d541150cbb7b5b25223326b7b3041e": { name: "Team wallet's Agent Wallet", role: "created by the Troya server for the team wallet; pays back only to it" },
};
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",");
const teamSet = () => new Set([TEST_WALLET, TEAM_WALLET, CREATOR, ...admins(), ...String(process.env.STATS_EXCLUDE || "").split(","), process.env.ARENA_LIVE_OWNER || ""]
  .map((a) => lc(a).trim()).filter(isAddr));

let store = null, root = "";
let rh = null;
const chain = () => (rh ||= import("./robinhood.mjs"));
const call = async (to, data) => (await chain()).rpc("robinhood", "eth_call", [{ to, data }, "latest"], { timeoutMs: 12_000 });
// an eth_call that should revert (a function the contract does not have): "reverts" or what it returned
const probe = (to, data) => call(to, data).then((r) => r).catch(() => "reverts");

/* ---------- Hyperliquid fills of the test wallet ---------- */
let fillCache = null;
async function hlFills() {
  if (fillCache && Date.now() - fillCache.at < 60_000) return fillCache.v;
  const fills = await hlInfo({ type: "userFills", user: TEST_WALLET.toLowerCase() });
  const v = {
    account: TEST_WALLET,
    source: "Hyperliquid info API: POST https://api.hyperliquid.xyz/info {\"type\":\"userFills\",\"user\":\"" + TEST_WALLET.toLowerCase() + "\"}",
    explorer: `https://app.hyperliquid.xyz/explorer/address/${TEST_WALLET}`,
    count: (fills || []).length,
    fills: (fills || []).map((f) => ({ time: new Date(f.time).toISOString(), coin: f.coin, dir: f.dir, side: f.side === "B" ? "buy" : "sell", px: Number(f.px), sz: Number(f.sz), closedPnl: Number(f.closedPnl), fee: Number(f.fee), oid: f.oid, hash: f.hash })),
  };
  fillCache = { at: Date.now(), v };
  return v;
}

/* ---------- the burn: 1,000,000,000 − totalSupply(), and every burn transaction ---------- */
const BURN_TTL = 5 * 60_000, SIG_FILE = "proof-burns.json";
let burnCache = null, burnP = null;
export async function burnView() {
  if (burnCache && Date.now() - burnCache.at < BURN_TTL) return burnCache.v;
  return (burnP ||= readBurn().finally(() => { burnP = null; }));
}
async function readBurn() {
  const { rpc } = await chain();
  const [supHex, deadHex, blockHex] = await Promise.all([call(TROYA, SEL.totalSupply), call(TROYA, SEL.balanceOf + word(DEAD)), rpc("robinhood", "eth_blockNumber", [])]);
  const supply = BigInt(supHex), atDead = BigInt(deadHex), burnedRaw = MINTED_RAW - supply;
  const fw = await store.readJson("flywheel.json", {});
  const sig = await store.readJson(SIG_FILE, {});
  const burns = (fw.burns || []).filter((b) => isHash(b.hash)).sort((a, b) => (b.block || 0) - (a.block || 0)).map((b) => {
    const s = sig[lc(b.hash)];
    return { hash: b.hash, block: b.block, troya: b.troya, url: txUrl(b.hash), signer: s?.from || null, call: s ? (s.sel === SEL.burn && lc(s.to) === lc(TROYA) ? "burn(uint256) on $TROYA" : `${s.sel} on ${s.to}`) : null };
  });
  const listed = burns.reduce((s, b) => s + (Number(b.troya) || 0), 0);
  const checked = burns.filter((b) => b.signer);
  const byCreator = checked.filter((b) => lc(b.signer) === lc(CREATOR) && b.call?.startsWith("burn(")).length;
  const v = {
    token: TROYA, chainId: 4663, block: Number(BigInt(blockHex)), checkedAt: Date.now(),
    minted: "1000000000", totalSupply: tok(supply), totalSupplyRaw: supply.toString(),
    burned: tok(burnedRaw), burnedRaw: burnedRaw.toString(), burnedWhole: int(burnedRaw), pctOfMinted: +(Number(burnedRaw * 1_000_000n / MINTED_RAW) / 10_000).toFixed(4),
    atDeadAddress: tok(atDead), atDeadAddressRaw: atDead.toString(),
    formula: "burned = 1,000,000,000 minted − totalSupply() now",
    how: "Every $TROYA burn so far used the token's own burn(), which takes the coins out of the total supply, so nothing sits at a dead address. Check it with totalSupply() on the token contract: 1,000,000,000 minus that number is what has been burned.",
    recipe: {
      totalSupply: { rpc: RPC_PUBLIC, body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TROYA, data: SEL.totalSupply }, "latest"] }, returns: supHex, decoded: `${tok(supply)} $TROYA (18 decimals)` },
      balanceOfDead: { rpc: RPC_PUBLIC, body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TROYA, data: SEL.balanceOf + word(DEAD) }, "latest"] }, returns: deadHex, decoded: `${tok(atDead)} $TROYA at 0x…dEaD` },
    },
    links: { token: `${BS}/token/${TROYA}`, readContract: `${BS}/token/${TROYA}?tab=read_contract`, blockscoutApi: `${BS}/api/v2/tokens/${TROYA}`, creator: addrUrl(CREATOR) },
    burns: { count: burns.length, listedTroya: +listed.toFixed(4), scannedTo: fw.scanned || null, signerChecked: checked.length, byCreatorWithBurn: byCreator,
      note: `Transfers of $TROYA from the creator wallet ${CREATOR} to the zero address, read from the chain since the launch block. Signers are read from each transaction.`, list: burns },
    thirdParty: "GeckoTerminal's token page still lists total_supply 1,000,000,000: that is the supply it stored at launch, not a live read. totalSupply() on the contract is the live number.",
  };
  burnCache = { at: Date.now(), v };
  paintBurn(v);
  return v;
}
// each burn's signer and call, read once from its transaction and kept (a transaction never changes)
async function checkBurnSigners() {
  const fw = await store.readJson("flywheel.json", {});
  const sig = await store.readJson(SIG_FILE, {});
  const todo = (fw.burns || []).filter((b) => isHash(b.hash) && !sig[lc(b.hash)]).sort((a, b) => (b.block || 0) - (a.block || 0)).slice(0, 40);   // newest first
  if (!todo.length) return;
  const { rpc } = await chain();
  const got = {};
  for (const b of todo) {
    const t = await rpc("robinhood", "eth_getTransactionByHash", [b.hash], { timeoutMs: 12_000 }).catch(() => null);
    if (t?.from && t?.to) got[lc(b.hash)] = { from: getAddress(t.from), to: getAddress(t.to), sel: String(t.input || "0x").slice(0, 10) };
    await sleep(300);
  }
  if (Object.keys(got).length) { await store.update(SIG_FILE, {}, (x) => ({ ...x, ...got })); burnCache = null; }
}

/* ---------- the Gate on $TROYA, every 10 minutes ---------- */
const GATE_EVERY = 10 * 60_000, GATE_AMOUNT = "0.01";
let gateEx = null, gating = false;
async function runGate() {
  if (gating) return gateEx;
  gating = true;
  try {
    const { gateCheck, rpc } = await chain();
    const g = await gateCheck({ tokenIn: "ETH", tokenOut: TROYA, amountIn: GATE_AMOUNT });
    // the simulated buy sent once more, pinned to a block, so the page can show a call anyone can replay
    let replay = null;
    const c = replayCall(g);
    if (c) {
      const block = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
      const params = [c.params[0], "0x" + block.toString(16), c.params[2]];
      try { replay = { block, ok: true, returnData: await rpc("robinhood", "eth_call", params, { timeoutMs: 15_000 }) }; }
      catch (e) { replay = { block, ok: false, error: String(e.message || e).slice(0, 200) }; }
    }
    const { plan, alternatives, ...quote } = g.quote || {};
    gateEx = { token: TROYA, amountEth: GATE_AMOUNT, pass: !!g.pass, checkedAt: g.checkedAt || Date.now(), checks: evidenceOf(g), quote, tx: g.tx ? { from: g.tx.from, to: g.tx.to, value: g.tx.value, data: g.tx.data, deadline: g.tx.deadline } : null,
      replay, call: c ? { ...c, params: [c.params[0], replay ? "0x" + replay.block.toString(16) : "latest", c.params[2]] } : null,
      api: `${SITE}/api/swap/gate?tokenIn=ETH&tokenOut=${TROYA}&amountIn=${GATE_AMOUNT}`, signedApi: `${SITE}/api/gate/v1/check/${TROYA}?amountEth=${GATE_AMOUNT}`,
      how: "Run by this server every 10 minutes with GET /api/swap/gate, the same call the Swap page, the app and Sentry make. Every check is an eth_call or a read of a public contract; nothing is signed or sent." };
    setFragment("gate-example", gateHtml(g, { token: TROYA, amount: GATE_AMOUNT, block: replay?.block ?? null, replay, apiUrl: gateEx.api }));
    setValue("gate.when", when(gateEx.checkedAt));
    setValue("gate.verdict", gateEx.pass ? "passed" : "did not pass");
    return gateEx;
  } catch (e) {
    console.warn("[proof] gate:", e.message);
    return gateEx;
  } finally { gating = false; }
}

/* ---------- contracts: read on chain every 30 minutes, Sourcify status every 6 hours ---------- */
let facts = null, factsAt = 0, sourcify = { at: 0, v: {} };
async function sourcifyOf(addrs) {
  if (Date.now() - sourcify.at < 6 * 3600_000 && addrs.every((a) => a in sourcify.v)) return sourcify.v;
  const v = { ...sourcify.v };
  for (const a of addrs) {
    try {
      const r = await fetch(`https://sourcify.dev/server/v2/contract/4663/${a}`, { signal: AbortSignal.timeout(8000) });
      const j = r.ok || r.status === 404 ? await r.json() : null;
      if (j) v[a] = j.match || null;
    } catch { /* keep the last */ }
  }
  sourcify = { at: Date.now(), v };
  return v;
}
async function contractFacts() {
  if (facts && Date.now() - factsAt < 30 * 60_000) return facts;
  const fw = await store.readJson("flywheel.json", {});
  const locked = [...new Set([LP_NFT, ...(fw.locked || []).map((p) => Number(p.tokenId)).filter((n) => n > 0)])];
  const [troyaOwner, stakeToken, stakeCooldown, stakeOwner, passOwner, factoryOwner, vaultOwner, codes, owners] = await Promise.all([
    probe(TROYA, SEL.owner), probe(STAKE, SEL.token), probe(STAKE, SEL.cooldown), probe(STAKE, SEL.owner), probe(PASS, SEL.owner), probe(SPLIT_FACTORY, SEL.owner), probe(OATH_VAULT, SEL.owner),
    Promise.all([STAKE, PASS, SPLIT_FACTORY, OATH_VAULT].map((a) => chain().then((m) => m.rpc("robinhood", "eth_getCode", [a, "latest"])).then((c) => (String(c || "0x").length - 2) / 2).catch(() => null))),
    Promise.all(locked.map((id) => probe(POSM, SEL.ownerOf + pad(id)).then((r) => ({ id, owner: r === "reverts" ? null : getAddress("0x" + String(r).slice(-40)) })))),
  ]);
  const src = await sourcifyOf([TROYA, STAKE, PASS, SPLIT_FACTORY, OATH_VAULT]);
  const addrOf = (r) => (r === "reverts" || !r ? null : getAddress("0x" + String(r).slice(-40)));
  const noOwner = (r) => (r === "reverts" ? "owner() reverts: the contract has no owner function" : `owner() returns ${addrOf(r)}`);
  const ownerCall = (to) => ({ rpc: RPC_PUBLIC, body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: SEL.owner }, "latest"] } });
  const ver = (a) => (src[a] ? `source verified on Sourcify (${src[a]})` : "source in the public repo; not yet verified on Sourcify");
  facts = { at: Date.now(), contracts: [
    { name: "$TROYA token", address: TROYA, by: "Pons Family token template (launched by the creator wallet)", url: `${BS}/token/${TROYA}`, facts: [noOwner(troyaOwner), "1,000,000,000 minted once at launch, straight into the Pons curve"], checks: [ownerCall(TROYA)], sourcify: src[TROYA] || null, tx: LAUNCH_TX },
    { name: "TroyaStake", address: STAKE, by: "Troya", source: `${SRC}/TroyaStake.sol`, url: addrUrl(STAKE), codeBytes: codes[0],
      facts: [noOwner(stakeOwner), `token() = ${addrOf(stakeToken) || "–"}${lc(addrOf(stakeToken)) === lc(TROYA) ? " ($TROYA)" : ""}`, `COOLDOWN() = ${stakeCooldown === "reverts" ? "–" : `${Number(BigInt(stakeCooldown))} seconds (${Number(BigInt(stakeCooldown)) / 86400} days)`}`, "no admin, pause, upgrade, fee or rescue function in its source", ver(STAKE)],
      checks: [ownerCall(STAKE), { rpc: RPC_PUBLIC, body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: STAKE, data: SEL.token }, "latest"] } }], sourcify: src[STAKE] || null },
    { name: "Troya Holder Pass (soulbound)", address: PASS, by: "Troya", source: `${SRC}/TroyaPass.sol`, url: addrUrl(PASS), codeBytes: codes[1], facts: [noOwner(passOwner), ver(PASS)], checks: [ownerCall(PASS)], sourcify: src[PASS] || null },
    { name: "TroyaFeeSplitter factory", address: SPLIT_FACTORY, by: "Troya", source: `${SRC}/TroyaFeeSplitter.sol`, url: addrUrl(SPLIT_FACTORY), codeBytes: codes[2], tx: SPLIT_DEPLOY_TX,
      facts: [noOwner(factoryOwner) + (lc(addrOf(factoryOwner)) === lc(TEAM_WALLET) ? " (the team wallet)" : ""), "the owner can only change where Troya's share goes (setTreasury); a coin's split is fixed when its splitter is created, Troya's share is capped at 20%, and the creator's share can never be redirected", ver(SPLIT_FACTORY)],
      checks: [ownerCall(SPLIT_FACTORY)], sourcify: src[SPLIT_FACTORY] || null },
    { name: "TroyaOathVault", address: OATH_VAULT, by: "Troya (deployed by the test wallet)", source: `${SRC}/TroyaOathVault.sol`, url: addrUrl(OATH_VAULT), codeBytes: codes[3], facts: [noOwner(vaultOwner), ver(OATH_VAULT)], checks: [ownerCall(OATH_VAULT)], sourcify: src[OATH_VAULT] || null },
    ...owners.map((o) => ({ name: `Uniswap v4 LP position #${o.id}`, address: POSM, tokenId: o.id, by: "Uniswap v4 PositionManager", url: `${BS}/token/${POSM}/instance/${o.id}`,
      facts: [o.owner ? `ownerOf(${o.id}) = ${o.owner}${lc(o.owner) === lc(DEAD) ? " (0x…dEaD: nobody can remove this liquidity)" : ""}` : "ownerOf could not be read"],
      checks: [{ rpc: RPC_PUBLIC, body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: POSM, data: SEL.ownerOf + pad(o.id) }, "latest"] } }], tx: o.id === LP_NFT ? LP_BURN_TX : (fw.locked || []).find((p) => Number(p.tokenId) === o.id)?.hash || null, deadOwned: lc(o.owner) === lc(DEAD) })),
  ] };
  factsAt = Date.now();
  return facts;
}

/* ---------- real trades by Troya's agents, every one with its transaction ---------- */
let tradesCache = null;
const hashesOf = (r) => {
  const out = [];
  const add = (h, label) => { if (isHash(h) && !out.some((x) => lc(x.hash) === lc(h))) out.push({ hash: h, label }); };
  if (!r || typeof r !== "object") return out;
  for (const s of r.steps || []) add(s?.hash, s?.label || "step");
  add(r.hash, "transaction");
  add(r.firstBuy?.hash, "first buy");
  return out;
};
const JOB = { autopilot: "Sentry Autopilot", champions: "Champions", aegis: "Aegis", playbook: "Playbook", x: "Trade on X", telegram: "Telegram", tg: "Telegram", app: "Agent Wallet (app)", assistant: "Ask Troya", wartable: "War Table", callouts: "War Table" };
export async function tradesView() {
  if (tradesCache && Date.now() - tradesCache.at < 2 * 60_000) return tradesCache.v;
  const team = teamSet();
  // Arena: the AI traders' real-money twins
  const a = await store.readJson("arena.json", {});
  const names = Object.fromEntries(Object.values(a.agents || {}).map((x) => [x.id, x.name || x.id]));
  let arenaWallet = ARENA_WALLET;
  if (isAddr(process.env.ARENA_LIVE_OWNER)) arenaWallet = (await import("./agentwallet.mjs").then((m) => m.getAgentWallet(process.env.ARENA_LIVE_OWNER)).catch(() => null))?.address || ARENA_WALLET;
  const arena = (a.positions || []).filter((p) => p.mode === "live" && (isHash(p.txBuy) || isHash(p.txSell))).map((p) => ({
    agent: names[p.agent] || p.agent, symbol: String(p.symbol || "").slice(0, 24), token: p.token, amountEth: p.amountEth, status: p.status, reason: p.reason || null,
    pnlEth: p.pnlEth ?? null, openedAt: p.openedAt, closedAt: p.closedAt || null, wallet: arenaWallet,
    txBuy: isHash(p.txBuy) ? p.txBuy : null, txSell: isHash(p.txSell) ? p.txSell : null, sealOpen: p.sealOpen || null, sealClose: p.sealClose || null,
  })).sort((x, y) => (y.closedAt || y.openedAt) - (x.closedAt || x.openedAt));
  // /verify: every real-money test transaction, with its signer (public/proof.json, built from the chain)
  let log = {}, verifySteps = 0;
  try { log = JSON.parse(await readFile(join(root, "public", "proof.json"), "utf8")); } catch { /* none */ }
  // the real-money steps on /verify are the articles with a roadmap number (data-v); the page's other cards are not tests
  try { verifySteps = ((await readFile(join(root, "public", "verify.html"), "utf8")).match(/<article class="step[^"]*" data-v="/g) || []).length; } catch { /* none */ }
  const verify = (log.transactions || []).filter((t) => isHash(t.hash) || /^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(String(t.hash || ""))).map((t) => ({
    step: t.step, what: t.what, chain: t.chain, hash: t.hash, url: t.explorer || txUrl(t.hash, t.chain), signer: t.signer || null, signerRole: t.signerRole || null, time: t.timeUtc || null, status: t.status || null }));
  // Agent Wallet jobs from the journal (the Arena is above; a row needs a transaction, so Hyperliquid orders are left out)
  const jobs = [];
  const TRADE = /^agent-wallet\.(swap|close|perp|twap|dca)$/;
  for (const e of await store.tail("journal.jsonl", 1e6, (x) => TRADE.test(x.kind || "") && x.status === "executed" && x.source !== "arena")) {
    const hs = hashesOf(e.data?.result);
    if (!hs.length) continue;
    const ch = String(e.data?.params?.chain || "robinhood").toLowerCase();
    jobs.push({ at: e.t, job: JOB[e.source] || e.source || "Agent Wallet", what: String(e.summary || e.kind).slice(0, 140), chain: ch, txs: hs.map((h) => ({ ...h, url: txUrl(h.hash, ch) })), team: team.has(lc(e.address)) });
  }
  // coins launched through Troya (web, X, Telegram); team tests are marked
  const launches = (await store.readJson("launches.json", [])).filter((l) => isHash(l.tx)).map((l) => ({
    at: l.at, symbol: String(l.symbol || "").slice(0, 24), name: String(l.name || "").slice(0, 48), token: l.token, source: l.source, tx: l.tx, url: txUrl(l.tx), team: !!l.teamTest || team.has(lc(l.owner)),
  })).sort((x, y) => (y.at || 0) - (x.at || 0));
  // paid Gate checks: x402 settlements and USDG deposits to the Gate API
  const x = await store.readJson("x402.json", {});
  const g = await store.readJson("gateapi.json", {});
  const sales = [
    ...(x.last || []).filter((s) => isHash(s.tx)).map((s) => ({ at: s.at, via: "x402", chain: NET[s.network] || s.network, tx: s.tx, url: txUrl(s.tx, NET[s.network]), team: team.has(lc(s.payer)) })),
    ...Object.entries(g.deposits || {}).filter(([k]) => isHash(k.split(":")[0])).map(([k, d]) => ({ at: d.at, via: "Gate API (USDG)", chain: "robinhood", tx: k.split(":")[0], url: txUrl(k.split(":")[0]), usdg: d.usdg, team: team.has(lc(d.from)) })),
  ].sort((p, q) => (q.at || 0) - (p.at || 0));
  // Herald payouts (Cup prizes, referral rewards), each a plain ETH transfer from the creator wallet
  const po = await store.readJson("payouts.json", {});
  const payouts = Object.values(po.weeks || {}).flatMap((w) => (w.items || []).filter((i) => isHash(i.hash)).map((i) => ({ at: w.at, season: w.season, kind: i.kind, usd: i.usd, eth: i.eth, tx: i.hash, url: txUrl(i.hash) })));
  const v = {
    checkedAt: Date.now(),
    counts: { verifySteps, arenaLive: arena.length, arenaTxs: arena.reduce((s, p) => s + (p.txBuy ? 1 : 0) + (p.txSell ? 1 : 0), 0), verifyTxs: verify.length, agentJobs: jobs.length, agentJobsOutside: jobs.filter((j) => !j.team).length, launches: launches.length, launchesOutside: launches.filter((l) => !l.team).length, gateSales: sales.length, gateSalesOutside: sales.filter((s) => !s.team).length, payouts: payouts.length },
    wallets: Object.entries(WALLETS).map(([k, w]) => ({ address: getAddress(k), ...w, url: addrUrl(getAddress(k)) })),
    arena, verify, jobs: jobs.sort((p, q) => q.at - p.at), launches, sales, payouts,
    note: "Only rows with a transaction hash are listed. Wallets are named only when the site already names them; a user's own Agent Wallet is shown by its transaction, never by its owner.",
  };
  tradesCache = { at: Date.now(), v };
  paintTrades(v);
  return v;
}

/* ---------- claims: what the site says, live or planned, with the evidence ---------- */
const st = (on) => (on ? "live" : "planned");
let claimsCache = null;
export async function claimsView() {
  if (claimsCache && Date.now() - claimsCache.at < 2 * 60_000) return claimsCache.v;
  const now = Date.now();
  const [b, t, c] = await Promise.all([burnView().catch(() => null), tradesView().catch(() => null), contractFacts().catch(() => null)]);
  const ge = gateEx;
  const stake = await import("./stake.mjs").then((m) => m.stakeTerms?.()).catch(() => null);
  let log = {};
  try { log = JSON.parse(await readFile(join(root, "public", "proof.json"), "utf8")); } catch { /* none */ }
  const work = await import("./botfacts.mjs").then((m) => m.workItems()).catch(() => []);
  const cOf = (name) => c?.contracts?.find((x) => x.name === name) || null;
  const ev = {
    tx: (hash, what, chainName = "robinhood") => ({ type: "tx", chain: chainName, hash, url: txUrl(hash, chainName), ...(what ? { what } : {}) }),
    contract: (address, what) => ({ type: "contract", chain: "robinhood", address, url: addrUrl(address), ...(what ? { what } : {}) }),
    api: (path, what) => ({ type: "api", url: path.startsWith("http") ? path : SITE + path, ...(what ? { what } : {}) }),
    page: (url, what) => ({ type: "page", url, ...(what ? { what } : {}) }),
    call: (body, what, returns) => ({ type: "eth_call", rpc: RPC_PUBLIC, body, ...(what ? { what } : {}), ...(returns != null ? { returns } : {}) }),
  };
  const claims = [];
  const add = (id, claim, status, evidence, extra = {}) => claims.push({ id, claim, status, evidence: evidence.filter(Boolean), checkedAt: extra.checkedAt || now, ...extra });
  add("token", "$TROYA is a Pons token on Robinhood Chain (chain 4663): 1,000,000,000 minted once at launch, and the token contract has no owner() function.", "live", [
    ev.contract(TROYA, "the token"), ev.tx(LAUNCH_TX, "the launch on Pons, signed by the creator wallet"),
    ev.call({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TROYA, data: SEL.owner }, "latest"] }, "owner()", "reverts"),
  ]);
  if (b) add("burn", `${b.burned} $TROYA burned so far (${b.pctOfMinted}% of the 1,000,000,000 minted): 1,000,000,000 − totalSupply() ${b.totalSupply}. Every burn used the token's own burn(), so the supply itself went down; balanceOf(0x…dEaD) is ${b.atDeadAddress}. ${b.burns.signerChecked} of ${b.burns.count} burn transactions checked: ${b.burns.byCreatorWithBurn} signed by the creator wallet ${CREATOR} calling burn(uint256).`, "live", [
    ev.call(b.recipe.totalSupply.body, "totalSupply()", b.recipe.totalSupply.returns), ev.call(b.recipe.balanceOfDead.body, "balanceOf(0x…dEaD)", b.recipe.balanceOfDead.returns),
    ev.api("/api/proof/burn", "every burn transaction and its signer"), ev.page(b.links.token, "the token on Blockscout (total supply)"),
    ...b.burns.list.map((x) => ev.tx(x.hash, `burn of ${Number(x.troya).toLocaleString("en-US", { maximumFractionDigits: 2 })} $TROYA`)),
  ], { checkedAt: b.checkedAt, block: b.block });
  const lp = c?.contracts?.filter((x) => x.tokenId) || [];
  if (lp.length) add("liquidity-locked", `${lp.filter((x) => x.deadOwned).length} Uniswap v4 $TROYA/ETH liquidity position${lp.length === 1 ? "" : "s"} owned by 0x…dEaD (#${lp.map((x) => x.tokenId).join(", #")}), so that liquidity cannot be removed.`, st(lp.some((x) => x.deadOwned)), [
    ...lp.map((x) => x.tx && ev.tx(x.tx, `position #${x.tokenId} sent or minted to 0x…dEaD`)), ...lp.map((x) => ev.call(x.checks[0].body, `ownerOf(${x.tokenId}) on the PositionManager`)),
  ], { checkedAt: c.at });
  add("gate", "Troya Gate checks any Robinhood Chain coin before a buy, free and without a wallet: route, price impact, pool depth, fees and taxes, the exact swap simulated with eth_call, a test sell and a transfer-tax probe. Fail one and no order is offered.", ge ? "live" : "planned", [
    ev.api(`/api/swap/gate?tokenIn=ETH&tokenOut=${TROYA}&amountIn=0.01`, "run it yourself (any coin: change tokenOut)"), ev.api("/api/proof/gate", "this server's last run on $TROYA, every check with what it read"),
    ge?.call && { type: "eth_call", rpc: RPC_PUBLIC, body: ge.call, what: `the simulated buy of ${ge.amountEth} ETH, pinned to block ${ge.replay?.block}`, returns: ge.replay?.ok ? (ge.replay.returnData ?? "0x") : "reverts" },
    ev.page(`${SITE}/proof#gate`, "the live box: paste a coin, no wallet"),
  ], { checkedAt: ge?.checkedAt || now, example: ge ? { pass: ge.pass, checks: ge.checks.map(({ key, status, detail }) => ({ key, status, detail })) } : null });
  add("gate-signed", `Signed Gate results for agents: GET /api/gate/v1/check/<coin> returns the result signed by the attestor ${ATTESTOR} (EIP-191 over keccak256 of the JSON); POST /api/gate/v1/verify checks a signature. A few free checks a day per IP, then 0.01 USDG on Robinhood Chain${process.env.X402_ENABLED === "1" ? " or $0.01 USDC over x402" : ""}.`, "live", [
    ev.api("/api/gate/v1", "price, pay-to, attestor, totals"), ev.api("/api/gate/x402", "x402 terms"), ev.contract(ATTESTOR, "the attestor (holds no funds)"),
  ]);
  if (t) {
    const sOut = t.sales.filter((s) => !s.team).length;
    add("gate-sales", `${t.sales.length} paid Gate checks with an on-chain payment (${sOut} from wallets outside the team, ${t.sales.length - sOut} team tests).`, st(t.sales.length > 0), t.sales.map((s) => ev.tx(s.tx, `${s.via}${s.team ? " (team test)" : ""}`, s.chain)));
    add("arena-live", `The Arena's AI traders made ${t.counts.arenaLive} real-money trades (${t.counts.arenaTxs} transactions) from the Arena Agent Wallet ${t.arena[0]?.wallet || ARENA_WALLET}, through Troya Gate and inside its caps. Results, losses included, are public.`, st(t.counts.arenaLive > 0), [
      ev.contract(t.arena[0]?.wallet || ARENA_WALLET, "the Arena Agent Wallet"), ev.api("/api/arena", "the board"),
      ...t.arena.flatMap((p) => [p.txBuy && ev.tx(p.txBuy, `${p.agent} bought $${p.symbol}`), p.txSell && ev.tx(p.txSell, `${p.agent} sold $${p.symbol}`)]),
    ]);
    add("real-money-tests", `${t.counts.verifyTxs} real-money test transactions on /verify, each with its signer and role (test wallet, team wallet, their Agent Wallets, bridge relayers).`, st(t.counts.verifyTxs > 0), [
      ev.page(`${SITE}/verify`), ...t.verify.map((x) => ({ type: "tx", chain: x.chain, hash: x.hash, url: x.url, what: `${x.step}: ${x.what}` })),
    ]);
    add("agent-jobs", `${t.counts.agentJobs} Agent Wallet trades executed by Troya's jobs and bots (Autopilot, Champions, Aegis, playbooks, Telegram, X, the app), ${t.counts.agentJobsOutside} of them for wallets outside the team.`, st(t.counts.agentJobs > 0), t.jobs.flatMap((j) => j.txs.map((x) => ({ type: "tx", chain: j.chain, hash: x.hash, url: x.url, what: `${j.job}${j.team ? " (team)" : ""}: ${j.what}` }))));
    add("launches", `${t.counts.launches} coins launched through Troya (troya.codes, X, Telegram), ${t.counts.launchesOutside} by wallets outside the team.`, st(t.counts.launches > 0), t.launches.map((l) => ev.tx(l.tx, `$${l.symbol} via ${l.source}${l.team ? " (team test)" : ""}`)));
    const hm = ["live", "dry", "off"].includes(process.env.HERALD_PAYOUTS) ? process.env.HERALD_PAYOUTS : "dry";
    add("herald-payouts", t.payouts.length ? `${t.payouts.length} Herald payouts (Arena Cup prizes, referral rewards) sent in ETH from the creator wallet.` : `Herald payouts (weekly Arena Cup prizes and referral rewards in ETH from the creator wallet): none sent yet (mode "${hm}"). ${hm === "live" ? "The first run is after the Cup week closes." : "Nothing is sent until the mode is live."}`, st(t.payouts.length > 0), [ev.api("/api/payouts", "every week and payment"), ...t.payouts.map((p) => ev.tx(p.tx, `${p.kind} ${p.season || ""}`.trim()))]);
  }
  const sk = cOf("TroyaStake");
  add("staking", `TroyaStake ${STAKE}: stake $TROYA, unstake with a 3-day wait, then withdraw. No owner, admin, pause, upgrade, fee or rescue function.`, st(!!stake?.deployed || (sk?.codeBytes > 0)), [
    ev.contract(STAKE, "the staking contract"), sk && ev.call(sk.checks[0].body, "owner()", "reverts"), sk && ev.call(sk.checks[1].body, "token()", TROYA), { type: "source", url: `${SRC}/TroyaStake.sol` }, ev.api("/api/stake", "tiers and perks"),
  ], { facts: sk?.facts || [] });
  const rewards = String(process.env.STAKE_REWARDS || "dry");
  add("staking-rewards", rewards === "live" ? "A daily share of $TROYA creator fees is paid into TroyaStake (notifyReward) for stakers to claim." : `A daily share of $TROYA creator fees paid to stakers: worked out every day but not sent yet (mode "${rewards}"). It is paid once switched on, the first time 7 days after the contract went live.`, st(rewards === "live"), [ev.api("/api/feesplit", "the split, its mode and schedule")]);
  // the automated scan of TroyaStake (public/security/, 22 Nov 2026): read from its summary file, so the numbers here are the published ones
  let scan = null;
  try { scan = JSON.parse(await readFile(join(root, "public", "security", "troyastake-scan.json"), "utf8")); } catch { /* not published */ }
  if (scan && scan.contract?.address?.toLowerCase() === STAKE.toLowerCase()) {
    const ran = scan.tools.filter((x) => x.status !== "not run"), a = scan.counts.afterTriage;
    add("staking-scan", `TroyaStake was scanned on ${scan.date} with ${ran.map((x) => `${x.tool} ${x.version}`).join(" and ")} (free static analyzers) on the exact verified source: ${scan.counts.beforeTriage.total} results before triage, ${a.real} real issues after it (${a.informational} informational, ${a.falsePositive} false positives), each explained. ${scan.label}.`, "live", [
      ev.page(`${SITE}/security/troyastake-scan.json`, "the summary: tools, versions, commands, every result with its verdict"),
      ...ran.flatMap((x) => x.runs.map((r) => ev.page(`${SITE}${r.raw.text}`, `${x.tool} ${x.version} raw output${x.runs.length > 1 ? `, ${r.pass}` : ""}`))),
      ev.page(`${SITE}/agent#/stake`, "the Stake page, How it works on-chain"),
    ], { checkedAt: Date.parse(scan.scannedAt?.["slither pass 1"] || scan.date) || now });
  }
  const pass = cOf("Troya Holder Pass (soulbound)"), fac = cOf("TroyaFeeSplitter factory"), vault = cOf("TroyaOathVault");
  if (pass) add("holder-pass", `Troya Holder Pass ${PASS}: a soulbound NFT for wallets holding 1,000,000 $TROYA, used for signed pass votes. ${pass.facts[0]}.`, "live", [ev.contract(PASS), ev.call(pass.checks[0].body, "owner()"), { type: "source", url: pass.source }, ev.api("/api/pass")]);
  if (fac) add("fee-splitter", `Coins launched through Troya by wallets without 1,000,000 $TROYA send their creator fees to a TroyaFeeSplitter clone from the factory ${SPLIT_FACTORY}: Troya's share is fixed per coin (capped at 20%) and the creator's share cannot be redirected. ${fac.facts[0]}; it can only change where Troya's share goes.`, "live", [ev.contract(SPLIT_FACTORY), ev.tx(SPLIT_DEPLOY_TX, "factory deployment"), ev.call(fac.checks[0].body, "owner()"), { type: "source", url: fac.source }, ev.api("/api/launch/splitter")]);
  if (vault) add("oath-vault", `TroyaOathVault ${OATH_VAULT}: coins locked for an Oath leave only as they unlock. ${vault.facts.join("; ")}.`, "live", [ev.contract(OATH_VAULT), { type: "sourcify", url: `https://sourcify.dev/server/v2/contract/4663/${OATH_VAULT}`, match: vault.sourcify }, ev.call(vault.checks[0].body, "owner()", "reverts"), ev.api("/api/oath")]);
  const seal = await store.readJson("seal.json", {});
  const anchors = Object.entries(seal.days || {}).filter(([, d]) => isHash(d.anchorTx)).sort((p, q) => (p[0] < q[0] ? 1 : -1)).slice(0, 30);
  add("seal", `Troya Seal: signed, hash-chained receipts (ECDSA by ${ATTESTOR} and ML-DSA-65) for Gate API checks, Arena trades and Record calls; ${seal.seq || 0} receipts so far, each day's last hash anchored on Robinhood Chain (${anchors.length} anchors listed).`, st(anchors.length > 0), [ev.api("/api/seal", "keys, days and anchors"), ...anchors.map(([d, x]) => ev.tx(x.anchorTx, `anchor of ${d}`))]);
  add("sentry", "Troya Sentry runs the Gate on new Pons launches and new pools; every result is public, failed ones included, and the channel posts only clean passes with real buying.", "live", [ev.api("/api/sentry/recent", "latest results"), ev.page("https://t.me/s/troyasentry", "the channel, readable without Telegram")]);
  add("record", "The Record: every coin Sentry posts is a call, written down at the post price and graded 24 hours later, misses included.", "live", [ev.api("/api/record?limit=500", "every call"), ev.page(`${SITE}/record`)]);
  add("open-source", "The Gate, the Agent Wallet caps, Sentry, the bots, the contracts, the MCP server and the CLI are public under MIT; the MCP server, the CLI and the Snap are on npm.", "live", [{ type: "repo", url: GITHUB }, ev.api("https://registry.npmjs.org/@troyaagent/mcp", "npm: @troyaagent/mcp"), ev.api("https://registry.npmjs.org/@troyaagent/cli", "npm: @troyaagent/cli"), ev.api("https://registry.npmjs.org/@troyaagent/snap", "npm: @troyaagent/snap")]);
  add("autopilot-live", process.env.AUTOPILOT_LIVE === "1" ? "Sentry Autopilot can trade live from a user's Agent Wallet, inside the caps the user sets; practice mode uses play money at real prices." : "Sentry Autopilot runs in practice mode (play money at real prices); live trading from the Agent Wallet is not switched on on this server yet.", st(process.env.AUTOPILOT_LIVE === "1"), [ev.page(`${SITE}/agent#/agent/sentry`)]);
  const feed = String(process.env.ACTIVITY_FEED || "dry");
  add("activity-feed", feed === "live" ? "Troya posts real activity (launches, stakers, agents, Gate use, payouts) to its Telegram group by itself." : `The activity feed (Troya posting real launches, stakers and payouts to its Telegram group) is built but not posting yet (mode "${feed}").`, st(feed === "live"), []);
  add("x402", process.env.X402_ENABLED === "1" ? "Troya Gate over x402: $0.01 USDC per signed check on Base (also Arbitrum, Polygon, and USDG on Robinhood Chain)." : "Troya Gate over x402 is not switched on on this server.", st(process.env.X402_ENABLED === "1"), [ev.api("/api/gate/x402"), ev.api("/.well-known/x402")]);
  add("snap", "The Troya Gate Snap is on npm and runs in MetaMask Flask; regular MetaMask needs MetaMask's allowlist review, which is pending.", "planned", [ev.api("https://registry.npmjs.org/@troyaagent/snap", "npm: @troyaagent/snap"), ev.page(`${SITE}/snap`)], { note: "planned: in every MetaMask after the allowlist review" });
  // staking and the activity feed have their own claims above, read from the chain and from the server's switches
  for (const w of work) if (!["stake", "activity"].includes(w.key) && !claims.some((x) => x.id === w.key)) add(`work-${w.key}`, `${w.name}: ${w.says}`, w.status === "building" ? "planned" : "live", [], { from: "the WORK IN PROGRESS list the bots and the assistant answer from (server/botfacts.mjs)" });
  add("no-audit", "There is no third-party security audit of Troya. The Agent Wallet is custodial by design: the operator stores its key encrypted, so keep it small.", "live", [ev.page(`${SITE}/verify#no-h`)]);
  const v = {
    name: "Troya Agent proof", site: `${SITE}/proof`, version: 2, generated: new Date(now).toISOString(),
    howToCheck: "Each claim has status live or planned. Evidence is a transaction hash, a contract address, an API URL on this site or an eth_call you can send to a public Robinhood Chain RPC yourself (chain id 4663). Nothing here needs a wallet.",
    token: TROYA, chainId: 4663, rpc: RPC_PUBLIC, explorer: BS,
    wallets: t?.wallets || [], contracts: c?.contracts || [], claims,
    burn: b ? { burned: b.burned, totalSupply: b.totalSupply, pctOfMinted: b.pctOfMinted, block: b.block, formula: b.formula, checkedAt: b.checkedAt } : null,
    trades: t?.counts || null,
    team: { github: "https://github.com/troyaagent", repo: GITHUB, x: "https://x.com/Troyaagent", telegram: "https://t.me/troyaagent", sentryChannel: "https://t.me/troyasentry", npm: "https://www.npmjs.com/org/troyaagent",
      creatorWallet: CREATOR, teamWallet: TEAM_WALLET, testWallet: TEST_WALLET, stakingAdmin: "none: TroyaStake has no owner or admin", audit: "none" },
    // the /verify transaction log (public/proof.json), kept here so older readers of /proof.json find it where it was
    transactions: log.transactions || [], testWallet: log.testWallet || TEST_WALLET, note: log.note || null,
  };
  claimsCache = { at: now, v };
  paintClaims(v);
  return v;
}

/* ---------- HTML written into the pages (server/livehtml.mjs) ---------- */
const A = (url, text) => `<a class="ulink" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const T = (hash, text, chainName) => A(txUrl(hash, chainName), text || short(hash));
const tile = (k, v, sub = "") => `<div class="rec-tile"><span>${esc(k)}</span><b>${esc(v)}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
const eth = (x) => (x == null || !isFinite(x) ? "–" : `${Number(x).toFixed(Math.abs(x) >= 0.01 ? 4 : 6)} ETH`);
function paintBurn(v) {
  const whole = commas(v.burnedWhole);
  setValue("burn.int", whole, v.burnedWhole);
  setValue("burn.total", whole);
  setValue("burn.pct", v.pctOfMinted.toFixed(2));
  setValue("burn.supply", commas(int(BigInt(v.totalSupplyRaw))));
  setValue("burn.count", String(v.burns.count));
  setValue("burn.block", commas(v.block));
  setValue("burn.when", when(v.checkedAt));
  setFragment("burn-tiles", [
    tile("$TROYA burned", whole, `${v.pctOfMinted.toFixed(2)}% of the 1,000,000,000 minted`),
    tile("Total supply now", commas(int(BigInt(v.totalSupplyRaw))), `totalSupply() at block ${commas(v.block)}`),
    tile("Burn transactions", String(v.burns.count), v.burns.signerChecked ? `${v.burns.byCreatorWithBurn} of ${v.burns.signerChecked} checked: creator wallet, burn()` : "signed by the creator wallet"),
  ].join(""));
  // "every burn was signed by the creator wallet" only when the chain agrees: the listed burns add up to the supply drop and
  // every one of them was read back as the creator wallet calling burn()
  const gap = v.burnedWhole - v.burns.listedTroya;
  const allCreator = Math.abs(gap) < 1 && v.burns.count > 0 && v.burns.byCreatorWithBurn === v.burns.count;
  const who = allCreator ? `Every burn so far was signed by the creator wallet ${A(addrUrl(CREATOR), short(CREATOR))} calling the token's own burn()`
    : `The ${v.burns.count} burns listed below left the creator wallet ${A(addrUrl(CREATOR), short(CREATOR))} (${v.burns.byCreatorWithBurn} of them read back so far as that wallet calling burn()) and add up to ${esc(commas(Math.floor(v.burns.listedTroya)))} $TROYA${gap >= 1 ? `; the other ${esc(commas(Math.round(gap)))} left the supply in transactions this list has not read yet (it is read from the chain every 5 minutes)` : ""}`;
  setValue("burn.who", allCreator ? "Every burn so far was signed by the creator wallet." : "Each burn is listed with the wallet that signed it.");
  setFragment("burn-note", `<p class="rec-note pf-burn-note"><b>${esc(whole)} $TROYA burned</b> = 1,000,000,000 minted − totalSupply() ${esc(v.totalSupply)} (read on chain at block ${esc(commas(v.block))}, ${esc(when(v.checkedAt))}). Burned with the token's own burn(), so the supply itself goes down and nothing sits at a dead address (balanceOf(0x…dEaD) = ${esc(v.atDeadAddress)}). ${who}. Check it yourself: ${A(v.links.token, "totalSupply on Blockscout")} · ${A(v.links.readContract, "read the contract")} · ${A(`${SITE}/api/proof/burn`, "every burn as JSON")}.</p>`);
  setFragment("burn-rows", v.burns.list.length ? v.burns.list.map((b) => `<tr><td>${esc(commas(b.block))}</td><td>${esc(Number(b.troya).toLocaleString("en-US", { maximumFractionDigits: 2 }))} $TROYA</td><td>${b.signer ? `${esc(lc(b.signer) === lc(CREATOR) ? "creator wallet" : short(b.signer))}${b.call ? ` · ${esc(b.call.replace(" on $TROYA", ""))}` : ""}` : '<span class="rec-na">reading</span>'}</td><td>${T(b.hash)}</td></tr>`).join("")
    : '<tr><td colspan="4" class="rec-empty">No burn listed yet.</td></tr>');
}
function paintTrades(v) {
  const c = v.counts;
  setValue("trades.arena", String(c.arenaLive));
  setValue("trades.verify", String(c.verifyTxs));
  setValue("trades.steps", String(c.verifySteps));
  setValue("trades.jobs", String(c.agentJobs));
  setValue("trades.launches", String(c.launches));
  setFragment("trade-tiles", [
    tile("Arena live trades", String(c.arenaLive), `${c.arenaTxs} transactions by the Arena Agent Wallet`),
    tile("Real-money tests", String(c.verifySteps || "–"), `steps on /verify, ${c.verifyTxs} transactions`),
    tile("Agent Wallet jobs", String(c.agentJobs), `${c.agentJobsOutside} for wallets outside the team`),
    tile("Coins launched", String(c.launches), `${c.launchesOutside} by wallets outside the team`),
    tile("Paid Gate checks", String(c.gateSales), `${c.gateSalesOutside} from outside the team`),
    tile("Herald payouts", String(c.payouts), c.payouts ? "ETH transfers from the creator wallet" : "none sent yet"),
  ].join(""));
  setFragment("trades-arena", v.arena.length ? v.arena.map((p) => `<tr><td>${esc(when(p.closedAt || p.openedAt))}</td><td>${esc(p.agent)}</td><td>$${esc(p.symbol)}<small>${esc(short(p.token))}</small></td><td>${esc(eth(p.amountEth))}</td><td>${p.status === "closed" ? `${p.pnlEth == null ? "–" : `<span class="${p.pnlEth >= 0 ? "rec-up" : "rec-dn"}">${p.pnlEth >= 0 ? "+" : ""}${esc(eth(p.pnlEth))}</span>`}<small>${esc(p.reason || "closed")}</small>` : "open"}</td><td>${p.txBuy ? T(p.txBuy, "buy") : ""}${p.txBuy && p.txSell ? " · " : ""}${p.txSell ? T(p.txSell, "sell") : ""}</td></tr>`).join("")
    : '<tr><td colspan="6" class="rec-empty">No live Arena trade yet.</td></tr>');
  setFragment("trades-verify", v.verify.length ? v.verify.map((x) => `<tr><td>${esc(x.time ? when(Date.parse(x.time)) : "–")}</td><td>${esc(x.step)}<small>${esc(x.what)}</small></td><td>${esc(x.chain)}</td><td>${x.signer ? `${esc(WALLETS[lc(x.signer)]?.name || short(x.signer))}<small>${esc(x.signerRole || "")}</small>` : "–"}</td><td>${A(x.url, short(x.hash))}</td></tr>`).join("")
    : '<tr><td colspan="5" class="rec-empty">No test listed.</td></tr>');
  setFragment("trades-jobs", v.jobs.length ? v.jobs.slice(0, 200).map((j) => `<tr><td>${esc(when(j.at))}</td><td>${esc(j.job)}${j.team ? "<small>team</small>" : ""}</td><td>${esc(j.what)}</td><td>${j.txs.map((x) => A(x.url, x.label === "transaction" ? short(x.hash) : x.label)).join(" · ")}</td></tr>`).join("")
    : '<tr><td colspan="4" class="rec-empty">No Agent Wallet job has traded on chain yet.</td></tr>');
  setFragment("trades-launches", v.launches.length ? v.launches.map((l) => `<tr><td>${esc(when(l.at))}</td><td>$${esc(l.symbol)}<small>${esc(l.name)}</small></td><td>${esc(l.source)}${l.team ? "<small>team test</small>" : ""}</td><td>${A(`${BS}/token/${l.token}`, short(l.token))}</td><td>${A(l.url, short(l.tx))}</td></tr>`).join("")
    : '<tr><td colspan="5" class="rec-empty">No launch yet.</td></tr>');
  setFragment("trades-sales", (v.sales.length || v.payouts.length) ? [...v.sales.map((s) => `<tr><td>${esc(when(s.at))}</td><td>Paid Gate check · ${esc(s.via)}${s.team ? "<small>team test</small>" : ""}</td><td>${esc(s.chain)}</td><td>${A(s.url, short(s.tx))}</td></tr>`), ...v.payouts.map((p) => `<tr><td>${esc(when(p.at))}</td><td>Herald payout · ${esc(p.kind)}</td><td>robinhood</td><td>${A(p.url, short(p.tx))}</td></tr>`)].join("")
    : '<tr><td colspan="4" class="rec-empty">No paid check or payout yet.</td></tr>');
  setFragment("wallets", v.wallets.map((w) => `<tr><td>${esc(w.name)}<small>${esc(w.role)}</small></td><td>${A(w.url, w.address)}</td></tr>`).join(""));
}
function paintClaims(v) {
  const rows = (s) => v.claims.filter((x) => x.status === s).map((x) => `<li class="pf-claim pf-${esc(x.status)}"><span class="pf-st">${x.status === "live" ? "Live" : "Planned"}</span><div><p>${esc(x.claim)}</p>${x.evidence.length ? `<small>${x.evidence.slice(0, 4).map((e) => e.url ? A(e.url, e.what || e.type) : e.body ? `<code>${esc(e.what || "eth_call")}</code>` : "").filter(Boolean).join(" · ")}${x.evidence.length > 4 ? ` · ${x.evidence.length - 4} more in proof.json` : ""}</small>` : ""}</div></li>`).join("");
  setFragment("claims-live", rows("live") || '<li class="pf-claim">–</li>');
  setFragment("claims-planned", rows("planned") || '<li class="pf-claim">Nothing planned is listed.</li>');
  setFragment("contracts", (v.contracts || []).map((c) => `<tr><td>${esc(c.name)}<small>${esc(c.by)}</small></td><td>${A(c.url, c.tokenId ? `#${c.tokenId}` : c.address)}${c.source ? `<small>${A(c.source, "source")}</small>` : ""}</td><td class="pf-wrap">${c.facts.map((f) => esc(f)).join("<br>")}${c.tx ? `<small>${T(c.tx, "transaction")}</small>` : ""}</td></tr>`).join(""));
  setValue("claims.live", String(v.claims.filter((x) => x.status === "live").length));
  setValue("claims.planned", String(v.claims.filter((x) => x.status === "planned").length));
}

/* ---------- routes and timers ---------- */
export async function register(r, ctx) {
  store = ctx.store; root = ctx.root || process.cwd();
  r.get("/api/proof/hl-fills", () => hlFills(), { perMin: 30 });
  r.get("/api/proof/burn", () => burnView(), { perMin: 120 });
  r.get("/api/proof/gate", async () => gateEx || (await runGate()) || { error: "The first Gate run has not finished yet." }, { perMin: 60 });
  r.get("/api/proof/trades", () => tradesView(), { perMin: 60 });
  r.get("/api/proof/fragments", () => fragments(), { perMin: 60 });
  r.get("/api/proof/claims", ({ res }) => { res.setHeader("access-control-allow-origin", "*"); return claimsView(); }, { perMin: 60 });
  // warm everything soon after a start, then keep it fresh: the burn every 5 minutes (signers read once per transaction),
  // the Gate every 10, trades and claims every 5
  const warm = async () => {
    await burnView().catch((e) => console.warn("[proof] burn:", e.message));
    await tradesView().catch((e) => console.warn("[proof] trades:", e.message));
    await claimsView().catch((e) => console.warn("[proof] claims:", e.message));
  };
  if (process.env.PROOF_WARM !== "0") {
    setTimeout(() => { warm(); }, 15_000).unref?.();
    setTimeout(() => { runGate().then(() => { claimsCache = null; return claimsView(); }).catch(() => {}); }, 45_000).unref?.();
    setTimeout(() => { checkBurnSigners().catch((e) => console.warn("[proof] signers:", e.message)); }, 90_000).unref?.();
    setInterval(() => { burnCache = null; tradesCache = null; claimsCache = null; warm(); checkBurnSigners().catch(() => {}); }, 5 * 60_000).unref?.();
    setInterval(() => { runGate().catch(() => {}); }, GATE_EVERY).unref?.();
  }
}
