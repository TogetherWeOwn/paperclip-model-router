import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  auditCheapestLanePerTier,
  type CheapestLaneRow,
} from "../src/roster-cheapest-lane.js";

// Pins the numbers quoted in docs/operator/cheapest-lane-readout.md.
//
// The readout is produced from a frozen projection of the committed deployed
// config fixture: each enabled row takes the lane of the capacity source whose
// `modelIds` lists it. The projection is done here, in the test, so the quoted
// figures can be reproduced from this file alone and fail loudly when the
// fixture or the audit drifts. Nothing here reads a live catalogue, writes a
// roster, pins a model or touches enforce.

interface FixtureModel {
  id: string;
  tier: string;
  enabled: boolean;
  quality?: number;
  costPerMTokIn: number;
  costPerMTokOut: number;
}

interface FixtureConfig {
  models: FixtureModel[];
  capacityRouting: { sources: { id: string; modelIds: string[] }[] };
}

const fixture = JSON.parse(
  readFileSync(new URL("./data/tog1076-deployed-config.json", import.meta.url), "utf8"),
) as FixtureConfig;

/** First-match projection of source `modelIds` onto rows; a model in two sources is ambiguous, so it throws. */
function projectRows(config: FixtureConfig): { rows: CheapestLaneRow[]; lanes: string[] } {
  const laneByModel = new Map<string, string>();
  for (const source of config.capacityRouting.sources) {
    for (const modelId of source.modelIds) {
      const existing = laneByModel.get(modelId);
      if (existing !== undefined && existing !== source.id) {
        throw new Error(`model ${modelId} sits in two capacity sources: ${existing} and ${source.id}`);
      }
      laneByModel.set(modelId, source.id);
    }
  }
  const rows = config.models.map((model) => ({
    id: model.id,
    tier: model.tier,
    enabled: model.enabled,
    costPerMTokIn: model.costPerMTokIn,
    costPerMTokOut: model.costPerMTokOut,
    ...(model.quality === undefined ? {} : { quality: model.quality }),
    laneId: laneByModel.get(model.id) ?? null,
  }));
  return { rows, lanes: config.capacityRouting.sources.map((source) => source.id) };
}

describe("cheapest-lane readout is pinned to the committed deployed-config fixture", () => {
  const { rows, lanes } = projectRows(fixture);
  const [t2, t3] = auditCheapestLanePerTier({ rows, lanes });

  it("projects 106 rows onto 4 lanes", () => {
    expect(rows).toHaveLength(106);
    expect(lanes).toEqual(["cliproxy-claude", "cliproxy-codex", "cliproxy-kimi", "cliproxy-opencode-go"]);
  });

  it("T2 (strong): 43 eligible, 37 lane-bound, cheapest cliproxy/deepseek-v4-flash on opencode-go, no gap", () => {
    expect(t2).toEqual({
      tier: "strong",
      eligibleCount: 43,
      laneBoundCount: 37,
      cheapestModelId: "cliproxy/deepseek-v4-flash",
      cheapestLaneId: "cliproxy-opencode-go",
      cheapestExpectedCostUsd: expect.closeTo(0.00308, 8),
      // The gap codes fire only on a tier with no enabled row at the tier
      // itself; strong has enabled rows, so the list is empty.
      gaps: [],
    });
  });

  it("T3 (frontier): 45 eligible, 39 lane-bound, same cheapest row, no gap", () => {
    expect(t3).toEqual({
      tier: "frontier",
      eligibleCount: 45,
      laneBoundCount: 39,
      cheapestModelId: "cliproxy/deepseek-v4-flash",
      cheapestLaneId: "cliproxy-opencode-go",
      cheapestExpectedCostUsd: expect.closeTo(0.00308, 8),
      gaps: [],
    });
  });

  it("the cheapest row is a standard-tier row below both ceilings", () => {
    const cheapestRow = rows.find((row) => row.id === t2!.cheapestModelId);
    expect(cheapestRow).toMatchObject({ tier: "standard", enabled: true });
  });

  it("an equal-cost, equal-quality sibling ties and the id tie-break picks the shorter id", () => {
    const sibling = rows.find((row) => row.id === "cliproxy/deepseek-v4-flash-vision-exp");
    const winner = rows.find((row) => row.id === "cliproxy/deepseek-v4-flash");
    expect(sibling).toMatchObject({
      enabled: true,
      costPerMTokIn: winner!.costPerMTokIn,
      costPerMTokOut: winner!.costPerMTokOut,
      quality: winner!.quality,
    });
    expect(t2!.cheapestModelId).toBe("cliproxy/deepseek-v4-flash");
    // Row order must not decide the tie: with the rows reversed the sibling
    // comes first in the input, and the id tie-break still picks the winner.
    const reversed = auditCheapestLanePerTier({ rows: [...rows].reverse(), lanes });
    expect(reversed.map((entry) => entry.cheapestModelId)).toEqual(["cliproxy/deepseek-v4-flash", "cliproxy/deepseek-v4-flash"]);
  });

  it("exactly 6 enabled rows carry no lane binding, none of them the cheapest in either tier", () => {
    const unlaned = rows.filter((row) => row.enabled && row.laneId === null);
    expect(unlaned.map((row) => `${row.tier}:${row.id}`).sort()).toEqual(EXPECTED_UNLANED);
    expect(unlaned.map((row) => row.id)).not.toContain(t2!.cheapestModelId);
    expect(unlaned.map((row) => row.id)).not.toContain(t3!.cheapestModelId);
  });

  it("projection throws when a model sits in two capacity sources", () => {
    // Self-check for the guard: an ambiguous projection must not silently pick a lane.
    const first = fixture.capacityRouting.sources[0]!;
    const second = fixture.capacityRouting.sources[1]!;
    const ambiguous: FixtureConfig = {
      models: fixture.models,
      capacityRouting: {
        sources: [first, { ...second, modelIds: [...second.modelIds, first.modelIds[0]!] }],
      },
    };
    expect(() => projectRows(ambiguous)).toThrow(/sits in two capacity sources/);
  });
});

const EXPECTED_UNLANED = [
  "small:cliproxy/gemini-3.1-flash-lite",
  "standard:cliproxy/gemini-3-flash",
  "standard:cliproxy/gemini-3.1-pro-low",
  "standard:cliproxy/gemini-3.6-flash-high",
  "standard:cliproxy/gemini-3.7-flash-high",
  "standard:cliproxy/gemini-pro-agent",
];
