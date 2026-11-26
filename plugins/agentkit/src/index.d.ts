import { ActionProvider, type Action, type WalletProvider, type Network } from "@coinbase/agentkit";
import type { TroyaClient, TroyaClientOptions } from "@troyaagent/sdk";

export type TroyaActionProviderOptions = TroyaClientOptions & { client?: TroyaClient };

export declare const ACTION_NAMES: readonly (
  | "troya_gate_check" | "troya_trident_check" | "troya_bridge_safety" | "troya_agent_passport" | "troya_weak_spot" | "troya_real_depth"
)[];

/** The Troya actions as plain AgentKit actions (also usable with customActionProvider). invoke returns a JSON string. */
export declare function troyaActions(options?: TroyaActionProviderOptions): Action[];

export declare class TroyaActionProvider extends ActionProvider<WalletProvider> {
  constructor(options?: TroyaActionProviderOptions);
  readonly options: TroyaActionProviderOptions;
  readonly actions: Action[];
  getActions(walletProvider?: WalletProvider): Action[];
  supportsNetwork(network?: Network): boolean;
}

export declare const troyaActionProvider: (options?: TroyaActionProviderOptions) => TroyaActionProvider;
export default troyaActionProvider;
