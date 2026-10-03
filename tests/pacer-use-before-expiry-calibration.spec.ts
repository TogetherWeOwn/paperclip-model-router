import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluateLanePace, normalizeLaneDocument } from "../packages/lane-capacity/src/pace.js";
import type { CapacityEvidence, LanePaceDefinition, LanePaceVerdict } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

// Use-before-expiry calibration vectors, offline fixtures only.
//
// Each lane burns toward a fixed weekly expiry while snapshots are taken
// nearer and nearer the reset. Every step runs through the real pace
// evaluator and the real model selector; the suite pins the admit/deny
// sequence per lane and proves admission tightens monotonically (once a lane
// denies near expiry it never re-admits).
//
// Scope boundaries (owned elsewhere, not duplicated here):
// - single-state admit/deny policy table: the pacer policy replay harness;
// - per-decision allow/deny audit log: the admission audit slice;
// - fleet mix drift readout: the drift snapshot slice;
// - which window wins when weekly pace and the five-hour backstop disagree:
//   the weekly-vs-five-hour conflict slice (deny steps here trip the
//   backstop while the allowance reads hot-but-usable; the suite pins the
//   burn-path sequence, not the precedence rule);
// - margin deadband boundaries: the hysteresis slice (every vector stays
//   clear of the trip ceiling and the pace margin edges).
//
// The fixture lives beside this spec, not in tests/fixtures/: the host gate
// validates every JSON file directly under tests/fixtures/ against the
// instance config schema, which a synthetic calibration table can never
// satisfy.

const here = dirname(fileURLToPath(import.meta.url));

interface BurnStep {
  id: string;
  hoursBeforeExpiry: number;
  allowanceUtilization: number;
  fiveHourUtilization: number;
  expectState: LanePaceVerdict["state"];
  expectReason: LanePaceVerdict["reason"];
  expectDecision: "admit" | "deny";
}

interface UrgencyStep {
  id: string;
  hoursBeforeExpiry: number;
  expectState: "behind" | "behind-urgent";
}

interface LaneVectors {
  laneId: string;
  allowanceWindow: string;
  burn: BurnStep[];
  urgency: UrgencyStep[];
}

const fixture = JSON.parse(
  readFileSync(join(here, "pacer-use-before-expiry-calibration.fixture.json"), "utf8"),
) as { version: number; policy: string; expiry: string; lanes: Record<string, LaneVectors> };

const WEEK_SECONDS = 604_800;
const FIVE_HOUR_SECONDS = 18_000;
const HOUR_MS = 3_600_000;

