// F19 · $TROYA flywheel in the app: the public numbers, and for the creator wallet the cycle itself.
//   1 Claim     the creator fees waiting in the Pons fee escrow
//   2 Buy back  ETH → $TROYA through Troya Gate (the burn share and the $TROYA half of the liquidity)
//   3 Burn      the burn share, with the token's own burn(): the total supply goes down
//   4 Lock      ETH + $TROYA as a full-range Uniswap v4 position in the Pons pool, minted straight to 0x…dEaD
// Each step is signed in the creator wallet, then sent to /api/flywheel/record, which checks it on chain and logs it.
import { Interface, AbiCoder, parseEther } from "ethers";
import { h, clear, useCss, toast, tiny, usd, pageHead, seg, review, short } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect } from "/agent/js/wallet.js";
import { sendTx, waitReceipt, errText } from "/agent/js/chain.js";

const coder = AbiCoder.defaultAbiCoder();
const ESC = new Interface(["function claim() returns (uint256)"]);
const TOK = new Interface(["function burn(uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const P2 = new Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration)", "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const POS = new Interface(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
const DEAD = "0x000000000000000000000000000000000000dEaD";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RESERVE = 0.0002;                                  // ETH kept in the creator wallet for gas (a cycle's 4-5 txs cost ~0.00005 on Robinhood Chain)
const KEY = "troya.flywheel.cycle";
const lc = (s) => String(s || "").toLowerCase();
const fx = (n) => (n == null || !isFinite(n) ? "–" : tiny(n));
const big = (x) => (x == null ? "–" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : tiny(x));
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
const save = (c) => { try { c ? localStorage.setItem(KEY, JSON.stringify(c)) : localStorage.removeItem(KEY); } catch {} };
const raw18 = (x) => parseEther(Number(x).toFixed(18));

// full-range liquidity for these amounts at this price (BigInt; 1% under, so the amounts always cover it)
function fullRangeL(sqrtPX96, ts, eth, troya) {
  const Q = 2n ** 96n, lo = Math.ceil(-887272 / ts) * ts, hi = Math.floor(887272 / ts) * ts;
  const sq = (t) => BigInt(Math.floor(Math.pow(1.0001, t / 2) * 2 ** 96));
  const a = sq(lo), b = sq(hi), p = BigInt(sqrtPX96);
  const L0 = eth * p * b / ((b - p) * Q), L1 = troya * Q / (p - a);
  return { L: (L0 < L1 ? L0 : L1) * 99n / 100n, lo, hi };
}

export async function mount(view) {
  useCss("perps"); useCss("swap");
  let alive = true;
  const st = { d: null, err: null, busy: null, ethIn: "", share: "50", cyc: load() };
  const top = h("div", { class: "fw-top" }), panel = h("div", { class: "panel sd-panel fw-panel" });
  clear(view, h("div", { class: "dk fw" },
    pageHead("$TROYA flywheel", "Creator fees buy $TROYA back, burn it and lock liquidity in the pool for good. Every cycle is signed by the creator wallet and read back from the chain."),
    top, panel,
    h("p", { class: "fine lt-legal" }, "Every number here comes from the chain: the Pons fee escrow, the $TROYA contract and the Uniswap v4 PositionManager. ", h("a", { class: "ulink", href: "/flywheel", target: "_blank", rel: "noopener" }, "Public page"), ". Not financial advice.")));

  async function refresh() {
    try { st.d = await api.get("flywheel"); st.err = null; } catch (e) { st.err = e.message; }
    if (alive) paint();
  }
  const isCreator = () => wallet.address && st.d && lc(wallet.address) === lc(st.d.creator);

  function paint() {
    const d = st.d;
    if (st.err && !d) { clear(top, h("div", { class: "alert error" }, st.err)); clear(panel); return; }
    if (!d) { clear(top, h("div", { class: "sk", style: { height: "120px" } })); clear(panel); return; }
    const e = d.price.ethUsd;
    const tile = (k, v, sub) => h("div", { class: "fw-tile" }, h("span", {}, k), h("b", {}, v), sub ? h("small", {}, sub) : null);
    clear(top, h("div", { class: "fw-tiles" },
      tile("Creator fees earned", `${fx(d.fees.earnedEth)} ETH`, e ? usd(d.fees.earnedEth * e) : null),
      tile("Waiting to claim", `${fx(d.fees.waitingEth)} ETH`, `${d.fees.claims} claims so far`),
      tile("$TROYA burned", big(d.burned.total), `${d.burned.pctOfMinted.toFixed(2)}% of the 1B minted`),
      tile("Liquidity locked", usd(d.locked.usd), `${d.locked.positions.length} position${d.locked.positions.length === 1 ? "" : "s"} at 0x…dEaD`),
      tile("Cycles", String(d.totals.cycles), d.totals.cycles ? `${big(d.totals.troyaBurned)} burned by cycles` : "none yet")));
    paintPanel();
  }

  /* ---------- the cycle (creator wallet only) ---------- */
  function plan() {
    const E = Number(st.ethIn), s = Number(st.share) / 100;
    if (!(E > 0)) return null;
    const burnEth = E * s, lockEth = E * (1 - s) / 2, buyEth = burnEth + lockEth;   // the other half of the lock is ETH
    const tpe = st.d.price.troyaPerEth;
    return { E, s, burnEth, lockEth, buyEth, estTroya: buyEth * tpe * 0.97 };
  }
  function paintPanel() {
    const d = st.d;
    if (!wallet.address) return clear(panel, h("h3", {}, "Run a cycle"), h("p", { class: "muted" }, `Only the $TROYA creator wallet (${short(d.creator)}) can sign a cycle. Anyone can follow it above and on the public page.`), h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet"));
    if (!isCreator()) return clear(panel, h("h3", {}, "Run a cycle"), h("p", { class: "muted" }, `The connected wallet ${short(wallet.address)} is not the $TROYA creator wallet. Cycles are signed only by ${short(d.creator)}.`));
    const c = st.cyc, p = c?.plan || plan(), done = c?.steps || {};
    const ethIn = h("input", { class: "input", inputmode: "decimal", placeholder: "ETH for this cycle", value: c ? String(c.plan.E) : st.ethIn, disabled: !!c, "aria-label": "ETH for this cycle" });
    ethIn.addEventListener("input", () => { st.ethIn = ethIn.value; paintPlan(); });
    const avail = Math.max(0, d.fees.creatorWalletEth - RESERVE);
    const shareSeg = seg([{ value: "100", label: "All to burn" }, { value: "70", label: "70 burn · 30 lock" }, { value: "50", label: "50 · 50" }, { value: "30", label: "30 burn · 70 lock" }], c ? String(Math.round(c.plan.s * 100)) : st.share, (v) => { if (!st.cyc) { st.share = v; paintPanel(); } }, "fw-share");
    const planBox = h("div", { class: "fw-plan" });
    function paintPlan() {
      const q = st.cyc?.plan || plan();
      clear(planBox, !q ? h("p", { class: "muted", style: { margin: 0 } }, "Enter the ETH this cycle uses.") : h("ul", { class: "fw-steps-plan" },
        h("li", {}, h("b", {}, "Buy back "), `${fx(q.buyEth)} ETH → about ${big(q.estTroya)} $TROYA, through Troya Gate`),
        h("li", {}, h("b", {}, "Burn "), q.s > 0 ? `the share bought with ${fx(q.burnEth)} ETH, with burn()` : "nothing (all to liquidity)"),
        h("li", {}, h("b", {}, "Lock "), q.lockEth > 0 ? `${fx(q.lockEth)} ETH + the $TROYA bought with ${fx(q.lockEth)} ETH, full range in the Pons pool, minted to 0x…dEaD` : "nothing (all to burn)")));
    }
    paintPlan();
    const stepRow = (n, label, sub, key, enabled, fn) => h("div", { class: `fw-step ${done[key] ? "done" : ""}` },
      h("span", { class: "fw-n" }, done[key] ? "✓" : String(n)), h("div", {}, h("b", {}, label), h("small", {}, done[key] ? h("a", { class: "ulink", href: `https://robinhoodchain.blockscout.com/tx/${done[key]}`, target: "_blank", rel: "noopener" }, `Signed ${short(done[key])}`) : sub)),
      done[key] ? null : h("button", { class: "btn sm blue", type: "button", disabled: !enabled || !!st.busy, onclick: fn }, label));
    const started = !!c;
    clear(panel,
      h("h3", {}, "Run a cycle"),
      h("p", { class: "fine", style: { margin: 0 } }, `Creator wallet ${short(d.creator)} · ${fx(d.fees.creatorWalletEth)} ETH in the wallet · ${fx(d.fees.waitingEth)} ETH waiting in the Pons escrow.`),
      stepRow(1, "Claim", d.fees.waitingEth > 0 ? `${fx(d.fees.waitingEth)} ETH from the Pons fee escrow (optional: the wallet already holds claimed fees)` : "Nothing waiting in the escrow right now", "claim", d.fees.waitingEth > 0, doClaim),
      h("div", { class: "fw-row" }, ethIn, h("button", { class: "link", type: "button", disabled: started, onclick: () => { st.ethIn = String(+avail.toFixed(6)); ethIn.value = st.ethIn; paintPlan(); } }, `Max ${fx(avail)}`)),
      shareSeg, planBox,
      stepRow(2, "Buy back", "ETH → $TROYA, Troya Gate first", "buyback", !!p && !done.buyback, doBuy),
      stepRow(3, "Burn", c?.burnAmt ? `${big(c.burnAmt)} $TROYA with burn()` : "after the buyback", "burn", !!done.buyback && !done.burn && c?.burnAmt > 0, doBurn),
      stepRow(4, "Lock liquidity", c?.lpTroya ? `${fx(c.plan.lockEth)} ETH + ${big(c.lpTroya)} $TROYA, minted to 0x…dEaD` : "after the buyback", "lock", !!done.buyback && !done.lock && c?.lpTroya > 0 && (done.burn || !(c?.burnAmt > 0)), doLock),
      started ? h("div", { class: "fw-row" }, h("span", { class: "fine" }, `Cycle ${c.id} · started ${new Date(c.startedAt).toLocaleString()}`),
        h("button", { class: "link", type: "button", onclick: async () => { if (await review({ title: "Close this cycle?", summary: "Signed steps stay on chain and on the public page. Steps not signed yet are dropped.", confirmLabel: "Close it" })) { st.cyc = null; save(null); paintPanel(); } } }, c && Object.keys(done).length >= 3 ? "Finish" : "Close")) : null,
      st.busy ? h("p", { class: "fine" }, st.busy) : null);
  }

  /* ---------- steps ---------- */
  const step = async (label, tx) => {
    st.busy = label; paintPanel();
    const hash = await sendTx("robinhood", tx);
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
    if (rc?.status !== 1) throw new Error(`${label.replace(/…$/, "")} failed on chain.`);
    return { hash, rc };
  };
  const ensureCycle = () => {
    if (st.cyc) return st.cyc;
    const q = plan();
    if (!q) throw new Error("Enter the ETH for this cycle first.");
    st.cyc = { id: `c${Date.now()}`, startedAt: Date.now(), plan: q, steps: {} };
    save(st.cyc);
    return st.cyc;
  };
  async function record(c, stepName, hash) {
    c.steps[stepName] = hash; save(c);
    for (let i = 0; i < 3; i++) {
      try { return await api.post("flywheel/record", { cycle: c.id, step: stepName, hash }); }
      catch (e) { if (i === 2) { toast(`Signed, but the log could not be written yet (${e.message}). It is on chain; refresh later.`, "error", 8000); return null; } await new Promise((r) => setTimeout(r, 3000)); }
    }
  }
  // one step at a time: a double click must not start the same transaction twice
  const run = async (fn) => { if (st.busy) return; st.busy = "Working…"; paintPanel(); try { await fn(); } catch (e) { toast(errText(e), "error", 8000); } st.busy = null; await refresh(); };

  const doClaim = () => run(async () => {
    const c = st.cyc || (plan() ? ensureCycle() : { id: `c${Date.now()}`, startedAt: Date.now(), plan: null, steps: {} });
    const { hash } = await step("Claiming the creator fees…", { to: st.d.escrow, data: ESC.encodeFunctionData("claim"), value: "0" });
    if (c.plan) await record(c, "claim", hash); else await api.post("flywheel/record", { cycle: c.id, step: "claim", hash }).catch(() => {});
    toast("Creator fees claimed into the creator wallet.", "ok");
  });
  const doBuy = () => run(async () => {
    const q = st.cyc?.plan || plan();
    if (!q) throw new Error("Enter the ETH for this cycle first.");
    if (q.E > st.d.fees.creatorWalletEth - RESERVE) throw new Error(`The creator wallet holds ${fx(st.d.fees.creatorWalletEth)} ETH; keep ${RESERVE} ETH for gas.`);
    const amt = +q.buyEth.toFixed(8);
    const gate = await api.get(`swap/gate?in=eth&out=${st.d.token}&amount=${amt}`).catch((e) => ({ error: e.message }));
    if (gate.error || gate.pass === false) throw new Error(`Troya Gate stopped the buyback: ${gate.error || (gate.checks || []).filter((x) => x.status === "fail").map((x) => x.detail || x.name).join("; ")}`);
    const ok = await review({ title: "Flywheel · buy back", summary: `${fx(amt)} ETH → $TROYA`, rows: [["Burn share", `${Math.round(q.s * 100)}%`], ["Then", q.s > 0 && q.lockEth > 0 ? "burn, then lock liquidity" : q.s > 0 ? "burn" : "lock liquidity"], ["Signer", `${short(wallet.address)} (creator wallet)`]], confirmLabel: "Continue in wallet" });
    if (!ok) return;
    const c = ensureCycle();
    const built = await api.post("swap/build", { from: wallet.address, tokenIn: "ETH", tokenOut: st.d.token, amountIn: String(amt), slippageBps: 300 });
    const { hash, rc } = await step("Buying $TROYA back…", built);
    const r = await record(c, "buyback", hash);
    // what arrived, from the receipt when the log could not be written
    const inLogs = (rc.logs || []).filter((l) => lc(l.address) === lc(st.d.token) && l.topics[0] === TRANSFER && lc(`0x${l.topics[2].slice(26)}`) === lc(wallet.address)).reduce((s, l) => s + BigInt(l.data), 0n);
    const got = r?.troyaOut || (inLogs > 0n ? Number(inLogs) / 1e18 : null);
    if (got) { c.troyaOut = got; c.burnAmt = got * (q.burnEth / q.buyEth); c.lpTroya = got - c.burnAmt; save(c); }
    toast(`Bought back ${got ? big(got) + " $TROYA" : "$TROYA"}.`, "ok", 6000);
  });
  const doBurn = () => run(async () => {
    const c = st.cyc;
    const amt = raw18(c.burnAmt * 0.999999);
    const { hash } = await step("Burning $TROYA…", { to: st.d.token, data: TOK.encodeFunctionData("burn", [amt]), value: "0" });
    await record(c, "burn", hash);
    toast(`${big(c.burnAmt)} $TROYA burned. The supply went down.`, "ok", 6000);
  });
  const doLock = () => run(async () => {
    const c = st.cyc, d = st.d, k = d.pool.key;
    const { reader } = await import("/agent/js/wallet.js");
    const rd = reader("robinhood");
    const balRaw = BigInt(await rd.call({ to: d.token, data: TOK.encodeFunctionData("balanceOf", [wallet.address]) }));
    let troya = raw18(c.lpTroya * 0.999999);
    if (troya > balRaw) troya = balRaw;
    const ethWei = raw18(c.plan.lockEth);
    // Permit2: the token to Permit2 once, then Permit2 to the PositionManager for this amount (30 minutes)
    const a1 = BigInt(await rd.call({ to: d.token, data: TOK.encodeFunctionData("allowance", [wallet.address, d.permit2]) }));
    if (a1 < troya) await step("Approve $TROYA for Permit2…", { to: d.token, data: TOK.encodeFunctionData("approve", [d.permit2, troya]), value: "0" });
    const a2 = P2.decodeFunctionResult("allowance", await rd.call({ to: d.permit2, data: P2.encodeFunctionData("allowance", [wallet.address, d.token, d.positionManager]) }));
    if (BigInt(a2.amount) < troya || Number(a2.expiration) < Date.now() / 1000 + 120) await step("Allow the PositionManager through Permit2…", { to: d.permit2, data: P2.encodeFunctionData("approve", [d.token, d.positionManager, troya, Math.floor(Date.now() / 1000) + 1800]), value: "0" });
    const fresh = await api.get("flywheel");
    const { L, lo, hi } = fullRangeL(fresh.pool.sqrtPriceX96, k.ts, ethWei, troya);
    if (L <= 0n) throw new Error("These amounts are too small for a position.");
    const keyT = [k.c0, k.c1, k.fee, k.ts, k.hooks];
    const params = [
      coder.encode(["tuple(address,address,uint24,int24,address)", "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [keyT, lo, hi, L, ethWei, troya, DEAD, "0x"]),
      coder.encode(["address", "address"], [k.c0, k.c1]),
      coder.encode(["address", "address"], [k.c0, wallet.address]),
    ];
    const unlock = coder.encode(["bytes", "bytes[]"], ["0x020d14", params]);   // MINT_POSITION, SETTLE_PAIR, SWEEP (unused ETH back)
    const data = POS.encodeFunctionData("modifyLiquidities", [unlock, BigInt(Math.floor(Date.now() / 1000) + 1200)]);
    // simulate first: a revert here costs nothing
    try { await rd.call({ from: wallet.address, to: d.positionManager, data, value: ethWei }); }
    catch (e) { throw new Error(`The lock would fail: ${errText(e)}`); }
    const ok = await review({ title: "Flywheel · lock liquidity", summary: `${fx(c.plan.lockEth)} ETH + ${big(Number(troya) / 1e18)} $TROYA, full range in the Pons pool`, rows: [["Position NFT to", "0x…dEaD (nobody can remove it)"], ["Contract", `Uniswap v4 PositionManager ${short(d.positionManager)}`], ["Unused ETH", "comes back in the same transaction"]], confirmLabel: "Continue in wallet", danger: true });
    if (!ok) return;
    const { hash } = await step("Locking liquidity…", { to: d.positionManager, data, value: ethWei.toString() });
    const r = await record(c, "lock", hash);
    toast(`Liquidity locked${r?.tokenId ? ` as position #${r.tokenId}` : ""}, owned by 0x…dEaD.`, "ok", 7000);
  });

  /* ---------- automatic mode (admins): the server runs each cycle with the creator key ---------- */
  const autoBox = h("section", { class: "panel fw-auto", hidden: true });
  view.querySelector(".fw")?.append(autoBox) || view.append(autoBox);
  async function paintAuto() {
    if (!wallet.session) { autoBox.hidden = true; return; }
    let a; try { a = await api.get("flywheel/auto"); } catch { autoBox.hidden = true; return; }
    autoBox.hidden = false;
    const s = a.settings;
    const num = (k, v, step, label, suffix) => { const el = h("input", { class: "input", type: "number", step, value: v, "aria-label": label }); el.dataset.k = k; return h("label", { class: "field" }, h("span", {}, label, suffix ? h("i", {}, ` ${suffix}`) : null), el); };
    const fields = h("div", { class: "fw-auto-g" },
      num("flywheelPct", s.flywheelPct, "1", "Flywheel share of each claim", "% (the rest stays in the creator wallet: yours)"),
      num("burnPct", s.burnPct, "1", "Of the flywheel share, burn", "% (the rest is locked)"),
      num("minEth", s.minEth, "0.001", "Claim when fees reach", "ETH"),
      num("maxEth", s.maxEth, "0.01", "Flywheel spends at most", "ETH per cycle"),
      num("everyHours", s.everyHours, "1", "At most one cycle every", "hours"));
    const ex = 0.05, fw = ex * s.flywheelPct / 100;
    const exampleEl = h("p", { class: "fine fw-auto-ex" }, `Example: ${ex} ETH of fees → ${(ex - fw).toFixed(4)} ETH stays yours, ${fw.toFixed(4)} ETH to the flywheel (${(fw * s.burnPct / 100).toFixed(4)} burn, ${(fw * (100 - s.burnPct) / 100).toFixed(4)} lock). The flywheel only uses fees it just claimed, never the rest of the wallet.`);
    const save = async (extra = {}) => {
      const body = { ...extra }; for (const el of fields.querySelectorAll("input")) body[el.dataset.k] = Number(el.value);
      try { await api.post("flywheel/auto/settings", body); toast("Saved", "ok"); paintAuto(); } catch (e) { toast(e.message, "error", 7000); }
    };
    const pk = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Creator wallet private key (0x…, 64 hex)", "aria-label": "Creator wallet private key" });
    clear(autoBox,
      h("div", { class: "fw-auto-h" }, h("h3", {}, "Automatic mode"), h("span", { class: `dk-v ${s.enabled && a.keySet ? "v-passed" : ""}` }, s.enabled && a.keySet ? "On" : "Off")),
      h("p", { class: "fine", style: { margin: 0 } }, `The server claims the creator fees, keeps your share in the creator wallet, buys $TROYA back with the flywheel share through Troya Gate, burns the burn part and locks the rest to 0x…dEaD, by itself. It signs only those calls, keeps ${s.reserveEth} ETH for gas and spends at most the limit per cycle. Each cycle is reported to your Telegram chat linked for reports; /flywheel off there stops it.`),
      a.keySet
        ? h("div", { class: "fw-auto-key ok" }, h("b", {}, "Creator key stored, encrypted."), h("span", { class: "fine" }, `Signs as ${short(a.creator)}.`), h("button", { class: "btn sm danger", type: "button", onclick: async () => { if (!(await review({ title: "Delete the stored key?", summary: "Automatic mode stops. You can import it again later.", confirmLabel: "Delete key", danger: true }))) return; try { await api.post("flywheel/auto/forget", {}); toast("Key deleted", "ok"); paintAuto(); } catch (e) { toast(e.message, "error"); } } }, "Delete key"))
        : h("div", { class: "fw-auto-key" },
            h("div", { class: "alert warn" }, h("b", {}, "Read this first. "), "The server will hold the creator wallet's key (encrypted). Move everything you do not want the flywheel to use out of the creator wallet first, so it holds only the fees. Type the key yourself here; never send it to anyone, Troya included."),
            h("div", { class: "fw-row" }, pk, h("button", { class: "btn primary", type: "button", onclick: async () => {
              const v = pk.value.trim(); pk.value = "";
              if (!v) return toast("Paste the creator wallet's private key.", "");
              try { const r = await api.post("flywheel/auto/key", { privateKey: v }); toast(`Key stored for ${short(r.address)}.`, "ok", 6000); paintAuto(); } catch (e) { toast(e.message, "error", 8000); }
            } }, "Store the key"))),
      fields, exampleEl,
      h("div", { class: "fw-row" },
        h("button", { class: "btn primary", type: "button", disabled: !a.keySet, onclick: () => save({ enabled: !(s.enabled && a.keySet) }) }, s.enabled && a.keySet ? "Switch off" : "Switch on"),
        h("button", { class: "btn", type: "button", onclick: () => save() }, "Save limits"),
        h("button", { class: "btn", type: "button", disabled: !a.keySet || a.running, onclick: async () => {
          if (!(await review({ title: "Run a cycle now?", summary: "Claim, buy back through the Gate, burn and lock, with the limits above.", confirmLabel: "Run now" }))) return;
          toast("Running… this takes a minute or two.", "", 6000);
          try { const r = await api.post("flywheel/auto/run", {}); toast(r.error ? `Stopped: ${r.error}` : r.note || r.skipped || "Cycle done.", r.error ? "error" : "ok", 9000); } catch (e) { toast(e.message, "error", 8000); }
          paintAuto(); refresh();
        } }, a.running ? "Running…" : "Run a cycle now")),
      a.runs?.length ? h("ul", { class: "fw-auto-log" }, a.runs.map((x) => h("li", {}, h("b", {}, new Date(x.at).toLocaleString()), " · ", x.reason, " · ",
        x.error ? h("span", { class: "down" }, x.error) : x.note ? h("span", { class: "muted" }, x.note) : h("span", {}, x.steps.map((st2) => h("a", { class: "ulink", href: `https://robinhoodchain.blockscout.com/tx/${st2.hash}`, target: "_blank", rel: "noopener" }, st2.step)).reduce((acc, el, i) => (i ? [...acc, " · ", el] : [el]), []))))) : null);
  }
  paintAuto();

  const off = onWallet(() => { paint(); paintAuto(); });
  await refresh();
  const t = setInterval(() => { if (!document.hidden && !st.busy) refresh(); }, 60_000);
  return () => { alive = false; off(); clearInterval(t); };
}
