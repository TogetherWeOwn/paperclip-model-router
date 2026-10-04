import type { LaneBurnDown } from "./burn-down.js";

// Per-lane burn-rate alert thresholds evaluated on fixture snapshots.
//
// A burn projection answers "if this account keeps burning at its
// window-average rate, where does it land at reset relative to the 98-100%
// band" (`projected = utilization / elapsed`, see burn-down.ts). These
// thresholds turn that spot readout into propose-only alert levels per lane
// family — Claude, Codex, Muse — so a hot lane pages before it exhausts and
// a cool lane flags waste before its allowance is destroyed at reset.
//
// Propose-only by construction: pure detection over an already-evaluated
// readout, plus a flag-gated emit to an injected logger. No config read, no
// host call, no pacing or selection change, no host-script change. Non-goals
// (owned elsewhere): hysteresis deadbands, weekly-vs-five-hour precedence,
// fleet-mix flip guards, and the shadow-emit path.
//
// Threshold table (projected end-of-window utilization):
//
//   lane    watch  warn  critical  cool(<)   why
//   claude  1.10   1.30  3.00      0.85      two-account weighted mix with one
//                                                 exhausted account; warn just
//                                                 above the observed hot account
//   codex   1.50   2.50  4.00      0.85      fixtures burn hottest (3-4.5x), so
//                                                 warn/critical sit higher to
//                                                 keep the signal actionable
//   muse    1.20   1.50  2.50      0.90      use-before-expiry sink with the
//                                                 nearest reset: watch starts
//                                                 earliest, cool edge tightest
//
// The Muse lane is evaluated on the weekly single-account `kimi` fixture
// shape (the established hotter-burn proxy: the calibration vectors note the
// Muse lane burns hotter and denies one step earlier). When a dedicated
// `muse` lane document lands, rebind the lane id without moving thresholds.
// Unknown lane ids resolve to the Muse (tightest) entry: propose-only errs
// toward visibility, never toward silence.

/** Alert severity for one account's burn projection. */
export type BurnAlertLevel = "cool" | "watch" | "warn" | "critical";

export type BurnAlertReason =
  | "below-cool-threshold"
  | "above-watch-threshold"
  | "above-warn-threshold"
  | "above-critical-threshold";

export interface BurnAlertThresholds {
  /** Projected >= this proposes `watch`. */
  overWatch: number;
  /** Projected >= this proposes `warn`. */
  overWarn: number;
  /** Projected >= this proposes `critical`. */
  overCritical: number;
  /** Projected <= this proposes `cool` (allowance waste). */
  underCool: number;
}

/** Per-lane-family threshold table. The module default; callers may pass a
 * per-call override without moving it (see BurnAlertPolicy). */
export const BURN_ALERT_THRESHOLDS: Record<"claude" | "codex" | "muse", BurnAlertThresholds> = {
  claude: { overWatch: 1.1, overWarn: 1.3, overCritical: 3.0, underCool: 0.85 },
  codex: { overWatch: 1.5, overWarn: 2.5, overCritical: 4.0, underCool: 0.85 },
  muse: { overWatch: 1.2, overWarn: 1.5, overCritical: 2.5, underCool: 0.9 },
};

export type BurnAlertLane = keyof typeof BURN_ALERT_THRESHOLDS;

export interface BurnAlertPolicy {
  /** Per-call threshold overrides. Partial per lane; `"default"` applies to
   * lanes without their own entry. Never mutates BURN_ALERT_THRESHOLDS. */
  thresholds?: Partial<Record<BurnAlertLane | "default", Partial<BurnAlertThresholds>>>;
}

