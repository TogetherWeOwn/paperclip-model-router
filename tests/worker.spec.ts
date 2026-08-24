/**
 * Worker-level tests driven through the SDK's own in-memory host harness, so
 * the plugin is exercised over the real context surface (config, state, tools,
 * data, actions) rather than through hand-written doubles.
 *
 * The same harness is instantiated twice with two companies' configs to show
 * that the ONE worker build serves both.
 */

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { ACTION_KEYS, DATA_KEYS, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

// The worker resolves config through `process.env`, not an injected env, so the
// combo-armed signal has to be stubbed at the process level here. These tests
// assert what the worker does with a WORKING Claude lane; without this the
// fixtures' bare Claude ids are refused at the claude-block gate, which is the
// undeployed case and is covered in `gate-integrity.spec.ts`. TOG-294.
beforeEach(() => {
  vi.stubEnv("MODEL_ROUTER_CLAUDE_COMBO_ARMED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

async function harnessFor(fixture: string) {
  const harness = createTestHarness({ manifest, config: readFixture(fixture) });
  // `definePlugin` returns `{ definition }`; the host calls into the definition,
  // and so do these tests, rather than re-wrapping it in a double.
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, plugin: definition };
}

describe("worker surfaces", () => {
  it("registers the tool, data keys and actions the manifest advertises", async () => {
    const { harness } = await harnessFor("company-a");
    const result = await harness.executeTool(TOOL_NAMES.selectModel, {
      companyId: COMPANY_A,
      taskClass: "implementation",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("returns the effective config for a company through the data bridge", async () => {
    const { harness } = await harnessFor("company-a");
    const data = await harness.getData<{ config: { models: unknown[] } }>(DATA_KEYS.effectiveConfig, {
      companyId: COMPANY_A,
    });
    expect(data.config.models).toHaveLength(6);
  });

  it("records every decision in company-scoped state", async () => {
    const { harness } = await harnessFor("company-a");
    await harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_A,
      taskClass: "implementation",
      issueId: "issue-1",
    });
    const log = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLog,
    }) as Array<{ modelId: string; outcome: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "selected", modelId: "minimax-m2.5" });
  });

  it("remembers the model used on an issue so the next call does not switch", async () => {
    const { harness } = await harnessFor("company-a");
    await harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_A,
      taskClass: "architecture",
      issueId: "issue-7",
    });
    const sticky = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.issueStickiness,
    }) as Record<string, string>;
    expect(sticky["issue-7"]).toBe("claude-sonnet-5");

    // A later, cheaper-looking call on the same issue keeps the incumbent.
    const second = (await harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_A,
      taskClass: "implementation",
      issueId: "issue-7",
    })) as { modelId: string; trace: string[] };
    expect(second.modelId).toBe("claude-sonnet-5");
    expect(second.trace.join(" ")).toContain("prompt cache");
  });

  it("refuses a tool call with no companyId", async () => {
    const { harness } = await harnessFor("company-a");
    const result = await harness.executeTool(TOOL_NAMES.selectModel, {});
    expect(result).toMatchObject({ ok: false });
  });
});

describe("one worker build, two companies", () => {
  it("serves two companies from two config rows with no code difference", async () => {
    const a = await harnessFor("company-a");
    const b = await harnessFor("company-b");

    const decisionA = (await a.harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_A,
      taskClass: "implementation",
    })) as { modelId: string };
    const decisionB = (await b.harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_B,
      taskClass: "implementation",
    })) as { modelId: string };

    expect(decisionA.modelId).toBe("minimax-m2.5");
    expect(decisionB.modelId).toBe("gpt-4.1");
  });

  it("keeps decision state separate per company", async () => {
    const a = await harnessFor("company-a");
    await a.harness.performAction(ACTION_KEYS.route, {
      companyId: COMPANY_A,
      taskClass: "implementation",
    });
    const otherCompanyLog = a.harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_B,
      stateKey: STATE_KEYS.decisionLog,
    });
    expect(otherCompanyLog ?? null).toBeNull();
  });
});

