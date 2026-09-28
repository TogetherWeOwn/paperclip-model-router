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
  /**
   * TOG-3419: caps `maxOutputTokens` on the synchronous `/invoke` path only,
   * so an unreachable request is rejected in milliseconds instead of running
   * until `SYNC_BUDGET_CEILING_MS` cuts it off. Absent means derive a default
   * from this model's effective request timeout and the throughput baseline
   * in `config/upstream-constraints.ts`. `model_router_invoke_async` ignores
   * this field entirely.
   */
  maxSyncOutputTokens?: number;
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
  /**
   * TOG-7417: the worker pre-resolves this before calling selectModel — a
   * host-injected authoritative fraction (tool/action context) wins over the
   * caller-supplied `task.signals.budgetSpentFraction`, which any caller can
   * forge. The engine only moves the warn/downshift/halt gates; it cannot
   * tell the two sources apart.
   */
  budgetSpentFraction?: number;
  capacityEvidence?: import("../capacity/types.js").CapacityEvidence[];
  capacityError?: string;
  /**
   * TOG-7885 (G8): age of the capacity snapshot the worker served this
   * decision from, in wall-clock ms (null = none stored). The engine does
   * NOT re-derive staleness from a timestamp — the worker computes it once
   * against `capacityRouting.maxSnapshotAgeMs` and hands both down, so the
   * metric, the record, and the decision can never disagree about it.
   */
  capacitySnapshotAgeMs?: number | null;
  capacitySnapshotStale?: boolean;
  servingModelId?: string;
  stickyModelId?: string;
  /**
   * TOG-2139 (slice 6): per-lane pace verdicts computed by the worker from the
   * same source documents the capacity evidence came from, keyed by lane id.
   * Consumed only when `capacityRouting.paceOrdering` is true; a missing or
   * `unknown` verdict is fail-neutral and never excludes a model.
   */
  paceVerdicts?: Record<string, import("../capacity/types.js").LanePaceVerdict>;
  /**
   * Maps model id -> lane id for pace lookup. Derived from
   * `capacityRouting.sources[].pace.laneId` over `sources[].modelIds`.
   */
  modelLaneByPace?: Record<string, string>;
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
  /** TOG-2139: pace state of this model's lane when `paceOrdering` is on. */
  paceState: import("../capacity/types.js").PaceState | "not-evaluated";
  /** TOG-2139: utilisation − elapsed deviation of the governing window, when known. */
  paceDeviation: number | null;
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
    /**
     * True when capacity telemetry was expected but missing or unparseable and
     * the router served anyway on the static routing policy (TOG-1040). The
     * decision is real; it is simply not capacity-aware.
     */
    degraded: boolean;
    /**
     * TOG-7885 (G8): age of the capacity snapshot the worker served this
     * decision from, in wall-clock ms. Surfaced so a reviewer forcing a
     * stale snapshot sees the staleness on the decision itself. Null when
     * capacity routing is disabled or no snapshot was ever stored.
     */
    snapshotAgeMs: number | null;
    /**
     * TOG-7885 (G8): true when `snapshotAgeMs` exceeds
     * `capacityRouting.maxSnapshotAgeMs` (or no snapshot exists while
     * capacity routing is enabled). The alertable boolean behind the
     * degraded-age counter and the decision-record rollup.
     */
    snapshotStale: boolean;
    servingModelId: string | null;
    fallbackEvents: string[];
  };
  gates: { budget: GateLevel };
}

export type GateLevel = "ok" | "warn" | "downshift" | "halt";
