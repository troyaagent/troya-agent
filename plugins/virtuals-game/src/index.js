// @troyaagent/game-plugin: Troya's read-only checks for Robinhood Chain (4663) as Virtuals GAME functions and a worker,
// in the shape of the official game-node plugins (a class with one getter per GameFunction and getWorker()).
// GAME hands every argument over as a string; the shared tool layer turns numbers and booleans back.
// Read only: no function trades, signs or sends anything, and none needs a private key.
import { GameWorker, GameFunction, ExecutableGameFunctionResponse, ExecutableGameFunctionStatus } from "@virtuals-protocol/game";
import { createTroyaClient, runTool, TOOLS, toolByKey } from "@troyaagent/sdk";

const MAX_FEEDBACK = 3500;   // keep the feedback the GAME planner reads short enough to stay useful

const HINTS = {
  gate_check: "Call before buying or recommending any Robinhood Chain coin. Use the coin's 0x address, not its ticker.",
  trident_check: "Call before signing any Robinhood Chain transaction or EIP-712 signature request.",
  bridge_safety: "Call before moving ETH between Robinhood Chain and Base, Arbitrum or Ethereum.",
  agent_passport: "Call before trusting another agent's calls or paying it.",
  weak_spot: "Call to learn the single biggest risk of a coin, dev wallet or agent.",
  real_depth: "Call to learn whether a coin's liquidity and volume are real before sizing a trade.",
};

export class TroyaPlugin {
  /**
   * options: id, name, description (of the worker), client (a ready @troyaagent/sdk client) or clientOptions
   * (apiKey, baseUrl, timeoutMs, fetch).
   */
  constructor(options = {}) {
    this.id = options.id || "troya_worker";
    this.name = options.name || "Troya Worker";
    this.description = options.description || "Checks Robinhood Chain (chain 4663) coins, transactions, bridge routes and other agents with Troya (https://troya.codes) before the agent acts: Gate pre-trade check, Trident transaction firewall, Scylla bridge safety, Bow agent passport, Heel weak spot and Sirens real depth. Read only: it never trades or signs.";
    this.client = options.client || createTroyaClient(options.clientOptions || {});
  }

  /** Build one GameFunction for a Troya tool key. */
  makeFunction(key) {
    const tool = toolByKey(key);
    if (!tool) throw new Error(`Unknown Troya tool ${key}`);
    return new GameFunction({
      name: `troya_${tool.key}`,
      description: tool.description,
      hint: HINTS[tool.key],
      args: Object.entries(tool.params).map(([name, p]) => ({ name, description: p.description, type: p.type, optional: !p.required })),
      executable: async (args, logger) => {
        logger?.(`${tool.title}: ${JSON.stringify(args).slice(0, 200)}`);
        const r = await runTool(this.client, tool.key, args || {});
        let feedback = r.ok ? `${r.text}\nresult: ${JSON.stringify(r.data)}` : r.text;
        if (feedback.length > MAX_FEEDBACK) feedback = feedback.slice(0, MAX_FEEDBACK) + "… (cut)";
        return new ExecutableGameFunctionResponse(r.ok ? ExecutableGameFunctionStatus.Done : ExecutableGameFunctionStatus.Failed, feedback);
      },
    });
  }

  get gateCheckFunction() { return this.makeFunction("gate_check"); }
  get tridentCheckFunction() { return this.makeFunction("trident_check"); }
  get bridgeSafetyFunction() { return this.makeFunction("bridge_safety"); }
  get agentPassportFunction() { return this.makeFunction("agent_passport"); }
  get weakSpotFunction() { return this.makeFunction("weak_spot"); }
  get realDepthFunction() { return this.makeFunction("real_depth"); }
  /** Every Troya function. */
  get functions() { return TOOLS.map((t) => this.makeFunction(t.key)); }

  /** A GameWorker with every Troya function (or the ones you pass) for a GameAgent's workers list. */
  getWorker(data = {}) {
    return new GameWorker({
      id: this.id,
      name: this.name,
      description: this.description,
      functions: data.functions || this.functions,
      getEnvironment: data.getEnvironment || (async () => ({ troya: this.client.baseUrl, chain: "Robinhood Chain (4663)", readOnly: true })),
    });
  }
}

export const FUNCTION_NAMES = TOOLS.map((t) => `troya_${t.key}`);
export default TroyaPlugin;
