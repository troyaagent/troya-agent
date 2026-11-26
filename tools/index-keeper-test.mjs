// Unit tests for server/index-keeper.mjs: the drift math, the move cap and cooldown, the refusals, the keeper key file.
// No chain, no network.   node tools/index-keeper-test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Interface, parseEther, getAddress, Wallet } from "ethers";

process.env.INDEX_OFF = "1";
delete process.env.INDEX_KEEPER;
delete process.env.INDEX_ADDRESS;
const K = await import("../server/index-keeper.mjs");
const { TOKENS, CREATOR, SAFE } = await import("../public/agent/desk/index-deploy-lib.js");
const coder = AbiCoder.defaultAbiCoder();
const ETH = "0x0000000000000000000000000000000000000000";
const Q96 = 1n << 96n;
let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };

/* ---------- prices ---------- */
// a venue with ETH as token0 and USDG (6 decimals) as token1 at 2,000 USDG per ETH: sqrt(2000e6 / 1e18) x 2^96
const sqrtOf = (num, den) => { const x = (BigInt(num) << 192n) / BigInt(den); let r = x, y = (x + 1n) / 2n; while (y < r) { r = y; y = (x / y + y) / 2n; } return r; };
const vUsdg = { asset0: ETH, asset1: TOKENS.USDG };
const sU = sqrtOf(2000_000000n, 10n ** 18n);
// a venue with the token as token0 (SPY, 18 decimals) and ETH as token1 at 0.25 ETH per SPY
const vSpy = { asset0: TOKENS.SPY, asset1: ETH };
const sS = sqrtOf(25n, 100n);
{
  const usdgPerEth = K.valueAt(sU, true, 10n ** 18n);
  assert.ok(usdgPerEth > 1999_990000n && usdgPerEth <= 2000_000000n, `1 ETH = ${usdgPerEth}`);
  const ethFor2000 = K.ethValue(TOKENS.USDG, 2000_000000n, vUsdg, sU);
  assert.ok(ethFor2000 > parseEther("0.99999") && ethFor2000 <= parseEther("1"), "2,000 USDG ~ 1 ETH");
  const ethForSpy = K.ethValue(TOKENS.SPY, parseEther("4"), vSpy, sS);
  assert.ok(ethForSpy > parseEther("0.99999") && ethForSpy <= parseEther("1"), "4 SPY ~ 1 ETH");
  const spyBack = K.tokenForEth(TOKENS.SPY, parseEther("1"), vSpy, sS);
  assert.ok(spyBack > parseEther("3.9999") && spyBack <= parseEther("4"), "1 ETH ~ 4 SPY");
  assert.equal(K.ethValue(ETH, 123n, null, 0n), 123n);
  assert.equal(K.ethValue(TOKENS.SPY, 1n, null, 0n), null, "no venue, no price");
  ok("valueAt / ethValue / tokenForEth match the vault's maths in both pool orientations");
}

