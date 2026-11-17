// V6 "Hermes" · launching coins through Troya: F26 Launch on X, F27 Launch in Telegram, and the web's Create coin.
// The rules (decided by the owner, 17 Nov 2026):
//   · Launch from X: holders of 1,000,000 $TROYA only (main wallet + Agent Wallet), and only once "Launch from X" is on in
//     the Desk. Telegram and the web: everyone.
//   · Launching is free. Troya's fee is 0.1% of the coin's trading volume, taken from the creator's 0.7% share of the Pons
//     fee through a TroyaFeeSplitter (the dev keeps 0.6% and 100% of any creator tax). Holders of 1M $TROYA pay 0%: the
//     creator fee goes straight to their own wallet.
//   · Creator tax 0–4%. At most 3 launches a day per wallet, 10 for holders. Names and tickers that copy ETH, BTC, USDG,
//     stock tokens, big coins or Troya itself are refused.
//   · Optional initial buy ("buy 0.01"): the Agent Wallet buys its own coin right after the 3-second Pons snipe tax, as a
//     normal Agent Wallet swap (Troya Gate, the wallet's caps). Not enough ETH for launch fee + buy → nothing is launched.
// Routes:
//   GET  /api/launch/rules              public numbers (holder minimum, limits, Troya's share, the splitter factory)
//   POST /api/launch/plan               { creator, creatorTaxBps, name?, symbol? } → who receives the creator fee for this launch
//   POST /api/launch/record             { hash, salt?, troyaBps? } → a web launch checked on chain and added to the creator's list
//   GET  /api/launch/mine               signed in: coins launched through Troya by this wallet
//   GET  /api/launch/prefs  POST …      signed in: { x: true|false } "Launch from X" switch
//   GET  /api/launch/board              the Hippodrome: coins born through Troya in three columns (new, almost bonded, migrated)
//   GET  /api/launch/born               addresses of coins born through Troya (the app puts the horse badge on them)
//   GET  /api/launch/splitter           the tested TroyaFeeSplitterFactory build and whether it is live
//   POST /api/launch/splitter/register  admins: { hash } of the factory deployment, checked against the tested build
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Interface, AbiCoder, getAddress, isAddress } from "ethers";
import { rpc, ADDR, STOCKS, tokenMeta, launchMenu } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";

export const HOLDER_MIN = Number(process.env.HOLDER_MIN || 1_000_000);
export const LIMITS = { perDay: 3, perDayHolder: 10 };
export const MAX_TAX_BPS = 400;                // 4%
export const TROYA_VOLUME_BPS = 10;            // Troya's fee: 0.1% of volume, out of the creator's 70 bps
export const MAX_INITIAL_BUY_ETH = 1;          // the wallet's own caps (per trade, per day) usually bite first
const CREATOR_FEE_BPS = 70;                    // 70% of the 1% Pons fee
export const PONS_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
const TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };

const facI = new Interface([
  "function predict(address creator, uint16 troyaBps, bytes32 salt) view returns (address)",
  "function escrow() view returns (address)", "function treasury() view returns (address)", "function implementation() view returns (address)",
]);
const ponsI = new Interface([
  "function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
]);

let store = null;
const call = async (to, i, fn, args = []) => i.decodeFunctionResult(fn, await rpc("robinhood", "eth_call", [{ to, data: i.encodeFunctionData(fn, args) }, "latest"]));

/* ---------- Troya's share ---------- */
/** Troya's share of everything a splitter collects, so that it comes to 0.1% of volume whatever the creator tax. */
export const troyaBpsFor = (taxBps) => Math.floor((TROYA_VOLUME_BPS * 10_000) / (CREATOR_FEE_BPS + Math.max(0, Math.round(Number(taxBps) || 0))));

let build = null;
async function buildInfo() {
  if (build) return build;
  build = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "agent", "desk", "troya-fee-splitter.json"), "utf8"));
  return build;
}
export async function splitterFactory() { return (await store.readJson("fee-splitter.json", {})).factory || null; }

