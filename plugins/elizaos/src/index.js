// @troyaagent/plugin-elizaos: Troya's read-only checks for Robinhood Chain (4663) as ElizaOS actions.
// Built against the @elizaos/core 2.x Plugin / Action interface: actions with typed `parameters` (filled by the planner
// and handed to the handler as options.parameters), a handler that returns an ActionResult and also answers through the
// callback. When no parameters come in (an older planner), the handler reads addresses and amounts from the message text.
// Read only: no action trades, signs or sends anything, and none needs a private key.
import { createTroyaClient, runTool, toolByKey } from "@troyaagent/sdk";

const ADDR_G = /0x[0-9a-fA-F]{40}/g;
const CHAINS = { robinhood: "robinhood", rh: "robinhood", "robinhood chain": "robinhood", base: "base", arbitrum: "arbitrum", arb: "arbitrum", ethereum: "ethereum", eth_mainnet: "ethereum", mainnet: "ethereum" };

const addrs = (t) => String(t || "").match(ADDR_G) || [];
const ethAmount = (t) => { const m = /(\d+(?:\.\d+)?)\s*(?:e|eth)\b/i.exec(String(t || "")); return m ? Number(m[1]) : undefined; };
function jsonIn(t) {
  const s = String(t || ""), i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}
// what each action can read from plain text when the planner sent no parameters
const FROM_TEXT = {
  gate_check: (t) => ({ token: addrs(t)[0], amountEth: ethAmount(t), signed: /\bsigned|attest/i.test(t) || undefined }),
  weak_spot: (t) => ({ address: addrs(t)[0] }),
  real_depth: (t) => ({ token: addrs(t)[0] || (/\$([A-Za-z0-9]{2,15})\b/.exec(t) || [])[1] }),
  agent_passport: (t) => ({ address: addrs(t)[0], agentId: (/agent\s*(?:id\s*)?#?\s*(\d{1,9})\b/i.exec(t) || [])[1] }),
  bridge_safety: (t) => {
    const low = String(t || "").toLowerCase(), found = [];
    for (const m of low.matchAll(/\b(robinhood chain|robinhood|rh|base|arbitrum|arb|ethereum|mainnet)\b/g)) { const c = CHAINS[m[1]]; if (c && found[found.length - 1] !== c) found.push(c); }
    const toIdx = low.search(/\bto\s+(robinhood|rh|base|arbitrum|arb|ethereum|mainnet)\b/);
    let from = found[0], to = found[1];
    if (found.length === 1) { if (toIdx >= 0) { to = found[0]; from = to === "robinhood" ? "base" : "robinhood"; } else { from = found[0]; to = from === "robinhood" ? "base" : "robinhood"; } }
    return { from, to, amount: ethAmount(t), token: addrs(t)[0] };
  },
  trident_check: (t) => {
    const j = jsonIn(t);
    if (j && typeof j === "object") return j.types && j.primaryType ? { typedData: j } : { from: j.from, to: j.to, data: j.data || j.input, value: j.value, typedData: j.typedData };
    return {};
  },
};

const ACTIONS = [
  { key: "gate_check", name: "TROYA_GATE_CHECK", similes: ["CHECK_TOKEN_SAFETY", "HONEYPOT_CHECK", "PRE_TRADE_CHECK", "TROYA_GATE"],
    routingHint: "before buying or recommending a Robinhood Chain coin -> TROYA_GATE_CHECK with its address; checks only, never buys",
    example: "Is 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074 safe to buy with 0.05 ETH?" },
  { key: "trident_check", name: "TROYA_TRIDENT_CHECK", similes: ["CHECK_TRANSACTION", "TX_FIREWALL", "APPROVAL_CHECK", "SIGNATURE_CHECK"],
    routingHint: "a Robinhood Chain transaction or EIP-712 signature request about to be signed -> TROYA_TRIDENT_CHECK; it never signs",
    example: 'Check this tx before I sign: {"from":"0x57b09Fe6dab0a7D3776E56e6388c773d6c4D09E4","to":"0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074","data":"0x095ea7b3…","value":"0"}' },
  { key: "bridge_safety", name: "TROYA_BRIDGE_SAFETY", similes: ["BRIDGE_ROUTE_SAFETY", "SAFE_BRIDGE", "SCYLLA"],
    routingHint: "moving ETH between Robinhood Chain and Base/Arbitrum/Ethereum -> TROYA_BRIDGE_SAFETY to score routes; it never bridges",
    example: "What's the safest way to bridge 0.2 ETH from Base to Robinhood Chain?" },
  { key: "agent_passport", name: "TROYA_AGENT_PASSPORT", similes: ["AGENT_REPUTATION", "CHECK_AGENT", "AGENT_PASSPORT", "TROYA_BOW"],
    routingHint: "another AI agent's wallet or ERC-8004 id, before trusting its calls or paying it -> TROYA_AGENT_PASSPORT",
    example: "Can I trust the agent at 0x45611870017682Ec781EDb9F71fA72fA91159350?" },
  { key: "weak_spot", name: "TROYA_WEAK_SPOT", similes: ["TOKEN_RISK", "DEV_RISK", "TROYA_HEEL"],
    routingHint: "what is the biggest risk of a Robinhood Chain coin, dev wallet or agent -> TROYA_WEAK_SPOT",
    example: "What's the weak spot of 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074?" },
  { key: "real_depth", name: "TROYA_REAL_DEPTH", similes: ["REAL_LIQUIDITY", "WASH_VOLUME_CHECK", "TROYA_SIRENS"],
    routingHint: "is a Robinhood Chain coin's liquidity or volume real -> TROYA_REAL_DEPTH",
    example: "How deep is the liquidity of 0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074 really, and is the volume wash?" },
];

const setting = (runtime, k) => { try { const v = runtime?.getSetting?.(k); return v == null || v === "" ? undefined : v; } catch { return undefined; } };
const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/**
 * Make the plugin. options.client: a ready @troyaagent/sdk client; otherwise one is made per runtime from the
 * TROYA_API_KEY, TROYA_BASE_URL and TROYA_TIMEOUT_MS settings (all optional).
 */
/** @param {{ client?: import("@troyaagent/sdk").TroyaClient, clientOptions?: import("@troyaagent/sdk").TroyaClientOptions }} [options] */
export function createTroyaPlugin(options = {}) {
  const clients = new WeakMap();
  const clientFor = (runtime) => {
    if (options.client) return options.client;
    const key = [setting(runtime, "TROYA_API_KEY"), setting(runtime, "TROYA_BASE_URL"), setting(runtime, "TROYA_TIMEOUT_MS")].map((x) => (x == null ? "" : String(x))).join("|");
    const hit = runtime && typeof runtime === "object" ? clients.get(runtime) : null;
    if (hit && hit.key === key) return hit.client;
    const [apiKey, baseUrl, timeoutMs] = key.split("|");
    const client = createTroyaClient({ ...(options.clientOptions || {}), apiKey: apiKey || options.clientOptions?.apiKey, baseUrl: baseUrl || options.clientOptions?.baseUrl, timeoutMs: Number(timeoutMs) || options.clientOptions?.timeoutMs });
    if (runtime && typeof runtime === "object") clients.set(runtime, { key, client });
    return client;
  };

  /** @type {import("@elizaos/core").Action[]} */
  const actions = ACTIONS.map((a) => {
    const tool = /** @type {import("@troyaagent/sdk").TroyaTool} */ (toolByKey(a.key));
    /** @type {import("@elizaos/core").Action} */
    const action = {
      name: a.name,
      similes: a.similes,
      description: tool.description,
      descriptionCompressed: `${tool.title} (read only, Robinhood Chain 4663)`,
      routingHint: a.routingHint,
      contexts: ["crypto", "wallet", "finance"],
      parameters: Object.entries(tool.params).map(([name, p]) => ({ name, description: p.description, required: !!p.required, schema: { type: p.type } })),
      validate: async () => true,
      handler: async (runtime, message, _state, opts, callback) => {
        const text = String(message?.content?.text || "");
        const given = clean(opts && typeof opts === "object" ? opts.parameters : null);
        const args = { ...clean(FROM_TEXT[a.key](text)), ...given };
        const r = await runTool(clientFor(runtime), a.key, args);
        if (callback) { try { await callback({ text: r.text, actions: [a.name], source: message?.content?.source }); } catch {} }
        if (r.ok === false) return { success: false, text: r.text, error: r.text, data: { actionName: a.name, troyaError: r.error } };
        const verdict = r.data.verdict ?? r.data.standing ?? r.data.severity;
        return { success: true, text: r.text, data: { actionName: a.name, troya: r.data }, values: { troyaLastCheck: a.key, troyaVerdict: verdict == null ? null : String(verdict) } };
      },
      examples: [[
        { name: "{{name1}}", content: { text: a.example } },
        { name: "{{agentName}}", content: { text: `Running ${tool.title}.`, actions: [a.name] } },
      ]],
    };
    return action;
  });

  /** @type {import("@elizaos/core").Plugin} */
  const plugin = {
    name: "troya",
    description: "Troya for agents: read-only safety checks on Robinhood Chain (chain 4663) from https://troya.codes. Gate pre-trade check, Trident transaction firewall, Scylla bridge safety, Bow agent passport, Heel weak spot and Sirens real depth. Never trades or signs.",
    config: { TROYA_API_KEY: null, TROYA_BASE_URL: null, TROYA_TIMEOUT_MS: null },
    actions,
  };
  return plugin;
}

/** The plugin with default settings: add it to your character's plugins. */
export const troyaPlugin = createTroyaPlugin();
export const ACTION_NAMES = ACTIONS.map((a) => a.name);
export default troyaPlugin;
