// V6 launch rules without a chain: parsing launch posts, refused names, Troya's share.  node tools/launch-test.mjs
import assert from "node:assert/strict";
import { parseLaunch, nameProblem, troyaBpsFor } from "../server/launch.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("plain launch post", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse $HORSE"), { name: "Wooden Horse", symbol: "HORSE", taxBps: 0 }));
t("ticker first, tax with %", () => assert.deepEqual(parseLaunch("@Troyaagent launch $HORSE Wooden Horse tax 2%"), { name: "Wooden Horse", symbol: "HORSE", taxBps: 200 }));
t("decimal tax and creator tax wording", () => assert.equal(parseLaunch("@Troyaagent launch Fork Horse $FH creator tax: 1.5%").taxBps, 150));
t("mention in the middle and a link", () => assert.deepEqual(parseLaunch("launch @Troyaagent Moon Cat $MCAT https://t.co/abc"), { name: "Moon Cat", symbol: "MCAT", taxBps: 0 }));
t("please launch", () => assert.equal(parseLaunch("@Troyaagent please launch Doge Horse $DGH").symbol, "DGH"));
t("lower-case ticker is upper-cased", () => assert.equal(parseLaunch("@Troyaagent launch Tiny $tiny").symbol, "TINY"));
t("not a launch", () => { assert.equal(parseLaunch("@Troyaagent when launch?"), null); assert.equal(parseLaunch("@Troyaagent gm"), null); });
t("launch without ticker", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse"), { name: "Wooden Horse", symbol: "", taxBps: 0 }));
t("emojis and symbols dropped from the name", () => assert.equal(parseLaunch("@Troyaagent launch Horse 🐴!! $HRS").name, "Horse"));

t("names that copy majors are refused", () => { for (const s of ["ETH", "BTC", "USDG", "TROYA", "HOOD"]) assert.ok(nameProblem("Something", s), s); });
t("reserved words are refused", () => { assert.ok(nameProblem("Troya Classic", "TRC")); assert.ok(nameProblem("Official Coin", "OFC")); assert.ok(nameProblem("Robinhood Cat", "RHC")); });
t("name that is a major is refused", () => assert.ok(nameProblem("Ethereum? no: ETH", "XYZ") === null && nameProblem("e t h", "XYZ")));
t("bad ticker characters", () => assert.ok(nameProblem("Horse", "HO-RSE")));
t("missing name or ticker", () => { assert.ok(nameProblem("", "HORSE")); assert.ok(nameProblem("Horse", "")); });
t("a fine coin passes", () => assert.equal(nameProblem("Wooden Horse", "HORSE"), null));

t("Troya's share is 0.1% of volume whatever the tax", () => {
  assert.equal(troyaBpsFor(0), 1428);          // 10 / 70
  assert.equal(troyaBpsFor(100), 588);         // 10 / 170
  assert.equal(troyaBpsFor(200), 370);         // 10 / 270
  assert.equal(troyaBpsFor(400), 212);         // 10 / 470
  for (const tax of [0, 50, 100, 250, 400]) {
    const ofVolumeBps = (troyaBpsFor(tax) / 10_000) * (70 + tax);
    assert.ok(ofVolumeBps <= 10 && ofVolumeBps > 9.9, `tax ${tax}: ${ofVolumeBps}`);
  }
});
console.log(`\n${n}/${n} passed`);
