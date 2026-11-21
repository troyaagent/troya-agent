// Community chat inside the app (community request, 21 Nov 2026). Reading is public; posting needs the wallet sign-in.
// Every message is from a signed-in wallet: Troya's bots never post here (server/chat.mjs refuses a message that speaks as
// Troya, its bots or the team). The server checks links (troya.codes only), length, rate and the Telegram group's spam
// and scam rules; this file only shows its answer.
//   mountChat(document.body)          a "Community" button above the Guide orb that opens a floating panel (every page)
//   mountChat(el, { inline: true })   the same panel drawn inside el (e.g. a Desk section)
// Returns a stop function. New messages are read every 4 s while the panel is open and every 30 s while it is closed
// (for the unread count); nothing is read while the tab is hidden.
import { h, clear, toast, ago, short, modal } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, onWallet, signIn } from "/agent/js/wallet.js";
import { chromeIcon } from "./chrome-icons.js";
import { pulseCss } from "./pulse.js";

const MAX = 280;
const OPEN_MS = 4_000, CLOSED_MS = 30_000;
const SEEN = "troya.chat.seen";
const lc = (s) => String(s || "").toLowerCase();
const seenGet = () => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch { return 0; } };
const seenSet = (v) => { try { localStorage.setItem(SEEN, String(v)); } catch {} };
const STROKE = { chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z", close: "M18 6 6 18M6 6l12 12", send: "M22 2 11 13M22 2l-7 20-4-9-9-4z" };
function ico(name) {
  const c = chromeIcon(name);
  if (c) return c;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("fill", "none"); el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.6"); el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); el.setAttribute("aria-hidden", "true");
  el.innerHTML = STROKE[name].split(/(?=M)/).map((d) => `<path d="${d}"/>`).join("");
  return el;
}
// a soft colour from the wallet address, so the same wallet reads the same at a glance (no picture, no emoji)
function avatar(addr) {
  const a = lc(addr), hue = [...a.slice(2, 14)].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 11);
  return h("span", { class: "cc-av", "aria-hidden": "true", style: { background: `linear-gradient(135deg, hsl(${hue} 55% 58%), hsl(${(hue + 50) % 360} 50% 26%))` } });
}
// message text as DOM: troya.codes links and contract addresses become links inside the app; everything else is plain text
const LINKY = /(?:https?:\/\/)?(?:www\.)?troya\.codes(?:\/[^\s<>"']*)?|\b0x[0-9a-fA-F]{40}\b/gi;
function body(text) {
  const out = [];
  let i = 0;
  for (const m of String(text).matchAll(LINKY)) {
    if (m.index > i) out.push(text.slice(i, m.index));
    const raw = m[0].replace(/[),.;:!?]+$/, "");
    if (/^0x/i.test(raw)) out.push(h("a", { class: "cc-ca", href: `#/token/${raw}`, title: "Open this coin in Troya" }, raw));
    else {
      let href = null;
      try { const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); if (/^(www\.)?troya\.codes$/i.test(u.hostname)) href = `${u.pathname}${u.search}${u.hash}` || "/"; } catch {}
      out.push(href ? h("a", { href, rel: "noopener" }, raw) : raw);
    }
    out.push(m[0].slice(raw.length));
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

export function mountChat(host = document.body, { inline = false } = {}) {
  pulseCss();
  const floating = !inline;
  let seq = 0, me = null, open = !floating, alive = true, timer = 0, busy = false, sending = false, lastId = 0, expired = false, first = true;
  const nodes = new Map();          // id → element

  /* ---------- the panel ---------- */
  const list = h("div", { class: "cc-list", role: "log", "aria-live": "polite", "aria-label": "Community messages" });
  const empty = h("div", { class: "cc-empty" }, h("b", {}, "No messages yet"), "Say hello. Everyone can read this chat; posting needs a wallet sign-in.");
  const jump = h("button", { class: "cc-jump", type: "button", hidden: true, onclick: () => { list.scrollTop = list.scrollHeight; jump.hidden = true; } }, "New messages");
  const note = h("p", { class: "cc-note", role: "status" });
  const input = h("textarea", { class: "cc-in", rows: "1", maxlength: String(MAX), placeholder: "Say something…", "aria-label": "Message", autocomplete: "off", spellcheck: "true" });
  const count = h("span", {}, `0/${MAX}`);
  const sendBtn = h("button", { class: "btn primary cc-send", type: "submit", "aria-label": "Send" }, ico("send"));
  const form = h("form", { class: "cc-row", onsubmit: (e) => { e.preventDefault(); send(); } }, input, sendBtn);
  const foot = h("div", { class: "cc-f" });
  const closeBtn = floating ? h("button", { class: "cc-x", type: "button", "aria-label": "Close chat", onclick: () => setOpen(false) }, ico("close")) : null;
  const panel = h("section", { class: `cc-panel ${floating ? "cc-float" : "cc-inline"}`, role: floating ? "dialog" : "region", "aria-label": "Community chat" },
    h("header", { class: "cc-h" }, ico("chat"), h("div", { class: "cc-t" }, h("b", {}, "Community"), h("small", {}, "Public chat · people with signed-in wallets")), closeBtn),
    list, note, foot);
  list.append(empty, jump);

  /* ---------- the floating button ---------- */
  const badge = h("span", { class: "cc-badge", hidden: true });
  const fab = floating ? h("button", { class: "cc-fab", type: "button", "aria-label": "Open the community chat", onclick: () => setOpen(true) }, ico("chat"), h("span", { class: "cc-fab-t" }, "Community"), badge) : null;
  if (floating) host.append(fab, panel); else clear(host, panel);

  function setOpen(v) {
    open = !!v;
    if (!floating) return;
    document.body.classList.toggle("cc-open", open);
    panel.setAttribute("aria-hidden", String(!open));
    if (open) { markSeen(); requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; if (canPost()) input.focus({ preventScroll: true }); }); }
    schedule(open ? 50 : CLOSED_MS);
  }
  if (floating) panel.setAttribute("aria-hidden", "true");
  const onKey = (e) => { if (floating && open && e.key === "Escape" && !document.querySelector(".modal-bg")) setOpen(false); };
  document.addEventListener("keydown", onKey);

  /* ---------- composer: connect, sign in, muted, or write ---------- */
  // the server's answer decides (a live sign-in cookie), so a session still counts while the wallet extension reconnects
  const canPost = () => !!me && !expired && !me.muted;
  const myAddr = () => lc(me?.address || wallet.address);
  // repaint the composer only when what it shows changes: re-inserting the textarea every poll blurred it
  // (on phones the keyboard closed every 4 s and the half-written message lost focus)
  let footKey = "";
  function paintFoot(force = false) {
    const key = !me || expired ? `gate|${wallet.address ? 1 : 0}` : me.muted ? `muted|${me.muted.until || ""}|${me.muted.why || ""}` : "write";
    if (!force && key === footKey && foot.firstChild) return;
    footKey = key;
    const rules = h("div", { class: "cc-meta" }, h("span", {}, "No links but troya.codes · no promos or DM asks · admins never DM first"), count);
    if (!me || expired) {
      clear(foot, h("div", { class: "cc-gate" },
        h("button", { class: "btn primary", type: "button", onclick: async () => { try { await signIn(); } catch (e) { toast(e.message, "error"); } } }, wallet.address ? "Sign in to post" : "Connect to post"),
        h("span", {}, "Reading is open to everyone. Your wallet address shows next to what you write.")));
      return;
    }
    if (me?.muted) {
      clear(foot, h("p", { class: "cc-note warn" }, me.muted.until ? `This wallet can post again ${new Date(me.muted.until).toLocaleString()}. ${me.muted.why || ""}`.trim() : "This wallet can't post here."));
      return;
    }
    clear(foot, form, rules);
  }
  const fit = () => { input.style.height = "auto"; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  input.addEventListener("input", () => {
    const n = [...input.value].length;
    count.textContent = `${n}/${MAX}`;
    count.classList.toggle("over", n > MAX);
    fit();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  let noteT = 0;
  function say(text, kind = "") { clearTimeout(noteT); note.className = `cc-note${kind ? " " + kind : ""}`; note.textContent = text || ""; if (text) noteT = setTimeout(() => { note.textContent = ""; }, 7000); }

  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    if ([...text].length > MAX) { say(`Keep it to ${MAX} characters.`, "err"); return; }
    sending = true; sendBtn.disabled = true;
    try {
      const r = await api.post("chat", { text });
      input.value = ""; count.textContent = `0/${MAX}`; fit();
      add([r.message]);
      list.scrollTop = list.scrollHeight;
      say("");
    } catch (e) {
      if (e.status === 401) { expired = true; paintFoot(); say("Your sign-in has ended. Sign in again to post.", "err"); }
      else if (e.status === 403 && e.data?.muted) { me = { ...(me || {}), muted: { until: e.data.muted.until, why: "" } }; paintFoot(); }
      else say(e.message || "The message was not sent.", "err");
    } finally { sending = false; sendBtn.disabled = false; }
  }

  /* ---------- messages ---------- */
  function msgEl(m, prev) {
    const mine = !!myAddr() && lc(m.from) === myAddr();
    const cont = prev && lc(prev.from) === lc(m.from) && m.at - prev.at < 5 * 60_000;
    const mod = me?.admin && !mine ? h("span", { class: "cc-mod" },
      h("button", { type: "button", onclick: () => remove(m) }, "Remove"),
      m.team ? null : h("button", { type: "button", onclick: () => ban(m) }, "Ban")) : null;
    const el = h("div", { class: `cc-msg${mine ? " mine" : ""}${m.team ? " team" : ""}${cont ? " cc-cont" : ""}`, "data-id": String(m.id), "data-from": lc(m.from), "data-at": String(m.at) },
      avatar(m.from),
      h("div", { class: "cc-m-h" },
        h("b", { class: "cc-name", title: m.from }, m.name || short(m.from)),
        m.team ? h("span", { class: "cc-tag team", title: "Troya team (a person, not a bot)" }, "Team") : null,
        m.holder ? h("span", { class: "cc-tag", title: "Holds at least 1,000,000 $TROYA" }, "Holder") : null,
        // $TROYA staking tier, read once at post time (sent only once the stake perks are on)
        /^(bronze|silver|gold)$/.test(m.stake || "") ? h("span", { class: `cc-tag stk-badge t-${m.stake}`, title: `${m.stake[0].toUpperCase()}${m.stake.slice(1)} tier $TROYA staker` }, `${m.stake[0].toUpperCase()}${m.stake.slice(1)}`) : null,
        h("time", { class: "cc-time", datetime: new Date(m.at).toISOString(), title: new Date(m.at).toLocaleString() }, ago(m.at)),
        mod),
      h("div", { class: "cc-m-t" }, body(m.text)));
    el._m = m;
    return el;
  }
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function add(msgs) {
    const stick = atBottom();
    let added = 0;
    for (const m of msgs || []) {
      if (!m || nodes.has(m.id)) continue;
      const prevEl = [...nodes.values()].at(-1);
      const el = msgEl(m, prevEl?._m);
      list.insertBefore(el, jump);
      nodes.set(m.id, el);
      lastId = Math.max(lastId, m.id);
      added++;
    }
    while (nodes.size > 200) { const [k, el] = nodes.entries().next().value; el.remove(); nodes.delete(k); }
    empty.hidden = nodes.size > 0;
    if (added) { if (stick || !open) list.scrollTop = list.scrollHeight; else jump.hidden = false; }
    return added;
  }
  function drop(ids) {
    let n = 0;
    for (const id of ids || []) { const el = nodes.get(id); if (el) { el.remove(); nodes.delete(id); n++; } }
    if (n) repaintAll();   // the next message may have hung under the removed one's name
    empty.hidden = nodes.size > 0;
  }
  function markSeen() { seenSet(Math.max(seenGet(), lastId)); badge.hidden = true; }
  function paintBadge() {
    if (!floating) return;
    if (open) { markSeen(); return; }
    const seen = seenGet(), mineLc = myAddr();
    const n = [...nodes.values()].filter((el) => el._m.id > seen && lc(el._m.from) !== mineLc).length;
    badge.hidden = !n; badge.textContent = n > 9 ? "9+" : String(n);
  }
  function repaintAll() {
    const msgs = [...nodes.values()].map((el) => el._m);
    for (const el of nodes.values()) el.remove();
    nodes.clear();
    add(msgs);
  }

  /* ---------- moderation (admins) ---------- */
  async function remove(m) {
    try { await api.del(`chat/${m.id}`); drop([m.id]); toast("Message removed.", "ok"); }
    catch (e) { toast(e.message, "error"); }
  }
  function ban(m) {
    const purge = h("input", { type: "checkbox", checked: true });
    const go = async (hours) => {
      try {
        const r = await api.post("chat/ban", { address: m.from, hours, purge: purge.checked, reason: "Banned from the web chat" });
        dlg.close();
        toast(`Banned ${m.x ? `@${m.x}` : short(m.from)}${r.purged ? `, ${r.purged} message${r.purged === 1 ? "" : "s"} removed` : ""}.`, "ok");
        poll(true);
      } catch (e) { toast(e.message, "error"); }
    };
    const dlg = modal({ title: "Ban from the chat", body: h("div", { class: "cc-ban" },
      h("p", {}, `${m.x ? `@${m.x} (${short(m.from)})` : short(m.from)} will not be able to post. Reading stays open.`),
      h("label", {}, purge, "Also remove their messages"),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => go(24) }, "24 hours"),
        h("button", { class: "btn", type: "button", onclick: () => go(24 * 7) }, "7 days"),
        h("button", { class: "btn danger", type: "button", onclick: () => go(null) }, "Until lifted"))) });
  }

  /* ---------- reading ---------- */
  async function poll(force = false) {
    if (!alive || busy || (document.hidden && !force)) return;
    busy = true;
    try {
      const d = await api.get(`chat?since=${seq}`);
      if (!alive) return;
      const was = `${me?.address}|${!!me?.admin}`;
      me = d.me || null;
      if (me) expired = false;
      if (d.reset) { for (const el of nodes.values()) el.remove(); nodes.clear(); }
      add(d.messages);
      drop(d.removed);
      if (Number.isFinite(d.seq)) seq = d.seq;
      // a first visit starts with nothing unread: the badge counts what is written after it
      if (first) { first = false; if (!seenGet()) seenSet(lastId); }
      if (`${me?.address}|${!!me?.admin}` !== was) repaintAll();   // "mine" and the admin links follow who is signed in
      paintFoot();
      paintBadge();
    } catch { /* the next read tries again; what is shown stays */ }
    finally { busy = false; }
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (!alive) return;
    timer = setTimeout(async () => { await poll(); schedule(open ? OPEN_MS : CLOSED_MS); }, ms);
  }
  const onVis = () => { if (!document.hidden) schedule(50); };
  document.addEventListener("visibilitychange", onVis);
  // ages ("3m") move on while the panel is open
  const clock = setInterval(() => { if (open && !document.hidden) for (const el of nodes.values()) { const t = el.querySelector(".cc-time"); if (t) t.textContent = ago(el._m.at); } }, 30_000);

  let lastKey = `${wallet.address}|${!!wallet.session}`;
  const offWallet = onWallet(() => {
    const k = `${wallet.address}|${!!wallet.session}`;
    if (k === lastKey) return;
    lastKey = k;
    expired = false;
    paintFoot();
    poll(true).then(() => repaintAll());   // "mine" and the admin links follow the wallet
  });
  paintFoot();
  poll(true);
  schedule(open ? OPEN_MS : CLOSED_MS);

  return () => {
    alive = false;
    clearTimeout(timer); clearInterval(clock); clearTimeout(noteT);
    offWallet();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVis);
    if (floating) { fab.remove(); panel.remove(); document.body.classList.remove("cc-open"); } else panel.remove();
  };
}
