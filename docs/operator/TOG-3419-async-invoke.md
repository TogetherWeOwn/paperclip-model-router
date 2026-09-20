# TOG-3419 — async invoke (submit + poll), v0.5.0

## Scope

This is a plain feature release, not a capability-escalating one. The plugin's
declared capabilities are unchanged (`plugin.state.read/write` and
`http.outbound` already covered the old synchronous path; the async path
reuses both, nothing new). **The ordinary `POST /api/plugins/:pluginId/upgrade`
path is sufficient** — this does not need the instance-admin install path that
[TOG-2922](TOG-2922-pace-ordering.md) required for its database-capability
increase.

No company config needs to change to adopt v0.5.0. `maxSyncOutputTokens` is an
optional per-model field; every model without it keeps deriving its
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
migration needs to be undone: nothing in v0.5.0 writes to a company's stored
config.

## Scope note

This document records the TOG-3419 change. It does not authorize a live
install; per `docs/OPERATIONS.md`, the compatible-upstream implementation as a
whole remains ungated for public release under TOG-532's terms, unchanged by
this feature.
