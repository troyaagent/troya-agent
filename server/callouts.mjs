// V8 F41 War Table, stage 2: callouts and X on every coin page.
//   · A callout is a signed-in wallet's thesis on a coin, stamped with the price and market cap at that moment. Its result
//     is read live from the price since, and graded at 24 hours, so a caller's record is public and cannot be edited.
//     The caller's X handle and avatar show when the wallet linked X (Sign in with X).
//   · The X panel lists recent posts that mention the coin's contract address (server/xsocial.mjs searchRecent, cached).
//   GET  /api/callouts/:token        the coin's callouts and X posts
//   POST /api/callouts               { token, text }  (session; at most 5 a day per wallet)
//   GET  /api/callouts               the latest callouts across coins and the callers' board
import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "callouts.json";
const PER_DAY = 5;
const lc = (s) => String(s || "").toLowerCase();
let store = null;

async function priceOf(token) {
  const m = await import("./market.mjs");
  const row = m.indexRow(token);
  if (row?.priceUsd) return { priceUsd: row.priceUsd, mcapUsd: row.mcapUsd || null, symbol: row.symbol };
  const r = await m.getRobinhoodToken(token).catch(() => null);
  return r?.token?.priceUsd ? { priceUsd: r.token.priceUsd, mcapUsd: r.token.mcapUsd || null, symbol: r.token.symbol } : null;
}
const resultPct = (c, now) => (c.priceUsd > 0 && now > 0 ? +(((now / c.priceUsd) - 1) * 100).toFixed(1) : null);

// grade every callout once it is 24 hours old: the price then, fixed for good
async function grade() {
  const d = await store.readJson(FILE, {});
  const due = (d.items || []).filter((c) => !c.graded && Date.now() - c.at >= 24 * 3600_000).slice(0, 40);
  if (!due.length) return;
  const prices = new Map();
  for (const c of due) if (!prices.has(c.token)) prices.set(c.token, (await priceOf(c.token).catch(() => null))?.priceUsd || null);
  await store.update(FILE, {}, (x) => { for (const c of x.items || []) { const pz = prices.get(c.token); if (!c.graded && due.some((y) => y.id === c.id) && pz) { c.graded = { at: Date.now(), priceUsd: pz, pct: resultPct(c, pz) }; } } return x; });
}
const pub = (c, now) => ({ id: c.id, token: getAddress(c.token), symbol: c.symbol, text: c.text, at: c.at, caller: { address: getAddress(c.owner), handle: c.handle || null, avatar: c.avatar || null },
  priceUsd: c.priceUsd, mcapUsd: c.mcapUsd, nowPct: now ? resultPct(c, now) : null, graded: c.graded || null });

export async function register(r, ctx) {
  store = ctx.store;
  setInterval(() => grade().catch(() => {}), 10 * 60_000).unref?.();
  r.get("/api/callouts/:token", async ({ params }) => {
    if (!isAddress(String(params.token || ""))) throw new HttpError(400, "That is not a token address.");
    const t = lc(params.token);
    const d = await store.readJson(FILE, {});
    const now = (await priceOf(t).catch(() => null))?.priceUsd || null;
    const list = (d.items || []).filter((c) => c.token === t).slice(0, 50).map((c) => pub(c, now));
    const x = await import("./xsocial.mjs").then((m) => m.searchRecent(`"${getAddress(t)}" OR "${t}"`, 20)).catch(() => null);
    return { token: getAddress(t), callouts: list, x: x ? { posts: (x.posts || []).slice(0, 20), capped: !!x.capped, error: x.error || null, at: x.at || null } : { posts: [], off: true } };
  }, { weight: 1, perMin: 60 });
  r.post("/api/callouts", async ({ req, body }) => {
    const s = requireSession(req);
    const t = lc(body?.token);
    if (!isAddress(t)) throw new HttpError(400, "That is not a token address.");
    const text = String(body?.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
    if (text.length < 3) throw new HttpError(400, "Write your thesis in a few words.");
    const p = await priceOf(t);
    if (!p?.priceUsd) throw new HttpError(400, "This coin has no price yet, so a callout could not be stamped.");
    const owner = lc(s.address);
    const x = await import("./xsocial.mjs").then((m) => m.handleOf(owner)).catch(() => null);
    const c = { id: randomBytes(6).toString("hex"), owner, token: t, symbol: p.symbol || null, text, at: Date.now(), priceUsd: p.priceUsd, mcapUsd: p.mcapUsd, handle: x?.username || null, avatar: x?.avatar || null };
    await store.update(FILE, {}, (d) => {
      const today = (d.items || []).filter((y) => y.owner === owner && Date.now() - y.at < 86_400_000).length;
      if (today >= PER_DAY) throw new HttpError(429, `That is ${PER_DAY} callouts today. Each one is graded in public, so make them count.`);
      d.items = [c, ...(d.items || [])].slice(0, 5000);
      return d;
    });
    import("./seal.mjs").then((m) => m.seal("callout", getAddress(t), c, `Callout on $${c.symbol || "?"}`)).catch(() => {});
    return { ok: true, callout: pub(c, p.priceUsd) };
  }, { perMin: 10 });
  r.get("/api/callouts", async () => {
    const d = await store.readJson(FILE, {});
    const items = d.items || [];
    const by = new Map();
    for (const c of items.filter((y) => y.graded)) { const b = by.get(c.owner) || { owner: c.owner, handle: c.handle, n: 0, sum: 0, wins: 0 }; b.n++; b.sum += c.graded.pct || 0; if ((c.graded.pct || 0) > 0) b.wins++; by.set(c.owner, b); }
    const board = [...by.values()].filter((b) => b.n >= 3).map((b) => ({ caller: getAddress(b.owner), handle: b.handle || null, calls: b.n, avgPct: +(b.sum / b.n).toFixed(1), winRate: +((100 * b.wins) / b.n).toFixed(0) })).sort((a, b) => b.avgPct - a.avgPct).slice(0, 30);
    return { latest: items.slice(0, 30).map((c) => pub(c, null)), board, rule: "Every callout is stamped with the price at the moment it was made and graded at 24 hours. Callers need 3 graded calls to enter the board." };
  }, { weight: 1 });
}
