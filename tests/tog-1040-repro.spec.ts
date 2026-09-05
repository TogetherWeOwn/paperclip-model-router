import { describe, expect, it } from "vitest";
import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

// TOG-1040 end-to-end reproduction.
//
// The live v0.4.0 fleet logged 15 `no-eligible-model` decisions, 9 on 2026-09-05,
// every one with `capacityLane: null` and `capacityPosture: "not-evaluated"`. This
// drives the REAL normalizer with a payload shaped like the one that produced
// "capacity payload carried no recognizable telemetry records", then feeds its
// output into the REAL engine — no hand-authored evidence fixture in between.

const source = {
  id: "subscriptions",
  statusUrl: "https://capacity.example/status",
  modelIds: ["cheap-model", "premium-model"],
  windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: ["resets7dAt"] }],
  healthFields: [] as string[],
  laneLabelFields: [] as string[],
  apiKeySecretRef: null,
  requestTimeoutMs: 5_000,
  maxResponseBytes: 262_144,
};

const NOW = "2026-09-05T10:00:00.000Z";

function configWith(unknownTelemetry: string) {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry, sources: [source] },
    models: [
      { id: "cheap-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200000 },
      { id: "premium-model", family: "other", tier: "standard", quality: 90, costPerMTokIn: 9, costPerMTokOut: 9, contextWindow: 200000 },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

describe("TOG-1040: the live no-eligible-model incident", () => {
  // A real telemetry producer outage: valid JSON, right envelope, but none of the
  // fields the router maps. This is what the normalizer cannot recognize.
  const outagePayload = { accounts: [{ account: "primary", status: "degraded" }] };

  it("the payload really is unparseable — this is the live error string", () => {
    const snapshot = normalizeCapacityPayload({ payload: outagePayload, source, fetchedAt: NOW });
    expect(snapshot.evidence).toHaveLength(0);
    expect(snapshot.error).toBe("capacity payload carried no recognizable telemetry records");
  });

  it("BEFORE (fail-closed): the caller gets no model at all", () => {
    const snapshot = normalizeCapacityPayload({ payload: outagePayload, source, fetchedAt: NOW });
    const decision = selectModel({
      config: configWith("fail-closed"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });
    // This is the live breakage, reproduced exactly.
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
    expect(decision.capacity.selectedSource).toBeNull();   // capacityLane: null
    expect(decision.capacity.usagePosture).toBe("not-evaluated");
  });

  it("AFTER (fail-open, the new default): service continues on the static policy", () => {
    const snapshot = normalizeCapacityPayload({ payload: outagePayload, source, fetchedAt: NOW });
    const decision = selectModel({
      config: configWith("fail-open"),
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("cheap-model"); // the static routing policy: cheapest qualifier
    expect(decision.capacity.degraded).toBe(true);
    expect(decision.capacity.telemetry).toBe("unavailable");
    expect(decision.trace.join(" ")).toContain("WARNING");
  });

  it("the default config alone is enough to survive the outage", () => {
    // No operator action required: a config that never mentions unknownTelemetry.
    const config = resolveConfig({
      routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
      capacityRouting: { enabled: true, mode: "enforce", sources: [source] },
      models: [
        { id: "cheap-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200000 },
      ],
      taskClasses: [{ key: "implementation", qualityFloor: 70 }],
    });
    const snapshot = normalizeCapacityPayload({ payload: outagePayload, source, fetchedAt: NOW });
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.degraded).toBe(true);
  });

  it("a genuinely exhausted lane is still refused — the fix does not reopen TOG-972", () => {
    // Same route, but now telemetry parses and says 100% utilized. Service must
    // still be denied, otherwise fail-open would have become 'ignore capacity'.
    const exhausted = normalizeCapacityPayload({
      payload: { accounts: [{ account: "primary", used7d: 1, resets7dAt: "2026-09-12T00:00:00Z" }] },
      source: { ...source, modelIds: ["cheap-model"] },
      fetchedAt: NOW,
    });
    expect(exhausted.error).toBeNull(); // it parsed fine
    const config = resolveConfig({
      routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
      capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry: "fail-open", sources: [{ ...source, modelIds: ["cheap-model"] }] },
      models: [
        { id: "cheap-model", family: "other", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 1, contextWindow: 200000 },
      ],
      taskClasses: [{ key: "implementation", qualityFloor: 70 }],
    });
    const decision = selectModel({
      config,
      descriptor: { taskClass: "implementation" },
      signals: { capacityEvidence: exhausted.evidence },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });
});
