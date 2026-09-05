# TOG-975 — wiring the usage telemetry producer into Router v0.4.0

- Status: review handoff, awaiting the operator's Caddy lane (TOG-952)
- Date: 2026-09-05
- Branch: `tog-975-telemetry-producer` (`4fe65e3`, one commit on `431fd3a`)
- Contract: `docs/contracts/model-usage-telemetry-v1.md`
- Evidence: `tests/telemetry-consumer-interop.spec.ts`

This answers the two questions the operator asked on the TOG-975 thread, and
records the consumer defect that changes the answer to the first one.

> **SUPERSEDED IN PART BY TOG-977 (2026-09-05).** §0 below diagnosed the v0.4.0
> consumer and concluded the operator had to serve a flat per-model projection,
> one endpoint per model. TOG-977 fixed the consumer instead:
> `src/capacity/contract.ts` reads the contract's nested `models` map by key.
> **Serve the contract shape from a single endpoint** — see §6 at the bottom of
> this document for the current wiring. §§0–3 are retained as the record of what
> was measured, and remain accurate about the *legacy* path, which still handles
> non-contract vendor status bodies.

## 0. The finding that shapes everything below

The contract was written before the consumer existed. It has now been run
against the consumer that actually ships in v0.4.0, and **the nested `models`
map does not survive the trip.**

`collectEvidenceRecords` (`src/capacity/normalize.ts:44`) walks the whole payload
tree, collects every object carrying a configured utilization field, and then
attributes each collected record to **every** id in `source.modelIds`
(`src/capacity/normalize.ts:154`). There is no model-key lookup anywhere in the
consumer path.

Measured, against the real function:

| Payload | Rows | Result |
|---|---|---|
| Contract nested `models` map, 2 models, 1 source | 8 | `oc/claude-sonnet-5` reports `utilization 0.71` — Opus's number |
| Flat per-model projection, 1 model per source | 1 | correct |

In shadow mode that logs a confidently wrong number. In enforce mode it would
throttle the wrong model. So the wire projection is flat and per-model.

Two further consumer limits, both measured, both mattering to the wiring:

- **Outage and healthy-empty are indistinguishable.** Both yield zero rows and
  the identical `error` string `"capacity payload carried no recognizable
  telemetry records"`. Contract §4 separates them; the consumer cannot see it.
  Freshness has to carry that instead — see §3.
- **`schemaVersion` is never checked.** Nothing in the consumer path reads it. A
  future v2 producer would be best-effort parsed, not rejected.

Both are recorded as failing-if-fixed tests in the interop spec, so if a
consumer change ever repairs them the suite says so.

## 1. Answer: the `statusUrl` shape

One endpoint **per model id**, HTTPS, no query string, no fragment, no
userinfo. The consumer rejects all of those plus RFC1918 literals at
`src/capacity/read.ts:29`, and the config schema rejects them again.

```
https://<caddy-edge-host>/telemetry/model-usage/<model-slug>
```

Worked example on the intended TOG-952 lane:

```
https://router.infextion.net/telemetry/model-usage/opus-5
https://router.infextion.net/telemetry/model-usage/sonnet-5
```

`<model-slug>` is an opaque path token the deployment picks per model id. It is
**not** parsed by anything and must not encode a provider or account. The
binding from slug to exact model id lives in `sources[].modelIds`, which is the
only place the real id appears.

Requirements the producer endpoint must meet, each enforced by the consumer:

- `Content-Type` must end in `/json` or `+json` (`read.ts:53`).
- No redirects — a 3xx or a followed redirect is refused outright (`read.ts:49`).
- Body under `maxResponseBytes` (default 262144; the contract's own cap is
  256 KiB, which matches).
- 401/403 map to `capacity-authentication-failed`; any non-2xx to
  `capacity-http-failed`.
- If a bearer is required, it is sent as the `x-api-key` header from
  `apiKeySecretRef`. There is no Authorization-header option in the consumer.

## 2. Answer: exact JSON field names

The response body per endpoint is **flat** — utilization and reset values are
distinct top-level keys, one pair per window. This is the serialization of the
contract's record, not a change to it.

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-09-05T02:00:00.000Z",
  "staleAfterSeconds": 300,
  "telemetry": "available",
  "reasonCode": null,
  "serviceable": true,
  "state": "degraded",
  "observationQuality": "measured",
  "fiveHourUtilization": 0.71,
  "fiveHourResetsAt": "2026-09-05T04:00:00.000Z",
  "weeklyUtilization": 0.44,
  "weeklyResetsAt": "2026-09-08T00:00:00.000Z"
}
```

The `sources[]` entry that reads it:

```json
{
  "id": "telemetry-opus-5",
  "statusUrl": "https://router.infextion.net/telemetry/model-usage/opus-5",
  "modelIds": ["oc/claude-opus-5"],
  "healthFields": ["state"],
  "requestTimeoutMs": 5000,
  "maxResponseBytes": 262144,
  "windows": [
    { "name": "five-hour",
      "utilizationFields": ["fiveHourUtilization"],
      "resetFields": ["fiveHourResetsAt"] },
    { "name": "weekly",
      "utilizationFields": ["weeklyUtilization"],
      "resetFields": ["weeklyResetsAt"] }
  ]
}
```

**`modelIds` must contain exactly one id.** More than one re-opens the
cross-contamination in §0. Repeat the whole block per model.

### Field vocabulary

| Key | Type | Notes |
|---|---|---|
| `fiveHourUtilization`, `weeklyUtilization` | number in `[0,1]`, or `null` | outside `[0,1]` is read as `null`, never clamped |
| `fiveHourResetsAt`, `weeklyResetsAt` | RFC3339 UTC, or `null` | |
| `state` | `available` \| `degraded` \| `exhausted` \| `unavailable` \| `unknown` | the only `healthFields` entry |
| `telemetry` | `available` \| `unavailable` | see §3 |
| `reasonCode` | bounded enum or `null` | never a propagated upstream message |

`state` values map through the consumer's `normalizeHealth` as
`available -> healthy`, `degraded -> degraded`, `exhausted -> exhausted`,
`unavailable -> unavailable`, `unknown -> unknown`. The consumer then takes the
**more restrictive** of the explicit `state` and its own window-derived verdict,
so a producer can only ever tighten the reading, never loosen it.

Adding a window later means adding a `<name>Utilization` / `<name>ResetsAt` pair
and a `windows[]` entry. Window names stay in the contract's closed vocabulary
(`five-hour`, `daily`, `weekly`, `monthly`, `rolling`) — a free-form name is a
side channel for the vendor's identity.

## 3. Signalling an outage

Because the consumer cannot tell outage from healthy-empty (§0), an outage must
be signalled by **omitting the utilization keys entirely**:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-09-05T02:00:00.000Z",
  "staleAfterSeconds": 300,
  "telemetry": "unavailable",
  "reasonCode": "upstream-unreachable"
}
```

