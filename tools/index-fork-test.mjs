// Troya Index end to end on a local Robinhood Chain fork (anvil). Nothing touches mainnet: every RPC points at the fork.
//   anvil --fork-url https://robinhood-rpc.publicnode.com --port 8547 --chain-id 4663
//   node tools/index-fork-test.mjs
// 1 deploy from a test account with exactly the deploy page's calldata (public/agent/desk/index-deploy-lib.js), hand the
//   vault to the Safe (impersonated on the fork to accept) · 2 deposits · 3 the server keeper (server/index-keeper.mjs):
//   hourly pokeAll, then rebalances through Troya Gate (the real gateCheck) after each cooldown, inside the move cap ·
//   4 the public API views · 5 a proposal and a pause are seen and turned into alerts · 6 a zap deposit as the page quotes it ·
//   7 everybody redeems in kind.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORK = process.env.FORK_RPC || "http://127.0.0.1:8547";
process.env.ROBINHOOD_RPCS = FORK; process.env.ROBINHOOD_RPC = FORK; process.env.ROBINHOOD_WIDE_RPC = FORK;
process.env.RPC_TIMEOUT_MS = "60000";
process.env.INDEX_OFF = "1";             // no timers: this test drives every pass itself
process.env.RECORD = "0";
process.env.KYBER = "0";            // KyberSwap is a live mainnet service: on a time-shifted fork the Gate uses Troya's own Uniswap routes
const DATA = await mkdtemp(join(tmpdir(), "troya-index-fork-"));
process.env.DATA_DIR = DATA;

const { JsonRpcProvider, FetchRequest, Interface, parseEther, formatEther, getAddress } = await import("ethers");
const fr = new FetchRequest(FORK); fr.timeout = 900_000;          // a fork fetching fresh state from the network can be slow
const provider = new JsonRpcProvider(fr, 4663, { staticNetwork: true });
const anvil = (m, p = []) => provider.send(m, p);
assert.equal(Number((await provider.getNetwork()).chainId), 4663, "the fork must be Robinhood Chain");
const ROOT = new URL("..", import.meta.url).pathname;
const L = await import(ROOT + "public/agent/desk/index-deploy-lib.js");
const build = JSON.parse(await readFile(ROOT + "public/agent/desk/troya-index.json", "utf8"));
const V = new Interface(build.contracts.TroyaIndex.abi);
const Z = new Interface(build.contracts.TroyaIndexZap.abi);
const ERC = new Interface(["function balanceOf(address) view returns (uint256)"]);
const { initStore } = await import(ROOT + "server/store.mjs");
const store = await initStore(DATA);
const routes = [];
const router = { get: (p, fn) => routes.push({ p, fn }), post() {}, del() {} };
await (await import(ROOT + "server/robinhood.mjs")).register(router, { store, dataDir: DATA });
const K = await import(ROOT + "server/index-keeper.mjs");
await K.register(router, { store, dataDir: DATA });
const route = (p) => routes.find((x) => x.p === p).fn;

let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };
const accounts = await anvil("eth_accounts");
const [DEPLOYER, ALICE, BOB, CAROL] = accounts.map(getAddress);
for (const a of [DEPLOYER, ALICE, BOB, CAROL]) await anvil("anvil_setBalance", [a, "0x" + parseEther("10").toString(16)]);
const send = async (from, tx) => {
  const t = { from, ...tx, ...(tx.value != null ? { value: "0x" + BigInt(tx.value).toString(16) } : {}) };
  const gas = BigInt(await anvil("eth_estimateGas", [t]));          // the forked block's gas limit would otherwise be the default
  const hash = await anvil("eth_sendTransaction", [{ ...t, gas: "0x" + ((gas * 13n) / 10n).toString(16) }]);
  const rc = await provider.waitForTransaction(hash);
  assert.equal(rc.status, 1, `tx ${hash} failed`);
  return rc;
};
const call = async (to, iface, fn, args = [], from) => iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn, args), ...(from ? { from } : {}) }));
// the fork's clock moves ahead by hours; this process's clock follows it, so swap deadlines built by Troya Gate (from
// Date.now) are not "too old" on the fork
const realNow = Date.now;
let skew = (await provider.getBlock("latest")).timestamp * 1000 - realNow();   // a reused fork may already be ahead
Date.now = () => realNow() + skew;
const hours = async (k) => { await anvil("evm_increaseTime", [3600 * k]); await anvil("evm_mine"); skew += 3600_000 * k; };

