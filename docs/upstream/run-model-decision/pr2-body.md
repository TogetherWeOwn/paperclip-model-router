Title: `feat(heartbeat): add run-scoped model decision hook behind requireRunModelDecision`
Branch: `feat/run-model-decision-hook`
Base: `master` at d9b64ee28, with the PR 1 commit applied first.
Precondition: discuss in Discord `#dev` before opening (see CONTRIBUTING.md, Feature Contributions).

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work.
> - Plugins extend Paperclip. A plugin can choose how a task runs, for example which model it uses.
> - A plugin learns about a new task from an event. Event handlers return nothing that the host uses. The events also fire after the run is claimed.
> - A plugin that picks a model per task must therefore write a task-level override and then race the run. The run can start before the override exists.
> - Related work adds a veto before a run starts (#12949, #5033) and per-task account routing (#14967). Neither lets a plugin decide the model for one run.
> - This pull request adds `onResolveRunModel` and the `run.model.resolve` capability. The host calls the one capability holder per run, before it merges the adapter config, with a deadline.
> - The decision applies to that run only and is recorded on the run. If no decision arrives, the run waits as a bounded retry. It never starts on the default model.
> - The benefit is that a model router can set the model before the first run starts. It needs no stored override and copies no secrets.

## Linked Issues or Issue Description

**Subsystem affected**

server/ heartbeat service, plugin SDK, shared constants and instance settings.

**Problem or motivation**

No plugin hook can decide anything before a run starts. A plugin that routes tasks to models can only write an override after it sees an event. When classification takes longer than the gap between task creation and run start, the run starts on the agent default model. After a reassignment, the stored override can also stay behind.

**Proposed solution**

Add one synchronous, capability-gated hook that returns the model for one run. This is the "decide" form of the admission point in #12949. It reuses the run-scoped override pattern of #12123. The hook is off by default behind the instance setting `requireRunModelDecision`.

**Alternatives considered**

- A veto only (#12949, #5033): it can stop a run but it cannot choose a model.
- A stored per-issue override (#9710 and the PR 1 fix): the override exists after the run can start, and it follows the issue across reassignment (#13743).
- A new engine router in core (#7598): this change keeps the policy in a plugin.

**Roadmap alignment**

ROADMAP.md asks for a thin core with plugins at the edge. This change adds one generic hook and keeps the routing policy in plugins.

**Related**

Refs #12949, Refs #12123, Refs #5033, Refs #7612, Refs #7598, Refs #7901, Refs #13743, Refs #14967, Discussion #4456.

## What Changed

- Add the SDK method `onResolveRunModel`, the RPC `resolveRunModel` and the `run.model.resolve` capability. Add the manifest field `modelRouting.envKeys`.
- Add `run-model-decision.ts`. It holds the pure rules: skip rules, answer validation, holder selection, the park and retry decision, and the advisory mode.
- Call the hook in `executeRun` after the override parse and before the adapter config merge. Apply a decision to the merged config before secret resolution, and to the native runner provider input.
- Record the outcome in `contextSnapshot.modelDecision` and in later run lifecycle events.
- With `requireRunModelDecision` on, no decision parks the run as a `model_decision_pending` retry. The retry has its own counter and uses `scheduleBoundedRetryForRun`. After 12 attempts the host surfaces the issue.
- Add the instance setting `requireRunModelDecision`. It is off by default.
- Document the method in `PLUGIN_SPEC.md`.

## Verification

- `pnpm exec vitest run server/src/__tests__/run-model-decision.test.ts` — 20 tests pass.
- Tests cover: a decision is applied and recorded; an env key outside the manifest list parks the run; a secret binding key parks the run; a timeout parks the run; `defer` honors `retryAfterMs`; two holders park the run; a failed holder lookup parks the run; exhausted attempts surface the issue and never return the default; a user-requested wake runs on the default and is recorded as exempt; an override model skips the hook; the flag off records the advice and never applies it; a model change resets the session; non-issue runs and human assignees skip the hook.
- `pnpm exec vitest run` on the settings, projection, recovery, SDK and UI settings suites — 276 tests pass in 15 files.
- Five existing heartbeat suites — 139 tests pass.
- `pnpm --filter @paperclipai/server exec tsc --noEmit` — no errors.

## Risks

- The `executeRun` call site has no integration test with a database. The pure rules have unit tests. A follow-up should add a test that runs `executeRun` with a holder.
- With the flag on, a missing or slow holder delays every issue run. The host calls the holder with a 1.5 second deadline and retries up to 12 times. After that it surfaces the issue. The setting is off by default for this reason.
- A model change starts a new session. This is the behavior of an override change today.
- The hook is skipped when the issue carries an override model. The host cannot tell an operator override from a plugin override.
- Only one plugin per company can hold the capability. A second holder parks the run.
- This pull request touches the same part of `heartbeat.ts` as #14967. One of them must rebase after the other merges.
- This change adds no database migration.

## Model Used

- Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`) ported and verified this change against current `master`. It used a code-editing agent with shell and test execution.
- [AUTHOR-MODEL-LINE: audit must add the models that wrote the original change, from run records.]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
