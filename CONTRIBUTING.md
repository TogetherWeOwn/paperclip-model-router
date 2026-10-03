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
required checks (`ci.yml`, CodeQL, secret scan). Verify locally first:

```sh
npm run typecheck
npm test
npm run build
npm run verify:host
npm run rehearse
```
