# Leaked-token response runbook (token in transcript, log, or comment)

Docs-only response procedure for a suspected credential exposure in this
repository's transcripts: issue comments, PR bodies, review threads, CI logs,
or committed text. It covers detection, containment, revoke/rotate steps, the
CISO route, and the owner-visible confirmation.

Scope: response only. Detection-pattern code lives elsewhere, and no step here
performs a live credential action — agents document and route; a human with
the right authority executes the revocation.

Companion drill record:
[`drills/2026-10-04-leaked-token-tabletop.md`](drills/2026-10-04-leaked-token-tabletop.md).

## 1. What counts

Any credential-shaped value appearing where it can be read, copied, or
retained outside its vault:

- personal access tokens, OAuth tokens, app tokens;
- provider API keys (upstream inference, telemetry, or status endpoints);
- bearer tokens from CI or deployment transcripts;
- a pasted secret where a Paperclip secret reference object belongs
  (`docs/decisions/0004-secret-references-not-secrets.md`).

A Paperclip `{ type: "secret_ref", secretId }` binding object is a reference,
not a secret — its presence in config is expected and is not an incident. A
raw string at a secret field is rejected by schema validation; treat a report
of one as a near-miss and still work this runbook through step 3.

This repository is public. Anything written here is world-readable from the
push, including history — severity starts high by default.

## 2. First five minutes (anyone who spots it)

1. **Stop the spread.** Do not quote, re-paste, or screenshot the value — not
   in a comment, a new issue, chat, or a fix commit. Reference it by location
   only (file, commit SHA, comment timestamp).
2. **Do not try another credential.** A failing or exposed credential is a
   blocker, not a puzzle: never substitute a different credential from env,
   files, process info, or broker output to "keep things working".
3. **Contain the blast radius.** If a run is still printing the value, cancel
   that run only; do not restart it or trigger new runs against the same
   secret. If the value sits in an open PR body or comment, leave the text in
   place until the CISO confirms the edit plan — premature edits destroy the
   scope evidence (step 3) while copies already exist elsewhere.
4. **Open the incident thread.** Post one short comment on the card that owns
   the work: what class of token, where it appears (no value), who can read
   that location, and that this runbook is engaged. Assign the CISO route
   (step 5) in the same run — do not wait.

## 3. Scope it (responder + CISO)

Determine, without moving the value anywhere new:

1. **Which credential class** (repo host token, provider key, deployment
   bearer, other) and whose authority issued it.
2. **Where it appears**: commit SHAs (note: the secret scan reads full
   history, so every ancestor commit counts), PR bodies, comments, logs.
   Scope a red scan to your own range first
   (`git log <base>..HEAD`-style range) so an inherited-commit hit is not
   misattributed.
3. **Who could have read it**: public readers from first push, forkers,
   log-retention windows, notification recipients.
4. **Whether it is still live**: assume live until the issuer's console says
   revoked. Never probe by using it.

Record the answers as locations and verdicts, never values.

## 4. Revoke / rotate (human-executed, approved)

Agents never revoke, rotate, delete, or re-create credentials. Each row below
is a human step with its approval; the responder prepares the request, the
named authority approves, the credential owner executes.

| # | Credential class | Execute | Approval |
|---|---|---|---|
| 1 | Repo-host token (user or app-issued) | Owner of the token revokes it in the host console, then issues a replacement out-of-band | CISO reviews; token-owner identity required |
| 2 | Upstream provider key (inference / telemetry) | Service owner revokes the key in the provider console, creates the successor, rebinds the Paperclip secret reference | CISO reviews; rotation of a credential leaving control is owner-reserved, so batch through the CEO decision path |
| 3 | Paperclip secret binding | Binding owner deletes the binding only after the successor is live; config keeps referencing the binding object, never a pasted value | CISO reviews; creation of a replacement binding is human-confirmed first |
| 4 | CI / deployment bearer from a transcript | Issuer revokes the token; runners holding it are cycled per the platform runbook | CISO reviews |

Order matters: revoke first, confirm dead, then bind the successor. Rotating
config to a new value while the old one is still live leaves two live secrets
instead of one. Never export a token into an environment variable to run these
steps; prefer the credential broker path the repo already uses.

## 5. CISO route

Route to the CISO (or the acting security reviewer when the CISO is
unreachable) as a decision brief, in-thread, containing:

- credential class and issuer (step 3.1), exposure locations (step 3.2),
  readership (step 3.3);
- proposed revoke/rotate row from step 4 and who executes it;
- scrub plan for the text (step 6) and its approval needs;
- owner-visible confirmation wording (step 7).

The CISO decides severity, approves or redirects the revoke plan, and owns the
call on whether history must be rewritten versus a forward-only scrub. Do not
route routine updates to the repo owner; only the credential-rotation approval
above travels the owner-reserved path, batched, not as scattered asks.

## 6. Scrub the text

Only after the credential is dead:

1. **History rewrite for committed text.** A working-tree edit cannot clear a
   scan that reads full history — the fix must rewrite the introducing
   commit. Follow the repo's established scrub method (rewrite the commit,
   delete the stale refs, re-scan the range) and verify the scan names your
   range, not just the tip.
2. **Bodies and comments.** Edit the PR body / comment to remove the value
   once the CISO confirms the evidence is preserved elsewhere (step 3
   record). State the edit plainly; do not claim the exposure never happened.
3. **Logs.** Expire or redact per the platform's log controls; where logs are
   immutable, record the retention expiry as the scrub date.
4. **Re-scan.** The secret scan plus the config-shape test (raw strings
   rejected at secret fields) must both pass on the exact head that closes
   the incident.

Patches that touch workflow files stay operator-applied
(`docs/OPERATIONS.md` → "Applying an operator-only change"); a scrub that
needs one is two PRs, not a shortcut.

## 7. Owner-visible confirmation

Close with one short, public-safe comment on the incident card:

- what happened (class + location, no value, no internal links);
- what is now dead (credential class + revocation confirmation source);
- what was scrubbed and what re-scan passed, with the head SHA;
- any residual risk (e.g. log retention window) and its expiry;
- link to the drill/record update if this run changed the runbook.

No token values, no rotation details, no internal ticket ids, no instance
links, no private hosts — this repo is public and the confirmation is too.

## 8. Non-goals

- Secret-pattern detectors and scanners (owned by the detection workstream).
- Red-main triage and runner forensics (separate detector cards).
- Exit-code / crash-loop probes (separate reliability work).
- Live credential operations from agents — explicitly out of scope.
