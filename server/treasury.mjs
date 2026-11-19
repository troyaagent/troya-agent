// V8 F46 Treasury: clear holder tiers for $TROYA and what each one unlocks, read from the same balance the perks use
// (the signed-in wallet plus its Agent Wallet, server/holders.mjs). Unlocks that work today:
//   · Watchfire pins: coins you pin are watched live by Watchfire and every fire on them reaches your inbox and Telegram
//   · Gate checks a day through the Gate API (server/gateapi.mjs reads gateFreeFor)
//   · the existing 1M perks (assistant messages, playbooks, Sentry DMs, launches without limits, the whole creator fee)
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
  { key: "guard", name: "King's Guard", min: 50_000_000, pins: 100, gateX: 10, perks: true },
];
const lc = (s) => String(s || "").toLowerCase();
let store = null;

export async function tierOf(address) {
  if (!isAddress(String(address || ""))) return { tier: TIERS[0], balance: 0, known: false };
  const h = await import("./holders.mjs").then((m) => m.holderOf(address)).catch(() => null);
  if (!h) return { tier: TIERS[0], balance: 0, known: false };
  const tier = [...TIERS].reverse().find((t) => h.balance >= t.min) || TIERS[0];
  return { tier, balance: h.balance, known: true, perksOn: !!h.on };
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
    return {
      name: "Troya Treasury",
      counted: "your signed-in wallet plus its Agent Wallet",
      tiers: TIERS.map((t) => ({ key: t.key, name: t.name, min: t.min, watchfirePins: t.pins, gateChecksPerDay: g ? (t.key === "soldier" ? g.holderFreePerDay : t.perks ? Math.round(g.holderFreePerDay * t.gateX) : Math.round(g.freePerDay * t.gateX)) : null, perks: !!t.perks })),
      perks: "From Soldier up: 200 assistant messages a day, 100 playbooks, a Telegram DM for every coin Sentry posts, launches through Troya without the daily limit and the whole creator fee.",
      pro: pro() || { note: "Pro plans, paid in $TROYA or a stablecoin, open once the team sets their prices." },
      you: me ? { tier: me.tier.key, name: me.tier.name, balance: me.balance, known: me.known, next: TIERS.find((t) => t.min > me.balance) || null, pins: (await pinsOf(s.address)).length, maxPins: me.tier.pins } : null,
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
