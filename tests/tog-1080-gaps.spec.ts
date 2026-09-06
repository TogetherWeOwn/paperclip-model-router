/**
 * TOG-1080 probe 2 — pin the exact state where each undefended clause is the
 * SOLE cause of the reported value. These are the regression tests PR #38
 * is currently missing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";
import { selectModel } from "../src/engine/select.js";

const raw = JSON.parse(
  readFileSync(new URL("./data/tog1076-deployed-config.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function cfg(over: Record<string, unknown>): RouterConfig {
  return resolveConfig({
    ...raw,
    capacityRouting: { ...(raw.capacityRouting as Record<string, unknown>), ...over },
  });
}

function everyMeteredLaneExhausted(config: RouterConfig): CapacityEvidence[] {
  const evidence: CapacityEvidence[] = [];
  for (const source of config.capacityRouting.sources) {
    for (const modelId of source.modelIds) {
      evidence.push({
        modelId, source: source.id, laneLabel: "record-1",
        health: "exhausted", posture: "unavailable", utilization: 1,
        remainingFraction: 0, resetsAt: "2026-09-05T18:00:00.000Z",
        resetInSeconds: 3600, windows: [], telemetryAvailable: true,
        reason: "quota exhausted",
      });
    }
  }
  return evidence;
}

describe("TOG-1080: the clauses PR #38 leaves undefended", () => {
  /**
   * THE KEY CASE for the author's Q2. In SHADOW mode the new right-hand
   * operand is gated off, so `base.capacity.degraded ||` is the ONLY thing
   * carrying a telemetry outage into the reported value. Drop the `||` and
   * shadow-mode outage reporting silently regresses to degraded=false.
   */
  it("M3: sticky OR is load-bearing in shadow mode during a telemetry outage", () => {
    const shadow = cfg({ mode: "shadow", unknownTelemetry: "fail-open" });
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: shadow,
      signals: { capacityEvidence: [], capacityError: "telemetry fetch failed" },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.telemetry).toBe("unavailable");
    // Right operand is false here (mode !== enforce), so this can only be true
    // via the sticky left operand.
    expect(decision.capacity.degraded).toBe(true);
  });

  /**
   * The author's Q1, stated as a behaviour rather than an argument: in shadow
   * mode an uncovered winner is reported undegraded. This is the deliberate
   * scope limit — pinning it means a later widening is a conscious act.
   */
  it("M2: shadow mode does NOT flag an uncovered winner (deliberate scope limit)", () => {
    const shadow = cfg({ mode: "shadow", unknownTelemetry: "fail-open" });
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: shadow,
      signals: { capacityEvidence: everyMeteredLaneExhausted(shadow) },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.telemetry).toBe("available");
    expect(decision.capacity.degraded).toBe(false);
  });

  /** The author's implicit third guard: capacity routing switched off entirely. */
  it("M1: capacity routing disabled never reports degraded", () => {
    const disabled = cfg({ enabled: false, mode: "enforce", unknownTelemetry: "fail-open" });
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: disabled,
      signals: { capacityEvidence: [] },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.mode).toBe("disabled");
    expect(decision.capacity.usagePosture).toBe("not-evaluated");
    expect(decision.capacity.degraded).toBe(false);
  });
});
