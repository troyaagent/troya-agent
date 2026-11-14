// Same-origin API client. Session is a cookie set by /api/auth/verify.
export class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function req(method, path, body, opts = {}) {
  const url = path.startsWith("/") ? path : `/api/${path}`;
  const init = { method, credentials: "same-origin", headers: {}, signal: opts.signal };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) { init.body = body; init.headers["content-type"] = opts.type || "application/octet-stream"; }
    else { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  }
  let res;
  try { res = await fetch(url, init); }
  catch (e) { if (e.name === "AbortError") throw e; throw new ApiError(0, "Network error: the Troya server could not be reached."); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  return data;
}

export const api = {
  get: (p, o) => req("GET", p, undefined, o),
  post: (p, b, o) => req("POST", p, b ?? {}, o),
  del: (p, b, o) => req("DELETE", p, b, o),
};

// tiny in-memory cache for GETs that many pages share (prices, market lists)
const cache = new Map();
export async function cached(path, ttl = 15000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = api.get(path).catch((e) => { cache.delete(path); throw e; });
  cache.set(path, { t: Date.now(), p });
  return p;
}

// Server-sent events over fetch (POST body allowed). onEvent(type, data)
export async function stream(path, body, onEvent, signal) {
  const res = await fetch(`/api/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { onEvent(type, JSON.parse(data)); } catch { onEvent(type, data); }
    }
  }
}