/* ---------- names ---------- */
const MAJORS = ["ETH", "WETH", "BTC", "WBTC", "CBBTC", "USDG", "USDC", "USDT", "DAI", "SOL", "HYPE", "BNB", "XRP", "DOGE", "PEPE", "SHIB", "ARB", "OP", "LINK", "UNI", "TAO", "HOOD", "TROYA"];
const RESERVED_WORDS = /\b(troya|official|admin|team|support|robinhood)\b/i;
export function nameProblem(name, symbol, { team = false } = {}) {
  const n = String(name || "").trim(), s = String(symbol || "").trim().replace(/^\$/, "");
  if (!n || !s) return "The coin needs a name and a $TICKER.";
  if (!/^[A-Za-z0-9]{1,16}$/.test(s)) return "The ticker can only use letters and numbers, 16 at most.";
  if (n.length > 48) return "The name is limited to 48 characters.";
  const S = s.toUpperCase();
  if (MAJORS.includes(S) || STOCKS.some((x) => String(x.symbol).toUpperCase() === S)) return `$${S} is taken by an existing coin or stock token, so Troya will not launch a copy. Pick another ticker.`;
  if (!team && (RESERVED_WORDS.test(n) || RESERVED_WORDS.test(s))) return "Names with Troya, official, admin, team, support or Robinhood in them are reserved.";
  if (MAJORS.some((m) => n.toUpperCase().replace(/[^A-Z0-9]/g, "") === m)) return "That name copies an existing coin. Pick another.";
  return null;
}

/* ---------- limits and the record ---------- */
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
async function launchesOf(owner) { return (await store.readJson("launches.json", [])).filter((x) => lc(x.owner) === lc(owner)); }
async function usedToday(owner) { const d = dayOf(Date.now()); return (await launchesOf(owner)).filter((x) => dayOf(x.at) === d).length; }
async function holderInfo(owner) {
  try { const h = await import("./holders.mjs"); const v = await h.holderOf(owner); return { holder: v.balance >= HOLDER_MIN, balance: v.balance }; }
  catch { return { holder: false, balance: 0 }; }
}

/**
 * Who receives the creator fee of a coin `creator` launches for `owner`.
 * Holders: the owner's own wallet, 100%. Everyone else: a TroyaFeeSplitter (0.1% of volume to Troya), once the factory is live;
 * until then the owner's own wallet, as before V6.
 */
export async function plan({ owner, creatorTaxBps = 0, name, symbol, source = "web" }) {
  if (!isAddress(String(owner || ""))) throw new HttpError(400, "Connect a wallet first.");
  owner = getAddress(owner);
  const tax = Math.round(Number(creatorTaxBps) || 0);
  if (tax < 0 || tax > MAX_TAX_BPS) throw new HttpError(400, `Creator tax goes from 0% to ${MAX_TAX_BPS / 100}%.`);
  if (name != null || symbol != null) { const p = nameProblem(name, symbol, { team: admins().includes(lc(owner)) }); if (p) throw new HttpError(400, p); }
  const h = await holderInfo(owner);
  const used = await usedToday(owner), max = h.holder ? LIMITS.perDayHolder : LIMITS.perDay;
  if (used >= max) throw new HttpError(429, `That is ${used} launches through Troya today, the most for one wallet${h.holder ? "" : ` (holders of ${HOLDER_MIN.toLocaleString("en-US")} $TROYA get ${LIMITS.perDayHolder})`}. Try again tomorrow (UTC).`);
  const base = { owner, holder: h.holder, balance: h.balance, holderMin: HOLDER_MIN, creatorTaxBps: tax, limit: { used, max }, source };
  if (h.holder) return { ...base, recipient: owner, troyaBps: 0, troyaVolumePct: 0, split: false, note: `You hold ${HOLDER_MIN.toLocaleString("en-US")} $TROYA: the whole creator fee goes to your own wallet.` };
  const factory = await splitterFactory();
  if (!factory) return { ...base, recipient: owner, troyaBps: 0, troyaVolumePct: 0, split: false, note: "The creator fee goes to your own wallet." };
  const troyaBps = troyaBpsFor(tax);
  const salt = "0x" + randomBytes(32).toString("hex");
  const [recipient] = await call(factory, facI, "predict", [owner, troyaBps, salt]);
  return { ...base, recipient: getAddress(recipient), troyaBps, troyaVolumePct: TROYA_VOLUME_BPS / 100, split: true, salt, factory,
    note: `Troya takes 0.1% of trading volume out of your 0.7% creator fee; you keep 0.6%${tax ? ` plus your whole ${tax / 100}% creator tax` : ""}. Hold ${HOLDER_MIN.toLocaleString("en-US")} $TROYA to keep it all.` };
}

