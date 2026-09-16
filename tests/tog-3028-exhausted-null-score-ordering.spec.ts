import { describe, expect, it } from "vitest";

import { evaluateLanePace, normalizeLaneDocument } from "../packages/lane-capacity/src/pace.js";
import type { CapacityEvidence, LanePaceDefinition, LanePaceVerdict } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

/**
 * TOG-3028: the v0.4.5 install produced a lane shape no test covered --
 * `state: "exhausted"` with `score: null`, because all three `cliproxy-codex`
 * accounts were at weekly 1.0.
 *
 * `pace-ordering.spec.ts:267` exercises an exhausted lane, but it builds the
 * verdict as `{ ...BEHIND, state: "exhausted" }`, which KEEPS a non-null score.
 * So the combination the engine actually emits at pace.ts:280 was never
 * ordered in a test, and the install gate's `score is null` clause fired on it.
 *
 * These assertions pin two separate facts:
 *   1. the engine really does emit `exhausted` + null score + a full
 *      `knownAccountCount` for a genuinely exhausted lane (so the install-gate
 *      relaxation in TOG-3028 keys off something real), and
 *   2. a null score does not poison pace ordering -- `paceDeviation()` returns
 *      NaN and the comparator's `Number.isFinite` guard (select.ts:87) falls
 *      through to the next comparator instead of subtracting NaN.
 */

const NOW = "2026-09-16T21:49:55.000Z";

const LANE: LanePaceDefinition = {
  laneId: "cliproxy-codex",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
  ],
};

function laneDocument(records: unknown[]): unknown {
  return { schemaVersion: 1, observedAt: NOW, staleAfterSeconds: 300, records };
}

function verdictFor(document: unknown, asOf = NOW): LanePaceVerdict {
  return evaluateLanePace({ observation: normalizeLaneDocument({ document, definition: LANE }), asOf });
}

/** All three codex accounts at weekly 1.0, reset 2026-09-19T11:12Z. */
function exhaustedAccount(key: string) {
  return {
    account_key: key,
    health: "healthy",
    weight: 1,
    governing_window: "weekly",
    window_seconds: { five_hour: 18000, weekly: 604800 },
    five_hour_utilization: 1,
    five_hour_resets_at: "2026-09-17T00:00:00Z",
    weekly_utilization: 1,
    weekly_resets_at: "2026-09-19T11:12:00Z",
  };
}

const CODEX_EXHAUSTED = verdictFor(laneDocument([exhaustedAccount("codex-1"), exhaustedAccount("codex-2"), exhaustedAccount("codex-3")]));

const BEHIND = verdictFor(
  laneDocument([
    {
      account_key: "other-1",
      health: "healthy",
      weight: 1,
      governing_window: "weekly",
      window_seconds: { five_hour: 18000, weekly: 604800 },
      five_hour_utilization: 0.2,
      five_hour_resets_at: "2026-09-17T00:00:00Z",
      weekly_utilization: 0.1,
      weekly_resets_at: "2026-09-19T11:12:00Z",
    },
  ]),
);

function baseConfig(paceOrdering: boolean) {
  return resolveConfig({
    routing: { enabled: true, mode: "enforce", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    capacityRouting: { enabled: true, mode: "enforce", paceOrdering, sources: [] },
    models: [
      { id: "codex-model", tier: "medium", quality: 0.8, enabled: true, capabilities: [], contextWindow: 200000, costPerMTokIn: 1, costPerMTokOut: 1 },
      { id: "other-model", tier: "medium", quality: 0.8, enabled: true, capabilities: [], contextWindow: 200000, costPerMTokIn: 2, costPerMTokOut: 2 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 0, maxTier: "medium" }],
  });
}

function healthyEvidence(modelId: string, utilization: number): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: "record-1",
    health: "healthy",
    posture: "available",
    utilization,
    remainingFraction: 1 - utilization,
    resetsAt: null,
    telemetryAvailable: true,
    observedAt: NOW,
  } as CapacityEvidence;
}

