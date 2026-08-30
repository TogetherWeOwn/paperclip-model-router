/**
 * Why an overlay and not the config: `ctx.config` is read-only to a plugin
 * (`PluginConfigClient` exposes `get` only), so a scheduled probe cannot flip
 * `enabled` in the operator's model table. It records health in company-scoped
 * plugin state instead, and selection reads the overlay on top of the table.
 * The operator's `enabled: false` always wins — the probe can take a model out
 * of service, never put one back into service against the operator's wish.
 */

/** A model-level verdict. `unknown` is a deliberate third state: an indeterminate
 * probe must never be read as "dead", which is what would mass-disable a table
 * the first time the upstream had a bad minute. */
export type HealthVerdict = "healthy" | "dead" | "unknown";

export interface ModelHealthEntry {
  verdict: HealthVerdict;
  /** ISO timestamp of the probe that last produced a definitive verdict. */
  checkedAt: string;
  /** Operator-readable reason, e.g. "absent from the upstream catalogue". */
  reason: string;
  /** Consecutive definitive-dead observations. A model is only taken out of
   * service once this reaches the configured threshold, so one flaky catalogue
   * read cannot black out the cheap tier. */
  strikes: number;
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
