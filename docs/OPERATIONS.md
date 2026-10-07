# Operations

This runbook installs, verifies, and rolls back the model-router plugin on a
live Paperclip instance. The repository is public and CI runs on GitHub-hosted
runners; releases are cut by tagging (`docs/PROCESS.md` → "Release") and the
published tarball is what an operator installs.

Two kinds of command appear below, and each block says which it is:

- **Checkout commands** (build, verify, rehearse, pin, download, unpack) need
  no Paperclip or GitHub credential. Each was run verbatim and its output is
  quoted; a reviewer can repeat them on a clean clone.
- **Instance-admin commands** (install, upgrade, config reads and writes, the
  plugin-row and decision-record SQL) need instance-admin or database access
  on the target instance. They were not run for this document. Each cites the
  host source or the recorded deployment it is taken from.

Provenance for every transcript: `NODE_ENV` unset (agent containers preset
`NODE_ENV=production`, which makes `npm ci` drop devDependencies and the build
die), built Paperclip host checkout at `/app`, no `GH_TOKEN` in the
environment, recorded 2026-10-02.

## Blast radius

- Plugin install or upgrade is instance-wide and restarts workers.
- Company config, secret reference, and state are company-scoped.
- A configured compatible upstream may itself have wider routing behavior; that is outside this plugin.

## Build and validate

Checkout commands. From a clean clone of the ref you intend to ship:

```sh
unset NODE_ENV
git clone https://github.com/TogetherWeOwn/paperclip-model-router.git
cd paperclip-model-router
git checkout v0.8.0
npm ci
npm run verify
```

`npm run verify` is `typecheck && test && check:lane-docs && build:lane-capacity
&& build && verify:host && verify:migrations && rehearse`. The host-coupled
steps need a built Paperclip checkout: they autodetect `/app` when
`/app/server/dist` exists, otherwise set `PAPERCLIP_HOST=/path/to/paperclip`.
With no host at all they skip, and the pin check below then refuses the
release (gate 8), so run `verify` where a host checkout is available.

Transcript at `v0.8.0` (`f90c51d`), exit 0:

```
 Test Files  38 passed (38)
      Tests  453 passed (453)

PASS: validated 6 required lane documents

  dist/worker.js                140.9kb
  dist/manifest.js               20.2kb
  dist/decision-records.js        1.8kb

strict: a host was requested (autodetected /app), so a check that cannot run is a FAILURE
all host-side checks passed
STOCK HOST CONTROL PROBES PASSED (4 probe(s) executed)
PASS 1 migration file(s), 2 statement(s), production insert/prune SQL, namespace=plugin_model_router_4dc1d582dd
REHEARSAL PASSED
```

The same command on `main` at `42a3b62` (2026-10-02, exit 0) reports
`71 passed (71)` test files, `822 passed (822)` tests, `dist/worker.js
176.9kb`, and `PASS 2 migration file(s), 4 statement(s)`; that code is
unreleased until the next tag.

The host-coupled steps, run individually so a reviewer can see each gate:

```sh
npm run build
PAPERCLIP_HOST=/app npm run verify:host
PAPERCLIP_HOST=/app npm run verify:migrations
npm run rehearse
```

- `verify:host` validates the built manifest and all shipped config fixtures
  through Paperclip's install-time validators. It is strict when a host
  checkout is reachable: a SKIP is a FAIL. It leaves
  `.verify-host-receipt.json` (git-ignored), naming the commit and the
  executed-check count. `npm run check:pin` gate 8 reads that receipt, so the
  evidence travels from the machine that can produce it to the handoff check
  that needs it.
- `verify:migrations` runs the bundled SQL and runtime write shapes through
  the target host checkout's database validators.
- `rehearse` loads one built worker and configures two companies with
  different compatible protocols and secret references. It invokes both and
  checks database-write isolation. On `main` it adds a third company and
  exercises an async invocation (submit → poll) and a run-end cancel on it
  (Evidence 8).

The rehearse transcript from `main` at `42a3b62`, in full. It is the
three-company isolation proof (exit 0). At `v0.8.0` the output is the same up
to the end of Evidence 7, followed by `REHEARSAL PASSED`: Evidence 8
landed after that tag.

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

