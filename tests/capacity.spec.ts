import { describe, expect, it } from "vitest";

import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

const NOW = "2026-09-04T12:00:00.000Z";

const source: CapacitySourceConfig = {
  id: "subscriptions",
  statusUrl: "https://capacity.example.test/status",
  apiKeySecretRef: null,
  providers: ["teamclaude", "openrouter"],
  accountIdFields: ["account"],
  healthFields: ["status"],
  windows: [
    {
      name: "five-hour",
      utilizationFields: ["used5h"],
      resetFields: ["resets5hAt"],
    },
    {
      name: "weekly",
      utilizationFields: ["used7d"],
      resetFields: ["resets7dAt"],
    },
  ],
};

describe("provider-neutral capacity normalization", () => {
  it("normalizes account utilization and reset timestamps without credentials", () => {
    const snapshot = normalizeCapacityPayload({
      source,
      fetchedAt: NOW,
      payload: {
        accounts: [
          {
            account: "subscription-a",
            status: "allowed",
            used5h: 0.96,
            resets5hAt: "2026-09-04T12:02:00Z",
            used7d: 0.4,
            resets7dAt: "2026-09-08T00:00:00Z",
          },
        ],
      },
    });

    expect(snapshot.error).toBeNull();
    expect(snapshot.lanes).toHaveLength(2);
    expect(snapshot.lanes[0]).toMatchObject({
      account: "subscription-a",
      utilization: 0.96,
      resetsAt: "2026-09-04T12:02:00.000Z",
      resetInSeconds: 120,
      telemetryAvailable: true,
    });
    expect(snapshot.lanes[0]!.remainingFraction).toBeCloseTo(0.04);
    expect(JSON.stringify(snapshot)).not.toContain("credential");
  });

  it("treats an exhausted window resetting imminently as degraded, not permanently dead", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, providers: ["teamclaude"] },
      fetchedAt: NOW,
      payload: {
        accounts: [{
          account: "resetting",
          used5h: 1,
          resets5hAt: "2026-09-04T12:03:00Z",
        }],
      },
    });
    expect(snapshot.lanes[0]).toMatchObject({ health: "degraded", posture: "avoid" });
  });

  it("does not turn an envelope status into a synthetic healthy account", () => {
    const snapshot = normalizeCapacityPayload({
      source,
      fetchedAt: NOW,
      payload: {
        status: "ok",
        accounts: [{
          account: "real-account",
          status: "allowed",
          used7d: 1,
          resets7dAt: "2026-09-10T12:00:00Z",
        }],
      },
    });

    expect(snapshot.lanes).toHaveLength(2);
    expect(snapshot.lanes.every((lane) => lane.account === "real-account")).toBe(true);
    expect(snapshot.lanes.every((lane) => lane.posture === "unavailable")).toBe(true);
  });

  it("pairs the restrictive window's utilization with its own reset", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, providers: ["teamclaude"] },
      fetchedAt: NOW,
      payload: {
        accounts: [{
          account: "mixed-windows",
          used5h: 0.1,
          resets5hAt: "2026-09-04T12:02:00Z",
          used7d: 1,
          resets7dAt: "2026-09-10T12:00:00Z",
        }],
      },
    });

    expect(snapshot.lanes[0]).toMatchObject({
      health: "exhausted",
      posture: "unavailable",
      utilization: 1,
      resetsAt: "2026-09-10T12:00:00.000Z",
      resetInSeconds: 518400,
    });
  });
});

