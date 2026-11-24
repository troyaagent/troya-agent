// Live facts for the bots (Telegram group AI and the X replies) and the in-app assistant.
// Owner, 19 Nov 2026: the bots' knowledge must always stay up to date by itself. The written prompt in tgbot.mjs goes
// stale whenever a phase ships, so every answer also gets a short block read from the site itself: which roadmap
// phases are live (a tick on troya.codes/roadmap) and which real-money receipts exist (troya.codes/verify). The block
// is cached for 15 minutes and the last good copy is kept if the site cannot be read.
// Audit, 20 Nov 2026: the in-app assistant (server/assistant.mjs) reads this block too, and the feature glossary
// (glossary() below, the same lines the in-app Guide uses) so it knows what each feature IS, not only what shipped.
// 21 Nov 2026: every block also carries WORK IN PROGRESS (workBlock() below): what the team is building right now and
// what shipped as an opt-in, so no bot calls an unbuilt feature live.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.PORT || 9270;
const TTL = 15 * 60 * 1000;
let cache = { at: 0, full: "", brief: "" };
let inflight = null;

const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
const big = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

async function page(path) {
  for (const base of [`http://127.0.0.1:${PORT}`, "https://troya.codes"]) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(6000) }); if (r.ok) return await r.text(); } catch {}
  }
  return "";
}
async function json(path) { try { const t = await page(path); return t ? JSON.parse(t) : null; } catch { return null; } }

