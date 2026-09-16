import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import {
  createRequest,
  createSuccessResponse,
  definePlugin,
  JsonRpcCallError,
  parseMessage,
  serializeMessage,
  startWorkerRpcHost,
} from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  buildAnthropicRequest,
  buildOpenAiRequest,
  normalizeAnthropicSuccess,
  normalizeOpenAiSuccess,
  requestHeaders,
  upstreamUrl,
} from "../src/inference/adapters.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from "../src/config/upstream-constraints.js";
import { effectiveRequestTimeoutMs, invokeCompatibleUpstream } from "../src/inference/transport.js";
import type { InvokeRequest } from "../src/inference/types.js";
import { InvocationValidationError, parseInvokeRequest } from "../src/inference/validate.js";
import { fixtureConfig } from "./helpers.js";

const request: InvokeRequest = {
  task: { taskClass: "implementation" },
  system: "System",
  messages: [
    { role: "user", content: [{ type: "text", text: "Use a tool" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Calling." },
        { type: "tool_call", id: "call-1", name: "lookup", arguments: { id: 7 } },
      ],
    },
    { role: "tool", toolCallId: "call-1", content: "found" },
  ],
  maxOutputTokens: 4096,
  stopSequences: ["STOP"],
  tools: [{ name: "lookup", description: "Look up an id", inputSchema: { type: "object", properties: { id: { type: "integer" } } } }],
  toolChoice: { name: "lookup" },
  metadata: { issue: "TOG-532" },
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rawResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

async function fetchThroughSdk(responseResult: {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}): Promise<Response> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let contextFetch: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  const plugin = definePlugin({
    async setup(ctx) {
      contextFetch = ctx.http.fetch.bind(ctx.http);
    },
  });
  const host = startWorkerRpcHost({ plugin, stdin, stdout });
  const lines = createInterface({ input: stdout });
  const messages = lines[Symbol.asyncIterator]();
  const workerMessage = async (): Promise<Record<string, unknown>> => {
    const next = await messages.next();
    if (next.done) throw new Error("SDK worker output ended early");
    return parseMessage(next.value) as unknown as Record<string, unknown>;
  };

  try {
    stdin.write(serializeMessage(createRequest(
      "initialize",
      { manifest: {}, config: {} },
      "initialize",
    )));
    await workerMessage();
    if (!contextFetch) throw new Error("SDK context did not initialize");
    const requestPromise = contextFetch("https://upstream.example/v1/messages", { method: "POST" });
    const outbound = await workerMessage();
    if (typeof outbound.id !== "string" && typeof outbound.id !== "number") {
      throw new Error("SDK request did not include an id");
    }
    stdin.write(serializeMessage(createSuccessResponse(outbound.id, responseResult)));
    return await requestPromise;
  } finally {
    host.stop();
  }
}

describe("exact compatible-upstream wires", () => {
  it("builds the OpenAI-compatible wire exactly", () => {
    expect(buildOpenAiRequest(request, "selected-model")).toEqual({
      model: "selected-model",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Use a tool" },
        {
          role: "assistant",
          content: "Calling.",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"id":7}' } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "found" },
      ],
      max_tokens: 4096,
      stream: false,
      stop: ["STOP"],
      tools: [{ type: "function", function: { name: "lookup", description: "Look up an id", parameters: { type: "object", properties: { id: { type: "integer" } } } } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      metadata: { issue: "TOG-532" },
    });
  });

  it("builds the Anthropic-compatible wire exactly", () => {
    expect(buildAnthropicRequest(request, "selected-model")).toEqual({
      model: "selected-model",
      max_tokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "Use a tool" }] },
        { role: "assistant", content: [{ type: "text", text: "Calling." }, { type: "tool_use", id: "call-1", name: "lookup", input: { id: 7 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "found", is_error: false }] },
      ],
      stream: false,
      system: "System",
      stop_sequences: ["STOP"],
      tools: [{ name: "lookup", description: "Look up an id", input_schema: { type: "object", properties: { id: { type: "integer" } } } }],
      tool_choice: { type: "tool", name: "lookup" },
    });
  });

  it("normalizes duplicate terminal paths and owns auth/encoding headers", () => {
    const openai = fixtureConfig("company-a").upstream;
    expect(upstreamUrl(openai)).toBe("https://company-a.example/api/v1/chat/completions");
    const anthropic = fixtureConfig("company-b").upstream;
    expect(upstreamUrl(anthropic)).toBe("https://company-b.example/compatible/v1/messages");
    expect(requestHeaders(openai, "resolved-a")).toEqual({
      "X-Company-Lane": "a",
      Authorization: "Bearer resolved-a",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
    });
    expect(requestHeaders(anthropic, "resolved-b")).toEqual({
      "X-Company-Lane": "b",
      "x-api-key": "resolved-b",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
    });
  });
});

