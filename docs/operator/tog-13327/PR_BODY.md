<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The heartbeat service classifies each finished run as succeeded or failed
> - The terminal-result cleanup SIGTERMs a lingering background task after the adapter already produced its terminal result
> - The CLI then exits 143, and the heartbeat marks the successful run as failed with `adapter_failed`
> - Agents go to error and stall until an operator resets them
> - This pull request forgives the cleanup-induced exit 143 / SIGTERM when the adapter itself reports success
> - The benefit is successful runs stay successful, and real failures still fail as before

## Linked Issues or Issue Description

No public issue exists in this repo for this bug, so the bug is described here.

**What happened?**
Successful `claude_local` runs are recorded as failed with `adapter_failed` and exit code 143. Every affected run has `result_json.subtype=success`, `is_error=false`, and `unmanagedBackgroundTask = {kind: terminal_result_cleanup, stopped: true, terminalResultSeen: true, forceKilled: false}`. The run produced its terminal result first. The terminal-result cleanup then SIGTERMed a leftover background task (for example a CI watch). The CLI exited 143. The heartbeat classified the run as failed. Each failure errors the agent, and the agent stalls until an operator resets it.

**Expected behavior**
A cleanup-induced exit 143 or SIGTERM after a terminal success result does not fail the run. The run is recorded as succeeded. The agent stays in service.

**Steps to reproduce**
1. Start a run whose agent backgrounds a task that outlives the terminal result (for example a CI watch).
2. Wait for the terminal result, then for the cleanup grace period to expire.
3. Observe the run recorded as failed with exit code 143 and `adapter_failed`, although the result is a success.

**Paperclip version or commit**
Fork line at `e60553d3`.

**Deployment mode**
Self-hosted server.

Related upstream discussion (same symptom, CLI-side cleanup): `paperclipai/paperclip#4307`. No upstream fix exists for this heartbeat seam. The adapter on this line already treats these results as success. The bug is only in the heartbeat outcome gate.

## What Changed

- Added `server/src/services/terminal-cleanup-outcome.ts` with `isTerminalResultCleanupSuccess`. It returns true only when the adapter reports no failure (no `errorMessage` and no `errorCode`), the `unmanagedBackgroundTask` evidence shows `terminalResultSeen: true`, and the process end is exit 143 and/or SIGTERM with no other exit code or signal.
- Used the predicate in the heartbeat outcome gate in `server/src/services/heartbeat.ts`. A forgiven end of process now yields `succeeded` instead of `failed` / `adapter_failed`.
- Added `server/src/__tests__/heartbeat-terminal-cleanup-outcome.test.ts` with 9 cases: the live failure shape, the SIGTERM variant, and 7 still-failing shapes.
- Added a process-level fixture in `packages/adapter-utils/src/server-utils.test.ts`: a child prints a terminal result, then exits 143 on cleanup SIGTERM. It asserts the exact evidence shape the predicate consumes.

## Verification

- `vitest run server/src/__tests__/heartbeat-terminal-cleanup-outcome.test.ts`: 9 passed.
- `vitest run packages/adapter-utils/src/server-utils.test.ts -t "clean"`: 4 passed (3 existing cleanup tests plus the new 143 fixture).
- `tsc --noEmit` in `packages/adapter-utils`: clean.
- `tsc --noEmit -p server/tsconfig.json`: exit 0, no errors.
- I did not run the full workspace suite or open-CI. The Agent token cannot read Actions check runs, so CI status on the PR needs the normal review path.

## Risks

- Low risk. The forgiveness needs all three signals at once: adapter success, seen terminal result, and a 143/SIGTERM end. One missing signal keeps the old behavior.
- Refusal codes keep failing. A refusal carries an `errorCode` with a null message, and any set `errorCode` blocks forgiveness.
- `is_error` results keep failing. They always set an adapter `errorMessage`.
- A force-kill escalation that ends in SIGKILL or exit 137 still fails. Only the observed 143/SIGTERM shape is forgiven. A follow-up can extend this if SIGKILL-after-success shows the same pattern.
- No migration. No schema change. No config change.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

- Muse, assigned model `muse-canary` (xhigh effort tier), via a Paperclip agent run with tool use and code execution.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] I have updated relevant documentation to reflect my changes (no user-facing doc describes this gate; behavior is documented in code comments)
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
