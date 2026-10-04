/**
 * Propose-only fleet-mix guard for the pinned-vs-unpinned snapshot.
 *
 * Compares two mix snapshots (see scripts/lib/model-mix.mjs and
 * docs/operator/model-mix-drift-threshold.md) and emits a proposal record
 * when the unpinned fleet-default share flips beyond threshold. This module
 * never touches routing, config, or scheduling: the output is a plain record
 * for a human or a later job to read.
 *
 * Alert conditions (either triggers, per the threshold note):
 *  1. the unpinned run share moves more than `unpinnedShareMovePp`
 *     percentage points between the two snapshots (default 5, strict >);
 *  2. the top entry of the unpinned reported-model breakdown flips model
 *     family between the two snapshots.
 */

export const DEFAULT_UNPINNED_SHARE_MOVE_PP = 5;

export const PROPOSAL_TEXT =
  "Re-read the routing-fidelity readout for the same window; no routing change (propose-only). " +
  "A fleet-default move under an unpinned-heavy mix is a fleet signal, not a router regression on its own.";

/**
 * Reduce a reported model string to its family for flip comparison.
 * Strips a trailing "(...)" effort qualifier, lowercases, splits on
 * separators, and drops trailing version segments (pure numbers, dots
 * allowed). Examples: "muse-spark(xhigh)" -> "muse-spark",
 * "muse-canary(xhigh)" -> "muse-canary", "claude-sonnet-5-5" -> "claude-sonnet".
 *
 * @param {unknown} model
 * @returns {string | null} family, or null when the input has no usable text
 */
export function modelFamily(model) {
  if (typeof model !== "string") return null;
  const stripped = model.replace(/\(.*?\)\s*$/, "").trim().toLowerCase();
  if (!stripped) return null;
  const parts = stripped.split(/[^a-z0-9]+/).filter(Boolean);
  while (parts.length > 1 && /^[0-9.]+$/.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return null;
  return parts.join("-");
}

/**
 * @param {Record<string, number> | null | undefined} counts
 * @returns {string | null} top model by count (ties keep insertion order), or null when empty
 */
export function topModel(counts) {
  if (!counts || typeof counts !== "object") return null;
  let best = null;
  let bestCount = -Infinity;
  for (const [model, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    if (n > bestCount) {
      best = model;
      bestCount = n;
    }
  }
  return best;
}

/**
 * @param {{ unpinnedShareOfIssueBound?: number | null, unpinnedReportedModelCounts?: Record<string, number> | null }} snapshot
 * @param {{ unpinnedShareMovePp?: number }} [options]
 */
export function evaluateMixGuard(prev, curr, options = {}) {
  const threshold = options.unpinnedShareMovePp ?? DEFAULT_UNPINNED_SHARE_MOVE_PP;
  const reasons = [];

  const prevShare = typeof prev?.unpinnedShareOfIssueBound === "number" ? prev.unpinnedShareOfIssueBound : null;
  const currShare = typeof curr?.unpinnedShareOfIssueBound === "number" ? curr.unpinnedShareOfIssueBound : null;
  const finiteShares =
    typeof prevShare === "number" && Number.isFinite(prevShare) && typeof currShare === "number" && Number.isFinite(currShare);
  // Rounded to 1e-6 pp so binary float noise (e.g. 0.92 - 0.87 reading
  // as 5.000000000000004) cannot flip the strictly-greater comparison.
  const unpinnedShareDeltaPp = finiteShares
    ? Math.round((currShare - prevShare) * 100 * 1e6) / 1e6
    : null;
  if (unpinnedShareDeltaPp !== null && Math.abs(unpinnedShareDeltaPp) > threshold) {
    reasons.push("unpinned-share-move");
  }

  const prevTopModel = topModel(prev?.unpinnedReportedModelCounts);
  const currTopModel = topModel(curr?.unpinnedReportedModelCounts);
  const prevTopFamily = prevTopModel === null ? null : modelFamily(prevTopModel);
  const currTopFamily = currTopModel === null ? null : modelFamily(currTopModel);
  if (prevTopFamily !== null && currTopFamily !== null && prevTopFamily !== currTopFamily) {
    reasons.push("top-family-flip");
  }

  const triggered = reasons.length > 0;
  return {
    triggered,
    reasons,
    unpinnedShareDeltaPp,
    prevTopModel,
    currTopModel,
    prevTopFamily,
    currTopFamily,
    thresholdPp: threshold,
    proposal: triggered ? PROPOSAL_TEXT : null,
  };
}
