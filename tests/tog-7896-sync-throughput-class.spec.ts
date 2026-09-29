/**
 * TOG-7896 (R2-14): the sync preflight must apply the per-class throughput
 * row, not one chat-model ceiling for every model.
 *
 * The acceptance case: a reasoning-model fixture with a `maxOutputTokens`
 * that FITS the measured chat baseline but EXCEEDS the reasoning row must be
 * rejected before any secret resolution or upstream call. On pristine main
 * `resolveModels` drops the class, the request fits the single 1200tok/28s
 * ceiling, and it reaches upstream — so this fails there and passes here.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, TOOL_NAMES } from "../src/constants.js";
import { SYNC_BUDGET_CEILING_MS } from "../src/config/upstream-constraints.js";
import { resolveConfig } from "../src/config/resolve.js";
import { effectiveMaxSyncOutputTokens } from "../src/inference/sync-budget.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const UPSTREAM_TIMEOUT_MS = 25_000;

function rawWithClasses(): Record<string, unknown> {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as Record<string, unknown>).stickyModelWithinIssue = false;
  config.models = [
    { id: "chat-model", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200_000, capabilities: [], syncThroughputClass: "chat", enabled: true },
    { id: "reasoning-model", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200_000, capabilities: [], syncThroughputClass: "reasoning", enabled: true },
    { id: "unlabeled-model", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200_000, capabilities: [], enabled: true },
  ];
  return config;
}

async function workerWithClasses(raw: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(raw); } };
  const httpCalls: string[] = [];
  const secretCalls: string[] = [];
  harness.ctx.secrets = {
    async resolve(ref) {
      secretCalls.push(String((ref as { secretId?: unknown })?.secretId ?? ref));
      return "resolved-secret";
    },
  };
  harness.ctx.http = {
    async fetch(url) {
      httpCalls.push(String(url));
      return new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: "echo",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition, httpCalls, secretCalls };
}

function invoke(modelId: string, maxOutputTokens: number) {
  return {
    task: { taskClass: "implementation", issueId: "issue-class", pinnedModelId: modelId },
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens,
  };
}

describe("TOG-7896: reasoning models get the reasoning ceiling, not the chat one", () => {
  it("rejects a request that fits chat but exceeds reasoning, before secret access or upstream", async () => {
    const reasoningBudget = effectiveMaxSyncOutputTokens(UPSTREAM_TIMEOUT_MS, undefined, undefined, "reasoning");
    const chatBudget = effectiveMaxSyncOutputTokens(UPSTREAM_TIMEOUT_MS, undefined, undefined, "chat");
    // Sanity on the test's own premise: the two rows must differ by enough
    // room to place a request strictly between them.
    expect(chatBudget - reasoningBudget).toBeGreaterThan(100);
    const between = reasoningBudget + 10;
    expect(between).toBeLessThan(chatBudget);

    const { harness, httpCalls, secretCalls } = await workerWithClasses(rawWithClasses());
    const result = await harness.performAction(ACTION_KEYS.invoke, invoke("reasoning-model", between), { companyId: COMPANY }) as {
      outcome: string;
      error: { code: string; message: string };
    };
    expect(result).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    expect(result.error.message).toContain("reasoning-model");
    expect(result.error.message).toContain(TOOL_NAMES.invokeAsync);
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
  });

  it("admits the same request size for a chat-class model (the class, not the number, decides)", async () => {
    const reasoningBudget = effectiveMaxSyncOutputTokens(UPSTREAM_TIMEOUT_MS, undefined, undefined, "reasoning");
    const between = reasoningBudget + 10;
    const { harness, httpCalls } = await workerWithClasses(rawWithClasses());
    const result = await harness.performAction(ACTION_KEYS.invoke, invoke("chat-model", between), { companyId: COMPANY }) as {
      outcome: string;
    };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });

  it("keeps the unlabeled model on the exact pre-class budget (backwards compatible)", async () => {
    const reasoningBudget = effectiveMaxSyncOutputTokens(UPSTREAM_TIMEOUT_MS, undefined, undefined, "reasoning");
    const between = reasoningBudget + 10;
    const { harness, httpCalls } = await workerWithClasses(rawWithClasses());
    const result = await harness.performAction(ACTION_KEYS.invoke, invoke("unlabeled-model", between), { companyId: COMPANY }) as {
      outcome: string;
    };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });

  it("still serves an in-reasoning-budget request on the synchronous path", async () => {
    const reasoningBudget = effectiveMaxSyncOutputTokens(UPSTREAM_TIMEOUT_MS, undefined, undefined, "reasoning");
    const { harness, httpCalls } = await workerWithClasses(rawWithClasses());
    const result = await harness.performAction(
      ACTION_KEYS.invoke,
      invoke("reasoning-model", Math.max(1, reasoningBudget - 10)),
      { companyId: COMPANY },
    ) as { outcome: string };
    expect(result).toMatchObject({ outcome: "completed" });
    expect(httpCalls).toHaveLength(1);
  });
});

describe("TOG-7896: class plumbing (resolver passthrough + write-time refusal)", () => {
  it("resolves both rows, leaves unlabeled absent, and passes junk through for the validator", () => {
    const config = resolveConfig(rawWithClasses());
    const byId = new Map(config.models.map((model) => [model.id, model]));
    expect(byId.get("chat-model")?.syncThroughputClass).toBe("chat");
    expect(byId.get("reasoning-model")?.syncThroughputClass).toBe("reasoning");
    expect(byId.get("unlabeled-model")?.syncThroughputClass).toBeUndefined();

    const junk = resolveConfig({
      ...rawWithClasses(),
      models: [{ id: "junk", tier: "standard", quality: 1, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 1, syncThroughputClass: "fast" }],
    });
    // Passed through (not silently dropped) so onValidateConfig can refuse it.
    expect(junk.models[0]?.syncThroughputClass).toBe("fast");
  });

  it("accepts both classes and refuses anything else at config write", async () => {
    const { definition } = createPlugin();
    const withClass = (syncThroughputClass: unknown) => ({
      ...rawWithClasses(),
      models: [{ id: "m", tier: "standard", quality: 1, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 1, syncThroughputClass }],
    });
    expect((await definition.onValidateConfig!(withClass("chat"))).errors).toEqual([]);
    expect((await definition.onValidateConfig!(withClass("reasoning"))).errors).toEqual([]);
    const refused = await definition.onValidateConfig!(withClass("fast"));
    expect(refused.ok).toBe(false);
    expect((refused.errors ?? []).join(" ")).toContain("syncThroughputClass");
    // The validator derives from the raw write, not from a resolved default:
    // omitting the field must stay valid.
    const omitted = { ...rawWithClasses(), models: [{ id: "m", tier: "standard", quality: 1, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 1 }] };
    expect((await definition.onValidateConfig!(omitted)).errors).toEqual([]);
  });

  it("pins the sync ceiling the new wiring still respects", () => {
    expect(SYNC_BUDGET_CEILING_MS).toBe(28_000);
  });
});
