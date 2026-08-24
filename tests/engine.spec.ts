import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { gateLevelFor, matchRule0, scoreTier, selectModel } from "../src/engine/select.js";
import { CLAUDE_COMBO_DEPLOYED, fixtureConfig } from "./helpers.js";

const A = fixtureConfig("company-a", CLAUDE_COMBO_DEPLOYED);

describe("rule 0 — the cheapest call is the one never made", () => {
  it("answers no-model-needed and names the tool when a deterministic pattern matches", () => {
    const decision = selectModel({
      descriptor: { summary: "Re-run the tests on the ci branch", taskClass: "mechanical" },
      config: A,
    });
    expect(decision.outcome).toBe("no-model-needed");
    expect(decision.modelId).toBeNull();
    expect(decision.trace.join(" ")).toContain("the test runner");
  });

  it("runs before every other gate, so it fires even for a task no model could serve", () => {
    const decision = selectModel({
      descriptor: {
        summary: "lint the whole repo",
        taskClass: "architecture",
        requiredCapabilities: ["computer-use"],
        requiredContextTokens: 100_000_000,
      },
      config: A,
    });
    expect(decision.outcome).toBe("no-model-needed");
  });

  it("skips an invalid regular expression rather than taking routing down", () => {
    const broken = resolveConfig({
      rule0: {
        enabled: true,
        deterministicPatterns: [
          { pattern: "([unclosed", tool: "nothing" },
          { pattern: "^compile\\b", tool: "the compiler" },
        ],
      },
    });
    expect(matchRule0("compile the protos", broken)).toEqual({
      pattern: "^compile\\b",
      tool: "the compiler",
    });
  });

  it("is off when the company turns it off", () => {
    const off = resolveConfig({
      rule0: { enabled: false, deterministicPatterns: [{ pattern: "tests", tool: "runner" }] },
    });
    expect(matchRule0("run the tests", off)).toBeNull();
  });
});

describe("hard capability gates run before cost is considered", () => {
  it("rejects a model that cannot hold the required context", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation", requiredContextTokens: 250_000 },
      config: A,
    });
    const contextRejections = decision.rejections.filter((r) => r.stage === "context-window");
    expect(contextRejections.length).toBeGreaterThan(0);
    // Only qwen3-coder has a 262k window in fixture A.
    expect(decision.candidates.every((c) => c.modelId === "qwen3-coder")).toBe(true);
  });

  it("rejects a model missing a required capability", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation", requiredCapabilities: ["vision"] },
      config: A,
    });
    expect(decision.rejections.some((r) => r.stage === "capability" && r.modelId === "glm-4.6")).toBe(
      true,
    );
  });

  it("adds the task class's own required capabilities to the descriptor's", () => {
    const decision = selectModel({ descriptor: { taskClass: "review" }, config: A });
    expect(decision.trace.join(" ")).toContain("structured-output");
  });
});

