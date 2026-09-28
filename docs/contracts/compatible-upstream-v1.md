# Model Router compatible-upstream contract v1

- Status: accepted for implementation
- Date: 2026-08-26
- Owner: Chief Product Officer
- Downstream implementation: TOG-532
- Independent verification: TOG-533
- Paperclip plugin API: v1

This is the normative product contract for the replacement Model Router. It defines what callers can invoke, what the plugin sends to a configured upstream, what it returns, and which failures may change the selected model. Exact-wire tests must derive their assertions from this document.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. User outcome and boundary

The user is a Paperclip company that wants one native plugin to choose a suitable model and obtain an inference result from either an OpenAI-compatible or an Anthropic-compatible endpoint, without provider-specific policy in Paperclip.

The request path has three layers:

1. **Selection** chooses an opaque model ID under Rule 0, hard capability/context constraints, quality, cost, and company budget policy.
2. **Protocol adaptation** encodes that model and the caller's conversation onto one of the two compatible HTTP profiles below, then decodes the response.
3. **Deployment routing** decides which provider, account, subscription, combo, or PAYG leg serves that model. This belongs to the configured upstream and is outside this plugin.

The plugin MUST NOT infer, choose, expose, or fall back between the configured compatible upstream's deployment providers or accounts. The sole Router v2 exception is sanitized model-usage evidence: a separately refreshed snapshot may associate health, utilization, reset, source ID, and a non-secret lane label with an exact opaque model ID before selection. This evidence may rank only models that cleared all ordinary gates. It MUST NOT be represented as deployment or serving identity, and it never adds an inference attempt.

## 2. Native Paperclip shape

The replacement remains a stock Paperclip plugin with manifest `apiVersion: 1`.

- There is one instance-level install and one worker process.
- The plugin definition MUST set `multiCompanyConfig: true`; every in-memory cache or accumulator MUST be keyed by the host-authorized company ID.
- Configuration and secret resolution are company-scoped. Company-bound state and decision records MUST use `scopeKind: "company"` with `scopeId` equal to the host-authorized company ID; caller-supplied issue/project/agent IDs are not tenant boundaries.
- The published `ctx.metrics.write` surface is instance-scoped. Per-company counters MUST live in company-scoped state; native metrics MAY contain only aggregate, non-content measurements that reveal no company identity.
- Runtime may use only published Paperclip SDK surfaces: manifest/config/state/secrets/http/tools/actions/routes/logging/metrics.
- Runtime MUST NOT require a Paperclip source patch, fork, migration, copied server file, or private `/app` dependency.
- Inference networking MUST use `ctx.http.fetch`. Direct Node `fetch`, `http`, `https`, sockets, or third-party HTTP clients are prohibited and MUST be rejected by source and packed-artifact tests; the SDK does not sandbox those bypasses automatically. The single exception is the async background upstream call (section 10), which uses the worker's own `fetch` to escape the host's 30-second bridge cap under the same SSRF posture; source and packed-artifact tests MUST reject every other direct-networking path.
- The plugin MUST use host-authorized company context. A caller-supplied `companyId` MUST NOT override `ToolRunContext.companyId`, `PluginPerformActionContext.companyId`, or `PluginApiRequestInput.companyId`.

### 2.1 Invocation surface

The canonical operation is named `invoke`. Every native surface MUST call the same internal `select -> invoke -> normalize -> record` function; no surface may implement a second routing or transport path.

The implementation MUST expose:

- agent tool bare manifest/registration name: `model_router_invoke`; the exact agent-visible stock name is `togetherweown.paperclip-model-router:model_router_invoke`
- action registration key: `invoke`; the worker handler returns `InferenceResult`, while stock HTTP action bridges wrap it as `{ "data": <InferenceResult> }`
- company-scoped route: `POST /api/plugins/togetherweown.paperclip-model-router/api/invoke?companyId=<uuid>`; the manifest MUST declare host-side company resolution from the query key, and the handler MUST trust only `PluginApiRequestInput.companyId` after that authorization
- issue-scoped convenience route: `POST /api/plugins/togetherweown.paperclip-model-router/api/issues/:issueId/invoke`; the manifest MUST declare host-side company resolution from the issue parameter

The tool returns native `ToolResult`:

```ts
{ content: string, data: InferenceResult }
{ error: string }
```

Every expected selection or upstream outcome, including `outcome: "error"`, uses the success form with a short bounded `content` summary and the complete structured result in `data`. The `ToolResult.error` form is reserved for a malformed invocation that prevents construction of an `InferenceResult` or an unavailable worker.

