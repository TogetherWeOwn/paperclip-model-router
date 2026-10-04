/**
 * TOG-14189: flag-gated decision-diff emit verb (no live mutation).
 *
 * A decision-diff answers one question on fixtures: "the old decision served
 * lane A, the new decision would serve lane B — what moved, and why?" It is a
 * pure diff plus a log emit. It never reads or writes live routing state: it
 * takes no plugin context, touches no `ctx.state`/`ctx.db`/`ctx.http`, and
 * performs no upstream call. Production wiring is deliberately out of scope —
 * this verb exists so tests and offline rehearsals can assert the diff shape
 * before anything is ever allowed near the live path.
 *
 * Flag: `DecisionDiffEmitOptions.enabled`, default `false` (off). When off,
 * `emitDecisionDiff` is a no-op that never calls the logger. When on, it
 * calls `logger.info` exactly once with the diff fields.
 */

/** One side of the diff: where a decision was (or would be) served from. */
export interface DecisionDiffLane {
  /** Capacity source id (the lane), e.g. `"subscriptions"`. Null = unknown. */
  source: string | null;
  /** Operator-defined lane label. Null = unknown. */
  laneLabel: string | null;
  /** Opaque model id served on the lane. Null = unknown. */
  modelId: string | null;
}

/** The emitted diff shape: old lane -> new lane + reason. */
export interface DecisionDiff {
  oldSource: string | null;
  oldLaneLabel: string | null;
  oldModelId: string | null;
  newSource: string | null;
  newLaneLabel: string | null;
  newModelId: string | null;
  /** Why the lane moved. Never empty — falls back to `"unspecified"`. */
  reason: string;
  /** True when source, lane label, or model id differs between the two sides. */
  changed: boolean;
}

export interface DecisionDiffEmitOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

/** Minimal logger surface: only `info` is ever called. */
export interface DecisionDiffLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Upper bound on the carried reason, matching the repo's 512-char error hygiene. */
export const DECISION_DIFF_REASON_MAX_LENGTH = 512;

const UNSPECIFIED_REASON = "unspecified";

function normalizeLane(lane: DecisionDiffLane | null | undefined): Required<DecisionDiffLane> {
  return {
    source: lane?.source ?? null,
    laneLabel: lane?.laneLabel ?? null,
    modelId: lane?.modelId ?? null,
  };
}

function normalizeReason(reason: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) return UNSPECIFIED_REASON;
  return trimmed.slice(0, DECISION_DIFF_REASON_MAX_LENGTH);
}

/**
 * Build the diff between the previously served lane and the newly computed
 * lane. Pure: no I/O, no config reads, no live state.
 */
export function buildDecisionDiff(
  oldLane: DecisionDiffLane | null | undefined,
  newLane: DecisionDiffLane | null | undefined,
  reason: string,
): DecisionDiff {
  const old = normalizeLane(oldLane);
  const current = normalizeLane(newLane);
  return {
    oldSource: old.source,
    oldLaneLabel: old.laneLabel,
    oldModelId: old.modelId,
    newSource: current.source,
    newLaneLabel: current.laneLabel,
    newModelId: current.modelId,
    reason: normalizeReason(reason),
    changed:
      old.source !== current.source ||
      old.laneLabel !== current.laneLabel ||
      old.modelId !== current.modelId,
  };
}

/**
 * Emit a decision diff to logs behind the `enabled` flag (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off (or
 * absent) the logger is never called — this is the guarantee the flag-off
 * tests pin. Never throws on a logger failure: a diff emit must not fault a
 * caller, so a throwing logger reads as "not emitted" (`false`).
 */
export function emitDecisionDiff(
  logger: DecisionDiffLogger,
  diff: DecisionDiff,
  options?: DecisionDiffEmitOptions,
): boolean {
  if (options?.enabled !== true) return false;
  const direction =
    diff.oldSource === null && diff.newSource === null
      ? "lane unknown"
      : `lane ${diff.oldSource ?? "unknown"} -> ${diff.newSource ?? "unknown"}`;
  try {
    logger.info(`Decision diff: ${direction} (${diff.reason}).`, {
      oldSource: diff.oldSource,
      oldLaneLabel: diff.oldLaneLabel,
      oldModelId: diff.oldModelId,
      newSource: diff.newSource,
      newLaneLabel: diff.newLaneLabel,
      newModelId: diff.newModelId,
      reason: diff.reason,
      changed: diff.changed,
    });
  } catch {
    return false;
  }
  return true;
}