/* ---------- the plan ---------- */
const lc = (s) => s.toLowerCase();
const targets = { [ETH]: 50, [lc(TOKENS.USDG)]: 30, [lc(TOKENS.SPY)]: 20 };
const A = (eth, usdg, spy, extra = {}) => [
  { address: ETH, holding: parseEther(String(eth)), buyable: true, venueId: null, venue: null, sqrt: null },
  { address: TOKENS.USDG, holding: BigInt(Math.round(usdg * 2000 * 1e6)), buyable: extra.usdgBuyable ?? true, venueId: 0, venue: vUsdg, sqrt: sU },
  { address: TOKENS.SPY, holding: parseEther(String(spy * 4)), buyable: true, venueId: 1, venue: vSpy, sqrt: extra.spySqrt === undefined ? sS : extra.spySqrt },
];   // amounts given in ETH value: usdg/spy are their ETH worth
const plan = (assets, o = {}) => K.planRebalance({ assets, targets, driftBps: 500, maxMoveBps: 2000, minTradeWei: parseEther("0.005"), ...o });
{
  const p = plan(A(0.5, 0.3, 0.2));
  assert.equal(p.action, "none"); assert.match(p.reason, /within 5 points/);
  const p2 = plan(A(0.53, 0.28, 0.19));
  assert.equal(p2.action, "none", "3 points off: inside the band");
  ok("inside the drift band: no trade");
}
{
  // all ETH (fresh vault): buy the most underweight token (USDG, 30 points under) with ETH, held to the 20% move cap
  const p = plan(A(1, 0, 0));
  assert.equal(p.action, "trade");
  assert.equal(lc(p.assetIn), lc(ETH)); assert.equal(lc(p.assetOut), lc(TOKENS.USDG));
  assert.equal(p.venueId, 0); assert.equal(p.zeroForOne, true, "ETH is token0 of the USDG venue");
  assert.equal(p.capped, true);
  assert.equal(p.amountIn, parseEther("0.2") - 1n, "20% of the ETH, one wei under the cap");
  ok("all ETH: buys the lightest token with ETH, held under the move cap");
}
{
  // ETH 40%, USDG 30%, SPY 30%: SPY 10 points over, ETH 10 under → sell SPY for ETH, 10% of the vault = 0.1 ETH worth
  const p = plan(A(0.4, 0.3, 0.3));
  assert.equal(p.action, "trade");
  assert.equal(lc(p.assetIn), lc(TOKENS.SPY)); assert.equal(lc(p.assetOut), lc(ETH));
  assert.equal(p.zeroForOne, true, "SPY is token0 of its venue");
  // with a 50% cap the full 10 points (0.1 ETH of SPY) fit
  const wide = plan(A(0.4, 0.3, 0.3), { maxMoveBps: 5000 });
  assert.equal(wide.capped, false);
  assert.ok(wide.valueWei > parseEther("0.0999") && wide.valueWei <= parseEther("0.1"), `value ${wide.valueWei}`);
}
ok("a heavy token is sold for ETH (one leg per cooldown, always through ETH)");
{
  // the 20% cap of a 0.3 ETH SPY holding is 0.06 ETH: the 0.1 ETH plan above is clamped
  const p = plan(A(0.4, 0.3, 0.3));
  assert.equal(p.capped, true);
  assert.ok(p.valueWei < parseEther("0.0601"), "held to 20% of the SPY held");
  ok("move cap respected on a token sale");
}
{
  // a retired asset may be sold in full: no cap
  const assets = A(0.4, 0.3, 0.3); assets[2].buyable = false;
  const p = plan(assets);
  assert.equal(p.capped, false);
  ok("retired asset: no move cap (the vault allows a full sale)");
}
{
  // USDG 20 points over, SPY 20 under, ETH on target: sell USDG for ETH first (SPY is bought next cooldown)
  const p = plan(A(0.5, 0.5, 0));
  assert.equal(p.action, "trade"); assert.equal(lc(p.assetIn), lc(TOKENS.USDG)); assert.equal(lc(p.assetOut), lc(ETH));
  assert.equal(p.zeroForOne, false, "USDG is token1 of its venue");
  ok("token over, token under: the heavy one goes to ETH first");
}
{
  const p = plan(A(0.0001, 0.0001, 0.0005), {});
  assert.equal(p.action, "none"); assert.match(p.reason, /minimum/);
  ok("a trade under the minimum size is skipped");
}
{
  const p = plan(A(1, 0, 0.2, { spySqrt: null }));
  assert.equal(p.action, "none"); assert.match(p.reason, /No price for SPY/);
  ok("a held asset without a median: no trade (the vault would refuse anyway)");
}
{
  const p = plan(A(0, 0, 0));
  assert.equal(p.action, "none"); assert.match(p.reason, /holds nothing/);
  const p2 = K.planRebalance({ assets: A(1, 0, 0), targets: {}, driftBps: 500, maxMoveBps: 2000 });
  assert.equal(p2.action, "none"); assert.match(p2.reason, /No target/);
  ok("empty vault / no targets: no trade");
}