The async submit/poll surfaces (tools `model_router_invoke_async` / `model_router_invoke_result`, actions `invoke-async` / `invoke-result` / `cancel-run-invocations`, routes `POST /invoke-async` and `GET /invoke/:requestId`, job `reconcile-async-invocations`) are defined normatively in section 10. They share the same canonical request validator and selection policy as this section; their submit envelope, poll envelope, and route statuses differ as stated there (notably HTTP 202 for an accepted async submission).

The action returns `InferenceResult`. Expected operation failures return an `InferenceResult` with `outcome: "error"`; malformed native invocation parameters MAY be rejected by the Paperclip bridge before the handler runs.

The route handler returns:

- HTTP 200 with an `InferenceResult` for every operation it completes, including upstream HTTP failures and selection refusals;
- HTTP 400 when the handler cannot parse or validate the native request;
- HTTP 503 when the handler runs but its worker state is not initialized.

The stock host may reject or fail outside the handler envelope: authentication/authorization/checkout failures may produce 401, 403, or 409; missing plugin/route/capability may produce 404; oversized or wrong-content-type requests may produce 413 or 415; unavailable route support may produce 501; worker RPC failure or timeout may produce 502; and other host failures may produce 500. Callers MUST distinguish these host-level failures from an HTTP 200 `InferenceResult`.

Upstream status codes MUST NOT become the scoped route's outer HTTP status. They remain in the normalized `InferenceError`, so completed handler operations use one stable Paperclip API contract.

### 2.2 Canonical request

```ts
interface InvokeRequest {
  task: {
    taskClass?: string;
    summary?: string;
    issueId?: string;
    requiredCapabilities?: Array<
      "tools" | "structured-output" | "vision" | "long-context" | "computer-use"
    >;
    requiredContextTokens?: number;
    signals?: Record<string, number>;
    pinnedModelId?: string;
    pinReason?: string;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
  };

  messages: Message[];
  system?: string;
  maxOutputTokens: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  metadata?: Record<string, string>;
}

interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
```

Contract rules:

- Every surface MUST run the same router-owned runtime validator; tool/action bridges are not assumed to enforce the manifest schema.
- `messages` MUST contain at least one item.
- `maxOutputTokens` MUST be an integer from 1 through the configured company maximum.
- The scoped route body MUST fit stock Paperclip's 1,000,000-byte serialized JSON ceiling; tool and action bridges remain subject to the host's general body/message ceilings.
- The v1 canonical request has no provider, account, connection, combo, PAYG, quota-lane, API-key, base-URL, or protocol override.
- Unknown top-level fields MUST be rejected. Unknown fields inside `metadata` MAY be preserved as opaque strings.
- The selected model always replaces any model-like value supplied through an untyped bridge. Callers cannot smuggle an upstream `model` override.
- A `role: "tool"` message requires `toolCallId`.
- A `tool_result` block requires `toolCallId`.
- Tool arguments are structured JSON values, not serialized strings, at this boundary.
- `image_url` support is conditional on the selected model clearing the `vision` capability gate. v1 does not accept inline base64 images, documents, audio, files, citations, provider-native thinking blocks, or provider-native server tools.

## 3. Per-company upstream configuration

```ts
interface CompatibleUpstreamConfig {
  protocol: "openai-chat-completions" | "anthropic-messages";
  baseUrl: string;
  credentialSecretRef: SecretRef;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  extraHeaders?: Record<string, string>;
}

interface SecretRef {
  type: "secret_ref";
  secretId: string; // UUID
  version?: "latest" | number; // positive integer
  projectionClass?: "unclassified" | "class_3_static_lease";
  projectionAllowlistKey?: string | null;
}
```

Required bounds:

| Field | Minimum | Maximum | Default |
| --- | ---: | ---: | ---: |
| `requestTimeoutMs` | 1,000 | 300,000 | 25,000 |
| `maxResponseBytes` | 1,024 | 16,777,216 | 8,388,608 |

Configuration rules:

- `baseUrl` MUST be an absolute `https:` URL, with no username, password, query, or fragment.
- Persisted config accepts only `https:`. Unit tests MAY exercise `http:` through an injected/mock HTTP boundary; literal loopback is unconditionally rejected by stock `ctx.http.fetch` and is not a live integration target.
- The adapter appends its fixed protocol path to `baseUrl`: `/v1/chat/completions` or `/v1/messages`. A configured path prefix is allowed; a duplicate terminal protocol path MUST be normalized to one copy.
- The final URL MUST pass both router validation and the host-managed HTTP boundary for every request. Stock HTTP resolves and pins an accepted address while filtering private/reserved results, but it is not a complete domain allowlist or process sandbox. This contract's HTTPS/no-userinfo/no-query rules and prohibition on direct networking are additional required controls.
- `extraHeaders` MUST reject `authorization`, `proxy-authorization`, `x-api-key`, `content-length`, `host`, `connection`, `transfer-encoding`, `cookie`, and `accept-encoding`, case-insensitively. The adapter itself always sets `Accept-Encoding: identity`.
- Header values MUST be single strings without CR or LF.
- The resolved credential is placed only in the protocol's auth header. It MUST NOT be accepted in `baseUrl`, `extraHeaders`, request content, logs, metrics, state, errors, traces, fixtures, or returned data.
- Secret references MUST use the exact closed object above. Raw strings and extra fields are invalid.
- The secret MUST be resolved at call time with both the host-authorized company ID and the config path. It MUST NOT be cached. Stock Paperclip currently limits plugin secret resolution to 30 calls per minute per company/plugin; v1 therefore exposes that as an effective per-company inference ceiling rather than weakening call-time resolution.

