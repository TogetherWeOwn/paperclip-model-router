/**
 * Regression suite for the TOG-228 QA review.
 *
 * Every `describe` below is a defect that was reproducible on v0.1.1, plus the
 * property that defect violated. These are written as attacks: each one is the
 * shortest configuration that made the router do the thing it promises never to
 * do. If one of them ever passes again, a gate has come loose.
 *
 * The last block is different — it is the sweep that FAILED to break the tier
 * ceiling, kept because "we tried and could not" is the only useful form of
 * that claim.
 */

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
import { selectModel } from "../src/engine/select.js";
import type { RouterConfig } from "../src/config/types.js";
import { fixtureConfig, readFixture } from "./helpers.js";

const A = fixtureConfig("company-a");

/** company-a, with a surgical change. Everything here is config, never code. */
function companyA(mutate: (raw: Record<string, any>) => void): RouterConfig {
  const raw = readFixture("company-a") as Record<string, any>;
  mutate(raw);
  return resolveConfig(raw);
}

// ---------------------------------------------------------------------------
// Rule 1: a Claude model resolves to teamclaude, or it does not resolve.
// ---------------------------------------------------------------------------

describe("the Claude block cannot be crossed by the fallback", () => {
  it("a fallback naming a Claude model is refused when the Claude block rejected it", () => {
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "claude-opus-5";
      // teamclaude is no longer permitted, so with PAYG off every Claude model
      // in the table is claude-blocked.
      raw.providers.permitted = ["opencode-go", "openrouter"];
      // ...and nothing else can clear this floor, so the fallback is reached.
      raw.taskClasses = [{ key: "architecture", qualityFloor: 99 }];
    });

    const decision = selectModel({ descriptor: { taskClass: "architecture" }, config });

    expect(config.providers.claudePaygEnabled).toBe(false);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5", stage: "claude-block" }),
    );
    // Before the fix this returned `selected claude-opus-5`: the fallback was
    // applied without consulting a single rejection.
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.trace.join("\n")).toContain("may not cross a hard constraint");
  });

  it("a fallback naming a model no gate has seen is refused", () => {
    const config = companyA((raw) => {
      // The id is not in the table at all, so no gate — the Claude block
      // included — ever had the chance to reject it.
      raw.routing.fallbackModelId = "claude-opus-5-via-some-payg-reseller";
      raw.taskClasses = [{ key: "architecture", qualityFloor: 99 }];
    });

    const decision = selectModel({ descriptor: { taskClass: "architecture" }, config });
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("the fallback still overrides the estimates it is there to override", () => {
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "qwen3-coder";
      raw.taskClasses = [{ key: "architecture", qualityFloor: 99 }];
    });
    // qwen3-coder is quality 45 against a floor of 99 and is served by a
    // permitted provider. A quality floor is a judgement about fit; the whole
    // point of a fallback is to accept a worse model rather than no model.
    const decision = selectModel({ descriptor: { taskClass: "architecture" }, config });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("qwen3-coder");
    expect(decision.fallbackUsed).toBe(true);
  });
});

describe("the Claude quota pause cannot be crossed by the fallback", () => {
  it("a paused pool does not become unpaused because a fallback is configured", () => {
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "claude-opus-5";
      // A table of nothing but Claude, so the quota pause empties it.
      raw.models = raw.models.filter((model: any) => model.family === "claude");
    });

    const decision = selectModel({
      descriptor: { taskClass: "architecture" },
      config,
      signals: { claudeQuotaUtilization: 0.99 },
    });

    expect(decision.gates.claudeQuota).toBe("halt");
    // Before the fix: `selected claude-opus-5`, while the pooled quota that
    // model draws on was reported exhausted.
    expect(decision.outcome).toBe("no-eligible-model");
  });
});

// ---------------------------------------------------------------------------
// The budget halt is a halt.
// ---------------------------------------------------------------------------

