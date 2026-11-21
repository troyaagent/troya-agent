// Profiles (community request, 21 Nov 2026): a username, a short bio, an avatar and a banner per wallet. The server
// (server/profile.mjs) checks every rule and re-encodes every picture; this file only draws and asks.
//   profileHeader()                    the header card the Portfolio page shows (banner, avatar, name, badges, bio, actions)
//   openProfileEditor({ onSaved })     the Edit profile dialog (sign-in first)
//   avatarFor(address, url, cls)       the profile picture, or the wallet's colour when it has none (the chat uses it too)
//   profileHref(username, address)     the in-app link to a wallet's page: #/u/<name>, else #/portfolio?address=0x…
import { h, clear, toast, short, copyText, modal, useCss, icon, debounce } from "./ui.js";
import { api } from "./api.js";
import { wallet, signIn } from "./wallet.js";

const lc = (s) => String(s || "").toLowerCase();
const MB = 1024 * 1024;
const KIND = { avatar: { max: MB, w: 256, h: 256, label: "photo" }, banner: { max: 2 * MB, w: 1500, h: 500, label: "banner" } };
const IMG = /^\/api\/profile\/img\/[0-9a-f]{32}\.webp$/;
const TYPES = /^image\/(png|jpeg|webp)$/;
const STROKE = {
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  camera: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
};
function ico(name) {
  if (!STROKE[name]) return icon(name);
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("fill", "none"); el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.6"); el.setAttribute("stroke-linecap", "round"); el.setAttribute("stroke-linejoin", "round"); el.setAttribute("aria-hidden", "true");
  el.innerHTML = STROKE[name].split(/(?=M)/).map((d) => `<path d="${d}"/>`).join("");
  return el;
}

/* ---------- shared pieces ---------- */
// the same colour the chat has always given a wallet without a picture, so a wallet reads the same everywhere
export function hueOf(addr) { return [...lc(addr).slice(2, 14)].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 11); }
export function avatarFor(address, url, cls = "pr-av") {
  if (url && IMG.test(url)) return h("img", { class: cls, src: url, alt: "", loading: "lazy", decoding: "async", draggable: "false" });
  const hue = hueOf(address);
  return h("span", { class: cls, "aria-hidden": "true", style: { background: `linear-gradient(135deg, hsl(${hue} 55% 58%), hsl(${(hue + 50) % 360} 50% 26%))` } });
}
export const profileHref = (username, address) => (username ? `#/u/${encodeURIComponent(username)}` : `#/portfolio?address=${address}`);
const shareUrl = (username, address) => `${location.origin}${location.pathname}${profileHref(username, address)}`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// no banner yet: the wallet's own hue as room light (a custom property needs setProperty: h()'s style object skips it)
function plainBanner(address) {
  const el = h("div", { class: "pr-banner pr-banner-def" });
  el.style.setProperty("--pr-h", String(hueOf(address)));
  return el;
}

// signed-in facts about the viewer (admin or not), read once per session
let meMemo = null;
async function viewerMe() {
  if (!wallet.session) return null;
  const key = lc(wallet.session.address || wallet.address);
  if (meMemo?.key === key) return meMemo.p;
  const p = api.get("profile/me").catch(() => null);
  meMemo = { key, p };
  return p;
}

