import type {
  CapacityHealth,
  CapacityLane,
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

function accountId(record: Record<string, unknown>, fields: string[], index: number): string {
  const found = firstValue(record, fields);
  return typeof found?.value === "string" && found.value.trim()
    ? found.value.trim()
    : `account-${index + 1}`;
}

function collectAccountRecords(payload: unknown, source: CapacitySourceConfig): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = recordOf(node);
    if (!record) return;
    const account = firstValue(record, source.accountIdFields);
    const window = source.windows.some((entry) => firstValue(record, entry.utilizationFields));
    if (account || window) found.push(record);
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
  const reset = firstValue(record, definition.resetFields);
  const normalizedUtilization = fraction(utilization?.value);
  const normalizedReset = timestamp(reset?.value);
  if (normalizedUtilization === null && normalizedReset === null) return null;
  return {
    name: definition.name,
    utilization: normalizedUtilization,
    remainingFraction: normalizedUtilization === null ? null : 1 - normalizedUtilization,
    resetsAt: normalizedReset,
    sourcePath: utilization?.field ?? reset?.field ?? definition.name,
  };
}

function laneHealth(
  explicit: CapacityHealth | null,
  utilization: number | null,
  resetInSeconds: number | null,
): CapacityHealth {
  if (explicit === "unavailable") return explicit;
  if (utilization !== null && utilization >= 0.995) {
    return resetInSeconds !== null && resetInSeconds <= 300 ? "degraded" : "exhausted";
  }
  if (explicit) return explicit;
  if (utilization === null) return "unknown";
  if (utilization >= 0.9) return "degraded";
  return "healthy";
}

function postureFor(health: CapacityHealth, utilization: number | null): CapacityLane["posture"] {
  if (health === "unavailable" || health === "exhausted") return "unavailable";
  if (health === "unknown") return "unknown";
  if (health === "degraded" || (utilization !== null && utilization >= 0.8)) return "avoid";
  if (utilization !== null && utilization >= 0.6) return "conserve";
  return "available";
}

function resetInSeconds(resetsAt: string | null, fetchedAtMs: number): number | null {
  return resetsAt === null || !Number.isFinite(fetchedAtMs)
    ? null
    : Math.max(0, Math.round((Date.parse(resetsAt) - fetchedAtMs) / 1000));
}

const HEALTH_RANK: Record<CapacityHealth, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  exhausted: 3,
  unavailable: 4,
};

function restrictiveWindow(
  windows: CapacityWindow[],
  fetchedAtMs: number,
): { window: CapacityWindow | null; health: CapacityHealth } {
  const evaluated = windows.map((window) => ({
    window,
    health: laneHealth(null, window.utilization, resetInSeconds(window.resetsAt, fetchedAtMs)),
  }));
  evaluated.sort((left, right) =>
    HEALTH_RANK[right.health] - HEALTH_RANK[left.health] ||
    (right.window.utilization ?? -1) - (left.window.utilization ?? -1) ||
    (resetInSeconds(right.window.resetsAt, fetchedAtMs) ?? Number.POSITIVE_INFINITY) -
      (resetInSeconds(left.window.resetsAt, fetchedAtMs) ?? Number.POSITIVE_INFINITY) ||
    left.window.name.localeCompare(right.window.name)
  );
  return evaluated[0] ?? { window: null, health: "unknown" };
}

export function normalizeCapacityPayload(input: {
  payload: unknown;
  source: CapacitySourceConfig;
  fetchedAt: string;
}): CapacitySnapshot {
  const fetchedAtMs = new Date(input.fetchedAt).getTime();
  const records = collectAccountRecords(input.payload, input.source);
  const lanes: CapacityLane[] = [];

  records.forEach((record, index) => {
    const windows = input.source.windows
      .map((definition) => normalizeWindow(record, definition))
      .filter((entry): entry is CapacityWindow => entry !== null);
    const restrictive = restrictiveWindow(windows, fetchedAtMs);
    const utilization = restrictive.window?.utilization ?? null;
    const resetsAt = restrictive.window?.resetsAt ?? null;
    const secondsUntilReset = resetInSeconds(resetsAt, fetchedAtMs);
    const explicit = normalizeHealth(firstValue(record, input.source.healthFields)?.value);
    const health = explicit === "unavailable"
      ? explicit
      : explicit && windows.length === 0
        ? explicit
        : restrictive.health;
    const providers = input.source.providers.length > 0 ? input.source.providers : [input.source.id];

    for (const provider of providers) {
      lanes.push({
        provider,
        account: accountId(record, input.source.accountIdFields, index),
        health,
        posture: postureFor(health, utilization),
        utilization,
        remainingFraction: utilization === null ? null : 1 - utilization,
        resetsAt,
        resetInSeconds: secondsUntilReset,
        windows,
        telemetryAvailable: windows.some((entry) => entry.utilization !== null) || explicit !== null,
        reason: windows.length === 0
          ? "no configured capacity window was present"
          : `${health}; ${Math.round((utilization ?? 0) * 100)}% utilized${resetsAt ? `; resets ${resetsAt}` : ""}`,
      });
    }
  });

  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    lanes,
    error: lanes.length === 0 ? "capacity payload carried no recognizable account records" : null,
  };
}
