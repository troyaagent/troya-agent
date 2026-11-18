// V6 launch end to end on a local Robinhood Chain fork (anvil): the fee splitter factory, Launch on X from an Agent Wallet,
// a non-holder launch through a splitter, trading, collecting the split, Launch in Telegram (F27), a web launch recorded,
// and the refusals.
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
process.env.SITE_URL = "https://troya.codes";   // uploaded logos get a public https link, as on the server

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
for (const m of ["robinhood", "policy", "journal", "agentwallet", "holders", "launch"]) { const mod = await import(ROOT + `server/${m}.mjs`); if (mod.register) await mod.register(router, ctx); }
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
const H = Wallet.createRandom().address, N = Wallet.createRandom().address, M = Wallet.createRandom().address;
const awH = Wallet.createRandom(), awN = Wallet.createRandom(), awM = Wallet.createRandom();
await store.writeJson("agentwallets.json", {
  [H.toLowerCase()]: { address: awH.address, enc: encrypt(awH.privateKey, H), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } },
  [N.toLowerCase()]: { address: awN.address, enc: encrypt(awN.privateKey, N), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } },
  [M.toLowerCase()]: { address: awM.address, enc: encrypt(awM.privateKey, M), createdAt: Date.now(), enabled: true, caps: { perTradeUsd: 100, dailyUsd: 250 } },
});
await fund(awH.address, 0.05); await fund(awN.address, 0.05); await fund(awM.address, 0.05);
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
await anvil("anvil_impersonateAccount", [PM]); await fund(PM, 1);
const erc = new Interface(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const pmSigner = await provider.getSigner(PM);
await (await pmSigner.sendTransaction({ to: TROYA, data: erc.encodeFunctionData("transfer", [H, parseEther("1500000")]) })).wait();
await anvil("anvil_stopImpersonatingAccount", [PM]);
ok("holder H has 1.5M $TROYA on the fork, N has none; both Agent Wallets hold 0.05 ETH");

/* ---------- Launch on X ---------- */
await store.writeJson("x-links.json", { [H.toLowerCase()]: { id: "111", username: "holder" }, [N.toLowerCase()]: { id: "222", username: "nonholder" }, [M.toLowerCase()]: { id: "333", username: "everyone" } });
await store.writeJson("launch-prefs.json", { [H.toLowerCase()]: { x: true }, [N.toLowerCase()]: { x: true } });
L._setLogoFetcher(async () => "https://troya.codes/img/logo-3d-hd.png");
const IMG = "https://pbs.twimg.com/media/test.jpg";

let r = await L.fromX({ tweetId: "1", authorId: "111", text: "@Troyaagent launch Fork Horse $FHORSE tax 1%", mediaUrl: IMG });
assert.match(r.reply, /isn't open yet/i); fixOk(r.reply);
ok("while Launch on X is off, the post gets a not-open-yet reply and nothing launches");
await store.writeJson("x-state.json", { launch: "live" });

r = await L.fromX({ tweetId: "2", authorId: "999", text: "@Troyaagent launch Fork Horse $FHORSE", mediaUrl: IMG });
assert.match(r.reply, /isn't linked to a Troya wallet/i); fixOk(r.reply); ok("an unlinked X account is told to link first");
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

/* ---------- Launch on X is open to everyone (owner, 18 Nov): a non-holder once a day, through a splitter; holders without a limit ---------- */
await store.writeJson("x-state.json", { launch: "live" });
await store.update("launch-prefs.json", {}, (m) => ({ ...m, [M.toLowerCase()]: { x: true } }));
r = await L.fromX({ tweetId: "20", authorId: "333", text: "@Troyaagent launch Open Horse $OPENH", mediaUrl: IMG });
assert.ok(r.launch?.token, r.reply);
assert.equal(r.launch.split, true, "a non-holder's creator fee goes through a splitter");
assert.match(r.reply, /Creator fee: you keep 0\.6% of volume, Troya 0\.1%/);
assert.ok(xLen(r.reply) <= 280, `reply fits a post (${xLen(r.reply)})`);
li = await info(r.launch.token);
assert.equal(getAddress(li.creatorFeeRecipient), getAddress(r.launch.recipient)); assert.equal(getAddress(li.deployer), awM.address);
console.log("   reply:", r.reply);
ok(`a non-holder launches from X: $OPENH ${r.launch.token}, creator fee through a splitter (0.6% / 0.1%)`);
r = await L.fromX({ tweetId: "21", authorId: "333", text: "@Troyaagent launch Second Horse $SECH", mediaUrl: IMG });
assert.match(r.reply, /one launch from X a day/); fixOk(r.reply); assert.ok(!r.launch);
await assert.rejects(L.plan({ owner: M, source: "x" }), /launch from X a day/);
const pm = await L.plan({ owner: M, source: "web" });
assert.equal(pm.limit.max, 3);
ok("the same non-holder's second launch from X that day is refused (troya.codes and Telegram still open, 3 a day in all)");
await store.update("launches.json", [], (l) => [...l, ...Array.from({ length: 8 }, (_, i) => ({ token: "0x" + "ab".repeat(19) + String(10 + i), owner: H, at: Date.now(), source: "x" }))]);
const ph = await L.plan({ owner: H, source: "x" });
assert.equal(ph.limit.max, null); assert.ok(ph.limit.used >= 11, String(ph.limit.used));
ok(`a holder has no daily limit: ${ph.limit.used} launches today and still allowed, from X too`);

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
// F28 Creator desk: what it says is waiting, and its own transaction collects it
const pre = await L.creatorFees(N);
const pc = pre.coins.find((c) => c.token.toLowerCase() === out.launch.token.toLowerCase());
assert.equal(pc.txs.length, 1, JSON.stringify(pc.txs)); assert.equal(getAddress(pc.txs[0].to), FACTORY);
await (await collector.sendTransaction({ to: pc.txs[0].to, data: pc.txs[0].data, nonce: 0 })).wait();
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
const near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.001 + 1e-12;
assert.ok(near(Number(toN) / 1e18, pc.yoursEth), `split: creator got ${Number(toN) / 1e18}, the desk said ${pc.yoursEth}`);
assert.ok((await L.creatorFees(N)).coins.find((c) => c.token === pc.token).yoursEth < 1e-12, "nothing left to claim");
ok(`F28 Creator desk, split coin: it said ${pc.yoursEth.toFixed(8)} ETH was waiting for the creator; its one transaction (deployAndCollect) paid exactly that`);

/* ---------- F28 · a holder's coins: sweep the curve, then one escrow claim to the holder's own wallet ---------- */
{
  const hf = await L.creatorFees(H);
  const bh = hf.coins.find((c) => c.symbol === "BUYH");
  assert.ok(bh && bh.onCurveEth > 0 && !bh.split, JSON.stringify(bh));
  assert.ok(hf.escrow.txs.length >= 2 && /Claim everything/.test(hf.escrow.txs[hf.escrow.txs.length - 1].label), JSON.stringify(hf.escrow.txs));
  await anvil("anvil_impersonateAccount", [H]); await fund(H, 1);
  const hs = await provider.getSigner(H);
  const rawBal = async (a) => BigInt(await provider.send("eth_getBalance", [a, "latest"]));   // raw: ethers briefly caches identical reads
  const h0 = await rawBal(H);
  let gas = 0n;
  for (const t of hf.escrow.txs) { const rc = await (await hs.sendTransaction({ to: t.to, data: t.data })).wait(); assert.equal(rc.status, 1, t.label); gas += rc.gasUsed * (rc.gasPrice || 0n); }
  await anvil("anvil_stopImpersonatingAccount", [H]);
  const got = Number((await rawBal(H)) - h0 + gas) / 1e18;
  assert.ok(near(got, hf.yoursEth), `holder got ${got}, the desk said ${hf.yoursEth}`);
  assert.ok((await L.creatorFees(H)).yoursEth < 1e-12, "nothing left for the holder");
  ok(`F28 Creator desk, holder coins: ${hf.escrow.txs.length} transactions (sweep the curve, claim the escrow) paid H ${got.toFixed(8)} ETH, as the desk said`);
}

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

/* ---------- F27 · Launch in Telegram: the bot's wizard, a photo, the preview and Confirm (non-holder N) ---------- */
{
  const T = await import(ROOT + "server/tglaunch.mjs");
  const sent = [];
  let mid = 100;
  const tg = async (method, body) => { sent.push({ method, body }); return method === "getFile" ? { ok: true, result: { file_path: "photos/file_1.png" } } : { ok: true, result: { message_id: ++mid } }; };
  const PNG = await readFile(ROOT + "public/img/logos/gmgn.png");
  T._setImageFetcher(async () => ({ buf: PNG, type: "image/png" }));
  const CHAT = 5001;
  await store.writeJson("telegram.json", { links: { [N.toLowerCase()]: CHAT }, codes: {} });
  const msg = (text, extra = {}) => ({ message_id: ++mid, chat: { id: extra.chat ?? CHAT, type: extra.type || "private" }, from: { id: extra.chat ?? CHAT }, text, ...extra.m });
  const last = () => sent[sent.length - 1].body;
  const btn = (re) => { for (let i = sent.length - 1; i >= 0; i--) { const k = sent[i].body?.reply_markup?.inline_keyboard?.flat().find((x) => x.callback_data && re.test(x.text)); if (k) return { data: k.callback_data, mid: 900 + i }; } throw new Error(`no button ${re}`); };
  const press = (b, from = CHAT) => T.handleCallback({ id: "cq" + (++mid), data: b.data, from: { id: from }, message: { chat: { id: from }, message_id: b.mid } }, tg);

  await T.handleMessage(msg("/launch"), tg, store);
  assert.match(last().text, /isn't open yet/); ok("Telegram: while Launch in Telegram is off, /launch says it is not open yet");
  await store.writeJson("tg-launch.json", { mode: "live" });
  await T.handleMessage(msg("/launch", { chat: -100123, type: "supergroup" }), tg, store);
  assert.match(last().text, /private chat/); assert.match(last().reply_markup.inline_keyboard[0][0].url, /\?start=launch$/);
  ok("Telegram: /launch in the group points to a private chat with the bot");
  await T.handleMessage(msg("/launch", { chat: 5002 }), tg, store);
  assert.match(last().text, /Link this chat to your wallet first/); ok("Telegram: an unlinked chat is told to link its wallet first");
  assert.equal(await T.handleMessage(msg("hello"), tg, store), false, "plain chat outside a launch goes on to the assistant");

  await T.handleMessage(msg("/start launch"), tg, store);
  assert.match(last().text, /What's its name/);
  await T.handleMessage(msg("Telegram Horse"), tg, store);
  assert.match(last().text, /Now the ticker/);
  await T.handleMessage(msg("ETH"), tg, store);
  assert.match(last().text, /taken by an existing coin/); ok("Telegram wizard: $ETH is refused, the step stays open");
  await T.handleMessage(msg("$TGH"), tg, store);
  assert.match(last().text, /send the coin's image/);
  await T.handleMessage({ ...msg(""), photo: [{ file_id: "small", width: 90 }, { file_id: "big", width: 800 }] }, tg, store);
  assert.match(last().text, /Image saved/);
  await press(btn(/^1%$/));
  await press(btn(/^0\.005 ETH$/));
  const pv = last().text;
  assert.match(pv, /Launch preview/); assert.match(pv, /\$TGH/); assert.match(pv, /Creator tax: 1%/); assert.match(pv, /0\.005 ETH/); assert.match(pv, /Troya takes 0\.1%/); assert.match(pv, /which holds 0\.0/);
  ok("Telegram wizard: name, ticker, photo, tax and buy buttons lead to a preview that names the 0.1% split and the wallet balance");
  const conf = btn(/Confirm launch/);
  assert.equal(await press(conf, 7777), true); assert.equal(await T.handleMessage(msg("x", { chat: 7777 }), tg, store), false);
  ok("Telegram: someone else's chat cannot press the Confirm button");
  await press(conf);
  let done = null;
  for (let i = 0; i < 120 && !done; i++) { await new Promise((res) => setTimeout(res, 1000)); done = sent.slice().reverse().find((c) => c.method === "editMessageText" && /is live|Not launched/.test(c.body.text)); }
  assert.ok(done, "the launch finished");
  console.log("   telegram:", done.body.text.replace(/\n+/g, " / "));
  assert.match(done.body.text, /\$TGH is live/); assert.match(done.body.text, /Initial buy of 0\.005 ETH done/);
  assert.match(done.body.reply_markup.inline_keyboard[0][0].url, /\/agent#\/token\/0x[0-9a-f]{40}$/);
  const tgl = (await store.readJson("launches.json", [])).find((x) => x.symbol === "TGH");
  assert.equal(tgl.source, "tg"); assert.equal(tgl.split, true); assert.ok(/\/api\/launch\/logo\/[0-9a-f]{32}\.png$/.test(tgl.logo), tgl.logo);
  const tli = await info(tgl.token);
  assert.equal(getAddress(tli.creatorFeeRecipient), getAddress(tgl.recipient)); assert.equal(getAddress(tli.deployer), awN.address); assert.equal(Number(tli.creatorTaxBps), 100);
  ok(`Telegram launch: $TGH ${tgl.token} by N's Agent Wallet, tax 1%, creator fee through a splitter, image saved, buy done, Trade on Troya button`);
  await press(conf);
  assert.match(sent[sent.length - 1].body.text, /expired|dropped/); ok("Telegram: a used Confirm button does nothing the second time");

  // the quick way: one photo with the whole launch in its caption, straight to the preview
  await T.handleMessage({ ...msg(""), caption: "/launch Quick Horse $QUICK tax 2%", photo: [{ file_id: "q", width: 640 }] }, tg, store);
  assert.match(last().text, /Launch preview/); assert.match(last().text, /Quick Horse/); assert.match(last().text, /Image: attached/); assert.match(last().text, /Creator tax: 2%/);
  await press(btn(/^Cancel$/));
  assert.match(sent[sent.length - 1].body.text, /dropped/);
  ok("Telegram quick way: a photo captioned \"/launch Quick Horse $QUICK tax 2%\" goes straight to the preview; Cancel drops it");
  await T.handleMessage(msg("/launch"), tg, store);
  assert.equal(await T.handleMessage(msg("/positions"), tg, store), false, "another command leaves the launch");
  assert.equal(await T.handleMessage(msg("Some Name"), tg, store), false, "and the launch is gone");
  ok("Telegram: any other command mid-launch drops the launch and goes on to trading or the assistant");
}

/* ---------- the daily limit ---------- */
const today = Date.now();
await store.update("launches.json", [], (l) => [...l, ...[1, 2, 3].map((i) => ({ token: "0x" + String(i).repeat(40), owner: N, at: today, source: "tg" }))]);
await assert.rejects(L.plan({ owner: N, creatorTaxBps: 0 }), /most for one wallet/);
ok("a non-holder past 3 launches a day is refused");

console.log(`\n${n}/${n} passed · data ${DATA}`);
process.exit(0);
