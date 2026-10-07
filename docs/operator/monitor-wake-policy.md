# Monitor wake policy: a minimum interval and a quiet-card skip

**Result:** a host patch that avoids a full agent session for an unchanged
timer monitor. It normally waits at least 2 hours after the agent's last run,
then defers a quiet card up to 4 hours after that run. New input dispatches
immediately. A timeout at or before the proposed deferral target plus two
scheduler intervals also dispatches immediately, avoiding a timeout race on the
next scheduler tick. The initial 24-hour replay estimated a 13% reduction in all
runs; that estimate predates the timeout-margin fix below. The revised policy's
live savings are not yet measured.

This repository does not own the Paperclip host source, so this is the smallest
exact patch plus executable verification. It has not been published to a
third-party repository. Base: host fork commit
`ee341c9b1` (`fix(heartbeat): ignore monitor re-arm when measuring run progress
for comment suppression`). The packet targets that base. Its monitor policy
source was tested in an isolated checkout; the final database fixture
refinement is called out under verification. It has not been rechecked or
executed against the serving host tree; live-host BEFORE/AFTER verification
remains outstanding, and no serving source was modified. Patch sha256
`29d8dca1e7a42996197db3955bd0c0124a6fd91a85531f105067e2df53eb88f6`.
Tracked for the next host build after the current cutover packet. Dependent
patch packets must be rebased and checked against this revised checksum before
stacking.

## Problem

A monitor is a timer. Agents arm one to look at something again later, and each
due monitor starts a full adapter session. When the agent re-arms for an hour
and nothing moved in between, the session pays full price for no new
information. Monitor wakes are exempt from the existing re-wake throttle on
purpose (they are event-shaped), and every no-op monitor run re-arms its own
monitor, which the throttle reads as progress.

Measured on the live fleet over 24 hours (2,914 runs): 746 runs (25.6%) were
woken by `issue_monitor_due`, and 218 of the 730 that succeeded ended with a
host-published final-message comment, the signature of a no-op note. Only 5
runs came from `issue_continuation_needed`, which the existing throttle already
covers, so this patch leaves continuation wakes alone.

## Fix

New pure module `server/src/services/issue-monitor-wake-policy.ts`, wired into
`dispatchClaimedIssueMonitor` in `server/src/services/heartbeat.ts`. Before a
due monitor enqueues a wake, the policy reads three facts and decides:

- the target agent's newest finished run on the issue;
- whether any issue input landed after it. Monitor housekeeping and the run's
  own activity do not count, using the same classifier that decides run
  progress for comment suppression;
- whether a linked external object (a pull request) changed or was linked after
  it.

Rules, in order:

| Condition | Decision |
| --- | --- |
| No finished run in the last 4 hours, or the last run did not succeed | dispatch (recovery is never delayed) |
| Last run ended 4 or more hours ago | dispatch (quiet backstop) |
| New issue input or a linked external change since the run | dispatch |
| `timeoutAt` is at or before the proposed next-check target plus two scheduler intervals | dispatch now, before timeout exhaustion |
| Due less than 2 hours after the run | defer to run end + 2 hours |
| Quiet, past 2 hours | defer 2 hours, never past run end + 4 hours |

A deferral re-arms the same monitor at a later time. It never consumes an
attempt, never clears the monitor, keeps `timeoutAt` and `maxAttempts`, never
moves the next look past `timeoutAt`, and keeps the raw policy fields (such as
the external reference) verbatim. The write is guarded on the claim token, so a
monitor an agent re-armed in the meantime is not overwritten.

Not touched: manual `monitor/check-now` checks, provider-quota recovery
monitors, and monitors a board user scheduled. Monitors with either
`kind: "external_service"` or a non-empty, trimmed `serviceName` stay exempt by
default because the host does not observe what they watch (CI, deploys). Exactly
`PAPERCLIP_GITHUB_MONITOR_EVENTS_CONFIRMED=true` lifts that exemption only for
service names containing `github` (case-insensitive), including when `kind` is
omitted. This is an operator confirmation gate, not GitHub event ingestion; do
not enable it until check and review delivery coverage is verified for every
affected installation and repository. Unknown or incomplete coverage means
leave it unset. Other named services and unnamed typed external-service monitors
remain exempt. A missing or blank service name by itself does not exempt a
timer.

The scheduler can pass a timeout that lands just after the proposed target
before this policy runs. The policy dispatches with
`timeout_window_reached` when `timeoutAt <= deferUntil + timeoutDispatchMarginMs`,
where the margin is two scheduler intervals:
`2 * Math.max(10_000, Number(HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30_000)`. With
the default 30-second scheduler interval, the margin is 60 seconds. This does not
change the existing exhaustion behavior for monitors already expired at the
current tick.

Failure mode: any error while reading evidence logs a warning and falls through
to the legacy dispatch. The policy is an optimization and cannot lose a wake.

Activity: an enforced deferral writes `issue.monitor_deferred`, and shadow mode
writes `issue.monitor_deferral_shadowed`, each with the reason, the new time,
the last run and the settings. The UI activity labels cover both.

## Settings (all optional)

- `PAPERCLIP_MONITOR_WAKE_POLICY`: `enforce` (default), `shadow` (evaluate and
  record, never defer) or `off` (legacy). Any other value means `enforce`.
- `PAPERCLIP_MONITOR_MIN_INTERVAL_MS`: default `7200000`.
- `PAPERCLIP_MONITOR_QUIET_BACKSTOP_MS`: default `14400000`, never below the
  minimum interval.
