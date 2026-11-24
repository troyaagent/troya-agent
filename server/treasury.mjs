// V8 F46 Treasury: clear holder tiers for $TROYA and what each one unlocks, read from the same balance the perks use
// (the signed-in wallet plus its Agent Wallet, server/holders.mjs). Unlocks that work today:
//   · Watchfire pins: coins you pin are watched live by Watchfire and every fire on them reaches your inbox and Telegram
//   · Gate checks a day through the Gate API (server/gateapi.mjs reads gateFreeFor)
//   · the existing 1M perks (assistant messages, playbooks, Sentry DMs, launches without limits, the whole creator fee)
//   · King's Guard: the earliest Sentry calls (60 s ahead, guardChats below) and the King's Guard badge (profile, chat)
// Pro plans paid in $TROYA or a stablecoin are listed with their prices only once the owner sets them (TREASURY_PRO).
//   GET  /api/treasury             the tiers, and yours when signed in
//   GET  /api/treasury/pins        your pinned coins (session)       POST /api/treasury/pins { token, on }   (session)
import { getAddress, isAddress } from "ethers";
import { requireSession, getSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "treasury.json";
const HOLDER_MIN = Number(process.env.HOLDER_MIN || 1_000_000);
export const TIERS = [
  { key: "free", name: "Visitor", min: 0, pins: 1, gateX: 1 },
  { key: "scout", name: "Scout", min: 100_000, pins: 3, gateX: 2 },
  { key: "soldier", name: "Soldier", min: HOLDER_MIN, pins: 10, gateX: 0, perks: true },        // gateX 0 = the holder quota
  { key: "captain", name: "Captain", min: 10_000_000, pins: 30, gateX: 3, perks: true },
  { key: "guard", name: "King's Guard", min: 50_000_000, pins: 100, gateX: 10, perks: true, sentryLeadSec: 60, badge: "guard",
    extras: ["earliest Sentry calls (60 s ahead): a Telegram DM 60 seconds before the public Sentry channel, for a linked Telegram", "King's Guard badge on your Troya profile and in the community chat"] },
];
// King's Guard (owner, 24 Nov 2026): the top tier gets each Sentry channel post by private message 60 s before the channel
// (server/sentry.mjs takes the higher of this and a staking tier's lead), and a badge on the profile and in the chat.
export const GUARD = TIERS.find((t) => t.key === "guard");
export const isGuardBalance = (balance) => Number(balance) >= GUARD.min;
const lc = (s) => String(s || "").toLowerCase();
let store = null;

export async function tierOf(address) {
  if (!isAddress(String(address || ""))) return { tier: TIERS[0], balance: 0, known: false };
  const h = await import("./holders.mjs").then((m) => m.holderOf(address)).catch(() => null);
  if (!h) return { tier: TIERS[0], balance: 0, known: false };
  const tier = [...TIERS].reverse().find((t) => h.balance >= t.min) || TIERS[0];
  return { tier, balance: h.balance, known: true, perksOn: !!h.on };
}
// Telegram chats of linked wallets in King's Guard, for the Sentry lead: [{ chat, address, tier: "guard", leadSec }].
// Only while the holder perks are on (holders.mjs perksOn). Each balance comes from holders.mjs holderOf, the same 10-minute
// cache the 1M holder DMs read, so this adds no new kind of read. The list is kept for 2 minutes and a Sentry post never
// waits more than 3 s for a refresh: past that it uses the last list. Never throws.
const GUARD_TTL = 120_000, GUARD_WAIT = 3_000;
let guardCache = { at: 0, list: [] }, guardRefresh = null;
async function readGuardChats() {
  const hp = await import("./holders.mjs").catch(() => null);
  if (!hp?.perksOn?.() || !store) return [];
  const t = await store.readJson("telegram.json", { links: {} });
  const out = [];
  for (const [address, chat] of Object.entries(t.links || {})) {
    if (chat == null) continue;
    const h = await hp.holderOf(address).catch(() => null);
    if (h && isGuardBalance(h.balance)) out.push({ chat, address, tier: "guard", leadSec: GUARD.sentryLeadSec });
  }
  return out;
}
export async function guardChats() {
  if (Date.now() - guardCache.at < GUARD_TTL) return guardCache.list;
  guardRefresh ||= readGuardChats().then((list) => { guardCache = { at: Date.now(), list }; return list; })
    .catch(() => guardCache.list).finally(() => { guardRefresh = null; });
  return Promise.race([guardRefresh, new Promise((r) => setTimeout(() => r(guardCache.list), GUARD_WAIT).unref?.())]);
}
// Gate API checks a day for this address: the Gate API's own free and holder quotas, scaled by tier
export async function gateFreeFor(address, s) {
  const { tier } = await tierOf(address);
  if (tier.key === "soldier") return s.holderFreePerDay;
  if (tier.perks) return Math.round(s.holderFreePerDay * tier.gateX);
  return Math.round(s.freePerDay * tier.gateX);
}
export async function pinsOf(address) {
  const d = await store.readJson(FILE, {});
  return (d.pins?.[lc(address)] || []).filter((t) => isAddress(t));
}
// every pinned coin, with who pinned it (Watchfire reads this)
export async function allPins() {
  const d = await store.readJson(FILE, {});
  const by = new Map();
  for (const [owner, list] of Object.entries(d.pins || {})) for (const t of list || []) { const k = lc(t); if (!by.has(k)) by.set(k, []); by.get(k).push(owner); }
  return by;
}
const pro = () => { try { return process.env.TREASURY_PRO ? JSON.parse(process.env.TREASURY_PRO) : null; } catch { return null; } };

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/treasury", async ({ req }) => {
    const s = getSession(req);
    const me = s ? await tierOf(s.address) : null;
    const g = await import("./gateapi.mjs").then((m) => m.gateSettings?.()).catch(() => null);
    // $TROYA staking (owner, 21 Nov 2026): staked coins count in the balance once a stake contract is live, and a staker's
    // tier badge shows here once the stake perks are on. Neither changes this answer while no contract is configured.
    const st = await import("./stake.mjs").catch(() => null);
    const stakeOn = st ? await st.stakeLive().catch(() => false) : false;
    const badge = me && stakeOn ? await st.badgeOf(s.address).catch(() => null) : null;
    return {
      name: "Troya Treasury",
      counted: stakeOn ? "your signed-in wallet plus its Agent Wallet, and the $TROYA you have staked" : "your signed-in wallet plus its Agent Wallet",
      tiers: TIERS.map((t) => ({ key: t.key, name: t.name, min: t.min, watchfirePins: t.pins, gateChecksPerDay: g ? (t.key === "soldier" ? g.holderFreePerDay : t.perks ? Math.round(g.holderFreePerDay * t.gateX) : Math.round(g.freePerDay * t.gateX)) : null, perks: !!t.perks, ...(t.extras ? { extras: t.extras } : {}) })),
      perks: "From Soldier up: 200 assistant messages a day, 100 playbooks, a Telegram DM for every coin Sentry posts, launches through Troya without the daily limit and the whole creator fee. King's Guard adds the earliest Sentry calls (60 s ahead: each Sentry post reaches a linked Telegram 60 seconds before the public channel) and the King's Guard badge on the profile and in the community chat. Tiers are read from your balance; none of them pays money or promises a return.",
      pro: pro() || { note: "Pro plans, paid in $TROYA or a stablecoin, open once the team sets their prices." },
      you: me ? { tier: me.tier.key, name: me.tier.name, balance: me.balance, known: me.known, next: TIERS.find((t) => t.min > me.balance) || null, pins: (await pinsOf(s.address)).length, maxPins: me.tier.pins, ...(badge ? { stakeBadge: badge } : {}), ...(me.tier.key === "guard" ? { guardBadge: true } : {}) } : null,
    };
  }, { weight: 1 });
  r.get("/api/treasury/pins", async ({ req }) => {
    const s = requireSession(req);
    const { tier } = await tierOf(s.address);
    const pins = await pinsOf(s.address);
    const wf = await import("./watchfire.mjs").catch(() => null);
    return { max: tier.pins, tier: tier.key, pins: pins.map((t) => ({ token: getAddress(t), state: wf?.watchfireState(t) || null })) };
  });
  r.post("/api/treasury/pins", async ({ req, body }) => {
    const s = requireSession(req);
    const t = lc(body?.token);
    if (!isAddress(t)) throw new HttpError(400, "That is not a token address.");
    const { tier } = await tierOf(s.address);
    let out = null;
    await store.update(FILE, {}, (d) => {
      d.pins ||= {};
      const list = (d.pins[lc(s.address)] || []).filter((x) => x !== t);
      if (body.on !== false) {
        if (list.length >= tier.pins) throw new HttpError(400, `Your tier (${tier.name}) pins up to ${tier.pins} coin${tier.pins > 1 ? "s" : ""}. Unpin one, or hold more $TROYA for more pins.`);
        list.unshift(t);
      }
      d.pins[lc(s.address)] = list;
      out = list;
    });
    if (body.on !== false) await import("./watchfire.mjs").then((m) => m.watch(t, "pin")).catch(() => {});
    return { ok: true, pins: out.map((x) => getAddress(x)), max: tier.pins };
  }, { perMin: 30 });
}
