# GitHub event wakes: PR, check and review events wake the owning card

**Result:** a host patch that turns bridged GitHub events into coalescible
agent wakes. Meaningful PR actions wake linked, worked issues; housekeeping
only updates the snapshot. Check and review events update that snapshot and
wake the assignee when they reach the host. GitHub service monitors remain
exempt from throttling until the operator explicitly confirms event coverage.
Normalization alone does not prove that CI or review signals arrive.

This repository tracks the packet, not the Paperclip host source. Apply it
in an isolated contributor checkout, never in the serving platform tree.
It stacks on the **final** [`monitor-wake-policy.patch`](./monitor-wake-policy.patch)
(sha256 `29d8dca1e7a42996197db3955bd0c0124a6fd91a85531f105067e2df53eb88f6`).
The host base is `ee341c9b17e6d4c81eb0e54ea79806fb3f90cb31` plus that packet.
Event patch sha256:
`611c202d7090c382360e34933d56f4cb66fb2065513b97f0e34bbb10f25ced36`.
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
`synchronize` wake after a run has ended. Heartbeat integration tests cover
both queued work and a live issue turn: queued deliveries coalesce without
starting another run, while two deliveries during a seeded live run create one
deferred follow-up (`coalescedCount: 1`) and no extra heartbeat run. The active
run fixture is registered with the heartbeat's live-process map to avoid the
zombie-run filter. These tests do not simulate a live provider session or
measure production savings.

## Conditional monitor policy

The merged monitor packet dispatches with `timeout_window_reached` when
`timeoutAt` falls at or within two scheduler intervals after the proposed
deferral target. This margin accounts for a scheduler tick passing the timeout
before the policy runs; it is derived from the host scheduler interval and is
60 seconds at the default interval. This event packet preserves that fix and
the named-service-without-kind exemption.

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

Final review-fix verification uses an isolated checkout of the host base plus
the merged monitor packet; tests use embedded Postgres, never production data.
Set `HOST_CHECKOUT` to that repository root before running the commands below.

```bash
cd "$HOST_CHECKOUT"
env -u NODE_ENV pnpm install --frozen-lockfile
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
env -u NODE_ENV pnpm --filter @paperclipai/plugin-sdk build
env -u NODE_ENV pnpm --filter @paperclipai/paperclip-runner build:typescript
node_modules/.bin/vitest run server/src/__tests__/github-event-wakes.test.ts server/src/__tests__/github-connection-events.test.ts server/src/__tests__/issue-monitor-wake-policy.test.ts server/src/__tests__/issue-monitor-wake-skip.test.ts server/src/__tests__/issue-monitor-scheduler.test.ts server/src/__tests__/issue-rewake-throttle.test.ts
pnpm --filter @paperclipai/server exec tsc -p tsconfig.json --noEmit --pretty false
```

- BEFORE: the earlier new regression tests against the old event-wake
  implementation on the previous revision of the monitor packet produced **24 failures / 75
  passes**. Those failures covered housekeeping wakes, forced non-coalescing
  and absent coverage gating. The timeout-margin and running-run follow-up
  fixes were added after that baseline.
- AFTER: all six named host suites pass, **128/128 tests**, with server
  typecheck exiting 0. This includes the real-heartbeat queued and running-run
  coalescing/redelivery tests, the enabled/disabled monitor coverage gate and
  two-scheduler-interval timeout dispatch boundary.
- Ten independently applied mutants were killed by assertion failures:
  forced dedicated wakes; housekeeping wake filtering; delivery dedup;
  issue status gating; foreign-head attribution; coverage gating;
  non-GitHub service exemption; timeout equality; unconfirmed coverage
  default; and removing the three GitHub reasons from the running-run
  follow-up set (the running-turn regression fails). Each modified source
  file was restored after its mutant.
- Router checks on the merge with main: `npm run typecheck`, `npm test`
  (**105 files, 1,377 tests**), and `npm run build` all pass.
- Reconstruction: `git apply --check` and `git apply` accept the merged monitor
  packet and then this packet, in order, on a fresh clone of host fork
  `ee341c9b1`; the verification above ran on that clone. The packets have not been
  executed against the serving host tree. Live-host BEFORE/AFTER verification
  and the operator deployment handoff remain outstanding; no serving files
  were edited.

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
