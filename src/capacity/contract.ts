/**
 * The consumer side of `docs/contracts/model-usage-telemetry-v1.md`.
 *
 * This module is the documented adapter between the contract's wire type
 * (`ModelUsageSnapshot`, from `src/telemetry/types.ts` — the same declaration
 * the producer emits) and `CapacityEvidence`, which is the engine's internal
 * ranking vocabulary in `src/engine/select.ts`.
 *
 * Why two shapes rather than one. `ModelUsageRecord` is a *statement about the
 * deployment*: serviceable, state, utilization, windows. `CapacityEvidence` is
 * a *ranking input*: it carries `posture`, which is a function of the operator's
 * configured `conserveUtilization` / `avoidUtilization` thresholds and has no
 * meaning on the wire. Collapsing them would push router policy into the
 * contract and force every producer to know this deployment's thresholds. So
 * the wire type is imported verbatim and the projection happens exactly here,
 * in one direction, in one file.
 *
 * What this module fixes relative to the tree-walking vendor path in
 * `normalize.ts`, all four of them contract §6 obligations:
 *
 *   §6.1  an unknown `schemaVersion` is rejected, not best-effort parsed
 *   §6.2  `observedAt + staleAfterSeconds < fetchedAt` reads as unavailable
 *   §6.3  the model ID is a byte-for-byte key lookup, never parsed or matched
 *         against a provider table — and never fanned across `modelIds`
 *   §6.5  a healthy-but-empty snapshot is `telemetry: "available"`; only a real
 *         producer outage is `"unavailable"`
 */

import {
  TELEMETRY_DEFAULTS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_WINDOWS,
  type ModelUsageRecord,
  type ModelUsageSnapshot,
  type ModelUsageState,
  type ModelUsageWindow,
  type TelemetryWindowName,
} from "../telemetry/types.js";
import type {
  CapacityEvidence,
  CapacityHealth,
  CapacityReasonCode,
  CapacitySnapshot,
  CapacitySourceConfig,
  CapacityWindow,
} from "./types.js";

/**
 * A contract snapshot names exactly one lane per model, because the producer
 * already collapsed every account and connection behind it (§2.3). There is
 * therefore no lane to label, and this constant exists so the field carries a
 * fixed token rather than anything derived from the payload.
 */
const CONTRACT_LANE_LABEL = "model";

const STATE_TO_HEALTH: Record<ModelUsageState, CapacityHealth> = {
  available: "healthy",
  degraded: "degraded",
  exhausted: "exhausted",
  unavailable: "unavailable",
  unknown: "unknown",
};

const WINDOW_NAMES = new Set<string>(TELEMETRY_WINDOWS);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** [0,1] or null. Out-of-range is rejected, never clamped (§3.1). */
function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isState(value: unknown): value is ModelUsageState {
  return value === "available" || value === "degraded" || value === "exhausted" ||
    value === "unavailable" || value === "unknown";
}

/** `serviceable` is derived from `state`; a record where they disagree is malformed (§3.2). */
function serviceableForState(state: ModelUsageState): boolean {
  return state === "available" || state === "degraded" || state === "unknown";
}

/**
 * True when the payload claims to be a contract snapshot at all.
 *
 * Presence of `schemaVersion` is the claim. A payload that makes the claim is
 * held to the contract even if the version is one we do not implement — that is
 * the whole point of §6.1, and it is why this test is presence, not equality.
 */
export function looksLikeModelUsageSnapshot(payload: unknown): boolean {
  const record = recordOf(payload);
  return record !== null && "schemaVersion" in record;
}

function windowFrom(value: unknown): ModelUsageWindow | null {
  const record = recordOf(value);
  if (!record) return null;
  const name = record.window;
  // A window this vocabulary cannot name is dropped rather than passed through:
  // a free-form name is a side channel for the vendor's identity (§3.3).
  if (typeof name !== "string" || !WINDOW_NAMES.has(name)) return null;
  const resetsAt = isoOrNull(record.resetsAt);
  const utilization = fraction(record.utilization);
  if (utilization === null && resetsAt === null) return null;
  const reported = record.resetInSeconds;
  return {
    window: name as TelemetryWindowName,
    utilization,
    resetsAt,
    resetInSeconds:
      typeof reported === "number" && Number.isFinite(reported) && reported >= 0
        ? Math.round(reported)
        : null,
  };
}