/** Reads a launch transaction back from the chain: the coin, its curve and its creator-fee recipient. */
export async function launchedIn(hash) {
  const rc = await rpc("robinhood", "eth_getTransactionReceipt", [hash]);
  if (!rc) return null;
  if (Number(rc.status) !== 1) return { failed: true };
  const log = (rc.logs || []).find((l) => lc(l.address) === lc(ADDR.ponsFactory) && l.topics?.[0] === TOKEN_LAUNCHED);
  if (!log) return { failed: true, why: "no Pons launch in that transaction" };
  const token = getAddress("0x" + log.topics[1].slice(26));
  const [info] = await call(ADDR.ponsFactory, ponsI, "getLaunchedToken", [token]);
  return { token, curve: getAddress(info.curve), deployer: getAddress(info.deployer), recipient: getAddress(info.creatorFeeRecipient), creatorTaxBps: Number(info.creatorTaxBps), block: Number(BigInt(rc.blockNumber)) };
}

async function addRecord(r) {
  let dup = false;
  await store.update("launches.json", [], (l) => {
    if (l.some((x) => lc(x.token) === lc(r.token))) { dup = true; return l; }
    l.push(r);
    return l.slice(-5000);
  });
  return !dup;
}

/** A web launch (signed in the browser with the creator's own wallet), checked on chain before it is recorded. */
export async function recordWeb({ hash, owner, salt, troyaBps }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new HttpError(400, "Bad transaction hash.");
  const tx = await rpc("robinhood", "eth_getTransactionByHash", [hash]);
  if (!tx) throw new HttpError(404, "That transaction is not on Robinhood Chain yet.");
  const got = await launchedIn(hash);
  if (!got || got.failed) throw new HttpError(400, "That transaction did not launch a coin on Pons.");
  const from = getAddress(tx.from);
  if (owner && lc(owner) !== lc(from)) throw new HttpError(403, "That launch was signed by another wallet.");
  let split = false, bps = 0;
  if (lc(got.recipient) !== lc(from)) {
    const factory = await splitterFactory();
    const b = Math.round(Number(troyaBps) || 0);
    if (!factory || !/^0x[0-9a-fA-F]{64}$/.test(String(salt || ""))) throw new HttpError(400, "The creator fee of that coin goes neither to its creator nor to a Troya splitter.");
    const [p] = await call(factory, facI, "predict", [from, b, salt]);
    if (lc(p) !== lc(got.recipient)) throw new HttpError(400, "The creator fee of that coin goes neither to its creator nor to a Troya splitter.");
    split = true; bps = b;
  }
  const meta = await tokenMeta(got.token).catch(() => null);
  const r = { token: got.token, curve: got.curve, name: meta?.name || null, symbol: meta?.symbol || null, owner: from, wallet: from, source: "web", recipient: got.recipient, split, troyaBps: bps, salt: split ? salt : null,
    creatorTaxBps: got.creatorTaxBps, tx: hash, at: Date.now() };
  await addRecord(r);
  return { ok: true, launch: r };
}

