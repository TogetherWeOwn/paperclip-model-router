/**
 * Propose-only watchdog detector: advise-mode decisions that never reached
 * enforce comparison and are older than the shadow window.
 *
 * An unenforced decision answers one question on snapshots: "this decision was
 * served in advise (shadow) mode, it is older than the shadow window, and no
 * enforce comparison ever ran for it — who should look at it?" The answer is
 * a proposal record only: decision id, age, and lane. This module never reads
 * or writes live routing state, never touches the alert route, and never calls
 * any recovery path: it takes decision snapshots, returns proposal records,
 * and — behind an explicit flag — emits them to an injected logger.
 * Production wiring (scheduled reads, routing to the alert sink) is
 * deliberately out of scope; this verb exists so tests can pin the
 * stale-vs-fresh-vs-compared boundary before anything is allowed near the
 * live path.
 *
 * Flag: `EmitUnenforcedDecisionsOptions.enabled`, default `false` (off).
 * When off, `emitUnenforcedDecisions` is a no-op that never calls the logger.
 *
 * Time source: the caller passes `now` (ISO). Rows carry `decidedAt` (ISO);
 * unparseable timestamps are indeterminate, not evidence of staleness — such
 * rows are skipped, in the same spirit as the run-stall detector's
 * indeterminate handling.
 */

/** Minimal advise-decision snapshot the detector reads. Extra fields ignored. */
export interface AdviseDecisionRow {
  /** Stable decision id. Rows without one are skipped. */
  id: string;
  /** Capacity mode the decision was served under. Only `"shadow"` (advise)
   * rows are examined; `"enforce"` or anything else never proposes. */
  capacityMode: string;
  /** ISO timestamp the decision was served. */
  decidedAt: string;
  /** True when an enforce comparison already ran for this decision. Compared
   * rows are settled and never propose, however old. */
  comparedToEnforce?: boolean;
  /** Capacity source id (the lane), e.g. `"subscriptions"`. Null = unknown.
   * Carried through for routing only. */
  lane?: string | null;
  /** Operator-defined lane label. Null = unknown. Carried through. */
  laneLabel?: string | null;
  /** Opaque model id served on the lane. Null = unknown. Carried through. */
  modelId?: string | null;
}

/** A propose-only record: "look at this unenforced decision". No action. */
export interface UnenforcedDecisionProposal {
  decisionId: string;
  /** How old the decision was at detection, in milliseconds. */
  ageMs: number;
  lane: string | null;
  laneLabel: string | null;
  modelId: string | null;
  /** ISO detection time (the normalized `now`). */
  detectedAt: string;
}

export interface DetectUnenforcedDecisionsOptions {
  /** ISO detection time. Defaults to the current time. */
  now?: string;
  /** Age at or beyond which an uncompared advise decision proposes. Default
   * 5 minutes (the `maxSnapshotAgeMs` shadow-window default). Must be finite
   * and positive — anything else proposes nothing. */
  staleAfterMs?: number;
}

/** Default staleness horizon: the 5-minute shadow-window default. */
export const UNENFORCED_DECISION_DEFAULT_AFTER_MS = 300_000;

/** Minimal logger surface: only `info` is ever called. */
export interface UnenforcedDecisionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface EmitUnenforcedDecisionsOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

const SHADOW_MODE = "shadow";

function parseMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNow(now: string | undefined): number | null {
  if (now === undefined) return Date.now();
  return parseMs(now);
}

function normalizeThreshold(staleAfterMs: number | undefined): number | null {
  const threshold = staleAfterMs ?? UNENFORCED_DECISION_DEFAULT_AFTER_MS;
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
    ? threshold
    : null;
}

/**
 * Flag advise (shadow) decisions older than the window with no enforce
 * comparison.
 *
 * Pure: no I/O, no config reads, no live state. The input rows are never
 * mutated. Returns one proposal record per stale unenforced decision, in
 * input order. Non-shadow rows, compared rows, rows with no usable timestamp,
 * and rows dated in the future (clock skew) never propose.
 */
export function detectUnenforcedDecisions(
  rows: readonly AdviseDecisionRow[],
  options?: DetectUnenforcedDecisionsOptions,
): UnenforcedDecisionProposal[] {
  const nowMs = normalizeNow(options?.now);
  const threshold = normalizeThreshold(options?.staleAfterMs);
  if (nowMs === null || threshold === null || !Array.isArray(rows)) return [];

  const proposals: UnenforcedDecisionProposal[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const decisionId = nullableString(row.id);
    if (decisionId === null) continue;
    if (row.capacityMode !== SHADOW_MODE) continue;
    if (row.comparedToEnforce === true) continue;

    const decidedMs = parseMs(row.decidedAt);
    if (decidedMs === null) continue;
    const ageMs = nowMs - decidedMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;
    if (ageMs < threshold) continue;

    proposals.push({
      decisionId,
      ageMs,
      lane: nullableString(row.lane),
      laneLabel: nullableString(row.laneLabel),
      modelId: nullableString(row.modelId),
      detectedAt: new Date(nowMs).toISOString(),
    });
  }
  return proposals;
}

/**
 * Emit unenforced-decision proposals to logs behind the `enabled` flag
 * (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off
 * (or absent), or with an empty proposal list, the logger is never called.
 * Never throws on a logger failure: a proposal emit must not fault a
 * caller, so a throwing logger reads as "not emitted" (`false`).
 */
export function emitUnenforcedDecisions(
  logger: UnenforcedDecisionLogger,
  proposals: readonly UnenforcedDecisionProposal[],
  options?: EmitUnenforcedDecisionsOptions,
): boolean {
  if (options?.enabled !== true) return false;
  if (!Array.isArray(proposals) || proposals.length === 0) return false;
  try {
    logger.info(
      `Watchdog unenforced-decision: ${proposals.length} advise decision(s) past the shadow window with no enforce comparison (propose-only).`,
      { proposals: [...proposals] },
    );
  } catch {
    return false;
  }
  return true;
}
