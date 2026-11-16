// Community page: the report form (kind, words, up to three screenshots, scaled down in the browser before upload)
// and the copy button on the contract address.
const $ = (s, el = document) => el.querySelector(s);
const form = $("[data-cm-form]");
const MAX = 3, MAX_BYTES = 3 * 1024 * 1024;
const shots = [];   // data URLs

// big screenshots are redrawn at most 1800 px wide as JPEG, so a phone capture uploads fast and stays readable
function shrink(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error("Screenshots must be PNG, JPEG or WebP."));
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 1800 / img.naturalWidth);
      if (k === 1 && file.size <= 1.5 * 1024 * 1024) { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); return; }
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", 0.86);
      if (out.length * 0.75 > MAX_BYTES) return reject(new Error("That screenshot is too large, even scaled down."));
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}

if (form) {
  const drop = $("[data-cm-drop]", form), file = $("[data-cm-file]", form), thumbs = $("[data-cm-thumbs]", form);
  const send = $("[data-cm-send]", form), done = $("[data-cm-done]", form);
  const say = (html, err = false) => { done.hidden = false; done.className = `cm-done${err ? " err" : ""}`; done.innerHTML = html; };
  const paint = () => {
    thumbs.replaceChildren(...shots.map((d, i) => {
      const box = document.createElement("div"); box.className = "cm-thumb";
      const im = document.createElement("img"); im.src = d; im.alt = `Screenshot ${i + 1}`;
      const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", `Remove screenshot ${i + 1}`);
      x.onclick = () => { shots.splice(i, 1); paint(); };
      box.append(im, x); return box;
    }));
  };
  const addFiles = async (list) => {
    for (const f of [...list]) {
      if (shots.length >= MAX) { say("Up to three screenshots.", true); break; }
      try { shots.push(await shrink(f)); } catch (e) { say(e.message, true); }
    }
    paint();
  };
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  file.addEventListener("change", () => { addFiles(file.files); file.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer?.files || []));
  form.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (fs.length) { e.preventDefault(); addFiles(fs); } });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const message = String(fd.get("message") || "").trim();
    if (message.length < 10) { say("Tell us a little more: at least a sentence.", true); form.message.focus(); return; }
    if (/\b(?:[a-z]+\s+){11,23}[a-z]+\b/i.test(message) && /seed|phrase|mnemonic|recovery/i.test(message)) { say("That looks like it may contain a seed phrase. Remove it: the team never needs one.", true); return; }
    send.disabled = true; send.textContent = "Sending…";
    try {
      const r = await fetch("/api/community/report", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ kind: fd.get("kind"), message, page: fd.get("page"), contact: fd.get("contact"), website: fd.get("website"), images: shots }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Could not send (${r.status}).`);
      form.reset(); shots.length = 0; paint();
      say(`Sent. Your reference is <b>#${d.id}</b>. The team reads every report; quote the number in the Telegram group if you want to follow up.`);
    } catch (err) { say(String(err.message || err).replace(/[<>&]/g, ""), true); }
    send.disabled = false; send.textContent = "Send to the team";
  });
}

document.querySelectorAll("[data-cm-copy]").forEach((b) => b.addEventListener("click", async () => {
  const label = b.querySelector("b");
  try { await navigator.clipboard.writeText(b.dataset.cmCopy); label.textContent = "Copied"; } catch { label.textContent = "Select it"; }
  setTimeout(() => (label.textContent = "Copy"), 1600);
}));