/* ---------- launching from the Agent Wallet (X and Telegram) ---------- */
async function prefsOf(owner) { return (await store.readJson("launch-prefs.json", {}))[lc(owner)] || { x: false }; }

/**
 * Launches a coin from `owner`'s Agent Wallet. The Agent Wallet pays the Pons launch fee; the creator fee follows plan().
 * Returns { ok, launch } or { ok: false, why }.
 */
export async function launchWithAgentWallet({ owner, name, symbol, logo, creatorTaxBps = 0, description = "", twitter = "", source, ref = null, buyEth = 0 }) {
  const p = await plan({ owner, creatorTaxBps, name, symbol, source });
  const aw = await import("./agentwallet.mjs");
  const w = await aw.getAgentWallet(owner);
  if (!w?.exists) return { ok: false, why: "no-agent-wallet" };
  buyEth = Number(buyEth) || 0;
  if (buyEth < 0 || buyEth > MAX_INITIAL_BUY_ETH) return { ok: false, why: "buy-size", reasons: [`The initial buy can be up to ${MAX_INITIAL_BUY_ETH} ETH.`] };
  if (buyEth > 0) {
    // the launch fee and the buy must both fit, or nothing is launched (no coin born without the buy that was asked for)
    const menu = await launchMenu(true);
    const bal = Number(BigInt(await rpc("robinhood", "eth_getBalance", [w.address, "latest"]))) / 1e18;
    const need = menu.launchFeeEth + buyEth + 0.0002;
    if (bal < need) return { ok: false, why: "funds", reasons: [`the Agent Wallet holds ${bal.toFixed(5)} ETH; the launch fee plus a ${buyEth} ETH buy needs about ${need.toFixed(5)} ETH`] };
  }
  const out = await aw.executeForUser(owner, {
    kind: "launch", source,
    rationale: `Launch requested on ${source}${ref ? ` (${ref})` : ""}`,
    params: { name: String(name).trim(), symbol: String(symbol).replace(/^\$/, "").trim(), logo, description, twitter, creatorTaxBps: p.creatorTaxBps, feeRecipient: p.recipient },
  });
  if (!out.executed) return { ok: false, why: out.blocked ? "blocked" : "not-sent", reasons: out.reasons || [], result: out.result || null, plan: p };
  const got = out.result?.hash ? await launchedIn(out.result.hash).catch(() => null) : null;
  const token = got?.token || out.result?.token || null;
  const r = { token, curve: got?.curve || out.result?.curve || null, logo: logo || null, name: String(name).trim(), symbol: String(symbol).replace(/^\$/, "").trim(), owner: p.owner, wallet: w.address, source, recipient: p.recipient, split: p.split, troyaBps: p.troyaBps,
    salt: p.salt || null, creatorTaxBps: p.creatorTaxBps, holder: p.holder, tx: out.result?.hash || null, ref, at: Date.now() };
  if (token) await addRecord(r);
  if (token && buyEth > 0) {
    // recorded first: the Agent Wallet may set aside the empty-curve check only for a coin it launched through Troya
    r.initialBuy = await initialBuy({ owner, token, buyEth, source, launchedAt: Date.now() });
    await store.update("launches.json", [], (l) => { const x = l.find((y) => lc(y.token) === lc(token)); if (x) x.initialBuy = r.initialBuy; return l; });
  }
  return { ok: !!token, launch: r, why: token ? null : "no-token" };
}

/** The Agent Wallet buys its own new coin once the Pons launch snipe tax (the first few seconds) is over. */
async function initialBuy({ owner, token, buyEth, source, launchedAt }) {
  const menu = await launchMenu().catch(() => ({ snipeTaxSeconds: 3 }));
  const wait = (Number(menu.snipeTaxSeconds) || 3) * 1000 + 2500 - (Date.now() - launchedAt);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  try {
    const aw = await import("./agentwallet.mjs");
    const out = await aw.executeForUser(owner, { kind: "swap", source, rationale: "Initial buy right after launch, asked for in the launch request",
      params: { tokenIn: "ETH", tokenOut: token, amountIn: buyEth, slippagePct: 5, initialBuy: true } });
    const steps = out.result?.steps || [];
    return { eth: buyEth, executed: !!out.executed, hash: steps[steps.length - 1]?.hash || null, reasons: out.reasons || [] };
  } catch (e) { return { eth: buyEth, executed: false, reasons: [String(e.message || e).slice(0, 160)] }; }
}