## 4. Selection contract

Selection remains protocol-neutral and precedes HTTP.

1. When Rule 0 matches, the result is `no-model-needed`; the plugin MUST make no upstream request.
2. Otherwise, selection applies required capabilities and context, company deployment constraints that are genuinely model-level, the quality floor, the budget-derived tier ceiling, and expected cost.
3. Cost never compensates for missing capability or quality.
4. The output is an opaque `modelId` or `no-eligible-model`.
5. An explicit pin is audited and follows the selection policy defined by the engine contract.

`protocol`, `baseUrl`, headers, credentials, upstream status, and serving-provider/account identity MUST NOT affect which model is selected. The same task, model table, and stored model-usage evidence MUST select the same model under both upstream protocols. Optional Router v2 evidence is refreshed separately, keyed to exact opaque model IDs, and may rank only eligible models; it is neither deployment routing nor a transport retry.

### 4.1 Model fallback versus transport failure

A **model fallback** is a second model-selection outcome, not a provider retry. v1 uses the following rule:

- The selection engine MAY choose a configured protocol-neutral fallback model only before HTTP and only under its documented model-level eligibility rules.
- Once an upstream request has been attempted, the selected model is fixed for that operation.
- The plugin MUST NOT select another model because of DNS failure, connection failure, timeout, redirect, 408, 409, 429, 5xx, malformed upstream JSON, or an empty response.
- The plugin MUST perform exactly one upstream HTTP attempt per operation and MUST NOT replay an inference request automatically. A replay can duplicate tool calls or other model side effects and has no portable idempotency guarantee. Automatic retry behavior in an HTTP library or host bridge MUST be disabled for this call.
- The caller MAY submit a new operation after inspecting `error.retryable`. That new operation is independently audited.

The configured upstream MAY perform provider/account/PAYG failover behind the same model ID. That behavior is opaque to the plugin.

## 5. OpenAI-compatible profile

### 5.1 Request wire

```http
POST {baseUrl}/v1/chat/completions
Authorization: Bearer <resolved secret>
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
```

```json
{
  "model": "<selected opaque model id>",
  "messages": [],
  "max_tokens": 4096,
  "stream": false,
  "stop": ["optional"],
  "tools": [],
  "tool_choice": "auto",
  "metadata": {}
}
```

Exact mapping:

- `system` becomes the first `{ "role": "system", "content": system }` message.
- Canonical `user` and `assistant` text become same-role string-content messages.
- `image_url` becomes `{ "type": "image_url", "image_url": { "url": url } }` in a message content array.
- An assistant `tool_call` becomes `message.tool_calls[]` with `type: "function"`, the same `id` and `name`, and `function.arguments = JSON.stringify(arguments)`.
- A canonical `tool` message or `tool_result` block becomes `{ "role": "tool", "tool_call_id": toolCallId, "content": content }`.
- Tools become `{ "type": "function", "function": { "name", "description", "parameters": inputSchema } }`.
- `toolChoice` maps to `"auto"`, `"none"`, `"required"`, or `{ "type": "function", "function": { "name" } }`.
- Omit `stop`, `tools`, `tool_choice`, and `metadata` when absent. Do not send explicit `null`.
- The adapter MUST send no provider-specific extension fields.

### 5.2 Accepted success wire