function routingConfig(mode: "shadow" | "enforce") {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    providers: { permitted: ["teamclaude", "openrouter"], preferenceOrder: ["teamclaude"] },
    capacityRouting: {
      enabled: true,
      mode,
      unknownTelemetry: "fail-closed",
      sources: [source],
    },
    models: [
      {
        id: "subscription-model",
        family: "other",
        tier: "standard",
        quality: 80,
        costPerMTokIn: 0,
        costPerMTokOut: 0,
        contextWindow: 200000,
        providers: ["teamclaude"],
      },
      {
        id: "available-model",
        family: "other",
        tier: "standard",
        quality: 80,
        costPerMTokIn: 1,
        costPerMTokOut: 4,
        contextWindow: 200000,
        providers: ["openrouter"],
      },
      {
        id: "cheap-below-floor",
        family: "other",
        tier: "small",
        quality: 30,
        costPerMTokIn: 0,
        costPerMTokOut: 0,
        contextWindow: 200000,
        providers: ["openrouter"],
      },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

const lanes = [
  {
    provider: "teamclaude",
    account: "scarce-subscription",
    health: "degraded" as const,
    posture: "avoid" as const,
    utilization: 0.96,
    remainingFraction: 0.04,
    resetsAt: "2026-09-04T18:00:00.000Z",
    resetInSeconds: 21600,
    windows: [],
    telemetryAvailable: true,
    reason: "near exhausted",
  },
  {
    provider: "openrouter",
    account: "available-capacity",
    health: "healthy" as const,
    posture: "available" as const,
    utilization: 0.2,
    remainingFraction: 0.8,
    resetsAt: null,
    resetInSeconds: null,
    windows: [],
    telemetryAvailable: true,
    reason: "healthy",
  },
];

describe("usage-aware selection", () => {
  it("keeps v1 serving in shadow mode and records the usage-aware alternative", () => {
    const decision = selectModel({
      config: routingConfig("shadow"),
      descriptor: { taskClass: "implementation", requestedProfile: "implementation" },
      signals: { capacityLanes: lanes },
    });
    expect(decision.modelId).toBe("subscription-model");
    expect(decision.capacity).toMatchObject({
      mode: "shadow",
      shadowModelId: "available-model",
      shadowProvider: "openrouter",
      shadowAccount: "available-capacity",
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "cheap-below-floor", stage: "quality-floor" }),
    );
  });

  it("prefers usable capacity after the quality floor in enforce mode", () => {
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityLanes: lanes },
    });
    expect(decision.modelId).toBe("available-model");
    expect(decision.capacity).toMatchObject({
      selectedProvider: "openrouter",
      selectedAccount: "available-capacity",
      usagePosture: "available",
    });
  });

  it("does not let a pin resurrect an exhausted lane in enforce mode", () => {
    const unavailableSubscription = lanes.map((lane) =>
      lane.provider === "teamclaude"
        ? { ...lane, health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0 }
        : lane,
    );
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: {
        taskClass: "implementation",
        pinnedModelId: "subscription-model",
        pinReason: "incident override",
      },
      signals: { capacityLanes: unavailableSubscription },
    });

    expect(decision.modelId).toBe("available-model");
    expect(decision.pin).toMatchObject({ modelId: "subscription-model", honored: false });
    expect(decision.capacity.usagePosture).toBe("available");
  });

  it("does not let issue stickiness resurrect an exhausted lane in enforce mode", () => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      routing: { enabled: true, mode: "advise", stickyModelWithinIssue: true },
    });
    const unavailableSubscription = lanes.map((lane) =>
      lane.provider === "teamclaude"
        ? { ...lane, health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0 }
        : lane,
    );
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", issueId: "issue-1" },
      signals: {
        capacityLanes: unavailableSubscription,
        stickyModelId: "subscription-model",
      },
    });

    expect(decision.modelId).toBe("available-model");
    expect(decision.capacity.usagePosture).toBe("available");
    expect(decision.trace.join(" ")).toContain("switching despite the cache cost");
  });

  it("rejects candidates with no covered provider lane under fail-closed enforcement", () => {
    const exhaustedOpenrouterOnly = [
      {
        ...lanes[1]!,
        health: "exhausted" as const,
        posture: "unavailable" as const,
        utilization: 1,
        remainingFraction: 0,
      },
    ];
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityLanes: exhaustedOpenrouterOnly },
    });

    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({
        modelId: "subscription-model",
        stage: "capacity",
        reason: expect.stringContaining("no capacity telemetry covers"),
      }),
    );
  });

  it("refuses rather than using a configured fallback when every lane is unavailable", () => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      routing: { enabled: true, fallbackModelId: "subscription-model", stickyModelWithinIssue: false },
    });
    const unavailable = lanes.map((lane) => ({
      ...lane,
      health: "exhausted" as const,
      posture: "unavailable" as const,
      utilization: 1,
      remainingFraction: 0,
    }));
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation" },
      signals: { capacityLanes: unavailable },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "subscription-model", stage: "capacity" }),
    );
  });

  it("fails closed in enforce mode when telemetry is unavailable", () => {
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityError: "telemetry endpoint unavailable" },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.trace.join(" ")).toContain("refusing");
  });

  it("fails closed when any configured telemetry source errors", () => {
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation" },
      signals: {
        capacityLanes: lanes,
        capacityError: "secondary telemetry endpoint unavailable",
      },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.capacity.telemetry).toBe("unavailable");
    expect(decision.trace.join(" ")).toContain("secondary telemetry endpoint unavailable");
  });

  it("records requested and serving identities without treating catalogue presence as health", () => {
    const decision = selectModel({
      config: routingConfig("shadow"),
      descriptor: {
        taskClass: "implementation",
        requestedModelId: "subscription-model",
        servingModelId: "available-model",
        servingProvider: "openrouter",
        servingAccount: "available-capacity",
      },
      signals: {
        capacityLanes: lanes,
        servingModelId: "available-model",
        servingProvider: "openrouter",
        servingAccount: "available-capacity",
      },
    });
    expect(decision.capacity).toMatchObject({
      servingModelId: "available-model",
      servingProvider: "openrouter",
      servingAccount: "available-capacity",
    });
  });
});
