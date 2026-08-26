import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { fixtureConfig } from "./helpers.js";

const config = fixtureConfig("company-a");

describe("gate integrity", () => {
  it("a refused pin does not exempt fallback from a budget halt", () => {
    const hostile = structuredClone(config);
    hostile.routing.fallbackModelId = "qwen3-coder";
    const decision = selectModel({
      descriptor: { pinnedModelId: "claude-sonnet-5", requiredContextTokens: 10_000_000 },
      config: hostile,
      signals: { budgetSpentFraction: 0.99 },
    });
    expect(decision.pin).toMatchObject({ modelId: "claude-sonnet-5", honored: false });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.fallbackUsed).toBe(false);
  });

  it("cost never compensates for a missing capability", () => {
    const decision = selectModel({ descriptor: { taskClass: "implementation", requiredCapabilities: ["vision"] }, config });
    expect(decision.rejections).toContainEqual(expect.objectContaining({ modelId: "minimax-m2.5", stage: "capability" }));
    expect(decision.modelId).toBe("claude-sonnet-5");
  });
});
