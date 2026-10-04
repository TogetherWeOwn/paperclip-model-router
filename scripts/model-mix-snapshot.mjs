#!/usr/bin/env node
/**
 * Model-mix drift snapshot (read-only).
 *
 * Counts pinned-vs-unpinned heartbeat runs over a window using the same
 * per-agent paging as the routing-fidelity job: one newest-1000 page per
 * agent, dedupe by run id, window applied client-side on `createdAt`
 * (see scripts/lib/heartbeat-runs.mjs for why offset/cursor paging does
 * not work on this endpoint).
 *
 * A run is "pinned" when its issue currently carries an
 * assigneeAdapterOverrides.adapterConfig.model string. This is the same
 * interim current-pin proxy the fidelity job uses: the per-run decision
 * record does not exist yet, so the mix is issue-pin state joined to runs,
 * not the pin at run time.
 *
 * Unpinned runs execute under the fleet-wide agent default model, which
 * flips between model families in short blocks; an unpinned-heavy mix
 * therefore drifts with the fleet default rather than with router policy.
 * See the threshold note printed with --markdown.
 *
 * Usage:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/model-mix-snapshot.mjs --hours 24 [--until ISO] [--markdown out.md]
 */

import { collectRuns } from "./lib/heartbeat-runs.mjs";
import { computeModelMix } from "./lib/model-mix.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => {
    if (!a.startsWith("--")) return [];
    const eq = a.indexOf("=");
    if (eq > 0) return [[a.slice(2, eq), a.slice(eq + 1)]];
    const next = all[i + 1];
    return [[a.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }),
);

const API = (process.env.PAPERCLIP_API_URL || "").replace(/\/$/, "");
const KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID || "";
if (!API || !KEY || !COMPANY) {
  console.error("model-mix-snapshot: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(2);
}

const HOURS = Number(args.hours ?? 24);

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

const untilMs = args.until === undefined ? Date.now() : Date.parse(args.until);
if (!Number.isFinite(untilMs)) {
  console.error(`model-mix-snapshot: --until must be an ISO timestamp, got ${args.until}`);
  process.exit(2);
}
const sinceMs = untilMs - HOURS * 3600 * 1000;

const {
  rows,
  distinctRuns,
  agentsScanned,
  duplicateRowsDropped,
  undatedRows,
  truncatedAgents,
} = await collectRuns({ api, companyId: COMPANY, sinceMs, untilMs });

for (const a of truncatedAgents) {
  console.warn(
    `model-mix-snapshot: WARNING ${a.name ?? a.agentId} returned a full page of ${a.rows} runs reaching back only to ${a.oldestFetched}; ` +
      `its older in-window runs are not counted`,
  );
}

const issueIds = [...new Set(rows.map((r) => r?.contextSnapshot?.issueId).filter(Boolean))];
const pins = new Map();
const CONCURRENCY = 8;
for (let i = 0; i < issueIds.length; i += CONCURRENCY) {
  const chunk = await Promise.all(
    issueIds.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        return [id, await api(`/api/issues/${id}`)];
      } catch {
        return [id, null];
      }
    }),
  );
  for (const [id, issue] of chunk) {
    const model = issue?.assigneeAdapterOverrides?.adapterConfig?.model;
    pins.set(id, typeof model === "string" && model !== "" ? model : null);
  }
}

const mix = computeModelMix(rows, pins);
const { pinnedRuns, unpinnedRuns, unresolvableRuns, noModelRuns, issueBound } = mix;
const { pinnedIssues, unpinnedIssues } = mix;
const reportedModelCounts = new Map(Object.entries(mix.reportedModelCounts));
const unpinnedReportedModelCounts = new Map(Object.entries(mix.unpinnedReportedModelCounts));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const created = rows.map((r) => Date.parse(r?.createdAt ?? "")).filter(Number.isFinite);
const output = {
  windowHours: HOURS,
  windowUntil: new Date(untilMs).toISOString(),
  generatedAt: new Date().toISOString(),
  windowOldest: created.length ? new Date(Math.min(...created)).toISOString() : null,
  windowNewest: created.length ? new Date(Math.max(...created)).toISOString() : null,
  distinctRuns,
  agentsScanned,
  duplicateRowsDropped,
  undatedRows,
  truncatedAgents,
  distinctIssues: issueIds.length,
  pinnedRuns,
  unpinnedRuns,
  unresolvableRuns,
  noModelRuns,
  pinnedShareOfIssueBound: issueBound ? pinnedRuns / issueBound : null,
  unpinnedShareOfIssueBound: issueBound ? unpinnedRuns / issueBound : null,
  pinnedIssues,
  unpinnedIssues,
  reportedModelCounts: Object.fromEntries([...reportedModelCounts.entries()].sort((a, b) => b[1] - a[1])),
  unpinnedReportedModelCounts: Object.fromEntries(
    [...unpinnedReportedModelCounts.entries()].sort((a, b) => b[1] - a[1]),
  ),
  method:
    "per-agent newest-1000 paging with client-side window; pin = current issue adapterConfig.model (interim proxy, not pin at run time); unpinned runs follow the flipping fleet default",
};
console.log(JSON.stringify(output, null, 2));

if (args.markdown) {
  const md = [
    `# Model-mix snapshot — last ${HOURS} h`,
    ``,
    `Generated ${output.generatedAt}. Window ${output.windowOldest} → ${output.windowNewest} (${distinctRuns} distinct runs, ${agentsScanned} agents, ${issueIds.length} issues).`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Pinned runs | ${pinnedRuns}/${issueBound} (${pct(pinnedRuns, issueBound)}) |`,
    `| Unpinned runs | ${unpinnedRuns}/${issueBound} (${pct(unpinnedRuns, issueBound)}) |`,
    `| Pinned issues | ${pinnedIssues} |`,
    `| Unpinned issues | ${unpinnedIssues} |`,
    `| Unresolvable (no issue join) | ${unresolvableRuns} |`,
    `| No-model runs (counted separately) | ${noModelRuns} |`,
    ``,
    `## Reported-model breakdown (usageJson.model, run time)`,
    ``,
    ...[...reportedModelCounts.entries()].map(([m, n]) => `- ${m}: ${n}`),
    ``,
    `## Unpinned reported-model breakdown`,
    ``,
    ...[...unpinnedReportedModelCounts.entries()].map(([m, n]) => `- ${m}: ${n}`),
    ``,
    `## Method and drift-alert threshold`,
    ``,
    `Method: one newest-1000 heartbeat-runs page per agent, deduped by run id, windowed client-side on createdAt.`,
    `Pin = the issue's CURRENT adapterConfig.model; the per-run decision record does not exist yet, so this is the same interim proxy the fidelity job uses.`,
    `Unpinned runs execute under the fleet-wide agent default model, which flips between model families in short blocks: an unpinned-heavy mix drifts with the fleet default, not with router policy.`,
    ``,
    `Drift-alert threshold (proposed): alert when the 24 h unpinned run share moves more than 5 percentage points week-over-week, or when the unpinned reported-model top entry flips family between consecutive daily snapshots. Either condition means the fleet default moved under an unpinned-heavy mix; neither implies a router regression on its own.`,
    ...(truncatedAgents.length
      ? [
          ``,
          `Truncated agents (older in-window runs not counted):`,
          ...truncatedAgents.map((a) => `- ${a.name ?? a.agentId}: ${a.rows} runs, oldest fetched ${a.oldestFetched}`),
        ]
      : []),
    ``,
  ].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.markdown, md);
  console.error(`markdown: ${args.markdown}`);
}