/** A propose-only record: "look at this lane account". No action, no mutation. */
export interface BurnAlertProposal {
  laneId: string;
  accountKey: string;
  projected: number;
  level: BurnAlertLevel;
  reason: BurnAlertReason;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ordered(thresholds: BurnAlertThresholds): boolean {
  return (
    thresholds.underCool < thresholds.overWatch &&
    thresholds.overWatch <= thresholds.overWarn &&
    thresholds.overWarn <= thresholds.overCritical
  );
}

function laneKeyFor(laneId: string): BurnAlertLane {
  const lane = laneId.toLowerCase();
  if (lane.includes("claude")) return "claude";
  if (lane.includes("codex")) return "codex";
  // The weekly single-account `kimi` fixture is the Muse lane's burn proxy
  // until a dedicated muse lane document lands; anything unrecognized takes
  // the tightest (Muse) entry so propose-only errs toward visibility.
  return "muse";
}

/**
 * Resolve the effective thresholds for a lane id: table entry merged with
 * any per-call override. A non-finite or misordered override is not an alert
 * policy, so resolution falls back to the table entry (fail-neutral). The
 * returned object is always a fresh copy; the table is never mutated.
 */
export function thresholdsForLane(laneId: string, policy?: BurnAlertPolicy): BurnAlertThresholds {
  const key = laneKeyFor(laneId);
  const base = BURN_ALERT_THRESHOLDS[key];
  const override = policy?.thresholds?.[key] ?? policy?.thresholds?.default;
  if (!override) return { ...base };
  const merged: BurnAlertThresholds = { ...base, ...override };
  if (
    finite(merged.overWatch) === null ||
    finite(merged.overWarn) === null ||
    finite(merged.overCritical) === null ||
    finite(merged.underCool) === null ||
    !ordered(merged)
  ) {
    return { ...base };
  }
  return merged;
}

/**
 * Propose burn alerts for every account of an already-evaluated lane
 * readout. Each account is judged against its lane's thresholds from its own
 * projection, so a hot account cannot hide behind a cool peer and vice
 * versa. Accounts without a computable projection report nothing, never a
 * guess. Pure: the input readout is never mutated; proposals return in
 * account order.
 */
export function detectBurnAlerts(readout: LaneBurnDown, policy?: BurnAlertPolicy): BurnAlertProposal[] {
  if (!readout || typeof readout !== "object" || !Array.isArray(readout.accounts)) return [];
  const thresholds = thresholdsForLane(readout.laneId, policy);
  const proposals: BurnAlertProposal[] = [];
  for (const account of readout.accounts) {
    const projected = finite(account?.projected);
    if (projected === null) continue;
    if (projected >= thresholds.overCritical) {
      proposals.push({ laneId: readout.laneId, accountKey: account.accountKey, projected, level: "critical", reason: "above-critical-threshold" });
    } else if (projected >= thresholds.overWarn) {
      proposals.push({ laneId: readout.laneId, accountKey: account.accountKey, projected, level: "warn", reason: "above-warn-threshold" });
    } else if (projected >= thresholds.overWatch) {
      proposals.push({ laneId: readout.laneId, accountKey: account.accountKey, projected, level: "watch", reason: "above-watch-threshold" });
    } else if (projected <= thresholds.underCool) {
      proposals.push({ laneId: readout.laneId, accountKey: account.accountKey, projected, level: "cool", reason: "below-cool-threshold" });
    }
  }
  return proposals;
}

/** Minimal logger surface: only `info` is ever called. */
export interface BurnAlertLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface EmitBurnAlertProposalsOptions {
  /**
   * Gate for the emit. Default `false`: the verb stays silent unless the
   * caller explicitly opts in. There is no global default to flip — each
   * call site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

/**
 * Emit burn proposals to logs behind the `enabled` flag (default off).
 *
 * Returns `true` iff exactly one log line was emitted. With the flag off
 * (or absent), or with an empty proposal list, the logger is never called.
 * Never throws on a logger failure: a proposal emit must not fault a
 * caller, so a throwing logger reads as "not emitted" (`false`).
 */
export function emitBurnAlertProposals(
  logger: BurnAlertLogger,
  proposals: readonly BurnAlertProposal[],
  options?: EmitBurnAlertProposalsOptions,
): boolean {
  if (options?.enabled !== true) return false;
  if (!Array.isArray(proposals) || proposals.length === 0) return false;
  try {
    logger.info(
      `Watchdog lane-burn: ${proposals.length} account(s) past burn alert thresholds (propose-only).`,
      { proposals: [...proposals] },
    );
  } catch {
    return false;
  }
  return true;
}
