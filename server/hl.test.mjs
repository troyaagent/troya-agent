// Signing checks against vectors from Hyperliquid's official Python SDK tests (tests/signing_test.py).
// Run: node server/hl.test.mjs   (no network, sends nothing)
import assert from "node:assert/strict";
import { encode } from "@msgpack/msgpack";
import { actionHash, phantomAgent, signL1Action, floatToWire, orderWire, orderAction, roundPx, roundSz } from "./hl.mjs";

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { console.log("FAIL", name, "\n     ", e.message); process.exitCode = 1; } };

await t("float_to_wire normalises like the SDK", () => {
  assert.equal(floatToWire(1670.1), "1670.1");
  assert.equal(floatToWire(0.0147), "0.0147");
  assert.equal(floatToWire(100), "100");
  assert.equal(floatToWire(-0), "0");
  assert.equal(floatToWire(0.00001), "0.00001");
  assert.throws(() => floatToWire(0.123456789));
});

await t("phantom agent connectionId for an IOC ETH order (SDK vector)", () => {
  const wire = orderWire({ asset: 4, isBuy: true, limitPx: 1670.1, size: 0.0147, reduceOnly: false, orderType: { limit: { tif: "Ioc" } } });
  const hash = actionHash(orderAction([wire]), null, 1677777606040);
  assert.equal(phantomAgent(hash, true).connectionId, "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
});

await t("L1 action signature, mainnet + testnet (SDK vector)", async () => {
  const key = "0x0123456789012345678901234567890123456789012345678901234567890123";
  const action = { type: "dummy", num: 100000000000 }; // float_to_int_for_hashing(1000)
  const main = await signL1Action(key, action, { nonce: 0, isMainnet: true });
  assert.equal(BigInt(main.r), BigInt("0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298"));
  assert.equal(BigInt(main.s), BigInt("0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8"));
  assert.equal(main.v, 27);
  const test = await signL1Action(key, action, { nonce: 0, isMainnet: false });
  assert.equal(BigInt(test.r), BigInt("0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510"));
  assert.equal(BigInt(test.s), BigInt("0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613"));
  assert.equal(test.v, 28);
});

await t("price + size rounding rules", () => {
  assert.equal(roundPx(74861.37, 5), 74861);      // integer part already 5 sig figs → 74861
  assert.equal(roundPx(1670.123, 4), 1670.1);     // 5 sig figs
  assert.equal(roundPx(0.123456, 0), 0.12346);    // ≤6 decimals, 5 sig figs
  assert.equal(roundPx(0.0123456, 2), 0.0123);    // capped at 6-2=4 decimals
  assert.equal(roundSz(0.123456, 3), 0.123);
});

// the browser client must hash identically (custom msgpack encoder)
await t("browser hl.js msgpack + hash match the server", async () => {
  const web = await import("../public/agent/js/hl.js");
  const samples = [
    { type: "order", orders: [{ a: 0, b: true, p: "74861", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
    { type: "order", orders: [{ a: 159, b: false, p: "0.12345", s: "12000", r: true, t: { trigger: { isMarket: true, triggerPx: "0.13", tpsl: "sl" } } }], grouping: "normalTpsl" },
    { type: "cancel", cancels: [{ a: 3, o: 91490942339 }] },
    { type: "updateLeverage", asset: 1, isCross: true, leverage: 7 },
    { type: "dummy", num: 100000000000, neg: -5, big: -70000, s: "x".repeat(40), arr: Array.from({ length: 20 }, (_, i) => i * 1000), nil: null },
  ];
  for (const a of samples) {
    assert.deepEqual(Buffer.from(web.msgpackEncode(a)).toString("hex"), Buffer.from(encode(a)).toString("hex"));
    assert.equal(web.actionHash(a, null, 1794257000123), actionHash(a, null, 1794257000123));
  }
  const key = "0x0123456789012345678901234567890123456789012345678901234567890123";
  const s1 = await web.signL1Action(key, { type: "dummy", num: 100000000000 }, 0);
  const s2 = await signL1Action(key, { type: "dummy", num: 100000000000 }, { nonce: 0 });
  assert.equal(s1.r, s2.r); assert.equal(s1.s, s2.s); assert.equal(s1.v, s2.v);
});

console.log(`\n${pass} passed`);
