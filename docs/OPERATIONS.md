# Operations

This runbook installs, verifies, and rolls back the model-router plugin on a
live Paperclip instance. The repository is public and CI runs on GitHub-hosted
runners; releases are cut by tagging (`docs/PROCESS.md` → "Release") and the
published tarball is what an operator installs. Every command below was run
verbatim against the cited commit — the transcripts are the proof, not
illustration.

Provenance for every transcript in this file: clean checkout of the cited
ref, `env -u NODE_ENV` (agent containers preset `NODE_ENV=production`, which
makes `npm ci` drop devDependencies and the build die), host checkout at
`/app`, recorded 2026-09-28.

## Blast radius

- Plugin install or upgrade is instance-wide and restarts workers.
- Company config, secret reference, and state are company-scoped.
- A configured compatible upstream may itself have wider routing behavior; that is outside this plugin.

## Build and validate

From a clean checkout of the ref you intend to ship:

```sh
env -u NODE_ENV npm ci
npm run verify
```

`npm run verify` is `typecheck && test && check:lane-docs && build:lane-capacity
&& build && verify:host && verify:migrations && rehearse`. Transcript (clean
`v0.8.0` worktree, 2026-09-28, exit 0):

```
 Test Files  47 passed (47)
      Tests  536 passed (536)

PASS: validated 6 required lane documents

  dist/worker.js                145.5kb
  dist/manifest.js               21.2kb
  dist/decision-records.js        1.9kb

all host-side checks passed
STOCK HOST CONTROL PROBES PASSED (4 probe(s) executed)
PASS 2 migration file(s), 4 statement(s), production insert/prune SQL, namespace=plugin_model_router_4dc1d582dd
REHEARSAL PASSED
```

The three host-coupled steps, run individually so a reviewer can see each
gate:

```sh
npm run build
PAPERCLIP_HOST=/app npm run verify:host
PAPERCLIP_HOST=/app npm run verify:migrations
npm run rehearse
```

`verify:host` validates the built manifest and all shipped config fixtures
through Paperclip's install-time validators (strict when a host checkout is
reachable: a SKIP is a FAIL). `verify:migrations` runs the bundled SQL and
runtime write shapes through the target host checkout's database validators.
`rehearse` loads one built worker, configures three companies with different
compatible protocols and secret references, invokes both sync companies,
submits an async invocation (submit → poll) plus a run-end cancel on the
third, and checks database-write isolation. `verify:host` leaves
`.verify-host-receipt.json` (git-ignored) naming the commit and
executed-check count; `npm run check:pin` gate 8 reads it, so the evidence
travels from the machine that can produce it to the handoff check that needs
it.

The rehearse transcript, in full — this is the three-company isolation proof
(2026-09-29, exit 0):

```
PASS  one built worker declares multi-company support
PASS  the built bundle contains no company UUID
PASS  the built bundle contains no direct networking imports
PASS  the built bundle uses the stock host HTTP boundary
PASS  company A completes through its OpenAI-compatible upstream
PASS  company B completes through its Anthropic-compatible upstream
PASS  the same invocation selects differently only because company config differs
PASS  each company uses its own base URL
PASS  each call disables redirects
PASS  each call sends Accept-Encoding identity
PASS  secret resolution is repeated at call time and company-scoped
PASS  repeated calls receive distinct secret resolutions rather than a cached credential
PASS  Rule 0 makes no upstream or secret request
PASS  decision records are company-scoped durable inserts
PASS  decision records contain no request content or credential

EVIDENCE 7 — model-usage evidence refresh is separate and shadow-first
PASS  refresh is company scoped and uses the distinct capacity secret path
PASS  refresh output contains no credential, provider, or account serving claim
PASS  shadow preserves the v1 winner and invoke makes zero inline capacity GETs
PASS  shadow makes exactly one inference POST
PASS  enforce changes only the opaque model ID and still makes one inference POST
PASS  capacity decision exposes no provider/account fields

REHEARSAL PASSED
```

## Release, pin, install

**Release.** Tag `vX.Y.Z` on a green `main` per `docs/PROCESS.md` → "Release";
`.github/workflows/release.yml` re-verifies, refuses a tag that does not match
`package.json`, and publishes
`togetherweown-paperclip-model-router-X.Y.Z.tgz` as the release asset. That
tarball is what an operator installs and what a company is pinned to.

