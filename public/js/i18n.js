/* Troya i18n: the site and the app in English (the default) or one of the languages in LANGS below.
   Loaded as a plain blocking script in <head>, right after /config.js, on every page that has a language picker.

   - The language comes from ?lang=zh|ja|ko|es|pt|ru|tr|vi|id|en (in the query or in the app's #/…?lang=), else from this browser's last pick
     (localStorage "troya.lang"), else English. English never loads a dictionary and changes nothing on the page.
   - A dictionary is a same-origin script per language and page group (/i18n/<lang>/<pack>.js, built once by
     tools/i18n/ and committed). Each entry maps the English text of one piece of the page to its translation.
   - The English source is matched as it stands, so nothing in the HTML needs a key: a "unit" is the smallest element that
     holds a whole sentence (a heading, a paragraph, a button, a link), with its inline tags numbered (<1>…</1>, <2/>) and its
     numbers lifted out as {0}, {1}. The translation keeps those markers and the page keeps its own elements, links,
     listeners and live numbers. Anything not in the dictionary stays in English, so a missing line never breaks a page.
   - Pages built later by scripts (the app, the menus) are translated as they appear, through a MutationObserver. */
(function () {
  "use strict";
  var KEY = "troya.lang";
  // [code, short label for the picker, native name, the code the assistant gets]. Adding a language: one line here and its
  // dictionaries in /i18n/<code>/ (tools/i18n/translate.mjs writes them). English is the source and loads nothing.
  var LANGS = [
    ["en", "EN", "English", "auto"],
    ["zh-Hans", "中文", "简体中文", "zh"],
    ["ja", "日本語", "日本語", "ja"],
    ["ko", "한국어", "한국어", "ko"],
    ["es", "ES", "Español", "es"],
    ["pt-BR", "PT", "Português", "pt"],
    ["ru", "RU", "Русский", "ru"],
    ["tr", "TR", "Türkçe", "tr"],
    ["vi", "VI", "Tiếng Việt", "vi"],
    ["id", "ID", "Bahasa Indonesia", "id"],
  ];
  var ALIAS = { "en-us": "en", "en-gb": "en", zh: "zh-Hans", "zh-cn": "zh-Hans", "zh-sg": "zh-Hans", cn: "zh-Hans", jp: "ja", "ja-jp": "ja", kr: "ko", "ko-kr": "ko", pt: "pt-BR", br: "pt-BR", "pt-pt": "pt-BR", "es-es": "es", "es-419": "es", "ru-ru": "ru", "tr-tr": "tr", "vi-vn": "vi", in: "id", "id-id": "id" };
  for (var li = 0; li < LANGS.length; li++) ALIAS[LANGS[li][0].toLowerCase()] = LANGS[li][0];
  var info = function (code) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === code) return LANGS[i]; return LANGS[0]; };
  // the short code used in ?lang= links: zh, pt, ja…
  var shortCode = function (code) { return code === "zh-Hans" ? "zh" : code === "pt-BR" ? "pt" : code; };
  var norm = function (v) { return ALIAS[String(v || "").toLowerCase()] || null; };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  var fromUrl = function () {
    var m = /[?&]lang=([^&#]*)/.exec(location.search) || /[?&]lang=([^&#]*)/.exec(location.hash);
    if (!m) return null;
    try { return norm(decodeURIComponent(m[1])); } catch (e) { return null; }
  };
  var urlLang = fromUrl();
  if (urlLang) store.set(KEY, urlLang);
  var lang = urlLang || norm(store.get(KEY)) || "en";
  var root = document.documentElement;
  var collecting = /[?&]i18n-collect=1\b/.test(location.search);

  // the assistant's reply language follows the picker: the app sends prefs.lang with every question (zh, ja … or auto)
  var syncAssistant = function (l) {
    try {
      var p = JSON.parse(localStorage.getItem("troya.prefs") || "null") || { slippage: 1, density: "comfortable", motion: "system", lang: "auto" };
      var want = l !== "en" ? info(l)[3] : (!p.lang || p.lang === "en" ? p.lang || "auto" : "auto");
      if (p.lang !== want) { p.lang = want; localStorage.setItem("troya.prefs", JSON.stringify(p)); }
    } catch (e) {}
  };
  if (urlLang && urlLang !== "en") syncAssistant(urlLang);   // a ?lang=en link leaves a reply language picked in Settings alone

  /* ---------- which dictionaries a page needs ---------- */
  var path = location.pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "").replace(/(.)\/$/, "$1");
  var PACKS = { "/": "home", "/roadmap": "roadmap", "/safety": "safety", "/agent": "app" };
  var packs = ["common"].concat(PACKS[path] ? [PACKS[path]] : []);

  var DICT = Object.create(null);
  window.TROYA_I18N_ADD = function (d) { for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) DICT[k] = d[k]; };

  /* ---------- the page's text: units, text nodes, attributes ---------- */
  // tags that may sit inside a unit (their text belongs to the sentence around them)
  var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BR: 1, CITE: 1, CODE: 1, DATA: 1, DFN: 1, EM: 1, I: 1, IMG: 1, KBD: 1, MARK: 1, Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, SVG: 1, TIME: 1, U: 1, VAR: 1, WBR: 1 };
  // elements whose whole content reads as one line even without a word of their own between the tags
  var TEXTBOX = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, DT: 1, DD: 1, TD: 1, TH: 1, LABEL: 1, BUTTON: 1, A: 1, SUMMARY: 1, FIGCAPTION: 1, BLOCKQUOTE: 1, CAPTION: 1, LEGEND: 1, OPTION: 1, TITLE: 1 };
  // never read or changed: code, addresses, numbers in mono type, media, form values, anything marked translate="no"
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, TEXTAREA: 1, INPUT: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, svg: 1 };
  var tagOf = function (el) { return el.tagName === "svg" ? "SVG" : el.tagName; };
  var skipped = function (el) {
    if (SKIP[el.tagName]) return true;
    if (el === root) return false;
    if (el.getAttribute("translate") === "no" || el.hasAttribute("data-i18n-skip")) return true;
    var c = el.classList;
    return !!c && (c.contains("mono") || c.contains("notranslate") || c.contains("lang-pick"));
  };
  // an inline element kept whole inside a unit: code, media, anything a script fills (data-*), mono numbers
  var opaque = function (el) {
    if (skipped(el) || tagOf(el) === "IMG" || tagOf(el) === "SVG" || tagOf(el) === "BR" || tagOf(el) === "WBR") return true;
    for (var i = 0; i < el.attributes.length; i++) if (el.attributes[i].name.indexOf("data-") === 0) return true;
    return false;
  };
  var blank = function (s) { return !/\S/.test(s); };
  var esc = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\{/g, "&lbrace;"); };
  var unesc = function (s) { return s.replace(/&lbrace;/g, "{").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); };
  // numbers become {0}, {1}… so "10 of 11 phases live" and "9 of 11 phases live" share one line
  var NUM = /(^|[^\w.<\/])(\d+(?:,\d{3})*(?:\.\d+)?)(?![\w>\/])/g;
  function liftNums(s, nums) { return s.replace(NUM, function (m, pre, n) { nums.push(n); return pre + "{" + (nums.length - 1) + "}"; }); }
  var clean = function (s) { return s.replace(/\s+/g, " ").trim(); };

  // can el be read as one unit? every descendant inline, some text outside the opaque parts
  function isUnit(el) {
    var text = false, own = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (!blank(c.data)) text = own = true; }
      else if (c.nodeType === 1) {
        if (!INLINE[tagOf(c)]) return false;
        if (opaque(c)) continue;
        var r = inner(c);
        if (r === -1) return false;
        if (r === 1) text = true;
      }
    }
    return text && (own || !!TEXTBOX[el.tagName]);
  }
  function inner(el) {          // -1: a block inside, 1: has text, 0: no text
    var text = 0;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (!blank(c.data)) text = 1; }
      else if (c.nodeType === 1) {
        if (!INLINE[tagOf(c)]) return -1;
        if (opaque(c)) continue;
        var r = inner(c);
        if (r === -1) return -1;
        if (r === 1) text = 1;
      }
    }
    return text;
  }
  // the key of a unit, and its numbered elements in document order
  function unitKey(el) {
    var nodes = [], s = "";
    (function rec(p) {
      for (var c = p.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += esc(c.data);
        else if (c.nodeType === 1) {
          var n = nodes.push(c);
          if (opaque(c) || !c.firstChild) s += "<" + n + "/>";
          else { s += "<" + n + ">"; rec(c); s += "</" + n + ">"; }
        }
      }
    })(el);
    var nums = [];
    return { key: liftNums(clean(s), nums), nodes: nodes, nums: nums };
  }
  var putNums = function (s, nums) { return s.replace(/\{(\d+)\}/g, function (m, i) { return nums[+i] != null ? nums[+i] : m; }); };

  // rebuild a unit from its translation, reusing the page's own elements (their links, listeners and live numbers stay)
  function applyUnit(el, tr, u) {
    var toks = [], re = /<(\/?)(\d+)(\/?)>|[^<]+/g, m, depth = [];
    while ((m = re.exec(tr))) {
      if (m[2]) {
        var i = +m[2] - 1;
        if (!u.nodes[i]) return false;
        if (m[1]) { if (depth.pop() !== i) return false; toks.push({ close: 1 }); }
        else if (m[3]) toks.push({ empty: i });
        else { depth.push(i); toks.push({ open: i }); }
      } else toks.push({ text: unesc(putNums(m[0], u.nums)) });
    }
    if (depth.length) return false;
    var used = {}, frag = document.createDocumentFragment(), stack = [frag];
    var take = function (i, deep) {
      var n = u.nodes[i];
      if (used[i]) return n.cloneNode(deep);
      used[i] = 1;
      return n;
    };
    for (var k = 0; k < toks.length; k++) {
      var t = toks[k], top = stack[stack.length - 1];
      if (t.text != null) top.appendChild(document.createTextNode(t.text));
      else if (t.empty != null) top.appendChild(take(t.empty, true));
      else if (t.open != null) { var x = take(t.open, false); while (x.firstChild) x.removeChild(x.firstChild); top.appendChild(x); stack.push(x); }
      else stack.pop();
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
    return true;
  }
  function textKey(s) { var nums = []; return { key: liftNums(clean(esc(s)), nums), nums: nums }; }
  var ATTRS = ["placeholder", "title", "aria-label"];

  // visit: call unit(el, key) / text(node, key) / attr(el, name, key) for every piece of text under el
  function visit(el, cb) {
    if (el.nodeType !== 1) return;
    var field = el.tagName === "INPUT" || el.tagName === "TEXTAREA";      // their placeholder and label only, never the value
    if (!field && skipped(el)) return;
    for (var a = 0; a < ATTRS.length; a++) { var v = el.getAttribute(ATTRS[a]); if (v && /[A-Za-z]/.test(v)) cb.attr(el, ATTRS[a], v); }
    if (field) return;
    if (isUnit(el)) { cb.unit(el); return; }
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (!blank(c.data) && /[A-Za-z]/.test(c.data)) cb.text(c); }
      else if (c.nodeType === 1) visit(c, cb);
    }
  }
  var TR = {
    unit: function (el) {
      var u = unitKey(el), tr = DICT[u.key];
      if (tr != null && tr !== u.key) applyUnit(el, tr, u);
    },
    text: function (node) {
      var k = textKey(node.data), tr = DICT[k.key];
      if (tr == null) return;
      var lead = /^\s*/.exec(node.data)[0], trail = /\s*$/.exec(node.data)[0];
      var out = lead + unesc(putNums(tr, k.nums)) + trail;
      if (out !== node.data) node.data = out;
    },
    attr: function (el, name, v) {
      var k = textKey(v), tr = DICT[k.key];
      if (tr != null) { var out = unesc(putNums(tr, k.nums)); if (out !== v) el.setAttribute(name, out); }
    },
  };
  // the nearest element above n that is not inline: where a changed piece of text has to be read again
  function blockOf(n) {
    var el = n.nodeType === 1 ? n : n.parentNode;
    while (el && el.nodeType === 1 && el !== document.body && el.parentNode && el.parentNode.nodeType === 1 && INLINE[tagOf(el)]) el = el.parentNode;
    return el && el.nodeType === 1 ? el : null;
  }

  /* ---------- the picker ---------- */
  var CSS = ".lang-pick{position:relative;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 28%,transparent);font:600 11px/1 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.04em;white-space:nowrap;cursor:pointer;flex:none;color:inherit}" +
    ".lang-pick:hover,.lang-pick:focus-within{border-color:color-mix(in srgb,currentColor 60%,transparent)}" +
    ".lang-pick svg{width:14px;height:14px;flex:none;opacity:.85}" +
    ".lang-pick select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:16px;border:0;margin:0;-webkit-appearance:none;appearance:none}" +
    ".lang-pick select option{color:#111;background:#fff}" +
    ".lang-pick.in-menu{display:none;height:36px;padding:0 14px;margin:0 0 22px;width:max-content}" +
    "@media (max-width:900px){.lang-pick.in-head{display:none}.lang-pick.in-menu{display:inline-flex}}" +
    "@media (max-width:420px){.lang-pick{padding:0 8px;gap:4px}.lang-pick.compact span{display:none}}" +
    // the app: the top bar (a globe only on phones), the sidebar foot and Settings
    ".d-lang-side{margin:10px 0 2px;align-self:flex-start;width:max-content}.d-lang-set{align-self:flex-start;width:max-content;height:36px}" +
    "@media (max-width:760px){.d-right .d-lang{width:36px;height:36px;padding:0;justify-content:center}.d-right .d-lang span{display:none}.d-right .d-lang svg{width:16px;height:16px}}" +
    // a phone in a language with a long "Connect" has no room for the globe: the sidebar foot and Settings still have it
    "@media (max-width:560px){html.i18n:not([lang=zh-Hans]):not([lang=ja]):not([lang=ko]) .d-right .d-lang{display:none}}" +
    "html.i18n-wait body{visibility:hidden}" +
    // longer words than English in the site header's text links: tighter pills (English keeps its own look)
    "html.i18n .bb-soc a.bb-com{padding:0 10px;letter-spacing:.04em;margin-right:2px}" +
    // and where they still do not fit, they wait in the menu (where they already are)
    "@media (max-width:1180px){html.i18n .bb-soc a.bb-com{display:none}}@media (max-width:1279px){html.i18n[lang=ru] .bb-soc a.bb-com{display:none}}";
  var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
  function setLang(l) {
    l = norm(l) || "en";
    store.set(KEY, l);
    syncAssistant(l);
    var href = location.href;
    if (/[?&]lang=/.test(href)) location.replace(href.replace(/([?&]lang=)[^&#]*/g, "$1" + shortCode(l)));
    else location.reload();
  }
  function picker(opts) {
    opts = opts || {};
    var lab = document.createElement("label");
    lab.className = "lang-pick" + (opts.compact ? " compact" : "") + (opts.cls ? " " + opts.cls : "");
    lab.title = "Language";
    lab.innerHTML = GLOBE;
    var cur = document.createElement("span");
    cur.textContent = info(lang)[opts.compact ? 1 : 2];       // EN in a header, English in a menu or Settings
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    for (var j = 0; j < LANGS.length; j++) {
      var o = document.createElement("option");
      o.value = LANGS[j][0]; o.textContent = LANGS[j][2]; o.lang = LANGS[j][0];
      if (LANGS[j][0] === lang) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { setLang(sel.value); });
    lab.appendChild(cur); lab.appendChild(sel);
    return lab;
  }
  // marketing pages: the picker sits in the header, just before Open app (the home page and every inner page)
  // phones and small tablets: the header has no room left, so the picker moves into the full-screen menu (built by
  // /home/pages.js on inner pages)
  function placePicker() {
    var spot = document.querySelector(".nav-r > .pill, .pn-r > .pn-pill");
    if (spot && !spot.parentNode.querySelector(".lang-pick")) spot.parentNode.insertBefore(picker({ compact: true, cls: "in-head" }), spot);
    var menu = document.querySelector("[data-menu], [data-pn-menu]");
    if (menu && menu.firstElementChild && !menu.querySelector(".lang-pick")) menu.insertBefore(picker({ cls: "in-menu" }), menu.firstChild);
  }
  document.addEventListener("DOMContentLoaded", placePicker);

  var style = document.createElement("style");
  style.textContent = CSS;
  (document.head || root).appendChild(style);

  window.TroyaI18n = {
    lang: lang, langs: LANGS, set: setLang, picker: picker,
    // the language the assistant answers in for this page's picker ("auto" for English: same as the message)
    assistant: info(lang)[3], shortCode: shortCode,
    t: function (s) { var k = textKey(String(s)), tr = DICT[k.key]; return tr == null ? String(s) : unesc(putNums(tr, k.nums)); },
  };

  /* ---------- extraction (tools/i18n/extract.mjs opens pages with ?i18n-collect=1, always in English) ---------- */
  if (collecting) {
    var gather = function (els, withTitle) {
      var found = {}, list = [];
      var add = function (key, kind, el) {
        if (!key || !/[A-Za-z]/.test(key.replace(/<\/?\d+\/?>/g, "")) || found[key]) return;
        var near = el && el.closest ? el.closest("section[id], section[aria-label], [id], header, nav, footer, aside, main") : null;
        found[key] = 1;
        list.push({ key: key, kind: kind, ctx: near ? near.id || near.getAttribute("aria-label") || near.tagName.toLowerCase() : "", tag: el && el.tagName ? el.tagName.toLowerCase() : "" });
      };
      var COL = {
        unit: function (el) { add(unitKey(el).key, "unit", el); },
        text: function (n) { add(textKey(n.data).key, "text", n.parentNode); },
        attr: function (el, name, v) { add(textKey(v).key, "attr:" + name, el); },
      };
      for (var i = 0; i < els.length; i++) visit(els[i], COL);
      var t = withTitle && document.querySelector("title");
      if (t) visit(t, COL);
      return list;
    };
    // collect(): the whole page now; collect(selector): only those parts
    window.TroyaI18n.collect = function (sel) { return sel ? gather(document.querySelectorAll(sel), false) : gather([document.body], true); };
    // the page as the server sent it, before any script split or rewrote its text
    document.addEventListener("readystatechange", function () {
      if (document.readyState === "interactive") { window.TroyaI18n.atParse = window.TroyaI18n.collect(); placePicker(); }
    });
    return;
  }

  if (lang === "en") {
    if (document.readyState !== "loading") placePicker();
    return;
  }

  /* ---------- a non-English page ---------- */
  root.lang = lang;
  root.classList.add("i18n", "i18n-wait");          // no flash of English: shown once the parsed page is translated
  var unwait = function () { root.classList.remove("i18n-wait"); };
  setTimeout(unwait, 2500);                 // a dictionary that never arrives still shows the page, in English
  var V = "20261125";
  for (var p = 0; p < packs.length; p++) {
    var src = "/i18n/" + lang + "/" + packs[p] + ".js?v=" + V;
    if (document.readyState === "loading") document.write('<script src="' + src + '"><\/script>');
    else { var s = document.createElement("script"); s.src = src; document.head.appendChild(s); }
  }

  var busy = false;
  function run(el) { if (!el) return; busy = true; try { visit(el, TR); } catch (e) {} busy = false; }
  var obs = new MutationObserver(function (recs) {
    if (busy) return;
    if (document.readyState === "loading") {
      // while the page is still arriving, a script about to run (the roadmap's phone folds) gets the text in its language
      for (var i = 0; i < recs.length; i++) for (var j = 0; j < recs[i].addedNodes.length; j++) {
        if (recs[i].addedNodes[j].nodeName === "SCRIPT" && document.body) { run(document.body); obs.takeRecords(); return; }
      }
      return;
    }
    var seen = [];
    for (var r = 0; r < recs.length; r++) {
      var b = blockOf(recs[r].target);
      if (b && seen.indexOf(b) < 0) seen.push(b);
    }
    // the outermost changed blocks only: a block inside another is read with it
    for (var q = 0; q < seen.length; q++) {
      var inside = false;
      for (var w = 0; w < seen.length; w++) if (w !== q && seen[w].contains(seen[q]) && seen[w] !== seen[q]) { inside = true; break; }
      if (!inside && seen[q].isConnected) run(seen[q]);
    }
    obs.takeRecords();
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  document.addEventListener("readystatechange", function () {
    if (document.readyState !== "interactive") return;
    placePicker();
    var t = document.querySelector("title");
    if (t) run(t);
    run(document.body);
    obs.takeRecords();
    unwait();
  });
})();
