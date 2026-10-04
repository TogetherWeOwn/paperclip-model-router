/**
 * Flag-gated enforce preflight: refuse enforce while the shadow window is stale.
 *
 * A shadow window is fresh while at least one shadow evidence sample was
 * observed within the last N minutes; otherwise it is stale and enforce must
 * not run on it — enforce without fresh shadow evidence would lock in a
 * decision the shadow path has not recently corroborated. This verb answers
 * one question on fixtures: "may enforce proceed on this shadow window?" It
 * returns a verdict record only: it takes timestamped samples, returns a
 * verdict, and never touches live state — it takes no plugin context, reads no
 * `ctx.state`/`ctx.db`, performs no `ctx.http` call, resolves no secret, and
 * mutates nothing. There is deliberately no worker or select wiring: the verb
 * exists so tests can pin the stale-vs-fresh boundary before anything is ever
 * allowed near the live path.
 *
 * Flag: `ShadowWindowPreflightOptions.enabled`, default `false` (off). When
 * off, the verdict always allows enforce (`reason: "disabled"`), so current
 * behavior is preserved until a caller explicitly opts in. When on, samples
 * with an `observedAt` age strictly greater than `freshWithinMs` are stale; a
 * window with no usable fresh sample refuses enforce
 * (`reason: "shadow-window-stale"`).
 *
 * Time source: the caller passes `now` (ISO). Samples carry `observedAt`
 * (ISO); unparseable timestamps are indeterminate, not evidence of freshness —
 * such samples are skipped, in the same spirit as the unenforced-decision
 * detector's indeterminate handling. Samples dated in the future (clock skew)
 * never grant freshness either: they are skipped, so a skewed clock fails
 * closed to `shadow-window-stale` rather than opening enforce.
 */

/** One shadow evidence observation: a shadow decision the window can cite. */
export interface ShadowEvidenceSample {
  /** ISO timestamp the shadow evidence was observed. Extra fields ignored. */
  observedAt: string;
}

export interface ShadowWindowPreflightOptions {
  /**
   * Gate for the conjunct. Default `false`: the verdict allows enforce unless
   * the caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
  /** ISO detection time. Defaults to the current time. */
  now?: string;
  /**
   * A window whose freshest usable sample is older than this (ms) is stale.
   * Default {@link SHADOW_WINDOW_DEFAULT_FRESH_WITHIN_MS}. Must be finite and
   * positive — anything else falls back to the default so a bad caller can
   * neither withdraw the world (stale-always) nor bless it (fresh-always).
   */
  freshWithinMs?: number;
}

/** Default freshness horizon: the 5-minute shadow-window default. */
export const SHADOW_WINDOW_DEFAULT_FRESH_WITHIN_MS = 300_000;

export type ShadowWindowPreflightReason =
  | "disabled"
  | "fresh"
  | "shadow-window-stale";

export interface ShadowWindowPreflightVerdict {
  /** True when enforce may proceed on this shadow window. */
  allowEnforce: boolean;
  /** Machine-readable reason: "disabled" | "fresh" | "shadow-window-stale". */
  reason: ShadowWindowPreflightReason;
  /**
   * Age of the freshest usable sample at detection, in milliseconds. Null when
   * the flag is off or no sample carried a usable, non-future timestamp.
   */
  freshAgeMs: number | null;
  /** ISO detection time (the normalized `now`). Null when `now` is unparseable. */
  detectedAt: string | null;
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
    return SHADOW_WINDOW_DEFAULT_FRESH_WITHIN_MS;
  }
  return Math.floor(freshWithinMs);
}

/**
 * Judge whether enforce may proceed on a shadow window.
 *
 * Pure: no I/O, no config reads, no live state. The input samples are never
 * mutated. With the flag off the verdict always allows enforce. With the flag
 * on, the verdict allows enforce iff at least one sample carries a usable,
 * non-future timestamp no older than `freshWithinMs`.
 */
export function checkShadowWindow(
  samples: readonly ShadowEvidenceSample[],
  options?: ShadowWindowPreflightOptions,
): ShadowWindowPreflightVerdict {
  const nowMs = normalizeNow(options?.now);
  if (options?.enabled !== true) {
    return {
      allowEnforce: true,
      reason: "disabled",
      freshAgeMs: null,
      detectedAt: nowMs === null ? null : new Date(nowMs).toISOString(),
    };
  }
  if (nowMs === null || !Array.isArray(samples)) {
    return { allowEnforce: false, reason: "shadow-window-stale", freshAgeMs: null, detectedAt: null };
  }
  const threshold = normalizeThreshold(options?.freshWithinMs);
  let freshest: number | null = null;
  for (const sample of samples) {
    if (!sample || typeof sample !== "object") continue;
    const observedMs = parseMs(sample.observedAt);
    if (observedMs === null) continue;
    const ageMs = nowMs - observedMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;
    if (freshest === null || ageMs < freshest) freshest = ageMs;
  }
  if (freshest === null || freshest > threshold) {
    return {
      allowEnforce: false,
      reason: "shadow-window-stale",
      freshAgeMs: freshest,
      detectedAt: new Date(nowMs).toISOString(),
    };
  }
  return {
    allowEnforce: true,
    reason: "fresh",
    freshAgeMs: freshest,
    detectedAt: new Date(nowMs).toISOString(),
  };
}
