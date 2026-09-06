import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

// TOG-1062 review of PR #37 (TOG-1040 fail-open).
//
// Two guarantees the fail-open change claims but did not defend with a test:
//
//   1. Fail-open relaxes ABSENCE only. A lane that positively reports
//      `exhausted` must STILL be excluded under enforce, even when the producer
//      sent no utilization number alongside the status. The normalizer only sets
//      `telemetryAvailable` when a utilization is present
//      (src/capacity/normalize.ts:152), so a status-only exhausted record used to
//      be flattened to `unknown` and then served as if it were mere absence.
//
//   2. The `capacityDegraded` field must actually reach the persisted decision
//      record. A pure-engine test cannot prove the worker ever writes it.

const NOW = "2026-09-05T10:00:00.000Z";

const statusOnlySource: CapacitySourceConfig = {
  id: "subscriptions",
  statusUrl: "https://capacity.example.test/status",
  apiKeySecretRef: null,
  modelIds: ["cheap-model"],
  requestTimeoutMs: 5_000,
  maxResponseBytes: 262_144,
  healthFields: ["status"],
  windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: ["resets7dAt"] }],
};

function enforceConfig(unknownTelemetry: string) {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry, sources: [statusOnlySource] },
    models: [
      { id: "cheap-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

describe("TOG-1062: fail-open relaxes absence, never a positive exhaustion signal", () => {
  // The exact shape that exposed the gap: a producer that reports the lane as
  // exhausted and nulls out the percentage, which is what a quota API typically
  // does once there is no quota left to express as a fraction. The utilization
  // KEY is present (so the record is collected) but carries no usable number, so
  // `telemetryAvailable` comes back false while `health` is a real signal.
  const statusOnlyExhausted = { accounts: [{ account: "primary", status: "exhausted", used7d: null }] };

  it("the normalizer keeps the exhausted health even with no utilization number", () => {
    const snapshot = normalizeCapacityPayload({ payload: statusOnlyExhausted, source: statusOnlySource, fetchedAt: NOW });

    expect(snapshot.error).toBeNull(); // the payload parsed — this is NOT absence
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]).toMatchObject({
      health: "exhausted",
      posture: "unavailable",
      utilization: null,
      // Documents the trap: the normalizer reports the lane as not-covered
      // because no utilization was present, even though health is a real signal.
      telemetryAvailable: false,
    });
  });

  it("EXCLUDES a known-exhausted lane under enforce+fail-open (not degraded-by-design)", () => {
    const snapshot = normalizeCapacityPayload({ payload: statusOnlyExhausted, source: statusOnlySource, fetchedAt: NOW });
    const decision = selectModel({
      config: enforceConfig("fail-open"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    // A lane that is KNOWN exhausted must still deny. Fail-open must not become
    // "ignore capacity" just because the producer omitted a percentage.
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    // And it must NOT be reported as degraded-by-design: telemetry was present
    // and readable, so the operator's dashboard must read this as a real lane
    // outage rather than a telemetry gap.
    expect(decision.capacity.degraded).toBe(false);
    expect(decision.capacity.telemetry).toBe("available");
  });

  it("still fails OPEN when the payload is genuinely unparseable", () => {
    // The control for the test above: same route, but real absence this time.
    const snapshot = normalizeCapacityPayload({
      payload: { accounts: [{ account: "primary", state: "who-knows" }] },
      source: statusOnlySource,
      fetchedAt: NOW,
    });
    expect(snapshot.evidence).toHaveLength(0);

    const decision = selectModel({
      config: enforceConfig("fail-open"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.degraded).toBe(true);
    expect(decision.capacity.telemetry).toBe("unavailable");
  });

  it("an explicitly unavailable lane is excluded too, and is not reported degraded", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { accounts: [{ account: "primary", status: "offline", used7d: null }] },
      source: statusOnlySource,
      fetchedAt: NOW,
    });
    const decision = selectModel({
      config: enforceConfig("fail-open"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.capacity.degraded).toBe(false);
  });
});

describe("TOG-1062: capacityDegraded actually reaches the persisted decision record", () => {
  const COMPANY = "11111111-1111-4111-8111-111111111111";

  async function workerWithCapacityOutage() {
    const config = readFixture("company-a") as Record<string, unknown>;
    // Point the router at a capacity source whose payload the normalizer cannot
    // recognize, so the run degrades rather than refusing.
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
          // Valid JSON, right envelope, none of the mapped fields.
          return new Response(JSON.stringify({ accounts: [{ account: "primary", state: "degraded" }] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion", model: "echo-a",
          choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const { definition } = createPlugin();
    await definition.setup(harness.ctx);
    return harness;
  }

  it("writes capacityDegraded: true onto the decision record the operator reads", async () => {
    const harness = await workerWithCapacityOutage();
    await harness.performAction("invoke", {
      task: { taskClass: "implementation", issueId: "issue-1" },
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 100,
    }, { companyId: COMPANY });

    const log = companyDecisionRecords(harness, COMPANY);

    expect(log).toHaveLength(1);
    // This is the assertion the engine-only tests cannot make: the flag survives
    // the worker wiring seam and lands in the persisted record. Deleting the
    // `capacityDegraded:` line in worker.ts must fail THIS test.
    expect(log[0]).toHaveProperty("capacityDegraded", true);
    expect(log[0]!.selectionOutcome).toBe("selected");
  });
});
