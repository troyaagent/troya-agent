// Playbooks = server watches checked every 20 s.
//   stop_loss   {coin, triggerPx, direction: "below"|"above", sizePct}   → close the perp position
//   take_profit {coin, levels:[{px, sizePct}], direction}                → close part of the position at each level
//   dca         {token, symbol, amountEth, everyHours, runs}             → swap ETH into a Robinhood Chain token on a schedule
//   alert       {target: perp coin or token address, direction, px}      → inbox note (no funds move)
// When a watch fires: Agent Wallet on + not paused + within caps → execute and journal; otherwise an inbox proposal.
import { randomBytes } from "node:crypto";
import { isAddress } from "ethers";
import { requireSession } from "./auth.mjs";
import { HttpError } from "./api.mjs";
import { logAction } from "./journal.mjs";
import { addInbox, createProposal } from "./inbox.mjs";
import { hlMarkets, robinhoodToken, untrusted } from "./tools.mjs";
import { getPolicy } from "./policy.mjs";

const TICK_MS = 20_000;
const MAX_PER_USER = 25;
let store;
let running = false;

const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const coinOf = (c) => String(c || "").toUpperCase().replace(/-PERP$/, "").replace(/[^A-Z0-9:]/g, "").slice(0, 20);

function normalize(input) {
  const type = String(input.type || "");
  const p = input.params || input;
  if (type === "stop_loss") {
    const coin = coinOf(p.coin), px = num(p.triggerPx);
    if (!coin || !(px > 0)) throw new HttpError(400, "A stop-loss needs a perp and a trigger price.");
    const direction = p.direction === "above" ? "above" : "below";
    return { type, params: { coin, triggerPx: px, direction, sizePct: Math.min(100, Math.max(1, num(p.sizePct) || 100)) }, title: `Stop-loss ${coin} ${direction === "below" ? "≤" : "≥"} ${px}` };
  }
  if (type === "take_profit") {
    const coin = coinOf(p.coin);
    const levels = (Array.isArray(p.levels) ? p.levels : []).map((l) => ({ px: num(l.px), sizePct: Math.min(100, Math.max(1, num(l.sizePct) || 25)), done: false })).filter((l) => l.px > 0).slice(0, 6);
    if (!coin || !levels.length) throw new HttpError(400, "A take-profit ladder needs a perp and at least one price level.");
    const direction = p.direction === "below" ? "below" : "above";
    return { type, params: { coin, levels, direction }, title: `Take-profit ${coin} · ${levels.length} level${levels.length > 1 ? "s" : ""}` };
  }
  if (type === "dca") {
    if (!isAddress(String(p.token || ""))) throw new HttpError(400, "DCA needs the token contract address on Robinhood Chain.");
    const amount = num(p.amountEth ?? p.amountHype), every = num(p.everyHours);
    if (!(amount > 0) || !(every >= 1)) throw new HttpError(400, "DCA needs an amount of ETH and an interval of at least 1 hour.");
    const runs = Math.min(365, Math.max(1, num(p.runs) || 10));
    return { type, params: { token: String(p.token).toLowerCase(), symbol: untrusted(p.symbol || "token", 20), amountEth: amount, everyHours: every, runs, done: 0, nextAt: Date.now() + 60_000 }, title: `DCA ${amount} ETH → ${untrusted(p.symbol || "token", 20)} every ${every}h` };
  }
  if (type === "alert") {
    const target = isAddress(String(p.target || "")) ? String(p.target).toLowerCase() : coinOf(p.target);
    const px = num(p.px);
    if (!target || !(px > 0)) throw new HttpError(400, "An alert needs a perp or token and a price.");
    const direction = p.direction === "below" ? "below" : "above";
    return { type, params: { target, direction, px, unit: isAddress(target) ? "ETH" : "USD" }, title: `Alert ${isAddress(target) ? untrusted(p.symbol || target.slice(0, 8), 20) : target} ${direction === "below" ? "≤" : "≥"} ${px}` };
  }
  throw new HttpError(400, "Unknown playbook type. Use stop_loss, take_profit, dca or alert.");
}

