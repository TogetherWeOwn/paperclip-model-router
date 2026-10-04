/**
 * Flag-gated routing-misfire log verb (log only, no live mutation).
 *
 * A routing misfire is one observed serving that visibly struggled — model
 * thrashing, dropped tool calls, a wrong answer that had to be redone, or a
 * tier-vs-model mismatch on an issue. This verb answers one question on
 * fixtures: "what misfire record would be appended to the routing-misfire
 * channel?" It builds the record and — behind an explicit flag — emits it to
 * an injected logger. The record carries the channel's reporting fields (the
 * issue id and its tier label, the model that actually ran, what went wrong)
 * so a future sink can append it verbatim.
 *
 * Propose-only: this module never re-pins a model, never touches routing
 * state, and never reaches the capacity path. It takes no plugin context,
 * reads no live state, performs no `ctx` call, resolves no secret, and
 * assigns no channel — the channel stays a passive log with no owner. There
 * is deliberately no worker wiring: the verb exists so tests can pin the
 * record shape and the flag-off silence before anything is ever allowed near
 * the live path. Durable allocation fixes belong on the model-selection
 * track, not here.
 *
 * Flag: `EmitRoutingMisfireOptions.enabled`, default `false` (off). When off,
 * `emitRoutingMisfire` is a no-op that never calls the logger. When on, it
 * calls `logger.info` exactly once with the record fields.
 */

/** Log-only sink name carried on every record. */
export const ROUTING_MISFIRE_CHANNEL = "routing-misfire";

/** What the caller observed struggling. Extra row fields are ignored. */
export interface RoutingMisfireInput {
  /** Issue the misfire was observed on (e.g. `"TOG-1234"`). Required. */
  issueId: string;
  /** Tier label of that issue, when known. Null/empty reads as unknown. */
  tier?: string | null;
  /** Model that actually ran (the serving model, not an assigned label). Required. */
  modelId: string;
  /** What went wrong: thrashing, dropped tool calls, wrong output, redo, or a
   * tier-vs-model mismatch. Required. */
  symptom: string;
  /** Free-form detail. Null/empty reads as absent. */
  detail?: string | null;
}

/** The appended channel record: normalized input plus sink name and timestamp. */
export interface RoutingMisfireRecord {
  /** Always {@link ROUTING_MISFIRE_CHANNEL}. Names the passive log sink. */
  channel: string;
  issueId: string;
  /** Tier label, or null when unknown. */
  tier: string | null;
  modelId: string;
  symptom: string;
  /** Detail, or null when absent. */
  detail: string | null;
  /** ISO observation time (the normalized `now`). */
  observedAt: string;
}

export interface BuildRoutingMisfireOptions {
  /** ISO observation time. Defaults to the current time; an unparseable value
   * falls back to the current time (never to a null timestamp). */
  now?: string;
}

export interface EmitRoutingMisfireOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each call
   * site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

/** Minimal logger surface: only `info` is ever called. */
export interface RoutingMisfireLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Upper bound on short identifying fields, matching the repo's error hygiene. */
export const ROUTING_MISFIRE_FIELD_MAX_LENGTH = 512;

/** Upper bound on the free-form detail (channel norm: each report stays short). */
export const ROUTING_MISFIRE_DETAIL_MAX_LENGTH = 2000;

function cleanRequired(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function cleanOptional(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeNow(now: string | undefined): string {
  if (typeof now === "string") {
    const ms = Date.parse(now);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Build the misfire record for the channel shape. Pure: no I/O, no config
 * reads, no live state. The input object is never mutated.
 *
 * Returns `null` when a required field (issue id, serving model, symptom) is
 * missing or blank — an unattributed record must never be appended. Optional
 * fields read as null when absent or blank.
 */
export function buildRoutingMisfire(
  input: RoutingMisfireInput,
  options?: BuildRoutingMisfireOptions,
): RoutingMisfireRecord | null {
  if (!input || typeof input !== "object") return null;
  const issueId = cleanRequired(input.issueId, ROUTING_MISFIRE_FIELD_MAX_LENGTH);
  const modelId = cleanRequired(input.modelId, ROUTING_MISFIRE_FIELD_MAX_LENGTH);
  const symptom = cleanRequired(input.symptom, ROUTING_MISFIRE_FIELD_MAX_LENGTH);
  if (issueId === null || modelId === null || symptom === null) return null;
  return {
    channel: ROUTING_MISFIRE_CHANNEL,
    issueId,
    tier: cleanOptional(input.tier, ROUTING_MISFIRE_FIELD_MAX_LENGTH),
    modelId,
    symptom,
    detail: cleanOptional(input.detail, ROUTING_MISFIRE_DETAIL_MAX_LENGTH),
    observedAt: normalizeNow(options?.now),
  };
}

/**
 * Emit one misfire record to logs behind the `enabled` flag (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off (or
 * absent), or with a null record, the logger is never called — this is the
 * guarantee the flag-off tests pin. Never throws on a logger failure: a
 * misfire emit must not fault a caller, so a throwing logger reads as "not
 * emitted" (`false`).
 */
export function emitRoutingMisfire(
  logger: RoutingMisfireLogger,
  record: RoutingMisfireRecord | null,
  options?: EmitRoutingMisfireOptions,
): boolean {
  if (options?.enabled !== true) return false;
  if (!record || typeof record !== "object") return false;
  try {
    logger.info(
      `Routing misfire: ${record.issueId} served by ${record.modelId} (${record.symptom}).`,
      {
        channel: record.channel,
        issueId: record.issueId,
        tier: record.tier,
        modelId: record.modelId,
        symptom: record.symptom,
        detail: record.detail,
        observedAt: record.observedAt,
      },
    );
  } catch {
    return false;
  }
  return true;
}
