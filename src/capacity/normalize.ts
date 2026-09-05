import type {
  CapacityEvidence,
  CapacityHealth,
  CapacitySnapshot,
  CapacitySourceConfig,
  CapacityWindow,
} from "./types.js";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstValue(record: Record<string, unknown>, fields: string[]): { value: unknown; field: string } | null {
  for (const field of fields) {
    if (field in record) return { value: record[field], field };
  }
  return null;
}

function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeHealth(value: unknown): CapacityHealth | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "allowed", "ready", "ok", "active"].includes(normalized)) return "healthy";
  if (["degraded", "limited", "warning", "cooldown", "cooling_down"].includes(normalized)) return "degraded";
  if (["exhausted", "quota_exhausted", "rate_limited"].includes(normalized)) return "exhausted";
  if (["unavailable", "disabled", "offline", "error", "blocked"].includes(normalized)) return "unavailable";
  if (["unknown", "stale"].includes(normalized)) return "unknown";
  return null;
}

function collectEvidenceRecords(payload: unknown, source: CapacitySourceConfig): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = recordOf(node);
    if (!record) return;
    const utilization = source.windows.some((entry) => firstValue(record, entry.utilizationFields));
    if (utilization) found.push(record);
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(payload);
  return found;
}

function normalizeWindow(
  record: Record<string, unknown>,
  definition: CapacitySourceConfig["windows"][number],
): CapacityWindow | null {
  const utilization = firstValue(record, definition.utilizationFields);
  const normalizedUtilization = fraction(utilization?.value);
  // Reset-only windows are metadata without capacity evidence. Ignoring them
  // prevents a reset timestamp from outranking a real utilization window.
  if (normalizedUtilization === null) return null;
  const reset = firstValue(record, definition.resetFields);
  const normalizedReset = timestamp(reset?.value);
  return {
    name: definition.name,
    utilization: normalizedUtilization,
    remainingFraction: 1 - normalizedUtilization,
    resetsAt: normalizedReset,
    sourcePath: utilization?.field ?? definition.name,
  };
}

function resetInSeconds(resetsAt: string | null, fetchedAtMs: number): number | null {
  return resetsAt === null || !Number.isFinite(fetchedAtMs)
    ? null
    : Math.round((Date.parse(resetsAt) - fetchedAtMs) / 1000);
}

function windowHealth(utilization: number, secondsUntilReset: number | null): CapacityHealth {
  if (utilization >= 0.995) return secondsUntilReset !== null && secondsUntilReset > 0 && secondsUntilReset <= 300 ? "degraded" : "exhausted";
  if (utilization >= 0.9) return "degraded";
  return "healthy";
}

const HEALTH_RANK: Record<CapacityHealth, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  exhausted: 3,
  unavailable: 4,
};

function restrictiveWindow(
  windows: CapacityWindow[],
  fetchedAtMs: number,
): { window: CapacityWindow | null; health: CapacityHealth } {
  const evaluated = windows.map((window) => ({
    window,
    health: windowHealth(window.utilization!, resetInSeconds(window.resetsAt, fetchedAtMs)),
  }));
  evaluated.sort((left, right) =>
    HEALTH_RANK[right.health] - HEALTH_RANK[left.health] ||
    right.window.utilization! - left.window.utilization! ||
    (resetInSeconds(right.window.resetsAt, fetchedAtMs) ?? Number.POSITIVE_INFINITY) -
      (resetInSeconds(left.window.resetsAt, fetchedAtMs) ?? Number.POSITIVE_INFINITY) ||
    left.window.name.localeCompare(right.window.name)
  );
  return evaluated[0] ?? { window: null, health: "unknown" };
}

function conservativeHealth(explicit: CapacityHealth | null, window: CapacityHealth): CapacityHealth {
  if (explicit === null) return window;
  return HEALTH_RANK[explicit] >= HEALTH_RANK[window] ? explicit : window;
}

function postureFor(health: CapacityHealth, utilization: number | null): CapacityEvidence["posture"] {
  if (health === "unavailable" || health === "exhausted") return "unavailable";
  if (health === "unknown") return "unknown";
  if (health === "degraded" || (utilization !== null && utilization >= 0.8)) return "avoid";
  if (utilization !== null && utilization >= 0.6) return "conserve";
  return "available";
}

export function normalizeCapacityPayload(input: {
  payload: unknown;
  source: CapacitySourceConfig;
  fetchedAt: string;
}): CapacitySnapshot {
  const fetchedAtMs = new Date(input.fetchedAt).getTime();
  const records = collectEvidenceRecords(input.payload, input.source);
  const evidence: CapacityEvidence[] = [];

  records.forEach((record, index) => {
    const windows = input.source.windows
      .map((definition) => normalizeWindow(record, definition))
      .filter((entry): entry is CapacityWindow => entry !== null);
    const restrictive = restrictiveWindow(windows, fetchedAtMs);
    const utilization = restrictive.window?.utilization ?? null;
    const resetsAt = restrictive.window?.resetsAt ?? null;
    const explicit = normalizeHealth(firstValue(record, input.source.healthFields)?.value);
    const health = conservativeHealth(explicit, restrictive.health);
    const telemetryAvailable = utilization !== null && health !== "unknown";

    for (const modelId of input.source.modelIds) {
      evidence.push({
        modelId,
        source: input.source.id,
        laneLabel: `record-${index + 1}` ,
        health,
        posture: postureFor(health, utilization),
        utilization,
        remainingFraction: utilization === null ? null : 1 - utilization,
        resetsAt,
        resetInSeconds: resetInSeconds(resetsAt, fetchedAtMs),
        windows,
        telemetryAvailable,
        reason: utilization === null
          ? `no valid utilization was present; explicit health ${explicit ?? "absent"}`
          : `${health}; ${Math.round(utilization * 100)}% utilized${resetsAt ? `; resets ${resetsAt}` : ""}`,
      });
    }
  });

  // The legacy vendor path cannot make contract §4's distinction: a vendor
  // status body has no `telemetry` field, so an outage and a genuinely
  // unconstrained deployment are the same zero-record payload. It therefore
  // reports the conservative reading — no records means unavailable — and a
  // producer that needs the healthy-empty case answered honestly must serve the
  // contract shape, which `src/capacity/contract.ts` reads structurally.
  const empty = evidence.length === 0;
  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    evidence,
    telemetry: empty ? "unavailable" : "available",
    reasonCode: empty ? "capacity-no-recognizable-records" : null,
    error: empty ? "capacity payload carried no recognizable telemetry records" : null,
  };
}
