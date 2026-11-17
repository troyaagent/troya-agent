// V6 launch end to end on a local Robinhood Chain fork (anvil): the fee splitter factory, Launch on X from an Agent Wallet,
// a non-holder launch through a splitter, trading, collecting the split, a web launch recorded, and the refusals.
// Nothing touches mainnet: every RPC points at the fork.
//   anvil --fork-url https://robinhood.drpc.org --port 8547 --chain-id 4663 --no-storage-caching
//   node tools/launch-fork-test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";

const FORK = process.env.FORK_RPC || "http://127.0.0.1:8547";
process.env.ROBINHOOD_RPCS = FORK;
process.env.ROBINHOOD_RPC = FORK;
process.env.RPC_TIMEOUT_MS = "60000";   // a fork pulls fresh state from the network for every new address
delete process.env.TROYA_NO_BROADCAST;
const DATA = await mkdtemp(join(tmpdir(), "troya-launch-fork-"));
process.env.DATA_DIR = DATA;

const { JsonRpcProvider, Wallet, ContractFactory, Contract, Interface, parseEther, getAddress, AbiCoder } = await import("ethers");
const provider = new JsonRpcProvider(FORK, 4663, { staticNetwork: true });
assert.equal(Number((await provider.getNetwork()).chainId), 4663, "the fork must be Robinhood Chain");
const anvil = (m, p) => provider.send(m, p);
const fund = (a, eth) => anvil("anvil_setBalance", [a, "0x" + parseEther(String(eth)).toString(16)]);

const ROOT = new URL("..", import.meta.url).pathname;
const { initStore } = await import(ROOT + "server/store.mjs");
const store = await initStore(DATA);
const router = { get() {}, post() {}, put() {}, delete() {} };
const ctx = { store, dataDir: DATA };
for (const m of ["policy", "journal", "agentwallet", "holders", "launch"]) { const mod = await import(ROOT + `server/${m}.mjs`); if (mod.register) await mod.register(router, ctx); }
const L = await import(ROOT + "server/launch.mjs");
const { ADDR } = await import(ROOT + "server/robinhood.mjs");

let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };
// every failed launch says why and what to do, and keeps to one cashtag (X refuses posts with more)
const fixOk = (reply) => { assert.match(reply, /^Not launched: .+To fix: /); assert.ok((reply.match(/\$[A-Za-z][A-Za-z0-9]*/g) || []).length <= 1, reply); };

/* ---------- the factory, deployed on the fork from the tested build ---------- */
const deployer = Wallet.createRandom().connect(provider);
const treasury = Wallet.createRandom().address;
await fund(deployer.address, 1);
const build = JSON.parse(await readFile(ROOT + "public/agent/desk/troya-fee-splitter.json", "utf8"));
const factory = await new ContractFactory(build.abi, build.bytecode, deployer).deploy(L.PONS_ESCROW, treasury, deployer.address);
await factory.waitForDeployment();
const FACTORY = await factory.getAddress();
await store.writeJson("fee-splitter.json", { factory: FACTORY, treasury });
assert.equal(await L.splitterFactory(), FACTORY);
ok(`factory deployed on the fork at ${FACTORY}`);

/* ---------- two owners with Agent Wallets: H holds 1.5M $TROYA, N holds none ---------- */
const master = Buffer.from((await readFile(join(DATA, "master.key"), "utf8")).trim(), "hex");
function encrypt(pk, owner) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", master, iv);
  c.setAAD(Buffer.from(owner.toLowerCase()));
  const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}