/* ---------- 1 deploy with the page's calldata ---------- */
const keeper = (await route("/api/index/keeper")({})).address;
assert.ok(/^0x[0-9a-fA-F]{40}$/.test(keeper) && !K.isTeamWallet(keeper));
const r1 = await send(DEPLOYER, { data: L.swapperData(build) });
const swapper = r1.contractAddress;
const r2 = await send(DEPLOYER, { data: L.vaultData(build, { owner: DEPLOYER, swapper, keeper }) });
const vault = r2.contractAddress;
const r3 = await send(DEPLOYER, { data: L.zapData(build, vault) });
const zap = r3.contractAddress;
console.log(`  gas: swapper ${r1.gasUsed}, vault ${r2.gasUsed}, zap ${r3.gasUsed}`);
assert.equal((await call(vault, V, "keeper"))[0], keeper);
assert.equal((await call(vault, V, "owner"))[0], DEPLOYER);
assert.equal(Number((await call(vault, V, "mgmtFeeBps"))[0]), 100);
assert.equal((await call(vault, V, "mgmtFeeRecipient"))[0], L.CREATOR);
assert.equal((await call(vault, V, "feeRecipient"))[0], L.FEE_ROUTER);
assert.equal((await call(vault, V, "assets"))[0].length, 5);
assert.equal(Number((await call(vault, V, "venueCount"))[0]), 4);
await send(DEPLOYER, { to: vault, data: L.transferData() });
assert.equal((await call(vault, V, "pendingOwner"))[0], L.SAFE);
await anvil("anvil_impersonateAccount", [L.SAFE]);
await anvil("anvil_setBalance", [L.SAFE, "0x16345785D8A0000"]);
await send(L.SAFE, { to: vault, data: L.acceptData() });
assert.equal((await call(vault, V, "owner"))[0], L.SAFE);
ok(`deployed with the page's calldata (vault ${vault}), owner handed to the Safe and accepted`);
const cmds = L.verifyCommands({ swapper, vault, zap, owner: DEPLOYER, keeper });
assert.equal(cmds.length, 3);
assert.ok(cmds[1].includes(vault) && cmds[1].includes("src/TroyaIndex.sol:TroyaIndex"));
ok("verify commands built for all three contracts");

process.env.INDEX_ADDRESS = vault; process.env.INDEX_ZAP_ADDRESS = zap; process.env.INDEX_DEPLOY_BLOCK = String(r1.blockNumber);
process.env.INDEX_KEEPER = "1";

/* ---------- 2 deposits ---------- */
await send(ALICE, { to: vault, data: V.encodeFunctionData("depositEth", [0n, ALICE]), value: parseEther("0.4") });
await send(BOB, { to: vault, data: V.encodeFunctionData("depositEth", [0n, BOB]), value: parseEther("0.3") });
const v0 = await route("/api/index")({});
assert.equal(v0.deployed, true);
assert.equal(v0.ethOnly, true);
assert.ok(Math.abs(v0.nav.totalEth - 0.6965) < 1e-9, `nav ${v0.nav.totalEth}`);
assert.equal(v0.keeper.matches, true);
ok("deposits in the ETH-only phase; /api/index reads them");

