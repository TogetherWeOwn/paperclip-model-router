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
  modelIds: ["subscription-model", "available-model"],
  requestTimeoutMs: 5000,
  maxResponseBytes: 1048576,
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
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence[0]).toMatchObject({
      laneLabel: "record-1",
      utilization: 0.96,
      resetsAt: "2026-09-04T12:02:00.000Z",
      resetInSeconds: 120,
      telemetryAvailable: true,
    });
    expect(snapshot.evidence[0]!.remainingFraction).toBeCloseTo(0.04);
    expect(JSON.stringify(snapshot)).not.toContain("credential");
  });

  it("treats an exhausted window resetting imminently as degraded, not permanently dead", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
      fetchedAt: NOW,
      payload: {
        accounts: [{
          account: "resetting",
          used5h: 1,
          resets5hAt: "2026-09-04T12:03:00Z",
        }],
      },
    });
    expect(snapshot.evidence[0]).toMatchObject({ health: "degraded", posture: "avoid" });
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

    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence.every((lane) => lane.laneLabel === "record-1")).toBe(true);
    expect(snapshot.evidence.every((lane) => lane.posture === "unavailable")).toBe(true);
  });

  it("pairs the restrictive window's utilization with its own reset", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
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

    expect(snapshot.evidence[0]).toMatchObject({
      health: "exhausted",
      posture: "unavailable",
      utilization: 1,
      resetsAt: "2026-09-10T12:00:00.000Z",
      resetInSeconds: 518400,
    });
  });

  it.each([
    ["degraded", "degraded", "avoid"],
    ["exhausted", "exhausted", "unavailable"],
    ["unknown", "unknown", "unknown"],
  ] as const)("keeps explicit %s health at least as restrictive as a healthy window", (status, health, posture) => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
      fetchedAt: NOW,
      payload: { accounts: [{ account: "explicit", status, used5h: 0.1 }] },
    });
    expect(snapshot.evidence[0]).toMatchObject({ health, posture });
  });

  it("keeps exhaustion unavailable when reset is current or past", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
      fetchedAt: NOW,
      payload: { accounts: [{ account: "expired", used5h: 1, resets5hAt: NOW }] },
    });
    expect(snapshot.evidence[0]).toMatchObject({ health: "exhausted", posture: "unavailable", resetInSeconds: 0 });
  });

  it("does not persist remote lane/account/URL-like labels", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
      fetchedAt: NOW,
      payload: { accounts: [{ account: "https://secret.example/token", used5h: 0.2 }] },
    });
    expect(snapshot.evidence[0]?.laneLabel).toBe("record-1");
    expect(JSON.stringify(snapshot)).not.toContain("secret.example");
  });

  it("ignores reset-only windows when choosing restrictive utilization", () => {
    const snapshot = normalizeCapacityPayload({
      source: { ...source, modelIds: ["subscription-model"] },
      fetchedAt: NOW,
      payload: { accounts: [{ account: "reset-only", resets5hAt: "2026-09-10T12:00:00Z", used7d: 0.7, resets7dAt: "2026-09-11T12:00:00Z" }] },
    });
    expect(snapshot.evidence[0]).toMatchObject({ utilization: 0.7, resetsAt: "2026-09-11T12:00:00.000Z", telemetryAvailable: true });
  });
});

function routingConfig(mode: "shadow" | "enforce") {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
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
              },
      {
        id: "available-model",
        family: "other",
        tier: "standard",
        quality: 80,
        costPerMTokIn: 1,
        costPerMTokOut: 4,
        contextWindow: 200000,
              },
      {
        id: "cheap-below-floor",
        family: "other",
        tier: "small",
        quality: 30,
        costPerMTokIn: 0,
        costPerMTokOut: 0,
        contextWindow: 200000,
              },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

