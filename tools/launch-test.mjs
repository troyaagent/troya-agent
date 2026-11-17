// V6 launch rules without a chain: parsing launch posts, refused names, Troya's share.  node tools/launch-test.mjs
import assert from "node:assert/strict";
import { parseLaunch, nameProblem, troyaBpsFor } from "../server/launch.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("plain launch post", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse $HORSE"), { name: "Wooden Horse", symbol: "HORSE", taxBps: 0, buyEth: 0 }));
t("ticker first, tax with %", () => assert.deepEqual(parseLaunch("@Troyaagent launch $HORSE Wooden Horse tax 2%"), { name: "Wooden Horse", symbol: "HORSE", taxBps: 200, buyEth: 0 }));
t("decimal tax and creator tax wording", () => assert.equal(parseLaunch("@Troyaagent launch Fork Horse $FH creator tax: 1.5%").taxBps, 150));
t("mention in the middle and a link", () => assert.deepEqual(parseLaunch("launch @Troyaagent Moon Cat $MCAT https://t.co/abc"), { name: "Moon Cat", symbol: "MCAT", taxBps: 0, buyEth: 0 }));
t("please launch", () => assert.equal(parseLaunch("@Troyaagent please launch Doge Horse $DGH").symbol, "DGH"));
t("the ticker keeps the case it was written in", () => { assert.equal(parseLaunch("@Troyaagent launch Tiny $tiny").symbol, "tiny"); assert.equal(parseLaunch("@Troyaagent launch X Test $XtestTROYA buy 0.001").symbol, "XtestTROYA"); });
t("a copy of a major is refused whatever the case", () => assert.ok(nameProblem("Something", "eth")));
t("the Troya team may use reserved words, others may not", () => { assert.ok(nameProblem("Troya Test", "XtestTROYA")); assert.equal(nameProblem("Troya Test", "XtestTROYA", { team: true }), null); assert.ok(nameProblem("Troya Test", "ETH", { team: true })); });
t("not a launch", () => { assert.equal(parseLaunch("@Troyaagent when launch?"), null); assert.equal(parseLaunch("@Troyaagent gm"), null); });
t("launch without ticker", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse"), { name: "Wooden Horse", symbol: "", taxBps: 0, buyEth: 0 }));
t("initial buy", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse $HORSE buy 0.01"), { name: "Wooden Horse", symbol: "HORSE", taxBps: 0, buyEth: 0.01 }));
t("initial buy with eth, tax and a full stop", () => assert.deepEqual(parseLaunch("@Troyaagent launch Wooden Horse $HORSE tax 2% initial buy 0.05 ETH."), { name: "Wooden Horse", symbol: "HORSE", taxBps: 200, buyEth: 0.05 }));
t("dev buy .2", () => assert.equal(parseLaunch("@Troyaagent launch Wooden Horse $HORSE dev buy .2").buyEth, 0.2));
t("buy as a word in the name is not a buy", () => assert.deepEqual(parseLaunch("@Troyaagent launch Buy The Dip $BTD"), { name: "Buy The Dip", symbol: "BTD", taxBps: 0, buyEth: 0 }));
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
