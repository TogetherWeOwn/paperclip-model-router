/**
 * TOG-7886 (gap G11): async/sync result-envelope parity conformance.
 *
 * `npm run rehearse` covers two sync companies only; nothing pinned that async
 * results carry the same selection/capacity metadata as sync `InferenceResult`.
 * These specs invoke BOTH paths against the same fixture and diff the envelope
 * field-by-field: any field present on sync but missing/renamed on async fails
 * the build, and any field the async terminal adds outside its known
 * submit/poll envelope (`status`, `startedAt`, `expiresAt`, `runId`, `agentId`)
 * fails it too.
 *
 * The guard itself is load-bearing: the last block feeds the comparator a
 * deliberately diverged pair and asserts it throws, so a future weakening of
 * the comparator cannot pass silently.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

const ASYNC_ONLY_TOP_LEVEL_KEYS = ["status", "startedAt", "expiresAt", "runId", "agentId"] as const;
const PER_REQUEST_TOP_LEVEL_KEYS = ["requestId"] as const;

function openAiSuccess(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-parity", object: "chat.completion", model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "parity reply" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-parity-a" } });
}

function anthropicSuccess(): Response {
  return new Response(JSON.stringify({
    id: "msg-parity", type: "message", role: "assistant", model: "echo-b",
    content: [{ type: "text", text: "parity reply" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-parity-b" } });
}

function upstreamError(): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status: 500,
    headers: { "content-type": "application/json", "x-request-id": "err-parity-1" },
  });
}

async function sharedWorker(mode: "success" | "error") {
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
  harness.ctx.secrets = {
    async resolve(_ref, options) {
      return options?.companyId === COMPANY_A ? "resolved-secret-a" : "resolved-secret-b";
    },
  };
  // The sync path rides ctx.http while the async background continuation rides
  // the worker's own global fetch. Both must answer identically or the parity
  // diff below measures the stubs, not the envelopes.
  const route = (url: unknown): Response => {
    if (mode === "error") return upstreamError();
    if (String(url).includes("capacity.example")) {
      return new Response(JSON.stringify({ rows: [{ status: "ok", used: 0.2 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return String(url).includes("company-a.example") ? openAiSuccess() : anthropicSuccess();
  };
  harness.ctx.http = { async fetch(url) { return route(url); } };
  vi.stubGlobal("fetch", async (url: string) => route(url));
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, configs };
}

async function pollTerminal(
  harness: Awaited<ReturnType<typeof sharedWorker>>["harness"],
  requestId: string,
  companyId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId }, { companyId }) as Record<string, unknown>;
    if (polled.status === "completed" || polled.status === "error") return polled;
    if (polled.status !== "pending") throw new Error(`async invocation ${requestId} polled unexpected status ${String(polled.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`async invocation ${requestId} never reached a terminal state`);
}

/** Every structural path, including intermediate object nodes, so empty
 * containers still compare as structure rather than vanishing. */
