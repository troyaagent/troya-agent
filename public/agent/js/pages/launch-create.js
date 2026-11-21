// Create coin (#/launch/create): launch on Pons Family (Robinhood Chain) from the user's wallet.
// The logo is hosted by this server (or a link the user gives), everything else is written on chain by the Pons factory.
// The server builds and simulates factory.launchToken; the user's wallet signs and sends it. A first buy, when chosen, is
// a second transaction: Swap opens with it after the launch confirms, the Gate runs on it and the user signs it there.
import { h, clear, icon, review, modal, toast, tiny, num, compact, short, useCss, debounce, infoTip, copyText, tokenIcon } from "../ui.js";
import { wallet, onWallet, openConnect, signIn } from "../wallet.js";
import { api } from "../api.js";
import { balanceOf, fromRaw, sendTx, waitReceipt, errText, journal } from "../chain.js";

const TAXES = [0, 100, 200, 300, 400]; // V6 rule: creator tax 0–4%
const BUYS = [0, 0.001, 0.005, 0.01, 0.05]; // "Buy right after launch", in ETH: the same choice X and Telegram offer
const GAS = 2n * 10n ** 14n;               // headroom for one transaction's network fee on Robinhood Chain (0.0002 ETH)
const PONS_FEE_BPS = 100;                  // the Pons trading fee: part of every total tax shown (owner rule, 18 Nov)
const SITE = "https://troya.codes";
const DONE_KEY = "troyaLaunchDone";        // the done screen, kept in this history entry: Back from Swap returns to it
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

/* ---------- curve and cost (plain numbers, no page state) ---------- */
const toWei = (eth) => BigInt(Math.round(Number(eth || 0) * 1e6)) * 10n ** 12n;
/** The curve in market cap from the launch menu: the server's figures, worked out here as well when an older server
 *  left them out (constant product on phantom + real quote, the whole supply in the curve; see robinhood.mjs). */
export function curveFigures(menu, buyEth = 0, taxBps = 0) {
  const cfg = menu?.configs?.[0];
  const p = Number(cfg?.phantomQuoteEth), g = Number(cfg?.graduationEth);
  if (!(p > 0) || !(g > 0)) return null;
  const startEth = cfg.startMcapEth ?? p, gradEth = cfg.gradMcapEth ?? (p + g) ** 2 / p;
  const eu = Number(menu.ethUsd) > 0 ? Number(menu.ethUsd) : null;
  // the first buy after the fee and creator tax (the creator is exempt from the launch snipe tax)
  const net = Number(buyEth) > 0 ? Number(buyEth) * (1 - ((cfg.curveFeeBps ?? PONS_FEE_BPS) + Number(taxBps || 0)) / 10000) : 0;
  return {
    startEth, gradEth, graduationEth: g,
    startUsd: menu.startMcapUsd ?? (eu ? startEth * eu : null), gradUsd: menu.gradMcapUsd ?? (eu ? gradEth * eu : null),
    feeUsd: menu.launchFeeUsd ?? (eu && menu.launchFeeEth != null ? menu.launchFeeEth * eu : null),
    buySharePct: net > 0 ? (net / (p + net)) * 100 : 0,       // of the whole supply, when it is the curve's first buy
    buyFillPct: net > 0 ? Math.min(100, (net / g) * 100) : 0,  // of the way to graduation
  };
}
/** Why a built launch must not go to the wallet (null when it may): a failed simulation would revert on chain and only
 *  burn gas, and a balance at or below the fee (or below the fee plus the chosen first buy) cannot pay for it. */
export function launchBlock(b, buyWei = 0n) {
  if (!b?.simulation?.ok) return { kind: "sim", error: String(b?.simulation?.error || "the launch reverted") };
  const fee = BigInt(b.value || 0), bal = b.balanceWei != null ? BigInt(b.balanceWei) : null;
  if (b.enoughBalance === false || (bal != null && bal <= fee)) return { kind: "fee", bal, need: fee + GAS };
  if (buyWei > 0n && bal != null && bal < fee + buyWei + 2n * GAS) return { kind: "buy", bal, need: fee + buyWei + 2n * GAS };
  return null;
}
const isDailyLimit = (e) => e?.status === 429 && /today|tomorrow/i.test(e?.message || "");
const usdK = (v) => (v >= 1000 ? "$" + compact(v, 1) : "$" + num(v, 0));
const usdC = (v) => (v > 0 && v < 0.01 ? "under $0.01" : "$" + Number(v).toFixed(2));
const money = (usdV, eth) => (usdV != null ? usdK(usdV) : `${num(eth, 2)} ETH`);
const totalTax = (t) => `${(PONS_FEE_BPS + t) / 100}% (1% Pons fee${t ? ` + ${t / 100}% creator tax` : ""})`;
const holderMin = (m) => (m % 1_000_000 === 0 ? `${m / 1_000_000}M` : m.toLocaleString("en-US"));
const swapHref = (token, eth) => `#/swap?in=eth&out=${token}&amount=${eth}&review=1`;

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

