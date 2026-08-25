# Operations

Install, configure, verify, roll back — and the blast-radius rules that make the
difference between a change that affects one company and one that affects every
company on the instance.

## Blast radius, before anything else

Other companies on this instance are live and some have running agents.

| Action | Scope | Safe to do without coordination? |
|---|---|---|
| Install or upgrade this plugin | Whole instance | **No.** Every company's worker restarts. Do it in a maintenance window. |
| Write a company's plugin config | That company only | Yes. |
| Add a model row to one company's table | That company only | Yes. |
| Add or edit an OmniRoute combo or mapping | **Every company on the proxy** | **No.** Operator action, reviewed as instance-wide. |
| Enable a company's Claude PAYG toggle | That company only, but it changes where Claude traffic goes | Owner decision, not an operator one. |

The rule: **a model id is a per-company choice; what that model id resolves to is
a global fact.** See [`docs/decisions/0002`](decisions/0002-omniroute-is-global-plugin-state-is-per-company.md).

## Install (once per instance)

```bash
# 1. Confirm which Paperclip you are about to change.
paperclipai plugin target
#    Read the API base URL and version. If it is not the instance you mean, stop.

# 2. Install the version-pinned tarball from the GitHub release.
#    v0.2.6 is the floor and v0.2.7 is the newest release, so there is nothing older
#    that is safe to choose. See Rollback below.
gh release download v0.2.7 \
  --repo TogetherWeOwn/paperclip-model-router --pattern '*.tgz' --dir /tmp
mkdir -p /opt/paperclip-plugins/model-router
tar -xzf /tmp/togetherweown-paperclip-model-router-0.2.7.tgz \
  -C /opt/paperclip-plugins/model-router --strip-components=1

#    The tarball ships dist/ but not node_modules. The plugin SDK is
#    deliberately external to the bundle — bundling it would pin a private copy
#    of the host/worker protocol — so resolve it before installing. Skipping
#    this is ERR_MODULE_NOT_FOUND at worker start, not a clean install failure.
cd /opt/paperclip-plugins/model-router
npm install --omit=dev --ignore-scripts

paperclipai plugin install /opt/paperclip-plugins/model-router

# 3. Confirm it loaded.
paperclipai plugin inspect togetherweown.paperclip-model-router
#    Expect status=ready. On error, `paperclipai plugin logs` has the reason.
```

At this point the plugin is installed for the whole instance and **inert**: with
no config, `providers.permitted` is empty, which fails closed, and every decision
returns `no-eligible-model`. No company's behaviour has changed.

## Configure a company

Requires instance-admin auth; `GET .../config` needs board org access.

```bash
COMPANY_ID=…            # the company to onboard
PLUGIN=togetherweown.paperclip-model-router

curl -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN/config" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"configJson\":$(cat company.json)}"
```

Rejections here are the system working. The host validates against
`instanceConfigSchema`; the worker's `onValidateConfig` adds the cross-field
checks. Between them they catch a duplicate model id, a pin that is not in the
table, thresholds out of order, an invalid Rule 0 pattern, a quota gate with no
URL, and a pasted credential.

