import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The no-op share classifier is a port of the host's "did this run leave
// issue-visible progress" rule. These tests pin every branch the host tests
// pin, plus the run attribution and wake classification the script adds, so a
// mutant that changes the verdict has something to fail. scripts/ is outside
// tsconfig's `include`, so resolve the modules through computed specifiers
// (see fidelity-pagination.spec.ts).

type Row = {
  action: string;
  entityType: string | null;
  entityId: string | null;
  runId: string | null;
  createdAt: string | null;
  details: unknown;
};
type Run = {
  id: string;
  agentId: string;
  status: string;
  createdAt: string;
  contextSnapshot: Record<string, unknown>;
};
interface Housekeeping {
  isMonitorOnlyIssueUpdateDetails(details: unknown): boolean;
  isNoEventWake(contextSnapshot: unknown): boolean;
  deriveWakeCommentId(contextSnapshot: unknown): string | null;
  isProgressRow(row: unknown): boolean;
  runIssueRows(rows: Row[], runId: string, issueId: string): Row[];
}
interface Share {
  OUTCOMES: {
    EVENT_WAKE: string;
    UNSCOPED: string;
    NOT_SUCCEEDED: string;
    UNVERIFIED: string;
    PROGRESS: string;
    COMMENT_ONLY: string;
    CHURN_ONLY: string;
    NOOP_HOUSEKEEPING: string;
    NOOP_NOTHING: string;
  };
  ARMED_MONITOR_LIST_LIMIT: number;
  isArmedMonitorListCapped(rowCount: number): boolean;
  classifyRun(run: Run, rows: Row[] | null): string;
  compactIssueRows(rows: unknown[]): Row[];
  issuesNeedingActivity(runs: Run[]): string[];
  buildReport(input: {
    runs: Run[];
    activityByIssue: Map<string, Row[] | null>;
    agentNames?: Map<string, string>;
    sinceMs: number;
    untilMs: number;
    truncatedAgents?: unknown[];
    undatedRows?: number;
    armedMonitorDiscoveryFailed?: boolean;
    armedMonitorListCapped?: boolean;
  }): Report;
  renderMarkdown(report: Report, meta: { windowHours: number; windowUntil: string; generatedAt: string }): string;
}
interface Report {
  totalRuns: number;
  succeededRuns: number;
  byOutcome: Record<string, number>;
  byWakeReason: Record<string, { runs: number; noop: number; idle: number; shareOfRuns: number; idleShareOfReason: number | null }>;
  noEvent: { runs: number; shareOfAllRuns: number | null };
  noop: { runs: number; housekeepingOnly: number; nothing: number; shareOfAllRuns: number | null; withProgressOnOtherIssues: number };
  idle: {
    runs: number;
    noop: number;
    commentOnly: number;
    checkoutChurnOnly: number;
    shareOfAllRuns: number | null;
    shareOfSucceededRuns: number | null;
    succeededNoEventRuns: number;
    shareOfSucceededNoEventRuns: number | null;
    noEventRunsWithProgress: number;
    meetsTarget: boolean | null;
  };
  monitorPolicy: { deferred: number; shadowed: number; triggered: number; deferredByReason: Record<string, number>; issuesWithActivity: number };
  byAgent: Record<string, { name: string | null; noop: number; idle: number }>;
  complete: boolean;
  caveats: string[];
}

const H: Housekeeping = await import(/* @vite-ignore */ new URL("../scripts/lib/monitor-housekeeping.mjs", import.meta.url).href);
const S: Share = await import(/* @vite-ignore */ new URL("../scripts/lib/noop-run-share.mjs", import.meta.url).href);
const fixture = JSON.parse(readFileSync(new URL("./noop-run-share.fixture.json", import.meta.url), "utf8")).details as Record<string, unknown>;

const ISSUE = "issue-1";
const OTHER_ISSUE = "issue-2";
const T0 = Date.parse("2026-10-07T03:00:00.000Z");
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

