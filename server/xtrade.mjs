// V6 F29 · Trade on X: buy or sell a coin by posting to @Troyaagent; the poster's Agent Wallet trades through Troya Gate.
//   @Troyaagent buy 0.01 $TICKER          @Troyaagent buy 0.01 ETH of 0x…          @Troyaagent buy $TICKER for 0.01 ETH
//   @Troyaagent sell 50% $TICKER          @Troyaagent sell all 0x…                 @Troyaagent sell half of $TICKER
// Rules (owner, 18 Nov): everyone may buy and sell $TROYA from X, a way in to holding it; holders of 1,000,000 $TROYA
// may trade any coin. "$TROYA" always means the official contract (copies share the ticker).
//   · mode in x-state.json "trade": off / test (admin wallets) / holders (1,000,000 $TROYA only) / live (the rule above)
//   · the X account is linked to a wallet, "Trade from X" is switched on for it, and it has an Agent Wallet
//   · every trade is a normal Agent Wallet swap: Troya Gate, the wallet's caps, its policy and kill switch
//   · buys from 0.0005 to MAX_BUY_ETH a post; a $TICKER several coins share is refused (post the address);
//     one trade per post, PER_DAY trades a day per wallet
// Only plain commands count (the post starts with buy or sell, no question mark), so "should I buy $X?" is never a trade.
// Replies are fixed texts, never the model, and every refusal says what to do. The sale's ETH stays in the Agent Wallet.
import { isAddress, getAddress, Interface } from "ethers";

export const MAX_BUY_ETH = Number(process.env.X_TRADE_MAX_ETH || 0.5);
export const MIN_BUY_ETH = 0.0005;
export const TROYA_CA = String(process.env.TROYA_CA || "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074").toLowerCase();
export const PER_DAY = 30;
let store = null;

