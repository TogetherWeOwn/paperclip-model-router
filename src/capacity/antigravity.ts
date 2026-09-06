import type {
  CapacityEvidence,
  CapacityHealth,
  CapacitySnapshot,
  CapacitySourceConfig,
  CapacityWindow,
} from "./types.js";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstValue(record: Record<string, unknown>, fields: string[]): { value: unknown; field: string } | null {
  for (const field of fields) {
    if (field in record) return { value: record[field], field };
  }
  return null;
}

function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeStatus(value: unknown): CapacityHealth | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["healthy", "available", "allowed", "ready", "ok", "active"].includes(normalized)) return "healthy";
  if (["degraded", "limited", "warning"].includes(normalized)) return "degraded";
  if (["cooldown", "cooling_down", "cooling-down", "exhausted", "quota_exhausted", "rate_limited"].includes(normalized)) return "exhausted";
  if (["unavailable", "disabled", "offline", "error", "blocked"].includes(normalized)) return "unavailable";
  if (["unknown", "stale"].includes(normalized)) return "unknown";
  return null;
}

function providerIsAntigravity(record: Record<string, unknown>): boolean {
  return [record.provider, record.type].some((value) =>
    typeof value === "string" && ["antigravity", "agy"].includes(value.trim().toLowerCase()),
  );
}

function collectAuthRecords(payload: unknown): Record<string, unknown>[] | null {
  const envelope = recordOf(payload);
  if (!envelope || !Array.isArray(envelope.files)) return null;
  return envelope.files.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null);
}

function collectCandidateRecords(value: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = recordOf(node);
    if (!record) return;
    candidates.push(record);
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return candidates;
}

function findWindowRecord(
  auth: Record<string, unknown>,
  definition: CapacitySourceConfig["windows"][number],
): { record: Record<string, unknown>; remaining: { value: unknown; field: string } } | null {
  for (const record of collectCandidateRecords(auth)) {
    const remaining = firstValue(record, definition.utilizationFields);
    if (remaining) return { record, remaining };
  }
  return null;
}

function resetInSeconds(resetsAt: string | null, fetchedAtMs: number): number | null {
  return resetsAt === null || !Number.isFinite(fetchedAtMs)
    ? null
    : Math.max(0, Math.round((Date.parse(resetsAt) - fetchedAtMs) / 1000));
}

function windowHealth(remainingFraction: number, secondsUntilReset: number | null): CapacityHealth {
  if (remainingFraction > 0) return remainingFraction <= 0.1 ? "degraded" : "healthy";
  return secondsUntilReset !== null && secondsUntilReset > 0 && secondsUntilReset <= 300
    ? "degraded"
    : "exhausted";
}

const HEALTH_RANK: Record<CapacityHealth, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  exhausted: 3,
  unavailable: 4,
};

function postureFor(health: CapacityHealth, utilization: number): CapacityEvidence["posture"] {
  if (health === "unavailable" || health === "exhausted") return "unavailable";
  if (health === "unknown") return "unknown";
  if (health === "degraded" || utilization >= 0.8) return "avoid";
  if (utilization >= 0.6) return "conserve";
  return "available";
}

export function normalizeAntigravityAuthFiles(input: {
  payload: unknown;
  source: CapacitySourceConfig;
  fetchedAt: string;
}): CapacitySnapshot {
  const records = collectAuthRecords(input.payload);
  if (!records) {
    return { fetchedAt: input.fetchedAt, source: input.source.id, evidence: [], error: "antigravity-auth-files-invalid" };
  }

  const fetchedAtMs = Date.parse(input.fetchedAt);
  const evidence: CapacityEvidence[] = [];
  const antigravityRecords = records.filter(providerIsAntigravity);

  antigravityRecords.forEach((auth, index) => {
    const explicitStatuses = input.source.healthFields
      .map((field) => normalizeStatus(auth[field]))
      .filter((entry): entry is CapacityHealth => entry !== null);
    if (auth.disabled === true || auth.unavailable === true) explicitStatuses.push("unavailable");

    const windows: CapacityWindow[] = [];
    const windowHealths: CapacityHealth[] = [];
    for (const definition of input.source.windows) {
      const matched = findWindowRecord(auth, definition);
      if (!matched) continue;
      const remainingFraction = fraction(matched.remaining.value);
      if (remainingFraction === null) continue;
      const reset = firstValue(matched.record, definition.resetFields) ?? firstValue(auth, definition.resetFields);
      const resetsAt = timestamp(reset?.value);
      const utilization = 1 - remainingFraction;
      windows.push({
        name: definition.name,
        utilization,
        remainingFraction,
        resetsAt,
        sourcePath: matched.remaining.field,
      });
      windowHealths.push(windowHealth(remainingFraction, resetInSeconds(resetsAt, fetchedAtMs)));
    }

    const health = [...explicitStatuses, ...windowHealths]
      .sort((left, right) => HEALTH_RANK[right] - HEALTH_RANK[left])[0] ?? "unknown";
    const restrictive = [...windows].sort((left, right) =>
      (right.utilization ?? -1) - (left.utilization ?? -1) || left.name.localeCompare(right.name),
    )[0] ?? null;
    const utilization = restrictive?.utilization ?? null;
    const telemetryAvailable = windows.length === input.source.windows.length && utilization !== null && health !== "unknown";
    const posture = telemetryAvailable ? postureFor(health, utilization!) : "unknown";

    for (const modelId of input.source.modelIds) {
      evidence.push({
        modelId,
        source: input.source.id,
        laneLabel: `credential-${index + 1}`,
        health: telemetryAvailable ? health : "unknown",
        posture,
        utilization,
        remainingFraction: restrictive?.remainingFraction ?? null,
        resetsAt: restrictive?.resetsAt ?? null,
        resetInSeconds: resetInSeconds(restrictive?.resetsAt ?? null, fetchedAtMs),
        windows,
        telemetryAvailable,
        reason: telemetryAvailable
          ? `${health}; ${Math.round((restrictive?.remainingFraction ?? 0) * 100)}% remains in the restrictive window`
          : `credential record is missing one or more required quota windows`,
      });
    }
  });

  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    evidence,
    error: antigravityRecords.length === 0
      ? "antigravity-auth-files-empty"
      : evidence.some((entry) => !entry.telemetryAvailable)
        ? "antigravity-auth-files-incomplete"
        : null,
  };
}
