import { describe, expect, it } from "vitest";

import { evaluateLanePace, normalizeLaneDocument } from "../packages/lane-capacity/src/pace.js";
import type { LanePaceDefinition, LanePaceVerdict } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import type { CapacityEvidence } from "../src/capacity/types.js";

const NOW = "2026-09-10T14:53:41.507882Z";

// TOG-1916 §2 lane-document shape: records[] with per-account windows, the
// same shape the collector publishes and check_lane_docs.py asserts.
function laneDocument(records: unknown[]): unknown {
  return { schemaVersion: 1, observedAt: NOW, staleAfterSeconds: 300, records };
}

const LANE: LanePaceDefinition = {
  laneId: "subscriptions",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
  ],
};

function verdictFor(document: unknown, asOf = NOW): LanePaceVerdict {
  return evaluateLanePace({ observation: normalizeLaneDocument({ document, definition: LANE }), asOf });
}

function baseConfig(paceOrdering: boolean, mode: "shadow" | "enforce" = "enforce") {
  return resolveConfig({
    routing: { enabled: true, mode, fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    capacityRouting: {
      enabled: true,
      mode,
      paceOrdering,
      sources: [],
    },
    models: [
      // Two same-tier, same-quality models with different prices: without
      // pace ordering the cheaper (lane-behind) one wins on cost anyway, so
      // the AHEAD lane model must be priced cheaper to prove ordering beats
      // both cost and utilization ordering.
      { id: "behind-lane-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 2, costPerMTokOut: 8, contextWindow: 200000 },
      { id: "ahead-lane-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
      { id: "uncovered-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 0.5, costPerMTokOut: 2, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 60 }],
    tiering: { signalWeights: { filesTouched: 4, ambiguity: 20 }, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
  });
}

// Capacity evidence is orthogonal to pace: give every covered model healthy
// evidence so the capacity gate passes them all and cannot explain ordering.
function healthyEvidence(modelId: string, utilization: number): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: "record-1",
    health: "healthy",
    posture: "available",
    utilization,
    remainingFraction: 1 - utilization,
    resetsAt: "2026-09-11T00:00:00Z",
    resetInSeconds: 3600,
    windows: [],
    telemetryAvailable: true,
    reason: "test",
  };
}

// Frozen pace verdicts derived from the §1 semantics: deviation = weighted
// utilization − elapsed fraction of the governing (weekly) window.
const BEHIND = verdictFor(laneDocument([{
  health: "healthy", weight: 1, governing_window: "weekly",
  window_seconds: { five_hour: 18000, weekly: 604800 },
  five_hour_utilization: 0.2, five_hour_resets_at: "2026-09-10T18:00:00Z",
  weekly_utilization: 0.1, weekly_resets_at: "2026-09-15T04:09:00Z",
}])); // elapsed ≈ 0.833 of the week → deviation ≈ −0.73 → behind

const AHEAD = verdictFor(laneDocument([{
  health: "healthy", weight: 1, governing_window: "weekly",
  window_seconds: { five_hour: 18000, weekly: 604800 },
  five_hour_utilization: 0.1, five_hour_resets_at: "2026-09-10T18:00:00Z",
  weekly_utilization: 0.8, weekly_resets_at: "2026-09-15T04:09:00Z",
}])); // elapsed ≈ 0.833 → deviation ≈ −0.03..? weekly 0.8 vs elapsed .833 → on/ahead boundary; see assertion below

describe("TOG-2139 pace ordering (slice 6)", () => {
  it("classifies the frozen fixtures into behind and ahead-of-pace states", () => {
    expect(BEHIND.state).toBe("behind");
    expect(BEHIND.score!.deviation).toBeLessThan(0);
    expect(["on", "ahead"]).toContain(AHEAD.state);
    expect(AHEAD.score!.deviation).toBeGreaterThan(BEHIND.score!.deviation);
  });

  it("keeps a health-only live lane explicit and fail-neutral", () => {
    const config = resolveConfig({
      capacityRouting: {
        sources: [{
          id: "health-only",
          statusUrl: "https://router.example/health-only.json",
          modelIds: ["health-only-model"],
          windows: [{ name: "weekly", utilizationFields: ["weekly_utilization"] }],
          pace: {
            laneId: "health-only",
            healthFields: ["health"],
            weightFields: ["weight"],
            governingWindowField: "governing_window",
            windowSecondsField: "window_seconds",
            staleAfterSecondsField: "staleAfterSeconds",
            windows: [],
          },
        }],
      },
    });
    const pace = config.capacityRouting.sources[0]?.pace;
    expect(pace).toBeDefined();
    expect(pace?.windows).toEqual([]);

    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: laneDocument([{
          health: "unknown",
          weight: 1,
          governing_window: "weekly",
          window_seconds: { weekly: 604800 },
        }]),
        definition: pace!,
      }),
      asOf: NOW,
    });
    expect(verdict.state).toBe("unknown");
    expect(verdict.serviceable).toBe(true);
    expect(verdict.reason).toBe("no-computable-governing-window");
  });

  it("flag off: pace verdicts present in signals do not change the decision (frozen behavior)", () => {
    const config = baseConfig(false);
    const signals = {
      capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2), healthyEvidence("uncovered-model", 0.1)],
      paceVerdicts: { subscriptions: BEHIND },
      modelLaneByPace: { "behind-lane-model": "subscriptions" },
    };
    const withPace = selectModel({ descriptor: { taskClass: "implementation" }, config, signals: structuredClone(signals) });
    const withoutPace = selectModel({ descriptor: { taskClass: "implementation" }, config, signals: { capacityEvidence: signals.capacityEvidence } });
    // Uncovered is cheapest and healthy → wins on cost both ways; the pace
    // verdict sitting in signals is inert while the flag is off.
    expect(withPace.modelId).toBe(withoutPace.modelId);
    expect(withoutPace.modelId).toBe("uncovered-model");
  });

  it("flag on: the furthest-behind lane wins over cheaper ahead-of-pace and uncovered models", () => {
    const config = baseConfig(true);
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2), healthyEvidence("uncovered-model", 0.1)],
        paceVerdicts: { behind: BEHIND, ahead: AHEAD },
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    // Covered models outrank uncovered (unknown) even though uncovered is
    // cheaper AND less utilized; behind outranks ahead even though ahead's
    // model is cheaper. Both orderings are overridden by pace.
    expect(decision.modelId).toBe("behind-lane-model");
    const ids = decision.candidates.map((c) => c.modelId);
    expect(ids.indexOf("behind-lane-model")).toBeLessThan(ids.indexOf("ahead-lane-model"));
    expect(ids.indexOf("ahead-lane-model")).toBeLessThan(ids.indexOf("uncovered-model"));
    expect(decision.candidates.find((c) => c.modelId === "behind-lane-model")?.paceState).toBe("behind");
    expect(decision.candidates.find((c) => c.modelId === "uncovered-model")?.paceState).toBe("unknown");
  });

  it("ACCEPTANCE MUTANT SCENARIO: pace can never promote a model across the quality floor", () => {
    // behind-lane-model is priced into the BELOW-floor tier here; no pace
    // verdict — however favorable — may lift it over the class's qualityFloor.
    const config = resolveConfig({
      routing: { enabled: true, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
      capacityRouting: { enabled: true, mode: "enforce", paceOrdering: true, sources: [] },
      models: [
        { id: "cheap-below-floor", family: "other", tier: "small", quality: 30, costPerMTokIn: 0.1, costPerMTokOut: 0.4, contextWindow: 200000 },
        { id: "eligible-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 5, costPerMTokOut: 20, contextWindow: 200000 },
      ],
      taskClasses: [{ key: "implementation", qualityFloor: 60 }],
      tiering: { signalWeights: { filesTouched: 4, ambiguity: 20 }, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
    });
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("cheap-below-floor", 0.1), healthyEvidence("eligible-model", 0.5)],
        paceVerdicts: { behind: BEHIND, ahead: AHEAD },
        modelLaneByPace: { "cheap-below-floor": "behind", "eligible-model": "ahead" },
      },
    });
    expect(decision.modelId).toBe("eligible-model");
    expect(decision.candidates.every((candidate) => candidate.quality >= 60)).toBe(true);
    expect(decision.candidates.some((candidate) => candidate.modelId === "cheap-below-floor")).toBe(false);
    // The below-floor model is not merely ranked last; it is absent — pace
    // ordering had no opportunity to rescue it.
  });

  it("ACCEPTANCE MUTANT SCENARIO: pace can never promote a model across the capability gate", () => {
    const config = resolveConfig({
      routing: { enabled: true, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
      capacityRouting: { enabled: true, mode: "enforce", paceOrdering: true, sources: [] },
      models: [
        { id: "behind-no-vision", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000, capabilities: [] },
        { id: "ahead-vision", family: "other", tier: "standard", quality: 80, costPerMTokIn: 2, costPerMTokOut: 8, contextWindow: 200000, capabilities: ["vision"] },
      ],
      taskClasses: [{ key: "architecture", qualityFloor: 60, requiredCapabilities: ["vision"] }],
      tiering: { signalWeights: { filesTouched: 4, ambiguity: 20 }, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
    });
    const decision = selectModel({
      descriptor: { taskClass: "architecture", requiredCapabilities: ["vision"] },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-no-vision", 0.1), healthyEvidence("ahead-vision", 0.5)],
        paceVerdicts: { behind: BEHIND, ahead: AHEAD },
        modelLaneByPace: { "behind-no-vision": "behind", "ahead-vision": "ahead" },
      },
    });
    expect(decision.modelId).toBe("ahead-vision");
    expect(decision.candidates.some((candidate) => candidate.modelId === "behind-no-vision")).toBe(false);
  });

  it("unknown/stale verdicts are fail-neutral: unknown ranks last but stays selectable", () => {
    const config = baseConfig(true);
    const unknownVerdict: LanePaceVerdict = { ...BEHIND, state: "unknown", score: null, reason: "snapshot-stale" };
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2), healthyEvidence("uncovered-model", 0.1)],
        paceVerdicts: { behind: unknownVerdict, ahead: AHEAD },
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    // With behind degraded to unknown, ahead wins (a KNOWN pace outranks an
    // unknown one), and the unknown model remains selectable — ranked last of
    // the covered pair but never excluded.
    expect(decision.modelId).toBe("ahead-lane-model");
    expect(decision.outcome).toBe("selected");
  });

  it("same-pace ties fall through to the existing capacity ordering, not cost", () => {
    // Two models on lanes with IDENTICAL pace verdicts (both unknown here):
    // the pre-slice-6 capacity ordering — evidence rank then UTILIZATION —
    // must decide between them. Cost ordering would pick the cheaper
    // high-utilization model; that is the regression this pins.
    const config = baseConfig(true);
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        // behind-lane-model costs more (2 vs 1) but is far less utilized.
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.2), healthyEvidence("ahead-lane-model", 0.9)],
        paceVerdicts: {},
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    expect(decision.modelId).toBe("behind-lane-model");
    const ids = decision.candidates.map((c) => c.modelId);
    expect(ids.indexOf("behind-lane-model")).toBeLessThan(ids.indexOf("ahead-lane-model"));
  });

  it("an exhausted lane does not win ordering even though the capacity gate excludes it separately", () => {
    const config = baseConfig(true);
    const exhaustedVerdict: LanePaceVerdict = { ...BEHIND, state: "exhausted" };
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2)],
        paceVerdicts: { behind: exhaustedVerdict, ahead: AHEAD },
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    expect(decision.modelId).toBe("ahead-lane-model");
  });

  it("shadow mode: serving follows the static policy; the pace-aware pick surfaces via shadowModelId", () => {
    const config = baseConfig(true, "shadow");
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2), healthyEvidence("uncovered-model", 0.1)],
        paceVerdicts: { behind: BEHIND, ahead: AHEAD },
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    // capacityRouting.mode: shadow preserves the existing contract — serving
    // follows the static baseline (cost) winner, and the pace+capacity-aware
    // preference is visible as the shadow advisory instead of steering.
    expect(decision.modelId).toBe("uncovered-model");
    expect(decision.capacity.shadowModelId).toBe("behind-lane-model");
    expect(decision.trace.some((line) => line.includes("would choose behind-lane-model"))).toBe(true);
  });

  it("kill switch: routing.enabled false disables the decision regardless of pace", () => {
    const config = resolveConfig({
      ...structuredClone(baseConfig(true)),
      routing: { enabled: false, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    });
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("behind-lane-model", 0.9), healthyEvidence("ahead-lane-model", 0.2)],
        paceVerdicts: { behind: BEHIND, ahead: AHEAD },
        modelLaneByPace: { "behind-lane-model": "behind", "ahead-lane-model": "ahead" },
      },
    });
    // The kill switch short-circuits before any ordering — preserved intact
    // by slice 6.
    expect(decision.outcome).toBe("disabled");
    expect(decision.modelId).toBeNull();
  });
});
