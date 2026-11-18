// V7 F35 Seal: a signed, hash-chained receipt for every decision Troya makes (Gate checks, paid checks over x402 and
// Virtuals ACP, Sentry calls, and later Council verdicts, Aegis exits and Arena trades).
//
// Each receipt is { v, seq, at, kind, subject, ref, digest, prev } and its hash is keccak256 of that JSON. It is signed twice:
//   · ECDSA by the Troya attestor (EIP-191 over "Troya Seal\n<hash>"), the same key that signs Gate results
//   · ML-DSA-65 (FIPS 204, post-quantum) over the 32 hash bytes, with a key made on the server and kept encrypted
// `prev` links every receipt to the one before it, so one hash commits the whole history up to it. Once a day the last
// hash of the previous day is anchored on Robinhood Chain (a 0-value transaction to the attestor address with the hash in its
// data, gas from Troya's sponsor wallet), so nobody, Troya included, can rewrite a day after it closes.
//   GET  /api/seal                    head, counts per day, anchors, both public keys, how to verify
//   GET  /api/seal/receipts?day=&limit=   receipts of a day, newest first
//   GET  /api/seal/r/:hash            one receipt
//   POST /api/seal/verify             { receipt } → hash, ECDSA, ML-DSA and link checks
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as pqSign, verify as pqVerify, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { keccak256, toUtf8Bytes, verifyMessage, getBytes, isHexString } from "ethers";
import { HttpError } from "./api.mjs";

const FILE = "seal.json", LABEL = "Troya Seal";
let store = null, dir = null, keys = null, queue = Promise.resolve();
const recent = new Map();                       // hash → receipt (the last few thousand, for quick lookups)
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const lc = (s) => String(s || "").toLowerCase();
const short = (v, n = 160) => (typeof v === "string" && v.length > n ? v.slice(0, n) : v);

/* ---------- the post-quantum key (ML-DSA-65), encrypted at rest like the attestor key ---------- */
async function masterKey() {
  const f = join(dir, "seal.key");
  try { const k = await readFile(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32); await writeFile(f, k, { mode: 0o600 }); return k;
}
async function pqKeys() {
  if (keys) return keys;
  const f = join(dir, "seal-pq.json");
  try {
    const j = JSON.parse(await readFile(f, "utf8"));
    const d = createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(j.iv, "hex")); d.setAuthTag(Buffer.from(j.tag, "hex"));
    const priv = createPrivateKey({ key: Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]), format: "der", type: "pkcs8" });
    keys = { priv, pub: createPublicKey(priv), pubB64: j.pub };
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync("ml-dsa-65");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", await masterKey(), iv);
    const ct = Buffer.concat([c.update(der), c.final()]);
    const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await writeFile(f, JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex"), pub: pubB64, alg: "ML-DSA-65", at: Date.now() }), { mode: 0o600 });
    keys = { priv: privateKey, pub: publicKey, pubB64 };
  }
  return keys;
}

const core = (r) => ({ v: r.v, seq: r.seq, at: r.at, kind: r.kind, subject: r.subject, ref: r.ref, digest: r.digest, prev: r.prev });
const hashOf = (r) => keccak256(toUtf8Bytes(JSON.stringify(core(r))));
const message = (hash) => `${LABEL}\n${hash}`;

/** Seal one decision. payload is hashed into `digest` (pass a hash string to use it as is). Never throws to the caller. */
export function seal(kind, subject, payload, ref = null) {
  if (!store) return Promise.resolve(null);
  const run = queue.then(async () => {
    const gate = await import("./gateapi.mjs");
    const st = await store.readJson(FILE, {});
    const digest = typeof payload === "string" && isHexString(payload, 32) ? payload : keccak256(toUtf8Bytes(JSON.stringify(payload ?? null)));
    const r = { v: 1, seq: (st.seq || 0) + 1, at: Date.now(), kind: String(kind), subject: short(String(subject || "")), ref: ref ? short(String(ref)) : null, digest, prev: st.head || null };
    const hash = hashOf(r);
    const ecdsa = await gate.attest(core(r), LABEL);                       // signs keccak256(JSON) = hash
    if (ecdsa.hash !== hash) throw new Error("seal hash mismatch");
    const k = await pqKeys();
    const mldsa = pqSign(null, Buffer.from(getBytes(hash)), k.priv).toString("base64");
    const rec = { ...r, hash, sig: { ecdsa: ecdsa.signature, attestor: ecdsa.attestor, mldsa } };
    const d = day(r.at);
    await mkdir(join(dir, "seal"), { recursive: true });
    await appendFile(join(dir, "seal", `${d}.jsonl`), JSON.stringify(rec) + "\n");
    await store.update(FILE, {}, (s) => {
      s.seq = r.seq; s.head = hash; s.days ||= {};
      const dd = (s.days[d] ||= { count: 0, first: hash });
      dd.count++; dd.last = hash; dd.kinds ||= {}; dd.kinds[r.kind] = (dd.kinds[r.kind] || 0) + 1;
      return s;
    });
    recent.set(hash, rec); if (recent.size > 5000) recent.delete(recent.keys().next().value);
    return rec;
  });
  queue = run.catch((e) => console.warn("[seal]", e.message));
  return run.catch(() => null);
}

