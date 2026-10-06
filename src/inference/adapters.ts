import type { CompatibleUpstreamConfig } from "../config/types.js";
import {
  FORBIDDEN_EXTRA_HEADERS,
  isReservedLiteralHost,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_TIMEOUT_MS,
  MIN_RESPONSE_BYTES,
} from "../config/upstream-constraints.js";
import type {
  InferenceError,
  InvokeRequest,
  Message,
  NormalizedResponse,
  NormalizedStopReason,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOrThrow(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function optionalNonNegativeInteger(value: unknown, name: string): number | null {
  // Scoped patch 0.8.1: OpenAI-compatible gateways emit explicit nulls where
  // OpenAI omits the key. Null means absent here, exactly like undefined;
  // anything else must still be a non-negative integer.
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} is invalid`);
  return value as number;
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : null;
}

export function validateUpstreamConfig(config: CompatibleUpstreamConfig): string[] {
  const errors: string[] = [];
  if (config.protocol !== "openai-chat-completions" && config.protocol !== "anthropic-messages") {
    errors.push("upstream.protocol is not supported");
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    errors.push("upstream.baseUrl must be an absolute URL");
  }
  if (parsed) {
    if (parsed.protocol !== "https:") errors.push("upstream.baseUrl must use https");
    if (parsed.username || parsed.password) errors.push("upstream.baseUrl must not contain credentials");
    if (parsed.search || parsed.hash) errors.push("upstream.baseUrl must not contain a query or fragment");
    if (isReservedLiteralHost(parsed.hostname)) errors.push("upstream.baseUrl must not use a private or reserved literal address");
  }
  if (!Number.isInteger(config.requestTimeoutMs) ||
      config.requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
      config.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    errors.push(`upstream.requestTimeoutMs must be an integer from ${MIN_REQUEST_TIMEOUT_MS} through ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(config.maxResponseBytes) ||
      config.maxResponseBytes < MIN_RESPONSE_BYTES ||
      config.maxResponseBytes > MAX_RESPONSE_BYTES) {
    errors.push(`upstream.maxResponseBytes must be an integer from ${MIN_RESPONSE_BYTES} through ${MAX_RESPONSE_BYTES}`);
  }
  for (const [name, value] of Object.entries(config.extraHeaders)) {
    if (FORBIDDEN_EXTRA_HEADERS.has(name.toLowerCase())) errors.push(`upstream.extraHeaders must not set ${name}`);
    if (/\r|\n/.test(value)) errors.push(`upstream.extraHeaders.${name} must not contain CR or LF`);
  }
  return errors;
}

function supportedProtocol(config: CompatibleUpstreamConfig): "openai-chat-completions" | "anthropic-messages" {
  if (config.protocol === "openai-chat-completions" || config.protocol === "anthropic-messages") {
    return config.protocol;
  }
  throw new Error("unsupported compatible upstream protocol");
}

