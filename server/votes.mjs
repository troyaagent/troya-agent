// F20 · Social layer, holders: the Troya Holder Pass (a soulbound NFT, contracts/src/TroyaPass.sol) and pass votes.
//   GET  /api/pass                 → the pass contract (once deployed), MIN_HOLD, passes minted, and for ?address= that
//                                    wallet's $TROYA balance, eligibility, pass id and whether it counts in votes
//   POST /api/pass/config {hash}   → admins: register the pass after deploying it from the browser; the deploy transaction is
//                                    checked (sent by an admin, creation code = the tested build, $TROYA as the token)
//   GET  /api/votes                → proposals with live tallies          GET /api/votes/:id → one proposal, every signed vote
//   POST /api/votes {title, options, days}       → admins: open a proposal
//   POST /api/votes/:id/vote {option, signature} → a pass holder's EIP-712 signed vote (no transaction, no gas)
// Counting rules: one pass, one vote. A pass counts only if it was minted before the proposal opened (compared by time:
// on an Arbitrum Orbit chain block.number inside a contract is the parent chain's block, so the pass's mint timestamp
// is checked against the Robinhood Chain block time when the proposal opened), and only while its
// wallet still holds MIN_HOLD $TROYA; when a proposal closes, every voter is checked once more and the result is frozen.
// So moving one bag of $TROYA between wallets cannot vote twice. Every signature is public: anyone can re-check.
import { Interface, verifyTypedData, getAddress, isAddress } from "ethers";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc } from "./robinhood.mjs";
import { HttpError } from "./api.mjs";
import { getSession, requireSession } from "./auth.mjs";

const TROYA = "0x1fa81ddaaac83240803b3f2d20595e40edc1a074";
const DEFAULT_MIN = 1_000_000;                        // same line as the holder perks (HOLDER_MIN)
const lc = (s) => String(s || "").toLowerCase();
const admins = () => String(process.env.X_ADMINS || process.env.TROYA_ADMINS || "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
const isAdmin = (req) => { const s = getSession(req); return !!s && admins().includes(lc(s.address)); };
const passI = new Interface([
  "function passOf(address) view returns (uint256)", "function isActive(address) view returns (bool)", "function eligible(address) view returns (bool)",
  "function mintedAt(uint256) view returns (uint256 blockNumber, uint256 timestamp)", "function totalSupply() view returns (uint256)", "function totalMinted() view returns (uint256)",
  "function MIN_HOLD() view returns (uint256)", "function TOKEN() view returns (address)", "function tokenURI(uint256) view returns (string)",
]);
const ercI = new Interface(["function balanceOf(address) view returns (uint256)"]);
const call = async (to, i, fn, args = [], block = "latest") => i.decodeFunctionResult(fn, await rpc("robinhood", "eth_call", [{ to, data: i.encodeFunctionData(fn, args) }, block], { timeoutMs: 12000 }));
const TYPES = { Vote: [{ name: "proposal", type: "string" }, { name: "option", type: "uint8" }, { name: "voter", type: "address" }] };
const domain = (pass) => ({ name: "Troya Votes", version: "1", chainId: 4663, verifyingContract: pass });

let store = null, build = null;
async function buildInfo() {
  if (build) return build;
  const f = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "agent", "desk", "troya-pass.json");
  build = JSON.parse(await readFile(f, "utf8"));
  return build;
}
async function passAddr() { return (await store.readJson("pass.json", {})).address || null; }