Start from `tests/fixtures/company-a.json` (a company with a pooled Claude
subscription and the Claude block on) or `tests/fixtures/company-b.json` (a
company on one provider with Claude PAYG enabled). Every configuration key is
documented in the [README](../README.md#configuration-reference).

### The onboarding checklist

1. **Model table.** Only models this company is entitled to, priced at what this
   company pays.
2. **`providers.permitted`.** Only providers this company is entitled to. It
   fails closed, so an omission is a refusal, not a leak.
3. **Reconcile against OmniRoute.** Every `models[].id` must be a model id
   OmniRoute maps, or the decision succeeds here and fails downstream. The plugin
   cannot check this and deliberately holds no authority to.
4. **Claude PAYG.** Leave `claudePaygEnabled: false` unless the owner has enabled
   PAYG for this company. `onValidateConfig` returns a loud warning when it is on.
5. **Quota gate.** Only if the company has a pooled Claude subscription. Set
   `statusUrl` to the endpoint **as reachable from the host** — from a container
   the host is `host.containers.internal`, not `127.0.0.1` — and bind
   `apiKeySecretRef` to a Paperclip secret. Never paste the key.
6. **Budget thresholds** to this company's own cap, satisfying
   `warn ≤ downshift ≤ halt`.
7. **Task classes**, with a real `qualityFloor` each. An unconfigured class
   routes at floor 0, which is permissive.

## Verify

```bash
# Effective config, with defaults filled in.
curl "$PAPERCLIP_API_URL/api/plugins/$PLUGIN/api/effective-config?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $TOKEN"

# A real decision for a real issue, with the full trace.
curl -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN/api/issues/$ISSUE_ID/route" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"taskClass":"implementation","summary":"…"}'
```

Read the `trace`. It names every gate that fired and every model that was
rejected with the reason. If the outcome is `no-eligible-model`, the trace says
which gate emptied the field — usually `provider-not-permitted` on a first
configuration.

Two checks worth running on any new company before trusting it:

- **The Claude block holds.** Route a task that would want Claude while
  `claudePaygEnabled` is false and the model's providers include something other
  than teamclaude. Expect a `claude-block` rejection.
- **Rule 0 fires.** Route a summary matching one of the company's patterns.
  Expect `no-model-needed` and the tool named.

## Rollback

Config and code roll back independently, which is the point of pinning.

**Roll back the plugin** (affects every company):

```bash
paperclipai plugin upgrade togetherweown.paperclip-model-router <version>
# or reinstall the earlier tarball
paperclipai plugin inspect togetherweown.paperclip-model-router
```

> **Do not roll back below `v0.2.6` — which today means do not roll back.**
> Rollback is a safety valve for a regression, and below the floor it
> reintroduces one instead. Every release from `v0.2.0` onward closed a way
> around a gate the owner set:
>
> - `v0.2.0` — the budget and quota gate bypasses (TOG-228)
> - `v0.2.2` — the mislabelled-`family` route around the Claude block (TOG-237)
> - `v0.2.3` — the `claudeFamilyProvider` / `claudePaygEnabled` route around it
> - `v0.2.4` — `models[].providers` outranking the id's own routing prefix (TOG-149)
> - `v0.2.5` — a bare Claude id being read as proof of a teamclaude route (TOG-294)
> - `v0.2.6` — the fallback being judged by gates that never ran (TOG-248)
>
> Each of those is reachable from a company's own config row, so the blast
> radius of rolling back is every company on the instance, not just the one you
> were fixing. Because the floor has kept pace with the newest tag, **there is
> currently no earlier version to fall back to.** If a regression forces you
> below the floor, disable the plugin rather than pin under it, and say so on
> the issue.
>
> This list is prose and nothing checks it. When a release closes another
> bypass, add it here and in the README's floor table in the same commit.

Company configs do not need to be rolled back with it. Unknown keys are rejected
at write time, so a stored config never contains a key an older build cannot
handle; missing keys take defaults. A config written for a newer version is
readable by an older one, minus the newer feature.

**Roll back one company** — re-POST the previous `configJson`. Keep the previous
payload; the config route replaces wholesale rather than merging.

**Turn one company off without uninstalling** — set `routing.enabled: false`.
Every decision returns `disabled` and callers keep whatever model they would have
used. This is the safe panic switch and it affects exactly one company.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Worker fails at start with `ERR_MODULE_NOT_FOUND: @paperclipai/plugin-sdk` | The `npm install --omit=dev` step was skipped after unpacking the tarball. The SDK is external to the bundle on purpose. |
| Every decision is `no-eligible-model` with `provider-not-permitted` | `providers.permitted` is empty or does not intersect the model rows' `providers`. It fails closed by design. |
| A Claude model is never selected | The Claude block: the row's providers do not include `claudeFamilyProvider` while PAYG is off. Working as intended. |
| Claude models suddenly rejected with `quota-gate` | Pooled quota crossed `pauseUtilization`. Check the `quota` data key; utilization is a fraction, `1.0` is exhausted. |
| Quota snapshot error mentions `apiKeySecretRef` | The status endpoint answered 401/403. The gate stays open rather than pausing Claude work. |
| Decision succeeds but the run fails at the provider | The model id is not mapped in OmniRoute. Reconcile the table with the combo mappings. |
| A pin is refused | Read the trace: a pin skips the tier ceiling but no hard gate, and never crosses the Claude block. |
