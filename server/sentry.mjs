// Troya Sentry: every new Pons launch goes through Troya Gate and the result is posted to a Telegram channel.
// The group gets one recap a day. Results also feed GET /api/sentry/recent (public, read-only).
//   SENTRY=1    watch + post        SENTRY=dry   watch, write posts to data/sentry-preview.jsonl, send nothing
//   SENTRY_CHANNEL (default @troyasentry) · SENTRY_RECAP_CHAT (default @troyaagent) · SENTRY_RECAP_UTC_HOUR (default 13)
//   SENTRY_IMAGES=0 turns off the coin's logo on posts (on by default; posts fall back to text when a logo can't be fetched)
//   SENTRY_POOLS=1 also checks coins that launch outside Pons: every new hookless Uniswap v3/v4 pool against ETH, WETH or USDG.
//   They are posted only once the Gate finds a route and at least 0.05 ETH of depth (checked at 5 min, 15 min, 1 h), so empty
//   or dust pools never reach the channel. SENTRY_POOLS=dry writes those posts to data/sentry-pools-preview.jsonl instead.
// Launch log: PonsFactory event, topics = [sig, token, curve, deployer]. Token names come from the internet: they are
// stripped of links and handles and HTML-escaped before they reach Telegram. Wording stays factual: check results,
// never "scam" or "safe".
import { ADDR, rpc, gateCheck, ponsState, ponsPublic, ponsProfile } from "./robinhood.mjs";
import { readFileSync } from "node:fs";
import { AbiCoder, getAddress } from "ethers";
import { addV4Key } from "./robinhood.mjs";

const LAUNCH_TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const MODE = process.env.SENTRY || "";
const CHANNEL = process.env.SENTRY_CHANNEL || "@troyasentry";
const RECAP_CHAT = process.env.SENTRY_RECAP_CHAT || "@troyaagent";
const RECAP_HOUR = Number(process.env.SENTRY_RECAP_UTC_HOUR ?? 13);
const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const SITE = "https://troya.codes";
const PONS = "https://ponsfamily.com/launchpad/";
const TEST_ETH = "0.01";
const MIN_RAISED = 0.002;                // below this a curve is dust: a "passed" there would mean nothing, so it waits like an empty one
const FIRST_CHECK_S = 90;                 // past the launch snipe tax
const RETRY_S = [5 * 60, 15 * 60];        // no buys yet → look again, then drop quietly
const MAX_RANGE = 2000, CATCHUP = 3000, MAX_GAP = 20000;
const STATE = "sentry.json";
const POOLS = process.env.SENTRY_POOLS || "";
const T_V4_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";   // PoolManager Initialize
const T_V3_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"; // UniswapV3Factory PoolCreated
const NULL_ADDR = "0x0000000000000000000000000000000000000000";
const QUOTES = new Set([NULL_ADDR, ADDR.weth.toLowerCase(), ADDR.usdg.toLowerCase()]);
const POOL_FIRST_S = 300, POOL_RETRY_S = [15 * 60, 60 * 60];
const coder = AbiCoder.defaultAbiCoder();
const STOCKS = (() => { try { return new Set(JSON.parse(readFileSync(new URL("./data/robinhood-stocks.json", import.meta.url), "utf8")).stocks.map((x) => x.address.toLowerCase())); } catch { return new Set(); } })();

let store, busy = false, lastPost = 0;
const recent = [];                        // newest first, for /api/sentry/recent
export const recentResults = (n = 5) => recent.slice(0, n);   // for the bot's /sentry

/* ---------- text ---------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// names and symbols are attacker-controlled: drop links, handles, control chars, keep it short
export function cleanName(s, n = 32) {
  let t = String(s ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");
  t = t.replace(/(https?:\/\/|www\.)\S*/gi, "").replace(/\b[\w-]+\.(com|io|xyz|me|org|net|fun|app|gg|co|codes|family|sh|ai)\b\S*/gi, "").replace(/t\.me\/\S*/gi, "").replace(/@\w+/g, "");
  t = t.replace(/\s+/g, " ").trim().slice(0, n);
  return t;
}
export const cleanSymbol = (s) => cleanName(s, 16).replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 16);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (v) => (v == null ? "–" : v < 0.001 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2));

// verdict for a fresh launch: thin depth is expected on a new curve, so it is reported, never the verdict
export function verdict(g) {
  const real = g.checks.filter((c) => c.key !== "depth");
  const fail = real.find((c) => c.status === "fail");
  if (fail) return { v: "failed", why: fail };
  const sell = real.find((c) => c.key === "sell");
  if (sell && sell.status === "skip" && /holds no buyers|too little/i.test(sell.detail)) return { v: "nobuys" };
  const warn = real.find((c) => c.status === "warn");
  if (warn) return { v: "caution", why: warn };
  return { v: "passed" };
}

