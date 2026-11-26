// V10 name clash (Xivor's idea, 26 Nov 2026): when other contracts on Robinhood Chain carry the same ticker or name, say
// so in one line next to the Gate check and on the coin page, with each one's address, age, liquidity and what the Gate
// said at its launch. GET /api/clash/:token (server/market.mjs nameClash). Shows nothing when the coin has no clash.
import { h, clear, short, ago, useCss } from "./ui.js";
import { api } from "./api.js";

useCss("clash");

const fmtUsd = (n) => (n == null ? "–" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const gateWord = (g) => (g?.v === "passed" ? "passed" : g?.v === "blocked" ? "blocked" : "not checked");
const memo = new Map();

export function clashData(address) {
  const k = String(address || "").toLowerCase();
  const hit = memo.get(k);
  if (hit && Date.now() - hit.t < 120_000) return hit.p;
  const p = api.get(`/api/clash/${k}`).catch(() => null);
  memo.set(k, { t: Date.now(), p });
  if (memo.size > 60) memo.delete(memo.keys().next().value);
  return p;
}

/** A box that fills itself in; stays empty (and hidden) when nothing clashes. */
export function clashBox(address) {
  const box = h("div", { class: "clash", hidden: true, role: "note" });
  clashData(address).then((c) => {
    if (!c?.clash || !c.others?.length) return;
    const n = c.others.length;
    const pos = c.thisOne === "oldest" ? " This one is the oldest." : c.thisOne === "newest" ? " This one is the newest." : "";
    const tally = [c.passed ? `${c.passed} passed` : null, c.blocked ? `${c.blocked} blocked` : null].filter(Boolean).join(", ");
    const me = String(address).toLowerCase();
    const rows = [{ address: me, self: true }, ...c.others];
    clear(box,
      h("b", {}, `${n} other contract${n === 1 ? "" : "s"} share${n === 1 ? "s" : ""} the ticker ${c.ticker}`),
      `Same name, different coins. Check the address before you buy.${pos}${tally ? ` Gate at launch: ${tally} of ${c.count}.` : ""}`,
      h("details", {},
        h("summary", {}, `See all ${c.count}`),
        h("div", { class: "wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Contract"), h("th", {}, "Age"), h("th", {}, "Liquidity"), h("th", {}, "Gate at launch"))),
          h("tbody", {}, rows.map((r) => {
            const x = r.self ? null : r;
            const born = x?.bornAt;
            return h("tr", {},
              h("td", {}, r.self ? h("span", {}, short(me), " (this one)") : h("a", { href: `#/token/${x.address}` }, short(x.address))),
              h("td", {}, r.self ? (c.oldest === me ? "oldest" : c.newest === me ? "newest" : "") : born ? ago(born) : "–"),
              h("td", {}, r.self ? "" : fmtUsd(x.realLiquidityUsd != null && x.realLiquidityUsd >= 1 ? x.realLiquidityUsd : x.liquidityUsd)),
              h("td", { class: r.self ? "" : `g-${x.gate?.v || "none"}` }, r.self ? "" : gateWord(x.gate)));
          }))))));
    box.hidden = false;
  });
  return box;
}