let tick = 0;
function row(action: string, runId: string | null, details: unknown = null, over: Partial<Row> = {}): Row {
  tick += 1;
  return { action, entityType: "issue", entityId: ISSUE, runId, createdAt: iso(tick), details, ...over };
}
function monitorRun(id: string, over: Partial<Run> = {}, snapshot: Record<string, unknown> = {}): Run {
  return {
    id,
    agentId: "agent-a",
    status: "succeeded",
    createdAt: iso(0),
    contextSnapshot: { issueId: ISSUE, wakeReason: "issue_monitor_due", ...snapshot },
    ...over,
  };
}
const checkoutAction = (fixture.checkoutEvent as { action: string }).action;
const checkedOut = (runId: string) => [
  row("issue.updated", "previous-run", fixture.statusBeforeCheckout, { createdAt: iso(-1) }),
  row(checkoutAction, runId, null, { createdAt: iso(1) }),
];
const checkoutRelease = (runId: string) => row("issue.updated", runId, fixture.checkoutBack);
const rearm = (runId: string) => [row("issue.monitor_scheduled", runId), row("issue.updated", runId, fixture.monitorRearmOnly)];
const comment = (runId: string) => row("issue.comment_added", runId, { commentId: "c1", bodySnippet: "note" });

describe("isMonitorOnlyIssueUpdateDetails (host rule parity)", () => {
  const only = H.isMonitorOnlyIssueUpdateDetails;

  it("treats an empty change set as monitor-only", () => {
    expect(only({ changes: {} })).toBe(true);
  });

  it("treats a monitor re-arm as monitor-only", () => {
    expect(only(fixture.monitorRearmOnly)).toBe(true);
  });

  it("treats a status change as progress, with or without monitor keys", () => {
    expect(only({ changes: { status: { to: "done", from: "in_progress" } } })).toBe(false);
    expect(only({ changes: { status: { to: "done", from: "in_progress" }, monitorNotes: { to: "b", from: "a" } } })).toBe(false);
  });

  it("treats a blocker change as progress", () => {
    expect(only(fixture.blockerChange)).toBe(false);
  });

  it("treats missing or malformed details as progress", () => {
    for (const details of [null, undefined, "x", [], {}, { changes: null }, { changes: [] }, { changes: "x" }]) {
      expect(only(details)).toBe(false);
    }
  });

  it("treats a plugin-style patch with no `changes` as progress", () => {
    expect(only(fixture.pluginPatch)).toBe(false);
  });

  it("treats a scheduling-only policy creation as housekeeping, with or without a monitor (host parity)", () => {
    expect(
      only({ changes: { executionPolicy: { to: { mode: "normal", stages: [], monitor: { nextCheckAt: "t2" }, commentRequired: true }, from: null } } }),
    ).toBe(true);
    expect(only({ changes: { executionPolicy: { to: { mode: "normal", stages: [], commentRequired: true }, from: null } } })).toBe(true);
    expect(only({ changes: { executionPolicy: { to: { mode: "normal", stages: [], monitor: null }, from: null } } })).toBe(true);
    expect(only({ changes: { executionPolicy: { to: {}, from: null } } })).toBe(true);
  });

  it("treats a policy creation with planned stages or other keys as progress", () => {
    expect(only({ changes: { executionPolicy: { to: { mode: "normal", stages: [{ id: "s" }], monitor: {} }, from: null } } })).toBe(false);
    expect(only({ changes: { executionPolicy: { to: { mode: "normal", monitor: {}, approvers: ["x"] }, from: null } } })).toBe(false);
  });

  it("treats a from-null execution-state creation as progress", () => {
    expect(only({ changes: { executionState: { to: { status: "idle", monitor: {} }, from: null } } })).toBe(false);
  });

  it("treats an execution-state change beyond the monitor sub-object as progress", () => {
    const stageAdvance = {
      changes: {
        executionState: {
          to: { status: "pending", currentStageIndex: 1, monitor: { nextCheckAt: "t2" } },
          from: { status: "pending", currentStageIndex: 0, monitor: { nextCheckAt: "t1" } },
        },
      },
    };
    expect(only(stageAdvance)).toBe(false);
  });

  it("rejects an execution-state change with neither `to` nor `from`", () => {
    expect(only({ changes: { executionState: {} } })).toBe(false);
    expect(only({ changes: { executionState: "x" } })).toBe(false);
  });

  it("treats a key outside the monitor set as progress even next to monitor keys", () => {
    expect(only({ changes: { monitorNextCheckAt: { to: "t", from: null }, assigneeAgentId: { to: "a", from: "b" } } })).toBe(false);
  });
});

