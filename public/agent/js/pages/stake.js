// Stake $TROYA (#/stake): stake, unstake with a 3-day cooldown, withdraw; your tier (Bronze, Silver, Gold) from the size and
// the age of your stake, the next tier's progress, each tier's perks and the risks in plain words.
// Your own numbers are read straight from the chain through Troya's relay (fresh after every step); the terms, tiers and
// totals come from /api/stake. Every write is signed in your own wallet. The contract has no owner and takes no fee.
// The daily creator-fee share (server/feesplit.mjs, owner 21 Nov 2026) is shown from /api/feesplit: a share of $TROYA creator
// fees that grows with market cap (0.1% to 0.5% at $35k to 1% at $100k of trading volume), varies with volume, not a promised yield.
import { Interface } from "ethers";
import { h, clear, useCss, icon, toast, short, compact, pageHead, seg, review } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, reader, CHAINS } from "../wallet.js";
import { sendTx, waitReceipt, errText, toRaw, rawInput, journal } from "../chain.js";

const STAKE = new Interface([
  "function stakeOf(address) view returns (uint256 amount, uint64 since, uint256 pending, uint64 unlockAt, uint256 earnedEth)",
  "function stake(uint256)", "function requestUnstake(uint256)", "function cancelUnstake()", "function withdraw()", "function claim()",
  "error ZeroAmount()", "error TooMuch(uint256 asked, uint256 staked)", "error NothingPending()", "error CoolingDown(uint64 unlockAt)",
  "error NothingToClaim()", "error EthTransferFailed()",
]);
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const DAY = 86_400_000;
const EXPLORER = CHAINS.robinhood.explorer;
const BADGE = "M12 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8.6 13.4 7 21l5-2.6 5 2.6-1.6-7.6M12 6.4l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z";

// "1.1000M" → "1.1M": compact() keeps the decimals it is given
const tok = (raw, dp = 2) => String(compact(Number(BigInt(raw)) / 1e18, dp)).replace(/\.(\d*?)0+(?=[^\d]*$)/, (_, d) => (d ? `.${d}` : ""));
const days = (ms) => ms / DAY;
const dateOf = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeOf = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pad = (n) => String(n).padStart(2, "0");
function countdown(ms) {
  if (ms <= 0) return "ready";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return `${d ? `${d}d ` : ""}${pad(hh)}h ${pad(mm)}m ${pad(s % 60)}s`;
}
function medal(key, size = 22) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("width", size); el.setAttribute("height", size);
  el.setAttribute("fill", "none"); el.setAttribute("stroke", "currentColor"); el.setAttribute("stroke-width", "1.5");
  el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", `stk-medal t-${key || "none"}`);
  el.innerHTML = BADGE.split(/(?=M)/).map((d) => `<path d="${d}"/>`).join("");
  return el;
}
// the same rule as server/stake.mjs: a tier needs its share of the supply staked AND its days, on the weighted start
function place(terms, amountRaw, sinceSec, now = Date.now()) {
  const held = sinceSec ? Math.max(0, now - sinceSec * 1000) : 0;
  let idx = -1;
  terms.tiers.forEach((t, i) => { if (t.minRaw != null && amountRaw >= BigInt(t.minRaw) && held >= t.minDays * DAY) idx = i; });
  return { idx, tier: terms.tiers[idx] || null, next: terms.tiers[idx + 1] || null, held };
}
// the start time a top-up of `add` would leave (weighted average, as the contract does it)
function sinceAfter(amountRaw, sinceSec, add, nowSec = Math.floor(Date.now() / 1000)) {
  if (amountRaw === 0n) return nowSec;
  return Number((amountRaw * BigInt(sinceSec) + add * BigInt(nowSec)) / (amountRaw + add));
}
function reason(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data || e?.revert?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const p = STAKE.parseError(data);
      if (p?.name === "CoolingDown") return `Still cooling down: the coins unlock ${timeOf(Number(p.args[0]) * 1000)}.`;
      if (p?.name === "TooMuch") return "That is more than you have staked.";
      if (p?.name === "NothingPending") return "No coins are waiting to be withdrawn.";
      if (p?.name === "NothingToClaim") return "No reward ETH to claim yet.";
      if (p?.name === "EthTransferFailed") return "Your wallet refused the ETH. Claim from a wallet that can receive ETH.";
      if (p?.name === "ZeroAmount") return "Enter an amount above zero.";
    } catch {}
  }
  return errText(e);
}