const H = Wallet.createRandom().address, N = Wallet.createRandom().address;
const awH = Wallet.createRandom(), awN = Wallet.createRandom();
await store.writeJson("agentwallets.json", {
  [H.toLowerCase()]: { address: awH.address, enc: encrypt(awH.privateKey, H), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } },
  [N.toLowerCase()]: { address: awN.address, enc: encrypt(awN.privateKey, N), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } },
});
await fund(awH.address, 0.05); await fund(awN.address, 0.05);
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
await anvil("anvil_impersonateAccount", [PM]); await fund(PM, 1);
const erc = new Interface(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const pmSigner = await provider.getSigner(PM);
await (await pmSigner.sendTransaction({ to: TROYA, data: erc.encodeFunctionData("transfer", [H, parseEther("1500000")]) })).wait();
await anvil("anvil_stopImpersonatingAccount", [PM]);
ok("holder H has 1.5M $TROYA on the fork, N has none; both Agent Wallets hold 0.05 ETH");

/* ---------- Launch on X ---------- */
await store.writeJson("x-links.json", { [H.toLowerCase()]: { id: "111", username: "holder" }, [N.toLowerCase()]: { id: "222", username: "nonholder" } });
await store.writeJson("launch-prefs.json", { [H.toLowerCase()]: { x: true }, [N.toLowerCase()]: { x: true } });
L._setLogoFetcher(async () => "https://troya.codes/img/logo-3d-hd.png");
const IMG = "https://pbs.twimg.com/media/test.jpg";

let r = await L.fromX({ tweetId: "1", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE tax 1%", mediaUrl: IMG });
assert.match(r.reply, /isn't open yet/i); fixOk(r.reply);
ok("while Launch on X is off, the post gets a not-open-yet reply and nothing launches");
await store.writeJson("x-state.json", { launch: "live" });

r = await L.fromX({ tweetId: "2", authorId: "999", text: "@Troyaagent launch Fork Horse $FHORSE", mediaUrl: IMG });
assert.match(r.reply, /isn't linked to a Troya wallet/i); fixOk(r.reply); ok("an unlinked X account is told to link first");
r = await L.fromX({ tweetId: "3", authorId: "222", text: "@Troyaagent launch Fork Horse $FHORSE", mediaUrl: IMG });
assert.match(r.reply, /needs 1,000,000/i); assert.match(r.reply, /you hold 0/); fixOk(r.reply); ok("a non-holder cannot launch from X");
r = await L.fromX({ tweetId: "4", authorId: "111", text: "@Troyaagent launch Fake Ether $ETH", mediaUrl: IMG });
assert.match(r.reply, /taken by an existing coin/i); fixOk(r.reply); ok("$ETH is refused");
r = await L.fromX({ tweetId: "6", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE tax 9%", mediaUrl: IMG });
assert.match(r.reply, /4% at most/i); fixOk(r.reply); ok("a 9% creator tax is refused");
await store.writeJson("launch-prefs.json", { [H.toLowerCase()]: { x: false } });
r = await L.fromX({ tweetId: "7", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE", mediaUrl: IMG });
assert.match(r.reply, /switched off/i); fixOk(r.reply); ok("with Launch from X switched off, nothing launches");
await store.writeJson("launch-prefs.json", { [H.toLowerCase()]: { x: true } });
// "test" mode: only admin wallets launch from X (the real-money test)
await store.writeJson("x-state.json", { launch: "test" });
process.env.X_ADMINS = "";
r = await L.fromX({ tweetId: "7b", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE", mediaUrl: IMG });
assert.match(r.reply, /isn't open yet/i); fixOk(r.reply); ok("test mode: a holder who is not an admin gets the not-open-yet reply");
process.env.X_ADMINS = H.toLowerCase();

// warm the fork up: the first Pons simulation pulls a lot of state from the network (the server's RPC timeout is 9 s)
{
  const { buildLaunchTx: warm } = await import(ROOT + "server/robinhood.mjs");
  for (let i = 0; i < 8; i++) {
    const w = await warm({ creator: awH.address, name: "Warm", symbol: "WARM", logo: "", creatorTaxBps: 100, feeRecipient: H }).catch((e) => ({ simulation: { ok: false, error: e.message } }));
    if (w.simulation.ok) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
}
r = await L.fromX({ tweetId: "8", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE tax 1%", mediaUrl: IMG });
assert.ok(r.launch?.token, `launched: ${r.reply}`);
// X counts every link as 23 characters
const xLen = (t) => t.replace(/\b[\w.-]+\.(?:codes|family|com)\/\S*/g, "x".repeat(23)).length;
assert.ok(xLen(r.reply) <= 280, `reply fits a post (${xLen(r.reply)})`);
const pons = new Interface(["function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"]);
const info = async (t) => pons.decodeFunctionResult("getLaunchedToken", await provider.call({ to: ADDR.ponsFactory, data: pons.encodeFunctionData("getLaunchedToken", [t]) }))[0];
let li = await info(r.launch.token);
assert.equal(getAddress(li.creatorFeeRecipient), H, "holder: the creator fee goes to the holder's own wallet");
assert.equal(getAddress(li.deployer), awH.address, "sent by the Agent Wallet");
assert.equal(Number(li.creatorTaxBps), 100);
console.log("   reply:", r.reply);
ok(`test mode, admin holder launch from X: $FHORSE ${r.launch.token}, deployed by the Agent Wallet, creator fee 100% to the holder, tax 1%`);
const again = await L.fromX({ tweetId: "8", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE tax 1%", mediaUrl: IMG });
assert.equal(again.launch?.token, r.launch.token); assert.equal(again.reply, null);
ok("the same post read twice does not launch twice");

// no image attached: the coin launches without one, and the reply says so
r = await L.fromX({ tweetId: "5", authorId: "111", text: "@Troyaagent launch Bare Horse $BARE", mediaUrl: null });
assert.ok(r.launch?.token, r.reply);
assert.match(r.reply, /No image was attached/);
ok(`a post without an image launches a coin with no image ($BARE ${r.launch.token})`);

/* ---------- an initial buy right after launch ---------- */
const tooBig = await L.fromX({ tweetId: "9a", authorId: "111", text: "@Troyaagent launch Big Horse $BIGH buy 5", mediaUrl: IMG });
assert.match(tooBig.reply, /up to 1 ETH/); fixOk(tooBig.reply); ok("an initial buy above 1 ETH is refused before anything launches");
const poor = await L.fromX({ tweetId: "9b", authorId: "111", text: "@Troyaagent launch Poor Horse $POOR buy 0.9", mediaUrl: IMG });
assert.match(poor.reply, /Not launched: the Agent Wallet holds/); fixOk(poor.reply); ok("not enough ETH for fee + buy: nothing launches");
r = await L.fromX({ tweetId: "9", authorId: "111", text: "@Troyaagent launch Buy Horse $BUYH buy 0.01", mediaUrl: IMG });
assert.ok(r.launch?.token, r.reply);
console.log("   reply:", r.reply);
assert.ok(r.launch.initialBuy, "initial buy attempted");
assert.equal(r.launch.initialBuy.executed, true, JSON.stringify(r.launch.initialBuy));
const held = BigInt(erc.decodeFunctionResult("balanceOf", await provider.call({ to: r.launch.token, data: erc.encodeFunctionData("balanceOf", [awH.address]) }))[0]);
assert.ok(held > 0n, "the Agent Wallet holds the new coin");
assert.match(r.reply, /Initial buy of 0.01 ETH done/);
ok(`launch with an initial buy: $BUYH, the Agent Wallet bought ${(Number(held) / 1e18).toLocaleString("en-US")} tokens for 0.01 ETH`);

/* ---------- a non-holder launch (Telegram path) goes through a splitter ---------- */
const out = await L.launchWithAgentWallet({ owner: N, name: "Split Horse", symbol: "SPLIT", logo: "https://troya.codes/img/logo-3d-hd.png", creatorTaxBps: 0, source: "tg", ref: "tg:test" });
assert.ok(out.ok, JSON.stringify(out).slice(0, 300));
li = await info(out.launch.token);
assert.equal(out.launch.split, true);
assert.equal(out.launch.troyaBps, 1428);
assert.equal(getAddress(li.creatorFeeRecipient), getAddress(out.launch.recipient), "Pons stored the splitter");
assert.equal(getAddress(await factory.predict(N, 1428, out.launch.salt)), getAddress(li.creatorFeeRecipient));
assert.equal((await provider.getCode(out.launch.recipient)), "0x", "no splitter code until there is something to collect");
ok(`non-holder launch: $SPLIT ${out.launch.token}, creator fee to splitter ${out.launch.recipient} (not deployed yet)`);

// trade it, then collect from any wallet
await anvil("evm_increaseTime", [900]); await anvil("anvil_mine", ["0x2710"]);   // past the launch snipe tax (it decays per block)
const trader = Wallet.createRandom().connect(provider);
await fund(trader.address, 5);
const curveI = new Interface(["function buy(uint256,uint256,address) payable returns (uint256)", "function sell(uint256,uint256,address) returns (uint256)"]);
const curve = getAddress(li.curve);
await (await trader.sendTransaction({ to: curve, data: curveI.encodeFunctionData("buy", [parseEther("2"), 0, trader.address]), value: parseEther("2"), nonce: 0 })).wait();
const got = BigInt(erc.decodeFunctionResult("balanceOf", await provider.call({ to: out.launch.token, data: erc.encodeFunctionData("balanceOf", [trader.address]) }))[0]);
await (await trader.sendTransaction({ to: out.launch.token, data: erc.encodeFunctionData("approve", [curve, got]), nonce: 1 })).wait();
const before = await provider.getBalance(trader.address);
const sellRc = await (await trader.sendTransaction({ to: curve, data: curveI.encodeFunctionData("sell", [got, 0, trader.address]), nonce: 2 })).wait();
const gasSell = sellRc.gasUsed * (sellRc.gasPrice || 0n);
const volume = parseEther("2") + (await provider.getBalance(trader.address)) - before + gasSell;
const feeI = new Interface(["function quoteFeeBalance() view returns (uint256)", "function creatorTaxBalance() view returns (uint256)", "function currentSnipeTaxBps(address) view returns (uint256)"]);
const qf = feeI.decodeFunctionResult("quoteFeeBalance", await provider.call({ to: curve, data: feeI.encodeFunctionData("quoteFeeBalance") }))[0];
const ct = feeI.decodeFunctionResult("creatorTaxBalance", await provider.call({ to: curve, data: feeI.encodeFunctionData("creatorTaxBalance") }))[0];
const n0 = await provider.getBalance(N), t0 = await provider.getBalance(treasury);
const collector = Wallet.createRandom().connect(provider);
await fund(collector.address, 1);
await (await factory.connect(collector).deployAndCollect(N, 1428, out.launch.salt, [curve], [out.launch.token], { nonce: 0 })).wait();
const toN = (await provider.getBalance(N)) - n0, toT = (await provider.getBalance(treasury)) - t0;
const income = toN + toT;
assert.ok(toT > 0n && toN > 0n);
assert.equal(toT, (income * 1428n) / 10000n, "exact split");
// the Pons fee is 1% of every trade, so the curve's fee balance names the real volume (buy in + sell out)
const vol = qf * 100n;
const troyaOfVolume = Number((toT * 1_000_000n) / vol) / 10_000;   // percent
const creatorOfVolume = Number((toN * 1_000_000n) / vol) / 10_000;
assert.ok(troyaOfVolume > 0.092 && troyaOfVolume < 0.108, `Troya ${troyaOfVolume}% of volume`);
assert.ok(creatorOfVolume > 0.55 && creatorOfVolume < 0.65, `creator ${creatorOfVolume}% of volume`);
ok(`volume ${(Number(vol) / 1e18).toFixed(3)} ETH → creator ${creatorOfVolume.toFixed(3)}%, Troya ${troyaOfVolume.toFixed(3)}% of volume, collected by a stranger`);

/* ---------- a web launch (the creator's own wallet) recorded after a check on chain ---------- */
const W = Wallet.createRandom().connect(provider);
await fund(W.address, 1);
const p = await L.plan({ owner: W.address, creatorTaxBps: 200, name: "Web Horse", symbol: "WEBH" });
assert.equal(p.split, true); assert.equal(p.troyaBps, 370);
const { buildLaunchTx } = await import(ROOT + "server/robinhood.mjs");
const b = await buildLaunchTx({ creator: W.address, name: "Web Horse", symbol: "WEBH", logo: "https://troya.codes/img/logo-3d-hd.png", creatorTaxBps: 200, feeRecipient: p.recipient });
assert.ok(b.simulation.ok, b.simulation.error);
const tx = await W.sendTransaction({ to: b.to, data: b.data, value: BigInt(b.value), nonce: 0 });
await tx.wait();
const rec = await L.recordWeb({ hash: tx.hash, owner: W.address, salt: p.salt, troyaBps: p.troyaBps });
assert.equal(rec.launch.split, true); assert.equal(String(rec.launch.symbol).toUpperCase(), "WEBH");
ok("web launch with a 2% tax: splitter at 370 bps (0.1% of volume), checked on chain and recorded");
await assert.rejects(L.recordWeb({ hash: tx.hash, owner: W.address, salt: "0x" + "11".repeat(32), troyaBps: 370 }), /neither to its creator nor to a Troya splitter/);
ok("a record with the wrong salt is refused");

/* ---------- the daily limit ---------- */
const today = Date.now();
await store.update("launches.json", [], (l) => [...l, ...[1, 2, 3].map((i) => ({ token: "0x" + String(i).repeat(40), owner: N, at: today, source: "tg" }))]);
await assert.rejects(L.plan({ owner: N, creatorTaxBps: 0 }), /most for one wallet/);
ok("a non-holder's 4th launch of the day is refused (the earlier one plus 3 more)");

console.log(`\n${n}/${n} passed · data ${DATA}`);
process.exit(0);
