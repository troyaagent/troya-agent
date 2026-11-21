// Herald payouts, automatic (owner, 20 Nov 2026: rewards set in the chat, then "lebih otomatis ... jadi saya ga kirim
// kirim"). Once a week, after the Arena Cup week closes (Monday 00:00 UTC), it pays last week's Cup prizes and the
// referral rewards earned so far, in ETH, from the creator wallet (the key the automatic flywheel already holds).
// Rails, all enforced here:
//   · budget: HERALD_FEE_CAP_PCT (15) % of the creator fees claimed during that week, and never more than
//     HERALD_PAYOUT_MAX_USD (default 60) in a week. When the budget is short, every payment shrinks by the same factor.
//   · only wallets on that week's list: the Cup's top 3 (one entry per wallet, admins left out, HERALD_CUP_SPLIT USD,
//     default 10,6,4) and referrers whose unpaid rewards reach $1 (admins left out). A week is paid once (ledger in
//     data/payouts.json); a referrer's paid total only grows.
//   · the creator wallet always keeps PAYOUT_RESERVE_ETH (0.003) for the flywheel's gas.
//   · HERALD_PAYOUTS: "live" sends, "dry" (the default) only writes the list and reports it, "off" does nothing.
//   · each payment is a plain ETH transfer, sealed, listed at GET /api/payouts and reported to the admins' Telegram.
//   GET  /api/payouts              public: past weeks, each payment with its transaction (wallets shortened)
//   POST /api/payouts/run {dry}    admin: work out (and, when live and not dry, pay) the last closed week now
import { HttpError } from "./api.mjs";
import { getSession } from "./auth.mjs";

const FILE = "payouts.json";
const DEF = { weeks: {}, refPaidUsd: {} };
const lc = (s) => String(s || "").toLowerCase();
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const mode = () => (["live", "dry", "off"].includes(process.env.HERALD_PAYOUTS) ? process.env.HERALD_PAYOUTS : "dry");
const maxUsd = () => { const v = Number(process.env.HERALD_PAYOUT_MAX_USD); return v > 0 ? v : 60; };
const reserveEth = () => { const v = Number(process.env.PAYOUT_RESERVE_ETH); return v >= 0 && isFinite(v) && process.env.PAYOUT_RESERVE_ETH ? v : 0.003; };
const split = () => { const v = String(process.env.HERALD_CUP_SPLIT || "10,6,4").split(",").map(Number).filter((x) => x >= 0 && isFinite(x)); return v.length ? v : [10, 6, 4]; };
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
// weeks that start before this date are never paid (the rewards were set on 20 Nov 2026, in the Cup week of 16 Nov)
const fromTs = () => { const t = Date.parse(process.env.HERALD_PAYOUTS_FROM || "2026-11-16T00:00:00Z"); return isFinite(t) ? t : 0; };
let store = null, busy = false;

// creator fees claimed inside [start, end): the flywheel's claim list carries block numbers; each block's time is read once
async function claimedEth(start, end) {
  const { rpc } = await import("./robinhood.mjs");
  const f = await store.readJson("flywheel.json", {});
  let sum = 0;
  for (const c of f.claims || []) {
    if (!(c.block > 0) || !(c.eth > 0)) continue;
    const b = await rpc("robinhood", "eth_getBlockByNumber", ["0x" + Number(c.block).toString(16), false]).catch(() => null);
    const t = b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : 0;
    if (t >= start && t < end) sum += c.eth;
  }
  return sum;
}

