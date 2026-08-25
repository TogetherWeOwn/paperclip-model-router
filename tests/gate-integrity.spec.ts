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

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { validateSecretRefShape } from "../src/config/secret-ref.js";
import { selectModel } from "../src/engine/select.js";
import type { RouterConfig } from "../src/config/types.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { CLAUDE_COMBO_ARMED_ENV } from "../src/constants.js";
import { CLAUDE_COMBO_DEPLOYED, fixtureConfig, readFixture } from "./helpers.js";

const A = fixtureConfig("company-a", CLAUDE_COMBO_DEPLOYED);

/** The plugin definition, for the validator half of these attacks. */
async function validator() {
  const harness = createTestHarness({ manifest, config: readFixture("company-a") });
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return definition;
}

/** company-a, with a surgical change. Everything here is config, never code. */
function companyA(
  mutate: (raw: Record<string, any>) => void,
  env: Record<string, string | undefined> = CLAUDE_COMBO_DEPLOYED,
): RouterConfig {
  const raw = readFixture("company-a") as Record<string, any>;
  mutate(raw);
  return resolveConfig(raw, env);
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

// ---------------------------------------------------------------------------
// TOG-248: a gate that never ran left no rejection, and the fallback read the
// missing rejection as clearance.
//
// The block above proves the fallback cannot cross a `claude-block` REJECTION.
// That was the wrong invariant to test, because it tests the record rather than
// the rule. The candidate loop rejects on capability and context window BEFORE
// it reaches the Claude block and `continue`s, so a caller who makes the
// fallback fail one of those deletes the evidence and the fallback sails.
//
// Every attack here is one descriptor field. None of them touches the config's
// Claude settings at all.
// ---------------------------------------------------------------------------

describe("the fallback is judged by the gates, not by their footprints", () => {
  /** company-a with a Claude fallback and teamclaude NOT permitted. */
  const claudeFallbackConfig = () =>
    companyA((raw) => {
      raw.routing.fallbackModelId = "claude-opus-5";
      raw.providers.permitted = ["opencode-go", "openrouter"];
    });

  it("a context window nothing can satisfy does not hand the fallback a Claude model", () => {
    const config = claudeFallbackConfig();
    // Every model in the table fails this, claude-opus-5 first — at
    // `context-window`, which is upstream of the Claude block. On v0.2.5 this
    // returned `selected claude-opus-5`, `fallbackUsed: true`, on a company
    // where teamclaude was not even a permitted provider.
    const decision = selectModel({
      descriptor: { summary: "read the whole monorepo", requiredContextTokens: 10_000_000 },
      config,
    });

    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.trace.join("\n")).toContain("may not cross a hard constraint");
    // The refusal has to survive in the decision log, not just the trace.
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5", stage: "claude-block" }),
    );
  });

  it("a capability the fallback lacks does not either", () => {
    // The capability gate is upstream of the Claude block in exactly the same
    // way, and it does not need an impossible number to trigger — only a
    // fallback that is missing one of the requested capabilities.
    // `claude-haiku-4-5` has neither `computer-use` nor `long-context`, so it is
    // rejected at `capability` and the Claude block never sees it.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "claude-haiku-4-5";
      raw.providers.permitted = ["opencode-go", "openrouter"];
    });

    const decision = selectModel({
      descriptor: {
        summary: "drive the browser over a large repo",
        requiredCapabilities: ["computer-use", "long-context"],
      },
      config,
    });

    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-haiku-4-5", stage: "capability" }),
    );
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.fallbackUsed).toBe(false);
  });

  it("the same descriptor does not carry a prefixed Claude id past the routing-prefix rule", () => {
    // TOG-149's defence is inside the Claude block, so skipping the block skips
    // it too: `oc/claude-opus-5` is opencode serving Claude.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "oc/claude-opus-5";
      raw.models.push({
        id: "oc/claude-opus-5",
        family: "claude",
        tier: "frontier",
        quality: 95,
        costPerMTokIn: 15,
        costPerMTokOut: 75,
        contextWindow: 200000,
        capabilities: ["tools", "structured-output"],
        providers: ["opencode-go"],
        enabled: true,
      });
    });

    const decision = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("nor past an instance that has not armed the teamclaude combos", () => {
    // The undeployed case, which is the real state of the instance: no env.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "claude-opus-5";
    }, {});

    const decision = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("nor through a PAUSED pooled quota", () => {
    // TOG-228's quota property, reached the same way: the pause lives below the
    // context-window gate, so the fallback never met it.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "claude-opus-5";
    });

    const decision = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
      signals: { claudeQuotaUtilization: 0.99 },
    });
    expect(decision.gates.claudeQuota).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("nor past the permitted-provider list, for any family", () => {
    // Not a Claude finding — the same hole crossed `provider-not-permitted`,
    // which is rule 1's companion constraint and equally non-negotiable.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "glm-4.6"; // served only by opencode-go
      raw.providers.permitted = ["openrouter"];
    });

    const decision = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("a disabled fallback stays disabled even when no gate got to say so", () => {
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "qwen3-coder";
      raw.models.find((model: any) => model.id === "qwen3-coder").enabled = false;
    });

    const decision = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
    });
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("and the estimates a fallback IS meant to cross still let it through", () => {
    // The other direction, which is the whole reason the fallback exists: a
    // capability the caller only thinks it needs is a judgement, not a rule.
    const config = companyA((raw) => {
      raw.routing.fallbackModelId = "qwen3-coder";
      raw.providers.permitted = ["opencode-go", "openrouter"];
    });

    // qwen3-coder has no `computer-use`, so it is rejected at `capability` —
    // the very stage this fix stops treating as clearance. It is still served,
    // because a capability estimate is a judgement about fit and every HARD
    // gate says yes: it is in the table, enabled, not Claude, and openrouter is
    // permitted. Closing the hole must not close the door.
    const decision = selectModel({
      descriptor: { requiredCapabilities: ["computer-use"] },
      config,
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("qwen3-coder");
    expect(decision.fallbackUsed).toBe(true);
  });

  it("the pin and stickiness were never exposed to this — proof, not assumption", () => {
    // Both are judged against `qualified`, which a model rejected upstream never
    // enters. Written down because "we checked and it held" is the only useful
    // form of that claim, and because it is what makes this a fallback-only fix.
    const config = companyA((raw) => {
      raw.providers.permitted = ["opencode-go", "openrouter"];
    });

    const pinned = selectModel({
      descriptor: { requiredContextTokens: 10_000_000, pinnedModelId: "claude-opus-5" },
      config,
    });
    expect(pinned.outcome).toBe("no-eligible-model");
    expect(pinned.pin).toEqual(expect.objectContaining({ honored: false }));

    const sticky = selectModel({
      descriptor: { requiredContextTokens: 10_000_000 },
      config,
      signals: { stickyModelId: "claude-opus-5" },
    });
    expect(sticky.outcome).toBe("no-eligible-model");
    expect(sticky.modelId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TOG-237: the Claude block cannot be switched off by mislabelling the family.
//
// Everything above this block attacks the ENGINE. This one attacks the CONFIG,
// one layer earlier — it never asks the Claude block a question it could fail,
// it arranges for the block never to be asked at all.
// ---------------------------------------------------------------------------

describe("the Claude block cannot be crossed by a mislabelled family", () => {
  /** The attack config, exactly as an operator would POST it. */
  function mislabelled(family: string) {
    const raw = readFixture("company-a") as Record<string, any>;
    // The only provider this company may use is OpenRouter — teamclaude is not
    // permitted, so a correctly-labelled Claude model here is claude-blocked.
    raw.providers.permitted = ["openrouter"];
    raw.providers.preferenceOrder = ["openrouter"];
    raw.providers.claudePaygEnabled = false;
    // One row: a Claude model filed under a family the Claude block does not
    // govern, reachable only via OpenRouter.
    raw.models = [
      {
        id: "claude-opus-5",
        family,
        tier: "frontier",
        quality: 95,
        costPerMTokIn: 15,
        costPerMTokOut: 75,
        contextWindow: 200_000,
        capabilities: ["tools"],
        providers: ["openrouter"],
        enabled: true,
      },
    ];
    raw.taskClasses = [];
    return raw;
  }

  it("a Claude model filed under family `gpt` is not served by OpenRouter", () => {
    const raw = mislabelled("gpt");
    // Armed, so the ONLY thing that can block this row is the id-classification
    // fix TOG-237 landed. Unarmed it would block for the TOG-294 reason too, and
    // this regression test would pass even if TOG-237 came loose.
    const config = resolveConfig(raw, CLAUDE_COMBO_DEPLOYED);

    // The config really does exempt it: `gpt` is not in `claudeFamilies`, and
    // the model's only provider is not `claudeFamilyProvider`.
    expect(config.providers.claudePaygEnabled).toBe(false);
    expect(config.providers.claudeFamilies).not.toContain("gpt");
    expect(config.models[0]!.providers).toEqual(["openrouter"]);

    const decision = selectModel({ descriptor: {}, config });

    // On v0.2.1 this returned `selected claude-opus-5` with `rejections: []`
    // and not one trace line about the Claude block. The gate did not fail —
    // it was never asked, because membership was read off a field the config
    // supplies. It is now read off the model id.
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5", stage: "claude-block" }),
    );
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("says so in the trace instead of failing silently", () => {
    const decision = selectModel({
      descriptor: {},
      config: resolveConfig(mislabelled("gpt"), CLAUDE_COMBO_DEPLOYED),
    });
    const trace = decision.trace.join("\n");
    expect(trace).toContain("config mislabels 1 model(s) as non-Claude");
    expect(trace).toContain('claude-opus-5 declares family "gpt"');
    // ...and the rejection names the reason it was caught, not just the block.
    const rejection = decision.rejections.find((entry) => entry.stage === "claude-block");
    expect(rejection?.reason).toContain("classified by id");
  });

  it("holds for every shape of mislabel, including the ones a typo produces", () => {
    // A family that is empty, absent, capitalised differently from anything in
    // `claudeFamilies`, or simply another vendor's name. None of them is a way
    // out of the block.
    for (const family of ["gpt", "GPT", "unknown", "", "qwen", "anthropic", "Claude-3", "claude "]) {
      const raw = mislabelled(family);
      if (family === "") delete raw.models[0].family;
      const config = resolveConfig(raw, CLAUDE_COMBO_DEPLOYED);
      const decision = selectModel({ descriptor: {}, config });
      expect(decision.outcome, `family=${JSON.stringify(family)} was served`).toBe(
        "no-eligible-model",
      );
    }
  });

  it("is not crossable by the fallback, the pin, or stickiness either", () => {
    // The three routes TOG-228 closed for a correctly-labelled Claude model.
    // They stay closed for a mislabelled one, because all three are judged
    // against the same `claude-block` rejection.
    const withFallback = resolveConfig(
      {
        ...mislabelled("gpt"),
        routing: { enabled: true, fallbackModelId: "claude-opus-5", stickyModelWithinIssue: true },
      },
      CLAUDE_COMBO_DEPLOYED,
    );
    expect(selectModel({ descriptor: {}, config: withFallback }).outcome).toBe("no-eligible-model");

    const config = resolveConfig(mislabelled("gpt"), CLAUDE_COMBO_DEPLOYED);
    const pinned = selectModel({
      descriptor: { pinnedModelId: "claude-opus-5", pinReason: "operator override" },
      config,
    });
    expect(pinned.outcome).toBe("no-eligible-model");
    expect(pinned.pin).toMatchObject({ honored: false });

    const sticky = selectModel({
      descriptor: { issueId: "issue-1" },
      config,
      signals: { stickyModelId: "claude-opus-5" },
    });
    expect(sticky.outcome).toBe("no-eligible-model");
  });

  it("still lets the mislabelled model through to teamclaude, which is the point", () => {
    // The block confines Claude to one provider; it does not ban Claude. A
    // mislabel must not turn into an outage for the permitted route.
    const raw = mislabelled("gpt");
    raw.providers.permitted = ["openrouter", "teamclaude"];
    raw.models[0].providers = ["teamclaude", "openrouter"];
    const decision = selectModel({
      descriptor: {},
      config: resolveConfig(raw, CLAUDE_COMBO_DEPLOYED),
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-opus-5");
    // ...and the operator is still told the table contradicts itself.
    expect(decision.trace.join("\n")).toContain("config mislabels");
  });

  it("the pooled quota pause reaches a mislabelled Claude model too", () => {
    // It draws on the same teamclaude pool whatever the config calls it, so a
    // mislabel must not exempt it from the quota gate either.
    const raw = mislabelled("gpt");
    raw.providers.permitted = ["openrouter", "teamclaude"];
    raw.models[0].providers = ["teamclaude"];
    const decision = selectModel({
      descriptor: {},
      config: resolveConfig(raw, CLAUDE_COMBO_DEPLOYED),
      signals: { claudeQuotaUtilization: 0.99 },
    });
    expect(decision.gates.claudeQuota).toBe("halt");
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5", stage: "quota-gate" }),
    );
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("configuration can still WIDEN the Claude block, only never narrow it", () => {
    // The id check is a floor, not a replacement. A company that files a
    // non-Anthropic model under a Claude family still gets it confined.
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.permitted = ["openrouter"];
    raw.providers.claudeFamilies = ["claude", "house-brand"];
    raw.models = [
      {
        id: "qwen3-coder",
        family: "house-brand",
        tier: "small",
        quality: 45,
        costPerMTokIn: 0.3,
        costPerMTokOut: 1.2,
        contextWindow: 128_000,
        capabilities: [],
        providers: ["openrouter"],
        enabled: true,
      },
    ];
    raw.taskClasses = [];
    const decision = selectModel({
      descriptor: {},
      config: resolveConfig(raw, CLAUDE_COMBO_DEPLOYED),
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "qwen3-coder", stage: "claude-block" }),
    );
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("onValidateConfig refuses the attack config outright", async () => {
    const plugin = await validator();
    const result = await plugin.onValidateConfig!(mislabelled("gpt"));

    // v0.2.1 reported `ok: true` on exactly this config.
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("claude-opus-5");
    expect(result.errors?.join(" ")).toContain("providers.claudeFamilies");
  });

  it("onValidateConfig warns, but does not refuse, the harmless inversion", async () => {
    const plugin = await validator();
    const raw = readFixture("company-a") as Record<string, any>;
    raw.models = [{ ...raw.models[0], family: "claude" }]; // qwen3-coder, filed as claude
    const result = await plugin.onValidateConfig!(raw);

    // This only ever widens the block, so it cannot leak — but it silently
    // confines a non-Anthropic model and looks like an outage.
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ")).toContain("qwen3-coder");
    expect(result.warnings?.join(" ")).toContain("does not name Claude or Anthropic");
  });

  it("onValidateConfig still accepts the shipped fixtures", async () => {
    const plugin = await validator();

    // company-a is accepted anywhere. company-b enables Claude PAYG, which is
    // now an owner-level decision, so it is only a valid config on an instance
    // where the owner unlocked it — the refusal below is the feature, not a
    // regression in the fixture.
    const a = await plugin.onValidateConfig!(readFixture("company-a"));
    expect(a.ok, `company-a: ${a.errors?.join("; ")}`).toBe(true);

    const bLocked = await plugin.onValidateConfig!(readFixture("company-b"));
    expect(bLocked.ok).toBe(false);
    expect(bLocked.errors?.join(" ")).toContain("not unlocked on this instance");

    vi.stubEnv("MODEL_ROUTER_CLAUDE_PAYG_UNLOCK", "1");
    try {
      const bUnlocked = await plugin.onValidateConfig!(readFixture("company-b"));
      expect(bUnlocked.ok, `company-b: ${bUnlocked.errors?.join("; ")}`).toBe(true);
      expect(bUnlocked.warnings?.join(" ")).toContain("pay-as-you-go is ENABLED");
    } finally {
      vi.unstubAllEnvs();
    }
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

// ---------------------------------------------------------------------------
// TOG-237 follow-up: the Claude block's DESTINATION and its ON-SWITCH were both
// company configuration. TOG-237 moved "which models are Claude" into code and
// left the two questions either side of it in the config row. Both reproduced
// on v0.2.2 — `selected`, no rejection, no trace line.
// ---------------------------------------------------------------------------

describe("the Claude block's destination is code, not configuration", () => {
  /** A Claude model teamclaude cannot serve. OpenRouter PAYG is its only route. */
  const paygOnlyClaude = {
    id: "claude-opus-5-payg",
    family: "claude",
    tier: "standard",
    quality: 95,
    // Priced below every other row so that if it is ever eligible, it wins:
    // the assertion cannot pass by accident of the cost ordering.
    costPerMTokIn: 0.001,
    costPerMTokOut: 0.001,
    contextWindow: 200000,
    capabilities: ["tools", "structured-output"],
    providers: ["openrouter"],
    enabled: true,
  };

  function withPaygOnlyClaude(mutate: (raw: Record<string, any>) => void = () => {}) {
    return companyA((raw) => {
      raw.models.push({ ...paygOnlyClaude });
      mutate(raw);
    });
  }

  it("baseline: teamclaude cannot serve it, so it is blocked", () => {
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: withPaygOnlyClaude(),
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5-payg", stage: "claude-block" }),
    );
    expect(decision.modelId).not.toBe("claude-opus-5-payg");
  });

  it("pointing claudeFamilyProvider at openrouter does not aim the block — it fails closed", () => {
    // The attack. On v0.2.2 this returned `selected: claude-opus-5-payg` with an
    // empty rejection list: the config named the provider the block permitted,
    // so redirecting the field redirected owner rule 1.
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: withPaygOnlyClaude((raw) => {
        raw.providers.claudeFamilyProvider = "openrouter";
        raw.providers.permitted = ["openrouter", "opencode-go", "teamclaude"];
      }),
    });

    expect(decision.modelId).not.toBe("claude-opus-5-payg");
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-opus-5-payg", stage: "claude-block" }),
    );
    // Narrowing, not widening: the legitimately-teamclaude Claude rows are
    // refused too, because the config no longer names an allowed provider.
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    );
  });

  it("the rejection names the real rule, not the config value that was overruled", () => {
    // v0.2.2 interpolated `claudeFamilyProvider` unconditionally, so a config
    // that had aimed the block at OpenRouter printed "may only be served by
    // openrouter" — the trace repeating the misconfiguration back as the rule.
    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: withPaygOnlyClaude((raw) => {
        raw.providers.claudeFamilyProvider = "openrouter";
      }),
    });
    const reason = decision.rejections.find((r) => r.modelId === "claude-opus-5-payg")?.reason ?? "";

    expect(reason).toContain("teamclaude");
    expect(reason).toContain("not an allowed Claude provider");
    expect(reason).not.toMatch(/may only be served by openrouter/);
  });

  it("a casing or whitespace variant of a disallowed provider does not slip through", () => {
    for (const variant of ["OpenRouter", " openrouter ", "OPENROUTER"]) {
      const decision = selectModel({
        descriptor: { taskClass: "implementation" },
        config: withPaygOnlyClaude((raw) => {
          raw.providers.claudeFamilyProvider = variant;
        }),
      });
      expect(decision.modelId, `variant ${JSON.stringify(variant)}`).not.toBe("claude-opus-5-payg");
    }
  });

  it("a casing variant of an ALLOWED provider still works — this narrows, it does not break", () => {
    const decision = selectModel({
      descriptor: { taskClass: "architecture" },
      config: companyA((raw) => {
        raw.providers.claudeFamilyProvider = "TeamClaude";
      }),
    });
    expect(decision.rejections).not.toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    );
  });
});

describe("Claude PAYG is an owner switch, not a company one", () => {
  it("a company config setting claudePaygEnabled true is ignored without the instance unlock", () => {
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.claudePaygEnabled = true;

    expect(resolveConfig(raw, {}).providers.claudePaygEnabled).toBe(false);
    expect(
      resolveConfig(raw, { MODEL_ROUTER_CLAUDE_PAYG_UNLOCK: "1" }).providers.claudePaygEnabled,
    ).toBe(true);
  });

  it("only an exact '1' unlocks it", () => {
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.claudePaygEnabled = true;
    for (const value of ["0", "", "true", "yes", "2", undefined]) {
      expect(
        resolveConfig(raw, { MODEL_ROUTER_CLAUDE_PAYG_UNLOCK: value }).providers.claudePaygEnabled,
        `unlock value ${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it("the block still runs when a locked company asked for PAYG", () => {
    // The routing consequence of the flag being ignored, not just its value.
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.claudePaygEnabled = true;
    raw.models = raw.models.map((model: any) =>
      model.family === "claude" ? { ...model, providers: ["openrouter"] } : model,
    );
    const decision = selectModel({
      descriptor: { taskClass: "architecture" },
      // Combos armed but PAYG still locked: the block must run because the
      // OWNER has not unlocked PAYG, not because the lane is undeployed.
      config: resolveConfig(raw, CLAUDE_COMBO_DEPLOYED),
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ stage: "claude-block" }),
    );
  });

  it("onValidateConfig REFUSES the write rather than warning about it", async () => {
    const definition = await validator();
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.claudePaygEnabled = true;

    const verdict = await definition.onValidateConfig!(raw);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors?.join(" ")).toContain("not unlocked on this instance");
  });

  it("onValidateConfig refuses a claudeFamilyProvider outside the allowlist", async () => {
    const definition = await validator();
    const raw = readFixture("company-a") as Record<string, any>;
    raw.providers.claudeFamilyProvider = "openrouter";

    const verdict = await definition.onValidateConfig!(raw);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors?.join(" ")).toContain("not a provider owner rule 1 allows");
  });
});

// ---------------------------------------------------------------------------
// TOG-149: the routing prefix in a model id outranks the `providers` array.
//
// TOG-237 moved "which models are Claude" out of config and into code. It left
// the question one layer up — WHO SERVES a Claude model — resting on
// `models[].providers`, which is the same kind of company-supplied claim. These
// are the shortest configs that made the router hand a Claude model to a
// non-teamclaude provider on v0.2.3, both reproduced before the fix.
//
// Owner decision on `rule1_scope` (2026-08-24): teamclaude_only. `oc/claude-*`
// is excluded too, because Claude served anywhere else does not consume the
// pooled teamclaude quota the owner is trying to fill, and blinds the usage
// gate that assumes it sees all Claude spend.
// ---------------------------------------------------------------------------

describe("rule 1: the model id's routing prefix is the destination, not `providers`", () => {
  /** company-a with claude-opus-5 renamed to a prefixed id but still labelled teamclaude. */
  function prefixedOpus(): RouterConfig {
    return companyA((raw) => {
      raw.models = raw.models.map((model: any) =>
        model.id === "claude-opus-5"
          ? { ...model, id: "oc/claude-opus-5", providers: ["teamclaude"] }
          : model,
      );
    });
  }

  const frontier = {
    taskClass: "architecture",
    signals: { complexity: 10, risk: 10, blastRadius: 10, ambiguity: 10 },
  };

  it("blocks a prefixed Claude id even when `providers` claims teamclaude", () => {
    const decision = selectModel({ descriptor: frontier, config: prefixedOpus() });

    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "oc/claude-opus-5", stage: "claude-block" }),
    );
    expect(decision.candidates.map((candidate) => candidate.modelId)).not.toContain(
      "oc/claude-opus-5",
    );
  });

  it("says the PREFIX refused it, so the operator does not go and edit `providers`", () => {
    const decision = selectModel({ descriptor: frontier, config: prefixedOpus() });
    const rejection = decision.rejections.find((entry) => entry.modelId === "oc/claude-opus-5");

    expect(rejection?.reason).toContain('routing prefix "oc/"');
  });

  // The sharp edge: owner rule 4 says a pin is always respected, so a pin is the
  // one path that skips the cheapest-survivor ranking. On v0.2.3 this returned
  // outcome "selected" with honored: true.
  it("REFUSES a pin on a prefixed Claude id — rule 4 never outranks rule 1", () => {
    const decision = selectModel({
      descriptor: { ...frontier, pinnedModelId: "oc/claude-opus-5", pinReason: "attack" },
      config: prefixedOpus(),
    });

    expect(decision.pin).toMatchObject({ modelId: "oc/claude-opus-5", honored: false });
    expect(decision.modelId).not.toBe("oc/claude-opus-5");
  });

  it("permits a BARE Claude id when a combo is armed to resolve it", () => {
    const decision = selectModel({ descriptor: frontier, config: A });

    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-sonnet-5");
  });

  // This test used to assert the opposite, under the name "still permits a BARE
  // Claude id — that is the rule 3 form a combo resolves". The premise was that
  // a bare id is safe BECAUSE a combo resolves it. TOG-294 measured the live
  // router and found no combo to do the resolving — `teamclaude/*` is empty in
  // GET /api/v1/models — and found the bare id served anyway, rewritten to
  // `anthropic/claude-sonnet-5`. The id form was right and the assumption
  // underneath it was untrue, so the assertion was too.
  it("refuses a BARE Claude id when no combo is armed, rather than routing it blind", () => {
    const undeployed = companyA(() => {}, {});

    expect(undeployed.providers.claudeComboArmed).toBe(false);

    const decision = selectModel({ descriptor: frontier, config: undeployed });

    expect(decision.candidates.map((candidate) => candidate.modelId)).not.toContain(
      "claude-sonnet-5",
    );
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "claude-sonnet-5", stage: "claude-block" }),
    );
  });

  it("names the unset env var in the trace, so the operator edits the right thing", () => {
    const undeployed = companyA(() => {}, {});
    const decision = selectModel({ descriptor: frontier, config: undeployed });
    const rejection = decision.rejections.find(
      (entry) => entry.modelId === "claude-sonnet-5" && entry.stage === "claude-block",
    );

    // The old trace for a blocked Claude id advised "name the bare model id and
    // let an OmniRoute combo resolve it". Unarmed, that advice moves the
    // operator off a BLOCKED leak and onto a SILENT one.
    expect(rejection?.reason).toContain(CLAUDE_COMBO_ARMED_ENV);
    expect(rejection?.reason).not.toMatch(/name the bare model id and let an OmniRoute combo/);
  });

  it("is an instance decision: a company cannot arm the lane from its own config row", () => {
    // Phase 4 installs this plugin into companies whose config the owner does
    // not review. If this were a `providers.*` field, an installee could
    // re-open a rule-1 hole in the OWNER's router by editing its own row.
    const claimsArmed = companyA((raw) => {
      raw.providers.claudeComboArmed = true;
      raw.providers.claudeLaneArmed = true;
      raw.claudeComboArmed = true;
    }, {});

    expect(claimsArmed.providers.claudeComboArmed).toBe(false);
    expect(
      selectModel({ descriptor: frontier, config: claimsArmed }).candidates.map((c) => c.modelId),
    ).not.toContain("claude-sonnet-5");
  });

  it("does not let `claudePaygEnabled` unlock provider-naming", () => {
    const config = companyA((raw) => {
      raw.providers.claudePaygEnabled = true;
      raw.models = raw.models.map((model: any) =>
        model.id === "claude-opus-5"
          ? { ...model, id: "oc/claude-opus-5", providers: ["teamclaude", "opencode"] }
          : model,
      );
    });

    const decision = selectModel({ descriptor: frontier, config });
    expect(decision.candidates.map((candidate) => candidate.modelId)).not.toContain(
      "oc/claude-opus-5",
    );
  });
});

// ---------------------------------------------------------------------------
// TOG-149: Claude ids that name the model by FAMILY only.
//
// `claude|anthropic` missed 15 live catalogue ids (2026-08-24, 1,438 ids): the
// `aug/*` routes name Claude by family — opus, sonnet, haiku, fable — and carry
// neither "claude" nor "anthropic". The combo CLI has refused these since
// TOG-151; the policy layer was selecting them. The layers disagreeing was the
// defect.
// ---------------------------------------------------------------------------

describe("rule 1: Claude models named by family only", () => {
  const familyNamed = [
    "aug/opus4.7",
    "aug/sonnet5-high",
    "aug/haiku4.5",
    "aug/fable-5",
    "aug/mythos5",
    "aug/prism-a",
  ];

  it.each(familyNamed)("blocks %s even when the config declares family 'gpt'", (id) => {
    const config = companyA((raw) => {
      raw.models.push({
        id,
        family: "gpt",
        tier: "frontier",
        quality: 95,
        costPerMTokIn: 0.5,
        costPerMTokOut: 2,
        contextWindow: 400_000,
        capabilities: ["tools", "structured-output"],
        providers: ["openrouter"],
        enabled: true,
      });
    });

    const decision = selectModel({
      descriptor: {
        taskClass: "architecture",
        signals: { complexity: 10, risk: 10, blastRadius: 10, ambiguity: 10 },
        pinnedModelId: id,
        pinReason: "attack",
      },
      config,
    });

    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: id, stage: "claude-block" }),
    );
    expect(decision.modelId).not.toBe(id);
  });
});
