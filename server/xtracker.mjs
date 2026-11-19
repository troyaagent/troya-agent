// V8 F41 War Table, stage 3: the X Tracker. Follow X accounts (callers, devs, KOLs); the moment one of them posts a
// Robinhood Chain contract, Troya runs the Gate on it and sends you the post, the coin and the verdict (inbox and
// Telegram). The accounts ride on Troya's X filtered stream as extra rules (server/xsocial.mjs setTrackerRules), so a
// post arrives as it is published and costs one read; nothing is polled.
//   GET  /api/xtracker/me            the accounts you track, your limit by tier, the last hits (session)
//   POST /api/xtracker               { handle, on }                                              (session)
import { getAddress, isAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "xtracker.json";
const LIMITS = { free: 3, scout: 5, soldier: 15, captain: 40, guard: 100 };   // accounts per wallet, by Treasury tier
const MAX_TOTAL = Number(process.env.XTRACKER_MAX || 250);                    // accounts across everyone (X rule budget)
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const lc = (s) => String(s || "").toLowerCase();
let store = null;

async function limitOf(owner) {
  const t = await import("./treasury.mjs").then((m) => m.tierOf(owner)).catch(() => null);
  return { tier: t?.tier?.key || "free", max: LIMITS[t?.tier?.key || "free"] || 3 };
}
async function allHandles() {
  const d = await store.readJson(FILE, {});
  const by = new Map();
  for (const [owner, list] of Object.entries(d.tracks || {})) for (const h of list || []) { const k = lc(h); if (!by.has(k)) by.set(k, []); by.get(k).push(owner); }
  return by;
}
let syncT = null;
function syncSoon() {
  clearTimeout(syncT);
  syncT = setTimeout(async () => {
    const by = await allHandles();
    await import("./xsocial.mjs").then((m) => m.setTrackerRules([...by.keys()].slice(0, MAX_TOTAL))).catch((e) => console.warn("[xtracker] rules", e.message));
  }, 3_000);
}

/** xsocial hook: a post from a tracked account. */
export async function onTrackedPost(t, author) {
  const handle = lc(author?.username);
  if (!handle) return;
  const cas = [...new Set((String(t.text || "").match(/0x[a-fA-F0-9]{40}/g) || []).map(lc))].slice(0, 3);
  if (!cas.length) return;
  const owners = (await allHandles()).get(handle) || [];
  if (!owners.length) return;
  const m = await import("./market.mjs");
  for (const ca of cas) {
    if (!isAddress(ca)) continue;
    const tok = m.indexRow(ca) || (await m.getRobinhoodToken(ca).catch(() => null))?.token;
    if (!tok?.symbol) continue;                                              // not a Robinhood Chain coin with a market
    const g = await import("./badge.mjs").then((b) => b.badgeResult(ca)).catch(() => null);
    const verdict = g?.verdict || "not checked";
    const hit = { at: Date.now(), handle, postId: t.id, token: getAddress(ca), symbol: tok.symbol, verdict, text: String(t.text || "").slice(0, 280) };
    await store.update(FILE, {}, (d) => { d.hits = [hit, ...(d.hits || [])].slice(0, 500); return d; });
    const { addInbox } = await import("./inbox.mjs");
    for (const o of owners) await addInbox(o, { kind: "xtracker", title: `@${author.username} posted $${tok.symbol} · Gate: ${verdict}`, body: `x.com/${author.username}/status/${t.id}\nCoin: troya.codes/agent#/token/${getAddress(ca)}\nThe Gate is a snapshot, never a safe stamp.`, data: { xtracker: hit } }).catch(() => {});
  }
}

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(syncSoon, 20_000);
  r.get("/api/xtracker/me", async ({ req }) => {
    const s = requireSession(req);
    const d = await store.readJson(FILE, {});
    const mine = d.tracks?.[lc(s.address)] || [];
    const lim = await limitOf(s.address);
    return { tracking: mine, max: lim.max, tier: lim.tier, hits: (d.hits || []).filter((h) => mine.includes(h.handle)).slice(0, 30) };
  });
  r.post("/api/xtracker", async ({ req, body }) => {
    const s = requireSession(req);
    const handle = String(body?.handle || "").replace(/^@/, "").trim();
    if (!HANDLE.test(handle)) throw new HttpError(400, "That is not an X handle.");
    const lim = await limitOf(s.address);
    const total = (await allHandles()).size;
    let out = [];
    await store.update(FILE, {}, (d) => {
      d.tracks ||= {};
      const list = (d.tracks[lc(s.address)] || []).filter((x) => x !== lc(handle));
      if (body?.on !== false) {
        if (list.length >= lim.max) throw new HttpError(400, `Your tier tracks up to ${lim.max} accounts. Untrack one, or hold more $TROYA for more (Treasury).`);
        if (total >= MAX_TOTAL && !Object.values(d.tracks).some((l) => (l || []).includes(lc(handle)))) throw new HttpError(503, "The X Tracker is full right now. Try again later.");
        list.unshift(lc(handle));
      }
      d.tracks[lc(s.address)] = list;
      out = list;
      return d;
    });
    syncSoon();
    return { ok: true, tracking: out, max: lim.max };
  }, { perMin: 20 });
}
