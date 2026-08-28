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
import { invokeCompatibleUpstream } from "../src/inference/transport.js";
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
    expect(() => normalizeAnthropicSuccess({ type: "message", role: "assistant", content: [{ type: "image", source: {} }] }, "m", null)).toThrow();
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

  it("returns caller-visible timeout without starting another request", async () => {
    const config = fixtureConfig("company-a").upstream;
    config.requestTimeoutMs = 5;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(response({})), 25)));
    const result = await invokeCompatibleUpstream({ http: { fetch }, config, credential: "resolved-value", request, modelId: "m" });
    expect(result.error?.code).toBe("upstream-timeout");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
