// Marks a Troya Check score as disputed while the team reviews a token team's request (or clears it). Runs on the server:
//   sudo -u troya node /srv/troya/tools/ops/check_dispute.mjs add 0x... "contested by the team, ticket from team@troya.codes"
//   sudo -u troya node /srv/troya/tools/ops/check_dispute.mjs remove 0x...
//   sudo -u troya node /srv/troya/tools/ops/check_dispute.mjs list
// The server re-reads the list within a minute. The score itself is never changed by this.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const F = "/srv/troya/data/check-disputes.json";
const [cmd, addr, ...rest] = process.argv.slice(2);
let d = {}; try { d = JSON.parse(readFileSync(F, "utf8")); } catch { d = {}; }
const k = String(addr || "").toLowerCase();
if (cmd === "list") { console.log(JSON.stringify(d, null, 1)); process.exit(0); }
if (!/^0x[0-9a-f]{40}$/.test(k) || !["add", "remove"].includes(cmd)) { console.log("usage: add|remove 0x... [note] | list"); process.exit(1); }
if (cmd === "add") d[k] = { since: Date.now(), note: rest.join(" ").slice(0, 200) || null };
else delete d[k];
writeFileSync(F + ".tmp", JSON.stringify(d, null, 1)); renameSync(F + ".tmp", F);
console.log(cmd === "add" ? "marked disputed:" : "cleared:", k);
