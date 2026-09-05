# TOG-974 — live shadow-mode evidence, Router v0.4.0

Captured 2026-09-05 from an agent container against the installed plugin
`f4ae898a-f839-4f64-9ff9-cf2e6287acc8` on `workforce.infextion.net`.

Reproduce with:

```
node scripts/capture-serving-baseline.mjs > after.json
node scripts/capture-serving-baseline.mjs --diff docs/operator/tog-974/serving-pre-shadow.json after.json
```

## What is in here

| file | what it is |
|---|---|
| `serving-pre-shadow.json` | serving fingerprint with `capacityRouting` absent (mode `disabled`) |
| `serving-shadow.json` | live capture with `capacityRouting.enabled=true, mode="shadow"` |

**Provenance caveat, stated because it matters.** `serving-shadow.json` is a raw
capture. `serving-pre-shadow.json` is *transcribed* from the pre-shadow capture
recorded on TOG-974 at 2026-09-05T01:08:58Z — it is not a second raw run,
because the config write is board-only (`403` to agents) and cannot be reverted
and re-captured from here. Its `provenance` field says so. The six serving rows
and the `disabled`/`not-configured` capacity block are what that capture showed.

## Result

Serving drift `0/6`. `capacity.mode` moved `disabled -> shadow` and nothing else
moved. Re-running the shadow capture twice also gives `0/6` against itself, so
the fingerprint is stable and not sampling noise.

| case | serving model | tier | before == after |
|---|---|---|---|
| default-no-signals | cliproxy/gpt-5.6-luna | standard | yes |
| small-cheap | cliproxy/gemini-3.1-flash-lite | small | yes |
| standard-mid | cliproxy/gemini-3.1-flash-lite | small | yes |
| large-complex | cliproxy/gemini-3.1-flash-lite | small | yes |
| long-context | cliproxy/gpt-5.6-luna | standard | yes |
| rule0-deterministic | cliproxy/gpt-5.6-luna | standard | yes |

## The outage case, for free

`sources: []` means the stored snapshot never refreshes, so
`storedCapacity` finds no `refreshedAt` and reports `capacity-snapshot-stale`
(`src/worker.ts:150`). Every live decision carries:

```json
{ "mode": "shadow", "telemetry": "unavailable", "usagePosture": "unknown",
  "utilization": null, "resetsAt": null,
  "decisionReason": "capacity telemetry unavailable: capacity-snapshot-stale" }
```

That is this card's required outage case observed on the live host, not staged:
telemetry recorded unavailable while serving is provably unchanged. The
fail-closed refusal branch is gated on `mode === "enforce"`
(`src/engine/select.ts:83`), so under `shadow` with `unknownTelemetry:
"fail-closed"` configured, selection proceeds untouched — which is exactly
what the diff above measures.

## Boundary

No credential material in any capture (`secretScan.clean: true`, and that
scanner is mutation-tested against a payload dirtier than the type permits).
In the live payloads `laneLabel` appears 0 times non-null; `bestLaneFor` and
`accountId` appear 0 times. Evidence is keyed on opaque `modelId`
(`src/capacity/types.ts`), and `laneLabel` is synthesized positionally as
`` `record-${index + 1}` `` (`src/capacity/normalize.ts:158`) — that literal is
present in the installed `dist/worker.js`, so no account identity can survive
normalization in the bytes actually serving.

## Route surface, as measured

| call | result |
|---|---|
| `POST /api/plugins/{id}/api/invoke?companyId=...` | 200, carries `decision.capacity` |
| `POST /api/plugins/{id}/api/issues/{issueId}/invoke` | 200, resolves company from the issue |
| `POST .../api/invoke` with no `?companyId=` | **400** — caller error, not a broken install |
| `POST .../api/refresh-capacity` | **404** — action key, not a route |
| `GET .../api/effective-config` | **404** — dropped in the rebase |
| `GET/POST /api/plugins/{id}/config` | **403** Board access required (agents) |

## Rollback

1. POST the operator's saved `router_config_before_shadow.json` back (removes
   `capacityRouting` → disabled), or set `capacityRouting.enabled=false`.
2. Full artifact rollback: repoint `/paperclip/plugin-packages-root/model-router-0.3.0`
   (currently a symlink to `model-router-0.4.0`) at
   `model-router-0.3.0-invocation-line` and call `/upgrade`.

Installed artifact re-verified this run: `dist/manifest.js e1ab33b4…`,
`dist/worker.js ed7045b1…`; markers `capacityRouting=37 refresh-capacity=1
model-health-probe=0`.

## Enforce is NOT unlocked by this

`mode: "enforce"` is schema-valid and the host will accept it. The gates are
TOG-901/916 (serving identity) and TOG-251 (measured quality floors), both
open. Shadow is also uninformative until a telemetry producer exists (TOG-978)
— `telemetry: "unavailable"` is the honest steady state today, not a defect.
