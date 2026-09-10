import type {
  CapacityEvidence,
  CapacityHealth,
  CapacitySnapshot,
  CapacitySourceDefinition,
  CapacityWindow,
} from "./types.js";
import { firstValue, fraction, normalizeHealth, recordOf, timestamp } from "./value-normalization.js";

function collectEvidenceRecords(payload: unknown, source: CapacitySourceDefinition): Record<string, unknown>[] {
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
  definition: CapacitySourceDefinition["windows"][number],
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
  const evaluated = windows.map((window) => {
    const secondsUntilReset = resetInSeconds(window.resetsAt, fetchedAtMs);
    return {
      window,
      secondsUntilReset,
      health: windowHealth(window.utilization!, secondsUntilReset),
    };
  });
  evaluated.sort((left, right) =>
    HEALTH_RANK[right.health] - HEALTH_RANK[left.health] ||
    right.window.utilization! - left.window.utilization! ||
    (right.secondsUntilReset ?? Number.POSITIVE_INFINITY) -
      (left.secondsUntilReset ?? Number.POSITIVE_INFINITY) ||
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
  source: CapacitySourceDefinition;
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
        laneLabel: `record-${index + 1}`,
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

  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    evidence,
    error: evidence.length === 0 ? "capacity payload carried no recognizable telemetry records" : null,
  };
}
