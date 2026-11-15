// Phase 3 · holder perks for $TROYA.
//   HOLDER_MIN     tokens needed (default 1,000,000 = 0.1% of supply), counted across the signed-in wallet and its Agent Wallet
//   HOLDER_START   ISO time the perks switch on (announced first, as the roadmap says); unset = on
// Perks: more assistant messages a day, more active playbooks, and a private Telegram DM for every coin Troya Sentry posts.
// Balances are read from chain and cached for 10 minutes. Nothing here moves tokens or asks anyone to.
import { readFileSync } from "node:fs";
import { getBalances } from "./robinhood.mjs";
import { requireSession } from "./auth.mjs";

const MIN = Number(process.env.HOLDER_MIN || 1_000_000);
const START = process.env.HOLDER_START ? Date.parse(process.env.HOLDER_START) : 0;
export const PERKS = { messagesPerDay: Number(process.env.HOLDER_MESSAGES || 200), playbooks: Number(process.env.HOLDER_PLAYBOOKS || 100), sentryDm: true };
const TTL = 10 * 60_000;
const memo = new Map();
let store;

function troyaCa() {
  if (process.env.TROYA_CA) return process.env.TROYA_CA;
  try { return (readFileSync(new URL("../public/config.js", import.meta.url), "utf8").match(/\bca:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1] || ""; } catch { return ""; }
}
export const perksOn = () => !!troyaCa() && Date.now() >= START;

async function agentAddress(owner) {
  try { const m = await import("./agentwallet.mjs"); return (await m.getAgentWallet(owner))?.address || null; } catch { return null; }
}
// { holder, balance, min, on, start } for one owner address
export async function holderOf(owner) {
  const ca = troyaCa(), k = String(owner || "").toLowerCase();
  if (!ca || !/^0x[0-9a-f]{40}$/.test(k)) return { holder: false, balance: 0, min: MIN, on: perksOn(), start: START || null };
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.v, on: perksOn() };
  const addrs = [k, await agentAddress(k)].filter(Boolean);
  let balance = 0;
  for (const a of addrs) {
    const b = await getBalances(a, [ca]).catch(() => null);
    const t = b?.balances?.find((x) => x.address !== "native" && x.address.toLowerCase() === ca.toLowerCase());
    if (t) balance += Number(t.amount);
  }
  const v = { holder: balance >= MIN, balance, min: MIN, start: START || null };
  memo.set(k, { at: Date.now(), v });
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return { ...v, on: perksOn() };
}
// perks apply only when switched on and the wallet holds enough
export async function hasPerks(owner) { if (!perksOn()) return false; return (await holderOf(owner)).holder; }

// Telegram chats of linked wallets that hold enough (for Sentry DMs)
export async function holderChats() {
  if (!perksOn() || !store) return [];
  const t = await store.readJson("telegram.json", { links: {} });
  const out = [];
  for (const [addr, chat] of Object.entries(t.links || {})) if (await hasPerks(addr).catch(() => false)) out.push(chat);
  return out;
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/holder", async ({ req }) => {
    const s = requireSession(req);
    const h = await holderOf(s.address);
    return { ...h, perks: PERKS, ca: troyaCa() };
  });
  r.get("/api/holder/terms", () => ({ min: MIN, start: START ? new Date(START).toISOString() : null, on: perksOn(), perks: PERKS, counted: "your signed-in wallet plus its Agent Wallet", ca: troyaCa() }));
}
