/**
 * The collection boundary: raw deployment telemetry in, identity-free
 * `UsageObservation[]` out.
 *
 * This is the ONLY place that ever sees account IDs, connection IDs and
 * credentials, and it is deliberately small enough to audit in one sitting.
 * Everything downstream of `collectObservations` is structurally incapable of
 * leaking an identity because `UsageObservation` has no field to hold one.
 *
 * Shape note: this reads payloads in the family OmniRoute's management API
 * returns — `/api/quota/plans` (resolved per-connection plans),
 * `/api/usage/{connectionId}` and `/api/quota/pools/{id}/usage` are all
 * connection-keyed records carrying utilization and reset clocks, with the
 * servable model IDs alongside. Those routes require a management credential
 * (`manage`/`admin`, or an `oma_` token), which is precisely why the collector
 * runs in the deployment and not in the plugin: the plugin must never hold that
 * credential, and this module's output is what crosses the gap instead.
 */

import type { ModelUsageState, TelemetryWindowName, UsageObservation } from "./types.js";
import { TELEMETRY_WINDOWS } from "./types.js";

/**
 * Where to find each piece in the deployment's own payload. Field names are
 * configured rather than hardcoded so a deployment can point this at its own
 * telemetry without a code change — and so this repository never has to encode
 * one vendor's schema as if it were the standard.
 */
export interface CollectorFieldMap {
  /** Fields holding the servable model IDs (array of strings, or one string). */
  modelIdFields: string[];
  /** Fields holding an explicit posture/health string. */
  stateFields: string[];
  /** How to read each window. `window` must be in the closed vocabulary. */
  windows: Array<{
    window: TelemetryWindowName;
    utilizationFields: string[];
    resetFields: string[];
    /** Optional used/limit pair, when the source reports counts not fractions. */
    usedFields?: string[];
    limitFields?: string[];
  }>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstPresent(record: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    if (field in record && record[field] !== null && record[field] !== undefined) return record[field];
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asIsoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds. A epoch-seconds value read as
    // milliseconds lands in 1970 and would make every reset look long past.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Map a source's own posture vocabulary onto the closed enum. */
function asState(value: unknown): ModelUsageState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "active", "ok", "ready", "allowed", "enabled"].includes(normalized)) {
    return "available";
  }
  if (["degraded", "limited", "warning", "throttled", "cooldown"].includes(normalized)) return "degraded";
  if (["exhausted", "quota_exhausted", "rate_limited", "over_limit", "depleted"].includes(normalized)) {
    return "exhausted";
  }
  if (["unavailable", "disabled", "offline", "error", "blocked", "revoked", "expired"].includes(normalized)) {
    return "unavailable";
  }
  if (["unknown", "stale", "pending"].includes(normalized)) return "unknown";
  // An unrecognized posture is `null` (meaning "we measured nothing explicit"),
  // never a guess. Guessing `available` here would invent capacity.
  return null;
}

function asModelIds(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    // Accept both `["a","b"]` and `[{id:"a"},{model:"b"}]`.
    if (typeof entry === "string" && entry !== "") out.push(entry);
    else {
      const record = recordOf(entry);
      const id = record ? (record["id"] ?? record["model"] ?? record["modelId"]) : undefined;
      if (typeof id === "string" && id !== "") out.push(id);
    }
  }
  return out;
}

/**
 * Read one window. Prefers an explicit fraction; falls back to used/limit.
 * A zero limit yields `null`, not a division blow-up or a fake 0%.
 */
function readWindow(
  record: Record<string, unknown>,
  definition: CollectorFieldMap["windows"][number],
): { window: TelemetryWindowName; utilization: number | null; resetsAt: string | null } | null {
  let utilization = asNumber(firstPresent(record, definition.utilizationFields));

  if (utilization === null && definition.usedFields && definition.limitFields) {
    const used = asNumber(firstPresent(record, definition.usedFields));
    const limit = asNumber(firstPresent(record, definition.limitFields));
    if (used !== null && limit !== null && limit > 0) utilization = used / limit;
  }

  // Some sources report percentages. Anything above 1 that is plausibly a
  // percent is rescaled; anything still out of range is rejected downstream by
  // the normalizer rather than clamped here.
  if (utilization !== null && utilization > 1 && utilization <= 100) utilization = utilization / 100;

  const resetsAt = asIsoString(firstPresent(record, definition.resetFields));
  if (utilization === null && resetsAt === null) return null;
  return { window: definition.window, utilization, resetsAt };
}

/**
 * Walk an arbitrary payload and pull out every record that carries model IDs
 * together with usage state. Identity fields present on those records are
 * simply never read — they are not copied and then removed, they are never
 * touched at all.
 */
export function collectObservations(input: {
  payload: unknown;
  fieldMap: CollectorFieldMap;
}): UsageObservation[] {
  const observations: UsageObservation[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = recordOf(node);
    if (record === null) return;
    // Cycle guard: management payloads are sometimes self-referential.
    if (seen.has(record)) return;
    seen.add(record);

    const modelIds = asModelIds(firstPresent(record, input.fieldMap.modelIdFields));
    if (modelIds.length > 0) {
      const windows = input.fieldMap.windows
        .map((definition) => readWindow(record, definition))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter((entry) => (TELEMETRY_WINDOWS as readonly string[]).includes(entry.window));
      const reportedState = asState(firstPresent(record, input.fieldMap.stateFields));

      if (windows.length > 0 || reportedState !== null) {
        observations.push({ modelIds, reportedState, windows });
      }
    }

    for (const value of Object.values(record)) {
      if (value !== null && typeof value === "object") visit(value);
    }
  };

  visit(input.payload);
  return observations;
}
