# Contributing

## Pull request standards

These follow the upstream paperclipai/paperclip contributor rules. The `pr-lint` check enforces them
(`.github/scripts/pr_standards.py`, tests beside it).

- **Title** is a Conventional Commits header, `type(scope): summary`, at most 100 characters, no trailing
  period. The squash commit on `main` takes the PR title.
- **Body** uses `.github/pull_request_template.md`. Fill in every section: Thinking Path, Linked Issues or
  Issue Description, What Changed, Verification, Risks, Model Used and the Checklist. A PR created through
  the API gets no template, so paste it in. `docs`, `chore`, `build`, `ci`, `style`, `test` and `revert`
  PRs need no linked issue and no duplicate-search tick.
- **Model Used** names the model and version that wrote or helped with the change, or says
  `None - human-authored`.
- **Search first.** Look for an open or recent PR that touches the same area, and link what you find.
- **No internal references.** A title, body, commit message or branch name carries no internal ticket id,
  instance link, localhost URL or private host. Link only public GitHub issues (`Fixes #123`). If an
  internal card held useful context, restate it in plain words.
- **Branch name** is `type/short-slug`, for example `fix/sudo-window`. Agent workspaces may be named after a
  card: push with `git push origin HEAD:refs/heads/fix/short-slug`.

## Merging and CI

This repo is squash-merge only: the squash commit on `main` takes the PR title, so the history on `main`
is one conventional commit per PR. `pr-lint` is green on the exact head before review, with the other
required checks (`ci-ok` from `ci.yml`, CodeQL, secret scan). `ci-ok` skips the heavy suite on a
docs-only change and runs everything otherwise (`docs/decisions/0013`). Verify locally first:

```sh
npm run typecheck
npm test
npm run build
npm run verify:host
npm run rehearse
```

Keep `build` before `verify:host`; the validator consumes the built artifact. If
an installed host adds a UI slot, derive its capability from the host's
`server/src/services/plugin-capability-validator.ts` before updating the mirror.
Pin rejection without the capability and acceptance with it in a behavior test.
Against a reachable host, a passing strict run must execute every required check
without skips; host-contract drift is a repair, not a reason to waive the gate.

## Scanner provenance

The CI-executed `scripts/gitleaks-selftest.sh` includes fail-closed controls for
one independently reviewed, immutable historical synthetic finding. The sole
commit-scoped `.gitleaksignore` row is not a path/rule/value allowance. New
matches remain forbidden; both normal scans and the scanner integrity pin are
unchanged. See [the provenance contract](docs/operator/historical-scanner-exception.md)
for the verified-binary command, redacted counts and unauthorized-match controls.
Do not broaden the row or rewrite history to obtain a passing scan.