A 2xx response is successful only when it is JSON with:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 0,
  "model": "...",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "text or null",
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": { "name": "tool_name", "arguments": "{\"x\":1}" }
          }
        ]
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1,
    "completion_tokens": 1,
    "total_tokens": 2
  }
}
```

Rules:

- `choices` MUST contain exactly one item with `index: 0` in v1. Zero or multiple choices are an invalid upstream response.
- The assistant message MUST contain non-empty text, at least one valid function tool call, or both.
- Each `function.arguments` MUST parse as a JSON object. Parse failure is an invalid upstream response; the raw argument string MUST NOT be passed to a tool.
- `finish_reason` values `stop`, `length`, `tool_calls`, and `content_filter` are recognized. `null` or unknown values normalize to `other` without failing an otherwise valid response.
- `usage` is optional. When present, token counts MUST be non-negative integers.
- Extra response fields are ignored.

## 6. Anthropic-compatible profile

### 6.1 Request wire

```http
POST {baseUrl}/v1/messages
x-api-key: <resolved secret>
anthropic-version: 2023-06-01
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
```

```json
{
  "model": "<selected opaque model id>",
  "max_tokens": 4096,
  "messages": [],
  "stream": false,
  "system": "optional",
  "stop_sequences": ["optional"],
  "tools": [],
  "tool_choice": { "type": "auto" },
  "metadata": {}
}
```

Exact mapping:

- `system` remains the top-level `system` string.
- Canonical `user` and `assistant` text become same-role messages with Anthropic text blocks.
- `image_url` is not representable in the conservative v1 Anthropic profile and MUST be rejected before HTTP. A later contract may add Anthropic image source variants.
- An assistant `tool_call` becomes `{ "type": "tool_use", "id", "name", "input": arguments }`.
- Canonical tool results are user content blocks: `{ "type": "tool_result", "tool_use_id": toolCallId, "content", "is_error": boolean }`.
- Tools become `{ "name", "description", "input_schema": inputSchema }`.
- `toolChoice` maps to `{ "type": "auto" }`, `{ "type": "none" }`, `{ "type": "any" }`, or `{ "type": "tool", "name" }`.
- `metadata` is omitted in v1 because arbitrary metadata is not a portable Anthropic Messages field.
- Omit absent optional fields; do not send explicit `null`.
- The adapter MUST send no beta header and no provider-specific extension fields.

### 6.2 Accepted success wire

A 2xx response is successful only when it is JSON with:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "toolu_...", "name": "tool_name", "input": { "x": 1 } }
  ],
  "model": "...",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 1, "output_tokens": 1 }
}
```

Rules:

- `type` MUST equal `message` and `role` MUST equal `assistant`.
- `content` MUST be an array containing at least one non-empty text or valid `tool_use` block.
- v1 recognizes text and `tool_use`. Unknown content block types are ignored; if nothing recognized remains, the response is invalid.
- `tool_use.input` MUST be a JSON object.
- Recognized stop reasons are `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, and `refusal`. Unknown or absent values normalize to `other`.
- `usage` is optional. When present, token counts MUST be non-negative integers.
- Extra response fields are ignored.

## 7. Normalized result

```ts
type InferenceResult =
  | {
      outcome: "no-model-needed";
      requestId: string;
      decision: RoutingDecision;
      response: null;
      error: null;
    }
  | {
      outcome: "no-eligible-model" | "disabled";
      requestId: string;
      decision: RoutingDecision;
      response: null;
      error: null;
    }
  | {
      outcome: "completed";
      requestId: string;
      decision: RoutingDecision;
      response: NormalizedResponse;
      error: null;
    }
  | {
      outcome: "error";
      requestId: string;
      decision: RoutingDecision | null;
      response: null;
      error: InferenceError;
    };

interface NormalizedResponse {
  id: string | null;
  modelId: string; // selected model, not blindly trusted upstream echo
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  stopReason: "end-turn" | "max-tokens" | "stop-sequence" | "tool-use" | "refusal" | "content-filter" | "other";
  stopSequence: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  upstream: {
    protocol: "openai-chat-completions" | "anthropic-messages";
    requestId: string | null;
    responseModelId: string | null;
  };
}
```

Stop mapping:

| OpenAI `finish_reason` | Anthropic `stop_reason` | Normalized |
| --- | --- | --- |
| `stop` | `end_turn` | `end-turn` |
| `length` | `max_tokens` | `max-tokens` |
| — | `stop_sequence` | `stop-sequence` |
| `tool_calls` | `tool_use` | `tool-use` |
| — | `refusal` | `refusal` |
| `content_filter` | — | `content-filter` |
| other/null | other/null | `other` |

The normalized output MUST NOT claim which provider or account served the request. `responseModelId` is an opaque upstream echo for diagnostics and MUST NOT change the selected `modelId` or future routing policy.

## 8. Errors

```ts
type InferenceErrorCode =
  | "invalid-request"
  | "secret-unavailable"
  | "upstream-url-rejected"
  | "upstream-redirect"
  | "upstream-connect"
  | "upstream-timeout"
  | "upstream-response-too-large"
  | "upstream-authentication"
  | "upstream-permission"
  | "upstream-not-found"
  | "upstream-conflict"
  | "upstream-rate-limit"
  | "upstream-client-error"
  | "upstream-server-error"
  | "upstream-overloaded"
  | "invalid-upstream-response"
  | "invocation-cancelled";

