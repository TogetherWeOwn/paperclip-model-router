/**
 * Model-level usage telemetry — the producer side.
 *
 * `docs/contracts/model-usage-telemetry-v1.md` is normative; this file is its
 * type surface. The one invariant worth restating here, because every field
 * below exists to serve it: a record is keyed by an **opaque model ID and
 * nothing else**. There is deliberately no provider field, no account field,
 * and no source count — not because they are filtered out late, but because
 * the shape has nowhere to put them.
 *
 * That is the difference between this and the lane-shaped consumer staged on
 * `tog-943-usage-aware-router-v2`, whose `CapacityLane` requires `provider` and
 * `account`. See contract §6.1.
 */

/** Snapshot schema version. A consumer rejects what it does not implement. */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/**
 * Closed window vocabulary (contract §3.3). Closed on purpose: a free-form
 * window name is a side channel for the vendor's identity ("anthropic-5h"
 * names the provider; `five-hour` does not).
 */
export const TELEMETRY_WINDOWS = ["five-hour", "daily", "weekly", "monthly", "rolling"] as const;
export type TelemetryWindowName = (typeof TELEMETRY_WINDOWS)[number];

/**
 * Model state, ordered least to most restrictive (contract §3.2).
 *
 * `unknown` is deliberately serviceable. Absence of evidence is not evidence of
 * exhaustion; if a producer outage could take the whole fleet out of service,
 * the outage becomes an availability incident. Fail-closed belongs in the
 * consumer's enforce path where it is a visible policy choice.
 */
export type ModelUsageState = "available" | "degraded" | "exhausted" | "unavailable" | "unknown";

/** Least-restrictive-first ordering, used by the cross-source reduction. */
export const STATE_RESTRICTIVENESS: Record<ModelUsageState, number> = {
  available: 0,
  degraded: 1,
  unknown: 2,
  exhausted: 3,
  unavailable: 4,
};

/** Whether the record rests on real measurement, some, or none. */
export type ObservationQuality = "measured" | "partial" | "absent";

/** Why a snapshot is unavailable. Closed so no reason can carry an identity. */
export type TelemetryReasonCode =
  | "upstream-unreachable"
  | "upstream-rejected-credential"
  | "upstream-error"
  | "upstream-malformed"
  | "not-configured"
  | "stale";

export interface ModelUsageWindow {
  window: TelemetryWindowName;
  /** Fraction in [0,1], or null when unmeasured. Never clamped — see §3.1. */
  utilization: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
}

export interface ModelUsageRecord {
  /** Derived from `state`, never independent of it. */
  serviceable: boolean;
  state: ModelUsageState;
  utilization: number | null;
  remainingFraction: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
  windows: ModelUsageWindow[];
  observationQuality: ObservationQuality;
}

export interface ModelUsageSnapshot {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** When the state was OBSERVED, not when this was serialized (§3.1). */
  observedAt: string;
  staleAfterSeconds: number;
  telemetry: "available" | "unavailable";
  reasonCode: TelemetryReasonCode | null;
  /**
   * Keyed by exact opaque model ID. An empty object with
   * `telemetry: "available"` is a valid, meaningful answer — it is NOT an
   * outage. Contract §4 exists entirely to keep those two apart.
   */
  models: Record<string, ModelUsageRecord>;
}

/**
 * One contributing source, as the producer sees it internally, BEFORE
 * sanitization. This type never crosses the wire.
 *
 * It carries no identity fields either — not because the deployment lacks them,
 * but because the normalizer has no legitimate use for them, and a field that
 * does not exist cannot be leaked by a future edit. The deployment's collector
 * maps its own account/connection rows onto these and discards the identities
 * at that boundary.
 */
export interface UsageObservation {
  /** Exact opaque model IDs this source can serve. Never parsed. */
  modelIds: string[];
  /** Explicit posture from the source, when it reports one. */
  reportedState: ModelUsageState | null;
  windows: Array<{
    window: TelemetryWindowName;
    utilization: number | null;
    resetsAt: string | null;
  }>;
}

export interface NormalizeOptions {
  /** At or above this utilization a window is exhausted. */
  exhaustedUtilization?: number;
  /** At or above this utilization a window is degraded. */
  degradedUtilization?: number;
  /**
   * A limit clearing within this many seconds reports `degraded`, not
   * `exhausted` (§3.2). A window that resets in ninety seconds is not an
   * outage, and calling it one sheds load that could have simply waited.
   */
  resetGraceSeconds?: number;
  /** Hard cap on emitted records (§5). */
  maxModels?: number;
}

export const TELEMETRY_DEFAULTS = {
  exhaustedUtilization: 0.995,
  degradedUtilization: 0.9,
  resetGraceSeconds: 300,
  maxModels: 512,
  staleAfterSeconds: 300,
  maxBodyBytes: 256 * 1024,
} as const;