describe("wake classification", () => {
  it.each([
    ["issue_monitor_due", true],
    ["issue_continuation_needed", true],
    ["issue_graph_liveness_backstop", true],
    ["issue_monitor_recovery", true],
    ["issue_monitor_recovery_issue", true],
    ["heartbeat_timer", true],
    ["issue_assigned", false],
    ["issue_commented", false],
    ["issue_assignment_recovery", false],
    ["issue_blockers_resolved", false],
    ["External chat message received", false],
  ])("wake reason %s carries no event: %s", (wakeReason, noEvent) => {
    expect(H.isNoEventWake({ wakeReason })).toBe(noEvent);
  });

  it("treats a missing, blank or non-string reason as event-free", () => {
    expect(H.isNoEventWake({})).toBe(true);
    expect(H.isNoEventWake({ wakeReason: "  " })).toBe(true);
    expect(H.isNoEventWake(undefined)).toBe(true);
  });

  it("treats any wake that names a comment as an event, whatever the reason", () => {
    expect(H.isNoEventWake({ wakeReason: "issue_monitor_due", wakeCommentId: "c" })).toBe(false);
    expect(H.isNoEventWake({ wakeReason: "issue_monitor_due", commentId: "c" })).toBe(false);
    expect(H.isNoEventWake({ wakeReason: "issue_monitor_due", wakeCommentIds: ["a", "b"] })).toBe(false);
    expect(H.isNoEventWake({ wakeReason: "issue_monitor_due", wakeCommentId: " " })).toBe(true);
  });

  it("derives the comment id with the host's precedence", () => {
    expect(H.deriveWakeCommentId({ wakeCommentIds: ["a", "b"], wakeCommentId: "c", commentId: "d" })).toBe("b");
    expect(H.deriveWakeCommentId({ wakeCommentId: "c", commentId: "d" })).toBe("c");
    expect(H.deriveWakeCommentId({ commentId: "d" })).toBe("d");
    expect(H.deriveWakeCommentId({})).toBeNull();
  });
});

describe("progress rows and run attribution", () => {
  it("never counts monitor housekeeping or a monitor-only update as progress", () => {
    expect(H.isProgressRow(row("issue.monitor_scheduled", "r"))).toBe(false);
    expect(H.isProgressRow(row("issue.updated", "r", fixture.monitorRearmOnly))).toBe(false);
  });

  it("counts a real update, a comment and a work product as progress", () => {
    expect(H.isProgressRow(row("issue.updated", "r", fixture.closeIssue))).toBe(true);
    expect(H.isProgressRow(row("issue.comment_added", "r"))).toBe(true);
    expect(H.isProgressRow(row("issue.work_product_created", "r"))).toBe(true);
  });

  it("ignores actions the host does not treat as progress", () => {
    for (const action of ["tool_gateway.call_allowed", "issue.checked_out", "issue.monitor_triggered", "issue.monitor_deferred", "issue.thread_interaction_answered"]) {
      expect(H.isProgressRow(row(action, "r"))).toBe(false);
    }
  });

  it("attributes by run id, issue entity and issue id only", () => {
    const mine = row("issue.comment_added", "run-1");
    const rows = [
      mine,
      row("issue.comment_added", "run-2"),
      row("issue.comment_added", null),
      row("issue.comment_added", "run-1", null, { entityId: OTHER_ISSUE }),
      row("issue.comment_added", "run-1", null, { entityType: "project" }),
      row("tool_gateway.call_allowed", "run-1"),
    ];
    expect(H.runIssueRows(rows, "run-1", ISSUE)).toEqual([mine]);
  });
});

