// Troya Check phase 2: website and X claims (each type proven, contradicted and unverified), the fetcher's guards (SSRF,
// redirects, size, scripts), the claims part in the score, the track record (grading and the score-band buckets) and the
// X silence rule. Offline: no network except a local test server on 127.0.0.1; nothing posted, no paid API.
//   node tools/checkclaims-test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "troya-claims-"));
delete process.env.OPENROUTER_API_KEY;                    // the model stays off: patterns only, never a paid call
const CC = await import("../server/checkclaims.mjs");
const C = await import("../server/check.mjs");
const { getAddress } = await import("ethers");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const A = getAddress("0x3eaf76055acfaa9a6984929fe35d3ab591f67777");
const SITE = "https://coin.example/";

/* ---------- reading claims ---------- */
const HTML = `<!doctype html><html><head><title>Example Coin</title><meta name="description" content="The fairest coin on Robinhood Chain">
<script>document.write("Liquidity is locked forever")</script><style>.x{}</style></head><body>
<h1>Example Coin</h1><p>Liquidity is locked forever. Ownership renounced. 0% tax on buys and sells.</p>
<p>Total supply: 1,000,000,000 tokens. 50% of supply burned at launch.</p>
<p>Audited by CertiK. Doxxed team. Listed on DexScreener. Partnered with Robinhood Markets.</p>
<p>The app is now live, try it today.</p><a href="https://app.coin.example/">Launch app</a>
<a href="https://skynet.certik.com/projects/example">Audit report</a><!-- Ownership renounced in a comment --></body></html>`;

await t("page text: visible words only (scripts, styles and comments dropped), title and links kept", () => {
  const p = CC.pageText(HTML, SITE);
  assert.ok(p.text.startsWith("Example Coin"));
  assert.equal((p.text.match(/Liquidity is locked forever/g) || []).length, 1, "the script's string is not read as page text");
  assert.ok(!/in a comment/.test(p.text));
  assert.ok(p.links.some((l) => l.href === "https://app.coin.example/"));
});

await t("patterns: every claim type with its exact words, URL and value", () => {
  const p = CC.pageText(HTML, SITE);
  const cl = CC.patternClaims(p.text, SITE, { links: p.links });
  const by = (type) => cl.filter((c) => c.type === type);
  assert.ok(by("lp")[0].quote.startsWith("Liquidity is locked forever"));
  assert.ok(by("renounced").length);
  assert.equal(by("tax")[0].value, 0);
  assert.equal(by("supply")[0].value, 1e9);
  assert.equal(by("burn")[0].value, 50);
  assert.equal(by("audit")[0].target, "CertiK");
  assert.ok(by("team").length);
  assert.equal(by("listing")[0].target, "dexscreener");
  assert.match(by("partner")[0].target, /^Robinhood/);
  assert.equal(by("live")[0].target, "https://app.coin.example/");
  for (const c of cl) { assert.equal(c.url, SITE); assert.ok(CC.quoteFound(c.quote, p.text), `quote in page: ${c.quote}`); }
});

await t("patterns: tax as a number, supply in words", () => {
  const cl = CC.patternClaims("Buy tax 5% and sell tax 5%. Max supply 420 million.", SITE);
  assert.equal(cl.find((c) => c.type === "tax").value, 5);
  assert.equal(cl.find((c) => c.type === "supply").value, 420e6);
  assert.equal(CC.patternClaims("Total supply 0", SITE).filter((c) => c.type === "supply").length, 0, "an animated counter is not a supply claim");
});

await t("model claims: a quote not in the text is dropped (no invented claims), a real one is kept", async () => {
  const src = [{ kind: "website", url: SITE, text: CC.pageText(HTML, SITE).text }];
  const ask = async () => JSON.stringify({ claims: [
    { type: "audit", quote: "Audited by CertiK", source: 1, target: "CertiK" },
    { type: "lp", quote: "Liquidity locked for 10 years on Unicrypt", source: 1 },           // not on the page
    { type: "price", quote: "Example Coin", source: 1 },                                      // not a claim type
    { type: "tax", quote: "0% tax on buys and sells", source: 1, value: "0" },
  ] });
  const got = await CC.modelClaims(src, { ask });
  assert.deepEqual(got.map((c) => c.type).sort(), ["audit", "tax"]);
  assert.equal(got.find((c) => c.type === "tax").value, 0);
  assert.ok(got.every((c) => c.url === SITE && c.source === "model"));
  assert.equal(await CC.modelClaims(src, { ask: async () => "not json" }), null);
});

