# Operations

The compatible-upstream implementation is not authorized for a public release or live installation by TOG-532. This runbook documents the private artifact and verification path only.

## Blast radius

- Plugin install or upgrade is instance-wide and restarts workers.
- Company config, secret reference, and state are company-scoped.
- A configured compatible upstream may itself have wider routing behavior; that is outside this plugin.

## Build and validate

```sh
npm ci
npm run typecheck
npm test
npm run build
PAPERCLIP_HOST=/app npm run verify:host
PAPERCLIP_HOST=/app npm run verify:migrations
npm run rehearse
```

`verify:host` validates the built manifest and both shipped config fixtures through Paperclip's install-time validators. `verify:migrations` runs the bundled SQL and runtime write shapes through the target host checkout's database validators. `rehearse` loads one built worker, configures two companies with different compatible protocols and secret references, invokes both, and checks database-write isolation.

## Capability-escalating upgrade

The durable ledger adds `database.namespace.migrate`, `database.namespace.read`, and
`database.namespace.write`. The current stock host's ordinary upgrade endpoint stops the
worker and then rejects that capability escalation before updating the installed manifest.
Do **not** use `POST /api/plugins/:pluginId/upgrade` for this transition: it leaves the old
plugin record in place and the router offline.

Use the operator's capability-approval install path for the new artifact, then enable it and
verify the migration before resuming traffic. Preserve the old artifact and config first.
The exact operator command depends on the deployment's approved plugin installer; refusing
this transition is safer than improvising a direct database edit around the capability gate.

## Configure a company

Use a company-scoped plugin config containing:

- `routing`: enablement, pre-HTTP fallback, issue stickiness, and maximum output tokens;
- `upstream`: compatible protocol, HTTPS base URL, Paperclip secret reference, request timeout, response-size ceiling, and safe extra headers;
- `models`: opaque IDs with tier, quality, price, context, and capability facts;
- `taskClasses`, `tiering`, `budget`, and Rule 0 patterns;
- optional `capacityRouting`: exact opaque model IDs, sanitized lane-label fields, health/utilization mappings, and bounded refresh controls.

Start from `tests/fixtures/company-a.json` or `tests/fixtures/company-b.json`.

The secret field accepts only the closed Paperclip reference object. Store the actual credential in Paperclip's secret provider and bind its UUID; never paste the credential into config.

## Verify a configured company

Invoke through a company-scoped route:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/invoke?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task":{"taskClass":"implementation"},
    "messages":[{"role":"user","content":"Return OK."}],
    "maxOutputTokens":64
  }'
```

A completed handler operation returns HTTP 200 even when the compatible upstream failed; inspect `outcome` and `error`. Invalid native request bodies return HTTP 400. Host authorization, body-size, bridge, and worker failures may return other host statuses before the plugin handler completes.

For a generation that may run past the host's RPC timeout, use the async submit/poll pair instead — `POST /invoke-async` returns `{status, requestId, decision}` immediately (HTTP 202) and `GET /invoke/:requestId` reports `pending`, `not-found` (after the pending record's TTL), or the terminal outcome. See [`docs/operator/TOG-3419-async-invoke.md`](operator/TOG-3419-async-invoke.md) for worked commands and for the new `maxSyncOutputTokens` config field that governs when the synchronous path refuses a request outright instead of attempting it.

## Expected safety properties

- Company identity is resolved by the host for tools, actions, and routes.
- Rule 0 and selection refusals make no secret-resolution or HTTP call.
- The credential is resolved at call time and used only in the protocol auth header.
- `refresh-capacity` is company-scoped and performs bounded, non-retrying telemetry GETs — one per source, at most 4 in flight at once (`REFRESH_CAPACITY_MAX_IN_FLIGHT` in `src/worker.ts`), in ceil(N / 4) times the slowest source. Failed refreshes preserve the last valid capacity-evidence snapshot but replace pace verdicts with only the current attempt's results, so stale pace never steers routing.
- Canonical `invoke` performs zero telemetry GETs. Inference performs exactly one `ctx.http.fetch` with `redirect: "manual"` and `Accept-Encoding: identity`.
- Capacity evidence is keyed to exact opaque model IDs and records only sanitized source/lane labels and usage facts, never provider/account serving identity.
- A transport failure never causes automatic replay or post-HTTP model fallback.
- Decision records are company-scoped and exclude prompts, messages, tool inputs/results, credentials, full URLs, error bodies, and deployment identity.
- `query-decisions` is company-scoped: the company id comes from the host-authorized action context and is bound as the query's `$1`, so a caller only ever sees its own company's rows. One call returns at most 200 rows, newest first, inside that company's `decisionLog.retentionDays` window (default 90 days, 1–3650).
- Native metrics are aggregate and contain no company tag. The one exception
  is the degraded-age counter below, which is namespaced per company IN THE
  METRIC NAME (`model_router.company.<companyId>.capacity.snapshot_stale`)
  precisely because a company tag is forbidden.

## Capacity-snapshot refresh SLO (TOG-7885)

`capacityRouting.maxSnapshotAgeMs` (default 300000 = 5 minutes) is the
freshness backstop: an invocation served from a snapshot older than that is a
**degraded-age invocation** — it routed on stale evidence. Every served
invocation exposes the age it actually used:

- the served decision carries `capacity.snapshotAgeMs` (wall-clock ms, null
  when no snapshot was ever stored) and `capacity.snapshotStale`;
- a company-namespaced counter fires on each degraded-age invocation:
  `model_router.company.<companyId>.capacity.snapshot_stale` (use the
  existing `model_router.invoke.*` series in the same namespace as the
  denominator);
- the persisted decision record rolls both up as `capacity_snapshot_age_ms`
  / `capacity_snapshot_stale` for the alert query below (rows written before
  migration `002` read NULL/false — never-stored, never "fresh").

**Alert before promoting shadow→enforce.** A snapshot that keeps going stale
means the refresh cadence (or the producer) cannot sustain the routing mode.
Query the rollup per company over the trailing SLO window and page when the
stale share exceeds 5%:

```sql
SELECT count(*) FILTER (WHERE capacity_snapshot_stale) * 1.0 / count(*)
  AS stale_share
