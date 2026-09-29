# Model usage telemetry contract v1

- Status: accepted for implementation
- Date: 2026-09-04
- Owner: Director of Engineering
- Issue: TOG-975
- Consumer: Router v0.3.0 shadow dogfood (TOG-972)
- Paperclip plugin API: v1

This is the normative contract for the **producer** of model-level usage telemetry. It
defines what a deployment-owned telemetry surface must publish so that the Model Router
plugin can be capacity-aware without ever receiving a provider, account, or subscription
identity.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. Why this exists, and why it is not part of the plugin

`docs/contracts/compatible-upstream-v1.md` §1 splits the request path into selection,
protocol adaptation, and deployment routing, and assigns deployment routing — "which
provider, account, subscription, combo, or PAYG leg serves that model" — to the configured
upstream, outside the plugin. It then states flatly:

> The plugin MUST NOT infer, choose, expose, or fall back between providers.

Capacity is a property of that deployment layer. The real state lives in things the plugin
is forbidden to know about: a subscription's weekly window, one OAuth account's remaining
quota, a combo's per-connection reset clock. A naive capacity feature therefore breaks the
compatible-upstream boundary by construction — the plugin ends up holding lane identities
in order to avoid them.

This contract resolves that by inverting who does the aggregation. The **deployment**
collapses every account, connection, combo leg and subscription window that can serve a
given model into a single verdict keyed **only by the exact opaque model ID the plugin
already uses**. The plugin learns *"`oc/claude-opus-5` is serviceable, ~70% utilized,
resets at T"*. It never learns how many accounts stand behind that, which provider they
are, or which one served the last call.

The producer is therefore deployment-owned infrastructure, not plugin code. This repository
carries the contract, a reference normalizer, and the conformance tests; it does not
carry the deployment's credential or its collection loop.

### 1.1 What this does not authorize

This contract specifies a **producer only**. It does not authorize capacity enforcement.
Router capacity routing remains shadow-first and its promotion to `enforce` stays gated on
TOG-901/916 (serving-model recording) and TOG-251 (measured quality floors). A conforming
producer changes nothing about routing on its own.

## 2. The sanitization boundary

### 2.1 The permitted key

A record MUST be keyed by `modelId`: the **exact, opaque** model ID string as it appears in
the router's model table and on the wire to the upstream. The producer MUST NOT parse,
split, prefix-strip, or otherwise interpret this string, and consumers MUST compare it
byte-for-byte. A routing prefix such as `oc/` is part of the ID, not a provider name.

### 2.2 The forbidden fields

A response MUST NOT contain, at any depth, under any key name, in any value:

| Class | Examples |
|---|---|
| Provider identity | provider name, vendor, family-of-origin, upstream brand |
| Account identity | account ID, email, org ID, subscription ID, plan name, seat |
| Connection identity | connection ID, node ID, endpoint ID, base URL, hostname |
| Combo / routing | combo ID, strategy, weight, priority, lane, leg, failover order |
| Credential material | API keys, tokens, OAuth material, key IDs, key-group names, `Authorization` echoes |
| PAYG legs | billing leg identity, per-leg cost attribution, spend-account identity |
| Serving route | which route/account/connection actually served any given call |
| Deployment identity | deployment ID, tenant ID, instance ID, region, cluster, container name |

This is a **rejection** rule, not a redaction rule: the producer MUST construct the response
from an allowlist of known-safe fields rather than filtering a richer object. An unknown
field encountered in the upstream telemetry MUST be dropped, never passed through.

The same prohibition applies to producer **logs** and to any error string that reaches the
response. An error MUST be reported as a bounded reason code, not as a propagated upstream
message, because upstream messages routinely embed connection IDs and URLs.

### 2.3 Cardinality is itself an identity leak

The number of records MUST equal the number of distinct model IDs the producer was asked
about. It MUST NOT vary with the number of accounts, connections, or combo legs behind
them. A consumer that could count lanes by counting records would have recovered deployment
shape without being told it.

For the same reason the aggregate of N accounts MUST be a single scalar per window. A
producer MUST NOT emit per-account arrays, min/max pairs that reveal spread, or a count of
contributing sources.

## 3. Response shape

