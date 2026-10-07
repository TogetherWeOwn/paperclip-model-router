# GitHub event wakes: PR, check and review events wake the owning card

**Result:** a host patch that turns bridged GitHub events into agent wakes.
A pull request event for a PR linked to an issue wakes that issue's agent
assignee while the issue is still being worked. `check_suite` and
`pull_request_review` are normalized into the linked PR snapshot so the
monitor wake policy reads them as new information, and GitHub-named
`external_service` monitors lose their policy exemption and get the 2-hour
floor and quiet skip too. Monitors become the fallback, as designed.

This repository does not own the Paperclip host source, so this is the
smallest exact patch plus executable verification. It has not been published
to a third-party repository. It stacks on the monitor wake policy packet:
apply [`monitor-wake-policy.patch`](./monitor-wake-policy.patch) first, then
this patch. Base: host fork commit `ee341c9b1` plus that packet, which this
patch reuses. It applies cleanly to that stack and to the live host tree
with the packet applied. Patch sha256
`0345508d636d3cd4537fa1517dc6a04023cf93a1b1ee037f9ee806ee584a97fe`.
Tracked for the next host build after the current cutover packet.

## Probe: which event types the connector actually leases

Read-only probe, decided in this packet rather than left open.

- Host code evidence: the sealed Cloud envelope carries a free-string
  `event`, but the host allowlists only `pull_request`,
  `installation_repositories` and `installation` in
  `normalizeLeasedPayload`. No host path produces or consumes `check_suite`
  or `pull_request_review` today; the existing bridge test covers only the
  merged-PR and installation shapes.
- Live-traffic proxy available to an agent: the company activity feed shows
  no `tool_connection.webhook_processed` rows in the recent window, and no
  agent-reachable API exposes `connection_event_deliveries` (the
  tool-connection activity route is board-only). A direct
  `SELECT DISTINCT event` needs operator database access. The exact query to
  confirm the Cloud subscription on deploy:
  ```sql
  SELECT event, count(*) FROM connection_event_deliveries
  WHERE provider = 'github'
    AND provider_created_at > now() - interval '7 days'
  GROUP BY 1 ORDER BY 2 DESC;
  ```

Decision, recorded here:

1. Host-side normalization now (this patch). It accepts both the
   Cloud-normalized flat shape and the raw GitHub nesting
   (`repository.full_name`, `check_suite.head_sha`, `review.state`), so the
   wakes activate the moment Cloud leases those types with no further host
   change.
2. Connector-side subscription as the follow-up: Cloud must lease
   `check_suite` and `pull_request_review` for CI and review signals to
   arrive. Queued for the host operator with this packet.
3. No new host-side polling of the checks API. Polling would add the very
   timers this work removes; the monitor fallback already covers unwatched
   state.
4. PR-event wakes deliver value immediately on current Cloud traffic, which
   provably includes `pull_request` (the existing snapshot path depends on
   it).

## Fix

`server/src/services/github-connection-events.ts`:

- `normalizeLeasedPayload` allowlists `check_suite` (repository, head sha,
  branch, status, conclusion) and `pull_request_review` (repository, PR
  number, review state, submitted time, head sha). Unknown event types are
  still received and acknowledged but touch nothing and wake nobody.
- A check suite names a commit, not a PR. It is attributed to the open PRs
  in the same repository pointing at that commit; suites on any other
  commit touch nothing. A review resolves its PR by repository plus number.
  Both merge a small `lastCheck*` / `lastReview*` record into the PR
  snapshot and move `lastChangedAt`, without changing the open/closed
  status. The monitor wake policy therefore treats them as external
  change and dispatches instead of deferring.
- A PR, check or review event wakes the agent assignee of every linked
  issue (`external_object_mentions`) whose status is `in_progress` or
  `in_review`. The reasons (`issue_github_pr_updated`,
  `issue_github_check_completed`, `issue_github_review_submitted`) are
  event-shaped: none is in `THROTTLED_ISSUE_REWAKE_REASONS`, so the rewake
  throttle passes them through. Deduplication is per delivery id
  (`github-event:{deliveryId}:{issueId}` against non-retryable wakeup rows),
  so re-leasing a delivery never wakes twice while a later delivery for
  the same PR wakes again. A missing or failing wakeup channel never fails
  the receipt: the snapshot is already durable.

`server/src/services/issue-thread-interactions.ts`: the internal wakeup
channel accepted only `reason: "issue_commented"`. It now accepts the
event-shaped reason strings above (still automation/system only). The one
existing caller is unchanged.

`server/src/services/issue-monitor-wake-policy.ts` plus the call site in
`server/src/services/heartbeat.ts`: the `external_service` exemption now
applies only to non-GitHub services. A service name containing "github"
(any case: "github", "github-actions", "GitHub CI") is evaluated by the
policy, because bridged events observe that state. Provider-quota recovery
monitors stay exempt via the quota check, which runs first.

## Artifact

Apply at the Paperclip host repository root, in order:

```bash
git apply --check monitor-wake-policy.patch
git apply monitor-wake-policy.patch
git apply --check github-event-wakes.patch
git apply github-event-wakes.patch
```

This adds wake and normalization logic to `github-connection-events.ts`,
widens the internal wakeup reason type, narrows the monitor exemption, and
adds one test file while updating the two monitor-policy test files from
the first packet.

## Verification (host source tree)

Against the live host tree with both packets applied, files restored
byte-identical afterwards (checksums verified):

```bash
cd server
../node_modules/.bin/vitest run src/__tests__/github-event-wakes.test.ts src/__tests__/github-connection-events.test.ts src/__tests__/issue-monitor-wake-policy.test.ts
../node_modules/.bin/vitest run src/__tests__/issue-monitor-wake-skip.test.ts src/__tests__/issue-monitor-scheduler.test.ts src/__tests__/issue-rewake-throttle.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
```

Results:

- Mutation control: with only the new/updated test files installed on the
  unpatched tree, both suites fail (4 of 6 wake tests fail; the 2 that pass
  are the negative guards matching legacy behavior, and the policy unit
  file cannot collect without the new module).
- Patched: 40 passed (wakes, bridge, policy unit) and 45 passed (skip,
  scheduler, throttle).
- Mutants, each killed by at least one test: status gate removed (todo
  issues wake); dedup disabled (a failed-receipt redelivery wakes twice);
  head-sha match removed (a foreign-commit suite touches the PR); blanket
  `external_service` exemption restored (3 unit plus 1 skip failure);
  exemption removed entirely (non-GitHub monitor deferred instead of
  dispatched).
- `tsc --noEmit`: exit 0.
- Sealed secrets never persist: leased payloads carrying a PR body, an
  OAuth token and a review body leave no trace in the receipt or snapshot
  (asserted in-test).

Known gap, same class as the first packet: the per-delivery idempotency
relies on the heartbeat persisting the wakeup row under that key. The test
double mirrors that contract explicitly; a heartbeat that dropped the key
would double-wake on failed-receipt redelivery.

## Effect

PR synchronize/open/close events now wake the owning card directly, so the
common "CI running / review landed / PR merged" polls have an event to wait
for. Check and review coverage follows automatically once Cloud leases
those types. GitHub-named external-service monitors join the 2-hour floor
and quiet skip, which the replay in the first packet did not count (it
treated every named service as exempt), so the measured deferral share only
grows.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text. This patch file is the tracked fork
input for that route.

## Rollback

Reverse the patch:

```bash
git apply -R github-event-wakes.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
Reversing restores the blanket `external_service` exemption from the first
packet; there is no runtime flag for the wakes themselves because they are
purely additive best-effort work.
