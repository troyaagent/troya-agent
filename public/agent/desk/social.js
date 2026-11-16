// F20 · Social layer in the app.
//   X              link your X account to your wallet (Sign in with X); Troya on X: the @Troyaagent account, its mode
//                  (off, draft, live), today's X usage against the daily caps, the replies it posted; admins see every
//                  mention and draft and switch the mode
import { h, clear, useCss, toast, pageHead, seg, short } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, openConnect, signIn } from "/agent/js/wallet.js";

const NOTE = {
  linked: ["Your X account is linked to this wallet.", "ok"], bot: ["@Troyaagent is connected: Troya can read and answer its mentions.", "ok"],
  signin: ["Sign in with your wallet first, then link X.", "error"], expired: ["That sign-in took too long. Try again.", "error"],
  cancelled: ["The X sign-in was cancelled.", "error"], failed: ["X did not finish the sign-in. Try again.", "error"], busy: ["Today's X budget is used up. Try again tomorrow.", "error"],
};
const ago = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };

export async function mount(view, ctx) {
  useCss("perps"); useCss("swap");
  let alive = true;
  const st = { me: undefined, status: null, log: null };
  const body = h("div", { class: "so-body" });
  clear(view, h("div", { class: "dk so" },
    pageHead("Social", "Your X account on Troya, and Troya answering on X. Every X call counts against one small daily budget."),
    body));
  const q = ctx.query?.x;
  if (q === "notbot") toast(`That was @${ctx.query.as || "another account"}. Only @Troyaagent can connect Troya on X.`, "error", 8000);
  else if (NOTE[q]) toast(NOTE[q][0], NOTE[q][1], 7000);
  if (q) history.replaceState(null, "", "#/social");

  async function load() {
    const [me, status] = await Promise.all([
      wallet.session ? api.get("x/me").catch(() => null) : Promise.resolve(null),
      api.get("x/status").catch((e) => ({ error: e.message })),
    ]);
    st.me = me; st.status = status;
    st.log = status?.admin ? (await api.get("x/log").catch(() => null))?.log || [] : null;
    if (alive) paint();
  }

  function paint() {
    const s = st.status;
    if (!s) return clear(body, h("div", { class: "sk", style: { height: "240px" } }));
    clear(body, mine(s), troya(s), st.log ? logBox() : null);
  }
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
