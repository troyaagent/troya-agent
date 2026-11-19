// Runs the built Snap bundle (dist/bundle.js) outside MetaMask: its onTransaction handler is called with real Robinhood
// Chain transactions and asks troya.codes for real, so the bundle that would ship is the one tested.
//   node test/bundle-check.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const src = fs.readFileSync(path.join(__dirname, "../dist/bundle.js"), "utf8");
const mod = { exports: {} };
new Function("module", "exports", "require", src)(mod, mod.exports, require);
const { onTransaction } = mod.exports;
assert.equal(typeof onTransaction, "function", "the bundle exports onTransaction");

const FROM = "0xFb0Ff87d2c26F15D880d0EDd1260aa417a82FFa0";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const DESK = "105ebb4bf1a04fbb7bf3f4497d7e3ee368205150";
const pad = (h) => h.padStart(64, "0");
const text = (node) => JSON.stringify(node);

(async () => {
  const a = await onTransaction({ chainId: "eip155:4663", transaction: { from: FROM, to: ROUTER, value: "0x2386f26fc10000", data: "0x3593564c" + pad("60") + pad(DESK) + pad("de0b6b3a7640000") } });
  assert.match(text(a.content), /Troya Gate/); assert.match(text(a.content), /\$DESK/);
  console.log("router call  →", a.severity || "no banner", "·", text(a.content).match(/"\$DESK"|DESK[^"]*/)?.[0]);

  const b = await onTransaction({ chainId: "eip155:4663", transaction: { from: FROM, to: "0x" + DESK, value: "0x0", data: "0x095ea7b3" + pad("111122223333444455556666777788889999aaaa") + "f".repeat(64) } });
  assert.match(text(b.content), /Unlimited approval/); assert.equal(b.severity, "critical");
  console.log("approval     →", b.severity, "· warning shown");

  const c = await onTransaction({ chainId: "eip155:1", transaction: { from: FROM, to: ROUTER, value: "0x0", data: "0x" } });
  assert.match(text(c.content), /Robinhood Chain transactions only/);
  console.log("other chain  → quiet");
  console.log("all 3 checks passed");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
