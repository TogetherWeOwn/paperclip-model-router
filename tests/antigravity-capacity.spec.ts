import { describe, expect, it } from "vitest";

import { normalizeAntigravityAuthFiles } from "../src/capacity/antigravity.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

const NOW = "2026-09-06T20:00:00.000Z";
const MODELS = ["cliproxy/gemini-3.7-flash-high", "cliproxy/gemini-3.1-pro-low"];

const source: CapacitySourceConfig = {
  id: "antigravity-oauth",
  kind: "antigravity-auth-files",
  statusUrl: "https://capacity.example.test/v0/management/auth-files",
  apiKeySecretRef: null,
  modelIds: MODELS,
  healthFields: ["status"],
  requestTimeoutMs: 5000,
  maxResponseBytes: 262144,
  windows: [
    { name: "five-hour", utilizationFields: ["five-hour", "five_hour", "five_hour_remaining_fraction"], resetFields: ["resetAt", "reset_at", "five_hour_reset_at"] },
    { name: "weekly", utilizationFields: ["weekly", "weekly_remaining_fraction"], resetFields: ["resetAt", "reset_at", "weekly_reset_at"] },
  ],
};

function authFile(overrides: Record<string, unknown> = {}) {
  return {
    auth_index: "must-not-leak",
    email: "private@example.test",
    access_token: "secret",
    provider: "antigravity",
    type: "antigravity",
    status: "active",
    quota_windows: {
      "five-hour": {
        remainingFraction: 0.5,
        resetAt: "2026-09-06T22:00:00Z",
      },
      weekly: {
        remainingFraction: 0.7,
        resetAt: "2026-09-10T20:00:00Z",
      },
    },
    ...overrides,
  };
}

function routingConfig() {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry: "exclude-lane", sources: [source] },
    models: MODELS.map((id, index) => ({
      id,
      tier: "standard",
      quality: 87,
      costPerMTokIn: index,
      costPerMTokOut: index,
      contextWindow: 200000,
      enabled: true,
    })),
    taskClasses: [{ key: "architecture", qualityFloor: 85 }],
  });
}

describe("antigravity auth-file capacity telemetry", () => {
  it("reports bounded usable five-hour and weekly headroom without credential identity", () => {
    const snapshot = normalizeAntigravityAuthFiles({ payload: { files: [authFile()] }, source, fetchedAt: NOW });

    expect(snapshot.error).toBeNull();
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence[0]).toMatchObject({
      laneLabel: "credential-1",
      health: "healthy",
      posture: "available",
      telemetryAvailable: true,
      remainingFraction: 0.5,
      utilization: 0.5,
    });
    expect(snapshot.evidence[0]!.windows).toHaveLength(2);
    expect(snapshot.evidence[0]!.windows[0]).toMatchObject({ name: "five-hour", remainingFraction: 0.5, utilization: 0.5 });
    expect(snapshot.evidence[0]!.windows[1]).toMatchObject({ name: "weekly", remainingFraction: 0.7 });
    expect(snapshot.evidence[0]!.windows[1]!.utilization).toBeCloseTo(0.3);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(JSON.stringify(snapshot)).not.toContain("private@example.test");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it.each([
    ["cooling", authFile({ status: "cooling_down" })],
    ["five-hour exhausted", authFile({ quota_windows: { "five-hour": { remainingFraction: 0, resetAt: "2026-09-07T01:00:00Z" }, weekly: { remainingFraction: 0.7, resetAt: "2026-09-10T20:00:00Z" } } })],
    ["weekly exhausted", authFile({ quota_windows: { "five-hour": { remainingFraction: 0.5, resetAt: "2026-09-06T22:00:00Z" }, weekly: { remainingFraction: 0, resetAt: "2026-09-10T20:00:00Z" } } })],
  ])("makes both models ineligible when every credential is %s", (_label, credential) => {
    const snapshot = normalizeAntigravityAuthFiles({ payload: { files: [credential, credential] }, source, fetchedAt: NOW });
    const decision = selectModel({
      config: routingConfig(),
      descriptor: { taskClass: "architecture" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null });
    for (const modelId of MODELS) {
      expect(decision.rejections).toContainEqual(expect.objectContaining({ modelId, stage: "capacity" }));
    }
  });

  it("fails closed when a credential omits either required quota window", () => {
    const incomplete = authFile({ quota_windows: { "five-hour": { remainingFraction: 0.5, resetAt: "2026-09-06T22:00:00Z" } } });
    const snapshot = normalizeAntigravityAuthFiles({ payload: { files: [incomplete] }, source, fetchedAt: NOW });
    const decision = selectModel({
      config: routingConfig(),
      descriptor: { taskClass: "architecture" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    expect(snapshot.error).toBe("antigravity-auth-files-incomplete");
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, capacity: { telemetry: "unavailable" } });
  });
});