const lanes = [
  {
    modelId: "subscription-model",
    source: "subscriptions",
    laneLabel: "scarce-subscription",
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
    modelId: "available-model",
    source: "subscriptions",
    laneLabel: "available-capacity",
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
      signals: { capacityEvidence: lanes },
    });
    expect(decision.modelId).toBe("subscription-model");
    expect(decision.capacity).toMatchObject({
      mode: "shadow",
      shadowModelId: "available-model",
      shadowSource: "subscriptions",
      shadowLaneLabel: "available-capacity",
    });
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({ modelId: "cheap-below-floor", stage: "quality-floor" }),
    );
  });

  it.each(["capacity-snapshot-stale", "capacity-request-failed"])("keeps shadow serving unchanged from the no-outage baseline after %s", (capacityError) => {
    const config = routingConfig("shadow");
    const descriptor = { taskClass: "implementation", requestedProfile: "implementation" };
    const baseline = selectModel({ config, descriptor, signals: { capacityEvidence: lanes } });
    const outage = selectModel({ config, descriptor, signals: { capacityEvidence: lanes, capacityError } });

    expect(baseline.capacity.telemetry).toBe("available");
    expect(outage.capacity.telemetry).toBe("unavailable");
    expect(outage).toMatchObject({
      outcome: baseline.outcome,
      modelId: baseline.modelId,
      fallbackUsed: baseline.fallbackUsed,
    });
  });

  it.each(["capacity-snapshot-stale", "capacity-request-failed"])("does not use retained evidence under exclude-lane after %s", (capacityError) => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      capacityRouting: { ...routingConfig("enforce").capacityRouting, unknownTelemetry: "exclude-lane" },
    });
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: lanes, capacityError },
    });
    expect(decision).toMatchObject({ outcome: "no-eligible-model", modelId: null, capacity: { telemetry: "unavailable" } });
  });

  it("ignores uncovered candidates above the effective tier under fail-closed", () => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      tiering: { signalWeights: {}, thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 }, defaultTier: "small" },
      models: [
        { id: "healthy-small", tier: "small", quality: 80, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200000 },
        { id: "uncovered-frontier", tier: "frontier", quality: 95, costPerMTokIn: 10, costPerMTokOut: 10, contextWindow: 200000 },
      ],
    });
    const healthy = { ...lanes[1]!, modelId: "healthy-small" };
    const decision = selectModel({ config, descriptor: { taskClass: "implementation" }, signals: { capacityEvidence: [healthy] } });
    expect(decision).toMatchObject({ outcome: "selected", modelId: "healthy-small" });
    expect(decision.rejections).toContainEqual(expect.objectContaining({ modelId: "uncovered-frontier", stage: "tier-ceiling" }));
  });

  it("aggregates contradictory evidence to the most restrictive posture", () => {
    const contradictory = [
      ...lanes,
      { ...lanes[1]!, source: "secondary", laneLabel: "record-1", health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0 },
    ];
    const decision = selectModel({ config: routingConfig("enforce"), descriptor: { taskClass: "implementation" }, signals: { capacityEvidence: contradictory } });
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("prefers usable capacity after the quality floor in enforce mode", () => {
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: lanes },
    });
    expect(decision.modelId).toBe("available-model");
    expect(decision.capacity).toMatchObject({
      selectedSource: "subscriptions",
      selectedLaneLabel: "available-capacity",
      usagePosture: "available",
    });
  });

  it.each([
    ["pin", true],
    ["stickiness", false],
  ] as const)("does not let %s use telemetryAvailable:false evidence in enforce mode", (_label, pinned) => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      routing: { enabled: true, mode: "advise", stickyModelWithinIssue: !pinned },
    });
    const unknown = lanes.map((lane) => lane.modelId === "subscription-model"
      ? { ...lane, telemetryAvailable: false, health: "healthy" as const, posture: "available" as const }
      : lane);
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", ...(pinned ? { pinnedModelId: "subscription-model" } : { issueId: "issue-1" }) },
      signals: { capacityEvidence: unknown, ...(pinned ? {} : { stickyModelId: "subscription-model" }) },
    });
    expect(decision.modelId).toBeNull();
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("does not let a pin resurrect an exhausted lane in enforce mode", () => {
    const unavailableSubscription = lanes.map((lane) =>
      lane.modelId === "subscription-model"
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
      signals: { capacityEvidence: unavailableSubscription },
    });

    expect(decision.modelId).toBeNull();
    expect(decision.outcome).toBe("no-eligible-model");
  });

  // TOG-3551 (scope 3): the pin cap is stricter than the capacity gate. A lane
  // can be perfectly healthy (usable() passes) yet already above the weekly
  // utilization cap; a pin must not park more work on it.
  it("refuses a pin onto a healthy lane that is above the weekly utilization cap", () => {
    const hotButHealthy = lanes.map((lane) =>
      lane.modelId === "subscription-model"
        ? { ...lane, health: "healthy" as const, posture: "available" as const, utilization: 0.85, remainingFraction: 0.15 }
        : lane,
    );
    const decision = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation", pinnedModelId: "subscription-model", pinReason: "hot pin" },
      signals: { capacityEvidence: hotButHealthy },
    });
    expect(decision.pin).toMatchObject({ modelId: "subscription-model", honored: false });
  });

  // Boundary: the cap is strict (> 0.70). Exactly at 0.70 the pin is honored;
  // a hair above it is refused. This kills operator (>=) and threshold mutants.
  it("honors a pin exactly at the cap and refuses it just above", () => {
    const atCap = lanes.map((lane) =>
      lane.modelId === "subscription-model"
        ? { ...lane, health: "healthy" as const, posture: "available" as const, utilization: 0.7, remainingFraction: 0.3 }
        : lane,
    );
    const honored = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation", pinnedModelId: "subscription-model", pinReason: "at cap" },
      signals: { capacityEvidence: atCap },
    });
    expect(honored).toMatchObject({ outcome: "selected", modelId: "subscription-model", pin: { honored: true } });

    const overCap = atCap.map((lane) =>
      lane.modelId === "subscription-model" ? { ...lane, utilization: 0.7001, remainingFraction: 0.2999 } : lane,
    );
    const refused = selectModel({
      config: routingConfig("enforce"),
      descriptor: { taskClass: "implementation", pinnedModelId: "subscription-model", pinReason: "over cap" },
      signals: { capacityEvidence: overCap },
    });
    expect(refused.pin).toMatchObject({ honored: false });
  });

  it("does not let issue stickiness resurrect an exhausted lane in enforce mode", () => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      routing: { enabled: true, mode: "advise", stickyModelWithinIssue: true },
    });
    const unavailableSubscription = lanes.map((lane) =>
      lane.modelId === "subscription-model"
        ? { ...lane, health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0 }
        : lane,
    );
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation", issueId: "issue-1" },
      signals: {
        capacityEvidence: unavailableSubscription,
        stickyModelId: "subscription-model",
      },
    });

    expect(decision.modelId).toBeNull();
    expect(decision.outcome).toBe("no-eligible-model");
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
      signals: { capacityEvidence: exhaustedOpenrouterOnly },
    });

    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.rejections).toContainEqual(
      expect.objectContaining({
        modelId: "subscription-model",
        stage: "capacity",
        reason: expect.stringContaining("no capacity evidence covers"),
      }),
    );
  });

  it("refuses a below-quality-floor fallback whose enforced capacity is unknown", () => {
    const config = resolveConfig({
      ...routingConfig("enforce"),
      routing: { enabled: true, fallbackModelId: "cheap-below-floor", stickyModelWithinIssue: false },
    });
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: lanes.map((lane) => ({ ...lane, health: "exhausted" as const, posture: "unavailable" as const, telemetryAvailable: true })) },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.rejections).toContainEqual(expect.objectContaining({ modelId: "cheap-below-floor", stage: "quality-floor" }));
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
      signals: { capacityEvidence: unavailable },
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
        capacityEvidence: lanes,
        capacityError: "secondary telemetry endpoint unavailable",
      },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.capacity.telemetry).toBe("unavailable");
    expect(decision.trace.join(" ")).toContain("secondary telemetry endpoint unavailable");
  });

  // TOG-1040: enforce mode was denying service whenever capacity telemetry was
  // absent or unparseable. Losing capacity-awareness must degrade routing
  // quality, not deny service. These reproduce the two live failure shapes seen
  // in the v0.4.0 decision log.
  describe("TOG-1040: absent telemetry fails open to the static policy", () => {
    const failOpen = () => resolveConfig({
      ...routingConfig("enforce"),
      capacityRouting: { ...routingConfig("enforce").capacityRouting, unknownTelemetry: "fail-open" },
    });

    it("serves on the static policy when the payload carries no recognizable records", () => {
      // Shape 1: `capacityLane: null`, posture `not-evaluated`, error
      // "capacity payload carried no recognizable telemetry records".
      const decision = selectModel({
        config: failOpen(),
        descriptor: { taskClass: "implementation" },
        signals: { capacityEvidence: [], capacityError: "capacity payload carried no recognizable telemetry records" },
      });
      expect(decision.outcome).toBe("selected");
      expect(decision.modelId).toBe("subscription-model"); // cheapest qualifier — the static v1 answer
      expect(decision.capacity).toMatchObject({ telemetry: "unavailable", degraded: true });
      expect(decision.trace.join(" ")).toContain("WARNING");
      expect(decision.trace.join(" ")).toContain("no recognizable telemetry records");
    });

    it("serves a covered model when only some qualified models are uncovered", () => {
      // Shape 2: the records that logged "capacity telemetry available" and
      // still selected nothing — one uncovered model vetoed every covered one.
      const onlyAvailableCovered = [lanes[1]!];
      const decision = selectModel({
        config: failOpen(),
        descriptor: { taskClass: "implementation" },
        signals: { capacityEvidence: onlyAvailableCovered },
      });
      expect(decision.outcome).toBe("selected");
      expect(decision.capacity.telemetry).toBe("available");
      // Not degraded: telemetry arrived, it just did not cover everything.
      expect(decision.capacity.degraded).toBe(false);
      // The covered, healthy lane outranks the uncovered one.
      expect(decision.modelId).toBe("available-model");
    });

    it("still refuses a model whose evidence positively reports exhaustion", () => {
      // Fail-open relaxes ABSENCE only. A real exhaustion signal must still bite,
      // otherwise this fix would reintroduce the overspend TOG-972 closed.
      const decision = selectModel({
        config: failOpen(),
        descriptor: { taskClass: "implementation" },
        signals: {
          capacityEvidence: lanes.map((lane) => ({
            ...lane, health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0,
          })),
        },
      });
      expect(decision.outcome).toBe("no-eligible-model");
      expect(decision.modelId).toBeNull();
    });

    it("prefers a healthy lane over an uncovered model rather than merely tolerating it", () => {
      const decision = selectModel({
        config: failOpen(),
        descriptor: { taskClass: "implementation" },
        signals: { capacityEvidence: [{ ...lanes[1]!, utilization: 0.1 }] },
      });
      expect(decision.modelId).toBe("available-model");
      expect(decision.capacity).toMatchObject({ usagePosture: "available", selectedLaneLabel: "available-capacity" });
    });

    it("leaves fail-closed refusing, so the strict posture stays available", () => {
      const decision = selectModel({
        config: routingConfig("enforce"), // pinned fail-closed
        descriptor: { taskClass: "implementation" },
        signals: { capacityEvidence: [], capacityError: "capacity payload carried no recognizable telemetry records" },
      });
      expect(decision.outcome).toBe("no-eligible-model");
    });

    it("does not mark a fully covered decision as degraded", () => {
      const decision = selectModel({
        config: failOpen(),
        descriptor: { taskClass: "implementation" },
        signals: { capacityEvidence: lanes },
      });
      expect(decision.outcome).toBe("selected");
      expect(decision.capacity.degraded).toBe(false);
    });
  });

  it("records requested and serving identities without treating catalogue presence as health", () => {
    const decision = selectModel({
      config: routingConfig("shadow"),
      descriptor: {
        taskClass: "implementation",
        requestedModelId: "subscription-model",
        servingModelId: "available-model",
      },
      signals: {
        capacityEvidence: lanes,
        servingModelId: "available-model",
      },
    });
    expect(decision.capacity).toMatchObject({
      servingModelId: "available-model",
    });
  });
});
