#!/usr/bin/env node
// Troya CLI: Troya Agent from the terminal. One file, no dependencies, Node 18+.
// It holds no keys. Read commands use the public Troya API; swap and execute need an API token
// (TROYA_API_KEY, from the app: Agent → Wallet → API tokens) and run through the same limits, Gate and journal as the app.
//   TROYA_BASE_URL  Troya server (default https://troya.codes)
//   TROYA_API_KEY   API token for swap / execute / policy / balances of your own wallet
import { randomUUID } from "node:crypto";

const VERSION = "0.1.0";
const argv = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { args.push(...argv.slice(i + 1)); break; }
  if (/^--[a-z-]+=/.test(a)) { const [k, ...v] = a.slice(2).split("="); flags[k] = v.join("="); }
  else if (/^--[a-z-]+$/.test(a)) { const k = a.slice(2); const n = argv[i + 1]; if (["limit", "base", "slippage", "cat"].includes(k) && n != null) { flags[k] = n; i++; } else flags[k] = true; }
  else if (a === "-h") flags.help = true;
  else if (a === "-v") flags.version = true;
  else if (a === "-j") flags.json = true;
  else args.push(a);
}
const BASE = String(flags.base || process.env.TROYA_BASE_URL || process.env.TROYA_URL || "https://troya.codes").replace(/\/+$/, "").replace(/\/(agent\/)?api$/, "");
const KEY = process.env.TROYA_API_KEY || "";
const JSON_OUT = !!flags.json;

/* ---------- terminal output ---------- */
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint("1"), dim = paint("2"), green = paint("32"), red = paint("31"), yellow = paint("33"), blue = paint("38;5;117");
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const say = (...a) => console.log(...a);
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function price(p) {
  if (p == null || !Number.isFinite(+p)) return "–";
  p = +p;
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p <= 0) return "$0";
  const z = -Math.floor(Math.log10(p)) - 1;
  if (z >= 4) return "$0.0" + String(z).split("").map((d) => SUB[d]).join("") + String(Math.round(p * 10 ** (z + 3)));
  return "$" + p.toPrecision(3);
}
function money(n) {
  if (n == null || !Number.isFinite(+n) || +n <= 0) return "–";
  n = +n;
  return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
}
const pct = (x, dp = 1) => (x == null || !Number.isFinite(+x) ? dim("–") : (+x >= 0 ? green : red)(`${+x >= 0 ? "+" : ""}${(+x).toFixed(dp)}%`));
const num = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-US"));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
// rows: arrays of cells; a row may carry .after, a line printed under it that does not set column widths
function table(rows, head, align = []) {
  const all = head.some(Boolean) ? [Object.assign(head.map((h) => dim(h)), {}), ...rows] : rows;
  const w = head.map((_, i) => Math.max(0, ...all.map((r) => strip(r[i] ?? "").length)));
  for (const r of all) {
    say(r.map((c, i) => { const s = String(c ?? ""), pad = " ".repeat(Math.max(0, w[i] - strip(s).length)); return align[i] === "r" ? pad + s : s + pad; }).join("  ").trimEnd());
    if (r.after) say(r.after);
  }
}
const sym = (s, n = 12) => { s = String(s || "?"); return "$" + (s.length > n ? s.slice(0, n - 1) + "…" : s); };
const tag = (status) => ({ pass: green("pass"), warn: yellow("warn"), fail: red("fail"), skip: dim("skip") }[status] || dim(status || "?"));
const verdictPaint = (v) => ({ passed: green, caution: yellow, failed: red }[v] || dim)(String(v || "untested").toUpperCase());
const LEAN = { up: green("leaning up"), down: red("leaning down"), sideways: blue("sideways") };

