# Monitor wake policy: a minimum interval and a quiet-card skip

**Result:** a host patch that stops a due monitor from starting a full agent
session when nothing changed since that agent's last run. A monitor never wakes
an agent sooner than 2 hours after its last run on the issue, and a quiet card
is deferred again up to 4 hours after that run. Replayed over 24 hours of real
runs, about half of all monitor wakes disappear (13% of all runs).

This repository does not own the Paperclip host source, so this is the smallest
exact patch plus executable verification. It has not been published to a
third-party repository. Base: host fork commit
`ee341c9b1` (`fix(heartbeat): ignore monitor re-arm when measuring run progress
for comment suppression`), which the patch reuses. It applies cleanly to that
commit and to the live host tree. Patch sha256
`304575f0dc570a5a7d3bbd4727ff7c4eec642ade916e5051ada1b3b08b5336b6`.
Tracked for the next host build after the current cutover packet.

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
| Due less than 2 hours after the run | defer to run end + 2 hours |
| Quiet, past 2 hours | defer 2 hours, never past run end + 4 hours |

A deferral re-arms the same monitor at a later time. It never consumes an
attempt, never clears the monitor, keeps `timeoutAt` and `maxAttempts`, never
moves the next look past `timeoutAt`, and keeps the raw policy fields (such as
the external reference) verbatim. The write is guarded on the claim token, so a
monitor an agent re-armed in the meantime is not overwritten.

Not touched: manual `monitor/check-now` checks, provider-quota recovery
monitors, monitors a board user scheduled, and `external_service` monitors. The
host does not observe what those watch (CI, deploys), so a quiet card proves
nothing. Lifting that last exemption per service is the job of the event-wake
follow-up, once check and review events reach the host.

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

Both intervals accept integers from 60000 to 86400000. A bad value falls back
to the default.

To see the effect before enforcing, start with `shadow` for a day and count
`issue.monitor_deferral_shadowed` rows. Rollback without a rebuild: set
`PAPERCLIP_MONITOR_WAKE_POLICY=off` and restart.

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

Results, run against the live host tree with the patch applied and restored
byte-identical afterwards:

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

## Replay estimate

The 24-hour run list and per-issue activity were replayed through the same
rules. Of 746 monitor wakes, 417 fell inside the 2-hour floor and 106 more hit
a quiet card, so 523 (70%) would have been deferred. A deferred monitor still
fires once at the end of its chain, so collapsing 145 chains leaves 378 runs
avoided: 51% of monitor wakes and 13% of all runs. This is an estimate, not a
measurement. It treats a named service as the `external_service` exemption, sees
only the 24-hour window, and assumes agents keep re-arming at the same cadence.
The weekly no-op share measurement is a separate follow-up.

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
