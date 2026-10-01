import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

// TOG-11795: stale-pin hygiene at the serving layer (the model-router half of
// the card; the host pin-env rewrite lives in the model-selection plugin).
//
// Two properties, both pinned at the worker seam because a pure-engine test
// cannot prove the sticky read/write wiring:
//
// 1. Reassignment: a sticky entry records the agent whose selection
//    established it. An invoke from a different agent ignores the foreign
//    entry and re-decides, then takes ownership. The old agent's model is
//    never served to the new agent from stickiness.
// 2. Fallback: a fallback selection never sticks. Skipping the write leaves
//    any older non-fallback entry in place, so when the primary is
//    serviceable again the next invoke honors it with no repin pass.
//    Non-fallback selections still stick for the same agent (control).
//
// The fixture is company-a with capacity routing enabled in enforce mode and
// a fallback configured: the "small" primary drains out of the pool through
// exhausted capacity while the "strong" fallback (above the task-class tier
// ceiling) serves via the fallback branch with `fallbackUsed: true`.
//
// Removing the agent check in readStickyModel, or the fallbackUsed skip in
// writeStickyModel, must fail THESE tests.

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function upstreamOk() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function evidenceFor(modelId: string, health: "healthy" | "exhausted") {
  return health === "healthy"
    ? {
        modelId, source: "subscriptions", laneLabel: `${modelId}-lane`,
        health: "healthy", posture: "available", utilization: 0.2,
        remainingFraction: 0.8, resetsAt: null, resetInSeconds: null,
        windows: [], telemetryAvailable: true, reason: "healthy",
      }
    : {
        modelId, source: "subscriptions", laneLabel: `${modelId}-lane`,
        health: "exhausted", posture: "unavailable", utilization: 1,
        remainingFraction: 0, resetsAt: null, resetInSeconds: null,
        windows: [], telemetryAvailable: true, reason: "exhausted",
      };
}

async function fallbackHarness() {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as Record<string, unknown>).fallbackModelId = "claude-sonnet-5";
  (config.routing as Record<string, unknown>).stickyModelWithinIssue = true;
  // "implementation" (floor 60, no maxTier): the fresh heuristic winner is
  // minimax-m2.5; the strong fallback sits above the default-tier ceiling so
  // it can only serve through the fallback branch.
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    maxSnapshotAgeMs: 300_000,
    conserveUtilization: 0.7,
    avoidUtilization: 0.9,
    sources: [],
  };
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret-a"; } };
  harness.ctx.http = { async fetch() { return upstreamOk(); } };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

type Harness = Awaited<ReturnType<typeof fallbackHarness>>;

const requestFor = (issueId: string) => ({
  task: { taskClass: "implementation", issueId },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
});

const asAgent = (agentId: string) => ({
  companyId: COMPANY,
  actor: { type: "agent" as const, agentId, runId: `run-${agentId.slice(0, 8)}` },
});

function stickyRow(harness: Harness): Record<string, unknown> {
  return (harness.getState({
    scopeKind: "company",
    scopeId: COMPANY,
    stateKey: STATE_KEYS.issueStickiness,
  }) ?? {}) as Record<string, unknown>;
}

/** Seed exhausted capacity for every model except the fallback. */
async function exhaustPrimaries(harness: Harness, fallbackId = "claude-sonnet-5") {
  const models = (readFixture("company-a") as { models: Array<{ id: string }> }).models.map((m) => m.id);
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.capacitySnapshot },
    {
      refreshedAt: new Date().toISOString(),
      snapshots: [],
      evidence: models
        .filter((id) => id !== fallbackId)
        .map((id) => evidenceFor(id, "exhausted")),
      lastRefreshError: null,
    },
  );
}

async function clearCapacity(harness: Harness) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.capacitySnapshot },
    { refreshedAt: new Date().toISOString(), snapshots: [], evidence: [], lastRefreshError: null },
  );
}

