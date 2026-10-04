# Upstream proposal package: per-key override env merge and run model decision hook

Draft only. Nothing here is filed. A person with the right access files each pull request after review.

Target: `paperclipai/paperclip`, base `master` at `d9b64ee28` (2026-10-02).

| File | Content |
|---|---|
| `pr1-per-key-env-merge.patch` | PR 1: one commit, 4 files, +401 −2. Applies to `master`. |
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

- `tsc --noEmit` for `server`: no errors. `shared` and `plugin-sdk` build. (The full `paperclip-runner` build stops at `build:binary` on missing `cargo` in containers; its TypeScript build completes.)
- PR 1: `execution-workspace-policy.test.ts` 49 tests pass (44 existing + 5 new: null clearing, non-object preservation, alias rejection, exact-match shadowing, alias-before-resolution). New `heartbeat-issue-override-env-merge.test.ts` 2 tests pass through real `executeRun` (merge delivers both keys; explicit null clears through runtime resolution). Combined with the 5 existing heartbeat suites: 190/190 across 7 files.
- PR 1 mutation checks: shallow-helper mutant fails 7 tests; alias-guard removal fails 2; call-site revert to the plain spread fails the new heartbeat merge test while all 49 helper tests still pass. Clean-room `git am` on `d9b64ee28` verified.
- PR 2: `run-model-decision.test.ts` 20 tests pass. 15 related suites pass (276 tests). 5 existing heartbeat suites pass (139 tests).
- No internal ticket IDs, host names or agent names in the patches or the bodies.

## Open points before filing

- PR 1 Model Used is filled (Muse Spark 1.3 original, Sonnet 5.5 port). PR 2: replace the `AUTHOR-MODEL-LINE` marker in its body with the models that wrote the original change.
- Upstream `master` has moved to `994d6edc` since this package's base; `heartbeat.ts` changed there, so PR 1 needs a rebase and a re-run of its Verification at filing time (the other two PR 1 files are unchanged upstream).
- PR 2: raise it in Discord `#dev` first. PR 2 touches the same area of `heartbeat.ts` and the plugin SDK as open PR #14967 (account routing per task).
- PR 2: the `executeRun` call site has no database integration test. The body says so in Risks.
- After a rebase, run the commands in each body again and update the numbers.
