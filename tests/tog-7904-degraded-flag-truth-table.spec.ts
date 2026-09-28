import { describe, expect, it } from "vitest";

import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import type { RouterConfig } from "../src/config/types.js";
import type { TaskDescriptor } from "../src/engine/types.js";

// TOG-7904 (Gap G3x): single pinned truth table for the capacity `degraded` flag.
//
// TOG-1076 judges the SELECTED model's evidence, but the full matrix
// (policy x telemetry coverage) had no single pinned table. This spec is that
// table. Axes:
//
//   policy P: fail-open | exclude-lane | fail-closed (all in enforce mode),
//             plus two shadow-mode rows pinning the mode axis;
//   coverage C: fetch-failed | full | partial-covered-wins |
//              partial-uncovered-wins | covered-exhausted-uncovered-wins.
//
// The 'fetch succeeded but model uncovered' case is row P=fail-open /
// C=partial-uncovered-wins: telemetry reads `available`, yet the winner has no
// evidence and the decision is degraded. Each row names its cell
// (`<policy> + <coverage>`), so flipping the `covered()`/`capacityFor`
// judgement in src/engine/select.ts must fail exactly its cell(s) by name.
//
// Acceptance: cover one model and uncover another under fail-open — rows
// `fail-open + partial-covered-wins` (control, degraded=false) and
// `fail-open + partial-uncovered-wins` (degraded=true) share identical
// evidence and differ only in which model the quality floor lets win, proving
// `degraded` reflects the SELECTED model, not the health of the fetch.
//
// Fixture mechanics: one source covers both models; coverage is decided by
// which evidence rows are handed in (an omitted row = uncovered model).
// lane-a is cheap so the static order always prefers it — an uncovered lane-b
// can only win when a quality floor (75) excludes lane-a (quality 70), the
// miniature of TOG-1076's tier-ceiling exclusion.

type Policy = "fail-open" | "fail-closed" | "exclude-lane";

function coveredLane(modelId: string, utilization: number): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: `${modelId}-lane`,
    health: "healthy",
    posture: "available",
    utilization,
    remainingFraction: 1 - utilization,
    resetsAt: null,
    resetInSeconds: null,
    windows: [],
    telemetryAvailable: true,
    reason: "healthy",
  };
}

function exhaustedLane(modelId: string): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: `${modelId}-lane`,
    health: "exhausted",
    posture: "unavailable",
    utilization: 1,
    remainingFraction: 0,
    resetsAt: null,
    resetInSeconds: null,
    windows: [],
    telemetryAvailable: true,
    reason: "quota exhausted",
  };
}

function configFor(policy: Policy, mode: "enforce" | "shadow", qualityFloor: number): RouterConfig {
  return resolveConfig({
    routing: { enabled: true, fallbackModelId: null, stickyModelWithinIssue: false },
    capacityRouting: {
      enabled: true,
      mode,
      unknownTelemetry: policy,
      sources: [
        {
          id: "subscriptions",
          statusUrl: "https://capacity.example.test/status",
          apiKeySecretRef: null,
          modelIds: ["lane-a", "lane-b"],
          healthFields: ["status"],
          windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: [] }],
        },
      ],
    },
    models: [
      { id: "lane-a", tier: "standard", quality: 70, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200_000 },
      { id: "lane-b", tier: "standard", quality: 80, costPerMTokIn: 10, costPerMTokOut: 40, contextWindow: 200_000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor }],
  });
}

const descriptor: TaskDescriptor = { taskClass: "implementation" };