describe("classifyRun", () => {
  const O = S.OUTCOMES;

  it("does not touch a run whose wake carried an event", () => {
    expect(S.classifyRun(monitorRun("r", {}, { wakeCommentId: "c" }), [])).toBe(O.EVENT_WAKE);
    expect(S.classifyRun(monitorRun("r", { contextSnapshot: { issueId: ISSUE, wakeReason: "issue_assigned" } }), [])).toBe(O.EVENT_WAKE);
  });

  it("sets aside a no-event run with no issue: the host cannot evaluate progress there", () => {
    expect(S.classifyRun(monitorRun("r", { contextSnapshot: { wakeReason: "heartbeat_timer" } }), [])).toBe(O.UNSCOPED);
  });

  it("sets aside a run that did not succeed", () => {
    for (const status of ["failed", "cancelled", "running", "queued", "timed_out"]) {
      expect(S.classifyRun(monitorRun("r", { status }), [])).toBe(O.NOT_SUCCEEDED);
    }
  });

  it("sets aside a run whose issue activity could not be read", () => {
    expect(S.classifyRun(monitorRun("r"), null)).toBe(O.UNVERIFIED);
  });

  it("calls a run with no attributed activity a no-op", () => {
    expect(S.classifyRun(monitorRun("r"), [])).toBe(O.NOOP_NOTHING);
  });

  it("calls a run whose only activity is its monitor re-arm a no-op", () => {
    expect(S.classifyRun(monitorRun("r"), rearm("r"))).toBe(O.NOOP_HOUSEKEEPING);
  });

  it("does not credit activity of another run, or on another issue, to this run", () => {
    const rows = [
      ...rearm("r"),
      row("issue.comment_added", "someone-else"),
      row("issue.work_product_created", null),
      row("issue.comment_added", "r", null, { entityId: OTHER_ISSUE }),
    ];
    expect(S.classifyRun(monitorRun("r"), rows)).toBe(O.NOOP_HOUSEKEEPING);
  });

  it("does not let monitor deferral or trigger rows count as progress", () => {
    const rows = [row("issue.monitor_triggered", "r"), row("issue.monitor_deferred", "r", fixture.deferred), ...rearm("r")];
    expect(S.classifyRun(monitorRun("r"), rows)).toBe(O.NOOP_HOUSEKEEPING);
  });

  it("calls a run that left a real update progress", () => {
    expect(S.classifyRun(monitorRun("r"), [...rearm("r"), row("issue.blockers_updated", "r"), row("issue.updated", "r", fixture.blockerChange)])).toBe(O.PROGRESS);
  });

  it("keeps a run whose only visible act is a comment out of the no-op count", () => {
    expect(S.classifyRun(monitorRun("r"), [...rearm("r"), comment("r")])).toBe(O.COMMENT_ONLY);
  });

  it("calls a checkout release back to the pre-run status idle", () => {
    const rows = [...checkedOut("r"), comment("r"), checkoutRelease("r"), ...rearm("r")];
    expect(S.classifyRun(monitorRun("r"), S.compactIssueRows(rows))).toBe(O.CHURN_ONLY);
  });

  it("uses this run's checkout when an earlier run checked out the same issue", () => {
    const earlierCheckout = [
      row("issue.updated", "older-run", { changes: { status: { to: "todo", from: "backlog" } } }, { createdAt: iso(-4) }),
      row(checkoutAction, "older-run", null, { createdAt: iso(-3) }),
    ];
    const rows = [...earlierCheckout, ...checkedOut("r"), comment("r"), checkoutRelease("r"), ...rearm("r")];
    expect(S.classifyRun(monitorRun("r"), S.compactIssueRows(rows))).toBe(O.CHURN_ONLY);
  });

  it("treats a checkout release as progress when the pre-checkout status is unknown", () => {
    const rows = [row(checkoutAction, "r", null, { createdAt: iso(1) }), comment("r"), checkoutRelease("r")];
    expect(S.classifyRun(monitorRun("r"), S.compactIssueRows(rows))).toBe(O.PROGRESS);
  });

  it("calls a comment plus a status change that sticks progress", () => {
    const rows = [...checkedOut("r"), comment("r"), row("issue.updated", "r", fixture.closeIssue)];
    expect(S.classifyRun(monitorRun("r"), S.compactIssueRows(rows))).toBe(O.PROGRESS);
  });

  it("calls a checkout release plus a work product progress", () => {
    const rows = [...checkedOut("r"), row("issue.work_product_created", "r"), checkoutRelease("r")];
    expect(S.classifyRun(monitorRun("r"), S.compactIssueRows(rows))).toBe(O.PROGRESS);
  });
});

