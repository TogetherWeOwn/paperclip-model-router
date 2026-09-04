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
  enabled: boolean;
}

export interface TaskDescriptor {
  taskClass?: string;
  summary?: string;
  requiredCapabilities?: ModelCapability[];
  requiredContextTokens?: number;
  signals?: Record<string, number>;
  issueId?: string;
  pinnedModelId?: string;
  pinReason?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface RuntimeSignals {
  budgetSpentFraction?: number;
  stickyModelId?: string;
  degradedModelIds?: ReadonlySet<string>;
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
  gates: { budget: GateLevel };
}

export type GateLevel = "ok" | "warn" | "downshift" | "halt";
