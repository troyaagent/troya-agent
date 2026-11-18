// The flywheel page (/flywheel): reads /api/flywheel and draws the numbers, the cycles, the locked liquidity and the
// burns. Plain DOM, no framework.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TX = "https://robinhoodchain.blockscout.com/tx/", AD = "https://robinhoodchain.blockscout.com/address/";
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const n = (x, d = 0) => (x == null || !isFinite(x) ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const ethf = (x) => (x == null ? "–" : x >= 1 ? `${x.toFixed(3)} ETH` : x >= 0.001 ? `${x.toFixed(4)} ETH` : x > 0 ? `${x.toPrecision(2)} ETH` : "0 ETH");
  const usd = (x) => (x == null || !isFinite(x) ? "–" : x >= 1000 ? `$${n(x)}` : `$${x.toFixed(2)}`);
  const big = (x) => (x == null ? "–" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : n(x, 2));
  const tx = (h, t) => (h ? `<a class="rec-post" href="${TX}${esc(h)}" target="_blank" rel="noopener">${esc(t)}</a>` : "");
  const when = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  function stats(d) {
    const tile = (k, v, sub = "") => `<div class="rec-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const e = d.price.ethUsd;
    $("[data-fw-stats]").innerHTML = [
      tile("Creator fees earned", ethf(d.fees.earnedEth), `${e ? usd(d.fees.earnedEth * e) + " · " : ""}${n(d.fees.credits)} credits from the Pons escrow`),
      tile("Claimed", ethf(d.fees.claimedEth), `${n(d.fees.claims)} claims · ${ethf(d.fees.waitingEth)} waiting now`),
      tile("$TROYA burned", big(d.burned.total), `${d.burned.pctOfMinted.toFixed(2)}% of the 1B minted · supply ${big(d.burned.supply)}`),
      tile("Liquidity locked", usd(d.locked.usd), `${d.locked.positions.length} position${d.locked.positions.length === 1 ? "" : "s"} owned by 0x…dEaD · ${ethf(d.locked.eth)} + ${big(d.locked.troya)} $TROYA`),
      tile("Cycles run", n(d.totals.cycles), d.totals.cycles ? `${ethf(d.totals.ethToBuyback)} into buybacks · ${big(d.totals.troyaBurned)} burned` : "the first cycle starts the ledger"),
      tile("$TROYA price", d.price.troyaUsd ? `$${d.price.troyaUsd.toPrecision(3)}` : "–", `${n(d.price.troyaPerEth)} per ETH, from the pool`),
    ].join("");
  }
  function cycles(d) {
    const el = $("[data-fw-cycles]");
    if (!d.cycles.length) { el.innerHTML = '<tr><td colspan="5" class="rec-empty">No cycle has run yet. The first one lands here, step by step, as the creator wallet signs it.</td></tr>'; return; }
    el.innerHTML = d.cycles.map((c) => {
      const s = c.steps || {};
      return `<tr><td>${when(c.startedAt)}</td>
        <td>${s.claim ? `${ethf(s.claim.eth)} ${tx(s.claim.hash, "tx")}` : '<span class="rec-na">–</span>'}</td>
        <td>${s.buyback ? `${ethf(s.buyback.ethIn)} → ${big(s.buyback.troyaOut)} $TROYA ${tx(s.buyback.hash, "tx")}` : '<span class="rec-na">–</span>'}</td>
        <td>${s.burn ? `${big(s.burn.troya)} $TROYA ${tx(s.burn.hash, "tx")}` : '<span class="rec-na">–</span>'}</td>
        <td>${s.lock ? `${ethf(s.lock.eth)} + ${big(s.lock.troya)} $TROYA · #${esc(s.lock.tokenId)} ${tx(s.lock.hash, "tx")}` : '<span class="rec-na">–</span>'}</td></tr>`;
    }).join("");
  }
  function locked(d) {
    const el = $("[data-fw-locked]");
    if (!d.locked.positions.length) { el.innerHTML = '<tr><td colspan="6" class="rec-empty">No locked positions found yet.</td></tr>'; return; }
    el.innerHTML = d.locked.positions.map((p) => `<tr>
      <td><a class="rec-coin" href="https://robinhoodchain.blockscout.com/token/${esc(d.positionManager)}/instance/${esc(p.tokenId)}" target="_blank" rel="noopener">#${esc(p.tokenId)}</a></td>
      <td>${esc(p.pool)}</td><td>${p.fullRange ? "Full range" : "Custom range"}${p.inRange ? "" : ' <em class="rec-via">out of range</em>'}</td>
      <td>${ethf(p.eth)} + ${big(p.troya)} $TROYA</td><td>${usd(p.usd)}</td><td>${tx(p.hash, short(p.hash))}</td></tr>`).join("");
  }
  function burns(d) {
    const el = $("[data-fw-burns]");
    $("[data-fw-burnlead]").textContent = `${big(d.burned.byCreator)} $TROYA burned by the creator wallet so far, ${d.burned.viaBurn > 0 ? "with the token's burn(), which takes it out of the total supply" : "sent to 0x…dEaD"}.`;
    const row = (b) => `<tr><td>${n(b.block)}</td><td>${big(b.troya)} $TROYA</td><td>${tx(b.hash, short(b.hash))}</td></tr>`;
    const all = d.burned.burns || [], FIRST = 10;
    el.innerHTML = all.length ? all.slice(0, FIRST).map(row).join("")
      + (all.length > FIRST ? `<tr class="rec-more"><td colspan="3"><button type="button" class="btn-line" data-fw-more>Show all ${all.length} burns</button></td></tr>` : "")
      : '<tr><td colspan="3" class="rec-empty">No burns yet.</td></tr>';
    el.querySelector("[data-fw-more]")?.addEventListener("click", () => { el.innerHTML = all.map(row).join(""); });
    const a = (addr, t) => `<a class="ulink" href="${AD}${esc(addr)}" target="_blank" rel="noopener">${t} ${short(addr)}</a>`;
    $("[data-fw-contracts]").innerHTML = `Addresses: ${a(d.token, "$TROYA")} · ${a(d.creator, "creator wallet")} · ${a(d.escrow, "Pons fee escrow")} · ${a(d.positionManager, "Uniswap v4 PositionManager")}.`;
  }

  async function load() {
    try {
      const d = await (await fetch("/api/flywheel", { cache: "no-store" })).json();
      if (d.error) throw new Error(d.error);
      $("[data-fw-rules]").textContent = d.rules;
      stats(d); cycles(d); locked(d); burns(d);
    } catch {
      $("[data-fw-rules]").textContent = "The chain could not be read right now. Try again in a minute.";
    }
  }
  load();
  setInterval(load, 60_000);
})();