export async function createWatch(address, input) {
  const w = normalize(input);
  const rec = { id: randomBytes(6).toString("hex"), address: address.toLowerCase(), ...w, status: "active", createdAt: Date.now(), lastCheck: null, lastPrice: null, fires: [] };
  // Phase 3: $TROYA holders keep more playbooks active
  const hp = await import("./holders.mjs").catch(() => null);
  const cap = hp && (await hp.hasPerks(address).catch(() => false)) ? hp.PERKS.playbooks : MAX_PER_USER;
  await store.update("watches.json", [], (list) => {
    if (list.filter((x) => x.address === rec.address && x.status === "active").length >= cap) throw new HttpError(400, `You can keep up to ${cap} active playbooks.`);
    list.push(rec);
  });
  await logAction({ address, kind: "watch.create", summary: rec.title, source: "app" });
  return rec;
}

async function fire(w, price, action, note) {
  const aw = await import("./agentwallet.mjs");
  const wallet = await aw.getAgentWallet(w.address);
  const pol = await getPolicy(w.address);
  let outcome;
  if (action && wallet?.enabled && !pol.effective.paused && !pol.effective.killSwitch) {
    try {
      const r = await aw.executeForUser(w.address, { kind: action.kind, params: action.params, rationale: `Playbook "${w.title}" fired at ${price}`, source: "playbook" });
      outcome = r.executed ? "executed" : r.blocked ? "blocked" : "built";
      if (!r.executed) await addInbox(w.address, { kind: "playbook", title: `${w.title}: ${outcome}`, body: (r.reasons || []).join(" ") || r.result?.note || "" });
    } catch (e) {
      outcome = "failed";
      await addInbox(w.address, { kind: "playbook", title: `${w.title}: could not execute`, body: e.message });
    }
  } else if (action) {
    const p = await createProposal(w.address, { kind: action.kind, params: action.params, summary: `${w.title} fired at ${price}`, rationale: note, source: "playbook" });
    await addInbox(w.address, { kind: "proposal", title: `${w.title} fired at ${price}`, body: "Approve it in Portfolio → Inbox within 10 minutes.", data: { proposalId: p.id } });
    outcome = "proposed";
  } else {
    await addInbox(w.address, { kind: "alert", title: `${w.title} (now ${price})`, body: note });
    outcome = "notified";
  }
  await logAction({ address: w.address, kind: `watch.${w.type}`, summary: `${w.title} fired at ${price}`, rationale: note, status: outcome, source: "playbook" });
  return outcome;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const list = await store.readJson("watches.json", []);
    const active = list.filter((w) => w.status === "active");
    if (!active.length) return;
    let mids = null;
    const needPerp = active.some((w) => w.type !== "dca" && !(w.type === "alert" && isAddress(w.params.target)));
    if (needPerp) mids = Object.fromEntries((await hlMarkets()).map((m) => [m.coin.toUpperCase(), m.midPx || m.markPx]));
    const updates = new Map();
    for (const w of active) {
      try {
        const u = { lastCheck: Date.now() };
        if (w.type === "stop_loss") {
          const px = mids?.[w.params.coin];
          u.lastPrice = px;
          if (px && (w.params.direction === "below" ? px <= w.params.triggerPx : px >= w.params.triggerPx)) {
            const o = await fire(w, px, { kind: "close", params: { coin: w.params.coin, sizePct: w.params.sizePct } }, `${w.params.coin} crossed ${w.params.triggerPx}.`);
            u.status = "done"; u.fires = [...w.fires, { t: Date.now(), px, outcome: o }];
          }
        } else if (w.type === "take_profit") {
          const px = mids?.[w.params.coin];
          u.lastPrice = px;
          const levels = w.params.levels.map((l) => ({ ...l }));
          let fired = false;
          for (const l of levels) {
            if (l.done || !px) continue;
            if (w.params.direction === "above" ? px >= l.px : px <= l.px) {
              const o = await fire(w, px, { kind: "close", params: { coin: w.params.coin, sizePct: l.sizePct } }, `Level ${l.px} reached: close ${l.sizePct}%.`);
              l.done = true; fired = true; u.fires = [...(u.fires || w.fires), { t: Date.now(), px, level: l.px, outcome: o }];
            }
          }
          if (fired) { u.params = { ...w.params, levels }; if (levels.every((l) => l.done)) u.status = "done"; }
        } else if (w.type === "dca") {
          if (Date.now() >= w.params.nextAt) {
            const o = await fire(w, "schedule", { kind: "swap", params: { tokenIn: "native", tokenOut: w.params.token, amountIn: w.params.amountEth ?? w.params.amountHype, slippagePct: 2 } }, `Scheduled buy ${w.params.done + 1} of ${w.params.runs}.`);
            const done = w.params.done + 1;
            u.params = { ...w.params, done, nextAt: Date.now() + w.params.everyHours * 3600_000 };
            u.fires = [...w.fires, { t: Date.now(), outcome: o }].slice(-50);
            if (done >= w.params.runs) u.status = "done";
          }
        } else if (w.type === "alert") {
          let px;
          if (isAddress(w.params.target)) px = (await robinhoodToken(w.params.target).catch(() => null))?.priceEth;
          else px = mids?.[w.params.target];
          u.lastPrice = px ?? null;
          if (px != null && (w.params.direction === "below" ? px <= w.params.px : px >= w.params.px)) {
            const o = await fire(w, px, null, `Price ${w.params.direction === "below" ? "fell to" : "reached"} ${px} ${w.params.unit}.`);
            u.status = "done"; u.fires = [...w.fires, { t: Date.now(), px, outcome: o }];
          }
        }
        updates.set(w.id, u);
      } catch (e) {
        updates.set(w.id, { lastCheck: Date.now(), lastError: String(e.message).slice(0, 200) });
      }
    }
    await store.update("watches.json", [], (all) => { for (const w of all) { const u = updates.get(w.id); if (u) Object.assign(w, u); } });
  } catch (e) {
    console.error("[watches]", e.message);
  } finally { running = false; }
}

