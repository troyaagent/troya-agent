// Shared bits for the market-facing pages (Home, Market, Token, Launchpad).
import { h, tokenIcon, padLogo, tiny, usd, compact } from "./ui.js";

export const LAUNCHPADS = [
  ["pons", "Pons"], ["clanker", "Clanker"], ["bankr", "Bankr"], ["virtuals", "Virtuals"], ["hoodit", "Hoodit"], ["mintclub", "Mint Club"], ["easya", "EasyA"],
  ["o1", "O1 Launchpad"], ["frontier", "Frontier"], ["long", "Long"], ["abyss", "Abyss"], ["goo", "Goo"], ["clank", "Clank.trade"], ["uniswap", "Uniswap"], ["ramses", "Ramses"],
  ["pancake", "PancakeSwap"], ["sushi", "SushiSwap"], ["aero", "Aerodrome"], ["up", "Up"], ["other", "Other"],
];
export const padName = (k) => (LAUNCHPADS.find(([v]) => v === k)?.[1] || (k ? k[0].toUpperCase() + k.slice(1) : "Other"));

// small X / Telegram / website links under a coin's name (the row opens the token page; these open the coin's own accounts)
const SOC = { x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z", telegram: "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z", website: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a8.2 8.2 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4zm.81 2h2.95c.32 1.25.78 2.45 1.38 3.56A8 8 0 0 1 5.07 16zM8.02 8H5.07a8 8 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.02 8zM12 19.96A14.1 14.1 0 0 1 10.09 16h3.82A14.1 14.1 0 0 1 12 19.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm.26 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38a8.2 8.2 0 0 1 0 4z" };
export function socialLinks(s) {
  if (!s) return null;
  const items = [["x", "X"], ["telegram", "Telegram"], ["website", "Website"]].filter(([k]) => s[k]);
  if (!items.length) return null;
  return h("span", { class: "tok-soc" }, items.map(([k, label]) => {
    const a = h("a", { href: s[k], target: "_blank", rel: "noopener nofollow", title: label, "aria-label": `${label} (opens the coin's own page)`, onclick: (e) => e.stopPropagation() });
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SOC[k]}"/></svg>`;
    return a;
  }));
}
export function tokenCell(t, opts = {}) {
  const narrow = matchMedia("(max-width: 720px)").matches;
  return h("div", { class: "tok" }, tokenIcon(t),
    h("div", { style: { minWidth: 0 } },
      h("b", {}, t.symbol || "?", opts.tag !== false && t.launchpad ? h("span", { class: `pad-tag${narrow ? " mini" : ""}`, title: padName(t.launchpad) }, padLogo(t.launchpad, 12), narrow ? null : padName(t.launchpad)) : null,
        !t.tradable && opts.flagUntradable ? h("span", { class: "pad-tag warn", title: "Troya found no route for it yet: Pons curves, Uniswap v3/v4 and the other Robinhood Chain venues through KyberSwap." }, "not routed") : null),
      h("small", {}, h("span", { class: "tok-nm" }, t.name || ""), socialLinks(t.socials))));
}
// "$0.00175" on top, "0.0₇8 ETH" under it
export function priceCell(priceEth, priceUsd) {
  return h("div", { class: "pcell" }, h("span", {}, priceUsd != null ? `$${tiny(priceUsd)}` : "–"), priceEth != null ? h("span", { class: "sub" }, `${tiny(priceEth)} ETH`) : null);
}
export function ethAmount(v) {
  if (v == null || !isFinite(v)) return "–";
  return `${v >= 1000 ? compact(v, 1) : v >= 1 ? v.toFixed(v >= 100 ? 0 : 2) : tiny(v)} ETH`;
}
export function mcapCell(t) {
  return h("div", { class: "pcell" }, h("span", {}, t.mcapUsd != null ? `≈ ${usd(t.mcapUsd, { compact: true })}` : "–"), t.mcapEth != null ? h("span", { class: "sub" }, ethAmount(t.mcapEth)) : null);
}
export function usdCell(vUsd, vEth) {
  return h("div", { class: "pcell" }, h("span", {}, vUsd != null ? usd(vUsd, { compact: true }) : "–"), vEth != null ? h("span", { class: "sub" }, ethAmount(vEth)) : null);
}
export function ageText(ms) {
  if (!ms) return "–";
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export function updatedText(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 60 ? "updated just now" : s < 3600 ? `updated ${Math.floor(s / 60)} min ago` : `updated ${Math.floor(s / 3600)} h ago`;
}
export const fmtFunding = (pctPerHr) => (pctPerHr == null ? "–" : `${pctPerHr > 0 ? "+" : ""}${pctPerHr.toFixed(4)}%`);
export const fmtApr = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${Math.abs(v) >= 1000 ? compact(v, 1) : v.toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`);
export function perpPrice(v) {
  if (v == null) return "–";
  const a = Math.abs(v);
  return a >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : a >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : tiny(v, 5);
}