EVIDENCE 8 — async submit/poll completes and run-end cancel settles invocation-cancelled
PASS  async submit returns pending with the same selection the sync path makes
PASS  async submit resolves the company secret at call time, company-scoped
PASS  async poll reaches completed through the company upstream
PASS  the async upstream call satisfies the sync contract
PASS  async traffic never touches the sync host bridge
PASS  a company cannot poll another company's request
PASS  the completed pending row carries attribution but no credential or prompt
PASS  the completed run left the run index on its own
PASS  the completion wrote one company-scoped audit row with run attribution
PASS  the second submit stays pending while its upstream socket is held open
PASS  the in-flight pending row carries run attribution but no credential or prompt
PASS  run-end reap settles exactly the named run
PASS  the reap aborted the real upstream socket, not just the row
PASS  the reaped invocation polls as non-retryable invocation-cancelled
PASS  a late upstream outcome never overwrites the reaped terminal
PASS  the reap wrote one company-scoped audit row naming the cancel
PASS  a second reap is a no-op and unknown runs/ids stay empty
PASS  async made exactly one upstream call per submit
PASS  async submits resolved exactly two company-scoped secrets
PASS  Evidence 8 wrote nothing outside the async company

REHEARSAL PASSED
```

## Release, pin, install

**Release.** Tag `vX.Y.Z` on a green `main` per `docs/PROCESS.md` → "Release";
`.github/workflows/release.yml` re-verifies, refuses a tag that does not match
`package.json`, and publishes
`togetherweown-paperclip-model-router-X.Y.Z.tgz` as the release asset. That
tarball is what an operator installs and what a company is pinned to.

**Pin.** Checkout command. Run it before writing a version into any
operator-facing text, and again before re-cutting a card that names it
(`docs/PROCESS.md` → "Handing a version to an operator"). Run it in the same
checkout of the tag where `npm run verify` just passed, because gate 8 reads
that run's receipt:

```sh
npm run check:pin -- --tag v0.8.0 \
  --expect-sha256 4339a5968a0ad9e3cf3c45e08d4c50c4187c746366544501154d5d913b000339 \
  --for-card
```

Transcript from the `v0.8.0` checkout above (exit 0, build output elided):

```
PASS  1  tag v0.8.0 resolves to a commit
      f90c51d1c8d8f76dfd059671bdffbdf68760c43c
PASS  2  package.json at v0.8.0 declares 0.8.0
PASS  3  CHANGELOG at v0.8.0 documents 0.8.0
PASS  7  HEAD ships the same plugin code as v0.8.0  (git diff v0.8.0..HEAD -- src)
PASS  8  verify:host ran strictly against v0.8.0 with no skipped checks
      25 host check(s) executed at /app with no skips
PASS  4  v0.8.0 is a published release with exactly one .tgz asset
      togetherweown-paperclip-model-router-0.8.0.tgz  161635 bytes  published 2026-09-28T02:59:38Z
PASS  5  the asset downloads and matches its sha256
      sha256 4339a5968a0ad9e3cf3c45e08d4c50c4187c746366544501154d5d913b000339  (161635 bytes) — matches --expect-sha256
PASS  6  the published asset's dist is byte-identical to this build
      dist/worker.js, dist/manifest.js identical — the tests that just ran describe the file the operator installs
  0 failed, 0 skipped
  ...
  RELEASE PIN CHECK PASSED
```

`--for-card` then prints a block to paste into the card. It refuses to print
that block if any gate failed *or skipped*. The gate is adversarial by design.
The same command run from `main` on 2026-10-02 refused:

```
FAIL  7  HEAD ships the same plugin code as v0.8.0  (git diff v0.8.0..HEAD -- src)
      22 file(s) changed since the tag:
      ...
      CUT A NEW TAG. Do not hand an operator this pin.
FAIL  8  verify:host ran strictly against v0.8.0 with no skipped checks
      receipt is for c95c0add45b2a90c76351c9cbba8fc9094ce73d9, not f90c51d1c8d8f76dfd059671bdffbdf68760c43c — re-run PAPERCLIP_HOST=/app npm run verify:host on this commit
