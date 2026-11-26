// Types for @troyaagent/sdk. The client is read only: nothing here builds, signs or sends a transaction.

export declare const VERSION: string;
export declare const DEFAULT_BASE_URL: "https://troya.codes";
export declare const CHAIN_ID: 4663;
/** $TROYA on Robinhood Chain. */
export declare const TROYA_TOKEN: "0x1FA81ddaAAc83240803B3F2d20595E40Edc1a074";
export declare const NOTICE: string;

export type TroyaErrorCode =
  | "BAD_INPUT" | "UNAUTHORIZED" | "PAYMENT_REQUIRED" | "RATE_LIMITED" | "UNAVAILABLE" | "HTTP_ERROR"
  | "TIMEOUT" | "ABORTED" | "NETWORK" | "BAD_RESPONSE" | "CONFIG" | "MCP_ERROR";

export declare class TroyaError extends Error {
  name: "TroyaError";
  code: TroyaErrorCode;
  /** HTTP status, 0 when no answer came back (timeout, network, bad input caught before the call). */
  status: number;
  url: string | null;
  body: unknown;
  /** On a 402 from the signed Gate check: price, pay-to address and how to pay. */
  payment: { price: Record<string, unknown>; payTo: string; howToPay: string[]; docs?: string } | null;
}

