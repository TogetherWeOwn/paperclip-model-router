# paperclip-model-router

A Paperclip plugin that chooses the **cheapest model that clears a hard quality floor**
and every capability, provider, budget and quota constraint. Paperclip names a
model; OmniRoute resolves the provider.

The objective function is not "use the cheapest model". It is:

> minimize expected cost, **subject to** a hard quality floor and hard
> capability / privacy / provider constraints.

Cost never buys its way past quality. The gates are filters applied in a fixed
order, not weights in a score.

---

## What the plugin does

For a described task it returns a decision: a model id, or an explicit refusal,
with the full reasoning trace and every rejected model and why.

| # | Gate | What it does |
|---|------|--------------|
| 1 | **Rule 0** | Does this need a model at all? A summary matching a configured pattern returns `no-model-needed` and names the deterministic tool that should answer instead. The cheapest call is the one never made. |
| 2 | **Hard capability gates** | Context window, tool calling, structured output, modality. Anything that cannot do the job is rejected before cost is considered. |
| 3 | **The Claude block** | While Claude pay-as-you-go is off, a Claude-family model may resolve to exactly one provider (`teamclaude` by default) and nothing else. A pin cannot cross this. |
| 4 | **Quality floor** | Reject anything below the floor for this task class. This is the one comparison cost may never win. |
| 5 | **Cheapest survivor wins** | Ranked by expected USD for this task, then by provider preference, then by quality. |

Budget and Claude-quota pressure lower the tier **ceiling** and can refuse work
outright. Neither ever lowers the quality floor: if the ceiling would eliminate
every model that clears the floor, the ceiling lifts and the trace says so.

Two behaviours worth calling out:

- **Pins are respected but bounded.** A pinned model skips the tier ceiling — an
  estimate and a cost control — but not one hard gate. A refused pin is recorded
  with the reason it was refused.
- **Model stickiness within an issue.** Switching model mid-task destroys the
  prompt cache, which can cost more than the model difference saves. The
  incumbent is kept while it still clears the hard gates. Real budget or quota
  pressure still moves it.

## Surfaces

| Surface | Key | Use |
|---|---|---|
| Agent tool | `model_router_select` | An agent asks for a model for a task it is about to do. |
| Action | `route` | The same decision through the plugin bridge. |
| Action | `refresh-quota` | Re-read the teamclaude quota snapshot for a company. |
| Data | `effective-config` | The company's config with every default filled in. |
| Data | `decisions` | The recent decision log for a company (last 200). |
| Data | `quota` | The last quota snapshot and whether the gate is on. |
| API route | `POST /api/plugins/togetherweown.paperclip-model-router/api/issues/:issueId/route` | Route one issue. Company is resolved from the issue. |
| API route | `GET /api/plugins/togetherweown.paperclip-model-router/api/effective-config?companyId=…` | Read effective config. |

---

## Installing it into a company

**Paperclip plugin installation is global, not per-company.** There is no
per-company install table and no per-company enable switch
(`PLUGIN_SPEC.md` §8). One operator installs the plugin once per instance; every
company then gets its own row in `plugin_configs`, keyed by `(pluginId, companyId)`.

That is exactly what makes this reusable: **installing it for a second company is
a config write, not a deploy.**

### 1. Install once, per instance (operator)

The repository is private and the package is not published to public npm, so the
deployable artifact is the **version-pinned tarball** attached to each GitHub
release by `.github/workflows/release.yml`.

```bash
# pinned to a known-good version, and rollable back to any earlier one
gh release download v0.1.0 \
  --repo TogetherWeOwn/paperclip-model-router --pattern '*.tgz' --dir /tmp
tar -xzf /tmp/togetherweown-paperclip-model-router-0.1.0.tgz -C /opt/paperclip-plugins
paperclipai plugin install /opt/paperclip-plugins/package

# or, for development, from a checkout on the host
git clone git@github.com:TogetherWeOwn/paperclip-model-router.git
cd paperclip-model-router && npm ci && npm run build
paperclipai plugin install "$PWD"

paperclipai plugin inspect togetherweown.paperclip-model-router
```

If the instance gains a private npm registry, publish there and
`paperclipai plugin install @togetherweown/paperclip-model-router --version 0.1.0`
becomes the preferred form — the install record is then reproducible by any
operator without a checkout.

Confirm the target instance before installing — `paperclipai plugin target`
prints the API base URL and server version it will act against.

### 2. Configure each company (instance admin)

```bash
curl -X POST "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/config" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"configJson\":$(cat my-company.json)}"
```

