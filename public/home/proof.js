// /proof and the Gate box on /verify. The server already wrote the numbers and tables into the page (server/proof.mjs);
// this script only adds what needs a click or a fresh read:
//   · "Run the Gate on a coin": GET /api/swap/gate for any pasted coin, no wallet, every check with what it read
//     (public/home/gate-evidence.js, the same file the server renders the $TROYA example with), and the simulated buy
//     sent once more to Robinhood Chain through the site's RPC relay, raw answer shown
//   · "Read totalSupply() now": the burn read straight from the token contract, raw JSON-RPC shown
//   · blocks that were still empty when the page was served (the first minute after a restart) are filled from
//     /api/proof/fragments, and the burn numbers are refreshed every 2 minutes
import { gateHtml, replayCall, esc } from "/home/gate-evidence.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const DEAD = "000000000000000000000000000000000000000000000000000000000000dead";
const ADDR = /0x[0-9a-fA-F]{40}/;
const getJson = async (url, opts) => { const r = await fetch(url, { cache: "no-store", ...opts }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
const rpc = (body) => getJson("/api/rpc/robinhood", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fmt = (wei) => { const s = BigInt(wei).toString().padStart(19, "0"); return `${BigInt(s.slice(0, -18)).toLocaleString("en-US")}.${s.slice(-18, -14)}`; };

/* ---------- blocks the server had not filled yet ---------- */
async function fillPending() {
  const pend = $$("[data-frag]").filter((el) => el.querySelector("[data-pf-pending]"));
  const vals = $$("[data-live]").filter((el) => el.textContent.trim() === "–");
  if (!pend.length && !vals.length) return;
  for (let i = 0; i < 6; i++) {
    const d = await getJson("/api/proof/fragments").catch(() => null);
    if (d) {
      for (const el of pend) if (el.querySelector("[data-pf-pending]") && d.fragments?.[el.dataset.frag]) el.innerHTML = d.fragments[el.dataset.frag];
      for (const el of vals) if (d.values?.[el.dataset.live]) el.textContent = d.values[el.dataset.live];
      if (!pend.some((el) => el.querySelector("[data-pf-pending]"))) return;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/* ---------- burn numbers, fresh from /api/proof/burn ---------- */
async function burnTick() {
  try {
    const b = await getJson("/api/proof/burn");
    const set = (k, t) => $$(`[data-live="${k}"]`).forEach((el) => { el.textContent = t; });
    set("burn.total", Number(b.burnedWhole).toLocaleString("en-US"));
    set("burn.int", Number(b.burnedWhole).toLocaleString("en-US"));
    set("burn.pct", Number(b.pctOfMinted).toFixed(2));
    set("burn.supply", Math.floor(Number(b.totalSupply.replace(/,/g, ""))).toLocaleString("en-US"));
  } catch { /* the server's copy stays */ }
}

/* ---------- "Read totalSupply() now" ---------- */
function supplyBox() {
  const btn = $("[data-pf-supply]"), out = $("[data-pf-supply-out]");
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true; out.hidden = false; out.textContent = "Asking Robinhood Chain…";
    const req = [
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TROYA, data: "0x18160ddd" }, "latest"] },
      { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: TROYA, data: "0x70a08231" + DEAD }, "latest"] },
      { jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] },
    ];
    try {
      const res = await rpc(req);
      const by = Object.fromEntries(res.map((x) => [x.id, x.result]));
      const sup = BigInt(by[1]), dead = BigInt(by[2] || "0x0"), burned = 10n ** 27n - sup;
      out.textContent = `Request (POST /api/rpc/robinhood, forwarded to a Robinhood Chain node):\n${JSON.stringify(req, null, 1)}\n\nAnswer:\n${JSON.stringify(res, null, 1)}\n\n`
        + `Block ${Number(BigInt(by[3])).toLocaleString("en-US")}\ntotalSupply()        = ${fmt(sup)} $TROYA\nbalanceOf(0x…dEaD)   = ${fmt(dead)} $TROYA\nburned = 1,000,000,000 − totalSupply() = ${fmt(burned)} $TROYA`;
    } catch (e) { out.textContent = `Could not read the chain right now (${e.message}). Try the public RPC with the call below.`; }
    btn.disabled = false;
  });
}

/* ---------- "Run the Gate on a coin" ---------- */
function gateBox() {
  const form = $("[data-pf-gate]");
  if (!form) return;
  const out = $("[data-pf-gate-out]", form), input = form.elements.coin, amount = form.elements.amount, btn = $("button[type=submit]", form);
  $$("[data-pf-coin]", form).forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.pfCoin; form.requestSubmit(); }));
  let seq = 0;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = (String(input.value).match(ADDR) || [])[0];
    if (!a) { out.innerHTML = '<p class="pf-err">Paste a Robinhood Chain contract address (0x followed by 40 characters).</p>'; return; }
    const amt = amount.value || "0.01", my = ++seq;
    const url = `/api/swap/gate?tokenIn=ETH&tokenOut=${a}&amountIn=${encodeURIComponent(amt)}`;
    btn.disabled = true;
    out.innerHTML = `<p class="pf-verdict">Running the Gate on ${esc(a)}: quote, simulation, test sell and tax probe. This takes a few seconds…</p>`;
    try {
      const g = await getJson(url);
      if (my !== seq) return;
      out.innerHTML = gateHtml(g, { token: a, amount: amt, apiUrl: location.origin + url })
        + (replayCall(g) ? '<p class="pf-src"><button type="button" class="pf-chip" data-pf-replay>Send the simulated buy to the chain again</button> through this site\'s RPC relay and show the raw answer.</p><pre class="pf-out" data-pf-replay-out hidden></pre>' : "");
      const rb = $("[data-pf-replay]", out), ro = $("[data-pf-replay-out]", out);
      rb?.addEventListener("click", async () => {
        rb.disabled = true; ro.hidden = false; ro.textContent = "Sending eth_call…";
        const body = replayCall(g);
        try {
          const res = await rpc(body);
          ro.textContent = `Request:\n${JSON.stringify(body, null, 1)}\n\nAnswer:\n${JSON.stringify(res, null, 1)}\n\n${res.error ? "It reverted now: the pool moved or the deadline passed. Run the Gate again for a fresh one." : "No error: the exact swap goes through against the pool as it is now. Nothing was signed or sent."}`;
        } catch (err) { ro.textContent = `Could not send it (${err.message}).`; }
        rb.disabled = false;
      });
    } catch (err) {
      if (my === seq) out.innerHTML = `<p class="pf-err">The Gate could not run on that coin: ${esc(err.message)}</p>`;
    } finally { if (my === seq) btn.disabled = false; }
  });
  // /proof runs it once on $TROYA as the page opens, so the live answer is on the page without a click
  if (form.dataset.pfAuto === "1") setTimeout(() => form.requestSubmit(), 1200);
}

fillPending();
supplyBox();
gateBox();
setInterval(burnTick, 120_000);
