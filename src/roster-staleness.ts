/**
 * Propose-only assembled-roster staleness detector: a roster snapshot older
 * than the freshness threshold, or one that fails regenerate-and-diff.
 *
 * The assembled roster is the serving-relevant projection of config: which
 * model rows exist, on which tiers, enabled or not, bound to which lane. It
 * goes stale two ways: time (the snapshot was assembled longer ago than the
 * freshness horizon, so config may have moved on) and drift (reassembling
 * from the same inputs yields different rows, so the snapshot no longer
 * describes what assembly would serve). Either condition answers one
 * question on snapshots: "this roster snapshot should be re-examined — who
 * should look at it?" The answer is a verdict record only.
 *
 * This module never refreshes, never re-pins, never enforces: it takes a
 * snapshot plus a caller-supplied pure regenerate function, returns a
 * verdict, and — behind an explicit flag — emits it to an injected logger.
 * It takes no plugin context, reads no `ctx.state`/`ctx.db`, performs no
 * `ctx.http` call, resolves no secret, and mutates nothing. There is
 * deliberately no worker, assembler, or select wiring: the verb exists so
 * tests can pin the fresh-vs-stale-vs-diff-mismatch boundary before anything
 * is ever allowed near the live path. Durable fixes belong to the roster
 * owner; this detector only proposes.
 *
 * Distinct from the sibling detectors: the shadow-gap detector judges
 * shadow-decision evidence freshness for the enforce preflight, and the
 * quota-expiry detector judges budget/quota lifetimes. This detector judges
 * only roster-assembly freshness — snapshot age against a horizon, and
 * snapshot content against a regeneration. Each keeps its own reason
 * strings, so a firing here is never confused with a firing there.
 *
 * Flag: `CheckAssembledRosterOptions.enabled`, default `false` (off). When
 * off, the verdict never proposes (`reason: "disabled"`), so current
 * behavior is preserved until a caller explicitly opts in.
 *
 * Time source: the caller passes `now` (ISO). The snapshot carries
 * `assembledAt` (ISO); an unparseable timestamp is indeterminate, not
 * evidence of staleness — such snapshots never propose, in the same spirit
 * as the shadow-window preflight's indeterminate handling. Snapshots dated
 * in the future (clock skew) never propose on age either: they are
 * indeterminate, so a skewed clock fails closed to silence rather than
 * proposing on every snapshot.
 */

export type RosterStalenessReason =
  | "disabled"
  | "fresh"
  | "roster-stale-age"
  | "roster-diff-mismatch"
  | "indeterminate";

/** One serving-relevant roster row. Extra fields are ignored by the diff. */
export interface RosterSnapshotRow {
  /** Stable row id; rows are matched across snapshots by this key. */
  id: string;
  /** Serving tier, when known. Carried into the diff. */
  tier?: string;
  /** Whether the row can serve. Carried into the diff. */
  enabled?: boolean;
  /** Lane binding, when known. Carried into the diff. */
  laneId?: string | null;
}

/** The assembled snapshot under test. Extra fields are ignored. */
export interface RosterSnapshot {
  /** ISO timestamp the roster was assembled. */
  assembledAt: string;
  /** Rows the assembly produced. */
  rows: readonly RosterSnapshotRow[];
}

export interface CheckAssembledRosterOptions {
  /**
   * Gate for the detector. Default `false`: the verdict never proposes
   * unless the caller explicitly opts in. There is no global default to
   * flip — each call site passes its own flag, so live routing cannot
   * inherit an "on".
   */
  enabled?: boolean;
  /** ISO detection time. Defaults to the current time. */
  now?: string;
  /**
   * A snapshot assembled longer ago than this (ms) is stale by age.
   * Default {@link ROSTER_DEFAULT_FRESH_WITHIN_MS}. Must be finite and
   * positive — anything else falls back to the default so a bad caller can
   * neither propose on everything (stale-always) nor bless it (fresh-always).
   */
  freshWithinMs?: number;
}

/** Default freshness horizon: one hour. Roster assembly is config-driven,
 * not per-request, so its freshness bound is looser than the 5-minute
 * shadow window and the 30-minute run-stall silence. */
export const ROSTER_DEFAULT_FRESH_WITHIN_MS = 60 * 60 * 1_000;

/** Row-level regenerate-and-diff evidence. Empty means the regeneration
 * reproduces the snapshot exactly. */
export interface RosterDiff {
  /** Ids present in the regeneration but absent from the snapshot. */
  added: string[];
  /** Ids present in the snapshot but absent from the regeneration. */
  removed: string[];
  /** Ids present in both but with different serving fields. */
  changed: string[];
}

export interface RosterStalenessVerdict {
  /** True when the snapshot should be re-examined (proposal fires). */
  propose: boolean;
  /**
   * Machine-readable reason: "disabled" | "fresh" |
   * "roster-stale-age" | "roster-diff-mismatch" | "indeterminate".
   */
  reason: RosterStalenessReason;
  /**
   * Age of the snapshot at detection, in milliseconds. Null when the flag
   * is off, or when `now`/`assembledAt` carries no usable timestamp.
   */
  snapshotAgeMs: number | null;
  /**
   * Regenerate-and-diff evidence. Null when no regenerate function was
   * supplied, when the flag is off, or when regeneration is indeterminate.
   * Present (possibly empty) otherwise — including on age-stale verdicts,
   * so an age firing still carries the content evidence.
   */
  diff: RosterDiff | null;
  /** ISO detection time (the normalized `now`). Null when unparseable. */
  detectedAt: string | null;
}

/** Minimal logger surface: only `info` is ever called. */
export interface RosterStalenessLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface EmitRosterStalenessOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

function parseMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeNow(now: string | undefined): number | null {
  if (now === undefined) return Date.now();
  return parseMs(now);
}

function normalizeThreshold(freshWithinMs: number | undefined): number {
  if (
    typeof freshWithinMs !== "number" ||
    !Number.isFinite(freshWithinMs) ||
    freshWithinMs <= 0
  ) {
    return ROSTER_DEFAULT_FRESH_WITHIN_MS;
  }
  return Math.floor(freshWithinMs);
}

function rowKey(row: RosterSnapshotRow): string | null {
  if (!row || typeof row !== "object") return null;
  return typeof row.id === "string" && row.id.length > 0 ? row.id : null;
}

/** Serving-relevant projection: the fields the diff compares. */
function rowShape(row: RosterSnapshotRow): string {
  return JSON.stringify({
    tier: typeof row.tier === "string" ? row.tier : null,
    enabled: typeof row.enabled === "boolean" ? row.enabled : null,
    laneId:
      typeof row.laneId === "string" && row.laneId.length > 0 ? row.laneId : null,
  });
}

/**
 * Diff snapshot rows against regenerated rows by stable id.
 *
 * Pure: no I/O, no config reads. Neither input is mutated. Rows without a
 * usable string id are ignored on both sides (they cannot be matched, so
 * they are indeterminate, not evidence of drift). Duplicate ids collapse to
 * the last occurrence on each side.
 */
export function diffRosterRows(
  snapshotRows: readonly RosterSnapshotRow[],
  regeneratedRows: readonly RosterSnapshotRow[],
): RosterDiff {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  if (Array.isArray(snapshotRows)) {
    for (const row of snapshotRows) {
      const key = rowKey(row);
      if (key !== null) before.set(key, rowShape(row as RosterSnapshotRow));
    }
  }
  if (Array.isArray(regeneratedRows)) {
    for (const row of regeneratedRows) {
      const key = rowKey(row);
      if (key !== null) after.set(key, rowShape(row as RosterSnapshotRow));
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, shape] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== shape) changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  return { added, removed, changed };
}

function diffIsEmpty(diff: RosterDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * Judge whether an assembled roster snapshot should be re-examined.
 *
 * Pure except for invoking the caller-supplied `regenerate`, which must
 * itself be pure (fixtures in tests). A `regenerate` that throws reads as
 * indeterminate — no diff evidence, no proposal on content — so a broken
 * test double fails closed to silence rather than proposing on every
 * snapshot. The input snapshot is never mutated. With the flag off the
 * verdict never proposes.
 */
export function checkAssembledRoster(
  snapshot: RosterSnapshot,
  regenerate: (() => readonly RosterSnapshotRow[]) | null | undefined,
  options?: CheckAssembledRosterOptions,
): RosterStalenessVerdict {
  const nowMs = normalizeNow(options?.now);
  if (options?.enabled !== true) {
    return {
      propose: false,
      reason: "disabled",
      snapshotAgeMs: null,
      diff: null,
      detectedAt: nowMs === null ? null : new Date(nowMs).toISOString(),
    };
  }
  if (nowMs === null || !snapshot || typeof snapshot !== "object") {
    return {
      propose: false,
      reason: "indeterminate",
      snapshotAgeMs: null,
      diff: null,
      detectedAt: null,
    };
  }
  const assembledMs = parseMs(snapshot.assembledAt);
  if (assembledMs === null) {
    return {
      propose: false,
      reason: "indeterminate",
      snapshotAgeMs: null,
      diff: null,
      detectedAt: new Date(nowMs).toISOString(),
    };
  }
  const ageMs = nowMs - assembledMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      propose: false,
      reason: "indeterminate",
      snapshotAgeMs: null,
      diff: null,
      detectedAt: new Date(nowMs).toISOString(),
    };
  }
  const threshold = normalizeThreshold(options?.freshWithinMs);

  let diff: RosterDiff | null = null;
  if (typeof regenerate === "function") {
    try {
      const regenerated = regenerate();
      diff = diffRosterRows(
        Array.isArray(snapshot.rows) ? snapshot.rows : [],
        Array.isArray(regenerated) ? regenerated : [],
      );
    } catch {
      diff = null;
    }
  }

  if (ageMs > threshold) {
    return {
      propose: true,
      reason: "roster-stale-age",
      snapshotAgeMs: ageMs,
      diff,
      detectedAt: new Date(nowMs).toISOString(),
    };
  }
  if (diff !== null && !diffIsEmpty(diff)) {
    return {
      propose: true,
      reason: "roster-diff-mismatch",
      snapshotAgeMs: ageMs,
      diff,
      detectedAt: new Date(nowMs).toISOString(),
    };
  }
  return {
    propose: false,
    reason: "fresh",
    snapshotAgeMs: ageMs,
    diff,
    detectedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Emit a proposing verdict to logs behind the `enabled` flag (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off
 * (or absent), with a non-proposing verdict, or with a malformed verdict,
 * the logger is never called. Never throws on a logger failure: a proposal
 * emit must not fault a caller, so a throwing logger reads as "not
 * emitted" (`false`).
 */
export function emitRosterStaleness(
  logger: RosterStalenessLogger,
  verdict: RosterStalenessVerdict,
  options?: EmitRosterStalenessOptions,
): boolean {
  if (options?.enabled !== true) return false;
  if (!verdict || typeof verdict !== "object" || verdict.propose !== true) return false;
  try {
    logger.info(
      `Watchdog roster-staleness: assembled roster snapshot needs re-examination (${verdict.reason}) (propose-only).`,
      { verdict: { ...verdict } },
    );
  } catch {
    return false;
  }
  return true;
}
