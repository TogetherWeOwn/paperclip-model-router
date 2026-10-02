Title: `fix(heartbeat): merge issue override env per key`
Branch: `fix/merge-issue-override-env-per-key`
Base: `master` at d9b64ee28

## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work.
> - A task can override the adapter settings of its assigned agent. The task-level model override in the UI (#9710) writes to this setting.
> - The setting is stored as `assigneeAdapterOverrides.adapterConfig`.
> - At run time, the heartbeat service spreads this object over the agent config.
> - The spread replaces the whole `env` object. An override that sets one environment key removes every other environment key of the agent, including secret references.
> - A caller must copy every agent environment entry into the override to avoid this loss. That copy spreads secret references into task data.
> - This pull request merges `env` per key. Every other key keeps the current replace behavior.
> - The benefit is that a task-level override can set one environment key and keep the agent credentials.

## Linked Issues or Issue Description

**What happened?**

An issue override that contains `env` replaces the complete `env` object of the agent config at run time. The agent loses every key that the override does not repeat. Secret references are lost the same way.

**Expected behavior**

The override `env` adds keys and replaces keys with the same name. Keys that the override does not mention stay in place.

**Steps to reproduce**

1. Configure an agent with `adapterConfig.env` that has a secret reference `API_TOKEN`.
2. Set `assigneeAdapterOverrides.adapterConfig` on an issue to `{ "model": "m", "env": { "EXAMPLE_KEY": "x" } }`.
3. Wake the agent on the issue.
4. The merged adapter config has `env` with only `EXAMPLE_KEY`. `API_TOKEN` is gone.

**Paperclip version or commit**

`master` at d9b64ee28. The merge is the spread in `executeRun` in `server/src/services/heartbeat.ts`.

**Related**

Refs #7612 (safe per-run model override), Refs #13743 (issue override model validation). Neither issue covers the `env` loss.

## What Changed

- Add `mergeIssueAdapterConfigOverrides` in `execution-workspace-policy.ts`. It merges `env` per key and spreads every other key.
- Call it from `executeRun` instead of the plain spread. The isolated task directory rule still applies after the merge.
- Add unit tests for the helper.

## Verification

- `pnpm exec vitest run server/src/__tests__/execution-workspace-policy.test.ts` — 44 tests pass.
- The new tests cover three cases: the override adds a key, the override replaces a key, and a base secret reference survives an override that omits it.
- Mutation check: I changed the helper to `next.env = overrideEnv`. Two new tests failed. I restored the helper and all 44 tests pass.
- `pnpm exec vitest run server/src/__tests__/heartbeat-project-env.test.ts server/src/__tests__/heartbeat-native-runner-selection.test.ts server/src/__tests__/heartbeat-retry-scheduling.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts server/src/__tests__/heartbeat-run-status-payload.test.ts` — 139 tests pass.
- `pnpm --filter @paperclipai/server exec tsc --noEmit` — no errors.

## Risks

- Low risk. A task override that sets no `env` behaves as before.
- An override with `env: {}` used to remove all agent environment keys. It now keeps them. An override cannot remove a key by leaving it out.
- This change adds no migration and no new setting.

## Model Used

- Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`) ported and verified this change against current `master`. It used a code-editing agent with shell and test execution.
- [AUTHOR-MODEL-LINE: audit must add the model that wrote the original change, from run records.]

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have considered documentation and no user-facing docs are affected by this internal merge fix
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
