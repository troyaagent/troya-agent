// V9 F55 Styx Promise: when Troya was paid to check a coin, said it could be bought (passed, or passed with notes), and the
// coin went to zero within 7 days, the fee for that check comes back by itself. Not insurance: only Troya's own check fee is
// returned, never trading losses. Troya takes no swap fee, so a paid Gate check is the only fee there is to give back.
//   paid how                         refunded as
//   Gate API credit (USDG)           the same credit, back on the wallet's Gate API balance
//   x402 (USDC on Base / USDG)       Gate API credit of the same amount on the paying wallet (usable for future checks)
// Virtuals ACP jobs are paid through ACP's own escrow and are not covered here.
// "Went to zero" is Two Fates' definition: the price is 10% of the price at the check or less, or there is no price at all.
// The coin is read at 24 hours and then once a day until day 7.
//   GET /api/styx → { stats, entries, rules }
import { getRobinhoodToken, getEthUsd } from "./market.mjs";

const FILE = "styx.json";
const GATE = "gateapi.json";
const H = 3600e3, DAY = 24 * H, WINDOW = 7 * DAY;
const ZERO = 0.1;
const COVERED = new Set(["passed", "caution"]);
const KEEP = 5000;
let store, busy = false;
const lc = (s) => String(s || "").toLowerCase();
const num = (x) => (Number.isFinite(x) && x > 0 ? x : null);

async function priceNow(token) {
  const r = await getRobinhoodToken(token);
  const p = r?.pons;
  if (p && !p.graduated && p.priceInPair > 0 && p.pair?.address === "native") {
    const eu = Number(await getEthUsd()) || 0;
    if (eu) return p.priceInPair * eu;
  }
  return num(Number(r?.token?.priceUsd));
}

/** a paid check finished: covered when its verdict let the coin be bought. micro = the fee in 1e-6 dollars. */
export async function notePaid({ method, payer, token, verdict, micro, tx = null, network = null }) {
  if (!store || !payer || !token || !COVERED.has(verdict) || !(micro > 0)) return;
  const e = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), method, payer: lc(payer), token: lc(token), verdict, micro: Math.round(micro), tx, network, status: "watching" };
  e.p0 = await priceNow(token).catch(() => null);
  if (!e.p0) e.status = "no-price";        // nothing to measure against: listed, never refunded
  await store.update(FILE, { entries: [] }, (d) => { d.entries = [e, ...(d.entries || [])].slice(0, KEEP); return d; });
}

async function refund(e) {
  await store.update(GATE, {}, (d) => {
    d.credits ||= {};
    d.credits[e.payer] = (d.credits[e.payer] || 0) + e.micro;
    d.stats ||= {};
    d.stats.styxRefunds = (d.stats.styxRefunds || 0) + 1;
    d.stats.styxMicro = (d.stats.styxMicro || 0) + e.micro;
    return d;
  });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, { entries: [] });
    const now = Date.now();
    const due = (d.entries || []).filter((e) => e.status === "watching" && now - e.at >= DAY && now - (e.readAt || 0) >= DAY - 10 * 60e3);
    if (!due.length) return;
    const done = new Map();
    for (const e of due.slice(0, 20)) {
      const p = await priceNow(e.token).catch(() => null);
      const x = { ...e, readAt: now, lastPrice: p };
      if (!p || p <= e.p0 * ZERO) {
        await refund(e);
        Object.assign(x, { status: "refunded", refundedAt: now, note: !p ? "No price left: went to zero." : `Fell to ${((p / e.p0) * 100).toFixed(1)}% of the price at the check.` });
        import("./seal.mjs").then((m) => m.seal("styx-refund", e.payer, { token: e.token, micro: e.micro, method: e.method }, e.tx || e.id)).catch(() => {});
      } else if (now - e.at >= WINDOW) Object.assign(x, { status: "kept", note: "Did not go to zero within 7 days." });
      done.set(e.id, x);
    }
    await store.update(FILE, { entries: [] }, (y) => { y.entries = (y.entries || []).map((e) => done.get(e.id) || e); return y; });
  } catch (e) {
    console.warn("[styx]", e.message);
  } finally { busy = false; }
}

export async function styxView() {
  const d = await store.readJson(FILE, { entries: [] });
  const list = d.entries || [];
  const refunded = list.filter((e) => e.status === "refunded");
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  return {
    stats: { covered: list.filter((e) => e.status !== "no-price").length, watching: list.filter((e) => e.status === "watching").length, refunded: refunded.length,
      refundedUsd: +(refunded.reduce((s, e) => s + e.micro, 0) / 1e6).toFixed(4), kept: list.filter((e) => e.status === "kept").length },
    entries: list.slice(0, 200).map((e) => ({ at: e.at, method: e.method, payer: short(e.payer), token: e.token, verdict: e.verdict, feeUsd: e.micro / 1e6, status: e.status, note: e.note || null, refundedAt: e.refundedAt || null })),
    rules: "When you pay Troya for a Gate check (Gate API credit or x402) and the result says the coin can be bought (passed, or passed with notes), the check is covered for 7 days. If the coin goes to zero in that time (its price falls to 10% of the price at the check or less, or there is no price at all), the fee for that check comes back by itself as Gate API credit on the wallet that paid. Read at 24 hours, then once a day. Not insurance: only Troya's own check fee is returned, never trading losses. Free checks cost nothing, so there is nothing to return. Virtuals ACP jobs are paid through ACP's escrow and are not covered.",
    updatedAt: Date.now(),
  };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/styx", () => styxView(), { weight: 1, perMin: 60 });
  setInterval(() => tick().catch(() => {}), H).unref?.();
  setTimeout(() => tick().catch(() => {}), 60_000).unref?.();
}
