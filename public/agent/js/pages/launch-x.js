// Launch from X (#/launch/x), V6 F26: set up launching a coin by posting on X. The post is read by the server
// (launch.mjs fromX), checked, and the coin is launched on Pons from the poster's Agent Wallet.
// 20 Nov audit: a first post used to take about six separate steps over two pages. Setup is now four steps, and
// "Set up in one go" does every one but the ETH in a single pass: the wallet sign-in, the Agent Wallet, then Sign in with X
// (xsocial.mjs links the account and, coming from this page, switches Launch from X on). The ETH stays a transfer the user
// signs in their own wallet, with the amount worked out for them (the Pons fee + 0.0001, or + an initial buy + 0.0002).
// Trade from X (F29) shares the X link and the Agent Wallet but is not part of launching: it sits folded at the bottom.
// Admins also deploy the TroyaFeeSplitterFactory here and switch Launch on X live.
import { AbiCoder, parseEther } from "ethers";
import { h, clear, icon, toast, short, tiny, num, review, useCss, copyText, ago } from "../ui.js";
import { wallet, onWallet, signIn, signerFor } from "../wallet.js";
import { api } from "../api.js";
import { waitReceipt, errText, balanceOf } from "../chain.js";

const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const EXAMPLE = "@Troyaagent launch Wooden Horse $HORSE";
// Sign in with X for the signed-in wallet: X's own page, then back here (xsocial.mjs, back=launch)
const X_LINK = "/api/x/login?for=link&back=launch";
const MAX_BUY_ETH = 1;   // launch.mjs MAX_INITIAL_BUY_ETH
// What the Agent Wallet must hold, as launch.mjs needEthFor counts it: the Pons fee and 0.0001 ETH, or with an initial buy
// the fee, the buy and 0.0002. Whole micro-ETH, rounded up, so float noise never asks for "0 ETH more".
const micro = (x) => Math.ceil(Number(x) * 1e6 - 1e-6);
const needEth = (fee, buy = 0) => micro(Number(fee) + (buy > 0 ? buy + 0.0002 : 0.0001)) / 1e6;
const topUp = (need, have) => Math.max(0, micro(need - (have || 0))) / 1e6;
const ethText = (x) => Number(x).toFixed(6).replace(/\.?0+$/, "");
const CUSTODIAL = "Custodial: the operator stores the Agent Wallet's key, encrypted. Keep only what you are willing to lose in it. Withdrawals only go back to your own wallet.";

