# 0008 — Workflow files are operator-applied, and that boundary stays

Status: accepted. In force now — it is the behaviour of the token broker, not a
plan for one.
Date: 2026-08-25
Supersedes nothing. Adds the sixth change rule in
[`docs/PROCESS.md`](../PROCESS.md). Shares its shape with
[`0007`](0007-ci-must-pass-is-a-rule-not-a-convention.md): a control is only a
control when the agents it constrains cannot lift it.

## Context

No agent in this company can change a GitHub Actions workflow. This was found by
attempting it, not by reading a field, and it has now been confirmed twice from
two different runs.

GitHub refuses the push:

```
! [remote rejected] refusing to allow a GitHub App to create or update workflow
  `.github/workflows/ci.yml` without `workflows` permission
```

and the `gh-token-broker` plugin refuses to mint the permission that would fix
it:

```
$ GH_APP_PERMISSIONS="…,workflows=write,…" gh-app-token.js token
gh-app-token: broker refused (403: Permission "workflows" is not in this
project's profile (contents, pull_requests, issues, metadata, checks, statuses).)
GH_APP_TOKEN_SOURCE=broker, so there is no fallback.
```

`GH_APP_SCOPE_STRICT=1`, and broker-derived scope can only be narrowed, so this
is not a scope an agent can widen from a run. It is a field on the broker's
plugin config, and agents get 403 on plugin config.

The boundary was real but undocumented, so it was discovered by whoever happened
to need it — each time at the end of a piece of finished work, which is the most
expensive moment to find out. It has already stranded two changes:

- **TOG-227** wrote `scripts/gitleaks-selftest.sh`, a test for the secret
  scanner's own config. Wiring it into the `secret-scan` job was a workflow
  edit, so it never landed. The script's header said it was "run in the same CI
  job as the scan"; that was never true. It asserted nothing from the moment it
  shipped, and the verdict the `secret-scan` job published never once included
  it. Keep those two facts apart: the job's result is not uniformly green — it
  went red on `501c5b7` for the download reason below — but green or red, that
  result was only ever `gitleaks dir .` and `gitleaks git .`, never the
  config's own test.
- **TOG-488** hardened the gitleaks install after a failed *download* was
  rendered as a failed *secret scan* on `501c5b7` (PR #22) — a red check named
  `secret scan`, identical in appearance to a committed credential, whose only
  available response was "re-run and see". That is the one habit a secret
  scanner must never teach.

## Decision

**`workflows` does not go into the broker's permission profile.** The profile
stays `contents, pull_requests, issues, metadata, checks, statuses`.

Workflow write is close to arbitrary code execution with the repository's
secrets: a run that can edit `ci.yml` can add a step that exfiltrates every
secret the workflow can read, and can do it in the same commit that does
something else. Every agent in this company shares one App identity, so granting
it to the one run that needs it grants it to all of them, permanently. The
scarce thing being protected is not the file — it is the fact that the CI
definition is the one artifact in this repository that a compromised or merely
mistaken run cannot rewrite.

This is the same argument as `0007` and it points the same way. There, an agent
that could create the ruleset could delete it, so applying it from a principal
the agents cannot mint is what made it a control. Here, an agent that can edit
the workflow can edit the checks that judge it. Both hold only because the
capability is absent, not because the runs are well-behaved.

It is worth being explicit that this is a real cost, not a free win. The two
changes above are correct, tested, and wanted, and they are late because of this
rule. That is the trade being accepted: a rare, legible delay in exchange for a
CI definition that no run can rewrite. The alternative — widen the profile
"just for this" — buys a few hours once and spends the property permanently.

**So workflow changes are handed to an operator as a patch.** They live in
`docs/operator/*.patch`, generated against the current tree, reviewed in a PR
like anything else, and applied by a human with `workflows` scope. The patch is
checked in rather than pasted into an issue so that it is reviewable, testable,
and cannot rot unnoticed.

**And the handoff is checked by a script, not remembered.**
`npm run check:workflows` ([`scripts/check-workflows.mjs`](../../scripts/check-workflows.mjs))
holds three gates: every queued patch still applies; every pinned scanner digest
still matches the publisher's checksums; and every script in `scripts/` is
reachable from something that runs it. It is red while a patch is pending and
goes green when the operator applies it, so "did the handoff happen?" is a
command rather than a memory.

The third gate is the one that earns the script. TOG-227's defect was invisible
to every existing check — a test that runs nowhere and a test that passes look
identical from outside — and it is the failure this rule structurally invites,
because the rule guarantees a gap between writing CI wiring and it taking
effect. A boundary that creates a specific failure mode should ship with the
detector for it.

Deliberately not part of `npm run verify`: it is legitimately red for as long as
a patch is queued, and a check that is normally red teaches everyone to ignore
it. Like `check:pin`, it is a handoff gate, run at the handoff.

## Consequences

Changing CI is slower and needs a human. That is intended, and the queue is
visible: `ls docs/operator/*.patch` is the backlog, and `check:workflows` says
whether it has been worked off.

The failure mode this rule introduces is a patch that is written, reviewed,
merged, and never applied — the repository then describes a CI it does not have.
Gate 1 catches the patch rotting; gate 3 catches the specific case where the
unapplied wiring leaves a test asserting nothing. Neither catches an operator who
simply never runs the runbook. That residual risk is accepted, and it is why
`check:workflows` prints the pending count rather than passing quietly.

`docs/OPERATIONS.md` → "Applying an operator-only change" is the runbook. The
acceptance test there is deliberately not "read the file back": it is to run
`npm run check:workflows` and see it go green, and then to look at a real CI run.

Scope is this repository's profile. The same broker profile governs the other
repos in the org, and the argument generalizes, but each has its own project
config and none of them is changed by this record.

If this is ever revisited, the question to answer is not "is the patch safe?" —
it always is, that is why it was written — but "what stops the next run from
using this scope for something else?" There is currently no answer to that
short of a second reviewing principal, which the org does not have.
