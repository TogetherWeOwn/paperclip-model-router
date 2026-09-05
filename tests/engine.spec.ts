import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import { fixtureConfig } from "./helpers.js";

const A = fixtureConfig("company-a");

describe("protocol-neutral model selection", () => {
  it("applies Rule 0 before selection", () => {
    const decision = selectModel({ descriptor: { summary: "lint the repo", taskClass: "architecture" }, config: A });
    expect(decision.outcome).toBe("no-model-needed");
  });

  it("keeps capability and quality as hard gates before cost", () => {
    const decision = selectModel({ descriptor: { taskClass: "architecture", requiredCapabilities: ["vision"] }, config: A });
    expect(decision.modelId).toBe("claude-sonnet-5");
    expect(decision.candidates.every((candidate) => candidate.quality >= 85)).toBe(true);
  });

  it("selects identically under both upstream protocols", () => {
    const openai = structuredClone(A);
    const anthropic = structuredClone(A);
    openai.upstream.protocol = "openai-chat-completions";
    openai.upstream.baseUrl = "https://one.example";
    anthropic.upstream.protocol = "anthropic-messages";
    anthropic.upstream.baseUrl = "https://two.example";
    const descriptor = { taskClass: "implementation" } as const;
    expect(selectModel({ descriptor, config: openai })).toEqual(selectModel({ descriptor, config: anthropic }));
  });

  it("halts non-pinned work but allows a surviving pin", () => {
    const halted = selectModel({ descriptor: { taskClass: "implementation" }, config: A, signals: { budgetSpentFraction: 0.99 } });
    expect(halted.outcome).toBe("no-eligible-model");
    const pinned = selectModel({ descriptor: { taskClass: "implementation", pinnedModelId: "minimax-m2.5" }, config: A, signals: { budgetSpentFraction: 0.99 } });
    expect(pinned).toMatchObject({ outcome: "selected", modelId: "minimax-m2.5", pin: { honored: true } });
  });

  it("refuses fallback models that fail capability, context, or quality qualification", () => {
    const config = fixtureConfig("company-b");
    const decision = selectModel({ descriptor: { taskClass: "implementation", requiredContextTokens: 500000 }, config });
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, fallbackUsed: false });
  });
});
