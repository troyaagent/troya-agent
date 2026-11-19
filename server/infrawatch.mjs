// Infra watch: tells the owner on Telegram (the admin chats in reports-tg.json, like the dev updates) the moment Troya's
// paid infrastructure or the server needs attention, so a plan can be raised before anything breaks. Checked every 5
// minutes; each alert at most once every 6 hours (a red one again after 1 hour if it is still red).
//   · Chainstack (the Growth node, 20M requests a month): requests counted at the RPC layer, alert at 70% and 90% of the
//     month, and early when the pace would run out before the month ends; alert when the node stops answering
//   · Blockscout PRO: alert when the client is paused (out of credits or rate limited)
//   · OpenRouter: alert when the credits left fall under $20
//   · the server: free memory under 200 MB, swap over 1.5 GB, disk over 85%
//   GET /api/infra   admins only: the numbers behind the alerts
import { readFile, statfs } from "node:fs/promises";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "infra.json", TICK = 5 * 60_000, COOL = 6 * 3600_000, COOL_RED = 3600_000;
const CS_MONTH = Number(process.env.CHAINSTACK_MONTHLY_REQUESTS || 20_000_000);
let store = null, csFails = 0;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function ownerChats() {
  const d = await store.readJson("reports-tg.json", {});
  return (d.chats || []).filter((c) => !c.off && !String(c.id).startsWith("-")).map((c) => c.id);
}
async function tell(text) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) return;
  for (const id of await ownerChats()) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: id, text: `<b>Troya infra</b>\n\n${text}`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }) }).catch(() => {});
  }
}

