// $TROYA flywheel, automatic mode. The creator wallet's key, imported once by an admin from the app and stored
// encrypted (AES-256-GCM, its own key file), lets the server run each cycle by itself:
//   claim the creator fees → buy $TROYA back through Troya Gate → burn() the burn share → lock the rest as
//   full-range liquidity in the Pons pool, the position NFT minted straight to 0x…dEaD.
// Rails, all enforced here, not in the browser:
//   · it signs only these calls: escrow.claim(), the Universal Router swap the server built for ETH → $TROYA,
//     TROYA.burn(), TROYA.approve(Permit2), Permit2.approve(PositionManager), PositionManager.modifyLiquidities
//     with the position minted to 0x…dEaD; anything else is refused
//   · Troya Gate must pass; a cycle spends at most `maxEth` and keeps `reserveEth` for gas
//   · one cycle at a time, at most one every `everyHours`; off switch in the app and /flywheel off in the bot
// Every step is checked on chain by recordStep() (the same log the public page reads) and reported to the admins'
// Telegram chats linked for reports.
//   GET  /api/flywheel/auto            admin: status and settings (never the key)
//   POST /api/flywheel/auto/key        admin: { privateKey } → must be the creator wallet's key
//   POST /api/flywheel/auto/settings   admin: { enabled, minEth, burnPct, maxEth, everyHours }
//   POST /api/flywheel/auto/run        admin: run a cycle now (same rails)
//   POST /api/flywheel/auto/forget     admin: delete the stored key
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Wallet, JsonRpcProvider, Interface, AbiCoder, getAddress, parseEther, formatEther } from "ethers";
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";
import { TROYA, CREATOR, ESCROW, POSM, DEAD, flywheelView, recordStep } from "./flywheel.mjs";

const RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
const UR = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");        // the only swap target accepted
const coder = AbiCoder.defaultAbiCoder();
const ESC = new Interface(["function claim() returns (uint256)"]);
const TOK = new Interface(["function burn(uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const P2 = new Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration)", "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const POS = new Interface(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
const DEFAULTS = { enabled: false, minEth: 0.02, burnPct: 70, maxEth: 0.5, everyHours: 6, reserveEth: 0.0003 };

let store = null, dir = null, port = 0, provider = null, running = false;
const SET = "flywheel-auto.json";

/* ---------- the key, encrypted at rest ---------- */
async function masterKey() {
  const f = join(dir, "flywheel.key");
  try { const k = await readFile(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32);
  await writeFile(f, k, { mode: 0o600 });
  return k;
}
async function saveKey(pk) {
  const k = await masterKey(), iv = randomBytes(12), c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  await writeFile(join(dir, "flywheel-key.json"), JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex"), addr: CREATOR, at: Date.now() }), { mode: 0o600 });
}
async function signer() {
  let j; try { j = JSON.parse(await readFile(join(dir, "flywheel-key.json"), "utf8")); } catch { return null; }
  const d = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(j.iv, "hex"));
  d.setAuthTag(Buffer.from(j.tag, "hex"));
  const w = new Wallet(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]).toString("utf8"), provider);
  if (w.address !== CREATOR) return null;
  return w;
}
const keySet = async () => { try { await readFile(join(dir, "flywheel-key.json")); return true; } catch { return false; } };

/* ---------- helpers ---------- */
async function local(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} answered ${r.status}`);
  return j;
}
const troyaOf = async (a) => BigInt(await provider.call({ to: TROYA, data: TOK.encodeFunctionData("balanceOf", [a]) }));
function fullRangeL(sqrtPX96, ts, eth, troya) {
  const Q = 2n ** 96n, lo = Math.ceil(-887272 / ts) * ts, hi = Math.floor(887272 / ts) * ts;
  const sq = (t) => BigInt(Math.floor(Math.pow(1.0001, t / 2) * 2 ** 96));
  const a = sq(lo), b = sq(hi), p = BigInt(sqrtPX96);
  const L0 = eth * p * b / ((b - p) * Q), L1 = troya * Q / (p - a);
  return { L: (L0 < L1 ? L0 : L1) * 99n / 100n, lo, hi };
}
// the only transactions this module will ever sign
function allowed(tx) {
  const to = lc(tx.to), sel = String(tx.data || "0x").slice(0, 10);
  if (to === lc(ESCROW)) return sel === ESC.getFunction("claim").selector && !BigInt(tx.value || 0);
  if (to === lc(TROYA)) return (sel === TOK.getFunction("burn").selector || (sel === TOK.getFunction("approve").selector && lc(TOK.decodeFunctionData("approve", tx.data)[0]) === lc(PERMIT2))) && !BigInt(tx.value || 0);
  if (to === lc(PERMIT2)) { if (sel !== P2.getFunction("approve").selector) return false; const [tok, sp] = P2.decodeFunctionData("approve", tx.data); return lc(tok) === lc(TROYA) && lc(sp) === lc(POSM); }
  if (to === lc(POSM)) return sel === POS.getFunction("modifyLiquidities").selector && lc(tx.data).includes(lc(DEAD).slice(2));
  if (to === lc(UR)) return true;                                    // built by our own swap/build for ETH → $TROYA, value checked below
  return false;
}
async function send(w, tx, log, label) {
  if (!allowed(tx)) throw new Error(`Refused to sign ${label}: not one of the flywheel's calls.`);
  const r = await w.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0), chainId: 4663 });
  const rc = await r.wait(1, 180_000);
  if (!rc || rc.status !== 1) throw new Error(`${label} failed on chain (${r.hash}).`);
  log.steps.push({ step: label, hash: r.hash });
  return { hash: r.hash, rc };
}
async function tell(text) {
  try { const c = await import("./community.mjs"); await c.notifyAdmins?.(text); } catch {}
}