// brief: phase names and their status only (the assistant gets what each phase does from the glossary)
function roadmap(html, { brief = false } = {}) {
  const out = [];
  for (const sec of html.split(/<section\b/).slice(1)) {
    const num = (sec.match(/<span class="rm-num">(V\d+)<\/span>/) || [])[1];
    if (!num) continue;
    const title = strip((sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
    const chip = (sec.match(/rm-chip (\w+)/) || [])[1] || "";
    // the chip's own words win: "Live, finishing" on a build-coloured chip means live, not "in build"
    const chipText = strip((sec.match(/rm-chip \w+"><i><\/i>([^<]*)</) || [])[1] || "");
    const phases = [...sec.matchAll(/<li class="rm-ph( next)?"[\s\S]*?<small>(F\d+)<\/small><b>([\s\S]*?)<\/b>(?:<span>([\s\S]*?)<\/span>)?/g)].map((m) => {
      // the name without its Open link, its "New" badge and its "From the live Arena" note
      const name = strip(m[3].replace(/<a[\s\S]*?<\/a>/g, "").replace(/<span class="new-badge"[\s\S]*?<\/span>/g, "").replace(/<em class="rm-from"[\s\S]*?<\/em>/g, ""));
      if (m[1]) return `${m[2]} ${name}: NOT live yet`;
      // a phase's own status tag ("Live · read-only", "Real-money test pending"); a pending test says what it waits for
      // (a <strong>, or an <a> when it links to its receipt on /verify)
      const st = /<(strong|a) class="rm-st (\w+)"[^>]*?(?: title="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/.exec(m[4] || "");
      const label = st ? strip(st[4]) : "";
      const status = !label ? "LIVE" : /^live\b/i.test(label) ? `LIVE${label.slice(4)}` : `LIVE, ${label.toLowerCase()}${st[2] === "wait" && st[3] ? ` (${strip(st[3])})` : ""}`;
      const desc = strip((m[4] || "").replace(st?.[0] || "", ""));
      return brief || !desc ? `${m[2]} ${name}: ${status}` : `${m[2]} ${name}: ${status} (${cut(desc, 110)})`;
    });
    const status = chip === "live" ? "shipped" : /\blive\b/i.test(chipText) ? `${chipText}: every phase running, real-money tests and switches next` : chip === "build" ? "in build" : chip || "status not shown";
    out.push(`${num} ${title} [${status}]: ${phases.join("; ")}`);
  }
  return out;
}

function receipts(html) {
  return [...html.matchAll(/<article class="step[^"]*"[^>]*>\s*<span class="n">(\d+)<\/span>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => {
    const when = (strip(m[3]).match(/^\d{1,2} \w{3} \d{4}/) || [""])[0];
    // the title without the "New" badge that sits inside it
    return when ? `${m[1]} ${strip(m[2].replace(/<span class="new-badge"[\s\S]*?<\/span>/g, ""))} (${when})` : "";
  }).filter(Boolean);
}

// the terms people ask about most and that the team changes from the admin side: read live, never written in a prompt
function tiers(t) {
  if (!Array.isArray(t?.tiers) || !t.tiers.length) return "";
  const rows = t.tiers.map((x) => `${x.name} (${x.min ? `${big(x.min)} $TROYA` : "anyone"}): ${x.watchfirePins} Watchfire pin${x.watchfirePins === 1 ? "" : "s"}, ${x.gateChecksPerDay ?? "the holder quota of"} Gate checks a day${x.perks ? ", holder perks" : ""}${Array.isArray(x.extras) && x.extras.length ? `, plus ${x.extras.join(" and ")}` : ""}`);
  return `Holder tiers (troya.codes/agent#/treasury, counted across ${t.counted || "the signed-in wallet and its Agent Wallet"}): ${rows.join("; ")}.${t.perks ? ` ${t.perks}` : ""}${t.pro?.note ? ` ${t.pro.note}` : ""}`;
}
function herald(lb, cup) {
  const parts = [];
  if (lb?.rewards) parts.push(String(lb.rewards));
  if (cup?.name) parts.push(`${cup.name}: ${cup.prizeOn && cup.prize ? cup.prize : "no prize is set right now."} ${cup.rule || ""}`.trim());
  return parts.length ? `Herald terms (troya.codes/agent#/herald): ${parts.join(" ")}` : "";
}

// free gas (server/gas.mjs) and where it comes from (owner, 22 Nov 2026): the funding sentence is the server's own
// (/api/feesplit gasTopup.line: "refills every day" only once GAS_TOPUP is live, "will be refilled" while it is dry, nothing
// while off), the honest limits right after it, read from the live gas settings (/api/gas/status)
export function gasFacts(gs, fsp) {
  const fund = typeof fsp?.gasTopup?.line === "string" ? fsp.gasTopup.line.slice(0, 400) : "";
  if (!gs && !fund) return "";
  const every = !gs ? "" : Number(gs.everyDays) === 7 ? "a week" : `every ${gs.everyDays} days`;
  const limits = !gs ? "" : gs.enabled
    ? `${fund ? "The limits: holders" : "Holders"} with 1M+ $TROYA (with their Agent Wallet) whose wallet runs low get ${gs.dripEth} ETH ${every} (claimed at troya.codes/agent → Portfolio → Free gas)${gs.refund ? `, and trades through a Troya Agent Wallet get their gas refunded, up to ${gs.refundPerDayEth} ETH a day per wallet` : ""}, within a daily budget for the whole gas wallet. Everyone else pays their own gas, which is tiny on Robinhood Chain.`
    : "Free gas (the holders' drip and the Agent Wallet refunds) is switched off right now.";
  return `Free gas (when someone asks about gas, say this plainly${fund ? ", then the limits" : ""}): ${fund} ${limits}`.replace(/\s+/g, " ").trim();
}

const AGENDA_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "agenda.json") : new URL("../data/agenda.json", import.meta.url);
export function agendaLines(now = Date.now()) {
  let list = [];
  try { const o = JSON.parse(readFileSync(AGENDA_FILE, "utf8")); if (Array.isArray(o)) list = o; } catch { return ""; }
  const on = list.filter((e) => e && typeof e.text === "string" && (!e.from || Date.parse(e.from) <= now) && (!e.until || Date.parse(e.until) > now));
  return on.length ? `Team agenda, dated (when someone asks what is coming or planned, say these plainly; times are UTC): ${on.map((e) => e.text.replace(/\s+/g, " ").trim().slice(0, 400)).join(" ")}` : "";
}

// V9 F57 Phoenix (24 Nov 2026): the team's corrections (data/lessons-bot.json, [{ at, wrong, right, source }], seeded by
// server/phoenix.mjs, one more with /lesson from an admin chat). Read on every answer (cached for 30 s), never in the
// 15-minute cache, so a correction counts from the next reply.
const LESSONS_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "lessons-bot.json") : new URL("../data/lessons-bot.json", import.meta.url);
let corr = { at: 0, text: "" };
export function correctionsBlock(now = Date.now()) {
  if (now - corr.at < 30_000) return corr.text;
  let list = [];
  try { const o = JSON.parse(readFileSync(LESSONS_FILE, "utf8")); if (Array.isArray(o)) list = o; } catch { /* no file: nothing to add */ }
  const on = list.filter((e) => e && typeof e.wrong === "string" && typeof e.right === "string" && e.wrong.trim() && e.right.trim() && e.active !== false && (!e.until || Date.parse(e.until) > now)).slice(-40);
  const text = on.length ? `\n\nCORRECTIONS THE TEAM MADE (never repeat these mistakes; each one is newer than anything written above, and the live facts still win for numbers):\n` +
    on.map((e) => `- Wrong: ${e.wrong.replace(/\s+/g, " ").trim().slice(0, 600)} Right: ${e.right.replace(/\s+/g, " ").trim().slice(0, 900)}`).join("\n") : "";
  corr = { at: now, text };
  return text;
}
// the share of the $TROYA supply staked against the target for the full daily stakers' share, read live (/api/feesplit
// rate): a staker was told the 5% target was still ahead when 7.6% was staked (23 Nov 2026)
export function stakeShareLine(fsp) {
  const r = fsp?.rate, staked = Number(r?.stakedTokens), target = Number(r?.targetTokens), pct = Number(r?.targetPct);
  if (!(staked >= 0) || !(target > 0) || !(pct > 0)) return "";
  const share = (staked / target) * pct;
  return share >= pct
    ? `$TROYA staked right now (read live from the staking contract): ${Math.round(staked).toLocaleString("en-US")} $TROYA, about ${share.toFixed(2)}% of the supply. The ${pct}% target is met, so the full daily stakers' share is paid; never say it still needs ${pct}% staked.`
    : `$TROYA staked right now (read live from the staking contract): ${Math.round(staked).toLocaleString("en-US")} $TROYA, about ${share.toFixed(2)}% of the supply, under the ${pct}% target, so ${Math.round((staked / target) * 100)}% of the daily stakers' share is paid until more is staked.`;
}

// the buyback-and-burn campaign (server/flywheel-auto.mjs campaignTick, data/flywheel-campaign.json), read on every build:
// 23 Nov 2026 a member asked "Twitter says you plan on doing burns today and tomorrow, when is that" and the bot did not know
const CAMPAIGN_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "flywheel-campaign.json") : new URL("../data/flywheel-campaign.json", import.meta.url);
export function campaignLine(now = Date.now()) {
  let c = null;
  try { c = JSON.parse(readFileSync(CAMPAIGN_FILE, "utf8")); } catch { /* no campaign file */ }
  const after = "From $100k market cap, 0.1% of $TROYA trading volume buys back and burns automatically. Never promise another campaign: a new one is announced on x.com/Troyaagent and in the group first.";
  if (!c?.active || !(Number(c.endsAt) > now)) return `$TROYA buyback-and-burn campaign: none is running right now. ${after}`;
  const every = Number(c.everyMinutes) >= 90 ? `about every ${+(Number(c.everyMinutes) / 60).toFixed(1)} hours` : `every ${c.everyMinutes} minutes`;
  const usd = Number(c.minUsd) && Number(c.maxUsd) && c.minUsd !== c.maxUsd ? `$${c.minUsd}–${c.maxUsd}` : `$${c.minUsd || c.maxUsd}`;
  const ends = new Date(Number(c.endsAt)).toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d).*/, (_, y, m, d, t) => `${+d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y} at ${t} UTC`);
  const since = Number(c.startedAt) ? ` since ${new Date(Number(c.startedAt)).toISOString().slice(0, 10)}` : "";
  return `$TROYA buyback-and-burn campaign, running now (read live): it has run${since}, buys ${usd} of $TROYA ${every} with ETH from the creator wallet and burns all of it; ${Array.isArray(c.buys) ? c.buys.length : Number(c.count) || 0} buys and ${Math.round(Number(c.burned) || 0).toLocaleString("en-US")} $TROYA burned so far; it ends ${ends}. Every burn: troya.codes/flywheel. ${after}`;
}