The host validates `configJson` against the plugin's `instanceConfigSchema`
before storing it, and the worker's `onValidateConfig` adds cross-field checks
(duplicate model ids, a pin that is not in the table, thresholds out of order,
an invalid Rule 0 regular expression, a quota gate with no URL). A bad table is
rejected at write time, not at routing time.

Start from [`tests/fixtures/company-a.json`](tests/fixtures/company-a.json) or
[`tests/fixtures/company-b.json`](tests/fixtures/company-b.json). Both are real,
schema-valid configs; the two deliberately differ in every company-specific
dimension, and [`tests/two-company.spec.ts`](tests/two-company.spec.ts) asserts
that the same code produces the right different answers for each.

### 3. Verify

```bash
curl "$PAPERCLIP_API_URL/api/plugins/togetherweown.paperclip-model-router/api/effective-config?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN"
```

Nothing about step 1 changes when you add a company. If something ever has to
change in code to onboard a company, that thing is a bug in this plugin — it
belongs in the config schema.

---

## Configuration reference

Every key below is per company. Everything is optional; defaults are listed and
are deliberately the safe end of each switch.

### `routing`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` returns `disabled` for every decision and the caller keeps its own model. |
| `mode` | `"advise"` \| `"enforce"` | `"advise"` | `advise` records and returns a decision. `enforce` additionally applies it where the host permits. |
| `fallbackModelId` | string \| null | `null` | Model used when nothing survives the gates. `null` means refuse rather than silently downgrade. |
| `stickyModelWithinIssue` | boolean | `true` | Keep the model already used on an issue while it still clears the hard gates, to preserve the prompt cache. |

### `providers`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `permitted` | string[] | `[]` | Providers this company may be served by. **Fails closed**: an empty list rejects every model. |
| `preferenceOrder` | string[] | `[]` | Tie-break order among permitted providers. Earlier is preferred. |
| `claudePaygEnabled` | boolean | `false` | Claude pay-as-you-go. While `false`, Claude-family models may only use `claudeFamilyProvider`. |
| `claudeFamilyProvider` | string | `"teamclaude"` | The single provider Claude may use while PAYG is off. |
| `claudeFamilies` | string[] | `["claude"]` | Which `models[].family` values the Claude block governs. Case-insensitive. |

### `models` — the model tier table

An array. Each row is one model this company may use, priced at what **this
company** actually pays.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Model id Paperclip names. OmniRoute resolves it to a provider. |
| `family` | string | yes | Family grouping; `claude` (per `claudeFamilies`) is governed by the Claude block. |
| `tier` | `small` \| `standard` \| `strong` \| `frontier` | yes | Tier for ceiling comparisons. |
| `quality` | number 0–100 | yes | Quality on this company's scale, compared against task-class floors. |
| `costPerMTokIn` | number | yes | USD per million input tokens. |
| `costPerMTokOut` | number | yes | USD per million output tokens. |
| `contextWindow` | integer | yes | Tokens. |
| `capabilities` | string[] | no | Any of `tools`, `structured-output`, `vision`, `long-context`, `computer-use`. |
| `providers` | string[] | no | Providers that may serve it. Intersected with `providers.permitted`. |
| `enabled` | boolean | no (`true`) | Set `false` to retire a row without deleting it. |

### `taskClasses`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `key` | string | yes | Class name callers pass as `taskClass`. |
| `qualityFloor` | number 0–100 | yes | Hard floor. Never traded against cost. |
| `maxTier` | tier | no | Cost ceiling for this class. |
| `requiredCapabilities` | string[] | no | Added to whatever the caller requires. |
| `pinnedModelId` | string | no | Class-level pin. Must exist in `models`. |

An unconfigured task class routes with a floor of `0` — permissive — and the
trace says so. Configure your classes.

### `tiering`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `signalWeights` | object of number | `{}` | Task score = Σ (signal value × weight). |
| `thresholds` | `{small,standard,strong,frontier}` | `{0, 30, 60, 85}` | Lowest score reaching each tier; evaluated highest first. |
| `defaultTier` | tier | `"standard"` | Tier for a task with no signals. |

### `budget`

Fractions of the company's own cap. Must satisfy `warn ≤ downshift ≤ halt`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `monthlyCapUsd` | number | `0` | This company's monthly ceiling. |
| `warnFraction` | number 0–1 | `0.6` | Annotate the decision; change nothing. |
| `downshiftFraction` | number 0–1 | `0.8` | Drop the tier ceiling one step. |
| `haltFraction` | number 0–1 | `0.95` | Refuse non-pinned model work. |

