// Audit journal: every action (or attempted action) with the reason behind it. JSONL at data/journal.jsonl.
import { randomBytes } from "node:crypto";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

let store;
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

export async function logAction({ address, kind, summary, rationale = "", data = null, status = "ok", source = "server" }) {
  const rec = {
    id: randomBytes(8).toString("hex"),
    t: Date.now(),
    address: address ? String(address).toLowerCase() : null,
    kind: clip(kind, 40),
    summary: clip(summary, 300),
    rationale: clip(rationale, 600),
    status: clip(status, 20),
    source: clip(source, 30),
    data: data ?? null,
  };
  if (store) await store.append("journal.jsonl", rec);
  return rec;
}

export async function readJournal(address, { limit = 100, kind } = {}) {
  const a = String(address || "").toLowerCase();
  return store.tail("journal.jsonl", Math.min(500, limit), (r) => r.address === a && (!kind || String(r.kind).startsWith(kind)));
}

export async function register(r, ctx) {
  store = ctx.store;

  r.get("/api/journal", async ({ req, query }) => {
    const s = requireSession(req);
    const items = await readJournal(s.address, { limit: Number(query.limit) || 100, kind: query.kind });
    return { items };
  });

  // The app reports actions the user signed in their own wallet (swaps, bridges, launches) so the journal is complete.
  r.post("/api/journal", async ({ req, body }) => {
    const s = requireSession(req);
    if (!body.kind || !body.summary) throw new HttpError(400, "kind and summary are required.");
    const hash = body.hash && /^0x[0-9a-fA-F]{64}$/.test(body.hash) ? body.hash : null;
    let data = body.data && typeof body.data === "object" ? body.data : null;
    if (data && JSON.stringify(data).length > 4000) data = { note: "data too large, dropped" };
    const rec = await logAction({ address: s.address, kind: body.kind, summary: body.summary, rationale: "Reported by the app after you signed in your wallet.", data: { ...(data || {}), hash }, status: body.status || "submitted", source: "reported by app" });
    return { item: rec };
  });
}
