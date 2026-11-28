// Exit Promise, pilot (Xivor's "Aegis" idea, owner approved the small pilot on 28 Nov 2026; Styx Promise, level two):
// if Troya Gate passed a coin, you bought it through Troya, and within 7 days Troya's own re-test cannot sell it, you get
// your buy back up to $10 per wallet per coin, from a 0.1 ETH pilot fund held by the team Safe. Price drops are not
// covered. Each payout is a Gate miss and is listed as one.
// Buys that count (from the pilot's start): Agent Wallet buys (the app, Telegram, X; not the Arena) that the server
// executed with a Gate pass (data/journal.jsonl), and Swap page buys on Robinhood Chain booked by POST /api/swap/sent
// (the calldata Troya built, sent by that wallet), with the Gate passing the coin when the buy is booked.
// Never covered: team, admin, Arena and test wallets (as stakebonus), the coin's deployer and the wallets tied to its dev.
// The re-test: every 6 hours while a covered buy is younger than 7 days, the Gate runs a simulated buy and test sell
// (the Two Fates re-test). Two failed sells at least 3 hours apart, with no passing sell in between, open a claim for each
// covered wallet (one per wallet per coin).
// Paying: nothing here sends money. A claim is proposed to the team Safe's queue by the server proposer (an ETH transfer
// to the buyer); two of the three owners confirm and one executes. The owner is told on Telegram. The fund cap counts
// every proposed and paid claim.
//   GET /api/exitpromise   rules, fund, what is covered and watched, every claim with its evidence
import { getAddress } from "ethers";
import { readFile } from "node:fs/promises";

const FILE = "exit-promise.json";
export const SINCE = Date.UTC(2026, 10, 28, 4, 0);        // the pilot covers buys from 28 Nov 2026 04:00 UTC
export const FUND_CAP_ETH = 0.1;
export const PER_CLAIM_USD = 10;
const WINDOW = 7 * 86400e3;
const RETEST_EVERY = 6 * 3600e3;
const CONFIRM_GAP = 3 * 3600e3;
const TICK_MS = 10 * 60_000;
const RETEST_ETH = "0.001";
export const RULES = "Exit Promise (pilot): if Troya Gate passed a coin, you bought it through Troya (the Swap page on Robinhood Chain, your Agent Wallet, or a trade in Telegram or on X), and within 7 days Troya's own re-test cannot sell it, you get your buy back, up to $10 per wallet per coin, while the 0.1 ETH pilot fund lasts. Price drops are not covered: only a coin that cannot be sold. The re-test runs every 6 hours; two failed sells at least 3 hours apart open a claim. Team wallets, the coin's deployer and wallets tied to its dev are not covered. The payout is an ETH transfer from the team Safe, confirmed by two of its three owners, and each one is listed as a Gate miss.";

let store = null, busy = false;
let state = { buys: {}, coins: {}, claims: [], journalAt: SINCE, at: 0 };
const lc = (a) => String(a || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "–");
const save = () => store.writeJson(FILE, { ...state, claims: state.claims.slice(-500) }).catch((e) => console.warn("[exitpromise] save", e.message));
const native = (t) => !t || /^(eth|native|0x0{40})$/i.test(String(t)) || lc(t) === "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

/** a Swap page buy booked by POST /api/swap/sent (stakebonus.recordWebSwap): covered if the Gate passes the coin now */
export async function noteWebBuy({ address, t, hash, usd, tokenIn, tokenOut, eth }) {
  if (!store || t < SINCE || !isAddr(address) || !native(tokenIn) || !isAddr(tokenOut)) return null;
  const key = `web:${lc(hash)}`;
  if (state.buys[key]) return state.buys[key];
  const pass = await gatePasses(tokenOut);
  state.buys[key] = { wallet: lc(address), token: lc(tokenOut), at: t, eth: Number(eth) || null, usd: Number(usd) || 0, source: "swap page", hash: lc(hash), covered: pass === true, why: pass === true ? null : pass === false ? "the Gate did not pass this coin when the buy was booked" : "the Gate could not be read when the buy was booked" };
  await save();
  return state.buys[key];
}

