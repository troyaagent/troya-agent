// Create coin (#/launch/create): launch on Pons Family (Robinhood Chain) from the user's wallet.
// The logo is hosted by this server (or a link the user gives), everything else is written on chain by the Pons factory.
// The server builds and simulates factory.launchToken; the user's wallet signs and sends it.
import { h, clear, icon, review, toast, tiny, num, short, useCss, debounce, infoTip, copyText, tokenIcon } from "../ui.js";
import { wallet, onWallet, openConnect } from "../wallet.js";
import { api } from "../api.js";
import { balanceOf, fromRaw, sendTx, waitReceipt, errText, journal } from "../chain.js";

const TAXES = [0, 100, 200, 300, 400]; // V6 rule: creator tax 0–4%
const TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"; // TokenLaunched(address,address,address,address,uint256,uint256)

export async function mount(view, ctx) {
  useCss("launch");
  let alive = true;
  const st = {
    name: "", symbol: "", description: "", website: "", twitter: "", telegram: "", logoUrl: "",
    file: null, preview: null, logo: null, tax: 0, menu: null, menuErr: null, bal: null, busy: false, done: null, plan: null, planErr: null, rules: null,
  };

  const HEAD_OLD = "Launch on Robinhood Chain through Pons Family: one transaction creates the coin and its bonding curve. It graduates to a Uniswap v4 pool once the curve fills, and you earn 70% of the 1% trading fee plus any creator tax you set.";
  const HEAD_V6 = "Launch on Robinhood Chain through Pons Family: one transaction creates the coin and its bonding curve. It graduates to a Uniswap v4 pool once the curve fills. Launching through Troya is free: you earn 0.6% of trading volume plus any creator tax you set, Troya takes 0.1%. Hold 1,000,000 $TROYA and you keep the whole 0.7%.";
  const headP = h("p", {}, HEAD_OLD);
  const form = h("div", { class: "lc-form" });
  const side = h("aside", { class: "lc-side" });
  const wrap = h("div", { class: "lc-grid" }, form, side);
  clear(view,
    h("a", { class: "lc-back link", href: "#/launch" }, "← Launchpad"),
    h("header", { class: "page-head lc-head" }, h("h1", {}, "Create coin"), headP),
    wrap);

  /* ---------- inputs ---------- */
  const inp = (key, attrs = {}) => {
    const el = h(attrs.textarea ? "textarea" : "input", { class: "input", value: st[key], rows: attrs.textarea ? 3 : null, ...attrs, textarea: null });
    if (attrs.textarea) el.value = st[key];
    el.addEventListener("input", () => { st[key] = el.value; if (key === "symbol") { el.value = el.value.toUpperCase().replace(/\s/g, ""); st.symbol = el.value; } if (key === "logoUrl") { st.logo = null; } paintSide(); paintBtn(); });
    return el;
  };
  const fileIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", class: "sr", id: "lc-file" });
  const drop = h("label", { class: "lc-drop", for: "lc-file" });
  fileIn.addEventListener("change", () => setFile(fileIn.files?.[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setFile(e.dataTransfer.files?.[0]); });
  function setFile(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast("Use a PNG, JPEG, GIF or WebP image.", "error"); return; }
    if (f.size > 1024 * 1024) { toast("The image is over 1 MB.", "error"); return; }
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.file = f; st.preview = URL.createObjectURL(f); st.logo = null;
    paintDrop(); paintSide(); paintBtn();
  }
  function paintDrop() {
    clear(drop, st.preview ? h("img", { src: st.preview, alt: "Coin image preview" }) : h("span", { class: "lc-drop-empty" }, icon("plus"), h("b", {}, "Add an image"), h("small", {}, "PNG, JPEG, GIF or WebP · up to 1 MB · square works best")));
  }

  const taxBox = h("div", { class: "chips" });
  const balNote = h("p", { class: "note" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => launch() });
  const status = h("div", { class: "lc-status" });

  clear(form,
    h("section", { class: "lc-sec" },
      h("h2", {}, "Identity"),
      h("div", { class: "lc-id" }, drop, fileIn,
        h("div", { class: "lc-id-f" },
          h("label", { class: "field" }, h("span", {}, "Name"), inp("name", { maxlength: 64, placeholder: "Wooden Horse" })),
          h("label", { class: "field" }, h("span", {}, "Symbol"), inp("symbol", { maxlength: 16, placeholder: "HORSE" })))),
      h("label", { class: "field" }, h("span", {}, "Logo link ", h("span", { class: "muted" }, "(optional, instead of uploading: ipfs:// or https://)")), inp("logoUrl", { maxlength: 512, placeholder: "ipfs://…" })),
      h("label", { class: "field" }, h("span", {}, "Description"), inp("description", { textarea: true, maxlength: 2048, placeholder: "What is this coin about?" }))),
    h("section", { class: "lc-sec" },
      h("h2", {}, "Links ", h("span", { class: "muted" }, "(optional)")),
      h("div", { class: "lc-links" },
        h("label", { class: "field" }, h("span", {}, "Website"), inp("website", { maxlength: 256, placeholder: "https://" })),
        h("label", { class: "field" }, h("span", {}, "X"), inp("twitter", { maxlength: 256, placeholder: "https://x.com/…" })),
        h("label", { class: "field" }, h("span", {}, "Telegram"), inp("telegram", { maxlength: 256, placeholder: "https://t.me/…" })))),
    h("section", { class: "lc-sec" },
      h("h2", {}, "Creator tax ", infoTip("An extra tax on every buy and sell, paid to you, on top of the 1% Pons fee (of which you already earn 70%). It applies before and after graduation and cannot be changed later. Higher taxes put traders off.")),
      taxBox,
      h("p", { class: "note" }, "Launch snipe protection is built into Pons: the first seconds after launch carry a tax that starts at 99% and halves every few blocks. Your own wallet is exempt, so you can buy right after launch from the Swap page at the normal fee.")),
    balNote, btn, status);

  function paintTax() {
    const max = st.menu?.maxCreatorTaxBps ?? 1000;
    clear(taxBox, TAXES.filter((t) => t <= max).map((t) => h("button", { type: "button", class: "chip", "aria-pressed": String(t === st.tax), onclick: () => { st.tax = t; paintTax(); paintSide(); refreshPlan(); } }, t ? `${t / 100}%` : "None")));
    if (st.menuErr) taxBox.after(h("div", { class: "alert error", style: { marginTop: "8px" } }, st.menuErr));
  }

  function paintSide() {
    const sym = st.symbol || "SYMBOL";
    const cfg = st.menu?.configs?.[0];
    const rowsInfo = [
      ["Network", "Robinhood Chain · 4663"],
      ["Launchpad", "Pons Family (bonding curve)"],
      ["Supply", cfg ? `${num(Number(cfg.supply), 0)} (fixed)` : "1,000,000,000 (fixed)"],
      ["Graduates at", cfg ? `${num(cfg.graduationEth, 2)} ETH raised → Uniswap v4` : "…"],
      ["Trading fee", feeText()],
      ["Troya fee", troyaText()],
      ["Creator tax", st.tax ? `${st.tax / 100}% to you` : "None"],
      ["Launch fee", st.menu ? `${tiny(st.menu.launchFeeEth)} ETH (paid to Pons)` : "…"],
    ];
    clear(side,
      h("div", { class: "lc-prev panel" },
        h("div", { class: "lc-prev-top" }, h("span", { class: "badge-s blue" }, "Live preview"), h("span", { class: "muted" }, "Robinhood Chain")),
        h("div", { class: "lc-prev-id" },
          st.preview ? h("img", { class: "lc-prev-img", src: st.preview, alt: "" }) : /^https:\/\//.test(st.logoUrl) ? h("img", { class: "lc-prev-img", src: st.logoUrl, alt: "" }) : tokenIcon({ symbol: sym }, ""),
          h("div", {}, h("b", {}, st.name || "Coin name"), h("span", { class: "muted" }, `$${sym}`))),
        st.description ? h("p", { class: "lc-prev-desc" }, st.description) : h("p", { class: "lc-prev-desc muted" }, "Your description shows here."),
        h("div", { class: "rows" }, rowsInfo.map(([k, v]) => h("div", {}, h("span", {}, k), h("span", {}, v))))),
      h("p", { class: "note" }, "Name, symbol, logo link, description and links are written into the coin contract and cannot be edited later. Pons's own rules apply to everything after launch."));
    const need = st.menu ? BigInt(st.menu.launchFeeWei) : 0n;
    if (wallet.address && st.bal && st.bal.raw < need + 2n * 10n ** 14n) balNote.textContent = `Your Robinhood Chain balance is ${tiny(st.bal.amount)} ETH, below the launch fee plus gas.`;
    else balNote.textContent = wallet.address && st.bal ? `Robinhood Chain balance: ${tiny(st.bal.amount)} ETH.` : "";
  }

  // V6 fee rule: the server says who receives the creator fee (the creator, or a Troya fee splitter for 0.1% of volume)
  function feeText() {
    const p = st.plan;
    if (!p) return st.rules?.splitter?.live ? "1% · creators earn 0.6% of volume (0.7% for holders)" : "1% · you earn 70% of it";
    return p.split ? "1% · you earn 0.6% of volume" : "1% · you earn 0.7% of volume";
  }
  function troyaText() {
    const p = st.plan;
    if (st.planErr) return st.planErr;
    if (!wallet.address) return st.rules?.splitter?.live ? "0.1% of volume · 0% for holders of 1M $TROYA" : "None";
    if (!p) return "…";
    if (p.holder) return "0% · you hold 1M $TROYA";
    return p.split ? "0.1% of volume, out of your 0.7%" : "None";
  }
  const refreshPlan = debounce(async () => {
    if (!wallet.address) { st.plan = null; st.planErr = null; if (alive) paintSide(); return; }
    try { st.plan = await api.post("launch/plan", { creator: wallet.address, creatorTaxBps: st.tax }); st.planErr = null; }
    catch (e) { st.plan = null; st.planErr = errText(e); }
    if (alive) { paintSide(); paintBtn(); }
  }, 250);

  function paintBtn() {
    let label = "Review launch", disabled = false;
    const haveLogo = st.file || /^(https:\/\/|ipfs:\/\/)\S+$/.test(st.logoUrl.trim());
    if (!wallet.address) label = "Connect wallet";
    else if (!st.name.trim() || !st.symbol.trim()) { label = "Add a name and symbol"; disabled = true; }
    else if (!haveLogo) { label = "Add an image or a logo link"; disabled = true; }
    else if (!st.menu) { label = st.menuErr ? "Pons is unavailable" : "Loading Pons…"; disabled = true; }
    else if (!st.menu.launchEnabled) { label = "Pons launches are paused"; disabled = true; }
    else if (st.bal && st.bal.raw < BigInt(st.menu.launchFeeWei)) { label = "Not enough ETH on Robinhood Chain"; disabled = true; }
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
  }

  async function refreshBal() {
    st.bal = wallet.address ? await balanceOf(wallet.address).catch(() => null) : null;
    if (alive) { paintSide(); paintBtn(); }
  }

  async function launch() {
    if (!wallet.address) { await openConnect(); return; }
    try {
      // 1. logo: an uploaded image is hosted here (cached so a retry does not re-upload); otherwise the given link
      if (!st.logo) {
        if (st.file) {
          st.busy = "Uploading the image…"; paintBtn();
          const r = await api.post("launch/logo", st.file, { type: st.file.type });
          if (r.note) toast(r.note, "warn", 7000);
          st.logo = r.url;
        } else st.logo = st.logoUrl.trim();
      }
      // 2. the fee plan for this launch (name rules, daily limit, who receives the creator fee), then build + simulate
      st.busy = "Checking the launch…"; paintBtn();
      const p = await api.post("launch/plan", { creator: wallet.address, creatorTaxBps: st.tax, name: st.name.trim(), symbol: st.symbol.trim() });
      st.plan = p;
      st.busy = "Simulating the launch…"; paintBtn();
      const b = await api.post("launch/build", {
        creator: wallet.address, name: st.name.trim(), symbol: st.symbol.trim(), logo: st.logo, description: st.description.trim(),
        website: st.website.trim(), twitter: st.twitter.trim(), telegram: st.telegram.trim(), creatorTaxBps: st.tax, feeRecipient: p.recipient,
      });
      const simNote = b.simulation.ok ? "Simulated against Robinhood Chain: the launch succeeds." : `Simulation failed: ${b.simulation.error}`;
      const ok = await review({
        title: "Review launch",
        summary: `${st.name.trim()} ($${st.symbol.trim()}) on Robinhood Chain`,
        rows: [
          ["Network", "Robinhood Chain · 4663"],
          ["Launchpad", `Pons factory ${short(b.to)}`],
          ["Coin address", b.predicted ? h("span", { class: "mono" }, short(b.predicted.token, 6)) : "Shown after launch"],
          ["Curve", `graduates at ${num(b.config.graduationEth, 2)} ETH raised`],
          ["Trading fee", p.split ? "1% (you earn 0.6% of volume, Troya 0.1%)" : "1% (you earn 0.7% of volume)"],
          ["Creator tax", b.creatorTaxBps ? `${b.creatorTaxBps / 100}%, all to you` : "None"],
          ["Fee recipient", p.split ? h("span", {}, "Troya fee splitter ", h("span", { class: "mono" }, short(p.recipient)), ` → ${(100 - p.troyaBps / 100).toFixed(2)}% to you`) : `${short(wallet.address)} (you)`],
          ["Launch fee", `${tiny(fromRaw(b.launchFeeWei))} ETH`],
          ["You send", `${tiny(fromRaw(b.value))} ETH + network fee`],
        ],
        extra: h("div", { class: `alert ${b.simulation.ok ? "ok" : "error"}`, style: { marginBottom: "10px" } }, simNote),
        warn: !b.enoughBalance ? "Your Robinhood Chain balance looks too low for this launch. Bridge ETH in first." : null,
        confirmLabel: "Launch in wallet",
      });
      if (!ok) return;
      st.busy = "Confirm in your wallet…"; paintBtn();
      const hash = await sendTx("robinhood", b);
      clear(status, h("div", { class: "muted" }, "Submitted ", h("a", { class: "mono link", href: `https://robinhoodchain.blockscout.com/tx/${hash}`, target: "_blank", rel: "noopener" }, short(hash, 6)), " · waiting for Robinhood Chain to include the launch…"));
      st.busy = "Waiting for Robinhood Chain…"; paintBtn();
      const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
      if (rc && rc.status === 1) {
        // the factory's TokenLaunched(token, curve, deployer, …) event names the coin; fall back to the simulated address
        const fromLog = rc.logs?.find((l) => l.address?.toLowerCase() === b.to.toLowerCase() && l.topics?.[0] === TOKEN_LAUNCHED)?.topics?.[1];
        const token = fromLog ? "0x" + fromLog.slice(26) : b.predicted?.token;
        journal({ kind: "launch", chain: "robinhood", hash, token, name: st.name.trim(), symbol: st.symbol.trim(), rationale: "Coin created from the Create coin page" });
        api.post("launch/record", { hash, creator: wallet.address, salt: p.salt || null, troyaBps: p.troyaBps || 0 }).catch(() => {});
        st.done = { hash, token, url: token ? `https://ponsfamily.com/launchpad/${token.toLowerCase()}` : null };
        showDone();
        return;
      }
      clear(status, rc ? h("div", { class: "alert error" }, "The launch reverted on chain. Only the network fee was spent.")
        : h("div", { class: "alert warn" }, "Still waiting for Robinhood Chain. It is not lost: keep the hash ", h("span", { class: "mono" }, short(hash, 6)), "."));
    } catch (e) {
      toast(errText(e), "error", 6000);
    } finally {
      st.busy = false;
      if (alive && !st.done) { paintBtn(); refreshBal(); }
    }
  }

  function showDone() {
    const d = st.done;
    clear(wrap, h("div", { class: "lc-done panel" },
      st.preview ? h("img", { class: "lc-done-img", src: st.preview, alt: "" }) : null,
      h("h2", { tabindex: "-1" }, `${st.name.trim()} is live on Robinhood Chain`),
      d.token ? h("p", { class: "muted" }, `$${st.symbol.trim()} · `, h("button", { class: "link mono", type: "button", onclick: () => copyText(d.token, "Address copied") }, short(d.token, 6))) : null,
      h("div", { class: "lc-done-act" },
        d.token ? h("a", { class: "btn primary", href: `#/token/${d.token.toLowerCase()}` }, "Open coin page") : null,
        d.url ? h("a", { class: "btn", href: d.url, target: "_blank", rel: "noopener" }, "View on Pons ", icon("ext")) : null,
        d.token ? h("a", { class: "btn", href: `#/swap?out=${d.token}` }, "Buy it") : null),
      h("p", { class: "note" }, "Launch transaction ", h("button", { class: "link mono", type: "button", onclick: () => copyText(d.hash, "Hash copied") }, short(d.hash, 6)), ". It can take a few minutes for GeckoTerminal to list the coin.")));
    wrap.querySelector("h2")?.focus();
    toast("Coin launched", "ok", 5000);
  }

  /* ---------- boot ---------- */
  paintDrop();
  paintTax();
  paintSide();
  paintBtn();
  api.get("launch/menu").then((m) => { st.menu = m; }).catch((e) => { st.menuErr = `Could not read the Pons launch options: ${e.message}`; })
    .finally(() => { if (alive) { paintTax(); paintSide(); paintBtn(); } });
  refreshPlan();
  api.get("launch/rules").then((r) => { st.rules = r; if (r?.splitter?.live) headP.textContent = HEAD_V6; if (alive) paintSide(); }).catch(() => {});
  const off = onWallet(() => { refreshBal(); refreshPlan(); paintBtn(); });
  return () => { alive = false; off(); if (st.preview && !st.done) URL.revokeObjectURL(st.preview); };
}
