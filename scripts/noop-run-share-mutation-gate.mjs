#!/usr/bin/env node
// Mutation gate for the no-op run share classifier. Each mutant changes one
// decision the report depends on and must FAIL tests/noop-run-share.spec.ts; a
// mutant that survives means the tests cannot tell the difference. The gate is
// the deliverable, not the flag.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const housekeeping = join(root, "scripts/lib/monitor-housekeeping.mjs");
const share = join(root, "scripts/lib/noop-run-share.mjs");
const command = ["npx", "vitest", "run", "tests/noop-run-share.spec.ts"];

const mutations = [
  {
    name: "a monitor-only issue.updated counts as progress",
    file: housekeeping,
    from: '  if (row.action === "issue.updated" && isMonitorOnlyIssueUpdateDetails(row.details)) return false;\n',
    to: "",
  },
  {
    name: "issue.monitor_scheduled counts as progress",
    file: housekeeping,
    from: 'export const MONITOR_HOUSEKEEPING_ACTIONS = new Set(["issue.monitor_scheduled"]);',
    to: "export const MONITOR_HOUSEKEEPING_ACTIONS = new Set([]);",
  },
  {
    name: "run attribution dropped: any run's rows count",
    file: housekeeping,
    from: "      row?.runId === runId &&\n",
    to: "      true &&\n",
  },
  {
    name: "issue attribution dropped: rows of other issues count",
    file: housekeeping,
    from: "      row.entityId === issueId &&\n",
    to: "      true &&\n",
  },
  {
    name: "an empty change set counts as progress",
    file: housekeeping,
    from: "  if (entries.length === 0) return true;",
    to: "  if (entries.length === 0) return false;",
  },
  {
    name: "status is treated as a monitor-only key",
    file: housekeeping,
    from: '  "statusVersion",\n]);',
    to: '  "statusVersion",\n  "status",\n]);',
  },
  {
    name: "the execution-state comparison no longer strips the monitor sub-object",
    file: housekeeping,
    from: "      if (canonicalize(withoutMonitorSubObject(change.to)) !== canonicalize(withoutMonitorSubObject(from))) {",
    to: "      if (canonicalize(change.to) !== canonicalize(from)) {",
  },
  {
    name: "a wake that names a comment still counts as event-free",
    file: housekeeping,
    from: "  return batched.at(-1) ?? nonEmptyString(contextSnapshot?.wakeCommentId) ?? nonEmptyString(contextSnapshot?.commentId);",
    to: "  return null;",
  },
  {
    name: "an issue comment stops counting as progress",
    file: housekeeping,
    from: '  "issue.comment_added",\n  "issue.created",',
    to: '  "issue.created",',
  },
  {
    name: "a run that did not succeed is classified like one that did",
    file: share,
    from: "  if (run.status !== \"succeeded\") return OUTCOMES.NOT_SUCCEEDED;\n",
    to: "",
  },
  {
    name: "unreadable issue activity is read as no activity",
    file: share,
    from: "  if (!Array.isArray(issueRows)) return OUTCOMES.UNVERIFIED;",
    to: "  issueRows = issueRows ?? [];",
  },
  {
    name: "a checkout release uses the in-run status instead of pre-checkout status",
    file: share,
    from: "  return statusBeforeCheckout !== finalStatus;",
    to: "  return statuses[0].from !== finalStatus;",
  },
  {
    name: "a status change that sticks is treated as checkout churn",
    file: share,
    from: "  return statusBeforeCheckout !== finalStatus;",
    to: "  return false;",
  },
  {
    name: "deferral counters ignore the window",
    file: share,
    from: "      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;",
    to: "      if (!Number.isFinite(at)) continue;",
  },
];

let failed = 0;
for (const mutation of mutations) {
  const original = readFileSync(mutation.file, "utf8");
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    console.error(`GATE BROKEN (anchor found ${occurrences}x for "${mutation.name}") — update the mutation to match the source.`);
    failed += 1;
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, () => mutation.to));
  try {
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8" });
    const survived = result.status === 0;
    console.log(`${survived ? "SURVIVED ✗" : "killed ✓"} — ${mutation.name} (vitest exit ${result.status})`);
    if (survived) failed += 1;
  } finally {
    writeFileSync(mutation.file, original);
  }
}

if (failed > 0) {
  console.error(`\n${failed} mutant(s) survived or could not be applied — the classifier tests are not tight enough.`);
  process.exit(1);
}
console.log(`\nall ${mutations.length} mutants killed.`);
