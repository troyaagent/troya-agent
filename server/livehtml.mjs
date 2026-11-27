// Live numbers and proof tables written into pages as they are served, so a crawler or a checker with JavaScript off reads
// the same numbers the page shows after its scripts run (larpcheck audit, 21 Nov 2026: the homepage still carried an old
// burn figure in its HTML). server/proof.mjs fills this from the chain and from Troya's own records; server.mjs calls
// liveHtml() on every page it sends and adds liveTag() to the ETag, so a cached copy is never confirmed once a number moved.
// No imports: server.mjs loads this before the API modules.
//   <!--live:NAME-->fallback<!--/live:NAME-->       the whole block is replaced by fragment NAME (HTML built by proof.mjs)
//   <b data-live="KEY" data-num="…">fallback</b>   the text is replaced by value KEY (and data-num, read by count-up scripts)
const frags = new Map();
const vals = new Map();
let gen = 0;
// only these pages are rewritten; every other file goes out byte for byte
const PAGES = new Set(["/index.html", "/verify.html", "/proof.html", "/flywheel.html", "/stats.html", "/record.html"]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function setFragment(name, html) {
  if (typeof html !== "string" || frags.get(name) === html) return;
  frags.set(name, html); gen++;
}
export function setValue(key, text, num = null) {
  const v = { text: String(text), num: num == null ? null : String(num) };
  const o = vals.get(key);
  if (o && o.text === v.text && o.num === v.num) return;
  vals.set(key, v); gen++;
}
// every fragment and value, for a page whose blocks were still empty when it was served (the first minute after a start)
export const fragments = () => ({ fragments: Object.fromEntries(frags), values: Object.fromEntries([...vals].map(([k, v]) => [k, v.text])) });
export const liveTag = (path) => (PAGES.has(path) && gen ? `-L${gen.toString(36)}` : "");

const BLOCK = /<!--live:([\w-]+)-->[\s\S]*?<!--\/live:\1-->/g;
const INLINE = /<([a-z][a-z0-9]*)(\s[^>]*?\bdata-live="([\w.-]+)"[^>]*)>([^<]*)<\/\1>/g;
export function liveHtml(path, buf) {
  if (!PAGES.has(path) || !gen) return buf;
  let s = buf.toString("utf8");
  s = s.replace(BLOCK, (m, name) => (frags.has(name) ? `<!--live:${name}-->${frags.get(name)}<!--/live:${name}-->` : m));
  s = s.replace(INLINE, (m, tag, attrs, key) => {
    const v = vals.get(key);
    if (!v) return m;
    const a = v.num != null && /\sdata-num="/.test(attrs) ? attrs.replace(/\sdata-num="[^"]*"/, ` data-num="${esc(v.num)}"`) : attrs;
    return `<${tag}${a}>${esc(v.text)}</${tag}>`;
  });
  return Buffer.from(s, "utf8");
}
