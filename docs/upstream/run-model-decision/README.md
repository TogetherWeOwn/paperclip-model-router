# Upstream proposal package: per-key override env merge and run model decision hook

Draft only. Nothing here is filed. A person with the right access files each pull request after review.

Target: `paperclipai/paperclip`, base `master` at `d9b64ee28` (2026-10-02).

| File | Content |
|---|---|
| `pr1-per-key-env-merge.patch` | PR 1: one commit, 3 files, +71 −2. Applies to `master`. |
| `pr1-body.md` | PR 1 title, branch name and body, in the upstream template. |
| `pr2-run-model-decision-hook.patch` | PR 2: one commit, 25 files. Apply PR 1 first. |
| `pr2-body.md` | PR 2 title, branch name and body, in the upstream template. |
| `SHA256SUMS` | Checksums of both patches. |

## Apply

```sh
git clone https://github.com/paperclipai/paperclip.git && cd paperclip
git checkout -b fix/merge-issue-override-env-per-key d9b64ee28
git am /path/to/pr1-per-key-env-merge.patch
git checkout -b feat/run-model-decision-hook
git am /path/to/pr2-run-model-decision-hook.patch
```

Both patches apply with `git am` on `d9b64ee28` without conflicts. Both author as `Upstream Draft <draft@example.invalid>`. Re-author the commits as the person who files them (`git commit --amend --reset-author`).

## Verified on `d9b64ee28` + patches

- `tsc --noEmit` for `server`: no errors. `shared` and `plugin-sdk` build.
- PR 1: `execution-workspace-policy.test.ts` 44 tests pass. A shallow-merge mutant fails 2 tests.
- PR 2: `run-model-decision.test.ts` 20 tests pass. 15 related suites pass (276 tests). 5 existing heartbeat suites pass (139 tests).
- No internal ticket IDs, host names or agent names in the patches or the bodies.

## Open points before filing

- PR 1 and PR 2: replace the `AUTHOR-MODEL-LINE` marker in each body with the models that wrote the original change.
- PR 2: raise it in Discord `#dev` first. PR 2 touches the same area of `heartbeat.ts` and the plugin SDK as open PR #14967 (account routing per task).
- PR 2: the `executeRun` call site has no database integration test. The body says so in Risks.
- After a rebase, run the commands in each body again and update the numbers.
