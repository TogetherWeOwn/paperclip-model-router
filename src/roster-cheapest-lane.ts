/**
 * Propose-only T2/T3 cheapest-lane audit over a frozen roster snapshot.
 *
 * For each audited tier, this answers three questions on fixtures: which
 * eligible row is cheapest, is it lane-bound to a known lane, and what gaps
 * remain. It changes nothing: no pin, no roster write, no enforce flip, no
 * live catalogue read, no telemetry fetch. Durable allocation fixes belong on
 * the model-selection track; this module only produces the readout a proposal
 * note can quote verbatim.
 *
 * Tier mapping: the T2/T3 labels live in model-selection vocabulary. This
 * repo's ladder is small/standard/strong/frontier (`src/engine/types.ts`), so
 * T2 -> `strong` and T3 -> `frontier` — the same mapping the dead-lane
 * probe uses.
 *
 * Eligibility mirrors the selector's static ceiling (`src/engine/select.ts`):
 * an enabled row serves a tier request when its own tier is at or below the
 * ceiling. Cost order mirrors the selector's baseline comparator (expected
 * cost at the default 8k-in/2k-out mix, quality breaks ties, then id), so the
 * reported cheapest is the row the static policy would serve. Quality-floor,
 * capability, context-window, capacity, pace, pin, sticky, budget, and
 * fallback gates are deliberately out of scope: this is roster coverage, not
 * a routing rehearsal.
 *
 * Lane-bound presence mirrors the roster row-contract guard
 * (`src/roster/contract.ts`): an enabled row should bind a known lane, and an
 * enabled cheapest row without one is an unpinned default.
 */

import { MODEL_TIER_ORDER, type ModelTier } from "./engine/types.js";

/** Audit vocabulary: T2 in model-selection terms. */
export const T2_TIER: ModelTier = "strong";

/** Audit vocabulary: T3 in model-selection terms. */
export const T3_TIER: ModelTier = "frontier";

/** Default audited tiers when the caller names none: T2 then T3. */
export const DEFAULT_AUDIT_TIERS: readonly ModelTier[] = [T2_TIER, T3_TIER];

/** Default token mix, kept identical to the selector's costing constants. */
export const CHEAPEST_LANE_DEFAULT_INPUT_TOKENS = 8_000;
export const CHEAPEST_LANE_DEFAULT_OUTPUT_TOKENS = 2_000;

/** One frozen assembled-roster row. Extra fields are ignored. */
export interface CheapestLaneRow {
  id: string;
  /** Serving tier. A value outside the ladder is ineligible for every tier. */
  tier: string;
  enabled: boolean;
  costPerMTokIn: number;
  costPerMTokOut: number;
  /** Tie-break only, mirroring the selector's baseline comparator. */
  quality?: number;
  /** Lane binding, when known. Carried into the readout. */
  laneId?: string | null;
}

export interface CheapestLaneAuditInput {
  /** Frozen roster rows. Never the live catalogue. */
  rows: CheapestLaneRow[];
  /** Frozen known lane ids. */
  lanes: string[];
  /** Tiers to audit, in readout order. Defaults to T2 then T3. */
  tiers?: ModelTier[];
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export type TierGapCode =
  | "no-eligible-row"
  | "cheapest-unpinned"
  | "cheapest-unknown-lane"
  | "no-lane-bound-rows"
  | "tier-has-no-enabled-rows";

export interface TierGap {
  code: TierGapCode;
  detail: string;
}

/** Readout for one audited tier. */
export interface TierCheapestLane {
  tier: ModelTier;
  /** Enabled rows at or below the ceiling. */
  eligibleCount: number;
  /** Of those, rows bound to a known lane. */
  laneBoundCount: number;
  /** Cheapest eligible row id, or null when nothing is eligible. */
  cheapestModelId: string | null;
  /** Its lane when bound to a known lane, else null. */
  cheapestLaneId: string | null;
  /** Its expected cost at the audit mix, or null when nothing is eligible. */
  cheapestExpectedCostUsd: number | null;
  gaps: TierGap[];
}

function knownTierIndex(tier: string): number | null {
  const index = MODEL_TIER_ORDER.indexOf(tier as ModelTier);
  return index === -1 ? null : index;
}

function expectedCostUsd(
  row: CheapestLaneRow,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * row.costPerMTokIn +
    (outputTokens / 1_000_000) * row.costPerMTokOut
  );
}

