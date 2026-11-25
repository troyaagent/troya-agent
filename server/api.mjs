// API router. Every module in MODULES exports `register(r, ctx)` and adds routes with r.get / r.post / r.del.
// Routes are served under /api/* and mirrored under /agent/api/* (the public REST base).
import { initStore } from "./store.mjs";
import { interactive } from "./kyber.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

// Set while an API call is being served: robinhood.mjs reads it to put a person's RPC reads ahead of background scans on
// the rate-limited official Robinhood Chain RPC (its broker's user lane).
export const requestLane = new AsyncLocalStorage();

const MODULES = [
  "./market.mjs",      // Robinhood Chain board (GeckoTerminal + Pons), tokenized stocks, Hyperliquid markets, brief, signals
  "./hl.mjs",          // Hyperliquid info proxy + exchange signing helpers
  "./robinhood.mjs",   // Robinhood Chain RPC relay, Pons + Uniswap swaps, Troya Gate, Pons launch, LI.FI bridge
  "./auth.mjs",        // wallet sign-in (nonce + signature → session cookie)
  "./policy.mjs",      // policy.json limits, per-user limits, pause + kill switch
  "./journal.mjs",     // audit journal (every action + rationale)
  "./agentwallet.mjs", // optional custodial Agent Wallet (encrypted at rest)
  "./watches.mjs",     // playbooks: server watches checked every 20 s
  "./tools.mjs",       // tool registry shared by the assistant, MCP and REST
  "./assistant.mjs",   // chat assistant (intent engine + optional LLM)
  "./apitokens.mjs",   // API tokens for MCP / REST execution
  "./inbox.mjs",       // inbox, notifications, proposals, settings, memory
  "./sentry.mjs",      // Troya Sentry: every new Pons launch through the Gate → Telegram channel + daily recap
  "./buybot.mjs",      // buy tracker: every $TROYA buy (Pons curve + Uniswap v4 ETH pools) → the Telegram group
  "./badge.mjs",       // Phase 4: live Troya Gate badge (SVG + JSON) for Pons devs to embed
  "./holders.mjs",     // Phase 3: $TROYA holder perks (more messages, more playbooks, Sentry DMs)
  "./brief.mjs",       // Phase 6: daily AI brief + smart alerts (Telegram DM and the web)
  "./autopilot.mjs",   // Phase 7: Sentry Autopilot (practice mode with play money; live through the Agent Wallet)
  "./onboard.mjs",     // Phase 8: 60-second start (setup status) · Phase 9: leaderboard + copy rules
  "./proof.mjs",       // proof for checkers: the test wallet's Hyperliquid fills as JSON
  "./record.mjs",      // F13: the Oracle's ledger, every Sentry call graded in public
  "./oracle.mjs",      // F21: the chart oracle, a chart note per coin every 6 hours, graded 24 hours later
  "./assay.mjs",       // F14: The Assay, dev, holders, bundles, clusters, wash trades and funders of a coin
  "./stocks.mjs",      // F17: Stock desk, multipliers, dividends and splits, Morpho loans against stock tokens
  "./liquidity.mjs",   // F18: Liquidity desk, Uniswap v3 ranges from volatility, positions, fees
  "./flywheel.mjs",    // F19: $TROYA flywheel, creator fees into buyback, burn and locked liquidity, read from the chain
  "./xsocial.mjs",     // F20: Sign in with X, Troya answering on X (draft first), one daily X budget
  "./votes.mjs",       // F20: the Troya Holder Pass (soulbound NFT) and pass votes signed with EIP-712
  "./agents.mjs",      // F20: agent factory, named agents built from playbooks, each with a public page
  "./flywheel-auto.mjs", // F19+: the flywheel run by the server with the creator key (admin opt-in, rails in the module)
  "./gas.mjs",         // Troya pays gas: the weekly drip for holders and Agent Wallet gas refunds, from a sponsor wallet
  "./gateapi.mjs",     // F23: Gate for every agent, a fresh signed Gate check as an API, paid per check in USDG
  "./ringradar.mjs",   // V7 F31 Ring Radar: Pons launch forensics (snipe-tax exemptions, bundle buys, reused bundlers, decoys)
  "./watchfire.mjs",   // V8 F39 Watchfire: keeps watching coins after launch (gathering, whale exits, sell velocity, herds)
  "./tribute.mjs",     // V8 F40 Tribute: is a coin's revenue, rewards or market cap real (creator-paid income, unbacked market cap, scripted volume)
  "./allies.mjs",      // V8 F45 Allies: an agent wallet's record (ERC-8004 identity + reputation, registry, Seal, Arena, launches + Gate)
  "./mcp.mjs",         // V8 F45 Skills: remote MCP endpoint (POST /api/mcp, also /mcp), read-only tools from the registry
  "./treasury.mjs",    // V8 F46 Treasury: holder tiers, Watchfire pins, Gate checks a day by tier
  "./champions.mjs",   // V8 F43 Champions: follow a proven Arena trader into your own capped Agent Wallet
  "./callouts.mjs",    // V8 F41 War Table: callouts stamped at the price of the moment, graded at 24 h; X posts that mention a coin
  "./herald.mjs",      // V8 F42 Herald: referral links, the weekly Arena Cup and the contributor board (share cards are drawn in the browser)
  "./payouts.mjs",     // V8 F42: Herald payouts, weekly and automatic (Cup prizes + referral rewards, capped)
  "./prizes.mjs",      // weekly prize pool (22 Nov 2026): 0.1% of $TROYA volume to the 10 most active traders, paid Mondays after Herald
  "./stats.mjs",       // public usage numbers (community request 21 Nov): GET /api/stats, page /stats
  "./xtracker.mjs",    // V8 F41 X Tracker: tracked X accounts ride on the filtered stream; a posted contract gets the Gate and a ping
  "./antround.mjs",    // Arena: Anthropic Round, the five AI traders on xyz:ANT (paper; live with ANT_ROUND_LIVE=1)
  "./fates.mjs",       // V9 F52 Two Fates (part 1): passed vs blocked launches graded on the same clock, GET /api/fates
  "./patroclus.mjs",   // V9 F54 Patroclus: the Heel card as an embeddable SVG image (GET /api/heelcard/:address.svg) and its embed kit
  "./phoenix.mjs",     // V9 F57 Phoenix: lessons from every closed Arena trade and graded call, pattern stats, bot corrections (shadow unless PHOENIX_INJECT=1)
  "./seal.mjs",
  "./quantum.mjs",
  "./oath.mjs",        // V7 F32 Oath (tier 1, watched): signed dev pledges shown live as kept or broken, with the breaking txs
  "./aegis.mjs",       // V7 F31 Aegis: a guard on every coin a user holds (dev and whale sells, sell test, tax, Oath), alerts and exit tickets
  "./radar.mjs",       // V7 F37 Robinhood Radar: stock tokens against the real share (gap, session, weekend pricing)
  "./smartmoney.mjs",  // V7 F37 Robinhood Radar: smart wallets scored on The Record's graded calls
  "./owl.mjs",         // V7 F35 Owl: your trading week from the chain, with plain coaching, sealed
  "./verdictfeed.mjs", // V7 F38 Gate in your wallet: signed verdict feed and the transaction check behind the Troya Snap
  "./arena.mjs",       // V7 F34 Arena: plain-words strategies replayed on The Record, 7 days on paper, and AI traders side by side
  "./infrawatch.mjs",  // owner alerts on Telegram: Chainstack quota, Blockscout pause, OpenRouter credits, server memory and disk
  "./council.mjs",     // V7 F33 Council: three reasons not to buy + a bull/bear/risk debate on Troya's own facts, sealed     // V7 F36 Quantum-Ready: key exposure for wallets and tokens, NIST + drand randomness        // V7 F35 Seal: signed, hash-chained receipts (ECDSA + ML-DSA) for every Troya decision, anchored daily on Robinhood Chain
  "./x402.mjs",        // F23+: the same Gate check over x402 v2, $0.01 USDC on Base per call, listed in x402 directories (off until X402_ENABLED=1)
  "./portfolio.mjs",   // every token a wallet holds (Blockscout), priced, with PnL from its own trades
  "./registry.mjs",    // F24: agent registry, agents file signed calls on Robinhood Chain coins and earn a public reputation
  "./rail.mjs",        // F25: the audited rail, limits/allowlist/kill switch for agents trading through Robinhood's agentic MCP
  "./launch.mjs",      // V6 Hermes: launching through Troya (X, Telegram, web), the fee rule and the TroyaFeeSplitter
  "./launch-xpost.mjs", // every coin born through Troya gets one post on @Troyaagent (quotes the launch post; skips team tests and Gate fails)
  "./projectcheck.mjs", // Project check on Create coin: a score for the project (site, its code, X, claims) with proof the links are the creator's
  "./xtrade.mjs",      // V6 F29: Trade on X (buy/sell by posting to @Troyaagent, from the Agent Wallet)
  "./trust.mjs",       // Safety page: live proof Troya is still being built (public commits, launches, burns, Sentry)
  "./community.mjs",   // community inbox: bug reports, ideas and suspicious-activity flags (web + Telegram), admins only
  "./icons.mjs",       // token + coin logos, fetched once and cached on disk
  "./tokenage.mjs",    // token age: when a coin was born (its creation block), cached for good (community request, 20 Nov)
  "./pulse.mjs",       // Desk pulse (community request, 21 Nov): coins that passed Sentry, coins that just graduated (read from the chain)
  "./chat.mjs",        // community chat in the app (community request, 21 Nov): public to read, wallet sign-in to post, same guard as the TG group
  "./profile.mjs",     // profiles (community request, 21 Nov): username, bio, avatar, banner per wallet; shown on Portfolio, #/u/<name> and in the chat
  "./stake.mjs",       // $TROYA staking (21 Nov): tiers from TroyaStake on chain and the perks behind them; read-only, off until a contract is set
  "./feesplit.mjs",    // $TROYA fee split (21 Nov): creator fees split by the hourly market cap (stakers, burn, owner); sent weekly by payouts.mjs (STAKE_REWARDS)
  "./atlas.mjs",       // V9 F49 Swift: one buy box, every venue Troya reaches quoted at once (Troya Atlas), ranked after fees and gas
  "./heel.mjs",        // V9 F47 Heel: paste a coin, dev or agent → its one weak spot in a sentence, with on-chain evidence and a Guard
  "./chiron.mjs",      // V9 F48 Chiron: paste a trader wallet → the one habit that costs it most, from its own swaps; one tap makes it a rule the Agent Wallet enforces
  "./clusters.mjs",    // Cluster map (community request, 24 Nov): a coin's 50 largest holders and which are linked (dev side, shared funders, transfers, bundles), each link with its proof
  "./activity.mjs",    // activity feed (22 Nov): real launches, stakers, agents, Gate use, graduations, payouts → the Telegram group + an X digest (ACTIVITY_FEED / ACTIVITY_X, dry by default)
];

