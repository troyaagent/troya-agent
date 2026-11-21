// V7 F31 Aegis: a guard on every coin a user holds on Robinhood Chain. Once a minute, per coin (shared by everyone who
// holds it), Aegis reads the new transfers of the wallets that can hurt a holder (the Pons deployer and creator-fee
// recipient, wallets disclosed in an Oath, the top holders, and any wallet the dev moved coins to) and runs a sell test
// every five minutes. What it raises:
//   dev-sell    the dev side sold ≥0.2% of the supply (amber) or ≥1% within an hour (red)
//   dev-moved   the dev sent ≥1% of the supply to a fresh wallet (amber; that wallet is followed from then on)
//   whale-sell  one top holder sold ≥3% (amber) or ≥6% (red) within an hour
//   tax-up      the sell tax rose to 10% or more (red)
//   cannot-sell the sell test failed twice in a row (red)
//   oath-broken the dev broke its Oath (red)        ring   Ring Radar called the launch rigged (amber, once)
//   dev-linked-sell  wallets tied to the dev (V8 dev side wallets, devlinks.mjs: coins or ETH moved with the dev, a small
//               shared funder, trades through one private contract) sold ≥0.2% of the supply in 10 minutes (amber), or
//               ≥1% in 10 minutes, ≥2% in one sale, or ≥0.5% with 3+ of them selling within a minute (red)
//   cluster-sell the same for a wallet cluster not tied to the dev (gathered into one wallet, funded by one small wallet)
// Each alert goes to the holder's inbox and Telegram DM, with a cool-down per coin and kind. In "exit" mode a red alert
// also builds a full sell of that coin to ETH: a ticket to approve, or, with the Agent Wallet on and AEGIS_AUTO_EXIT=1,
// a sell through the Gate and the wallet's caps. Red alerts are sealed (V7 F35).
//   GET  /api/aegis/feed            what Aegis caught lately, across all coins (no wallet data, no team test coins)
//   GET  /api/aegis/token/:token    one coin's watch: who is watched, the last sell test, its alerts
//   GET  /api/aegis/me              your guard, the coins it watches and their alerts         (session)
//   POST /api/aegis/me              { on, mode: "alert"|"exit", minUsd }                        (session)
import { getAddress, isAddress, zeroPadValue, id as keccakId } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";

const FILE = "aegis.json";
const TICK_MS = 60_000, HOLD_MS = 10 * 60_000, SELLTEST_MS = 5 * 60_000, TOP_MS = 30 * 60_000, COOL_MS = 3 * 3600_000;
const FREE_COINS = 3, HOLDER_COINS = 50, MAX_COINS = 200;
const T_TRANSFER = keccakId("Transfer(address,address,uint256)");
const SKIP = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);       // USDG (WETH is added from ADDR below)
const lc = (s) => String(s || "").toLowerCase();
const hex = (n) => "0x" + n.toString(16);
const pct = (a, s) => (s > 0n ? Number((a * 1_000_000n) / s) / 10_000 : 0);
let store = null, busy = false, R = null;
const live = new Map();          // token → { supply, devs:Set, top:Set, followed:Set, linked:Set, loose:Set, venues:Set, sells:[{w,v,at,tx,dev,linked,loose}], sell:{at,ok,tax,fails}, curveQuote:[{at,q}] }

async function chain() { return (R ||= await import("./robinhood.mjs")); }

/* ---------- who holds what ---------- */
async function onChainCandidates(owner) {
  const d = await store.readJson(FILE, {});
  const prev = (d.guards?.[lc(owner)]?.coins || []).map((c) => c.token);
  const oaths = Object.keys((await store.readJson("oath.json", {})).oaths || {});
  const recent = ((await store.readJson("sentry.json", {})).recent || []).slice(0, 40).map((x) => lc(x.token));
  return [...new Set([...prev, ...oaths, ...recent].map(lc))].filter((t) => !SKIP.has(t)).slice(0, 38);
}

