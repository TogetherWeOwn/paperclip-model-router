import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, PENDING_INVOCATION_TTL_MS, ROUTE_KEYS, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

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
  const defaultUpstream = (url: unknown): Response =>
    String(url).includes("company-a.example") ? success("openai") : success("anthropic");
  harness.ctx.http = {
    async fetch(url, init) {
      httpCalls.push({ url: String(url), init });
      return defaultUpstream(url);
    },
  };
  // The async (submit + poll) path deliberately bypasses ctx.http and uses the
  // worker's own global fetch (see directFetchHttpClient). Stub it with the same
  // default upstream so async tests reach a working upstream unless they override
  // it; afterEach() unstubs. Individual async tests replace this via vi.stubGlobal.
  vi.stubGlobal("fetch", async (url: string, _init?: RequestInit) => defaultUpstream(url));
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition, httpCalls, secretCalls, configs };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable decision records", () => {
  it("reconciles the legacy ring buffer and keeps appending after 200 records", async () => {
    const { harness } = await sharedWorker();
    const legacy = Array.from({ length: 200 }, (_, index) => ({
      at: new Date(Date.now() - index * 1_000).toISOString(),
      requestId: `legacy-${index}`,
      runId: null,
      issueId: null,
      taskClass: "implementation",
      selectionOutcome: "selected",
      modelId: "minimax-m2.5",
      fallbackUsed: false,
      upstreamProtocol: "openai-chat-completions",
      outcome: "completed",
      errorCode: null,
      upstreamStatus: null,
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      upstreamRequestId: null,
      capacityMode: "disabled",
      capacityTelemetry: "not-evaluated",
      capacityLane: null,
      capacityLaneLabel: null,
      capacityPosture: "not-evaluated",
      capacityReason: null,
      capacityDegraded: false,
      shadowModelId: null,
    }));
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.legacyDecisionLog,
    }, legacy);

    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    const records = companyDecisionRecords(harness, COMPANY_A);
    expect(records).toHaveLength(202);
    expect(records.filter((record) => String(record.requestId).startsWith("legacy-"))).toHaveLength(200);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.legacyDecisionLog,
    })).toEqual(legacy);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLogMigration,
    })).toMatchObject({ reconciledAt: expect.any(String) });
  });

  it("reconciles records written by the legacy worker during an artifact rollback", async () => {
    const first = await sharedWorker();
    await first.harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.legacyDecisionLog,
    }, [{
      at: new Date().toISOString(),
      requestId: "before-rollback",
      outcome: "completed",
    }]);
    await first.harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    const second = await sharedWorker();
    for (const key of [STATE_KEYS.decisionLogMigration, STATE_KEYS.legacyDecisionLog]) {
      const state = first.harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: key });
      if (key === STATE_KEYS.legacyDecisionLog) {
        (state as Array<Record<string, unknown>>).unshift({
          at: new Date().toISOString(),
          requestId: "during-rollback",
          outcome: "completed",
        });
      }
      await second.harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY_A, stateKey: key }, state);
    }

    await second.harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    expect(companyDecisionRecords(second.harness, COMPANY_A).map((record) => record.requestId))
      .toContain("during-rollback");
  });

  it("does not import legacy records outside the 90-day retention window", async () => {
    const { harness } = await sharedWorker();
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.legacyDecisionLog,
    }, [{
      at: "2000-01-01T00:00:00.000Z",
      requestId: "expired",
      outcome: "completed",
    }]);

    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(1);
    expect(companyDecisionRecords(harness, COMPANY_A)[0]?.requestId).not.toBe("expired");
  });

  it("prunes the explicit 90-day retention window at worker startup", async () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const harness = createTestHarness({ manifest, config: {} });
      const retained = [
        { requestId: "outside", recordedAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000 - 1) },
        { requestId: "inside", recordedAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000 + 1) },
      ];
      harness.ctx.db.execute = async (sql, params) => {
        const cutoff = new Date(String(params?.[0])).getTime() - Number(params?.[1]) * 24 * 60 * 60 * 1_000;
        for (let index = retained.length - 1; index >= 0; index -= 1) {
          if (retained[index]!.recordedAt.getTime() < cutoff) retained.splice(index, 1);
        }
        harness.dbExecutes.push({ sql, params });
        return { rowCount: 1 };
      };
      const { definition } = createPlugin();
      await definition.setup(harness.ctx);

      expect(harness.dbExecutes[0]).toMatchObject({ params: [now.toISOString(), 90] });
      expect(harness.dbExecutes[0]?.sql).toContain("$2 * interval '1 day'");
      expect(retained.map((record) => record.requestId)).toEqual(["inside"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
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
    expect(companyDecisionRecords(harness, COMPANY_B)).toMatchObject([{
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
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
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

    // TOG-3419: the sync-budget preflight derives its ceiling from the same
    // 1_000ms the selected model inherits here, so maxOutputTokens has to fit
    // that tiny test budget or the request is rejected before ever reaching
    // the transport this test means to exercise.
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      { ...invocation, maxOutputTokens: 10 },
      { companyId: COMPANY_A },
    ) as { outcome: string; error: { code: string } };
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
    const logA = companyDecisionRecords(harness, COMPANY_A);
    const logB = companyDecisionRecords(harness, COMPANY_B);
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

  it("persists fresh pace independently of legacy capacity evidence and clears it on refresh failure", async () => {
    const { harness, configs } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    (config.routing as { stickyModelWithinIssue: boolean }).stickyModelWithinIssue = false;
    const expensive = (config.models as Array<{ id: string; tier: string }>).find((model) => model.id === "claude-sonnet-5");
    if (!expensive) throw new Error("missing expensive test model");
    expensive.tier = "standard";
    config.capacityRouting = {
      enabled: true,
      mode: "enforce",
      unknownTelemetry: "fail-open",
      paceOrdering: true,
      maxSnapshotAgeMs: 300_000,
      sources: [
        {
          id: "expensive-behind",
          statusUrl: "https://capacity.example/behind",
          modelIds: ["claude-sonnet-5"],
          healthFields: ["health"],
          requestTimeoutMs: 5000,
          maxResponseBytes: 262144,
          windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
          pace: {
            laneId: "expensive-behind",
            healthFields: ["health"],
            windows: [{ name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"], defaultWindowSeconds: 604800 }],
          },
        },
        {
          id: "cheap-ahead",
          statusUrl: "https://capacity.example/ahead",
          modelIds: ["minimax-m2.5"],
          healthFields: ["health"],
          requestTimeoutMs: 5000,
          maxResponseBytes: 262144,
          windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
          pace: {
            laneId: "cheap-ahead",
            healthFields: ["health"],
            windows: [{ name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"], defaultWindowSeconds: 604800 }],
          },
        },
      ],
    };
    configs.set(COMPANY_A, config);
    const observedAt = new Date();
    const laneDocument = (utilization: number, resetDays: number) => ({
      schemaVersion: 1,
      observedAt: observedAt.toISOString(),
      staleAfterSeconds: 300,
      records: [{
        health: "healthy",
        governing_window: "weekly",
        window_seconds: { weekly: 604800 },
        weekly_utilization: utilization,
        weekly_resets_at: new Date(observedAt.getTime() + resetDays * 24 * 60 * 60 * 1_000).toISOString(),
      }],
    });
    let fail = false;
    harness.ctx.http.fetch = async (url) => {
      if (!String(url).includes("capacity.example")) return success("openai");
      if (fail) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      const behind = String(url).endsWith("/behind");
      return new Response(JSON.stringify(behind ? laneDocument(0.1, 1) : laneDocument(0.95, 3)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const refreshed = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A }) as {
      error: string;
      paceVerdicts: Record<string, { state: string }>;
    };
    expect(refreshed.error).toContain("capacity payload carried no recognizable telemetry records");
    expect(["behind", "behind-urgent"]).toContain(refreshed.paceVerdicts["expensive-behind"]?.state);
    expect(refreshed.paceVerdicts["cheap-ahead"]?.state).toBe("ahead");
    const storedFresh = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot });
    expect(storedFresh).toMatchObject({
      paceRefreshedAt: expect.any(String),
      paceVerdicts: {
        "expensive-behind": expect.objectContaining({ state: expect.stringMatching(/^behind/) }),
        "cheap-ahead": expect.objectContaining({ state: "ahead" }),
      },
    });
    const paceSelected = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { decision: { modelId: string } };
    expect(paceSelected.decision.modelId).toBe("claude-sonnet-5");

    fail = true;
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });
    const storedFailed = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot });
    expect(storedFailed).toMatchObject({ paceVerdicts: {}, lastRefreshError: expect.stringContaining("capacity-http-failed") });
    const staticSelected = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { decision: { modelId: string } };
    expect(staticSelected.decision.modelId).toBe("minimax-m2.5");
  });

  // TOG-2922: the prerequisite config lands `source.pace` with paceOrdering
  // still false. If evaluation were gated on the same flag as steering, that
  // refresh would store zero verdicts and the later one-key enable would start
  // cold. Warm-but-inert is the contract: verdicts present, selection unmoved.
  it("stores pace verdicts on refresh while paceOrdering is off without steering selection", async () => {
    const { harness, configs } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    (config.routing as { stickyModelWithinIssue: boolean }).stickyModelWithinIssue = false;
    const expensive = (config.models as Array<{ id: string; tier: string }>).find((model) => model.id === "claude-sonnet-5");
    if (!expensive) throw new Error("missing expensive test model");
    expensive.tier = "standard";
    const paceWindows = [{ name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"], defaultWindowSeconds: 604800 }];
    config.capacityRouting = {
      enabled: true,
      mode: "enforce",
      unknownTelemetry: "fail-open",
      // The one thing that differs from the steering test above.
      paceOrdering: false,
      maxSnapshotAgeMs: 300_000,
      sources: [
        {
          id: "expensive-behind",
          statusUrl: "https://capacity.example/behind",
          modelIds: ["claude-sonnet-5"],
          healthFields: ["health"],
          requestTimeoutMs: 5000,
          maxResponseBytes: 262144,
          windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
          pace: { laneId: "expensive-behind", healthFields: ["health"], windows: paceWindows },
        },
        {
          id: "cheap-ahead",
          statusUrl: "https://capacity.example/ahead",
          modelIds: ["minimax-m2.5"],
          healthFields: ["health"],
          requestTimeoutMs: 5000,
          maxResponseBytes: 262144,
          windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
          pace: { laneId: "cheap-ahead", healthFields: ["health"], windows: paceWindows },
        },
      ],
    };
    configs.set(COMPANY_A, config);
    const observedAt = new Date();
    const laneDocument = (utilization: number, resetDays: number) => ({
      schemaVersion: 1,
      observedAt: observedAt.toISOString(),
      staleAfterSeconds: 300,
      records: [{
        health: "healthy",
        governing_window: "weekly",
        window_seconds: { weekly: 604800 },
        weekly_utilization: utilization,
        weekly_resets_at: new Date(observedAt.getTime() + resetDays * 24 * 60 * 60 * 1_000).toISOString(),
      }],
    });
    harness.ctx.http.fetch = async (url) => {
      if (!String(url).includes("capacity.example")) return success("openai");
      const behind = String(url).endsWith("/behind");
      return new Response(JSON.stringify(behind ? laneDocument(0.1, 1) : laneDocument(0.95, 3)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const refreshed = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A }) as {
      paceVerdicts: Record<string, { state: string }>;
    };
    expect(["behind", "behind-urgent"]).toContain(refreshed.paceVerdicts["expensive-behind"]?.state);
    expect(refreshed.paceVerdicts["cheap-ahead"]?.state).toBe("ahead");
    const stored = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot });
    expect(stored).toMatchObject({
      paceRefreshedAt: expect.any(String),
      paceVerdicts: {
        "expensive-behind": expect.objectContaining({ state: expect.stringMatching(/^behind/) }),
        "cheap-ahead": expect.objectContaining({ state: "ahead" }),
      },
    });

    // Same lanes, same verdicts, flag off: selection must stay on the static
    // winner the steering test moved off. This is the half that proves the
    // enable is still a real, isolated one-key change.
    const selected = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as { decision: { modelId: string } };
    expect(selected.decision.modelId).toBe("minimax-m2.5");
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

  // TOG-3551 (scope 4): the refresh publishes a per-lane `laneDown` map keyed by
  // SOURCE id into plugin_state for the host dispatch-sweep / repinPass. A lane
  // is down when its source errored or its evidence cannot serve; a total fetch
  // failure must OVERWRITE a prior "up" rather than leave it stale.
  it("publishes a per-lane laneDown map and overwrites it on a failed refresh", async () => {
    const { harness, configs } = await sharedWorker();
    const config = structuredClone(configs.get(COMPANY_A)!);
    config.capacityRouting = {
      enabled: true, mode: "enforce", unknownTelemetry: "fail-open",
      sources: [
        { id: "healthy-lane", statusUrl: "https://capacity.example/healthy", modelIds: ["minimax-m2.5"], healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144, windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }] },
        { id: "dead-lane", statusUrl: "https://capacity.example/dead", modelIds: ["claude-sonnet-5"], healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144, windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }] },
      ],
    };
    configs.set(COMPANY_A, config);
    let fail = false;
    harness.ctx.http.fetch = async (url) => {
      const target = String(url);
      if (!target.includes("capacity.example")) return success("openai");
      if (fail) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      const rows = target.endsWith("/dead") ? [{ status: "exhausted", used: 0.99 }] : [{ status: "ok", used: 0.2 }];
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const refreshed = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A }) as { laneDown: Record<string, boolean> };
    expect(refreshed.laneDown).toEqual({ "healthy-lane": false, "dead-lane": true });
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot })).toMatchObject({
      lastRefreshError: null,
      laneDown: { "healthy-lane": false, "dead-lane": true },
    });

    fail = true;
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.capacitySnapshot })).toMatchObject({
      laneDown: { "healthy-lane": true, "dead-lane": true },
    });
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
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([
      { agentId: "agent-a", runId: "run-a", stopReason: "end-turn" },
      { agentId: "agent-a", runId: "run-a", stopReason: null },
    ]);
  });

  it("returns HTTP 202 for a pending async submission and 200 once its poll completes", async () => {
    const { definition, configs } = await sharedWorker();
    const mutated = structuredClone(configs.get(COMPANY_A)!);
    (mutated.models as Array<Record<string, unknown>>).find((m) => m.id === "claude-sonnet-5")!.requestTimeoutMs = 60_000;
    configs.set(COMPANY_A, mutated);

    const submitResponse = await definition.onApiRequest!({
      routeKey: ROUTE_KEYS.invokeAsync,
      method: "POST",
      path: "/invoke-async",
      params: {},
      query: { companyId: COMPANY_A },
      body: { ...invocation, task: { ...invocation.task, pinnedModelId: "claude-sonnet-5" } },
      actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(submitResponse.status).toBe(202);
    const requestId = (submitResponse.body as { requestId: string }).requestId;
    expect(requestId).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollResponse = await definition.onApiRequest!({
      routeKey: ROUTE_KEYS.invokeResult,
      method: "GET",
      path: `/invoke/${requestId}`,
      params: { requestId },
      query: { companyId: COMPANY_A },
      body: {},
      actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(pollResponse.status).toBe(200);
    expect(pollResponse.body).toMatchObject({ status: "completed", outcome: "completed" });
  });
});

describe("sync budget preflight (TOG-3419)", () => {
  it("rejects an unreachable maxOutputTokens before stickiness, secret access, or upstream", async () => {
    const { harness, httpCalls, secretCalls } = await sharedWorker();
    const request = {
      ...invocation,
      // company-a's default upstream requestTimeoutMs (25s) derives a ~1071
      // token sync budget for claude-sonnet-5; 5000 is comfortably unreachable.
      maxOutputTokens: 5_000,
      task: { ...invocation.task, pinnedModelId: "claude-sonnet-5" },
    };

    const startedAt = Date.now();
    const result = await harness.performAction(ACTION_KEYS.invoke, request, { companyId: COMPANY_A }) as {
      outcome: string;
      error: { code: string; message: string };
    };
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(result.error.message).toContain("claude-sonnet-5");
    expect(result.error.message).toContain(TOOL_NAMES.invokeAsync);
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.issueStickiness,
    })).toBeUndefined();
    expect(elapsedMs).toBeLessThan(50);
  });

  it("still lets an in-budget request reach upstream on the synchronous path, unchanged", async () => {
    const { harness, httpCalls } = await sharedWorker();
    const request = { ...invocation, maxOutputTokens: 100, task: { ...invocation.task, pinnedModelId: "claude-sonnet-5" } };
    const result = await harness.performAction(ACTION_KEYS.invoke, request, { companyId: COMPANY_A }) as { outcome: string };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });
});

