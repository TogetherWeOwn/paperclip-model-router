import type { CapacityWindow } from "./types.js";

// Headroom-per-hour burn-rate readout for Muse lanes (read-only).
//
// A weekly allowance is destroyed at reset, so the pacing question this
// answers is purely quantitative: how much of the remaining weekly headroom
// can each Muse lane spend per hour before the reset and still land inside
// the allowance?
//
//   burnRate = remainingFraction / hoursToReset
//
// where `remainingFraction` is `1 - utilization` of the lane's weekly window
// and `hoursToReset` is the wall-clock gap between `asOf` and the window's
// `resetsAt` (the 10-05 weekly reset).
//
// Countdown-input reuse (TOG-14078 owns the countdown display): this readout
// reads the SAME inputs the countdown slice reads — window `utilization`,
// window `resetsAt`, and the `asOf` clock — and nothing else. It never
// renders, formats, or returns a reset countdown (`resetInSeconds`,
// "in N hours", ticking display): that display stays owned by the countdown
// slice. This module returns a rate per lane plus a ranking, not a time.
//
// Read-only by construction: pure arithmetic over caller-supplied lane
// states. No config read, no telemetry fetch, no host call, no admission,
// pacing, or enforce change. Fixture and synthetic inputs only.

export type MuseBurnRateReason = "ok" | "no-computable-window" | "window-already-elapsed";

/**
 * One Muse lane's weekly-window state. `utilization` and `resetsAt` are the
 * countdown slice's inputs; `asOf` is the clock the readout is taken at.
 * Prefer the lane's weekly `CapacityWindow` fields verbatim: `utilization`
 * from `window.utilization`, `resetsAt` from `window.resetsAt`.
 */
export interface MuseLaneBurnRateInput {
  laneId: string;
  /** Fraction of the weekly allowance consumed, 0-1. Null when unmeasured. */
  utilization: number | null;
  /** Weekly-window reset instant (ISO). Null when the window reports none. */
  resetsAt: string | null;
  /** Instant the readout is taken at (ISO). */
  asOf: string;
}

export interface MuseLaneBurnRate {
  laneId: string;
  utilization: number | null;
  /** Headroom left in the weekly window: `1 - utilization`. Negative means overdrawn. */
  remainingFraction: number | null;
  resetsAt: string | null;
  /** Wall-clock hours from `asOf` to `resetsAt`. Null when uncomputable. */
  hoursToReset: number | null;
  /**
   * Spendable headroom per hour. Null when there is nothing to rate.
   * Negative means the lane already burned past its allowance.
   */
  burnRate: number | null;
  reason: MuseBurnRateReason;
}

const MS_PER_HOUR = 3_600_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTime(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Rate a single Muse lane. Never throws on dirty input: unmeasurable lanes
 * report `burnRate: null` with the reason why, never a guess.
 */
export function museLaneBurnRate(input: MuseLaneBurnRateInput): MuseLaneBurnRate {
  const utilization = finite(input.utilization);
  const resetMs = parseTime(input.resetsAt);
  const asOfMs = parseTime(input.asOf);
  if (utilization === null || resetMs === null || asOfMs === null) {
    return {
      laneId: input.laneId,
      utilization,
      remainingFraction: utilization === null ? null : 1 - utilization,
      resetsAt: input.resetsAt,
      hoursToReset: null,
      burnRate: null,
      reason: "no-computable-window",
    };
  }
  const hoursToReset = (resetMs - asOfMs) / MS_PER_HOUR;
  if (!(hoursToReset > 0)) {
    return {
      laneId: input.laneId,
      utilization,
      remainingFraction: 1 - utilization,
      resetsAt: input.resetsAt,
      hoursToReset,
      burnRate: null,
      reason: "window-already-elapsed",
    };
  }
  const remainingFraction = 1 - utilization;
  return {
    laneId: input.laneId,
    utilization,
    remainingFraction,
    resetsAt: input.resetsAt,
    hoursToReset,
    burnRate: remainingFraction / hoursToReset,
    reason: "ok",
  };
}

/**
 * Rank Muse lanes by burn rate ascending: the tightest headroom-per-hour
 * first, unratable lanes (`burnRate: null`) last in input order. The input
 * array is never mutated; the returned rows are fresh objects owned by the
 * caller. The ranking carries no countdown field: countdown display stays
 * with the countdown slice.
 */
export function rankMuseLaneBurnRates(lanes: MuseLaneBurnRateInput[]): MuseLaneBurnRate[] {
  const rated = lanes.map((lane) => ({ lane, rated: museLaneBurnRate(lane) }));
  const indexed = rated.map((entry, index) => ({ ...entry, index }));
  indexed.sort((a, b) => {
    if (a.rated.burnRate === null && b.rated.burnRate === null) return a.index - b.index;
    if (a.rated.burnRate === null) return 1;
    if (b.rated.burnRate === null) return -1;
    if (a.rated.burnRate !== b.rated.burnRate) return a.rated.burnRate - b.rated.burnRate;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.rated);
}

/**
 * Build the readout input for a Muse lane straight from its weekly
 * `CapacityWindow` (same fields the countdown slice reads). Returns null
 * when the lane reports no weekly window: absence of a window is not a
 * zero-headroom lane.
 */
export function museLaneInputFromWeeklyWindow(
  laneId: string,
  windows: CapacityWindow[],
  asOf: string,
): MuseLaneBurnRateInput | null {
  const weekly = windows.find((window) => window.name === "weekly") ?? null;
  if (weekly === null) return null;
  return { laneId, utilization: weekly.utilization, resetsAt: weekly.resetsAt, asOf };
}
