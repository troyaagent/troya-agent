import type { Plugin } from "@elizaos/core";
import type { TroyaClient, TroyaClientOptions } from "@troyaagent/sdk";

export interface TroyaPluginOptions {
  /** A ready @troyaagent/sdk client. Without it, one is made per runtime from TROYA_API_KEY / TROYA_BASE_URL / TROYA_TIMEOUT_MS. */
  client?: TroyaClient;
  /** Defaults for the client made from settings. */
  clientOptions?: TroyaClientOptions;
}

export declare function createTroyaPlugin(options?: TroyaPluginOptions): Plugin;
export declare const troyaPlugin: Plugin;
export declare const ACTION_NAMES: readonly (
  | "TROYA_GATE_CHECK" | "TROYA_TRIDENT_CHECK" | "TROYA_BRIDGE_SAFETY" | "TROYA_AGENT_PASSPORT" | "TROYA_WEAK_SPOT" | "TROYA_REAL_DEPTH"
)[];
export default troyaPlugin;
