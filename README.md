# Paperclip Model Router

A stock Paperclip plugin that performs one audited operation:

1. select an opaque model ID under company capability, quality, cost, and budget rules;
2. invoke the company's configured compatible upstream exactly once;
3. normalize the response into one protocol-neutral result;
4. record a bounded company-scoped audit row.

The normative contract is [`docs/contracts/compatible-upstream-v1.md`](docs/contracts/compatible-upstream-v1.md).

## Native surfaces

- agent tool: `togetherweown.paperclip-model-router:model_router_invoke`
- action: `invoke`
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
  "rule0": { "enabled": true, "deterministicPatterns": [] }
}
```

`upstream.protocol` supports `openai-chat-completions` and `anthropic-messages`. The adapter appends `/v1/chat/completions` or `/v1/messages` and normalizes a duplicate terminal path to one copy.

Credentials are resolved at invocation time through `ctx.secrets.resolve` using the host-authorized company ID and config path. They are never placed in config, logs, state, errors, metrics, fixtures, or returned data.

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
