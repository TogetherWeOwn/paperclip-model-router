Title: `fix(heartbeat): merge issue override env per key`
Branch: `fix/merge-issue-override-env-per-key`
Base: `master` at 994d6edc

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

`master` at 994d6edc. The merge is the spread in `executeRun` in `server/src/services/heartbeat.ts`.

**Related**

- Refs #7612 (safe per-run model override) and Refs #13743 (issue override model validation). Neither issue covers the `env` loss.
- Related #6628: the same per-key `env` merge question for `PATCH /api/agents`, including whether `null` should delete a key. This PR does not change the agent update route.
- Related #14967: it edits the same merged-config line in `executeRun`. Whichever PR merges second needs a rebase. The per-key `env` merge must stay the last writer of `env` after that rebase.

## What Changed

- Add `mergeIssueAdapterConfigOverrides` in `execution-workspace-policy.ts`. It merges `env` per key and spreads every other key.
- Call it from `executeRun` instead of the plain spread. The isolated task directory rule still applies after the merge.
- Preserve an explicit non-object `env` (including `null`) as a clearing operation instead of merging the base env back over it. Downstream resolution maps a non-object env to `{}`, so `env: null` removes every agent environment key, matching the previous spread behavior. There is no per-key removal: an `env` entry set to `null` is not a valid binding and is rejected at secret resolution.
- Reject an override env key that shares a case-insensitive name with any base key, before secret resolution, unless the base carries exactly that one spelling. Environment names are case-sensitive on Linux but case-insensitive on Windows targets, so a case-variant alias would keep a shadowed secret binding that resolution must resolve before the launch layer folds the names. When the base already carries several spellings of one name, every override of that name is rejected, since no single spelling can replace them all. The error names the key and every inherited spelling. This rejection runs on every target, so a conflicting override also fails on Linux even though the process variables would be distinct there.
- Add unit tests for the helper and heartbeat regression tests that run `executeRun` with an agent env and an issue override env: the adapter receives both keys, an explicit null override env clears every key through runtime resolution, and a multi-spelling base group with valid plain bindings fails the run before the adapter executes with the alias-conflict cause asserted on the run record.
- No documentation describes how issue overrides merge into the agent config, so no doc changes.

## Verification

- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/execution-workspace-policy.test.ts src/__tests__/heartbeat-issue-override-env-merge.test.ts` — 60 tests pass (53 helper + 7 heartbeat-file: 4 integration + 3 fixture-lifecycle fault-injection; the integration tests were verified here on the isolated PostgreSQL test service via a local provisioning redirect — the tracked file uses the embedded helper).
- The helper tests cover: the override adds a key, the override replaces a key, a base secret reference survives an override that omits it, inputs are not mutated, an omitted override env keeps the base env, an explicit `env: null` is preserved as a clearing value, a non-object `env` is preserved, a case-variant alias (`api_token` over `API_TOKEN`) is rejected, exact matches still shadow case-sensitively, the alias is rejected at the merge boundary before secret resolution (with a resolver double showing the shadowed binding would otherwise fail there with an unavailable-secret error), a multi-spelling base group rejects in either base input order, an exact override over another spelling rejects, an unavailable reference in another spelling rejects before resolution, and a Windows-fold double shows the inherited alias would otherwise overwrite the replacement.
- The heartbeat tests run `executeRun` against the isolated PostgreSQL test service: agent env `{HEARTBEAT_MERGE_BASE}` plus issue override env `{HEARTBEAT_MERGE_OVERRIDE}` delivers both keys to the adapter; an explicit null override env clears every agent/issue key through runtime secret resolution; a multi-spelling base group with valid plain bindings fails the run before the adapter executes with the alias-conflict cause asserted on the run record; a fixture diagnostic proves setup-failure cleanup restores only the env keys actually written; and three fixture-lifecycle fault-injection tests prove a database/home directory that arrives after teardown is cleaned without publishing state, and that database cleanup still runs when home removal fails.
- Mutation checks, each labelled with the exact executed scope. Two-file command `vitest run src/__tests__/execution-workspace-policy.test.ts src/__tests__/heartbeat-issue-override-env-merge.test.ts` (60 tests): flattening the merge to `next.env = overrideEnv` fails 4 (3 helper merge tests plus the delivers-both-keys integration test), 56 pass; removing the alias guard fails 7 (the 6 alias unit tests plus the alias integration test, now guard-sensitive at the seam), 53 pass; reverting the `executeRun` call site to the plain spread fails exactly the 2 executeRun-composition heartbeat tests with all 53 helper tests green; replacing the call site with a per-key/null-preserving but unguarded merge fails exactly the alias integration test (1 failed / 59 passed) with all 53 helper tests green. Helper-only command on the first file (53 tests): flattening fails 3 (50 pass); guard removal fails 6 (47 pass). Fixture mutants on the lifecycle tests: teardown without disposal marking fails the 2 late-completion tests; coupled home-then-DB disposal fails the removal-failure test. I restored each mutant byte-identical and the suites re-run green.
- `pnpm --filter @paperclipai/server exec vitest run` on the five existing heartbeat suites (`heartbeat-project-env`, `heartbeat-native-runner-selection`, `heartbeat-retry-scheduling`, `heartbeat-dependency-scheduling`, `heartbeat-run-status-payload`) — 139 tests pass on these exact bytes (same local provisioning redirect as above); combined with the two files above, 199/199 across 7 files.
- `pnpm --filter @paperclipai/server exec tsc --noEmit` — no errors in the touched files. Pre-existing errors remain in untouched files (missing `paperclip-runner` dist whose binary build needs `cargo`, plus implicit-`any` diagnostics). The full `paperclip-runner` package build stops at `build:binary` on missing `cargo` in this container.
- Clean-room check: fresh checkout of `master` at 994d6edc plus `git am` of the exact tracked mail patch applies with no conflicts and byte-identical postimages; `git diff --check` is clean.

## Risks

- Low risk. A task override that sets no `env` behaves as before.
- An override with `env: {}` used to remove all agent environment keys. It now keeps them. An override cannot remove a key by leaving it out.
- An override with `env: null`, or an `env` that is not an object, still removes all agent environment keys, as before. This is now a tested contract rather than an accident of the spread.
- An override env key that shares a case-insensitive name with an agent env key (for example `api_token` over `API_TOKEN`) now fails the run with an explicit message instead of merging both spellings. Use the exact agent key spelling to replace it. When the agent env already carries several spellings of one name, every override of that name fails, since no single spelling can replace them all; remove the inherited aliases instead. This rejection runs on every target, so a conflicting override also fails on Linux even though the process variables would be distinct there. Exact matches over a single-spelled base and non-conflicting keys behave as before on every target.
- Agent secret references now reach runs that use an `env` override. They are the same references the agent config already grants to that agent's runs.
- This change adds no migration and no new setting.

## Model Used

- Meta Muse Spark, version 1.3, wrote the original change. Reasoning effort was set to extra high (xhigh). The model has a 1M-token context, and the agent harness ran it with a 204k-token window. It worked in a coding agent with tool use, shell access and test execution.
- Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`, 200k-token context, extended thinking) ported the change to current `master` and verified it. It used the same kind of coding agent with tool use, shell access and test execution.
- The follow-up repair on top of the ported change (null-clearing contract, alias rejection with the completed multi-spelling guard, `executeRun` regressions, fixture hardening) was written and verified by the project coding agent running under the harness-assigned model label `muse-canary(xhigh)` at extra-high reasoning effort, with tool use, shell access and test execution. That label is a routing alias, not a vendor/version identifier, so no vendor claim is made for this line.
- The revision-3 repair on top of that (genuine `git format-patch` transport artifact verified with `git am` on the exact tracked bytes; alias integration test switched to valid plain bindings with the alias-conflict cause asserted on the run record; both call-site mutants proven killed) was written and verified by the project coding agent running under the same harness-assigned model label `muse-canary(xhigh)` at extra-high reasoning effort, with tool use, shell access and test execution on the isolated PostgreSQL test service. That label is likewise a routing alias, not a vendor/version identifier, so no vendor claim is made for this line either.
- The revision-4 repair on top of that (lifecycle-safe fixture setup/teardown with fault-injection tests; public-packet scrub with unchanged test scope) was written and verified by the project coding agent running under the same harness-assigned model label `muse-canary(xhigh)` at extra-high reasoning effort, with tool use, shell access and test execution on the isolated PostgreSQL test service. That label is likewise a routing alias, not a vendor/version identifier, so no vendor claim is made for this line either.

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
