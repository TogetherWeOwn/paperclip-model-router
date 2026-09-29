import type { ModelEntry } from "../engine/types.js";
import type { CatalogueProbe, HealthFlip, ModelHealthEntry, ModelHealthState } from "./types.js";

/** Consecutive catalogue absences before removing a model from service. */
export const DEAD_STRIKES = 2;
/** Consecutive routed failures before a present model is degraded. */
export const DEGRADE_STRIKES = 2;
/** Consecutive routed completions before a model is called healthy. */
export const RECOVERY_STRIKES = 2;
/** Invocation-backed health expires when it is no longer recent evidence. */
export const HEALTH_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1_000;
/** A degraded model becomes probationary so real traffic can test recovery. */
export const DEGRADED_PROBATION_MS = 30 * 60 * 1_000;

const UNKNOWN_ENTRY: ModelHealthEntry = {
  verdict: "unknown",
  checkedAt: "",
  reason: "never probed",
  strikes: 0,
  failureStreak: 0,
  successStreak: 0,
  lastInvocationAt: null,
  degradedAt: null,
};

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function asVerdict(value: unknown): ModelHealthEntry["verdict"] {
  return value === "healthy" || value === "degraded" || value === "dead" || value === "unknown"
    ? value
    : "unknown";
}

/** Normalize state written by older plugin versions before it affects routing. */
export function normalizeHealthState(value: unknown): ModelHealthState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: ModelHealthState = {};
  for (const [modelId, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const lastInvocationAt = isoOrNull(row.lastInvocationAt);
    let verdict = asVerdict(row.verdict);
    let reason = typeof row.reason === "string" ? row.reason : "stored health normalized";
    if (verdict === "healthy" && lastInvocationAt === null) {
      verdict = "unknown";
      reason = "catalogue-only legacy health has no invocation evidence";
    }
    next[modelId] = {
      verdict,
      checkedAt: isoOrNull(row.checkedAt) ?? "",
      reason,
      strikes: finiteCounter(row.strikes),
      failureStreak: finiteCounter(row.failureStreak),
      successStreak: finiteCounter(row.successStreak),
      lastInvocationAt,
      degradedAt: isoOrNull(row.degradedAt),
    };
  }
  return next;
}

function entryFor(state: ModelHealthState, modelId: string): ModelHealthEntry {
  return state[modelId] ?? { ...UNKNOWN_ENTRY };
}

function elapsedMs(from: string | null, now: string): number {
  if (!from) return Number.POSITIVE_INFINITY;
  const start = Date.parse(from);
  const end = Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : Number.POSITIVE_INFINITY;
}

function pushFlip(
  flips: HealthFlip[],
  modelId: string,
  before: ModelHealthEntry["verdict"],
  after: ModelHealthEntry["verdict"],
  reason: string,
): void {
  if (before !== after) flips.push({ modelId, from: before, to: after, reason });
}

/**
 * Fold one catalogue probe into stored health.
 *
 * Presence clears absence strikes but never creates positive health. Recent
 * invocation evidence is preserved; stale or degraded evidence enters
 * probation so traffic can produce a fresh verdict. An indeterminate catalogue
 * request remains an exact no-op.
 */