export function formatPost(r) {
  const head = r.v === "passed" ? "Passed" : r.v === "caution" ? "Caution" : "Failed";
  const sym = r.symbol ? `$${esc(r.symbol)}` : "unnamed";
  const name = r.name && r.name.toUpperCase() !== (r.symbol || "").toUpperCase() ? ` · ${esc(r.name)}` : "";
  const ck = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  const lines = [`<b>${head}</b> · <b>${sym}</b>${name}`];
  if (r.source) lines.push(`New ${esc(r.source)} pool`);
  if (r.v === "failed" || r.v === "caution") lines.push(`${esc(r.why.label)}: ${esc(String(r.why.detail).slice(0, 140))}`);
  const bits = [];
  if (ck.sim) bits.push(`Sim ${ck.sim.status === "pass" ? "ok" : ck.sim.status === "fail" ? "failed" : "skipped"}`);
  if (ck.sell) bits.push(`Test sell ${ck.sell.status === "pass" ? (/partial/i.test(ck.sell.detail) ? "ok (partial)" : "ok") : ck.sell.status === "fail" ? "failed" : "skipped"}`);
  if (ck.tax) bits.push(`Tax ${ck.tax.status === "pass" ? "none" : ck.tax.status === "skip" ? "not measured" : esc(ck.tax.detail)}`);
  if (ck.fee) bits.push(`Fees ${esc(ck.fee.detail)}`);
  if (bits.length) lines.push(bits.join(" · "));
  if (r.pons) lines.push(`Curve ${eth(r.pons.raised)} ${esc(r.pons.pair?.symbol || "ETH")} raised · ${r.pons.progressPct != null ? r.pons.progressPct.toFixed(r.pons.progressPct < 1 ? 2 : 1) : "–"}% to graduation · creator tax ${(r.pons.fees.creatorTaxBps / 100).toFixed(2)}%`);
  lines.push(`<code>${r.token}</code>`);
  return lines.join("\n");
}
const TRADE = process.env.TG_TRADE === "1";
const buttons = (a) => ({ inline_keyboard: [
  ...(TRADE ? [[{ text: "Trade in Telegram", url: `https://t.me/${process.env.TG_BOT_USERNAME || "TrojanTroya_bot"}?start=t_${a}` }]] : []),
  [{ text: "Check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${a}` }, { text: "Pons", url: PONS + a.toLowerCase() }],
] });

const poolButtons = (a) => ({ inline_keyboard: [
  ...(TRADE ? [[{ text: "Trade in Telegram", url: `https://t.me/${process.env.TG_BOT_USERNAME || "TrojanTroya_bot"}?start=t_${a}` }]] : []),
  [{ text: "Check in Troya", url: `${SITE}/agent#/swap?in=eth&out=${a}` }, { text: "DexScreener", url: `https://dexscreener.com/robinhood/${a}` }],
] });

export function formatRecap(d, dayLabel) {
  const checked = d.passed + d.caution + d.failed;
  return `<b>Troya Sentry · ${esc(dayLabel)}</b>

${d.seen} Pons launches${d.pools ? ` and ${d.pools} new Uniswap pools` : ""} seen. ${checked} had buyers and went through Troya Gate:
${d.passed} passed · ${d.caution} caution · ${d.failed} failed
${d.nobuys} had an empty or dust-only curve (no real buys, or every buyer sold), so there was nothing to test.

Every result, one line each: t.me/${CHANNEL.replace(/^@/, "")}
Check any coin yourself: /gate 0x…

Automated checks, not endorsements.`;
}

/* ---------- the coin's logo ---------- */
// Pons keeps each coin's logo URL on chain, almost always an IPFS CID. The image is fetched only from fixed public
// gateways by CID (never from an arbitrary host, so no request can be pointed at our own network), checked for type and
// size, and uploaded with the post; Telegram's file_id is then reused for the same logo. Anything else: text post.
const IMAGES = process.env.SENTRY_IMAGES !== "0";
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/"];
const IMG_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMG = 5 * 1024 * 1024;
const fileIds = new Map();               // cid → Telegram file_id
export function logoCid(logo) {
  const m = /^(?:ipfs:\/\/(?:ipfs\/)?|https:\/\/[^/?#]+\/ipfs\/)([A-Za-z0-9]{46,100})(\/[A-Za-z0-9._-]{1,80})?$/.exec(String(logo || "").trim());
  return m ? m[1] + (m[2] || "") : null;
}
async function fetchLogo(cid) {
  for (const g of GATEWAYS) {
    try {
      const r = await fetch(g + cid, { redirect: "error", signal: AbortSignal.timeout(8000) });
      const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!r.ok || !IMG_TYPES[type] || Number(r.headers.get("content-length") || 0) > MAX_IMG) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || buf.length > MAX_IMG) continue;
      return { buf, type };
    } catch { /* next gateway */ }
  }
  return null;
}
export async function logoFor(token) {
  if (!IMAGES) return null;
  const p = await ponsProfile(token).catch(() => null);
  const cid = logoCid(p?.logo);
  if (!cid) return null;
  if (fileIds.has(cid)) return { cid, fileId: fileIds.get(cid) };
  const img = await fetchLogo(cid);
  return img ? { cid, ...img } : null;
}

/* ---------- telegram ---------- */
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  return r.json();
}
// a photo post: the cached file_id, or the image uploaded as multipart; null when Telegram won't take it
async function sendPhoto(chat, logo, caption, markup) {
  let j;
  if (logo.fileId) j = await tg("sendPhoto", { chat_id: chat, photo: logo.fileId, caption, parse_mode: "HTML", reply_markup: markup });
  else {
    const f = new FormData();
    f.set("chat_id", String(chat)); f.set("caption", caption); f.set("parse_mode", "HTML"); f.set("reply_markup", JSON.stringify(markup));
    f.set("photo", new Blob([logo.buf], { type: logo.type }), `logo.${IMG_TYPES[logo.type]}`);
    j = await fetch(`https://api.telegram.org/bot${TG}/sendPhoto`, { method: "POST", body: f, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  }
  if (j.ok) { const ph = j.result.photo; if (ph?.length) fileIds.set(logo.cid, ph[ph.length - 1].file_id); console.log(`[sentry] posted with logo ${logo.cid.slice(0, 16)}… to ${chat}`); if (fileIds.size > 500) fileIds.delete(fileIds.keys().next().value); return j; }
  if (j.parameters?.retry_after) return j;
  console.warn("[sentry] photo post failed, sending text:", j.description);
  if (logo.fileId) fileIds.delete(logo.cid);
  return null;
}
async function send(chat, text, markup, logo = null) {
  if (MODE === "dry") { await store.append("sentry-preview.jsonl", { t: Date.now(), chat, text, markup, logo: logo?.cid || null }); return { ok: true, dry: true }; }
  const wait = lastPost + 4000 - Date.now();
  if (wait > 0) await new Promise((x) => setTimeout(x, wait));
  lastPost = Date.now();
  const once = async () => (logo && text.length <= 1024 && (await sendPhoto(chat, logo, text, markup))) || tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
  const j = await once();
  if (!j.ok && j.parameters?.retry_after) { await new Promise((x) => setTimeout(x, (j.parameters.retry_after + 1) * 1000)); return once(); }
  return j;
}

/* ---------- state ---------- */
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const blank = () => ({ seen: 0, pools: 0, passed: 0, caution: 0, failed: 0, nobuys: 0 });
// one [time, kind] per event, kept 3 days, so the recap counts exactly the last 24 hours
function bump(s, k) { s.events.push([Date.now(), k]); const cut = Date.now() - 3 * 86400e3; while (s.events.length && s.events[0][0] < cut) s.events.shift(); }
export function countSince(events, since) { const d = blank(); for (const [t, k] of events) if (t >= since && k in d) d[k]++; return d; }

/* ---------- one launch ---------- */
export async function checkLaunch(token) {
  const g = await gateCheck({ tokenIn: "ETH", tokenOut: token, amountIn: TEST_ETH, slippageBps: 100 });
  const ps = await ponsState(token).catch(() => null);
  const pons = ponsPublic(ps);
  let vd = verdict(g);
  if (vd.v !== "failed" && pons && !pons.graduated && pons.pair?.address === "native" && (pons.raised ?? 0) < MIN_RAISED) vd = { v: "nobuys" };
  const t = g.quote?.tokenOut || {};
  return { token, symbol: cleanSymbol(t.symbol), name: cleanName(t.name), checks: g.checks, pons, snipe: !!(ps && ps.snipeBps > 0n), ...vd, at: Date.now() };
}

async function scan(s) {
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  let from = s.lastBlock ? s.lastBlock + 1 : head - CATCHUP;
  if (head - from > MAX_GAP) from = head - CATCHUP;                     // after downtime: don't flood the channel with stale launches
  while (from <= head) {
    const to = Math.min(head, from + MAX_RANGE - 1);
    const logs = await rpc("robinhood", "eth_getLogs", [{ address: ADDR.ponsFactory, topics: [LAUNCH_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }], { timeoutMs: 20000 });
    for (const l of logs || []) {
      const token = "0x" + l.topics[1].slice(26);
      if (s.seen[token]) continue;
      s.seen[token] = Date.now();
      s.queue.push({ token, due: Date.now() + FIRST_CHECK_S * 1000, tries: 0 });
      bump(s, "seen");
    }
    if (POOLS) await scanPools(s, from, to);
    s.lastBlock = to;
    from = to + 1;
  }
  const keep = Object.entries(s.seen).sort((a, b) => b[1] - a[1]).slice(0, 3000);
  s.seen = Object.fromEntries(keep);
}

// coins launched outside Pons: a new hookless Uniswap pool with ETH, WETH or USDG on one side. Pons launches (already
// queued above) and tokenized stocks are skipped; a v4 pool's key is registered so the Gate can route through it at once.
function notePool(s, token, item) {
  const t = token.toLowerCase();
  if (s.seen[t] || STOCKS.has(t) || QUOTES.has(t)) return;
  s.seen[t] = Date.now();
  s.queue.push({ token: t, due: Date.now() + POOL_FIRST_S * 1000, tries: 0, kind: "pool", ...item });
  bump(s, "pools");
}
async function scanPools(s, from, to) {
  const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
  const [v4, v3] = await Promise.all([
    rpc("robinhood", "eth_getLogs", [{ address: ADDR.poolManager, topics: [T_V4_INIT], ...range }], { timeoutMs: 20000 }),
    rpc("robinhood", "eth_getLogs", [{ address: ADDR.v3Factory, topics: [T_V3_CREATED], ...range }], { timeoutMs: 20000 }),
  ]);
  for (const l of v4 || []) {
    const c0 = "0x" + l.topics[2].slice(26), c1 = "0x" + l.topics[3].slice(26);
    const [fee, ts, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], l.data);
    if (hooks !== NULL_ADDR && hooks.toLowerCase() !== NULL_ADDR) continue;            // hooked pools (Pons graduations and others) are left out
    const q0 = QUOTES.has(c0), q1 = QUOTES.has(c1);
    if (q0 === q1) continue;
    addV4Key(l.topics[1], { c0: getAddress(c0), c1: getAddress(c1), fee: Number(fee), ts: Number(ts), hooks: getAddress(hooks), liq: 1 });
    notePool(s, q0 ? c1 : c0, { source: "Uniswap v4", pool: l.topics[1] });
  }
  for (const l of v3 || []) {
    const t0 = "0x" + l.topics[1].slice(26), t1 = "0x" + l.topics[2].slice(26);
    const q0 = QUOTES.has(t0), q1 = QUOTES.has(t1);
    if (q0 === q1) continue;
    const [, pool] = coder.decode(["int24", "address"], l.data);
    notePool(s, q0 ? t1 : t0, { source: "Uniswap v3", pool });
  }
}

async function work(s) {
  const now = Date.now();
  const due = s.queue.filter((q) => q.due <= now).slice(0, 4);
  for (const q of due) {
    let r;
    try { r = await checkLaunch(q.token); }
    catch (e) { q.due = now + 60000; q.err = (q.err || 0) + 1; if (q.err >= 3) s.queue = s.queue.filter((x) => x !== q); console.warn("[sentry]", q.token, e.message); continue; }
    if (q.kind === "pool") {
      if (r.pons) { s.queue = s.queue.filter((x) => x !== q); continue; }                 // a Pons coin: its launch is covered already
      const ck = Object.fromEntries(r.checks.map((c) => [c.key, c]));
      const ready = ck.route?.status === "pass" && (ck.depth?.status === "pass" || ck.depth?.status === "warn");
      if (!ready || r.v === "nobuys") {
        if (q.tries < POOL_RETRY_S.length) { q.due = now + POOL_RETRY_S[q.tries] * 1000; q.tries++; continue; }
        s.queue = s.queue.filter((x) => x !== q); continue;                               // never reached real depth: dropped quietly
      }
      s.queue = s.queue.filter((x) => x !== q);
      r.source = q.source;
      if (POOLS === "dry") { await store.append("sentry-pools-preview.jsonl", { t: Date.now(), token: r.token, pool: q.pool, text: formatPost(r) }); continue; }
      const jp = await send(CHANNEL, formatPost(r), poolButtons(r.token), null).catch((e) => ({ ok: false, description: e.message }));
      if (!jp.ok) console.warn("[sentry] pool post failed:", jp.description);
      if (MODE !== "dry") holderDms(r, null).catch((e) => console.warn("[sentry] holder DMs:", e.message));
      bump(s, r.v);
      recent.unshift({ token: r.token, symbol: r.symbol, name: r.name, verdict: r.v, source: r.source, reason: r.why ? `${r.why.label}: ${r.why.detail}` : null, raised: null, progressPct: null, at: r.at, post: jp.result?.message_id ? `https://t.me/${CHANNEL.replace(/^@/, "")}/${jp.result.message_id}` : null });
      recent.length = Math.min(recent.length, 200);
      s.recent = recent.slice(0, 200);
      continue;
    }
    if (r.snipe && q.tries < 3) { q.due = now + 60000; q.tries++; continue; }
    if (r.v === "nobuys") {
      if (q.tries < RETRY_S.length) { q.due = now + RETRY_S[q.tries] * 1000; q.tries++; continue; }
      s.queue = s.queue.filter((x) => x !== q); bump(s, "nobuys"); continue;
    }
    s.queue = s.queue.filter((x) => x !== q);
    const logo = await logoFor(r.token).catch(() => null);
    const j = await send(CHANNEL, formatPost(r), buttons(r.token), logo).catch((e) => ({ ok: false, description: e.message }));
    if (!j.ok) console.warn("[sentry] post failed:", j.description);
    if (MODE !== "dry") holderDms(r, logo && fileIds.has(logo.cid) ? { cid: logo.cid, fileId: fileIds.get(logo.cid) } : null).catch((e) => console.warn("[sentry] holder DMs:", e.message));
    // Phase 7: Sentry Autopilot acts on every launch that passed
    if (MODE !== "dry" && r.v === "passed") import("./autopilot.mjs").then((a) => a.onLaunch(r)).catch((e) => console.warn("[sentry] autopilot:", e.message));
    bump(s, r.v);
    recent.unshift({ token: r.token, symbol: r.symbol, name: r.name, verdict: r.v, reason: r.why ? `${r.why.label}: ${r.why.detail}` : null, raised: r.pons?.raised ?? null, progressPct: r.pons?.progressPct ?? null, at: r.at, post: j.result?.message_id ? `https://t.me/${CHANNEL.replace(/^@/, "")}/${j.result.message_id}` : null });
    recent.length = Math.min(recent.length, 200);
    s.recent = recent.slice(0, 200);                                   // survives restarts
  }
}

// Phase 3: linked $TROYA holders get each result as a private message too (the bot can only DM people who started it)
async function holderDms(r, logo) {
  const hp = await import("./holders.mjs").catch(() => null);
  if (!hp) return;
  const kb = r.source ? poolButtons(r.token) : buttons(r.token);
  for (const chat of await hp.holderChats()) {
    const sent = logo ? await sendPhoto(chat, logo, formatPost(r), kb).catch(() => null) : null;
    if (!sent?.ok) await tg("sendMessage", { chat_id: chat, text: formatPost(r), parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
    await new Promise((x) => setTimeout(x, 60));
  }
}

async function recap(s) {
  const now = new Date();
  if (now.getUTCHours() !== RECAP_HOUR) return;
  const today = dayKey();
  if (s.recapSent === today) return;
  const d = countSince(s.events, Date.now() - 86400e3);
  s.recapSent = today;
  if (!d.seen) return;
  const j = await send(RECAP_CHAT, formatRecap(d, "last 24 hours"), { inline_keyboard: [[{ text: "Open Troya Sentry", url: `https://t.me/${CHANNEL.replace(/^@/, "")}` }]] }).catch((e) => ({ ok: false, description: e.message }));
  if (!j.ok) console.warn("[sentry] recap failed:", j.description);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await store.readJson(STATE, { lastBlock: 0, seen: {}, queue: [], events: [], recapSent: null });
    s.events ||= [];
    await scan(s).catch((e) => console.warn("[sentry] scan:", e.message));
    await work(s);
    await recap(s).catch((e) => console.warn("[sentry] recap:", e.message));
    await store.writeJson(STATE, s);
  } finally { busy = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  recent.push(...((await store.readJson(STATE, {})).recent || []));
  r.get("/api/sentry/recent", ({ query }) => ({ items: recent.slice(0, Math.min(100, Number(query.limit) || 30)), channel: `https://t.me/${CHANNEL.replace(/^@/, "")}`, live: !!MODE }));
  if (!MODE || (MODE !== "dry" && !TG)) return;
  console.log(`[sentry] watching Pons launches → ${MODE === "dry" ? "data/sentry-preview.jsonl (dry)" : CHANNEL}`);
  setTimeout(() => tick().catch(() => {}), 5000).unref();
  setInterval(() => tick().catch(() => {}), 15000).unref();
}