// what a due-diligence question asked on 23 Nov 2026 and the bot could not answer ("I can't confirm that name or the
// 81.6M balance"): the Pons graduation locker, the dev side's sales and whether the fee split is enforced. The locker
// and the fee path are fixed by the contracts; the dev side's numbers are the live Gate check (/api/proof/gate).
export function supplyFacts(gate) {
  // right after a restart the check reads "Still reading the wallets tied to the dev…": never hand the bot that
  const raw = (gate?.checks || []).find((x) => x?.key === "devlinks")?.detail;
  const dev = raw && /\d/.test(raw) && !/still reading|check again|try again/i.test(raw) ? raw : null;
  return [
    "$TROYA supply and fee facts (quote these when asked; they were checked on chain):",
    "- PonsV2LaunchLocker 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952 holds 81,632,653 $TROYA. It is Pons' own graduation locker, not a team wallet: at graduation the curve's leftover virtual-reserve tokens that cannot enter the pool without lowering the opening price are sent there with lockTokenSupply(). The verified contract has no function that sends tokens out, so there is no beneficiary and no unlock date: they are locked for good, out of circulation. Anyone can read lockedTokenSupply(<the $TROYA CA>) on it. The same locker holds the graduation liquidity position NFT #4302001.",
    `- Dev side: ${dev ? `from Troya Gate's live check of $TROYA: ${String(dev).slice(0, 600)}. troya.codes/proof publishes this itself.` : "the live numbers (what the wallets tied to the dev sold and still hold) are on troya.codes/proof, Gate check \"Dev side wallets\"; send people there rather than quoting a figure."} The first burns, 26,884,853 $TROYA on 15 Nov 2026, came from the dev's own bag. No policy has been announced for what the dev side still holds; never invent one.`,
    "- Fees: the Pons contracts credit the creator wallet 2.6% of every $TROYA trade (the 1.9% creator tax plus 70% of the 1% Pons fee) into the Pons fee escrow, which only the creator wallet can claim. That part is enforced on chain. What happens after the claim (the stakers' share, buyback and burn, the team's part, which pays for servers, APIs and the build) is NOT enforced by a contract: Troya's server code runs it from the creator wallet, and every claim, payout and burn is a public transaction on troya.codes/proof and troya.codes/flywheel. When asked, say this plainly and never claim a contract enforces the split.",
    "- The dev reads this group and posts in it as the group's anonymous admin (shown with the group's name). Never say the dev is not in this chat or will not see a message; say the team reads the group.",
  ].filter(Boolean).join("\n");
}

async function build() {
  const [rm, vf, tr, lb, cup, pz] = await Promise.all([page("/roadmap"), page("/verify"), json("/api/treasury"), json("/api/herald/leaderboard"), json("/api/herald/cup"), json("/api/leaderboard/prizes")]);
  const v = receipts(vf), t = tiers(tr), hd = herald(lb, cup);
  // the weekly prize pool (server/prizes.mjs, 22 Nov 2026): one sentence written by the server, true to its mode (live; dry =
  // being tested, nothing paid yet; off = paused), with this week's pool so far
  const prize = typeof pz?.botLine === "string" ? pz.botLine.slice(0, 1200) : "";
  // the $TROYA burn, read on chain (server/proof.mjs): bots quote this number, never an older figure from a post
  const pb = await json("/api/proof/burn");
  // $TROYA staking tiers, read live from /api/stake (22 Nov: the bot told a staker it "didn't know the Gold cutoff")
  const sk = await json("/api/stake");
  const stakeTiers = Array.isArray(sk?.tiers) && sk.tiers.length && sk.deployed
    ? `$TROYA staking tiers, live (quote these when asked): ${sk.tiers.map((x) => `${x.name} = at least ${Math.round(Number(x.minTokens)).toLocaleString("en-US")} $TROYA staked and ${x.minDays} days staked`).join("; ")}. There is no lock period to choose: a staker never picks 7, 14 or 30 days; the tier climbs by itself while the coins stay staked (it needs both the amount and the days). Days count from the stake's start; adding more moves the start to a weighted average, unstaking everything resets it. The stake page shows "Staked for X days · next tier in Y days".`
    : "";
  const [gst, fsp] = await Promise.all([json("/api/gas/status"), json("/api/feesplit")]);
  const gas = gasFacts(gst, fsp), stakeShare = stakeShareLine(fsp);
  const burn = pb?.burnedWhole > 0 ? `$TROYA burned so far: ${Number(pb.burnedWhole).toLocaleString("en-US")} (${pb.pctOfMinted}% of the 1,000,000,000 minted), read on chain as 1,000,000,000 minus totalSupply() (${pb.totalSupply} now). Burned with the token's own burn(), so the supply itself goes down and nothing sits at a dead address.${pb.burns?.count && pb.burns.byCreatorWithBurn === pb.burns.count && Math.abs(pb.burnedWhole - pb.burns.listedTroya) < 1 ? " Every burn so far was signed by the creator wallet 0x57b0…09E4 (the wallet that launched $TROYA)." : ""} Every burn transaction with its signer: troya.codes/proof#burn.` : "";
  // the team's dated agenda (data/agenda.json, 23 Nov 2026: a member asked "anything planned to drop today?" and the bot
  // knew of nothing): [{ from, until, text }] in ISO times; only entries whose window covers now are told
  const agenda = agendaLines();
  const supply = supplyFacts(await json("/api/proof/gate")), campaign = campaignLine();
  const make = (r) => {
    if (!r.length && !v.length) return "";
    return `\n\nLIVE STATUS, read from troya.codes just now. It is newer than anything written above: where they disagree, this block wins (a phase marked LIVE here is live even if an older line above says it is not, and a phase marked NOT live yet is never live). Use it to say what is live; for numbers still use the tools, except the tiers and terms below, which are read live and may be quoted.` +
      (r.length ? `\nRoadmap (troya.codes/roadmap):\n${r.join("\n")}` : "") +
      (v.length ? `\nReal-money receipts (troya.codes/verify, step number and title): ${v.join("; ")}` : "") +
      (t ? `\n${t}` : "") + (hd ? `\n${hd}` : "") + (prize ? `\n${prize}` : "") + (burn ? `\n${burn}` : "") + (gas ? `\n${gas}` : "") + (stakeTiers ? `\n${stakeTiers}` : "") + (stakeShare ? `\n${stakeShare}` : "") + (agenda ? `\n${agenda}` : "") + `\n${campaign}\n${supply}`;
  };
  return { full: make(roadmap(rm)), brief: make(roadmap(rm, { brief: true })) };
}

// { brief: true } leaves out each phase's description (for a prompt that already carries the feature glossary)
// { work: false } leaves out the WORK IN PROGRESS block (for a prompt that adds workBlock() itself)
export async function liveFacts({ brief = false, work = true } = {}) {
  const pick = () => (brief ? cache.brief : cache.full) + (work ? workBlock() : "") + correctionsBlock();
  if (Date.now() - cache.at < TTL && cache.full) return pick();
  inflight ||= build().then((b) => { if (b.full) cache = { at: Date.now(), ...b }; else cache.at = Date.now() - TTL + 60_000; }).catch(() => {}).finally(() => { inflight = null; });
  await inflight;
  return pick();
}

/* ---------- work in progress ----------
   Community questions on 21 Nov 2026 asked about features the team is building right now. The bots (Telegram, X) and
   the in-app assistant must answer "that one is being worked on" for these, never "live", and must describe an opt-in
   feature as opt-in. Statuses: building (not live, nothing to use yet), optin (live, off by default, the user switches
   it on), live. A status changes here, or with no deploy in data/feature-status.json, e.g. { "stake": "live" }
   (re-read every minute). A roadmap phase that the LIVE STATUS block marks LIVE still wins for that phase. */
const WORK = [
  // 21 Nov 2026: the contract and the page are built, the contract is being deployed. It turns live with
  // (22 Nov 2026: 2x for stakers who trade through Troya, server/stakebonus.mjs; the wording follows STAKE_ACTIVE_DAYS=1
  // and STAKE_ACTIVE_MIN_USD=5: change it here if those change)
  // data/feature-status.json { "stake": "live" } (the older key "staking" is read too).
  { key: "stake", keys: ["stake", "staking"], name: "$TROYA staking", aka: ["staking", "stake", "staked", "staker", "stakers", "stake troya", "troya staking", "staking tiers", "staking rewards", "staking reward", "apy", "apr", "yield"],
    building: "coming, the contract is being deployed: staking is not open yet, so nobody can stake $TROYA today and nothing can be claimed. When it opens it will be on troya.codes/agent#/stake only: stake $TROYA on Robinhood Chain, unstake with a 3-day wait, a tier (Bronze, Silver, Gold) from how much is staked and for how long, perks inside Troya (earlier Sentry alerts, more assistant and Council use, free Gate API checks, a badge), and staked coins still count for the 1M holder perks. Stakers get a share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield; at $100k and up another 0.1% of volume buys $TROYA back and burns it. That share counts from 21 Nov 2026 and is kept in a staker pot until the contract is live; the pot (and the first 7 days after go-live) is paid on day 7 after it goes live, and from then on it is paid into the staking contract every day; claim any time. Each staked $TROYA earns the same rate: the full daily share is paid once 5% of the supply is staked; with less staked only that fraction is paid and the unpaid part stays with the team. If nobody is staked when the daily share is paid, it stays with the team (also when a day's amount is too small to send). Stakers who trade through Troya at least once a day earn 2x: a trade of $5 or more through Troya (the Swap page on Robinhood Chain, the Agent Wallet, Telegram or X trades, or a coin launched through Troya) in the 24 hours before the 01:00 UTC daily share makes that wallet's staked coins count double in that share. The staking contract pays every staked coin the 1x part; the extra part is sent straight to the wallet in ETH from the $TROYA creator wallet once it adds up to 0.00002 ETH, and the stake page shows each wallet's status (Active, 2x / Not active today, 1x), the bonus to receive and the bonuses paid. Team and test wallets keep 1x. Perps from the Perps page's browser key and swaps on Base, Arbitrum or Solana do not count yet. Never quote an APY, APR, a yield, tier sizes or a date, and warn that any other site, bot or DM offering $TROYA staking is a scam.",
    live: "live at troya.codes/agent#/stake (the only place to stake): stake $TROYA on Robinhood Chain in your own wallet, unstake with a 3-day wait, then withdraw. The contract has no owner, no admin and no fee. A tier (Bronze, Silver, Gold) comes from the share of the supply staked and the days staked; the page shows the current sizes and perks (earlier Sentry alerts, more assistant and Council use, free Gate API checks, Arena Cup points shown for fun, a badge in the community chat and the Treasury). Staked and waiting coins still count for the 1M holder perks. Stakers get a share of $TROYA creator fees that grows with market cap (0.1% → 0.5% at $35k → 1% at $100k of trading volume), varies with volume, not a promised yield; each fee uses the market cap of the hour it came in (a median of several reads). Paid into the staking contract every day (01:00 UTC, for the day before); claim any time; it is shared by every coin staked at that moment, and the pot from before launch was paid on day 7 after go-live. Each staked $TROYA earns the same rate: the full daily share is paid once 5% of the supply is staked; until then only that fraction is paid (the page shows it live) and the unpaid part stays with the team. If nobody is staked when the daily share is paid, it stays with the team (also when a day's amount is too small to send). Stakers who trade through Troya at least once a day earn 2x: a trade of $5 or more through Troya (the Swap page on Robinhood Chain, the Agent Wallet, Telegram or X trades, or a coin launched through Troya) in the 24 hours before the 01:00 UTC daily share makes that wallet's staked coins count double in that share. The staking contract pays every staked coin the 1x part; the extra part is sent straight to the wallet in ETH from the $TROYA creator wallet once it adds up to 0.00002 ETH, and the stake page shows each wallet's status (Active, 2x / Not active today, 1x), the bonus to receive and the bonuses paid. Team and test wallets keep 1x. Perps from the Perps page's browser key and swaps on Base, Arbitrum or Solana do not count yet. At $100k and up another 0.1% of volume buys $TROYA back and burns it. Never quote an APY, APR or a yield, never promise an amount, and send people to the page for the numbers." },

  { key: "activity", name: "Activity feed (Troya's own posts of real activity in the Telegram group and on X)", aka: ["activity feed", "activity posts", "activity bot", "launch alerts in the group", "new staker posts", "x digest", "daily recap"], building: "being switched on, not posting yet: Troya will post real activity itself (each coin launched through Troya with its Troya Gate result, each new $TROYA staker, newly registered agents, graduations, the daily stakers' payout and tier changes, an hourly line on outside agents using Troya Gate and on the Arena's real-money trades), at most one message every 90 seconds, plus an X digest every 4 hours and a daily recap at 13:00 UTC. Only real records, never a price call; a coin the Gate blocks or whose name copies another project is posted without a link.", live: "live: Troya itself posts real activity in this group (each coin launched through Troya with its Troya Gate result, each new $TROYA staker, newly registered agents, graduations, the daily stakers' payout and tier changes, an hourly line on outside agents using Troya Gate and on the Arena's real-money trades), at most one message every 90 seconds, plus an X digest every 4 hours and a daily recap at 13:00 UTC. These are automatic posts from Troya's own records, not a person, and never a price call or advice; a coin the Gate blocks or whose name copies another project is posted without a link." },
  { key: "chat", name: "Community chat inside the app", aka: ["in-app chat", "in app chat", "app chat", "chat in the app", "community chat", "chat room", "chatroom", "web chat", "chat on the website", "chat on troya.codes"],
    building: "being built, not open yet: members cannot chat with each other inside troya.codes today; the community talks in the Telegram group t.me/troyaagent. This is not Ask Troya, the AI assistant in the app, which is live." },
  { key: "passed", name: "Passed strip on the Desk", aka: ["passed strip", "pass strip", "passed lane", "passed coins strip", "passes strip"],
    building: "being built, not on the Desk yet: a live lane of the newest coins that passed Troya Sentry at the channel's bar (next to a lane of coins that just graduated from their Pons curve). Until it ships, the same passes are posted in t.me/troyasentry and shown by /sentry in Telegram." },
  { key: "permit2", name: "One-approval sells with Permit2", aka: ["permit2", "permit 2", "one approval", "one-approval", "single approval", "approve once", "approval once", "fewer approvals", "two approvals", "approve every sell", "approval every time"],
    optin: "live, opt-in, off by default: on the Swap page, for coins that route through Uniswap v4 on Robinhood Chain, a seller can approve the coin once for Uniswap's Permit2 contract (an unlimited allowance), and every later sell is then a free signature for the exact amount (valid 30 minutes) plus the swap itself, instead of two exact approvals each time. The choice is remembered on that device. Routes through KyberSwap, LI.FI, Uniswap v3 and Pons curves keep the exact approvals. It is a choice, never required: an unlimited approval is a trade-off, so say so plainly." },
  { key: "walletconnect", name: "WalletConnect (phone wallets by QR code)", aka: ["walletconnect", "wallet connect", "reown", "qr code", "scan qr", "connect with qr", "mobile wallet", "phone wallet", "connect my phone", "trust wallet", "email login", "passkey"],
    building: "being built, not live: today the app connects a browser wallet (an extension such as MetaMask, Rabby, Coinbase Wallet or OKX Wallet, or the browser inside a wallet app); connecting a phone wallet by scanning a WalletConnect QR code is coming, with no date. Email or passkey sign-in has not been announced." },
];
const STATUS_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "feature-status.json") : new URL("../data/feature-status.json", import.meta.url);
let over = { at: 0, v: {} };
function overrides() {
  if (Date.now() - over.at < 60_000) return over.v;
  let v = {};
  try { const o = JSON.parse(readFileSync(STATUS_FILE, "utf8")); if (o && typeof o === "object") v = o; } catch { /* no file: the defaults */ }
  over = { at: Date.now(), v };
  return v;
}
const statusOf = (w) => { const o = overrides(); const s = (w.keys || [w.key]).map((k) => o[k]).find((v) => ["building", "optin", "live"].includes(v)); return s || (w.optin ? "optin" : "building"); };
// an override with no written line for its status gets a plain one, never the line of another status
const sayOf = (w, st) => w[st] || (st === "live" ? "live now; for where it is and how it works use the FEATURE GLOSSARY or troya.codes/agent#/docs, never details from memory"
  : st === "optin" ? "live as an opt-in: off until the user switches it on; for where it is and how it works use the FEATURE GLOSSARY or troya.codes/agent#/docs, never details from memory" : w.building);