describe("budget halt outranks every route out of the engine except a pin", () => {
  it("stickiness does not carry an incumbent through a halt", () => {
    // claude-haiku-4-5 clears company-a's implementation floor, so before the
    // fix the sticky branch returned it and the halt check below was never
    // reached. The trace did not even mention the halt.
    const decision = selectModel({
      descriptor: { taskClass: "implementation", issueId: "issue-1" },
      config: A,
      signals: { budgetSpentFraction: 0.99, stickyModelId: "claude-haiku-4-5" },
    });

    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.trace.join("\n")).toContain("refusing non-pinned model work");
  });

  it("a fallback does not carry work through a halt", () => {
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "qwen3-coder";
    });
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config,
      signals: { budgetSpentFraction: 0.99 },
    });

    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("a pin is still the documented exception", () => {
    const decision = selectModel({
      descriptor: {
        taskClass: "implementation",
        pinnedModelId: "claude-haiku-4-5",
        pinReason: "operator override during the incident",
      },
      config: A,
      signals: { budgetSpentFraction: 0.99 },
    });

    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-haiku-4-5");
    expect(decision.pin).toMatchObject({ honored: true });
  });
});

// ---------------------------------------------------------------------------
// Cost never wins against the quality floor — including via a typo.
// ---------------------------------------------------------------------------

describe("an unconfigured task class is refused, not quietly floored at 0", () => {
  it("a one-character typo in the class key does not delete the quality floor", () => {
    const correct = selectModel({ descriptor: { taskClass: "architecture" }, config: A });
    expect(correct.qualityFloor).toBe(85);
    expect(correct.modelId).toBe("claude-sonnet-5");

    // Before the fix this returned `qwen3-coder` — quality 45, the cheapest row
    // in the table — for a decision that was meant to demand 85. Cost beating
    // the quality floor, reached by misspelling a config key.
    const typo = selectModel({ descriptor: { taskClass: "architecure" }, config: A });
    expect(typo.outcome).toBe("no-eligible-model");
    expect(typo.modelId).toBeNull();
    expect(typo.trace.join("\n")).toContain("is not configured for this company");
  });

  it("sending no task class at all is still allowed", () => {
    // The refusal is for naming a class this company does not have. A caller
    // that names none is not making a claim about quality and is unaffected.
    const decision = selectModel({ descriptor: {}, config: A });
    expect(decision.outcome).toBe("selected");
    expect(decision.qualityFloor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// An open gate is not a healthy gate.
// ---------------------------------------------------------------------------

describe("a quota gate that cannot read its input says so", () => {
  it("records in the trace that the gate is open, and why", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: A,
      signals: { claudeQuotaError: "quota status returned HTTP 503" },
    });

    expect(A.quotaGate.enabled).toBe(true);
    // Still fails soft — a teamclaude outage must not take routing down...
    expect(decision.gates.claudeQuota).toBe("ok");
    // ...but "ok" here means unknown, and the trace has to say which.
    const trace = decision.trace.join("\n");
    expect(trace).toContain("the gate is OPEN");
    expect(trace).toContain("HTTP 503");
  });

  it("says nothing when the company has no quota gate", () => {
    const config = companyA((raw) => {
      raw.quotaGate.enabled = false;
    });
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });
    expect(decision.trace.join("\n")).not.toContain("the gate is OPEN");
  });
});

// ---------------------------------------------------------------------------
// A credential cannot be stored in a company's config.
// ---------------------------------------------------------------------------