async function readings() {
  const R = await import("./robinhood.mjs");
  const out = { at: Date.now() };
  // Chainstack: this month's requests (the RPC layer counts every request it sends to a chainstack host)
  const d = await store.readJson(FILE, {});
  // Chainstack counts quota per billing period (the plan started on the 19th: 19 Nov to 19 Dec), not per calendar month
  const anchor = Number(process.env.CHAINSTACK_PERIOD_DAY || 19), now = new Date();
  let pStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), anchor));
  if (pStart > now) pStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, anchor));
  const pEnd = new Date(Date.UTC(pStart.getUTCFullYear(), pStart.getUTCMonth() + 1, anchor));
  const m = pStart.toISOString().slice(0, 10);
  const hits = R.rpcHits ? R.rpcHits() : {};
  const cs = Object.entries(hits).filter(([h]) => /chainstack/.test(h)).reduce((s, [, n]) => s + n, 0);
  const prev = d.csSeen || 0;
  const add = cs >= prev ? cs - prev : cs;                                       // the counter restarts with the server
  const fresh = d.csMonth !== m;
  const used = (fresh ? 0 : d.csUsed || 0) + add;
  const since = fresh || !d.csSince ? Date.now() : d.csSince;                    // counting began (mid-period on 19 Nov)
  const rate = used / Math.max(60_000, Date.now() - since);                      // requests per ms, from what we measured
  out.chainstack = { used, limit: CS_MONTH, pct: pct(used, CS_MONTH), projected: Math.round(used + rate * Math.max(0, pEnd - Date.now())), period: `${m} → ${pEnd.toISOString().slice(0, 10)}` };
  await store.update(FILE, {}, (x) => { x.csMonth = m; x.csUsed = used; x.csSeen = cs; x.csSince = since; return x; });
  // Chainstack answering?
  const cfg = R.CHAINS.robinhood.upstreams.find((u) => /chainstack/.test(u));
  if (cfg) {
    const ok = await R.rpc("robinhood", "eth_blockNumber", [], { only: cfg, timeoutMs: 8000 }).then(() => true).catch(() => false);
    csFails = ok ? 0 : csFails + 1;
    out.chainstackUp = ok;
  }
  // Blockscout
  const M = await import("./market.mjs");
  out.blockscout = { key: !!process.env.BLOCKSCOUT_API_KEY, live: M.hasBlockscout() };
  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    const j = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null);
    if (j?.data) out.openrouter = { left: +(Number(j.data.total_credits) - Number(j.data.total_usage)).toFixed(2) };
  }
  // the server
  const mem = Object.fromEntries((await readFile("/proc/meminfo", "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => { const [k, v] = l.split(":"); return [k, parseInt(v) / 1024]; }));
  out.server = { memFreeMb: Math.round(mem.MemAvailable || 0), swapUsedMb: Math.round((mem.SwapTotal || 0) - (mem.SwapFree || 0)) };
  const fs = await statfs("/").catch(() => null);
  if (fs) out.server.diskPct = pct((fs.blocks - fs.bavail) * fs.bsize, fs.blocks * fs.bsize);
  return out;
}

async function tick() {
  if (!store) return;
  try {
    const r = await readings();
    const d = await store.readJson(FILE, {});
    const sent = d.sent || {};
    const alerts = [];
    const add = (key, red, text) => { const last = sent[key] || 0; if (Date.now() - last > (red ? COOL_RED : COOL)) { alerts.push(text); sent[key] = Date.now(); } };
    const c = r.chainstack;
    if (c.pct >= 90) add("cs90", true, `🔴 Kuota Chainstack ${c.pct}% terpakai (${(c.used / 1e6).toFixed(1)} jt dari ${(c.limit / 1e6).toFixed(0)} jt request periode ini). Naikkan ke Pro ($199) atau nyalakan Extra usage, kalau tidak server pindah ke RPC gratis yang lebih lambat saat kuota habis.`);
    else if (c.pct >= 70) add("cs70", false, `🟠 Kuota Chainstack ${c.pct}% terpakai (${(c.used / 1e6).toFixed(1)} jt dari ${(c.limit / 1e6).toFixed(0)} jt). Perkiraan akhir periode ${(c.projected / 1e6).toFixed(1)} jt.`);
    else if (c.used > 200_000 && c.projected > c.limit * 0.95) add("csPace", false, `🟠 Laju pemakaian Chainstack akan melewati kuota periode ini (perkiraan ${(c.projected / 1e6).toFixed(1)} jt dari ${(c.limit / 1e6).toFixed(0)} jt). Belum darurat; pertimbangkan Pro ($199) sebelum habis.`);
    if (csFails >= 2) add("csDown", true, "🔴 Node Chainstack tidak menjawab (2 cek berturut-turut). Troya otomatis pakai RPC cadangan (resmi, dRPC, publicnode), jadi tetap jalan tapi lebih lambat. Cek status.chainstack.com.");
    if (r.blockscout.key && !r.blockscout.live) add("bsDown", true, "🔴 Blockscout terjeda (kredit habis atau kena limit). Jumlah holder pindah ke GeckoTerminal, Owl berhenti, Aegis baca saldo dari chain. Cek dev.blockscout.com: kalau kredit Builder habis, naikkan ke Pro ($199).");
    if (r.openrouter && r.openrouter.left < 20) add("orLow", r.openrouter.left < 5, `${r.openrouter.left < 5 ? "🔴" : "🟠"} Saldo OpenRouter tinggal $${r.openrouter.left}. Council, Arena, dan AI bot TG/X memakainya: isi ulang di openrouter.ai/credits.`);
    const s = r.server;
    if (s.memFreeMb < 200) add("mem", true, `🔴 RAM server tinggal ${s.memFreeMb} MB. Server bisa melambat atau proses mati: naikkan Hetzner ke 4 GB.`);
    if (s.swapUsedMb > 1500) add("swap", false, `🟠 Server memakai swap ${s.swapUsedMb} MB (RAM kurang). Pertimbangkan naik ke Hetzner 4 GB.`);
    if (s.diskPct > 85) add("disk", s.diskPct > 95, `${s.diskPct > 95 ? "🔴" : "🟠"} Disk server ${s.diskPct}% penuh. Data log dan arsip perlu dibersihkan atau disk diperbesar.`);
    await store.update(FILE, {}, (x) => { x.sent = sent; x.last = r; return x; });
    if (alerts.length) { await tell(alerts.join("\n\n")); console.log(`[infra] alerted: ${alerts.length}`); }
  } catch (e) { console.warn("[infra]", e.message); }
}

export async function register(r, ctx) {
  store = ctx.store;
  setTimeout(() => tick().catch(() => {}), 2 * 60_000);
  setInterval(() => tick().catch(() => {}), TICK).unref();
  r.get("/api/infra", async ({ req }) => {
    const me = String(requireSession(req).address).toLowerCase();
    const admins = String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (!admins.includes(me)) throw new HttpError(403, "Admins only.");
    return (await store.readJson(FILE, {})).last || {};
  }, { weight: 1 });
}
