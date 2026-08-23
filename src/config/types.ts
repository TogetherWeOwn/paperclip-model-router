import type { ModelEntry, ModelTier } from "../engine/types.js";

/**
 * The per-company configuration contract.
 *
 * Every field here is something that legitimately differs between companies on
 * one Paperclip instance. Nothing in this file may be hardcoded in the engine:
 * the acceptance test for this plugin is that a second company gets correct,
 * different behaviour with no code change, and this interface is the whole of
 * the surface that makes that true.
 */
export interface RouterConfig {
  routing: RoutingConfig;
  providers: ProvidersConfig;
  models: ModelEntry[];
  taskClasses: TaskClassConfig[];
  tiering: TieringConfig;
  budget: BudgetConfig;
  quotaGate: QuotaGateConfig;
  rule0: Rule0Config;
}

export interface RoutingConfig {
  /** Master switch. `false` makes every decision `disabled` and changes nothing. */
  enabled: boolean;
  /**
   * `advise` records a decision and returns it to the caller.
   * `enforce` additionally lets the worker apply the model where the host
   * permits it. Both modes record; only `enforce` writes.
   */
  mode: "advise" | "enforce";
  /** Model used when the table yields nothing and the company wants a floor rather than a failure. */
  fallbackModelId: string | null;
  /**
   * Keep the model already used on an issue unless a gate forces a change.
   * Switching models mid-task destroys the prompt cache; see docs/decisions/0003.
   */
  stickyModelWithinIssue: boolean;
}

export interface ProvidersConfig {
  /** Providers this company is allowed to be served by. Intersected with each model's `providers`. */
  permitted: string[];
  /** Tie-break order among permitted providers. Earlier is preferred. */
  preferenceOrder: string[];
  /**
   * Claude pay-as-you-go. While `false`, no Claude-family model may resolve to
   * anything other than `claudeFamilyProvider`.
   */
  claudePaygEnabled: boolean;
  /** The single provider Claude-family models are permitted to use. */
  claudeFamilyProvider: string;
  /** Family names treated as Claude for the purposes of the Claude block. */
  claudeFamilies: string[];
}

export interface TaskClassConfig {
  key: string;
  /** Minimum model quality accepted for this class. Hard floor, never traded against cost. */
  qualityFloor: number;
  /** Optional ceiling. Stops a cheap class from reaching for a frontier model. */
  maxTier?: ModelTier;
  /** Capabilities every task in this class needs, added to the descriptor's own. */
  requiredCapabilities?: string[];
  /** Operator pin for the whole class. */
  pinnedModelId?: string;
}

export interface TieringConfig {
  /** Per-signal weights. Score = sum(signal value * weight). */
  signalWeights: Record<string, number>;
  /** Score at or above which each tier is reached. Evaluated highest-first. */
  thresholds: Record<ModelTier, number>;
  /** Tier used when the descriptor carries no signals at all. */
  defaultTier: ModelTier;
}

export interface BudgetConfig {
  /** The company's own monthly ceiling in USD. Informational for the engine. */
  monthlyCapUsd: number;
  /** Fraction of the cap at which the decision is annotated but unchanged. */
  warnFraction: number;
  /** Fraction of the cap at which the tier ceiling drops one step. */
  downshiftFraction: number;
  /** Fraction of the cap at which non-pinned model work is refused. */
  haltFraction: number;
}

export interface QuotaGateConfig {
  enabled: boolean;
  /** teamclaude status endpoint. Differs per host; never a loopback assumption. */
  statusUrl: string;
  /**
   * Paperclip secret holding the teamclaude API key. Stored as a secret
   * reference, never as a value. The repo never contains the key itself.
   */
  apiKeySecretRef: SecretRef | null;
  /** Utilization windows to read. Values are fractions in [0,1]; 1.0 means exhausted. */
  windows: string[];
  warnUtilization: number;
  downshiftUtilization: number;
  pauseUtilization: number;
}

export interface Rule0Config {
  /**
   * The cheapest call is the one never made. When a task summary matches one of
   * these patterns, the engine answers `no-model-needed` and names the tool.
   */
  enabled: boolean;
  deterministicPatterns: Array<{ pattern: string; tool: string }>;
}

/** `format: "secret-ref"` binding object, as submitted by the Paperclip secret picker. */
export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
}
