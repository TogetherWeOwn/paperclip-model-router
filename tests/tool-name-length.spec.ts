import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../src/constants.js";
import {
  buildAnthropicRequest,
  buildOpenAiRequest,
} from "../src/inference/adapters.js";
import type { InvokeRequest } from "../src/inference/types.js";
import {
  InvocationValidationError,
  MAX_TOOL_NAME_LENGTH,
  parseInvokeRequest,
} from "../src/inference/validate.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

// TOG-5247 (follow-up to TOG-4713, D2d name-length slice of the D2
// conformance family): gateway tool-name length conformance.
//
// Defect under test (OBS in TOG-4896): gateway tool names embed a random
// application UUID, so with the client prefix they reach 90-110 characters.
// A 64-capped lane (CLIProxy `capResponsesChatToolName` on the Muse lane)
// truncates every action to one shared head and appends `_1`..`_N`; the model
// cannot tell the actions apart and the reverse map fails with "No such tool
// available" (44% of Muse-lane GitHub MCP calls, 09-19..26).
//
// Contract asserted here: the router never forwards a caller tool name longer
// than 64 characters. `parseInvokeRequest` rejects such names as
// `invalid-request` BEFORE selection, so no model is selected, no upstream
// request is made, and the violation is caught at the router boundary — by a
// test, not by a lane failure (the seven-day metric on TOG-5247).
//
// The bound is pinned at 64 (the portable ceiling across both compatible
// profiles and the capped lane), and rejection messages carry only the
// length and position — never the offending name itself.

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET = "resolved-secret-probe";

// Two distinct F7-shaped names sharing one 62-character head: exactly what a
// 64-capped lane mangles into indistinguishable aliases.
const SHARED_HEAD = "g".repeat(62);
const LONG_A = `${SHARED_HEAD}-create-branch-action-alpha`;
const LONG_B = `${SHARED_HEAD}-create-repository-action-beta`;

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: { taskClass: "implementation" },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 100,
    ...overrides,
  };
}

function openAiSuccess() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function testWorker() {
  const configs = new Map([[COMPANY_A, readFixture("company-a")]]);
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get(companyId) {
      const config = configs.get(String(companyId));
      if (!config) throw new Error(`missing company config for ${companyId}`);
      return structuredClone(config);
    },
  };
  harness.ctx.secrets = {
    async resolve() { return SECRET; },
  };
  const httpCalls: Array<{ url: string; init?: RequestInit }> = [];
  harness.ctx.http = {
    async fetch(url, init) {
      httpCalls.push({ url: String(url), init });
      return openAiSuccess();
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, httpCalls };
}

