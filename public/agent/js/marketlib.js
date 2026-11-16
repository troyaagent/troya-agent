// Shared bits for the market-facing pages (Home, Market, Token, Launchpad).
import { h, tokenIcon, padLogo, tiny, usd, compact } from "./ui.js";

export const LAUNCHPADS = [
  ["pons", "Pons"], ["clanker", "Clanker"], ["bankr", "Bankr"], ["virtuals", "Virtuals"], ["hoodit", "Hoodit"], ["mintclub", "Mint Club"], ["easya", "EasyA"],
  ["o1", "O1 Launchpad"], ["frontier", "Frontier"], ["long", "Long"], ["abyss", "Abyss"], ["goo", "Goo"], ["clank", "Clank.trade"], ["uniswap", "Uniswap"], ["ramses", "Ramses"],
  ["pancake", "PancakeSwap"], ["sushi", "SushiSwap"], ["aero", "Aerodrome"], ["up", "Up"], ["other", "Other"],
];
export const padName = (k) => (LAUNCHPADS.find(([v]) => v === k)?.[1] || (k ? k[0].toUpperCase() + k.slice(1) : "Other"));

export function tokenCell(t, opts = {}) {
  return h("div", { class: "tok" }, tokenIcon(t),
    h("div", { style: { minWidth: 0 } },
      h("b", {}, t.symbol || "?", opts.tag !== false && t.launchpad ? h("span", { class: "pad-tag" }, padLogo(t.launchpad, 12), padName(t.launchpad)) : null,
        !t.tradable && opts.flagUntradable ? h("span", { class: "pad-tag warn", title: "Troya found no route for it yet: Pons curves, Uniswap v3/v4 and the other Robinhood Chain venues through KyberSwap." }, "not routed") : null),
      h("small", {}, t.name || "")));
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