FAIL  6  the published asset's dist is byte-identical to this build
      differ: dist/worker.js, dist/manifest.js
      Expected — gate 7 already found src/ has moved since this tag. Cut a new tag; this one is stale, not corrupt.
  3 failed, 0 skipped
  REFUSING to print a card block: a card may only quote a complete, clean run.
  RELEASE PIN CHECK FAILED — do not hand this version to an operator.
```

That is the gate working, not failing. `v0.8.0` is still a sound artifact to
install, as the passing run shows. It is not what `main` tests today, so the
answer for shipping `main` is to cut a new tag. Never reword the runbook around
the mismatch.

**Download.** Checkout command. The repository is public, so no token is
needed.

Transcript from the `v0.8.0` run (exit 0; the `v0.9.0` run is on its release card):

```sh
VERSION=0.8.0
TGZ="togetherweown-paperclip-model-router-$VERSION.tgz"
curl -fsSLO "https://github.com/TogetherWeOwn/paperclip-model-router/releases/download/v$VERSION/$TGZ"
echo "4339a5968a0ad9e3cf3c45e08d4c50c4187c746366544501154d5d913b000339  $TGZ" | sha256sum -c -
# togetherweown-paperclip-model-router-0.8.0.tgz: OK
```

`gh release download "v$VERSION" --repo TogetherWeOwn/paperclip-model-router
--pattern '*.tgz'` is equivalent when `gh` is installed.

**Unpack.** Run this on the instance host. `NEW_DIR` must be a path the host
has never loaded (see the next paragraph). The same commands were run with
`NEW_DIR` in a scratch directory (exit 0):

```sh
set -euo pipefail
NEW_DIR="/paperclip/plugin-packages-root/model-router-$VERSION"

test ! -e "$NEW_DIR"
mkdir -m 0755 "$NEW_DIR"
tar -xzf "$TGZ" -C "$NEW_DIR" --strip-components=1
env -u NODE_ENV npm install --prefix "$NEW_DIR" --omit=dev --ignore-scripts
# added 3 packages, and audited 4 packages in 1s
# found 0 vulnerabilities
```

**Install or upgrade.** Instance-admin commands. Read the release's CHANGELOG
"Compatibility" entry first. It states whether the release adds a plugin
capability, and that decides the path:

- **First install** on an instance with no model-router row:
  `npx paperclipai plugin install "$NEW_DIR" --local --json`.
  `install` refuses a plugin key that is already installed:
  `409 Plugin already installed: togetherweown.paperclip-model-router`
  (`server/src/services/plugin-registry.ts`,
  `install`). Use it only for a first install.
- **No new capability** (e.g. v0.8.0: "No new plugin capability is required,
  so this upgrades through the ordinary `plugin upgrade` path"): use the
  procedure below.
- **Capability-escalating** (new `database.*`, `jobs.schedule`, …): see
  "Capability-escalating upgrade" below. Do not use the ordinary procedure.

The ordinary upgrade (`POST /api/plugins/:pluginId/upgrade`) takes no package
argument. It re-reads the package from the directory stored in the plugin
row's `package_path` (`server/src/services/plugin-loader.ts`,
`upgradePlugin`). So the row has to point at `NEW_DIR` first. Repointing a
symlink at the old path does **not** work. Node's module cache keys on the path
string, so the host re-reads the cached old manifest. The v0.5.0 deployment
recorded exactly that failure (`oldVersion 0.4.5 -> newVersion 0.4.5`) in
`/paperclip/plugin-packages-root/model-router-0.5.0.deployment.json`. The
procedure that deployment then used:

```sh
PLUGIN='togetherweown.paperclip-model-router'

# 1. Record the row you are about to change. Keep packagePath and version:
#    they are the rollback target.
npx paperclipai plugin inspect "$PLUGIN" --json | jq '{id, version, status, packagePath}'

# 2. Point the row at the new directory (Paperclip database, operator access).
#    UPDATE plugins SET package_path = '<NEW_DIR>'
#      WHERE plugin_key = 'togetherweown.paperclip-model-router';

# 3. Upgrade. The host stops the worker, re-reads the manifest from NEW_DIR,
#    and returns to `ready` when no capability was added.
npx paperclipai plugin upgrade "$PLUGIN" --payload-json "{\"version\":\"$VERSION\"}" --json

