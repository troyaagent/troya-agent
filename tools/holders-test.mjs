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
const BIG = "0xE64785f0611eD19E9567f38f9ae076385B76a7DD";      // a public wallet that holds about 6.5% of supply
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

console.log("B · announced, not yet on");
h = await load({ HOLDER_START: new Date(Date.now() + 3600e3).toISOString() });
ok(!h.perksOn(), "before HOLDER_START the perks are off");
ok(!(await h.hasPerks(BIG)), "a holder gets nothing early");
ok((await h.holderOf(BIG)).holder, "but the status already shows they qualify");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
