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
6. **You cannot push `.github/workflows/`. Nobody here can.** Read this before
   you edit a workflow, not after the push is rejected — it has already cost two
   pieces of finished work.

   The App the agents authenticate as has no `workflows` permission, and the
   token broker refuses to mint it (`403: Permission "workflows" is not in this
   project's profile`). `GH_APP_SCOPE_STRICT=1` and broker-derived scope can only
   be narrowed, so there is no way to widen it from a run and no fallback to try.
   It is deliberate — [`docs/decisions/0008`](decisions/0008-workflow-files-are-operator-applied.md)
   — and it is not going to be lifted for your change.

   So hand it over instead. Generate the patch against the current tree, check it
   in under `docs/operator/`, and describe it in the PR like any other change:

   ```bash
   git diff -- .github/workflows/ci.yml > docs/operator/tog-NNN-what-it-does.patch
   git checkout -- .github/workflows/ci.yml   # you cannot push this file
   npm run check:workflows                    # red while it is pending, by design
   ```

   `npm run check:workflows` is the gate: it fails if a queued patch no longer
   applies, if a pinned scanner digest has drifted from the publisher, or if a
   script is wired up *only* inside a patch nobody has applied. That last one is
   how `scripts/gitleaks-selftest.sh` spent its first day asserting nothing while
   the `secret scan` job reported green. **Verify the patch by applying it
   locally and running the thing it changes** — the operator gets one attempt and
   cannot debug it.

   [`docs/OPERATIONS.md`](OPERATIONS.md) → "Applying an operator-only change" is
   the other half, written for whoever applies it.

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

One step CI cannot do for you, so do it before tagging — from a machine with a
Paperclip checkout:

```bash
PAPERCLIP_HOST=/app npm run verify:host
```

Install steps 5, 5b and 6 (capabilities-vs-features, page-route collision,
minimum host version) run mirrored copies of the host's tables when no checkout
is reachable, which is every CI runner. This run replaces those with the host's
compiled `server/dist` and re-derives each mirrored entry against the real one,
failing on any disagreement. Skipping it does not make a release unsafe; it
makes the `[MIRROR]` lines in CI unverified for as long as you skip it, which is
how a copied table quietly stops describing the host it was copied from
(TOG-232).

**This run is strict, and it leaves a receipt.** Because `PAPERCLIP_HOST` is
set, every check is expected to execute: one that cannot resolve what it needs
is a `FAIL`, not a `SKIP`. Until TOG-1070 the opposite was true — the stock-host
probes printed `SKIP` and exited 0, so `npm run verify` reported success with
this gate never having run, and **v0.4.1 and v0.4.2 were both tagged that way**.
A gate that can pass by absence is indistinguishable from one that passed.

A clean run writes `.verify-host-receipt.json` (git-ignored) naming the commit
and the number of checks that actually executed. `npm run check:pin` gate 8
reads it and refuses a pin whose commit was never host-verified, so the evidence
travels from the machine that can produce it to the check that needs it. CI
cannot re-run these probes — a runner has no checkout — which is exactly why the
receipt exists rather than a re-check.

If the host checkout is knowingly half-built and you need to proceed anyway,
`ALLOW_HOST_PROBE_SKIP=1` restores the old permissive behaviour. It is recorded
in the receipt, and gate 8 refuses to quote a run that used it.

## Handing a version to an operator

Everything above proves the *working tree* is good. It says nothing about the
thing an operator installs: a published release asset, named by a tag, quoted in
a runbook or approval card written some hours earlier. Run this before you write
that version into any operator-facing text, and again before you re-cut a card
that names it:

```bash
npm run check:pin -- --tag v0.2.5 --expect-sha256 <the sha in the card> --for-card
```

Seven gates: the tag resolves; `package.json` and `CHANGELOG.md` **at the tag**
agree with it; a published, non-draft release exists with exactly one `.tgz`;
the asset downloads and matches the sha you pinned; the asset's `dist/*.js` are
**byte-identical to a fresh build of the working tree**; and `git diff
<tag>..HEAD -- src` is empty.

The last two are the point. Gate 6 is what makes "I ran the tests on `main`" and
"the operator installs the tarball" the same sentence rather than two hopes.
Gate 7 is allowed to fail, and when it does the answer is to **cut a new tag**,
not to reword the runbook.

`--for-card` prints a block to paste into the card, and refuses to print it if
any gate failed *or skipped* — a card is a claim to someone who cannot check it,
so it may only quote a complete run. `--offline` is refused alongside it.

This is not part of `npm run verify` on purpose: at commit time the release for
the version under development does not exist yet, so folding it in would either
fail every build or teach everyone to ignore it. It is a release-and-handoff
gate, run deliberately.

Three shipped mistakes it would have caught, all of them cards that reached the
owner's queue: `v0.1.1` (a tag with no published tarball behind it), `v0.2.3`
(a card naming a version the runbook had already marked unsafe), and `v0.2.4`
(four `src/` files changed after the tag, so the pinned artifact no longer
matched the code being tested).