describe("async invoke (submit + poll)", () => {
  it("returns pending immediately and completes on poll, using the model's own uncapped timeout", async () => {
    const { harness, configs } = await sharedWorker();
    const mutated = structuredClone(configs.get(COMPANY_A)!);
    (mutated.models as Array<Record<string, unknown>>).find((m) => m.id === "claude-sonnet-5")!.requestTimeoutMs = 120_000;
    configs.set(COMPANY_A, mutated);

    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async () =>
        await new Promise<Response>((resolve) => setTimeout(() => resolve(success("openai")), 90_000)));

      const request = { ...invocation, task: { ...invocation.task, pinnedModelId: "claude-sonnet-5" } };
      const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, request, { companyId: COMPANY_A }) as {
        status: string;
        requestId: string;
        decision: { modelId: string };
      };
      expect(submitted).toMatchObject({ status: "pending", decision: { modelId: "claude-sonnet-5" } });
      expect(submitted.requestId).toBeTruthy();

      const stillRunning = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A });
      expect(stillRunning).toMatchObject({ status: "pending" });

      // 90s of simulated upstream latency: past the host's 30s RPC cap and
      // the sync path's 28s ceiling, within the model's 120s override.
      await vi.advanceTimersByTimeAsync(90_000);

      const finished = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A }) as {
        status: string;
        outcome: string;
        response: { modelId: string };
      };
      expect(finished).toMatchObject({ status: "completed", outcome: "completed", response: { modelId: "claude-sonnet-5" } });
      expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
        outcome: "completed",
        modelId: "claude-sonnet-5",
        latencyMs: 90_000,
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps concurrent request ids independently pollable", async () => {
    const { harness } = await sharedWorker();
    const originalGet = harness.ctx.state.get.bind(harness.ctx.state);
    let pendingReads = 0;
    let releaseReads!: () => void;
    const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve; });
    harness.ctx.state.get = async (input) => {
      const value = await originalGet(input);
      // This barrier deterministically reproduces the old shared-map race. The
      // per-request implementation never reads this legacy aggregate key.
      if (input.stateKey === STATE_KEYS.pendingInvocations) {
        pendingReads += 1;
        if (pendingReads === 2) releaseReads();
        await bothReadsStarted;
      }
      return structuredClone(value);
    };
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));

    const [first, second] = await Promise.all([
      harness.performAction(ACTION_KEYS.invokeAsync, {
        ...invocation,
        task: { ...invocation.task, issueId: "concurrent-1" },
      }, { companyId: COMPANY_A }),
      harness.performAction(ACTION_KEYS.invokeAsync, {
        ...invocation,
        task: { ...invocation.task, issueId: "concurrent-2" },
      }, { companyId: COMPANY_A }),
    ]) as [{ requestId: string }, { requestId: string }];

    expect(first.requestId).not.toBe(second.requestId);
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: first.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: second.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps a successful terminal outcome when audit persistence fails", async () => {
    const { harness } = await sharedWorker();
    const execute = harness.ctx.db.execute.bind(harness.ctx.db);
    let failedInsert = false;
    harness.ctx.db.execute = async (sql, params) => {
      if (!failedInsert && /insert\s+into/i.test(sql)) {
        failedInsert = true;
        throw new Error("simulated audit write failure");
      }
      return execute(sql, params);
    };

    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, { companyId: COMPANY_A }) as {
      requestId: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 0));

    const polled = await harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    );
    expect(failedInsert).toBe(true);
    expect(polled).toMatchObject({ status: "completed", outcome: "completed" });
    expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(0);
  });

  it("records a terminal error on poll when the background upstream call fails", async () => {
    const { harness, configs } = await sharedWorker();
    const mutated = structuredClone(configs.get(COMPANY_A)!);
    (mutated.models as Array<Record<string, unknown>>).find((m) => m.id === "claude-sonnet-5")!.requestTimeoutMs = 60_000;
    configs.set(COMPANY_A, mutated);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } }));

    const request = { ...invocation, task: { ...invocation.task, pinnedModelId: "claude-sonnet-5" } };
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, request, { companyId: COMPANY_A }) as { status: string; requestId: string };
    expect(submitted.status).toBe("pending");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A }) as {
      status: string;
      outcome: string;
    };
    expect(polled).toMatchObject({ status: "error", outcome: "error" });
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{ outcome: "error" }]);
  });

  it("returns not-found for an unknown requestId", async () => {
    const { harness } = await sharedWorker();
    const polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: "never-submitted" }, { companyId: COMPANY_A });
    expect(polled).toEqual({ status: "not-found" });
  });

  it("physically deletes a terminal response when its TTL expires", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const { harness } = await sharedWorker();
      const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, { companyId: COMPANY_A }) as {
        requestId: string;
      };
      await vi.advanceTimersByTimeAsync(0);

      const stateKey = `${STATE_KEYS.pendingInvocations}:${submitted.requestId}`;
      expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey }))
        .toMatchObject({ status: "completed", response: { content: [{ text: "hello a" }] } });

      await vi.advanceTimersByTimeAsync(PENDING_INVOCATION_TTL_MS + 1);

      expect(harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey })).toBeUndefined();
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toEqual({ status: "not-found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a pending record after its TTL, independent of whether the background call ever finishes", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const { harness } = await sharedWorker();
      vi.stubGlobal("fetch", async () =>
        await new Promise<Response>((resolve) => setTimeout(() => resolve(success("openai")), 60_000)));

      const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, { companyId: COMPANY_A }) as { requestId: string };

      vi.setSystemTime(new Date(start.getTime() + PENDING_INVOCATION_TTL_MS + 1_000));

      const polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A });
      expect(polled).toEqual({ status: "not-found" });
      expect(harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_A,
        stateKey: `${STATE_KEYS.pendingInvocations}:${submitted.requestId}`,
      })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TOG-3419 simulated overrun regression", () => {
  it("the sync path refuses the request outright while async invoke completes it past 28s", async () => {
    const { harness, httpCalls, configs } = await sharedWorker();
    const mutated = structuredClone(configs.get(COMPANY_A)!);
    (mutated.models as Array<Record<string, unknown>>).push({
      id: "cliproxy/glm-5.3-flash",
      tier: "strong",
      quality: 80,
      costPerMTokIn: 0.5,
      costPerMTokOut: 2,
      contextWindow: 128_000,
      capabilities: [],
      requestTimeoutMs: 90_000,
      enabled: true,
    });
    configs.set(COMPANY_A, mutated);

    const request = {
      task: { taskClass: "implementation", issueId: "issue-glm", pinnedModelId: "cliproxy/glm-5.3-flash" },
      messages: [{ role: "user", content: "generate a long, careful answer" }],
      // ~93s of generation at the TOG-1035 baseline (43 tok/s): unreachable
      // within the sync path's 28s ceiling, comfortably inside the model's 90s.
      maxOutputTokens: 4_000,
    };

    const syncResult = await harness.performAction(ACTION_KEYS.invoke, request, { companyId: COMPANY_A }) as {
      outcome: string;
      error: { code: string };
    };
    expect(syncResult).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(httpCalls).toHaveLength(0);

    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async () =>
        await new Promise<Response>((resolve) => setTimeout(() => resolve(success("openai")), 45_000)));

      const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, request, { companyId: COMPANY_A }) as {
        status: string;
        requestId: string;
      };
      expect(submitted.status).toBe("pending");

      const stillRunning = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A });
      expect(stillRunning).toMatchObject({ status: "pending" });

      await vi.advanceTimersByTimeAsync(45_000);

      const finished = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A }) as {
        status: string;
        outcome: string;
        response: { modelId: string };
      };
      expect(finished).toMatchObject({
        status: "completed",
        outcome: "completed",
        response: { modelId: "cliproxy/glm-5.3-flash" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
