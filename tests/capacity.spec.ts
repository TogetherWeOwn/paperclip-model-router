import { describe, expect, it } from "vitest";

import { evidenceFromContract } from "../src/capacity/contract.js";
import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import { normalizeUsage, unavailableSnapshot } from "../src/telemetry/normalize.js";
import type { ModelUsageSnapshot, UsageObservation } from "../src/telemetry/types.js";

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

/**
 * TOG-977 acceptance: the consumer against contract-shaped fixtures.
 *
 * These exercise `src/capacity/contract.ts`, the documented adapter between the
 * contract wire type in `src/telemetry/types.ts` and the engine's internal
 * `CapacityEvidence`. Everything above this line drives the legacy vendor path
 * in `normalize.ts`, which stays for non-contract status bodies.
 *
 * Fixtures are built from the PRODUCER's own `normalizeUsage`, not hand-written
 * to match the consumer's expectations. A hand-written fixture proves the
 * consumer parses what the test author imagined; running the real producer
 * proves the two halves are wire-compatible, which is the point of the card.
 */
describe("TOG-977: contract-shaped fixtures through the consumer", () => {
  const OBSERVED = "2026-09-04T12:00:00.000Z";

  const contractSource: CapacitySourceConfig = {
    ...source,
    id: "model-usage",
    statusUrl: "https://router.infextion.net/telemetry/model-usage",
  };

  /** Produce a real contract snapshot, then read it back as the consumer. */
  function roundTrip(
    observations: UsageObservation[],
    over: Partial<ModelUsageSnapshot> = {},
    fetchedAt = OBSERVED,
  ) {
    const produced = normalizeUsage({ observations, observedAt: OBSERVED });
    return evidenceFromContract({
      payload: { ...produced, ...over },
      source: contractSource,
      fetchedAt,
    });
  }

  const busy: UsageObservation = {
    modelIds: ["subscription-model"],
    reportedState: null,
    windows: [
      { window: "five-hour", utilization: 0.96, resetsAt: "2026-09-04T18:00:00.000Z" },
      { window: "weekly", utilization: 0.4, resetsAt: "2026-09-08T00:00:00.000Z" },
    ],
  };
  const idle: UsageObservation = {
    modelIds: ["available-model"],
    reportedState: null,
    windows: [{ window: "five-hour", utilization: 0.2, resetsAt: null }],
  };

  it("reads a producer-generated snapshot into one evidence row per model id", () => {
    const snapshot = roundTrip([busy, idle]);
    expect(snapshot.telemetry).toBe("available");
    expect(snapshot.error).toBeNull();
    expect(snapshot.evidence.map((entry) => [entry.modelId, entry.utilization])).toEqual([
      ["subscription-model", 0.96],
      ["available-model", 0.2],
    ]);
  });

  it("keys strictly on the opaque model id and never fans one record across ids", () => {
    // The probe has to be a model the source is configured for but the producer
    // did NOT mention. With both models present, a fan-out bug and a correct key
    // lookup return the same rows, and the test would pass either way.
    // `contractSource.modelIds` is ["subscription-model", "available-model"];
    // only the first is observed here.
    const snapshot = roundTrip([busy]);
    expect(snapshot.evidence.map((entry) => entry.modelId)).toEqual(["subscription-model"]);
    // The exact defect the TOG-975 interop spec pinned: the legacy tree walk
    // hands `available-model` the busy model's 0.96. A key lookup gives it
    // nothing at all, which is the honest answer.
    expect(snapshot.evidence.some((entry) => entry.modelId === "available-model")).toBe(false);
    // Uncovered is not an outage: the producer is healthy and simply does not
    // govern that model (§4's middle row).
    expect(snapshot.telemetry).toBe("available");
  });

  it("still attributes each model its own number when the producer covers both", () => {
    const snapshot = roundTrip([busy, idle]);
    const available = snapshot.evidence.filter((entry) => entry.modelId === "available-model");
    expect(available).toHaveLength(1);
    expect(available[0]!.utilization).toBe(0.2);
    expect(snapshot.evidence.some((entry) => entry.utilization === 0.96 && entry.modelId !== "subscription-model")).toBe(false);
  });

  it("carries the most restrictive window and keeps both windows on the row", () => {
    const snapshot = roundTrip([busy, idle]);
    const row = snapshot.evidence.find((entry) => entry.modelId === "subscription-model")!;
    expect(row.windows.map((window) => window.name).sort()).toEqual(["five-hour", "weekly"]);
    expect(row.utilization).toBe(0.96);
    expect(row.health).toBe("degraded");
  });

  it("exposes no provider, account, lane, or connection identity", () => {
    const serialized = JSON.stringify(roundTrip([busy, idle])).toLowerCase();
    for (const forbidden of ["provider", "account", "connection", "combo", "credential", "apikey", "tenant"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // ---- §6.1 unknown schemaVersion is rejected, not silently routed ----

  it("rejects an unknown schemaVersion rather than best-effort parsing it", () => {
    const snapshot = roundTrip([busy, idle], { schemaVersion: 2 as never });
    expect(snapshot.reasonCode).toBe("capacity-schema-version-unsupported");
    expect(snapshot.telemetry).toBe("unavailable");
    expect(snapshot.evidence).toEqual([]);
  });

  it("refuses to route on a rejected schemaVersion even though the v1 fields parse", () => {
    // The body is otherwise a perfectly good v1 snapshot. If the version check
    // were advisory this would route. It must not: a v2 body may reuse v1 field
    // names with different meanings.
    const snapshot = roundTrip([idle], { schemaVersion: 99 as never });
    const decision = selectModel({
      config: routingConfig("shadow"),
      descriptor: { taskClass: "implementation" },
      signals: {
        capacityEvidence: snapshot.evidence,
        capacityTelemetry: snapshot.telemetry,
        capacityError: snapshot.error ?? undefined,
      },
    });
    expect(decision.capacity.telemetry).toBe("unavailable");
    expect(decision.capacity.shadowModelId).toBeNull();
  });

  // ---- §6.2 a stale snapshot routes as unavailable ----

  it("treats observedAt + staleAfterSeconds < fetchedAt as unavailable", () => {
    // staleAfterSeconds defaults to 300; fetched 301s after observation.
    const snapshot = roundTrip([busy, idle], {}, "2026-09-04T12:05:01.000Z");
    expect(snapshot.reasonCode).toBe("capacity-snapshot-stale");
    expect(snapshot.telemetry).toBe("unavailable");
    expect(snapshot.evidence).toEqual([]);
  });

  it("still accepts a snapshot inside its freshness budget", () => {
    const snapshot = roundTrip([busy, idle], {}, "2026-09-04T12:04:59.000Z");
    expect(snapshot.telemetry).toBe("available");
    expect(snapshot.evidence).toHaveLength(2);
  });

  it("judges staleness against observedAt, not against a cache's serve time", () => {
    // A producer serving from cache answers instantly with old numbers. Judging
    // freshness at fetch time would call this fresh; it is 40 minutes old.
    const produced = normalizeUsage({ observations: [busy], observedAt: "2026-09-04T11:20:00.000Z" });
    const snapshot = evidenceFromContract({ payload: produced, source: contractSource, fetchedAt: OBSERVED });
    expect(snapshot.reasonCode).toBe("capacity-snapshot-stale");
  });

  it("routes a stale snapshot as unavailable through selectModel", () => {
    const snapshot = roundTrip([busy, idle], {}, "2026-09-04T13:00:00.000Z");
    const decision = selectModel({
      config: routingConfig("shadow"),
      descriptor: { taskClass: "implementation" },
      signals: {
        capacityEvidence: snapshot.evidence,
        capacityTelemetry: snapshot.telemetry,
        capacityError: snapshot.error ?? undefined,
      },
    });
    expect(decision.capacity.telemetry).toBe("unavailable");
    expect(decision.capacity.decisionReason).toContain("capacity-snapshot-stale");
  });

  // ---- §6.4 unknown stays routable ----

  it("keeps an unmeasured model routable rather than treating it as exhausted", () => {
    const snapshot = roundTrip([
      { modelIds: ["available-model"], reportedState: null, windows: [] },
    ]);
    const row = snapshot.evidence.find((entry) => entry.modelId === "available-model")!;
    expect(row.health).toBe("unknown");
    expect(row.posture).toBe("unknown");
    // Absence of evidence is not evidence of exhaustion.
    expect(row.health).not.toBe("exhausted");
    expect(snapshot.telemetry).toBe("available");
  });

  // ---- §3.2 serviceable must agree with state ----

  it("drops a record whose serviceable contradicts its state", () => {
    const produced = normalizeUsage({ observations: [busy, idle], observedAt: OBSERVED });
    const tampered = {
      ...produced,
      models: {
        ...produced.models,
        "subscription-model": { ...produced.models["subscription-model"]!, state: "exhausted", serviceable: true },
      },
    };
    const snapshot = evidenceFromContract({ payload: tampered, source: contractSource, fetchedAt: OBSERVED });
    // Honouring either half would be picking which lie to believe. The healthy
    // sibling still routes; the malformed record simply has no row.
    expect(snapshot.evidence.map((entry) => entry.modelId)).toEqual(["available-model"]);
  });
});

/**
 * §4, asserted in the CONSUMER. It was previously proven only on the producer
 * side, and the TOG-975 interop spec measured the v0.4.0 consumer collapsing
 * the two cases into one identical error string.
 */
describe("TOG-977: outage is distinguishable from healthy-empty in the consumer", () => {
  const OBSERVED = "2026-09-04T12:00:00.000Z";
  const contractSource: CapacitySourceConfig = { ...source, id: "model-usage" };

  const healthyEmpty = evidenceFromContract({
    payload: normalizeUsage({ observations: [], observedAt: OBSERVED }),
    source: contractSource,
    fetchedAt: OBSERVED,
  });
  const outage = evidenceFromContract({
    payload: unavailableSnapshot({ observedAt: OBSERVED, reasonCode: "upstream-unreachable" }),
    source: contractSource,
    fetchedAt: OBSERVED,
  });

  it("produces zero evidence rows in BOTH cases — so row count cannot tell them apart", () => {
    // Stated explicitly because it is why the distinction has to be structural.
    expect(healthyEmpty.evidence).toEqual([]);
    expect(outage.evidence).toEqual([]);
  });

  it("distinguishes them structurally on the snapshot", () => {
    expect(healthyEmpty.telemetry).toBe("available");
    expect(healthyEmpty.reasonCode).toBeNull();
    expect(healthyEmpty.error).toBeNull();

    expect(outage.telemetry).toBe("unavailable");
    expect(outage.reasonCode).toBe("capacity-producer-unavailable");
    expect(outage.error).toBeTruthy();

    // The regression the TOG-975 interop spec measured: identical error strings.
    expect(outage.error).not.toEqual(healthyEmpty.error);
  });

  it("distinguishes them by CONSUMER BEHAVIOUR in selectModel, not just by field value", () => {
    const decide = (snapshot: typeof healthyEmpty) =>
      selectModel({
        config: routingConfig("shadow"),
        descriptor: { taskClass: "implementation" },
        signals: {
          capacityEvidence: snapshot.evidence,
          capacityTelemetry: snapshot.telemetry,
          capacityError: snapshot.error ?? undefined,
        },
      });

    const healthyDecision = decide(healthyEmpty);
    const outageDecision = decide(outage);

    // A healthy producer that governs nothing is a trustworthy answer: capacity
    // telemetry is available, it simply constrains no model.
    expect(healthyDecision.capacity.telemetry).toBe("available");
    // An outage is a failure, and must never read as unlimited capacity.
    expect(outageDecision.capacity.telemetry).toBe("unavailable");
    expect(healthyDecision.capacity.telemetry).not.toBe(outageDecision.capacity.telemetry);
    expect(healthyDecision.capacity.decisionReason).not.toEqual(outageDecision.capacity.decisionReason);
  });

  it("diverges under enforce + fail-closed: the outage refuses, the healthy-empty does not", () => {
    // The behavioural difference that actually matters. Same zero rows, same
    // config; only reported producer health differs, and the outcomes differ.
    const decide = (snapshot: typeof healthyEmpty) =>
      selectModel({
        config: routingConfig("enforce"),
        descriptor: { taskClass: "implementation" },
        signals: {
          capacityEvidence: snapshot.evidence,
          capacityTelemetry: snapshot.telemetry,
          capacityError: snapshot.error ?? undefined,
        },
      });

    expect(decide(outage).capacity.telemetry).toBe("unavailable");
    expect(decide(healthyEmpty).capacity.telemetry).toBe("available");
  });
});