describe("compactIssueRows and issuesNeedingActivity", () => {
  it("drops rows the report never reads and keeps details only where needed", () => {
    const kept = S.compactIssueRows([
      { action: "tool_gateway.call_allowed", details: { big: "x" } },
      { action: "issue.checked_out", runId: "r" },
      { action: "issue.comment_added", runId: "r", entityType: "issue", entityId: ISSUE, details: { bodySnippet: "long" } },
      { action: "issue.updated", runId: "r", entityType: "issue", entityId: ISSUE, details: fixture.closeIssue },
      { action: "issue.monitor_deferred", entityType: "issue", entityId: ISSUE, details: fixture.deferred },
      null,
      { details: {} },
    ]);
    expect(kept.map((r) => r.action)).toEqual(["issue.checked_out", "issue.comment_added", "issue.updated", "issue.monitor_deferred"]);
    expect(kept[0]?.details).toBeNull();
    expect(kept[1]?.details).toBeNull();
    expect(kept[2]?.details).toEqual(fixture.closeIssue);
    expect(kept[3]?.details).toEqual(fixture.deferred);
  });

  it("asks only for issues a succeeded no-event run touched", () => {
    const runs = [
      monitorRun("a"),
      monitorRun("b", { contextSnapshot: { issueId: "issue-b", wakeReason: "issue_continuation_needed" } }),
      monitorRun("c", { contextSnapshot: { issueId: "issue-c", wakeReason: "issue_assigned" } }),
      monitorRun("d", { status: "failed", contextSnapshot: { issueId: "issue-d", wakeReason: "issue_monitor_due" } }),
      monitorRun("e", { contextSnapshot: { wakeReason: "issue_monitor_due" } }),
    ];
    expect(S.issuesNeedingActivity(runs).sort()).toEqual([ISSUE, "issue-b"]);
  });
});