```jsonc
{
  "schemaVersion": 1,
  "observedAt": "2026-09-04T23:30:00.000Z",   // RFC3339 UTC, when state was observed
  "staleAfterSeconds": 300,                    // freshness budget for this snapshot
  "telemetry": "available",                    // "available" | "unavailable"
  "reasonCode": null,                          // bounded enum when unavailable
  "models": {
    "oc/claude-opus-5": {
      "serviceable": true,
      "utilization": 0.71,                     // [0,1] or null
      "remainingFraction": 0.29,               // 1 - utilization, or null
      "resetsAt": "2026-09-05T00:00:00.000Z",  // RFC3339 UTC, or null
      "resetInSeconds": 1800,                  // >= 0, or null
      "windows": [
        { "window": "five-hour", "utilization": 0.71,
          "resetsAt": "2026-09-05T00:00:00.000Z", "resetInSeconds": 1800 },
        { "window": "weekly", "utilization": 0.44,
          "resetsAt": "2026-09-08T00:00:00.000Z", "resetInSeconds": 288000 }
      ],
      "state": "degraded",                     // see §3.2
      "observationQuality": "measured"         // "measured" | "partial" | "absent"
    }
  }
}
```

### 3.1 Field rules

- `schemaVersion` — integer, currently `1`. A consumer MUST reject a version it does not
  implement rather than best-effort parse it.
- `observedAt` — when the underlying state was **observed**, not when the response was
  serialized. A producer serving from cache MUST report the observation time, so the
  consumer can judge staleness honestly.
- `staleAfterSeconds` — positive integer. Past `observedAt + staleAfterSeconds` a consumer
  MUST treat the snapshot as `unavailable`, regardless of what it says.
- `telemetry` — see §4.
- `models` — object keyed by exact model ID. **An empty object is a valid, meaningful
  answer** (see §4).
- `utilization` — fraction in `[0,1]`, the **most restrictive** window's utilization, or
  `null` when unmeasured. Values outside `[0,1]` MUST be rejected as `null`, not clamped;
  a producer emitting `1.7` is misreporting, and clamping would launder that into a
  plausible-looking `1.0`.
- `resetInSeconds` — MUST be `>= 0` and derived from `resetsAt` relative to `observedAt`.
  It is provided so a consumer need not trust its own clock against the producer's.
- `windows` — bounded array of per-window detail. Window names come from a closed
  vocabulary (§3.3); a window the producer cannot name MUST be omitted.

### 3.2 `state`

A closed enum, ordered from least to most restrictive:

| `state` | Meaning | `serviceable` |
|---|---|---|
| `available` | measured and comfortably below any limit | `true` |
| `degraded` | measured and near a limit; usable, prefer alternatives | `true` |
| `exhausted` | a limit is reached and no reset is imminent | `false` |
| `unavailable` | the model cannot currently be served at all | `false` |
| `unknown` | no usable measurement; state genuinely not known | `true` |

`serviceable` is derived from `state`, never independent of it. A record where the two
disagree is malformed and MUST be rejected by the consumer.

`unknown` MUST remain `serviceable: true`. Absence of evidence is not evidence of
exhaustion, and a producer outage must not silently take the whole fleet out of service.
Fail-closed behavior, if a deployment wants it, belongs in the consumer's enforce path
where it is a visible policy choice — not smuggled in through the producer's defaults.

**Exhausted vs. degraded near a reset.** A model at or above the exhaustion threshold whose
window resets within `resetGraceSeconds` (default 300) MUST report `degraded`, not
`exhausted`. A limit that clears in ninety seconds is not an outage, and reporting it as one
causes a consumer to shed load it could simply have waited for.

### 3.3 Window vocabulary

Closed set: `five-hour`, `daily`, `weekly`, `monthly`, `rolling`. A producer MUST map its
upstream's window naming into this vocabulary or omit the window. This exists so that a
window name cannot become a side channel for a provider's identity — "anthropic-5h" names
the vendor; `five-hour` does not.

### 3.4 Aggregating many sources into one record

When several accounts, connections or legs can serve a model, the producer MUST reduce them
to the **least restrictive** posture available, because that is what the deployment can
actually deliver: if any lane can serve the model, the model is serviceable.

- `state` — the minimum (least restrictive) state across contributing sources.
- `utilization` — the utilization of the source that produced that winning state, so
  utilization and state describe the same lane rather than being mixed from different ones.
- `resetsAt` — when `state` is `exhausted` or `unavailable`, the **earliest** reset across
  sources, since that is when capacity returns. Otherwise the reset of the winning source.
- `observationQuality` — `measured` if every contributing source was measured, `partial` if
  some were, `absent` if none were.

Within a single source, the **most restrictive** window wins: a lane at 40% weekly but 99%
five-hourly is constrained by the five-hour window.

## 4. Outage is not emptiness

A consumer MUST be able to distinguish these three conditions, and the response makes them
structurally distinct:

| Condition | `telemetry` | `models` | `reasonCode` |
|---|---|---|---|
| Working, some models have state | `available` | non-empty | `null` |
| Working, no model has state | `available` | `{}` | `null` |
| Producer could not observe | `unavailable` | `{}` | non-null |

The middle row is a **valid, trustworthy answer**: the deployment is healthy and reports
that it currently governs no models. The bottom row is a failure. Collapsing them — the
common bug, where an outage returns `{}` and reads as "nothing is constrained" — would let
a telemetry failure silently present as unlimited capacity. That is the single most
dangerous misread available in this design, and it is why `telemetry` is a required
top-level field rather than something inferred from `models`.

A producer that cannot observe MUST still return HTTP 200 with
`telemetry: "unavailable"`. Signalling outage by HTTP status is insufficient: a
transport-level failure is indistinguishable from a proxy error, and consumers already have
to handle both.

`reasonCode` is a closed enum — `upstream-unreachable`, `upstream-rejected-credential`,
`upstream-error`, `upstream-malformed`, `not-configured`, `stale` — chosen so that no
reason code can carry an identity. Producers MUST NOT extend it with free text.

## 5. Transport

The producer MUST expose an HTTP `GET` that is safe to call from `ctx.http.fetch`:

- **Method** `GET`, no request body, no side effects, idempotent.
- **Authentication** — the deployment MAY require a bearer credential. That credential
  authorizes *reading the sanitized snapshot* and MUST NOT be a management credential for
  the underlying telemetry. It MUST NOT appear in the response or in producer logs.
- **Response** `200 application/json` for every outcome described in §4, including outage.
- **Bounded body** — the producer MUST cap the response. Default cap: 256 KiB and 512 model
  records. On overflow it MUST truncate deterministically (model IDs sorted ascending) and
  set `telemetry: "unavailable"` with `reasonCode: "upstream-malformed"` rather than return
  a partial snapshot that reads as complete. A consumer MUST enforce the same cap on its
  own read and MUST NOT parse an unbounded body.
- **Freshness** — the producer SHOULD serve from a short cache and MUST report the true
  `observedAt`. It MUST NOT synchronously fan out to the upstream on every consumer read;
  the consumer's request rate is not the deployment's polling rate.
- **No query parameters affect identity.** A consumer MAY pass `?models=a,b` to narrow the
  set. The producer MUST NOT accept a parameter that selects by provider, account, or
  connection.

## 6. Consumer obligations

A conforming consumer:

1. MUST reject an unknown `schemaVersion`.
2. MUST treat `observedAt + staleAfterSeconds < now` as `unavailable`, and MUST NOT trust a
   snapshot merely because it parsed.
3. MUST NOT derive provider identity from a model ID. The ID is opaque; matching it against
   a provider table reintroduces exactly the coupling this contract removes.
4. MUST treat `unknown` as routable.
5. MUST distinguish §4's three conditions and act differently on the empty-but-healthy case
   than on the outage case.
6. MUST bound its own read (§5).

### 6.1 Required change to the staged Router v2 consumer

The consumer staged on `tog-943-usage-aware-router-v2` does **not** conform. Its
`CapacityLane` (`src/capacity/types.ts`) carries required `provider: string` and
`account: string`, and `bestLaneFor()` in `src/engine/select.ts` selects a lane by matching
`lane.provider` against the model's provider list. That is provider identity inside the
plugin, and it is the coupling §2 forbids.

Conforming requires re-keying the consumer from `(provider, account)` to `modelId`:
capacity becomes a direct lookup `models[model.id]` rather than a lane search, which also
removes `bestLaneFor` and the provider-matching helpers entirely. This is a simplification
of the consumer, not an addition to it. Tracked separately; it is not in scope for the
producer contract.

## 7. Conformance

`tests/model-usage-telemetry.spec.ts` is the executable form of this document. It asserts:

- normalization of representative live-shaped payloads into fresh records (§3);
- the exhausted case, the unavailable case, and the near-reset grace case (§3.2);
- reset-window arithmetic and the most-restrictive-window rule (§3.4);
- deep recursive absence of every forbidden field class in both response and log output,
  including against a payload deliberately seeded with credentials and connection IDs (§2);
- record cardinality independent of source cardinality (§2.3);
- outage distinguishable from a valid empty model set (§4);
- bounded body and staleness enforcement (§5).

A producer implementation is conforming when it satisfies that suite against its own
output. The reference normalizer in `src/telemetry/` is the shape those tests exercise; a
deployment MAY implement the producer in any language provided its responses pass.