/* ---------- guards ---------- */
{
  const me = Wallet.createRandom().address;
  assert.match(K.guard({ now: 100, nextAt: 50, rebalancesPaused: false, onChainKeeper: CREATOR, me }), /not the vault's keeper/);
  assert.match(K.guard({ now: 100, nextAt: 50, rebalancesPaused: true, onChainKeeper: me, me }), /paused/);
  assert.match(K.guard({ now: 100, nextAt: 101, rebalancesPaused: false, onChainKeeper: me, me }), /Cooldown/);
  assert.match(K.guard({ now: 100, nextAt: 50, rebalancesPaused: false, onChainKeeper: me, me, refusedWhy: "Refused: x" }), /Refused/);
  assert.equal(K.guard({ now: 101, nextAt: 101, rebalancesPaused: false, onChainKeeper: me.toLowerCase(), me }), null);
  ok("guards: wrong keeper, paused, cooldown, refused key; clear when all is fine");
}
{
  for (const a of [CREATOR, SAFE, "0x1e1367360a080A94069ac59af3B9FF042Bb058d1", "0x70A02a0A8C820E897a2fCB16bcffe4C69aACA931", "0x937533f8Eb47A10B529A42a7154B73CECa33390B"]) assert.equal(K.isTeamWallet(a.toLowerCase()), true, a);
  const x = Wallet.createRandom().address;
  assert.equal(K.isTeamWallet(x), false);
  assert.equal(K.isTeamWallet(x, [x]), true);
  ok("team wallets recognised (creator, Safe, its signers, gas sponsor, extra list)");
}
{
  const vault = getAddress("0x" + "ab".repeat(20));
  const poke = K.V.encodeFunctionData("pokeAll");
  const reb = K.V.encodeFunctionData("rebalance", [0, true, 1n, 0n]);
  assert.equal(K.allowedTx({ to: vault, data: poke, value: 0 }, vault), true);
  assert.equal(K.allowedTx({ to: vault, data: reb, value: 0 }, vault), true);
  assert.equal(K.allowedTx({ to: vault, data: reb, value: 1 }, vault), false, "no ETH may be sent");
  assert.equal(K.allowedTx({ to: vault, data: K.V.encodeFunctionData("transferOwnership", [CREATOR]) }, vault), false);
  assert.equal(K.allowedTx({ to: vault, data: K.V.encodeFunctionData("redeem", [1n, CREATOR]) }, vault), false, "never redeem");
  assert.equal(K.allowedTx({ to: TOKENS.USDG, data: poke }, vault), false, "only the vault");
  assert.equal(K.allowedTx({ to: vault, data: poke }, null), false);
  ok("the keeper signs only pokeAll() and rebalance() on the vault, with no value");
}

/* ---------- plain words for the timelock queue and alerts ---------- */
{
  const d = (t, v) => coder.encode(t, v);
  assert.match(K.describeChange(0, d(["address"], [CREATOR])), /New keeper/);
  assert.match(K.describeChange(2, d(["address", "uint16"], [CREATOR, 200])), /Deposit fee 2%/);
  assert.match(K.describeChange(3, d(["uint256", "uint256"], [parseEther("5"), parseEther("1")])), /5\.0 TIDX in total, 1\.0 TIDX per wallet/);
  assert.match(K.describeChange(4, d(["uint16", "uint32"], [1000, 21600])), /10% of an asset per move, every 6 hours/);
  assert.match(K.describeChange(5, d(["address"], [TOKENS.SPY])), /Add SPY/);
  assert.match(K.describeChange(7, d(["tuple(uint8,address,address,address,uint24,int24,address,uint16)"], [[1, TOKENS.SPY, ETH, ETH, 0, 0, ETH, 200]])), /Uniswap v3 pool/);
  assert.match(K.describeChange(9, d(["address", "uint16"], [CREATOR, 150])), /Management fee 1\.5% a year/);
  const t = K.alertText({ name: "ChangeProposed", op: 0, data: d(["address"], [CREATOR]), eta: 1800000000, tx: "0x" + "1".repeat(64) }, CREATOR);
  assert.match(t, /proposed on chain/); assert.match(t, /redeem in kind at any time/); assert.match(t, /2027-01-15 08:00 UTC/);
  assert.match(K.alertText({ name: "Paused", deposits: true, rebalances: true, tx: "0x" + "2".repeat(64) }), /Withdrawals are never paused/);
  ok("timelocked changes and alerts in plain words");
}

/* ---------- the keeper key: generated once, mode 0600, only the address leaves ---------- */
{
  const dir = await mkdtemp(join(tmpdir(), "index-keeper-"));
  const { initStore } = await import("../server/store.mjs");
  const store = await initStore(dir);
  const routes = [];
  const r = { get: (p, fn) => routes.push({ p, fn }), post() {}, del() {} };
  await K.register(r, { store, dataDir: dir });
  for (const f of ["index-keeper.key", "index-keeper-wallet.json"]) assert.equal((await stat(join(dir, f))).mode & 0o777, 0o600, `${f} is readable by the service user only`);
  const j = JSON.parse(await readFile(join(dir, "index-keeper-wallet.json"), "utf8"));
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(j.address) && j.ct && !/0x[0-9a-f]{64}/i.test(JSON.stringify(j).replace(j.ct, "")), "only ciphertext and the address on disk");
  const view = await routes.find((x) => x.p === "/api/index").fn({});
  assert.equal(view.deployed, false);
  assert.equal(view.keeper.address, j.address, "the public view shows the keeper's address");
  assert.ok(!JSON.stringify(view).includes(j.ct), "never the key");
  // a second start keeps the same wallet
  const K2 = await import("../server/index-keeper.mjs?again=" + Date.now());
  const routes2 = [];
  await K2.register({ get: (p, fn) => routes2.push({ p, fn }), post() {}, del() {} }, { store, dataDir: dir });
  assert.equal((await routes2.find((x) => x.p === "/api/index").fn({})).keeper.address, j.address);
  // a damaged wallet file is never silently replaced (that would orphan the vault's keeper)
  await writeFile(join(dir, "index-keeper-wallet.json"), "{not json");
  const K3 = await import("../server/index-keeper.mjs?broken=" + Date.now());
  const routes3 = [];
  await K3.register({ get: (p, fn) => routes3.push({ p, fn }), post() {}, del() {} }, { store, dataDir: dir });
  const v3 = await routes3.find((x) => x.p === "/api/index").fn({});
  assert.match(v3.keeper.refused || "", /unavailable/);
  assert.equal(await readFile(join(dir, "index-keeper-wallet.json"), "utf8"), "{not json", "left as it was");
  ok("keeper key: generated on first start, 0600, same wallet on restart, a damaged file is refused, not replaced");

  // a keeper key that is a team wallet refuses to run
  const dir2 = await mkdtemp(join(tmpdir(), "index-keeper-team-"));
  const store2 = await initStore(dir2);
  const K4 = await import("../server/index-keeper.mjs?team=" + Date.now());
  const routes4 = [];
  await K4.register({ get: (p, fn) => routes4.push({ p, fn }), post() {}, del() {} }, { store: store2, dataDir: dir2 });
  const addr = JSON.parse(await readFile(join(dir2, "index-keeper-wallet.json"), "utf8")).address;
  process.env.INDEX_TEAM_WALLETS = addr;            // pretend this key is a team wallet
  process.env.INDEX_ADDRESS = getAddress("0x" + "cd".repeat(20));
  const K5 = await import("../server/index-keeper.mjs?team2=" + Date.now());
  await K5.register({ get() {}, post() {}, del() {} }, { store: store2, dataDir: dir2 });
  const t = await K5.keeperTick({ force: true });
  assert.match(t.skipped || "", /Refused: the keeper key .* is a team wallet/);
  delete process.env.INDEX_TEAM_WALLETS; delete process.env.INDEX_ADDRESS;
  ok("a keeper key that is a team wallet: refused, nothing signed");
}