describe("buildReport", () => {
  const window = { sinceMs: T0 - 24 * 3600_000, untilMs: T0 + 3600_000 };

  function scenario() {
    const runs: Run[] = [
      monitorRun("noop-1"),
      monitorRun("noop-2"),
      monitorRun("note-1"),
      monitorRun("churn-1"),
      monitorRun("work-1"),
      monitorRun("failed-1", { status: "failed" }),
      monitorRun("event-1", { contextSnapshot: { issueId: ISSUE, wakeReason: "issue_assigned" } }),
      monitorRun("event-2", { contextSnapshot: { issueId: ISSUE, wakeReason: "issue_commented" } }, {}),
    ];
    const rows: Row[] = [
      ...rearm("noop-1"),
      row("issue.comment_added", "event-1"),
      ...rearm("noop-2"),
      ...rearm("note-1"),
      comment("note-1"),
      ...checkedOut("churn-1"),
      comment("churn-1"),
      checkoutRelease("churn-1"),
      row("issue.work_product_created", "work-1"),
      row("issue.monitor_triggered", null, null, { createdAt: iso(5) }),
      row("issue.monitor_deferred", null, fixture.deferred, { createdAt: iso(6) }),
      row("issue.monitor_deferral_shadowed", null, { reason: "quiet_card" }, { createdAt: iso(7) }),
      row("issue.monitor_deferred", null, fixture.deferred, { createdAt: new Date(T0 - 48 * 3600_000).toISOString() }),
    ];
    return { runs, activityByIssue: new Map<string, Row[] | null>([[ISSUE, rows]]) };
  }

  it("counts no-ops, idle runs and shares", () => {
    const report = S.buildReport({ ...scenario(), ...window, agentNames: new Map([["agent-a", "Agent A"]]) });
    expect(report.totalRuns).toBe(8);
    expect(report.succeededRuns).toBe(7);
    expect(report.byOutcome).toEqual({
      [S.OUTCOMES.NOOP_HOUSEKEEPING]: 2,
      [S.OUTCOMES.COMMENT_ONLY]: 1,
      [S.OUTCOMES.CHURN_ONLY]: 1,
      [S.OUTCOMES.PROGRESS]: 1,
      [S.OUTCOMES.NOT_SUCCEEDED]: 1,
      [S.OUTCOMES.EVENT_WAKE]: 2,
    });
    expect(report.noEvent).toEqual({ runs: 6, shareOfAllRuns: 6 / 8 });
    expect(report.noop).toMatchObject({ runs: 2, housekeepingOnly: 2, nothing: 0, shareOfAllRuns: 2 / 8 });
    expect(report.idle).toMatchObject({
      runs: 4,
      noop: 2,
      commentOnly: 1,
      checkoutChurnOnly: 1,
      shareOfAllRuns: 4 / 8,
      shareOfSucceededRuns: 4 / 7,
      succeededNoEventRuns: 5,
      shareOfSucceededNoEventRuns: 4 / 5,
      noEventRunsWithProgress: 1,
      meetsTarget: false,
    });
    expect(report.byAgent["agent-a"]).toMatchObject({ name: "Agent A", noop: 2, idle: 4 });
    expect(report.byWakeReason.issue_monitor_due).toMatchObject({ runs: 6, noop: 2, idle: 4, shareOfRuns: 6 / 8 });
    expect(report.byWakeReason.issue_assigned).toMatchObject({ runs: 1, noop: 0, idle: 0 });
    expect(report.complete).toBe(true);
  });

  it("includes unscoped succeeded no-event runs in the denominator", () => {
    const runs = [monitorRun("idle"), monitorRun("unscoped", { contextSnapshot: { wakeReason: "heartbeat_timer" } })];
    const report = S.buildReport({ runs, activityByIssue: new Map([[ISSUE, rearm("idle")]]), ...window });
    expect(report.noEvent.runs).toBe(2);
    expect(report.idle.succeededNoEventRuns).toBe(2);
    expect(report.idle.shareOfSucceededNoEventRuns).toBe(0.5);
  });

  it("meets the target only below 10% of all runs", () => {
    const nine = Array.from({ length: 9 }, (_, i) => monitorRun(`e${i}`, { contextSnapshot: { issueId: ISSUE, wakeReason: "issue_assigned" } }));
    const under = S.buildReport({ runs: [...nine, monitorRun("n")], activityByIssue: new Map([[ISSUE, rearm("n")]]), ...window });
    expect(under.idle.shareOfAllRuns).toBe(0.1);
    expect(under.idle.meetsTarget).toBe(false);
    const eleven = [...nine, monitorRun("e9", { contextSnapshot: { issueId: ISSUE, wakeReason: "issue_assigned" } }), monitorRun("n")];
    const ok = S.buildReport({ runs: eleven, activityByIssue: new Map([[ISSUE, rearm("n")]]), ...window });
    expect(ok.idle.meetsTarget).toBe(true);
  });

  it("counts deferral and trigger rows inside the window only", () => {
    const report = S.buildReport({ ...scenario(), ...window });
    expect(report.monitorPolicy).toMatchObject({
      triggered: 1,
      deferred: 1,
      shadowed: 1,
      deferredByReason: { min_interval: 1, quiet_card: 1 },
      issuesWithActivity: 1,
    });
  });

  it("flags a no-op run that also moved a different issue, as a lower bound", () => {
    const { runs, activityByIssue } = scenario();
    activityByIssue.set(OTHER_ISSUE, [row("issue.comment_added", "noop-1", null, { entityId: OTHER_ISSUE })]);
    expect(S.buildReport({ runs, activityByIssue, ...window }).noop.withProgressOnOtherIssues).toBe(1);
  });

  it("reports an incomplete window instead of a clean number", () => {
    const { runs, activityByIssue } = scenario();
    activityByIssue.set(ISSUE, null);
    const truncatedAgents = [{ agentId: "B", name: "Agent B", rows: 1000, oldestFetched: iso(-60) }];
    const report = S.buildReport({ runs, activityByIssue, truncatedAgents, ...window });
    expect(report.complete).toBe(false);
    expect(report.caveats).toHaveLength(3);
    expect(report.caveats.join(" ")).toMatch(/1 agent\(s\).*1000-run page/);
    expect(report.caveats.join(" ")).toMatch(/5 no-event run\(s\) could not be classified/);
    expect(report.caveats.join(" ")).toMatch(/1 issue activity read\(s\) failed/);
    expect(report.noop.runs).toBe(0);
  });

  it("marks the report incomplete when any run row is undated", () => {
    const { runs, activityByIssue } = scenario();
    const report = S.buildReport({ runs, activityByIssue, undatedRows: 1, ...window });
    expect(report.complete).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/1 run row\(s\) have missing or invalid createdAt/);
  });

  it("marks the report incomplete when armed-monitor discovery fails", () => {
    const { runs, activityByIssue } = scenario();
    const report = S.buildReport({ runs, activityByIssue, armedMonitorDiscoveryFailed: true, ...window });
    expect(report.complete).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/could not discover issues with an armed monitor/);
  });

  it("marks the report incomplete when the armed-monitor read hit its row limit", () => {
    const { runs, activityByIssue } = scenario();
    const report = S.buildReport({ runs, activityByIssue, armedMonitorListCapped: true, ...window });
    expect(report.complete).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/open-issue read returned its 1000-row limit/);
    expect(S.buildReport({ runs, activityByIssue, ...window }).complete).toBe(true);
  });

  it("treats a list at exactly its limit as capped, and one row fewer as complete", () => {
    expect(S.isArmedMonitorListCapped(S.ARMED_MONITOR_LIST_LIMIT)).toBe(true);
    expect(S.isArmedMonitorListCapped(S.ARMED_MONITOR_LIST_LIMIT - 1)).toBe(false);
  });

  it("marks the report incomplete when activity for an armed-only issue is unreadable", () => {
    const { runs, activityByIssue } = scenario();
    activityByIssue.set("armed-only", null);
    const report = S.buildReport({ runs, activityByIssue, ...window });
    expect(report.complete).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/1 issue activity read\(s\) failed/);
  });

  it("returns null shares for an empty window", () => {
    const report = S.buildReport({ runs: [], activityByIssue: new Map(), ...window });
    expect(report.totalRuns).toBe(0);
    expect(report.noop.shareOfAllRuns).toBeNull();
    expect(report.idle.shareOfAllRuns).toBeNull();
    expect(report.idle.meetsTarget).toBeNull();
  });

  it("renders the figures and the incomplete warning in markdown", () => {
    const report = S.buildReport({ ...scenario(), ...window, truncatedAgents: [{ agentId: "B", name: "Agent B", rows: 1000, oldestFetched: iso(-60) }] });
    const md = S.renderMarkdown(report, { windowHours: 24, windowUntil: iso(3600), generatedAt: iso(3601) });
    expect(md).toContain("# No-op run share, last 24 h");
    expect(md).toContain("| **Idle share of all runs** | **50.0%** | < 10.0% |");
    expect(md).toContain("| Idle share of succeeded no-event runs | 80.0% of 5 (1 left real progress) | — |");
    expect(md).toContain("2 (2 housekeeping, 0 nothing): 25.0% of runs");
    expect(md).toContain("| `issue.monitor_deferred` | 1 | — |");
    expect(md).toContain("| issue_monitor_due | 6 | 75.0% | 2 | 4 | 66.7% |");
    expect(md).toContain("**Incomplete:**");
    expect(md).toContain("Agent B: 1000 runs");
  });
});

