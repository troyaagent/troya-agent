// Saves the "Troya Test Provider" agent's ACP connection to ~/.config/troya/acp-provider.env (mode 600), asked here in the
// Terminal so the signer key never goes through a chat. Usage: node setup-provider.mjs
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, ok) => { for (;;) { const v = (await rl.question(q)).trim(); if (ok(v)) return v; console.log("  That does not look right, try again."); } };
console.log("Troya Test Provider setup. Copy each value from app.virtuals.io → My Agents → Troya Test Provider.\n");
const addr = await ask("1) Agent EVM wallet address (0x…, shown at the top of the agent page): ", (v) => /^0x[0-9a-fA-F]{40}$/.test(v));
const id = await ask("2) EVM Wallet ID (Wallet tab → Signers): ", (v) => v.length >= 8 && !/\s/.test(v));
const key = await ask("3) Signer private key (Wallet tab → Add Key → Generate Key Pair, policy Virtuals-only): ", (v) => v.length >= 32 && !/\s/.test(v));
const offering = (await rl.question("4) Offering name (press Enter for \"test_task\"): ")).trim() || "token_snapshot";
rl.close();
const dir = process.env.HOME + "/.config/troya";
mkdirSync(dir, { recursive: true });
const file = dir + "/acp-provider.env";
writeFileSync(file, `# Troya Test Provider (Virtuals ACP), used only to test Troya Gate as an evaluator\nACP_WALLET_ADDRESS=${addr}\nACP_WALLET_ID=${id}\nACP_SIGNER_KEY=${key}\nACP_OFFERING=${offering}\nACP_PRICE_USDC=0.01\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`\nSaved to ${file} (only you can read it). Next: node test-provider.mjs`);