export async function mount(view) {
  useCss("stake");
  document.title = "Stake · Troya Agent";
  let alive = true, seq = 0, seen, tick = null;
  const st = { terms: null, stats: null, split: null, me: null, err: null, mode: "stake", amount: "", busy: null };
  const tiles = h("div", { class: "stk-tiles" });
  const act = h("section", { class: "panel stk-act" });
  const prog = h("section", { class: "panel stk-prog" });
  const tiersBox = h("section", { class: "panel stk-tiers" });
  const risks = h("section", { class: "panel stk-risks" });
  const foot = h("p", { class: "fine stk-foot" });
  const shareBox = h("p", { class: "fine stk-share" });
  const headBadge = h("span", { class: "stk-state" });
  clear(view, h("div", { class: "dk stk" },
    pageHead("Stake $TROYA", "Stake $TROYA to earn a tier: Bronze, Silver or Gold, from how much you stake and for how long. Each tier unlocks perks inside Troya. Unstaking takes 3 days. Stakers also share part of the $TROYA creator fees in ETH, paid into the staking contract every day (claim any time): a share that grows with market cap, varies with volume, not a promised yield.", { act: headBadge }),
    tiles, shareBox, h("div", { class: "stk-grid" }, act, prog), tiersBox, risks, foot));

  /* ---------------- data ---------------- */
  async function readMine(addr) {
    const p = reader("robinhood"), S = st.terms.contract, T = st.terms.token;
    const c = (to, iface, fn, args) => p.call({ to, data: iface.encodeFunctionData(fn, args) }).then((r) => iface.decodeFunctionResult(fn, r));
    const [[bal], [allow], [amount, since, pending, unlockAt, earned]] = await Promise.all([
      c(T, ERC20, "balanceOf", [addr]), c(T, ERC20, "allowance", [addr, S]), c(S, STAKE, "stakeOf", [addr])]);
    return { addr, bal: BigInt(bal), allow: BigInt(allow), amount: BigInt(amount), since: Number(since), pending: BigInt(pending), unlockAt: Number(unlockAt), earned: BigInt(earned) };
  }
  async function load() {
    const my = ++seq;
    try {
      const [terms, stats, split] = await Promise.all([api.get("stake"), api.get("stake/stats").catch(() => null), api.get("feesplit").catch(() => null)]);
      st.terms = terms; st.stats = stats; st.split = split; st.err = null;
      st.me = terms.deployed && wallet.address ? await readMine(wallet.address).catch((e) => { st.err = `Couldn't read your stake: ${errText(e)}`; return null; }) : null;
    } catch (e) { st.err = e.message || String(e); }
    if (alive && my === seq) paint();
  }
  // after a step: your numbers again from the chain, and the server's cached tier refreshed for the perks
  async function reloadMine() {
    if (!wallet.address || !st.terms?.deployed) return;
    try { st.me = await readMine(wallet.address); } catch {}
    api.get("stake/stats").then((s) => { st.stats = s; if (alive) paintTiles(); }).catch(() => {});
    setTimeout(() => api.get(`stake/${wallet.address}?fresh=1`).catch(() => {}), 5_500);
    if (alive) paint();
  }

  /* ---------------- paint ---------------- */
  function paint() {
    if (!st.terms) {
      clear(tiles, st.err ? h("div", { class: "alert error" }, st.err) : h("div", { class: "sk", style: { height: "92px" } }));
      clear(act); clear(prog); clear(tiersBox); clear(risks); clear(foot); clear(shareBox);
      return;
    }
    clear(headBadge, h("span", { class: `stk-pill ${st.terms.deployed ? "on" : ""}` }, st.terms.deployed ? "Live on Robinhood Chain" : "Opening soon"));
    paintTiles(); paintAct(); paintProg(); paintTiers(); paintRisks();
    const S = st.terms.contract;
    clear(foot, S && st.terms.deployed
      ? [h("span", {}, "Contract "), h("a", { class: "ulink mono", href: `${EXPLORER}/address/${S}`, target: "_blank", rel: "noopener" }, short(S, 6)),
        " on Robinhood Chain. No owner, no admin, no fee, not upgradeable: only you can move your coins. Tier sizes are a share of the $TROYA total supply, read on chain."]
      : "The staking contract is not live yet. When it is, its address shows here with a link to the explorer.");
  }

  // the $TROYA fee split (/api/feesplit): today's tier and the stakers' ETH so far, the staker pot and when it is paid,
  // yesterday's run, and the rule in plain words (it is counted before the contract: fees count for stakers from 21 Nov 2026)
  function paintShare() {
    const t = st.terms, f = st.split;
    const wording = f?.wording || t.share?.wording || "A share of $TROYA creator fees that grows with market cap, varies with volume, not a promised yield.";
    const paid = f?.paid || t.share?.paid || "Paid into the staking contract every day; claim any time.";
    const nos = f?.noStakers || t.share?.noStakers || "If nobody is staked when the daily share is paid, it stays with the team.";
    if (!f) { clear(shareBox, h("b", {}, "Creator fee share. "), wording, " ", paid, " ", nos); return; }
    const e6 = (x) => `${(+x || 0).toFixed(6)} ETH`;
    const mc = f.now?.mcUsd;
    const part = f.rate && f.rate.paidPct < 100;
    const today = `Today: tier ${f.now?.tier?.name || "–"} at MC ${mc ? `$${compact(mc, 1)}` : "not read yet"}, stakers get ${e6(part ? f.today?.stakersReceiveEth : f.today?.stakerEth)} so far${part ? ` (of a ${e6(f.today?.stakerEth)} share)` : ""}${f.today?.burnEth ? `, ${e6(f.today.burnEth)} to buy back and burn` : ""}.`;
    const held = !f.pot?.contractLive || (f.schedule?.firstPayAt && Date.now() < f.schedule.firstPayAt);
    const pot = `Staker pot so far: ${e6(f.pot?.stakerEth)}, ${f.pot?.payOn ? `paid on ${dateOf(f.pot.payOn)}` : "paid with the first daily run 7 days after the stake contract goes live"}${part ? ` (at today's stake, stakers would receive ${e6(f.pot?.receiveEthAtTodaysStake)} of it)` : ""}${f.mode === "live" ? "" : " (payments are not switched on yet)"}.`;
    const ld = f.lastDay;
    const why = (r) => String(r || "").replace(/^Returned to the owner: /, "").replace(/[.]$/, "");
    const ldText = (p) => (!p ? "" : p.status === "sent" ? `${e6(p.sentEth)} sent` : p.status === "held" ? `${e6(p.accruedEth)} kept in the pot`
      : p.status === "returned" ? `${e6(p.returnedEth)} stayed with the team${p.reason ? ` (${why(p.reason)})` : ""}`
      : p.status === "dry" ? `${e6(p.sendEth || p.accruedEth)} worked out, not sent` : p.status === "none" ? "nothing" : p.status);
    const tierLines = (f.tiers || []).map((x) => h("li", {}, h("b", {}, x.name), `: stakers ${x.stakersPctOfVolume}% of volume${x.burnPctOfVolume ? `, plus ${x.burnPctOfVolume}% bought back and burned` : ""}`));
    clear(shareBox,
      h("div", { class: "stk-share-l" }, h("b", {}, today)),
      held || f.pot?.stakerEth ? h("div", { class: "stk-share-l" }, h("b", {}, pot)) : null,
      f.rate ? h("div", { class: "stk-share-l" }, h("b", {}, f.rate.line), " ", f.rate.rule) : null,
      ld ? h("div", { class: "stk-share-l muted" }, `Yesterday (${ld.day}): stakers ${ldText(ld.stakers)}; burn ${ldText(ld.burn)}.`,
        ld.stakers?.hash ? [" ", h("a", { class: "ulink", href: `${EXPLORER}/tx/${ld.stakers.hash}`, target: "_blank", rel: "noopener" }, "Transaction")] : null) : null,
      h("div", { class: "stk-share-l" }, wording, " ", h("b", {}, paid), " ", h("b", {}, nos)),
      h("details", { class: "stk-share-how" }, h("summary", {}, "How the share works"), h("p", {}, f.rule), h("ul", {}, tierLines),
        h("p", { class: "muted" }, "The market cap of each hour is the median of several reads that hour (Troya's market index, DexScreener and the pool price on chain), so a short pump does not move the tier.")));
  }

  function paintTiles() {
    paintShare();
    const t = st.terms, s = st.stats, me = st.me;
    const tile = (k, v, sub, cls = "") => h("div", { class: `stk-tile ${cls}` }, h("span", {}, k), h("b", {}, v), sub ? h("small", {}, sub) : null);
    const pub = [
      tile("Total staked", s?.deployed ? `${compact(s.totalStaked, 2)}` : "–", s?.deployed ? `${s.pctOfSupplyStaked.toFixed(2)}% of the supply` : "$TROYA"),
      tile("Stakers", s?.deployed ? String(s.stakers) : "–", s?.deployed ? `${s.waiting} waiting to leave` : null),
    ];
    if (!t.deployed || !me) { clear(tiles, ...pub, tile("Cooldown", "3 days", "between unstake and withdraw"), tile("Fee", "None", "no owner, no admin")); return; }
    const p = place(t, me.amount, me.since);
    clear(tiles,
      tile("Your stake", `${tok(me.amount)} $TROYA`, me.amount ? `${t.supply ? ((Number(me.amount) / 1e18 / t.supply) * 100).toFixed(3) : "–"}% of the supply` : "nothing staked yet"),
      tile("Time staked", me.since ? `${days(p.held).toFixed(1)} days` : "–", me.since ? `counted from ${dateOf(me.since * 1000)}` : "starts when you stake"),
      h("div", { class: "stk-tile stk-tile-tier" }, h("span", {}, "Your tier"), h("b", {}, medal(p.tier?.key), p.tier?.name || "No tier yet"), h("small", {}, p.next ? `${p.next.name} next` : "the top tier")),
      tile("Waiting to leave", me.pending ? `${tok(me.pending)} $TROYA` : "Nothing", me.pending ? (Date.now() >= me.unlockAt * 1000 ? "ready to withdraw" : `unlocks ${timeOf(me.unlockAt * 1000)}`) : "no cooldown running"),
      ...pub.slice(0, 1));
  }

  function paintAct() {
    const t = st.terms, me = st.me;
    if (tick) { clearInterval(tick); tick = null; }
    if (!t.deployed) return clear(act, h("h3", {}, "Stake"), h("p", { class: "muted" }, "Staking opens when the contract is live on Robinhood Chain. There is nothing to sign yet. The tiers, perks, the daily creator-fee share and the risks below are the plan."));
    if (!wallet.address) return clear(act, h("h3", {}, "Stake"), h("p", { class: "muted" }, "Connect the wallet that holds your $TROYA. Staking is signed in your own wallet; Troya never holds your coins."),
      h("button", { class: "btn primary", type: "button", onclick: () => openConnect() }, icon("wallet"), "Connect wallet"));
    if (!me) return clear(act, h("h3", {}, "Stake"), h("div", { class: "alert error" }, st.err || "Couldn't read your stake right now."), h("button", { class: "btn", type: "button", onclick: load }, icon("refresh"), "Try again"));

    const modeSeg = seg([{ value: "stake", label: "Stake" }, { value: "unstake", label: "Unstake" }], st.mode, (v) => { st.mode = v; st.amount = ""; paintAct(); }, "stk-seg");
    const max = st.mode === "stake" ? me.bal : me.amount;
    const input = h("input", { class: "input stk-in", inputmode: "decimal", placeholder: "0.0", value: st.amount, "aria-label": st.mode === "stake" ? "$TROYA to stake" : "$TROYA to unstake", disabled: !!st.busy });
    const hint = h("p", { class: "fine stk-hint" });
    const go = h("button", { class: "btn primary stk-go", type: "button" });
    const paintGo = () => {
      const raw = toRaw(input.value, 18);
      const bad = raw == null || raw <= 0n, over = raw != null && raw > max;
      go.disabled = !!st.busy || bad || over;
      if (st.mode === "stake") {
        const needApprove = raw != null && raw > me.allow;
        clear(go, icon(needApprove ? "key" : "plus"), st.busy || (bad ? "Enter an amount" : over ? "More than your wallet holds" : needApprove ? "Approve, then stake (2 steps)" : "Stake"));
        if (!bad && !over) {
          const ns = sinceAfter(me.amount, me.since, raw);
          const p = place(t, me.amount + raw, ns);
          clear(hint, me.amount ? `After this your stake counts as ${days(Math.max(0, Date.now() - ns * 1000)).toFixed(1)} days old (a top-up moves the start time forward in proportion to the coins added). ` : "Your stake's time starts now. ",
            p.tier ? `That is ${p.tier.name} right away.` : p.next ? `${p.next.name} needs ${p.next.minDays} days at this size.` : "");
        } else clear(hint, "Approving lets the stake contract take exactly this amount, nothing more.");
      } else {
        clear(go, icon("clock"), st.busy || (bad ? "Enter an amount" : over ? "More than you have staked" : "Start the 3-day cooldown"));
        clear(hint, raw != null && raw === me.amount && raw > 0n ? "Unstaking everything resets your stake's age: a new stake starts from zero days." : "Coins you unstake stop counting for your tier right away and can be withdrawn after 3 days.");
      }
    };
    input.addEventListener("input", () => { st.amount = input.value; paintGo(); });
    go.onclick = () => (st.mode === "stake" ? doStake(toRaw(input.value, 18)) : doUnstake(toRaw(input.value, 18)));
    paintGo();

    const pendingBox = me.pending > 0n ? (() => {
      const left = h("b", { class: "stk-count" });
      const wd = h("button", { class: "btn blue", type: "button", onclick: doWithdraw }, icon("arrowUp"), "Withdraw");
      const upd = () => {
        const ms = me.unlockAt * 1000 + 5_000 - Date.now();      // a few seconds past the unlock, so the chain's clock agrees
        left.textContent = ms > 0 ? countdown(ms) : "Ready";
        wd.disabled = ms > 0 || !!st.busy;
        if (ms <= 0 && tick) { clearInterval(tick); tick = null; }
      };
      upd();
      if (me.unlockAt * 1000 + 5_000 > Date.now()) tick = setInterval(upd, 1000);
      return h("div", { class: "stk-pending" },
        h("div", {}, h("small", { class: "muted" }, "Waiting to leave"), h("div", { class: "stk-pend-amt" }, `${tok(me.pending)} $TROYA`),
          h("small", { class: "muted" }, `Unlocks ${timeOf(me.unlockAt * 1000)}`)),
        h("div", { class: "stk-pend-r" }, h("small", { class: "muted" }, "Time left"), left),
        h("div", { class: "stk-pend-btns" }, wd, h("button", { class: "btn ghost", type: "button", disabled: !!st.busy, onclick: doCancel }, icon("loop"), "Put back into stake")));
    })() : null;

    const rewardsOn = st.stats?.rewards?.on || me.earned > 0n;
    const rewardBox = rewardsOn ? h("div", { class: "stk-reward" },
      h("div", {}, h("small", { class: "muted" }, "Reward ETH to claim"), h("b", {}, `${(Number(me.earned) / 1e18).toFixed(6)} ETH`)),
      h("button", { class: "btn", type: "button", disabled: me.earned === 0n || !!st.busy, onclick: doClaim }, "Claim")) : null;

    clear(act,
      h("div", { class: "stk-act-h" }, h("h3", {}, st.mode === "stake" ? "Stake" : "Unstake"), modeSeg),
      h("div", { class: "stk-bal" }, h("span", { class: "muted" }, st.mode === "stake" ? "In your wallet" : "Staked"), h("b", {}, `${tok(max, 4)} $TROYA`)),
      h("div", { class: "stk-row" }, input, h("button", { class: "btn sm", type: "button", disabled: !!st.busy || max === 0n, onclick: () => { st.amount = rawInput(max, 18, 6); input.value = st.amount; paintGo(); } }, "Max")),
      hint, go,
      st.mode === "stake" && me.bal === 0n ? h("a", { class: "ulink", href: `#/swap?out=${t.token}` }, "Buy $TROYA first") : null,
      pendingBox, rewardBox,
      st.busy ? h("p", { class: "fine stk-busy" }, st.busy) : null);
  }

  function paintProg() {
    const t = st.terms, me = st.me;
    const amount = me?.amount || 0n, since = me?.since || 0;
    const p = place(t, amount, since);
    const bar = (label, frac, text) => h("div", { class: "stk-bar-row" },
      h("div", { class: "stk-bar-l" }, h("span", {}, label), h("small", {}, text)),
      h("div", { class: "stk-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(frac * 100)), "aria-label": label },
        h("i", { style: { width: `${Math.max(frac > 0 ? 2 : 0, Math.min(100, frac * 100)).toFixed(1)}%` } })));
    const kids = [h("h3", {}, "Tier progress")];
    kids.push(h("div", { class: `stk-now t-${p.tier?.key || "none"}` }, medal(p.tier?.key, 40),
      h("div", {}, h("b", {}, p.tier?.name || "No tier yet"), h("small", { class: "muted" }, p.tier ? `${p.tier.minPctOfSupply}% of supply for ${p.tier.minDays} days, reached` : wallet.address ? "Stake to start" : "Connect a wallet to see yours"))));
    if (p.next) {
      const need = BigInt(p.next.minRaw || 0);
      const aFrac = need > 0n ? Math.min(1, Number((amount * 10_000n) / need) / 10_000) : 1;
      const tFrac = p.next.minDays > 0 ? Math.min(1, p.held / (p.next.minDays * DAY)) : 1;
      const more = amount >= need ? 0n : need - amount;
      kids.push(h("p", { class: "fine stk-next" }, `Next: ${p.next.name}. It needs both.`),
        bar("Size", aFrac, more ? `${tok(amount)} of ${tok(need)} $TROYA · ${tok(more)} more` : `${tok(need)} $TROYA reached`),
        bar("Time", tFrac, tFrac >= 1 ? `${p.next.minDays} days reached` : since ? `${days(p.held).toFixed(1)} of ${p.next.minDays} days · met on ${dateOf(since * 1000 + p.next.minDays * DAY)} if you add nothing` : `${p.next.minDays} days from your first stake`));
      if (more > 0n && wallet.address) kids.push(h("button", { class: "btn sm", type: "button", onclick: () => { st.mode = "stake"; st.amount = rawInput(more <= (me?.bal || 0n) ? more : me?.bal || 0n, 18, 6); paintAct(); act.scrollIntoView({ behavior: "smooth", block: "start" }); } }, icon("plus"), `Stake ${tok(more)} more`));
    } else kids.push(h("p", { class: "fine" }, "You are in the top tier. Keep it staked to keep it."));
    kids.push(h("p", { class: "fine muted stk-rule" }, "Coins waiting out the cooldown count for nothing. A top-up moves your start time forward in proportion to the coins added, so a big top-up looks younger than a small one."));
    clear(prog, ...kids);
  }

  function perkLines(pk) {
    return [
      pk.sentryLeadSec ? `Sentry alerts ${pk.sentryLeadSec} s before the public channel` : null,
      pk.aiQuotaX > 1 ? `${pk.aiQuotaX}x assistant messages and Council calls` : null,
      pk.gateFreePerDay ? `${pk.gateFreePerDay} free Gate API checks a day` : null,
      pk.arenaCupPoints ? `${pk.arenaCupPoints} Arena Cup points a week` : null,
      pk.badge ? `${pk.badge[0].toUpperCase()}${pk.badge.slice(1)} badge on your wallet` : null,
    ].filter(Boolean);
  }
  function paintTiers() {
    const t = st.terms, p = st.me ? place(t, st.me.amount, st.me.since) : { tier: null };
    clear(tiersBox,
      h("div", { class: "panel-h" }, h("h2", {}, "Tiers and perks"), h("span", { class: `stk-pill ${t.perksLive ? "on" : ""}` }, t.perksLive ? "Perks live" : "Perks switch on soon")),
      h("div", { class: "stk-cards" }, t.tiers.map((x) => h("div", { class: `stk-card t-${x.key} ${p.tier?.key === x.key ? "is-you" : ""}` },
        h("div", { class: "stk-card-h" }, medal(x.key, 28), h("b", {}, x.name), p.tier?.key === x.key ? h("span", { class: "stk-you" }, "You") : null),
        h("div", { class: "stk-req" }, h("div", {}, h("b", {}, x.minTokens != null ? `${compact(x.minTokens, 1)} $TROYA` : `${x.minPctOfSupply}% of supply`), h("small", {}, `${x.minPctOfSupply}% of the supply`)),
          h("div", {}, h("b", {}, `${x.minDays} days`), h("small", {}, "staked"))),
        h("ul", { class: "stk-perks" }, perkLines(x.perks).map((l) => h("li", {}, icon("check"), l)))))),
      h("p", { class: "fine muted" }, "No perk is money: they are features inside Troya. Sizes and perks are set by the team on the server and can change; the contract itself never changes."));
  }
  function paintRisks() {
    const t = st.terms;
    const items = [
      ["Smart contract risk", "Your coins sit in a smart contract. A bug in it could lose them. It is tested and has no owner, but it has not had an outside audit."],
      ["3 days to get out", "Unstaking takes 3 days, and you cannot sell coins that are staked or waiting. If the price falls in those days, there is no faster way out."],
      ["The wait restarts", "Asking to unstake more while coins already wait adds them and restarts the 3-day wait for all of them."],
      ["Nobody can undo a mistake", "There is no owner, admin, pause or upgrade. $TROYA sent straight to the contract address, instead of through Stake, is lost for good."],
      ["Not a yield", "The daily ETH is a share of $TROYA creator fees: it moves with trading volume and with the market cap tier, can be zero on a quiet day, and is not promised. It goes to the coins staked at the moment it arrives (every day at 01:00 UTC, for the day before); coins waiting out the cooldown get none. If nobody is staked then, or it is under 0.00002 ETH, it stays with the team."],
      ["Tiers can move", "Tier sizes are a share of the total supply, and the team can change sizes and perks. A tier you reach today can need more later."],
      t.holdersCountStaked ? ["Holder tiers", "Treasury holder tiers count your staked and waiting coins too."]
        : ["Holder tiers", "For now Treasury holder tiers read your wallet balance only: coins you stake leave your wallet and stop counting there."],
      ["Network fees", "Every step (approve, stake, unstake, withdraw, claim) is a transaction on Robinhood Chain paid in ETH."],
    ];
    clear(risks, h("div", { class: "panel-h" }, h("h2", {}, icon("shield"), "Risks, in plain words")),
      h("ul", { class: "stk-risk-list" }, items.map(([k, v]) => h("li", {}, h("b", {}, k), h("span", {}, v)))));
  }

  /* ---------------- steps ---------------- */
  async function step(label, tx, kind, summary) {
    st.busy = label; paint();
    try {
      const hash = await sendTx("robinhood", tx);
      st.busy = `${label.replace(/…$/, "")}: waiting for the chain…`; paintAct();
      const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
      if (rc?.status !== 1) throw new Error(`${label.replace(/…$/, "")} did not go through on chain.`);
      journal({ kind, summary, status: "done", hash, chain: "robinhood" });
      return hash;
    } finally { st.busy = null; }
  }
  const S = () => st.terms.contract, T = () => st.terms.token;
  async function doStake(raw) {
    const me = st.me;
    if (!raw || raw <= 0n || raw > me.bal) return;
    const ns = sinceAfter(me.amount, me.since, raw), p = place(st.terms, me.amount + raw, ns);
    const okd = await review({ title: "Stake $TROYA", confirmLabel: raw > me.allow ? "Approve and stake" : "Stake",
      rows: [["Stake", `${tok(raw, 4)} $TROYA`], ["Staked after", `${tok(me.amount + raw, 4)} $TROYA`], ["Counts as", `${days(Math.max(0, Date.now() - ns * 1000)).toFixed(1)} days old`], ["Tier after", p.tier?.name || "No tier yet"], ["Wallet steps", raw > me.allow ? "2 (approve, then stake)" : "1"]],
      warn: "Unstaking later takes 3 days. Coins in the stake cannot be sold until you withdraw them." });
    if (!okd) return;
    const two = raw > me.allow;
    try {
      if (two) {
        await step("Step 1 of 2: approve in your wallet…", { to: T(), data: ERC20.encodeFunctionData("approve", [S(), raw]) }, "stake-approve", `Approved ${tok(raw)} $TROYA for staking`);
        st.me.allow = raw;
      }
      await step(two ? "Step 2 of 2: stake in your wallet…" : "Stake in your wallet…", { to: S(), data: STAKE.encodeFunctionData("stake", [raw]) }, "stake", `Staked ${tok(raw)} $TROYA`);
      toast("Staked.", "ok"); st.amount = "";
    } catch (e) { toast(reason(e), "error", 6000); }
    await reloadMine();
  }
  async function doUnstake(raw) {
    const me = st.me;
    if (!raw || raw <= 0n || raw > me.amount) return;
    const all = raw === me.amount;
    const okd = await review({ title: "Start the 3-day cooldown", confirmLabel: "Start cooldown", danger: all,
      rows: [["Unstake", `${tok(raw, 4)} $TROYA`], ["Stays staked", `${tok(me.amount - raw, 4)} $TROYA`], ["Withdraw from", timeOf(Date.now() + 3 * DAY)], me.pending ? ["Already waiting", `${tok(me.pending, 4)} $TROYA (their wait restarts too)`] : null],
      warn: `${all ? "Your stake's age resets to zero. " : ""}These coins stop counting for your tier now and earn nothing while they wait.` });
    if (!okd) return;
    try {
      await step("Unstake in your wallet…", { to: S(), data: STAKE.encodeFunctionData("requestUnstake", [raw]) }, "unstake", `Started unstaking ${tok(raw)} $TROYA (3-day cooldown)`);
      toast("Cooldown started. Withdraw in 3 days.", "ok"); st.amount = "";
    } catch (e) { toast(reason(e), "error", 6000); }
    await reloadMine();
  }
  async function doWithdraw() {
    try {
      await step("Withdraw in your wallet…", { to: S(), data: STAKE.encodeFunctionData("withdraw") }, "stake-withdraw", `Withdrew ${tok(st.me.pending)} $TROYA from staking`);
      toast("Withdrawn to your wallet.", "ok");
    } catch (e) { toast(reason(e), "error", 6000); }
    await reloadMine();
  }
  async function doCancel() {
    const me = st.me;
    const okd = await review({ title: "Put back into stake", confirmLabel: "Put back",
      rows: [["Back into stake", `${tok(me.pending, 4)} $TROYA`], ["Counts as", "a top-up made now"]],
      warn: "The coins rejoin your stake as if added today, which moves your start time forward in proportion." });
    if (!okd) return;
    try {
      await step("Confirm in your wallet…", { to: S(), data: STAKE.encodeFunctionData("cancelUnstake") }, "stake-cancel", `Put ${tok(me.pending)} $TROYA back into staking`);
      toast("Back in your stake.", "ok");
    } catch (e) { toast(reason(e), "error", 6000); }
    await reloadMine();
  }
  async function doClaim() {
    try {
      await step("Claim in your wallet…", { to: S(), data: STAKE.encodeFunctionData("claim") }, "stake-claim", `Claimed ${(Number(st.me.earned) / 1e18).toFixed(6)} ETH staking reward`);
      toast("Reward ETH sent to your wallet.", "ok");
    } catch (e) { toast(reason(e), "error", 6000); }
    await reloadMine();
  }

  // every minute: the totals and your numbers again; the form is repainted only when your numbers changed, so typing is not lost
  const key = (m) => (m ? [m.bal, m.allow, m.amount, m.since, m.pending, m.unlockAt, m.earned].join("|") : "");
  async function soft() {
    if (document.hidden || st.busy || !st.terms) return;
    const before = key(st.me);
    const [stats, me, split] = await Promise.all([api.get("stake/stats").catch(() => st.stats), st.terms.deployed && wallet.address ? readMine(wallet.address).catch(() => st.me) : null, api.get("feesplit").catch(() => st.split)]);
    if (!alive) return;
    st.stats = stats; st.split = split;
    if (me) st.me = me;
    if (key(st.me) !== before && !act.contains(document.activeElement)) paint(); else { paintTiles(); paintProg(); }
  }
  // onWallet calls back at once: that first call is the load; after that only an address change reloads
  const off = onWallet(() => { const k = String(wallet.address || "").toLowerCase(); if (k !== seen) { seen = k; st.me = null; load(); } });
  const refresher = setInterval(soft, 60_000);
  return () => { alive = false; off(); clearInterval(refresher); if (tick) clearInterval(tick); };
}
