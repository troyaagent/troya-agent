// Translate tools/i18n/src/<pack>.json into public/i18n/<lang>/<pack>.js with an LLM through OpenRouter, once; the
// results are committed as static files. Lines already translated are kept, so a rerun only pays for new lines.
//   node --env-file=/srv/troya/.env tools/i18n/translate.mjs [--langs zh-Hans,ja] [--packs home,app] [--src dir] [--out dir]
// Needs OPENROUTER_API_KEY (never printed). Prints the spend from OpenRouter's own usage numbers.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : def; };
const SRC = arg("src", join(HERE, "src"));
const OUT = arg("out", join(HERE, "../../public/i18n"));
const MODEL = arg("model", "anthropic/claude-sonnet-5.5");
const NAMES = {
  "zh-Hans": "Simplified Chinese (简体中文, as used in mainland China)", ja: "Japanese", ko: "Korean", es: "Spanish (neutral Latin American)",
  "pt-BR": "Brazilian Portuguese", ru: "Russian", tr: "Turkish", vi: "Vietnamese", id: "Indonesian (Bahasa Indonesia, plain and friendly)",
};
const LANGS = arg("langs", Object.keys(NAMES).join(",")).split(",");
const PACKS = arg("packs", readdirSync(SRC).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).join(",")).split(",");
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("OPENROUTER_API_KEY is not set"); process.exit(1); }

/* ---------- which collected lines are worth translating ---------- */
// The app pages also show live data (coin names, tickers, prices, chat messages, times): those stay as they are.
const ALLOW_CAPS = new Set("ETH USDC USDG USD MCP API CLI TROYA ETF AI PNL DEX LP NFT UTC OI HL MC QR ID TX CA ERC REST SDK RPC TVL APR APY FAQ BTC SOL HYPE UBTC UETH KYC DCA TWAP COOLDOWN CEX JSON URL SMS PDF ANT V4 V3 V2 NVDA OG".split(" "));
const CHAT_UI = new Set(["Community", "Public chat · people with signed-in wallets", "Close chat", "Community messages", "<1>No messages yet</1>Say hello. Everyone can read this chat; posting needs a wallet sign-in.", "New messages", "Connect to post", "Reading is open to everyone. Your profile name, or your wallet address, shows next to what you write.", "Holder", "Holds at least {0} $TROYA", "X account linked with Sign in with X"]);
const COIN_NAMES = new Set(["Boner Coin", "Pons", "MarketFloat", "Hookr.fun", "HEPH AI", "Texel", "ChipWizard", "SPCX Chain", "ignot", "Moon Cat", "Community is Capital", "Memoria", "Moth", "Sigil", "GENESIS CHAD", "ANT Chain", "Interpres", "Tender", "Semiconductor 3x ETF", "paired with USDG", "Cash Cat", "Artificial Inu", "Zhipu AI", "NVIDIA", "Anthropic, PBC Class A Common Stock", "SpaceX Class A", "robinhood",
  // language names are shown in their own language everywhere
  "English", "简体中文", "日本語", "한국어", "Español", "Português", "Русский", "Türkçe", "Tiếng Việt", "Bahasa Indonesia"]);
export function worth(k, pack) {
  const text = k.key.replace(/<\/?\d+\/?>/g, " ").replace(/\{\d+\}/g, " ");
  if (!/[a-z]{2,}/.test(text)) return false;                        // "ETH", "1D", "${0}.7K", "OI ${0}.4M"
  if (/^(<\d+><\d+>[^<]*<\/\d+><\/\d+>\s*)+$/.test(k.key)) return false;   // a heading after the word reveal split it
  if (/\b\d+[hdm] ago\b|^\d+[hdm]$/.test(k.key)) return false;          // "3d ago": live ages (and the commit list beside them)
  if (pack !== "app") return true;
  if (/Community chat/.test(k.ctx)) return CHAT_UI.has(k.key);
  if (COIN_NAMES.has(k.key)) return false;
  if (/0x[0-9a-fA-F]{4}|\d+\/\d+\/20\d\d/.test(k.key)) return false;  // addresses, timestamps
  if (/\$[A-Z][A-Z0-9]{1,}/.test(k.key.replace(/\$TROYA/g, ""))) return false;   // $TICKER
  if (/\$\d+(\.\d+)?[KMB]\b|\{\d+\}\.\d+[KMB]\b|\b\d+[hdm]\b( ago)?|\b\d+ min ago/.test(k.key)) return false;     // live money and ages
  const caps = text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [];
  if (caps.some((w) => !ALLOW_CAPS.has(w))) return false;           // tickers: BIGTIME, FIONA…
  if (/^(Today|Yesterday|Staker pot so far):/.test(k.key) || /^Couldn't read/.test(k.key)) return false;
  return true;
}

/* ---------- markers: every <n>, </n>, <n/> and {n} of the source must come back ---------- */
const markers = (s) => (s.match(/<\/?\d+\/?>|\{\d+\}/g) || []).sort().join(" ");
function nested(s) {
  const st = [];
  for (const m of s.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) { if (st.pop() !== m[2]) return false; } else st.push(m[2]);
  }
  return !st.length;
}
const valid = (src, tr) => typeof tr === "string" && tr.trim() && markers(src) === markers(tr) && nested(tr) && !/<(?!\/?\d+\/?>)/.test(tr.replace(/&lt;/g, ""));