describe("TOG-11795: stale-pin hygiene at the serving layer", () => {
  it("a fallback selection never sticks; the recovered primary is honored again with no repin", async () => {
    const harness = await fallbackHarness();

    // Baseline: agent A selects the primary and it sticks.
    const first = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-fb"), asAgent(AGENT_A),
    ) as { outcome: string; decision: { modelId: string; fallbackUsed: boolean } };
    expect(first).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5", fallbackUsed: false } });
    expect(stickyRow(harness)).toEqual({ "issue-fb": { modelId: "minimax-m2.5", agentId: AGENT_A } });

    // Primary goes down: the fallback serves, but must not overwrite the pin.
    await exhaustPrimaries(harness);
    const fallback = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-fb"), asAgent(AGENT_A),
    ) as { outcome: string; decision: { modelId: string; fallbackUsed: boolean } };
    expect(fallback).toMatchObject({ outcome: "completed", decision: { modelId: "claude-sonnet-5", fallbackUsed: true } });
    // The stale fallback is not what sticks — the primary entry survives.
    expect(stickyRow(harness)).toEqual({ "issue-fb": { modelId: "minimax-m2.5", agentId: AGENT_A } });

    // Primary recovers: the very next invoke honors the surviving entry.
    await clearCapacity(harness);
    const recovered = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-fb"), asAgent(AGENT_A),
    ) as { outcome: string; decision: { modelId: string; fallbackUsed: boolean } };
    expect(recovered).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5", fallbackUsed: false } });
  });

  it("reassignment ignores the previous agent's sticky entry and takes ownership", async () => {
    const harness = await fallbackHarness();

    const first = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-move"), asAgent(AGENT_A),
    ) as { outcome: string; decision: { modelId: string } };
    expect(first).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5" } });
    expect(stickyRow(harness)).toEqual({ "issue-move": { modelId: "minimax-m2.5", agentId: AGENT_A } });

    // Agent B arrives on the same issue. The foreign entry is invisible, so B
    // re-decides (same winner here) and the entry is rewritten under B.
    const second = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-move"), asAgent(AGENT_B),
    ) as { outcome: string; decision: { modelId: string } };
    expect(second).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5" } });
    expect(stickyRow(harness)).toEqual({ "issue-move": { modelId: "minimax-m2.5", agentId: AGENT_B } });

    // A stale entry planted for a third agent is never served to B: with the
    // planted model out of the pool B re-decides instead of inheriting it.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
      { "issue-move": { modelId: "qwen3-coder", agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
    );
    const third = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-move"), asAgent(AGENT_B),
    ) as { outcome: string; decision: { modelId: string } };
    expect(third).toMatchObject({ outcome: "completed" });
    expect(third.decision.modelId).not.toBe("qwen3-coder");
  });

  it("control: same-agent non-fallback selections still stick with no rewrite", async () => {
    const harness = await fallbackHarness();
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    const stickySets: unknown[] = [];
    harness.ctx.state.set = async (key, value) => {
      if ((key as { stateKey?: string }).stateKey === STATE_KEYS.issueStickiness) stickySets.push(value);
      return originalSet(key, value);
    };

    await harness.performAction(ACTION_KEYS.invoke, requestFor("issue-still"), asAgent(AGENT_A));
    expect(stickySets).toHaveLength(1);
    expect(stickyRow(harness)).toEqual({ "issue-still": { modelId: "minimax-m2.5", agentId: AGENT_A } });

    // Same agent, same model: the hot path performs no state write.
    await harness.performAction(ACTION_KEYS.invoke, requestFor("issue-still"), asAgent(AGENT_A));
    expect(stickySets).toHaveLength(1);
  });

  it("legacy bare-string entries are honored once and upgraded on write", async () => {
    const harness = await fallbackHarness();
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.issueStickiness },
      { "issue-legacy": "minimax-m2.5" },
    );

    const result = await harness.performAction(
      ACTION_KEYS.invoke, requestFor("issue-legacy"), asAgent(AGENT_A),
    ) as { outcome: string; decision: { modelId: string } };
    expect(result).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5" } });
    // Served from the legacy entry, then upgraded to the owned shape.
    expect(stickyRow(harness)).toEqual({ "issue-legacy": { modelId: "minimax-m2.5", agentId: AGENT_A } });
  });
});
