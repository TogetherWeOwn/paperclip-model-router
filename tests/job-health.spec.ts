import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, JOB_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";

/** Everything company-a's model table lists. */
const ALL_MODELS = ["qwen3-coder", "minimax-m2.5", "claude-sonnet-5"];

function completion(modelId: string) {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A harness whose upstream serves a catalogue we control and completions for
 * anything else, so a job run and an invocation share one fake upstream.
 */
async function harnessWith(
  catalogue: () => Response,
  invoke: (modelId: string) => Response = completion,
) {
  const config = readFixture("company-a");
  const harness = createTestHarness({ manifest, config: {} });
  harness.seed({ companies: [{ id: COMPANY_A, name: "A" } as never] });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "credential"; } };
  const urls: string[] = [];
  harness.ctx.http = {
    async fetch(url, init) {
      urls.push(String(url));
      if (String(url).endsWith("/v1/models")) return catalogue();
      const body = JSON.parse(String((init as RequestInit).body));
      return invoke(body.model);
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, urls };
}

const invocation = {
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

async function invokeModelId(harness: Awaited<ReturnType<typeof harnessWith>>["harness"]) {
  const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as
    { outcome: string; decision: { modelId: string | null } };
  return result.decision.modelId;
}

const catalogueOf = (ids: string[]) => () =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("a dead upstream model stops being selected", () => {
  it("flips enabled through the scheduled job and reroutes the next call", async () => {
    // minimax-m2.5 is what company-a's implementation class selects while the
    // whole table is healthy — the cheapest model clearing the quality floor.
    const healthy = await harnessWith(catalogueOf(ALL_MODELS));
    expect(await invokeModelId(healthy.harness)).toBe("minimax-m2.5");

    // Now the upstream stops listing it. Two runs, because one absence is a
    // strike rather than a verdict.
    const dark = await harnessWith(catalogueOf(ALL_MODELS.filter((id) => id !== "minimax-m2.5")));
    await dark.harness.runJob(JOB_KEYS.modelHealth);
    expect(await invokeModelId(dark.harness)).toBe("minimax-m2.5");

    await dark.harness.runJob(JOB_KEYS.modelHealth);
    const health = dark.harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    }) as Record<string, { verdict: string }>;
    expect(health["minimax-m2.5"]?.verdict).toBe("dead");

    // The selection moves on rather than failing forever against a dead model.
    expect(await invokeModelId(dark.harness)).toBe("claude-sonnet-5");

    // And the flip is on the board, not only in failed invocations.
    expect(dark.harness.activity.map((entry) => entry.message)).toEqual([
      expect.stringContaining("took minimax-m2.5 out of service"),
    ]);
  });

  it("leaves the table alone when the catalogue probe fails", async () => {
    const broken = await harnessWith(() => new Response("{}", { status: 503 }));
    await broken.harness.runJob(JOB_KEYS.modelHealth);
    await broken.harness.runJob(JOB_KEYS.modelHealth);
    // Nothing was ever written — not an empty table, no table at all.
    expect(broken.harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    })).toBeUndefined();
    expect(await invokeModelId(broken.harness)).toBe("minimax-m2.5");
    expect(broken.harness.activity).toEqual([]);
  });
});