interface InferenceError {
  code: InferenceErrorCode;
  message: string;
  retryable: boolean;
  upstreamStatus: number | null;
  upstreamRequestId: string | null;
}
```

Error rules:

- Error messages MUST be router-authored, bounded, and credential-free. They MUST NOT copy an upstream body, URL query, authorization header, or resolved secret.
- The adapter MAY parse an upstream error body only to classify it. It MUST NOT return the upstream message verbatim.
- OpenAI-compatible error parsing accepts `{ "error": { "message", "type", "code" } }` when present.
- Anthropic-compatible error parsing accepts `{ "type": "error", "error": { "type", "message" }, "request_id" }` when present.
- Capture upstream request IDs from `x-request-id`, `request-id`, or Anthropic error `request_id`, in that precedence order. IDs are opaque, bounded diagnostic strings.
- 401 -> `upstream-authentication`, non-retryable.
- 403 -> `upstream-permission`, non-retryable.
- 404 -> `upstream-not-found`, non-retryable.
- 408 -> `upstream-timeout`, retryable.
- 409 -> `upstream-conflict`, retryable for a new caller-submitted operation; never automatically replayed.
- 429 -> `upstream-rate-limit`, retryable unless the caller has separate evidence of a durable quota/spend cap.
- Other 4xx -> `upstream-client-error`, non-retryable.
- 500-528 and 530-599 -> `upstream-server-error`, retryable.
- 529 -> `upstream-overloaded`, retryable.
- A network or DNS failure before headers -> `upstream-connect`, retryable.
- If the plugin's caller-visible timer reaches `requestTimeoutMs`, the operation returns `upstream-timeout`, retryable. On the synchronous path, stock `ctx.http.fetch` does not serialize an abort signal, so the host request may continue in cleanup until the stock 30-second host timeout; no second operation is started by the plugin. (The async bound is the selected model's effective timeout in section 10.2.)
- A 2xx response with invalid JSON or invalid required fields -> `invalid-upstream-response`, non-retryable until the upstream is fixed.
- A run-end reap aborting an async invocation in flight (TOG-7417) -> `invocation-cancelled`, non-retryable. Never produced by the transport itself; the transport reports an abort as `invocation-cancelled` only when its caller-supplied abort signal fired, and the reap settles the pending row to the same code. Retry logic MUST NOT replay a cancelled run: the host declared it finished.
- After stock `ctx.http.fetch` returns its buffered body, the adapter measures its UTF-8 byte length. Exceeding `maxResponseBytes` -> `upstream-response-too-large`, non-retryable for the same configuration. This is a caller-visible acceptance bound, not an early network-read bound: stock v1 may buffer up to its host ceiling before the plugin can reject it.

`retryable` tells the caller whether a new operation may succeed. It never authorizes an automatic plugin replay or model change.

## 9. Streaming decision

Streaming is **out of v1**.

The plugin MUST send `stream: false` to both upstream profiles and return one normalized result after the complete upstream body is available. It MUST reject any native `stream` parameter rather than ignore it.

Reason: stock Paperclip plugin tools, actions, and scoped routes are JSON request/response surfaces, and the published host-managed HTTP bridge used for outbound requests buffers the upstream body. Paperclip also publishes worker-to-UI channels through `ctx.streams`, but that is a separate authorized delivery surface and does not make `ctx.http.fetch` an incremental SSE client. v1 deliberately avoids a second event contract. A later version may combine a published incremental outbound transport with `ctx.streams`, but only after it defines upstream SSE consumption, normalized event ordering, reconnect/error semantics, cancellation, and caller authorization.

Because v1 is non-streaming and the stock worker/HTTP ceilings are bounded, the synchronous path works inside a 28-second budget ceiling, below the host's 30-second boundary. Stock v1 exposes no separately configurable TCP/TLS connect timeout: DNS lookup has its own host-controlled ceiling and the total host request remains capped at 30 seconds. Generations that cannot complete inside the synchronous budget are served by asynchronous invocation (section 10), not by streaming.

## 10. Asynchronous invocation (submit + poll)

The synchronous `invoke` path of sections 2–8 completes inside the host RPC
round trip. The async path serves generations that cannot: submit returns a
pending receipt immediately while one background upstream attempt runs, and the
caller polls for the terminal outcome. Async shares the canonical request
validator, selection policy, protocol adapters, normalization, error taxonomy,
and audit rules with the sync path; only the envelope, timing, transport
bound, retention, and run-end cancellation below differ.

### 10.1 Surfaces and envelopes

The implementation MUST expose:

- agent tools `model_router_invoke_async` (submit; same canonical request
  schema as `model_router_invoke`) and `model_router_invoke_result` (poll;
  `{ "requestId": string }` — a missing or empty value reads `not-found`);
- action registration keys `invoke-async` (submit), `invoke-result` (poll),
  and `cancel-run-invocations` (run-end reap; `runId` is required and a
  missing/empty value is a handler error, never a silent no-op);
- company-scoped route `POST /api/plugins/togetherweown.paperclip-model-router/api/invoke-async?companyId=<uuid>`
  with the same host-side company resolution as the sync route, and
  `GET /api/plugins/togetherweown.paperclip-model-router/api/invoke/:requestId?companyId=<uuid>`;
- scheduled job `reconcile-async-invocations`, every minute. The host tears
  down a plugin's invocation scope the instant it receives the worker's RPC
  response, so the background continuation that outlives the submit response
  usually cannot persist through scoped `ctx.state`/`ctx.db` calls. The
  continuation therefore caches its terminal outcome and audit record
  in memory (where polling reads them immediately), and the job — whose
  dispatch carries no invocation id and runs under the ordinary proactive
  per-company scope — flushes both to durable state. The job persists
  outcomes and audit records; it MUST NOT issue upstream requests.

Submit returns one of:

```ts
{ status: "pending"; requestId: string; decision: RoutingDecision }
| InferenceResult  // early exit: no pending row exists
```

- `requestId` is a router-generated UUID identifying the operation.
- `decision` is the full selection decision, identical in shape to the
  `decision` the same request would receive on the sync path.
- Early exits return `InferenceResult` directly with no pending row: Rule 0,
  `no-eligible-model`/`disabled`, invalid request, invalid upstream
  configuration, and unavailable credentials all resolve at submit time and
  are audited exactly like their sync equivalents.

Poll returns one of:

```ts
{ status: "pending"; requestId: string; decision: RoutingDecision;
  startedAt: string; expiresAt: string; runId: string | null; agentId: string | null }