const lc = (s) => String(s || "").toLowerCase();
const SITE = () => (process.env.SITE_URL || "https://troya.codes").replace(/\/+$/, "").replace(/^https?:\/\//, "");
const DESK = () => `${SITE()}/agent#/launch/x`;
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const erc = new Interface(["function balanceOf(address) view returns (uint256)"]);

/* ---------- reading the post ---------- */
const TOKEN = String.raw`(\$[A-Za-z][A-Za-z0-9]{0,15}|0x[0-9a-fA-F]{40})`;
const NUM = String.raw`(\d*\.?\d+)`;
const BUY_A = new RegExp(String.raw`^buy\s+${NUM}\s*(?:eth\s+)?(?:(?:worth\s+)?of\s+)?${TOKEN}(?![A-Za-z0-9])`, "i");
const BUY_B = new RegExp(String.raw`^buy\s+${TOKEN}\s+(?:for\s+|with\s+)?${NUM}\s*eth\b`, "i");
const SELL_A = new RegExp(String.raw`^sell\s+(?:(\d{1,3}(?:\.\d+)?)\s*%|(all|everything|half))\s+(?:of\s+)?(?:my\s+)?${TOKEN}(?![A-Za-z0-9])`, "i");
const SELL_B = new RegExp(String.raw`^sell\s+(?:my\s+)?${TOKEN}\s+(?:(\d{1,3}(?:\.\d+)?)\s*%|(all|everything|half))(?![A-Za-z0-9])`, "i");
const plainOf = (text) => {
  let s = String(text || "").replace(/(^|\s)@\w+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) s = s.replace(/^(?:hey|hi|yo|gm|ok|okay|please|pls|troya)\b[\s,!.:-]*/i, "");
  return s;
};
/** A trade command, or { unclear: true } when the post starts with buy/sell but can't be read for sure, or null. */
export function parseTrade(text) {
  const s = plainOf(text);
  if (!/^(buy|sell)\b/i.test(s) || s.includes("?")) return null;
  let m;
  if ((m = BUY_A.exec(s))) return { side: "buy", eth: Number(m[1]), token: m[2] };
  if ((m = BUY_B.exec(s))) return { side: "buy", eth: Number(m[2]), token: m[1] };
  const pctOf = (n, w) => (n != null ? Number(n) : /half/i.test(w) ? 50 : 100);
  if ((m = SELL_A.exec(s))) return { side: "sell", pct: pctOf(m[1], m[2]), token: m[3] };
  if ((m = SELL_B.exec(s))) return { side: "sell", pct: pctOf(m[2], m[3]), token: m[1] };
  return { unclear: true };
}

/* ---------- who may trade ---------- */
export const tradeMode = async () => { const v = (await store.readJson("x-state.json", {})).trade || process.env.X_TRADE || "off"; return ["off", "test", "holders", "live"].includes(v) ? v : "off"; };
async function linkedOwner(authorId) {
  const m = await store.readJson("x-links.json", {});
  for (const [addr, v] of Object.entries(m)) if (String(v.id) === String(authorId)) return getAddress(addr);
  return null;
}
async function isHolder(owner) {
  try { const h = await import("./holders.mjs"); const L = await import("./launch.mjs"); return (await h.holderOf(owner)).balance >= L.HOLDER_MIN; } catch { return null; }
}
const tradeOn = async (owner) => !!(await store.readJson("launch-prefs.json", {}))[lc(owner)]?.trade;
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const ethTxt = (n) => (n >= 0.01 ? n.toFixed(4) : n.toPrecision(3)).replace(/\.?0+$/, "");

/** what to do about a refused trade, from the first reason the Agent Wallet gave */
function fixFor(why) {
  const w = String(why);
  if (/kill switch|paused/i.test(w)) return "turn your kill switch off in the app, then post again";
  if (/cap|daily|per trade|limit/i.test(w)) return "raise your Agent Wallet caps, or post a smaller amount";
  if (/balance|insufficient|not enough|funds/i.test(w)) return "top up your Agent Wallet with ETH on Robinhood Chain";
  if (/honeypot|blacklist|mint|tax|owner|liquidity|pool depth|impact|gate|risk/i.test(w)) return `Troya Gate refused this coin; see why: ${SITE()}/agent#/gate`;
  if (/route|quote/i.test(w)) return "try again in a minute, or trade it in the app";
  return "check your setup, then post again";
}
const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/[\s,;:(]+\S*$/, "") + "…" : s);
const notTraded = (why, fix, spent = true) => `Not traded: ${cut(String(why).replace(/\.$/, ""), 120)}. To fix: ${fix}.${spent ? " Nothing was spent." : ""}`.slice(0, 275);

/**
 * A mention that asks for a trade. Returns null when the post is not a trade command, else { reply } and, when a trade
 * went through, { trade }.
 */
