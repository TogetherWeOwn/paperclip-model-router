import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

// TOG-1064, found merging PR #37.
//
// TOG-1062 fixed the absence-before-health ordering in `engine/select.ts`, but
// the SAME ordering bug exists a layer earlier, at the capacity refresh gate in
// `worker.ts`. That gate decides whether a snapshot is persisted at all:
//
//   - `malformedEvidence` used the pre-1062 predicate, which keys off
//     `telemetryAvailable`; the normalizer only sets that when a utilization
//     number is present (`capacity/normalize.ts:152`).
//   - A lane reporting `status: "exhausted"` with a null percentage therefore
//     made the whole refresh `capacity-refresh-incomplete`, so the evidence was
//     never written to state.
//   - `invoke` reads STORED capacity, so it then saw absence, not exhaustion —
//     and under `fail-open` absence is served.
//
// The select.ts reorder alone cannot save this: select never receives the
// evidence. Both layers must agree that an explicit exhausted/unavailable
// health is a positive signal.
//
// Note the two layers are only reachable in this order via the refresh action,
// which is why the engine-level TOG-1062 tests (which hand-feed evidence and
// `capacityError: undefined`) pass while production still served.

const COMPANY = "11111111-1111-4111-8111-111111111111";

async function workerWithStatusOnlyLane(status: string) {
  const config = readFixture("company-a") as Record<string, unknown>;
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    sources: [{
      id: "subscriptions",
      statusUrl: "https://capacity.example.test/status",
      modelIds: (config.models as Array<{ id: string }>).map((entry) => entry.id),
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
        // The shape a quota API returns once there is no quota left to express
        // as a fraction: a real status, and a null percentage.
        return new Response(JSON.stringify({
          accounts: [{ account: "primary", status, used7d: null }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: "echo-a",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

describe("TOG-1064: the refresh gate must persist a status-only exhausted lane", () => {
  it("does not mark a status-only exhausted refresh incomplete", async () => {
    const harness = await workerWithStatusOnlyLane("exhausted");
    const refreshed = await harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as { error: string | null; evidence: unknown[] };

    // The pre-fix predicate returned "capacity-refresh-incomplete" here, which
    // discarded the snapshot and turned a known outage into absence.
    expect(refreshed.error).toBeNull();
    expect(refreshed.evidence.length).toBeGreaterThan(0);
  });

  it("DENIES an invocation after a known-exhausted refresh, under enforce+fail-open", async () => {
    const harness = await workerWithStatusOnlyLane("exhausted");
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY });
    await harness.performAction("invoke", {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    }, { companyId: COMPANY });

    const log = companyDecisionRecords(harness, COMPANY);

    expect(log).toHaveLength(1);
    // Regression guard: on 2fb83ea AND on a612488 this served `minimax-m2.5`.
    expect(log[0]!.selectionOutcome).toBe("no-eligible-model");
    // And it must read as a real lane outage, not a telemetry gap — the
    // operator's dashboard distinguishes "we are out of quota" from "we cannot
    // see our quota", and only the first should page a human about capacity.
    expect(log[0]!.capacityDegraded).toBe(false);
    expect(log[0]!.capacityTelemetry).toBe("available");
  });

  it("still fails OPEN when the refresh is genuinely unreadable", async () => {
    // The control: same route, real absence. Fail-open must still serve.
    const harness = await workerWithStatusOnlyLane("who-knows");
    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY });
    await harness.performAction("invoke", {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    }, { companyId: COMPANY });

    const log = companyDecisionRecords(harness, COMPANY);

    expect(log[0]!.selectionOutcome).toBe("selected");
    expect(log[0]!.capacityDegraded).toBe(true);
  });
});
