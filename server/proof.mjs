// Proof a checker can read without a browser app: the test wallet's Hyperliquid fills, live from Hyperliquid's own API.
//   GET /api/proof/hl-fills → every fill on 0x12a0…7054 (time, coin, side, price, size, closed PnL, fee, order id, L1 hash)
// The same data straight from Hyperliquid: POST https://api.hyperliquid.xyz/info {"type":"userFills","user":"<address>"}
// The static list of every proof transaction (chain, signer, role, time) is public/proof.json.
import { hlInfo } from "./hl.mjs";

export const TEST_WALLET = "0x12a05719851c8375342DE65c9105329c81f57054";
let cache = null;

export async function register(r) {
  r.get("/api/proof/hl-fills", async () => {
    if (cache && Date.now() - cache.at < 60_000) return cache.v;
    const fills = await hlInfo({ type: "userFills", user: TEST_WALLET.toLowerCase() });
    const v = {
      account: TEST_WALLET,
      source: "Hyperliquid info API: POST https://api.hyperliquid.xyz/info {\"type\":\"userFills\",\"user\":\"" + TEST_WALLET.toLowerCase() + "\"}",
      explorer: `https://app.hyperliquid.xyz/explorer/address/${TEST_WALLET}`,
      count: (fills || []).length,
      fills: (fills || []).map((f) => ({ time: new Date(f.time).toISOString(), coin: f.coin, dir: f.dir, side: f.side === "B" ? "buy" : "sell", px: Number(f.px), sz: Number(f.sz), closedPnl: Number(f.closedPnl), fee: Number(f.fee), oid: f.oid, hash: f.hash })),
    };
    cache = { at: Date.now(), v };
    return v;
  }, { perMin: 30 });
}
