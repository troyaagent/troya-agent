// One coin finder for every input that takes a coin: type a symbol, a name or a ticker and the matching coins on
// Robinhood Chain drop down with their logos (real coin first, small copies of a bigger coin's ticker marked).
// Pasting an address still works everywhere; this only adds the names.
import { h, clear, tokenIcon, short } from "./ui.js";
import { api } from "./api.js";

const ADDR = /0x[0-9a-fA-F]{40}/;
const money = (n) => (n == null ? null : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const price = (n) => (n == null ? null : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 20 })}` : null);
const STYLE = `
.cs-wrap { position: relative; min-width: 0; flex: 1 1 auto; }
.cs-wrap > input { width: 100%; }
.cs-pop { position: fixed; z-index: 2147483000; display: grid; gap: 2px; padding: 6px; max-height: 340px; overflow: auto; min-width: 280px;
  border-radius: 14px; border: 1px solid rgba(160, 220, 240, .16); background: #0b141a; box-shadow: 0 18px 48px rgba(0, 0, 0, .55); }
.cs-pop[hidden] { display: none; }
.cs-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 10px; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; font: inherit; }
.cs-row:hover, .cs-row.on { background: rgba(142, 223, 245, .08); }
.cs-row .tok-ico { width: 28px; height: 28px; flex: none; }
.cs-n { display: grid; min-width: 0; line-height: 1.25; }
.cs-n b { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-n small { font-size: 12px; opacity: .62; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-x { margin-left: auto; display: grid; justify-items: end; font-size: 12px; line-height: 1.25; white-space: nowrap; }
.cs-x small { opacity: .58; }
.cs-tag { font-size: 11px; padding: 2px 7px; border-radius: 99px; border: 1px solid rgba(160, 220, 240, .2); opacity: .9; }
.cs-tag.warn { color: #f0c46e; border-color: rgba(240, 196, 110, .45); background: rgba(240, 196, 110, .08); }
.cs-empty { padding: 10px; font-size: 13px; opacity: .6; }
html[data-theme="light"] .cs-pop { background: #fff; border-color: rgba(10, 40, 60, .12); box-shadow: 0 18px 48px rgba(10, 30, 50, .16); }
html[data-theme="light"] .cs-row:hover, html[data-theme="light"] .cs-row.on { background: rgba(20, 110, 150, .07); }
`;
let styled = false;

/** Top match for a typed symbol or name: { address, symbol, name, kind, ... } or null. Majors (ETH) skipped unless asked. */
export async function findCoin(q, { majors = false } = {}) {
  const raw = String(q || "").trim();
  const m = ADDR.exec(raw);
  if (m) return { address: m[0].toLowerCase(), symbol: null };
  if (!raw) return null;
  const r = await api.get(`/api/search/coins?q=${encodeURIComponent(raw)}&limit=8`);
  return (r.coins || []).find((c) => (majors || c.kind !== "major") && c.address !== "native") || null;
}

/**
 * Wrap an input with the coin dropdown. Returns the wrapper to place where the input was.
 * onPick(coin) gets { address, symbol, name, kind, image, priceUsd, liquidityUsd, copy }.
 * Register this before the input's own Enter handler: a picked row stops the event.
 */
export function coinSuggest(input, onPick, { limit = 7, majors = false, stocks = true } = {}) {
  if (!styled) { styled = true; document.head.append(h("style", {}, STYLE)); }
  const pop = h("div", { class: "cs-pop", role: "listbox", hidden: true });
  const wrap = h("div", { class: "cs-wrap" }, input);
  const place = () => {
    if (pop.hidden) return;
    const r = input.getBoundingClientRect();
    if (!r.width) { close(); return; }
    const below = innerHeight - r.bottom, up = below < 240 && r.top > below;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 280) - 8))}px`;
    pop.style.width = `${Math.max(r.width, 280)}px`;
    pop.style.top = up ? "" : `${r.bottom + 6}px`;
    pop.style.bottom = up ? `${innerHeight - r.top + 6}px` : "";
    pop.style.maxHeight = `${Math.max(160, Math.min(340, (up ? r.top : below) - 16))}px`;
  };
  addEventListener("scroll", place, { passive: true, capture: true });
  addEventListener("resize", place, { passive: true });
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-autocomplete", "list");
  let coins = [], sel = -1, seq = 0, timer = 0;
  const close = () => { pop.hidden = true; sel = -1; pop.remove(); };
  const pick = (c) => { close(); onPick(c); };
  const paint = (empty) => {
    clear(pop, coins.length ? coins.map((c, i) => h("button", { class: `cs-row ${i === sel ? "on" : ""}`, type: "button", role: "option",
      onmousedown: (e) => e.preventDefault(), onclick: () => pick(c) },
      tokenIcon({ address: c.address === "native" ? "" : c.address, symbol: c.symbol, image: c.image, chain: "robinhood" }),
      h("span", { class: "cs-n" }, h("b", {}, c.symbol), h("small", {}, [c.name && c.name !== c.symbol ? c.name : null, c.address === "native" ? "Native" : short(c.address)].filter(Boolean).join(" · "))),
      h("span", { class: "cs-x" },
        c.copy ? h("span", { class: "cs-tag warn", title: "A small coin borrowing the ticker of a bigger one. Check the address." }, "Copy?")
          : c.kind === "stock" ? h("span", { class: "cs-tag" }, "Stock") : price(c.priceUsd) ? h("span", {}, price(c.priceUsd)) : null,
        c.liquidityUsd ? h("small", {}, `liq ${money(c.liquidityUsd)}`) : c.launchpad ? h("small", {}, c.launchpad) : null)))
      : h("div", { class: "cs-empty" }, empty || "No coin matches. Paste its address instead."));
    if (!input.isConnected) return;
    if (!pop.isConnected) document.body.append(pop);
    pop.hidden = false; place();
  };
  const lookup = () => {
    clearTimeout(timer);
    const q = input.value.trim().replace(/^\$/, "");
    if (q.length < 2 || ADDR.test(q)) { coins = []; close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api.get(`/api/search/coins?q=${encodeURIComponent(q)}&limit=${limit + 3}`);
        if (my !== seq || document.activeElement !== input) return;
        coins = (r.coins || []).filter((c) => (majors || c.kind !== "major") && (stocks || c.kind !== "stock")).slice(0, limit);
        sel = coins.length ? 0 : -1;
        paint();
      } catch { if (my === seq) { coins = []; paint("Search is unavailable right now. Paste the address instead."); } }
    }, 160);
  };
  input.addEventListener("input", lookup);
  input.addEventListener("focus", () => { if (coins.length && input.value.trim().length >= 2) paint(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (pop.hidden || !coins.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + coins.length) % coins.length; paint(); }
    else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(coins[sel]); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  return wrap;
}
