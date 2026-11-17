// Launch from X (#/launch/x), V6 F26: set up launching a coin by posting on X. The post is read by the server
// (launch.mjs fromX), checked, and the coin is launched on Pons from the poster's Agent Wallet.
// Admins also deploy the TroyaFeeSplitterFactory here and switch Launch on X live.
import { AbiCoder } from "ethers";
import { h, clear, icon, toast, short, tiny, num, review, useCss, copyText, ago } from "../ui.js";
import { wallet, onWallet, openConnect, signIn, signerFor } from "../wallet.js";
import { api } from "../api.js";
import { waitReceipt, errText, balanceOf } from "../chain.js";

const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
const EXAMPLE = "@Troyaagent launch Wooden Horse $HORSE";

export async function mount(view, ctx) {
  useCss("launch");
  let alive = true;
  const st = { prefs: null, aw: null, bal: null, mine: null, err: null, busy: false, factory: null, held: {} };
  const body = h("div", { class: "lx" });
  clear(view,
    h("a", { class: "lc-back link", href: "#/launch" }, "← Launchpad"),
    h("header", { class: "page-head lc-head" }, h("h1", {}, "Launch from X"),
      h("p", {}, "Post on X and the coin goes live on Pons from your Agent Wallet. Open to everyone: one launch a day, or as many as you like with 1,000,000 $TROYA, which also keeps the whole creator fee for you. ", h("a", { class: "link", href: "/launch-on-x", target: "_blank", rel: "noopener" }, "Read the full guide"))),
    body);
  if (ctx.query.x === "linked") toast("X account linked.", "ok");

  async function load() {
    st.err = null;
    if (wallet.session) {
      const [p, aw, mine] = await Promise.all([
        api.get("launch/prefs").catch((e) => { st.err = errText(e); return null; }),
        api.get("agent-wallet").catch(() => null),
        api.get("launch/mine").catch(() => null),
      ]);
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
    if (alive) paint();
  }

  const run = (label, fn) => async () => {
    if (st.busy) return;
    st.busy = label; paint();
    try { await fn(); } catch (e) { toast(errText(e), "error", 6000); }
    finally { st.busy = false; await load(); }
  };

  function step(n, done, title, detail, action) {
    return h("li", { class: `lx-step${done ? " done" : ""}` },
      h("span", { class: "lx-n", "aria-hidden": "true" }, done ? icon("check") : String(n)),
      h("div", {}, h("b", {}, title), detail ? h("p", { class: "muted" }, detail) : null),
      action || null);
  }

  function paint() {
    const p = st.prefs;
    const eth = st.bal?.robinhoodEth ?? st.bal?.balances?.find((b) => b.address === "native")?.amount ?? null;   // /api/agent-wallet/balances → robinhoodEth
    const fee = p?.launchFeeEth ?? null;
    const steps = [
      step(1, !!wallet.address, "Connect your wallet", wallet.address ? short(wallet.address) : "The wallet that holds your $TROYA.",
        wallet.address ? null : h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect")),
      step(2, !!wallet.session, "Sign in", wallet.session ? "Signed in." : "One signature, no transaction.",
        wallet.address && !wallet.session ? h("button", { class: "btn primary", type: "button", onclick: async () => { try { await signIn(); load(); } catch (e) { toast(errText(e), "error"); } } }, "Sign in") : null),
      step(3, !!p?.xAccount, "Link your X account", p?.xAccount ? `@${p.xAccount.username}. Only posts from this account can launch for your wallet.` : "Troya only acts on posts from the X account linked to your wallet.",
        wallet.session && !p?.xAccount ? h("a", { class: "btn primary", href: "/api/x/login?for=link&back=launch" }, "Link X") : null),
      step(4, !!(st.aw?.exists && eth != null && fee != null && eth > fee), "Agent Wallet with a little ETH",
        st.aw?.exists ? `${short(st.aw.address)} · ${eth != null ? `${tiny(eth)} ETH` : "…"} on Robinhood Chain. It pays the Pons launch fee${fee != null ? ` (${tiny(fee)} ETH)` : ""}; Troya pays the gas.` : "Launches from X are sent by your Agent Wallet, never by your main wallet.",
        wallet.session ? h("a", { class: "btn", href: "#/agent/wallet" }, st.aw?.exists ? "Open" : "Create") : null),
      step(5, !!p?.holder?.holder, `Optional: hold ${num(p?.holderMin || 1_000_000, 0)} $TROYA`,
        p ? `This wallet and its Agent Wallet hold ${num(p.holder?.balance || 0, 0)} $TROYA. ${p.holder?.holder ? "No daily limit, and the whole creator fee is yours." : "Without 1M: one launch from X a day, and you keep 0.6% of volume (Troya 0.1%)."}` : "No daily limit and the whole creator fee. Without it: one launch from X a day.",
        p && !p.holder?.holder ? h("a", { class: "btn", href: `#/swap?out=${TROYA}` }, "Get $TROYA") : null),
      step(6, !!p?.x, "Switch Launch from X on", p?.x ? "On. Posts from your linked X account can launch coins from your Agent Wallet." : "Off until you switch it on, so nobody can launch for you by surprise.",
        p ? h("button", { class: `btn${p.x ? "" : " primary"}`, type: "button", disabled: !!st.busy, onclick: run(p.x ? "Switching off…" : "Switching on…", () => api.post("launch/prefs", { x: !p.x })) }, p.x ? "Switch off" : "Switch on") : null),
    ];
    const ready = p && p.xAccount && p.x && st.aw?.exists;
    clear(body,
      p && p.xLaunchMode !== "live" ? h("div", { class: "alert warn" }, p.xLaunchMode === "test" ? "Launch on X is in its real-money test: only Troya's own wallets can launch from X right now. You can set everything up." : "Launch on X opens after its real-money test. You can set everything up now.") : null,
      st.err ? h("div", { class: "alert error" }, st.err) : null,
      h("div", { class: "lc-grid" },
        h("section", { class: "panel lx-panel" }, h("h2", {}, "Set up"), h("ol", { class: "lx-steps" }, steps),
          ready ? h("div", { class: "alert ok" }, "Ready. Post the launch on X with the image attached.") : null),
        h("aside", { class: "panel lx-panel" },
          h("h2", {}, "Post it like this"),
          h("div", { class: "lx-tweet" }, h("span", { class: "mono" }, EXAMPLE), h("button", { class: "link", type: "button", onclick: () => copyText(EXAMPLE, "Copied") }, "Copy")),
          h("p", { class: "muted" }, "Attach the coin's image to the post. Add \"tax 2%\" for a creator tax and \"buy 0.01\" for an initial buy."),
          h("ul", { class: "lx-rules" },
            h("li", {}, "Attach the image: square (1:1) works best, since every site shows coin logos in a square or circle and crops other shapes to the middle. PNG or JPEG up to 5 MB (X's own limit); GIFs turn into video on X and don't work. Without an image, the coin launches with none, for good."),
            h("li", {}, "Creator tax from 0% to 4%, all of it yours."),
            h("li", {}, "Initial buy: your Agent Wallet buys right after the 3-second Pons snipe tax, through Troya Gate and within its caps. If it cannot pay the launch fee plus the buy, nothing is launched."),
            h("li", {}, "Creator fee: holders of 1M $TROYA keep all of it (0.7% of trading volume plus the tax). Everyone else keeps 0.6% plus the whole tax, and Troya takes 0.1%."),
            h("li", {}, `Holders: no daily limit. Without 1M $TROYA: ${p?.limits?.perDayX ?? 1} launch from X a day (${p?.limits?.perDay ?? 3} a day across X, Telegram and troya.codes).`),
            h("li", {}, "Troya sees your post within seconds and replies with the coin's address and market cap, or with what to fix if it could not launch."),
            h("li", {}, "Your own words work too, in English: \"please create a token called Moon Cat, ticker MCAT, 2% tax, buy 0.01 ETH\". If Troya is unsure, it shows you the format instead of guessing."),
            h("li", {}, "Tickers and names that copy ETH, BTC, USDG, stock tokens, big coins or Troya are refused.")))),
      mineCard(),
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
      st.mine.length ? h("p", { class: "muted" }, "Coins from your initial buy sit in your Agent Wallet. Sell them here: the sale runs through Troya Gate and your Agent Wallet caps, and the ETH stays in the Agent Wallet.") : null, rows);
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

  function adminCard() {
    const f = st.factory, p = st.prefs;
    const card = h("section", { class: "panel lx-panel" }, h("h2", {}, "Admin"));
    const mode = p.xLaunchMode || "off";
    const label = { off: "Off: posts get a not-open-yet reply.", test: "Test: only admin wallets can launch from X.", live: "Live: every holder who set it up can launch from X." }[mode];
    card.append(h("div", { class: "lx-coin" }, h("b", {}, "Launch on X"), h("span", { class: "muted" }, label),
      h("span", { style: { display: "inline-flex", gap: "6px" } }, ["off", "test", "live"].map((m) => h("button", { class: `btn${m === mode ? " primary" : ""}`, type: "button", disabled: !!st.busy || m === mode,
        onclick: run("Saving…", () => api.post("x/launch", { launch: m })) }, m[0].toUpperCase() + m.slice(1))))));
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

  paint();
  load();
  const off = onWallet(() => load());
  return () => { alive = false; off(); };
}
