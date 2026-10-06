# TOG-3419 — async invoke (submit + poll), v0.5.0 / v0.6.0

The async protocol and persistence behavior below also apply to v0.7.0.
That version adds the margin-aware serviceability hard stop before invocation;
see the v0.7.0 changelog for selection compatibility, not an async API change.
The same async protocol applies to v0.7.1; its tool-name validation fix is
recorded in the changelog. v0.8.0 keeps the protocol and adds the TOG-7417
run-end reap (`cancel-run-invocations`), an authoritative host-injected
budget fraction, and per-request abort — see the v0.8.0 changelog entry.
v0.8.1 keeps the protocol and capabilities unchanged and accepts explicit-null
success-envelope fields from null-serializing gateways.
This compatibility note is not install approval.

## Scope

v0.5.0 was a plain feature release, not a capability-escalating one: its
declared capabilities were unchanged (`plugin.state.read/write` and
`http.outbound` already covered the old synchronous path; the async path
reused both, nothing new), so the ordinary `POST /api/plugins/:pluginId/upgrade`
path was sufficient for it.

**v0.6.0 is capability-escalating.** It adds `jobs.schedule` (see
[Persistence fix](#persistence-fix-v060) below) and therefore needs the
instance-admin install path — the same one
[TOG-2922](TOG-2922-pace-ordering.md) required for its database-capability
increase — not the ordinary upgrade endpoint.

No company config needs to change to adopt v0.5.0 or v0.6.0. `maxSyncOutputTokens`
is an optional per-model field; every model without it keeps deriving its
synchronous budget exactly as before.

## What's new

- `model_router_invoke_async` (tool) / `POST /invoke-async` (route) — runs
  selection and credential resolution synchronously, then invokes the
  compatible upstream in the background and returns immediately:
  `{status: "pending", requestId, decision}`.
- `model_router_invoke_result` (tool) / `GET /invoke/:requestId` (route) —
  polls that submission: `{status: "pending"}` while running, `{status:
  "not-found"}` once the pending record's TTL has elapsed, or the terminal
  `completed`/`error` outcome.
- The background call is bounded by the selected model's own
  `requestTimeoutMs` (or the upstream default), up to the worker's real 300s
  ceiling — **not** squeezed to the 28s synchronous ceiling. This is what lets
  a generation that would overrun Paperclip's 30s host RPC cap still finish.
- The synchronous `model_router_invoke` / `POST /invoke` path is unchanged
  except for one new preflight: it now rejects, in milliseconds and before any
  credential resolution or upstream call, a `maxOutputTokens` unreachable
  within `min(model.requestTimeoutMs ?? upstream.requestTimeoutMs, 28_000)` at
  a 43 tok/s baseline. The `invalid-request` error names the model and points
  the caller at `model_router_invoke_async`.

## How the async path escapes the 30s cap

Paperclip caps every request that goes through the host HTTP bridge
(`ctx.http.fetch`) at 30s: the host aborts the outbound socket
(`PLUGIN_FETCH_TIMEOUT_MS`) and the SDK RPC layer rejects the pending host
promise (`DEFAULT_RPC_TIMEOUT_MS`) at the same deadline. The synchronous
`/invoke` path still rides that bridge and is still bound by it — nothing about
the sync path changed.

The async background continuation instead issues its single upstream request
with the worker process's own `fetch` (`directFetchHttpClient` in
`src/inference/transport.ts`), which never touches the host bridge and is
therefore bound only by the model's own `requestTimeoutMs` (clamped to the
worker's [1s, 300s] range). The plugin SDK explicitly sanctions a worker using
standard Node `fetch` directly; this is not a host workaround, it is the
supported way to run a long call from inside a plugin worker.

**SSRF posture is unchanged.** The direct fetch skips the host's DNS pinning,
but the only URL this path ever constructs is derived from the company's
already-validated `upstream.baseUrl` — config validation requires an absolute
`https://` URL, credential-free, that does not resolve to a private or reserved
range. There is no caller-supplied URL on this path.

## Persistence fix (v0.6.0)

v0.5.0 shipped a design flaw: Paperclip tears down a plugin worker's
invocation scope the instant the host receives the worker's RPC response, but
the async background continuation (an unawaited promise started during that
response) keeps running afterward. Its scoped `ctx.state` calls — persisting
the terminal outcome, and the legacy-log read that runs ahead of the audit
write — were rejected by the host once that scope was gone
(`the worker referenced a missing, expired, or unknown invocation scope`).
Submit still returned 202 and the upstream generation still completed, but
the pending record could never advance past `pending` and no audit record was
written. This was a host-scoping design constraint, not a plugin retry gap:
retrying the same write inside the same continuation cannot help, because the
scope really is gone.

v0.6.0 fixes this with two changes, no host or SDK change required:

- The background continuation now caches a completed/error outcome in-memory
  the moment it has one. Polling returns the correct terminal result
  immediately even if the state write behind it failed.
- A new scheduled job, `reconcile-async-invocations`, runs every minute
  (capability `jobs.schedule`). A job dispatch carries no invocation id, so
  the host grants it access under the plugin's ordinary proactive
  per-company scope rather than a dead invocation scope. The job flushes any
  cached terminal outcome and audit record the continuation could not
  persist, so both survive a worker restart rather than only living in the
  in-memory cache.

A company on v0.5.0 sees no behavior change from this fix until upgraded —
v0.5.0's pending records that never resolved stay stuck exactly as before;
there is no backfill for requests submitted before the upgrade.

## Verify a configured company

Submit, then poll:

```sh
REQ=$(curl -sS -X POST "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/invoke-async?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task":{"taskClass":"implementation"},
    "messages":[{"role":"user","content":"Write a long, careful answer."}],
    "maxOutputTokens":4000
  }')
echo "$REQ"   # {"status":"pending","requestId":"...","decision":{...}}

REQUEST_ID=$(echo "$REQ" | jq -r .requestId)

curl -sS "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/invoke/$REQUEST_ID?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN"
# {"status":"pending"} while running, then {"status":"completed","outcome":"completed",...}
```

Confirm the new sync-path preflight rejects an unreachable request immediately
(no upstream call, no multi-second wait):

```sh
time curl -sS -X POST "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/invoke?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task":{"taskClass":"implementation"},
    "messages":[{"role":"user","content":"Write a long, careful answer."}],
    "maxOutputTokens":4000
  }'
# HTTP 400, {"outcome":"error","error":{"code":"invalid-request", ...}}, real time well under a second
```

## Blast radius

Same as the existing plugin: instance-wide worker restart on upgrade;
company-scoped config, secrets, and state otherwise. Each async request uses
its own company-scoped `ctx.state` row, so concurrent submits cannot overwrite
one another. The row never contains the credential or prompt, but a terminal
row does contain the normalized response while it remains pollable.

The poll contract expires after 15 minutes. The worker schedules physical row
deletion at that deadline, and an expired poll also deletes the row. `ctx.state`
has no durable native TTL, however: if the worker restarts before its timer
fires and nobody polls that request again, an abandoned terminal row (including
its normalized response text) can remain physically stored until host database
retention removes it. Operators whose response-retention policy cannot tolerate
that restart edge should not enable async invoke until the host provides native
state TTL. The API still returns `not-found` after `expiresAt`; it never serves
an expired value.

## Rollback

`git revert` plus reinstalling the previous artifact, same as any other
version — see [OPERATIONS.md](../OPERATIONS.md#reversibility). No config
migration needs to be undone: nothing in v0.5.0 or v0.6.0 writes to a
company's stored config. Rolling back from v0.6.0 to v0.5.0 drops the
`jobs.schedule` capability and stops the reconcile job; it reintroduces the
v0.5.0 persistence bug but does not require an instance-admin path itself
(a capability downgrade is not capability-escalating).

## Scope note

This document records the TOG-3419 change. It does not authorize a live
install; per `docs/OPERATIONS.md`, the compatible-upstream implementation as a
whole remains ungated for public release under TOG-532's terms, unchanged by
this feature.
