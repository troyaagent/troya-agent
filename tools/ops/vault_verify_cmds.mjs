// Prints the Blockscout verification commands for the deployed Troya Index (run from contracts/), built with the same
// library the deploy page used, so the constructor arguments match what was signed. Usage:
//   node tools/ops/vault_verify_cmds.mjs <swapper> <vault> <zap> <keeper>
import { verifyCommands, CREATOR } from "../../public/agent/desk/index-deploy-lib.js";
const [swapper, vault, zap, keeper] = process.argv.slice(2);
for (const c of verifyCommands({ swapper, vault, zap, owner: CREATOR, keeper })) console.log(c);