async function plan() {
  const herald = await import("./herald.mjs");
  const inp = await herald.payoutInputs();
  const { getEthUsd } = await import("./market.mjs");
  const ethUsd = await getEthUsd();
  if (!(ethUsd > 0)) throw new Error("No ETH price right now.");
  const ad = new Set([...admins(), ...(inp.admins || [])]);
  const led = await store.readJson(FILE, DEF);
  const items = [];
  const prizes = split();
  inp.cup.filter((r) => !ad.has(r.owner)).slice(0, prizes.length).forEach((r, i) => { if (prizes[i] > 0) items.push({ kind: "cup", rank: i + 1, to: r.owner, usdDue: prizes[i], note: `Arena Cup ${inp.season} #${i + 1} (${r.pnlPct}% over ${r.closed} trades)` }); });
  for (const r of inp.referrals || []) {
    if (!r.on || ad.has(r.referrer)) continue;
    const unpaid = +((r.pendingUsd || 0) - (led.refPaidUsd[r.referrer] || 0)).toFixed(4);
    if (unpaid >= 1) items.push({ kind: "referral", to: r.referrer, usdDue: unpaid, note: `Referral rewards (${r.bps / 100}% share)` });
  }
  const claimed = await claimedEth(inp.start, inp.end);
  const capPct = inp.capPct || 15;
  const budgetUsd = Math.min((claimed * ethUsd * capPct) / 100, maxUsd());
  const dueUsd = items.reduce((s, x) => s + x.usdDue, 0);
  const factor = dueUsd > 0 ? Math.min(1, budgetUsd / dueUsd) : 0;
  for (const x of items) { x.usd = +(x.usdDue * factor).toFixed(2); x.eth = +(x.usd / ethUsd).toFixed(6); }
  return { season: inp.season, start: inp.start, end: inp.end, ethUsd, claimedEth: +claimed.toFixed(6), capPct, maxUsd: maxUsd(), budgetUsd: +budgetUsd.toFixed(2), dueUsd: +dueUsd.toFixed(2), factor: +factor.toFixed(4), items: items.filter((x) => x.eth >= 0.00001) };
}

