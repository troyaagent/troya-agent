// "How it works on-chain", the trust section of #/stake (owner, 22 Nov 2026), answering "people staked with another team that
// vanished and nobody could unstake: what is the guarantee here?". It shows, from the contract itself:
//   · the flow of coins and of reward ETH through TroyaStake, each arrow named by the function that moves it (inline SVG);
//   · what the contract cannot do, each point linked to its line in the published source (pinned to the commit Sourcify and
//     Blockscout verified as an exact match) or to the test that proves it;
//   · how to leave through Blockscout with no troya.codes at all, with your own staked amount in wei, ready to paste;
//   · the contract's totals read live from Robinhood Chain through Troya's RPC relay, with the time and block of the read.
// Checked on 22 Nov 2026 against contracts/src/TroyaStake.sol and the chain: deployed in block 120,022,765 (21 Nov 2026,
// 16:55:33 UTC) by the creator wallet, token() = $TROYA, COOLDOWN() = 259,200, owner() and paused() revert, 17 functions in
// the ABI (6 writes, 11 reads), no receive(). The facts are tied to that one address: a different contract in /api/stake hides
// the section instead of showing claims that were never checked against it.
// stake.js loads this module with a dynamic import, so it never holds up the stake form.
import { Interface } from "ethers";
import { h, clear, icon, short, compact, copyText } from "../ui.js";
import { reader, CHAINS } from "../wallet.js";
import { toRaw, rawInput } from "../chain.js";

const EXPLORER = CHAINS.robinhood.explorer;
const DEPLOYED = {
  contract: "0x1C867c13BD950a90aB75158C1C45061837aa02d2",
  block: 120_022_765,
  at: Date.UTC(2026, 10, 21, 16, 55, 33),
  tx: "0xcedeef59b68a8ba793672b80b1fd7eb2fcd0fd79ab4e440b78d77349c6fc1418",
  creator: "0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4",   // the $TROYA creator wallet: it deployed the contract and sends the daily share
  commit: "7a4fdb523b167a5aa0c4a7ed8430434be4eefe3e",      // the last commit that touched TroyaStake.sol and its tests (= the verified source)
};
const REPO = "https://github.com/troyaagent/troya-agent";
const SRC = `${REPO}/blob/${DEPLOYED.commit}/contracts/src/TroyaStake.sol`;
const TESTS = `${REPO}/blob/${DEPLOYED.commit}/contracts/test/TroyaStake.t.sol`;
const TEST_DIR = `${REPO}/tree/${DEPLOYED.commit}/contracts/test`;
const L = (a, b) => `${SRC}#L${a}${b ? `-L${b}` : ""}`;
const T = (a, b) => `${TESTS}#L${a}${b ? `-L${b}` : ""}`;
const RPC = CHAINS.robinhood.rpcs.find((u) => !u.includes("troya.codes")) || CHAINS.robinhood.rpcs[0];

const VIEWS = new Interface(["function totalStaked() view returns (uint256)", "function totalPending() view returns (uint256)",
  "function totalRewarded() view returns (uint256)", "function totalClaimed() view returns (uint256)"]);
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const NS = "http://www.w3.org/2000/svg";
const lc = (s) => String(s || "").toLowerCase();
const tok = (raw, dp = 2) => String(compact(Number(BigInt(raw)) / 1e18, dp)).replace(/\.(\d*?)0+(?=[^\d]*$)/, (_, d) => (d ? `.${d}` : ""));
const eth = (wei) => `${(Number(BigInt(wei)) / 1e18).toFixed(6)} ETH`;
const timeOf = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ext = (href, ...kids) => h("a", { class: "ulink", href, target: "_blank", rel: "noopener" }, ...kids);
const ev = (label, href) => h("a", { class: "stk-ev", href, target: "_blank", rel: "noopener" }, label, icon("ext"));
const chev = () => sv("svg", { viewBox: "0 0 16 16", class: "stk-chev", "aria-hidden": "true" }, sv("path", { d: "M4 6l4 4 4-4" }));
const narrow = () => { try { return matchMedia("(max-width: 640px)").matches; } catch { return false; } };

