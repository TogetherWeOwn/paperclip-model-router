import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import type { RouterConfig } from "../src/config/types.js";
import type { TaskDescriptor } from "../src/engine/types.js";

// TOG-7902 (Gap G3x): unknown `taskClass` refuses
// (`src/engine/select.ts`, the `task class ... is not configured` branch) but
// the boundary behavior was unpinned: quality exactly at the floor, tier
// exactly at the class ceiling, and empty `taskClasses`. Each test below moves
// exactly one input across the boundary it names.
//
// Mutant notes (why this shape): the floor gate is `model.quality <
// qualityFloor` — a `<=` mutant rejects the exact-floor model, so the
// exact-floor test is the kill. The ceiling gate keeps `tierIndex <=
// tierIndex(ceiling)` — a `<` mutant drops the exact-ceiling model, so the
// at-ceiling survivor assertion is the kill. The unknown-class branch returns
// before `base.qualityFloor` is set, so the refusal test asserts the null.

const UNKNOWN_CLASS_LINE = 'task class "ghost" is not configured — refusing';

function qualityConfig(floor: number): RouterConfig {
  return resolveConfig({
    routing: { enabled: true },
    models: [
      {
        id: "cheap-edge",
        tier: "small",
        quality: 0, // placeholder: per-test clone sets the probe quality
        costPerMTokIn: 1,
        costPerMTokOut: 4,
        contextWindow: 1_000_000,
        capabilities: [],
      },
      {
        id: "pricey-safe",
        tier: "small",
        quality: 80,
        costPerMTokIn: 10,
        costPerMTokOut: 40,
        contextWindow: 1_000_000,
        capabilities: [],
      },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: floor }],
  });
}

function decideAtQuality(probeQuality: number, floor = 70) {
  const config = qualityConfig(floor);
  config.models.find((entry) => entry.id === "cheap-edge")!.quality = probeQuality;
  return selectModel({ descriptor: { taskClass: "implementation" }, config });
}

function tierConfig(taskClass: Record<string, unknown>): RouterConfig {
  return resolveConfig({
    routing: { enabled: true },
    tiering: { signalWeights: { effort: 1 } },
    models: [
      { id: "tiny-small", tier: "small", quality: 90, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 1_000_000, capabilities: [] },
      { id: "mid-standard", tier: "standard", quality: 90, costPerMTokIn: 10, costPerMTokOut: 40, contextWindow: 1_000_000, capabilities: [] },
      { id: "big-strong", tier: "strong", quality: 90, costPerMTokIn: 100, costPerMTokOut: 400, contextWindow: 1_000_000, capabilities: [] },
      { id: "top-frontier", tier: "frontier", quality: 90, costPerMTokIn: 1000, costPerMTokOut: 4000, contextWindow: 1_000_000, capabilities: [] },
    ],
    taskClasses: [taskClass],
  });
}

describe("TOG-7902: qualityFloor boundary flips exactly at the floor", () => {
  it("quality exactly at the floor qualifies (70.00 selects the cheapest)", () => {
    const decision = decideAtQuality(70);
    expect(decision).toMatchObject({ outcome: "selected", modelId: "cheap-edge", qualityFloor: 70 });
    expect(decision.rejections).not.toContainEqual(
      expect.objectContaining({ modelId: "cheap-edge", stage: "quality-floor" }),
    );
  });

  it("quality 0.01 below the floor is rejected (69.99 falls through to the next model)", () => {
    const decision = decideAtQuality(69.99);
    expect(decision).toMatchObject({ outcome: "selected", modelId: "pricey-safe" });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "cheap-edge", stage: "quality-floor", reason: "quality 69.99 < floor 70" }),
    );
  });

  it("quality 0.01 above the floor qualifies (70.01 selects the cheapest)", () => {
    const decision = decideAtQuality(70.01);
    expect(decision).toMatchObject({ outcome: "selected", modelId: "cheap-edge" });
    expect(decision.rejections).not.toContainEqual(
      expect.objectContaining({ modelId: "cheap-edge", stage: "quality-floor" }),
    );
  });
});

