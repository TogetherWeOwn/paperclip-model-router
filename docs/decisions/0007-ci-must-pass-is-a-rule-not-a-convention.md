# 0007 — "CI must pass" is a rule, not a convention

Status: accepted — **not yet in force**. The configuration below is decided and
checked in; applying it is blocked on a GitHub plan upgrade and needs an operator.
Date: 2026-08-23
Supersedes nothing. Makes enforceable the first change rule in
[`docs/PROCESS.md`](../PROCESS.md).

## Context

Every change to this repository is supposed to land through a pull request with
green CI. That is written down, and so far it has held. It has held because the
agents working here chose to escalate merges rather than take them — the author
of PR #1 could have merged their own work, and nothing stopped the CTO merging
PRs #4 and #5 either.

A control that depends on good judgement is not a control. It works until the one
time it does not, and by then the thing it was protecting is already on `main`.
This repository ships a plugin that routes model spend inside customer instances;
the four CI jobs are the only automated thing standing between a bad change and a
tarball an operator installs.

Two facts constrain what can be done about it, both verified against the live API
on 2026-08-23:

**The org is on the GitHub `free` plan and this repo is private.** Branch
protection and rulesets are not offered in that combination — the endpoints
return `403 Upgrade to GitHub Pro or make this repository public` before scope is
ever consulted. The rules are refused, not stored-and-ignored. The same 403 holds
on `routeware-shadow-api`, `nntune` and `kofra`, so it is one root cause across
the org rather than a problem with this repository.

**An agent run cannot apply a ruleset even after the plan is upgraded.** The App
*installation* carries `administration: write`, but what a run *mints* is
least-privilege — `contents`, `issues`, `metadata`, `pull_requests` — and
admin-scoped endpoints return `403 Resource not accessible by integration`. The
two 403s are textually distinct, and that is the whole test for telling a plan
limit from a scope limit.

That second constraint is not a limitation to route around. An agent that can
create this ruleset can delete it, so a gate installed by a credential every run
holds constrains nobody. Applying it from a principal the agents cannot mint is
what makes it a control.

## Decision

The ruleset is [`docs/branch-ruleset.main.json`](../branch-ruleset.main.json),
targeting the default branch. Four elements, each decided rather than defaulted.

**Require the four CI checks.** `typecheck, test, build`, `secret scan`, `the
packed tarball is installable`, and `version and changelog`. These context strings
are the job `name:` values in `ci.yml` and are whitespace- and comma-sensitive; a
required check whose name matches no real job is the classic way a gate silently
never runs. All four report on `pull_request`, so they are usable as merge gates.
`release` is deliberately not required — it fires only on `v*.*.*` tags, and
requiring it would deadlock every PR.

**Require a pull request, but require zero approving reviews.** Required status
checks alone do not force a change through a PR, and the concern here is merges to
`main`. Requiring approvals is the tempting addition and it is the wrong one: the
reviewer pool is agents that may or may not be awake, so a required-approval rule
is a deadlock with no human on call to break it. It would have blocked the PR #4
and #5 merges. A second pair of eyes on security-relevant changes is a question
about how issues get assigned, not a GitHub setting.

**No bypass actors.** `"bypass_actors": []`. The reasoning is not that bypasses
are bad in general — it is that on GitHub a ruleset bypass is the worse of the two
available escape hatches. A bypass actor merging past a red build produces a merge
that looks *identical* to one that passed: silent at the merge button, and only
reconstructable afterwards from the ruleset insights page. Disabling the ruleset
is loud by comparison — a deliberate act that leaves the repo visibly unprotected
until someone turns it back on. The org has one human seat, who is the owner and
can always flip enforcement, so the "an unbypassable rule is its own incident"
risk is already covered by the escape hatch that leaves a trace. A bypass list
buys nothing here and costs the audit trail.

**Block deletion and force-push of `main`.** Cheap, no workflow cost, and it
closes the hole where a force-push launders an unreviewed change past a check
gate.

`strict_required_status_checks_policy` is `false` on purpose. `true` would require
every branch to be current with `main` before merging, which on a repository at
this volume means an update-and-re-run loop per PR for little benefit. Revisit it
if concurrent PRs start landing semantic conflicts.

## Consequences

Until the plan question is decided, this record is the control's specification and
not the control. `main` remains gated by convention, and that gap is now stated in
`PROCESS.md` where the convention is written rather than left for a reader to
discover.

The artifact is checked in so the decision survives the agent workspace it was
drafted in, and so applying it after approval is a review-then-paste step rather
than a re-derivation. **An operator applies it**, with a token carrying
`administration: write`, or through *Settings → Rules → New ruleset*, which
expresses the same configuration:

```sh
curl -sS -X POST \
  -H "Authorization: token $TOK" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/TogetherWeOwn/paperclip-model-router/rulesets \
  -d @docs/branch-ruleset.main.json
```

Reading the ruleset back is not the acceptance test. **The acceptance test is a
throwaway PR that breaks one check on purpose** — confirm the merge button is
blocked, then close it. A rule that has never refused anything has not been
tested.

Break-glass is `enforcement: "disabled"` on the ruleset, land the fix, set it back
to `"active"`, and note it on the issue. Rollback is the same call, or `DELETE` on
the ruleset id to remove it entirely.

Timing is the one thing this record does not decide unilaterally: applying a merge
gate while the TOG-149 epic has an install run in flight risks blocking exactly
the work that epic is waiting on. Apply it once TOG-156 is accepted or TOG-149
closes. The plan upgrade itself is inert — it enables the capability without
changing any repository's behaviour — so it can be approved at any time.

Scope is this repository. The same argument applies to the other three org repos
and one upgrade would cover them, but `routeware-shadow-api` has zero Actions runs,
so a required-check rule there would gate on checks that never report. Protection
is meaningless where no checks exist; that is a different and worse problem and
belongs in its own issue.
