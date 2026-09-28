/**
 * The consumer side of `docs/contracts/model-usage-telemetry-v1.md`.
 *
 * This module is the documented adapter between the contract's wire type
 * (`ModelUsageSnapshot` — the shape the producer in `src/telemetry/` emits)
 * and `CapacityEvidence`, which is the engine's internal ranking vocabulary in
 * `src/engine/select.ts`.
 *
 * Why two shapes rather than one. `ModelUsageRecord` is a *statement about the
 * deployment*: serviceable, state, utilization, windows. `CapacityEvidence` is
 * a *ranking input*: it carries `posture`, which is a function of the operator's
 * configured `conserveUtilization` / `avoidUtilization` thresholds and has no
 * meaning on the wire. Collapsing them would push router policy into the
 * contract and force every producer to know this deployment's thresholds. So
 * the wire type is parsed here and the projection happens exactly here, in one
 * direction, in one file.
 *
 * Why the constants below are duplicated rather than imported. This package
 * builds in isolation (`tsc -p packages/lane-capacity/tsconfig.json` with
 * `rootDir: src`), so it cannot import `src/telemetry/types.ts`. The canonical
 * values live there; these copies are pinned equal by
 * `tests/capacity.spec.ts` ("contract constants track the producer"), and the
 * TOG-977 round-trip tests run the REAL producer (`normalizeUsage`) into
 * `evidenceFromContract`, so wire compatibility is proven executably rather
 * than by import.
 *
 * What this module enforces, all of them contract §6 obligations:
 *
 *   §6.1  an unknown `schemaVersion` is rejected, not best-effort parsed
 *   §6.2  `observedAt + staleAfterSeconds < fetchedAt` reads as unavailable
 *   §6.3  the model ID is a byte-for-byte key lookup, never parsed or matched
 *         against a provider table — and never fanned across `modelIds`
 *   §6.5  a healthy-but-empty snapshot is `telemetry: "available"`; only a real
 *         producer outage is `"unavailable"`
 */

import type {
  CapacityEvidence,
  CapacityHealth,
  CapacityReasonCode,
  CapacitySnapshot,
  CapacitySourceDefinition,
  CapacityWindow,
} from "./types.js";
import { fraction, recordOf } from "./value-normalization.js";

/** Canonical source: `TELEMETRY_SCHEMA_VERSION` in `src/telemetry/types.ts`. */
export const CONTRACT_SCHEMA_VERSION = 1;

/** Canonical source: `TELEMETRY_WINDOWS` in `src/telemetry/types.ts`. */
export const CONTRACT_WINDOWS = ["five-hour", "daily", "weekly", "monthly", "rolling"] as const;
export type ContractWindowName = (typeof CONTRACT_WINDOWS)[number];

/** Canonical source: `TELEMETRY_DEFAULTS.maxModels` in `src/telemetry/types.ts`. */
export const CONTRACT_MAX_MODELS = 512;

type ContractState = "available" | "degraded" | "exhausted" | "unavailable" | "unknown";

interface ContractWindow {
  window: ContractWindowName;
  utilization: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
}

interface ContractModelRecord {
  serviceable: boolean;
  state: ContractState;
  utilization: number | null;
  remainingFraction: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
  windows: ContractWindow[];
  observationQuality: "measured" | "partial" | "absent";
}

/**
 * A contract snapshot names exactly one lane per model, because the producer
 * already collapsed every account and connection behind it (§2.3). There is
 * therefore no lane to label, and this constant exists so the field carries a
 * fixed token rather than anything derived from the payload.
 */
const CONTRACT_LANE_LABEL = "model";

const STATE_TO_HEALTH: Record<ContractState, CapacityHealth> = {
  available: "healthy",
  degraded: "degraded",
  exhausted: "exhausted",
  unavailable: "unavailable",
  unknown: "unknown",
};

const WINDOW_NAMES = new Set<string>(CONTRACT_WINDOWS);

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isState(value: unknown): value is ContractState {
  return value === "available" || value === "degraded" || value === "exhausted" ||
    value === "unavailable" || value === "unknown";
}

/** `serviceable` is derived from `state`; a record where they disagree is malformed (§3.2). */
function serviceableForState(state: ContractState): boolean {
  return state === "available" || state === "degraded" || state === "unknown";
}

/**
 * True when the payload claims to be a contract snapshot at all.
 *
 * The claim is presence of `telemetry`, not `schemaVersion` alone.
 * `schemaVersion`/`observedAt`/`staleAfterSeconds` are also the pre-existing
 * legacy lane-document envelope (see every `records`-array fixture in
 * `tests/`), so keying detection on `schemaVersion` would hijack every real
 * legacy vendor source that happens to version its own document the same
 * way and reject it as malformed. `telemetry` is specific to this contract —
 * no legacy shape in this codebase uses that key — so its presence is the
 * unambiguous claim. A payload that makes the claim is held to the contract
 * even if `schemaVersion` is one we do not implement — that is the whole
 * point of §6.1, and it is why the version check inside the parser is
 * presence-of-claim-then-reject, not equality-or-ignore.
 */
export function looksLikeModelUsageSnapshot(payload: unknown): boolean {
  const record = recordOf(payload);
  return record !== null && "telemetry" in record;
}

function windowFrom(value: unknown): ContractWindow | null {
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
    window: name as ContractWindowName,
    utilization,
    resetsAt,
    resetInSeconds:
      typeof reported === "number" && Number.isFinite(reported) && reported >= 0
        ? Math.round(reported)
        : null,
  };
}

function modelRecordFrom(value: unknown): ContractModelRecord | null {
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
    ? record.windows.map(windowFrom).filter((entry): entry is ContractWindow => entry !== null)
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
  | { ok: true; snapshot: { observedAt: string; staleAfterSeconds: number; telemetry: "available" | "unavailable"; reasonCode: string | null; models: Record<string, ContractModelRecord> } }
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
  if (record.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
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
        observedAt,
        staleAfterSeconds,
        telemetry: "unavailable",
        reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : "upstream-error",
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
  if (Object.keys(modelsRaw).length > CONTRACT_MAX_MODELS) {
    return { ok: false, reasonCode: "capacity-contract-malformed" };
  }

  const models: Record<string, ContractModelRecord> = {};
  for (const [modelId, value] of Object.entries(modelsRaw)) {
    const parsed = modelRecordFrom(value);
    if (parsed !== null) models[modelId] = parsed;
  }

  return {
    ok: true,
    snapshot: {
      observedAt,
      staleAfterSeconds,
      telemetry: "available",
      reasonCode: null,
      models,
    },
  };
}

function unavailable(
  source: CapacitySourceDefinition,
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

function windowsFor(record: ContractModelRecord): CapacityWindow[] {
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
  source: CapacitySourceDefinition;
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
