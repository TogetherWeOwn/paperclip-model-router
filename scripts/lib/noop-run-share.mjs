/**
 * Pure classification and aggregation for scripts/noop-run-share.mjs.
 *
 * A run is a NO-OP when all of these hold:
 *   1. it succeeded;
 *   2. its wake carried no new event (a due check or a re-assertion, and no
 *      comment id; see `isNoEventWake`);
 *   3. it is bound to an issue, and the only activity attributed to it on that
 *      issue is monitor housekeeping (`issue.monitor_scheduled`, or an
 *      `issue.updated` that only touches monitor fields) or nothing at all.
 *
 * That is the host's own "no issue-visible progress" rule, so the number here
 * is the population the no-progress/no-event suppression and the monitor wake
 * policy are meant to remove. Everything the rule cannot see is kept out of
 * the numerator and reported next to it:
 * - unbound no-event runs (the host cannot evaluate progress without an issue);
 * - runs that did not succeed;
 * - runs whose issue activity could not be read;
 * - "comment-only" runs, whose single visible act is a comment. The host counts
 *   a comment as progress, so these are NOT no-ops here, but a "still waiting"
 *   note lands in this bucket, so it is the upper-bound companion figure.
 */

import {
  ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  isMonitorOnlyIssueUpdateDetails,
  isNoEventWake,
  isProgressRow,
  runIssueRows,
} from "./monitor-housekeeping.mjs";

export const TARGET_NOOP_SHARE = 0.1;

export const OUTCOMES = Object.freeze({
  EVENT_WAKE: "event_wake",
  UNSCOPED: "no_event_unscoped",
  NOT_SUCCEEDED: "no_event_not_succeeded",
  UNVERIFIED: "no_event_unverified",
  PROGRESS: "no_event_progress",
  COMMENT_ONLY: "no_event_comment_only",
  CHURN_ONLY: "no_event_churn_only",
  NOOP_HOUSEKEEPING: "noop_housekeeping",
  NOOP_NOTHING: "noop_nothing",
});

const NOOP_OUTCOMES = new Set([OUTCOMES.NOOP_HOUSEKEEPING, OUTCOMES.NOOP_NOTHING]);
// Wakes that carried no event and left nothing but a note and/or checkout churn.
const IDLE_OUTCOMES = new Set([...NOOP_OUTCOMES, OUTCOMES.COMMENT_ONLY, OUTCOMES.CHURN_ONLY]);

// NOT part of the host rule. Keys an `issue.updated` row carries when a run only
// checks the issue out and releases it (lock, start time, run ids). The host
// counts these as progress, so a monitor check that checks out, comments and
// re-arms never looks idle to it.
const CHECKOUT_EVENT_ACTION = "issue.checked_out";
const CHECKOUT_CHURN_KEYS = new Set([
  "startedAt",
  "executionRunId",
  "executionLockedAt",
  "executionAgentNameKey",
  "checkoutRunId",
]);

export const DEFERRAL_ACTIONS = Object.freeze({
  DEFERRED: "issue.monitor_deferred",
  SHADOWED: "issue.monitor_deferral_shadowed",
  TRIGGERED: "issue.monitor_triggered",
});

const KEPT_ACTIONS = new Set(Object.values(DEFERRAL_ACTIONS));

/** The wake reason as the host records it, `(none)` when absent. */
export function wakeReasonOf(run) {
  const reason = run?.contextSnapshot?.wakeReason;
  return typeof reason === "string" && reason.trim() !== "" ? reason : "(none)";
}

export function issueIdOf(run) {
  const id = run?.contextSnapshot?.issueId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Issues whose activity must be read to classify the window's runs. */
export function issuesNeedingActivity(runs) {
  const ids = new Set();
  for (const run of runs) {
    if (run?.status !== "succeeded") continue;
    if (!isNoEventWake(run.contextSnapshot)) continue;
    const issueId = issueIdOf(run);
    if (issueId) ids.add(issueId);
  }
  return [...ids];
}

/**
 * Reduce an issue's full activity to the rows this report reads, so a busy
 * issue's tool-gateway noise is not held in memory.
 */
export function compactIssueRows(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row || typeof row.action !== "string") continue;
    if (!KEPT_ACTIONS.has(row.action) && !ISSUE_PROGRESS_ACTIVITY_ACTIONS.has(row.action) && row.action !== CHECKOUT_EVENT_ACTION) continue;
    out.push({
      action: row.action,
      entityType: row.entityType ?? null,
      entityId: row.entityId ?? null,
      runId: row.runId ?? null,
      createdAt: row.createdAt ?? null,
      // Only `issue.updated` needs its details to be classified; the monitor
      // deferral rows keep theirs for the reason breakdown.
      details:
        row.action === "issue.updated" || row.action === DEFERRAL_ACTIONS.DEFERRED || row.action === DEFERRAL_ACTIONS.SHADOWED
          ? (row.details ?? null)
          : null,
    });
  }
  return out;
}