const routes = [];
const ctx = {};
// A person is waiting on these answers (the Swap page and the app's quote, Gate and build calls, on Robinhood Chain, Base,
// Arbitrum and Solana through ?chain=, and the cross-chain buy, which runs the destination chain's Gate), so their
// KyberSwap calls take the priority lane: served before Sentry, Arena, Autopilot, Aegis and Gate API background work, and
// failing fast to a fallback route instead of queueing behind it (kyber.mjs).
const INTERACTIVE = new Set(["GET /api/swap/quote", "GET /api/swap/gate", "POST /api/swap/build", "GET /api/bridge/cross-buy", "GET /api/atlas/quote"]);

const r = {
  get: (path, fn, opts) => routes.push({ method: "GET", ...compile(path), fn, opts: opts || {} }),
  post: (path, fn, opts) => routes.push({ method: "POST", ...compile(path), fn, opts: opts || {} }),
  del: (path, fn, opts) => routes.push({ method: "DELETE", ...compile(path), fn, opts: opts || {} }),
};

function compile(path) {
  const keys = [];
  const re = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  return { path, re, keys };
}

// ---- tiny rate limiter (per IP, per minute, weighted) ----
const buckets = new Map();
// one bucket per IP and route, so a strict route (e.g. sendRawTransaction) is not drained by ordinary page traffic;
// plus a global per-IP ceiling across all routes
function limited(ip, route, weight = 1, perMin = 240) {
  return hit(`${ip}|${route}`, weight, perMin) || hit(`${ip}|*`, weight, GLOBAL_PER_MIN);
}
const GLOBAL_PER_MIN = +(process.env.RATE_GLOBAL_PER_MIN || 1800);
function hit(key, weight, perMin) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; buckets.set(key, b); }
  b.n += weight;
  if (buckets.size > 20000) for (const [k, v] of buckets) if (now - v.t > 60_000) buckets.delete(k);
  return b.n > perMin;
}

