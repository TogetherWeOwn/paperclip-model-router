import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelCapability, TaskDescriptor } from "../src/engine/types.js";

// TOG-7901 (Gap G3x): single truth table for the fallback block
// (`src/engine/select.ts`, the `if (!pool.length)` branch). The fallback must
// clear capability, context, quality, halt, and enforced-capacity gates.
// Each row below starts from the same all-pass baseline and flips exactly ONE
// gate outcome; each row names its verdict (honored/refused + trace line).
//
// Fixture mechanics (why this shape): the honored path is only reachable in
// `enforce` mode. The fallback sits ABOVE the tier ceiling (`strong` vs
// `maxTier: small`) so the tier lift leaves it out of `ranked`, while the
// in-ceiling primary drains out of the pool through exhausted capacity.
// In shadow/disabled mode the pool equals `ranked`, so a qualifying fallback
// is always served through the normal path and `fallbackUsed` never fires.

const FALLBACK_REFUSED_LINE =
  "fallback fallback-strong refused — it must clear capability, context, quality, halt, and enforced capacity gates";

function evidenceFor(
  modelId: string,
  health: "healthy" | "exhausted",
) {
  return health === "healthy"
    ? {
        modelId,
        source: "subscriptions",
        laneLabel: `${modelId}-lane`,
        health: "healthy" as const,
        posture: "available" as const,
        utilization: 0.2,
        remainingFraction: 0.8,
        resetsAt: null,
        resetInSeconds: null,
        windows: [],
        telemetryAvailable: true,
        reason: "healthy",
      }
    : {
        modelId,
        source: "subscriptions",
        laneLabel: `${modelId}-lane`,
        health: "exhausted" as const,
        posture: "unavailable" as const,
        utilization: 1,
        remainingFraction: 0,
        resetsAt: null,
        resetInSeconds: null,
        windows: [],
        telemetryAvailable: true,
        reason: "exhausted",
      };
}

function baselineInput(overrides: {
  qualityFloor?: number;
  requiredCapabilities?: ModelCapability[];
  requiredContextTokens?: number;
  budgetSpentFraction?: number;
  fallbackHealth?: "healthy" | "exhausted";
} = {}) {
  const config = resolveConfig({
    routing: { enabled: true, fallbackModelId: "fallback-strong", stickyModelWithinIssue: false },
    capacityRouting: {
      enabled: true,
      mode: "enforce",
      unknownTelemetry: "fail-open",
      sources: [
        {
          id: "subscriptions",
          statusUrl: "https://capacity.example.test/status",
          apiKeySecretRef: null,
          modelIds: ["primary-small", "fallback-strong"],
          healthFields: ["status"],
          windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: [] }],
        },
      ],
    },
    models: [
      {
        id: "primary-small",
        tier: "small",
        quality: 80,
        costPerMTokIn: 1,
        costPerMTokOut: 4,
        contextWindow: 1_000_000,
        capabilities: ["tools", "vision", "computer-use"],
      },
      {
        id: "fallback-strong",
        tier: "strong",
        quality: 90,
        costPerMTokIn: 10,
        costPerMTokOut: 40,
        contextWindow: 200_000,
        capabilities: ["tools", "vision"],
      },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: overrides.qualityFloor ?? 70, maxTier: "small" }],
  });
  const descriptor: TaskDescriptor = { taskClass: "implementation", requiredCapabilities: ["vision"] };
  if (overrides.requiredCapabilities) descriptor.requiredCapabilities = overrides.requiredCapabilities;
  if (overrides.requiredContextTokens !== undefined) descriptor.requiredContextTokens = overrides.requiredContextTokens;
  return {
    config,
    descriptor,
    signals: {
      capacityEvidence: [
        evidenceFor("primary-small", "exhausted"),
        evidenceFor("fallback-strong", overrides.fallbackHealth ?? "healthy"),
      ],
      ...(overrides.budgetSpentFraction !== undefined
        ? { budgetSpentFraction: overrides.budgetSpentFraction }
        : {}),
    },
  };
}

describe("TOG-7901: fallback-model gate-parity truth table", () => {
  it("all gates pass → fallback HONORED (verdict: configured fallback used)", () => {
    const decision = selectModel(baselineInput());
    expect(decision).toMatchObject({ outcome: "selected", modelId: "fallback-strong", fallbackUsed: true });
    expect(decision.capacity.fallbackEvents).toContain("configured fallback fallback-strong used");
  });

  it("capability gate fails → fallback REFUSED (verdict: fallback refused line + capability rejection)", () => {
    // Flip: require computer-use, which the fallback lacks (primary still has it).
    const decision = selectModel(baselineInput({ requiredCapabilities: ["vision", "computer-use"] }));
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
    expect(decision.trace.join(" ")).toContain(FALLBACK_REFUSED_LINE);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "fallback-strong", stage: "capability" }),
    );
  });

  it("context gate fails → fallback REFUSED (verdict: fallback refused line + context-window rejection)", () => {
    // Flip: require 500k context; the fallback window is 200k (primary is 1M).
    const decision = selectModel(baselineInput({ requiredContextTokens: 500_000 }));
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
    expect(decision.trace.join(" ")).toContain(FALLBACK_REFUSED_LINE);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "fallback-strong", stage: "context-window" }),
    );
  });

  it("quality gate fails → fallback REFUSED (verdict: fallback refused line + quality-floor rejection)", () => {
    // Flip: floor 95 excludes the fallback at quality 90 (and the primary at 80).
    const decision = selectModel(baselineInput({ qualityFloor: 95 }));
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
    expect(decision.trace.join(" ")).toContain(FALLBACK_REFUSED_LINE);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "fallback-strong", stage: "quality-floor" }),
    );
  });

  it("halt gate fails → fallback REFUSED (verdict: budget halt line, before the fallback branch)", () => {
    // Flip: spend 0.99 ≥ halt 0.95. The halt return fires before the fallback
    // block, so the verdict line is the budget halt, not the fallback refusal.
    const decision = selectModel(baselineInput({ budgetSpentFraction: 0.99 }));
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
    expect(decision.trace.join(" ")).toContain("budget gate halt: refusing non-pinned model work");
  });

  it("enforced-capacity gate fails → fallback REFUSED (verdict: fallback refused line + capacity rejection)", () => {
    // Flip: the fallback lane reports exhausted while everything else holds.
    const decision = selectModel(baselineInput({ fallbackHealth: "exhausted" }));
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
    expect(decision.trace.join(" ")).toContain(FALLBACK_REFUSED_LINE);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "fallback-strong", stage: "capacity" }),
    );
  });
});