export function workItems() { return WORK.map((w) => { const status = statusOf(w); return { key: w.key, name: w.name, status, says: sayOf(w, status) }; }); }
// the items a question names (troya_feature tool); nothing when it names none
export function workStatus(text) {
  const s = norm(text);
  return workItems().filter((it) => { const w = WORK.find((x) => x.key === it.key); return [w.name, ...w.aka].some((a) => s.includes(norm(a))); });
}
export function workBlock() {
  return `\n\nWORK IN PROGRESS (set by the team, newer than anything written above, the feature glossary included): when someone asks about one of these, answer from its line in plain words, e.g. "that one is being worked on, it is not live yet", and never say or imply that a feature being built is live, can be used today, or has a date. An opt-in feature is live but off until the user switches it on: say both. A roadmap phase the LIVE STATUS block marks LIVE still wins for that phase.\n` +
    workItems().map((it) => `- ${it.name}: ${it.says}`).join("\n");
}

/* ---------- the feature glossary ----------
   One source for what each feature is: GLOSSARY in public/agent/desk/guide.js (the in-app Guide), between the
   GLOSSARY:BEGIN and GLOSSARY:END markers, as strict JSON. Re-read whenever the file changes, so a deploy of the page
   updates the assistant too without a restart; a broken edit keeps the last good copy and says so once in the log. */
