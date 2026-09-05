# Paperclip Model Router

A stock Paperclip plugin that performs one audited operation:

1. select an opaque model ID under company capability, quality, cost, and budget rules;
2. invoke the company's configured compatible upstream exactly once;
3. normalize the response into one protocol-neutral result;
4. record a bounded company-scoped audit row.

The normative contract is [`docs/contracts/compatible-upstream-v1.md`](docs/contracts/compatible-upstream-v1.md).

## Native surfaces

- agent tool: `togetherweown.paperclip-model-router:model_router_invoke`
- actions: `invoke`, `refresh-capacity`
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
    "unknownTelemetry": "fail-closed",
    "conserveUtilization": 0.6,
    "avoidUtilization": 0.8,
    "sources": []
  },
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
| `unknownTelemetry` | `"fail-closed"` \| `"exclude-lane"` | `"fail-closed"` | Enforcement refuses when required evidence is absent or unknown, or excludes uncovered models. |
| `conserveUtilization` | number 0–1 | `0.6` | Marks evidence for conservation. |
| `avoidUtilization` | number 0–1 | `0.8` | Prefers another quality-qualified model when possible. |
| `sources` | array | `[]` | Model IDs, sanitized lane-label fields, health/utilization mappings, and bounded read controls. |

Each source names exact `modelIds`, a public HTTPS status URL, optional Paperclip secret
reference, lane-label and health fields, utilization/reset windows, a 1–25 second timeout
(default 5 seconds), and a bounded response ceiling (default 256 KiB). Refresh uses one
host-managed GET with redirects refused and never overwrites a valid snapshot on failure.
Stored evidence contains only model ID, source ID, a sanitized lane label, health, posture,
utilization, and reset facts. It contains no credential, raw body, URL, provider, account, or
serving-identity claim.

Promotion to `enforce` is an operator decision, never an automatic gate. Before changing it,
require TOG-901/916 evidence, TOG-251 measurements, fresh evidence for every affected model,
a clean representative shadow window, and an outage rehearsal proving fail-closed behavior.
Disable `capacityRouting` to restore v1 selection exactly.

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

## Development

```sh
npm run typecheck
npm test
npm run build
npm run verify:host
npm run rehearse
```

`npm run verify:host` runs the built manifest through Paperclip's install-time validators. `npm run rehearse` loads the built worker once and invokes two isolated company configurations through different compatible protocols.

This repository is private and unlicensed for public distribution. No install or release is performed by the build or test commands.
