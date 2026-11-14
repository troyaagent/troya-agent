// API tokens for MCP and REST. Shown once, stored as sha256 hashes in data/apitokens.json.
// Scopes: read (always), prepare (always), execute (opt-in per token; still dry-run until the user turns dry-run off).
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

let store;
const sha = (s) => createHash("sha256").update(s).digest("hex");
let cache = null;
async function all() { if (!cache) cache = await store.readJson("apitokens.json", []); return cache; }
async function save(list) { cache = list; await store.writeJson("apitokens.json", list); }

export async function optionalApiToken(req) {
  const raw = String(req.headers["x-api-key"] || "").trim();
  if (!raw) return null;
  if (!/^troya_[A-Za-z0-9_-]{20,80}$/.test(raw)) throw new HttpError(401, "This API token is not valid.");
  const h = Buffer.from(sha(raw), "hex");
  const t = (await all()).find((x) => !x.revoked && timingSafeEqual(Buffer.from(x.hash, "hex"), h));
  if (!t) throw new HttpError(401, "This API token is not valid or was revoked.");
  const now = Date.now();
  if (!t.lastUsedAt || now - t.lastUsedAt > 60_000) { t.lastUsedAt = now; save(cache).catch(() => {}); }
  return { address: t.address, scopes: t.scopes, id: t.id, name: t.name, dryRun: t.dryRun !== false };
}
export async function requireApiToken(req) {
  const t = await optionalApiToken(req);
  if (!t) throw new HttpError(401, "Send your API token in the x-api-key header.");
  return t;
}

// Idempotency for execution routes: the same key returns the same result for 24 h.
const idem = new Map();
export function idempotent(tokenId, key) {
  if (!key || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new HttpError(400, "Execution routes need an Idempotency-Key header (8–100 characters).");
  const k = `${tokenId}:${key}`;
  const now = Date.now();
  for (const [kk, v] of idem) if (now - v.t > 86400_000) idem.delete(kk);
  return {
    get: () => idem.get(k)?.result,
    set: (result) => idem.set(k, { t: now, result }),
  };
}

export async function register(r, ctx) {
  store = ctx.store;

  r.get("/api/agent-api/tokens", async ({ req }) => {
    const s = requireSession(req);
    const list = (await all()).filter((t) => t.address === s.address.toLowerCase() && !t.revoked);
    return { items: list.map(({ hash, ...t }) => t) };
  });
  r.post("/api/agent-api/tokens", async ({ req, body }) => {
    const s = requireSession(req);
    const list = await all();
    if (list.filter((t) => t.address === s.address.toLowerCase() && !t.revoked).length >= 10) throw new HttpError(400, "You already have 10 active tokens. Revoke one first.");
    const token = `troya_${randomBytes(24).toString("base64url")}`;
    const rec = {
      id: randomBytes(6).toString("hex"),
      address: s.address.toLowerCase(),
      name: String(body.name || "My agent").replace(/[^\w .-]/g, "").slice(0, 40) || "My agent",
      prefix: token.slice(0, 12),
      hash: sha(token),
      scopes: ["read", "prepare", ...(body.execute ? ["execute"] : [])],
      dryRun: true, // every token starts in dry-run; the owner switches it off per token
      createdAt: Date.now(),
      lastUsedAt: null,
      revoked: false,
    };
    await save([...list, rec]);
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "api-token", summary: `API token "${rec.name}" created (${rec.scopes.join(", ")})`, source: "app" });
    const { hash, ...pub } = rec;
    return { token, item: pub, note: "Copy this token now. It will not be shown again." };
  });
  // dry-run is switched per token (only tokens with the execute scope can go live)
  r.post("/api/agent-api/tokens/dry-run", async ({ req, body }) => {
    const s = requireSession(req);
    const list = await all();
    const t = list.find((x) => x.id === body.id && x.address === s.address.toLowerCase() && !x.revoked);
    if (!t) throw new HttpError(404, "Token not found.");
    if (body.dryRun === false && !t.scopes.includes("execute")) throw new HttpError(400, "This token has no execute scope. Create a token with execution allowed.");
    t.dryRun = body.dryRun !== false;
    await save(list);
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "api-token", summary: `API token "${t.name}": dry-run ${t.dryRun ? "on" : "off (live execution)"}`, source: "app" });
    const { hash, ...pub } = t;
    return { item: pub };
  });
  r.post("/api/agent-api/tokens/revoke", async ({ req, body }) => {
    const s = requireSession(req);
    const list = await all();
    const t = list.find((x) => x.id === body.id && x.address === s.address.toLowerCase());
    if (!t) throw new HttpError(404, "Token not found.");
    t.revoked = true;
    t.revokedAt = Date.now();
    await save(list);
    const { logAction } = await import("./journal.mjs");
    await logAction({ address: s.address, kind: "api-token", summary: `API token "${t.name}" revoked`, source: "app" });
    return { ok: true };
  });
}
