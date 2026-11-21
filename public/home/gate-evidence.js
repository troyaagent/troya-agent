// Troya Gate, explained check by check: what each line read and how, from a /api/swap/gate answer. One file for both sides:
// the server writes the $TROYA example into /proof and /verify with it (server/proof.mjs imports this file), and the
// "Run the Gate on a coin" box on those pages draws a live answer with it in the browser. Pure functions, no DOM.
// Every method below is what server/robinhood.mjs gateCheck() does; nothing here is a claim the code does not make.
const SIM = "0x7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a";      // the Gate's simulation sender: no key exists for it
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const num = (x, d = 6) => (x == null || x === "" || !isFinite(Number(x)) ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d }));
const hex = (n) => "0x" + BigInt(n || 0).toString(16);

// the simulated buy as a JSON-RPC call anyone can send to a Robinhood Chain RPC: the same transaction, the same sender
// with the same balance override the Gate gave it. `block` pins it to the block it ran on (an archive node can replay it
// later); "latest" works until the swap's deadline (20 minutes after the check)
export function replayCall(g, block = "latest") {
  const t = g?.tx;
  if (!t?.to || !t?.data) return null;
  const from = t.from || SIM, value = BigInt(t.value || 0);
  return { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to: t.to, data: t.data, value: hex(value), gas: "0x1c9c380" }, block, { [from]: { balance: hex(value + 10n ** 20n) } }] };
}

// what each check read, in plain words, with the numbers from this answer
export function evidenceOf(g) {
  const q = g?.quote || {}, t = g?.tx || null, p = q.route?.pons || null, hop = (q.route?.hops || [])[0] || {};
  const tin = q.tokenIn?.symbol || "ETH", tout = q.tokenOut?.symbol || "the coin";
  const how = {
    route: [`The best route Troya found for ${num(q.amountIn)} ${tin} → ${tout}: ${q.route?.label || "–"}.`,
      p?.poolId ? `Pons coin, ${p.graduated ? "graduated to its Uniswap v4 pool" : "still on its bonding curve"} · pool id ${short(p.poolId)} · curve ${short(p.curve)}${hop.hooks ? ` · hook ${short(hop.hooks)}` : ""}.` : ""],
    impact: [`Quoted out: ${num(q.amountOut, 2)} ${tout}, at least ${num(q.minOut, 2)} after ${((q.slippageBps ?? 100) / 100).toFixed(2)}% slippage. Price impact at this size: ${q.priceImpact == null ? "not measurable" : (q.priceImpact * 100).toFixed(2) + "%"}.`],
    depth: [q.poolLiquidity ? `${q.poolLiquidity.eth != null ? num(q.poolLiquidity.eth, 3) + " ETH" : "–"}${q.poolLiquidity.usd != null ? ` ($${num(q.poolLiquidity.usd, 0)})` : ""}: ${q.poolLiquidity.note || "the pool's ETH side"}.` : "Pool depth from the route's pool."],
    fee: [p?.fees ? `Pons fee ${(p.fees.curveBps / 100).toFixed(2)}% + creator tax ${(p.fees.creatorTaxBps / 100).toFixed(2)}%${p.fees.snipeTaxBps ? ` + snipe tax ${(p.fees.snipeTaxBps / 100).toFixed(2)}%` : ""}, read from the Pons contracts${hop.feePct ? `, plus a ${hop.feePct}% pool fee` : ""}.` : `Every fee and tax on the route${q.feeNote ? ` (${q.feeNote})` : ""}.`],
    sim: [t ? `eth_call of the exact swap: to ${short(t.to)} (${t.to && t.to.toLowerCase() === "0x8876789976decbfcbbbe364623c63652db8c0904" ? "Uniswap Universal Router" : "the route's router"}), value ${num(Number(BigInt(t.value || 0)) / 1e18)} ETH, ${Math.max(0, ((t.data || "").length - 2) / 2)} bytes of calldata, sent from ${short(t.from || SIM)}, an address with no key, given a balance through eth_call's state override. Nothing is broadcast.` : "Runs once the route has a transaction to simulate."],
    sell: [`A keyless address is handed the ${num(q.amountOut, 2)} ${tout} this buy returns (and the approvals) through state overrides, then sells them back through the best route, all inside eth_call. A token that cannot be sold reverts here.`],
    tax: [((d) => /^None on a transfer|plain transfer reverts/i.test(d)
      ? "Measured on the token itself: inside one eth_call, Multicall3 is given the coins through a state override, sends them to the Uniswap v4 PoolManager and to a fresh wallet, and reads how many arrived."
      : /^None detected/i.test(d) ? "Measured from the test sell: what the simulated sell returned against what the route quoted for it."
      : "Measured from the test sell (returned against quoted), and on the token itself with a transfer probe (Multicall3 in one eth_call) when the sell cannot tell.")((g?.checks || []).find((c) => c.key === "tax")?.detail || "")],
    devlinks: ["Wallets the dev funded or was funded by, read from the chain; a dev side wallet holding or selling shows here."],
  };
  return (g?.checks || []).map((c) => ({ key: c.key, label: c.label, status: c.status, detail: c.detail, how: (how[c.key] || []).filter(Boolean) }));
}