function modelRecordFrom(value: unknown): ModelUsageRecord | null {
  const record = recordOf(value);
  if (!record) return null;
  if (!isState(record.state)) return null;
  if (typeof record.serviceable !== "boolean") return null;
  // §3.2: the two must agree. A producer asserting `exhausted` but
  // `serviceable: true` is misreporting, and honouring either half of it would
  // be picking which lie to believe.
  if (record.serviceable !== serviceableForState(record.state)) return null;

  const quality = record.observationQuality;
  const utilization = fraction(record.utilization);
  const windows = Array.isArray(record.windows)
    ? record.windows.map(windowFrom).filter((entry): entry is ModelUsageWindow => entry !== null)
    : [];
  const resetsAt = isoOrNull(record.resetsAt);
  const reportedReset = record.resetInSeconds;

  return {
    serviceable: record.serviceable,
    state: record.state,
    utilization,
    remainingFraction: utilization === null ? null : 1 - utilization,
    resetsAt,
    resetInSeconds:
      typeof reportedReset === "number" && Number.isFinite(reportedReset) && reportedReset >= 0
        ? Math.round(reportedReset)
        : null,
    windows,
    observationQuality:
      quality === "measured" || quality === "partial" || quality === "absent" ? quality : "absent",
  };
}

export type ContractParse =
  | { ok: true; snapshot: ModelUsageSnapshot }
  | { ok: false; reasonCode: CapacityReasonCode };

/**
 * Strictly parse a contract snapshot. Everything that is not a well-formed
 * snapshot of a version we implement comes back as a reason code, never as a
 * partially-trusted object.
 */
export function parseModelUsageSnapshot(payload: unknown): ContractParse {
  const record = recordOf(payload);
  if (!record) return { ok: false, reasonCode: "capacity-invalid-json" };

  // §6.1. Rejected before anything else is read: a v2 body may reuse v1 field
  // names with different meanings, so parsing first and checking after would be
  // trusting exactly the bytes we have decided we cannot interpret.
  if (record.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, reasonCode: "capacity-schema-version-unsupported" };
  }

  const observedAt = isoOrNull(record.observedAt);
  if (observedAt === null) return { ok: false, reasonCode: "capacity-contract-malformed" };

  const staleAfterSeconds = record.staleAfterSeconds;
  if (typeof staleAfterSeconds !== "number" || !Number.isFinite(staleAfterSeconds) || staleAfterSeconds <= 0) {
    return { ok: false, reasonCode: "capacity-contract-malformed" };
  }

  const telemetry = record.telemetry;
  if (telemetry !== "available" && telemetry !== "unavailable") {
    return { ok: false, reasonCode: "capacity-contract-malformed" };
  }

  if (telemetry === "unavailable") {
    return {
      ok: true,
      snapshot: {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        observedAt,
        staleAfterSeconds,
        telemetry: "unavailable",
        reasonCode: typeof record.reasonCode === "string" ? (record.reasonCode as never) : "upstream-error",
        models: {},
      },
    };
  }

  const modelsRaw = recordOf(record.models);
  // `models` is required even when empty. Its ABSENCE is malformed; an empty
  // object is the valid "healthy, governing nothing" answer (§4).
  if (modelsRaw === null) return { ok: false, reasonCode: "capacity-contract-malformed" };
  // §5/§6.6: the consumer enforces the same record cap as the producer. An
  // oversized body is malformed, not a partial snapshot that reads as complete.
  if (Object.keys(modelsRaw).length > TELEMETRY_DEFAULTS.maxModels) {
    return { ok: false, reasonCode: "capacity-contract-malformed" };
  }

  const models: Record<string, ModelUsageRecord> = {};
  for (const [modelId, value] of Object.entries(modelsRaw)) {
    const parsed = modelRecordFrom(value);
    if (parsed !== null) models[modelId] = parsed;
  }

  return {
    ok: true,
    snapshot: {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      observedAt,
      staleAfterSeconds,
      telemetry: "available",
      reasonCode: null,
      models,
    },
  };
}

function unavailable(
  source: CapacitySourceConfig,
  fetchedAt: string,
  reasonCode: CapacityReasonCode,
): CapacitySnapshot {
  return {
    fetchedAt,
    source: source.id,
    evidence: [],
    telemetry: "unavailable",
    reasonCode,
    error: reasonCode,
  };
}