**Pin.** Before writing a version into any operator-facing text, and again
before re-cutting a card that names it (`docs/PROCESS.md` → "Handing a version
to an operator"):

```sh
npm run check:pin -- --tag v0.8.0 --expect-sha256 <the sha in the card> --for-card
```

`--for-card` prints a block to paste into the card and refuses to print it if
any gate failed *or skipped*. The gate is adversarial by design — on 2026-09-28
it refused `v0.8.0` from a `main` that had moved eight `src/` files past the
tag:

```
FAIL  7  HEAD ships the same plugin code as v0.8.0  (git diff v0.8.0..HEAD -- src)
      CUT A NEW TAG. Do not hand an operator this pin.
```

That is the gate working, not failing: the answer is to cut a new tag, never
to reword the runbook around the mismatch.

**Install.** Download the pinned asset and verify its hash (2026-09-28):

```sh
gh release download v0.8.0 --repo TogetherWeOwn/paperclip-model-router --pattern '*.tgz'
sha256sum togetherweown-paperclip-model-router-0.8.0.tgz
# 4339a5968a0ad9e3cf3c45e08d4c50c4187c746366544501154d5d913b000339
```

Then unpack and install. Which endpoint depends on the release's CHANGELOG
"Compatibility" entry:

- **No new capability** (e.g. v0.8.0: "No new plugin capability is required,
  so this upgrades through the ordinary `plugin upgrade` path") — the ordinary
  `POST /api/plugins/:pluginId/upgrade` path is sufficient.
- **Capability-escalating** (new `database.*`, `jobs.schedule`, …) — see
  "Capability-escalating upgrade" below; do not use the ordinary endpoint.

```sh
set -euo pipefail
PLUGIN='togetherweown.paperclip-model-router'
NEW_DIR='/paperclip/plugin-packages-root/model-router-0.8.0'
TGZ='togetherweown-paperclip-model-router-0.8.0.tgz'

test ! -e "$NEW_DIR"
mkdir -m 0755 "$NEW_DIR"
tar -xzf "$TGZ" -C "$NEW_DIR" --strip-components=1
npm install --prefix "$NEW_DIR" --omit=dev --ignore-scripts
```

For a worked instance-admin install with config backup, prerequisite migration,
and full rollback, see
[`docs/operator/TOG-2922-pace-ordering.md`](operator/TOG-2922-pace-ordering.md) —
it remains the canonical transcript for the capability-approval path.

## Capability-escalating upgrade

A release whose manifest declares new capabilities (today the durable ledger
adds `database.namespace.migrate`, `database.namespace.read`,
`database.namespace.write`; v0.6.0 added `jobs.schedule`) cannot go through
the ordinary upgrade endpoint: the stock host stops the worker and then rejects
the capability escalation before updating the installed manifest. Do **not** use
`POST /api/plugins/:pluginId/upgrade` for such a transition: it leaves the old
plugin record in place and the router offline.

Use the operator's capability-approval install path for the new artifact, then
enable it and verify the migration before resuming traffic. Preserve the old
artifact and config first. The exact operator command depends on the
deployment's approved plugin installer; refusing this transition is safer than
improvising a direct database edit around the capability gate. A capability
*downgrade* is not capability-escalating and needs no instance-admin path.

How to tell which one a release needs: read its CHANGELOG "Compatibility"
entry. It names the path explicitly for every release since v0.5.0.

## Configure a company

Use a company-scoped plugin config containing:

- `routing`: enablement, pre-HTTP fallback, issue stickiness, and maximum output tokens;
- `upstream`: compatible protocol, HTTPS base URL, Paperclip secret reference, request timeout, response-size ceiling, and safe extra headers;
- `models`: opaque IDs with tier, quality, price, context, and capability facts;
- `taskClasses`, `tiering`, `budget`, and Rule 0 patterns;
- optional `capacityRouting`: exact opaque model IDs, sanitized lane-label fields, health/utilization mappings, and bounded refresh controls.

Start from `tests/fixtures/company-a.json` or `tests/fixtures/company-b.json`
— both pass the host's own `instanceConfigSchema` validation under
`verify:host`, so a config that matches their shape is one the host accepts.

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

Promotion itself stays an operator decision under
[`docs/decisions/0010`](decisions/0010-capacity-routing-is-shadow-first-and-fails-closed.md):
fresh evidence for every affected model, a clean representative shadow window,
and an outage rehearsal proving fail-closed behavior — never an automatic gate.

## Rollback

Rollback restores two things: the previously installed package and each
company's pre-change config payload. Back both up before every install or
config write:

```sh
PLUGIN='togetherweown.paperclip-model-router'
COMPANY_ID="$PAPERCLIP_COMPANY_ID"
BACKUP='/secure/path/model-router-config-before-<change>.json'

npx paperclipai plugin config "$PLUGIN" -C "$COMPANY_ID" --json > "$BACKUP"
```

Then, to roll back:

```sh
# Reinstall the exact package directory recorded by the live plugin row
# before the change (e.g. the previous version's directory).
npx paperclipai plugin install "$OLD_DIR" --json

# Restore the saved config payload verbatim.
npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c . "$BACKUP")" \
  --json
```

For a config-only change with no package move, the second command alone is the
rollback. For a one-key `capacityRouting` toggle, re-running the reviewed
transformer against the saved pre-enable payload produces the exact prior
state — see the "Full rollback" section of
[`docs/operator/TOG-2922-pace-ordering.md`](operator/TOG-2922-pace-ordering.md).

The source-code undo path is `git revert` on the merge commit plus reinstalling
the previous artifact. Do not infer that an older release is safe to install
merely because it exists: run `npm run check:pin` against it first — pin gates
exist precisely because "the tag exists" once proved nothing (PROCESS.md →
"Handing a version to an operator").

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
git apply docs/operator/tog-7890-hosted-pack-step.patch

# 3. Re-run the same check. This is the acceptance test, not `git diff`.
#    It must now report "workflow guard passed".
npm run check:workflows

# 4. Push on a branch and open a PR, with a token carrying `workflows: write`.
git checkout -b operator/tog-7890-hosted-pack-step
git commit -am "TOG-7890: simplify pack/load step for hosted-only runners"
git push -u origin operator/tog-7890-hosted-pack-step
```

Then **look at a real CI run** on that PR. Reading the file back is not the
acceptance test: the point of these patches so far has been to make a job that
was quietly doing nothing start doing something, and only a run shows that. For
the TOG-7890 patch specifically, the verify job's pack/load step should unpack
into a fixed `INSTALL_DIR` with no run-id suffix and run no `Remove the
unpacked artifact` cleanup step — the VM is discarded either way. If run-unique
paths or the cleanup step are still there, the patch did not take, whatever
the diff says.

Once the PR is merged, delete the applied patch in a follow-up PR — an applied
patch left in `docs/operator/` reads as still-queued to the next person.
`check:workflows` reports it as "already applied" until then, which is correct
but easy to skim past.

**Rollback** is `git revert` on the merge commit, with the same credential.
Nothing else depends on it.
