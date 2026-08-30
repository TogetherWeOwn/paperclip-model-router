import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { accrue, emptyLedger, invocationCostUsd, monthKey, spentFraction } from "../src/engine/spend.js";
import { fixtureConfig } from "./helpers.js";

const config = fixtureConfig("company-a");
const AT = new Date("2026-08-30T00:00:00.000Z");

describe("the spend ledger measures what the router actually spent", () => {
  it("prices an invocation from the model table and reported usage", () => {
    const model = config.models.find((entry) => entry.id === "claude-sonnet-5")!;
    // 1M in at $3 + 1M out at $15.
    expect(invocationCostUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18);
  });

  it("counts an unmetered response as zero rather than guessing", () => {
    const model = config.models.find((entry) => entry.id === "claude-sonnet-5")!;
    expect(invocationCostUsd(model, { inputTokens: null, outputTokens: null })).toBe(0);
    expect(invocationCostUsd(undefined, { inputTokens: 100, outputTokens: 100 })).toBe(0);
  });

  it("rolls the total over when the calendar month changes", () => {
    const august = accrue(emptyLedger(monthKey(AT)), 10, AT);
    expect(august).toMatchObject({ month: "2026-08", totalUsd: 10, invocations: 1 });
    const september = accrue(august, 4, new Date("2026-09-01T00:00:00.000Z"));
    expect(september).toMatchObject({ month: "2026-09", totalUsd: 4, invocations: 1 });
  });

  it("reports no fraction when no cap is configured", () => {
    // An unset cap means the operator did not ask for a limit — which must stay
    // distinguishable from a cap of zero, or every install halts on first use.
    expect(spentFraction(emptyLedger("2026-08"), 0, AT)).toBeUndefined();
    expect(spentFraction({ month: "2026-08", totalUsd: 50, invocations: 1 }, 100, AT)).toBe(0.5);
  });
});

describe("the halt gate refuses non-pinned work", () => {
  const descriptor = { taskClass: "implementation" as const };
  // company-a caps at $250 with haltFraction 0.95 — $240 is under, $249 is over.
  const fractionAt = (spentUsd: number) =>
    spentFraction({ month: monthKey(AT), totalUsd: spentUsd, invocations: 1 }, config.budget.monthlyCapUsd, AT);

  it("still selects below the halt threshold", () => {
    const decision = selectModel({
      descriptor,
      config,
      signals: { budgetSpentFraction: fractionAt(100) },
    });
    expect(decision.outcome).toBe("selected");
  });

  it("refuses once measured spend crosses haltFraction", () => {
    const decision = selectModel({
      descriptor,
      config,
      signals: { budgetSpentFraction: fractionAt(249) },
    });
    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("still honours an explicit pin at halt, and says so", () => {
    const decision = selectModel({
      descriptor: { ...descriptor, pinnedModelId: "minimax-m2.5", pinReason: "operator pin" },
      config,
      signals: { budgetSpentFraction: fractionAt(249) },
    });
    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("selected");
    expect(decision.pin).toMatchObject({ modelId: "minimax-m2.5", honored: true });
  });

  it("does not let a fallback model walk through the halt gate", () => {
    const decision = selectModel({
      descriptor: { taskClass: "architecture" },
      config: { ...config, routing: { ...config.routing, fallbackModelId: "qwen3-coder" } },
      signals: { budgetSpentFraction: fractionAt(249) },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.fallbackUsed).toBe(false);
  });
});