export interface TroyaClientOptions {
  /** Default https://troya.codes */
  baseUrl?: string;
  /** A Troya API token (troya_…). Only sent to the signed Gate check. */
  apiKey?: string;
  /** Per-call timeout in ms (default 30000; slower routes use at least 45000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  userAgent?: string;
}
export interface CallOptions { signal?: AbortSignal }

export type GateVerdict = "passed" | "caution" | "failed" | "untested";
export interface GateCheckItem { key: string; status: "pass" | "warn" | "fail" | "skip" | string; label?: string; detail: string }

export interface GateCheckResult {
  kind: "gate"; signed: false; chainId: 4663;
  token: string; symbol: string | null; name: string | null; amountEth: number;
  verdict: GateVerdict; reason: string | null; pass: boolean; checks: GateCheckItem[];
  quote: null | {
    amountOut: string | null; minOut: string | null; priceImpactPct: number | null; feePct: number | null;
    route: string | null; venue: string | null; poolLiquidityEth: number | null; poolLiquidityUsd: number | null; ethUsd: number | null; warnings: string[];
  };
  checkedAt: number; source: string;
}

export interface SignedGateResult {
  attested: {
    v: 1; chainId: 4663; token: string; symbol: string | null; amountEth: number; verdict: GateVerdict; reason: string | null;
    checks: { key: string; status: string; detail: string }[];
    quote: null | { amountOut: string; minOut: string; priceImpactPct: number | null; feePct: number | null; route: string | null };
    assay: null | { flags?: { key: string; level: "red" | "amber" | string; title: string; detail: string }[]; devHoldsPct?: number | null; devSoldPct?: number | null; top10Pct?: number | null; status?: string };
    checkedAt: number;
  };
  hash: string; signature: string; attestor: string;
  paid: { by: "free" | "credit"; freeLeftToday?: number; costUsdg?: number; balanceUsdg?: number; wallet: string | null; via: string };
}

export interface TridentRequest {
  chainId?: number | string; from?: string; to?: string; data?: string; value?: string | number | bigint;
  authorizationList?: { address?: string; contractAddress?: string }[];
  typedData?: Record<string, unknown> | string;
}
export interface TridentResult {
  verdict: "allow" | "warn" | "block" | "unsupported"; chainId: number;
  reasons: { level: "block" | "warn" | "info"; code: string; text: string }[];
  coins?: { token: string; symbol: string; verdict: string }[];
  summary?: string; checkedAt?: number;
  signed?: { hash: string; signature: string; attestor: string };
}

export interface BridgeSafetyQuery { from?: string | number; to?: string | number; amount?: number | string; token?: string; address?: string; signal?: AbortSignal }
export interface ScyllaRoute {
  id: string; source: "troya" | "lifi"; tools: string[]; score: number; band: "green" | "amber" | "red"; weakest: string;
  redLines: { key: string; cap: number; from: string; [k: string]: unknown }[]; warnings: string[]; tags: string[];
  toAmount: string; toAmountMin: string; valueLostPct: number | null; seconds: number | null; contract: string | null; [k: string]: unknown;
}
export interface BridgeSafetyResult {
  name: "Troya Scylla"; rubric: string; from: { id: number; name: string }; to: { id: number; name: string }; amountEth: number; amountWei: string;
  token: Record<string, unknown> | null; gate: { verdict: string; passed?: number; total?: number; why?: string } | null;
  routes: ScyllaRoute[]; primaryNote: string | null; listNote: string | null; storm: { level: string; warnings: string[]; lastRun: number | null };
  chain: Record<string, unknown> | null; checkedAt: number; limit: string; receipt?: { hash: string; signature: string; attestor: string };
  [k: string]: unknown;
}

export interface PassportResult {
  name: "Troya Bow"; address: string | null; agentId: string | number | null; label: string | null; kind: string;
  standing: string; summary: string; counts: Record<string, number>;
  stamps: { key: string; title: string; text: string; evidence: { type: string; ref: string; url?: string; note?: string }[] }[];
  warnings: unknown[]; partial?: boolean; signed?: { hash: string; signature: string; attestor: string }; [k: string]: unknown;
}
export interface WeakSpotResult {
  address: string; kind: "coin" | "dev" | "agent" | "unknown"; heel: string | null; severity: string | null; score?: number; confidence: string | null;
  facts: { text: string; evidence: { type: string; ref: string; url?: string; note?: string }; confidence: string; source: string; key: string; severity: string }[];
  guard?: unknown; coverage: { source: string; status: string; note?: string }[]; partial: boolean; checkedAt: number; [k: string]: unknown;
}
export interface RealDepthResult {
  coin: { address: string; symbol: string; name: string; decimals: number; [k: string]: unknown } | null;
  partial: boolean;
  depth: { status: string; headline?: string; venues?: unknown[]; missing?: unknown[]; [k: string]: unknown };
  volume: { status: string; headline?: string; raw?: unknown; honest?: unknown; removedPct?: number; [k: string]: unknown };
  family: { status: string; headline?: string; [k: string]: unknown };
  method?: unknown; checkedAt: number;
}

export interface TroyaClient {
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  request<T = unknown>(method: "GET" | "POST", path: string, opts?: { query?: Record<string, unknown>; body?: unknown; auth?: boolean; timeout?: number; signal?: AbortSignal }): Promise<T>;
  /** Free, unsigned Troya Gate (GET /api/swap/gate). The built swap transaction is never returned. */
  gateCheck(token: string, opts?: { amountEth?: number; from?: string; slippagePct?: number; signal?: AbortSignal }): Promise<GateCheckResult>;
  /** Signed Troya Gate (GET /api/gate/v1/check/:token): free daily allowance, then USDG credit; 402 → TroyaError PAYMENT_REQUIRED. */
  signedGateCheck(token: string, opts?: { amountEth?: number; from?: string; assay?: boolean; preferCredit?: boolean; signal?: AbortSignal }): Promise<SignedGateResult>;
  verifyGateResult(result: { attested: object; signature: string }, opts?: CallOptions): Promise<{ genuine: boolean; hash: string; signer: string | null; attestor: string; ageSeconds: number | null }>;
  gateInfo(opts?: CallOptions): Promise<Record<string, unknown>>;
  gateCredits(address: string, opts?: CallOptions): Promise<{ address: string; balanceUsdg: number; checksLeft: number; freePerDay: number; freeLeftToday: number; holder: boolean; deposits: unknown[] }>;
  x402Info(opts?: CallOptions): Promise<Record<string, unknown>>;
  /** Reads the 402 PAYMENT-REQUIRED requirements for one x402-paid signed check. Signs and pays nothing. */
  x402Requirements(token: string, opts?: { amountEth?: number; signal?: AbortSignal }): Promise<{ status: number; resource?: string; required: any; body?: unknown }>;
  tridentCheck(req: TridentRequest, opts?: CallOptions): Promise<TridentResult>;
  bridgeSafety(q?: BridgeSafetyQuery): Promise<BridgeSafetyResult>;
  agentPassport(target: string | number | { address?: string; agentId?: string | number }, opts?: { agentId?: string | number; signal?: AbortSignal }): Promise<PassportResult>;
  weakSpot(address: string, opts?: { waitMs?: number; signal?: AbortSignal }): Promise<WeakSpotResult>;
  realDepth(token: string, opts?: { waitMs?: number; signal?: AbortSignal }): Promise<RealDepthResult>;
  mcp<T = unknown>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
}

export declare function createTroyaClient(options?: TroyaClientOptions): TroyaClient;
export declare function gateVerdict(checks: GateCheckItem[]): { verdict: GateVerdict; reason: string | null };

export type TroyaToolKey = "gate_check" | "trident_check" | "bridge_safety" | "agent_passport" | "weak_spot" | "real_depth";
export interface TroyaToolParam { type: "string" | "number" | "boolean"; description: string; required?: boolean }
export interface TroyaTool {
  key: TroyaToolKey; title: string; description: string;
  params: Record<string, TroyaToolParam>;
  run(client: TroyaClient, args: Record<string, unknown>): Promise<unknown>;
  summarize(result: any): { text: string; data: Record<string, unknown> };
}
export declare const TOOLS: TroyaTool[];
export declare function toolByKey(key: string): TroyaTool | undefined;
export type ToolRun =
  | { ok: true; text: string; data: Record<string, unknown> }
  | { ok: false; text: string; error: { code: string; status?: number; message?: string; payment?: unknown } };
export declare function runTool(client: TroyaClient, key: TroyaToolKey | string, args?: Record<string, unknown>): Promise<ToolRun>;