describe("TOG-7902: maxTier boundary keeps the ceiling tier, drops the next one up", () => {
  it("tier exactly at maxTier survives while one tier above is rejected", () => {
    // No signals -> requested tier is the default `standard`; maxTier standard
    // binds, so small + standard survive and strong + frontier do not.
    const config = tierConfig({ key: "implementation", qualityFloor: 0, maxTier: "standard" });
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });
    expect(decision).toMatchObject({ outcome: "selected", modelId: "tiny-small", requestedTier: "standard", effectiveTier: "standard" });
    expect(decision.candidates.map((entry) => entry.modelId)).toEqual(["tiny-small", "mid-standard"]);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "big-strong", stage: "tier-ceiling", reason: "tier strong exceeds ceiling standard" }),
    );
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "top-frontier", stage: "tier-ceiling", reason: "tier frontier exceeds ceiling standard" }),
    );
  });

  it("requested tier below maxTier leaves the requested ceiling in place", () => {
    // maxTier frontier never binds a `standard` request: the ceiling stays the
    // requested tier and strong+frontier are still rejected above it.
    const config = tierConfig({ key: "implementation", qualityFloor: 0, maxTier: "frontier" });
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });
    expect(decision).toMatchObject({ outcome: "selected", requestedTier: "standard", effectiveTier: "standard" });
    expect(decision.candidates.map((entry) => entry.modelId)).toEqual(["tiny-small", "mid-standard"]);
  });

  it("absent maxTier leaves the requested ceiling in place", () => {
    const config = tierConfig({ key: "implementation", qualityFloor: 0 });
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });
    expect(decision).toMatchObject({ outcome: "selected", requestedTier: "standard", effectiveTier: "standard" });
    expect(decision.candidates.map((entry) => entry.modelId)).toEqual(["tiny-small", "mid-standard"]);
  });

  it("a frontier request against maxTier frontier keeps every tier", () => {
    const config = tierConfig({ key: "implementation", qualityFloor: 0, maxTier: "frontier" });
    const descriptor: TaskDescriptor = { taskClass: "implementation", signals: { effort: 100 } };
    const decision = selectModel({ descriptor, config });
    expect(decision).toMatchObject({ outcome: "selected", requestedTier: "frontier", effectiveTier: "frontier" });
    expect(decision.candidates.map((entry) => entry.modelId)).toEqual(
      ["tiny-small", "mid-standard", "big-strong", "top-frontier"],
    );
  });
});

describe("TOG-7902: unknown and empty taskClasses", () => {
  function knownConfig(): RouterConfig {
    return resolveConfig({
      routing: { enabled: true },
      models: [
        { id: "tiny-small", tier: "small", quality: 90, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 1_000_000, capabilities: [] },
      ],
      taskClasses: [{ key: "implementation", qualityFloor: 70 }],
    });
  }

  it("unknown taskClass refuses before the floor is reported", () => {
    const decision = selectModel({ descriptor: { taskClass: "ghost" }, config: knownConfig() });
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, qualityFloor: null, requestedTier: null });
    expect(decision.trace.join(" ")).toContain(UNKNOWN_CLASS_LINE);
  });

  it("empty taskClasses refuses a named class identically to an unknown one", () => {
    const config = knownConfig();
    config.taskClasses = [];
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, qualityFloor: null });
    expect(decision.trace.join(" ")).toContain('task class "implementation" is not configured — refusing');
  });

  it("no taskClass means floor 0 and no class ceiling", () => {
    const config = knownConfig();
    config.taskClasses = [];
    const decision = selectModel({ descriptor: {}, config });
    expect(decision).toMatchObject({ outcome: "selected", modelId: "tiny-small", taskClass: null, qualityFloor: 0 });
  });
});
