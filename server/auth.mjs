// Wallet sign-in: nonce message (SIWE-style) → personal_sign → session cookie "troya_sid".
// Sessions are stored hashed in data/sessions.json and last 7 days.
import { randomBytes, createHash } from "node:crypto";
import { verifyMessage, getAddress, isAddress } from "ethers";
import { HttpError } from "./api.mjs";

const SESSION_DAYS = 7;
const NONCE_TTL = 10 * 60 * 1000;
const COOKIE = "troya_sid";
const sha = (s) => createHash("sha256").update(s).digest("hex");

let store;
let sessions = {}; // hash → { address, since, exp }
const challenges = new Map(); // `${purpose}:${address}` → { message, exp }

export function normAddress(a) {
  if (!a || !isAddress(String(a))) throw new HttpError(400, "A valid wallet address is required.");
  return getAddress(String(a));
}

function hostOf(req) {
  const h = String(req.headers["x-forwarded-host"] && process.env.TRUST_PROXY === "1" ? req.headers["x-forwarded-host"] : req.headers.host || "localhost").split(",")[0].trim();
  return h.replace(/[^a-zA-Z0-9.:\-\[\]]/g, "").slice(0, 120) || "localhost";
}
function isHttps(req) {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0") return false;
  return process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-proto"] || "").includes("https");
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Builds a sign-in style message. `purpose` lets other modules ask for a fresh signature (e.g. key export).
export function makeChallenge(req, address, purpose = "sign-in", statement) {
  const addr = normAddress(address);
  const host = hostOf(req);
  const proto = isHttps(req) ? "https" : "http";
  const now = new Date();
  const exp = new Date(now.getTime() + NONCE_TTL);
  const nonce = randomBytes(12).toString("hex");
  const text = statement || (purpose === "sign-in"
    ? "Sign in to Troya Agent. This signature only proves you own this wallet. It sends nothing and costs no gas."
    : `Confirm: ${purpose}. This signature sends nothing and costs no gas.`);
  const message = `${host} wants you to sign in with your Ethereum account:\n${addr}\n\n${text}\n\nURI: ${proto}://${host}\nVersion: 1\nChain ID: 4663\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${exp.toISOString()}\nRequest ID: ${purpose}`;
  challenges.set(`${purpose}:${addr.toLowerCase()}`, { message, exp: exp.getTime() });
  if (challenges.size > 20000) for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  return message;
}

// Verifies and consumes a challenge. Returns the checksummed address.
export function consumeChallenge(address, purpose, message, signature) {
  const addr = normAddress(address);
  const key = `${purpose}:${addr.toLowerCase()}`;
  const c = challenges.get(key);
  if (!c || c.message !== String(message || "")) throw new HttpError(401, "This sign-in request is unknown or was replaced. Request a new one.");
  if (c.exp < Date.now()) { challenges.delete(key); throw new HttpError(401, "This sign-in request expired. Request a new one."); }
  let recovered;
  try { recovered = verifyMessage(c.message, String(signature || "")); } catch { throw new HttpError(401, "The signature could not be read."); }
  if (recovered.toLowerCase() !== addr.toLowerCase()) throw new HttpError(401, "The signature does not match this wallet.");
  challenges.delete(key);
  return addr;
}

async function persist() {
  const now = Date.now();
  for (const [k, v] of Object.entries(sessions)) if (v.exp < now) delete sessions[k];
  await store.writeJson("sessions.json", sessions);
}

export function getSession(req) {
  const id = cookies(req)[COOKIE];
  if (!id || id.length < 20) return null;
  const s = sessions[sha(id)];
  if (!s || s.exp < Date.now()) return null;
  return { address: s.address, since: s.since };
}
export function requireSession(req) {
  const s = getSession(req);
  if (!s) throw new HttpError(401, "Sign in with your wallet first.");
  return s;
}

function setCookie(res, req, id, maxAge) {
  const parts = [`${COOKIE}=${id}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

export async function register(r, ctx) {
  store = ctx.store;
  sessions = await store.readJson("sessions.json", {});

  r.post("/api/auth/nonce", ({ req, body }) => ({ message: makeChallenge(req, body.address, "sign-in") }));

  r.post("/api/auth/verify", async ({ req, res, body }) => {
    const address = consumeChallenge(body.address, "sign-in", body.message, body.signature);
    const id = randomBytes(32).toString("base64url");
    const since = Date.now();
    sessions[sha(id)] = { address, since, exp: since + SESSION_DAYS * 86400_000 };
    await persist();
    setCookie(res, req, id, SESSION_DAYS * 86400);
    return { address, since };
  });

  r.get("/api/me", ({ req }) => {
    const s = getSession(req);
    if (!s) throw new HttpError(401, "Not signed in.");
    return s;
  });

  r.post("/api/auth/logout", async ({ req, res }) => {
    const id = cookies(req)[COOKIE];
    if (id && sessions[sha(id)]) { delete sessions[sha(id)]; await persist(); }
    setCookie(res, req, "", 0);
    return { ok: true };
  });
}