await t("sources: the socials Troya knows, then links handed in from X (site and X handle)", () => {
  assert.deepEqual(CC.sourcesOf({ website: "https://coin.example", twitter: "https://x.com/examplecoin" }), { website: "https://coin.example/", x: "examplecoin" });
  assert.deepEqual(CC.sourcesOf({}, ["https://t.me/example", "https://x.com/examplecoin/", "https://coin.example/home"]), { website: "https://coin.example/home", x: "examplecoin" });
  assert.equal(CC.sourcesOf({ website: "https://dexscreener.com/robinhood/0x1" }).website, null, "a chart page is not the project's site");
});

await t("readClaims end to end (fake fetch, X not connected): sources, claims, the model off", async () => {
  const fetch = async (u) => (u.startsWith("https://coin.example") ? { ok: true, status: 200, url: SITE, type: "text/html", text: HTML } : { ok: false, status: 404 });
  const r = await CC.readClaims(A, { token: { website: "coin.example", twitter: "examplecoin" }, deps: { fetch, xPosts: async () => ({ error: "X is not connected here" }) } });
  assert.equal(r.model, false);
  assert.ok(r.sources.find((x) => x.kind === "website").ok);
  assert.equal(r.sources.find((x) => x.kind === "x").ok, false);
  assert.ok(r.claims.length >= 8);
  assert.ok(r.siteLinks.includes("https://skynet.certik.com/projects/example"));
});

/* ---------- verifying each type ---------- */
const ck = (key, status, detail) => ({ key, status, label: key, detail });
const gatePass = { checks: [ck("sell", "pass", "Selling back returns 0.0098 ETH"), ck("tax", "pass", "None detected")] };
const gateTax = { checks: [ck("sell", "pass", "ok"), ck("tax", "fail", "About 12.0% is lost on transfer")] };
const ponsCurve = { curve: "0x1111111111111111111111111111111111111111", graduated: false, fees: { creatorTaxBps: 0 } };
const base = { address: A, gate: gatePass, assay: { status: "done", flags: [], dev: { liquidityPulledPct: 0 } }, health: { owner: null, ownerRenounced: null, functions: { owner: [] }, proxy: null }, pons: null, supply: { total: 1e9, dead: 0, zero: 0 }, dexPairs: 2, siteLinks: [] };
const claim = (type, extra = {}) => ({ type, quote: `fixture ${type} claim`, url: SITE, ...extra });
const v1 = async (c, f = {}, fetch) => (await CC.verifyClaims([c], { ...base, ...f }, { deps: { fetch: fetch || (async () => ({ ok: false, status: 0, why: "offline" })) } }))[0];

