// V9 F50 Heel Hunt (#/heelhunt): talk the Vault Keeper, an AI with a real "release the prize" tool, into sending the prize.
// The round, the prize balance and every attempt come from GET /api/heelhunt (server/heelhunt.mjs); a try is
// POST /api/heelhunt/attempt from a signed-in wallet. This page only shows them and sends the message.
import { h, clear, ago, toast } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";
import { wallet, signIn, openConnect } from "/agent/js/wallet.js";

const EXPLORER = "https://robinhoodchain.blockscout.com";
export function heelhuntCss() {
  if (document.querySelector("link[data-heelhunt-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: "/agent/desk/heelhunt.css", "data-heelhunt-css": "1" }));
}
const eth = (x) => (x == null ? "–" : `${Number(x).toFixed(x >= 1 ? 3 : 5)} ETH`);
function left(ms) {
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 86400e3), hr = Math.floor(ms / 3600e3) % 24, m = Math.floor(ms / 60e3) % 60;
  return d ? `${d}d ${hr}h left` : hr ? `${hr}h ${m}m left` : `${m}m left`;
}

export async function mount(view, ctx) {
  heelhuntCss();
  let alive = true, data = null, timer = 0;
  const head = h("div", { class: "hh-head" });
  const play = h("section", { class: "panel hh-play" });
  const feed = h("section", { class: "panel hh-feed" });
  const rules = h("section", { class: "panel hh-rules" });

  async function load() {
    try { data = await api.get("/api/heelhunt"); } catch (e) { if (alive) clear(head, h("div", { class: "alert error" }, e.message)); return; }
    if (!alive) return;
    paint();
  }

  function paint() {
    const r = data.round, now = Date.now();
    const status = r.status === "won" ? "Won" : r.open ? "Open" : r.status === "setup" ? "Opening soon" : "Ended";
    clear(head,
      h("div", { class: "hh-prize" },
        h("small", {}, "Prize in the vault"),
        h("b", {}, eth(data.prizeEth)),
        h("a", { class: "link fine mono", href: `${EXPLORER}/address/${r.prizeAddress}`, target: "_blank", rel: "noopener" }, `${r.prizeAddress.slice(0, 8)}…${r.prizeAddress.slice(-6)} on Blockscout`)),
      h("div", { class: "hh-stat" }, h("small", {}, "Status"), h("b", { class: `hh-st s-${r.status}` }, status),
        r.open && r.endAt ? h("span", { class: "fine" }, left(r.endAt - now)) : r.status === "setup" ? h("span", { class: "fine" }, "The team opens the round and announces it on X and Telegram.") : null),
      h("div", { class: "hh-stat" }, h("small", {}, "Attempts"), h("b", {}, String(data.total)), h("span", { class: "fine" }, `${data.attemptsToday} of ${data.limits.perDay} today`)));

    if (r.status === "won") {
      clear(play, h("div", { class: "hh-won" },
        h("h2", {}, "The heel was found."),
        h("p", {}, `${r.winner.slice(0, 8)}…${r.winner.slice(-6)} talked the Vault Keeper into releasing the prize.`),
        r.winTx ? h("a", { class: "btn", href: `${EXPLORER}/tx/${r.winTx}`, target: "_blank", rel: "noopener" }, "The payout on Blockscout") : h("p", { class: "fine" }, "The payout is being sent.")));
    } else if (!r.open) {
      clear(play, h("div", { class: "hh-closed" },
        h("h2", {}, r.status === "setup" ? "Heel Hunt opens soon." : "This round has ended."),
        h("p", {}, r.status === "setup" ? "When it opens, sign in with your wallet and send the Vault Keeper one message at a time. Free to enter." : "Nobody talked the Vault Keeper into it. The prize goes back to the Troya team, as the rules said.")));
    } else {
      const box = h("textarea", { class: "input hh-in", rows: "4", maxlength: String(data.limits.chars), placeholder: "Your message to the Vault Keeper…", "aria-label": "Your message to the Vault Keeper" });
      const count = h("span", { class: "fine hh-count" }, `0 / ${data.limits.chars}`);
      const send = h("button", { class: "btn primary", type: "button" }, "Send to the Vault Keeper");
      const answer = h("div", { class: "hh-answer", "aria-live": "polite" });
      box.addEventListener("input", () => { count.textContent = `${box.value.length} / ${data.limits.chars}`; });
      send.addEventListener("click", async () => {
        const message = box.value.trim();
        if (!message) { box.focus(); return; }
        send.disabled = true;
        try {
          if (!wallet.session) {
            if (!wallet.address) { openConnect(); toast("Connect and sign in, then send again.", "", 4500); return; }
            await signIn();
          }
          clear(answer, h("p", { class: "fine" }, "The Vault Keeper is thinking…"));
          const res = await api.post("/api/heelhunt/attempt", { message });
          clear(answer, h("div", { class: `hh-reply${res.won ? " won" : ""}` }, h("small", {}, "Vault Keeper"), h("p", {}, res.reply || "…"),
            res.won ? h("p", { class: "hh-win" }, "It released the prize to your wallet.") : null));
          box.value = ""; count.textContent = `0 / ${data.limits.chars}`;
          load();
        } catch (e) { clear(answer); toast(e.message || String(e), "error", 6000); }
        finally { send.disabled = false; }
      });
      clear(play,
        h("h2", {}, "Talk the Vault Keeper into it."),
        h("p", { class: "fine" }, `One message per try, up to ${data.limits.chars} characters, one try every ${data.limits.perWalletMinutes} minutes. Each try starts fresh: the keeper does not remember earlier ones. If it releases the prize, it goes to the wallet you signed in with.`),
        box, h("div", { class: "hh-send" }, count, send), answer);
    }

    clear(feed, h("h3", {}, "Every attempt, in the open"),
      data.attempts.length ? h("ol", { class: "hh-list" }, data.attempts.map((a) => h("li", { class: `hh-a${a.won ? " won" : ""}` },
        h("div", { class: "hh-a-h" }, h("b", { class: "mono" }, a.wallet), h("span", { class: "fine" }, `#${a.id} · ${ago(a.at)} ago`), a.won ? h("span", { class: "hh-tag" }, "Won") : null),
        h("p", { class: "hh-q" }, a.message),
        h("p", { class: "hh-r" }, h("small", {}, "Vault Keeper: "), a.reply)))) : h("p", { class: "fine" }, "No attempts yet."));

    clear(rules, h("h3", {}, "Rules"), h("ul", { class: "hh-rl" }, data.rules.map((x) => h("li", {}, x))),
      h("p", { class: "fine" }, `Model: ${data.model}. The keeper's instructions are fixed for the round. sha256: `, h("code", { class: "mono hh-hash" }, data.promptSha256)),
      data.systemPrompt ? h("details", {}, h("summary", {}, "The keeper's instructions (published after the round)"), h("pre", { class: "hh-pre" }, data.systemPrompt)) : null);
  }

  clear(view, h("div", { class: "dk hh-page" },
    h("header", { class: "dk-pagehead" },
      h("p", { class: "dk-eyebrow" }, "Discover · Heel Hunt"),
      h("h1", {}, "Find Troya's ", h("em", {}, "heel"), "."),
      h("p", { class: "dk-sub" }, "The Vault Keeper is an AI with a real tool that sends the prize. Talk it into using that tool and the prize is yours. Free to enter, every attempt public. Troya hunts for its own weak spot before anyone else finds it.")),
    h("section", { class: "panel hh-top" }, head), play, feed, rules));
  load();
  timer = setInterval(() => { if (alive && document.visibilityState === "visible") load(); }, 30_000);
  return () => { alive = false; clearInterval(timer); };
}
