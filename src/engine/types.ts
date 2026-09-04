export type ModelTier = "small" | "standard" | "strong" | "frontier";

export const MODEL_TIER_ORDER: readonly ModelTier[] = [
  "small",
  "standard",
  "strong",
  "frontier",
];

export type ModelCapability =
  | "tools"
  | "structured-output"
  | "vision"
  | "long-context"
  | "computer-use";

export interface ModelEntry {
  id: string;
  tier: ModelTier;
  quality: number;
  costPerMTokIn: number;
  costPerMTokOut: number;
  contextWindow: number;
  capabilities: ModelCapability[];
  /** Capacity telemetry lane labels associated with this opaque model id. */
  providers: string[];
  enabled: boolean;
}

export interface TaskDescriptor {
  taskClass?: string;
  summary?: string;
  requiredCapabilities?: ModelCapability[];
  requiredContextTokens?: number;
  signals?: Record<string, number>;
  issueId?: string;
  requestedProfile?: string;
  requestedModelId?: string;
  servingModelId?: string;
  servingProvider?: string;
  servingAccount?: string;
  pinnedModelId?: string;
  pinReason?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface RuntimeSignals {
  budgetSpentFraction?: number;
  capacityLanes?: import("../capacity/types.js").CapacityLane[];
  capacityError?: string;
  servingModelId?: string;
  servingProvider?: string;
  servingAccount?: string;
  stickyModelId?: string;
}

export type DecisionOutcome =
  | "no-model-needed"
  | "selected"
  | "no-eligible-model"
  | "disabled";

export type RejectionStage =
  | "disabled"
  | "not-in-table"
  | "capability"
  | "context-window"
  | "quality-floor"
  | "tier-ceiling"
  | "capacity"
  | "budget-gate";

export interface Rejection {
  modelId: string;
  stage: RejectionStage;
  reason: string;
}

export interface Candidate {
  modelId: string;
  tier: ModelTier;
  quality: number;
  expectedCostUsd: number;
  provider: string | null;
  account: string | null;
  usagePosture: import("../capacity/types.js").CapacityLane["posture"] | "not-evaluated";
  utilization: number | null;
  resetsAt: string | null;
}

export interface RoutingDecision {
  outcome: DecisionOutcome;
  modelId: string | null;
  requestedTier: ModelTier | null;
  effectiveTier: ModelTier | null;
  taskClass: string | null;
  qualityFloor: number | null;
  trace: string[];
  rejections: Rejection[];
  candidates: Candidate[];
  pin: { modelId: string; reason: string; honored: boolean } | null;
  fallbackUsed: boolean;
  capacity: {
    mode: "disabled" | "shadow" | "enforce";
    telemetry: "available" | "unavailable" | "not-configured";
    selectedProvider: string | null;
    selectedAccount: string | null;
    usagePosture: import("../capacity/types.js").CapacityLane["posture"] | "not-evaluated";
    utilization: number | null;
    resetsAt: string | null;
    shadowModelId: string | null;
    shadowProvider: string | null;
    shadowAccount: string | null;
    decisionReason: string;
    servingModelId: string | null;
    servingProvider: string | null;
    servingAccount: string | null;
    fallbackEvents: string[];
  };
  gates: { budget: GateLevel };
}

export type GateLevel = "ok" | "warn" | "downshift" | "halt";
