# Monitor wake policy: a minimum interval and a quiet-card skip

**Result:** a host patch that avoids a full agent session for an unchanged
timer monitor. It normally waits at least 2 hours after the agent's last run,
then defers a quiet card up to 4 hours after that run. New input and a timeout
inside the proposed deferral dispatch immediately. The initial 24-hour replay
estimated a 13% reduction in all runs; that estimate predates the timeout fix
below. The revised policy's live savings are not yet measured.

This repository does not own the Paperclip host source, so this is the smallest
exact patch plus executable verification. It has not been published to a
third-party repository. Base: host fork commit
`ee341c9b1` (`fix(heartbeat): ignore monitor re-arm when measuring run progress
for comment suppression`), which the patch reuses. It applies cleanly to that
commit and to the live host tree. Patch sha256
`4c6f8f8e7d0a2761a155c4571ad90fb68933a0d8f4746282ae92745563e46f6d`.
Tracked for the next host build after the current cutover packet. Dependent
patch packets must be rebased and checked against this revised checksum before
stacking; the event-wake packet written against the initial version no longer
applies cleanly.

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
| `timeoutAt` is at or before the proposed next check | dispatch now, before timeout exhaustion |
| Due less than 2 hours after the run | defer to run end + 2 hours |
| Quiet, past 2 hours | defer 2 hours, never past run end + 4 hours |

A deferral re-arms the same monitor at a later time. It never consumes an
attempt, never clears the monitor, keeps `timeoutAt` and `maxAttempts`, never
moves the next look past `timeoutAt`, and keeps the raw policy fields (such as
the external reference) verbatim. The write is guarded on the claim token, so a
monitor an agent re-armed in the meantime is not overwritten.

Not touched: manual `monitor/check-now` checks, provider-quota recovery
monitors, monitors a board user scheduled, and monitors with either
`kind: "external_service"` or a non-empty, trimmed `serviceName`. The host does
not observe what those watch (CI, deploys), so a quiet card proves nothing.
A missing or blank service name does not exempt a timer. Lifting the exemption
per service is the job of the event-wake follow-up, once check and review events
reach the host.

A timeout is not a useful next-check time: the existing scheduler checks
`now >= timeoutAt` before evaluating this policy and starts recovery instead
of dispatching. If the timeout would cap the proposed deferral, the policy
dispatches immediately with `timeout_window_reached`. It does not change the
existing exhaustion behavior for monitors already expired at the current tick.

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

To measure the effect on the live fleet, re-run `scripts/noop-run-share.mjs`
(see [`noop-run-share.md`](./noop-run-share.md)) before and after the swap.

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

### Review-fix verification

The revised packet was reconstructed in an isolated export of host fork
`ee341c9b1`; no running platform files were changed. Tests use embedded
Postgres, not production data. From the exported repository root:

```bash
env -u NODE_ENV pnpm install --frozen-lockfile
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk build
env -u NODE_ENV pnpm --filter @paperclipai/paperclip-runner build:typescript
node_modules/.bin/vitest run server/src/__tests__/issue-monitor-wake-policy.test.ts server/src/__tests__/issue-monitor-wake-skip.test.ts
node_modules/.bin/tsc -p server/tsconfig.json --noEmit --pretty false
```

- Before the fixes, 15 regression cases fail: timeout dispatch, equality,
  all three recovery policies, and service-named monitors without `kind`.
  The database cases execute both the due tick and the expiry tick before
  asserting: the old implementation produces a recovery wake, a recovery
  issue, or no wake instead of `issue_monitor_due`.
- Final packet: 37 policy unit tests and 30 database-backed dispatch tests pass
  (67 total). The tests also cover a safe first deferral followed by an
  immediate check when the quiet window would cross the timeout.
- Nine pure-policy mutants are killed: compare timeout to now; allow timeout
  equality; dispatch every bounded monitor; remove the named-service or typed
  exemption; exempt blank service names; defer failed runs; ignore external
  changes; ignore new issue input.
- The intermediate implementation omitted `serviceName` from the scheduler's
  projection into the policy. Both named-service database tests failed despite
  green unit tests. The final packet forwards that field and passes both.
- Server typecheck exits 0 after building the runner's TypeScript declarations.
  Before that build, typecheck failed on missing runner exports, not the patch.
- Reapplying the exported patch to a fresh base reproduces the tested files
  byte-for-byte. `git apply --check` succeeds on the fork base and the live
  source tree; the live source was only checked, never patched.
- Repository checks: `npm run typecheck`, `npm test` (1,259 tests), and
  `npm run build` all pass.

## Replay estimate

The initial 24-hour run list and per-issue activity replay estimated 523 of 746
monitor wakes deferred (417 inside the 2-hour floor, 106 on quiet cards).
Collapsing 145 deferral chains estimated 378 runs avoided: 51% of monitor wakes
and 13% of all runs. This is a historical estimate, not a measurement of the
revised policy. It treats a named service as the `external_service` exemption,
sees only the 24-hour window, assumes the same re-arm cadence, and does not model
the timeout-window dispatch added after review. Those monitors now dispatch
rather than defer, so the revised savings must be recomputed. The weekly no-op
share measurement is a separate follow-up; the under-10% target is unproven.

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