describe("the Claude block", () => {
  it("refuses a Claude model that would be served by anything but teamclaude", () => {
    const config = resolveConfig({
      providers: {
        permitted: ["openrouter"],
        claudePaygEnabled: false,
        claudeFamilyProvider: "teamclaude",
        claudeFamilies: ["claude"],
      },
      models: [
        {
          id: "claude-sonnet-5",
          family: "claude",
          tier: "strong",
          quality: 88,
          costPerMTokIn: 3,
          costPerMTokOut: 15,
          contextWindow: 200000,
          capabilities: ["tools"],
          providers: ["openrouter"],
        },
      ],
    });
    const decision = selectModel({ descriptor: {}, config });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.rejections).toEqual([
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    ]);
  });

  it("allows a Claude model when teamclaude is permitted", () => {
    const decision = selectModel({
      descriptor: { taskClass: "architecture" },
      config: A,
      signals: {},
    });
    expect(decision.modelId).toBe("claude-sonnet-5");
  });

  it("a pin cannot buy a Claude model past the block", () => {
    const config = resolveConfig({
      providers: { permitted: ["openrouter"], claudePaygEnabled: false },
      models: [
        {
          id: "claude-opus-5",
          family: "claude",
          tier: "frontier",
          quality: 95,
          costPerMTokIn: 15,
          costPerMTokOut: 75,
          contextWindow: 200000,
          providers: ["openrouter"],
        },
      ],
    });
    const decision = selectModel({
      descriptor: { pinnedModelId: "claude-opus-5", pinReason: "operator asked for it" },
      config,
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.pin).toEqual({
      modelId: "claude-opus-5",
      reason: "operator asked for it",
      honored: false,
    });
    expect(decision.trace.join(" ")).toContain("pin refused");
  });

  it("stops applying once the OWNER enables Claude pay-as-you-go", () => {
    // The unlock is the second half of the switch. `claudePaygEnabled` alone is
    // a company's opinion; owner rule 1 keeps PAYG off until the owner enables
    // it, and this plugin installs into companies the owner does not review.
    const config = resolveConfig({
      providers: { permitted: ["openrouter"], claudePaygEnabled: true },
      models: [
        {
          id: "claude-sonnet-5",
          family: "claude",
          tier: "strong",
          quality: 88,
          costPerMTokIn: 3,
          costPerMTokOut: 15,
          contextWindow: 200000,
          providers: ["openrouter"],
        },
      ],
    }, { MODEL_ROUTER_CLAUDE_PAYG_UNLOCK: "1", ...CLAUDE_COMBO_DEPLOYED });
    expect(config.providers.claudePaygEnabled).toBe(true);
    expect(selectModel({ descriptor: {}, config }).modelId).toBe("claude-sonnet-5");
  });

  it("keeps applying when the company asked for PAYG but the instance did not unlock it", () => {
    const raw = {
      providers: { permitted: ["openrouter"], claudePaygEnabled: true },
      models: [
        {
          id: "claude-sonnet-5",
          family: "claude",
          tier: "strong",
          quality: 88,
          costPerMTokIn: 3,
          costPerMTokOut: 15,
          contextWindow: 200000,
          providers: ["openrouter"],
        },
      ],
    };
    const config = resolveConfig(raw, {});
    expect(config.providers.claudePaygEnabled).toBe(false);
    const decision = selectModel({ descriptor: {}, config });
    expect(decision.modelId).toBeNull();
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    );
  });
});

describe("the quality floor is never traded against cost", () => {
  it("drops every model below the floor, however cheap", () => {
    const decision = selectModel({ descriptor: { taskClass: "architecture" }, config: A });
    const below = decision.rejections.filter((r) => r.stage === "quality-floor");
    expect(below.map((r) => r.modelId).sort()).toEqual([
      "claude-haiku-4-5",
      "glm-4.6",
      "minimax-m2.5",
      "qwen3-coder",
    ]);
    expect(decision.qualityFloor).toBe(85);
  });

  it("picks the cheapest survivor, not the best one", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation", estimatedInputTokens: 10_000, estimatedOutputTokens: 2_000 },
      config: A,
    });
    // minimax-m2.5 (q62) beats claude-haiku (q66) and glm-4.6 (q74) on price, and
    // all three clear the floor of 60. Cheapest survivor wins.
    expect(decision.modelId).toBe("minimax-m2.5");
    expect(decision.candidates[0]?.expectedCostUsd).toBeLessThan(
      decision.candidates[1]!.expectedCostUsd,
    );
  });

  it("refuses rather than silently downgrading when nothing clears the floor", () => {
    const config = resolveConfig({
      providers: { permitted: ["openrouter"] },
      taskClasses: [{ key: "architecture", qualityFloor: 99 }],
      models: [
        {
          id: "gpt-4.1",
          family: "gpt",
          tier: "strong",
          quality: 82,
          costPerMTokIn: 2,
          costPerMTokOut: 8,
          contextWindow: 128000,
          providers: ["openrouter"],
        },
      ],
    });
    const decision = selectModel({ descriptor: { taskClass: "architecture" }, config });
    expect(decision.outcome).toBe("no-eligible-model");
  });
});

describe("provider permission", () => {
  it("fails closed when a company has permitted no providers at all", () => {
    const config = resolveConfig({
      models: [
        {
          id: "gpt-4.1",
          family: "gpt",
          tier: "strong",
          quality: 82,
          costPerMTokIn: 2,
          costPerMTokOut: 8,
          contextWindow: 128000,
          providers: ["openrouter"],
        },
      ],
    });
    const decision = selectModel({ descriptor: {}, config });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.rejections[0]?.stage).toBe("provider-not-permitted");
  });

  it("breaks a price tie on the company's provider preference order", () => {
    const config = resolveConfig({
      providers: { permitted: ["opencode-go", "openrouter"], preferenceOrder: ["opencode-go"] },
      models: [
        {
          id: "same-price-openrouter",
          family: "x",
          tier: "small",
          quality: 50,
          costPerMTokIn: 1,
          costPerMTokOut: 1,
          contextWindow: 100000,
          providers: ["openrouter"],
        },
        {
          id: "same-price-go",
          family: "x",
          tier: "small",
          quality: 50,
          costPerMTokIn: 1,
          costPerMTokOut: 1,
          contextWindow: 100000,
          providers: ["opencode-go"],
        },
      ],
    });
    expect(selectModel({ descriptor: {}, config }).modelId).toBe("same-price-go");
  });
});

