import { describe, expect, it } from "vitest";

import { evaluateLanePace, normalizeLaneDocument } from "../packages/lane-capacity/src/pace.js";
import type { LanePaceDefinition, LanePaceVerdict } from "../src/capacity/types.js";
import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

/**
 * TOG-3983: margin-aware serviceability hard-stop parity.
 *
 * Ports the worker fix landed on TOG-3930 (ops-tooling `e71863d3b`, merged as
 * `21bdc881b` via TOG-3939) into this repository. Measured 2026-09-16
 * 22:29-22:52Z: a Claude lane document with one account at five_hour 1.0 and
 * a healthy second account at 0.05 still served 429s for 52 runs, because the
 * lane roll-up only tripped when EVERY account was unserviceable and the
 * provider does not fail over within a lane.
 *
 * Parity contract: a serviceability window at, or within the pace margin of,
 * 1.0 poisons the lane — `state:"exhausted"`, `serviceable:false`,
 * `reason:"serviceability-window-exhausted"`, `urgentResetAt` = the earliest
 * tripped window's resetsAt — even when another account is healthy.
 */
const OBSERVED_AT = "2026-09-16T23:13:12.071592Z";

const CLAUDE: LanePaceDefinition = {
  laneId: "claude",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"] },
  ],
};

const PEER_FIVE_HOUR_RESET = "2026-09-17T03:30:00.666229Z";

const TRIPPED_RECORD = {
  health: "healthy",
  weight: 1,
  governing_window: "seven_day",
  window_seconds: { five_hour: 18000, seven_day: 604800 },
  five_hour_utilization: 1.0,
  five_hour_resets_at: "2026-09-16T23:20:00.443210Z",
  seven_day_utilization: 0.84,
  seven_day_resets_at: "2026-09-18T19:00:00.443239Z",
};

const HEALTHY_PEER_RECORD = {
  health: "healthy",
  weight: 1,
  governing_window: "seven_day",
  window_seconds: { five_hour: 18000, seven_day: 604800 },
  five_hour_utilization: 0.05,
  five_hour_resets_at: PEER_FIVE_HOUR_RESET,
  seven_day_utilization: 0.71,
  seven_day_resets_at: "2026-09-19T09:59:59.666254Z",
};

function verdictFor(records: unknown[], margin?: number): LanePaceVerdict {
  return evaluateLanePace({
    observation: normalizeLaneDocument({
      document: { schemaVersion: 1, observedAt: OBSERVED_AT, staleAfterSeconds: 300, records },
      definition: CLAUDE,
    }),
    asOf: OBSERVED_AT,
    policy: margin === undefined ? undefined : { margin },
  });
}

describe("TOG-3983: margin-aware trip ceiling", () => {
  it.each([
    [0.899, 0.1, true],
    [0.8994, 0.1, true],
    [0.8995, 0.1, false],
    [0.9, 0.1, false],
    [0.799, 0.2, true],
    [0.8, 0.2, false],
    [0.999, 0, true],
    [1, 0, false],
  ])("five_hour utilization %s with margin %s is serviceable=%s", (utilization, margin, serviceable) => {
    const verdict = verdictFor(
      [{ ...HEALTHY_PEER_RECORD, five_hour_utilization: utilization }],
      margin,
    );
    expect(verdict.serviceable).toBe(serviceable);
    expect(verdict.accounts[0]).toMatchObject({ serviceable });
    if (!serviceable) {
      expect(verdict.reason).toBe("serviceability-window-exhausted");
      expect(verdict.accounts[0]).toMatchObject({ state: "exhausted" });
    }
  });
});

describe("TOG-3983: unrelated pace behavior stays unchanged", () => {
  it("does not apply the serviceability margin to an allowance window", () => {
    expect(verdictFor([{ ...HEALTHY_PEER_RECORD, seven_day_utilization: 0.99 }])).toMatchObject({
      serviceable: true, reason: "ok",
    });
  });

  it("allows a healthy peer to rescue an allowance-only exhaustion", () => {
    expect(verdictFor([{ ...HEALTHY_PEER_RECORD, seven_day_utilization: 1 }, HEALTHY_PEER_RECORD])).toMatchObject({
      serviceable: true, serviceableAccountCount: 1, reason: "ok",
    });
  });

  it("keeps stale and free observations neutral to the hard stop", () => {
    const observation = normalizeLaneDocument({
      document: { observedAt: OBSERVED_AT, staleAfterSeconds: 300, records: [TRIPPED_RECORD] },
      definition: CLAUDE,
    });
    expect(evaluateLanePace({ observation, asOf: "2026-09-17T00:00:00Z" })).toMatchObject({
      state: "unknown", serviceable: null, reason: "snapshot-stale",
    });
    expect(evaluateLanePace({ observation: { ...observation, free: true }, asOf: OBSERVED_AT })).toMatchObject({
      state: "free", serviceable: true, reason: "free-lane",
    });
  });
});