describe("TOG-3028: an exhausted lane with a null score", () => {
  it("is what the engine actually emits when every account is at 1.0", () => {
    expect(CODEX_EXHAUSTED.state).toBe("exhausted");
    expect(CODEX_EXHAUSTED.score).toBeNull();
    expect(CODEX_EXHAUSTED.reason).toBe("all-accounts-unserviceable");
    expect(CODEX_EXHAUSTED.serviceable).toBe(false);
    // The discriminator the TOG-3028 adjudicator keys off: every account's
    // `utilizationFields` parsed, so the pace block still matches its
    // collector document. A drifted block would leave this short of 3.
    expect(CODEX_EXHAUSTED.knownAccountCount).toBe(3);
    expect(CODEX_EXHAUSTED.accounts).toHaveLength(3);
    expect(CODEX_EXHAUSTED.serviceableAccountCount).toBe(0);
  });

  it("is distinguishable from the TOG-2993 drift shape, which is `unknown`", () => {
    // Same records, but the block's utilizationFields no longer resolve.
    const drifted = evaluateLanePace({
      observation: normalizeLaneDocument({
        document: laneDocument([exhaustedAccount("codex-1")]),
        definition: {
          ...LANE,
          windows: [{ name: "weekly", role: "allowance", utilizationFields: ["nope_utilization"], resetFields: ["nope_resets_at"] }],
        },
      }),
      asOf: NOW,
    });
    expect(drifted.state).toBe("unknown");
    expect(drifted.score).toBeNull();
    expect(drifted.knownAccountCount).toBe(0);
  });

  // Control: without paceOrdering the cheaper, less-utilized codex-model wins
  // on both baseline cost and capacity utilization. So the assertion below is
  // measuring pace state, not a coincidence of the other comparators.
  it("control: with paceOrdering off, the exhausted lane's model still wins", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: baseConfig(false),
      signals: {
        capacityEvidence: [healthyEvidence("codex-model", 0.2), healthyEvidence("other-model", 0.9)],
        paceVerdicts: { "cliproxy-codex": CODEX_EXHAUSTED, other: BEHIND },
        modelLaneByPace: { "codex-model": "cliproxy-codex", "other-model": "other" },
      },
    });
    expect(decision.modelId).toBe("codex-model");
  });

  it("does not poison pace ordering: the null-score lane sorts last, no NaN", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: baseConfig(true),
      signals: {
        // codex-model is CHEAPER, so only pace state can demote it.
        capacityEvidence: [healthyEvidence("codex-model", 0.2), healthyEvidence("other-model", 0.9)],
        paceVerdicts: { "cliproxy-codex": CODEX_EXHAUSTED, other: BEHIND },
        modelLaneByPace: { "codex-model": "cliproxy-codex", "other-model": "other" },
      },
    });
    expect(decision.modelId).toBe("other-model");
    const ids = decision.candidates.map((c) => c.modelId);
    expect(ids.indexOf("other-model")).toBeLessThan(ids.indexOf("codex-model"));
    // The exhausted lane still reports its state, and a null deviation stays
    // null rather than surfacing as NaN.
    const codex = decision.candidates.find((c) => c.modelId === "codex-model");
    expect(codex?.paceState).toBe("exhausted");
    expect(codex?.paceDeviation).toBeNull();
  });

  it("still selects the exhausted lane's model when it is the only survivor", () => {
    const config = baseConfig(true);
    config.models = config.models.filter((m) => m.id === "codex-model");
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: {
        capacityEvidence: [healthyEvidence("codex-model", 0.2)],
        paceVerdicts: { "cliproxy-codex": CODEX_EXHAUSTED },
        modelLaneByPace: { "codex-model": "cliproxy-codex" },
      },
    });
    // Pace ordering never changes WHICH models are eligible -- the capacity
    // gate is what would exclude an exhausted lane, and this evidence is
    // `available`, so the model is still served.
    expect(decision.modelId).toBe("codex-model");
  });
});