# 4. Confirm: version is the new one, status is ready.
npx paperclipai plugin inspect "$PLUGIN" --json | jq '{version, status, lastError}'
```

Then run "Verify a configured company" below for each configured company.

## Capability-escalating upgrade

A release whose manifest declares new capabilities cannot go through the
ordinary upgrade endpoint. The durable ledger added `database.namespace.migrate`,
`database.namespace.read` and `database.namespace.write`; v0.6.0 added
`jobs.schedule`. The stock host deactivates the worker first and then rejects
the escalation before it updates the installed manifest
(`plugin-lifecycle.ts` `upgrade`, then `plugin-loader.ts` `upgradePlugin`
throws "introduces new capabilities that require approval"). Do **not** use
`POST /api/plugins/:pluginId/upgrade` for such a transition: it leaves the old
plugin record in place and the router offline.

The capability-approval boundary on the stock host is `plugin install`, which
applies the plugin's migrations in the same transaction as the install record.
Because `install` refuses a live key (409, above), it only applies after a
**soft** uninstall. `plugin uninstall "$PLUGIN"` without `--force` marks the
row `uninstalled`. A later `install` of the same key reactivates that same row
in place (same plugin ID, company config and plugin data kept), per
`plugin-registry.ts` `install`/`uninstall`. `--force` hard-deletes the row and
cascades its config: never use it here. That sequence is read from host
source and has not been run from this runbook. Rehearse it on a non-production
instance, and back up config first (Rollback, below). Refusing the transition
is safer than improvising a direct database edit around the capability gate.
[`docs/operator/TOG-2922-pace-ordering.md`](operator/TOG-2922-pace-ordering.md)
is the worked v0.4.5 example (config backup, prerequisite migration, full
rollback). Its `plugin install "$NEW_DIR"` step ran against a live 0.3.0 row
and would get that 409 today, so add the soft uninstall in front of it. Its
full-rollback `plugin install "$OLD_DIR"` has the same problem: use the
Rollback procedure below instead.

A capability *downgrade* is not capability-escalating and needs no
instance-admin path.

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

The config write is a full replace: `POST /api/plugins/:pluginId/config`
requires the whole `configJson` object, not a delta.

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
- `refresh-capacity` is company-scoped and performs bounded, non-retrying
  telemetry GETs: one per source, at most 4 in flight at once
  (`REFRESH_CAPACITY_MAX_IN_FLIGHT` in `src/worker.ts`). A refresh over N
  sources therefore takes at most ceil(N / 4) × the slowest source's latency.
  Failed refreshes preserve the last valid capacity-evidence snapshot but
  replace pace verdicts with only the current attempt's results, so stale
  pace never steers routing.
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

**Unreleased.** This section describes `main` (migration
`002_capacity_snapshot_age.sql` and the fields below). `v0.8.0` ships neither,
and they reach an instance with the next tag. Its CHANGELOG "Compatibility"
entry decides the install path.

`capacityRouting.maxSnapshotAgeMs` (default 300000 = 5 minutes) is the
freshness backstop: an invocation served from a snapshot older than that is a
**degraded-age invocation** — it routed on stale evidence. Every served
invocation exposes the age it actually used:

- the served decision carries `capacity.snapshotAgeMs` (wall-clock ms, null
  when no snapshot was ever stored) and `capacity.snapshotStale`. With
  capacity routing enabled, a missing snapshot counts as stale
  (`src/worker.ts`, `storedCapacity`);
- a company-namespaced counter fires on each degraded-age invocation:
  `model_router.company.<companyId>.capacity.snapshot_stale` (use the
  existing `model_router.invoke.*` series in the same namespace as the
  denominator);
- the persisted decision record rolls both up as `capacity_snapshot_age_ms`
  / `capacity_snapshot_stale` for the alert query below.

Two kinds of row carry `capacity_snapshot_age_ms` NULL **and**
`capacity_snapshot_stale` false: rows written before migration `002` (the
column default), and decisions made with capacity routing disabled. Neither
is evidence of freshness. The query therefore counts only capacity-routed
decisions: stale, or with a recorded age.

**Alert before promoting shadow→enforce.** A snapshot that keeps going stale
means the refresh cadence (or the producer) cannot sustain the routing mode.
Instance-admin (database access). Query per company over the trailing SLO
window, and page when the stale share exceeds 5%:

```sql
SELECT count(*) FILTER (WHERE capacity_snapshot_stale) * 1.0
         / NULLIF(count(*), 0) AS stale_share,
       count(*) AS capacity_decisions
