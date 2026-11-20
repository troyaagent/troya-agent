// Token age (asked for in the Telegram group by lynx_evo, 20 Nov 2026: "add information about token age").
// When a coin was born, read from the chain: the block of the transaction that created the token contract (Blockscout
// names it), cached for good because a birth never changes. The market board's createdAt is the date of the coin's main
// pool, so a Pons coin that graduated to Uniswap looked as old as its graduation ($TROYA read 4 days on 20 Nov; it
// launched on 14 Nov). When Blockscout cannot say, the board's pool date is the fallback and is marked as such.
//   GET  /api/token-age/:token          → { address, bornAt, source: "creation" | "pool" | null }
//   POST /api/token-age  { addresses }  → { ages: { address: bornAt | null } } (up to 60; unknown ones are looked up in
//                                           the background, so a second call a few seconds later fills them in)
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { isAddress } from "ethers";
import { HttpError } from "./api.mjs";
import { rpc } from "./robinhood.mjs";

const lc = (s) => String(s || "").toLowerCase();
const RETRY_MS = 6 * 3600_000;          // an unknown birth is asked again after 6 hours, a pool-date fallback after 1 day
const born = new Map();                 // address → { at, src, tried }
const pending = new Map();
let file = null, saveT = null, active = 0;
const waiters = [];

async function slot(fn) {               // at most 4 lookups at a time (Blockscout spaces its own calls too)
  if (active >= 4) await new Promise((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}
async function blockTime(n) {
  const b = await rpc("robinhood", "eth_getBlockByNumber", ["0x" + n.toString(16), false], { timeoutMs: 10_000 }).catch(() => null);
  return b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : 0;
}
async function lookup(a) {
  const m = await import("./market.mjs");
  if (m.hasBlockscout()) {
    const info = await m.blockscoutApi(`/addresses/${a}`).catch(() => null);
    const tx = info?.creation_transaction_hash || info?.creation_tx_hash;
    if (tx) {
      const t = await rpc("robinhood", "eth_getTransactionByHash", [tx], { timeoutMs: 10_000 }).catch(() => null);
      const at = t?.blockNumber ? await blockTime(Number(BigInt(t.blockNumber))) : 0;
      if (at) return { at, src: "creation" };
    }
  }
  const row = m.indexRow?.(a);
  return row?.createdAt ? { at: Number(row.createdAt), src: "pool" } : null;
}
function save() {
  if (!file || saveT) return;
  saveT = setTimeout(async () => {
    saveT = null;
    try { await writeFile(file + ".tmp", JSON.stringify(Object.fromEntries(born))); await rename(file + ".tmp", file); } catch {}
  }, 5000);
  saveT.unref?.();
}
function fresh(c) { return c && (c.src === "creation" || Date.now() - (c.tried || 0) < (c.src === "pool" ? 4 * RETRY_MS : RETRY_MS)); }

/** When the coin was born (ms), or null. waitMs = 0 only starts the lookup and answers from the cache. */
export async function bornAt(address, { waitMs = 6000 } = {}) {
  const a = lc(address);
  if (!isAddress(a)) return null;
  const c = born.get(a);
  if (fresh(c)) return c.at || null;
  let p = pending.get(a);
  if (!p) {
    p = slot(() => lookup(a)).then((r) => {
      born.set(a, r ? { at: r.at, src: r.src, tried: Date.now() } : { at: c?.at || 0, src: c?.src || null, tried: Date.now() });
      save();
      return r?.at || c?.at || null;
    }).catch(() => c?.at || null).finally(() => pending.delete(a));
    pending.set(a, p);
  }
  if (!waitMs) return c?.at || null;
  return Promise.race([p, new Promise((r) => setTimeout(() => r(c?.at || null), waitMs).unref?.())]);
}
export const bornSource = (address) => born.get(lc(address))?.src || null;

/** "6d 2h", "3h 12m", "12m" */
export function ageText(ms) {
  if (!ms) return null;
  const m = Math.max(1, Math.floor((Date.now() - ms) / 60_000));
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh < 48) return `${hh}h ${m % 60}m`;
  return `${Math.floor(hh / 24)}d ${hh % 24}h`;
}

export async function register(r, ctx = {}) {
  if (ctx.dataDir) {
    file = join(ctx.dataDir, "token-birth.json");
    try { for (const [a, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")) || {})) born.set(a, v); } catch {}
  }
  r.get("/api/token-age/:token", async ({ params }) => {
    if (!isAddress(String(params.token || ""))) throw new HttpError(400, "That is not a token address.");
    const at = await bornAt(params.token);
    return { address: lc(params.token), bornAt: at, source: at ? bornSource(params.token) : null };
  }, { weight: 1, perMin: 60 });
  r.post("/api/token-age", async ({ body }) => {
    const list = [...new Set((Array.isArray(body?.addresses) ? body.addresses : []).map(lc).filter((a) => isAddress(a)))].slice(0, 60);
    const ages = {};
    await Promise.all(list.map(async (a) => { ages[a] = await bornAt(a, { waitMs: 0 }); }));
    return { ages };
  }, { weight: 1, perMin: 30 });
}
