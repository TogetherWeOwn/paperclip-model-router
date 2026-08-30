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
async function harnessWith(catalogue: () => Response) {
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
      return completion(body.model);
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

describe("the budget gate halts on the router's own measured spend", () => {
  it("accrues real usage and then refuses non-pinned work", async () => {
    const { harness } = await harnessWith(catalogueOf(ALL_MODELS));
    // company-a caps at $250 and halts at 0.95 => $237.50.
    // minimax-m2.5 is $0.25/MTok in, $1/MTok out; each call reports 1000 in and
    // 1000 out, so each costs $0.00125. Seed the ledger to just under the line
    // and let one real invocation carry it over.
    harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.spendLedger },
      { month: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`, totalUsd: 237.4995, invocations: 1 },
    );

    expect(await invokeModelId(harness)).toBe("minimax-m2.5");

    const ledger = harness.getState({
      scopeKind: "company", scopeId: COMPANY_A, stateKey: STATE_KEYS.spendLedger,
    }) as { totalUsd: number };
    expect(ledger.totalUsd).toBeGreaterThan(237.5);

    // The next non-pinned call is refused, and no HTTP happens for it.
    const refused = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as
      { outcome: string; decision: { gates: { budget: string } } };
    expect(refused.outcome).toBe("no-eligible-model");
    expect(refused.decision.gates.budget).toBe("halt");

    // A pinned call still goes through — halt stops discretionary spend, not
    // work the operator explicitly pinned.
    const pinned = await harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { ...invocation.task, pinnedModelId: "minimax-m2.5", pinReason: "operator pin" },
    }, { companyId: COMPANY_A }) as { outcome: string };
    expect(pinned.outcome).toBe("completed");
  });
});