async function run({ dry = false, reason = "schedule" } = {}) {
  if (busy) throw new HttpError(409, "A payout run is already going.");
  if (mode() === "off") return { mode: "off", note: "Payouts are off (HERALD_PAYOUTS=off)." };
  busy = true;
  try {
    const p = await plan();
    if (p.start < fromTs()) return { mode: mode(), skipped: true, note: `Week ${p.season} started before payouts began, so it is not paid.` };
    const led = await store.readJson(FILE, DEF);
    const done = led.weeks[p.season];
    if (done && done.status === "paid") return { mode: mode(), already: true, week: done };
    const live = mode() === "live" && !dry;
    const week = { ...p, status: live ? "paying" : "dry", at: Date.now(), reason, items: p.items.map((x) => ({ ...x })) };
    if (live && week.items.length) {
      const fw = await import("./flywheel-auto.mjs");
      const w = await fw.payoutSigner();
      if (!w) throw new Error("The creator wallet key is not stored on the server, so nothing can be paid automatically.");
      const total = week.items.reduce((s, x) => s + x.eth, 0);
      const bal = Number(await w.provider.getBalance(w.address)) / 1e18;
      if (bal - total < reserveEth()) throw new Error(`The creator wallet holds ${bal.toFixed(5)} ETH; paying ${total.toFixed(5)} ETH would leave less than the ${reserveEth()} ETH gas reserve.`);
      const { parseEther } = await import("ethers");
      for (const x of week.items) {
        try {
          const tx = await w.sendTransaction({ to: x.to, value: parseEther(String(x.eth)) });
          const rc = await tx.wait(1);
          x.hash = tx.hash; x.ok = rc?.status === 1;
          if (x.ok) import("./seal.mjs").then((s) => s.seal("herald-payout", x.to, { week: p.season, kind: x.kind, usd: x.usd, eth: x.eth, hash: x.hash }, `Herald paid ${x.eth} ETH ($${x.usd}) to ${short(x.to)}: ${x.note}`)).then((r) => { x.seal = r?.hash || null; }).catch(() => {});
        } catch (e) { x.error = String(e.shortMessage || e.message).slice(0, 200); }
      }
      week.status = week.items.every((x) => x.ok) ? "paid" : "partial";
    } else if (live) week.status = "paid";               // nothing to pay this week: closed as paid (an empty week)
    await store.update(FILE, DEF, (x) => {
      x.weeks = x.weeks || {}; x.refPaidUsd = x.refPaidUsd || {};
      if (week.status !== "dry") for (const it of week.items) if (it.kind === "referral" && it.ok) x.refPaidUsd[it.to] = +((x.refPaidUsd[it.to] || 0) + it.usd).toFixed(4);
      if (!(x.weeks[p.season]?.status === "paid")) x.weeks[p.season] = week;
      return x;
    });
    const lines = week.items.map((x) => `${x.kind === "cup" ? `Cup #${x.rank}` : "Referral"} ${short(x.to)}: ${x.eth} ETH ($${x.usd})${x.hash ? ` robinhoodchain.blockscout.com/tx/${x.hash}` : ""}${x.error ? ` FAILED: ${x.error}` : ""}`);
    const head = week.status === "dry" ? "Herald payouts (dry run, nothing sent)" : `Herald payouts ${week.status}`;
    import("./community.mjs").then((c) => c.notifyAdmins?.(`<b>${head}</b>, week ${p.season}\nCreator fees claimed that week: ${p.claimedEth} ETH. Budget: ${p.capPct}% of it, at most $${p.maxUsd} = $${p.budgetUsd}. Due: $${p.dueUsd}${p.factor < 1 ? `, paid at ${Math.round(p.factor * 100)}%` : ""}.\n${lines.join("\n") || "Nobody to pay this week (no Cup winners with 3+ closed trades, no referral rewards of $1 or more)."}`)).catch(() => {});
    return { mode: mode(), week };
  } finally { busy = false; }
}

// the last closed week is paid once, an hour after it closes
async function tick() {
  if (mode() === "off") return;
  const now = new Date();
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  if (Date.now() < monday + 3600_000) return;
  const herald = await import("./herald.mjs");
  const inp = await herald.payoutInputs().catch(() => null);
  const season = inp?.season;
  if (!season || !(inp.start >= fromTs())) return;
  const led = await store.readJson(FILE, DEF);
  const w = led.weeks[season];
  if (w && (w.status === "paid" || w.status === "partial" || (w.status === "dry" && mode() === "dry"))) return;
  await run({ reason: "schedule" }).catch((e) => {
    console.warn("[payouts]", e.message);
    import("./community.mjs").then((c) => c.notifyAdmins?.(`<b>Herald payouts stopped</b>: ${e.message}`)).catch(() => {});
  });
}

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => tick().catch(() => {}), 120_000).unref?.();
  setInterval(() => tick().catch(() => {}), 3600_000).unref?.();
  r.get("/api/payouts", async () => {
    const led = await store.readJson(FILE, DEF);
    const weeks = Object.values(led.weeks || {}).sort((a, b) => b.start - a.start).slice(0, 12).map((w) => ({
      season: w.season, status: w.status, at: w.at, claimedEth: w.claimedEth, capPct: w.capPct, budgetUsd: w.budgetUsd, dueUsd: w.dueUsd, factor: w.factor,
      items: (w.items || []).map((x) => ({ kind: x.kind, rank: x.rank || null, to: short(x.to), usd: x.usd, eth: x.eth, hash: x.hash || null, ok: !!x.ok, seal: x.seal || null })),
    }));
    return { name: "Herald payouts", mode: mode(), rules: `Every Monday after the Arena Cup week closes: Cup prizes (${split().map((v) => `$${v}`).join(" / ")}) and referral rewards of $1 or more, paid in ETH from the creator wallet. The budget is ${Number(process.env.HERALD_FEE_CAP_PCT) || 15}% of the creator fees claimed that week, at most $${maxUsd()}; when it is short, every payment shrinks by the same share.`, weeks };
  }, { weight: 1 });
  r.post("/api/payouts/run", async ({ req, body }) => {
    const s = getSession(req);
    if (!s || !admins().includes(lc(s.address))) throw new HttpError(403, "Admins only.");
    return run({ dry: body?.dry !== false, reason: "admin" });
  });
}

export { plan as _plan, run as _run };
