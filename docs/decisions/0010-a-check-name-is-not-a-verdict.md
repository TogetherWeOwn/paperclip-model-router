# 0010 — A check name is not a verdict

Status: accepted. In force now — `npm run check:ci` implements it and
[`tests/ci-health.spec.ts`](../../tests/ci-health.spec.ts) pins it.
Date: 2026-08-25
Supersedes nothing. Amends how
[`0007`](0007-ci-must-pass-is-a-rule-not-a-convention.md) is evaluated: 0007
says CI must pass, and this record says what it takes to know whether it did.

## Context

On 2026-08-25, between 17:27 and 17:38, the TogetherWeOwn organisation crossed
its GitHub Actions spending limit. From that moment every job in every workflow
was refused. On `d29c2ab` all four checks failed two seconds after starting,
before checkout, each carrying the same annotation:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased. Please check the 'Billing & plans'
> section in your settings

The commit eleven minutes earlier, `fdd1b62`, was green on the same workflow and
the same runners in 23s / 6s / 21s / 8s. Nothing in the diff was responsible and
nothing in the diff could be.

What the pull request page showed was four red checks. What had actually
happened was that nothing ran. Those two states are rendered identically, and
one of the four was named `secret scan` — so a billing problem was presented to
engineers in the exact visual shape of a committed credential. Making a red
`secret scan` mean one unambiguous thing is precisely what TOG-488 was in the
middle of doing (PR #23, still open); this arrived from a direction that work
had not predicted.

Three distinct states, one colour:

| what happened | what the PR page shows |
|---|---|
| gitleaks ran, found a credential | red `secret scan` |
| gitleaks ran, the scanner download failed (TOG-488) | red `secret scan` |
| no job ever started; GitHub refused it | red `secret scan` |

## Decision

**A check's name and colour are not evidence about a commit. Whether the job ran
is a separate question and must be asked separately.**

`scripts/ci-health.mjs`, wired as `npm run check:ci`, asks it. It reports four
states rather than two, because two is the number that caused the problem:

| exit | state | meaning |
|---|---|---|
| `0` | GREEN | every required check ran and passed |
| `1` | RED | a check ran and genuinely failed — read it, fix the code |
| `2` | DID_NOT_RUN | a job was refused; the red checks verified nothing |
| `3` | UNKNOWN | unreadable, absent, skipped, or still in flight |

Three properties are load-bearing:

1. **`GET /commits/{sha}/check-runs` is read, and HTTP 200 is asserted.** The
   Actions API returns 403 for our App token and the broker will not mint the
   permission, so a naive poll of `/actions/runs` reads an empty list and
   concludes "no runs yet" — indistinguishable from a healthy untriggered
   commit. An unreadable response is never rounded down to an empty one.
2. **Exit `0` requires a completed, passing check run for every named check.**
   Zero check runs is exit `3`, not exit `0`. "Nothing to report" is not
   "nothing wrong". A required check that exists but was *skipped* is also exit
   `3` — it scanned nothing, and on a PR page that reads as an absence rather
   than a problem.
3. **Annotations are the sole classifier; duration is not.** The tempting
   heuristic — "it failed in 2 seconds, so it did no work" — is wrong here.
   `version and changelog` passes in 6 seconds and `secret scan` in 8. Any
   threshold catching a 2s refusal would fire on green builds.

### The asymmetry that sets the default

Because annotations are the only definitive signal, a refusal that produces no
annotation is reported as a *genuine failure*. This is deliberate, and the
reasoning generalises:

- A real failure mistaken for infrastructure is silent and permanent. The
  company learns to wave through red builds, and the secret scan stops meaning
  anything.
- Infrastructure mistaken for a real failure costs someone an hour, and at the
  end of that hour they know the truth.

Only the second corrects itself, so every unproven case resolves toward the
loud one. `REFUSAL_PATTERNS` is kept narrow for the same reason, and the test
suite asserts both directions with adversarial strings — a genuine test failure
in a module called "billing", and a job *cancelled* rather than never started,
must both stay `FAIL`.

## Consequences

- `docs/PROCESS.md` rule 1 now names `npm run check:ci` as the way to establish
  "CI is green" before acting on it.
- Exit `2` is not an engineering problem. There is nothing in the diff to fix
  and no failing job to debug; it needs whoever holds billing. The tool names
  that audience in its output, because the original failure was a message
  reaching the wrong reader.
- This does not make CI pass. It makes CI's silence audible. The spending limit
  itself is a spend decision reserved to the owner, raised as TOG-489.
- The detector reads only public check metadata and writes nothing.

## Alternatives rejected

**Alert on a duration threshold.** Rejected on the repository's own numbers: 6s
and 8s are normal passes here, so a threshold safe enough to avoid false alarms
would not catch a 2s refusal.

**Treat any red `secret scan` as a possible billing problem.** This is the
dangerous direction of the same confusion and would defeat the scanner. A red
secret scan is a credential until an annotation proves otherwise.

**Wait for branch protection to enforce it.** Branch protection needs GitHub Pro
or a public repo and is blocked on its own owner decision (TOG-240 / TOG-125).
It would also not have helped: a required check that is refused is still red,
and the question of whether it ran is unchanged.
