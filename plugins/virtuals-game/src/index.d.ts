import { GameWorker, GameFunction } from "@virtuals-protocol/game";
import type { TroyaClient, TroyaClientOptions, TroyaToolKey } from "@troyaagent/sdk";

export interface TroyaPluginOptions {
  id?: string;
  name?: string;
  description?: string;
  client?: TroyaClient;
  clientOptions?: TroyaClientOptions;
}

export declare class TroyaPlugin {
  constructor(options?: TroyaPluginOptions);
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly client: TroyaClient;
  makeFunction(key: TroyaToolKey): GameFunction<any>;
  get gateCheckFunction(): GameFunction<any>;
  get tridentCheckFunction(): GameFunction<any>;
  get bridgeSafetyFunction(): GameFunction<any>;
  get agentPassportFunction(): GameFunction<any>;
  get weakSpotFunction(): GameFunction<any>;
  get realDepthFunction(): GameFunction<any>;
  get functions(): GameFunction<any>[];
  getWorker(data?: { functions?: GameFunction<any>[]; getEnvironment?: () => Promise<Record<string, any>> }): GameWorker;
}

export declare const FUNCTION_NAMES: readonly (
  | "troya_gate_check" | "troya_trident_check" | "troya_bridge_safety" | "troya_agent_passport" | "troya_weak_spot" | "troya_real_depth"
)[];
export default TroyaPlugin;