/* ---------- target weights: published, scheduled 48 hours ahead, validated (Xivor, 26 Nov 2026) ---------- */
{
  const dir = await mkdtemp(join(tmpdir(), "index-weights-"));
  const { initStore } = await import("../server/store.mjs");
  const store = await initStore(dir);
  const W = await import("../server/index-keeper.mjs?weights=" + Date.now());
  const routes = [];
  await W.register({ get: (p, fn) => routes.push({ p, fn }), post: (p, fn) => routes.push({ p, fn, post: true }), del() {} }, { store, dataDir: dir });
  const allowed = [ETH, TOKENS.USDG, TOKENS.SPY, TOKENS.NVDA, TOKENS.TROYA];
  const posted = [];
  const post = async (t) => { posted.push(t); return true; };

  // (4) refusals: an asset off the allow-list, a sum other than 100%, a negative weight, an asset named twice
  assert.match(W.validateWeights({ ETH: 50, AAPL: 50 }, allowed).reason, /not an asset address or a known symbol/);
  assert.match(W.validateWeights({ ETH: 50, "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9": 50 }, allowed).reason, /not on the vault's allow-list/);
  assert.match(W.validateWeights({ ETH: 50, USDG: 49 }, allowed).reason, /add up to 99%, not 100%/);
  assert.match(W.validateWeights({ ETH: 110, USDG: -10 }, allowed).reason, /at least 0/);
  assert.match(W.validateWeights({ ETH: 50, [ETH]: 50 }, allowed).reason, /named twice/);
  const good = W.validateWeights({ ETH: 40, USDG: 30, SPY: 30 }, allowed);
  assert.equal(good.ok, true); assert.equal(good.targets[lc(TOKENS.SPY)], 30);
  await assert.rejects(W.scheduleWeights({ targets: { ETH: 60, USDG: 30 } }, { allowed, post }), /Refused: The weights add up to 90%/);
  await assert.rejects(W.scheduleWeights({ targets: { ETH: 50, TSLA: 50 } }, { allowed, post }), /Refused/);
  assert.equal(posted.length, 0, "a refused change is not announced");
  ok("weights refused: asset off the allow-list, sum not 100%, negative, named twice (nothing scheduled, nothing posted)");

  // (2) a change is pending for at least 48 hours, even if a shorter delay is asked; the old weights stay in use
  const t0 = 1_800_000_000_000;
  const before = await W.activeWeights(allowed);
  const w1 = await W.scheduleWeights({ targets: { ETH: 40, USDG: 20, SPY: 20, NVDA: 15, TROYA: 5 }, delayMs: 3600_000, note: "more SPY" }, { allowed, post, now: t0 });
  assert.equal(w1.pending.activatesAt, t0 + 48 * 3600_000, "never sooner than 48 hours");
  await assert.rejects(W.scheduleWeights({ targets: { ETH: 100 } }, { allowed, post, now: t0 }), /already scheduled/);
  const early = await W.activateDueWeights({ allowed, post, now: t0 + 47.9 * 3600_000 });
  assert.equal(early.activated, false);
  assert.deepEqual((await W.activeWeights(allowed)).targets, before.targets, "the keeper keeps the old weights until activation");
  // (1) published: active and pending in GET /api/index and /api/index/weights
  const view = await routes.find((x) => x.p === "/api/index").fn({});
  assert.equal(view.weights.active.targets.ETH, 35);
  assert.equal(view.weights.pending.targets.ETH, 40);
  assert.equal(view.weights.pending.activatesAt, t0 + 48 * 3600_000);
  assert.equal((await routes.find((x) => x.p === "/api/index/weights" && !x.post).fn({})).pending.note, "more SPY");
  // (3) announced when scheduled
  assert.match(posted[0], /new target weights were scheduled/); assert.match(posted[0], /ETH 40%, USDG 20%, SPY 20%, NVDA 15%, TROYA 5%/); assert.match(posted[0], /2027-01-17 08:00 UTC/);
  ok("a change waits at least 48 hours as pending, published in /api/index, announced; the keeper keeps the old weights");

  // activation at the time, announced; the keeper then uses the new weights
  const act = await W.activateDueWeights({ allowed, post, now: t0 + 48 * 3600_000 });
  assert.equal(act.activated, true);
  assert.equal((await W.activeWeights(allowed)).targets[ETH], 40);
  assert.match(posted[1], /now active/);
  assert.equal((await routes.find((x) => x.p === "/api/index").fn({})).weights.pending, null);
  ok("activation after 48 hours: the new weights are used and announced");

  // cancelled before activation: nothing changes, announced
  await W.scheduleWeights({ targets: { ETH: 100 } }, { allowed, post, now: t0 + 50 * 3600_000 });
  await W.cancelWeights({ post, now: t0 + 51 * 3600_000 });
  assert.match(posted[3], /cancelled/);
  const late = await W.activateDueWeights({ allowed, post, now: t0 + 200 * 3600_000 });
  assert.equal(late.activated, false);
  assert.equal((await W.activeWeights(allowed)).targets[ETH], 40, "the cancelled change never applies");
  await assert.rejects(W.cancelWeights({ post }), /No weight change is scheduled/);
  ok("a scheduled change can be cancelled before it activates; it then never applies");

  // re-checked at activation: an asset removed from the vault in the meantime drops the change
  await W.scheduleWeights({ targets: { ETH: 50, SPY: 50 } }, { allowed, post, now: t0 + 300 * 3600_000 });
  const pruned = allowed.filter((a) => a !== TOKENS.SPY);
  const rej = await W.activateDueWeights({ allowed: pruned, post, now: t0 + 400 * 3600_000 });
  assert.equal(rej.activated, false); assert.match(rej.rejected, /SPY is not on the vault's allow-list/);
  assert.equal((await W.activeWeights(allowed)).targets[ETH], 40);
  ok("weights re-checked at activation: a change naming an asset no longer allowed is dropped");

  // the keeper refuses active weights that became unusable (a hand-edited file, an asset retired and pruned)
  await store.writeJson("index-weights.json", { active: { targets: { [ETH]: 60, [lc(TOKENS.USDG)]: 30 }, driftPct: 5, minTradeEth: 0.005 }, pending: null, history: [] });
  const bad = await W.activeWeights(allowed);
  assert.equal(bad.ok, false); assert.match(bad.reason, /90%/);
  await store.writeJson("index-weights.json", { active: { targets: { [ETH]: 50, [lc(TOKENS.SPY)]: 50 } }, pending: null, history: [] });
  assert.equal((await W.activeWeights(pruned)).ok, false, "SPY no longer allowed: refused");
  ok("the keeper refuses active weights that do not sum to 100% or name an asset off the allow-list");
}

console.log(`\n${n} passed`);