describe("response normalization", () => {
  it("normalizes OpenAI text, tool calls, usage and request id", () => {
    expect(normalizeOpenAiSuccess({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "echoed-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Done", tool_calls: [{ id: "call-2", type: "function", function: { name: "lookup", arguments: '{"id":8}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }, "selected-model", "req-1")).toMatchObject({
      id: "chatcmpl-1",
      modelId: "selected-model",
      stopReason: "tool-use",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      upstream: { protocol: "openai-chat-completions", requestId: "req-1", responseModelId: "echoed-model" },
      content: [{ type: "text", text: "Done" }, { type: "tool_call", id: "call-2", name: "lookup", arguments: { id: 8 } }],
    });
  });

  it("normalizes Anthropic text, tool calls, refusal and usage", () => {
    expect(normalizeAnthropicSuccess({
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "echoed-model",
      content: [{ type: "text", text: "Done" }, { type: "tool_use", id: "toolu-1", name: "lookup", input: { id: 8 } }],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 5 },
    }, "selected-model", "req-2")).toMatchObject({
      modelId: "selected-model",
      stopReason: "refusal",
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      upstream: { protocol: "anthropic-messages", requestId: "req-2", responseModelId: "echoed-model" },
    });
  });

  it("rejects malformed arguments and malformed 2xx envelopes", () => {
    expect(() => normalizeOpenAiSuccess({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "x", arguments: "not-json" } }] } }] }, "m", null)).toThrow();
    expect(() => normalizeOpenAiSuccess({ object: "wrong", choices: [{ index: 0, message: { role: "assistant", content: "text" } }] }, "m", null)).toThrow("chat.completion");
    // A structurally broken block still throws. An *unrecognized* block no longer
    // does — see the empty-content group below for why those two differ.
    expect(() => normalizeAnthropicSuccess({ type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "lookup", input: "not-an-object" }] }, "m", null)).toThrow();
    expect(() => normalizeAnthropicSuccess({ type: "message", role: "assistant", content: "not-an-array" }, "m", null)).toThrow("message envelope is invalid");
  });
});

/**
 * TOG-1035. A reasoning model can burn its entire output budget on hidden
 * thinking tokens and return a well-formed success carrying nothing readable.
 * The router used to call that `invalid-upstream-response`, which blamed the
 * upstream for a generation that had in fact happened and been paid for — 5 of
 * 50 calls in the first enforce-mode hour. It is a completion that ran out of
 * room, and it must normalize as one.
 */
describe("empty-content success envelopes", () => {
  it("completes an OpenAI reply whose content and tool calls are both absent", () => {
    const result = normalizeOpenAiSuccess({
      object: "chat.completion",
      id: "chatcmpl-empty",
      model: "glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 1500, total_tokens: 2400 },
    }, "selected-model", "req-empty");
    expect(result.content).toEqual([]);
    // Reported "stop", but a turn that ended with nothing said did not end willingly.
    expect(result.stopReason).toBe("max-tokens");
    // The tokens were spent and must still be billed and recorded.
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 1500, totalTokens: 2400 });
  });

  it("completes an Anthropic reply that carries only thinking blocks", () => {
    const result = normalizeAnthropicSuccess({
      id: "msg-empty",
      type: "message",
      role: "assistant",
      model: "minimax-m3",
      content: [{ type: "thinking", thinking: "<think>...</think>" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 2048 },
    }, "selected-model", "req-empty");
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe("max-tokens");
    expect(result.usage).toMatchObject({ outputTokens: 2048 });
  });

  it("keeps a stop reason that explains the emptiness instead of overwriting it", () => {
    // A refusal or a filter is *why* there is no content, and is the more
    // specific fact. Only an unbelievable "it finished" gets corrected.
    expect(normalizeAnthropicSuccess({
      type: "message", role: "assistant", model: "m", content: [], stop_reason: "refusal",
    }, "m", null).stopReason).toBe("refusal");
    expect(normalizeOpenAiSuccess({
      object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "content_filter" }],
    }, "m", null).stopReason).toBe("content-filter");
    expect(normalizeOpenAiSuccess({
      object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "length" }],
    }, "m", null).stopReason).toBe("max-tokens");
  });

  it("still reports content when the model did produce some", () => {
    // The correction is scoped to empty replies; a normal end-turn is untouched.
    expect(normalizeOpenAiSuccess({
      object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    }, "m", null).stopReason).toBe("end-turn");
  });
});

