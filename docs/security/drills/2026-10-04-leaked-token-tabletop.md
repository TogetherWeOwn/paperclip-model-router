# Tabletop drill record — leaked-token response (2026-10-04)

Drill only. No live credential existed, none was revoked, and no detector
code was written. All values below are synthetic placeholders.

Exercises: [`../leaked-token-response-runbook.md`](../leaked-token-response-runbook.md).

## Scenario

Synthetic report: a provider API key placeholder (`<provider-key-REDACTED>`,
never a real key) appears in a PR review comment during a routine router
change. The comment is public from push. The reporter posts location-only
evidence (PR number, comment time) with no value quoted.

## Walkthrough

| T+ | Action | Runbook step | Outcome |
|---|---|---|---|
| 0 min | Reporter stops quoting the value, posts location-only incident comment | §2 | Spread contained; no new copies |
| 5 min | Responder scopes: class = provider key, one comment location, public readership, assumed live | §3 | Scope recorded without moving the value |
| 12 min | Revoke plan drafted: service owner revokes in provider console, successor bound via secret reference; agent takes no credential action | §4 row 2 | Plan ready for review, not executed (drill) |
| 18 min | Decision brief routed to CISO role: class, location, readership, revoke plan, scrub plan, confirmation wording | §5 | Severity confirmed high-by-default (public repo) |
| 25 min | Scrub plan agreed: comment edit after evidence preserved; history rewrite not needed (no commit carried the value); re-scan on the closing head | §6 | Plan accepted |
| 30 min | Owner-visible confirmation drafted: class + location, dead-or-drill status, scrub + re-scan result, residual risk none | §7 | Wording approved as public-safe |

Total exercise time: 30 minutes, inside the 4-hour card budget.

## Findings

1. The runbook's "leave the text until CISO confirms" (§2.3) was the least
   intuitive step — instinct is to delete immediately. Kept as written:
   premature edits destroy scope evidence.
2. The revoke-before-rebind order (§4) needs emphasis for provider keys: one
   participant proposed binding the successor first. Drill holds the runbook
   order — two live secrets is worse than a short outage.
3. No runbook change required. No follow-up code or detector work identified;
   non-goal workstreams (pattern detector, red-main detector, exit-code
   probe) are unaffected.

## Attestation

Tabletop completed 2026-10-04 against the runbook revision in the same
change. Synthetic placeholders only; nothing to revoke, rotate, or scrub.
