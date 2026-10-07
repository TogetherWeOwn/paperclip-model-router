/**
 * Port of the Paperclip host's "did this run leave issue-visible progress"
 * rule, used by scripts/noop-run-share.mjs.
 *
 * Sources (host fork, kept verbatim so the measurement and the host agree):
 * - server/src/services/heartbeat.ts: `PRESENTATION_MONITOR_HOUSEKEEPING_ACTIONS`,
 *   `PRESENTATION_MONITOR_ONLY_UPDATE_KEYS`, `isMonitorOnlyIssueUpdateDetails`,
 *   `readPresentationRunMadeIssueProgress`, `derivePresentationWakeProvenance`
 * - server/src/services/issue-rewake-throttle.ts: `ISSUE_PROGRESS_ACTIVITY_ACTIONS`
 * - server/src/services/heartbeat-run-summary.ts: `NO_PROGRESS_NO_EVENT_WAKE_REASONS`,
 *   `isNoEventWakeReason`
 * - server/src/modules/run-dispatch/domain/wake-context.ts: `deriveCommentId`
 *
 * If the host changes one of these, change the copy here in the same step;
 * tests/noop-run-share.spec.ts pins every branch the host tests pin.
 *
 * Known divergence: the host reads at most 50 matching rows per run in an
 * unspecified order. This port reads all of them, which can only turn a
 * "housekeeping-only" verdict into "progress", never the reverse.
 */

/** Actions the host counts as issue-visible progress when attributed to a run. */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS = new Set([
  "issue.updated",
  "issue.comment_added",
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_created",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
]);

/** Progress actions that are a monitor re-arm, not progress. */
export const MONITOR_HOUSEKEEPING_ACTIONS = new Set(["issue.monitor_scheduled"]);

/** Top-level `issue.updated` change keys that only re-arm or inspect the monitor. */
export const MONITOR_ONLY_UPDATE_KEYS = new Set([
  "monitorNotes",
  "executionState",
  "executionPolicy",
  "monitorNextCheckAt",
  "monitorScheduledBy",
  "monitorWakeRequestedAt",
  "statusVersion",
]);

/** Wakes that carry no new event for the issue (a null reason counts too). */
export const NO_EVENT_WAKE_REASONS = new Set([
  "issue_continuation_needed",
  "issue_graph_liveness_backstop",
  "issue_monitor_due",
  "issue_monitor_recovery",
  "issue_monitor_recovery_issue",
  "heartbeat_timer",
]);

// A freshly created execution policy may carry these keys besides `monitor`
// when the creation is just a monitor re-arm.
const SCHEDULING_ONLY_POLICY_KEYS = new Set(["mode", "stages", "commentRequired"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutMonitorSubObject(value) {
  if (!isPlainObject(value)) return value;
  const { monitor: _ignored, ...rest } = value;
  return rest;
}

function isSchedulingOnlyPolicyCreation(value) {
  if (!isPlainObject(value) || !isPlainObject(value.monitor)) return false;
  const stripped = withoutMonitorSubObject(value);
  if (!isPlainObject(stripped)) return false;
  for (const [key, entry] of Object.entries(stripped)) {
    if (!SCHEDULING_ONLY_POLICY_KEYS.has(key)) return false;
    if (key === "stages") {
      if (entry === undefined || entry === null) continue;
      if (!Array.isArray(entry) || entry.length > 0) return false;
    }
  }
  return true;
}

/**
 * Whether an `issue.updated` row is a monitor re-arm rather than progress.
 * Anything unclassifiable is progress, so real progress is never hidden.
 */
export function isMonitorOnlyIssueUpdateDetails(details) {
  if (!isPlainObject(details)) return false;
  const changes = details.changes;
  if (!isPlainObject(changes)) return false;
  const entries = Object.entries(changes);
  if (entries.length === 0) return true;
  for (const [key, change] of entries) {
    if (!MONITOR_ONLY_UPDATE_KEYS.has(key)) return false;
    if (key === "executionState" || key === "executionPolicy") {
      if (!isPlainObject(change)) return false;
      if (!("to" in change) && !("from" in change)) return false;
      const from = change.from ?? null;
      if (from === null) {
        // First-time creation: only a scheduling-only policy skeleton is
        // housekeeping; planned stages or workflow state are real work.
        if (key !== "executionPolicy" || !isSchedulingOnlyPolicyCreation(change.to)) return false;
        continue;
      }
      if (canonicalize(withoutMonitorSubObject(change.to)) !== canonicalize(withoutMonitorSubObject(from))) {
        return false;
      }
    }
  }
  return true;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Last batched wake comment id, else `wakeCommentId`, else `commentId`. */
export function deriveWakeCommentId(contextSnapshot) {
  const batched = Array.isArray(contextSnapshot?.wakeCommentIds)
    ? contextSnapshot.wakeCommentIds.map(nonEmptyString).filter(Boolean)
    : [];
  return batched.at(-1) ?? nonEmptyString(contextSnapshot?.wakeCommentId) ?? nonEmptyString(contextSnapshot?.commentId);
}

/** A wake is event-free when its reason is a due check or re-assertion and it names no comment. */
export function isNoEventWake(contextSnapshot) {
  const reason = nonEmptyString(contextSnapshot?.wakeReason);
  const eventFreeReason = reason === null || NO_EVENT_WAKE_REASONS.has(reason);
  return eventFreeReason && deriveWakeCommentId(contextSnapshot) === null;
}

/** An activity row the host would count as issue-visible progress. */
export function isProgressRow(row) {
  if (!ISSUE_PROGRESS_ACTIVITY_ACTIONS.has(row?.action)) return false;
  if (MONITOR_HOUSEKEEPING_ACTIONS.has(row.action)) return false;
  if (row.action === "issue.updated" && isMonitorOnlyIssueUpdateDetails(row.details)) return false;
  return true;
}

/**
 * Rows attributed to this run on this issue, in the host's own terms: same run
 * id, issue entity, and one of the progress actions. A row with a null or a
 * different run id belongs to someone else and never counts.
 */
export function runIssueRows(rows, runId, issueId) {
  return rows.filter(
    (row) =>
      row?.runId === runId &&
      row.entityType === "issue" &&
      row.entityId === issueId &&
      ISSUE_PROGRESS_ACTIVITY_ACTIONS.has(row.action),
  );
}