describe("tiering", () => {
  it("uses the configured default tier when a task carries no signals", () => {
    expect(scoreTier({}, A)).toEqual({ tier: "standard", score: null });
  });

  it("scores signals with the company's own weights", () => {
    const scored = scoreTier({ signals: { ambiguity: 3, blastRadius: 2 } }, A);
    expect(scored.score).toBe(3 * 20 + 2 * 15);
    expect(scored.tier).toBe("frontier");
  });

  it("honours a task class tier ceiling", () => {
    const decision = selectModel({
      descriptor: { taskClass: "mechanical", signals: { ambiguity: 5 } },
      config: A,
    });
    expect(decision.effectiveTier).toBe("small");
    expect(decision.modelId).toBe("qwen3-coder");
  });
});

describe("budget and quota pressure lower the ceiling, never the floor", () => {
  it("maps a fraction to a gate level", () => {
    const thresholds = { warn: 0.6, downshift: 0.8, halt: 0.95 };
    expect(gateLevelFor(undefined, thresholds)).toBe("ok");
    expect(gateLevelFor(0.1, thresholds)).toBe("ok");
    expect(gateLevelFor(0.6, thresholds)).toBe("warn");
    expect(gateLevelFor(0.81, thresholds)).toBe("downshift");
    expect(gateLevelFor(1, thresholds)).toBe("halt");
  });

  it("drops the tier ceiling one step under budget pressure", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation", signals: { ambiguity: 5 } },
      config: A,
      signals: { budgetSpentFraction: 0.85 },
    });
    expect(decision.requestedTier).toBe("frontier");
    expect(decision.effectiveTier).toBe("strong");
    expect(decision.gates.budget).toBe("downshift");
  });

  it("refuses non-pinned work once the budget halt threshold is crossed", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: A,
      signals: { budgetSpentFraction: 0.99 },
    });
    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("pauses Claude — and only Claude — when pooled quota is exhausted", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: A,
      signals: { claudeQuotaUtilization: 0.97 },
    });
    expect(decision.gates.claudeQuota).toBe("halt");
    const paused = decision.rejections.filter((r) => r.stage === "quota-gate").map((r) => r.modelId);
    expect(paused).toContain("claude-haiku-4-5");
    expect(paused).toContain("claude-sonnet-5");
    // Non-Claude work is untouched.
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("minimax-m2.5");
  });

  it("treats utilization as a fraction, not a percentage", () => {
    // 0.9 is 90% consumed and must trip the gate; 90 would be nonsense input but
    // must not be read as 90%.
    const under = selectModel({
      descriptor: { taskClass: "architecture" },
      config: A,
      signals: { claudeQuotaUtilization: 0.9 },
    });
    expect(under.gates.claudeQuota).toBe("downshift");
    const clear = selectModel({
      descriptor: { taskClass: "architecture" },
      config: A,
      signals: { claudeQuotaUtilization: 0.5 },
    });
    expect(clear.gates.claudeQuota).toBe("ok");
  });

  it("leaves the quota gate off when the company has not configured it", () => {
    const B = fixtureConfig("company-b", CLAUDE_COMBO_DEPLOYED);
    const decision = selectModel({
      descriptor: {},
      config: B,
      signals: { claudeQuotaUtilization: 0.99 },
    });
    expect(decision.gates.claudeQuota).toBe("ok");
  });
});

describe("pins and overrides are logged with their reasoning", () => {
  it("honours a task pin that survives the gates and records why", () => {
    const decision = selectModel({
      descriptor: {
        taskClass: "implementation",
        pinnedModelId: "glm-4.6",
        pinReason: "TOG-152 bake-off winner for this class",
      },
      config: A,
    });
    expect(decision.modelId).toBe("glm-4.6");
    expect(decision.pin?.honored).toBe(true);
    expect(decision.trace.join(" ")).toContain("TOG-152 bake-off winner");
  });

  it("honours a task-class pin from config", () => {
    const config = resolveConfig({
      providers: { permitted: ["openrouter"] },
      taskClasses: [{ key: "docs", qualityFloor: 10, pinnedModelId: "gpt-4.1-mini" }],
      models: [
        {
          id: "gpt-4.1-mini",
          family: "gpt",
          tier: "small",
          quality: 52,
          costPerMTokIn: 0.4,
          costPerMTokOut: 1.6,
          contextWindow: 128000,
          providers: ["openrouter"],
        },
        {
          id: "cheaper",
          family: "gpt",
          tier: "small",
          quality: 40,
          costPerMTokIn: 0.01,
          costPerMTokOut: 0.01,
          contextWindow: 128000,
          providers: ["openrouter"],
        },
      ],
    });
    const decision = selectModel({ descriptor: { taskClass: "docs" }, config });
    expect(decision.modelId).toBe("gpt-4.1-mini");
    expect(decision.pin?.reason).toContain("docs");
  });
});