const BADGE = { pass: "Pass", warn: "Caution", fail: "Fail", skip: "Skipped" };
// the answer as HTML (escaped): a verdict line, one row per check with what it read, and the simulated buy as a call to replay
export function gateHtml(g, { token = "", amount = "0.01", block = null, replay = null, apiUrl = "" } = {}) {
  const q = g?.quote || {}, sym = q.tokenOut?.symbol ? `$${q.tokenOut.symbol}` : short(token);
  const when = g?.checkedAt ? new Date(g.checkedAt).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";
  const rows = evidenceOf(g).map((c) => `<li class="pf-chk pf-${esc(c.status)}"><span class="pf-st">${esc(BADGE[c.status] || c.status)}</span><div><b>${esc(c.label)}</b><span class="pf-det">${esc(c.detail)}</span>${c.how.map((h) => `<small>${esc(h)}</small>`).join("")}</div></li>`).join("");
  const call = replayCall(g, block != null ? hex(block) : "latest");
  const rep = replay ? `<p class="pf-rep">This server sent that call again at block ${esc(num(replay.block, 0))}: ${replay.ok ? "it did not revert" : `it reverted (${esc(replay.error || "")})`}${replay.returnData != null ? `, returned <code>${esc(String(replay.returnData).slice(0, 66))}</code>` : ""}.</p>` : "";
  return `<div class="pf-gate" data-pass="${g?.pass ? "1" : "0"}">
<p class="pf-verdict"><b>${g?.pass ? "Passed" : "Did not pass"}</b> · ${esc(sym)} · a simulated buy of ${esc(amount)} ETH on Robinhood Chain${when ? ` · checked ${esc(when)}` : ""}</p>
<ol class="pf-checks">${rows || '<li class="pf-chk"><span class="pf-st">–</span><div><b>No checks</b></div></li>'}</ol>
${call ? `<details class="pf-call"><summary>The simulated buy, as a call you can send yourself</summary><p>POST this to any Robinhood Chain RPC (for example https://rpc.mainnet.chain.robinhood.com, chain id 4663). An answer without an error means the swap goes through against the pool at that block${block != null ? "; replaying at that block needs an archive node, and \"latest\" works until the swap's 20-minute deadline" : ""}.</p><pre>${esc(JSON.stringify(call, null, 1))}</pre></details>` : ""}
${rep}${apiUrl ? `<p class="pf-src">Raw answer: <a class="ulink" href="${esc(apiUrl)}" target="_blank" rel="noopener">${esc(apiUrl.replace(/^https?:\/\/[^/]+/, ""))}</a></p>` : ""}
</div>`;
}
