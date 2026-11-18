// Create coin (#/launch/create): launch on Pons Family (Robinhood Chain) from the user's wallet.
// The logo is hosted by this server (or a link the user gives), everything else is written on chain by the Pons factory.
// The server builds and simulates factory.launchToken; the user's wallet signs and sends it.
import { h, clear, icon, review, toast, tiny, num, short, useCss, debounce, infoTip, copyText, tokenIcon } from "../ui.js";
import { wallet, onWallet, openConnect, signIn } from "../wallet.js";
import { api } from "../api.js";
import { balanceOf, fromRaw, sendTx, waitReceipt, errText, journal } from "../chain.js";

const TAXES = [0, 100, 200, 300, 400]; // V6 rule: creator tax 0–4%
// launches sent but not recorded yet: kept in this browser until Troya has them (the fee splitter's salt rides along; the
// server keeps its own copy too), and sent again on the next visit
const PENDING = "troya.pendingLaunches";
const pendingList = () => { try { return JSON.parse(localStorage.getItem(PENDING) || "[]"); } catch { return []; } };
const savePending = (l) => { try { localStorage.setItem(PENDING, JSON.stringify(l.slice(-20))); } catch {} };
export const hasPending = () => pendingList().length > 0;
export async function recordPending() {
  const left = [];
  for (const p of pendingList()) {
    try { await api.post("launch/record", p); }
    catch (e) {
      // "not on Robinhood Chain yet" and network trouble: try again later; a definite refusal is dropped
      if (Date.now() - (p.at || 0) < 30 * 86400_000 && (!e.status || e.status === 404 || e.status >= 500)) left.push(p);
    }
  }
  savePending(left);
}
const TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"; // TokenLaunched(address,address,address,address,uint256,uint256)
const PC_DRAFT = "troya.createDraft", DRAFT_KEYS = ["name", "symbol", "description", "website", "twitter", "telegram", "logoUrl", "github"];
const PC_ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  no: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  na: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"/></svg>',
};
const PC_CSS = `.lc-pc { display: grid; gap: 14px; min-width: 0; }
.lc-pc-steps > li > div, .lc-pc-top > div, .lc-pc-res, .lc-pc-sec li > span, .lc-pc-extra li > span { min-width: 0; overflow-wrap: anywhere; }
.lc-pc-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.lc-pc-steps > li { display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: start; font-size: 13.5px; line-height: 1.5; }
.lc-pc-m { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line-3); color: var(--muted); }
.lc-pc-m svg { width: 12px; height: 12px; }
.lc-pc-m.ok { color: var(--up); border-color: color-mix(in srgb, var(--up) 45%, transparent); }
.lc-pc-m.no { color: var(--down); border-color: color-mix(in srgb, var(--down) 45%, transparent); }
.lc-pc-code { display: flex; align-items: center; gap: 8px; margin-top: 6px; min-width: 0; }
.lc-pc-code code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 7px 10px; border: 1px solid var(--line-2); border-radius: 8px; font-size: 12px; }
.lc-pc-act { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.lc-pc-run { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lc-pc-res { border: 1px solid var(--line-2); border-radius: 14px; padding: 16px; display: grid; gap: 12px; }
.lc-pc-top { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; }
.lc-pc-score { display: flex; align-items: baseline; gap: 2px; }
.lc-pc-score b { font-size: 44px; line-height: 1; font-weight: 700; letter-spacing: -0.02em; }
.lc-pc-score span { color: var(--muted); font-size: 13px; }
.lc-pc-res.good .lc-pc-score b { color: var(--up); } .lc-pc-res.mid .lc-pc-score b { color: var(--warn); } .lc-pc-res.low .lc-pc-score b { color: var(--down); }
.lc-pc-verdict { font-weight: 700; letter-spacing: .08em; font-size: 13px; }
.lc-pc-vrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lc-pc-own { font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line-3); color: var(--fg-2); }
.lc-pc-own.ok { color: var(--up); border-color: color-mix(in srgb, var(--up) 45%, transparent); }
.lc-pc-own.part { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.lc-pc-own.no { color: var(--down); border-color: color-mix(in srgb, var(--down) 45%, transparent); }
.lc-pc-secs { display: grid; gap: 6px; }
.lc-pc-sec { border-top: 1px solid var(--line); padding-top: 6px; }
.lc-pc-sec summary { display: grid; grid-template-columns: 1fr auto 90px; gap: 10px; align-items: center; cursor: pointer; list-style: none; font-size: 13.5px; }
.lc-pc-sec summary::-webkit-details-marker { display: none; }
.lc-pc-bar { display: block; height: 5px; border-radius: 3px; background: var(--line-2); overflow: hidden; }
.lc-pc-bar > i { display: block; height: 100%; background: var(--fg-2); }
.lc-pc-sec ul, .lc-pc-extra { list-style: none; margin: 8px 0 4px; padding: 0; display: grid; gap: 6px; }
.lc-pc-sec li, .lc-pc-extra li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; font-size: 12.5px; color: var(--fg-2); line-height: 1.45; }
@media (max-width: 560px) { .lc-pc-sec summary { grid-template-columns: 1fr auto 56px; } .lc-pc-score b { font-size: 36px; } }`;

