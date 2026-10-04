# Upstream proposal package: per-key override env merge and run model decision hook

Draft only. Nothing here is filed. A person with the right access files each pull request after review.

Target: `paperclipai/paperclip`, base `master` at `994d6edc` (2026-10-04).

| File | Content |
|---|---|
| `pr1-per-key-env-merge.patch` | PR 1: one commit (`9231ea0`), 4 files, +881 −2. Genuine `git format-patch` mail patch. Applies to `master`. |
| `pr1-body.md` | PR 1 title, branch name and body, in the upstream template. |
| `pr2-run-model-decision-hook.patch` | PR 2: one commit, 25 files. Apply PR 1 first. |
| `pr2-body.md` | PR 2 title, branch name and body, in the upstream template. |
| `SHA256SUMS` | Checksums of both patches. |

## Apply

```sh
git clone https://github.com/paperclipai/paperclip.git && cd paperclip
git checkout -b fix/merge-issue-override-env-per-key 994d6edc
git am /path/to/pr1-per-key-env-merge.patch
git checkout -b feat/run-model-decision-hook
git am /path/to/pr2-run-model-decision-hook.patch
```

Both patches apply with `git am` on `994d6edc` without conflicts. Both author as `Upstream Draft <draft@example.invalid>`. Re-author the commits as the person who files them (`git commit --amend --reset-author`).

## Verified on `994d6edc` + patches

- `tsc --noEmit` for `server`: no errors in the touched files. `shared` and `plugin-sdk` build. Pre-existing errors remain in untouched files (missing `paperclip-runner` dist whose binary build needs `cargo`, plus implicit-`any` diagnostics); the full `paperclip-runner` build stops at `build:binary` on missing `cargo` in containers.
- PR 1: `execution-workspace-policy.test.ts` 53 tests pass (44 existing + 9 new: null clearing, non-object preservation, singleton alias rejection, exact-match shadowing, alias-before-resolution, multi-spelling base in either input order, exact override over another spelling, unavailable-reference rejection, Windows-fold regression). New `heartbeat-issue-override-env-merge.test.ts` 7 tests pass: 4 through real `executeRun` on the isolated PostgreSQL test service (merge delivers both keys; explicit null clears through runtime resolution; multi-spelling alias group with valid plain bindings fails the run before the adapter executes with the alias-conflict cause asserted on the run record; fixture setup-failure cleanup restores only written keys) plus 3 always-run fixture-lifecycle fault-injection tests (late database/home cleanup without publishing state; database cleanup despite home-removal failure). Combined with the 5 existing heartbeat suites (139 tests, same run): 199/199 across 7 files.
- PR 1 mutation checks on the two-file suite (60 tests): flattened merge fails 4 (56 pass; helper-only scope: 3 failed / 50 passed); alias-guard removal fails 7 (53 pass; helper-only scope: 6 failed / 47 passed); plain-spread call-site revert fails exactly the 2 executeRun-composition tests with all 53 helper tests green; unguarded per-key call-site mutant fails exactly the alias integration test (1 failed / 59 passed) with all 53 helper tests green; teardown without disposal marking fails the 2 fixture late-completion tests; coupled home-then-DB disposal fails the fixture removal-failure test. Each mutant was restored and verified byte-identical afterwards. Clean-room `git am` of the exact tracked mail patch on `994d6edc` verified with byte-identical postimages.
- PR 2: `run-model-decision.test.ts` 20 tests pass. 15 related suites pass (276 tests). 5 existing heartbeat suites pass (139 tests).
- No internal ticket IDs, host names or agent names in the patches or the bodies.

## Open points before filing

- PR 1 Model Used is filled (Muse Spark 1.3 original, Sonnet 5.5 port, harness-labelled repair credit). PR 2: replace the `AUTHOR-MODEL-LINE` marker in its body with the models that wrote the original change.
- PR 2: raise it in Discord `#dev` first. PR 2 touches the same area of `heartbeat.ts` and the plugin SDK as open PR #14967 (account routing per task).
- PR 2: the `executeRun` call site has no database integration test. The body says so in Risks.
- After a rebase, run the commands in each body again and update the numbers.