### `quotaGate` — pooled Claude quota

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Off unless the company has a pooled Claude subscription. |
| `statusUrl` | string | `""` | Full teamclaude status URL **as reachable from the host**. Do not assume loopback: from a container the host is `host.containers.internal`, not `127.0.0.1`. |
| `apiKeySecretRef` | secret ref \| null | `null` | Paperclip secret holding the teamclaude key. A **reference**, never a value — the schema rejects a pasted key. |
| `windows` | string[] | `["unified5h","unified7d"]` | Status fields to read. |
| `warnUtilization` | number 0–1 | `0.7` | Annotate only. |
| `downshiftUtilization` | number 0–1 | `0.85` | Claude-family models drop a tier. |
| `pauseUtilization` | number 0–1 | `0.95` | Claude-family models become unavailable. Non-Claude work is untouched. |

Utilization values are **fractions in [0,1]**; `1.0` means the window is
exhausted. Reading them as percentages is wrong by 100×. If the endpoint is
unreachable the gate stays `ok` rather than pausing every company's Claude work.

### `rule0`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `deterministicPatterns` | `{pattern, tool}[]` | `[]` | Case-insensitive regular expression, and the tool that should answer instead. An invalid pattern is skipped, not fatal. |

---

## OmniRoute is global; plugin state is per company

**Get this wrong and one company's routing change silently breaks another's.**

| | Scope | Who changes it | Blast radius |
|---|---|---|---|
| OmniRoute combos and model→combo mappings | **Global to the proxy**, shared by every company on the instance | Operator, through the constrained combo CLI | Every company, immediately |
| This plugin's install | Global to the Paperclip instance | Operator, once | Every company, but inert without config |
| This plugin's config | **Per company** (`plugin_configs` keyed by `pluginId + companyId`) | Instance admin, per company | That company only |
| This plugin's state (decisions, stickiness, quota snapshot) | **Per company** (`plugin_state`, `scopeKind: "company"`) | The worker | That company only |

The practical rule: **a model id is a per-company choice; what that model id
resolves to is a global fact.** This plugin only ever picks a model id. It never
picks a provider, never edits a combo, and holds no capability that would let it.
Changing which provider serves a model is an OmniRoute operator action with
instance-wide blast radius and is out of scope for this plugin by design.

Two consequences for operators:

1. Adding a model to one company's table is safe. Adding an OmniRoute combo so
   that model resolves somewhere new is not — it affects everyone.
2. If a company's table names a model id OmniRoute does not map, the decision
   still succeeds here and fails downstream. Keep tables and combos reconciled;
   `docs/OPERATIONS.md` has the checklist.

## Secrets

No credential is ever committed to this repository or stored in a company's
config. The teamclaude key and the OmniRoute credentials are referenced by name
and resolved at runtime:

- `quotaGate.apiKeySecretRef` is a Paperclip secret reference resolved through
  `ctx.secrets.resolve()` at call time and never cached, logged, or persisted.
- The schema for that field rejects a raw string, so a pasted key cannot be
  stored even by mistake. `tests/config.spec.ts` and `tests/manifest.spec.ts`
  assert both properties, and CI runs a secret scan on every push.

## Development

```bash
npm ci
npm run verify        # typecheck + tests + build + host-schema validation
npm run verify:host   # validate the built artifact with the host's own validators
npm run dev           # esbuild --watch into dist/
```

`verify:host` runs the built `dist/manifest.js` through
`pluginManifestV1Schema` — the same Zod schema the host runs at install steps
3–4 — and every shipped example config through the host's Ajv config validator.
Point it at a Paperclip checkout to validate against that exact build:

```bash
PAPERCLIP_SHARED=/app/packages/shared/dist/validators/plugin.js npm run verify:host
```

`npm run verify` is what CI runs. See [`docs/PROCESS.md`](docs/PROCESS.md) for
the repository conventions and [`docs/decisions/`](docs/decisions/) for the
architecture decision records.

## Versioning and rollback

Releases are tagged `vMAJOR.MINOR.PATCH` and a company can be pinned to a known
version. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the rollback
procedure; the short form is that config is forward-compatible by construction
(unknown keys are rejected at write, missing keys take defaults), so rolling the
plugin back does not require rolling every company's config back with it.

## Status

`0.1.0` — the decision engine, the config contract, the quota reader, the agent
tool and the scoped API routes are implemented and tested. Applying a decision
to an issue's `assigneeAdapterOverrides` is **not** implemented: the plugin SDK
exposes `assigneeAdapterOverrides` on issue *create* but not on issue *update*
(`PluginIssuesClient.update`), so `mode: "enforce"` currently records and returns
the decision exactly as `advise` does. See
[`docs/decisions/0005-advise-before-enforce.md`](docs/decisions/0005-advise-before-enforce.md).