describe("TOG-3983: a tripped serviceability window is a lane hard stop", () => {
  it("hard-stops the synthetic storm-shaped record (7d 0.84 + 5h 1.0)", () => {
    const verdict = verdictFor([TRIPPED_RECORD]);
    expect(verdict.serviceable).toBe(false);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.urgentResetAt).toBe("2026-09-16T23:20:00.443Z");
    expect(verdict.accounts[0]).toMatchObject({ serviceable: false, state: "exhausted" });
  });

  it("does not let the healthy peer account rescue the tripped lane", () => {
    const verdict = verdictFor([HEALTHY_PEER_RECORD, TRIPPED_RECORD]);
    expect(verdict.serviceable).toBe(false);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.serviceableAccountCount).toBe(1);
    expect(verdict.urgentResetAt).toBe("2026-09-16T23:20:00.443Z");
  });

  it("reports the earliest tripped reset regardless of account order", () => {
    const later = { ...TRIPPED_RECORD, five_hour_resets_at: "2026-09-17T03:30:00.666229Z" };
    const verdict = verdictFor([later, TRIPPED_RECORD]);
    expect(verdict.reason).toBe("serviceability-window-exhausted");
    expect(verdict.urgentResetAt).toBe("2026-09-16T23:20:00.443Z");
  });

  it("checks every serviceability window, not just the first or governing window", () => {
    const observation = normalizeLaneDocument({
      document: { observedAt: OBSERVED_AT, records: [HEALTHY_PEER_RECORD] },
      definition: CLAUDE,
    });
    observation.accounts[0]!.windows.push({
      name: "burst", role: "serviceability", utilization: 0.9,
      resetsAt: "2026-09-16T23:15:00.000Z", windowSeconds: null, sourcePath: null,
    });
    expect(evaluateLanePace({ observation, asOf: OBSERVED_AT })).toMatchObject({
      serviceable: false, reason: "serviceability-window-exhausted", urgentResetAt: "2026-09-16T23:15:00.000Z",
    });
  });

  it("trips without a reset or computable governor and does not invent relief", () => {
    const verdict = verdictFor([
      { ...TRIPPED_RECORD, five_hour_resets_at: null, seven_day_resets_at: null, governing_window: "missing" },
    ]);
    expect(verdict).toMatchObject({
      state: "exhausted",
      serviceable: false,
      urgentResetAt: null,
      reason: "serviceability-window-exhausted",
    });
    expect(verdict.accounts[0]).toMatchObject({ state: "exhausted", serviceable: false });
  });

  it("a healthy peer's indeterminate capacity cannot mask a trip", () => {
    const peer = { ...HEALTHY_PEER_RECORD, seven_day_resets_at: null };
    const control = verdictFor([peer]);
    expect(control.state).toBe("unknown");
    expect(control.serviceable).toBe(true);
    const verdict = verdictFor([peer, TRIPPED_RECORD]);
    expect(verdict).toMatchObject({
      state: "exhausted",
      serviceable: false,
      reason: "serviceability-window-exhausted",
      urgentResetAt: "2026-09-16T23:20:00.443Z",
    });
  });
});

const ZAI: LanePaceDefinition = {
  laneId: "zai",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
  ],
};

function zaiVerdict(): LanePaceVerdict {
  return evaluateLanePace({
    observation: normalizeLaneDocument({
      document: {
        schemaVersion: 1,
        observedAt: OBSERVED_AT,
        staleAfterSeconds: 300,
        records: [{
          health: "healthy",
          weight: 1,
          governing_window: "weekly",
          window_seconds: { five_hour: 18000, weekly: 604800 },
          five_hour_utilization: 0.1,
          five_hour_resets_at: "2026-09-17T03:51:12.000Z",
          weekly_utilization: 0.9,
          weekly_resets_at: "2026-09-22T04:09:05.000Z",
        }],
      },
      definition: ZAI,
    }),
    asOf: OBSERVED_AT,
  });
}