/* ---------- one cycle ---------- */
async function cycle(reason = "schedule") {
  if (running) return { skipped: "A cycle is already running." };
  running = true;
  const s = { ...DEFAULTS, ...(await store.readJson(SET, {})) };
  const log = { at: Date.now(), reason, steps: [], note: null, error: null };
  const id = `auto${Date.now()}`;
  try {
    const w = await signer();
    if (!w) throw new Error("No creator key is stored.");
    let d = await flywheelView();
    // 1 claim what is waiting
    if (d.fees.waitingEth >= Math.max(0.001, s.minEth / 4)) {
      const { hash } = await send(w, { to: ESCROW, data: ESC.encodeFunctionData("claim"), value: 0 }, log, "claim");
      await recordStep({ cycle: id, step: "claim", hash }).catch(() => {});
    }
    const bal = Number(formatEther(await provider.getBalance(CREATOR)));
    const E = Math.min(s.maxEth, bal - s.reserveEth);
    if (!(E >= s.minEth)) { log.note = `Below the threshold: ${E > 0 ? E.toFixed(5) : 0} ETH available, ${s.minEth} ETH needed.`; return log; }
    const share = Math.max(0, Math.min(100, s.burnPct)) / 100;
    const burnEth = E * share, lockEth = E * (1 - share) / 2, buyEth = burnEth + lockEth;
    const amt = +buyEth.toFixed(8);
    // 2 buy back through the Gate
    const gate = await local(`/api/swap/gate?in=eth&out=${TROYA}&amount=${amt}`);
    if (gate.pass === false) throw new Error(`Troya Gate stopped the buyback: ${(gate.checks || []).filter((x) => x.status === "fail").map((x) => `${x.label || x.name}: ${x.detail}`).join("; ")}`);
    const built = await local("/api/swap/build", { from: CREATOR, tokenIn: "ETH", tokenOut: TROYA, amountIn: String(amt), slippageBps: 300 });
    if (lc(built.to) !== lc(UR)) throw new Error("The swap route is not the Universal Router; skipped for safety.");
    if (BigInt(built.value || 0) > parseEther(amt.toFixed(18)) + 1000n) throw new Error("The swap would spend more than planned; skipped.");
    const before = await troyaOf(CREATOR);
    const b = await send(w, built, log, "buyback");
    await recordStep({ cycle: id, step: "buyback", hash: b.hash }).catch(() => {});
    const got = (await troyaOf(CREATOR)) - before;
    if (got <= 0n) throw new Error("The buyback brought no $TROYA.");
    const burnAmt = share >= 1 ? got : (got * BigInt(Math.round(burnEth / buyEth * 1e6))) / 1000000n;
    const lpTroya = got - burnAmt;
    // 3 burn
    if (burnAmt > 0n) {
      const { hash } = await send(w, { to: TROYA, data: TOK.encodeFunctionData("burn", [burnAmt]), value: 0 }, log, "burn");
      await recordStep({ cycle: id, step: "burn", hash }).catch(() => {});
    }
    // 4 lock: full range in the Pons pool, the NFT minted to 0x…dEaD
    if (lpTroya > 0n && lockEth > 0) {
      const ethWei = parseEther(lockEth.toFixed(18));
      const a1 = BigInt(await provider.call({ to: TROYA, data: TOK.encodeFunctionData("allowance", [CREATOR, PERMIT2]) }));
      if (a1 < lpTroya) await send(w, { to: TROYA, data: TOK.encodeFunctionData("approve", [PERMIT2, lpTroya]), value: 0 }, log, "approve-permit2");
      const a2 = P2.decodeFunctionResult("allowance", await provider.call({ to: PERMIT2, data: P2.encodeFunctionData("allowance", [CREATOR, TROYA, POSM]) }));
      if (BigInt(a2.amount) < lpTroya || Number(a2.expiration) < Date.now() / 1000 + 120)
        await send(w, { to: PERMIT2, data: P2.encodeFunctionData("approve", [TROYA, POSM, lpTroya, Math.floor(Date.now() / 1000) + 1800]), value: 0 }, log, "approve-positionmanager");
      d = await flywheelView();
      const k = d.pool.key;
      const { L, lo, hi } = fullRangeL(d.pool.sqrtPriceX96, k.ts, ethWei, lpTroya);
      if (L > 0n) {
        const keyT = [k.c0, k.c1, k.fee, k.ts, k.hooks];
        const params = [
          coder.encode(["tuple(address,address,uint24,int24,address)", "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [keyT, lo, hi, L, ethWei, lpTroya, DEAD, "0x"]),
          coder.encode(["address", "address"], [k.c0, k.c1]),
          coder.encode(["address", "address"], [k.c0, CREATOR]),
        ];
        const data = POS.encodeFunctionData("modifyLiquidities", [coder.encode(["bytes", "bytes[]"], ["0x020d14", params]), BigInt(Math.floor(Date.now() / 1000) + 1200)]);
        await provider.call({ from: CREATOR, to: POSM, data, value: ethWei });       // simulate first: a revert costs nothing
        const { hash } = await send(w, { to: POSM, data, value: ethWei }, log, "lock");
        await recordStep({ cycle: id, step: "lock", hash }).catch(() => {});
      } else log.note = "Too small for a liquidity position; the $TROYA stays in the creator wallet for the next cycle.";
    }
    log.summary = { eth: E, buyEth, burnEth, lockEth, troyaBought: Number(formatEther(got)), troyaBurned: Number(formatEther(burnAmt)) };
    await tell(`<b>Flywheel cycle done</b> (automatic)\n${E.toFixed(5)} ETH: bought back ${Math.round(log.summary.troyaBought).toLocaleString("en-US")} $TROYA, burned ${Math.round(log.summary.troyaBurned).toLocaleString("en-US")}, locked the rest to 0x…dEaD.\n${log.steps.map((x) => `${x.step}: robinhoodchain.blockscout.com/tx/${x.hash}`).join("\n")}\ntroya.codes/flywheel`);
    return log;
  } catch (e) {
    log.error = String(e?.shortMessage || e?.message || e).slice(0, 400);
    await tell(`<b>Flywheel cycle stopped</b> (automatic)\n${log.error}${log.steps.length ? `\nDone before it stopped: ${log.steps.map((x) => x.step).join(", ")}` : ""}`);
    return log;
  } finally {
    running = false;
    await store.update(SET, {}, (x) => { x.lastRun = log.at; x.runs = [log, ...(x.runs || [])].slice(0, 30); return x; });
  }
}

export async function register(r, ctx) {
  store = ctx.store; dir = ctx.dataDir; port = Number(process.env.PORT) || 9270;
  provider = new JsonRpcProvider(RPC, { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
  await mkdir(dir, { recursive: true });

  r.get("/api/flywheel/auto", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const s = { ...DEFAULTS, ...(await store.readJson(SET, {})) };
    return { keySet: await keySet(), creator: CREATOR, running, settings: { enabled: s.enabled, minEth: s.minEth, burnPct: s.burnPct, maxEth: s.maxEth, everyHours: s.everyHours, reserveEth: s.reserveEth }, lastRun: s.lastRun || null, runs: (s.runs || []).slice(0, 10) };
  }, { weight: 1 });
  r.post("/api/flywheel/auto/key", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    let pk = String(body?.privateKey || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new HttpError(400, "That is not a private key (64 hex characters).");
    let w; try { w = new Wallet(pk); } catch { throw new HttpError(400, "That is not a valid private key."); }
    if (w.address !== CREATOR) throw new HttpError(400, `That key belongs to ${w.address}, not the $TROYA creator wallet ${CREATOR}. Nothing was stored.`);
    await saveKey(pk);
    return { ok: true, address: w.address };
  }, { weight: 3, perMin: 5, maxBody: 2048 });
  r.post("/api/flywheel/auto/forget", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    await unlink(join(dir, "flywheel-key.json")).catch(() => {});
    await store.update(SET, {}, (x) => { x.enabled = false; return x; });
    return { ok: true };
  }, { weight: 2 });
  r.post("/api/flywheel/auto/settings", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    let out;
    await store.update(SET, {}, (x) => {
      const s = { ...DEFAULTS, ...x };
      if (body?.enabled != null) s.enabled = !!body.enabled;
      s.minEth = num(body?.minEth ?? s.minEth, 0.002, 10, s.minEth);
      s.burnPct = num(body?.burnPct ?? s.burnPct, 0, 100, s.burnPct);
      s.maxEth = num(body?.maxEth ?? s.maxEth, 0.005, 50, s.maxEth);
      s.everyHours = num(body?.everyHours ?? s.everyHours, 1, 168, s.everyHours);
      out = s; return { ...x, ...s };
    });
    if (out.enabled && !(await keySet())) throw new HttpError(400, "Import the creator key first, then switch it on.");
    return { settings: out };
  }, { weight: 2 });
  r.post("/api/flywheel/auto/run", async ({ req }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    return await cycle("run now");
  }, { weight: 5, perMin: 3 });

  // the schedule: every 10 minutes, look; run when it is on, due and there is enough to work with
  if (process.env.FLYWHEEL_AUTO !== "0") setInterval(async () => {
    try {
      const s = { ...DEFAULTS, ...(await store.readJson(SET, {})) };
      if (!s.enabled || running || !(await keySet())) return;
      if (s.lastRun && Date.now() - s.lastRun < s.everyHours * 3600_000) return;
      const d = await flywheelView();
      const ready = d.fees.waitingEth + Math.max(0, d.fees.creatorWalletEth - s.reserveEth);
      if (ready < s.minEth) return;
      await cycle("schedule");
    } catch (e) { console.warn("[flywheel-auto]", e.message); }
  }, 10 * 60_000).unref();
}

/** The bot's /flywheel off|on for linked admin chats. */
export async function setEnabled(on) {
  if (!store) return null;
  if (on && !(await keySet())) return { ok: false, why: "No creator key is stored." };
  await store.update(SET, {}, (x) => { x.enabled = !!on; return x; });
  return { ok: true };
}
export { allowed as _allowed };
