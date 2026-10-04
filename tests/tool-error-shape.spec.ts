import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

// MCP tool error-shape conformance.
//
// Contract under test: every model-router MCP tool returns a `ToolResult`
// whose `data` is a plain object on EVERY path — success, rejection, and
// infrastructure failure. A handler must never throw, never resolve with
// `data` undefined/null/an array, and never leak infrastructure detail
// (exception text, secrets, URLs) into the caller-visible result.
//
// Failure-shape convention asserted here:
// - `model_router_invoke` / `model_router_invoke_async`: unexpected
//   infrastructure failures resolve with an `InferenceResult`
//   `{ outcome: "error", error: { code: "internal-error", ... } }` — the same
//   envelope agents already handle for `invalid-request` / `secret-unavailable`
//   / `upstream-*`, with a fixed router-authored message.
// - `model_router_invoke_result`: a missing/unparsable `requestId` resolves
//   with `{ status: "not-found" }` (same as an unknown id); an unreadable
//   pending store resolves with `{ status: "error", error: { code:
//   "internal-error", ... } }` so agents retry instead of abandoning the poll.
// - A synchronously-throwing upstream fetch maps to `upstream-connect`
//   (a network failure before headers, per docs/contracts/compatible-upstream-v1.md),
//   not to a throw.

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_COMPANY = "99999999-9999-4999-8999-999999999999";
const SECRET = "resolved-secret-probe";

function openAiSuccess() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

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
  harness.ctx.http = {
    async fetch() { return openAiSuccess(); },
  };
  // The async submit+poll path bypasses ctx.http and uses the worker's own
  // global fetch; stub it with the same healthy upstream.
  vi.stubGlobal("fetch", async () => openAiSuccess());
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, configs };
}

function toolCtx(companyId: string = COMPANY_A) {
  return { companyId, runId: "run-conformance", agentId: "agent-conformance", projectId: "project-conformance" };
}

/** The conformance assertion: resolved, with a plain-object `data` and a string `content`. */
function expectDataObject(result: { content?: string; data?: unknown; error?: string }) {
  expect(result.error).toBeUndefined();
  expect(typeof result.content).toBe("string");
  expect(result.data).toBeDefined();
  expect(typeof result.data).toBe("object");
  expect(result.data).not.toBeNull();
  expect(Array.isArray(result.data)).toBe(false);
  return result.data as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP tool error-shape conformance", () => {
  it("every registered MCP tool is pinned here, so a fourth tool cannot escape conformance", () => {
    expect(Object.values(TOOL_NAMES).sort()).toEqual([
      "model_router_invoke",
      "model_router_invoke_async",
      "model_router_invoke_result",
    ]);
    expect(manifest.tools!.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL_NAMES).sort());
  });

  it("invoke resolves completed data on the happy path", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "completed", response: { modelId: expect.any(String) } });
  });

  it("invoke_async submit resolves pending data on the happy path", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invokeAsync, invocation, toolCtx()));
    expect(data).toMatchObject({ status: "pending", requestId: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("invoke_result resolves not-found data for an unknown request id", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(
      await harness.executeTool(TOOL_NAMES.invokeResult, { requestId: "never-submitted" }, toolCtx()),
    );
    expect(data).toEqual({ status: "not-found" });
  });

  it("invoke with an unavailable company config returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx(UNKNOWN_COMPANY)));
    expect(data).toMatchObject({
      outcome: "error",
      decision: null,
      response: null,
      error: { code: "invalid-config", retryable: false, upstreamStatus: null, upstreamRequestId: null },
    });
  });

  it("invoke_async with an unavailable company config returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invokeAsync, invocation, toolCtx(UNKNOWN_COMPANY)));
    expect(data).toMatchObject({
      outcome: "error",
      error: { code: "invalid-config", retryable: false, upstreamStatus: null, upstreamRequestId: null },
    });
  });

  it("invoke_result with null params returns not-found data instead of throwing", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invokeResult, null, toolCtx()));
    expect(data).toEqual({ status: "not-found" });
  });

  it("invoke_result with undefined params returns not-found data instead of throwing", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invokeResult, undefined, toolCtx()));
    expect(data).toEqual({ status: "not-found" });
  });

  it("invoke when the decision-record write fails returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.db.execute = async () => { throw new Error("decision store is down"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "internal-error" } });
  });

  it("invoke when plugin state reads fail returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.state.get = async () => { throw new Error("plugin state is down"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "internal-error" } });
  });

  it("invoke when the upstream fetch throws synchronously returns upstream-connect data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.http.fetch = () => { throw new Error("synchronous socket boom"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({
      outcome: "error",
      error: { code: "upstream-connect", retryable: true, upstreamStatus: null, upstreamRequestId: null },
    });
  });

  it("invoke when metric writes fail returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.metrics.write = async () => { throw new Error("metrics sink is down"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "internal-error" } });
  });

  it("invoke when the stickiness write fails returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = async (key, value) => {
      if (String(key.stateKey).includes("issue-stickiness")) throw new Error("stickiness store is down");
      return originalSet(key, value);
    };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "internal-error" } });
  });

  it("invoke_async submit when the pending-state write fails returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.state.set = async () => { throw new Error("pending store is down"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invokeAsync, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "internal-error" } });
  });

  it("invoke_result when plugin state reads fail returns error data instead of throwing", async () => {
    const { harness } = await testWorker();
    harness.ctx.state.get = async () => { throw new Error("pending store is down"); };
    const data = expectDataObject(
      await harness.executeTool(TOOL_NAMES.invokeResult, { requestId: "any-id" }, toolCtx()),
    );
    expect(data).toMatchObject({ status: "error", error: { code: "internal-error" } });
  });

  it("invoke with an invalid native request still returns invalid-request data", async () => {
    const { harness } = await testWorker();
    const data = expectDataObject(
      await harness.executeTool(TOOL_NAMES.invoke, { task: {}, messages: [], maxOutputTokens: 1 }, toolCtx()),
    );
    expect(data).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
  });

  it("invoke when credential resolution fails still returns secret-unavailable data", async () => {
    const { harness } = await testWorker();
    harness.ctx.secrets.resolve = async () => { throw new Error("vault is down"); };
    const data = expectDataObject(await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx()));
    expect(data).toMatchObject({ outcome: "error", error: { code: "secret-unavailable" } });
  });

  it("internal-error data carries a fixed router-authored message and leaks neither secrets nor infrastructure detail", async () => {
    const { harness } = await testWorker();
    harness.ctx.db.execute = async () => { throw new Error(`insert failed carrying ${SECRET} at 10.0.0.1`); };
    const result = await harness.executeTool(TOOL_NAMES.invoke, invocation, toolCtx());
    const data = expectDataObject(result);
    expect(data).toMatchObject({
      outcome: "error",
      error: {
        code: "internal-error",
        message: "The router encountered an internal error and could not complete this invocation.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("10.0.0.1");
    expect(JSON.stringify(result)).not.toContain("insert failed");
  });
});
