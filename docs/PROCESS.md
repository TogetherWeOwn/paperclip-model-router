# Repository conventions

This repository was created under the PaperclipAI process. It has no inherited
agent harness, so it is clean by construction rather than cleaned up later.

## What lives where

**Paperclip is the tracker.** There are no plan files, checkpoint logs, progress
trackers or review write-ups in this repository. Work is tracked as Paperclip
issues; this repository holds the artifact, not the workflow.

**Recorded decisions outrank prose about them.** Architecture and decision
records live in [`docs/decisions/`](decisions/), numbered and immutable once
merged. A decision that changes gets a new record that supersedes the old one;
the old record stays. This adopts the existing `docs/decisions/` convention
already in use in the TogetherWeOwn estate rather than inventing a third format.

**Operational knowledge lives in [`docs/OPERATIONS.md`](OPERATIONS.md).** Install,
configure, verify, roll back, and the blast-radius rules.

## Not in this repository, ever

- Agent instructions and harness tooling — `CLAUDE.md`, `AGENTS.md`, `.claude/`,
  `.cursor/`, `.codex/`, `.mcp.json`, hooks, loop runners, harness settings. The
  PaperclipAI process replaces all of it. `.gitignore` excludes `.claude/` so an
  agent working here cannot commit one by accident.
- Any credential, in any form. See [`docs/decisions/0004`](decisions/0004-secret-references-not-secrets.md).
  CI runs gitleaks on every push and the config schema itself rejects a pasted key.

## Change rules

1. **Every change lands through a pull request**, and CI must be green. CI runs
   `npm run verify` — typecheck, tests, build — plus a built-manifest load, a
   version/changelog sync check, and a secret scan.

   **This rule is currently a convention, not a control.** `main` has no branch
   protection, so nothing technically stops anyone merging their own PR past a
   red build. The ruleset that would enforce it is decided and checked in —
   [`docs/decisions/0007`](decisions/0007-ci-must-pass-is-a-rule-not-a-convention.md)
   and [`docs/branch-ruleset.main.json`](branch-ruleset.main.json) — but it
   cannot be applied while the org is on the GitHub `free` plan with private
   repos. Until then, escalate merges rather than taking them.
2. **Behaviour changes come with a test.** The tests are the specification of
   the routing rules; `tests/two-company.spec.ts` in particular is the
   acceptance criterion for this plugin and must keep passing.
3. **Anything company-specific goes in the config schema, not in code.** If a
   change requires a code edit to onboard a company, that is a defect. There is
   no `companyId` parameter in the engine, by construction, and a test asserts it.
4. **Update `CHANGELOG.md` in the same PR.** CI refuses to tag a release whose
   version has no changelog entry and no matching `PLUGIN_VERSION`.
5. **Architectural choices get a decision record**, added in the same PR that
   implements them.

## Release

```bash
# on a green main
npm version minor          # updates package.json
# update src/constants.ts PLUGIN_VERSION and CHANGELOG.md to match
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which re-verifies, refuses to
proceed if the tag does not match `package.json`, and attaches the packed tarball
to the GitHub release. That tarball is what an operator installs and what a
company is pinned to.
