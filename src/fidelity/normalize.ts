/**
 * Routing-fidelity model-name normalization (TOG-11796).
 *
 * Design doc TOG-11780 §8: fidelity compares the run's reported model
 * (`usage_json.model`) with the decided model. The two sides arrive in
 * different naming schemes — the roster holds canonical deploy IDs
 * (`claude-sonnet-5`) while runs and pins carry versioned or
 * provider-decorated variants (`claude-sonnet-5-5`,
 * `muse-spark-1.3-contributor(xhigh)`, `gpt-6.1-sol`).
 *
 * Two rules keep this honest:
 *
 * 1. The alias table is EXPLICIT and versioned here. A variant maps to a
 *    canonical ID only when a row says so.
 * 2. Unknown IDs are NEVER coerced. An unrecognized name normalizes to
 *    itself (minus any effort suffix), so a comparison involving it can only
 *    match on exact raw equality. Guessing a canonical ID for an unknown
 *    name would launder a misreport into a plausible-looking match — the
 *    same reason `normalizeUsage` rejects out-of-range fractions instead of
 *    clamping them.
 */

const EFFORT_SUFFIX = /\([^()]*\)\s*$/;

/**
 * Canonical deploy IDs for runtime variants observed in the fleet. Each row
 * must name a real roster ID; nothing here is derived by pattern.
 */
const ALIASES: Record<string, string> = {
  // Versioned Claude deploys served under the sonnet-5 roster entry.
  "claude-sonnet-5-5": "claude-sonnet-5",
  // Agent-default Muse build served under the contributor-free roster entry.
  "muse-spark-1.3-contributor": "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor": "muse-spark-1.2-contributor-free",
  // sol lane build served under the gpt-5.6-sol roster entry.
  "gpt-6.1-sol": "gpt-5.6-sol",
};

/** Strip one trailing effort suffix such as `(xhigh)`. A bare `()` is kept: it is not an effort marker. */
export function stripEffortSuffix(raw: string): string {
  const match = raw.match(EFFORT_SUFFIX);
  if (!match || match[0] === "()") return raw;
  return raw.slice(0, raw.length - match[0].length).trimEnd();
}

/**
 * Normalize one reported model name to its canonical roster ID. Returns null
 * for empty input; unknown IDs survive unchanged (see module doc).
 */
export function normalizeModelName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const stripped = stripEffortSuffix(raw.trim());
  if (stripped === "") return null;
  return ALIASES[stripped] ?? stripped;
}

/** True when the run's reported model equals the decided model after normalization. Null on either side never matches. */
export function modelsMatch(
  reported: string | null | undefined,
  decided: string | null | undefined,
): boolean {
  const left = normalizeModelName(reported);
  const right = normalizeModelName(decided);
  return left !== null && right !== null && left === right;
}
