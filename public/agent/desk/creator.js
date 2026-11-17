// Creator desk (#/creator), V6 F28: every coin a wallet launched through Troya, the creator fees waiting for it on Pons,
// and the claim. Numbers and transactions come from /api/launch/fees (read from chain); the wallet signs every claim.
//   · coins whose fee goes through a TroyaFeeSplitter (launched without 1M $TROYA): one transaction per coin
//     (factory.deployAndCollect) pays the creator's part straight to the creator's wallet; Troya keeps 0.1% of volume
//   · coins whose fee goes to the creator's own wallet (holders): sweep each curve, then one claim from the Pons fee escrow
import { h, clear, useCss, pageHead, short, tiny, usd, ago, tokenIcon, toast, review } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signerFor } from "/agent/js/wallet.js";
import { waitReceipt, errText } from "/agent/js/chain.js";

const SRC = { x: "From X", tg: "From Telegram", web: "From troya.codes" };

export async function mount(view) {
  useCss("perps");
  let alive = true, busy = false, data = null, err = null, addr = null, loading = false;
  const body = h("div", { class: "cr" });
  clear(view, h("div", { class: "dk cr-page" },
    pageHead("Creator desk", "Every coin you launched through Troya, the creator fees waiting for you, and a one-click claim. Read live from Pons; your own wallet signs every claim."),
    body));

  async function load() {
    addr = wallet.address || null;
    if (!addr) { data = null; err = null; paint(); return; }
    loading = true; paint();
    try { data = await api.get(`/api/launch/fees?wallet=${addr}`); err = null; } catch (e) { err = errText(e); }
    loading = false;
    if (alive) paint();
  }
  const eth = (v) => (v > 0 ? `${tiny(v)} ETH` : "0 ETH");
  const inUsd = (v) => (data?.ethUsd && v > 0 ? usd(v * data.ethUsd) : "");

  // every claim is signed by the creator's own wallet, one transaction after another, then the numbers are read again
  async function claim(txs, title, amount) {
    if (busy || !txs?.length) return;
    if (!wallet.address || wallet.address.toLowerCase() !== String(data?.wallet).toLowerCase()) { toast("Connect the wallet that launched these coins.", "error"); return; }
    const ok = await review({
      title,
      summary: `About ${eth(amount)}${inUsd(amount) ? ` (${inUsd(amount)})` : ""} goes to your wallet ${short(data.wallet)}. You sign ${txs.length === 1 ? "one transaction" : `${txs.length} transactions`} on Robinhood Chain and pay the gas, a fraction of a cent each.`,
      rows: txs.map((t, i) => [`Step ${i + 1}`, t.label]),
      confirmLabel: "Continue in wallet",
    });
    if (!ok) return;
    busy = true; paint();
    try {
      const signer = await signerFor("robinhood");
      for (const t of txs) {
        const hash = await signer.sendUncheckedTransaction({ to: t.to, data: t.data });
        const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
        if (rc?.status !== 1) throw new Error(`${t.label}: the transaction failed on chain.`);
      }
      toast("Claimed. The ETH is in your wallet.", "ok", 7000);
    } catch (e) { toast(errText(e), "error", 8000); }
    busy = false;
    await load();
  }

  function coinRow(c) {
    const yours = c.split ? c.yoursEth : c.onCurveEth;
    const chips = [
      h("span", { class: "cr-chip" }, SRC[c.source] || "Launched through Troya"),
      c.graduated ? h("span", { class: "cr-chip ok" }, "Graduated") : h("span", { class: "cr-chip" }, "On the Pons curve"),
      c.split ? h("span", { class: "cr-chip" }, "You 0.6% · Troya 0.1% of volume") : h("span", { class: "cr-chip gold" }, "100% yours"),
      c.creatorTaxBps ? h("span", { class: "cr-chip" }, `Tax ${c.creatorTaxBps / 100}%`) : null,
    ];
    const act = c.split
      ? h("button", { class: `btn${yours > 0 ? " primary" : ""}`, type: "button", disabled: busy || !(c.txs?.length), onclick: () => claim(c.txs, `Claim $${c.symbol || "coin"} creator fees`, yours) }, yours > 0 ? "Claim" : "Nothing yet")
      : h("span", { class: "cr-in" }, yours > 0 ? "In the wallet claim above" : "Nothing yet");
    return h("article", { class: "panel cr-coin" },
      h("a", { class: "cr-ava", href: `#/token/${c.token}`, "aria-label": `Open $${c.symbol || "coin"}` }, tokenIcon({ address: c.token, symbol: c.symbol, image: c.logo }, "xl")),
      h("div", { class: "cr-main" },
        h("div", { class: "cr-name" }, h("a", { href: `#/token/${c.token}` }, h("b", {}, c.symbol ? `$${c.symbol}` : short(c.token))), h("span", {}, c.name || ""), c.at ? h("small", {}, ago(c.at)) : null),
        h("div", { class: "cr-chips" }, chips),
        c.graduated ? h("p", { class: "cr-note" }, "Its Uniswap pool's fees reach the Pons escrow when Pons sweeps them, then show up here.") : null),
      h("div", { class: "cr-amt" }, h("b", {}, eth(yours)), h("small", {}, inUsd(yours) || "waiting for you")),
      act);
  }

  function paint() {
    if (!alive) return;
    if (!wallet.address) {
      clear(body, h("section", { class: "panel cr-empty" },
        h("b", {}, "Connect the wallet you launch with"),
        h("p", {}, "Coins launched from X and Telegram count for the wallet linked to them; coins launched on troya.codes, for the wallet that signed."),
        h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet")));
      return;
    }
    if (err) { clear(body, h("div", { class: "alert error" }, err), h("button", { class: "btn", type: "button", onclick: load }, "Try again")); return; }
    if (!data) { clear(body, h("div", { class: "sk", style: { height: "120px", borderRadius: "18px" } })); return; }
    const coins = data.coins || [];
    if (!coins.length && !(data.escrow?.walletEth > 0)) {
      clear(body, h("section", { class: "panel cr-empty" },
        h("b", {}, "No coins launched through Troya from this wallet yet"),
        h("p", {}, `Launch one from X, Telegram or troya.codes and its creator fees show up here. Wallet ${short(data.wallet)}.`),
        h("a", { class: "btn primary", href: "#/create" }, "Create coin")));
      return;
    }
    const split = coins.filter((c) => c.split), own = coins.filter((c) => !c.split);
    const all = [...split.flatMap((c) => c.txs || []), ...(data.escrow?.txs || [])];
    const holderEth = (data.escrow?.walletEth || 0) + (data.escrow?.holderCurveEth || 0);
    clear(body,
      h("section", { class: "panel cr-sum" },
        h("div", {},
          h("div", { class: "k" }, "Waiting for you"),
          h("div", { class: "v" }, eth(data.yoursEth)),
          h("div", { class: "u" }, [inUsd(data.yoursEth), `${coins.length} coin${coins.length === 1 ? "" : "s"} launched through Troya`, loading ? "refreshing…" : null].filter(Boolean).join(" · "))),
        h("div", { class: "cr-sum-act" },
          h("button", { class: "btn primary", type: "button", disabled: busy || !all.length || !(data.yoursEth > 0), onclick: () => claim(all, "Claim all creator fees", data.yoursEth) }, busy ? "Claiming…" : "Claim all"),
          h("button", { class: "btn", type: "button", disabled: busy || loading, onclick: load }, "Refresh"))),
      own.length || data.escrow?.walletEth > 0 ? h("section", { class: "panel cr-wallet" },
        h("div", {},
          h("b", {}, "Paid to your own wallet"),
          h("p", { class: "cr-note" }, "Coins launched while holding 1,000,000 $TROYA send the whole creator fee to your wallet through the Pons fee escrow. One claim pays out everything the escrow holds for you, these coins and any other.")),
        h("div", { class: "cr-amt" }, h("b", {}, eth(holderEth)), h("small", {}, inUsd(holderEth) || "waiting for you")),
        h("button", { class: `btn${holderEth > 0 ? " primary" : ""}`, type: "button", disabled: busy || !(data.escrow?.txs?.length), onclick: () => claim(data.escrow.txs, "Claim to your wallet", holderEth) }, holderEth > 0 ? "Claim to wallet" : "Nothing yet")) : null,
      h("h2", { class: "cr-sec" }, "Your coins"),
      h("div", { class: "cr-list" }, coins.map(coinRow)),
      h("p", { class: "cr-foot" }, "Amounts are read from Pons on chain: fees still on each coin's curve plus what the fee escrow holds. Anyone may send a split coin's collect; it always pays the creator the same share. ",
        h("a", { class: "ulink", href: "/launch-on-x#money", target: "_blank", rel: "noopener" }, "Where the creator fee goes")));
  }

  const off = onWallet(() => { if ((wallet.address || null) !== addr) load(); });
  await load();
  return () => { alive = false; off?.(); };
}
