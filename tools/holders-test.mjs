// Phase 3 check: holder status from chain, the switch-on time, and the perks the server applies.
//   node tools/holders-test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const data = mkdtempSync(join(tmpdir(), "troya-holders-"));
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`); };
async function load(env) {
  Object.assign(process.env, { DATA_DIR: data, TELEGRAM_POLL: "0", TELEGRAM_BOT_TOKEN: "", SENTRY: "", ...env });
  return import(`../server/holders.mjs?${Math.random()}`);
}
// the PoolManager on Robinhood Chain holds the pooled $TROYA (about 285M on 24 Nov 2026); the wallet used before sold out
const BIG = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const EMPTY = "0x000000000000000000000000000000000000dEaD";

console.log("A · on now");
let h = await load({ HOLDER_START: "" });
const big = await h.holderOf(BIG);
ok(big.holder && big.balance > 1e6, "a wallet with millions of $TROYA counts as a holder", `${Math.round(big.balance).toLocaleString("en-US")} TROYA`);
ok(await h.hasPerks(BIG), "perks apply when switched on");
const none = await h.holderOf(EMPTY);
ok(!none.holder && none.balance === 0, "an empty wallet is not a holder");
ok(!(await h.hasPerks(EMPTY)), "no perks without the tokens");
ok(h.PERKS.messagesPerDay === 200 && h.PERKS.playbooks === 100, "perks: 200 messages a day, 100 playbooks");

console.log("A2 · King's Guard (50,000,000 $TROYA): the Sentry lead list and the badge test");
{
  const { initStore } = await import("../server/store.mjs");
  const st = await initStore(mkdtempSync(join(tmpdir(), "troya-guard-")));
  await st.writeJson("telegram.json", { links: { [BIG.toLowerCase()]: 111, [EMPTY.toLowerCase()]: 222 } });
  const tr = await import(`../server/treasury.mjs?${Math.random()}`);
  await tr.register({ get() {}, post() {} }, { store: st });
  ok(tr.isGuardBalance(50_000_000) && !tr.isGuardBalance(49_999_999), "King's Guard starts at 50,000,000 $TROYA");
  const g = await tr.guardChats();
  const bigBal = (await h.holderOf(BIG)).balance;
  ok(bigBal >= 50e6 && g.length === 1 && g[0].chat === 111 && g[0].leadSec === 60 && g[0].tier === "guard",
    "guardChats lists only the linked King's Guard wallet, with a 60 s lead", JSON.stringify(g.map((x) => [x.chat, x.leadSec])));
  ok(!g.some((x) => x.chat === 222), "an empty linked wallet gets no lead");
}

console.log("B · announced, not yet on");
h = await load({ HOLDER_START: new Date(Date.now() + 3600e3).toISOString() });
ok(!h.perksOn(), "before HOLDER_START the perks are off");
ok(!(await h.hasPerks(BIG)), "a holder gets nothing early");
ok((await h.holderOf(BIG)).holder, "but the status already shows they qualify");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