function windowsFor(record: ModelUsageRecord): CapacityWindow[] {
  return record.windows.map((window) => ({
    name: window.window,
    utilization: window.utilization,
    remainingFraction: window.utilization === null ? null : 1 - window.utilization,
    resetsAt: window.resetsAt,
    sourcePath: "models[].windows.utilization",
  }));
}

function postureFor(health: CapacityHealth, utilization: number | null): CapacityEvidence["posture"] {
  if (health === "unavailable" || health === "exhausted") return "unavailable";
  if (health === "unknown") return "unknown";
  if (health === "degraded" || (utilization !== null && utilization >= 0.8)) return "avoid";
  if (utilization !== null && utilization >= 0.6) return "conserve";
  return "available";
}

/**
 * Project a parsed contract snapshot onto capacity evidence for exactly the
 * model ids this source was configured to inform.
 *
 * The lookup is `snapshot.models[modelId]` — a byte-for-byte key match on an
 * opaque string (§2.1, §6.3). It is deliberately NOT the tree walk in
 * `normalize.ts`, which collects every utilization-bearing object anywhere in
 * the payload and attributes each one to every configured model id. On a nested
 * contract body that walk emits 8 rows for 2 models and gives Sonnet Opus's
 * utilization; here a model the producer did not mention simply gets no row.
 */
export function evidenceFromContract(input: {
  payload: unknown;
  source: CapacitySourceConfig;
  fetchedAt: string;
}): CapacitySnapshot {
  const parsed = parseModelUsageSnapshot(input.payload);
  if (!parsed.ok) return unavailable(input.source, input.fetchedAt, parsed.reasonCode);
  const snapshot = parsed.snapshot;

  if (snapshot.telemetry === "unavailable") {
    return unavailable(input.source, input.fetchedAt, "capacity-producer-unavailable");
  }

  // §6.2. Staleness is judged against `observedAt` — when the deployment
  // OBSERVED the state — not against when we fetched it. A producer serving a
  // cached body answers instantly with hours-old numbers, so a fetch-time
  // freshness check would call that fresh. It is not.
  const observedAtMs = Date.parse(snapshot.observedAt);
  const fetchedAtMs = Date.parse(input.fetchedAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(fetchedAtMs)) {
    return unavailable(input.source, input.fetchedAt, "capacity-contract-malformed");
  }
  if (fetchedAtMs - observedAtMs > snapshot.staleAfterSeconds * 1000) {
    return unavailable(input.source, input.fetchedAt, "capacity-snapshot-stale");
  }

  const evidence: CapacityEvidence[] = [];
  for (const modelId of input.source.modelIds) {
    const record = snapshot.models[modelId];
    // Absent is not an error. The producer is healthy and is telling us it does
    // not govern this model; §4's middle row. The per-model enforce gate in
    // `selectModel` still refuses it, which is where fail-closed belongs.
    if (!record) continue;
    const health = STATE_TO_HEALTH[record.state];
    const utilization = record.utilization;
    const resetsAt = record.resetsAt;
    // §3.1: prefer the producer's own `resetInSeconds`, which it derived from
    // `observedAt`, over anything we compute against our clock.
    const resetInSeconds = record.resetInSeconds ??
      (resetsAt === null ? null : Math.round((Date.parse(resetsAt) - observedAtMs) / 1000));
    evidence.push({
      modelId,
      source: input.source.id,
      laneLabel: CONTRACT_LANE_LABEL,
      health,
      posture: postureFor(health, utilization),
      utilization,
      remainingFraction: record.remainingFraction,
      resetsAt,
      resetInSeconds: resetInSeconds === null || Number.isFinite(resetInSeconds) ? resetInSeconds : null,
      windows: windowsFor(record),
      // §6.4: `unknown` stays routable. It is reported as "we have no
      // measurement", never as exhaustion, and shadow mode still ranks it.
      telemetryAvailable: utilization !== null && health !== "unknown",
      reason: utilization === null
        ? `${record.state}; no measured utilization (${record.observationQuality})`
        : `${record.state}; ${Math.round(utilization * 100)}% utilized${resetsAt ? `; resets ${resetsAt}` : ""}`,
    });
  }

  // The healthy-empty case (§4). `telemetry: "available"` with no evidence is a
  // trustworthy statement, and `error` stays null so it is not conflated with
  // the outage above, which is the single most dangerous misread in this design.
  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    evidence,
    telemetry: "available",
    reasonCode: null,
    error: null,
  };
}
