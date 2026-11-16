// Bridge (#/bridge?dir=in|out|hl&chain=arbitrum|base|ethereum): ETH into and out of Robinhood Chain through LI.FI routes,
// and To Hyperliquid (dir=hl): ETH on Robinhood Chain → USDC on the user's own Hyperliquid account for perps.
// The route and its calldata come from LI.FI via the server; the transaction is signed on the source chain in the user's wallet.
import { h, clear, pageHead, seg, icon, review, toast, tiny, num, short, useCss, debounce, infoTip, copyText, ago, chainLogo, venueLogo, tokenIcon } from "../ui.js";
import { wallet, onWallet, openConnect, addChain, CHAINS } from "../wallet.js";
import { api } from "../api.js";
import { balanceOf, toRaw, fromRaw, inputNum, rawInput, sendTx, waitReceipt, errText, journal, transfers, addTransfer, updateTransfer } from "../chain.js";

const HOME = { id: 4663, key: "robinhood", name: "Robinhood Chain" };
const OTHER = [{ id: 42161, key: "arbitrum", name: "Arbitrum" }, { id: 8453, key: "base", name: "Base" }, { id: 1, key: "ethereum", name: "Ethereum" }];
const HL = { id: 1337, key: "hyperliquid", name: "Hyperliquid" };

