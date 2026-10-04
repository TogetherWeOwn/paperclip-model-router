# 0013 — CI runs only what the change affects

Status: accepted. In force now — `.github/workflows/ci.yml` implements it and
[`tests/ci-changes.spec.ts`](../../tests/ci-changes.spec.ts) pins it.
Date: 2026-10-04
Supersedes nothing. Amends [`0011`](0011-ci-jobs-merge-for-per-job-billing.md):
the merged `typecheck, test, build, package, version` job keeps its name and
steps, but is no longer a required check by itself.

## Context

Every pull request paid for the full `verify` job, including a PR that only
touched a decision record. The organisation standard is that CI runs only what
a change affects, with a full run on `main` and nightly so a regression that
slips past a PR is caught within hours.

## Decision

- A `changes` job diffs the PR against its merge base with native
  `git diff --name-only` (no third-party action) via
  [`scripts/ci-changes.mjs`](../../scripts/ci-changes.mjs) and outputs one
  boolean, `code`. This repo has one heavy job, so it has one area.
- `code` is `false` only when every changed file is on a short allow-list of
  documentation that nothing executes or reads: `CONTRIBUTING.md`, `AGENTS.md`,
  `docs/decisions/**`, `docs/security/**`. Everything else runs the full job:
  source, tests, scripts, migrations, packages, the dependency manifest and
  lockfile, build and TypeScript config, `.github/**`, the filter itself, and
  the docs that tests read (`README.md`, `CHANGELOG.md`, `docs/OPERATIONS.md`,
  `docs/PROCESS.md`, `docs/contracts/**`, `docs/operator/**`).
- Gating is job-level (`if: needs.changes.outputs.code == 'true'`). A
  workflow-level `on: pull_request: paths:` is forbidden here: a workflow that
  never starts never reports its checks, and a required check waits forever.
- `ci-ok` is the aggregate (`if: always()`, needs every job). It passes when
  `changes` and `secret scan` succeeded and `verify` either succeeded or was
  skipped because `changes` said `code=false`. A skip with `code=true` fails:
  it is a hole in the gate, not a docs-only PR.
- Safety net: a push to `main`, the nightly schedule and a manual dispatch
  always answer `code=true`. So does any error, an unresolvable merge base or an
  empty diff. The only route to `false` is a successful diff of allow-listed
  paths.
- Always run: `secret scan`, `pr-lint` and `ci-ok`.
- `npm run check:ci` requires `ci-ok` and `secret scan` by name. It cannot
  require the merged job: on a docs-only PR that job is skipped, and
  [`0012`](0012-a-check-name-is-not-a-verdict.md) rightly reads a skipped
  required check as unknown.

## Adding to the allow-list

A path moves onto the list only when nothing in `tests/`, `scripts/`, the
`package.json` `files` list or the pack step reads it. When a test starts
reading a listed doc, take it off the list in the same PR.

## Consequences

- A docs-only PR costs the `changes`, `secret scan` and `ci-ok` jobs instead of
  the full suite.
- `docs/branch-ruleset.main.json` now lists `ci-ok`, `secret scan` and `pr-lint`.
  Applying it to the live ruleset needs a repository admin; until then the live
  ruleset's required checks are whatever it already lists, and `ci-ok` still
  reports on every PR.
- Rollback: revert the PR. The `verify` job is unchanged apart from its `needs`
  and `if`.

<!-- probe: docs-only change, expect verify skipped and ci-ok green -->