describe("invocation outcomes govern present-model health", () => {
  it("degrades repeated failures, reroutes, and recovers from real completions", async () => {
    let minimaxFails = true;
    const routed = await harnessWith(catalogueOf(ALL_MODELS), (modelId) =>
      modelId === "minimax-m2.5" && minimaxFails
        // No content-type: the transport reports invalid-upstream-response,
        // still a post-transport failure that counts against the model.
        ? new Response("{}", { status: 403 })
        : completion(modelId),
    );

    await routed.harness.runJob(JOB_KEYS.modelHealth);
    expect(await invokeModelId(routed.harness)).toBe("minimax-m2.5");
    expect(await invokeModelId(routed.harness)).toBe("minimax-m2.5");

    let health = routed.harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    }) as Record<string, { verdict: string }>;
    expect(health["minimax-m2.5"]?.verdict).toBe("degraded");
    expect(await invokeModelId(routed.harness)).toBe("claude-sonnet-5");
    expect(routed.harness.activity.map((entry) => entry.message)).toContainEqual(
      expect.stringContaining("degraded minimax-m2.5"),
    );

    minimaxFails = false;
    // Fake the passage of the degraded cooldown: backdate the degraded
    // verdict so the next catalogue reconciliation opens probation.
    const past = "2026-08-30T00:30:00.000Z";
    const current = routed.harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    }) as Record<string, unknown>;
    current["minimax-m2.5"] = {
      ...(current["minimax-m2.5"] as object),
      checkedAt: past,
      degradedAt: past,
    };
    await routed.harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth },
      current,
    );
    // The scheduled catalogue reconciliation opens a probation window after the
    // degraded cooldown; the next two real calls prove recovery.
    await routed.harness.runJob(JOB_KEYS.modelHealth);
    expect(await invokeModelId(routed.harness)).toBe("minimax-m2.5");
    expect(await invokeModelId(routed.harness)).toBe("minimax-m2.5");
    health = routed.harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    }) as Record<string, { verdict: string }>;
    expect(health["minimax-m2.5"]?.verdict).toBe("healthy");
  });

  it("keeps a degraded model as the last eligible option", async () => {
    const routed = await harnessWith(catalogueOf(ALL_MODELS), (modelId) =>
      modelId === "claude-sonnet-5" ? new Response("{}", { status: 403 }) : completion(modelId),
    );
    const pinned = {
      ...invocation,
      task: { taskClass: "architecture", pinnedModelId: "claude-sonnet-5", pinReason: "operator pin" },
    };
    await routed.harness.performAction(ACTION_KEYS.invoke, pinned, { companyId: COMPANY_A });
    await routed.harness.performAction(ACTION_KEYS.invoke, pinned, { companyId: COMPANY_A });
    expect(await invokeModelId(routed.harness)).toBe("minimax-m2.5");

    const architecture = await routed.harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { taskClass: "architecture" },
    }, { companyId: COMPANY_A }) as { decision: { modelId: string | null } };
    expect(architecture.decision.modelId).toBe("claude-sonnet-5");
  });

  it("does not change model health for failures before transport", async () => {
    const { harness, urls } = await harnessWith(catalogueOf(ALL_MODELS));
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      task: { taskClass: "implementation" },
      messages: [],
      maxOutputTokens: 100,
    }, { companyId: COMPANY_A }) as { outcome: string };
    expect(result.outcome).toBe("error");
    expect(urls).toEqual([]);
    expect(harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    })).toBeUndefined();
  });

  it("does not attribute a shared authentication failure to one model", async () => {
    const { harness } = await harnessWith(
      catalogueOf(ALL_MODELS),
      () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );
    await invokeModelId(harness);
    await invokeModelId(harness);
    expect(harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.modelHealth,
    })).toBeUndefined();
  });

  it("returns the invocation result when health telemetry fails", async () => {
    const routed = await harnessWith(
      catalogueOf(ALL_MODELS),
      () => new Response("{}", { status: 403 }),
    );
    // The firewall is per-sink, not per-path: the invocation's own
    // `model_router.invoke.*` counter in record() must keep working while
    // only health reporting breaks. Fail the health series by name.
    routed.harness.ctx.activity = { async log() { throw new Error("activity unavailable"); } };
    routed.harness.ctx.metrics = {
      async write(name) {
        if (String(name).startsWith("model_router.health.")) {
          throw new Error("health metric unavailable");
        }
      },
    };
    const first = await routed.harness.performAction(
      ACTION_KEYS.invoke,
      invocation,
      { companyId: COMPANY_A },
    ) as { outcome: string };
    expect(first.outcome).toBe("error");
    const result = await routed.harness.performAction(
      ACTION_KEYS.invoke,
      invocation,
      { companyId: COMPANY_A },
    ) as { outcome: string; error: { code: string } };
    expect(result.outcome).toBe("error");
    expect(result.error.code).toBe("invalid-upstream-response");
  });
});