export async function register(r, ctx) {
  store = ctx.store;
  if (process.env.TROYA_WATCHES !== "0") setInterval(tick, TICK_MS).unref();

  r.get("/api/watches", async ({ req }) => {
    const s = requireSession(req);
    const list = (await store.readJson("watches.json", [])).filter((w) => w.address === s.address.toLowerCase());
    return { items: list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100), tickSec: TICK_MS / 1000 };
  });
  r.post("/api/watches", async ({ req, body }) => ({ item: await createWatch(requireSession(req).address, body) }));
  r.post("/api/watches/:id/toggle", async ({ req, params }) => {
    const s = requireSession(req);
    let out;
    await store.update("watches.json", [], (all) => {
      const w = all.find((x) => x.id === params.id && x.address === s.address.toLowerCase());
      if (!w) throw new HttpError(404, "Playbook not found.");
      if (w.status === "done") throw new HttpError(409, "This playbook already finished.");
      w.status = w.status === "active" ? "paused" : "active";
      out = w;
    });
    return { item: out };
  });
  r.del("/api/watches/:id", async ({ req, params }) => {
    const s = requireSession(req);
    let removed = null;
    await store.update("watches.json", [], (all) => {
      const i = all.findIndex((x) => x.id === params.id && x.address === s.address.toLowerCase());
      if (i < 0) throw new HttpError(404, "Playbook not found.");
      removed = all.splice(i, 1)[0];
    });
    await logAction({ address: s.address, kind: "watch.delete", summary: `${removed.title} removed`, source: "app" });
    return { ok: true };
  });
  r.post("/api/watches/tick", async ({ req }) => { requireSession(req); await tick(); return { ok: true }; });
}