async function gatePasses(token) {
  const { gateCheck } = await import("./robinhood.mjs");
  const g = await Promise.race([gateCheck({ tokenIn: "ETH", tokenOut: getAddress(lc(token)), amountIn: "0.01", slippageBps: 100 }), new Promise((r) => setTimeout(() => r(null), 45_000))]).catch(() => null);
  return g ? !!g.pass : null;
}

/** Agent Wallet buys the server executed with a Gate pass, since the last read of the journal */
async function readJournal() {
  let text = "";
  try { text = await readFile(store.path("journal.jsonl"), "utf8"); } catch { return; }
  let last = state.journalAt;
  for (const line of text.split("\n")) {
    if (!line.includes('"agent-wallet.swap"') || !line.includes('"executed"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Number(e.t) || 0;
    if (t <= state.journalAt || t < SINCE) continue;
    last = Math.max(last, t);
    const p = e.data?.params || {}, res = e.data?.result || {};
    if (String(e.source || "") === "arena" || /^reported/.test(String(e.source || ""))) continue;
    if (!native(p.tokenIn) || !isAddr(p.tokenOut)) continue;                         // buys only: ETH into a coin
    const steps = Array.isArray(res.steps) ? res.steps : res.hash ? [res] : [];
    const lastStep = steps[steps.length - 1];
    if (!lastStep || lastStep.status !== "confirmed") continue;
    const key = `aw:${e.id}`;
    if (state.buys[key]) continue;
    const eth = Number(p.amountIn) || 0;
    const ethUsd = await (await import("./market.mjs")).getEthUsd().catch(() => null);
    state.buys[key] = { wallet: lc(e.address), token: lc(p.tokenOut), at: t, eth, usd: ethUsd ? eth * ethUsd : null, source: e.source === "telegram" ? "Telegram" : e.source === "x" ? "X" : "Agent Wallet", hash: lastStep.hash || null,
      covered: e.data?.gate?.pass === true, why: e.data?.gate?.pass === true ? null : "the Gate did not pass this coin at the buy" };
  }
  state.journalAt = last;
}

/** wallets never covered: team, admin, Arena and test wallets, the deployer, the dev's linked wallets */
async function excludedFor(token, wallet) {
  const sb = await import("./stakebonus.mjs").catch(() => null);
  const team = sb?.excluded ? await Promise.resolve(sb.excluded()).catch(() => new Set()) : new Set();
  if (new Set([...team].map(lc)).has(lc(wallet))) return "a team, admin, Arena or test wallet";
  const R = await import("./robinhood.mjs");
  const ps = await R.ponsState(getAddress(lc(token))).catch(() => null);
  if (ps && (lc(ps.deployer) === lc(wallet) || lc(ps.creatorFeeRecipient) === lc(wallet))) return "the coin's deployer";
  const D = await import("./devlinks.mjs").catch(() => null);
  const side = D?.devSideOf?.(token);
  const linked = side?.linked ? [...side.linked].map(lc) : [];
  if (linked.includes(lc(wallet))) return "a wallet tied to the coin's dev";
  return null;
}

/** the re-test, the Two Fates way: false when the test sell, the simulation or the route fails; true when the sell passes */
async function sellable(token) {
  const { gateCheck } = await import("./robinhood.mjs");
  const g = await Promise.race([gateCheck({ tokenIn: "ETH", tokenOut: getAddress(lc(token)), amountIn: RETEST_ETH, slippageBps: 100 }), new Promise((r) => setTimeout(() => r(null), 45_000))]).catch(() => null);
  const ch = Array.isArray(g?.checks) ? g.checks : [];
  const failed = ch.filter((x) => ["sell", "sim", "route"].includes(x.key) && x.status === "fail");
  if (failed.length) return { ok: false, detail: failed.map((x) => `${x.name || x.key}: ${x.detail || "failed"}`).join("; ").slice(0, 300) };
  if (ch.some((x) => x.key === "sell" && (x.status === "pass" || x.status === "warn"))) return { ok: true, detail: null };
  return { ok: null, detail: "the Gate could not finish" };
}

/** the re-tests that confirm a coin cannot be sold: two failed sells at least 3 hours apart, no passing sell in between */
export function confirmedFails(checks) {
  const known = (checks || []).filter((x) => x.ok !== null);
  const lastPass = Math.max(0, ...known.filter((x) => x.ok === true).map((x) => x.at));
  const fails = known.filter((x) => x.ok === false && x.at > lastPass);
  return fails.length >= 2 && fails[fails.length - 1].at - fails[0].at >= CONFIRM_GAP ? fails : null;
}

/** used = proposed + paid, in ETH */
const usedEth = () => state.claims.filter((c) => c.status === "proposed" || c.status === "paid").reduce((s, c) => s + (Number(c.refundEth) || 0), 0);

async function openClaims(token, evidence) {
  const now = Date.now();
  const ethUsd = await (await import("./market.mjs")).getEthUsd().catch(() => null);
  const seen = new Set(state.claims.filter((c) => c.token === token).map((c) => c.wallet));
  for (const b of Object.values(state.buys)) {
    if (b.token !== token || !b.covered || now - b.at > WINDOW || seen.has(b.wallet)) continue;
    seen.add(b.wallet);
    const why = await excludedFor(token, b.wallet);
    const refundUsd = Math.min(PER_CLAIM_USD, Number(b.usd) || (b.eth && ethUsd ? b.eth * ethUsd : 0));
    const refundEth = ethUsd ? Math.floor((refundUsd / ethUsd) * 1e6) / 1e6 : null;
    const c = { id: `${token.slice(2, 10)}-${b.wallet.slice(2, 10)}`, at: now, wallet: b.wallet, token, buyAt: b.at, buyEth: b.eth, buyUsd: b.usd, source: b.source, buyHash: b.hash,
      refundUsd: Math.round(refundUsd * 100) / 100, refundEth, evidence, status: why ? "not covered" : "queued", why: why || null };
    state.claims.push(c);
    console.log(`[exitpromise] claim ${c.id}: ${short(c.wallet)} on ${short(token)} · ${c.status}${why ? ` (${why})` : ` · $${c.refundUsd}`}`);
  }
}

async function proposePayouts() {
  const S = await import("./safeprop.mjs");
  const { rpc } = await import("./robinhood.mjs");
  const bal = Number(BigInt(await rpc("robinhood", "eth_getBalance", [S.SAFE, "latest"]).catch(() => "0x0"))) / 1e18;
  const told = [];
  for (const c of state.claims.filter((x) => x.status === "queued")) {
    if (!(c.refundEth > 0)) { c.status = "needs review"; c.why = "no ETH price to size the refund"; continue; }
    if (usedEth() + c.refundEth > FUND_CAP_ETH + 1e-9) { c.status = "fund used up"; continue; }
    const pending = state.claims.filter((x) => x.status === "proposed").reduce((s, x) => s + x.refundEth, 0);
    if (bal < pending + c.refundEth) { c.why = `waiting for the fund: the Safe holds ${bal.toFixed(4)} ETH`; continue; }
    try {
      const p = await S.proposeSafeTx({ to: c.wallet, value: BigInt(Math.round(c.refundEth * 1e18)).toString(), data: "0x", origin: `Exit Promise refund ${c.id}` });
      Object.assign(c, { status: "proposed", safeNonce: p.nonce, safeTxHash: p.safeTxHash, proposedAt: Date.now(), why: null });
      told.push(c);
    } catch (e) { c.why = `could not be proposed yet: ${e.message}`.slice(0, 200); }
  }
  if (told.length) {
    const { tellOwner } = await import("./infrawatch.mjs").catch(() => ({}));
    await tellOwner?.(`<b>Exit Promise: ${told.length} refund${told.length === 1 ? "" : "s"} in the Safe queue</b>\nA coin the Gate passed could not be sold at Troya's re-test. Confirm in the Safe app (2 of 3) and execute:\n${told.map((c) => `• nonce ${c.safeNonce}: ${c.refundEth} ETH ($${c.refundUsd}) to ${short(c.wallet)} · coin ${short(c.token)} · ${c.evidence?.[c.evidence.length - 1]?.detail || ""}`).join("\n")}`).catch(() => {});
  }
}

async function trackPaid() {
  const S = await import("./safeprop.mjs");
  for (const c of state.claims.filter((x) => x.status === "proposed" && x.safeTxHash)) {
    const st = await S.safeTxStatus(c.safeTxHash).catch(() => null);
    if (st?.executed && st.successful !== false) Object.assign(c, { status: "paid", paidAt: Date.now(), txHash: st.txHash });
    else if (st?.executed && st.successful === false) Object.assign(c, { status: "queued", why: "the Safe transaction failed; it will be proposed again" });
  }
}

async function tick() {
  if (busy || !store) return;
  busy = true;
  try {
    await readJournal();
    const now = Date.now();
    const tokens = new Set(Object.values(state.buys).filter((b) => b.covered && now - b.at <= WINDOW).map((b) => b.token));
    for (const t of tokens) {
      const c = state.coins[t] || (state.coins[t] = { checks: [] });
      if (now - (c.lastAt || 0) < RETEST_EVERY) continue;
      const r = await sellable(t);
      c.lastAt = now;
      c.checks = [...c.checks, { at: now, ok: r.ok, detail: r.detail }].slice(-12);
      const fails = confirmedFails(c.checks);
      if (fails) await openClaims(t, fails.map((x) => ({ at: x.at, detail: x.detail })));
    }
    await proposePayouts();
    await trackPaid();
    state.at = now;
    await save();
  } catch (e) { console.warn("[exitpromise]", e.message); } finally { busy = false; }
}

export async function view() {
  const S = await import("./safeprop.mjs");
  const { rpc } = await import("./robinhood.mjs");
  const bal = Number(BigInt(await rpc("robinhood", "eth_getBalance", [S.SAFE, "latest"]).catch(() => "0x0"))) / 1e18;
  const now = Date.now();
  const covered = Object.values(state.buys).filter((b) => b.covered);
  return {
    name: "Exit Promise (pilot)", rules: RULES, since: SINCE, fund: { holder: S.SAFE, holderIs: "the team Safe (2 of 3)", balanceEth: Math.round(bal * 1e6) / 1e6, capEth: FUND_CAP_ETH, usedEth: Math.round(usedEth() * 1e6) / 1e6, perClaimUsd: PER_CLAIM_USD },
    covered: { buys: covered.length, wallets: new Set(covered.map((b) => b.wallet)).size, open: covered.filter((b) => now - b.at <= WINDOW).length },
    watching: Object.entries(state.coins).filter(([t]) => covered.some((b) => b.token === t && now - b.at <= WINDOW)).map(([t, c]) => ({ token: getAddress(t), lastAt: c.lastAt || null, last: c.checks?.[c.checks.length - 1] || null })),
    claims: state.claims.slice(-50).reverse().map((c) => ({ id: c.id, at: c.at, wallet: short(c.wallet), token: getAddress(c.token), refundUsd: c.refundUsd, refundEth: c.refundEth, status: c.status, why: c.why, evidence: c.evidence, safeNonce: c.safeNonce ?? null, txHash: c.txHash || null })),
    paidCount: state.claims.filter((c) => c.status === "paid").length,
    updatedAt: state.at || null,
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  state = await store.readJson(FILE, state).catch(() => state);
  for (const k of ["buys", "coins"]) if (!state[k] || typeof state[k] !== "object") state[k] = {};
  if (!Array.isArray(state.claims)) state.claims = [];
  if (!state.journalAt) state.journalAt = SINCE;
  r.get("/api/exitpromise", () => view(), { weight: 1, perMin: 60 });
  if (process.env.EXIT_PROMISE === "0") return;
  setTimeout(() => tick().catch(() => {}), 60_000).unref?.();
  setInterval(() => tick().catch(() => {}), TICK_MS).unref?.();
}

export const _test = { confirmedFails, setStore: (s) => { store = s; }, setState: (s) => { state = s; }, getState: () => state, openClaims, usedEth, readJournal };