export async function mount(view, ctx) {
  useCss("launch");
  let alive = true;
  if (hasPending()) recordPending().catch(() => {});
  const st = {
    name: "", symbol: "", description: "", website: "", twitter: "", telegram: "", logoUrl: "",
    file: null, preview: null, logo: null, tax: 0, menu: null, menuErr: null, bal: null, busy: false, done: null, plan: null, planErr: null, rules: null,
    github: "", pc: null, pcBusy: false, pcErr: null, xMe: null,
  };
  // the form comes back after Sign in with X (Project check): the text fields were kept in this tab for the round trip
  try { const d = JSON.parse(sessionStorage.getItem(PC_DRAFT) || "null"); sessionStorage.removeItem(PC_DRAFT); if (d) for (const k of DRAFT_KEYS) if (typeof d[k] === "string") st[k] = d[k]; } catch {}

  const HEAD_V6 = "Launch on Robinhood Chain through Pons Family: one transaction creates the coin and its bonding curve. It graduates to a Uniswap v4 pool once the curve fills. Launching through Troya is free: you earn 0.6% of trading volume plus any creator tax you set, Troya takes 0.1%. Hold 1,000,000 $TROYA and you keep the whole 0.7%.";
  const headP = h("p", {}, HEAD_V6);
  const form = h("div", { class: "lc-form" });
  const side = h("aside", { class: "lc-side" });
  const wrap = h("div", { class: "lc-grid" }, form, side);
  clear(view,
    h("a", { class: "lc-back link", href: "#/create" }, "← Create coin"),
    h("header", { class: "page-head lc-head" }, h("h1", {}, "Create coin"), headP),
    wrap);

  /* ---------- inputs ---------- */
  const inp = (key, attrs = {}) => {
    const el = h(attrs.textarea ? "textarea" : "input", { class: "input", value: st[key], rows: attrs.textarea ? 3 : null, ...attrs, textarea: null });
    if (attrs.textarea) el.value = st[key];
    // the ticker is letters and numbers only: a typed "$" or "!" would be written into the coin on chain for good
    el.addEventListener("input", () => { st[key] = el.value; if (key === "symbol") { el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); st.symbol = el.value; } if (key === "logoUrl") { st.logo = null; } paintSide(); paintBtn(); });
    return el;
  };
  const fileIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", class: "sr", id: "lc-file" });
  const drop = h("label", { class: "lc-drop", for: "lc-file" });
  fileIn.addEventListener("change", () => setFile(fileIn.files?.[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setFile(e.dataTransfer.files?.[0]); });
  // the logo store keeps images up to 1 MB: a bigger one is scaled down here (to 1024 px, then smaller if needed), so
  // nobody has to think about file sizes. An animated GIF can't be scaled without losing the animation, so it says so.
  async function shrink(f) {
    if (f.size <= 1024 * 1024) return f;
    if (f.type === "image/gif") throw new Error("That GIF is too large to use. Use a PNG or JPEG instead.");
    const bmp = await createImageBitmap(f);
    for (const side of [1024, 768, 512]) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const type = f.type === "image/png" ? "image/png" : "image/jpeg";
      let b = await new Promise((res) => c.toBlob(res, type, 0.9));
      if (b && b.size > 1024 * 1024 && type === "image/png") b = await new Promise((res) => c.toBlob(res, "image/webp", 0.92));
      if (b && b.size <= 1024 * 1024) return new File([b], f.name.replace(/\.\w+$/, "") + (b.type === "image/png" ? ".png" : b.type === "image/webp" ? ".webp" : ".jpg"), { type: b.type });
    }
    throw new Error("Troya couldn't make that image small enough. Try another one.");
  }
  async function setFile(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast("Use a PNG, JPEG, GIF or WebP image.", "error"); return; }
    try { f = await shrink(f); } catch (e) { toast(e.message, "error"); return; }
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.file = f; st.preview = URL.createObjectURL(f); st.logo = null;
    paintDrop(); paintSide(); paintBtn();
  }
  function paintDrop() {
    clear(drop, st.preview ? h("img", { src: st.preview, alt: "Coin image preview" }) : h("span", { class: "lc-drop-empty" }, icon("plus"), h("b", {}, "Add an image"), h("small", {}, "PNG, JPEG, GIF or WebP"), h("small", {}, "Square works best")));
  }

  const taxBox = h("div", { class: "chips" });
  const balNote = h("p", { class: "note" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => launch() });
  const status = h("div", { class: "lc-status" });

  /* ---------- Project check (18 Nov): a score for the project behind the coin, and proof the website and X are the creator's ---------- */
  if (!document.getElementById("lc-pc-css")) document.head.append(h("style", { id: "lc-pc-css" }, PC_CSS));
  const pcBox = h("div", { class: "lc-pc" });
  const pcSec = h("section", { class: "lc-sec" },
    h("h2", {}, "Project check ", h("span", { class: "muted" }, "(optional)")),
    h("p", { class: "note", style: { marginTop: 0 } }, "Troya reads your website, the code it runs and your X account (plus GitHub and Telegram if you have them) and scores the project the way an outside reviewer would. It also checks that the website and X are really yours and shows it beside the score. Only you see the result."),
    h("label", { class: "field" }, h("span", {}, "GitHub ", h("span", { class: "muted" }, "(optional)")), inp("github", { maxlength: 256, placeholder: "https://github.com/…" })),
    pcBox);
  const xOf = (v) => (/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i.exec(v || "") || /^@?([A-Za-z0-9_]{1,15})$/.exec(String(v || "").trim()) || [])[1] || "";
  const mark = (ok) => { const i = h("i", { class: `lc-pc-m ${ok === true ? "ok" : ok === false ? "no" : "na"}` }); i.innerHTML = PC_ICON[ok === true ? "ok" : ok === false ? "no" : "na"]; return i; };
  function linkX() {
    try { const d = {}; for (const k of DRAFT_KEYS) d[k] = st[k]; sessionStorage.setItem(PC_DRAFT, JSON.stringify(d)); } catch {}
    location.href = "/api/x/login?for=link&back=create";
  }
  async function loadXMe() {
    if (!wallet.session) st.xMe = null;
    else { try { st.xMe = (await api.get("x/me"))?.x?.username || null; } catch { st.xMe = null; } }
    if (alive) paintPc();
  }
  async function runPc() {
    st.pcBusy = true; st.pcErr = null; paintPc();
    try { st.pc = await api.post("launch/project-check", { name: st.name, symbol: st.symbol, description: st.description, website: st.website, twitter: st.twitter, telegram: st.telegram, github: st.github }); }
    catch (e) { st.pcErr = e.message || "The check failed. Try again in a minute."; }
    finally { st.pcBusy = false; if (alive) paintPc(); }
  }
  function pcResult(v) {
    return h("div", { class: `lc-pc-res ${v.score >= 60 ? "good" : v.score >= 40 ? "mid" : "low"}` },
      h("div", { class: "lc-pc-top" },
        h("div", { class: "lc-pc-score" }, h("b", {}, String(v.score)), h("span", {}, "/100")),
        h("div", {},
          h("div", { class: "lc-pc-vrow" }, h("span", { class: "lc-pc-verdict" }, v.verdict), v.owner ? h("span", { class: `lc-pc-own ${v.owner.verified ? "ok" : v.owner.proven ? "part" : "no"}` }, v.owner.verified ? "Owner verified" : v.owner.proven ? "Owner partly verified" : "Owner not verified") : null),
          v.owner && !v.owner.verified ? h("p", { class: "fine", style: { margin: "4px 0 0" } }, `${v.owner.text}. Prove them in the steps above, then check again.`) : null,
          v.summary ? h("p", { class: "fine", style: { margin: "4px 0 0" } }, v.summary) : null)),
      h("div", { class: "lc-pc-secs" }, v.sections.map((s) => h("details", { class: "lc-pc-sec" },
        h("summary", {}, h("span", {}, s.title), h("span", { class: "mono" }, `${s.points}/${s.max}`), h("i", { class: "lc-pc-bar" }, h("i", { style: { width: `${Math.round((s.points / s.max) * 100)}%` } }))),
        h("ul", {}, s.items.map((it) => h("li", {}, mark(it.ok), h("span", {}, it.text))))))),
      v.extra?.length ? h("ul", { class: "lc-pc-extra" }, v.extra.map((it) => h("li", {}, mark(it.ok), h("span", {}, it.text)))) : null,
      h("p", { class: "fine", style: { margin: 0 } }, v.note));
  }
  function paintPc() {
    const addr = wallet.address || "";
    const xh = xOf(st.twitter);
    const xOk = !!(st.xMe && xh && st.xMe.toLowerCase() === xh.toLowerCase());
    const meta = `<meta name="troya-verify" content="${addr || "0xYourWallet"}">`;
    const xAct = xOk ? null : !addr ? h("button", { class: "btn sm", type: "button", onclick: () => openConnect() }, "Connect wallet")
      : !wallet.session ? h("button", { class: "btn sm", type: "button", onclick: () => signIn().then(loadXMe).catch((e) => toast(errText(e), "error")) }, "Sign in")
      : h("button", { class: "btn sm", type: "button", onclick: linkX }, st.xMe ? "Sign in with another X account" : "Sign in with X");
    const steps = h("ol", { class: "lc-pc-steps" },
      h("li", {}, mark(xOk ? true : null), h("div", {}, h("b", {}, "Prove the X account. "),
        xOk ? `Signed in as @${st.xMe}: it matches.` : st.xMe ? `You are signed in as @${st.xMe}; sign in with ${xh ? `@${xh}` : "the project's account"} instead.` : `Sign in with ${xh ? `@${xh}` : "the project's X account"}.`,
        xAct ? h("div", { class: "lc-pc-act" }, xAct) : null)),
      h("li", {}, mark(st.pc ? st.pc.ownership.website.verified : null), h("div", {}, h("b", {}, "Prove the website. "), "Put your wallet address on the site, as a file ", h("code", {}, "/troya.txt"), " or as this tag inside the home page's ", h("code", {}, "<head>"), ":",
        h("div", { class: "lc-pc-code" }, h("code", {}, addr || "Connect a wallet to see your address"), addr ? h("button", { class: "btn sm", type: "button", onclick: () => copyText(addr, "Address copied") }, "Copy") : null),
        h("div", { class: "lc-pc-code" }, h("code", {}, meta), h("button", { class: "btn sm", type: "button", onclick: () => copyText(meta, "Tag copied") }, "Copy")))),
      h("li", {}, mark(null), h("div", { class: "muted" }, h("b", {}, "Optional. "), "The same address in ", h("code", {}, "troya.txt"), " at the root of your GitHub repo, or in your Telegram group's description, adds a few points.")));
    const ready = !!(st.website.trim() && xh);
    clear(pcBox, steps,
      h("div", { class: "lc-pc-run" },
        h("button", { class: "btn primary", type: "button", disabled: !ready || st.pcBusy, onclick: runPc }, st.pcBusy ? "Checking the project…" : st.pc ? "Check again" : "Check project"),
        !ready ? h("span", { class: "fine" }, "Add your website and X above first: both are needed for a score.") : st.pcBusy ? h("span", { class: "fine" }, "Reading the site, its code and X: about 10 seconds.") : null),
      st.pcErr ? h("div", { class: "alert error" }, st.pcErr) : null,
      st.pc ? pcResult(st.pc) : null);
  }
  form.addEventListener("input", debounce(() => { if (alive) paintPc(); }, 250));

  clear(form,
    h("section", { class: "lc-sec" },
      h("h2", {}, "Identity"),
      h("div", { class: "lc-id" }, drop, fileIn,
        h("div", { class: "lc-id-f" },
          h("label", { class: "field" }, h("span", {}, "Name"), inp("name", { maxlength: 48, placeholder: "Wooden Horse" })),
          h("label", { class: "field" }, h("span", {}, "Symbol"), inp("symbol", { maxlength: 16, placeholder: "HORSE" })))),
      h("label", { class: "field" }, h("span", {}, "Logo link ", h("span", { class: "muted" }, "(optional, instead of uploading: ipfs:// or https://)")), inp("logoUrl", { maxlength: 512, placeholder: "ipfs://…" })),
      h("label", { class: "field" }, h("span", {}, "Description"), inp("description", { textarea: true, maxlength: 2048, placeholder: "What is this coin about?" }))),
    h("section", { class: "lc-sec" },
      h("h2", {}, "Links ", h("span", { class: "muted" }, "(optional)")),
      h("div", { class: "lc-links" },
        h("label", { class: "field" }, h("span", {}, "Website"), inp("website", { maxlength: 256, placeholder: "https://" })),
        h("label", { class: "field" }, h("span", {}, "X"), inp("twitter", { maxlength: 256, placeholder: "https://x.com/…" })),
        h("label", { class: "field" }, h("span", {}, "Telegram"), inp("telegram", { maxlength: 256, placeholder: "https://t.me/…" })))),
    pcSec,
    h("section", { class: "lc-sec" },
      h("h2", {}, "Creator tax ", infoTip("An extra tax on every buy and sell, paid to you, on top of the 1% Pons fee (you already earn 0.6% of volume from that fee, or all 0.7% when you hold 1,000,000 $TROYA). It applies before and after graduation and cannot be changed later. Higher taxes put traders off.")),
      taxBox,
      h("p", { class: "note" }, "Launch snipe protection is built into Pons: the first seconds after launch carry a tax that starts at 99% and halves every few blocks. Your own wallet is exempt, so you can buy right after launch from the Swap page at the normal fee.")),
    balNote, btn, status);

  let menuAlert = null;
  function paintTax() {
    const max = st.menu?.maxCreatorTaxBps ?? 1000;
    clear(taxBox, TAXES.filter((t) => t <= max).map((t) => h("button", { type: "button", class: "chip", "aria-pressed": String(t === st.tax), onclick: () => { st.tax = t; paintTax(); paintSide(); refreshPlan(); } }, t ? `${t / 100}%` : "None")));
    // one alert, replaced on each repaint (each tax click used to add another copy)
    menuAlert?.remove(); menuAlert = null;
    if (st.menuErr) { menuAlert = h("div", { class: "alert error", style: { marginTop: "8px" } }, st.menuErr); taxBox.after(menuAlert); }
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
    if (!p) return "1% · creators earn 0.6% of volume (0.7% for holders)";
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
          ["Fee recipient", p.split ? h("span", {}, "Troya fee splitter ", h("span", { class: "mono" }, short(p.recipient)), ": pays you 0.6% of volume", b.creatorTaxBps ? " plus all your tax" : "", ", Troya 0.1%") : `${short(wallet.address)} (you)`],
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
      const rec = { hash, creator: wallet.address, salt: p.salt || null, troyaBps: p.troyaBps || 0, at: Date.now() };
      savePending([...pendingList(), rec]);
      clear(status, h("div", { class: "muted" }, "Submitted ", h("a", { class: "mono link", href: `https://robinhoodchain.blockscout.com/tx/${hash}`, target: "_blank", rel: "noopener" }, short(hash, 6)), " · waiting for Robinhood Chain to include the launch…"));
      st.busy = "Waiting for Robinhood Chain…"; paintBtn();
      const rc = await waitReceipt("robinhood", hash, { timeoutMs: 180_000 });
      if (rc && rc.status === 1) {
        // the factory's TokenLaunched(token, curve, deployer, …) event names the coin; fall back to the simulated address
        const fromLog = rc.logs?.find((l) => l.address?.toLowerCase() === b.to.toLowerCase() && l.topics?.[0] === TOKEN_LAUNCHED)?.topics?.[1];
        const token = fromLog ? "0x" + fromLog.slice(26) : b.predicted?.token;
        journal({ kind: "launch", chain: "robinhood", hash, token, name: st.name.trim(), symbol: st.symbol.trim(), rationale: "Coin created from the Create coin page" });
        // recorded with a few retries (the node may not have the receipt yet); if it still fails, the next visit sends it
        (async () => { for (const wait of [0, 4000, 12000]) { await new Promise((r) => setTimeout(r, wait)); if (await api.post("launch/record", rec).then(() => true, () => false)) { savePending(pendingList().filter((x) => x.hash !== hash)); return; } } })();
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
  paintPc(); loadXMe();
  const off = onWallet(() => { refreshBal(); refreshPlan(); paintBtn(); loadXMe(); });
  return () => { alive = false; off(); if (st.preview && !st.done) URL.revokeObjectURL(st.preview); };
}