/* ---------- F26 · Launch on X ---------- */
/** "@Troyaagent launch Wooden Horse $HORSE tax 2%" → { name, symbol, taxBps } or null when the post is not a launch. */
export function parseLaunch(text) {
  const t = String(text || "").replace(/(^|\s)@\w+/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  const m = t.match(/^(?:please\s+|pls\s+)?launch\b\s*(.*)$/i);
  if (!m) return null;
  let rest = m[1];
  let taxBps = 0;
  const tm = rest.match(/\b(?:tax|creator\s*tax)\s*:?\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (tm) { taxBps = Math.round(Number(tm[1]) * 100); rest = rest.replace(tm[0], " "); }
  let buyEth = 0;
  const bm = rest.match(/\b(?:initial\s*buy|dev\s*buy|buy)\s*:?\s*(\d*\.?\d+)\s*(?:eth)?(?=\s|$|[,.;!])/i);
  if (bm) { buyEth = Number(bm[1]); rest = rest.replace(bm[0], " "); }
  const sm = rest.match(/\$([A-Za-z0-9]{1,16})\b/);
  const symbol = sm ? sm[1] : "";   // kept as written: $XtestTROYA stays XtestTROYA
  if (sm) rest = rest.replace(sm[0], " ");
  const name = rest.replace(/[^\p{L}\p{N} .'&-]/gu, " ").replace(/\s+/g, " ").trim().replace(/^(?:a|the|coin|token|called|named)\s+/i, "").trim()
    .replace(/(^|\s)[.'&-]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();   // a stray full stop or dash is not part of the name
  return { name, symbol, taxBps, buyEth };
}

async function linkedOwner(authorId) {
  const m = await store.readJson("x-links.json", {});
  for (const [addr, v] of Object.entries(m)) if (String(v.id) === String(authorId)) return getAddress(addr);
  return null;
}
let fetchLogo = fetchXImage;
/** tests only: replace how an X image is fetched (no network in a fork test) */
export const _setLogoFetcher = (fn) => { fetchLogo = fn; };
async function fetchXImage(url) {
  const { saveLaunchLogo } = await import("./robinhood.mjs");
  const u = new URL(url);
  if (u.hostname !== "pbs.twimg.com") throw new Error("not an X image");
  u.searchParams.set("name", "small");
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`image ${r.status}`);
  const type = String(r.headers.get("content-type") || "").split(";")[0];
  const buf = Buffer.from(await r.arrayBuffer());
  return (await saveLaunchLogo(buf, type === "image/jpg" ? "image/jpeg" : type)).url;
}
const xLaunchMode = async () => { const v = (await store.readJson("x-state.json", {})).launch || process.env.X_LAUNCH || "off"; return ["off", "test", "live"].includes(v) ? v : "off"; };
/** Launch on X is read from posts when "live" (everyone who qualifies) or "test" (admin wallets only, for the real-money test). */
export const xLaunchOn = async () => (await xLaunchMode()) !== "off";
const SITE = () => (process.env.SITE_URL || "https://troya.codes").replace(/\/+$/, "");
const DESK = () => `${SITE().replace(/^https?:\/\//, "")}/agent#/launch/x`;

/**
 * A mention of @Troyaagent that asks for a launch. Returns { reply } (the text to post back) and, when a coin went live,
 * { launch }. Nothing is launched unless Launch on X is live, the author linked a wallet, switched Launch from X on,
 * holds 1M $TROYA and the Agent Wallet can pay the Pons fee.
 */
export async function fromX({ tweetId, authorId, text, mediaUrl }) {
  const ask = parseLaunch(text);
  if (!ask) return null;
  const done = (await store.readJson("launches.json", [])).find((x) => x.ref === `x:${tweetId}`);
  if (done) return { reply: null, launch: done };
  const xm = await xLaunchMode();
  const notYet = { reply: "Launching from X is not open yet. It goes live after its real-money test; the roadmap is on troya.codes/roadmap" };
  if (xm === "off") return notYet;
  const owner = await linkedOwner(authorId);
  if (xm === "test" && !(owner && admins().includes(lc(owner)))) return notYet;
  if (!owner) return { reply: `To launch from X, link this X account to your Troya wallet and switch Launch from X on: ${DESK()}` };
  if (!(await prefsOf(owner)).x) return { reply: `Launch from X is switched off for your wallet. Turn it on here first: ${DESK()}` };
  const h = await holderInfo(owner);
  if (!h.holder) return { reply: `Launching from X is for holders of ${HOLDER_MIN.toLocaleString("en-US")} $TROYA (main wallet plus Agent Wallet). Anyone can launch from the Telegram bot or troya.codes.` };
  if (!ask.symbol || !ask.name) return { reply: "Write it like this, with an image attached: @Troyaagent launch Wooden Horse $HORSE (add \"tax 2%\" for a creator tax, \"buy 0.01\" for an initial buy)" };
  const np = nameProblem(ask.name, ask.symbol, { team: admins().includes(lc(owner)) });
  if (np) return { reply: np };
  if (ask.taxBps > MAX_TAX_BPS) return { reply: `The creator tax can be 4% at most. Post again with a lower tax.` };
  if (ask.buyEth > MAX_INITIAL_BUY_ETH) return { reply: `The initial buy can be up to ${MAX_INITIAL_BUY_ETH} ETH. Post again with a smaller buy.` };
  // the image is up to the poster (owner's rule, 17 Nov): no image attached → the coin launches without one
  let logo = "";
  if (mediaUrl) { try { logo = await fetchLogo(mediaUrl); } catch { return { reply: "Troya could not read that image. Post again with a PNG or JPEG under 1 MB." }; } }
  let out;
  try {
    out = await launchWithAgentWallet({ owner, name: ask.name, symbol: ask.symbol, logo, creatorTaxBps: ask.taxBps, twitter: `https://x.com/i/status/${tweetId}`, source: "x", ref: `x:${tweetId}`, buyEth: ask.buyEth });
  } catch (e) { return { reply: String(e.message || "The launch failed.").slice(0, 240) }; }
  if (!out.ok) {
    if (out.why === "no-agent-wallet") return { reply: `Your wallet has no Agent Wallet yet. Create one and add a little ETH on Robinhood Chain: ${DESK()}` };
    const why = (out.reasons || [])[0] || "the launch could not be sent";
    return { reply: `Not launched: ${why}`.slice(0, 260) };
  }
  const ca = out.launch.token, ib = out.launch.initialBuy;
  const buyNote = !ib ? "" : ib.executed ? ` Initial buy of ${ib.eth} ETH done.` : ` Initial buy not sent: ${String(ib.reasons?.[0] || "it was refused").slice(0, 70)}.`;
  const imgNote = logo ? "" : " No image was attached, so the coin has none.";
  return { launch: out.launch, reply: `$${ask.symbol} is live on Pons.${buyNote}${imgNote} CA ${ca} · Gate: ${SITE().replace(/^https?:\/\//, "")}/agent#/gate/${ca} · Buy: fomo.family/tokens/robinhood/${ca}` };
}

/* ---------- the Hippodrome: every coin born through Troya ---------- */
// $TROYA itself opens the Migrated column: the coin the whole desk is built around (launched on Pons, 15 Nov 2026).
const ORIGIN = { token: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074", name: "Troya Agent", symbol: "TROYA", source: "origin", owner: "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4", at: Date.parse("2026-11-15T12:00:00Z") };
export const ALMOST_PCT = 50;                  // a curve at least this full counts as almost bonded
let boardMemo = null;
async function bornRecords() {
  const l = await store.readJson("launches.json", []);
  const seen = new Set(), out = [];
  for (const x of [ORIGIN, ...l.slice().reverse()]) { const k = lc(x.token); if (!x.token || seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
async function boardItem(rec, handles) {
  const m = await import("./market.mjs");
  const d = await m.getRobinhoodToken(rec.token).catch(() => null);
  const t = d?.token || {}, p = d?.pons || null;
  const graduated = !!p?.graduated || (rec.source === "origin" && !p);
  return {
    token: getAddress(rec.token), name: t.name || rec.name || "", symbol: t.symbol || rec.symbol || "", image: t.image || t.logoUri || rec.logo || null,
    source: rec.source, at: rec.at || t.createdAt || null, creator: rec.owner ? getAddress(rec.owner) : null, creatorX: handles[lc(rec.owner)]?.username || null,
    keepsAll: rec.source === "origin" ? null : !rec.split, creatorTaxBps: rec.creatorTaxBps ?? p?.fees?.creatorTaxBps ?? null, initialBuyEth: rec.initialBuy?.executed ? rec.initialBuy.eth : null,
    priceUsd: t.priceUsd ?? null, mcapUsd: t.mcapUsd ?? null, volume24hUsd: t.volume24hUsd ?? null, liquidityUsd: t.liquidityUsd ?? null, holders: t.holders ?? null,
    txns24h: t.txns24h ?? null, buys24h: t.buys24h ?? null, sells24h: t.sells24h ?? null, change1h: t.change1h ?? null, change24h: t.change24h ?? null,
    progressPct: graduated ? 100 : p?.progressPct ?? null, graduated, raisedEth: p?.raised ?? null, ponsUrl: p?.ponsUrl || null,
  };
}
export async function board() {
  if (boardMemo && Date.now() - boardMemo.at < 15_000) return boardMemo.v;
  const recs = (await bornRecords()).slice(0, 90);
  const handles = await store.readJson("x-links.json", {});
  const items = [];
  for (let i = 0; i < recs.length; i += 6) items.push(...(await Promise.all(recs.slice(i, i + 6).map((r) => boardItem(r, handles).catch(() => null)))).filter(Boolean));
  // $TROYA (the genesis coin) always leads Migrated; the rest by market cap
  const migrated = items.filter((x) => x.graduated).sort((a, b) => (b.source === "origin") - (a.source === "origin") || (b.mcapUsd || 0) - (a.mcapUsd || 0));
  const almost = items.filter((x) => !x.graduated && (x.progressPct || 0) >= ALMOST_PCT).sort((a, b) => (b.progressPct || 0) - (a.progressPct || 0));
  const fresh = items.filter((x) => !x.graduated && (x.progressPct || 0) < ALMOST_PCT).sort((a, b) => (b.at || 0) - (a.at || 0));
  const v = { new: fresh, almost, migrated, almostPct: ALMOST_PCT, counts: { born: items.length, graduated: migrated.length }, updatedAt: Date.now() };
  boardMemo = { at: Date.now(), v };
  return v;
}

/* ---------- routes ---------- */
export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/launch/rules", async () => {
    const factory = await splitterFactory();
    return { holderMin: HOLDER_MIN, limits: LIMITS, maxCreatorTaxBps: MAX_TAX_BPS, troyaVolumePct: TROYA_VOLUME_BPS / 100, creatorFeePct: CREATOR_FEE_BPS / 100,
      holderTroyaPct: 0, splitter: factory ? { factory, live: true } : { live: false }, xLaunch: (await xLaunchMode()) === "live",
      text: `Free to launch. Troya takes 0.1% of trading volume out of the creator's 0.7% share of the Pons fee; holders of ${HOLDER_MIN.toLocaleString("en-US")} $TROYA keep all of it. Launch on X is for holders; Telegram and troya.codes are open to everyone. Creator tax 0–4%, ${LIMITS.perDay} launches a day (${LIMITS.perDayHolder} for holders).` };
  });
  r.post("/api/launch/plan", ({ body }) => plan({ owner: body?.creator, creatorTaxBps: body?.creatorTaxBps, name: body?.name, symbol: body?.symbol, source: "web" }), { perMin: 30 });
  r.post("/api/launch/record", async ({ req, body }) => recordWeb({ hash: body?.hash, owner: getSession(req)?.address || body?.creator || null, salt: body?.salt, troyaBps: body?.troyaBps }), { perMin: 20 });
  r.get("/api/launch/mine", async ({ req }) => ({ launches: (await launchesOf(requireSession(req).address)).slice().reverse() }));
  r.get("/api/launch/board", () => board(), { perMin: 120 });
  r.get("/api/launch/born", async () => ({ tokens: (await bornRecords()).map((x) => lc(x.token)) }), { perMin: 120 });
  r.get("/api/launch/prefs", async ({ req }) => {
    const a = requireSession(req).address;
    const x = await import("./xsocial.mjs").then((m) => m.handleOf(a)).catch(() => null);
    const fee = await launchMenu().then((m) => m.launchFeeEth).catch(() => null);
    return { ...(await prefsOf(a)), xAccount: x, holder: await holderInfo(a), holderMin: HOLDER_MIN, xLaunch: await xLaunchOn(), xLaunchMode: await xLaunchMode(), launchFeeEth: fee,
      limits: LIMITS, admin: isAdmin(req), factory: await splitterFactory() };
  });
  r.post("/api/launch/prefs", async ({ req, body }) => {
    const a = lc(requireSession(req).address);
    const x = !!body?.x;
    await store.update("launch-prefs.json", {}, (m) => { m[a] = { ...(m[a] || {}), x, at: Date.now() }; return m; });
    return { ok: true, x };
  }, { perMin: 20 });
  r.get("/api/launch/splitter", async () => {
    const b = await buildInfo();
    const s = await store.readJson("fee-splitter.json", {});
    return { factory: s.factory || null, deployTx: s.deployTx || null, escrow: PONS_ESCROW, abi: b.abi, bytecode: b.bytecode, compiler: b.compiler, source: b.source };
  });
  r.post("/api/launch/splitter/register", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    if (await splitterFactory()) throw new HttpError(409, "The fee splitter factory is already registered.");
    const hash = String(body?.hash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new HttpError(400, "Bad transaction hash.");
    const [tx, rc] = await Promise.all([rpc("robinhood", "eth_getTransactionByHash", [hash]), rpc("robinhood", "eth_getTransactionReceipt", [hash])]);
    if (!tx || !rc) throw new HttpError(404, "That transaction is not on Robinhood Chain yet.");
    if (!admins().includes(lc(tx.from))) throw new HttpError(403, "The factory must be deployed by an admin wallet.");
    if (tx.to || !rc.contractAddress || Number(rc.status) !== 1) throw new HttpError(400, "That is not a successful contract deployment.");
    const b = await buildInfo();
    if (!lc(tx.input).startsWith(lc(b.bytecode))) throw new HttpError(400, "That deployment is not the tested TroyaFeeSplitterFactory build.");
    const [escrow, treasury, owner] = AbiCoder.defaultAbiCoder().decode(["address", "address", "address"], "0x" + tx.input.slice(b.bytecode.length));
    if (lc(escrow) !== lc(PONS_ESCROW)) throw new HttpError(400, "That factory does not use the Pons fee escrow.");
    const factory = getAddress(rc.contractAddress);
    await store.writeJson("fee-splitter.json", { factory, treasury: getAddress(treasury), owner: getAddress(owner), deployTx: hash, deployedBy: getAddress(tx.from), block: Number(BigInt(rc.blockNumber)), at: Date.now() });
    return { ok: true, factory, treasury: getAddress(treasury) };
  });
}
