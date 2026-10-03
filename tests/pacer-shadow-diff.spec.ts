import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceDefinition,
} from "../packages/lane-capacity/src/pace.js";
import type { CapacityEvidence, LanePaceVerdict } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { buildDecisionDiff } from "../src/decision-diff.js";
import { selectModel } from "../src/engine/select.js";

// TOG-14235: shadow-mode dual-policy diff on RECORDED decisions (read-only).
//
// Baseline (recorded serving policy): capacityRouting.mode shadow with
// paceOrdering off — static cost order serves, the pace-aware pick surfaces
// only as the shadow advisory. Candidate (promotion): mode enforce with
// paceOrdering on. Both run offline through the real selector over the same
// recorded inputs; no policy is applied, nothing is re-admitted.
//
// Recorded inputs (frozen in the sibling fixture, never synthesized here):
// - pace verdicts: real evaluations of packages/lane-capacity/tests/data/tog2135
//   lane documents at their frozen observedAt (claude behind, the other three
//   ahead). The first test below re-evaluates and pins those summaries.
// - capacity evidence: per-source first-record values from the recorded live
//   snapshot tests/data/tog1076-live-snapshot.json (modelId remapped to the
//   case models; every other field verbatim).
// Non-goal boundary: TOG-14188 replays synthetic states against the admit/deny
// table; this suite diffs two policies over recorded decisions. TOG-14079 owns
// the audit-log append path; nothing here writes a decision record.

interface FixtureCase {
  id: string;
  title: string;
  note: string;
  descriptor: Record<string, unknown>;
  evidence: string[];
  paceLanes: string[];
  onlyModels?: string[];
  budgetSpentFraction?: number;
  stickyModelId?: string;
  stickyRouting?: boolean;
  reason: string;
  expect: {
    baseline: { outcome: string; modelId: string | null; lane: string | null };
    candidate: { outcome: string; modelId: string | null; lane: string | null };
  };
}

interface Fixture {
  version: number;
  baseline: string;
  candidate: string;
  agree: number;
  disagree: number;
  models: Array<Record<string, unknown>>;
  taskClasses: Array<{ key: string; qualityFloor: number }>;
  modelLaneByPace: Record<string, string>;
  paceVerdicts: Record<string, {
    laneId: string; state: string; reason: string; serviceable: boolean;
    utilization: number; elapsed: number; deviation: number;
  }>;
  evidence: Record<string, CapacityEvidence>;
  inputs: { laneDocuments: Record<string, string> };
  cases: FixtureCase[];
}

