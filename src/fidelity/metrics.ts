/**
 * Routing-fidelity metrics (TOG-11796, design TOG-11780 §8).
 *
 * Pure computation over already-fetched rows: no API access here, so the
 * spec pins the arithmetic on synthetic fixtures instead of live data.
 *
 * Interim decision source: the issue's CURRENT pin (`assigneeAdapterOverrides
 * .adapterConfig.model`), because `contextSnapshot.modelDecision` does not
 * exist yet (TOG-11792). The report must carry that caveat — see
 * `FIDELITY_CAVEAT`. When the hook ships, the caller passes the per-run
 * decision model instead of the pin model and the caveat goes away; this
 * module does not change.
 */

import { modelsMatch } from "./normalize.js";

export interface FidelityRunRow {
  issueId: string;
  wakeReason: string | null;
  /** Raw `usage_json.model`; null when the run reported none. */
  reportedModel: string | null;
  errorCode: string | null;
}

export interface FidelityPin {
  /** Raw pin model; null when the issue is unpinned. */
  model: string | null;
  hasSecretRefEnv: boolean;
}

/** The §2.2 stale-pin failure: a pin made for agent A kept after reassignment to B. */
const ESCAPE_ERROR = "configuration_incomplete";

export const FIDELITY_CAVEAT =
  "Interim pin-vs-run proxy: each run is compared with the pin as it is now, " +
  "not the pin at run time. Re-point at contextSnapshot.modelDecision once TOG-11792 ships.";

export interface FidelityReport {
  totalRuns: number;
  /** Share of issue-bound runs that carry a decision (interim: a pin). */
  routedRuns: number;
  routedShare: number;
  /** Runs with no reported model — counted separately, never as matches (§8). */
  noModelRuns: number;
  /** Normalized reported == decision, over routed runs that reported a model. */
  fidelityMatches: number;
  fidelityDenominator: number;
  fidelity: number;
  fidelityNoModelRuns: number;
  firstRunTotal: number;
  firstRunDecided: number;
  firstRunCoverage: number;
  /** Runs failed with the stale-pin error — the measurable escape of the pin regime. */
  escapedRuns: number;
  escapedIssueIds: string[];
  pinsTotal: number;
  staleSecretPins: number;
  caveat: string;
}

export function computeFidelity(
  rows: FidelityRunRow[],
  pins: Map<string, FidelityPin>,
): FidelityReport {
  let routedRuns = 0;
  let noModelRuns = 0;
  let fidelityMatches = 0;
  let fidelityDenominator = 0;
  let fidelityNoModelRuns = 0;
  let firstRunTotal = 0;
  let firstRunDecided = 0;
  let escapedRuns = 0;
  const escapedIssueIds: string[] = [];

  for (const row of rows) {
    const pin = pins.get(row.issueId);
    const decided = pin?.model != null && pin.model !== "";
    if (row.reportedModel == null || row.reportedModel === "") {
      noModelRuns += 1;
      if (decided) {
        routedRuns += 1;
        fidelityNoModelRuns += 1;
      }
    } else if (decided) {
      routedRuns += 1;
      fidelityDenominator += 1;
      if (modelsMatch(row.reportedModel, pin.model)) fidelityMatches += 1;
    }
    if (row.wakeReason === "issue_assigned") {
      firstRunTotal += 1;
      if (decided) firstRunDecided += 1;
    }
    if (row.errorCode === ESCAPE_ERROR) {
      escapedRuns += 1;
      if (escapedIssueIds.length < 50 && !escapedIssueIds.includes(row.issueId)) {
        escapedIssueIds.push(row.issueId);
      }
    }
  }

  let pinsTotal = 0;
  let staleSecretPins = 0;
  for (const pin of pins.values()) {
    if (pin.model != null && pin.model !== "") {
      pinsTotal += 1;
      if (pin.hasSecretRefEnv) staleSecretPins += 1;
    }
  }

  const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

  return {
    totalRuns: rows.length,
    routedRuns,
    routedShare: ratio(routedRuns, rows.length),
    noModelRuns,
    fidelityMatches,
    fidelityDenominator,
    fidelity: ratio(fidelityMatches, fidelityDenominator),
    fidelityNoModelRuns,
    firstRunTotal,
    firstRunDecided,
    firstRunCoverage: ratio(firstRunDecided, firstRunTotal),
    escapedRuns,
    escapedIssueIds,
    pinsTotal,
    staleSecretPins,
    caveat: FIDELITY_CAVEAT,
  };
}
