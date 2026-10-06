/**
 * Scoped patch 0.8.1: OpenAI-compatible gateways (e.g. CLI proxies) serialize
 * absent optional fields as explicit nulls. The normalizer treated
 * `tool_calls: null`, `usage: null` and null usage counters as a malformed
 * envelope, so every generation against such an upstream failed with
 * `invalid-upstream-response` ("invalid success envelope") while the origin
 * kept returning 200. Explicit null now means absent; genuinely malformed
 * values still throw. The transport also keeps the violated check plus the
 * 2xx status/request id instead of reporting one opaque string with nulls.
 */
import { describe, expect, it } from "vitest";

import { normalizeAnthropicSuccess, normalizeOpenAiSuccess } from "../src/inference/adapters.js";
import { invokeCompatibleUpstream } from "../src/inference/transport.js";
import type { InvokeRequest } from "../src/inference/types.js";
import { fixtureConfig } from "./helpers.js";

function openAiEnvelope(message: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    object: "chat.completion",
    id: "chatcmpl-16699",
    model: "proxy-model",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
    ...extra,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const probeRequest: InvokeRequest = {
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "Say hi in five words." }],
  maxOutputTokens: 32,
};

describe("explicit-null success envelopes", () => {
  it("accepts OpenAI tool_calls:null as absent", () => {
    const result = normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi there friend", tool_calls: null }),
      "openai/gpt-6-luna",
      null,
    );
    expect(result.content).toEqual([{ type: "text", text: "hi there friend" }]);
    expect(result.stopReason).toBe("end-turn");
  });

  it("accepts OpenAI null usage object and null usage counters", () => {
    const nullObject = normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi" }, { usage: null }),
      "m",
      null,
    );
    expect(nullObject.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    const nullCounters = normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi" }, { usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } }),
      "m",
      null,
    );
    expect(nullCounters.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("accepts Anthropic null usage object and null usage counters", () => {
    const body = (usage: unknown) => ({
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "proxy-model",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage,
    });
    expect(normalizeAnthropicSuccess(body(null), "m", null).usage).toEqual(
      { inputTokens: null, outputTokens: null, totalTokens: null },
    );
    expect(
      normalizeAnthropicSuccess(body({ input_tokens: null, output_tokens: null }), "m", null).usage,
    ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("still rejects genuinely malformed tool_calls and usage", () => {
    // Guard pin: present-but-wrong-typed values still throw.
    expect(() => normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi", tool_calls: "bogus" }), "m", null,
    )).toThrow("tool_calls is invalid");
    expect(() => normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi" }, { usage: { prompt_tokens: "lots" } }), "m", null,
    )).toThrow("prompt_tokens is invalid");
    expect(() => normalizeOpenAiSuccess(
      openAiEnvelope({ content: "hi" }, { usage: 42 }), "m", null,
    )).toThrow("usage is invalid");
    expect(() => normalizeOpenAiSuccess(
      { object: "wrong", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] }, "m", null,
    )).toThrow("chat.completion");
  });

  it("completes a 200 gateway envelope carrying explicit nulls end to end", async () => {
    const config = fixtureConfig("company-a").upstream;
    const result = await invokeCompatibleUpstream({
      http: {
        fetch: async () => jsonResponse(
          openAiEnvelope(
            { content: "hello from the gateway", tool_calls: null },
            { usage: { prompt_tokens: null, completion_tokens: 5, total_tokens: null } },
          ),
          { "x-request-id": "gateway-req-1" },
        ),
      },
      config,
      credential: "resolved-value",
      request: probeRequest,
      modelId: "openai/gpt-6-luna",
    });
    expect(result.error).toBeNull();
    expect(result.response?.content).toEqual([{ type: "text", text: "hello from the gateway" }]);
    expect(result.response?.usage).toEqual({ inputTokens: null, outputTokens: 5, totalTokens: null });
    expect(result.response?.upstream.requestId).toBe("gateway-req-1");
  });

  it("names the violated check and keeps status/request id on a truly invalid envelope", async () => {
    const config = fixtureConfig("company-a").upstream;
    const result = await invokeCompatibleUpstream({
      http: {
        fetch: async () => jsonResponse(
          { object: "wrong", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] },
          { "x-request-id": "gateway-req-2" },
        ),
      },
      config,
      credential: "resolved-value",
      request: probeRequest,
      modelId: "openai/gpt-6-luna",
    });
    expect(result.response).toBeNull();
    expect(result.error?.code).toBe("invalid-upstream-response");
    expect(result.error?.message).toContain("chat.completion");
    expect(result.error?.upstreamStatus).toBe(200);
    expect(result.error?.upstreamRequestId).toBe("gateway-req-2");
    expect(result.error?.retryable).toBe(false);
  });
});
