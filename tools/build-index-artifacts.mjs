// Builds public/agent/desk/troya-index.json (ABI + creation bytecode of TroyaIndexSwapper, TroyaIndex, TroyaIndexZap) from
// contracts/out, for the owner's deploy page (#/vault/deploy) and the fork test. Run after `forge build` in contracts/:
//   node tools/build-index-artifacts.mjs
// The bytecode is the one forge compiles from contracts/src with foundry.toml (solc 0.8.24, 500 runs, shanghai), so
// `forge verify-contract` on Blockscout matches it as long as contracts/src is unchanged since this build.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname;
const names = [["TroyaIndexSwapper", "TroyaIndexSwapper.sol"], ["TroyaIndex", "TroyaIndex.sol"], ["TroyaIndexZap", "TroyaIndexZap.sol"]];
const contracts = {};
let compiler = null;
for (const [name, file] of names) {
  const j = JSON.parse(await readFile(`${ROOT}contracts/out/${file}/${name}.json`, "utf8"));
  const bytecode = j.bytecode?.object;
  if (!/^0x[0-9a-f]+$/i.test(bytecode || "") || bytecode.length < 1000) throw new Error(`${name}: no bytecode in contracts/out (run forge build)`);
  contracts[name] = { abi: j.abi, bytecode, runtimeBytes: (j.deployedBytecode.object.length - 2) / 2 };
  compiler ||= j.metadata?.compiler?.version || null;
}
let commit = null;
const SRC = ["contracts/src/TroyaIndex.sol", "contracts/src/TroyaIndexSwapper.sol", "contracts/src/TroyaIndexZap.sol"];
try { commit = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%h", "--", ...SRC], { encoding: "utf8" }).trim() || null; } catch {}
// built from sources not committed yet: say so, so nobody verifies against the wrong commit
try { if (execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", ...SRC], { encoding: "utf8" }).trim()) commit = `${commit || "none"}+uncommitted`; } catch {}
const out = {
  name: "Troya Index (TIDX)",
  compiler, settings: { optimizer: true, runs: 500, evmVersion: "shanghai" },
  sourceCommit: commit,
  source: "https://github.com/troyaagent/troya-agent/tree/main/contracts/src",
  tests: "75 contract tests (64 unit/fuzz, 8 invariants, 3 Robinhood Chain fork), Slither + Wake scanned + the keeper and deploy-page fork run",
  audited: false,
  contracts,
};
await writeFile(`${ROOT}public/agent/desk/troya-index.json`, JSON.stringify(out));
console.log("wrote public/agent/desk/troya-index.json", Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.runtimeBytes])), compiler, commit);
