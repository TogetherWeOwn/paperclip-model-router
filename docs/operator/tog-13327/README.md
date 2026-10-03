# TOG-13327 handoff: fix/cleanup-exit-143-success push bundle

Card: TOG-13327 (`fix(1001): successful runs marked adapter_failed (exit 143)
after terminal_result_cleanup`). Parent: TOG-13236.

## Ready ref (verified 2026-10-03 ~14:40Z)

- Repo: `https://github.com/TogetherWeOwn/paperclip.git` (public)
- Branch to create: `fix/cleanup-exit-143-success`
- Base: `e60553d3851528d0a14dfc1a6adff5c639721f51`
  `fix(plugins): port H1-H9 host wiring onto 1001 line (#33)`
- Patch commit message: `fix(heartbeat): keep cleanup SIGTERM from failing successful runs`
- Patch applies cleanly to pristine base (`git apply --check`: clean,
  4 files, +241/-2).

## Why this bundle exists

Push from this run's token fails (dry-run probe 2026-10-03, exact error):

```text
remote: Permission to TogetherWeOwn/paperclip.git denied to togetherweown[bot].
fatal: unable to access 'https://github.com/TogetherWeOwn/paperclip.git/': The requested URL returned error: 403
```

This run is scoped to the Model Router Plugin project
(`paperclip-model-router`); its token cannot write `TogetherWeOwn/paperclip`.
No credential substitution attempted (owner rule 2026-09-29).

## Files

- `fix-cleanup-exit-143-success.mbox`: format-patch (1 commit) for the base above.
- `PR_BODY.md`: PR body following `.github/PULL_REQUEST_TEMPLATE.md`
  (7 sections, public-safe: no internal ticket ids or private URLs).

## Operator apply (exact)

```sh
git clone https://github.com/TogetherWeOwn/paperclip.git paperclip-pr
cd paperclip-pr
git checkout -b fix/cleanup-exit-143-success e60553d3851528d0a14dfc1a6adff5c639721f51
git am /path/to/fix-cleanup-exit-143-success.mbox
git push origin fix/cleanup-exit-143-success
gh pr create --title "fix(heartbeat): keep cleanup SIGTERM from failing successful runs" \
  --body-file /path/to/PR_BODY.md --base main --head fix/cleanup-exit-143-success
```

Rollback: `git am --abort` (before push) or close the PR unmerged.

## After the PR exists

- Needs one independent Code Reviewer pass on the exact head SHA, then the
  approving reviewer squash-merges (review economy: no separate merge card).
- If CI is red on `check`/`gitleaks`/`pr-lint` from the first push, see the
  card: a red secret scan on a rebased branch usually needs the introducing
  commit rewritten, not a working-tree fix.
- No deploy, restart, or image build from this card. The operator folds the
  merged PR into the next image with H1-H9 and the PR28/PR29 carry.

## What was verified (and what was not)

- New predicate unit tests: 9/9 pass.
- Process fixture (terminal result, then child exits 143 on cleanup SIGTERM):
  passes with the 3 existing cleanup tests (4/4 in the `-t "clean"` filter).
- `tsc --noEmit` in `packages/adapter-utils`: clean.
- `tsc --noEmit -p server/tsconfig.json` with only these hunks applied: exit 0.
- Full server `pnpm run typecheck` could not finish here: its
  `prepare:runner-vendor` chain needs `cargo`, which this container lacks
  (fails building `paperclip-runnerd`, before `tsc` runs). Environment limit,
  not a code signal. CI on the PR is the real gate.
- Agent tokens cannot read Actions check runs (403 by scope), so CI status
  must come from the normal review path, not from the author run.