/* ---------- the pass ---------- */
export async function passView(address) {
  const pass = await passAddr();
  const out = { pass, token: TROYA, minHold: DEFAULT_MIN, deployed: !!pass, domain: pass ? domain(pass) : null, types: TYPES };
  if (pass) {
    const [mh, ts, tm] = await Promise.all([call(pass, passI, "MIN_HOLD"), call(pass, passI, "totalSupply"), call(pass, passI, "totalMinted")]);
    Object.assign(out, { minHold: Number(mh[0]) / 1e18, passes: Number(ts[0]), minted: Number(tm[0]) });
  }
  if (address && isAddress(address)) {
    const a = getAddress(address);
    const bal = Number((await call(TROYA, ercI, "balanceOf", [a]))[0]) / 1e18;
    const me = { address: a, balance: bal, eligible: bal >= out.minHold, passId: null, active: false };
    if (pass) {
      const id = Number((await call(pass, passI, "passOf", [a]))[0]);
      me.passId = id || null;
      me.active = !!id && me.eligible;
      if (id) { const m = await call(pass, passI, "mintedAt", [id]); me.mintedAt = Number(m.timestamp); me.image = await passImage(pass, id).catch(() => null); }
    }
    out.me = me;
  }
  return out;
}
async function passImage(pass, id) {
  const uri = (await call(pass, passI, "tokenURI", [id]))[0];
  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
  return json.image;
}
async function configure(req, hash) {
  if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
  if (await passAddr()) throw new HttpError(409, "The pass is already registered.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) throw new HttpError(400, "Bad transaction hash.");
  const [tx, rc] = await Promise.all([rpc("robinhood", "eth_getTransactionByHash", [hash]), rpc("robinhood", "eth_getTransactionReceipt", [hash])]);
  if (!tx || !rc) throw new HttpError(404, "That transaction is not on Robinhood Chain yet.");
  if (!admins().includes(lc(tx.from))) throw new HttpError(403, "The pass must be deployed by an admin wallet.");
  if (tx.to || !rc.contractAddress || Number(rc.status) !== 1) throw new HttpError(400, "That is not a successful contract deployment.");
  const b = await buildInfo();
  if (!lc(tx.input).startsWith(lc(b.bytecode))) throw new HttpError(400, "That deployment is not the tested TroyaPass build.");
  const pass = getAddress(rc.contractAddress);
  if (lc((await call(pass, passI, "TOKEN"))[0]) !== TROYA) throw new HttpError(400, "That pass does not use $TROYA.");
  await store.writeJson("pass.json", { address: pass, deployTx: hash, deployedBy: getAddress(tx.from), block: Number(BigInt(rc.blockNumber)), at: Date.now() });
  return { ok: true, pass };
}

/* ---------- proposals and votes ---------- */
const startOf = (p) => p.startTime || Math.floor(p.createdAt / 1000);
async function counts(p, pass, final = false) {
  const tally = p.options.map(() => 0), voters = [];
  for (const v of Object.values(p.votes || {})) {
    let ok = false;
    try {
      const id = Number((await call(pass, passI, "passOf", [v.voter]))[0]);
      if (id) {
        const m = await call(pass, passI, "mintedAt", [id]);
        ok = Number(m.timestamp) < startOf(p) && (await call(pass, passI, "isActive", [v.voter]))[0];
      }
    } catch {}
    voters.push({ ...v, counts: ok });
    if (ok) tally[v.option]++;
  }
  return { tally, voters, checkedAt: Date.now(), final };
}
async function proposalView(p, withVotes = false) {
  const pass = await passAddr();
  const open = Date.now() < p.endsAt;
  let t = p.result;
  if (!t && pass) {
    t = await counts(p, pass, !open);
    if (!open) { await store.update("votes.json", [], (l) => { const x = l.find((y) => y.id === p.id); if (x && !x.result) x.result = t; return l; }); }
  }
  const { votes, result, ...rest } = p;
  return { ...rest, startTime: startOf(p), open, tally: t?.tally || p.options.map(() => 0), counted: t ? t.voters.filter((v) => v.counts).length : 0, cast: Object.keys(votes || {}).length, final: !!t?.final, checkedAt: t?.checkedAt || null,
    votes: withVotes ? (t?.voters || Object.values(votes || {})).map((v) => ({ voter: v.voter, option: v.option, signature: v.signature, at: v.at, counts: v.counts ?? null })) : undefined };
}
async function createProposal(req, body) {
  if (!isAdmin(req)) throw new HttpError(403, "Admins only.");
  if (!(await passAddr())) throw new HttpError(409, "Deploy the Holder Pass first.");
  const title = String(body?.title || "").trim().slice(0, 140);
  const options = (Array.isArray(body?.options) ? body.options : []).map((o) => String(o || "").trim().slice(0, 60)).filter(Boolean).slice(0, 5);
  const days = Math.min(14, Math.max(1, Number(body?.days) || 3));
  if (title.length < 8 || options.length < 2) throw new HttpError(400, "A proposal needs a title and at least two options.");
  const head = await rpc("robinhood", "eth_getBlockByNumber", ["latest", false]);
  const startBlock = Number(BigInt(head.number)), startTime = Number(BigInt(head.timestamp));
  const p = { id: `p${Date.now().toString(36)}`, title, options, startBlock, startTime, createdAt: Date.now(), endsAt: Date.now() + days * 86400_000, createdBy: requireSession(req).address, votes: {} };
  await store.update("votes.json", [], (l) => { l.push(p); return l; });
  return proposalView(p);
}
async function castVote(id, body) {
  const pass = await passAddr();
  if (!pass) throw new HttpError(409, "There is no Holder Pass yet.");
  const all = await store.readJson("votes.json", []);
  const p = all.find((x) => x.id === id);
  if (!p) throw new HttpError(404, "No such proposal.");
  if (Date.now() >= p.endsAt) throw new HttpError(409, "This vote has closed.");
  const option = Number(body?.option);
  if (!Number.isInteger(option) || option < 0 || option >= p.options.length) throw new HttpError(400, "Pick one of the options.");
  const voter = isAddress(String(body?.voter || "")) ? getAddress(body.voter) : null;
  if (!voter) throw new HttpError(400, "Missing voter.");
  let signer;
  try { signer = verifyTypedData(domain(pass), TYPES, { proposal: p.id, option, voter }, String(body?.signature || "")); } catch { throw new HttpError(400, "That signature does not check out."); }
  if (lc(signer) !== lc(voter)) throw new HttpError(400, "The signature is not from that wallet.");
  const passId = Number((await call(pass, passI, "passOf", [voter]))[0]);
  if (!passId) throw new HttpError(403, "This wallet has no Holder Pass.");
  const m = await call(pass, passI, "mintedAt", [passId]);
  if (Number(m.timestamp) >= startOf(p)) throw new HttpError(403, "Your pass was minted after this vote opened, so it counts from the next one.");
  if (!(await call(pass, passI, "isActive", [voter]))[0]) throw new HttpError(403, "Your wallet holds less $TROYA than the pass needs right now.");
  await store.update("votes.json", [], (l) => { const x = l.find((y) => y.id === id); x.votes[lc(voter)] = { voter, option, signature: String(body.signature), at: Date.now() }; return l; });
  return { ok: true, option };
}

export async function register(r, ctx) {
  store = ctx.store;
  r.get("/api/pass", ({ query }) => passView(query.address || null), { weight: 1 });
  r.post("/api/pass/config", ({ req, body }) => configure(req, body?.hash), { perMin: 10 });
  r.get("/api/votes", async ({ req }) => ({ admin: isAdmin(req), proposals: await Promise.all((await store.readJson("votes.json", [])).slice().reverse().slice(0, 30).map((p) => proposalView(p))) }), { weight: 2 });
  r.get("/api/votes/:id", async ({ params }) => { const p = (await store.readJson("votes.json", [])).find((x) => x.id === params.id); if (!p) throw new HttpError(404, "No such proposal."); return proposalView(p, true); }, { weight: 2 });
  r.post("/api/votes", ({ req, body }) => createProposal(req, body), { perMin: 10 });
  r.post("/api/votes/:id/vote", ({ params, body }) => castVote(params.id, body), { perMin: 30 });
}