await t("lp: proven on a Pons curve, contradicted when the dev pulled liquidity, unverified otherwise", async () => {
  assert.equal((await v1(claim("lp"), { pons: ponsCurve })).status, "proven");
  assert.equal((await v1(claim("lp"), { assay: { status: "done", dev: { liquidityPulledPct: 12 }, flags: [{ key: "lp-pulled", level: "red" }] } })).status, "contradicted");
  assert.equal((await v1(claim("lp"))).status, "unverified");
  assert.equal((await v1(claim("lp"), { pons: { ...ponsCurve, graduated: true } })).status, "unverified");
});
await t("renounced: proven (owner() is dead / no owner function), contradicted (live owner, upgradeable proxy), unverified", async () => {
  assert.equal((await v1(claim("renounced"), { health: { owner: "0x000000000000000000000000000000000000dEaD", ownerRenounced: true } })).status, "proven");
  assert.equal((await v1(claim("renounced"))).status, "proven", "no owner() at all");
  assert.equal((await v1(claim("renounced"), { health: { owner: "0x2222222222222222222222222222222222222222", ownerRenounced: false } })).status, "contradicted");
  assert.equal((await v1(claim("renounced"), { health: { owner: null, proxy: { type: "EIP-1967 upgradeable proxy", implementation: "0x3" } } })).status, "contradicted");
  assert.equal((await v1(claim("renounced"), { health: null })).status, "unverified");
});
await t("tax: proven (no tax measured), contradicted (12% measured), unverified (not measured)", async () => {
  const r = await v1(claim("tax", { value: 0 }), { pons: ponsCurve });
  assert.equal(r.status, "proven"); assert.match(r.evidence, /1% Pons trading fee/);
  assert.equal((await v1(claim("tax", { value: 0 }), { gate: gateTax })).status, "contradicted");
  assert.equal((await v1(claim("tax", { value: 12 }), { gate: gateTax })).status, "proven");
  assert.equal((await v1(claim("tax", { value: 0 }), { gate: { checks: [ck("tax", "skip", "Not measured")] } })).status, "unverified");
});
await t("supply: proven, proven as minted for Pons after burns, contradicted, unverified", async () => {
  assert.equal((await v1(claim("supply", { value: 1e9 }))).status, "proven");
  assert.equal((await v1(claim("supply", { value: 1e9 }), { supply: { total: 9.5e8 }, pons: ponsCurve })).status, "proven");
  assert.equal((await v1(claim("supply", { value: 1e12 }))).status, "contradicted");
  assert.equal((await v1(claim("supply", { value: 1e9 }), { supply: null })).status, "unverified");
});
await t("burn: proven, contradicted, unverified", async () => {
  assert.equal((await v1(claim("burn", { value: 50 }), { supply: { total: 1e9, dead: 5e8, zero: 0 } })).status, "proven");
  assert.equal((await v1(claim("burn", { value: 50 }), { supply: { total: 1e9, dead: 1e7, zero: 0 } })).status, "contradicted");
  assert.equal((await v1(claim("burn", { value: 50 }), { supply: null })).status, "unverified");
});
await t("audit: proven when a known auditor's page answers and names the contract, contradicted on a dead link, else unverified", async () => {
  const links = ["https://skynet.certik.com/projects/example"];
  const ok = async () => ({ ok: true, status: 200, url: links[0], text: `Example audit for ${A.toLowerCase()}` });
  assert.equal((await v1(claim("audit", { target: "CertiK" }), { siteLinks: links }, ok)).status, "proven");
  assert.equal((await v1(claim("audit", { target: "CertiK" }), { siteLinks: links }, async () => ({ ok: false, status: 404 }))).status, "contradicted");
  assert.equal((await v1(claim("audit", { target: "CertiK" }), { siteLinks: links }, async () => ({ ok: true, status: 200, url: links[0], text: "some other project" }))).status, "unverified");
  assert.equal((await v1(claim("audit", { target: "CertiK" }))).status, "unverified", "no report link");
  assert.equal((await v1(claim("audit", { target: "CertiK" }), { siteLinks: ["https://certik-fake.example/report"] }, ok)).status, "unverified", "not an auditor domain");
});
await t("team and partner: always unverified", async () => {
  assert.equal((await v1(claim("team"))).status, "unverified");
  assert.equal((await v1(claim("partner", { target: "Robinhood" }))).status, "unverified");
});
await t("live: proven (2xx), contradicted (404), unverified (no link or unreachable)", async () => {
  assert.equal((await v1(claim("live", { target: "https://app.coin.example/" }), {}, async () => ({ ok: true, status: 200, url: "https://app.coin.example/" }))).status, "proven");
  assert.equal((await v1(claim("live", { target: "https://app.coin.example/" }), {}, async () => ({ ok: false, status: 404 }))).status, "contradicted");
  assert.equal((await v1(claim("live", { target: "https://app.coin.example/" }))).status, "unverified");
  assert.equal((await v1(claim("live"))).status, "unverified");
});
await t("listing: DexScreener proven / contradicted / unverified; CoinGecko needs a link that names the contract", async () => {
  assert.equal((await v1(claim("listing", { target: "dexscreener" }))).status, "proven");
  assert.equal((await v1(claim("listing", { target: "dexscreener" }), { dexPairs: 0 })).status, "contradicted");
  assert.equal((await v1(claim("listing", { target: "dexscreener" }), { dexPairs: null })).status, "unverified");
  assert.equal((await v1(claim("listing", { target: "coingecko" }))).status, "unverified");
  const cg = "https://www.coingecko.com/en/coins/example";
  assert.equal((await v1(claim("listing", { target: "coingecko" }), { siteLinks: [cg] }, async () => ({ ok: true, status: 200, url: cg, text: `contract ${A}` }))).status, "proven");
});
await t("every verified claim keeps its exact words and URL", async () => {
  const out = await CC.verifyClaims([claim("lp"), claim("team")], base);
  assert.ok(out.every((c) => c.quote && c.url === SITE && ["proven", "contradicted", "unverified"].includes(c.status) && c.evidence));
});

