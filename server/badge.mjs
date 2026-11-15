// Phase 4 · the Troya Gate badge for Pons devs: a live SVG for any Robinhood Chain coin, and the page it links to.
//   GET /api/badge/:address.svg   SVG, re-checked at most every 10 minutes per coin
//   GET /api/badge/:address       the same result as JSON (checks, verdict, time)
// The verdict is Sentry's: route, simulation, test sell, transfer tax and fees decide; a thin young curve is reported,
// not failed. The badge says what was checked and when. It never says "safe", and a coin can change after a check.
import { checkLaunch } from "./sentry.mjs";

const TTL = 10 * 60_000;
const memo = new Map();                       // address → { at, p }
const ADDR = /^(0x[0-9a-fA-F]{40})(\.svg)?$/;
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function result(a) {
  const k = a.toLowerCase(), hit = memo.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = checkLaunch(a).then((r) => ({
    token: r.token, symbol: r.symbol, name: r.name, verdict: r.v === "nobuys" ? "untested" : r.v,
    reason: r.why ? `${r.why.label}: ${r.why.detail}` : null,
    checks: r.checks.map((c) => ({ key: c.key, label: c.label, status: c.status, detail: c.detail })),
    curve: r.pons && !r.pons.graduated ? { raised: r.pons.raised, pair: r.pons.pair?.symbol || "ETH", progressPct: r.pons.progressPct } : null,
    checkedAt: r.at,
  }));
  memo.set(k, { at: Date.now(), p });
  p.catch(() => memo.delete(k));
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return p;
}

const LOOK = {
  passed: { word: "PASSED", fg: "#5fd38d", bg: "rgba(95,211,141,.14)" },
  caution: { word: "CAUTION", fg: "#f2c26b", bg: "rgba(242,194,107,.14)" },
  failed: { word: "FAILED", fg: "#f0606d", bg: "rgba(240,96,109,.14)" },
  untested: { word: "NOT TESTED YET", fg: "#9fb0bf", bg: "rgba(159,176,191,.12)" },
  error: { word: "UNAVAILABLE", fg: "#9fb0bf", bg: "rgba(159,176,191,.12)" },
};
// the mark inside the shield: a tick, a cross, a "!" or a dash
const MARK = { passed: "M18.3 20.6l2.6 2.6 5-5.2", failed: "M19 17.4l6 6M25 17.4l-6 6", caution: "M22 15.6v5.2M22 24.2v.2", untested: "M18.6 20.4h6.8", error: "M18.6 20.4h6.8" };
export function svg(r) {
  const L = LOOK[r?.verdict] || LOOK.error;
  const t = r?.checkedAt ? new Date(r.checkedAt).toISOString().slice(11, 16) + " UTC" : "";
  const sub = (r?.verdict === "untested" ? "no buyers on the curve yet" : r?.symbol ? `$${r.symbol} · checked ${t}` : t ? `checked ${t}` : "try again in a minute").slice(0, 40);
  const leftW = Math.max(86, Math.ceil(sub.length * 5.9));
  const pillW = Math.ceil(L.word.length * 8.4 + 20);
  const W = 40 + leftW + 16 + pillW + 10;
  const px = W - pillW - 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="44" viewBox="0 0 ${W} 44" role="img" aria-label="Troya Gate: ${xml(L.word.toLowerCase())}">
<title>Troya Gate: ${xml(L.word.toLowerCase())}${r?.symbol ? ` · $${xml(r.symbol)}` : ""}${t ? ` · checked ${t}` : ""}</title>
<rect width="${W}" height="44" rx="8" fill="#071014"/><rect x=".5" y=".5" width="${W - 1}" height="43" rx="7.5" fill="none" stroke="rgba(216,247,255,.18)"/>
<path d="M14 13.5 22 10.5l8 3v6.2c0 5.2-3.4 8.6-8 10.8-4.6-2.2-8-5.6-8-10.8z" fill="rgba(95,211,239,.14)" stroke="#5fd3ef" stroke-width="1.6" stroke-linejoin="round"/>
<path d="${MARK[r?.verdict] || MARK.error}" fill="none" stroke="${L.fg}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
<text x="40" y="19" font-family="Menlo,Consolas,monospace" font-size="11" letter-spacing="1.6" fill="#5fd3ef">TROYA GATE</text>
<text x="40" y="33" font-family="Verdana,Segoe UI,sans-serif" font-size="9.5" fill="#8fa3b1">${xml(sub)}</text>
<rect x="${px}" y="11" width="${pillW}" height="22" rx="5" fill="${L.bg}"/>
<text x="${px + pillW / 2}" y="26" text-anchor="middle" font-family="Verdana,Segoe UI,sans-serif" font-size="11" font-weight="700" letter-spacing=".5" fill="${L.fg}">${L.word}</text>
</svg>`;
}

export async function register(r) {
  r.get("/api/badge/:address", async ({ params, res }) => {
    const m = ADDR.exec(String(params.address || ""));
    if (!m) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Not a token address" })); }
    let data = null;
    try { data = await result(m[1]); } catch (e) { data = { verdict: "error", error: String(e.message).slice(0, 200) }; }
    if (m[2]) {
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return res.end(svg(data));
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=120" });
    return res.end(JSON.stringify({ ...data, page: `https://troya.codes/badge?ca=${m[1]}`, svg: `https://troya.codes/api/badge/${m[1]}.svg`, ttlSeconds: TTL / 1000 }));
  }, { weight: 1, perMin: 120 });
}
