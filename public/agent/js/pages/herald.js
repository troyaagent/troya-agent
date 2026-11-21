// V8 F42 Herald (#/herald): your referral link and what it brought, the share-card maker, the referral leaderboard, the
// weekly Arena Cup (paper PnL %, not volume) and the contributor board (real work such as code, guides and videos, never posts).
// No money moves from this page: rewards and prizes show what the owner has set, or say they are not switched on yet.
import { h, clear, useCss, pageHead, seg, toast, modal, ago } from "../ui.js";
import { api } from "../api.js";
import { wallet, onWallet, openConnect, signIn } from "../wallet.js";
import { W, H, drawCard, gateSpec, watchfireSpec, cupPnlSpec, shareUrl, actions, refNote, refOf, xIntent } from "../sharecard.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const pct = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`);
const eth = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)} ETH`;
const left = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`; };
const n = (v) => Number(v || 0).toLocaleString("en-US");
// AI traders carry their model maker's mark, the same self-hosted SVGs (and the same map) the Arena uses in agent.js
const AI_LOGOS = { "ai-claude": "claude", "ai-gpt": "gpt", "ai-gemini": "gemini", "ai-deepseek": "deepseek", "ai-qwen": "qwen" };

export async function mount(view) {
  useCss("herald");
  let alive = true;
  const st = { me: null, meErr: null, lb: null, lbErr: null, cup: null, cupErr: null, week: "this", b: null, bErr: null };
  const linkBox = h("section", { class: "panel hr-link" });
  const lbBox = h("section", { class: "panel hr-lb" });
  const cupBox = h("section", { class: "panel hr-cup" });
  const boardBox = h("section", { class: "panel hr-board" });
  const jump = h("nav", { class: "hr-jump", "aria-label": "Sections" },
    [["Your link", linkBox], ["Leaderboard", lbBox], ["Arena Cup", cupBox], ["Contributor board", boardBox]].map(([t, el]) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); el.scrollIntoView({ behavior: "smooth", block: "start" }); } }, t)));
  // "hr-page", not "hr": app.css styles .hr as a 1 px divider, which collapsed this wrapper and let the footer show through
  clear(view, h("div", { class: "hr-page" },
    pageHead("Herald", "Bring people to Troya with your own link. Share cards for Gate verdicts, Watchfire alerts and your PnL carry it. A weekly Arena Cup ranks paper strategies by PnL %, not volume, and the contributor board pays for real work, never for posts."),
    jump, linkBox, h("div", { class: "hr-grid" }, lbBox, cupBox), boardBox));

  /* ---------- the card maker (also used signed out: the card then carries the plain site link) ---------- */
  // A PnL card is never typed in here (21 Nov audit, 3-13: a free symbol and % made a fake "+10,000%" Troya card easy).
  // Real trades are shared from Portfolio (Share PnL on a token or a closed Hyperliquid trade, read from the chain); this
  // page offers only your Arena Cup week, from the Cup's own table and marked as paper.
  const maker = (() => {
    let kind = "gate", cur = null, drawnWith;          // drawnWith: the referral code on the last card drawn
    const canvas = h("canvas", { class: "hr-canvas", width: W, height: H, "aria-label": "Share card preview" });
    const msg = h("p", { class: "fine muted hr-msg" }, "Pick a card, fill it in and press Make card.");
    const addr = h("input", { class: "input mono", placeholder: "Coin address on Robinhood Chain (0x…)", spellcheck: "false", autocomplete: "off", value: window.SITE?.ca || "" });
    const fields = h("div", { class: "hr-fields" });
    const cupFill = h("button", { class: "btn sm", type: "button", hidden: true, onclick: () => {
      if (!st.cup?.mine) return;
      if (kind !== "pnl") pick.querySelector('[data-v="pnl"]')?.click();
      make();
    } }, "Use my Arena Cup week");
    const pnlInfo = () => h("div", { class: "hr-pnl" },
      h("p", { class: "fine", style: { margin: 0 } }, "PnL cards are read, never typed: open Portfolio and press Share PnL on a token or a closed Hyperliquid trade. The card carries the transaction it was read from, so anyone can check it."),
      h("div", { class: "hr-acts" }, h("a", { class: "btn sm", href: "#/portfolio" }, "Open Portfolio"), h("a", { class: "btn sm", href: "#/portfolio/history" }, "Hyperliquid trades")),
      st.cup?.mine ? null : h("p", { class: "fine muted", style: { margin: 0 } }, "Your Arena Cup week can be shared here too, as paper, once a strategy of yours has closed trades this week."));
    const paintFields = () => clear(fields, kind === "pnl" ? pnlInfo() : addr);
    const pick = seg([{ value: "gate", label: "Gate verdict" }, { value: "watchfire", label: "Watchfire" }, { value: "pnl", label: "PnL" }], kind, (v) => { kind = v; paintFields(); });
    async function make() {
      if (drawnWith === undefined) drawnWith = null;
      msg.textContent = "Drawing…";
      try {
        let spec;
        if (kind === "pnl") {
          if (!st.cup?.mine) throw new Error("Share a real trade from Portfolio, or come back once you have an Arena Cup week.");
          spec = cupPnlSpec(st.cup);
        } else {
          const a = addr.value.trim();
          if (!ADDR.test(a)) throw new Error("Paste a coin address (0x and 40 characters).");
          spec = kind === "gate" ? await gateSpec(a) : await watchfireSpec(a);
        }
        canvas.classList.add("busy");
        await drawCard(spec, refOf(st.me), canvas);
        cur = { canvas, spec, url: shareUrl(st.me, spec.address) };
        drawnWith = st.me?.code || null;
        msg.textContent = spec.loading ? "Watchfire is still reading this coin. Try again in a few seconds for a full card." : "Download the card, then attach it to your post.";
      } catch (e) { msg.textContent = e.message; }
      finally { canvas.classList.remove("busy"); }
    }
    paintFields();
    const note = h("div");
    const el = h("div", { class: "hr-maker" },
      h("div", { class: "hr-maker-top" }, h("h3", {}, "Card maker"), pick),
      fields,
      h("div", { class: "hr-acts" }, h("button", { class: "btn primary", type: "button", onclick: make }, "Make card"), cupFill),
      h("div", { class: "hr-frame" }, canvas), msg, actions(() => cur), note);
    return { el, refresh() {
      cupFill.hidden = !st.cup?.mine;
      if (kind === "pnl") paintFields();                 // the Cup line depends on whether you have a week yet
      clear(note, refNote(refOf(st.me), () => loadMe()));
      // a first card ($TROYA's Gate verdict) so the preview is never empty; redrawn once the link is known
      if (wallet.session && !st.me && !st.meErr) return;
      const code = st.me?.code || null;
      if (drawnWith === undefined ? ADDR.test(addr.value.trim()) : cur && drawnWith !== code) make();
    } };
  })();

  /* ---------- your link ---------- */
  function paintLink() {
    const head = h("div", { class: "hr-h" }, h("h2", {}, "Your link"), st.me?.rank ? h("span", { class: "badge-s blue" }, `#${st.me.rank} on the leaderboard`) : null);
    let left;
    if (!wallet.session) {
      left = h("div", { class: "hr-link-l" },
        h("p", { class: "hr-lead" }, "Every wallet that signs in through your link counts for you. Only what it does after that counts: launches through Troya, Agent Wallet trades and Gate calls."),
        h("button", { class: "btn primary", type: "button", onclick: async () => { try { if (!wallet.address) await openConnect(); if (wallet.address && !wallet.session) await signIn(); } catch (e) { toast(e.message, "error"); } } }, wallet.address ? "Sign in to get your link" : "Connect and sign in"),
        h("p", { class: "fine muted" }, "Signing in sends nothing and costs no gas."));
    } else if (!st.me) {
      left = h("div", { class: "hr-link-l" }, st.meErr ? h("div", { class: "alert error" }, st.meErr) : h("div", { class: "sk", style: { height: "180px" } }));
    } else {
      // the short /r/ link: its page carries a proper link preview on X and Telegram (server/share.mjs), and keeps the code
      const m = st.me, s = m.stats, link = refOf(m)?.link || m.link;
      const tile = (k, v, sub) => h("div", { class: "hr-tile" }, h("span", {}, k), h("b", {}, v), sub ? h("small", {}, sub) : null);
      const intro = "I check coins on Robinhood Chain with Troya Agent before I buy: the Gate tests a buy and a sell, Watchfire reads every transfer.";
      left = h("div", { class: "hr-link-l" },
        h("div", { class: "hr-code" }, h("span", { class: "fine muted" }, "Your code"), h("b", { class: "mono" }, m.code)),
        h("div", { class: "hr-copy" }, h("input", { class: "input mono", readonly: true, value: link, "aria-label": "Your referral link", onclick: (e) => e.target.select() }),
          h("button", { class: "btn", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(link); toast("Link copied", "ok"); } catch { toast(link); } } }, "Copy"),
          h("a", { class: "btn", href: xIntent(intro, link), target: "_blank", rel: "noopener" }, "Post on X")),
        h("div", { class: "hr-tiles" },
          tile("Joined", n(s.referred), "through your link"),
          tile("Active", n(s.active), "did something after"),
          tile("Launches", n(s.launches), s.feeLaunches ? `${n(s.feeLaunches)} pay Troya's fee` : "through Troya"),
          tile("Trades", n(s.trades), "from Agent Wallets"),
          tile("Gate calls", n(s.gateCalls), "paid checks")),
        h("div", { class: `hr-reward ${m.rewards.on ? "on" : ""}` },
          m.rewards.on ? h("div", { class: "hr-reward-n" }, h("span", {}, "Earned (pending)"), h("b", {}, `$${Number(m.rewards.pendingUsd || 0).toFixed(2)}`), h("small", {}, "paid in ETH")) : null,
          h("p", {}, m.rewards.text), m.rewards.covers ? h("p", { class: "fine muted" }, m.rewards.covers) : null),
        m.referredBy ? h("p", { class: "fine muted" }, `You joined through ${m.referredBy.wallet}'s link ${ago(m.referredBy.at)} ago.`) : null,
        m.wallets?.length ? h("div", { class: "hr-wallets" }, h("span", { class: "fine muted" }, "Latest wallets you brought"),
          h("ul", {}, m.wallets.slice(0, 8).map((x) => h("li", {}, h("span", { class: "mono" }, x.wallet), h("span", { class: "fine muted" }, `${ago(x.at)} ago`), x.active ? h("span", { class: "badge-s blue" }, "active") : h("span", { class: "badge-s" }, "not yet"))))) : null,
        h("p", { class: "fine muted" }, m.how));
    }
    clear(linkBox, head, h("div", { class: "hr-link-b" }, left, maker.el));
    maker.refresh();
  }

  /* ---------- referral leaderboard ---------- */
  function paintLb() {
    const d = st.lb;
    const head = h("div", { class: "hr-h" }, h("h2", {}, "Referral leaderboard"), d ? h("span", { class: "fine muted" }, `${n(d.totals.referred)} wallets joined · ${n(d.totals.active)} active`) : null);
    if (!d) { clear(lbBox, head, st.lbErr ? h("div", { class: "alert error hr-pad" }, st.lbErr) : h("div", { class: "sk hr-pad", style: { height: "160px" } })); return; }
    const body = d.rows.length
      ? h("div", { class: "hr-scroll" }, h("table", { class: "hr-tbl" },
        h("thead", {}, h("tr", {}, ["#", "Referrer", "Active", "Joined", "Launches", "Trades", "Gate"].map((x) => h("th", {}, x)))),
        h("tbody", {}, d.rows.map((r) => h("tr", {}, h("td", {}, String(r.rank)), h("td", { class: "mono" }, r.referrer), h("td", { class: "b" }, n(r.active)), h("td", {}, n(r.referred)), h("td", {}, n(r.launches)), h("td", {}, n(r.trades)), h("td", {}, n(r.gateCalls)))))))
      : h("div", { class: "hr-empty" }, h("b", {}, "No referrals yet."), h("p", {}, "Share your link or a card. The first wallets that join through it put you on this board."));
    clear(lbBox, head, body, h("p", { class: "fine muted hr-pad" }, d.rule), h("p", { class: "fine hr-pad hr-rw" }, d.rewards));
  }

  /* ---------- Arena Cup ---------- */
  function paintCup() {
    const d = st.cup;
    const week = seg([{ value: "this", label: "This week" }, { value: "prev", label: "Last week" }], st.week, (v) => { st.week = v; st.cup = null; paintCup(); loadCup(); });
    const head = h("div", { class: "hr-h" }, h("h2", {}, "Arena Cup", d ? h("span", { class: "hr-season mono" }, d.season) : null), week);
    if (!d) { clear(cupBox, head, st.cupErr ? h("div", { class: "alert error hr-pad" }, st.cupErr) : h("div", { class: "sk hr-pad", style: { height: "160px" } })); return; }
    const when = d.final ? `Final standings, ${new Date(d.start).toUTCString().slice(5, 11)} to ${new Date(d.end - 1).toUTCString().slice(5, 11)}` : `Ends in ${left(d.endsIn)} (Monday 00:00 UTC)`;
    const rows = (list, ranked) => h("tbody", {}, list.map((r) => h("tr", { class: r.mine ? "mine" : "" },
      h("td", {}, ranked ? String(r.rank) : "–"), h("td", { class: r.model ? "" : "mono" },
        AI_LOGOS[r.id] ? h("img", { class: "hr-logo", src: `/img/logos/ai/${AI_LOGOS[r.id]}.svg`, alt: "", width: 14, height: 14, loading: "lazy", decoding: "async" }) : null,
        r.name, r.mine ? h("span", { class: "badge-s blue hr-you" }, "you") : null,
        // $TROYA staking tier points: display only, the order and the prizes stay PnL %
        r.stakePoints ? h("span", { class: "badge-s stk-badge hr-stk", title: "$TROYA staker points, shown for fun: they do not change the order or the prizes" }, `${r.stakePoints} pts`) : null),
      h("td", { class: `b ${r.pnlPct > 0 ? "up" : r.pnlPct < 0 ? "down" : ""}` }, pct(r.pnlPct)), h("td", {}, eth(r.pnlEth)), h("td", {}, String(r.closed)), h("td", {}, r.closed ? `${Math.round((r.wins / r.closed) * 100)}%` : "–"))));
    const thead = () => h("thead", {}, h("tr", {}, ["#", "Trader", "PnL %", "PnL", "Closed", "Won"].map((x) => h("th", {}, x))));
    clear(cupBox, head,
      h("div", { class: "hr-cup-meta hr-pad" }, h("span", {}, when), h("span", { class: `hr-prize ${d.prizeOn ? "on" : ""}` }, d.prize)),
      d.ranked.length ? h("div", { class: "hr-scroll" }, h("table", { class: "hr-tbl" }, thead(), rows(d.ranked, true)))
        : h("div", { class: "hr-empty" }, h("b", {}, d.final ? "Nobody qualified that week." : "Nobody has 3 closed trades this week yet."), h("p", {}, "Write a strategy in plain words in the Arena and run it on paper. It enters the Cup on its own."),
          h("a", { class: "btn primary sm", href: "#/agent/arena" }, "Open the Arena")),
      d.running.length ? h("p", { class: "fine muted hr-pad" }, `In the running with fewer than 3 closed trades: ${d.running.map((r) => `${r.name} (${r.closed})`).join(", ")}.`) : null,
      h("p", { class: "fine muted hr-pad" }, d.rule),
      d.stakePointsNote ? h("p", { class: "fine muted hr-pad" }, d.stakePointsNote) : null,
      d.ai.length ? h("details", { class: "hr-ai" }, h("summary", {}, `AI traders this week, for reference (${d.ai.length})`), h("div", { class: "hr-scroll" }, h("table", { class: "hr-tbl" }, thead(), rows(d.ai, false)))) : null,
      h("p", { class: "fine muted hr-pad" }, d.note, " ", h("a", { class: "link", href: "#/agent/arena" }, "Enter with a strategy")));
  }

  /* ---------- contributor board ---------- */
  function submit(b) {
    const link = h("input", { class: "input", placeholder: "https:// link to the work (repo, document, video or file)", maxlength: "300" });
    const note = h("textarea", { class: "input hr-ta", placeholder: "A few words on what you did (optional)", maxlength: "1000", rows: "4" });
    const err = h("p", { class: "fine hr-err" });
    const m = modal({ title: "Submit work", body: h("div", { class: "hr-sub" },
      h("p", { class: "hr-sub-t" }, b.title), h("p", { class: "fine muted" }, b.detail),
      h("label", { class: "field" }, h("span", {}, "Link"), link), h("label", { class: "field" }, h("span", {}, "Note"), note), err,
      h("div", { class: "row", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn primary", type: "button", onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true; err.textContent = "";
          try {
            const r = await api.post(`herald/bounties/${encodeURIComponent(b.id)}/submit`, { link: link.value.trim(), note: note.value.trim() });
            toast(r.message || "Sent", "ok", 5000); m.close(); loadBoard();
          } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
        } }, "Send"))) });
  }
  async function needSession() {
    if (wallet.session) return true;
    try { if (!wallet.address) await openConnect(); if (wallet.address) await signIn(); } catch (e) { toast(e.message, "error"); }
    return !!wallet.session;
  }
  function adminPanel(d) {
    const title = h("input", { class: "input", placeholder: "Title", maxlength: "140" });
    const kind = h("select", { class: "select" }, Object.entries(d.kinds).map(([k, v]) => h("option", { value: k }, v)));
    const reward = h("input", { class: "input", placeholder: "Reward (text), e.g. Set by the team", maxlength: "80" });
    const detail = h("textarea", { class: "input hr-ta", placeholder: "What counts as done", rows: "3", maxlength: "1200" });
    const subs = d.submissions || [];
    return h("div", { class: "hr-admin" },
      h("h3", {}, "Admin"),
      h("div", { class: "hr-admin-add" }, title, kind, reward, detail,
        h("button", { class: "btn primary sm", type: "button", onclick: async () => {
          try { await api.post("herald/bounties", { title: title.value, kind: kind.value, reward: reward.value, detail: detail.value }); toast("Bounty added", "ok"); loadBoard(); } catch (e) { toast(e.message, "error"); }
        } }, "Add bounty")),
      h("h3", {}, `Submissions (${subs.length})`),
      subs.length ? h("ul", { class: "hr-subs" }, subs.map((s) => h("li", {},
        h("div", {}, h("b", {}, s.bountyTitle), h("p", { class: "fine muted" }, `${s.by} · ${ago(s.at)} ago · `, h("a", { class: "link", href: s.link, target: "_blank", rel: "noopener nofollow ugc" }, s.link.replace(/^https:\/\//, "").slice(0, 60))), s.note ? h("p", { class: "fine" }, s.note) : null),
        h("div", { class: "hr-subs-a" }, h("span", { class: `badge-s ${s.status === "accepted" ? "blue" : s.status === "rejected" ? "down" : ""}` }, s.status),
          (d.submissionStatuses || []).filter((x) => x !== s.status).map((x) => h("button", { class: "btn sm", type: "button", onclick: async () => {
            try { await api.post(`herald/submissions/${s.id}`, { status: x }); loadBoard(); } catch (e) { toast(e.message, "error"); }
          } }, x)))))) : h("p", { class: "fine muted" }, "None yet."));
  }
  function paintBoard() {
    const d = st.b;
    const head = h("div", { class: "hr-h" }, h("h2", {}, "Contributor board"), h("span", { class: "fine muted" }, "Real work, never posts"));
    if (!d) { clear(boardBox, head, st.bErr ? h("div", { class: "alert error hr-pad" }, st.bErr) : h("div", { class: "sk hr-pad", style: { height: "200px" } })); return; }
    const setStatus = (b, status) => api.post("herald/bounties", { id: b.id, status }).then(() => loadBoard()).catch((e) => toast(e.message, "error"));
    clear(boardBox, head, h("p", { class: "hr-pad hr-lead" }, d.rule),
      h("div", { class: "hr-bounties" }, d.bounties.map((b) => h("article", { class: `hr-bounty s-${b.status}` },
        h("div", { class: "hr-bounty-top" }, h("span", { class: `hr-kind k-${b.kind}` }, b.kindLabel), h("span", { class: "fine muted" }, b.status === "open" ? "Open" : b.status === "review" ? "In review" : b.status === "done" ? "Done" : "Closed")),
        h("h3", {}, b.title), h("p", {}, b.detail),
        h("div", { class: "hr-bounty-f" },
          h("span", { class: "fine" }, h("span", { class: "muted" }, "Reward: "), b.reward),
          b.submissions ? h("span", { class: "fine muted" }, `${b.submissions} sent`) : null,
          b.status === "open" ? h("button", { class: "btn sm primary", type: "button", onclick: async () => { if (await needSession()) submit(b); } }, "Submit work") : null),
        d.admin ? h("div", { class: "hr-bounty-adm" }, ["open", "review", "done", "closed"].filter((x) => x !== b.status).map((x) => h("button", { class: "btn sm", type: "button", onclick: () => setStatus(b, x) }, x))) : null))),
      d.mine?.length ? h("div", { class: "hr-mine hr-pad" }, h("h3", {}, "Your submissions"), h("ul", { class: "hr-subs" }, d.mine.map((s) => h("li", {},
        h("div", {}, h("b", {}, s.bountyTitle), h("p", { class: "fine muted" }, `${ago(s.at)} ago · ${s.link.replace(/^https:\/\//, "").slice(0, 60)}`), s.adminNote ? h("p", { class: "fine" }, s.adminNote) : null),
        h("span", { class: `badge-s ${s.status === "accepted" ? "blue" : s.status === "rejected" ? "down" : ""}` }, s.status === "new" ? "waiting" : s.status))))) : null,
      d.admin ? adminPanel(d) : null);
  }

  /* ---------- data ---------- */
  async function loadMe() {
    if (!wallet.session) { st.me = null; st.meErr = null; if (alive) paintLink(); return; }
    try { st.me = await api.get("herald/me"); st.meErr = null; } catch (e) { st.meErr = e.message; }
    if (alive) paintLink();
  }
  async function loadLb() { try { st.lb = await api.get("herald/leaderboard"); st.lbErr = null; } catch (e) { st.lbErr = e.message; } if (alive) paintLb(); }
  async function loadCup() {
    const w = st.week;
    try { const d = await api.get(`herald/cup${w === "prev" ? "?week=prev" : ""}`); if (w !== st.week) return; st.cup = d; st.cupErr = null; } catch (e) { st.cupErr = e.message; }
    if (alive) { paintCup(); maker.refresh(); }
  }
  async function loadBoard() { try { st.b = await api.get("herald/bounties"); st.bErr = null; } catch (e) { st.bErr = e.message; } if (alive) paintBoard(); }

  paintLink(); paintLb(); paintCup(); paintBoard();
  let lastSession = undefined;
  const off = onWallet(() => {
    const s = wallet.session?.address || null;
    if (s === lastSession) return;
    lastSession = s;
    st.me = null; loadMe(); loadCup(); loadBoard();
  });
  loadLb();
  const tick = setInterval(() => { if (!document.hidden && st.week === "this") loadCup(); }, 60_000);
  return () => { alive = false; off?.(); clearInterval(tick); };
}