export async function mount(view, ctx = {}) {
  useCss("launch");
  let alive = true;
  if (hasPending()) recordPending().catch(() => {});
  const st = {
    name: "", symbol: "", description: "", website: "", twitter: "", telegram: "", logoUrl: "",
    file: null, preview: null, logo: null, tax: 0, buy: 0, menu: null, menuErr: null, bal: null, busy: false, done: null, plan: null, planErr: null, limitHit: null, rules: null,
    github: "", pc: null, pcBusy: false, pcErr: null, xMe: null, creator: null,
  };
  // Back from Swap (the first buy), or a reload after the launch: this history entry carries the done screen
  let back = null, openPc = false;
  try { const s = history.state?.[DONE_KEY]; if (s?.hash && Date.now() - (s.at || 0) < 86400_000) back = s; } catch {}
  // the form comes back after Sign in with X (Project check) or a trip to Bridge: the fields were kept in this tab
  try {
    const d = JSON.parse(sessionStorage.getItem(PC_DRAFT) || "null"); sessionStorage.removeItem(PC_DRAFT);
    if (d) {
      for (const k of DRAFT_KEYS) if (typeof d[k] === "string") st[k] = d[k];
      if (TAXES.includes(d.tax)) st.tax = d.tax;
      if (BUYS.includes(d.buy)) st.buy = d.buy;
      openPc = !!d.pc;
      if (d.done?.hash) back = d.done;
    }
  } catch {}
  if (back) {
    for (const k of ["name", "symbol", "website", "twitter", "telegram", "github"]) if (typeof back[k] === "string") st[k] = back[k];
    st.logo = back.logo || null;
    st.done = { hash: back.hash, token: back.token || null, url: back.url || null, buy: BUYS.includes(back.buy) ? back.buy : 0, at: back.at || Date.now() };
  }
  function saveDraft(extra = {}) {
    try {
      const d = { ...extra, tax: st.tax, buy: st.buy, done: st.done ? snapshot() : null };
      for (const k of DRAFT_KEYS) d[k] = st[k];
      // an image already uploaded to Troya comes back as its link
      if (!d.logoUrl && /^https:\/\//.test(st.logo || "")) d.logoUrl = st.logo;
      sessionStorage.setItem(PC_DRAFT, JSON.stringify(d));
    } catch {}
  }

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
    // the ticker is letters and numbers only: a typed "$" or "!" would be written into the coin on chain for good. Its case
    // is kept as typed, the same as on X and in Telegram ("horse" stays horse on all three; 21 Nov audit)
    el.addEventListener("input", () => { st[key] = el.value; if (key === "symbol") { el.value = el.value.replace(/[^A-Za-z0-9]/g, ""); st.symbol = el.value; } if (key === "logoUrl") { st.logo = null; } paintSide(); paintBtn(); });
    return el;
  };
  const fileIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", class: "sr", id: "lc-file" });
  const drop = h("label", { class: "lc-drop", for: "lc-file" });
  fileIn.addEventListener("change", () => setFile(fileIn.files?.[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setFile(e.dataTransfer.files?.[0]); });
  // Every site shows a coin's logo in a square or a circle, so the image is centre-cropped to a square here (side = its
  // shorter edge, at most 1024 px) and the preview shows exactly that crop: what is previewed is what goes on chain. A
  // 2400 × 1200 PNG used to be shrunk to 1024 × 512 and left for each board to cut. The server crops X and Telegram images
  // the same way (server/logosquare.mjs). A square image within 1024 px and 1 MB (the logo store's limit) is kept byte for
  // byte; anything else is drawn again, at 1024 px and smaller until it fits. An animated GIF can't be cropped and keep its
  // animation: a square one that fits is kept, any other becomes a still of its first frame, and the toast says so.
  const MAX_SIDE = 1024, MAX_BYTES = 1024 * 1024;
  async function shrink(f) {
    let bmp;
    try { bmp = await createImageBitmap(f); } catch { throw new Error("Troya couldn't read that image. Try a PNG or JPEG."); }
    const side = Math.min(bmp.width, bmp.height);
    if (bmp.width === bmp.height && side <= MAX_SIDE && f.size <= MAX_BYTES) { bmp.close?.(); return { file: f }; }
    const sx = Math.floor((bmp.width - side) / 2), sy = Math.floor((bmp.height - side) / 2);
    const type = f.type === "image/jpeg" ? "image/jpeg" : "image/png";   // PNG keeps the transparency of PNG, WebP and GIF
    const toBlob = (c, t, q) => new Promise((res) => c.toBlob(res, t, q));
    try {
      for (const n of [...new Set([MAX_SIDE, 768, 512, 384].map((t) => Math.min(side, t)))]) {
        const c = document.createElement("canvas");
        c.width = c.height = n;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(bmp, sx, sy, side, side, 0, 0, n, n);
        let b = await toBlob(c, type, 0.9);
        if (b && b.size > MAX_BYTES && type === "image/png") b = await toBlob(c, "image/webp", 0.92);   // Safari answers PNG again: the next size down
        if (b && b.size <= MAX_BYTES) {
          const ext = b.type === "image/png" ? ".png" : b.type === "image/webp" ? ".webp" : ".jpg";
          return { file: new File([b], f.name.replace(/\.\w+$/, "") + ext, { type: b.type }),
            note: f.type === "image/gif" ? "An animated GIF can't keep its animation once cropped to a square, so its first frame is used." : null };
        }
      }
    } finally { bmp.close?.(); }
    throw new Error("Troya couldn't make that image small enough. Try another one.");
  }
  async function setFile(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast("Use a PNG, JPEG, GIF or WebP image.", "error"); return; }
    try { const r = await shrink(f); f = r.file; if (r.note) toast(r.note, "warn", 7000); } catch (e) { toast(e.message, "error"); return; }
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.file = f; st.preview = URL.createObjectURL(f); st.logo = null;
    paintDrop(); paintSide(); paintBtn();
  }
  function paintDrop() {
    clear(drop, st.preview ? h("img", { src: st.preview, alt: "Coin image preview" }) : h("span", { class: "lc-drop-empty" }, icon("plus"), h("b", {}, "Add an image"), h("small", {}, "PNG, JPEG, GIF or WebP"), h("small", {}, "Cropped to a centre square")));
  }

  const taxBox = h("div", { class: "chips", role: "group", "aria-label": "Creator tax" });
  const taxTotal = h("p", { class: "note", style: { marginTop: 0 } });
  const buyBox = h("div", { class: "chips", role: "group", "aria-label": "Buy right after launch" });
  // the cost, the total tax and what is permanent, right above the button (on a phone the preview is far below)
  const sumBox = h("div", { class: "lc-sum", "aria-live": "polite" });
  const balNote = h("p", { class: "note" });
  const btn = h("button", { class: "btn primary big", type: "button", onclick: () => launch() });
  const status = h("div", { class: "lc-status" });

  // website, X and Telegram are optional: folded until asked for (open when one is already filled in)
  const linksD = h("details", { class: "lc-more", open: !!(st.website || st.twitter || st.telegram) || openPc },
    h("summary", {}, icon("plus"), "Add website, X, Telegram", h("span", { class: "muted" }, "(optional)")),
    h("div", { class: "lc-links" },
      h("label", { class: "field" }, h("span", {}, "Website"), inp("website", { maxlength: 256, placeholder: "https://" })),
      h("label", { class: "field" }, h("span", {}, "X"), inp("twitter", { maxlength: 256, placeholder: "https://x.com/…" })),
      h("label", { class: "field" }, h("span", {}, "Telegram"), inp("telegram", { maxlength: 256, placeholder: "https://t.me/…" }))));
  const openLinks = () => { linksD.open = true; linksD.querySelector("input")?.focus(); };

  /* ---------- Project check (18 Nov): a score for the project behind the coin, and proof the website and X are the creator's ---------- */
  if (!document.getElementById("lc-pc-css")) document.head.append(h("style", { id: "lc-pc-css" }, PC_CSS));
  const pcBox = h("div", { class: "lc-pc" });
  // optional, so it sits folded below the launch button (and comes back on the done screen)
  const pcFold = h("details", { class: "lc-fold", open: openPc },
    h("summary", {}, h("span", {}, "Project check ", h("span", { class: "muted" }, "(optional): get a credibility score"))),
    h("div", { class: "lc-fold-b" },
      h("p", { class: "note", style: { marginTop: 0 } }, "Troya reads your website, the code it runs, your X account and your wallet's track record on Robinhood Chain (plus GitHub and Telegram if you have them) and scores the project the way an outside reviewer would. It also checks that the website and X are really yours and shows it beside the score. Only you see the result."),
      h("label", { class: "field" }, h("span", {}, "GitHub ", h("span", { class: "muted" }, "(optional)")), inp("github", { maxlength: 256, placeholder: "https://github.com/…" })),
      pcBox));
  const xOf = (v) => (/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i.exec(v || "") || /^@?([A-Za-z0-9_]{1,15})$/.exec(String(v || "").trim()) || [])[1] || "";
  const mark = (ok) => { const i = h("i", { class: `lc-pc-m ${ok === true ? "ok" : ok === false ? "no" : "na"}` }); i.innerHTML = PC_ICON[ok === true ? "ok" : ok === false ? "no" : "na"]; return i; };
  function linkX() {
    saveDraft({ pc: true });
    location.href = "/api/x/login?for=link&back=create";
  }
  // an older wallet signs that it belongs to the signed-in creator (the session cookie stays while the wallet app shows the older account)
  async function linkOld() {
    const creator = st.creator || wallet.session?.address;
    if (!creator) { toast("Sign in with the wallet you will launch from first.", "error", 6000); return; }
    try {
      const old = (await wallet.eip.request({ method: "eth_requestAccounts" }))?.[0];
      if (!old || old.toLowerCase() === creator.toLowerCase()) { toast("In your wallet app, switch to the older wallet, then press Link an older wallet again.", "info", 8000); return; }
      const message = `I own ${old} and link it to ${creator} for my Troya track record.\nTime: ${new Date().toISOString()}`;
      const hexMsg = "0x" + [...new TextEncoder().encode(message)].map((x) => x.toString(16).padStart(2, "0")).join("");
      const signature = await wallet.eip.request({ method: "personal_sign", params: [hexMsg, old] });
      await api.post("launch/track-link", { message, signature });
      toast(`Linked ${short(old)}. Switch back to ${short(creator)} in your wallet app, then check again.`, "ok", 9000);
    } catch (e) { toast(errText(e), "error", 7000); }
  }
  async function loadXMe() {
    if (wallet.session?.address) st.creator = wallet.session.address;
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
      h("li", {}, mark(null), h("div", { class: "muted" }, h("b", {}, "Optional. "), "The same address in ", h("code", {}, "troya.txt"), " at the root of your GitHub repo, or in your Telegram group's description, adds a few points.")),
      h("li", {}, mark(null), h("div", { class: "muted" }, h("b", {}, "Bring your track record (optional). "), "Launching from a fresh wallet is fine and is not marked down. If you launched before from an older wallet and want its history to count, switch to it in your wallet app and link it here: the older wallet signs, nothing is sent and no gas is used.",
        st.creator || wallet.session ? h("div", { class: "lc-pc-act" }, h("button", { class: "btn sm", type: "button", onclick: linkOld }, "Link an older wallet")) : null)));
    const ready = !!(st.website.trim() && xh);
    clear(pcBox, steps,
      h("div", { class: "lc-pc-run" },
        h("button", { class: "btn primary", type: "button", disabled: !ready || st.pcBusy, onclick: runPc }, st.pcBusy ? "Checking the project…" : st.pc ? "Check again" : "Check project"),
        !ready ? h("span", { class: "fine" }, "Add your website and X first: both are needed for a score. ", st.done ? null : h("button", { class: "link", type: "button", onclick: openLinks }, "Add them"))
          : st.pcBusy ? h("span", { class: "fine" }, "Reading the site, its code, X and your wallet's history: up to 30 seconds.") : null),
      st.pcErr ? h("div", { class: "alert error" }, st.pcErr) : null,
      st.pc ? pcResult(st.pc) : null);
  }
  // the whole page (the form, then the done screen) repaints the check as fields change
  wrap.addEventListener("input", debounce(() => { if (alive) paintPc(); }, 250));

  clear(form,
    h("section", { class: "lc-sec" },
      h("h2", {}, "Identity"),
      h("div", { class: "lc-id" }, h("div", { class: "lc-drop-w" }, drop, h("span", { class: "fine" }, "Your image is hosted by Troya")), fileIn,
        h("div", { class: "lc-id-f" },
          h("label", { class: "field" }, h("span", {}, "Name"), inp("name", { maxlength: 48, placeholder: "Wooden Horse" })),
          h("label", { class: "field" }, h("span", {}, "Symbol ", h("span", { class: "muted" }, "(saved exactly as typed)")), inp("symbol", { maxlength: 16, placeholder: "HORSE" })))),
      h("label", { class: "field" }, h("span", {}, "Logo link ", h("span", { class: "muted" }, "(optional, instead of uploading: ipfs:// or https://, used as it is, so make it square)")), inp("logoUrl", { maxlength: 512, placeholder: "ipfs://…" })),
      h("label", { class: "field" }, h("span", {}, "Description"), inp("description", { textarea: true, maxlength: 2048, placeholder: "What is this coin about?" })),
      linksD),
    h("section", { class: "lc-sec" },
      h("h2", {}, "Creator tax ", infoTip("An extra tax on every buy and sell, paid to you, on top of the 1% Pons fee (you already earn 0.6% of volume from that fee, or all 0.7% when you hold 1,000,000 $TROYA). It applies before and after graduation and cannot be changed later. Higher taxes put traders off.")),
      taxBox, taxTotal),
    h("section", { class: "lc-sec" },
      h("h2", {}, "Buy right after launch ", h("span", { class: "muted" }, "(optional)")),
      buyBox,
      h("p", { class: "note", style: { marginTop: 0 } }, "When the launch confirms, Swap opens with this buy for you to review and sign: a second transaction, checked by the Gate like any trade. Pons puts a launch snipe tax on the first seconds (it starts at 99% and halves every few blocks); your own wallet is exempt, so your buy pays the normal fee.")),
    sumBox, balNote, btn, status, pcFold);

  let menuAlert = null;
  function paintTax() {
    const max = st.menu?.maxCreatorTaxBps ?? 1000;
    clear(taxBox, TAXES.filter((t) => t <= max).map((t) => h("button", { type: "button", class: "chip", "aria-pressed": String(t === st.tax), onclick: () => { st.tax = t; paintTax(); paintSide(); refreshPlan(); } }, t ? `${t / 100}%` : "None")));
    // owner rule (18 Nov): a coin's tax is always shown as the total, the Pons fee included
    taxTotal.textContent = `Boards show the total tax: the 1% Pons fee plus your creator tax. This coin: ${totalTax(st.tax)}.`;
    // one alert, replaced on each repaint (each tax click used to add another copy)
    menuAlert?.remove(); menuAlert = null;
    if (st.menuErr) { menuAlert = h("div", { class: "alert error", style: { marginTop: "8px" } }, st.menuErr); taxBox.after(menuAlert); }
  }
  function paintBuy() {
    clear(buyBox, BUYS.map((v) => h("button", { type: "button", class: "chip", "aria-pressed": String(v === st.buy), onclick: () => { st.buy = v; paintBuy(); paintSide(); paintBtn(); } }, v ? `${v} ETH` : "None")));
  }

  // where the curve starts and graduates, in market cap (dollars when the ETH price is known)
  function curveBox(f) {
    if (!f) return h("div", { class: "lc-curve" }, h("span", { class: "lc-curve-k" }, "Bonding curve"), h("p", {}, st.menuErr ? "The curve details are unavailable right now." : "Reading the Pons curve…"));
    const start = `≈ ${money(f.startUsd, f.startEth)}`, grad = `≈ ${money(f.gradUsd, f.gradEth)}`;
    return h("div", { class: "lc-curve" },
      h("span", { class: "lc-curve-k" }, "Bonding curve"),
      h("div", { class: "lc-curve-ends" },
        h("div", {}, h("span", {}, "Starts at"), h("b", {}, start), h("span", {}, "market cap")),
        h("div", {}, h("span", {}, "Graduates at"), h("b", {}, grad), h("span", {}, "market cap"))),
      h("i", { class: "lc-curve-bar", role: "img", "aria-label": `Bonding curve: starts at ${start} market cap and graduates at ${grad}` }, h("i", { style: { width: `${Math.max(1.5, f.buyFillPct)}%` } })),
      h("p", {}, `Graduates when buyers have put in ${num(f.graduationEth, 2)} ETH, then trades on a Uniswap v4 pool with the same total tax.`),
      st.buy ? h("p", {}, `Your ${st.buy} ETH first buy gets ≈ ${num(f.buySharePct, 2)}% of the supply, if it is the curve's first buy.`) : null);
  }

  function paintSide() {
    const sym = st.symbol || "SYMBOL";
    const cfg = st.menu?.configs?.[0];
    const f = curveFigures(st.menu, st.buy, st.tax);
    const rowsInfo = [
      ["Network", "Robinhood Chain · 4663"],
      ["Launchpad", "Pons Family (bonding curve)"],
      ["Supply", cfg ? `${num(Number(cfg.supply), 0)} (fixed)` : "1,000,000,000 (fixed)"],
      ["Total tax", totalTax(st.tax)],
      ["Trading fee", feeText()],
      ["Troya fee", troyaText()],
      ["Launch fee", st.menu ? `${tiny(st.menu.launchFeeEth)} ETH${f?.feeUsd != null ? ` (≈ ${usdC(f.feeUsd)})` : ""}, paid to Pons` : "…"],
      st.buy ? ["First buy", `${st.buy} ETH on Swap, after the launch`] : null,
    ].filter(Boolean);
    clear(side,
      h("div", { class: "lc-prev panel" },
        h("div", { class: "lc-prev-top" }, h("span", { class: "badge-s blue" }, "Live preview"), h("span", { class: "muted" }, "Robinhood Chain")),
        h("div", { class: "lc-prev-id" },
          st.preview ? h("img", { class: "lc-prev-img", src: st.preview, alt: "" }) : /^https:\/\//.test(st.logoUrl) ? h("img", { class: "lc-prev-img", src: st.logoUrl, alt: "" }) : tokenIcon({ symbol: sym }, ""),
          h("div", {}, h("b", {}, st.name || "Coin name"), h("span", { class: "muted" }, `$${sym}`))),
        st.description ? h("p", { class: "lc-prev-desc" }, st.description) : h("p", { class: "lc-prev-desc muted" }, "Your description shows here."),
        curveBox(f),
        h("div", { class: "rows" }, rowsInfo.map(([k, v]) => h("div", {}, h("span", {}, k), h("span", {}, v))))),
      h("p", { class: "note" }, "Name, symbol, logo link, description and links are written into the coin contract and cannot be edited later. Pons's own rules apply to everything after launch."));
    paintSum(f);
  }

  // "Launches today: 1 of 3": from the fee plan (the server counts today's launches through Troya, UTC)
  function limitLine() {
    const min = `${holderMin(st.rules?.holderMin || 1_000_000)} $TROYA`;
    if (st.limitHit) return `Launches today: ${st.limitHit.max} of ${st.limitHit.max}. Daily limit reached, back at 00:00 UTC (no limit with ${min}).`;
    const l = st.plan?.limit;
    if (l) return l.max == null ? `Launches today: no limit (you hold ${min})` : `Launches today: ${l.used} of ${l.max} (no limit with ${min})`;
    const per = st.rules?.limits?.perDay;
    return per ? `Up to ${per} launches a day (no limit with ${min})` : null;
  }
  function paintSum(f = curveFigures(st.menu, st.buy, st.tax)) {
    const fee = st.menu ? `${tiny(st.menu.launchFeeEth)} ETH launch fee${f?.feeUsd != null ? ` (≈ ${usdC(f.feeUsd)})` : ""}` : "the Pons launch fee";
    const lim = limitLine();
    clear(sumBox,
      h("div", {}, h("b", {}, "You pay "), st.buy ? `${fee} + ${st.buy} ETH first buy` : fee, ", plus network fees."),
      h("div", { class: "fine" }, `Total tax ${totalTax(st.tax)} · Name, ticker and image are permanent`),
      lim ? h("div", { class: `fine${st.limitHit ? " lc-sum-stop" : ""}` }, lim) : null);
    const need = st.menu ? BigInt(st.menu.launchFeeWei) + toWei(st.buy) + (st.buy ? 2n : 1n) * GAS : 0n;
    if (wallet.address && st.bal && st.bal.raw < need) {
      clear(balNote, `Your Robinhood Chain balance is ${tiny(st.bal.amount)} ETH, below the launch fee${st.buy ? `, your ${st.buy} ETH first buy` : ""} and gas. `,
        h("a", { class: "link", href: "#/bridge", onclick: () => saveDraft() }, "Bridge ETH in"));
    } else if (wallet.address && st.bal) clear(balNote, `Robinhood Chain balance: ${tiny(st.bal.amount)} ETH.`);
    else clear(balNote);
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
    if (!p) return st.limitHit ? "0.1% of volume · 0% for holders of 1M $TROYA" : "…";
    if (p.holder) return "0% · you hold 1M $TROYA";
    return p.split ? "0.1% of volume, out of your 0.7%" : "None";
  }
  const limitOf = () => ({ max: st.rules?.limits?.perDay ?? 3 });
  const refreshPlan = debounce(async () => {
    if (!wallet.address) { st.plan = null; st.planErr = null; st.limitHit = null; if (alive) { paintSide(); paintBtn(); } return; }
    try { st.plan = await api.post("launch/plan", { creator: wallet.address, creatorTaxBps: st.tax }); st.planErr = null; st.limitHit = null; }
    catch (e) {
      st.plan = null;
      // today's launches are used up: said once, above the button, and the button waits for 00:00 UTC
      if (isDailyLimit(e)) { st.limitHit = limitOf(); st.planErr = null; } else { st.limitHit = null; st.planErr = errText(e); }
    }
    if (alive) { paintSide(); paintBtn(); }
  }, 250);

  function paintBtn() {
    let label = "Review launch", disabled = false;
    const haveLogo = st.file || /^(https:\/\/|ipfs:\/\/)\S+$/.test(st.logoUrl.trim());
    const fee = st.menu ? BigInt(st.menu.launchFeeWei) : 0n;
    if (!wallet.address) label = "Connect wallet";
    else if (st.limitHit) { label = "Daily limit reached, back at 00:00 UTC"; disabled = true; }
    else if (!st.name.trim() || !st.symbol.trim()) { label = "Add a name and symbol"; disabled = true; }
    else if (!haveLogo) { label = "Add an image or a logo link"; disabled = true; }
    else if (!st.menu) { label = st.menuErr ? "Pons is unavailable" : "Loading Pons…"; disabled = true; }
    else if (!st.menu.launchEnabled) { label = "Pons launches are paused"; disabled = true; }
    else if (st.bal && st.bal.raw < fee) { label = "Not enough ETH on Robinhood Chain"; disabled = true; }
    else if (st.buy && st.bal && st.bal.raw < fee + toWei(st.buy)) { label = "Not enough ETH for the launch and this buy"; disabled = true; }
    if (st.busy) { label = st.busy; disabled = true; }
    btn.textContent = label;
    btn.disabled = disabled;
  }

  async function refreshBal() {
    st.bal = wallet.address ? await balanceOf(wallet.address).catch(() => null) : null;
    if (alive) { paintSide(); paintBtn(); }
  }

  // a launch that cannot go through gets no launch button: what failed, how to fix it, and Back
  function blocked(why) {
    let title, text, fixes;
    if (why.kind === "sim") {
      title = "This launch would fail";
      text = `Simulation failed: ${why.error}`;
      fixes = ["Check the name, symbol and logo link, then press Review launch again.", "If it fails again, Pons may have paused launches or changed its options: try again in a few minutes."];
    } else {
      const bal = why.bal != null ? `${tiny(fromRaw(why.bal))} ETH` : "too low";
      title = "Not enough ETH on Robinhood Chain";
      text = `Your balance is ${bal}. The launch fee${why.kind === "buy" ? `, your ${st.buy} ETH first buy` : ""} and gas need about ${tiny(fromRaw(why.need))} ETH.`;
      fixes = ["Bridge ETH to Robinhood Chain, then come back to Create coin: this tab keeps what you filled in.", why.kind === "buy" ? "Or pick a smaller first buy, or None." : null].filter(Boolean);
    }
    return new Promise((resolve) => {
      const m = modal({ title, onClose: () => resolve(), body: h("div", {},
        h("div", { class: "alert error", style: { marginBottom: "10px" } }, text),
        h("ul", { class: "lc-fix" }, fixes.map((f) => h("li", {}, f))),
        h("p", { class: "fine", style: { margin: "8px 0 0" } }, "Nothing was sent and nothing was spent."),
        h("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "14px" } },
          h("button", { class: why.kind === "sim" ? "btn primary" : "btn ghost", type: "button", onclick: () => m.close() }, "Back"),
          why.kind === "sim" ? null : h("a", { class: "btn primary", href: "#/bridge", onclick: () => saveDraft() }, "Bridge ETH in"))) });
    });
  }

  async function launch() {
    if (!wallet.address) { await openConnect(); return; }
    try {
      // 1. logo: an uploaded image is hosted here (cached so a retry does not re-upload); otherwise the given link
      if (!st.logo) {
        if (st.file) {
          // the logo upload now needs a signed-in session (server/api launch/logo answers 401 without one)
          if (!wallet.session) { st.busy = "Sign in to upload the image…"; paintBtn(); await signIn(); }
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
      // a failed simulation or a balance that cannot pay never reaches the review: there is nothing to sign
      const buy = st.buy, stop = launchBlock(b, toWei(buy));
      if (stop) { st.busy = false; paintBtn(); await blocked(stop); return; }
      const f = curveFigures(st.menu, buy, b.creatorTaxBps);
      const feeEth = tiny(fromRaw(b.launchFeeWei));
      const ok = await review({
        title: "Review launch",
        summary: `${st.name.trim()} ($${st.symbol.trim()}) on Robinhood Chain`,
        rows: [
          ["Network", "Robinhood Chain · 4663"],
          ["Launchpad", `Pons factory ${short(b.to)}`],
          ["Coin address", b.predicted ? h("span", { class: "mono" }, short(b.predicted.token, 6)) : "Shown after launch"],
          ["Curve", f ? `starts at ≈ ${money(f.startUsd, f.startEth)} market cap, graduates at ≈ ${money(f.gradUsd, f.gradEth)} (${num(b.config.graduationEth, 2)} ETH put in)` : `graduates at ${num(b.config.graduationEth, 2)} ETH raised`],
          ["Total tax", totalTax(b.creatorTaxBps)],
          ["Trading fee", p.split ? "1% (you earn 0.6% of volume, Troya 0.1%)" : "1% (you earn 0.7% of volume)"],
          ["Fee recipient", p.split ? h("span", {}, "Troya fee splitter ", h("span", { class: "mono" }, short(p.recipient)), ": pays you 0.6% of volume", b.creatorTaxBps ? " plus all your tax" : "", ", Troya 0.1%") : `${short(wallet.address)} (you)`],
          ["Launch fee", `${feeEth} ETH${f?.feeUsd != null ? ` (≈ ${usdC(f.feeUsd)})` : ""}`],
          ["You send", `${tiny(fromRaw(b.value))} ETH + network fee`],
          buy ? ["Then you buy", `${buy} ETH of $${st.symbol.trim()} on Swap: checked by the Gate, signed on its own`] : null,
          // added in wei: tiny() cuts digits, so a float sum like 0.010499… would read 0.0104
          buy ? ["Total", `${feeEth} launch fee + ${buy} buy = ${tiny(fromRaw(BigInt(b.value) + toWei(buy)))} ETH, plus network fees`] : null,
        ],
        extra: h("div", { class: "alert ok", style: { marginBottom: "10px" } }, "Simulated against Robinhood Chain: the launch succeeds."),
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
        st.done = { hash, token, url: token ? `https://ponsfamily.com/launchpad/${token.toLowerCase()}` : null, buy: token ? buy : 0, at: Date.now() };
        showDone();
        if (st.done.buy) {
          // the first buy: Swap opens with it filled in, the Gate runs and the user signs it there (Back returns to this screen)
          toast(`Coin launched. Swap is open with your ${buy} ETH buy: review it and sign. Back brings you to the share step.`, "ok", 9000);
          location.hash = swapHref(token, buy);
        } else toast("Coin launched", "ok", 5000);
        return;
      }
      clear(status, rc ? h("div", { class: "alert error" }, "The launch reverted on chain. Only the network fee was spent.")
        : h("div", { class: "alert warn" }, "Still waiting for Robinhood Chain. It is not lost: keep the hash ", h("span", { class: "mono" }, short(hash, 6)), "."));
    } catch (e) {
      if (isDailyLimit(e)) { st.limitHit = limitOf(); paintSum(); }
      toast(errText(e), "error", 6000);
    } finally {
      st.busy = false;
      if (alive && !st.done) { paintBtn(); refreshBal(); }
    }
  }

  // what the done screen needs to come back (Back from Swap, a reload, a Sign in with X round trip)
  function snapshot() {
    return { ...st.done, name: st.name.trim(), symbol: st.symbol.trim(), logo: /^https:\/\//.test(st.logo || "") ? st.logo : null,
      website: st.website, twitter: st.twitter, telegram: st.telegram, github: st.github };
  }
  function showDone(again = false) {
    const d = st.done, sym = st.symbol.trim(), lc = d.token ? d.token.toLowerCase() : null;
    try { history.replaceState({ ...(history.state || {}), [DONE_KEY]: snapshot() }, "", location.href); } catch {}
    const img = st.preview || (/^https:\/\//.test(st.logo || "") ? st.logo : null);
    // the share step: a ready post with the ticker, the full CA and the coin's page on troya.codes (the creator posts it)
    let link = lc ? `${SITE}/agent#/token/${lc}` : null;
    const post = `$${sym} is live on Robinhood Chain\nCA ${d.token}`;
    const intent = (u) => `https://x.com/intent/post?text=${encodeURIComponent(post)}&url=${encodeURIComponent(u)}`;
    const xBtn = lc ? h("a", { class: "btn", href: intent(link), target: "_blank", rel: "noopener" }, "Share on X") : null;
    // signed in: the link carries the creator's Herald referral code (sharecard.js), so buyers who come through it count
    if (lc) import("../sharecard.js").then(async (m) => { const ref = await m.loadRef(); if (ref?.code && alive) { link = m.shareUrl(ref, d.token); xBtn.href = m.xIntent(post, link); } }).catch(() => {});
    const another = () => { try { history.replaceState(null, "", location.href); } catch {} if (ctx.go) ctx.go("#/launch/create"); else location.reload(); };
    const pcReady = !!(st.website.trim() && xOf(st.twitter));
    clear(wrap, h("div", { class: "lc-done panel" },
      img ? h("img", { class: "lc-done-img", src: img, alt: "" }) : null,
      h("h2", { tabindex: "-1" }, `${st.name.trim()} is live on Robinhood Chain`),
      d.token ? h("p", { class: "muted" }, `$${sym} · `, h("button", { class: "link mono", type: "button", onclick: () => copyText(d.token, "Address copied") }, short(d.token, 6))) : null,
      h("div", { class: "lc-done-act" },
        lc && d.buy && !again ? h("a", { class: "btn primary", href: swapHref(d.token, d.buy) }, `Buy ${d.buy} ETH now`) : null,
        lc ? h("a", { class: d.buy && !again ? "btn" : "btn primary", href: `#/token/${lc}` }, "Open coin page") : null,
        d.url ? h("a", { class: "btn", href: d.url, target: "_blank", rel: "noopener" }, "View on Pons ", icon("ext")) : null,
        lc && (!d.buy || again) ? h("a", { class: "btn", href: `#/swap?out=${d.token}` }, "Buy it") : null),
      lc ? h("div", { class: "lc-done-share" },
        xBtn,
        h("button", { class: "btn", type: "button", onclick: () => copyText(link, "Link copied") }, icon("copy"), "Copy link"),
        h("a", { class: "btn ghost", href: "#/troya-launches" }, "See it on Troya Launches"),
        h("a", { class: "btn ghost", href: "#/creator" }, "Creator desk")) : null,
      h("p", { class: "note" }, "Launch transaction ", h("button", { class: "link mono", type: "button", onclick: () => copyText(d.hash, "Hash copied") }, short(d.hash, 6)), ". It can take a few minutes for GeckoTerminal to list the coin."),
      pcReady ? pcFold : null,
      h("button", { class: "link lc-done-new", type: "button", onclick: another }, "Create another coin")));
    if (pcReady) paintPc();
    wrap.querySelector("h2")?.focus();
  }

  /* ---------- boot ---------- */
  paintDrop();
  paintTax();
  paintBuy();
  paintSide();
  paintBtn();
  if (st.done) showDone(true);
  api.get("launch/menu").then((m) => { st.menu = m; }).catch((e) => { st.menuErr = `Could not read the Pons launch options: ${e.message}`; })
    .finally(() => { if (alive) { paintTax(); paintSide(); paintBtn(); } });
  refreshPlan();
  api.get("launch/rules").then((r) => { st.rules = r; if (r?.splitter?.live) headP.textContent = HEAD_V6; if (alive) paintSide(); }).catch(() => {});
  paintPc(); loadXMe();
  const off = onWallet(() => { refreshBal(); refreshPlan(); paintBtn(); loadXMe(); });
  return () => { alive = false; off(); if (st.preview && !st.done) URL.revokeObjectURL(st.preview); };
}
