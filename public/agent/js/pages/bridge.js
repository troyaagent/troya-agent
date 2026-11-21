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
// A stand-in sender for quotes before a wallet is connected (LI.FI quotes the burn address like any wallet, in about a
// second). A quote made for it is a preview only: it delivers to the stand-in, so it is never signed; Review always
// fetches the route again for the connected wallet.
const PREVIEW_FROM = "0x000000000000000000000000000000000000dEaD";
const QUOTE_EVERY = 25_000;      // a quote on screen is fetched again this often while the page is visible
const QUOTE_MAX_AGE = 30_000;    // a route older than this is fetched again before its review opens
const REVIEW_MAX_AGE = 120_000;  // a route whose review stayed open longer is fetched and shown once more before signing

export async function mount(view, ctx) {
  useCss("bridge");
  let alive = true;
  const st = {
    dir: ["out", "hl"].includes(ctx.query.dir) ? ctx.query.dir : "in", other: OTHER.find((c) => c.key === ctx.query.chain) || OTHER[0],
    amount: ctx.query.amount && /^\d*\.?\d+$/.test(ctx.query.amount) ? ctx.query.amount : "", bal: null, busy: false, lq: null, lqErr: null, lqLoading: false, lqSeq: 0,
    // lqAt: when the route was quoted · lqFor: the address it was quoted for (PREVIEW_FROM before a wallet connects) ·
    // lqKey: direction, chains and amount it answers · refreshing: the 25 s refresh of a route already on screen
    lqAt: 0, lqFor: "", lqKey: "", refreshing: false,
  };
  const src = () => (st.dir === "in" ? st.other : HOME);
  const dst = () => (st.dir === "in" ? HOME : st.dir === "hl" ? HL : st.other);
  const isHl = () => st.dir === "hl";
  const outSym = () => (isHl() ? "USDC" : "ETH");
  const outDec = (q) => Number(q?.toDecimals ?? 18);
  const arrives = (sec) => (sec ? `~${sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`}` : "Usually a few minutes");
  const keyOf = (raw) => `${st.dir}:${src().id}:${dst().id}:${raw}`;
  const me = () => String(wallet.address || "").toLowerCase();
  const isPreview = () => !!st.lq && st.lqFor !== me();
  // the route on screen no longer answers: a new amount, direction or chain (anything on its way is for the old one)
  function invalidate() { st.lqSeq++; st.lq = null; st.lqErr = null; st.refreshing = false; st.lqLoading = !!toRaw(st.amount, 18); }

  const box = h("div", { class: "br-box" });
  const addSec = h("section", { class: "br-section" });
  const listSec = h("section", { class: "br-section" });
  // the same frame as the other Trade desks, so the header sits at the same height on every page
  clear(view, h("div", { class: "dk br" },
    pageHead("Bridge", "Move ETH onto Robinhood Chain from Arbitrum, Base or Ethereum, take it back out, or fund your Hyperliquid account with USDC for perps. Routes come from LI.FI and usually land in minutes."),
    h("div", { class: "br-wrap" }, box, addSec, listSec)));

  const amountInput = h("input", { class: "br-amt", inputmode: "decimal", placeholder: "0", autocomplete: "off", "aria-label": "Amount", value: st.amount });
  amountInput.addEventListener("input", () => {
    const v = amountInput.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    if (v !== amountInput.value) amountInput.value = v;
    st.amount = v;
    invalidate();
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
  const previewBox = h("p", { class: "br-preview", hidden: true }, icon("info"), "Preview, connect to get your exact route");
  const freshBox = h("p", { class: "br-fresh", hidden: true });

  function render() {
    // every direction wears a mark; phones get the short label so the three fit one row
    const lbl = (mark, long, shortTxt) => h("span", { class: "seg-ico br-dir" }, mark, h("span", { class: "br-dl" }, long), h("span", { class: "br-ds" }, shortTxt));
    const outMark = h("span", { class: "br-out-ico" }, icon("ext"));
    const dirSeg = seg([{ value: "in", label: lbl(chainLogo("robinhood", 14), "Into Robinhood Chain", "Into Robinhood") }, { value: "out", label: lbl(outMark, "Out of Robinhood Chain", "Out") }, { value: "hl", label: lbl(chainLogo("hyperliquid", 14), "To Hyperliquid", "To Hyperliquid") }], st.dir,
      (v) => { st.dir = v; invalidate(); render(); refreshBal(); requote(); });
    dirSeg.classList.add("br-dirs");
    const otherSeg = seg(OTHER.map((c) => ({ value: c.id, label: h("span", { class: "seg-ico" }, chainLogo(c.key, 14), c.name) })), st.other.id,
      (v) => { st.other = OTHER.find((c) => c.id === v); invalidate(); render(); refreshBal(); requote(); });
    const s = src(), d = dst();
    clear(box,
      h("div", { class: "br-ctrls" }, dirSeg),
      isHl() ? h("p", { class: "muted br-hlnote" }, "ETH on Robinhood Chain becomes USDC on your own Hyperliquid account, ready as margin for perps. Then trade on Perps, or approve your Agent Wallet once and let it trade.")
        : h("div", { class: "br-ctrls" }, h("span", { class: "muted" }, st.dir === "in" ? "From" : "To"), otherSeg),
      h("div", { class: "br-card panel" },
        h("div", { class: "br-leg" },
          h("div", { class: "br-leg-top" }, h("span", { class: "row" }, "From ", chainLogo(s.key, 16), h("b", {}, s.name)), balLine),
          h("div", { class: "br-leg-main" }, amountInput, h("span", { class: "br-sym" }, tokenIcon({ symbol: "ETH", chain: s.key }, "xs"), "ETH"))),
        h("div", { class: "br-quick" }, ["0.01", "0.05", "0.1", "0.5"].map((v) => h("button", { type: "button", class: "chip", onclick: () => { amountInput.value = v; amountInput.dispatchEvent(new Event("input")); } }, `${v} ETH`)),
          h("button", { type: "button", class: "chip", title: "Everything but a little ETH kept for gas on the source chain", onclick: () => setMax() }, "Max")),
        h("div", { class: "br-leg" },
          h("div", { class: "br-leg-top" }, h("span", { class: "row" }, "To ", chainLogo(d.key, 16), h("b", {}, d.name)), h("span", { class: "muted" }, isHl() ? "Your Hyperliquid account" : "Same wallet")),
          h("div", { class: "br-leg-main" }, recvOut, h("span", { class: "br-sym" }, tokenIcon({ symbol: outSym(), chain: d.key === "hl" ? "hyperliquid" : d.key }, "xs"), outSym()))),
        previewBox, rowsBox, freshBox, warnBox, noteBox, btn, statusBox));
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
      h("div", {}, h("span", {}, "Arrives"), h("span", {}, arrives(q.executionSec))),
      h("div", {}, h("span", {}, "Route fees"), h("span", {}, `$${num(q.feeUsd + q.gasUsd, 2)}`)),
    ] : []);
    rowsBox.hidden = !q;
    previewBox.hidden = !isPreview();
    if (st.lqErr) warnBox.append(h("div", { class: "alert error" }, st.lqErr));
    clear(noteBox, isHl() ? `One transaction on ${s.name}. LI.FI swaps your ETH to USDC and delivers it to your own Hyperliquid account (same address); route fees are in the quote. Troya adds no fee.`
      : `One transaction on ${s.name}. A bridge or relayer found by LI.FI delivers ETH to the same address on ${dst().name}; its fee is included in the quote. Troya adds no fee.`);
    // the wallet is asked for at Review: before that the route is a preview quoted for a stand-in address
    let label, disabled = false;
    if (!raw || raw <= 0n) { if (wallet.address) { label = "Enter an amount"; disabled = true; } else label = isHl() ? "Connect wallet to fund Hyperliquid" : "Connect wallet to bridge"; }
    else if (wallet.address && st.bal && raw > st.bal.raw) { label = `Not enough ETH on ${s.name}`; disabled = true; }
    else if (!st.lq) { label = st.lqLoading ? "Finding a route…" : st.lqErr ? "No route" : "Finding a route…"; disabled = true; }
    else if (!wallet.address) label = isHl() ? "Connect and review funding" : "Connect and review bridge";
    else label = isHl() ? "Review funding" : "Review bridge";
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
    paintFresh();
  }
  // "Quote refreshes in Ns" under the rows, while a route is on screen
  function paintFresh() {
    const on = !!st.lq && !!toRaw(st.amount, 18) && !st.busy;
    const t = !on ? "" : st.refreshing ? "Refreshing the quote…" : `Quote refreshes in ${Math.max(0, Math.ceil((st.lqAt + QUOTE_EVERY - Date.now()) / 1000))}s`;
    if (freshBox.textContent !== t) freshBox.textContent = t;
    freshBox.hidden = !t;
  }

  async function refreshBal() {
    st.bal = null;
    if (!wallet.address) { paint(); return; }
    paint();
    const a = me(), k = src().key;
    let b = null;
    try { b = await balanceOf(wallet.address, undefined, k); } catch { b = null; }
    if (a === me() && k === src().key) st.bal = b;   // a balance read for another wallet or chain is dropped
    if (alive) paint();
  }
  function setMax() {
    if (!st.bal) return;
    const reserve = src().key === "ethereum" ? 2n * 10n ** 15n : 3n * 10n ** 14n; // leave gas on the source chain
    const raw = st.bal.raw > reserve ? st.bal.raw - reserve : 0n;
    amountInput.value = rawInput(raw, 18, 6);
    amountInput.dispatchEvent(new Event("input"));
  }

  const quoteFor = (from, raw) => isHl() ? api.get(`bridge/hl-quote?${new URLSearchParams({ address: from, amountWei: raw.toString() })}`)
    : api.get(`bridge/quote?${new URLSearchParams({ fromChain: String(src().id), toChain: String(dst().id), address: from, amountWei: raw.toString() })}`);
  // Without a wallet the route is quoted for a stand-in address, so the amount, fees and time show before connecting.
  // quiet: the 25 s refresh of a route already on screen (it stays visible while the new one loads; one miss falls
  // back to a normal quote, which shows a real error)
  async function fetchQuote(quiet = false) {
    if (st.busy) return;   // Review is fetching the exact route itself
    const raw = toRaw(st.amount, 18);
    if (!quiet) { st.lq = null; st.lqErr = null; }
    if (!raw || raw <= 0n) { st.lqLoading = false; st.refreshing = false; paint(); return; }
    const seq = ++st.lqSeq, from = wallet.address || PREVIEW_FROM, key = keyOf(raw);
    st.refreshing = quiet;
    if (!quiet) st.lqLoading = true;
    paint();
    try {
      const q = await quoteFor(from, raw);
      if (seq !== st.lqSeq || !alive) return;
      Object.assign(st, { lq: q, lqAt: Date.now(), lqFor: from.toLowerCase(), lqKey: key, lqErr: null });
    } catch (e) {
      if (seq !== st.lqSeq || !alive) return;
      // (called straight away: the 500 ms ticker would keep pushing a debounced call back)
      if (quiet) { st.refreshing = false; fetchQuote(false); return; }
      st.lqErr = e.message;
    }
    st.lqLoading = false; st.refreshing = false; paint();
  }
  const requote = debounce(() => fetchQuote(false), 500);
  // every 25 s while the page is visible and a route is on screen; never during a review or a send
  const freshTick = setInterval(() => {
    if (!alive) return;
    if (st.lq && toRaw(st.amount, 18) && !st.busy && !st.lqLoading && !st.refreshing && document.visibilityState !== "hidden" && Date.now() - st.lqAt >= QUOTE_EVERY) fetchQuote(true);
    paintFresh();
  }, 500);

  async function act() {
    if (st.busy) return;
    if (!wallet.address) {
      // the wallet is asked for here, at Review: with one connected, the review below opens on its exact route
      await openConnect();
      if (!alive || !wallet.address) return;
      if (!toRaw(st.amount, 18) || !st.lq) { refreshBal(); requote(); return; }
    }
    const raw = toRaw(st.amount, 18);
    if (!raw || raw <= 0n || !st.lq) return;
    const amt = fromRaw(raw), s = src(), d = dst(), who = me();
    try {
      if (!st.bal) { st.busy = "Reading your balance…"; paint(); await refreshBal(); }
      if (!alive) return;
      if (st.bal && raw > st.bal.raw) { toast(`Not enough ETH on ${s.name} for this amount.`, "error", 5000); return; }
      let q = null;
      for (let round = 0; ; round++) {
        // the exact route for this wallet: a preview (quoted for the stand-in address), a route for another amount or
        // direction, or one older than 30 s is fetched again before the review opens
        if (!q && (!st.lq || st.lqFor !== who || st.lqKey !== keyOf(raw) || Date.now() - st.lqAt > QUOTE_MAX_AGE)) {
          st.busy = st.lqFor !== who ? "Finding your exact route…" : "Refreshing the route…"; paint();
          st.lqSeq++;   // a quote already on its way answers for the old route
          const q2 = await quoteFor(wallet.address, raw);
          if (!alive) return;
          Object.assign(st, { lq: q2, lqAt: Date.now(), lqFor: who, lqKey: keyOf(raw), lqErr: null, lqLoading: false, refreshing: false });
        }
        q = q || st.lq;
        // only a route quoted for this wallet, this amount and this direction is ever signed
        if (st.lqFor !== who || me() !== who || st.lqKey !== keyOf(raw) || !q?.tx?.to || (q.toAddress && String(q.toAddress).toLowerCase() !== who)) throw new Error("That route was not quoted for your wallet. Nothing was sent. Try again.");
        const fees = `$${num(q.feeUsd + q.gasUsd, 2)}`, eta = arrives(q.executionSec);
        st.busy = "Waiting for your review…"; paint();
        const ok = isHl() ? await review({ title: "Review funding", summary: `${tiny(amt)} ETH on ${s.name} → about ${tiny(fromRaw(q.toAmount, outDec(q)))} USDC on your Hyperliquid account`, confirmLabel: "Fund in wallet",
          rows: [["From", s.name], ["To", "Your Hyperliquid account, same address"], ["You send", `${tiny(amt)} ETH`], ["You receive (est.)", `${tiny(fromRaw(q.toAmount, outDec(q)))} USDC`], ["Minimum", `${tiny(fromRaw(q.toAmountMin, outDec(q)))} USDC`], ["Route", `${q.tool} via LI.FI`], ["Arrives", eta], ["Route fees", fees], ["Recipient", `${short(wallet.address)} (you)`]],
          warn: "Sent through a third-party route: Troya cannot reverse it once it is sent. The USDC lands on Hyperliquid under this same address." })
          : await review({ title: "Review bridge", summary: `${tiny(amt)} ETH on ${s.name} → about ${tiny(fromRaw(q.toAmount))} ETH on ${d.name}`, confirmLabel: "Bridge in wallet",
          rows: [["From", s.name], ["To", `${d.name}, same address`], ["You send", `${tiny(amt)} ETH`], ["You receive (est.)", `${tiny(fromRaw(q.toAmount))} ETH`], ["Minimum", `${tiny(fromRaw(q.toAmountMin))} ETH`], ["Route", `${q.tool} via LI.FI`], ["Arrives", eta], ["Route fees", fees], ["Recipient", `${short(wallet.address)} (you)`], ["Contract", short(q.tx.to)]],
          warn: "Bridging through a third-party route: Troya cannot reverse a transfer once it is sent." });
        if (!ok || !alive) return;
        // a review left open for two minutes: the route is fetched again and the review shows once more
        if (Date.now() - st.lqAt <= REVIEW_MAX_AGE && st.lq === q) break;
        if (round >= 2) throw new Error("The route kept changing while the review was open. Nothing was sent. Try again.");
        q = null; st.lqAt = 0;
        toast("The review stayed open a while, so the route was fetched again. Check it once more.", "", 5000);
      }
      st.busy = "Confirm in your wallet…"; paint();
      const hash = await sendTx(s.key, { to: q.tx.to, data: q.tx.data, value: q.tx.value, gasLimit: (BigInt(q.tx.gasLimit) * 13n) / 10n });
      addTransfer({ kind: "lifi", hash, amount: amt, sym: "ETH", from: s.key, fromId: s.id, to: d.key, toId: d.id, at: Date.now(), status: "sent", address: wallet.address });
      journal({ kind: "bridge", direction: st.dir, chain: s.key, hash, amount: amt, route: q.tool, rationale: isHl() ? "Fund Hyperliquid from the Bridge page" : "Manual bridge from the Bridge page" });
      toast(isHl() ? "Funding sent. USDC usually reaches Hyperliquid within a minute." : "Bridge transaction sent.", "ok");
      st.amount = ""; amountInput.value = ""; invalidate();
      st.busy = false; paint(); renderList(); track(hash);
    } catch (e) {
      toast(errText(e), "error", 5000);
    } finally {
      st.busy = false;
      if (alive) {
        paint(); refreshBal();
        // the amount changed while busy, or the exact route could not be fetched: quote again for what is on screen now
        if ((!st.lq || isPreview()) && toRaw(st.amount, 18)) requote();
      }
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
      h("div", { class: "br-head" }, h("h2", {}, "Add Robinhood Chain to your wallet"), infoTip("Lets your wallet show Robinhood Chain balances and sign its transactions.", "Add the network")),
      h("div", { class: "rows br-netrows" },
        h("div", {}, h("span", {}, "Network name"), h("span", {}, c.name)),
        h("div", {}, h("span", {}, "Chain ID"), h("span", {}, String(c.id))),
        h("div", {}, h("span", {}, "Currency"), h("span", {}, c.currency)),
        h("div", {}, h("span", {}, "RPC"), h("span", { class: "mono br-rpc" }, h("span", { class: "br-rpc-v", title: c.rpc }, c.rpc), h("button", { class: "icon-btn", type: "button", "aria-label": "Copy RPC", onclick: () => copyText(c.rpc, "RPC copied") }, icon("copy")))),
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

  // a new wallet (or none) gets its own route: a preview becomes the exact route once a wallet connects
  const off = onWallet(() => { refreshBal(); renderList(); paint(); if (!st.busy && (st.lqFor !== String(wallet.address || PREVIEW_FROM).toLowerCase() || !st.lq)) requote(); });
  render();
  renderAdd();
  renderList();
  for (const t of transfers.get()) if (t.kind === "lifi" && ["sent", "confirmed"].includes(t.status) && Date.now() - t.at < 6 * 3600_000) track(t.hash);
  return () => { alive = false; off(); clearInterval(freshTick); };
}