function loadFixture(): Fixture {
  const path = fileURLToPath(new URL("./pacer-shadow-diff.fixture.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

const OBSERVED_AT = "2026-09-10T14:53:41.507882Z";

function laneDefinition(lane: string, allowance: string): LanePaceDefinition {
  return {
    laneId: lane,
    healthFields: ["health"],
    windows: [
      { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
      { name: allowance, role: "allowance", utilizationFields: [`${allowance}_utilization`], resetFields: [`${allowance}_resets_at`] },
    ],
  };
}

const LANE_DEFS: Record<string, LanePaceDefinition> = {
  claude: laneDefinition("claude", "seven_day"),
  codex: laneDefinition("codex", "weekly"),
  kimi: laneDefinition("kimi", "weekly"),
  "opencode-go": laneDefinition("opencode-go", "monthly"),
};

const LANE_ID_OF: Record<string, string> = {
  claude: "cliproxy-claude",
  codex: "cliproxy-codex",
  kimi: "cliproxy-kimi",
  "opencode-go": "cliproxy-opencode-go",
};

function laneDocument(name: string): unknown {
  const path = fileURLToPath(new URL(`../packages/lane-capacity/tests/data/tog2135/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function fullVerdict(laneId: string, summary: Fixture["paceVerdicts"][string]): LanePaceVerdict {
  return {
    laneId,
    observedAt: OBSERVED_AT,
    state: summary.state as LanePaceVerdict["state"],
    serviceable: summary.serviceable,
    score: { utilization: summary.utilization, elapsed: summary.elapsed, deviation: summary.deviation },
    accounts: [],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: summary.reason as LanePaceVerdict["reason"],
  };
}

function configFor(fixture: Fixture, mode: "shadow" | "enforce", paceOrdering: boolean, c: FixtureCase) {
  return resolveConfig({
    routing: {
      enabled: true,
      mode,
      fallbackModelId: null,
      stickyModelWithinIssue: c.stickyRouting ?? false,
      maxOutputTokens: 16384,
    },
    capacityRouting: { enabled: true, mode, paceOrdering, sources: [] },
    models: (c.onlyModels
      ? fixture.models.filter((m) => c.onlyModels!.includes(m.id as string))
      : fixture.models) as never,
    taskClasses: fixture.taskClasses as never,
    tiering: {
      signalWeights: {},
      thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 },
      defaultTier: "standard",
    },
  });
}

function signalsFor(fixture: Fixture, c: FixtureCase) {
  const paceVerdicts: Record<string, LanePaceVerdict> = {};
  for (const lane of c.paceLanes) {
    const laneId = LANE_ID_OF[lane]!;
    paceVerdicts[laneId] = fullVerdict(laneId, fixture.paceVerdicts[laneId]!);
  }
  const signals: Record<string, unknown> = {
    capacityEvidence: c.evidence.map((key) => structuredClone(fixture.evidence[key])),
    capacityTelemetry: "available",
    paceVerdicts,
    modelLaneByPace: fixture.modelLaneByPace,
  };
  if (c.budgetSpentFraction !== undefined) signals.budgetSpentFraction = c.budgetSpentFraction;
  if (c.stickyModelId !== undefined) signals.stickyModelId = c.stickyModelId;
  return signals;
}

describe("TOG-14235: recorded pace verdicts reproduce through the real evaluator", () => {
  it.each([
    ["claude", "behind", -0.13, "ok"],
    ["codex", "ahead", 0.537, "ok"],
    ["kimi", "ahead", 0.118, "ok"],
    ["opencode-go", "ahead", 0.279, "ok"],
  ])("%s evaluates to %s (deviation %s)", (doc, state, deviation, reason) => {
    const fixture = loadFixture();
    const laneId = LANE_ID_OF[doc]!;
    const live = evaluateLanePace({
      observation: normalizeLaneDocument({ document: laneDocument(doc), definition: LANE_DEFS[doc]! }),
      asOf: OBSERVED_AT,
    });
    const frozen = fixture.paceVerdicts[laneId]!;
    expect(live.state).toBe(state);
    expect(live.reason).toBe(reason);
    expect(live.score!.deviation).toBeCloseTo(deviation, 3);
    // The fixture summary is the recorded verdict, not a re-typed copy.
    expect(frozen.state).toBe(live.state);
    expect(frozen.deviation).toBeCloseTo(live.score!.deviation, 3);
    expect(frozen.reason).toBe(live.reason);
  });
});

describe("TOG-14235: dual-policy diff over recorded decisions", () => {
  const fixture = loadFixture();

  it("pins the corpus size and the agree/disagree split", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.cases).toHaveLength(12);
    expect(fixture.agree).toBe(7);
    expect(fixture.disagree).toBe(5);
  });

  it.each([
    "d01-full-roster", "d02-kimi-lane-down", "d03-claude-evidence-only", "d04-single-model",
    "d05-quality-floor", "d06-capability-gate", "d07-budget-halt", "d08-stale-pace-aligned",
    "d09-stale-pace-splits", "d10-pin-honored", "d11-pin-on-exhausted", "d12-sticky-incumbent",
  ])("case %s: real selector reproduces both recorded decisions", (id) => {
    const c = fixture.cases.find((entry) => entry.id === id)!;
    expect(c).toBeDefined();
    const descriptor = { ...(c.descriptor as object) } as Parameters<typeof selectModel>[0]["descriptor"];
    const baseline = selectModel({
      descriptor: structuredClone(descriptor),
      config: configFor(fixture, "shadow", false, c),
      signals: signalsFor(fixture, c) as never,
    });
    const candidate = selectModel({
      descriptor: structuredClone(descriptor),
      config: configFor(fixture, "enforce", true, c),
      signals: signalsFor(fixture, c) as never,
    });
    expect({ outcome: baseline.outcome, modelId: baseline.modelId }).toEqual({
      outcome: c.expect.baseline.outcome, modelId: c.expect.baseline.modelId,
    });
    expect(baseline.capacity.selectedSource).toBe(c.expect.baseline.lane);
    expect({ outcome: candidate.outcome, modelId: candidate.modelId }).toEqual({
      outcome: c.expect.candidate.outcome, modelId: c.expect.candidate.modelId,
    });
    expect(candidate.capacity.selectedSource).toBe(c.expect.candidate.lane);
    const diff = buildDecisionDiff(
      { source: baseline.capacity.selectedSource, laneLabel: baseline.capacity.selectedLaneLabel, modelId: baseline.modelId },
      { source: candidate.capacity.selectedSource, laneLabel: candidate.capacity.selectedLaneLabel, modelId: candidate.modelId },
      c.reason || "steady state",
    );
    const expectChanged = c.expect.baseline.modelId !== c.expect.candidate.modelId;
    expect(diff.changed).toBe(expectChanged);
    if (expectChanged) {
      // Every disagreement names its lever: pace ordering, a pin refusal, or
      // the capacity-utilization fallback when pace is stale.
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.reason).toMatch(/pace ordering|pin refused/i);
    }
  });

  it("the recorded split is 7 agree / 5 disagree", () => {
    let agree = 0;
    let disagree = 0;
    for (const c of fixture.cases) {
      if (c.expect.baseline.modelId === c.expect.candidate.modelId) agree += 1;
      else disagree += 1;
    }
    expect(agree).toBe(fixture.agree);
    expect(disagree).toBe(fixture.disagree);
  });
});
