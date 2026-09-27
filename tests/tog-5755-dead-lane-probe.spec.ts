import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import type { CapacityEvidence } from "../src/capacity/types.js";
import { selectModel } from "../src/engine/select.js";

// TOG-5755: dead-lane veto second-tier probe (T1/T2 cheapest-lane exclusion).
//
// Independent probe side of the D1e dead-lane veto (spec: TOG-5122 doc
// `d1e-veto-spec`; sibling TOG-5157 builds the executable slice). This card
// uses FAKE signals only: a "zero-success lane" is simulated as capacity
// evidence that positively reports exhaustion, and the probe demonstrates that
// the cheapest lane carrying that signal is excluded from selection while a
// healthy second-cheapest lane in the same tier wins — without touching pins
// or quality floors.
//
// Tier mapping (OBS): the audit's T1/T2/T3 tiers live in the model-selection
// repo (`plugins/model-selection`). This repo's ladder is
// small/standard/strong/frontier (`src/engine/types.ts`), so T1 -> `standard`
// and T2 -> `strong`: one run per tier ceiling.
//
// Mechanism under test (OBS, `src/engine/select.ts:202-221`): in enforce mode
// only evidence that POSITIVELY reports `unavailable` excludes a model
// (`positivelyUnavailable`); mere absence sorts last under `fail-open`.

const RESETS_AT = "2026-09-27T12:00:00.000Z";

/** Fake signal for a zero-success (dead) lane: positive exhaustion report. */
function deadLane(modelId: string): CapacityEvidence {
  return {
    modelId,
    source: "probe-fake",
    laneLabel: `${modelId}-lane`,
    health: "exhausted",
    posture: "unavailable",
    utilization: 1,
    remainingFraction: 0,
    resetsAt: RESETS_AT,
    resetInSeconds: 3600,
    windows: [],
    telemetryAvailable: true,
    reason: "probe fake: zero successes in last 5 polls",
  };
}

/** Fake signal for a healthy lane. */
function healthyLane(modelId: string, utilization: number): CapacityEvidence {
  return {
    modelId,
    source: "probe-fake",
    laneLabel: `${modelId}-lane`,
    health: "healthy",
    posture: "available",
    utilization,
    remainingFraction: 1 - utilization,
    resetsAt: RESETS_AT,
    resetInSeconds: 3600,
    windows: [],
    telemetryAvailable: true,
    reason: "probe fake: serving normally",
  };
}

function probeConfig(models: Array<{ id: string; tier: "standard" | "strong"; costIn: number; costOut: number }>) {
  return resolveConfig({
    routing: { enabled: true, stickyModelWithinIssue: false },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry: "fail-open" },
    models: models.map((entry) => ({
      id: entry.id,
      tier: entry.tier,
      quality: 80,
      costPerMTokIn: entry.costIn,
      costPerMTokOut: entry.costOut,
      contextWindow: 500_000,
      capabilities: ["tools"],
      enabled: true,
    })),
    taskClasses: [{ key: "implementation", qualityFloor: 60 }],
    tiering: {
      signalWeights: { complexity: 1 },
      thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 },
      defaultTier: "standard",
    },
  });
}

describe("TOG-5755: zero-success (dead) lane excluded, second-cheapest wins", () => {
  it("T1 (standard tier): cheapest lane with zero successes is excluded", () => {
    const config = probeConfig([
      { id: "std-cheap", tier: "standard", costIn: 1, costOut: 1 },
      { id: "std-pricey", tier: "standard", costIn: 3, costOut: 3 },
    ]);
    const before = structuredClone(config);

    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", signals: { complexity: 35 } },
      signals: { capacityEvidence: [deadLane("std-cheap"), healthyLane("std-pricey", 0.45)] },
    });

    // Exclusion is observable: the dead cheapest lane loses, the healthy
    // second-cheapest lane is selected, with a capacity-stage rejection.
    expect(decision.requestedTier).toBe("standard");
    expect(decision).toMatchObject({ outcome: "selected", modelId: "std-pricey", fallbackUsed: false });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "std-cheap", stage: "capacity" }),
    );
    expect(decision.capacity).toMatchObject({
      mode: "enforce",
      telemetry: "available",
      degraded: false,
      selectedLaneLabel: "std-pricey-lane",
    });

    // No pin/floor mutation: no pin configured or honored, the floor is the
    // configured one, and the engine did not mutate the config object.
    expect(decision.pin).toBeNull();
    expect(decision.qualityFloor).toBe(60);
    expect(JSON.stringify(before)).not.toContain("pinnedModelId");
    expect(config).toEqual(before);
  });

  it("T1 control: the same cheapest lane wins when its signal is healthy", () => {
    const config = probeConfig([
      { id: "std-cheap", tier: "standard", costIn: 1, costOut: 1 },
      { id: "std-pricey", tier: "standard", costIn: 3, costOut: 3 },
    ]);

    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", signals: { complexity: 35 } },
      signals: { capacityEvidence: [healthyLane("std-cheap", 0.15), healthyLane("std-pricey", 0.45)] },
    });

    // Proves the T1 exclusion above is caused by the dead-lane signal, not by
    // cost ordering or tier mechanics: healthy cheapest wins.
    expect(decision).toMatchObject({ outcome: "selected", modelId: "std-cheap" });
    expect(decision.pin).toBeNull();
    expect(decision.qualityFloor).toBe(60);
  });

  it("T2 (strong tier): cheapest lane with zero successes is excluded", () => {
    const config = probeConfig([
      { id: "str-cheap", tier: "strong", costIn: 5, costOut: 5 },
      { id: "str-pricey", tier: "strong", costIn: 9, costOut: 9 },
    ]);
    const before = structuredClone(config);

    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", signals: { complexity: 70 } },
      signals: { capacityEvidence: [deadLane("str-cheap"), healthyLane("str-pricey", 0.45)] },
    });

    expect(decision.requestedTier).toBe("strong");
    expect(decision).toMatchObject({ outcome: "selected", modelId: "str-pricey", fallbackUsed: false });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "str-cheap", stage: "capacity" }),
    );
    expect(decision.capacity).toMatchObject({
      mode: "enforce",
      telemetry: "available",
      degraded: false,
      selectedLaneLabel: "str-pricey-lane",
    });

    expect(decision.pin).toBeNull();
    expect(decision.qualityFloor).toBe(60);
    expect(JSON.stringify(before)).not.toContain("pinnedModelId");
    expect(config).toEqual(before);
  });

  it("T2 control: the same cheapest lane wins when its signal is healthy", () => {
    const config = probeConfig([
      { id: "str-cheap", tier: "strong", costIn: 5, costOut: 5 },
      { id: "str-pricey", tier: "strong", costIn: 9, costOut: 9 },
    ]);

    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", signals: { complexity: 70 } },
      signals: { capacityEvidence: [healthyLane("str-cheap", 0.15), healthyLane("str-pricey", 0.45)] },
    });

    expect(decision).toMatchObject({ outcome: "selected", modelId: "str-cheap" });
    expect(decision.pin).toBeNull();
    expect(decision.qualityFloor).toBe(60);
  });
});
