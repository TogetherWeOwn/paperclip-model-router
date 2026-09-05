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
  /**
   * Per-model wall-clock budget for one generation, overriding
   * `upstream.requestTimeoutMs` when this model is selected. Absent means
   * inherit. A reasoning model needs minutes where the rest of the table needs
   * seconds, and one shared ceiling cannot be right for both (TOG-1035).
   */
  requestTimeoutMs?: number;
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
  pinnedModelId?: string;
  pinReason?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface RuntimeSignals {
  budgetSpentFraction?: number;
  capacityEvidence?: import("../capacity/types.js").CapacityEvidence[];
  capacityError?: string;
  servingModelId?: string;
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
  capacitySource: string | null;
  laneLabel: string | null;
  usagePosture: import("../capacity/types.js").CapacityEvidence["posture"] | "not-evaluated";
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
    selectedSource: string | null;
    selectedLaneLabel: string | null;
    usagePosture: import("../capacity/types.js").CapacityEvidence["posture"] | "not-evaluated";
    utilization: number | null;
    resetsAt: string | null;
    shadowModelId: string | null;
    shadowSource: string | null;
    shadowLaneLabel: string | null;
    decisionReason: string;
    servingModelId: string | null;
    fallbackEvents: string[];
  };
  gates: { budget: GateLevel };
}

export type GateLevel = "ok" | "warn" | "downshift" | "halt";
