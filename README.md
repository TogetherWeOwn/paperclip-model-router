# Paperclip Model Router

A stock Paperclip plugin that performs one audited operation:

1. select an opaque model ID under company capability, quality, cost, and budget rules;
2. invoke the company's configured compatible upstream exactly once;
3. normalize the response into one protocol-neutral result;
4. append a company-scoped audit row to durable plugin storage.

The normative contract is [`docs/contracts/compatible-upstream-v1.md`](docs/contracts/compatible-upstream-v1.md).

## Native surfaces

- agent tool: `togetherweown.paperclip-model-router:model_router_invoke`
- actions: `invoke`, `refresh-capacity`, `query-decisions`
- `POST /api/plugins/togetherweown.paperclip-model-router/api/invoke?companyId=<uuid>`
- `POST /api/plugins/togetherweown.paperclip-model-router/api/issues/:issueId/invoke`

Every surface calls the same internal implementation. Company identity comes from the Paperclip host context, not caller input.

## Company configuration

```json
{
  "routing": {
    "enabled": true,
    "mode": "enforce",
    "fallbackModelId": null,
    "stickyModelWithinIssue": true,
    "maxOutputTokens": 16384
  },
  "upstream": {
    "protocol": "openai-chat-completions",
    "baseUrl": "https://compatible.example",
    "credentialSecretRef": {
      "type": "secret_ref",
      "secretId": "00000000-0000-4000-8000-000000000000"
    },
    "requestTimeoutMs": 25000,
    "maxResponseBytes": 8388608,
    "extraHeaders": {}
  },
  "models": [
    {
      "id": "model-id",
      "tier": "standard",
      "quality": 75,
      "costPerMTokIn": 1,
      "costPerMTokOut": 5,
      "contextWindow": 200000,
      "capabilities": ["tools", "structured-output"],
      "requestTimeoutMs": 180000,
      "enabled": true
    }
  ],
  "taskClasses": [{ "key": "implementation", "qualityFloor": 70 }],
  "tiering": {
    "signalWeights": {},
    "thresholds": { "small": 0, "standard": 30, "strong": 60, "frontier": 85 },
    "defaultTier": "standard"
  },
  "budget": {
    "monthlyCapUsd": 100,
    "warnFraction": 0.6,
    "downshiftFraction": 0.8,
    "haltFraction": 0.95
  },
  "capacityRouting": {
    "enabled": false,
    "mode": "shadow",
    "unknownTelemetry": "fail-open",
    "conserveUtilization": 0.6,
    "avoidUtilization": 0.8,
    "sources": []
  },
  "decisionLog": { "retentionDays": 90 },
  "rule0": { "enabled": true, "deterministicPatterns": [] }
}
```

`upstream.protocol` supports `openai-chat-completions` and `anthropic-messages`. The adapter appends `/v1/chat/completions` or `/v1/messages` and normalizes a duplicate terminal path to one copy.

Credentials are resolved at invocation time through `ctx.secrets.resolve` using the host-authorized company ID and config path. They are never placed in config, logs, state, errors, metrics, fixtures, or returned data.

### `capacityRouting` — usage-aware Router v2

Capacity routing is disabled by default and defaults to `shadow`. It consumes sanitized,
pre-inference evidence keyed to exact opaque model IDs. It does not choose or expose the
provider or account that serves inference. Run the company-scoped `refresh-capacity` action
to read telemetry and store a valid snapshot; canonical `invoke` reads that snapshot and
never performs a telemetry GET inline. Inference still makes exactly one upstream attempt.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Enables capacity-aware decisions from stored evidence. |
| `mode` | `"shadow"` \| `"enforce"` | `"shadow"` | Shadow records the alternative; enforce may choose another qualified model ID. |
| `unknownTelemetry` | `"fail-open"` \| `"exclude-lane"` \| `"fail-closed"` | `"fail-open"` | What **absent** evidence means under `enforce`. See below. |
| `conserveUtilization` | number 0–1 | `0.6` | Marks evidence for conservation. |
| `avoidUtilization` | number 0–1 | `0.8` | Prefers another quality-qualified model when possible. |
| `sources` | array | `[]` | Model IDs, sanitized lane-label fields, health/utilization mappings, and bounded read controls. |