That yields zero evidence rows and a non-null `error`, which is what
`selectModel` reads as `capacity telemetry unavailable`. Keep
`unknownTelemetry: "fail-closed"` so a promotion to enforce refuses rather than
guesses.

A producer that cannot reach its upstream **must not** serve a stale body with a
fresh `observedAt`. Serve the observation time; `maxSnapshotAgeMs` (default
300000, matching `staleAfterSeconds: 300`) is the backstop, and staleness is the
only mechanism that still works when the two empty cases collapse.

## 4. Verification

`tests/telemetry-consumer-interop.spec.ts` runs the real
`normalizeCapacityPayload` against these payloads. Covered: correct per-model
attribution, both windows retained with the most restrictive winning,
`exhausted -> posture unavailable`, the reset-grace case (≥0.995 clearing within
300s reads `degraded`), null-utilization `unavailable`, and the outage shape.
Plus the three failing-if-fixed tests pinning the consumer defect.

Branch state: 188 tests pass, typecheck clean, acceptance rehearsal passes.
`scripts/check-workflows.mjs` is red identically on unmodified `main` (the known
unapplied operator patch), so it is not introduced by this branch.

## 5. What this does not authorize

Producer only. Capacity enforcement stays gated on TOG-901/916 and TOG-251.
`capacityRouting.mode` stays `shadow`. Note that the host config schema will
accept `mode: "enforce"` — that rule is procedural, with no technical guard.

## 6. CURRENT wiring (TOG-977) — serve the contract shape

This section replaces §§1–3 for a new deployment. The consumer now reads the
contract's nested `models` map by exact key, so the fan-out that forced the flat
projection is gone.

**One endpoint, all models.** No per-model slug, no repeated `sources[]` block.

```
https://router.infextion.net/telemetry/model-usage
```

Serve exactly the §3 response body — nested `models`, keyed by the exact opaque
model ID. The transport requirements in §1 are unchanged and still enforced:
HTTPS, no query/fragment/userinfo, no redirects, `Content-Type` ending in
`/json` or `+json`, body under `maxResponseBytes`, bearer (if any) sent as
`x-api-key`.

```json
{
  "id": "model-usage",
  "statusUrl": "https://router.infextion.net/telemetry/model-usage",
  "modelIds": ["oc/claude-opus-5", "oc/claude-sonnet-5"],
  "requestTimeoutMs": 5000,
  "maxResponseBytes": 262144,
  "windows": [{ "name": "five-hour", "utilizationFields": ["utilization"], "resetFields": ["resetsAt"] }]
}
```

`modelIds` may now list **every** model this endpoint covers — listing more than
one no longer cross-contaminates, because the lookup is `models[modelId]`. A
model in `modelIds` that the producer does not mention simply gets no evidence
row, and that is reported as healthy-with-no-coverage rather than as an outage.
`healthFields` and `windows` are unused on the contract path (state and windows
are read from their contract positions); keep one `windows` entry to satisfy the
config schema's `minItems: 1`.

### What changed for the producer

- **Signal an outage with `telemetry: "unavailable"` and a `reasonCode`**, exactly
  as contract §4 specifies. The §3 workaround — omitting the utilization keys so
  the tree walk found nothing — is no longer needed. The consumer now reads the
  field, and `telemetry: "available"` with `models: {}` is accepted as the
  distinct, trustworthy "healthy, governing nothing" answer.
- **`schemaVersion` is now enforced.** A body whose version is not `1` is rejected
  outright rather than best-effort parsed. Do not bump it without a consumer
  release.
- **Staleness is judged against `observedAt`**, not fetch time, using the
  producer's own `staleAfterSeconds`. A cached body served with a fresh
  `observedAt` it did not actually observe will be trusted; serve the true
  observation time. `maxSnapshotAgeMs` remains the backstop.
- **`serviceable` must agree with `state`** (§3.2). A record where they disagree is
  dropped, not reconciled.

Keep `unknownTelemetry: "fail-closed"` and `mode: "shadow"`. Verification:
`tests/capacity.spec.ts` (TOG-977 blocks) plus
`scripts/tog977-mutation-oracle.mjs`.