/* ---------- the claims part in the score ---------- */
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const pg = { verdict: "passed", word: "passed", checkedAt: NOW, checks: [ck("route", "pass", "ok"), ck("impact", "pass", "0.4%"), ck("depth", "pass", "12 ETH"), ck("fee", "pass", "0.3%"), ck("sim", "pass", "ok"), ck("sell", "pass", "Selling back returns 0.0098 ETH"), ck("tax", "pass", "None detected"), ck("ring", "pass", "No ring pattern."), ck("devlinks", "pass", "The dev side holds 1%")] };
const coin = (claims) => ({ address: A, kind: "coin", symbol: "GOOD", now: NOW, gate: pg, ring: { verdict: "clear", reasons: [] }, assay: { status: "done", flags: [] }, token: { liquidityUsd: 150000, holders: 1200, priceUsd: 0.0001 },
  heel: { kind: "coin", severity: "none", partial: false, heel: "No weak spot", facts: [] }, clash: { clash: false, count: 1, ticker: "GOOD", others: [] }, bornAt: NOW - 10 * 86400e3, claims });
const src = { website: SITE, x: null, sources: [{ kind: "website", url: SITE, ok: true }], model: false };
const v = (type, status, evidence = "chain says so") => ({ type, quote: `the ${type} words`, url: SITE, status, evidence });

