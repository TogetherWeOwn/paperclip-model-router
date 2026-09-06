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
  it("uses and records the tool run context", async () => {
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
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLog,
    })).toMatchObject([{
      agentId: "agent-a",
      runId: "run-a",
      stopReason: "end-turn",
    }]);
  });

  it("resolves the secret again for every invocation without caching", async () => {
    const { harness, secretCalls } = await sharedWorker();
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    expect(secretCalls).toEqual([
      { secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A, configPath: "upstream.credentialSecretRef" },
      { secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A, configPath: "upstream.credentialSecretRef" },
    ]);
  });

  it("uses and records the action host context", async () => {
    const { harness, httpCalls } = await sharedWorker();
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, {
      companyId: COMPANY_B,
      actor: { type: "agent", agentId: "agent-b", runId: "run-b" },
    }) as { outcome: string; response: { modelId: string } };
    expect(result).toMatchObject({ outcome: "completed", response: { modelId: "gpt-4.1" } });
    expect(httpCalls[0]?.url).toBe("https://company-b.example/compatible/v1/messages");
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_B,
      stateKey: STATE_KEYS.decisionLog,
    })).toMatchObject([{
      agentId: "agent-b",
      runId: "run-b",
      stopReason: "end-turn",
    }]);
  });

  it("records max-token completions without classifying them as errors", async () => {
    const { harness } = await sharedWorker();
    harness.ctx.http.fetch = async () => new Response(JSON.stringify({
      id: "chatcmpl-max",
      object: "chat.completion",
      model: "echo-a",
      choices: [{ index: 0, message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
      usage: { prompt_tokens: 2, completion_tokens: 100, total_tokens: 102 },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await harness.executeTool(TOOL_NAMES.invoke, invocation, {
      companyId: COMPANY_A,
      runId: "run-max",
      agentId: "agent-max",
      projectId: "project-a",
    });
    expect(result.data).toMatchObject({
      outcome: "completed",
      response: { stopReason: "max-tokens" },
    });
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLog,
    })).toMatchObject([{
      agentId: "agent-max",
      runId: "run-max",
      outcome: "completed",
      errorCode: null,
      stopReason: "max-tokens",
    }]);
  });

  it.each([
    ["invalid URL", { baseUrl: "https://user:pass@company-a.example/api" }],
    ["unknown protocol", { protocol: "future-provider-wire" }],
    ["timeout below runtime bound", { requestTimeoutMs: 999 }],
    ["response ceiling above runtime bound", { maxResponseBytes: 16_777_217 }],
  ])("rejects %s in stored upstream config before secret resolution or HTTP", async (_label, patch) => {
    const { harness, httpCalls, secretCalls, configs } = await sharedWorker();
    const invalid = structuredClone(configs.get(COMPANY_A)!);
    Object.assign(invalid.upstream as Record<string, unknown>, patch);
    configs.set(COMPANY_A, invalid);
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; error: { code: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "upstream-url-rejected" } });
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  // TOG-1035. effectiveRequestTimeoutMs is unit-tested, but nothing asserted that the
  // worker actually hands it the selected model's entry. Dropping that spread leaves
  // every per-model budget silently inert and still typechecks.
  it("applies the selected model's requestTimeoutMs to the real invocation", async () => {
    const { harness, configs } = await sharedWorker();
    const slow = structuredClone(configs.get(COMPANY_A)!);
    (slow.upstream as Record<string, unknown>).requestTimeoutMs = 1_000;
    // "implementation" selects minimax-m2.5 in this fixture.
    const selected = (slow.models as Array<Record<string, unknown>>).find((m) => m.id === "minimax-m2.5")!;
    selected.requestTimeoutMs = 120_000;
    configs.set(COMPANY_A, slow);
    harness.ctx.http.fetch = async () =>
      await new Promise<Response>((resolve) => setTimeout(() => resolve(success("openai")), 1_600));

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string };
    // Outlives the 1s upstream budget purely because the model carries its own.
    expect(result).toMatchObject({ outcome: "completed" });
  });

  it("lets a fast model still fail fast while a long ceiling is configured", async () => {
    const { harness, configs } = await sharedWorker();
    const mixed = structuredClone(configs.get(COMPANY_A)!);
    (mixed.upstream as Record<string, unknown>).requestTimeoutMs = 1_000;
    // The 300s ceiling is configured on a *different* model; the selected one inherits.
    (mixed.models as Array<Record<string, unknown>>).find((m) => m.id === "claude-sonnet-5")!.requestTimeoutMs = 300_000;
    configs.set(COMPANY_A, mixed);
    harness.ctx.http.fetch = async () =>
      await new Promise<Response>((resolve) => setTimeout(() => resolve(success("openai")), 1_600));

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; error: { code: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "upstream-timeout" } });
  });

  it("rejects fixed semantic headers in stored config before secret resolution or HTTP", async () => {
    const { harness, httpCalls, secretCalls, configs } = await sharedWorker();
    const invalid = structuredClone(configs.get(COMPANY_A)!);
    Object.assign((invalid.upstream as Record<string, unknown>).extraHeaders as Record<string, string>, {
      "aNtHrOpIc-BeTa": "unsafe",
      "content-TYPE": "text/plain",
      Accept: "text/event-stream",
    });
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

  it("derives vision from OpenAI-profile image input before selecting a model", async () => {
    const { harness, httpCalls } = await sharedWorker();
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      task: { taskClass: "implementation" },
      messages: [{ role: "user", content: [{ type: "image_url", url: "https://images.example/a.png" }] }],
      maxOutputTokens: 10,
    }, { companyId: COMPANY_A }) as { outcome: string; decision: { modelId: string }; response: { modelId: string } };
    expect(result).toMatchObject({
      outcome: "completed",
      decision: { modelId: "claude-sonnet-5" },
      response: { modelId: "claude-sonnet-5" },
    });
    expect(httpCalls).toHaveLength(1);
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

  it("refreshes capacity separately, preserves valid state on failure, and invoke makes zero telemetry GETs", async () => {
    const { harness, configs, httpCalls, secretCalls } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    config.capacityRouting = {
      enabled: true, mode: "shadow", unknownTelemetry: "fail-closed",
      sources: [{ id: "capacity", statusUrl: "https://capacity.example/status", modelIds: ["minimax-m2.5"], healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144, windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }] }],
    };
    configs.set(COMPANY_A, config);
    harness.ctx.http.fetch = async (url, init) => {
      httpCalls.push({ url: String(url), init });
      if (String(url).includes("capacity.example")) return new Response(JSON.stringify({ rows: [{ lane: "fresh", status: "ok", used: 0.2 }] }), { status: 200, headers: { "content-type": "application/json" } });
      return success("openai");
    };
    await harness.performAction(ACTION_KEYS.refreshCapacity, { companyId: COMPANY_B }, { companyId: COMPANY_A });
    const valid = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot });
    expect(valid).toMatchObject({ evidence: [expect.objectContaining({ modelId: "minimax-m2.5", laneLabel: "record-1" })] });
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_B, stateKey: STATE_KEYS.capacitySnapshot })).toBeUndefined();
    const beforeInvoke = httpCalls.filter((call) => call.init?.method === "GET").length;
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    expect(httpCalls.filter((call) => call.init?.method === "GET")).toHaveLength(beforeInvoke);
    harness.ctx.http.fetch = async (url, init) => {
      httpCalls.push({ url: String(url), init });
      if (String(url).includes("capacity.example")) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      return success("openai");
    };
    const failed = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });
    expect(failed).toMatchObject({ error: "capacity-http-failed" });
    const afterFailure = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot });
    expect(afterFailure).toMatchObject({ evidence: (valid as { evidence: unknown[] }).evidence, lastRefreshError: "capacity-http-failed" });
    const getsBeforeEnforce = httpCalls.filter((call) => call.init?.method === "GET").length;
    (config.capacityRouting as { mode: string }).mode = "enforce";
    configs.set(COMPANY_A, config);
    const enforced = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; decision: { capacity: { telemetry: string } } };
    expect(enforced).toMatchObject({ outcome: "no-eligible-model", decision: { capacity: { telemetry: "unavailable" } } });
    expect(httpCalls.filter((call) => call.init?.method === "GET")).toHaveLength(getsBeforeEnforce);
    expect(JSON.stringify([failed, afterFailure, secretCalls])).not.toContain("leaked capacity body");
  });

  it("rejects mixed valid and malformed refresh records and preserves prior evidence", async () => {
    const { harness, configs } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    config.capacityRouting = {
      enabled: true, mode: "enforce", unknownTelemetry: "fail-closed",
      sources: [{ id: "capacity", statusUrl: "https://capacity.example/status", modelIds: ["minimax-m2.5"], healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144, windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }] }],
    };
    configs.set(COMPANY_A, config);
    let mixed = false;
    harness.ctx.http.fetch = async (url) => {
      if (!String(url).includes("capacity.example")) return success("openai");
      const rows = mixed
        ? [{ status: "ok", used: 0.2 }, { status: "unknown", used: 0.3 }]
        : [{ status: "ok", used: 0.2 }];
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });
    const valid = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot }) as { evidence: unknown[] };
    mixed = true;
    const failed = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });
    expect(failed).toMatchObject({ error: "capacity-refresh-incomplete" });
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot })).toMatchObject({ evidence: valid.evidence, lastRefreshError: "capacity-refresh-incomplete" });
  });

  it("fails closed on a stale stored capacity snapshot", async () => {
    const { harness, configs, httpCalls } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    config.capacityRouting = {
      enabled: true, mode: "enforce", unknownTelemetry: "fail-closed", maxSnapshotAgeMs: 1000,
      sources: [{ id: "capacity", statusUrl: "https://capacity.example/status", modelIds: ["minimax-m2.5"], healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144, windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }] }],
    };
    configs.set(COMPANY_A, config);
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot }, {
      refreshedAt: "2000-01-01T00:00:00.000Z", lastRefreshError: null, snapshots: [],
      evidence: [{ modelId: "minimax-m2.5", source: "capacity", laneLabel: "stale", health: "healthy", posture: "available", utilization: 0.1, remainingFraction: 0.9, resetsAt: null, resetInSeconds: null, windows: [], telemetryAvailable: true, reason: "old" }],
    });
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { outcome: string; decision: { capacity: { telemetry: string } } };
    expect(result).toMatchObject({ outcome: "no-eligible-model", decision: { capacity: { telemetry: "unavailable" } } });
    expect(httpCalls).toHaveLength(0);
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
    const { definition, harness } = await sharedWorker();
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
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLog,
    })).toMatchObject([
      { agentId: "agent-a", runId: "run-a", stopReason: "end-turn" },
      { agentId: "agent-a", runId: "run-a", stopReason: null },
    ]);
  });
});