export function upstreamUrl(config: CompatibleUpstreamConfig): string {
  const parsed = new URL(config.baseUrl);
  const suffix = supportedProtocol(config) === "openai-chat-completions" ? "/v1/chat/completions" : "/v1/messages";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  parsed.pathname = `${path}${suffix}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}

function openAiMessages(request: InvokeRequest): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (request.system !== undefined) output.push({ role: "system", content: request.system });
  for (const message of request.messages) output.push(...openAiMessage(message));
  return output;
}

function openAiMessage(message: Message): Record<string, unknown>[] {
  if (message.role === "tool") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text" ? block.text : block.type === "tool_result" ? block.content : "").join("");
    return [{ role: "tool", tool_call_id: message.toolCallId, content }];
  }
  if (typeof message.content === "string") return [{ role: message.role, content: message.content }];

  const toolResults = message.content.filter((block) => block.type === "tool_result");
  const ordinary = message.content.filter((block) => block.type !== "tool_result");
  const result: Record<string, unknown>[] = [];
  if (ordinary.length > 0) {
    const text = ordinary.filter((block) => block.type === "text").map((block) => block.text).join("");
    const images = ordinary.filter((block) => block.type === "image_url");
    const calls = ordinary.filter((block) => block.type === "tool_call");
    const wire: Record<string, unknown> = { role: message.role };
    wire.content = images.length > 0
      ? [
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((block) => ({ type: "image_url", image_url: { url: block.url } })),
        ]
      : text || null;
    if (calls.length > 0) {
      wire.tool_calls = calls.map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.arguments) },
      }));
    }
    result.push(wire);
  }
  result.push(...toolResults.map((block) => ({
    role: "tool",
    tool_call_id: block.toolCallId,
    content: block.content,
  })));
  return result;
}

export function buildOpenAiRequest(request: InvokeRequest, modelId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: openAiMessages(request),
    max_tokens: request.maxOutputTokens,
    stream: false,
  };
  if (request.stopSequences !== undefined) body.stop = request.stopSequences;
  if (request.tools !== undefined) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      },
    }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = typeof request.toolChoice === "string"
      ? request.toolChoice
      : { type: "function", function: { name: request.toolChoice.name } };
  }
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return body;
}

function anthropicMessages(request: InvokeRequest): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      output.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : block.type === "tool_result" ? block.content : "").join(""), is_error: false }],
      });
      continue;
    }
    if (typeof message.content === "string") {
      output.push({ role: message.role, content: [{ type: "text", text: message.content }] });
      continue;
    }
    const ordinary = message.content.filter((block) => block.type !== "tool_result");
    if (ordinary.length > 0) {
      output.push({
        role: message.role,
        content: ordinary.map((block) => {
          if (block.type === "image_url") throw new Error("image_url is not supported by the Anthropic-compatible v1 profile");
          if (block.type === "text") return { type: "text", text: block.text };
          if (block.type === "tool_call") return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
          throw new Error("unexpected tool result");
        }),
      });
    }
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      output.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError === true }],
      });
    }
  }
  return output;
}

export function buildAnthropicRequest(request: InvokeRequest, modelId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: request.maxOutputTokens,
    messages: anthropicMessages(request),
    stream: false,
  };
  if (request.system !== undefined) body.system = request.system;
  if (request.stopSequences !== undefined) body.stop_sequences = request.stopSequences;
  if (request.tools !== undefined) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    }));
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = typeof request.toolChoice === "string"
      ? { type: request.toolChoice === "required" ? "any" : request.toolChoice }
      : { type: "tool", name: request.toolChoice.name };
  }
  return body;
}

export function requestHeaders(config: CompatibleUpstreamConfig, credential: string): Record<string, string> {
  return {
    ...config.extraHeaders,
    ...(supportedProtocol(config) === "openai-chat-completions"
      ? { Authorization: `Bearer ${credential}` }
      : { "x-api-key": credential, "anthropic-version": "2023-06-01" }),
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
}

function openAiStop(value: unknown): NormalizedStopReason {
  if (value === "stop") return "end-turn";
  if (value === "length") return "max-tokens";
  if (value === "tool_calls") return "tool-use";
  if (value === "content_filter") return "content-filter";
  return "other";
}

/**
 * What an otherwise-valid envelope carrying no content actually means.
 *
 * A reasoning model can spend its whole output budget on hidden thinking tokens
 * and return a well-formed success with nothing the caller can read — glm-5.3-flash
 * did this on 5 of 50 TOG-1035 trial calls, and minimax-m3 does it while leaking
 * `<think>` into `content`. That is a completion that ran out of room, not a broken
 * upstream, and calling it `invalid-upstream-response` both hid a real (billed)
 * generation and implicated the wrong component.
 *
 * A stop reason the upstream actually asserted is kept: a refusal or a content
 * filter is *why* the content is empty and is the more specific fact. Only the
 * reasons claiming the model finished saying its piece are corrected, because an
 * empty end-turn is the one combination that cannot be true on its face.
 */
function stopReasonForEmptyContent(reported: NormalizedStopReason): NormalizedStopReason {
  return reported === "end-turn" || reported === "other" ? "max-tokens" : reported;
}

function anthropicStop(value: unknown): NormalizedStopReason {
  if (value === "end_turn") return "end-turn";
  if (value === "max_tokens") return "max-tokens";
  if (value === "stop_sequence") return "stop-sequence";
  if (value === "tool_use") return "tool-use";
  if (value === "refusal") return "refusal";
  return "other";
}

export function normalizeOpenAiSuccess(
  value: unknown,
  selectedModelId: string,
  upstreamRequestId: string | null,
): NormalizedResponse {
  const body = objectOrThrow(value, "OpenAI-compatible response must be an object");
  if (body.object !== "chat.completion") throw new Error("object must be chat.completion");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error("choices must contain exactly one item");
  const choice = objectOrThrow(body.choices[0], "choice is invalid");
  if (choice.index !== 0) throw new Error("choice index must be zero");
  const message = objectOrThrow(choice.message, "assistant message is missing");
  if (message.role !== "assistant") throw new Error("assistant role is invalid");
  const content: NormalizedResponse["content"] = [];
  if (typeof message.content === "string" && message.content.length > 0) content.push({ type: "text", text: message.content });
  // Scoped patch 0.8.1: an explicit null is the wire equivalent of an
  // omitted key for gateways that always serialize the field.
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) throw new Error("tool_calls is invalid");
    for (const rawCall of message.tool_calls) {
      const call = objectOrThrow(rawCall, "tool call is invalid");
      const fn = objectOrThrow(call.function, "tool function is invalid");
      if (call.type !== "function" || typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw new Error("tool call fields are invalid");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(fn.arguments); } catch { throw new Error("tool arguments are not valid JSON"); }
      if (!isRecord(parsed)) throw new Error("tool arguments must parse as an object");
      content.push({ type: "tool_call", id: call.id, name: fn.name, arguments: parsed });
    }
  }
  // Scoped patch 0.8.1: explicit null usage is absent usage, not malformed.
  const usage = body.usage === undefined || body.usage === null ? null : objectOrThrow(body.usage, "usage is invalid");
  const inputTokens = usage ? optionalNonNegativeInteger(usage.prompt_tokens, "prompt_tokens") : null;
  const outputTokens = usage ? optionalNonNegativeInteger(usage.completion_tokens, "completion_tokens") : null;
  const totalTokens = usage ? optionalNonNegativeInteger(usage.total_tokens, "total_tokens") : null;
  return {
    id: boundedId(body.id),
    modelId: selectedModelId,
    content,
    stopReason: content.length === 0
      ? stopReasonForEmptyContent(openAiStop(choice.finish_reason))
      : openAiStop(choice.finish_reason),
    stopSequence: null,
    usage: { inputTokens, outputTokens, totalTokens },
    upstream: {
      protocol: "openai-chat-completions",
      requestId: upstreamRequestId,
      responseModelId: boundedId(body.model),
    },
  };
}

export function normalizeAnthropicSuccess(
  value: unknown,
  selectedModelId: string,
  upstreamRequestId: string | null,
): NormalizedResponse {
  const body = objectOrThrow(value, "Anthropic-compatible response must be an object");
  if (body.type !== "message" || body.role !== "assistant" || !Array.isArray(body.content)) {
    throw new Error("message envelope is invalid");
  }
  const content: NormalizedResponse["content"] = [];
  for (const rawBlock of body.content) {
    if (!isRecord(rawBlock)) continue;
    if (rawBlock.type === "text" && typeof rawBlock.text === "string" && rawBlock.text.length > 0) {
      content.push({ type: "text", text: rawBlock.text });
    } else if (rawBlock.type === "tool_use") {
      if (typeof rawBlock.id !== "string" || typeof rawBlock.name !== "string" || !isRecord(rawBlock.input)) {
        throw new Error("tool_use block is invalid");
      }
      content.push({ type: "tool_call", id: rawBlock.id, name: rawBlock.name, arguments: rawBlock.input });
    }
  }
  // No recognized content is a real outcome, not a malformed envelope: a
  // `thinking`-only reply is exactly what a reasoning model returns when the
  // output budget went entirely on hidden tokens. Structurally invalid blocks
  // still throw above; only the empty result is tolerated.
  // Scoped patch 0.8.1: explicit null usage is absent usage, not malformed.
  const usage = body.usage === undefined || body.usage === null ? null : objectOrThrow(body.usage, "usage is invalid");
  const inputTokens = usage ? optionalNonNegativeInteger(usage.input_tokens, "input_tokens") : null;
  const outputTokens = usage ? optionalNonNegativeInteger(usage.output_tokens, "output_tokens") : null;
  return {
    id: boundedId(body.id),
    modelId: selectedModelId,
    content,
    stopReason: content.length === 0
      ? stopReasonForEmptyContent(anthropicStop(body.stop_reason))
      : anthropicStop(body.stop_reason),
    stopSequence: typeof body.stop_sequence === "string" ? body.stop_sequence : null,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    },
    upstream: {
      protocol: "anthropic-messages",
      requestId: upstreamRequestId,
      responseModelId: boundedId(body.model),
    },
  };
}

export function classifyHttpError(status: number, upstreamRequestId: string | null): InferenceError {
  if (status >= 300 && status < 400) return { code: "upstream-redirect", message: "The compatible upstream returned a redirect, which the router does not follow.", retryable: false, upstreamStatus: status, upstreamRequestId };
  if (status === 401) return { code: "upstream-authentication", message: "The compatible upstream rejected its configured credential.", retryable: false, upstreamStatus: status, upstreamRequestId };
  if (status === 403) return { code: "upstream-permission", message: "The compatible upstream denied this request.", retryable: false, upstreamStatus: status, upstreamRequestId };
  if (status === 404) return { code: "upstream-not-found", message: "The compatible upstream endpoint or selected model was not found.", retryable: false, upstreamStatus: status, upstreamRequestId };
  if (status === 408) return { code: "upstream-timeout", message: "The compatible upstream timed out before completing the request.", retryable: true, upstreamStatus: status, upstreamRequestId };
  if (status === 409) return { code: "upstream-conflict", message: "The compatible upstream reported a request conflict.", retryable: true, upstreamStatus: status, upstreamRequestId };
  if (status === 429) return { code: "upstream-rate-limit", message: "The compatible upstream rate-limited this request.", retryable: true, upstreamStatus: status, upstreamRequestId };
  if (status === 529) return { code: "upstream-overloaded", message: "The compatible upstream is overloaded.", retryable: true, upstreamStatus: status, upstreamRequestId };
  if (status >= 500 && status <= 599) return { code: "upstream-server-error", message: "The compatible upstream returned a server error.", retryable: true, upstreamStatus: status, upstreamRequestId };
  return { code: "upstream-client-error", message: "The compatible upstream rejected the request.", retryable: false, upstreamStatus: status, upstreamRequestId };
}

export function upstreamRequestId(headers: Headers, body: unknown): string | null {
  const headerId = headers.get("x-request-id") ?? headers.get("request-id");
  if (headerId) return headerId.slice(0, 512);
  if (isRecord(body) && typeof body.request_id === "string") return body.request_id.slice(0, 512);
  return null;
}
