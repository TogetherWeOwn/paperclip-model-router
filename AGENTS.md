# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. What this repo is

`paperclip-model-router` is a stock Paperclip plugin that selects and invokes one audited model under hard capability, privacy and provider gates. A mistake here can route traffic to the wrong model or leak cost and privacy guarantees. This repo is public: never put internal ticket ids, instance links, localhost URLs or private hosts in any title, body, commit, comment or branch name. Read before you touch anything.

## 2. Read this first

1. `CONTRIBUTING.md` — the full contribution contract (pull request standards first).
2. `README.md` — what the router does and how it is operated.
3. `.github/pull_request_template.md` — the 7-section PR template you must fill in.

## 3. Contribution contract

- Work on a branch, open a pull request, never push to `main`. Squash merges only. PR titles are Conventional Commits headers (`type(scope): summary`, max 100 chars, no trailing period).
- Fill in **every** section of the PR template: Thinking Path, Linked Issues or Issue Description, What Changed, Verification, Risks, Model Used, Checklist. Use short, active sentences.
- References: this repo is **public**, so link only public GitHub issues (`Fixes #123`) or describe the problem in the PR. Name the branch after the change (`type/short-slug`, e.g. `fix/sudo-window`); if your workspace branch carries a card id, push with `git push origin HEAD:type/short-slug`.
- Disclose honestly: name the model used (provider plus exact model ID), or write "None - human-authored". Report the tests you actually ran and their results. Never claim a green run you did not see.
- Address every review finding, or explain why it does not apply. Give credit to contributors whose work you build on.
- Done means **merged**. Opening the PR is not delivery. Never leave an orphan PR open: merge it, or close it with a comment naming what replaced it.

## 4. Before you implement, and before you push

- Verify locally first: `npm run typecheck`, `npm test`, `npm run build` (full list in `CONTRIBUTING.md`).
- No secrets in this repo, ever. Never export tokens on `argv`; prefer the credential broker.

## 5. Definition of done

A change is done when all are true:

1. Behavior matches the card that asked for it.
2. Tests pass locally and CI is green on the exact head SHA that merges (`ci.yml`, `pr-lint.yml`, CodeQL, secret scan).
3. Review is complete and every finding is addressed or answered.
4. The PR is squash-merged and the card closes only after the merge.
5. Docs (`README.md`, `CONTRIBUTING.md`) reflect the change.
