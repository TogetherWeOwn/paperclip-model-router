/**
 * TOG-7882 (gap G3): `scoreTier` walks MODEL_TIER_ORDER from the top and
 * returns the first tier whose threshold the score reaches, so it silently
 * assumes small<=standard<=strong<=frontier. A misordered
 * `tiering.thresholds` mis-tiers every scored task with no error.
 *
 * Each validation test below feeds thresholds through the REAL
 * `onValidateConfig` entry point and asserts the refusal names the offending
 * pair, so deleting the ordering check turns this suite red. The boundary
 * tests pin the documented tiering semantics: a score exactly on a threshold
 * reaches that tier (inclusive lower bound).
 */
import { describe, expect, it } from "vitest";

import { scoreTier } from "../src/engine/select.js";
import { createPlugin } from "../src/worker.js";
import { fixtureConfig, readFixture } from "./helpers.js";

function baseRaw(): Record<string, unknown> {
  return structuredClone(readFixture("company-a")) as Record<string, unknown>;
}

function withThresholds(thresholds: Record<string, number>): Record<string, unknown> {
  const raw = baseRaw();
  (raw.tiering as Record<string, unknown>).thresholds = thresholds;
  return raw;
}

async function validate(raw: Record<string, unknown>) {
  const { definition } = createPlugin();
  const result = await definition.onValidateConfig!(raw);
  return { ok: result.ok, errors: result.errors ?? [] };
}

function tieringErrors(errors: string[]): string[] {
  return errors.filter((entry) => entry.includes("tiering.thresholds"));
}

const ORDERED = { small: 0, standard: 30, strong: 60, frontier: 85 };

describe("TOG-7882: misordered tiering.thresholds fail closed at write time", () => {
  it("accepts ordered thresholds (fixture baseline stays green)", async () => {
    const result = await validate(withThresholds({ ...ORDERED }));
    expect(tieringErrors(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const swaps: Array<{ lower: string; upper: string; thresholds: Record<string, number> }> = [
    { lower: "small", upper: "standard", thresholds: { small: 30, standard: 0, strong: 60, frontier: 85 } },
    { lower: "standard", upper: "strong", thresholds: { small: 0, standard: 60, strong: 30, frontier: 85 } },
    { lower: "strong", upper: "frontier", thresholds: { small: 0, standard: 30, strong: 85, frontier: 60 } },
  ];
  for (const { lower, upper, thresholds } of swaps) {
    it(`refuses a swap of ${lower} and ${upper}, naming the pair`, async () => {
      const result = await validate(withThresholds(thresholds));
      expect(result.ok).toBe(false);
      const failures = tieringErrors(result.errors);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(lower);
      expect(failures[0]).toContain(upper);
    });
  }

  it("catches a non-adjacent inversion (small above frontier trips the small<=standard pair)", async () => {
    const result = await validate(withThresholds({ small: 100, standard: 30, strong: 60, frontier: 85 }));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("tiering.thresholds must satisfy small <= standard");
  });

  it("allows equal thresholds (a collapsed tier is deliberate, not a silent mis-tier)", async () => {
    const result = await validate(withThresholds({ small: 0, standard: 30, strong: 30, frontier: 85 }));
    expect(tieringErrors(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("TOG-7882: scoreTier boundary tiers", () => {
  function tierFor(score: number): string {
    const config = fixtureConfig("company-a");
    config.tiering.signalWeights = { effort: 1 };
    config.tiering.thresholds = { ...ORDERED };
    return scoreTier({ signals: { effort: score } }, config).tier;
  }

  const exact: Array<[number, string]> = [
    [0, "small"],
    [30, "standard"],
    [60, "strong"],
    [85, "frontier"],
  ];
  for (const [score, tier] of exact) {
    it(`scores exactly ${score} on a threshold -> ${tier}`, () => {
      expect(tierFor(score)).toBe(tier);
    });
  }

  const near: Array<[number, string]> = [
    [29.99, "small"],
    [59.99, "standard"],
    [84.99, "strong"],
    [100, "frontier"],
  ];
  for (const [score, tier] of near) {
    it(`scores ${score} just below the next threshold -> ${tier}`, () => {
      expect(tierFor(score)).toBe(tier);
    });
  }

  it("returns the default tier with a null score when no signals are present", () => {
    const config = fixtureConfig("company-a");
    expect(scoreTier({}, config)).toEqual({ tier: config.tiering.defaultTier, score: null });
  });
});
