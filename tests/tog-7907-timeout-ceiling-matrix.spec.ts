/**
 * TOG-7907 (Gap G5x): per-model `requestTimeoutMs` inheritance ×
 * `SYNC_BUDGET_CEILING_MS` interaction matrix.
 *
 * `models[].requestTimeoutMs` overrides `upstream.requestTimeoutMs` for the
 * wire timeout on BOTH paths (`effectiveRequestTimeoutMs`), but the sync
 * preflight derives its token budget from
 * `min(effectiveTimeout, SYNC_BUDGET_CEILING_MS)` while async has no token
 * ceiling at all. The pinned table:
 *
 * | upstream | model override | wire timeout (sync+async) | sync token budget | async token ceiling |
 * |----------|----------------|---------------------------|-------------------|---------------------|
 * | 25s      | absent         | 25s (inherit)             | 25s-derived       | none                |
 * | 25s      | 10s (below)    | 10s (override wins down)  | 10s-derived       | none                |
 * | 25s      | 300s (above)   | 300s                      | 28s ceiling       | none                |
 * | 300s     | absent         | 300s (inherit)            | 28s ceiling       | none                |
 * | 300s     | 10s (below)    | 10s (override wins down)  | 10s-derived       | none                |
 *
 * Acceptance: a 300s model override on sync stays capped at the 28s ceiling —
 * a request past the ceiling-derived budget is rejected `invalid-request`
 * before secret resolution or upstream HTTP, naming the model and pointing at
 * `model_router_invoke_async`; the identical request on async is accepted.
 *
 * Mutant notes (why this shape): the ceiling guard is
 * `Math.min(effective, SYNC_BUDGET_CEILING_MS)` in `sync-budget.ts` — drop the
 * `min` and the 300s-override sync rejection below admits the request, so the
 * acceptance test is the kill. The preflight gate is `if (mode === "sync")` in
 * `worker.ts` — extend it to async and the async acceptance poll never leaves
 * pending-with-completion (it returns the rejection terminal instead), so the
 * async half is the kill for that direction.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, TOOL_NAMES } from "../src/constants.js";
import {
  SYNC_BUDGET_CEILING_MS,
  SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS,
} from "../src/config/upstream-constraints.js";
import { effectiveMaxSyncOutputTokens } from "../src/inference/sync-budget.js";
import { effectiveRequestTimeoutMs } from "../src/inference/transport.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const UPSTREAM_MS = 25_000;
const OVERRIDE_BELOW_MS = 10_000;
const OVERRIDE_ABOVE_MS = 300_000;

function rawWithTimeouts(): Record<string, unknown> {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as Record<string, unknown>).stickyModelWithinIssue = false;
  const model = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    tier: "standard",
    quality: 70,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    contextWindow: 200_000,
    capabilities: [],
    enabled: true,
    ...extra,
  });
  config.models = [
    model("inherit-model"),
    model("above-model", { requestTimeoutMs: OVERRIDE_ABOVE_MS }),
    model("below-model", { requestTimeoutMs: OVERRIDE_BELOW_MS }),
  ];
  return config;
}

function openAiSuccess(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-timeout-matrix", object: "chat.completion", model: "echo",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "timeout-matrix-1" } });
}

async function workerWithTimeouts(raw: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(raw); } };
  const httpCalls: string[] = [];
  const secretCalls: string[] = [];
  harness.ctx.secrets = {
    async resolve() {
      secretCalls.push("secret");
      return "resolved-secret";
    },
  };
  harness.ctx.http = {
    async fetch(url) {
      httpCalls.push(String(url));
      return openAiSuccess();
    },
  };
  // Async rides the worker's own global fetch, not ctx.http.
  vi.stubGlobal("fetch", async () => openAiSuccess());
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, httpCalls, secretCalls };
}

function invoke(modelId: string, maxOutputTokens: number) {
  return {
    task: { taskClass: "implementation", issueId: `issue-timeout-${modelId}`, pinnedModelId: modelId },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens,
  };
}

async function pollTerminal(
  harness: Awaited<ReturnType<typeof workerWithTimeouts>>["harness"],
  requestId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId }, { companyId: COMPANY }) as Record<string, unknown>;
    if (polled.status === "completed" || polled.status === "error") return polled;
    if (polled.status !== "pending") throw new Error(`async invocation ${requestId} polled unexpected status ${String(polled.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`async invocation ${requestId} never reached a terminal state`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7907: timeout inheritance × sync-ceiling matrix (units)", () => {
  it.each([
    ["inherit below ceiling", UPSTREAM_MS, undefined, UPSTREAM_MS, UPSTREAM_MS],
    ["override below ceiling", UPSTREAM_MS, OVERRIDE_BELOW_MS, OVERRIDE_BELOW_MS, OVERRIDE_BELOW_MS],
    ["override above ceiling", UPSTREAM_MS, OVERRIDE_ABOVE_MS, OVERRIDE_ABOVE_MS, SYNC_BUDGET_CEILING_MS],
    ["inherit above ceiling", OVERRIDE_ABOVE_MS, undefined, OVERRIDE_ABOVE_MS, SYNC_BUDGET_CEILING_MS],
    ["override below wins over high upstream", OVERRIDE_ABOVE_MS, OVERRIDE_BELOW_MS, OVERRIDE_BELOW_MS, OVERRIDE_BELOW_MS],
  ])("%s: wire timeout follows inheritance, sync budget follows the ceiling", (
    _label, upstreamMs, modelMs, expectedWireMs, expectedSyncBudgetMs,
  ) => {
    // The wire timeout (both paths) inherits or overrides with no ceiling.
    expect(effectiveRequestTimeoutMs(upstreamMs, modelMs)).toBe(expectedWireMs);
    // The sync token budget derives from the ceiling-clamped timeout.
    expect(effectiveMaxSyncOutputTokens(upstreamMs, modelMs, undefined)).toBe(
      Math.floor(expectedSyncBudgetMs * SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS),
    );
  });

  it("pins the ceiling itself: a 300s override still derives the 28s budget", () => {
    const ceilingBudget = Math.floor(SYNC_BUDGET_CEILING_MS * SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(SYNC_BUDGET_CEILING_MS).toBe(28_000);
    expect(effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_ABOVE_MS, undefined)).toBe(ceilingBudget);
  });
});

describe("TOG-7907: 300s model override on sync stays at the 28s ceiling", () => {
  it("rejects past-ceiling maxOutputTokens on sync, naming the model and async", async () => {
    const ceilingBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_ABOVE_MS, undefined);
    const { harness, httpCalls, secretCalls } = await workerWithTimeouts(rawWithTimeouts());
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      invoke("above-model", ceilingBudget + 10),
      { companyId: COMPANY },
    ) as { outcome: string; error: { code: string; message: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(result.error.message).toContain("above-model");
    expect(result.error.message).toContain(TOOL_NAMES.invokeAsync);
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("serves the identical past-ceiling request on async (no token ceiling there)", async () => {
    const ceilingBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_ABOVE_MS, undefined);
    const { harness } = await workerWithTimeouts(rawWithTimeouts());
    const submitted = await harness.performAction(
      ACTION_KEYS.invokeAsync,
      invoke("above-model", ceilingBudget + 10),
      { companyId: COMPANY },
    ) as Record<string, unknown>;
    expect(submitted).toMatchObject({ status: "pending" });
    const terminal = await pollTerminal(harness, String(submitted.requestId));
    expect(terminal).toMatchObject({ status: "completed" });
  });

  it("still serves an in-ceiling request on sync for the 300s model", async () => {
    const ceilingBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_ABOVE_MS, undefined);
    const { harness, httpCalls } = await workerWithTimeouts(rawWithTimeouts());
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      invoke("above-model", Math.max(1, ceilingBudget - 10)),
      { companyId: COMPANY },
    ) as { outcome: string };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });
});

describe("TOG-7907: below-ceiling override pulls the sync budget down with it", () => {
  it("rejects on sync a size that fits the upstream budget but exceeds the override", async () => {
    const belowBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_BELOW_MS, undefined);
    const upstreamBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, undefined, undefined);
    // Premise guard: the probe must sit strictly between the two budgets.
    expect(belowBudget).toBeLessThan(upstreamBudget);
    const between = belowBudget + 10;
    expect(between).toBeLessThan(upstreamBudget);

    const { harness, httpCalls, secretCalls } = await workerWithTimeouts(rawWithTimeouts());
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      invoke("below-model", between),
      { companyId: COMPANY },
    ) as { outcome: string; error: { code: string; message: string } };
    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(result.error.message).toContain(TOOL_NAMES.invokeAsync);
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("admits the same size on sync for the inheriting model (the override, not the number, decides)", async () => {
    const belowBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_BELOW_MS, undefined);
    const { harness, httpCalls } = await workerWithTimeouts(rawWithTimeouts());
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      invoke("inherit-model", belowBudget + 10),
      { companyId: COMPANY },
    ) as { outcome: string };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });

  it("serves the same size on async for the below-ceiling model (async ignores the token budget)", async () => {
    const belowBudget = effectiveMaxSyncOutputTokens(UPSTREAM_MS, OVERRIDE_BELOW_MS, undefined);
    const { harness } = await workerWithTimeouts(rawWithTimeouts());
    const submitted = await harness.performAction(
      ACTION_KEYS.invokeAsync,
      invoke("below-model", belowBudget + 10),
      { companyId: COMPANY },
    ) as Record<string, unknown>;
    expect(submitted).toMatchObject({ status: "pending" });
    const terminal = await pollTerminal(harness, String(submitted.requestId));
    expect(terminal).toMatchObject({ status: "completed" });
  });
});
