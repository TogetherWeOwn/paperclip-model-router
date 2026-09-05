/**
 * Reduce raw usage observations into a sanitized, model-keyed snapshot.
 *
 * The whole point of this module is the direction of the reduction. The
 * deployment knows N accounts × M connections × K windows. The plugin is
 * allowed to know one verdict per model ID. Collapsing that here — rather than
 * shipping lanes and letting the consumer pick — is what keeps provider and
 * account identity out of the plugin entirely.
 *
 * Two reductions run in opposite directions, and mixing them up is the easy bug:
 *
 *   within one source, across windows  -> MOST restrictive wins
 *       (40% weekly but 99% five-hourly means you are constrained at 99%)
 *
 *   across sources, for one model      -> LEAST restrictive wins
 *       (if any account can still serve the model, the model is serviceable)
 *
 * See docs/contracts/model-usage-telemetry-v1.md §3.4.
 */

import {
  STATE_RESTRICTIVENESS,
  TELEMETRY_DEFAULTS,
  TELEMETRY_SCHEMA_VERSION,
  type ModelUsageRecord,
  type ModelUsageSnapshot,
  type ModelUsageState,
  type ModelUsageWindow,
  type NormalizeOptions,
  type ObservationQuality,
  type TelemetryReasonCode,
  type UsageObservation,
} from "./types.js";

/**
 * A fraction, or null. Values outside [0,1] are REJECTED rather than clamped:
 * a source reporting 1.7 is misreporting, and clamping would launder that into
 * a plausible-looking 1.0 that reads as a real exhaustion signal.
 */
function fraction(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function isoOrNull(value: string | null): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function secondsUntil(resetsAt: string | null, observedAtMs: number): number | null {
  if (resetsAt === null) return null;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - observedAtMs) / 1000));
}

/** State implied by one window's numbers alone. */
function windowState(
  utilization: number | null,
  resetInSeconds: number | null,
  options: Required<Pick<NormalizeOptions, "exhaustedUtilization" | "degradedUtilization" | "resetGraceSeconds">>,
): ModelUsageState {
  if (utilization === null) return "unknown";
  if (utilization >= options.exhaustedUtilization) {
    // A limit that clears inside the grace window is a wait, not an outage.
    return resetInSeconds !== null && resetInSeconds <= options.resetGraceSeconds
      ? "degraded"
      : "exhausted";
  }
  if (utilization >= options.degradedUtilization) return "degraded";
  return "available";
}

/** `serviceable` is derived from `state`, never carried independently (§3.2). */
function serviceableFor(state: ModelUsageState): boolean {
  return state === "available" || state === "degraded" || state === "unknown";
}

interface ReducedSource {
  state: ModelUsageState;
  utilization: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
  windows: ModelUsageWindow[];
  measured: boolean;
}

/** Within one source: the most restrictive window governs. */
function reduceSource(
  observation: UsageObservation,
  observedAtMs: number,
  options: Required<Pick<NormalizeOptions, "exhaustedUtilization" | "degradedUtilization" | "resetGraceSeconds">>,
): ReducedSource {
  const windows: ModelUsageWindow[] = [];
  for (const raw of observation.windows) {
    const utilization = fraction(raw.utilization);
    const resetsAt = isoOrNull(raw.resetsAt);
    // A window with neither a number nor a clock tells us nothing at all.
    if (utilization === null && resetsAt === null) continue;
    windows.push({
      window: raw.window,
      utilization,
      resetsAt,
      resetInSeconds: secondsUntil(resetsAt, observedAtMs),
    });
  }

  const evaluated = windows.map((window) => ({
    window,
    state: windowState(window.utilization, window.resetInSeconds, options),
  }));

  evaluated.sort(
    (left, right) =>
      STATE_RESTRICTIVENESS[right.state] - STATE_RESTRICTIVENESS[left.state] ||
      (right.window.utilization ?? -1) - (left.window.utilization ?? -1) ||
      left.window.window.localeCompare(right.window.window),
  );

  const worst = evaluated[0] ?? null;
  const measured = windows.some((window) => window.utilization !== null);

  // An explicit `unavailable` from the source outranks any arithmetic: the
  // source is telling us it cannot serve, and no utilization number overrides
  // that. Other reported states only apply when we measured nothing ourselves.
  let state: ModelUsageState;
  if (observation.reportedState === "unavailable") {
    state = "unavailable";
  } else if (worst === null) {
    state = observation.reportedState ?? "unknown";
  } else {
    state = worst.state;
  }

  return {
    state,
    utilization: worst?.window.utilization ?? null,
    resetsAt: worst?.window.resetsAt ?? null,
    resetInSeconds: worst?.window.resetInSeconds ?? null,
    windows,
    measured: measured || observation.reportedState !== null,
  };
}

function qualityFor(total: number, measured: number): ObservationQuality {
  if (total === 0 || measured === 0) return "absent";
  return measured === total ? "measured" : "partial";
}

/** Earliest reset across sources — when capacity actually returns. */
function earliestReset(sources: ReducedSource[]): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const source of sources) {
    if (source.resetsAt === null) continue;
    const ms = Date.parse(source.resetsAt);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = source.resetsAt;
    }
  }
  return best;
}

