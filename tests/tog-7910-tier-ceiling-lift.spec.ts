/**
 * TOG-7910 (gap G3x): mutation-pin the tier-ceiling lift
 * (`src/engine/select.ts`, the `appliedCeiling` branch, lines ~174-179).
 *
 * When nothing at or below the tier ceiling clears the quality floor, the
 * router LIFTS the ceiling to the lowest qualifying tier instead of refusing
 * with `no-eligible-model`. The lift silently widens the served tier
 * (`requestedTier` stays put while `effectiveTier` moves up), so weakening it
 * strands exactly these tasks at `no-eligible-model` — with no other test
 * turning red, because every other fixture keeps something servable inside
 * its own ceiling.
 *
 * Fixture mechanics (why this shape): task class `implementation` pins
 * `qualityFloor: 75` with `maxTier: small`, so the ceiling is `small` (the
 * bottom of the tier order) while every servable model sits above it. The
 * ONLY path to `selected` runs through the lift. Each test names the mutant
 * it kills, per the repo's pin-the-guard convention (remove / weaken /
 * rescope — a fix whose guard is unenforced survives mutation).
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";
import { selectModel } from "../src/engine/select.js";
import type { ModelTier } from "../src/engine/types.js";

interface LiftModel {
  id: string;
  tier: ModelTier;
  quality: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
}

function ceilingConfig(models: LiftModel[], qualityFloor = 75): RouterConfig {
  return resolveConfig({
    routing: { enabled: true },
    models: models.map((model) => ({
      id: model.id,
      tier: model.tier,
      quality: model.quality,
      costPerMTokIn: model.costPerMTokIn ?? 1,
      costPerMTokOut: model.costPerMTokOut ?? 4,
      contextWindow: 200_000,
      capabilities: ["tools"],
      enabled: true,
    })),
    taskClasses: [{ key: "implementation", qualityFloor, maxTier: "small" }],
  });
}

function decide(config: RouterConfig) {
  return selectModel({ descriptor: { taskClass: "implementation" }, config });
}

describe("TOG-7910: tier-ceiling lift is load-bearing", () => {
  it("serves the lone above-ceiling qualifier through the lift (kills: lift deleted)", () => {
    // desk-small sits AT the ceiling but below the floor, so the qualified
    // pool holds only reasoner-strong — above the ceiling. Without the lift
    // the survivor filter empties the pool and this strands at
    // `no-eligible-model`.
    const decision = decide(ceilingConfig([
      { id: "desk-small", tier: "small", quality: 60 },
      { id: "reasoner-strong", tier: "strong", quality: 80 },
    ]));

    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "reasoner-strong",
      requestedTier: "standard",
      effectiveTier: "strong",
      fallbackUsed: false,
    });
    // The widening is loud, not silent: the trace names both ends of the move.
    expect(decision.trace.join("\n")).toContain(
      "tier ceiling small lifted to strong: nothing below it clears quality floor 75",
    );
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "desk-small", stage: "quality-floor" }),
    );
  });

  it("lifts to the LOWEST qualifying tier, not the highest (kills: lift-to-max weakening)", () => {
    // frontier-scout is deliberately CHEAPER than reasoner-strong: price and
    // tier are independent axes in the model table, so a lift that lands on
    // the highest qualifier would serve frontier-scout on cost. The real lift
    // lands on `strong` and frontier-scout never reaches the pool.
    const decision = decide(ceilingConfig([
      { id: "desk-small", tier: "small", quality: 60 },
      { id: "reasoner-strong", tier: "strong", quality: 80, costPerMTokIn: 10, costPerMTokOut: 40 },
      { id: "frontier-scout", tier: "frontier", quality: 95, costPerMTokIn: 1, costPerMTokOut: 4 },
    ]));

    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "reasoner-strong",
      effectiveTier: "strong",
    });
  });

  it("still rejects models above the LIFTED ceiling (kills: survivor-filter inversion)", () => {
    // Inverting the survivor filter (`<=` → `>=`) keeps everything at or
    // above the lifted ceiling, so frontier-scout would survive without a
    // rejection. The pin: it must die at `tier-ceiling` naming the lifted
    // ceiling, not the original one.
    const decision = decide(ceilingConfig([
      { id: "desk-small", tier: "small", quality: 60 },
      { id: "reasoner-strong", tier: "strong", quality: 80, costPerMTokIn: 10, costPerMTokOut: 40 },
      { id: "frontier-scout", tier: "frontier", quality: 95, costPerMTokIn: 1, costPerMTokOut: 4 },
    ]));

    expect(decision.rejections).toContainEqual({
      modelId: "frontier-scout",
      stage: "tier-ceiling",
      reason: "tier frontier exceeds ceiling strong",
    });
  });

  it("inverting the lift trigger strands the lift-only task (kills: trigger inversion)", () => {
    // With `<=` flipped to `>=` on the `.some()` line, the above-ceiling
    // qualifier counts as "covered", the lift never fires, and the survivor
    // filter against the unlifted ceiling empties the pool. Same verdict as
    // deleting the lift — this is the weaken half of the acceptance pair.
    const decision = decide(ceilingConfig([
      { id: "desk-small", tier: "small", quality: 60 },
      { id: "reasoner-strong", tier: "strong", quality: 80 },
    ]));

    // Guard-the-guard: this fixture only means something while the lift fires
    // on the unmutated code — if THIS ever flips to `no-eligible-model` on
    // main, the lift itself regressed and the mutant claims below are void.
    expect(decision).toMatchObject({ outcome: "selected", modelId: "reasoner-strong" });
    expect(decision.trace.join("\n")).toContain("tier ceiling small lifted to strong");
  });

  it("an empty qualified pool refuses cleanly without touching the lift (kills: guard removal)", () => {
    // Floor 99 qualifies nothing. Dropping the `qualified.length` guard sends
    // the empty pool into `qualified[0]!.model.tier` — a throw instead of a
    // clean `no-eligible-model`. The lift must never fire here.
    const decision = decide(
      ceilingConfig(
        [
          { id: "desk-small", tier: "small", quality: 60 },
          { id: "reasoner-strong", tier: "strong", quality: 80 },
        ],
        99,
      ),
    );

    expect(decision).toMatchObject({
      outcome: "no-eligible-model",
      modelId: null,
      effectiveTier: "small",
    });
    expect(decision.trace.join("\n")).not.toContain("lifted");
  });

  it("a task servable inside its ceiling takes no lift (kills: always-lift rescope)", () => {
    // workhorse-small clears the floor AT the ceiling, so the `.some()` check
    // holds and the lift must stay out. Dropping that check pushes a spurious
    // `lifted` trace line (ceiling "lifted" to itself) — the rescope half of
    // the guard pin.
    const decision = decide(ceilingConfig([{ id: "workhorse-small", tier: "small", quality: 80 }]));

    expect(decision).toMatchObject({
      outcome: "selected",
      modelId: "workhorse-small",
      requestedTier: "standard",
      effectiveTier: "small",
    });
    expect(decision.trace.join("\n")).not.toContain("lifted");
  });
});
