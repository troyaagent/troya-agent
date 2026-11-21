// Phase 4 · the Troya Gate badge for Pons devs: a live SVG for any Robinhood Chain coin, and the page it links to.
//   GET /api/badge/:address.svg   SVG, re-checked at most every 10 minutes per coin
//   GET /api/badge/:address       the same result as JSON (checks, verdict, time, the buy size checked, cached or not)
//   GET /api/badge/:address?fresh=1   JSON from a new check now (the Gate page's "Run the Gate"), six a minute per IP
// The verdict is the one Swap and the Gate page show (public/agent/js/verdict.js, imported here so the three can never
// drift apart): "word" is passed | notes | blocked | untestable, "label" the words on screen, "answer" the plain
// "Can I buy?" line. "verdict" keeps the older names (passed | caution | failed | untested | error) for the readers that
// use them. A thin young curve is reported, not failed. The badge says what was checked and when. It never says "safe",
// and a coin can change after a check.
import { checkLaunch } from "./sentry.mjs";
import { verdictOf } from "../public/agent/js/verdict.js";

const TTL = 10 * 60_000;
const memo = new Map();                       // address → { at, done, p }
const ADDR = /^(0x[0-9a-fA-F]{40})(\.svg)?$/;
// the test buy checkLaunch runs (Sentry's TEST_ETH): price impact on the badge is for this size, and the page says so
const CHECK_ETH = "0.01";
// ?fresh=1 skips the memo for a whole new check (quote, simulation, test sell), so each IP gets a few a minute; past that
// the page is answered from the memo and told so, never refused
const FRESH_PER_MIN = 6;
const freshHits = new Map();                  // ip → { t, n }
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function freshOk(ip) {
  const now = Date.now();
  let b = freshHits.get(ip);
  if (!b || now - b.t > 60_000) { b = { t: now, n: 0 }; freshHits.set(ip, b); }
  if (freshHits.size > 5000) for (const [k, v] of freshHits) if (now - v.t > 60_000) freshHits.delete(k);
  return ++b.n <= FRESH_PER_MIN;
}

// → { p, cached }: cached is true when the answer is a finished check from the memo
function lookup(a, fresh = false) {
  const k = a.toLowerCase(), hit = memo.get(k);
  // a fresh run joins a check already under way: nothing is fresher, and the chain is not asked twice
  if (hit && (!hit.done || (!fresh && Date.now() - hit.at < TTL))) return { p: hit.p, cached: hit.done };
  const e = { at: Date.now(), done: false, p: null };
  e.p = checkLaunch(a).then((r) => {
    const checks = r.checks.map((c) => ({ key: c.key, label: c.label, status: c.status, detail: c.detail }));
    const curve = r.pons && !r.pons.graduated ? { raised: r.pons.raised, pair: r.pons.pair?.symbol || "ETH", progressPct: r.pons.progressPct } : null;
    // read by the shared rule, not Sentry's channel filter: a depth line that fails off a curve blocks Swap, so it blocks
    // here too, and a curve with no buyers is "untestable" on every surface alike
    const v = verdictOf({ checks, curve });
    return {
      token: r.token, symbol: r.symbol, name: r.name, verdict: v.legacy, word: v.word, label: v.label, answer: v.answer,
      reason: v.why && v.word !== "passed" ? `${v.why.label}: ${v.why.detail}` : null,
      checks, curve, checkedAt: r.at,
    };
  });
  // errors are never kept; a failed fresh run only drops its own entry
  e.p.then(() => { e.done = true; }, () => { if (memo.get(k) === e) memo.delete(k); });
  memo.delete(k);                             // re-inserted at the end, so the size cap below drops the oldest check first
  memo.set(k, e);
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return { p: e.p, cached: false };
}
const result = (a) => lookup(a).p;

export const badgeResult = result;           // for the bot's /badge

// the shared labels in capitals (verdict.js LABEL), so the badge on a dev's site reads as Swap and the Gate page do
const LOOK = {
  passed: { word: "PASSED", fg: "#5fd38d", bg: "rgba(95,211,141,.14)" },
  caution: { word: "PASSED WITH NOTES", fg: "#f2c26b", bg: "rgba(242,194,107,.14)" },
  failed: { word: "BLOCKED", fg: "#f0606d", bg: "rgba(240,96,109,.14)" },
  untested: { word: "NOT TESTABLE YET", fg: "#9fb0bf", bg: "rgba(159,176,191,.12)" },
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
  r.get("/api/badge/:address", async ({ params, query, ip, res }) => {
    const m = ADDR.exec(String(params.address || ""));
    if (!m) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Not a token address" })); }
    // JSON only: a badge embedded on someone's site never forces a new check
    const wantFresh = !m[2] && query?.fresh === "1";
    const fresh = wantFresh && freshOk(ip || "?");
    let data = null, cached = false;
    // a check that could not run fails closed, as Swap does: the word is "blocked", the badge itself reads UNAVAILABLE
    try { const l = lookup(m[1], fresh); cached = l.cached; data = await l.p; } catch (e) { const error = String(e.message).slice(0, 200); const v = verdictOf({ verdict: "error", error }); data = { verdict: "error", word: v.word, label: "Unavailable", answer: v.answer, error }; }
    if (m[2]) {
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return res.end(svg(data));
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": wantFresh ? "no-store" : "public, max-age=120" });
    return res.end(JSON.stringify({
      ...data, chain: "robinhood", amountEth: CHECK_ETH, cached, ...(wantFresh && !fresh ? { freshLimited: true } : {}),
      page: `https://troya.codes/badge?ca=${m[1]}`, svg: `https://troya.codes/api/badge/${m[1]}.svg`, ttlSeconds: TTL / 1000,
    }));
  }, { weight: 1, perMin: 120 });
}