/**
 * Whether an `issue.updated` row is checkout churn plus monitor re-arm: it
 * touches only monitor and checkout keys, and a `status`/`completedAt` change
 * counts as churn only when the run's status did not net-change (checkout
 * flips it out and back).
 */
function isChurnOnlyUpdate(details, statusNetChanged) {
  const changes = details?.changes;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) return false;
  const remaining = Object.fromEntries(
    Object.entries(changes).filter(
      ([key]) => !CHECKOUT_CHURN_KEYS.has(key) && !((key === "status" || key === "completedAt") && !statusNetChanged),
    ),
  );
  return isMonitorOnlyIssueUpdateDetails({ changes: remaining });
}

function statusChangeOf(row) {
  const change = row?.details?.changes?.status;
  return change !== null && typeof change === "object" && !Array.isArray(change) ? change : null;
}

/** Whether the run left the issue in a different status than it had before checkout. */
function runStatusNetChanged(progress, issueRows, runId, issueId) {
  const byTime = (a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "");
  const statuses = progress
    .filter((row) => row.action === "issue.updated")
    .sort(byTime)
    .map(statusChangeOf)
    .filter(Boolean);
  if (statuses.length === 0) return false;

  const finalStatus = statuses.at(-1).to;
  if (finalStatus === undefined) return true;

  const checkout = issueRows
    .filter(
      (row) =>
        row.action === CHECKOUT_EVENT_ACTION &&
        row.runId === runId &&
        row.entityType === "issue" &&
        row.entityId === issueId,
    )
    .sort(byTime)[0];
  if (!checkout) return statuses[0].from !== finalStatus;

  const checkoutAt = Date.parse(checkout.createdAt ?? "");
  if (!Number.isFinite(checkoutAt)) return true;
  const statusBeforeCheckout = issueRows
    .filter(
      (row) =>
        row.action === "issue.updated" &&
        row.entityType === "issue" &&
        row.entityId === issueId &&
        Date.parse(row.createdAt ?? "") < checkoutAt,
    )
    .sort(byTime)
    .map(statusChangeOf)
    .filter(Boolean)
    .at(-1)?.to;

  // Unknown starting status is progress: only suppress a release whose return
  // to the pre-checkout status can be proven from issue activity.
  if (statusBeforeCheckout === undefined) return true;
  return statusBeforeCheckout !== finalStatus;
}

/** Progress rows that are more than a note or checkout churn. */
function substantiveRows(progress, issueRows, runId, issueId) {
  const statusNetChanged = runStatusNetChanged(progress, issueRows, runId, issueId);
  return progress.filter((row) => {
    if (row.action === "issue.comment_added") return false;
    if (row.action === "issue.updated") return !isChurnOnlyUpdate(row.details, statusNetChanged);
    return true;
  });
}

/**
 * @param {object} run                heartbeat run row
 * @param {object[] | null} issueRows compact activity rows of the run's issue, null when unreadable
 */
export function classifyRun(run, issueRows) {
  if (!isNoEventWake(run?.contextSnapshot)) return OUTCOMES.EVENT_WAKE;
  const issueId = issueIdOf(run);
  if (!issueId) return OUTCOMES.UNSCOPED;
  if (run.status !== "succeeded") return OUTCOMES.NOT_SUCCEEDED;
  if (!Array.isArray(issueRows)) return OUTCOMES.UNVERIFIED;

  const attributed = runIssueRows(issueRows, run.id, issueId);
  const progress = attributed.filter(isProgressRow);
  if (progress.length === 0) {
    return attributed.length === 0 ? OUTCOMES.NOOP_NOTHING : OUTCOMES.NOOP_HOUSEKEEPING;
  }
  if (substantiveRows(progress, issueRows, run.id, issueId).length > 0) return OUTCOMES.PROGRESS;
  return progress.every((row) => row.action === "issue.comment_added") ? OUTCOMES.COMMENT_ONLY : OUTCOMES.CHURN_ONLY;
}

const share = (num, den) => (den > 0 ? num / den : null);

const ZERO = () => ({ runs: 0, succeeded: 0, noEvent: 0, noop: 0, idle: 0 });

function tally(map, key) {
  let entry = map.get(key);
  if (!entry) {
    entry = ZERO();
    map.set(key, entry);
  }
  return entry;
}

function sortedObject(map, sortBy = "runs") {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1][sortBy] - a[1][sortBy] || (a[0] < b[0] ? -1 : 1)));
}