const KEEP = "Troya, Troya Agent, Troya Gate, the Gate (write it as Gate), Troya Swap, Troya Launches, Sentry, Sentry Autopilot, Agent Wallet, Heel, Heel Hunt, Swift, Chiron, Phoenix, War Room, Myrmidons, Scepter, Aegis, Herald, Treasury, Arena, Council, Seal, Oath, The Record, Flywheel, Zero, Zero Watch, Patroclus, Watchfire, Achilles, Agamemnon, Athena, Hermes, Odysseus, Cassandra, Poseidon, Penelope, Prometheus, Ithaca, Olympus, MMXXVI, $TROYA and every $TICKER, Robinhood Chain, Robinhood, Base, Arbitrum, Ethereum, Solana, Hyperliquid, trade.xyz, Lighter, Morpho, Pons, Uniswap, KyberSwap, Jupiter, PancakeSwap, LI.FI, Relay, DexScreener, GeckoTerminal, Blockscout, Sourcify, Fomo, MetaMask, Coinbase Wallet, Rabby, OKX Wallet, Phantom, Solflare, Backpack, X, Telegram, GitHub, Claude, Claude Desktop, Claude Code, Cursor, OpenRouter, TradingView, Slither, Wake, Aderyn, Cyfrin, Trail of Bits, Ackee Blockchain, Foundry, OpenZeppelin, MCP, API, CLI, x402, ERC-8004";
const system = (lang) => `You translate the website and app of Troya Agent, an AI trading desk for crypto on Robinhood Chain, from English into ${NAMES[lang]}.

Rules:
- Each item is one piece of a web page: a heading, a sentence, a paragraph, a button, a menu label or a tooltip. "ctx" says where it sits. Translate it fully and naturally, the way a careful native product writer would. Short UI labels stay short.
- Inline markers stand for the page's own elements and must be kept exactly: <1>…</1> wraps text (a link, bold, a highlighted word), <2/> is an icon, an image, a number or a code snippet, and {0}, {1} are numbers. Every marker of the source must appear in your translation exactly as many times, with <n>…</n> pairs properly nested. Move them where the grammar of ${NAMES[lang]} needs them; translate the text inside <n>…</n>.
- Keep &amp; &lt; &gt; &lbrace; exactly as written (they stand for the characters & < > {).
- Keep these names as written, in Latin letters, never translated or transliterated: ${KEEP}. Keep code, function names (withdraw(), claim()), commands (npx …, /long), file names, URLs, @handles and wallet addresses as they are.
- Plain, accurate and calm. Never add hype, promises or words that are not in the English; never drop a caveat; never change a number, a date, a limit or a claim. Dates like "25 Nov 2026" may follow the local date order.
- Answer with one JSON object only: {"<id>": "<translation>", …} with every id you were given, and nothing before or after it.`;

async function call(lang, items) {
  const body = {
    model: MODEL, temperature: 0.2, max_tokens: 16000, usage: { include: true },
    messages: [{ role: "system", content: system(lang) }, { role: "user", content: JSON.stringify(items.map((x) => ({ id: x.id, ctx: x.ctx || undefined, text: x.key }))) }],
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
      const j = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${j?.error?.message || ""}`.slice(0, 200));
      spend.cost += Number(j.usage?.cost || 0); spend.in += j.usage?.prompt_tokens || 0; spend.out += j.usage?.completion_tokens || 0; spend.calls++;
      const txt = j.choices?.[0]?.message?.content || "";
      const m = txt.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : {};
    } catch (e) {
      console.log(`  ${lang} attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) return {};
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

const spend = { cost: 0, in: 0, out: 0, calls: 0 };
const readOut = (file) => { try { const s = readFileSync(file, "utf8"); return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { return {}; } };

async function doLang(lang) {
  for (const pack of PACKS) {
    const src = JSON.parse(readFileSync(join(SRC, `${pack}.json`), "utf8")).filter((k) => worth(k, pack));
    const file = join(OUT, lang, `${pack}.js`);
    const done = existsSync(file) ? readOut(file) : {};
    const todo = src.filter((k) => !valid(k.key, done[k.key])).map((k, i) => ({ ...k, id: String(i) }));
    let fixed = 0, failed = [];
    // batches of about 6 KB of English
    const batches = [];
    for (let cur = [], size = 0, i = 0; i < todo.length; i++) {
      cur.push(todo[i]); size += todo[i].key.length + 40;
      if (size > 6000 || i === todo.length - 1) { batches.push(cur); cur = []; size = 0; }
    }
    for (const b of batches) {
      let res = await call(lang, b);
      let miss = b.filter((x) => !valid(x.key, res[x.id]));
      if (miss.length) {                                       // a second try for the lines whose markers did not come back
        const again = await call(lang, miss);
        for (const x of miss) if (valid(x.key, again[x.id])) res[x.id] = again[x.id];
        miss = miss.filter((x) => !valid(x.key, res[x.id]));
      }
      for (const x of b) if (valid(x.key, res[x.id])) { done[x.key] = res[x.id]; fixed++; }
      failed.push(...miss.map((x) => x.key));
    }
    // only lines still on the page, in page order (lines that stay the same, like names, are kept so a rerun skips them)
    const out = {};
    for (const k of src) if (valid(k.key, done[k.key])) out[k.key] = done[k.key];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `// ${NAMES[lang]} · ${pack} · written by tools/i18n/translate.mjs (${MODEL}); English source in tools/i18n/src/${pack}.json\nTROYA_I18N_ADD(${JSON.stringify(out, null, 0).replace(/","/g, '",\n"')});\n`);
    console.log(`${lang} ${pack}: ${Object.keys(out).length}/${src.length} lines (${fixed} new)${failed.length ? `, ${failed.length} left in English` : ""}`);
  }
}
await Promise.all(LANGS.map(doLang));
console.log(`spend: $${spend.cost.toFixed(4)} · ${spend.calls} calls · ${spend.in} tokens in · ${spend.out} out`);
