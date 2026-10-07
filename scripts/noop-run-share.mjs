#!/usr/bin/env node
/**
 * No-op run share: how many heartbeat runs woke for nothing.
 *
 * A no-op run is a succeeded run whose wake carried no new event and whose only
 * issue activity is monitor housekeeping or nothing; the classifier is a port of
 * the host rule (scripts/lib/monitor-housekeeping.mjs). Target: under 10% of
 * all runs. See scripts/lib/noop-run-share.mjs for the exact definitions.
 *
 * Reads, per agent, the newest 1000 runs (the list ignores `offset` and every
 * time param; see scripts/lib/heartbeat-runs.mjs), then for each issue that a
 * succeeded no-event run touched reads that issue's whole activity log from
 * `GET /api/issues/{id}/activity` and attributes rows to runs by `runId`.
 * `GET /api/companies/{id}/activity` cannot be used: it does not filter by run
 * and caps at 500 rows, so a busy issue would be silently under-attributed.
 *
 * Issues with a monitor armed right now are read too, so the monitor wake policy
 * counters (`issue.monitor_deferred`, `issue.monitor_deferral_shadowed`) also see
 * issues whose wake was deferred and had no run in the window.
 *
 * Usage:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/noop-run-share.mjs --hours 24 [--until ISO] [--markdown out.md]
 *
 * JSON goes to stdout, progress and warnings to stderr. Exit 2 on bad input,
 * 1 on a fatal read error.
 */

import { writeFileSync } from "node:fs";
import { collectRuns } from "./lib/heartbeat-runs.mjs";
import { buildReport, compactIssueRows, issuesNeedingActivity, renderMarkdown } from "./lib/noop-run-share.mjs";

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
  console.error("noop-run-share: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(2);
}

const HOURS = Number(args.hours ?? 24);
if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error(`noop-run-share: --hours must be a positive number, got ${args.hours}`);
  process.exit(2);
}
const untilMs = args.until === undefined ? Date.now() : Date.parse(args.until);
if (!Number.isFinite(untilMs)) {
  console.error(`noop-run-share: --until must be an ISO timestamp, got ${args.until}`);
  process.exit(2);
}
const sinceMs = untilMs - HOURS * 3600 * 1000;

const ACTIVITY_CONCURRENCY = 6;
const FETCH_ATTEMPTS = 3;

async function api(path) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
      if (res.ok) return await res.json();
      lastError = new Error(`GET ${path}: HTTP ${res.status}`);
      // A client error will not change on retry; a 429 or 5xx might.
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  throw lastError;
}

const { rows, distinctRuns, agentsScanned, duplicateRowsDropped, undatedRows, truncatedAgents } = await collectRuns({
  api,
  companyId: COMPANY,
  sinceMs,
  untilMs,
});
for (const a of truncatedAgents) {
  console.warn(
    `noop-run-share: WARNING ${a.name ?? a.agentId} returned a full page of ${a.rows} runs reaching back only to ${a.oldestFetched}; ` +
      `its older in-window runs are not counted`,
  );
}

const agentNames = new Map(
  (await api(`/api/companies/${COMPANY}/agents`)).map((agent) => [agent.id, agent.name ?? null]),
);

// Issues to read: those a succeeded no-event run touched (needed to classify),
// plus those with a monitor armed now (so deferral counters see deferred wakes
// that never became a run).
const issueIds = new Set(issuesNeedingActivity(rows));
let armedMonitorIssues = null;
try {
  const open = await api(`/api/companies/${COMPANY}/issues?status=in_progress,in_review&limit=1000`);
  armedMonitorIssues = (Array.isArray(open) ? open : []).filter((issue) => issue?.monitorNextCheckAt);
  for (const issue of armedMonitorIssues) issueIds.add(issue.id);
} catch (error) {
  console.warn(`noop-run-share: WARNING could not list armed monitors (${error.message}); deferral counters cover run-touched issues only`);
}

const activityByIssue = new Map();
let activityFailures = 0;
const queue = [...issueIds];
await Promise.all(
  Array.from({ length: ACTIVITY_CONCURRENCY }, async () => {
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      try {
        const activity = await api(`/api/issues/${id}/activity`);
        if (!Array.isArray(activity)) throw new Error("expected an array");
        activityByIssue.set(id, compactIssueRows(activity));
      } catch (error) {
        activityFailures += 1;
        activityByIssue.set(id, null);
        console.warn(`noop-run-share: WARNING issue ${id} activity unreadable (${error.message})`);
      }
    }
  }),
);

const report = buildReport({ runs: rows, activityByIssue, agentNames, sinceMs, untilMs, truncatedAgents });
const meta = {
  windowHours: HOURS,
  windowUntil: new Date(untilMs).toISOString(),
  windowSince: new Date(sinceMs).toISOString(),
  generatedAt: new Date().toISOString(),
  agentsScanned,
  duplicateRowsDropped,
  undatedRows,
  issuesRead: activityByIssue.size,
  issuesWithArmedMonitor: armedMonitorIssues?.length ?? null,
  activityFailures,
};
console.log(JSON.stringify({ ...meta, ...report }, null, 2));

if (args.markdown) {
  writeFileSync(args.markdown, renderMarkdown(report, meta));
  console.error(`markdown: ${args.markdown}`);
}
