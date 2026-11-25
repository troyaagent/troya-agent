// V9 F54 Patroclus: the Heel card, embeddable anywhere an <img> works (launchpads, bots, wallets, docs, forum posts).
//   GET /api/heelcard/:address.svg   the card as SVG (600 × 220), Heel's own answer drawn, cached with Heel (5 min)
//   GET /api/heelcard/:address       the embed kit as JSON: card URL, page URL and ready-made HTML / Markdown snippets
// A card is a dated snapshot of what Heel read, never a safe stamp: it prints the time it was read and says so.
// It is an image, not an iframe, so it needs no change to the site's frame rules and runs no code on the host page.
// Patroclus went into battle wearing Achilles' armour.
import { heel } from "./heel.mjs";

const ADDR = /^(0x[0-9a-fA-F]{40})(\.svg)?$/;
const SITE = "https://troya.codes";
const WAIT_MS = 8000;           // an embed never hangs: past this the card says "reading" and the next load has the answer
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const REF = /^[A-Za-z0-9_-]{1,32}$/;

// the colours of the levels Heel uses (heel.mjs levelOf)
const LEVEL = {
  critical: { word: "CRITICAL", fg: "#f0606d", bg: "rgba(240,96,109,.16)" },
  high: { word: "HIGH", fg: "#f0606d", bg: "rgba(240,96,109,.14)" },
  medium: { word: "MEDIUM", fg: "#f2c26b", bg: "rgba(242,194,107,.14)" },
  low: { word: "LOW", fg: "#9fd3a8", bg: "rgba(159,211,168,.12)" },
  none: { word: "NO HEEL FOUND", fg: "#5fd38d", bg: "rgba(95,211,141,.12)" },
  reading: { word: "READING", fg: "#9fb0bf", bg: "rgba(159,176,191,.12)" },
};

// greedy word wrap for the card's sentence (monospace-ish width estimate, good enough for a fixed card)
function wrap(text, max, lines) {
  const plain = String(text || "").replace(/^Heel:\s*/i, "");
  const words = (plain.charAt(0).toUpperCase() + plain.slice(1)).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { out.push(cur.trim()); cur = w; if (out.length === lines) break; } else cur += " " + w;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[lines - 1] = out[lines - 1].replace(/[\s,.;:]*\S{0,12}$/, "") + "…";
  return out;
}

export function card(r, address) {
  const W = 600, H = 220;
  const reading = !r;
  const L = reading ? LEVEL.reading : LEVEL[r.severity] || LEVEL.none;
  const kind = r?.kind || "coin";
  const title = r?.coin?.symbol ? `$${r.coin.symbol}` : kind === "dev" ? `Dev ${short(address)}` : kind === "agent" ? `Agent ${short(address)}` : short(address);
  const lines = reading ? ["Troya is reading this address on Robinhood Chain.", "Load the card again in a minute for the answer."] : wrap(r.heel, 62, 3);
  const when = r?.checkedAt ? new Date(r.checkedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  const gate = r?.coin?.gate?.label ? `Gate: ${r.coin.gate.label}` : "";
  const foot = [gate, when ? `read ${when}` : ""].filter(Boolean).join(" · ");
  const pillW = Math.ceil(L.word.length * 8.2 + 22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Troya Heel for ${xml(title)}: ${xml(lines.join(" "))}">
<title>Troya Heel · ${xml(title)}${when ? ` · read ${xml(when)}` : ""}</title>
<rect width="${W}" height="${H}" rx="14" fill="#071014"/><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="rgba(216,247,255,.16)"/>
<path d="M26 22 36 18.5l10 3.5v7.6c0 6.4-4.2 10.6-10 13.4-5.8-2.8-10-7-10-13.4z" fill="rgba(95,211,239,.14)" stroke="#5fd3ef" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M31.5 37.5c2-.6 3.4-2.4 4.5-5.5 1.1 3.1 2.5 4.9 4.5 5.5" fill="none" stroke="#5fd3ef" stroke-width="1.6" stroke-linecap="round"/>
<text x="58" y="30" font-family="Menlo,Consolas,monospace" font-size="12" letter-spacing="2" fill="#5fd3ef">TROYA HEEL</text>
<text x="58" y="47" font-family="Verdana,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="#e8f6fb">${xml(title)}</text>
<rect x="${W - pillW - 22}" y="20" width="${pillW}" height="26" rx="6" fill="${L.bg}"/>
<text x="${W - pillW / 2 - 22}" y="38" text-anchor="middle" font-family="Verdana,Segoe UI,sans-serif" font-size="12" font-weight="700" letter-spacing=".6" fill="${L.fg}">${L.word}</text>
${lines.map((l, i) => `<text x="26" y="${88 + i * 24}" font-family="Verdana,Segoe UI,sans-serif" font-size="15" fill="#d7e6ec">${xml(l)}</text>`).join("\n")}
<line x1="26" y1="164" x2="${W - 26}" y2="164" stroke="rgba(216,247,255,.10)"/>
<text x="26" y="184" font-family="Verdana,Segoe UI,sans-serif" font-size="11" fill="#8fa3b1">${xml(foot || "Robinhood Chain")}</text>
<text x="26" y="203" font-family="Verdana,Segoe UI,sans-serif" font-size="11" fill="#6f8593">A dated snapshot, never a safe stamp</text>
<text x="${W - 26}" y="203" text-anchor="end" font-family="Menlo,Consolas,monospace" font-size="11" letter-spacing="1" fill="#5fd3ef">troya.codes/heel</text>
</svg>`;
}

// the Heel answer, or null when it is not ready inside WAIT_MS (the read keeps going in heel.mjs's own in-flight map)
async function read(address) {
  const p = heel(address).catch(() => null);
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
}

export function kit(address, ref) {
  const a = address;
  const q = ref && REF.test(ref) ? `&ref=${encodeURIComponent(ref)}` : "";
  const page = `${SITE}/agent#/heel/${a}${q ? `?${q.slice(1)}` : ""}`;
  const img = `${SITE}/api/heelcard/${a}.svg`;
  return {
    card: img, page,
    html: `<a href="${page}" target="_blank" rel="noopener"><img src="${img}" width="600" height="220" alt="Troya Heel: the one weak spot of ${a}, read on Robinhood Chain"></a>`,
    markdown: `[![Troya Heel](${img})](${page})`,
    note: "The card re-reads at most every 5 minutes and prints when it was read. It is a dated snapshot, never a safe stamp.",
  };
}

export async function register(r) {
  r.get("/api/heelcard/:address", async ({ params, query, res }) => {
    const m = ADDR.exec(String(params.address || ""));
    if (!m) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Not an address" })); }
    if (m[2]) {
      const data = await read(m[1]);
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": data && !data.partial ? "public, max-age=300" : "public, max-age=30",   // a partial read (a source still reading) is re-asked soon
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "access-control-allow-origin": "*",
      });
      return res.end(card(data, m[1]));
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ address: m[1], ...kit(m[1], query?.ref) }));
  }, { weight: 1, perMin: 120 });
}