/* ---------------- the flow diagram ---------------- */

function sv(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
let laneSeq = 0;
// one lane, top to bottom: nodes joined by arrows, each arrow named by the function (or the plain step) that moves the value
function lane({ key, title, desc, nodes, arrows }) {
  const W = 340, NH = 60, GAP = 58, TOP = 30;
  const H = TOP + nodes.length * NH + (nodes.length - 1) * GAP + 2;
  const id = `stk-lane-${key}-${++laneSeq}`;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: `stk-lane stk-lane-${key}`, role: "img", "aria-labelledby": `${id}-t ${id}-d` },
    sv("title", { id: `${id}-t` }, title), sv("desc", { id: `${id}-d` }, desc),
    sv("circle", { cx: 6, cy: 11, r: 3.5, class: "stk-l-dot" }),
    sv("text", { x: 16, y: 15, class: "stk-l-cap" }, title.toUpperCase()));
  nodes.forEach((n, i) => {
    const y = TOP + i * (NH + GAP), cy = y + NH / 2;
    const ic = icon(n.icon, "stk-n-ic");
    for (const [k, v] of Object.entries({ x: 21, y: cy - 9, width: 18, height: 18 })) ic.setAttribute(k, v);
    svg.append(sv("g", { class: `stk-n${n.hub ? " hub" : ""}` },
      sv("rect", { x: 1, y: y + 0.5, width: W - 2, height: NH - 1, rx: 15 }),
      sv("circle", { cx: 30, cy, r: 17, class: "stk-n-disc" }), ic,
      sv("text", { x: 60, y: y + 26, class: "stk-n-t" }, n.t),
      sv("text", { x: 60, y: y + 45, class: "stk-n-s" }, n.s)));
  });
  arrows.forEach((a, i) => {
    const y0 = TOP + i * (NH + GAP) + NH, y1 = y0 + GAP, d = `M30 ${y0 + 5}V${y1 - 6}`;
    svg.append(sv("g", { class: "stk-a" },
      sv("path", { d, class: "stk-a-line" }), sv("path", { d, class: "stk-a-run" }),
      sv("path", { d: `M24.5 ${y1 - 12} 30 ${y1 - 5.5} 35.5 ${y1 - 12}`, class: "stk-a-head" }),
      sv("text", { x: 54, y: y0 + GAP / 2 - 3, class: `stk-a-fn${a.plain ? " plain" : ""}` }, a.fn),
      sv("text", { x: 54, y: y0 + GAP / 2 + 14, class: "stk-a-note" }, a.note)));
  });
  return svg;
}

function flow() {
  const coins = lane({
    key: "coins", title: "Your coins",
    desc: "Your wallet signs approve and stake(amount); the TroyaStake contract holds the coins and has no owner or admin. requestUnstake(amount) starts a fixed 3-day wait. withdraw() then sends every waiting coin back to the wallet that staked.",
    nodes: [
      { icon: "wallet", t: "Your wallet", s: "your $TROYA, your keys" },
      { icon: "shield", t: "TroyaStake contract", s: "holds the coins · no owner, no admin", hub: true },
      { icon: "clock", t: "3-day wait", s: "COOLDOWN = 259,200 s, fixed in code" },
      { icon: "wallet", t: "Back in your wallet", s: "the same address that staked" },
    ],
    arrows: [
      { fn: "approve() + stake(amount)", note: "you sign both; Troya never holds coins" },
      { fn: "requestUnstake(amount)", note: "the 3 days start; these coins stop earning" },
      { fn: "withdraw()", note: "every waiting coin, to the caller only" },
    ],
  });
  const rewards = lane({
    key: "eth", title: "Your reward ETH",
    desc: "$TROYA trades pay a 2.6% creator fee to the creator wallet. Every day it sends the stakers' share to the contract with notifyReward(). The contract splits it by the coins staked at that moment, and you take yours with claim().",
    nodes: [
      { icon: "swap", t: "$TROYA trades", s: "2.6% of each trade is the creator fee" },
      { icon: "key", t: "Creator wallet", s: `${short(DEPLOYED.creator, 4)}, run by the team` },
      { icon: "shield", t: "TroyaStake contract", s: "splits it by the coins staked now", hub: true },
      { icon: "wallet", t: "Your wallet", s: "your ETH, claimed by you" },
    ],
    arrows: [
      { fn: "creator fees", plain: true, note: "a share is set aside for stakers" },
      { fn: "notifyReward()", note: "daily at 01:00 UTC · anyone may add ETH" },
      { fn: "claim()", note: "any time, only to the staker" },
    ],
  });
  return h("div", { class: "stk-flow" }, h("figure", {}, coins), h("figure", {}, rewards));
}