- `PAPERCLIP_GITHUB_MONITOR_EVENTS_CONFIRMED`: defaults to `false`; only the
  exact value `true` lifts the service-monitor exemption for names containing
  `github`, case-insensitively. Enable only after operators verify check and
  review delivery coverage; this patch does not implement event ingestion.

Both interval settings accept integers from 60000 to 86400000. A bad value
falls back to the default.

To see the effect before enforcing, start with `shadow` for a day and count
`issue.monitor_deferral_shadowed` rows. Rollback without a rebuild: set
`PAPERCLIP_MONITOR_WAKE_POLICY=off` and restart.

This source packet does not measure live run savings.

## Artifact

Apply [`monitor-wake-policy.patch`](./monitor-wake-policy.patch) at the
Paperclip host repository root. It adds one module and two test files, and
edits `heartbeat.ts` and `ui/src/lib/activity-format.ts`.

```bash
git apply --check monitor-wake-policy.patch
git apply monitor-wake-policy.patch
```

## Verification (host source tree)

```bash
cd server
../node_modules/.bin/vitest run src/__tests__/issue-monitor-wake-policy.test.ts src/__tests__/issue-monitor-wake-skip.test.ts
../node_modules/.bin/vitest run src/__tests__/issue-monitor-scheduler.test.ts src/__tests__/issue-rewake-throttle.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
cd ../ui && node_modules/.bin/vitest run src/lib/activity-format.test.ts
```

Initial packet results, before the review fixes below, run against the live
host source tree with the patch applied and restored byte-identical afterwards:

- Mutation control: with only the two new test files installed on the
  unpatched tree, 8 of the 21 database-backed tests failed (the 13 that passed
  are the dispatch cases that match legacy behavior).
- Patched: 25 unit tests and 21 embedded-Postgres tests pass.
- Mutants, each killed by at least one test: monitor-only `issue.updated`
  counted as input; the last run's own activity counted as input; external
  change ignored; timeout cap removed; `external_service` exemption removed;
  failed last run no longer dispatches; manual check no longer exempt.
- `tsc --noEmit`: exit 0. UI `activity-format` tests: 15 passed.
- Adjacent suites on the patched tree: `issue-monitor-scheduler` and
  `issue-rewake-throttle` pass in isolation. A 12-file consumer batch ran 359
  passed and 4 failed, all in `heartbeat-stale-queue-invalidation`
  (issue-claim serialization). That file fails 2 of 48 on the unpatched tree
  and passes 48 of 48 on the patched tree when run alone, so it is a
  load-dependent timing flake outside the changed path. The scheduler test
  "wakes a cross-agent review participant for provider quota monitors" times
  out on some runs on both trees and passes alone.

Known gap: the claim-token guard on the deferral write is not mutation-tested,
because a re-arm between the claim and the write cannot be staged without
hooking the database.

### Final review-fix verification

The monitor policy was tested in an isolated checkout of host fork `ee341c9b1`.
Tests use embedded Postgres, not production data; the serving host source was
not modified. From that checkout:

```bash
node_modules/.bin/vitest run server/src/__tests__/issue-monitor-wake-policy.test.ts server/src/__tests__/issue-monitor-wake-skip.test.ts
pnpm --filter @paperclipai/server exec tsc -p tsconfig.json --noEmit --pretty false
```

- The most recent monitor-specific run passed **67/67 tests**; server TypeScript
  checking exited 0. That run preceded the final database fixture refinement below.
- The pure timeout boundary test uses a 10-second scheduler interval: a timeout
  exactly 20,000 ms after the proposed target dispatches; one 20,001 ms after
  it still defers.
- The database regression now targets a due monitor at 12:30, a proposed
  deferral at 14:10, `timeoutAt` at 14:10:20, and a later scheduler tick at
  14:10:31. With the 30-second default interval, the initial 12:31 tick must
  dispatch within the 60-second margin; otherwise the later tick would exhaust
  the monitor. It asserts one `issue_monitor_due` wake and no deferral or
  exhaustion. This fixture refinement was not rerun against a host checkout in
  this update; the previously executed version used a 14:10:30 second tick and
  an explicitly confirmed GitHub-service monitor. The current fixture is an
  ordinary timer monitor so it isolates timeout-margin behavior from the
  service-coverage gate.
- These are isolated-checkout results, not live-host BEFORE/AFTER execution.
  That verification and the operator deployment handoff remain outstanding;
  no serving host files were changed.

## Replay estimate

The initial 24-hour run list and per-issue activity replay estimated 523 of 746
monitor wakes deferred (417 inside the 2-hour floor, 106 on quiet cards).
Collapsing 145 deferral chains estimated 378 runs avoided: 51% of monitor wakes
and 13% of all runs. This is a historical estimate, not a measurement of the
revised policy. It treats every named service as exempt under the default confirmation setting,
sees only the 24-hour window, assumes the same re-arm cadence, and does not model
the timeout-window dispatch added after review. Those monitors now dispatch
rather than defer, so the revised savings must be recomputed.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text. This patch file is the tracked fork input
for that route.

## Rollback

Set `PAPERCLIP_MONITOR_WAKE_POLICY=off` and restart for an immediate return to
legacy dispatch. To remove the code before commit, reverse the patch:

```bash
git apply -R monitor-wake-policy.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
