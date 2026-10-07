# No-op run share: a repeatable measurement

`scripts/noop-run-share.mjs` answers one question from the Paperclip API alone:
what share of heartbeat runs woke for nothing? It exists so the effect of the
monitor wake policy and of event-driven wakes is a number that can be re-run,
not a one-off analysis.

```bash
PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
  node scripts/noop-run-share.mjs --hours 24 [--until ISO] [--markdown out.md]
npm run check:noop-share-mutants   # the classifier's mutation gate
```

JSON goes to stdout, a short markdown table to `--markdown`, warnings to stderr.

## What it counts

A wake carries **no new event** when its reason is a due check or a
re-assertion (`issue_monitor_due`, `issue_continuation_needed`,
`issue_graph_liveness_backstop`, `issue_monitor_recovery[_issue]`,
`heartbeat_timer`, or no reason at all) and it names no comment. This is the
host's own list.

For a succeeded, issue-bound, no-event run the script reads the run's activity
on that issue (rows attributed by `runId`, issue entity, progress actions only)
and classifies it with a port of the host's progress rule
(`scripts/lib/monitor-housekeeping.mjs`):

| Outcome | Meaning |
|---|---|
| `noop_nothing`, `noop_housekeeping` | **No-op, host rule.** Nothing, or only `issue.monitor_scheduled` and `issue.updated` rows that touch monitor fields. |
| `no_event_comment_only` | The only visible act is a comment. The host counts a comment as progress, so these are not no-ops by the host rule. |
| `no_event_churn_only` | A comment and/or a real `issue.checked_out` event followed by a release update that restores the pre-checkout status and clears checkout locks, and nothing else. |
| `no_event_progress` | Anything else: a status change that sticks, a work product, a document, a blocker, and so on. |
| `no_event_unscoped`, `no_event_not_succeeded`, `no_event_unverified` | Set aside: no issue to judge, the run did not succeed, or its issue activity could not be read. |

Two figures follow, and they answer different questions:

- **No-op (host rule)** is the population the host's no-progress suppression can
  see. On the live fleet it is almost empty: a monitor check checks the issue
  out, comments and re-arms; the comment and the release `issue.updated` row
  count as progress to the host. The `issue.checked_out` row is retained only
  as context so the idle classifier can compare the release status with the
  issue's last status before checkout.
- **Idle** is no-op plus `comment_only` plus `churn_only`: runs that left only
  a note or checkout churn. It is a heuristic and an upper bound. A note such
  as "CI is green, review routed" is real information, and work done on
  GitHub is invisible in issue activity. It is the tracked figure because it is
  defined the same way every week. **Target: idle share of all runs under 10%.**

It also reports the share of runs by wake reason, the share of runs whose wake
carried no event, the host-rule no-ops that also moved another issue (a lower
bound), and `issue.monitor_triggered`, `issue.monitor_deferred` and
`issue.monitor_deferral_shadowed` counts inside the window. Deferral rows are
counted on every issue that a no-event run touched plus every issue with a
monitor armed now, so a deferred wake with no run is still seen.

## Limits, stated by the output

- The run list ignores `offset` and every time parameter and returns at most
  1000 runs per agent, so the script pages per agent. An agent whose full page
  stops short of the window start is listed in `truncatedAgents`, the report is
  marked `complete: false`, and its older runs are not counted. A 7-day window is
  truncated for the busiest agents; use `--hours 24` for a figure that is
  complete.
- Activity comes from `GET /api/issues/{id}/activity`, which is not capped. The
  company-wide activity list is not used: it cannot filter by run and caps at
  500 rows.
- The host reads at most 50 matching rows per run in an unspecified order; the
  script reads them all. That can only turn a housekeeping-only verdict into
  progress, never the reverse.
- Cost is not measured here. Run-level usage on resumed sessions is a running
  total, so summed per-run cost overstates; use a per-run delta for that.

## Keeping the port honest

The constants and `isMonitorOnlyIssueUpdateDetails` are copied from the host
(`heartbeat.ts`, `issue-rewake-throttle.ts`, `heartbeat-run-summary.ts`); the
file header names each source. `tests/noop-run-share.spec.ts` pins every branch
the host tests pin and the run attribution on top, and
`scripts/noop-run-share-mutation-gate.mjs` applies 14 one-line mutants (a
monitor-only update counted as progress, run attribution dropped, a checkout
release compared against the wrong starting status, and so on);
each must fail the suite.
