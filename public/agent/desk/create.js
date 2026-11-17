// Create coin (#/create): the one place every "Create coin" button leads to. Three ways to launch on Robinhood Chain
// through Troya: troya.codes (own wallet, open to everyone), X (post to @Troyaagent, holders) and Telegram (/launch to the bot).
// Numbers and status come from /api/launch/rules, so the page never promises what is not live.
import { h, clear, useCss, pageHead } from "/agent/js/ui.js";
import { api } from "/agent/js/api.js";

const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 3h3l-6.6 7.5L21.6 21h-6l-4.7-6.1L5.4 21h-3l7.1-8.1L2.2 3h6.1l4.2 5.6L17.5 3zm-1 16.2h1.7L7.6 4.7H5.8l10.7 14.5z"/></svg>';
const TG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.5-1.5zm-3.3 3.2-8.6 7.8-.3 3.4-1.4-4.5 10.3-6.7z"/></svg>';
const WEB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';
const svg = (s) => { const e = h("span", { class: "cc-ic", "aria-hidden": "true" }); e.innerHTML = s; return e; };

export async function mount(view) {
  useCss("perps");
  let alive = true;
  const grid = h("div", { class: "cc-grid" });
  clear(view, h("div", { class: "dk cc" },
    pageHead("Create coin", "Three ways to launch a coin on Robinhood Chain through Troya. Each one lands on the Pons curve, gets checked by the Gate, and shows up in Troya Launches."),
    grid,
    h("p", { class: "cc-foot" }, "Every coin born through Troya: ", h("a", { class: "ulink", href: "#/hippodrome" }, "Troya Launches"), " · Every new coin on Robinhood Chain: ", h("a", { class: "ulink", href: "#/launch" }, "All launches"))));

  function card({ ic, title, sub, status, tone, points, cta, href, off, guide }) {
    return h("article", { class: `panel cc-card${off ? " off" : ""}` },
      h("div", { class: "cc-top" }, svg(ic), h("span", { class: `cc-status ${tone}` }, status)),
      h("h2", {}, title), h("p", { class: "cc-sub" }, sub),
      h("ul", { class: "cc-points" }, points.map((p) => h("li", {}, p))),
      off ? h("span", { class: "btn cc-cta", "aria-disabled": "true" }, cta) : h("a", { class: "btn primary cc-cta", href, ...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener" } : {}) }, cta),
      guide ? h("a", { class: "cc-guide ulink", href: guide, target: "_blank", rel: "noopener" }, "Read the full guide") : null);
  }

  function paint(r) {
    const live = !!r?.splitter?.live, min = (r?.holderMin || 1_000_000).toLocaleString("en-US");
    const fee = live ? `You earn 0.6% of trading volume, Troya 0.1%. Hold ${min} $TROYA and you keep the whole 0.7%.` : "You earn 70% of the 1% trading fee.";
    clear(grid,
      card({ ic: WEB_ICON, title: "On troya.codes", sub: "Fill in the form and sign with your own wallet.", status: "Open to everyone", tone: "ok",
        points: ["Free to launch through Troya: you pay the Pons launch fee and gas.", fee, `Creator tax 0–4%, all yours. Up to ${r?.limits?.perDay ?? 3} launches a day; holders of ${min} $TROYA have no limit.`],
        cta: "Create on troya.codes", href: "#/launch/create" }),
      card({ ic: X_ICON, title: "From X", sub: "Post to @Troyaagent and your Agent Wallet launches it.", status: r?.xLaunch ? "Open to everyone" : "In its real-money test", tone: r?.xLaunch ? "ok" : "test",
        points: [`One launch a day, or as many as you like with ${min} $TROYA.`, fee, "Write \"launch Name $TICKER\", or in your own words; add \"tax 2%\" and \"buy 0.01\".",
          "Attach the coin's image: square (1:1) works best, PNG or JPEG up to 5 MB; other shapes get cropped to the middle. Without one, the coin launches with no image, for good.", "Troya replies in seconds with the address and market cap, or with what to fix."],
        cta: "Set up Launch from X", href: "#/launch/x", guide: "/launch-on-x" }),
      r?.tgLaunch
        ? card({ ic: TG_ICON, title: "In Telegram", sub: `Send /launch to @${r.tgBot} in a private chat.`, status: "Open to everyone", tone: "ok",
          points: ["Answer step by step: name, ticker, image, creator tax, initial buy. Or send the image with the caption \"/launch Wooden Horse $HORSE tax 2% buy 0.01\".",
            fee, "Your Agent Wallet pays the Pons launch fee and the buy; Troya pays the gas. Link the chat once in Settings → Telegram alerts.",
            "A preview with a Confirm button comes before anything is sent."],
          cta: "Open the Troya bot", href: `https://t.me/${r.tgBot}?start=launch` })
        : card({ ic: TG_ICON, title: "In Telegram", sub: "Launch from a private chat with the Troya bot.", status: "In its real-money test", tone: "test", off: true,
          points: ["Open to everyone.", "Step by step in the chat, or one photo with a caption, then a preview and a Confirm button.", "Opens after its real-money test."],
          cta: "Opening soon" }));
  }

  paint(null);
  api.get("/api/launch/rules").then((r) => { if (alive) paint(r); }).catch(() => {});
  return () => { alive = false; };
}
