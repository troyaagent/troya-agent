#!/usr/bin/env node
// Troya Rail: an MCP gateway between your AI agent and Robinhood's agentic trading MCP (or any MCP server).
// It runs on your machine, holds no keys and never sees your Robinhood login: the upstream command (by default
// mcp-remote, which signs you in to Robinhood in your own browser) does that. Read tools pass straight through.
// Every other tool call is checked by Troya first against the policy you set in the app (orders on or off, a limit
// per order and per day, a symbol allowlist and block list, market hours, buys only, and the kill switch); Troya signs
// each decision and keeps it in your audit log. If Troya cannot be reached, orders are refused (it fails closed).
//
//   claude mcp add robinhood-rail -e TROYA_API_KEY=troya_… -- npx -y @troyaagent/rail
//   npx -y @troyaagent/rail -- <any upstream MCP command>      (default: npx -y mcp-remote https://agent.robinhood.com/mcp/trading)
//
//   TROYA_API_KEY   your API token from the Troya app (Agent → Wallet → API tokens); without it every order is refused
//   TROYA_BASE_URL  default https://troya.codes          RAIL_NAME  a name for this rail in your audit log (default "rail")
// Not affiliated with or endorsed by Robinhood.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const VERSION = "0.1.0";
const BASE = (process.env.TROYA_BASE_URL || "https://troya.codes").replace(/\/+$/, "").replace(/\/(agent\/)?api$/, "");
const KEY = process.env.TROYA_API_KEY || "";
const NAME = String(process.env.RAIL_NAME || "rail").slice(0, 40);
const sep = process.argv.indexOf("--");
const upstreamCmd = sep >= 0 ? process.argv.slice(sep + 1) : ["npx", "-y", "mcp-remote", "https://agent.robinhood.com/mcp/trading"];
const log = (...a) => process.stderr.write(`[troya-rail] ${a.join(" ")}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// the same split as the server: read tools pass, everything else asks Troya
const READ_TOOL = /^(get|list|search|read|fetch|view|lookup|find|describe|quote|show)[_-]?/i;
const isRead = (name, ann) => ann?.readOnlyHint === true || (READ_TOOL.test(name) && !/place|submit|execute/i.test(name));

const tools = new Map();                 // name → annotations, from the upstream's tools/list
const listIds = new Set();               // ids of tools/list requests, to read their answers
const pending = new Map();               // upstream request id → { decision id } for allowed calls

const up = spawn(upstreamCmd[0], upstreamCmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
up.on("exit", (code) => { log(`upstream exited (${code})`); process.exit(code ?? 0); });
up.on("error", (e) => { log(`could not start the upstream: ${e.message}`); process.exit(1); });
const toUp = (msg) => up.stdin.write(JSON.stringify(msg) + "\n");

async function troya(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY, "user-agent": `troya-rail/${VERSION}`, "x-troya-client": "rail" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const refuse = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

// from the agent
createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "tools/list" && msg.id != null) listIds.add(msg.id);
  if (msg.method !== "tools/call" || msg.id == null) return toUp(msg);
  const name = String(msg.params?.name || ""), args = msg.params?.arguments || {};
  if (isRead(name, tools.get(name))) return toUp(msg);
  if (!KEY) return refuse(msg.id, `Troya Rail refused "${name}": no TROYA_API_KEY is set, so the rail cannot check this call. Create a token in the Troya app (Agent → Wallet → API tokens).`);
  try {
    const d = await troya("/api/rail/check", { tool: name, args, annotations: tools.get(name) || null, rail: NAME });
    if (!d.allow) return refuse(msg.id, `Troya Rail refused "${name}":\n- ${d.reasons.join("\n- ")}\nDecision ${d.id}, signed by Troya (hash ${d.receipt?.hash || "–"}). Change limits or the kill switch in the Troya app: ${BASE}/agent#/rail`);
    pending.set(msg.id, { decision: d.id });
    toUp(msg);
  } catch (e) {
    refuse(msg.id, `Troya Rail refused "${name}": Troya could not be reached (${e.message}), and the rail fails closed for anything that is not a read.`);
  }
});

// from the upstream (Robinhood's MCP through mcp-remote, or any MCP server)
createInterface({ input: up.stdout }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
  if (msg.id != null && listIds.has(msg.id) && Array.isArray(msg.result?.tools)) {
    listIds.delete(msg.id);
    for (const t of msg.result.tools) {
      tools.set(t.name, t.annotations || null);
      if (!isRead(t.name, t.annotations)) t.description = `${t.description || ""} [Guarded by Troya Rail: checked against your limits, allowlist and kill switch before it runs.]`.trim();
    }
  }
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    const text = (msg.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 300);
    troya("/api/rail/report", { id: p.decision, ok: !msg.error && !msg.result?.isError, summary: msg.error ? `error: ${msg.error.message || ""}` : text }).catch(() => {});
  }
  send(msg);
});
log(`v${VERSION} guarding: ${upstreamCmd.join(" ")}${KEY ? "" : " (no TROYA_API_KEY: orders will be refused)"}`);