export async function fromX({ tweetId, authorId, text }) {
  const ask = parseTrade(text);
  if (!ask) return null;
  const ref = `x:${tweetId}`;
  if ((await store.readJson("x-trades.json", [])).some((x) => x.ref === ref)) return { reply: null };
  const mode = await tradeMode();
  const notYet = { reply: `Not traded: Trade on X isn't open yet, it's in its real-money test. To fix: nothing to do yet; switch it on now and it works the day it opens: ${DESK()}` };
  if (mode === "off") return notYet;
  const owner = await linkedOwner(authorId);
  if (mode === "test" && !(owner && admins().includes(lc(owner)))) return notYet;
  const ob = await import("./onboard.mjs"); ob.init(store);
  if (!owner) return { reply: `Not traded yet. ${ob.gapsLine(["connect your wallet and link this X account", "switch Trade from X on", "add a little ETH to your Agent Wallet"], "trade-x")}. Then post again. Nothing was spent.` };
  {
    const gaps = await ob.gapsFor(owner, "trade-x", { needEth: ask.side === "buy" && Number(ask.eth) >= MIN_BUY_ETH && Number(ask.eth) <= MAX_BUY_ETH ? Number(ask.eth) + 0.0002 : 0.0002 }).catch(() => []);
    if (gaps.length) return { reply: `Not traded yet. ${ob.gapsLine(gaps, "trade-x")}. Then post again. Nothing was spent.` };
  }
  if (!(await tradeOn(owner))) return { reply: `Not traded yet. ${ob.gapsLine(["switch Trade from X on"], "trade-x")}. Then post again. Nothing was spent.` };
  if (mode === "holders") {
    const hd = await isHolder(owner);
    if (hd === null) return { reply: notTraded("Troya couldn't read your $TROYA balance just now", "post again in a minute") };
    if (!hd) return { reply: notTraded("Trade on X is open to holders of 1M TROYA first", `hold 1M across your wallet and Agent Wallet, or trade in the app: ${SITE()}/agent#/swap`) };
  }
  if (ask.unclear) return { reply: "Not traded: Troya couldn't read the trade for sure. To fix: post it like this: @Troyaagent buy 0.01 $TICKER, or @Troyaagent sell 50% $TICKER (a contract address works too). Nothing was spent." };
  const aw = await import("./agentwallet.mjs");
  const w = await aw.getAgentWallet(owner);
  if (!w?.exists) return { reply: notTraded("your wallet has no Agent Wallet yet", `create one and add a little ETH on Robinhood Chain: ${SITE()}/agent#/agent/wallet`) };
  const today = (await store.readJson("x-trades.json", [])).filter((x) => lc(x.owner) === lc(owner) && x.executed && dayOf(x.at) === dayOf(Date.now())).length;
  if (today >= PER_DAY) return { reply: notTraded(`that is ${PER_DAY} trades from X today, the most for one wallet`, "trade in the app, or post again tomorrow (UTC)") };

  // the coin: a contract address, or a ticker only one coin uses
  const tools = await import("./tools.mjs");
  const isTroya = /^\$troya$/i.test(ask.token);
  const isCa = isAddress(ask.token) || isTroya;
  const t = await tools.resolveToken(isTroya ? TROYA_CA : ask.token).catch(() => null);
  if (!t || t.native) return { reply: notTraded(`Troya couldn't find ${isCa ? "that contract" : ask.token} on Robinhood Chain`, "post the coin's contract address") };
  if (!isCa && (t.sameSymbol || 1) > 1) return { reply: notTraded(`${t.sameSymbol} coins use ${ask.token}`, "post the coin's contract address instead of the ticker") };
  if (!isCa && lc(t.symbol) !== lc(ask.token.replace(/^\$/, ""))) return { reply: notTraded(`Troya found no coin called ${ask.token}`, "post the coin's contract address") };
  const ca = getAddress(t.address);
  // live: without 1M $TROYA, Trade on X is for $TROYA itself; any other coin needs 1M (or the app)
  if (mode === "live" && lc(ca) !== TROYA_CA) {
    const hd = await isHolder(owner);
    if (hd === null) return { reply: notTraded("Troya couldn't read your TROYA balance just now", "post again in a minute") };
    if (!hd) return { reply: notTraded("without 1M TROYA, Trade on X is for TROYA itself", `hold 1M TROYA (wallet plus Agent Wallet) to trade any coin from X, or trade this one on troya.codes: ${SITE()}/agent#/swap?out=${lc(ca)}`) };
  }
  const { tokenMeta, rpc } = await import("./robinhood.mjs");
  const meta = await tokenMeta(ca).catch(() => ({ symbol: t.symbol, decimals: 18 }));
  const sym = String(meta.symbol || t.symbol || "coin").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "coin";
  const dec = Number(meta.decimals ?? 18);

  let params, amountTxt;
  if (ask.side === "buy") {
    if (!(ask.eth >= MIN_BUY_ETH)) return { reply: notTraded(`a buy from X starts at ${MIN_BUY_ETH} ETH`, "post a bigger amount") };
    if (ask.eth > MAX_BUY_ETH) return { reply: notTraded(`a buy from X can be up to ${MAX_BUY_ETH} ETH`, "post a smaller amount, or trade in the app") };
    params = { tokenIn: "ETH", tokenOut: ca, amountIn: ask.eth, slippagePct: 5 };
    amountTxt = `${ask.eth} ETH`;
  } else {
    if (!(ask.pct > 0 && ask.pct <= 100)) return { reply: notTraded("the share to sell goes from 1% to 100%", "post e.g. sell 50%") };
    const res = await rpc("robinhood", "eth_call", [{ to: ca, data: erc.encodeFunctionData("balanceOf", [w.address]) }, "latest"]).catch(() => null);
    const raw = res && res !== "0x" ? BigInt(res) : 0n;
    const held = Number(raw) / 10 ** dec;
    if (!(held > 0)) return { reply: notTraded(`your Agent Wallet holds no $${sym}`, "buy it first, or check the coin's address") };
    const amount = ask.pct >= 100 ? Math.floor(held * 1e6) / 1e6 : Math.floor(held * ask.pct * 1e4) / 1e6;
    if (!(amount > 0)) return { reply: notTraded(`that share of your $${sym} is too small to sell`, "sell a bigger share") };
    params = { tokenIn: ca, tokenOut: "ETH", amountIn: amount, slippagePct: 5 };
    amountTxt = `${ask.pct}%`;
  }
  // the expected amount, for the reply (the Agent Wallet quotes and checks again when it sends)
  const q = await tools.quoteSwap({ tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, slippagePct: 5 }).catch(() => null);
  const rec = { ref, owner, authorId: String(authorId), side: ask.side, token: ca, symbol: sym, amount: params.amountIn, pct: ask.pct || null, eth: ask.eth || null, at: Date.now(), executed: false };
  let out;
  try {
    out = await aw.executeForUser(owner, { kind: "swap", source: "x", rationale: `Trade on X (${ref}): ${ask.side} ${amountTxt} of $${sym}`, params });
  } catch (e) {
    await addTrade({ ...rec, why: String(e.message || e).slice(0, 200) });
    return { reply: notTraded(e.message || "the trade could not be sent", fixFor(e.message)) };
  }
  if (!out.executed) {
    const why = (out.reasons || [])[0] || "the trade could not be sent";
    await addTrade({ ...rec, why: String(why).slice(0, 200) });
    return { reply: notTraded(why, fixFor(why)) };
  }
  const steps = out.result?.steps || [];
  const done = { ...rec, executed: true, hash: steps[steps.length - 1]?.hash || null, expectedOut: q?.amountOut ?? null };
  await addTrade(done);
  const link = `${SITE()}/agent#/token/${lc(ca)}`;
  const reply = ask.side === "buy"
    ? `Bought ${q?.amountOut ? `~${fmt(q.amountOut)} ` : ""}$${sym} for ${ask.eth} ETH from your Agent Wallet, through Troya Gate. ${link}`
    : `Sold ${ask.pct}% of your $${sym}${q?.amountOut ? ` for ~${ethTxt(q.amountOut)} ETH` : ""}; the ETH stays in your Agent Wallet. ${link}`;
  return { reply, trade: done };
}
async function addTrade(r) { await store.update("x-trades.json", [], (l) => [...l, r].slice(-5000)); }

export async function register(r, ctx) {
  store = ctx.store;
  const { getSession } = await import("./auth.mjs");
  const { HttpError } = await import("./api.mjs");
  const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
  r.post("/api/x/trade", async ({ req, body }) => {
    if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
    const v = String(body?.trade || "");
    if (!["off", "test", "holders", "live"].includes(v)) throw new HttpError(400, "Trade on X must be off, test, holders or live.");
    await store.update("x-state.json", {}, (s) => ({ ...s, trade: v, tradeBy: getSession(req).address, tradeAt: Date.now() }));
    return { ok: true, trade: v };
  });
  r.get("/api/x/trades/mine", async ({ req }) => {
    const s = getSession(req);
    if (!s) throw new HttpError(401, "Sign in first.");
    return { trades: (await store.readJson("x-trades.json", [])).filter((x) => lc(x.owner) === lc(s.address)).slice(-50).reverse() };
  });
}
