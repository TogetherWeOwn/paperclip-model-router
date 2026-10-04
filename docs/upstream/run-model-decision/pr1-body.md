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

- Refs #7612 (safe per-run model override) and Refs #13743 (issue override model validation). Neither issue covers the `env` loss.
- Related #6628: the same per-key `env` merge question for `PATCH /api/agents`, including whether `null` should delete a key. This PR does not change the agent update route.
- Related #14967: it edits the same merged-config line in `executeRun`. Whichever PR merges second needs a rebase. The per-key `env` merge must stay the last writer of `env` after that rebase.

## What Changed

- Add `mergeIssueAdapterConfigOverrides` in `execution-workspace-policy.ts`. It merges `env` per key and spreads every other key.
- Call it from `executeRun` instead of the plain spread. The isolated task directory rule still applies after the merge.
- Preserve an explicit non-object `env` (including `null`) as a clearing operation instead of merging the base env back over it. Downstream resolution maps a non-object env to `{}`, so `env: null` removes every agent environment key, matching the previous spread behavior. There is no per-key removal: an `env` entry set to `null` is not a valid binding and is rejected at secret resolution.
- Reject an override env key that differs only by letter case from a base key, before secret resolution. Environment names are case-sensitive on Linux but case-insensitive on Windows targets, so a case-variant alias would keep a shadowed secret binding that resolution must resolve before the launch layer folds the names. The error names both keys: use the exact base spelling to replace it, or pick a non-conflicting name.
- Add unit tests for the helper and a heartbeat regression test that runs `executeRun` with an agent env and an issue override env and asserts the adapter receives both keys, plus a null-clearing case through runtime resolution.
- No documentation describes how issue overrides merge into the agent config, so no doc changes.

## Verification

- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/execution-workspace-policy.test.ts src/__tests__/heartbeat-issue-override-env-merge.test.ts` — 51 tests pass (49 helper + 2 heartbeat).
- The helper tests cover: the override adds a key, the override replaces a key, a base secret reference survives an override that omits it, inputs are not mutated, an omitted override env keeps the base env, an explicit `env: null` is preserved as a clearing value, a non-object `env` is preserved, a case-variant alias (`api_token` over `API_TOKEN`) is rejected, exact matches still shadow case-sensitively, and the alias is rejected at the merge boundary before secret resolution (with a resolver double showing the shadowed binding would otherwise fail there with an unavailable-secret error).
- The heartbeat tests run `executeRun` against embedded Postgres: agent env `{HEARTBEAT_MERGE_BASE}` plus issue override env `{HEARTBEAT_MERGE_OVERRIDE}` delivers both keys to the adapter, and an explicit null override env clears every agent/issue key through runtime secret resolution.
- Mutation checks: I changed the helper to `next.env = overrideEnv` — 7 tests failed. I removed the alias guard — the 2 alias tests failed. I reverted the `executeRun` call site to the plain spread — the new heartbeat merge test failed while all 49 helper tests still passed (the integration gap this regression closes). I restored each mutant and the suites re-run green.
- `pnpm --filter @paperclipai/server exec vitest run` on the five existing heartbeat suites (`heartbeat-project-env`, `heartbeat-native-runner-selection`, `heartbeat-retry-scheduling`, `heartbeat-dependency-scheduling`, `heartbeat-run-status-payload`) — 139 tests pass; combined with the two files above, 190/190 across 7 files.
- `pnpm --filter @paperclipai/server exec tsc --noEmit` — no errors. (The full `paperclip-runner` package build stops at `build:binary` on missing `cargo` in this container; its TypeScript build completed and the server typecheck resolves cleanly.)
- Clean-room check: fresh clone of `master` at d9b64ee28 plus `git am` of this patch applies with no conflicts; `git diff --check` is clean.

## Risks

- Low risk. A task override that sets no `env` behaves as before.
- An override with `env: {}` used to remove all agent environment keys. It now keeps them. An override cannot remove a key by leaving it out.
- An override with `env: null`, or an `env` that is not an object, still removes all agent environment keys, as before. This is now a tested contract rather than an accident of the spread.
- An override env key that differs only by letter case from an agent env key (for example `api_token` over `API_TOKEN`) now fails the run with an explicit message instead of merging both spellings. Use the exact agent key spelling to replace it. Exact matches and non-conflicting keys behave as before on every target.
- Agent secret references now reach runs that use an `env` override. They are the same references the agent config already grants to that agent's runs.
- This change adds no migration and no new setting.

## Model Used

- Meta Muse Spark, version 1.3, wrote the original change. Reasoning effort was set to extra high (xhigh). The model has a 1M-token context, and the agent harness ran it with a 204k-token window. It worked in a coding agent with tool use, shell access and test execution.
- Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`, 200k-token context, extended thinking) ported the change to current `master` and verified it. It used the same kind of coding agent with tool use, shell access and test execution.

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
- [ ] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
