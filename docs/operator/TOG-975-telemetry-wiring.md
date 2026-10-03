# TOG-975 — wiring the usage telemetry producer into Router v0.4.0

- Status: review handoff, awaiting the operator's Caddy lane (TOG-952)
- Date: 2026-09-05
- Branch: `tog-975-telemetry-producer` (`4fe65e3`, one commit on `431fd3a`)
- Contract: `docs/contracts/model-usage-telemetry-v1.md`
- Evidence: `tests/telemetry-consumer-interop.spec.ts`

This answers the two questions the operator asked on the TOG-975 thread, and
records the consumer defect that changes the answer to the first one.

## 0. The finding that shapes everything below

**SUPERSEDED IN PART BY TOG-977.** The three defects below are still accurate
for `normalizeCapacityPayload` (`packages/lane-capacity/src/normalize.ts`) in
isolation — that function is retained for genuinely non-contract vendor
sources and still behaves exactly as measured here. They are **no longer**
true of the wiring a deployment actually hits: `readCapacitySource`
(`packages/lane-capacity/src/read.ts`) now dispatches a contract-shaped
response (anything carrying `telemetry`) to `packages/lane-capacity/src/contract.ts`
instead, which closes all three. See §6 below for the current state and
`docs/contracts/model-usage-telemetry-v1.md` §6.1 for the full account.

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
https://router.example.invalid/telemetry/model-usage/opus-5
https://router.example.invalid/telemetry/model-usage/sonnet-5
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
  "statusUrl": "https://router.example.invalid/telemetry/model-usage/opus-5",
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

§0's finding drove the wire format below into a flat, per-model, non-contract
shape as a workaround. That workaround is no longer necessary. A producer may
now serve the actual `model-usage-telemetry-v1` shape — nested `models` map,
`telemetry`, `reasonCode` — directly, and the consumer will read it correctly:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-09-05T02:00:00.000Z",
  "staleAfterSeconds": 300,
  "telemetry": "available",
  "reasonCode": null,
  "models": {
    "oc/claude-opus-5": { "windows": [{ "window": "five-hour", "utilization": 0.71, "resetsAt": "2026-09-05T04:00:00.000Z" }] },
    "oc/claude-sonnet-5": { "windows": [{ "window": "five-hour", "utilization": 0.1, "resetsAt": null }] }
  }
}
```

An outage is now first-class rather than inferred from an empty body:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-09-05T02:00:00.000Z",
  "staleAfterSeconds": 300,
  "telemetry": "unavailable",
  "reasonCode": "upstream-unreachable",
  "models": {}
}
```

`readCapacitySource` (`packages/lane-capacity/src/read.ts`) recognizes either
shape by the presence of `telemetry` and routes it to
`packages/lane-capacity/src/contract.ts`, which does the byte-key lookup
§0 found missing, rejects an unsupported `schemaVersion` instead of
best-effort parsing it, and reads the `telemetry`/`reasonCode` fields directly
instead of inferring outage from an absence of rows. The flat per-model
shape in §1–§2 above still works unchanged — it simply does not carry
`telemetry`, so it still takes the legacy tree-walk path. Both are valid;
a producer that can serve the contract shape natively should prefer it, since
it is the one this document's own contract defines and the one
`tests/tog-977-contract-consumer.spec.ts` proves the consumer honors end to
end against real producer output.
