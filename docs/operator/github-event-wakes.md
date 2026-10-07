# GitHub event wakes: PR, check and review events wake the owning card

**Result:** a host patch that turns bridged GitHub events into coalescible
agent wakes. Meaningful PR actions wake linked, worked issues; housekeeping
only updates the snapshot. Check and review events update that snapshot and
wake the assignee when they reach the host. GitHub service monitors remain
exempt from throttling until the operator explicitly confirms event coverage.
Normalization alone does not prove that CI or review signals arrive.

This repository tracks the packet, not the Paperclip host source. Apply it
in an isolated contributor checkout, never in the serving platform tree.
It stacks on the **revised** [`monitor-wake-policy.patch`](./monitor-wake-policy.patch)
(sha256 `4c6f8f8e7d0a2761a155c4571ad90fb68933a0d8f4746282ae92745563e46f6d`).
The host base is `ee341c9b17e6d4c81eb0e54ea79806fb3f90cb31` plus that packet.
Event patch sha256:
`a0abf87bdbfc52a4a05962849fa2b236e087b0b35ad02f8d6c192e20c13e1ad7`.
Host release and connector verification remain operator work after review.

## Probe and decision

The read-only agent probe established a capability gap, not event coverage:

- The existing host normalizer handles only `pull_request`, `installation`
  and `installation_repositories`. The sealed Cloud envelope allows other
  event strings, but the host does not normalize them yet.
- The recent company activity feed showed no `tool_connection.webhook_processed`
  rows. No agent-accessible API exposes the delivery table; its activity route
  is board-only. **Actual leased event types could not be verified.** An empty
  activity result does not prove Cloud omits check or review events.
- Existing PR normalization is a code path, not a receipt proving that a
  particular live repository receives events.

The operator's exact read-only delivery probe is:

```sql
SELECT company_id, installation_id, repository_id, event, status, count(*)
FROM connection_event_deliveries
WHERE provider = 'github'
  AND provider_created_at > now() - interval '7 days'
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;
```

Decision: normalize check and review events in the host now. If the probe
finds either type missing, extend the **connector's subscription**, not a
second host checks-API poller. Keep existing service monitors exempt while
coverage is absent or unknown. The operator handoff owns both the probe and
any connector change; neither is claimed complete here.

## Wake behavior

`server/src/services/github-connection-events.ts`:

- PR wake actions are `opened`, `reopened`, `synchronize`, `closed`,
  `ready_for_review` and `review_requested`. Housekeeping such as `edited`,
  `labeled`, `assigned` and unknown actions still refreshes the PR snapshot,
  but does not request agent work.
- `check_suite` accepts repository, head SHA, branch, status and conclusion.
  A check is attributed only to non-terminal PRs in that repository on the
  exact head SHA. A foreign-commit check touches nothing.
- `pull_request_review` accepts repository, PR number, review state,
  submitted time and head SHA. Both check and review payloads accept the
  Cloud flat shape and raw GitHub nesting. Only allowlisted, bounded fields
  persist; PR/review bodies and credentials do not.
- Checks and reviews merge `lastCheck*` / `lastReview*` fields into the PR
  snapshot and move `lastChangedAt`. They do not open or close the PR.
- Linked issue assignees wake only for `in_progress` and `in_review` issues.
  Reasons are `issue_github_pr_updated`, `issue_github_check_completed` and
  `issue_github_review_submitted`, outside the no-information rewake throttle.
- Delivery/issue keys (`github-event:{deliveryId}:{issueId}`) deduplicate
  against durable, non-retryable wake rows. Failed-receipt redelivery does
  not duplicate an already admitted wake, including a coalesced wake.
- The bridge does **not** force `allowRunCoalescing:false`. Ordinary
  heartbeat admission may coalesce into existing work or merge deferred
  work instead of creating a dedicated session per delivery. It does not
  override the heartbeat's interaction or fresh-session boundaries.
- A missing or failing wakeup channel does not fail the event receipt; the
  snapshot stays durable and monitors remain a fallback.

The internal wakeup type in `issue-thread-interactions.ts` accepts the
additional event-shaped reason strings. The existing interaction caller is
unchanged.

GitHub actions share an owner identity across agents. This packet does not
invent an actor-to-agent mapping or claim to eliminate every self-authored
`synchronize` wake after a run has ended. The regression test proves two
consecutive deliveries coalesce into existing **queued** work through the
real heartbeat, without another run; it does not simulate a live provider
session or measure production savings.

