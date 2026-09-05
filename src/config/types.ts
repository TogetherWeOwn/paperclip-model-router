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
}

export interface RoutingConfig {
  enabled: boolean;
  mode: "advise" | "enforce";
  fallbackModelId: string | null;
  stickyModelWithinIssue: boolean;
  maxOutputTokens: number;
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
  sources: CapacitySourceConfig[];
}

export interface Rule0Config {
  enabled: boolean;
  deterministicPatterns: Array<{ pattern: string; tool: string }>;
}

export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
  projectionClass?: "unclassified" | "class_3_static_lease";
  projectionAllowlistKey?: string | null;
}
