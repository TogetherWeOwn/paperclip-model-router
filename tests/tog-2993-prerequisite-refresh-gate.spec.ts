import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs operator script, shipped in `files` and run by the runbook.
import { checkPrerequisiteRefresh } from "../scripts/tog-2922-prerequisite-refresh-gate.mjs";

/**
 * TOG-2993: the install gate in the v0.4.4 runbook asserted only that the four
 * lane KEYS were present. A lane whose `utilizationFields` stop matching its
 * collector still produces a key -- with `state: "unknown"` -- so the gate
 * waved through a prerequisite that cannot steer.
 *
 * These are the positive controls for the replacement gate: each one is a
 * refresh result that the OLD keys-only assertion accepted, and that the new
 * gate must reject. Without them the gate is unfalsifiable.
 */
const score = { utilization: 0.59, elapsed: 0.5, deviation: 0.09 };

function refreshResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      paceVerdicts: {
        "cliproxy-claude": { laneId: "cliproxy-claude", state: "on", score, reason: "ok" },
        "cliproxy-codex": { laneId: "cliproxy-codex", state: "ahead", score, reason: "ok" },
        "cliproxy-kimi": { laneId: "cliproxy-kimi", state: "unknown", score: null, reason: "no-computable-governing-window" },
        "cliproxy-opencode-go": { laneId: "cliproxy-opencode-go", state: "behind", score, reason: "ok" },
        ...overrides,
      },
    },
  };
}

describe("TOG-2993: the prerequisite refresh gate rejects an unsteerable lane", () => {
  it("accepts the healthy four-lane refresh", () => {
    expect(checkPrerequisiteRefresh(refreshResult())).toEqual({ ok: true, failures: [] });
  });

  // The exact shape the reviewer produced by renaming Claude's
  // `utilizationFields` to nonexistent literals. All four keys still present.
  it("rejects Claude degraded to unknown even though all four keys are present", () => {
    const result = refreshResult({
      "cliproxy-claude": { laneId: "cliproxy-claude", state: "unknown", score: null, reason: "no-computable-governing-window" },
    });
    expect(Object.keys(result.data.paceVerdicts).sort()).toHaveLength(4);
    const { ok, failures } = checkPrerequisiteRefresh(result);
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("cliproxy-claude");
  });

  it.each(["cliproxy-codex", "cliproxy-opencode-go"])("rejects %s degraded to unknown", (laneId) => {
    const { ok, failures } = checkPrerequisiteRefresh(
      refreshResult({ [laneId]: { laneId, state: "unknown", score: null, reason: "no-computable-governing-window" } }),
    );
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain(laneId);
  });

  // A state can survive while the score does not; steering needs the score.
  it("rejects a measurable lane that kept a state but lost its score", () => {
    const { ok, failures } = checkPrerequisiteRefresh(
      refreshResult({ "cliproxy-claude": { laneId: "cliproxy-claude", state: "on", score: null, reason: "ok" } }),
    );
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("score is null");
  });

  it("rejects an absent state rather than reading it as a pass", () => {
    const { ok } = checkPrerequisiteRefresh(
      refreshResult({ "cliproxy-claude": { laneId: "cliproxy-claude", score, reason: "ok" } }),
    );
    expect(ok).toBe(false);
  });

  // The inverse direction: Kimi publishes no utilization/reset pair, so a
  // computable Kimi verdict means the lane document moved under the blocks.
  it("rejects Kimi becoming computable", () => {
    const { ok, failures } = checkPrerequisiteRefresh(
      refreshResult({ "cliproxy-kimi": { laneId: "cliproxy-kimi", state: "behind", score, reason: "ok" } }),
    );
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("re-deriving");
  });

  it("rejects a missing lane and an unexpected extra lane", () => {
    const missing = refreshResult();
    delete (missing.data.paceVerdicts as Record<string, unknown>)["cliproxy-codex"];
    expect(checkPrerequisiteRefresh(missing).ok).toBe(false);
    expect(checkPrerequisiteRefresh(refreshResult({ "cliproxy-newlane": { state: "on", score } })).ok).toBe(false);
  });

  it("rejects a refresh that stored no verdicts at all", () => {
    expect(checkPrerequisiteRefresh({ data: { paceVerdicts: {} } }).ok).toBe(false);
    expect(checkPrerequisiteRefresh({ data: {} }).ok).toBe(false);
    expect(checkPrerequisiteRefresh({}).ok).toBe(false);
  });
});