function toolCtx() {
  return { companyId: COMPANY_A, runId: "run-name-length", agentId: "agent-name-length", projectId: "project-name-length" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool-name length conformance (TOG-5247)", () => {
  it("pins the lane ceiling at 64 characters", () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
  });

  it("rejects a 65-character tool definition name", () => {
    const name = "t".repeat(65);
    expect(() => parseInvokeRequest(
      baseRequest({ tools: [{ name, inputSchema: { type: "object" } }] }),
      100,
    )).toThrow(InvocationValidationError);
    expect(() => parseInvokeRequest(
      baseRequest({ tools: [{ name, inputSchema: { type: "object" } }] }),
      100,
    )).toThrow(/64/);
  });

  it("accepts a 64-character tool definition name byte-identical", () => {
    const name = "t".repeat(64);
    const parsed = parseInvokeRequest(
      baseRequest({ tools: [{ name, description: "exact ceiling", inputSchema: { type: "object" } }] }),
      100,
    );
    expect(parsed.tools?.[0]?.name).toBe(name);
  });

  it("rejects both F7-shaped names sharing one 62-character head", () => {
    for (const name of [LONG_A, LONG_B]) {
      expect(name.length).toBeGreaterThan(64);
      expect(() => parseInvokeRequest(
        baseRequest({ tools: [{ name, inputSchema: { type: "object" } }] }),
        100,
      )).toThrow(/64/);
    }
  });

  it("rejects an overlong object-form toolChoice name", () => {
    const name = "c".repeat(100);
    expect(() => parseInvokeRequest(
      baseRequest({
        tools: [{ name: "short", inputSchema: { type: "object" } }],
        toolChoice: { name },
      }),
      100,
    )).toThrow(/64/);
  });

  it("leaves string toolChoice forms unaffected", () => {
    for (const toolChoice of ["auto", "none", "required"] as const) {
      const parsed = parseInvokeRequest(baseRequest({ toolChoice }), 100);
      expect(parsed.toolChoice).toBe(toolChoice);
    }
  });

  it("rejects an overlong assistant tool_call name", () => {
    const name = "m".repeat(90);
    expect(() => parseInvokeRequest(
      baseRequest({
        messages: [{
          role: "assistant",
          content: [{ type: "tool_call", id: "call-1", name, arguments: {} }],
        }],
      }),
      100,
    )).toThrow(/64/);
  });

  it("accepts a 64-character assistant tool_call name", () => {
    const name = "m".repeat(64);
    const parsed = parseInvokeRequest(
      baseRequest({
        messages: [{
          role: "assistant",
          content: [{ type: "tool_call", id: "call-1", name, arguments: {} }],
        }],
      }),
      100,
    );
    const content = parsed.messages[0]?.content;
    expect(Array.isArray(content) && content[0]).toMatchObject({ type: "tool_call", name });
  });

  it("keeps rejecting an empty tool definition name", () => {
    expect(() => parseInvokeRequest(
      baseRequest({ tools: [{ name: "", inputSchema: { type: "object" } }] }),
      100,
    )).toThrow("non-empty string");
  });

  it("never echoes the offending name in the rejection message", () => {
    const marker = `zz${"q".repeat(90)}zz`;
    let message = "";
    try {
      parseInvokeRequest(
        baseRequest({ tools: [{ name: marker, inputSchema: { type: "object" } }] }),
        100,
      );
    } catch (failure) {
      message = failure instanceof Error ? failure.message : String(failure);
    }
    expect(message).toContain("64");
    expect(message).not.toContain(marker);
    expect(message.length).toBeLessThanOrEqual(512);
  });

  it("wire builders still pass a ceiling-length name verbatim", () => {
    const name = "w".repeat(64);
    const request: InvokeRequest = {
      task: {},
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
      tools: [{ name, inputSchema: { type: "object" } }],
      toolChoice: { name },
    };
    const openai = buildOpenAiRequest(request, "m") as { tools: Array<{ function: { name: string } }>; tool_choice: { function: { name: string } } };
    expect(openai.tools[0]?.function.name).toBe(name);
    expect(openai.tool_choice.function.name).toBe(name);
    const anthropic = buildAnthropicRequest(request, "m") as { tools: Array<{ name: string }>; tool_choice: { name: string } };
    expect(anthropic.tools[0]?.name).toBe(name);
    expect(anthropic.tool_choice.name).toBe(name);
  });

  it("invoke resolves invalid-request data with no upstream fetch on an overlong tool name", async () => {
    const { harness, httpCalls } = await testWorker();
    const result = await harness.executeTool(TOOL_NAMES.invoke, {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
      tools: [{ name: LONG_A, inputSchema: { type: "object" } }],
    }, toolCtx());
    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data).toMatchObject({
      outcome: "error",
      decision: null,
      error: { code: "invalid-request", retryable: false },
    });
    expect(String((data.error as Record<string, unknown>).message)).toContain("64");
    expect(httpCalls).toEqual([]);
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
      outcome: "error",
      errorCode: "invalid-request",
    }]);
  });

  it("invoke still reaches the upstream on a ceiling-length tool name", async () => {
    const { harness, httpCalls } = await testWorker();
    const name = "u".repeat(64);
    const result = await harness.executeTool(TOOL_NAMES.invoke, {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
      tools: [{ name, inputSchema: { type: "object" } }],
    }, toolCtx()) as { data: Record<string, unknown> };
    expect(result.data).toMatchObject({ outcome: "completed" });
    expect(httpCalls.length).toBe(1);
  });
});
