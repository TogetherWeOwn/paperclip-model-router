import type { CapacitySourceConfig } from "../capacity/types.js";
import type { ModelEntry, ModelTier } from "../engine/types.js";

export type CompatibleUpstreamProtocol =
  | "openai-chat-completions"
  | "anthropic-messages";

export interface RouterConfig {
  routing: RoutingConfig;
  upstream: CompatibleUpstreamConfig;
  models: ModelEntry[];
  taskClasses: TaskClassConfig[];
  tiering: TieringConfig;
  budget: BudgetConfig;
  capacityRouting: CapacityRoutingConfig;
  rule0: Rule0Config;
  /**
   * TOG-7897: visible decision-history window. Physical pruning also
   * preserves the current UTC accounting month for spend-cap enforcement.
   * `query-decisions` only returns rows inside the history window.
   */
  decisionLog: DecisionLogConfig;
}

export interface RoutingConfig {
  enabled: boolean;
  mode: "advise" | "enforce";
  fallbackModelId: string | null;
  stickyModelWithinIssue: boolean;
  maxOutputTokens: number;
  /**
   * TOG-3551 (scope 3): model ids that must never be honored as a pin, whatever
   * the routing mode or capacity evidence. This is the operator-maintained list
   * of known-unserved / payment_required ids (e.g. deepseek-v4-flash,
   * qwen3.8-max, cliproxy/* label pins, devin payment_required ids) that a
   * label-only pin must not resurrect. Empty by default — the guard ships inert
   * until an operator populates it.
   */
  pinBlocklist: string[];
}

export interface CompatibleUpstreamConfig {
  protocol: CompatibleUpstreamProtocol | null;
  baseUrl: string;
  credentialSecretRef: SecretRef | null;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  extraHeaders: Record<string, string>;
}

export interface TaskClassConfig {
  key: string;
  qualityFloor: number;
  maxTier?: ModelTier;
  requiredCapabilities?: string[];
  pinnedModelId?: string;
}

export interface TieringConfig {
  signalWeights: Record<string, number>;
  thresholds: Record<ModelTier, number>;
  defaultTier: ModelTier;
}

export interface BudgetConfig {
  monthlyCapUsd: number;
  warnFraction: number;
  downshiftFraction: number;
  haltFraction: number;
}

export interface CapacityRoutingConfig {
  enabled: boolean;
  mode: "shadow" | "enforce";
  /**
   * What absent capacity evidence means in `enforce` mode.
   *
   * - `fail-open` (default): absence of evidence never denies service. A model
   *   with missing or unknown evidence ranks last but stays selectable, and a
   *   payload the router cannot parse degrades routing to the static policy.
   *   Only evidence that positively reports `unavailable` excludes a model.
   * - `exclude-lane`: drop models without usable evidence, refuse only if none remain.
   * - `fail-closed`: refuse the decision outright. Strictly opt-in since TOG-1040.
   */
  unknownTelemetry: "fail-open" | "fail-closed" | "exclude-lane";
  conserveUtilization: number;
  avoidUtilization: number;
  maxSnapshotAgeMs: number;
  /**
   * TOG-2139 (slice 6): order eligible candidates by subscription pace — the
   * lane furthest BEHIND its governing-window pace line wins, deviation next,
   * then the existing evidence ordering. Within the survivor pool only: pace
   * never reorders across `qualityFloor`, capability, context-window, or tier
   * gates. In enforce mode, a positive serviceability-window trip is rejected
   * by the existing capacity gate, including pins, stickiness and fallback.
   * Off by default.
   */
  paceOrdering: boolean;
  /**
   * Policy for pace evaluation. Falls back to the shared package defaults
   * (margin 0.1, 24h urgent reset, 15min snapshot age) when absent.
   */
  pacePolicy?: { margin?: number; urgentResetSeconds?: number; maxSnapshotAgeSeconds?: number };
  sources: CapacitySourceConfig[];
}

/**
 * Lane-document definition for pace evaluation on a capacity source
 * (TOG-1916 §2 shape: records[] with per-account windows). Structurally the
 * shared package's `LanePaceDefinition`; the resolver fills the defaults the
 * JSON schema leaves optional. A health-only lane may carry an empty windows
 * array; it yields an explicit `unknown` verdict until utilization telemetry
 * appears. A source without a pace block is also fail-neutral — its models rank
 * `unknown`, never denied, exactly like missing telemetry today.
 */
export type SourcePaceDefinition = import("../capacity/types.js").LanePaceDefinition;

/**
 * TOG-7897: `retentionDays` bounds visible history. Pruning and legacy import
 * preserve the earlier of this cutoff and the current UTC month start;
 * `query-decisions` never returns rows outside the history window.
 */
export interface DecisionLogConfig {
  retentionDays: number;
}

export interface Rule0Pattern {
  pattern: string;
  tool: string;
  /**
   * TOG-7881 (G2): compiled once at config resolution (`resolveConfig`),
   * so the engine never constructs a regex per request and invalid config
   * fails closed at load instead of silently never matching. Survives the
   * harness's `structuredClone`; never persisted — it is rebuilt from
   * `pattern` on every resolve.
   */
  regex: RegExp;
}

export interface Rule0Config {
  enabled: boolean;
  deterministicPatterns: Rule0Pattern[];
}

export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
  projectionClass?: "unclassified" | "class_3_static_lease";
  projectionAllowlistKey?: string | null;
}
