import { describe, expect, it } from "vitest";

import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";
import { selectModel } from "../src/engine/select.js";

// TOG-7909 (Gap G3x): single three-way matrix for `unknownTelemetry` on MISSING
// evidence (`src/engine/select.ts`, the `usable()`/`covered()` helpers and the
// two fail-closed refusals). TOG-1062 covers the boundaries (positive
// exhaustion is still excluded under fail-open) but no single matrix pins all
// three policies side by side — including exclude-lane's refuse-only-if-none-
// remain, which is behaviorally between the other two and invisible in any
// pairwise comparison that never serves under exclude-lane while refusing
// under fail-closed.
//
// Fixture mechanics: two same-tier models (`alpha` cheaper, so the static
// policy always prefers it) in enforce mode, no fallback configured. Evidence
// presence is the ONLY thing that varies; each row below removes evidence and
// asserts all three policies:
//
//   full    (both covered):            all three serve alpha, undegraded.
//   partial (beta's removed):          fail-open AND exclude-lane serve alpha;
//                                      fail-closed REFUSES even though a
//                                      covered model is ready — absence vetoes.
//   none    (reviewer removes all):    fail-open serves degraded alpha
//                                      (serve-degraded); exclude-lane refuses
//                                      via an emptied pool with per-model
//                                      capacity rejections (refuse-empty);
//                                      fail-closed refuses at the telemetry
//                                      gate with no per-model rejections and
//                                      degraded=false (refuse).
//
// Deletion guide: removing the line-175 gate refusal must fail the none/
// fail-closed cell; removing the line-256 any-uncovered refusal must fail the
// partial/fail-closed cell; relaxing exclude-lane's `usable()` to fail-open
// semantics must fail the none/exclude-lane cell; tightening it to fail-closed
// semantics must fail the partial/exclude-lane cell.

type Policy = RouterConfig["capacityRouting"]["unknownTelemetry"];

function healthyEvidence(modelId: string): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: `${modelId}-lane`,
    health: "healthy",
    posture: "available",
    utilization: 0.2,
    remainingFraction: 0.8,
    resetsAt: null,
    resetInSeconds: null,
    windows: [],
    telemetryAvailable: true,
    reason: "healthy",
  };
}

function matrixConfig(policy: Policy): RouterConfig {
  return resolveConfig({
    routing: { enabled: true, stickyModelWithinIssue: false },
    capacityRouting: {
      enabled: true,
      mode: "enforce",
      unknownTelemetry: policy,
      sources: [
        {
          id: "subscriptions",
          statusUrl: "https://capacity.example.test/status",
          apiKeySecretRef: null,
          modelIds: ["alpha", "beta"],
          healthFields: ["status"],
          windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: [] }],
        },
      ],
    },
    models: [
      { id: "alpha", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
      { id: "beta", tier: "standard", quality: 80, costPerMTokIn: 9, costPerMTokOut: 36, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

function decide(policy: Policy, evidence: CapacityEvidence[]) {
  return selectModel({
    config: matrixConfig(policy),
    descriptor: { taskClass: "implementation" },
    signals: { capacityEvidence: evidence },
  });
}

const FULL = [healthyEvidence("alpha"), healthyEvidence("beta")];
const PARTIAL = [healthyEvidence("alpha")];
const NONE: CapacityEvidence[] = [];

describe("TOG-7909: unknownTelemetry three-way matrix on missing evidence", () => {
  it("full evidence: every policy serves the covered cheapest model, undegraded", () => {
    for (const policy of ["fail-open", "exclude-lane", "fail-closed"] as const) {
      const decision = decide(policy, FULL);

      expect(decision.outcome).toBe("selected");
      expect(decision.modelId).toBe("alpha");
      expect(decision.capacity.telemetry).toBe("available");
      expect(decision.capacity.degraded).toBe(false);
    }
  });

  it("one model's evidence removed: fail-open and exclude-lane serve, fail-closed refuses", () => {
    const failOpen = decide("fail-open", PARTIAL);
    expect(failOpen.outcome).toBe("selected");
    expect(failOpen.modelId).toBe("alpha");
    expect(failOpen.capacity.degraded).toBe(false);

    // exclude-lane's refuse-only-if-none-remain: beta is excluded for absence,
    // but alpha remains, so the lane serves. This is the cell no pairwise
    // comparison pins — it serves where fail-closed refuses.
    const excludeLane = decide("exclude-lane", PARTIAL);
    expect(excludeLane.outcome).toBe("selected");
    expect(excludeLane.modelId).toBe("alpha");
    expect(excludeLane.capacity.degraded).toBe(false);
    expect(excludeLane.rejections).toContainEqual(
      expect.objectContaining({ modelId: "beta", stage: "capacity" }),
    );

    // fail-closed: one uncovered qualified model vetoes the whole decision,
    // even though alpha has healthy evidence and is ready to serve.
    const failClosed = decide("fail-closed", PARTIAL);
    expect(failClosed.outcome).toBe("no-eligible-model");
    expect(failClosed.modelId).toBeNull();
    expect(failClosed.trace.join(" ")).toContain(
      "capacity routing fail-closed: at least one qualified model has missing, unknown, or unavailable evidence",
    );
  });

  it("all evidence removed: serve-degraded / refuse-empty / refuse", () => {
    const failOpen = decide("fail-open", NONE);
    expect(failOpen.outcome).toBe("selected");
    expect(failOpen.modelId).toBe("alpha");
    expect(failOpen.capacity.telemetry).toBe("unavailable");
    expect(failOpen.capacity.degraded).toBe(true);
    expect(failOpen.trace.join(" ")).toContain("WARNING");

    // refuse-empty: every survivor drains out of the pool model by model, so
    // the refusal carries a per-model capacity rejection and degraded=true
    // (telemetry was unavailable, even though the fetch shape is "empty").
    const excludeLane = decide("exclude-lane", NONE);
    expect(excludeLane.outcome).toBe("no-eligible-model");
    expect(excludeLane.modelId).toBeNull();
    expect(excludeLane.capacity.telemetry).toBe("unavailable");
    expect(excludeLane.capacity.degraded).toBe(true);
    expect(
      excludeLane.rejections.filter((entry) => entry.stage === "capacity").map((entry) => entry.modelId).sort(),
    ).toEqual(["alpha", "beta"]);

    // refuse: the telemetry gate refuses before per-model evaluation, so
    // there are no capacity rejections and degraded stays false — a real
    // outage reads as an outage, not as two drained models.
    const failClosed = decide("fail-closed", NONE);
    expect(failClosed.outcome).toBe("no-eligible-model");
    expect(failClosed.modelId).toBeNull();
    expect(failClosed.capacity.telemetry).toBe("unavailable");
    expect(failClosed.capacity.degraded).toBe(false);
    expect(failClosed.rejections).toHaveLength(0);
    expect(failClosed.trace.join(" ")).toContain(
      "capacity routing is enforcing and telemetry is unavailable — refusing",
    );
  });
});
