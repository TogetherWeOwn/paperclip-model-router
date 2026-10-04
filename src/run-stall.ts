/**
 * Propose-only run-stall detector: runs stuck `in_progress` with no heartbeat
 * beyond N minutes.
 *
 * A stalled run answers one question on snapshots: "this run still reads
 * `in_progress`, but nothing has been heard from it for longer than the
 * stall threshold — who should look at it?" The answer is a proposal
 * record only. This module never retries, never mutates, never calls the
 * recovery writer: it takes run snapshots, returns proposal records, and —
 * behind an explicit flag — emits them to an injected logger. Production
 * wiring (scheduled reads, routing to the same sink as the other detectors)
 * is deliberately out of scope; this verb exists so tests can pin the
 * stalled-vs-active-vs-finished boundary before anything is allowed near
 * the live path.
 *
 * Flag: `EmitRunStallProposalsOptions.enabled`, default `false` (off).
 * When off, `emitRunStallProposals` is a no-op that never calls the logger.
 *
 * Time source: the caller passes `now` (ISO). Callers map the run's latest
 * heartbeat timestamp into `lastHeartbeatAt`; a run that never beat carries
 * `null` and falls back to `createdAt`. Unparseable timestamps are
 * indeterminate, not evidence of a stall — such rows are skipped, in the
 * same spirit as the catalogue probe's indeterminate handling.
 */

/** Minimal run snapshot the detector reads. Extra row fields are ignored. */
export interface RunStallRow {
  /** Run id. Rows without one are skipped. */
  id: string;
  /** Owning agent, when known. Carried through for routing only. */
  agentId?: string | null;
  /** Issue the run works on, when known. Carried through for routing only. */
  issueId?: string | null;
  /** Only exactly `"in_progress"` is examined. Any other status — queued,
   * terminal, unknown — is out of scope and never proposed. */
  status: string;
  /** ISO timestamp the run started. Fallback beat when no heartbeat exists. */
  createdAt: string;
  /** ISO timestamp of the latest heartbeat, or null when never heard from. */
  lastHeartbeatAt?: string | null;
}

/** A propose-only record: "look at this run". No action, no mutation. */
export interface RunStallProposal {
  runId: string;
  agentId: string | null;
  issueId: string | null;
  /** How long the run had been silent at detection, in milliseconds. */
  stalledForMs: number;
  /** The beat the silence is measured from; null when the run never beat
   * (measured from `createdAt` instead). */
  lastHeartbeatAt: string | null;
  /** ISO detection time (the normalized `now`). */
  detectedAt: string;
}

export interface DetectRunStallsOptions {
  /** ISO detection time. Defaults to the current time. */
  now?: string;
  /** Silence beyond this many milliseconds proposes. Default 30 minutes.
   * Must be finite and positive — anything else proposes nothing. */
  stallAfterMs?: number;
}

/** Default stall threshold: 30 minutes of silence. */
export const RUN_STALL_DEFAULT_AFTER_MS = 30 * 60 * 1_000;

/** Minimal logger surface: only `info` is ever called. */
export interface RunStallLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface EmitRunStallProposalsOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

const IN_PROGRESS = "in_progress";

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

function normalizeThreshold(stallAfterMs: number | undefined): number | null {
  const threshold = stallAfterMs ?? RUN_STALL_DEFAULT_AFTER_MS;
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
    ? threshold
    : null;
}

/**
 * Flag runs stuck `in_progress` with no heartbeat beyond the threshold.
 *
 * Pure: no I/O, no config reads, no live state. The input rows are never
 * mutated. Returns one proposal record per stalled run, in input order.
 * Terminal or non-`in_progress` rows, rows with no usable timestamp, and
 * rows dated in the future (clock skew) never propose.
 */
export function detectRunStalls(
  rows: readonly RunStallRow[],
  options?: DetectRunStallsOptions,
): RunStallProposal[] {
  const nowMs = normalizeNow(options?.now);
  const threshold = normalizeThreshold(options?.stallAfterMs);
  if (nowMs === null || threshold === null || !Array.isArray(rows)) return [];

  const proposals: RunStallProposal[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const runId = nullableString(row.id);
    if (runId === null) continue;
    if (row.status !== IN_PROGRESS) continue;

    const beatMs = parseMs(row.lastHeartbeatAt) ?? parseMs(row.createdAt);
    if (beatMs === null) continue;
    const silentForMs = nowMs - beatMs;
    if (!Number.isFinite(silentForMs) || silentForMs < 0) continue;
    if (silentForMs < threshold) continue;

    proposals.push({
      runId,
      agentId: nullableString(row.agentId),
      issueId: nullableString(row.issueId),
      stalledForMs: silentForMs,
      lastHeartbeatAt: typeof row.lastHeartbeatAt === "string" && parseMs(row.lastHeartbeatAt) !== null
        ? (row.lastHeartbeatAt as string)
        : null,
      detectedAt: new Date(nowMs).toISOString(),
    });
  }
  return proposals;
}

/**
 * Emit stall proposals to logs behind the `enabled` flag (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off
 * (or absent), or with an empty proposal list, the logger is never called.
 * Never throws on a logger failure: a proposal emit must not fault a
 * caller, so a throwing logger reads as "not emitted" (`false`).
 */
export function emitRunStallProposals(
  logger: RunStallLogger,
  proposals: readonly RunStallProposal[],
  options?: EmitRunStallProposalsOptions,
): boolean {
  if (options?.enabled !== true) return false;
  if (!Array.isArray(proposals) || proposals.length === 0) return false;
  try {
    logger.info(
      `Watchdog run-stall: ${proposals.length} run(s) stalled with no heartbeat (propose-only).`,
      { proposals: [...proposals] },
    );
  } catch {
    return false;
  }
  return true;
}