describe("cache-preserving stickiness", () => {
  it("keeps the incumbent model on an issue when it still survives the gates", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation", issueId: "issue-1" },
      config: A,
      signals: { stickyModelId: "claude-haiku-4-5" },
    });
    expect(decision.modelId).toBe("claude-haiku-4-5");
    expect(decision.trace.join(" ")).toContain("destroy the prompt cache");
  });

  it("switches, and says so, when the incumbent no longer survives", () => {
    const decision = selectModel({
      descriptor: { taskClass: "architecture", issueId: "issue-1" },
      config: A,
      signals: { stickyModelId: "qwen3-coder" },
    });
    expect(decision.modelId).toBe("claude-sonnet-5");
    expect(decision.trace.join(" ")).toContain("no longer survives");
  });

  it("does not apply when the company turns stickiness off", () => {
    const B = fixtureConfig("company-b", CLAUDE_COMBO_DEPLOYED);
    expect(B.routing.stickyModelWithinIssue).toBe(false);
  });
});

describe("the master switch", () => {
  it("returns `disabled` and changes nothing", () => {
    const config = resolveConfig({ routing: { enabled: false } });
    const decision = selectModel({ descriptor: { summary: "anything" }, config });
    expect(decision.outcome).toBe("disabled");
    expect(decision.modelId).toBeNull();
  });
});

describe("fallback", () => {
  /** Two models on one permitted provider; the cheap one is the fallback. */
  const table = [
    {
      id: "gpt-4.1-mini",
      family: "gpt",
      tier: "small",
      quality: 52,
      costPerMTokIn: 0.4,
      costPerMTokOut: 1.6,
      contextWindow: 128000,
      capabilities: ["tools"],
      providers: ["openrouter"],
    },
    {
      id: "gpt-4.1",
      family: "gpt",
      tier: "strong",
      quality: 82,
      costPerMTokIn: 2,
      costPerMTokOut: 8,
      contextWindow: 128000,
      capabilities: ["tools"],
      providers: ["openrouter"],
    },
  ];

  it("uses the configured fallback when nothing survives the negotiable gates", () => {
    const config = resolveConfig({
      routing: { enabled: true, fallbackModelId: "gpt-4.1-mini" },
      providers: { permitted: ["openrouter"] },
      models: table,
      taskClasses: [{ key: "impossible", qualityFloor: 99 }],
    });
    // Nothing clears a floor of 99, and the fallback does not either — but the
    // floor is an estimate of fit, which is exactly what the fallback exists to
    // override. It is still served by a permitted provider.
    const decision = selectModel({ descriptor: { taskClass: "impossible" }, config });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("gpt-4.1-mini");
    expect(decision.fallbackUsed).toBe(true);
  });

  it("flags the fallback so `selected` is not mistaken for `this model can do the job`", () => {
    const config = resolveConfig({
      routing: { enabled: true, fallbackModelId: "gpt-4.1-mini" },
      providers: { permitted: ["openrouter"] },
      models: table,
    });
    // No model holds ten million tokens. The fallback does not either.
    const decision = selectModel({ descriptor: { requiredContextTokens: 10_000_000 }, config });
    expect(decision.modelId).toBe("gpt-4.1-mini");
    expect(decision.fallbackUsed).toBe(true);

    // ...whereas an ordinary win is not flagged.
    const ordinary = selectModel({ descriptor: {}, config });
    expect(ordinary.modelId).toBe("gpt-4.1-mini");
    expect(ordinary.fallbackUsed).toBe(false);
  });

  it("refuses a fallback that is not in the company's model table", () => {
    const config = resolveConfig({
      routing: { enabled: true, fallbackModelId: "some-model-nobody-vetted" },
      providers: { permitted: [] },
      models: table,
    });
    const decision = selectModel({ descriptor: {}, config });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.trace.join("\n")).toContain("not in this company's model table");
  });
});