export async function mount(view, ctx) {
  useCss("launch");
  let alive = true;
  const st = { rules: null, prefs: null, aw: null, bal: null, mine: null, err: null, busy: false, busyKey: null, leaving: false, factory: null, held: {}, buy: 0, tradeOpen: false };
  const body = h("div", { class: "lx" });
  clear(view,
    h("a", { class: "lc-back link", href: "#/create" }, "← Create coin"),
    h("header", { class: "page-head lc-head" }, h("h1", {}, "Launch from X"),
      h("p", {}, "Post on X and the coin goes live on Pons from your Agent Wallet. Open to everyone: one launch a day, or as many as you like with 1,000,000 $TROYA, which also keeps the whole creator fee for you. ", h("a", { class: "link", href: "/launch-on-x", target: "_blank", rel: "noopener" }, "Read the full guide"))),
    body);
  // back from X's sign-in page: say what happened, here where it started
  const X_BACK = { linked: ["X account linked. Launch from X is on; you can switch it off any time.", "ok"], cancelled: ["X sign-in was cancelled. Press Sign in with X to try again.", "warn"], expired: ["The X sign-in took too long. Press Sign in with X to try again.", "warn"],
    busy: ["X is busy right now. Try again in a few minutes.", "warn"], failed: ["X sign-in didn't go through. Try again in a minute.", "error"], signin: ["Sign in with your wallet first. Sign in with X below does both.", "warn"] };
  const back = ctx.query.x;
  if (X_BACK[back]) {
    toast(X_BACK[back][0], X_BACK[back][1], 7000);
    // said once: a reload must not say it again, nor switch Launch from X back on after the user switched it off
    try { history.replaceState(null, "", "#/launch/x"); } catch {}
  }
  // linked from this page: xsocial.mjs switched Launch from X on with the link. If that write failed, it is done here, once
  let ensureOn = back === "linked";

  async function load() {
    st.err = null;
    const rules = api.get("launch/rules").catch(() => st.rules);
    if (wallet.session) {
      const [p, aw, mine] = await Promise.all([
        api.get("launch/prefs").catch((e) => { st.err = errText(e); return null; }),
        api.get("agent-wallet").catch(() => null),
        api.get("launch/mine").catch(() => null),
      ]);
      if (p && ensureOn) {
        ensureOn = false;
        if (p.xAccount && !p.x) { const r = await api.post("launch/prefs", { x: true }).catch(() => null); if (r) p.x = !!r.x; }
      }
      st.prefs = p; st.aw = aw; st.mine = mine?.launches || [];
      st.bal = aw?.exists ? await api.get("agent-wallet/balances").catch(() => null) : null;
      // what the Agent Wallet still holds of each coin it launched (the initial buy), so it can be sold from here
      st.held = {};
      if (aw?.exists) for (const x of st.mine.filter((m) => String(m.wallet || "").toLowerCase() === aw.address.toLowerCase()).slice(0, 20)) {
        const b = await balanceOf(aw.address, { address: x.token, decimals: 18 }).catch(() => null);
        if (b) st.held[x.token.toLowerCase()] = b.amount;
      }
      if (p?.admin) st.factory = await api.get("launch/splitter").catch(() => null);
    } else { st.prefs = null; st.aw = null; st.mine = null; st.bal = null; }
    st.rules = await rules;
    if (alive) paint();
  }

  // label: what the busy button says meanwhile; key: which button that is
  const run = (label, fn, key = null) => async () => {
    if (st.busy) return;
    st.busy = label; st.busyKey = key; paint();
    try { await fn(); } catch (e) { toast(errText(e), "error", 6000); }
    finally {
      // on the way to X's sign-in page: the button keeps saying so until the page goes
      if (!st.leaving) { st.busy = false; st.busyKey = null; await load(); }
    }
  };
  const act = (key, text, busyText, fn, cls = "btn") => h("button", { class: cls, type: "button", disabled: !!st.busy, onclick: run(busyText, fn, key) }, st.busyKey === key ? st.busy : text);

  async function toX() {
    const me = await api.get("x/me").catch(() => null);
    if (me && me.configured === false) throw new Error("Sign in with X isn't available on this server right now. Try again later.");
    st.leaving = true; st.busy = "Opening X…"; paint();
    location.assign(X_LINK);
  }
  // one step: the wallet signs in (connecting first when needed: one signature, no transaction), then X links the account
  async function signInWithX() {
    if (!wallet.session) await signIn();
    if (!wallet.session) return;
    const p = await api.get("launch/prefs");
    if (p.xAccount) { toast(`Signed in. @${p.xAccount.username} is already linked to this wallet.`, "ok", 6000); return; }
    await toX();
  }
  // every step but the ETH, in one pass: sign-in, the Agent Wallet, the switch, and Sign in with X last (it leaves the page)
  async function setUpAll() {
    if (!wallet.session) await signIn();
    if (!wallet.session) return;
    const [p, aw] = await Promise.all([api.get("launch/prefs"), api.get("agent-wallet")]);
    const awOn = !!(aw?.exists && aw.enabled !== false);
    const rows = [];
    if (!aw?.exists) rows.push(["Agent Wallet", "Created for you"]);
    else if (!awOn) rows.push(["Agent Wallet", `${short(aw.address)} switched back on`]);
    if (!p.xAccount) rows.push(["X account", "Linked on X's own page, then back here"]);
    if (!p.x) rows.push(["Launch from X", p.xAccount ? "Switched on" : "Switched on with the X link"]);
    if (!rows.length) { toast("Everything is set up already. Only the ETH is left if it is short.", "ok", 6000); return; }
    const ok = await review({ title: "Set up Launch from X", summary: "Troya does these now. Nothing is sent from your wallet, and you can switch Launch from X off any time.",
      rows, warn: aw?.exists ? null : CUSTODIAL, confirmLabel: p.xAccount ? "Set it up" : "Set up and go to X" });
    if (!ok) return;
    if (!aw?.exists) await api.post("agent-wallet/create");
    else if (!awOn) await api.post("agent-wallet/settings", { enabled: true });
    if (p.xAccount) {
      if (!p.x) await api.post("launch/prefs", { x: true });
      toast("Set up. Add the ETH and you are ready.", "ok", 6000);
      return;
    }
    await toX();
  }
  // the ETH: a plain transfer the user signs, from their own wallet to their Agent Wallet
  async function addEth(amount, buy) {
    const aw = st.aw;
    if (!aw?.exists || !(amount > 0)) return;
    const ok = await review({ title: "Add ETH to your Agent Wallet", summary: "A plain ETH transfer on Robinhood Chain from your wallet to your Agent Wallet. You can withdraw it back any time.",
      rows: [["From", short(wallet.address, 6)], ["To (Agent Wallet)", short(aw.address, 6)], ["Amount", `${ethText(amount)} ETH`],
        ["For", buy > 0 ? `a launch with a ${ethText(buy)} ETH initial buy` : "one launch (the Pons fee)"], ["Network", "Robinhood Chain"]], confirmLabel: "Continue in wallet" });
    if (!ok) return;
    st.busy = "Waiting for your wallet…"; paint();
    const signer = await signerFor("robinhood");
    // the hash as soon as the wallet sends it; the receipt is then watched through Troya's relay (chain.js sendTx)
    const hash = await signer.sendUncheckedTransaction({ to: aw.address, value: parseEther(ethText(amount)) });
    st.busy = "Confirming…"; paint();
    const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
    if (rc?.status !== 1) throw new Error("The transfer failed on chain.");
    toast(`Added ${ethText(amount)} ETH to your Agent Wallet.`, "ok", 6000);
  }

  function step(n, done, title, detail, action, extra = null) {
    return h("li", { class: `lx-step${done ? " done" : ""}` },
      h("span", { class: "lx-n", "aria-hidden": "true" }, done ? icon("check") : String(n)),
      h("div", {}, h("b", {}, title), detail ? h("p", { class: "muted" }, detail) : null, extra),
      action || null);
  }

  // step 4's amount, worked out for the user: what is missing for one launch, or for the initial buy they mean to post.
  // Typing a buy updates the line and the button in place (a repaint would take the focus out of the field). One button
  // that is either "Add … ETH" or "Open", since the steps' narrow layout only places a single button child.
  function fundParts(fee, eth) {
    const line = h("p", { class: "muted" });
    const go = h("button", { type: "button" });
    let add = 0;
    const buyIn = h("input", { class: "input", type: "number", min: "0", max: String(MAX_BUY_ETH), step: "any", inputmode: "decimal", placeholder: "0", value: st.buy > 0 ? String(st.buy) : "",
      style: { width: "96px" }, "aria-label": "Initial buy you plan to post, in ETH", oninput: () => { const v = Number(buyIn.value); st.buy = v > 0 ? v : 0; sync(); } });
    const sync = () => {
      const b = st.buy, tooBig = b > MAX_BUY_ETH, need = needEth(fee, tooBig ? 0 : b);
      add = eth == null || tooBig ? 0 : topUp(need, eth);
      line.textContent = tooBig ? `The initial buy can be up to ${MAX_BUY_ETH} ETH.`
        : eth == null ? "The Agent Wallet's balance can't be read right now. Open it to add ETH."
        : b > 0 ? `A launch with a ${ethText(b)} ETH initial buy needs ${ethText(need)} ETH: the fee, the buy and 0.0002.${add > 0 ? ` Add ${ethText(add)} ETH.` : " It holds enough."}`
        : add > 0 ? `Add ${ethText(add)} ETH for your first launch.` : "Enough for a launch.";
      go.className = add > 0 ? "btn primary" : "btn";
      go.textContent = st.busyKey === "fund" ? st.busy : add > 0 ? `Add ${ethText(add)} ETH` : "Open";
      go.disabled = !!st.busy;
    };
    go.addEventListener("click", () => {
      if (!(add > 0)) { location.hash = "#/agent/wallet"; return; }
      const b = st.buy;
      run("Adding ETH…", () => addEth(topUp(needEth(fee, b), eth), b), "fund")();
    });
    sync();
    const extra = h("div", { style: { display: "grid", gap: "6px", marginTop: "8px" } }, line,
      h("label", { class: "row", style: { flexWrap: "wrap", fontSize: "13px" } }, h("span", { class: "muted" }, "Initial buy you plan to post (optional)"), buyIn, h("span", { class: "muted" }, "ETH")),
      h("p", { class: "muted" }, "No ETH on Robinhood Chain yet? ", h("a", { class: "link", href: "#/bridge?dir=in" }, "Bridge it in"), "."));
    return { extra, action: go };
  }

  function paint() {
    const p = st.prefs, r = st.rules;
    const ethRaw = st.bal?.robinhoodEth ?? st.bal?.balances?.find((b) => b.address === "native")?.amount ?? null;   // /api/agent-wallet/balances → robinhoodEth
    const eth = ethRaw == null ? null : Number(ethRaw);
    const fee = p?.launchFeeEth ?? null;
    const signed = !!wallet.session;
    const xIn = signed && !!p?.xAccount;
    const awOn = !!(st.aw?.exists && st.aw.enabled !== false);
    const need = fee != null ? needEth(fee) : null;
    const funded = !!st.aw?.exists && need != null && eth != null && topUp(need, eth) === 0;
    const fund = signed && st.aw?.exists && fee != null ? fundParts(fee, eth) : null;
    const holderMin = p?.holderMin || r?.holderMin || 1_000_000;
    const steps = [
      step(1, xIn, "Sign in with X",
        xIn ? `@${p.xAccount.username}, linked to ${short(wallet.address)}. Only posts from this X account can launch for your wallet.`
          : signed ? `Signed in as ${short(wallet.address)}. Now link your X account: only posts from it can launch for your wallet.`
          : "Your wallet signs once (no transaction), then X asks you to approve. Only posts from that X account can launch for your wallet.",
        xIn ? null : act("x", "Sign in with X", "Signing in…", signInWithX)),
      step(2, awOn, "Create your Agent Wallet",
        st.aw?.exists ? (awOn ? `${short(st.aw.address)}, a wallet of its own that sends your launches from X. Caps per trade and per day apply to everything it does.` : `${short(st.aw.address)} is switched off, so it can't launch. Switch it on, or open it to change its caps.`)
          : `A separate wallet that sends your launches from X and pays the Pons fee. ${CUSTODIAL}`,
        !signed ? null : !st.aw?.exists ? act("aw", "Create", "Creating…", () => api.post("agent-wallet/create"))
          : !awOn ? act("aw", "Switch on", "Switching on…", () => api.post("agent-wallet/settings", { enabled: true }))
          : h("a", { class: "btn", href: "#/agent/wallet" }, "Open")),
      step(3, !!p?.x, "Switch Launch from X on",
        p?.x ? "On, switch off any time. Posts from your linked X account can launch coins from your Agent Wallet."
          : "Off, so nobody can launch for you by surprise. Sign in with X from this page switches it on.",
        p ? act("on", p.x ? "Switch off" : "Switch on", p.x ? "Switching off…" : "Switching on…", () => api.post("launch/prefs", { x: !p.x })) : null),
      step(4, funded, "Add a little ETH to it",
        st.aw?.exists ? `${short(st.aw.address)} holds ${eth != null ? `${tiny(eth)} ETH` : "…"} on Robinhood Chain. A launch takes ${need != null ? `${ethText(need)} ETH: the Pons fee (${tiny(fee)}) and 0.0001` : "the Pons fee and 0.0001 ETH"}; Troya pays the gas.`
          : `It pays the Pons launch fee${fee != null ? ` (${tiny(fee)} ETH)` : ""} for each coin; Troya pays the gas. Your Agent Wallet is separate from your own wallet.`,
        fund ? fund.action : signed && st.aw?.exists ? h("a", { class: "btn", href: "#/agent/wallet" }, "Open") : null, fund?.extra),
      step(5, !!p?.holder?.holder, `Optional: hold ${num(holderMin, 0)} $TROYA`,
        p ? `This wallet and its Agent Wallet hold ${num(p.holder?.balance || 0, 0)} $TROYA. ${p.holder?.holder ? "No daily limit, and the whole creator fee is yours." : "Without 1M: one launch from X a day, and you keep 0.6% of volume (Troya 0.1%)."}` : "No daily limit and the whole creator fee. Without it: one launch from X a day.",
        p && !p.holder?.holder ? h("a", { class: "btn", href: `#/swap?out=${TROYA}` }, "Get $TROYA") : null),
    ];
    // "Set up in one go" until everything it can do is done; the ETH is the user's own transfer, in step 4
    const oneGo = !(xIn && awOn && p?.x) ? h("div", { class: "row", style: { flexWrap: "wrap", gap: "12px" } },
      act("all", "Set up in one go", "Setting up…", setUpAll, "btn primary"),
      h("span", { class: "muted", style: { flex: "1 1 220px", fontSize: "13px" } }, "Signs you in with your wallet and X, creates your Agent Wallet and switches Launch from X on. Then only the ETH is left.")) : null;
    const ready = xIn && awOn && p?.x && funded;
    const lm = p?.xLaunchMode || r?.xLaunchMode || null;
    clear(body,
      lm && lm !== "live" ? h("div", { class: "alert warn" }, lm === "test" ? "Launch on X is in its real-money test: only Troya's own wallets can launch from X right now. You can set everything up." : "Launch on X opens after its real-money test. You can set everything up now.") : null,
      st.err ? h("div", { class: "alert error" }, st.err) : null,
      h("div", { class: "lc-grid" },
        h("section", { class: "panel lx-panel" }, h("h2", {}, "Set up"), oneGo, h("ol", { class: "lx-steps" }, steps),
          ready ? h("div", { class: "alert ok" }, "Ready. Post the launch on X with the image attached.")
            : xIn && awOn && p?.x && st.aw?.exists ? h("p", { class: "muted" }, "Only the ETH is left: step 4.") : null),
        h("aside", { class: "panel lx-panel" },
          h("h2", {}, "Post it like this"),
          h("div", { class: "lx-tweet" }, h("span", { class: "mono" }, EXAMPLE), h("button", { class: "btn sm", type: "button", onclick: () => copyText(EXAMPLE, "Copied") }, icon("copy"), "Copy")),
          h("p", { class: "muted" }, "Attach the coin's image to the post. That alone is a clean launch: 0% tax and no initial buy. Add \"tax 2%\" for a creator tax and \"buy 0.01\" for an initial buy, only if you want them."),
          h("ul", { class: "lx-rules" },
            h("li", {}, "Attach the image: square (1:1) works best, since every site shows coin logos in a square or circle and crops other shapes to the middle. PNG or JPEG; GIFs turn into video on X and don't work. Without an image, the coin launches with none, for good."),
            h("li", {}, "Creator tax from 0% to 4%, all of it yours."),
            h("li", {}, "Initial buy: your Agent Wallet buys right after the 3-second Pons snipe tax, through Troya Gate and within its caps. If it cannot pay the launch fee plus the buy, nothing is launched."),
            h("li", {}, "Creator fee: holders of 1M $TROYA keep all of it (0.7% of trading volume plus the tax). Everyone else keeps 0.6% plus the whole tax, and Troya takes 0.1%."),
            h("li", {}, `Holders: no daily limit. Without 1M $TROYA: ${p?.limits?.perDayX ?? r?.limits?.perDayX ?? 1} launch from X a day (${p?.limits?.perDay ?? r?.limits?.perDay ?? 3} a day across X, Telegram and troya.codes).`),
            h("li", {}, "Troya sees your post within seconds and replies with the coin's address and market cap, or with what to fix if it could not launch."),
            h("li", {}, "Your own words work too, in English: \"please create a token called Moon Cat, ticker MCAT, 2% tax, buy 0.01 ETH\". If Troya is unsure, it shows you the format instead of guessing."),
            h("li", {}, "Any name and ticker you like: the ticker is letters and numbers (16 at most), the name up to 48 characters.")))),
      mineCard(),
      tradeCard(),
      p?.admin ? adminCard() : null);
  }

  function mineCard() {
    if (!st.mine) return null;
    const rows = st.mine.length ? st.mine.map((x) => h("div", { class: "lx-coin" },
      h("div", {}, h("b", {}, x.symbol ? `$${x.symbol}` : short(x.token)), h("span", { class: "muted" }, ` ${x.name || ""}`)),
      h("span", { class: "muted" }, `${x.source === "x" ? "X" : x.source === "tg" ? "Telegram" : "Web"} · ${ago(x.at)} · ${x.split ? "Troya 0.1% of volume" : "creator fee 100% yours"}`),
      h("a", { class: "link", href: `#/token/${String(x.token).toLowerCase()}` }, "Open"),
      sellRow(x))) : [h("p", { class: "muted" }, "No coins launched through Troya from this wallet yet.")];
    return h("section", { class: "panel lx-panel" }, h("h2", {}, "Your launches"),
      st.mine.length ? h("p", { class: "muted" }, "Coins from your initial buy sit in your Agent Wallet. Sell them here: the sale runs through Troya Gate and your Agent Wallet caps, and the ETH stays in the Agent Wallet. Creator fees are claimed on the ", h("a", { class: "link", href: "#/creator" }, "Creator desk"), ".") : null, rows);
  }
  // sell part or all of what the Agent Wallet holds of a coin it launched
  function sellRow(x) {
    const held = st.held[String(x.token).toLowerCase()];
    if (!(held > 0)) return null;
    const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2));
    return h("div", { class: "lx-sell" }, h("span", { class: "muted" }, `Agent Wallet holds ${fmt(held)} ${x.symbol ? "$" + x.symbol : ""}`),
      [25, 50, 100].map((pct) => h("button", { class: "btn sm", type: "button", disabled: !!st.busy, onclick: run(`Selling ${pct}%…`, async () => {
        const amount = pct === 100 ? Math.floor(held * 1e6) / 1e6 : Math.floor(held * pct * 1e4) / 1e6;
        const ok = await review({ title: `Sell ${pct}% of ${x.symbol ? "$" + x.symbol : "this coin"}`, summary: "From your Agent Wallet, through Troya Gate and within its caps. The ETH stays in the Agent Wallet.",
          rows: [["Coin", x.symbol ? `$${x.symbol}` : short(x.token)], ["Amount", `${fmt(amount)} (${pct}%)`], ["You get", "ETH, after the 1% fee and any creator tax"], ["Slippage limit", "5%"]], confirmLabel: `Sell ${pct}%` });
        if (!ok) return;
        const r = await api.post("agent-wallet/execute", { kind: "swap", params: { tokenIn: x.token, tokenOut: "ETH", amountIn: amount, slippagePct: 5 } });
        if (r.executed) toast(`Sold ${pct}% of ${x.symbol ? "$" + x.symbol : "the coin"}.`, "ok", 6000);
        else throw new Error((r.reasons || [])[0] || "The sale was not sent.");
      }) }, `Sell ${pct}%`)));
  }

  // V6 F29 · Trade from X: buy or sell by posting, from the Agent Wallet, through Troya Gate. Not part of launching, so it is
  // folded (closed until opened, and kept open across repaints). Its status is the public mode from /api/launch/rules, so a
  // signed-out visitor no longer reads "Opens after its real-money test" whatever the real mode is.
  function tradeCard() {
    const p = st.prefs;
    const mode = st.rules?.xTradeMode || p?.xTradeMode || null;
    const status = { off: "Opens after its real-money test. You can switch it on now.", test: "In its real-money test: only Troya's own wallets can trade from X right now.",
      holders: "Open to holders of 1,000,000 $TROYA first.", live: "Open to everyone for $TROYA; holders of 1,000,000 $TROYA can trade any coin." }[mode] || "";
    const tag = { off: "opens after its test", test: "in its real-money test", holders: "open to 1M $TROYA holders", live: p?.trade ? "on" : "open" }[mode] || "";
    const BUY = "@Troyaagent buy 0.01 $TROYA", SELL = "@Troyaagent sell 50% $TROYA";
    const ex = (t) => h("div", { class: "lx-tweet" }, h("span", { class: "mono" }, t), h("button", { class: "link", type: "button", onclick: () => copyText(t, "Copied") }, "Copy"));
    return h("details", { class: "lc-fold", open: st.tradeOpen, ontoggle: (e) => { st.tradeOpen = e.currentTarget.open; } },
      h("summary", {}, h("span", {}, "Trade from X", tag ? h("span", { class: "muted" }, ` · ${tag}`) : null)),
      h("div", { class: "lc-fold-b" },
        h("p", { class: "muted" }, `Post a buy or a sell and your Agent Wallet trades it. ${status}`),
        ex(BUY), ex(SELL),
        h("ul", { class: "lx-rules" },
          h("li", {}, "Also: \"buy 0.01 ETH of 0x…\", \"sell all $TICKER\", \"sell half of 0x…\". The post has to start with buy or sell; a question is never a trade."),
          h("li", {}, "Every trade runs through Troya Gate and your Agent Wallet caps, like a trade in the app. Buys from 0.0005 to 0.5 ETH a post."),
          h("li", {}, "Everyone can buy and sell $TROYA this way. With 1,000,000 $TROYA (wallet plus Agent Wallet) you can trade any coin on Robinhood Chain from X."),
          h("li", {}, "$TROYA always means the official contract. For other coins, when several share a ticker, Troya asks for the contract address instead of guessing."),
          h("li", {}, "The ETH from a sale stays in your Agent Wallet. Troya replies in seconds with what it did, or with what to fix."),
          h("li", {}, "Uses the same linked X account and Agent Wallet as Launch from X.")),
        p ? h("div", {}, act("trade", p.trade ? "Switch Trade from X off" : "Switch Trade from X on", p.trade ? "Switching off…" : "Switching on…", () => api.post("launch/prefs", { trade: !p.trade }), `btn${p.trade ? "" : " primary"}`))
          : h("p", { class: "muted" }, "Sign in with X above, then switch it on here.")));
  }

  function adminCard() {
    const f = st.factory, p = st.prefs;
    const card = h("section", { class: "panel lx-panel" }, h("h2", {}, "Admin"));
    const mode = p.xLaunchMode || "off";
    const label = { off: "Off: posts get a not-open-yet reply.", test: "Test: only admin wallets can launch from X.", live: "Live: everyone who set it up can launch from X (once a day without 1M $TROYA)." }[mode];
    card.append(h("div", { class: "lx-coin" }, h("b", {}, "Launch on X"), h("span", { class: "muted" }, label),
      h("span", { style: { display: "inline-flex", gap: "6px" } }, ["off", "test", "live"].map((m) => h("button", { class: `btn${m === mode ? " primary" : ""}`, type: "button", disabled: !!st.busy || m === mode,
        onclick: run("Saving…", () => api.post("x/launch", { launch: m })) }, m[0].toUpperCase() + m.slice(1))))));
    const xm = p.xTradeMode || "off";
    const xl = { off: "Off: buy/sell posts get a not-open-yet reply.", test: "Test: only admin wallets can trade from X.", holders: "Holders: wallets with 1M $TROYA can trade from X.", live: "Live: everyone can trade $TROYA from X; holders of 1M $TROYA can trade any coin." }[xm];
    card.append(h("div", { class: "lx-coin" }, h("b", {}, "Trade on X"), h("span", { class: "muted" }, xl),
      h("span", { style: { display: "inline-flex", gap: "6px", flexWrap: "wrap" } }, ["off", "test", "holders", "live"].map((m) => h("button", { class: `btn${m === xm ? " primary" : ""}`, type: "button", disabled: !!st.busy || m === xm,
        onclick: run("Saving…", () => api.post("x/trade", { trade: m })) }, m[0].toUpperCase() + m.slice(1))))));
    const tm = p.tgLaunchMode || "off";
    const tl = { off: "Off: /launch gets a not-open-yet reply.", test: "Test: only admin wallets can launch in Telegram.", live: "Live: everyone with a linked chat and an Agent Wallet can launch." }[tm];
    card.append(h("div", { class: "lx-coin" }, h("b", {}, "Launch in Telegram"), h("span", { class: "muted" }, tl),
      h("span", { style: { display: "inline-flex", gap: "6px" } }, ["off", "test", "live"].map((m) => h("button", { class: `btn${m === tm ? " primary" : ""}`, type: "button", disabled: !!st.busy || m === tm,
        onclick: run("Saving…", () => api.post("launch/tg", { mode: m })) }, m[0].toUpperCase() + m.slice(1))))));
    if (f?.factory) {
      card.append(h("p", { class: "muted" }, "Fee splitter factory ", h("a", { class: "mono link", href: `https://robinhoodchain.blockscout.com/address/${f.factory}`, target: "_blank", rel: "noopener" }, short(f.factory, 6)), " is live. Non-holder launches pay Troya 0.1% of volume through it."));
      return card;
    }
    const tIn = h("input", { class: "input mono", value: wallet.address || "", "aria-label": "Treasury for Troya's share", placeholder: "0x… treasury" });
    card.append(
      h("p", { class: "muted" }, "Not deployed yet: until it is, every launch sends the whole creator fee to its creator. Deploy it from an admin wallet; Troya's 0.1% goes to the treasury below (it can be changed later, a creator's share never can)."),
      h("label", { class: "field" }, h("span", {}, "Treasury"), tIn),
      h("button", { class: "btn primary", type: "button", disabled: !!st.busy, onclick: run("Deploying…", async () => {
        const treasury = tIn.value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error("Enter the treasury address.");
        const b = await api.get("launch/splitter");
        const ok = await review({ title: "Deploy the Troya fee splitter factory", summary: "Creates one splitter per non-holder coin: 0.1% of volume to Troya, the rest to the creator, fixed forever.",
          rows: [["Pons fee escrow", short(b.escrow, 6)], ["Treasury", short(treasury, 6)], ["Owner (treasury changes only)", short(wallet.address, 6)], ["Tests", "11 unit + 2 Robinhood Chain fork tests passed"], ["Gas", "about 1.6M gas"]],
          confirmLabel: "Continue in wallet" });
        if (!ok) return;
        const data = b.bytecode + AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [b.escrow, treasury, wallet.address]).slice(2);
        const signer = await signerFor("robinhood");
        const hash = await signer.sendUncheckedTransaction({ data });
        const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
        if (rc?.status !== 1) throw new Error("The deployment failed on chain.");
        await api.post("launch/splitter/register", { hash });
        toast("The fee splitter factory is live.", "ok", 7000);
      }) }, st.busy || "Deploy the factory"));
    return card;
  }

  // the browser's Back button from X's page can bring this page back from the back-forward cache still "Opening X…"
  const onShow = (e) => { if (e.persisted && st.leaving) { st.leaving = false; st.busy = false; st.busyKey = null; load(); } };
  addEventListener("pageshow", onShow);
  paint();
  load();
  const off = onWallet(() => load());
  return () => { alive = false; off(); removeEventListener("pageshow", onShow); };
}