/**
 * TOG-1035. The 25s ceiling was a wall, not a budget: 20 of 32 implementation
 * calls died at exactly 25.0s while the same generations landed upstream at
 * ~27s. v1 invokes once with no retry, so each was a paid generation discarded.
 */
describe("request timeout budget", () => {
  it("allows an operator to configure well past the old 25s wall", () => {
    expect(MAX_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("keeps the default at 25s so raising the ceiling changes nobody silently", () => {
    // The schema publishes the default, so for an unconfigured company this value
    // *is* the timeout. It once read MAX_REQUEST_TIMEOUT_MS; had it stayed that
    // way, this release would have moved every such company 25s -> 300s as a side
    // effect of a bounds change. Opt-in only.
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(25_000);
    expect(fixtureConfig("company-a").upstream.requestTimeoutMs).toBe(25_000);
  });

  it("prefers the selected model's override and inherits when it is absent", () => {
    expect(effectiveRequestTimeoutMs(25_000, 180_000)).toBe(180_000);
    expect(effectiveRequestTimeoutMs(25_000, undefined)).toBe(25_000);
  });

  it("clamps a stored override, because the config schema validates nothing at runtime", () => {
    expect(effectiveRequestTimeoutMs(25_000, 10 * MAX_REQUEST_TIMEOUT_MS)).toBe(MAX_REQUEST_TIMEOUT_MS);
    expect(effectiveRequestTimeoutMs(25_000, 1)).toBe(MIN_REQUEST_TIMEOUT_MS);
    // Garbage falls back rather than failing the call outright.
    expect(effectiveRequestTimeoutMs(25_000, Number.NaN)).toBe(25_000);
  });

  it("gives a slow model the longer budget its own entry asks for", async () => {
    const config = fixtureConfig("company-a").upstream;
    config.requestTimeoutMs = 5;
    const slowReply = response({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "thought about it" }, finish_reason: "stop" }],
    });
    const fetch = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(slowReply), 25)));
    // Same upstream that timed out above, rescued purely by the per-model override.
    const result = await invokeCompatibleUpstream({
      http: { fetch }, config, credential: "resolved-value", request, modelId: "m", modelTimeoutMs: 1_000,
    });
    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    // ...and without the override the very same call is still lost, which is what
    // makes the override the cause of the rescue rather than the fixture.
    // TOG-3055: this half carried the same 20ms wall-clock margin as the timeout
    // test below, so it runs on virtual time. The rescued half above keeps the
    // real clock — its margin is 975ms, and it has to read the response body.
    vi.useFakeTimers();
    try {
      const pending = invokeCompatibleUpstream({
        http: { fetch: () => new Promise<Response>((resolve) => setTimeout(() => resolve(slowReply), 25)) },
        config, credential: "resolved-value", request, modelId: "m",
      });
      await vi.advanceTimersByTimeAsync(5);
      expect((await pending).error?.code).toBe("upstream-timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runtime request validation", () => {
  it.each(["model", "protocol", "baseUrl", "headers", "stream", "companyId"])("rejects caller override %s", (field) => {
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10, [field]: "bad" }, 100)).toThrow(InvocationValidationError);
  });

  it("requires tool call identifiers and enforces the company maximum", () => {
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "tool", content: "result" }], maxOutputTokens: 10 }, 100)).toThrow("toolCallId");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 101 }, 100)).toThrow("company maximum");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: [{ type: "image_url", url: "https://images.example/a.png" }] }], maxOutputTokens: 10 }, 100, "anthropic-messages")).toThrow("image_url");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: [{ type: "image_url", url: "data:image/png;base64,AAAA" }] }], maxOutputTokens: 10 }, 100, "openai-chat-completions")).toThrow("inline data");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: [{ type: "image_url", url: "images.example/a.png" }] }], maxOutputTokens: 10 }, 100, "openai-chat-completions")).toThrow("absolute http or https URL");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "user", content: [{ type: "tool_call", id: "x", name: "lookup", arguments: {} }] }], maxOutputTokens: 10 }, 100)).toThrow("assistant role");
    expect(() => parseInvokeRequest({ task: {}, messages: [{ role: "assistant", content: [{ type: "tool_result", toolCallId: "x", content: "done" }] }], maxOutputTokens: 10 }, 100)).toThrow("tool_result");
  });

  it("derives the vision capability gate from OpenAI-profile image content", () => {
    const parsed = parseInvokeRequest({
      task: { requiredCapabilities: ["tools"] },
      messages: [{ role: "user", content: [{ type: "image_url", url: "https://images.example/a.png" }] }],
      maxOutputTokens: 10,
    }, 100, "openai-chat-completions");
    expect(parsed.task.requiredCapabilities).toEqual(["tools", "vision"]);
  });
});

