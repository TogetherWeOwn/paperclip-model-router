# TOG-13304 handoff: amend lockfile gate to admit regenerable hunks

Parent: [TOG-13236](/TOG/issues/TOG-13236) (option b, non-blocking).
Context: [TOG-13295](/TOG/issues/TOG-13295) (lockfile fix), [TOG-13303](/TOG/issues/TOG-13303) (option c immediate path).

## Problem (verified)

`Block manual lockfile edits` in `pr-trusted.yml` fails ANY PR whose diff
touches `pnpm-lock.yaml` (except `chore/refresh-lockfile`/dependabot). A PR
that adds a dependency MUST commit a lockfile hunk
(`pnpm install --frozen-lockfile` fails without it), and the master-side
refresh flow cannot supply an entry for a dep that exists only on the branch.
Consequence: no dependency-adding PR can go green — systemic, not just PR #33.

## Ready ref (verified 2026-10-03)

- Repo: `https://github.com/TogetherWeOwn/paperclip.git`
- Base commit: `e60553d3851528d0a14dfc1a6adff5c639721f51` (master tip, PR #33 merged)
- Patch: `pr-trusted-lockfile-gate.patch` (4 files, +81/-10; verified `git apply --check` clean on a fresh clone @ e60553d
  plus 381/381 tests green after apply)
- pnpm: 9.15.4 (repo-pinned). Note: master `pnpm-lock.yaml` header is
  `lockfileVersion: '9.0'`, so `--frozen-lockfile` fails on the version header
  even when content is current; resolution-only (`--no-frozen-lockfile`) is
  content-fresh (no-op on master). The gate therefore uses
  `--resolution-only --ignore-scripts --no-frozen-lockfile` for the regen check.

## What the patch does

1. `pr-trusted.yml`: renames the step to `Block unregenerable lockfile edits`.
   Lockfile hunk + a `package.json` change in the same PR → check out the base
   lockfile, re-resolve with the PR's manifests, require byte-identity
   (`cmp -s`) with the PR's lockfile. Match → pass; mismatch → fail with
   "commit the regenerated lockfile" guidance (PR tree restored before exit).
   Lockfile hunk with NO manifest → fail fast as before.
2. `check-pr-lockfile.mjs` (comment gate): admits lockfile+manifest shape
   cheaply, keeps failing lockfile-only hunks, refresh-bot pass unchanged.
3. Tests: 3 new `check-pr-lockfile` cases + 1 workflow-shape test asserting the
   old blanket ban is gone and the regen gate exists.

## Verification (all run 2026-10-03, pnpm 9.15.4, paperclip @ e60553d)

- `.github/scripts/tests/*.test.mjs`: 381/381 pass (includes 4 new tests).
- Gate script `bash -n`: OK.
- 4-way live simulation against the real resolver (synthetic `is-odd@^3.0.1`
  dep-add into `cli/package.json`):
  - dep-add + regen lock → `GATE-PASS(regenerable)` (exit 0)
  - gratuitous lock-only hand-edit → `GATE-FAIL(no-manifest)` (exit 1)
  - manifest + corrupt lock → `GATE-FAIL(unregenerable)` (exit 1)
  - no lock change → `GATE-PASS(no-lock-hunk)` (exit 0)
- Regen-identity proof: base lock + PR manifests re-resolved is byte-identical
  to the PR's committed lockfile (`diff` empty); a hand-edited version string
  is NOT reproduced by the resolver (regen output lacks it).

## Why a queued operator bundle (no direct push)

Agents cannot push workflow files (`workflows` not in broker profile; standing
policy: queue patch under `docs/operator/`). The pusher applies this patch
from a scope that may touch `.github/workflows`.

## Push recipe (from a paperclip-scoped run)

```sh
git clone https://github.com/TogetherWeOwn/paperclip.git paperclip-push
cd paperclip-push
git checkout e60553d3851528d0a14dfc1a6adff5c639721f51
git apply /path/to/pr-trusted-lockfile-gate.patch
node --test '.github/scripts/tests/*.test.mjs'   # expect 381/381 pass
git checkout -b chore/allow-regenerable-lockfile-hunks
git add .github/workflows/pr-trusted.yml .github/scripts/check-pr-lockfile.mjs \
  .github/scripts/tests/check-pr-lockfile.test.mjs \
  .github/scripts/tests/lockfile-refresh-workflows.test.mjs
git commit -m "ci(policy): admit regenerable lockfile hunks with manifest changes"
git push origin HEAD:refs/heads/chore/allow-regenerable-lockfile-hunks
# then open a PR against master; do NOT push to master directly.
```

If origin/master moved past `e60553d`, STOP and re-verify (rebase + rerun the
4-way sim) — do not force-push.

## Files

- `pr-trusted-lockfile-gate.patch` — unified diff of the 4 files above.
- This README — handoff for the pusher.