/* ---------- 3 the keeper ---------- */
// warm the fork: anvil fetches each pool's state from the network on first touch, which can outlast a Gate read
{
  const Q = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
  for (const [tok, fee] of [[L.TOKENS.USDG, 100], [L.TOKENS.SPY, 500], [L.TOKENS.NVDA, 500]])
    await provider.call({ to: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", data: Q.encodeFunctionData("quoteExactInputSingle", [[L.WETH, tok, parseEther("0.1"), fee, 0n]]) }).catch(() => {});
}
const empty = await K.keeperTick();
assert.match(empty.skipped || "", /needs at least 0\.0003 ETH/, "an unfunded keeper does nothing");
await anvil("anvil_setBalance", [keeper, "0x" + parseEther("0.05").toString(16)]);
let t = await K.keeperTick();
assert.ok(t.poked, "pokeAll sent");
assert.match(t.rebalance?.reason || "", /hourly reads|No price/, JSON.stringify(t.rebalance));
let pokes = 1;
for (let i = 0; i < 14 && t.rebalance?.action !== "trade"; i++) {
  await hours(1); t = await K.keeperTick();
  assert.ok(t.poked, `poke ${i}: ${JSON.stringify(t)}`); pokes++;
  if (t.rebalance?.action !== "trade") assert.match(t.rebalance?.reason || "", /hourly reads/, JSON.stringify(t.rebalance));
}
assert.equal(t.rebalance?.action, "trade", JSON.stringify(t));
assert.equal(pokes, 12, "the first trade comes with the 12th hourly read");
assert.ok(t.rebalance.tx, JSON.stringify(t));
const first = t.rebalance;
console.log("  rebalance 1:", first.reason);
const held = (a) => call(vault, V, "holdings", [a]).then((x) => x[0]);
assert.ok((await held(L.TOKENS.USDG)) > 0n, "USDG bought (the most underweight first)");
const ethAfter = await held("0x0000000000000000000000000000000000000000");
assert.ok(ethAfter >= (parseEther("0.6965") * 8000n) / 10000n, "never more than 20% of the ETH in one move");
ok("keeper: hourly pokes, then one rebalance through the Gate after 12 reads, inside the move cap");
t = await K.keeperTick();
assert.match(t.rebalance?.reason || "", /Cooldown/, "the cooldown is respected");
// legs 2 to 4: the first leg ran the real Troya Gate on the fork; the next legs take a stand-in Gate, because the real one's
// sell test and transfer-tax probe pull a lot of fresh state that a fork on a free archive endpoint serves too slowly. The
// stand-in first says no (the keeper must trade nothing), then yes.
const gateCalls = [];
let gateSays = false;
const gate = async (q) => { gateCalls.push(q); return gateSays ? { pass: true, checks: [] } : { pass: false, checks: [{ status: "fail", label: "Stand-in Gate", detail: "says no" }] }; };
for (let i = 0; i < 6; i++) { await hours(1); t = await K.keeperTick({ gate }); if (t.rebalance?.action === "blocked") break; }
assert.equal(t.rebalance?.action, "blocked", JSON.stringify(t.rebalance));
assert.match(t.rebalance.reason, /Troya Gate stopped the buy: Stand-in Gate: says no/);
assert.equal(t.rebalance.tx, undefined, "nothing traded when the Gate fails");
assert.equal(gateCalls[0].tokenIn, "ETH");
ok("a failing Gate stops the buy: no rebalance is sent");
gateSays = true;
let trades = [first], gateRetries = 0;
for (let k = 0; k < 3; k++) {
  // the cooldown, then a trade; a Gate read that times out on the fork (anvil fetching a pool's state from the network for
  // the first time) blocks that pass, as it must, and the next hourly pass tries again
  for (let i = 0; i < 10; i++) {
    if (k > 0 || i > 0) await hours(1);
    t = await K.keeperTick({ gate });
    if (t.rebalance?.action === "trade") break;
    if (t.rebalance?.action === "blocked") { assert.match(t.rebalance.reason, /Troya Gate stopped the buy: Route: Could not reach/, t.rebalance.reason); gateRetries++; }
    else assert.match(t.rebalance?.reason || "", /Cooldown/, JSON.stringify(t.rebalance));
  }
  assert.equal(t.rebalance?.action, "trade", JSON.stringify(t.rebalance));
  trades.push(t.rebalance);
  console.log(`  rebalance ${k + 2}:`, t.rebalance.reason);
}
if (gateRetries) console.log(`  (${gateRetries} pass(es) held back by a Gate read timing out on the fork, then retried)`);
for (const s of ["SPY", "NVDA"]) assert.ok((await held(L.TOKENS[s])) > 0n || trades.some((x) => x.assetOut === L.TOKENS[s]), `${s} bought`);
assert.ok(gateCalls.length >= 3, "every buy asked the Gate");
ok("keeper: a trade every 4 hours, each into the most underweight asset, the Gate asked before every buy");

/* ---------- 4 the public views ---------- */
await K.scanEvents({ post: async () => true });
const v1 = await route("/api/index")({});
assert.equal(v1.ethOnly, false);
assert.equal(v1.holdings.length, 5);
assert.ok(v1.holdings.find((x) => x.symbol === "USDG").amount > 0);
assert.ok(v1.nav.perTidxEth > 0.9 && v1.nav.perTidxEth < 1.01, `NAV per TIDX ${v1.nav.perTidxEth} ETH`);
assert.ok(v1.lastRebalance?.tx, "last rebalance tx from the events");
assert.equal(v1.fee.mgmtPctPerYear, 1);
assert.equal(v1.ownerIsSafe, true);
const me = await route("/api/index/me/:wallet")({ params: { wallet: ALICE } });
assert.ok(me.shares > 0.39 && me.redeemNow.length === 5 && me.redeemNow.find((x) => x.symbol === "USDG").amount > 0);
ok(`/api/index: holdings, NAV ${v1.nav.perTidxEth.toFixed(5)} ETH per TIDX, fees, owner, last rebalance; /api/index/me: what a redeem pays`);

/* ---------- 5 alerts on a proposal and a pause ---------- */
const posted = [];
const { AbiCoder } = await import("ethers");
const prop = V.encodeFunctionData("propose", [2, AbiCoder.defaultAbiCoder().encode(["address", "uint16"], [L.FEE_ROUTER, 200])]);
await send(L.SAFE, { to: vault, data: prop });
await send(L.SAFE, { to: vault, data: V.encodeFunctionData("setPaused", [true, false]) });
const sc = await K.scanEvents({ post: async (txt) => { posted.push(txt); return true; } });
assert.equal(sc.alerted, 2, JSON.stringify(sc));
assert.match(posted[0], /proposed on chain/); assert.match(posted[0], /Deposit fee 2%/); assert.match(posted[0], /redeem in kind at any time/);
assert.match(posted[1], /New deposits are paused/); assert.match(posted[1], /Withdrawals are never paused/);
const v2 = await route("/api/index")({});
assert.equal(v2.pending.length, 1); assert.match(v2.pending[0].text, /Deposit fee 2%/);
ok("ChangeProposed and Paused → public alert texts; the timelock queue shows the proposal");
await send(L.SAFE, { to: vault, data: V.encodeFunctionData("setPaused", [false, false]) });

/* ---------- 6 a zap deposit as the page quotes it ---------- */
await new Promise((r) => setTimeout(r, 21_000));   // past the view's 20 s cache
const v3 = await route("/api/index")({});
const budget = parseEther("0.1");
const shares = parseEther(((0.1 * 0.97) / v3.nav.perTidxEth).toFixed(18));
const [quoted] = Z.decodeFunctionResult("zap", await provider.call({ from: CAROL, to: zap, data: Z.encodeFunctionData("zap", [shares, CAROL, v3.zapVenues]), value: budget }));
const c0 = await provider.getBalance(CAROL);
const rz = await send(CAROL, { to: zap, data: Z.encodeFunctionData("zap", [shares, CAROL, v3.zapVenues]), value: budget });
// what left Carol's wallet, gas included (gas on the fork costs well under 0.001 ETH)
const paid = c0 - (await provider.getBalance(CAROL));
assert.equal((await call(vault, V, "balanceOf", [CAROL]))[0], shares);
assert.equal(await provider.getBalance(zap), 0n, "the zap keeps nothing");
assert.ok(paid >= (quoted * 99n) / 100n && paid <= budget + parseEther("0.001"), `paid ${formatEther(paid)} (gas included) for a quote of ${formatEther(quoted)}`);
ok(`zap: ${formatEther(shares).slice(0, 8)} TIDX for ${formatEther(paid).slice(0, 8)} ETH (quoted ${formatEther(quoted).slice(0, 8)}), the rest refunded`);

/* ---------- 7 everybody redeems in kind ---------- */
for (const who of [ALICE, BOB, CAROL]) {
  const [bal] = await call(vault, V, "balanceOf", [who]);
  const [exp] = await call(vault, V, "previewRedeem", [bal]);
  await send(who, { to: vault, data: V.encodeFunctionData("redeem", [bal, who]) });
  for (const [i, s] of ["USDG", "SPY", "NVDA", "TROYA"].entries()) {
    const got = (await call(L.TOKENS[s], ERC, "balanceOf", [who]))[0];
    assert.ok(got >= exp[i + 1] * 99n / 100n, `${s} for ${who}`);
  }
  assert.equal((await call(vault, V, "owed", [who, L.TOKENS.USDG]))[0], 0n);
}
ok("all three holders redeemed in kind: ETH, USDG, SPY, NVDA and $TROYA each");
const fees = (await call(vault, V, "balanceOf", [L.CREATOR]))[0];
assert.ok(fees > 0n, "the management fee was minted in TIDX to the creator wallet");
ok(`management fee over the run: ${formatEther(fees)} TIDX to the creator wallet`);
const log = (await store.readJson("index-keeper.json", {})).log || [];
assert.ok(log.filter((x) => x.kind === "rebalance").length >= 4 && log.some((x) => x.kind === "poke"));
console.log(`\n${n} passed (data dir ${DATA})`);
process.exit(0);