await t("a contradicted key claim (liquidity locked, but the dev pulled it) caps the score at 35 and leads the reasons", () => {
  const r = C.scoreCheck(coin({ ...src, verified: [v("lp", "contradicted", "The Assay: the dev wallet removed liquidity worth 12.00% of the supply from a pool."), v("tax", "proven")] }));
  assert.ok(r.score <= C.CAPS.claimFalse, `score ${r.score}`);
  assert.equal(r.reasons[0].part, "claims");
  assert.match(r.headline, /It claims "the lp words", but the chain shows otherwise/);
  const p = r.parts.find((x) => x.key === "claims");
  assert.equal(p.claims[0].quote, "the lp words"); assert.equal(p.claims[0].url, SITE);
});
await t("claims all proven: full points; a contradicted product link lowers it but does not cap", () => {
  const ok = C.scoreCheck(coin({ ...src, verified: [v("renounced", "proven"), v("tax", "proven")] }));
  assert.equal(ok.parts.find((x) => x.key === "claims").value, 1);
  const dead = C.scoreCheck(coin({ ...src, verified: [v("live", "contradicted"), v("tax", "proven")] }));
  assert.ok(!dead.caps.some((c) => c.at === C.CAPS.claimFalse), "not the 35 cap (a dead product link is no key claim)");
  assert.equal(dead.parts.find((x) => x.key === "claims").value, 0.5);
});
await t("no site known: n/a; site unreachable: not read; nothing claimed: n/a. None of them count", () => {
  assert.equal(C.claimsPart({ website: null, x: null, sources: [] }).status, "n/a");
  assert.equal(C.claimsPart({ website: SITE, sources: [{ kind: "website", url: SITE, ok: false, why: "answered 503" }] }).status, "not read");
  assert.equal(C.claimsPart({ ...src, verified: [] }).status, "n/a");
  assert.equal(C.WEIGHTS.claims, 8);
  assert.equal(Object.values(C.WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

/* ---------- the fetcher's guards ---------- */
await t("SSRF: only public http(s) on 80/443, no credentials, no private, loopback, link-local or metadata addresses", () => {
  for (const bad of ["file:///etc/passwd", "ftp://coin.example/", "javascript:alert(1)", "data:text/html,hi", "gopher://x.example/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://100.64.0.1/", "http://0.0.0.0/", "http://localhost/", "http://router.local/", "https://coin.example:8443/", "https://user:pw@coin.example/", "http://intranet/"])
    assert.equal(CC.allowedUrl(bad), null, bad);
  assert.ok(CC.allowedUrl("https://coin.example/path?q=1"));
  assert.ok(CC.allowedUrl("coin.example"));
  assert.ok(CC.allowedUrl("http://8.8.8.8/"));
  assert.ok(CC.privateIp("::ffff:10.1.2.3")); assert.ok(!CC.privateIp("1.1.1.1")); assert.ok(CC.privateIp("not-an-ip"));
});
await t("SSRF: a hostname that resolves to a private address is refused at connect time", async () => {
  const err = await new Promise((r) => CC._test.guardedLookup("localhost", {}, (e) => r(e)));
  assert.equal(err?.code, "EBLOCKED");
});
await t("redirects: at most 3 followed, and a redirect into a private address is refused", async () => {
  let n = 0;
  const loop = async (u) => ({ status: 302, headers: { location: `https://coin.example/r${++n}` } });
  const r = await CC.safeFetch("https://coin.example/", { request: loop });
  assert.equal(r.ok, false); assert.equal(r.why, "too many redirects"); assert.equal(n, 4, "the first request plus 3 redirects");
  const jump = async (u) => (u.hostname === "coin.example" ? { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } } : { status: 200, headers: {}, text: "secret" });
  const j = await CC.safeFetch("https://coin.example/", { request: jump });
  assert.equal(j.ok, false); assert.equal(j.why, "address not allowed");
  const two = async (u) => (u.pathname === "/" ? { status: 302, headers: { location: "/a" } } : u.pathname === "/a" ? { status: 302, headers: { location: "/b" } } : { status: 200, headers: { "content-type": "text/html" }, text: "<p>ok</p>" });
  const ok = await CC.safeFetch("https://coin.example/", { request: two });
  assert.equal(ok.ok, true); assert.equal(ok.url, "https://coin.example/b");
});
await t("size cap, timeout and no scripts run (local test server, lookup pinned to it for this test only)", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 3000);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<script>globalThis.PWNED = true</script>${"x".repeat(2_000_000)}`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const pin = (h, o, cb) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
  try {
    const big = await CC._test.once(new URL(`http://test.example:${port}/`), { max: 100_000, timeoutMs: 2000, accept: "*/*", lookup: pin });
    assert.equal(big.cut, true); assert.ok(big.text.length <= 100_000);
    assert.equal(globalThis.PWNED, undefined, "fetched script never runs");
    const slow = await CC._test.once(new URL(`http://test.example:${port}/slow`), { max: 1000, timeoutMs: 500, accept: "*/*", lookup: pin });
    assert.equal(slow.status, 0); assert.equal(slow.why, "timed out");
    // and without the pin, the real guard refuses the same local server
    const blocked = await CC._test.once(new URL(`http://localhost:${port}/`), { max: 1000, timeoutMs: 2000, accept: "*/*" });
    assert.equal(blocked.why, "address not allowed");
  } finally { srv.close(); }
});

