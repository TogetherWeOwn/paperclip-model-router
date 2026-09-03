// TOG-877 regression suite. The budget `downshift` rung exists to REDUCE spend.
// Before this fix it could not: it lowered only the tier CEILING, so
// survivors(downshift) was always a subset of survivors(ok), and the winner is
// the cost-minimum of the survivor set — shrinking a set cannot lower its
// minimum. Worse, on the live catalogue it went backwards (4.5x on the one class
// it changed) because tier is not a cost proxy: 3 of 28 `standard` models
// undercut every `small` model.
//
// These are the acceptance bars from the card, folded in so the property cannot
// regress silently. The two operator scripts (tog250-proof.mjs,
// tog250-cost-check.mjs) are reproduced here against the same seed and the same
// harvested catalogue, so a green suite is the same evidence.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { RouterConfig, TaskClassConfig } from "../src/config/types.js";
import type { ModelEntry, ModelTier } from "../src/engine/types.js";
import { fixtureConfig } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

const IN_TOKENS = 8_000;
const OK_FRACTION = 0.1;
const DOWNSHIFT_FRACTION = 0.85;

// Start from a real resolved company config so every field the engine reads is
// the one a live install would carry, then swap in the table under test. The
// budget fractions below are company-a's own: warn .7, downshift .8, halt .95.
const BASE = fixtureConfig("company-a");

function configWith(models: ModelEntry[], taskClasses: TaskClassConfig[]): RouterConfig {
  return {
    ...BASE,
    routing: { ...BASE.routing, enabled: true, stickyModelWithinIssue: false, fallbackModelId: null },
    rule0: { enabled: true, deterministicPatterns: [] },
    tiering: { defaultTier: "standard", thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, signalWeights: {} },
    taskClasses,
    models,
    budget: { monthlyCapUsd: 400, warnFraction: 0.7, downshiftFraction: 0.8, haltFraction: 0.95 },
  };
}

/** The engine reports each candidate's expected cost; read the winner's out of it. */
function winnerCost(decision: ReturnType<typeof selectModel>): number | null {
  if (decision.modelId === null) return null;
  return decision.candidates.find((entry) => entry.modelId === decision.modelId)?.expectedCostUsd ?? null;
}

describe("TOG-877: the downshift rung reduces spend on the live catalogue", () => {
  // The 42-enabled-model catalogue harvested from company A on 2026-09-03,
  // vendored byte-identical from the operator handoff. It lives under
  // tests/data/ rather than tests/fixtures/ because it is a harvested model
  // table, not a company config — scripts/verify-against-host.mjs validates
  // every tests/fixtures/*.json against the host's instanceConfigSchema.
  const harvested = JSON.parse(
    readFileSync(join(here, "data", "tog877-live-catalogue.json"), "utf8"),
  ) as Record<string, { tier: ModelTier; quality?: number; cost: number | null; enabled: boolean }>;

  const models: ModelEntry[] = Object.entries(harvested)
    .filter(([, entry]) => entry.enabled)
    .map(([id, entry]) => ({
      id,
      tier: entry.tier,
      quality: entry.quality ?? 85,
      // A model with no disclosed price must never win on price.
      costPerMTokIn: entry.cost == null ? Number.MAX_SAFE_INTEGER : (entry.cost / IN_TOKENS) * 1e6,
      costPerMTokOut: 0,
      contextWindow: 200_000,
      capabilities: ["tools", "structured-output"],
      enabled: true,
    }));

  const taskClasses = [
    { key: "mechanical", qualityFloor: 40 },
    { key: "implementation", qualityFloor: 60 },
    { key: "review", qualityFloor: 70 },
    { key: "architecture", qualityFloor: 85 },
  ];

  const config = configWith(models, taskClasses);
  const pick = (taskClass: string, fraction: number) =>
    selectModel({
      descriptor: { taskClass, summary: "TOG-877 cost check" },
      config,
      signals: { budgetSpentFraction: fraction },
    });

  it("has a catalogue where tier is genuinely not a cost proxy — the premise of the bug", () => {
    // If this ever stops holding, the old tier-drop rung would look harmless
    // again. Assert the inversion so the reason for the fix stays visible.
    const priced = models.filter((model) => model.costPerMTokIn !== Number.MAX_SAFE_INTEGER);
    const cheapestIn = (tier: ModelTier) =>
      Math.min(...priced.filter((model) => model.tier === tier).map((model) => model.costPerMTokIn));
    expect(cheapestIn("standard")).toBeLessThan(cheapestIn("small"));
  });

  for (const taskClass of ["mechanical", "implementation", "review", "architecture"]) {
    it(`never costs more under downshift than under ok — ${taskClass}`, () => {
      const ok = pick(taskClass, OK_FRACTION);
      const downshift = pick(taskClass, DOWNSHIFT_FRACTION);
      expect(ok.gates.budget).toBe("ok");
      expect(downshift.gates.budget).toBe("downshift");
      expect(ok.outcome).toBe("selected");
      expect(downshift.outcome).toBe("selected");
      expect(winnerCost(downshift)!).toBeLessThanOrEqual(winnerCost(ok)!);
    });
  }

  it("no longer picks the 4.5x-dearer small-tier model on the mechanical class", () => {
    // The exact regression the card was filed for: downshift used to move this
    // class from $0.00110 to $0.00500 by dropping standard -> small.
    const downshift = pick("mechanical", DOWNSHIFT_FRACTION);
    expect(downshift.modelId).toBe("opencode-go/glm-5.3-flash");
    expect(downshift.modelId).not.toBe("cliproxy/gemini-3.1-flash-lite");
  });
});

