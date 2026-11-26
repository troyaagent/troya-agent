// One description of every Troya check, shared by the ElizaOS, AgentKit and Virtuals GAME plugins so the wording an
// agent sees is the same everywhere (and matches https://troya.codes/mcp where the tool exists there).
// Each tool: key, title, description, params (JSON-Schema-like, all strings/numbers/booleans), run(client, args) and
// summarize(result) → { text, data }: one or two plain sentences for the agent plus a compact object it can reason over.

export const NOTICE = "A reading of the chain at that moment, not advice and never a safe stamp. Read only: nothing was traded, signed or sent.";
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? "n/a" : `${Number(n).toFixed(2)}%`);
const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const str = (v) => (v == null ? undefined : String(v).trim() || undefined);
const num = (v) => (v == null || v === "" ? undefined : Number(v));
// trident reasons besides the one its summary already says
const others = (r) => (r.reasons || []).filter((x) => !String(r.summary || "").includes(x.text)).map((x) => `[${x.level}] ${x.text}`);
const bool = (v) => (v === true || v === "true" || v === "1" || v === 1 ? true : v === false || v === "false" || v === "0" || v === 0 ? false : undefined);

export const TOOLS = [
  {
    key: "gate_check",
    title: "Troya Gate check",
    description: "Troya Gate: a fresh pre-trade check of a Robinhood Chain (chain 4663) coin at your trade size, before you buy it: route, price impact, pool depth, fees and taxes, a simulated buy, a test sell, transfer tax, launch ring and dev side wallets. Verdict passed, caution, failed or untested (no buyers on its curve yet). Free and unsigned by default; signed=true returns the attested check with The Assay's flags, signed by Troya's attestor so other agents can verify it (a few free a day per IP, more with a Troya API key, then 0.01 USDG of credit per check). Read only: it never buys.",
    params: {
      token: { type: "string", description: "Coin contract address on Robinhood Chain (0x + 40 hex)", required: true },
      amountEth: { type: "number", description: "Trade size in ETH (default 0.01, at most 5)" },
      from: { type: "string", description: "Optional: the buyer wallet, to simulate from it" },
      signed: { type: "boolean", description: "true for the signed, attested check (uses the daily free allowance or credit); default false" },
    },
    run: (c, a) => {
      const token = str(a.token), opts = { amountEth: num(a.amountEth) ?? 0.01, from: str(a.from) };
      return bool(a.signed) ? c.signedGateCheck(token, opts) : c.gateCheck(token, opts);
    },
    summarize(r) {
      if (r && r.attested) {
        const at = r.attested;
        const red = (at.assay?.flags || []).filter((f) => f.level === "red").map((f) => f.title);
        return {
          text: `Troya Gate (signed) on $${at.symbol || short(at.token)} at ${at.amountEth} ETH: ${String(at.verdict).toUpperCase()}${at.reason ? ` (${at.reason})` : ""}.${red.length ? ` Red flags: ${red.join("; ")}.` : ""} Signed by ${short(r.attestor)}; paid by ${r.paid?.by || "n/a"}. ${NOTICE}`,
          data: { verdict: at.verdict, reason: at.reason, token: at.token, symbol: at.symbol, amountEth: at.amountEth, checks: at.checks, quote: at.quote, assay: at.assay, checkedAt: at.checkedAt, attested: at, hash: r.hash, signature: r.signature, attestor: r.attestor, paid: r.paid, signed: true },
        };
      }
      const notes = r.checks.filter((c) => c.status === "warn" || c.status === "fail").map((c) => `${c.label}: ${c.detail}`);
      return {
        text: `Troya Gate on $${r.symbol || short(r.token)} at ${r.amountEth} ETH: ${String(r.verdict).toUpperCase()}${r.reason ? ` (${r.reason})` : ""}.${r.quote ? ` Price impact ${pct(r.quote.priceImpactPct)}, fees and taxes ${pct(r.quote.feePct)}, route ${r.quote.route}.` : ""}${notes.length > 1 ? ` Other notes: ${notes.slice(1, 3).join(" | ")}` : ""} Unsigned free check. ${NOTICE}`,
        data: { verdict: r.verdict, reason: r.reason, token: r.token, symbol: r.symbol, amountEth: r.amountEth, checks: r.checks, quote: r.quote, checkedAt: r.checkedAt, signed: false },
      };
    },
  },
  {
    key: "trident_check",
    title: "Troya Trident firewall",
    description: "Troya Trident: a firewall check of a Robinhood Chain transaction or signature request BEFORE anyone signs it. Send the transaction (to, data, value, from) or EIP-712 typedData. It reads every coin the call touches through Troya Gate, dry-runs the exact call, and flags unlimited or wallet-to-wallet approvals (drainer pattern), coins sent to the token contract or zero address, EIP-7702 delegations to unknown contracts, and Permit/Permit2 to unknown spenders. Answers allow, warn or block with plain reasons, signed by Troya's attestor. Read only: it never signs or sends.",
    params: {
      to: { type: "string", description: "Transaction target address (the contract or wallet being called)" },
      data: { type: "string", description: "Calldata, 0x hex (default 0x)" },
      value: { type: "string", description: "ETH value in wei (decimal or 0x hex, default 0)" },
      from: { type: "string", description: "The wallet that would sign; enables the dry run" },
      typedData: { type: "string", description: "Instead of a transaction: EIP-712 typed data to be signed, as a JSON string" },
    },
    run: (c, a) => c.tridentCheck({ from: str(a.from), to: str(a.to), data: str(a.data), value: str(a.value), typedData: a.typedData && typeof a.typedData === "object" ? a.typedData : str(a.typedData) }),
    summarize(r) {
      return {
        text: `Troya Trident: ${String(r.verdict).toUpperCase()}. ${r.summary || ""}${others(r).length ? ` Also: ${others(r).slice(0, 3).join(" ")}` : ""} ${/safe stamp/.test(r.summary || "") ? "Read only: nothing was signed or sent." : NOTICE}`,
        data: { verdict: r.verdict, summary: r.summary, reasons: r.reasons, coins: r.coins, checkedAt: r.checkedAt, signed: r.signed || null },
      };
    },
  },
  {
    key: "bridge_safety",
    title: "Troya Scylla bridge safety",
    description: "Troya Scylla: before moving ETH between Robinhood Chain and Base, Arbitrum or Ethereum, score every bridge route on offer 0-100 for safety (verification model, who controls upgrades, incidents, track record, audits; the route scores as its weakest layer) with green/amber/red bands, red lines, value lost in the quote and time. One side must be Robinhood Chain. Optionally a coin bought at the end, which also runs Troya Gate on it. Routes are quotes, never sent; a score explains a risk and never promises a bridge is safe.",
    params: {
      from: { type: "string", description: "Source chain: robinhood, base, arbitrum, ethereum or a chain id (default base)" },
      to: { type: "string", description: "Destination chain (default robinhood)" },
      amount: { type: "number", description: "Amount of ETH to move (default 0.1, at most 50)" },
      token: { type: "string", description: "Optional: coin address to buy at the end of the crossing" },
      address: { type: "string", description: "Optional: your wallet, to quote for it" },
    },
    run: (c, a) => c.bridgeSafety({ from: str(a.from) || "base", to: str(a.to) || "robinhood", amount: num(a.amount) ?? 0.1, token: str(a.token), address: str(a.address) }),
    summarize(r) {
      const routes = (r.routes || []).slice(0, 6).map((x) => ({ id: x.id, source: x.source, tools: x.tools, score: x.score, band: x.band, weakest: x.weakest, redLines: (x.redLines || []).map((l) => l.key), warnings: x.warnings, valueLostPct: x.valueLostPct, seconds: x.seconds, toAmount: x.toAmount, tags: x.tags }));
      const best = [...routes].sort((p, q) => q.score - p.score)[0];
      return {
        text: `Troya Scylla, ${r.amountEth} ETH ${r.from?.name} → ${r.to?.name}: ${routes.length} route(s) scored.${best ? ` Safest: ${best.tools.join(" + ")} at ${best.score}/100 (${best.band})${best.redLines.length ? `, red lines: ${best.redLines.join(", ")}` : ""}.` : ""}${r.gate ? ` Arriving coin: Gate ${r.gate.verdict}.` : ""}${r.storm?.level && r.storm.level !== "calm" ? ` Storm watch: ${r.storm.level}.` : ""} ${r.limit || NOTICE}`,
        data: { from: r.from, to: r.to, amountEth: r.amountEth, token: r.token, gate: r.gate, routes, storm: r.storm, chain: r.chain ? { name: r.chain.name, score: r.chain.score } : null, primaryNote: r.primaryNote, checkedAt: r.checkedAt, receipt: r.receipt || null, limit: r.limit },
      };
    },
  },
  {
    key: "agent_passport",
    title: "Troya Bow agent passport",
    description: "Troya Bow: the passport of another AI agent on Robinhood Chain before you trust its calls, signals or payment requests: stamps built from evidence, not claims (ERC-8004 identity and feedback, calls graded in public in Troya's registry, paid jobs, Seal receipts, launches and their Gate verdict now, farm-like reviewers, endpoint health), each with its proof, plus a standing and a dated summary signed by Troya's attestor. It describes what wallets and endpoints did, never who runs them. Give a wallet address or an ERC-8004 agent id.",
    params: {
      address: { type: "string", description: "The agent's wallet address (0x + 40 hex)" },
      agentId: { type: "string", description: "Or its ERC-8004 agent id on Robinhood Chain" },
    },
    run: (c, a) => c.agentPassport({ address: str(a.address), agentId: str(a.agentId) }),
    summarize(r) {
      return {
        text: `Troya Bow passport for ${r.label ? `"${r.label}" ` : ""}${short(r.address) || `agent #${r.agentId}`}: standing ${r.standing}. ${r.summary || ""}${(r.warnings || []).length ? ` Warnings: ${r.warnings.map((w) => w.title || w.text || w).slice(0, 3).join("; ")}.` : ""}`.trim(),
        data: { address: r.address, agentId: r.agentId, label: r.label, kind: r.kind, standing: r.standing, summary: r.summary, counts: r.counts, stamps: (r.stamps || []).map((s) => ({ key: s.key, title: s.title, text: s.text, evidence: (s.evidence || []).slice(0, 2).map((e) => e.url || e.ref) })), warnings: r.warnings, partial: !!r.partial, page: r.page || null, signed: r.signed || null, limit: r.limit || null },
      };
    },
  },
  {
    key: "weak_spot",
    title: "Troya Heel weak spot",
    description: "Troya Heel: paste a Robinhood Chain coin, a dev wallet or an agent; Troya names its single most dangerous weak spot in one sentence (dev selling, rigged launch ring, side wallets, broken Oath, contract controls, …) with up to three facts that each carry on-chain evidence and a confidence label. The worst finding is picked by fixed rules, never by a model. Read only.",
    params: { address: { type: "string", description: "Coin, dev wallet or agent address (0x + 40 hex)", required: true } },
    run: (c, a) => c.weakSpot(str(a.address), { waitMs: 20_000 }),
    summarize(r) {
      return {
        text: `Troya Heel (${r.kind}${r.coin?.symbol ? ` $${r.coin.symbol}` : ""}): ${r.heel || "no weak spot found"}${r.severity ? ` Severity ${r.severity}, confidence ${r.confidence}.` : ""}${r.partial ? " Some sources were still reading; ask again shortly." : ""} ${NOTICE}`,
        data: { address: r.address, kind: r.kind, heel: r.heel, severity: r.severity, score: r.score, confidence: r.confidence, facts: (r.facts || []).map((f) => ({ text: f.text, confidence: f.confidence, source: f.source, evidence: f.evidence?.url || f.evidence?.ref || null })), coverage: (r.coverage || []).map((x) => `${x.source}: ${x.status}`), partial: !!r.partial, checkedAt: r.checkedAt },
      };
    },
  },
  {
    key: "real_depth",
    title: "Troya Sirens real depth",
    description: "Troya Sirens: how deep a Robinhood Chain coin really is and how honest its volume is. Price impact of $100, $1,000 and $10,000 buys and sells on every venue (Pons curve, Uniswap v3/v4, KyberSwap, Lighter), flags pools that look deep but quote shallow, 24 h on-chain volume with self-trades, round trips and linked-wallet wash removed, and other coins sharing its ticker (lookalikes). Read only.",
    params: { token: { type: "string", description: "Coin address on Robinhood Chain (or its ticker or name)", required: true } },
    run: (c, a) => c.realDepth(str(a.token), { waitMs: 30_000 }),
    summarize(r) {
      const d = r.depth || {}, v = r.volume || {}, f = r.family || {};
      const venues = (d.venues || []).map((x) => ({ venue: x.label || x.venue, buy: (x.buy || []).map((b) => ({ sizeUsd: b.sizeUsd, impactPct: b.impactPct, ok: b.ok })), sell: (x.sell || []).map((s) => ({ sizeUsd: s.sizeUsd, impactPct: s.impactPct, ok: s.ok })), within2PctUsd: x.within2PctUsd, reportedLiquidityUsd: x.reportedLiquidityUsd, looksDeep: x.looksDeep }));
      return {
        text: `Troya Sirens on $${r.coin?.symbol || short(r.coin?.address)}: ${d.headline || `depth ${d.status || "n/a"}`} ${v.headline || `Volume ${v.status || "n/a"}.`}${f.headline ? ` ${f.headline}` : ""}${r.partial ? " Some readings are still in progress; ask again shortly." : ""}`,
        data: { coin: r.coin, partial: !!r.partial, depth: { status: d.status, headline: d.headline, venues, missing: (d.missing || []).map((m) => `${m.label}: ${m.why}`), coinLooksDeep: d.coinLooksDeep }, volume: { status: v.status, headline: v.headline, raw: v.raw, honest: v.honest, removedPct: v.removedPct }, family: { status: f.status, headline: f.headline }, checkedAt: r.checkedAt },
      };
    },
  },
];

export const toolByKey = (k) => TOOLS.find((t) => t.key === k);

/** Run a tool by key and return { ok, text, data } (or { ok:false, text, error } with the TroyaError's code). */
export async function runTool(client, key, args = {}) {
  const t = toolByKey(key);
  if (!t) return { ok: false, text: `Unknown Troya tool ${key}.`, error: { code: "BAD_INPUT" } };
  try {
    const raw = await t.run(client, args || {});
    const s = t.summarize(raw);
    return { ok: true, text: s.text, data: s.data };
  } catch (e) {
    const code = e?.code || "ERROR";
    const extra = code === "PAYMENT_REQUIRED" && e.payment ? ` How to pay: ${(e.payment.howToPay || []).join(" ")} Or use signed=false for the free unsigned check.` : code === "RATE_LIMITED" ? " Wait a minute and try again." : "";
    return { ok: false, text: `${t.title} failed (${code}): ${e?.message || e}.${extra}`.replace(/\.\./g, "."), error: { code, status: e?.status || 0, message: e?.message || String(e), payment: e?.payment || null } };
  }
}
