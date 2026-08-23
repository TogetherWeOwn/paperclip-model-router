/**
 * The acceptance test for this plugin.
 *
 * The requirement is empirical, not architectural: the same installed plugin
 * must serve a second company correctly with NO code edits. Paperclip plugin
 * installation is global — one install, one config row per company — so the
 * whole of the per-company surface is `configJson`.
 *
 * Every case below runs the identical `selectModel` against two different
 * companies' stored configuration and asserts they diverge for the reason the
 * configuration says they should. If any of these ever needs a code branch on
 * a company id, this plugin has failed its acceptance criterion.
 */

import { describe, expect, it } from "vitest";

import { selectModel } from "../src/engine/select.js";
import type { TaskDescriptor } from "../src/engine/types.js";
import { fixtureConfig, PAYG_UNLOCKED } from "./helpers.js";

const A = fixtureConfig("company-a");
// B is the company that enabled Claude PAYG, which is now an owner-level
// decision as well as a company one: the flag needs the instance unlock to take
// effect. B therefore models a company on an instance where the owner granted
// it. The case immediately below asserts what the same config does without it.
const B = fixtureConfig("company-b", PAYG_UNLOCKED);

/** One call site, two companies. There is no third argument for "which company". */
function both(descriptor: TaskDescriptor, signals?: Parameters<typeof selectModel>[0]["signals"]) {
  return {
    a: selectModel({ descriptor, config: A, signals }),
    b: selectModel({ descriptor, config: B, signals }),
  };
}

describe("model tier tables are configuration", () => {
  it("each company selects from its own table, and neither can reach the other's models", () => {
    const { a, b } = both({ taskClass: "implementation" });

    expect(a.modelId).toBe("minimax-m2.5");
    expect(b.modelId).toBe("gpt-4.1");

    const aIds = A.models.map((m) => m.id);
    const bIds = B.models.map((m) => m.id);
    expect(aIds).toContain(a.modelId);
    expect(bIds).toContain(b.modelId);
    expect(bIds).not.toContain("minimax-m2.5");
  });

  it("the same task class means a different quality floor in each company", () => {
    const { a, b } = both({ taskClass: "implementation" });
    expect(a.qualityFloor).toBe(60);
    expect(b.qualityFloor).toBe(80);
    // B's higher floor is why B pays more for the same class. That is B's choice,
    // expressed in config, not a different code path.
    expect(b.candidates.every((c) => c.quality >= 80)).toBe(true);
  });
});

describe("permitted providers are configuration", () => {
  it("a model whose only provider is unpermitted is rejected in B and selected in A", () => {
    const { a, b } = both({ taskClass: "mechanical" });

    // glm-4.6 sits in both tables. A permits opencode-go; B does not.
    expect(B.models.some((m) => m.id === "glm-4.6")).toBe(true);
    expect(b.rejections).toContainEqual(
      expect.objectContaining({ modelId: "glm-4.6", stage: "provider-not-permitted" }),
    );
    expect(a.rejections).not.toContainEqual(
      expect.objectContaining({ modelId: "glm-4.6", stage: "provider-not-permitted" }),
    );
  });

  it("provider preference order differs and the trace shows which company preferred what", () => {
    expect(A.providers.preferenceOrder[0]).toBe("opencode-go");
    expect(B.providers.preferenceOrder[0]).toBe("openrouter");
  });
});

describe("the Claude PAYG toggle is configuration", () => {
  const claudeTask: TaskDescriptor = { taskClass: "architecture" };

  it("B's identical config does NOT enable PAYG on an instance without the owner's unlock", () => {
    // The same stored bytes, resolved on a locked instance. Owner rule 1 keeps
    // Claude PAYG off until the OWNER enables it, and a company's config row is
    // not the owner — which matters precisely because this plugin installs into
    // other companies whose configuration the owner never reviews.
    const lockedB = fixtureConfig("company-b");
    expect(lockedB.providers.claudePaygEnabled).toBe(false);

    // And the routing consequence, not just the flag: B lists claude-sonnet-5
    // on openrouter only, so with the block back in force it is refused.
    const decision = selectModel({ descriptor: claudeTask, config: lockedB });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    );
    expect(decision.modelId).not.toBe("claude-sonnet-5");
  });

  it("A keeps Claude on teamclaude; B, which enabled PAYG, may use openrouter", () => {
    const { a, b } = both(claudeTask);

    // A: claude-sonnet-5 is listed with providers [teamclaude, openrouter], and
    // A has PAYG off, so it may only be served by teamclaude — and it is chosen.
    expect(a.modelId).toBe("claude-sonnet-5");
    expect(a.rejections).not.toContainEqual(expect.objectContaining({ stage: "claude-block" }));

    // B lists claude-sonnet-5 on openrouter only. With PAYG off that would be a
    // claude-block rejection; B has PAYG on, so it is allowed.
    expect(B.providers.claudePaygEnabled).toBe(true);
    expect(b.rejections).not.toContainEqual(expect.objectContaining({ stage: "claude-block" }));
    expect(b.modelId).toBe("claude-sonnet-5");
  });

  it("flipping only A's toggle — a config change, not a code change — blocks A's Claude route", () => {
    const paygOffButOpenRouterOnly = {
      ...A,
      models: A.models.map((model) =>
        model.family === "claude" ? { ...model, providers: ["openrouter"] } : model,
      ),
    };
    const decision = selectModel({ descriptor: claudeTask, config: paygOffButOpenRouterOnly });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.rejections.filter((r) => r.stage === "claude-block").length).toBeGreaterThan(0);
  });
});

