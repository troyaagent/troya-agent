// Troya Index (#/vault): one token, TIDX, for a basket of Robinhood Chain assets (ETH, USDG, SPY, NVDA, $TROYA), kept near
// its weights by Troya's keeper. Deposit (ETH while the vault holds only ETH, else through TroyaIndexZap with a quoted
// maximum ETH in), redeem any amount in kind (each asset shown first), take out what a redeem had to keep for you
// (claimOwed), and read the holdings, caps, fees, the 48-hour timelock queue and the risks. Reads: /api/index (server/
// index-keeper.mjs) and eth_call through Troya's relay; every write is signed in your own wallet (wallet.js).
// #/vault/deploy is the owner's deploy page: linked from nowhere, it proceeds only with the creator wallet connected and
// sends the three deployments with the approved parameters (index-deploy-lib.js), then hands ownership to the Safe.
import { Interface, formatEther, formatUnits, parseEther } from "ethers";
import { h, clear, toast, short, review, pageHead, seg, copyText, usd, tiny } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, reader, signerFor } from "/agent/js/wallet.js";
import { sendTx, waitReceipt, errText } from "/agent/js/chain.js";
import * as L from "/agent/desk/index-deploy-lib.js";

const VAULT = new Interface([
  "function depositEth(uint256 minShares, address receiver) payable returns (uint256)",
  "function previewDepositEth(uint256 value) view returns (uint256 shares, uint256 fee)",
  "function previewDeposit(uint256 shares) view returns (uint256[] amounts, uint256 fee)",
  "function previewRedeem(uint256 shares) view returns (uint256[] amounts)",
  "function redeem(uint256 shares, address receiver) returns (uint256[] amounts)",
  "function claimOwed(address asset, address to)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)", "function pendingOwner() view returns (address)", "function keeper() view returns (address)",
  "function transferOwnership(address)",
  "function depositsPaused() view returns (bool)", "function rebalancesPaused() view returns (bool)", "function setPaused(bool deposits, bool rebalances)",
  "error NotEthOnly()", "error SharesBelowMinimum(uint256 shares, uint256 minimum)", "error WalletCapExceeded()", "error TotalCapExceeded()", "error DepositsPaused()", "error NotEnoughEth(uint256 needed, uint256 sent)",
]);
const ZAP = new Interface(["function zap(uint256 shares, address receiver, uint256[] venueIds) payable returns (uint256 ethSpent)", "error ReceivedLess(address asset, uint256 needed, uint256 received)", "error BadVenue()"]);
const lc = (s) => String(s || "").toLowerCase();
const EXP = L.EXPLORER;
const ext = (href, text) => h("a", { class: "ulink", href, target: "_blank", rel: "noopener" }, text);
const addrLink = (a, text) => ext(`${EXP}/address/${a}`, text || short(a));
const txLink = (t, text) => ext(`${EXP}/tx/${t}`, text || short(t, 6));
const amt = (x) => (x == null || !isFinite(x) ? "–" : x === 0 ? "0" : Math.abs(x) >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : Math.abs(x) >= 1 ? x.toFixed(4) : tiny(x));
const money = (x) => (x == null || !isFinite(x) ? "–" : usd(x));
const when = (s) => new Date(s * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function left(s) {
  const d = s - Date.now() / 1000;
  if (d <= 0) return "executable now";
  const hh = Math.floor(d / 3600), mm = Math.floor((d % 3600) / 60);
  return hh >= 1 ? `in ${hh} h ${mm} min` : `in ${mm} min`;
}

function css() {
  if (document.querySelector("style[data-iv]")) return;
  document.head.append(h("style", { "data-iv": "1" }, `
.iv { display: grid; gap: 16px; min-width: 0; }
.iv .panel { padding: 18px; min-width: 0; }
.iv h3 { margin: 0 0 10px; font-size: 15px; }
.iv-risk { border-left: 4px solid var(--warn); }
.iv-risk p { margin: 0 0 6px; font-size: 13.5px; }
.iv-risk ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.iv-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.iv-tiles div { padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--bg-2); min-width: 0; }
.iv-tiles small { display: block; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.iv-tiles b { display: block; font-size: 20px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
.iv-tiles span { font-size: 12px; color: var(--muted); }
.iv-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.iv-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.iv-tbl th { text-align: left; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); font-weight: 500; padding: 0 6px 8px; }
.iv-tbl td { padding: 9px 6px; border-top: 1px solid var(--line-2); vertical-align: middle; }
.iv-tbl td.r, .iv-tbl th.r { text-align: right; }
.iv-bar { height: 6px; border-radius: 3px; background: var(--line-2); position: relative; min-width: 60px; }
.iv-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--fg); opacity: .75; }
.iv-bar em { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--warn); }
.iv-sym { font-weight: 600; }
.iv-sub { font-size: 11.5px; color: var(--muted); }
.iv-form { display: grid; gap: 10px; }
.iv-in { display: flex; gap: 8px; align-items: center; }
.iv-in input { flex: 1; min-width: 0; font-size: 16px; }
.iv-out { display: grid; gap: 4px; font-size: 13.5px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--line-2); border-radius: 10px; }
.iv-out div { display: flex; justify-content: space-between; gap: 10px; }
.iv-out span:last-child { text-align: right; overflow-wrap: anywhere; }
.iv-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 13.5px; }
.iv-list li { display: grid; gap: 2px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; overflow-wrap: anywhere; }
.iv-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; font-size: 13px; }
.iv-kv span:nth-child(odd) { color: var(--muted); }
.iv-kv span:nth-child(even) { overflow-wrap: anywhere; }
.iv-out.iv-weights div { flex-wrap: wrap; }
.iv-pending { border-top: 1px dashed var(--line-3); padding-top: 6px; margin-top: 2px; }
.iv-pending .warn { color: var(--warn); }
.iv-pill { display: inline-block; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--warn); color: var(--warn); border-radius: 999px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
.iv-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.iv-steps li { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 12px; }
.iv-steps li.done { border-color: var(--up); }
.iv-n { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--line-3); font-size: 13px; }
.iv-steps li.done .iv-n { border-color: var(--up); color: var(--up); }
.iv-steps small { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.iv-pre { white-space: pre-wrap; word-break: break-all; font-size: 11.5px; background: var(--bg-2); padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line-2); margin: 6px 0 0; font-family: var(--mono, ui-monospace, monospace); }
@media (max-width: 900px) { .iv-grid { grid-template-columns: 1fr; } .iv-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .iv .panel { padding: 14px; } .iv-tbl .hide-s { display: none; } .iv-steps li { grid-template-columns: 30px minmax(0, 1fr); } .iv-steps li > button, .iv-steps li > span.done { grid-column: 2; justify-self: start; } .iv-tiles b { font-size: 17px; } }`));
}

export async function mount(view, ctx = {}) {
  css();
  if (ctx.parts?.[0] === "deploy") return mountDeploy(view);
  let alive = true;
  const st = { d: null, me: null, mode: "deposit", busy: null, preview: null, typed: "" };
  const head = h("div"), risk = h("section", { class: "panel iv-risk" }), tiles = h("div", { class: "iv-tiles" });
  const hold = h("section", { class: "panel" }), act = h("section", { class: "panel" }), queue = h("section", { class: "panel" }), info = h("section", { class: "panel" });
  clear(view, h("div", { class: "dk iv" }, head, risk, tiles, h("div", { class: "iv-grid" }, h("div", { class: "iv", style: { gap: "16px" } }, hold, queue), h("div", { class: "iv", style: { gap: "16px" } }, act, info))));
  head.append(pageHead("Troya Index", "One token, TIDX, for a basket of Robinhood Chain assets kept near its weights by Troya's keeper. Your TIDX is always the same slice of everything the vault holds, and you can take it out in kind at any time.", { badge: "Not audited", badgeClass: "warn" }));

  async function load() {
    try { st.d = await api.get("index"); } catch (e) { st.err = e.message; }
    if (wallet.address && st.d?.deployed) st.me = await api.get(`index/me/${wallet.address}`).catch(() => null); else st.me = null;
    if (alive) paint();
  }

  function paint() {
    const d = st.d;
    if (!d) { clear(hold, st.err ? h("div", { class: "alert error" }, st.err) : h("div", { class: "sk", style: { height: "160px" } })); return; }
    clear(risk, h("h3", {}, "Read this first"), h("p", {}, d.notAudited),
      h("ul", {},
        h("li", {}, "Withdrawals cannot be paused by anyone. You always get your slice of every asset, in kind."),
        h("li", {}, "The team's Safe can pause new deposits and rebalances at once; every other change waits 48 hours in public (the queue below)."),
        h("li", {}, "The keeper can only make the vault trade with itself, at most 20% of an asset every 4 hours, never under the pool's 24-hour median price minus a band."),
        h("li", {}, "Basket tokens can be frozen by their issuers (USDG, stock tokens). A frozen token is kept for you to claim later; the others still pay out."),
        h("li", {}, "Fees: 0.5% of the ETH you deposit, and 1% a year paid by minting TIDX (diluting every holder slightly). Withdrawals are free.")),
      h("p", { class: "fine", style: { marginTop: "8px" } }, ext(d.docs, "The full plan, threat model and test list")));
    if (!d.deployed) return paintPlanned(d);
    clear(tiles,
      tile("Value", money(d.nav.totalUsd), `${amt(d.nav.totalEth)} ETH`),
      tile("One TIDX", money(d.nav.perTidxUsd), `${amt(d.nav.perTidxEth)} ETH`),
      tile("Supply", `${amt(d.supply)} TIDX`, `${d.caps.usedPct.toFixed(1)}% of the ${amt(d.caps.total)} TIDX cap`),
      tile("Fees", `${d.fee.pct}% + ${d.fee.mgmtPctPerYear}%/yr`, "deposit (ETH) + management (TIDX)"));
    paintHoldings(d); paintAct(); paintQueue(d); paintInfo(d);
  }
  const tile = (k, v, s) => h("div", {}, h("small", {}, k), h("b", {}, v), h("span", {}, s));

  function paintPlanned(d) {
    const p = d.planned;
    clear(tiles, tile("Status", "Opening soon", "not deployed yet"), tile("Basket", p.assets.join(" · "), "ETH first"), tile("Caps", `${p.totalCap} TIDX`, `${p.walletCap} per wallet`), tile("Fees", `${p.feePct}% + ${p.mgmtPctPerYear}%/yr`, "deposit + management"));
    clear(hold, h("h3", {}, "Target weights"), h("table", { class: "iv-tbl" }, h("tbody", {}, Object.entries(d.weights?.active?.targets || p.targets).map(([s, w]) => h("tr", {}, h("td", { class: "iv-sym" }, s), h("td", { class: "r" }, `${w}%`))))), weightsBox(d.weights));
    clear(act, h("h3", {}, "Deposit"), h("p", { class: "muted" }, "The vault opens once it is deployed and its source is verified on Blockscout."));
    clear(queue); clear(info, h("h3", {}, "Keeper"), h("div", { class: "iv-kv" }, h("span", {}, "Address"), h("span", {}, d.keeper?.address ? addrLink(d.keeper.address) : "–")));
  }

  function paintHoldings(d) {
    clear(hold, h("h3", {}, "Holdings"),
      h("table", { class: "iv-tbl" },
        h("thead", {}, h("tr", {}, h("th", {}, "Asset"), h("th", { class: "r" }, "Amount"), h("th", { class: "r" }, "Value"), h("th", { class: "hide-s" }, "Weight vs target"))),
        h("tbody", {}, d.holdings.map((x) => h("tr", {},
          h("td", {}, h("div", { class: "iv-sym" }, x.symbol), h("div", { class: "iv-sub" }, x.venue ? `${x.venue.kind}, band ${x.venue.slippageBps / 100}%` : "native")),
          h("td", { class: "r" }, amt(x.amount)),
          h("td", { class: "r" }, money(x.valueUsd), h("div", { class: "iv-sub" }, `${x.weightPct.toFixed(1)}% · target ${x.targetPct}%`)),
          h("td", { class: "hide-s" }, h("div", { class: "iv-bar", title: `${x.weightPct.toFixed(1)}% now, ${x.targetPct}% target` }, h("i", { style: { width: `${Math.min(100, x.weightPct)}%` } }), h("em", { style: { left: `${Math.min(99, x.targetPct)}%` } }))))))),
      h("p", { class: "fine", style: { marginTop: "8px" } }, `Values from the vault's own pools and Troya's market prices; ETH at ${money(d.nav.ethUsd)}. The keeper trades when a weight drifts more than ${d.driftPct} points from its target.`),
      weightsBox(d.weights));
  }
  // the keeper's target weights, and any change waiting its 48 hours (Xivor, 26 Nov 2026: weights never change silently)
  function weightsBox(w) {
    if (!w) return null;
    const line = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}%`).join(" · ");
    return h("div", { class: "iv-out iv-weights", style: { marginTop: "10px" } },
      h("div", {}, h("b", {}, "Target weights"), h("span", {}, w.active.since ? `since ${new Date(w.active.since).toLocaleDateString()}` : "from launch")),
      h("div", {}, h("span", {}, line(w.active.targets))),
      w.pending ? h("div", { class: "iv-pending" }, h("span", {}, h("b", { class: "warn" }, "Scheduled change: "), line(w.pending.targets)), h("span", {}, `takes effect ${left(w.pending.activatesAt / 1000)} (${when(w.pending.activatesAt / 1000)})`)) : h("div", {}, h("span", { class: "iv-sub" }, "No weight change is scheduled. Any change is announced 48 hours before it applies.")));
  }

  function paintQueue(d) {
    clear(queue, h("h3", {}, "Timelock queue"),
      d.pending.length ? h("ul", { class: "iv-list" }, d.pending.map((p) => h("li", {}, h("b", {}, p.text), h("span", { class: "iv-sub" }, `Executable ${left(p.eta)} (${when(p.eta)}), lapses ${new Date(p.expiresAt).toLocaleDateString()}. `, txLink(p.tx, "Proposal"))))) : h("p", { class: "muted", style: { margin: 0 } }, "No change is waiting. Any change to the keeper, fees, caps, basket or pools is shown here for 48 hours before it can take effect."),
      d.recent?.length ? h("details", { style: { marginTop: "10px" } }, h("summary", { class: "fine" }, "Recent vault events"), h("ul", { class: "iv-list", style: { marginTop: "8px" } }, d.recent.map((e) => h("li", {}, h("span", {}, e.name, e.text ? `: ${e.text}` : ""), h("span", { class: "iv-sub" }, txLink(e.tx)))))) : null);
  }

  function paintInfo(d) {
    const c = d.contracts;
    clear(info, h("h3", {}, "Contracts and rules"),
      h("div", { class: "iv-kv" },
        h("span", {}, "Vault (TIDX)"), h("span", {}, addrLink(c.vault.address)),
        h("span", {}, "Zap"), h("span", {}, c.zap ? addrLink(c.zap.address) : "–"),
        h("span", {}, "Swapper"), h("span", {}, addrLink(c.swapper.address)),
        h("span", {}, "Owner"), h("span", {}, addrLink(d.owner), d.ownerIsSafe ? " (team Safe)" : d.pendingOwner ? ` (handing over to ${short(d.pendingOwner)})` : ""),
        h("span", {}, "Keeper"), h("span", {}, addrLink(d.keeper.onChain)),
        h("span", {}, "Deposit fee"), h("span", {}, `${d.fee.pct}% of the ETH part, to `, addrLink(d.fee.recipient, d.fee.recipientIsFeeRouter ? "TroyaFeeRouter" : short(d.fee.recipient))),
        h("span", {}, "Management fee"), h("span", {}, `${d.fee.mgmtPctPerYear}% a year in TIDX, to `, addrLink(d.fee.mgmtRecipient)),
        h("span", {}, "Caps"), h("span", {}, `${amt(d.caps.total)} TIDX total, ${amt(d.caps.wallet)} per wallet`),
        h("span", {}, "Rebalance"), h("span", {}, `at most ${d.rules.maxMovePct}% per move, every ${d.rules.cooldownHours} h`),
        h("span", {}, "Last rebalance"), h("span", {}, d.lastRebalance?.tx ? txLink(d.lastRebalance.tx, `${d.lastRebalance.assetIn || ""} → ${d.lastRebalance.assetOut || ""}`) : "none yet"),
        h("span", {}, "Status"), h("span", {}, d.paused.deposits ? "new deposits paused" : "deposits open", " · ", d.paused.rebalances ? "rebalances paused" : "rebalances running", " · withdrawals always open")));
  }

  /* ---------- deposit / redeem ---------- */
  function paintAct() {
    const d = st.d;
    if (!d?.deployed) return;
    const modeSeg = seg([{ value: "deposit", label: "Deposit" }, { value: "redeem", label: "Redeem" }], st.mode, (v) => { st.mode = v; st.preview = null; st.typed = ""; paintAct(); }, "iv-seg");
    const kids = [h("h3", {}, "Your TIDX"), modeSeg];
    if (!wallet.address) { kids.push(h("p", { class: "muted" }, "Connect a wallet to deposit or redeem."), h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet")); return clear(act, ...kids); }
    const me = st.me;
    kids.push(h("div", { class: "iv-out", style: { marginTop: "10px" } },
      h("div", {}, h("span", {}, "You hold"), h("span", {}, `${amt(me?.shares || 0)} TIDX`)),
      h("div", {}, h("span", {}, "Worth now"), h("span", {}, money(me?.redeemUsd)))));
    // what the user typed survives the panel being redrawn by a refresh (wallet event, the 60 s timer)
    const input = h("input", { class: "input", inputmode: "decimal", placeholder: st.mode === "deposit" ? "ETH to put in" : "TIDX to redeem", autocomplete: "off", value: st.typed });
    const out = h("div", { class: "iv-out", hidden: true });
    const go = h("button", { class: "btn primary", type: "button", disabled: !!st.busy }, st.busy || (st.mode === "deposit" ? "Review deposit" : "Review redeem"));
    const maxBtn = st.mode === "redeem" ? h("button", { class: "btn sm", type: "button", onclick: () => { input.value = String(me?.shares || 0); input.dispatchEvent(new Event("input")); } }, "Max") : null;
    let t = 0;
    input.addEventListener("input", () => { st.typed = input.value; clearTimeout(t); t = setTimeout(() => quote(input.value, out), 350); });
    go.addEventListener("click", () => (st.mode === "deposit" ? doDeposit(input.value) : doRedeem(input.value)));
    kids.push(h("div", { class: "iv-form", style: { marginTop: "12px" } }, h("div", { class: "iv-in" }, input, maxBtn), out, go,
      h("p", { class: "fine", style: { margin: 0 } }, st.mode === "deposit"
        ? (d.ethOnly ? "While the vault holds only ETH, your ETH mints TIDX at the vault's ETH per TIDX." : "The vault holds tokens: the zap buys your share of each with ETH in the vault's own pools, deposits it all, and refunds what is left. You approve a maximum; you pay at most that.")
        : "You receive your slice of every asset the vault holds. Nothing can pause this.")));
    if (me?.owed?.length) kids.push(h("div", { style: { marginTop: "14px" } }, h("h3", {}, "Kept for you"), h("p", { class: "fine" }, "A redeem could not send these (the token refused, or your wallet refused ETH). Take them out to this wallet or another."),
      h("ul", { class: "iv-list" }, me.owed.map((o) => h("li", {}, h("span", {}, `${amt(o.amount)} ${o.symbol}`), h("button", { class: "btn sm", type: "button", onclick: () => doClaim(o) }, "Take out"))))));
    const focused = document.activeElement?.closest?.(".iv-in") != null;
    clear(act, ...kids);
    if (st.typed) { if (focused) input.focus(); quote(st.typed, out); }
  }

  const call = async (to, iface, fn, args, value = 0n) => iface.decodeFunctionResult(fn, await reader("robinhood").call({ from: wallet.address, to, data: iface.encodeFunctionData(fn, args), value }));
  const vaultAddr = () => st.d.contracts.vault.address;
  async function quote(v, out) {
    const d = st.d;
    out.hidden = true;
    const x = Number(v);
    if (!(x > 0)) return;
    try {
      if (st.mode === "redeem") {
        const sh = parseEther(String(v));
        const [a] = await call(vaultAddr(), VAULT, "previewRedeem", [sh]);
        st.preview = { shares: sh, amounts: a };
        clear(out, h("div", {}, h("b", {}, "You receive"), h("span", {})), ...d.holdings.map((hh, i) => h("div", {}, h("span", {}, hh.symbol), h("span", {}, `${amt(Number(formatUnits(a[i] ?? 0n, hh.decimals)))}${hh.priceUsd ? ` (${money(Number(formatUnits(a[i] ?? 0n, hh.decimals)) * hh.priceUsd)})` : ""}`))));
      } else if (d.ethOnly) {
        const value = parseEther(String(v));
        const [shares, fee] = await call(vaultAddr(), VAULT, "previewDepositEth", [value]);
        st.preview = { value, shares };
        clear(out, h("div", {}, h("span", {}, "You get"), h("span", {}, `${amt(Number(formatEther(shares)))} TIDX`)), h("div", {}, h("span", {}, "Deposit fee"), h("span", {}, `${amt(Number(formatEther(fee)))} ETH`)));
      } else {
        if (!d.contracts.zap) throw new Error("The zap is not configured yet.");
        const value = parseEther(String(v));
        // aim the shares 3% under what the ETH buys at the vault's value per TIDX: pool fees, the deposit fee, a little room
        const per = d.nav.perTidxEth;
        if (!(per > 0)) throw new Error("No value per TIDX yet.");
        const shares = parseEther(((x * 0.97) / per).toFixed(18));
        const [spent] = await call(d.contracts.zap.address, ZAP, "zap", [shares, wallet.address, d.zapVenues], value);
        st.preview = { value, shares, spent };
        clear(out, h("div", {}, h("span", {}, "You get"), h("span", {}, `${amt(Number(formatEther(shares)))} TIDX`)), h("div", {}, h("span", {}, "Quoted cost"), h("span", {}, `${amt(Number(formatEther(spent)))} ETH`)), h("div", {}, h("span", {}, "Most you can pay"), h("span", {}, `${amt(x)} ETH (the rest comes back)`)));
      }
      out.hidden = false;
    } catch (e) { st.preview = null; clear(out, h("span", { class: "down" }, errText(e))); out.hidden = false; }
  }

  const run = async (label, fn) => { if (st.busy) return; st.busy = label; paintAct(); let done = false; try { done = (await fn()) === true; } catch (e) { toast(errText(e), "error", 8000); } st.busy = null; if (done) { st.typed = ""; st.preview = null; } await load(); };
  const doDeposit = (v) => run("Depositing…", async () => {
    const d = st.d, p = st.preview;
    if (!p || !(Number(v) > 0)) throw new Error("Enter an amount and wait for the quote.");
    if (d.ethOnly) {
      const min = (p.shares * 995n) / 1000n;
      if (!(await review({ title: "Deposit ETH", summary: `${v} ETH → about ${amt(Number(formatEther(p.shares)))} TIDX`, rows: [["Fee", `${d.fee.pct}% of the ETH`], ["Least you accept", `${amt(Number(formatEther(min)))} TIDX`], ["Contract", short(vaultAddr())]], confirmLabel: "Continue in wallet" }))) return;
      const hash = await sendTx("robinhood", { to: vaultAddr(), data: VAULT.encodeFunctionData("depositEth", [min, wallet.address]), value: p.value.toString() });
      const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
      if (rc?.status !== 1) throw new Error("The deposit failed on chain.");
    } else {
      if (!(await review({ title: "Deposit through the zap", summary: `${amt(Number(formatEther(p.shares)))} TIDX for at most ${v} ETH`, rows: [["Quoted cost", `${amt(Number(formatEther(p.spent)))} ETH`], ["Refunded", "everything not spent"], ["Contract", short(d.contracts.zap.address)]], warn: "Prices can move before your transaction lands; if the ETH you send is not enough, it fails and costs only gas.", confirmLabel: "Continue in wallet" }))) return;
      const hash = await sendTx("robinhood", { to: d.contracts.zap.address, data: ZAP.encodeFunctionData("zap", [p.shares, wallet.address, d.zapVenues]), value: p.value.toString() });
      const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
      if (rc?.status !== 1) throw new Error("The zap failed on chain.");
    }
    toast("Deposited. Your TIDX are in your wallet.", "ok", 6000);
    return true;
  });
  const doRedeem = (v) => run("Redeeming…", async () => {
    const p = st.preview;
    if (!p || !(Number(v) > 0)) throw new Error("Enter an amount and wait for the preview.");
    const rows = st.d.holdings.map((hh, i) => [hh.symbol, amt(Number(formatUnits(p.amounts[i] ?? 0n, hh.decimals)))]);
    if (!(await review({ title: "Redeem TIDX", summary: `Burn ${v} TIDX and receive your slice of every asset`, rows, confirmLabel: "Continue in wallet" }))) return;
    const hash = await sendTx("robinhood", { to: vaultAddr(), data: VAULT.encodeFunctionData("redeem", [p.shares, wallet.address]), value: "0" });
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
    if (rc?.status !== 1) throw new Error("The redeem failed on chain.");
    toast("Redeemed. The assets are in your wallet (anything a token refused is kept for you below).", "ok", 7000);
    return true;
  });
  const doClaim = (o) => run("Taking out…", async () => {
    const hash = await sendTx("robinhood", { to: vaultAddr(), data: VAULT.encodeFunctionData("claimOwed", [o.asset, wallet.address]), value: "0" });
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
    if (rc?.status !== 1) throw new Error("It still failed; it stays kept for you. Try again later.");
    toast(`${o.symbol} sent to your wallet.`, "ok");
  });

  const off = onWallet(() => { if (alive) load(); });
  const tick = setInterval(() => { if (!document.hidden && !st.busy) load(); }, 60_000);
  await load();
  return () => { alive = false; off(); clearInterval(tick); };
}

/* ====================================================================== */
/* #/vault/deploy: the owner deploys from his own browser wallet           */
/* ====================================================================== */
const KEY = "troya.index.deploy.v1";
const loadRun = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const saveRun = (r) => { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch {} };

async function mountDeploy(view) {
  let alive = true;
  const st = { run: loadRun(), build: null, keeper: null, busy: null, err: null, live: {} };
  const box = h("div", { class: "dk iv" });
  clear(view, box);

  async function load() {
    try {
      const [b, k] = await Promise.all([fetch("/agent/desk/troya-index.json").then((r) => r.json()), api.get("index/keeper")]);
      st.build = b; st.keeper = k;
    } catch (e) { st.err = e.message; }
    await readLive();
    if (alive) paint();
  }
  async function readLive() {
    const v = st.run.vault?.address;
    if (!v) return;
    try {
      const rd = reader("robinhood");
      const dec = async (fn) => VAULT.decodeFunctionResult(fn, await rd.call({ to: v, data: VAULT.encodeFunctionData(fn, []) }))[0];
      st.live = { owner: await dec("owner"), pending: await dec("pendingOwner"), keeper: await dec("keeper"), paused: await dec("depositsPaused").catch(() => null) };
    } catch {}
  }
  const isCreator = () => lc(wallet.address) === lc(L.CREATOR);
  const keeperOk = () => st.keeper?.address && !st.keeper.refused && lc(st.keeper.address) !== lc(L.CREATOR);

  function paint() {
    const r = st.run, b = st.build;
    const kids = [pageHead("Deploy Troya Index", "For the $TROYA creator wallet only. Three contracts are created from the tested build with the approved parameters, then the vault is handed to the team Safe. Each step is one transaction in your wallet.", { badge: "Owner", badgeClass: "warn" })];
    if (st.err) kids.push(h("div", { class: "alert error" }, st.err));
    kids.push(proposerPanel());
    if (!wallet.address) kids.push(h("section", { class: "panel" }, h("p", {}, `Connect the creator wallet ${short(L.CREATOR)} to continue.`), h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet")));
    else if (!isCreator()) kids.push(h("section", { class: "panel" }, h("div", { class: "alert warn" }, `The connected wallet ${short(wallet.address)} is not the creator wallet ${short(L.CREATOR)}. This page only proceeds with the creator wallet.`)));
    // the parameters, always visible so they can be checked before connecting
    const P = L.PARAMS;
    kids.push(h("section", { class: "panel" }, h("h3", {}, "What will be deployed"),
      h("div", { class: "iv-kv" },
        h("span", {}, "Build"), h("span", {}, b ? `solc ${b.compiler}, 500 runs, shanghai · source ${b.sourceCommit || "?"} · vault ${b.contracts.TroyaIndex.runtimeBytes.toLocaleString()} B` : "loading…"),
        h("span", {}, "Owner at deploy"), h("span", {}, `${short(L.CREATOR)} (you), then handed to the Safe ${short(L.SAFE)}`),
        h("span", {}, "Keeper"), h("span", {}, st.keeper?.address ? h("span", {}, addrLink(st.keeper.address), st.keeper.refused ? h("b", { class: "down" }, ` ${st.keeper.refused}`) : " (the server's keeper wallet)") : "loading…"),
        h("span", {}, "Guardian"), h("span", {}, "none"),
        h("span", {}, "Deposit fee"), h("span", {}, `${P.feeBps / 100}% in ETH (max 2%), to TroyaFeeRouter ${short(P.feeRecipient)}`),
        h("span", {}, "Management fee"), h("span", {}, `${P.mgmtFeeBps / 100}% a year in TIDX (max 2%), to ${short(P.mgmtFeeRecipient)}`),
        h("span", {}, "Caps"), h("span", {}, `${formatEther(P.totalCap)} TIDX total, ${formatEther(P.walletCap)} per wallet`),
        h("span", {}, "Rebalance"), h("span", {}, `${P.maxMoveBps / 100}% per move, every ${P.cooldown / 3600} h`),
        h("span", {}, "Basket"), h("span", {}, "ETH, USDG, SPY, NVDA, $TROYA"),
        h("span", {}, "Pools"), h("span", {}, P.venues.map((v) => `${v.label} (band ${v.slippageBps / 100}%)`).join(" · ")))));
    const ready = isCreator() && b && keeperOk();
    const step = (n, key, title, sub, fn, enabled) => {
      const done = r[key];
      return h("li", { class: done ? "done" : "" }, h("span", { class: "iv-n" }, done ? "ok" : String(n)),
        h("div", {}, h("b", {}, title), h("small", {}, done ? h("span", {}, done.address ? h("span", {}, addrLink(done.address), " · ") : null, txLink(done.hash, `tx ${short(done.hash, 6)}`)) : sub)),
        done ? h("span", { class: "done fine" }, "Done") : h("button", { class: "btn primary sm", type: "button", disabled: !enabled || !!st.busy, onclick: fn }, st.busy === key ? "Waiting…" : "Sign"));
    };
    kids.push(h("section", { class: "panel" }, h("h3", {}, "Steps"),
      h("ol", { class: "iv-steps" },
        step(1, "swapper", "Deploy the swapper", "TroyaIndexSwapper: the stateless swap engine (no owner).", () => deployStep("swapper"), ready),
        step(2, "vault", "Deploy the vault (TIDX)", "TroyaIndex with the parameters above; you are its owner until the Safe accepts.", () => deployStep("vault"), ready && !!r.swapper),
        step(3, "zap", "Deploy the zap", "TroyaIndexZap: deposits with ETH only (no owner).", () => deployStep("zap"), ready && !!r.vault),
        step(4, "transfer", "Hand the vault to the Safe", `transferOwnership(${short(L.SAFE)}): the Safe becomes pending owner; it must accept.`, () => transferStep(), ready && !!r.zap)),
      st.busy ? h("p", { class: "fine" }, "Confirm in your wallet, then wait for the block…") : null,
      Object.keys(r).length ? h("p", { class: "fine", style: { marginTop: "10px" } }, h("button", { class: "link", type: "button", onclick: async () => { if (await review({ title: "Forget this run?", summary: "Only this browser's record is cleared. Contracts already deployed stay on chain.", confirmLabel: "Forget", danger: true })) { st.run = {}; saveRun({}); paint(); } } }, "Start over (forget this browser's record)")) : null));
    if (r.transfer) kids.push(finalPanel());
    clear(box, ...kids);
  }

  function finalPanel() {
    const r = st.run, live = st.live;
    const accepted = lc(live.owner) === lc(L.SAFE);
    const cmds = L.verifyCommands({ swapper: r.swapper.address, vault: r.vault.address, zap: r.zap.address, owner: L.CREATOR, keeper: r.keeper });
    const env = L.serverEnv({ vault: r.vault.address, zap: r.zap.address, block: r.vault.block });
    const copyBtn = (t, label) => h("button", { class: "btn sm", type: "button", onclick: () => copyText(t, "Copied") }, label);
    return h("section", { class: "panel" }, h("h3", {}, "Done on your side. Next:"),
      h("div", { class: "iv-kv" },
        h("span", {}, "Owner now"), h("span", {}, live.owner ? addrLink(live.owner, accepted ? "the Safe (accepted)" : short(live.owner)) : "–"),
        h("span", {}, "Pending owner"), h("span", {}, live.pending && !/^0x0{40}$/i.test(live.pending) ? addrLink(live.pending, lc(live.pending) === lc(L.SAFE) ? "the Safe (waiting for it to accept)" : short(live.pending)) : accepted ? "none" : "–"),
        h("span", {}, "Keeper"), h("span", {}, live.keeper ? addrLink(live.keeper) : "–")),
      // deposits stay shut until the bounty is published and the opening is announced (the creator can pause only before the Safe accepts)
      h("h3", { style: { marginTop: "14px" } }, "0. Keep deposits shut until the opening"),
      live.paused === true
        ? h("p", { class: "fine" }, "Deposits are paused. Withdrawals always stay open. The Safe resumes deposits (setPaused false, false) when the opening is announced.")
        : accepted
          ? h("p", { class: "fine" }, "Deposits are open on chain. The Safe owns the vault now, so pause them from the Safe: setPaused(true, true).")
          : h("div", {}, h("p", { class: "fine" }, "Deposits are open on chain right now. Pause them from this wallet before the Safe accepts ownership (after that, only the Safe can). Withdrawals cannot be paused."),
            h("button", { class: "btn primary", type: "button", disabled: !!st.busy || !isCreator(), onclick: pauseStep }, st.busy === "pause" ? "Confirm in your wallet…" : "Pause deposits now")),
      h("h3", { style: { marginTop: "14px" } }, "1. The Safe accepts ownership"),
      h("p", { class: "fine" }, "Until the Safe accepts, your wallet stays the owner (every change still waits 48 hours). In the Safe app (app.safe.global, Robinhood Chain): New transaction → Transaction Builder → address ", h("span", { class: "mono" }, r.vault.address), ", enter the raw data below with value 0, then two of the three signers sign and one executes."),
      h("pre", { class: "iv-pre" }, `to:    ${r.vault.address}\nvalue: 0\ndata:  ${L.acceptData()}   (acceptOwnership())`),
      copyBtn(L.acceptData(), "Copy data"),
      h("h3", { style: { marginTop: "14px" } }, "2. Source verification on Blockscout (for the team, from contracts/)"),
      h("pre", { class: "iv-pre" }, cmds.join("\n\n")), copyBtn(cmds.join("\n"), "Copy commands"),
      h("h3", { style: { marginTop: "14px" } }, "3. Server settings"),
      h("pre", { class: "iv-pre" }, env.join("\n")), copyBtn(env.join("\n"), "Copy"),
      h("p", { class: "fine" }, "Then fund the keeper with a little ETH for gas (0.005 ETH lasts a long time) and switch it on with INDEX_KEEPER=1. Announce only after the owner's go-ahead."));
  }

  const send = async (key, tx) => {
    st.busy = key; paint();
    const signer = await signerFor("robinhood");
    const hash = await signer.sendUncheckedTransaction(tx);
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 240_000 });
    if (rc?.status !== 1) throw new Error(`Step ${key} failed on chain (${hash}).`);
    return { hash, rc };
  };
  const guardStep = () => {
    if (!isCreator()) throw new Error("Connect the creator wallet.");
    if (!keeperOk()) throw new Error(`The server's keeper address is not usable: ${st.keeper?.refused || "missing"}.`);
  };
  async function deployStep(which) {
    if (st.busy) return;
    try {
      guardStep();
      const r = st.run, b = st.build;
      if (r.keeper && lc(r.keeper) !== lc(st.keeper.address)) throw new Error("The server's keeper changed since this run started. Start over.");
      r.keeper = st.keeper.address;
      const data = which === "swapper" ? L.swapperData(b) : which === "vault" ? L.vaultData(b, { owner: wallet.address, swapper: r.swapper.address, keeper: r.keeper }) : L.zapData(b, r.vault.address);
      const names = { swapper: "TroyaIndexSwapper", vault: "TroyaIndex", zap: "TroyaIndexZap" };
      if (!(await review({ title: `Deploy ${names[which]}`, summary: "A contract creation from the tested build. No ETH is sent; only gas.", rows: [["Signer", `${short(wallet.address)} (creator wallet)`], ["Size", `${((data.length - 2) / 2).toLocaleString()} bytes of creation code`]], confirmLabel: "Continue in wallet" }))) return;
      const { hash, rc } = await send(which, { data });
      const address = rc.contractAddress;
      if (!address) throw new Error("No contract address in the receipt.");
      const code = await reader("robinhood").getCode(address);
      if (!code || code === "0x") throw new Error("The new contract has no code.");
      r[which] = { hash, address, block: rc.blockNumber };
      saveRun(r);
      toast(`${names[which]} deployed at ${short(address)}.`, "ok", 6000);
    } catch (e) { toast(errText(e), "error", 9000); }
    st.busy = null; await readLive(); paint();
  }
  async function transferStep() {
    if (st.busy) return;
    try {
      guardStep();
      const r = st.run;
      if (!(await review({ title: "Hand the vault to the Safe", summary: `transferOwnership(${L.SAFE})`, rows: [["Vault", short(r.vault.address)], ["After", "The Safe must accept (step shown next)"]], confirmLabel: "Continue in wallet" }))) return;
      const { hash } = await send("transfer", { to: r.vault.address, data: L.transferData(), value: 0n });
      r.transfer = { hash };
      saveRun(r);
      toast("Ownership offered to the Safe. Now the Safe accepts.", "ok", 7000);
    } catch (e) { toast(errText(e), "error", 9000); }
    st.busy = null; await readLive(); paint();
  }

  // the server proposer: one EIP-712 signature from a Safe signer registers it with the Safe Transaction Service (free; the
  // Safe app's own "Add proposer" is a paid feature). It can only queue transactions; owners still confirm and execute.
  async function loadProposer() {
    try { st.prop = await (await fetch("/api/safe/proposer")).json(); } catch { st.prop = null; }
    if (alive) paint();
  }
  function proposerPanel() {
    const p = st.prop;
    const isOwner = p && wallet.address && (p.owners || []).some((o) => lc(o) === lc(wallet.address));
    return h("section", { class: "panel" }, h("h3", {}, "Safe proposer (team)"),
      h("p", { class: "fine" }, "The server's proposer wallet puts transactions in the team Safe's queue (for example: open deposits), so the team only confirms and executes them in the Safe app. It cannot confirm, execute or hold funds."),
      !p ? h("p", { class: "muted" }, "Loading…")
        : h("div", { class: "iv-kv" }, h("span", {}, "Proposer"), h("span", {}, p.proposer ? addrLink(p.proposer) : "not set on the server"),
          h("span", {}, "Status"), h("span", {}, p.registered ? `registered (by ${short(p.delegators?.[0] || "")})` : "not registered yet")),
      p && !p.registered && p.proposer ? (isOwner
        ? h("button", { class: "btn primary", type: "button", disabled: st.busy === "prop", onclick: registerProposer }, st.busy === "prop" ? "Sign in your wallet…" : "Register the proposer (one signature, no gas)")
        : h("p", { class: "fine" }, wallet.address ? `Connect one of the Safe's signers to register it (the connected wallet ${short(wallet.address)} is not one).` : "Connect one of the Safe's signers to register it.")) : null);
  }
  async function registerProposer() {
    if (st.busy) return;
    st.busy = "prop"; paint();
    try {
      const p = st.prop;
      const totp = Math.floor(Date.now() / 1000 / 3600);
      const signer = await signerFor("robinhood");
      const domain = { name: "Safe Transaction Service", version: "1.0", chainId: 4663 };
      const types = { Delegate: [{ name: "delegateAddress", type: "address" }, { name: "totp", type: "uint256" }] };
      const signature = await signer.signTypedData(domain, types, { delegateAddress: p.proposer, totp });
      const res = await fetch("/api/safe/delegate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delegator: wallet.address, signature, totp }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      toast(j.already ? "The proposer was already registered." : "Proposer registered with the Safe.", "ok", 7000);
    } catch (e) { toast(errText(e), "error", 9000); }
    st.busy = null; await loadProposer();
  }

  async function pauseStep() {
    if (st.busy) return;
    try {
      if (!isCreator()) throw new Error("Connect the creator wallet.");
      const r = st.run;
      if (!(await review({ title: "Pause deposits", summary: "setPaused(true, true): new deposits and rebalances stop. Withdrawals stay open. No ETH is sent; only gas.", rows: [["Vault", short(r.vault.address)], ["Signer", `${short(wallet.address)} (creator wallet)`]], confirmLabel: "Pause" }))) return;
      await send("pause", { to: r.vault.address, data: VAULT.encodeFunctionData("setPaused", [true, true]), value: 0n });
      toast("Deposits paused. Next: the Safe accepts ownership.", "ok", 7000);
    } catch (e) { toast(errText(e), "error", 9000); }
    st.busy = null; await readLive(); paint();
  }

  const off = onWallet(() => { if (alive) paint(); });
  await load();
  loadProposer();
  return () => { alive = false; off(); };
}