const GUIDE = new URL("../public/agent/desk/guide.js", import.meta.url);
const MARK = ["/* GLOSSARY:BEGIN */", "/* GLOSSARY:END */"];
let gl = { mtime: -1, list: [], warned: 0 };
const okEntry = (g) => g && ["name", "page", "where", "what", "money"].every((k) => typeof g[k] === "string" && g[k].trim());
export function glossary() {
  try {
    const mtime = statSync(GUIDE).mtimeMs;
    if (mtime === gl.mtime) return gl.list;
    const src = readFileSync(GUIDE, "utf8");
    const a = src.indexOf(MARK[0]), b = src.indexOf(MARK[1]);
    if (a < 0 || b < a) throw new Error("the glossary markers are missing");
    const list = JSON.parse(src.slice(a + MARK[0].length, b));
    if (!Array.isArray(list) || !list.length) throw new Error("the glossary is empty");
    gl = { mtime, list: list.filter(okEntry).map((g) => ({ ...g, aka: Array.isArray(g.aka) ? g.aka.map(String) : [] })), warned: 0 };
  } catch (e) {
    if (Date.now() - gl.warned > 3600_000) { gl.warned = Date.now(); console.warn("[botfacts] glossary:", e.message, gl.list.length ? "(keeping the last good copy)" : ""); }
  }
  return gl.list;
}
// where a feature lives as a link people can open: an app route or a site page
export const linkOf = (g) => (g.page.startsWith("/") ? `troya.codes${g.page}` : `troya.codes/agent#/${g.page}`);
export function glossaryBlock() {
  const list = glossary();
  if (!list.length) return "";
  return `\n\nFEATURE GLOSSARY: every part of Troya, one line each: its name, where it lives and its link, what it is for, and whether it can move money. It is the same text the in-app Guide shows. It says what a feature IS; whether a phase is live comes from the LIVE STATUS block.\n` +
    list.map((g) => `- ${g.name} (${g.where}; ${linkOf(g)}): ${g.what} Money: ${g.money}`).join("\n");
}

// the features a text names, in the order it names them; longest names first, so "Sentry Autopilot" is never also read
// as "Autopilot" or "Sentry" (the same rule as featuresIn() in guide.js)
const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
export function featuresIn(text) {
  const terms = glossary().flatMap((g) => [g.name.replace(/\s*\([^)]*\)\s*$/, ""), ...g.aka].map((t) => [norm(t).trim(), g]))
    .filter(([t]) => t.length > 2).sort((a, b) => b[0].length - a[0].length);
  let s = norm(text);
  const hits = [];
  for (const [t, g] of terms) for (const form of [t, `${t}s`]) {
    const k = ` ${form} `;
    for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k)) {
      if (!hits.some((x) => x.g === g)) hits.push({ g, i });
      s = s.slice(0, i + 1) + "#".repeat(form.length) + s.slice(i + 1 + form.length);
    }
  }
  return hits.sort((a, b) => a.i - b.i).map((x) => x.g);
}

export { roadmap as _roadmap, receipts as _receipts };
