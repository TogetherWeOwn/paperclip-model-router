import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

// TOG-7885 (G8): `maxSnapshotAgeMs` made staleness a routing fact, but it was
// invisible — no counter, no record rollup, nothing to alert on before
// promoting shadow→enforce. These tests pin the three surfaces to the single
// worker-computed `snapshotAgeMs`:
//
//   1. the served decision carries `capacity.snapshotAgeMs/snapshotStale`;
//   2. a company-namespaced `model_router.company.<id>.capacity.snapshot_stale`
//      metric fires on the degraded-age invocation (and only there);
//   3. the persisted decision record rolls both up for the alert query.
//
// Deleting the `snapshotAgeMs:` line in worker.ts, the `metrics.write` for
// `snapshot_stale`, or either `capacitySnapshot*:` line in worker.ts must fail
// THESE tests — a pure-engine test cannot prove the worker wiring.

const COMPANY = "11111111-1111-4111-8111-111111111111";

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

const staleEvidence = (modelId: string) => ({
  modelId,
  source: "capacity",
  laneLabel: "stale-lane",
  health: "healthy",
  posture: "available",
  utilization: 0.1,
  remainingFraction: 0.9,
  resetsAt: null,
  resetInSeconds: null,
  windows: [],
  telemetryAvailable: true,
  reason: "old",
});

async function harnessWithCapacity() {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as { stickyModelWithinIssue: boolean }).stickyModelWithinIssue = false;
  config.capacityRouting = {
    enabled: true,
    mode: "shadow",
    unknownTelemetry: "fail-open",
    maxSnapshotAgeMs: 300_000,
    sources: [{
      id: "capacity",
      statusUrl: "https://capacity.example.test/status",
      modelIds: ["minimax-m2.5"],
      healthFields: ["status"],
      requestTimeoutMs: 5000,
      maxResponseBytes: 262144,
      windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }],
    }],
  };
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret-a"; } };
  harness.ctx.http = {
    async fetch() {
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

async function seedSnapshot(
  harness: Awaited<ReturnType<typeof harnessWithCapacity>>,
  refreshedAt: string,
) {
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEYS.capacitySnapshot },
    {
      refreshedAt,
      lastRefreshError: null,
      snapshots: [],
      evidence: [staleEvidence("minimax-m2.5")],
    },
  );
}

describe("TOG-7885: capacity-snapshot age is observable", () => {
  it("a stale snapshot surfaces on the served decision, fires the counter, and lands in the record", async () => {
    const harness = await harnessWithCapacity();
    await seedSnapshot(harness, "2000-01-01T00:00:00.000Z");

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      outcome: string;
      decision: { capacity: { snapshotAgeMs: number | null; snapshotStale: boolean } };
    };

    // 1. The staleness is on the decision itself — the acceptance step: force
    // a stale snapshot, invoke, see the staleness.
    expect(result.outcome).toBe("completed");
    expect(result.decision.capacity.snapshotStale).toBe(true);
    expect(result.decision.capacity.snapshotAgeMs).toEqual(expect.any(Number));
    expect(result.decision.capacity.snapshotAgeMs as number).toBeGreaterThan(300_000);

    // 2. The company-scoped degraded-age counter fired exactly once.
    const staleMetrics = harness.metrics.filter(
      (entry) => entry.name === `model_router.company.${COMPANY}.capacity.snapshot_stale`,
    );
    expect(staleMetrics).toHaveLength(1);
    expect(staleMetrics[0]!.value).toBe(1);

    // 3. The persisted record rolls the age up for the alert query.
    const log = companyDecisionRecords(harness, COMPANY);
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveProperty("capacitySnapshotStale", true);
    expect(log[0]!.capacitySnapshotAgeMs).toEqual(expect.any(Number));
    expect(log[0]!.capacitySnapshotAgeMs as number).toBeGreaterThan(300_000);
  });

  it("a fresh snapshot serves with snapshotStale false, no counter, and a bounded age", async () => {
    const harness = await harnessWithCapacity();
    const before = Date.now();
    await seedSnapshot(harness, new Date().toISOString());

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      outcome: string;
      decision: { capacity: { snapshotAgeMs: number | null; snapshotStale: boolean } };
    };

    // A negative control for the metric: fresh must NOT fire it. Without this,
    // a worker that fires the counter unconditionally still passes test 1.
    expect(result.outcome).toBe("completed");
    expect(result.decision.capacity.snapshotStale).toBe(false);
    expect(result.decision.capacity.snapshotAgeMs as number).toBeGreaterThanOrEqual(0);
    expect(result.decision.capacity.snapshotAgeMs as number).toBeLessThanOrEqual(Date.now() - before + 5_000);
    expect(harness.metrics.filter(
      (entry) => entry.name === `model_router.company.${COMPANY}.capacity.snapshot_stale`,
    )).toHaveLength(0);

    const log = companyDecisionRecords(harness, COMPANY);
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveProperty("capacitySnapshotStale", false);
    expect(log[0]!.capacitySnapshotAgeMs).toEqual(expect.any(Number));
  });

  it("no snapshot stored reads as stale with a null age, never as fresh", async () => {
    const harness = await harnessWithCapacity();
    // No seed: capacity routing is enabled but nothing was ever refreshed.

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      outcome: string;
      decision: { capacity: { snapshotAgeMs: number | null; snapshotStale: boolean; telemetry: string } };
    };

    // Missing evidence degrades, not fresh: the age reads null and the stale
    // flag still fires the counter. A null masquerading as "age 0" would look
    // like a just-refreshed snapshot in the rollup.
    expect(result.decision.capacity.snapshotAgeMs).toBeNull();
    expect(result.decision.capacity.snapshotStale).toBe(true);
    expect(harness.metrics.filter(
      (entry) => entry.name === `model_router.company.${COMPANY}.capacity.snapshot_stale`,
    )).toHaveLength(1);

    const log = companyDecisionRecords(harness, COMPANY);
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveProperty("capacitySnapshotAgeMs", null);
    expect(log[0]).toHaveProperty("capacitySnapshotStale", true);
  });

  it("disabled capacity routing reads as no snapshot — null age, never stale", async () => {
    const harness = await harnessWithCapacity();
    await seedSnapshot(harness, "2000-01-01T00:00:00.000Z");
    // Flip capacity routing off AFTER seeding: the stale stored row must not
    // leak into a decision that never consulted it.
    const raw = harness.ctx.config as { get: (companyId: string) => Promise<Record<string, unknown>> };
    const baseGet = raw.get.bind(raw);
    raw.get = async (companyId: string) => {
      const config = await baseGet(companyId);
      return { ...config, capacityRouting: { ...(config.capacityRouting as object), enabled: false } };
    };

    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      outcome: string;
      decision: { capacity: { snapshotAgeMs: number | null; snapshotStale: boolean; telemetry: string } };
    };

    expect(result.outcome).toBe("completed");
    expect(result.decision.capacity.telemetry).toBe("not-configured");
    expect(result.decision.capacity.snapshotAgeMs).toBeNull();
    expect(result.decision.capacity.snapshotStale).toBe(false);
    expect(harness.metrics.filter(
      (entry) => entry.name === `model_router.company.${COMPANY}.capacity.snapshot_stale`,
    )).toHaveLength(0);

    const log = companyDecisionRecords(harness, COMPANY);
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveProperty("capacitySnapshotAgeMs", null);
    expect(log[0]).toHaveProperty("capacitySnapshotStale", false);
  });
});