/** Monitor wake-policy counters from the compact rows inside [sinceMs, untilMs]. */
export function monitorPolicyCounts(activityByIssue, sinceMs, untilMs) {
  const counts = { deferred: 0, shadowed: 0, triggered: 0, deferredByReason: {}, issuesWithActivity: 0 };
  for (const rows of activityByIssue.values()) {
    if (!Array.isArray(rows)) continue;
    counts.issuesWithActivity += 1;
    for (const row of rows) {
      const at = Date.parse(row.createdAt ?? "");
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      if (row.action === DEFERRAL_ACTIONS.TRIGGERED) counts.triggered += 1;
      else if (row.action === DEFERRAL_ACTIONS.DEFERRED || row.action === DEFERRAL_ACTIONS.SHADOWED) {
        if (row.action === DEFERRAL_ACTIONS.DEFERRED) counts.deferred += 1;
        else counts.shadowed += 1;
        const reason = typeof row.details?.reason === "string" ? row.details.reason : "(unknown)";
        counts.deferredByReason[reason] = (counts.deferredByReason[reason] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * @param {object} input
 * @param {object[]} input.runs                        in-window runs (deduped)
 * @param {Map<string, object[] | null>} input.activityByIssue  compact rows per issue, null when unreadable
 * @param {Map<string, string>} [input.agentNames]
 * @param {number} input.sinceMs
 * @param {number} input.untilMs
 * @param {object[]} [input.truncatedAgents]           from collectRuns
 */
export function buildReport({ runs, activityByIssue, agentNames = new Map(), sinceMs, untilMs, truncatedAgents = [] }) {
  const byStatus = new Map();
  const byWakeReason = new Map();
  const byAgent = new Map();
  const byOutcome = new Map();

  // Run id -> issues where that run left real progress, across every issue we
  // read. A lower bound (only fetched issues are visible): a no-op run that
  // also moved a different issue was not really idle.
  const progressIssuesByRun = new Map();
  for (const rows of activityByIssue.values()) {
    for (const row of rows ?? []) {
      if (!row.runId || !isProgressRow(row)) continue;
      const set = progressIssuesByRun.get(row.runId) ?? new Set();
      set.add(row.entityId);
      progressIssuesByRun.set(row.runId, set);
    }
  }

  const total = ZERO();
  let noopWithProgressElsewhere = 0;

  for (const run of runs) {
    const issueId = issueIdOf(run);
    const outcome = classifyRun(run, activityByIssue.get(issueId) ?? null);
    const status = typeof run.status === "string" ? run.status : "(unknown)";
    const flags = {
      succeeded: status === "succeeded",
      noEvent: outcome !== OUTCOMES.EVENT_WAKE,
      noop: NOOP_OUTCOMES.has(outcome),
      idle: IDLE_OUTCOMES.has(outcome),
    };

    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    for (const entry of [total, tally(byWakeReason, wakeReasonOf(run)), tally(byAgent, run.agentId ?? "(unknown)")]) {
      entry.runs += 1;
      for (const [flag, on] of Object.entries(flags)) if (on) entry[flag] += 1;
    }
    if (flags.noop) {
      const elsewhere = progressIssuesByRun.get(run.id);
      if (elsewhere && [...elsewhere].some((id) => id !== issueId)) noopWithProgressElsewhere += 1;
    }
  }

  const totalRuns = total.runs;
  const unverified = byOutcome.get(OUTCOMES.UNVERIFIED) ?? 0;
  const caveats = [];
  if (truncatedAgents.length > 0) {
    caveats.push(
      `${truncatedAgents.length} agent(s) returned a full 1000-run page that stops short of the window start; their older runs are not counted`,
    );
  }
  if (unverified > 0) caveats.push(`${unverified} no-event run(s) could not be classified because their issue activity was unreadable`);

  const wakeReasons = sortedObject(byWakeReason);
  for (const entry of Object.values(wakeReasons)) {
    entry.shareOfRuns = share(entry.runs, totalRuns);
    entry.noopShareOfReason = share(entry.noop, entry.runs);
    entry.idleShareOfReason = share(entry.idle, entry.runs);
  }

  const agents = {};
  for (const [agentId, entry] of Object.entries(sortedObject(byAgent, "idle"))) {
    if (entry.idle === 0) continue;
    agents[agentId] = { name: agentNames.get(agentId) ?? null, ...entry };
  }

  const count = (outcome) => byOutcome.get(outcome) ?? 0;
  return {
    totalRuns,
    succeededRuns: total.succeeded,
    byStatus: Object.fromEntries([...byStatus.entries()].sort((a, b) => b[1] - a[1])),
    byWakeReason: wakeReasons,
    byOutcome: Object.fromEntries([...byOutcome.entries()].sort((a, b) => b[1] - a[1])),
    // Wake carried no new event (due check or re-assertion), whatever the run did.
    noEvent: { runs: total.noEvent, shareOfAllRuns: share(total.noEvent, totalRuns) },
    // The host's own "no issue-visible progress" rule, applied to succeeded no-event runs.
    noop: {
      runs: total.noop,
      housekeepingOnly: count(OUTCOMES.NOOP_HOUSEKEEPING),
      nothing: count(OUTCOMES.NOOP_NOTHING),
      shareOfAllRuns: share(total.noop, totalRuns),
      shareOfSucceededRuns: share(total.noop, total.succeeded),
      withProgressOnOtherIssues: noopWithProgressElsewhere,
    },
    // No-op plus runs whose only visible act is a note or checkout churn: the
    // host counts those as progress, but nothing about the issue changed.
    idle: {
      runs: total.idle,
      noop: total.noop,
      commentOnly: count(OUTCOMES.COMMENT_ONLY),
      checkoutChurnOnly: count(OUTCOMES.CHURN_ONLY),
      shareOfAllRuns: share(total.idle, totalRuns),
      shareOfSucceededRuns: share(total.idle, total.succeeded),
      shareOfSucceededNoEventRuns: share(total.idle, total.idle + count(OUTCOMES.PROGRESS)),
      noEventRunsWithProgress: count(OUTCOMES.PROGRESS),
      targetShare: TARGET_NOOP_SHARE,
      meetsTarget: totalRuns > 0 ? total.idle / totalRuns < TARGET_NOOP_SHARE : null,
    },
    monitorPolicy: monitorPolicyCounts(activityByIssue, sinceMs, untilMs),
    byAgent: agents,
    truncatedAgents,
    complete: caveats.length === 0,
    caveats,
  };
}

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);

/** Short markdown summary table for the card. */
export function renderMarkdown(report, { windowHours, windowUntil, generatedAt }) {
  const { noEvent, noop, idle, monitorPolicy: policy } = report;
  const lines = [
    `# No-op run share, last ${windowHours} h`,
    ``,
    `Window ends ${windowUntil}; generated ${generatedAt}.`,
    ``,
    `| Metric | Value | Target |`,
    `|---|---|---|`,
    `| Runs in window | ${report.totalRuns} (${report.succeededRuns} succeeded) | — |`,
    `| Wakes with no new event | ${noEvent.runs} (${pct(noEvent.shareOfAllRuns)} of runs) | — |`,
    `| No-op runs, host rule (only monitor housekeeping or nothing) | ${noop.runs} (${noop.housekeepingOnly} housekeeping, ${noop.nothing} nothing): ${pct(noop.shareOfAllRuns)} of runs | — |`,
    `| **Idle runs** (no-op, or only a note / checkout churn) | **${idle.runs}** (${idle.noop} no-op, ${idle.commentOnly} comment-only, ${idle.checkoutChurnOnly} checkout churn) | — |`,
    `| **Idle share of all runs** | **${pct(idle.shareOfAllRuns)}** | < ${pct(idle.targetShare)} |`,
    `| Idle share of succeeded runs | ${pct(idle.shareOfSucceededRuns)} | — |`,
    `| Idle share of succeeded no-event runs | ${pct(idle.shareOfSucceededNoEventRuns)} (${idle.noEventRunsWithProgress} left real progress) | — |`,
    `| Host-rule no-op runs that touched another issue | ${noop.withProgressOnOtherIssues} (lower bound) | — |`,
    `| \`issue.monitor_triggered\` | ${policy.triggered} | — |`,
    `| \`issue.monitor_deferred\` | ${policy.deferred} | — |`,
    `| \`issue.monitor_deferral_shadowed\` | ${policy.shadowed} | — |`,
    ``,
    `| Wake reason | Runs | Share of runs | No-op | Idle | Idle share of reason |`,
    `|---|---|---|---|---|---|`,
    ...Object.entries(report.byWakeReason)
      .slice(0, 12)
      .map(([reason, e]) => `| ${reason} | ${e.runs} | ${pct(e.shareOfRuns)} | ${e.noop} | ${e.idle} | ${pct(e.idleShareOfReason)} |`),
    ``,
  ];
  if (!report.complete) {
    lines.push(`**Incomplete:**`, ...report.caveats.map((c) => `- ${c}`), ``);
    if (report.truncatedAgents.length) {
      lines.push(
        ...report.truncatedAgents.map((a) => `- ${a.name ?? a.agentId}: ${a.rows} runs, oldest fetched ${a.oldestFetched}`),
        ``,
      );
    }
  }
  return lines.join("\n");
}