async function readDay(d) {
  try { return (await readFile(join(dir, "seal", `${d}.jsonl`), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

/** Every check a third party can run on a receipt: the hash, both signatures, and the link to the receipt before it. */
export async function verifyReceipt(rec) {
  const out = { hash: false, ecdsa: false, mldsa: false, linked: null };
  if (!rec || typeof rec !== "object") return out;
  const h = hashOf(rec);
  out.hash = h === rec.hash;
  try { out.ecdsa = lc(verifyMessage(message(h), rec.sig?.ecdsa)) === lc(await (await import("./gateapi.mjs")).attestorAddress()); } catch {}
  try { out.mldsa = pqVerify(null, Buffer.from(getBytes(h)), (await pqKeys()).pub, Buffer.from(String(rec.sig?.mldsa || ""), "base64")); } catch {}
  if (rec.prev) {
    const prev = recent.get(rec.prev) || (await readDay(day(rec.at))).find((x) => x.hash === rec.prev) || (await readDay(day(rec.at - 86_400_000))).find((x) => x.hash === rec.prev);
    out.linked = !!prev && prev.seq === rec.seq - 1;
  } else out.linked = rec.seq === 1;
  out.valid = out.hash && out.ecdsa && out.mldsa && out.linked !== false;
  return out;
}

/* ---------- daily anchor on Robinhood Chain ---------- */
async function anchorTick() {
  if (process.env.SEAL_ANCHOR === "0") return;
  const st = await store.readJson(FILE, {});
  const y = day(Date.now() - 86_400_000);
  const dd = st.days?.[y];
  if (!dd || dd.anchorTx || !dd.last) return;
  const gate = await import("./gateapi.mjs");
  const to = await gate.attestorAddress();
  const data = "0x" + Buffer.from(`TROYA-SEAL ${y} `).toString("hex") + dd.last.slice(2);
  try {
    const out = await (await import("./gas.mjs")).sponsorTx({ to, data, kind: "seal-anchor", maxEth: 0.0002 });
    if (out.status === 1) {
      await store.update(FILE, {}, (s) => { s.days[y].anchorTx = out.hash; s.days[y].anchoredAt = Date.now(); s.lastAnchor = { day: y, tx: out.hash, head: dd.last }; return s; });
      console.log(`[seal] anchored ${y} (${dd.count} receipts) tx ${out.hash}`);
    }
  } catch (e) { console.warn("[seal] anchor", e.message); }
}

export async function register(r, ctx) {
  store = ctx.store; dir = ctx.dataDir;
  pqKeys().catch((e) => console.warn("[seal] pq key", e.message));
  setTimeout(() => anchorTick().catch(() => {}), 60_000);
  setInterval(() => anchorTick().catch(() => {}), 30 * 60_000).unref();

  r.get("/api/seal", async () => {
    const st = await store.readJson(FILE, {});
    const k = await pqKeys();
    const days = Object.entries(st.days || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30)
      .map(([d, v]) => ({ day: d, count: v.count, kinds: v.kinds || {}, last: v.last, anchorTx: v.anchorTx || null, anchorUrl: v.anchorTx ? `https://robinhoodchain.blockscout.com/tx/${v.anchorTx}` : null }));
    return {
      name: "Troya Seal", seq: st.seq || 0, head: st.head || null, today: st.days?.[day()]?.count || 0, days, lastAnchor: st.lastAnchor || null,
      keys: { ecdsa: await (await import("./gateapi.mjs")).attestorAddress(), mldsa: { alg: "ML-DSA-65 (FIPS 204)", spkiBase64: k.pubB64 } },
      verify: "hash = keccak256(JSON.stringify({v,seq,at,kind,subject,ref,digest,prev})); sig.ecdsa = EIP-191 over \"Troya Seal\\n<hash>\" by keys.ecdsa; sig.mldsa = ML-DSA-65 over the 32 hash bytes with keys.mldsa; prev = hash of receipt seq-1. Or POST { receipt } to /api/seal/verify.",
    };
  }, { weight: 1 });

  r.get("/api/seal/receipts", async ({ query }) => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(query.day || "")) ? query.day : day();
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const kind = query.kind ? String(query.kind) : null;
    const list = (await readDay(d)).filter((x) => !kind || x.kind === kind).reverse().slice(0, limit);
    return { day: d, count: list.length, receipts: list };
  }, { weight: 2 });

  r.get("/api/seal/r/:hash", async ({ params }) => {
    if (!isHexString(params.hash, 32)) throw new HttpError(400, "That is not a receipt hash.");
    const h = lc(params.hash);
    let rec = recent.get(h);
    for (let i = 0; !rec && i < 7; i++) rec = (await readDay(day(Date.now() - i * 86_400_000))).find((x) => x.hash === h);
    if (!rec) throw new HttpError(404, "No receipt with that hash in the last 7 days.");
    return { receipt: rec, check: await verifyReceipt(rec) };
  }, { weight: 2 });

  r.post("/api/seal/verify", async ({ body }) => ({ check: await verifyReceipt(body?.receipt || body) }), { weight: 2 });
}