/* ---------- API ---------- */
async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { accept: "application/json", "user-agent": `troya-cli/${VERSION}`, "x-troya-client": "cli", ...(body ? { "content-type": "application/json" } : {}), ...(KEY ? { "x-api-key": KEY } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) { throw new Error(`Could not reach ${BASE} (${e.cause?.code || e.name}).`); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
const tool = async (name, input = {}, headers = {}) => (await api("POST", `/api/tools/${encodeURIComponent(name)}`, input, headers)).result;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
async function resolveCoin(q) {
  if (!q) throw new Error("Give a coin: a 0x… address or a ticker like TROYA.");
  if (ADDR.test(q)) return { address: q.toLowerCase() };
  const t = String(q).replace(/^\$/, "");
  const r = await api("GET", `/api/search/coins?q=${encodeURIComponent(t)}&limit=8`);
  const coins = r.coins || [];
  const hit = coins.find((c) => c.symbol?.toLowerCase() === t.toLowerCase()) || coins[0];
  if (!hit) throw new Error(`No coin on Robinhood Chain matches "${q}".`);
  return hit;
}
const needKey = () => { if (!KEY) throw new Error("This command needs TROYA_API_KEY. Create one in the Troya app: Agent → Wallet → API tokens."); };
const out = (data, pretty) => (JSON_OUT ? say(JSON.stringify(data, null, 2)) : pretty(data));

/* ---------- commands ---------- */
const C = {};
C.gate = {
  use: "gate <coin>", about: "Troya Gate for a Robinhood Chain coin: a simulated buy and a test sell from a fresh address",
  run: async ([q]) => {
    const c = await resolveCoin(q);
    const r = await api("GET", `/api/badge/${c.address}`);
    out(r, () => {
      say(`${bold("Troya Gate")}  ${bold("$" + (r.symbol || "?"))} ${dim(r.name || "")}  ${verdictPaint(r.verdict)}`);
      say(dim(r.token));
      if (r.reason) say(yellow(r.reason));
      say("");
      table((r.checks || []).map((k) => [tag(k.status), k.label || k.name || k.key || "", dim(k.detail || "")]), ["", "Check", "Detail"]);
      say("");
      say(dim(`Checked ${r.checkedAt ? ago(r.checkedAt) : "just now"} · full result ${BASE}/agent/#/gate/${r.token}`));
    });
  },
};
C.token = {
  use: "token <coin>", about: "Price, market cap, liquidity, volume, holders and links for one coin",
  run: async ([q]) => {
    const c = await resolveCoin(q);
    const r = await api("GET", `/api/market/robinhood/token?address=${c.address}`);
    const t = r.token || r;
    out(r, () => {
      say(`${bold("$" + t.symbol)} ${dim(t.name || "")}  ${price(t.priceUsd)}  ${pct(t.change24h)} ${dim("24h")}`);
      say(dim(t.address));
      say("");
      const s = t.socials || {};
      table([
        ["Market cap", money(t.mcapUsd)], ["Liquidity", money(t.liquidityUsd)], ["Volume 24h", money(t.volume24hUsd)],
        ["Trades 24h", t.txns24h != null ? `${num(t.txns24h)}${t.buys24h != null ? dim(`  ${num(t.buys24h)} buys · ${num(t.sells24h)} sells`) : ""}` : "–"],
        ["Holders", t.holders != null ? `${num(t.holders)}${t.top10Pct != null ? dim(`  top 10 hold ${t.top10Pct.toFixed(0)}%`) : ""}` : "–"],
        ["Launchpad", t.launchpad || "–"],
        ...(s.website || s.twitter || s.telegram ? [["Socials", [s.website, s.twitter, s.telegram].filter(Boolean).join("  ")]] : []),
      ], ["", ""]);
      say("");
      say(dim(`Troya  ${BASE}/agent/#/token/${t.address}`));
      say(dim(`Fomo   https://fomo.family/tokens/robinhood/${t.address}`));
    });
  },
};
C.search = {
  use: "search <query>", about: "Find coins on Robinhood Chain by name, ticker or address",
  run: async (a) => {
    const q = a.join(" ");
    if (!q) throw new Error("Give something to search for.");
    const r = await api("GET", `/api/search/coins?q=${encodeURIComponent(q)}&limit=${Number(flags.limit) || 10}`);
    out(r, () => {
      if (!r.coins?.length) return say(dim(`Nothing matches "${q}".`));
      table(r.coins.map((c) => [bold(sym(c.symbol)), (c.name || "").slice(0, 24), price(c.priceUsd), pct(c.change24h), money(c.liquidityUsd), dim(c.address)]), ["Coin", "Name", "Price", "24h", "Liquidity", "Address"], ["", "", "r", "r", "r"]);
    });
  },
};
C.market = {
  use: "market [picks|trending|new|bonding|all]", about: "The Robinhood Chain board. Troya picks by default, each with why",
  run: async ([cat = flags.cat || "picks"]) => {
    if (!["picks", "trending", "new", "bonding", "all"].includes(cat)) throw new Error("Category is one of: picks, trending, new, bonding, all.");
    const sort = cat === "picks" ? "picks" : cat === "new" ? "newest" : "volume";
    const r = await api("GET", `/api/market/robinhood?cat=${cat}&sort=${sort}&limit=${Number(flags.limit) || 15}`);
    out(r, () => {
      const counts = r.catCounts ? dim(Object.entries(r.catCounts).map(([k, v]) => `${k} ${v}`).join(" · ")) : "";
      say(`${bold(cat === "picks" ? "Troya picks" : cat[0].toUpperCase() + cat.slice(1))}  ${counts}`);
      say("");
      const rows = [];
      (r.tokens || []).forEach((t, i) => {
        const row = [dim(String(i + 1)), bold(sym(t.symbol)), price(t.priceUsd), pct(t.change24h), money(t.mcapUsd), money(t.liquidityUsd), money(t.volume24hUsd), t.holders != null ? num(t.holders) : "–"];
        if (cat === "picks" && t.pick?.why?.length) row.after = dim(`   ${t.pick.why.join(" · ")}`);
        rows.push(row);
      });
      table(rows, ["#", "Coin", "Price", "24h", "MC", "Liquidity", "Vol 24h", "Holders"], ["r", "", "r", "r", "r", "r", "r", "r"]);
      if (cat === "picks") { say(""); say(dim("A read of live data, not advice. Run `troya gate <coin>` before you buy.")); }
    });
  },
};
C.picks = { use: "picks", about: "Same as `troya market picks`", run: () => C.market.run(["picks"]) };
C.holders = {
  use: "holders <coin>", about: "Top holders of a coin, with known contracts labelled",
  run: async ([q]) => {
    const c = await resolveCoin(q);
    const r = await api("GET", `/api/market/robinhood/holders?address=${c.address}`);
    out(r, () => {
      say(`${bold(num(r.count))} holders${r.top10 != null ? dim(` · top 10 hold ${r.top10.toFixed(1)}%`) : ""}`);
      say("");
      table((r.holders || []).slice(0, Number(flags.limit) || 15).map((h, i) => [dim(String(i + 1)), h.address, `${h.pct.toFixed(2)}%`, h.label ? blue(h.label) : h.contract ? dim("contract") : ""]), ["#", "Address", "Share", ""], ["r", "", "r"]);
    });
  },
};
C.oracle = {
  use: "oracle [coin]", about: "The chart oracle: Troya's latest chart notes, and how past notes were graded",
  run: async ([q]) => {
    if (q) {
      const id = /^(eth|btc)$/i.test(q) ? q.toUpperCase() : (await resolveCoin(q)).address;
      const r = await api("GET", `/api/oracle/coin/${id}`);
      return out(r, () => {
        const n = r.note;
        if (!n) return say(dim(`No chart note for ${q} yet. Notes cover ETH, BTC, $TROYA and the top Troya picks.`));
        note(n);
      });
    }
    const r = await api("GET", "/api/oracle?limit=60");
    out(r, () => {
      const s = r.stats;
      say(`${bold("The chart oracle")}  ${dim(`${s.notes} notes · ${s.graded} graded · ${s.winRate == null ? "no grades yet" : `${Math.round(s.winRate * 100)}% right`}`)}`);
      say("");
      const seen = new Set();
      for (const n of r.notes) if (!seen.has(n.id)) { seen.add(n.id); note(n); say(""); }
      say(dim(`Rules and every graded note: ${BASE}/record#chart-oracle`));
    });
    function note(n) {
      const sentence = n.call === "up" ? `toward ${price(n.resistance)}, support at ${price(n.support)}` : n.call === "down" ? `toward ${price(n.support)}, resistance at ${price(n.resistance)}` : `between ${price(n.support)} and ${price(n.resistance)}`;
      say(`${bold((n.kind === "rh" ? "$" : "") + n.symbol)}  ${LEAN[n.call] || n.call} ${sentence}  ${dim(`at ${price(n.price)}, ${ago(n.at)}`)}`);
      say(dim(`  ${(n.why || []).join(" · ")}`));
      if (n.status === "graded") say(`  ${n.result === "win" ? green("right") : red("wrong")} ${dim("24h later:")} ${pct(n.move)}`);
    }
  },
};
C.record = {
  use: "record", about: "The Oracle's ledger: every Troya Sentry call, graded 24 hours later",
  run: async () => {
    const r = await api("GET", `/api/record?limit=${Number(flags.limit) || 12}`);
    out(r, () => {
      const s = r.stats;
      say(`${bold("The Record")}  ${dim(`${s.calls} calls · ${s.graded} graded · ${s.winRate == null ? "–" : Math.round(s.winRate * 100) + "% higher after 24h"} · median peak ${s.medianPeakX ? s.medianPeakX.toFixed(2) + "×" : "–"}`)}`);
      say("");
      table((r.calls || []).map((c) => [bold(c.symbol ? sym(c.symbol) : short(c.token)), dim(ago(c.at)), price(c.priceAtCall), pct(c.change24h), c.peakX ? `${c.peakX.toFixed(2)}×` : "–", c.result === "win" ? green("win") : c.result === "miss" ? red("miss") : dim(c.status)]), ["Coin", "Called", "Price then", "24h", "Peak", "Result"], ["", "", "r", "r", "r"]);
      say(""); say(dim(`${BASE}/record`));
    });
  },
};
C.flywheel = {
  use: "flywheel", about: "$TROYA creator fees, buybacks, burns and locked liquidity, read from the chain",
  run: async () => {
    const r = await api("GET", "/api/flywheel");
    out(r, () => {
      const f = r.fees || {}, b = r.burned || {}, t = r.totals || {}, p = r.price || {};
      say(bold("$TROYA flywheel"));
      say("");
      table([
        ["Price", price(p.troyaUsd)],
        ["Creator fees earned", `${(f.earnedEth ?? 0).toFixed(4)} ETH ${dim(`(${f.claims ?? 0} claims)`)}`],
        ["Burned", `${num(b.total)} TROYA ${dim(`${(b.pctOfMinted ?? 0).toFixed(2)}% of minted`)}`],
        ["Supply", `${num(b.supply)} TROYA`],
        ["Buyback cycles", `${t.cycles ?? 0} ${dim(`· ${num(t.troyaBought)} bought · ${num(t.troyaBurned)} burned`)}`],
      ], ["", ""]);
      say(""); say(dim(`${BASE}/flywheel`));
    });
  },
};
C.perp = {
  use: "perp <COIN>", about: "A Hyperliquid perp: price, 24h, funding, open interest, spread",
  run: async ([coin]) => {
    if (!coin) throw new Error("Give a perp, like ETH or BTC.");
    const r = await tool("analyze_ticker", { coin: coin.toUpperCase() });
    out(r, () => {
      say(`${bold(r.coin)}  ${price(r.markPx)}  ${pct(r.change24h)} ${dim("24h")}`);
      say("");
      table([["Funding", `${pct(r.fundingApr)} ${dim("a year")}`], ["Open interest", money(r.openInterestUsd)], ["Volume 24h", money(r.volume24hUsd)], ["Spread", `${r.spreadPct?.toFixed(3)}%`], ["Max leverage", `${r.maxLeverage}×`]], ["", ""]);
    });
  },
};
C.movers = {
  use: "movers", about: "Biggest 24h movers among liquid Hyperliquid perps",
  run: async () => {
    const r = await tool("get_movers", { limit: Number(flags.limit) || 10 });
    out(r, () => table((r.movers || []).map((m) => [bold(m.coin), price(m.markPx), pct(m.change24h), money(m.volume24hUsd), pct(m.fundingApr, 0)]), ["Perp", "Price", "24h", "Vol 24h", "Funding/yr"], ["", "r", "r", "r", "r"]));
  },
};
C.funding = {
  use: "funding", about: "Highest and lowest funding among liquid Hyperliquid perps",
  run: async () => {
    const r = await tool("get_funding_extremes", { limit: Number(flags.limit) || 5 });
    out(r, () => {
      const row = (m) => [bold(m.coin), pct(m.fundingApr, 0), price(m.markPx), money(m.openInterestUsd)];
      say(bold("Highest")); table((r.highest || []).map(row), ["Perp", "Funding/yr", "Price", "OI"], ["", "r", "r", "r"]);
      say(""); say(bold("Lowest")); table((r.lowest || []).map(row), ["Perp", "Funding/yr", "Price", "OI"], ["", "r", "r", "r"]);
    });
  },
};
C.stocks = {
  use: "stocks [filter]", about: "Tokenized stocks and ETFs on Robinhood Chain",
  run: async ([q]) => {
    const r = await tool("robinhood_stocks", q ? { q } : {});
    out(r, () => table((r.stocks || []).slice(0, Number(flags.limit) || 30).map((s) => [bold(s.symbol), (s.name || "").slice(0, 26), price(s.priceUsd), pct(s.change24h), money(s.liquidityUsd)]), ["Stock", "Name", "Price", "24h", "Liquidity"], ["", "", "r", "r", "r"]));
  },
};
C.health = {
  use: "health <coin>", about: "Bytecode check: owner, mint, pause, blacklist, fee setters, proxy",
  run: async ([q]) => {
    const c = await resolveCoin(q);
    const r = await tool("analyze_token_health", { address: c.address });
    out(r, () => {
      say(`${bold("Token health")}  ${r.score >= 80 ? green(r.score + "/100") : r.score >= 50 ? yellow(r.score + "/100") : red(r.score + "/100")}  ${r.verdict}`);
      say(dim(r.address));
      say("");
      table([["Owner", r.owner || "none"], ["Proxy", r.proxy ? yellow("yes") : "no"], ["Flags", r.flags?.length ? red(r.flags.map((f) => f.label || f).join(", ")) : green("none")]], ["", ""]);
      for (const n of r.notes || []) say(dim("· " + n));
    });
  },
};
C.quote = {
  use: "quote <amount> <from> <to>", about: "Quote a swap on Robinhood Chain (best route across Pons, Uniswap and KyberSwap)",
  run: async (a) => {
    const [amount, from, to] = a.length === 2 ? [a[0], "ETH", a[1]] : a;
    if (!(+amount > 0) || !to) throw new Error("Usage: troya quote 0.01 ETH TROYA");
    const tin = /^eth$/i.test(from) ? "ETH" : (await resolveCoin(from)).address, tout = /^eth$/i.test(to) ? "ETH" : (await resolveCoin(to)).address;
    const r = await tool("quote_swap", { tokenIn: tin, tokenOut: tout, amountIn: +amount, slippagePct: Number(flags.slippage) || 1 });
    out(r, () => {
      const q = r.quote || {}, amt = (v) => (v == null ? "–" : (+v).toLocaleString("en-US", { maximumFractionDigits: +v >= 1 ? 2 : 8 }));
      say(bold(`${amount} ${r.tokenIn?.symbol} → ${amt(r.amountOut ?? q.amountOut)} ${r.tokenOut?.symbol}`));
      say("");
      table([
        ["Route", q.route?.label || q.venue || "–"],
        ["Price impact", r.priceImpactPct != null ? `${(+r.priceImpactPct).toFixed(2)}%` : q.priceImpact != null ? `${(q.priceImpact * 100).toFixed(2)}%` : "–"],
        ["Fees and taxes", r.feePct != null ? `${(+r.feePct).toFixed(2)}%` : "–"],
        [`Minimum at ${r.slippagePct ?? 1}% slippage`, `${amt(q.minOut)} ${r.tokenOut?.symbol}`],
        ["Executable", r.executable ? green("yes") : red("no")],
      ], ["", ""]);
      const side = (x) => (x?.address === "native" || x?.native ? "ETH" : x?.address);
      say(""); say(dim(`Swap it in the app: ${BASE}/agent/#/swap?in=${side(r.tokenIn)}&out=${side(r.tokenOut)}&amount=${amount}`));
    });
  },
};
C.balances = {
  use: "balances [address]", about: "ETH and tokens on Robinhood Chain plus the Hyperliquid account",
  run: async ([addr]) => {
    if (!addr) needKey();
    const r = await tool("get_balances", addr ? { address: addr } : {});
    out(r, () => say(JSON.stringify(r, null, 2)));
  },
};
C.policy = { use: "policy", about: "Your limits (stricter of operator and personal caps), today's usage and dry-run", run: async () => { needKey(); const r = await tool("get_policy", {}); out(r, () => say(JSON.stringify(r, null, 2))); } };
C.swap = {
  use: "swap <amount> <from> <to>", about: "Prepare a swap: quote, Troya Gate and your limits, then a confirmation id (120 s)",
  run: async (a) => {
    needKey();
    const [amount, from, to] = a.length === 2 ? [a[0], "ETH", a[1]] : a;
    if (!(+amount > 0) || !to) throw new Error("Usage: troya swap 0.01 ETH TROYA");
    const tin = /^eth$/i.test(from) ? "ETH" : (await resolveCoin(from)).address, tout = /^eth$/i.test(to) ? "ETH" : (await resolveCoin(to)).address;
    const r = await tool("prepare_swap", { tokenIn: tin, tokenOut: tout, amountIn: +amount, slippagePct: Number(flags.slippage) || 1 });
    out(r, () => {
      say(`${bold("Troya Gate")} ${r.gate?.pass ? green("PASSED") : red("BLOCKED")}`);
      for (const k of r.gate?.checks || []) say(`  ${tag(k.status)} ${k.label || k.name || k.key || ""} ${dim(k.detail || "")}`);
      if (!r.ok) return say(red("\nNot prepared. The Gate or your limits stopped it."));
      say(`\n${bold("Confirmation")} ${r.confirmationId} ${dim(`valid ${r.expiresInSec}s`)}`);
      say(dim(`Run: troya execute ${r.confirmationId}${flags.live ? " --live" : ""}   (a dry run unless you add --live and switched dry-run off for this token)`));
    });
  },
};
C.execute = {
  use: "execute <confirmationId> [--live]", about: "Execute a prepared action through your Agent Wallet. Dry run unless --live",
  run: async ([id]) => {
    needKey();
    if (!id) throw new Error("Give the confirmation id from `troya swap`.");
    const r = await tool("execute_intent", { confirmationId: id, ...(flags.live ? {} : { dryRun: true }) }, { "idempotency-key": `cli-${randomUUID()}` });
    out(r, () => {
      if (r.dryRun) { say(`${yellow("Dry run")} ${dim(r.why || "")}`); return say(JSON.stringify(r.wouldExecute, null, 2)); }
      if (r.blocked) return say(red("Blocked: " + (r.reasons || []).join(" ")));
      say(`${green("Sent")} ${r.hash || ""}`); if (r.explorer) say(dim(r.explorer));
    });
  },
};
C.tools = {
  use: "tools", about: "Every tool on the Troya REST API, with its tier",
  run: async () => { const r = await api("GET", "/api/tools"); out(r, () => table(r.tools.map((t) => [t.tier === "read" ? green(t.tier) : t.tier === "prepare" ? yellow(t.tier) : red(t.tier), bold(t.name), dim(t.description.slice(0, 80))]), ["Tier", "Tool", ""])); },
};
C.call = {
  use: "call <tool> [json | key=value …]", about: "Call any REST tool directly and print its JSON",
  run: async ([name, ...rest]) => {
    if (!name) throw new Error("Give a tool name. `troya tools` lists them.");
    let input = {};
    if (rest.length === 1 && rest[0].trim().startsWith("{")) input = JSON.parse(rest[0]);
    else for (const kv of rest) { const [k, ...v] = kv.split("="); const s = v.join("="); input[k] = s === "true" ? true : s === "false" ? false : s !== "" && Number.isFinite(+s) && !/^0x/i.test(s) ? +s : s; }
    const r = await tool(name, input, name === "execute_intent" ? { "idempotency-key": `cli-${randomUUID()}` } : {});
    say(JSON.stringify(r, null, 2));
  },
};

function help(cmd) {
  if (cmd && C[cmd]) { say(`${bold("troya " + C[cmd].use)}\n${C[cmd].about}`); return; }
  say(`${bold("Troya CLI")} ${dim("v" + VERSION)}  Troya Agent from the terminal: Robinhood Chain and Hyperliquid.\n`);
  say(`${bold("Usage")}  troya <command> [args] [--json]\n`);
  const groups = [["Robinhood Chain", ["gate", "token", "search", "market", "picks", "holders", "health", "quote", "stocks"]], ["Troya, in public", ["oracle", "record", "flywheel"]], ["Hyperliquid", ["perp", "movers", "funding"]], ["Your account (TROYA_API_KEY)", ["swap", "execute", "balances", "policy"]], ["Anything else", ["tools", "call"]]];
  for (const [g, list] of groups) {
    say(blue(g));
    const w = Math.max(...list.map((k) => C[k].use.length));
    for (const k of list) say(`  ${C[k].use.padEnd(w)}  ${dim(C[k].about)}`);
    say("");
  }
  say(`${bold("Examples")}\n  troya gate TROYA\n  troya market picks --limit 10\n  troya oracle ETH\n  troya quote 0.01 ETH TROYA\n  troya token 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074 --json\n`);
  say(dim(`Server ${BASE}${KEY ? " · API token set" : " · no API token (read commands only)"}`));
  say(dim("A coin can be a 0x… address or a ticker. Nothing here is advice; run the Gate before you buy."));
}

(async () => {
  const [cmd, ...rest] = args;
  if (flags.version) return say(VERSION);
  if (!cmd || cmd === "help" || (flags.help && !cmd)) return help(rest[0]);
  if (flags.help) return help(cmd);
  const c = C[cmd];
  if (!c) { console.error(`Unknown command: ${cmd}\n`); help(); process.exitCode = 1; return; }
  try { await c.run(rest); }
  catch (e) { console.error(red("✗ ") + e.message); process.exitCode = 1; }
})();