describe("secret references hold a pointer and never a value", () => {
  const path = "quotaGate.apiKeySecretRef";
  const validRef = { type: "secret_ref", secretId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };

  it("accepts what the Paperclip secret picker submits", () => {
    expect(validateSecretRefShape(null, path)).toBeNull();
    expect(validateSecretRefShape(undefined, path)).toBeNull();
    expect(validateSecretRefShape(validRef, path)).toBeNull();
    expect(validateSecretRefShape({ ...validRef, version: "latest" }, path)).toBeNull();
    expect(validateSecretRefShape({ ...validRef, version: 3 }, path)).toBeNull();
  });

  it("refuses an object that carries a credential instead of a reference", () => {
    // THE case. The host accepted this: `format: "secret-ref"` is registered as
    // `validate: () => true`, and the host's secret-ref extractor ignores any
    // value that is not literally `{ type: "secret_ref" }` — so this was stored
    // in the company's config row verbatim.
    expect(validateSecretRefShape({ apiKey: "sk-live-not-a-reference" }, path)).toContain(
      "not a secret reference",
    );
  });

  it("refuses a credential smuggled alongside a valid reference", () => {
    expect(
      validateSecretRefShape({ ...validRef, value: "sk-live-not-a-reference" }, path),
    ).toContain("unexpected field(s): value");
  });

  it("refuses a pasted string and a non-UUID secret id", () => {
    expect(validateSecretRefShape("sk-live-not-a-reference", path)).toContain("not a string");
    expect(validateSecretRefShape({ type: "secret_ref", secretId: "teamclaude" }, path)).toContain(
      "must be the UUID",
    );
  });
});

// ---------------------------------------------------------------------------
// The property that held. Kept because a negative result is only worth
// anything if you can see how hard it was tried.
// ---------------------------------------------------------------------------

describe("the tier ceiling can never admit a model below the quality floor", () => {
  it("holds across every combination of floor, ceiling, budget, quota and stickiness", () => {
    const floors = [0, 40, 60, 66, 70, 74, 85, 88, 95];
    const ceilings = ["small", "standard", "strong", "frontier"];
    const budgets = [undefined, 0.65, 0.85, 0.99];
    const quotas = [undefined, 0.75, 0.9, 0.99];
    const stickies = [undefined, "qwen3-coder", "claude-haiku-4-5", "claude-opus-5"];

    let selections = 0;
    for (const qualityFloor of floors) {
      for (const maxTier of ceilings) {
        const config = companyA((raw) => {
          raw.taskClasses = [{ key: "swept", qualityFloor, maxTier }];
        });
        for (const budgetSpentFraction of budgets) {
          for (const claudeQuotaUtilization of quotas) {
            for (const stickyModelId of stickies) {
              const decision = selectModel({
                descriptor: { taskClass: "swept", issueId: "issue-1" },
                config,
                signals: { budgetSpentFraction, claudeQuotaUtilization, stickyModelId },
              });
              if (decision.outcome !== "selected") continue;
              selections += 1;
              const model = config.models.find((entry) => entry.id === decision.modelId);
              expect(model, `selected ${decision.modelId}, which is not in the table`).toBeTruthy();
              expect(
                model!.quality,
                `floor=${qualityFloor} ceiling=${maxTier} budget=${budgetSpentFraction} ` +
                  `quota=${claudeQuotaUtilization} sticky=${stickyModelId} -> ` +
                  `${decision.modelId} at quality ${model!.quality}`,
              ).toBeGreaterThanOrEqual(qualityFloor);
            }
          }
        }
      }
    }
    // Guard against the sweep silently degenerating into "nothing was selected,
    // so nothing was below the floor".
    expect(selections).toBeGreaterThan(200);
  });

  it("the ceiling lift only ever raises the ceiling over models that cleared the floor", () => {
    // company-a: implementation floor 60. Nothing at or below `small` clears it,
    // so the ceiling has to lift — and the lift lands on the cheapest tier that
    // does clear it, never on the cheap model that does not.
    const config = companyA((raw) => {
      raw.taskClasses = [{ key: "implementation", qualityFloor: 60, maxTier: "small" }];
    });
    const decision = selectModel({ descriptor: { taskClass: "implementation" }, config });

    expect(decision.trace.join("\n")).toContain("lifted to standard");
    expect(decision.effectiveTier).toBe("standard");
    expect(decision.candidates.every((candidate) => candidate.quality >= 60)).toBe(true);
    // qwen3-coder is the only `small` row and is quality 45; the lift must not
    // have swept it in.
    expect(decision.candidates.map((candidate) => candidate.modelId)).not.toContain("qwen3-coder");
  });
});