Each source names exact `modelIds`, a public HTTPS status URL, optional Paperclip secret
reference, lane-label and health fields, utilization/reset windows, a 1–25 second timeout
(default 5 seconds), and a bounded response ceiling (default 256 KiB). Refresh issues one
host-managed GET per source with redirects refused and never overwrites a valid snapshot
on failure. Sources refresh concurrently with at most 4 in flight
(`REFRESH_CAPACITY_MAX_IN_FLIGHT` in `src/worker.ts`), so a fleet of up to 4 lanes
refreshes in roughly one source-time; secret resolution stays sequential in config order
and snapshots are reassembled in config order, so a single failing source keeps its
error while the healthy lanes keep their evidence.
Stored evidence contains only model ID, source ID, a sanitized lane label, health, posture,
utilization, and reset facts. It contains no credential, raw body, URL, provider, account, or
serving-identity claim.

#### `unknownTelemetry` — absence of a signal is not a signal (TOG-1040)

The three values differ only in how they treat **missing** evidence. All three treat evidence
that positively reports `unavailable`/`exhausted` identically: that model is never selected.

- **`fail-open` (default)** — losing capacity-awareness degrades routing quality, it does not
  deny service. A model with missing or unknown evidence sorts *last* but stays selectable, and
  a payload the router cannot parse falls through to the static routing policy. The decision
  carries `capacity.degraded: true` and a `WARNING` trace line, and the decision record carries
  `capacityDegraded: true`, so a telemetry outage is loud without being fatal.
- **`exclude-lane`** — drop uncovered models, refuse only if none remain.
- **`fail-closed`** — refuse the whole decision if telemetry is unavailable, or if *any*
  qualified model is uncovered. This denies service during a telemetry outage; it is now
  strictly opt-in. It was the default up to v0.4.1 and caused the TOG-1040 incident.

Promotion to `enforce` is an operator decision, never an automatic gate. Before changing it,
require TOG-901/916 evidence, TOG-251 measurements, fresh evidence for every affected model,
a clean representative shadow window, and an outage rehearsal proving fail-closed behavior.
Disable `capacityRouting` to restore v1 selection exactly.

### `decisionLog` — routing-history retention and read path (TOG-7897)

Every invocation appends a company-scoped audit row to durable storage. One
optional setting governs history visibility:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `retentionDays` | integer 1–3650 | `90` | The company's visible routing-history window, in days. Physical deletion also preserves the current UTC accounting month. |

Omitting `decisionLog` or supplying `decisionLog: {}` defaults to 90 days.
Malformed explicit values are rejected, including in stored configuration.

**Physical-retention exception:** `decision_records` also feeds monthly spend-cap
enforcement. Deletion therefore uses the **earlier** of the configured history
cutoff and the current UTC month start, unconditionally — even if caps are
currently disabled. Current-month accounting rows outside a short history window
remain stored but are not returned by `query-decisions`. After the month rolls
over, those rows can be deleted once they are also outside the history window.
Legacy import applies the same floor and reconciles before the monthly ledger read.

Each write prunes that company's own rows using this cutoff. Startup enumerates
persisted company IDs from `decision_records` and applies their individual policies;
there is no whole-table default DELETE or writer-state-index dependency. If policy
cannot be read or resolved, pruning is skipped and legacy reconciliation is deferred
without marking it complete. A later write or worker restart retries after recovery.
A successfully read absent policy, unlike an unavailable policy, uses the default.

Run the company-scoped `query-decisions` action to inspect recent routing
history:

```sh
npx paperclipai plugin action "$PLUGIN" query-decisions \
  --payload-json "$(jq -nc --arg companyId "$COMPANY_ID" '{companyId:$companyId,params:{limit:50}}')"
```

The company id comes from the host-authorized action context, never from
params, so a caller only ever sees its own company's rows. The window start
is derived from that company's `retentionDays`, and the row limit is clamped
to 1–200 newest-first. Returned records carry the same fields as the stored
row (selection, model, outcome, latency, token usage, capacity facts) and
never prompts, credentials, or request content.

## Invocation

