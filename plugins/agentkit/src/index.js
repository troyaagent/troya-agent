// @troyaagent/agentkit: Troya's read-only checks for Robinhood Chain (4663) as a Coinbase AgentKit ActionProvider.
// The provider overrides getActions() and hands AgentKit plain { name, description, schema (zod), invoke } actions, so it
// needs no decorators or reflect-metadata. The actions never use the wallet provider: nothing here trades, signs or
// sends, whatever wallet the agent runs with. troyaActions() returns the same actions for customActionProvider().
import { ActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { createTroyaClient, runTool, TOOLS } from "@troyaagent/sdk";

/** AgentKit action names (snake case, as AgentKit's own actions are). */
export const ACTION_NAMES = TOOLS.map((t) => `troya_${t.key}`);

function schemaOf(tool) {
  const shape = {};
  for (const [name, p] of Object.entries(tool.params)) {
    let s = p.type === "number" ? z.coerce.number() : p.type === "boolean" ? z.boolean() : z.string();
    s = s.describe(p.description);
    shape[name] = p.required ? s : s.optional();
  }
  return z.object(shape);
}

/**
 * The Troya actions as plain AgentKit actions: [{ name, description, schema, invoke(args) → string }].
 * options: a ready @troyaagent/sdk `client`, or client options (apiKey, baseUrl, timeoutMs, fetch).
 * Each invoke returns a JSON string: { ok, summary, result } or { ok:false, summary, error }.
 */
export function troyaActions(options = {}) {
  const client = options.client || createTroyaClient(options);
  return TOOLS.map((tool) => ({
    name: `troya_${tool.key}`,
    description: tool.description,
    schema: schemaOf(tool),
    invoke: async (args) => {
      const r = await runTool(client, tool.key, args || {});
      return JSON.stringify(r.ok ? { ok: true, summary: r.text, result: r.data } : { ok: false, summary: r.text, error: r.error });
    },
  }));
}

/** Troya for AgentKit: AgentKit.from({ walletProvider, actionProviders: [troyaActionProvider()] }). */
export class TroyaActionProvider extends ActionProvider {
  constructor(options = {}) {
    super("troya", []);
    this.options = options;
    this.actions = troyaActions(options);
  }
  /** The wallet provider is ignored on purpose: every Troya action is read only. */
  getActions(_walletProvider) { return this.actions; }
  /** Troya reads Robinhood Chain over HTTP, whatever network the agent's wallet is on. */
  supportsNetwork(_network) { return true; }
}

export const troyaActionProvider = (options = {}) => new TroyaActionProvider(options);
export default troyaActionProvider;