function definitionFor(lane: LaneVectors): LanePaceDefinition {
  return {
    laneId: lane.laneId,
    healthFields: ["health"],
    windows: [
      { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
      { name: lane.allowanceWindow, role: "allowance", utilizationFields: [`${lane.allowanceWindow}_utilization`], resetFields: [`${lane.allowanceWindow}_resets_at`] },
    ],
  };
}

function documentFor(lane: LaneVectors, asOf: string, allowanceUtilization: number, fiveHourUtilization: number): unknown {
  return {
    schemaVersion: 1,
    observedAt: asOf,
    staleAfterSeconds: 7200,
    records: [
      {
        health: "healthy",
        weight: 1,
        governing_window: lane.allowanceWindow,
        window_seconds: { five_hour: FIVE_HOUR_SECONDS, [lane.allowanceWindow]: WEEK_SECONDS },
        five_hour_utilization: fiveHourUtilization,
        five_hour_resets_at: new Date(Date.parse(asOf) + 3 * HOUR_MS).toISOString(),
        [`${lane.allowanceWindow}_utilization`]: allowanceUtilization,
        [`${lane.allowanceWindow}_resets_at`]: fixture.expiry,
      },
    ],
  };
}

function verdictFor(lane: LaneVectors, step: { hoursBeforeExpiry: number; allowanceUtilization: number; fiveHourUtilization: number }): LanePaceVerdict {
  const asOf = new Date(Date.parse(fixture.expiry) - step.hoursBeforeExpiry * HOUR_MS).toISOString();
  return evaluateLanePace({
    observation: normalizeLaneDocument({
      document: documentFor(lane, asOf, step.allowanceUtilization, step.fiveHourUtilization),
      definition: definitionFor(lane),
    }),
    asOf,
  });
}

function decideFor(lane: LaneVectors, step: { hoursBeforeExpiry: number; allowanceUtilization: number }, verdict: LanePaceVerdict) {
  const config = resolveConfig({
    routing: { enabled: true, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry: "fail-open", paceOrdering: true, sources: [] },
    models: [
      { id: "subject", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 60 }],
    tiering: { signalWeights: {}, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
  });
  const evidence: CapacityEvidence = {
    modelId: "subject",
    source: "synthetic",
    laneLabel: "record-1",
    health: "healthy",
    posture: "available",
    utilization: step.allowanceUtilization,
    remainingFraction: 1 - step.allowanceUtilization,
    resetsAt: fixture.expiry,
    resetInSeconds: Math.round(step.hoursBeforeExpiry * 3600),
    windows: [],
    telemetryAvailable: true,
    reason: "synthetic calibration",
  };
  return selectModel({
    descriptor: { taskClass: "implementation" },
    config,
    signals: {
      capacityEvidence: [evidence],
      capacityTelemetry: "available",
      paceVerdicts: { [lane.laneId]: verdict },
      modelLaneByPace: { subject: lane.laneId },
    },
  });
}

describe("pacer use-before-expiry calibration vectors (offline)", () => {
  for (const lane of Object.values(fixture.lanes)) {
    describe(`lane ${lane.laneId}`, () => {
      it("burns monotonically toward expiry (fixture hygiene: nearer means hotter, never cooler)", () => {
        for (let index = 1; index < lane.burn.length; index += 1) {
          const prev = lane.burn[index - 1]!;
          const next = lane.burn[index]!;
          expect(next.hoursBeforeExpiry).toBeLessThan(prev.hoursBeforeExpiry);
          expect(next.allowanceUtilization).toBeGreaterThanOrEqual(prev.allowanceUtilization);
          expect(next.fiveHourUtilization).toBeGreaterThanOrEqual(prev.fiveHourUtilization);
        }
      });

      it("pins the calibrated admit/deny sequence through the real evaluator and selector", () => {
        for (const step of lane.burn) {
          const verdict = verdictFor(lane, step);
          expect(verdict.state).toBe(step.expectState);
          expect(verdict.reason).toBe(step.expectReason);
          const decision = decideFor(lane, step, verdict);
          if (step.expectDecision === "admit") {
            expect(verdict.serviceable).toBe(true);
            expect(decision.outcome).toBe("selected");
            expect(decision.modelId).toBe("subject");
          } else {
            expect(verdict.serviceable).toBe(false);
            expect(decision.outcome).toBe("no-eligible-model");
            expect(decision.candidates.some((candidate) => candidate.modelId === "subject")).toBe(false);
            expect(decision.rejections.some((rejection) => rejection.stage === "capacity")).toBe(true);
          }
        }
      });

      it("tightens monotonically: once denied near expiry the lane never re-admits", () => {
        const decisions = lane.burn.map((step) => {
          const decision = decideFor(lane, step, verdictFor(lane, step));
          return decision.outcome === "selected" ? "admit" : "deny";
        });
        expect(decisions).toContain("deny");
        const firstDeny = decisions.indexOf("deny");
        expect(decisions.slice(firstDeny).every((entry) => entry === "deny")).toBe(true);
      });

      it("flags use-before-expiry urgency monotonically without ever denying the under-burned lane", () => {
        const states = lane.urgency.map((step) => {
          const verdict = verdictFor(lane, { ...step, allowanceUtilization: 0.2, fiveHourUtilization: 0.1 });
          expect(verdict.state).toBe(step.expectState);
          const decision = decideFor(lane, { ...step, allowanceUtilization: 0.2 }, verdict);
          expect(decision.outcome).toBe("selected");
          expect(decision.modelId).toBe("subject");
          return verdict.state;
        });
        expect(states).toContain("behind-urgent");
        const firstUrgent = states.indexOf("behind-urgent");
        expect(states.slice(firstUrgent).every((entry) => entry === "behind-urgent")).toBe(true);
      });
    });
  }
});