/* ---------- the header ---------- */
export function profileHeader({ onEdit } = {}) {
  useCss("profile");
  const el = h("section", { class: "pr-card", "aria-label": "Profile", hidden: true });
  let cur = { address: null, own: false, data: null }, seq = 0;

  function skeleton(address) {
    clear(el,
      plainBanner(address),
      h("div", { class: "pr-body" },
        h("div", { class: "pr-av-ring" }, avatarFor(address, null)),
        h("div", { class: "pr-id" }, h("div", { class: "sk", style: { height: "26px", width: "min(220px, 60%)" } }), h("div", { class: "sk", style: { height: "14px", width: "140px", marginTop: "10px" } }))));
  }
  function tag(text, cls = "", title = "") { return h("span", { class: `pr-tag${cls ? " " + cls : ""}`, title: title || null }, text); }
  function paint(d, own, admin) {
    const p = d.profile, b = d.badges || {}, addr = d.address;
    const banner = p?.banner
      ? h("div", { class: "pr-banner" }, h("img", { src: p.banner, alt: "", decoding: "async" }))
      : plainBanner(addr);
    const tags = h("span", { class: "pr-tags" },
      b.team ? tag("Team", "team", "Troya team (a person, not a bot)") : null,
      b.holder ? tag("Holder", "", "Holds at least 1,000,000 $TROYA") : null,
      b.stake ? tag(cap(b.stake), `stk-badge t-${b.stake}`, `${cap(b.stake)} tier $TROYA staker`) : null,
      b.pass ? tag(`Pass #${b.pass}`, "", "Troya Holder Pass (soulbound)") : null,
      b.x ? h("a", { class: "pr-tag pr-x", href: `https://x.com/${b.x}`, target: "_blank", rel: "noopener nofollow", title: "X account linked with Sign in with X" }, `@${b.x}`) : null);
    const joined = p?.joined ? h("span", {}, `Joined ${new Date(p.joined).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`) : null;
    const acts = h("div", { class: "pr-acts" },
      own ? h("button", { class: "btn primary", type: "button", onclick: () => edit() }, ico("edit"), p?.username || p?.avatar ? "Edit profile" : "Set up profile") : null,
      h("button", { class: "btn", type: "button", onclick: () => copyText(shareUrl(p?.username, addr), "Profile link copied") }, ico("link"), "Copy link"),
      !own && admin ? h("button", { class: "btn ghost", type: "button", onclick: () => moderate(d) }, icon("shield"), "Moderate") : null);
    clear(el, banner,
      h("div", { class: "pr-body" },
        h("div", { class: "pr-av-ring" }, avatarFor(addr, p?.avatar)),
        h("div", { class: "pr-id" },
          h("h1", { class: "pr-name" }, h("b", { title: p?.username ? addr : null }, p?.username || short(addr)), tags),
          h("p", { class: "pr-addr" },
            h("button", { class: "pr-copy", type: "button", title: `Copy ${addr}`, onclick: () => copyText(addr, "Address copied") }, h("span", { class: "mono" }, short(addr)), icon("copy")),
            h("a", { class: "pr-ext", href: `https://robinhoodchain.blockscout.com/address/${addr}`, target: "_blank", rel: "noopener" }, "Explorer"),
            joined)),
        acts,
        p?.bio ? h("p", { class: "pr-bio" }, p.bio)
          : own ? h("p", { class: "pr-bio pr-bio-empty" }, "Add a name, a photo and a few words. They show on this page and next to what you write in the chat.") : null));
  }
  function edit() {
    if (onEdit) return onEdit();
    openProfileEditor({ onSaved: () => load(cur.address, { own: cur.own, quiet: true }) });
  }
  function moderate(d) { openModeration(d, () => load(cur.address, { own: cur.own, quiet: true })); }

  /** Shows the profile of `address` (null hides the card). own: the viewer's own wallet (Edit profile). → the data or null */
  async function load(address, { own = false, quiet = false } = {}) {
    const same = cur.address && address && lc(cur.address) === lc(address);
    cur = { address, own, data: same ? cur.data : null };
    if (!address) { el.hidden = true; clear(el); return null; }
    el.hidden = false;
    const id = ++seq;
    if (!same && !quiet) skeleton(address);
    let d;
    try { d = await api.get(`profile?address=${address}`); }
    catch (e) {
      if (id !== seq) return null;
      // the page still works without a profile: the wallet's own colour and its address
      paint({ address, profile: null, badges: {} }, own, false);
      if (e.status && e.status !== 404) console.warn("[profile]", e.message);
      return null;
    }
    if (id !== seq) return d;
    cur.data = d;
    const me = own ? null : await viewerMe();
    if (id !== seq) return d;
    paint(d, own, !!me?.limits?.admin);
    return d;
  }
  /** Finds a profile by its username. → { address, profile, badges } or null (and the card hidden) */
  async function loadName(name) {
    const id = ++seq;
    try {
      const d = await api.get(`profile?u=${encodeURIComponent(name)}`);
      if (id !== seq) return d;
      cur = { address: d.address, own: false, data: d };
      el.hidden = false;
      paint(d, false, !!(await viewerMe())?.limits?.admin);
      return d;
    } catch { if (id === seq) { el.hidden = true; clear(el); } return null; }
  }
  return { el, load, loadName, get data() { return cur.data; } };
}