export async function mount(view, ctx) {
  useCss("bridge");
  let alive = true;
  const st = {
    dir: ["out", "hl"].includes(ctx.query.dir) ? ctx.query.dir : "in", other: OTHER.find((c) => c.key === ctx.query.chain) || OTHER[0],
    amount: ctx.query.amount && /^\d*\.?\d+$/.test(ctx.query.amount) ? ctx.query.amount : "", bal: null, busy: false, lq: null, lqErr: null, lqLoading: false, lqSeq: 0,
  };
  const src = () => (st.dir === "in" ? st.other : HOME);
  const dst = () => (st.dir === "in" ? HOME : st.dir === "hl" ? HL : st.other);
  const isHl = () => st.dir === "hl";
  const outSym = () => (isHl() ? "USDC" : "ETH");
  const outDec = (q) => Number(q?.toDecimals ?? 18);

  const box = h("div", { class: "br-box" });
  const addSec = h("section", { class: "br-section" });
  const listSec = h("section", { class: "br-section" });
  clear(view,
    pageHead("Bridge", "Move ETH onto Robinhood Chain from Arbitrum, Base or Ethereum, take it back out, or fund your Hyperliquid account with USDC for perps. Routes come from LI.FI and usually land in minutes."),
    h("div", { class: "br-wrap" }, box, addSec, listSec));

  const amountInput = h("input", { class: "br-amt", inputmode: "decimal", placeholder: "0", autocomplete: "off", "aria-label": "Amount", value: st.amount });
  amountInput.addEventListener("input", () => {
    const v = amountInput.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    if (v !== amountInput.value) amountInput.value = v;
    st.amount = v;
    paint();
    requote();
  });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => act() });
  const balLine = h("button", { class: "br-bal", type: "button", onclick: () => setMax() });
  const recvOut = h("div", { class: "br-amt out" }, "0");
  const rowsBox = h("div", { class: "rows br-rows" });
  const noteBox = h("p", { class: "note br-note" });
  const warnBox = h("div", { class: "br-warn" });
  const statusBox = h("div", { class: "br-status" });

  function render() {
    const dirSeg = seg([{ value: "in", label: h("span", { class: "seg-ico" }, chainLogo("robinhood", 14), "Into Robinhood Chain") }, { value: "out", label: "Out of Robinhood Chain" }, { value: "hl", label: h("span", { class: "seg-ico" }, chainLogo("hyperliquid", 14), "To Hyperliquid") }], st.dir,
      (v) => { st.dir = v; st.lq = null; render(); refreshBal(); requote(); });
    const otherSeg = seg(OTHER.map((c) => ({ value: c.id, label: h("span", { class: "seg-ico" }, chainLogo(c.key, 14), c.name) })), st.other.id,
      (v) => { st.other = OTHER.find((c) => c.id === v); st.lq = null; render(); refreshBal(); requote(); });
    const s = src(), d = dst();
    clear(box,
      h("div", { class: "br-ctrls" }, dirSeg),
      isHl() ? h("p", { class: "muted br-hlnote" }, "ETH on Robinhood Chain becomes USDC on your own Hyperliquid account, ready as margin for perps. Then trade on Perps, or approve your Agent Wallet once and let it trade.")
        : h("div", { class: "br-ctrls" }, h("span", { class: "muted" }, st.dir === "in" ? "From" : "To"), otherSeg),
      h("div", { class: "br-card panel" },
        h("div", { class: "br-leg" },
          h("div", { class: "br-leg-top" }, h("span", { class: "row" }, "From ", chainLogo(s.key, 16), h("b", {}, s.name)), balLine),
          h("div", { class: "br-leg-main" }, amountInput, h("span", { class: "br-sym" }, tokenIcon({ symbol: "ETH", chain: s.key }, "xs"), "ETH"))),
        h("div", { class: "br-quick" }, ["0.01", "0.05", "0.1", "0.5"].map((v) => h("button", { type: "button", class: "chip", onclick: () => { amountInput.value = v; amountInput.dispatchEvent(new Event("input")); } }, `${v} ETH`))),
        h("div", { class: "br-leg" },
          h("div", { class: "br-leg-top" }, h("span", { class: "row" }, "To ", chainLogo(d.key, 16), h("b", {}, d.name)), h("span", { class: "muted" }, isHl() ? "Your Hyperliquid account" : "Same wallet")),
          h("div", { class: "br-leg-main" }, recvOut, h("span", { class: "br-sym" }, tokenIcon({ symbol: outSym(), chain: d.key === "hl" ? "hyperliquid" : d.key }, "xs"), outSym()))),
        rowsBox, warnBox, noteBox, btn, statusBox));
    paint();
  }

  function paint() {
    const raw = toRaw(st.amount, 18);
    const s = src();
    clear(balLine, wallet.address ? (st.bal ? `Balance ${tiny(st.bal.amount)} ETH` : "Balance …") : "");
    balLine.disabled = !st.bal;
    clear(warnBox);
    const q = st.lq;
    recvOut.textContent = q ? tiny(fromRaw(q.toAmount, outDec(q))) : st.lqLoading ? "…" : "0";
    recvOut.classList.toggle("dim", !q);
    clear(rowsBox, q ? [
      h("div", {}, h("span", {}, "You receive (est.)"), h("span", {}, `${tiny(fromRaw(q.toAmount, outDec(q)))} ${outSym()}`)),
      h("div", {}, h("span", {}, "Minimum"), h("span", {}, `${tiny(fromRaw(q.toAmountMin, outDec(q)))} ${outSym()}`)),
      h("div", {}, h("span", {}, "Route"), h("span", { class: "tok-link" }, venueLogo("lifi", 14), `${q.tool} via LI.FI`)),
      h("div", {}, h("span", {}, "Arrives"), h("span", {}, q.executionSec ? `~${q.executionSec < 90 ? `${Math.max(1, Math.round(q.executionSec))} s` : `${Math.round(q.executionSec / 60)} min`}` : "Usually a few minutes")),
      h("div", {}, h("span", {}, "Route fees"), h("span", {}, `$${num(q.feeUsd + q.gasUsd, 2)}`)),
    ] : []);
    rowsBox.hidden = !q;
    if (st.lqErr) warnBox.append(h("div", { class: "alert error" }, st.lqErr));
    clear(noteBox, isHl() ? `One transaction on ${s.name}. LI.FI swaps your ETH to USDC and delivers it to your own Hyperliquid account (same address); route fees are in the quote. Troya adds no fee.`
      : `One transaction on ${s.name}. A bridge or relayer found by LI.FI delivers ETH to the same address on ${dst().name}; its fee is included in the quote. Troya adds no fee.`);
    let label, disabled = false;
    if (!wallet.address) label = isHl() ? "Connect wallet to fund Hyperliquid" : "Connect wallet to bridge";
    else if (!raw || raw <= 0n) { label = "Enter an amount"; disabled = true; }
    else if (st.bal && raw > st.bal.raw) { label = `Not enough ETH on ${s.name}`; disabled = true; }
    else if (!st.lq) { label = st.lqLoading ? "Finding a route…" : st.lqErr ? "No route" : "Finding a route…"; disabled = true; }
    else label = isHl() ? "Review funding" : "Review bridge";
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
  }

  async function refreshBal() {
    st.bal = null;
    if (!wallet.address) { paint(); return; }
    paint();
    try { st.bal = await balanceOf(wallet.address, undefined, src().key); } catch { st.bal = null; }
    if (alive) paint();
  }
  function setMax() {
    if (!st.bal) return;
    const reserve = src().key === "ethereum" ? 2n * 10n ** 15n : 3n * 10n ** 14n; // leave gas on the source chain
    const raw = st.bal.raw > reserve ? st.bal.raw - reserve : 0n;
    amountInput.value = rawInput(raw, 18, 6);
    amountInput.dispatchEvent(new Event("input"));
  }

  const requote = debounce(async () => {
    const raw = toRaw(st.amount, 18);
    st.lq = null; st.lqErr = null;
    if (!raw || raw <= 0n || !wallet.address) { st.lqLoading = false; paint(); return; }
    const seq = ++st.lqSeq;
    st.lqLoading = true; paint();
    try {
      const q = isHl() ? await api.get(`bridge/hl-quote?${new URLSearchParams({ address: wallet.address, amountWei: raw.toString() })}`)
        : await api.get(`bridge/quote?${new URLSearchParams({ fromChain: String(src().id), toChain: String(dst().id), address: wallet.address, amountWei: raw.toString() })}`);
      if (seq !== st.lqSeq || !alive) return;
      st.lq = q;
    } catch (e) { if (seq === st.lqSeq) st.lqErr = e.message; }
    if (seq === st.lqSeq && alive) { st.lqLoading = false; paint(); }
  }, 500);

  async function act() {
    if (!wallet.address) { await openConnect(); refreshBal(); requote(); return; }
    const raw = toRaw(st.amount, 18);
    if (!raw || raw <= 0n || !st.lq) return;
    const amt = fromRaw(raw), q = st.lq, s = src(), d = dst();
    try {
      const ok = isHl() ? await review({ title: "Review funding", summary: `${tiny(amt)} ETH on ${s.name} → about ${tiny(fromRaw(q.toAmount, outDec(q)))} USDC on your Hyperliquid account`, confirmLabel: "Fund in wallet",
        rows: [["From", s.name], ["To", "Your Hyperliquid account, same address"], ["You send", `${tiny(amt)} ETH`], ["You receive (est.)", `${tiny(fromRaw(q.toAmount, outDec(q)))} USDC`], ["Minimum", `${tiny(fromRaw(q.toAmountMin, outDec(q)))} USDC`], ["Route", `${q.tool} via LI.FI`], ["Route fees", `$${num(q.feeUsd + q.gasUsd, 2)}`]],
        warn: "Sent through a third-party route: Troya cannot reverse it once it is sent. The USDC lands on Hyperliquid under this same address." })
        : await review({ title: "Review bridge", summary: `${tiny(amt)} ETH on ${s.name} → about ${tiny(fromRaw(q.toAmount))} ETH on ${d.name}`, confirmLabel: "Bridge in wallet",
        rows: [["From", s.name], ["To", `${d.name}, same address`], ["You send", `${tiny(amt)} ETH`], ["You receive (est.)", `${tiny(fromRaw(q.toAmount))} ETH`], ["Minimum", `${tiny(fromRaw(q.toAmountMin))} ETH`], ["Route", `${q.tool} via LI.FI`], ["Contract", short(q.tx.to)]],
        warn: "Bridging through a third-party route: Troya cannot reverse a transfer once it is sent." });
      if (!ok) return;
      st.busy = "Confirm in your wallet…"; paint();
      const hash = await sendTx(s.key, { to: q.tx.to, data: q.tx.data, value: q.tx.value, gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n });
      addTransfer({ kind: "lifi", hash, amount: amt, sym: "ETH", from: s.key, fromId: s.id, to: d.key, toId: d.id, at: Date.now(), status: "sent", address: wallet.address });
      journal({ kind: "bridge", direction: st.dir, chain: s.key, hash, amount: amt, route: q.tool, rationale: isHl() ? "Fund Hyperliquid from the Bridge page" : "Manual bridge from the Bridge page" });
      toast(isHl() ? "Funding sent. USDC usually reaches Hyperliquid within a minute." : "Bridge transaction sent.", "ok");
      st.amount = ""; amountInput.value = ""; st.lq = null;
      st.busy = false; paint(); renderList(); track(hash);
    } catch (e) {
      toast(errText(e), "error", 5000);
    } finally {
      st.busy = false;
      if (alive) { paint(); refreshBal(); }
    }
  }

  /* ---------- transfer tracking ---------- */
  const tracking = new Set();
  const nameOf = (key) => (key === "robinhood" ? HOME.name : key === HL.key ? HL.name : OTHER.find((c) => c.key === key)?.name || CHAINS[key]?.name || key);
  async function track(hash) {
    if (tracking.has(hash)) return;
    tracking.add(hash);
    const t = transfers.get().find((x) => x.hash === hash);
    if (!t || t.kind !== "lifi") { tracking.delete(hash); return; }
    try {
      if (t.status === "sent") {
        const rc = await waitReceipt(t.from, hash, { timeoutMs: 240_000 });
        if (!rc) { tracking.delete(hash); return; }
        updateTransfer(hash, { status: rc.status === 1 ? "confirmed" : "failed" });
        if (alive) renderList();
        if (rc.status !== 1) return;
      }
      for (let i = 0; i < 120 && alive; i++) {
        const s = await api.get(`bridge/status?${new URLSearchParams({ txHash: hash, fromChain: String(t.fromId), toChain: String(t.toId || HOME.id) })}`).catch(() => null);
        if (s?.status === "DONE") { updateTransfer(hash, { status: "done" }); toast(t.to === HL.key ? "Funded: USDC is on your Hyperliquid account. Open Perps to trade." : `Bridge complete: ETH is on ${nameOf(t.to)}`, "ok", 6000); break; }
        if (s?.status === "FAILED") { updateTransfer(hash, { status: "failed" }); break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
    } finally { tracking.delete(hash); if (alive) renderList(); }
  }

  /* ---------- sections ---------- */
  function renderAdd() {
    const c = CHAINS.robinhood;
    clear(addSec,
      h("div", { class: "br-head" }, h("h2", {}, "Add Robinhood Chain to your wallet"), infoTip("Lets your wallet show Robinhood Chain balances and sign its transactions.")),
      h("div", { class: "rows br-netrows" },
        h("div", {}, h("span", {}, "Network name"), h("span", {}, c.name)),
        h("div", {}, h("span", {}, "Chain ID"), h("span", {}, String(c.id))),
        h("div", {}, h("span", {}, "Currency"), h("span", {}, c.currency)),
        h("div", {}, h("span", {}, "RPC"), h("span", { class: "mono br-rpc" }, c.rpc, " ", h("button", { class: "icon-btn", type: "button", "aria-label": "Copy RPC", onclick: () => copyText(c.rpc, "RPC copied") }, icon("copy")))),
        h("div", {}, h("span", {}, "Explorer"), h("span", {}, h("a", { class: "link", href: c.explorer, target: "_blank", rel: "noopener" }, "robinhoodchain.blockscout.com")))),
      h("button", { class: "btn", type: "button", onclick: async () => { try { await addChain("robinhood"); toast("Robinhood Chain added to your wallet", "ok"); } catch (e) { toast(errText(e), "error"); } } }, icon("plus"), "Add Robinhood Chain to your wallet"));
  }
  function renderList() {
    const mine = transfers.get().filter((t) => t.kind === "lifi" && (!wallet.address || !t.address || t.address.toLowerCase() === wallet.address.toLowerCase()));
    const label = { sent: "Sent", confirmed: "Confirmed, arriving", done: "Arrived", failed: "Failed" };
    clear(listSec,
      h("div", { class: "br-head" }, h("h2", {}, "Your transfers")),
      !wallet.address && !mine.length ? h("p", { class: "muted" }, "Connect your wallet to see your transfers.")
        : !mine.length ? h("p", { class: "muted" }, "No transfers from this browser yet.")
        : h("div", { class: "br-list" }, mine.map((t) => h("div", { class: "br-item" },
          h("div", { class: "br-item-l" },
            h("b", {}, `${nameOf(t.from)} → ${nameOf(t.to || "robinhood")}`),
            h("span", { class: "muted" }, `${tiny(t.amount)} ${t.sym || "ETH"} · ${ago(t.at)} ago · `,
              h("button", { class: "link", type: "button", onclick: () => copyText(t.hash, "Hash copied") }, short(t.hash, 6)))),
          h("span", { class: `badge-s ${t.status === "done" ? "blue" : t.status === "failed" ? "down" : ""}` }, label[t.status] || t.status)))));
  }

  const off = onWallet(() => { refreshBal(); renderList(); paint(); requote(); });
  render();
  renderAdd();
  renderList();
  for (const t of transfers.get()) if (t.kind === "lifi" && ["sent", "confirmed"].includes(t.status) && Date.now() - t.at < 6 * 3600_000) track(t.hash);
  return () => { alive = false; off(); };
}