// End to end: the real script against a local server with the live endpoints'
// behaviour (per-agent run pages that ignore everything else, per-issue activity).
describe("scripts/noop-run-share.mjs", () => {
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL("../scripts/noop-run-share.mjs", import.meta.url));
  const COMPANY = "co-1";
  let server: Server;
  let baseUrl = "";
  const requested: string[] = [];
  let armedIssueReadFails = false;
  let includeUndatedRun = false;

  beforeAll(async () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const mk = (id: string, agentId: string, minutesAgo: number, issueId: string, wakeReason: string, status = "succeeded") => ({
      id,
      agentId,
      status,
      createdAt: at(minutesAgo),
      contextSnapshot: { issueId, wakeReason },
    });
    const runs = [
      mk("r-noop", "A", 10, "i-1", "issue_monitor_due"),
      mk("r-note", "A", 20, "i-2", "issue_monitor_due"),
      mk("r-work", "B", 30, "i-3", "issue_continuation_needed"),
      mk("r-event", "B", 40, "i-3", "issue_assigned"),
      mk("r-old", "B", 60 * 40, "i-3", "issue_monitor_due"),
    ];
    const act = (action: string, runId: string | null, entityId: string, details: unknown = null) => ({
      action,
      runId,
      entityType: "issue",
      entityId,
      createdAt: at(5),
      details,
    });
    const activity: Record<string, unknown[]> = {
      "i-1": [act("issue.monitor_scheduled", "r-noop", "i-1"), act("issue.updated", "r-noop", "i-1", fixture.monitorRearmOnly), act("tool_gateway.call_allowed", "r-noop", "i-1")],
      "i-2": [act("issue.comment_added", "r-note", "i-2")],
      "i-3": [act("issue.work_product_created", "r-work", "i-3"), act("issue.monitor_deferred", null, "i-3", fixture.deferred)],
      "i-armed": [act("issue.monitor_deferral_shadowed", null, "i-armed", { reason: "quiet_card" })],
    };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://fixture");
      requested.push(url.pathname + url.search);
      let body: unknown = { error: "not found" };
      if (url.pathname === `/api/companies/${COMPANY}/agents`) body = [{ id: "A", name: "Agent A" }, { id: "B", name: "Agent B" }];
      else if (url.pathname === `/api/companies/${COMPANY}/heartbeat-runs`) {
        const agentRuns = runs.filter((r) => r.agentId === url.searchParams.get("agentId"));
        if (includeUndatedRun && url.searchParams.get("agentId") === "A") {
          agentRuns.push({ id: "r-undated", agentId: "A", status: "succeeded", createdAt: "not-a-date", contextSnapshot: { issueId: "i-1", wakeReason: "issue_monitor_due" } });
        }
        body = agentRuns;
      } else if (url.pathname === `/api/companies/${COMPANY}/issues`) {
        if (armedIssueReadFails) {
          res.statusCode = 500;
          body = { error: "read failed" };
        } else {
          body = [{ id: "i-armed", monitorNextCheckAt: at(-60) }, { id: "i-quiet" }];
        }
      } else if (url.pathname.startsWith("/api/issues/") && url.pathname.endsWith("/activity")) {
        const id = url.pathname.split("/")[3] ?? "";
        if (activity[id]) body = activity[id];
        else res.statusCode = 404;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const env = () => ({ ...process.env, NODE_ENV: "", PAPERCLIP_API_URL: baseUrl, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: COMPANY });

  it("reads activity per issue, attributes it by run and writes JSON plus markdown", async () => {
    requested.length = 0;
    const out = join(mkdtempSync(join(tmpdir(), "noop-share-")), "report.md");
    const { stdout } = await exec(process.execPath, [script, "--hours", "24", "--markdown", out], { env: env() });
    const report = JSON.parse(stdout);

    // r-old is outside the window; the other four are in.
    expect(report.totalRuns).toBe(4);
    expect(report.noop).toMatchObject({ runs: 1, housekeepingOnly: 1 });
    expect(report.idle).toMatchObject({ runs: 2, commentOnly: 1, noEventRunsWithProgress: 1 });
    expect(report.idle.shareOfAllRuns).toBe(0.5);
    // The armed monitor's issue is read, so its shadowed deferral is counted.
    expect(report.monitorPolicy).toMatchObject({ deferred: 1, shadowed: 1 });
    expect(report.issuesRead).toBe(4);
    expect(report.issuesWithArmedMonitor).toBe(1);
    expect(report.activityFailures).toBe(0);
    expect(report.complete).toBe(true);

    // One run page per agent, no offset or cursor, and activity from the per-issue route.
    const runPages = requested.filter((p) => p.includes("/heartbeat-runs"));
    expect(runPages).toHaveLength(2);
    expect(runPages.every((p) => /agentId=[AB]&limit=1000$/.test(p))).toBe(true);
    expect(requested.some((p) => /offset|cursor/.test(p))).toBe(false);
    expect(requested.filter((p) => p.endsWith("/activity")).sort()).toEqual(
      ["/api/issues/i-1/activity", "/api/issues/i-2/activity", "/api/issues/i-3/activity", "/api/issues/i-armed/activity"],
    );
    expect(readFileSync(out, "utf8")).toContain("| **Idle share of all runs** | **50.0%** | < 10.0% |");
  }, 60_000);

  it("marks output incomplete when a returned run has no usable timestamp", async () => {
    includeUndatedRun = true;
    try {
      const { stdout } = await exec(process.execPath, [script, "--hours", "24"], { env: env() });
      const report = JSON.parse(stdout);
      expect(report.undatedRows).toBe(1);
      expect(report.complete).toBe(false);
      expect(report.caveats.join(" ")).toMatch(/1 run row\(s\) have missing or invalid createdAt/);
    } finally {
      includeUndatedRun = false;
    }
  }, 60_000);

  it("marks output incomplete when armed-monitor discovery fails", async () => {
    armedIssueReadFails = true;
    try {
      const { stdout } = await exec(process.execPath, [script, "--hours", "24"], { env: env() });
      const report = JSON.parse(stdout);
      expect(report.issuesWithArmedMonitor).toBeNull();
      expect(report.complete).toBe(false);
      expect(report.caveats.join(" ")).toMatch(/could not discover issues with an armed monitor/);
    } finally {
      armedIssueReadFails = false;
    }
  }, 60_000);

  it("rejects bad input", async () => {
    await expect(exec(process.execPath, [script, "--hours", "0"], { env: env() })).rejects.toMatchObject({ code: 2 });
    await expect(exec(process.execPath, [script, "--until", "not-a-date"], { env: env() })).rejects.toMatchObject({ code: 2 });
    await expect(exec(process.execPath, [script], { env: { ...env(), PAPERCLIP_API_KEY: "" } })).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