/** Across sources, for one model: the least restrictive posture governs. */
function reduceModel(
  sources: ReducedSource[],
  observedAtMs: number,
): ModelUsageRecord {
  const ranked = [...sources].sort(
    (left, right) =>
      STATE_RESTRICTIVENESS[left.state] - STATE_RESTRICTIVENESS[right.state] ||
      (left.utilization ?? Number.POSITIVE_INFINITY) - (right.utilization ?? Number.POSITIVE_INFINITY),
  );

  // Utilization comes from the SAME source that produced the winning state, so
  // the two describe one lane rather than being spliced from different ones.
  const winner = ranked[0];
  if (!winner) {
    return {
      serviceable: true,
      state: "unknown",
      utilization: null,
      remainingFraction: null,
      resetsAt: null,
      resetInSeconds: null,
      windows: [],
      observationQuality: "absent",
    };
  }

  const state = winner.state;
  const blocked = state === "exhausted" || state === "unavailable";
  // When nothing can serve, the useful clock is when the FIRST lane recovers.
  const resetsAt = blocked ? earliestReset(sources) ?? winner.resetsAt : winner.resetsAt;

  return {
    serviceable: serviceableFor(state),
    state,
    utilization: winner.utilization,
    remainingFraction: winner.utilization === null ? null : 1 - winner.utilization,
    resetsAt,
    resetInSeconds: secondsUntil(resetsAt, observedAtMs),
    // Windows come from the winning source only. Merging windows across
    // sources would let a consumer count lanes by counting windows (§2.3).
    windows: winner.windows,
    observationQuality: qualityFor(sources.length, sources.filter((source) => source.measured).length),
  };
}

/**
 * Build a healthy snapshot from observations.
 *
 * `observedAt` is when the deployment OBSERVED the state — a producer serving
 * from cache passes the original observation time, not `now`, so the consumer
 * can judge staleness honestly.
 */
export function normalizeUsage(input: {
  observations: UsageObservation[];
  observedAt: string;
  staleAfterSeconds?: number;
  options?: NormalizeOptions;
}): ModelUsageSnapshot {
  const observedAt = isoOrNull(input.observedAt);
  if (observedAt === null) {
    // We cannot date the observation, so we cannot let anyone judge its
    // freshness. An undateable snapshot is an outage, not a snapshot.
    return unavailableSnapshot({
      observedAt: new Date(0).toISOString(),
      reasonCode: "upstream-malformed",
      staleAfterSeconds: input.staleAfterSeconds ?? TELEMETRY_DEFAULTS.staleAfterSeconds,
    });
  }

  const observedAtMs = Date.parse(observedAt);
  const thresholds = {
    exhaustedUtilization: input.options?.exhaustedUtilization ?? TELEMETRY_DEFAULTS.exhaustedUtilization,
    degradedUtilization: input.options?.degradedUtilization ?? TELEMETRY_DEFAULTS.degradedUtilization,
    resetGraceSeconds: input.options?.resetGraceSeconds ?? TELEMETRY_DEFAULTS.resetGraceSeconds,
  };
  const maxModels = input.options?.maxModels ?? TELEMETRY_DEFAULTS.maxModels;

  // Group by exact model ID. The ID is never parsed, split, or prefix-stripped
  // — `oc/` is part of the ID, not a provider name (§2.1).
  const byModel = new Map<string, ReducedSource[]>();
  for (const observation of input.observations) {
    const reduced = reduceSource(observation, observedAtMs, thresholds);
    for (const modelId of observation.modelIds) {
      if (typeof modelId !== "string" || modelId === "") continue;
      const bucket = byModel.get(modelId);
      if (bucket) bucket.push(reduced);
      else byModel.set(modelId, [reduced]);
    }
  }

  // Deterministic truncation, and it is honest about it: a truncated snapshot
  // that still read as `available` would look complete while missing models,
  // so overflow is reported as an outage instead (§5).
  const modelIds = [...byModel.keys()].sort();
  if (modelIds.length > maxModels) {
    return unavailableSnapshot({
      observedAt,
      reasonCode: "upstream-malformed",
      staleAfterSeconds: input.staleAfterSeconds ?? TELEMETRY_DEFAULTS.staleAfterSeconds,
    });
  }

  const models: Record<string, ModelUsageRecord> = {};
  for (const modelId of modelIds) {
    models[modelId] = reduceModel(byModel.get(modelId) ?? [], observedAtMs);
  }

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    observedAt,
    staleAfterSeconds: input.staleAfterSeconds ?? TELEMETRY_DEFAULTS.staleAfterSeconds,
    // An empty `models` here is a real answer: healthy, governing nothing.
    telemetry: "available",
    reasonCode: null,
    models,
  };
}

/**
 * The outage form. Structurally distinct from a healthy empty set, which is the
 * entire point of contract §4 — an outage that returned a bare `{}` would read
 * as "nothing is constrained", i.e. unlimited capacity.
 */
export function unavailableSnapshot(input: {
  observedAt: string;
  reasonCode: TelemetryReasonCode;
  staleAfterSeconds?: number;
}): ModelUsageSnapshot {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    observedAt: isoOrNull(input.observedAt) ?? new Date(0).toISOString(),
    staleAfterSeconds: input.staleAfterSeconds ?? TELEMETRY_DEFAULTS.staleAfterSeconds,
    telemetry: "unavailable",
    reasonCode: input.reasonCode,
    models: {},
  };
}

/** True when the snapshot has aged past its own freshness budget (§6.2). */
export function isStale(snapshot: ModelUsageSnapshot, nowIso: string): boolean {
  const observedAtMs = Date.parse(snapshot.observedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - observedAtMs > snapshot.staleAfterSeconds * 1000;
}
