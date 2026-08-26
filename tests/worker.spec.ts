import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, ROUTE_KEYS, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET_A = "resolved-secret-a";
const SECRET_B = "resolved-secret-b";

function success(protocol: "openai" | "anthropic") {
  return protocol === "openai"
    ? new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } })
    : new Response(JSON.stringify({ id: "msg-1", type: "message", role: "assistant", model: "echo-b", content: [{ type: "text", text: "hello b" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-b" } });
}

async function sharedWorker() {
  const configs = new Map([
    [COMPANY_A, readFixture("company-a")],
    [COMPANY_B, readFixture("company-b")],
  ]);
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get(companyId) {
      const config = configs.get(String(companyId));
      if (!config) throw new Error("missing company config");
      return structuredClone(config);
    },
  };
  const secretCalls: Array<{ secretId: string; companyId?: string; configPath?: string }> = [];
  harness.ctx.secrets = {
    async resolve(ref, options) {
      const secretId = typeof ref === "object" && ref ? String(ref.secretId) : String(ref);
      secretCalls.push({ secretId, ...options });
      return options?.companyId === COMPANY_A ? SECRET_A : SECRET_B;
    },
  };
  const httpCalls: Array<{ url: string; init?: RequestInit }> = [];
  harness.ctx.http = {
    async fetch(url, init) {
      httpCalls.push({ url: String(url), init });
      return String(url).includes("company-a.example") ? success("openai") : success("anthropic");
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition, httpCalls, secretCalls, configs };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

describe("one select-invoke-normalize-record path", () => {
  it("uses the tool run context company", async () => {
    const { harness, httpCalls, secretCalls } = await sharedWorker();
    const result = await harness.executeTool(TOOL_NAMES.invoke, invocation, {
      companyId: COMPANY_A,
      runId: "run-a",
      agentId: "agent-a",
      projectId: "project-a",
    });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ outcome: "completed", response: { modelId: "minimax-m2.5" } });
    expect(httpCalls[0]?.url).toBe("https://company-a.example/api/v1/chat/completions");
    expect(secretCalls).toEqual([{ secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A, configPath: "upstream.credentialSecretRef" }]);
  });

  it("uses the action host context and returns the same InferenceResult", async () => {
    const { harness, httpCalls } = await sharedWorker();
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, {
      companyId: COMPANY_B,
      actor: { type: "agent", agentId: "agent-b", runId: "run-b" },
    }) as { outcome: string; response: { modelId: string } };
    expect(result).toMatchObject({ outcome: "completed", response: { modelId: "gpt-4.1" } });
    expect(httpCalls[0]?.url).toBe("https://company-b.example/compatible/v1/messages");
  });

  it("rejects invalid stored upstream config before secret resolution or HTTP", async () => {
    const { harness, httpCalls, secretCalls, configs } = await sharedWorker();
    const invalid = structuredClone(configs.get(COMPANY_A)!);
    (invalid.upstream as Record<string, unknown>).baseUrl = "https://user:pass@company-a.example/api";
    configs.set(COMPANY_A, invalid);
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; error: { code: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "upstream-url-rejected" } });
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("rejects Anthropic-profile image input before secret resolution or HTTP", async () => {
    const { harness, httpCalls, secretCalls } = await sharedWorker();
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      task: { taskClass: "implementation", requiredCapabilities: ["vision"] },
      messages: [{ role: "user", content: [{ type: "image_url", url: "https://images.example/a.png" }] }],
      maxOutputTokens: 10,
    }, { companyId: COMPANY_B }) as { outcome: string; error: { code: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("makes zero HTTP and secret calls for Rule 0", async () => {
    const { harness, httpCalls, secretCalls } = await sharedWorker();
    const result = await harness.executeTool(TOOL_NAMES.invoke, {
      task: { taskClass: "mechanical", summary: "lint the repo" },
      messages: [{ role: "user", content: "lint" }],
      maxOutputTokens: 10,
    }, { companyId: COMPANY_A, runId: "run-a", agentId: "agent-a", projectId: "project-a" });
    expect(result.data).toMatchObject({ outcome: "no-model-needed" });
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("keeps two companies' config, secrets, wires, and state isolated in one worker", async () => {
    const { harness, httpCalls, secretCalls } = await sharedWorker();
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_B });
    expect(httpCalls.map((call) => call.url)).toEqual([
      "https://company-a.example/api/v1/chat/completions",
      "https://company-b.example/compatible/v1/messages",
    ]);
    expect(secretCalls.map((call) => [call.secretId, call.companyId])).toEqual([
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", COMPANY_A],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", COMPANY_B],
    ]);
    const logA = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.decisionLog }) as unknown[];
    const logB = harness.getState({ scopeKind: "company", scopeId: COMPANY_B, stateKey: STATE_KEYS.decisionLog }) as unknown[];
    expect(logA).toHaveLength(1);
    expect(logB).toHaveLength(1);
    expect(JSON.stringify(logA)).not.toContain(SECRET_A);
    expect(JSON.stringify(logA)).not.toContain("hello");
    expect(JSON.stringify(logB)).not.toContain(SECRET_B);
  });

  it("records upstream errors without replay, secret, body, or provider identity", async () => {
    const { harness } = await sharedWorker();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: `leaked ${SECRET_A}` } }), { status: 429, headers: { "content-type": "application/json", "x-request-id": "rate-1" } }));
    harness.ctx.http.fetch = fetch;
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; error: { code: string; upstreamRequestId: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "upstream-rate-limit", upstreamRequestId: "rate-1" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(SECRET_A);
    expect(JSON.stringify(result)).not.toContain("leaked");
  });
});

describe("scoped routes", () => {
  it("returns HTTP 200 for completed upstream failures and HTTP 400 only for invalid native requests", async () => {
    const { definition } = await sharedWorker();
    const invalid = await definition.onApiRequest!({
      routeKey: ROUTE_KEYS.invoke,
      method: "POST",
      path: "/invoke",
      params: {},
      query: { companyId: COMPANY_A },
      body: { task: {}, messages: [], maxOutputTokens: 1 },
      actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(invalid.status).toBe(400);

    const completed = await definition.onApiRequest!({
      routeKey: ROUTE_KEYS.invokeIssue,
      method: "POST",
      path: "/issues/issue-route/invoke",
      params: { issueId: "issue-route" },
      query: {},
      body: { task: { taskClass: "implementation", issueId: "spoof" }, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 10 },
      actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: "completed", decision: { taskClass: "implementation" } });
  });
});