export function reconcileHealth(input: {
  models: ModelEntry[];
  probe: CatalogueProbe;
  previous: ModelHealthState;
  now: string;
}): { next: ModelHealthState; flips: HealthFlip[] } {
  const { models, probe, now } = input;
  const previous = normalizeHealthState(input.previous);
  if (probe.modelIds === null) return { next: previous, flips: [] };

  const next: ModelHealthState = {};
  const flips: HealthFlip[] = [];

  for (const model of models) {
    const before = entryFor(previous, model.id);
    const present = probe.modelIds.has(model.id);

    if (present) {
      let after: ModelHealthEntry = { ...before, checkedAt: now, strikes: 0 };
      if (before.verdict === "dead") {
        after = {
          ...after,
          verdict: "unknown",
          reason: "present in the upstream catalogue; awaiting invocation evidence",
          failureStreak: 0,
          successStreak: 0,
          degradedAt: null,
        };
      } else if (
        before.verdict === "degraded" &&
        elapsedMs(before.degradedAt, now) >= DEGRADED_PROBATION_MS
      ) {
        after = {
          ...after,
          verdict: "unknown",
          reason: "degraded cooldown elapsed; awaiting probationary invocation",
          failureStreak: 0,
          successStreak: 0,
          degradedAt: null,
        };
      } else if (
        before.verdict === "healthy" &&
        elapsedMs(before.lastInvocationAt, now) >= HEALTH_EVIDENCE_MAX_AGE_MS
      ) {
        after = {
          ...after,
          verdict: "unknown",
          reason: "invocation evidence is stale; awaiting a fresh result",
          failureStreak: 0,
          successStreak: 0,
          degradedAt: null,
        };
      } else if (before.verdict === "unknown") {
        after.reason = before.lastInvocationAt
          ? before.reason
          : "present in the upstream catalogue; awaiting invocation evidence";
      }
      next[model.id] = after;
      pushFlip(flips, model.id, before.verdict, after.verdict, after.reason);
      continue;
    }

    const strikes = before.strikes + 1;
    const reason = `absent from the upstream catalogue (${strikes}/${DEAD_STRIKES} consecutive)`;
    const after = strikes >= DEAD_STRIKES
      ? { ...before, verdict: "dead" as const, checkedAt: now, reason, strikes }
      : { ...before, checkedAt: now, reason, strikes };
    next[model.id] = after;
    pushFlip(flips, model.id, before.verdict, after.verdict, reason);
  }

  return { next, flips };
}

/** Fold one real routed-call result into stored health for the selected model. */
export function reconcileInvocation(input: {
  modelId: string;
  succeeded: boolean;
  previous: ModelHealthState;
  now: string;
}): { next: ModelHealthState; flips: HealthFlip[] } {
  const previous = normalizeHealthState(input.previous);
  const before = entryFor(previous, input.modelId);
  const next = { ...previous };
  if (before.verdict === "dead") return { next, flips: [] };

  let after: ModelHealthEntry;
  if (input.succeeded) {
    const successStreak = before.successStreak + 1;
    const healthy = successStreak >= RECOVERY_STRIKES;
    after = {
      ...before,
      verdict: healthy ? "healthy" : before.verdict,
      checkedAt: input.now,
      reason: healthy
        ? `${successStreak} consecutive invocations completed`
        : `invocation completed (${successStreak}/${RECOVERY_STRIKES} consecutive)`,
      failureStreak: 0,
      successStreak,
      lastInvocationAt: input.now,
      degradedAt: healthy ? null : before.degradedAt,
    };
  } else {
    const failureStreak = before.failureStreak + 1;
    const degraded = failureStreak >= DEGRADE_STRIKES;
    after = {
      ...before,
      verdict: degraded ? "degraded" : before.verdict,
      checkedAt: input.now,
      reason: degraded
        ? `${failureStreak} consecutive invocations failed`
        : `invocation failed (${failureStreak}/${DEGRADE_STRIKES} consecutive)`,
      failureStreak,
      successStreak: 0,
      lastInvocationAt: input.now,
      // Every fresh failure restarts the probation cooldown. Otherwise a model
      // that failed again just before the timer elapsed would be retried as if
      // the old incident had gone quiet.
      degradedAt: degraded ? input.now : before.degradedAt,
    };
  }

  next[input.modelId] = after;
  const flips: HealthFlip[] = [];
  pushFlip(flips, input.modelId, before.verdict, after.verdict, after.reason);
  return { next, flips };
}

/** Apply hard health removal on top of the operator's model table. */
export function applyHealth(models: ModelEntry[], health: ModelHealthState): ModelEntry[] {
  const normalized = normalizeHealthState(health);
  return models.map((model) =>
    normalized[model.id]?.verdict === "dead" ? { ...model, enabled: false } : model,
  );
}

export function degradedModelIds(health: ModelHealthState): Set<string> {
  const normalized = normalizeHealthState(health);
  return new Set(
    Object.entries(normalized)
      .filter(([, entry]) => entry.verdict === "degraded")
      .map(([modelId]) => modelId),
  );
}
