/**
 * Types for the routing engine.
 *
 * The engine is a pure function of (task descriptor, company config, runtime
 * signals) -> decision. It performs no I/O, so it is exhaustively testable and
 * it cannot behave differently in one company than another for reasons other
 * than that company's configuration.
 */

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

/** One row of a company's model tier table. */
export interface ModelEntry {
  /** The model id Paperclip names. OmniRoute resolves this to a provider. */
  id: string;
  /** Family grouping. `claude` is special-cased by the Claude block. */
  family: string;
  tier: ModelTier;
  /** 0-100 quality score on this company's scale. Compared against quality floors. */
  quality: number;
  /** USD per million input tokens, at the price this company actually pays. */
  costPerMTokIn: number;
  /** USD per million output tokens, at the price this company actually pays. */
  costPerMTokOut: number;
  contextWindow: number;
  capabilities: ModelCapability[];
  /**
   * Providers that may serve this model. Intersected with
   * `providers.permitted`; an empty intersection rejects the model.
   */
  providers: string[];
  enabled: boolean;
}

/** What the caller knows about the work before a model is chosen. */
export interface TaskDescriptor {
  /** Free-text task class key, matched against `taskClasses[].key`. */
  taskClass?: string;
  /** Human summary used only for the Rule 0 deterministic-tooling match. */
  summary?: string;
  /** Capabilities the task genuinely requires. Hard gate — not a preference. */
  requiredCapabilities?: ModelCapability[];
  /** Tokens of context the task needs to hold. Hard gate. */
  requiredContextTokens?: number;
  /** Signals used to score the task into a tier. */
  signals?: Record<string, number>;
  /** Issue this decision is for, used for cache-preserving stickiness. */
  issueId?: string;
  /** Operator or agent pin. Respected, and recorded with its reason. */
  pinnedModelId?: string;
  pinReason?: string;
  /** Estimated tokens, used to rank survivors by expected cost. */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

/** Runtime facts the engine cannot derive itself. Supplied by the worker. */
export interface RuntimeSignals {
  /** Fraction of the company's monthly budget already spent, 0..1. */
  budgetSpentFraction?: number;
  /** Highest teamclaude utilization across the configured windows, 0..1. */
  claudeQuotaUtilization?: number;
  /** Model already used on this issue, if any. Enables cache-preserving stickiness. */
  stickyModelId?: string;
}

export type DecisionOutcome =
  /** Rule 0: deterministic tooling answers this; no model call at all. */
  | "no-model-needed"
  /** A model was selected. */
  | "selected"
  /** Nothing survived the gates. The caller must escalate, not silently downgrade. */
  | "no-eligible-model"
  /** Routing is switched off for this company; the caller keeps its default. */
  | "disabled";

export type RejectionStage =
  | "disabled"
  | "not-in-table"
  | "capability"
  | "context-window"
  | "claude-block"
  | "provider-not-permitted"
  | "quality-floor"
  | "tier-ceiling"
  | "quota-gate"
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
  /** Expected USD for this task at the descriptor's token estimates. */
  expectedCostUsd: number;
}

export interface RoutingDecision {
  outcome: DecisionOutcome;
  /** Selected model id, when `outcome === "selected"`. */
  modelId: string | null;
  /** Tier the task scored into, before any gate lowered it. */
  requestedTier: ModelTier | null;
  /** Tier actually allowed after budget and quota pressure. */
  effectiveTier: ModelTier | null;
  taskClass: string | null;
  qualityFloor: number | null;
  /** Ordered, human-readable account of how the decision was reached. */
  trace: string[];
  /** Every model considered and why it was dropped. */
  rejections: Rejection[];
  /** Survivors, cheapest first. The head is the selection. */
  candidates: Candidate[];
  /** Set when a pin was applied, with the reason it was applied. */
  pin: { modelId: string; reason: string; honored: boolean } | null;
  /** Gate levels in force at decision time. */
  gates: {
    budget: GateLevel;
    claudeQuota: GateLevel;
  };
}

/**
 * Pressure levels. `ok` -> no effect, `warn` -> recorded only,
 * `downshift` -> tier ceiling lowered one step, `halt` -> the class of work
 * this gate governs is refused.
 */
export type GateLevel = "ok" | "warn" | "downshift" | "halt";
