/**
 * Pure pinned-vs-unpinned mix computation for the model-mix snapshot job.
 *
 * A run is "pinned" when its issue currently carries an
 * assigneeAdapterOverrides.adapterConfig.model string. This is the same
 * interim current-pin proxy the routing-fidelity job uses: the per-run
 * decision record does not exist yet, so the mix joins runs to CURRENT
 * issue pins, not the pin at run time.
 *
 * Kept side-effect free so the snapshot script stays a thin reader and the
 * counting rules are pinned by unit tests.
 */

/**
 * @param {Array<{ contextSnapshot?: { issueId?: string }, usageJson?: { model?: string } }>} rows
 * @param {Map<string, string | null>} pins  issue id -> current pin model or null
 */
export function computeModelMix(rows, pins) {
  let pinnedRuns = 0;
  let unpinnedRuns = 0;
  let unresolvableRuns = 0;
  let noModelRuns = 0;
  const pinnedIssues = new Set();
  const unpinnedIssues = new Set();
  const reportedModelCounts = new Map();
  const unpinnedReportedModelCounts = new Map();

  for (const r of rows) {
    const issueId = r?.contextSnapshot?.issueId;
    if (!issueId || !pins.has(issueId)) {
      unresolvableRuns += 1;
      continue;
    }
    const reported =
      typeof r?.usageJson?.model === "string" && r.usageJson.model !== "" ? r.usageJson.model : null;
    if (reported == null) {
      noModelRuns += 1;
    } else {
      reportedModelCounts.set(reported, (reportedModelCounts.get(reported) ?? 0) + 1);
    }
    const pin = pins.get(issueId);
    if (pin == null || pin === "") {
      unpinnedRuns += 1;
      unpinnedIssues.add(issueId);
      if (reported) {
        unpinnedReportedModelCounts.set(reported, (unpinnedReportedModelCounts.get(reported) ?? 0) + 1);
      }
    } else {
      pinnedRuns += 1;
      pinnedIssues.add(issueId);
    }
  }

  const issueBound = pinnedRuns + unpinnedRuns;
  const desc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    pinnedRuns,
    unpinnedRuns,
    unresolvableRuns,
    noModelRuns,
    issueBound,
    pinnedShareOfIssueBound: issueBound ? pinnedRuns / issueBound : null,
    unpinnedShareOfIssueBound: issueBound ? unpinnedRuns / issueBound : null,
    pinnedIssues: pinnedIssues.size,
    unpinnedIssues: unpinnedIssues.size,
    reportedModelCounts: Object.fromEntries(desc(reportedModelCounts)),
    unpinnedReportedModelCounts: Object.fromEntries(desc(unpinnedReportedModelCounts)),
  };
}
