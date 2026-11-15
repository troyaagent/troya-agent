// Offline checks for the limits added after the 15 Nov 2026 outside review. No network, no keys.
//   node tools/security-test.mjs
process.env.SITE_URL = "https://troya.codes";
process.env.TROYA_NO_BROADCAST = "1";
const rh = await import("../server/robinhood.mjs");
const auth = await import("../server/auth.mjs");
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log("slippage");
t("default cap is 5%", rh.MAX_SLIPPAGE_BPS === 500, rh.MAX_SLIPPAGE_BPS);
t("a client asking 50% gets the cap", rh.capSlippage(5000) === rh.MAX_SLIPPAGE_BPS);
t("normal requests pass through", rh.capSlippage(100) === 100 && rh.capSlippage(300) === 300);
t("nonsense falls back to 1%", rh.capSlippage("abc") === 100 && rh.capSlippage(-5) === 1);
t("only internal simulations go wider", rh.capSlippage(5000, true) === 5000);

console.log("minOut");
t("minOut=0 is ignored, the quote's minimum stays", rh.floorMinOut(1000n, "0") === 1000n);
t("a lower minOut is ignored", rh.floorMinOut(1000n, "999") === 1000n);
t("a higher minOut (more protection) is kept", rh.floorMinOut(1000n, "1500") === 1500n);
t("no minOut means the quote's minimum", rh.floorMinOut(1000n, undefined) === 1000n && rh.floorMinOut(1000n, "") === 1000n);
t("garbage is refused", throws(() => rh.floorMinOut(1000n, "1e18")));
t("internal test sell may use 0", rh.floorMinOut(1000n, "0", true) === 0n);

console.log("relay");
const r1 = await rh.checkCall("robinhood", { jsonrpc: "2.0", id: 7, method: "eth_sendRawTransaction", params: ["0x02"] }, "1.2.3.4");
t("TROYA_NO_BROADCAST refuses eth_sendRawTransaction", r1?.error && /switched off/.test(r1.error.message), JSON.stringify(r1));
const r2 = await rh.checkCall("robinhood", { jsonrpc: "2.0", id: 8, method: "eth_chainId", params: [] }, "1.2.3.4");
t("reads still pass", r2 === null, JSON.stringify(r2));

console.log("sign-in message");
const req = { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } };
const msg = auth.makeChallenge(req, "0x1111111111111111111111111111111111111111");
t("names troya.codes, not the Host header", msg.startsWith("troya.codes wants you to sign in") && msg.includes("URI: https://troya.codes") && !msg.includes("evil.example"), msg.split("\n")[0]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
