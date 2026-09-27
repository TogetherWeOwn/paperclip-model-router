# TOG-4896 slice B — Muse-lane before/after verification plan

Owner: Founding Engineer. Companion to `deployment-staging/TOG-4896-operator.sh`.
Scope: verifies the local mitigation (shortened `tool_applications.application_key`
for affected GitHub gallery rows) actually restores distinct, working Muse-lane
GitHub tool names, without touching grants/policies/permissions.

## Pass criterion (written first)

For a single affected company/connection, run the same synthetic Muse-lane
session — 5 named GitHub read actions, called once each, in this fixed order —
before and after the mitigation is applied:

1. `get-me`
2. `get-file-contents` (a small known file, e.g. `README.md` at the repo root)
3. `list-branches`
4. `list-commits`
5. `list-pull-requests`

**Pass** requires all of the following on the *after* run:

- 5/5 calls resolve to the correct upstream action (verified by response shape:
  `get-me` returns a user object, `get-file-contents` returns file content,
  `list-branches`/`list-commits`/`list-pull-requests` each return arrays of the
  expected shape) — 0/5 misroutes.
- 0/5 calls return `No such tool available` or any other name-resolution error.
- The 5 gateway tool names presented to the Muse lane are pairwise distinct
  (no shared truncated base, no `_N` numeric aliasing).
- Regression check: the same 5-action session run against the **Claude and GPT
  lanes** (already unaffected, per the f7-impact baseline) still passes 5/5 —
  the mitigation must not regress lanes that were already working.
- Negative control: a policy-gated action on the same connection that was
  denied before the mitigation (if one exists for the test company) is still
  denied after — proves grants/policies did not move.

**Fail** if any of the above does not hold, or if the *before* run does not
reproduce at least 1/5 failures (if the *before* run is already 5/5, the test
company/connection is not actually affected and is not a valid fixture for
this verification — pick a different one, per the f7-impact blast-radius
list).

This is a verification *plan* — no live apply happens in this slice. The
before/after run itself only executes once the CEO has signed off on `apply`
per TOG-5763's constraints, coordinated with the TOG-4761 readout (2026-10-03).

## Before/after procedure

### 0. Fixture selection

Pick one company + one GitHub gallery connection known to be affected: an
`applicationKey` matching `app-gallery:github:<uuid>` with
`length(applicationKey) > 40`, from the f7-impact blast-radius query. Record:
`company_id`, `connection_id`, `application_id`, `old_application_key`.

### 1. Before (baseline, reproduces the defect)

1. Open (or reuse) a Muse-lane session with GitHub tool access via the fixture
   connection.
2. Call the 5 actions above, once each, in order. Record for each: the
   gateway-presented tool name, the raw response, and pass/fail per the
   criteria above.
3. Expect: some subset name-collide (shared truncated base / `_N` alias) and
   at least one call fails with a routing error — this reproduces the
   defect and is the baseline this fixture is worth testing against.

### 2. Apply (separate operator card, CEO-approved, not this slice)

Run `deployment-staging/TOG-4896-operator.sh dry-run --company-id <id>` first
and confirm the printed plan only contains the fixture row with a clear
policy pre-flight. Only then, on the approved operator card,
`apply --company-id <id> --confirm-ceo-signoff`. Save the printed rollback
manifest path.

### 3. After (mitigation verification)

1. Re-derive the gateway tool names for the fixture connection (or, if the
   gateway caches names, cycle the Muse-lane session so it re-resolves).
2. Call the same 5 actions, once each, in the same order. Record the same
   fields as step 1.
3. Score against the pass criterion above.

### 4. Regression check

Repeat the same 5-action session on the Claude and GPT lanes for the same
connection. Confirm 5/5 pass on both — these lanes were never broken by F7,
and the mitigation (an application_key rename) must not change their
behavior since their tool-name derivation was already within budget.

### 5. Rollback check (optional, recommended once)

On a disposable/staging-only fixture, run
`deployment-staging/TOG-4896-operator.sh rollback --manifest <path>` and
confirm the row's `application_key` is restored to `old_application_key`
exactly, and that the Muse-lane session reproduces the original baseline
failure again (proving rollback is a true inverse, not just "no crash").

## What this plan does not cover

- It does not test the upstream gateway code fix (TOG-4896 slice A,
  `14d077c52`) — that already has its own tests
  (`server/src/__tests__/tool-gateway.test.ts`). This plan only verifies the
  *local, no-deploy* mitigation in this slice.
- It does not run against production data. All company/connection IDs used
  must come from a staging or otherwise disposable database named explicitly
  via `TOG4896_DB_URL` — never the ambient `$DATABASE_URL`.
- No secrets (tokens, connection strings, row data beyond IDs/keys already
  discussed in the f7-impact doc) are to be pasted into any report or card
  comment; report pass/fail counts and tool names only.
