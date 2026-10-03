import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CapacityEvidence, LanePaceVerdict } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

const here = dirname(fileURLToPath(import.meta.url));

interface SyntheticEvidence {
  modelId: string;
  health: CapacityEvidence["health"];
  utilization: number | null;
  telemetryAvailable: boolean;
}

interface SyntheticPace {
  lane: string;
  state: LanePaceVerdict["state"];
  reason: LanePaceVerdict["reason"];
  deviation: number | null;
}

interface SyntheticState {
  id: string;
  title: string;
  config: { mode: "shadow" | "enforce"; unknownTelemetry: "fail-open" | "fail-closed" | "exclude-lane"; paceOrdering: boolean };
  evidence: SyntheticEvidence[];
  pace: SyntheticPace | null;
  expect: { decision: "admit" | "deny"; reasonContains: string };
}

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "pacer-policy-replay.json"), "utf8"),
) as { version: number; states: SyntheticState[] };

function toEvidence(entry: SyntheticEvidence): CapacityEvidence {
  return {
    modelId: entry.modelId,
    source: "synthetic",
    laneLabel: "record-1",
    health: entry.health,
    posture: entry.telemetryAvailable && entry.health !== "unknown" ? "available" : "unknown",
    utilization: entry.utilization,
    remainingFraction: entry.utilization === null ? null : 1 - entry.utilization,
    resetsAt: "2026-09-11T00:00:00Z",
    resetInSeconds: 3600,
    windows: [],
    telemetryAvailable: entry.telemetryAvailable,
    reason: "synthetic replay",
  };
}

function toVerdict(pace: SyntheticPace): LanePaceVerdict {
  return {
    laneId: pace.lane,
    observedAt: "2026-09-10T14:53:41.507882Z",
    state: pace.state,
    serviceable: pace.state === "exhausted" ? false : pace.state === "unknown" ? null : true,
    score: pace.deviation === null
      ? null
      : { utilization: 0.3, elapsed: 0.3 - pace.deviation, deviation: pace.deviation },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: pace.state === "exhausted" ? 0 : 1,
    urgentResetAt: null,
    reason: pace.reason,
  };
}

describe("pacer policy replay on synthetic capacity states (offline)", () => {
  for (const state of fixture.states) {
    it(`${state.id}: ${state.expect.decision}`, () => {
      const config = resolveConfig({
        routing: { enabled: true, mode: state.config.mode, fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
        capacityRouting: {
          enabled: true,
          mode: state.config.mode,
          unknownTelemetry: state.config.unknownTelemetry,
          paceOrdering: state.config.paceOrdering,
          sources: [],
        },
        models: [
          { id: "subject", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
        ],
        taskClasses: [{ key: "implementation", qualityFloor: 60 }],
        tiering: { signalWeights: { filesTouched: 4, ambiguity: 20 }, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "standard" },
      });
      const decision = selectModel({
        descriptor: { taskClass: "implementation" },
        config,
        signals: {
          capacityEvidence: state.evidence.map(toEvidence),
          capacityTelemetry: "available",
          paceVerdicts: state.pace ? { [state.pace.lane]: toVerdict(state.pace) } : {},
          modelLaneByPace: state.pace ? { subject: state.pace.lane } : {},
        },
      });
      if (state.expect.decision === "admit") {
        expect(decision.outcome).toBe("selected");
        expect(decision.modelId).toBe("subject");
      } else {
        expect(decision.outcome).toBe("no-eligible-model");
        expect(decision.candidates.some((candidate) => candidate.modelId === "subject")).toBe(false);
      }
      expect(JSON.stringify(decision)).toContain(state.expect.reasonContains);
    });
  }
});