function gap(code: TierGapCode, detail: string): TierGap {
  return { code, detail };
}

/**
 * Audit each requested tier over frozen rows. Returns one readout per tier
 * in the requested order. Pure: no I/O, no catalogue read, no mutation of
 * the input.
 */
export function auditCheapestLanePerTier(input: CheapestLaneAuditInput): TierCheapestLane[] {
  const knownLanes = new Set(input.lanes);
  const tiers = input.tiers ?? [...DEFAULT_AUDIT_TIERS];
  const inputTokens = input.estimatedInputTokens ?? CHEAPEST_LANE_DEFAULT_INPUT_TOKENS;
  const outputTokens = input.estimatedOutputTokens ?? CHEAPEST_LANE_DEFAULT_OUTPUT_TOKENS;

  return tiers.map((tier) => {
    const ceiling = knownTierIndex(tier);
    const eligible =
      ceiling === null
        ? []
        : input.rows
            .filter((row) => {
              if (!row.enabled) return false;
              const rowTier = knownTierIndex(row.tier);
              return rowTier !== null && rowTier <= ceiling;
            })
            .map((row) => ({ row, cost: expectedCostUsd(row, inputTokens, outputTokens) }))
            // Baseline order: cheapest first, quality breaks ties, then id.
            .sort((a, b) => a.cost - b.cost || (b.row.quality ?? 0) - (a.row.quality ?? 0) || a.row.id.localeCompare(b.row.id));

    const laneBoundCount = eligible.filter(
      (entry) => typeof entry.row.laneId === "string" && knownLanes.has(entry.row.laneId),
    ).length;

    if (eligible.length === 0) {
      return {
        tier,
        eligibleCount: 0,
        laneBoundCount: 0,
        cheapestModelId: null,
        cheapestLaneId: null,
        cheapestExpectedCostUsd: null,
        gaps: [gap("no-eligible-row", `tier ${tier}: no enabled row at or below the ceiling`)],
      };
    }

    const cheapest = eligible[0]!;
    const laneId = typeof cheapest.row.laneId === "string" && cheapest.row.laneId.length > 0 ? cheapest.row.laneId : null;
    const gaps: TierGap[] = [];
    if (laneId === null) {
      gaps.push(gap("cheapest-unpinned", `tier ${tier}: cheapest eligible row ${cheapest.row.id} has no lane binding`));
    } else if (!knownLanes.has(laneId)) {
      gaps.push(gap("cheapest-unknown-lane", `tier ${tier}: cheapest eligible row ${cheapest.row.id} binds unknown lane ${laneId}`));
    }
    if (laneBoundCount === 0) {
      gaps.push(gap("no-lane-bound-rows", `tier ${tier}: none of the ${eligible.length} eligible rows bind a known lane`));
    }
    if (!input.rows.some((row) => row.enabled && row.tier === tier)) {
      gaps.push(
        gap("tier-has-no-enabled-rows", `tier ${tier}: no enabled row sits at the tier; coverage comes only from below-ceiling rows`),
      );
    }

    return {
      tier,
      eligibleCount: eligible.length,
      laneBoundCount,
      cheapestModelId: cheapest.row.id,
      cheapestLaneId: laneId !== null && knownLanes.has(laneId) ? laneId : null,
      cheapestExpectedCostUsd: cheapest.cost,
      gaps,
    };
  });
}
