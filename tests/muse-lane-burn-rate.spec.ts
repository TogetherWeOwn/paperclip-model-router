import { describe, expect, it } from "vitest";

import {
  museLaneBurnRate,
  museLaneInputFromWeeklyWindow,
  rankMuseLaneBurnRates,
  type MuseLaneBurnRateInput,
} from "../packages/lane-capacity/src/muse-burn-rate.js";

// Muse-lane headroom-per-hour burn-rate readout (read-only).
//
// Synthetic lane states only: every input below is hand-built from the same
// fields the countdown slice reads (weekly-window utilization, resetsAt, and
// the asOf clock) — no live telemetry, no roster write, no enforce change.
// The ranking proves the tightest lane (least headroom per hour) sorts
// first. This spec never asserts a countdown: `resetInSeconds` display
// stays owned by the countdown slice, and the ranking carries no such
// field by construction.

// Weekly reset shared by every synthetic state: 2026-10-05T00:00:00Z.
const RESET_AT = "2026-10-05T00:00:00.000Z";
// Readout taken 96h before reset, so hoursToReset is exactly 96.
const AS_OF = "2026-10-01T00:00:00.000Z";

function lane(laneId: string, utilization: number | null): MuseLaneBurnRateInput {
  return { laneId, utilization, resetsAt: RESET_AT, asOf: AS_OF };
}

describe("muse lane headroom-per-hour burn-rate readout (read-only)", () => {
  it("sorts 4 synthetic lane states by burn-rate ascending, tightest first", () => {
    const ranked = rankMuseLaneBurnRates([
      lane("muse-cool", 0.25),
      lane("muse-hot", 0.95),
      lane("muse-warm", 0.8),
      lane("muse-overdrawn", 1.1),
    ]);
    expect(ranked.map((row) => row.laneId)).toEqual([
      "muse-overdrawn",
      "muse-hot",
      "muse-warm",
      "muse-cool",
    ]);
    // Exact rates: remaining headroom over exactly 96h to the 10-05 reset.
    expect(ranked[0]!.burnRate).toBeCloseTo(-0.1 / 96, 10);
    expect(ranked[1]!.burnRate).toBeCloseTo(0.05 / 96, 10);
    expect(ranked[2]!.burnRate).toBeCloseTo(0.2 / 96, 10);
    expect(ranked[3]!.burnRate).toBeCloseTo(0.75 / 96, 10);
    for (const row of ranked) expect(row.reason).toBe("ok");
  });

  it("sorts unratable lanes last without guessing a rate", () => {
    const ranked = rankMuseLaneBurnRates([
      lane("muse-cool", 0.25),
      lane("muse-unmeasured", null),
      { laneId: "muse-no-reset", utilization: 0.99, resetsAt: null, asOf: AS_OF },
      lane("muse-hot", 0.95),
    ]);
    expect(ranked.map((row) => row.laneId)).toEqual([
      "muse-hot",
      "muse-cool",
      "muse-unmeasured",
      "muse-no-reset",
    ]);
    expect(ranked[2]!.burnRate).toBeNull();
    expect(ranked[2]!.reason).toBe("no-computable-window");
    expect(ranked[3]!.burnRate).toBeNull();
    expect(ranked[3]!.reason).toBe("no-computable-window");
  });

  it("weighs nearer resets heavier at equal utilization, elapsed resets never rate", () => {
    const asOf = "2026-10-04T12:00:00.000Z";
    const ranked = rankMuseLaneBurnRates([
      { laneId: "muse-far", utilization: 0.5, resetsAt: "2026-10-05T00:00:00.000Z", asOf },
      { laneId: "muse-near", utilization: 0.5, resetsAt: "2026-10-04T18:00:00.000Z", asOf },
      { laneId: "muse-elapsed", utilization: 0.1, resetsAt: "2026-10-04T11:00:00.000Z", asOf },
    ]);
    // Same headroom, less time: the nearer reset allows a higher spend rate.
    expect(ranked.map((row) => row.laneId)).toEqual(["muse-far", "muse-near", "muse-elapsed"]);
    expect(ranked[0]!.burnRate).toBeCloseTo(0.5 / 12, 10);
    expect(ranked[1]!.burnRate).toBeCloseTo(0.5 / 6, 10);
    expect(ranked[2]!.burnRate).toBeNull();
    expect(ranked[2]!.reason).toBe("window-already-elapsed");
  });

  it("ranks from weekly CapacityWindow fields and skips lanes with no weekly window", () => {
    const input = museLaneInputFromWeeklyWindow(
      "muse-spark-1.3-contributor",
      [
        {
          name: "weekly",
          utilization: 0.75,
          resetsAt: RESET_AT,
          remainingFraction: 0.25,
          sourcePath: "models[].windows.utilization",
        },
      ],
      AS_OF,
    )!;
    const ranked = rankMuseLaneBurnRates([lane("muse-cool", 0.25), input]);
    expect(ranked.map((row) => row.laneId)).toEqual(["muse-spark-1.3-contributor", "muse-cool"]);
    expect(ranked[0]!.remainingFraction).toBe(0.25);
    expect(
      museLaneInputFromWeeklyWindow("muse-other", [], AS_OF),
    ).toBeNull();
  });

  it("never mutates the input and never emits a countdown field", () => {
    const lanes = [lane("muse-hot", 0.95), lane("muse-cool", 0.25)];
    const frozen = structuredClone(lanes);
    const ranked = rankMuseLaneBurnRates(lanes);
    expect(lanes).toEqual(frozen);
    expect(ranked).not.toBe(lanes);
    for (const row of ranked) {
      expect(row).not.toHaveProperty("resetInSeconds");
      expect(JSON.stringify(row)).not.toContain("resetInSeconds");
    }
    // Dirty clocks rate as uncomputable, never throw.
    expect(museLaneBurnRate({ laneId: "x", utilization: 0.5, resetsAt: "not-a-time", asOf: AS_OF }).reason).toBe(
      "no-computable-window",
    );
  });
});