describe("onValidateConfig", () => {
  it("accepts a complete config", async () => {
    const { plugin } = await harnessFor("company-a");
    const result = await plugin.onValidateConfig!(readFixture("company-a"));
    expect(result.ok).toBe(true);
  });

  it("warns loudly when the OWNER has enabled Claude pay-as-you-go", async () => {
    const { plugin } = await harnessFor("company-b");
    vi.stubEnv("MODEL_ROUTER_CLAUDE_PAYG_UNLOCK", "1");
    try {
      const result = await plugin.onValidateConfig!(readFixture("company-b"));
      expect(result.ok).toBe(true);
      expect(result.warnings?.join(" ")).toContain("pay-as-you-go is ENABLED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses the same config when the instance has not unlocked PAYG", async () => {
    // company-b's stored bytes are unchanged; only the instance differs. A
    // company config row cannot enable Claude PAYG on its own — owner rule 1.
    const { plugin } = await harnessFor("company-b");
    const result = await plugin.onValidateConfig!(readFixture("company-b"));
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("not unlocked on this instance");
  });

  it("rejects a quota gate that is enabled with no status URL", async () => {
    const { plugin } = await harnessFor("company-a");
    const result = await plugin.onValidateConfig!({
      quotaGate: { enabled: true, statusUrl: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("statusUrl");
  });

  it("rejects thresholds that are out of order", async () => {
    const { plugin } = await harnessFor("company-a");
    const result = await plugin.onValidateConfig!({
      budget: { warnFraction: 0.9, downshiftFraction: 0.5, haltFraction: 0.95 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("warn <= downshift <= halt");
  });

  it("rejects a task class pin that is not in the model table", async () => {
    const { plugin } = await harnessFor("company-a");
    const result = await plugin.onValidateConfig!({
      taskClasses: [{ key: "x", qualityFloor: 10, pinnedModelId: "does-not-exist" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid Rule 0 regular expression", async () => {
    const { plugin } = await harnessFor("company-a");
    const result = await plugin.onValidateConfig!({
      rule0: { enabled: true, deterministicPatterns: [{ pattern: "([", tool: "x" }] },
    });
    expect(result.ok).toBe(false);
  });
});

describe("scoped API routes", () => {
  it("answers the effective-config route", async () => {
    const { plugin } = await harnessFor("company-a");
    const response = await plugin.onApiRequest!({
      routeKey: "company-config",
      method: "GET",
      path: "/effective-config",
      params: {},
      query: { companyId: COMPANY_A },
      body: null,
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(response.status).toBe(200);
  });

  it("answers the issue routing route with a decision", async () => {
    const { plugin } = await harnessFor("company-a");
    const response = await plugin.onApiRequest!({
      routeKey: "route-issue",
      method: "POST",
      path: "/issues/issue-1/route",
      params: { issueId: "issue-1" },
      query: {},
      body: { taskClass: "implementation" },
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as { decision: { modelId: string } }).decision.modelId).toBe("minimax-m2.5");
  });

  it("routes through the same path as every other surface", async () => {
    // The HTTP route used to call `selectModel` directly. That gave it a second
    // routing engine with no quota gate, no stickiness, no decision log and no
    // metric — the one surface an operator is most likely to hit by hand was
    // also the one nothing recorded. TOG-228.
    const { harness, plugin } = await harnessFor("company-a");

    const response = await plugin.onApiRequest!({
      routeKey: "route-issue",
      method: "POST",
      path: "/issues/issue-7/route",
      params: { issueId: "issue-7" },
      query: {},
      body: { taskClass: "implementation" },
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(response.status).toBe(200);

    // Recorded, like every other surface.
    const log = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.decisionLog,
    }) as Array<{ issueId: string; modelId: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ issueId: "issue-7", modelId: "minimax-m2.5" });

    // ...and sticky, like every other surface.
    const sticky = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.issueStickiness,
    }) as Record<string, string>;
    expect(sticky["issue-7"]).toBe("minimax-m2.5");
  });

  it("applies the budget gate supplied in the request body", async () => {
    const { plugin } = await harnessFor("company-a");
    const response = await plugin.onApiRequest!({
      routeKey: "route-issue",
      method: "POST",
      path: "/issues/issue-8/route",
      params: { issueId: "issue-8" },
      query: {},
      body: { taskClass: "implementation", budgetSpentFraction: 0.99 },
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    const { decision } = response.body as {
      decision: { outcome: string; gates: { budget: string } };
    };
    expect(decision.gates.budget).toBe("halt");
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("404s an unknown route key", async () => {
    const { plugin } = await harnessFor("company-a");
    const response = await plugin.onApiRequest!({
      routeKey: "nope",
      method: "GET",
      path: "/nope",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "agent", actorId: "agent-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(response.status).toBe(404);
  });
});
