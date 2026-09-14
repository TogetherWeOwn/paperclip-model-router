# 0011 — CI jobs merge because GitHub bills per job, not per second

Status: accepted. Applied directly to `.github/workflows/ci.yml` via the
`docs/operator/tog-2547-ci-job-merge.patch` handoff described in
[`docs/decisions/0008`](0008-workflow-files-are-operator-applied.md) — no agent
can push this file, so this record's change is inert until an operator applies
that patch (`npm run check:workflows` stays red until then, same as any other
queued workflow change).

Date: 2026-09-14. Partially supersedes
[`0007`](0007-ci-must-pass-is-a-rule-not-a-convention.md): the ruleset's required
check-name *list* changes; nothing about the decision to require CI changes.

## Context

`ci.yml` ran four jobs on every push and pull request:

| job | avg duration (20-run sample, 2026-09-05 to 2026-09-13) |
|---|---|
| `typecheck, test, build` | 27.2s |
| `the packed tarball is installable` | 20.1s |
| `version and changelog` | 7.0s |
| `secret scan` | 8.3s |

Three of the four — everything except `secret scan`, which needs its own
`fetch-depth: 0` full-history checkout — ran on the same `ubuntu-latest` runner
type, checked out the same commit, and (for the first two) ran `npm ci`
independently. `the packed tarball is installable` additionally re-ran
`npm run build` from scratch rather than reusing the build `typecheck, test,
build` had already produced one job over.

**GitHub Actions bills per job, rounded up to the nearest whole minute** (GitHub
billing docs, "minute multipliers": *"GitHub rounds the minutes and partial
minutes each job uses up to the nearest whole minute"*). Every one of the four
jobs above finishes in under 30 seconds, so every one of them was already being
billed a full minute it did not use — shaving seconds off any single job's
runtime buys nothing, because the ceiling was never the bottleneck. The only
lever that reduces billed minutes here is reducing the number of billable jobs.

Four jobs per CI run × jobs on both `push` and `pull_request` (a PR branch push
triggers both events, and this repo's history is exclusively feature-branch-then-
squash-merge — every commit in `git log --oneline origin/main` corresponds to a
merged PR) means each change was billing on the order of 8 job-minutes before a
human ever looked at it. None of the three merged jobs do enough real work to
justify a rounded-up minute of their own.

## Decision

**Merge `typecheck, test, build`, `the packed tarball is installable`, and
`version and changelog` into one job**, renamed `typecheck, test, build,
package, version`. Order is preserved as fast-fail-first: typecheck → test →
build → entrypoint assertion → `verify:host` → changelog/version-sync check →
pack-unpack-install-load. A typecheck failure now fails in ~10s instead of
paying for a full job's rounded-up minute before failing on unrelated ground.

**`secret-scan` stays its own job.** It is the one job that needs
`fetch-depth: 0` (full git history, not just the working tree) — merging it
into `verify` would force every other check in that job to pay for a full clone
instead of a shallow one, which is a real cost, not a rounding artifact, on a
repository whose history is genuinely large. Keeping it separate also means a
finding here is visually distinct from a typecheck/build/pack failure, which
mattered enough to earn its own paragraph in
[`docs/decisions/0008`](0008-workflow-files-are-operator-applied.md) (the
TOG-488 "failed download looks identical to a leaked secret" story) — collapsing
it into the same job would make that exact confusion easier, not harder.

**No check was removed.** Every `run:` step that existed before this change
still runs, in the same order relative to its own prerequisites, on every push
and pull request. This is a job-topology change, not a coverage change.

**Nothing about triggers, `concurrency`, or `permissions` changes.** The
`push: branches: ["main"]` / `pull_request` / `workflow_dispatch` trigger set
was already minimal — no job here runs on a schedule or on every branch, and
`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` already
cancels a superseded run on the same ref, so rapid pushes to one PR do not stack
runs. There was no waste to find on that axis; the finding is entirely in job
count.

**`release.yml` is untouched.** It runs once per tag, not once per push, so its
per-job billing is not a repeated cost the way `ci.yml`'s is, and its single
`release` job already does everything in sequence.

## Consequences

**Estimated saving: roughly 2 billed minutes per CI run, from 4 to 2** (the
merged `verify` job's combined runtime — 27.2 + 20.1 + 7.0s of real work, minus
the ~10-15s of redundant checkout/setup-node/npm-ci/build the second and third
jobs no longer pay for — is ~50-60s, which still rounds up to 1 billed minute;
`secret-scan` is unchanged at 1 billed minute). Over this repository's actual
history — 66 commits to `main` since 2026-08-23, each corresponding to a CI run
on both the feature branch and the resulting `pull_request` event — that is on
the order of a few hundred minutes saved to date, and continues at whatever rate
future PRs land. This is a reasoned estimate from removed job count, not a
measurement of GitHub's private billing ledger, which no agent here has access
to; the runtime numbers above are the real check-run timestamps for the current
jobs, read via `commits/{sha}/check-runs` (`repos/actions/jobs/{id}` and
`repos/actions/runs` both 403 for this App's token — "Resource not accessible by
integration" — so the per-*step* breakdown a workflow run page shows was not
available to verify this record; the per-*job* start/end timestamps from
check-runs were, and are what the table above uses).

`docs/branch-ruleset.main.json`'s `required_status_checks` list changes from
four contexts to two: `typecheck, test, build, package, version` and
`secret scan`. That file has never been applied (0007's ruleset is still
blocked on the GitHub plan upgrade), so this is a same-PR correction to an
inert artifact, not a live re-gate.

The tradeoff being accepted: a failure in the merged job is less immediately
legible about *which* of typecheck/test/build/package/version-sync failed than
four separately-named red checks were. Each step still has its own `name:` and
the job log still shows exactly which step failed — the cost is one extra click
into the job to see the step name, not lost information.