async function holdingsOf(owner) {
  const p = await import("./portfolio.mjs");
  const m = await import("./market.mjs");
  const blind = !m.hasBlockscout();                                 // Blockscout paused or missing: read on chain
  const aw = await (await import("./agentwallet.mjs")).getAgentWallet(owner).catch(() => null);
  const wallets = [owner, aw?.address].filter((w) => w && isAddress(w)).map(lc);
  const { ADDR } = await chain();
  SKIP.add(lc(ADDR.weth));
  const out = new Map();
  for (const w of wallets) {
    let list = blind ? [] : await p.walletTokens(w).catch(() => []);
    if (!list.length) {
      const { getBalances } = await chain();
      const b = await getBalances(w, await onChainCandidates(owner)).catch(() => null);
      list = (b?.balances || []).filter((x) => x.address !== "native" && Number(x.amount) > 0 && !SKIP.has(lc(x.address)))
        .map((x) => ({ address: lc(x.address), symbol: x.symbol, decimals: x.decimals, raw: x.raw, amount: Number(x.amount), rate: null, stock: false }));
    }
    for (const t of list) {
      if (t.stock || SKIP.has(t.address) || !(Number(t.amount) > 0)) continue;
      const usd = t.rate != null ? Number(t.amount) * t.rate : null;
      const k = t.address;
      const prev = out.get(k);
      out.set(k, { token: k, symbol: t.symbol, usd: (prev?.usd || 0) + (usd || 0), usdKnown: usd != null || !!prev?.usdKnown,
        where: [...(prev?.where || []), { wallet: w, agent: aw?.address ? lc(aw.address) === w : false, raw: t.raw, decimals: t.decimals }] });
    }
  }
  return [...out.values()];
}

async function coinLimit(owner) {
  const h = await import("./holders.mjs").catch(() => null);
  return (await h?.hasPerks(owner).catch(() => false)) ? HOLDER_COINS : FREE_COINS;
}

