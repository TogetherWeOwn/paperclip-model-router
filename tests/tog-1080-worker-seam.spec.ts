/**
 * TOG-1080 review of PR #38 (TOG-1076 degraded-for-uncovered-winner).
 *
 * The existing worker-seam test (tests/tog-1062-fail-open-boundary.spec.ts:173)
 * proves `capacityDegraded` reaches the persisted record — but it drives the
 * FETCH-FAILURE cause, where `base.capacity.degraded` is already true at
 * select.ts:102. It therefore passes identically with or without PR #38.
 *
 * This drives the NEW cause through the same seam: telemetry fetches fine and
 * parses fine, one lane is genuinely covered and exhausted, and the winner is a
 * model no source covers. Pre-PR that persisted `capacityDegraded: false`.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

/**
 * A worker whose capacity telemetry is fully HEALTHY and parseable, covering
 * only `covered-model` and reporting it exhausted. `uncovered-model` is named
 * by no source at all, so it wins on absent evidence under fail-open.
 */
async function workerWithUncoveredWinner() {
  const config = readFixture("company-a") as Record<string, unknown>;

  // Two models: the metered one is the cheaper/preferred pick, so if capacity
  // were ignored entirely it would win. Exhausting it forces the uncovered tail.
  config.models = [
    { id: "covered-model", family: "other", tier: "standard", quality: 90, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200_000, enabled: true },
    { id: "uncovered-model", family: "other", tier: "standard", quality: 90, costPerMTokIn: 5, costPerMTokOut: 5, contextWindow: 200_000, enabled: true },
  ];
  config.taskClasses = [{ key: "implementation", qualityFloor: 70 }];
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    sources: [{
      id: "subscriptions",
      statusUrl: "https://capacity.example.test/status",
      // Deliberately covers ONLY covered-model.
      modelIds: ["covered-model"],
      healthFields: ["status"],
      windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: ["resets7dAt"] }],
    }],
  };

  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret-a"; } };
  harness.ctx.http = {
    async fetch(url) {
      if (String(url).includes("capacity.example.test")) {
        // A well-formed, fully parseable payload: utilization present so
        // telemetryAvailable is true, health positively exhausted.
        return new Response(JSON.stringify({
          accounts: [{ account: "primary", status: "exhausted", used7d: 1, resets7dAt: "2026-09-05T18:00:00.000Z" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: "uncovered-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

describe("TOG-1080: the uncovered-winner degradation reaches the persisted record", () => {
  it("persists capacityDegraded: true when telemetry is HEALTHY but the winner is uncovered", async () => {
    const harness = await workerWithUncoveredWinner();
    // `storedCapacity` reads PERSISTED state; the refresh is a separate action.
    // Without this the snapshot is stale, capacityError becomes
    // "capacity-snapshot-stale", and the run degrades via the OLD select.ts:102
    // path — which would pass on pristine main and prove nothing.
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY });

    await harness.performAction("invoke", {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    }, { companyId: COMPANY });

    const log = companyDecisionRecords(harness, COMPANY);

    expect(log).toHaveLength(1);
    expect(log[0]!.selectionOutcome).toBe("selected");
    // The distinguishing facts: the fetch SUCCEEDED (so this is not the
    // select.ts:102 path the TOG-1062 test already covers)...
    expect(log[0]!.capacityTelemetry).toBe("available");
    // ...the winner is the model no source covers...
    expect(log[0]!.selectedModelId ?? log[0]!.modelId).toBe("uncovered-model");
    expect(log[0]!.capacityLane).toBeNull();
    // ...and the operator-visible record still says degraded. This is the
    // assertion that fails on pristine main.
    expect(log[0]).toHaveProperty("capacityDegraded", true);
  });
});