describe("TOG-877: downshift can reduce cost, and can never raise it, on any catalogue", () => {
  // The randomized bar from the card: 20,000 synthetic catalogues through the
  // real engine, deterministic seed so this reproduces byte-for-byte.
  const TIERS: ModelTier[] = ["small", "standard", "strong", "frontier"];

  function sweep() {
    let seed = 20260903;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pickOne = <T>(values: readonly T[]): T => values[Math.floor(rnd() * values.length)]!;

    let cases = 0;
    let cheaper = 0;
    let dearer = 0;
    let refusedOnly = 0;

    for (let trial = 0; trial < 20_000; trial++) {
      const count = 1 + Math.floor(rnd() * 8);
      const models: ModelEntry[] = Array.from({ length: count }, (_unused, index) => ({
        id: `m${index}`,
        tier: pickOne(TIERS),
        quality: Math.floor(rnd() * 101),
        costPerMTokIn: Math.round(rnd() * 100_000) / 10,
        costPerMTokOut: 0,
        contextWindow: 200_000,
        capabilities: ["tools", "structured-output"],
        enabled: true,
      }));
      const floor = Math.floor(rnd() * 101);
      const config = configWith(models, [{ key: "t", qualityFloor: floor }]);

      const ok = selectModel({ descriptor: { taskClass: "t" }, config, signals: { budgetSpentFraction: OK_FRACTION } });
      const down = selectModel({ descriptor: { taskClass: "t" }, config, signals: { budgetSpentFraction: DOWNSHIFT_FRACTION } });

      if (ok.outcome !== "selected") continue;
      cases++;
      if (down.outcome !== "selected") {
        refusedOnly++;
        continue;
      }
      const okCost = winnerCost(ok)!;
      const downCost = winnerCost(down)!;
      if (downCost < okCost - 1e-12) cheaper++;
      else if (downCost > okCost + 1e-12) dearer++;
    }
    return { cases, cheaper, dearer, refusedOnly };
  }

  const result = sweep();

  it("selects a model on the ok rung in the great majority of trials", () => {
    expect(result.cases).toBe(15_660);
  });

  it("picks a strictly CHEAPER model in a non-zero number of trials", () => {
    // The bar the card names: this was 0 before the fix.
    expect(result.cheaper).toBeGreaterThan(0);
  });

  it("never picks a MORE EXPENSIVE model", () => {
    // The bar the card names: this was 2040 before the fix.
    expect(result.dearer).toBe(0);
  });

  it("never refuses work that the ok rung would have taken", () => {
    // Halting is the halt rung's job, and is explicitly out of this card's scope.
    expect(result.refusedOnly).toBe(0);
  });
});

describe("TOG-877: the rung only readmits models that undercut the ok-rung price", () => {
  // A cost reduction is only possible if the rung WIDENS the survivor set — the
  // winner is that set's minimum. Widening is safe precisely because every
  // readmitted model is strictly cheaper than what the router was about to pay.
  const models: ModelEntry[] = [
    { id: "dear-small", tier: "small", quality: 50, costPerMTokIn: 100, costPerMTokOut: 0, contextWindow: 200_000, capabilities: ["tools"], enabled: true },
    { id: "cheap-strong", tier: "strong", quality: 50, costPerMTokIn: 1, costPerMTokOut: 0, contextWindow: 200_000, capabilities: ["tools"], enabled: true },
    { id: "dear-strong", tier: "strong", quality: 90, costPerMTokIn: 500, costPerMTokOut: 0, contextWindow: 200_000, capabilities: ["tools"], enabled: true },
  ];
  const config = configWith(models, [{ key: "t", qualityFloor: 40, maxTier: "small" }]);
  const at = (fraction: number) =>
    selectModel({ descriptor: { taskClass: "t" }, config, signals: { budgetSpentFraction: fraction } });

  it("keeps the class ceiling when the budget is not under pressure", () => {
    const ok = at(OK_FRACTION);
    expect(ok.modelId).toBe("dear-small");
    expect(ok.effectiveTier).toBe("small");
  });

  it("readmits the above-ceiling model that undercuts it, and says so in the trace", () => {
    const down = at(DOWNSHIFT_FRACTION);
    expect(down.modelId).toBe("cheap-strong");
    expect(down.trace.join("\n")).toContain("readmitted 1 model(s)");
  });

  it("leaves the dearer above-ceiling model rejected on the tier ceiling", () => {
    const down = at(DOWNSHIFT_FRACTION);
    expect(down.candidates.map((entry) => entry.modelId)).not.toContain("dear-strong");
    expect(down.rejections).toContainEqual(
      expect.objectContaining({ modelId: "dear-strong", stage: "tier-ceiling" }),
    );
  });

  it("reports the tier it actually routed to, not the ceiling it was given", () => {
    // effectiveTier feeds the audit trail; it must not claim `small` when the
    // router deliberately spent on a `strong` model to save money.
    expect(at(DOWNSHIFT_FRACTION).effectiveTier).toBe("strong");
  });
});