describe("single-attempt transport", () => {
  it("uses ctx.http.fetch once, manual redirects, and normalizes success", async () => {
    const config = fixtureConfig("company-a").upstream;
    const fetch = vi.fn(async () => response({ id: "chatcmpl-1", object: "chat.completion", model: "echo", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }, 200, { "x-request-id": "req-live" }));
    const result = await invokeCompatibleUpstream({ http: { fetch }, config, credential: "resolved-value", request, modelId: "minimax-m2.5" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(result.response).toMatchObject({ modelId: "minimax-m2.5", upstream: { requestId: "req-live" } });
  });

  it("never replays after an upstream failure", async () => {
    const fetch = vi.fn(async () => response({ error: { message: "do not return me" } }, 529));
    const result = await invokeCompatibleUpstream({ http: { fetch }, config: fixtureConfig("company-a").upstream, credential: "resolved-value", request, modelId: "minimax-m2.5" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ code: "upstream-overloaded", retryable: true });
    expect(JSON.stringify(result)).not.toContain("do not return me");
    expect(JSON.stringify(result)).not.toContain("resolved-value");
  });

  it("rejects non-JSON and compressed response media", async () => {
    const config = fixtureConfig("company-a").upstream;
    const html = await invokeCompatibleUpstream({ http: { fetch: async () => rawResponse("<html>bad</html>", 200, { "content-type": "text/html" }) }, config, credential: "resolved-value", request, modelId: "m" });
    expect(html.error?.code).toBe("invalid-upstream-response");
    const compressed = await invokeCompatibleUpstream({ http: { fetch: async () => rawResponse("{}", 200, { "content-type": "application/json", "content-encoding": "gzip" }) }, config, credential: "resolved-value", request, modelId: "m" });
    expect(compressed.error?.code).toBe("invalid-upstream-response");
  });

  it("rejects buffered responses above the configured byte ceiling", async () => {
    const config = fixtureConfig("company-a").upstream;
    config.maxResponseBytes = 32;
    const result = await invokeCompatibleUpstream({ http: { fetch: async () => response({ data: "x".repeat(100) }) }, config, credential: "resolved-value", request, modelId: "m" });
    expect(result.error?.code).toBe("upstream-response-too-large");
  });

  it("maps stock SDK host URL rejection and network failure separately", async () => {
    const config = fixtureConfig("company-a").upstream;
    for (const cause of [
      new JsonRpcCallError({ code: -32603, message: "All resolved IPs for private.example are in private/reserved ranges" }),
      new JsonRpcCallError({ code: -32603, message: "Resolved IPs for private.example include private/reserved ranges" }),
      new JsonRpcCallError({ code: -32603, message: 'Disallowed protocol "file:" — only http: and https: are permitted' }),
      new JsonRpcCallError({ code: -32603, message: "url resolves to a private, local, multicast, or reserved address" }),
    ]) {
      const rejected = await invokeCompatibleUpstream({ http: { fetch: async () => { throw cause; } }, config, credential: "resolved-value", request, modelId: "m" });
      expect(rejected.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    }
    for (const message of [
      "DNS resolution returned no results for upstream.example",
      "DNS lookup timed out after 5000ms for upstream.example",
      "DNS resolution failed for upstream.example: temporary failure",
      "socket hang up",
    ]) {
      const unavailable = await invokeCompatibleUpstream({ http: { fetch: async () => { throw new JsonRpcCallError({ code: -32603, message }); } }, config, credential: "resolved-value", request, modelId: "m" });
      expect(unavailable.error).toMatchObject({ code: "upstream-connect", retryable: true });
    }
    const typeError = await invokeCompatibleUpstream({ http: { fetch: async () => { throw new TypeError("socket closed"); } }, config, credential: "resolved-value", request, modelId: "m" });
    expect(typeError.error).toMatchObject({ code: "upstream-connect", retryable: true });
  });

  it("fails closed before HTTP when called with an unknown runtime protocol", async () => {
    const config = fixtureConfig("company-a").upstream;
    (config as { protocol: string | null }).protocol = "future-provider-wire";
    const fetch = vi.fn();
    const result = await invokeCompatibleUpstream({ http: { fetch }, config, credential: "resolved-value", request, modelId: "m" });
    expect(result.error).toMatchObject({ code: "upstream-url-rejected", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies SDK-reconstructed HTTP 304 as redirect instead of URL rejection", async () => {
    const config = fixtureConfig("company-a").upstream;
    const result = await invokeCompatibleUpstream({
      http: {
        fetch: async () => fetchThroughSdk({
          status: 304,
          statusText: "Not Modified",
          headers: { "x-request-id": "sdk-304-request" },
          body: "",
        }),
      },
      config,
      credential: "resolved-value",
      request,
      modelId: "m",
    });
    expect(result.error).toMatchObject({
      code: "upstream-redirect",
      retryable: false,
      upstreamStatus: 304,
      upstreamRequestId: null,
    });
  });

  it.each([301, 302, 303, 307, 308])("classifies HTTP %s as redirect before media or body validation", async (status) => {
    const config = fixtureConfig("company-a").upstream;
    const result = await invokeCompatibleUpstream({
      http: { fetch: async () => rawResponse("not-json", status, {
        "content-type": "text/html",
        "location": "https://redirect.example/elsewhere",
        "x-request-id": `redirect-request-${status}`,
      }) },
      config,
      credential: "resolved-value",
      request,
      modelId: "m",
    });
    expect(result.error).toMatchObject({
      code: "upstream-redirect",
      retryable: false,
      upstreamStatus: status,
      upstreamRequestId: `redirect-request-${status}`,
    });
  });

  // TOG-3055: this ran on the wall clock — a 5ms budget against an upstream that
  // answered 25ms later. `transport.ts` arms the mock's timer (inside http.fetch)
  // one statement before it arms its own, and Promise.race resolves on absolute
  // due time, so the whole test rested on those two arming points landing within
  // 20ms of each other. One GC pause or scheduler preemption there and the
  // upstream response wins instead, which surfaces as "invalid-upstream-response"
  // — measured at 2 of 7 full-suite runs on a loaded 8-core box, and once on CI.
  // Fake timers order the two by virtual due time, so the margin is exact rather
  // than probabilistic, and they let us advance PAST the late response to prove
  // it is discarded rather than replayed.
  it("returns caller-visible timeout without starting another request", async () => {
    vi.useFakeTimers();
    try {
      const config = fixtureConfig("company-a").upstream;
      config.requestTimeoutMs = 5;
      const fetch = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(response({})), 25)));
      const pending = invokeCompatibleUpstream({ http: { fetch }, config, credential: "resolved-value", request, modelId: "m" });
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result.error?.code).toBe("upstream-timeout");
      expect(fetch).toHaveBeenCalledTimes(1);
      // The upstream answers after the caller already has its timeout. Nothing
      // may re-issue the request, and the late body must not resurface.
      await vi.advanceTimersByTimeAsync(25);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.error?.code).toBe("upstream-timeout");
      expect(result.response).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