/* ---------- pictures before upload ---------- */
// A file within the limit goes up as it is (the server crops, resizes and re-encodes it). A bigger photo (a phone camera's,
// say) is first drawn here at the size the server keeps, centre-cropped exactly as the server would, so it still fits.
async function prepare(file, kind) {
  const k = KIND[kind];
  const type = TYPES.test(file.type) ? file.type : /\.png$/i.test(file.name) ? "image/png" : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : /\.webp$/i.test(file.name) ? "image/webp" : "";
  if (!type) throw new Error("Use a PNG, JPG or WebP image.");
  if (file.size <= k.max) return file.type === type ? file : new Blob([file], { type });
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bmp = null; }
  if (!bmp) throw new Error(`The ${k.label} is over ${k.max / MB} MB. Pick a smaller file.`);
  const scale = Math.max(k.w / bmp.width, k.h / bmp.height), sw = k.w / scale, sh = k.h / scale;
  const c = document.createElement("canvas");
  c.width = k.w; c.height = k.h;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, k.w, k.h);
  bmp.close?.();
  const blob = (t, q) => new Promise((r) => c.toBlob(r, t, q));
  let out = await blob("image/webp", 0.9);
  if (!out || out.type !== "image/webp") out = await blob("image/jpeg", 0.9);   // Safari draws no WebP
  if (!out || out.size > k.max) throw new Error(`The ${k.label} is over ${k.max / MB} MB. Pick a smaller file.`);
  return out;
}