describe("TOG-7904: capacity degraded-flag truth table", () => {
  // -- fail-open (enforce): absence never denies; the winner's evidence decides.
  it("fail-open + fetch-failed → SELECTED lane-a, degraded (static policy, no awareness)", () => {
    const decision = selectModel({
      config: configFor("fail-open", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [], capacityError: "telemetry endpoint unavailable" },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "unavailable", degraded: true },
    });
    expect(decision.trace.join(" ")).toContain("WARNING");
  });

  it("fail-open + full → SELECTED lane-a, not degraded", () => {
    const decision = selectModel({
      config: configFor("fail-open", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1), coveredLane("lane-b", 0.5)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "available", degraded: false, selectedSource: "subscriptions" },
    });
  });

  it("fail-open + partial-covered-wins → SELECTED lane-a, not degraded (control)", () => {
    const decision = selectModel({
      config: configFor("fail-open", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "available", degraded: false, selectedSource: "subscriptions" },
    });
  });

  it("fail-open + partial-uncovered-wins → SELECTED lane-b, DEGRADED (fetch ok, winner uncovered)", () => {
    // Same evidence as the control above; only the quality floor moved (70→75)
    // so the covered lane-a no longer qualifies and uncovered lane-b wins.
    const decision = selectModel({
      config: configFor("fail-open", "enforce", 75),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-b",
      capacity: { telemetry: "available", degraded: true, selectedSource: null },
    });
  });

  it("fail-open + covered-exhausted-uncovered-wins → SELECTED lane-b, DEGRADED", () => {
    // The TOG-1076 fleet shape in miniature: the covered lane positively
    // reports exhaustion (excluded for a real reason, not absence) and the
    // uncovered lane absorbs the traffic — visibly, via degraded=true.
    const decision = selectModel({
      config: configFor("fail-open", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [exhaustedLane("lane-a")] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-b",
      capacity: { telemetry: "available", degraded: true, selectedSource: null },
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "lane-a", stage: "capacity" }),
    );
  });

  // -- exclude-lane (enforce): uncovered models drop; refusal is quiet on fetch-ok.
  it("exclude-lane + fetch-failed → REFUSED, degraded (nothing usable, telemetry lost)", () => {
    const decision = selectModel({
      config: configFor("exclude-lane", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [], capacityError: "telemetry endpoint unavailable" },
    });
    expect(decision).toMatchObject({
      outcome: "no-eligible-model",
      modelId: null,
      capacity: { telemetry: "unavailable", degraded: true },
    });
  });

  it("exclude-lane + full → SELECTED lane-a, not degraded", () => {
    const decision = selectModel({
      config: configFor("exclude-lane", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1), coveredLane("lane-b", 0.5)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "available", degraded: false },
    });
  });

  it("exclude-lane + partial-covered-wins → SELECTED lane-a, not degraded", () => {
    const decision = selectModel({
      config: configFor("exclude-lane", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "available", degraded: false },
    });
  });

  it("exclude-lane + partial-uncovered-wins → REFUSED, not degraded (same evidence fail-open serves)", () => {
    // Identical evidence and floor to the fail-open degraded cell above — the
    // policy difference is the verdict: drop instead of serve degraded.
    const decision = selectModel({
      config: configFor("exclude-lane", "enforce", 75),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "no-eligible-model",
      modelId: null,
      capacity: { telemetry: "available", degraded: false },
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "lane-b", stage: "capacity" }),
    );
  });

  // -- fail-closed (enforce): one uncovered qualifier vetoes the decision.
  it("fail-closed + full → SELECTED lane-a, not degraded", () => {
    const decision = selectModel({
      config: configFor("fail-closed", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1), coveredLane("lane-b", 0.5)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "available", degraded: false },
    });
  });

  it("fail-closed + partial → REFUSED, not degraded (one uncovered qualifier vetoes)", () => {
    const decision = selectModel({
      config: configFor("fail-closed", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "no-eligible-model",
      modelId: null,
      capacity: { telemetry: "available", degraded: false },
    });
    expect(decision.trace.join(" ")).toContain("fail-closed");
  });

  it("fail-closed + fetch-failed → REFUSED, not degraded (refusal is the signal, not the flag)", () => {
    const decision = selectModel({
      config: configFor("fail-closed", "enforce", 70),
      descriptor,
      signals: { capacityEvidence: [], capacityError: "telemetry endpoint unavailable" },
    });
    expect(decision).toMatchObject({
      outcome: "no-eligible-model",
      modelId: null,
      capacity: { telemetry: "unavailable", degraded: false },
    });
    expect(decision.trace.join(" ")).toContain("refusing");
  });

  // -- shadow mode: the served model follows the static policy, so the winner's
  // evidence is never judged — degraded fires only on whole-telemetry loss.
  it("shadow + fetch-failed → SELECTED lane-a, degraded", () => {
    const decision = selectModel({
      config: configFor("fail-open", "shadow", 70),
      descriptor,
      signals: { capacityEvidence: [], capacityError: "telemetry endpoint unavailable" },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-a",
      capacity: { telemetry: "unavailable", degraded: true },
    });
  });

  it("shadow + partial-uncovered-wins → SELECTED lane-b, NOT degraded (mode axis)", () => {
    // Identical evidence and floor to the fail-open degraded cell — shadow
    // serves the same uncovered winner without the flag, because shadow never
    // routes on capacity. If this row ever reads degraded=true, the mode gate
    // in `capacityFor` (src/engine/select.ts) has been widened beyond enforce.
    const decision = selectModel({
      config: configFor("fail-open", "shadow", 75),
      descriptor,
      signals: { capacityEvidence: [coveredLane("lane-a", 0.1)] },
    });
    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "lane-b",
      capacity: { telemetry: "available", degraded: false },
    });
  });
});