function selectionConfig(paceOrdering: boolean) {
  return resolveConfig({
    routing: { enabled: true, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    capacityRouting: { enabled: true, mode: "enforce", paceOrdering, sources: [] },
    models: [
      { id: "claude-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
      { id: "zai-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 2, costPerMTokOut: 8, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 60 }],
    tiering: { signalWeights: { filesTouched: 4, ambiguity: 20 }, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
  });
}

function healthyEvidence(modelId: string): CapacityEvidence {
  return {
    modelId,
    source: "lane",
    laneLabel: "record-1",
    health: "healthy",
    posture: "available",
    utilization: 0.2,
    remainingFraction: 0.8,
    resetsAt: "2026-09-17T00:00:00.000Z",
    resetInSeconds: 3600,
    windows: [],
    telemetryAvailable: true,
    reason: "test",
  };
}

describe("TOG-3983: selection excludes the tripped lane in enforce mode", () => {
  it("a tripped lane never wins: the live lane is selected and the 429 lane is rejected", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: selectionConfig(true),
      signals: {
        capacityEvidence: [healthyEvidence("claude-model"), healthyEvidence("zai-model")],
        paceVerdicts: { claude: verdictFor([HEALTHY_PEER_RECORD, TRIPPED_RECORD]), zai: zaiVerdict() },
        modelLaneByPace: { "claude-model": "claude", "zai-model": "zai" },
      },
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("zai-model");
    expect(decision.rejections.some((r) => r.modelId === "claude-model" && r.stage === "capacity")).toBe(true);
  });

  it.each(["fail-open", "fail-closed", "exclude-lane"] as const)("cannot pin, stick or fall back to a tripped sole candidate under %s", (policy) => {
    const config = selectionConfig(true);
    config.capacityRouting.unknownTelemetry = policy;
    config.models = config.models.filter((model) => model.id === "claude-model");
    config.routing.fallbackModelId = "claude-model";
    config.routing.stickyModelWithinIssue = true;
    const decision = selectModel({
      descriptor: { taskClass: "implementation", pinnedModelId: "claude-model" },
      config,
      signals: {
        stickyModelId: "claude-model",
        capacityEvidence: [healthyEvidence("claude-model")],
        paceVerdicts: { claude: verdictFor([HEALTHY_PEER_RECORD, TRIPPED_RECORD]) },
        modelLaneByPace: { "claude-model": "claude" },
      },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("control: shadow capacity does not enforce a serviceability exclusion", () => {
    const config = selectionConfig(true);
    config.capacityRouting.mode = "shadow";
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("claude-model"), healthyEvidence("zai-model")],
        paceVerdicts: { claude: verdictFor([TRIPPED_RECORD]), zai: zaiVerdict() },
        modelLaneByPace: { "claude-model": "claude", "zai-model": "zai" },
      },
    });
    expect(decision.modelId).toBe("claude-model");
    expect(decision.rejections.some((r) => r.modelId === "claude-model" && r.stage === "capacity")).toBe(false);
  });

  it("control: a healthy claude lane wins back the pick, so the trip is what excludes it", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: selectionConfig(true),
      signals: {
        capacityEvidence: [healthyEvidence("claude-model"), healthyEvidence("zai-model")],
        paceVerdicts: { claude: verdictFor([HEALTHY_PEER_RECORD]), zai: zaiVerdict() },
        modelLaneByPace: { "claude-model": "claude", "zai-model": "zai" },
      },
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-model");
  });

  it("control: with paceOrdering off the verdict is inert and the cheaper model wins", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: selectionConfig(false),
      signals: {
        capacityEvidence: [healthyEvidence("claude-model"), healthyEvidence("zai-model")],
        paceVerdicts: { claude: verdictFor([HEALTHY_PEER_RECORD, TRIPPED_RECORD]), zai: zaiVerdict() },
        modelLaneByPace: { "claude-model": "claude", "zai-model": "zai" },
      },
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-model");
  });
});