```json
{
  "task": {
    "taskClass": "implementation",
    "summary": "Implement the requested change",
    "requiredCapabilities": ["tools"],
    "estimatedInputTokens": 8000,
    "estimatedOutputTokens": 2000
  },
  "system": "Optional system instruction",
  "messages": [{ "role": "user", "content": "Do the work." }],
  "maxOutputTokens": 4096,
  "toolChoice": "auto"
}
```

The request cannot override the selected model, compatible protocol, base URL, credential, headers, or streaming behavior. Streaming is not part of v1.

## Transport guarantees

- inference networking uses only Paperclip's published `ctx.http.fetch` boundary;
- redirects are not followed;
- `Accept-Encoding: identity` is always sent;
- exactly one upstream HTTP attempt is made;
- transport failures never trigger a new model selection or automatic replay;
- upstream status codes remain inside the normalized result rather than becoming the outer route status;
- response bodies are measured after the stock host returns its buffered response;
- caller-visible timeout is bounded by company configuration and does not start a replacement request.

### Response media and encoding failures

Both invocation paths require JSON response media and absent, empty, or `identity`
`Content-Encoding`. A refusal returns `invalid-upstream-response` with a fixed
message distinguishing **JSON media** from **non-identity encoding**; when both
headers violate the contract, media is reported first. No upstream header value
or response body is copied into the error. Older builds combined these cases as
“did not return an uncompressed JSON response”; that message alone cannot identify
which header failed.

Async uses native worker `fetch`, while sync uses the host-buffered SDK response.
Native fetch can decode a compressed body while retaining its encoding header;
this does **not** make the response acceptable. The router still requests
`Accept-Encoding: identity` and refuses non-identity encoding rather than adding
a decompression or content-sniffing fallback. An accepted media/encoding pair
must also pass the configured UTF-8 byte limit, JSON parsing, and protocol-envelope
validation. A successfully accepted empty model completion is distinct from an
empty HTTP body, which is invalid JSON.

### Timeouts, and reasoning models

One upstream attempt is made and there is no retry, so a timeout is a discarded
generation rather than a delayed one — the upstream usually finishes the work and
bills for it after the router has stopped listening.

`upstream.requestTimeoutMs` defaults to **25s** and may be raised to **300s**. Set
`models[].requestTimeoutMs` to give one model its own budget; it overrides the
upstream value whenever that model is selected, and is omitted to inherit. Prefer
the per-model form: a reasoning model needs minutes, and lifting the shared ceiling
to suit it also stops every fast model from failing fast.

A reasoning model may also spend its entire output budget on hidden thinking tokens
and return a valid success carrying nothing readable. That is reported as a normal
completion with `stopReason: "max-tokens"` and an **empty `content` array**, so a
caller must not assume a completed result has at least one content block. A
`refusal` or `content-filter` stop reason is preserved rather than rewritten.

### Sync throughput baseline, per model class

The synchronous `/invoke` preflight rejects a `maxOutputTokens` that cannot
finish inside `min(model.requestTimeoutMs ?? upstream.requestTimeoutMs, 28s)`
at the model's throughput rate — before any credential resolution or upstream
call. The rate comes from a per-class table (`syncThroughputClass` on the
model entry); an explicit `maxSyncOutputTokens` always wins over the table.

| class | rate | provenance |
|---|---|---|
| `chat` (default) | 1200 tok / 28s (~43 tok/s) | Measured: glm-5.3-flash, TOG-1035 |
| `reasoning` | 600 tok / 28s (~21 tok/s) | Uncalibrated conservative estimate: half the chat row |

A model without `syncThroughputClass` uses the `chat` row, so existing
configs keep exactly the budget they already had. Set `reasoning` on models
that spend wall-clock on hidden thinking tokens — a chat-derived ceiling
would over-admit them into sync and risk a discarded generation. The
reasoning row is deliberately conservative (it steers toward async) until a
production measurement replaces it; operators with measured numbers for
their own models should set `maxSyncOutputTokens` explicitly.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run verify:host
npm run rehearse
```

`npm run verify:host` runs the built manifest through Paperclip's install-time validators. `npm run rehearse` loads the built worker once, invokes two isolated sync company configurations through different compatible protocols, and submits an async invocation (submit → poll) plus a run-end cancel on a third.

Licensed under the [MIT License](./LICENSE). No install or release is performed by the build or test commands.