| { status: "completed" | "error"; requestId: string; decision: RoutingDecision;
    outcome: "completed" | "error"; response: NormalizedResponse | null; error: InferenceError | null;
    startedAt: string; expiresAt: string; runId: string | null; agentId: string | null }
| { status: "not-found" }
```

- A terminal poll record carries the complete sync `InferenceResult`
  envelope plus only these async keys: `status`, `startedAt`, `expiresAt`,
  `runId`, `agentId`. `status` MUST mirror the wrapped `outcome`.
- `startedAt`/`expiresAt` are ISO-8601 timestamps bounding pollability
  (section 10.3). `runId`/`agentId` record the submitting run and agent;
  rows written before run tracking existed read them as null.
- `not-found` means no live row exists for that `requestId`: unknown, never
  submitted, already expired (section 10.3), or belonging to another company.
  Pending rows are company-scoped; a poll MUST NOT distinguish "another
  company's row" from "no such row".

Route statuses:

- `POST .../invoke-async` returns HTTP 202 with the pending receipt for an
  accepted submission; HTTP 400 when submit resolves to an `invalid-request`
  `InferenceResult`; HTTP 200 when submit resolves to any other
  `InferenceResult`; HTTP 503 when the worker state is not initialized. The
  host-level failures of section 2.1 apply unchanged.
- `GET .../invoke/:requestId` returns HTTP 200 with the poll envelope for
  every completed handler operation, including `not-found`.

### 10.2 Selection, timeout, and transport parity

- Submit runs the shared select path synchronously before returning
  `pending`: configuration validation, canonical request parsing, capacity
  evidence, authoritative budget fraction, model selection, issue-stickiness
  write, and credential resolution. The selected model is fixed at submit;
  section 4.1's rule applies unchanged — no post-submit model change for any
  transport outcome.
- The sync-only output-budget preflight does not apply to async. Async has
  no token ceiling beyond the generation timeout below.
- The background generation is bounded by the selected model's effective
  timeout: the model's `requestTimeoutMs` override when present, otherwise
  the upstream `requestTimeoutMs`, clamped to 1,000 through 300,000 ms. The
  configured default stays 25,000 ms; raising the ceiling is strictly opt-in
  per model or per upstream.
- The background performs exactly one upstream HTTP attempt through the same
  adapters, normalization, and error taxonomy as sections 5–8, and settles
  the row to the resulting `completed` or `error` outcome. An unexpected
  exception escaping the transport normalizes to `upstream-connect`,
  retryable, with no upstream status or request ID.
- The background call uses the worker process's own `fetch`, not the
  host-managed `ctx.http.fetch` bridge, because the bridge aborts at the
  host's 30-second cap — the exact bound async exists to escape. SSRF posture
  is unchanged: the only URL is derived from the company-validated
  `baseUrl`, and the request-time DNS guard of the sync path applies before
  the socket opens. No caller-supplied URL exists on this path.

### 10.3 Retention (TTL) and expiry

- Each pending row lives `PENDING_INVOCATION_TTL_MS` (15 minutes) from
  submit: `expiresAt = startedAt + 15 min`. The worker schedules physical
  deletion at that deadline, and a poll that finds an expired row deletes it
  and returns `not-found` (lazy expiry covers worker restarts that lost the
  timer).
- After `expiresAt`, polling MUST return `not-found` and MUST NOT serve the
  expired value.
- A late upstream outcome that lands after expiry MUST NOT resurrect the
  row. The outcome is still written to the decision-record audit (history),
  but the pending row stays deleted and polling stays `not-found`. The
  expired row's run-index entry is pruned on the expiry read.
- Storage caveat: `ctx.state` has no durable native TTL. If the worker
  restarts before its deletion timer fires and nobody polls the request
  again, an abandoned row (a terminal row contains its normalized response
  text) can remain physically stored until host database retention removes
  it. The API guarantee above is unaffected: it never serves an expired
  value.
- `startedAt` anchors the TTL, not the upstream round trip: a generation
  that finishes at minute 14 stays pollable for one more minute, not 15.

### 10.4 Run-end cancellation (reap)

- When an agent run ends, the host calls `cancel-run-invocations` with that
  `runId`. The plugin enumerates the run's still-open request IDs through a
  per-run index (one company-scoped row per run; best-effort — a submit
  whose index write failed still returns `pending`, and such rows expire via
  section 10.3 if the reap cannot see them).
- For each listed row still `pending`, the reap aborts its in-flight
  upstream socket through the request's `AbortController` (when the worker
  that started it is still alive to hold the controller), flags the request
  so the continuation cannot overwrite the terminal below, settles the row
  to `error` / `invocation-cancelled` (non-retryable, no upstream status or
  request ID), removes it from the run index, and writes its audit record.
- For each listed row already terminal or gone (TTL, an earlier reap, a
  worker restart that lost the controllers), the reap prunes the index entry
  and reports it as already-terminal — never as cancelled.
- The reap is idempotent and MUST NOT throw on storage failures. It returns
  `{ runId, cancelled: string[], alreadyTerminal: string[], failed: string[] }`
  so the host can retry what it could not settle. A second call for the same
  run reports zeroes.
- A late upstream outcome that lands after the reap MUST NOT overwrite the
  `invocation-cancelled` terminal (flag check plus a re-read of the row
  before persisting). The observed outcome is still audited; the pending row
  is state, the decision record is history.
- `invocation-cancelled` is never produced by the transport itself. The
  transport reports an abort as `invocation-cancelled` only when its
  caller-supplied abort signal fired. Retry logic MUST NOT replay a
  cancelled run: the host declared it finished.

### 10.5 Non-replay and audit

- Section 4.1's single-attempt rule covers async: one submit performs at
  most one upstream HTTP attempt. Neither the background continuation, nor
  the reap, nor the reconcile job re-issues an upstream request.
- Every terminal async outcome — `completed`, `error`, and
  `invocation-cancelled` — produces the same decision-record shape as
  section 12. Reap-time audit carries no request content (the issue ID is
  null) and attributes the row to the stored submitting agent/run. A
  continuation or reap that cannot persist its audit record queues it for
  the reconcile job, so rows end terminal *and* audit-complete.
- Pending rows carry only the routing envelope (`status`, `requestId`,
  `decision`, timestamps, submitting run/agent); terminal rows add the
  normalized response or error. Neither MUST contain credentials, message
  content, tool arguments/results, system prompts, raw upstream bodies, or
  provider/account serving identity.

## 11. Redirects and response handling

- Redirects MUST NOT be followed.
- Every 3xx response, including 301, 302, 303, 307, and 308, normalizes to `upstream-redirect` with `retryable: false`.
- The `Location` header MUST NOT be fetched and MUST NOT be returned to callers. It MAY be logged only after normal URL redaction and without query/fragment.
- Stock `ctx.http.fetch` buffers before returning. The adapter MUST reject a returned body whose UTF-8 byte length exceeds `maxResponseBytes`, but MUST NOT claim this stops the host read early.
- Only JSON success and error bodies are accepted. HTML, text, compressed bytes, and SSE bodies are invalid upstream responses.
- The adapter MUST send `Accept-Encoding: identity`; stock v1 does not decompress gzip, Brotli, or deflate responses.

## 12. Audit, state, and observability

For every operation, the plugin appends a company-scoped decision record to its durable database namespace with:

- Paperclip request/run identifier;
- issue ID when present;
- task class;
- selection outcome and selected model;
- whether a protocol-neutral model fallback was used;
- upstream protocol;
- normalized operation outcome;
- normalized error code and upstream status when applicable;
- bounded latency and normalized token usage;
- upstream request ID when present;
- capacity-snapshot age in wall-clock ms and whether it exceeded
  `capacityRouting.maxSnapshotAgeMs` at decision time (TOG-7885) — a pure
  freshness fact about the router's own refresh cadence.

It MUST NOT record message content, tool arguments/results, system prompts, credentials, full upstream URLs, upstream error bodies, or provider/account serving identity. Router v2 MAY record only the exact model ID, source ID, sanitized lane label, health, posture, utilization, and reset from a separately refreshed snapshot. Those labels MUST remain semantically separate from deployment identity.

Rule 0 and selection refusals are audited without any upstream entry. Decision records MUST NOT be capped by a rolling in-memory or plugin-state buffer; this implementation retains 90 days and prunes older rows at worker startup. Company A's config, secret reference, company-scoped state, request content, and results MUST never be readable from company B. Native metrics are aggregate instance measurements only and MUST NOT carry a company identifier.

## 13. Explicit non-goals and removed vocabulary

The following are not part of this contract and MUST be removed rather than renamed:

- `claudePaygEnabled` and any PAYG unlock environment variable;
- router-owned allowlists or preference order for the compatible upstream's actual serving providers, post-selection provider choice, and provider fallback after inference starts; separately refreshed model-usage evidence is additive selection input, not deployment routing;
- combo arming, combo unlocks, or model-ID prefix inspection as a containment boundary;
- `teamclaude`, `CLIProxy`, OmniRoute, OpenRouter, or any provider name in the generic product schema or normalized result;
- teamclaude-specific quota URLs, keys, windows, snapshots, utilization signals, actions, data keys, gates, traces, and error fields;
- automatic retries or fallback after an upstream request begins;
- OpenAI Responses API, legacy Completions API, Anthropic Batches, Files, token counting, citations, prompt caching controls, thinking controls, server tools, computer use, audio, PDF/document input, or provider beta fields;
- streaming, partial results, resumable requests, and batch inference. (Asynchronous submit+poll invocation and run-end cancellation of it are in-contract under section 10; anything beyond that — incremental delivery, client-driven cancel, resume tokens — is out.)
- public release, license selection, repository visibility, brand positioning, or any legal/public commitment.

TogetherWeOwn may configure `baseUrl` to OmniRoute. That is an instance choice, not a product dependency or protocol extension.

## 14. Conformance and handoff

TOG-532 is complete only when implementation has exact-wire tests covering, at minimum:

1. identical selection under both protocols;
2. Rule 0 makes zero HTTP requests;
3. exact method, path, headers, and JSON for minimal text requests;
4. exact tool definition, tool call, and tool result mappings;
5. normalized text, tool calls, stop reason, usage, selected model, and upstream request ID;
6. malformed tool arguments and malformed 2xx envelopes;
7. every status/error classification in section 8;
8. no redirect following;
9. caller-visible request timeout, stock 30-second cleanup behavior, and post-buffer response-size rejection;
10. closed secret-ref schema, call-time company-scoped resolution, the stock 30/minute resolution ceiling, and absence of secrets from output/log/state;
11. rejection of caller model/protocol/base-URL/header/stream overrides;
12. no automatic replay or post-HTTP model fallback;
13. `multiCompanyConfig: true`, company-scoped state keys, and isolation of two companies with different protocol/base URL/secret refs in one worker;
14. exact stock wrappers and failures: namespaced tool name, action `{data}` envelope, scoped-route host status cases, and the 1,000,000-byte scoped-route body ceiling;
15. source and packed-artifact proof that inference networking uses only `ctx.http.fetch` except the single sanctioned async background client (section 10.2), with `Accept-Encoding: identity` and no other direct Node or third-party HTTP client;
16. stock Paperclip plugin API v1 build, pack, install validation, and load without runtime host modification;
17. repository-wide absence of every removed field and behavior in section 13, except historical ADRs or migration notes that clearly label them obsolete.
18. async submit/poll fidelity to section 10: pending receipt and terminal envelopes carry exactly the stated keys; submit resolves early exits to `InferenceResult` with no pending row; polls after `expiresAt` return `not-found` without serving the expired value; late outcomes never resurrect an expired or reaped row; the reap settles still-pending rows to `invocation-cancelled` exactly once and never throws; neither continuation, reap, nor reconcile issues a second upstream request.

TOG-533 independently verifies the same contract, including SSRF posture and the packaged artifact. A public release or live installation requires separate authorization and is not granted by this document.

## 15. Versioning and undo path

This contract is `v1`. Additive response fields and newly recognized upstream fields MAY be introduced without changing the contract version if existing required fields and behavior remain unchanged. New request capabilities, streaming, automatic replay, a third protocol, changed endpoint paths, or changed failure/fallback semantics require `v2` or a new superseding contract.

Undo path: revert this document and the TOG-532 implementation before a replacement release or live install. The superseded v0.2.7 artifact remains uninstalled; reverting does not authorize installing it, because it implements the removed product requirements.
