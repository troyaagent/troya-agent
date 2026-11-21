// One verdict for every place that shows a Troya Gate result: the Swap card, the Gate page (#/gate), the Desk card and
// the badge (/api/badge: server/badge.mjs imports this same file). Before this, each surface read the raw checks its own
// way, so one coin could read "No buyers yet" on the Gate page while Swap said "Blocked". Four words:
//   passed      every check that decides passed
//   notes       passed, with a line in amber to read first
//   blocked     a check failed where Swap refuses to build the swap (or the Gate could not run: it fails closed)
//   untestable  nothing failed, but the curve holds no buyers' money, so the test sell has nothing to sell against
// "blocked" follows the server's own rule for Swap (robinhood.mjs gateCheck → pass): any failed check, except the depth
// line on a Pons curve, which informs and never decides (every new coin starts at zero raised). A live Gate answer
// carries that pass itself and it is taken as given; a badge answer (no pass field) is read by the same rule.
// No DOM and no imports: the file runs in the browser and in Node.

export const WORDS = ["passed", "notes", "blocked", "untestable"];
export const LABEL = { passed: "Passed", notes: "Passed with notes", blocked: "Blocked", untestable: "Not testable yet" };
// the look each word wears (.dk-v.v-*, .dk-ring.v-*, .dk-gate-note.v-*), and the older verdict names the badge JSON and
// its readers (token page, bot, share card) keep using
export const LEGACY = { passed: "passed", notes: "caution", blocked: "failed", untestable: "untested" };
const DUST_ETH = 0.002;                          // Sentry's MIN_RAISED: below this a curve holds dust, not buyers
const EMPTY_SELL = /holds no buyers|too little/i; // the Gate's own words when the test sell had nothing to sell against

// "No: <this>": the first failing check in plain words, its number kept where it says something
function plain(c) {
  const d = String(c?.detail || "").trim();
  const n = /\d[\d.,]*\s?%|\d[\d.,]*\s?(ETH|SOL)\b/i.exec(d)?.[0];
  switch (c?.key) {
    case "route": return "there is no route to buy it right now";
    case "impact": return `this buy would move the price too far${n ? ` (${n})` : ""}`;
    case "depth": return `the pool is too thin to get back out${n ? ` (${n})` : ""}`;
    case "fee": return `fees and taxes are too high${n ? ` (${n})` : ""}`;
    case "sim": return "the exact swap fails when it is simulated";
    case "sell": return "it could not be sold back in the test sell";
    case "tax": return `too much is lost on every transfer${n ? ` (${n})` : ""}`;
    case "gate": return "the checks could not run just now";
    default: return c?.label ? `${String(c.label).toLowerCase()} failed` : "the checks did not pass";
  }
}

/** "6 passed · 1 not measured": the same count on every surface (a check that did not run is neither passed nor failed). */
export function tallyOf(checks) {
  const cs = Array.isArray(checks) ? checks : [];
  const n = (s) => cs.filter((c) => c.status === s).length;
  const passed = n("pass"), failed = n("fail"), notes = n("warn"), skipped = n("skip");
  const text = [`${passed} passed`, failed ? `${failed} failed` : "", notes ? `${notes} to note` : "", skipped ? `${skipped} not measured` : ""].filter(Boolean).join(" · ");
  return { passed, failed, notes, skipped, total: cs.length - skipped, text };
}

/**
 * verdictOf(gate) for a live /api/swap/gate answer ({ pass, checks, quote }), a badge answer ({ verdict, checks, curve })
 * or the Gate page's reading of either. Returns
 *   { word, label, cls, legacy, canBuy, answer, sentence, note, why, buttons, nudge }
 * answer: "Yes" · "Yes, but read the amber line" · "No: <first failing check>" · "Not testable yet: …"
 * sentence: "Can I buy? <answer>." · buttons: what a page may offer (buy, amounts, fomo, token, ask or explain, badge)
 * nudge: the end of an "Ask Troya" offer ("$X <nudge>. Want me to explain?"), or null when there is nothing to explain
 */
export function verdictOf(g) {
  const checks = Array.isArray(g?.checks) ? g.checks : [];
  const quote = g?.quote || null;
  const curve = quote?.venue ? quote.venue === "pons-curve" : !!g?.curve;
  const decides = (c) => !(curve && c.key === "depth");
  const fail = checks.find((c) => c.status === "fail" && decides(c));
  let word, why = null;
  if (!checks.length || g?.verdict === "error") {
    word = "blocked";
    why = { key: "gate", label: "Troya Gate", detail: g?.error || g?.reason || "The checks could not run just now" };
  } else if (g?.pass === false || (g?.pass == null && fail)) {
    word = "blocked";
    why = fail || checks.find((c) => c.status === "fail") || { key: "gate", label: "Troya Gate", detail: "The checks did not pass" };
  } else {
    const sell = checks.find((c) => c.key === "sell");
    const eth = !curve ? null : quote ? quote.poolLiquidity?.eth : /^W?ETH$/i.test(g?.curve?.pair || "ETH") ? g?.curve?.raised : null;
    const empty = (sell?.status === "skip" && EMPTY_SELL.test(sell.detail || "")) || (eth != null && Number(eth) < DUST_ETH);
    const warn = checks.find((c) => c.status === "warn");
    if (empty) { word = "untestable"; why = sell?.status === "skip" ? sell : null; }
    else if (warn) { word = "notes"; why = warn; }
    else word = "passed";
  }
  const answer = word === "passed" ? "Yes"
    : word === "notes" ? "Yes, but read the amber line"
    : word === "blocked" ? `No: ${plain(why)}`
    : "Not testable yet: no buyers on the curve right now";
  const line = why ? `${why.label}: ${why.detail}` : "";
  const note = word === "passed" ? "Every check passed at this moment. A snapshot, never a safe stamp: a coin can change after a check."
    : word === "notes" ? `${line.replace(/[.\s]+$/, "")}.`
    : word === "blocked" ? `${line.replace(/[.\s]+$/, "")}. Troya will not offer a buy until this passes.`
    : "Nobody holds a buy on the curve, so the test sell waits for one. You would be one of the first buyers.";
  const canBuy = word !== "blocked";
  return {
    word, label: LABEL[word], cls: LEGACY[word], legacy: LEGACY[word], canBuy,
    answer, sentence: `Can I buy? ${answer}.`, note, why: why ? { key: why.key, label: why.label, detail: why.detail } : null,
    buttons: canBuy ? ["buy", "amounts", "fomo", "token", "ask", "badge"] : ["token", "explain", "badge"],
    nudge: word === "blocked" ? "was blocked by the Gate" : word === "notes" ? "passed the Gate with a note" : null,
  };
}