/* ---------- one coin's watch ---------- */
async function setupCoin(token, st) {
  const { rpc, ponsState, ADDR } = await chain();
  const t = lc(token);
  let c = live.get(t);
  if (!c) {
    c = { devs: new Set(), top: new Set(), followed: new Set(st?.followed || []), venues: new Set([lc(ADDR.poolManager), lc(ADDR.universalRouter), lc(ADDR.swapRouter02), "0x204faca1764b154221e35c0d20abb3c525710498", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5"]),
      sells: [], sell: { at: 0, ok: null, tax: null, fails: 0 }, curveQuote: [], topAt: 0, supply: 0n, pons: false, linked: new Set(), loose: new Set() };
    live.set(t, c);
  }
  if (!c.supply) c.supply = BigInt(await rpc("robinhood", "eth_call", [{ to: t, data: "0x18160ddd" }, "latest"]).catch(() => "0x0"));
  if (!c.devAt || Date.now() - c.devAt > TOP_MS) {
    const ps = await ponsState(t).catch(() => null);
    c.pons = !!ps;
    if (ps) {
      if (ps.deployer) c.devs.add(lc(ps.deployer));
      if (ps.creatorFeeRecipient) c.devs.add(lc(ps.creatorFeeRecipient));
      if (ps.curve && !ps.graduated) c.venues.add(lc(ps.curve));
      c.graduated = !!ps.graduated;
      if (!ps.graduated && ps.realQuote != null) { c.curveQuote.push({ at: Date.now(), q: Number(ps.realQuote) }); c.curveQuote = c.curveQuote.filter((x) => Date.now() - x.at < 20 * 60_000); }
    }
    c.devAt = Date.now();
  }
  // the Oath every minute (a store read): a broken pledge has to reach holders at once, not at the next half-hour refresh
  const oath = await (await import("./oath.mjs")).oathOf(t).catch(() => null);
  for (const w of oath?.pledge?.wallets || []) c.devs.add(lc(w));
  c.oathBroken = oath?.status === "broken";
  // V8 dev side wallets: the wallets tied to the dev and the clusters not tied to it, from devlinks.mjs's cache (a stale
  // or missing report starts a read in the background); a sale through a relay it found (a bot's router) is a sale
  const ds = (await import("./devlinks.mjs").catch(() => null))?.devSideOf(t);
  if (ds) {
    c.linked = new Set([...ds.linked].filter((w) => !c.devs.has(w)));
    c.loose = new Set([...ds.loose].filter((w) => !c.devs.has(w) && !c.linked.has(w)));
    for (const v of ds.relays || []) c.venues.add(lc(v));
  }
  if (Date.now() - c.topAt > TOP_MS) {
    const th = await (await import("./market.mjs")).topHolders(t).catch(() => null);
    c.top = new Set((th?.holders || []).filter((h) => h.wallet).slice(0, 10).map((h) => lc(h.address)));
    c.topAt = Date.now();
  }
  return c;
}

// the dev, the wallets it moved coins to and the wallets tied to it first, then the top holders and other clusters
function watchedOf(c) { return [...new Set([...c.devs, ...c.followed, ...c.linked, ...c.top, ...c.loose])].filter((w) => !c.venues.has(w)).slice(0, 80); }

async function scanCoin(token, st, raise) {
  const { rpc, CHAINS } = await chain();
  const c = await setupCoin(token, st);
  const head = Number(BigInt(await rpc("robinhood", "eth_blockNumber", [])));
  const from = st.lastBlock ? st.lastBlock + 1 : head - 600;
  const to = Math.min(head, from + 29_999);
  const watched = watchedOf(c);
  if (watched.length && from <= to) {
    const q = [{ address: token, topics: [T_TRANSFER, watched.map((w) => zeroPadValue(w, 32))], fromBlock: hex(from), toBlock: hex(to) }];
    const logs = await rpc("robinhood", "eth_getLogs", q, { timeoutMs: 15_000 }).catch(() => rpc("robinhood", "eth_getLogs", q, { timeoutMs: 20_000, only: CHAINS.robinhood.wide })).catch(() => null);
    if (!logs) return;                                                      // try the same range next tick
    for (const l of logs) {
      const fromW = "0x" + l.topics[1].slice(26), toW = "0x" + l.topics[2].slice(26), v = BigInt(l.data);
      const dev = c.devs.has(fromW) || c.followed.has(fromW);
      if (c.venues.has(toW)) {
        const linked = !dev && c.linked.has(fromW), loose = !dev && !linked && c.loose.has(fromW);
        c.sells.push({ w: fromW, v, at: Date.now(), tx: l.transactionHash, dev, linked, loose });
        c.sells = c.sells.filter((s) => Date.now() - s.at < 3600_000);
        const oneP = pct(v, c.supply);
        if (dev) {
          const hour = pct(c.sells.filter((s) => s.dev).reduce((a, s) => a + s.v, 0n), c.supply);
          if (hour >= 1) await raise("dev-sell", "red", `The dev side sold ${hour.toFixed(2)}% of the supply in the last hour`, l.transactionHash, hour);
          else if (oneP >= 0.2) await raise("dev-sell", "amber", `The dev side sold ${oneP.toFixed(2)}% of the supply`, l.transactionHash);
        } else if (linked || loose) {
          // wallets tied to the dev (or a cluster) starting to sell: in exit mode a red one builds the sell
          const mine = c.sells.filter((s) => (linked ? s.linked : s.loose));
          const ten = pct(mine.filter((s) => Date.now() - s.at < 600_000).reduce((a, s) => a + s.v, 0n), c.supply);
          const sellers = new Set(mine.filter((s) => Date.now() - s.at < 60_000).map((s) => s.w)).size;
          const kind = linked ? "dev-linked-sell" : "cluster-sell", who = linked ? "Wallets tied to the dev" : "A wallet cluster (not tied to the dev)";
          if (ten >= 1 || oneP >= 2 || (sellers >= 3 && ten >= 0.5)) await raise(kind, "red", `${who} sold ${ten.toFixed(2)}% of the supply in the last 10 minutes${sellers >= 3 ? ` (${sellers} wallets within a minute)` : ""}`, l.transactionHash, ten);
          else if (ten >= 0.2) await raise(kind, "amber", `${who} sold ${ten.toFixed(2)}% of the supply in the last 10 minutes`, l.transactionHash);
        } else if (c.top.has(fromW)) {
          const hour = pct(c.sells.filter((s) => s.w === fromW).reduce((a, s) => a + s.v, 0n), c.supply);
          if (hour >= 6) await raise("whale-sell", "red", `A top holder (${fromW.slice(0, 8)}…) sold ${hour.toFixed(2)}% of the supply in the last hour`, l.transactionHash, hour);
          else if (hour >= 3) await raise("whale-sell", "amber", `A top holder (${fromW.slice(0, 8)}…) sold ${hour.toFixed(2)}% of the supply in the last hour`, l.transactionHash);
        }
      } else if (dev && !c.devs.has(toW) && !/^0x0{40}$|^0x0{36}dead$/.test(toW) && pct(v, c.supply) >= 1) {
        c.followed.add(toW);                                                // follow the coins one hop
        await raise("dev-moved", "amber", `The dev sent ${pct(v, c.supply).toFixed(2)}% of the supply to a new wallet (${toW.slice(0, 8)}…); Aegis follows it now`, l.transactionHash);
      }
    }
  }
  st.lastBlock = to;
  st.followed = [...c.followed].slice(0, 20);
  // heavy selling on the curve: the ETH buyers put in fell fast
  if (c.curveQuote.length >= 2) {
    const first = c.curveQuote[0].q, last = c.curveQuote.at(-1).q;
    if (first > 0 && last < first * 0.6 && c.curveQuote.at(-1).at - c.curveQuote[0].at <= 20 * 60_000) await raise("curve-drain", "amber", `The ETH in the Pons curve fell ${Math.round((1 - last / first) * 100)}% in under 20 minutes`, null);
  }
  if (c.oathBroken) await raise("oath-broken", "red", "The dev broke its Oath (troya.codes/oath)", null);
  const ring = (await import("./ringradar.mjs")).ringFlags(token);
  if (ring[0]?.level === "red") await raise("ring", "amber", `${ring[0].title}: ${ring[0].detail}`, null);
  // V8 F39 Watchfire reads every transfer of this coin live: a fire (coins gathered into one wallet, a 5%+ sale) is red,
  // fast selling is amber
  const wf = (await import("./watchfire.mjs").catch(() => null))?.watchfireState(token);
  if (wf?.level === "fire" && wf.lastFire) await raise("watchfire", "red", `Watchfire: ${wf.lastFire.detail}`, null);
  else if (wf?.level === "red" && wf.why?.[0]) await raise("watchfire-selling", "amber", `Watchfire: ${wf.why[0]}`, null);
  // the sell test, every five minutes
  if (Date.now() - c.sell.at > SELLTEST_MS && st.testRaw) {
    c.sell.at = Date.now();
    const s = await (await chain()).sellCheck({ token, amountRaw: st.testRaw }).catch((e) => ({ error: e.message }));
    if (s && !s.error && !s.unknown) {          // "unknown" (an empty curve, storage not found) is no verdict
      const sellable = s.sellable !== false && s.ok !== false;
      const tax = Number(s.transferTaxPct ?? s.sellTaxPct ?? 0) || 0;
      c.sell.fails = sellable ? 0 : c.sell.fails + 1;
      if (c.sell.fails >= 2) await raise("cannot-sell", "red", `The sell test failed twice in a row${s.reason ? `: ${String(s.reason).slice(0, 120)}` : ""}`, null);
      if (tax >= 10 && (c.sell.tax == null || c.sell.tax < 10)) await raise("tax-up", "red", `The sell tax is now ${tax.toFixed(1)}%`, null);
      c.sell.ok = sellable; c.sell.tax = tax;
      st.sell = { at: c.sell.at, ok: sellable, tax };
    }
  }
}

/* ---------- alerts: fan out to everyone guarding the coin ---------- */
async function deliver(ev, holders) {
  const { addInbox, createProposal } = await import("./inbox.mjs");
  const autoExit = process.env.AEGIS_AUTO_EXIT === "1";
  for (const h of holders) {
    const title = `Aegis ${ev.level === "red" ? "RED" : "amber"}: $${ev.symbol}`;
    const body = `${ev.text}.${ev.tx ? ` Tx ${ev.tx.slice(0, 14)}…` : ""}`;
    if (ev.level === "red" && h.mode === "exit" && ev.kind !== "cannot-sell") {
      const spot = h.where.find((w) => w.agent) || h.where[0];
      const amountIn = spot ? (Number(BigInt(spot.raw)) / 10 ** spot.decimals * 0.999).toPrecision(12).replace(/\.?0+$/, "") : null;
      if (spot && amountIn) {
        const params = { tokenIn: ev.token, tokenOut: "ETH", amountIn, slippagePct: 10 };
        // a sell from the Agent Wallet still sells everything of the coin, but tells the lot ledger so: every open lot of
        // the coin (Sentry Autopilot, Champions) then closes with its share of the real ETH that came back, instead of the
        // next job finding nothing to sell and booking -100% (audit 3-10, 21 Nov 2026). At the moment it sends, the ledger
        // reads the whole balance again, so a sell approved later is not stuck on an amount from the alert.
        const lot = spot.agent ? { source: "aegis", closeAll: true } : null;
        if (autoExit && spot.agent) {
          try {
            const aw = await import("./agentwallet.mjs");
            const r = await aw.executeForUser(h.owner, { kind: "swap", params, rationale: `Aegis exit: ${ev.text}`, source: "aegis", lot });
            // held by the trust ladder (Approve, the default for a wallet that never picked a step): the sell is already
            // waiting in Scepter and the Inbox as a proposal, so this line says so instead of "exit blocked"
            await addInbox(h.owner, { kind: "aegis", title: `${title} · ${r.executed ? "sold to ETH" : r.proposed ? "exit waiting for your approval" : "exit blocked"}`, body: r.executed ? body : r.proposed ? `${body} Approve the sell in Agent → Scepter or Portfolio → Inbox.` : `${body} ${(r.reasons || []).join(" ")}`, data: { aegis: ev } });
            continue;
          } catch (e) { await addInbox(h.owner, { kind: "aegis", title: `${title} · exit failed`, body: `${body} ${e.message}`, data: { aegis: ev } }); continue; }
        }
        const p = await createProposal(h.owner, { kind: "swap", params, summary: `Aegis exit: sell $${ev.symbol} to ETH`, rationale: ev.text, source: "aegis", lot });
        await addInbox(h.owner, { kind: "proposal", title: `${title} · exit ready`, body: `${body} Approve the sell in Portfolio → Inbox.`, data: { proposalId: p.id, aegis: ev } });
        continue;
      }
    }
    await addInbox(h.owner, { kind: "aegis", title, body, data: { aegis: ev } });
  }
}

async function tick() {
  if (busy || !store) return;
  busy = true;
  try {
    const d = await store.readJson(FILE, {});
    d.guards ||= {}; d.coins ||= {}; d.feed ||= []; d.cool ||= {};
    const owners = Object.entries(d.guards).filter(([, g]) => g.on);
    // refresh holdings every ten minutes per owner
    for (const [o, g] of owners) {
      if (g.holdAt && Date.now() - g.holdAt < HOLD_MS) continue;
      const list = (await holdingsOf(o).catch(() => null));
      if (!list) continue;
      const lim = await coinLimit(o);
      g.coins = list.filter((x) => !x.usdKnown || x.usd >= (g.minUsd ?? 1)).sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, lim);
      g.capped = list.length > lim ? list.length - lim : 0;
      g.holdAt = Date.now();
    }
    // who guards each coin
    const by = new Map();
    for (const [o, g] of owners) for (const x of g.coins || []) { if (!by.has(x.token)) by.set(x.token, []); by.get(x.token).push({ owner: o, mode: g.mode || "alert", where: x.where, symbol: x.symbol }); }
    const coins = [...by.keys()].slice(0, MAX_COINS);
    for (const t of coins) {
      const st = (d.coins[t] ||= {});
      const hs = by.get(t);
      st.symbol = hs[0].symbol;
      // test-sell the smallest position guarded, so the test is one a real holder would make
      const raws = hs.flatMap((h) => h.where.map((w) => BigInt(w.raw))).filter((x) => x > 0n).sort((a, b) => (a < b ? -1 : 1));
      st.testRaw = raws[0] ? raws[0].toString() : null;
      // one alert per coin, kind and level every 3 hours, unless the number at least doubled since (a dev selling more)
      const raise = async (kind, level, text, tx, mag = null) => {
        const key = `${t}:${kind}:${level}`, prev = d.cool[key];
        const at = typeof prev === "number" ? prev : prev?.at;
        if (at && Date.now() - at < COOL_MS && !(mag && prev?.mag && mag >= prev.mag * 2)) return;
        d.cool[key] = { at: Date.now(), mag };
        const ev = { token: getAddress(t), symbol: st.symbol, kind, level, text, tx, at: Date.now() };
        d.feed.unshift(ev); d.feed = d.feed.slice(0, 300);
        (st.events ||= []).unshift(ev); st.events = st.events.slice(0, 30);
        if (level === "red") import("./seal.mjs").then((m) => m.seal("aegis", ev.token, ev, `${kind}: ${text}`.slice(0, 150))).catch(() => {});
        await deliver(ev, hs).catch((e) => console.warn("[aegis] deliver", e.message));
        console.log(`[aegis] ${level} ${kind} $${st.symbol} → ${hs.length} holder(s)`);
      };
      await scanCoin(t, st, raise).catch((e) => console.warn("[aegis] scan", t.slice(0, 10), e.message));
    }
    for (const [k, v] of Object.entries(d.cool)) if (Date.now() - (typeof v === "number" ? v : v?.at || 0) > COOL_MS) delete d.cool[k];
    await store.update(FILE, {}, (x) => {
      x.coins = { ...(x.coins || {}), ...d.coins }; x.feed = d.feed; x.cool = d.cool; x.guards ||= {};
      for (const [o, g] of owners) if (x.guards[o]) x.guards[o] = { ...x.guards[o], coins: g.coins, capped: g.capped, holdAt: g.holdAt };
      return x;
    });
  } catch (e) { console.warn("[aegis]", e.message); }
  finally { busy = false; }
}

const pubEvent = (e) => ({ token: e.token, symbol: e.symbol, kind: e.kind, level: e.level, text: e.text, tx: e.tx, at: e.at });

/* ---------- the team's own test coins stay out of the public feed ---------- */
// The public feed and its counts leave out the team's test coins ($OATHTEST, the coin the team broke an Oath on to test
// tier 2). The rule is the Troya Launches board's (launch.mjs isTeamTest: a "test" name or ticker, a team wallet, a
// record flagged teamTest), plus an Oath signed by the team's test wallet and the short list below for anything those
// miss. Only the public feed is filtered: holders of a test coin still get every alert, and /api/aegis/token/:token is
// unchanged. $TROYA is never a test coin, although its creator is an admin wallet.
const TEST_COINS = new Set(["0x01e1313d5b74eb39c55160f653ed59f18a0ee968"]);   // $OATHTEST (Oath tier 2 test, 19 Nov)
const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
let testMemo = null;
async function teamTests() {
  if (testMemo && Date.now() - testMemo.at < 60_000) return testMemo;
  const L = await import("./launch.mjs").catch(() => null);
  const named = (symbol) => (L?.isTeamTest ? L.isTeamTest({ symbol }) : /test/i.test(String(symbol || "")));
  const set = new Set(TEST_COINS);
  for (const l of await store.readJson("launches.json", []).catch(() => [])) {
    try { if (l?.token && L?.isTeamTest?.(l)) set.add(lc(l.token)); } catch { /* a broken record is not a test coin */ }
  }
  const testWallets = new Set((L?.TEST_WALLETS || []).map(lc));
  for (const o of Object.values((await store.readJson("oath.json", {}).catch(() => ({}))).oaths || {})) {
    if (o?.token && [o.signer, o.deployer].some((w) => testWallets.has(lc(w)))) set.add(lc(o.token));
  }
  set.delete(TROYA);
  testMemo = { at: Date.now(), set, isTest: (token, symbol) => lc(token) !== TROYA && (set.has(lc(token)) || named(symbol)) };
  return testMemo;
}

/** The public feed: what Aegis caught lately on real coins, how many users guard coins, and how many coins Troya watches. */
async function publicFeed() {
  const d = await store.readJson(FILE, {});
  const { isTest } = await teamTests();
  const guards = Object.values(d.guards || {}).filter((g) => g.on);
  const guarded = new Set();
  for (const g of guards) for (const c of g.coins || []) if (c?.token && !isTest(c.token, c.symbol)) guarded.add(lc(c.token));
  // site-wide: the coins Aegis guards for users plus the coins Watchfire reads live (open coin pages, Arena positions,
  // Treasury pins); Aegis raises Watchfire's alerts on the coins it guards
  const watched = new Set(guarded);
  const wf = await import("./watchfire.mjs").catch(() => null);
  for (const c of (wf?.watchedTokens?.() || [])) if (c?.token && !isTest(c.token, c.symbol)) watched.add(lc(c.token));
  return { guards: guards.length, coins: guarded.size, coinsWatched: watched.size,
    note: "coins counts the coins Aegis guards for users now; coinsWatched counts every coin Troya reads live now (Aegis and Watchfire). The team's own test coins are not included.",
    events: (d.feed || []).filter((e) => !isTest(e.token, e.symbol)).slice(0, 60).map(pubEvent) };
}

export async function aegisToken(token) {
  const t = lc(token);
  const d = await store.readJson(FILE, {});
  const st = d.coins?.[t] || null;
  const c = live.get(t);
  return { token: getAddress(t), symbol: st?.symbol || null, guarded: !!st,
    watching: c ? { dev: c.devs.size, topHolders: c.top.size, followed: c.followed.size, devLinked: c.linked.size, clusters: c.loose.size } : null,
    sellTest: st?.sell || null, events: (st?.events || []).map(pubEvent),
    note: st ? "Watched once a minute while someone guards it." : "Nobody guards this coin yet. Turn Aegis on in the app and every coin you hold is watched." };
}

export async function register(r, ctx) {
  store = ctx.store;
  import("./devlinks.mjs").then((m) => m.initDevLinks(ctx.store)).catch(() => {});   // its funder cache, even before its routes load
  setTimeout(() => tick().catch(() => {}), 75_000);
  setInterval(() => tick().catch(() => {}), TICK_MS).unref();
  r.get("/api/aegis/feed", () => publicFeed(), { weight: 1 });
  r.get("/api/aegis/token/:token", async ({ params }) => { if (!isAddress(params.token)) throw new HttpError(400, "That is not a token address."); return aegisToken(params.token); }, { weight: 1 });
  r.get("/api/aegis/me", async ({ req }) => {
    const me = lc(requireSession(req).address);
    const d = await store.readJson(FILE, {});
    const g = d.guards?.[me] || { on: false, mode: "alert", minUsd: 1 };
    return { on: !!g.on, mode: g.mode || "alert", minUsd: g.minUsd ?? 1, autoExit: process.env.AEGIS_AUTO_EXIT === "1", limit: await coinLimit(me), capped: g.capped || 0, checkedAt: g.holdAt || null,
      coins: (g.coins || []).map((x) => ({ token: getAddress(x.token), symbol: x.symbol, usd: x.usdKnown ? +x.usd.toFixed(2) : null, inAgentWallet: x.where.some((w) => w.agent), sellTest: d.coins?.[x.token]?.sell || null, events: (d.coins?.[x.token]?.events || []).slice(0, 5).map(pubEvent) })) };
  }, { weight: 1 });
  r.post("/api/aegis/me", async ({ req, body }) => {
    const me = lc(requireSession(req).address);
    const on = body?.on !== false, mode = body?.mode === "exit" ? "exit" : "alert", minUsd = Math.max(0, Math.min(10_000, Number(body?.minUsd ?? 1) || 0));
    await store.update(FILE, {}, (x) => { x.guards ||= {}; x.guards[me] = { ...(x.guards[me] || {}), on, mode, minUsd, holdAt: 0, since: x.guards[me]?.since || Date.now() }; return x; });
    if (on) setTimeout(() => tick().catch(() => {}), 2000);
    return { ok: true, on, mode, minUsd };
  }, { weight: 2, perMin: 20 });
}

/** Tests and audits: replay one coin's watch from a block, collecting what Aegis would raise (nothing is delivered). */
export async function probe(token, fromBlock, { testRaw = null, windows = 6 } = {}) {
  const st = { lastBlock: fromBlock - 1, testRaw };
  const evs = [];
  const raise = async (kind, level, text, tx, mag = null) => { evs.push({ kind, level, text, tx, mag }); };
  for (let i = 0; i < windows; i++) { const before = st.lastBlock; await scanCoin(lc(token), st, raise); if (st.lastBlock === before) break; }
  const c = live.get(lc(token));
  return { lastBlock: st.lastBlock, sell: st.sell || null, events: evs, watched: c ? { dev: [...c.devs], top: c.top.size, followed: [...c.followed], devLinked: [...c.linked], clusters: c.loose.size } : null };
}
