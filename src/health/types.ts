/**
 * Why an overlay and not the config: `ctx.config` is read-only to a plugin
 * (`PluginConfigClient` exposes `get` only), so a scheduled probe cannot flip
 * `enabled` in the operator's model table. It records health in company-scoped
 * plugin state instead, and selection reads the overlay on top of the table.
 * The operator's `enabled: false` always wins — the probe can take a model out
 * of service, never put one back into service against the operator's wish.
 */

/** A model-level verdict. Catalogue presence is only reachability metadata;
 * `healthy` and `degraded` require real invocation evidence. `unknown` keeps a
 * fresh or probationary model routable without claiming it works. */
export type HealthVerdict = "healthy" | "degraded" | "dead" | "unknown";

export interface ModelHealthEntry {
  verdict: HealthVerdict;
  /** ISO timestamp of the catalogue reconciliation that last touched the row. */
  checkedAt: string;
  /** Operator-readable reason, e.g. "two consecutive invocation failures". */
  reason: string;
  /** Consecutive catalogue-absence observations. Kept separate from invocation
   * evidence so an upstream outage cannot silently become model absence. */
  strikes: number;
  /** Consecutive routed calls that failed after selecting this model. */
  failureStreak: number;
  /** Consecutive routed calls that completed after selecting this model. */
  successStreak: number;
  /** ISO timestamp of the most recent routed call observed for this model. */
  lastInvocationAt: string | null;
  /** ISO timestamp at which the current degraded verdict began. */
  degradedAt: string | null;
}

export type ModelHealthState = Record<string, ModelHealthEntry>;

/** The outcome of one catalogue probe, before it is folded into stored health. */
export interface CatalogueProbe {
  /** `null` when the probe was indeterminate — transport failed, the upstream
   * refused to talk, or the payload was not a catalogue we understand. In that
   * case no model may be marked dead. */
  modelIds: Set<string> | null;
  /** Operator-readable description of what happened. */
  detail: string;
  /** HTTP status, when there was one. */
  status: number | null;
}

/** One flip the probe decided to make, for the activity log. */
export interface HealthFlip {
  modelId: string;
  from: HealthVerdict;
  to: HealthVerdict;
  reason: string;
}
