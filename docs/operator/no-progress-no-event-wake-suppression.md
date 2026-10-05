# No-progress, no-event wake: suppress run-final-message comments

**Result:** a host patch that stops publishing a run's final message as an issue
comment when the wake carried no new event and the run left no issue-visible
progress. The text stays in the run log; the thread stays clean.

This repository does not own the Paperclip host source, so this is the smallest
exact upstream patch plus executable verification. It has not been published to
a third-party repository. Base: host fork commit
`14f66a7cf6422b43fe87d1d747ceabdf9f23b583`. Patch sha256
`0dbecf9c1cbdf6e0a2917cbec6dc569803b8775546e68551f38bfb5db8ec5838`.
Tracked for the next host build after the current cutover packet; it does not
disturb that packet.

## Problem

Agents comply with "no comment on a no-op wake", but the host itself turned the
run's final message into an issue comment. Presentation decisions showed
`chosenSource: "adapter_final_response"`, `commentAction: "create"` with
legacy-compatibility reason codes on wakes that changed nothing. Hundreds of
no-op notes landed fleet-wide in hours.

## Fix

In `server/src/services/heartbeat-run-summary.ts`:

- Add a no-event wake set: the existing throttle set (assignment,
  continuation, assignment recovery, liveness backstop) plus monitor-due,
  monitor-recovery (both spellings) and the unscoped timer wake. A missing
  reason (reason-less on-demand invoke) also counts as event-free.
- Extend `resolveHeartbeatRunResponse()` with optional `wakeReason`,
  `wakeCommentId` and `runMadeIssueProgress`. When the wake is event-free, no
  wake comment id is present, and progress is explicitly `false`, return
  `decision("none", { reasonCodes: ["no_progress_no_event_wake"] })` with null
  text.
- The check sits after explicit-comment reuse, external-chat precedence and
  yielded-wait handling, so those paths are unchanged. Omitting the new fields
  preserves legacy behavior for all existing callers.

In `server/src/services/heartbeat.ts` (finalization):

- Read the wake reason and wake comment id from the run's persisted context
  snapshot and query the activity log for any progress action attributed to
  this run on this issue (or an explicit run comment, which counts as
  progress). Pass the three values into the resolver.

## Artifact

Apply [`no-progress-no-event-wake-suppression.patch`](./no-progress-no-event-wake-suppression.patch)
at the Paperclip host repository root:

```bash
git apply --check no-progress-no-event-wake-suppression.patch
git apply no-progress-no-event-wake-suppression.patch
```

## Verification (host source tree)

```bash
cd server
../node_modules/.bin/vitest run src/__tests__/heartbeat-run-summary.test.ts
../node_modules/.bin/vitest run src/services/native-runtime/paperclip-control-plane-port.test.ts src/services/native-runtime/native-runner-file-handoff.test.ts
../node_modules/.bin/tsc --noEmit --pretty false
```

Results on the patched tree:

- `heartbeat-run-summary.test.ts`: 51 passed (46 existing + 5 new).
- Consumer suites (`paperclip-control-plane-port`, `native-runner-file-handoff`):
  33 passed.
- `tsc --noEmit`: clean.

New tests cover: no-op monitor/continuation/assignment/recovery/liveness/timer
and reason-less wakes publish nothing; a wake with run progress still
publishes; an explicit run comment still reuses; a comment wake (wake comment
id, or comment reason) still publishes; omitted progress flags preserve legacy
behavior.

## Upstream route

Upstream publication goes through the normal audits, steward and operator
review path with public-safe text (no internal ticket ids, links or hosts).
This patch file is the tracked fork input for that route.

## Rollback

Before commit, reverse the patch:

```bash
git apply -R no-progress-no-event-wake-suppression.patch
```

After commit, use the host repository's normal `git revert <commit>` path.
Rollback restores legacy publishing of final messages on no-op wakes.