/* ---------- the editor ---------- */
export async function openProfileEditor({ onSaved } = {}) {
  useCss("profile");
  try { await signIn(); } catch (e) { toast(e.message, "error"); return; }
  let me;
  try { me = await api.get("profile/me"); } catch (e) { toast(e.message, "error"); return; }
  meMemo = { key: lc(me.address), p: Promise.resolve(me) };
  const p = me.profile || {}, lim = me.limits || {}, rules = me.rules || {};
  const nameMax = rules.nameMax || 20, bioMax = rules.bioMax || 160;
  const urls = [];
  const pick = { avatar: { blob: null, remove: false }, banner: { blob: null, remove: false } };
  const shown = { avatar: p.avatar || null, banner: p.banner || null };

  // the preview: the banner at 3:1 with the photo over its lower edge, as on the page
  const bannerBox = h("div", { class: "pr-banner pr-ed-banner" });
  const avBox = h("div", { class: "pr-av-ring pr-ed-av" });
  const file = (kind) => h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true, onchange: async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const b = await prepare(f, kind);
      const u = URL.createObjectURL(b);
      urls.push(u);
      pick[kind] = { blob: b, remove: false };
      shown[kind] = u;
      paintArt();
      say("");
    } catch (err) { say(err.message, "err"); }
  } });
  const inputs = { avatar: file("avatar"), banner: file("banner") };
  const chip = (label, ic, onclick, extra = {}) => h("button", { class: "pr-chip-btn", type: "button", onclick, ...extra }, ic ? ico(ic) : null, label);
  const bannerActs = h("div", { class: "pr-ed-bn-acts" });
  const avActs = h("div", { class: "pr-ed-av-acts" });
  function paintArt() {
    clear(bannerBox, shown.banner ? h("img", { src: shown.banner, alt: "Banner preview" }) : null);
    bannerBox.classList.toggle("pr-banner-def", !shown.banner);
    bannerBox.style.setProperty("--pr-h", String(hueOf(me.address)));
    clear(avBox, shown.avatar ? h("img", { class: "pr-av", src: shown.avatar, alt: "Photo preview" }) : avatarFor(me.address, null));
    clear(bannerActs,
      chip(shown.banner ? "Change banner" : "Add banner", "image", () => inputs.banner.click()),
      shown.banner ? chip("Remove", "trash", () => { pick.banner = { blob: null, remove: !!p.banner }; shown.banner = null; paintArt(); }, { "aria-label": "Remove banner" }) : null);
    clear(avActs,
      h("button", { class: "btn sm", type: "button", onclick: () => inputs.avatar.click() }, ico("camera"), shown.avatar ? "Change photo" : "Add photo"),
      shown.avatar ? h("button", { class: "btn sm ghost", type: "button", onclick: () => { pick.avatar = { blob: null, remove: !!p.avatar }; shown.avatar = null; paintArt(); } }, "Remove photo") : null);
  }

  // the username, checked against the server's rules as it is typed
  const nameIn = h("input", { class: "input", type: "text", value: p.username || "", maxlength: String(nameMax), placeholder: "your_name", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": "pr-name-hint" });
  const nameHint = h("small", { class: "pr-hint", id: "pr-name-hint" });
  const renameNote = lim.fixUntil && p.username ? `Typo? You can still correct it until ${new Date(lim.fixUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. After that, the next change is possible ${new Date(lim.renameAt).toLocaleDateString([], { day: "numeric", month: "short" })}.`
    : lim.renameAt && p.username ? `Your next username change is possible ${new Date(lim.renameAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Letter case can change any time.`
    : `3 to ${nameMax} letters, numbers or _. You can change it once every ${lim.renameEveryDays || 7} days.`;
  let nameOk = true, checkSeq = 0;
  const setHint = (text, kind = "") => { nameHint.textContent = text; nameHint.className = `pr-hint${kind ? " " + kind : ""}`; };
  setHint(renameNote);
  const check = debounce(async () => {
    const v = nameIn.value.trim().replace(/^@/, "");
    const id = ++checkSeq;
    if (!v || lc(v) === lc(p.username)) { nameOk = true; setHint(renameNote); return; }
    try {
      const r = await api.get(`profile/check?u=${encodeURIComponent(v)}`);
      if (id !== checkSeq) return;
      nameOk = !!r.ok;
      setHint(r.ok ? `${v} is available.` : r.why, r.ok ? "ok" : "err");
    } catch { if (id === checkSeq) { nameOk = true; setHint(renameNote); } }
  }, 350);
  nameIn.addEventListener("input", () => {
    const v = nameIn.value;
    if (v && !/^@?[A-Za-z0-9_]*$/.test(v)) { nameOk = false; setHint("Use only letters, numbers and _.", "err"); return; }
    check();
  });

  const bioIn = h("textarea", { class: "input pr-bio-in", rows: "3", maxlength: String(bioMax), placeholder: "A few words about you", "aria-describedby": "pr-bio-hint" });
  bioIn.value = p.bio || "";
  const bioCount = h("span", {}, `${[...bioIn.value].length}/${bioMax}`);
  bioIn.addEventListener("input", () => { const n = [...bioIn.value].length; bioCount.textContent = `${n}/${bioMax}`; bioCount.classList.toggle("over", n > bioMax); });

  const note = h("p", { class: "pr-note", role: "status" });
  const say = (text, kind = "") => { note.textContent = text || ""; note.className = `pr-note${kind ? " " + kind : ""}`; };
  const saveBtn = h("button", { class: "btn primary", type: "button", onclick: () => save() }, "Save");
  const locked = lim.lockedUntil ? h("div", { class: "alert warn" }, `An admin locked this profile until ${new Date(lim.lockedUntil).toLocaleString()}.`) : null;
  if (locked) saveBtn.disabled = true;

  const body = h("div", { class: "pr-ed" },
    h("div", { class: "pr-ed-art" }, bannerBox, bannerActs, avBox, inputs.avatar, inputs.banner),
    avActs,
    h("label", { class: "field" }, h("span", {}, "Username"), nameIn, nameHint),
    h("label", { class: "field" }, h("span", {}, "Bio"), bioIn, h("small", { class: "pr-hint", id: "pr-bio-hint" }, bioCount, " · No links except troya.codes, no promotions or DM asks.")),
    h("p", { class: "fine pr-fine" }, `PNG, JPG or WebP. Photo up to 1 MB, shown at 256 × 256; banner up to 2 MB, shown at 1500 × 500 (3:1). Both are cropped to the centre and saved again on our server, without the camera, location or other data inside the file. ${lim.admin ? "" : `${lim.editsLeft ?? 5} of ${lim.editsPerHour || 5} changes left this hour.`}`),
    locked, note,
    h("div", { class: "row pr-ed-foot" }, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Cancel"), saveBtn));
  const dlg = modal({ title: p.username || p.avatar ? "Edit profile" : "Set up your profile", body, wide: true, onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)) });
  paintArt();

  let last = null;
  async function save() {
    const name = nameIn.value.trim().replace(/^@/, "");
    const bio = bioIn.value.trim();
    if (!nameOk) { say(nameHint.textContent || "Pick another username.", "err"); nameIn.focus(); return; }
    if ([...bio].length > bioMax) { say(`Keep the bio to ${bioMax} characters.`, "err"); return; }
    const text = {};
    if (name !== (p.username || "")) text.username = name;
    if (bio !== (p.bio || "")) text.bio = bio;
    const steps = [];
    for (const kind of ["avatar", "banner"]) {
      if (pick[kind].blob) steps.push([`Uploading the ${KIND[kind].label}…`, () => api.post(`profile/${kind}`, pick[kind].blob, { type: pick[kind].blob.type }), kind]);
      else if (pick[kind].remove) steps.push([`Removing the ${KIND[kind].label}…`, () => api.del(`profile/${kind}`), kind]);
    }
    if (Object.keys(text).length) steps.push(["Saving…", () => api.post("profile", text), "text"]);
    if (!steps.length) { dlg.close(); return; }
    saveBtn.disabled = true;
    let done = 0;
    try {
      for (const [label, run, what] of steps) {
        say(label);
        last = await run();
        done++;
        if (what === "avatar" || what === "banner") { pick[what] = { blob: null, remove: false }; p[what] = last.profile?.[what] || null; }
        else { p.username = last.profile?.username || null; p.bio = last.profile?.bio || ""; }
      }
      dlg.close();
      toast("Profile saved", "ok");
      onSaved?.(last?.profile || null);
    } catch (e) {
      say(e.message || "The profile could not be saved.", "err");
      if (done) onSaved?.(last?.profile || null);        // what did save shows on the page already
    } finally { saveBtn.disabled = !!locked; }
  }
}

/* ---------- admins: reset a profile ---------- */
function openModeration(d, after) {
  const p = d.profile || {}, who = p.username || short(d.address);
  const box = (k, label, has) => h("label", { class: "row pr-mod-row" }, h("input", { type: "checkbox", "data-k": k, checked: !!has, disabled: !has }), label);
  const rows = h("div", { class: "pr-mod" },
    box("username", `Username${p.username ? ` (${p.username})` : ""}`, p.username), box("bio", "Bio", p.bio), box("avatar", "Photo", p.avatar), box("banner", "Banner", p.banner));
  const block = h("input", { type: "checkbox", disabled: !p.username });
  const lock = h("select", { class: "select", "aria-label": "Lock edits" }, [["", "Do not change"], ["0", "Unlock"], ["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["365", "1 year"]].map(([v, t]) => h("option", { value: v }, t)));
  const reason = h("input", { class: "input", type: "text", maxlength: "140", placeholder: "Reason (kept in the admin log)" });
  const go = h("button", { class: "btn danger", type: "button", onclick: async () => {
    const fields = [...rows.querySelectorAll("input:checked")].map((x) => x.dataset.k);
    if (!fields.length && lock.value === "") { toast("Pick what to reset.", "error"); return; }
    go.disabled = true;
    try {
      await api.post("profile/admin/reset", { address: d.address, fields, block: block.checked, lockDays: lock.value === "" ? null : Number(lock.value), reason: reason.value.trim() || null });
      dlg.close(); toast(`Profile of ${who} reset.`, "ok"); after?.();
    } catch (e) { toast(e.message, "error"); go.disabled = false; }
  } }, "Reset");
  const dlg = modal({ title: "Moderate profile", body: h("div", { class: "pr-ed" },
    h("p", { style: { margin: 0 } }, `${who} · `, h("span", { class: "mono" }, short(d.address)), ". What is reset is removed for good; the chat shows the short address again at once."),
    rows,
    h("label", { class: "row pr-mod-row" }, block, "Block this username for good (otherwise nobody can take it for 30 days)"),
    h("label", { class: "field" }, h("span", {}, "Lock this wallet's edits"), lock),
    h("label", { class: "field" }, h("span", {}, "Reason"), reason),
    h("div", { class: "row pr-ed-foot" }, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Cancel"), go)) });
}