FROM <namespace>.decision_records
WHERE company_id = '<companyId>'
  AND recorded_at > now() - interval '30 minutes';
-- stale_share > 0.05: do NOT promote shadow→enforce; fix refresh first.
```

(`<namespace>` is the plugin's database namespace, e.g.
`plugin_model_router_4dc1d582dd`; `<companyId>` is the company's UUID.)
Do not promote while the alert fires: under fail-open a stale snapshot serves
without capacity awareness, and under fail-closed it denies. Either way the
fleet is flying blind past the SLO.

## Reversibility

Before any authorized installation, preserve the previously installed artifact and every company's previous config payload. The implementation undo path is a git revert plus restoring the prior artifact/config. Do not infer that an older release is safe to install merely because it exists; authorization and compatibility are separate gates.

## Applying an operator-only change

Some changes cannot be pushed by any agent in this company and need a human with
a wider credential. Today that is exactly one category: **files under
`.github/workflows/`**. The App the agents use has no `workflows` permission and
the token broker will not mint it, on purpose — see
[`docs/decisions/0008`](decisions/0008-workflow-files-are-operator-applied.md).

These changes are prepared as patches under `docs/operator/`, already reviewed
and merged as part of a normal PR. **The patch being in `main` does not mean it
has been applied** — that is the whole hazard of this arrangement, and the check
below is how you tell the two apart.

**Blast radius:** this repository's CI only. It changes no running instance and
no company's config. It is not a maintenance-window action.

```bash
# 1. See what is queued and why it is red.
npm run check:workflows

# 2. Apply. Patches are generated against main; if one does not apply, STOP —
#    do not resolve a conflict in a file the authors cannot test against.
#    Kick it back to the issue and ask for the patch to be regenerated.
git apply docs/operator/tog-488-ci-secret-scan.patch

# 3. Re-run the same check. This is the acceptance test, not `git diff`.
#    It must now report "workflow guard passed".
npm run check:workflows

# 4. Push on a branch and open a PR, with a token carrying `workflows: write`.
git checkout -b operator/tog-488-ci-secret-scan
git commit -am "TOG-488: verify the gitleaks download, and run the scanner self-test"
git push -u origin operator/tog-488-ci-secret-scan
```

Then **look at a real CI run** on that PR. Reading the file back is not the
acceptance test: the point of these patches so far has been to make a job that
was quietly doing nothing start doing something, and only a run shows that. For
the TOG-488 patch specifically, the `secret scan` job should gain a
`Self-test the scanner config` step that prints ten `PASS` lines. If that step is
absent the patch did not take, whatever the diff says.

Once the PR is merged, delete the applied patch in a follow-up PR — an applied
patch left in `docs/operator/` reads as still-queued to the next person.
`check:workflows` reports it as "already applied" until then, which is correct
but easy to skim past.

**Rollback** is `git revert` on the merge commit, with the same credential.
Nothing else depends on it.