## Conditional monitor policy

The revised first packet already fixes the timeout-cap defect: dispatch
immediately with `timeout_window_reached` when a proposed deferral would
reach or cross `timeoutAt`, before the scheduler can exhaust the monitor.
This packet preserves that fix and the named-service-without-kind exemption.

`PAPERCLIP_GITHUB_MONITOR_EVENTS_CONFIRMED` is **off by default**. Only the
exact value `true` lifts the exemption for service names containing `github`
(case-insensitive). It covers both typed `external_service` monitors and
service-named monitors without a kind. Other named services, unnamed typed
external services, quota recovery, manual checks and board monitors remain
exempt.

Because the flag is host-wide, do not set it after observing one repository.
Before enabling it, the operator must confirm **both** processed
`check_suite` and `pull_request_review` deliveries for every monitored
installation/repository across the affected companies, and correlate real
receipts with the linked PR's updated snapshot. Unknown or incomplete
coverage means leave the flag unset. Revert it to `false` and restart if
coverage is lost. This packet does not auto-promote based on normalization.

## Apply and release

In an isolated checkout of the host base, apply in order:

```bash
git apply --check monitor-wake-policy.patch
git apply monitor-wake-policy.patch
git apply --check github-event-wakes.patch
git apply github-event-wakes.patch
```

Run the verification below, publish through the normal audited upstream
route, and upgrade the host to the reviewed release. Do not patch the live
platform in place. Default deployment leaves the confirmation flag unset,
so current GitHub service-monitor latency does not change. Enable it only
after the delivery probe and snapshot correlation above succeed.

## Verification

The initial packet had BEFORE/AFTER execution against the live host source,
restored byte-identical afterwards: 40 bridge/policy tests and 45 adjacent
monitor/throttle tests passed. Its five original mutation families were
killed. Those historical results do not prove the review revisions.

Review-fix verification uses an isolated export of the host base plus the
revised first packet; tests use embedded Postgres, never production data.
From the exported repository root:

```bash
env -u NODE_ENV pnpm install --frozen-lockfile
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk build
env -u NODE_ENV pnpm --filter @paperclipai/paperclip-runner build:typescript
node_modules/.bin/vitest run server/src/__tests__/github-event-wakes.test.ts server/src/__tests__/github-connection-events.test.ts server/src/__tests__/issue-monitor-wake-policy.test.ts server/src/__tests__/issue-monitor-wake-skip.test.ts server/src/__tests__/issue-monitor-scheduler.test.ts server/src/__tests__/issue-rewake-throttle.test.ts
node_modules/.bin/tsc -p server/tsconfig.json --noEmit --pretty false
```

- BEFORE: the new regression tests against the old event-wake implementation
  on the revised first packet produce **24 failures / 75 passes**. Failures
  cover housekeeping wakes, forced non-coalescing and absent coverage gating.
- AFTER: all six named host suites pass, **125/125 tests**, with server
  typecheck exiting 0. This includes the real-heartbeat coalescing/redelivery
  test, the enabled/disabled monitor coverage gate and pre-timeout dispatch
  of a confirmed GitHub monitor.
- Nine independently applied mutants are killed by assertion failures:
  forced dedicated wakes; housekeeping wake filtering; delivery dedup;
  issue status gating; foreign-head attribution; coverage gating;
  non-GitHub service exemption; timeout equality; unconfirmed coverage
  default. Each modified source file is restored after its mutant.
- Router checks: `npm run typecheck`, `npm test` (**1,259 tests**), and
  `npm run build` all pass.
- Reconstruction: both revised packets apply in order to read-only snapshots
  of the live target files. The bridge source is byte-identical to the tested
  fork export. Other live source has surrounding drift, so applicability
  alone is not claimed as full live-runtime execution.
- Four live target checksums remain unchanged; no serving files were edited.

## Rollback

To remove only the event packet in an uncommitted contributor checkout:

```bash
git apply -R github-event-wakes.patch
```

This restores the first packet's blanket service exemption and removes
bridge wakes/check-review normalization. For an installed release, use the
operator's supported previous-release upgrade path, not a reverse patch in
the serving tree. To restore only monitor latency, set
`PAPERCLIP_GITHUB_MONITOR_EVENTS_CONFIRMED=false` and restart; to disable the
entire first packet's optimization, use `PAPERCLIP_MONITOR_WAKE_POLICY=off`.
