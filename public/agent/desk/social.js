// F20 · Social layer in the app.
//   X              link your X account to your wallet (Sign in with X); Troya on X: the @Troyaagent account, its mode
//                  (off, draft, live), today's X usage against the daily caps, the replies it posted; admins see every
//                  mention and draft and switch the mode
//   Holder pass    the soulbound Troya Holder Pass: mint it while you hold the minimum $TROYA (admins deploy it once)
//   Votes          proposals; one pass, one vote, signed in the wallet (no transaction); every signature public
import { Interface, AbiCoder, parseUnits } from "ethers";
import { h, clear, useCss, toast, pageHead, seg, short, tiny, review } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signIn, signerFor } from "/agent/js/wallet.js";
import { sendTx, waitReceipt, errText } from "/agent/js/chain.js";

const PASS = new Interface(["function mint() returns (uint256)", "function burn()"]);
const big = (x) => (x == null ? "–" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : tiny(x));
const TROYA = "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";

const NOTE = {
  linked: ["Your X account is linked to this wallet.", "ok"], bot: ["@Troyaagent is connected: Troya can read and answer its mentions.", "ok"],
  signin: ["Sign in with your wallet first, then link X.", "error"], expired: ["That sign-in took too long. Try again.", "error"],
  cancelled: ["The X sign-in was cancelled.", "error"], failed: ["X did not finish the sign-in. Try again.", "error"], busy: ["Today's X budget is used up. Try again tomorrow.", "error"],
};
const ago = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  const st = { tab: ["x", "pass", "votes"].includes(ctx.parts[0]) ? ctx.parts[0] : "x", me: undefined, status: null, log: null, pass: null, votes: null, busy: null };
  const body = h("div", { class: "so-body" }), tabs = h("div", { class: "sd-tabs" });
  clear(view, h("div", { class: "dk so" },
    pageHead("Social", "Your X account on Troya, Troya answering on X, the Holder Pass and holder votes."),
    tabs, body));
  const paintTabs = () => clear(tabs, seg([{ value: "x", label: "X" }, { value: "pass", label: "Holder pass" }, { value: "votes", label: "Votes" }], st.tab, (v) => { st.tab = v; history.replaceState(null, "", `#/social/${v}`); paint(); load(); }));
  const q = ctx.query?.x;
  if (q === "notbot") toast(`That was @${ctx.query.as || "another account"}. Only @Troyaagent can connect Troya on X.`, "error", 8000);
  else if (NOTE[q]) toast(NOTE[q][0], NOTE[q][1], 7000);
  if (q) history.replaceState(null, "", "#/social");

  async function load() {
    if (st.tab === "pass" || st.tab === "votes") return loadHolders();
    const [me, status] = await Promise.all([
      wallet.session ? api.get("x/me").catch(() => null) : Promise.resolve(null),
      api.get("x/status").catch((e) => ({ error: e.message })),
    ]);
    st.me = me; st.status = status;
    st.log = status?.admin ? (await api.get("x/log").catch(() => null))?.log || [] : null;
    if (alive) paint();
  }

  function paint() {
    paintTabs();
    if (st.tab === "pass") return passTab();
    if (st.tab === "votes") return votesTab();
    const s = st.status;
    if (!s) return clear(body, h("div", { class: "sk", style: { height: "240px" } }));
    clear(body, mine(s), troya(s), st.log ? logBox() : null);
  }

  /* ---------- holder pass ---------- */
  async function loadHolders() {
    const [pass, votes] = await Promise.all([api.get(`pass${wallet.address ? `?address=${wallet.address}` : ""}`).catch((e) => ({ error: e.message })), api.get("votes").catch(() => null)]);
    st.pass = pass; st.votes = votes;
    if (alive) paint();
  }
  const run = async (label, fn) => { if (st.busy) return; st.busy = label; paint(); try { await fn(); } catch (e) { toast(errText(e), "error", 8000); } st.busy = null; await loadHolders(); };
  function passTab() {
    const p = st.pass;
    if (!p) return clear(body, h("div", { class: "sk", style: { height: "240px" } }));
    if (p.error) return clear(body, h("div", { class: "alert error" }, p.error));
    const card = h("div", { class: "panel sd-panel so-card" }, h("h3", {}, "Troya Holder Pass"),
      h("p", { class: "muted", style: { margin: 0 } }, `A soulbound NFT for wallets holding at least ${big(p.minHold)} $TROYA. It cannot be sold, sent or approved, only burned by its holder. One pass is one vote while its wallet still holds the minimum.`));
    if (!p.deployed) {
      card.append(h("p", { class: "fine" }, "The pass contract is not deployed yet."));
      if (st.votes?.admin) {
        const minIn = h("input", { class: "input", inputmode: "decimal", value: String(p.minHold), "aria-label": "Minimum $TROYA" });
        card.append(h("div", { class: "fw-row" }, h("span", { class: "fine" }, "Admin · minimum $TROYA (fixed forever)"), minIn,
          h("button", { class: "btn blue", type: "button", disabled: !!st.busy, onclick: () => deploy(Number(minIn.value)) }, st.busy || "Deploy the pass")));
      }
      return clear(body, card);
    }
    card.append(h("p", { class: "fine" }, h("a", { class: "ulink", href: `https://robinhoodchain.blockscout.com/address/${p.pass}`, target: "_blank", rel: "noopener" }, `Contract ${short(p.pass)}`), ` · ${p.passes} pass${p.passes === 1 ? "" : "es"} held · ${p.minted} minted`));
    const me = p.me;
    if (!wallet.address) card.append(h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet"));
    else if (me?.passId) card.append(h("div", { class: "so-pass" }, me.image ? h("img", { src: me.image, alt: `Troya Holder Pass #${me.passId}`, width: 180, height: 180 }) : null,
      h("div", {}, h("b", {}, `Pass #${me.passId}`), h("p", { class: "fine" }, me.active ? `Counts in votes: this wallet holds ${big(me.balance)} $TROYA.` : `Not counting right now: this wallet holds ${big(me.balance)} $TROYA, under the ${big(p.minHold)} minimum.`),
        h("button", { class: "link", type: "button", disabled: !!st.busy, onclick: burnPass }, "Burn my pass"))));
    else if (me?.eligible) card.append(h("p", {}, `This wallet holds ${big(me.balance)} $TROYA: it can mint a pass.`), h("button", { class: "btn blue", type: "button", disabled: !!st.busy, onclick: mintPass }, st.busy || "Mint my pass"));
    else card.append(h("p", {}, `This wallet holds ${big(me?.balance || 0)} $TROYA; the pass needs ${big(p.minHold)}.`), h("a", { class: "btn", href: `#/swap?out=${TROYA}` }, "Get $TROYA"));
    clear(body, card);
  }
  const deploy = (minHold) => run("Deploying…", async () => {
    if (!(minHold > 0)) throw new Error("Enter the minimum $TROYA.");
    const b = await (await fetch("/agent/desk/troya-pass.json")).json();
    const ok = await review({ title: "Deploy the Troya Holder Pass", summary: `Minimum ${big(minHold)} $TROYA, fixed forever. No owner, no admin, no upgrade.`, rows: [["Token", `$TROYA ${short(TROYA)}`], ["Contract", "TroyaPass (16 tests passed)"], ["Gas", "about 1.9M gas"]], confirmLabel: "Continue in wallet" });
    if (!ok) return;
    const data = b.bytecode + AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [TROYA, parseUnits(String(minHold), 18)]).slice(2);
    const signer = await signerFor("robinhood");
    const tx = await signer.sendTransaction({ data });
    const rc = await waitReceipt("robinhood", tx.hash, { timeoutMs: 180_000 });
    if (rc?.status !== 1) throw new Error("The deployment failed on chain.");
    await api.post("pass/config", { hash: tx.hash });
    toast("The Holder Pass is live.", "ok", 7000);
  });
  const mintPass = () => run("Minting…", async () => {
    const hash = await sendTx("robinhood", { to: st.pass.pass, data: PASS.encodeFunctionData("mint"), value: "0" });
    const rc = await waitReceipt("robinhood", hash);
    if (rc?.status !== 1) throw new Error("The mint failed on chain.");
    toast("Your Holder Pass is minted.", "ok", 6000);
  });
  const burnPass = () => run("Burning…", async () => {
    if (!(await review({ title: "Burn your pass?", summary: "It stops counting in votes. You can mint a new one later while you hold the minimum.", confirmLabel: "Burn it", danger: true }))) return;
    const hash = await sendTx("robinhood", { to: st.pass.pass, data: PASS.encodeFunctionData("burn"), value: "0" });
    const rc = await waitReceipt("robinhood", hash);
    if (rc?.status !== 1) throw new Error("The burn failed on chain.");
    toast("Pass burned.", "ok");
  });

  /* ---------- votes ---------- */
  function votesTab() {
    const v = st.votes, p = st.pass;
    if (!v || !p) return clear(body, h("div", { class: "sk", style: { height: "240px" } }));
    const items = [];
    if (v.admin && p.deployed) {
      const t = h("input", { class: "input", placeholder: "Question, for example: Next flywheel split?", maxlength: "140" });
      const o = h("textarea", { class: "input", rows: "3", placeholder: "One option per line (2 to 5)" });
      const d = h("input", { class: "input", inputmode: "numeric", value: "3", "aria-label": "Days" });
      items.push(h("div", { class: "panel sd-panel so-card" }, h("h3", {}, "New proposal (admins)"), t, o, h("div", { class: "fw-row" }, h("span", { class: "fine" }, "Open for days"), d,
        h("button", { class: "btn blue", type: "button", disabled: !!st.busy, onclick: () => run("Opening…", async () => { await api.post("votes", { title: t.value, options: o.value.split("\n"), days: Number(d.value) }); toast("Proposal open.", "ok"); }) }, "Open the vote"))));
    }
    if (!p.deployed) items.push(h("div", { class: "panel sd-panel so-card" }, h("p", { class: "muted" }, "Votes start once the Holder Pass is deployed.")));
    else if (!v.proposals.length) items.push(h("div", { class: "panel sd-panel so-card" }, h("p", { class: "muted" }, "No proposals yet.")));
    for (const x of v.proposals) {
      const total = x.tally.reduce((s, n) => s + n, 0) || 1;
      const canVote = x.open && p.me?.passId && p.me.active && p.me.mintedBlock < x.startBlock;
      items.push(h("div", { class: "panel sd-panel so-card" },
        h("div", { class: "so-li-h" }, h("b", {}, x.title), h("span", { class: "chip" }, x.open ? `open · ${Math.max(0, Math.ceil((x.endsAt - Date.now()) / 3600_000))} h left` : x.final ? "closed · final" : "closed")),
        h("div", { class: "so-opts" }, x.options.map((name, i) => h("div", { class: "so-opt" },
          h("div", { class: "so-opt-h" }, h("span", {}, name), h("b", {}, `${x.tally[i]} vote${x.tally[i] === 1 ? "" : "s"}`)), h("i", { style: { width: `${(x.tally[i] / total) * 100}%` } }),
          canVote ? h("button", { class: "btn sm", type: "button", disabled: !!st.busy, onclick: () => vote(x, i) }, "Vote") : null))),
        h("p", { class: "fine", style: { margin: 0 } }, `${x.counted} counted of ${x.cast} cast · passes minted before block ${x.startBlock} and still holding the minimum · `, h("a", { class: "ulink", href: `/api/votes/${x.id}`, target: "_blank", rel: "noopener" }, "every signed vote (JSON)")),
        x.open && wallet.address && !canVote ? h("p", { class: "fine" }, !p.me?.passId ? "Mint a Holder Pass to vote in the next proposals." : !p.me.active ? "Your wallet is under the minimum right now." : "Your pass was minted after this vote opened; it counts from the next one.") : null));
    }
    clear(body, ...items);
  }
  const vote = (x, option) => run("Signing…", async () => {
    const signer = await signerFor("robinhood");
    const signature = await signer.signTypedData(st.pass.domain, st.pass.types, { proposal: x.id, option, voter: wallet.address });
    await api.post(`votes/${x.id}/vote`, { option, voter: wallet.address, signature });
    toast(`Vote signed: ${x.options[option]}. No transaction, no gas.`, "ok", 6000);
  });
  function mine(s) {
    const box = h("div", { class: "panel sd-panel so-card" }, h("h3", {}, "Your X account"));
    if (!s.configured) box.append(h("p", { class: "muted" }, "Sign in with X is not configured on this server yet."));
    else if (!wallet.address) box.append(h("p", { class: "muted" }, "Connect and sign in with your wallet, then link your X account to it."), h("button", { class: "btn primary", type: "button", onclick: openConnect }, "Connect wallet"));
    else if (!wallet.session) box.append(h("p", { class: "muted" }, "Sign in with your wallet first (one signature, no transaction). Then link X."), h("button", { class: "btn primary", type: "button", onclick: async () => { try { await signIn(); load(); } catch (e) { toast(e.message, "error"); } } }, "Sign in"));
    else if (st.me?.x) {
      const x = st.me.x;
      box.append(h("div", { class: "so-who" }, x.avatar ? h("img", { src: x.avatar, alt: "", width: 40, height: 40 }) : null,
        h("div", {}, h("b", {}, x.name || x.username), h("a", { class: "ulink", href: `https://x.com/${encodeURIComponent(x.username)}`, target: "_blank", rel: "noopener" }, `@${x.username}`)),
        h("span", { class: "fine" }, `linked to ${short(wallet.address)}`)),
        h("button", { class: "btn sm", type: "button", onclick: async () => { await api.post("x/unlink", {}).catch((e) => toast(e.message, "error")); load(); } }, "Unlink"));
    } else box.append(h("p", { class: "muted" }, `Link an X account to ${short(wallet.address)}. Troya reads only your public profile (name, handle, picture); it never posts for you.`),
      h("a", { class: "btn primary", href: "/api/x/login?for=link" }, "Sign in with X"));
    return box;
  }
  function troya(s) {
    const u = s.usage || {}, c = s.caps || {};
    const bar = (k, label) => h("div", { class: "so-use" }, h("span", {}, label), h("b", {}, `${u[k] || 0} / ${c[k]}`), h("i", { style: { width: `${Math.min(100, ((u[k] || 0) / (c[k] || 1)) * 100)}%` } }));
    const modeLabel = { off: "Off", draft: "Draft: replies are written but not posted", live: "Live: replies are posted" }[s.mode] || s.mode;
    return h("div", { class: "panel sd-panel so-card" },
      h("h3", {}, "Troya on X"),
      s.bot ? h("p", {}, "Answering mentions of ", h("a", { class: "ulink", href: `https://x.com/${s.bot.username}`, target: "_blank", rel: "noopener" }, `@${s.bot.username}`), ` · ${modeLabel} · checked ${ago(s.lastPoll)}, every ${s.pollEveryMin} min`)
        : h("div", {}, h("p", { class: "muted" }, `@${s.expected} has not authorized Troya yet. Sign in as @${s.expected} on X first, then press the button (any other account is refused).`),
          s.configured ? h("a", { class: "btn primary", href: "/api/x/login?for=bot" }, `Connect @${s.expected}`) : null),
      s.lastError ? h("p", { class: "fine down" }, `Last error: ${s.lastError}`) : null,
      h("div", { class: "so-uses" }, bar("reads", "Posts read today"), bar("posts", "Replies posted today"), bar("search", "Searches today"), bar("users", "Sign-ins today")),
      s.admin ? h("div", { class: "so-admin" }, h("span", { class: "fine" }, "Admin · mode"),
        seg([{ value: "off", label: "Off" }, { value: "draft", label: "Draft" }, { value: "live", label: "Live" }], s.mode, async (v) => {
          try { await api.post("x/mode", { mode: v }); toast(`Troya on X: ${v}`, "ok"); load(); } catch (e) { toast(e.message, "error"); }
        })) : null,
      s.posted?.length ? h("div", { class: "so-posted" }, h("span", { class: "fine" }, "Latest replies"), s.posted.map((p) => h("a", { class: "ulink", href: `https://x.com/${s.bot?.username || "Troyaagent"}/status/${p.replyId}`, target: "_blank", rel: "noopener" }, `to @${p.author || "someone"} · ${ago(p.at)}`))) : null);
  }
  function logBox() {
    return h("div", { class: "panel sd-panel so-card" }, h("h3", {}, "Mentions and drafts (admins)"),
      !st.log.length ? h("p", { class: "muted" }, "Nothing yet. The first check only marks where to start, so old mentions are never answered.")
        : h("div", { class: "so-log" }, st.log.map((x) => h("div", { class: `so-li ${x.status}` },
          h("div", { class: "so-li-h" }, h("b", {}, `@${x.author || "?"}`), h("span", { class: `chip` }, x.status), h("span", { class: "fine" }, ago(x.at)), h("a", { class: "ulink fine", href: `https://x.com/i/web/status/${x.id}`, target: "_blank", rel: "noopener" }, "post")),
          h("p", { class: "so-q" }, x.text), x.reply ? h("p", { class: "so-a" }, x.reply) : h("p", { class: "fine" }, x.why || "")))));
  }

  const off = onWallet(() => load());
  await load();
  const t = setInterval(() => { if (!document.hidden) load(); }, 60_000);
  return () => { alive = false; off(); clearInterval(t); };
}