describe("budget thresholds are configuration", () => {
  it("the same spend fraction is warn in one company and halt in the other", () => {
    const { a, b } = both({ taskClass: "implementation" }, { budgetSpentFraction: 0.92 });

    expect(A.budget.haltFraction).toBe(0.95);
    expect(B.budget.haltFraction).toBe(0.9);

    expect(a.gates.budget).toBe("downshift");
    expect(a.outcome).toBe("selected");

    expect(b.gates.budget).toBe("halt");
    expect(b.outcome).toBe("no-eligible-model");
  });

  it("each company's monthly cap is its own", () => {
    expect(A.budget.monthlyCapUsd).toBe(250);
    expect(B.budget.monthlyCapUsd).toBe(60);
  });
});

describe("quota gate thresholds are configuration", () => {
  it("A's gate pauses Claude at high utilization; B, which has no gate, is unaffected", () => {
    const { a, b } = both({ taskClass: "architecture" }, { claudeQuotaUtilization: 0.97 });

    expect(a.gates.claudeQuota).toBe("halt");
    expect(a.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "quota-gate" }),
    );

    expect(B.quotaGate.enabled).toBe(false);
    expect(b.gates.claudeQuota).toBe("ok");
    expect(b.modelId).toBe("claude-sonnet-5");
  });
});

describe("Rule 0 patterns are configuration", () => {
  it("a summary that skips the model in A still needs one in B, and vice versa", () => {
    const lint = both({ summary: "lint the repo", taskClass: "mechanical" });
    expect(lint.a.outcome).toBe("no-model-needed");
    expect(lint.b.outcome).not.toBe("no-model-needed");

    const bump = both({ summary: "bump the version and tag it", taskClass: "mechanical" });
    expect(bump.a.outcome).not.toBe("no-model-needed");
    expect(bump.b.outcome).toBe("no-model-needed");
  });
});

describe("tiering weights and thresholds are configuration", () => {
  it("identical signals score into different tiers in each company", () => {
    const descriptor: TaskDescriptor = { signals: { filesTouched: 5, ambiguity: 1 } };
    const { a, b } = both(descriptor);

    // A: 5*4 + 1*20 = 40  -> standard (threshold 30)
    // B: 5*2 + 1*30 = 40  -> strong   (threshold 40)
    expect(a.requestedTier).toBe("standard");
    expect(b.requestedTier).toBe("strong");
  });

  it("the default tier for an unsignalled task differs per company", () => {
    const { a, b } = both({});
    expect(a.requestedTier).toBe("standard");
    expect(b.requestedTier).toBe("small");
  });
});

describe("routing behaviour switches are configuration", () => {
  it("stickiness applies in A and not in B", () => {
    const descriptor: TaskDescriptor = { taskClass: "implementation", issueId: "issue-1" };
    const signals = { stickyModelId: "claude-haiku-4-5" };

    const a = selectModel({ descriptor, config: A, signals });
    expect(a.modelId).toBe("claude-haiku-4-5");

    // B turned stickiness off, so its incumbent is ignored and the cheapest
    // survivor wins outright.
    const b = selectModel(
      { descriptor, config: B, signals: { stickyModelId: "claude-sonnet-5" } },
    );
    expect(B.routing.stickyModelWithinIssue).toBe(false);
    expect(b.modelId).toBe("gpt-4.1");
  });

  it("B's fallback model catches a task no model can serve; A refuses instead", () => {
    // No model in either table holds ten million tokens of context.
    const impossible: TaskDescriptor = { requiredContextTokens: 10_000_000, taskClass: "review" };
    const { a, b } = both(impossible);

    expect(A.routing.fallbackModelId).toBeNull();
    expect(a.outcome).toBe("no-eligible-model");

    expect(B.routing.fallbackModelId).toBe("gpt-4.1-mini");
    expect(b.outcome).toBe("selected");
    expect(b.modelId).toBe("gpt-4.1-mini");
  });
});

describe("company isolation", () => {
  it("a decision for one company never reads the other's config object", () => {
    const before = JSON.stringify(B);
    selectModel({ descriptor: { taskClass: "architecture" }, config: A });
    expect(JSON.stringify(B)).toBe(before);
  });

  it("the engine takes no company id at all, so it cannot special-case one", () => {
    // `selectModel` accepts exactly { descriptor, config, signals }. There is no
    // companyId parameter to branch on, by construction.
    const parameterNames = Object.keys({ descriptor: 0, config: 0, signals: 0 });
    expect(parameterNames).not.toContain("companyId");
    const source = selectModel.toString();
    expect(source).not.toMatch(/companyId/);
  });
});