/* ---------- the track record ---------- */
const H = 3600e3, DAY = 24 * H;
const row = (addr, score, at, track) => ({ address: addr, kind: "coin", score, at, track });
await t("tracking: one per coin per 24 hours, no price left out, not-sellable kept, stocks and unscored never tracked", () => {
  const r0 = row(A, 30, NOW, null);
  assert.deepEqual(C.trackOf(r0, { priceUsd: 0.002 }, []), { status: "watching", p0: 0.002 });
  assert.deepEqual(C.trackOf(r0, { priceUsd: null }, []), { status: "no-price" });
  assert.equal(C.trackOf(r0, { notSellable: true, priceUsd: null }, []).notSellable, true);
  assert.deepEqual(C.trackOf(row(A, 30, NOW + H), { priceUsd: 1 }, [row(A, 30, NOW, { status: "watching", p0: 1 })]), { status: "dup" });
  assert.equal(C.trackOf(row(A, 30, NOW + DAY + 1), { priceUsd: 1 }, [row(A, 30, NOW, { status: "graded", p0: 1 })]).status, "watching");
  assert.equal(C.trackOf({ ...r0, kind: "stock" }, { priceUsd: 1 }, []), null);
  assert.equal(C.trackOf({ ...r0, score: null }, { priceUsd: 1 }, []), null);
});
await t("grading: 1 h price, then up / down / zero (≤10% or no price) / not sellable at 24 h", async () => {
  const g = async (p0, p24, extra = {}) => { const r = row(A, 40, NOW, { status: "watching", p0, ...extra }); await C.gradeStep(r, NOW + H, async () => p0 * 1.1); await C.gradeStep(r, NOW + DAY, async () => p24); return r.track; };
  const up = await g(1, 1.5); assert.equal(up.result, "up"); assert.equal(up.p1h, 1.1);
  assert.equal((await g(1, 0.5)).result, "down");
  assert.equal((await g(1, 0.1)).result, "zero");
  assert.equal((await g(1, null)).result, "zero");
  assert.equal((await g(null, null, { notSellable: true })).result, "not-sellable");
  const early = row(A, 40, NOW, { status: "watching", p0: 1 });
  assert.equal(await C.gradeStep(early, NOW + 10 * 60e3, async () => 2), false, "nothing before 1 hour");
});
await t("record: buckets by score band, every graded check counted, −100% for zero-without-price and not sellable, small samples flagged", () => {
  const T = (result, p0, p24h) => ({ status: "graded", result, p0, p24h });
  const rows = [
    row("0x01", 10, NOW, T("zero", 1, null)), row("0x02", 12, NOW, T("not-sellable", null, null)), row("0x03", 20, NOW, T("down", 1, 0.5)),
    row("0x04", 30, NOW, T("up", 1, 2)), row("0x05", 40, NOW, T("down", 1, 0.8)),
    row("0x06", 80, NOW, T("up", 1, 1.2)), row("0x07", 90, NOW, { status: "watching", p0: 1 }),
    row("0x08", 90, NOW, { status: "dup" }), row("0x09", 90, NOW, { status: "no-price" }), { address: "0x10", kind: "stock", score: null, at: NOW, track: null },
  ];
  const r = C.recordOf(rows, NOW);
  const b = Object.fromEntries(r.buckets.map((x) => [x.band, x]));
  assert.equal(b["0-24"].graded, 3); assert.equal(b["0-24"].wentToZero, 2); assert.equal(b["0-24"].zeroPct, 66.7); assert.equal(b["0-24"].median24h, -100);
  assert.equal(b["25-49"].graded, 2); assert.equal(b["25-49"].median24h, 40);
  assert.equal(b["50-74"].graded, 0); assert.equal(b["50-74"].zeroPct, null);
  assert.equal(b["75-100"].graded, 1); assert.equal(b["75-100"].watching, 1); assert.equal(b["75-100"].tracked, 2, "dup and no-price rows left out");
  assert.equal(r.graded, 6);
  assert.ok(r.buckets.every((x) => x.smallSample));
  assert.match(r.note, /Only 6 checks graded so far/);
  assert.match(r.rules, /nothing is picked/);
});

/* ---------- X: never "not enough read" ---------- */
await t("X answer: a coin with no score gets no reply (silent, logged); a score, a stock or an unknown address gets one", () => {
  const none = C.xAnswer({ address: A, kind: "coin", score: null, label: "Not enough read", headline: "Too few checks" });
  assert.equal(none.reply, null); assert.equal(none.silent, true);
  assert.match(C.xAnswer({ address: A, kind: "coin", symbol: "GOOD", score: 31, label: "Risky", headline: "Thin liquidity: $900." }).reply, /^\$GOOD: risky \(31\/100\)/);
  assert.match(C.xAnswer({ address: A, kind: "stock", symbol: "NVDA", score: null, label: "Tokenized stock" }).reply, /tokenized stock/);
  assert.ok(C.xAnswer({ address: A, kind: "unknown", score: null, headline: "There is no contract at this address" }).reply);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