export function ipOf(req) {
  return (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

export async function readBody(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks);
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw.toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
  }
  return raw;
}

export function send(res, status, body, extra = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isBuf ? "application/octet-stream" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export async function initApi({ dataDir, root }) {
  ctx.dataDir = dataDir;
  ctx.root = root;
  ctx.store = await initStore(dataDir);
  for (const m of MODULES) {
    try {
      const mod = await import(m);
      if (typeof mod.register === "function") await mod.register(r, ctx);
    } catch (e) {
      console.error(`[api] module ${m} failed to load:`, e.message);
    }
  }
  r.get("/api/health", () => ({ ok: true, name: "troya-agent", time: Date.now(), modules: MODULES.length }));
}

export async function handleApi(req, res, url) {
  let p = url.pathname;
  if (p.startsWith("/agent/api/")) p = p.slice("/agent".length);
  if (!p.startsWith("/api/")) return false;
  const ip = ipOf(req);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const hit = routes.find((x) => x.method === method && x.re.test(p));
  if (!hit) {
    const other = routes.some((x) => x.re.test(p));
    send(res, other ? 405 : 404, { error: other ? "Method not allowed" : "Not found" });
    return true;
  }
  if (limited(ip, `${hit.method} ${hit.path}`, hit.opts.weight || 1, hit.opts.perMin || 600)) { send(res, 429, { error: "Too many requests, slow down." }); return true; }
  const m = hit.re.exec(p);
  const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const body = method === "POST" || method === "DELETE" ? await readBody(req, hit.opts.maxBody) : {};
    const run = () => hit.fn({ req, res, url, params, query: Object.fromEntries(url.searchParams), body, ip, ctx });
    const out = await requestLane.run({ at: Date.now() }, () => (INTERACTIVE.has(`${hit.method} ${hit.path}`) ? interactive(run) : run()));
    if (out === undefined) { if (!res.writableEnded) send(res, 204, {}); }
    else if (!res.headersSent) send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[api] ${method} ${p}:`, e);
    send(res, status, { error: status >= 500 && !e.expose ? "Something went wrong on our side." : e.message, ...(e.extra || {}) });
  }
  return true;
}