FROM plugin_model_router_4dc1d582dd.decision_records
WHERE company_id = '<companyId>'
  AND recorded_at > now() - interval '30 minutes'
  AND (capacity_snapshot_stale OR capacity_snapshot_age_ms IS NOT NULL);
-- stale_share > 0.05: do NOT promote shadow→enforce; fix refresh first.
-- stale_share NULL (capacity_decisions = 0): no capacity-routed traffic in
-- the window. That is not a pass; widen the window or wait for traffic.
```

`plugin_model_router_4dc1d582dd` is the plugin's database namespace. The host
derives it from a sha256 of the plugin key (`plugin-database.ts`), so it is the
same on every instance; `verify:migrations` prints it. `<companyId>` is the company's UUID. The
query was run against a scratch database with migrations `001`→`002`
applied. Five rows (pre-002, capacity-off, fresh, over-age, never-stored)
gave `stale_share 0.667` over 3 capacity decisions. An empty window gave
`NULL`, not a division error.

Do not promote while the alert fires: under fail-open a stale snapshot serves
without capacity awareness, and under fail-closed it denies. Either way the
fleet is flying blind past the SLO.

Promotion itself stays an operator decision under
[`docs/decisions/0010`](decisions/0010-capacity-routing-is-shadow-first-and-fails-closed.md):
fresh evidence for every affected model, a clean representative shadow window,
and an outage rehearsal proving fail-closed behavior — never an automatic gate.

## Rollback

Instance-admin commands. Rollback restores two things: the previously
installed package and each company's pre-change config. Back both up before
every install, upgrade, or config write:

```sh
PLUGIN='togetherweown.paperclip-model-router'
COMPANY_ID="$PAPERCLIP_COMPANY_ID"
BACKUP='/secure/path/model-router-config-before-<change>.json'

# The package half: the row's current packagePath and version.
npx paperclipai plugin inspect "$PLUGIN" --json | jq '{id, version, status, packagePath}'
# The config half: the full PluginConfig record ({configJson, ...}, or null).
npx paperclipai plugin config "$PLUGIN" -C "$COMPANY_ID" --json > "$BACKUP"
```

To roll the package back, use the same repoint-then-upgrade procedure as the
ordinary upgrade, aimed at the recorded old directory. It is the rollback
command recorded with the v0.5.0 deployment. `plugin install "$OLD_DIR"` is
**not** a rollback: it is refused with 409 while the plugin row is live.

```sh
# 1. Paperclip database, operator access:
#    UPDATE plugins SET package_path = '<OLD_DIR from the inspect output>'
#      WHERE plugin_key = 'togetherweown.paperclip-model-router';
# 2. Re-read the old package and return to ready. A rollback never adds a
#    capability, so the ordinary endpoint accepts it.
npx paperclipai plugin upgrade "$PLUGIN" --payload-json '{"version":"<OLD_VERSION>"}' --json
npx paperclipai plugin inspect "$PLUGIN" --json | jq '{version, status, lastError}'
```

Restore the saved config. The endpoint needs `configJson`. Pass that field
from the backup, not the whole record:

```sh
npx paperclipai plugin config:set "$PLUGIN" -C "$COMPANY_ID" \
  --payload-json "$(jq -c '{configJson}' "$BACKUP")" \
  --json
```

If the backup is `null`, the company had no config before the change: there
is nothing to restore. For a config-only change with no package move, the
config restore alone is the rollback. For a one-key `capacityRouting` toggle,
re-running the reviewed transformer against the saved pre-enable payload
produces the exact prior state. See the "Full rollback" section of
[`docs/operator/TOG-2922-pace-ordering.md`](operator/TOG-2922-pace-ordering.md).

Leave the old package directory in place until the new version has served
cleanly. The rollback reads it from disk.

The source-code undo path is `git revert` on the merge commit, plus the
package rollback above to the previous artifact. Do not infer that an older release is safe to install
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