/* ---------------- the section ---------------- */

/** The on-chain section. `get()` returns { terms, stats, me, address } from stake.js; `connect()` opens the wallet picker.
 *  paint() redraws what changed (your amounts, the live totals) without rebuilding the rest; read() reads the chain again. */
export function chainPanel({ get, connect }) {
  const el = h("section", { class: "panel stk-ch", hidden: true, "aria-labelledby": "stk-ch-title" });
  const live = h("div", { class: "stk-ch-live" });
  const liveNote = h("p", { class: "fine stk-ch-note" });
  const helper = h("div", { class: "stk-wei" });
  const yourWait = h("p", { class: "fine stk-ch-you" });
  const yourEth = h("p", { class: "fine stk-ch-you" });
  const cli = h("pre", { class: "stk-cli" });
  let built = false, data = null, err = null, reading = false, typed = false, who = null, text = "";
  const C = DEPLOYED.contract;
  const bsCode = `${EXPLORER}/address/${C}?tab=contract`;
  const bsWrite = `${EXPLORER}/address/${C}?tab=read_write_contract`;
  const sourcify = `https://repo.sourcify.dev/4663/${C}`;

  function build(t) {
    built = true;
    const open = !narrow();
    const facts = [
      ["Contract", [h("span", { class: "mono" }, short(C, 6)), " ", h("button", { class: "stk-copy", type: "button", "aria-label": "Copy the contract address", onclick: () => copyText(C, "Contract address copied") }, icon("copy")), " ", ext(`${EXPLORER}/address/${C}`, "Blockscout")]],
      ["Network", "Robinhood Chain (chain ID 4663)"],
      ["Coin", ["$TROYA ", ext(`${EXPLORER}/token/${t.token}`, h("span", { class: "mono" }, short(t.token, 4)))]],
      ["Deployed", [`${new Date(DEPLOYED.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, block ${DEPLOYED.block.toLocaleString("en-US")} · `, ext(`${EXPLORER}/tx/${DEPLOYED.tx}`, "transaction")]],
      ["Source", ["Verified, exact match: ", ext(bsCode, "Blockscout"), " · ", ext(sourcify, "Sourcify"), " · ", ext(SRC, "GitHub")]],
      ["Audit", [h("b", { class: "stk-warn" }, "Not audited by an outside firm yet."), " Public tests: ", ext(TEST_DIR, "40 unit and fuzz, 4 invariants, 1 fork test")]],
    ];
    const cant = [
      ["Only 6 functions can change anything", "stake, requestUnstake, cancelUnstake, withdraw and claim act only on the calling wallet's own account; notifyReward only adds ETH. The other 11 functions only read. Blockscout lists all 17.",
        [ev("All 17 on Blockscout", bsWrite), ev("Source L82–169", L(82, 169))]],
      ["No owner, no admin", "It inherits only a re-entry guard: no Ownable, no admin role, no allow-list. The constructor stores the coin's address and nothing else, so the wallet that deployed it got no power over it.",
        [ev("L21", L(21)), ev("Constructor L72–75", L(72, 75))]],
      ["No pause", "Nothing can stop staking, unstaking or withdrawing. withdraw() checks only that you have coins waiting and that their 3 days are over.",
        [ev("withdraw() L126–136", L(126, 136))]],
      ["No upgrade", "Not a proxy: the code at the address matches the published source exactly, and it has no delegatecall and no selfdestruct. The coin it holds is fixed for good (immutable).",
        [ev("Verified code", bsCode), ev("Sourcify", sourcify), ev("L40", L(40))]],
      ["No fee", "Every coin that arrives is booked as yours; withdraw() pays back every waiting coin and claim() all your ETH. There is no fee in the code to switch on.",
        [ev("stake() L86–91", L(86, 91)), ev("L134", L(134))]],
      ["Nobody can move or freeze your coins", "Every function acts on the wallet that calls it (msg.sender). The one line that sends $TROYA out and the one line that sends ETH out both pay the caller. A test tries it from another wallet and fails.",
        [ev("Coins out L134", L(134)), ev("ETH out L167", L(167)), ev("Test", T(320, 334))]],
      ["The 3 days are fixed", "COOLDOWN is a constant compiled into the code: 259,200 seconds. Nobody can make the wait longer.",
        [ev("L26", L(26))]],
      ["No rescue, no sweep", "Only your own withdraw() and claim() take anything out. Plain ETH is refused (there is no receive()), so ETH only comes in as a reward. The flip side: $TROYA sent straight to the address, not through stake(), can never come back.",
        [ev("notifyReward() L144–156", L(144, 156)), ev("Test", T(336, 340))]],
    ];
    const steps = [
      [h("b", {}, "Open the verified contract on Blockscout"), " and go to Read/Write contract. Check the address: ", h("span", { class: "mono stk-addr" }, C), ".",
        h("div", { class: "stk-step-act" }, h("a", { class: "btn sm", href: bsWrite, target: "_blank", rel: "noopener" }, icon("ext"), "Open on Blockscout"))],
      [h("b", {}, "Connect your wallet"), " with Connect your wallet at the top of the list: the wallet that staked, on Robinhood Chain (chain ID 4663)."],
      [h("b", {}, "requestUnstake(amount)"), ": open it, paste your amount in wei (18 decimals) into amount, press Write and confirm in your wallet. Or type whole $TROYA and press ×10^18.", helper],
      [h("b", {}, "Wait 3 days."), " stakeOf(your address), on the same page, shows unlockAt in Unix seconds. Asking to unstake more restarts the 3 days for every waiting coin; cancelUnstake() puts them back into the stake.", yourWait],
      [h("b", {}, "withdraw()"), ": press Write. There is nothing to type: every waiting coin goes back to your wallet."],
      [h("b", {}, "claim()"), " for your reward ETH: press Write, any time, even after you have left.", yourEth],
    ];
    clear(el,
      h("div", { class: "panel-h" }, h("h2", { id: "stk-ch-title" }, icon("shield"), "How it works on-chain"),
        h("a", { class: "stk-pill on", href: bsCode, target: "_blank", rel: "noopener" }, "Source verified · exact match")),
      h("p", { class: "stk-ch-lead" }, "Your $TROYA is held by a smart contract on Robinhood Chain, not by Troya. It has no owner and no admin: nobody, the team included, can pause it, change it, take a fee or move your coins. If this website ever goes away, you can still unstake and claim on Blockscout in a few clicks, as shown below."),
      h("dl", { class: "stk-facts" }, facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      flow(),
      h("p", { class: "fine muted stk-ch-cap" }, "Coins waiting out the 3 days earn nothing. The daily share is sent by the creator wallet; the 2x bonus for traders is sent straight from that wallet to yours, outside the contract."),
      h("div", { class: "stk-ch-sub" }, h("h3", {}, "The contract right now"), live, liveNote),
      h("div", { class: "stk-ch-cols" },
        h("details", { class: "stk-ch-d", open }, h("summary", {}, h("span", {}, h("b", {}, "What the contract can't do"), h("small", {}, "no owner, no pause, no upgrade, no fee")), chev()),
          h("ul", { class: "stk-cant" }, cant.map(([k, v, links]) => h("li", {}, icon("check"), h("div", {}, h("b", {}, k), h("span", {}, v), h("span", { class: "stk-evs" }, links)))))),
        h("div", { class: "stk-ch-right" },
        h("details", { class: "stk-ch-d", open }, h("summary", {}, h("span", {}, h("b", {}, "Exit without this website"), h("small", {}, "unstake and claim on Blockscout")), chev()),
          h("ol", { class: "stk-steps" }, steps.map((s) => h("li", {}, h("div", {}, ...s)))),
          h("p", { class: "fine stk-ch-off" }, "None of this goes through troya.codes: Blockscout talks to Robinhood Chain directly, so it works even if this website is offline. Any tool that can call a contract works the same way, for example Foundry's cast (add your own signer, such as --ledger):"),
          cli),
        // always shown, also with the two lists folded on a phone
        h("div", { class: "stk-honest" }, h("b", {}, "What it does not promise"),
          h("ul", {}, h("li", {}, "It has not been audited by an outside firm yet. Its tests are public: run them yourself from the repository."),
            h("li", {}, "The daily ETH is sent by the team. The contract keeps whatever has reached it for you, but it cannot make new rewards arrive."))))));
  }

  function paintLive() {
    const s = get().stats;
    const tile = (k, v, sub) => h("div", { class: "stk-tile" }, h("span", {}, k), h("b", {}, v), sub ? h("small", {}, sub) : null);
    if (!data) {
      clear(live, err ? h("div", { class: "alert error" }, `Couldn't read the contract right now: ${err}`) : [0, 1, 2, 3].map(() => h("div", { class: "sk", style: { height: "86px", borderRadius: "18px" } })));
      clear(liveNote, err ? h("button", { class: "btn sm", type: "button", onclick: () => read(true) }, icon("refresh"), "Try again") : "Reading Robinhood Chain…");
      return;
    }
    const d = data, both = d.staked + d.pending, extra = d.held - both;
    clear(live,
      tile("Total staked", `${tok(d.staked)} $TROYA`, `${d.pending ? `${tok(d.pending)} waiting to leave · ` : ""}contract holds ${tok(d.held)}${extra > 0n ? ` (${tok(extra)} sent straight to it)` : ""}`),
      tile("Stakers", s?.deployed ? String(s.stakers) : "–", "wallets with coins staked, from the contract's events"),
      tile("ETH held for rewards", eth(d.eth), "sent as rewards, not claimed yet"),
      tile("Total rewarded", eth(d.rewarded), `${eth(d.claimed)} claimed so far`));
    clear(liveNote, `Read from Robinhood Chain at ${clock(d.at)}, block ${d.block.toLocaleString("en-US")}, through Troya's RPC relay (the staker count from Troya's index of the contract's events). Check the same numbers yourself: totalStaked, totalRewarded and totalClaimed on `,
      ext(bsWrite, "Blockscout"), ". ",
      h("button", { class: "stk-again", type: "button", disabled: reading, onclick: () => read(true) }, icon("refresh"), reading ? "Reading…" : "Read again"));
  }

  function paintExit() {
    const { me, address } = get();
    const now = Date.now();
    clear(yourWait, me?.pending > 0n ? `Yours: ${tok(me.pending, 4)} $TROYA waiting, ${me.unlockAt * 1000 <= now ? "ready to withdraw now" : `unlocks ${timeOf(me.unlockAt * 1000)} (unlockAt ${me.unlockAt})`}.` : "");
    clear(yourEth, me?.earned > 0n ? `Yours to claim now: ${eth(me.earned)}.` : "");
    if (lc(address) !== who) { who = lc(address); typed = false; }
    else if (helper.contains(document.activeElement)) return;      // someone is typing in the converter: leave it be
    const staked = me?.amount || 0n;
    if (!typed) text = staked > 0n ? rawInput(staked, 18, 18) : "";
    const input = h("input", { class: "input stk-wei-in", inputmode: "decimal", placeholder: "0.0", value: text, "aria-label": "$TROYA to unstake, to turn into wei" });
    const out = h("code", { class: "stk-wei-out" });
    const copy = h("button", { class: "btn sm", type: "button" }, icon("copy"), "Copy");
    const warn = h("small", { class: "stk-wei-warn" });
    const upd = () => {
      const raw = toRaw(input.value, 18);
      const ok = raw != null && raw > 0n;
      out.textContent = ok ? raw.toString() : "–";
      copy.disabled = !ok;
      copy.onclick = () => ok && copyText(raw.toString(), "Amount in wei copied");
      warn.textContent = ok && me && raw > staked ? `More than you have staked (${tok(staked, 4)} $TROYA): requestUnstake would refuse it.` : "";
      paintCli(ok ? raw.toString() : "<amount in wei>");
    };
    input.addEventListener("input", () => { typed = true; text = input.value; upd(); });
    const fill = staked > 0n ? h("button", { class: "btn sm ghost", type: "button", onclick: () => { typed = false; text = rawInput(staked, 18, 18); input.value = text; upd(); } }, "All my staked $TROYA") : null;
    const line = !address ? [h("span", {}, "Connect your wallet here to fill in your staked amount, or type any amount. "), h("button", { class: "stk-again", type: "button", onclick: connect }, icon("wallet"), "Connect wallet")]
      : !me ? "Reading your stake…"
      : staked > 0n ? `Your stake from ${short(address, 4)}: ${tok(staked, 4)} $TROYA, filled in below in full.`
      : me.pending > 0n ? `Nothing left staked from ${short(address, 4)}: your coins are already waiting, so withdraw() is your next step.`
      : `Nothing staked from ${short(address, 4)}. Type any amount to see it in wei.`;
    clear(helper, h("p", { class: "fine stk-wei-l" }, line),
      h("div", { class: "stk-wei-row" }, h("label", { class: "stk-wei-k" }, "$TROYA", input), fill),
      h("div", { class: "stk-wei-row" }, h("span", { class: "stk-wei-k" }, "In wei"), out, copy), warn);
    upd();
  }
  function paintCli(wei) {
    cli.textContent = [`cast send ${C} "requestUnstake(uint256)" ${wei} --rpc-url ${RPC}`,
      `cast send ${C} "withdraw()" --rpc-url ${RPC}`, `cast send ${C} "claim()" --rpc-url ${RPC}`].join("\n");
  }

  async function read(force = false) {
    const { terms } = get();
    if (reading || !terms?.deployed || lc(terms.contract) !== lc(C)) return;
    if (!force && data && Date.now() - data.at < 50_000) return;
    reading = true;
    if (data) paintLive();
    try {
      const p = reader("robinhood");
      const c = (to, iface, fn, args = []) => p.call({ to, data: iface.encodeFunctionData(fn, args) }).then((r) => BigInt(iface.decodeFunctionResult(fn, r)[0]));
      const [block, staked, pending, rewarded, claimed, held, bal] = await Promise.all([p.getBlockNumber(),
        c(C, VIEWS, "totalStaked"), c(C, VIEWS, "totalPending"), c(C, VIEWS, "totalRewarded"), c(C, VIEWS, "totalClaimed"),
        c(terms.token, ERC20, "balanceOf", [C]), p.getBalance(C)]);
      data = { at: Date.now(), block: Number(block), staked, pending, rewarded, claimed, held, eth: BigInt(bal) };
      err = null;
    } catch (e) { err = e?.shortMessage || e?.message || String(e); }
    finally { reading = false; }
    if (built) paintLive();
  }

  function paint() {
    const { terms } = get();
    const ok = !!terms?.deployed && lc(terms.contract) === lc(C) && !!terms.token;
    el.hidden = !ok;
    if (!ok) return;
    if (!built) build(terms);
    paintLive(); paintExit();
    read();
  }
  return { el, paint, read: () => read(false) };
}