function allPaths(value: unknown, prefix: string, out: string[]): string[] {
  out.push(prefix);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => allPaths(entry, `${prefix}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) allPaths(entry, `${prefix}.${key}`, out);
  }
  return out;
}

function stripTopLevel(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keys.includes(key)) out[key] = entry;
  }
  return out;
}

/**
 * Fail the build when the async terminal diverges from the sync envelope:
 * missing/renamed sync fields, async-only additions outside the known
 * submit/poll envelope, or value drift at any shared path. `requestId` is
 * router-generated per request (never equal); the upstream request ids nested
 * inside `response`/`error` ARE compared.
 */
function assertEnvelopeParity(syncResult: Record<string, unknown>, asyncTerminal: Record<string, unknown>): void {
  const syncPaths = new Set(allPaths(syncResult, "$", []));
  const asyncPaths = new Set(allPaths(asyncTerminal, "$", []));
  const asyncOnly = new Set([...ASYNC_ONLY_TOP_LEVEL_KEYS, ...PER_REQUEST_TOP_LEVEL_KEYS].map((key) => `$.${key}`));

  const missing = [...syncPaths].filter((path) => !asyncPaths.has(path) && ![...PER_REQUEST_TOP_LEVEL_KEYS].some((key) => path === `$.${key}`));
  expect(missing, `fields present on sync but missing on async: ${missing.join(", ")}`).toEqual([]);

  const unexpected = [...asyncPaths].filter((path) => !syncPaths.has(path) && !asyncOnly.has(path));
  expect(unexpected, `fields present on async but missing/renamed on sync: ${unexpected.join(", ")}`).toEqual([]);

  // The poll status must mirror the terminal outcome it wraps.
  expect(asyncTerminal.status, "async poll status mirrors the terminal outcome").toBe(syncResult.outcome);

  expect(
    stripTopLevel(asyncTerminal, [...ASYNC_ONLY_TOP_LEVEL_KEYS, ...PER_REQUEST_TOP_LEVEL_KEYS]),
    "async terminal payload deep-equals the sync envelope field-by-field",
  ).toEqual(stripTopLevel(syncResult, [...PER_REQUEST_TOP_LEVEL_KEYS]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7886: async/sync result-envelope parity", () => {
  it.each([
    ["company-a openai", COMPANY_A],
    ["company-b anthropic", COMPANY_B],
  ])("completed envelope matches on %s for the same fixture", async (_label, companyId) => {
    const { harness } = await sharedWorker("success");
    // Distinct issue ids per path: `stickyModelWithinIssue` would otherwise
    // make the second selection take the sticky-incumbent early return (a
    // shorter trace) while the first takes the fresh path. Parity needs
    // identical selection inputs, so each path starts with no stickiness.
    const syncRequest = {
      task: { taskClass: "implementation", issueId: `parity-sync-${companyId}` },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };
    const asyncRequest = {
      task: { taskClass: "implementation", issueId: `parity-async-${companyId}` },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };

    const sync = await harness.performAction(ACTION_KEYS.invoke, syncRequest, { companyId }) as Record<string, unknown>;
    expect(sync).toMatchObject({ outcome: "completed" });

    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, asyncRequest, { companyId }) as Record<string, unknown>;
    expect(submitted).toMatchObject({ status: "pending" });
    // The submit-time decision is the same selection, not a lossy summary.
    // Strict: `toEqual` ignores `undefined`-valued keys, so a dropped field
    // would pass silently — the very drift this spec exists to catch.
    expect(submitted.decision).toStrictEqual(sync.decision);

    const terminal = await pollTerminal(harness, String(submitted.requestId), companyId);
    assertEnvelopeParity(sync, terminal);
  });

  it("completed envelope matches when capacity telemetry populates the decision", async () => {
    const { harness, configs } = await sharedWorker("success");
    const config = structuredClone(configs.get(COMPANY_A)!);
    config.capacityRouting = {
      enabled: true, mode: "enforce", unknownTelemetry: "fail-open",
      sources: [{
        id: "capacity", statusUrl: "https://capacity.example/status", modelIds: ["minimax-m2.5"],
        healthFields: ["status"], requestTimeoutMs: 5000, maxResponseBytes: 262144,
        windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }],
      }],
    };
    configs.set(COMPANY_A, config);
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY_A });

    const syncRequest = {
      task: { taskClass: "implementation", issueId: "parity-capacity-sync" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };
    const asyncRequest = {
      task: { taskClass: "implementation", issueId: "parity-capacity-async" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };
    const sync = await harness.performAction(ACTION_KEYS.invoke, syncRequest, { companyId: COMPANY_A }) as Record<string, unknown>;
    // Guard the guard: this case only means something when capacity metadata is
    // actually populated on the sync decision.
    expect(sync).toMatchObject({
      outcome: "completed",
      decision: { capacity: { mode: "enforce", telemetry: "available", selectedSource: "capacity" } },
    });

    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, asyncRequest, { companyId: COMPANY_A }) as Record<string, unknown>;
    const terminal = await pollTerminal(harness, String(submitted.requestId), COMPANY_A);
    assertEnvelopeParity(sync, terminal);
  });

  it("error envelope matches when the upstream fails on both paths", async () => {
    const { harness } = await sharedWorker("error");
    const syncRequest = {
      task: { taskClass: "implementation", issueId: "parity-error-sync" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };
    const asyncRequest = {
      task: { taskClass: "implementation", issueId: "parity-error-async" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    };

    const sync = await harness.performAction(ACTION_KEYS.invoke, syncRequest, { companyId: COMPANY_A }) as Record<string, unknown>;
    expect(sync).toMatchObject({
      outcome: "error",
      error: { code: "upstream-server-error", upstreamStatus: 500, upstreamRequestId: "err-parity-1" },
    });

    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, asyncRequest, { companyId: COMPANY_A }) as Record<string, unknown>;
    const terminal = await pollTerminal(harness, String(submitted.requestId), COMPANY_A);
    assertEnvelopeParity(sync, terminal);
  });

  it("early-exit envelopes match when async returns terminal directly (Rule 0)", async () => {
    const { harness } = await sharedWorker("success");
    const request = {
      task: { taskClass: "mechanical", summary: "lint the repo" },
      messages: [{ role: "user", content: "lint" }],
      maxOutputTokens: 10,
    };

    const sync = await harness.performAction(ACTION_KEYS.invoke, request, { companyId: COMPANY_A }) as Record<string, unknown>;
    expect(sync).toMatchObject({ outcome: "no-model-needed" });

    // No pending record exists for early exits: async returns InferenceResult
    // directly, so parity is a straight envelope comparison.
    const asyncDirect = await harness.performAction(ACTION_KEYS.invokeAsync, request, { companyId: COMPANY_A }) as Record<string, unknown>;
    expect(asyncDirect.outcome).toBe("no-model-needed");
    expect(stripTopLevel(asyncDirect, [...PER_REQUEST_TOP_LEVEL_KEYS])).toEqual(
      stripTopLevel(sync, [...PER_REQUEST_TOP_LEVEL_KEYS]),
    );
  });
});

describe("TOG-7886: the comparator itself bites", () => {
  const sync = {
    outcome: "completed",
    requestId: "sync-1",
    decision: { outcome: "selected", modelId: "m", capacity: { mode: "disabled" } },
    response: { modelId: "m", usage: { inputTokens: 1 } },
    error: null,
  };

  it("passes an identical pair modulo requestId", () => {
    assertEnvelopeParity(sync, { ...structuredClone(sync), requestId: "async-2", status: "completed", startedAt: "t", expiresAt: "t", runId: null, agentId: null });
  });

  it("fails a field missing on async", () => {
    const diverged = structuredClone(sync) as Record<string, unknown>;
    delete (diverged.response as Record<string, unknown>).usage;
    expect(() => assertEnvelopeParity(sync, { ...diverged, status: "completed" })).toThrow("missing on async");
  });

  it("fails a field renamed on async (trips the missing arm first)", () => {
    const diverged = structuredClone(sync) as Record<string, unknown>;
    const response = diverged.response as Record<string, unknown>;
    response.result = response.usage;
    delete response.usage;
    // A rename is a missing old name plus an unexpected new one; the missing
    // arm fires first. The companion case below pins the unexpected arm when
    // the old name survives alongside the new one.
    expect(() => assertEnvelopeParity(sync, { ...diverged, status: "completed" })).toThrow("missing on async");
  });

  it("fails a field added on async outside the known submit/poll envelope", () => {
    const diverged = structuredClone(sync) as Record<string, unknown>;
    ((diverged.response as Record<string, unknown>).usage as Record<string, unknown>).cachedTokens = 7;
    expect(() => assertEnvelopeParity(sync, { ...diverged, status: "completed" })).toThrow("missing/renamed");
  });

  it("fails a value drift at a shared path", () => {
    const diverged = structuredClone(sync) as Record<string, unknown>;
    ((diverged.decision as Record<string, unknown>).capacity as Record<string, unknown>).mode = "enforce";
    expect(() => assertEnvelopeParity(sync, { ...diverged, status: "completed" })).toThrow("field-by-field");
  });
});
